/* Dashboard view — a personal workspace: greeting + daily quote, then a grid
   of movable widgets (drag the ⠿ grip to rearrange; order persists per device
   in App.prefs). Widgets: At Risk, Journal (js/journal.js), Delivered,
   Pipeline Status, Department & Team workload, Upcoming Deliveries. */
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

  // span = grid columns (of 12); rows = grid rows (120px units). The default
  // order tiles perfectly with grid-auto-flow: dense.
  const WIDGETS = {
    atRisk:    { span: 8, rows: 1 },
    journal:   { span: 4, rows: 3 },
    delivered: { span: 4, rows: 1 },
    pipeline:  { span: 4, rows: 2 },
    deptLoad:  { span: 4, rows: 1 },
    upcoming:  { span: 8, rows: 2 },
    teamLoad:  { span: 4, rows: 2 }
  };
  const DEFAULT_ORDER = ['atRisk', 'journal', 'delivered', 'pipeline', 'deptLoad', 'upcoming', 'teamLoad'];

  App.dashboard = {
    render(episodes) {
      const wrap = el('.dash');
      wrap.appendChild(this.greeting());

      const grid = el('.dash-grid');
      if (!episodes.length) {
        grid.appendChild(el('.empty', { style: { gridColumn: 'span 12' } }, 'No episodes match the current filters.'));
        wrap.appendChild(grid);
        return wrap;
      }

      // ---- aggregate once, shared by the widgets ----
      const subs = [];
      episodes.forEach(ep => App.subsView(ep).forEach(su => subs.push({ ep, su })));
      const m = { episodes, subs, delivered: episodes.filter(App.isDelivered).length };

      const order = (App.prefs.get('dashOrder', null) || DEFAULT_ORDER.slice()).filter(id => WIDGETS[id]);
      DEFAULT_ORDER.forEach(id => { if (!order.includes(id)) order.push(id); });   // newly added widgets join at the end

      order.forEach(id => grid.appendChild(this.cell(id, m)));
      this.wireDrag(grid, order);
      wrap.appendChild(grid);
      return wrap;
    },

    greeting() {
      const user = App.state.user;
      const name = user ? user.name.split(' ')[0] : App.role(App.state.role).label;
      const h = App.today().getHours();
      const hello = h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
      const q = QUOTES[dayIndex() % QUOTES.length];
      return el('.dash-hello', null, [
        el('.dash-hi', null, hello + ', ' + name + '!'),
        el('.dash-quote', null, ['“' + q[0] + '”', el('span.qa', null, ' — ' + q[1])])
      ]);
    },

    // one grid cell: uniform chrome (grip + title + sub) around a widget body
    cell(id, m) {
      const w = WIDGETS[id];
      const built = this[id](m);        // -> { title, sub, body, bare }
      const cell = el('.dw', { style: { gridColumn: 'span ' + w.span, gridRow: 'span ' + w.rows } });
      cell.dataset.wid = id;
      const grip = el('span.dw-grip', { title: 'Drag to rearrange', draggable: 'true' }, '⠿');
      cell.appendChild(el('.widget', { style: { height: '100%' } }, [
        el('.widget-head', null, [
          el('.dw-head-l', null, [grip, el('.widget-title', null, built.title)]),
          built.sub ? el('.widget-sub', null, built.sub) : null
        ]),
        el('.widget-body' + (built.bare ? '.bare' : ''), null, built.body)
      ]));
      return cell;
    },

    // ---- drag to rearrange (HTML5 DnD on the grips) ----
    wireDrag(grid, order) {
      let dragId = null;
      grid.addEventListener('dragstart', (e) => {
        const cell = e.target.closest && e.target.closest('.dw');
        if (!cell || !e.target.classList.contains('dw-grip')) { e.preventDefault(); return; }
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
          App.prefs.set('dashOrder', next);
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
    journal() {
      return { title: 'Journal', sub: 'your daily notes', body: App.journal.render(), bare: true };
    },

    atRisk(m) {
      const items = [];
      const todayIso = App.isoDate(App.today());
      m.subs.forEach(({ ep, su }) => {
        if (su.status === 'approved') return;
        const overdue = su.due < todayIso;
        const blocked = App.isRiskBlocked(ep, su.key);
        if (overdue || blocked) items.push({ ep, su, overdue, blocked, late: App.daysUntil(su.due) });
      });
      items.sort((a, b) => a.late - b.late);
      const body = items.length ? el('.risk-list', null, items.slice(0, 6).map(x => {
        const dep = App.dept(x.su.dept);
        return el('.risk-item', null, [
          el('span.dept-chip', { style: { padding: '1px 7px', fontSize: '10px' } }, [el('span.dot', { style: { background: dep.color } }), dep.label]),
          el('.ri-main', null, [
            el('.ri-title', null, x.su.name + '  ·  ' + x.ep.code),
            el('.ri-sub', null, x.ep.title + ' — due ' + App.fmtDate(x.su.due))
          ]),
          x.overdue ? el('span.ri-tag.over', null, Math.abs(x.late) + 'd overdue') : null,
          x.blocked ? el('span.ri-tag.blk', null, 'blocked') : null
        ]);
      })) : el('.dw-calm', null, '✓  Smooth sailing.');
      return { title: 'At Risk', sub: 'overdue & blocked', body };
    },

    delivered(m) {
      const total = m.episodes.length;
      const pct = total ? Math.round(m.delivered / total * 100) : 0;
      return { title: 'Delivered Episodes', sub: 'fully approved', body: el('.donut-wrap', null, [
        donut(pct, '#00c875'),
        el('div', null, [
          el('.big-num', null, [String(m.delivered), el('span.of', null, ' / ' + total)]),
          el('.widget-sub', { style: { marginTop: '4px' } }, pct + '% of the slate delivered')
        ])
      ]) };
    },

    pipeline(m) {
      const count = { not_started: 0, ready: 0, in_progress: 0, review: 0, approved: 0 };
      m.subs.forEach(x => count[x.su.status]++);
      const rows = App.STATUS_ORDER.map(sk => {
        const s = App.STATUSES[sk], v = count[sk] || 0;
        const pct = m.subs.length ? Math.round(v / m.subs.length * 100) : 0;
        return el('.bar-row', null, [
          el('.bl', null, [el('span.swatch', { style: { width: '11px', height: '11px', borderRadius: '3px', background: s.color, display: 'inline-block' } }), s.label]),
          el('.bt', null, [el('.bf', { style: { width: pct + '%', background: s.color } })]),
          el('.bv', null, String(v))
        ]);
      });
      return { title: 'Pipeline Status', sub: m.subs.length + ' subitems', body: rows };
    },

    deptLoad(m) {
      const active = m.subs.filter(x => x.su.status !== 'approved');
      const max = Math.max(1, ...Object.keys(App.DEPARTMENTS).map(k => active.filter(x => x.su.dept === k).length));
      const rows = Object.keys(App.DEPARTMENTS)
        .map(dk => ({ d: App.dept(dk), n: active.filter(x => x.su.dept === dk).length }))
        .filter(r => r.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, 5)
        .map(r => el('.bar-row', null, [
          el('.bl', null, [el('span.swatch', { style: { width: '11px', height: '11px', borderRadius: '3px', background: r.d.color, display: 'inline-block' } }), r.d.label]),
          el('.bt', null, [el('.bf', { style: { width: Math.round(r.n / max * 100) + '%', background: r.d.color } })]),
          el('.bv', null, String(r.n))
        ]));
      return { title: 'Department Workload', sub: 'open subitems', body: rows.length ? rows : el('.dw-calm', null, 'Nothing open.') };
    },

    teamLoad(m) {
      const editors = App.state.data.people.filter(p => App.roleDept(p.role));
      const rows = editors.map(p => {
        const mine = m.subs.filter(x => x.su.assignee === p.id);
        const activeN = mine.filter(x => ['ready', 'in_progress', 'review'].includes(x.su.status)).length;
        const wip = mine.filter(x => x.su.status === 'in_progress').length;
        return { p, activeN, wip };
      }).filter(r => r.activeN > 0).sort((a, b) => b.activeN - a.activeN).slice(0, 8);
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

    upcoming(m) {
      const list = m.episodes.filter(ep => !App.isDelivered(ep))
        .map(ep => ({ ep, due: App.epDue(ep) }))
        .sort((a, b) => a.due < b.due ? -1 : 1).slice(0, 6);
      const body = list.length ? el('.risk-list', null, list.map(x => {
        const show = App.show(x.ep.showId);
        const days = App.daysUntil(x.due);
        return el('.risk-item', null, [
          el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color), fontSize: '10px', padding: '2px 7px' } }, x.ep.code),
          el('.ri-main', null, [
            el('.ri-title', null, x.ep.title + '  ·  ' + show.name),
            el('.ri-sub', null, App.progressPct(x.ep) + '% complete · ' + App.epStatusLabel(x.ep))
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
