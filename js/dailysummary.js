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

  /* A link reads as where it goes — "Frame.io Link" — not as a URL. The
     address itself is one hover (tooltip) or right-click (copy) away. */
  const HOSTS = [
    [/(^|\.)(f\.io|frame\.io)$/, 'Frame.io'], [/(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$/, 'Google Drive'],
    [/(^|\.)dropbox\.com$/, 'Dropbox'], [/(^|\.)box\.com$/, 'Box'], [/(^|\.)vimeo\.com$/, 'Vimeo'],
    [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'], [/(^|\.)(wetransfer\.com|we\.tl)$/, 'WeTransfer'],
    [/(^|\.)ibmaspera\.com$|(^|\.)asperafiles\.com$/, 'Aspera'], [/(^|\.)sharepoint\.com$/, 'SharePoint']
  ];
  function linkLabel(url) {
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return 'Link'; }
    const known = HOSTS.find(([re]) => re.test(host));
    const name = known ? known[1] : host.charAt(0).toUpperCase() + host.slice(1);
    return name + ' Link';
  }
  // shared with the Reviews tab, so a link reads the same everywhere
  App.linkLabel = linkLabel;

  /* Right-click copies a cell's text — the full URL for a link, the full
     date for a date — the way the sheet let people copy a cell. */
  function copyOnRightClick(node, text, what) {
    node.addEventListener('contextmenu', (e) => {
      if (!text) return;
      e.preventDefault(); e.stopPropagation();
      App.copy(text, what);
    });
    return node;
  }
  // "13 Oct 2026" — unambiguous once it's pasted somewhere without the table's context
  const fullDate = (iso) => iso ? App.parseDate(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  App.dailySummary = {
    get(id) { const d = App.state.data.dailySummary; return (d && d[id]) || {}; },

    /* The Priority picked here also orders the Reviews tab (js/reviews.js):
       Highest first, unset last. Exposed so both read one vocabulary. */
    priority(id) { return this.get(id).priority || null; },
    priorityRank: (v) => PRIORITY_RANK(v),

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
       A review can run as long as nothing downstream is waiting on it — but
       the version under review is rarely the last. If it comes back for
       changes, every version still in the task's revision budget has to fit
       before the next task starts (the schedule plans for that worst case;
       see App.schedulePipeline). So the suggestion works backwards from the
       earliest dependant's start (or, with none, the end of the task's own
       reserve): place each remaining version, latest first, on its
       department's working days, keep any review time planned between them
       (revGaps), and the feedback for THIS version is due the last working
       review day before the first of them. The final version gets everything
       up to the dependant. Never earlier than the task's own due date, never
       in the past. */
        calFor(show) { return App.showCalendar(show) || App.makeCalendar({}, null); },
    dependants(ep, su) {
      return App.subitems(ep).filter(o => (o.deps || []).indexOf(su.key) >= 0)
        .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    },
    recommend(ep, su) {
      const cal = this.calFor(App.show(ep.showId));
      const review = { review: true };
      const work = { dept: su.dept, person: su.assignee };
      const todayIso = App.isoDate(App.today());
      const deps = this.dependants(ep, su);
      // the last working day strictly before `iso`, for whoever's calendar
      const before = (iso, who) => { let x = App.shiftIso(iso, -1), g = 0; while (cal.isOff(x, who) && g++ < 60) x = App.shiftIso(x, -1); return x; };

      const t = App.revTask(ep, su.key);
      const { max, days, used } = App.taskRevisions(ep, su.key);
      const anchor = deps.length ? deps[0].start : App.shiftIso(App.plannedRevisions(ep, su).end, 1);
      // the versions still to come, placed as late as they can go
      const reserved = [];
      let at = anchor;
      if (su.status !== 'approved') {
        for (let r = max - 1; r >= used; r--) {
          const n = Math.max(1, days[r] || 1);
          const end = before(at, work);
          let start = end;
          for (let i = 1; i < n; i++) start = before(start, work);
          reserved.unshift({ label: 'V' + (r + 2), start, due: end });
          at = start;
          // review time planned before a LATER version belongs to that version's review
          if (r > used) for (let g = App.revGap(t, r); g > 0; g--) at = before(at, work);
        }
      }
      let date = before(at, review), basis = deps.length ? 'dependant' : 'reserve';
      if (date < su.due) { date = su.due; basis = 'due'; }       // no slack left: the plan's own date
      let late = false;
      if (date < todayIso) { date = cal.nextWork(todayIso, review); late = true; }
      /* Without the slack, the latest-possible placement above would sit
         before the feedback even arrives — so show the versions where they'd
         really fall, straight after the feedback date, and how far past the
         next task's start that runs. */
      let overrun = 0;
      if ((basis === 'due' || late) && reserved.length) {
        const fwd = App.revisionSteps(t, date, cal, work, used).revs;
        reserved.splice(0, reserved.length, ...fwd.map(v => ({ label: v.label, start: v.start, due: v.due })));
        const last = reserved[reserved.length - 1].due;
        if (last >= anchor) overrun = this.workDays(cal, anchor, last);
      }
      return { date, basis, late, deps, cal, reserved, overrun };
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

      cells.push(r.added
        ? copyOnRightClick(el('td.dsum-date', { title: 'Right-click to copy' }, App.fmtDate(isoOf(r.added))), fullDate(isoOf(r.added)), 'date')
        : el('td.dsum-date', null, el('span.dsum-muted', null, '—')));
      cells.push(copyOnRightClick(el('td.dsum-due', null, this.dueCell(r, o.edit, todayIso)), fullDate(r.due), 'date'));
      cells.push(el('td', null, this.choice(r, 'priority', PRIORITIES, o.edit)));
      cells.push(el('td', null, this.choice(r, 'qc', QC, o.edit)));
      cells.push(el('td.dsum-notes-cell', null, this.notesCell(r, o.edit)));
      return el('tr' + (r.state === 'approved' ? '.done' : ''), null, cells);
    },

    linkCell(r, edit) {
      const url = r.rev && r.rev.frameUrl;
      if (url) {
        const a = copyOnRightClick(el('a.dsum-url', { href: url, target: '_blank', rel: 'noopener noreferrer',
          title: 'Right-click to copy the link', onclick: e => e.stopPropagation() }, linkLabel(url)), url, 'link');
        if (!edit) return a;
        // clicking the link opens it and right-click copies it, so changing it gets its own button
        const btn = el('button.dsum-link-edit', { type: 'button', title: 'Change the review link',
          onclick: (e) => { e.stopPropagation(); this.openLinkPop(btn, r); } }, App.icon('pencil'));
        return el('.dsum-link-wrap', null, [a, btn]);
      }
      // not sent yet: the coordinator's next move is right here
      if (edit && r.su.status === 'review') {
        return el('button.dsum-send', { title: 'Set up the review and send it to the Director',
          onclick: (e) => { e.stopPropagation(); App.reviewFlow.sendDialog(r.ep, r.su); } }, 'Send →');
      }
      // not sent yet and not ours to send: what was uploaded, named the same way
      if (r.newest && r.newest.url) {
        return copyOnRightClick(el('a.dsum-url.muted', { href: r.newest.url, target: '_blank', rel: 'noopener noreferrer',
          title: 'Right-click to copy the link', onclick: e => e.stopPropagation() }, linkLabel(r.newest.url)), r.newest.url, 'link');
      }
      return r.newest ? copyOnRightClick(el('span.dsum-muted', { title: r.newest.name }, r.newest.name), r.newest.name, 'file name')
        : el('span.dsum-muted', null, 'nothing uploaded');
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

    // the same small popover as the Feedback Due picker, holding the link instead
    openLinkPop(anchor, r) {
      this.hideLane();
      const key = 'dsum:link:' + r.id;
      if (App.filterMenu.openKey === key) { App.filterMenu.close(); return; }
      App.filterMenu.close();
      const cur = (r.rev && r.rev.frameUrl) || '';
      const input = el('input.fld', { type: 'text', value: cur, placeholder: 'Paste the review link' });
      const save = () => {
        if (!App.review.setLink(r.ep.id, r.su.key, input.value)) { input.focus(); return; }
        App.filterMenu.close();
      };
      const pop = el('.filter-pop.dsum-due-pop.dsum-link-pop', { style: { maxHeight: 'none' }, onclick: e => e.stopPropagation() }, [
        el('.dsum-pop-title', null, 'Review link'),
        input,
        el('.dsum-pop-hint', null, 'This is the link the Director opens. Changing it keeps the review where it is.'),
        el('.dsum-pop-actions', null, [
          el('button.btn-ghost', { onclick: () => App.filterMenu.close() }, 'Cancel'),
          el('button.btn-primary', { onclick: save }, 'Save')
        ])
      ]);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') App.filterMenu.close();
      });
      const b = anchor.getBoundingClientRect();
      pop.style.top = (b.bottom + 6) + 'px';
      pop.style.left = Math.max(8, Math.min(b.left - 120, window.innerWidth - 348)) + 'px';
      document.body.appendChild(pop);
      App.filterMenu.openKey = key;
      App.filterMenu._pop = pop;
      setTimeout(() => { input.focus(); input.select(); }, 20);
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
      const { deps, reserved, basis, late } = r.rec;
      const d = deps[0];
      const until = d ? d.name + ' starts' : 'the end of its planned reserve';
      const versions = reserved.length === 1 ? reserved[0].label
        : reserved.length ? reserved[0].label + '–' + reserved[reserved.length - 1].label : '';
      const over = r.rec.overrun
        ? ' — if it comes back, ' + versions + ' would run ' + r.rec.overrun + ' working day' + (r.rec.overrun === 1 ? '' : 's') + ' past ' + (d ? d.name + '’s start' : 'its reserve')
        : '';
      if (late) return 'the planned date has passed, so the next working day' + over;
      if (basis === 'due') return reserved.length
        ? 'its own due date' + (over || ' — no slack left before ' + until)
        : 'its own due date' + (d ? ' (' + d.name + ' already starts by then)' : ' — nothing waits on it');
      return reserved.length
        ? 'leaves room for ' + versions + ' before ' + until
        : 'the final version — the day before ' + until;
    },

    /* ---- hover: the gap the reviewer has ----
       One strip, drawn the way the Timeline draws it: the tail end of the
       version under review on the left (its department's colour, ringed in
       its status), the start of whatever comes next on the right — the next
       version if there are any left in the budget (striped, like the
       Timeline's planned revisions), otherwise the next task — and the gap
       between them, which is the reviewer's: the time to watch it, make
       notes, or approve it. Long empty stretches are cut out (zig-zag). */
    showLane(anchor, r) {
      this.hideLane();
      if (App.filterMenu.openKey === 'dsum:due:' + r.id) return;
      const { su, rec } = r;
      const cal = rec.cal;
      const todayIso = App.isoDate(App.today());
      const TAIL = 3;                                   // calendar days of each bar to show
      const dep = App.dept(su.dept);
      const st = App.status(su.status);
      const uploadIso = isoOf(r.added);

      // left: the version's tail — it's done when the cut is in, if that was early
      const tailEnd = uploadIso && uploadIso < su.due ? uploadIso : su.due;
      const tailStart = [su.start, App.shiftIso(tailEnd, -(TAIL - 1))].sort()[1];
      // right: the next version if there's one left, else the next task
      const nextVer = rec.reserved[0] || null;
      const nextTask = nextVer ? null : (rec.deps[0] || null);
      // "V3" → "V03", the way the sheet (and the Name column) writes versions
      const verLabel = nextVer ? 'V' + nextVer.label.slice(1).padStart(2, '0') : null;
      const right = nextVer
        ? { label: su.name + ' ' + verLabel, sub: 'if sent back', start: nextVer.start, due: nextVer.due, color: dep.color, rev: true }
        : nextTask
          ? { label: nextTask.name, sub: 'next task', start: nextTask.start, due: nextTask.due, color: App.dept(nextTask.dept).color, rev: false }
          : null;
      const headEnd = right ? [right.due, App.shiftIso(right.start, TAIL - 1)].sort()[0] : null;
      const gapStart = App.shiftIso(tailEnd, 1);
      const gapEnd = right ? App.shiftIso(right.start, -1) : r.due;

      /* ---- the scale, with breaks ----
         Only the days around something worth seeing are drawn — the two bar
         ends, today, the upload and the feedback date — and any longer empty
         stretch between them is cut out and drawn as a zig-zag break.
         Positions are % of the strip. */
      const pts = [tailStart, tailEnd, todayIso, r.due, uploadIso, right && right.start, headEnd].filter(Boolean).sort();
      const from = App.shiftIso(pts[0], -1);
      const to = App.shiftIso(pts[pts.length - 1], right ? 0 : 2);
      const TRACK_PX = 520 - 28;                        // popover width − padding
      const PAD = 2, MIN_GAP = 6, BREAK_PX = 18;
      const clampIso = (iso) => iso < from ? from : iso > to ? to : iso;
      const segs = [];
      pts.map(clampIso).forEach(p => {
        const a = clampIso(App.shiftIso(p, -PAD)), b = clampIso(App.shiftIso(p, PAD));
        const last = segs[segs.length - 1];
        if (last && App.diffDays(a, last.b) <= MIN_GAP) { if (b > last.b) last.b = b; }
        else segs.push({ a, b });
      });
      // the strip runs exactly from the first drawn day of the tail to the last of the head
      segs[0].a = from; segs[segs.length - 1].b = to;
      const nBreaks = segs.length - 1;
      const visDays = segs.reduce((n, g) => n + App.diffDays(g.b, g.a) + 1, 0);
      const dayPx = (TRACK_PX - nBreaks * BREAK_PX) / visDays;
      const dayU = dayPx / TRACK_PX * 100, breakU = BREAK_PX / TRACK_PX * 100;
      let x = 0;
      segs.forEach((g, i) => {
        g.x = x; x += (App.diffDays(g.b, g.a) + 1) * dayU;
        if (i < nBreaks) { g.breakX = x; x += breakU; }
      });
      const place = (iso) => {
        if (iso <= segs[0].a) return { s: 0, e: iso < segs[0].a ? 0 : dayU };
        for (let i = 0; i < segs.length; i++) {
          const g = segs[i];
          if (iso >= g.a && iso <= g.b) { const s0 = g.x + App.diffDays(iso, g.a) * dayU; return { s: s0, e: s0 + dayU }; }
          if (i < nBreaks && iso > g.b && iso < segs[i + 1].a) { const c = g.breakX + breakU / 2; return { s: c, e: c }; }
        }
        return { s: 100, e: 100 };
      };
      const mid = (iso) => { const p = place(iso); return (p.s + p.e) / 2; };
      const span = (a, b) => { const s0 = place(a).s, e0 = place(b).e; return { left: s0 + '%', width: Math.max(1.2, e0 - s0) + '%' }; };
      const eachDay = (fn) => segs.forEach((g, gi) => {
        for (let i = 0, n = App.diffDays(g.b, g.a); i <= n; i++) fn(App.shiftIso(g.a, i), i, gi);
      });

      // ---- the strip ----
      const strip = el('.dsum-strip');
      eachDay(iso => {
        if (cal.isOff(iso, { review: true })) strip.appendChild(el('.dsum-lane-off', { style: { left: place(iso).s + '%', width: dayU + '%' } }));
      });
      const gapDays = gapEnd >= gapStart ? this.workDays(cal, gapStart, gapEnd) : 0;
      const leftDays = gapEnd >= todayIso ? this.workDays(cal, todayIso > gapStart ? todayIso : gapStart, gapEnd) : 0;
      if (gapEnd >= gapStart) strip.appendChild(el('.dsum-strip-gap', { style: span(gapStart, gapEnd) }));
      // the version under review: its department's colour, ringed in its status — as on the Timeline
      strip.appendChild(el('.dsum-strip-bar.tail', {
        style: Object.assign(span(tailStart, tailEnd), { background: dep.color, color: App.pickInk(dep.color), outlineColor: st.color })
      }, el('span', null, r.name.replace(/^.*\s(V\d+)$/i, '$1'))));
      if (right) {
        const head = el('.dsum-strip-bar.head' + (right.rev ? '.rev' : ''), {
          style: Object.assign(span(right.start, headEnd), right.rev ? {} : { background: right.color, color: App.pickInk(right.color) })
        }, el('span', null, right.rev ? verLabel : right.label));
        if (right.rev) head.style.setProperty('--rp-c', right.color);
        strip.appendChild(head);
      }
      // today and the feedback date, as lines through the strip
      const marks = [];
      if (todayIso >= from && todayIso <= to) marks.push(['today', todayIso]);
      if (r.due >= from && r.due <= to) marks.push(['due', r.due]);
      marks.forEach(([cls, iso]) => strip.appendChild(el('.dsum-lane-mark.k-' + cls, { style: { left: mid(iso) + '%' } })));

      // captions: what's on the left, the gap, what's on the right
      const caps = el('.dsum-strip-caps', null, [
        el('.dsum-cap.left', { style: { left: place(tailStart).s + '%' } }, [el('strong', null, r.name), el('span', null, tailEnd < su.due ? 'uploaded ' + App.fmtDate(tailEnd) + ' · due ' + App.fmtDate(su.due) : 'due ' + App.fmtDate(su.due))]),
        right ? el('.dsum-cap.right', { style: { right: (100 - place(headEnd).e) + '%' } }, [el('strong', null, right.label), el('span', null, right.sub + ' · starts ' + App.fmtDate(right.start))]) : null
      ]);
      const gapCap = el('.dsum-strip-gapcap', null, gapEnd < gapStart
        ? 'No gap — ' + (right ? right.label + ' starts before this is due' : 'nothing waits on it')
        : [el('strong', null, 'Review gap · ' + gapDays + ' working day' + (gapDays === 1 ? '' : 's')),
           todayIso > gapEnd ? el('span.late', null, ' · past') : todayIso >= gapStart ? el('span', null, ' · ' + leftDays + ' left') : null]);

      /* ---- the date axis ---- */
      const every = Math.max(1, Math.ceil(26 / dayPx));
      const axis = el('.dsum-lane-axis');
      const todayX = mid(todayIso);
      let lastMonth = null;
      eachDay((iso, i, gi) => {
        const d = App.parseDate(iso);
        const x0 = mid(iso);
        axis.appendChild(el('.dsum-tick' + (d.getDay() === 1 ? '.week' : '') + (iso === todayIso ? '.today' : ''),
          { style: { left: x0 + '%' } }));
        const isToday = iso === todayIso;
        const clearOfToday = Math.abs(x0 - todayX) >= every * dayU;
        const clearOfBreak = !(gi > 0 && i > 0 && i <= every);
        if (isToday || (i % every === 0 && clearOfToday && clearOfBreak)) {
          const month = d.getMonth();
          const text = month !== lastMonth || (i === 0 && gi > 0) ? App.fmtDate(iso) : String(d.getDate());
          lastMonth = month;
          const afterBreak = i === 0 && gi > 0;
          axis.appendChild(el('.dsum-tick-label' + (isToday ? '.today' : '') + (afterBreak ? '.after-break' : ''),
            { style: { left: (afterBreak ? place(iso).s : x0) + '%' } }, text));
        }
      });
      const ZIG = '<svg viewBox="0 0 10 100" preserveAspectRatio="none"><polyline points="2,0 8,6.25 2,12.5 8,18.75 2,25 8,31.25 2,37.5 8,43.75 2,50 8,56.25 2,62.5 8,68.75 2,75 8,81.25 2,87.5 8,93.75 2,100"/></svg>';
      segs.slice(0, nBreaks).forEach((g, i) => {
        const skipped = App.diffDays(segs[i + 1].a, g.b) - 1;
        const tip = skipped + ' day' + (skipped === 1 ? '' : 's') + ' skipped (' + App.fmtDate(App.shiftIso(g.b, 1)) + ' – ' + App.fmtDate(App.shiftIso(segs[i + 1].a, -1)) + ')';
        axis.appendChild(el('.dsum-axis-gap', { style: { left: g.breakX + '%', width: breakU + '%' } }));
        strip.appendChild(el('.dsum-lane-break', { style: { left: g.breakX + '%', width: breakU + '%' }, title: tip, html: ZIG + ZIG }));
      });

      /* ---- key dates under the strip ---- */
      const keys = [];
      const addKey = (iso, label, cls) => {
        if (!iso || iso < from || iso > to) return;
        const k = keys.find(x => x.iso === iso);
        if (k) { k.labels.push(label); if (cls === 'due' || cls === 'today') k.cls = cls; }
        else keys.push({ iso, labels: [label], cls });
      };
      if (uploadIso) addKey(uploadIso, 'Uploaded', 'up');
      addKey(todayIso, 'Today', 'today');
      addKey(r.due, r.extra.feedbackDue ? 'Feedback due' : 'Feedback due (suggested)', 'due');
      keys.sort((a, b) => a.iso < b.iso ? -1 : 1);
      const levels = [];
      const keyStrip = el('.dsum-lane-keys');
      keys.forEach(k => {
        const text = k.labels.join(' · ') + ' — ' + App.fmtDate(k.iso);
        const wPct = (text.length * 5.6 + 14) / TRACK_PX * 100;
        const lx = Math.max(0, Math.min(100 - wPct, mid(k.iso) - wPct / 2));
        let lvl = levels.findIndex(end => end <= lx - 1);
        if (lvl < 0) { lvl = levels.length; levels.push(0); }
        levels[lvl] = lx + wPct;
        keyStrip.appendChild(el('.dsum-key.k-' + k.cls, { style: { left: lx + '%', top: (lvl * 18) + 'px' } }, text));
      });
      keyStrip.style.height = (Math.max(1, levels.length) * 18) + 'px';

      const pop = el('.dsum-lane', null, [
        el('.dsum-lane-head', null, [
          el('strong', null, r.ep.code + ' · ' + r.name),
          el('span', null, (rec.deps.length ? rec.deps.length + ' task' + (rec.deps.length === 1 ? '' : 's') + ' waiting on it' : 'nothing waits on it'))
        ]),
        caps,
        el('.dsum-lane-axis-row', null, axis),
        strip,
        gapCap,
        el('.dsum-lane-keys-row', null, keyStrip),
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
