/* Boot + interactions: role/view switching, permission-guarded status & task edits,
   show creation/removal, team-role assignment, and popup/modal dismissal. */
window.App = window.App || {};
(function () {
  'use strict';

  const SHOW_PALETTE = ['#ff6f9c', '#6cc24a', '#f6be00', '#a06cd5', '#3da4dd', '#ff7a59', '#27c4b8', '#e35d6a'];
  const PERSON_PALETTE = ['#e8615b', '#f6a609', '#37b679', '#2d9cdb', '#9b59b6', '#16a085', '#e67e22', '#d6457f', '#4b6bfb'];

  // Keep "Ready to Start" honest after any change: a not-started task whose (non-removed)
  // dependencies are all Approved becomes Ready; a Ready task that loses a dep drops back.
  App.refreshReadiness = function (ep) {
    const removed = ep.removed || [];
    const pipe = App.pipelineFor(ep);
    pipe.forEach(t => {
      if (removed.includes(t.key)) return;
      const cur = ep.statuses[t.key] || 'not_started';
      const deps = t.deps.filter(d => !removed.includes(d) && pipe.some(p => p.key === d));
      const depsOK = deps.every(d => (ep.statuses[d] || 'not_started') === 'approved');
      const hasOwner = !!(ep.assignees && ep.assignees[t.key]);
      // no-dependency tasks are ready from day one — provided someone owns them
      if (cur === 'not_started' && depsOK && (deps.length || hasOwner)) ep.statuses[t.key] = 'ready';
      else if (cur === 'ready' && !depsOK) ep.statuses[t.key] = 'not_started';
    });
  };

  // ---- permission helpers shared by the mutators ----
  function findTask(epId, key) {
    const ep = App.state.data.episodes.find(e => e.id === epId);
    const su = ep && App.subitem(ep, key);
    return su ? { ep, su } : null;
  }
  // department-scoped gate: may this role touch the task at all?
  function guardEdit(epId, key) {
    const g = findTask(epId, key);
    if (!g) return null;
    if (!App.canEditTask(App.state.role, g.su)) {
      const d = App.roleDept(App.state.role);
      App.toast('Your role can only edit ' + (d ? App.dept(d).label : 'permitted') + ' tasks', true);
      return null;
    }
    return g;
  }
  // scheduling is its own right and spans departments (see App.canEditSchedule)
  function guardSchedule(epId, key) {
    const g = findTask(epId, key);
    if (!g) return null;
    if (!App.canEditSchedule(App.state.role)) {
      App.toast('Only Producers, Managers and Post Operations can change the schedule', true);
      return null;
    }
    return g;
  }

  App.setStatus = function (epId, key, status) {
    App.board.closePop && App.board.closePop();
    const g = guardEdit(epId, key); if (!g) return;
    if (status === 'approved' && !App.canApprove(App.state.role)) {
      App.toast('Only Producer, Director or Manager can approve tasks', true); return;
    }
    const wasApproved = g.su.status === 'approved';
    App.mutate(d => { const e = d.episodes.find(x => x.id === epId); e.statuses[key] = status; App.refreshReadiness(e); });
    App.track.audit('task.status', { episode: g.ep.code, task: g.su.name, from: g.su.status, to: status });
    App.toast(g.su.name + ' → ' + App.status(status).label);
    if (status === 'approved' && !wasApproved) App.promoteDelivered(epId, key);
  };

  App.applyTaskEdit = function (epId, key, { name, status, start, due, assignee }) {
    const g = findTask(epId, key); if (!g) return;
    const role = App.state.role;
    // Each field has its own right; anything the role lacks is left untouched
    // rather than blocking the save. A department owner can still move their
    // task's status on, and a scheduler can still redate another team's task.
    const canTouch = App.canEditTask(role, g.su);
    const canName = App.canEditTaskName(role), canSched = App.canEditSchedule(role);
    if (!canTouch && !canSched) {
      const d = App.roleDept(role);
      App.toast('Your role can only edit ' + (d ? App.dept(d).label : 'permitted') + ' tasks', true);
      return;
    }
    if (canTouch && status === 'approved' && g.su.status !== 'approved' && !App.canApprove(role)) {
      App.toast('Only Producer, Director or Manager can approve tasks', true); return;
    }
    const wasApproved = g.su.status === 'approved';
    App.mutate(d => {
      const e = d.episodes.find(x => x.id === epId);
      e.names = e.names || {}; e.dates = e.dates || {};
      if (canName) e.names[key] = name;
      if (canSched) e.dates[key] = { start, due };
      if (canTouch) e.statuses[key] = status;
      // assignee is only passed when the editor holds the assign-owners privilege
      if (assignee !== undefined && canTouch && App.canAssignOwners(role)) {
        e.assignees = e.assignees || {};
        if (assignee) e.assignees[key] = assignee; else delete e.assignees[key];
      }
      App.refreshReadiness(e);
    });
    // record only the fields that actually moved, so the log reads as a diff
    const changed = {};
    if (canName && name !== g.su.name) changed.name = { from: g.su.name, to: name };
    if (canSched && (start !== g.su.start || due !== g.su.due)) changed.schedule = { from: g.su.start + '→' + g.su.due, to: start + '→' + due };
    if (canTouch && status !== g.su.status) changed.status = { from: g.su.status, to: status };
    if (Object.keys(changed).length) {
      App.track.audit('task.edit', { episode: g.ep.code, task: g.su.name, changed });
    }
    App.toast('Saved “' + (canName ? name : g.su.name) + '”');
    if (canTouch && status === 'approved' && !wasApproved) App.promoteDelivered(epId, key);
  };

  /* Approval is what turns delivered work into an asset the next department can
     use, so that's the moment the files move out of the episode's Mezzanine
     folder into Publish. Silent when there's nothing waiting — plenty of tasks
     are approved without a file attached. */
  App.promoteDelivered = function (epId, key) {
    if (!App.masterPathSet || !App.masterPathSet()) return;
    const ep = App.state.data.episodes.find(e => e.id === epId); if (!ep) return;
    App.api.flush()
      .then(() => App.api.taskPromote({ epId, taskKey: key, pipeline: App.pipelineFor(ep) }))
      .then(r => {
        if (!r.promoted) return;
        App.toast(r.promoted + ' delivered file' + (r.promoted === 1 ? '' : 's') + ' published');
        App.workspace && App.workspace.reload && App.workspace.reload();
      })
      .catch(e => App.toast('Approved, but publishing the files failed: ' + e.message, true));
  };

  // Reschedule a task by dragging its bar on the Timeline. minDays is a hard
  // floor (rejected outright — the drag itself already clamps to it live, so
  // this only fires on a genuine bug or a very fast gesture); dependency
  // ordering is a soft rule — the move still applies, but the user is warned.
  App.moveTask = function (epId, key, newStart, newDue) {
    const g = guardSchedule(epId, key); if (!g) return;
    const pipe = App.pipelineFor(g.ep);
    const task = pipe.find(t => t.key === key);
    const minDays = (task && task.minDays) || 1;
    const hideWeekends = App.prefs.get('hideWeekends', true);
    const span = App.visibleDayCount(newStart, newDue, hideWeekends);
    if (span < minDays) {
      App.toast('“' + g.su.name + '” needs at least ' + minDays + ' day' + (minDays === 1 ? '' : 's') + ' — adjustment ignored', true);
      return;
    }

    const byKey = {}; App.subitems(g.ep).forEach(s => { byKey[s.key] = s; });
    const warnings = [];
    (task ? task.deps : []).forEach(dk => {
      const dep = byKey[dk];
      if (dep && newStart <= dep.due) warnings.push('now starts before its dependency “' + dep.name + '” finishes');
    });
    pipe.forEach(t => {
      if (t.key !== key && t.deps.includes(key)) {
        const dependent = byKey[t.key];
        if (dependent && dependent.start <= newDue) warnings.push('“' + dependent.name + '” now starts before it finishes');
      }
    });

    App.mutate(d => {
      const e = d.episodes.find(x => x.id === epId);
      e.dates = e.dates || {};
      e.dates[key] = { start: newStart, due: newDue };
      App.refreshReadiness(e);
    });
    if (newStart !== g.su.start || newDue !== g.su.due) {
      App.track.audit('task.reschedule', {
        episode: g.ep.code, task: g.su.name,
        from: g.su.start + '→' + g.su.due, to: newStart + '→' + newDue,
        brokeDependency: warnings.length > 0
      });
    }
    if (warnings.length) App.toast('“' + g.su.name + '”: ' + warnings.join('; '), true);
    else App.toast('“' + g.su.name + '” → ' + App.fmtRange(newStart, newDue));
  };

  // toggle a role's assign-owners privilege (Admin panel)
  App.setAssignPriv = function (roleKey, allowed) {
    if (!App.isAdminRole(App.state.role)) { App.toast('Only admins can change privileges', true); return; }
    App.mutate(d => {
      const cur = d.assignPriv || App.defaultAssignPriv();
      d.assignPriv = allowed ? [...new Set([...cur, roleKey])] : cur.filter(k => k !== roleKey);
    });
    App.track.audit('perm.change', { role: roleKey, permission: 'Assign Task Owners', allowed });
    App.toast(App.role(roleKey).label + (allowed ? ' can now assign owners' : ' can no longer assign owners'));
  };

  // toggle any other role capability (Admin → Access Control). The Producer's
  // permissions are locked so an admin can never lock everyone out.
  App.setRolePerm = function (roleKey, perm, allowed, label) {
    if (!App.isAdminRole(App.state.role)) { App.toast('Only admins can change privileges', true); return; }
    if (roleKey === 'producer' && !allowed) { App.toast('Producer permissions are locked', true); return; }
    App.mutate(d => {
      d.rolePerms = d.rolePerms || {};
      d.rolePerms[roleKey] = d.rolePerms[roleKey] || {};
      d.rolePerms[roleKey][perm] = allowed;
    });
    App.track.audit('perm.change', { role: roleKey, permission: label || perm, allowed });
    App.toast(label + (allowed ? ' enabled' : ' disabled') + ' for ' + App.role(roleKey).label);
  };

  // enable/disable a connector globally (Workflow Settings → Connectors).
  // Disabled connectors are hidden everywhere in the app.
  App.setConnector = function (key, enabled) {
    if (!App.isAdminRole(App.state.role)) { App.toast('Only admins can change connectors', true); return; }
    App.mutate(d => { d.connectors = d.connectors || {}; d.connectors[key] = enabled; });
    const c = App.connector(key);
    App.toast((c ? c.label : key) + (enabled ? ' enabled' : ' disabled'));
  };

  // ---- Workflow & Status Settings (Admin) ----
  // All persist as overrides in data.workflow; App.applyWorkflow folds them
  // into the live DEPARTMENTS/STATUSES on the next render.
  function guardAdmin() {
    if (!App.isAdminRole(App.state.role)) { App.toast('Only admins can change workflow settings', true); return false; }
    return true;
  }
  const HEX = /^#[0-9a-fA-F]{6}$/;

  App.setStatusStyle = function (key, patch) {
    if (!guardAdmin()) return;
    if (!App._DEFAULT_STATUSES[key]) return;
    if (patch.color && !HEX.test(patch.color)) { App.toast('Enter a valid colour', true); return; }
    if (patch.label != null && !patch.label.trim()) { App.toast('Status name can’t be empty', true); return; }
    App.mutate(d => {
      d.workflow = d.workflow || {};
      d.workflow.statuses = d.workflow.statuses || {};
      d.workflow.statuses[key] = Object.assign({}, d.workflow.statuses[key], patch);
    });
    App.track.audit('workflow.status', { status: key, patch });
  };

  App.setDeptStyle = function (key, patch) {
    if (!guardAdmin()) return;
    if (patch.color && !HEX.test(patch.color)) { App.toast('Enter a valid colour', true); return; }
    if (patch.label != null && !patch.label.trim()) { App.toast('Department name can’t be empty', true); return; }
    App.mutate(d => {
      d.workflow = d.workflow || {};
      d.workflow.departments = d.workflow.departments || {};
      d.workflow.departments[key] = Object.assign({}, d.workflow.departments[key], patch);
    });
    App.track.audit('workflow.department', { department: key, patch });
  };

  const DEPT_PALETTE = ['#7a5cff', '#2ec4b6', '#e07a5f', '#f2b134', '#5f8fff', '#d65db1', '#3ec46d', '#ff8f6b'];
  App.addDept = function (label) {
    if (!guardAdmin()) return;
    label = (label || '').trim();
    if (!label) { App.toast('Enter a department name', true); return; }
    let base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'dept';
    let key = base, i = 2;
    while (App.DEPARTMENTS[key]) key = base + '_' + (i++);
    const color = DEPT_PALETTE[Object.keys(App.DEPARTMENTS).length % DEPT_PALETTE.length];
    App.mutate(d => {
      d.workflow = d.workflow || {};
      d.workflow.departments = d.workflow.departments || {};
      d.workflow.departments[key] = { label, color };
    });
    App.track.audit('workflow.deptAdd', { department: label });
    App.toast('Added department “' + label + '”');
  };

  App.removeDept = function (key) {
    if (!guardAdmin()) return;
    if (App.isDefaultDept(key)) { App.toast('Built-in departments can’t be removed', true); return; }
    const inUse = App.state.data.shows.some(s => (s.pipeline || []).some(t => t.dept === key)) ||
                  App.ROLES.some(r => r.dept === key);
    const remove = () => {
      App.mutate(d => { if (d.workflow && d.workflow.departments) delete d.workflow.departments[key]; });
      App.track.audit('workflow.deptRemove', { department: key });
      App.toast('Department removed');
    };
    if (!inUse) return remove();
    App.confirm('This department is still used by a show pipeline or role. Remove it anyway?',
      remove, { title: 'Remove department', yesLabel: 'Remove' });
  };

  App.resetWorkflow = function () {
    if (!guardAdmin()) return;
    App.confirm('Reset all department and status colours & names to their defaults?', () => {
      App.mutate(d => { delete d.workflow; });
      App.track.audit('workflow.reset', {});
      App.toast('Workflow settings reset to defaults');
    }, { title: 'Reset workflow settings', yesLabel: 'Reset', icon: 'gear' });
  };

  // ---- Shows & episodes archive (Admin → Workflow → Shows) ----
  // Archiving hides content from every view but keeps all of its data;
  // only archived content can be permanently deleted.
  App.setShowArchived = function (showId, archived) {
    if (!guardAdmin()) return;
    const s = App.state.data.shows.find(x => x.id === showId); if (!s) return;
    App.mutate(d => {
      const t = d.shows.find(x => x.id === showId);
      if (archived) t.archived = true; else delete t.archived;
    });
    App.track.audit(archived ? 'show.archive' : 'show.restore', { show: s.name });
    if (archived && App.state.filters.show === showId) { App.state.filters.show = 'all'; App.render(); }
    App.toast((archived ? 'Archived “' : 'Restored “') + s.name + '”');
  };

  App.setEpisodeArchived = function (epId, archived) {
    if (!guardAdmin()) return;
    const ep = App.state.data.episodes.find(x => x.id === epId); if (!ep) return;
    App.mutate(d => {
      const t = d.episodes.find(x => x.id === epId);
      if (archived) t.archived = true; else delete t.archived;
    });
    App.track.audit(archived ? 'episode.archive' : 'episode.restore', { episode: ep.code, title: ep.title });
    App.toast((archived ? 'Archived ' : 'Restored ') + ep.code + ' — ' + ep.title);
  };

  App.deleteShow = function (showId) {
    if (!guardAdmin()) return;
    const s = App.state.data.shows.find(x => x.id === showId);
    if (!s || !s.archived) { App.toast('Only archived shows can be deleted', true); return; }
    const n = App.state.data.episodes.filter(e => e.showId === showId).length;
    App.confirm('Permanently delete “' + s.name + '” and its ' + n + ' episode' + (n === 1 ? '' : 's') + '? This can’t be undone.', () => {
      App.mutate(d => {
        d.shows = d.shows.filter(x => x.id !== showId);
        d.episodes = d.episodes.filter(e => e.showId !== showId);
      });
      App.track.audit('show.delete', { show: s.name, episodes: n });
      App.toast('Deleted “' + s.name + '”');
    }, { title: 'Delete show' });
  };

  App.deleteEpisode = function (epId) {
    if (!guardAdmin()) return;
    const ep = App.state.data.episodes.find(x => x.id === epId);
    if (!ep || !App.isEpArchived(ep)) { App.toast('Only archived episodes can be deleted', true); return; }
    App.confirm('Permanently delete ' + ep.code + ' — “' + ep.title + '”? This can’t be undone.', () => {
      App.mutate(d => { d.episodes = d.episodes.filter(x => x.id !== epId); });
      App.track.audit('episode.delete', { episode: ep.code, title: ep.title });
      App.toast('Deleted ' + ep.code);
    }, { title: 'Delete episode' });
  };

  // ---- Pipeline presets (Admin → Workflow → Pipelines) ----
  // Named, reusable pipelines per show type. Add Show offers them alongside
  // the built-in defaults; a created show always takes its own deep copy, so
  // editing or deleting a preset never touches existing shows.
  App.savePipelinePreset = function (preset) {
    if (!guardAdmin()) return false;
    const name = (preset.name || '').trim();
    if (!name) { App.toast('Give the pipeline a name', true); return false; }
    if (!preset.pipeline.length) { App.toast('The pipeline needs at least one task', true); return false; }
    if (!App.topoSort(preset.pipeline)) { App.toast('The pipeline has a dependency cycle', true); return false; }
    App.mutate(d => {
      d.pipelinePresets = d.pipelinePresets || [];
      const clean = {
        id: preset.id || App.uid(),
        name,
        type: preset.type === 'live_action' ? 'live_action' : 'animation',
        pipeline: preset.pipeline.map(t => ({
          key: t.key, name: (t.name || '').trim() || t.key, dept: t.dept,
          days: t.days, minDays: t.minDays, deps: t.deps.slice()
        }))
      };
      const i = d.pipelinePresets.findIndex(x => x.id === clean.id);
      if (i >= 0) d.pipelinePresets[i] = clean; else d.pipelinePresets.push(clean);
    });
    App.toast('Saved pipeline “' + name + '”');
    return true;
  };

  App.duplicatePipelinePreset = function (id) {
    if (!guardAdmin()) return;
    const p = (App.state.data.pipelinePresets || []).find(x => x.id === id);
    if (!p) return;
    const copy = JSON.parse(JSON.stringify(p));
    copy.id = App.uid();
    copy.name = p.name + ' copy';
    App.mutate(d => { d.pipelinePresets.push(copy); });
    App.toast('Duplicated “' + p.name + '”');
  };

  App.deletePipelinePreset = function (id) {
    if (!guardAdmin()) return;
    const p = (App.state.data.pipelinePresets || []).find(x => x.id === id);
    if (!p) return;
    App.confirm('Delete the pipeline preset “' + p.name + '”? Shows already created from it keep their own copy.', () => {
      App.mutate(d => { d.pipelinePresets = d.pipelinePresets.filter(x => x.id !== id); });
      App.toast('Deleted “' + p.name + '”');
    }, { title: 'Delete pipeline preset' });
  };

  App.removeTask = function (epId, key) {
    const g = findTask(epId, key); if (!g) return;
    if (!App.canRemoveTask(App.state.role)) {
      App.toast('Only Producers and Managers can remove tasks', true); return;
    }
    App.mutate(d => {
      const e = d.episodes.find(x => x.id === epId);
      e.removed = e.removed || []; if (!e.removed.includes(key)) e.removed.push(key);
      App.refreshReadiness(e);
    });
    App.track.audit('task.remove', { episode: g.ep.code, task: g.su.name });
    App.toast('Removed “' + g.su.name + '”');
  };

  // ---- shows ----
  // pipeline: the show's own task template [{key,name,dept,days,minDays,deps}].
  // scale: squeeze/extend factor from the Add Show dialog (1 = recommended pace;
  // durations never drop below each task's minDays). Episode i starts at
  // startIso + i*cadence; every task gets concrete scheduled dates in ep.dates.
  App.createShow = function ({ name, code, type, epNames, pipeline, startIso, cadence, scale }) {
    if (!App.canManageShows(App.state.role)) { App.toast('Only Producers can add shows', true); return; }
    type = type || 'animation';
    pipeline = pipeline || App.defaultPipelineFor(type);
    startIso = startIso || App.isoDate(App.today());
    cadence = cadence == null ? 14 : cadence;
    let newShowId = null;
    App.mutate(d => {
      const showId = newShowId = code.toLowerCase().replace(/[^a-z0-9]/g, '') + '_' + App.uid().slice(0, 3);
      d.shows.push({ id: showId, name, prefix: code, type, color: SHOW_PALETTE[d.shows.length % SHOW_PALETTE.length], pipeline });
      const byDept = {};
      d.people.forEach(p => { const dep = App.roleDept(p.role); if (dep) (byDept[dep] = byDept[dep] || []).push(p.id); });
      epNames.forEach((title, i) => {
        const sch = App.schedulePipeline(pipeline, App.shiftIso(startIso, i * cadence), scale);
        const assignees = {};
        pipeline.forEach(t => { const pool = byDept[t.dept] || []; if (pool.length) assignees[t.key] = pool[i % pool.length]; });
        d.episodes.push({
          id: App.uid(), showId, code: code + '-' + (i + 1), title, index: d.episodes.length,
          shiftDays: 0, dates: sch.dates,
          statuses: App.deriveStatusesFromDates(pipeline, sch.dates, assignees), assignees
        });
      });
    });
    App.track.audit('show.create', { show: name, code, type, episodes: epNames.length, tasks: pipeline.length });
    App.toast('Created “' + name + '” with ' + epNames.length + ' episode' + (epNames.length === 1 ? '' : 's'));
    // Build the whole production structure up front — shared folders plus every
    // episode's department tree. The server reads the show and its episodes from
    // stored state, so flush the pending save first or it won't see them yet.
    if (App.masterPathSet() && newShowId) {
      App.toast('Creating production folders…');
      App.api.flush()
        .then(() => App.api.createFolders({ showId: newShowId, pipeline }))
        .then(r => App.toast(r.created + ' folder' + (r.created === 1 ? '' : 's') + ' created for ' +
          r.episodes + ' episode' + (r.episodes === 1 ? '' : 's') + ' at ' + r.root))
        .catch(e => App.toast('Show created, but folders failed: ' + e.message, true));
    }
  };

  /* ---- production folders on the LucidLink master directory ----
     Admin → Workflow → Storage holds the path; it lives in shared board state so
     the whole team resolves the same root. */
  App.masterPathSet = () => !!(App.api && App.api.online &&
    App.state.data && App.state.data.storage && App.state.data.storage.masterPath);

  App.setMasterPath = function (p) {
    if (!App.isAdminRole(App.state.role)) { App.toast('Only admins can change the master directory', true); return; }
    App.mutate(d => { d.storage = Object.assign({}, d.storage, { masterPath: (p || '').trim() }); });
    App.toast((p || '').trim() ? 'Master directory saved' : 'Master directory cleared');
  };

  /* Rebuild a show's folders (Admin → Workflow → Shows). Purely additive — the
     server only creates what's missing and never touches existing folders or
     their contents — so this covers a folder someone deleted or moved, a show
     that predates the master directory being set, and a pipeline that gained
     tasks after the show was created. */
  App.rebuildShowFolders = function (showId) {
    if (!App.isAdminRole(App.state.role)) { App.toast('Only admins can rebuild production folders', true); return; }
    const show = App.show(showId); if (!show) return;
    if (!App.masterPathSet()) { App.toast('Set a master directory in Admin → Workflow → Storage first', true); return; }
    App.toast('Checking folders for “' + show.name + '”…');
    App.api.flush()
      .then(() => App.api.createFolders({ showId, pipeline: show.pipeline || App.defaultPipeline() }))
      .then(r => App.toast(r.created
        ? r.created + ' missing folder' + (r.created === 1 ? '' : 's') + ' restored for “' + show.name + '”'
        : '“' + show.name + '” is complete — all ' + r.existed + ' folders present'))
      .catch(e => App.toast('“' + show.name + '”: ' + e.message, true));
  };

  App.removeShow = function (showId) {
    if (!App.canManageShows(App.state.role)) { App.toast('Only Producers can remove shows', true); return; }
    const show = App.show(showId);
    App.confirm('Remove “' + show.name + '” and all its episodes?', () => {
      App.mutate(d => {
        d.shows = d.shows.filter(s => s.id !== showId);
        d.episodes = d.episodes.filter(e => e.showId !== showId);
      });
      App.track.audit('show.remove', { show: show.name });
      if (App.state.filters.show === showId) App.state.filters.show = 'all';
      App.render();
      App.toast('Removed “' + show.name + '”');
    }, { title: 'Remove show', yesLabel: 'Remove' });
  };

  // ---- producer notes (per-show timeline annotations) ----
  // Producers & Managers author them; everyone else sees them read-only.
  App.canEditNotes = () => App.isAdminRole(App.state.role);
  App.addNote = function (showId, note) {
    if (!App.canEditNotes()) { App.toast('Only Producers and Managers can edit notes', true); return null; }
    const id = App.uid();
    App.mutate(d => {
      const s = d.shows.find(x => x.id === showId); if (!s) return;
      s.notes = s.notes || [];
      s.notes.push(Object.assign({ id, text: '', color: '#f6be00' }, note));
    });
    App.track.audit('note.add', { show: (App.show(showId) || {}).name });
    return id;
  };
  App.updateNote = function (showId, id, patch) {
    if (!App.canEditNotes()) { App.toast('Only Producers and Managers can edit notes', true); return; }
    App.mutate(d => {
      const s = d.shows.find(x => x.id === showId);
      const n = s && s.notes && s.notes.find(x => x.id === id);
      if (n) Object.assign(n, patch);
    });
  };
  App.removeNote = function (showId, id) {
    if (!App.canEditNotes()) { App.toast('Only Producers and Managers can edit notes', true); return; }
    App.mutate(d => {
      const s = d.shows.find(x => x.id === showId);
      if (s && s.notes) s.notes = s.notes.filter(x => x.id !== id);
    });
    App.track.audit('note.remove', { show: (App.show(showId) || {}).name });
  };

  // ---- team / admin ----
  App.setPersonRole = function (id, role) {
    const was = App.person(id);
    App.mutate(d => { const p = d.people.find(x => x.id === id); if (p) p.role = role; });
    App.track.audit('person.role', { person: was ? was.name : id, from: was ? was.role : null, to: role });
    App.toast('Role updated');
  };
  App.renamePerson = function (id, name) {
    if (!name.trim()) { App.toast('Name can’t be empty', true); return; }
    App.mutate(d => { const p = d.people.find(x => x.id === id); if (p) p.name = name.trim(); });
  };
  App.setPersonEmail = function (id, email) {
    email = email.trim();
    if (email && !/^\S+@\S+\.\S+$/.test(email)) { App.toast('Enter a valid work email', true); return; }
    App.mutate(d => { const p = d.people.find(x => x.id === id); if (p) p.email = email; });
  };
  // Integration flags are placeholders until real SSO/OAuth linking exists —
  // for now they just mark whether a team member's Slack/Gmail is connected.
  App.toggleIntegration = function (id, key) {
    App.mutate(d => {
      const p = d.people.find(x => x.id === id); if (!p) return;
      p.integrations = p.integrations || {};
      p.integrations[key] = !p.integrations[key];
    });
  };
  App.addPerson = function (name, role, email) {
    email = (email || '').trim();
    if (email && !/^\S+@\S+\.\S+$/.test(email)) { App.toast('Enter a valid work email', true); return; }
    App.mutate(d => { d.people.push({ id: App.uid(), name, role, email, integrations: {}, color: PERSON_PALETTE[d.people.length % PERSON_PALETTE.length] }); });
    App.track.audit('person.add', { person: name, role, email });
    App.toast(name + ' added as ' + App.role(role).label);
  };
  App.removePerson = function (id) {
    const p = App.person(id); if (!p) return;
    App.confirm('Remove ' + p.name + ' from the team? Their task assignments will be cleared.', () => {
      App.mutate(d => {
        d.people = d.people.filter(x => x.id !== id);
        d.episodes.forEach(e => { if (e.assignees) Object.keys(e.assignees).forEach(k => { if (e.assignees[k] === id) delete e.assignees[k]; }); });
      });
      App.track.audit('person.remove', { person: p.name, role: p.role });
      if (App.state.filters.person === id) { App.state.filters.person = 'all'; App.render(); }
      App.toast(p.name + ' removed');
    }, { title: 'Remove team member', yesLabel: 'Remove' });
  };

  // ---- role preset ----
  App.setRole = function (role) {
    App.state.role = role;
    const r = App.role(role), f = App.state.filters;
    f.person = 'all';
    if (r.dept) { App.state.view = 'board'; f.dept = r.dept; }
    else { f.dept = 'all'; App.state.view = r.view || 'timeline'; }
    if (App.state.view === 'admin' && !App.isAdminRole(role)) App.state.view = 'timeline';
    App.render();
  };

  /* ---- identity: map the signed-in account onto the team directory ----
     adminEmails from server-config are always Producer (bootstrap); everyone
     else must match a directory member by work email to get their role. */
  function applyIdentity() {
    const me = App.api.me;
    if (!me) return true;                                   // offline demo mode
    const person = App.state.data.people.find(p => (p.email || '').toLowerCase() === me.email);
    App.state.user = {
      email: me.email, picture: me.picture, admin: !!me.admin,
      name: person ? person.name : me.name, personId: person ? person.id : null
    };
    if (me.admin) App.state.role = 'producer';
    else if (person) App.state.role = person.role;
    else return false;                                      // signed in but not in the directory
    App.state.baseRole = App.state.role;
    const r = App.role(App.state.role);
    App.state.view = r.dept ? 'board' : (r.view || 'timeline');
    if (r.dept) App.state.filters.dept = r.dept;
    return true;
  }

  /* ---- sign-in screens ---- */
  const G_LOGO = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.17 3.57-8.81z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.93-2.91l-3.87-3c-1.07.72-2.44 1.14-4.06 1.14-3.12 0-5.77-2.11-6.71-4.95H1.29v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.29 14.28A7.2 7.2 0 0 1 4.91 12c0-.79.14-1.56.38-2.28v-3.1H1.29a12 12 0 0 0 0 10.76l4-3.1z"/><path fill="#EA4335" d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.29 6.62l4 3.1C6.23 6.88 8.88 4.77 12 4.77z"/></svg>';

  function loginScreen() {
    const el = App.el, opts = App.api.loginOpts || {};
    const err = new URLSearchParams(location.search).get('err');
    const emailInput = el('input.login-input', { type: 'email', placeholder: 'you@moonbug.com' });
    const codeInput = opts.needsCode
      ? el('input.login-input', { type: 'password', placeholder: 'Team access code' })
      : null;
    const devSubmit = () => App.api.devLogin(emailInput.value, codeInput ? codeInput.value : undefined)
      .catch(e => App.toast(e.message, true));
    emailInput.addEventListener('keydown', e => { if (e.key === 'Enter') devSubmit(); });
    if (codeInput) codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') devSubmit(); });

    document.body.appendChild(el('.login-screen', null, el('.login-card', null, [
      App.icon('clapper', { cls: 'login-logo', size: 26 }),
      el('.login-title', null, 'Post Pipeline'),
      el('.login-sub', null, 'Episodic post-production tracker'),
      (err ? el('.login-err', null, [App.icon('warn'), ' ' + err]) : null),
      el('a.login-google' + (opts.googleConfigured ? '' : '.disabled'),
        { href: opts.googleConfigured ? '/auth/google' : null },
        [el('span.login-g', { html: G_LOGO }), 'Sign in with Google']),
      (!opts.googleConfigured ? el('.login-hint', null, 'Google SSO isn’t configured yet — the server owner can enable it (see README). Use the team sign-in below for now.') : null),
      (opts.devLogin ? el('.login-div', null, el('span', null, 'or')) : null),
      (opts.devLogin ? el('.login-dev' + (codeInput ? '.stacked' : ''), null, [
        emailInput,
        codeInput,
        el('button.btn-primary', { onclick: devSubmit }, 'Sign in')
      ]) : null)
    ])));
  }

  function notInDirectoryScreen() {
    const el = App.el, me = App.api.me;
    document.body.appendChild(el('.login-screen', null, el('.login-card', null, [
      App.icon('lock', { cls: 'login-logo', size: 26 }),
      el('.login-title', null, 'Almost there'),
      el('.login-sub', { style: { maxWidth: '300px' } },
        'You’re signed in as ' + me.email + ', but that address isn’t in the team directory yet. ' +
        'Ask a Producer or Manager to add it to your profile in Admin → User Directory.'),
      el('button.ghost', { onclick: () => App.api.logout(), style: { marginTop: '16px' } }, 'Sign out')
    ])));
  }

  /* ---- quick preferences popover (opens from the topbar logo/cog) ----
     The rows are scoped to the view that's open, so each tab exposes only the
     settings that actually affect it (see viewRows below). */
  App.prefsMenu = {
    _pop: null,
    close() { if (this._pop) { this._pop.remove(); this._pop = null; } },
    toggle() { this._pop ? this.close() : this.open(); },
    open() {
      this.close();
      const el = App.el;
      const prefRow = (title, key, def, onChange) => {
        const on = App.prefs.get(key, def);
        return el('.prefs-row', {
          onclick: () => {
            App.prefs.set(key, !on);
            this.open();                       // rebuild the menu with the new switch state
            if (onChange) onChange(!on);
          }
        }, [
          el('.prefs-row-title', null, title),
          el('span.switch' + (on ? '.on' : ''), null, el('span.knob'))
        ]);
      };
      const segRow = (title, key, def, options) => {
        const cur = App.prefs.get(key, def);
        return el('.prefs-row', { style: { cursor: 'default' } }, [
          el('.prefs-row-title', null, title),
          el('.prefs-seg', null, options.map(o =>
            el('button.seg' + (cur === o.v ? '.active' : ''), {
              onclick: (e) => { e.stopPropagation(); App.prefs.set(key, o.v); this.open(); App.render(); }
            }, o.label)))
        ]);
      };
      // a <select> row — for settings with more options than a segmented
      // control can hold at this width (themes)
      const selRow = (title, key, def, options, onChange) => {
        const cur = App.prefs.get(key, def);
        const sel = el('select.prefs-select');
        options.forEach(o => {
          const opt = document.createElement('option');
          opt.value = o.v; opt.textContent = o.label;
          if (o.v === cur) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener('click', e => e.stopPropagation());
        sel.addEventListener('change', () => {
          App.prefs.set(key, sel.value);
          if (onChange) onChange(sel.value);
        });
        return el('.prefs-row', { style: { cursor: 'default' } }, [
          el('.prefs-row-title', null, title), sel
        ]);
      };

      // a row of plain action buttons (no persisted switch) — for one-shot
      // commands like expand-all or resetting a layout
      const actionRow = (title, actions) => el('.prefs-row', { style: { cursor: 'default' } }, [
        el('.prefs-row-title', null, title),
        el('.prefs-actions', null, actions.map(a =>
          el('button.prefs-btn', {
            onclick: (e) => { e.stopPropagation(); a.run(); this.close(); App.render(); }
          }, a.label)))
      ]);

      // Which rows belong to which tab. Each entry returns the rows for that
      // view; anything without an entry falls through to the empty note.
      const viewRows = {
        timeline: () => [
          segRow('Sort timeline by', 'timelineSort', 'department',
            [{ v: 'episode', label: 'Episode' }, { v: 'department', label: 'Department' }, { v: 'show', label: 'Show' }]),
          prefRow('Latch scrolling', 'latchScroll', false, () => App.render()),
          prefRow('Hide weekends', 'hideWeekends', true, () => App.render())
        ],
        board: () => [
          actionRow('All episode groups', [
            { label: 'Expand', run: () => App.visibleEpisodes().forEach(ep => { App.state.expanded[ep.id] = true; }) },
            { label: 'Collapse', run: () => { App.state.expanded = {}; } }
          ])
        ],
        dashboard: () => [
          actionRow('Widget layout', [
            { label: 'Reset to default', run: () => App.prefs.set('dashOrder', null) }
          ])
        ],
        review: () => [
          segRow('Sort reviews by', 'reviewSort', 'due',
            [{ v: 'due', label: 'Due date' }, { v: 'show', label: 'Show' }, { v: 'dept', label: 'Dept' }])
        ]
      };

      const view = App.state.view;
      const label = ({ timeline: 'Timeline', board: 'Board', dashboard: 'Dashboard',
        review: 'Reviews', admin: 'Admin' })[view] || 'Quick';
      const rows = viewRows[view] ? viewRows[view]() : [];

      // Appearance applies to the whole tracker, so it sits in its own section
      // below the view-scoped rows and shows up on every tab.
      const themeRow = selRow('Theme', 'theme', 'midnight', App.THEMES, () => {
        App.applyTheme();
        this.open();        // rebuild the popover so it repaints in the new palette
        App.render();       // anything that samples the palette (timeline labels)
      });

      const pop = el('.prefs-pop', { onclick: e => e.stopPropagation() },
        [el('.prefs-title', null, label + ' preferences')]
          .concat(rows.length ? rows : [el('.prefs-note', null, 'No display options for this view.')])
          .concat([el('.prefs-title.sep', null, 'Appearance'), themeRow]));
      const r = document.getElementById('brand-logo').getBoundingClientRect();
      pop.style.top = (r.bottom + 8) + 'px';
      pop.style.left = Math.max(8, r.left) + 'px';
      document.body.appendChild(pop);
      this._pop = pop;
    }
  };

  async function boot() {
    await App.api.boot();

    if (App.api.online && !App.api.me) { loginScreen(); return; }

    if (App.api.online) {
      let remote = null;
      try { remote = await App.api.pull(); } catch (e) { /* fall through to local */ }
      if (remote) { App.state.data = remote; App.save(); }
      else { App.load(); App.api.push(); }                  // fresh server: seed it
      if (!applyIdentity()) { notInDirectoryScreen(); return; }
      App.api.startPolling();
    } else {
      App.load();                                           // no backend: localStorage mode
    }

    document.getElementById('btn-reset').addEventListener('click', () => {
      App.confirm('Reset everything to the reference demo board? All current data will be replaced for the whole team.',
        () => App.resetData(), { title: 'Reset board', yesLabel: 'Reset', icon: 'gear' });
    });
    document.getElementById('brand-logo').addEventListener('click', e => {
      e.stopPropagation();
      App.prefsMenu.toggle();
    });
    document.addEventListener('click', () => {
      App.board.closePop && App.board.closePop();
      App.prefsMenu.close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { App.board.closePop && App.board.closePop(); App.prefsMenu.close(); }
    });
    App.render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
