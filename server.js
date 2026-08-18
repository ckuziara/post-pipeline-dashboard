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
const folders = require('./folders');
const { makePgChat, parseTaskId } = require('./chat-store');
const { makeKeyVault } = require('./keyvault');
const { makeSlackBridge } = require('./slack-bridge');

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
  databaseUrl: '',                       // Postgres connection string (Neon) → hosted mode
  accessCode: ''                         // shared team code required by the email sign-in
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
  if (ENV.ACCESS_CODE) cfg.accessCode = ENV.ACCESS_CODE;

  // Local dev only: persist a generated secret so sessions survive a restart.
  // (In a hosted deploy SESSION_SECRET is set, so we never reach this.)
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
    try {
      const toSave = Object.assign({}, cfg);
      delete toSave.databaseUrl; delete toSave.accessCode;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2));
    } catch (e) { /* read-only fs — fine, secret just lives for this run */ }
  }
  return cfg;
}

// Constant-time compare so the code can't be guessed a character at a time.
// Both sides are hashed first, which also sidesteps length leakage.
function codeMatches(given) {
  const h = (s) => crypto.createHash('sha256').update(String(s || '')).digest();
  return crypto.timingSafeEqual(h(given), h(config.accessCode));
}
// Who may use the email sign-in: the configured Workspace domain, plus the
// bootstrap admins (who might be on another domain).
function emailAllowed(email) {
  if (!config.allowedDomain) return true;
  return email.endsWith('@' + config.allowedDomain) ||
         config.adminEmails.map(e => e.toLowerCase()).includes(email);
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

// One pool shared by the board store and the activity log — a hosted Postgres
// (Neon's free tier especially) counts connections, so we never open a second.
let pgPool = null;
function getPgPool(connectionString) {
  if (!pgPool) {
    const { Pool } = require('pg');   // lazy — only a hosted deploy needs the dependency
    // Verify the server certificate by default — Neon (and RDS/Aurora) present
    // certs from a public CA, so this just works and protects the connection
    // from interception. An on-prem Postgres with a self-signed cert can opt out
    // with PGSSL_NO_VERIFY=true rather than us weakening it for everyone.
    const ssl = { rejectUnauthorized: ENV.PGSSL_NO_VERIFY !== 'true' };
    pgPool = new Pool({ connectionString, ssl, max: 5 });
  }
  return pgPool;
}

function makePgStore(connectionString) {
  const pool = getPgPool(connectionString);
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

/* ------------------------------------------------- board backups (2 backends)
   Point-in-time copies of the whole board, kept in the database rather than
   downloaded — so a backup is available to whoever needs it from wherever they
   are, and taking one doesn't depend on someone remembering to file a JSON
   somewhere. Snapshots are made server-side from the stored state, never from
   what a client posts, so a stale or half-loaded tab can't record a bad copy.

   Capped: a board blob is small but not free, and a hosted free tier isn't the
   place for unbounded history. The oldest are dropped past the cap.
   `meta` holds the row summary so listing never has to read the blobs. */
const BACKUP_PATH = path.join(DATA_DIR, 'backups.json');
const BACKUP_CAP = 20;

function backupMeta(data) {
  return {
    shows: ((data && data.shows) || []).length,
    episodes: ((data && data.episodes) || []).length,
    bytes: Buffer.byteLength(JSON.stringify(data || null))
  };
}

function makeFileBackups() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let rows = readJson(BACKUP_PATH, []);
  const save = () => { try { writeJson(BACKUP_PATH, rows); } catch (e) {} };
  return {
    kind: 'json file',
    async init() {},
    async create({ label, email, version, data }) {
      const row = {
        id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
        ts: new Date().toISOString(), email, label: label || null, version,
        meta: backupMeta(data), data
      };
      rows.push(row);
      if (rows.length > BACKUP_CAP) rows = rows.slice(-BACKUP_CAP);
      save();
      return { id: row.id, ts: row.ts, email, label: row.label, version, meta: row.meta };
    },
    async list() {
      return rows.slice().reverse().map(r =>
        ({ id: r.id, ts: r.ts, email: r.email, label: r.label, version: r.version, meta: r.meta }));
    },
    async get(id) { return rows.find(r => r.id === id) || null; },
    async remove(id) { const n = rows.length; rows = rows.filter(r => r.id !== id); save(); return n !== rows.length; }
  };
}

function makePgBackups(connectionString) {
  const pool = getPgPool(connectionString);
  return {
    kind: 'postgres',
    async init() {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS board_backups (' +
        'id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), ' +
        'email text, label text, version int, meta jsonb, data jsonb NOT NULL)'
      );
      await pool.query('CREATE INDEX IF NOT EXISTS board_backups_ts_idx ON board_backups (ts DESC)');
    },
    async create({ label, email, version, data }) {
      const meta = backupMeta(data);
      const r = await pool.query(
        'INSERT INTO board_backups (email, label, version, meta, data) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) ' +
        'RETURNING id, ts, email, label, version, meta',
        [email, label || null, version, JSON.stringify(meta), JSON.stringify(data)]
      );
      // drop the oldest past the cap, so history can't grow without bound
      await pool.query(
        'DELETE FROM board_backups WHERE id NOT IN (SELECT id FROM board_backups ORDER BY ts DESC LIMIT $1)',
        [BACKUP_CAP]
      );
      const row = r.rows[0];
      return { id: String(row.id), ts: row.ts, email: row.email, label: row.label, version: row.version, meta: row.meta };
    },
    async list() {
      // deliberately omits `data` — the list is metadata only
      const r = await pool.query(
        'SELECT id, ts, email, label, version, meta FROM board_backups ORDER BY ts DESC LIMIT $1', [BACKUP_CAP]);
      return r.rows.map(x => ({ id: String(x.id), ts: x.ts, email: x.email, label: x.label, version: x.version, meta: x.meta }));
    },
    async get(id) {
      if (!/^\d+$/.test(String(id))) return null;
      const r = await pool.query('SELECT id, ts, email, label, version, meta, data FROM board_backups WHERE id = $1', [id]);
      const row = r.rows[0];
      return row ? Object.assign({}, row, { id: String(row.id) }) : null;
    },
    async remove(id) {
      if (!/^\d+$/.test(String(id))) return false;
      const r = await pool.query('DELETE FROM board_backups WHERE id = $1', [id]);
      return !!r.rowCount;
    }
  };
}

const backups = config.databaseUrl ? makePgBackups(config.databaseUrl) : makeFileBackups();

/* ------------------------------------------------- activity log (2 backends)
   Append-only, and deliberately NOT part of board state: the board blob is
   re-sent on every save, so folding a growing log into it would balloon each
   write. Two kinds of row share the table:
     audit — a change to the data (who renamed/rescheduled/approved what)
     usage — a feature was used (which views and tools each role actually opens)
   Capped so it can never grow without bound on a free-tier database. */
const ACTIVITY_PATH = path.join(DATA_DIR, 'activity.json');
const ACTIVITY_CAP = 20000;

function makeFileActivity() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let rows = readJson(ACTIVITY_PATH, []);
  let dirty = false;
  // Batch disk writes: a burst of usage pings shouldn't mean a write each.
  setInterval(() => { if (dirty) { dirty = false; try { writeJson(ACTIVITY_PATH, rows); } catch (e) {} } }, 2000).unref();
  return {
    kind: 'json file',
    async init() {},
    async append(entries) {
      entries.forEach(e => rows.push(e));
      if (rows.length > ACTIVITY_CAP) rows = rows.slice(-ACTIVITY_CAP);
      dirty = true;
    },
    async query({ kind, role, dept, email, action, since, limit, offset }) {
      let out = rows;
      if (kind) out = out.filter(r => r.kind === kind);
      if (role) out = out.filter(r => r.role === role);
      if (dept) out = out.filter(r => r.dept === dept);
      if (email) out = out.filter(r => r.email === email);
      if (action) out = out.filter(r => r.action === action);
      if (since) out = out.filter(r => r.ts >= since);
      const total = out.length;
      out = out.slice().reverse().slice(offset || 0, (offset || 0) + (limit || 100));  // newest first
      return { total, rows: out };
    },
    async stats(since, prevSince, filt) {
      let src = prevSince ? rows.filter(r => r.ts >= prevSince) : rows;
      if (filt && filt.role) src = src.filter(r => r.role === filt.role);
      if (filt && filt.dept) src = src.filter(r => r.dept === filt.dept);
      return aggregate(src, since);
    }
  };
}

