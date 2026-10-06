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
  /* A bar's time-off pauses (.bar-hol) belong to the calendar, not the
     task: while a bar is dragged or stretched they stay on the holiday's own
     dates, clipped to whatever part of the bar still covers them. */
  function placePauses(bar, portrait) {
    const pauses = bar.querySelectorAll('.bar-hol'); if (!pauses.length) return;
    const p0 = portrait ? 'top' : 'left', sz = portrait ? 'height' : 'width';
    const pos = parseFloat(bar.style[p0]) || 0, size = parseFloat(bar.style[sz]) || 0;
    pauses.forEach(pz => {
      const a = Math.max(+pz.dataset.at - pos, 0), b = Math.min(+pz.dataset.at + +pz.dataset.len - pos, size);
      pz.style.display = b > a ? '' : 'none';
      pz.style[p0] = a + 'px'; pz.style[sz] = Math.max(0, b - a) + 'px';
    });
  }
  function setBarPos(style, axis, xOf, s, d) {
    if (axis && axis.portrait) { style.top = xOf(s) + 'px'; style.height = xOf.width(s, d) + 'px'; }
    else { style.left = xOf(s) + 'px'; style.width = xOf.width(s, d) + 'px'; }
  }

  /* A summary bar's gradient runs ALONG the time axis, so it has to turn with
     it — a 90deg gradient on a tall thin Portrait bar bands it edge-to-edge
     across its 5px width instead of along its length. */
  function barGradient(color, axis) {
    return 'linear-gradient(' + (axis && axis.portrait ? '180deg' : '90deg') + ',' +
           color + ',' + shade(color, -16) + ')';
  }

  /* The progress wash inside a summary bar — the "x% done" overlay. Grows
     along the time axis (leading edge first) in either orientation, which
     means swapping which pair of sides it pins to. Shared by all four
     summary-bar builders (episode, show, department, show-department). */
  function progressFill(prog, axis) {
    const style = (axis && axis.portrait)
      ? { position: 'absolute', top: '0', left: '0', right: '0', height: prog + '%' }
      : { position: 'absolute', left: '0', top: '0', bottom: '0', width: prog + '%' };
    style.background = 'rgba(255,255,255,.22)';
    style.borderRadius = '6px';
    style.pointerEvents = 'none';
    return el('', { style });
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
  /* Resources view cell size for a zoom (px per day): days once a day is wide
     enough for a legible circle — the top of the zoom range — weeks until a
     week gets too narrow for one, then months. */
  const RES_DAY_MIN = 32;
  function resourceUnit(dw) {
    if (dw >= RES_DAY_MIN) return 'days';
    return dw * 5 >= 18 ? 'weeks' : 'months';
  }

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
  App.ganttSelection = { has: selHas, clear: selClear, resolved: selResolved, toggle: selToggle, add: selAdd };

  /* Opt means "all". Opt+Shift on a row label takes every task that row stands
     for — an episode, a department, a show, one task across episodes — so each
     label row carries its own {ep, su} list, rebuilt with the row on every
     render. Built from the data rather than the drawn bars, so an episode left
     collapsed still gives up its tasks. */
  App.ganttSelection.all = (items) => selAll(items);
  const selRow = (row, items) => { row._selItems = items; return row; };
  const epItems = (ep) => App.subsView(ep).map(su => ({ ep, su }));
  // one press adds the lot, unless the lot is already picked — then it drops it
  function selAll(items) {
    const adding = !items.every(({ ep, su }) => selHas(ep.id, su.key));
    items.forEach(({ ep, su }) => {
      if (adding) selAdd(ep.id, su.key);
      else if (selHas(ep.id, su.key)) selToggle(ep.id, su.key);
    });
    return adding;
  }

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
  App.wheelZoomFactor = wheelZoomFactor;   // the episode preview zooms the same way (js/pipeviz.js)

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

  /* The Timeline's time axis, for other views that draw dates the same way
     (Smart import's sheet and dependency views) — the same zoom tiers, header
     cells and grid lines, so a date reads identically wherever it's drawn. */
  App.ganttAxis = { tierFor, clampZoom, segments, buildSegRow, gridLines, mondayOf };

  App.gantt = {
    _wantCenter: true,
    _scrollEl: null,
    _rafId: null,

    render(episodes) {
      this._episodes = episodes;       // what "all" means for the Opt shortcuts
      const sort = App.timelineGrouping();
      // Resources mode (the toolbar's Schedule / Resources switch): the same
      // time axis, header, zoom and today line, with departments and people
      // as the rows instead of episodes — see resourceRows. Landscape only.
      const resMode = App.timelineMode() === 'resources';
      if (!resMode) this._resSnap = null;   // re-entering Resources shouldn't animate from a stale zoom
      /* Portrait (time runs top-to-bottom) applies to all three sorts. Every
         sort's rows are built from the same .g-row/.g-label/.g-track shape, so
         Portrait is the same two things everywhere: bars written along the
         other axis (setBarPos), and .gantt-body flipped to flex-row in CSS so
         a "row" lays out as a column. Grouping, ordering and interval-stacking
         are untouched and orientation-agnostic in all three. */
      const portrait = !resMode && App.prefs.get('timelineOrientation', 'landscape') === 'portrait';
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
      // the dates in view, for painting holidays; spans are cached per render
      this._vis = { start: startIso, end: App.isoDate(end) };
      this._holCache = {};

      /* Hide weekends switched since the last render: every column shifts, so
         the same scroll offset would land on different dates. Find the date
         that sat mid-view under the old column map and keep it there under
         the new one (via _preserve, the same hand-off zoom uses). */
      if (this._hideWeekends !== undefined && this._hideWeekends !== hideWeekends && this._startIso && this._dw && App.state.gantt) {
        const g = App.state.gantt;
        const pos = portrait ? (this._viewH || 0) / 2 : (this._viewW || 0) / 2;
        const off = portrait ? (g.scrollTop || 0) + pos - COL_HEAD_H : (g.scrollLeft || 0) + pos - LABEL_W;
        const oldCol = Math.max(0, off / this._dw);
        const whole = Math.floor(oldCol);
        const date = App.addVisibleDays(this._startIso, whole, this._hideWeekends);
        this._preserve = { dayOffset: colOf(date) + (oldCol - whole), screenPos: pos };
      }

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

      // the ruler's body half — a band down the whole chart over the measured
      // dates. Landscape only: the header it's drawn from is Landscape's.
      this._rulerHead = portrait ? null : this._rulerHead;
      this._rulerBand = portrait ? null : el('.ruler-band');
      if (this._rulerBand) body.appendChild(this._rulerBand);
      this.paintRuler();

      // Producer Notes swimlane — per-show annotations, only meaningful when a
      // single show is in view (nonsensical mixed across shows on "All shows").
      // Not yet given a Portrait transpose (it has its own unrelated .portrait
      // meaning already — narrow notes flipping to vertical text — and its own
      // transpose problem); hidden in Portrait rather than half-drawn.
      const singleShow = App.singleShowFilter();
      if (singleShow && !portrait && !resMode) this.producerNotesLane(body, singleShow, startIso, dw, xOf);

      const byStart = (a, b) => App.epStart(a) < App.epStart(b) ? -1 : 1;
      // All shows: the executive view — departments and the two dates that
      // matter, no tasks (see execRows). Landscape only.
      if (resMode) {
        this.resourceRows(body, ctx);
      } else if (!App.state.filters.show.length && !portrait) {
        this.execRows(body, episodes.slice().sort(byStart), xOf, dw, axis);
      } else if (sort === 'show') {
        // one row per show; matching tasks across its episodes share a line
        const byShow = {};
        episodes.forEach(ep => (byShow[ep.showId] = byShow[ep.showId] || []).push(ep));
        Object.values(byShow)
          .map(eps => eps.sort(byStart))
          .sort((a, b) => byStart(a[0], b[0]))
          .forEach(eps => this.showRow(body, App.show(eps[0].showId), eps, startIso, dw, timeW, xOf, axis));
      } else if (sort === 'episode') {
        // one row per episode; expand into department-grouped, stacked task rows
        episodes.slice().sort(byStart).forEach(ep => this.episodeStackedRow(body, ep, startIso, dw, timeW, xOf, axis));
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

      fitBarLabels(wrap);
      return wrap;
    },

    setupEventDelegation() {
      if (!this._scrollEl) return;
      const self = this;

      const handleClick = (e) => {
        // a drag or a hold just ended on this element — that gesture already had
        // its effect, and it isn't "open Edit Task"
        if (self._clickSuppressed) { e.stopPropagation(); return; }
        // a time-off note: its own small editor (edit on the holidays page, or delete)
        const holNote = e.target.closest('.pn-holiday');
        if (holNote) { e.stopPropagation(); self.openHolidayNote(holNote); return; }

        const mark = e.target.closest('.ms-day.clickable');
        if (mark) {
          e.stopPropagation();
          if (mark.dataset.episodeId && mark.dataset.msKey && App.milestoneDialog) {
            App.milestoneDialog.open(mark.dataset.episodeId, mark.dataset.msKey);
          }
          return;
        }

        // the ✕ on a "leftover revisions" ghost — dismiss, not open anything
        const ghostX = e.target.closest('.rev-ghost-x');
        if (ghostX) {
          e.stopPropagation();
          const g = ghostX.closest('.rev-ghost');
          if (g && g.dataset.episodeId && g.dataset.suKey && App.clearRevisionGhost) {
            App.clearRevisionGhost(g.dataset.episodeId, g.dataset.suKey);
          }
          return;
        }
        // the ghost's own body — not interactive otherwise, just don't fall
        // through to a click on the track underneath it
        if (e.target.closest('.rev-ghost')) { e.stopPropagation(); return; }

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
        if (!row) return;
        // `.sub` rows are normally terminal (a task line, nothing further to
        // open) — `.exp` is the one exception: the Show sort's nested
        // Department row, indented like a `.sub` row but still expandable
        // onto its own tasks. See showDeptRows.
        if (row.classList.contains('sub') && !row.classList.contains('exp')) return;

        const epId = row.dataset.episodeId;
        if (!epId) return;

        e.preventDefault();
        if (e.altKey) self.expandAllLike(epId, !App.state.ganttExpanded[epId]);
        else App.state.ganttExpanded[epId] = !App.state.ganttExpanded[epId];
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
        if (!bar || !row || row.classList.contains('phase')) {
          // open chart or the header inside the measured range → the ruler's menu
          if (self.rulerHit(e) && (e.target.closest('.g-track') || e.target.closest('.th-cols'))) {
            e.preventDefault();
            hideTip();
            self.openRulerMenu(e);
          }
          return;
        }
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

    /* ---- Ruler ----
       Drag along the date header to measure a stretch of the schedule: a
       capped line above the dates with the day count on it, and a band down the
       chart over the same dates. Right-click inside it to select the tasks
       that run in it, or print/export just those dates. Held in App.state for
       the session so a re-render (a filter, a zoom) keeps it — never saved or
       synced; it's a way of looking, not part of the board. A click on the
       header without a drag, or Escape, puts it away. Shift+drag extends the
       one already there from its far end. */
    rulerColAt(clientX) {
      const r = this._rulerCols.getBoundingClientRect();
      const n = Math.round(r.width / this._dw);
      return Math.max(0, Math.min(n - 1, Math.floor((clientX - r.left) / this._dw)));
    },

    // `grip` is 'from' or 'to' when an end's handle was grabbed: that end
    // follows the pointer and the other one is the anchor, like Shift+drag.
    startRuler(e, grip) {
      const cur = App.state.ganttRuler;
      let anchor = this.rulerColAt(e.clientX);
      const extend = !!cur && (e.shiftKey || !!grip);
      if (extend) {
        const colOf = (iso) => Math.round(this._xOf(iso) / this._dw);
        const a = colOf(cur.from), b = colOf(cur.to);
        anchor = grip ? (grip === 'from' ? b : a) : Math.abs(anchor - a) < Math.abs(anchor - b) ? b : a;
      }
      this._drag = { kind: 'ruler', anchor, startClientX: e.clientX, moved: extend };
      if (this._drag.moved) this.onDragMove(e);
      document.body.classList.add('gantt-dragging', 'gantt-ruling');
    },

    // is this event over the measured dates? (Landscape; any row, or the header)
    rulerHit(e) {
      const r = App.state.ganttRuler;
      if (!r || !this._rulerCols || (this._axis && this._axis.portrait)) return false;
      const box = this._rulerCols.getBoundingClientRect();
      const x = e.clientX - box.left;
      return x >= this._xOf(r.from) && x < this._xOf(r.from) + this._xOf.width(r.from, r.to);
    },

    paintRuler() {
      const r = App.state.ganttRuler, head = this._rulerHead, band = this._rulerBand;
      if (!head || !band) return;
      head.style.display = band.style.display = r ? '' : 'none';
      if (!r) return;
      const left = this._xOf(r.from), w = this._xOf.width(r.from, r.to);
      head.style.left = left + 'px'; head.style.width = w + 'px';
      band.style.left = (LABEL_W + left) + 'px'; band.style.width = w + 'px';
      const days = App.diffDays(r.to, r.from) + 1, work = App.visibleDayCount(r.from, r.to, true);
      const lbl = head.querySelector('.ruler-lbl');
      lbl.innerHTML = '';
      lbl.appendChild(el('b', null, days + ' day' + (days === 1 ? '' : 's')));
      // past a month, weeks read easier than a day count — to one decimal unless exact
      if (days > 31) { const wk = Math.round(days / 7 * 10) / 10; lbl.appendChild(el('span', null, wk + ' weeks')); }
      if (work !== days) lbl.appendChild(el('span', null, work + ' working'));
    },

    // Select Tasks / Print-Export Selection — shared by the ruler's own menu
    // and a bar's menu when that bar sits inside the range
    rulerItems(item) {
      const r = App.state.ganttRuler, out = [];
      if (App.canSelectTasks(App.state.role)) out.push(item('Select Tasks', App.fmtRange(r.from, r.to), () => this.selectRulerTasks()));
      out.push(item('Print / Export Selection…', null, () => this.exportRuler()));
      out.push(item('Clear ruler', 'Esc', () => { App.state.ganttRuler = null; this.paintRuler(); }));
      return out;
    },

    openRulerMenu(e) {
      this.closeBarMenu();
      const menu = el('.ctx-menu');
      const item = (label, sub, fn) => el('button.ctx-item', {
        type: 'button',
        onclick: () => { this.closeBarMenu(); fn(); }
      }, [el('span.ctx-item-lbl', null, label), sub ? el('span.ctx-item-sub', null, sub) : null]);
      this.rulerItems(item).forEach(n => menu.appendChild(n));
      this.placeMenu(e, menu);
    },

    /* Every task on the timeline that runs on any of the measured days —
       touched, not enclosed, the same rule as the shift-sweep. Built from the
       data rather than the drawn bars, so a collapsed episode's tasks count;
       those episodes are opened so the selection can be seen. Replaces the
       current selection rather than adding to it. */
    selectRulerTasks() {
      const r = App.state.ganttRuler; if (!r) return;
      const items = [];
      (this._episodes || []).forEach(ep => App.subsView(ep).forEach(su => {
        if (su.start <= r.to && su.due >= r.from) items.push({ ep, su });
      }));
      if (!items.length) { App.toast('No tasks run ' + App.fmtRange(r.from, r.to), true); return; }
      selClear();
      items.forEach(({ ep, su }) => { selAdd(ep.id, su.key); App.state.ganttExpanded[ep.id] = true; });
      App.render();
      const eps = new Set(items.map(x => x.ep.id)).size;
      App.toast(items.length + ' task' + (items.length === 1 ? '' : 's') + ' selected across ' +
        eps + ' episode' + (eps === 1 ? '' : 's') + ' · ' + App.fmtRange(r.from, r.to));
    },

    // the production breakdown — App.exporter.context() gives it the ruler's
    // dates as its range, the same as the Export button and ⌘P do
    exportRuler() {
      if (App.state.ganttRuler) App.exporter.open();
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
      {
        const ep = App.state.data.episodes.find(x => x.id === epId);
        if (ep && this.clashes(ep.showId)[epId + '::' + suKey] && App.canManageShows(App.state.role)) {
          menu.appendChild(item('Resolve holiday clash…', null, () => App.holidayClashDialog.open(ep.showId, { onlyKey: epId + '::' + suKey })));
        }
      }
      if (sel.length) {
        menu.appendChild(item('Clear selection', 'Esc', () => { selClear(); App.render(); }));
      }
      // a bar inside the measured range still offers what the range can do
      if (this.rulerHit(e)) { menu.appendChild(el('.ctx-sep')); this.rulerItems(item).forEach(n => menu.appendChild(n)); }

      this.placeMenu(e, menu);
    },

    // pin a context menu at the cursor; closed by any press outside it
    placeMenu(e, menu) {
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
    // edge fixed). Both are clamped live to the task's minDays. A drop goes
    // into the unsaved draft (App.timelineDraft.stage); dependencies and the
    // delivery/live dates are checked when the draft is saved.
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
        /* A planned version (V2, V3…): only its end moves — it always starts
           the day after the version before it — so the whole bar drags its end. */
        const revEl = e.target.closest('.rev-plan.adjustable');
        if (revEl) {
          revEl.style.cursor = (this._axis && this._axis.portrait) ? 'ns-resize' : 'ew-resize';
          return;
        }
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
        // ruler — a press on the date header measures a range (see paintRuler)
        const rulerCols = e.button === 0 && !(this._axis && this._axis.portrait) && e.target.closest('.time-head .th-cols');
        if (rulerCols) {
          e.preventDefault();
          hideTip();
          const grip = e.target.closest('.ruler-grip');
          this.startRuler(e, grip && grip.dataset.end);
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

        // a planned version: drag its end to change how many days it runs
        const revEl = e.target.closest('.rev-plan.adjustable');
        if (revEl && !e.shiftKey && App.canEditSchedule(App.state.role)) {
          const ep = App.state.data.episodes.find(x => x.id === revEl.dataset.episodeId);
          const su = ep && App.subitem(ep, revEl.dataset.suKey);
          const rv = su && App.plannedRevisions(ep, su).revs.find(x => String(x.idx) === revEl.dataset.rev);
          if (!rv) return;
          e.preventDefault();
          hideTip();
          this._drag = {
            kind: 'rev', el: revEl, epId: ep.id, suKey: su.key, r: rv.idx, label: rv.label,
            cal: App.showCalendar(ep.showId), who: { dept: su.dept, person: su.assignee },
            startClientX: e.clientX, startClientY: e.clientY, startedAt: Date.now(), moved: false,
            origStart: rv.start, origDue: rv.due, curDue: rv.due
          };
          revEl.classList.add('dragging');
          document.body.classList.add('gantt-dragging');
          document.body.style.cursor = (this._axis && this._axis.portrait) ? 'ns-resize' : 'ew-resize';
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

        /* Opt+Shift on a row label → every task that row stands for. */
        if (e.shiftKey && e.altKey && !bar && e.target.closest('.g-label')) {
          const lrow = e.target.closest('.g-row');
          if (lrow && lrow._selItems && lrow._selItems.length && App.canSelectTasks(App.state.role)) {
            e.preventDefault();
            hideTip();
            const adding = selAll(lrow._selItems);
            this.suppressNextClick();                // the click after isn't "expand this row"
            App.render();
            App.toast((adding ? 'Selected ' : 'Dropped ') + lrow._selItems.length + ' task' +
              (lrow._selItems.length === 1 ? '' : 's') + ' · ' + selList().length + ' selected');
            return;
          }
        }

        /* Shift on empty grid → marquee. (Shift on a bar sweeps too, once it
           moves — see below — so a band can start anywhere on the chart.) */
        if (e.shiftKey && !bar) {
          const track = e.target.closest('.g-row.sub .g-track');
          if (track && App.canSelectTasks(App.state.role)) {
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
        if (!su) return;

        /* Shift on a bar → toggle it in the selection, and nothing else. No
           move starts and no dialog opens: the whole point of holding shift is
           that this press is about choosing, not about moving or inspecting.
           Dragging from it sweeps a box, the same as from open grid; the
           toggle happens on release if the press never moved (see onDragEnd). */
        if (e.shiftKey) {
          if (!App.canSelectTasks(App.state.role)) return;
          e.preventDefault();
          hideTip();
          /* Opt+Shift → this task on every episode the timeline is showing,
             open or collapsed; the filters narrow what "all" reaches. */
          if (e.altKey) {
            selAll((this._episodes || []).map(x => {
              const s = App.subsView(x).find(t => t.key === suKey);
              return s ? { ep: x, su: s } : null;
            }).filter(Boolean));
            this.suppressNextClick();
            App.render();
            return;
          }
          this.startMarquee(e, { epId, suKey });
          return;
        }

        if (!App.canEditSchedule(App.state.role)) return;   // a plain click still opens the dialog, which explains the lock
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
        document.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape' || !App.state.ganttRuler || (App.modal && App.modal._ov)) return;
          if (this._barMenu) return;                 // the first Escape closes the menu
          App.state.ganttRuler = null;
          this.paintRuler();
        });
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
    // `toggle` — the bar the press started on, picked or dropped if it never moves
    startMarquee(e, toggle) {
      const ghost = el('.g-marquee', {
        style: { left: e.clientX + 'px', top: e.clientY + 'px', width: '0px', height: '0px' }
      });
      document.body.appendChild(ghost);
      this._drag = {
        kind: 'marquee', ghost,
        startClientX: e.clientX, startClientY: e.clientY, startedAt: Date.now(), moved: false,
        // shift is held, so this extends whatever was already picked — unless
        // the press started on a bar that's already picked: then the band takes
        // what it touches back out (the Board's Shift+drag works the same way)
        additive: true, toggle: toggle || null,
        removing: !!(toggle && selHas(toggle.epId, toggle.suKey))
      };
      if (this._drag.removing) ghost.classList.add('removing');
      document.body.classList.add('gantt-dragging');
    },

    onDragMove(e) {
      const d = this._drag; if (!d) return;
      const dw = this._dw, hw = this._hideWeekends, xOf = this._xOf;
      // notes are Landscape-only regardless of the current axis (Producer Notes
      // hidden entirely in Portrait — see render()), so their delta always
      // reads clientX. Only the bar-drag branch below ever reads clientY.
      const colDeltaX = Math.round((e.clientX - d.startClientX) / dw);

      if (d.kind === 'ruler') {
        if (Math.abs(e.clientX - d.startClientX) > DRAG_SLOP) d.moved = true;
        if (!d.moved) return;
        const c = this.rulerColAt(e.clientX);
        const a = Math.min(d.anchor, c), b = Math.max(d.anchor, c);
        App.state.ganttRuler = {
          from: App.addVisibleDays(this._startIso, a, hw),
          to: App.addVisibleDays(this._startIso, b, hw)
        };
        this.paintRuler();
        return;
      }

      if (d.kind === 'note-draw') {
        // notes are Landscape-only, so the drawn range always reads clientX
        const drawDelta = e.clientX - d.startClientX;
        const cur = d.startCol + Math.round(drawDelta / dw);
        const a = Math.max(0, Math.min(d.startCol, cur)), b = Math.max(0, Math.max(d.startCol, cur));
        d.curA = a; d.curB = b;
        if (Math.abs(drawDelta) > 4) d.moved = true;
        d.ghost.style.left = (a * dw) + 'px';
        d.ghost.style.width = ((b - a + 1) * dw) + 'px';
        const sIso = App.addVisibleDays(this._startIso, a, hw), dIso = App.addVisibleDays(this._startIso, b, hw);
        const dotColor = '#5b6cff';
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
            placePauses(m.el, portraitG);
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

      const portrait = !!(this._axis && this._axis.portrait);
      if (d.kind === 'rev') {
        const mainDelta = portrait ? (e.clientY - d.startClientY) : (e.clientX - d.startClientX);
        if (Math.abs(mainDelta) > DRAG_SLOP) d.moved = true;
        let nd = App.addVisibleDays(d.origDue, Math.round(mainDelta / dw), hw);
        if (nd < d.origStart) nd = d.origStart;
        d.curDue = nd;
        if (portrait) d.el.style.height = xOf.width(d.origStart, nd) + 'px';
        else d.el.style.width = xOf.width(d.origStart, nd) + 'px';
        d.days = this.versionDays(d, nd);
        const tip = dragTipEl(); tip.innerHTML = '';
        tip.appendChild(el('span.tip-dot', { style: { background: '#5fb0f0' } }));
        tip.appendChild(document.createTextNode(d.label + ' · ' + d.days + ' day' + (d.days === 1 ? '' : 's') + ' · ' + App.fmtRange(d.origStart, nd)));
        tip.style.display = 'flex'; tip.style.left = e.clientX + 'px'; tip.style.top = (e.clientY - 38) + 'px';
        return;
      }

      // the only branch that can be Portrait — notes (handled above) never
      // render there, so this is where clientY actually gets read
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
      placePauses(d.bar, portrait);

      // no flags mid-adjustment — what the change sets off shows in the
      // unsaved-changes bar once it's dropped (js/draft.js)
      const tip = dragTipEl(); tip.innerHTML = '';
      tip.appendChild(el('span.tip-dot', { style: { background: '#5fb0f0' } }));
      tip.appendChild(document.createTextNode(App.fmtRange(newStart, newDue)));
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

      if (d.kind === 'ruler') {
        document.body.classList.remove('gantt-ruling');
        this.suppressNextClick();
        // a click without a drag puts the ruler away
        if (!d.moved) { App.state.ganttRuler = null; this.paintRuler(); }
        return;
      }

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

      if (d.kind === 'marquee') {
        // read the band before removing it, then hit-test the bars against it
        const box = d.ghost.getBoundingClientRect();
        d.ghost.remove();
        this.suppressNextClick();
        if (!d.moved) {                              // a shift-click: a bar toggles, open grid does nothing
          if (d.toggle) { selToggle(d.toggle.epId, d.toggle.suKey); App.render(); }
          return;
        }
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
          if (d.removing) { if (selHas(epId, suKey)) { selToggle(epId, suKey); added++; } return; }
          if (!selHas(epId, suKey)) added++;
          selAdd(epId, suKey);
        });
        App.render();
        const total = selList().length;
        if (d.removing) { App.toast(added + ' task' + (added === 1 ? '' : 's') + ' dropped · ' + total + ' selected'); return; }
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
        App.timelineDraft.stage(changed.map(m => ({ epId: m.epId, suKey: m.suKey, start: m.curStart, due: m.curDue })));
        return;
      }

      // was this a gesture rather than a click? (see DRAG_SLOP / HOLD_MS)
      const held = d.startedAt ? (Date.now() - d.startedAt) >= HOLD_MS : false;
      const wasGesture = !!d.moved || held;
      if (wasGesture) this.suppressNextClick();

      if (d.kind === 'rev') {
        d.el.classList.remove('dragging');
        if (d.curDue !== d.origDue) App.setVersionDays(d.epId, d.suKey, d.r, d.days);
        else App.render();
        return;
      }

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
        App.timelineDraft.stage([{ epId: d.epId, suKey: d.suKey, start: d.curStart, due: d.curDue }]);
      }
    },

    /* How long a version dragged to end on `due` runs: its people's working
       days when the show keeps a calendar (what App.revisionSteps counts),
       otherwise every day of the span. */
    versionDays(d, due) {
      let n = 0, x = d.origStart, g = 0;
      while (x <= due && g++ < 2000) { if (!d.cal || !d.cal.isOff(x, d.who)) n++; x = App.shiftIso(x, 1); }
      return Math.max(1, n);
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
      this._viewW = s.clientWidth; this._viewH = s.clientHeight;    // for re-anchoring (render)
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
      }, App.timelineMode() === 'resources' ? 'DEPARTMENT / PERSON'
        : { show: 'SHOW / TASK', department: 'DEPARTMENT / TASK' }[App.timelineGrouping()] || 'EPISODE / SUBITEM'));
      const cols = el('.th-cols', { title: 'Drag along the dates to measure a range', style: { width: (ctx.totalCols * ctx.dw) + 'px' } });
      // the ruler's header half, on a strip of its own above the dates — a
      // capped line over the measured range with the day count sitting on it.
      // The strip is always there so the header never changes height mid-drag.
      // a grip at each end: drag one to move that edge, the other stays put
      this._rulerHead = el('.ruler-head', null, [el('.ruler-line'), el('.ruler-lbl'),
        el('.ruler-grip', { 'data-end': 'from', title: 'Drag to move this end' }),
        el('.ruler-grip', { 'data-end': 'to', title: 'Drag to move this end' })]);
      cols.appendChild(el('.ruler-strip', null, this._rulerHead));
      cols.appendChild(buildSegRow(ctx, tier.primary, 'primary'));
      cols.appendChild(buildSegRow(ctx, tier.secondary, 'secondary'));
      this._rulerCols = cols;
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

    /* ---- Executive view (All shows) ----
       The whole slate at a glance, for people who need the shape and not the
       tasks: each show is a header row, each episode one line of thin
       department bands — when each department is on it — with its Delivery
       and Live dates marked. Detail is opened a level at a time: click a show
       to fold its episodes away (leaving one start-to-end bar)
       or bring them back; click an episode to open its tasks beneath it, as
       the Episode sort shows them. ↗ on a show opens its full timeline.
       Whole-production holidays still show. */
    execRows(body, episodes, xOf, dw, axis) {
      const byShow = {}, order = [];
      episodes.forEach(ep => {
        if (!byShow[ep.showId]) { byShow[ep.showId] = []; order.push(ep.showId); }
        byShow[ep.showId].push(ep);
      });
      const depts = Object.keys(App.DEPARTMENTS);
      // the key: which colour is which department, and what D / LD mean
      const key = el('.g-row.exec-key');
      key.appendChild(el('.g-label', null, el('.l-title', null, 'All shows · overview')));
      key.appendChild(el('.exec-key-items', null, depts.map(dk => el('span.exec-key-item', null, [
        el('span.exec-key-sw', { style: { background: App.dept(dk).color } }), App.dept(dk).label
      ])).concat([
        el('span.exec-key-item', null, [el('span.exec-key-ms.del', null, 'D'), 'Delivery']),
        el('span.exec-key-item', null, [el('span.exec-key-ms.live', null, 'LD'), 'Live']),
        el('span.exec-key-hint', null, 'Click a show or episode for more or less detail · ↗ opens a show’s full timeline')
      ])));
      body.appendChild(key);
      const collapsed = App.state.execCollapsed = App.state.execCollapsed || {};
      // department bands for a set of episodes, one thin line per department
      const bands = (track, eps) => {
        const subs = [].concat(...eps.map(e => App.subitems(e)));
        const present = depts.filter(dk => subs.some(su => su.dept === dk));
        present.forEach((dk, i) => {
          const mine = subs.filter(su => su.dept === dk);
          const a = mine.reduce((m, su) => su.start < m ? su.start : m, mine[0].start);
          const b = mine.reduce((m, su) => su.due > m ? su.due : m, mine[0].due);
          const done = mine.filter(su => su.status === 'approved').length;
          const style = {}; setBarPos(style, axis, xOf, a, b);
          style.top = (5 + i * 6) + 'px';
          style.background = App.dept(dk).color;
          track.appendChild(el('.exec-band' + (done === mine.length ? '.done' : ''), {
            style, title: App.dept(dk).label + ' · ' + App.fmtRange(a, b) + ' · ' + done + ' of ' + mine.length + ' done'
          }));
        });
        return present.length;
      };
      // a click on a Delivery/Live mark is that mark's own (it opens its date)
      const toggleOn = (row, fn) => row.addEventListener('click', (e) => {
        if (e.target.closest('.ms-day, .exec-open')) return;
        if (this._clickSuppressed) { e.stopPropagation(); return; }   // an Opt+Shift pick just ended here
        e.stopPropagation(); fn(e); App.render();
      });
      order.forEach(showId => {
        const show = App.show(showId); if (!show) return;
        const eps = byShow[showId];
        const open = !collapsed[showId];
        const s0 = eps.reduce((m, e) => { const x = App.epStart(e); return x < m ? x : m; }, '9999-99-99');
        const f0 = eps.reduce((m, e) => { const x = App.epFinal(e); return x > m ? x : m; }, '0000-00-00');
        const delivered = eps.filter(App.isDelivered).length;

        // show header — click to fold its episodes away or bring them back
        const head = el('.g-row.exec-show' + (open ? '' : '.folded'));
        head.appendChild(el('.g-label.exec-show-label', { title: (open ? 'Collapse ' : 'Expand ') + show.name }, [
          el('.l-title', null, [
            el('span.chev' + (open ? '.open' : ''), null, '▶'),
            el('span.exec-chip', { style: { background: show.color, color: App.pickInkFor(show.color) } }, show.prefix || ''),
            el('span.exec-show-name', null, show.name),
            el('button.exec-open', {
              type: 'button', title: 'Open ' + show.name + '’s full timeline',
              onclick: (e) => { e.stopPropagation(); App.state.filters.show = [showId]; App.render(); }
            }, '↗')
          ]),
          el('.l-sub', null, eps.length + ' episode' + (eps.length === 1 ? '' : 's') + ' · ' + delivered + ' delivered · ends ' + App.fmtDate(f0))
        ]));
        const ht = el('.g-track');
        this.holWash(ht, [showId], null, xOf, axis);
        // the show's span, start to end — folded it's the whole story, so it's
        // drawn solid, with the show's final Delivery and Live dates on it
        const st = {}; setBarPos(st, axis, xOf, s0, f0);
        st.background = show.color;
        ht.appendChild(el('.exec-span' + (open ? '' : '.solid'), {
          style: st, title: show.name + ' · ' + App.fmtRange(s0, f0) + ' · ' + eps.length + ' episode' + (eps.length === 1 ? '' : 's')
        }));
        if (!open) {
          const lastEp = eps.reduce((m, e) => App.epFinal(e) > App.epFinal(m) ? e : m, eps[0]);
          this.milestoneMarks(ht, lastEp, xOf, dw, axis);
        }
        head.appendChild(ht);
        selRow(head, [].concat(...eps.map(epItems)));
        // Opt+click folds or opens every show at once
        toggleOn(head, (e) => { (e.altKey ? order : [showId]).forEach(id => { collapsed[id] = open; }); });
        body.appendChild(head);
        if (!open) return;

        eps.forEach(ep => {
          const epOpen = !!App.state.ganttExpanded[ep.id];
          const row = el('.g-row.exec-row' + (epOpen ? '.open' : ''));
          row.appendChild(el('.g-label', { title: (epOpen ? 'Hide ' : 'Show ') + ep.title + '’s tasks' }, [
            el('.l-title', null, [el('span.chev' + (epOpen ? '.open' : ''), null, '▶'), el('span', null, ep.title)]),
            el('.l-sub', null, el('span.code', null, ep.code))
          ]));
          const track = el('.g-track');
          this.holWash(track, [showId], null, xOf, axis);
          const n = bands(track, [ep]);          // one thin band per department
          row.style.minHeight = Math.max(34, 10 + n * 6) + 'px';
          this.milestoneMarks(track, ep, xOf, dw, axis);
          row.appendChild(track);
          selRow(row, epItems(ep));
          toggleOn(row, (e) => {
            if (e.altKey) this.expandAllLike(ep.id, !epOpen);
            else App.state.ganttExpanded[ep.id] = !epOpen;
          });
          body.appendChild(row);
          // opened: the episode's tasks, exactly as the Episode sort draws them
          if (epOpen) {
            const { order: dOrder, byDept } = this.groupByDept([ep]);
            dOrder.forEach(dk => this.deptStackedLines(body, App.dept(dk), this.groupItems(byDept[dk]), xOf, dw, null, axis));
          }
        });
      });
    },

    // Shared episode summary row (the collapsed/top line for both the
    // Department and Episode sorts). Returns the .g-row element.
    epTopRow(ep, xOf, dw, axis) {
      const show = App.show(ep.showId);
      const expanded = !!App.state.ganttExpanded[ep.id];
      const prog = App.progressPct(ep);
      const blocked = App.epBlockedCount(ep), overdue = App.epOverdueCount(ep);
      const portrait = !!(axis && axis.portrait);
      const spine = portrait && expanded;

      const row = selRow(el('.g-row' + (spine ? '.spine' : '')), epItems(ep));
      row.dataset.episodeId = ep.id;
      const labelTip = ep.code + ' · ' + ep.title + ' · ' + App.fmtRange(App.epStart(ep), App.epDue(ep)) +
                       (overdue ? ' · ' + overdue + ' overdue' : '');
      row.appendChild(el('.g-label', { title: portrait ? labelTip : null }, spine ? [
        el('.l-title', null, [el('span.chev.open', null, '▶')])
      ] : [
        el('.l-title', null, [
          el('span.chev' + (expanded ? '.open' : ''), null, '▶'),
          el('span', null, ep.title)
        ]),
        // Portrait's label band is ~96px wide against Landscape's 220px, so
        // the sub-line keeps only the episode code — the date range and the
        // overdue count move into the tooltip rather than being ellipsised
        // into unreadable fragments.
        el('.l-sub', null, portrait ? [
          el('span.code', null, ep.code),
          (overdue ? el('span', { style: { color: '#ff8a95', fontWeight: '700' } }, '· ' + overdue) : null)
        ] : [
          el('span.code', null, ep.code),
          el('span', null, '· ' + App.fmtRange(App.epStart(ep), App.epDue(ep))),
          (overdue ? el('span', { style: { color: '#ff8a95', fontWeight: '700' } }, ['· ', App.icon('warn'), ' ' + overdue]) : null)
        ])
      ]));

      const track = el('.g-track');
      const s = App.epStart(ep), d = App.epDue(ep);
      const delivered = App.isDelivered(ep);
      const barStyle = { background: barGradient(show.color, axis), color: pickInk(show.color) };
      setBarPos(barStyle, axis, xOf, s, d);
      const bar = el('.bar' + (delivered ? '.delivered' : ''), {
        title: ep.code + ' · ' + ep.title + ' — ' + prog + '% · ' + App.epStatusLabel(ep),
        style: barStyle
      }, spine ? [] : [
        el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, ep.title),
        (blocked ? App.icon('blocked', { cls: 'blk', title: blocked + ' blocked' }) : null)
      ]);
      if (!spine && !delivered && prog > 0) bar.appendChild(progressFill(prog, axis));
      attachBar(bar, epBarStatus(ep), !spine);
      track.appendChild(bar);
      // milestones sit past the end of the work, so an expanded episode's
      // spine still draws them — they're the only thing marking where the
      // delivery and live dates fall once the summary bar is a hairline.
      this.milestoneMarks(track, ep, xOf, dw, axis);
      this.holWash(track, [ep.showId], null, xOf, axis);
      row.appendChild(track);
      return row;
    },

    /* Delivery Date and Live Date, past the end of the episode's work. Each
       occupies its single day on the grid — a red D and a blue LD — so they read
       as dated events on the calendar rather than annotations floating beside
       the bar. They are not tasks and are never draggable: a date owed to
       someone outside the studio shouldn't be a thing you can nudge with the
       mouse. Clicking one opens its panel, which is where the date is changed. */
    milestoneMarks(track, ep, xOf, dw, axis) {
      if (isCoarse(dw)) return;                  // a one-day mark says nothing at this scale
      App.epMilestones(ep).forEach(m => {
        const late = m.slipDays > 0;
        const msStyle = {};
        setBarPos(msStyle, axis, xOf, m.date, m.date);
        const mark = el('.ms-day.clickable.ms-' + m.key + (m.fixed ? '.fixed' : '') + (late ? '.late' : ''), {
          style: msStyle,
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
      const clash = this.clashes(ep.showId)[ep.id + '::' + su.key];
      const sbar = el('.bar' + (done ? '.delivered' : '') + (ring ? '.st-ring' : '') + (bare ? '.bare' : '') +
                      (selHas(ep.id, su.key) ? '.selected' : '') + (clash ? '.hol-clash' : ''), {
        title: (labelText ? labelText + ' — ' : '') + su.name + ' — ' + st.label + ' · ' + App.fmtRange(su.start, su.due) +
               (clash ? '\n⚠ Runs into ' + clash.reason + ' — right-click to reassign or shift' : ''),
        style
      }, bare ? null : [
        el('span.bar-label', { style: { overflow: 'hidden', textOverflow: 'ellipsis' }, 'data-abbr': labelText ? null : abbreviate(su.name) || null }, labelText || su.name),
        (App.isRiskBlocked(ep, su.key) ? App.icon('blocked', { cls: 'blk', title: 'In progress while a dependency is unapproved' }) : null)
      ]);
      sbar.dataset.episodeId = ep.id;
      sbar.dataset.suKey = su.key;
      track.appendChild(sbar);

      /* A task that runs across time off — typically one stretched by a
         holiday split — shows the time off inside its bar: greyed, with a
         line at each end, so it reads as work paused rather than one long
         run. Positioned relative to the bar, so it moves with it. */
      if (!bare) {
        const p0 = axis && axis.portrait ? 'top' : 'left', sz = axis && axis.portrait ? 'height' : 'width';
        const at0 = xOf(su.start);
        this.holSpans(ep.showId, su.dept).forEach(sp => {
          const a = sp.start < su.start ? su.start : sp.start, b = sp.end > su.due ? su.due : sp.end;
          if (a > b || (a === su.start && b === su.due)) return;   // outside it, or the whole bar
          const pause = el('.bar-hol');
          // where the time off sits on the track, so a drag can keep it there
          pause.dataset.at = xOf(a); pause.dataset.len = xOf.width(a, b);
          pause.style[p0] = (xOf(a) - at0) + 'px';
          pause.style[sz] = xOf.width(a, b) + 'px';
          sbar.appendChild(pause);
        });
      }
      attachBar(sbar, { color: st.color, label: st.label }, false);

      /* Revisions still ahead of an open task: the time the schedule holds in
         reserve in case it's sent back, drawn as striped V2, V3… bars after
         it (the gaps between are the Director's review days). Not part of `su.due`; the first one becomes
         real when a revision is actually requested. */
      App.plannedRevisions(ep, su).revs.forEach(rv => {
        const rStyle = {};
        setBarPos(rStyle, axis, xOf, rv.start, rv.due);
        const canAdjust = App.canEditSchedule(App.state.role);
        const rbar = el('.rev-plan' + (bare ? '.bare' : '') + (canAdjust ? '.adjustable' : ''), {
          title: su.name + ' ' + rv.label + ' — planned revision, ' + App.fmtRange(rv.start, rv.due) + ' · only used if it’s sent back' +
                 (canAdjust ? '\nDrag its end to change how long it runs' : ''),
          style: rStyle
        }, bare ? null : el('span', null, rv.label));
        rbar.style.setProperty('--rp-c', bg);
        rbar.dataset.episodeId = ep.id;
        rbar.dataset.suKey = su.key;
        rbar.dataset.rev = rv.idx;
        track.appendChild(rbar);
      });

      /* Unused revision budget, left visible rather than forgotten: a task
         approved without spending every revision it was allowed banked real
         slack, and this is where that shows up — a grey tail right after the
         bar, sized to the days it never needed. Cosmetic only: it's not part
         of `su.due` or the schedule, so drawing or dismissing it never moves
         anything else. Skipped at coarse zoom for the same reason the
         milestone marks are — a sliver of grey says nothing at that scale. */
      if (!bare) {
        const ghostDays = App.revisionGhostDays(ep, su);
        if (ghostDays > 0) {
          const gStart = App.shiftIso(su.due, 1), gEnd = App.shiftIso(su.due, ghostDays);
          const gStyle = {};
          setBarPos(gStyle, axis, xOf, gStart, gEnd);
          const ghost = el('.rev-ghost', {
            title: ghostDays + ' unused revision day' + (ghostDays === 1 ? '' : 's') + ' — approved without needing ' +
                   'every revision it was budgeted',
            style: gStyle
          }, el('span.rev-ghost-x', { title: 'Remove from the timeline' }, '✕'));
          ghost.dataset.episodeId = ep.id;
          ghost.dataset.suKey = su.key;
          track.appendChild(ghost);
        }
      }
      return sbar;
    },

    /* Holidays on the timeline, in red. A whole-production day off — a
       national holiday or production time off — is painted through every row
       of the show; a department's own time off only through that
       department's rows. Weekends aren't painted: they're either hidden
       columns or simply not working days. Spans are worked out once per
       show/department per render. */
    holSpans(showId, dept) {
      const key = showId + '|' + (dept || '');
      if (this._holCache && this._holCache[key]) return this._holCache[key];
      const show = App.show(showId);
      const cal = show && App.showCalendar(show);
      const out = [];
      if (cal && this._vis) {
        const roleKey = dept && dept.indexOf('role:') === 0 ? dept.slice(5) : dept;
        let cur = null;
        for (let x = this._vis.start; x <= this._vis.end; x = App.shiftIso(x, 1)) {
          let hit = null;
          if (!cal.weekend(x)) {
            const nat = cal.national(x);
            const prod = cal.cal.offDays.find(o => o.scope === 'show' && x >= o.start && x <= o.end);
            // the label is what hovering the red shows: what the day is, and who's off
            if (nat) hit = { prod: true, label: nat + ' — national holiday, whole production off' };
            else if (prod) hit = { prod: true, label: (prod.label || 'Time off') + ' — whole production off' };
            else if (dept) {
              const o = cal.cal.offDays.find(o2 => x >= o2.start && x <= o2.end &&
                ((o2.scope === 'dept' && o2.target === dept) || (o2.scope === 'role' && o2.target === roleKey)));
              if (o) hit = { prod: false, label: (o.label || 'Time off') + ' — ' +
                (o.scope === 'role' ? App.role(o.target).label : App.dept(o.target).label) + ' off' };
            }
          }
          if (hit && cur && cur.prod === hit.prod && cur.label === hit.label && App.shiftIso(cur.end, 1) === x) cur.end = x;
          else if (hit) { cur = Object.assign({ start: x, end: x }, hit); out.push(cur); }
          else cur = null;
        }
      }
      if (this._holCache) this._holCache[key] = out;
      return out;
    },
    // this show's holiday clashes, keyed "epId::taskKey" — once per render
    clashes(showId) {
      const key = 'clash|' + showId;
      if (this._holCache && this._holCache[key]) return this._holCache[key];
      const map = {};
      App.holidayClashes(showId).forEach(c => { map[c.ep.id + '::' + c.su.key] = c; });
      if (this._holCache) this._holCache[key] = map;
      return map;
    },
    holWash(track, showIds, dept, xOf, axis) {
      showIds.forEach(id => this.holSpans(id, dept).forEach(sp => {
        const style = {};
        setBarPos(style, axis, xOf, sp.start, sp.end);
        // first in the track, so every bar stacks above it
        track.insertBefore(el('.hol-wash' + (sp.prod ? '.prod' : ''), {
          style, title: sp.label + ' · ' + (sp.start === sp.end ? App.fmtDate(sp.start) : App.fmtRange(sp.start, sp.end))
        }), track.firstChild);
      }));
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

    // The span itself — where a department's work starts and ends. `cls`
    // '.phase-line' draws it as a hairline along the top of a task row.
    phaseBar(dep, items, xOf, note, axis, cls) {
      const gStart = items.reduce((m, x) => x.su.start < m ? x.su.start : m, items[0].su.start);
      const gDue = items.reduce((m, x) => x.su.due > m ? x.su.due : m, items[0].su.due);
      const [r, g, b] = hexToRgb(dep.color);
      const pStyle = {
        background: 'rgba(' + r + ',' + g + ',' + b + (cls ? ',.7)' : ',.15)'),
        borderColor: 'rgba(' + r + ',' + g + ',' + b + ',.55)'
      };
      setBarPos(pStyle, axis, xOf, gStart, gDue);
      return el('.phase-bar' + (cls || ''), {
        title: dep.label + ' — ' + App.fmtRange(gStart, gDue) + (note ? ' · ' + note : ''),
        style: pStyle
      });
    },

    // Faint span header row marking where a department's work starts and ends.
    phaseRow(body, dep, items, xOf, note, axis) {
      const portrait = !!(axis && axis.portrait);
      const hrow = selRow(el('.g-row.sub.phase', { style: { background: this.deptWash(dep) } }), items);
      // Portrait gives the phase span a spine's width, so its name would clip
      // to a letter or two — the dot alone carries the department there, with
      // the name in the tooltip the label already has.
      hrow.appendChild(el('.g-label', { title: dep.label + ' phase', style: { background: deptLabelBg(dep.color) } }, [
        el('.l-title', { style: { fontWeight: '700', fontSize: '10.5px' } }, portrait ? [
          this.deptDot(dep)
        ] : [
          this.deptDot(dep),
          el('span', null, dep.label)
        ])
      ]));
      const ht = el('.g-track');
      this.holWash(ht, [...new Set(items.map(x => x.ep.showId))], items[0].su.dept, xOf, axis);
      ht.appendChild(this.phaseBar(dep, items, xOf, note, axis));
      hrow.appendChild(ht);
      body.appendChild(hrow);
    },

    // One task on the Y axis, its episodes on the board: each {ep, su} drawn
    // as an episode-coded bar in its show's colour — a line here mixes shows,
    // and the department is already named on the axis. Bars spill onto
    // continuation rows whenever two would overlap in time.
    // `deep` is set only when this is called under the Show sort's nested
    // Department row (see showDeptRows) — one more level than the Department
    // sort's own use of this method, so the task rows need to sit one step
    // further indented to keep Show → Department → Task legible as a chain.
    epTaskLines(body, dep, title, items, xOf, dw, axis, deep) {
      const sorted = items.slice().sort((a, b) => a.su.start < b.su.start ? -1 : 1);
      const levels = [];
      sorted.forEach(it => {
        const end = App.plannedRevisions(it.ep, it.su).end;
        const lvl = levels.find(l => it.su.start > l.lastDue);
        if (lvl) { lvl.lastDue = end; lvl.items.push(it); }
        else levels.push({ lastDue: end, items: [it] });
      });

      const wash = this.deptWash(dep);
      levels.forEach((lvl, li) => {
        const srow = selRow(el('.g-row.sub' + (deep ? '.sub-deep' : ''), { style: { background: wash } }), items);
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
        this.holWash(st, [...new Set(lvl.items.map(it => it.ep.showId))], lvl.items[0].su.dept, xOf, axis);
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
    deptStackedLines(body, dep, items, xOf, dw, barLabel, axis) {
      const sorted = items.slice().sort((a, b) => a.su.start < b.su.start ? -1 : 1);
      if (!sorted.length) return;
      const multi = sorted.length > 1;

      // phase span — only worth it for a multi-task department. Landscape
      // draws it as a hairline over the first task line rather than a row of
      // its own; Portrait keeps its own column, where there's no room above.
      const portrait = !!(axis && axis.portrait);
      if (multi && portrait) this.phaseRow(body, dep, sorted, xOf, sorted.length + ' tasks', axis);

      // interval-stack: a task shares a line unless it overlaps the last one
      // (planned revisions included, so a V2 never lands on the next task)
      const levels = [];
      sorted.forEach(it => {
        const end = App.plannedRevisions(it.ep, it.su).end;
        const lvl = levels.find(l => it.su.start > l.lastDue);
        if (lvl) { lvl.lastDue = end; lvl.items.push(it); }
        else levels.push({ lastDue: end, items: [it] });
      });

      const wash = this.deptWash(dep);
      levels.forEach((lvl, li) => {
        const srow = selRow(el('.g-row.sub', { style: { background: wash } }), sorted);
        srow.appendChild(el('.g-label', { title: dep.label, style: { background: deptLabelBg(dep.color) } },
          el('.l-title', { style: { fontWeight: '600', fontSize: '10.5px' } },
            multi && (portrait || li > 0)
              ? []                       // the phase header / first line already names it
              : [this.deptDot(dep),
                 el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, dep.label)]
          )
        ));
        const st = el('.g-track');
        this.holWash(st, [...new Set(lvl.items.map(it => it.ep.showId))], dep.key || lvl.items[0].su.dept, xOf, axis);
        // identity lives on each bar, not the row: one line can hold many episodes
        lvl.items.forEach(it => this.taskBar(st, it.ep, it.su, dep, xOf, dw, barLabel && barLabel(it), null, axis));
        if (multi && !portrait && li === 0) {
          // a long gap between tasks breaks the line, so idle stretches don't read as work
          const runs = [];
          sorted.forEach(it => {
            const end = App.plannedRevisions(it.ep, it.su).end;
            const run = runs[runs.length - 1];
            if (run && App.diffDays(it.su.start, run.end) <= PHASE_GAP_DAYS) { run.items.push(it); if (end > run.end) run.end = end; }
            else runs.push({ end, items: [it] });
          });
          runs.forEach(run => st.appendChild(this.phaseBar(dep, run.items, xOf,
            run.items.length + (run.items.length === 1 ? ' task' : ' tasks'), axis, '.phase-line')));
        }
        srow.appendChild(st);
        body.appendChild(srow);
      });
    },

    // "Department" sort: one top row per department, spanning every episode in
    // view; expand → one line per task in that department, each line holding a
    // bar per episode running it.
    /* ---- Resources mode ----
       One row per department, expanding (the shared .g-label click, keyed
       'res:<dept>') into one row per person. Each cell along the axis gets a
       circle: the faint ring is capacity, the filled disc grows with load
       (by area, so twice the load reads as twice the ink), and fills the ring
       at capacity — over it, it turns red. The number is how many open tasks
       touch the cell; hovering lists them. Load is App.resourceLoad, so a
       cell's booked days are days with any task (side-by-side tasks share
       the day), plus planned allocations, against capacity after time off.
       Whose rows show is the role's Resource Visibility (Access Control).

       What a cell is follows the zoom, so a circle always has room to read:
       a DAY near full zoom, a WEEK through the middle, and a MONTH once a
       week is too narrow for a circle. Weekends never carry capacity, so with
       Hide weekends off their day columns stay empty. */
    resourceRows(body, ctx) {
      const people = App.resources.peopleInScope();
      if (!people.length) {
        body.appendChild(el('.empty', null, App.resourceView(App.state.role) === 'team' && !App.roleDept(App.state.role)
          ? 'Your role isn’t in a department, so it has no team to show. An admin can open this up in Admin → Access Control.'
          : 'Nobody in view — check the Dept and Owner filters.'));
        return;
      }
      const unit = resourceUnit(ctx.dw);
      const segs = segments(ctx, unit);
      const lastIso = App.shiftIso(App.isoDate(ctx.start), ctx.totalCalDays - 1);
      const buckets = segs.map((seg, i) => {
        const start = App.isoDate(seg.day);
        const end = unit === 'days' ? start : segs[i + 1] ? App.shiftIso(App.isoDate(segs[i + 1].day), -1) : lastIso;
        return {
          key: start, start, end, x: seg.colStart * ctx.dw, w: seg.colSpan * ctx.dw,
          label: unit === 'days' ? App.fmtDate(start) : unit === 'weeks' ? seg.label + ' · ' + seg.sub : seg.label + ' ' + seg.sub
        };
      }).filter(b => {
        if (unit !== 'days') return true;
        const dow = App.parseDate(b.start).getDay();
        return dow !== 0 && dow !== 6;
      });
      const load = App.resourceLoad(people, buckets);
      // every open task per department — a department's count includes work
      // nobody has been given yet
      const deptTasks = {};
      App.activeEpisodes().forEach(ep => App.subitems(ep).forEach(su => {
        if (su.status !== 'approved') (deptTasks[su.dept] = deptTasks[su.dept] || []).push({ ep, su });
      }));
      const byDept = {};
      people.forEach(p => { const d = App.roleDept(p.role); (byDept[d] = byDept[d] || []).push(p); });
      const todayIso = App.isoDate(App.today());
      const isNow = (b) => b.start <= todayIso && b.end >= todayIso;

      Object.keys(App.DEPARTMENTS).filter(d => byDept[d]).forEach(dk => {
        const dep = App.dept(dk);
        const crew = byDept[dk].sort((a, b) => a.name.localeCompare(b.name));
        const expKey = 'res:' + dk;
        const expanded = !!App.state.ganttExpanded[expKey];
        const row = el('.g-row.res-lane');
        row.dataset.episodeId = expKey;
        row.appendChild(el('.g-label', null, [
          el('.l-title', null, [el('span.chev' + (expanded ? '.open' : ''), null, '▶'), this.deptDot(dep), el('span', null, dep.label)]),
          el('.l-sub', null, [el('span.code', null, crew.length + (crew.length === 1 ? ' person' : ' people'))])
        ]));
        const track = el('.g-track', { 'data-res-key': expKey });
        buckets.forEach(b => {
          const x = crew.reduce((a, p) => {
            const l = load[p.id][b.key];
            a.cap += l.cap; a.busy += Math.max(l.booked, l.planned); a.booked += l.booked; a.planned += l.planned;
            return a;
          }, { cap: 0, busy: 0, booked: 0, planned: 0 });
          const wd = App.workdaysIn(b.start, b.end);
          const tasks = (deptTasks[dk] || []).filter(({ su }) => wd.some(day => su.start <= day && su.due >= day));
          track.appendChild(this.resCircle(b, x, tasks, dep, dep.label, isNow(b), false, true));
        });
        row.appendChild(track);
        body.appendChild(row);
        if (!expanded) return;

        crew.forEach(p => {
          // zoomed in to days, a person's circles give way to their actual
          // task bars — see resPersonBars
          if (unit === 'days') { this.resPersonBars(body, p, dep, buckets, load, ctx); return; }
          const prow = el('.g-row.sub.res-lane.res-person');
          prow.appendChild(this.resPersonLabel(p));
          const ptrack = el('.g-track', { 'data-res-key': 'person:' + p.id });
          buckets.forEach(b => {
            const l = load[p.id][b.key];
            ptrack.appendChild(this.resCircle(b, { cap: l.cap, busy: Math.max(l.booked, l.planned), booked: l.booked, planned: l.planned, off: l.off },
              l.tasks, dep, p.name, isNow(b), l.days > 0 && l.off >= l.days, false));
          });
          prow.appendChild(ptrack);
          body.appendChild(prow);
        });
      });
      this.resAnimate(body, ctx, unit);
    },

    /* Changing cell size (day / week / month) animates instead of snapping.
       Zooming IN, every new circle grows out of the parent it came from:
       it starts at the parent's centre and size and glides to its own spot.
       Zooming OUT, the old circles are pulled into their new parent and
       shrink away (stand-ins, since the real ones are already gone), while
       the parent swells into place. Everything is worked out from the
       circles' dates under the CURRENT scale, so it holds however far the
       zoom jumped. The snapshot taken here is what the next render compares
       against. Transforms only — nothing reflows — and none of it for
       people who ask for reduced motion. */
    resAnimate(body, ctx, unit) {
      const RANK = { days: 0, weeks: 1, months: 2 };
      const centre = (start, end) => (ctx.colOf(start) + ctx.colOf(App.shiftIso(end, 1))) / 2 * ctx.dw;
      const read = () => {
        const rows = {};
        body.querySelectorAll('.g-track[data-res-key]').forEach(t => {
          rows[t.dataset.resKey] = [...t.querySelectorAll('.res-cell[data-start]')].map(c => {
            const ring = c.querySelector('.res-ring');
            return ring && { start: c.dataset.start, end: c.dataset.end, el: ring, size: ring.offsetWidth || parseFloat(ring.style.width),
              disc: parseFloat(ring.firstChild.style.width), over: ring.classList.contains('over'), color: ring.style.getPropertyValue('--res-c') };
          }).filter(Boolean);
        });
        return rows;
      };
      const prev = this._resSnap;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      requestAnimationFrame(() => {
        const now = read();
        this._resSnap = { unit, rows: Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v.map(({ el: _, ...rest }) => rest)])) };
        if (!prev || prev.unit === unit || reduce || !body.isConnected) return;
        const zoomIn = RANK[unit] < RANK[prev.unit];
        // only what's on screen (plus a margin) moves — a long board has
        // hundreds of circles, and off-screen motion is all cost, no picture
        const sc = this._scrollEl;
        const lo = (sc ? sc.scrollLeft : 0) - 160, hi = (sc ? sc.scrollLeft + sc.clientWidth - LABEL_W : Infinity) + 160;
        const seen = (x) => x >= lo && x <= hi;
        // ease-in-out (cubic) on every leg, so motion ramps up and settles at both ends
        const ease = 'cubic-bezier(.65,0,.35,1)', dur = 560;
        // a person's task bars (day zoom) draw out from their start as they arrive
        if (zoomIn) body.querySelectorAll('.res-bars .bar').forEach((bar, i) => {
          if (!seen(parseFloat(bar.style.left))) return;
          // .bar centres itself with translateY(-50%), so the keyframes keep it
          bar.animate([{ transform: 'translateY(-50%) scaleX(.15)', transformOrigin: 'left center', opacity: 0 }, { transform: 'translateY(-50%)', transformOrigin: 'left center', opacity: 1 }],
            { duration: dur, easing: ease, delay: Math.min(i % 7, 6) * 18 });
        });
        // the counts sit at their final spots, so they wait for the circles to land
        body.querySelectorAll('.res-count').forEach(n => {
          if (seen(parseFloat(n.parentNode.style.left))) n.animate([{ opacity: 0 }, { opacity: 0, offset: .6 }, { opacity: 1 }], { duration: dur + 160, easing: 'ease-in-out' });
        });
        body.querySelectorAll('.g-track[data-res-key]').forEach(track => {
          const before = prev.rows[track.dataset.resKey] || [];
          const after = now[track.dataset.resKey] || [];
          if (zoomIn) {
            after.forEach((c, i) => {
              if (!seen(centre(c.start, c.end))) return;
              const parent = before.find(p => p.start <= c.start && p.end >= c.start);
              if (!parent) { c.el.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: dur, easing: ease }); return; }
              const dx = centre(parent.start, parent.end) - centre(c.start, c.end);
              const k = parent.size / Math.max(1, c.size);
              c.el.animate([
                { transform: 'translateX(' + dx + 'px) scale(' + k + ')', opacity: .35 },
                { transform: 'none', opacity: 1 }
              ], { duration: dur, easing: ease, delay: Math.min(i % 7, 6) * 18 });
            });
          } else {
            after.forEach(p => {
              const pc = centre(p.start, p.end);
              if (!seen(pc)) return;
              const kids = before.filter(c => c.start >= p.start && c.start <= p.end && seen(centre(c.start, c.end)));
              kids.forEach(c => {
                const cc = centre(c.start, c.end);
                const ghost = el('.res-cell.res-ghost', { style: { left: (cc - c.size / 2) + 'px', width: c.size + 'px' } }, [
                  el('.res-ring' + (c.over ? '.over' : ''), { style: { width: c.size + 'px', height: c.size + 'px' } },
                    [el('.res-disc', { style: { width: c.disc + 'px', height: c.disc + 'px' } })])
                ]);
                ghost.firstChild.style.setProperty('--res-c', c.color);
                track.appendChild(ghost);
                ghost.animate([
                  { transform: 'none', opacity: 1 },
                  { transform: 'translateX(' + (pc - cc) + 'px) scale(.2)', opacity: 0 }
                ], { duration: dur, easing: ease, fill: 'forwards' }).onfinish = () => ghost.remove();
              });
              p.el.animate([{ transform: 'scale(.3)', opacity: 0 }, { transform: 'scale(.3)', opacity: 0, offset: .35 }, { transform: 'none', opacity: 1 }],
                { duration: dur + 100, easing: ease });
            });
          }
        });
      });
    },

    resPersonLabel(p) {
      return el('.g-label', { onclick: (e) => { e.stopPropagation(); App.resources.openPerson(p.id); }, title: 'Capacity, time off and allocations' }, [
        el('.l-title', null, [
          el('span.avatar', { style: { width: '18px', height: '18px', fontSize: '8px', background: p.color, flex: 'none' } }, App.initials(p.name)),
          el('span', null, p.name)
        ]),
        el('.l-sub', null, [el('span', null, App.role(p.role).label + (p.contractor ? ' · Contractor' : '') + ' · ' +
          (Math.round(App.personCapacity(p) * 10) / 10) + 'd/wk')])
      ]);
    },

    /* A person at day zoom: their tasks as the Timeline's own task bars
       (taskBar — same colours, status ring, holiday pauses, revisions, and
       the same click-to-edit and drag, since they're .bar elements in a
       .g-row.sub carrying the episode and task). Overlapping tasks stack
       into lanes exactly as epTaskLines does; the first lane carries the
       person's label, the rest are continuation rows. Days they're off are
       hatched behind the bars, across every lane. */
    resPersonBars(body, p, dep, buckets, load, ctx) {
      const xOf = this._xOf;
      const items = [];
      App.activeEpisodes().forEach(ep => App.subitems(ep).forEach(su => { if (su.assignee === p.id) items.push({ ep, su }); }));
      items.sort((a, b) => a.su.start < b.su.start ? -1 : 1);
      const levels = [];
      items.forEach(it => {
        const end = App.plannedRevisions(it.ep, it.su).end;
        const lvl = levels.find(l => it.su.start > l.lastDue);
        if (lvl) { lvl.lastDue = end; lvl.items.push(it); }
        else levels.push({ lastDue: end, items: [it] });
      });
      if (!levels.length) levels.push({ items: [] });
      levels.forEach((lvl, li) => {
        const row = el('.g-row.sub.res-lane.res-person.res-bars' + (li ? '.res-cont' : ''));
        row.appendChild(li === 0 ? this.resPersonLabel(p) : el('.g-label'));
        const track = el('.g-track');
        buckets.forEach(b => {
          const l = load[p.id][b.key];
          if (l.days && l.off >= l.days) track.appendChild(el('.res-cell.away', { style: { left: b.x + 'px', width: b.w + 'px' } }));
        });
        lvl.items.forEach(({ ep, su }) => this.taskBar(track, ep, su, dep, xOf, ctx.dw, ep.code + ' · ' + su.name, null, { portrait: false }));
        row.appendChild(track);
        body.appendChild(row);
      });
    },

    /* One cell's circle, sized to the cell: as big as the narrower of the
       cell and the row allows (capped so a wide day or month doesn't balloon
       into the row's borders). The task count needs room beside the circle,
       so on a narrow cell it moves into the tooltip only. */
    resCircle(b, x, tasks, dep, who, now, away, isDept) {
      const cell = el('.res-cell' + (now ? '.now' : ''), { style: { left: b.x + 'px', width: b.w + 'px' }, 'data-start': b.start, 'data-end': b.end });
      const roomy = b.w >= 34;
      if (away) { if (b.w >= 30) cell.appendChild(el('span.res-away', null, 'Away')); else cell.classList.add('away'); return cell; }
      if (!tasks.length && x.busy <= 0) return cell;
      const ratio = x.cap > 0 ? x.busy / x.cap : (x.busy > 0 ? 2 : 0);
      const over = ratio > 1.001;
      const ring = Math.max(6, Math.min(b.w - (roomy ? 12 : 4), isDept ? 40 : 34));
      const disc = ring * Math.sqrt(Math.min(1, ratio));
      const r1 = (n) => Math.round(n * 10) / 10;
      const tip = () => {
        const box = el('.res-tip');
        box.appendChild(el('.res-tip-head', null, who + ' · ' + b.label));
        box.appendChild(el('.res-tip-sub', null, r1(x.booked) + ' d booked' + (x.planned ? ' · ' + r1(x.planned) + ' d planned' : '') +
          ' of ' + r1(x.cap) + ' d' + (x.off ? ' (' + x.off + ' d off)' : '') + ' · ' + tasks.length + (tasks.length === 1 ? ' task' : ' tasks')));
        tasks.slice().sort((a, c) => a.su.start < c.su.start ? -1 : 1).slice(0, 12).forEach(({ ep, su }) => {
          const owner = isDept && su.assignee ? App.person(su.assignee) : null;
          box.appendChild(el('.res-tip-task', { style: { borderLeftColor: App.dept(su.dept).color } }, [
            el('span.res-tip-code', null, ep.code), ' ' + su.name,
            el('span.res-tip-meta', null, App.fmtRange(su.start, su.due) + (owner ? ' · ' + owner.name : isDept && !su.assignee ? ' · unassigned' : ''))
          ]));
        });
        if (tasks.length > 12) box.appendChild(el('.res-tip-sub', null, '+ ' + (tasks.length - 12) + ' more'));
        return box;
      };
      const circle = el('.res-ring' + (over ? '.over' : ''), {
        title: tip, style: { width: ring + 'px', height: ring + 'px' }
      }, [el('.res-disc', { style: { width: disc + 'px', height: disc + 'px' } })]);
      circle.style.setProperty('--res-c', dep.color);
      cell.appendChild(circle);
      if (tasks.length && roomy) cell.appendChild(el('span.res-count', null, String(tasks.length)));
      return cell;
    },

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

        // Portrait gives every department a whole COLUMN, so an expanded
        // department's own summary bar would sit next to its tasks eating a
        // full column of width for information the tasks already show. Once
        // open it collapses to a thin spine — just the dept's span as a
        // hairline, and a chevron-plus-dot label to close it again.
        const spine = portrait && expanded;
        const row = selRow(el('.g-row' + (spine ? '.spine' : '')), all);
        row.dataset.episodeId = expKey;                       // expansion key via the shared click handler
        const labelTip = dep.label + ' — ' + group.keys.length + ' task' + (group.keys.length === 1 ? '' : 's') +
                         ' · ' + epCount + ' ep' + (epCount === 1 ? '' : 's') + ' · ' + App.fmtRange(min, max);
        row.appendChild(el('.g-label', { title: portrait ? labelTip : null }, spine ? [
          el('.l-title', null, [
            el('span.chev.open', null, '▶'),
            this.deptDot(dep)
          ])
        ] : [
          el('.l-title', null, [
            el('span.chev' + (expanded ? '.open' : ''), null, '▶'),
            this.deptDot(dep),
            el('span', null, dep.label)
          ]),
          // A portrait column is ~96px wide, not the 220px a Landscape label
          // gets, so the sub-line carries only the task count — the episode
          // count and date range live in the label's tooltip instead of
          // being ellipsised into nothing.
          el('.l-sub', null, portrait ? [
            el('span.code', null, group.keys.length + ' task' + (group.keys.length === 1 ? '' : 's'))
          ] : [
            el('span.code', null, group.keys.length + ' task' + (group.keys.length === 1 ? '' : 's')),
            el('span', null, '· ' + epCount + ' ep' + (epCount === 1 ? '' : 's') + ' · ' + App.fmtRange(min, max))
          ])
        ]));

        const track = el('.g-track');
        const barStyle = { background: barGradient(dep.color, axis), color: pickInk(dep.color) };
        setBarPos(barStyle, axis, xOf, min, max);
        const bar = el('.bar' + (complete ? '.delivered' : ''), {
          title: dep.label + ' — ' + group.keys.length + ' task' + (group.keys.length === 1 ? '' : 's') +
                 ' across ' + epCount + ' episode' + (epCount === 1 ? '' : 's') + ' · ' + prog + '% complete',
          style: barStyle
        }, spine ? [] : [el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, dep.label)]);
        if (!spine && !complete && prog > 0) bar.appendChild(progressFill(prog, axis));
        attachBar(bar, complete ? { color: '#00c875', label: 'Complete' } : { color: '#fdab3d', label: prog + '% complete' }, !spine);
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
    episodeStackedRow(body, ep, startIso, dw, timeW, xOf, axis) {
      body.appendChild(this.epTopRow(ep, xOf, dw, axis));
      if (!App.state.ganttExpanded[ep.id]) return;

      const { order, byDept } = this.groupByDept([ep]);
      order.forEach(dk => {
        const group = byDept[dk];
        this.deptStackedLines(body, App.dept(dk), this.groupItems(group), xOf, dw, null, axis);
      });
    },

    // "Show" sort: one top row per show; expand → the show's departments on
    // the Y axis with their tasks on the board, exactly as the Episode sort
    // reads, but pooling every episode of the show onto the same lines.
    showRow(body, show, eps, startIso, dw, timeW, xOf, axis) {
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

      const portrait = !!(axis && axis.portrait);
      const spine = portrait && expanded;

      const row = selRow(el('.g-row' + (spine ? '.spine' : '')), [].concat(...eps.map(epItems)));
      row.dataset.episodeId = expKey;                       // expansion key via the shared click handler
      const labelTip = show.name + ' — ' + eps.length + ' episode' + (eps.length === 1 ? '' : 's') +
                       ' · ' + App.fmtRange(min, max);
      row.appendChild(el('.g-label', { title: portrait ? labelTip : null }, spine ? [
        el('.l-title', null, [el('span.chev.open', null, '▶')])
      ] : [
        el('.l-title', null, [
          el('span.chev' + (expanded ? '.open' : ''), null, '▶'),
          el('span', null, show.name)
        ]),
        el('.l-sub', null, portrait ? [
          el('span.code', null, eps.length + ' ep' + (eps.length === 1 ? '' : 's'))
        ] : [
          el('span.code', null, eps.length + ' episode' + (eps.length === 1 ? '' : 's')),
          el('span', null, '· ' + App.fmtRange(min, max))
        ])
      ]));

      const track = el('.g-track');
      const barStyle = { background: barGradient(show.color, axis), color: pickInk(show.color) };
      setBarPos(barStyle, axis, xOf, min, max);
      const bar = el('.bar' + (delivered ? '.delivered' : ''), {
        title: show.name + ' — ' + eps.length + ' episode' + (eps.length === 1 ? '' : 's') + ' · ' + prog + '% complete',
        style: barStyle
      }, spine ? [] : [el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, show.name)]);
      if (!spine && !delivered && prog > 0) bar.appendChild(progressFill(prog, axis));
      attachBar(bar, delivered ? { color: '#00c875', label: 'Delivered' } : { color: '#fdab3d', label: prog + '% complete' }, !spine);
      track.appendChild(bar);
      row.appendChild(track);
      body.appendChild(row);
      if (!expanded) return;

      // Departments on the Y axis, one row each — collapsed to a summary bar
      // exactly like the Department sort's own top-level rows, just scoped to
      // this show and nested one level under it. Expanding a department is
      // what reveals its tasks, so opening a show doesn't dump every task of
      // every department onto the screen at once.
      this.showDeptRows(body, show, eps, xOf, dw, axis);
    },

    /* Show sort, expanded: one row per department, in the same collapsed
       shape departmentRows() draws at the top level — dept dot, task/episode
       counts, a date-range summary bar — but scoped to just this show's
       episodes and keyed per-show so opening "Audio" under one show doesn't
       open it under another, or collide with the flat Department sort's own
       expand state for the same department key.

       `.exp` marks the row as expandable despite carrying `.sub`'s indent —
       see the click handler's note on that class. Its own expansion reveals
       epTaskLines' per-task rows, `deep`-indented one step further so
       Show → Department → Task reads as a chain rather than two things at
       the same depth. */
    showDeptRows(body, show, eps, xOf, dw, axis) {
      const { order, byDept } = this.groupByDept(eps);
      const portrait = !!(axis && axis.portrait);
      order.forEach(dk => {
        const dep = App.dept(dk), group = byDept[dk];
        const all = this.groupItems(group);
        if (!all.length) return;

        const expKey = 'show:' + show.id + ':dept:' + dk;
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

        const spine = portrait && expanded;
        const row = selRow(el('.g-row.sub.exp' + (spine ? '.spine' : '')), all);
        row.dataset.episodeId = expKey;                     // expansion key via the shared click handler
        const labelTip = dep.label + ' — ' + group.keys.length + ' task' + (group.keys.length === 1 ? '' : 's') +
                         ' · ' + epCount + ' ep' + (epCount === 1 ? '' : 's') + ' · ' + App.fmtRange(min, max);
        row.appendChild(el('.g-label', { title: portrait ? labelTip : null }, spine ? [
          el('.l-title', null, [el('span.chev.open', null, '▶'), this.deptDot(dep)])
        ] : [
          el('.l-title', null, [
            el('span.chev' + (expanded ? '.open' : ''), null, '▶'),
            this.deptDot(dep),
            el('span', null, dep.label)
          ]),
          // A portrait column is ~96px wide, not the 220px a Landscape label
          // gets, so the sub-line carries only the task count — the episode
          // count and date range live in the label's tooltip instead of
          // being ellipsised into nothing.
          el('.l-sub', null, portrait ? [
            el('span.code', null, group.keys.length + ' task' + (group.keys.length === 1 ? '' : 's'))
          ] : [
            el('span.code', null, group.keys.length + ' task' + (group.keys.length === 1 ? '' : 's')),
            el('span', null, '· ' + epCount + ' ep' + (epCount === 1 ? '' : 's') + ' · ' + App.fmtRange(min, max))
          ])
        ]));

        const track = el('.g-track');
        const barStyle = { background: barGradient(dep.color, axis), color: pickInk(dep.color) };
        setBarPos(barStyle, axis, xOf, min, max);
        const bar = el('.bar' + (complete ? '.delivered' : ''), {
          title: dep.label + ' — ' + group.keys.length + ' task' + (group.keys.length === 1 ? '' : 's') +
                 ' across ' + epCount + ' episode' + (epCount === 1 ? '' : 's') + ' · ' + prog + '% complete',
          style: barStyle
        }, spine ? [] : [el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, dep.label)]);
        if (!spine && !complete && prog > 0) bar.appendChild(progressFill(prog, axis));
        attachBar(bar, complete ? { color: '#00c875', label: 'Complete' } : { color: '#fdab3d', label: prog + '% complete' }, !spine);
        track.appendChild(bar);
        row.appendChild(track);
        body.appendChild(row);
        if (!expanded) return;

        // task rows carry the episode code on each bar, same as the
        // Department sort — a line here still mixes every episode of the show
        group.keys.forEach(k => this.epTaskLines(body, dep, group.tasks[k].name, group.tasks[k].items, xOf, dw, axis, true));
      });
    },

    // ---- Producer Notes swimlane ----
    // A collapsible band at the top of the timeline holding free-form, date-
    // ranged producer annotations for the selected show. Notes interval-stack
    // onto as many rows as needed so overlapping notes never hide each other.
    // Click-drag an empty grid cell to draw a new note, click a note to
    // edit/recolour/delete, drag the middle to move or an edge to resize
    // (weekend-aware, same math as task bars).
    producerNotesLane(body, showId, startIso, dw, xOf) {
      const show = App.show(showId);
      if (!show) return;
      /* Time off for departments, roles and people shows up here as read-only
         red notes on its dates (the whole production's days are painted
         through the timeline instead). */
      const cal = show.calendar ? App.normCal(show.calendar) : null;
      const offNotes = cal ? cal.offDays.filter(o => o.scope !== 'show').map(o => {
        const who = o.scope === 'dept' ? App.dept(o.target).label
          : o.scope === 'role' ? App.role(o.target).label
          : (App.person(o.target) || { name: 'Someone' }).name;
        return { start: o.start, due: o.end, color: '#ff5b6e', holiday: true, offId: o.id,
                 text: who + ' off' + (o.label ? ' · ' + o.label : '') };
      }) : [];
      const notes = (show.notes || []).concat(offNotes).sort((a, b) => a.start < b.start ? -1 : 1);
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
      /* A note may take a second line: split at " · " (how time off reads —
         "Chris off · Holiday") or else at the space nearest the middle. Flat,
         that keeps a note sideways that would otherwise stand upright; upright,
         it's a second column so a long note isn't cut to a few letters. */
      const split2 = (t) => {
        const dot = t.indexOf(' · ');
        if (dot > 0) return [t.slice(0, dot), t.slice(dot + 3)];
        const mid = t.length / 2;
        let best = -1;
        for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
        return best > 0 ? [t.slice(0, best), t.slice(best + 1)] : null;
      };
      const shaped = notes.map(n => {
        const width = xOf.width(n.start, n.due);
        const text = n.text || 'Untitled note';
        const fitsFlat = width - 16 >= text.length * HFONT;
        const lines = fitsFlat ? null : split2(text);
        const longest = lines ? Math.max(lines[0].length, lines[1].length) : text.length;
        const flat2 = !!lines && width - 16 >= longest * HFONT;
        const portrait = !fitsFlat && !flat2;
        // upright: a second column only when one would be cut short and there's room for two
        const two = flat2 || (portrait && !!lines && width >= 28 && text.length * VSTEP + 14 > 84);
        const portraitH = Math.max(36, Math.min(two ? 110 : 84, Math.round((two ? longest : text.length) * VSTEP) + 14));
        return { n, width, text, portrait, portraitH, lines: two ? lines : null, flat2 };
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
        const rowH = lvl.items.reduce((m, s) => s.portrait ? Math.max(m, s.portraitH + 8) : s.flat2 ? Math.max(m, 38) : m, 26);
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
          else if (s.flat2) style.height = '30px';
          // time-off notes come from the show's calendar — edited there, not here
          const note = el('.pn-note' + (canEdit && !n.holiday ? '.editable' : '') + (n.holiday ? '.pn-holiday' : '') + (s.portrait ? '.portrait' : '') + (s.lines ? '.two' : ''), {
            title: s.text + ' · ' + App.fmtRange(n.start, n.due) + (n.holiday ? ' — click to edit or delete' : ''),
            style: style
          }, s.lines ? s.lines.map(t => el('span', null, t)) : [el('span', null, s.text)]);
          if (n.id) note.dataset.noteId = n.id;
          if (n.offId) note.dataset.offId = n.offId;
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
          /* Turn the note into time off: the show's Working Days & Holidays
             page opens with the note's dates and text already filled in as a
             new entry, ready to say who's off. The note is only removed once
             that's saved — cancel, and it stays a note. */
          (App.canManageShows(App.state.role) ? el('button.pn-holiday-btn', {
            title: 'Make this a holiday — opens Working Days & Holidays with these dates',
            onclick: () => {
              pop._commit = null;
              const text = input.value.trim() || note.text || '';
              this.closeNoteEditor();
              App.addShow.open({
                showId, step: 3,
                newOff: { label: text, start: note.start, end: note.due },
                onSaved: () => App.removeNote(showId, id)
              });
            }
          }, [App.icon('calendar'), ' Make holiday']) : null),
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

    /* A time-off note's editor: what it is, and the two things to do with it.
       Edit opens the show's Working Days & Holidays page on that entry (who,
       dates, label all live there); Delete removes the time off. */
    openHolidayNote(noteEl) {
      this.closeNoteEditor();
      const showId = noteEl.dataset.showId, offId = noteEl.dataset.offId;
      const show = App.show(showId);
      const off = show && show.calendar && (show.calendar.offDays || []).find(o => o.id === offId);
      if (!off) return;
      const r = noteEl.getBoundingClientRect();
      const can = App.canManageShows(App.state.role);
      const pop = el('.pn-editor.pn-hol-editor', { onclick: (e) => e.stopPropagation(), onmousedown: (e) => e.stopPropagation() }, [
        el('.pn-hol-title', null, noteEl.textContent),
        el('.pn-hol-dates', null, off.start === off.end ? App.fmtDate(off.start) : App.fmtRange(off.start, off.end)),
        can ? el('.pn-editor-actions', null, [
          el('button.pn-del', { onclick: () => { this.closeNoteEditor(); App.removeTimeOff(showId, offId); } }, [App.icon('trash'), ' Delete']),
          el('button.pn-done', { onclick: () => { this.closeNoteEditor(); App.addShow.open({ showId, step: 3, focusOff: offId }); } }, [App.icon('pencil'), ' Edit'])
        ]) : el('.fld-hint', null, 'Only Producers can change time off.')
      ]);
      pop._commit = null;
      document.body.appendChild(pop);
      this._noteEditor = pop;
      requestAnimationFrame(() => {
        const pw = pop.offsetWidth, ph = pop.offsetHeight;
        let left = r.left, top = r.bottom + 8;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
        if (top + ph > window.innerHeight - 8) top = r.top - ph - 8;
        pop.style.left = Math.max(8, left) + 'px';
        pop.style.top = Math.max(8, top) + 'px';
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
    /* Opt+click on an expandable row: every row of the same kind opens or
       closes with it. Episodes reach the whole timeline, collapsed shows
       included; department and show rows reach the ones on screen, which at
       their level is all of them. */
    expandAllLike(key, open) {
      const exp = App.state.ganttExpanded;
      let keys;
      if (key.indexOf(':') === -1) keys = (this._episodes || []).map(ep => ep.id);
      else {
        const shape = key.replace(/[^:]+/g, 'x');     // 'dept:x', 'show:x', 'show:x:dept:x'
        const head = key.split(':')[0];
        keys = [...(this._scrollEl ? this._scrollEl.querySelectorAll('.g-row[data-episode-id]') : [])]
          .map(r => r.dataset.episodeId)
          .filter(k => k.split(':')[0] === head && k.replace(/[^:]+/g, 'x') === shape);
      }
      if (keys.indexOf(key) === -1) keys.push(key);
      keys.forEach(k => { if (open) exp[k] = true; else delete exp[k]; });
    },

    /* ← / → on a selection. `step` is in the columns the timeline draws, so
       with weekends hidden a day step goes Friday → Monday, the same as a
       one-column drag. `cascade` (Opt) carries along everything downstream of
       the selection — transitively, within each episode — by the same step,
       so the gaps between them hold. Approved work stays where it landed. */
    nudgeSelection(step, cascade) {
      if (!App.canEditSchedule(App.state.role)) {
        App.toast('Only Producers, Managers and Post Operations can change the schedule', true); return;
      }
      const sel = selResolved();
      if (!sel.length) return;
      const hw = App.prefs.get('hideWeekends', true);
      const moves = new Map();
      const add = (ep, su) => {
        const k = selKey(ep.id, su.key);
        if (!moves.has(k)) moves.set(k, {
          epId: ep.id, suKey: su.key,
          start: App.addVisibleDays(su.start, step, hw), due: App.addVisibleDays(su.due, step, hw)
        });
      };
      sel.forEach(s => add(s.ep, s.su));
      if (cascade) {
        const byEp = new Map();
        sel.forEach(s => { if (!byEp.has(s.epId)) byEp.set(s.epId, { ep: s.ep, keys: new Set() }); byEp.get(s.epId).keys.add(s.suKey); });
        byEp.forEach(({ ep, keys }) => {
          const pipe = App.pipelineFor(ep);
          const byKey = {}; pipe.forEach(t => { byKey[t.key] = t; });
          const order = App.topoSort(pipe) || pipe.map(t => t.key);
          const down = new Set(keys);
          order.forEach(k => { const t = byKey[k]; if (t && !down.has(k) && t.deps.some(d => down.has(d))) down.add(k); });
          down.forEach(k => {
            if (keys.has(k)) return;
            const su = App.subitem(ep, k);
            if (su && su.status !== 'approved') add(ep, su);
          });
        });
      }
      App.track.feature(cascade ? 'timeline.keyNudgeCascade' : 'timeline.keyNudge');
      App.timelineDraft.stage([...moves.values()]);
    },

    centerToday() {
      const s = this._scrollEl;
      if (!s) { this._wantCenter = true; App.render(); return; }
      const t = s.querySelector('.today-line');
      if (!t) return;
      if (this._axis && this._axis.portrait) s.scrollTo({ top: Math.max(0, parseFloat(t.style.top) - s.clientHeight * 0.38), behavior: 'smooth' });
      else s.scrollTo({ left: Math.max(0, parseFloat(t.style.left) - s.clientWidth * 0.38), behavior: 'smooth' });
    }
  };

  /* A task name too long for its bar at this zoom falls back to its
     initials — "Storyboard & Animatic" → "S&A" — before it ellipsises. Runs
     after every render, which is also what a zoom does, so zooming back in
     brings the full name back. The full name is always in the tooltip. */
  // days of nothing between a department's tasks before its phase line breaks
  const PHASE_GAP_DAYS = 14;

  function abbreviate(name) {
    const words = String(name).split(/\s+/).filter(Boolean);
    if (words.length < 2) return '';
    // symbols, versions and acronyms stay whole: "Animatic V2" → "AV2", "VO Comps" → "VOC"
    return words.map(w => /^[&+\/-]$/.test(w) || /\d/.test(w) || /^[A-Z]{2,}$/.test(w) ? w : w[0].toUpperCase()).join('');
  }
  // waits for this chart to be in the page and laid out before measuring
  function fitBarLabels(root, tries = 0) {
    requestAnimationFrame(() => {
      if (!root.isConnected) { if (tries < 10) fitBarLabels(root, tries + 1); return; }
      const ls = root.querySelectorAll('.bar-label[data-abbr]');
      ls.forEach(sp => { if (sp.scrollWidth > sp.clientWidth + 1) sp.textContent = sp.dataset.abbr; });
    });
  }

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
