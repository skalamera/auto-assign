# Auto-Assign App - Complete Implementation Guide

## Overview
This Freshdesk app automatically assigns unassigned tickets to agents using a round-robin algorithm within their respective groups. It runs every 5 minutes to check for new unassigned tickets.

## Core Functionality

### 1. Ticket Assignment Logic
- **Round-Robin Within Groups**: Tickets are assigned only to agents within the same group
- **Supported Groups** (with IDs):
  - West Region: 67000578161
  - Central Southeast Region: 67000578164
  - Northeast Region: 67000578163
  - Central Southwest Region: 67000578162
  - Triage: 67000578235
  - Support Ops: 67000570681
- **Unsupported Groups**: Tickets in other groups are skipped for manual assignment

### 2. Agent Filtering
- **Exclude**: Occasional agents (`agent.occasional === true`)
- **Exclude**: Deactivated agents (`agent.deactivated === true`)
- **Exclude**: Special accounts (Teams Channel, General Channel, Notifications)
- **Include**: All regular agents regardless of "available" status

### 3. Schedule
- Runs every 5 minutes (hardcoded)
- Created automatically on app installation
- Uses Freshdesk's `$schedule` API

## Technical Implementation

### Directory Structure
```
auto-assign/
├── manifest.json
├── config/
│   ├── iparams.json
│   └── requests.json
├── app/
│   ├── index.html
│   ├── icon.svg
│   ├── scripts/
│   │   └── app.js
│   └── styles/
│       └── style.css
├── server/
│   └── server.js
└── dist/
    └── auto-assign.zip
```

### Key Configuration Files

#### 1. manifest.json
```json
{
  "platform-version": "3.0",
  "modules": {
    "common": {
      "location": {
        "full_page_app": {
          "url": "index.html",
          "icon": "icon.svg"
        }
      },
      "events": {
        "onAppInstall": {
          "handler": "onAppInstallHandler"
        },
        "onScheduledEvent": {
          "handler": "onScheduledEventHandler"
        }
      },
      "functions": {
        "getLogs": {},
        "clearLogs": {}
      },
      "requests": {
        "getUnassignedTickets": {},
        "assignTicket": {},
        "getAgents": {},
        "getWestRegionGroup": {},
        "getCentralSoutheastGroup": {},
        "getNortheastRegionGroup": {},
        "getCentralSouthwestGroup": {},
        "getTriageGroup": {},
        "getSupportOpsGroup": {}
      }
    }
  }
}
```

#### 2. config/requests.json
All requests are hardcoded with:
- **Domain**: benchmarkeducationcompany.freshdesk.com
- **API Key**: Base64 encoded (Basic NVRNZ2JjWmRSRlk3MGhTcEVkajpY)
- **Filter for tickets**: "new_and_my_open"

Example request:
```json
{
  "getUnassignedTickets": {
    "schema": {
      "method": "GET",
      "host": "benchmarkeducationcompany.freshdesk.com",
      "path": "/api/v2/tickets",
      "query": {
        "filter": "new_and_my_open",
        "per_page": "100"
      },
      "headers": {
        "Authorization": "Basic NVRNZ2JjWmRSRlk3MGhTcEVkajpY",
        "Content-Type": "application/json"
      }
    }
  }
}
```

### Server Implementation (server.js)

#### Key Components:

1. **In-Memory Storage** (to avoid database issues):
   ```javascript
   let agentIndexByGroup = {};  // Tracks round-robin index per group
   let inMemoryLogs = [];       // Stores app logs
   ```

2. **Installation Handler**:
   ```javascript
   onAppInstallHandler: async function (payload) {
     // Creates a 5-minute schedule
     const schedule = await $schedule.create({
       name: "ticket_assignment_schedule",
       data: { operation: "assign_tickets" },
       schedule_at: new Date(Date.now() + 60000).toISOString(),
       repeat: { time_unit: "minutes", frequency: 5 }
     });
   }
   ```