function makePgActivity(connectionString) {
  const pool = getPgPool(connectionString);
  return {
    kind: 'postgres',
    async init() {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS activity_log (' +
        'id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), ' +
        'email text, role text, kind text NOT NULL, action text NOT NULL, detail jsonb)'
      );
      // added after the first release — existing deployments migrate in place
      await pool.query('ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS dept text');
      await pool.query('CREATE INDEX IF NOT EXISTS activity_ts_idx ON activity_log (ts DESC)');
    },
    async append(entries) {
      for (const e of entries) {
        await pool.query(
          'INSERT INTO activity_log (ts, email, role, dept, kind, action, detail) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)',
          [e.ts, e.email, e.role, e.dept, e.kind, e.action, JSON.stringify(e.detail || {})]
        );
      }
      // trim to the cap — cheap, and only when we're plausibly over it
      await pool.query(
        'DELETE FROM activity_log WHERE id < (SELECT COALESCE(MAX(id),0) - $1 FROM activity_log)', [ACTIVITY_CAP]
      );
    },
    async query({ kind, role, dept, email, action, since, limit, offset }) {
      const w = [], p = [];
      const add = (sql, v) => { p.push(v); w.push(sql.replace('?', '$' + p.length)); };
      if (kind) add('kind = ?', kind);
      if (role) add('role = ?', role);
      if (dept) add('dept = ?', dept);
      if (email) add('email = ?', email);
      if (action) add('action = ?', action);
      if (since) add('ts >= ?', since);
      const where = w.length ? ' WHERE ' + w.join(' AND ') : '';
      const cnt = await pool.query('SELECT count(*)::int AS n FROM activity_log' + where, p);
      const r = await pool.query(
        'SELECT ts, email, role, dept, kind, action, detail FROM activity_log' + where +
        ' ORDER BY id DESC LIMIT $' + (p.length + 1) + ' OFFSET $' + (p.length + 2),
        p.concat([limit || 100, offset || 0])
      );
      return { total: cnt.rows[0].n, rows: r.rows.map(x => ({ ...x, ts: new Date(x.ts).toISOString() })) };
    },
    async stats(since, prevSince, filt) {
      const w = [], p = [];
      const add = (sql, v) => { p.push(v); w.push(sql.replace('?', '$' + p.length)); };
      if (prevSince) add('ts >= ?', prevSince);
      if (filt && filt.role) add('role = ?', filt.role);
      if (filt && filt.dept) add('dept = ?', filt.dept);
      const where = w.length ? ' WHERE ' + w.join(' AND ') : '';
      const r = await pool.query('SELECT ts, email, role, dept, kind, action, detail FROM activity_log' + where, p);
      return aggregate(r.rows.map(x => ({ ...x, ts: new Date(x.ts).toISOString() })), since);
    }
  };
}

/* Shared roll-up so both backends report identically.
   `rows` covers the current window PLUS an equal window before it, and `since`
   is the boundary — so every headline number ships with what it was last period
   and the page can talk in trends rather than totals. Series are bucketed by day
   (or by week once the range is long enough that daily points turn to noise). */
function aggregate(rows, since) {
  const mondayOf = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };

  const cur = since ? rows.filter(r => r.ts >= since) : rows;
  const prev = since ? rows.filter(r => r.ts < since) : [];

  /* Sessions are derived, not tracked: a browser can't be relied on to report
     when a session ended (tabs get closed, laptops sleep). Group one person's
     events in time order and split wherever they went quiet for 30 minutes —
     the standard idle-timeout definition. A lone event isn't a measurable
     session, so it's counted but contributes no duration. */
  const IDLE_MS = 30 * 60 * 1000;
  const sessionize = (src) => {
    const byUser = {};
    src.forEach(r => { if (r.email) (byUser[r.email] = byUser[r.email] || []).push(Date.parse(r.ts)); });
    let count = 0, totalMs = 0, measurable = 0;
    Object.values(byUser).forEach(times => {
      times.sort((a, b) => a - b);
      let start = times[0], last = times[0];
      const close = () => {
        count++;
        if (last > start) { totalMs += last - start; measurable++; }
      };
      for (let i = 1; i < times.length; i++) {
        if (times[i] - last > IDLE_MS) { close(); start = times[i]; }
        last = times[i];
      }
      close();
    });
    return { sessions: count, avgMs: measurable ? Math.round(totalMs / measurable) : 0 };
  };

  /* Friction, all derived from the flow.* / error events the client emits.
       abandonment — flows opened but closed without saving
       ttc         — how long the ones that DID complete took (median + p90)
       errors      — failures, as a rate against the attempts of the same flow */
  const frictionOf = (src) => {
    const flows = {}, errors = {};
    const F = (name) => (flows[name] = flows[name] || { started: 0, completed: 0, abandoned: 0, times: [] });
    src.forEach(r => {
      const flow = (r.detail && r.detail.flow) || null;
      if (r.action === 'flow.start' && flow) F(flow).started++;
      else if (r.action === 'flow.complete' && flow) {
        const f = F(flow); f.completed++;
        if (typeof (r.detail || {}).ms === 'number') f.times.push(r.detail.ms);
      } else if (r.action === 'flow.abandon' && flow) F(flow).abandoned++;
      else if (r.kind === 'error') {
        const e = errors[r.action] = errors[r.action] || { count: 0, flow: flow || null };
        e.count++;
      }
    });
    const pctl = (arr, p) => {
      if (!arr.length) return null;
      const a = arr.slice().sort((x, y) => x - y);
      return a[Math.min(a.length - 1, Math.floor(p * a.length))];
    };
    return {
      flows: Object.keys(flows).map(name => {
        const f = flows[name];
        const closed = f.completed + f.abandoned;
        return {
          flow: name, started: f.started, completed: f.completed, abandoned: f.abandoned,
          abandonRate: closed ? Math.round(f.abandoned / closed * 100) : 0,
          medianMs: pctl(f.times, 0.5), p90Ms: pctl(f.times, 0.9), samples: f.times.length
        };
      }).sort((a, b) => (b.completed + b.abandoned) - (a.completed + a.abandoned)),
      errors: Object.keys(errors).map(action => {
        // rate against the attempts of the flow the error belongs to, when known
        const f = errors[action].flow && flows[errors[action].flow];
        const attempts = f ? f.started : 0;
        return {
          action, count: errors[action].count, flow: errors[action].flow,
          attempts, rate: attempts ? Math.round(errors[action].count / attempts * 100) : null
        };
      }).sort((a, b) => b.count - a.count)
    };
  };

  const tally = (src) => {
    const byRole = {}, byAction = {}, byRoleAction = {}, byDept = {}, users = new Set();
    let usage = 0, audit = 0, errors = 0;
    src.forEach(r => {
      const role = r.role || 'unknown';
      if (r.kind === 'error') errors++; else if (r.kind === 'audit') audit++; else usage++;
      if (r.email) users.add(r.email);
      byRole[role] = (byRole[role] || 0) + 1;
      if (r.dept) byDept[r.dept] = (byDept[r.dept] || 0) + 1;
      byAction[r.action] = (byAction[r.action] || 0) + 1;
      byRoleAction[role] = byRoleAction[role] || {};
      byRoleAction[role][r.action] = (byRoleAction[role][r.action] || 0) + 1;
    });
    const sess = sessionize(src);
    return { total: src.length, usage, audit, errors, users: users.size,
             byRole, byAction, byRoleAction, byDept,
             sessions: sess.sessions, avgSessionMs: sess.avgMs };
  };

  const now = tally(cur), before = tally(prev);

  // --- time series over the current window ---
  const dayKeys = [...new Set(cur.map(r => r.ts.slice(0, 10)))].sort();
  const spanDays = dayKeys.length > 1
    ? Math.round((Date.parse(dayKeys[dayKeys.length - 1]) - Date.parse(dayKeys[0])) / 86400000) + 1
    : 1;
  const bucket = spanDays > 70 ? 'week' : 'day';
  const keyOf = (ts) => bucket === 'week' ? mondayOf(ts.slice(0, 10)) : ts.slice(0, 10);

  // a continuous axis — gaps are real information ("nobody used it that day")
  const buckets = [];
  if (dayKeys.length) {
    const step = bucket === 'week' ? 7 : 1;
    let c = new Date((bucket === 'week' ? mondayOf(dayKeys[0]) : dayKeys[0]) + 'T00:00:00Z');
    const last = keyOf(dayKeys[dayKeys.length - 1]);
    for (let i = 0; i < 400; i++) {
      const k = c.toISOString().slice(0, 10);
      buckets.push(k);
      if (k >= last) break;
      c.setUTCDate(c.getUTCDate() + step);
    }
  }
  const idx = {}; buckets.forEach((b, i) => { idx[b] = i; });
  const zeros = () => new Array(buckets.length).fill(0);

  const series = { total: zeros(), usage: zeros(), audit: zeros(), errors: zeros(), users: zeros(), byRole: {}, byAction: {} };
  const seenPerBucket = buckets.map(() => new Set());
  const dauPerBucket = buckets.map(() => ({}));      // bucket → role → Set(email)
  cur.forEach(r => {
    const i = idx[keyOf(r.ts)]; if (i === undefined) return;
    const role = r.role || 'unknown';
    series.total[i]++;
    if (r.kind === 'error') series.errors[i]++; else if (r.kind === 'audit') series.audit[i]++; else series.usage[i]++;
    if (r.email) {
      seenPerBucket[i].add(r.email);
      (dauPerBucket[i][role] = dauPerBucket[i][role] || new Set()).add(r.email);
    }
    (series.byRole[role] = series.byRole[role] || zeros())[i]++;
    (series.byAction[r.action] = series.byAction[r.action] || zeros())[i]++;
  });
  seenPerBucket.forEach((s, i) => { series.users[i] = s.size; });

  /* Daily Active Users, per role. DAU is a *daily* figure, so it's the mean of
     the active-day buckets rather than the window's distinct-user count — which
     would just grow with the range and stop being comparable. */
  const activeIdx = buckets.map((_, i) => i).filter(i => series.total[i] > 0);
  const dauByRole = {};
  Object.keys(now.byRole).forEach(role => {
    const perDay = activeIdx.map(i => (dauPerBucket[i][role] ? dauPerBucket[i][role].size : 0));
    const live = perDay.filter(n => n > 0);
    dauByRole[role] = live.length ? +(live.reduce((a, b) => a + b, 0) / live.length).toFixed(1) : 0;
  });
  const dau = activeIdx.length
    ? +(activeIdx.map(i => series.users[i]).reduce((a, b) => a + b, 0) / activeIdx.length).toFixed(1) : 0;

  // "Top feature leveraged" — the busiest *feature* (a usage event), not an audit
  // row, since audit rows record data changes rather than a tool being reached for.
  const featureCounts = {};
  cur.forEach(r => { if (r.kind === 'usage' && !r.action.startsWith('flow.')) featureCounts[r.action] = (featureCounts[r.action] || 0) + 1; });
  const featureRank = Object.keys(featureCounts).sort((a, b) => featureCounts[b] - featureCounts[a]);
  const featureTotal = Object.values(featureCounts).reduce((a, b) => a + b, 0);
  const topFeature = featureRank.length
    ? { action: featureRank[0], count: featureCounts[featureRank[0]],
        share: featureTotal ? Math.round(featureCounts[featureRank[0]] / featureTotal * 100) : 0 }
    : null;

  const prevFeature = {};
  prev.forEach(r => { if (r.kind === 'usage' && !r.action.startsWith('flow.')) prevFeature[r.action] = (prevFeature[r.action] || 0) + 1; });

  return {
    bucket, buckets, series,
    total: now.total, usage: now.usage, audit: now.audit, errors: now.errors, users: now.users,
    sessions: now.sessions, avgSessionMs: now.avgSessionMs,
    dau, dauByRole, topFeature, featureCounts,
    byRole: now.byRole, byAction: now.byAction, byRoleAction: now.byRoleAction, byDept: now.byDept,
    friction: frictionOf(cur),
    // the comparison window — absent when the caller asked for all time
    prev: since ? {
      total: before.total, usage: before.usage, audit: before.audit, errors: before.errors,
      users: before.users, sessions: before.sessions, avgSessionMs: before.avgSessionMs,
      byRole: before.byRole, byAction: before.byAction, featureCounts: prevFeature,
      // DAU on the same daily-mean basis as the current window, so the two are
      // directly comparable (a distinct-user count would scale with the range)
      ...(() => {
        const days = {}, allDays = {};
        prev.forEach(r => {
          if (!r.email) return;
          const d = r.ts.slice(0, 10), role = r.role || 'unknown';
          ((days[d] = days[d] || {})[role] = days[d][role] || new Set()).add(r.email);
          (allDays[d] = allDays[d] || new Set()).add(r.email);
        });
        const byRoleOut = {};
        Object.keys(before.byRole).forEach(role => {
          const per = Object.values(days).map(x => (x[role] ? x[role].size : 0)).filter(n => n > 0);
          byRoleOut[role] = per.length ? +(per.reduce((a, b) => a + b, 0) / per.length).toFixed(1) : 0;
        });
        const perDay = Object.values(allDays).map(s => s.size);
        return {
          dauByRole: byRoleOut,
          dau: perDay.length ? +(perDay.reduce((a, b) => a + b, 0) / perDay.length).toFixed(1) : 0
        };
      })(),
      friction: frictionOf(prev)
    } : null
  };
}

