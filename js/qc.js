/* QC tab: the QC department's queue.

   QC doesn't make deliverables, it checks them. A task a Producer has marked
   Requires QC (in the show's pipeline, or on one episode from Edit Task)
   joins this queue the moment the Director approves it, and it isn't
   finished until QC passes it: dependents wait, and its files aren't
   published (App.isComplete, App.promoteDelivered). The schedule already
   holds QC's days after it (App.schedulePipeline), so each check has a QC
   due date.

   Two outcomes:
     Pass            the check is done; dependents become Ready
     Send QC Report  notes (and a link to the full report) go back to the
                     department, and the task returns to In Progress. The
                     fix comes straight back here with Resubmit to QC, from
                     Edit Task: not past the Director again, and no revision
                     spent.

   Like the Director's Priority calendar (App.reviews.open), checks are
   planned onto working days, at most App.qcSettings().perDay a day, between
   the day they joined the queue and their QC due date. One that can't fit is
   marked at risk. QC can pin a check to a day. The record lives on the
   episode: ep.qcChecks[key] (see App.syncQcChecks in js/state.js). */
window.App = window.App || {};
(function () {
  const el = (s, p, c) => App.el(s, p, c);
  const DONE_DAYS = 14;               // passed / failed checks stay listed this long
  const safeHref = (u) => /^https?:\/\//i.test(String(u || '')) ? String(u) : null;
  const me = () => { const u = App.state.user; return { by: (u && u.personId) || null, byName: (u && u.name) || 'Someone' }; };
  const KEY = (epId, key) => epId + '::' + key;

  const STATES = {
    waiting: { label: 'Waiting for QC', color: '#5fb0f0' },
    passed:  { label: 'QC passed',      color: '#00c875' },
    failed:  { label: 'QC report sent', color: '#ff6b6b' }
  };

  // every check that's live, or settled in the last DONE_DAYS
  function collect(episodes, withDone) {
    const out = [], since = App.shiftIso(App.isoDate(App.today()), -DONE_DAYS);
    episodes.forEach(ep => {
      if (!ep.qcChecks) return;
      App.subitems(ep).forEach(su => {
        const c = App.qcCheck(ep, su.key);
        if (!c || !c.state) return;
        if (c.state !== 'waiting' && (!withDone || String(c.decidedAt || '').slice(0, 10) < since)) return;
        const w = App.qcWindow(ep, su);
        out.push({ ep, su, check: c, state: c.state, qcDue: w ? w.due : null, start: w ? w.start : null });
      });
    });
    return out;
  }

  /* Plan the waiting checks onto days. The plan is worked out over every
     check on the board, then cut down to `episodes`, so a filter never
     changes what QC is doing on a given day. */
  function plan(episodes) {
    const want = new Set(episodes.map(ep => ep.id));
    const perDay = App.qcSettings().perDay;
    const todayIso = App.isoDate(App.today());
    const items = collect(App.activeEpisodes(), false)
      .sort((a, b) => (a.qcDue || '9999') < (b.qcDue || '9999') ? -1 : (a.qcDue || '9999') > (b.qcDue || '9999') ? 1
        : String(a.check.queuedAt || '') < String(b.check.queuedAt || '') ? -1 : 1);
    const cals = {};
    const isWork = (ep, iso) => {
      if (!(ep.showId in cals)) cals[ep.showId] = App.showCalendar(ep.showId);
      const cal = cals[ep.showId];
      if (cal) return !cal.isOff(iso, { dept: 'qc', person: null });
      const d = App.parseDate(iso).getDay(); return d !== 0 && d !== 6;
    };
    const load = {};
    const pinOf = (x) => x.check.planDate && x.check.planDate >= todayIso ? x.check.planDate : null;
    items.forEach(x => { const p = pinOf(x); if (p) load[p] = (load[p] || 0) + 1; });
    items.forEach(x => {
      const pinned = pinOf(x);
      if (pinned) { Object.assign(x, { date: pinned, pinned: true, atRisk: !!x.qcDue && pinned > x.qcDue }); return; }
      if (x.qcDue && x.qcDue < todayIso) { Object.assign(x, { date: todayIso, overdue: true }); load[todayIso] = (load[todayIso] || 0) + 1; return; }
      // from the day it was approved — QC can pick it up straight away, and
      // the window held in the schedule is the deadline, not the start
      const queued = String(x.check.queuedAt || '').slice(0, 10);
      let day = queued > todayIso ? queued : todayIso;
      const last = x.qcDue || App.shiftIso(day, 30);
      for (let g = 0; day <= last && g < 400; day = App.shiftIso(day, 1), g++) {
        if (!isWork(x.ep, day)) continue;
        if ((load[day] || 0) < perDay) { load[day] = (load[day] || 0) + 1; x.date = day; return; }
      }
      // no room before it's due: on its due date, and said so
      x.date = last; x.atRisk = true; load[last] = (load[last] || 0) + 1;
    });
    return { items: items.filter(x => want.has(x.ep.id)), load, perDay };
  }

  function mutateCheck(epId, key, label, fn) {
    App.mutate(d => {
      const e = d.episodes.find(x => x.id === epId); if (!e) return;
      e.qcChecks = e.qcChecks || {};
      const c = Object.assign({ reports: [] }, e.qcChecks[key]);
      c.reports = (c.reports || []).slice();
      fn(e, c);
      e.qcChecks[key] = c;
      App.refreshReadiness(e);
    }, label);
  }
  const find = (epId, key) => {
    const ep = App.state.data.episodes.find(e => e.id === epId);
    const su = ep && App.subitem(ep, key);
    return su ? { ep, su } : null;
  };

  App.qcQueue = {
    collect, plan,
    pendingCount(episodes) { return collect(episodes, false).length; },

    pass(epId, key) {
      if (!App.canDecideQc(App.state.role)) { App.toast('Only QC and Producers can pass a QC check', true); return; }
      const g = find(epId, key); if (!g || App.qcState(g.ep, key) !== 'waiting') return;
      const u = me();
      mutateCheck(epId, key, 'passing QC', (e, c) => {
        Object.assign(c, { state: 'passed', decidedAt: new Date().toISOString(), decidedBy: u.byName, planDate: null });
      });
      App.track.audit('task.qc', { episode: g.ep.code, task: g.su.name, result: 'passed' });
      App.toast(g.su.name + ' passed QC');
      App.promoteDelivered(epId, key);
    },

    fail(epId, key, notes, link) {
      if (!App.canDecideQc(App.state.role)) { App.toast('Only QC and Producers can send a QC report', true); return false; }
      const g = find(epId, key); if (!g || App.qcState(g.ep, key) !== 'waiting') return false;
      notes = String(notes || '').trim();
      if (!notes) { App.toast('Say what QC found', true); return false; }
      const href = String(link || '').trim();
      if (href && !safeHref(href)) { App.toast('The report link needs to start with https://', true); return false; }
      const u = me(), at = new Date().toISOString();
      mutateCheck(epId, key, 'the QC report', (e, c) => {
        c.reports.push({ at, by: u.by, byName: u.byName, notes, link: href || null });
        Object.assign(c, { state: 'failed', decidedAt: at, decidedBy: u.byName, planDate: null });
        e.statuses[key] = 'in_progress';         // back to the department to fix
      });
      App.track.audit('task.qc', { episode: g.ep.code, task: g.su.name, result: 'report' });
      App.toast('QC report sent — ' + g.su.name + ' is back with ' + App.dept(g.su.dept).label);
      return true;
    },

    /* The department's fix goes straight back to QC. Approved without an
       approver, on purpose: the Director already signed the creative off,
       and QC's report was about the deliverable, not the cut. */
    resubmit(epId, key) {
      const g = find(epId, key); if (!g) return;
      if (!App.canEditTask(App.state.role, g.su)) { App.toast('Only the ' + App.dept(g.su.dept).label + ' team can resubmit this', true); return; }
      if (App.qcState(g.ep, key) !== 'failed') return;
      mutateCheck(epId, key, 'resubmitting to QC', (e, c) => {
        e.statuses[key] = 'approved';             // App.syncQcChecks puts it back in the queue
        c.resubmittedAt = new Date().toISOString();
      });
      App.track.audit('task.qc', { episode: g.ep.code, task: g.su.name, result: 'resubmitted' });
      App.toast(g.su.name + ' resubmitted to QC');
    },

    pin(epId, key, iso) {
      if (!App.canDecideQc(App.state.role)) return;
      const g = find(epId, key); if (!g || App.qcState(g.ep, key) !== 'waiting') return;
      mutateCheck(epId, key, 'the QC day', (e, c) => { c.planDate = iso || null; });
    },

    reportDialog(ep, su) {
      const notes = el('textarea.fld', { rows: '6', placeholder: 'What QC found: timecodes, specs, what needs fixing…' });
      const link = el('input.fld', { type: 'url', placeholder: 'https://… (optional — the full QC report)' });
      const send = () => { if (this.fail(ep.id, su.key, notes.value, link.value)) App.modal.close(); };
      App.modal.open(el('.modal-card.confirm-card', { onclick: e => e.stopPropagation() }, [
        el('.modal-head', null, [
          el('.modal-head-main', null, [
            App.icon('checkBadge', { cls: 'modal-ic' }),
            el('div', null, [
              el('.modal-title', null, 'Send QC Report'),
              el('.modal-subtitle', null, su.name + ' · ' + ep.code + ' ' + (ep.title || ''))
            ])
          ]),
          el('button.modal-x', { onclick: () => App.modal.close(), title: 'Close' }, '✕')
        ]),
        el('.modal-body', null, [
          el('.modal-section-title', { style: { marginTop: '0' } }, 'Report'),
          notes,
          el('.modal-section-title', { style: { marginTop: '14px' } }, [App.icon('link'), ' Report link']),
          link,
          el('.fld-hint', null, 'The task goes back to ' + App.dept(su.dept).label + ' as In Progress, with this report. Their fix comes straight back to QC.')
        ]),
        el('.modal-foot', null, [
          el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Cancel'),
          el('button.btn-danger', { onclick: send }, 'Send QC Report')
        ])
      ]));
      setTimeout(() => notes.focus(), 40);
    },

    // a small pill for the Board and Edit Task: where the QC check stands
    badge(ep, su) {
      const q = App.qcFor(ep, su.key); if (!q.on) return null;
      const st = App.qcState(ep, su.key);
      const [txt, cls, tip] = st === 'passed' ? ['QC ✓', '.passed', 'QC passed']
        : st === 'failed' ? ['QC ✕', '.failed', 'QC sent a report back — fix it and resubmit to QC']
        : su.status === 'approved' ? ['QC ◷', '.waiting', 'Approved — waiting for QC']
        : ['QC', '', 'Needs QC once approved (' + q.days + ' day' + (q.days === 1 ? '' : 's') + ')'];
      return el('span.qcq-badge' + cls, { title: tip }, txt);
    },

    /* Edit Task's QC block: where the check stands, the latest report, and
       — for the department, after a report — Resubmit to QC. */
    taskSection(ep, su) {
      const q = App.qcFor(ep, su.key);
      const c = App.qcCheck(ep, su.key);
      if (!q.on && !(c && c.reports && c.reports.length)) return null;
      const st = (c && c.state) || null;
      const w = App.qcWindow(ep, su);
      const head = st === 'passed' ? 'QC passed' + (c.decidedBy ? ' by ' + c.decidedBy : '') + (c.decidedAt ? ' on ' + App.fmtDate(c.decidedAt.slice(0, 10)) : '')
        : st === 'waiting' ? 'Approved — waiting for QC' + (w ? ', due ' + App.fmtDate(w.due) : '')
        : st === 'failed' ? 'QC sent a report back'
        : q.on ? 'Goes to QC once approved' + (w ? ' — QC held ' + App.fmtRange(w.start, w.due) : '') : 'QC no longer needed';
      const last = c && c.reports && c.reports.length ? c.reports[c.reports.length - 1] : null;
      const href = last && safeHref(last.link);
      const kids = [el('.qcq-sec-head', null, [App.icon('checkBadge'), ' ', head])];
      if (last && (st === 'failed' || st === 'waiting')) {
        kids.push(el('.qcq-report', null, [
          el('.qcq-report-meta', null, 'QC report · ' + (last.byName || 'QC') + ' · ' + App.fmtDate(last.at.slice(0, 10)) +
            (c.reports.length > 1 ? ' · ' + c.reports.length + ' reports so far' : '')),
          el('.qcq-report-notes', null, last.notes),
          href ? el('a.qcq-report-link', { href, target: '_blank', rel: 'noopener' }, [App.icon('link'), ' Full report']) : null
        ]));
      }
      if (st === 'failed' && App.canEditTask(App.state.role, su)) {
        kids.push(el('button.btn-primary.qcq-resubmit', {
          onclick: () => { App.modal.close(); App.qcQueue.resubmit(ep.id, su.key); }
        }, 'Resubmit to QC'));
      }
      return el('.qcq-sec' + (st ? '.' + st : ''), null, kids);
    },

    focus(epId, key) {
      App.state.view = 'qc';
      App.render();
      requestAnimationFrame(() => {
        const row = document.querySelector('.qcq-row[data-key="' + CSS.escape(KEY(epId, key)) + '"]');
        if (!row) { App.toast('That check is hidden by the current filters', true); return; }
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.remove('rvq-flash'); void row.offsetWidth; row.classList.add('rvq-flash');
        setTimeout(() => row.classList.remove('rvq-flash'), 1400);
      });
    },

    render(episodes) {
      const wrap = el('.rvq.qcq');
      const showDone = !!App.prefs.get('qcShowDone', false);
      wrap.appendChild(el('.qcq-top', null, [
        el('.section-title', null, [App.icon('checkBadge'), ' QC']),
        el('label.qcq-toggle', null, [
          el('span.switch' + (showDone ? '.on' : ''), { onclick: () => { App.prefs.set('qcShowDone', !showDone); App.render(); } }, el('span.knob')),
          el('span', null, 'Show checked (' + DONE_DAYS + ' days)')
        ])
      ]));

      const { items, load, perDay } = plan(episodes);
      wrap.appendChild(this.strip(load, perDay));

      const done = showDone ? collect(episodes, true).filter(x => x.state !== 'waiting') : [];
      if (!items.length && !done.length) {
        wrap.appendChild(el('.empty', null, [App.icon('checkBadge'), ' Nothing is waiting for QC right now.']));
        return wrap;
      }
      // grouped by the day each check is planned for
      const byDay = {};
      items.forEach(x => { (byDay[x.date] = byDay[x.date] || []).push(x); });
      const todayIso = App.isoDate(App.today());
      Object.keys(byDay).sort().forEach(day => {
        const list = byDay[day];
        wrap.appendChild(el('.qcq-day', null, [
          el('span.qcq-day-name', null, day === todayIso ? 'Today' : day === App.shiftIso(todayIso, 1) ? 'Tomorrow' : App.fmtDate(day)),
          el('span.qcq-day-load' + (list.length > perDay ? '.over' : ''), null, list.length + ' / ' + perDay)
        ]));
        list.forEach(x => wrap.appendChild(this.row(x)));
      });
      if (done.length) {
        wrap.appendChild(el('.qcq-day', null, [el('span.qcq-day-name', null, 'Checked')]));
        done.sort((a, b) => String(b.check.decidedAt) < String(a.check.decidedAt) ? -1 : 1).forEach(x => wrap.appendChild(this.row(x)));
      }
      return wrap;
    },

    // the next two working weeks: how full each day is against QC's capacity
    strip(load, perDay) {
      const box = el('.qcq-strip');
      let day = App.isoDate(App.today());
      for (let n = 0, g = 0; n < 10 && g < 30; day = App.shiftIso(day, 1), g++) {
        const dow = App.parseDate(day).getDay(); if (dow === 0 || dow === 6) continue;
        n++;
        const k = load[day] || 0;
        box.appendChild(el('.qcq-strip-day' + (k > perDay ? '.over' : k === perDay ? '.full' : ''), { title: k + ' of ' + perDay + ' QC checks on ' + App.fmtDate(day) }, [
          el('.qcq-strip-lbl', null, App.KO_DAYS[dow].slice(0, 3) + ' ' + App.parseDate(day).getDate()),
          el('.qcq-strip-bar', null, el('span', { style: { width: Math.min(100, Math.round(k / perDay * 100)) + '%' } })),
          el('.qcq-strip-n', null, k + '/' + perDay)
        ]));
      }
      return box;
    },

    row(x) {
      const { ep, su, check } = x;
      const dep = App.dept(su.dept);
      const show = App.show(ep.showId);
      const can = App.canDecideQc(App.state.role);
      const st = STATES[x.state] || STATES.waiting;
      const todayIso = App.isoDate(App.today());
      const late = x.state === 'waiting' && x.qcDue && x.qcDue < todayIso;
      const flag = x.state !== 'waiting' ? null : late ? el('span.qcq-flag.late', null, 'Overdue')
        : x.atRisk ? el('span.qcq-flag.risk', { title: 'QC is already full every day before this is due' }, 'At risk')
        : x.pinned ? el('span.qcq-flag', { title: 'Pinned to this day' }, 'Pinned') : null;
      const acts = [el('button.rvq-icon', { title: 'Open the discussion on this task', onclick: () => App.openTaskChat(ep.id, su.key) }, App.icon('chat'))];
      if (x.state === 'waiting' && can) {
        const pin = el('input.fld.qcq-pin', { type: 'date', value: x.date || '', min: todayIso, title: 'Plan this check for a different day',
          onchange: (e) => App.qcQueue.pin(ep.id, su.key, e.target.value) });
        acts.push(pin);
        acts.push(el('button.rvq-mini.ok', { onclick: () => App.qcQueue.pass(ep.id, su.key) }, '✓ Pass'));
        acts.push(el('button.rvq-mini', { onclick: () => App.qcQueue.reportDialog(ep, su) }, 'Send QC Report'));
      } else if (x.state !== 'waiting') {
        acts.push(el('span.qcq-state', { style: { background: st.color } }, st.label));
      }
      const row = el('.rvq-row.qcq-row' + (x.state !== 'waiting' ? '.done' : ''), null, [
        el('.rvq-cell.rvq-task', null, [
          el('.rvq-task-name', { style: { cursor: 'pointer' }, title: 'Open the task', onclick: () => App.editTask.open(ep.id, su.key) }, [su.name, ' ', flag]),
          el('.rvq-task-sub', null, [
            el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color) }, title: show.name + ' · ' + (ep.title || '') }, ep.code),
            el('span.dept-chip', null, [el('span.dot', { style: { background: dep.color } }), dep.label]),
            check.reports && check.reports.length ? el('span.rvq-who', null, check.reports.length + ' report' + (check.reports.length === 1 ? '' : 's') + ' before') : null
          ])
        ]),
        el('.rvq-cell', null, [
          el('.rvq-lbl', null, 'Approved'),
          el('.rvq-val', null, check.queuedAt ? App.fmtDate(String(check.queuedAt).slice(0, 10)) : '—')
        ]),
        el('.rvq-cell.rvq-due' + (late ? '.late' : ''), null, [
          el('.rvq-lbl', null, 'QC due'),
          el('.rvq-val', null, x.qcDue ? App.fmtDate(x.qcDue) : '—')
        ]),
        el('.rvq-cell.rvq-acts', null, acts)
      ]);
      row.dataset.key = KEY(ep.id, su.key);
      return row;
    },

    // Dashboard: today's checks, for the QC role's board
    // (m.episodes, not m.subs: for the QC role m.subs is QC's own tasks only)
    widget(m) {
      const todayIso = App.isoDate(App.today());
      const items = plan(m.episodes).items.filter(x => x.date <= todayIso || x.atRisk);
      const list = el('.pr-list');
      if (!items.length) { list.appendChild(el('.empty', null, 'Nothing to QC today')); return list; }
      items.slice(0, 8).forEach(x => {
        const show = App.show(x.ep.showId), dep = App.dept(x.su.dept);
        list.appendChild(el('.pr-item', { onclick: () => App.qcQueue.focus(x.ep.id, x.su.key) }, [
          el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color), fontSize: '10px', padding: '2px 7px' } }, x.ep.code),
          el('.ri-main', null, [
            el('.ri-title', null, x.su.name),
            el('.ri-sub', null, [el('span.dept-chip', { style: { padding: '1px 7px', fontSize: '10px' } }, [el('span.dot', { style: { background: dep.color } }), dep.label])])
          ]),
          el('span.qcq-flag' + (x.overdue ? '.late' : x.atRisk ? '.risk' : ''), null, x.overdue ? 'Overdue' : x.atRisk ? 'At risk' : 'Today')
        ]));
      });
      if (items.length > 8) list.appendChild(el('.pr-more', null, '+' + (items.length - 8) + ' more'));
      return list;
    }
  };
})();
