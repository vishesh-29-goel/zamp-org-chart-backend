require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const cors = require('cors');
const fetch = require('node-fetch');

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

// ── EMAIL ROUTES ───────────────────────────────────────────────────────────────
const { CLIENTS } = require('./clients');
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;

function getConnectionId(clientId) {
  const client = CLIENTS[clientId];
  if (!client) return null;
  return client.composioConnectionId;
}

// Fetch emails to/from a contact — requires ?client=natwest (etc.)
app.get('/api/emails/:contactEmail', requireAuth, async (req, res) => {
  const { contactEmail } = req.params;
  const clientId = req.query.client || 'natwest';
  const connectionId = getConnectionId(clientId);

  if (!connectionId) {
    return res.status(400).json({ error: `Unknown client: ${clientId}` });
  }

  if (!COMPOSIO_API_KEY) {
    return res.status(500).json({ error: 'COMPOSIO_API_KEY not configured' });
  }

  try {
    // Search Gmail for emails to/from the contact
    const query = `from:${contactEmail} OR to:${contactEmail}`;

    const response = await fetch('https://backend.composio.dev/api/v1/actions/GMAIL_LIST_THREADS/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': COMPOSIO_API_KEY
      },
      body: JSON.stringify({
        connectedAccountId: connectionId,
        input: {
          query: query,
          max_results: 20,
          include_spam_trash: false
        }
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Composio error:', err);
      return res.status(502).json({ error: 'Failed to fetch emails from Gmail' });
    }

    const data = await response.json();
    res.json({ emails: data?.data?.threads || data?.data || [], query });

  } catch (err) {
    console.error('Email fetch error:', err);
    res.status(500).json({ error: 'Internal error fetching emails' });
  }
});

// Search emails by person name (for contacts without email address)
app.get('/api/emails/search', requireAuth, async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name query param required' });
  const clientId = req.query.client || 'natwest';
  const connectionId = getConnectionId(clientId);
  if (!connectionId) return res.status(400).json({ error: `Unknown client: ${clientId}` });

  if (!COMPOSIO_API_KEY) {
    return res.status(500).json({ error: 'COMPOSIO_API_KEY not configured' });
  }

  const clientName = CLIENTS[clientId]?.name || clientId;
  try {
    const query = `"${name}" ${clientName}`;
    const response = await fetch('https://backend.composio.dev/api/v1/actions/GMAIL_LIST_THREADS/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': COMPOSIO_API_KEY },
      body: JSON.stringify({
        connectedAccountId: connectionId,
        input: { query, max_results: 15, include_spam_trash: false }
      })
    });
    const data = await response.json();
    res.json({ emails: data?.data?.threads || data?.data || [], query });
  } catch (err) {
    console.error('Name search error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Get a specific email thread
app.get('/api/emails/thread/:threadId', requireAuth, async (req, res) => {
  const { threadId } = req.params;
  const clientId = req.query.client || 'natwest';
  const connectionId = getConnectionId(clientId);
  if (!connectionId) return res.status(400).json({ error: `Unknown client: ${clientId}` });

  if (!COMPOSIO_API_KEY) {
    return res.status(500).json({ error: 'COMPOSIO_API_KEY not configured' });
  }

  try {
    const response = await fetch('https://backend.composio.dev/api/v1/actions/GMAIL_GET_THREAD/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': COMPOSIO_API_KEY
      },
      body: JSON.stringify({
        connectedAccountId: connectionId,
        input: { thread_id: threadId }
      })
    });

    const data = await response.json();
    res.json(data?.data || {});
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});


// ── INTERACTION LOG ROUTES (in-memory for now, upgrade to DB later) ────────────
// Store manually-logged interactions in memory (persists per server session)
const interactionLog = {}; // { contactEmail: [{ date, type, notes, loggedBy }] }

app.get('/api/interactions/:contactEmail', requireAuth, (req, res) => {
  const logs = interactionLog[req.params.contactEmail] || [];
  res.json({ interactions: logs });
});

app.post('/api/interactions/:contactEmail', requireAuth, (req, res) => {
  const { contactEmail } = req.params;
  const { type, notes, date } = req.body;

  if (!interactionLog[contactEmail]) interactionLog[contactEmail] = [];

  const entry = {
    id: Date.now(),
    date: date || new Date().toISOString(),
    type: type || 'note',
    notes: notes || '',
    loggedBy: req.user.email
  };

  interactionLog[contactEmail].unshift(entry);
  res.json({ success: true, entry });
});

// ── HEALTH CHECK ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV || 'development' });
});

// ── START ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`NatWest Org Backend running on port ${PORT}`);
  console.log(`Google OAuth client: ${process.env.GOOGLE_CLIENT_ID?.slice(0, 30)}...`);
});