3. **Scheduled Event Handler**:
   - Fetches unassigned tickets
   - Filters for `responder_id === null`
   - Gets all agents with group information
   - Assigns tickets using round-robin per group

4. **Key Functions**:
   - `getUnassignedTickets()`: Fetches tickets with "new_and_my_open" filter
   - `getActiveAgents()`: Fetches agents and group memberships
   - `assignTicketsInRoundRobin()`: Core assignment logic
   - `addLog()`: Logging function for tracking operations

#### API Rate Limiting
- Sequential API calls to avoid 429 errors
- No `setTimeout` (not available in serverless)
- Fetches groups one by one

#### Assignment Algorithm
```javascript
// For each ticket:
1. Check if ticket has a group_id
2. Check if group is in supported groups list
3. Filter agents for that group (excluding occasional/deactivated)
4. Get current round-robin index for the group
5. Assign to agent at that index
6. Increment index (wrapping around)
```

### Frontend Implementation

#### Logs Viewer (app/index.html)
- Full-page app showing operation logs
- Auto-refreshes every 10 seconds
- Shows ticket assignments, errors, and system events
- Uses Freshdesk's client API: `client.request.invoke('getLogs', {})`

#### Log Entry Format
```javascript
{
  timestamp: '2025-08-04T11:43:55.164Z',
  type: 'ticket_assigned|error|info',
  message: 'Description of event',
  details: {
    ticket_id: 123,
    agent_id: 456,
    group_id: 789,
    // ... other relevant data
  }
}
```

## Important Considerations

### 1. Error Handling
- Graceful handling of API failures
- Detailed logging for debugging
- Returns success/error objects from handlers

### 2. Freshdesk API Quirks
- Use "new_and_my_open" filter instead of "status:2 AND agent_id:null"
- Groups API returns `agent_ids` array, not on agent objects
- Must map group memberships manually

### 3. Local Development Issues
- Installation UI may spin indefinitely (cosmetic issue)
- `callback is not a function` errors can be ignored
- Port conflicts on 10001 - use `netstat -ano | findstr :10001`

### 4. Production Deployment
- Empty iparams.json may cause issues
- Needs proper directory structure (app/scripts/, app/styles/)
- All request paths must start with `/`
- Icon must be 64x64 for full_page_app

## Testing Commands

```bash
# Validate app
fdk validate

# Run locally
fdk run

# Pack for deployment
fdk pack

# Access locally
http://localhost:10001/custom_configs (installation)
http://localhost:10001/apps/-1/index.html?product=freshdesk (logs viewer)
```

## Common Issues & Solutions

1. **"Invalid filter" error**: Use "new_and_my_open" instead of custom filters
2. **Rate limiting (429)**: Use sequential API calls, not Promise.all
3. **No agents in group**: Groups API provides agent_ids, must fetch separately
4. **Installation fails**: Check directory structure, ensure all paths start with `/`
5. **Database errors**: Use in-memory storage instead of $db

## Future Enhancements

1. **Configurable assignment rules** (e.g., by skill, workload)
2. **Priority-based assignment**
3. **Business hours consideration**
4. **Agent workload balancing**
5. **Persistent storage for logs**
6. **Email notifications for assignments**
7. **Assignment history and analytics**

## Security Notes

- API key is hardcoded (not recommended for production)
- No user authentication for logs viewer
- Consider implementing proper iparam configuration
- Add rate limiting protection

## Base64 API Key Encoding

To encode API key for Authorization header:
```javascript
// Format: "apikey:X" encoded in Base64
// Example: "5SMgbcZdRFY70hSpEdj:X" → "NVRNZ2JjWmRSRlk3MGhTcEVkajpY"
```

## Dependencies

- Freshdesk FDK 9.5.2
- Node.js 18.20.4
- No external npm packages required

---

This documentation contains all the essential information needed to recreate the Auto-Assign app from scratch, including architecture decisions, implementation details, and lessons learned during development.