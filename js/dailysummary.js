/* Daily Summary — Post Operations' review sheet, as a dashboard widget.

   The team ran their day from a spreadsheet ("TopSheet - Daily Summary"): one
   row per version up for review, refreshed daily for anything due within
   48 hours, feedback by 5pm GMT. This is that sheet, column for column, so
   nobody has to relearn where to look — but filled from the board instead of
   by hand:

     #, Name, Link, Stage, Department, Date added   derived (reviewflow.js)
     Review (one sub-column per Director)           derived from the review
                                                    record until someone sets it
     Feedback due                                   suggested from the timeline
                                                    (when the dependants need it),
                                                    overridable by the operator
     Priority, QC, Notes                            the operator's own fields

   What the board can't know lives in one shared map, keyed like everything
   else in the review hand-off:

     data.dailySummary["<epId>::<taskKey>"] =
       { priority, qc, notes, feedbackDue, reviewers: { personId: status } }

   Rows: every task at Ready for Review, plus anything approved in the last
   48 hours — the sheet kept those on so the day's sign-offs were visible. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const KEY = (epId, taskKey) => epId + '::' + taskKey;
  const RECENT_HOURS = 48;

  // The sheet's own vocabularies, kept in its order. `tone` picks the pill colour.
  const PRIORITIES = [
    ['Highest', 'bad'], ['High', 'bad'], ['Medium', 'warn'], ['Low', 'mute'],
    ['Priority 1', 'bad'], ['Priority 2', 'warn'], ['Priority 3', 'mute']
  ];
  const QC = [
    ['Pending', 'mute'], ['In Progress', 'warn'], ['Completed', 'info'], ['Passed', 'ok'], ['Overdue', 'bad']
  ];
  const REVIEWER = [
    ['Needs Reviewing', 'info'], ['Under Review', 'warn'], ['Feedback Done', 'ok'],
    ['Approved', 'ok'], ['Approved with Notes', 'ok'], ['Final Approval Needed', 'info'],
    ['Waiting for Feedback', 'info'], ['Optional Review', 'mute'], ['FYI', 'mute'],
    ['Notes on Slack', 'mute'], ['Notes on email', 'mute'], ['Due Date Missed', 'bad'], ['N/A', 'mute']
  ];
  const toneOf = (list, v) => { const f = list.find(x => x[0] === v); return f ? f[1] : 'mute'; };
  const PRIORITY_RANK = (v) => { const i = PRIORITIES.findIndex(x => x[0] === v); return i < 0 ? 99 : i; };

  /* Stage is the sheet's word for what kind of cut this is. The pipeline
     keys say it already; anything a studio added itself reads as its name. */
  function stageOf(su) {
    const k = su.key;
    if (/^animatic/.test(k)) return 'Animatic';
    if (/^sfx/.test(k)) return 'SFX';
    return ({
      layout: 'Layout', blocking: 'Blocking', animation: 'Animation', lrc: 'LRC', final_lrc: 'LRC',
      song_master: 'Master', qc: 'QC', deliverys: 'Final Delivery'
    })[k] || su.name.replace(/\s*v\d+$/i, '');
  }

  // "Animation V02" — the sheet's naming. Names that already carry a version keep theirs.
  function versionName(ep, su) {
    if (/\bv\d+$/i.test(su.name)) return su.name;
    return su.name + ' V' + String(App.revisionsUsed(ep, su.key) + 1).padStart(2, '0');
  }

  const isoOf = (ts) => ts ? App.isoDate(new Date(ts)) : null;

  App.dailySummary = {
    get(id) { const d = App.state.data.dailySummary; return (d && d[id]) || {}; },

    set(id, patch, label) {
      App.mutate(d => {
        d.dailySummary = d.dailySummary || {};
        const cur = Object.assign({}, d.dailySummary[id]);
        Object.keys(patch).forEach(k => {
          if (k === 'reviewers') cur.reviewers = Object.assign({}, cur.reviewers, patch.reviewers);
          else cur[k] = patch[k];
        });
        // keep the map tidy: an entry with nothing in it is no entry
        if (cur.reviewers) Object.keys(cur.reviewers).forEach(p => { if (!cur.reviewers[p]) delete cur.reviewers[p]; });
        if (cur.reviewers && !Object.keys(cur.reviewers).length) delete cur.reviewers;
        Object.keys(cur).forEach(k => { if (cur[k] == null || cur[k] === '') delete cur[k]; });
        if (Object.keys(cur).length) d.dailySummary[id] = cur; else delete d.dailySummary[id];
      }, label || 'Daily Summary');
    },

    // Post Operations runs the sheet; producers and managers can step in.
    canEdit() {
      const r = App.state.role;
      return App.roleDept(r) === 'ops' || (App.isAdminRole(r) && App.canApprove(r));
    },
    // a Director can always set their own column
    canEditReviewer(pid) {
      return this.canEdit() || (!!App.state.user && App.state.user.personId === pid);
    },

    /* ------------------------------------------------------------- rows */
    rows(m) {
      const now = Date.now();
      const out = [];
      App.reviewFlow.allSubs(m).forEach(({ ep, su }) => {
        const rev = App.review.get(ep.id, su.key);
        if (su.status === 'approved') {
          const ts = rev && (rev.at || rev.sentAt);
          if (!ts || now - new Date(ts).getTime() > RECENT_HOURS * 3600e3) return;
        } else if (su.status !== 'review') return;

        const uploads = App.reviewUploads.list(ep.id, su.key);
        const newest = uploads.length ? uploads[uploads.length - 1] : null;
        const id = KEY(ep.id, su.key);
        const extra = this.get(id);
        const rec = this.recommend(ep, su);
        out.push({
          id, ep, su, rev, uploads, newest, extra, rec,
          show: App.show(ep.showId),
          stage: stageOf(su),
          name: versionName(ep, su),
          added: (newest && newest.at) || (rev && rev.sentAt) || null,
          due: extra.feedbackDue || rec.date,
          state: su.status === 'approved' ? 'approved'
            : rev && rev.state === 'under' ? 'under'
            : rev && rev.frameUrl ? 'sent' : 'waiting'
        });
      });
      return out;
    },

    /* ------------------------------------------- the suggested due date ----
       A review can run as long as nothing downstream is waiting on it. So the
       suggestion is the last working review day before the earliest
       dependant starts — never earlier than the task's own due date (that's
       the day the plan already gave it), and never in the past. Working days
       are the show's calendar for a Director review: weekends, holidays and
       the Directors' own time off. */
    calFor(show) { return App.showCalendar(show) || App.makeCalendar({}, null); },
    dependants(ep, su) {
      return App.subitems(ep).filter(o => (o.deps || []).indexOf(su.key) >= 0)
        .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    },
    recommend(ep, su) {
      const cal = this.calFor(App.show(ep.showId));
      const who = { review: true };
      const todayIso = App.isoDate(App.today());
      const deps = this.dependants(ep, su);
      let date = su.due, basis = 'due';
      if (deps.length) {
        let x = App.shiftIso(deps[0].start, -1), g = 0;
        while (cal.isOff(x, who) && g++ < 60) x = App.shiftIso(x, -1);
        if (x > date) { date = x; basis = 'dependant'; }
      }
      let late = false;
      if (date < todayIso) { date = cal.nextWork(todayIso, who); late = true; }
      return { date, basis, late, deps, cal };
    },

    // working review days from `fromIso` to `toIso`, both included
    workDays(cal, fromIso, toIso) {
      let n = 0, x = fromIso, g = 0;
      while (x <= toIso && g++ < 400) { if (!cal.isOff(x, { review: true })) n++; x = App.shiftIso(x, 1); }
      return n;
    },

    /* --------------------------------------------------------- Directors ----
       One sub-column per Director on the shows in view. With every show in
       view the columns would run to the whole studio, so they fold into a
       single Review column that lists each row's own Directors. */
    allShowsInView() {
      const f = App.state.filters.show;
      return !f.length || App.activeShows().every(s => f.includes(s.id));
    },
    directorsOf(show) { return App.deptTeam(show, App.ROLE_SLOT + 'director').ids; },
    reviewerStatus(r, pid) {
      const set = r.extra.reviewers && r.extra.reviewers[pid];
      if (set) return { value: set, derived: false };
      if (r.state === 'approved') return { value: 'Approved', derived: true };
      if (r.state === 'under') return { value: 'Under Review', derived: true };
      if (r.state === 'sent') return { value: 'Needs Reviewing', derived: true };
      return { value: null, derived: true };
    },

    /* ----------------------------------------------------------- widget */
    widget(m, t) {
      const rows = this.rows(m);
      const due = rows.filter(r => r.state !== 'approved');
      const todayIso = App.isoDate(App.today());
      const overdue = due.filter(r => r.due < todayIso).length;
      return {
        title: 'Daily Summary',
        sub: (due.length ? due.length + ' in review' : 'nothing in review') +
          (overdue ? ' · ' + overdue + ' overdue' : '') + ' · feedback due 5pm GMT',
        body: rows.length ? this.table(rows) : el('.dw-calm', null, 'Nothing up for review — the sheet is clear.'),
        bare: !!rows.length
      };
    },

    sortRows(rows) {
      const cs = App.prefs.get('dailySummarySort', null) || {};
      const val = {
        code: r => r.ep.code, name: r => r.name.toLowerCase(), stage: r => r.stage.toLowerCase(),
        dept: r => App.dept(r.su.dept).label.toLowerCase(), added: r => r.added || '',
        due: r => r.due, priority: r => PRIORITY_RANK(r.extra.priority),
        qc: r => { const i = QC.findIndex(x => x[0] === r.extra.qc); return i < 0 ? 99 : i; }
      };
      // the sheet's own order: what's due first, the urgent first within a day
      const dflt = (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) ||
        PRIORITY_RANK(a.extra.priority) - PRIORITY_RANK(b.extra.priority) ||
        String(a.ep.code).localeCompare(String(b.ep.code), undefined, { numeric: true });
      const f = val[cs.key];
      const sign = cs.dir === 'desc' ? -1 : 1;
      return rows.slice().sort((a, b) => {
        if (!f) return dflt(a, b);
        const x = f(a), y = f(b);
        const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return c ? sign * c : dflt(a, b);
      });
    },

    table(rows) {
      const edit = this.canEdit();
      const folded = this.allShowsInView();
      const shows = [...new Set(rows.map(r => r.show))];
      const dirs = folded ? [] : [...new Set([].concat(...App.state.filters.show
        .map(id => App.show(id)).filter(Boolean).map(s => this.directorsOf(s))))]
        .map(id => App.person(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
      const cs = App.prefs.get('dailySummarySort', null) || {};

      // a heading that sorts, the Board's way: ascending, descending, then off
      const th = (key, label, attrs) => {
        if (!key) return el('th', attrs, label);
        const on = cs.key === key;
        return el('th.dsum-sortable' + (on ? '.sorted' : ''), Object.assign({
          title: !on ? 'Sort by ' + label.toLowerCase() : cs.dir === 'asc' ? 'Sorted ascending — click for descending' : 'Sorted descending — click for the default order',
          onclick: (e) => {
            e.stopPropagation();
            App.prefs.set('dailySummarySort', !on ? { key, dir: 'asc' } : cs.dir === 'asc' ? { key, dir: 'desc' } : null);
            App.render();
          }
        }, attrs), [label, el('span.sort-ind', null, on ? (cs.dir === 'asc' ? '↑' : '↓') : '↕')]);
      };
      const two = { rowspan: '2' };
      const reviewSpan = folded || !dirs.length ? 1 : dirs.length;
      const head1 = el('tr', null, [
        th('code', '#', two), th('name', 'Name', two), th(null, 'Link', two), th('stage', 'Stage', two),
        th('dept', 'Department', two),
        el('th.dsum-group', (folded || !dirs.length) ? two : { colspan: String(reviewSpan) }, 'Review'),
        th('added', 'Date Added', two), th('due', 'Feedback Due', two), th('priority', 'Priority', two),
        th('qc', 'QC', two), th(null, 'Notes', two)
      ]);
      const thead = el('thead', null, [head1]);
      if (!folded && dirs.length) thead.appendChild(el('tr.dsum-sub', null, dirs.map(p => el('th', null, p.name.split(' ')[0]))));

      const tbody = el('tbody');
      this.sortRows(rows).forEach(r => tbody.appendChild(this.row(r, { edit, folded, dirs })));
      return el('.dsum-scroll', null, el('table.dsum-table' + (!folded && dirs.length ? '.two-tier' : ''), null, [thead, tbody]));
    },

    row(r, o) {
      const { ep, su, show } = r;
      const dep = App.dept(su.dept);
      const todayIso = App.isoDate(App.today());
      const STATE = {
        waiting: ['With Post Ops', 'info'], sent: ['Sent', 'warn'],
        under: ['Under Review', 'warn'], approved: ['Approved', 'ok']
      }[r.state];

      const cells = [
        el('td.dsum-code', null, el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color) } }, ep.code)),
        el('td.dsum-name', null, [
          el('button.dsum-name-btn', { title: 'Open the task', onclick: (e) => { e.stopPropagation(); App.editTask.open(ep.id, su.key); } }, r.name),
          el('span.dsum-state.dsum-t-' + STATE[1], null, STATE[0])
        ]),
        el('td.dsum-link', null, this.linkCell(r, o.edit)),
        el('td', null, r.stage),
        el('td', null, el('span.dept-chip.dsum-dept', null, [el('span.dot', { style: { background: dep.color } }), dep.label]))
      ];

      // Review — a pill per Director, folded or in their own columns
      if (o.folded || !o.dirs.length) {
        const mine = this.directorsOf(show).map(id => App.person(id)).filter(Boolean);
        cells.push(el('td.dsum-rev-list', null, mine.length
          ? mine.map(p => this.reviewerPill(r, p, true))
          : el('span.dsum-muted', null, 'No Director on this show')));
      } else {
        const onShow = this.directorsOf(show);
        o.dirs.forEach(p => cells.push(onShow.indexOf(p.id) >= 0
          ? el('td.dsum-rev', null, this.reviewerPill(r, p, false))
          : el('td.dsum-rev.off', { title: p.name + ' isn’t a Director on ' + show.name })));
      }

      cells.push(el('td.dsum-date', null, r.added ? App.fmtDate(isoOf(r.added)) : el('span.dsum-muted', null, '—')));
      cells.push(el('td.dsum-due', null, this.dueCell(r, o.edit, todayIso)));
      cells.push(el('td', null, this.choice(r, 'priority', PRIORITIES, o.edit)));
      cells.push(el('td', null, this.choice(r, 'qc', QC, o.edit)));
      cells.push(el('td.dsum-notes-cell', null, this.notesCell(r, o.edit)));
      return el('tr' + (r.state === 'approved' ? '.done' : ''), null, cells);
    },

    linkCell(r, edit) {
      const url = r.rev && r.rev.frameUrl;
      if (url) {
        return el('a.dsum-url', { href: url, target: '_blank', rel: 'noopener noreferrer', title: url, onclick: e => e.stopPropagation() },
          url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''));
      }
      // not sent yet: the coordinator's next move is right here
      if (edit && r.su.status === 'review') {
        return el('button.dsum-send', { title: 'Make the Frame.io review and send it to the Director',
          onclick: (e) => { e.stopPropagation(); App.reviewFlow.sendDialog(r.ep, r.su); } }, 'Send →');
      }
      return el('span.dsum-muted', null, r.newest ? r.newest.name : 'nothing uploaded');
    },

    pill(text, tone, extra) { return el('span.dsum-pill.dsum-t-' + tone + (extra || ''), null, text); },

    // a single-choice cell using the app's own dropdown (App.choiceMenu)
    choice(r, field, list, edit) {
      const v = r.extra[field] || null;
      if (!edit) return v ? this.pill(v, toneOf(list, v)) : el('span.dsum-muted', null, '—');
      const pick = (val) => () => { App.filterMenu.close(); this.set(r.id, { [field]: val }, 'Daily Summary ' + field); };
      const btn = App.choiceMenu('dsum:' + field + ':' + r.id, v || '—', [
        list.map(([val]) => ({ label: val, on: val === v, pick: pick(val) })),
        [{ label: 'Clear', on: false, pick: pick(null) }]
      ], 'Set ' + (field === 'qc' ? 'QC' : field));
      btn.classList.add('dsum-pick', 'dsum-t-' + (v ? toneOf(list, v) : 'none'));
      return btn;
    },

    reviewerPill(r, p, named) {
      const st = this.reviewerStatus(r, p.id);
      const text = (named ? p.name.split(' ')[0] + ' · ' : '') + (st.value || '—');
      const tone = st.value ? toneOf(REVIEWER, st.value) : 'none';
      if (!this.canEditReviewer(p.id)) {
        const s = this.pill(text, tone, st.derived ? '.derived' : '');
        if (st.derived && st.value) s.setAttribute('title', 'From the review’s progress — not set by hand');
        return s;
      }
      const pick = (val) => () => {
        App.filterMenu.close();
        this.set(r.id, { reviewers: { [p.id]: val } }, 'Review status for ' + p.name);
      };
      const btn = App.choiceMenu('dsum:rev:' + r.id + ':' + p.id, text, [
        REVIEWER.map(([val]) => ({ label: val, on: !st.derived && val === st.value, pick: pick(val) })),
        [{ label: 'Follow the review’s progress', tip: 'Clear it — the status fills in from the review record again', on: st.derived, pick: pick(null) }]
      ], p.name + ' — ' + (st.derived ? 'from the review’s progress' : 'set by hand'));
      btn.classList.add('dsum-pick', 'dsum-t-' + tone);
      if (st.derived) btn.classList.add('derived');
      return btn;
    },

    /* --------------------------------------------------- Feedback due cell */
    dueCell(r, edit, todayIso) {
      const chosen = !!r.extra.feedbackDue;
      // the sheet's colouring: overdue red, today/tomorrow amber, later plain
      const tone = r.state === 'approved' ? 'mute'
        : r.due < todayIso ? 'bad' : r.due <= App.shiftIso(todayIso, 1) ? 'warn' : 'none';
      const btn = el((edit ? 'button' : 'span') + '.dsum-due-btn.dsum-t-' + tone, edit ? {
        onclick: (e) => { e.stopPropagation(); this.openDuePop(btn, r); }
      } : null, [
        App.fmtDate(r.due),
        chosen ? null : el('span.dsum-suggest', null, 'suggested')
      ]);
      btn.addEventListener('mouseenter', () => this.showLane(btn, r));
      btn.addEventListener('mouseleave', () => this.hideLane());
      return btn;
    },

    openDuePop(anchor, r) {
      this.hideLane();
      const key = 'dsum:due:' + r.id;
      if (App.filterMenu.openKey === key) { App.filterMenu.close(); return; }
      App.filterMenu.close();
      const input = el('input.fld', { type: 'date', value: r.due });
      const save = (v) => { App.filterMenu.close(); this.set(r.id, { feedbackDue: v || null }, 'Feedback due'); };
      const pop = el('.filter-pop.dsum-due-pop', { style: { maxHeight: 'none' }, onclick: e => e.stopPropagation() }, [
        el('.dsum-pop-title', null, 'Feedback due by'),
        input,
        el('.dsum-pop-hint', null, 'Suggested: ' + App.fmtDate(r.rec.date) + ' — ' + this.basisText(r)),
        el('.dsum-pop-actions', null, [
          r.extra.feedbackDue ? el('button.btn-ghost', { onclick: () => save(null) }, 'Reset to suggested') : null,
          el('button.btn-primary', { onclick: () => save(input.value) }, 'Set')
        ])
      ]);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') save(input.value); });
      const b = anchor.getBoundingClientRect();
      pop.style.top = (b.bottom + 6) + 'px';
      pop.style.left = Math.max(8, Math.min(b.left, window.innerWidth - 280)) + 'px';
      document.body.appendChild(pop);
      App.filterMenu.openKey = key;
      App.filterMenu._pop = pop;
      setTimeout(() => input.focus(), 20);
    },

    basisText(r) {
      const d = r.rec.deps[0];
      if (r.rec.late) return 'the planned date has passed, so the next working day';
      if (r.rec.basis === 'dependant') return 'the day before ' + d.name + ' starts';
      return d ? 'its own due date (' + d.name + ' already starts by then)' : 'its own due date — nothing waits on it';
    },

    /* ---- hover: the review window against what's waiting on it ----
       A small timeline of just this task and its dependants, so the
       coordinator can see how much room there is before choosing a date. */
    showLane(anchor, r) {
      this.hideLane();
      if (App.filterMenu.openKey === 'dsum:due:' + r.id) return;
      const { su, rec } = r;
      const cal = rec.cal;
      const todayIso = App.isoDate(App.today());
      const winStart = [todayIso, isoOf(r.added) || todayIso].sort()[1];
      const deps = rec.deps.slice(0, 6);
      let from = [su.start, todayIso, winStart].sort()[0];
      let to = [su.due, r.due].concat(deps.map(d => d.due)).sort().pop();
      from = App.shiftIso(from, -1); to = App.shiftIso(to, 1);
      // keep it readable: a fortnight either side of the review at most
      const lo = App.shiftIso(r.due, -21), hi = App.shiftIso(r.due, 28);
      if (from < lo) from = lo; if (to > hi) to = hi;
      const span = App.diffDays(to, from) + 1;
      const pct = (iso) => Math.max(0, Math.min(100, App.diffDays(iso, from) / span * 100));
      const bar = (a, b, style, cls, label) => el('.dsum-lane-bar' + (cls || ''), {
        style: Object.assign({ left: pct(a) + '%', width: Math.max(1.5, pct(App.shiftIso(b, 1)) - pct(a)) + '%' }, style)
      }, label ? el('span', null, label) : null);

      const days = el('.dsum-lane-days');
      for (let i = 0; i < span; i++) {
        const iso = App.shiftIso(from, i);
        if (cal.isOff(iso, { review: true })) days.appendChild(el('.dsum-lane-off', { style: { left: (i / span * 100) + '%', width: (100 / span) + '%' } }));
      }
      const left = this.workDays(cal, winStart, r.due);
      const lines = [
        el('.dsum-lane-row', null, [el('.dsum-lane-label', null, su.name),
          el('.dsum-lane-track', null, bar(su.start, su.due, { background: App.status(su.status).color }))]),
        // the days left sit in the label: the bar itself can be a sliver
        el('.dsum-lane-row.win', null, [
          el('.dsum-lane-label', { title: left + ' working review day' + (left === 1 ? '' : 's') + ' left' },
            winStart <= r.due ? 'Review · ' + left + 'd' : 'Review · overdue'),
          el('.dsum-lane-track', null, winStart <= r.due
            ? bar(winStart, r.due, null, '.review')
            : bar(r.due, r.due, null, '.review.late'))])
      ];
      deps.forEach(d => lines.push(el('.dsum-lane-row', null, [
        el('.dsum-lane-label', { title: d.name }, d.name),
        el('.dsum-lane-track', null, bar(d.start, d.due, { background: App.dept(d.dept).color }))
      ])));
      if (rec.deps.length > deps.length) lines.push(el('.dsum-lane-more', null, '+' + (rec.deps.length - deps.length) + ' more waiting on it'));

      const body = el('.dsum-lane-body', null, [days].concat(lines));
      if (todayIso >= from && todayIso <= to) body.appendChild(el('.dsum-lane-today', { style: { left: 'calc(110px + (100% - 110px) * ' + (pct(todayIso) / 100) + ')' } }));
      body.appendChild(el('.dsum-lane-due', { style: { left: 'calc(110px + (100% - 110px) * ' + (pct(App.shiftIso(r.due, 1)) / 100) + ')' } }));

      const pop = el('.dsum-lane', null, [
        el('.dsum-lane-head', null, [
          el('strong', null, r.ep.code + ' · ' + r.name),
          el('span', null, (deps.length ? deps.length + ' task' + (deps.length === 1 ? '' : 's') + ' waiting on it' : 'nothing waits on it'))
        ]),
        el('.dsum-lane-scale', null, [el('span', null, App.fmtDate(from)), el('span', null, App.fmtDate(to))]),
        body,
        el('.dsum-lane-foot', null, (r.extra.feedbackDue ? 'Due ' + App.fmtDate(r.due) + ' (set by hand) · suggested ' + App.fmtDate(rec.date)
          : 'Suggested ' + App.fmtDate(rec.date)) + ' — ' + this.basisText(r))
      ]);
      document.body.appendChild(pop);
      const b = anchor.getBoundingClientRect();
      const w = pop.offsetWidth, h = pop.offsetHeight;
      const below = b.bottom + 8 + h < window.innerHeight;
      pop.style.top = (below ? b.bottom + 8 : Math.max(8, b.top - h - 8)) + 'px';
      pop.style.left = Math.max(8, Math.min(b.left + b.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px';
      this._lane = pop;
    },
    hideLane() { if (this._lane) { this._lane.remove(); this._lane = null; } },

    /* Notes: the operator's own scratch line. Saves when focus leaves, and
       api.js leaves the board alone while one has focus (see _adoptVersion). */
    notesCell(r, edit) {
      const v = r.extra.notes || '';
      if (!edit) return v ? el('.dsum-notes-ro', null, v) : el('span.dsum-muted', null, '');
      const ta = el('textarea.dsum-notes', { rows: '1', placeholder: 'Add a note…', onclick: e => e.stopPropagation() });
      ta.value = v;
      const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };
      ta.addEventListener('input', fit);
      ta.addEventListener('focus', fit);
      ta.addEventListener('blur', () => {
        const nv = ta.value.trim();
        if (nv !== v) this.set(r.id, { notes: nv || null }, 'Daily Summary note');
        else ta.style.height = '';
      });
      ta.addEventListener('keydown', e => { if (e.key === 'Escape') { ta.value = v; ta.blur(); } });
      return ta;
    }
  };
})();
