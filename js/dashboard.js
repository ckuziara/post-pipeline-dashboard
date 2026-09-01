/* Dashboard view — a personal workspace: greeting + daily quote, then a grid
   of widgets dealt from a role-specific layout. "Edit" turns on layout mode,
   where a tile can be dragged to swap places and resized by dragging an
   edge or corner — traditional tiling-window-manager logic, not a picker of
   canned sizes: growing a tile from an edge pushes whatever is in the way
   back in that same direction (grow right → push right; grow left → push
   left; grow down → push down), cascading through however many tiles are in
   the way. When a push runs out of room across the grid's 12 columns, the
   tile in the way drops below the grid instead of clipping or overlapping —
   see resolveCollisions. Width is a ratio of the page (1-12 twelfths) and
   height is a pixel value with much finer resolution than width, both
   continuous rather than a pick from three canned sizes. How much data a
   data-driven widget shows scales continuously with its height (see capOf).
   The whole layout (every widget's position and size) persists per device
   AND per role.
   Widgets: Priority (department roles), At Risk, Journal (js/journal.js),
   Delivered, Pipeline Status, Department & Team workload, Upcoming. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  const QUOTES = [
    ['Slow is smooth, and smooth is fast.', 'Every editor, eventually'],
    ['A deadline is just a dependency you can see from space.', 'Post Coordinator proverb'],
    ['It’s not late, it’s “in review”.', 'Anonymous'],
    ['Render twice, deliver once.', 'Pipeline wisdom'],
    ['The mix is never finished, only abandoned at QC.', 'Audio Post'],
    ['Approved is a state of mind. Also a status.', 'This app']
  ];

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const COLS = 12;          // columns in the grid — matches .dash-grid's math
  const GAP = 12;           // px gutter between tiles, inset from each cell's raw rect
  const HEIGHT_STEP = 12;   // px per resize step — fine-grained relative to a whole column

  /* Per-widget geometry limits. Width is in twelfths of the page (1-12);
     height is px. Both are continuous — a drag can land on any column or
     any few pixels, not one of three presets — and both are independently
     clamped (minW/maxW, minH/maxH) so a tile can't be dragged narrower than
     its content reads or shorter than its chrome needs.

     itemPx + headPx are what let a data-driven widget's row COUNT track its
     height continuously (see capOf) instead of jumping between three fixed
     counts: headPx is the fixed chrome (title, padding, any always-shown
     line), itemPx is what one more row of data costs. A widget without
     itemPx (journal, pipeline, delivered) doesn't scale its content by
     height at all — journal is a fixed notebook, pipeline always lists the
     same five statuses, and delivered's extra content is a WIDTH thing (see
     the `delivered` widget below), not a height one. */
  const WIDGETS = {
    priority:  { minW: 3, maxW: 12, minH: 140, maxH: 700, itemPx: 34, headPx: 90 },
    atRisk:    { minW: 3, maxW: 12, minH: 180, maxH: 900, itemPx: 52, headPx: 100 },
    journal:   { minW: 3, maxW: 12, minH: 260, maxH: 700 },
    delivered: { minW: 3, maxW: 12, minH: 120, maxH: 500 },
    pipeline:  { minW: 3, maxW: 12, minH: 140, maxH: 400 },
    deptLoad:  { minW: 3, maxW: 12, minH: 90,  maxH: 500, itemPx: 27, headPx: 45 },
    upcoming:  { minW: 3, maxW: 12, minH: 150, maxH: 900, itemPx: 52, headPx: 82 },
    teamLoad:  { minW: 3, maxW: 12, minH: 100, maxH: 700, itemPx: 36, headPx: 45 }
  };
  // how many data rows this widget shows at this height — grows continuously
  // rather than at three breakpoints; widgets without itemPx aren't scaled
  // by height at all (see the WIDGETS comment above)
  const capOf = (id, heightPx) => {
    const w = WIDGETS[id];
    if (!w.itemPx) return Infinity;
    return Math.max(1, Math.floor((heightPx - w.headPx) / w.itemPx));
  };
  // The inverse of capOf, for phone mode: rather than pick a pixel height
  // and let the row count fall out of it, pick the row count directly (5 —
  // a glance's worth) and derive the height capOf would need to show that
  // many, clamped to the widget's own min/max so it stays a height that
  // widget could legitimately have on desktop too.
  const PHONE_ROWS = 5;
  function phoneRows(id) {
    const w = WIDGETS[id];
    if (!w.itemPx) return w.minH;
    return clamp(w.headPx + PHONE_ROWS * w.itemPx, w.minH, w.maxH);
  }

  /* Who sees what. A department lead wants their own queue and little else; a
     producer or manager is accountable for the whole slate and wants the
     aggregates too. So the dashboard is dealt from one of three hands rather
     than showing everyone the same eight widgets:

       oversight  producers & managers — the queue plus every roll-up
       review     directors and anyone without a department — approvals-first
       dept       a single department's own queue, deliberately sparse: the
                  essentials, and room left over for the lighter widgets

     The Priority queue is a department widget only. Oversight and review roles
     get the aggregates instead — they're answerable for the shape of the whole
     slate, not for picking up the next task on one department's list.

     Chosen by capability, not by role name, so re-granting rights in
     Admin → Access Control moves someone's dashboard with them.

     Each entry is {id, col, row, w, h} — an explicit starting rectangle
     (col/w in twelfths, row/h in px), the same shape a saved layout takes.
     This is the one arrangement hand-laid out rather than derived; every
     other layout a person sees is this one plus whatever they've dragged. */
  const LAYOUTS = {
    oversight: [
      { id: 'atRisk',    col: 0, row: 0,   w: 6, h: 430 },
      { id: 'journal',   col: 6, row: 0,   w: 6, h: 420 },
      { id: 'pipeline',  col: 0, row: 442, w: 4, h: 175 },
      { id: 'teamLoad',  col: 4, row: 442, w: 4, h: 190 },
      { id: 'deptLoad',  col: 8, row: 442, w: 4, h: 130 },
      { id: 'upcoming',  col: 0, row: 644, w: 6, h: 400 },
      { id: 'delivered', col: 6, row: 644, w: 6, h: 150 }
    ],
    review: [
      { id: 'atRisk',    col: 0, row: 0,   w: 6, h: 430 },
      { id: 'journal',   col: 6, row: 0,   w: 6, h: 420 },
      { id: 'upcoming',  col: 0, row: 442, w: 6, h: 400 },
      { id: 'delivered', col: 6, row: 442, w: 6, h: 150 }
    ],
    dept: [
      { id: 'priority',  col: 0, row: 0,   w: 6, h: 250 },
      { id: 'journal',   col: 6, row: 0,   w: 6, h: 420 },
      { id: 'delivered', col: 0, row: 262, w: 4, h: 150 }
    ]
  };
  // the placeholder a popped-out widget leaves behind names it without having
  // to build the widget itself
  const WIDGET_TITLE = {
    priority: 'Priority', atRisk: 'At Risk', journal: 'Journal', delivered: 'Delivered Episodes',
    pipeline: 'Pipeline Status', deptLoad: 'Department Workload', upcoming: 'Upcoming Deliveries',
    teamLoad: 'Team Workload'
  };

  function layoutKind(role) {
    if (App.roleDept(role)) return 'dept';                                    // a department lead
    if (App.isAdminRole(role) && App.canApprove(role)) return 'oversight';    // producer / manager
    return 'review';
  }

  /* Priority buckets, worst first. `In Review` is pulled out ahead of the date
     buckets on purpose: it's already in someone's hands, so listing it under
     Overdue would read as a problem when it isn't one. */
  const PRIORITY_GROUPS = [
    { key: 'overdue',  label: 'Overdue',       sub: 'Past due, not done',       color: '#ff5b6e', open: true  },
    { key: 'today',    label: 'Due Today',     sub: 'Due by end of day',        color: '#fdab3d', open: true  },
    { key: 'week',     label: 'Due This Week', sub: 'Before the week is out',   color: '#f6be00', open: true  },
    { key: 'upcoming', label: 'Upcoming',      sub: 'Due later',                color: '#00c875', open: false },
    { key: 'review',   label: 'In Review',     sub: 'Currently being reviewed', color: '#a25ddc', open: true  }
  ];

  const rectsOverlap = (a, b) =>
    a.col < b.col + b.w && a.col + a.w > b.col && a.row < b.row + b.h && a.row + a.h > b.row;

  /* Traditional tiling-window-manager push: after `moved`'s rect has already
     been grown/shrunk on the `dir` edge (see wireResize), shove every other
     tile that now overlaps it further along that same axis — growing right
     pushes things right, growing down pushes things down, and so on.

     This has to cascade past direct contact with `moved`: pushing tile B
     out of the way can just as easily walk it into tile C, which then needs
     pushing too, and so on transitively. A queue does that properly — every
     tile that gets pushed is itself re-checked against everyone else before
     the pass ends — rather than only ever comparing against the original
     `moved` rect, which would leave B correctly clear of `moved` but still
     overlapping C. Bounded to a fixed number of steps as a safety net
     rather than proving termination; a real layout settles well inside it.

     Pushing sideways can run a tile off the 12-column grid — there's
     nowhere further to push it into. Rather than clip or overlap it, that
     tile drops to below whatever pushed it instead: "when a window size
     gets too small, shift widgets down to fit them all in." */
  function resolveCollisions(layout, movedId, dir) {
    const queue = [movedId];
    let guard = 0;
    while (queue.length && guard++ < 300) {
      // shift OUTSIDE the predicate — find() can probe the predicate once
      // per element it checks before matching, which would silently drain
      // several queue entries per pass instead of exactly one
      const nextId = queue.shift();
      const cur = layout.find(w => w.id === nextId);
      if (!cur) continue;   // defensive: a ref that no longer resolves shouldn't be able to crash the drag
      layout.forEach(w => {
        if (w === cur || !rectsOverlap(cur, w)) return;
        if (dir === 'r') {
          const push = (cur.col + cur.w) - w.col;
          if (w.col + push + w.w <= COLS) w.col += push;
          else w.row = cur.row + cur.h;
        } else if (dir === 'l') {
          const push = (w.col + w.w) - cur.col;
          if (w.col - push >= 0) w.col -= push;
          else w.row = cur.row + cur.h;
        } else if (dir === 'b') {
          w.row += (cur.row + cur.h) - w.row;
        } else if (dir === 't') {
          const push = (w.row + w.h) - cur.row;
          w.row = Math.max(0, w.row - push);
          if (w.row === 0 && rectsOverlap(cur, w)) w.row = cur.row + cur.h;
        }
        queue.push(w.id);
      });
    }
    return layout;
  }

  function clampTile(t) {
    const w = WIDGETS[t.id];
    t.w = clamp(t.w, w.minW, w.maxW);
    t.h = clamp(t.h, w.minH, w.maxH);
    t.col = clamp(t.col, 0, COLS - t.w);
    t.row = Math.max(0, t.row);
    return t;
  }

  /* Vertical compaction: every tile is pulled up to sit exactly GAP below
     whatever's directly above it in its own column span — or to row 0 if
     nothing is above it — so the space between tiles is always the same
     distance, never a leftover gap from wherever a push or a drag happened
     to leave it. Column and width are never touched here, only row, and
     tiles are processed top-to-bottom so each one settles against neighbours
     that have already been settled. Pure micro-adjustment: nothing here
     changes what's next to what, only how tightly it all sits — run after
     every drag, resize, and on every plain render, so the layout can't drift
     out of alignment over time. */
  function compact(layout) {
    const colBottom = new Array(COLS).fill(0);
    layout.slice().sort((a, b) => a.row - b.row).forEach(t => {
      t.row = Math.max(...colBottom.slice(t.col, t.col + t.w));
      for (let c = t.col; c < t.col + t.w; c++) colBottom[c] = t.row + t.h + GAP;
    });
    return layout;
  }

  App.dashboard = {
    // Layout editing is a mode, not an always-on affordance: widgets stay
    // inert until it's on, so nobody drags a tile while reading it. Session
    // state on purpose — you leave the dashboard, you leave edit mode.
    _editing: false,
    toggleEdit() { this._editing = !this._editing; App.render(); },

    /* ---- pop out a widget into its own window ----
       A real browser window, not an in-page panel: the point is to keep the
       Journal (or the priority queue) visible while working in another app, or
       on a second screen. Each popped widget gets its own window; the grid
       keeps a placeholder in its place so the layout doesn't silently reflow
       and there's an obvious way back.

       The widget is rebuilt into the window on every App.render, so a popped
       tile stays as live as a docked one. Session state — closing the tab
       closes the windows with it. */
    _pop: {},          // id -> { win, mount, pip }
    _pipId: null,      // which widget holds the single Picture-in-Picture window

    popped(id) { return !!this._pop[id]; },

    /* Two ways to get a floating window, in order of preference:

         Document Picture-in-Picture — a real always-on-top window, which is
         the point of popping a widget out: it stays visible over other apps.
         Chromium only, and only ONE at a time per page.

         window.open — everywhere else, and for a second widget once PiP is
         taken. Subject to the popup blocker, so it needs a real click.

       Either way it must run from a user gesture, which is why this is only
       ever reached from the button's own onclick. */
    async popOut(id) {
      if (this._pop[id]) { try { this._pop[id].win.focus(); } catch (e) {} return; }

      const usePiP = window.documentPictureInPicture && !this._pipId;
      let w = null;
      if (usePiP) {
        try {
          w = await window.documentPictureInPicture.requestWindow({ width: 460, height: 560 });
          this._pipId = id;
        } catch (e) { w = null; }                 // fall through to a plain window
      }
      if (!w) {
        w = window.open('', 'ppw_' + id, 'width=480,height=560');
        if (!w) {
          App.toast('Your browser blocked the pop-out window', true);
          if (this._pipId === id) this._pipId = null;
          return;
        }
      }

      const d = w.document;
      d.head.innerHTML = '';
      d.body.innerHTML = '';
      d.title = 'Post Pipeline — ' + (WIDGET_TITLE[id] || id);
      // borrow the app's own stylesheets and theme attributes, so the popped
      // widget is the same widget rather than an unstyled copy of its markup
      document.querySelectorAll('link[rel="stylesheet"], style').forEach(n => d.head.appendChild(n.cloneNode(true)));
      ['data-theme', 'data-mode', 'data-skin'].forEach(k => {
        const v = document.documentElement.getAttribute(k);
        if (v) d.documentElement.setAttribute(k, v);
      });
      const mount = d.createElement('div');
      mount.className = 'dash-pop';
      d.body.appendChild(mount);

      this._pop[id] = { win: w, mount: mount, pip: this._pipId === id };
      // however the window goes away — its own ✕, or the tab being closed
      w.addEventListener('pagehide', () => {
        delete this._pop[id];
        if (this._pipId === id) this._pipId = null;
        App.render();
      });
      App.render();
    },

    popIn(id) {
      const p = this._pop[id];
      if (!p) return;
      delete this._pop[id];
      if (this._pipId === id) this._pipId = null;
      try { p.win.close(); } catch (e) {}
      App.render();
    },

    // orphaned pop-outs outlive the page that was feeding them, so take them with us
    closeAllPops() {
      Object.keys(this._pop).forEach(id => { try { this._pop[id].win.close(); } catch (e) {} });
      this._pop = {};
      this._pipId = null;
    },

    // called at the end of each render: refill every open pop-out
    paintPops(m) {
      Object.keys(this._pop).forEach(id => {
        const p = this._pop[id];
        if (!p.win || p.win.closed) { delete this._pop[id]; return; }
        const t = this.getLayout().find(x => x.id === id) || { id: id, w: COLS, h: 320 };
        p.mount.innerHTML = '';
        // a pop-out is its own window, so it ignores the grid rect entirely
        const cellEl = this.cell({ id: id, w: t.w, h: t.h, col: 0, row: 0 }, m, true);
        p.mount.appendChild(cellEl);
      });
    },

    render(episodes) {
      const wrap = el('.dash');
      wrap.appendChild(this.greeting());

      if (!episodes.length) {
        const grid = el('.dash-grid');
        grid.appendChild(el('.empty', null, 'No episodes match the current filters.'));
        wrap.appendChild(grid);
        return wrap;
      }

      // ---- aggregate once, shared by the widgets ----
      const subs = [];
      episodes.forEach(ep => App.subsView(ep).forEach(su => subs.push({ ep, su })));
      const m = { episodes, subs, delivered: episodes.filter(App.isDelivered).length };

      if (App.isPhone()) { wrap.appendChild(this.renderPhone(m)); return wrap; }

      const grid = el('.dash-grid' + (this._editing ? '.editing' : ''));
      const layout = this.getLayout();
      layout.forEach(t => grid.appendChild(this.popped(t.id) ? this.popHolder(t) : this.cell(t, m)));
      // absolutely-positioned children don't contribute to a parent's auto
      // height, so the grid's own height is set explicitly from whatever the
      // layout actually uses
      grid.style.height = (Math.max(0, ...layout.map(t => t.row + t.h)) + GAP) + 'px';
      this.wireDrag(grid);
      if (this._editing) this.wireResize(grid);
      wrap.appendChild(grid);
      this.paintPops(m);
      return wrap;
    },

    // the gap a popped widget leaves behind: same rect, so nothing reflows,
    // and the only thing in it is the way back
    popHolder(t) {
      const cell = el('.dw.dw-holder', { style: this.rectStyle(t) });
      cell.dataset.wid = t.id;
      cell.appendChild(el('.widget.dw-holder-card', null, [
        el('.dw-holder-title', null, WIDGET_TITLE[t.id] || t.id),
        el('.dw-holder-note', null, 'Open in its own window'),
        el('button.dw-holder-btn', { type: 'button', onclick: () => this.popIn(t.id) }, 'Bring back')
      ]));
      return cell;
    },

    /* Phone mode: a plain top-to-bottom stack, nothing draggable or
       resizable — there's no pointer precision on a touch screen for
       grabbing a 4px resize handle, and no room to drag a tile sideways
       past its neighbours anyway at this width. Every tile is full width,
       in the same curated order LAYOUTS hand-lays-out for this role (not
       whatever a desktop drag session saved — that positioning answers a
       question, "where on a wide grid", that doesn't exist here).

       Reuses each widget's own body-building function unmodified, passing
       `w: 4` — the same width every widget already treats as "narrow" on
       desktop (a dept-chip's label drops, the sub-blurb drops, a donut
       drops in favour of just the number) — so "only the important
       details" is the existing narrow path, not a second one invented for
       phones specifically. Height is capped low on purpose (a handful of
       rows per list, via phoneRows below) rather than full desktop depth:
       the point of a phone dashboard is a glance, and a tap into the row
       (every list item already opens App.editTask) is the way to the rest. */
    renderPhone(m) {
      const ids = LAYOUTS[layoutKind(App.state.role)].map(t => t.id);
      const stack = el('.dash-phone');
      ids.forEach(id => {
        const built = this[id](m, { w: 4, h: phoneRows(id) });
        stack.appendChild(el('.widget', null, [
          el('.widget-head', null, [
            el('.dw-head-l', null, el('.widget-title', null, built.title)),
            built.sub ? el('.widget-sub', null, built.sub) : null
          ]),
          el('.widget-body' + (built.bare ? '.bare' : ''), null, built.body)
        ]));
      });
      return stack;
    },

    // Layout is per device AND per role — one person switching hats
    // shouldn't drag a producer's layout onto a creative's.
    layoutKey() { return 'dashLayout:' + App.state.role; },

    /* The working layout. With no save yet, that's just the hand-laid-out
       default (LAYOUTS) verbatim — its positions are curated, not something
       to re-derive. Once a save exists, it wins, filtered to widgets this
       role still gets and re-clamped in case a widget's own min/max changed
       since it was saved; anything the role gets that isn't in the save
       (newly added since) drops in below everything else rather than being
       left out. */
    getLayout() {
      const dflt = LAYOUTS[layoutKind(App.state.role)];
      const saved = App.prefs.get(this.layoutKey(), null);
      if (!saved) return compact(dflt.map(d => clampTile(Object.assign({}, d))));

      const allowed = dflt.map(d => d.id);
      const layout = saved
        .filter(t => WIDGETS[t.id] && allowed.includes(t.id))
        .map(t => clampTile(Object.assign({}, t)));
      const have = new Set(layout.map(t => t.id));
      dflt.forEach(d => {
        if (have.has(d.id)) return;
        const bottom = layout.length ? Math.max(...layout.map(t => t.row + t.h)) + GAP : 0;
        layout.push(clampTile(Object.assign({}, d, { row: bottom })));
      });
      // always re-compact on the way out: a saved layout can drift out of
      // tight alignment (a widget's min/max changed, one was dropped in
      // above), so every read re-settles it rather than trusting storage
      return compact(layout);
    },
    saveLayout(layout) {
      App.prefs.set(this.layoutKey(), layout.map(t => ({ id: t.id, col: t.col, row: t.row, w: t.w, h: t.h })));
    },

    greeting() {
      const user = App.state.user;
      const name = user ? user.name.split(' ')[0] : App.role(App.state.role).label;
      // App.today() zeroes the clock (it's a date, for day-boundary math) — the
      // greeting needs the actual wall-clock hour, so it reads real time directly
      const h = new Date().getHours();
      const hello = h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
      const q = QUOTES[dayIndex() % QUOTES.length];
      const editing = this._editing;
      return el('.dash-hello', null, [
        el('div', null, [
          el('.dash-hi', null, hello + ', ' + name + '!'),
          el('.dash-quote', null, ['“' + q[0] + '”', el('span.qa', null, ' — ' + q[1])])
        ]),
        // there's nothing to drag or resize on a phone stack, so the whole
        // edit-layout affordance — which only makes sense against the
        // desktop tiling grid — doesn't get offered
        (App.isPhone() ? null : el('.dash-tools', null, [
          (editing ? el('button.ghost.dash-reset', {
            title: 'Put every widget back to its default size and position',
            onclick: () => {
              App.prefs.set(this.layoutKey(), null);
              App.render();
            }
          }, 'Reset layout') : null),
          el('button' + (editing ? '.btn-primary' : '.ghost'), {
            title: editing ? 'Finish editing the layout' : 'Move and resize widgets',
            onclick: () => this.toggleEdit()
          }, editing ? '✓ Done' : [App.icon('pencil'), ' Edit'])
        ]))
      ]);
    },

    // px rect for a tile, gutter already subtracted — the single source of
    // truth both the initial render and every live resize preview draw from
    rectStyle(t) {
      return {
        left: 'calc(' + (t.col / COLS * 100) + '% + ' + (GAP / 2) + 'px)',
        width: 'calc(' + (t.w / COLS * 100) + '% - ' + GAP + 'px)',
        top: (t.row + GAP / 2) + 'px',
        height: (t.h - GAP) + 'px'
      };
    },

    /* one tile: uniform chrome (grip + title + sub) around a widget body.
       `t` is {id, col, row, w, h} — col/w in twelfths, row/h in px. The
       whole grid is absolutely positioned (see .dash-grid in style.css) so
       every tile can sit at an exact, independent rectangle instead of
       flowing through CSS grid tracks — that's what lets a resize push
       neighbours by an exact amount rather than only ever repacking into
       rows. The card stretches to fill its rect (`.widget { height: 100% }`)
       rather than sizing to its own content, so a short widget's leftover
       height never shows up as a hole — internal content that doesn't fill
       it just leaves calm padding, and `.widget-body` scrolls on the rare
       overflow. `.dw-narrow` swaps in a denser layout below a width
       threshold — see the widget builders below, which key off `t.w`
       directly for anything wider or richer. In edit mode the tile becomes
       the drag handle and grows thin edge and corner zones; the body goes
       inert so arranging can't touch a widget's content. */
    cell(t, m, popped) {
      const built = this[t.id](m, t);        // -> { title, sub, body, bare }
      const editing = this._editing && !popped;
      const cell = el('.dw' + (t.w <= 4 ? '.dw-narrow' : '') + (editing ? '.dw-editable' : '') + (popped ? '.dw-popped' : ''), {
        // a pop-out owns its whole window, so it takes no grid rect
        style: popped ? null : this.rectStyle(t)
      });
      cell.dataset.wid = t.id;
      /* Pop-out / dock lives in the head next to the sub-label. Hidden while
         editing: that mode is about arranging the grid, and a widget that has
         left the grid isn't part of that. */
      const popBtn = editing ? null : el('button.dw-pop', {
        type: 'button',
        title: popped ? 'Put this widget back on the dashboard' : 'Open this widget in its own window',
        onclick: (e) => { e.stopPropagation(); popped ? this.popIn(t.id) : this.popOut(t.id); }
      }, popped ? '⤡' : '⤢');
      cell.appendChild(el('.widget', null, [
        el('.widget-head', null, [
          el('.dw-head-l', null, [
            (editing ? el('span.dw-grip', { title: 'Drag to move — drop anywhere, even empty space' }, '⠿') : null),
            el('.widget-title', null, built.title)
          ]),
          el('.dw-head-r', null, [
            built.sub ? el('.widget-sub', null, built.sub) : null,
            popBtn
          ])
        ]),
        el('.widget-body' + (built.bare ? '.bare' : ''), null, built.body)
      ]));
      if (editing) {
        const tip = 'Drag an edge or corner to resize — pushes whatever is in the way';
        // an edge grabs one axis, a corner either; both are just hairlines on hover
        ['t', 'r', 'b', 'l'].forEach(side => {
          const z = el('span.dw-edge.e-' + side, { title: tip });
          z.dataset.grab = side;
          cell.appendChild(z);
        });
        ['tl', 'tr', 'bl', 'br'].forEach(c => {
          const z = el('span.dw-corner.c-' + c, { title: tip });
          z.dataset.grab = c;
          cell.appendChild(z);
        });
        cell.appendChild(el('span.dw-size', null, Math.round(t.w / COLS * 100) + '% · ' + t.h + 'px'));
      }
      return cell;
    },

    /* ---- resize by dragging an edge or a corner: traditional tiling logic ----
       Only the grabbed edge moves — the opposite edge stays put, so dragging
       the LEFT edge out grows the tile leftward instead of just widening it
       from a fixed left edge, and likewise for every other edge. Whatever
       that growth now overlaps gets pushed further along the same axis (see
       resolveCollisions), cascading through however many tiles are in the
       way; a push that would run off the grid instead drops the tile below.
       Width moves in whole columns (tracking the cursor 1:1 against the
       grid's own column width); height moves in small HEIGHT_STEP px steps
       — finer resolution than width, since a stray few px of height rarely
       matters but a stray column visibly misaligns the grid. A corner drags
       both axes and pushes on both. */
    wireResize(grid) {
      let d = null;

      grid.addEventListener('pointerdown', (e) => {
        const z = e.target.closest('.dw-edge, .dw-corner');
        if (!z) return;
        const cellEl = z.closest('.dw');
        e.preventDefault();
        d = {
          id: cellEl.dataset.wid, cellEl, grab: z.dataset.grab, x: e.clientX, y: e.clientY,
          start: this.getLayout(), colPx: grid.getBoundingClientRect().width / COLS
        };
        cellEl.classList.add('dw-resizing');
        // The tile is draggable for reordering, and a native drag starting here
        // would fire pointercancel and kill the resize mid-gesture. Turn the
        // move affordance off for the duration of this drag.
        cellEl.removeAttribute('draggable');
        // capture keeps the drag alive past the grid's edge; harmless if the
        // pointer is already gone (synthetic events, a released touch)
        try { z.setPointerCapture(e.pointerId); } catch (err) {}
      });

      grid.addEventListener('pointermove', (e) => {
        if (!d) return;
        const w = WIDGETS[d.id];
        const dCols = Math.round((e.clientX - d.x) / d.colPx);
        const dRows = Math.round((e.clientY - d.y) / HEIGHT_STEP) * HEIGHT_STEP;
        const grab = d.grab;

        // fresh copy of the pre-drag layout every move, not cumulative on
        // top of the last preview — otherwise dragging out then back in
        // isn't 1:1 with the cursor
        const next = d.start.map(t => Object.assign({}, t));
        const t = next.find(x => x.id === d.id);

        if (grab.indexOf('r') >= 0) t.w = clamp(t.w + dCols, w.minW, w.maxW);
        if (grab.indexOf('l') >= 0) {
          const nw = clamp(t.w - dCols, w.minW, w.maxW);
          t.col = clamp(t.col + (t.w - nw), 0, COLS - nw);
          t.w = nw;
        }
        if (grab.indexOf('b') >= 0) t.h = clamp(t.h + dRows, w.minH, w.maxH);
        if (grab.indexOf('t') >= 0) {
          const nh = clamp(t.h - dRows, w.minH, w.maxH);
          t.row = Math.max(0, t.row + (t.h - nh));
          t.h = nh;
        }
        if (grab.indexOf('r') >= 0) resolveCollisions(next, d.id, 'r');
        if (grab.indexOf('l') >= 0) resolveCollisions(next, d.id, 'l');
        if (grab.indexOf('b') >= 0) resolveCollisions(next, d.id, 'b');
        if (grab.indexOf('t') >= 0) resolveCollisions(next, d.id, 't');

        d.to = next;
        // live preview: every tile the push touched moves, not just the one
        // being dragged
        next.forEach(nt => {
          const el2 = grid.querySelector('.dw[data-wid="' + nt.id + '"]');
          if (!el2) return;
          Object.assign(el2.style, this.rectStyle(nt));
          el2.classList.toggle('dw-narrow', nt.w <= 4);
        });
        grid.style.height = (Math.max(0, ...next.map(x => x.row + x.h)) + GAP) + 'px';
        const badge = d.cellEl.querySelector('.dw-size');
        if (badge) badge.textContent = Math.round(t.w / COLS * 100) + '% · ' + t.h + 'px';
      });

      const finish = () => {
        if (!d) return;
        const cur = d;
        d = null;
        cur.cellEl.classList.remove('dw-resizing');
        cur.cellEl.setAttribute('draggable', 'true');
        if (cur.to) this.saveLayout(cur.to);
        App.render();                  // rebuild from the saved layout, narrow classes and all
      };
      grid.addEventListener('pointerup', finish);
      grid.addEventListener('pointercancel', finish);
    },

    /* ---- drag to move — iPhone-springboard logic (pointer-driven, edit
       mode only) ----
       The dragged tile rides under the cursor at the exact pixel position,
       ignoring the grid entirely (`.dw-dragging` gets no CSS transition, so
       there's zero lag). Every OTHER tile, though, is free to land anywhere
       in real, empty space — hovering over an occupied spot pushes whatever
       is there downward to make room, live, on every pointermove, the same
       way iOS shuffles icons out from under your thumb while you're still
       holding one; moving away un-pushes them, because each move recomputes
       from the untouched pre-drag layout rather than the previous preview
       (see wireResize for the same reasoning). Those other tiles DO get a
       CSS transition (see `.dw` in style.css), so the making-room reads as
       a slide, not a snap. Dropping on genuinely empty ground pushes
       nothing — the tile just lands there. */
    wireDrag(grid) {
      let d = null;

      grid.addEventListener('pointerdown', (e) => {
        const grip = e.target.closest('.dw-grip');
        if (!grip) return;
        const cellEl = grip.closest('.dw');
        e.preventDefault();
        const layout = this.getLayout();
        const tile = layout.find(t => t.id === cellEl.dataset.wid);
        const gridRect = grid.getBoundingClientRect();
        const cellRect = cellEl.getBoundingClientRect();
        d = {
          id: tile.id, cellEl, layout, tile,
          offX: e.clientX - cellRect.left, offY: e.clientY - cellRect.top,
          colPx: gridRect.width / COLS, lastCol: tile.col, lastRow: tile.row
        };
        cellEl.classList.add('dw-dragging');
        try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      });

      grid.addEventListener('pointermove', (e) => {
        if (!d) return;
        const gridRect = grid.getBoundingClientRect();
        // the dragged tile itself: raw cursor-relative px, no grid snap —
        // it should feel like it's riding directly under the pointer
        const px = e.clientX - gridRect.left - d.offX;
        const py = e.clientY - gridRect.top - d.offY;
        d.cellEl.style.left = px + 'px';
        d.cellEl.style.top = py + 'px';

        const col = clamp(Math.round(px / d.colPx), 0, COLS - d.tile.w);
        const row = Math.max(0, Math.round(py));
        if (col === d.lastCol && row === d.lastRow) return;   // proposed cell hasn't changed — skip the re-pack
        d.lastCol = col; d.lastRow = row;

        // fresh copy of the PRE-DRAG layout every move, not the previous
        // preview — so moving away from a spot un-pushes it instead of the
        // push compounding
        const next = d.layout.map(t => Object.assign({}, t));
        const moved = next.find(t => t.id === d.id);
        moved.col = col; moved.row = row;
        resolveCollisions(next, d.id, 'b');   // shove anything in the way down to make room
        d.preview = next;

        next.forEach(t => {
          if (t.id === d.id) return;   // its DOM is driven by raw px above, not this
          const el2 = grid.querySelector('.dw[data-wid="' + t.id + '"]');
          if (!el2) return;
          Object.assign(el2.style, this.rectStyle(t));
          el2.classList.toggle('dw-narrow', t.w <= 4);
        });
        grid.style.height = (Math.max(row + d.tile.h, ...next.map(t => t.row + t.h)) + GAP) + 'px';
      });

      const finishDrag = () => {
        if (!d) return;
        const cur = d;
        d = null;
        cur.cellEl.classList.remove('dw-dragging');
        if (cur.preview) this.saveLayout(cur.preview.map(clampTile));
        App.render();
      };
      grid.addEventListener('pointerup', finishDrag);
      grid.addEventListener('pointercancel', finishDrag);
    },

    /* ------------------------------------------------------- widgets ---- */

    /* Priority — what to pick up, in the order to pick it up. Grouped by how
       soon it's due rather than listed flat, so "two things are late" reads at
       a glance instead of having to compare dates. Empty groups are dropped: no
       row for Overdue is the clearest way to say nothing is overdue.

       Scoped to the signed-in person's own assignments. It's a personal to-do
       list, not a department report — a lead shouldn't have to pick their own
       work out of their whole team's. Anyone we can't match to a directory
       person (offline demo, an admin who isn't on the team list) has no
       assignments to filter by, so they keep the old department queue. */
    priority(m, t) {
      const meId = App.state.user && App.state.user.personId;
      const dept = App.roleDept(App.state.role);
      const scoped = meId ? m.subs.filter(x => x.su.assignee === meId)
                    : dept ? m.subs.filter(x => x.su.dept === dept)
                    : m.subs;
      const todayIso = App.isoDate(App.today());
      // "this week" means the calendar week you're in, not a rolling seven days
      // — on a Thursday it's Friday and Sunday, not the whole of next week.
      const today = App.today();
      const weekIso = App.isoDate(App.addDays(today, 7 - (((today.getDay() + 6) % 7) + 1)));

      const buckets = {};
      PRIORITY_GROUPS.forEach(g => { buckets[g.key] = []; });
      scoped.forEach(x => {
        if (x.su.status === 'approved') return;                      // done, not a priority
        if (x.su.status === 'review') { buckets.review.push(x); return; }
        if (x.su.due < todayIso) buckets.overdue.push(x);
        else if (x.su.due === todayIso) buckets.today.push(x);
        else if (x.su.due <= weekIso) buckets.week.push(x);
        else buckets.upcoming.push(x);
      });
      Object.keys(buckets).forEach(k => buckets[k].sort((a, b) => a.su.due < b.su.due ? -1 : 1));

      const groups = PRIORITY_GROUPS.filter(g => buckets[g.key].length)
        .map(g => this.priorityGroup(g, buckets[g.key], t));
      const open = scoped.filter(x => x.su.status !== 'approved').length;

      return {
        title: 'Priority',
        sub: (meId ? 'Assigned to you' : dept ? App.dept(dept).label : 'across the slate') + ' · ' + open + ' open',
        body: groups.length ? el('.pr-list', null, groups)
          : el('.dw-calm', null, meId && !scoped.length
              ? 'Nothing assigned to you right now.'
              : 'Nothing outstanding — all clear.')
      };
    },

    priorityGroup(g, items, t) {
      const pkey = 'dashPri:' + g.key;
      const open = App.prefs.get(pkey, g.open);
      const box = el('.pr-group', { style: { borderLeftColor: g.color } });

      box.appendChild(el('button.pr-head', {
        type: 'button',
        onclick: () => { App.prefs.set(pkey, !open); App.render(); }
      }, [
        el('span.chev' + (open ? '.open' : ''), null, '▶'),
        el('span.pr-label', null, g.label),
        (t.w <= 4 ? null : el('span.pr-sub', null, g.sub)),   // no room for the blurb when narrow
        el('span.pr-count', { style: { color: g.color } }, String(items.length))
      ]));

      if (open) {
        const rows = el('.pr-rows');
        // capped to what the tile can actually hold at this height
        const cap = capOf('priority', t.h);
        items.slice(0, cap).forEach(({ ep, su }) => {
          const st = App.status(su.status);
          rows.appendChild(el('.pr-row', {
            title: ep.title + ' — ' + su.name + ' · due ' + App.fmtDate(su.due),
            onclick: () => App.editTask.open(ep.id, su.key)
          }, [
            el('span.pr-code', null, ep.code),
            el('span.pr-task', null, '(' + su.name + ')'),
            el('span.pr-date', null, App.fmtDate(su.due)),
            el('span.pr-chip', { style: { background: st.color, color: st.ink } }, st.label)
          ]));
        });
        if (items.length > cap) rows.appendChild(el('.pr-more', null, '+' + (items.length - cap) + ' more'));
        box.appendChild(rows);
      }
      return box;
    },

    journal() {
      return { title: 'Journal', sub: 'your daily notes', body: App.journal.render(), bare: true };
    },

    atRisk(m, t) {
      const items = [];
      const todayIso = App.isoDate(App.today());
      m.subs.forEach(({ ep, su }) => {
        if (su.status === 'approved') return;
        const overdue = su.due < todayIso;
        const blocked = App.isRiskBlocked(ep, su.key);
        if (overdue || blocked) items.push({ ep, su, overdue, blocked, late: App.daysUntil(su.due) });
      });
      items.sort((a, b) => a.late - b.late);
      const narrow = t.w <= 4;
      const cap = capOf('atRisk', t.h);
      const body = items.length ? el('.risk-list', null, items.slice(0, cap).map(x => {
        const dep = App.dept(x.su.dept);
        return el('.risk-item', {
          title: dep.label + ' — ' + x.su.name + ' · ' + x.ep.code + ' ' + x.ep.title + ' · due ' + App.fmtDate(x.su.due),
          onclick: () => App.editTask.open(x.ep.id, x.su.key)
        }, [
          (narrow ? el('span.dot', { style: { background: dep.color, width: '8px', height: '8px', borderRadius: '50%', flex: 'none' } })
            : el('span.dept-chip', { style: { padding: '1px 7px', fontSize: '10px' } }, [el('span.dot', { style: { background: dep.color } }), dep.label])),
          el('.ri-main', null, [
            el('.ri-title', null, x.su.name + '  ·  ' + x.ep.code),
            (narrow ? null : el('.ri-sub', null, x.ep.title + ' — due ' + App.fmtDate(x.su.due)))
          ]),
          riChatBtn(x.ep.id, x.su.key),
          x.overdue ? el('span.ri-tag.over', null, Math.abs(x.late) + 'd overdue') : null,
          x.blocked ? el('span.ri-tag.blk', null, 'blocked') : null
        ]);
      })) : el('.dw-calm', null, '✓  Smooth sailing.');
      if (items.length > cap) body.appendChild(el('.pr-more', null, '+' + (items.length - cap) + ' more'));
      return { title: 'At Risk', sub: items.length + ' overdue or blocked', body };
    },

    delivered(m, t) {
      const total = m.episodes.length;
      const pct = total ? Math.round(m.delivered / total * 100) : 0;
      const figure = el('div', null, [
        el('.big-num', null, [String(m.delivered), el('span.of', null, ' / ' + total)]),
        el('.widget-sub', { style: { marginTop: '4px' } }, pct + '% of the slate delivered')
      ]);
      // narrow drops the donut (the number is the point); a wide tile earns a
      // per-show breakdown of where the delivered episodes actually came from
      const body = el('.donut-wrap', null, [(t.w <= 4 ? null : donut(pct, '#00c875')), figure]);
      if (t.w >= 9) {
        const rows = App.activeShows().map(sh => {
          const eps = m.episodes.filter(ep => ep.showId === sh.id);
          return { sh: sh, done: eps.filter(App.isDelivered).length, n: eps.length };
        }).filter(r => r.n).sort((a, b) => b.done - a.done);
        const list = el('.dw-split', null, rows.map(r => el('.bar-row', null, [
          el('.bl', null, [el('span.swatch', { style: { width: '11px', height: '11px', borderRadius: '3px', background: r.sh.color, display: 'inline-block' } }), r.sh.name]),
          el('.bt', null, [el('.bf', { style: { width: Math.round(r.done / r.n * 100) + '%', background: r.sh.color } })]),
          el('.bv', null, r.done + '/' + r.n)
        ])));
        return { title: 'Delivered Episodes', sub: 'fully approved', body: el('.dw-wide', null, [body, list]) };
      }
      return { title: 'Delivered Episodes', sub: 'fully approved', body: body };
    },

    pipeline(m, t) {
      const count = { not_started: 0, ready: 0, in_progress: 0, review: 0, approved: 0 };
      m.subs.forEach(x => count[x.su.status]++);
      const rows = App.STATUS_ORDER.map(sk => {
        const s = App.STATUSES[sk], v = count[sk] || 0;
        const pct = m.subs.length ? Math.round(v / m.subs.length * 100) : 0;
        return el('.bar-row', null, [
          el('.bl', { title: s.label + ' — ' + v + ' of ' + m.subs.length }, [el('span.swatch', { style: { width: '11px', height: '11px', borderRadius: '3px', background: s.color, display: 'inline-block' } }), s.label]),
          el('.bt', null, [el('.bf', { style: { width: pct + '%', background: s.color } })]),
          el('.bv', null, t.w <= 4 ? String(v) : v + '  ' + pct + '%')
        ]);
      });
      return { title: 'Pipeline Status', sub: m.subs.length + ' subitems', body: rows };
    },

    deptLoad(m, t) {
      const active = m.subs.filter(x => x.su.status !== 'approved');
      const max = Math.max(1, ...Object.keys(App.DEPARTMENTS).map(k => active.filter(x => x.su.dept === k).length));
      const rows = Object.keys(App.DEPARTMENTS)
        .map(dk => ({ d: App.dept(dk), n: active.filter(x => x.su.dept === dk).length }))
        .filter(r => r.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, capOf('deptLoad', t.h))
        .map(r => el('.bar-row', null, [
          el('.bl', null, [el('span.swatch', { style: { width: '11px', height: '11px', borderRadius: '3px', background: r.d.color, display: 'inline-block' } }), r.d.label]),
          el('.bt', null, [el('.bf', { style: { width: Math.round(r.n / max * 100) + '%', background: r.d.color } })]),
          el('.bv', null, String(r.n))
        ]));
      return { title: 'Department Workload', sub: 'open subitems', body: rows.length ? rows : el('.dw-calm', null, 'Nothing open.') };
    },

    teamLoad(m, t) {
      const editors = App.state.data.people.filter(p => App.roleDept(p.role));
      const rows = editors.map(p => {
        const mine = m.subs.filter(x => x.su.assignee === p.id);
        const activeN = mine.filter(x => ['ready', 'in_progress', 'review'].includes(x.su.status)).length;
        const wip = mine.filter(x => x.su.status === 'in_progress').length;
        return { p, activeN, wip };
      }).filter(r => r.activeN > 0).sort((a, b) => b.activeN - a.activeN).slice(0, capOf('teamLoad', t.h));
      const max = Math.max(1, ...rows.map(r => r.activeN));
      const body = rows.length ? rows.map(r => el('.bar-row', null, [
        el('.bl', null, [
          el('span.avatar', { style: { width: '20px', height: '20px', fontSize: '8px', background: r.p.color } }, App.initials(r.p.name)),
          r.p.name.split(' ')[0]
        ]),
        el('.bt', null, [el('.bf', { style: { width: Math.round(r.activeN / max * 100) + '%', background: r.wip ? 'var(--st-in_progress)' : 'var(--accent)' } })]),
        el('.bv', null, r.activeN + (r.wip ? ' · ' + r.wip + '▶' : ''))
      ])) : el('.dw-calm', null, 'No active assignments.');
      return { title: 'Team Workload', sub: 'live tasks per editor', body };
    },

    upcoming(m, t) {
      const narrow = t.w <= 4;
      const list = m.episodes.filter(ep => !App.isDelivered(ep))
        .map(ep => ({ ep, due: App.epDue(ep) }))
        .sort((a, b) => a.due < b.due ? -1 : 1).slice(0, capOf('upcoming', t.h));
      const body = list.length ? el('.risk-list', null, list.map(x => {
        const show = App.show(x.ep.showId);
        const days = App.daysUntil(x.due);
        // same "current focus" pick as App.epStatusLabel — the task the sub-line
        // names is the one a click should land on, falling back to whatever's
        // first when nothing's actively moving yet
        const subs = App.subitems(x.ep);
        const focus = subs.find(s => s.status === 'in_progress') || subs.find(s => s.status === 'review') || subs[0];
        return el('.risk-item', {
          title: x.ep.code + ' · ' + x.ep.title + ' — ' + show.name + ' · ' + App.progressPct(x.ep) + '% complete',
          onclick: focus ? () => App.editTask.open(x.ep.id, focus.key) : null
        }, [
          el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color), fontSize: '10px', padding: '2px 7px' } }, x.ep.code),
          el('.ri-main', null, [
            el('.ri-title', null, narrow ? x.ep.title : x.ep.title + '  ·  ' + show.name),
            (narrow ? null : el('.ri-sub', null, App.progressPct(x.ep) + '% complete · ' + App.epStatusLabel(x.ep)))
          ]),
          focus ? riChatBtn(x.ep.id, focus.key) : null,
          el('span.ri-tag' + (days < 0 ? '.over' : ''), { style: days >= 0 ? { background: 'var(--surface-3)', color: 'var(--text-2)' } : {} },
            days < 0 ? Math.abs(days) + 'd late' : days === 0 ? 'today' : 'in ' + days + 'd')
        ]);
      })) : el('.dw-calm', null, 'No outstanding deliveries.');
      return { title: 'Upcoming Deliveries', sub: 'next episodes to land', body };
    }
  };

  // A shortcut into a task's Discussion tab from a risk-list row, without
  // making the whole row a two-destination click: it stops propagation so it
  // doesn't also fire the row's own onclick (which opens the same dialog on
  // Details).
  function riChatBtn(epId, taskKey) {
    return el('button.ri-chat', {
      title: 'Open discussion', type: 'button',
      onclick: (e) => { e.stopPropagation(); App.editTask.open(epId, taskKey, { tab: 'chat' }); }
    }, App.icon('chat'));
  }

  // deterministic day index (no Math.random at module load)
  function dayIndex() { const t = App.today(); return Math.floor((t - new Date(t.getFullYear(), 0, 0)) / 86400000); }

  // tiny SVG donut
  function donut(pct, color) {
    const r = 30, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '78'); svg.setAttribute('height', '78'); svg.setAttribute('viewBox', '0 0 78 78');
    const mk = (stroke, dash) => {
      const ci = document.createElementNS(ns, 'circle');
      ci.setAttribute('cx', '39'); ci.setAttribute('cy', '39'); ci.setAttribute('r', String(r));
      ci.setAttribute('fill', 'none'); ci.setAttribute('stroke', stroke); ci.setAttribute('stroke-width', '9');
      if (dash != null) { ci.setAttribute('stroke-dasharray', String(c)); ci.setAttribute('stroke-dashoffset', String(dash)); ci.setAttribute('stroke-linecap', 'round'); ci.setAttribute('transform', 'rotate(-90 39 39)'); }
      return ci;
    };
    svg.appendChild(mk('rgba(255,255,255,.09)'));
    svg.appendChild(mk(color, off));
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', '39'); txt.setAttribute('y', '44'); txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('fill', '#e7e9f0'); txt.setAttribute('font-size', '16'); txt.setAttribute('font-weight', '800');
    txt.textContent = pct + '%';
    svg.appendChild(txt);
    return svg;
  }
})();