const activity = config.databaseUrl ? makePgActivity(config.databaseUrl) : makeFileActivity();

/* ------------------------------------------------ passwords (2 backends) --
   Deliberately NOT part of board state (data.people). GET /api/state ships
   the whole board to every signed-in browser verbatim — that's the entire
   sync mechanism — so a hash stored alongside a person's name and email would
   go out to every teammate's browser on every load. Hashed or not, that's an
   offline-crackable password list handed to anyone who opens dev tools. This
   store never rides that payload; it is read only by the two auth routes.

   scrypt, not bcrypt: Node's crypto ships it, so this stays dependency-free.
   N=16384 (2^14) is Node's own recommended minimum work factor. Format is
   "salt:hash", both hex, so a future rehash to stronger parameters can be
   read and verified as long as it exposes the same two hex fields. */
const PASSWORD_PATH = path.join(DATA_DIR, 'passwords.json');
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 64;

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return salt.toString('hex') + ':' + key.toString('hex');
}
// Constant-time compare of a hash that IS constant length, so no length or
// early-exit leakage — same discipline as codeMatches() above.
function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const want = Buffer.from(hashHex, 'hex');
  if (want.length !== SCRYPT_KEYLEN) return false;
  const got = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return crypto.timingSafeEqual(got, want);
}

function makeFilePasswords() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let rows = readJson(PASSWORD_PATH, {});   // { [lowercased email]: hash }
  return {
    kind: 'json file',
    async init() {},
    async get(email) { return rows[email.toLowerCase()] || null; },
    async set(email, hash) { rows[email.toLowerCase()] = hash; writeJson(PASSWORD_PATH, rows); },
    async clear(email) { delete rows[email.toLowerCase()]; writeJson(PASSWORD_PATH, rows); }
  };
}

function makePgPasswords(connectionString) {
  const pool = getPgPool(connectionString);
  return {
    kind: 'postgres',
    async init() {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS user_passwords (' +
        'email text PRIMARY KEY, hash text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())'
      );
    },
    async get(email) {
      const r = await pool.query('SELECT hash FROM user_passwords WHERE email = $1', [email.toLowerCase()]);
      return r.rows[0] ? r.rows[0].hash : null;
    },
    async set(email, hash) {
      await pool.query(
        'INSERT INTO user_passwords (email, hash, updated_at) VALUES ($1, $2, now()) ' +
        'ON CONFLICT (email) DO UPDATE SET hash = $2, updated_at = now()',
        [email.toLowerCase(), hash]
      );
    },
    async clear(email) { await pool.query('DELETE FROM user_passwords WHERE email = $1', [email.toLowerCase()]); }
  };
}

const passwords = config.databaseUrl ? makePgPasswords(config.databaseUrl) : makeFilePasswords();

/* Contextual task chat. Postgres only — there is no file backend, so chat is
   simply absent when the board runs on the JSON store (local preview). Shares
   the one pool rather than opening a second. Null here is a supported state,
   not a failure: the routes answer 503 with a reason. */
const chat = config.databaseUrl ? makePgChat(getPgPool(config.databaseUrl)) : null;

/* BYOK relay. Needs Postgres AND at least one MASTER_KEY_V*; null when either
   is absent, and the routes say which. A bad master key (wrong length, or
   MASTER_KEY_CURRENT naming one that doesn't exist) is a configuration error
   worth shouting about, but not worth taking the board down for — the tracker
   worked before this feature and must keep working without it. */
let vault = null;
if (config.databaseUrl) {
  try {
    vault = makeKeyVault(getPgPool(config.databaseUrl));
  } catch (e) {
    console.error('BYOK relay disabled — ' + e.message);
  }
}

/* Reference extraction — the interceptors from spec section 3, web side.

   The spec's regexes assume things this app doesn't have (numeric task ids for
   "#402"), so the task form here is the board's own names:

     #LA-101            an episode
     #LA-101/Blocking   a task in it (space works as well as the slash)

   LucidLink detection is the spec's regex verbatim. Cross-references are
   computed HERE, not trusted from the client — they end up as chips other
   people click, so what they point at has to be the server's own reading of
   the message. A mention that doesn't resolve to a real episode stays plain
   text: a chip that goes nowhere is worse than no chip. */
const LUCIDLINK_REGEX = /(lucid:\/\/|https:\/\/[\w-]+\.lucid\.link\/)[^\s]+/gi;
const EP_MENTION_REGEX = /#([A-Za-z]{1,6}(?:-|\s)?\d{1,5})\b/g;

function extractReferences(content, data) {
  const refs = [];
  const text = String(content || '');

  const lucid = text.match(LUCIDLINK_REGEX) || [];
  lucid.forEach(url => refs.push({ kind: 'lucidlink', url: url.replace(/[).,;]+$/, '') }));

  const normCode = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const episodes = (data && data.episodes) || [];
  let m;
  EP_MENTION_REGEX.lastIndex = 0;
  while ((m = EP_MENTION_REGEX.exec(text))) {
    const ep = episodes.find(e => normCode(e.code) === normCode(m[1]));
    if (!ep) continue;
    // a task name may follow — try the next two words, then one, so
    // "#LA-101/Final LRC" wins over a bare "#LA-101 Final ..." misread
    const after = text.slice(m.index + m[0].length).match(/^[\/\s]+([A-Za-z][\w-]*)(?:\s+([A-Za-z][\w-]*))?/);
    const pipe = (data.shows.find(s => s.id === ep.showId) || {}).pipeline || null;
    const tasks = pipe || [];   // seed shows: fall back to per-episode names below
    const names = new Map();
    (tasks.length ? tasks : []).forEach(t => names.set(t.key, String(t.name)));
    if (!names.size && ep.statuses) Object.keys(ep.statuses).forEach(k => names.set(k, k));
    const tryName = (phrase) => {
      if (!phrase) return null;
      const n = phrase.toLowerCase();
      const hits = [...names.entries()].filter(([k, nm]) =>
        nm.toLowerCase() === n || k === n || nm.toLowerCase().startsWith(n));
      return hits.length === 1 ? hits[0][0] : null;
    };
    let taskKey = null;
    if (after) taskKey = tryName(after[2] ? after[1] + ' ' + after[2] : null) || tryName(after[1]);
    refs.push(taskKey
      ? { kind: 'task', epId: ep.id, code: ep.code, taskKey, label: ep.code + ' / ' + (names.get(taskKey) || taskKey) }
      : { kind: 'episode', epId: ep.id, code: ep.code, label: ep.code });
  }
  return refs;
}

