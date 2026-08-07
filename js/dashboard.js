/* Dashboard view — a personal workspace: greeting + daily quote, then a grid
   of widgets dealt from a role-specific layout. "Edit" turns on layout mode,
   where a tile can be dragged to reorder and resized by dragging an edge. A
   widget has three vetted sizes (Small / Medium / Large) rather than a free
   span, and shows more of its data at each — so resizing can't leave a tile
   too cramped to read. Rows are packed to a full twelve columns, so the grid
   never opens a gap. Order and sizes persist per device AND per role.
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

  /* Three fixed sizes per widget instead of a free-form span, so a resize can
     never leave a tile too narrow for its content or too wide to tile with its
     neighbours. A size sets two things and deliberately not a third:

       span  columns, drawn from {4, 6, 12} only — every combination of those
             fills a 12-column row exactly, which is what keeps the grid from
             opening up horizontal gaps
       cap   how many rows of data to show, so the tile doesn't just stretch

     HEIGHT IS NEVER DECLARED. A card is as tall as what's inside it and no
     taller — a tile forced to a neighbour's height is just a card with a hole
     in it. The grid aligns tiles to the top of their row instead of stretching
     them (see `align-items: start` in style.css). */
  const SIZES = ['sm', 'md', 'lg'];
  const SIZE_LABEL = { sm: 'Small', md: 'Medium', lg: 'Large' };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const WIDGETS = {
    priority:  { sm: 4, md: 6, lg: 12, cap: { sm: 2, md: 4, lg: 8 } },
    atRisk:    { sm: 4, md: 6, lg: 12, cap: { sm: 3, md: 6, lg: 10 } },
    journal:   { sm: 4, md: 6, lg: 12 },
    delivered: { sm: 4, md: 6, lg: 12 },
    pipeline:  { sm: 4, md: 6, lg: 12 },
    deptLoad:  { sm: 4, md: 6, lg: 12, cap: { sm: 3, md: 5, lg: 9 } },
    upcoming:  { sm: 4, md: 6, lg: 12, cap: { sm: 3, md: 6, lg: 10 } },
    teamLoad:  { sm: 4, md: 6, lg: 12, cap: { sm: 4, md: 8, lg: 12 } }
  };
  // how many data rows this widget shows at this size
  const capOf = (id, size) => (WIDGETS[id].cap || {})[size] || 6;

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
     Admin → Access Control moves someone's dashboard with them. */
  const LAYOUTS = {
    oversight: [['atRisk', 'md'], ['journal', 'md'], ['pipeline', 'sm'], ['teamLoad', 'sm'],
                ['deptLoad', 'sm'], ['upcoming', 'md'], ['delivered', 'md']],
    review:    [['atRisk', 'md'], ['journal', 'md'], ['upcoming', 'md'], ['delivered', 'md']],
    dept:      [['priority', 'md'], ['journal', 'md'], ['delivered', 'sm']]
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

  // grid geometry, kept in step with .dash-grid in style.css
  const COLS = 12;

  /* Pack tiles into rows in order, first-fit, then hand any spare columns back
     to the tiles in that row. Nothing is left over, so the grid can't show a
     hole where a row didn't happen to add up to twelve — which is the whole
     reason spans are restricted to {4, 6, 12}. Heights are left alone: each
     card keeps its own, and the row is as tall as its tallest member. */
  function packRows(entries) {
    const rows = [];
    let cur = [], used = 0;
    entries.forEach(t => {
      if (used + t.span > COLS) { rows.push(cur); cur = []; used = 0; }
      cur.push(t); used += t.span;
    });
    if (cur.length) rows.push(cur);

    rows.forEach(row => {
      let spare = COLS - row.reduce((n, t) => n + t.span, 0);
      for (let i = row.length - 1; spare > 0; i = (i - 1 + row.length) % row.length) {
        row[i].span++; spare--;                       // widen from the end, one column at a time
      }
    });
    return rows;
  }

  App.dashboard = {
    // Layout editing is a mode, not an always-on affordance: widgets stay
    // inert until it's on, so nobody drags a tile while reading it. Session
    // state on purpose — you leave the dashboard, you leave edit mode.
    _editing: false,
    toggleEdit() { this._editing = !this._editing; App.render(); },

    render(episodes) {
      const wrap = el('.dash');
      wrap.appendChild(this.greeting());

      const grid = el('.dash-grid' + (this._editing ? '.editing' : ''));
      if (!episodes.length) {
        grid.appendChild(el('.empty', { style: { gridColumn: 'span 12' } }, 'No episodes match the current filters.'));
        wrap.appendChild(grid);
        return wrap;
      }

      // ---- aggregate once, shared by the widgets ----
      const subs = [];
      episodes.forEach(ep => App.subsView(ep).forEach(su => subs.push({ ep, su })));
      const m = { episodes, subs, delivered: episodes.filter(App.isDelivered).length };

      const dflt = LAYOUTS[layoutKind(App.state.role)];
      const allowed = dflt.map(e => e[0]);
      const order = (App.prefs.get(this.orderKey(), null) || allowed.slice())
        .filter(id => WIDGETS[id] && allowed.includes(id));   // a role never inherits another's widgets
      allowed.forEach(id => { if (!order.includes(id)) order.push(id); });   // newly added widgets join at the end

      // size class first, then pack: the packer widens tiles to close any gap,
      // so a cell's final span can exceed its class's nominal width
      const entries = order.map(id => {
        const size = this.sizeOf(id, dflt);
        return { id: id, size: size, span: WIDGETS[id][size] };
      });
      packRows(entries).forEach(row => row.forEach(t => grid.appendChild(this.cell(t, m))));
      this.wireDrag(grid, order);
      if (this._editing) this.wireResize(grid, dflt);
      wrap.appendChild(grid);
      return wrap;
    },

    // Rearranging and resizing are per device AND per role — one person
    // switching hats shouldn't drag a producer's layout onto a creative's.
    orderKey() { return 'dashOrder:' + App.state.role; },
    sizeKey() { return 'dashSize:' + App.state.role; },

    // stored size class wins over the layout's default for that widget
    sizeOf(id, dflt) {
      const saved = (App.prefs.get(this.sizeKey(), null) || {})[id];
      if (SIZES.indexOf(saved) >= 0) return saved;
      const entry = (dflt || []).find(e => e[0] === id);
      return (entry && entry[1]) || 'md';
    },
    setSize(id, size) {
      const all = Object.assign({}, App.prefs.get(this.sizeKey(), null) || {});
      all[id] = size;
      App.prefs.set(this.sizeKey(), all);
    },

    greeting() {
      const user = App.state.user;
      const name = user ? user.name.split(' ')[0] : App.role(App.state.role).label;
      const h = App.today().getHours();
      const hello = h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
      const q = QUOTES[dayIndex() % QUOTES.length];
      const editing = this._editing;
      return el('.dash-hello', null, [
        el('div', null, [
          el('.dash-hi', null, hello + ', ' + name + '!'),
          el('.dash-quote', null, ['“' + q[0] + '”', el('span.qa', null, ' — ' + q[1])])
        ]),
        el('.dash-tools', null, [
          (editing ? el('button.ghost.dash-reset', {
            title: 'Put every widget back to its default size and position',
            onclick: () => {
              App.prefs.set(this.orderKey(), null);
              App.prefs.set(this.sizeKey(), null);
              App.render();
            }
          }, 'Reset layout') : null),
          el('button' + (editing ? '.btn-primary' : '.ghost'), {
            title: editing ? 'Finish editing the layout' : 'Move and resize widgets',
            onclick: () => this.toggleEdit()
          }, editing ? '✓ Done' : [App.icon('pencil'), ' Edit'])
        ])
      ]);
    },

    /* one grid cell: uniform chrome (grip + title + sub) around a widget body.
       `t` is a packed tile — { id, size, span }. No height is set: the card is
       as tall as its content. In edit mode the tile becomes the drag handle and
       grows thin edge and corner zones; the body goes inert so arranging can't
       touch a widget's content. */
    cell(t, m) {
      const built = this[t.id](m, t.size);        // -> { title, sub, body, bare }
      const editing = this._editing;
      const cell = el('.dw.dw-' + t.size + (editing ? '.dw-editable' : ''), {
        style: { gridColumn: 'span ' + t.span }
      });
      cell.dataset.wid = t.id;
      if (editing) cell.setAttribute('draggable', 'true');
      cell.appendChild(el('.widget', null, [
        el('.widget-head', null, [
          el('.dw-head-l', null, [
            (editing ? el('span.dw-grip', { title: 'Drag to move' }, '⠿') : null),
            el('.widget-title', null, built.title)
          ]),
          built.sub ? el('.widget-sub', null, built.sub) : null
        ]),
        el('.widget-body' + (built.bare ? '.bare' : ''), null, built.body)
      ]));
      if (editing) {
        const tip = 'Drag out to grow, in to shrink — currently ' + SIZE_LABEL[t.size];
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
        cell.appendChild(el('span.dw-size', null, SIZE_LABEL[t.size]));
      }
      return cell;
    },

    /* ---- resize by dragging an edge or a corner ----
       Widgets step between three vetted sizes rather than any span the cursor
       lands on, so a tile can't be dragged narrower than its content reads or
       wider than the row can hold. Dragging away from the tile moves up a size,
       towards it moves down; STEP_PX is how far the cursor travels per step. A
       corner watches both axes and takes whichever moved further, so it behaves
       like the nearer edge when the drag is mostly horizontal or vertical. */
    wireResize(grid, dflt) {
      let d = null;
      const STEP_PX = 90;

      grid.addEventListener('pointerdown', (e) => {
        const z = e.target.closest('.dw-edge, .dw-corner');
        if (!z) return;
        const cell = z.closest('.dw');
        e.preventDefault();
        const size = this.sizeOf(cell.dataset.wid, dflt);
        d = { cell: cell, grab: z.dataset.grab, x: e.clientX, y: e.clientY, from: size, to: size };
        cell.classList.add('dw-resizing');
        // The tile is draggable for reordering, and a native drag starting here
        // would fire pointercancel and kill the resize mid-gesture. Turn the
        // move affordance off for the duration of this drag.
        cell.removeAttribute('draggable');
        // capture keeps the drag alive past the grid's edge; harmless if the
        // pointer is already gone (synthetic events, a released touch)
        try { z.setPointerCapture(e.pointerId); } catch (err) {}
      });

      grid.addEventListener('pointermove', (e) => {
        if (!d) return;
        // outward travel on each axis the grabbed handle owns
        const dx = d.grab.indexOf('r') >= 0 ? e.clientX - d.x : d.grab.indexOf('l') >= 0 ? d.x - e.clientX : 0;
        const dy = d.grab.indexOf('b') >= 0 ? e.clientY - d.y : d.grab.indexOf('t') >= 0 ? d.y - e.clientY : 0;
        const out = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
        const next = SIZES[clamp(SIZES.indexOf(d.from) + Math.round(out / STEP_PX), 0, SIZES.length - 1)];
        if (next === d.to) return;
        d.to = next;
        d.cell.style.gridColumn = 'span ' + WIDGETS[d.cell.dataset.wid][next];   // preview; the packer has the last word
        const badge = d.cell.querySelector('.dw-size');
        if (badge) badge.textContent = SIZE_LABEL[next];
      });

      const finish = () => {
        if (!d) return;
        const cur = d;
        d = null;
        cur.cell.classList.remove('dw-resizing');
        cur.cell.setAttribute('draggable', 'true');
        if (cur.to !== cur.from) this.setSize(cur.cell.dataset.wid, cur.to);
        App.render();                  // re-pack, and let the widget refit its new box
      };
      grid.addEventListener('pointerup', finish);
      grid.addEventListener('pointercancel', finish);
    },

    // ---- drag to rearrange (HTML5 DnD; edit mode only) ----
    wireDrag(grid, order) {
      let dragId = null;
      grid.addEventListener('dragstart', (e) => {
        const cell = e.target.closest && e.target.closest('.dw');
        // the whole tile drags, but only in edit mode, and never from a resize handle
        if (!cell || !this._editing || (e.target.closest && e.target.closest('.dw-edge, .dw-corner'))) { e.preventDefault(); return; }
        dragId = cell.dataset.wid;
        cell.classList.add('dw-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragId); } catch (err) {}
      });
      grid.addEventListener('dragover', (e) => {
        if (!dragId) return;
        e.preventDefault();
        const over = e.target.closest && e.target.closest('.dw');
        grid.querySelectorAll('.dw-over').forEach(c => c.classList.remove('dw-over'));
        if (over && over.dataset.wid !== dragId) over.classList.add('dw-over');
      });
      grid.addEventListener('drop', (e) => {
        e.preventDefault();
        const over = e.target.closest && e.target.closest('.dw');
        if (dragId && over && over.dataset.wid !== dragId) {
          const next = order.filter(x => x !== dragId);
          next.splice(next.indexOf(over.dataset.wid), 0, dragId);
          App.prefs.set(this.orderKey(), next);
          dragId = null;
          App.render();
          return;
        }
        dragId = null;
      });
      grid.addEventListener('dragend', () => {
        dragId = null;
        grid.querySelectorAll('.dw-over, .dw-dragging').forEach(c => c.classList.remove('dw-over', 'dw-dragging'));
      });
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
    priority(m, size) {
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
        .map(g => this.priorityGroup(g, buckets[g.key], size));
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

    priorityGroup(g, items, size) {
      const pkey = 'dashPri:' + g.key;
      const open = App.prefs.get(pkey, g.open);
      const box = el('.pr-group', { style: { borderLeftColor: g.color } });

      box.appendChild(el('button.pr-head', {
        type: 'button',
        onclick: () => { App.prefs.set(pkey, !open); App.render(); }
      }, [
        el('span.chev' + (open ? '.open' : ''), null, '▶'),
        el('span.pr-label', null, g.label),
        (size === 'sm' ? null : el('span.pr-sub', null, g.sub)),   // no room for the blurb when narrow
        el('span.pr-count', { style: { color: g.color } }, String(items.length))
      ]));

      if (open) {
        const rows = el('.pr-rows');
        // capped to what the tile can actually hold at this size
        const cap = capOf('priority', size);
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

    atRisk(m, size) {
      const items = [];
      const todayIso = App.isoDate(App.today());
      m.subs.forEach(({ ep, su }) => {
        if (su.status === 'approved') return;
        const overdue = su.due < todayIso;
        const blocked = App.isRiskBlocked(ep, su.key);
        if (overdue || blocked) items.push({ ep, su, overdue, blocked, late: App.daysUntil(su.due) });
      });
      items.sort((a, b) => a.late - b.late);
      const cap = capOf('atRisk', size);
      const body = items.length ? el('.risk-list', null, items.slice(0, cap).map(x => {
        const dep = App.dept(x.su.dept);
        return el('.risk-item', { title: dep.label + ' — ' + x.su.name + ' · ' + x.ep.code + ' ' + x.ep.title + ' · due ' + App.fmtDate(x.su.due) }, [
          (size === 'sm' ? el('span.dot', { style: { background: dep.color, width: '8px', height: '8px', borderRadius: '50%', flex: 'none' } })
            : el('span.dept-chip', { style: { padding: '1px 7px', fontSize: '10px' } }, [el('span.dot', { style: { background: dep.color } }), dep.label])),
          el('.ri-main', null, [
            el('.ri-title', null, x.su.name + '  ·  ' + x.ep.code),
            (size === 'sm' ? null : el('.ri-sub', null, x.ep.title + ' — due ' + App.fmtDate(x.su.due)))
          ]),
          x.overdue ? el('span.ri-tag.over', null, Math.abs(x.late) + 'd overdue') : null,
          x.blocked ? el('span.ri-tag.blk', null, 'blocked') : null
        ]);
      })) : el('.dw-calm', null, '✓  Smooth sailing.');
      if (items.length > cap) body.appendChild(el('.pr-more', null, '+' + (items.length - cap) + ' more'));
      return { title: 'At Risk', sub: items.length + ' overdue or blocked', body };
    },

    delivered(m, size) {
      const total = m.episodes.length;
      const pct = total ? Math.round(m.delivered / total * 100) : 0;
      const figure = el('div', null, [
        el('.big-num', null, [String(m.delivered), el('span.of', null, ' / ' + total)]),
        el('.widget-sub', { style: { marginTop: '4px' } }, pct + '% of the slate delivered')
      ]);
      // small drops the donut (the number is the point); large earns a per-show
      // breakdown of where the delivered episodes actually came from
      const body = el('.donut-wrap', null, [(size === 'sm' ? null : donut(pct, '#00c875')), figure]);
      if (size === 'lg') {
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

    pipeline(m, size) {
      const count = { not_started: 0, ready: 0, in_progress: 0, review: 0, approved: 0 };
      m.subs.forEach(x => count[x.su.status]++);
      const rows = App.STATUS_ORDER.map(sk => {
        const s = App.STATUSES[sk], v = count[sk] || 0;
        const pct = m.subs.length ? Math.round(v / m.subs.length * 100) : 0;
        return el('.bar-row', null, [
          el('.bl', { title: s.label + ' — ' + v + ' of ' + m.subs.length }, [el('span.swatch', { style: { width: '11px', height: '11px', borderRadius: '3px', background: s.color, display: 'inline-block' } }), s.label]),
          el('.bt', null, [el('.bf', { style: { width: pct + '%', background: s.color } })]),
          el('.bv', null, size === 'sm' ? String(v) : v + '  ' + pct + '%')
        ]);
      });
      return { title: 'Pipeline Status', sub: m.subs.length + ' subitems', body: rows };
    },

    deptLoad(m, size) {
      const active = m.subs.filter(x => x.su.status !== 'approved');
      const max = Math.max(1, ...Object.keys(App.DEPARTMENTS).map(k => active.filter(x => x.su.dept === k).length));
      const rows = Object.keys(App.DEPARTMENTS)
        .map(dk => ({ d: App.dept(dk), n: active.filter(x => x.su.dept === dk).length }))
        .filter(r => r.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, capOf('deptLoad', size))
        .map(r => el('.bar-row', null, [
          el('.bl', null, [el('span.swatch', { style: { width: '11px', height: '11px', borderRadius: '3px', background: r.d.color, display: 'inline-block' } }), r.d.label]),
          el('.bt', null, [el('.bf', { style: { width: Math.round(r.n / max * 100) + '%', background: r.d.color } })]),
          el('.bv', null, String(r.n))
        ]));
      return { title: 'Department Workload', sub: 'open subitems', body: rows.length ? rows : el('.dw-calm', null, 'Nothing open.') };
    },

    teamLoad(m, size) {
      const editors = App.state.data.people.filter(p => App.roleDept(p.role));
      const rows = editors.map(p => {
        const mine = m.subs.filter(x => x.su.assignee === p.id);
        const activeN = mine.filter(x => ['ready', 'in_progress', 'review'].includes(x.su.status)).length;
        const wip = mine.filter(x => x.su.status === 'in_progress').length;
        return { p, activeN, wip };
      }).filter(r => r.activeN > 0).sort((a, b) => b.activeN - a.activeN).slice(0, capOf('teamLoad', size));
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

    upcoming(m, size) {
      const list = m.episodes.filter(ep => !App.isDelivered(ep))
        .map(ep => ({ ep, due: App.epDue(ep) }))
        .sort((a, b) => a.due < b.due ? -1 : 1).slice(0, capOf('upcoming', size));
      const body = list.length ? el('.risk-list', null, list.map(x => {
        const show = App.show(x.ep.showId);
        const days = App.daysUntil(x.due);
        return el('.risk-item', { title: x.ep.code + ' · ' + x.ep.title + ' — ' + show.name + ' · ' + App.progressPct(x.ep) + '% complete' }, [
          el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color), fontSize: '10px', padding: '2px 7px' } }, x.ep.code),
          el('.ri-main', null, [
            el('.ri-title', null, size === 'sm' ? x.ep.title : x.ep.title + '  ·  ' + show.name),
            (size === 'sm' ? null : el('.ri-sub', null, App.progressPct(x.ep) + '% complete · ' + App.epStatusLabel(x.ep)))
          ]),
          el('span.ri-tag' + (days < 0 ? '.over' : ''), { style: days >= 0 ? { background: 'var(--surface-3)', color: 'var(--text-2)' } : {} },
            days < 0 ? Math.abs(days) + 'd late' : days === 0 ? 'today' : 'in ' + days + 'd')
        ]);
      })) : el('.dw-calm', null, 'No outstanding deliveries.');
      return { title: 'Upcoming Deliveries', sub: 'next episodes to land', body };
    }
  };

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
