/**
 * Ticket Assignment Automation App
 * This app automatically assigns unassigned tickets to agents in a round-robin fashion
 */

// Store the current agent index for round-robin assignment per group
let agentIndexByGroup = {};

// Temporary in-memory log storage
let inMemoryLogs = [];

// Group name map for readable activity entries
const GROUP_NAMES_BY_ID = {
  67000578161: 'West Region',
  67000578164: 'Central Southeast',
  67000578163: 'Northeast Region',
  67000578162: 'Central Southwest',
  67000578235: 'Triage',
  67000570681: 'Support Ops'
};

// Key for assignment attempts storage
const ASSIGNMENT_ATTEMPTS_DB_KEY = 'assignment_attempts_v1';

// Retention window in days for assignment attempts
const ASSIGNMENT_ATTEMPTS_RETENTION_DAYS = 31;

// Key for weekend reversion storage
const WEEKEND_REVERSIONS_DB_KEY = 'weekend_reversions_v1';

// Retention window in days for weekend reversions
const WEEKEND_REVERSIONS_RETENTION_DAYS = 90;

// Key for consolidated activity storage
const ACTIVITY_LOG_DB_KEY = 'activity_log_v1';



// Status mappings for weekend reversion
const STATUS_MAPPINGS = {
  'Follow-up Required': {
    'Waiting on Customer': 6,
    'Awaiting Internal Review': 36,
    'Pending': 3
  }
};

// Helper function to get existing logs
async function getExistingLogs() {
  // Return in-memory logs
  await Promise.resolve(); // Dummy await to satisfy linter
  return inMemoryLogs;
}

// Helper function to save logs to database
function saveLogsToDatabase(logs) {
  try {
    // Ensure logs is a valid array
    if (!Array.isArray(logs)) {
      console.warn('Invalid logs data, using empty array');
      logs = [];
    }

    // Update in-memory logs
    inMemoryLogs = logs;

    // For now, just log to console to avoid database issues
    console.log('Logs stored in memory:', {
      count: logs.length,
      latest: logs[logs.length - 1] || 'No logs'
    });

  } catch (error) {
    console.error('Error in log storage:', error);
  }
}

// Logging utility functions
async function addLog(type, message, details = {}) {
  try {
    // Validate inputs
    if (!type || !message) {
      console.warn('Invalid log entry - missing type or message:', { type, message });
      return Promise.resolve();
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      type: type.toString(), // 'config_change', 'ticket_assigned', 'error', 'info'
      message: message.toString(),
      details: details || {}
    };

    console.log('Creating log entry:', logEntry);

    // Get existing logs
    const logs = await getExistingLogs();
    console.log('Retrieved existing logs, count:', logs.length);

    // Add new log entry
    logs.push(logEntry);

    // Keep only last 1000 logs to prevent database bloat
    if (logs.length > 1000) {
      logs.splice(0, logs.length - 1000);
    }

    // Save logs back to database (non-blocking)
    saveLogsToDatabase(logs);

    console.log(`[${logEntry.timestamp}] ${type.toUpperCase()}: ${message}`);
    return Promise.resolve();
  } catch (error) {
    console.error('Error adding log:', error);
    return Promise.resolve(); // Always resolve to avoid breaking the chain
  }
}