/* Notification fan-out — the spec's alert rules, applied server-side when a
   message lands. Two reasons someone is told, and only two:

     mention             their name follows an @ in the message
     assigned_task_chat  they own the task and somebody else wrote in it

   Everything else stays quiet. The unread counter is only worth looking at if
   it never lights up for things that aren't about you.

   Resolution runs through TWO directories on purpose. Assignees and @names are
   board people (string ids, in the board_state document); notifications need
   users (uuid rows). A board person with an email gets a users row created
   here on first mention — the same row they'd get by signing in, since email
   is the identity and upsertUser is case-insensitive. A person with no email
   has nobody to be: they're skipped, not guessed at.

   Mentions match the LONGEST name first ("@Alex Greenwood" must not resolve as
   a first-name "@Alex" plus stray text), and a first name shared by two people
   matches nobody — a wrong notification is worse than a missing one.

   Best-effort throughout: a fan-out failure must never fail the message that
   caused it. */
async function notifyForMessage(msg, episodeId, taskKey, authorUserId) {
  try {
    const board = await storage.get();
    const data = board && board.data;
    if (!data) return;
    const ep = (data.episodes || []).find(e => e.id === episodeId);
    const people = data.people || [];

    // candidate names → person, longest first, ambiguous first names dropped
    const byName = new Map();
    for (const p of people) {
      const full = String(p.name || '').toLowerCase().trim();
      if (!full) continue;
      byName.set(full, byName.has(full) ? null : p);
      const first = full.split(/\s+/)[0];
      if (first && first !== full) byName.set(first, byName.has(first) ? null : p);
    }
    const names = Array.from(byName.keys()).sort((a, b) => b.length - a.length);

    const mentioned = new Map();   // person.id → person
    let rest = String(msg.content || '').toLowerCase();
    for (const n of names) {
      const p = byName.get(n);
      if (!p) continue;                                  // ambiguous
      const hit = rest.indexOf('@' + n);
      if (hit < 0) continue;
      const after = rest[hit + 1 + n.length];
      if (after && /[a-z0-9]/.test(after)) continue;     // "@alexa" is not "@alex"
      mentioned.set(p.id, p);
      // blank the match so "@alex greenwood" can't ALSO match "@alex"
      rest = rest.slice(0, hit) + ' '.repeat(n.length + 1) + rest.slice(hit + 1 + n.length);
    }

    // person → users row, creating one when there's an email to hang it on
    const resolve = async (person) => {
      if (!person) return null;
      const linked = await chat.findUsersByBoardPersonIds([person.id]);
      if (linked.length) return linked[0];
      if (!person.email) return null;
      return chat.upsertUser({ email: person.email, fullName: person.name, boardPersonId: person.id });
    };

    const fanOut = async (userIds, type) => {
      const ids = userIds.filter(id => id && id !== authorUserId);   // never notify yourself
      if (!ids.length) return;
      await chat.notify({ userIds: ids, messageId: msg.id, episodeId, taskKey, type });
      /* The event carries recipients so each client can tell whether it's for
         them. Everyone signed in can see it — but new_message already
         broadcasts the full content to the same audience, so this reveals
         nothing the stream didn't. */
      sseEmit('notification', { taskId: episodeId + '::' + taskKey, messageId: msg.id, type, userIds: ids });
    };

    const mentionUsers = [];
    for (const p of mentioned.values()) {
      const u = await resolve(p);
      if (u) mentionUsers.push(u.id);
    }
    await fanOut(mentionUsers, 'mention');

    const assigneeId = ep && ep.assignees && ep.assignees[taskKey];
    if (assigneeId) {
      const u = await resolve(people.find(p => p.id === assigneeId));
      if (u) await fanOut([u.id], 'assigned_task_chat');
    }
  } catch (e) {
    console.error('[chat] notification fan-out failed:', e.message);
  }
}

/* Slack bridge — 2-way sync on Bolt's own receiver, second port. Null until
   SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET exist (IT approval pending), and the
   app runs exactly as today without it. */
const slack = makeSlackBridge({
  chat, storage, sseEmit,
  appUrl: ENV.APP_URL || null
});

/* Server-side audit. The client tracker (js/track.js) can't be trusted to
   record something it never sees — a relay call spends the user's money, so
   the record of it is written here, from the session, not from the browser.
   Best-effort: a logging failure must never fail the request it describes. */
function auditServer(session, action, detail) {
  Promise.resolve()
    .then(() => activity.append([{
      ts: new Date().toISOString(),
      email: (session && session.email) || null,
      role: null, dept: null,
      kind: 'audit', action, detail: detail || {}
    }]))
    .catch(() => {});
}

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

/* Chat realtime rides the SSE stream that already exists rather than adding a
   second transport. The spec asks for Socket.io; this delivers the same three
   events (new_message, notification_cleared, reference_pinned) over the
   channel every client is already connected to — see the note in
   migrations/002. Named events, so a client subscribes to what it wants.

   No per-task rooms: SSE has no concept of them, so every listener receives
   every event and filters on taskId. Fine at this board's scale; if chat ever
   gets loud enough for that to matter, that is the moment to reconsider the
   transport rather than now. */
function sseEmit(event, payload) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n';
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

/* --------------------------------------------------- task workspace ------ */
/* Backs the per-subtask workspace (Project / Assets / Deliver) so nobody has to
   open Finder. Upload destinations are handed out as short-lived tokens: the
   client never names a filesystem path, so path authority stays server-side even
   though delivering isn't an admin-only action. */
const deliverTokens = new Map();   // token -> { dir, exp }
function issueDeliverToken(dir) {
  const t = crypto.randomBytes(18).toString('base64url');
  for (const [k, v] of deliverTokens) if (v.exp < Date.now()) deliverTokens.delete(k);
  deliverTokens.set(t, { dir, exp: Date.now() + 3600000 });   // an hour to finish uploading
  return t;
}
function redeemDeliverToken(t) {
  const rec = deliverTokens.get(t);
  if (!rec || rec.exp < Date.now()) { deliverTokens.delete(t); return null; }
  return rec.dir;
}

