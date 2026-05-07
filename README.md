# NatWest Org Chart — Backend

Express.js backend for Google OAuth + Gmail email fetching.

## Deploy to Railway

### 1. Create a new Railway project
- Go to railway.app → New Project → Deploy from GitHub repo
- Or use the CLI: `railway init` then `railway up`

### 2. Set environment variables in Railway dashboard
```
GOOGLE_CLIENT_ID=249136820428-nlsvmllst73ppg3iptvkkhsg8b8r0fqi.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<from vault: Gmail OAuth - Vishesh>
CALLBACK_URL=https://natwest-org-api.up.railway.app/auth/google/callback
FRONTEND_URL=https://natwest-org.zampapps.com
SESSION_SECRET=<generate a random string>
NODE_ENV=production
COMPOSIO_API_KEY=<your Composio API key from app.composio.dev>
```

### 3. Update GCP OAuth redirect URI
In Google Cloud Console → APIs & Services → Credentials → your OAuth client:
- Add to Authorized redirect URIs: `https://natwest-org-api.up.railway.app/auth/google/callback`
- Add to Authorized JavaScript origins: `https://natwest-org.zampapps.com`

### 4. The domain will be: https://natwest-org-api.up.railway.app
(Railway auto-assigns this if you name the project `natwest-org-api`)

## Local dev
```bash
cp .env .env.local  # edit with real values
npm start
```