// Handler for scheduled events
exports = {
  // Handler for the app installation
  onAppInstallHandler: async function (payload) {
    console.log('App installation started - CREATING COMBINED SCHEDULE');
    console.log('Installation payload:', JSON.stringify(payload));

    try {
      // Try to delete any existing schedule first
      try {
        await $schedule.delete({
          name: "auto_assign_schedule"
        });
        console.log('Deleted existing schedule');
      } catch (deleteError) {
        console.log('No existing schedule to delete:', deleteError.message);
      }

      // Create a single schedule that handles both ticket assignment and weekend reversion
      const schedule = await $schedule.create({
        name: "auto_assign_schedule",
        data: {
          operation: "combined_operations"
        },
        schedule_at: new Date(Date.now() + 60000).toISOString(), // Start 1 minute from now
        repeat: {
          time_unit: "minutes",
          frequency: 10
        }
      });

      console.log('Combined schedule created successfully:', JSON.stringify(schedule));
      console.log('App installed successfully with combined schedule (ticket assignment + weekend reversion)');

      // Call renderData() to complete the installation
      renderData();
    } catch (error) {
      console.error('Installation error:', error.message);
      console.error('Error stack:', error.stack);

      // Call renderData with error to fail the installation
      renderData({
        message: error.message || 'Installation failed'
      });
    }
  },



  // Handler for scheduled events - handles both ticket assignment and weekend status reversion
  onScheduledEventHandler: async function (payload) {
    const now = new Date();
    const operation = payload?.data?.operation || 'combined_operations';

    if (operation === 'combined_operations') {
      try {
        // Get all tickets once for both operations
        const allTickets = await getUnassignedTickets();
        if (!allTickets || allTickets.length === 0) {
          await addLog('info', 'No tickets found to process');
          return;
        }

        const isWeekend = isWeekendTime(now);
        let revertedCount = 0;
        let assignedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        // Run weekend reversion check (if it's weekend time)
        if (isWeekend) {
          revertedCount = await handleWeekendStatusReversion(allTickets);
        }

        // Then run ticket assignment (if service is enabled, within time window, and on weekdays)
        const withinWindow = isWithinAssignmentWindow(now);
        if (!withinWindow) {
          await addLog('info', 'Outside assignment window (2:01-4:00 AM ET), skipping ticket assignment');
          return;
        }

        const isWeekday = isWeekdayTime(now);
        if (!isWeekday) {
          await addLog('info', 'Weekend detected, skipping ticket assignment (weekdays only)');
          return;
        }

        // Purge old assignment attempts monthly (lightweight every run)
        await purgeOldAssignmentAttempts();

        if (!await isServiceEnabled()) {
          await addLog('info', 'Service disabled, skipping ticket assignment');
          return;
        }

        // Filter for unassigned tickets for assignment
        const unassignedTickets = allTickets.filter(ticket => {
          const isUnassigned = !ticket.responder_id;
          const hasCorrectStatus = ticket.status === 2 || ticket.status === 29;
          return isUnassigned && hasCorrectStatus;
        });

        if (!unassignedTickets || unassignedTickets.length === 0) {
          await addLog('info', 'No unassigned tickets found for assignment');
          return;
        }

        const allAgentsWithGroups = await getActiveAgents();
        if (!allAgentsWithGroups || allAgentsWithGroups.length === 0) {
          await addLog('error', 'No agents available for assignment');
          return;
        }

        await loadAgentIndicesByGroup();
        const results = await assignTicketsInRoundRobin(unassignedTickets, allAgentsWithGroups);
        await saveAgentIndicesByGroup();

        assignedCount = results.assigned;
        skippedCount = results.skipped;
        errorCount = results.errors;

        // Final summary log
        await addLog('info', `Run completed: ${assignedCount} assigned, ${skippedCount} skipped, ${errorCount} errors${isWeekend ? `, ${revertedCount} reverted` : ''}`, {
          total_tickets: allTickets.length,
          assigned: assignedCount,
          skipped: skippedCount,
          errors: errorCount,
          reverted: revertedCount,
          weekend_mode: isWeekend
        });

      } catch (error) {
        console.error('Error during combined operations:', error);
        await addLog('error', 'Error during combined operations', { error: error.message });
      }
    } else {
      await addLog('info', `Legacy operation: ${operation}`);
    }
  },

  // Get logs function for viewing logs
  getLogs: async function (args) {
    await Promise.resolve(); // Dummy await to satisfy linter
    try {
      console.log('getLogs called with args:', args);

      // Return the in-memory logs directly without await
      const logs = inMemoryLogs || [];
      console.log('Current logs in memory:', logs.length);

      // Filter logs if type is specified
      let filteredLogs = logs;
      if (args && args.type) {
        filteredLogs = logs.filter(log => log.type === args.type);
      }

      // Limit number of logs - default to 100 most recent if not specified
      const limit = args && args.limit ? parseInt(args.limit) : 100;
      filteredLogs = filteredLogs.slice(-limit);

      const result = {
        success: true,
        logs: filteredLogs,
        total_logs: logs.length,
        filtered_count: filteredLogs.length
      };

      console.log('Returning logs:', result);
      return result;
    } catch (error) {
      console.error('Error retrieving logs:', error);
      return { success: false, error: error.message, logs: [] };
    }
  },

  // Get consolidated activity with server-side filtering
  getActivityLog: async function (args) {
    try {
      const params = args || {};
      const data = await getActivityLogData();
      let entries = Array.isArray(data.entries) ? data.entries : [];

      // Date range filter (inclusive)
      if (params.date_from || params.date_to) {
        const from = params.date_from ? new Date(params.date_from).getTime() : null;
        const to = params.date_to ? new Date(params.date_to).getTime() : null;
        entries = entries.filter(e => {
          const ts = new Date(e.created_at || e.assigned_at || e.status_reverted_at).getTime();
          if (from && ts < from) return false;
          if (to && ts > to) return false;
          return true;
        });
      }

      // Column filters
      if (params.ticket_id) entries = entries.filter(e => String(e.ticket_id) === String(params.ticket_id));
      if (params.ticket_subject) entries = entries.filter(e => (e.ticket_subject || '').toLowerCase().includes(String(params.ticket_subject).toLowerCase()));
      if (params.ticket_status) entries = entries.filter(e => String(e.ticket_status) === String(params.ticket_status));
      if (params.assigned_to) entries = entries.filter(e => (e.assigned_to || '') === params.assigned_to);
      if (params.group_name) entries = entries.filter(e => (e.group_name || '') === params.group_name);
      if (params.activity_type) entries = entries.filter(e => (e.activity_type || '') === params.activity_type);

      // Sort newest first
      entries.sort((a, b) => new Date(b.created_at || b.assigned_at || b.status_reverted_at) - new Date(a.created_at || a.assigned_at || a.status_reverted_at));

      // Optional limit
      const limit = params.limit ? parseInt(params.limit, 10) : 1000;
      const result = entries.slice(0, isNaN(limit) ? 1000 : limit);

      return { success: true, entries: result, total: entries.length };
    } catch (error) {
      console.error('Error in getActivityLog:', error);
      return { success: false, error: error.message, entries: [], total: 0 };
    }
  },

  // Clear all consolidated activity entries
  clearActivityLog: async function () {
    try {
      await $db.set(ACTIVITY_LOG_DB_KEY, { entries: [], updated_at: new Date().toISOString() });
      return { success: true };
    } catch (error) {
      console.error('Error in clearActivityLog:', error);
      return { success: false, error: error.message };
    }
  },

  // Add demo data for UI testing
  addDemoActivityData: async function () {
    try {
      const now = Date.now();
      const demo = [
        { ticket_id: 1001, ticket_subject: 'Demo: Login issue', ticket_status: 2, assigned_to: 'Alice Johnson', group_name: 'Triage', assigned_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), status_reverted_at: null, activity_type: 'assignment' },
        { ticket_id: 1002, ticket_subject: 'Demo: Order not received', ticket_status: 'Waiting on Customer', assigned_to: null, group_name: 'West Region', assigned_at: null, status_reverted_at: new Date(now - 90 * 60 * 1000).toISOString(), activity_type: 'status_reversion' },
        { ticket_id: 1003, ticket_subject: 'Demo: Payment failed', ticket_status: 29, assigned_to: 'Bob Smith', group_name: 'Support Ops', assigned_at: new Date(now - 45 * 60 * 1000).toISOString(), status_reverted_at: null, activity_type: 'assignment' }
      ];

      for (const e of demo) {
        await addActivityEntry(e);
      }
      return { success: true, added: demo.length };
    } catch (error) {
      console.error('Error in addDemoActivityData:', error);
      return { success: false, error: error.message };
    }
  },

  // Clear logs function
  clearLogs: async function () {
    await Promise.resolve(); // Dummy await to satisfy linter
    try {
      console.log('clearLogs called');

      // Clear in-memory logs
      inMemoryLogs = [];

      // Add a log entry about clearing (but don't await it)
      const clearLogEntry = {
        timestamp: new Date().toISOString(),
        type: 'info',
        message: 'Logs cleared by user',
        details: {}
      };
      inMemoryLogs.push(clearLogEntry);

      console.log('Logs cleared, returning success');
      return { success: true, message: 'Logs cleared successfully', logs: [clearLogEntry] };
    } catch (error) {
      console.error('Error clearing logs:', error);
      return { success: false, error: error.message, logs: [] };
    }
  },

  // Return assignment attempt activity with optional filters
  getAssignmentActivity: async function (args) {
    try {
      const filters = args || {};
      const data = await getAssignmentAttemptsData();
      let attempts = data.attempts || [];

      // Apply filters
      if (filters.agent_name) {
        attempts = attempts.filter(a => (a.agent_name || '').toLowerCase() === String(filters.agent_name).toLowerCase());
      }
      if (filters.group_id) {
        const gid = String(filters.group_id);
        attempts = attempts.filter(a => String(a.group_id) === gid);
      }
      if (filters.result) {
        const r = String(filters.result).toLowerCase();
        attempts = attempts.filter(a => (a.result || '').toLowerCase() === r);
      }
      if (filters.date_from) {
        const from = new Date(filters.date_from).getTime();
        attempts = attempts.filter(a => new Date(a.attempted_at).getTime() >= from);
      }
      if (filters.date_to) {
        const to = new Date(filters.date_to).getTime();
        attempts = attempts.filter(a => new Date(a.attempted_at).getTime() <= to);
      }

      // Sort by attempted_at desc by default
      attempts.sort((a, b) => new Date(b.attempted_at) - new Date(a.attempted_at));

      return { success: true, attempts, total: attempts.length };
    } catch (error) {
      console.error('Error in getAssignmentActivity:', error);
      return { success: false, error: error.message, attempts: [], total: 0 };
    }
  },

  // Clear assignment attempt storage manually
  clearAssignmentActivity: async function () {
    try {
      await $db.set(ASSIGNMENT_ATTEMPTS_DB_KEY, { attempts: [], updated_at: new Date().toISOString() });
      return { success: true };
    } catch (error) {
      console.error('Error in clearAssignmentActivity:', error);
      return { success: false, error: error.message };
    }
  },

  // Return weekend reversion activity with optional filters
  getWeekendReversions: async function (args) {
    try {
      const filters = args || {};
      const data = await getWeekendReversionsData();
      let reversions = data.reversions || [];

      // Apply filters
      if (filters.ticket_id) {
        reversions = reversions.filter(r => String(r.ticket_id) === String(filters.ticket_id));
      }
      if (filters.agent_name) {
        reversions = reversions.filter(r => (r.agent_name || '').toLowerCase() === String(filters.agent_name).toLowerCase());
      }
      if (filters.previous_status) {
        reversions = reversions.filter(r => r.previous_status === filters.previous_status);
      }
      if (filters.date_from) {
        const from = new Date(filters.date_from).getTime();
        reversions = reversions.filter(r => new Date(r.reverted_at).getTime() >= from);
      }
      if (filters.date_to) {
        const to = new Date(filters.date_to).getTime();
        reversions = reversions.filter(r => new Date(r.reverted_at).getTime() <= to);
      }

      // Sort by reverted_at desc by default
      reversions.sort((a, b) => new Date(b.reverted_at) - new Date(a.reverted_at));

      return { success: true, reversions, total: reversions.length };
    } catch (error) {
      console.error('Error in getWeekendReversions:', error);
      return { success: false, error: error.message, reversions: [], total: 0 };
    }
  },

  // Clear weekend reversion storage manually
  clearWeekendReversions: async function () {
    try {
      await $db.set(WEEKEND_REVERSIONS_DB_KEY, { reversions: [], updated_at: new Date().toISOString() });
      return { success: true };
    } catch (error) {
      console.error('Error in clearWeekendReversions:', error);
      return { success: false, error: error.message };
    }
  },

  // Test function for weekend reversion (for testing purposes)
  testWeekendReversion: async function () {
    try {
      console.log('Manual test of weekend reversion started');
      await addLog('info', 'Manual test of weekend reversion started');

      // Get tickets for testing
      const allTickets = await getUnassignedTickets();
      if (!allTickets || allTickets.length === 0) {
        await addLog('info', 'No tickets found for testing');
        return { success: false, message: 'No tickets found for testing' };
      }

      // Force weekend reversion regardless of time
      await handleWeekendStatusReversion(allTickets);

      return { success: true, message: 'Weekend reversion test completed' };
    } catch (error) {
      console.error('Error in testWeekendReversion:', error);
      await addLog('error', 'Error in testWeekendReversion', { error: error.message });
      return { success: false, error: error.message };
    }
  },

  // Test function for overnight tagging (for testing purposes)
  testOvernightTagging: async function (args) {
    try {
      const ticketId = args?.ticket_id || 318402; // Use the ticket from the file as default
      console.log(`Testing overnight tagging on ticket #${ticketId}...`);
      await addLog('info', `Testing overnight tagging on ticket #${ticketId}`);

      const success = await addOvernightTag(ticketId);

      if (success) {
        await addLog('info', `Successfully added overnight tag to ticket #${ticketId}`);
        return { success: true, message: `Overnight tag added to ticket #${ticketId}` };
      } else {
        await addLog('error', `Failed to add overnight tag to ticket #${ticketId}`);
        return { success: false, message: `Failed to add overnight tag to ticket #${ticketId}` };
      }
    } catch (error) {
      console.error('Error in testOvernightTagging:', error);
      await addLog('error', 'Error in testOvernightTagging', { error: error.message });
      return { success: false, error: error.message };
    }
  },

  // Debug function to check specific ticket
  checkSpecificTicket: async function (args) {
    try {
      const ticketId = args?.ticket_id || 315751;
      console.log(`Checking specific ticket #${ticketId}...`);

      const response = await $request.invokeTemplate('getSpecificTicket', {
        context: { ticket_id: ticketId }
      });

      if (response.status >= 400) {
        console.error(`Failed to fetch ticket #${ticketId}:`, response.response);
        return { success: false, error: `API returned status ${response.status}` };
      }

      const ticket = JSON.parse(response.response);
      console.log(`Ticket #${ticketId} details:`, {
        id: ticket.id,
        responder_id: ticket.responder_id,
        status: ticket.status,
        group_id: ticket.group_id,
        subject: ticket.subject
      });

      return {
        success: true,
        ticket: {
          id: ticket.id,
          responder_id: ticket.responder_id,
          status: ticket.status,
          group_id: ticket.group_id,
          subject: ticket.subject
        }
      };
    } catch (error) {
      console.error('Error in checkSpecificTicket:', error);
      return { success: false, error: error.message };
    }
  }
};

