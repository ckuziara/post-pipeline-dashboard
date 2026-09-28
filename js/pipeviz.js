/* Pipeline preview — one episode drawn start to finish, beside the task list
   in Add Show so a producer sees the shape of the pipeline while building it.

   Rows are departments (in App.DEPARTMENTS order). Each task is a pill
   spanning its scheduled first pass; its revision budget follows as dashed
   V2, V3… bars, back to back. Time reads in weeks from the episode's start, not calendar
   dates — this is the shape of the pipeline, not a schedule. Dependencies
   aren't drawn; hovering a task lights what it waits for and what waits for it.

   The dates come from App.schedulePipeline, the same forward pass that
   schedules the real show, so what's drawn is what gets created. That pass
   plans the worst case: every task spends its whole revision budget, and
   whatever depends on it waits for the last revision.

   Tasks in one department that overlap in time stack into sub-rows rather than
   drawing over each other. The whole thing is rebuilt on every render: a
   pipeline is a few dozen tasks at most, and rebuilding keeps it impossible for
   the picture to drift from the list. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  const LABEL_W = 132;     // department rail
  const ROW_H = 26;        // one sub-row of bars
  const BAR_H = 12;        // the main timeline's task-bar height (.g-row.sub .bar)
  const AXIS_H = 26;
  const PAD_DAYS = 3;      // breathing room past the last thing drawn
  // zoom works like the Timeline's: continuous px per day, ×1.25 a step,
  // Ctrl+scroll / pinch on the chart anchored under the pointer, ⌘+ / ⌘−
  const ZOOM_MIN = 1.5, ZOOM_MAX = 60, ZOOM_STEP = 1.25;

  App.pipelineViz = function (opts) {
    const onSelect = (opts && opts.onSelect) || function () {};
    /* Editing from the timeline goes back through the owner — `update(key, fn)`
       applies fn to the task as one undo step and re-renders both halves, and
       the right-click windows use the hooks below. Without `update` the
       timeline is read-only. */
    const update = opts && opts.update;
    const depTags = opts && opts.depTags;           // (key, after) -> the task row's dependency chips
    const setBatch = opts && opts.setBatch;         // (key, cfg | null)
    const previewBatch = opts && opts.previewBatch; // (key, cfg) -> [{ ep, name, day, group }]
    let selected = null, hovered = null;
    let last = null;                        // the args of the last render, for re-zooming
    let zoom = null;                        // px per day; null = fit to width

    const canvas = el('.pv-canvas');
    const scroller = el('.pv-scroll', null, canvas);
    const summary = el('.pv-summary');
    const zoomOut = el('button.btn-icon.pv-zoom-btn', { type: 'button', title: 'Zoom out (' + App.shortcutLabel('−') + ', or Ctrl+scroll on the chart)', onclick: () => zoomBy(1 / ZOOM_STEP) }, '−');
    const zoomIn = el('button.btn-icon.pv-zoom-btn', { type: 'button', title: 'Zoom in (' + App.shortcutLabel('+') + ', or Ctrl+scroll on the chart)', onclick: () => zoomBy(ZOOM_STEP) }, '＋');
    const fitBtn = el('button.btn-icon.pv-zoom-btn.pv-fit', { type: 'button', title: 'Fit the episode to the panel', onclick: () => { zoom = null; repaint(); } }, 'Fit');
    const root = el('.pv', null, [
      el('.pv-head', null, [
        el('.pv-title-wrap', null, [
          el('.pv-title', null, 'Episode preview'),
          summary
        ]),
        el('.pv-zoom', null, [zoomOut, fitBtn, zoomIn])
      ]),
      scroller,
      el('.pv-legend', null, [
        el('span.pv-lg', null, [el('span.pv-lg-pill'), 'First pass']),
        el('span.pv-lg', null, [el('span.pv-lg-pill.rev'), 'Revision (planned)']),
                el('span.pv-lg', null, [el('span.pv-lg-line'), 'Delivery / Live'])
      ])
    ]);

    // a fitted zoom has to be recomputed whenever the panel changes width
    if (window.ResizeObserver) new ResizeObserver(() => { if (zoom === null && last) repaint(); }).observe(scroller);

    function fitPx(totalDays) {
      const w = scroller.clientWidth - LABEL_W - 12;
      if (w <= 0) return 8;
      return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, w / totalDays));
    }
    /* Zoom by a factor, keeping the day under `anchorX` (px from the
       scroller's left edge; default its middle) where it is on screen. */
    function zoomBy(f, anchorX) {
      if (!last) return;
      const old = currentPx, nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, old * f));
      if (Math.abs(nz - old) < 0.001) return;
      const sx = anchorX == null ? scroller.clientWidth / 2 : anchorX;
      const day = (scroller.scrollLeft + sx - LABEL_W) / old;
      zoom = nz;
      repaint();
      scroller.scrollLeft = Math.max(0, day * currentPx + LABEL_W - sx);
    }
    let currentPx = 8;
    scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;                  // pinch arrives as ctrl+wheel too
      e.preventDefault();
      const f = App.wheelZoomFactor ? App.wheelZoomFactor(e) : (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
      zoomBy(f, e.clientX - scroller.getBoundingClientRect().left);
    }, { passive: false });
    // ⌘+ / ⌘− while this preview is on screen (the Timeline's own shortcut
    // stands down whenever a dialog is open)
    const onKey = (e) => {
      if (!root.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (!root.offsetParent || !(App.isMac ? e.metaKey : e.ctrlKey) || e.altKey) return;
      if (App.exporter && App.exporter._ov) return;
      const k = e.key.toLowerCase();
      const zin = k === '=' || k === '+' || e.code === 'NumpadAdd';
      const zout = k === '-' || k === '_' || e.code === 'NumpadSubtract';
      if (!zin && !zout) return;
      e.preventDefault();
      zoomBy(zin ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    document.addEventListener('keydown', onKey);

    /* ---- layout ----
       Everything is laid out in days from the episode's start, then turned
       into pixels once the zoom is known. */
    function layout(pipe, startIso, scale, opts) {
      // working days & holidays (opts.cal) and episode 1's owners, if known
      const cal = (opts && opts.cal) || null;
      const assignees = (opts && opts.assigneesFor && opts.assigneesFor(0)) || {};
      // the scheduler plans the worst case: dependents wait out every revision
      const sch = App.schedulePipeline(pipe, startIso, scale, { cal, assignees });
      if (!sch) return null;
      const items = pipe.map(t => {
        const d = sch.dates[t.key];
        const s = App.diffDays(d.start, startIso), e = App.diffDays(d.due, startIso) + 1;   // e exclusive
        // versions run back to back (the scheduler's own revision steps, so
        // working days and holidays land exactly as they will on the real show)
        const segs = [{ s, e, label: t.maxRev ? 'V1' : '' }];
        const off = (iso) => App.diffDays(iso, startIso);
        const steps = App.revisionSteps(t, d.due, cal, { dept: t.dept, person: assignees[t.key] || null }, 0);
        steps.revs.forEach(rv => segs.push({ s: off(rv.start), e: off(rv.due) + 1, label: rv.label, rev: true }));
        const at = off(steps.end) + 1;
        return { t, s, e, end: Math.max(at, e), segs, start: d.start, due: d.due };
      });

      /* Department lanes, each packed greedily into sub-rows: a task takes the
         first sub-row whose last occupant has finished (revisions included,
         so a V2 never sits under the next task's pill). */
      const lanes = [];
      Object.keys(App.DEPARTMENTS).concat(
        // a department a preset uses but this studio has since removed still
        // needs a lane, or its tasks would vanish from the picture
        [...new Set(pipe.map(t => t.dept))].filter(k => !App.DEPARTMENTS[k])
      ).forEach(dk => {
        const mine = items.filter(it => it.t.dept === dk).sort((a, b) => a.s - b.s || a.e - b.e);
        if (!mine.length) return;
        const rows = [];
        mine.forEach(it => {
          let r = rows.findIndex(endAt => endAt <= it.s);
          if (r < 0) { r = rows.length; rows.push(0); }
          rows[r] = it.end;
          it.sub = r;
        });
        lanes.push({ dept: dk, items: mine, rows: rows.length });
      });

      // milestones hang off QC, the way the real episode's do
      const anchor = App.diffDays(sch.done.qc || sch.end, startIso) + 1;   // after QC’s last revision
      const milestones = (App.MILESTONES || []).map(m => ({ name: m.short || m.name, day: anchor + (m.afterQc || 0) }));

      const workEnd = App.diffDays(sch.end, startIso) + 1;
      const drawEnd = Math.max(workEnd, ...items.map(it => it.end), ...milestones.map(m => m.day + 1));
      /* Days off to paint red: a whole-production day (national holiday or
         production time off) runs through every lane; a department's own time
         off only through its lane. Weekends are simply skipped, not painted. */
      const offDays = [];
      if (cal) {
        const total = drawEnd + PAD_DAYS;
        for (let d = 0; d < total; d++) {
          const iso = App.shiftIso(startIso, d);
          if (cal.weekend(iso)) continue;
          const nat = cal.national(iso);
          const prod = cal.cal.offDays.find(o => o.scope === 'show' && iso >= o.start && iso <= o.end);
          if (nat || prod) {
            offDays.push({ day: d, prod: true, label: nat ? nat + ' — national holiday, whole production off' : (prod.label || 'Time off') + ' — whole production off' });
            continue;
          }
          lanes.forEach(lane => {
            const o = cal.cal.offDays.find(x => iso >= x.start && iso <= x.end &&
              ((x.scope === 'dept' && x.target === lane.dept) || (x.scope === 'role' && x.target === lane.dept)));
            if (o) offDays.push({ day: d, dept: lane.dept, label: (o.label || 'Time off') + ' — ' + App.dept(lane.dept).label + ' off' });
          });
        }
      }
      return { items, lanes, milestones, workEnd, offDays, totalDays: drawEnd + PAD_DAYS };
    }

    function render(pipe, startIso, scale, opts) {
      last = { pipe, startIso, scale, opts };
      repaint();
    }

    function repaint() {
      if (!last) return;
      const { pipe, startIso, scale, opts } = last;
      canvas.innerHTML = '';
      if (!pipe.length) { summary.textContent = ''; canvas.appendChild(el('.pv-empty', null, 'Add a task to see the episode take shape.')); return; }
      const L = layout(pipe, startIso, scale, opts);
      if (!L) {
        summary.textContent = '';
        canvas.appendChild(el('.pv-empty.bad', null, [App.icon('warn'), ' The dependencies loop back on themselves — nothing can start.']));
        return;
      }
      const px = zoom === null ? fitPx(L.totalDays) : zoom;
      currentPx = px;
      zoomOut.disabled = px <= ZOOM_MIN + 0.001;
      zoomIn.disabled = px >= ZOOM_MAX - 0.001;
      fitBtn.classList.toggle('active', zoom === null);

      const live = L.milestones[L.milestones.length - 1];
      const weeksOf = (days) => Math.ceil(days / 7);
      summary.textContent = weeksOf(L.workEnd) + ' weeks of work (' + L.workEnd + ' days)' +
        (live ? ' · ' + live.name + ' in week ' + weeksOf(live.day + 1) : '');

      const X = (day) => LABEL_W + day * px;
      const width = X(L.totalDays);

      // vertical positions: axis, then each department's sub-rows
      let y = AXIS_H;
      L.lanes.forEach(lane => { lane.y = y; lane.h = lane.rows * ROW_H + 8; y += lane.h; });
      const height = y;
      L.lanes.forEach(lane => lane.items.forEach(it => { it.lane = lane; }));

      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';

      // ---- grid: week ticks, labelled Week 1, 2… — no calendar dates ----
      // label every week, or every other one when a week is too narrow for it
      const labelWeeks = [1, 2, 4, 8].find(n => n * 7 * px >= 56) || 8;
      /* Zoomed in far enough, each day gets a line and its weekday initial
         under the week label — still no dates. Days the show doesn't work
         (its calendar's weekends) are the faded ones. */
      const showDays = px >= 16;
      canvas.classList.toggle('days', showDays);
      if (showDays) {
        const dow0 = App.parseDate(startIso).getDay();
        const cal = opts && opts.cal;
        for (let d = 0; d < L.totalDays; d++) {
          const dow = (dow0 + d) % 7;
          if (d % 7) canvas.appendChild(el('.pv-tick', { style: { left: X(d) + 'px', height: height + 'px' } }));
          // no calendar means every day is a working day (weekends included)
          const off = cal ? cal.weekend(App.shiftIso(startIso, d)) : false;
          canvas.appendChild(el('.pv-day-lbl' + (off ? '.off' : ''), { style: { left: X(d) + 'px', width: px + 'px' } }, 'SMTWTFS'[dow]));
        }
      }
      for (let d = 0; d < L.totalDays; d += 7) {
        const week = d / 7;
        canvas.appendChild(el('.pv-tick.major', { style: { left: X(d) + 'px', height: height + 'px' } }));
        if (week % labelWeeks === 0) {
          canvas.appendChild(el('.pv-tick-lbl', { style: { left: (X(d) + 3) + 'px' } }, 'Week ' + (week + 1)));
        }
      }

      // ---- lane rails ----
      L.lanes.forEach(lane => {
        const dep = App.dept(lane.dept);
        canvas.appendChild(el('.pv-lane', { style: { top: lane.y + 'px', height: lane.h + 'px', width: width + 'px' } },
          el('.pv-lane-lbl', null, [el('span.dot', { style: { background: dep.color } }), dep.label])));
      });

      // ---- days off, in red ----
      L.offDays.forEach(od => {
        const lane = od.dept && L.lanes.find(l => l.dept === od.dept);
        const top = od.prod ? AXIS_H : lane.y, h = od.prod ? height - AXIS_H : lane.h;
        canvas.appendChild(el('.pv-off' + (od.prod ? '.prod' : ''), {
          title: od.label, style: { left: X(od.day) + 'px', width: px + 'px', top: top + 'px', height: h + 'px' }
        }));
      });

      // ---- milestones ----
      L.milestones.forEach(m => {
        canvas.appendChild(el('.pv-ms', { style: { left: X(m.day) + 'px', top: AXIS_H + 'px', height: (height - AXIS_H) + 'px' } }));
        canvas.appendChild(el('.pv-ms-lbl', { style: { left: X(m.day) + 'px', top: (AXIS_H + 2) + 'px' } }, m.name));
      });

      const byKey = {}; L.items.forEach(it => { byKey[it.t.key] = it; });

      // ---- bars ----
      // "Week 2" or "Weeks 2–3", from day offsets (e exclusive)
      const span = (s0, e0) => {
        const a = Math.floor(s0 / 7) + 1, b = Math.floor((e0 - 1) / 7) + 1;
        return a === b ? 'Week ' + a : 'Weeks ' + a + '–' + b;
      };
      L.items.forEach(it => {
        const dep = App.dept(it.t.dept);
        // the timeline's own ink rule, so a bar reads the same in both places
        const ink = App.pickInk ? App.pickInk(dep.color) : '#fff';
        const top = it.lane.y + 4 + it.sub * ROW_H + (ROW_H - BAR_H) / 2;
        /* Zoomed out, a task's passes (V1 · V2 · V3, back to back)
           shrink to slivers that overlap. Then they're drawn as one bar with a
           line between each pass: the first pass solid, revisions striped,
           the right edge still stretching the last one. */
        const segW = (sg) => (sg.e - sg.s) * px - 2;
        let merged = false;
        if (it.segs.length > 1 && it.segs.some((sg, i) => segW(sg) < 16 || (i && (sg.s - it.segs[i - 1].e) * px < 5))) {
          const s0 = it.segs[0].s, e0 = it.segs[it.segs.length - 1].e, total = e0 - s0;
          const w = Math.max(4, total * px - 2);
          const name = it.t.name || 'Untitled';
          const lastSi = it.segs.length - 1;
          const batch = !!App.batchCfg(it.t);
          const pill = el('button.pv-pill.combo' + (batch ? '.batch' : ''), {
            type: 'button', 'data-key': it.t.key,
            title: name + ' — ' + dep.label + '\n' + span(it.s, it.e) + '\n' +
              it.segs.map(sg => (sg.label || 'First pass') + ': ' + (sg.e - sg.s) + ' day' + (sg.e - sg.s === 1 ? '' : 's') + (sg.rev ? ' (planned)' : '')).join(' · '),
            style: { left: (X(s0) + 1) + 'px', top: top + 'px', width: w + 'px', height: BAR_H + 'px', color: ink },
            onclick: () => { if (!justDragged) onSelect(it.t.key); },
            oncontextmenu: (e) => openMenu(e, it.t.key),
            onmouseenter: () => { hovered = it.t.key; applyFocus(); },
            onmouseleave: () => { if (hovered === it.t.key) { hovered = null; applyFocus(); } }
          });
          it.segs.forEach((sg, i) => {
            // each pass runs on to where the next begins, so the bar is continuous
            const a = (sg.s - s0) / total * 100, z = ((i < lastSi ? it.segs[i + 1].s : e0) - s0) / total * 100;
            pill.appendChild(el('span.pv-part' + (sg.rev ? '.rev' : '') + (i ? '.div' : ''), { style: { left: a + '%', width: (z - a) + '%' } }));
          });
          if (batch) pill.appendChild(el('span.pv-batch-tag', null, 'BATCH'));
          if (w > 24) pill.appendChild(el('span.pv-pill-txt', null, name));
          pill.style.setProperty('--pv-c', dep.color);
          if (update) {
            pill.classList.add('editable');
            if (drag && drag.t.key === it.t.key) pill.classList.add('dragging');
            pill.appendChild(el('span.pv-grip', { onpointerdown: (e) => beginResize(e, it.t, lastSi) }));
          }
          canvas.appendChild(pill);
          merged = true;                 // drawn — skip the per-pass bars below
        }
        if (!merged) it.segs.forEach((sg, si) => {
          const w = Math.max(4, (sg.e - sg.s) * px - 2);
          const days = sg.e - sg.s;
          const name = it.t.name || 'Untitled';
          // the first pass carries the task's name; a revision only its version
          const text = si === 0 ? (it.t.maxRev ? name + ' · V1' : name) : sg.label;
          const batch = si === 0 && !!App.batchCfg(it.t);
          const tip = si === 0
            ? name + ' — ' + dep.label + '\n' + span(it.s, it.e) + ' · ' + days + ' day' + (days === 1 ? '' : 's') +
              (it.t.deps.length ? '\nWaits for ' + it.t.deps.map(k => byKey[k] ? byKey[k].t.name : k).join(', ') : '\nStarts on day 1')
            : name + ' ' + sg.label + ' — ' + days + ' day' + (days === 1 ? '' : 's') + ' — planned for, in case it’s sent back';
          const pill = el('button.pv-pill' + (sg.rev ? '.rev' : '') + (batch ? '.batch' : ''), {
            type: 'button', title: tip, 'data-key': it.t.key,
            style: {
              left: (X(sg.s) + 1) + 'px', top: top + 'px', width: w + 'px', height: BAR_H + 'px',
              color: sg.rev ? 'var(--text)' : ink
            },
            onclick: () => { if (!justDragged) onSelect(it.t.key); },
            oncontextmenu: (e) => openMenu(e, it.t.key),
            onmouseenter: () => { hovered = it.t.key; applyFocus(); },
            onmouseleave: () => { if (hovered === it.t.key) { hovered = null; applyFocus(); } }
          }, [
            batch ? el('span.pv-batch-tag', null, 'BATCH') : null,
            w > 24 ? el('span.pv-pill-txt', null, text) : null
          ]);
          pill.style.setProperty('--pv-c', dep.color);     // Object.assign can't set a custom property
          // the right edge stretches or shrinks this pass — its days, or this
          // revision's days. Narrow bars are all handle.
          if (update) {
            pill.classList.add('editable');
            // the one being stretched keeps its handle lit through the repaints
            if (drag && drag.t.key === it.t.key && drag.si === si) pill.classList.add('dragging');
            pill.appendChild(el('span.pv-grip', {
              onpointerdown: (e) => beginResize(e, it.t, si)
            }));
          }
          canvas.appendChild(pill);
        });
      });

      applyFocus();

      // keep the selected task in view when it was picked from the list
      if (selected && byKey[selected] && scrollToSel) {
        scrollToSel = false;
        const sx = X(byKey[selected].s) - LABEL_W - 24;
        if (sx < scroller.scrollLeft || X(byKey[selected].e) > scroller.scrollLeft + scroller.clientWidth) {
          scroller.scrollLeft = Math.max(0, sx);
        }
      }
    }

    /* Hovering or selecting a task lights it, what it waits for and what waits
       for it, and dims the rest. Done with classes on the existing nodes — a
       rebuild on hover would pull the pill out from under the cursor and take
       its tooltip with it. */
    function applyFocus() {
      const focus = hovered || selected;
      const linked = new Set();
      if (focus) {
        linked.add(focus);
        (last.pipe.find(t => t.key === focus) || { deps: [] }).deps.forEach(k => linked.add(k));
        last.pipe.forEach(t => { if (t.deps.includes(focus)) linked.add(t.key); });
      }
      canvas.querySelectorAll('[data-key]').forEach(n => {
        const k = n.getAttribute('data-key');
        n.classList.toggle('sel', k === selected);
        n.classList.toggle('dim', !!focus && !linked.has(k));
      });
    }

    let scrollToSel = false;
    function setSelected(key) {
      if (key === selected) return;
      selected = key || null;
      scrollToSel = !!selected;
      repaint();
    }

    /* ---- drag a bar's end to change its days ----
       The task is changed in place while dragging so the timeline can
       redraw live, then put back and committed through update() on release —
       one undo step for the whole gesture, not one per day crossed. Listeners
       sit on the window because every redraw replaces the bar being dragged. */
    let drag = null, justDragged = false;
    const badge = el('.pv-drag-badge');

    const segDays = (t, si) => si === 0 ? t.days : (t.revDays || [])[si - 1] || 1;
    const setSegDays = (t, si, n) => {
      if (si === 0) { t.days = n; if (t.minDays > n) t.minDays = n; }
      else t.revDays[si - 1] = n;
    };

    function beginResize(e, t, si) {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      drag = { t, si, x: e.clientX, from: segDays(t, si), now: segDays(t, si), minDays: t.minDays };
      root.classList.add('resizing');
      document.body.appendChild(badge);
      moveBadge(e);
      window.addEventListener('pointermove', onResizeMove);
      window.addEventListener('pointerup', endResize);
      window.addEventListener('pointercancel', endResize);
    }
    function moveBadge(e) {
      const d = drag; if (!d) return;
      badge.textContent = (d.si === 0 ? (d.t.name || 'Task') : 'V' + (d.si + 1)) + ' · ' + d.now + ' day' + (d.now === 1 ? '' : 's') +
        (d.now !== d.from ? ' (' + (d.now > d.from ? '+' : '−') + Math.abs(d.now - d.from) + ')' : '');
      badge.style.left = (e.clientX + 14) + 'px';
      badge.style.top = (e.clientY - 30) + 'px';
    }
    function onResizeMove(e) {
      const d = drag; if (!d) return;
      const n = Math.max(1, Math.min(365, d.from + Math.round((e.clientX - d.x) / currentPx)));
      if (n !== d.now) { d.now = n; setSegDays(d.t, d.si, n); repaint(); }
      moveBadge(e);
    }
    function endResize() {
      const d = drag; if (!d) return;
      drag = null;
      window.removeEventListener('pointermove', onResizeMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
      root.classList.remove('resizing');
      badge.remove();
      // the release lands as a click on whatever is under it — swallow that one
      justDragged = true; setTimeout(() => { justDragged = false; }, 0);
      // put the task back as it was, then commit the change as one step
      setSegDays(d.t, d.si, d.from); d.t.minDays = d.minDays;
      if (d.now === d.from) { repaint(); return; }
      update(d.t.key, (t) => setSegDays(t, d.si, d.now));
    }

    /* ---- right-click menu ----
       Same look as the main Timeline's bar menu, and kept to what it names:
       each item opens a small window where the option is actually set. */
    let menu = null;
    const closeMenu = () => {
      if (!menu) return;
      menu.remove(); menu = null;
      document.removeEventListener('mousedown', offMenu, true);
      document.removeEventListener('keydown', escMenu, true);
    };
    const offMenu = (ev) => { if (menu && !menu.contains(ev.target)) closeMenu(); };
    const escMenu = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closeMenu(); } };

    function openMenu(e, key) {
      if (!update) return;
      e.preventDefault();
      closeMenu();
      const t = last.pipe.find(x => x.key === key);
      if (!t) return;
      const item = (label, sub, fn) => el('button.ctx-item', {
        type: 'button', onclick: () => { closeMenu(); fn(); }
      }, [el('span.ctx-item-lbl', null, label), sub ? el('span.ctx-item-sub', null, sub) : null]);
      const nDeps = t.deps.length;
      menu = el('.ctx-menu', null, [
        setBatch ? item('Batch Task…', App.batchCfg(t) ? App.batchLabel(t) : null, () => openBatch(key)) : null,
        depTags ? item('Dependencies…', nDeps ? String(nDeps) : null, () => openDeps(key)) : null
      ]);
      document.body.appendChild(menu);
      const mh = menu.offsetHeight, mw = menu.offsetWidth;
      menu.style.top = (e.clientY + mh + 6 > window.innerHeight ? Math.max(6, e.clientY - mh) : e.clientY + 2) + 'px';
      menu.style.left = Math.min(e.clientX + 2, window.innerWidth - mw - 8) + 'px';
      setTimeout(() => {
        document.addEventListener('mousedown', offMenu, true);
        document.addEventListener('keydown', escMenu, true);
      }, 0);
    }

    /* ---- popup windows ----
       Add Show is itself a modal, and App.modal holds one card at a time, so
       these open as a window of their own over it rather than through
       App.modal (which would tear Add Show down). Escape and a click on the
       dim backdrop close just this window. */
    let pop = null;
    const closePop = () => {
      if (!pop) return;
      pop.remove(); pop = null;
      document.removeEventListener('keydown', escPop, true);
    };
    const escPop = (ev) => {
      if (ev.key !== 'Escape') return;
      // a dependency picker open inside the window closes first
      if (document.querySelector('.dep-menu')) return;
      ev.stopPropagation(); closePop();
    };
    function openPop(title, subtitle, t, body, footer) {
      closePop();
      const dep = App.dept(t.dept);
      pop = el('.pv-pop-scrim', { onmousedown: (ev) => { if (ev.target === pop) closePop(); } },
        el('.modal-card.pv-pop', { onclick: (ev) => ev.stopPropagation() }, [
          el('.modal-head', null, [
            el('.modal-head-main', null, [
              el('div', null, [el('.modal-title', null, title), el('.modal-subtitle', null, subtitle)])
            ]),
            el('button.modal-x', { type: 'button', title: 'Close', onclick: closePop }, '✕')
          ]),
          el('.modal-body', null, [
            el('.ctx-box.slim', null, [
              el('span.ctx-chip', { style: { background: dep.color, color: App.pickInkFor ? App.pickInkFor(dep.color) : '#11131a' } }, dep.label),
              el('span.ctx-title', null, t.name || 'Untitled')
            ])
          ].concat(body)),
          el('.modal-foot', null, footer)
        ]));
      document.body.appendChild(pop);
      setTimeout(() => document.addEventListener('keydown', escPop, true), 0);
    }

    /* Batch Task — the Timeline's Batch Set Dates layout (Same start / Stagger /
       Group), minus dates: spacing is days or weeks from the first episode,
       and the preview reads in weeks. Nothing changes until Apply. */
    function openBatch(key) {
      const t = last.pipe.find(x => x.key === key); if (!t) return;
      const cur = App.batchCfg(t) || { mode: 'group', size: 2, every: 0, unit: 'week' };
      let mode = cur.mode;
      const everyInput = el('input.fld.bd-num', { type: 'number', min: '0', max: '365', value: String(cur.every) });
      const sizeInput = el('input.fld.bd-num', { type: 'number', min: '1', max: '99', value: String(cur.size) });
      const unitSel = el('select.fld.bd-unit', null,
        [['day', 'Days'], ['week', 'Weeks']].map(([v, l]) => el('option', { value: v }, l)));
      unitSel.value = cur.unit;
      const read = () => ({
        mode,
        size: Math.max(1, Math.min(99, parseInt(sizeInput.value, 10) || 1)),
        every: Math.max(0, Math.min(365, parseInt(everyInput.value, 10) || 0)),
        unit: unitSel.value
      });

      const summary = el('.bd-summary');
      const list = el('.bd-preview');
      const paint = () => {
        const rows = previewBatch ? previewBatch(key, read()) : [];
        list.innerHTML = '';
        let lastGroup = -1;
        rows.forEach(r => {
          const lead = r.group !== lastGroup;
          lastGroup = r.group;
          list.appendChild(el('.bd-row' + (lead ? '.bd-row-lead' : ''), null, [
            el('span.bd-code', null, r.ep),
            el('span.bd-task', null, r.name),
            el('span.bd-now.changed', null, lead ? 'Week ' + (Math.floor(r.day / 7) + 1) + ' · day ' + (r.day + 1) : 'shares the run above')
          ]));
        });
        const runs = new Set(rows.map(r => r.group)).size;
        summary.textContent = rows.length + ' episode' + (rows.length === 1 ? '' : 's') + ' · ' +
          runs + ' run' + (runs === 1 ? '' : 's') + ' of ' + (t.name || 'this task') + ' · durations kept';
      };

      const segs = el('.prefs-seg.bd-modes', null, [
        ['fixed', 'Same start'], ['stagger', 'Stagger'], ['group', 'Group']
      ].map(([v, label]) => el('button.seg' + (mode === v ? '.active' : ''), {
        type: 'button',
        onclick: (ev) => {
          mode = v;
          [...segs.children].forEach(b => b.classList.toggle('active', b === ev.currentTarget));
          syncControls(); paint();
        }
      }, label)));
      const everyRow = el('.bd-inline', null, [el('span.bd-lbl', null, 'Space by'), everyInput, unitSel,
        el('span.bd-hint', null, '0 = follow the episode rate')]);
      const sizeRow = el('.bd-inline', null, [el('span.bd-lbl', null, 'Episodes per batch'), sizeInput]);
      const syncControls = () => {
        everyRow.style.display = mode === 'fixed' ? 'none' : '';
        sizeRow.style.display = mode === 'group' ? '' : 'none';
      };
      syncControls();
      [everyInput, sizeInput].forEach(i => { i.addEventListener('input', paint); i.addEventListener('change', paint); });
      unitSel.addEventListener('change', paint);
      paint();

      const had = !!App.batchCfg(t);
      openPop('Batch Task', 'Run this task once for several episodes, by episode order', t, [
        segs,
        el('.bd-controls', null, [everyRow, sizeRow]),
        summary,
        list
      ], [
        had ? el('button.btn-ghost.pv-pop-remove', { type: 'button', onclick: () => { closePop(); setBatch(key, null); } }, 'Remove batch') : null,
        el('button.btn-ghost', { type: 'button', onclick: closePop }, 'Cancel'),
        el('button.btn-primary', { type: 'button', onclick: () => { const c = read(); closePop(); setBatch(key, c); } }, had ? 'Save' : 'Make Batch Task')
      ]);
    }

    /* Dependencies — the task row's own chips: a tag per dependency with ✕,
       and ＋ to add one. Changes apply as they're made, like in the list. */
    function openDeps(key) {
      const t = last.pipe.find(x => x.key === key); if (!t) return;
      const holder = el('.pv-pop-deps');
      const fill = () => { holder.innerHTML = ''; const box = depTags(key, fill); if (box) holder.appendChild(box); };
      fill();
      openPop('Dependencies', 'What has to finish before this task can start', t, [holder], [
        el('button.btn-primary', { type: 'button', onclick: closePop }, 'Done')
      ]);
    }

    const closeAll = () => { closeMenu(); closePop(); };

    return { el: root, render, setSelected, closeMenus: closeAll };
  };
})();
