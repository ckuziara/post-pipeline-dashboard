/* QC tab: the QC department's queue.

   QC doesn't make deliverables, it checks them. A task a Producer has marked
   Requires QC (in the show's pipeline, or on one episode from Edit Task)
   joins this queue the moment the Director approves it, and it isn't
   finished until QC passes it: dependents wait, and its files aren't
   published (App.isComplete, App.promoteDelivered). The schedule already
   holds QC's days after it (App.schedulePipeline), so each check has a QC
   due date.

   Two outcomes:
     Pass            with a pass report saying what was checked; the check is
                     done, the files publish, dependents become Ready
     Send QC Report  notes (and a link to the full report) go back to the
                     department, and the task returns to In Progress. The
                     fix comes straight back here with Resubmit to QC, from
                     Edit Task: not past the Director again, and no revision
                     spent.

   Like the Director's Priority calendar (App.reviews.open), checks are
   planned onto working days, at most App.qcSettings().perDay a day, between
   the day they joined the queue and their QC due date. One that can't fit is
   marked at risk. The record lives on the
   episode: ep.qcChecks[key] (see App.syncQcChecks in js/state.js). */
window.App = window.App || {};
(function () {
  const el = (s, p, c) => App.el(s, p, c);
  const DONE_DAYS = 14;               // passed / failed checks stay under Completed this long
  const safeHref = (u) => /^https?:\/\//i.test(String(u || '')) ? String(u) : null;
  const me = () => { const u = App.state.user; return { by: (u && u.personId) || null, byName: (u && u.name) || 'Someone' }; };
  const KEY = (epId, key) => epId + '::' + key;
  // what QC can attach as its report — the server opens only these (QC_REPORT_EXT in server.js)
  const REPORT_EXT = /\.(xlsx|xls|xlsm|csv|numbers|pdf|docx|doc|pages|txt|rtf)$/i;
  const baseName = (p) => String(p).split(/[\\/]/).pop();
  /* A report file is stored relative to the production folder, never as this
     machine's absolute path: every machine mounts the volume somewhere of its
     own, and the server resolves it against whichever machine opens it.
     Null when the file isn't inside the production folder. */
  const relToRoot = (p, root) => {
    const norm = (x) => String(x || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const a = norm(p), r = norm(root);
    return r && a.startsWith(r + '/') ? a.slice(r.length + 1) : null;
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
  /* Pending: tasks marked Requires QC that haven't been approved yet, so
     there's nothing to check — listed so QC can see what's coming. A task
     QC sent back (failed) is under Completed instead. */
  function pendingFor(episodes) {
    const out = [];
    episodes.forEach(ep => App.subitems(ep).forEach(su => {
      if (!App.qcFor(ep, su.key).on || su.status === 'in_qc' || App.isCompleteKey(ep, su.key)) return;
      if (App.qcState(ep, su.key) === 'failed') return;
      const w = App.qcWindow(ep, su);
      out.push({ ep, su, check: App.qcCheck(ep, su.key) || {}, state: 'pending', qcDue: w ? w.due : null, date: w ? w.start : null });
    }));
    return out;
  }

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

  /* The report's QC Operator: whoever owns this episode's QC task (the
     pipeline's QC task, or its first QC-department task). With no owner
     set, the signed-in person — by name, never a role label. */
  // the QC report's QC Operator: the check's QC owner (App.qcOwner), else
  // the signed-in person — by name, never a role label
  function qcOperator(ep, key) {
    const o = App.qcOwner(ep, key), p = o.id && App.person(o.id);
    if (p) return p.name;
    const u = App.state.user, me = u && u.personId && App.person(u.personId);
    return (me && me.name) || (u && u.name) || '';
  }

  /* Toolbar Sort By for the QC tab (App.QC_SORT_OPTIONS in js/render.js):
     orders the checks within each department. Ties fall to QC due, then
     running order, so equal keys never shuffle. */
  function sortChecks() {
    const { key, dir } = App.sortPref('qc');
    const ownerName = (x) => { const o = App.qcOwner(x.ep, x.su.key); const p = o.id && App.person(o.id); return p ? p.name : '\uffff'; };
    const val = {
      qcdue: x => x.qcDue || '9999', planned: x => x.date || '9999', approved: x => String(x.check.queuedAt || ''),
      running: x => App.show(x.ep.showId).name + '\u0000' + String(x.ep.index || 0).padStart(5, '0'),
      code: x => String(x.ep.code || ''), task: x => x.su.name.toLowerCase(), owner: ownerName,
      dept: x => String(Object.keys(App.DEPARTMENTS).indexOf(x.su.dept)).padStart(3, '0')
    }[key] || (x => x.qcDue || '9999');
    const sign = dir === 'desc' ? -1 : 1;
    const cmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
    return (a, b) => sign * cmp(val(a), val(b)) || cmp(a.qcDue || '9999', b.qcDue || '9999') ||
      cmp(App.show(a.ep.showId).name, App.show(b.ep.showId).name) || (a.ep.index || 0) - (b.ep.index || 0);
  }

  /* The operator on a row: who's doing the check. A QC Manager gets a
     picker — the show's QC operators first, then the rest of QC, each with
     what they already have open — plus Auto-assign (the show's least busy
     operator) and Unassigned. */
  const loadText = (l) => { l = l || {}; return (l.open || 0) + ' open' + (l.upcoming ? ' · ' + l.upcoming + ' ahead' : ''); };
  function ownerControl(ep, su) {
    const o = App.qcOwner(ep, su.key), p = o.id ? App.person(o.id) : null;
    const tip = p ? 'Operator: ' + p.name + (o.auto ? ' (auto-assigned)' : '') : 'No operator yet';
    // just the circle, like the Board's Owner column
    const av = p ? el('span.avatar.qcq-av', { style: { background: p.color, color: App.pickInk(p.color) } }, App.initials(p.name))
      : el('span.avatar.avatar-none.qcq-av', null, '?');
    if (!App.canAssignQc(App.state.role)) return el('span.qcq-owner', { title: tip }, av);
    const show = App.show(ep.showId);
    const team = App.qcOperatorsFor(show);
    const load = curLoad || App.qcWorkload();
    const byLoad = (a, b) => ((load[a.id] || {}).open || 0) - ((load[b.id] || {}).open || 0) || a.name.localeCompare(b.name);
    const all = App.deptStaff('qc');
    const onShow = all.filter(x => team.includes(x.id)).sort(byLoad), others = all.filter(x => !team.includes(x.id)).sort(byLoad);
    const pick = (id) => () => { App.filterMenu.close(); App.qcQueue.assign(ep.id, su.key, id); };
    const row = (x, onTeam) => ({ label: x.name + ' — ' + loadText(load[x.id]), tip: onTeam ? 'One of ' + show.name + '’s QC operators' : 'Not one of ' + show.name + '’s QC operators',
      on: x.id === o.id, pick: pick(x.id) });
    const sections = [];
    if (onShow.length) sections.push(onShow.map(x => row(x, true)));
    if (others.length) sections.push(others.map(x => row(x, false)));
    sections.push([
      team.length ? { label: 'Auto-assign', tip: 'Whichever of ' + show.name + '’s QC operators has the least open', on: false, pick: pick('auto') } : null,
      { label: 'Unassigned', tip: 'Nobody — it stays unassigned until it’s delegated', on: !o.id, pick: pick(null) }
    ].filter(Boolean));
    const btn = App.choiceMenu('qc:owner:' + ep.id + ':' + su.key, '', sections);
    btn.className = 'qcq-owner can';
    btn.innerHTML = '';
    btn.appendChild(av);
    btn.title = tip + ' — click to delegate';
    return btn;
  }

  /* QC due on a row. A QC Manager can move it: a date pop like the Daily
     Summary's, with the scheduled date to go back to. */
  function dueControl(ep, su, x, late) {
    const w = App.qcWindow(ep, su);
    const txt = x.qcDue ? App.fmtDate(x.qcDue) : '—';
    const can = App.canAssignQc(App.state.role) && (x.state === 'waiting' || x.state === 'pending');
    const tip = w && w.set ? 'Moved by a QC Manager — scheduled ' + App.fmtDate(w.planned) : 'The end of the QC days held in the schedule';
    if (!can) return el('span.qcq-due' + (w && w.set ? '.set' : ''), { title: tip }, txt);
    const btn = el('button.qcq-due.can' + (w && w.set ? '.set' : '') + (late ? '.overdue' : ''), { type: 'button', title: tip + ' — click to change' }, txt);
    btn.addEventListener('click', (e) => { e.stopPropagation(); openDuePop(btn, ep, su, w); });
    return btn;
  }
  function openDuePop(anchor, ep, su, w) {
    const key = 'qc:due:' + ep.id + ':' + su.key;
    if (App.filterMenu.openKey === key) { App.filterMenu.close(); return; }
    App.filterMenu.close();
    const input = el('input.fld', { type: 'date', value: (w && w.due) || '' });
    const save = (v) => { App.filterMenu.close(); App.qcQueue.setDue(ep.id, su.key, v || null); };
    const pop = el('.filter-pop.qcq-due-pop', { style: { maxHeight: 'none' }, onclick: e => e.stopPropagation() }, [
      el('.qcq-pop-title', null, 'QC due — ' + su.name),
      input,
      w && w.set ? el('.qcq-pop-hint', null, 'Scheduled: ' + App.fmtDate(w.planned)) : null,
      el('.qcq-pop-actions', null, [
        w && w.set ? el('button.btn-ghost', { onclick: () => save(null) }, 'Reset to scheduled') : null,
        el('button.btn-primary', { onclick: () => save(input.value) }, 'Set')
      ])
    ]);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(input.value); });
    const b = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(b.left, window.innerWidth - 260)) + 'px';
    document.body.appendChild(pop);
    // above the date when there's no room below it
    const h = pop.offsetHeight;
    pop.style.top = (b.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, b.top - 6 - h) : b.bottom + 6) + 'px';
    App.filterMenu.openKey = key;
    App.filterMenu._pop = pop;
    setTimeout(() => input.focus(), 20);
  }

  /* The QC tab's Operator filter (the toolbar's Owner, renamed there):
     the checks delegated to the picked people, or unassigned. */
  App.QC_UNASSIGNED = '__unassigned';
  App.qcOperatorMatch = (ep, key) => {
    const ops = (App.state.filters && App.state.filters.operator) || [];
    if (!ops.length) return true;
    const id = App.qcOwner(ep, key).id;
    return id ? ops.includes(id) : ops.includes(App.QC_UNASSIGNED);
  };
  // ...and its Dept filter: the department whose deliverable it is (With QC means nothing here)
  const deptOk = (su) => { const d = ((App.state.filters && App.state.filters.dept) || []).filter(k => k !== 'qc'); return !d.length || d.includes(su.dept); };
  /* QC's finished work, by who did it and the day: every pass and every
     report sent back (a revoked pass doesn't count), from `from` to `to`.
     Who is whoever sent it, else the check's operator.
     → { [personId]: { [iso]: [{ ep, su, done: true, result }] } } */
  function doneByDay(from, to) {
    const out = {};
    App.activeEpisodes().forEach(ep => Object.keys(ep.qcChecks || {}).forEach(key => {
      const c = ep.qcChecks[key], su = App.subitem(ep, key); if (!su) return;
      (c.reports || []).forEach(r => {
        if (r.revokedAt) return;
        const day = App.isoDate(new Date(r.at));
        if (day < from || day > to) return;
        const who = r.by && App.person(r.by) ? r.by : c.owner; if (!who) return;
        ((out[who] = out[who] || {})[day] = out[who][day] || []).push({ ep, su, done: true, result: r.result === 'pass' ? 'passed' : 'report sent' });
      });
    }));
    return out;
  }
  const opOk = (x) => App.qcOperatorMatch(x.ep, x.su.key) && deptOk(x.su);
  let curLoad = null;     // App.qcWorkload(), once per render — every row's picker reads it

  App.qcQueue = {
    collect, plan, doneByDay,
    pendingCount(episodes) { return collect(episodes, false).length; },

    /* A pass carries its own report, the same shape as one sent back, so the
       task's QC history shows what was checked and found clean — not just
       that someone clicked Pass. Both need the QC report file itself (`file`:
       { path, name }, chosen from the volume in the dialog); notes are optional,
       since the report file carries the detail. */
    pass(epId, key, notes, file) {
      if (!App.canDecideQc(App.state.role)) { App.toast('Only QC and Producers can pass a QC check', true); return false; }
      const g = find(epId, key); if (!g || App.qcState(g.ep, key) !== 'waiting') return false;
      notes = String(notes || '').trim();
      if (!file || !file.path) { App.toast('Choose the QC report file first', true); return false; }
      const u = me(), at = new Date().toISOString(), version = App.qcVersion(g.ep, key);
      mutateCheck(epId, key, 'passing QC', (e, c) => {
        c.reports.push({ at, by: u.by, byName: u.byName, notes, file: file.path, fileName: file.name, version, result: 'pass', queuedAt: c.queuedAt || null });
        Object.assign(c, { state: 'passed', decidedAt: at, decidedBy: u.byName, planDate: null, due: null });
        e.statuses[key] = 'approved';      // out of QC; Delivered once its files are published
      });
      App.track.audit('task.qc', { episode: g.ep.code, task: g.su.name, result: 'passed', version: 'V' + App.qcVersion(g.ep, key) });
      App.toast(g.su.name + ' passed QC V' + version);
      App.promoteDelivered(epId, key);
      return true;
    },

    /* Take a pass back: the check goes back in the queue at the same
       version, and the task stops counting as finished — anything waiting
       on it that hadn't started drops back from Ready (App.refreshReadiness).
       Files already published stay where they are. */
    revoke(epId, key) {
      if (!App.canDecideQc(App.state.role)) { App.toast('Only QC and Producers can revoke a QC pass', true); return; }
      const g = find(epId, key); if (!g || App.qcState(g.ep, key) !== 'passed') return;
      const v = 'QC V' + App.qcVersion(g.ep, key);
      App.confirm('Revoke the ' + v + ' pass on “' + g.su.name + '” (' + g.ep.code + ')? It goes back in the QC queue, and anything waiting on it that hasn’t started waits again.', () => {
        const u = me();
        mutateCheck(epId, key, 'revoking the QC pass', (e, c) => {
          // the pass report stays in the history, marked as taken back
          const last = c.reports[c.reports.length - 1];
          if (last && last.result === 'pass') c.reports[c.reports.length - 1] = Object.assign({}, last, { revokedAt: new Date().toISOString(), revokedBy: u.byName });
          Object.assign(c, { state: 'waiting', queuedAt: App.isoDate(App.today()), planDate: null, decidedAt: null, decidedBy: null,
            revokedAt: new Date().toISOString(), revokedBy: u.byName });
          e.statuses[key] = 'in_qc';
        });
        App.track.audit('task.qc', { episode: g.ep.code, task: g.su.name, result: 'pass revoked', version: v });
        App.toast(v + ' pass revoked — ' + g.su.name + ' is back in the QC queue');
      }, { title: 'Revoke QC Pass', yesLabel: 'Revoke' });
    },

    fail(epId, key, notes, file) {
      if (!App.canDecideQc(App.state.role)) { App.toast('Only QC and Producers can send a QC report', true); return false; }
      const g = find(epId, key); if (!g || App.qcState(g.ep, key) !== 'waiting') return false;
      notes = String(notes || '').trim();
      if (!file || !file.path) { App.toast('Choose the QC report file first', true); return false; }
      const u = me(), at = new Date().toISOString(), version = App.qcVersion(g.ep, key);
      mutateCheck(epId, key, 'the QC report', (e, c) => {
        // queuedAt: when this round joined the queue, so the Timeline can grey out the time it spent with QC
        c.reports.push({ at, by: u.by, byName: u.byName, notes, file: file.path, fileName: file.name, version, queuedAt: c.queuedAt || null });
        Object.assign(c, { state: 'failed', decidedAt: at, decidedBy: u.byName, planDate: null, due: null });
        e.statuses[key] = 'ready';               // back to the department, Ready to Start on the fix (App.isQcFix)
      });
      App.track.audit('task.qc', { episode: g.ep.code, task: g.su.name, result: 'report', version: 'V' + version });
      App.toast('QC V' + version + ' report sent — ' + g.su.name + ' is back with ' + App.dept(g.su.dept).label);
      return true;
    },

    /* What's been delivered since QC's last report — the fix. A Mezzanine
       file counts by its modified time (stamped when it's delivered, see
       /api/task/deliver/prepare), a link by when it was added. */
    fixDelivered(ep, key, mezz, links) {
      const reps = ((App.qcCheck(ep, key) || {}).reports || []).filter(r => r.result !== 'pass');
      const last = reps[reps.length - 1];
      const since = last ? Date.parse(last.at) : 0;
      return (mezz || []).filter(f => (f.mtime || 0) > since).length +
        (links || []).filter(l => Date.parse(l.at || 0) > since).length;
    },

    /* The department's fix goes straight back to QC. Approved without an
       approver, on purpose: the Director already signed the creative off,
       and QC's report was about the deliverable, not the cut. It has to be
       a fix, though: something delivered since the report (Deliver passes
       fresh: n, from fixDelivered), or QC would just get the same files. */
    resubmit(epId, key, opts) {
      const g = find(epId, key); if (!g) return;
      if (!App.canEditTask(App.state.role, g.su)) { App.toast('Only the ' + App.dept(g.su.dept).label + ' team can resubmit this', true); return; }
      if (App.qcState(g.ep, key) !== 'failed') return;
      if (!(opts && opts.fresh > 0)) { App.toast('Deliver the fix first — nothing new has been delivered since the QC V' + App.qcVersion(g.ep, key) + ' report', true); return; }
      mutateCheck(epId, key, 'resubmitting to QC', (e, c) => {
        e.statuses[key] = 'in_qc';                // App.syncQcChecks puts it back in the queue
        c.resubmittedAt = new Date().toISOString();
      });
      App.track.audit('task.qc', { episode: g.ep.code, task: g.su.name, result: 'resubmitted' });
      App.toast(g.su.name + ' resubmitted to QC — now QC V' + App.qcVersion(App.state.data.episodes.find(e => e.id === epId), key));
    },

    /* Send to QC — the department's Delivery send button, once the Director
       has approved the task and its final files are delivered. The task goes
       In QC and joins the queue. Their own department's task, so no approver
       needed: approval already happened. */
    sendToQc(epId, key, opts) {
      const g = find(epId, key); if (!g) return;
      // QC checks the delivered files, so there must be some (Deliver passes delivered: n)
      if (!(opts && opts.delivered > 0)) { App.toast('Upload the delivery files in Deliver first — QC checks those', true); return; }
      if (!App.canEditTask(App.state.role, g.su)) { App.toast('Only the ' + App.dept(g.su.dept).label + ' team can send this to QC', true); return; }
      if (!App.qcFor(g.ep, key).on) return;
      if (g.su.status !== 'approved') { App.toast(g.su.name + ' needs the Director’s approval before it goes to QC', true); return; }
      if (App.qcState(g.ep, key) === 'passed') return;
      mutateCheck(epId, key, 'sending to QC', (e) => { e.statuses[key] = 'in_qc'; });
      App.track.audit('task.qc', { episode: g.ep.code, task: g.su.name, result: 'sent to QC', version: 'V' + App.qcVersion(App.state.data.episodes.find(e => e.id === epId), key) });
      App.toast(g.su.name + ' sent to QC');
    },

    /* Delegate a check: to a person, 'auto' (the show's least busy QC
       operator — App.qcAutoAssign, run by App.syncQcChecks), or null to
       leave it unassigned (and stop it being auto-assigned). */
    assign(epId, key, personId) {
      if (!App.canAssignQc(App.state.role)) { App.toast('Only a QC Manager can delegate QC', true); return; }
      const g = find(epId, key); if (!g) return;
      const was = App.qcOwner(g.ep, key);
      mutateCheck(epId, key, 'delegating QC', (e, c) => {
        delete c.owner; delete c.ownerAuto; delete c.ownerManual;
        if (personId === 'auto') return;
        if (personId) c.owner = personId; else c.ownerManual = true;
      });
      const ep2 = App.state.data.episodes.find(e => e.id === epId);
      const now = App.qcOwner(ep2, key), p = now.id && App.person(now.id);
      App.track.audit('task.qcOwner', { episode: g.ep.code, task: g.su.name, from: (App.person(was.id) || {}).name || null, to: p ? p.name : null });
      App.toast(g.su.name + ' — ' + (p ? 'delegated to ' + p.name + (now.auto ? ' (auto)' : '')
        : personId === 'auto' ? 'auto-assigns when it reaches QC' : 'unassigned'));
    },

    /* A QC Manager moves a check's QC due date (null: back to the date the
       schedule holds). It's for this round: passing or sending a report
       clears it. */
    setDue(epId, key, iso) {
      if (!App.canAssignQc(App.state.role)) { App.toast('Only a QC Manager can change QC due dates', true); return; }
      const g = find(epId, key); if (!g) return;
      if (iso && !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
      mutateCheck(epId, key, 'the QC due date', (e, c) => { if (iso) c.due = iso; else delete c.due; });
      App.track.audit('task.qcDue', { episode: g.ep.code, task: g.su.name, due: iso || 'scheduled' });
      App.toast(g.su.name + ' — QC due ' + (iso ? App.fmtDate(iso) : 'back to the scheduled date'));
    },

    /* An operator's default shows: on (or off) a show's QC team. Its checks
       waiting with nobody on them are delegated straight away. */
    setOperatorShow(personId, showId, on) {
      if (!App.canAssignQc(App.state.role)) return;
      const person = App.person(personId), show = App.state.data.shows.find(x => x.id === showId);
      if (!person || !show) return;
      App.mutate(d => {
        const sh = d.shows.find(x => x.id === showId);
        sh.team = sh.team || {};
        const t = sh.team.qc = Object.assign({ ids: [] }, sh.team.qc);
        t.ids = on ? [...new Set((t.ids || []).concat(personId))] : (t.ids || []).filter(id => id !== personId);
        if (t.lead && !t.ids.includes(t.lead)) delete t.lead;
        d.episodes.filter(e => e.showId === showId && !App.isEpArchived(e)).forEach(e => App.syncQcChecks(e));
      }, 'QC operator shows');
      App.track.audit('show.qcOperator', { show: show.name, person: person.name, on: !!on });
      App.toast(person.name + (on ? ' now takes ' : ' no longer takes ') + show.name + '’s QC checks');
    },

    pin(epId, key, iso) {
      if (!App.canDecideQc(App.state.role)) return;
      const g = find(epId, key); if (!g || App.qcState(g.ep, key) !== 'waiting') return;
      mutateCheck(epId, key, 'the QC day', (e, c) => { c.planDate = iso || null; });
    },

    /* The task's delivered files. Approved work waiting on QC is still in
       the episode's Mezzanine (it's only published once QC passes it —
       App.promoteDelivered); after that it's in Publish. Whichever has it. */
    async openAssets(ep, su) {
      if (App.masterPathSet && !App.masterPathSet()) { App.toast('Connect this device to the production folder first (Preferences → Connect to Workspace)', true); return; }
      const base = { epId: ep.id, taskKey: su.key, pipeline: App.pipelineFor(ep) };
      const order = App.qcState(ep, su.key) === 'passed' ? ['publish', 'mezzanine'] : ['mezzanine', 'publish'];
      for (const which of order) {
        try {
          const r = await App.api.taskOpen(Object.assign({ which }, base));
          if (!r.opened) App.toast('Delivered assets: ' + r.path);
          return;
        } catch (e) { /* not there — try the other */ }
      }
      App.toast('Nothing has been delivered for ' + su.name + ' yet', true);
    },

    /* Create QC Project: QC's project for checking this version, in QC's
       folder, named by the convention (…_QC_v001, server.js qcProjectStem) from QC's preferred
       software's template (the first desktop app in Admin → Department
       Software → QC), with the QC report beside it — then the folder opens,
       so QC sees both. Asking again for the same version just opens the
       folder; nothing is made twice. */
    async createProject(ep, su) {
      if (App.masterPathSet && !App.masterPathSet()) { App.toast('Connect this device to the production folder first (Preferences → Connect to Workspace)', true); return; }
      const apps = App.deptSoftware('qc');
      const sw = apps.find(a => a.kind !== 'online' && a.ext && a.ext.length) || null;
      const version = App.qcVersion(ep, su.key);
      try {
        const w = App.qcWindow(ep, su);
        const report = {
          task: su.name, dept: App.dept(su.dept).label,
          operator: qcOperator(ep, su.key),
          qcDue: w ? App.fmtDate(w.due) : '',
          ips: App.activeShows().map(x => x.name),
          operators: App.deptStaff('qc').map(p => p.name),
          // the server uses the board's own; a companion has no board, so it uses this
          branding: App.state.data.formBranding || null,
          // the same for the naming convention, which labels the report's Assets column
          suffixes: App.namingSuffixes()
        };
        const r = await App.api.qcProject({ epId: ep.id, taskKey: su.key, pipeline: App.pipelineFor(ep), version, exts: sw ? sw.ext : [], report });
        if (r.file) {
          mutateCheck(ep.id, su.key, 'the QC project', (e, c) => {
            c.projects = Object.assign({}, c.projects, { ['V' + version]: { file: r.file, at: new Date().toISOString(), by: me().byName } });
          });
        }
        App.track.audit('task.qcProject', { episode: ep.code, task: su.name, version: 'V' + version, file: r.file || null, created: r.created });
        const what = (r.file ? r.file : 'the QC folder') + (r.reportCreated ? ' and its QC report' : '');
        App.toast(r.existed ? 'Opened the QC folder' : r.created ? 'Created ' + what + ' — opening the folder'
          : (sw ? 'No ' + sw.label + ' template in the studio library — made the QC folder' : 'Made the QC folder — QC has no desktop software set in Admin') ,
          !r.file && !r.existed);
        if (!r.opened) App.toast('QC folder: ' + r.path);
      } catch (e) { App.toast('Couldn’t create the QC project: ' + e.message, true); }
    },

    /* Run AQC over everything the task delivered. Admin → Workflow → QC
       says who checks (App.qcSettings().aqcMode):
         internal    PipeDream's own checks (aqc.js on the server) against the
                     Moonbase spec — results at once, saved as a CSV in QC's folder
         vidchecker  the media goes to VidChecker's watch-in folder; Collect
                     Reports files what it writes to the watch-out folder
         both        the two together
       The check keeps a summary per QC version, so the row shows how the
       last run went. It never passes or fails the check: that stays QC's call. */
    aqcBody(ep, su) {
      const q = App.qcSettings();
      return { epId: ep.id, taskKey: su.key, taskName: su.name, pipeline: App.pipelineFor(ep), version: App.qcVersion(ep, su.key),
        suffixes: App.namingSuffixes(),
        // the server reads the board's own; a companion has no board, so it uses this
        aqc: { aqcMode: q.aqcMode, vcIn: q.vcIn, vcOut: q.vcOut } };
    },
    async runAqc(ep, su) {
      if (App.masterPathSet && !App.masterPathSet()) { App.toast('Connect this device to the production folder first (Preferences → Connect to Workspace)', true); return; }
      const version = App.qcVersion(ep, su.key);
      const mode = App.qcSettings().aqcMode;
      App.toast((mode === 'vidchecker' ? 'Sending ' + su.name + ' to VidChecker' : 'Running AQC on ' + su.name) + '…');
      try {
        const r = await App.api.aqc(this.aqcBody(ep, su));
        if (r.empty) { App.toast('Nothing delivered for ' + su.name + ' yet — no files to check', true); return; }
        mutateCheck(ep.id, su.key, 'the AQC result', (e, c) => {
          const prev = (c.aqc && c.aqc['V' + version]) || {};
          const rec = { at: new Date().toISOString(), by: me().byName, mode: r.mode };
          if (r.result) Object.assign(rec, { result: r.result.result, counts: r.result.counts, report: r.report });
          if (r.vidchecker) rec.vc = { submittedAt: r.vidchecker.submittedAt || null, files: r.vidchecker.submitted.length, reports: [] };
          else if (prev.vc && r.mode === 'internal') delete rec.vc;
          c.aqc = Object.assign({}, c.aqc, { ['V' + version]: rec });
        });
        App.track.audit('task.aqc', { episode: ep.code, task: su.name, version: 'V' + version, mode: r.mode,
          result: r.result ? r.result.result : null, sent: r.vidchecker ? r.vidchecker.submitted.length : 0 });
        this.aqcDialog(ep, su, version, r);
      } catch (e) { App.toast('Couldn’t run AQC: ' + e.message, true); }
    },
    // VidChecker's reports, from its watch-out folder into QC's folder
    async collectAqc(ep, su, version, then) {
      try {
        const r = await App.api.aqcCollect(this.aqcBody(ep, su));
        if (r.none) { App.toast('Nothing has been sent to VidChecker for QC V' + version + ' yet', true); return null; }
        const got = r.reports.filter(x => x.file);
        mutateCheck(ep.id, su.key, 'the VidChecker reports', (e, c) => {
          const rec = Object.assign({}, c.aqc && c.aqc['V' + version]);
          rec.vc = Object.assign({}, rec.vc, { reports: got.map(x => ({ file: x.file, path: x.path, for: x.for })), waiting: r.waiting.length, collectedAt: new Date().toISOString() });
          c.aqc = Object.assign({}, c.aqc, { ['V' + version]: rec });
        });
        App.toast(got.length ? 'Filed ' + got.length + ' VidChecker report' + (got.length === 1 ? '' : 's') + ' in QC’s folder'
          + (r.waiting.length ? ' — ' + r.waiting.length + ' still waiting' : '')
          : 'No VidChecker reports yet — ' + r.waiting.length + ' file' + (r.waiting.length === 1 ? '' : 's') + ' still being checked');
        if (then) then(r);
        return r;
      } catch (e) { App.toast('Couldn’t collect VidChecker’s reports: ' + e.message, true); return null; }
    },
    aqcDialog(ep, su, version, r) {
      const res = r.result;
      const word = { pass: 'Pass', flag: 'Flag', fail: 'Fail', info: '' };
      const body = [];
      if (res) {
        if (r.mode === 'both') body.push(el('.modal-section-title', { style: { marginTop: '0' } }, [App.icon('bolt'), ' Internal AQC']));
        res.files.forEach(f => body.push(el('.aqc-file', null, [
          el('.aqc-file-head', null, [el('span.aqc-badge.' + f.result, null, word[f.result]), el('span.aqc-file-name', { title: f.name }, f.name)]),
          el('table.aqc-table', null, f.rows.map(x => el('tr.' + x.result, null, [
            el('td.aqc-res', null, x.result === 'info' ? '·' : x.result === 'pass' ? '✓' : x.result === 'flag' ? '!' : '✕'),
            el('td', null, x.label), el('td.aqc-act', null, x.actual), el('td.aqc-exp', null, x.expected)
          ])))
        ])));
      }
      if (r.vidchecker) {
        const vcBox = el('.aqc-vc');
        const draw = (col) => {
          vcBox.innerHTML = '';
          vcBox.appendChild(el('.modal-section-title', { style: { marginTop: res ? '6px' : '0' } }, [App.icon('package'), ' VidChecker']));
          const sent = r.vidchecker.submitted;
          if (!sent.length) { vcBox.appendChild(el('.fld-hint', null, 'No media files to send — VidChecker only takes movies and audio.')); return; }
          const reports = col ? col.reports.filter(x => x.file) : [];
          sent.forEach(n => {
            const mine = reports.filter(x => x.for === n);
            const st = col && col.files.find(f => f.name === n);
            const state = mine.length ? 'done' : st && st.state === 'failed' ? 'failed' : st && st.state === 'copying' ? 'copying' : 'waiting';
            vcBox.appendChild(el('.aqc-vc-row', null, [
              el('span.aqc-badge.' + (state === 'done' ? 'pass' : state === 'failed' ? 'fail' : 'flag'), null,
                state === 'done' ? 'Report' : state === 'failed' ? 'Not sent' : state === 'copying' ? 'Copying' : 'Checking'),
              el('span.aqc-file-name', { title: n }, n),
              // REPORT_EXT: what the server will open; an XML or HTML report is filed, and named, but opened from the folder
              el('span.aqc-vc-acts', null, mine.map(x => REPORT_EXT.test(x.file)
                ? el('button.btn-mini', { type: 'button', title: 'Open ' + x.file, onclick: () => this.openReportFile(ep, su, x.path) },
                    [App.icon('file'), ' ' + x.file.split('.').pop().toUpperCase()])
                : el('span.btn-mini', { title: x.file + ' — in QC’s folder' }, x.file.split('.').pop().toUpperCase())))
            ]));
            if (state === 'failed' && st.error) vcBox.appendChild(el('.fld-hint.aqc-vc-err', null, st.error));
          });
          vcBox.appendChild(el('.fld-hint', null, col
            ? (col.waiting.length ? 'VidChecker is still checking ' + col.waiting.length + ' — collect again once it’s done.' : 'Every report is in QC’s folder.')
            : 'Sent to ' + r.vidchecker.in + '. VidChecker’s reports land in its watch-out folder; Collect Reports files them in QC’s folder.'));
        };
        draw(null);
        body.push(vcBox);
        this._aqcRedraw = draw;
      }
      if (r.folders && r.folders.length) body.push(el('.fld-hint', null, 'Folders not opened (soft deliveries): ' + r.folders.join(', ')));
      const c = res && res.counts;
      const title = 'AQC · QC V' + version + (res ? ' — ' + word[res.result] : ' — sent to VidChecker');
      const sub = su.name + ' · ' + ep.code + (c ? ' · ' + c.pass + ' pass · ' + c.flag + ' flag · ' + c.fail + ' fail' : '');
      App.modal.open(el('.modal-card.aqc-card', { onclick: e => e.stopPropagation() }, [
        el('.modal-head', null, [
          el('.modal-head-main', null, [App.icon('bolt', { cls: 'modal-ic' }), el('div', null, [el('.modal-title', null, title), el('.modal-subtitle', null, sub)])]),
          el('button.modal-x', { onclick: () => App.modal.close(), title: 'Close' }, '✕')
        ]),
        el('.modal-body.aqc-body', null, body),
        el('.modal-foot', null, [
          r.report ? el('.fld-hint', { style: { marginRight: 'auto' } }, 'Saved to QC’s folder as ' + r.report) : el('span', { style: { marginRight: 'auto' } }),
          r.vidchecker && r.vidchecker.submitted.length ? el('button.btn-ghost', { type: 'button',
            onclick: () => this.collectAqc(ep, su, version, (col) => this._aqcRedraw && this._aqcRedraw(col)) }, [App.icon('download'), ' Collect Reports']) : null,
          el('button.btn-primary', { onclick: () => App.modal.close() }, 'Done')
        ])
      ]));
    },

    /* A settled check's QC report. The file QC attached when they decided it
       (the newest report's), or — for checks decided before reports were
       attached — the version's report by name in the QC folder. */
    async openReport(ep, su) {
      const c = App.qcCheck(ep, su.key), last = c && c.reports && c.reports[c.reports.length - 1];
      return this.openReportFile(ep, su, last && last.file);
    },
    async openReportFile(ep, su, file) {
      if (App.masterPathSet && !App.masterPathSet()) { App.toast('Connect this device to the production folder first (Preferences → Connect to Workspace)', true); return; }
      try {
        const r = await App.api.qcReport(Object.assign({ epId: ep.id, taskKey: su.key, pipeline: App.pipelineFor(ep), version: App.qcVersion(ep, su.key) }, file ? { path: file } : {}));
        if (!r.opened) App.toast('QC report: ' + r.path);
      } catch (e) { App.toast(e.message, true); }
    },

    passDialog(ep, su) { this.decisionDialog(ep, su, 'pass'); },
    reportDialog(ep, su) { this.decisionDialog(ep, su, 'fail'); },

    /* Pass, or Send QC Report: notes plus the QC report file itself, chosen
       from the volume with the app's own picker (never a native dialog — see
       App.folderPicker). This version's report from Create QC Project is
       attached to start with when it's there. The picker replaces this
       dialog, so what's been typed rides along in `st` and comes back. */
    decisionDialog(ep, su, mode, st) {
      const pass = mode === 'pass', v = App.qcVersion(ep, su.key);
      const base = { epId: ep.id, taskKey: su.key, pipeline: App.pipelineFor(ep) };
      st = st || { notes: pass ? 'All checks passed — no issues found.' : '', file: null, dir: null, root: null, looked: false };
      const connected = !(App.masterPathSet && !App.masterPathSet());
      const notes = el('textarea.fld.qcq-report-in', { rows: '6', placeholder: pass ? 'What QC checked: specs, picture, sound, file names…' : 'What QC found: timecodes, specs, what needs fixing…' });
      notes.value = st.notes;
      const again = () => this.decisionDialog(ep, su, mode, st);
      const fileBox = el('.qcq-file');
      const drawFile = () => {
        fileBox.innerHTML = '';
        fileBox.appendChild(st.file
          ? el('.ws-item.static', null, [App.icon('file', { cls: 'ws-ic' }), el('span.ws-name', { title: st.file.path }, st.file.name)])
          : el('.fld-hint', null, connected ? 'No report chosen yet.' : 'Connect this device to the production folder (Preferences → Connect to Workspace) to attach the report.'));
        fileBox.appendChild(el('button.btn-ghost.ws-btn', {
          disabled: !connected,
          onclick: () => {
            st.notes = notes.value;
            App.folderPicker.open(st.dir || '', (chosen) => {
              const p = Array.isArray(chosen) ? chosen[0] : chosen;
              if (p && !REPORT_EXT.test(p)) App.toast('Choose the report document — a spreadsheet, PDF or text file', true);
              else if (p && !relToRoot(p, st.root)) App.toast('Choose a report inside the production folder', true);
              else if (p) st.file = { path: relToRoot(p, st.root), name: baseName(p) };
              again();
            }, {
              pickFiles: true,
              title: 'Choose the QC V' + v + ' report',
              subtitle: 'Starts in this task’s QC folder. Nothing is moved — the report stays where it is and is attached to the ' + (pass ? 'pass' : 'report') + '.',
              confirmLabel: 'Attach this report',
              onCancel: again
            });
          }
        }, [App.icon('archive'), st.file ? ' Choose another' : ' Choose the report file']));
      };
      drawFile();
      // first time in: where the QC folder is, and this version's report if Create QC Project made one
      if (connected && !st.looked) {
        st.looked = true;
        App.api.qcFolder(Object.assign({ version: v }, base)).then(r => {
          st.dir = r.exists ? r.dir : (r.root || null);
          st.root = r.root || null;
          const rel = r.report && relToRoot(r.report, r.root);
          if (!st.file && rel) { st.file = { path: rel, name: baseName(r.report) }; drawFile(); }
        }).catch(() => {});
      }
      const send = () => {
        st.notes = notes.value;
        if ((pass ? this.pass : this.fail).call(this, ep.id, su.key, notes.value, st.file)) App.modal.close();
      };
      App.modal.open(el('.modal-card.confirm-card', { onclick: e => e.stopPropagation() }, [
        el('.modal-head', null, [
          el('.modal-head-main', null, [
            App.icon('checkBadge', { cls: 'modal-ic' }),
            el('div', null, [
              el('.modal-title', null, pass ? 'Pass QC V' + v : 'Send QC V' + v + ' Report'),
              el('.modal-subtitle', null, su.name + ' · ' + ep.code + ' ' + (ep.title || ''))
            ])
          ]),
          el('button.modal-x', { onclick: () => App.modal.close(), title: 'Close' }, '✕')
        ]),
        el('.modal-body', null, [
          el('.modal-section-title', { style: { marginTop: '0' } }, [pass ? 'Pass notes' : 'Notes', el('span.qcq-optional', null, ' — optional')]),
          notes,
          el('.modal-section-title', { style: { marginTop: '14px' } }, [App.icon('file'), ' QC report file']),
          fileBox,
          el('.fld-hint', null, pass
            ? 'Saved with the task as its QC V' + v + ' pass report. Passing publishes the delivered files and unlocks the tasks waiting on ' + su.name + '.'
            : 'The task goes back to ' + App.dept(su.dept).label + ' as In Progress, with this report. Their fix comes straight back to QC.')
        ]),
        el('.modal-foot', null, [
          el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Cancel'),
          pass ? el('button.btn-primary', { onclick: send }, '✓ Pass QC') : el('button.btn-danger', { onclick: send }, 'Send QC Report')
        ])
      ]));
      setTimeout(() => notes.focus(), 40);
    },

    // a small pill for the Board and Edit Task: where the QC check stands
    badge(ep, su) {
      const q = App.qcFor(ep, su.key); if (!q.on) return null;
      const st = App.qcState(ep, su.key), v = 'V' + App.qcVersion(ep, su.key);
      const [txt, cls, tip] = st === 'passed' ? ['QC ' + v + ' ✓', '.passed', 'QC ' + v + ' passed']
        : st === 'failed' ? ['QC ' + v + ' ✕', '.failed', 'QC ' + v + ' sent a report back — fix it and resubmit to QC']
        : su.status === 'in_qc' ? ['QC ' + v + ' ◷', '.waiting', 'In QC — waiting for QC ' + v]
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
      const v = 'QC V' + App.qcVersion(ep, su.key);
      const head = st === 'passed' ? v + ' passed' + (c.decidedBy ? ' by ' + c.decidedBy : '') + (c.decidedAt ? ' on ' + App.fmtDate(c.decidedAt.slice(0, 10)) : '')
        : st === 'waiting' ? 'In QC — waiting for ' + v + (w ? ', due ' + App.fmtDate(w.due) : '')
        : st === 'failed' ? v + ' — QC sent a report back'
        : q.on ? (su.status === 'approved' ? 'Approved — send the delivery to QC from Deliver' : 'Goes to QC once approved and the delivery is sent') +
            (w ? ' — QC held ' + App.fmtRange(w.start, w.due) : '') : 'QC no longer needed';
      const kids = [el('.qcq-sec-head', null, [App.icon('checkBadge'), ' ', head])];
      /* Every QC report, newest first, each under the version it was about.
         The latest is open while it's the one being fixed or re-checked;
         earlier versions sit folded underneath as the history. */
      const reports = ((c && c.reports) || []).map((r, i) => Object.assign({ version: i + 1 }, r)).reverse();
      reports.forEach((r, i) => {
        const href = safeHref(r.link);
        const body = [
          r.notes ? el('.qcq-report-notes', null, r.notes) : null,
          // the report file QC attached; older reports carried a link instead
          r.file ? el('button.qcq-report-link', { type: 'button', title: r.file, onclick: () => App.qcQueue.openReportFile(ep, su, r.file) }, [App.icon('file'), ' ' + (r.fileName || 'QC report')]) : null,
          href ? el('a.qcq-report-link', { href, target: '_blank', rel: 'noopener' }, [App.icon('link'), ' Full report']) : null
        ];
        const kind = r.result === 'pass' ? (r.revokedAt ? ' pass report (revoked)' : ' pass report') : ' report';
        const meta = 'QC V' + r.version + kind + ' · ' + (r.byName || 'QC') + ' · ' + App.fmtDate(String(r.at).slice(0, 10));
        const open = i === 0 && (st === 'failed' || st === 'waiting' || st === 'passed');
        kids.push(open
          ? el('.qcq-report', null, [el('.qcq-report-meta', null, meta)].concat(body))
          : el('details.qcq-report.past', null, [el('summary.qcq-report-meta', null, meta)].concat(body)));
      });
      // Resubmit lives in Edit Task's Deliver section, beside the fix it sends
      // (a connected computer: there's nothing to deliver from a phone)
      return el('.qcq-sec' + (st ? '.' + st : ''), null, kids);
    },

    focus(epId, key) {
      App.state.view = 'qc';
      if (App.qcMode() !== 'checks') App.prefs.set('qcMode', 'checks');
      App.render();
      requestAnimationFrame(() => {
        const row = document.querySelector('.qcq-row[data-key="' + CSS.escape(KEY(epId, key)) + '"]');
        if (!row) { App.toast('That check is hidden by the current filters', true); return; }
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.remove('rvq-flash'); void row.offsetWidth; row.classList.add('rvq-flash');
        setTimeout(() => row.classList.remove('rvq-flash'), 1700);
      });
    },

    /* A table like the Board's: one card of checks waiting for QC and one of
       what QC settled in the last DONE_DAYS, each with a header row whose
       columns sort (ascending, descending, then back to QC due) — the same
       setting as the toolbar's Sort menu (sortBy.qc). */
    render(episodes) {
      // the toolbar's Checks / Resources toggle (App.qcMode)
      if (App.qcMode() === 'resources') return this.resources();
      const wrap = el('.rvq.qcq');
      wrap.appendChild(el('.section-title', null, [App.icon('checkBadge'), ' QC']));
      curLoad = App.qcWorkload();
      const open = plan(episodes).items.filter(opOk).sort(sortChecks());
      const done = collect(episodes, true).filter(x => x.state !== 'waiting' && opOk(x))
        .sort((a, b) => String(b.check.decidedAt) < String(a.check.decidedAt) ? -1 : 1);
      if (!open.length && !done.length && !pendingFor(episodes).length) {
        wrap.appendChild(el('.empty', null, [App.icon('checkBadge'), ' Nothing is waiting for QC right now.']));
        return wrap;
      }
      const card = (title, items, ranked) => {
        const grid = el('.subgrid.qcq-grid');
        grid.appendChild(this.head(ranked));
        items.forEach((x, i) => grid.appendChild(this.row(x, ranked ? i + 1 : null)));
        return el('.rvq-ep.qcq-card', null, [
          el('.rvq-ep-head', null, [el('span.rvq-ep-title', null, title), el('span.rvq-dept-n', null, items.length)]),
          el('.subtable', null, grid)
        ]);
      };
      const pending = pendingFor(episodes).filter(opOk).sort(sortChecks());
      if (!open.length && !pending.length && !done.length) {
        wrap.appendChild(el('.empty', null, [App.icon('checkBadge'), ' No checks match the filters.']));
      }
      if (open.length) wrap.appendChild(card('Waiting for QC', open, true));
      if (pending.length) wrap.appendChild(card('Pending QC — not sent to QC yet', pending, false));
      if (done.length) wrap.appendChild(card('Completed', done, false));
      return wrap;
    },

    /* QC → Resources: the QC operators' week, day by day. Each operator's
       checks fall on the days the QC plan puts them (the same plan as the
       Checks list — plan(): from the day a check joins the queue, at most
       App.qcSettings().perDay a day, late ones on today), drawn as the
       Timeline's ring-and-disc against that daily figure. Under each name:
       what's in QC with them, and their default shows (the shows whose
       checks are delegated to them; a QC Manager edits them here). A row
       opens that person's workload page (App.resources.openPerson).
       Unassigned checks get a row of their own, and shows with QC work but
       no operator are called out, since nothing delegates itself there. */
    resources() {
      const wrap = el('.rvq.qcq.qcr');
      wrap.appendChild(el('.section-title', null, [App.icon('users'), ' QC Resources']));
      const staff = App.deptStaff('qc').slice().sort((a, b) => a.name.localeCompare(b.name));
      const canEdit = App.canAssignQc(App.state.role);
      const shows = App.activeShows();
      const qcLoad = App.qcWorkload();
      const perDay = App.qcSettings().perDay;
      const today = App.isoDate(App.today());
      const mon = App.mondayIso(today);
      const days = [0, 1, 2, 3, 4].map(i => App.shiftIso(mon, i));
      const DAY = ['M', 'T', 'W', 'T', 'F'];
      // the plan, by operator and day
      const byDay = {};
      plan(App.activeEpisodes()).items.forEach(x => {
        const id = App.qcOwner(x.ep, x.su.key).id || '';
        ((byDay[id] = byDay[id] || {})[x.date] = byDay[id][x.date] || []).push(x);
      });
      // and what they've already finished this week, so past days aren't blank
      const done = doneByDay(days[0], days[4]);
      Object.keys(done).forEach(id => Object.keys(done[id]).forEach(day => {
        ((byDay[id] = byDay[id] || {})[day] = byDay[id][day] || []).unshift(...done[id][day]);
      }));
      const awayOn = (p, day) => (p.timeOff || []).some(t => t.start <= day && (t.end || t.start) >= day);
      const LEVEL_C = { ok: '#37b679', full: '#f6a609', over: 'var(--danger)' };
      const levelOf = (n) => n > perDay ? 'over' : n >= perDay * 0.8 ? 'full' : 'ok';

      const dayTip = (who, day, list) => () => {
        const box = el('.res-tip');
        box.appendChild(el('.res-tip-head', null, who + ' · ' + App.fmtDate(day)));
        const nd = list.filter(x => x.done).length, np = list.length - nd;
        box.appendChild(el('.res-tip-sub', null, [nd ? nd + ' done' : null, np ? np + ' planned' : null].filter(Boolean).join(' · ') + ' · QC takes up to ' + perDay + ' a day'));
        list.slice(0, 10).forEach(x => box.appendChild(el('.res-tip-task', { style: { borderLeftColor: App.dept(x.su.dept).color } }, [
          el('span.res-tip-code', null, x.ep.code), ' ' + x.su.name,
          el('span.res-tip-meta', null, x.done ? '✓ ' + x.result : x.overdue ? 'late' : x.atRisk ? 'at risk' : x.qcDue ? 'due ' + App.fmtDate(x.qcDue) : '')
        ])));
        if (list.length > 10) box.appendChild(el('.res-tip-sub', null, '+ ' + (list.length - 10) + ' more'));
        return box;
      };
      const dayCells = (id, who, p) => days.map((day, i) => {
        const past = day < today;
        if (p && awayOn(p, day)) return el('.qcr-day.away', { title: who + ' — away ' + App.fmtDate(day) }, el('span.qcr-day-n', null, 'Off'));
        const list = (byDay[id] && byDay[id][day]) || [];
        const n = list.length, ratio = Math.min(1, n / perDay);
        const ring = el('.res-ring.qcr-ring' + (n > perDay ? '.over' : '') + (day === today ? '.now' : ''), { title: n ? dayTip(who, day, list) : who + ' — nothing ' + (past ? 'done ' : 'planned ') + App.fmtDate(day) },
          [el('.res-disc', { style: { width: (20 * Math.sqrt(ratio)) + 'px', height: (20 * Math.sqrt(ratio)) + 'px' } })]);
        ring.style.setProperty('--res-c', LEVEL_C[levelOf(n)]);
        return el('.qcr-day' + (past ? '.past' : ''), null, [ring, el('span.qcr-day-n', null, n ? String(n) : '')]);
      });

      const list = el('.qcr-list');
      const DAYNAME = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      list.appendChild(el('.qcr-row.qcr-head', null, [
        el('span.qcr-h', null, 'Operator'),
        el('span.qcr-h', null, 'In QC'),
        el('span.qcr-h', null, 'Shows'),
        el('.qcr-days', null, days.map((day, i) => el('span.qcr-h.qcr-dh' + (day === today ? '.now' : ''), { title: App.fmtDate(day) },
          [DAYNAME[i], el('span.qcr-dd', null, String(App.parseDate(day).getDate()))]))),
        el('span.qcr-h.qcr-wk', null, 'Week')
      ]));
      let weekTotal = 0;
      staff.forEach(p => {
        const q = qcLoad[p.id] || { open: 0, today: 0, late: 0, upcoming: 0 };
        const wk = days.reduce((n, d) => n + ((byDay[p.id] && byDay[p.id][d]) || []).length, 0);
        weekTotal += wk;
        const desk = el('.qcr-desk', null, [
          el('span.qcr-open', null, [el('b', null, String(q.open)), ' open']),
          q.late ? el('span.qcr-late', null, q.late + ' late') : null,
          q.today ? el('span.qcr-today', null, q.today + ' due today') : null,
          q.upcoming ? el('span', { title: 'Delegated to them, not in QC yet' }, q.upcoming + ' ahead') : null
        ]);
        const mine = shows.filter(s => App.qcOperatorsFor(s).includes(p.id));
        const showLine = el('.qcr-shows', null, mine.length
          ? mine.map(s => el('span.qcq-op-show', { style: { borderColor: s.color }, title: s.name + '’s checks are delegated to its QC operators' }, s.name))
          : [el('span.qcq-op-none', null, 'No default show')]);
        if (canEdit) {
          const menu = App.choiceMenu('qc:opshows:' + p.id, 'Shows', [shows.map(s => {
            const on = mine.includes(s);
            return { label: s.name, on, tip: on ? 'Stop delegating ' + s.name + ' to ' + p.name : 'Delegate ' + s.name + '’s checks to ' + p.name,
              pick: () => App.qcQueue.setOperatorShow(p.id, s.id, !on) };
          })], 'Default shows: the shows whose checks are delegated to ' + p.name);
          // just a +: the chips beside it already say which shows
          menu.className = 'qcq-op-edit';
          menu.innerHTML = '';
          menu.appendChild(document.createTextNode('+'));
          menu.setAttribute('aria-label', 'Default shows for ' + p.name);
          showLine.appendChild(menu);
        }
        list.appendChild(el('.qcr-row', { title: 'Open ' + p.name + '’s workload',
          onclick: (e) => { if (!e.target.closest('button, .filter-pop')) App.resources.openPerson(p.id); } }, [
          el('.qcr-who', null, [
            el('span.avatar', { style: { width: '28px', height: '28px', fontSize: '10px', background: p.color, flex: 'none', color: App.pickInk(p.color) } }, App.initials(p.name)),
            el('.qcr-id', null, [
              el('.qcr-name', null, p.name),
              el('.qcr-sub', null, App.personCapacity(p) + ' days a week' + ((p.timeOff || []).some(t => (t.end || t.start) >= mon && t.start <= days[4]) ? ' · time off this week' : ''))
            ])
          ]),
          desk,
          showLine,
          el('.qcr-days', null, dayCells(p.id, p.name, p)),
          el('.qcr-wk', { title: wk + ' check' + (wk === 1 ? '' : 's') + ' planned this week' }, [el('b', null, String(wk))])
        ]));
      });
      const un = qcLoad[''] || { open: 0 };
      if (un.open) {
        list.appendChild(el('.qcr-row.qcr-un', { title: 'Back to the checks, to delegate them', onclick: () => { App.prefs.set('qcMode', 'checks'); App.render(); } }, [
          el('.qcr-who', null, [
            el('span.avatar.avatar-none', { style: { width: '28px', height: '28px', fontSize: '10px', flex: 'none' } }, '?'),
            el('.qcr-id', null, [
              el('.qcr-name', null, 'Unassigned'),
              el('.qcr-sub', null, canEdit ? 'Open Checks to delegate' : 'Waiting for a QC Manager')
            ])
          ]),
          el('.qcr-desk', null, el('span.qcr-open', null, [el('b', null, String(un.open)), ' open'])),
          el('span'),
          el('.qcr-days', null, dayCells('', 'Unassigned', null)),
          el('.qcr-wk', null, el('b', null, String(days.reduce((n, d) => n + ((byDay[''] && byDay[''][d]) || []).length, 0))))
        ]));
      }
      if (!staff.length) list.appendChild(el('.empty', null, 'No QC operators yet — add people with the QC role in Admin.'));
      const bare = shows.filter(s => !App.qcOperatorsFor(s).length &&
        App.activeEpisodes().some(ep => ep.showId === s.id && App.subitems(ep).some(su => App.qcFor(ep, su.key).on && !App.isCompleteKey(ep, su.key))));
      wrap.appendChild(el('.rvq-ep.qcq-card.qcr-card', null, [
        el('.rvq-ep-head', null, [
          el('span.rvq-ep-title', null, 'This week · w/c ' + App.fmtDate(mon)),
          el('span.rvq-dept-n', { title: 'QC checks per day — Admin → Workflow' }, (() => { const nd = Object.values(done).reduce((n, byD) => n + Object.values(byD).reduce((m, l) => m + l.length, 0), 0); return (nd ? nd + ' done · ' : '') + (weekTotal - nd) + ' planned · up to ' + perDay + ' a day'; })())
        ]),
        el('.qcr-body', null, [
          bare.length ? el('.qcq-op-warn', null, [App.icon('warn'), ' No QC operator on ' + bare.map(s => s.name).join(', ') +
            ' — ' + (bare.length === 1 ? 'its' : 'their') + ' checks aren’t delegated automatically.' + (canEdit ? ' Add one with the + beside an operator’s shows.' : '')]) : null,
          list])
      ]));
      return wrap;
    },

    // the header row: the sortable columns drive the same Sort By as the toolbar
    head(sortable) {
      const cur = App.sortPref('qc');
      const set = (v) => { App.prefs.set('sortBy.qc', v); App.render(); };
      const col = (k, label) => {
        if (!sortable || !k) return el('.cell', null, label);
        const on = cur.key === k;
        return el('.cell.sortable' + (on ? '.sorted' : ''), {
          title: !on ? 'Sort by ' + label.toLowerCase() : cur.dir === 'asc' ? 'Sorted ascending — click for descending' : 'Sorted descending — click for QC due',
          onclick: () => set(!on ? { key: k, dir: 'asc' } : cur.dir === 'asc' ? { key: k, dir: 'desc' } : null)
        }, [label, el('span.sort-ind', null, on ? (cur.dir === 'asc' ? '↑' : '↓') : '↕')]);
      };
      return el('.subrow.head', null, [
        el('.cell.c-num', null, '#'),
        col('task', 'Task'), col('code', 'Episode'), col('dept', 'Department'),
        col('owner', 'Operator'), col('qcdue', 'QC due'),
        el('.cell', null, 'Files'), el('.cell', null, '')
      ]);
    },

    row(x, rank) {
      const { ep, su, check } = x;
      const dep = App.dept(su.dept);
      const show = App.show(ep.showId);
      const can = App.canDecideQc(App.state.role);
      const todayIso = App.isoDate(App.today());
      const waiting = x.state === 'waiting', pending = x.state === 'pending';
      const late = waiting && x.qcDue && x.qcDue < todayIso;
      const flag = !waiting ? null
        : x.atRisk && !late ? el('span.qcq-flag.risk', { title: 'QC is already full every day before this is due' }, 'At risk')
        : x.date && x.date > todayIso ? el('span.qcq-flag', { title: 'Planned for ' + App.fmtDate(x.date) + (x.pinned ? ' (pinned)' : '') }, App.fmtDate(x.date)) : null;
      const madeV = check.projects && check.projects['V' + App.qcVersion(ep, su.key)];

      const acts = [el('button.rvq-icon', { title: 'Open the discussion on this task', 'aria-label': 'Open discussion',
        onclick: () => App.openTaskChat(ep.id, su.key) }, App.icon('chat'))];
      if (pending) {
        // nothing to check until it's approved: say where the task is instead
        const st = App.status(su.status);
        const sendable = su.status === 'approved';
        acts.push(el('span.qcq-pending', { title: sendable ? 'Approved — QC starts once ' + dep.label + ' sends the delivery to QC' : 'Can’t be QC’d until it’s approved and sent to QC' },
          [el('span.et-dot', { style: { background: st.color } }), sendable ? 'Approved · not sent' : st.label]));
      } else if (waiting) {
        acts.push(el('button.rvq-mini.ok', { disabled: !can, title: can ? 'Pass QC' : 'Only QC and Producers can pass a QC check',
          onclick: () => App.qcQueue.passDialog(ep, su) }, '✓ Pass'));
        acts.push(el('button.rvq-mini.warn', { disabled: !can, title: can ? 'Send QC Report — back to ' + dep.label : 'Only QC and Producers can send a QC report',
          onclick: () => App.qcQueue.reportDialog(ep, su) }, '↺ Report'));
      } else if (x.state === 'passed') {
        acts.push(el('button.rvq-mini.ok.approved', { type: 'button', 'aria-disabled': 'true', title: 'QC passed' + (check.decidedBy ? ' by ' + check.decidedBy : '') }, '✓ Passed'));
        if (can) acts.push(el('button.rvq-mini.warn', { title: 'Revoke QC Pass — put it back in the QC queue',
          onclick: () => App.qcQueue.revoke(ep.id, su.key) }, '↺ Revoke'));
      } else {
        acts.push(el('button.rvq-mini.warn', { type: 'button', 'aria-disabled': 'true', title: 'QC report sent — back with ' + dep.label + ' to fix' }, '↺ Sent'));
      }

      const row = el('.subrow.qcq-row' + (waiting ? '' : pending ? '.pending' : '.done'), null, [
        el('.cell.c-num', null, rank != null ? String(rank) : ''),
        el('.cell.c-name.qcq-task', null,
          [el('span', null, su.name), el('span.rvq-ver', null, 'QC V' + App.qcVersion(ep, su.key)), flag]),
        el('.cell', null, el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color) }, title: show.name + ' · ' + (ep.title || '') }, ep.code)),
        el('.cell.c-dept', null, el('span.dept-chip', null, [el('span.dot', { style: { background: dep.color } }), dep.label])),
        el('.cell.c-assignee', null, ownerControl(ep, su)),
        el('.cell.c-date' + (late ? '.overdue' : ''), null, dueControl(ep, su, x, late)),
        // icon buttons, named on hover, to keep the table narrow
        el('.cell.qcq-files', null, [
          el('button.rvq-icon', { title: 'Delivered Assets — the folder ' + dep.label + ' delivered ' + su.name + ' to', 'aria-label': 'Delivered Assets',
            onclick: () => App.qcQueue.openAssets(ep, su) }, App.icon('package')),
          pending ? null : waiting ? el('button.rvq-icon.qcq-go', {
              title: madeV ? 'Open QC Folder — ' + madeV.file + ' and its QC report' : 'Create QC Project — QC’s project and QC report for this version, named and saved automatically',
              'aria-label': madeV ? 'Open QC Folder' : 'Create QC Project',
              onclick: () => App.qcQueue.createProject(ep, su)
            }, madeV ? App.icon('checkBadge') : App.icon('plus'))
            : el('button.rvq-icon.qcq-go', { title: 'Open QC Report — QC V' + App.qcVersion(ep, su.key), 'aria-label': 'Open QC Report',
                onclick: () => App.qcQueue.openReport(ep, su) }, App.icon('file')),
          // Run AQC — the dot is the last run for this version: pass / flag / fail
          ...(waiting ? (() => {
            const v = App.qcVersion(ep, su.key), last = check.aqc && check.aqc['V' + v];
            // files with a report in — a PDF and an XML for one master count once
            const vcIn = last && last.vc ? new Set((last.vc.reports || []).map(x => x.for)).size : 0;
            const vcOpen = !!(last && last.vc && last.vc.files && vcIn < last.vc.files);
            const parts = [];
            if (last && last.result) parts.push('internal: ' + last.result + ' (' + last.counts.pass + ' pass · ' + last.counts.flag + ' flag · ' + last.counts.fail + ' fail)');
            if (last && last.vc) parts.push('VidChecker: ' + vcIn + ' of ' + last.vc.files + ' files reported');
            const btns = [el('button.rvq-icon.aqc-go' + (last && last.result ? '.' + last.result : vcOpen ? '.vc' : ''), {
              title: last ? 'Run AQC again — last run ' + parts.join(' · ') : 'Run AQC — automatic checks of the delivered files',
              'aria-label': 'Run AQC',
              onclick: () => App.qcQueue.runAqc(ep, su)
            }, App.icon('bolt'))];
            if (vcOpen) btns.push(el('button.rvq-icon', { title: 'Collect VidChecker’s reports — ' + vcIn + ' of ' + last.vc.files + ' files reported so far', 'aria-label': 'Collect VidChecker reports',
              onclick: () => App.qcQueue.collectAqc(ep, su, v) }, App.icon('download')));
            return btns;
          })() : [])
        ]),
        el('.cell.rvq-acts', null, acts)
      ]);
      row.dataset.key = KEY(ep.id, su.key);
      // the whole row opens the task, as on the Board; its buttons keep their own clicks
      row.title = 'Open ' + su.name;
      row.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, .filter-pop')) return;
        App.editTask.open(ep.id, su.key, { preview: true });   // view-only when it's another department's
      });
      return row;
    }
  };
})();
