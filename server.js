/* Post Pipeline backend (Node 18+).
   Serves the static frontend AND provides:
     • Google Workspace SSO (OAuth code flow) with a dev sign-in fallback
     • stateless, HMAC-signed cookie sessions (no server-side session store)
     • a shared board-state store with optimistic versioning:
         – Postgres (Neon/RDS/…) when DATABASE_URL is set   → hosted / prod
         – a local JSON file otherwise                       → laptop dev

   Config comes from environment variables first (for hosts with an ephemeral
   filesystem like Render), then server-config.json, then built-in defaults.
   Local dev needs nothing: `node server.js` → http://localhost:8771.
   See README for the Render + Neon deploy steps. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'server-config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const ENV = process.env;

/* ------------------------------------------------------------- config ---- */
const DEFAULT_CONFIG = {
  port: 8771,
  host: '0.0.0.0',                       // bind to the LAN; use 127.0.0.1 for laptop-only
  sessionSecret: '',                     // from SESSION_SECRET env, or auto-generated locally
  devLogin: true,                        // email-only sign-in; MUST be false in a public deploy
  google: { clientId: '', clientSecret: '' },
  allowedDomain: 'moonbug.com',          // only this Workspace domain may sign in ('' = any)
  adminEmails: ['chris.kuziara@moonbug.com'],  // always treated as Producer (bootstrap)
  databaseUrl: ''                        // Postgres connection string (Neon) → hosted mode
};

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { /* first run / hosted */ }
  cfg = Object.assign({}, DEFAULT_CONFIG, cfg);
  cfg.google = Object.assign({}, DEFAULT_CONFIG.google, cfg.google || {});

  // Environment overrides — the source of truth for hosted deploys, where the
  // filesystem is wiped on every restart so a config file can't be trusted.
  if (ENV.SESSION_SECRET) cfg.sessionSecret = ENV.SESSION_SECRET;
  if (ENV.GOOGLE_CLIENT_ID) cfg.google.clientId = ENV.GOOGLE_CLIENT_ID;
  if (ENV.GOOGLE_CLIENT_SECRET) cfg.google.clientSecret = ENV.GOOGLE_CLIENT_SECRET;
  if (ENV.ALLOWED_DOMAIN !== undefined) cfg.allowedDomain = ENV.ALLOWED_DOMAIN;
  if (ENV.ADMIN_EMAILS) cfg.adminEmails = ENV.ADMIN_EMAILS.split(',').map(s => s.trim()).filter(Boolean);
  if (ENV.DEV_LOGIN !== undefined) cfg.devLogin = ENV.DEV_LOGIN === 'true';
  if (ENV.DATABASE_URL) cfg.databaseUrl = ENV.DATABASE_URL;

  // Local dev only: persist a generated secret so sessions survive a restart.
  // (In a hosted deploy SESSION_SECRET is set, so we never reach this.)
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
    try {
      const toSave = Object.assign({}, cfg); delete toSave.databaseUrl;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2));
    } catch (e) { /* read-only fs — fine, secret just lives for this run */ }
  }
  return cfg;
}
const config = loadConfig();
const PORT = ENV.PORT || config.port;
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

/* ------------------------------------------------- state store (2 backends) */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, obj) {          // atomic: tmp + rename
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// The store exposes get()/version()/put(); put() is optimistic — it rejects a
// write whose base version is stale, unless the board is still empty (first
// write wins). Returns {ok:true, version} or {ok:false, current:{version,data}}.
function makeFileStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let store = readJson(STATE_PATH, { version: 0, data: null });
  return {
    kind: 'json file (' + STATE_PATH + ')',
    async init() {},
    async get() { return { version: store.version, data: store.data }; },
    async version() { return store.version; },
    async put(version, data) {
      if (store.data !== null && version !== store.version) return { ok: false, current: { version: store.version, data: store.data } };
      store = { version: store.version + 1, data };
      writeJson(STATE_PATH, store);
      return { ok: true, version: store.version };
    }
  };
}

