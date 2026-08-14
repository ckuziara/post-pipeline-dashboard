/* Server sync layer (Phase 2-3). Talks to the Node backend in server.js:
   session check, shared-state pull/push with optimistic versioning, a live
   Server-Sent-Events feed for instant cross-tab/cross-user updates, and a
   slow poll as a fallback in case the SSE connection can't be held open.
   If no server responds (double-clicked index.html), the app silently stays
   in the old localStorage-only mode. */
window.App = window.App || {};
(function () {
  'use strict';

  App.api = {
    online: false,       // a backend answered /api/me
    me: null,            // {email,name,picture,admin} when signed in
    version: 0,          // server state version we're based on
    _pushTimer: null,
    _pollTimer: null,
    _pushing: false,
    _es: null,

    async boot() {
      try {
        const r = await fetch('/api/me', { cache: 'no-store' });
        this.online = true;
        const body = await r.json();
        if (r.ok) this.me = body;
        else this.loginOpts = body;      // {devLogin, googleConfigured}
      } catch (e) {
        this.online = false;             // file:// or server down → offline mode
      }
      return this.me;
    },

    async pull() {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (!r.ok) return null;
      const s = await r.json();
      this.version = s.version;
      return s.data;                     // null on a fresh server
    },

    // Debounced save. On a version conflict (someone else saved first) we
    // adopt the server's copy — with 5s polling that's a rare race.
    push() {
      if (!this.online || !this.me) return;
      clearTimeout(this._pushTimer);
      this._pushTimer = setTimeout(() => this._doPush(), 400);
    },

    /* Send any pending save NOW and wait for it to land. Needed before asking
       the server to act on state we just changed locally (e.g. creating a new
       show's folders) — otherwise the debounce means the server hasn't seen the
       show yet and would answer "unknown show". */
    async flush() {
      if (!this.online || !this.me) return;
      clearTimeout(this._pushTimer);
      this._pushTimer = null;
      await this._doPush();
      // _doPush re-queues itself if a push was already in flight; wait that out
      // so callers can rely on the server being current when this resolves.
      while (this._pushing || this._pushTimer) {
        clearTimeout(this._pushTimer);
        this._pushTimer = null;
        await new Promise(r => setTimeout(r, 60));
        if (!this._pushing) await this._doPush();
      }
    },

    async _doPush() {
      this._pushTimer = null;   // the scheduled push is now in flight, not pending
      if (this._pushing) { this.push(); return; }
      this._pushing = true;
      try {
        const r = await fetch('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: this.version, data: App.state.data })
        });
        if (r.status === 409) {
          const s = await r.json();
          this.version = s.version;
          App.state.data = App.migrate(s.data);
          App.render();
          App.toast('Updated by a teammate — board refreshed', true);
        } else if (r.ok) {
          this.version = (await r.json()).version;
        }
      } catch (e) { /* transient network error; next mutation retries */ }
      this._pushing = false;
    },

    // Shared guard: never clobber unsent edits, and never re-render mid-typing
    // in the journal — used by both the SSE push and the fallback poll.
    async _adoptVersion(v) {
      if (this._pushTimer || this._pushing || document.hidden) return;
      const ae = document.activeElement;
      if (ae && ae.classList && (ae.classList.contains('jr-block') || ae.classList.contains('pn-note-input'))) return;
      if (v <= this.version) return;
      const data = await this.pull();
      if (data) { App.state.data = App.migrate(data); App.render(); }
    },

    // Instant path: a teammate's save broadcasts the new version over SSE.
    // EventSource reconnects on its own if the stream drops.
    connectLive() {
      if (!window.EventSource || this._es) return;
      const es = new EventSource('/api/events');
      es.addEventListener('version', e => {
        this._adoptVersion(Number(e.data)).catch(() => {});
      });
      /* Chat rides the same stream rather than a second transport. SSE has no
         rooms, so every client hears every message and the panel filters on
         taskId — see the note in server.js. Parsed defensively: a malformed
         frame must not kill the listener for the rest of the session. */
      es.addEventListener('new_message', e => {
        try { App.chat && App.chat.onLive(JSON.parse(e.data)); } catch (err) {}
      });
      es.addEventListener('notification_cleared', e => {
        try { App.chat && App.chat.onCleared(JSON.parse(e.data)); } catch (err) {}
      });
      es.addEventListener('notification', e => {
        try { App.chat && App.chat.onNotify(JSON.parse(e.data)); } catch (err) {}
      });
      this._es = es;
    },

    // Fallback safety net in case SSE can't be held open (e.g. a proxy that
    // buffers streaming responses) — slow, since the live feed does the work.
    startPolling() {
      this.connectLive();
      clearInterval(this._pollTimer);
      this._pollTimer = setInterval(async () => {
        if (this._pushTimer || this._pushing || document.hidden) return;
        try {
          const r = await fetch('/api/version', { cache: 'no-store' });
          if (!r.ok) return;
          const v = (await r.json()).version;
          await this._adoptVersion(v);
        } catch (e) { /* server briefly unreachable */ }
      }, 15000);
    },

    /* List a directory on the machine running the server — the folder picker's
       backing call. A browser picker can't return an absolute path, and it's the
       server that has to see the LucidLink mount. */
    async browse(dirPath, withFiles) {
      const q = [];
      if (dirPath) q.push('path=' + encodeURIComponent(dirPath));
      if (withFiles) q.push('files=1');
      const r = await fetch('/api/browse' + (q.length ? '?' + q.join('&') : ''), { cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'could not open that folder');
      return body;
    },

    /* ---- board backups (Admin → Shows; admin-only) ----
       Snapshots live in the database, so there's no payload to send: the
       server copies whatever it currently holds. */
    async backups() {
      const r = await fetch('/api/backups', { cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'could not read the backups');
      return body;
    },
    async backupNow(label) {
      const r = await fetch('/api/backups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label || '' })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'could not take a backup');
      return body;
    },
    async restoreBackup(id) {
      const r = await fetch('/api/backups/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'could not restore that backup');
      // the board underneath us is now a different one — adopt it wholesale
      this.version = body.version;
      const data = await this.pull();
      if (data) { App.state.data = App.migrate(data); App.history.clear(); App.render(); }
      return body;
    },
    async deleteBackup(id) {
      const r = await fetch('/api/backups?id=' + encodeURIComponent(id), { method: 'DELETE' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'could not delete that backup');
      return body;
    },

    /* ---- activity log (Admin → Audit & Event Logs; admin-only to read) ---- */
    async activity(params) {
      const q = new URLSearchParams();
      Object.keys(params || {}).forEach(k => { if (params[k] !== '' && params[k] != null) q.set(k, params[k]); });
      const r = await fetch('/api/activity?' + q, { cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'could not read the activity log');
      return body;
    },
    // `q` is the segment: { days | hours, role, dept }. A bare number is still
    // accepted so older callers keep working.
    async activityStats(q) {
      const params = (typeof q === 'object' && q) ? q : { days: q };
      const usp = new URLSearchParams();
      Object.keys(params).forEach(k => { if (params[k] !== '' && params[k] != null) usp.set(k, params[k]); });
      const r = await fetch('/api/activity/stats?' + usp, { cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'could not read usage statistics');
      return body;
    },

    /* ---- contextual task chat ----
       Postgres-only on the server, so every call here can legitimately come
       back 503 on a file-store deploy. `chatUnavailable` is carried on the
       thrown error so the UI can say "not configured" rather than "failed". */
    async _chat(method, path, body) {
      const r = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store'
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = new Error(out.error || 'request failed');
        e.status = r.status;
        e.chatUnavailable = r.status === 503;
        throw e;
      }
      return out;
    },

    chatThread(taskId) {
      return this._chat('GET', '/api/tasks/' + encodeURIComponent(taskId) + '/messages');
    },
    chatSend(taskId, content, crossReferences) {
      return this._chat('POST', '/api/tasks/' + encodeURIComponent(taskId) + '/messages',
        { content, crossReferences: crossReferences || [] });
    },
    chatStartRevision(taskId, label) {
      return this._chat('POST', '/api/tasks/' + encodeURIComponent(taskId) + '/revisions',
        { label: label || null });
    },
    notifications() { return this._chat('GET', '/api/notifications'); },
    markNotificationsRead(body) { return this._chat('POST', '/api/notifications/read', body || {}); },

    /* ---- per-subtask workspace (Project / Assets / Deliver) ----
       All of these POST because the server needs the pipeline to resolve a task's
       folder, and seed shows don't carry one in stored state. */
    async _post(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || 'request failed');
      return out;
    },

    taskWorkspace(b) { return this._post('/api/task/workspace', b); },
    taskProject(b)   { return this._post('/api/task/project', b); },
    taskOpen(b)      { return this._post('/api/task/open', b); },
    deliverPrepare(b) { return this._post('/api/task/deliver/prepare', b); },
    // moves a task's delivered files from Mezzanine to Publish, on approval
    taskPromote(b) { return this._post('/api/task/promote', b); },
    // opens in the OS default browser when the server is on this machine
    openUrl(url) { return this._post('/api/open-url', { url }); },

    /* Streams one file straight to the token's folder. Kept as a raw body (not
       multipart) so multi-GB media never buffers in memory on either side. */
    async deliverUpload(token, file) {
      const q = '?token=' + encodeURIComponent(token) + '&filename=' + encodeURIComponent(file.name);
      const r = await fetch('/api/task/deliver/upload' + q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || 'upload failed');
      return out;
    },

    /* Build a show's whole production structure on the LucidLink master directory
       — shared folders plus every episode. The server generates every path itself
       from stored state; we only name the show. */
    async createFolders({ showId, pipeline }) {
      const r = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId, pipeline })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'could not create folders');
      return body;
    },

    async devLogin(email, code) {
      const r = await fetch('/auth/dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code })
      });
      if (!r.ok) throw new Error((await r.json()).error || 'sign-in failed');
      location.href = location.pathname;   // reboot signed in (drops ?err=…)
    },

    async logout() {
      await fetch('/auth/logout', { method: 'POST' });
      location.href = location.pathname;
    }
  };
})();
