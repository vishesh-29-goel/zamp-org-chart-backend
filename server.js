require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
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

// ── SESSION ───────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'natwest-org-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000  // 24 hours
  }
}));

// ── PASSPORT GOOGLE OAUTH ─────────────────────────────────────────────────────
// Guard: only register the strategy if credentials are present.
// Without this guard, Passport throws at module load when env vars are missing,
// which prevents app.listen() from ever being called → Railway "service unavailable".
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL || 'http://localhost:3001/auth/google/callback'
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value || '';
    if (!email.endsWith('@zamp.ai')) {
      return done(null, false, { message: 'Only @zamp.ai accounts are allowed.' });
    }
    return done(null, { email, name: profile.displayName, picture: profile.photos?.[0]?.value });
  }));
} else {
  console.warn('WARNING: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — OAuth disabled');
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}


// ── AUTH ROUTES ────────────────────────────────────────────────────────────────
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth/failed' }),
  (req, res) => {
    // Redirect back to the frontend after successful login
    const frontendUrl = process.env.FRONTEND_URL || 'https://natwest-org.zampapps.com';
    res.redirect(frontendUrl + '?auth=success');
  }
);

app.get('/auth/failed', (req, res) => {
  res.status(403).json({ error: 'Only @zamp.ai accounts are allowed.' });
});

app.get('/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: req.user });
});

app.post('/auth/logout', (req, res) => {
  req.logout(() => res.json({ success: true }));
});

// ── DATABASE ───────────────────────────────────────────────────────────────────
// All email data is read from crm_client_emails (populated daily by the CRM refresh).
// client_id=6 is NatWest. No Composio API key needed.
const { CLIENTS } = require('./clients');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ── EMAIL ROUTES ───────────────────────────────────────────────────────────────

// Fetch emails to/from a contact by their email address
// GET /api/emails/:contactEmail?client=natwest
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

// Search emails by contact name (for contacts whose email address isn't known)
// GET /api/emails/search?name=Gary+Southgate&client=natwest
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

// Get all emails in a thread by thread_id
// GET /api/emails/thread/:threadId?client=natwest
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

// ── INTERACTION LOG ROUTES ─────────────────────────────────────────────────────
// Manually-logged touchpoints stored in DB (persists across server restarts)

// Ensure table exists on startup
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
      [contactEmail, clientId, type || 'note', notes || '', date || new Date().toISOString(), req.user.email]
    );
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('DB interactions insert error:', err.message);
    res.status(500).json({ error: 'Failed to save interaction' });
  }
});

// ── HEALTH CHECK ───────────────────────────────────────────────────────────────
// Both / and /health return 200 — Railway probes / by default
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'zamp-org-chart-backend' });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    env: process.env.NODE_ENV || 'development',
    oauth: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  });
});

// ── START ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`NatWest Org Backend running on port ${PORT}`);
  console.log(`Google OAuth client: ${process.env.GOOGLE_CLIENT_ID?.slice(0, 30)}...`);
});

