/* Post Pipeline backend — zero-dependency Node server (Node 18+).
   Serves the static frontend AND provides:
     • Google Workspace SSO (OAuth code flow) with a local dev sign-in fallback
     • cookie sessions (HMAC-signed, persisted across restarts)
     • a shared state store (data/state.json) with optimistic versioning,
       so every laptop on the network sees the same board.

   Run:  node server.js         → http://<your-lan-ip>:8771
   Config lives in server-config.json (created on first run). To enable real
   Google sign-in, paste an OAuth client id/secret there — see README. */
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
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');

/* ------------------------------------------------------------- config ---- */
const DEFAULT_CONFIG = {
  port: 8771,
  host: '0.0.0.0',                       // bind to the LAN; use 127.0.0.1 for laptop-only
  sessionSecret: '',                     // auto-generated below
  devLogin: true,                        // email-only sign-in; disable once Google SSO works
  google: { clientId: '', clientSecret: '' },
  allowedDomain: 'moonbug.com',          // only this Workspace domain may sign in ('' = any)
  adminEmails: ['chris.kuziara@moonbug.com']  // always treated as Producer (bootstrap)
};

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { /* first run */ }
  cfg = Object.assign({}, DEFAULT_CONFIG, cfg);
  cfg.google = Object.assign({}, DEFAULT_CONFIG.google, cfg.google || {});
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }
  return cfg;
}
const config = loadConfig();
const PORT = process.env.PORT || config.port;

/* ------------------------------------------------------ tiny persistence -- */
fs.mkdirSync(DATA_DIR, { recursive: true });
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, obj) {          // atomic: tmp + rename
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

let store = readJson(STATE_PATH, { version: 0, data: null });
let sessions = readJson(SESSIONS_PATH, {});   // sid -> {email,name,picture,created}
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

function saveSessions() { writeJson(SESSIONS_PATH, sessions); }

/* ------------------------------------------------------------ sessions ---- */
function sign(v) { return crypto.createHmac('sha256', config.sessionSecret).update(v).digest('hex').slice(0, 32); }

function createSession(user) {
  const sid = crypto.randomUUID();
  sessions[sid] = { ...user, created: Date.now() };
  saveSessions();
  return sid + '.' + sign(sid);
}
function getSession(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('pp_sid='));
  if (!raw) return null;
  const [sid, sig] = raw.slice(7).split('.');
  if (!sid || sig !== sign(sid)) return null;
  const s = sessions[sid];
  if (!s || Date.now() - s.created > SESSION_TTL) { delete sessions[sid]; return null; }
  return { sid, ...s };
}
function destroySession(req) {
  const s = getSession(req);
  if (s) { delete sessions[s.sid]; saveSessions(); }
}
function sessionCookie(value, expire) {
  return 'pp_sid=' + value + '; Path=/; HttpOnly; SameSite=Lax' +
    (expire ? '; Max-Age=0' : '; Max-Age=' + Math.floor(SESSION_TTL / 1000));
}

/* --------------------------------------------------------- google oauth --- */
const oauthStates = new Map();           // state -> expiry (10 min)
function googleConfigured() { return !!(config.google.clientId && config.google.clientSecret); }
function redirectUri(req) { return 'http://' + req.headers.host + '/auth/callback'; }

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
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
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
        res.writeHead(302, { 'Set-Cookie': sessionCookie(createSession(user)), Location: '/' });
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
      res.setHeader('Set-Cookie', sessionCookie(createSession({ email, name, picture: '', via: 'dev' })));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'POST /auth/logout') {
      destroySession(req);
      res.setHeader('Set-Cookie', sessionCookie('', true));
      return sendJson(res, 200, { ok: true });
    }

    /* ---- shared state (auth required) ---- */
    if (url.pathname.startsWith('/api/')) {
      if (!getSession(req)) return sendJson(res, 401, { error: 'not signed in' });

      if (route === 'GET /api/state') return sendJson(res, 200, store);
      if (route === 'GET /api/version') return sendJson(res, 200, { version: store.version });

      if (route === 'PUT /api/state') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (!body.data) return sendJson(res, 400, { error: 'missing data' });
        // optimistic concurrency: reject stale writes so nobody silently
        // overwrites a teammate's change; the client adopts the newer state
        if (store.data !== null && body.version !== store.version) {
          return sendJson(res, 409, store);
        }
        store = { version: store.version + 1, data: body.data };
        writeJson(STATE_PATH, store);
        return sendJson(res, 200, { version: store.version });
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

server.listen(PORT, config.host, () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find(n => n && n.family === 'IPv4' && !n.internal);
  console.log('Post Pipeline server running:');
  console.log('  • This laptop:  http://localhost:' + PORT + '/');
  if (config.host !== '127.0.0.1' && lan) console.log('  • Team (LAN):   http://' + lan.address + ':' + PORT + '/');
  console.log('  • Google SSO:   ' + (googleConfigured() ? 'configured ✓' : 'not configured — dev sign-in active (see README)'));
  console.log('  • Shared data:  ' + STATE_PATH);
});
