/* Activity tracking — feeds Admin → Audit & Event Logs.

   Two kinds of event:
     audit — a change to the data ("renamed a task", "approved a subtask").
             The record of what happened, for project auditing.
     usage — a feature was opened or used ("timeline view", "add show dialog").
             Answers which parts of the tool each role actually reaches for.

   Events are buffered and flushed in batches so a busy minute costs one request,
   and tracking never blocks or breaks the action it's recording — every failure
   path here is a silent no-op. The server stamps identity and time; `role` is
   sent from here because the board role is a client-side concept the server
   doesn't model. It's analytics, not a security boundary. */
window.App = window.App || {};
(function () {
  'use strict';

  const FLUSH_MS = 4000, MAX_BUFFER = 50;
  const TICK_MS = 15000, IDLE_MS = 2 * 60 * 1000, TIME_SEND_MS = 30 * 60 * 1000;
  let buffer = [], timer = null, sending = false;

  function post(events, useBeacon) {
    const body = JSON.stringify({ events });
    // On page hide, fetch() is often killed mid-flight — sendBeacon survives it.
    if (useBeacon && navigator.sendBeacon) {
      try { navigator.sendBeacon('/api/activity', new Blob([body], { type: 'application/json' })); return; } catch (e) { /* fall through */ }
    }
    fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
      .catch(() => { /* logging is best-effort — never surface a failure */ });
  }

  App.track = {
    // A page can only log against a signed-in session, and only when the
    // backend is actually there (file:// / offline demo mode logs nothing).
    _on() { return !!(App.api && App.api.online && App.api.me); },

    push(kind, action, detail) {
      if (!this._on()) return;
      if (kind === 'audit' && App.state && App.state.sandbox) return;   // the tour's edits never happened
      const role = App.state && App.state.role;
      buffer.push({
        kind, action, role,
        dept: role ? App.roleDept(role) : null,   // segment by department, not just role
        detail: detail || {}
      });
      if (buffer.length >= MAX_BUFFER) return this.flush();
      if (!timer) timer = setTimeout(() => this.flush(), FLUSH_MS);
    },

    // What changed — the audit trail.
    audit(action, detail) { this.push('audit', action, detail); },
    // What was used — the feature-adoption signal.
    usage(action, detail) { this.push('usage', action, detail); },
    // Something went wrong for the user — feeds the friction section's error rates.
    error(action, detail) { this.push('error', action, detail); },

    /* ---- flow tracking (friction) ----
       A "flow" is a task with a beginning and an end the user can walk away from
       — opening the Edit Task modal, provisioning a user, uploading a delivery.
       start() stamps the clock; done() closes it as either completed or
       abandoned and reports how long it took. That single pair yields all three
       friction metrics: abandonment rate, time-to-completion, and (with error())
       the failure rate. An unclosed flow is simply never reported. */
    flowStart(flow, detail) {
      if (!this._on()) return;
      this._flows = this._flows || {};
      this._flows[flow] = { t: Date.now(), detail: detail || {} };
      this.usage('flow.start', { flow });
    },
    flowDone(flow, completed, detail) {
      if (!this._on()) return;
      const f = this._flows && this._flows[flow];
      if (!f) return;                      // never started (or already closed)
      delete this._flows[flow];
      const ms = Date.now() - f.t;
      // A multi-hour "flow" means the tab was left open, not that the user
      // laboured over it — don't let that skew the timing percentiles.
      const stale = ms > 30 * 60 * 1000;
      this.push('usage', completed ? 'flow.complete' : 'flow.abandon',
        Object.assign({ flow, ms: stale ? null : ms }, f.detail, detail || {}));
    },
    // Called when a modal closes: whatever is still open was walked away from.
    abandonOpenFlows() {
      if (!this._flows) return;
      Object.keys(this._flows).forEach(flow => this.flowDone(flow, false));
    },

    /* De-duped usage ping. Re-renders and repeated clicks on the same view
       would otherwise drown the signal — one event per feature per minute is
       plenty to see which tools a role lives in. */
    feature(action, detail) {
      if (!this._on()) return;
      this._seen = this._seen || {};
      const now = Date.now();
      if (this._seen[action] && now - this._seen[action] < 60000) return;
      this._seen[action] = now;
      this.usage(action, detail);
    },

    /* ---- signals: where time goes, and where people struggle ----
       Product telemetry rather than features, so each is 'sig.'-prefixed and
       the server keeps them out of the feature rankings. Read in Admin →
       Audit & Event Logs → Feature Usage ("Where time goes", "Struggle
       signals") and in a person's summary on the Activity tab. */
    signal(name, detail) { this.usage('sig.' + name, detail); },

    /* Active time per view. Time only counts while the tab is visible and
       someone has touched mouse or keyboard in the last two minutes, so a tab
       left open overnight counts nothing. It's summed here and sent as ONE
       event per half hour (and when the tab is hidden or closed), keeping the
       log's 20,000-row cap for real history. */
    _time: { view: null, acc: {}, lastInput: 0, lastTick: 0, sentAt: 0 },
    setView(view) { this._tick(); this._time.view = view; },
    _tick() {
      const T = this._time, now = Date.now();
      if (T.view && T.lastTick && !document.hidden && now - T.lastInput < IDLE_MS) {
        T.acc[T.view] = (T.acc[T.view] || 0) + Math.min(now - T.lastTick, TICK_MS * 2);
      }
      T.lastTick = now;
    },
    flushTime() {
      this._tick();
      const T = this._time;
      const views = {}; let total = 0;
      Object.keys(T.acc).forEach(v => { const ms = Math.round(T.acc[v]); if (ms >= 1000) { views[v] = ms; total += ms; } });
      T.acc = {}; T.sentAt = Date.now();
      if (total) this.signal('time', { views, ms: total });
    },

    // the same few-pixel spot clicked 3+ times inside 0.8s — something that
    // looks clickable but isn't, or is too slow to answer
    _clicks: [],
    _click(e) {
      const now = Date.now();
      this._clicks = this._clicks.filter(c => now - c.t < 800 && Math.abs(c.x - e.clientX) < 24 && Math.abs(c.y - e.clientY) < 24);
      this._clicks.push({ t: now, x: e.clientX, y: e.clientY });
      if (this._clicks.length < 3) return;
      this._clicks = [];
      const t = e.target && e.target.closest ? e.target : null;
      if (!t) return;
      // name the control that was hit; anything else (a bar, a row, empty
      // space) by its element and class, which is what a developer can find
      const n = t.closest('button, a, [role="button"], [role="tab"], input, select, label, [aria-label], [title]');
      const label = n ? (n.getAttribute('aria-label') || n.getAttribute('title') || n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) : '';
      const what = label || (t.tagName.toLowerCase() + (t.classList[0] ? '.' + t.classList[0] : ''));
      this.signal('rage', { target: what, view: App.state && App.state.view });
    },

    // a query someone typed that matched nothing, once it's settled for 2s
    _searchTimer: null,
    searchResult(q, count) {
      clearTimeout(this._searchTimer);
      q = (q || '').trim();
      // every render passes through here, so the same dead query is only told once
      if (!q || count) { this._emptyQ = null; return; }
      if (this._emptyQ === q) return;
      this._searchTimer = setTimeout(() => {
        this._emptyQ = q;
        this.signal('searchEmpty', { q: q.slice(0, 60), view: App.state && App.state.view });
      }, 2000);
    },

    flush(useBeacon) {
      clearTimeout(timer); timer = null;
      if (!buffer.length || (sending && !useBeacon)) return;
      const batch = buffer; buffer = [];
      sending = true;
      post(batch, useBeacon);
      sending = false;
    }
  };

  // Don't lose the tail of a session when the tab closes or is backgrounded.
  addEventListener('pagehide', () => { App.track.flushTime(); App.track.flush(true); });
  addEventListener('visibilitychange', () => {
    if (document.hidden) { App.track.flushTime(); App.track.flush(true); }
    else App.track._time.lastTick = Date.now();   // hidden time never counts
  });
  // active-time clock: any input marks the person present
  const present = () => { const T = App.track._time; if (!T.lastInput || Date.now() - T.lastInput > IDLE_MS) T.lastTick = Date.now(); T.lastInput = Date.now(); };
  ['pointerdown', 'keydown', 'wheel', 'pointermove'].forEach(ev => addEventListener(ev, present, { passive: true, capture: true }));
  addEventListener('click', e => App.track._click(e), true);
  setInterval(() => {
    App.track._tick();
    if (Date.now() - App.track._time.sentAt > TIME_SEND_MS) App.track.flushTime();
  }, TICK_MS);
  App.track._time.sentAt = Date.now();
})();
