/* Timeline (Gantt) view — swimlanes grouped by episode status, week/day column
   header, a live "today" line, and click-to-expand episode → subitem bars.
   Uses event delegation and centralized scroll state to prevent view jank. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const LABEL_W = 220;   // must match .g-label width in style.css

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

  function gridLines(grid, ctx, unit, strong) {
    segments(ctx, unit).forEach(seg => {
      const left = seg.colStart + seg.colSpan;
      if (left > 0 && left < ctx.totalCols) grid.appendChild(el('.grid-line' + (strong ? '.strong' : ''), { style: { left: (left * ctx.dw) + 'px' } }));
    });
  }

  App.gantt = {
    _wantCenter: true,
    _scrollEl: null,
    _rafId: null,

    render(episodes) {
      const wrap = el('.gantt' + (App.prefs.get('latchScroll', false) ? '.latch' : ''));
      if (!episodes.length) { wrap.appendChild(el('.empty', null, 'No episodes match the current filters.')); return wrap; }

      let min = '9999', max = '0000';
      episodes.forEach(ep => {
        const s = App.epStart(ep), d = App.epDue(ep);
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

      const tier = tierFor(dw);
      const scroll = el('.gantt-scroll', { style: { maxHeight: 'calc(100vh - 230px)' } });
      const inner = el('.gantt-inner', { style: { width: (LABEL_W + timeW) + 'px' } });

      inner.appendChild(this.buildHead(ctx, tier));

      const body = el('.gantt-body');
      const grid = el('.grid-bg', { style: { left: LABEL_W + 'px', width: timeW + 'px' } });
      if (!hideWeekends && tier.secondary === 'days') {
        for (let i = 0; i < totalCalDays; i++) {
          const day = App.addDays(start, i);
          if (day.getDay() === 0 || day.getDay() === 6)
            grid.appendChild(el('.grid-col.weekend', { style: { left: (i * dw) + 'px', width: dw + 'px' } }));
        }
      }
      gridLines(grid, ctx, tier.secondary, false);
      gridLines(grid, ctx, tier.primary, true);
      body.appendChild(grid);

      const todayIso = App.isoDate(App.today());
      if (todayIso >= startIso && todayIso <= App.isoDate(end)) {
        const tx = LABEL_W + xOf(todayIso) + dw / 2;
        body.appendChild(el('.today-line', { style: { left: tx + 'px' } }));
      }

      const sort = App.prefs.get('timelineSort', 'department');
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
        // 'department': one row per episode; expand into one row per task
        episodes.slice().sort(byStart).forEach(ep => this.episodeRow(body, ep, startIso, dw, timeW, xOf));
      }

      inner.appendChild(body);
      scroll.appendChild(inner);
      wrap.appendChild(scroll);

      this._scrollEl = scroll;
      this.setupEventDelegation();
      this.setupDrag();

      // settle: when scrolling stops, ease the nearest row flush under the
      // sticky chrome so no task row is ever left half-cut at the top
      scroll.addEventListener('scroll', () => {
        clearTimeout(this._settleT);
        this._settleT = setTimeout(() => this.settleRows(), 160);
      }, { passive: true });

      scroll.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          const old = App.state.zoom, nz = clampZoom(old * (e.deltaY < 0 ? 1.12 : 0.89));
          if (Math.abs(nz - old) > 0.001) {
            const sx = e.clientX - scroll.getBoundingClientRect().left;
            this._preserve = { dayOffset: (scroll.scrollLeft + sx - LABEL_W) / old, screenX: sx };
            App.state.zoom = nz; App.render();
          }
          return;
        }
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
        const bar = e.target.closest('.bar');
        const label = e.target.closest('.g-label');

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

      if (this._clickHandler) {
        this._scrollEl.removeEventListener('click', this._clickHandler);
      }
      this._clickHandler = handleClick;
      this._scrollEl.addEventListener('click', handleClick);
    },

    // ---- drag-to-reschedule a task bar ----
    // Middle = move (keeps duration); either edge = resize (keeps the other
    // edge fixed). Both are clamped live to the task's minDays; dependency
    // ordering is checked live for a warning outline and confirmed again in
    // App.moveTask on drop (which applies the change regardless and toasts).
    dragZone(bar, clientX) {
      const r = bar.getBoundingClientRect();
      if (r.width < 16) return 'move';                 // too narrow to grab an edge precisely
      const edge = Math.min(8, r.width / 3);
      const x = clientX - r.left;
      if (x <= edge) return 'resize-left';
      if (x >= r.width - edge) return 'resize-right';
      return 'move';
    },

    setupDrag() {
      if (!this._scrollEl) return;
      const scroll = this._scrollEl;

      const hoverHandler = (e) => {
        if (this._drag) return;
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
            ok = !!(su && App.canEditTask(App.state.role, su));
            this._adjustableCache.set(bar, ok);
          }
          bar.classList.toggle('adjustable', ok);
        }
        bar.style.cursor = this.dragZone(bar, e.clientX) === 'move' ? 'grab' : 'ew-resize';
      };
      scroll.addEventListener('mousemove', hoverHandler);

      const downHandler = (e) => {
        const bar = e.target.closest('.bar');
        if (!bar) return;
        const row = bar.closest('.g-row.sub');
        if (!row || row.classList.contains('phase')) return;
        const epId = bar.dataset.episodeId || row.dataset.episodeId;
        const suKey = bar.dataset.suKey || row.dataset.suKey;
        if (!epId || !suKey) return;
        const ep = App.state.data.episodes.find(x => x.id === epId);
        const su = ep && App.subitem(ep, suKey);
        if (!su || !App.canEditTask(App.state.role, su)) return;   // a plain click still surfaces the permission toast

        e.preventDefault();
        hideTip();
        const zone = this.dragZone(bar, e.clientX);
        const pipe = App.pipelineFor(ep);
        const task = pipe.find(t => t.key === suKey);
        const byKey = {}; App.subitems(ep).forEach(s => { byKey[s.key] = s; });
        this._drag = {
          bar, epId, suKey, zone, startClientX: e.clientX,
          origStart: su.start, origDue: su.due, curStart: su.start, curDue: su.due,
          minDays: (task && task.minDays) || 1,
          deps: (task ? task.deps : []).map(k => byKey[k]).filter(Boolean),
          dependents: pipe.filter(t => t.key !== suKey && t.deps.includes(suKey)).map(t => byKey[t.key]).filter(Boolean)
        };
        bar.classList.add('dragging');
        document.body.classList.add('gantt-dragging');
        document.body.style.cursor = zone === 'move' ? 'grabbing' : 'ew-resize';
      };
      scroll.addEventListener('mousedown', downHandler);

      // document-level so the drag tracks the cursor even off the bar/track;
      // attached once for the component's lifetime — re-renders just refresh
      // the _dw/_hideWeekends/_xOf scale these read, not the listeners
      if (!this._dragBound) {
        document.addEventListener('mousemove', (e) => this.onDragMove(e));
        document.addEventListener('mouseup', (e) => this.onDragEnd(e));
        this._dragBound = true;
      }
    },

    onDragMove(e) {
      const d = this._drag; if (!d) return;
      const dw = this._dw, hw = this._hideWeekends, xOf = this._xOf;
      const colDelta = Math.round((e.clientX - d.startClientX) / dw);

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

      d.bar.style.left = xOf(newStart) + 'px';
      d.bar.style.width = xOf.width(newStart, newDue) + 'px';

      const broken = d.deps.some(dep => newStart <= dep.due) || d.dependents.some(dep => dep.start <= newDue);
      d.bar.classList.toggle('warn', broken);

      const tip = dragTipEl(); tip.innerHTML = '';
      tip.appendChild(el('span.tip-dot', { style: { background: broken ? '#ff5b6e' : '#5fb0f0' } }));
      tip.appendChild(document.createTextNode(App.fmtRange(newStart, newDue) + (broken ? ' ⚠ breaks a dependency' : '')));
      tip.style.display = 'flex';
      tip.style.left = e.clientX + 'px';
      tip.style.top = (e.clientY - 38) + 'px';
    },

    onDragEnd(e) {
      const d = this._drag; if (!d) return;
      this._drag = null;
      d.bar.classList.remove('dragging', 'warn');
      document.body.classList.remove('gantt-dragging');
      document.body.style.cursor = '';
      hideDragTip();
      if (d.curStart !== d.origStart || d.curDue !== d.origDue) App.moveTask(d.epId, d.suKey, d.curStart, d.curDue);
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
      }, App.prefs.get('timelineSort', 'department') === 'show' ? 'SHOW / TASK' : 'EPISODE / SUBITEM'));
      const cols = el('', { style: { width: (ctx.totalCols * ctx.dw) + 'px' } });
      cols.appendChild(buildSegRow(ctx, tier.primary, 'primary'));
      cols.appendChild(buildSegRow(ctx, tier.secondary, 'secondary'));
      row.appendChild(cols);
      head.appendChild(row);
      return head;
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
          (overdue ? el('span', { style: { color: '#ff8a95', fontWeight: '700' } }, '· ⚠ ' + overdue) : null)
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
        (blocked ? el('span.blk', { title: blocked + ' blocked' }, '⛔') : null)
      ]);
      if (!delivered && prog > 0) {
        bar.appendChild(el('', { style: {
          position: 'absolute', left: '0', top: '0', bottom: '0', width: prog + '%',
          background: 'rgba(255,255,255,.22)', borderRadius: '6px', pointerEvents: 'none'
        } }));
      }
      attachBar(bar, epBarStatus(ep));
      track.appendChild(bar);
      row.appendChild(track);
      return row;
    },

    // draw one task bar into a sub-row track (shared by both episode sorts)
    taskBar(track, ep, su, dep, xOf, dw, labelText) {
      const sl = xOf(su.start), sw = xOf.width(su.start, su.due);
      const done = su.status === 'approved';
      const sbar = el('.bar' + (done ? '.delivered' : ''), {
        title: (labelText ? labelText + ' — ' : '') + su.name + ' — ' + App.status(su.status).label + ' · ' + App.fmtRange(su.start, su.due),
        style: { left: sl + 'px', width: sw + 'px', background: dep.color, color: pickInk(dep.color) }
      }, [
        el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, labelText || su.name),
        (App.isRiskBlocked(ep, su.key) ? el('span.blk', { title: 'In progress while a dependency is unapproved' }, '⛔') : null)
      ]);
      sbar.dataset.episodeId = ep.id;
      sbar.dataset.suKey = su.key;
      attachBar(sbar, { color: App.status(su.status).color, label: App.status(su.status).label });
      track.appendChild(sbar);
      return sbar;
    },

    // "Department" sort: one row per episode; expand → one row per task, in
    // pipeline order, each labelled with its department.
    episodeRow(body, ep, startIso, dw, timeW, xOf) {
      body.appendChild(this.epTopRow(ep, xOf, dw));
      if (!App.state.ganttExpanded[ep.id]) return;

      App.subsView(ep).sort((a, b) => a.start < b.start ? -1 : 1).forEach(su => {
        const srow = el('.g-row.sub');
        srow.dataset.episodeId = ep.id;
        srow.dataset.suKey = su.key;
        const dep = App.dept(su.dept);
        srow.appendChild(el('.g-label', { title: dep.label + ' — ' + su.name }, [
          el('.l-title', { style: { fontWeight: '600', fontSize: '10.5px' } }, [
            el('span.dot', { style: { background: dep.color, width: '7px', height: '7px', borderRadius: '50%', flex: 'none' } }),
            el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, su.name),
            el('span', { style: { color: 'var(--text-3)', fontWeight: '500', fontSize: '9px', marginLeft: 'auto', paddingLeft: '6px', flex: 'none' } }, dep.label)
          ])
        ]));
        const st = el('.g-track');
        this.taskBar(st, ep, su, dep, xOf, dw);
        srow.appendChild(st);
        body.appendChild(srow);
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

      const subs = App.subsView(ep);
      const byKey = {}; subs.forEach(su => { byKey[su.key] = su; });
      // department order = order of first appearance in the pipeline
      const deptOrder = [];
      App.pipelineFor(ep).forEach(t => { if (byKey[t.key] && !deptOrder.includes(t.dept)) deptOrder.push(t.dept); });

      deptOrder.forEach(dk => {
        const dep = App.dept(dk);
        const items = subs.filter(su => su.dept === dk).sort((a, b) => a.start < b.start ? -1 : 1);
        if (!items.length) return;
        const [dr, dg, db] = hexToRgb(dep.color);
        const wash = 'linear-gradient(rgba(' + dr + ',' + dg + ',' + db + ',.07), rgba(' + dr + ',' + dg + ',' + db + ',.07)), rgba(0,0,0,.16)';
        const multi = items.length > 1;

        // phase-span header row (only worth it for a multi-task department)
        if (multi) {
          const gStart = items.reduce((m, x) => x.start < m ? x.start : m, items[0].start);
          const gDue = items.reduce((m, x) => x.due > m ? x.due : m, items[0].due);
          const hrow = el('.g-row.sub.phase', { style: { background: wash } });
          hrow.appendChild(el('.g-label', { title: dep.label + ' phase', style: { background: deptLabelBg(dep.color) } }, [
            el('.l-title', { style: { fontWeight: '700', fontSize: '10.5px' } }, [
              el('span.dot', { style: { background: dep.color, width: '7px', height: '7px', borderRadius: '50%', flex: 'none' } }),
              el('span', null, dep.label)
            ])
          ]));
          const ht = el('.g-track');
          const hl = xOf(gStart), hw = xOf.width(gStart, gDue);
          ht.appendChild(el('.phase-bar', {
            title: dep.label + ' — ' + App.fmtRange(gStart, gDue) + ' · ' + items.length + ' tasks',
            style: { left: hl + 'px', width: hw + 'px',
              background: 'rgba(' + dr + ',' + dg + ',' + db + ',.15)',
              borderColor: 'rgba(' + dr + ',' + dg + ',' + db + ',.55)' }
          }));
          hrow.appendChild(ht);
          body.appendChild(hrow);
        }

        // interval-stack: a task shares a row unless it overlaps the last one
        const levels = [];
        items.forEach(su => {
          const lvl = levels.find(l => su.start > l.lastDue);
          if (lvl) { lvl.lastDue = su.due; lvl.items.push(su); }
          else levels.push({ lastDue: su.due, items: [su] });
        });
        levels.forEach((lvl, li) => {
          const srow = el('.g-row.sub', { style: { background: wash } });
          srow.appendChild(el('.g-label', { style: { background: deptLabelBg(dep.color) } },
            el('.l-title', { style: { fontWeight: '600', fontSize: '10.5px' } },
              multi
                ? [el('span', { style: { color: 'var(--text-3)', paddingLeft: '20px' } }, '↳')]
                : [el('span.dot', { style: { background: dep.color, width: '7px', height: '7px', borderRadius: '50%', flex: 'none' } }),
                   el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, dep.label)]
            )
          ));
          const st = el('.g-track');
          lvl.items.forEach(su => this.taskBar(st, ep, su, dep, xOf, dw));
          srow.appendChild(st);
          body.appendChild(srow);
        });
      });
    },

    // "Sort by show": one top row per show; expanding lists the pipeline tasks
    // once, each line holding a bar per episode. Bars that would overlap in
    // time spill onto continuation rows (↳) stacked beneath.
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

      App.pipelineFor(eps[0]).forEach(t => {
        const items = [];
        eps.forEach(ep => {
          const su = App.subsView(ep).find(x => x.key === t.key);
          if (su) items.push({ ep, su });
        });
        if (!items.length) return;

        // interval stacking: same line while bars don't overlap, else new level
        items.sort((a, b) => a.su.start < b.su.start ? -1 : 1);
        const levels = [];
        items.forEach(it => {
          const lvl = levels.find(l => it.su.start > l.lastDue);
          if (lvl) { lvl.lastDue = it.su.due; lvl.items.push(it); }
          else levels.push({ lastDue: it.su.due, items: [it] });
        });

        // a faint wash of the department's own colour, layered over the usual
        // dark sub-row base — adjacent same-dept rows blend into one band, and
        // the hue shift at a department change reads as a soft divider
        const dep = App.dept(t.dept);
        const [dr, dg, db] = hexToRgb(dep.color);
        const deptWash = 'linear-gradient(rgba(' + dr + ',' + dg + ',' + db + ',.07), rgba(' + dr + ',' + dg + ',' + db + ',.07)), rgba(0,0,0,.16)';
        levels.forEach((lvl, li) => {
          const srow = el('.g-row.sub', { style: { background: deptWash } });
          srow.appendChild(el('.g-label', { title: dep.label + ' — ' + t.name, style: { background: deptLabelBg(dep.color) } }, [
            el('.l-title', { style: { fontWeight: '600', fontSize: '10.5px' } }, li === 0 ? [
              el('span.dot', { style: { background: dep.color, width: '7px', height: '7px', borderRadius: '50%', flex: 'none' } }),
              el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, t.name),
              el('span', { style: { color: 'var(--text-3)', fontWeight: '500', fontSize: '9px', marginLeft: 'auto', paddingLeft: '6px', flex: 'none' } }, dep.label)
            ] : [
              el('span', { style: { color: 'var(--text-3)', paddingLeft: '13px' } }, '↳')
            ])
          ]));

          const st = el('.g-track');
          lvl.items.forEach(({ ep, su }) => {
            const sl = xOf(su.start), sw = xOf.width(su.start, su.due);
            const done = su.status === 'approved';
            const sbar = el('.bar' + (done ? '.delivered' : ''), {
              title: ep.code + ' · ' + su.name + ' — ' + App.status(su.status).label + ' · ' + App.fmtRange(su.start, su.due),
              style: { left: sl + 'px', width: sw + 'px', background: dep.color, color: pickInk(dep.color) }
            }, [
              el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, ep.code),
              (App.isRiskBlocked(ep, su.key) ? el('span.blk', { title: 'In progress while a dependency is unapproved' }, '⛔') : null)
            ]);
            sbar.dataset.episodeId = ep.id;                 // per-bar identity: one line holds many episodes
            sbar.dataset.suKey = su.key;
            attachBar(sbar, { color: App.status(su.status).color, label: App.status(su.status).label });
            st.appendChild(sbar);
          });
          srow.appendChild(st);
          body.appendChild(srow);
        });
      });
    },

    afterMount() {
      const scroll = this._scrollEl;
      if (!scroll) return;

      // Measure the sticky time-head height and expose it as a CSS variable so
      // lane-head sticky top aligns flush beneath it (avoids a hardcoded px value).
      const head = scroll.querySelector('.time-head');
      if (head) {
        scroll.style.setProperty('--gantt-head-h', head.offsetHeight + 'px');
        // latch scrolling pins episode rows one slot lower: under the lane band
        const lane = scroll.querySelector('.lane-head');
        scroll.style.setProperty('--latch-top', (head.offsetHeight + (lane ? lane.offsetHeight : 0)) + 'px');
      }

      // Restore synchronously — the element is already in the DOM, so setting
      // scrollLeft/Top here paints the first frame in the right place. Waiting
      // a frame (rAF) shows one frame at position 0 and reads as a jump.
      const st = App.state.gantt || {};
      if (this._preserve) {                                    // zoom — keep the anchored date under the cursor
        scroll.scrollLeft = this._preserve.dayOffset * App.state.zoom + LABEL_W - this._preserve.screenX;
        scroll.scrollTop = st.scrollTop || 0;
        this._preserve = null;
      } else if (this._wantCenter) {                           // first load — centre on today
        const t = scroll.querySelector('.today-line');
        if (t) scroll.scrollLeft = Math.max(0, parseFloat(t.style.left) - scroll.clientWidth * 0.38);
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
      if (s) { const sx = s.clientWidth / 2; this._preserve = { dayOffset: (s.scrollLeft + sx - LABEL_W) / old, screenX: sx }; }
      App.state.zoom = clampZoom(old * f);
      App.render();
    },

    // Deliberate navigation is the ONE place smooth scrolling belongs — scroll
    // in place with no re-render, so nothing else on the page can shift.
    centerToday() {
      const s = this._scrollEl;
      if (!s) { this._wantCenter = true; App.render(); return; }
      const t = s.querySelector('.today-line');
      if (t) s.scrollTo({ left: Math.max(0, parseFloat(t.style.left) - s.clientWidth * 0.38), behavior: 'smooth' });
    }
  };

  function attachBar(bar, st) {
    bar.appendChild(el('span.bar-dot', { style: { background: st.color } }));
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
  const SUB_LABEL_BASE = hexToRgb('#1e212a');   // matches --surface-2
  function deptLabelBg(deptHex) {
    const [dr, dg, db] = hexToRgb(deptHex);
    const t = 0.16;
    const mix = (b, d) => Math.round(b * (1 - t) + d * t);
    return 'rgb(' + mix(SUB_LABEL_BASE[0], dr) + ',' + mix(SUB_LABEL_BASE[1], dg) + ',' + mix(SUB_LABEL_BASE[2], db) + ')';
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