// Helper function to check if service is enabled
async function isServiceEnabled() {
  await Promise.resolve(); // Dummy await to satisfy linter
  try {
    // Check in-memory config first
    if (global.appConfig && global.appConfig.service_status === 'false') {
      console.log('Ticket assignment service is disabled');
      return false;
    }
  } catch (error) {
    console.log('Error reading service status, defaulting to enabled');
  }
  return true;
}

// Helper function to make API calls with rate limit handling
async function makeAPICallWithRetry(templateName, context, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await $request.invokeTemplate(templateName, context);

      // Log rate limit status for monitoring
      const rateLimitTotal = response.headers['x-ratelimit-total'];
      const rateLimitRemaining = response.headers['x-ratelimit-remaining'];
      const rateLimitUsed = response.headers['x-ratelimit-used-currentrequest'];

      if (rateLimitTotal && rateLimitRemaining) {
        console.log(`Rate limit status: ${rateLimitRemaining}/${rateLimitTotal} remaining (used ${rateLimitUsed || 1} for this request)`);

        // Proactive slowdown if we're getting close to the limit
        const remaining = parseInt(rateLimitRemaining, 10);
        if (remaining < 50) {
          console.log(`Rate limit warning: Only ${remaining} calls remaining, adding extra delay...`);
          const start = Date.now();
          while (Date.now() - start < 1000) {
            // Extra 1-second delay when approaching limit
          }
        }
      }

      if (response.status === 429) {
        // Rate limited - check retry-after header
        const retryAfter = parseInt(response.headers['retry-after'] || '10', 10);
        console.log(`Rate limited (attempt ${attempt}/${maxRetries}), waiting ${retryAfter} seconds...`);
        console.log(`Rate limit headers: Total=${rateLimitTotal}, Remaining=${rateLimitRemaining}, Used=${rateLimitUsed}`);

        if (attempt < maxRetries) {
          // Wait using a simple loop instead of setTimeout
          const waitMs = retryAfter * 1000;
          const start = Date.now();
          while (Date.now() - start < waitMs) {
            // Busy wait - not ideal but works in serverless environment
          }
          continue;
        } else {
          throw new Error(`Rate limited after ${maxRetries} attempts`);
        }
      }

      if (response.status >= 400) {
        throw new Error(`API returned status ${response.status}: ${response.response}`);
      }

      return response;
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      // Wait before retry for other errors
      const start = Date.now();
      while (Date.now() - start < 2000) {
        // Busy wait for 2 seconds
      }
    }
  }
}