// Native "Open" only makes sense when the server shares a machine with the user.
// Their setup is a local server per Mac against the LucidLink mount, so this is
// the normal case; a remote/shared server falls back to showing the path.
function isLocalRequest(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function openNatively(target) {
  const { spawn } = require('child_process');
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  // no shell: the path is passed as a single argv entry, so spaces and quotes
  // in show or episode names can't turn into shell syntax
  const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
  child.on('error', e => console.error('[open] ' + e.message));
  child.unref();
}

// The master directory + the show/episode/pipeline a workspace request refers to,
// or an { error } describing what's missing.
async function resolveTaskContext(body) {
  const { data } = await storage.get();
  if (!data) return { error: 'no board state yet' };
  const masterPath = ENV.MASTER_PATH || (data.storage && data.storage.masterPath) || '';
  if (!masterPath) return { error: 'No master directory set — an admin can set one in Admin → Workflow → Storage' };
  if (!path.isAbsolute(masterPath)) return { error: 'Master directory must be an absolute path' };
  if (!fs.existsSync(masterPath)) return { error: 'Master directory not found — is LucidLink mounted?' };

  const ep = (data.episodes || []).find(e => e.id === body.epId);
  if (!ep) return { error: 'unknown episode' };
  const show = (data.shows || []).find(s => s.id === ep.showId);
  if (!show) return { error: 'unknown show' };
  let pipeline;
  try { pipeline = folders.normalisePipeline(show.pipeline || body.pipeline); }
  catch (e) { return { error: e.message }; }
  const paths = folders.taskPaths(ep, pipeline, body.taskKey);
  if (!paths) return { error: 'that task is not in this show’s pipeline' };
  return { data, masterPath, show, ep, pipeline, paths };
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
        needsCode: !!config.accessCode,
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
      // Without Google SSO this endpoint is the only gate, so it enforces both
      // the shared team code and the allowed domain — otherwise anyone who
      // finds the URL could sign in as an admin.
      if (config.accessCode && !codeMatches(body.code)) {
        return sendJson(res, 403, { error: 'Wrong access code' });
      }
      if (!emailAllowed(email)) {
        return sendJson(res, 403, { error: 'Only @' + config.allowedDomain + ' accounts can sign in' });
      }
      const name = email.split('@')[0].split(/[._-]/).map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
      res.setHeader('Set-Cookie', sessionCookie(createSession({ email, name, picture: '', via: 'dev' }), { secure: isSecure(req) }));
      return sendJson(res, 200, { ok: true });
    }

    /* Real credentialed sign-in — works whether devLogin/accessCode are on or
       off, unlike /auth/dev, because the password itself is the gate: an
       admin chose to grant this specific person a way in, the same act as
       adding them to the People directory in the first place. No domain
       check either, for the same reason bootstrap admins in adminEmails may
       sit outside allowedDomain — a password an admin set is authorization,
       independent of what domain the address happens to be on. */
    if (route === 'POST /auth/password') {
      const body = JSON.parse(await readBody(req) || '{}');
      const email = String(body.email || '').trim().toLowerCase();
      const pw = String(body.password || '');
      if (!email || !pw) return sendJson(res, 400, { error: 'Enter your email and password' });
      const hash = await passwords.get(email);
      // Same "invalid email or password" either way — confirming an address
      // has no password set is a small enumeration leak otherwise.
      if (!hash || !verifyPassword(pw, hash)) {
        return sendJson(res, 401, { error: 'Incorrect email or password' });
      }
      const name = email.split('@')[0].split(/[._-]/).map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
      res.setHeader('Set-Cookie', sessionCookie(createSession({ email, name, picture: '', via: 'password' }), { secure: isSecure(req) }));
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

      /* ---- passwords ----
         Two different rights, deliberately not merged into one route: an
         admin sets ANYONE's password without knowing the old one (the same
         authority that adds someone to the People directory); a signed-in
         user changes their OWN and must prove they still hold it. Neither
         touches data.people or storage — see the note where `passwords` is
         defined for why a hash can never ride the board sync. */
      if (route === 'POST /api/admin/password') {
        const s = getSession(req);
        if (!config.adminEmails.map(e => e.toLowerCase()).includes(s.email)) {
          return sendJson(res, 403, { error: 'Only admins can set another user’s password' });
        }
        const body = JSON.parse(await readBody(req) || '{}');
        const email = String(body.email || '').trim().toLowerCase();
        const pw = String(body.password || '');
        if (!/^\S+@\S+\.\S+$/.test(email)) return sendJson(res, 400, { error: 'That’s not a valid email' });
        if (pw.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
        await passwords.set(email, hashPassword(pw));
        auditServer(s, 'account.passwordSet', { target: email });
        return sendJson(res, 200, { ok: true });
      }
      if (route === 'DELETE /api/admin/password') {
        const s = getSession(req);
        if (!config.adminEmails.map(e => e.toLowerCase()).includes(s.email)) {
          return sendJson(res, 403, { error: 'Only admins can remove a password' });
        }
        const body = JSON.parse(await readBody(req) || '{}');
        const email = String(body.email || '').trim().toLowerCase();
        if (!email) return sendJson(res, 400, { error: 'Missing email' });
        await passwords.clear(email);
        auditServer(s, 'account.passwordCleared', { target: email });
        return sendJson(res, 200, { ok: true });
      }
      if (route === 'POST /api/account/password') {
        const s = getSession(req);
        const body = JSON.parse(await readBody(req) || '{}');
        const current = String(body.currentPassword || '');
        const next = String(body.newPassword || '');
        if (next.length < 8) return sendJson(res, 400, { error: 'New password must be at least 8 characters' });
        const hash = await passwords.get(s.email);
        if (!hash) {
          return sendJson(res, 409, { error: 'You don’t have a password set yet — ask an admin to set one first' });
        }
        if (!verifyPassword(current, hash)) {
          return sendJson(res, 403, { error: 'Current password is incorrect' });
        }
        await passwords.set(s.email, hashPassword(next));
        auditServer(s, 'account.passwordChanged', {});
        return sendJson(res, 200, { ok: true });
      }

      /* ---- contextual task chat -------------------------------------------
         Spec section 4. Every other route here is an exact string match; these
         are the first with a path parameter, hence the regex.

         :taskId is `episodeId::taskKey` — the identity the rest of the app
         already uses (js/uploads.js, js/workspace.js). There is no tasks table
         to hand out uuids, so this is the stable name a task actually has. */
      const taskChat = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(messages|revisions|references)$/);
      if (taskChat) {
        if (!chat) {
          return sendJson(res, 503, {
            error: 'Chat needs Postgres. This server is running on the JSON file store — set DATABASE_URL to enable it.'
          });
        }
        const parsed = parseTaskId(decodeURIComponent(taskChat[1]));
        if (!parsed) {
          return sendJson(res, 400, { error: 'taskId must be "<episodeId>::<taskKey>", e.g. cn6bimwnrc::layout' });
        }
        const { episodeId, taskKey } = parsed;
        const s = getSession(req);
        // the users table fills itself from whoever signs in, which is also
        // what keeps author_id pointing at a real row
        const me = await chat.upsertUser({ email: s.email, fullName: s.name || '' });

        if (route.startsWith('GET') && taskChat[2] === 'messages') {
          const limit = parseInt(url.searchParams.get('limit') || '100', 10);
          const before = url.searchParams.get('before') || null;
          const [messages, current, references] = await Promise.all([
            chat.listThread({ episodeId, taskKey, limit, before }),
            chat.currentRevision({ episodeId, taskKey }),
            chat.listReferences({ episodeId, taskKey })
          ]);
          // dividers are messages with a revision_id and is_system_event, so the
          // client renders one continuous stream — no separate merge step
          return sendJson(res, 200, { taskId: episodeId + '::' + taskKey, messages, currentRevision: current, references });
        }

        /* Pinned references — the durable list, separate from the messages
           that produced it. Removal is open to anyone signed in: it's a
           pinboard, and an out-of-date pin hurts everyone who trusts it. */
        if (route.startsWith('GET') && taskChat[2] === 'references') {
          return sendJson(res, 200, { references: await chat.listReferences({ episodeId, taskKey }) });
        }
        if (route.startsWith('DELETE') && taskChat[2] === 'references') {
          const id = url.searchParams.get('id');
          if (!id) return sendJson(res, 400, { error: 'id is required' });
          const gone = await chat.removeReference(id);
          if (gone) sseEmit('reference_pinned', { taskId: episodeId + '::' + taskKey, removed: id });
          return sendJson(res, 200, { ok: true, removed: gone });
        }

        if (route.startsWith('POST') && taskChat[2] === 'messages') {
          const body = JSON.parse(await readBody(req) || '{}');
          if (!body.content || !String(body.content).trim()) {
            return sendJson(res, 400, { error: 'content is required' });
          }
          // cross-references are computed here, never taken from the client —
          // they become chips other people click
          const board = await storage.get();
          const refs = extractReferences(body.content, board && board.data);
          let msg;
          try {
            msg = await chat.postMessage({
              episodeId, taskKey, authorId: me.id, content: String(body.content),
              crossReferences: refs
            });
          } catch (e) {
            return sendJson(res, 400, { error: e.message });
          }
          /* A LucidLink URL in a message is also PINNED — the spec's
             interceptor, minus the Slack ephemeral prompt it can't have yet.
             The pin outlives the message scrollback, which is its point. */
          for (const r of refs) {
            if (r.kind !== 'lucidlink') continue;
            try {
              const pin = await chat.addReference({
                episodeId, taskKey, messageId: msg.id, url: r.url,
                displayName: r.url.split('/').filter(Boolean).pop() || r.url,
                createdByUserId: me.id
              });
              sseEmit('reference_pinned', { taskId: episodeId + '::' + taskKey, reference: pin });
            } catch (e) { console.error('[chat] pin failed:', e.message); }
          }
          sseEmit('new_message', { taskId: episodeId + '::' + taskKey, message: msg });
          // fire-and-forget: the message is saved either way, and the sender
          // shouldn't wait on other people's alerts
          notifyForMessage(msg, episodeId, taskKey, me.id);
          if (slack) slack.mirrorMessage(episodeId, taskKey, msg);
          return sendJson(res, 201, { message: msg });
        }

        if (route.startsWith('POST') && taskChat[2] === 'revisions') {
          const body = JSON.parse(await readBody(req) || '{}');
          const { revision, divider } = await chat.startRevision({
            episodeId, taskKey, label: body.label || null, createdByUserId: me.id
          });
          sseEmit('new_message', { taskId: episodeId + '::' + taskKey, message: divider });
          if (slack) slack.mirrorMessage(episodeId, taskKey, divider);
          return sendJson(res, 201, { revision, divider });
        }

        return sendJson(res, 405, { error: 'Method not allowed' });
      }

      /* ---- BYOK: the user's own Gemini key, and the relay that spends it ---
         The key is theirs, so the bill is theirs. Every guard here — the
         format check, the verify-before-store, the per-minute bucket, the
         daily ceiling — exists because the thing being protected is somebody
         else's money rather than ours. */
      if (url.pathname === '/api/save-key' || url.pathname === '/api/key' || url.pathname === '/api/call-gemini') {
        if (!vault) {
          return sendJson(res, 503, {
            error: !config.databaseUrl
              ? 'The key relay needs Postgres. This server is running on the JSON file store — set DATABASE_URL.'
              : 'The key relay needs a master key. Set MASTER_KEY_V1 (openssl rand -base64 32) and MASTER_KEY_CURRENT=1.'
          });
        }
        const s = getSession(req);
        const me = await chat.upsertUser({ email: s.email, fullName: s.name || '' });

        if (route === 'POST /api/save-key') {
          const body = JSON.parse(await readBody(req) || '{}');
          const apiKey = String(body.apiKey || '').trim();
          if (!vault.validFormat(apiKey)) {
            return sendJson(res, 400, { error: 'That does not look like a Google AI Studio API key (expected AIza…, 39 characters).' });
          }
          const why = await vault.verifyWithGoogle(apiKey);
          if (why) return sendJson(res, 400, { error: why });
          const saved = await vault.saveKey(me.id, apiKey);
          // the key itself is never logged, echoed, or written anywhere but
          // the encrypted column
          auditServer(s, 'byok.keySaved', { provider: 'gemini', keyHint: saved.keyHint });
          return sendJson(res, 200, { ok: true, provider: 'gemini', keyHint: saved.keyHint });
        }

        if (route === 'GET /api/key') return sendJson(res, 200, await vault.status(me.id));

        if (route === 'DELETE /api/key') {
          const gone = await vault.deleteKey(me.id);
          if (gone) auditServer(s, 'byok.keyRemoved', { provider: 'gemini' });
          return sendJson(res, 200, { ok: true, removed: gone });
        }

        if (route === 'POST /api/call-gemini') {
          const body = JSON.parse(await readBody(req) || '{}');
          const r = await vault.callGemini(me.id, String(body.prompt || ''));
          if (r.retryAfter) res.setHeader('Retry-After', String(r.retryAfter));
          if (!r.ok) {
            // status and reason only — an upstream error body can echo the request
            console.error('[byok] call failed', r.status, r.upstreamStatus || '', r.googleStatus || '');
            return sendJson(res, r.status, { error: r.error });
          }
          auditServer(s, 'byok.call', {
            model: r.model, usedToday: r.usedToday, dailyLimit: r.dailyLimit,
            promptTokens: r.usage && r.usage.promptTokenCount,
            outputTokens: r.usage && r.usage.candidatesTokenCount
          });
          return sendJson(res, 200, {
            text: r.text, model: r.model, finishReason: r.finishReason,
            usage: r.usage, usedToday: r.usedToday, dailyLimit: r.dailyLimit
          });
        }

        return sendJson(res, 405, { error: 'Method not allowed' });
      }

      /* ---- Slack channel mappings (Admin → Shows) --------------------------
         Which channel a show (optionally one department of it) posts into.
         Admin-only: pointing a show's chatter at a Slack channel is a
         visibility decision, the same class as backups. */
      if (url.pathname === '/api/slack/channels') {
        if (!chat) return sendJson(res, 503, { error: 'Needs Postgres — set DATABASE_URL.' });
        const s = getSession(req);
        if (!config.adminEmails.map(e => e.toLowerCase()).includes(s.email)) {
          return sendJson(res, 403, { error: 'Only admins can manage Slack channels' });
        }
        if (route === 'GET /api/slack/channels') {
          return sendJson(res, 200, { mappings: await chat.listChannels(), bridge: !!slack });
        }
        if (route === 'POST /api/slack/channels') {
          const body = JSON.parse(await readBody(req) || '{}');
          const channelId = String(body.slackChannelId || '').trim();
          // Slack channel ids look like C0123ABCD — catching a pasted #name
          // here beats a silent post failure later
          if (!/^[CG][A-Z0-9]{6,}$/i.test(channelId)) {
            return sendJson(res, 400, { error: 'That doesn’t look like a channel ID (C…). In Slack: channel → ⋯ → Copy channel ID.' });
          }
          const row = await chat.setChannel({
            showId: String(body.showId || ''), deptKey: body.deptKey || null, slackChannelId: channelId.toUpperCase()
          });
          return sendJson(res, 200, { mapping: row });
        }
        if (route === 'DELETE /api/slack/channels') {
          const id = url.searchParams.get('id');
          if (!id) return sendJson(res, 400, { error: 'id is required' });
          return sendJson(res, 200, { ok: true, removed: await chat.removeChannel(id) });
        }
        return sendJson(res, 405, { error: 'Method not allowed' });
      }

      /* Unread count and clearing, used by the notification bell. */
      if (route === 'GET /api/notifications') {
        if (!chat) return sendJson(res, 200, { unread: [], count: 0, disabled: true });
        const s = getSession(req);
        const me = await chat.upsertUser({ email: s.email, fullName: s.name || '' });
        const unread = await chat.listUnread(me.id);
        // userId rides along so the client can recognise itself in broadcast
        // notification events — with an empty bell there's no row to learn it from
        return sendJson(res, 200, { unread, count: unread.length, userId: me.id });
      }

      if (route === 'POST /api/notifications/read') {
        if (!chat) return sendJson(res, 503, { error: 'Chat needs Postgres.' });
        const s = getSession(req);
        const me = await chat.upsertUser({ email: s.email, fullName: s.name || '' });
        const body = JSON.parse(await readBody(req) || '{}');
        let cleared = 0;
        if (Array.isArray(body.ids) && body.ids.length) {
          cleared = await chat.markRead(me.id, body.ids);
        } else if (body.taskId) {
          const p = parseTaskId(String(body.taskId));
          if (!p) return sendJson(res, 400, { error: 'bad taskId' });
          cleared = await chat.markThreadRead(me.id, p);
          // only broadcast a clear that cleared something — every client
          // refetches on this event, and most thread-opens have nothing unread
          if (cleared > 0) sseEmit('notification_cleared', { taskId: body.taskId, userId: me.id });
        }
        return sendJson(res, 200, { cleared });
      }

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

      /* Directory browser behind the Storage setting's "Browse…" button.
         A browser folder picker can't hand us an absolute path (by design), and
         it's this process — not the laptop — that needs to see the LucidLink
         mount, so the listing happens here. Admin-only, directories only, and it
         grants nothing an admin didn't already have: they can type any path into
         the same setting. */
      if (route === 'GET /api/browse') {
        const s = getSession(req);
        // Admins browse anywhere (they're choosing the master directory). Everyone
        // else may browse only to pick a file to deliver — hence files=1, which
        // any signed-in user can call so they never need Finder.
        const wantFiles = url.searchParams.get('files') === '1';
        if (!wantFiles && !config.adminEmails.map(e => e.toLowerCase()).includes(s.email)) {
          return sendJson(res, 403, { error: 'Only admins can browse the server filesystem' });
        }
        const roots = [
          { label: 'Volumes', path: '/Volumes' },
          { label: os.userInfo().username, path: os.homedir() },
          { label: 'Root', path: '/' }
        ].filter(r => { try { return fs.statSync(r.path).isDirectory(); } catch (e) { return false; } });

        const listing = (d) => {
          const st = fs.statSync(d);
          if (!st.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
          return fs.readdirSync(d, { withFileTypes: true });
        };

        const asked = url.searchParams.get('path') || (roots[0] && roots[0].path) || '/';
        let dir = path.resolve(asked), entries, notice = null;
        try {
          entries = listing(dir);
        } catch (e) {
          // Never dead-end the picker: fall back to a known-good root so the user
          // can always navigate out of a bad saved path.
          const why = e.code === 'EACCES' ? 'No permission to read' : 'Can’t open';
          const fb = roots.find(r => { try { listing(r.path); return true; } catch (err) { return false; } });
          if (!fb) return sendJson(res, 400, { error: why + ' ' + dir, roots });
          notice = why + ' ' + asked + ' — showing ' + fb.path + ' instead.';
          dir = fb.path;
          entries = listing(dir);
        }
        const dirs = entries
          .filter(e => !e.name.startsWith('.'))
          .filter(e => { try { return e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(dir, e.name)).isDirectory()); } catch (err) { return false; } })
          .map(e => e.name)
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        const parent = path.dirname(dir);
        // files=1 additionally returns the files, so "pick from the mount" can
        // choose one to deliver without ever opening Finder
        const files = wantFiles ? entries
          .filter(e => !e.name.startsWith('.') && !dirs.includes(e.name))
          .map(e => { let size = 0; try { size = fs.statSync(path.join(dir, e.name)).size; } catch (err) {} return { name: e.name, size }; })
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : undefined;
        return sendJson(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs, files, roots, notice });
      }

      /* ---- per-subtask workspace ----------------------------------------
         One read that returns everything the Edit Task panel shows: the task's
         own folders and project files, plus each dependency's published assets
         (or nothing, which the UI shows as Pending). POST because it needs the
         pipeline in the body — seed shows don't carry one in stored state. */
      if (route === 'POST /api/task/workspace') {
        const body = JSON.parse(await readBody(req) || '{}');
        const ctx = await resolveTaskContext(body);
        if (ctx.error) return sendJson(res, 400, { error: ctx.error });
        const { data, masterPath, show, ep, pipeline, paths } = ctx;

        const rel = (p) => folders.resolveIn(masterPath, show, p);
        const task = pipeline.find(t => t.key === body.taskKey);

        // project files = what's sitting in the task's working folder
        const workAbs = rel(paths.work);
        const work = folders.listDir(workAbs);

        // Studio-wide templates plus anything this show overrides. Plain notes
        // (a README explaining the folder) are excluded — nobody should be able
        // to start a project from readme.txt.
        const templates = folders.templatesFor(masterPath, show);

        // dependency assets — the heart of the Assets panel
        const deps = (task.deps || []).map(depKey => {
          const dt = pipeline.find(t => t.key === depKey);
          if (!dt) return null;
          const dp = folders.taskPaths(ep, pipeline, depKey);
          const items = dp ? folders.listDir(rel(dp.publish)) : [];
          return {
            key: depKey, name: dt.name, dept: dt.dept,
            status: (ep.statuses && ep.statuses[depKey]) || 'not_started',
            publish: dp ? dp.publish : null,
            // An earlier iteration of the SAME deliverable (Animatic V2 → V3,
            // Layout → Blocking) shares this task's folder, so it isn't an
            // incoming handoff — the UI lists it as a version, not an asset.
            sameFolder: !!dp && dp.publish === paths.publish,
            items: items.map(i => ({ name: i.name, dir: i.dir, size: i.size, path: i.path }))
          };
        }).filter(Boolean);

        return sendJson(res, 200, {
          ok: true,
          local: isLocalRequest(req),
          root: folders.resolveIn(masterPath, show, ''),
          deliverable: paths.deliverable,
          paths: { work: paths.work, mezzanine: paths.mezzanine, publish: paths.publish },
          absolute: { work: workAbs, mezzanine: rel(paths.mezzanine), publish: rel(paths.publish) },
          work: work.map(i => ({ name: i.name, dir: i.dir, size: i.size, mtime: i.mtime })),
          // delivered but awaiting approval
          mezzanine: folders.listDir(rel(paths.mezzanine)).map(i => ({ name: i.name, dir: i.dir, size: i.size })),
          publish: folders.listDir(rel(paths.publish)).map(i => ({ name: i.name, dir: i.dir, size: i.size })),
          templates, deps
        });
      }

      /* Create Project — makes the working folder and, if a template was chosen,
         copies it in under a versioned name. Never overwrites. */
      if (route === 'POST /api/task/project') {
        const body = JSON.parse(await readBody(req) || '{}');
        const ctx = await resolveTaskContext(body);
        if (ctx.error) return sendJson(res, 400, { error: ctx.error });
        const { masterPath, show, ep, paths } = ctx;
        const workAbs = folders.resolveIn(masterPath, show, paths.work);
        fs.mkdirSync(workAbs, { recursive: true });

        let created = null;
        if (body.template) {
          // templateSource says which library it came from: the studio-wide one,
          // or this show's own override folder
          const src = folders.templatePath(masterPath, show, body.template, body.templateSource);
          if (!fs.existsSync(src)) {
            return sendJson(res, 400, { error: 'template not found: ' + body.template });
          }
          // <EPCODE>_<Deliverable>_v001.<ext> — e.g. LA-101_Animatic_v001.aep
          const ext = path.extname(src);
          const base = folders.episodeFolder(ep).split('_')[0] + '_' + paths.deliverable + '_v001' + ext;
          const dest = folders.uniquePath(workAbs, folders.safeFile(base));
          // a Logic .logicx (and friends) is a package directory, so copy recursively
          fs.cpSync(src, dest, { recursive: fs.statSync(src).isDirectory() });
          created = path.basename(dest);
        }
        const willOpen = body.open !== false && isLocalRequest(req);
        if (willOpen) openNatively(created ? path.join(workAbs, created) : workAbs);
        return sendJson(res, 200, { ok: true, created, dir: workAbs, opened: willOpen });
      }

      /* Open — hands the file or folder to the OS when the server is on this
         machine (their normal setup); otherwise returns the path to copy. */
      if (route === 'POST /api/task/open') {
        const body = JSON.parse(await readBody(req) || '{}');
        const ctx = await resolveTaskContext(body);
        if (ctx.error) return sendJson(res, 400, { error: ctx.error });
        const { masterPath, show, paths } = ctx;
        const which = body.which === 'publish' ? paths.publish
          : body.which === 'mezzanine' ? paths.mezzanine
          : paths.work;
        const target = folders.resolveIn(masterPath, show,
          body.name ? which + '/' + folders.safeFile(body.name) : which);
        if (!fs.existsSync(target)) return sendJson(res, 404, { error: 'not there yet: ' + path.basename(target) });
        if (!isLocalRequest(req)) return sendJson(res, 200, { ok: true, opened: false, path: target });
        openNatively(target);
        return sendJson(res, 200, { ok: true, opened: true, path: target });
      }

      /* Promote a task's delivered files from Mezzanine to Publish. Called when a
         task reaches Approved, which is the moment its output becomes a usable
         asset for everything downstream. Idempotent: re-running moves whatever is
         still sitting in Mezzanine and reports honestly. */
      if (route === 'POST /api/task/promote') {
        const body = JSON.parse(await readBody(req) || '{}');
        const ctx = await resolveTaskContext(body);
        if (ctx.error) return sendJson(res, 400, { error: ctx.error });
        const { masterPath, show, paths } = ctx;
        const mezz = folders.resolveIn(masterPath, show, paths.mezzanine);
        const pub = folders.resolveIn(masterPath, show, paths.publish);
        if (!fs.existsSync(mezz)) return sendJson(res, 200, { ok: true, promoted: 0 });

        const items = folders.listDir(mezz);
        if (!items.length) return sendJson(res, 200, { ok: true, promoted: 0 });
        fs.mkdirSync(pub, { recursive: true });

        const promoted = [];
        for (const it of items) {
          const dest = folders.uniquePath(pub, folders.safeFile(it.name));
          try {
            fs.renameSync(it.path, dest);
          } catch (e) {
            if (e.code !== 'EXDEV') throw e;
            fs.cpSync(it.path, dest, { recursive: it.dir });
            fs.rmSync(it.path, { recursive: it.dir, force: true });
          }
          promoted.push(path.basename(dest));
        }
        console.log('[promote] ' + getSession(req).email + ' ' + paths.deliverable +
          ': ' + promoted.length + ' → Publish');
        return sendJson(res, 200, { ok: true, promoted: promoted.length, names: promoted, dir: pub });
      }

      /* Hand a URL to the OS so it opens in the real default browser (Create
         Project → Google Docs/Sheets template gallery). Deliberately narrow: only
         https, and only hosts we ship links for, so this can't become a general
         "make the server launch anything" endpoint. */
      if (route === 'POST /api/open-url') {
        const body = JSON.parse(await readBody(req) || '{}');
        let u;
        try { u = new URL(String(body.url || '')); } catch (e) { return sendJson(res, 400, { error: 'not a URL' }); }
        const ALLOWED = ['docs.google.com', 'drive.google.com', 'sheets.google.com'];
        if (u.protocol !== 'https:' || !ALLOWED.includes(u.hostname)) {
          return sendJson(res, 400, { error: 'that host isn’t allowed: ' + u.hostname });
        }
        if (!isLocalRequest(req)) return sendJson(res, 200, { ok: true, opened: false, url: u.href });
        openNatively(u.href);
        return sendJson(res, 200, { ok: true, opened: true, url: u.href });
      }

      /* Deliver, step 1: create the destination and hand back an upload token,
         so the browser never gets to name a path. Also used by "pick from the
         volume", which relocates a file already on the mount. */
      if (route === 'POST /api/task/deliver/prepare') {
        const body = JSON.parse(await readBody(req) || '{}');
        const ctx = await resolveTaskContext(body);
        if (ctx.error) return sendJson(res, 400, { error: ctx.error });
        const { masterPath, show, paths } = ctx;
        // Deliveries go to Mezzanine, NOT Publish — they only become assets for
        // downstream tasks once this task is approved (see /api/task/promote).
        const destAbs = folders.resolveIn(masterPath, show, paths.mezzanine);
        fs.mkdirSync(destAbs, { recursive: true });      // lazily created on first delivery

        if (body.src) {
          const src = path.resolve(String(body.src));
          if (!fs.existsSync(src)) return sendJson(res, 400, { error: 'source not found' });
          const st = fs.statSync(src);
          /* Already in the delivery folder? Do nothing. Comparing src to dest
             can't catch this — uniquePath has by then renamed dest to _2, so the
             move would "succeed" and leave a pointless duplicate. */
          if (path.dirname(path.resolve(src)) === path.resolve(destAbs)) {
            return sendJson(res, 400, { error: path.basename(src) + ' is already delivered' });
          }
          const dest = folders.uniquePath(destAbs, folders.safeFile(path.basename(src)));

          /* Delivering MOVES the export out of the working folder, so there's one
             copy of the master rather than a duplicate to keep in sync. The two
             reference libraries are the exception: those are shared source
             material, and emptying them to deliver would be data loss, so files
             taken from there are copied instead. */
          const isLibrary = /(^|\/)(!!_Templates|!!_ShowLibrary)\//.test(src + '/');
          let moved = false;
          try {
            if (isLibrary) {
              fs.cpSync(src, dest, { recursive: st.isDirectory() });
            } else {
              try {
                fs.renameSync(src, dest);            // same volume: instant, even for a 40GB master
                moved = true;
              } catch (e) {
                if (e.code !== 'EXDEV') throw e;      // different filesystem — fall back to copy+remove
                fs.cpSync(src, dest, { recursive: st.isDirectory() });
                fs.rmSync(src, { recursive: st.isDirectory(), force: true });
                moved = true;
              }
            }
          } catch (e) {
            return sendJson(res, 400, { error: (moved ? 'move' : 'copy') + ' failed: ' + e.message });
          }
          console.log('[deliver] ' + getSession(req).email + ' ' + (moved ? 'moved' : 'copied') + ' ' + src + ' → ' + dest);
          return sendJson(res, 200, {
            ok: true, filed: path.basename(dest), dir: destAbs,
            size: st.size, dirEntry: st.isDirectory(), moved, fromLibrary: isLibrary
          });
        }
        return sendJson(res, 200, { ok: true, token: issueDeliverToken(destAbs), dir: destAbs });
      }

      /* Deliver, step 2: stream the body straight to disk under the token's
         directory. One request per file — no multipart parsing, and large media
         never buffers in memory. */
      if (route === 'POST /api/task/deliver/upload') {
        const dir = redeemDeliverToken(url.searchParams.get('token') || '');
        if (!dir) return sendJson(res, 400, { error: 'upload window expired — press Deliver again' });
        const name = folders.safeFile(url.searchParams.get('filename') || 'untitled');
        const dest = folders.uniquePath(dir, name);
        try {
          await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(dest);
            req.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
            req.on('error', reject);
          });
        } catch (e) {
          try { fs.unlinkSync(dest); } catch (err) {}   // don't leave a half file behind
          return sendJson(res, 500, { error: 'write failed: ' + e.message });
        }
        console.log('[deliver] ' + getSession(req).email + ' uploaded → ' + dest);
        return sendJson(res, 200, { ok: true, filed: path.basename(dest), size: fs.statSync(dest).size });
      }

      /* Production folders on the LucidLink master directory. Admin-only, and
         the show/episode NAMES come from stored state rather than the request,
         so a client can only ever address content it can already see. */
      if (route === 'POST /api/folders') {
        const s = getSession(req);
        if (!config.adminEmails.map(e => e.toLowerCase()).includes(s.email)) {
          return sendJson(res, 403, { error: 'Only admins can create production folders' });
        }
        const body = JSON.parse(await readBody(req) || '{}');
        const { data } = await storage.get();
        if (!data) return sendJson(res, 400, { error: 'no board state yet' });

        const masterPath = ENV.MASTER_PATH || (data.storage && data.storage.masterPath) || '';
        if (!masterPath) return sendJson(res, 400, { error: 'No master directory set — add one in Admin → Workflow → Storage' });
        // A relative path would resolve against the server's working directory and
        // quietly build the tree inside the app folder. Demand an absolute one.
        if (!path.isAbsolute(masterPath)) {
          return sendJson(res, 400, { error: 'Master directory must be an absolute path starting with “/” — use Browse… to pick it.\nGot: ' + masterPath });
        }
        if (!fs.existsSync(masterPath)) return sendJson(res, 400, { error: 'Master directory not found — is LucidLink mounted?\n' + masterPath });

        const show = (data.shows || []).find(x => x.id === body.showId);
        if (!show) return sendJson(res, 404, { error: 'unknown show' });

        try {
          // The studio-wide template library sits beside the shows, so make sure
          // it exists — it's shared, and creating any show is a fine moment to
          // guarantee it's there.
          fs.mkdirSync(folders.resolveMaster(masterPath, folders.MASTER_TEMPLATES), { recursive: true });

          // Whole show, once, at creation: shared folders + every episode's tree.
          const pipeline = folders.normalisePipeline(show.pipeline || body.pipeline);
          const showEps = (data.episodes || []).filter(e => e.showId === show.id);
          let dirs = folders.showSkeleton(show);
          showEps.forEach(ep => { dirs = dirs.concat(folders.episodeTree(ep, pipeline)); });

          const result = folders.createDirs(masterPath, show, dirs);
          console.log('[folders] ' + s.email + ' → ' + result.root + ' (' + showEps.length + ' episode' +
            (showEps.length === 1 ? '' : 's') + ', +' + result.created.length + ' new, ' + result.existed.length + ' existing)');
          return sendJson(res, 200, {
            ok: true, label: show.name, root: result.root, episodes: showEps.length,
            created: result.created.length, existed: result.existed.length
          });
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
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

      /* ---- board backups ----
         Admin-only throughout: a backup is the whole board, and restoring one
         overwrites everyone's work. Snapshots are taken from stored state here
         rather than from a posted body, so what gets kept is always what the
         server actually holds. */
      if (route.startsWith('GET /api/backups') || route.startsWith('POST /api/backups') ||
          route.startsWith('DELETE /api/backups')) {
        const s = getSession(req);
        if (!config.adminEmails.map(e => e.toLowerCase()).includes(s.email)) {
          return sendJson(res, 403, { error: 'Only admins can manage board backups' });
        }

        if (route === 'GET /api/backups') {
          return sendJson(res, 200, { cap: BACKUP_CAP, backups: await backups.list() });
        }

        if (route === 'POST /api/backups') {
          const body = JSON.parse(await readBody(req) || '{}');
          const cur = await storage.get();
          if (!cur.data) return sendJson(res, 400, { error: 'There’s no board to back up yet' });
          const row = await backups.create({
            label: String(body.label || '').slice(0, 120) || null,
            email: s.email, version: cur.version, data: cur.data
          });
          return sendJson(res, 200, row);
        }

        /* Restoring is itself a destructive write, so the board as it stands is
           snapshotted first — that auto-backup is the way out of a restore that
           turned out to be the wrong one. The board's version keeps counting up
           (it isn't rewound), so every open tab sees a change and re-pulls. */
        if (route === 'POST /api/backups/restore') {
          const body = JSON.parse(await readBody(req) || '{}');
          const row = await backups.get(String(body.id || ''));
          if (!row) return sendJson(res, 404, { error: 'That backup no longer exists' });
          const cur = await storage.get();
          if (cur.data) {
            await backups.create({
              label: 'Before restoring ' + new Date(row.ts).toISOString().slice(0, 16).replace('T', ' '),
              email: s.email, version: cur.version, data: cur.data
            });
          }
          const result = await storage.put(cur.version, row.data);
          if (!result.ok) return sendJson(res, 409, result.current);
          broadcastVersion(result.version);
          return sendJson(res, 200, { version: result.version, restored: row.id });
        }

        if (route === 'DELETE /api/backups') {
          const ok = await backups.remove(String(url.searchParams.get('id') || ''));
          return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'That backup no longer exists' });
        }
      }

      /* ---- activity log ---- */
      // Anyone signed in may append (that's how their own usage is recorded),
      // but the identity and timestamp come from the session and the clock here
      // — never from the client, so a row can't be forged onto someone else.
      if (route === 'POST /api/activity') {
        const s = getSession(req);
        const body = JSON.parse(await readBody(req) || '{}');
        const list = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
        if (!list.length) return sendJson(res, 200, { ok: true, stored: 0 });
        const now = new Date().toISOString();
        const entries = list
          .filter(e => e && typeof e.action === 'string')
          .map(e => ({
            ts: now,
            email: s.email,
            role: typeof e.role === 'string' ? e.role.slice(0, 40) : null,
            dept: typeof e.dept === 'string' ? e.dept.slice(0, 40) : null,
            kind: e.kind === 'audit' ? 'audit' : e.kind === 'error' ? 'error' : 'usage',
            action: e.action.slice(0, 80),
            detail: e.detail && typeof e.detail === 'object' ? e.detail : {}
          }));
        await activity.append(entries);
        return sendJson(res, 200, { ok: true, stored: entries.length });
      }

      // Reading the log is an admin matter — it names who did what.
      if (route === 'GET /api/activity' || route === 'GET /api/activity/stats') {
        const s = getSession(req);
        if (!config.adminEmails.map(e => e.toLowerCase()).includes(s.email)) {
          return sendJson(res, 403, { error: 'Only admins can read the activity log' });
        }
        const q = url.searchParams;
        // `hours` carries the 24h horizon; `days` the longer ones. One window
        // length in ms drives both the range and its comparison period.
        const hours = parseFloat(q.get('hours') || '0');
        const days = parseInt(q.get('days') || '0', 10);
        const winMs = hours > 0 ? hours * 3600000 : days > 0 ? days * 86400000 : 0;
        const since = winMs ? new Date(Date.now() - winMs).toISOString() : null;
        const filt = { role: q.get('role') || null, dept: q.get('dept') || null };
        if (route === 'GET /api/activity/stats') {
          // pull an equal window before `since` too, so every figure has a
          // previous-period counterpart to trend against
          const prevSince = winMs ? new Date(Date.now() - winMs * 2).toISOString() : null;
          return sendJson(res, 200, await activity.stats(since, prevSince, filt));
        }
        return sendJson(res, 200, await activity.query({
          kind: q.get('kind') || null,
          role: filt.role,
          dept: filt.dept,
          email: q.get('email') || null,
          action: q.get('action') || null,
          since,
          limit: Math.min(parseInt(q.get('limit') || '100', 10) || 100, 500),
          offset: parseInt(q.get('offset') || '0', 10) || 0
        }));
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
  // the log is a nice-to-have: a failure here must never stop the tracker
  try { await activity.init(); }
  catch (e) { console.error('Activity log init failed (logging disabled):', e.message); }
  // likewise backups — the board must still serve if the table can't be made
  try { await backups.init(); }
  catch (e) { console.error('Backup store init failed (backups disabled):', e.message); }
  // and passwords — Google/dev sign-in must still work if this table can't be made
  try { await passwords.init(); }
  catch (e) { console.error('Password store init failed (password sign-in disabled):', e.message); }
  // chat is Postgres-only and equally optional: the tracker predates it and
  // must still serve without it
  if (chat) {
    try { await chat.init(); }
    catch (e) { console.error('Chat store init failed (chat disabled):', e.message); }
  }
  // Slack rides its own listener so Bolt can verify raw request signatures
  if (slack) {
    const slackPort = Number(ENV.SLACK_PORT || Number(PORT) + 1);
    try {
      await slack.start(slackPort);
      console.log('  • Slack bridge:  listening on :' + slackPort + ' (POST /slack/events)');
    } catch (e) { console.error('Slack bridge failed to start:', e.message); }
  }

  server.listen(PORT, config.host, () => {
    const nets = os.networkInterfaces();
    const lan = Object.values(nets).flat().find(n => n && n.family === 'IPv4' && !n.internal);
    console.log('Post Pipeline server running:');
    console.log('  • This host:    http://localhost:' + PORT + '/');
    if (config.host !== '127.0.0.1' && lan) console.log('  • Team (LAN):   http://' + lan.address + ':' + PORT + '/');
    console.log('  • Storage:      ' + storage.kind);
    console.log('  • Google SSO:   ' + (googleConfigured() ? 'configured ✓' : 'not configured — dev sign-in active'));
    console.log('  • Email sign-in: ' + (!config.devLogin ? 'off'
      : config.accessCode ? 'on, access code required' : 'on, NO ACCESS CODE'));
    if (config.devLogin && !config.accessCode && storage.kind === 'postgres') {
      console.log('  ⚠ SECURITY: email sign-in is open on a hosted deploy — anyone with the URL');
      console.log('    can sign in as any ' + (config.allowedDomain || 'valid') + ' address, including an admin.');
      console.log('    Set ACCESS_CODE (shared team code), or DEV_LOGIN=false once Google SSO works.');
    }
  });
})();
