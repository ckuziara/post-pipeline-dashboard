/* Guided setup — a first-run wizard, a hands-on tour, and the per-person
   profile both of them write.

   Three parts, in the order a new person meets them:

     The wizard   A retro text-adventure screen (.if-*). Welcome, what the
                  app is, a name, a theme, a mascot, the order they want the
                  tabs in. Keyboard-first: number keys pick, arrows + Enter,
                  B goes back, Esc offers to quit.

     The coach    A spotlight over the real app (.gd-*): everything dims but
                  the thing being explained, a bubble says what it is, and
                  the chosen mascot pops up behind it. A step that asks the
                  user to DO something waits until they have — or until they
                  press Show me (it's done for them) or Skip (which ducks out
                  of the way once and asks if they're sure).

     The sandbox  The tour clicks real filters, opens real dialogs and draws
                  real notes, on a demo show. None of it is kept: on the way
                  in the board is copied and every save, push, teammate sync
                  and audit is held off; on the way out the copy goes back.

   The profile ({ name, character, theme, tabOrder, setupDone }) lives in the
   shared board at data.profiles[email] — like the Journal, it follows the
   person to any machine. Admins write the welcome and completion text, the
   mascot roster and the demo show in data.guide (Admin → Workflow → Guide
   Configuration). */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const modalOpen = () => !!document.querySelector('.modal-overlay');
  const cmd = () => App.isMac ? '⌘' : 'Ctrl';
  const alt = () => App.isMac ? 'Option' : 'Alt';
  const escHtml = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /* ------------------------------------------------------------ config */
  const DEFAULT_MASCOTS = [
    { emoji: '💩', label: 'Sir Plops-a-Lot' },
    { emoji: '🥸', label: 'The Producer in Disguise' },
    { emoji: '🤡', label: 'Bonko the Notes Clown' },
    { emoji: '📎', label: 'Clippy’s Cousin' },
    { emoji: '👀', label: 'The Reviewer' }
  ];
  const DEFAULT_WELCOME =
    'Morning light spills across the edit suite. The coffee’s still warm, the timeline’s already open, ' +
    'and somewhere a render bar is creeping toward 100%.\n\n' +
    'Welcome to PipeDream, {name}! Let’s get your desk set up.';
  const DEFAULT_COMPLETION =
    'Setup complete, {name}! Your pipeline is set up the way you like it. This is your Journal — ' +
    'a page for each day, just for you. Jot down what you’re working on, and the rest of the board will keep up.';
  const DEMO_ID = 'demo_alp';
  const DEMO_NAME = 'Alp’s Ping Pong Adventure';

  App.guideConfig = function () {
    const g = (App.state.data && App.state.data.guide) || {};
    return {
      welcome: (g.welcome || '').trim() || DEFAULT_WELCOME,
      completion: (g.completion || '').trim() || DEFAULT_COMPLETION,
      mascots: Array.isArray(g.mascots) && g.mascots.length ? g.mascots : DEFAULT_MASCOTS,
      demoShowId: g.demoShowId || ''
    };
  };
  App.GUIDE_DEFAULTS = { welcome: DEFAULT_WELCOME, completion: DEFAULT_COMPLETION, mascots: DEFAULT_MASCOTS };

  /* The tabs a person ranks. "Resourcing" isn't a tab of its own — it's the
     Timeline's Resources mode — so picking it first opens the Timeline in
     that mode (see App.profile.applyStart). */
  const PRIORITY_TABS = [
    { key: 'dashboard', label: 'Dashboard',           blurb: 'your day at a glance' },
    { key: 'timeline',  label: 'Production Schedule', blurb: 'the Timeline — every episode on a calendar' },
    { key: 'board',     label: 'Task Board',          blurb: 'every task, as a list' },
    { key: 'review',    label: 'Reviews',             blurb: 'cuts waiting for your notes', when: () => App.canSeeReviewQueue(App.state.role) },
    { key: 'resources', label: 'Resourcing',          blurb: 'who’s busy, week by week', when: () => App.canSeeResources(App.state.role) }
  ];
  const availableTabs = () => PRIORITY_TABS.filter(t => !t.when || t.when());

  /* ------------------------------------------------------------ profile */
  App.profile = {
    _queued: null,              // writes made while the tour's sandbox is up
    key() { return (App.state.user && App.state.user.email) || 'local'; },
    get() {
      const d = App.state.data;
      return (d && d.profiles && d.profiles[this.key()]) || null;
    },
    /* Not an App.mutate: who someone is isn't a board edit, so it takes no
       undo step and draws nothing. */
    set(patch) {
      if (App.state.sandbox) { this._queued = Object.assign({}, this._queued, patch); return; }
      const d = App.state.data;
      d.profiles = d.profiles || {};
      d.profiles[this.key()] = Object.assign({}, d.profiles[this.key()], patch);
      App.save();
    },
    flushQueued() {
      if (!this._queued) return;
      const q = this._queued; this._queued = null;
      this.set(q);
    },
    displayName() {
      const p = this.get();
      if (p && p.name) return p.name;
      const u = App.state.user;
      return u && u.name ? u.name.split(' ')[0] : '';
    },
    mascot() {
      const p = this.get();
      const list = App.guideConfig().mascots;
      return (p && p.character) || (list[0] && list[0].emoji) || '👀';
    },
    // the person's ranking, cut to what this role can actually open, with
    // anything they've not ranked yet (a tab granted since) on the end
    tabOrder() {
      const avail = availableTabs().map(t => t.key);
      const saved = ((this.get() || {}).tabOrder || []).filter(k => avail.includes(k));
      return saved.concat(avail.filter(k => !saved.includes(k)));
    },
    hasOrder() { const p = this.get(); return !!(p && Array.isArray(p.tabOrder) && p.tabOrder.length); },
    // the view-tab order: a ranked list of views, with Resourcing folded
    // into the Timeline wherever it ranks higher
    viewOrder() {
      const out = [];
      this.tabOrder().forEach(k => { const v = k === 'resources' ? 'timeline' : k; if (!out.includes(v)) out.push(v); });
      return out;
    },
    // where a new day starts: the first-ranked tab
    applyStart() {
      if (!this.hasOrder()) return false;
      const first = this.tabOrder()[0];
      if (first === 'resources') { App.state.view = 'timeline'; App.prefs.set('timelineMode', 'resources'); }
      else {
        App.state.view = first;
        if (first === 'timeline') App.prefs.set('timelineMode', 'schedule');
      }
      return true;
    }
  };

  /* ------------------------------------------------------------ sandbox */
  const SANDBOX_PREFS = ['timelineMode', 'hideDoneTimeline', 'hideDoneBoard', 'timelineOrientation'];
  const sandbox = {
    _snap: null,
    showId: null,

    enter() {
      if (App.state.sandbox) return;
      const s = App.state;
      this._snap = {
        data: clone(s.data), filters: clone(s.filters), view: s.view, zoom: s.zoom,
        expanded: clone(s.expanded), ganttExpanded: clone(s.ganttExpanded), gantt: s.gantt ? clone(s.gantt) : null,
        prefs: SANDBOX_PREFS.map(k => [k, App.prefs.get(k, undefined)]),
        undo: App.history._undo.length
      };
      s.sandbox = true;
      document.body.classList.add('gd-sandboxed');
      this.showId = this.pickShow();
      s.filters = { show: [], dept: [], person: [], q: '' };
      s.expanded = {}; s.ganttExpanded = {};
    },

    async exit() {
      if (!App.state.sandbox) return;
      const s = App.state, snap = this._snap;
      App.modal && App.modal.close && App.modal.close();
      App.gantt && App.gantt.closeNoteEditor && App.gantt.closeNoteEditor();
      App.filterMenu && App.filterMenu.close && App.filterMenu.close();
      s.data = snap.data; s.filters = snap.filters; s.view = snap.view; s.zoom = snap.zoom;
      s.expanded = snap.expanded; s.ganttExpanded = snap.ganttExpanded; s.gantt = snap.gantt;
      snap.prefs.forEach(([k, v]) => App.prefs.set(k, v));
      // anything the tour did is not something to undo afterwards
      App.history._undo.length = Math.min(App.history._undo.length, snap.undo);
      App.history._redo.length = 0;
      s.sandbox = false;
      document.body.classList.remove('gd-sandboxed');
      this._snap = null;
      // teammates may have saved while the tour held sync off — catch up
      if (App.api && App.api.online && App.api.me) {
        try { const d = await App.api.pull(); if (d) s.data = App.migrate(d); } catch (e) {}
      }
      App.profile.flushQueued();
      App.render();
    },

    /* The admin's pick if it's still an active show; otherwise the built-in
       demo, dealt from the seed's first show with its tasks handed to real
       people — the current user first — so "your tasks" means something. */
    pickShow() {
      const chosen = App.guideConfig().demoShowId;
      if (chosen && App.activeShows().some(s => s.id === chosen)) return chosen;
      const seed = App.seedData();
      const src = seed.shows[0];
      const d = App.state.data;
      const me = App.state.user && App.state.user.personId;
      const myDept = App.roleDept(App.state.role);
      const realByDept = {};
      d.people.forEach(p => { const k = App.roleDept(p.role); if (k) (realByDept[k] = realByDept[k] || []).push(p.id); });
      const seedDept = {};
      seed.people.forEach(p => { seedDept[p.id] = App.roleDept(p.role); });
      const show = Object.assign({}, src, { id: DEMO_ID, name: DEMO_NAME, prefix: 'APA', color: '#ff8a3d', notes: [] });
      const eps = seed.episodes.filter(e => e.showId === src.id).map((e, i) => {
        const assignees = {};
        Object.keys(e.assignees || {}).forEach(k => {
          const dept = seedDept[e.assignees[k]];
          if (me && dept && dept === myDept) assignees[k] = me;
          else if (dept && realByDept[dept]) assignees[k] = realByDept[dept][i % realByDept[dept].length];
        });
        return Object.assign({}, e, {
          id: 'demo_ep' + i, showId: DEMO_ID,
          code: String(e.code || '').replace(/^[^-]+/, 'APA'), assignees
        });
      });
      d.shows.push(show);
      d.episodes.push(...eps);
      return DEMO_ID;
    },
    isBuiltIn() { return this.showId === DEMO_ID; }
  };
  App.guideSandbox = sandbox;

  /* ------------------------------------------------------------ skip, reluctantly
     Every Skip ducks out of the way the first time it's pressed: it slides a
     short way in a random direction, and the mascot asks whether you're sure.
     The second press on the same step really skips. */
  function reluctantSkip(btn, sayFn, onSkip) {
    let tries = 0, dx = 0, dy = 0;
    const press = () => {
      if (tries++ > 0) { onSkip(); return; }
      const r = btn.getBoundingClientRect();
      const ang = Math.random() * Math.PI * 2, dist = 40 + Math.random() * 40;
      let nx = dx + Math.cos(ang) * dist, ny = dy + Math.sin(ang) * dist;
      // keep it in reach — on screen, and inside the terminal when it's in
      // one: a skip you can't get to isn't a joke, it's a bug
      const box = btn.closest('.if-stage, .gd-bubble');
      const bb = box ? box.getBoundingClientRect()
        : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      const left = r.left - dx + nx, top = r.top - dy + ny;
      if (left < bb.left + 8) nx += bb.left + 8 - left;
      if (left + r.width > bb.right - 8) nx -= left + r.width - (bb.right - 8);
      if (top < bb.top + 8) ny += bb.top + 8 - top;
      if (top + r.height > bb.bottom - 8) ny -= top + r.height - (bb.bottom - 8);
      dx = nx; dy = ny;
      btn.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      btn.classList.add('gd-dodged');
      sayFn('Are you sure about that?');
    };
    return { press, reset() { tries = 0; dx = 0; dy = 0; btn.style.transform = ''; btn.classList.remove('gd-dodged'); } };
  }

  /* ------------------------------------------------------------ mascot speech */
  function sayFrom(mascotEl, text) {
    if (!mascotEl || !mascotEl.isConnected) return;
    const old = mascotEl.querySelector('.gd-mascot-say');
    if (old) old.remove();
    const b = el('.gd-mascot-say', null, text);
    if (mascotEl.getBoundingClientRect().top < 70) b.classList.add('below');
    mascotEl.appendChild(b);
    setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 300); }, 2500);
  }

  /* ================================================================ WIZARD
     A cozy visual-novel screen: an illustrated edit suite (the scene) with a
     dialog box over it, the speaker's name on a tag at its top edge. The
     scene follows along — the director's name goes on the clapperboard as
     it's typed, the right-hand monitor previews the theme being picked, the
     chosen companion sits on the desk, and tab priorities are pinned to the
     schedule board as sticky notes. Each prompt is a promise; a step
     resolves {value} or {nav:'back'|'skip'|'quit'}. */

  // the edit suite, drawn in the same thick-outline, flat-pastel hand as the
  // rest of the costume. viewBox 1600×900; ids are what the wizard touches.
  function sceneSVG() {
    const now = new Date();
    const hA = ((now.getHours() % 12) + now.getMinutes() / 60) * 30, mA = now.getMinutes() * 6;
    const days = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
    return `
<svg class="if-svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g class="sc-o">
    <!-- wall + floor -->
    <rect x="-20" y="-20" width="1640" height="720" fill="#f4ecd6" stroke="none"/>
    <path d="M-20 700 H1620 V920 H-20Z" fill="#e3c99b"/>
    <path d="M-20 700 H1620" />
    <g stroke-width="3" opacity=".35"><path d="M120 760 H520 M700 800 H1180 M1300 750 H1600 M60 860 H400 M880 870 H1400"/></g>
    <path d="M-20 640 H1620" stroke-width="3" opacity=".25"/>

    <!-- the schedule board -->
    <g id="sc-calendar">
      <rect x="90" y="70" width="450" height="320" rx="18" fill="#c99863"/>
      <rect x="112" y="92" width="406" height="276" rx="10" fill="#efcf98"/>
      <rect x="196" y="48" width="240" height="56" rx="14" fill="#f7a6b8"/>
      <text x="316" y="86" class="sc-t" text-anchor="middle" font-size="28">THIS WEEK</text>
      ${days.map((d, i) => `<text x="${150 + i * 78}" y="128" class="sc-t" font-size="18" text-anchor="middle" opacity=".55">${d}</text>`).join('')}
      <g stroke-width="3" opacity=".25">${[1, 2, 3, 4].map(i => `<path d="M${112 + i * 81} 140 V360"/>`).join('')}</g>
      <circle cx="140" cy="102" r="8" fill="#e85d5d"/><circle cx="490" cy="102" r="8" fill="#5d8ee8"/>
      <g id="sc-notes"></g>
    </g>

    <!-- wall clock: it's always about the schedule -->
    <g id="sc-clock" transform="translate(720 150)">
      <circle r="74" fill="#fffaf0"/>
      <circle r="60" fill="none" stroke-width="3" opacity=".3"/>
      <path d="M0 0 L0 -40" transform="rotate(${hA})" stroke-width="7"/>
      <path d="M0 0 L0 -54" transform="rotate(${mA})" stroke-width="4"/>
      <circle r="6" fill="#2b2b2b"/>
    </g>

    <!-- a film poster -->
    <g id="sc-poster">
      <rect x="1240" y="40" width="190" height="220" rx="10" fill="#8fb7e8"/>
      <path d="M1262 225 L1310 160 L1345 200 L1375 170 L1410 225Z" fill="#6c9a5e"/>
      <circle cx="1380" cy="100" r="22" fill="#ffd166"/>
      <text x="1335" y="250" class="sc-t" text-anchor="middle" font-size="20">NOW SHOWING</text>
    </g>

    <!-- desk -->
    <rect x="520" y="520" width="1040" height="44" rx="12" fill="#c9a074"/>
    <path d="M560 564 V700 M1520 564 V700" stroke-width="10"/>
    <rect x="1340" y="564" width="160" height="110" rx="8" fill="#b88d62"/>
    <path d="M1360 618 H1480" stroke-width="3"/><circle cx="1420" cy="598" r="5" fill="#2b2b2b"/>

    <!-- monitor A: a timeline, of course -->
    <g id="sc-timeline">
      <path d="M990 470 L980 520 H1060 L1050 470" fill="#4a4a4a"/>
      <rect x="840" y="290" width="360" height="190" rx="14" fill="#3b3b44"/>
      <rect x="856" y="306" width="328" height="158" rx="6" fill="#20222b" stroke-width="3"/>
      <rect x="872" y="324" width="120" height="16" rx="5" fill="#ff6f9c" stroke="none"/>
      <rect x="940" y="352" width="150" height="16" rx="5" fill="#ffd166" stroke="none"/>
      <rect x="1020" y="380" width="110" height="16" rx="5" fill="#6cc24a" stroke="none"/>
      <rect x="900" y="408" width="90" height="16" rx="5" fill="#8fb7e8" stroke="none"/>
      <rect x="1060" y="436" width="100" height="16" rx="5" fill="#a06cd5" stroke="none"/>
      <path d="M1010 316 V456" stroke="#ff5b6e" stroke-width="3"/>
    </g>

    <!-- monitor B: previews the theme being picked -->
    <g id="sc-monitor">
      <path d="M1340 470 L1330 520 H1410 L1400 470" fill="#4a4a4a"/>
      <rect x="1220" y="290" width="300" height="190" rx="14" fill="#3b3b44"/>
      <g class="sc-theme">
        <rect x="1236" y="306" width="268" height="158" rx="6" style="fill:var(--bg)" stroke-width="3"/>
        <rect x="1236" y="306" width="268" height="24" rx="6" style="fill:var(--surface)" stroke="none"/>
        <rect x="1248" y="314" width="40" height="8" rx="4" style="fill:var(--accent)" stroke="none"/>
        <rect x="1250" y="342" width="110" height="52" rx="6" style="fill:var(--surface)" stroke="none"/>
        <rect x="1372" y="342" width="118" height="52" rx="6" style="fill:var(--surface)" stroke="none"/>
        <rect x="1262" y="356" width="60" height="8" rx="4" style="fill:var(--text)" opacity=".6" stroke="none"/>
        <rect x="1262" y="372" width="80" height="8" rx="4" style="fill:var(--accent)" stroke="none"/>
        <rect x="1384" y="356" width="70" height="8" rx="4" style="fill:var(--text)" opacity=".6" stroke="none"/>
        <rect x="1384" y="372" width="50" height="8" rx="4" style="fill:var(--st-approved)" stroke="none"/>
        <rect x="1250" y="404" width="240" height="46" rx="6" style="fill:var(--surface)" stroke="none"/>
        <rect x="1262" y="418" width="160" height="8" rx="4" style="fill:var(--st-review)" stroke="none"/>
        <rect x="1262" y="432" width="100" height="8" rx="4" style="fill:var(--text)" opacity=".4" stroke="none"/>
      </g>
    </g>

    <!-- keyboard, mouse, coffee -->
    <rect x="900" y="494" width="260" height="30" rx="8" fill="#ece6da"/>
    <g stroke-width="2" opacity=".4"><path d="M920 509 H1140"/></g>
    <rect x="1190" y="498" width="34" height="24" rx="12" fill="#ece6da"/>
    <g id="sc-mug">
      <path d="M1440 470 h56 v40 a14 14 0 0 1 -14 14 h-28 a14 14 0 0 1 -14 -14Z" fill="#f28c6b"/>
      <path d="M1496 480 a14 14 0 0 1 0 28" fill="none"/>
      <path class="sc-steam" d="M1458 455 q-10 -16 0 -30 M1478 455 q-10 -16 0 -30" fill="none" stroke-width="4" opacity=".45"/>
    </g>

    <!-- the clapperboard, with the director's name on it -->
    <g id="sc-clapper">
      <rect x="560" y="382" width="210" height="140" rx="10" fill="#3a3a3a"/>
      <path d="M560 382 L566 340 L776 352 L770 382Z" fill="#fffaf0"/>
      <g stroke="none" fill="#3a3a3a"><path d="M590 343 l26 1 l-14 36 l-26 -1Z M650 346 l26 1 l-14 36 l-26 -1Z M710 349 l26 1 l-14 36 l-26 -1Z"/></g>
      <path d="M560 420 H770 M560 460 H770 M665 420 V460" stroke="#fffaf0" stroke-width="3"/>
      <text x="575" y="410" class="sc-c" font-size="20">PIPEDREAM</text>
      <text x="575" y="448" class="sc-c" font-size="17">SC 01</text>
      <text x="680" y="448" class="sc-c" font-size="17">TK 01</text>
      <text x="575" y="500" class="sc-c" font-size="20" id="sc-clap-name">DIR: ?</text>
    </g>

    <!-- film reel + a strip of film across the floor -->
    <g id="sc-reel">
      <path d="M330 690 C 420 720, 520 650, 640 690 S 860 740, 980 700" fill="none" stroke="#3a3a3a" stroke-width="26"/>
      <path d="M330 690 C 420 720, 520 650, 640 690 S 860 740, 980 700" fill="none" stroke="#f4ecd6" stroke-width="8" stroke-dasharray="10 14"/>
      <circle cx="250" cy="600" r="96" fill="#5d6fd6"/>
      <circle cx="250" cy="600" r="20" fill="#f4ecd6"/>
      ${[0, 72, 144, 216, 288].map(a => `<circle cx="${250 + Math.cos(a * Math.PI / 180) * 54}" cy="${600 + Math.sin(a * Math.PI / 180) * 54}" r="20" fill="#f4ecd6"/>`).join('')}
    </g>

    <!-- a plant, because every edit suite has one that's seen too much -->
    <g id="sc-plant">
      <path d="M1440 610 q-40 -70 10 -120 q10 60 -10 120 M1460 610 q10 -90 70 -110 q-20 70 -70 110 M1450 610 q-60 -40 -90 -100 q60 20 90 100" fill="#7cb86a"/>
      <path d="M1410 600 h90 l-12 90 h-66Z" fill="#e8946b"/>
    </g>
  </g>
</svg>`;
  }

  const IF = {
    root: null, log: null, input: null, mascotEl: null, foot: null, stage: null,
    _skipNow: false, _keyHandler: null,

    open() {
      this.close();
      this.root = el('.if-screen', { onclick: e => e.stopPropagation() });
      const stage = el('.if-stage');
      stage.innerHTML = sceneSVG();
      this.stage = stage;
      this.mascotEl = el('.if-mascot');
      this.stepEl = el('.if-strip');
      this.nameTag = el('.if-tag', null, 'PipeDream');
      this.log = el('.if-log');
      this.input = el('.if-input');
      this.foot = el('.if-foot');
      const box = el('.if-box', null, [this.nameTag, this.log, this.input, this.foot]);
      stage.appendChild(this.mascotEl);
      stage.appendChild(this.stepEl);
      stage.appendChild(box);
      this.root.appendChild(stage);
      document.body.appendChild(this.root);
      // any key or click finishes the line being typed
      this._skipType = () => { this._skipNow = true; };
      this.root.addEventListener('mousedown', this._skipType);
      document.addEventListener('keydown', this._skipType, true);
    },
    close() {
      if (this._keyHandler) { document.removeEventListener('keydown', this._keyHandler, true); this._keyHandler = null; }
      if (this._skipType) document.removeEventListener('keydown', this._skipType, true);
      if (this.root) this.root.remove();
      this.root = null;
    },
    peek(on) { if (this.root) this.root.classList.toggle('if-peek', !!on); },
    // a film strip of frames across the top: one per step, the done ones exposed
    setStep(n, total) {
      if (!this.stepEl) return;
      this.stepEl.innerHTML = '';
      for (let i = 1; i <= total; i++) this.stepEl.appendChild(el('span.if-frame' + (i < n ? '.done' : i === n ? '.now' : ''), null, String(i)));
    },
    // which prop in the scene is being talked about: it wiggles
    focus(id) { if (this.root) this.root.dataset.focus = id || ''; },
    setSpeaker(name) { if (this.nameTag) this.nameTag.textContent = name || 'PipeDream'; },
    setClap(name) {
      const t = this.root && this.root.querySelector('#sc-clap-name');
      if (t) t.textContent = 'DIR: ' + (String(name || '?').slice(0, 14) || '?');
    },
    // the tab priorities, pinned to the schedule board in order
    setNotes(labels) {
      const g = this.root && this.root.querySelector('#sc-notes');
      if (!g) return;
      const colors = ['#fff3a3', '#ffc9d6', '#c9e8ff', '#d4f5c4', '#e6d4ff'];
      g.innerHTML = (labels || []).map((l, i) => {
        const x = 124 + (i % 3) * 132, y = 146 + Math.floor(i / 3) * 106, r = (i % 2 ? 4 : -3);
        const words = l.split(' ');
        return `<g transform="rotate(${r} ${x + 60} ${y + 46})" class="sc-note">
          <rect x="${x}" y="${y}" width="122" height="92" rx="6" fill="${colors[i % colors.length]}" stroke="#2b2b2b" stroke-width="3"/>
          <circle cx="${x + 61}" cy="${y + 8}" r="6" fill="#e85d5d" stroke="#2b2b2b" stroke-width="2"/>
          <text x="${x + 61}" y="${y + 36}" class="sc-t" font-size="16" text-anchor="middle">${i + 1}</text>
          ${words.map((w, j) => `<text x="${x + 61}" y="${y + 58 + j * 19}" class="sc-t" font-size="15" text-anchor="middle">${escHtml(w)}</text>`).join('')}
        </g>`;
      }).join('');
    },
    // before a companion is chosen, a stand-in keeps the desk warm (and has
    // something to say when Skip is pressed)
    setMascot(emoji) {
      if (!this.mascotEl) return;
      const keep = this.mascotEl.querySelector('.gd-mascot-say');
      this.mascotEl.textContent = emoji || '🎬';
      if (keep) this.mascotEl.appendChild(keep);
      this.mascotEl.classList.remove('hop'); void this.mascotEl.offsetWidth; this.mascotEl.classList.add('on', 'hop');
      this.mascotEl.classList.toggle('stand-in', !emoji);
    },
    clear() { if (this.log) this.log.innerHTML = ''; if (this.input) this.input.innerHTML = ''; },

    async type(text, cls) {
      const p = el('p.if-line' + (cls ? '.' + cls : ''));
      this.log.appendChild(p);
      this._skipNow = false;
      for (let i = 0; i < text.length; i++) {
        if (this._skipNow || !this.root) { p.textContent = text; break; }
        p.textContent = text.slice(0, i + 1);
        if (i % 2 === 0) await sleep(text[i] === '\n' ? 60 : 16);
      }
      this.log.scrollTop = this.log.scrollHeight;
      await sleep(40);
      this._skipNow = false;
    },
    // what was picked isn't repeated back — the scene shows it instead
    echo() {},

    /* Footer, written into the box's bottom border: Back, Skip (reluctant)
       and Quit. `onSkip` is what skipping this step means — usually "keep
       the default and move on". */
    footer({ back, onSkip, onBack, onQuit }) {
      this.foot.innerHTML = '';
      const skipBtn = el('button.if-key.if-skip', { title: 'S' }, 'SKIP');
      const rs = reluctantSkip(skipBtn, (t) => sayFrom(this.mascotEl, t), onSkip);
      skipBtn.onclick = () => rs.press();
      this.foot.appendChild(el('button.if-key' + (back ? '' : '.off'), { title: 'B', onclick: back ? onBack : null }, '« BACK'));
      this.foot.appendChild(skipBtn);
      this.foot.appendChild(el('button.if-key', { title: 'Esc', onclick: onQuit }, 'QUIT »'));
      return rs;
    },

    /* Pick one of `options` ([{label, value, hint}]), shown as numbered pills.
       onFocus fires as the highlight moves (the theme step previews with it). */
    choose(options, opts) {
      opts = opts || {};
      return new Promise(resolve => {
        let idx = Math.max(0, options.findIndex(o => o.value === opts.current));
        this.input.innerHTML = '';
        const list = el('.if-choices' + (options.length > 6 ? '.many' : ''));
        const rows = options.map((o, i) => el('button.if-choice', {
          onclick: () => done({ value: o.value }),
          onmouseenter: () => focus(i)
        }, [el('span.if-num', null, String(i + 1)), el('span.if-lbl', null, [o.label, o.hint ? el('span.if-hint', null, o.hint) : null])]));
        rows.forEach(r => list.appendChild(r));
        this.input.appendChild(list);
        const focus = (i) => {
          idx = i;
          rows.forEach((r, j) => r.classList.toggle('on', j === i));
          if (opts.onFocus) opts.onFocus(options[i].value);
        };
        focus(idx);
        let finished = false;
        const done = (r) => {
          if (finished) return;
          finished = true;
          document.removeEventListener('keydown', key, true);
          this._keyHandler = null;
          resolve(r);
        };
        const rs = this.footer({
          back: opts.back, onBack: () => done({ nav: 'back' }),
          onSkip: () => done({ nav: 'skip' }), onQuit: () => done({ nav: 'quit' })
        });
        const key = (e) => {
          if (!this.root) return;
          const k = e.key;
          if (/^[1-9]$/.test(k) && options[Number(k) - 1]) { e.preventDefault(); e.stopPropagation(); done({ value: options[Number(k) - 1].value }); }
          else if (k === 'ArrowDown' || k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); focus((idx + 1) % options.length); }
          else if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); focus((idx - 1 + options.length) % options.length); }
          else if (k === 'Enter') { e.preventDefault(); e.stopPropagation(); done({ value: options[idx].value }); }
          else if ((k === 'b' || k === 'B') && opts.back) { e.preventDefault(); e.stopPropagation(); done({ nav: 'back' }); }
          else if (k === 's' || k === 'S') { e.preventDefault(); e.stopPropagation(); rs.press(); }
          else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); done({ nav: 'quit' }); }
        };
        this._keyHandler = key;
        document.addEventListener('keydown', key, true);
      });
    },

    ask(prompt, def, opts) {
      opts = opts || {};
      return new Promise(resolve => {
        this.input.innerHTML = '';
        const field = el('input.if-field', { type: 'text', value: def || '', maxlength: '40', spellcheck: 'false', placeholder: 'Type a name…' });
        if (opts.onInput) field.addEventListener('input', () => opts.onInput(field.value));
        this.input.appendChild(el('label.if-ask', null, [field, el('span.if-enter', null, 'Enter ↵')]));
        setTimeout(() => { field.focus(); field.select(); }, 0);
        let finished = false;
        const done = (r) => {
          if (finished) return;
          finished = true;
          document.removeEventListener('keydown', key, true);
          this._keyHandler = null;
          resolve(r);
        };
        this.footer({
          back: opts.back, onBack: () => done({ nav: 'back' }),
          onSkip: () => done({ nav: 'skip' }), onQuit: () => done({ nav: 'quit' })
        });
        const key = (e) => {
          if (!this.root) return;
          if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation();
            const v = field.value.trim();
            if (v) done({ value: v });
          } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done({ nav: 'quit' }); }
          // typing goes to the field; Back and Skip are the footer's buttons here
        };
        this._keyHandler = key;
        document.addEventListener('keydown', key, true);
      });
    }
  };

  /* ================================================================ COACH
     One spotlight at a time. `step()` resolves 'done' | 'skip' | 'end'. The
     target is looked up again every frame — App.render rebuilds the DOM, so
     an element reference would go stale on the first redraw. */
  const coach = {
    layer: null, hole: null, bubble: null, mascot: null, _raf: 0, _poll: 0,

    ensure() {
      if (this.layer && this.layer.isConnected) return;
      this.layer = el('.gd-layer');
      this.hole = el('.gd-hole');
      this.mascot = el('.gd-mascot');
      this.bubble = el('.gd-bubble', { onclick: e => e.stopPropagation(), onmousedown: e => e.stopPropagation() });
      this.layer.appendChild(this.hole);
      this.layer.appendChild(this.mascot);
      this.layer.appendChild(this.bubble);
      document.body.appendChild(this.layer);
    },
    close() {
      cancelAnimationFrame(this._raf); clearInterval(this._poll);
      if (this.layer) this.layer.remove();
      this.layer = null;
    },
    say(text) { sayFrom(this.mascot, text); },

    resolveTargets(t) {
      if (!t) return [];
      const r = typeof t === 'function' ? t() : document.querySelectorAll(t);
      const arr = !r ? [] : (r instanceof Element ? [r] : Array.from(r));
      return arr.filter(n => n && n.isConnected && n.getClientRects().length);
    },

    place(opts) {
      const els = this.resolveTargets(opts.target).concat(this.resolveTargets(opts.also));
      const vw = window.innerWidth, vh = window.innerHeight;
      let rect = null;
      els.forEach(n => {
        const r = n.getBoundingClientRect();
        if (!r.width && !r.height) return;
        rect = rect ? {
          left: Math.min(rect.left, r.left), top: Math.min(rect.top, r.top),
          right: Math.max(rect.right, r.right), bottom: Math.max(rect.bottom, r.bottom)
        } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      const pad = 6;
      if (rect) {
        rect.left = Math.max(4, rect.left - pad); rect.top = Math.max(4, rect.top - pad);
        rect.right = Math.min(vw - 4, rect.right + pad); rect.bottom = Math.min(vh - 4, rect.bottom + pad);
        Object.assign(this.hole.style, {
          display: '', left: rect.left + 'px', top: rect.top + 'px',
          width: (rect.right - rect.left) + 'px', height: (rect.bottom - rect.top) + 'px'
        });
        this.layer.classList.remove('gd-nohole');
      } else {
        this.hole.style.display = 'none';
        this.layer.classList.add('gd-nohole');
      }

      // the bubble: below the hole if it fits, else above, else beside, else centred
      const b = this.bubble.getBoundingClientRect();
      let bx, by;
      if (!rect) { bx = (vw - b.width) / 2; by = (vh - b.height) / 2; }
      else if (rect.bottom + 14 + b.height < vh) { bx = rect.left; by = rect.bottom + 14; }
      else if (rect.top - 14 - b.height > 0) { bx = rect.left; by = rect.top - 14 - b.height; }
      else if (rect.right + 14 + b.width < vw) { bx = rect.right + 14; by = rect.top; }
      else { bx = (vw - b.width) / 2; by = vh - b.height - 16; }
      bx = Math.max(12, Math.min(vw - b.width - 12, bx));
      by = Math.max(12, Math.min(vh - b.height - 12, by));
      this.bubble.style.left = bx + 'px';
      this.bubble.style.top = by + 'px';

      // the mascot peeks up from behind the top edge of what's lit — or sits
      // on the bubble's shoulder when there's nothing to light
      let mx, my;
      if (!rect) { mx = bx + b.width - 30; my = by - 40; }
      else if (rect.top >= 48) { mx = Math.min(vw - 60, rect.right - 46); my = rect.top - 44; }
      // no room above (a tab, the toolbar): beside it instead, never over it
      else if (rect.right + 52 < vw) { mx = rect.right + 4; my = rect.top; }
      else { mx = rect.left - 50; my = rect.top; }
      this.mascot.style.left = mx + 'px';
      this.mascot.style.top = my + 'px';
    },

    step(opts) {
      this.ensure();
      cancelAnimationFrame(this._raf); clearInterval(this._poll);
      const mascotEmoji = App.profile.mascot();
      this.mascot.textContent = mascotEmoji;
      this.mascot.classList.remove('pop'); void this.mascot.offsetWidth; this.mascot.classList.add('pop');

      return new Promise(resolve => {
        let finished = false, evt = null;
        const finish = (how) => {
          if (finished) return;
          finished = true;
          cancelAnimationFrame(this._raf); clearInterval(this._poll);
          document.removeEventListener('keydown', keys, true);
          if (evt) document.removeEventListener(evt.type, evt.fn, true);
          resolve(how);
        };

        const text = typeof opts.text === 'function' ? opts.text() : opts.text;
        this.bubble.innerHTML = '';
        this.bubble.appendChild(el('span.gd-b-title', null, opts.title || ''));
        this.bubble.appendChild(el('.gd-b-head', null, [
          opts.progress ? el('span.gd-b-prog', null, opts.progress) : null,
          el('button.gd-b-x', { title: 'End the tour', onclick: () => finish('end') }, '✕')
        ]));
        const bodyEl = el('.gd-b-text', null, text);
        this.bubble.appendChild(bodyEl);
        if (opts.waitFor) this.bubble.appendChild(el('.gd-b-wait', null, opts.waitLabel || 'Go ahead — I’ll wait.'));
        const acts = el('.gd-b-acts');
        const skipBtn = el('button.gd-b-skip', null, 'Skip');
        const rs = reluctantSkip(skipBtn, (t) => this.say(t), () => finish('skip'));
        skipBtn.onclick = () => rs.press();
        acts.appendChild(skipBtn);
        if (opts.showMe) acts.appendChild(el('button.gd-b-show', {
          onclick: async () => { try { await opts.showMe(); } catch (e) { console.error(e); } if (!opts.waitFor) finish('done'); }
        }, 'Show me'));
        if (!opts.waitFor || opts.next) acts.appendChild(el('button.gd-b-next', { onclick: () => finish('done') }, opts.next || 'Next'));
        this.bubble.appendChild(acts);

        const tick = () => {
          if (finished) return;
          if (opts.text && typeof opts.text === 'function') {
            const t = opts.text();
            if (t !== bodyEl.textContent) bodyEl.textContent = t;
          }
          this.place(opts);
          this._raf = requestAnimationFrame(tick);
        };
        tick();
        if (opts.waitFor) {
          this._poll = setInterval(() => {
            let ok = false;
            try { ok = opts.waitFor(); } catch (e) { ok = false; }
            if (ok) {
              clearInterval(this._poll);
              this.bubble.classList.add('gd-ok');
              setTimeout(() => { this.bubble.classList.remove('gd-ok'); finish('done'); }, 450);
            }
          }, 200);
        }
        if (opts.event) {
          evt = { type: opts.event.type, fn: (e) => { if (e.target.closest && e.target.closest(opts.event.sel)) setTimeout(() => finish('done'), opts.event.delay || 900); } };
          document.addEventListener(evt.type, evt.fn, true);
        }
        // S skips (reluctantly), N / → for Next on a step that has one —
        // never while typing, which a step may well be asking for
        const keys = (e) => {
          const t = e.target;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key === 's' || e.key === 'S') { e.preventDefault(); e.stopPropagation(); rs.press(); }
          else if ((e.key === 'n' || e.key === 'N' || e.key === 'ArrowRight') && (!opts.waitFor || opts.next)) { e.preventDefault(); e.stopPropagation(); finish('done'); }
        };
        document.addEventListener('keydown', keys, true);
      });
    }
  };
  App.coach = coach;

  /* ================================================================ TOUR */
  const goView = (v) => { if (App.state.view !== v) { App.state.view = v; App.render(); } };
  const tabSel = (v) => '.view-tab[data-view="' + v + '"]';
  const deptKey = (re) => Object.keys(App.DEPARTMENTS).find(k => re.test(App.DEPARTMENTS[k].label) || re.test(k));
  const demoEps = () => App.state.data.episodes.filter(e => e.showId === sandbox.showId)
    .sort((a, b) => (a.index || 0) - (b.index || 0));
  const showName = () => (App.show(sandbox.showId) || {}).name || DEMO_NAME;

  const SECTIONS = {
    timeline: () => {
      let zoom0 = 0, notes0 = 0;
      const creative = deptKey(/creative/i);
      const allButCreative = () => Object.keys(App.DEPARTMENTS).filter(k => k !== creative);
      return [
        { title: 'Production Schedule', text: 'Click the Timeline tab — the production schedule, every episode laid out on a calendar.',
          target: tabSel('timeline'), waitFor: () => App.state.view === 'timeline' && App.timelineMode() === 'schedule',
          before: () => { if (App.state.view === 'timeline' && App.timelineMode() !== 'schedule') { App.prefs.set('timelineMode', 'schedule'); App.render(); } },
          showMe: () => { App.prefs.set('timelineMode', 'schedule'); goView('timeline'); } },
        { title: 'Search & filters', text: 'Narrow everything down by Show, Department and Owner, or search by episode. Whatever you pick is remembered the next time you open the app.',
          target: '#toolbar' },
        { title: 'Pick a show', text: () => 'Open the Show filter and pick “' + showName() + '”.',
          target: '.filter-multi[data-fkey="show"]', also: '.filter-pop',
          waitFor: () => App.state.filters.show.length === 1 && App.state.filters.show[0] === sandbox.showId,
          showMe: () => { App.filterMenu.close(); App.state.filters.show = [sandbox.showId]; App.render(); } },
        { title: 'Open them all', text: () => alt() + '-click an episode to open or close every episode at once. (' + cmd() + 'K → “Open every episode” does it too.)',
          target: () => document.querySelector('.g-row[data-episode-id] .g-label'),
          waitFor: () => demoEps().filter(e => App.state.ganttExpanded[e.id]).length >= 2,
          showMe: () => { const e = demoEps()[0]; if (e) { App.gantt.expandAllLike(e.id, true); App.render(); } } },
        { title: 'Zoom', text: () => 'Zoom in and out with ' + cmd() + ' + and ' + cmd() + ' −, or these buttons. Try it.',
          before: () => { zoom0 = App.state.zoom; },
          target: () => { const z = document.querySelector('#toolbar .toolbar-group'); return z; },
          waitFor: () => App.state.zoom !== zoom0,
          showMe: () => App.gantt.zoomBy(1.25) },
        { title: 'Everyone but…', text: () => 'Open Dept, then ' + cmd() + '-click “Creative” twice. The first click shows only Creative; the second shows everything except Creative.',
          target: '.filter-multi[data-fkey="dept"]', also: '.filter-pop',
          waitFor: () => { const d = App.state.filters.dept, w = allButCreative(); return d.length === w.length && w.every(k => d.includes(k)); },
          showMe: () => { App.filterMenu.close(); App.state.filters.dept = allButCreative(); App.render(); } },
        { title: 'Open a task', text: 'Click any task bar to open it.',
          target: () => document.querySelector('.g-row.sub:not(.phase) .bar'),
          waitFor: modalOpen,
          showMe: () => {
            const b = document.querySelector('.g-row.sub:not(.phase) .bar[data-episode-id][data-su-key]');
            if (b) App.editTask.open(b.dataset.episodeId, b.dataset.suKey);
            else { const e = demoEps()[0]; const su = e && App.subitems(e)[0]; if (su) App.editTask.open(e.id, su.key); }
          } },
        { title: 'And back out', text: 'Everything about a task is here. Press Esc to close it.',
          target: '.modal-card', waitFor: () => !modalOpen(), showMe: () => App.modal.close() },

        // ---- producers: the show itself, notes, and the dates it's committed to ----
        { when: () => App.canManageShows(App.state.role), title: 'Shows', text: 'Shows (top right) is where productions are set up and changed. Open it.',
          target: '[data-guide="shows"]', waitFor: () => !!document.querySelector('.show-card'),
          showMe: () => App.showsBrowser.open() },
        { when: () => App.canManageShows(App.state.role), title: 'Open the show', text: () => 'Click “' + showName() + '”.',
          target: () => Array.from(document.querySelectorAll('.show-card')).find(c => c.textContent.includes(showName())),
          waitFor: () => !!document.querySelector('.show-edit-links'),
          showMe: () => App.editShowDialog.open(sandbox.showId, { back: () => App.showsBrowser.open() }) },
        { when: () => App.canManageShows(App.state.role), title: 'Changing the production',
          text: 'From here: the Team on each department, the Pipeline and episode schedule, Holidays and the working week, Export, a JSON backup, and Archive.',
          target: '.show-edit-links' },
        { when: () => App.canManageShows(App.state.role), title: 'Close it', text: 'Press Esc.',
          target: '.modal-card', waitFor: () => !modalOpen(), showMe: () => App.modal.close() },
        { when: () => App.canEditNotes(), title: 'Producer Notes', text: 'With a single show picked, this lane holds notes for the whole team — shoot days, holidays, heads-ups.',
          target: '.g-row.pn-head', also: '.g-row.pn-row',
          before: () => { if (!document.querySelector('.g-row.pn-head')) { App.state.filters.show = [sandbox.showId]; App.render(); } } },
        { when: () => App.canEditNotes(), title: 'Draw a note', text: 'Drag across the notes lane to draw a note over some days.',
          before: () => { const s = App.show(sandbox.showId); notes0 = (s && s.notes || []).length; },
          target: () => document.querySelector('.g-row.pn-row .g-track.pn-drawable'),
          waitFor: () => { const s = App.show(sandbox.showId); return (s && s.notes || []).length > notes0; },
          showMe: () => {
            const t = App.isoDate(App.today());
            const id = App.addNote(sandbox.showId, { text: '', start: t, due: App.isoDate(App.addDays(App.today(), 3)), color: '#f6be00' });
            requestAnimationFrame(() => {
              const n = document.querySelector('.pn-note[data-note-id="' + id + '"]');
              if (n) App.gantt.openNoteEditor(n);
            });
          } },
        { when: () => App.canEditNotes(), title: 'Name it', text: 'Give your note a name — type it in and press Enter.',
          target: () => document.querySelector('.pn-note-input') || document.querySelector('.g-row.pn-row'),
          waitFor: () => { const s = App.show(sandbox.showId); const n = s && s.notes && s.notes[s.notes.length - 1]; return !!(n && String(n.text || '').trim()); },
          showMe: () => {
            const s = App.show(sandbox.showId); const n = s && s.notes && s.notes[s.notes.length - 1];
            if (n) { App.gantt.closeNoteEditor && App.gantt.closeNoteEditor(); App.updateNote(sandbox.showId, n.id, { text: 'Ping pong table arrives' }); }
          } },
        { when: () => App.canManageShows(App.state.role), title: 'Delivery date', text: 'The D marks are each episode’s Delivery date. Click one.',
          before: () => { App.gantt.closeNoteEditor && App.gantt.closeNoteEditor(); },
          target: () => document.querySelector('.ms-day.ms-delivery_date'),
          waitFor: modalOpen,
          showMe: () => { const e = demoEps()[0]; if (e) App.milestoneDialog.open(e.id, 'delivery_date'); } },
        { when: () => App.canManageShows(App.state.role), title: 'Delivery date', text: 'This is the date the episode is committed to. Press Esc to close.',
          target: '.modal-card', waitFor: () => !modalOpen(), showMe: () => App.modal.close() },
        { when: () => App.canManageShows(App.state.role), title: 'Live date', text: 'And LD is when it goes Live. Click one.',
          target: () => document.querySelector('.ms-day.ms-' + App.LIVE_KEY),
          waitFor: modalOpen,
          showMe: () => { const e = demoEps()[0]; if (e) App.milestoneDialog.open(e.id, App.LIVE_KEY); } },
        { when: () => App.canManageShows(App.state.role), title: 'Live date', text: 'Press Esc to close.',
          target: '.modal-card', waitFor: () => !modalOpen(), showMe: () => App.modal.close() }
      ];
    },

    board: () => {
      const myDept = App.roleDept(App.state.role);
      const firstEpId = () => { const g = document.querySelector('.ep-group[data-ep-id]'); return g && g.dataset.epId; };
      const workspace = () => !sandbox.isBuiltIn() && App.masterPathSet && App.masterPathSet() &&
        !!(App.companion && (App.companion.usable() || !App.companion.wanted || !App.companion.wanted()));
      const wsBlock = (i) => () => document.querySelectorAll('.ws .ws-block')[i];
      const wsNames = [
        ['Project', 'Create or open the project file for this task, right from the production folder.'],
        ['Assets', 'Everything this task needs to work from.'],
        ['Review Uploads', 'Cuts sent for review, and their notes.'],
        ['Deliver', 'Hand your finished work on — it lands where the next department expects it.']
      ];
      return [
        { title: 'Task Board', text: 'Click Board — every episode as a list of its tasks.',
          target: tabSel('board'), waitFor: () => App.state.view === 'board', showMe: () => goView('board') },
        { title: 'Departments', text: () => myDept
            ? 'This shows every department. Tip: pick just ' + App.DEPARTMENTS[myDept].label + ' so the board is only your work.'
            : 'Filter the board to one or more departments here.',
          target: '.filter-multi[data-fkey="dept"]', also: '.filter-pop',
          next: 'Next',
          waitFor: myDept ? () => App.state.filters.dept.length === 1 && App.state.filters.dept[0] === myDept : null,
          showMe: myDept ? () => { App.filterMenu.close(); App.state.filters.dept = [myDept]; App.render(); } : null },
        { title: 'Open an episode', text: 'Click the first episode to open it.',
          target: () => document.querySelector('.ep-group[data-ep-id] .ep-row'),
          waitFor: () => { const id = firstEpId(); return !!(id && App.state.expanded[id]); },
          showMe: () => { const id = firstEpId(); if (id) { App.state.expanded[id] = true; App.render(); } } },
        { title: 'What’s it waiting on?', text: 'Stage is the department the episode is with now. Hover over it to see exactly what it’s waiting on.',
          target: () => document.querySelector('.stage-chip'), event: { type: 'mouseover', sel: '.stage-chip', delay: 1400 }, next: 'Next' },
        { title: 'One of yours', text: 'Click one of your tasks.',
          target: () => {
            const mine = App.state.user && App.state.user.personId;
            const rows = Array.from(document.querySelectorAll('.subtable .subrow:not(.head)'));
            const r = (mine && rows.find(x => x.textContent.includes((App.person(mine) || {}).name || '\u0000'))) || rows[0];
            return r && r.querySelector('.c-name');
          },
          waitFor: modalOpen,
          showMe: () => {
            const id = firstEpId(); const ep = id && App.state.data.episodes.find(e => e.id === id);
            const subs = ep ? App.subsView(ep) : [];
            const mine = App.state.user && App.state.user.personId;
            const su = subs.find(s => s.assignee === mine) || subs[0];
            if (su) App.editTask.open(ep.id, su.key);
          } },
        { when: workspace, title: 'Production Asset Manager', text: 'This is the Production Asset Manager — quick access to the production folders, so you can get to your work and deliver it without hunting.',
          target: '.ws' },
        ...wsNames.map(([name, blurb], i) => ({
          when: () => workspace() && !!wsBlock(i)(), title: name, text: blurb, target: wsBlock(i)
        })),
        { title: 'Close it', text: 'Press Esc to close the task.', target: '.modal-card', waitFor: () => !modalOpen(), showMe: () => App.modal.close() }
      ];
    },

    dashboard: () => [
      { title: 'Dashboard', text: 'Click Dashboard — your day at a glance.',
        target: tabSel('dashboard'), waitFor: () => App.state.view === 'dashboard', showMe: () => goView('dashboard') },
      { title: 'Make it yours', text: 'Edit lets you move, resize, add and remove widgets any time.', target: '.dash-tools' },
      { title: 'Pop it out', text: 'This opens a widget in its own window — handy on a second screen, or kept on top while you work in another app.',
        target: () => document.querySelector('.dw .dw-pop') }
    ],

    review: () => [
      { title: 'Reviews', text: 'Click Reviews — cuts waiting for notes and approval.',
        target: tabSel('review'), waitFor: () => App.state.view === 'review', showMe: () => goView('review') },
      { title: 'The review queue', text: 'Everything sent for review, most urgent first. Open one to watch it, leave notes, approve or send it back.', target: '#view' }
    ],

    resources: () => [
      { title: 'Resourcing', text: 'Click the Timeline tab.', when: () => App.state.view !== 'timeline',
        target: tabSel('timeline'), waitFor: () => App.state.view === 'timeline', showMe: () => goView('timeline') },
      { title: 'Resourcing', text: 'Switch to Resources to see who’s busy, department by department, week by week.',
        target: () => Array.from(document.querySelectorAll('#toolbar .toolbar-seg')).find(s => s.textContent.includes('Resources')),
        waitFor: () => App.timelineMode() === 'resources',
        showMe: () => { App.prefs.set('timelineMode', 'resources'); App.render(); } },
      { title: 'Workload', text: 'Each circle is a week’s workload. Click a person for their capacity and time off.', target: '#view' }
    ]
  };

  async function runTour() {
    if (App.isPhone()) return 'done';
    App.filterMenu && App.filterMenu.close && App.filterMenu.close();
    sandbox.enter();
    App.render();
    let result = 'done';
    try {
      const order = App.profile.tabOrder();
      const steps = [];
      order.forEach(k => { if (SECTIONS[k]) steps.push(...SECTIONS[k]()); });
      const live = steps.filter(s => !s.when || s.when());
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.when && !s.when()) continue;
        if (s.before) s.before();
        await sleep(120);
        const n = live.indexOf(s) + 1;
        const r = await coach.step(Object.assign({ progress: n ? n + ' / ' + live.length : '' }, s));
        if (r === 'end') { result = 'end'; break; }
        // a filter picked in a step is done with — don't leave its menu over the next one
        if (s.also === '.filter-pop') App.filterMenu.close();
        await sleep(150);
      }
    } finally {
      coach.close();
      await sandbox.exit();
    }
    return result;
  }

  /* ================================================================ FLOW */
  const fill = (s) => s.replace(/\{name\}/g, App.profile.displayName() || 'traveller');

  App.guide = {
    running: false,

    // first sign-in, or any day the setup was never finished
    maybeStart() {
      if (this.running) return;
      if (!App.state.data || !App.state.user) return;
      const p = App.profile.get();
      if (p && p.setupDone) return;
      setTimeout(() => this.start(), 400);
    },

    async start(opts) {
      if (this.running) return;
      opts = opts || {};
      this.running = true;
      App.prefsMenu && App.prefsMenu.close();
      try { await this._run(opts); }
      catch (e) { console.error('guide', e); }
      finally {
        IF.close(); coach.close();
        if (App.state.sandbox) await sandbox.exit();
        this.running = false;
        App.render();
      }
    },

    async _run(opts) {
      const redo = !!opts.redo;
      const prof = App.profile.get() || {};
      const cfg = App.guideConfig();
      const pick = {
        name: prof.name || App.profile.displayName(),
        theme: App.prefs.get('theme', prof.theme || 'midnight'),
        character: prof.character || '',
        tabOrder: App.profile.hasOrder() ? App.profile.tabOrder() : null
      };
      const themeBefore = App.prefs.get('theme', 'midnight');
      const save = (extra) => {
        if (App.state.user && pick.name) App.state.user.name = pick.name;
        App.profile.set(Object.assign({
          name: pick.name, character: pick.character || (cfg.mascots[0] && cfg.mascots[0].emoji),
          theme: pick.theme, tabOrder: pick.tabOrder || App.profile.tabOrder()
        }, extra || {}));
      };
      const today = App.isoDate(App.today());
      const phone = App.isPhone();

      IF.open();
      IF.setMascot(pick.character);
      const mascotLabel = (emoji) => { const m = cfg.mascots.find(x => x.emoji === emoji); return (m && m.label) || 'PipeDream'; };
      if (pick.character) IF.setSpeaker(mascotLabel(pick.character));
      IF.setClap(pick.name);
      if (pick.tabOrder) IF.setNotes(pick.tabOrder.map(k => PRIORITY_TABS.find(t => t.key === k).label));
      const TOTAL = phone ? 6 : 9;

      const quit = async () => {
        IF.clear();
        await IF.type('Leave setup? Whatever you’ve chosen so far is kept.');
        const r = await IF.choose([{ label: 'Yes, let me in', value: 'yes' }, { label: 'No, keep going', value: 'no' }]);
        return r.value === 'yes' || r.nav === 'quit';
      };

      // ---- steps 1–6 on the text-adventure screen ----
      const steps = [
        async () => {
          IF.setStep(1, TOTAL); IF.clear(); IF.focus('');
          await IF.type(redo ? 'You’re back. Let’s change a few things.' : fill(cfg.welcome));
          return IF.choose([{ label: redo ? 'Change my setup' : 'Begin', value: 'go' }]);
        },
        async () => {
          IF.setStep(2, TOTAL); IF.clear(); IF.focus('timeline');
          await IF.type('PipeDream tracks every episode of every show, from kick off to delivery.');
          await IF.type('Each episode is a chain of tasks passed between departments — Creative, Music, Animation, Audio, Video, Post Ops and QC. ' +
            'When yours is done, the next department can start. Everyone sees the same board, live.');
          return IF.choose([{ label: 'Got it', value: 'go' }], { back: true });
        },
        async () => {
          IF.setStep(3, TOTAL); IF.clear(); IF.focus('clapper');
          await IF.type('Every production needs a name on the clapperboard. What would you like to be called?');
          const r = await IF.ask('', pick.name, { back: true, onInput: (v) => IF.setClap(v) });
          if (r.value) pick.name = r.value;
          IF.setClap(pick.name);
          return r;
        },
        async () => {
          IF.setStep(4, TOTAL); IF.clear(); IF.focus('monitor'); IF.peek(true);
          await IF.type('Nice to meet you, ' + pick.name + '! Now, how should your screens look? Move through the list — the monitor on the right shows each one.');
          const r = await IF.choose(App.THEMES.map(t => ({ label: t.label, value: t.v })), {
            back: true, current: pick.theme,
            onFocus: (v) => { App.prefs.set('theme', v); App.applyTheme(); App.render(); }
          });
          IF.peek(false);
          if (r.value) pick.theme = r.value;
          App.prefs.set('theme', pick.theme); App.applyTheme(); App.render();
          return r;
        },
        async () => {
          IF.setStep(5, TOTAL); IF.clear(); IF.focus('mascot');
          await IF.type('Something rustles behind the monitors… a little companion wants to keep you company on the desk. Who’ll it be?');
          const r = await IF.choose(cfg.mascots.map(m => ({ label: m.emoji + '  ' + (m.label || ''), value: m.emoji })), {
            back: true, current: pick.character,
            onFocus: (v) => { IF.setMascot(v); IF.setSpeaker(mascotLabel(v)); }
          });
          if (r.value) pick.character = r.value;
          if (!pick.character) pick.character = cfg.mascots[0] && cfg.mascots[0].emoji;
          IF.setMascot(pick.character);
          IF.setSpeaker(mascotLabel(pick.character));
          if (r.value) sayFrom(IF.mascotEl, 'Hi, ' + pick.name + '!');
          return r;
        },
        async () => {
          IF.setStep(6, TOTAL); IF.clear(); IF.focus('calendar');
          await IF.type('Let’s plan your mornings. Which do you check first each day? I’ll pin them to the board in order.');
          const order = [];
          const pin = () => IF.setNotes(order.map(k => PRIORITY_TABS.find(t => t.key === k).label));
          pin();
          let left = availableTabs();
          while (left.length > 1) {
            const r = await IF.choose(left.map(t => ({ label: t.label, value: t.key, hint: t.blurb })), { back: true });
            if (r.nav === 'back') {
              if (!order.length) return r;
              left = availableTabs().filter(t => !order.slice(0, -1).includes(t.key));
              order.pop();
              pin();
              continue;
            }
            if (r.nav === 'skip') { order.push(...left.map(t => t.key)); left = []; break; }
            if (r.nav === 'quit') return r;
            order.push(r.value);
            pin();
            left = left.filter(t => t.key !== r.value);
            if (left.length > 1) { IF.clear(); await IF.type('And next?'); }
          }
          order.push(...left.map(t => t.key));
          pin();
          pick.tabOrder = order;
          IF.clear();
          await IF.type('All pinned up: ' + order.map(k => PRIORITY_TABS.find(t => t.key === k).label).join(' → ') + '. Your tabs will sit in this order too.');
          await sleep(700);
          await sleep(500);
          return { value: 'ok' };
        }
      ];

      let i = 0;
      while (i < steps.length) {
        const r = await steps[i]();
        if (r && r.nav === 'back') { i = Math.max(0, i - 1); continue; }
        if (r && r.nav === 'quit') {
          if (await quit()) { save({ setupDone: prof.setupDone || today }); App.render(); return; }
          continue;
        }
        save();
        i++;
      }
      save();
      if (pick.theme !== themeBefore) App.toast('Theme set to ' + ((App.THEMES.find(t => t.v === pick.theme) || {}).label || pick.theme));
      // the new tab order shows straight away
      App.render();

      if (phone) {
        IF.clear();
        await IF.type(fill('All set, {name}. The full tour lives on a bigger screen — open the app on a computer and pick “Redo Setup Wizard” from settings to take it.'));
        await IF.choose([{ label: 'Let me in', value: 'go' }]);
        IF.close();
        save({ setupDone: today });
        App.profile.applyStart();
        App.render();
        return;
      }

      // ---- step 7: the dashboard, built by hand ----
      IF.setStep(7, TOTAL); IF.clear(); IF.focus('');
      let wantDash = true;
      if (redo) {
        await IF.type('Rebuild your dashboard from scratch?');
        const r = await IF.choose([{ label: 'Yes — start me with an empty one', value: 'yes' }, { label: 'No, keep it as it is', value: 'no' }]);
        wantDash = r.value === 'yes';
      } else {
        await IF.type('Next, your Dashboard. It’s empty — you choose what goes on it.');
        await IF.choose([{ label: 'Show me', value: 'go' }]);
      }
      IF.close();
      if (wantDash) {
        App.state.view = 'dashboard';
        App.dashboard.clearForSetup();
        await sleep(200);
        const r1 = await coach.step({
          title: 'Build your dashboard', progress: '7 / ' + TOTAL,
          text: 'Drag widgets from the tray onto the dashboard, then drag their edges to size them. Add as many as you like, then press ✓ Done.',
          target: '.dash-tray', also: () => document.querySelectorAll('.dash-grid, .dash-tools'),
          waitFor: () => !App.dashboard._editing, waitLabel: 'Press ✓ Done when you’re happy.',
          showMe: () => { App.dashboard.restoreDefault(); }
        });
        if (r1 !== 'end') {
          await sleep(200);
          const pop = await coach.step({
            title: 'Its own window', progress: '7 / ' + TOTAL,
            text: 'This button opens a widget in a window of its own — keep the Journal or your priorities on a second screen, or on top while you work in another app.',
            target: () => document.querySelector('.dw .dw-pop')
          });
          void pop;
        }
        coach.close();
      }

      // ---- step 8: the tour ----
      IF.open(); IF.setMascot(pick.character); IF.setSpeaker(mascotLabel(pick.character)); IF.setStep(8, TOTAL);
      IF.setClap(pick.name); IF.setNotes(App.profile.tabOrder().map(k => (PRIORITY_TABS.find(t => t.key === k) || {}).label || k)); IF.focus('reel');
      await IF.type(redo ? 'Take the tour again?' : 'Last thing: a quick tour of each tab, in the order you picked. It’s a sandbox — nothing you do in it is saved.');
      const t = await IF.choose([{ label: 'Take the tour', value: 'go' }, { label: redo ? 'No thanks' : 'Not now', value: 'no' }]);
      IF.close();
      let tourResult = 'skipped';
      if (t.value === 'go') tourResult = await runTour();

      // ---- step 9: home, and the first page of the journal ----
      App.state.view = 'dashboard';
      save({ setupDone: prof.setupDone || today, tourDone: tourResult === 'done' ? today : (prof.tourDone || null) });
      if (!redo || t.value === 'go') App.journal.addNote(escHtml(fill(cfg.completion)));
      App.render();
      await sleep(250);
      await coach.step({
        title: 'Setup complete', progress: '9 / ' + TOTAL,
        text: fill(cfg.completion),
        target: () => document.querySelector('.dw[data-wid="journal"]') || document.querySelector('.dash-hello'),
        next: 'Finish'
      });
      coach.close();
    }
  };
})();
