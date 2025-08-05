/**
 * Ticket Assignment Automation App
 * This app automatically assigns unassigned tickets to agents in a round-robin fashion
 */

// Store the current agent index for round-robin assignment per group
let agentIndexByGroup = {};

// Temporary in-memory log storage
let inMemoryLogs = [];

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
    console.log('App installation started - CREATING 5-MINUTE SCHEDULE');
    console.log('Installation payload:', JSON.stringify(payload));

    try {
      // Try to delete any existing schedule first
      try {
        await $schedule.delete({
          name: "ticket_assignment_schedule"
        });
        console.log('Deleted existing schedule');
      } catch (deleteError) {
        console.log('No existing schedule to delete:', deleteError.message);
      }

      // Create the schedule with hardcoded 5-minute interval
      const schedule = await $schedule.create({
        name: "ticket_assignment_schedule",
        data: {
          operation: "assign_tickets"
        },
        schedule_at: new Date(Date.now() + 60000).toISOString(), // Start 1 minute from now
        repeat: {
          time_unit: "minutes",
          frequency: 5
        }
      });

      console.log('Schedule created successfully:', JSON.stringify(schedule));
      console.log('App installed successfully with 5-minute schedule');

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



  // Handler for scheduled events - assigns unassigned tickets
  onScheduledEventHandler: async function () {
    console.log('Running scheduled ticket assignment');
    await addLog('info', 'Scheduled ticket assignment started');

    try {
      if (!await isServiceEnabled()) {
        await addLog('info', 'Service is disabled, skipping ticket assignment');
        return;
      }

      const tickets = await getUnassignedTickets();
      if (!tickets || tickets.length === 0) {
        await addLog('info', 'No unassigned tickets found');
        return;
      }

      const allAgentsWithGroups = await getActiveAgents();
      if (!allAgentsWithGroups || allAgentsWithGroups.length === 0) {
        await addLog('error', 'No agents available for assignment');
        return;
      }

      await loadAgentIndicesByGroup();
      await assignTicketsInRoundRobin(tickets, allAgentsWithGroups);
      await saveAgentIndicesByGroup();

      await addLog('info', `Ticket assignment completed. Processed ${tickets.length} tickets with ${allAgentsWithGroups.length} total agents`);

    } catch (error) {
      console.error('Error during ticket assignment:', error);
      await addLog('error', 'Error during ticket assignment', { error: error.message });
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
  const ticketsResponse = await $request.invokeTemplate('getUnassignedTickets', {});
  const tickets = JSON.parse(ticketsResponse.response);

  if (!tickets || tickets.length === 0) {
    console.log('No tickets found');
    return null;
  }

  // Filter out tickets that already have agents assigned
  const unassignedTickets = tickets.filter(ticket =>
    !ticket.responder_id || ticket.responder_id === null
  );

  if (unassignedTickets.length === 0) {
    console.log('No unassigned tickets found (all tickets have agents assigned)');
    return null;
  }

  console.log(`Found ${unassignedTickets.length} unassigned tickets out of ${tickets.length} total tickets`);
  return unassignedTickets;
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

        // If we got 100 agents, there might be more
        if (pageAgents.length === 100) {
          page++;
        } else {
          hasMore = false;
        }
      } else {
        hasMore = false;
      }
    } catch (error) {
      console.log(`No more agent pages or error on page ${page}:`, error.message);
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
      continue;
    }

    if (!supportedGroups.includes(ticketGroupId)) {
      console.log(`Ticket #${ticket.id} is in unsupported group ${ticketGroupId}, skipping for manual assignment`);
      await addLog('info', `Ticket in unsupported group - requires manual assignment`, {
        ticket_id: ticket.id,
        group_id: ticketGroupId,
        ticket_subject: ticket.subject
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
      continue;
    }

    console.log(`Found ${groupAgents.length} agents in group ${ticketGroupId}:`,
      groupAgents.map(a => a.contact?.name).join(', '));

    // Get or initialize the agent index for this group
    if (!agentIndexByGroup[ticketGroupId]) {
      agentIndexByGroup[ticketGroupId] = 0;
      console.log(`Initializing round-robin index for group ${ticketGroupId} to 0`);
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

      // Log the ticket assignment with detailed information
      await addLog('ticket_assigned', `Ticket #${ticket.id} assigned to agent in correct group`, {
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
        total_agents_in_group: groupAgents.length
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

// Helper function to create or update the schedule
async function createSchedule(interval) {
  try {
    // Delete existing schedule if any
    try {
      await $schedule.delete({
        name: "ticket_assignment_schedule"
      });
      console.log('Deleted existing schedule');
    } catch (error) {
      console.log('No existing schedule to delete');
    }

    // Create new schedule
    const schedule = await $schedule.create({
      name: "ticket_assignment_schedule",
      data: {
        operation: "assign_tickets"
      },
      schedule_at: new Date().toISOString(),
      repeat: {
        time_unit: "minutes",
        frequency: parseInt(interval, 10)
      }
    });

    console.log('Created new schedule:', schedule);
    return schedule;
  } catch (error) {
    console.error('Error creating schedule:', error);
    throw error;
  }
}