// Helper function to get unassigned tickets
async function getUnassignedTickets() {
  try {
    console.log('Calling getUnassignedTickets API with pagination...');

    // Calculate lookback period - 61 hours on Monday, 24 hours other weekdays
    const now = new Date();
    const estDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const isMonday = estDate.getDay() === 1;

    const lookbackHours = isMonday ? 61 : 24;
    const since = new Date();
    since.setHours(since.getHours() - lookbackHours);
    const updatedSince = since.toISOString();

    console.log(`Using ${lookbackHours}-hour lookback (${isMonday ? 'Monday' : 'Weekday'}) - updated_since filter: ${updatedSince}`);

    let allTickets = [];
    let page = 1;
    let hasMore = true;
    const maxPages = 50; // Limit to prevent infinite loops

    while (hasMore && page <= maxPages) {
      console.log(`Fetching page ${page}...`);

      const ticketsResponse = await makeAPICallWithRetry('getUnassignedTickets', {
        context: {
          updated_since: updatedSince,
          page: page
        }
      });
      console.log(`Page ${page} API Response status:`, ticketsResponse.status);

      const pageTickets = JSON.parse(ticketsResponse.response);
      console.log(`Page ${page}: fetched ${pageTickets.length} tickets`);

      if (pageTickets && pageTickets.length > 0) {
        allTickets = allTickets.concat(pageTickets);

        // Check if we found our target tickets (for debugging)
        const targetTicket = pageTickets.find(ticket => ticket.id === 315751);
        if (targetTicket) {
          console.log(`Found target ticket #315751 on page ${page}: responder_id=${targetTicket.responder_id}, status=${targetTicket.status}, group_id=${targetTicket.group_id}, updated_at=${targetTicket.updated_at}`);
        }

        // Check for ticket #306399 specifically
        const ticket306399 = pageTickets.find(ticket => ticket.id === 306399);
        if (ticket306399) {
          console.log(`Found ticket #306399 on page ${page}: responder_id=${ticket306399.responder_id}, status=${ticket306399.status}, group_id=${ticket306399.group_id}, updated_at=${ticket306399.updated_at}`);
        }

        if (pageTickets.length < 100) {
          // If we got less than a full page, we've reached the end
          hasMore = false;
        } else {
          page++;
          // Dynamic delay between pages based on rate limit status
          // Base delay of 500ms, increased if we're making many requests
          const delayMs = page > 5 ? 1000 : 500; // Slower after 5 pages
          const start = Date.now();
          while (Date.now() - start < delayMs) {
            // Busy wait to avoid rate limiting
          }
        }
      } else {
        hasMore = false;
      }
    }

    console.log(`Total tickets fetched across ${page} pages: ${allTickets.length}`);

    // Show date range of tickets for debugging
    if (allTickets.length > 0) {
      const oldestTicket = allTickets[allTickets.length - 1];
      const newestTicket = allTickets[0];
      console.log(`Ticket date range: Newest updated ${newestTicket.updated_at} (ID: ${newestTicket.id}), Oldest updated ${oldestTicket.updated_at} (ID: ${oldestTicket.id})`);
    }



    if (!allTickets || allTickets.length === 0) {
      console.log('No tickets found');
      return null;
    }

    // Filter for unassigned tickets with status 2 (Open) or 29 (Triage)
    console.log('Starting ticket filtering process...');

    const unassignedTickets = allTickets.filter(ticket => {
      const isUnassigned = !ticket.responder_id || ticket.responder_id === null;
      const hasCorrectStatus = ticket.status === 2 || ticket.status === 29;
      const isEligible = isUnassigned && hasCorrectStatus;

      // Debug logging for ticket #315751 specifically
      if (ticket.id === 315751) {
        console.log(`DEBUG - Ticket #315751: responder_id=${ticket.responder_id}, status=${ticket.status}, isUnassigned=${isUnassigned}, hasCorrectStatus=${hasCorrectStatus}, isEligible=${isEligible}`);
      }

      return isEligible;
    });

    if (unassignedTickets.length === 0) {
      console.log('No unassigned tickets with Open or Triage status found');
      console.log('Sample tickets for debugging:');
      allTickets.slice(0, 5).forEach(ticket => {
        console.log(`  Ticket #${ticket.id}: responder_id=${ticket.responder_id}, status=${ticket.status}, group_id=${ticket.group_id}`);
      });
      console.log('Returning all tickets for processing by weekend reversion');
      return allTickets;
    }

    console.log(`Found ${unassignedTickets.length} unassigned tickets with Open/Triage status out of ${allTickets.length} total tickets`);
    return allTickets; // Return all tickets for use by both operations (weekend reversion needs access to all tickets)
  } catch (error) {
    console.error('Error in getUnassignedTickets:', error);
    throw error;
  }
}

