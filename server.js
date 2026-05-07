require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ───────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://natwest-org.zampapps.com',
  'http://localhost:3000',
  'http://localhost:8080'
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json());

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────
// Trusts x-user-email header (set by frontend after Google sign-in).
// Only allows @zamp.ai accounts.
function requireAuth(req, res, next) {
  const email = req.headers['x-user-email'] || '';
  if (!email.endsWith('@zamp.ai')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.userEmail = email;
  next();
}

// ── DATABASE ───────────────────────────────────────────────────────────────
const { CLIENTS } = require('./clients');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ── EMAIL ROUTES ───────────────────────────────────────────────────────────
app.get('/api/emails/:contactEmail', requireAuth, async (req, res) => {
  const { contactEmail } = req.params;
  const clientId = req.query.client || 'natwest';
  const clientDbId = CLIENTS[clientId]?.dbId;
  if (!clientDbId) return res.status(400).json({ error: `Unknown client: ${clientId}` });

  try {
    const result = await pool.query(
      `SELECT id, gmail_message_id, thread_id, from_address, to_address,
              subject, body_snippet, full_body, direction, received_at, created_at
       FROM crm_client_emails
       WHERE client_id = $1
         AND (from_address ILIKE $2 OR to_address ILIKE $2)
       ORDER BY received_at DESC NULLS LAST, created_at DESC
       LIMIT 50`,
      [clientDbId, `%${contactEmail}%`]
    );
    res.json({ emails: result.rows, total: result.rowCount });
  } catch (err) {
    console.error('DB email fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

app.get('/api/emails/search', requireAuth, async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name query param required' });
  const clientId = req.query.client || 'natwest';
  const clientDbId = CLIENTS[clientId]?.dbId;
  if (!clientDbId) return res.status(400).json({ error: `Unknown client: ${clientId}` });

  try {
    const result = await pool.query(
      `SELECT id, gmail_message_id, thread_id, from_address, to_address,
              subject, body_snippet, full_body, direction, received_at, created_at
       FROM crm_client_emails
       WHERE client_id = $1
         AND (from_address ILIKE $2 OR to_address ILIKE $2
              OR subject ILIKE $2 OR full_body ILIKE $2)
       ORDER BY received_at DESC NULLS LAST, created_at DESC
       LIMIT 30`,
      [clientDbId, `%${name}%`]
    );
    res.json({ emails: result.rows, total: result.rowCount });
  } catch (err) {
    console.error('DB email search error:', err.message);
    res.status(500).json({ error: 'Failed to search emails' });
  }
});

app.get('/api/emails/thread/:threadId', requireAuth, async (req, res) => {
  const { threadId } = req.params;
  const clientId = req.query.client || 'natwest';
  const clientDbId = CLIENTS[clientId]?.dbId;
  if (!clientDbId) return res.status(400).json({ error: `Unknown client: ${clientId}` });

  try {
    const result = await pool.query(
      `SELECT id, gmail_message_id, thread_id, from_address, to_address,
              subject, body_snippet, full_body, direction, received_at, created_at
       FROM crm_client_emails
       WHERE client_id = $1 AND thread_id = $2
       ORDER BY received_at ASC NULLS LAST, created_at ASC`,
      [clientDbId, threadId]
    );
    res.json({ messages: result.rows, total: result.rowCount });
  } catch (err) {
    console.error('DB thread fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// ── INTERACTION LOG ROUTES ─────────────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS org_chart_interactions (
    id SERIAL PRIMARY KEY,
    contact_email VARCHAR(255) NOT NULL,
    client_id VARCHAR(50) NOT NULL DEFAULT 'natwest',
    type VARCHAR(50) NOT NULL DEFAULT 'note',
    notes TEXT,
    interaction_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    logged_by VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('Failed to create interactions table:', err.message));

app.get('/api/interactions/:contactEmail', requireAuth, async (req, res) => {
  const clientId = req.query.client || 'natwest';
  try {
    const result = await pool.query(
      `SELECT id, contact_email, type, notes, interaction_date, logged_by, created_at
       FROM org_chart_interactions
       WHERE contact_email ILIKE $1 AND client_id = $2
       ORDER BY interaction_date DESC`,
      [req.params.contactEmail, clientId]
    );
    res.json({ interactions: result.rows });
  } catch (err) {
    console.error('DB interactions fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch interactions' });
  }
});

app.post('/api/interactions/:contactEmail', requireAuth, async (req, res) => {
  const { contactEmail } = req.params;
  const { type, notes, date } = req.body;
  const clientId = req.query.client || 'natwest';
  try {
    const result = await pool.query(
      `INSERT INTO org_chart_interactions (contact_email, client_id, type, notes, interaction_date, logged_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [contactEmail, clientId, type || 'note', notes || '', date || new Date().toISOString(), req.userEmail]
    );
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('DB interactions insert error:', err.message);
    res.status(500).json({ error: 'Failed to save interaction' });
  }
});

// ── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'zamp-org-chart-backend' }));
app.get('/health', (req, res) => res.json({ status: 'ok', env: process.env.NODE_ENV || 'development' }));

// ── START ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`NatWest Org Backend running on port ${PORT}`));
