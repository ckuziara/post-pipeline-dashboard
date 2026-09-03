/* Timeline (Gantt) view — swimlanes grouped by episode status, week/day column
   header, a live "today" line, and click-to-expand episode → subitem bars.
   Uses event delegation and centralized scroll state to prevent view jank. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const LABEL_W = 220;   // must match .g-label width in style.css

  /* Portrait (Timeline View preference, Department sort only — see render()):
     time runs top-to-bottom instead of left-to-right. These four are portrait's
     mirror of LABEL_W — same "must match style.css" contract, just for the
     axis that's now vertical. Not derived from anything; sized for a vertical
     bar plus a short label to stay legible, per the "enough width" ask. */
  const COL_W = 96;        // must match .gantt-portrait .g-row width in style.css
  const SUB_COL_W = 76;    // must match .gantt-portrait .g-row.sub width
  const DATE_RAIL_W = 78;  // must match .date-rail width
  const COL_HEAD_H = 44;   // must match .gantt-portrait .g-label / .th-corner height

  /* Writes a bar's position along the time axis. The pixel VALUES are always
     xOf(iso)/xOf.width(s,d) — colOf/dw don't care which screen axis time is
     drawn on — only which CSS property they land in changes. Centralizes what
     used to be nine separate `{ left: xOf(s)+'px', width: ... }` literals so
     Portrait didn't mean writing a tenth, eleventh, ... variant by hand. */
  function setBarPos(style, axis, xOf, s, d) {
    if (axis && axis.portrait) { style.top = xOf(s) + 'px'; style.height = xOf.width(s, d) + 'px'; }
    else { style.left = xOf(s) + 'px'; style.width = xOf.width(s, d) + 'px'; }
  }

  // ---- ISO week helpers ----
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - day + 3);
    const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const fday = (firstThu.getUTCDay() + 6) % 7;
    firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
    return 1 + Math.round((t - firstThu) / (7 * 86400000));
  }
  const mondayOf = (d) => App.addDays(d, -(((d.getDay() + 6) % 7)));
  const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const MON = (d) => d.toLocaleDateString('en-US', { month: 'short' });

  // header granularity by zoom (px/day): days → weeks → months → quarters → years
  function tierFor(dw) {
    if (dw >= 15) return { primary: 'weeks', secondary: 'days' };
    if (dw >= 6) return { primary: 'months', secondary: 'weeks' };
    if (dw >= 2.2) return { primary: 'quarters', secondary: 'months' };
    return { primary: 'years', secondary: 'quarters' };
  }
  function clampZoom(z) { return Math.max(1.4, Math.min(60, z)); }

  /* Zoomed out to quarters, the chart is read as shape rather than detail.

     A day is under 6px there, so a task's label has no room to be a word and a
     milestone's single day is a sliver with a letter jammed in it. Both stop
     being information and become noise laid over the thing you zoomed out to
     see, so the coarse view drops them and lets the bars carry it. Nothing is
     lost: the tooltips still say everything, and zooming back in brings the
     detail with it. Tied to the header tier so there's one definition of
     "zoomed out" rather than a second threshold to keep in step. */
  function isCoarse(dw) {
    const t = tierFor(dw).primary;
    return t === 'quarters' || t === 'years';
  }

  /* Telling a click apart from a drag or a hold.

     A press that moves past DRAG_SLOP, or is held for HOLD_MS without moving,
     was a gesture — not a click — so it must not also trigger the click action
     (opening Edit Task). The browser fires `click` after `mouseup` regardless,
     and it used to be swallowed by accident: applying a move re-rendered the
     chart, destroying the element the click was headed for. A move that now
     stops to ask for confirmation leaves the DOM in place, so the click landed
     and Edit Task opened over the question. The suppression below is explicit
     rather than relying on that. HOLD_MS is generous — a deliberate click can
     be slow, and refusing to open Edit Task for one would feel broken. */
  const DRAG_SLOP = 3;      // px of travel that makes it a drag
  const HOLD_MS = 400;      // press longer than this reads as a grab, not a click

  /* ---- Shift-selection ----
     A group of task bars held aside so one drag can move or resize all of them.
     Identity is (episode, task), not the DOM node: every render rebuilds the
     bars, and in the Show and Department sorts one line carries bars from many
     episodes, so a selection has to survive both. Kept as a flat string set for
     cheap membership tests during a drag, which runs on every mouse move. */
  const selKey = (epId, suKey) => epId + '|' + suKey;
  const selList = () => (App.state.ganttSel = App.state.ganttSel || []);
  function selHas(epId, suKey) { return selList().indexOf(selKey(epId, suKey)) !== -1; }
  function selToggle(epId, suKey) {
    const k = selKey(epId, suKey), list = selList(), i = list.indexOf(k);
    if (i === -1) list.push(k); else list.splice(i, 1);
    return i === -1;
  }
  function selAdd(epId, suKey) {
    const k = selKey(epId, suKey), list = selList();
    if (list.indexOf(k) === -1) list.push(k);
  }
  function selClear() { App.state.ganttSel = []; }
  // (epId, suKey) pairs for the current selection, dropping anything the board
  // no longer has — a teammate can delete a task while it sits selected here
  function selResolved() {
    return selList().map(k => {
      const i = k.indexOf('|');
      const epId = k.slice(0, i), suKey = k.slice(i + 1);
      const ep = App.state.data.episodes.find(x => x.id === epId);
      const su = ep && App.subitem(ep, suKey);
      return su ? { epId, suKey, ep, su } : null;
    }).filter(Boolean);
  }
  App.ganttSelection = { has: selHas, clear: selClear, resolved: selResolved };

  /* How far one Ctrl+scroll event should zoom.

     A fixed step per event is what made this twitchy: a mouse wheel sends one
     chunky event per notch, but a trackpad sends a stream of tiny ones, so the
     same 12% per event meant a flick of two fingers crossed the whole range.

     Scaling by the distance actually scrolled fixes both at once. Deltas are
     first normalised to pixels — browsers report lines or pages depending on
     the device — then fed through an exponential, which keeps the zoom rate
     constant per pixel travelled and compounds smoothly however many events
     arrive. A single event is capped so one violent flick can't jump the
     entire scale.

     At 0.0018/px: a trackpad's ~3px event moves ~0.5%, a wheel notch (~100px)
     about 16%. Gentle where it was too eager, unchanged where it was fine. */
  const ZOOM_PER_PX = 0.0018;
  const PX_PER_LINE = 16, PX_PER_PAGE = 400;
  function wheelZoomFactor(e) {
    const px = e.deltaMode === 1 ? e.deltaY * PX_PER_LINE
             : e.deltaMode === 2 ? e.deltaY * PX_PER_PAGE
             : e.deltaY;
    return Math.max(0.75, Math.min(1.33, Math.exp(-px * ZOOM_PER_PX)));
  }

  // ctx = { start, totalCalDays, totalCols, dw, colOf } — colOf maps an ISO
  // date to its rendered column index, collapsing hidden (weekend) days onto
  // the column of the nearest preceding visible day. When weekends are shown,
  // colOf is the identity (1 column per calendar day) and nothing collapses.
  function segments(ctx, unit) {
    const { start, totalCalDays, colOf } = ctx;
    const out = []; let i = 0;                      // i = calendar-day cursor
    while (i < totalCalDays) {
      const day = App.addDays(start, i);
      let calSpan, label, sub = '';
      if (unit === 'days') { calSpan = 1; label = String(day.getDate()); sub = WD[(day.getDay() + 6) % 7]; }
      else if (unit === 'weeks') {
        const dow = (day.getDay() + 6) % 7; calSpan = Math.min(7 - dow, totalCalDays - i);
        const end = App.addDays(day, calSpan - 1); label = 'W' + isoWeek(day); sub = MON(day) + ' ' + day.getDate() + '–' + end.getDate();
      } else if (unit === 'months') {
        const b = new Date(day.getFullYear(), day.getMonth() + 1, 1);
        calSpan = Math.min(App.diffDays(App.isoDate(b), App.isoDate(day)), totalCalDays - i); label = MON(day); sub = String(day.getFullYear());
      } else if (unit === 'quarters') {
        const q = Math.floor(day.getMonth() / 3); const b = new Date(day.getFullYear(), q * 3 + 3, 1);
        calSpan = Math.min(App.diffDays(App.isoDate(b), App.isoDate(day)), totalCalDays - i); label = 'Q' + (q + 1); sub = String(day.getFullYear());
      } else {
        const b = new Date(day.getFullYear() + 1, 0, 1);
        calSpan = Math.min(App.diffDays(App.isoDate(b), App.isoDate(day)), totalCalDays - i); label = String(day.getFullYear());
      }
      if (calSpan < 1) calSpan = 1;
      const colStart = colOf(App.isoDate(day));
      const colSpan = colOf(App.isoDate(App.addDays(day, calSpan))) - colStart;
      // a segment fully inside a hidden weekend (a Sat/Sun 'days' cell) collapses to
      // zero columns — skip it entirely rather than rendering an empty cell
      if (colSpan > 0) out.push({ colStart, colSpan, label, sub, day });
      i += calSpan;
    }
    return out;
  }

  function buildSegRow(ctx, unit, cls) {
    const todayIso = App.isoDate(App.today());
    const row = el('.thead-row.' + cls);
    segments(ctx, unit).forEach(seg => {
      const w = seg.colSpan * ctx.dw;
      let mod = '';
      if (unit === 'days') { const wk = seg.day.getDay() === 0 || seg.day.getDay() === 6; mod = (wk ? '.weekend' : '') + (App.isoDate(seg.day) === todayIso ? '.is-today' : ''); }
      const cell = el('.thead-cell.' + cls + mod, { style: { width: w + 'px', minWidth: w + 'px' } });
      if (unit === 'days') { cell.appendChild(el('.wd', null, seg.sub)); cell.appendChild(el('.dnum', null, seg.label)); }
      else { cell.appendChild(el('span.seg-main', null, seg.label)); if (seg.sub) cell.appendChild(el('span.seg-sub', null, seg.sub)); }
      row.appendChild(cell);
    });
    return row;
  }

  function gridLines(grid, ctx, unit, strong, portrait) {
    segments(ctx, unit).forEach(seg => {
      const off = seg.colStart + seg.colSpan;
      if (off > 0 && off < ctx.totalCols) {
        const style = portrait ? { top: (off * ctx.dw) + 'px' } : { left: (off * ctx.dw) + 'px' };
        grid.appendChild(el('.grid-line' + (strong ? '.strong' : ''), { style }));
      }
    });
  }

  // Portrait's mirror of buildSegRow: the same segments(), stacked vertically
  // (sized by height) instead of horizontally (sized by width). Cell markup
  // (.wd/.dnum or .seg-main/.seg-sub) is reused verbatim — it was already two
  // lines stacked within a cell, so only the cell's own outer dimension flips.
  function buildSegColumn(ctx, unit, cls) {
    const todayIso = App.isoDate(App.today());
    const col = el('.thead-row.thead-col.' + cls);
    segments(ctx, unit).forEach(seg => {
      const h = seg.colSpan * ctx.dw;
      let mod = '';
      if (unit === 'days') { const wk = seg.day.getDay() === 0 || seg.day.getDay() === 6; mod = (wk ? '.weekend' : '') + (App.isoDate(seg.day) === todayIso ? '.is-today' : ''); }
      const cell = el('.thead-cell.' + cls + mod, { style: { height: h + 'px', minHeight: h + 'px' } });
      if (unit === 'days') { cell.appendChild(el('.wd', null, seg.sub)); cell.appendChild(el('.dnum', null, seg.label)); }
      else { cell.appendChild(el('span.seg-main', null, seg.label)); if (seg.sub) cell.appendChild(el('span.seg-sub', null, seg.sub)); }
      col.appendChild(cell);
    });
    return col;
  }

  App.gantt = {
    _wantCenter: true,
    _scrollEl: null,
    _rafId: null,

    render(episodes) {
      const sort = App.prefs.get('timelineSort', 'department');
      /* Portrait (time runs top-to-bottom) is Department-sort only for now —
         Episode/Show build their rows through separate, independent code that
         hasn't been given a column-based mirror yet. The preference itself
         isn't scoped to a sort mode, so switching to Episode/Show with
         Portrait selected just quietly renders Landscape — no error, nothing
         to explain, and it starts working again the moment you switch back. */
      const portrait = sort === 'department' && App.prefs.get('timelineOrientation', 'landscape') === 'portrait';
      const axis = { portrait };

      const wrap = el('.gantt' + (App.prefs.get('latchScroll', false) ? '.latch' : '') + (portrait ? '.gantt-portrait' : ''));
      if (!episodes.length) { wrap.appendChild(el('.empty', null, 'No episodes match the current filters.')); return wrap; }

      // Only the Episode sort draws the end-of-episode milestones, and there
      // the window has to run out to the last Live Date or they fall off the
      // end. The other two sorts stop at the work: a show line would carry
      // every episode's dates at once, and a department line has no episode to
      // pin them to.
      const marks = sort === 'episode';
      let min = '9999', max = '0000';
      episodes.forEach(ep => {
        const s = App.epStart(ep), d = marks ? App.epFinal(ep) : App.epDue(ep);
        if (s < min) min = s; if (d > max) max = d;
      });
      const start = mondayOf(App.addDays(App.parseDate(min), -2));
      let end = App.addDays(App.parseDate(max), 2);
      end = App.addDays(mondayOf(end), 6);
      const startIso = App.isoDate(start);
      const totalCalDays = App.diffDays(App.isoDate(end), startIso) + 1;
      const dw = App.state.zoom;

      // Hide-weekends (preference, default on): Saturdays/Sundays are removed
      // as columns entirely rather than just shaded. `colOf` maps any ISO date
      // to its rendered column index, collapsing a hidden day onto the column
      // of the nearest preceding visible day — so a task starting or ending on
      // a weekend still renders correctly, just with the weekend compressed to
      // zero width. With the preference off, colOf is the identity (1:1 with
      // calendar days) and behaviour is exactly as before.
      const hideWeekends = App.prefs.get('hideWeekends', true);
      const colPrefix = new Array(totalCalDays + 1);
      colPrefix[0] = 0;
      for (let i = 0; i < totalCalDays; i++) {
        const dow = App.addDays(start, i).getDay();
        colPrefix[i + 1] = colPrefix[i] + ((!hideWeekends || (dow !== 0 && dow !== 6)) ? 1 : 0);
      }
      const totalCols = colPrefix[totalCalDays];
      const colOf = (iso) => colPrefix[Math.max(0, Math.min(totalCalDays, App.diffDays(iso, startIso)))];
      const timeW = totalCols * dw;
      const xOf = (iso) => colOf(iso) * dw;
      // shared width helper for every bar: collapses any weekend the span
      // covers, same as the column math above (attached to xOf to avoid
      // threading a second function through every row-building method)
      xOf.width = (s, d) => Math.max(dw, (colOf(App.shiftIso(d, 1)) - colOf(s)) * dw);
      const ctx = { start, totalCalDays, totalCols, dw, colOf };

      // stashed so drag handlers (which run between renders) can convert
      // pixels back to dates using the exact same scale just rendered with
      this._dw = dw;
      this._hideWeekends = hideWeekends;
      this._xOf = xOf;
      this._startIso = startIso;
      this._axis = axis;

      const tier = tierFor(dw);
      const scroll = el('.gantt-scroll', { style: { maxHeight: 'calc(100vh - 230px)' } });
      const inner = el('.gantt-inner');
      const body = el('.gantt-body');

      // timeW is the same colOf/dw math either way — colOf doesn't know or
      // care which screen axis it's drawn on. Portrait just points it down
      // instead of across: the header becomes a rail on the left, and every
      // .g-row gets that same length as its own height (via --gantt-time-h)
      // instead of the whole board getting it as one shared width.
      if (portrait) {
        wrap.style.setProperty('--gantt-time-h', (COL_HEAD_H + timeW) + 'px');
        inner.appendChild(this.buildDateRail(ctx, tier));
      } else {
        inner.style.width = (LABEL_W + timeW) + 'px';
        inner.appendChild(this.buildHead(ctx, tier));
      }

      const grid = el('.grid-bg', portrait
        ? { style: { top: COL_HEAD_H + 'px', height: timeW + 'px' } }
        : { style: { left: LABEL_W + 'px', width: timeW + 'px' } });
      if (!hideWeekends && tier.secondary === 'days') {
        for (let i = 0; i < totalCalDays; i++) {
          const day = App.addDays(start, i);
          if (day.getDay() === 0 || day.getDay() === 6) {
            const style = portrait ? { top: (i * dw) + 'px', height: dw + 'px' } : { left: (i * dw) + 'px', width: dw + 'px' };
            grid.appendChild(el('.grid-col.weekend', { style }));
          }
        }
      }
      gridLines(grid, ctx, tier.secondary, false, portrait);
      gridLines(grid, ctx, tier.primary, true, portrait);
      body.appendChild(grid);

      const todayIso = App.isoDate(App.today());
      if (todayIso >= startIso && todayIso <= App.isoDate(end)) {
        const off = xOf(todayIso) + dw / 2;
        const style = portrait ? { top: (COL_HEAD_H + off) + 'px' } : { left: (LABEL_W + off) + 'px' };
        body.appendChild(el('.today-line', { style }));
      }

      // "+ Create" row — drawn before Producer Notes so it sits at the very
      // top. If the role lost the right mid-session (the role selector
      // changed while it was armed), clear it silently rather than render an
      // interactive track the current role can't actually use.
      if (App.state.creatingOnGantt && !(App.canManageShows(App.state.role) || App.canEditSchedule(App.state.role))) {
        App.state.creatingOnGantt = false;
      }
      if (App.state.creatingOnGantt) this.createRow(body, startIso, dw, xOf);

      // Producer Notes swimlane — per-show annotations, only meaningful when a
      // single show is in view (nonsensical mixed across shows on "All shows").
      // Not yet given a Portrait transpose (it has its own unrelated .portrait
      // meaning already — narrow notes flipping to vertical text — and its own
      // transpose problem); hidden in Portrait rather than half-drawn.
      const singleShow = App.singleShowFilter();
      if (singleShow && !portrait) this.producerNotesLane(body, singleShow, startIso, dw, xOf);

      const byStart = (a, b) => App.epStart(a) < App.epStart(b) ? -1 : 1;
      if (sort === 'show') {
        // one row per show; matching tasks across its episodes share a line
        const byShow = {};
        episodes.forEach(ep => (byShow[ep.showId] = byShow[ep.showId] || []).push(ep));
        Object.values(byShow)
          .map(eps => eps.sort(byStart))
          .sort((a, b) => byStart(a[0], b[0]))
          .forEach(eps => this.showRow(body, App.show(eps[0].showId), eps, startIso, dw, timeW, xOf));
      } else if (sort === 'episode') {
        // one row per episode; expand into department-grouped, stacked task rows
        episodes.slice().sort(byStart).forEach(ep => this.episodeStackedRow(body, ep, startIso, dw, timeW, xOf));
      } else {
        // 'department': one row per department, spanning every show in view;
        // expand into one line per task, each holding a bar per episode.
        // In Portrait, .gantt-body is flex-row (CSS), so this exact same
        // row-emitting call reads left-to-right as columns instead of
        // top-to-bottom as rows — including a department's expansion into
        // per-task .g-row.sub elements, and each task's own interval-stacked
        // "levels" (epTaskLines) landing as side-by-side sub-columns instead
        // of extra stacked rows. Nothing about that grouping/stacking logic
        // changes; only where axis is threaded down into the bars themselves.
        this.departmentRows(body, episodes, startIso, dw, timeW, xOf, axis);
      }

      inner.appendChild(body);
      scroll.appendChild(inner);
      wrap.appendChild(scroll);

      this._scrollEl = scroll;
      this.setupEventDelegation();
      this.setupDrag();

      // settle: when scrolling stops, ease the nearest row flush under the
      // sticky chrome so no task row is ever left half-cut at the top.
      // Landscape only — see the guard at the top of settleRows().
      scroll.addEventListener('scroll', () => {
        clearTimeout(this._settleT);
        this._settleT = setTimeout(() => this.settleRows(), 160);
      }, { passive: true });

      scroll.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          const old = App.state.zoom, nz = clampZoom(old * wheelZoomFactor(e));
          if (Math.abs(nz - old) > 0.001) {
            if (portrait) {
              const sy = e.clientY - scroll.getBoundingClientRect().top;
              this._preserve = { dayOffset: (scroll.scrollTop + sy - COL_HEAD_H) / old, screenPos: sy };
            } else {
              const sx = e.clientX - scroll.getBoundingClientRect().left;
              this._preserve = { dayOffset: (scroll.scrollLeft + sx - LABEL_W) / old, screenPos: sx };
            }
            App.state.zoom = nz; App.render();
          }
          return;
        }
        // Portrait's primary scroll axis is already the one a plain wheel
        // moves (deltaY = vertical = time), so it needs no sideways-scroll
        // fallback the way Landscape does.
        if (portrait) return;
        const canV = scroll.scrollHeight > scroll.clientHeight + 16;
        const canH = scroll.scrollWidth > scroll.clientWidth + 1;
        if ((e.shiftKey || !canV) && canH && e.deltaY !== 0) { scroll.scrollLeft += e.deltaY; e.preventDefault(); }
      }, { passive: false });

      return wrap;
    },

    setupEventDelegation() {
      if (!this._scrollEl) return;
      const self = this;

      const handleClick = (e) => {
        // a drag or a hold just ended on this element — that gesture already had
        // its effect, and it isn't "open Edit Task"
        if (self._clickSuppressed) { e.stopPropagation(); return; }

        const mark = e.target.closest('.ms-day.clickable');
        if (mark) {
          e.stopPropagation();
          if (mark.dataset.episodeId && mark.dataset.msKey && App.milestoneDialog) {
            App.milestoneDialog.open(mark.dataset.episodeId, mark.dataset.msKey);
          }
          return;
        }

        const bar = e.target.closest('.bar');
        const label = e.target.closest('.g-label');

        /* A plain click on open track drops the selection. Without it the only
           exits are Escape or un-picking every bar by hand, and a group left
           standing quietly owns the next drag. Row labels are left alone —
           expanding a row to see more of what you've picked shouldn't
           throw the picking away. */
        if (!bar && !label && !e.shiftKey && selList().length && e.target.closest('.g-track')) {
          selClear();
          App.render();
          return;
        }

        if (!bar && !label) return;
        if (bar && bar.closest('.g-row.sub')) {
          e.stopPropagation();
          const row = bar.closest('.g-row.sub');
          // show-sorted lines hold bars from several episodes, so identity
          // lives on the bar itself; episode-sorted rows carry it on the row
          const epId = bar.dataset.episodeId || row.dataset.episodeId;
          const suKey = bar.dataset.suKey || row.dataset.suKey;
          if (epId && suKey) {
            App.editTask.open(epId, suKey);
          }
          return;
        }

        const row = label?.closest('.g-row') || bar?.closest('.g-row');
        if (!row || row.classList.contains('sub')) return;

        const epId = row.dataset.episodeId;
        if (!epId) return;

        e.preventDefault();
        App.state.ganttExpanded[epId] = !App.state.ganttExpanded[epId];
        App.render();
      };

      /* Right-click a task bar. The one action that genuinely needs a menu is
         Batch Set Dates — it acts on a selection rather than on a bar, so
         there's no bar to hang it off and no drag that could express it. Edit
         Task and Clear selection come along because a menu with one item in it
         reads like a mistake, and both are already reachable elsewhere. */
      const handleContext = (e) => {
        const bar = e.target.closest('.bar');
        const row = bar && bar.closest('.g-row.sub');
        if (!bar || !row || row.classList.contains('phase')) return;
        const epId = bar.dataset.episodeId || row.dataset.episodeId;
        const suKey = bar.dataset.suKey || row.dataset.suKey;
        if (!epId || !suKey) return;
        e.preventDefault();
        hideTip();
        self.openBarMenu(e, epId, suKey);
      };

      if (this._clickHandler) {
        this._scrollEl.removeEventListener('click', this._clickHandler);
        this._scrollEl.removeEventListener('contextmenu', this._ctxHandler);
      }
      this._clickHandler = handleClick;
      this._ctxHandler = handleContext;
      this._scrollEl.addEventListener('click', handleClick);
      this._scrollEl.addEventListener('contextmenu', handleContext);
    },

    closeBarMenu() {
      if (this._barMenu) { this._barMenu.remove(); this._barMenu = null; }
      if (this._barMenuOff) { document.removeEventListener('mousedown', this._barMenuOff, true); this._barMenuOff = null; }
    },

    openBarMenu(e, epId, suKey) {
      this.closeBarMenu();
      const sel = selResolved();
      const menu = el('.ctx-menu');
      const item = (label, sub, fn) => el('button.ctx-item', {
        type: 'button',
        onclick: () => { this.closeBarMenu(); fn(); }
      }, [el('span.ctx-item-lbl', null, label), sub ? el('span.ctx-item-sub', null, sub) : null]);

      if (sel.length > 1 && App.canEditSchedule(App.state.role)) {
        menu.appendChild(item('Batch Set Dates…', sel.length + ' selected', () => App.batchDates.open()));
        menu.appendChild(el('.ctx-sep'));
      }
      menu.appendChild(item('Edit task…', null, () => App.editTask.open(epId, suKey)));
      if (sel.length) {
        menu.appendChild(item('Clear selection', 'Esc', () => { selClear(); App.render(); }));
      }

      document.body.appendChild(menu);
      // flipped up or left when it would otherwise run off the edge — the
      // cursor can be anywhere, including the last few pixels of the window
      const mh = menu.offsetHeight, mw = menu.offsetWidth;
      menu.style.top = (e.clientY + mh + 6 > window.innerHeight ? Math.max(6, e.clientY - mh) : e.clientY + 2) + 'px';
      menu.style.left = Math.min(e.clientX + 2, window.innerWidth - mw - 8) + 'px';
      this._barMenu = menu;
      // capture, so the press that dismisses the menu can't also land on a bar
      this._barMenuOff = (ev) => { if (!menu.contains(ev.target)) this.closeBarMenu(); };
      setTimeout(() => document.addEventListener('mousedown', this._barMenuOff, true), 0);
    },

    // ---- drag-to-reschedule a task bar ----
    // Middle = move (keeps duration); either edge = resize (keeps the other
    // edge fixed). Both are clamped live to the task's minDays; dependency
    // ordering is checked live for a warning outline and confirmed again in
    // App.moveTask on drop (which applies the change regardless and toasts).
    // `axis` picks which physical edge is being measured — the zone names
    // ('resize-left'/'resize-right') keep their Landscape meaning either way
    // (the task's START edge / DUE edge), since onDragMove already reads them
    // that way regardless of which screen axis is current.
    dragZone(bar, e, axis) {
      const r = bar.getBoundingClientRect();
      const portrait = !!(axis && axis.portrait);
      const mainSize = portrait ? r.height : r.width;
      if (mainSize < 16) return 'move';                 // too narrow to grab an edge precisely
      const edge = Math.min(8, mainSize / 3);
      const pos = portrait ? (e.clientY - r.top) : (e.clientX - r.left);
      if (pos <= edge) return 'resize-left';
      if (pos >= mainSize - edge) return 'resize-right';
      return 'move';
    },

    setupDrag() {
      if (!this._scrollEl) return;
      const scroll = this._scrollEl;

      const hoverHandler = (e) => {
        if (this._drag) return;
        const noteEl = e.target.closest('.pn-note.editable');
        if (noteEl) {
          if (this._hoverBar && this._hoverBar !== noteEl) { this._hoverBar.style.cursor = ''; this._hoverBar.classList.remove('adjustable'); }
          this._hoverBar = noteEl;
          noteEl.classList.add('adjustable');
          noteEl.style.cursor = this.dragZone(noteEl, e, null) === 'move' ? 'grab' : 'ew-resize';   // notes: always Landscape
          return;
        }
        const bar = e.target.closest('.bar');
        const row = bar && bar.closest('.g-row.sub');
        if (!bar || !row || row.classList.contains('phase')) {
          if (this._hoverBar) { this._hoverBar.style.cursor = ''; this._hoverBar.classList.remove('adjustable'); this._hoverBar = null; }
          return;
        }
        if (bar !== this._hoverBar) {
          if (this._hoverBar) { this._hoverBar.style.cursor = ''; this._hoverBar.classList.remove('adjustable'); }
          this._hoverBar = bar;
          // cache per element (elements are rebuilt every render, so this
          // never goes stale) — avoids an episode/subitem lookup every pixel
          this._adjustableCache = this._adjustableCache || new WeakMap();
          let ok = this._adjustableCache.get(bar);
          if (ok === undefined) {
            const epId = bar.dataset.episodeId || row.dataset.episodeId;
            const suKey = bar.dataset.suKey || row.dataset.suKey;
            const ep = epId && App.state.data.episodes.find(x => x.id === epId);
            const su = ep && suKey && App.subitem(ep, suKey);
            // dragging a bar reschedules it, so it's the schedule right that
            // matters here — not the department-scoped edit gate
            ok = !!(su && App.canEditSchedule(App.state.role));
            this._adjustableCache.set(bar, ok);
          }
          bar.classList.toggle('adjustable', ok);
        }
        // shift held: this press adds or removes the bar, it doesn't move it
        if (e.shiftKey) { bar.style.cursor = 'pointer'; return; }
        const resizeCursor = (this._axis && this._axis.portrait) ? 'ns-resize' : 'ew-resize';
        bar.style.cursor = this.dragZone(bar, e, this._axis) === 'move' ? 'grab' : resizeCursor;
      };
      scroll.addEventListener('mousemove', hoverHandler);

      const downHandler = (e) => {
        // "+ Create" — DRAWING: empty cell on the blank Create row → draw a
        // new episode/task. Permission is live-checked here too, not just
        // trusted from render time, matching the same discipline the notes
        // branch right below already uses (App.canEditNotes() inline).
        const createTrack = e.target.closest('.g-row.create-row .g-track.cr-drawable');
        if (createTrack && App.state.creatingOnGantt &&
            (App.canManageShows(App.state.role) || App.canEditSchedule(App.state.role))) {
          e.preventDefault();
          this.startCreateDraw(e, createTrack);
          return;
        }

        // producer notes — DRAWING: empty grid cell in a notes row → draw a new note
        const drawTrack = e.target.closest('.g-row.pn-row .g-track.pn-drawable');
        if (drawTrack && !e.target.closest('.pn-note') && App.canEditNotes()) {
          e.preventDefault();
          this.closeNoteEditor();
          this.startNoteDraw(e, drawTrack);
          return;
        }

        // producer notes: draggable/resizable like task bars, but no dep rules
        const noteEl = e.target.closest('.pn-note.editable');
        if (noteEl) {
          const showId = noteEl.dataset.showId, id = noteEl.dataset.noteId;
          const show = App.show(showId);
          const note = show && (show.notes || []).find(n => n.id === id);
          if (!note) return;
          e.preventDefault();
          hideTip();
          const zone = this.dragZone(noteEl, e, null);   // notes: always Landscape
          this._drag = {
            kind: 'note', el: noteEl, showId, id, zone, startClientX: e.clientX,
            origStart: note.start, origDue: note.due, curStart: note.start, curDue: note.due, moved: false
          };
          noteEl.classList.add('dragging');
          document.body.classList.add('gantt-dragging');
          document.body.style.cursor = zone === 'move' ? 'grabbing' : 'ew-resize';
          return;
        }

        const bar = e.target.closest('.bar');

        /* Shift on empty grid → marquee. Starting the band on a bar would take
           the shift+click-to-toggle gesture away, and dragging out from a bar
           you've just added is the natural way to extend a selection, so the
           band only ever starts in open space. */
        if (e.shiftKey && !bar) {
          const track = e.target.closest('.g-row.sub .g-track');
          if (track && App.canEditSchedule(App.state.role)) {
            e.preventDefault();
            hideTip();
            this.startMarquee(e);
            return;
          }
        }

        if (!bar) return;
        const row = bar.closest('.g-row.sub');
        if (!row || row.classList.contains('phase')) return;
        const epId = bar.dataset.episodeId || row.dataset.episodeId;
        const suKey = bar.dataset.suKey || row.dataset.suKey;
        if (!epId || !suKey) return;
        const ep = App.state.data.episodes.find(x => x.id === epId);
        const su = ep && App.subitem(ep, suKey);
        if (!su || !App.canEditSchedule(App.state.role)) return;   // a plain click still opens the dialog, which explains the lock

        /* Shift on a bar → toggle it in the selection, and nothing else. No
           drag starts and no dialog opens: the whole point of holding shift is
           that this press is about choosing, not about moving or inspecting. */
        if (e.shiftKey) {
          e.preventDefault();
          hideTip();
          selToggle(epId, suKey);
          this.suppressNextClick();
          App.render();
          return;
        }

        e.preventDefault();
        hideTip();
        const zone = this.dragZone(bar, e, this._axis);

        /* Dragging a bar that's part of a selection drags the whole selection.
           Grabbing an unselected bar drops the selection first — otherwise a
           group would sit there invisibly owning every later drag, and the one
           bar you actually grabbed would be the one that didn't move. */
        if (selList().length && !selHas(epId, suKey)) selClear();
        const group = selHas(epId, suKey) ? selResolved() : null;

        if (group && group.length > 1) {
          this.startGroupDrag(e, bar, zone, group);
          return;
        }

        const pipe = App.pipelineFor(ep);
        const task = pipe.find(t => t.key === suKey);
        const byKey = {}; App.subitems(ep).forEach(s => { byKey[s.key] = s; });
        this._drag = {
          bar, epId, suKey, zone, startClientX: e.clientX, startClientY: e.clientY, startedAt: Date.now(), moved: false,
          origStart: su.start, origDue: su.due, curStart: su.start, curDue: su.due,
          minDays: (task && task.minDays) || 1,
          deps: (task ? task.deps : []).map(k => byKey[k]).filter(Boolean),
          dependents: pipe.filter(t => t.key !== suKey && t.deps.includes(suKey)).map(t => byKey[t.key]).filter(Boolean)
        };
        bar.classList.add('dragging');
        document.body.classList.add('gantt-dragging');
        document.body.style.cursor = zone === 'move' ? 'grabbing' : ((this._axis && this._axis.portrait) ? 'ns-resize' : 'ew-resize');
      };
      scroll.addEventListener('mousedown', downHandler);

      // document-level so the drag tracks the cursor even off the bar/track;
      // attached once for the component's lifetime — re-renders just refresh
      // the _dw/_hideWeekends/_xOf scale these read, not the listeners
      if (!this._dragBound) {
        document.addEventListener('mousemove', (e) => this.onDragMove(e));
        document.addEventListener('mouseup', (e) => this.onDragEnd(e));
        /* Shift is a mode while it's held, so the cursor should say so before
           the press rather than after. Keyed off the modifier on every event
           that reports it — watching keydown/keyup alone misses the case where
           the key goes down or up while the window isn't focused. */
        const shiftState = (e) => {
          document.body.classList.toggle('gantt-shift', !!e.shiftKey && !this._drag);
        };
        document.addEventListener('keydown', shiftState);
        document.addEventListener('keyup', shiftState);
        document.addEventListener('mousemove', shiftState);
        window.addEventListener('blur', () => document.body.classList.remove('gantt-shift'));
        this._dragBound = true;
      }
    },

    /* ---- group drag ----
       Every selected bar moves or resizes by the SAME number of days, which is
       what makes this a bulk edit rather than an alignment tool: "everything a
       week later", "everything two days shorter". Absolute dates would collapse
       a staggered selection onto one span and destroy the shape the producer is
       working with.

       Each member carries its own minDays floor, so a short task stops
       shortening while its longer neighbours keep going. The delta is not
       clamped to the tightest member — that would let one 1-day task veto a
       shorten the other eleven can absorb. */
    startGroupDrag(e, bar, zone, group) {
      const members = group.map(g => {
        const task = App.pTask(g.ep, g.suKey);
        return {
          epId: g.epId, suKey: g.suKey,
          origStart: g.su.start, origDue: g.su.due,
          curStart: g.su.start, curDue: g.su.due,
          minDays: (task && task.minDays) || 1,
          // the DOM node, when it's on screen — a selected bar can be inside a
          // collapsed row, in which case it still moves, just invisibly
          el: this._scrollEl && this._scrollEl.querySelector(
            '.bar[data-episode-id="' + g.epId + '"][data-su-key="' + g.suKey + '"]')
        };
      });
      this._drag = {
        kind: 'group', zone, members, bar,
        startClientX: e.clientX, startClientY: e.clientY, startedAt: Date.now(), moved: false, colDelta: 0
      };
      members.forEach(m => { if (m.el) m.el.classList.add('dragging'); });
      document.body.classList.add('gantt-dragging');
      document.body.style.cursor = zone === 'move' ? 'grabbing'
        : ((this._axis && this._axis.portrait) ? 'ns-resize' : 'ew-resize');
    },

    /* ---- marquee ----
       Drawn and hit-tested in viewport coordinates, which is why the band is
       `position: fixed`: the bars are measured with getBoundingClientRect, so
       keeping the band in the same space means the sweep and what it catches
       can't disagree. Content-relative was tried and is a trap — the scroll
       container is static, so an absolute band silently resolves against a
       different ancestor and lands somewhere its own numbers don't predict.

       Hit-tested once on release rather than per mouse move: one pass over the
       bars beats one per pixel, and the band's outline is feedback enough. */
    startMarquee(e) {
      const ghost = el('.g-marquee', {
        style: { left: e.clientX + 'px', top: e.clientY + 'px', width: '0px', height: '0px' }
      });
      document.body.appendChild(ghost);
      this._drag = {
        kind: 'marquee', ghost,
        startClientX: e.clientX, startClientY: e.clientY, startedAt: Date.now(), moved: false,
        // shift is held, so this extends whatever was already picked
        additive: true
      };
      document.body.classList.add('gantt-dragging');
    },

    onDragMove(e) {
      const d = this._drag; if (!d) return;
      const dw = this._dw, hw = this._hideWeekends, xOf = this._xOf;
      // notes are Landscape-only regardless of the current axis (Producer Notes
      // hidden entirely in Portrait — see render()), so their delta always
      // reads clientX. Only the bar-drag branch below ever reads clientY.
      const colDeltaX = Math.round((e.clientX - d.startClientX) / dw);

      if (d.kind === 'note-draw' || d.kind === 'create-draw') {
        const cur = d.startCol + Math.round((e.clientX - d.startClientX) / dw);
        const a = Math.max(0, Math.min(d.startCol, cur)), b = Math.max(0, Math.max(d.startCol, cur));
        d.curA = a; d.curB = b;
        if (Math.abs(e.clientX - d.startClientX) > 4) d.moved = true;
        d.ghost.style.left = (a * dw) + 'px';
        d.ghost.style.width = ((b - a + 1) * dw) + 'px';
        const sIso = App.addVisibleDays(this._startIso, a, hw), dIso = App.addVisibleDays(this._startIso, b, hw);
        const dotColor = d.kind === 'create-draw' ? '#9b5bff' : '#5b6cff';
        const tip = dragTipEl(); tip.innerHTML = '';
        tip.appendChild(el('span.tip-dot', { style: { background: dotColor } }));
        tip.appendChild(document.createTextNode(App.fmtRange(sIso, dIso)));
        tip.style.display = 'flex'; tip.style.left = e.clientX + 'px'; tip.style.top = (e.clientY - 38) + 'px';
        return;
      }

      if (d.kind === 'marquee') {
        if (Math.abs(e.clientX - d.startClientX) > DRAG_SLOP || Math.abs(e.clientY - d.startClientY) > DRAG_SLOP) d.moved = true;
        d.ghost.style.left = Math.min(e.clientX, d.startClientX) + 'px';
        d.ghost.style.top = Math.min(e.clientY, d.startClientY) + 'px';
        d.ghost.style.width = Math.abs(e.clientX - d.startClientX) + 'px';
        d.ghost.style.height = Math.abs(e.clientY - d.startClientY) + 'px';
        return;
      }

      if (d.kind === 'group') {
        const portraitG = !!(this._axis && this._axis.portrait);
        const mainDeltaG = portraitG ? (e.clientY - d.startClientY) : (e.clientX - d.startClientX);
        const colDeltaG = Math.round(mainDeltaG / dw);
        if (Math.abs(mainDeltaG) > DRAG_SLOP) d.moved = true;
        d.colDelta = colDeltaG;

        let clamped = 0;
        d.members.forEach(m => {
          let ns = m.origStart, nd = m.origDue;
          if (d.zone === 'move') {
            ns = App.addVisibleDays(m.origStart, colDeltaG, hw);
            nd = App.addVisibleDays(m.origDue, colDeltaG, hw);
          } else if (d.zone === 'resize-left') {
            ns = App.addVisibleDays(m.origStart, colDeltaG, hw);
            if (App.visibleDayCount(ns, nd, hw) < m.minDays) { ns = App.addVisibleDays(nd, -(m.minDays - 1), hw); clamped++; }
          } else {
            nd = App.addVisibleDays(m.origDue, colDeltaG, hw);
            if (App.visibleDayCount(ns, nd, hw) < m.minDays) { nd = App.addVisibleDays(ns, m.minDays - 1, hw); clamped++; }
          }
          m.curStart = ns; m.curDue = nd;
          if (m.el) {
            if (portraitG) { m.el.style.top = xOf(ns) + 'px'; m.el.style.height = xOf.width(ns, nd) + 'px'; }
            else { m.el.style.left = xOf(ns) + 'px'; m.el.style.width = xOf.width(ns, nd) + 'px'; }
          }
        });

        const verb = d.zone === 'move' ? (colDeltaG > 0 ? 'later' : 'earlier')
                   : (d.zone === 'resize-left' ? (colDeltaG > 0 ? 'shorter' : 'longer')
                                               : (colDeltaG > 0 ? 'longer' : 'shorter'));
        const tipG = dragTipEl(); tipG.innerHTML = '';
        tipG.appendChild(el('span.tip-dot', { style: { background: clamped ? '#fdab3d' : '#5fb0f0' } }));
        tipG.appendChild(document.createTextNode(
          d.members.length + ' tasks · ' + (colDeltaG ? Math.abs(colDeltaG) + 'd ' + verb : 'no change') +
          (clamped ? ' · ' + clamped + ' at minimum' : '')));
        tipG.style.display = 'flex';
        tipG.style.left = e.clientX + 'px';
        tipG.style.top = (e.clientY - 38) + 'px';
        return;
      }

      if (d.kind === 'note') {
        if (Math.abs(e.clientX - d.startClientX) > 3) d.moved = true;
        let ns = d.origStart, nd = d.origDue;
        if (d.zone === 'move') { ns = App.addVisibleDays(d.origStart, colDeltaX, hw); nd = App.addVisibleDays(d.origDue, colDeltaX, hw); }
        else if (d.zone === 'resize-left') { ns = App.addVisibleDays(d.origStart, colDeltaX, hw); if (ns > nd) ns = nd; }
        else { nd = App.addVisibleDays(d.origDue, colDeltaX, hw); if (nd < ns) nd = ns; }
        d.curStart = ns; d.curDue = nd;
        d.el.style.left = xOf(ns) + 'px';
        d.el.style.width = xOf.width(ns, nd) + 'px';
        const tip = dragTipEl(); tip.innerHTML = '';
        tip.appendChild(el('span.tip-dot', { style: { background: '#5fb0f0' } }));
        tip.appendChild(document.createTextNode(App.fmtRange(ns, nd)));
        tip.style.display = 'flex'; tip.style.left = e.clientX + 'px'; tip.style.top = (e.clientY - 38) + 'px';
        return;
      }

      // the only branch that can be Portrait — notes (handled above) never
      // render there, so this is where clientY actually gets read
      const portrait = !!(this._axis && this._axis.portrait);
      const mainDelta = portrait ? (e.clientY - d.startClientY) : (e.clientX - d.startClientX);
      const colDelta = Math.round(mainDelta / dw);
      if (Math.abs(mainDelta) > DRAG_SLOP) d.moved = true;

      let newStart = d.origStart, newDue = d.origDue;
      if (d.zone === 'move') {
        newStart = App.addVisibleDays(d.origStart, colDelta, hw);
        newDue = App.addVisibleDays(d.origDue, colDelta, hw);
      } else if (d.zone === 'resize-left') {
        newStart = App.addVisibleDays(d.origStart, colDelta, hw);
        if (App.visibleDayCount(newStart, newDue, hw) < d.minDays) newStart = App.addVisibleDays(newDue, -(d.minDays - 1), hw);
      } else {
        newDue = App.addVisibleDays(d.origDue, colDelta, hw);
        if (App.visibleDayCount(newStart, newDue, hw) < d.minDays) newDue = App.addVisibleDays(newStart, d.minDays - 1, hw);
      }
      d.curStart = newStart; d.curDue = newDue;

      if (portrait) { d.bar.style.top = xOf(newStart) + 'px'; d.bar.style.height = xOf.width(newStart, newDue) + 'px'; }
      else { d.bar.style.left = xOf(newStart) + 'px'; d.bar.style.width = xOf.width(newStart, newDue) + 'px'; }

      const broken = d.deps.some(dep => newStart <= dep.due) || d.dependents.some(dep => dep.start <= newDue);
      d.bar.classList.toggle('warn', broken);

      const tip = dragTipEl(); tip.innerHTML = '';
      tip.appendChild(el('span.tip-dot', { style: { background: broken ? '#ff5b6e' : '#5fb0f0' } }));
      tip.appendChild(document.createTextNode(App.fmtRange(newStart, newDue) + (broken ? ' — breaks a dependency' : '')));
      tip.style.display = 'flex';
      tip.style.left = e.clientX + 'px';
      tip.style.top = (e.clientY - 38) + 'px';
    },

    onDragEnd(e) {
      const d = this._drag; if (!d) return;
      this._drag = null;
      document.body.classList.remove('gantt-dragging');
      document.body.style.cursor = '';
      hideDragTip();

      if (d.kind === 'note-draw') {
        d.ghost.remove();
        if (d.moved) {
          const sIso = App.addVisibleDays(this._startIso, d.curA, this._hideWeekends);
          const dIso = App.addVisibleDays(this._startIso, d.curB, this._hideWeekends);
          const id = App.addNote(d.showId, { text: '', start: sIso, due: dIso, color: '#f6be00' });
          if (id) requestAnimationFrame(() => {
            const nEl = this._scrollEl && this._scrollEl.querySelector('.pn-note[data-note-id="' + id + '"]');
            if (nEl) this.openNoteEditor(nEl);
          });
        }
        return;
      }

      if (d.kind === 'create-draw') {
        d.ghost.remove();
        if (d.moved) {
          const sIso = App.addVisibleDays(this._startIso, d.curA, this._hideWeekends);
          const dIso = App.addVisibleDays(this._startIso, d.curB, this._hideWeekends);
          // one-shot per toolbar click: turn the toggle off and re-render
          // before opening the modal, so a Cancel doesn't leave the row
          // sitting there armed for an accidental second draw
          App.state.creatingOnGantt = false;
          App.render();
          App.createFromDrag.open({ startIso: sIso, dueIso: dIso, showId: App.singleShowFilter() });
        }
        return;
      }

      if (d.kind === 'marquee') {
        // read the band before removing it, then hit-test the bars against it
        const box = d.ghost.getBoundingClientRect();
        d.ghost.remove();
        this.suppressNextClick();
        if (!d.moved) return;                        // a shift-click on open grid: nothing to sweep
        if (!d.additive) selClear();
        let added = 0;
        this._scrollEl.querySelectorAll('.g-row.sub:not(.phase) .bar').forEach(b => {
          const r = b.getBoundingClientRect();
          // touched, not enclosed — a band drawn across a long bar means it
          if (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) return;
          const row = b.closest('.g-row.sub');
          const epId = b.dataset.episodeId || row.dataset.episodeId;
          const suKey = b.dataset.suKey || row.dataset.suKey;
          if (!epId || !suKey) return;
          if (!selHas(epId, suKey)) added++;
          selAdd(epId, suKey);
        });
        App.render();
        const total = selList().length;
        App.toast(added
          ? added + ' task' + (added === 1 ? '' : 's') + ' added · ' + total + ' selected'
          : 'Nothing new in that sweep · ' + total + ' selected');
        return;
      }

      if (d.kind === 'group') {
        d.members.forEach(m => { if (m.el) m.el.classList.remove('dragging'); });
        this.suppressNextClick();                    // the mouseup's click isn't "open Edit Task"
        const changed = d.members.filter(m => m.curStart !== m.origStart || m.curDue !== m.origDue);
        if (!changed.length) { App.render(); return; }
        App.moveTasks(changed.map(m => ({ epId: m.epId, suKey: m.suKey, start: m.curStart, due: m.curDue })));
        return;
      }

      // was this a gesture rather than a click? (see DRAG_SLOP / HOLD_MS)
      const held = d.startedAt ? (Date.now() - d.startedAt) >= HOLD_MS : false;
      const wasGesture = !!d.moved || held;
      if (wasGesture) this.suppressNextClick();

      if (d.kind === 'note') {
        d.el.classList.remove('dragging');
        if (d.moved && (d.curStart !== d.origStart || d.curDue !== d.origDue)) {
          App.updateNote(d.showId, d.id, { start: d.curStart, due: d.curDue });
        } else if (!wasGesture) {
          this.openNoteEditor(d.el);   // a plain click opens the editor
        }
        return;
      }

      d.bar.classList.remove('dragging', 'warn');
      if (d.curStart !== d.origStart || d.curDue !== d.origDue) {
        App.track.feature('timeline.dragReschedule');
        App.moveTask(d.epId, d.suKey, d.curStart, d.curDue);
      }
    },

    /* The `click` that follows a drag's mouseup has to be dropped, or releasing
       a bar also opens Edit Task. Cleared on the next tick: click is dispatched
       synchronously after mouseup, so it always arrives before this runs, and
       the flag can never linger to eat a real click later. */
    suppressNextClick() {
      this._clickSuppressed = true;
      setTimeout(() => { this._clickSuppressed = false; }, 0);
    },

    // Called by App.render() before the view is torn down. The isConnected
    // guard skips detached elements (e.g. returning from the Board view), so a
    // stale 0 never overwrites the last real position.
    syncScrollState() {
      const s = this._scrollEl;
      if (!s || !s.isConnected) return;
      App.state.gantt = { scrollLeft: s.scrollLeft, scrollTop: s.scrollTop };
    },

    // ---- scroll settle ----
    // Fires 160ms after the last scroll event. Finds the row boundary nearest
    // the current vertical position and smooth-scrolls to it, offset by the
    // sticky stack above (time header + lane band, + pinned episode row for
    // sub rows when latch scrolling is on). Pure horizontal scrolling is left
    // alone, and our own smooth settle doesn't re-trigger itself.
    settleRows() {
      const s = this._scrollEl;
      if (!s || !s.isConnected) return;
      // This exists for latch scrolling, which Portrait doesn't support (see
      // render()) — summing offsetHeight across what are, in Portrait,
      // side-by-side columns rather than stacked rows wouldn't mean anything.
      if (this._axis && this._axis.portrait) return;
      if (this._settling) { this._settling = false; this._settledTop = s.scrollTop; return; }
      const st = s.scrollTop;
      if (this._settledTop != null && Math.abs(st - this._settledTop) < 2) return;

      const headH = parseFloat(s.style.getPropertyValue('--gantt-head-h')) || 0;
      const lane = s.querySelector('.lane-head');
      const laneH = lane ? lane.offsetHeight : 0;
      const latch = App.prefs.get('latchScroll', false);
      const maxTop = s.scrollHeight - s.clientHeight;
      const body = s.querySelector('.gantt-body');
      if (!body) return;

      // Sticky rows lie about offsetTop while stuck (it tracks the scroll),
      // so derive each row's static position by accumulating flow heights.
      let best = null, y = body.offsetTop, epH = 0;
      [...body.children].forEach(c => {
        const cls = c.classList;
        if (cls.contains('grid-bg') || cls.contains('today-line')) return;  // absolute: not in flow
        if (cls.contains('g-row')) {
          const sub = cls.contains('sub');
          if (!sub) epH = c.offsetHeight;             // the row that would pin above its tasks
          const base = headH + laneH + (latch && sub ? epH : 0);
          const t = Math.max(0, Math.min(y - base, maxTop));
          if (best === null || Math.abs(t - st) < Math.abs(best - st)) best = t;
        }
        y += c.offsetHeight;
      });

      if (best !== null && Math.abs(best - st) > 2) {
        this._settling = true;
        this._settledTop = best;
        s.scrollTo({ top: best, behavior: 'smooth' });
      } else {
        this._settledTop = st;
      }
    },

    buildHead(ctx, tier) {
      const head = el('.time-head');
      const row = el('', { style: { display: 'flex' } });
      row.appendChild(el('.th-corner', {
        style: { position: 'sticky', left: '0', zIndex: '9', width: LABEL_W + 'px', minWidth: LABEL_W + 'px',
                 background: 'var(--bg-2)', borderRight: '1px solid var(--border-2)', display: 'flex',
                 alignItems: 'center', padding: '0 14px', fontSize: '11px', fontWeight: '700', color: 'var(--text-3)' }
      }, { show: 'SHOW / TASK', department: 'DEPARTMENT / TASK' }[App.prefs.get('timelineSort', 'department')] || 'EPISODE / SUBITEM'));
      const cols = el('', { style: { width: (ctx.totalCols * ctx.dw) + 'px' } });
      cols.appendChild(buildSegRow(ctx, tier.primary, 'primary'));
      cols.appendChild(buildSegRow(ctx, tier.secondary, 'secondary'));
      row.appendChild(cols);
      head.appendChild(row);
      return head;
    },

    /* Portrait's mirror of buildHead — sticky LEFT instead of sticky top,
       date segments stacked vertically instead of side by side. The corner
       is sized to COL_HEAD_H (matching every column's own .g-label height)
       rather than LABEL_W, so the first date segment starts at the same page
       Y as every track's own content — both are pushed down by the same
       shared constant, so they line up without either measuring the other. */
    buildDateRail(ctx, tier) {
      const rail = el('.date-rail');
      rail.appendChild(el('.th-corner', {
        style: { position: 'sticky', top: '0', zIndex: '9', height: COL_HEAD_H + 'px', minHeight: COL_HEAD_H + 'px',
                 background: 'var(--bg-2)', borderBottom: '1px solid var(--border-2)', display: 'flex',
                 alignItems: 'center', padding: '0 6px', fontSize: '10px', fontWeight: '700', color: 'var(--text-3)' }
      }, 'DATE'));
      const rows = el('', { style: { display: 'flex', height: (ctx.totalCols * ctx.dw) + 'px' } });
      rows.appendChild(buildSegColumn(ctx, tier.primary, 'primary'));
      rows.appendChild(buildSegColumn(ctx, tier.secondary, 'secondary'));
      rail.appendChild(rows);
      return rail;
    },

    // Shared episode summary row (the collapsed/top line for both the
    // Department and Episode sorts). Returns the .g-row element.
    epTopRow(ep, xOf, dw) {
      const show = App.show(ep.showId);
      const expanded = !!App.state.ganttExpanded[ep.id];
      const prog = App.progressPct(ep);
      const blocked = App.epBlockedCount(ep), overdue = App.epOverdueCount(ep);

      const row = el('.g-row');
      row.dataset.episodeId = ep.id;
      row.appendChild(el('.g-label', null, [
        el('.l-title', null, [
          el('span.chev' + (expanded ? '.open' : ''), null, '▶'),
          el('span', null, ep.title)
        ]),
        el('.l-sub', null, [
          el('span.code', null, ep.code),
          el('span', null, '· ' + App.fmtRange(App.epStart(ep), App.epDue(ep))),
          (overdue ? el('span', { style: { color: '#ff8a95', fontWeight: '700' } }, ['· ', App.icon('warn'), ' ' + overdue]) : null)
        ])
      ]));

      const track = el('.g-track');
      const s = App.epStart(ep), d = App.epDue(ep);
      const left = xOf(s), width = xOf.width(s, d);
      const delivered = App.isDelivered(ep);
      const bar = el('.bar' + (delivered ? '.delivered' : ''), {
        title: ep.code + ' · ' + ep.title + ' — ' + prog + '% · ' + App.epStatusLabel(ep),
        style: {
          left: left + 'px', width: width + 'px',
          background: 'linear-gradient(90deg,' + show.color + ',' + shade(show.color, -16) + ')',
          color: pickInk(show.color)
        }
      }, [
        el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, ep.title),
        (blocked ? App.icon('blocked', { cls: 'blk', title: blocked + ' blocked' }) : null)
      ]);
      if (!delivered && prog > 0) {
        bar.appendChild(el('', { style: {
          position: 'absolute', left: '0', top: '0', bottom: '0', width: prog + '%',
          background: 'rgba(255,255,255,.22)', borderRadius: '6px', pointerEvents: 'none'
        } }));
      }
      attachBar(bar, epBarStatus(ep));
      track.appendChild(bar);
      this.milestoneMarks(track, ep, xOf, dw);
      row.appendChild(track);
      return row;
    },

    /* Delivery Date and Live Date, past the end of the episode's work. Each
       occupies its single day on the grid — a red D and a blue LD — so they read
       as dated events on the calendar rather than annotations floating beside
       the bar. They are not tasks and are never draggable: a date owed to
       someone outside the studio shouldn't be a thing you can nudge with the
       mouse. Clicking one opens its panel, which is where the date is changed. */
    milestoneMarks(track, ep, xOf, dw) {
      if (isCoarse(dw)) return;                  // a one-day mark says nothing at this scale
      App.epMilestones(ep).forEach(m => {
        const late = m.slipDays > 0;
        const mark = el('.ms-day.clickable.ms-' + m.key + (m.fixed ? '.fixed' : '') + (late ? '.late' : ''), {
          style: { left: xOf(m.date) + 'px', width: xOf.width(m.date, m.date) + 'px' },
          title: m.name + ' — ' + App.fmtDate(m.date) +
                 (m.key === App.LIVE_KEY ? '' : m.fixed
                   ? '\nHeld at its own date'
                   : '\n' + m.lead + ' days before the live date') +
                 (late ? '\nThe work now finishes ' + m.slipDays + ' day' + (m.slipDays === 1 ? '' : 's') + ' later' : '') +
                 '\nClick to edit'
        }, el('span.ms-tag', null, m.key === 'live_date' ? 'LD' : 'D'));
        mark.dataset.episodeId = ep.id;
        mark.dataset.msKey = m.key;
        track.appendChild(mark);
      });
    },

    // draw one task bar into a sub-row track (shared by every sort)
    // Task bars are often only a few pixels wide, so they carry no status dot —
    // the label needs the room. Status instead reads from the bar itself:
    // approved is greyed out, and every live state gets a hairline ring in its
    // status colour. Not Started is left plain on purpose.
    // `fill` overrides the bar colour, which the Department sort uses to paint
    // by show instead — there the Y axis already carries the department, so
    // the useful thing to read off a bar is which show it belongs to.
    taskBar(track, ep, su, dep, xOf, dw, labelText, fill, axis) {
      const st = App.status(su.status);
      const done = su.status === 'approved';
      const ring = su.status === 'ready' || su.status === 'in_progress' || su.status === 'review';
      const bg = fill || dep.color;
      const bare = isCoarse(dw);                 // shape only — see isCoarse
      const style = { background: bg, color: pickInk(bg) };
      setBarPos(style, axis, xOf, su.start, su.due);
      if (ring) style.outlineColor = st.color;
      const sbar = el('.bar' + (done ? '.delivered' : '') + (ring ? '.st-ring' : '') + (bare ? '.bare' : '') +
                      (selHas(ep.id, su.key) ? '.selected' : ''), {
        title: (labelText ? labelText + ' — ' : '') + su.name + ' — ' + st.label + ' · ' + App.fmtRange(su.start, su.due),
        style
      }, bare ? null : [
        el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, labelText || su.name),
        (App.isRiskBlocked(ep, su.key) ? App.icon('blocked', { cls: 'blk', title: 'In progress while a dependency is unapproved' }) : null)
      ]);
      sbar.dataset.episodeId = ep.id;
      sbar.dataset.suKey = su.key;
      attachBar(sbar, { color: st.color, label: st.label }, false);
      track.appendChild(sbar);
      return sbar;
    },

    // ---- shared building blocks for the two "many episodes on one line"
    // sorts (Show and Department). Both put a task on the Y axis and the
    // episodes running it on the board. ----

    // Fold a set of episodes into departments → tasks → the episode instances
    // of each task. Department and task order both follow first appearance in
    // the pipelines in view, so shows on different pipelines still interleave
    // in a sensible reading order.
    groupByDept(episodes) {
      const order = [], byDept = {};
      episodes.forEach(ep => {
        const subs = {};
        App.subsView(ep).forEach(su => { subs[su.key] = su; });
        App.pipelineFor(ep).forEach(t => {
          const su = subs[t.key];
          if (!su) return;                                   // filtered out, or not on this episode
          const dk = su.dept || t.dept;
          let group = byDept[dk];
          if (!group) { group = byDept[dk] = { keys: [], tasks: {} }; order.push(dk); }
          if (!group.tasks[t.key]) { group.tasks[t.key] = { name: su.name, items: [] }; group.keys.push(t.key); }
          group.tasks[t.key].items.push({ ep, su });
        });
      });
      return { order, byDept };
    },

    // Every task in a group, flattened to a single {ep, su} list.
    groupItems(group) {
      return group.keys.reduce((all, k) => all.concat(group.tasks[k].items), []);
    },

    // A faint wash of the department's own colour over the usual dark sub-row
    // base — adjacent same-dept rows blend into one band, and the hue shift at
    // a department change reads as a soft divider.
    deptWash(dep) {
      const [r, g, b] = hexToRgb(dep.color);
      return 'linear-gradient(rgba(' + r + ',' + g + ',' + b + ',.07), rgba(' + r + ',' + g + ',' + b + ',.07)), rgba(0,0,0,.16)';
    },

    deptDot(dep) {
      return el('span.dot', { style: { background: dep.color, width: '7px', height: '7px', borderRadius: '50%', flex: 'none' } });
    },

    // Faint span header marking where a department's work starts and ends.
    phaseRow(body, dep, items, xOf, note) {
      const gStart = items.reduce((m, x) => x.su.start < m ? x.su.start : m, items[0].su.start);
      const gDue = items.reduce((m, x) => x.su.due > m ? x.su.due : m, items[0].su.due);
      const [r, g, b] = hexToRgb(dep.color);
      const hrow = el('.g-row.sub.phase', { style: { background: this.deptWash(dep) } });
      hrow.appendChild(el('.g-label', { title: dep.label + ' phase', style: { background: deptLabelBg(dep.color) } }, [
        el('.l-title', { style: { fontWeight: '700', fontSize: '10.5px' } }, [
          this.deptDot(dep),
          el('span', null, dep.label)
        ])
      ]));
      const ht = el('.g-track');
      ht.appendChild(el('.phase-bar', {
        title: dep.label + ' — ' + App.fmtRange(gStart, gDue) + (note ? ' · ' + note : ''),
        style: { left: xOf(gStart) + 'px', width: xOf.width(gStart, gDue) + 'px',
          background: 'rgba(' + r + ',' + g + ',' + b + ',.15)',
          borderColor: 'rgba(' + r + ',' + g + ',' + b + ',.55)' }
      }));
      hrow.appendChild(ht);
      body.appendChild(hrow);
    },

    // One task on the Y axis, its episodes on the board: each {ep, su} drawn
    // as an episode-coded bar in its show's colour — a line here mixes shows,
    // and the department is already named on the axis. Bars spill onto
    // continuation rows whenever two would overlap in time.
    epTaskLines(body, dep, title, items, xOf, dw, axis) {
      const sorted = items.slice().sort((a, b) => a.su.start < b.su.start ? -1 : 1);
      const levels = [];
      sorted.forEach(it => {
        const lvl = levels.find(l => it.su.start > l.lastDue);
        if (lvl) { lvl.lastDue = it.su.due; lvl.items.push(it); }
        else levels.push({ lastDue: it.su.due, items: [it] });
      });

      const wash = this.deptWash(dep);
      levels.forEach((lvl, li) => {
        const srow = el('.g-row.sub', { style: { background: wash } });
        srow.appendChild(el('.g-label', { title: dep.label + ' — ' + title, style: { background: deptLabelBg(dep.color) } }, [
          el('.l-title', { style: { fontWeight: '600', fontSize: '10.5px' } }, li === 0 ? [
            this.deptDot(dep),
            el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, title)
          ] : [])   // continuation row (Landscape) / continuation column (Portrait) — no marker
        ]));
        const st = el('.g-track');
        // identity lives on each bar, not the row: one line holds many episodes.
        // A "level" here is an interval-stacking lane (see the loop above) —
        // in Landscape an overlap becomes an extra stacked row; in Portrait,
        // .gantt-body's flex-row (CSS) turns that same extra .g-row.sub into
        // an extra side-by-side sub-column instead. Same algorithm either way.
        lvl.items.forEach(({ ep, su }) => {
          const show = App.show(ep.showId);
          this.taskBar(st, ep, su, dep, xOf, dw, ep.code, show && show.color, axis);
        });
        srow.appendChild(st);
        body.appendChild(srow);
      });
    },

    // One department on the Y axis, its tasks on the board (the Episode and
    // Show sorts both read this way). A department holding more than one task
    // gets a phase-span header naming it, with its tasks stacked directly
    // beneath — tasks that don't overlap in time share a line, so parallel
    // work reads at a glance. `barLabel` names each bar; it varies because a
    // show's line carries tasks from several episodes at once.
    deptStackedLines(body, dep, items, xOf, dw, barLabel) {
      const sorted = items.slice().sort((a, b) => a.su.start < b.su.start ? -1 : 1);
      if (!sorted.length) return;
      const multi = sorted.length > 1;

      // phase-span header — only worth it for a multi-task department
      if (multi) this.phaseRow(body, dep, sorted, xOf, sorted.length + ' tasks');

      // interval-stack: a task shares a line unless it overlaps the last one
      const levels = [];
      sorted.forEach(it => {
        const lvl = levels.find(l => it.su.start > l.lastDue);
        if (lvl) { lvl.lastDue = it.su.due; lvl.items.push(it); }
        else levels.push({ lastDue: it.su.due, items: [it] });
      });

      const wash = this.deptWash(dep);
      levels.forEach(lvl => {
        const srow = el('.g-row.sub', { style: { background: wash } });
        srow.appendChild(el('.g-label', { title: dep.label, style: { background: deptLabelBg(dep.color) } },
          el('.l-title', { style: { fontWeight: '600', fontSize: '10.5px' } },
            multi
              ? []                       // the phase header above already names it
              : [this.deptDot(dep),
                 el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, dep.label)]
          )
        ));
        const st = el('.g-track');
        // identity lives on each bar, not the row: one line can hold many episodes
        lvl.items.forEach(it => this.taskBar(st, it.ep, it.su, dep, xOf, dw, barLabel && barLabel(it)));
        srow.appendChild(st);
        body.appendChild(srow);
      });
    },

    // "Department" sort: one top row per department, spanning every episode in
    // view; expand → one line per task in that department, each line holding a
    // bar per episode running it.
    departmentRows(body, episodes, startIso, dw, timeW, xOf, axis) {
      const { order, byDept } = this.groupByDept(episodes);
      const portrait = !!(axis && axis.portrait);

      order.forEach(dk => {
        const dep = App.dept(dk), group = byDept[dk];
        const all = this.groupItems(group);
        if (!all.length) return;

        const expKey = 'dept:' + dk;
        const expanded = !!App.state.ganttExpanded[expKey];
        let min = '9999', max = '0000', done = 0;
        all.forEach(({ su }) => {
          if (su.start < min) min = su.start;
          if (su.due > max) max = su.due;
          if (su.status === 'approved') done++;
        });
        const prog = Math.round(done / all.length * 100);
        const epCount = new Set(all.map(x => x.ep.id)).size;
        const complete = done === all.length;

        const row = el('.g-row');
        row.dataset.episodeId = expKey;                       // expansion key via the shared click handler
        row.appendChild(el('.g-label', null, [
          el('.l-title', null, [
            el('span.chev' + (expanded ? '.open' : ''), null, '▶'),
            this.deptDot(dep),
            el('span', null, dep.label)
          ]),
          el('.l-sub', null, [
            el('span.code', null, group.keys.length + ' task' + (group.keys.length === 1 ? '' : 's')),
            el('span', null, '· ' + epCount + ' ep' + (epCount === 1 ? '' : 's') + ' · ' + App.fmtRange(min, max))
          ])
        ]));

        const track = el('.g-track');
        const barStyle = {
          background: 'linear-gradient(' + (portrait ? '180deg' : '90deg') + ',' + dep.color + ',' + shade(dep.color, -16) + ')',
          color: pickInk(dep.color)
        };
        setBarPos(barStyle, axis, xOf, min, max);
        const bar = el('.bar' + (complete ? '.delivered' : ''), {
          title: dep.label + ' — ' + group.keys.length + ' task' + (group.keys.length === 1 ? '' : 's') +
                 ' across ' + epCount + ' episode' + (epCount === 1 ? '' : 's') + ' · ' + prog + '% complete',
          style: barStyle
        }, [el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, dep.label)]);
        if (!complete && prog > 0) {
          const fillStyle = portrait
            ? { position: 'absolute', top: '0', left: '0', right: '0', height: prog + '%' }
            : { position: 'absolute', left: '0', top: '0', bottom: '0', width: prog + '%' };
          fillStyle.background = 'rgba(255,255,255,.22)'; fillStyle.borderRadius = '6px'; fillStyle.pointerEvents = 'none';
          bar.appendChild(el('', { style: fillStyle }));
        }
        attachBar(bar, complete ? { color: '#00c875', label: 'Complete' } : { color: '#fdab3d', label: prog + '% complete' });
        track.appendChild(bar);
        row.appendChild(track);
        body.appendChild(row);
        if (!expanded) return;

        group.keys.forEach(k => this.epTaskLines(body, dep, group.tasks[k].name, group.tasks[k].items, xOf, dw, axis));
      });
    },

    // "Episode" sort (modelled on the studio's wall planner): one row per
    // episode; expand → tasks grouped by department in pipeline order. Each
    // department with 2+ tasks gets a faint phase-span header showing where it
    // starts and ends, with its tasks stacked directly beneath — tasks that
    // don't overlap in time share a row so parallel work reads at a glance.
    episodeStackedRow(body, ep, startIso, dw, timeW, xOf) {
      body.appendChild(this.epTopRow(ep, xOf, dw));
      if (!App.state.ganttExpanded[ep.id]) return;

      const { order, byDept } = this.groupByDept([ep]);
      order.forEach(dk => {
        const group = byDept[dk];
        this.deptStackedLines(body, App.dept(dk), this.groupItems(group), xOf, dw, null);
      });
    },

    // "Show" sort: one top row per show; expand → the show's departments on
    // the Y axis with their tasks on the board, exactly as the Episode sort
    // reads, but pooling every episode of the show onto the same lines.
    showRow(body, show, eps, startIso, dw, timeW, xOf) {
      const expKey = 'show:' + show.id;
      const expanded = !!App.state.ganttExpanded[expKey];
      let min = '9999', max = '0000', delivered = true, prog = 0;
      eps.forEach(ep => {
        const s = App.epStart(ep), d = App.epDue(ep);
        if (s < min) min = s; if (d > max) max = d;
        if (!App.isDelivered(ep)) delivered = false;
        prog += App.progressPct(ep);
      });
      prog = Math.round(prog / eps.length);

      const row = el('.g-row');
      row.dataset.episodeId = expKey;                       // expansion key via the shared click handler
      row.appendChild(el('.g-label', null, [
        el('.l-title', null, [
          el('span.chev' + (expanded ? '.open' : ''), null, '▶'),
          el('span', null, show.name)
        ]),
        el('.l-sub', null, [
          el('span.code', null, eps.length + ' episode' + (eps.length === 1 ? '' : 's')),
          el('span', null, '· ' + App.fmtRange(min, max))
        ])
      ]));

      const track = el('.g-track');
      const left = xOf(min), width = xOf.width(min, max);
      const bar = el('.bar' + (delivered ? '.delivered' : ''), {
        title: show.name + ' — ' + eps.length + ' episode' + (eps.length === 1 ? '' : 's') + ' · ' + prog + '% complete',
        style: {
          left: left + 'px', width: width + 'px',
          background: 'linear-gradient(90deg,' + show.color + ',' + shade(show.color, -16) + ')',
          color: pickInk(show.color)
        }
      }, [el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, show.name)]);
      if (!delivered && prog > 0) {
        bar.appendChild(el('', { style: {
          position: 'absolute', left: '0', top: '0', bottom: '0', width: prog + '%',
          background: 'rgba(255,255,255,.22)', borderRadius: '6px', pointerEvents: 'none'
        } }));
      }
      attachBar(bar, delivered ? { color: '#00c875', label: 'Delivered' } : { color: '#fdab3d', label: prog + '% complete' });
      track.appendChild(bar);
      row.appendChild(track);
      body.appendChild(row);
      if (!expanded) return;

      // departments on the Y axis, tasks on the board — the Episode sort's
      // layout, widened to every episode of the show at once. Bars therefore
      // lead with the episode code, since one line now mixes episodes.
      const { order, byDept } = this.groupByDept(eps);
      order.forEach(dk => {
        this.deptStackedLines(body, App.dept(dk), this.groupItems(byDept[dk]), xOf, dw,
          it => it.ep.code + ' · ' + it.su.name);
      });
    },

    // ---- Producer Notes swimlane ----
    // A collapsible band at the top of the timeline holding free-form, date-
    // ranged producer annotations for the selected show. Notes interval-stack
    // onto as many rows as needed so overlapping notes never hide each other.
    // Click-drag an empty grid cell to draw a new note, click a note to
    // edit/recolour/delete, drag the middle to move or an edge to resize
    // (weekend-aware, same math as task bars).
    /* "+ Create" row — a blank canvas at the very top of the timeline,
       identical in every sort mode (no per-row context to infer show/episode/
       department from once a row spans more than one episode, so nothing here
       tries to). Drawing a date range opens App.createFromDrag (js/dialog.js)
       to ask explicitly and confirm before anything is written — unlike a
       Producer Note, an episode or task is a structural, team-visible entity,
       not a lightweight annotation that's safe to save-then-edit. */
    createRow(body, startIso, dw, xOf) {
      const row = el('.g-row.create-row');
      row.appendChild(el('.g-label.create-label', null,
        el('.l-title', null, el('span', { style: { fontSize: '10px', color: 'var(--text-3)' } }, 'Drag to create an episode or task →'))));
      row.appendChild(el('.g-track.cr-drawable'));
      body.appendChild(row);
    },

    producerNotesLane(body, showId, startIso, dw, xOf) {
      const show = App.show(showId);
      if (!show) return;
      const notes = (show.notes || []).slice().sort((a, b) => a.start < b.start ? -1 : 1);
      const open = App.state.notesOpen !== false;   // default open
      const canEdit = App.canEditNotes();

      // header row
      const head = el('.g-row.pn-head');
      const label = el('.g-label.pn-label', {
        title: 'Producer notes for ' + show.name,
        onclick: () => { App.state.notesOpen = !open; App.render(); }
      }, [
        el('.l-title', null, [
          el('span.chev' + (open ? '.open' : ''), null, '▶'),
          el('span', null, 'PRODUCER NOTES'),
          el('span.pn-count', null, notes.length ? String(notes.length) : '')
        ])
      ]);
      head.appendChild(label);
      head.appendChild(el('.g-track'));   // empty track keeps the header aligned
      body.appendChild(head);
      if (!open) return;

      // Shape every note first: one whose text can't fit across its (usually
      // short) date span flips to an upright portrait box, which makes its row
      // taller. HFONT/VSTEP ≈ px per character horizontally / vertically at 10px.
      const HFONT = 5.6, VSTEP = 7.4;
      const shaped = notes.map(n => {
        const width = xOf.width(n.start, n.due);
        const text = n.text || 'Untitled note';
        const fitsFlat = width - 16 >= text.length * HFONT;
        const portraitH = Math.max(36, Math.min(84, Math.round(text.length * VSTEP) + 14));
        return { n, width, text, portrait: !fitsFlat, portraitH };
      });

      // Interval-stack, but keep portrait notes on their own lanes and flat
      // notes on theirs: portrait notes pack tightly together (a tall row is
      // costly, so we don't want a flat note stranding a portrait note onto a
      // fresh tall row) — this is the "vertical notes share a lane" priority.
      const stack = (arr) => {
        const lv = [];
        arr.forEach(s => {
          const l = lv.find(x => s.n.start > x.lastDue);
          if (l) { l.lastDue = s.n.due; l.items.push(s); }
          else lv.push({ lastDue: s.n.due, items: [s] });
        });
        return lv;
      };
      const levels = [...stack(shaped.filter(s => s.portrait)), ...stack(shaped.filter(s => !s.portrait))];
      if (!levels.length) levels.push({ items: [] });          // hint / draw row when empty
      if (canEdit) levels.push({ items: [] });                 // spare row so there's always open grid to draw in

      levels.forEach((lvl, li) => {
        const rowH = lvl.items.reduce((m, s) => s.portrait ? Math.max(m, s.portraitH + 8) : m, 26);
        const row = el('.g-row.sub.pn-row', { style: { minHeight: rowH + 'px' } });
        row.appendChild(el('.g-label.pn-sublabel', null,
          el('.l-title', { style: { fontWeight: '600', fontSize: '10px' } },
            li === 0 && !notes.length
              ? [el('span', { style: { color: 'var(--text-3)', paddingLeft: '13px' } }, canEdit ? 'Drag to add a note' : 'No notes')]
              : [])   // no ↳ continuation markers for note rows
        ));
        const track = el('.g-track' + (canEdit ? '.pn-drawable' : ''));
        lvl.items.forEach(s => {
          const n = s.n;
          const left = xOf(n.start);
          const ink = pickInk(n.color || '#f6be00');
          const style = { left: left + 'px', width: s.width + 'px', background: n.color || '#f6be00', color: ink };
          if (s.portrait) style.height = s.portraitH + 'px';
          const note = el('.pn-note' + (canEdit ? '.editable' : '') + (s.portrait ? '.portrait' : ''), {
            title: s.text + ' · ' + App.fmtRange(n.start, n.due),
            style: style
          }, [el('span', null, s.text)]);
          note.dataset.noteId = n.id;
          note.dataset.showId = showId;
          track.appendChild(note);
        });
        row.appendChild(track);
        body.appendChild(row);
      });
    },

    // DRAWING: mousedown on empty notes grid starts a ghost; drag sets its span
    startNoteDraw(e, trackEl) {
      const dw = this._dw;
      const rect = trackEl.getBoundingClientRect();
      const startCol = Math.max(0, Math.round((e.clientX - rect.left) / dw));
      const ghost = el('.pn-note.pn-ghost', {
        style: { left: (startCol * dw) + 'px', width: dw + 'px', background: '#5b6cff', color: '#fff' }
      }, el('span', null, 'New note'));
      trackEl.appendChild(ghost);
      this._drag = {
        kind: 'note-draw', showId: App.singleShowFilter(), ghost,
        startCol, startClientX: e.clientX, curA: startCol, curB: startCol, moved: false
      };
      document.body.classList.add('gantt-dragging');
      document.body.style.cursor = 'ew-resize';
    },

    // mirrors startNoteDraw exactly — same ghost/ drag mechanics, different
    // color so a create-draw never reads as "drawing a note"
    startCreateDraw(e, trackEl) {
      const dw = this._dw;
      const rect = trackEl.getBoundingClientRect();
      const startCol = Math.max(0, Math.round((e.clientX - rect.left) / dw));
      const ghost = el('.create-ghost', {
        style: { left: (startCol * dw) + 'px', width: dw + 'px', background: '#9b5bff', color: '#fff' }
      }, el('span', null, 'New'));
      trackEl.appendChild(ghost);
      this._drag = {
        kind: 'create-draw', ghost,
        startCol, startClientX: e.clientX, curA: startCol, curB: startCol, moved: false
      };
      document.body.classList.add('gantt-dragging');
      document.body.style.cursor = 'ew-resize';
    },

    NOTE_COLORS: ['#f6be00', '#ff6f9c', '#6cc2f0', '#6cc24a', '#a06cd5', '#ff7a59', '#9aa0ad'],

    openNoteEditor(noteEl) {
      this.closeNoteEditor();
      const showId = noteEl.dataset.showId, id = noteEl.dataset.noteId;
      const show = App.show(showId);
      const note = show && (show.notes || []).find(n => n.id === id);
      if (!note) return;
      const r = noteEl.getBoundingClientRect();

      const origText = note.text || '', curColor = note.color || '#f6be00';
      const input = el('input.pn-note-input', {
        type: 'text', value: origText, placeholder: 'Note…',
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') this.closeNoteEditor(); }
      });
      const swatches = el('.pn-swatches', null, this.NOTE_COLORS.map(c =>
        el('button.pn-swatch' + (c === curColor ? '.on' : ''), {
          style: { background: c }, title: c,
          // commit text + colour together; the resulting re-render closes us
          onclick: () => { App.updateNote(showId, id, { text: input.value, color: c }); }
        })
      ));

      const pop = el('.pn-editor', { onclick: (e) => e.stopPropagation(), onmousedown: (e) => e.stopPropagation() }, [
        input,
        swatches,
        el('.pn-editor-actions', null, [
          el('button.pn-del', { onclick: () => { pop._commit = null; this.closeNoteEditor(); App.removeNote(showId, id); } }, [App.icon('trash'), ' Delete']),
          el('button.pn-done', { onclick: () => this.closeNoteEditor() }, 'Done')
        ])
      ]);
      // remember what to commit on teardown, without re-reading stale state
      pop._commit = () => { if (input.value !== origText) App.updateNote(showId, id, { text: input.value }); };
      document.body.appendChild(pop);
      this._noteEditor = pop;

      requestAnimationFrame(() => {
        const pw = pop.offsetWidth, ph = pop.offsetHeight;
        let left = r.left, top = r.bottom + 8;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
        if (top + ph > window.innerHeight - 8) top = r.top - ph - 8;   // flip above
        pop.style.left = Math.max(8, left) + 'px';
        pop.style.top = Math.max(8, top) + 'px';
        input.focus(); input.select();
      });

      if (!this._noteOutside) {
        this._noteOutside = () => this.closeNoteEditor();
        setTimeout(() => document.addEventListener('mousedown', this._noteOutside), 0);
      }
    },

    closeNoteEditor() {
      if (this._noteOutside) { document.removeEventListener('mousedown', this._noteOutside); this._noteOutside = null; }
      const pop = this._noteEditor;
      this._noteEditor = null;                 // clear first so the commit's re-render is a no-op re-entry
      // sweep the tracked editor plus any orphan left by a re-entrant path
      document.querySelectorAll('.pn-editor').forEach(p => { if (p !== pop) p.remove(); });
      if (!pop) return;
      pop.remove();
      if (pop._commit) pop._commit();          // may trigger a render; editor already detached
    },

    afterMount() {
      const scroll = this._scrollEl;
      if (!scroll) return;
      const portrait = !!(this._axis && this._axis.portrait);

      // Measure the sticky time-head height and expose it as a CSS variable so
      // lane-head sticky top aligns flush beneath it (avoids a hardcoded px
      // value). Landscape only — Portrait has no lane-head/latch equivalent
      // (see render()'s Producer Notes note and settleRows' guard), and its
      // own header (.date-rail) is sized from the DATE_RAIL_W/COL_HEAD_H
      // constants, not measured, the same way LABEL_W isn't measured either.
      if (!portrait) {
        const head = scroll.querySelector('.time-head');
        if (head) {
          scroll.style.setProperty('--gantt-head-h', head.offsetHeight + 'px');
          // latch scrolling pins episode rows one slot lower: under the lane band
          const lane = scroll.querySelector('.lane-head');
          scroll.style.setProperty('--latch-top', (head.offsetHeight + (lane ? lane.offsetHeight : 0)) + 'px');
        }
      }

      // Restore synchronously — the element is already in the DOM, so setting
      // scrollLeft/Top here paints the first frame in the right place. Waiting
      // a frame (rAF) shows one frame at position 0 and reads as a jump.
      const st = App.state.gantt || {};
      if (this._preserve) {                                    // zoom — keep the anchored date under the cursor
        if (portrait) {
          scroll.scrollTop = this._preserve.dayOffset * App.state.zoom + COL_HEAD_H - this._preserve.screenPos;
          scroll.scrollLeft = st.scrollLeft || 0;
        } else {
          scroll.scrollLeft = this._preserve.dayOffset * App.state.zoom + LABEL_W - this._preserve.screenPos;
          scroll.scrollTop = st.scrollTop || 0;
        }
        this._preserve = null;
      } else if (this._wantCenter) {                           // first load — centre on today
        const t = scroll.querySelector('.today-line');
        if (t) {
          if (portrait) scroll.scrollTop = Math.max(0, parseFloat(t.style.top) - scroll.clientHeight * 0.38);
          else scroll.scrollLeft = Math.max(0, parseFloat(t.style.left) - scroll.clientWidth * 0.38);
        }
        this._wantCenter = false;
      } else {                                                 // every other re-render — exact position
        scroll.scrollLeft = st.scrollLeft || 0;
        scroll.scrollTop = st.scrollTop || 0;
      }
      App.state.gantt = { scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop };
      // the restore above fires a scroll event — mark this position as already
      // settled so re-renders (edits, polling) never nudge the view
      this._settledTop = scroll.scrollTop;
      this._settling = false;
    },

    zoomBy(f) {
      const old = App.state.zoom, s = this._scrollEl;
      const portrait = !!(this._axis && this._axis.portrait);
      if (s) {
        if (portrait) { const sy = s.clientHeight / 2; this._preserve = { dayOffset: (s.scrollTop + sy - COL_HEAD_H) / old, screenPos: sy }; }
        else { const sx = s.clientWidth / 2; this._preserve = { dayOffset: (s.scrollLeft + sx - LABEL_W) / old, screenPos: sx }; }
      }
      App.state.zoom = clampZoom(old * f);
      App.render();
    },

    // Deliberate navigation is the ONE place smooth scrolling belongs — scroll
    // in place with no re-render, so nothing else on the page can shift.
    centerToday() {
      const s = this._scrollEl;
      if (!s) { this._wantCenter = true; App.render(); return; }
      const t = s.querySelector('.today-line');
      if (!t) return;
      if (this._axis && this._axis.portrait) s.scrollTo({ top: Math.max(0, parseFloat(t.style.top) - s.clientHeight * 0.38), behavior: 'smooth' });
      else s.scrollTo({ left: Math.max(0, parseFloat(t.style.left) - s.clientWidth * 0.38), behavior: 'smooth' });
    }
  };

  function attachBar(bar, st, dot) {
    if (dot !== false) bar.appendChild(el('span.bar-dot', { style: { background: st.color } }));
    bar.addEventListener('mouseenter', (e) => showTip(e, st.color, st.label));
    bar.addEventListener('mousemove', positionTip);
    bar.addEventListener('mouseleave', hideTip);
  }

  function tipEl() {
    if (!App._gtip) { App._gtip = el('.bar-tip'); App._gtip.style.display = 'none'; document.body.appendChild(App._gtip); }
    return App._gtip;
  }

  function showTip(e, color, label) {
    const t = tipEl(); t.innerHTML = '';
    t.appendChild(el('span.tip-dot', { style: { background: color } }));
    t.appendChild(document.createTextNode(label));
    t.style.display = 'flex'; positionTip(e);
  }

  function positionTip(e) { const t = tipEl(); t.style.left = e.clientX + 'px'; t.style.top = (e.clientY - 38) + 'px'; }
  function hideTip() { if (App._gtip) App._gtip.style.display = 'none'; }

  // separate element for the drag-reschedule preview — keeps it immune to the
  // hover tooltip's own mouseenter/mouseleave lifecycle (which would otherwise
  // hide it mid-drag the instant the cursor drifts off the moving bar)
  function dragTipEl() {
    if (!App._gDragTip) { App._gDragTip = el('.bar-tip.drag-tip'); App._gDragTip.style.display = 'none'; document.body.appendChild(App._gDragTip); }
    return App._gDragTip;
  }
  function hideDragTip() { if (App._gDragTip) App._gDragTip.style.display = 'none'; }

  function epBarStatus(ep) {
    const map = { working: 'in_progress', review: 'review', pending: 'not_started', delivered: 'approved' };
    const sk = map[App.epGroup(ep)] || 'not_started';
    return { color: App.STATUSES[sk].color, label: App.STATUSES[sk].label };
  }

  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  // Opaque department wash for the sticky label column — it must stay solid
  // (never rgba) or bars scrolling underneath show through the sticky column.
  // The base is the live --surface-2, sampled once per theme so the blend
  // follows whichever palette is active instead of a baked-in dark value.
  let _labelBase = { theme: null, rgb: [30, 33, 42] };
  function subLabelBase() {
    const theme = document.documentElement.getAttribute('data-theme') || '';
    if (_labelBase.theme !== theme) {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim();
      _labelBase = { theme, rgb: /^#[0-9a-f]{6}$/i.test(v) ? hexToRgb(v) : [30, 33, 42] };
    }
    return _labelBase.rgb;
  }
  function deptLabelBg(deptHex) {
    const [dr, dg, db] = hexToRgb(deptHex);
    const base = subLabelBase();
    const t = 0.16;
    const mix = (b, d) => Math.round(b * (1 - t) + d * t);
    return 'rgb(' + mix(base[0], dr) + ',' + mix(base[1], dg) + ',' + mix(base[2], db) + ')';
  }
  function shade(hex, amt) {
    const [r, g, b] = hexToRgb(hex);
    const f = (c) => Math.max(0, Math.min(255, c + amt));
    return '#' + [f(r), f(g), f(b)].map(c => c.toString(16).padStart(2, '0')).join('');
  }
  function pickInk(hex) {
    const [r, g, b] = hexToRgb(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 165 ? '#11131a' : '#fff';
  }
  App.pickInk = pickInk;
})();