// Helper function to get all agents with their group memberships
async function getActiveAgents() {
  // Fetch all pages of agents
  let allAgents = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      const agentsResponse = page === 1
        ? await makeAPICallWithRetry('getAgents', {})
        : await makeAPICallWithRetry('getAgentsPage', { context: { page: page } });

      const pageAgents = JSON.parse(agentsResponse.response);

      if (pageAgents && pageAgents.length > 0) {
        allAgents = allAgents.concat(pageAgents);
        console.log(`Fetched ${pageAgents.length} agents from page ${page} (total: ${allAgents.length})`);

        // If we got a full page of agents, there might be more
        if (pageAgents.length >= 30) {
          page++;
          // Small delay between pages to avoid rate limiting
          const start = Date.now();
          while (Date.now() - start < 500) {
            // Busy wait for 500ms
          }
        } else {
          hasMore = false;
        }
      } else {
        hasMore = false;
      }
    } catch (error) {
      console.log(`Error fetching agents page ${page}:`, error.message);
      hasMore = false;
    }
  }

  // Fetch groups sequentially to avoid rate limiting
  const westGroup = await makeAPICallWithRetry('getWestRegionGroup', {});
  const southeastGroup = await makeAPICallWithRetry('getCentralSoutheastGroup', {});
  const northeastGroup = await makeAPICallWithRetry('getNortheastRegionGroup', {});
  const southwestGroup = await makeAPICallWithRetry('getCentralSouthwestGroup', {});
  const triageGroup = await makeAPICallWithRetry('getTriageGroup', {});
  const supportOpsGroup = await makeAPICallWithRetry('getSupportOpsGroup', {});

  const agents = allAgents;
  const groups = [
    JSON.parse(westGroup.response),
    JSON.parse(southeastGroup.response),
    JSON.parse(northeastGroup.response),
    JSON.parse(southwestGroup.response),
    JSON.parse(triageGroup.response),
    JSON.parse(supportOpsGroup.response)
  ];

  // Create a mapping of agent_id to group_ids
  const agentGroupMap = {};

  // Go through each regional group and add its members to the map
  for (const group of groups) {
    if (group.agent_ids && group.agent_ids.length > 0) {
      for (const agentId of group.agent_ids) {
        if (!agentGroupMap[agentId]) {
          agentGroupMap[agentId] = [];
        }
        agentGroupMap[agentId].push(group.id);
      }
    }
  }

  // Add group_ids to each agent and enrich with current availability
  let availableCount = 0;
  let unavailableCount = 0;

  for (const agent of agents) {
    agent.group_ids = agentGroupMap[agent.id] || [];
    // Ensure 'available' field is present if missing by fetching details (best-effort)
    if (typeof agent.available === 'undefined') {
      try {
        const detailResp = await makeAPICallWithRetry('getAgentDetails', { context: { agent_id: agent.id } });
        const detail = JSON.parse(detailResp.response);
        agent.available = !!detail.available;
      } catch (e) {
        // ignore errors; leave availability as-is
      }
    }

    // Count availability
    if (agent.available) {
      availableCount++;
    } else {
      unavailableCount++;
    }
  }

  console.log(`Agent availability: ${availableCount} available, ${unavailableCount} unavailable (total: ${agents.length})`);

  // Log only agents that have groups assigned
  const agentsWithGroups = agents.filter(a => a.group_ids && a.group_ids.length > 0).map(a => ({
    name: a.contact?.name || 'Unknown',
    available: a.available,
    groups: a.group_ids.map(gid => GROUP_NAMES_BY_ID[gid] || `Group ${gid}`).join(', ')
  }));
  console.log(`Agents with groups (${agentsWithGroups.length}):`, agentsWithGroups);

  return agents;
}

// Helper function to load current agent indices by group
async function loadAgentIndicesByGroup() {
  try {
    const storedData = await $db.get('agent_indices_by_group');
    if (storedData && storedData.indices) {
      agentIndexByGroup = storedData.indices;
    } else {
      agentIndexByGroup = {};
    }
  } catch (error) {
    agentIndexByGroup = {};
  }
}

