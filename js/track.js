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
  addEventListener('pagehide', () => App.track.flush(true));
  addEventListener('visibilitychange', () => { if (document.hidden) App.track.flush(true); });
})();
