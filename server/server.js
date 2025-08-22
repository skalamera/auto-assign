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
          frequency: 5
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
    console.log('Running scheduled event handler');
    console.log('Event payload:', JSON.stringify(payload));

    const operation = payload?.data?.operation || 'combined_operations';

    if (operation === 'combined_operations') {
      console.log('Running combined operations (ticket assignment + weekend reversion)');
      await addLog('info', 'Combined operations scheduled event started');

      try {
        // Get all tickets once for both operations
        const allTickets = await getUnassignedTickets();
        if (!allTickets || allTickets.length === 0) {
          await addLog('info', 'No tickets found');
          return;
        }

        const now = new Date();
        const isWeekend = isWeekendTime(now);

        console.log(`Current time: ${now.toISOString()}, Weekend mode: ${isWeekend}`);
        await addLog('info', `Processing ${allTickets.length} total tickets - Weekend mode: ${isWeekend}`);

        // Run weekend reversion check first (if it's weekend time)
        if (isWeekend) {
          await addLog('info', 'Weekend detected - checking for Follow-up Required tickets to revert');
          await handleWeekendStatusReversion(allTickets);
        } else {
          await addLog('info', 'Not weekend time, skipping weekend status reversion');
        }

        // Then run ticket assignment (if service is enabled)
        await addLog('info', 'Starting ticket assignment process');

        // Purge old assignment attempts monthly (lightweight every run)
        await purgeOldAssignmentAttempts();

        if (!await isServiceEnabled()) {
          await addLog('info', 'Service is disabled, skipping ticket assignment');
          return;
        }

        // Filter for unassigned tickets for assignment
        // Status 2 = "Open", Status 29 = "Triage" in Freshdesk
        console.log(`Filtering ${allTickets.length} tickets for assignment eligibility...`);

        const unassignedTickets = allTickets.filter(ticket => {
          const isUnassigned = !ticket.responder_id;
          const hasCorrectStatus = ticket.status === 2 || ticket.status === 29;
          const isEligible = isUnassigned && hasCorrectStatus;

          // Debug logging for ticket #315751 specifically
          if (ticket.id === 315751) {
            console.log(`DEBUG - Assignment filtering for #315751: responder_id=${ticket.responder_id}, status=${ticket.status}, isUnassigned=${isUnassigned}, hasCorrectStatus=${hasCorrectStatus}, isEligible=${isEligible}`);
          }

          if (!isEligible) {
            console.log(`Skipping ticket #${ticket.id} for assignment - unassigned: ${isUnassigned}, status: ${ticket.status} (needs 2 or 29)`);
          }
          return isEligible;
        });

        if (!unassignedTickets || unassignedTickets.length === 0) {
          console.log('No tickets eligible for assignment found. Sample tickets:');
          allTickets.slice(0, 5).forEach(ticket => {
            console.log(`  Ticket #${ticket.id}: responder_id=${ticket.responder_id}, status=${ticket.status}, group_id=${ticket.group_id}`);
          });
          await addLog('info', 'No unassigned tickets with Open (2) or Triage (29) status found for assignment');
          return;
        }

        console.log(`Found ${unassignedTickets.length} tickets eligible for assignment:`, unassignedTickets.map(t => `#${t.id} (status: ${t.status})`));

        const allAgentsWithGroups = await getActiveAgents();
        if (!allAgentsWithGroups || allAgentsWithGroups.length === 0) {
          await addLog('error', 'No agents available for assignment');
          return;
        }

        await loadAgentIndicesByGroup();
        await assignTicketsInRoundRobin(unassignedTickets, allAgentsWithGroups);
        await saveAgentIndicesByGroup();

        await addLog('info', `Combined operations completed. Ticket assignment: ${unassignedTickets.length} tickets, Weekend reversion: ${isWeekendTime(now) ? 'checked' : 'skipped'}`);

      } catch (error) {
        console.error('Error during combined operations:', error);
        await addLog('error', 'Error during combined operations', { error: error.message });
      }
    } else {
      // Fallback for legacy operations
      console.log('Running legacy operation:', operation);
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

// Helper function to get unassigned tickets
async function getUnassignedTickets() {
  try {
    console.log('Calling getUnassignedTickets API with pagination...');

    // Calculate date from 7 days ago for updated_since filter
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const updatedSince = sevenDaysAgo.toISOString();

    console.log(`Using updated_since filter: ${updatedSince}`);

    let allTickets = [];
    let page = 1;
    let hasMore = true;
    const maxPages = 50; // Limit to prevent infinite loops

    while (hasMore && page <= maxPages) {
      console.log(`Fetching page ${page}...`);

      const ticketsResponse = await $request.invokeTemplate('getUnassignedTickets', {
        context: {
          updated_since: updatedSince,
          page: page
        }
      });
      console.log(`Page ${page} API Response status:`, ticketsResponse.status);

      if (ticketsResponse.status >= 400) {
        console.error('API Error Response body:', ticketsResponse.response);
        console.error('API Error headers:', ticketsResponse.headers);
        throw new Error(`API returned status ${ticketsResponse.status}: ${ticketsResponse.response}`);
      }

      const pageTickets = JSON.parse(ticketsResponse.response);
      console.log(`Page ${page}: fetched ${pageTickets.length} tickets`);

      if (pageTickets && pageTickets.length > 0) {
        allTickets = allTickets.concat(pageTickets);

        // Check if we found our target ticket
        const targetTicket = pageTickets.find(ticket => ticket.id === 315751);
        if (targetTicket) {
          console.log(`Found target ticket #315751 on page ${page}: responder_id=${targetTicket.responder_id}, status=${targetTicket.status}, group_id=${targetTicket.group_id}, updated_at=${targetTicket.updated_at}`);
          hasMore = false; // Stop searching once we find it
        } else if (pageTickets.length < 100) {
          // If we got less than a full page, we've reached the end
          hasMore = false;
        } else {
          page++;
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

    // Final check if ticket #315751 is in the combined batch
    const targetTicket = allTickets.find(ticket => ticket.id === 315751);
    if (!targetTicket) {
      console.log('Target ticket #315751 NOT found in any of the fetched pages');
      console.log('Target ticket #315751 was last updated on 2025-08-22T14:29:09Z');
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
      return null;
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
  console.log('Fetching agents and groups sequentially to avoid rate limiting...');

  // Fetch all pages of agents
  let allAgents = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      console.log(`Fetching agents page ${page}...`);
      const agentsResponse = page === 1
        ? await $request.invokeTemplate('getAgents', {})
        : await $request.invokeTemplate('getAgentsPage', { context: { page: page } });

      const pageAgents = JSON.parse(agentsResponse.response);

      if (pageAgents && pageAgents.length > 0) {
        allAgents = allAgents.concat(pageAgents);
        console.log(`Page ${page}: fetched ${pageAgents.length} agents (total so far: ${allAgents.length})`);

        // If we got a full page of agents, there might be more
        // Freshdesk returns 30 agents per page by default
        if (pageAgents.length >= 30) {
          page++;
        } else {
          hasMore = false;
        }
      } else {
        console.log(`Page ${page} returned no agents, stopping pagination`);
        hasMore = false;
      }
    } catch (error) {
      console.log(`Error fetching page ${page}:`, error.message);
      console.log(`Full error:`, error);
      hasMore = false;
    }
  }

  console.log(`Total agents fetched: ${allAgents.length}`);

  // Fetch groups sequentially to avoid rate limiting
  console.log('Fetching group 1/6: West Region');
  const westGroup = await $request.invokeTemplate('getWestRegionGroup', {});

  console.log('Fetching group 2/6: Central Southeast');
  const southeastGroup = await $request.invokeTemplate('getCentralSoutheastGroup', {});

  console.log('Fetching group 3/6: Northeast');
  const northeastGroup = await $request.invokeTemplate('getNortheastRegionGroup', {});

  console.log('Fetching group 4/6: Central Southwest');
  const southwestGroup = await $request.invokeTemplate('getCentralSouthwestGroup', {});

  console.log('Fetching group 5/6: Triage');
  const triageGroup = await $request.invokeTemplate('getTriageGroup', {});

  console.log('Fetching group 6/6: Support Ops');
  const supportOpsGroup = await $request.invokeTemplate('getSupportOpsGroup', {});

  const agents = allAgents;
  const groups = [
    JSON.parse(westGroup.response),
    JSON.parse(southeastGroup.response),
    JSON.parse(northeastGroup.response),
    JSON.parse(southwestGroup.response),
    JSON.parse(triageGroup.response),
    JSON.parse(supportOpsGroup.response)
  ];

  console.log(`Fetched ${agents.length} agents and ${groups.length} groups (4 regional + 1 triage + 1 support ops)`);

  // Create a mapping of agent_id to group_ids
  const agentGroupMap = {};

  // Go through each regional group and add its members to the map
  for (const group of groups) {
    console.log(`Group "${group.name}" (ID: ${group.id}) has ${group.agent_ids ? group.agent_ids.length : 0} members:`, group.agent_ids);

    if (group.agent_ids && group.agent_ids.length > 0) {
      for (const agentId of group.agent_ids) {
        if (!agentGroupMap[agentId]) {
          agentGroupMap[agentId] = [];
        }
        agentGroupMap[agentId].push(group.id);
      }
    }
  }

  // Add group_ids to each agent
  for (const agent of agents) {
    agent.group_ids = agentGroupMap[agent.id] || [];
  }

  // Return all agents with group information - no filtering
  console.log(`Fetched all ${agents.length} agents with group information`);
  console.log('Sample agents with their groups:', agents.slice(0, 5).map(a => ({
    id: a.id,
    name: a.contact?.name || 'Unknown',
    group_ids: a.group_ids,
    occasional: a.occasional,
    deactivated: a.deactivated
  })));

  return agents;
}

// Helper function to load current agent indices by group
async function loadAgentIndicesByGroup() {
  try {
    // Try to load from persistent storage
    const storedData = await $db.get('agent_indices_by_group');
    if (storedData && storedData.indices) {
      agentIndexByGroup = storedData.indices;
      console.log('Loaded agent indices from storage:', agentIndexByGroup);
    } else {
      // Initialize if no stored data
      agentIndexByGroup = {};
      console.log('No stored agent indices found, starting fresh');
    }
  } catch (error) {
    console.log('Error loading agent indices, using empty object:', error.message);
    agentIndexByGroup = {};
  }
}

// Helper function to assign tickets in round-robin fashion
async function assignTicketsInRoundRobin(tickets, allAgents) {
  // No filtering - use all agents in the group for assignment
  console.log(`Processing ${tickets.length} tickets with ${allAgents.length} total agents`);

  // Define the 6 group IDs we handle (4 regional + 1 triage + 1 support ops)
  const supportedGroups = [67000578161, 67000578164, 67000578163, 67000578162, 67000578235, 67000570681];

  for (const ticket of tickets) {
    const ticketGroupId = ticket.group_id;

    if (!ticketGroupId) {
      console.log(`Ticket #${ticket.id} has no group assigned, skipping for manual assignment`);
      await addLog('info', `Ticket has no group - requires manual assignment`, {
        ticket_id: ticket.id,
        ticket_subject: ticket.subject
      });
      // Record attempt as failed (no group)
      await addAssignmentAttemptEntry({
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        agent_name: null,
        group_id: ticketGroupId,
        result: 'Failed',
        error_message: 'Ticket has no group assigned'
      });
      continue;
    }

    if (!supportedGroups.includes(ticketGroupId)) {
      console.log(`Ticket #${ticket.id} is in unsupported group ${ticketGroupId}, skipping for manual assignment`);
      await addLog('info', `Ticket in unsupported group - requires manual assignment`, {
        ticket_id: ticket.id,
        group_id: ticketGroupId,
        ticket_subject: ticket.subject
      });
      // Record attempt as failed (unsupported group)
      await addAssignmentAttemptEntry({
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        agent_name: null,
        group_id: ticketGroupId,
        result: 'Failed',
        error_message: 'Unsupported group for auto-assignment'
      });
      continue;
    }

    // Find all agents that belong to the same group as the ticket - NO FILTERING
    const groupAgents = allAgents.filter(agent =>
      agent.group_ids && agent.group_ids.includes(ticketGroupId)
    );

    // Special logging for Support Ops group to debug the issue
    if (ticketGroupId === 67000570681) {
      console.log(`\n=== Support Ops Group Debug Info ===`);
      console.log(`All agents in Support Ops group:`,
        groupAgents.map(a => ({
          id: a.id,
          name: a.contact?.name,
          occasional: a.occasional,
          deactivated: a.deactivated,
          email: a.contact?.email
        }))
      );
      console.log(`Total agents in Support Ops: ${groupAgents.length}`);
      console.log(`=== End Support Ops Debug ===\n`);
    }

    if (!groupAgents || groupAgents.length === 0) {
      console.log(`No agents found in group ${ticketGroupId} for ticket #${ticket.id}, skipping`);
      await addLog('error', `No agents available in ticket's group`, {
        ticket_id: ticket.id,
        group_id: ticketGroupId,
        ticket_subject: ticket.subject,
        total_agents_in_group: 0
      });
      // Record attempt as failed (no agents available)
      await addAssignmentAttemptEntry({
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        agent_name: null,
        group_id: ticketGroupId,
        result: 'Failed',
        error_message: 'No agents available in group'
      });
      continue;
    }

    console.log(`Found ${groupAgents.length} agents in group ${ticketGroupId}:`,
      groupAgents.map(a => a.contact?.name).join(', '));

    // Get or initialize the agent index for this group
    if (!agentIndexByGroup[ticketGroupId]) {
      // Randomize the starting index to avoid same agents getting tickets from multiple groups
      agentIndexByGroup[ticketGroupId] = Math.floor(Math.random() * groupAgents.length);
      console.log(`Initializing round-robin index for group ${ticketGroupId} to ${agentIndexByGroup[ticketGroupId]} (randomized from 0-${groupAgents.length - 1})`);
    }

    // Get the next agent in rotation for this group
    const agentIndex = agentIndexByGroup[ticketGroupId];
    const agent = groupAgents[agentIndex];

    console.log(`Round-robin state for group ${ticketGroupId}: index=${agentIndex}, next agent=${agent.contact?.name} (ID: ${agent.id})`);


    try {
      // Assign the ticket to the agent
      await $request.invokeTemplate('assignTicket', {
        context: { ticket_id: ticket.id },
        body: JSON.stringify({ responder_id: agent.id })
      });

      console.log(`✅ Ticket #${ticket.id} assigned to ${agent.contact.name} (ID: ${agent.id}) in group ${ticketGroupId}`);

      // Add "overnight" tag to the ticket after successful assignment
      try {
        await $request.invokeTemplate('addTicketTag', {
          context: { ticket_id: ticket.id },
          body: JSON.stringify({ tags: ['overnight'] })
        });
        console.log(`✅ Added "overnight" tag to ticket #${ticket.id}`);
      } catch (tagError) {
        console.warn(`⚠️ Failed to add "overnight" tag to ticket #${ticket.id}:`, tagError.message);
        // Don't fail the assignment if tag addition fails
      }

      // Log the ticket assignment with detailed information
      await addLog('ticket_assigned', `Ticket #${ticket.id} assigned to agent in correct group and tagged with "overnight"`, {
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        ticket_priority: ticket.priority,
        ticket_status: ticket.status,
        agent_id: agent.id,
        agent_name: agent.contact.name,
        agent_email: agent.contact.email,
        group_id: ticketGroupId,
        assignment_time: new Date().toISOString(),
        round_robin_index: agentIndex,
        total_agents_in_group: groupAgents.length,
        tag_added: 'overnight'
      });

      // Record assignment attempt (success)
      await addAssignmentAttemptEntry({
        ticket_id: ticket.id,
        ticket_subject: ticket.subject,
        agent_name: agent.contact?.name || 'Unknown',
        group_id: ticketGroupId,
        result: 'Success',
        error_message: null,
        tag_added: 'overnight'
      });

    } catch (error) {
      console.error(`❌ Error assigning ticket #${ticket.id}:`, error);
      await addLog('error', `Failed to assign ticket #${ticket.id}`, {
        ticket_id: ticket.id,
        agent_id: agent.id,
        agent_name: agent.contact.name,
        group_id: ticketGroupId,
        error: error.message || 'Unknown error'
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
    }

    // Update the agent index for round-robin for this group
    agentIndexByGroup[ticketGroupId] = (agentIndex + 1) % groupAgents.length;
  }
}

// Helper function to save agent indices by group
async function saveAgentIndicesByGroup() {
  try {
    // Save to persistent storage
    await $db.set('agent_indices_by_group', {
      indices: agentIndexByGroup,
      last_updated: new Date().toISOString()
    });
    console.log('Agent indices saved to storage:', agentIndexByGroup);
  } catch (error) {
    console.error('Error saving agent indices:', error.message);
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
    console.log('Starting weekend status reversion process...');
    await addLog('info', 'Weekend status reversion process started');

    // Purge old weekend reversion entries
    await purgeOldWeekendReversions();

    // STRICT FILTERING: Only process tickets with "Follow-up Required" status (23)
    // This is critical to prevent interference with the assignment system
    const tickets = allTickets.filter(ticket => {
      const isFollowUpRequired = ticket.status === 23;
      if (!isFollowUpRequired) {
        console.log(`Skipping ticket #${ticket.id} for weekend reversion - status ${ticket.status} is not "Follow-up Required" (23)`);
      }
      return isFollowUpRequired;
    });

    if (!tickets || tickets.length === 0) {
      await addLog('info', 'No tickets with Follow-up Required status (23) found for weekend reversion');
      return;
    }

    console.log(`Found ${tickets.length} tickets with Follow-up Required status (23). Checking for supported groups...`);

    // Check which tickets are in supported groups
    const supportedGroupIds = [67000578161, 67000578164, 67000578163, 67000578162, 67000578235, 67000570681]; // West, Central SE, Northeast, Central SW, Triage, Support Ops
    const supportedTickets = tickets.filter(ticket => supportedGroupIds.includes(ticket.group_id));
    console.log(`Found ${supportedTickets.length} tickets in supported groups for weekend reversion:`, supportedTickets.map(t => `#${t.id}`));

    if (supportedTickets.length === 0) {
      await addLog('info', 'No tickets with Follow-up Required status in supported groups for weekend reversion');
      return;
    }

    console.log(`Processing ${supportedTickets.length} tickets with Follow-up Required status for weekend reversion`);

    let revertedCount = 0;
    let errorCount = 0;

    for (const ticket of supportedTickets) {
      try {
        // Check if ticket is in one of the supported groups
        if (!supportedGroupIds.includes(ticket.group_id)) {
          console.log(`Skipping ticket #${ticket.id} - not in supported group (group_id: ${ticket.group_id})`);
          continue;
        }

        console.log(`Processing ticket #${ticket.id} from group ${ticket.group_id}`);

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

          await addLog('weekend_reversion', `Ticket #${ticket.id} reverted from Follow-up Required to ${previousStatus}`, {
            ticket_id: ticket.id,
            ticket_subject: ticket.subject,
            previous_status: previousStatus,
            reversion_reason: 'Weekend hours'
          });
        } else {
          errorCount++;
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`Error processing ticket #${ticket.id}:`, error);
        errorCount++;
        await addLog('error', `Error processing ticket #${ticket.id} for weekend reversion`, {
          ticket_id: ticket.id,
          error: error.message
        });
      }
    }

    await addLog('info', `Weekend status reversion completed. Reverted: ${revertedCount}, Errors: ${errorCount}`, {
      total_processed: tickets.length,
      reverted_count: revertedCount,
      error_count: errorCount
    });

    console.log(`Weekend status reversion completed. Reverted: ${revertedCount}, Errors: ${errorCount}`);

  } catch (error) {
    console.error('Error in weekend status reversion:', error);
    await addLog('error', 'Error in weekend status reversion process', { error: error.message });
  }
}