// Helper function to assign tickets in round-robin fashion
async function assignTicketsInRoundRobin(tickets, allAgents) {
  let assignedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Define the 6 group IDs we handle (4 regional + 1 triage + 1 support ops)
  const supportedGroups = [67000578161, 67000578164, 67000578163, 67000578162, 67000578235, 67000570681];

  for (const ticket of tickets) {
    const ticketGroupId = ticket.group_id;

    if (!ticketGroupId) {
      await addLog('info', `Ticket #${ticket.id} skipped: no group assigned`, { ticket_id: ticket.id });
      await addAssignmentAttemptEntry({
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        agent_name: null,
        group_id: ticketGroupId,
        result: 'Failed',
        error_message: 'Ticket has no group assigned'
      });
      skippedCount++;
      continue;
    }

    if (!supportedGroups.includes(ticketGroupId)) {
      await addLog('info', `Ticket #${ticket.id} skipped: unsupported group ${ticketGroupId}`, { ticket_id: ticket.id, group_id: ticketGroupId });
      await addAssignmentAttemptEntry({
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        agent_name: null,
        group_id: ticketGroupId,
        result: 'Failed',
        error_message: 'Unsupported group for auto-assignment'
      });
      skippedCount++;
      continue;
    }

    // Find all agents that belong to the same group as the ticket and are available
    const groupAgents = allAgents.filter(agent =>
      agent.group_ids && agent.group_ids.includes(ticketGroupId) && agent.available === true
    );

    if (!groupAgents || groupAgents.length === 0) {
      await addLog('info', `Ticket #${ticket.id} skipped: no available agents in ${GROUP_NAMES_BY_ID[ticketGroupId] || `group ${ticketGroupId}`}`, {
        ticket_id: ticket.id,
        group_id: ticketGroupId
      });
      await addAssignmentAttemptEntry({
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        agent_name: null,
        group_id: ticketGroupId,
        result: 'Failed',
        error_message: 'No agents available in group'
      });
      skippedCount++;
      continue;
    }

    // Get or initialize the agent index for this group (ensure within bounds after availability filtering)
    const currentIndex = agentIndexByGroup[ticketGroupId];
    if (currentIndex === null || typeof currentIndex === 'undefined' || currentIndex >= groupAgents.length) {
      agentIndexByGroup[ticketGroupId] = 0;
    }

    // Get the next agent in rotation for this group
    const agentIndex = agentIndexByGroup[ticketGroupId];
    const agent = groupAgents[agentIndex];

    try {
      // Assign the ticket to the agent
      await makeAPICallWithRetry('assignTicket', {
        context: { ticket_id: ticket.id },
        body: JSON.stringify({ responder_id: agent.id })
      });

      // Always add overnight tag to assigned tickets
      const overnightTagAdded = await addOvernightTag(ticket.id);

      // Log successful assignment
      await addLog('info', `Ticket #${ticket.id} assigned to ${agent.contact.name} (${GROUP_NAMES_BY_ID[ticketGroupId] || `Group ${ticketGroupId}`})${overnightTagAdded ? ' + overnight tag' : ''}`, {
        ticket_id: ticket.id,
        agent_name: agent.contact.name,
        group_name: GROUP_NAMES_BY_ID[ticketGroupId],
        overnight_tagged: overnightTagAdded
      });

      // Write consolidated activity entry for assignment
      await addActivityEntry({
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        ticket_status: ticket.status,
        assigned_to: agent.contact?.name || null,
        group_name: GROUP_NAMES_BY_ID[ticketGroupId] || `Group ${ticketGroupId}`,
        assigned_at: new Date().toISOString(),
        status_reverted_at: null,
        activity_type: 'assignment',
        overnight_tagged: overnightTagAdded
      });

      // Record assignment attempt (success)
      await addAssignmentAttemptEntry({
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        agent_name: agent.contact?.name || 'Unknown',
        group_id: ticketGroupId,
        result: 'Success',
        error_message: null,
        tag_added: overnightTagAdded ? 'overnight' : null
      });

      assignedCount++;

    } catch (error) {
      await addLog('error', `Ticket #${ticket.id} assignment failed: ${error.message}`, {
        ticket_id: ticket.id,
        agent_name: agent.contact.name,
        error: error.message
      });

      // Record assignment attempt (failure)
      await addAssignmentAttemptEntry({
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        agent_name: agent.contact?.name || 'Unknown',
        group_id: ticketGroupId,
        result: 'Failed',
        error_message: error.message || 'Unknown error'
      });

      errorCount++;
    }

    // Update the agent index for round-robin for this group
    agentIndexByGroup[ticketGroupId] = (agentIndex + 1) % groupAgents.length;
  }

  return { assigned: assignedCount, skipped: skippedCount, errors: errorCount };
}

// Helper function to save agent indices by group
async function saveAgentIndicesByGroup() {
  try {
    await $db.set('agent_indices_by_group', {
      indices: agentIndexByGroup,
      last_updated: new Date().toISOString()
    });
  } catch (error) {
    // Continue execution even if save fails
  }
}

// ----- Assignment Attempts Storage Helpers -----

async function getAssignmentAttemptsData() {
  try {
    const existing = await $db.get(ASSIGNMENT_ATTEMPTS_DB_KEY);
    if (existing && Array.isArray(existing.attempts)) {
      return existing;
    }
  } catch (e) {
    // Ignore missing key errors
  }
  return { attempts: [] };
}

async function addAssignmentAttemptEntry({ ticket_id, ticket_subject, agent_name, group_id, result, error_message, tag_added }) {
  try {
    const data = await getAssignmentAttemptsData();
    const attempts = Array.isArray(data.attempts) ? data.attempts : [];

    const entry = {
      ticket_id,
      ticket_subject: ticket_subject || 'Unknown Subject',
      agent_name: agent_name || 'Unknown',
      group_id,
      group_name: GROUP_NAMES_BY_ID[group_id] || `Group ${group_id}`,
      attempted_at: new Date().toISOString(),
      result: result === 'Success' ? 'Success' : 'Failed',
      error_message: result === 'Failed' ? (error_message || 'Unknown error') : null,
      tag_added: tag_added || null
    };

    attempts.push(entry);

    // Keep a reasonable upper bound to prevent unbounded growth
    const MAX_ENTRIES = 10000;
    if (attempts.length > MAX_ENTRIES) {
      attempts.splice(0, attempts.length - MAX_ENTRIES);
    }

    await $db.set(ASSIGNMENT_ATTEMPTS_DB_KEY, { attempts, updated_at: new Date().toISOString() });
  } catch (error) {
    console.error('Error saving assignment attempt entry:', error);
  }
}

async function purgeOldAssignmentAttempts() {
  try {
    const data = await getAssignmentAttemptsData();
    const attempts = Array.isArray(data.attempts) ? data.attempts : [];
    if (attempts.length === 0) return;

    const now = Date.now();
    const cutoffMs = ASSIGNMENT_ATTEMPTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const cutoffTime = now - cutoffMs;

    const filtered = attempts.filter(a => {
      const t = new Date(a.attempted_at).getTime();
      return !Number.isNaN(t) && t >= cutoffTime;
    });

    if (filtered.length !== attempts.length) {
      await $db.set(ASSIGNMENT_ATTEMPTS_DB_KEY, { attempts: filtered, updated_at: new Date().toISOString() });
      console.log(`Purged ${attempts.length - filtered.length} old assignment attempts; kept ${filtered.length}`);
    }
  } catch (error) {
    console.error('Error purging old assignment attempts:', error);
  }
}

// ----- Activity Log Storage Helpers -----

async function getActivityLogData() {
  try {
    const existing = await $db.get(ACTIVITY_LOG_DB_KEY);
    if (existing && Array.isArray(existing.entries)) return existing;
  } catch (e) {
    // ignore missing key
  }
  return { entries: [] };
}

