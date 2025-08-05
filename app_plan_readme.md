# Describe the idea
Setup a serverless scheduled event app in Freshdesk to look every 30-60 minutes for any unassigned tickets received throughout the night and assign them in a round robin fashion.


# Describe the app UI
The app uses installation parameters (iparams) for configuration. Users can set the intervals for the scheduled event (30-60 minutes) and have the option to turn the service on or off during app installation and configuration.


# List of core features
- Scheduled event app
- Look for unassigned tickets every 30-60 minutes
- Assign tickets in a round robin fashion
- Configuration setup page to set the intervals
- Turn the service on/off
- Comprehensive logging system for monitoring and troubleshooting


# Future Considerations
- Customizable assignment rules based on ticket priority
- Notification system for assigned tickets
- Integration with agent availability status



# Implementation Plan
## Describe the UI to be built for every placeholder
- Placeholder: full_page_app in Freshdesk
Configuration setup page with interval selector (30-60 minutes) and a toggle switch to turn the service on/off.


## Details on what and how to fetch installation parameters
Add installation parameters for configuring scheduled frequency with a default value of 30 minutes and a service status toggle with on/off options.

## Scheduled Event: Register & Implement Scheduled Event
Register a scheduled event using serverless.js with a configurable interval between 30-60 minutes to fetch unassigned tickets via Freshdesk API, then assign them to agents in round robin fashion.

## Installation Parameters: Configure App Settings
The app uses installation parameters (iparams) for configuration. Users can set the schedule interval and service status during app installation and modify them later through the Freshdesk app configuration page.

## File Structure

`manifest.json`: App manifest defining modules, event handlers, and API requests
`config/iparams.json`: Installation parameters schema defining configuration options for ticket assignment service
`server/server.js`: Backend implementation of ticket assignment logic with round-robin distribution and logging
`config/requests.json`: API request templates for Freshdesk ticket and agent operations
`logs.html`: Log viewer interface for monitoring app activity and troubleshooting

## Steps to run the app
- Run "fdk validate", it lists the errors and warnings in the app.
- Address the errors before you run the app. You can also use Freddy co-pilot to fix (lint)
- Once validation is successfully passed, execute "fdk run"
- Starting local testing server at  "http://*:10001" 
- Append "dev=true" to your current host URL to start testing
- e.g:
	- https://domain.freshdesk.com/a/tickets/1?dev=true
- To test the installation parameters, visit - http://localhost:10001/custom_configs
- To view app logs, visit - http://localhost:10001/logs.html
- To simulate product, app setup, and external events, visit - http://localhost:10001/web/test
	Populating test data with events found in the app
