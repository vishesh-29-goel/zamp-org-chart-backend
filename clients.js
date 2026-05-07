// ─── CLIENT CONFIG ────────────────────────────────────────────────────────────
// Add a new entry here when onboarding a new client org chart.
// composioConnectionId: the customer@ mailbox Composio connection for that client.

const CLIENTS = {
  natwest: {
    name: 'NatWest',
    composioConnectionId: '7b7c19e1-c755-409b-9c11-e0437a4ba260',
    frontendUrl: 'https://natwest-org.zampapps.com'
  }
  // Future clients:
  // instacart: {
  //   name: 'Instacart',
  //   composioConnectionId: '<instacart customer@ connection id>',
  //   frontendUrl: 'https://instacart-org.zampapps.com'
  // }
};

module.exports = { CLIENTS };