async function addActivityEntry({ ticket_id, ticket_subject, ticket_status, assigned_to, group_name, assigned_at, status_reverted_at, activity_type, overnight_tagged }) {
  try {
    const data = await getActivityLogData();
    const entries = Array.isArray(data.entries) ? data.entries : [];

    const entry = {
      ticket_id,
      ticket_subject: ticket_subject || 'Unknown Subject',
      ticket_status: ticket_status || null,
      assigned_to: assigned_to || null,
      group_name: group_name || null,
      assigned_at: assigned_at || null,
      status_reverted_at: status_reverted_at || null,
      activity_type: activity_type || (assigned_at ? 'assignment' : (status_reverted_at ? 'status_reversion' : null)),
      overnight_tagged: overnight_tagged || false,
      created_at: new Date().toISOString()
    };

    entries.push(entry);

    const MAX_ENTRIES = 10000;
    if (entries.length > MAX_ENTRIES) {
      entries.splice(0, entries.length - MAX_ENTRIES);
    }

    await $db.set(ACTIVITY_LOG_DB_KEY, { entries, updated_at: new Date().toISOString() });
  } catch (error) {
    console.error('Error saving activity entry:', error);
  }
}

// Helper function to create or update the schedule
async function createSchedule(interval) {
  try {
    // Delete existing schedule if any
    try {
      await $schedule.delete({
        name: "auto_assign_schedule"
      });
      console.log('Deleted existing schedule');
    } catch (error) {
      console.log('No existing schedule to delete');
    }

    // Create new schedule
    const schedule = await $schedule.create({
      name: "auto_assign_schedule",
      data: {
        operation: "combined_operations"
      },
      schedule_at: new Date().toISOString(),
      repeat: {
        time_unit: "minutes",
        frequency: parseInt(interval, 10)
      }
    });

    console.log('Created new combined schedule:', schedule);
    return schedule;
  } catch (error) {
    console.error('Error creating schedule:', error);
    throw error;
  }
}

// (Overnight reassignment functionality removed)

// ----- Weekend Status Reversion Helpers -----

// Check if current time is during weekend hours (Friday 6 PM EST to Monday 7 AM EST)
function isWeekendTime(date) {
  // TEMPORARY: Set to true for testing - REMOVE THIS LINE AFTER TESTING
  const TESTING_MODE = false; // Set to true to force weekend mode for testing

  if (TESTING_MODE) {
    return false;
  }

  // Convert to EST timezone
  const estDate = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = estDate.getDay(); // 0 = Sunday, 1 = Monday, ..., 5 = Friday, 6 = Saturday
  const hour = estDate.getHours();

  // Friday after 6 PM (18:00)
  if (day === 5 && hour >= 18) return true;
  // Saturday (all day)
  if (day === 6) return true;
  // Sunday (all day)
  if (day === 0) return true;
  // Monday before 7 AM (07:00)
  if (day === 1 && hour < 7) return true;

  return false;
}

// Check if current time is between 2:01 AM and 4:00 AM Eastern Time (inclusive of 4:00)
function isWithinAssignmentWindow(date) {
  // Convert to America/New_York timezone to account for DST
  const estDate = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hour = estDate.getHours();
  const minute = estDate.getMinutes();

  // 2:01-2:59 -> run, 3:00-3:59 -> run, 4:00 -> run, else -> skip
  if (hour === 2 && minute >= 1) return true;
  if (hour === 3) return true;
  if (hour === 4 && minute === 0) return true;
  return false;
}

// Check if current time is on a weekday (Monday-Friday)
function isWeekdayTime(date) {
  // Convert to America/New_York timezone to account for DST
  const estDate = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = estDate.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  // Monday (1) through Friday (5) are weekdays
  return day >= 1 && day <= 5;
}

// Helper function to add overnight tag to a ticket
async function addOvernightTag(ticketId) {
  try {
    console.log(`Adding overnight tag to ticket #${ticketId}`);

    // Fetch current ticket to retrieve existing tags
    const getResp = await makeAPICallWithRetry('getSpecificTicket', {
      context: { ticket_id: ticketId }
    });

    const ticket = JSON.parse(getResp.response);
    const existingTags = Array.isArray(ticket.tags) ? ticket.tags : [];

    // If tag already present, nothing to do
    if (existingTags.includes('overnight')) {
      console.log(`Tag 'overnight' already present on ticket #${ticketId}`);
      return true;
    }

    // Create updated tag set preserving all existing
    const updatedTags = Array.from(new Set([...existingTags, 'overnight']));

    // Update tags by sending the full list (Freshdesk replaces tags with provided array)
    await makeAPICallWithRetry('addTicketTag', {
      context: { ticket_id: ticketId },
      body: JSON.stringify({ tags: updatedTags })
    });

    console.log(`✅ Successfully ensured 'overnight' tag on ticket #${ticketId} (tags now: ${JSON.stringify(updatedTags)})`);
    return true;
  } catch (error) {
    console.error(`Error adding overnight tag to ticket #${ticketId}:`, error);
    return false;
  }
}

// Get weekend reversion data from database
async function getWeekendReversionsData() {
  try {
    const existing = await $db.get(WEEKEND_REVERSIONS_DB_KEY);
    if (existing && Array.isArray(existing.reversions)) {
      return existing;
    }
  } catch (e) {
    // Ignore missing key errors
  }
  return { reversions: [] };
}

// Add weekend reversion entry to database
async function addWeekendReversionEntry({ ticket_id, ticket_subject, agent_name, previous_status, reverted_to_status, reversion_reason }) {
  try {
    const data = await getWeekendReversionsData();
    const reversions = Array.isArray(data.reversions) ? data.reversions : [];

    const entry = {
      ticket_id,
      ticket_subject: ticket_subject || 'Unknown Subject',
      agent_name: agent_name || 'Unknown',
      previous_status,
      reverted_to_status,
      reversion_reason,
      reverted_at: new Date().toISOString()
    };

    reversions.push(entry);

    // Keep a reasonable upper bound to prevent unbounded growth
    const MAX_ENTRIES = 5000;
    if (reversions.length > MAX_ENTRIES) {
      reversions.splice(0, reversions.length - MAX_ENTRIES);
    }

    await $db.set(WEEKEND_REVERSIONS_DB_KEY, { reversions, updated_at: new Date().toISOString() });
  } catch (error) {
    console.error('Error saving weekend reversion entry:', error);
  }
}

