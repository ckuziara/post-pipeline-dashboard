/* Print / Export — ⌘P / Ctrl+P, or the Export buttons.

   The browser's own Print would print the app: toolbars, a half-scrolled
   timeline, dark chrome. What a producer actually wants to hand a client or a
   freelancer is the data behind whatever they're looking at, laid out as a
   document. So the shortcut is taken over and opens this instead — a print
   dialog of our own, options down the left, a live preview on the right.

   What gets exported depends on where it was opened from. Each place hands
   over a "context": what it's called, which filters make sense for it, which
   fields it can include, and a build() that turns the chosen options into a
   document —

     Timeline / Board        production breakdown of the filtered episodes
     Shows window            the shows listed (after its own filters)
     Edit Show / Pipeline    one show: details, team, pipeline, episodes —
                             and what's still unfinished
     Working Days & Holidays the production's holidays and time off

   A dialog offers one by putting `_exportCtx` (a function returning the
   context) on its .modal-card; the views are handled here. The document is
   { title, subtitle, meta, accent, blocks[] } and renders two ways: HTML for
   the preview and the PDF (printed from a hidden frame — the system dialog's
   "Save as PDF"), and CSV for spreadsheets. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const fmt = (iso) => iso ? App.fmtDate(iso) : '—';
  const fmtY = (iso) => {
    if (!iso) return '—';
    return App.parseDate(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const range = (a, b) => !a ? '—' : (!b || a === b) ? fmtY(a) : fmtY(a) + ' – ' + fmtY(b);
  const slug = (s) => String(s || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
  const today = () => App.isoDate(App.today());
  const overlaps = (a, b, from, to) => (!to || !a || a <= to) && (!from || !b || b >= from);
  const cell = (t, h) => ({ t: t == null ? '' : String(t), h });
  const pill = (label, color, ink) =>
    '<span class="pill" style="background:' + color + ';color:' + (ink || App.pickInkFor(color)) + '">' + esc(label) + '</span>';
  const dot = (color) => '<i class="dot" style="background:' + color + '"></i>';

  // working days between two dates — the calendar's, when there is one
  function workDays(a, b, cal, who) {
    if (!a || !b) return 0;
    let n = 0;
    for (let x = a, g = 0; x <= b && g < 2000; x = App.shiftIso(x, 1), g++) {
      if (cal ? !cal.isOff(x, who) : true) n++;
    }
    return n;
  }

  // everyone staffed on a show, each with the department they sit in
  function teamPeople(show) {
    const out = [], seen = {};
    App.teamSlots(show).forEach(slot => App.deptTeam(show, slot).ids.forEach(id => {
      if (seen[id]) return; seen[id] = 1;
      const p = App.person(id); if (p) out.push(p);
    }));
    return out;
  }
  const personGroup = (p) => {
    const d = App.roleDept(p.role);
    return d ? App.dept(d).label : App.role(p.role).label;
  };
  const peopleOptions = (people) => people
    .map(p => ({ id: p.id, label: p.name, group: personGroup(p), color: p.color }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));

  const STATUS_OPTS = () => App.STATUS_ORDER.map(k => ({ id: k, label: App.status(k).label, color: App.status(k).color }));
  const SHOW_STATES = [
    { id: 'pending', label: 'Not started', color: '#9aa0ad' },
    { id: 'active', label: 'In production', color: '#fdab3d' },
    { id: 'done', label: 'Delivered', color: '#00c875' }
  ];
  const epState = (ep) => App.isDelivered(ep) ? 'done' : App.inProduction(ep) ? 'active' : 'pending';
  const stateOf = (id) => SHOW_STATES.find(s => s.id === id) || SHOW_STATES[0];

  function showState(eps) {
    if (!eps.length) return 'pending';
    if (eps.every(App.isDelivered)) return 'done';
    return eps.some(App.inProduction) ? 'active' : 'pending';
  }
  const liveOf = (ep) => { const m = App.epMilestone(ep, App.LIVE_KEY); return m ? m.date : null; };

  /* ================================================================ contexts */

  /* ---- Timeline / Board: production breakdown ----
     The episodes the toolbar filters leave on screen, task by task. The
     department and owner filters carry over as the starting selection, so
     the export opens on what's showing and can be widened from there. */
  function productionCtx() {
    const view = App.state.view;
    const eps = App.visibleEpisodes().slice().sort((a, b) => {
      const sa = App.show(a.showId).name, sb = App.show(b.showId).name;
      return sa.localeCompare(sb) || (a.index || 0) - (b.index || 0);
    });
    if (!eps.length) return { empty: 'No episodes match the current filters — there’s nothing to export.' };
    const shows = [...new Set(eps.map(e => e.showId))].map(id => App.show(id));
    const f = App.state.filters;

    // only what these episodes actually contain is worth offering as a filter
    const depts = [], owners = {};
    let lo = '9999-99-99', hi = '0000-00-00';
    eps.forEach(ep => {
      App.subitems(ep).forEach(su => {
        if (!depts.includes(su.dept)) depts.push(su.dept);
        if (su.assignee) owners[su.assignee] = 1;
        if (su.start < lo) lo = su.start;
        if (su.due > hi) hi = su.due;
      });
      const fin = App.epFinal(ep); if (fin > hi) hi = fin;
    });
    const order = Object.keys(App.DEPARTMENTS);
    depts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const people = peopleOptions(Object.keys(owners).map(App.person).filter(Boolean));
    people.push({ id: '_none', label: 'Unassigned', group: 'Nobody yet', color: '#777' });

    const one = shows.length === 1 ? shows[0] : null;
    return {
      kind: 'production',
      source: view === 'board' ? 'Board' : view === 'dashboard' ? 'Dashboard' : 'Timeline',
      what: 'Production breakdown',
      title: one ? one.name : 'Production Breakdown',
      subtitle: one ? 'Production breakdown' : shows.map(s => s.name).join(' · '),
      accent: one ? one.color : null,
      fileBase: (one ? (one.prefix || one.name) : 'productions') + '-breakdown',
      orient: 'landscape',
      span: { from: lo, to: hi },
      filters: {
        dept: { label: 'Departments', options: depts.map(d => ({ id: d, label: App.dept(d).label, color: App.dept(d).color })),
                sel: f.dept.length ? f.dept.filter(d => depts.includes(d)) : null },
        person: { label: 'People', options: people, sel: f.person.length ? f.person.slice() : null },
        status: { label: 'Status', options: STATUS_OPTS() }
      },
      fields: [
        { key: 'summary', label: 'Episode summary', adv: true, hint: 'One line per episode: status, progress, delivery and live' },
        { key: 'milestones', label: 'Delivery & live dates', simple: true, adv: true },
        { key: 'dept', label: 'Department', simple: true, adv: true },
        { key: 'owner', label: 'Owner', simple: true, adv: true },
        { key: 'start', label: 'Start', simple: true, adv: true },
        { key: 'due', label: 'Due', simple: true, adv: true },
        { key: 'status', label: 'Status', simple: true, adv: true },
        { key: 'days', label: 'Working days', adv: true },
        { key: 'revisions', label: 'Revisions', adv: true },
        { key: 'deps', label: 'Depends on', adv: true },
        { key: 'flags', label: 'Flags (overdue, blocked, holiday)', adv: true },
        { key: 'bars', label: 'Schedule bars', adv: true, pdfOnly: true, hint: 'A small Gantt bar beside each task — PDF only' }
      ],
      build: (o) => buildProduction(eps, shows, o)
    };
  }

  function buildProduction(eps, shows, o) {
    const F = o.fields, t0 = today();
    const cols = [
      { key: 'show', label: 'Show', pdf: false },
      { key: 'episode', label: 'Episode', pdf: false },
      { key: 'task', label: 'Task', w: 'wide' },
      F.dept && { key: 'dept', label: 'Department', nowrap: true },
      F.owner && { key: 'owner', label: 'Owner', nowrap: true },
      F.start && { key: 'start', label: 'Start', nowrap: true },
      F.due && { key: 'due', label: 'Due', nowrap: true },
      F.days && { key: 'days', label: 'Days', align: 'r' },
      F.status && { key: 'status', label: 'Status' },
      F.revisions && { key: 'revisions', label: 'Revisions', align: 'c' },
      F.deps && { key: 'deps', label: 'Depends on', w: 'wide' },
      F.flags && { key: 'flags', label: 'Flags' },
      F.bars && o.format === 'pdf' && { key: 'bars', label: '', csv: false, w: 'bars' }
    ].filter(Boolean);

    const from = o.from, to = o.to;
    // the bar column's own axis: the chosen range, or the span of what's in it
    const rows = [], summary = [];
    let taskCount = 0, epCount = 0;
    const keep = (su) => o.dept(su.dept) && o.person(su.assignee || '_none') && o.status(su.status) && overlaps(su.start, su.due, from, to);

    eps.forEach(ep => {
      const show = App.show(ep.showId);
      const subs = App.subitems(ep).filter(keep).sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
      const ms = F.milestones ? App.epMilestones(ep).filter(m => overlaps(m.date, m.date, from, to)) : [];
      if (!subs.length && !ms.length) return;
      epCount++;

      const live = App.epMilestone(ep, App.LIVE_KEY), del = App.epMilestone(ep, 'delivery_date');
      summary.push({ cells: {
        show: cell(show.name), episode: cell(ep.code),
        title: cell(ep.title),
        status: cell(App.epStatusLabel(ep)),
        progress: cell(App.progressPct(ep) + '%', '<span class="prog"><i style="width:' + App.progressPct(ep) + '%;background:' + show.color + '"></i></span> ' + App.progressPct(ep) + '%'),
        start: cell(App.epStart(ep), esc(fmtY(App.epStart(ep)))),
        delivery: cell(del ? del.date : '', esc(del ? fmtY(del.date) : '—')),
        live: cell(live ? live.date : '', esc(live ? fmtY(live.date) : '—')),
        slip: cell(live && live.slipDays > 0 ? '+' + live.slipDays + 'd late' : 'On time',
          live && live.slipDays > 0 ? '<b class="bad">+' + live.slipDays + 'd late</b>' : '<span class="ok">On time</span>')
      } });

      rows.push({ group: ep.code + ' · ' + ep.title, sub: show.name + ' · ' + App.epStatusLabel(ep), color: show.color });
      const cal = App.showCalendar(show);
      subs.forEach(su => {
        taskCount++;
        const owner = su.assignee && App.person(su.assignee);
        const rev = App.taskRevisions(ep, su.key);
        const flags = [];
        if (su.status !== 'approved' && su.due < t0) flags.push('Overdue');
        if (App.isRiskBlocked(ep, su.key)) flags.push('Blocked');
        if (cal && App.hasHolidayClash(ep, su)) flags.push('Holiday clash');
        const st = App.status(su.status), d = App.dept(su.dept);
        rows.push({ bar: { a: su.start, b: su.due, color: d.color }, cells: {
          show: cell(show.name), episode: cell(ep.code + ' ' + ep.title),
          task: cell(su.name),
          dept: cell(d.label, dot(d.color) + esc(d.label)),
          owner: cell(owner ? owner.name : 'Unassigned', owner ? esc(owner.name) : '<span class="muted">Unassigned</span>'),
          start: cell(su.start, esc(fmt(su.start))),
          due: cell(su.due, esc(fmt(su.due))),
          days: cell(workDays(su.start, su.due, cal, { dept: su.dept, person: su.assignee })),
          status: cell(st.label, pill(st.label, st.color, st.ink)),
          revisions: cell(rev.max ? rev.used + ' of ' + rev.max : '', rev.max ? esc(rev.used + ' / ' + rev.max) : '<span class="muted">—</span>'),
          deps: cell(su.deps.map(k => { const x = App.subitems(ep).find(s => s.key === k); return x ? x.name : k; }).join(', ')),
          flags: cell(flags.join(', '), flags.map(x => '<b class="flag">' + esc(x) + '</b>').join(' '))
        } });
      });
      ms.forEach(m => {
        rows.push({ milestone: true, bar: { a: m.date, b: m.date, color: show.color, ms: true }, cells: {
          show: cell(show.name), episode: cell(ep.code + ' ' + ep.title),
          task: cell(m.name, '◆ ' + esc(m.name)),
          dept: cell('Milestone', '<span class="muted">Milestone</span>'),
          owner: cell(''), start: cell(m.date, esc(fmt(m.date))), due: cell(m.date, esc(fmt(m.date))),
          days: cell(''), status: cell(m.slipDays > 0 ? 'At risk (+' + m.slipDays + 'd)' : 'On track',
            m.slipDays > 0 ? '<b class="bad">At risk · +' + m.slipDays + 'd</b>' : '<span class="ok">On track</span>'),
          revisions: cell(''), deps: cell(''), flags: cell('')
        } });
      });
    });

    /* Bars are drawn once the axis is known. With a date range chosen every
       episode shares it, so they line up against each other; across the whole
       schedule each episode gets its own, or a year-long axis would squash a
       week's task to a dot. */
    if (F.bars && o.format === 'pdf') {
      const draw = (list, a, b) => {
        if (!a || !b) return;
        const span = Math.max(1, App.diffDays(b, a) + 1);
        const pct = (iso) => Math.max(0, Math.min(100, App.diffDays(iso, a) / span * 100));
        list.forEach(r => {
          if (!r.bar) return;
          const x = pct(r.bar.a), y = pct(App.shiftIso(r.bar.b, 1));
          r.cells.bars = cell('', '<span class="track">' + (r.bar.ms
            ? '<i class="ms" style="left:' + x + '%;background:' + r.bar.color + '"></i>'
            : '<i style="left:' + x + '%;width:' + Math.max(0.8, y - x) + '%;background:' + r.bar.color + '"></i>') +
            (t0 >= a && t0 <= b ? '<b class="now" style="left:' + pct(t0) + '%"></b>' : '') + '</span>');
        });
      };
      const bc = cols.find(c => c.key === 'bars');
      if (from && to) {
        draw(rows, from, to);
        if (bc) bc.labelH = '<span class="axis"><span>' + esc(fmt(from)) + '</span><span>' + esc(fmt(to)) + '</span></span>';
      } else {
        let grp = null, list = [];
        const flush = () => {
          if (!grp || !list.length) return;
          const a = list.reduce((m, r) => r.bar.a < m ? r.bar.a : m, list[0].bar.a);
          const b = list.reduce((m, r) => r.bar.b > m ? r.bar.b : m, list[0].bar.b);
          draw(list, a, b);
          grp.sub += ' · ' + range(a, b);
        };
        rows.forEach(r => { if (r.group) { flush(); grp = r; list = []; } else if (r.bar) list.push(r); });
        flush();
        if (bc) bc.label = 'Episode schedule';
      }
    }

    const blocks = [];
    if (F.summary) blocks.push({ kind: 'table', title: 'Episode summary', columns: [
      { key: 'show', label: 'Show', pdf: shows.length > 1 }, { key: 'episode', label: 'Episode' }, { key: 'title', label: 'Title', w: 'wide' },
      { key: 'status', label: 'Status', w: 'wide' }, { key: 'progress', label: 'Progress' }, { key: 'start', label: 'Starts', nowrap: true },
      { key: 'delivery', label: 'Delivery', nowrap: true }, { key: 'live', label: 'Live', nowrap: true }, { key: 'slip', label: 'Schedule' }
    ], rows: summary, empty: 'No episodes in this selection.' });
    blocks.push({ kind: 'table', title: F.summary ? 'Tasks' : null, columns: cols, rows,
      empty: 'Nothing matches these options — widen the date range or tick more departments, people or statuses.' });

    return {
      meta: [
        ['Shows', shows.map(s => s.name).join(', ')],
        ['Dates', from || to ? range(from, to) : 'Whole schedule'],
        ['Contents', plural(epCount, 'episode') + ' · ' + plural(taskCount, 'task')]
      ],
      count: taskCount + ' task' + (taskCount === 1 ? '' : 's') + ' across ' + plural(epCount, 'episode'),
      blocks
    };
  }

  /* ---- Shows window: the shows listed ---- */
  App.exportShowsCtx = function (list, filterNote) {
    const shows = list.slice();
    if (!shows.length) return { empty: 'No shows are listed — clear the Shows filters to export them.' };
    const info = shows.map(s => {
      const eps = App.state.data.episodes.filter(e => e.showId === s.id && !e.archived)
        .sort((a, b) => (a.index || 0) - (b.index || 0));
      const starts = eps.map(App.epStart).filter(x => x !== '9999-99-99').sort();
      const lives = eps.map(liveOf).filter(Boolean).sort();
      const { ids, lead } = App.deptTeam(s, App.roleSlot('producer'));
      const producers = (lead ? [lead].concat(ids.filter(i => i !== lead)) : ids).map(App.person).filter(Boolean);
      return {
        s, eps, producers,
        start: starts[0] || null,
        live: lives[lives.length - 1] || null,
        next: lives.find(d => d >= today()) || null,
        finish: App.showPredictedFinish(s.id) || null,
        progress: eps.length ? Math.round(eps.reduce((a, e) => a + App.progressPct(e), 0) / eps.length) : 0,
        state: showState(eps),
        crew: App.showTeamSize(s),
        team: teamPeople(s)
      };
    });
    let lo = null, hi = null;
    info.forEach(i => { if (i.start && (!lo || i.start < lo)) lo = i.start; const e = i.live || i.finish; if (e && (!hi || e > hi)) hi = e; });
    const people = {};
    info.forEach(i => i.team.forEach(p => { people[p.id] = p; }));

    return {
      kind: 'shows', source: 'Shows', what: 'Shows overview',
      title: 'Shows Overview', subtitle: filterNote || plural(shows.length, 'current show'),
      fileBase: 'shows-overview', orient: 'landscape',
      span: lo && hi ? { from: lo, to: hi } : null,
      filters: {
        person: { label: 'People on the team', options: peopleOptions(Object.values(people)) },
        status: { label: 'Show status', options: SHOW_STATES }
      },
      fields: [
        { key: 'brand', label: 'Brand', simple: true, adv: true },
        { key: 'series', label: 'Series / Season', simple: true, adv: true },
        { key: 'producer', label: 'Producer', simple: true, adv: true },
        { key: 'episodes', label: 'Episodes', simple: true, adv: true },
        { key: 'start', label: 'Starts', simple: true, adv: true },
        { key: 'live', label: 'Last live date', simple: true, adv: true },
        { key: 'status', label: 'Status', simple: true, adv: true },
        { key: 'progress', label: 'Progress', adv: true },
        { key: 'finish', label: 'Predicted finish', adv: true },
        { key: 'next', label: 'Next live date', adv: true },
        { key: 'crew', label: 'Crew', adv: true },
        { key: 'depts', label: 'Departments', adv: true },
        { key: 'iters', label: 'Plan iterations', adv: true },
        { key: 'eplist', label: 'Episode list per show', adv: true, hint: 'Every episode with its status and dates' }
      ],
      build: (o) => {
        const F = o.fields;
        const hits = info.filter(i => o.status(i.state) &&
          (o.allPeople || i.team.some(p => o.person(p.id))) &&
          overlaps(i.start, i.live || i.finish, o.from, o.to));
        const cols = [
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Show', w: 'wide' },
          F.brand && { key: 'brand', label: 'Brand' }, F.series && { key: 'series', label: 'Season' },
          F.producer && { key: 'producer', label: 'Producer' }, F.episodes && { key: 'episodes', label: 'Eps', align: 'r' },
          F.crew && { key: 'crew', label: 'Crew', align: 'r' }, F.depts && { key: 'depts', label: 'Departments', w: 'wide' },
          F.start && { key: 'start', label: 'Starts', nowrap: true }, F.next && { key: 'next', label: 'Next live', nowrap: true },
          F.live && { key: 'live', label: 'Last live', nowrap: true }, F.finish && { key: 'finish', label: 'Predicted finish', nowrap: true },
          F.progress && { key: 'progress', label: 'Progress' }, F.status && { key: 'status', label: 'Status' },
          F.iters && { key: 'iters', label: 'Iterations', align: 'r' }
        ].filter(Boolean);
        const rows = hits.map(i => {
          const st = stateOf(i.state), s = i.s;
          const late = i.finish && i.live && i.finish > i.live;
          return { cells: {
            code: cell(s.prefix || '', pill(s.prefix || '—', s.color)),
            name: cell(s.name, '<b>' + esc(s.name) + '</b>'),
            brand: cell(s.brand || ''), series: cell(s.series || ''),
            producer: cell(i.producers.map(p => p.name).join(', ') || '', i.producers.length ? esc(i.producers.map(p => p.name).join(', ')) : '<span class="muted">None</span>'),
            episodes: cell(i.eps.length), crew: cell(i.crew),
            depts: cell(App.showDepts(s).map(d => App.dept(d).label).join(', ')),
            start: cell(i.start || '', esc(fmtY(i.start))), next: cell(i.next || '', esc(fmtY(i.next))),
            live: cell(i.live || '', esc(fmtY(i.live))),
            finish: cell(i.finish || '', i.finish ? (late ? '<b class="bad">' + esc(fmtY(i.finish)) + '</b>' : esc(fmtY(i.finish))) : '—'),
            progress: cell(i.progress + '%', '<span class="prog"><i style="width:' + i.progress + '%;background:' + s.color + '"></i></span> ' + i.progress + '%'),
            status: cell(st.label, pill(st.label, st.color)),
            iters: cell((s.iterations || []).length || 1)
          } };
        });
        const blocks = [{ kind: 'table', title: F.eplist ? 'Shows' : null, columns: cols, rows, empty: 'No shows match these options.' }];
        if (F.eplist) {
          const erows = [];
          hits.forEach(i => {
            if (!i.eps.length) return;
            erows.push({ group: i.s.name, sub: plural(i.eps.length, 'episode'), color: i.s.color });
            i.eps.forEach(ep => {
              const st = stateOf(epState(ep)), live = App.epMilestone(ep, App.LIVE_KEY);
              erows.push({ cells: {
                show: cell(i.s.name), episode: cell(ep.code), title: cell(ep.title, esc(ep.title)),
                status: cell(App.epStatusLabel(ep), pill(st.label, st.color) + (App.epStatusLabel(ep).includes('·') ? ' <span class="muted">' + esc(App.epStatusLabel(ep).replace(/^[^·]*·\s*/, '')) + '</span>' : '')),
                start: cell(App.epStart(ep), esc(fmtY(App.epStart(ep)))),
                live: cell(live ? live.date : '', live ? esc(fmtY(live.date)) + (live.slipDays > 0 ? ' <b class="bad">+' + live.slipDays + 'd</b>' : '') : '—'),
                progress: cell(App.progressPct(ep) + '%')
              } });
            });
          });
          blocks.push({ kind: 'table', title: 'Episodes', columns: [
            { key: 'show', label: 'Show', pdf: false }, { key: 'episode', label: 'Episode' }, { key: 'title', label: 'Title', w: 'wide' },
            { key: 'status', label: 'Status', w: 'wide' }, { key: 'start', label: 'Starts', nowrap: true },
            { key: 'live', label: 'Live', nowrap: true }, { key: 'progress', label: 'Progress', align: 'r' }
          ], rows: erows, empty: 'No episodes.' });
        }
        return {
          meta: [['Listed', filterNote || 'All current shows'], ['Dates', o.from || o.to ? range(o.from, o.to) : 'Any'],
                 ['Contents', plural(hits.length, 'show')]],
          count: plural(hits.length, 'show'),
          blocks
        };
      }
    };
  };

  /* ---- one show: Edit Show / Edit Pipeline ----
     `snap` is a plain description of the show as it stands in the dialog —
     saved or still a draft — so an unsaved plan exports as what's on screen,
     and what isn't filled in yet is listed rather than silently missing.
       { id, isNew, unsaved, name, code, brand, series, type, color,
         pipeline, team, calendar,
         episodes: [{ code, title, start, live, liveSet, state, statusLabel,
                      progress, locked, slip, ep }],
         iterations } */
  App.exportShowSnap = function (show) {
    const eps = App.state.data.episodes.filter(e => e.showId === show.id && !e.archived)
      .sort((a, b) => (a.index || 0) - (b.index || 0));
    return {
      id: show.id, isNew: false, unsaved: false,
      name: show.name, code: show.prefix || '', brand: show.brand || '', series: show.series || '',
      type: show.type || 'animation', color: show.color,
      pipeline: show.pipeline || App.defaultPipelineFor(show.type),
      team: show.team || {}, calendar: show.calendar || null, iterations: show.iterations || [],
      episodes: eps.map(ep => {
        const live = App.epMilestone(ep, App.LIVE_KEY);
        return {
          code: ep.code, title: ep.title, start: App.epStart(ep), live: live ? live.date : null,
          liveSet: !!(ep.milestones && ep.milestones[App.LIVE_KEY]), state: epState(ep),
          statusLabel: App.epStatusLabel(ep), progress: App.progressPct(ep), locked: App.inProduction(ep),
          slip: live ? live.slipDays : 0, ep
        };
      })
    };
  };

  function snapSpan(snap) {
    const s = snap.episodes.map(e => e.start).filter(x => x && x !== '9999-99-99').sort();
    const l = snap.episodes.map(e => e.live).filter(Boolean).sort();
    return s.length ? { from: s[0], to: l[l.length - 1] || s[s.length - 1] } : null;
  }

  // what a show still needs before it's fully set up — the "unfinished" list
  function checklist(snap) {
    const out = [];
    const add = (lvl, label, detail) => out.push({ lvl, label, detail });
    const pipe = snap.pipeline || [];
    const show = { team: snap.team || {}, pipeline: pipe };
    if (snap.unsaved) add('info', 'Unsaved changes', snap.isNew ? 'This show hasn’t been created yet — this is the plan as drafted.' : 'This export shows the edits on screen, which haven’t been saved.');
    add(snap.name && snap.code ? 'ok' : 'todo', 'Show name and content code', snap.name && snap.code ? snap.name + ' · ' + snap.code : 'Still needed: ' + [!snap.name && 'name', !snap.code && 'code'].filter(Boolean).join(' and '));
    add(snap.brand && snap.series ? 'ok' : 'todo', 'Brand and season', snap.brand && snap.series ? snap.brand + ' · ' + snap.series : 'Not set: ' + [!snap.brand && 'brand', !snap.series && 'season'].filter(Boolean).join(' and '));
    if (!pipe.length) add('todo', 'Pipeline', 'No tasks yet');
    else if (!App.topoSort(pipe)) add('todo', 'Pipeline', 'The dependencies loop back on themselves — fix the cycle');
    else add('ok', 'Pipeline', plural(pipe.length, 'task') + ' across ' + plural(App.pipelineDepts(pipe).length, 'department'));
    ['producer', 'director'].forEach(r => {
      const n = App.deptTeam(show, App.roleSlot(r)).ids.length;
      add(n ? 'ok' : 'todo', App.role(r).label, n ? App.deptTeam(show, App.roleSlot(r)).ids.map(id => App.person(id).name).join(', ') : 'Nobody assigned');
    });
    const unstaffed = App.pipelineDepts(pipe).filter(d => !App.deptTeam(show, d).ids.length);
    add(unstaffed.length ? 'todo' : 'ok', 'Department staffing', unstaffed.length
      ? 'No one on ' + unstaffed.map(d => App.dept(d).label).join(', ')
      : 'Every department in the pipeline has someone');
    const eps = snap.episodes;
    if (!eps.length) add('todo', 'Episodes', 'None planned');
    else {
      const unnamed = eps.filter(e => /^episode \d+$/i.test(e.title || '')).length;
      add(unnamed ? 'todo' : 'ok', 'Episode titles', unnamed ? unnamed + ' of ' + eps.length + ' still have placeholder titles' : 'All ' + eps.length + ' named');
      const noLive = eps.filter(e => !e.liveSet).length;
      add(noLive ? 'info' : 'ok', 'Live dates', noLive ? noLive + ' of ' + eps.length + ' follow the plan rather than a committed date' : 'All committed');
      const late = eps.filter(e => e.slip > 0);
      if (late.length) add('todo', 'Behind schedule', late.map(e => e.code + ' +' + e.slip + 'd').join(', '));
    }
    const cal = snap.calendar ? App.normCal(snap.calendar) : null;
    add(cal && (cal.region !== 'none' || cal.offDays.length || !cal.workWeekends) ? 'ok' : 'info', 'Working days & holidays',
      !cal ? 'Not set up — every calendar day counts as a working day'
        : [cal.workWeekends ? '7-day week' : 'Mon–Fri', cal.region === 'none' ? 'no national holidays' : cal.region.toUpperCase() + ' holidays', plural(cal.offDays.length, 'time-off entry').replace('entrys', 'entries')].join(' · '));
    if (snap.id) {
      const open = [];
      eps.forEach(e => e.ep && App.subitems(e.ep).forEach(su => { if (su.status !== 'approved' && !su.assignee) open.push(su); }));
      add(open.length ? 'todo' : 'ok', 'Task owners', open.length ? plural(open.length, 'open task') + ' without an owner' : 'Every open task has an owner');
      const cl = App.holidayClashes(snap.id);
      if (cl.length) add('todo', 'Holiday clashes', plural(cl.length, 'task') + ' run into time off');
    }
    return out;
  }

  App.exportShowCtx = function (getSnap, source) {
    const snap0 = getSnap();
    const pipe = snap0.pipeline || [];
    const depts = App.pipelineDepts(pipe);
    const team = teamPeople({ team: snap0.team || {}, pipeline: pipe });
    return {
      kind: 'show', source: source || 'Edit Show', what: 'Show breakdown',
      title: snap0.name || 'Untitled show', subtitle: 'Show breakdown' + (snap0.unsaved ? ' · unsaved draft' : ''),
      accent: snap0.color || null, fileBase: (snap0.code || snap0.name || 'show') + '-show-breakdown', orient: 'portrait',
      span: snapSpan(snap0),
      filters: {
        dept: { label: 'Departments', options: depts.map(d => ({ id: d, label: App.dept(d).label, color: App.dept(d).color })) },
        person: { label: 'People', options: peopleOptions(team) },
        status: { label: 'Episode status', options: SHOW_STATES }
      },
      fields: [
        { key: 'checklist', label: 'Unfinished sections', simple: true, adv: true, hint: 'What still needs filling in' },
        { key: 'team', label: 'Production team', simple: true, adv: true },
        { key: 'episodes', label: 'Episodes & live dates', simple: true, adv: true },
        { key: 'pipeline', label: 'Pipeline', simple: true, adv: true },
        { key: 'pl_detail', label: 'Pipeline: revisions, batching & dependencies', adv: true },
        { key: 'holidays', label: 'Holidays & time off', adv: true },
        { key: 'iterations', label: 'Plan iterations', adv: true }
      ],
      build: (o) => buildShow(getSnap(), o)
    };
  };

  function buildShow(snap, o) {
    const F = o.fields, blocks = [];
    const pipe = snap.pipeline || [];
    const show = { team: snap.team || {}, pipeline: pipe };
    const span = snapSpan(snap);
    const cal = snap.calendar ? App.normCal(snap.calendar) : null;
    const eps = snap.episodes.filter(e => o.status(e.state) && overlaps(e.start, e.live, o.from, o.to));
    const done = snap.episodes.filter(e => e.state === 'done').length;

    blocks.push({ kind: 'kv', title: 'Overview', rows: [
      ['Show', snap.name || '— not named yet —'], ['Content code', snap.code || '—'],
      ['Brand', snap.brand || '—'], ['Series / season', snap.series || '—'],
      ['Type', snap.type === 'live_action' ? 'Live action' : 'Animation'],
      ['Episodes', snap.episodes.length + (done ? ' · ' + done + ' delivered' : '')],
      ['Schedule', span ? range(span.from, span.to) : '—'],
      ['Working week', !cal ? 'Every day (no calendar set)' : cal.workWeekends ? '7 days' : 'Monday – Friday'],
      ['National holidays', !cal || cal.region === 'none' ? 'None' : cal.region === 'uk' ? 'United Kingdom' : 'United States']
    ] });

    if (F.checklist) blocks.push({ kind: 'check', title: 'Unfinished sections', items: checklist(snap) });

    if (F.team) {
      const rows = [];
      App.teamSlots(show).forEach(slot => {
        if (!App.isRoleSlot(slot) && !o.dept(slot)) return;
        const { ids, lead } = App.deptTeam(show, slot);
        const who = ids.filter(id => o.allPeople || o.person(id)).map(App.person).filter(Boolean);
        if (!o.allPeople && !who.length) return;
        const color = App.isRoleSlot(slot) ? '#8a90a0' : App.dept(slot).color;
        rows.push({ cells: {
          slot: cell(App.slotLabel(slot), dot(color) + '<b>' + esc(App.slotLabel(slot)) + '</b>'),
          lead: cell(lead && App.person(lead) ? App.person(lead).name : '', lead && App.person(lead) ? esc(App.person(lead).name) : '<span class="muted">—</span>'),
          people: cell(who.map(p => p.name).join(', ') || 'Unstaffed', who.length ? esc(who.map(p => p.name).join(', ')) : '<b class="bad">Unstaffed</b>'),
          count: cell(who.length)
        } });
      });
      blocks.push({ kind: 'table', title: 'Production team', columns: [
        { key: 'slot', label: 'Department / role' }, { key: 'lead', label: 'Lead' },
        { key: 'people', label: 'People', w: 'wide' }, { key: 'count', label: 'Staff', align: 'r' }
      ], rows, empty: 'No team for these filters.' });
    }

    if (F.episodes) blocks.push({ kind: 'table', title: 'Episodes', columns: [
      { key: 'episode', label: '#' }, { key: 'title', label: 'Title', w: 'wide' }, { key: 'status', label: 'Status', w: 'wide' },
      { key: 'start', label: 'Starts', nowrap: true }, { key: 'live', label: 'Live', nowrap: true }, { key: 'progress', label: 'Progress', align: 'r' }
    ], rows: eps.map((e, i) => {
      const st = stateOf(e.state);
      const titleMissing = /^episode \d+$/i.test(e.title || '');
      return { cells: {
        episode: cell(e.code || String(i + 1)),
        title: cell(e.title, esc(e.title) + (titleMissing ? ' <b class="todo">placeholder</b>' : '') + (e.locked ? ' <span class="muted">🔒</span>' : '')),
        status: cell(e.statusLabel || st.label, pill(st.label, st.color) + (e.statusLabel && e.statusLabel.includes('·') ? ' <span class="muted">' + esc(e.statusLabel.replace(/^[^·]*·\s*/, '')) + '</span>' : '')),
        start: cell(e.start, esc(fmtY(e.start))),
        live: cell(e.live || '', e.live ? esc(fmtY(e.live)) + (e.liveSet ? '' : ' <span class="muted">(plan)</span>') + (e.slip > 0 ? ' <b class="bad">+' + e.slip + 'd</b>' : '') : '<b class="todo">not set</b>'),
        progress: cell((e.progress || 0) + '%')
      } };
    }), empty: snap.episodes.length ? 'No episodes match these options.' : 'No episodes planned yet.' });

    if (F.pipeline) {
      const name = (k) => { const t = pipe.find(x => x.key === k); return t ? t.name : k; };
      const cols = [{ key: 'n', label: '#', align: 'r' }, { key: 'task', label: 'Task', w: 'wide' }, { key: 'dept', label: 'Department' },
        { key: 'days', label: 'Days', align: 'r' }];
      if (F.pl_detail) cols.push({ key: 'rev', label: 'Revisions' }, { key: 'batch', label: 'Batch' }, { key: 'deps', label: 'Depends on', w: 'wide' });
      // in running order — topoSort hands back keys
      const ks = App.topoSort(pipe);
      const order = ks ? ks.map(k => pipe.find(t => t.key === k)) : pipe;
      const rows = order.filter(t => o.dept(t.dept)).map((t, i) => {
        const d = App.dept(t.dept);
        const revDays = (t.revDays || []).slice(0, t.maxRev || 0);
        return { cells: {
          n: cell(i + 1), task: cell(t.name || t.key, t.name ? esc(t.name) : '<b class="todo">unnamed</b>'),
          dept: cell(d.label, dot(d.color) + esc(d.label)),
          days: cell(t.days || '', t.days ? String(t.days) : '<b class="todo">—</b>'),
          rev: cell(t.maxRev ? t.maxRev + ' (' + revDays.join('+') + 'd)' : '', t.maxRev ? esc(t.maxRev + ' × ' + revDays.join(' + ') + 'd') + ' <span class="muted">+ reviews</span>' : '<span class="muted">—</span>'),
          batch: cell(App.batchCfg(t) ? App.batchLabel(t) : ''),
          deps: cell((t.deps || []).map(name).join(', '))
        } };
      });
      blocks.push({ kind: 'table', title: 'Pipeline', sub: plural(pipe.length, 'task'), columns: cols, rows, empty: pipe.length ? 'No tasks in the ticked departments.' : 'No tasks yet.' });
    }

    if (F.holidays) {
      // the status ticks here are episode states, which don't apply to holidays
      const h = holidayRows({ calendar: snap.calendar, team: snap.team }, span, Object.assign({}, o, { status: () => true }), false);
      blocks.push({ kind: 'table', title: 'Holidays & time off', columns: h.columns, rows: h.rows,
        empty: cal ? 'No holidays or time off in this period.' : 'No working-days calendar set up for this show.' });
    }

    if (F.iterations && (snap.iterations || []).length) blocks.push({ kind: 'table', title: 'Plan iterations', columns: [
      { key: 'n', label: 'Iteration', align: 'r' }, { key: 'at', label: 'Date', nowrap: true }, { key: 'by', label: 'By' },
      { key: 'note', label: 'What changed', w: 'wide' }, { key: 'finish', label: 'Predicted finish', nowrap: true }, { key: 'delta', label: 'Change', align: 'r' }
    ], rows: snap.iterations.map(it => ({ cells: {
      n: cell(it.n), at: cell(it.at, esc(fmtY(it.at))), by: cell(it.by || ''), note: cell(it.note || ''),
      finish: cell(it.finish || '', esc(fmtY(it.finish))),
      delta: cell(it.delta == null ? '' : (it.delta > 0 ? '+' : '') + it.delta + 'd',
        it.delta == null ? '<span class="muted">—</span>' : it.delta > 0 ? '<b class="bad">+' + it.delta + 'd</b>' : it.delta < 0 ? '<span class="ok">' + it.delta + 'd</span>' : '0d')
    } })) });

    const todo = checklist(snap).filter(c => c.lvl === 'todo').length;
    return {
      meta: [
        ['Show', (snap.name || 'Untitled') + (snap.code ? ' (' + snap.code + ')' : '')],
        ['Schedule', span ? range(span.from, span.to) : '—'],
        ['Setup', todo ? plural(todo, 'section') + ' unfinished' : 'Complete']
      ],
      count: plural(eps.length, 'episode') + ' · ' + plural(pipe.length, 'task') + (todo ? ' · ' + todo + ' unfinished' : ''),
      blocks
    };
  }

  /* ---- Working Days & Holidays ----
     National holidays inside the production's span, then each time-off
     entry, with who it keeps away. Shared with the show breakdown. */
  const HOL_TYPES = [
    { id: 'national', label: 'National holiday', color: '#ff6b6b' },
    { id: 'show', label: 'Whole production', color: '#ff9f6b' },
    { id: 'dept', label: 'Department', color: '#6c8cff' },
    { id: 'role', label: 'Role', color: '#b06cff' },
    { id: 'person', label: 'Person', color: '#29c2d6' }
  ];
  function holidayRows(snap, span, o, adv) {
    const cal = snap.calendar ? App.normCal(snap.calendar) : null;
    const columns = [
      { key: 'dates', label: 'Dates', nowrap: true }, { key: 'days', label: 'Working days', align: 'r' },
      { key: 'label', label: 'Holiday', w: 'wide' }, { key: 'type', label: 'Type' }, { key: 'who', label: 'Who’s off', w: 'wide' }
    ];
    if (adv) columns.push({ key: 'note', label: 'Note' });
    if (!cal) return { columns, rows: [], list: [] };
    const weekendOnly = App.makeCalendar({ workWeekends: cal.workWeekends }, null);
    const list = [];
    const from = o.from || (span && span.from), to = o.to || (span && span.to);
    if (cal.region !== 'none' && from && to) {
      const skip = new Set(cal.skipNational);
      App.nationalHolidays(cal.region, from, to).forEach(h => {
        const worked = skip.has(cal.region + ':' + h.date) || skip.has(h.date);
        if (worked && !adv) return;
        list.push({ type: 'national', start: h.date, end: h.date, label: h.name, who: 'Everyone', worked });
      });
    }
    cal.offDays.forEach(x => {
      if (!overlaps(x.start, x.end, o.from, o.to)) return;
      let who = 'Everyone', dept = null, person = null;
      if (x.scope === 'dept') { who = App.dept(x.target).label + ' department'; dept = x.target; }
      else if (x.scope === 'role') { who = 'All ' + App.role(x.target).label + 's'; dept = App.roleDept(x.target); }
      else if (x.scope === 'person') {
        const p = App.person(x.target); person = x.target;
        who = p ? p.name + ' · ' + personGroup(p) : 'Someone no longer on the team';
        dept = p ? App.roleDept(p.role) : null;
      }
      list.push({ type: x.scope, start: x.start, end: x.end, label: x.label || '', who, dept, person });
    });
    const rows = list
      .filter(r => o.status(r.type) && (!r.dept || o.dept(r.dept)) && (!r.person || o.person(r.person)))
      .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
      .map(r => {
        const t = HOL_TYPES.find(x => x.id === r.type);
        const days = workDays(r.start, r.end, weekendOnly, {});
        return { tone: r.worked ? 'dim' : null, cells: {
          dates: cell(r.start === r.end ? r.start : r.start + ' to ' + r.end, esc(range(r.start, r.end))),
          days: cell(r.worked ? 0 : days, r.worked ? '<span class="muted">0</span>' : String(days)),
          label: cell(r.label || (r.type === 'national' ? 'National holiday' : 'Time off'), r.label ? esc(r.label) : '<span class="muted">Time off</span>'),
          type: cell(t.label, dot(t.color) + esc(t.label)),
          who: cell(r.who),
          note: cell(r.worked ? 'Worked through' : '', r.worked ? '<span class="muted">Worked through</span>' : '')
        } };
      });
    return { columns, rows, list };
  }

  App.exportHolidaysCtx = function (getSnap, source) {
    const snap0 = getSnap();
    const team = teamPeople({ team: snap0.team || {}, pipeline: snap0.pipeline || [] });
    const depts = App.pipelineDepts(snap0.pipeline || []);
    return {
      kind: 'holidays', source: source || 'Working Days & Holidays', what: 'Holidays breakdown',
      title: (snap0.name || 'Untitled show'), subtitle: 'Working days & holidays' + (snap0.unsaved ? ' · unsaved draft' : ''),
      accent: snap0.color || null, fileBase: (snap0.code || snap0.name || 'show') + '-holidays', orient: 'portrait',
      span: snapSpan(snap0),
      filters: {
        dept: { label: 'Departments', options: depts.map(d => ({ id: d, label: App.dept(d).label, color: App.dept(d).color })) },
        person: { label: 'People', options: peopleOptions(team) },
        status: { label: 'Type', options: HOL_TYPES }
      },
      fields: [
        { key: 'week', label: 'Working week summary', simple: true, adv: true },
        { key: 'list', label: 'Holidays & time off', simple: true, adv: true },
        { key: 'worked', label: 'Holidays worked through', adv: true },
        { key: 'people', label: 'Days off per person', adv: true },
        { key: 'clashes', label: 'Work that clashes', adv: true, hint: 'Open tasks that land on someone’s time off (saved shows only)' }
      ],
      build: (o) => {
        const snap = getSnap(), F = o.fields;
        const span = snapSpan(snap);
        const cal = snap.calendar ? App.normCal(snap.calendar) : null;
        const h = holidayRows(snap, span, o, !!F.worked);
        const blocks = [];
        const lost = h.rows.reduce((a, r) => a + (Number(r.cells.days.t) || 0), 0);
        if (F.week) blocks.push({ kind: 'kv', title: 'Working week', rows: [
          ['Production', (snap.name || 'Untitled') + (snap.code ? ' (' + snap.code + ')' : '')],
          ['Schedule', span ? range(span.from, span.to) : '—'],
          ['Working week', !cal ? 'Every day (no calendar set)' : cal.workWeekends ? '7 days — weekends are working days' : 'Monday – Friday'],
          ['National holidays', !cal || cal.region === 'none' ? 'None observed' : (cal.region === 'uk' ? 'United Kingdom' : 'United States') +
            (cal.skipNational.filter(x => x.indexOf(cal.region + ':') === 0).length ? ' · ' + plural(cal.skipNational.filter(x => x.indexOf(cal.region + ':') === 0).length, 'worked through') : '')],
          ['Entries', plural(h.rows.length, 'holiday / time-off entry').replace('entrys', 'entries') + ' · ' + plural(lost, 'working day')]
        ] });
        if (F.list) blocks.push({ kind: 'table', title: 'Holidays & time off', columns: h.columns, rows: h.rows,
          empty: cal ? 'Nothing in this period matches these options.' : 'This show has no working-days calendar yet.' });
        if (F.people && cal) {
          const from = o.from || (span && span.from), to = o.to || (span && span.to);
          const mk = App.makeCalendar(cal, snap.team);
          const wk = App.makeCalendar({ workWeekends: cal.workWeekends }, null);
          const rows = [];
          teamPeople({ team: snap.team || {}, pipeline: snap.pipeline || [] }).forEach(p => {
            if (!o.person(p.id)) return;
            const dept = App.roleDept(p.role);
            if (dept && !o.dept(dept)) return;
            let off = 0, nat = 0;
            if (from && to) for (let x = from, g = 0; x <= to && g < 1500; x = App.shiftIso(x, 1), g++) {
              if (wk.weekend(x)) continue;
              if (mk.national(x)) { nat++; continue; }
              if (mk.isOff(x, { dept, person: p.id })) off++;
            }
            rows.push({ cells: {
              person: cell(p.name, '<b>' + esc(p.name) + '</b>'), group: cell(personGroup(p)),
              nat: cell(nat), off: cell(off), total: cell(nat + off, '<b>' + (nat + off) + '</b>')
            } });
          });
          blocks.push({ kind: 'table', title: 'Days off per person', sub: from && to ? range(from, to) : '', columns: [
            { key: 'person', label: 'Person', w: 'wide' }, { key: 'group', label: 'Department / role' },
            { key: 'nat', label: 'National', align: 'r' }, { key: 'off', label: 'Time off', align: 'r' }, { key: 'total', label: 'Total days', align: 'r' }
          ], rows, empty: 'No one on the team matches these options.' });
        }
        if (F.clashes) {
          const cl = snap.id && !snap.unsaved ? App.holidayClashes(snap.id) : [];
          blocks.push({ kind: 'table', title: 'Work that clashes', columns: [
            { key: 'ep', label: 'Episode' }, { key: 'task', label: 'Task', w: 'wide' }, { key: 'owner', label: 'Owner' },
            { key: 'dates', label: 'Dates', nowrap: true }, { key: 'why', label: 'Clashes with', w: 'wide' }
          ], rows: cl.filter(c => o.dept(c.su.dept) && (!c.su.assignee || o.person(c.su.assignee)) && overlaps(c.su.start, c.su.due, o.from, o.to)).map(c => ({ cells: {
            ep: cell(c.ep.code), task: cell(c.su.name),
            owner: cell(c.su.assignee && App.person(c.su.assignee) ? App.person(c.su.assignee).name : 'Unassigned'),
            dates: cell(c.su.start + ' to ' + c.su.due, esc(range(c.su.start, c.su.due))),
            why: cell(c.reason + ' · ' + plural(c.days.length, 'day'))
          } })), empty: snap.unsaved ? 'Save the show to check its work against these holidays.' : 'No open work lands on time off.' });
        }
        return {
          meta: [['Production', snap.name || 'Untitled'], ['Dates', o.from || o.to ? range(o.from, o.to) : (span ? range(span.from, span.to) : '—')],
                 ['Contents', plural(h.rows.length, 'entry').replace('entrys', 'entries') + ' · ' + plural(lost, 'working day') + ' off']],
          count: plural(h.rows.length, 'entry').replace('entrys', 'entries'),
          blocks
        };
      }
    };
  };

  /* ================================================================ renderers */

  const DOC_CSS = `
  *{box-sizing:border-box}
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{margin:0;font:10.5px/1.4 Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d2230;background:#fff}
  .doc{padding:0}
  .hd{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding-bottom:12px;border-bottom:2px solid var(--acc);margin-bottom:14px}
  .hd h1{margin:0;font-size:21px;line-height:1.15;font-weight:800;letter-spacing:-.01em}
  .hd .sub{margin-top:3px;color:#5b6272;font-size:12px;font-weight:600}
  .hd .brand{font-size:9.5px;color:#8a90a0;text-align:right;white-space:nowrap}
  .hd .brand b{display:block;color:#1d2230;font-size:10.5px}
  .meta{display:flex;flex-wrap:wrap;gap:6px 22px;margin:0 0 16px;font-size:10px}
  .meta div span{color:#8a90a0;text-transform:uppercase;letter-spacing:.06em;font-size:8.5px;font-weight:700;display:block}
  .meta div b{font-weight:600}
  h2{font-size:12.5px;margin:18px 0 7px;font-weight:800;display:flex;align-items:baseline;gap:8px}
  h2 small{font-weight:500;color:#8a90a0;font-size:10px}
  .tw{width:100%}
  table{width:100%;border-collapse:collapse;font-size:10.5px}
  th{text-align:left;font-size:.81em;text-transform:uppercase;letter-spacing:.06em;color:#6b7282;font-weight:700;padding:.48em .67em;border-bottom:1px solid #cfd4de;background:#f4f6f9}
  td{padding:.43em .67em;border-bottom:1px solid #e8ebf0;vertical-align:middle}
  thead{display:table-header-group}
  tr{break-inside:avoid;page-break-inside:avoid}
  td.r,th.r{text-align:right} td.c,th.c{text-align:center}
  td.nw{white-space:nowrap}
  th.wide{min-width:11em}
  table.wrap td,table.wrap th,table.wrap td.nw{white-space:normal}
  table.wrap th.wide,table.wrap td.bars,table.wrap th.bars{min-width:0}
  table.wrap th{letter-spacing:.02em}
  table.squeeze td,table.squeeze th{overflow-wrap:anywhere;hyphens:auto;-webkit-hyphens:auto}
  tr.grp td{background:#f7f8fb;font-weight:800;font-size:11px;padding-top:8px;border-bottom:1px solid #cfd4de;border-left:3px solid var(--g)}
  tr.grp td small{font-weight:500;color:#6b7282;margin-left:8px;font-size:9.5px}
  tr.ms td{color:#3a4050;background:#fcfcfd}
  tr.dim td{color:#9aa0ad}
  .pill{display:inline-block;padding:.1em .7em;border-radius:9px;font-size:.86em;font-weight:700;white-space:nowrap}
  .dot{display:inline-block;width:.67em;height:.67em;border-radius:2px;margin-right:.45em;vertical-align:0}
  .muted{color:#9aa0ad}
  .bad{color:#d8364a} .ok{color:#0f9960;font-weight:600} .todo{color:#b76b00;font-size:9px;text-transform:uppercase;letter-spacing:.04em}
  .flag{display:inline-block;color:#d8364a;background:#fdecee;border-radius:4px;padding:0 .45em;font-size:.86em;margin-right:2px}
  .prog{display:inline-block;width:4em;height:5px;border-radius:3px;background:#e8ebf0;vertical-align:1px;overflow:hidden}
  .prog i{display:block;height:100%}
  td.bars,th.bars{width:28%;min-width:13em}
  .track{position:relative;display:block;height:10px;background:#f1f3f7;border-radius:3px}
  .track i{position:absolute;top:1px;bottom:1px;border-radius:2px}
  .track i.ms{width:8px;height:8px;top:1px;transform:translateX(-4px) rotate(45deg);border-radius:1px}
  .track .now{position:absolute;top:-2px;bottom:-2px;width:1px;background:#d8364a}
  .axis{display:flex;justify-content:space-between;font-weight:600;text-transform:none;letter-spacing:0}
  .kv{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1px solid #e1e5ec;border-radius:6px;overflow:hidden}
  .kv div{padding:6px 9px;border-bottom:1px solid #eef0f4;border-right:1px solid #eef0f4}
  .kv span{display:block;color:#8a90a0;font-size:8.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
  .kv b{font-weight:600}
  .kv b,.meta b,.check .d,h1,.sub{overflow-wrap:anywhere}
  .check{list-style:none;margin:0;padding:0;border:1px solid #e1e5ec;border-radius:6px}
  .check li{display:flex;gap:9px;align-items:baseline;padding:5px 9px;border-bottom:1px solid #eef0f4}
  .check li:last-child{border-bottom:0}
  .check .ic{width:14px;height:14px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:#fff;transform:translateY(2px)}
  .check .lv-ok .ic{background:#0f9960} .check .lv-todo .ic{background:#e08a00} .check .lv-info .ic{background:#8a90a0}
  .check b{min-width:170px;font-weight:700} .check .d{color:#5b6272}
  .check .lv-todo b{color:#9a5a00} .check .lv-todo .d{color:#9a5a00}
  .empty{padding:12px;color:#8a90a0;border:1px dashed #d5d9e1;border-radius:6px;text-align:center}
  .foot{margin-top:18px;padding-top:8px;border-top:1px solid #e1e5ec;color:#9aa0ad;font-size:9px;display:flex;justify-content:space-between}
  @media screen{
    html{background:#dfe2e8}
    body{background:transparent;padding:22px}
    .doc{background:#fff;margin:0 auto;padding:var(--pad);box-shadow:0 2px 14px rgba(20,25,40,.18);border-radius:2px;min-height:var(--ph)}
  }
  @media print{ .doc{padding:0} }
  `;


  /* Nothing may run off the paper. Each table is measured against the page's
     width (the .doc is sized to the paper on screen, so this holds in the
     hidden print frame too); one that's too wide first gets smaller type,
     then wraps at spaces, and only as a last resort breaks (hyphenated)
     inside a word. Sizes
     inside tables are in em, so everything shrinks together. */
  const FIT_JS = '<script>window.__fit=function(){' +
    'document.querySelectorAll(".tw>table").forEach(function(t){' +
      'var w=t.parentNode;t.style.fontSize="";t.classList.remove("wrap","squeeze");' +
      'var over=function(){return t.offsetWidth>w.clientWidth+0.5;};' +
      'var fs=10.5,shrink=function(min){while(over()&&fs>min){fs-=0.5;t.style.fontSize=fs+"px";}};' +
      'shrink(8.5);if(over())t.classList.add("wrap");' +
      'shrink(7.5);if(over())t.classList.add("squeeze");' +
      'shrink(6.5);' +
    '});};' +
    'document.addEventListener("DOMContentLoaded",window.__fit);' +
    'if(document.fonts&&document.fonts.ready)document.fonts.ready.then(window.__fit);' +
    '<\/script>';

  function renderDocHtml(ctx, doc, o) {
    const acc = ctx.accent || '#5b6cff';
    const paper = o.paper === 'letter' ? { w: 279.4, h: 215.9 } : { w: 297, h: 210 };
    const land = o.orient !== 'portrait';
    const pw = land ? paper.w : paper.h, ph = land ? paper.h : paper.w;
    const who = App.state.user && App.state.user.name;
    let h = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>' + esc(fileName(ctx, o).replace(/\.\w+$/, '')) + '</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">' +
      '<style>' + DOC_CSS + '@page{size:' + (o.paper === 'letter' ? 'letter' : 'A4') + ' ' + (land ? 'landscape' : 'portrait') + ';margin:11mm 11mm 12mm}' +
      ':root{--acc:' + acc + ';--pad:11mm;--ph:' + ph + 'mm}@media screen{.doc{width:' + pw + 'mm}}</style>' + FIT_JS + '</head><body><div class="doc">';
    h += '<div class="hd"><div><h1>' + esc(ctx.title) + '</h1>' + (ctx.subtitle ? '<div class="sub">' + esc(ctx.subtitle) + '</div>' : '') + '</div>' +
      '<div class="brand"><b>Post Pipeline</b>' + esc(fmtY(today())) + (who ? ' · ' + esc(who) : '') + '</div></div>';
    if (doc.meta && doc.meta.length) h += '<div class="meta">' + doc.meta.map(([k, v]) => '<div><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('') + '</div>';
    doc.blocks.forEach(b => {
      if (b.title) h += '<h2>' + esc(b.title) + (b.sub ? ' <small>' + esc(b.sub) + '</small>' : '') + '</h2>';
      if (b.kind === 'kv') {
        h += '<div class="kv">' + b.rows.map(([k, v]) => '<div><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('') + '</div>';
      } else if (b.kind === 'check') {
        const ic = { ok: '✓', todo: '!', info: 'i' };
        h += '<ul class="check">' + b.items.map(it => '<li class="lv-' + it.lvl + '"><span class="ic">' + ic[it.lvl] + '</span><b>' + esc(it.label) +
          '</b><span class="d">' + esc(it.detail || '') + '</span></li>').join('') + '</ul>';
      } else {
        const cols = b.columns.filter(c => c.pdf !== false);
        const data = b.rows.filter(r => !r.group);
        if (!data.length) { h += '<div class="empty">' + esc(b.empty || 'Nothing to show.') + '</div>'; return; }
        h += '<div class="tw"><table><thead><tr>' + cols.map(c => '<th class="' + [c.align, c.w].filter(Boolean).join(' ') + '">' + (c.labelH || esc(c.label)) + '</th>').join('') + '</tr></thead><tbody>';
        b.rows.forEach(r => {
          if (r.group) { h += '<tr class="grp" style="--g:' + (r.color || acc) + '"><td colspan="' + cols.length + '">' + esc(r.group) + (r.sub ? '<small>' + esc(r.sub) + '</small>' : '') + '</td></tr>'; return; }
          h += '<tr class="' + [r.milestone && 'ms', r.tone].filter(Boolean).join(' ') + '">' + cols.map(c => {
            const v = r.cells[c.key] || cell('');
            return '<td class="' + [c.align, c.nowrap && 'nw', c.w === 'bars' && 'bars'].filter(Boolean).join(' ') + '">' + (v.h != null ? v.h : esc(v.t)) + '</td>';
          }).join('') + '</tr>';
        });
        h += '</tbody></table></div>';
      }
    });
    h += '<div class="foot"><span>' + esc(ctx.what) + ' · exported from ' + esc(ctx.source) + '</span><span>' + esc(doc.count || '') + '</span></div>';
    return h + '</div></body></html>';
  }

  // CSV: one table plainly; several, each under its own title with a blank
  // line between — how Excel and Sheets read a multi-part sheet
  function renderCsv(doc) {
    const q = (v) => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const out = [];
    const tables = doc.blocks;
    const titled = tables.length > 1;
    tables.forEach((b, i) => {
      if (i) out.push('');
      if (titled && b.title) out.push(q(b.title));
      if (b.kind === 'kv') { b.rows.forEach(([k, v]) => out.push(q(k) + ',' + q(v))); return; }
      if (b.kind === 'check') {
        out.push('State,Section,Detail');
        const lbl = { ok: 'Done', todo: 'Unfinished', info: 'Note' };
        b.items.forEach(it => out.push([lbl[it.lvl], it.label, it.detail].map(q).join(',')));
        return;
      }
      const cols = b.columns.filter(c => c.csv !== false);
      out.push(cols.map(c => q(c.label)).join(','));
      b.rows.filter(r => !r.group).forEach(r => out.push(cols.map(c => q((r.cells[c.key] || {}).t)).join(',')));
    });
    return '﻿' + out.join('\r\n') + '\r\n';
  }

  function csvPreviewHtml(csv) {
    const rows = csv.replace(/^﻿/, '').split('\r\n');
    // a light parse, good enough to lay out what we wrote ourselves
    const parse = (line) => {
      const out = []; let cur = '', inq = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inq) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inq = false; else cur += ch; }
        else if (ch === '"') inq = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
      }
      out.push(cur); return out;
    };
    const shown = rows.slice(0, 400);
    const width = Math.max(1, ...shown.map(r => parse(r).length));
    const letters = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
    let h = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;font:11px/1.3 ui-monospace,Menlo,Consolas,monospace;background:#fff;color:#1d2230}' +
      'table{border-collapse:collapse}td,th{border:1px solid #dfe2e8;padding:3px 7px;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}' +
      'th{background:#f1f3f7;color:#6b7282;font-weight:600;position:sticky;top:0}td.n{background:#f7f8fa;color:#8a90a0;text-align:right}.more{padding:10px;color:#8a90a0}</style></head><body><table><thead><tr><th></th>';
    for (let i = 0; i < width; i++) h += '<th>' + letters(i) + '</th>';
    h += '</tr></thead><tbody>';
    shown.forEach((r, i) => {
      if (i === shown.length - 1 && r === '') return;
      const c = parse(r);
      h += '<tr><td class="n">' + (i + 1) + '</td>';
      for (let j = 0; j < width; j++) h += '<td>' + esc(c[j] || '') + '</td>';
      h += '</tr>';
    });
    h += '</tbody></table>' + (rows.length > 400 ? '<div class="more">…and ' + (rows.length - 400) + ' more rows in the file</div>' : '') + '</body></html>';
    return h;
  }

  function fileName(ctx, o) {
    return slug(ctx.fileBase) + '_' + today() + '.' + (o.format === 'csv' ? 'csv' : 'pdf');
  }

  /* ================================================================ dialog */

  const RANGES = [
    ['all', 'Whole schedule'], ['month', 'This month'], ['4w', 'Next 4 weeks'], ['quarter', 'Next 3 months'], ['custom', 'Custom']
  ];
  function rangeFor(key, span) {
    const t = today();
    if (key === 'month') { const d = App.parseDate(t); return { from: App.isoDate(new Date(d.getFullYear(), d.getMonth(), 1)), to: App.isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }; }
    if (key === '4w') return { from: t, to: App.shiftIso(t, 27) };
    if (key === 'quarter') return { from: t, to: App.shiftIso(t, 90) };
    return { from: span ? span.from : '', to: span ? span.to : '' };
  }

  App.exporter = {
    _ov: null,

    // what's in front of the user: a dialog that knows how to export itself,
    // else the view behind it
    context() {
      const mo = App.modal && App.modal._ov;
      if (mo) {
        const card = mo.querySelector('.modal-card');
        if (card && typeof card._exportCtx === 'function') return card._exportCtx();
        return { empty: 'This window has nothing to export — close it to export the view behind.' };
      }
      const v = App.state.view;
      if (v === 'timeline' || v === 'board' || v === 'dashboard') return productionCtx();
      return { empty: 'Print / Export works from the Timeline and Board — switch to one to export a production breakdown.' };
    },

    open(ctx) {
      if (this._ov) return;
      ctx = ctx || this.context();
      if (!ctx) return;
      if (ctx.empty) { App.toast(ctx.empty, true); return; }
      App.track && App.track.feature('export.open', ctx.kind);

      const PK = 'export.' + ctx.kind;
      const saved = App.prefs.get(PK, {}) || {};
      const fieldSet = (p) => new Set(ctx.fields.filter(f => p === 'simple' ? f.simple : f.adv).map(f => f.key));
      const st = {
        preset: saved.preset === 'advanced' || saved.preset === 'custom' ? saved.preset : 'simple',
        format: saved.format === 'csv' ? 'csv' : 'pdf',
        orient: saved.orient && saved.kindOrient === ctx.orient ? saved.orient : (ctx.orient || 'landscape'),
        paper: saved.paper === 'letter' ? 'letter' : 'a4',
        range: 'all', from: '', to: '',
        sel: {}
      };
      st.fields = st.preset === 'custom' && Array.isArray(saved.fields)
        ? new Set(saved.fields.filter(k => ctx.fields.some(f => f.key === k)))
        : fieldSet(st.preset);
      Object.assign(st, rangeFor('all', ctx.span));
      Object.keys(ctx.filters || {}).forEach(k => {
        const f = ctx.filters[k];
        const all = f.options.map(x => x.id);
        st.sel[k] = new Set(f.sel && f.sel.length ? f.sel.filter(id => all.includes(id)) : all);
      });

      const remember = () => App.prefs.set(PK, {
        preset: st.preset, format: st.format, orient: st.orient, kindOrient: ctx.orient, paper: st.paper,
        fields: st.preset === 'custom' ? [...st.fields] : undefined
      });

      const opts = () => {
        const has = (k) => (id) => !ctx.filters[k] || st.sel[k].has(id);
        const F = {}; st.fields.forEach(k => { F[k] = true; });
        const pf = ctx.filters.person;
        return {
          format: st.format, orient: st.orient, paper: st.paper, preset: st.preset,
          from: st.range === 'all' ? '' : st.from, to: st.range === 'all' ? '' : st.to,
          dept: has('dept'), person: has('person'), status: has('status'),
          allPeople: !pf || st.sel.person.size === pf.options.length,
          fields: F
        };
      };

      /* ---------- left: options ---------- */
      const side = el('.xp-side');
      const seg = (items, cur, on, cls) => el('.prefs-seg.xp-seg' + (cls ? '.' + cls : ''), null, items.map(([v, l, tip]) =>
        el('button.seg' + (cur() === v ? '.active' : ''), { type: 'button', title: tip || null, onclick: () => on(v) }, l)));

      const section = (label, extra, body) => el('.xp-sec', null, [
        el('.xp-sec-head', null, [el('span.xp-sec-lbl', null, label), extra || null]), body
      ]);

      function chips(key) {
        const f = ctx.filters[key];
        const set = st.sel[key];
        const wrap = el('.xp-chips');
        const groups = {};
        f.options.forEach(opt => { const g = opt.group || ''; (groups[g] = groups[g] || []).push(opt); });
        Object.keys(groups).forEach(g => {
          if (g) wrap.appendChild(el('.xp-chip-group', null, g));
          groups[g].forEach(opt => {
            const b = el('button.xp-chip' + (set.has(opt.id) ? '.on' : ''), {
              type: 'button', title: set.has(opt.id) ? 'Leave out ' + opt.label : 'Include ' + opt.label,
              onclick: () => { if (set.has(opt.id)) set.delete(opt.id); else set.add(opt.id); paintSide(); refresh(); }
            }, [opt.color ? el('i.xp-chip-dot', { style: { background: opt.color } }) : null, opt.label]);
            wrap.appendChild(b);
          });
        });
        const n = set.size, all = f.options.length;
        const tools = el('span.xp-sec-tools', null, [
          n === all ? null : el('span.xp-sec-count', null, n + ' of ' + all),
          el('button.xp-link', { type: 'button', onclick: () => { f.options.forEach(x => set.add(x.id)); paintSide(); refresh(); } }, 'All'),
          el('button.xp-link', { type: 'button', onclick: () => { set.clear(); paintSide(); refresh(); } }, 'None')
        ]);
        return section(f.label, tools, wrap);
      }

      function paintSide() {
        const top = side.scrollTop;
        side.innerHTML = '';
        side.appendChild(section('Preset', null, seg([
          ['simple', 'Simple', 'The essentials — for clients and freelancers'],
          ['advanced', 'Advanced', 'Everything, for production reporting']
        ].concat(st.preset === 'custom' ? [['custom', 'Custom', 'Your own choice of fields']] : []), () => st.preset, (v) => {
          if (v === 'custom') return;
          st.preset = v; st.fields = fieldSet(v); remember(); paintSide(); refresh();
        })));
        side.appendChild(section('Format', null, seg([['pdf', 'PDF', 'Opens the print dialog — choose Save as PDF'], ['csv', 'CSV', 'A spreadsheet file for Excel, Numbers or Sheets']],
          () => st.format, (v) => { st.format = v; remember(); paintSide(); refresh(); })));
        if (st.format === 'pdf') {
          side.appendChild(el('.xp-row2', null, [
            section('Layout', null, seg([['landscape', 'Landscape'], ['portrait', 'Portrait']], () => st.orient, (v) => { st.orient = v; remember(); paintSide(); refresh(); })),
            section('Paper', null, seg([['a4', 'A4'], ['letter', 'Letter']], () => st.paper, (v) => { st.paper = v; remember(); paintSide(); refresh(); }))
          ]));
        }

        // date range
        const fromI = el('input.fld.xp-date', { type: 'date', value: st.from || '' });
        const toI = el('input.fld.xp-date', { type: 'date', value: st.to || '' });
        const onDate = () => {
          st.range = 'custom'; st.from = fromI.value; st.to = toI.value;
          if (st.from && st.to && st.to < st.from) { st.to = st.from; toI.value = st.from; }
          [...rsel.options].forEach(op => { op.selected = op.value === 'custom'; });
          refresh();
        };
        fromI.addEventListener('change', onDate); toI.addEventListener('change', onDate);
        const rsel = el('select.fld.xp-range', { onchange: () => {
          st.range = rsel.value;
          if (st.range !== 'custom') { const r = rangeFor(st.range, ctx.span); st.from = r.from; st.to = r.to; fromI.value = st.from; toI.value = st.to; }
          refresh();
        } });
        RANGES.forEach(([v, l]) => { const op = document.createElement('option'); op.value = v; op.textContent = l; op.selected = st.range === v; rsel.appendChild(op); });
        side.appendChild(section('Date range', null, el('div', null, [
          rsel, el('.xp-dates', null, [fromI, el('span.xp-to', null, 'to'), toI])
        ])));

        // a filter with nothing to choose from (an unstaffed draft's People) isn't offered
        ['dept', 'person', 'status'].forEach(k => { if (ctx.filters[k] && ctx.filters[k].options.length) side.appendChild(chips(k)); });

        // fields
        const fl = el('.xp-fields');
        ctx.fields.forEach(fd => {
          const cb = el('input', { type: 'checkbox' });
          cb.checked = st.fields.has(fd.key);
          const off = fd.pdfOnly && st.format === 'csv';
          cb.disabled = off;
          cb.addEventListener('change', () => {
            if (cb.checked) st.fields.add(fd.key); else st.fields.delete(fd.key);
            const same = (p) => { const s = fieldSet(p); return s.size === st.fields.size && [...s].every(k => st.fields.has(k)); };
            st.preset = same('simple') ? 'simple' : same('advanced') ? 'advanced' : 'custom';
            remember(); paintSide(); refresh();
          });
          fl.appendChild(el('label.xp-field' + (off ? '.off' : ''), { title: off ? 'PDF only' : (fd.hint || null) }, [cb, el('span', null, fd.label)]));
        });
        side.appendChild(section('Fields', null, fl));
        side.scrollTop = top;
      }

      /* ---------- right: preview ---------- */
      const frame = el('iframe.xp-frame', { title: 'Export preview' });
      const stage = el('.xp-stage', null, [frame]);
      const countLbl = el('span.xp-count');
      const goBtn = el('button.btn-primary.xp-go', { type: 'button', onclick: () => run() });
      let lastDoc = null, lastHtml = '', lastCsv = '';

      function fit() {
        if (st.format === 'csv') { frame.style.transform = ''; frame.style.width = '100%'; frame.style.height = '100%'; return; }
        const paper = st.paper === 'letter' ? { w: 279.4, h: 215.9 } : { w: 297, h: 210 };
        const mm = 96 / 25.4;
        const docW = ((st.orient === 'portrait' ? paper.h : paper.w) * mm) + 44;
        const s = Math.min(1, (stage.clientWidth - 2) / docW);
        frame.style.width = docW + 'px';
        frame.style.height = (stage.clientHeight / s) + 'px';
        frame.style.transform = 'scale(' + s + ')';
      }

      let t = null;
      function refresh() { clearTimeout(t); t = setTimeout(render, 60); }
      function render() {
        const o = opts();
        let doc;
        try { doc = ctx.build(o); }
        catch (e) { console.error('export build failed', e); doc = { meta: [], blocks: [{ kind: 'table', columns: [], rows: [], empty: 'Couldn’t build this export: ' + e.message }] }; }
        // a narrowed filter is part of what the document says: name it in the header
        Object.keys(ctx.filters || {}).forEach(k => {
          const f = ctx.filters[k], set = st.sel[k];
          if (!f.options.length || set.size === f.options.length) return;
          const names = f.options.filter(x => set.has(x.id)).map(x => x.label);
          doc.meta = (doc.meta || []).concat([[f.label, !names.length ? 'None'
            : names.length <= 4 ? names.join(', ') : names.slice(0, 4).join(', ') + ' +' + (names.length - 4) + ' more']]);
        });
        lastDoc = doc;
        stage.classList.toggle('csv', st.format === 'csv');
        if (st.format === 'csv') { lastCsv = renderCsv(doc); frame.srcdoc = csvPreviewHtml(lastCsv); }
        else { lastHtml = renderDocHtml(ctx, doc, o); frame.srcdoc = lastHtml; }
        countLbl.textContent = doc.count || '';
        goBtn.textContent = st.format === 'csv' ? 'Download CSV' : 'Save as PDF / Print…';
        fit();
      }

      function run() {
        const o = opts();
        const name = fileName(ctx, o);
        App.track && App.track.feature('export.' + st.format, ctx.kind + '.' + st.preset);
        if (st.format === 'csv') {
          const url = URL.createObjectURL(new Blob([lastCsv || renderCsv(lastDoc)], { type: 'text/csv;charset=utf-8' }));
          const a = document.createElement('a'); a.href = url; a.download = name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          App.toast('Downloaded ' + name);
          return;
        }
        /* Printed from a frame of its own holding only the document, so the
           system dialog shows the breakdown — not the app — and its "Save as
           PDF" names the file after it. The page title is borrowed for the
           duration too, which is what some browsers name the PDF by. */
        const pf = el('iframe', { style: { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0', visibility: 'hidden' } });
        document.body.appendChild(pf);
        const title0 = document.title;
        const cleanup = () => { document.title = title0; setTimeout(() => pf.remove(), 500); };
        pf.onload = () => {
          const w = pf.contentWindow;
          const go = () => {
            try {
              document.title = name.replace(/\.pdf$/, '');
              if (w.__fit) w.__fit();
              w.focus(); w.print();
            } catch (e) { App.toast('Printing isn’t available here — try CSV, or open the app in a browser', true); }
            cleanup();
          };
          // fonts first, so the PDF isn't set in the fallback face
          if (w.document.fonts && w.document.fonts.ready) Promise.race([w.document.fonts.ready, new Promise(r => setTimeout(r, 1200))]).then(go);
          else setTimeout(go, 300);
        };
        pf.srcdoc = lastHtml || renderDocHtml(ctx, lastDoc, o);
      }

      const close = () => {
        if (!this._ov) return;
        this._ov.remove(); this._ov = null;
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', fit);
      };
      // captured first, so Escape closes this and not the dialog underneath
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
        else if ((App.isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); e.stopImmediatePropagation(); run(); }
      };

      const card = el('.xp-card', { onclick: (e) => e.stopPropagation() }, [
        el('.xp-head', null, [
          el('.xp-head-main', null, [
            App.icon('printer', { cls: 'modal-ic' }),
            el('div', null, [
              el('.modal-title', null, 'Print / Export'),
              el('.modal-subtitle', null, [ctx.what + ' · from ' + ctx.source])
            ])
          ]),
          el('button.modal-x', { type: 'button', onclick: close, title: 'Close (Esc)' }, '✕')
        ]),
        el('.xp-body', null, [side, el('.xp-main', null, [stage])]),
        el('.xp-foot', null, [
          countLbl,
          el('span.xp-hint', null, App.shortcutLabel('P') + ' exports too'),
          el('button.btn-ghost', { type: 'button', onclick: close }, 'Cancel'),
          goBtn
        ])
      ]);
      const ov = el('.xp-overlay', { onclick: (e) => { if (e.target === ov) close(); } }, [card]);
      document.body.appendChild(ov);
      this._ov = ov;
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', fit);
      paintSide();
      requestAnimationFrame(render);
    },

    close() { if (this._ov) { this._ov.remove(); this._ov = null; } }
  };

  // ⌘P / Ctrl+P anywhere — the app's own print, of what's on screen
  document.addEventListener('keydown', (e) => {
    const mod = App.isMac ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'p') return;
    if (!App.state || !App.state.data || App.exporter._ov) return;
    e.preventDefault();
    App.exporter.open();
  });
})();
