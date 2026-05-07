require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────────────────────────
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

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const email = req.headers['x-user-email'] || '';
  if (!email.endsWith('@zamp.ai')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.userEmail = email;
  next();
}

// ── DATABASE ──────────────────────────────────────────────────────────────────
const { CLIENTS } = require('./clients');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ── EMAIL ROUTES ──────────────────────────────────────────────────────────────

// GET /api/emails/threads/:contactEmail
// Returns threads grouped by thread_id, each with summary + all messages inline
app.get('/api/emails/threads/:contactEmail', requireAuth, async (req, res) => {
  const { contactEmail } = req.params;
  const clientId = req.query.client || 'natwest';
  const clientDbId = CLIENTS[clientId]?.dbId;
  if (!clientDbId) return res.status(400).json({ error: `Unknown client: ${clientId}` });

  try {
    // Get all emails touching this contact, then group in JS
    const result = await pool.query(
      `SELECT id, gmail_message_id, thread_id, from_address, to_address,
              subject, body_snippet, full_body, direction, received_at, created_at
       FROM crm_client_emails
       WHERE client_id = $1
         AND (from_address ILIKE $2 OR to_address ILIKE $2)
       ORDER BY COALESCE(received_at, created_at) ASC`,
      [clientDbId, `%${contactEmail}%`]
    );

    // Group by thread_id
    const threadMap = new Map();
    for (const row of result.rows) {
      const tid = row.thread_id || row.gmail_message_id;
      if (!threadMap.has(tid)) {
        threadMap.set(tid, { thread_id: tid, messages: [] });
      }
      threadMap.get(tid).messages.push(row);
    }

    // Build thread summaries (newest thread first)
    const threads = Array.from(threadMap.values()).map(t => {
      const msgs = t.messages;
      const last = msgs[msgs.length - 1];
      const first = msgs[0];
      const directions = [...new Set(msgs.map(m => m.direction))];
      return {
        thread_id: t.thread_id,
        subject: first.subject?.replace(/^(Re|RE|Fwd|FW):\s*/i, '').trim() || '(no subject)',
        message_count: msgs.length,
        last_date: last.received_at || last.created_at,
        direction: directions.includes('inbound') && directions.includes('outbound') ? 'both'
                   : directions[0] || 'outbound',
        participants: [...new Set(msgs.flatMap(m => [m.from_address, m.to_address])
          .join(',').split(',').map(s => s.trim()).filter(Boolean))],
        messages: msgs
      };
    });

    // Sort newest first
    threads.sort((a, b) => new Date(b.last_date) - new Date(a.last_date));

    res.json({ threads, total: threads.length });
  } catch (err) {
    console.error('DB thread fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// Legacy flat email endpoint (keep for backwards compat)
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

// ── INTERACTION LOG ROUTES ────────────────────────────────────────────────────
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

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'zamp-org-chart-backend' }));
app.get('/health', (req, res) => res.json({ status: 'ok', env: process.env.NODE_ENV || 'development' }));

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`NatWest Org Backend running on port ${PORT}`));