function makePgStore(connectionString) {
  const { Pool } = require('pg');   // lazy — only a hosted deploy needs the dependency
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 5 });
  return {
    kind: 'postgres',
    async init() {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS board_state (' +
        'id int PRIMARY KEY DEFAULT 1, version int NOT NULL DEFAULT 0, data jsonb, CHECK (id = 1))'
      );
      await pool.query('INSERT INTO board_state (id, version, data) VALUES (1, 0, NULL) ON CONFLICT (id) DO NOTHING');
    },
    async get() {
      const r = await pool.query('SELECT version, data FROM board_state WHERE id = 1');
      const row = r.rows[0] || { version: 0, data: null };
      return { version: row.version, data: row.data };   // jsonb comes back already parsed
    },
    async version() {
      const r = await pool.query('SELECT version FROM board_state WHERE id = 1');
      return r.rows[0] ? r.rows[0].version : 0;
    },
    async put(version, data) {
      // one atomic statement does the version check + bump — no read-modify-write
      // race even with several writers. The `data IS NULL` clause lets the very
      // first write land regardless of the client's base version.
      const r = await pool.query(
        'UPDATE board_state SET version = version + 1, data = $1::jsonb ' +
        'WHERE id = 1 AND (version = $2 OR data IS NULL) RETURNING version',
        [JSON.stringify(data), version]
      );
      if (!r.rowCount) return { ok: false, current: await this.get() };
      return { ok: true, version: r.rows[0].version };
    }
  };
}

const storage = config.databaseUrl ? makePgStore(config.databaseUrl) : makeFileStore();

/* ------------------------------------------------- live update fan-out ---- */
// Plain-HTTP Server-Sent Events — no extra dependency, works through Render's
// proxy. Every open /api/events connection gets the new version the instant
// someone else's PUT lands, so the client can pull immediately instead of
// waiting for its next poll.
const sseClients = new Set();
function broadcastVersion(v) {
  const msg = 'event: version\ndata: ' + v + '\n\n';
  for (const res of sseClients) {
    try { res.write(msg); } catch (e) { sseClients.delete(res); }
  }
}

/* ------------------------------------------------------------ sessions ---- */
// Stateless: the signed cookie IS the session (base64url payload + HMAC), so
// there's nothing to persist — survives restarts and needs no shared store.
function sign(v) { return crypto.createHmac('sha256', config.sessionSecret).update(v).digest('base64url'); }

function createSession(user) {
  const payload = Buffer.from(JSON.stringify({ ...user, iat: Date.now() })).toString('base64url');
  return payload + '.' + sign(payload);
}
function getSession(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('pp_sid='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(7).split('.');
  if (!payload || !sig || sig !== sign(payload)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!data.iat || Date.now() - data.iat > SESSION_TTL) return null;
  return data;   // { email, name, picture, via, iat }
}
function sessionCookie(value, opts) {
  opts = opts || {};
  return 'pp_sid=' + value + '; Path=/; HttpOnly; SameSite=Lax' +
    (opts.secure ? '; Secure' : '') +
    (opts.expire ? '; Max-Age=0' : '; Max-Age=' + Math.floor(SESSION_TTL / 1000));
}

/* --------------------------------------------------------- google oauth --- */
const oauthStates = new Map();           // state -> expiry (10 min)
function googleConfigured() { return !!(config.google.clientId && config.google.clientSecret); }
// Honour the reverse-proxy's protocol header so the OAuth redirect is the real
// public https:// URL (a hosted app receives http internally behind TLS).
function baseUrl(req) {
  const xf = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xf || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return proto + '://' + req.headers.host;
}
function isSecure(req) { return baseUrl(req).startsWith('https'); }
function redirectUri(req) { return baseUrl(req) + '/auth/callback'; }

function googleAuthUrl(req) {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now() + 600000);
  for (const [k, exp] of oauthStates) if (exp < Date.now()) oauthStates.delete(k);
  const q = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });
  if (config.allowedDomain) q.set('hd', config.allowedDomain);
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
}

async function googleCallback(req, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !oauthStates.has(state)) throw new Error('Sign-in expired — please try again');
  oauthStates.delete(state);

  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code'
    })
  });
  const tok = await tokRes.json();
  if (!tok.access_token) throw new Error('Google rejected the sign-in (' + (tok.error || 'no token') + ')');

  const uiRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: 'Bearer ' + tok.access_token }
  });
  const ui = await uiRes.json();
  if (!ui.email || ui.email_verified === false) throw new Error('Google account has no verified email');
  const email = ui.email.toLowerCase();
  if (config.allowedDomain && !email.endsWith('@' + config.allowedDomain) &&
      !config.adminEmails.map(e => e.toLowerCase()).includes(email)) {
    throw new Error('Only @' + config.allowedDomain + ' accounts can sign in');
  }
  return { email, name: ui.name || email, picture: ui.picture || '', via: 'google' };
}

