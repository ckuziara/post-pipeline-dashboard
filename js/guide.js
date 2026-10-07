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
  // the chart (and the page) back to the top — the Producer Notes lane lives there
  const toTop = () => {
    const v = document.getElementById('view'), sc = document.querySelector('.gantt-scroll');
    if (v) v.scrollTop = 0;
    if (sc) sc.scrollTop = 0;
  };
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
      this.stageReviews(3);
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
    isBuiltIn() { return this.showId === DEMO_ID; },

    /* The Reviews tab should have something on it: make sure the tour's show
       has `n` cuts sitting in review — tasks already under way around today,
       set to Ready for Review with a (pretend) Frame.io link, as if Post
       Operations had sent them on to the Director. Sandbox data only. */
    stageReviews(n) {
      const d = App.state.data, today = App.isoDate(App.today());
      const eps = d.episodes.filter(e => e.showId === this.showId);
      const sent = (e, k) => App.review && App.review.sent(e.id, k);
      let have = 0;
      eps.forEach(e => App.subitems(e).forEach(su => { if (su.status === 'review' && sent(e, su.key)) have++; }));
      const cands = [];
      eps.forEach(e => App.subitems(e).forEach(su => {
        if (su.status === 'approved' || (su.status === 'review' && sent(e, su.key))) return;
        if (su.start > today) return;
        cands.push({ e, su, gap: Math.abs(App.diffDays(su.due, today)) });
      }));
      cands.sort((a, b) => a.gap - b.gap);
      d.reviews = d.reviews || {};
      cands.slice(0, Math.max(0, n - have)).forEach(({ e, su }, i) => {
        e.statuses = Object.assign({}, e.statuses, { [su.key]: 'review' });
        d.reviews[e.id + '::' + su.key] = {
          state: 'sent', frameUrl: 'https://f.io/pipedream-demo-' + (i + 1),
          sentAt: new Date().toISOString(), sentBy: 'Post Operations'
        };
      });
    }
  };
  App.guideSandbox = sandbox;

  /* ------------------------------------------------------------ skip, reluctantly
     Skip doesn't skip the first time it's pressed: the mascot pops up and
     asks whether you're sure. The second press on the same step really
     skips. The button itself stays put, where it can always be reached. */
  function reluctantSkip(btn, sayFn, onSkip) {
    let tries = 0;
    const press = () => {
      if (tries++ > 0) { onSkip(); return; }
      btn.classList.add('gd-sure');
      sayFn('Are you sure about that?');
    };
    return { press, reset() { tries = 0; btn.classList.remove('gd-sure'); } };
  }

  /* ------------------------------------------------------------ mascot speech */
  function sayFrom(mascotEl, text) {
    if (!mascotEl || !mascotEl.isConnected) return;
    const old = mascotEl.querySelector('.gd-mascot-say');
    if (old) old.remove();
    const b = el('.gd-mascot-say', null, text);
    if (mascotEl.dataset.from === 'bottom' || mascotEl.getBoundingClientRect().top < 70) b.classList.add('below');
    mascotEl.appendChild(b);
    setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 300); }, 2500);
  }

  /* The themes from lightest to darkest, by how bright each one's page
     background actually is — read by trying each theme on the root for a
     moment (no paint happens in between) and measuring --bg. */
  function themesByBrightness() {
    const root = document.documentElement;
    const keep = ['data-theme', 'data-mode', 'data-skin'].map(a => [a, root.getAttribute(a)]);
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const ctx = cv.getContext('2d');
    const lum = (css) => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#808080'; ctx.fillStyle = css || '#808080'; ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return { l: 0.2126 * r + 0.7152 * g + 0.0722 * b, rgb: 'rgb(' + r + ',' + g + ',' + b + ')' };
    };
    const out = App.THEMES.map(t => {
      root.setAttribute('data-theme', t.v);
      root.setAttribute('data-mode', t.mode || 'dark');
      if (t.skin) root.setAttribute('data-skin', t.skin); else root.removeAttribute('data-skin');
      const m = lum(getComputedStyle(root).getPropertyValue('--bg').trim());
      return { t, bg: m.rgb, l: m.l };
    });
    keep.forEach(([a, v]) => { if (v == null) root.removeAttribute(a); else root.setAttribute(a, v); });
    return out.sort((a, b) => b.l - a.l);
  }
  /* The light end is where everyone starts; the dark end is earned. Each
     title belongs to a level, not a slot, so adding or removing a theme
     moves the stops without renaming them: a stop takes the title of the
     highest level at or below its own. */
  const RANKS = [
    [1, 'Producer'], [10, 'Runner'], [20, 'Intern'], [30, 'Boom Op'], [40, 'Assistant Editor'],
    [50, 'Editor'], [60, 'Colourist'], [70, 'Sound Wizard'], [80, 'Post Supervisor'],
    [90, 'Director'], [100, 'Film Goat']
  ];
  const levelFor = (i, n) => {
    // Lv. 1 at the light end, then even steps up to Lv. 100 (10, 20, 30… with 11 themes)
    const lv = i === 0 ? 1 : Math.round((n > 1 ? i / (n - 1) : 1) * 100);
    const r = RANKS.filter(x => x[0] <= lv).pop();
    return 'Lv. ' + lv + ' ' + r[1];
  };

  /* The slider's two ends, in the scene's own hand: a studio lamp blazing at
     the bright end, a projector rolling at the dark end. */
  const LAMP = `<svg viewBox="0 0 48 48" class="sc-o"><path d="M27 21 L44 13 L44 39 L27 31 Z" fill="#ffe27a" stroke="none" opacity=".75"/>
    <path d="M17 32 L11 43 M17 32 L23 43 M17 32 V43" fill="none"/>
    <path d="M10 26 Q17 34 24 26" fill="none"/>
    <rect x="7" y="16" width="16" height="14" rx="3" fill="#5d6fd6"/>
    <ellipse cx="25" cy="23" rx="3.5" ry="8.5" fill="#fffaf0"/>
    <path d="M11 13 L14 16 M16 12 V16" fill="none"/></svg>`;
  const PROJECTOR = `<svg viewBox="0 0 48 48" class="sc-o"><path d="M30 27 L44 21 L44 37 Z" fill="#fff3b0" stroke="none" opacity=".55"/>
    <circle cx="14" cy="15" r="6" fill="#7d84c9"/><circle cx="26" cy="15" r="6" fill="#7d84c9"/>
    <rect x="8" y="22" width="22" height="13" rx="3" fill="#b9bde6"/>
    <rect x="30" y="25" width="4" height="7" rx="1" fill="#ffd166"/>
    <path d="M12 35 L10 41 M26 35 L28 41" fill="none"/></svg>`;
  const endIcon = (svg, title) => { const n = el('span.if-end', { title }); n.innerHTML = svg; return n; };

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
    <rect x="-20" y="-20" width="1960" height="720" fill="#f4ecd6" stroke="none"/>
    <path d="M-20 700 H1940 V920 H-20Z" fill="#e3c99b"/>
    <path d="M-20 700 H1940" />
    <g stroke-width="3" opacity=".35"><path d="M120 760 H520 M700 800 H1180 M1300 750 H1600 M60 860 H400 M880 870 H1400"/></g>
    <path d="M-20 640 H1940" stroke-width="3" opacity=".25"/>

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
    <g id="sc-clock" transform="translate(720 200)">
      <circle r="64" fill="#fffaf0"/>
      <circle r="51" fill="none" stroke-width="3" opacity=".3"/>
      <path d="M0 0 L0 -32" transform="rotate(${hA})" stroke-width="7"/>
      <path d="M0 0 L0 -45" transform="rotate(${mA})" stroke-width="4"/>
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
      <!-- a miniature of the app, no words: just its layout in the theme's colours -->
      <g class="sc-theme">
        <rect x="1236" y="306" width="268" height="158" rx="6" style="fill:var(--bg)" stroke-width="3"/>
        <rect x="1237.5" y="307.5" width="265" height="15" rx="5" style="fill:var(--bg-2)" stroke="none"/>
        <rect x="1242" y="311" width="8" height="8" rx="2" style="fill:var(--accent)" stroke="none"/>
        <rect x="1256" y="312" width="20" height="6" rx="3" style="fill:var(--accent)" stroke="none"/>
        <rect x="1280" y="312" width="18" height="6" rx="3" style="fill:var(--surface-2)" stroke="none"/>
        <rect x="1302" y="312" width="20" height="6" rx="3" style="fill:var(--surface-2)" stroke="none"/>
        <rect x="1326" y="312" width="16" height="6" rx="3" style="fill:var(--surface-2)" stroke="none"/>
        <rect x="1346" y="312" width="18" height="6" rx="3" style="fill:var(--surface-2)" stroke="none"/>
        <circle cx="1494" cy="315" r="4" style="fill:var(--accent-2)" stroke="none"/>
        <rect x="1242" y="327" width="30" height="7" rx="3.5" style="fill:var(--surface)" stroke="none"/>
        <rect x="1276" y="327" width="30" height="7" rx="3.5" style="fill:var(--surface)" stroke="none"/>
        <rect x="1310" y="327" width="30" height="7" rx="3.5" style="fill:var(--surface)" stroke="none"/>
        <rect x="1346" y="327" width="64" height="7" rx="3.5" style="fill:var(--surface)" stroke="none"/>
        <rect x="1470" y="327" width="28" height="7" rx="3.5" style="fill:var(--accent)" stroke="none"/>
        <rect x="1242" y="339" width="44" height="9" rx="2.5" style="fill:var(--surface)" stroke="none"/>
        <rect x="1242" y="339" width="3" height="9" rx="1.5" style="fill:var(--st-approved)" stroke="none"/>
        <rect x="1250" y="342" width="18" height="3" rx="1.5" style="fill:var(--text-3)" stroke="none"/>
        <rect x="1290" y="339" width="44" height="9" rx="2.5" style="fill:var(--surface)" stroke="none"/>
        <rect x="1290" y="339" width="3" height="9" rx="1.5" style="fill:var(--accent-2)" stroke="none"/>
        <rect x="1298" y="342" width="18" height="3" rx="1.5" style="fill:var(--text-3)" stroke="none"/>
        <rect x="1338" y="339" width="44" height="9" rx="2.5" style="fill:var(--surface)" stroke="none"/>
        <rect x="1338" y="339" width="3" height="9" rx="1.5" style="fill:var(--st-review)" stroke="none"/>
        <rect x="1346" y="342" width="18" height="3" rx="1.5" style="fill:var(--text-3)" stroke="none"/>
        <rect x="1386" y="339" width="44" height="9" rx="2.5" style="fill:var(--surface)" stroke="none"/>
        <rect x="1386" y="339" width="3" height="9" rx="1.5" style="fill:var(--danger)" stroke="none"/>
        <rect x="1394" y="342" width="18" height="3" rx="1.5" style="fill:var(--text-3)" stroke="none"/>
        <rect x="1242" y="353" width="256" height="106" rx="4" style="fill:var(--surface)" stroke="none"/>
        <rect x="1242" y="353" width="256" height="9" rx="4" style="fill:var(--surface-2)" stroke="none"/>
        <rect x="1248" y="368" width="30" height="4" rx="2" style="fill:var(--text-3)" stroke="none"/>
        <rect x="1242" y="377" width="256" height="14" style="fill:var(--row-alt)" stroke="none"/>
        <rect x="1248" y="382" width="24" height="4" rx="2" style="fill:var(--text-3)" stroke="none"/>
        <rect x="1248" y="396" width="18" height="4" rx="2" style="fill:var(--text-3)" stroke="none"/>
        <rect x="1242" y="405" width="256" height="14" style="fill:var(--row-alt)" stroke="none"/>
        <rect x="1248" y="410" width="30" height="4" rx="2" style="fill:var(--text-3)" stroke="none"/>
        <rect x="1248" y="424" width="24" height="4" rx="2" style="fill:var(--text-3)" stroke="none"/>
        <rect x="1242" y="433" width="256" height="14" style="fill:var(--row-alt)" stroke="none"/>
        <rect x="1248" y="438" width="18" height="4" rx="2" style="fill:var(--text-3)" stroke="none"/>
        <rect x="1310" y="362" width="1" height="96" style="fill:var(--border)" stroke="none"/>
        <rect x="1340" y="362" width="1" height="96" style="fill:var(--border)" stroke="none"/>
        <rect x="1370" y="362" width="1" height="96" style="fill:var(--border)" stroke="none"/>
        <rect x="1400" y="362" width="1" height="96" style="fill:var(--border)" stroke="none"/>
        <rect x="1430" y="362" width="1" height="96" style="fill:var(--border)" stroke="none"/>
        <rect x="1460" y="362" width="1" height="96" style="fill:var(--border)" stroke="none"/>
        <rect x="1490" y="362" width="1" height="96" style="fill:var(--border)" stroke="none"/>
        <rect x="1300" y="366" width="60" height="7" rx="3.5" style="fill:var(--st-approved)" stroke="none"/>
        <rect x="1330" y="380" width="70" height="7" rx="3.5" style="fill:var(--accent-2)" stroke="none"/>
        <rect x="1360" y="394" width="55" height="7" rx="3.5" style="fill:var(--st-review)" stroke="none"/>
        <rect x="1310" y="408" width="40" height="7" rx="3.5" style="fill:var(--st-ready)" stroke="none"/>
        <rect x="1390" y="422" width="80" height="7" rx="3.5" style="fill:var(--accent)" stroke="none"/>
        <rect x="1420" y="436" width="50" height="7" rx="3.5" style="fill:var(--text-3)" stroke="none"/>
        <rect x="1378" y="362" width="1.5" height="96" style="fill:var(--danger)" stroke="none"/>
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

    <!-- ivy trailing down from the ceiling on the right; some of it hangs
         just past the frame, where the camera push on the monitor finds it -->
    ${ivySVG()}
  </g>
