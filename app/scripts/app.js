/**
 * Auto-Assign App
 * This app automatically assigns tickets to agents using round-robin within groups
 */

document.addEventListener("DOMContentLoaded", function () {
    // App initialization
    app.initialized()
        .then(function (client) {
            // App is initialized
            window.client = client;
            console.log('Auto-Assign app initialized');
        })
        .catch(function (error) {
            console.error('Error initializing app:', error);
        });
});