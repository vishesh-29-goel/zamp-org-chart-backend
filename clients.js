// ─── CLIENT CONFIG ────────────────────────────────────────────────────────────
// Add a new entry here when onboarding a new client org chart.
// dbId: the client_id in the crm_client_emails table (check crm_clients to find it).

const CLIENTS = {
  natwest: {
    name: 'NatWest',
    dbId: 6,  // crm_clients.id = 6 (NatWest)
    frontendUrl: 'https://natwest-org.zampapps.com'
  }
  // Future clients — find their dbId with:
  // SELECT id, name FROM crm_clients WHERE name ILIKE '%instacart%';
  // instacart: {
  //   name: 'Instacart',
  //   dbId: <id from crm_clients>,
  //   frontendUrl: 'https://instacart-org.zampapps.com'
  // }
};

module.exports = { CLIENTS };
