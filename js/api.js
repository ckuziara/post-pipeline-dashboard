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
          App.state.data = s.data;
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
      if (data) { App.state.data = data; App.render(); }
    },

    // Instant path: a teammate's save broadcasts the new version over SSE.
    // EventSource reconnects on its own if the stream drops.
    connectLive() {
      if (!window.EventSource || this._es) return;
      const es = new EventSource('/api/events');
      es.addEventListener('version', e => {
        this._adoptVersion(Number(e.data)).catch(() => {});
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
