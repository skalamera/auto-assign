/**
 * Auto-Assign App
 * This app automatically assigns tickets to agents using round-robin within groups
 */

document.addEventListener("DOMContentLoaded", function () {
    console.log('Auto-Assign app.js - DOMContentLoaded');

    // Check if we're in Freshdesk environment
    if (typeof app !== 'undefined' && app.initialized) {
        // App initialization
        app.initialized()
            .then(function (client) {
                // App is initialized
                window.client = client;
                console.log('Auto-Assign app initialized, client available as window.client');

                // Dispatch a custom event to notify other scripts
                window.dispatchEvent(new CustomEvent('freshdesk-client-ready', { detail: { client: client } }));
            })
            .catch(function (error) {
                console.error('Error initializing app:', error);
            });
    } else {
        console.log('Auto-Assign app.js - Not in Freshdesk environment (app object not found)');
    }
});