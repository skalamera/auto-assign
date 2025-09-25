import requests
import json
import logging
import time

# Freshdesk credentials
API_KEY = "59uXal9xdL1XHfLn2D58"
DOMAIN = "benchmarkeducationcompany.freshdesk.com"  
API_ENDPOINT = f"https://{DOMAIN}/api/v2/tickets"

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

# Helper function to handle rate limits
def make_request_with_retry(url, headers, payload):
    while True:
        response = requests.post(url, auth=(API_KEY, "X"), headers=headers, data=json.dumps(payload))
        
        if response.status_code == 429:
            retry_after = int(response.headers.get("Retry-After", 5))
            logging.warning(f"Rate limit hit. Retrying after {retry_after} seconds...")
            time.sleep(retry_after)
            continue
        return response

def create_test_ticket():
    headers = {
        "Content-Type": "application/json"
    }
    
    payload = {
        "description": "DO NOT TRIAGE THIS TICKET - This is a ticket created via API for testing purposes.",
        "subject": "Test Ticket - API",
        "email": "klaffoon@msdwarco.k12.in.us",
        "priority": 1,
        "status": 2
    }
    
    logging.info("Creating a test ticket for Kelly Laffoon...")
    response = make_request_with_retry(API_ENDPOINT, headers, payload)

    if response.status_code == 201:
        ticket = response.json()
        logging.info(f"Ticket created successfully! Ticket ID: {ticket['id']}")
        print(json.dumps(ticket, indent=2))
    else:
        logging.error(f"Failed to create ticket. Status Code: {response.status_code}, Response: {response.text}")

if __name__ == "__main__":
    create_test_ticket()