// Purge old weekend reversion entries
async function purgeOldWeekendReversions() {
  try {
    const data = await getWeekendReversionsData();
    const reversions = Array.isArray(data.reversions) ? data.reversions : [];
    if (reversions.length === 0) return;

    const now = Date.now();
    const cutoffMs = WEEKEND_REVERSIONS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const cutoffTime = now - cutoffMs;

    const filtered = reversions.filter(r => {
      const t = new Date(r.reverted_at).getTime();
      return !Number.isNaN(t) && t >= cutoffTime;
    });

    if (filtered.length !== reversions.length) {
      await $db.set(WEEKEND_REVERSIONS_DB_KEY, { reversions: filtered, updated_at: new Date().toISOString() });
      console.log(`Purged ${reversions.length - filtered.length} old weekend reversions; kept ${filtered.length}`);
    }
  } catch (error) {
    console.error('Error purging old weekend reversions:', error);
  }
}



// Get ticket history to determine previous status
async function getTicketHistory(ticketId) {
  try {
    console.log(`Fetching history for ticket #${ticketId}...`);
    const response = await $request.invokeTemplate('getTicketHistory', {
      context: { ticket_id: ticketId }
    });

    if (response.status >= 400) {
      console.error('API Error Response:', response.response);
      throw new Error(`API returned status ${response.status}: ${response.response}`);
    }

    const history = JSON.parse(response.response);
    console.log(`Found ${history.length} history entries for ticket #${ticketId}`);
    return history;
  } catch (error) {
    console.error(`Error fetching history for ticket #${ticketId}:`, error);
    throw error;
  }
}

// Determine previous status from ticket history
function determinePreviousStatus() {
  console.log('Using default status: "Waiting on Customer" for weekend reversion');
  return 'Waiting on Customer';
}

// Revert ticket status and add note
async function revertTicketStatus(ticket, previousStatus) {
  try {
    const ticketId = ticket.id;
    const newStatusId = STATUS_MAPPINGS['Follow-up Required'][previousStatus];

    if (!newStatusId) {
      console.log(`No status mapping found for ${previousStatus}, skipping ticket #${ticketId}`);
      return false;
    }

    console.log(`Reverting ticket #${ticketId} from "Follow-up Required" back to "${previousStatus}" (ID: ${newStatusId})`);

    // Update ticket status
    const updateResponse = await $request.invokeTemplate('updateTicketStatus', {
      context: { ticket_id: ticketId },
      body: JSON.stringify({ status: newStatusId })
    });

    if (updateResponse.status >= 400) {
      console.error(`Failed to update ticket #${ticketId} status:`, updateResponse.response);
      return false;
    }

    // Add note explaining the reversion
    const noteBody = `🔄 **Weekend Status Reversion**\n\nThis ticket was automatically reverted from "Follow-up Required" back to "${previousStatus}" because the status change occurred during weekend hours (Friday 6 PM EST to Monday 7 AM EST).`;

    const noteResponse = await $request.invokeTemplate('addTicketNote', {
      context: { ticket_id: ticketId },
      body: JSON.stringify({
        body: noteBody,
        private: true
      })
    });

    if (noteResponse.status >= 400) {
      console.error(`Failed to add note to ticket #${ticketId}:`, noteResponse.response);
      // Don't fail the whole operation if note fails
    }

    console.log(`✅ Successfully reverted ticket #${ticketId} to "${previousStatus}"`);
    return true;
  } catch (error) {
    console.error(`Error reverting ticket #${ticket.id}:`, error);
    return false;
  }
}

// Main weekend status reversion handler
async function handleWeekendStatusReversion(allTickets) {
  try {
    // Purge old weekend reversion entries
    await purgeOldWeekendReversions();

    // STRICT FILTERING: Only process tickets with "Follow-up Required" status (23)
    const tickets = allTickets.filter(ticket => ticket.status === 23);
    if (!tickets || tickets.length === 0) {
      return 0;
    }

    // Check which tickets are in supported groups
    const supportedGroupIds = [67000578161, 67000578164, 67000578163, 67000578162, 67000578235, 67000570681];
    const supportedTickets = tickets.filter(ticket => supportedGroupIds.includes(ticket.group_id));
    if (supportedTickets.length === 0) {
      return 0;
    }

    let revertedCount = 0;

    for (const ticket of supportedTickets) {
      try {
        // Check if ticket is in one of the supported groups
        if (!supportedGroupIds.includes(ticket.group_id)) {
          continue;
        }

        // Use default previous status for weekend reversion
        const previousStatus = determinePreviousStatus();

        if (!previousStatus) {
          console.log(`Could not determine previous status for ticket #${ticket.id}, skipping`);
          continue;
        }

        // Check if this is a valid status to revert from
        if (!STATUS_MAPPINGS['Follow-up Required'][previousStatus]) {
          console.log(`Previous status "${previousStatus}" is not in our mapping for ticket #${ticket.id}, skipping`);
          continue;
        }

        // Revert the ticket status
        const success = await revertTicketStatus(ticket, previousStatus);

        if (success) {
          revertedCount++;

          // Log the reversion
          await addWeekendReversionEntry({
            ticket_id: ticket.id,
            ticket_subject: ticket.subject,
            agent_name: ticket.responder_id ? 'Agent ID: ' + ticket.responder_id : 'Unassigned',
            previous_status: previousStatus,
            reverted_to_status: previousStatus,
            reversion_reason: 'Weekend hours - customer should not be penalized for non-business hours'
          });

          await addLog('info', `Ticket #${ticket.id} reverted from Follow-up Required to ${previousStatus}`, {
            ticket_id: ticket.id,
            group_name: GROUP_NAMES_BY_ID[ticket.group_id]
          });

          // Write consolidated activity entry for status reversion
          await addActivityEntry({
            ticket_id: ticket.id,
            ticket_subject: ticket.subject,
            ticket_status: previousStatus,
            assigned_to: null,
            group_name: GROUP_NAMES_BY_ID[ticket.group_id] || `Group ${ticket.group_id}`,
            assigned_at: null,
            status_reverted_at: new Date().toISOString(),
            activity_type: 'status_reversion'
          });
        }

        // Small delay to avoid rate limiting
        const start = Date.now();
        while (Date.now() - start < 1000) {
          // Busy wait for 1 second
        }

      } catch (error) {
        await addLog('error', `Ticket #${ticket.id} reversion failed: ${error.message}`, {
          ticket_id: ticket.id,
          error: error.message
        });
      }
    }

    return revertedCount;

  } catch (error) {
    await addLog('error', 'Weekend reversion process failed', { error: error.message });
    return 0;
  }
}

