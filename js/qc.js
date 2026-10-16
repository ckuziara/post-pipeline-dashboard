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
   marked at risk. The record lives on the
   episode: ep.qcChecks[key] (see App.syncQcChecks in js/state.js). */
window.App = window.App || {};
(function () {
  const el = (s, p, c) => App.el(s, p, c);
  const DONE_DAYS = 14;               // passed / failed checks stay under Completed this long
  const safeHref = (u) => /^https?:\/\//i.test(String(u || '')) ? String(u) : null;
  const me = () => { const u = App.state.user; return { by: (u && u.personId) || null, byName: (u && u.name) || 'Someone' }; };
  const KEY = (epId, key) => epId + '::' + key;

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

  /* The QC owner on a row: who's doing the check. A QC Manager gets a
     picker — the show's QC team first, then the rest of QC — and can put it
     back to the default (the show's QC person). */
  function ownerControl(ep, su) {
    const o = App.qcOwner(ep, su.key), p = o.id ? App.person(o.id) : null;
    const tip = p ? 'QC: ' + p.name + (o.auto ? '' : ' (reassigned)') : 'No QC person on this show';
    // just the circle, like the Board's Owner column
    const av = p ? el('span.avatar.qcq-av', { style: { background: p.color, color: App.pickInk(p.color) } }, App.initials(p.name))
      : el('span.avatar.avatar-none.qcq-av', null, '?');
    if (!App.canAssignQc(App.state.role)) return el('span.qcq-owner', { title: tip }, av);
    const show = App.show(ep.showId);
    const team = show ? App.deptTeam(show, 'qc').ids : [];
    const all = App.deptStaff('qc');
    const onShow = all.filter(x => team.includes(x.id)), others = all.filter(x => !team.includes(x.id));
    const pick = (id) => () => { App.filterMenu.close(); App.qcQueue.assign(ep.id, su.key, id); };
    const dflt = App.qcOwner(ep, su.key, { ignoreOwner: true }), dfltP = dflt.id && App.person(dflt.id);
    const sections = [];
    if (onShow.length) sections.push(onShow.map(x => ({ label: x.name, tip: 'On ' + show.name + '’s QC team', on: !o.auto && x.id === o.id, pick: pick(x.id) })));
    if (others.length) sections.push(others.map(x => ({ label: x.name, tip: 'Not on this show’s QC team', on: !o.auto && x.id === o.id, pick: pick(x.id) })));
    sections.push([{ label: 'Default' + (dfltP ? ' (' + dfltP.name + ')' : ''), tip: 'The show’s QC person', on: o.auto, pick: pick(null) }]);
    const btn = App.choiceMenu('qc:owner:' + ep.id + ':' + su.key, '', sections);
    btn.className = 'qcq-owner can';
    btn.innerHTML = '';
    btn.appendChild(av);
    btn.title = tip + ' — click to reassign';
    return btn;
  }


  App.qcQueue = {
    collect, plan,
    pendingCount(episodes) { return collect(episodes, false).length; },

    pass(epId, key) {
      if (!App.canDecideQc(App.state.role)) { App.toast('Only QC and Producers can pass a QC check', true); return; }
      const g = find(epId, key); if (!g || App.qcState(g.ep, key) !== 'waiting') return;
      const u = me();
      mutateCheck(epId, key, 'passing QC', (e, c) => {
        Object.assign(c, { state: 'passed', decidedAt: new Date().toISOString(), decidedBy: u.byName, planDate: null });
        e.statuses[key] = 'approved';      // out of QC; Delivered once its files are published
      });
      App.track.audit('task.qc', { episode: g.ep.code, task: g.su.name, result: 'passed', version: 'V' + App.qcVersion(g.ep, key) });
      App.toast(g.su.name + ' passed QC V' + App.qcVersion(g.ep, key));
      App.promoteDelivered(epId, key);
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
          Object.assign(c, { state: 'waiting', queuedAt: App.isoDate(App.today()), planDate: null, decidedAt: null, decidedBy: null,
            revokedAt: new Date().toISOString(), revokedBy: u.byName });
          e.statuses[key] = 'in_qc';
        });
        App.track.audit('task.qc', { episode: g.ep.code, task: g.su.name, result: 'pass revoked', version: v });
        App.toast(v + ' pass revoked — ' + g.su.name + ' is back in the QC queue');
      }, { title: 'Revoke QC Pass', yesLabel: 'Revoke' });
    },

    fail(epId, key, notes, link) {
      if (!App.canDecideQc(App.state.role)) { App.toast('Only QC and Producers can send a QC report', true); return false; }
      const g = find(epId, key); if (!g || App.qcState(g.ep, key) !== 'waiting') return false;
      notes = String(notes || '').trim();
      if (!notes) { App.toast('Say what QC found', true); return false; }
      const href = String(link || '').trim();
      if (href && !safeHref(href)) { App.toast('The report link needs to start with https://', true); return false; }
      const u = me(), at = new Date().toISOString(), version = App.qcVersion(g.ep, key);
      mutateCheck(epId, key, 'the QC report', (e, c) => {
        c.reports.push({ at, by: u.by, byName: u.byName, notes, link: href || null, version });
        Object.assign(c, { state: 'failed', decidedAt: at, decidedBy: u.byName, planDate: null });
        e.statuses[key] = 'in_progress';         // back to the department to fix
      });
      App.track.audit('task.qc', { episode: g.ep.code, task: g.su.name, result: 'report', version: 'V' + version });
      App.toast('QC V' + version + ' report sent — ' + g.su.name + ' is back with ' + App.dept(g.su.dept).label);
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

    // hand a check to another QC person, or back to the default (null)
    assign(epId, key, personId) {
      if (!App.canAssignQc(App.state.role)) { App.toast('Only a QC Manager can reassign QC', true); return; }
      const g = find(epId, key); if (!g) return;
      const was = App.qcOwner(g.ep, key);
      mutateCheck(epId, key, 'reassigning QC', (e, c) => { if (personId) c.owner = personId; else delete c.owner; });
      const now = App.qcOwner(App.state.data.episodes.find(e => e.id === epId), key);
      const p = now.id && App.person(now.id);
      App.track.audit('task.qcOwner', { episode: g.ep.code, task: g.su.name, from: (App.person(was.id) || {}).name || null, to: p ? p.name : null });
      App.toast(g.su.name + ' — QC: ' + (p ? p.name : 'unassigned') + (personId ? '' : ' (default)'));
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
       folder, named <EP>_<Deliverable>_QC_V<n> from QC's preferred
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
          branding: App.state.data.formBranding || null
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

    // a settled check's QC report — the version QC decided on
    async openReport(ep, su) {
      if (App.masterPathSet && !App.masterPathSet()) { App.toast('Connect this device to the production folder first (Preferences → Connect to Workspace)', true); return; }
      try {
        const r = await App.api.qcReport({ epId: ep.id, taskKey: su.key, pipeline: App.pipelineFor(ep), version: App.qcVersion(ep, su.key) });
        if (!r.opened) App.toast('QC report: ' + r.path);
      } catch (e) { App.toast(e.message, true); }
    },

    reportDialog(ep, su) {
      const notes = el('textarea.fld.qcq-report-in', { rows: '6', placeholder: 'What QC found: timecodes, specs, what needs fixing…' });
      const link = el('input.fld', { type: 'url', placeholder: 'https://… (optional — the full QC report)' });
      const send = () => { if (this.fail(ep.id, su.key, notes.value, link.value)) App.modal.close(); };
      App.modal.open(el('.modal-card.confirm-card', { onclick: e => e.stopPropagation() }, [
        el('.modal-head', null, [
          el('.modal-head-main', null, [
            App.icon('checkBadge', { cls: 'modal-ic' }),
            el('div', null, [
              el('.modal-title', null, 'Send QC V' + App.qcVersion(ep, su.key) + ' Report'),
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
          el('.qcq-report-notes', null, r.notes),
          href ? el('a.qcq-report-link', { href, target: '_blank', rel: 'noopener' }, [App.icon('link'), ' Full report']) : null
        ];
        const meta = 'QC V' + r.version + ' report · ' + (r.byName || 'QC') + ' · ' + App.fmtDate(String(r.at).slice(0, 10));
        const open = i === 0 && (st === 'failed' || st === 'waiting');
        kids.push(open
          ? el('.qcq-report', null, [el('.qcq-report-meta', null, meta)].concat(body))
          : el('details.qcq-report.past', null, [el('summary.qcq-report-meta', null, meta)].concat(body)));
      });
      if (st === 'failed' && App.canEditTask(App.state.role, su)) {
        kids.push(el('button.btn-primary.qcq-resubmit', {
          onclick: () => { App.modal.close(); App.qcQueue.resubmit(ep.id, su.key); }
        }, 'Resubmit to QC V' + (App.qcVersion(ep, su.key) + 1)));
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

    /* A table like the Board's: one card of checks waiting for QC and one of
       what QC settled in the last DONE_DAYS, each with a header row whose
       columns sort (ascending, descending, then back to QC due) — the same
       setting as the toolbar's Sort menu (sortBy.qc). */
    render(episodes) {
      const wrap = el('.rvq.qcq');
      wrap.appendChild(el('.section-title', null, [App.icon('checkBadge'), ' QC']));
      const open = plan(episodes).items.sort(sortChecks());
      const done = collect(episodes, true).filter(x => x.state !== 'waiting')
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
      const pending = pendingFor(episodes).sort(sortChecks());
      if (open.length) wrap.appendChild(card('Waiting for QC', open, true));
      if (pending.length) wrap.appendChild(card('Pending QC — not sent to QC yet', pending, false));
      if (done.length) wrap.appendChild(card('Completed', done, false));
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
          onclick: () => App.qcQueue.pass(ep.id, su.key) }, '✓ Pass'));
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
        el('.cell.c-date' + (late ? '.overdue' : ''), null, x.qcDue ? App.fmtDate(x.qcDue) : '—'),
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
                onclick: () => App.qcQueue.openReport(ep, su) }, App.icon('file'))
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
    },

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
