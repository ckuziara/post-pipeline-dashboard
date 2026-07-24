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

    async devLogin(email) {
      const r = await fetch('/auth/dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
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
