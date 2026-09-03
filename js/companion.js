/* Companion probe — find a local Post Pipeline that can reach the volume.

   The hosted board has no LucidLink mount and never can: a container in a
   datacenter cannot see a volume mounted on someone's Mac, and there is no
   way to mount a laptop's directory into a remote server. What CAN work is
   the other direction — a studio machine running this same server has the
   mount, so the hosted page hands its file work to that machine instead.
   Board state stays on the host (one shared source of truth); only the
   filesystem work moves to where the filesystem is.

   ── WHY LOCALHOST IS THE ONLY ADDRESS THAT WORKS ──────────────────────────
   http://localhost means "the machine this browser is running on", so a
   teammate's browser probing it reaches THEIR machine, never yours. That
   isn't a limitation to route around — it's the correct behaviour. LucidLink
   IS the filesystem here: someone without the volume mounted has no files to
   open and no folder to create a project in, so "file features need the
   mount" is a fact about the work, not a software restriction.

   ── SAFE WHEN ABSENT ──────────────────────────────────────────────────────
   Nothing here throws or blocks. No companion → available() stays false and
   every caller keeps talking to the host exactly as it does today, which is
   the degraded-but-honest panel from #35. The probe is also cheap and cached:
   one request, short timeout, result reused for the session. */
window.App = window.App || {};
(function () {
  'use strict';

  const DEFAULT_PORT = 8771;
  const PROBE_TIMEOUT_MS = 1500;

  App.companion = {
    _state: 'unprobed',        // unprobed | probing | present | absent
    _base: null,
    _masterOk: false,
    _probe: null,              // the in-flight promise, so parallel callers share one request

    /* The port a companion listens on. 8771 is what the launcher scripts and
       launch.json use; the override exists for anyone running it elsewhere
       and is per-device (localStorage), not board state — it describes this
       machine, not the production. */
    port() { return Number(App.prefs.get('companionPort', DEFAULT_PORT)) || DEFAULT_PORT; },
    setPort(p) { App.prefs.set('companionPort', Number(p) || DEFAULT_PORT); this.reset(); },

    /* Only meaningful when the page itself ISN'T the local server. Served
       from localhost already? Then this IS the machine with the mount (or
       isn't, and a companion wouldn't help) — the normal same-origin routes
       already do the right thing, so probing would just be a wasted request
       against ourselves. */
    wanted() {
      const h = location.hostname;
      return !(h === 'localhost' || h === '127.0.0.1' || h === '[::1]');
    },

    available() { return this._state === 'present'; },
    // present AND actually able to reach a volume — the only state where
    // handing file work over is an improvement on staying local
    usable() { return this._state === 'present' && this._masterOk; },
    base() { return this.usable() ? this._base : null; },

    reset() {
      this._state = 'unprobed'; this._base = null; this._masterOk = false; this._probe = null;
    },

    async ensure() {
      if (!this.wanted()) { this._state = 'absent'; return false; }
      if (this._state === 'present' || this._state === 'absent') return this.usable();
      if (this._probe) return this._probe;

      const base = 'http://localhost:' + this.port();
      this._state = 'probing';
      this._probe = (async () => {
        try {
          const r = await fetch(base + '/api/companion/ping', {
            method: 'GET',
            credentials: 'include',        // the companion has its own session
            cache: 'no-store',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
          });
          if (!r.ok) throw new Error('ping ' + r.status);
          const body = await r.json();
          // confirm it's actually us — an arbitrary service on this port
          // answering 200 must not be mistaken for a companion
          if (body.app !== 'post-pipeline' || !body.companion) throw new Error('not a companion');
          this._base = base;
          this._masterOk = !!body.masterOk;
          this._state = 'present';
        } catch (e) {
          // absent, blocked by Private Network Access, wrong port, not signed
          // in there — all the same outcome from here: carry on without it
          this._state = 'absent';
          this._base = null; this._masterOk = false;
        }
        this._probe = null;
        return this.usable();
      })();
      return this._probe;
    },

    /* What the UI can say about it. Kept here rather than in a view so the
       wording stays consistent wherever it surfaces. */
    describe() {
      if (!this.wanted()) return null;
      if (this._state === 'present' && this._masterOk) return 'Using the volume on this machine.';
      if (this._state === 'present') return 'A local Post Pipeline is running, but it can’t reach the volume either.';
      return null;
    }
  };
})();
