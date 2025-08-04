/**
 * Ticket Assignment Automation App
 * This app automatically assigns unassigned tickets to agents in a round-robin fashion
 */

// Store the current agent index for round-robin assignment
let currentAgentIndex = 0;

// Handler for scheduled events
exports = {
  // Handler for the app installation
  onAppInstallHandler: async function(payload) {
    console.log('App installed successfully');
    
    try {
      // Create a recurring schedule based on the configuration
      const interval = payload.iparams.service_interval || 30;
      const status = payload.iparams.service_status !== false;
      
      if (status) {
        await createSchedule(interval);
        console.log(`Scheduled ticket assignment created with ${interval} minute interval`);
      } else {
        console.log('Ticket assignment service is disabled');
      }
    } catch (error) {
      console.error('Error during app installation:', error);
    }
  },

  // Handler for scheduled events - assigns unassigned tickets
  onScheduledEventHandler: async function(payload) {
    console.log('Running scheduled ticket assignment');
    
    try {
      // Check if the service is enabled
      const data = await $db.get('service_status');
      if (data && data === false) {
        console.log('Ticket assignment service is disabled');
        return;
      }

      // Get all unassigned tickets
      const ticketsResponse = await $request.invokeTemplate('getUnassignedTickets', {});
      const tickets = JSON.parse(ticketsResponse.response);
      
      if (!tickets || tickets.length === 0) {
        console.log('No unassigned tickets found');
        return;
      }
      
      console.log(`Found ${tickets.length} unassigned tickets`);
      
      // Get all active agents
      const agentsResponse = await $request.invokeTemplate('getAgents', {});
      const agents = JSON.parse(agentsResponse.response);
      
      // Filter out inactive agents
      const activeAgents = agents.filter(agent => 
        agent.occasional === false && 
        agent.available === true
      );
      
      if (!activeAgents || activeAgents.length === 0) {
        console.log('No active agents available for assignment');
        return;
      }
      
      console.log(`Found ${activeAgents.length} active agents for assignment`);
      
      // Get the saved agent index or reset to 0
      try {
        const savedIndex = await $db.get('current_agent_index');
        if (savedIndex !== undefined && savedIndex !== null) {
          currentAgentIndex = parseInt(savedIndex, 10);
        }
      } catch (error) {
        console.log('No saved agent index found, starting from 0');
        currentAgentIndex = 0;
      }
      
      // Assign tickets in round-robin fashion
      for (const ticket of tickets) {
        // Get the next agent in rotation
        const agent = activeAgents[currentAgentIndex];
        
        // Assign the ticket to the agent
        await $request.invokeTemplate('assignTicket', {
          context: { ticket_id: ticket.id },
          body: JSON.stringify({ responder_id: agent.id })
        });
        
        console.log(`Ticket #${ticket.id} assigned to agent ${agent.contact.name} (ID: ${agent.id})`);
        
        // Update the agent index for round-robin
        currentAgentIndex = (currentAgentIndex + 1) % activeAgents.length;
      }
      
      // Save the current agent index for next run
      await $db.set('current_agent_index', currentAgentIndex);
      
    } catch (error) {
      console.error('Error during ticket assignment:', error);
    }
  },

  // SMI to update schedule based on configuration changes
  updateSchedule: async function(args) {
    try {
      const interval = args.interval || 30;
      const status = args.status !== false;
      
      // Store the updated service status in the database
      await $db.set('service_status', status);
      
      if (status) {
        // Update or create the schedule
        await createSchedule(interval);
        console.log(`Schedule updated with ${interval} minute interval`);
        return { success: true, message: 'Schedule updated successfully' };
      } else {
        // Try to delete the schedule if service is disabled
        try {
          await $schedule.delete({
            name: "ticket_assignment_schedule"
          });
          console.log('Schedule deleted successfully');
        } catch (error) {
          console.log('No existing schedule to delete or error deleting:', error.message);
        }
        
        return { success: true, message: 'Service disabled and schedule removed' };
      }
    } catch (error) {
      console.error('Error updating schedule:', error);
      return { success: false, message: 'Failed to update schedule', error: error.message };
    }
  }
};

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
      console.log('No existing schedule to delete or error deleting:', error.message);
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