</svg>`;
  }

  /* Hanging vines in the manner of a wandering-dude (tradescantia): pointed
     leaves with a dark green rim, a pale silvery band, and a green stripe
     down the middle, drooping on short stalks from a thin, wavy stem. Each
     vine sways gently from the top. */
  function ivySVG() {
    const vines = [[1548, 470, 0], [1590, 640, 1.3], [1632, 420, 2.1], [1676, 590, .6], [1724, 380, 1.8], [1768, 520, 2.7]];
    /* Leaf kinds, so the vines aren't one stamp repeated: [rim, band, stripe,
       width]. Softer than black-and-white — the band is a pale sage, not
       paper, and the outline is a deep green rather than the scene's ink. */
    const KINDS = [
      ['#5f9a57', '#d3e6c6', '#76b066', 1],     // variegated, the classic
      ['#6aa65e', '#b9d9a8', '#7dba6c', .85],   // softer, mostly green
      ['#78b468', '#cfe7bd', '#8cc37a', 1.1],   // young and light
      ['#568f50', '#a9cf98', '#6aa65e', .7],    // slim and plain
      ['#6aa65e', '#e0eed5', '#82bb70', .95]    // pale-banded
    ];
    const leaf = (x, y, side, k) => {
      const [rim, band, stripe, wide] = KINDS[(k * 3 + (k >> 2)) % KINDS.length];
      const tilt = 28 + (k * 17) % 30;                      // droops 28–58° below level
      const rot = side > 0 ? tilt : 180 - tilt;
      const sc = (0.8 + ((k * 7) % 5) * 0.09).toFixed(2);    // a little variety in size
      const w = (n) => (n * wide).toFixed(1);
      return `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${sc})">` +
        `<path d="M0 0 H6" fill="none" style="stroke:#6aa65e;stroke-width:2.5"/>` +
        `<path d="M6 0 C 12 -${w(11)}, 28 -${w(12)}, 38 0 C 28 ${w(12)}, 12 ${w(11)}, 6 0Z" fill="${rim}" style="stroke:#3f6e3b;stroke-width:2"/>` +
        `<path d="M10 0 C 15 -${w(7)}, 27 -${w(7.5)}, 33 0 C 27 ${w(7.5)}, 15 ${w(7)}, 10 0Z" fill="${band}" stroke="none"/>` +
        `<path d="M12 0 C 17 -${w(2.6)}, 26 -${w(2.6)}, 31 0 C 26 ${w(2.6)}, 17 ${w(2.6)}, 12 0Z" fill="${stripe}" stroke="none"/>` +
        `</g>`;
    };
    return '<g id="sc-ivy">' + vines.map(([x0, len, ph], vi) => {
      let d = `M${x0} -10`, leaves = '';
      for (let y = 0, k = 0; y <= len; y += 26, k++) {
        const x = x0 + Math.sin(y / 60 + ph) * 11;
        d += ` L${x.toFixed(1)} ${y}`;
        if (y > 16) leaves += leaf(x, y, (k + vi) % 2 ? 1 : -1, k + vi * 3);
      }
      // the stem's tip curls off below the last leaf
      d += ` q 10 18 -2 26`;
      return `<g class="sc-vine" style="animation-delay:-${(ph * 1.7).toFixed(1)}s"><path d="${d}" fill="none" style="stroke:#6aa65e;stroke-width:3"/>${leaves}</g>`;
    }).join('') + '<path d="M1520 -4 H1800" stroke-width="10"/></g>';
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
      this.nameTag = el('.if-tag');
      this.log = el('.if-log');
      this.input = el('.if-input');
      this.foot = el('.if-foot');
      // a second hiding place, behind the dialog box's top edge — used while
      // the camera's pushed in and the monitor's out of shot
      this.boxMascot = el('.if-box-mascot');
      this.boxSay = el('.if-box-say');
      const box = el('.if-box', null, [this.nameTag, el('.if-box-peek', null, this.boxMascot), this.boxSay, this.log, this.input, this.foot]);
      // the companion hides behind the timeline monitor: this box's bottom
      // edge is the monitor's top edge, so whatever's below it isn't drawn
      stage.appendChild(el('.if-mascot-clip', null, this.mascotEl));
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
    // a film strip of frames across the top: one per step, the done ones exposed
    setStep(n, total) {
      if (!this.stepEl) return;
      this.stepEl.innerHTML = '';
      for (let i = 1; i <= total; i++) this.stepEl.appendChild(el('span.if-frame' + (i < n ? '.done' : i === n ? '.now' : ''), null, String(i)));
    },
    // which prop in the scene is being talked about: it wiggles
    focus(id) { if (this.root) this.root.dataset.focus = id || ''; },
    // a slow camera push in on one prop ('monitor'), or back out ('')
    zoom(id) { if (this.root) this.root.dataset.zoom = id || ''; },
    setSpeaker(name) {
      const t = this.nameTag;
      if (!t || t.textContent === (name || '')) return;
      t.textContent = name || '';
      t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop');
    },
    setClap(name) {
      const t = this.root && this.root.querySelector('#sc-clap-name');
      if (t) t.textContent = 'DIR: ' + (String(name || '?').slice(0, 14) || '?');
    },
    // the tab priorities, pinned to the schedule board in order
    setNotes(labels, still) {
      const g = this.root && this.root.querySelector('#sc-notes');
      if (!g) return;
      still = still || 0;
      const colors = ['#fff3a3', '#ffc9d6', '#c9e8ff', '#d4f5c4', '#e6d4ff'];
      g.innerHTML = (labels || []).map((l, i) => {
        const x = 124 + (i % 3) * 132, y = 146 + Math.floor(i / 3) * 106, r = (i % 2 ? 4 : -3);
        const words = l.split(' ');
        return `<g transform="rotate(${r} ${x + 60} ${y + 46})" class="sc-note${i < still ? ' still' : ''}">
          <rect x="${x}" y="${y}" width="122" height="92" rx="6" fill="${colors[i % colors.length]}" stroke="#2b2b2b" stroke-width="3"/>
          <circle cx="${x + 61}" cy="${y + 8}" r="6" fill="#e85d5d" stroke="#2b2b2b" stroke-width="2"/>
          <text x="${x + 61}" y="${y + 36}" class="sc-t" font-size="16" text-anchor="middle">${i + 1}</text>
          ${words.map((w, j) => `<text x="${x + 61}" y="${y + 58 + j * 19}" class="sc-t" font-size="15" text-anchor="middle">${escHtml(w)}</text>`).join('')}
        </g>`;
      }).join('');
    },
    // nobody's on the desk until a companion is chosen (step 5)
    // where note i sits on the board, on screen — for cards to fly to
    noteSlot(i) {
      const svg = this.root && this.root.querySelector('.if-svg');
      if (!svg) return null;
      const x = 124 + (i % 3) * 132, y = 146 + Math.floor(i / 3) * 106;
      const m = svg.getScreenCTM();
      const p = (px, py) => new DOMPoint(px, py).matrixTransform(m);
      const a = p(x, y), b = p(x + 122, y + 92);
      return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y, rot: i % 2 ? 4 : -3 };
    },
    /* "Pin them up": each card flies from the dialog to its slot on the board,
       in order, and is pinned there as it lands. */
    async pinCards(cards, labels) {
      const fl = [];
      cards.forEach(c => { c.style.visibility = 'hidden'; });
      await Promise.all(cards.map((c, i) => new Promise(res => {
        setTimeout(() => {
          const from = c.getBoundingClientRect(), to = this.noteSlot(i);
          if (!to || !this.root) { res(); return; }
          const f = c.cloneNode(true);
          f.classList.add('if-card-fly');
          f.style.visibility = '';
          Object.assign(f.style, { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px' });
          this.root.appendChild(f); fl.push(f);
          const dx = to.left + to.width / 2 - (from.left + from.width / 2);
          const dy = to.top + to.height / 2 - (from.top + from.height / 2);
          const sc = Math.min(to.width / from.width, to.height / from.height);
          const anim = f.animate([
            { transform: 'translate(0,0) rotate(0deg) scale(1)' },
            { transform: `translate(${dx * .55}px, ${dy * .55 - 60}px) rotate(${to.rot * -3}deg) scale(${(1 + sc) / 2 * 1.08})`, offset: .55 },
            { transform: `translate(${dx}px, ${dy}px) rotate(${to.rot}deg) scale(${sc})` }
          ], { duration: 650, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'forwards' });
          // the card IS the note now — it lands in place, so no second entrance
          anim.onfinish = () => { this.setNotes(labels.slice(0, i + 1), i + 1); f.remove(); res(); };
        }, i * 160);
      })));
      fl.forEach(f => f.remove());
    },

    /* Surprise! The companion pops up from behind the monitor, then floats
       out in front of the screen and hovers there. Changing to another one
       tucks the current one back behind first; quick changes (hovering along
       the row) only ever show the latest. */
    setMascot(emoji) {
      const m = this.mascotEl;
      if (!m) return;
      if (emoji !== '🎬' && this._standIn) { this._standIn = false; clearTimeout(this._standInOff); }
      const clip = m.parentNode;
      clearTimeout(this._duck); clearTimeout(this._float);
      const keep = () => m.querySelector('.gd-mascot-say');
      const show = () => {
        const b = keep();
        m.textContent = emoji;
        if (b) m.appendChild(b);
        clip.classList.remove('front');
        m.classList.remove('duck', 'up', 'float'); void m.offsetWidth; m.classList.add('on', 'up');
        // once it's all the way up (nothing left behind the screen), it comes out front
        this._float = setTimeout(() => { clip.classList.add('front'); m.classList.remove('up'); m.classList.add('float'); }, 560);
      };
      const tuck = () => { clip.classList.remove('front'); m.classList.remove('up', 'float'); m.classList.add('duck'); };
      if (!emoji) { tuck(); this._duck = setTimeout(() => { m.textContent = ''; m.classList.remove('on'); }, 200); return; }
      if (m.classList.contains('on') && m.firstChild && m.firstChild.nodeValue !== emoji) {
        tuck();
        this._duck = setTimeout(show, 170);
      } else if (!m.classList.contains('on') || m.firstChild.nodeValue !== emoji) show();
    },
    /* The companion says something from on top of the monitor. Before one's
       been chosen, a stand-in from the crew (🎬) pops up to say it, then
       ducks back down. */
    sayAsMascot(text) {
      const m = this.mascotEl;
      if (!m) return;
      if (this.root && this.root.dataset.zoom) {
        // zoomed in: pop up from behind the dialog box instead
        const bm = this.boxMascot;
        const chosen = m.classList.contains('on') && !this._standIn && m.firstChild ? m.firstChild.nodeValue : '';
        clearTimeout(this._boxOff);
        bm.textContent = chosen || '🎬';
        bm.classList.remove('up'); void bm.offsetWidth; bm.classList.add('up');
        setTimeout(() => sayFrom(this.boxSay, text), 450);
        this._boxOff = setTimeout(() => bm.classList.remove('up'), 3200);
        return;
      }
      if (m.classList.contains('on') && !this._standIn) { sayFrom(m, text); return; }
      clearTimeout(this._standInOff);
      if (!this._standIn) { this._standIn = true; this.setMascot('🎬'); }
      setTimeout(() => sayFrom(m, text), m.parentNode.classList.contains('front') ? 0 : 600);
      this._standInOff = setTimeout(() => { if (this._standIn) { this._standIn = false; this.setMascot(''); } }, 3400);
    },
    // a new line of dialogue: the old answers and menu bar go with the old question
    clear() { if (this.log) this.log.innerHTML = ''; if (this.input) this.input.innerHTML = ''; if (this.foot) this.foot.innerHTML = ''; },

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
      const rs = reluctantSkip(skipBtn, (t) => this.sayAsMascot(t), onSkip);
      skipBtn.onclick = () => rs.press();
      this.foot.appendChild(el('button.if-key' + (back ? '' : '.off'), { title: 'B', onclick: back ? onBack : null }, '« BACK'));
      this.foot.appendChild(skipBtn);
      this.foot.appendChild(el('button.if-key', { title: 'Esc', onclick: onQuit }, 'QUIT »'));
      return rs;
    },

    /* Pick one of `options` ([{label, value, hint, face}]), shown as numbered
       pills — or, with opts.faces, as a row of big faces and nothing else
       (each option's `face`), which react as they're hovered. onFocus fires
       as the highlight moves (the theme and character steps preview with it). */
    choose(options, opts) {
      opts = opts || {};
      return new Promise(resolve => {
        const cur = options.findIndex(o => o.value === opts.current);
        // faces start with nobody picked out, so nobody's name shows until hovered
        let idx = opts.faces ? cur : Math.max(0, cur);
        this.input.innerHTML = '';
        const list = el(opts.faces ? '.if-faces' : '.if-choices' + (options.length > 6 ? '.many' : ''));
        const rows = options.map((o, i) => opts.faces
          ? el('button.if-face.react-' + (i % 4), {
              title: String(i + 1), onclick: () => done({ value: o.value }), onmouseenter: () => focus(i)
            }, el('span.if-face-emoji', null, o.face))
          : el('button.if-choice', {
              onclick: () => done({ value: o.value }), onmouseenter: () => focus(i)
            }, [el('span.if-num', null, String(i + 1)), el('span.if-lbl', null, [o.label, o.hint ? el('span.if-hint', null, o.hint) : null])]));
        rows.forEach(r => list.appendChild(r));
        this.input.appendChild(list);
        const focus = (i) => {
          if (i === idx && rows[i] && rows[i].classList.contains('on')) return;
          idx = i;
          rows.forEach((r, j) => r.classList.toggle('on', j === i));
          if (i >= 0 && opts.onFocus) opts.onFocus(options[i].value);
        };
        if (idx >= 0) focus(idx);
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
          else if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); focus(idx < 0 ? options.length - 1 : (idx - 1 + options.length) % options.length); }
          else if (k === 'Enter') { e.preventDefault(); e.stopPropagation(); if (idx >= 0) done({ value: options[idx].value }); }
          else if ((k === 'b' || k === 'B') && opts.back) { e.preventDefault(); e.stopPropagation(); done({ nav: 'back' }); }
          else if (k === 's' || k === 'S') { e.preventDefault(); e.stopPropagation(); rs.press(); }
          else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); done({ nav: 'quit' }); }
        };
        this._keyHandler = key;
        document.addEventListener('keydown', key, true);
      });
    },

    /* A slider along `items` (in order), for the theme step: each stop names
       itself above the bar. Arrow keys move it from anywhere; Enter, or the
       button, settles on it. onChange fires as it moves. */
    slide(items, opts) {
      opts = opts || {};
      return new Promise(resolve => {
        let idx = Math.max(0, items.findIndex(o => o.value === opts.current));
        this.input.innerHTML = '';
        const lvl = el('.if-lvl'), name = el('.if-lvl-name');
        const range = el('input.if-range', { type: 'range', min: '0', max: String(items.length - 1), step: '1', value: String(idx) });
        if (opts.track) range.style.setProperty('--track', opts.track);
        const ticks = el('.if-ticks', null, items.map(() => el('span')));
        const go = el('button.if-choice.on.if-slide-go', { onclick: () => done({ value: items[idx].value }) }, [el('span.if-lbl', null, 'That’s the one ✓')]);
        this.input.appendChild(el('.if-slider', null, [
          el('.if-lvl-row', null, [lvl, name]),
          el('.if-range-row', null, [endIcon(LAMP, 'Lights up'), el('.if-range-wrap', null, [range, ticks]), endIcon(PROJECTOR, 'Lights down')]),
          go
        ]));
        const show = (i, quiet) => {
          idx = Math.max(0, Math.min(items.length - 1, i));
          range.value = String(idx);
          range.style.setProperty('--pct', (idx / Math.max(1, items.length - 1) * 100) + '%');
          lvl.textContent = items[idx].level;
          name.textContent = items[idx].label;
          lvl.classList.remove('pop'); void lvl.offsetWidth; lvl.classList.add('pop');
          if (!quiet && opts.onChange) opts.onChange(items[idx].value);
        };
        range.addEventListener('input', () => show(Number(range.value)));
        show(idx, true);
        setTimeout(() => range.focus(), 0);
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
          if (k === 'ArrowRight' || k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); show(idx + 1); }
          else if (k === 'ArrowLeft' || k === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); show(idx - 1); }
          else if (k === 'Enter') { e.preventDefault(); e.stopPropagation(); done({ value: items[idx].value }); }
          else if ((k === 'b' || k === 'B') && opts.back) { e.preventDefault(); e.stopPropagation(); done({ nav: 'back' }); }
          else if (k === 's' || k === 'S') { e.preventDefault(); e.stopPropagation(); rs.press(); }
          else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); done({ nav: 'quit' }); }
        };
        this._keyHandler = key;
        document.addEventListener('keydown', key, true);
      });
    },

    /* Drag-to-order: `items` as sticky notes in a row, first on the left.
       Drag one sideways and the others shuffle out of its way; or focus one
       and move it with ← →. onChange gets the order (values) as it changes. */
    arrange(items, opts) {
      opts = opts || {};
      return new Promise(resolve => {
        this.input.innerHTML = '';
        const colors = ['#fff3a3', '#ffc9d6', '#c9e8ff', '#d4f5c4', '#e6d4ff'];
        const row = el('.if-arrange');
        const cards = items.map((it, i) => {
          const c = el('button.if-card', { type: 'button', title: 'Drag, or use ← → to move' }, [
            el('span.if-card-pin'), el('span.if-card-num'),
            el('span.if-card-lbl', null, it.label), el('span.if-card-hint', null, it.hint || '')
          ]);
          c.dataset.value = it.value;
          c.style.setProperty('--note', colors[i % colors.length]);
          c.style.setProperty('--tilt', (i % 2 ? 1.5 : -1.5) + 'deg');
          return c;
        });
        cards.forEach(c => row.appendChild(c));
        const go = el('button.if-choice.on.if-slide-go', { onclick: () => done({ value: order() }) }, [el('span.if-lbl', null, 'Pin them up ✓')]);
        this.input.appendChild(el('.if-arrange-wrap', null, [
          el('.if-arrange-ends', null, [el('span', null, 'first'), el('span', null, 'last')]), row, go
        ]));
        const order = () => Array.from(row.children).map(c => c.dataset.value);
        const renumber = () => {
          Array.from(row.children).forEach((c, i) => { c.querySelector('.if-card-num').textContent = String(i + 1); });
          if (opts.onChange) opts.onChange(order());
        };
        renumber();

        // slide the cards that moved from where they were to where they are (FLIP)
        const shuffle = (fn) => {
          const before = new Map(Array.from(row.children).map(c => [c, c.getBoundingClientRect().left]));
          fn();
          Array.from(row.children).forEach(c => {
            if (c.classList.contains('dragging')) return;
            const dx = before.get(c) - c.getBoundingClientRect().left;
            if (!dx) return;
            c.style.transition = 'none'; c.style.translate = dx + 'px 0';
            requestAnimationFrame(() => { c.style.transition = ''; c.style.translate = ''; });
          });
          renumber();
        };

        let drag = null;
        row.addEventListener('pointerdown', (e) => {
          const c = e.target.closest('.if-card');
          if (!c) return;
          e.preventDefault();
          c.focus();
          drag = { c, x0: e.clientX };
          c.classList.add('dragging');
          try { c.setPointerCapture(e.pointerId); } catch (err) {}
        });
        row.addEventListener('pointermove', (e) => {
          if (!drag) return;
          const c = drag.c;
          c.style.translate = (e.clientX - drag.x0) + 'px 0';
          const swap = (n, after) => {
            const was = c.getBoundingClientRect().left - parseFloat(c.style.translate || 0);
            shuffle(() => after ? n.after(c) : n.before(c));
            c.style.translate = '0px 0';
            const now = c.getBoundingClientRect().left;
            drag.x0 += now - was;
            c.style.translate = (e.clientX - drag.x0) + 'px 0';
          };
          // a fast drag can pass several cards in one move — keep swapping until it's settled
          for (let guard = 0; guard < items.length; guard++) {
            const m = c.getBoundingClientRect().left + c.offsetWidth / 2;
            const next = c.nextElementSibling, prev = c.previousElementSibling;
            if (next && m > next.getBoundingClientRect().left + next.offsetWidth / 2) swap(next, true);
            else if (prev && m < prev.getBoundingClientRect().left + prev.offsetWidth / 2) swap(prev, false);
            else break;
          }
        });
        const drop = () => {
          if (!drag) return;
          const c = drag.c; drag = null;
          c.classList.remove('dragging');
          c.style.translate = '';
        };
        row.addEventListener('pointerup', drop);
        row.addEventListener('pointercancel', drop);

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
          const k = e.key, card = document.activeElement && document.activeElement.closest && document.activeElement.closest('.if-card');
          if ((k === 'ArrowLeft' || k === 'ArrowRight') && card) {
            e.preventDefault(); e.stopPropagation();
            const n = k === 'ArrowLeft' ? card.previousElementSibling : card.nextElementSibling;
            if (n) { shuffle(() => k === 'ArrowLeft' ? n.before(card) : n.after(card)); card.focus(); }
          } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
            e.preventDefault(); e.stopPropagation();
            (k === 'ArrowLeft' ? row.lastElementChild : row.firstElementChild).focus();
          } else if (k === 'Enter') { e.preventDefault(); e.stopPropagation(); done({ value: order() }); }
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
    layer: null, bubble: null, mascot: null, peek: null, sayAnchor: null, _raf: 0, _poll: 0,
    _glowed: [],

    /* No dimming and no moving frame: whatever's being explained gets a glow
       of its own (.gd-glow, a box-shadow on the element itself), so it
       scrolls with the page exactly, never a frame behind. The mascot hides
       behind that element and peeks out over its edge from a clipping box
       whose cut line sits on the element's edge. */
    ensure() {
      if (this.layer && this.layer.isConnected) return;
      this.layer = el('.gd-layer');
      this.mascot = el('.gd-mascot');
      this.peek = el('.gd-peek', null, this.mascot);
      this.sayAnchor = el('.gd-say-anchor');
      this.bubble = el('.gd-bubble', { onclick: e => e.stopPropagation(), onmousedown: e => e.stopPropagation() });
      this.layer.appendChild(this.peek);
      this.layer.appendChild(this.sayAnchor);
      this.layer.appendChild(this.bubble);
      document.body.appendChild(this.layer);
    },
    close() {
      cancelAnimationFrame(this._raf); clearInterval(this._poll);
      this.glow([]);
      if (this.layer) this.layer.remove();
      this.layer = null;
    },
    // the speech bubble hangs off an unclipped anchor beside the peeking mascot
    say(text) { sayFrom(this.sayAnchor, text); },

    // App.render rebuilds the DOM, so the glow is re-applied every frame to
    // whatever the selectors find now, and taken off anything that left
    glow(els) {
      this._glowed.forEach(n => { if (!els.includes(n)) n.classList.remove('gd-glow', 'gd-round'); });
      els.forEach(n => {
        if (n.classList.contains('gd-glow')) return;
        n.classList.add('gd-glow');
        // a square container (a group of buttons) gets rounded corners for the glow
        if (parseFloat(getComputedStyle(n).borderTopLeftRadius) === 0) n.classList.add('gd-round');
      });
      this._glowed = els;
    },

    resolveTargets(t) {
      if (!t) return [];
      const r = typeof t === 'function' ? t() : document.querySelectorAll(t);
      const arr = !r ? [] : (r instanceof Element ? [r] : Array.from(r));
      return arr.filter(n => n && n.isConnected && n.getClientRects().length);
    },

    place(opts) {
      // a step with `pick` chooses its element once and keeps it, so the light
      // doesn't wander to a different bar as the page settles
      if (opts.pick && !opts._picked) opts._picked = opts.pick();
      const main = opts._picked && opts._picked.isConnected ? [opts._picked] : this.resolveTargets(opts.target);
      const els = main.concat(this.resolveTargets(opts.also));
      this.glow(els);
      const vw = window.innerWidth, vh = window.innerHeight;
      const union = (list) => {
        let rect = null;
        list.forEach(n => {
          const r = n.getBoundingClientRect();
          if (!r.width && !r.height) return;
          rect = rect ? {
            left: Math.min(rect.left, r.left), top: Math.min(rect.top, r.top),
            right: Math.max(rect.right, r.right), bottom: Math.max(rect.bottom, r.bottom)
          } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        });
        return rect;
      };
      const rect = union(els);
      this.layer.classList.toggle('gd-nohole', !rect && !opts.noWash);

      // the bubble: below what's lit if it fits, else above, else beside, else centred
      const b = this.bubble.getBoundingClientRect();
      const gap = 18;
      let bx, by;
      // nothing lit: the bubble waits at the bottom, out of the page's way
      if (!rect) { bx = (vw - b.width) / 2; by = vh - b.height - 28; }
      // a step that needs the space under what's lit (dropping widgets onto
      // the dashboard) parks the bubble in the bottom-right corner instead
      else if (opts.corner) { bx = vw - b.width - 20; by = vh - b.height - 20; }
      else if (rect.bottom + gap + b.height < vh) { bx = rect.left; by = rect.bottom + gap; }
      else if (rect.top - gap - b.height > 0) { bx = rect.left; by = rect.top - gap - b.height; }
      else if (rect.right + gap + b.width < vw) { bx = rect.right + gap; by = rect.top; }
      else { bx = (vw - b.width) / 2; by = vh - b.height - 16; }
      bx = Math.max(12, Math.min(vw - b.width - 12, bx));
      by = Math.max(12, Math.min(vh - b.height - 12, by));
      this.bubble.style.left = bx + 'px';
      this.bubble.style.top = by + 'px';

      /* The mascot peeks out from behind the main target: over its top edge
         when there's room, else hanging down from under its bottom edge. The
         clip box's cut line IS that edge, so the part of the mascot still
         "behind" the element is simply not drawn. */
      // a step can sit the mascot on the bubble itself instead (peekOn: 'bubble')
      const t = opts.peekOn === 'bubble'
        ? { left: bx + b.width * 0.55, right: bx + b.width - 50, top: by, bottom: by + b.height }
        : union(main) || rect;
      const W = 58, H = 52;
      let px, py, from;
      if (!t) { px = bx + b.width - W - 10; py = by - H; from = 'top'; }
      else {
        px = opts.peek === 'left' ? t.left + 10 : Math.max(t.left, Math.min(t.right - W - 6, vw - W - 4));
        if (t.top - H >= 2) { py = t.top - H; from = 'top'; }
        else { py = t.bottom; from = 'bottom'; }
      }
      // a step can go without the mascot (noMascot) — and any step pointing at
      // one of the tabs along the top does, there's no room up there for it
      const onTab = main.some(n => n.matches && n.matches('.view-tab'));
      this.peek.style.display = opts.noMascot || onTab ? 'none' : '';
      this.peek.style.left = px + 'px';
      this.peek.style.top = py + 'px';
      if (this.peek.dataset.from !== from) this.peek.dataset.from = from;
      this.sayAnchor.style.left = px + 'px';
      this.sayAnchor.style.top = (from === 'top' ? py : py + H) + 'px';
      this.sayAnchor.dataset.from = from;
    },

    step(opts) {
      this.ensure();
      cancelAnimationFrame(this._raf); clearInterval(this._poll);
      const mascotEmoji = App.profile.mascot();
      this.mascot.textContent = mascotEmoji;
      this.peek.classList.remove('in'); void this.peek.offsetWidth; this.peek.classList.add('in');

      return new Promise(resolve => {
        let finished = false, evt = null;
        const finish = (how) => {
          if (finished) return;
          finished = true;
          cancelAnimationFrame(this._raf); clearInterval(this._poll);
          if (this._calmOff) this._calmOff();
          if (this._unlock) { this._unlock(); this._unlock = null; }
          document.removeEventListener('keydown', keys, true);
          if (evt) document.removeEventListener(evt.type, evt.fn, true);
          resolve(how);
        };

        /* The glow is for finding the thing. Once they're using it (a press
           inside anything lit), it settles down to a soft outline. */
        /* …or, for a step with a `then` (a target for once they've started),
           the light moves on to that instead — the Done button, say. */
        // a step can hold the page still (no wheel, touch or key scrolling)
        if (opts.lock) {
          const stop = (e) => { if (!(e.target.closest && e.target.closest('.gd-bubble'))) e.preventDefault(); };
          const keysStop = (e) => {
            const zoomKey = (e.metaKey || e.ctrlKey) && ['=', '+', '-', '_', '0'].includes(e.key);
            if (zoomKey) { e.preventDefault(); e.stopPropagation(); return; }
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key) && !(e.target.closest && e.target.closest('input, textarea, [contenteditable]'))) e.preventDefault();
          };
          // and the timeline's zoom (its buttons, ⌘+/⌘−, ctrl+scroll) holds still too
          const zoomBy = App.gantt && App.gantt.zoomBy;
          if (zoomBy) App.gantt.zoomBy = () => {};
          window.addEventListener('wheel', stop, { passive: false, capture: true });
          window.addEventListener('touchmove', stop, { passive: false, capture: true });
          window.addEventListener('keydown', keysStop, true);
          document.body.classList.add('gd-locked');
          this._unlock = () => {
            window.removeEventListener('wheel', stop, { capture: true });
            window.removeEventListener('touchmove', stop, { capture: true });
            window.removeEventListener('keydown', keysStop, true);
            document.body.classList.remove('gd-locked');
            if (zoomBy) App.gantt.zoomBy = zoomBy;
          };
        }
        document.body.classList.remove('gd-calm');
        let moved = false;
        const calm = (e) => {
          if (moved || !this._glowed.some(n => n.contains(e.target))) return;
          if (opts.then) { moved = true; opts = Object.assign({}, opts, opts.then, { then: null }); }
          else document.body.classList.add('gd-calm');
        };
        document.addEventListener('pointerdown', calm, true);
        this._calmOff = () => { document.removeEventListener('pointerdown', calm, true); document.body.classList.remove('gd-calm'); };

        const text = typeof opts.text === 'function' ? opts.text() : opts.text;
        this.bubble.innerHTML = '';
        this.bubble.appendChild(el('span.gd-b-title', null, opts.title || ''));
        this.bubble.appendChild(el('.gd-b-head', null, [
          opts.progress ? el('span.gd-b-prog', null, opts.progress) : null,
          el('button.gd-b-x', { title: 'End the tour', onclick: () => finish('end') }, '✕')
        ]));
        // opts.face: the mascot sits inside the bubble, saying the line itself
        const bodyEl = el('.gd-b-text', null, text);
        if (opts.face) this.bubble.classList.add('gd-b-faced'); else this.bubble.classList.remove('gd-b-faced');
        this.bubble.appendChild(opts.face ? el('.gd-b-face-row', null, [el('span.gd-b-face', null, App.profile.mascot()), bodyEl]) : bodyEl);
        if (opts.waitFor) this.bubble.appendChild(el('.gd-b-wait', null, opts.waitLabel || 'Go ahead — I’ll wait.'));
        const acts = el('.gd-b-acts');
        // no Skip in the tour: every step has Show me (or Next), and ✕ ends it
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
          // a step pinned to the top of the chart stays there, whatever redraws
          if (opts.top) toTop();
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
          if ((e.key === 'n' || e.key === 'N' || e.key === 'ArrowRight') && (!opts.waitFor || opts.next)) { e.preventDefault(); e.stopPropagation(); finish('done'); }
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

  /* A task bar the person can actually see right now: inside the timeline's
     scrolled view, not off past its left or right edge (the first bar in the
     DOM is often weeks ago, scrolled out of sight). Nearest to today wins. */
  const visibleBar = () => {
    const sc = document.querySelector('.gantt-scroll, .gantt-wrap, #view');
    const box = sc ? sc.getBoundingClientRect() : { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
    const today = document.querySelector('.today-line');
    const tx = today ? today.getBoundingClientRect().left : (box.left + box.right) / 2;
    const bars = myDeptFirst(Array.from(document.querySelectorAll('.g-row.sub:not(.phase) .bar[data-episode-id][data-su-key]'))).filter(b => {
      const r = b.getBoundingClientRect();
      return r.width > 20 && r.left >= box.left + 230 && r.right <= Math.min(box.right, innerWidth) - 8 && r.top >= box.top && r.bottom <= Math.min(box.bottom, innerHeight);
    });
    const mine = bars.filter(isMyDept);
    const pool = mine.length ? mine : bars;
    pool.sort((a, b) => Math.abs(a.getBoundingClientRect().left - tx) - Math.abs(b.getBoundingClientRect().left - tx));
    return pool[0] || null;
  };

  /* Scroll the page and the chart so one task bar sits about a quarter of the
     way down the screen and comfortably inside the chart, leaving the space
     below it for the bubble and above it for the mascot. Returns that bar. */
  const frameBar = () => {
    const view = document.getElementById('view');
    const sc = document.querySelector('.gantt-scroll');
    if (!sc) return null;
    view.scrollTop = 0;
    sc.scrollTop = 0;
    // the highest task on the chart that's happening around today — so the
    // chart can scroll it up into a comfortable spot
    const today = document.querySelector('.today-line');
    const tx = today ? today.getBoundingClientRect().left : null;
    const all = myDeptFirst(Array.from(document.querySelectorAll('.g-row.sub:not(.phase) .bar[data-episode-id][data-su-key]'))
      .filter(x => x.getBoundingClientRect().width > 20));
    const near = tx == null ? all : all.filter(x => { const r = x.getBoundingClientRect(); return r.right > tx - 250 && r.left < tx + 250; });
    // their own department's work first, wherever it sits
    const b = near.find(isMyDept) || all.find(isMyDept) || near[0] || all[0];
    if (!b) return null;
    const box = sc.getBoundingClientRect(), r = b.getBoundingClientRect();
    sc.scrollTop += (r.top - box.top) - Math.max(60, box.height * 0.18);
    sc.scrollLeft += (r.left - box.left) - Math.max(260, box.width * 0.35);
    return b;
  };

  const closeAll = async () => { for (let i = 0; i < 4 && modalOpen(); i++) { App.modal.close(); await sleep(60); } };
  /* Scroll the chart so the first element matching `sel` sits comfortably in
     view (a third of the way across, a quarter of the way down). Returns it. */
  const frameEl = (sel) => {
    const sc = document.querySelector('.gantt-scroll');
    const n = document.querySelector(sel);
    if (!sc || !n) return n;
    const v = document.getElementById('view'); if (v) v.scrollTop = 0;
    const box = sc.getBoundingClientRect(), r = n.getBoundingClientRect();
    sc.scrollLeft += (r.left - box.left) - Math.max(260, box.width * 0.35);
    sc.scrollTop += (r.top - box.top) - Math.max(80, box.height * 0.22);
    return n;
  };
  let framed = null;   // the task bar the "Open a task" step framed and lit
  /* The task a department person is shown is one of their department's: the
     bar's task belongs to the department of the role they're signed in as.
     Oversight roles have no department, so any task will do for them. */
  const isMyDept = (bar) => {
    const dept = App.roleDept(App.state.role);
    if (!dept) return true;
    const ep = App.state.data.episodes.find(e => e.id === bar.dataset.episodeId);
    const su = ep && App.subitem(ep, bar.dataset.suKey);
    return !!(su && su.dept === dept);
  };
  const myDeptFirst = (bars) => bars.filter(isMyDept).concat(bars.filter(b => !isMyDept(b)));

  const SECTIONS = {
    timeline: () => {
      let zoom0 = 0, notes0 = 0;
      const creative = deptKey(/creative/i);
      const myDept = () => App.roleDept(App.state.role);
      const allButCreative = () => Object.keys(App.DEPARTMENTS).filter(k => k !== creative);
      return [
        { title: 'Production Schedule', text: 'Click the Timeline tab — the production schedule, every episode laid out on a calendar.',
          target: tabSel('timeline'), waitFor: () => App.state.view === 'timeline' && App.timelineMode() === 'schedule',
          before: () => { if (App.state.view === 'timeline' && App.timelineMode() !== 'schedule') { App.prefs.set('timelineMode', 'schedule'); App.render(); } },
          showMe: () => { App.prefs.set('timelineMode', 'schedule'); goView('timeline'); } },
        { title: 'Search & filters', text: 'Narrow everything down by Show, Department and Owner, or search by episode. Whatever you pick is remembered the next time you open the app.',
          target: '#toolbar .filter-multi[data-fkey], #search' },
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
        // a department person narrows to just their own department's tasks…
        { when: () => !!myDept(), title: 'Just yours', text: () => 'Open Dept, then ' + cmd() + '-click “' + App.DEPARTMENTS[myDept()].label + '” to show only your department’s tasks.',
          target: '.filter-multi[data-fkey="dept"]', also: '.filter-pop',
          waitFor: () => { const d = App.state.filters.dept; return d.length === 1 && d[0] === myDept(); },
          showMe: () => { App.filterMenu.close(); App.state.filters.dept = [myDept()]; App.render(); } },
        // …oversight roles see the other trick: everything except one department
        { when: () => !myDept(), title: 'Everyone but…', text: () => 'Open Dept, then ' + cmd() + '-click “Creative” twice. The first click shows only Creative; the second shows everything except Creative.',
          target: '.filter-multi[data-fkey="dept"]', also: '.filter-pop',
          waitFor: () => { const d = App.state.filters.dept, w = allButCreative(); return d.length === w.length && w.every(k => d.includes(k)); },
          showMe: () => { App.filterMenu.close(); App.state.filters.dept = allButCreative(); App.render(); } },
        { title: 'Open a task', text: 'Click any task bar to open it.',
          // frame one task high in the chart, with room below it for the bubble,
          // then hold the page still so nothing drifts apart
          before: () => {
            // the step before filtered out Creative — bring their own department back into view
            const mine = App.roleDept(App.state.role), f = App.state.filters;
            if (mine && f.dept.length && !f.dept.includes(mine)) { f.dept = []; App.render(); }
            framed = frameBar();
          }, lock: true, pick: () => (framed && framed.isConnected ? framed : visibleBar()),
          target: () => visibleBar(),
          waitFor: modalOpen,
          showMe: () => {
            const b = visibleBar();
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
          target: '.show-edit-links button' },
        // closing the show editor drops back to the Shows browser — Esc again closes that
        { when: () => App.canManageShows(App.state.role), title: 'Close it', text: 'Press Esc (twice — once for the show, once for the Shows list).',
          target: '.modal-card', waitFor: () => !modalOpen(), showMe: closeAll },
        { when: () => App.canEditNotes(), title: 'Producer Notes', text: 'With a single show picked, this lane holds notes for the whole team — shoot days, holidays, heads-ups.',
          target: '.g-row.pn-head', also: '.g-row.pn-row', lock: true, top: true, peekOn: 'bubble',
          before: () => {
            if (!document.querySelector('.g-row.pn-head')) { App.state.filters.show = [sandbox.showId]; App.render(); }
            toTop();
          } },
        { when: () => App.canEditNotes(), title: 'Draw a note', text: 'Drag across the notes lane to draw a note over some days.',
          lock: true, top: true, corner: true,   // the bubble keeps out of the lane
          before: () => { toTop(); const s = App.show(sandbox.showId); notes0 = (s && s.notes || []).length; },
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
          lock: true, top: true, corner: true,
          // the mascot sits on the note just drawn; its name box is lit too
          target: () => {
            const s = App.show(sandbox.showId), n = s && s.notes && s.notes[s.notes.length - 1];
            return (n && document.querySelector('.pn-note[data-note-id="' + n.id + '"]')) || document.querySelector('.g-row.pn-row');
          },
          also: '.pn-note-input',
          waitFor: () => { const s = App.show(sandbox.showId); const n = s && s.notes && s.notes[s.notes.length - 1]; return !!(n && String(n.text || '').trim()); },
          showMe: () => {
            const s = App.show(sandbox.showId); const n = s && s.notes && s.notes[s.notes.length - 1];
            if (n) { App.gantt.closeNoteEditor && App.gantt.closeNoteEditor(); App.updateNote(sandbox.showId, n.id, { text: 'Ping pong table arrives' }); }
          } },
        { when: () => App.canManageShows(App.state.role), title: 'Delivery date', text: 'The D marks are each episode’s Delivery date. Click one.',
          // bring the first D into view, then hold the chart still on it
          before: () => { App.gantt.closeNoteEditor && App.gantt.closeNoteEditor(); framed = frameEl('.ms-day.ms-delivery_date'); },
          lock: true, pick: () => framed, peekOn: 'bubble',
          target: () => document.querySelector('.ms-day.ms-delivery_date'),
          waitFor: modalOpen,
          showMe: () => { const m = framed && framed.isConnected ? framed : null; if (m) m.click(); else { const e = demoEps()[0]; if (e) App.milestoneDialog.open(e.id, 'delivery_date'); } } },
        { when: () => App.canManageShows(App.state.role), title: 'Delivery date', text: 'This is the date the episode is committed to. Press Esc to close.', peekOn: 'bubble',
          target: '.modal-card', waitFor: () => !modalOpen(), showMe: () => App.modal.close() },
        { when: () => App.canManageShows(App.state.role), title: 'Live date', text: 'And LD is when it goes Live. Click one.',
          before: () => { framed = frameEl('.ms-day.ms-' + App.LIVE_KEY); },
          lock: true, pick: () => framed, peekOn: 'bubble',
          target: () => document.querySelector('.ms-day.ms-' + App.LIVE_KEY),
          waitFor: modalOpen,
          showMe: () => { const m = framed && framed.isConnected ? framed : null; if (m) m.click(); else { const e = demoEps()[0]; if (e) App.milestoneDialog.open(e.id, App.LIVE_KEY); } } },
        { when: () => App.canManageShows(App.state.role), title: 'Live date', text: 'Press Esc to close.', peekOn: 'bubble',
          target: '.modal-card', waitFor: () => !modalOpen(), showMe: () => App.modal.close() }
      ];
    },

    board: () => {
      const myDept = App.roleDept(App.state.role);
      const firstEpId = () => { const g = document.querySelector('.ep-group[data-ep-id]'); return g && g.dataset.epId; };
      // the task in the open episode that's most theirs: assigned to them, else
      // their department's, else (oversight roles) the first
      const yours = () => {
        const id = firstEpId(); const ep = id && App.state.data.episodes.find(e => e.id === id);
        const subs = ep ? App.subsView(ep) : [];
        const me = App.state.user && App.state.user.personId, dept = App.roleDept(App.state.role);
        return subs.find(x => x.assignee === me && (!dept || x.dept === dept)) || (dept && subs.find(x => x.dept === dept)) || subs[0];
      };
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
          // theirs if one's assigned to them, else one from their department —
          // a department role can only open its own department's tasks
          target: () => {
            const su = yours();
            const rows = Array.from(document.querySelectorAll('.subtable .subrow:not(.head)'));
            const r = (su && rows.find(x => (x.querySelector('.c-name') || {}).textContent === su.name)) || rows[0];
            return r && r.querySelector('.c-name');
          },
          waitFor: modalOpen,
          showMe: () => { const id = firstEpId(), su = yours(); if (id && su) App.editTask.open(id, su.key); } },
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
      { title: 'Make it yours', text: 'Edit lets you move, resize, add and remove widgets any time.', target: '.dash-tools button' },
      { title: 'Pop it out', text: 'This opens a widget in its own window — handy on a second screen, or kept on top while you work in another app.',
        target: () => document.querySelector('.dw .dw-pop') }
    ],

    review: () => [
      // every department's reviews, not just what an earlier step filtered down to
      { title: 'Reviews', text: 'Click Reviews — cuts waiting for notes and approval.', noMascot: true,
        before: () => { App.state.filters.dept = []; App.state.filters.person = []; App.render(); },
        target: tabSel('review'), waitFor: () => App.state.view === 'review', showMe: () => goView('review') },
      { title: 'The review queue', text: 'Everything sent for review, most urgent first. Open one to watch it, leave notes, approve or send it back.', target: null, peekOn: 'bubble', noWash: true }
    ],

    resources: () => [
      { title: 'Resourcing', text: 'Click the Timeline tab.', when: () => App.state.view !== 'timeline',
        target: tabSel('timeline'), waitFor: () => App.state.view === 'timeline', showMe: () => goView('timeline') },
      { title: 'Resourcing', text: 'Switch to Resources to see who’s busy, department by department, week by week.',
        target: () => Array.from(document.querySelectorAll('#toolbar .toolbar-seg')).find(s => s.textContent.includes('Resources')),
        waitFor: () => App.timelineMode() === 'resources',
        showMe: () => { App.prefs.set('timelineMode', 'resources'); App.render(); } },
      { title: 'Workload', text: 'Each circle is a week’s workload. Click a person for their capacity and time off.', target: null, peekOn: 'bubble', noWash: true }
    ]
  };

  // `from` (a step number, 1-based, or part of a title) starts part-way —
  // for reviewing one step without clicking through the ones before it
  async function runTour(from) {
    if (App.isPhone()) return 'done';
    App.filterMenu && App.filterMenu.close && App.filterMenu.close();
    sandbox.enter();
    App.render();
    let result = 'done';
    try {
      const order = App.profile.tabOrder();
      const steps = [];
      // the Dashboard isn't toured: setup has just had them build it by hand
      // (step 7 covers the tray, Edit and the pop-out button)
      order.forEach(k => { if (k !== 'dashboard' && SECTIONS[k]) steps.push(...SECTIONS[k]()); });
      const live = steps.filter(s => !s.when || s.when());
      let start = 0;
      if (typeof from === 'number') start = Math.max(0, steps.indexOf(live[from - 1]));
      else if (typeof from === 'string') start = Math.max(0, steps.findIndex(s => (s.title || '').toLowerCase().includes(from.toLowerCase())));
      // fast-forward: do what each skipped step would have had the user do,
      // so the step we land on finds the screen it expects
      for (let i = 0; i < start; i++) {
        const s = steps[i];
        if (s.when && !s.when()) continue;
        if (s.before) s.before();
        if (s.showMe) { try { await s.showMe(); } catch (e) {} await sleep(250); }
      }
      for (let i = start; i < steps.length; i++) {
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

  /* The completion line appears in the Journal as if typed, very fast. It's
     already saved — this only replays it on screen, then leaves it whole. */
  async function typeIntoJournal(html) {
    await sleep(200);
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    const text = tmp.textContent;
    const blocks = Array.from(document.querySelectorAll('.dw[data-wid="journal"] .jr-block'));
    const b = blocks.reverse().find(x => x.textContent === text);
    if (!b) return;
    b.textContent = '';
    b.classList.add('gd-typing');
    for (let i = 0; i <= text.length; i += 3) {
      if (!b.isConnected) return;
      b.textContent = text.slice(0, i);
      await sleep(12);
    }
    b.innerHTML = html;
    b.classList.remove('gd-typing');
  }

  /* ================================================================ FLOW */
  const fill = (s) => s.replace(/\{name\}/g, App.profile.displayName() || 'traveller');

  App.guide = {
    running: false,

    /* Review helpers, from the console:
         App.guide.start({ redo: true, step: 4 })   the wizard from step 4
         App.guide.tour(5) / App.guide.tour('zoom')  the tour from a step */
    async tour(from) {
      if (this.running) return;
      this.running = true;
      try { await runTour(from); } finally { coach.close(); this.running = false; App.render(); }
    },

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
        character: redo ? (prof.character || '') : '',
        // a first run starts from a blank slate, even if a half-finished
        // setup saved something; a redo starts from what they have
        tabOrder: redo && App.profile.hasOrder() ? App.profile.tabOrder() : null
      };
      const themeBefore = App.prefs.get('theme', 'midnight');
      const save = (extra) => {
        if (App.state.user && pick.name) App.state.user.name = pick.name;
        App.profile.set(Object.assign({
          name: pick.name, character: pick.character || prof.character || '',
          theme: pick.theme, tabOrder: pick.tabOrder || App.profile.tabOrder()
        }, extra || {}));
      };
      const today = App.isoDate(App.today());
      const phone = App.isPhone();

      IF.open();
      IF.setMascot(pick.character);
      const mascotLabel = (emoji) => { const m = cfg.mascots.find(x => x.emoji === emoji); return (m && m.label) || 'PipeDream'; };
      if (pick.character) IF.setSpeaker(mascotLabel(pick.character));
      IF.setClap(redo ? pick.name : '');
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
          IF.setStep(3, TOTAL); IF.clear(); IF.focus('clapper'); IF.setClap(pick.name);
          await IF.type('Every production needs a name on the clapperboard. What would you like to be called?');
          const r = await IF.ask('', pick.name, { back: true, onInput: (v) => IF.setClap(v) });
          if (r.value) pick.name = r.value;
          IF.setClap(pick.name);
          return r;
        },
        async () => {
          IF.setStep(4, TOTAL); IF.clear(); IF.focus(''); IF.zoom('monitor');
          await IF.type('Nice to meet you, ' + pick.name + '! How bright do you like your screens? Slide from light to dark and watch the monitor.');
          const ordered = themesByBrightness();
          const r = await IF.slide(ordered.map((o, i) => ({
            value: o.t.v, label: o.t.label.replace(/\s*\(default\)/, ''), level: levelFor(i, ordered.length)
          })), {
            back: true, current: pick.theme,
            track: 'linear-gradient(to right, ' + ordered.map(o => o.bg || '#888').join(', ') + ')',
            onChange: (v) => { App.prefs.set('theme', v); App.applyTheme(); }
          });
          IF.zoom('');
          if (r.value) pick.theme = r.value;
          App.prefs.set('theme', pick.theme); App.applyTheme(); App.render();
          return r;
        },
        async () => {
          IF.setStep(5, TOTAL); IF.clear(); IF.focus('mascot');
          await IF.type('Something rustles behind the monitors… a little companion wants to keep you company on the desk. Who’ll it be?');
          const r = await IF.choose(cfg.mascots.map(m => ({ label: m.label || '', value: m.emoji, face: m.emoji })), {
            back: true, current: pick.character, faces: true,
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
          await IF.type('Let’s plan your mornings. Drag these into the order you check them each day — first on the left. I’ll pin them to the board.');
          const label = (k) => (PRIORITY_TABS.find(t => t.key === k) || {}).label || k;
          // arrange → pin → look; Back from the pinned board unpins them to rearrange
          let order = pick.tabOrder || availableTabs().map(t => t.key);
          for (;;) {
            IF.setNotes([]);                       // the board's empty until they're pinned up
            const r = await IF.arrange(order.map(k => {
              const t = PRIORITY_TABS.find(x => x.key === k);
              return { value: k, label: t.label, hint: t.blurb };
            }), { back: true });
            if (r.nav) return r;
            order = r.value;
            await IF.pinCards(Array.from(IF.input.querySelectorAll('.if-card')), order.map(label));
            IF.clear();
            await IF.type('All pinned up! Your tabs will sit in this order too.');
            const c = await IF.choose([{ label: 'Looks good', value: 'go' }], { back: true });
            if (c.nav === 'back') {
              IF.clear();
              await IF.type('No problem — move them around again.');
              continue;
            }
            if (c.nav === 'quit') return c;
            break;
          }
          pick.tabOrder = order;
          return { value: 'ok' };
        }
      ];

      // opts.step jumps straight to a wizard step (1–9) — for reviewing
      const jump = Math.max(1, Math.min(9, opts.step || 1));
      let i = Math.min(jump - 1, steps.length);
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
      let wantDash = jump <= 7;
      if (wantDash && redo) {
        await IF.type('Rebuild your dashboard from scratch?');
        const r = await IF.choose([{ label: 'Yes — start me with an empty one', value: 'yes' }, { label: 'No, keep it as it is', value: 'no' }]);
        wantDash = r.value === 'yes';
      } else if (wantDash) {
        // Back from here returns to the pinboard (step 6), then comes back
        for (;;) {
          IF.setStep(7, TOTAL); IF.clear(); IF.focus('');
          await IF.type('Next, your Dashboard. It’s empty — you choose what goes on it.');
          const c = await IF.choose([{ label: 'Show me', value: 'go' }], { back: true });
          if (c.nav !== 'back') break;
          await steps[5]();
          save();
        }
      }
      IF.close();
      if (wantDash) {
        App.state.view = 'dashboard';
        App.dashboard.clearForSetup();
        await sleep(200);
        const r1 = await coach.step({
          title: 'Build your dashboard', progress: '7 / ' + TOTAL,
          text: 'Drag widgets from the tray onto the dashboard, then drag their edges to size them. Add as many as you like, then press ✓ Done.',
          target: '.dash-tray', also: '.dash-tools button', corner: true, peek: 'left',
          // once they've started building, only Done stays lit
          then: { target: '.dash-tools .btn-primary', also: null, peek: null },
          // Done with nothing on it doesn't count — back into edit mode, and a nudge
          waitFor: () => {
            if (App.dashboard._editing) return false;
            if (App.dashboard.getLayout().length) return true;
            App.dashboard._editing = true; App.render();
            coach.say('Pick at least one first!');
            return false;
          },
          waitLabel: 'Press ✓ Done when you’re happy.',
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
      let t = { value: 'no' };
      if (jump <= 8) {
        IF.open(); IF.setMascot(pick.character); IF.setSpeaker(mascotLabel(pick.character)); IF.setStep(8, TOTAL);
        IF.setClap(pick.name); IF.setNotes(App.profile.tabOrder().map(k => (PRIORITY_TABS.find(t => t.key === k) || {}).label || k)); IF.focus('reel');
        await IF.type(redo ? 'Take the tour again?' : 'Last thing: a quick tour of each tab, in the order you picked. It’s a sandbox — nothing you do in it is saved.');
        t = await IF.choose([{ label: 'Take the tour', value: 'go' }, { label: redo ? 'No thanks' : 'Not now', value: 'no' }]);
        IF.close();
      }
      let tourResult = 'skipped';
      if (t.value === 'go') tourResult = await runTour();

      // ---- step 9: home, and the first page of the journal ----
      App.state.view = 'dashboard';
      save({ setupDone: prof.setupDone || today, tourDone: tourResult === 'done' ? today : (prof.tourDone || null) });
      // written once: a redo on the same day doesn't add a second copy
      const note = escHtml(fill(cfg.completion));
      const todays = ((App.state.data.journal || {})[App.state.user ? App.state.user.email : 'local'] || {})[today] || [];
      if ((!redo || t.value === 'go') && !todays.some(b => b.content === note)) App.journal.addNote(note);
      App.render();
      // the message is written in the Journal, so the Journal has to be there to read it
      if (!App.dashboard.getLayout().some(t => t.id === 'journal')) App.dashboard.addWidget('journal', 6, 0);
      await sleep(250);
      typeIntoJournal(note);            // plays while the bubble's up
      await coach.step({
        title: 'Setup complete', progress: '9 / ' + TOTAL,
        text: 'Wow.. Look at you!', face: true, noMascot: true,
        target: () => document.querySelector('.dw[data-wid="journal"]') || document.querySelector('.dash-hello'),
        next: 'Finish'
      });
      coach.close();
    }
  };
})();