/* ------------------------------------------------------------- helpers ---- */
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain', '.woff2': 'font/woff2'
};
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  // never serve secrets, server internals or anything outside the project
  if (!file.startsWith(ROOT) || file.includes(path.sep + 'data' + path.sep) ||
      file === CONFIG_PATH || file === path.join(ROOT, 'server.js') || p.includes('..')) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* -------------------------------------------------------------- server ---- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const route = req.method + ' ' + url.pathname;

  try {
    /* ---- auth ---- */
    if (route === 'GET /api/me') {
      const s = getSession(req);
      if (!s) return sendJson(res, 401, {
        error: 'not signed in',
        devLogin: config.devLogin,
        googleConfigured: googleConfigured()
      });
      return sendJson(res, 200, {
        email: s.email, name: s.name, picture: s.picture, via: s.via,
        admin: config.adminEmails.map(e => e.toLowerCase()).includes(s.email),
        devLogin: config.devLogin, googleConfigured: googleConfigured()
      });
    }

    if (route === 'GET /auth/google') {
      if (!googleConfigured()) { res.writeHead(302, { Location: '/?err=' + encodeURIComponent('Google SSO isn’t configured yet — see README') }); return res.end(); }
      res.writeHead(302, { Location: googleAuthUrl(req) }); return res.end();
    }

    if (route === 'GET /auth/callback') {
      try {
        const user = await googleCallback(req, url);
        res.writeHead(302, { 'Set-Cookie': sessionCookie(createSession(user), { secure: isSecure(req) }), Location: '/' });
      } catch (e) {
        res.writeHead(302, { Location: '/?err=' + encodeURIComponent(e.message) });
      }
      return res.end();
    }

    if (route === 'POST /auth/dev') {
      if (!config.devLogin) return sendJson(res, 403, { error: 'dev sign-in is disabled' });
      const body = JSON.parse(await readBody(req) || '{}');
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return sendJson(res, 400, { error: 'enter a valid email' });
      const name = email.split('@')[0].split(/[._-]/).map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
      res.setHeader('Set-Cookie', sessionCookie(createSession({ email, name, picture: '', via: 'dev' }), { secure: isSecure(req) }));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'POST /auth/logout') {
      res.setHeader('Set-Cookie', sessionCookie('', { expire: true, secure: isSecure(req) }));
      return sendJson(res, 200, { ok: true });
    }

    /* ---- shared state (auth required) ---- */
    if (url.pathname.startsWith('/api/')) {
      if (!getSession(req)) return sendJson(res, 401, { error: 'not signed in' });

      if (route === 'GET /api/state') return sendJson(res, 200, await storage.get());
      if (route === 'GET /api/version') return sendJson(res, 200, { version: await storage.version() });

      if (route === 'GET /api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive'
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
        req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
        return;
      }

      if (route === 'PUT /api/state') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (!body.data) return sendJson(res, 400, { error: 'missing data' });
        // optimistic concurrency: a stale write is rejected with the current
        // state so the client can adopt it instead of clobbering a teammate.
        const result = await storage.put(body.version, body.data);
        if (!result.ok) return sendJson(res, 409, result.current);
        broadcastVersion(result.version);
        return sendJson(res, 200, { version: result.version });
      }
      return sendJson(res, 404, { error: 'unknown api route' });
    }

    /* ---- static frontend ---- */
    if (req.method === 'GET') return serveStatic(req, res, url);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'server error' });
  }
});

(async () => {
  try { await storage.init(); }
  catch (e) { console.error('Storage init failed:', e.message); process.exit(1); }

  server.listen(PORT, config.host, () => {
    const nets = os.networkInterfaces();
    const lan = Object.values(nets).flat().find(n => n && n.family === 'IPv4' && !n.internal);
    console.log('Post Pipeline server running:');
    console.log('  • This host:    http://localhost:' + PORT + '/');
    if (config.host !== '127.0.0.1' && lan) console.log('  • Team (LAN):   http://' + lan.address + ':' + PORT + '/');
    console.log('  • Storage:      ' + storage.kind);
    console.log('  • Google SSO:   ' + (googleConfigured() ? 'configured ✓' : 'not configured — dev sign-in active'));
    if (config.devLogin && storage.kind === 'postgres') {
      console.log('  ⚠ DEV_LOGIN is ON in a hosted deploy — set DEV_LOGIN=false once Google SSO works, or anyone with the URL can sign in.');
    }
  });
})();
