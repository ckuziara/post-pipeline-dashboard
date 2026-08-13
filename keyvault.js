/* BYOK — per-user provider API keys, and the relay that spends them.

   Users bring their own Gemini key; the server encrypts it, stores only
   ciphertext, and calls Google on their behalf. The key is theirs, so the
   billing is theirs, and every guard here exists because the thing being
   protected is somebody else's money.

   ── THE KEY NEVER REACHES POSTGRES ────────────────────────────────────────
   Encryption is AES-256-GCM in this process. pgcrypto would mean passing the
   master key into SQL as a query parameter, where it lands in statement logs,
   pg_stat_statements and the parameters of any failed query — handing the one
   secret to the same system holding everything it protects.

   ── ROTATION IS BUILT IN, NOT BOLTED ON ───────────────────────────────────
   Rows record which master key encrypted them. Add MASTER_KEY_V2, set
   MASTER_KEY_CURRENT=2, and old rows keep decrypting under v1 while new writes
   use v2. A master key you cannot rotate is one nobody ever rotates. */
'use strict';

const crypto = require('crypto');

const IV_BYTES = 12;                 // GCM standard
const PROVIDER = 'gemini';
const MODEL = 'gemini-2.5-flash';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';
const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_PROMPT_CHARS = 32_000;
const CALL_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 10_000;
const DAILY_LIMIT = 200;             // per user, per day — a cost ceiling, not a quota
const BURST = 20;                    // per-minute token bucket
const REFILL_PER_MS = 20 / 60_000;
// Google keys are AIza + 35 chars. Catching a truncated paste here turns a
// confusing 403 three screens later into an immediate, accurate message.
const KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/;

/* ---- master keys ------------------------------------------------------- */
function loadKeys() {
  const keys = new Map();
  for (const [name, val] of Object.entries(process.env)) {
    const m = name.match(/^MASTER_KEY_V(\d+)$/);
    if (!m || !val) continue;
    const raw = Buffer.from(val, 'base64');
    if (raw.length !== 32) {
      throw new Error(name + ' must be 32 bytes base64 (got ' + raw.length +
        ') — regenerate with: openssl rand -base64 32');
    }
    keys.set(Number(m[1]), raw);
  }
  return keys;
}

/* The user id and provider are bound in as Additional Authenticated Data, so a
   ciphertext copied from one user's row to another fails to decrypt instead of
   handing the attacker a working key. */
const aad = (userId) => Buffer.from(String(userId) + ':' + PROVIDER, 'utf8');

/* ---- rate limiting ------------------------------------------------------
   Per-minute burst is in memory, so the budget is per Render instance. The
   daily ceiling lives on the key row instead, because that one has to survive
   a restart — a leak drains a quota slowly, and slowly is exactly when a
   process gets redeployed. */
const buckets = new Map();
function takeToken(userId) {
  const now = Date.now();
  const b = buckets.get(userId) || { tokens: BURST, ts: now };
  b.tokens = Math.min(BURST, b.tokens + (now - b.ts) * REFILL_PER_MS);
  b.ts = now;
  if (b.tokens < 1) { buckets.set(userId, b); return false; }
  b.tokens -= 1;
  buckets.set(userId, b);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of buckets) if (v.ts < cutoff) buckets.delete(k);
}, 60_000).unref();

