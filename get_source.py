import requests
import time
import logging
import pandas as pd
from pandas import json_normalize

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

# Freshdesk credentials
API_KEY = "59uXal9xdL1XHfLn2D58"
DOMAIN = "benchmarkeducationcompany.freshdesk.com"
BASE_URL = f"https://{DOMAIN}/api/v2/tickets"

# Ticket IDs to fetch
TICKET_IDS = [
    322331, 322322, 322300, 322111, 322084, 322055, 322050,
    322035, 322020, 322002, 321983, 321875, 321843, 321832,
    321829, 321780, 321774, 321765, 321747
]

def get_ticket(ticket_id):
    """Fetch full ticket JSON for a given ticket ID."""
    url = f"{BASE_URL}/{ticket_id}"
    try:
        response = requests.get(url, auth=(API_KEY, "X"))
        if response.status_code == 429:
            retry_after = int(response.headers.get("Retry-After", 5))
            logging.warning(f"Rate limit hit. Retrying after {retry_after} seconds...")
            time.sleep(retry_after)
            return get_ticket(ticket_id)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        logging.error(f"Error fetching ticket {ticket_id}: {e}")
        return None

def main():
    all_tickets = []

    for ticket_id in TICKET_IDS:
        logging.info(f"Fetching details for ticket {ticket_id}...")
        ticket = get_ticket(ticket_id)
        if ticket:
            all_tickets.append(ticket)
        time.sleep(0.1)  # stay well below 700 requests/minute

    if not all_tickets:
        logging.error("No tickets were retrieved.")
        return

    # Flatten JSON into a table
    df = json_normalize(all_tickets, sep="_")

    # Save to Excel
    output_file = "tickets.xlsx"
    df.to_excel(output_file, index=False)
    logging.info(f"Saved {len(all_tickets)} tickets to {output_file}")

if __name__ == "__main__":
    main()
