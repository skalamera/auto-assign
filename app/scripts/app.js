document.addEventListener('DOMContentLoaded', function() {
  const app = window.app;
  const client = app.initialized();

  client.then(function(clientObj) {
    // Get DOM elements
    const intervalInput = document.getElementById('interval');
    const serviceStatus = document.getElementById('service-status');
    const statusText = document.getElementById('status-text');
    const saveBtn = document.getElementById('save-btn');
    const notification = document.getElementById('notification');

    // Update status text when toggle is clicked
    serviceStatus.addEventListener('change', function() {
      statusText.textContent = this.checked ? 'Enabled' : 'Disabled';
    });

    // Load existing configuration
    clientObj.iparams.get(["service_interval", "service_status"]).then(function(data) {
      if (data.service_interval) {
        intervalInput.value = data.service_interval;
      }
      if (data.service_status !== undefined) {
        serviceStatus.checked = data.service_status;
        statusText.textContent = data.service_status ? 'Enabled' : 'Disabled';
      }
    }).catch(function(error) {
      console.error('Error loading configuration:', error);
      showNotification('Error loading configuration. Please refresh the page.', 'error');
    });

    // Save configuration
    saveBtn.addEventListener('click', function() {
      const interval = parseInt(intervalInput.value, 10);
      
      // Validate input
      if (isNaN(interval) || interval < 30 || interval > 60) {
        showNotification('Please enter a valid interval between 30 and 60 minutes.', 'error');
        return;
      }

      // Save configuration to iparams
      clientObj.iparams.set({
        service_interval: interval,
        service_status: serviceStatus.checked
      }).then(function() {
        showNotification('Configuration saved successfully!', 'success');
        
        // Update the schedule based on new settings
        clientObj.request.invoke('updateSchedule', {
          interval: interval,
          status: serviceStatus.checked
        }).then(function() {
          console.log('Schedule updated successfully');
        }).catch(function(error) {
          console.error('Error updating schedule:', error);
          showNotification('Configuration saved but schedule update failed.', 'warning');
        });
      }).catch(function(error) {
        console.error('Error saving configuration:', error);
        showNotification('Error saving configuration. Please try again.', 'error');
      });
    });

    // Helper function to show notifications
    function showNotification(message, type) {
      notification.textContent = message;
      notification.className = 'notification ' + type;
      notification.style.display = 'block';
      
      // Hide notification after 5 seconds
      setTimeout(function() {
        notification.style.display = 'none';
      }, 5000);
    }
  });
});