/* ------------------------------------------------------------------------ */
function makeKeyVault(pool) {
  const keys = loadKeys();
  const current = Number(process.env.MASTER_KEY_CURRENT || 1);
  const q = (t, p) => pool.query(t, p);
  const one = (r) => r.rows[0] || null;

  if (!keys.size) return null;                       // not configured — caller answers 503
  if (!keys.has(current)) {
    throw new Error('MASTER_KEY_CURRENT=' + current + ' has no matching MASTER_KEY_V' + current + '.');
  }

  function encrypt(plaintext, userId) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(current), iv);
    cipher.setAAD(aad(userId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: current };
  }

  function decrypt(row, userId) {
    const key = keys.get(row.key_version);
    if (!key) throw new Error('Row encrypted with key version ' + row.key_version + ', which is not configured.');
    const d = crypto.createDecipheriv('aes-256-gcm', key, row.iv);
    d.setAAD(aad(userId));
    d.setAuthTag(row.auth_tag);                      // throws on tamper — the point of GCM
    return Buffer.concat([d.update(row.ciphertext), d.final()]).toString('utf8');
  }

  return {
    kind: 'postgres',
    keyVersions: Array.from(keys.keys()).sort(),
    currentVersion: current,

    /* Ask Google whether the key works before storing it, so a typo fails at
       the settings screen rather than mid-conversation. Returns a reason
       string on failure, null on success. */
    async verifyWithGoogle(apiKey) {
      let r;
      try {
        r = await fetch(MODELS_URL, {
          headers: { 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
        });
      } catch (e) {
        return 'Could not reach Google to verify the key. Try again shortly.';
      }
      if (r.status === 400 || r.status === 403) {
        return 'Google rejected that key. Check it was copied in full and the Generative Language API is enabled.';
      }
      if (!r.ok) return 'Could not reach Google to verify the key. Try again shortly.';
      return null;
    },

    validFormat: (apiKey) => KEY_RE.test(String(apiKey || '').trim()),

    async saveKey(userId, apiKey) {
      const { ciphertext, iv, authTag, keyVersion } = encrypt(apiKey, userId);
      const hint = apiKey.slice(-4);
      await q(
        `insert into user_api_keys
           (user_id, provider, ciphertext, iv, auth_tag, key_version, key_hint)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (user_id, provider) do update set
           ciphertext  = excluded.ciphertext,
           iv          = excluded.iv,
           auth_tag    = excluded.auth_tag,
           key_version = excluded.key_version,
           key_hint    = excluded.key_hint,
           calls_day   = null,
           calls_count = 0`,
        [userId, PROVIDER, ciphertext, iv, authTag, keyVersion, hint]);
      return { keyHint: hint, keyVersion };
    },

    // never returns the key itself — only whether there is one, and its tail
    async status(userId) {
      const r = one(await q(
        `select key_hint, key_version, created_at, updated_at, last_used_at,
                case when calls_day = current_date then calls_count else 0 end as used_today
           from user_api_keys where user_id = $1 and provider = $2`,
        [userId, PROVIDER]));
      return r ? { connected: true, dailyLimit: DAILY_LIMIT, ...r } : { connected: false };
    },

    async deleteKey(userId) {
      return (await q('delete from user_api_keys where user_id = $1 and provider = $2',
        [userId, PROVIDER])).rowCount > 0;
    },

    /* Counts the call and returns the running total in one statement, so two
       concurrent requests can't both read "199" and both proceed. The date
       rolls lazily — no cron, no reset job. */
    async countCall(userId) {
      const r = one(await q(
        `update user_api_keys
            set calls_day   = current_date,
                calls_count = case when calls_day = current_date then calls_count + 1 else 1 end,
                last_used_at = now()
          where user_id = $1 and provider = $2
          returning calls_count`,
        [userId, PROVIDER]));
      return r ? r.calls_count : 0;
    },

    /* The relay. Returns { ok, status, ...} rather than throwing, because
       every failure here needs a specific message the user can act on. */
    async callGemini(userId, prompt) {
      if (!prompt || !String(prompt).trim()) return { ok: false, status: 400, error: 'A prompt is required.' };
      if (prompt.length > MAX_PROMPT_CHARS) {
        return { ok: false, status: 413, error: 'Prompt too long (' + prompt.length + ' chars, limit ' + MAX_PROMPT_CHARS + ').' };
      }
      if (!takeToken(userId)) {
        return { ok: false, status: 429, retryAfter: 60, error: 'Too many requests. Try again shortly.' };
      }

      /* Key and today's usage in one read. The ceiling is CHECKED here and
         COUNTED only after Google actually answers — an earlier version
         incremented up front, which meant a decryption failure or a timeout
         burned the user's allowance for a call that never reached Google and
         cost them nothing. Two concurrent requests can therefore both pass a
         check at the boundary; the per-minute bucket bounds that overshoot,
         and erring toward the user is the right way round for a limit that
         exists to protect their bill. */
      const row = one(await q(
        `select ciphertext, iv, auth_tag, key_version,
                case when calls_day = current_date then calls_count else 0 end as used_today
           from user_api_keys where user_id = $1 and provider = $2`, [userId, PROVIDER]));
      if (!row) return { ok: false, status: 412, error: 'No Gemini key connected. Add one in settings first.' };

      if (row.used_today >= DAILY_LIMIT) {
        return { ok: false, status: 429, error: 'Daily limit reached (' + DAILY_LIMIT + ' calls). It resets at midnight UTC.' };
      }

      let apiKey;
      try {
        apiKey = decrypt(row, userId);
      } catch (e) {
        // tampered row, or a master key that has gone away — never the user's fault
        return { ok: false, status: 500, error: 'Stored key could not be read. Please re-connect your key.', detail: e.message };
      }

      let upstream, payload;
      try {
        upstream = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: {
            // Header auth, NOT ?key= — a key in the query string ends up in
            // access logs, proxy logs and error messages.
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
          }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
        });
        payload = await upstream.json();
      } catch (e) {
        const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
        return { ok: false, status: 504, error: timedOut ? 'Gemini timed out.' : 'Could not reach Gemini.' };
      } finally {
        apiKey = null;
      }

      if (!upstream.ok) {
        const map = {
          400: { status: 502, error: 'Gemini rejected the request.' },
          403: { status: 403, error: 'Your Gemini key was rejected. Re-connect it in settings.' },
          429: { status: 429, error: 'Your Gemini quota is exhausted. Check your Google AI Studio limits.' }
        };
        const m = map[upstream.status] || { status: 502, error: 'Gemini returned an error.' };
        return { ok: false, upstreamStatus: upstream.status, googleStatus: payload && payload.error && payload.error.status, ...m };
      }

      const blocked = payload && payload.promptFeedback && payload.promptFeedback.blockReason;
      if (blocked) return { ok: false, status: 422, error: 'Prompt blocked by Gemini safety filters (' + blocked + ').' };

      const cand = payload && payload.candidates && payload.candidates[0];
      const text = (cand && cand.content && cand.content.parts || [])
        .map(p => p.text).filter(Boolean).join('');
      if (!text) return { ok: false, status: 502, error: 'Gemini returned an empty response.' };

      // Google answered and billed them, so now it counts.
      const usedToday = await this.countCall(userId);
      return {
        ok: true, status: 200, text, model: MODEL,
        finishReason: (cand && cand.finishReason) || null,
        usage: payload.usageMetadata || null,
        usedToday, dailyLimit: DAILY_LIMIT
      };
    }
  };
}

module.exports = { makeKeyVault, PROVIDER, MODEL, DAILY_LIMIT, MAX_PROMPT_CHARS };
