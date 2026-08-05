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
      this._startIso = startIso;

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

      // Producer Notes swimlane — per-show annotations, only meaningful when a
      // single show is in view (nonsensical mixed across shows on "All shows").
      if (App.state.filters.show !== 'all') this.producerNotesLane(body, App.state.filters.show, startIso, dw, xOf);

      // Rows / bars / sub-bars are three chosen dimensions — see App.timelineAxes
      this.pivot(body, episodes, App.timelineAxes(), xOf, dw);

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
        const noteEl = e.target.closest('.pn-note.editable');
        if (noteEl) {
          if (this._hoverBar && this._hoverBar !== noteEl) { this._hoverBar.style.cursor = ''; this._hoverBar.classList.remove('adjustable'); }
          this._hoverBar = noteEl;
          noteEl.classList.add('adjustable');
          noteEl.style.cursor = this.dragZone(noteEl, e.clientX) === 'move' ? 'grab' : 'ew-resize';
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
        bar.style.cursor = this.dragZone(bar, e.clientX) === 'move' ? 'grab' : 'ew-resize';
      };
      scroll.addEventListener('mousemove', hoverHandler);

      const downHandler = (e) => {
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
          const zone = this.dragZone(noteEl, e.clientX);
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
        if (!bar) return;
        const row = bar.closest('.g-row.sub');
        if (!row || row.classList.contains('phase')) return;
        const epId = bar.dataset.episodeId || row.dataset.episodeId;
        const suKey = bar.dataset.suKey || row.dataset.suKey;
        if (!epId || !suKey) return;
        const ep = App.state.data.episodes.find(x => x.id === epId);
        const su = ep && App.subitem(ep, suKey);
        if (!su || !App.canEditSchedule(App.state.role)) return;   // a plain click still opens the dialog, which explains the lock

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

      if (d.kind === 'note-draw') {
        const cur = d.startCol + Math.round((e.clientX - d.startClientX) / dw);
        const a = Math.max(0, Math.min(d.startCol, cur)), b = Math.max(0, Math.max(d.startCol, cur));
        d.curA = a; d.curB = b;
        if (Math.abs(e.clientX - d.startClientX) > 4) d.moved = true;
        d.ghost.style.left = (a * dw) + 'px';
        d.ghost.style.width = ((b - a + 1) * dw) + 'px';
        const sIso = App.addVisibleDays(this._startIso, a, hw), dIso = App.addVisibleDays(this._startIso, b, hw);
        const tip = dragTipEl(); tip.innerHTML = '';
        tip.appendChild(el('span.tip-dot', { style: { background: '#5b6cff' } }));
        tip.appendChild(document.createTextNode(App.fmtRange(sIso, dIso)));
        tip.style.display = 'flex'; tip.style.left = e.clientX + 'px'; tip.style.top = (e.clientY - 38) + 'px';
        return;
      }

      if (d.kind === 'note') {
        if (Math.abs(e.clientX - d.startClientX) > 3) d.moved = true;
        let ns = d.origStart, nd = d.origDue;
        if (d.zone === 'move') { ns = App.addVisibleDays(d.origStart, colDelta, hw); nd = App.addVisibleDays(d.origDue, colDelta, hw); }
        else if (d.zone === 'resize-left') { ns = App.addVisibleDays(d.origStart, colDelta, hw); if (ns > nd) ns = nd; }
        else { nd = App.addVisibleDays(d.origDue, colDelta, hw); if (nd < ns) nd = ns; }
        d.curStart = ns; d.curDue = nd;
        d.el.style.left = xOf(ns) + 'px';
        d.el.style.width = xOf.width(ns, nd) + 'px';
        const tip = dragTipEl(); tip.innerHTML = '';
        tip.appendChild(el('span.tip-dot', { style: { background: '#5fb0f0' } }));
        tip.appendChild(document.createTextNode(App.fmtRange(ns, nd)));
        tip.style.display = 'flex'; tip.style.left = e.clientX + 'px'; tip.style.top = (e.clientY - 38) + 'px';
        return;
      }

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

      if (d.kind === 'note') {
        d.el.classList.remove('dragging');
        if (d.moved && (d.curStart !== d.origStart || d.curDue !== d.origDue)) {
          App.updateNote(d.showId, d.id, { start: d.curStart, due: d.curDue });
        } else {
          this.openNoteEditor(d.el);   // a click (no move) opens the editor
        }
        return;
      }

      d.bar.classList.remove('dragging', 'warn');
      if (d.curStart !== d.origStart || d.curDue !== d.origDue) {
        App.track.feature('timeline.dragReschedule');
        App.moveTask(d.epId, d.suKey, d.curStart, d.curDue);
      }
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
      }, (() => {                        // corner names the pivot, e.g. "SHOW / EPISODE"
        const a = App.timelineAxes();
        return (App.TL_DIMS[a.rows].label + ' / ' + App.TL_DIMS[a.sub].label).toUpperCase();
      })()));
      const cols = el('', { style: { width: (ctx.totalCols * ctx.dw) + 'px' } });
      cols.appendChild(buildSegRow(ctx, tier.primary, 'primary'));
      cols.appendChild(buildSegRow(ctx, tier.secondary, 'secondary'));
      row.appendChild(cols);
      head.appendChild(row);
      return head;
    },

    // draw one real task bar into a track (single-cell pivot groups)
    taskBar(track, ep, su, dep, xOf, dw, labelText) {
      const sl = xOf(su.start), sw = xOf.width(su.start, su.due);
      const done = su.status === 'approved';
      const sbar = el('.bar' + (done ? '.delivered' : ''), {
        title: (labelText ? labelText + ' — ' : '') + su.name + ' — ' + App.status(su.status).label + ' · ' + App.fmtRange(su.start, su.due),
        style: { left: sl + 'px', width: sw + 'px', background: dep.color, color: pickInk(dep.color) }
      }, [
        el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, labelText || su.name),
        (App.isRiskBlocked(ep, su.key) ? App.icon('blocked', { cls: 'blk', title: 'In progress while a dependency is unapproved' }) : null)
      ]);
      sbar.dataset.episodeId = ep.id;
      sbar.dataset.suKey = su.key;
      attachBar(sbar, { color: App.status(su.status).color, label: App.status(su.status).label });
      track.appendChild(sbar);
      return sbar;
    },

    /* ---- pivot engine ----
       Every visible {episode, subitem} pair is a "cell". Rows group cells by
       the row dimension; inside a row, bars group its cells by the bar
       dimension (each bar spanning its members' earliest start → latest due);
       expanding splits the row by the sub dimension. A dimension is just a way
       to key/name/colour a cell, so all combinations share one code path
       instead of a hand-written case per pairing. */

    // key / name / colour a cell under one dimension
    dimOf(dim, c) {
      if (dim === 'show') return { key: c.show.id, name: c.show.name, color: c.show.color, kind: 'show' };
      if (dim === 'episode') return { key: c.ep.id, name: c.ep.code, note: c.ep.title, color: c.show.color, kind: 'episode' };
      if (dim === 'department') { const d = App.dept(c.su.dept); return { key: c.su.dept, name: d.label, color: d.color, kind: 'department' }; }
      const d = App.dept(c.su.dept);
      return { key: c.su.key, name: c.su.name, color: d.color, kind: 'task' };
    },

    buildCells(episodes) {
      const cells = [];
      episodes.forEach(ep => {
        const show = App.show(ep.showId);
        App.subsView(ep).forEach(su => cells.push({ ep, su, show }));
      });
      return cells;
    },

    // group cells by a dimension, keeping first-appearance order and recording
    // each group's span plus how much of it is approved (for the % overlay)
    groupCells(cells, dim) {
      const map = new Map();
      cells.forEach(c => {
        const d = this.dimOf(dim, c);
        let g = map.get(d.key);
        if (!g) { g = Object.assign({}, d, { cells: [], start: c.su.start, due: c.su.due, done: 0 }); map.set(d.key, g); }
        g.cells.push(c);
        if (c.su.start < g.start) g.start = c.su.start;
        if (c.su.due > g.due) g.due = c.su.due;
        if (c.su.status === 'approved') g.done++;
      });
      return [...map.values()].sort((a, b) => a.start < b.start ? -1 : (a.start > b.start ? 1 : 0));
    },

    // interval-stack groups so non-overlapping ones share a visual line
    stackGroups(groups) {
      const levels = [];
      groups.forEach(g => {
        const l = levels.find(x => g.start > x.lastDue);
        if (l) { l.lastDue = g.due; l.groups.push(g); }
        else levels.push({ lastDue: g.due, groups: [g] });
      });
      return levels;
    },

    /* One bar for a group. A single-cell group is a real task, so it keeps the
       task-bar behaviour (status colour dot, click-to-edit, drag-to-reschedule);
       an aggregate gets a % complete overlay instead. */
    pivotBar(track, g, xOf, dw, isSub) {
      if (g.cells.length === 1 && (g.kind === 'task' || isSub)) {
        const c = g.cells[0];
        return this.taskBar(track, c.ep, c.su, App.dept(c.su.dept), xOf, dw, g.name);
      }
      const pct = Math.round(100 * g.done / g.cells.length);
      const delivered = pct === 100;
      const bar = el('.bar' + (delivered ? '.delivered' : ''), {
        title: g.name + ' — ' + g.cells.length + ' task' + (g.cells.length === 1 ? '' : 's') +
               ' · ' + pct + '% · ' + App.fmtRange(g.start, g.due),
        style: {
          left: xOf(g.start) + 'px', width: xOf.width(g.start, g.due) + 'px',
          background: 'linear-gradient(90deg,' + g.color + ',' + shade(g.color, -16) + ')',
          color: pickInk(g.color)
        }
      }, [el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, g.name)]);
      if (!delivered && pct > 0) {
        bar.appendChild(el('', { style: {
          position: 'absolute', left: '0', top: '0', bottom: '0', width: pct + '%',
          background: 'rgba(255,255,255,.22)', borderRadius: '6px', pointerEvents: 'none'
        } }));
      }
      attachBar(bar, delivered ? { color: '#00c875', label: 'Delivered' } : { color: '#fdab3d', label: pct + '% complete' });
      track.appendChild(bar);
      return bar;
    },

    /* One bar per actual task instance, for the expanded lines. Labelled by
       whichever dimension the line itself isn't — a task line shows episode
       codes; an episode or department line shows task names — and kept as
       single-cell groups so pivotBar routes them through taskBar (clickable,
       draggable). */
    cellGroups(cells, subDim) {
      const labelDim = subDim === 'task' ? 'episode' : 'task';
      return cells.map(c => ({
        key: c.ep.id + '::' + c.su.key,
        name: this.dimOf(labelDim, c).name,
        color: App.dept(c.su.dept).color,
        kind: 'cell', cells: [c],
        start: c.su.start, due: c.su.due,
        done: c.su.status === 'approved' ? 1 : 0
      })).sort((a, b) => a.start < b.start ? -1 : (a.start > b.start ? 1 : 0));
    },

    /* Lines for a set of groups. `opts.deptLines` keeps each department on its
       own line instead of packing bars purely by time — otherwise one
       department's tasks scatter across whichever line had a free slot, which
       makes a single department impossible to follow across the row. Only if a
       department overlaps itself does it take a second line. */
    pivotLines(body, groups, xOf, dw, opts) {
      let levels;
      if (opts.deptLines) {
        const order = [], byDept = new Map();
        groups.forEach(g => {
          const dk = g.cells[0].su.dept;
          if (!byDept.has(dk)) { byDept.set(dk, []); order.push(dk); }
          byDept.get(dk).push(g);
        });
        levels = [];
        order.forEach(dk => this.stackGroups(byDept.get(dk)).forEach(l => levels.push(Object.assign(l, { dept: dk }))));
      } else {
        levels = this.stackGroups(groups);
      }

      levels.forEach((lvl, li) => {
        const dep = lvl.dept ? App.dept(lvl.dept) : null;
        const row = el('.g-row' + (opts.sub ? '.sub' : ''), {
          style: dep ? { background: deptWash(dep.color) } : (opts.rowStyle || null)
        });
        if (opts.expKey && li === 0) row.dataset.episodeId = opts.expKey;
        // the row's own label on the first line; every dept line is also tagged
        // with its department, since that's what the line now represents
        const kids = li === 0 ? opts.label(dep) : (dep ? el('.l-title', { style: { fontWeight: '600', fontSize: '10.5px' } }, [
          el('span.dot', { style: { background: dep.color, width: '7px', height: '7px', borderRadius: '50%', flex: 'none' } }),
          el('span', { style: { color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis' } }, dep.label)
        ]) : el('.l-title', null, []));
        row.appendChild(el('.g-label', {
          title: li === 0 ? opts.title : (dep ? dep.label : null),
          style: dep ? { background: deptLabelBg(dep.color) } : (opts.labelStyle || null)
        }, kids));
        const track = el('.g-track');
        lvl.groups.forEach(g => this.pivotBar(track, g, xOf, dw, opts.sub));
        row.appendChild(track);
        body.appendChild(row);
      });
    },

    pivot(body, episodes, axes, xOf, dw) {
      const cells = this.buildCells(episodes);
      this.groupCells(cells, axes.rows).forEach(rg => {
        const expKey = 'pv:' + axes.rows + ':' + rg.key;
        const expanded = !!App.state.ganttExpanded[expKey];
        const pct = Math.round(100 * rg.done / rg.cells.length);

        // the row's bar IS the row's own span — [rg] is a single group, so this
        // is always one line with one summary bar
        const count = axes.rows === 'show'
          ? new Set(rg.cells.map(c => c.ep.id)).size + ' episode' + (new Set(rg.cells.map(c => c.ep.id)).size === 1 ? '' : 's')
          : rg.cells.length + ' task' + (rg.cells.length === 1 ? '' : 's');
        this.pivotLines(body, [rg], xOf, dw, {
          expKey,
          title: rg.name + ' — ' + pct + '% complete',
          label: () => [
            el('.l-title', null, [
              el('span.chev' + (expanded ? '.open' : ''), null, '▶'),
              el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, rg.name)
            ]),
            el('.l-sub', null, [
              el('span.code', null, rg.note || count),
              el('span', null, '· ' + App.fmtRange(rg.start, rg.due))
            ])
          ]
        });
        if (!expanded) return;

        // expanded: split the row by the sub dimension, one entry per line, with
        // each department kept to its own line (see pivotLines deptLines)
        this.groupCells(rg.cells, axes.sub).forEach(sg => {
          this.pivotLines(body, this.cellGroups(sg.cells, axes.sub), xOf, dw, {
            sub: true, deptLines: true,
            title: sg.name,
            // the trailing department tag is dropped when the line already IS a
            // department, which would otherwise print the same name twice
            label: (dep) => el('.l-title', { style: { fontWeight: '600', fontSize: '10.5px' } }, [
              (dep ? el('span.dot', { style: { background: dep.color, width: '7px', height: '7px', borderRadius: '50%', flex: 'none' } }) : null),
              el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, sg.name),
              (dep && axes.sub !== 'department' ? el('span', { style: { color: 'var(--text-3)', fontWeight: '500', fontSize: '9px', marginLeft: 'auto', paddingLeft: '6px', flex: 'none' } }, dep.label) : null)
            ])
          });
        });
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
        kind: 'note-draw', showId: App.state.filters.show, ghost,
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
  // A faint wash of the department's own colour over the dark sub-row base:
  // adjacent same-dept rows blend into one band, and the hue shift where the
  // department changes reads as a soft divider without drawing a line.
  function deptWash(deptHex) {
    const [r, g, b] = hexToRgb(deptHex);
    return 'linear-gradient(rgba(' + r + ',' + g + ',' + b + ',.07), rgba(' + r + ',' + g + ',' + b + ',.07)), rgba(0,0,0,.16)';
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
