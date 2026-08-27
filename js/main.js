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
    App.mutate(d => { const e = d.episodes.find(x => x.id === epId); e.statuses[key] = status; App.refreshReadiness(e); }, 'the status change');
    App.track.audit('task.status', { episode: g.ep.code, task: g.su.name, from: g.su.status, to: status });
    App.toast(g.su.name + ' → ' + App.status(status).label);
    if (status === 'approved' && !wasApproved) App.promoteDelivered(epId, key);
  };

  App.applyTaskEdit = function (epId, key, { name, status, start, due, assignee }, opts) {
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
    /* Typing the dates is the same act as dragging them, so it meets the same
       edge: nothing may reach the live date, and reaching the delivery date is
       asked about rather than assumed. The rest of the edit waits for the
       answer — a half-applied save would be worse than a re-asked one. */
    const reSched = canSched && (start !== g.su.start || due !== g.su.due);
    const impact = reSched ? App.scheduleImpact(g.ep, key, start, due) : null;
    if (impact && impact.deny) { App.toast(impact.deny.text + ' — nothing saved', true); return; }
    if (impact && impact.delivery && !(opts && opts.confirmed) && App.impactDialog) {
      App.impactDialog.open(g.ep, key, impact, {
        onConfirm: (shiftDelivery) => {
          if (shiftDelivery) App.setEpisodeMilestone(epId, impact.delivery.ms.key, impact.delivery.suggest);
          App.applyTaskEdit(epId, key, { name, status, start, due, assignee }, { confirmed: true });
        },
        onCancel: () => App.render()
      });
      return;
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
    }, 'the task edit');
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

  /* Reschedule a task by dragging its bar on the Timeline.

     minDays is a hard floor, rejected outright — the drag clamps to it live, so
     this only fires on a genuine bug or a very fast gesture.

     Breaking a dependency is allowed, but not silently: a move that lands on
     top of one is held and put to the producer as a decision, with the old and
     new schedule drawn over each other. Confirming re-enters with
     opts.confirmed so the same call applies for real. */
  App.moveTask = function (epId, key, newStart, newDue, opts) {
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

    const impact = App.scheduleImpact(g.ep, key, newStart, newDue);
    if (impact.deny) {
      App.toast(impact.deny.text + ' — nothing moved', true);
      App.render();                            // snap the dropped bar back
      return;
    }
    if ((impact.clashes.length || impact.delivery) && !(opts && opts.confirmed) && App.impactDialog) {
      App.impactDialog.open(g.ep, key, impact, {
        onConfirm: (shiftDelivery) => App.moveTask(epId, key, newStart, newDue,
          { confirmed: true, shiftDelivery: shiftDelivery }),
        // the dragged bar is still sitting where it was dropped; a re-render
        // rebuilds it from the unchanged data, snapping it back
        onCancel: () => App.render()
      });
      return;
    }

    // the delivery date moves in the SAME mutation, so one undo puts both back
    const shiftDelivery = !!(opts && opts.shiftDelivery && impact.delivery);
    App.mutate(d => {
      const e = d.episodes.find(x => x.id === epId);
      e.dates = e.dates || {};
      e.dates[key] = { start: newStart, due: newDue };
      if (shiftDelivery) {
        e.milestones = e.milestones || {};
        e.milestones[impact.delivery.ms.key] = impact.delivery.suggest;
      }
      App.refreshReadiness(e);
    }, shiftDelivery ? 'the reschedule and delivery date' : 'the reschedule');
    if (newStart !== g.su.start || newDue !== g.su.due) {
      App.track.audit('task.reschedule', {
        episode: g.ep.code, task: g.su.name,
        from: g.su.start + '→' + g.su.due, to: newStart + '→' + newDue,
        brokeDependency: impact.clashes.length > 0,
        deliveryDate: shiftDelivery ? impact.delivery.ms.date + '→' + impact.delivery.suggest : null
      });
    }
    if (shiftDelivery) {
      App.toast('“' + g.su.name + '” moved — delivery date now ' + App.fmtDate(impact.delivery.suggest), true);
    } else if (impact.delivery) {
      App.toast('“' + g.su.name + '” moved — the delivery date (' +
        App.fmtDate(impact.delivery.ms.date) + ') stands', true);
    } else if (impact.clashes.length) {
      App.toast('“' + g.su.name + '” moved — ' + impact.clashes.length +
        ' dependency clash' + (impact.clashes.length === 1 ? '' : 'es') + ' accepted', true);
    } else {
      App.toast('“' + g.su.name + '” → ' + App.fmtRange(newStart, newDue));
    }
  };

  /* Move a milestone, or hand the delivery date back to the live date.

     `iso` null clears a hand-picked delivery date, returning it to `lead` days
     in front of the live date. The live date has nothing to fall back to — it
     IS the commitment — so it can only be changed, never cleared. Neither ever
     drifts with the work: a slip shows up as a warning instead of being quietly
     absorbed by the date someone outside the studio was promised. */
  App.setEpisodeMilestone = function (epId, key, iso) {
    if (!App.canEditSchedule(App.state.role)) {
      App.toast('Only Producers, Managers and Post Operations can change the schedule', true); return;
    }
    if (!App.isMilestoneKey(key)) return;
    const ep = App.state.data.episodes.find(x => x.id === epId); if (!ep) return;
    const def = App.milestoneDef(key);
    if (!iso && key === App.LIVE_KEY) { App.toast('A live date can be changed, but not cleared', true); return; }
    if (iso && !/^\d{4}-\d{2}-\d{2}$/.test(iso)) { App.toast('Enter a valid date', true); return; }

    const was = App.epMilestone(ep, key);
    App.mutate(d => {
      const e = d.episodes.find(x => x.id === epId);
      e.milestones = e.milestones || {};
      if (iso) e.milestones[key] = iso; else delete e.milestones[key];
      if (!Object.keys(e.milestones).length) delete e.milestones;
    }, 'the ' + def.short.toLowerCase() + ' date');

    const now = App.epMilestone(App.state.data.episodes.find(x => x.id === epId), key);
    App.track.audit('milestone.set', {
      episode: ep.code, milestone: def.name,
      from: was ? was.date : null, to: now ? now.date : null, fixed: !!iso
    });
    if (!iso) App.toast(def.name + ' back to ' + def.lead + ' days before the live date — ' + App.fmtDate(now.date));
    else if (now.slipDays > 0) {
      App.toast(def.name + ' set to ' + App.fmtDate(iso) + ' — the work runs ' +
        now.slipDays + ' day' + (now.slipDays === 1 ? '' : 's') + ' past it', true);
    } else App.toast(def.name + ' set to ' + App.fmtDate(iso));
  };

  /* Bulk reschedule — swap episodes between each other's schedule slots.

     The slots stay where they are; the episodes move between them. An episode
     keeps its own internal shape (task durations, anything hand-dragged) and
     simply slides by the gap between the slot it held and the slot it now
     holds, so a show can be re-prioritised without re-planning it.

     Approved work never moves. It already happened, and back-dating history to
     fit a new plan is how a schedule stops being believable — so an approved
     task stays exactly where it is and the rest of its episode moves around
     it. Delivered episodes aren't in the running at all: their slots aren't up
     for grabs. Milestones derive from task dates, so they follow on their own.

     `orderedIds` is the full set of schedulable episode ids in their new order. */
  App.reorderEpisodes = function (showId, orderedIds) {
    if (!App.canEditSchedule(App.state.role)) {
      App.toast('Only Producers, Managers and Post Operations can change the schedule', true); return;
    }
    const current = App.rearrangeableEpisodes(showId);
    const currentIds = current.map(ep => ep.id);
    // the incoming order must be a permutation of what we offered, or the slot
    // mapping below would silently drop or duplicate an episode's dates
    if (orderedIds.length !== currentIds.length || orderedIds.some(id => !currentIds.includes(id))) {
      App.toast('That order doesn’t match the show’s episodes — nothing changed', true); return;
    }
    const slotStarts = current.map(ep => App.epStart(ep));
    /* Delivery and live dates belong to the SLOT, not to the episode — the
       whole point of a re-arrange is that the episode moved into the early slot
       goes out on the early slot's date. So they travel with the position. */
    const slotMs = current.map(ep => (ep.milestones ? JSON.parse(JSON.stringify(ep.milestones)) : null));

    const moves = [];
    orderedIds.forEach((id, newIdx) => {
      const oldIdx = currentIds.indexOf(id);
      if (oldIdx === newIdx) return;
      const delta = App.diffDays(slotStarts[newIdx], slotStarts[oldIdx]);
      moves.push({ id, delta, newIdx, ep: current[oldIdx] });
    });
    if (!moves.length) { App.toast('Already in that order'); return; }

    let shifted = 0, locked = 0;
    App.mutate(d => {
      moves.forEach(m => {
        const e = d.episodes.find(x => x.id === m.id); if (!e) return;
        const subs = App.subitems(e);          // snapshot before writing back into e.dates
        e.dates = e.dates || {};
        if (m.delta) subs.forEach(su => {
          if (su.status === 'approved') { locked++; return; }   // stays put, by design
          e.dates[su.key] = { start: App.shiftIso(su.start, m.delta), due: App.shiftIso(su.due, m.delta) };
          shifted++;
        });
        if (slotMs[m.newIdx]) e.milestones = slotMs[m.newIdx]; else delete e.milestones;
        App.refreshReadiness(e);
      });
    }, 'the re-arrange');

    App.track.audit('show.reorder', {
      show: App.show(showId).name,
      order: orderedIds.map(id => (current.find(e => e.id === id) || {}).code).join(' → '),
      episodesMoved: moves.length, tasksShifted: shifted, tasksLocked: locked
    });
    App.toast(moves.length + ' episode' + (moves.length === 1 ? '' : 's') + ' re-arranged' +
      (locked ? ' · ' + locked + ' approved task' + (locked === 1 ? '' : 's') + ' left in place' : ''));
  };

  /* Episodes a re-arrange may touch: this show's, still active, not delivered.
     Ordered by where they currently sit, since that ordering IS the slot list
     the dialog maps positions onto. Two episodes can legitimately share a start
     date, so the code breaks the tie — an arbitrary order would otherwise shift
     under us between the dialog opening and the reorder being applied. */
  App.rearrangeableEpisodes = function (showId) {
    return App.activeEpisodes()
      .filter(ep => ep.showId === showId && !App.isDelivered(ep))
      .sort((a, b) => {
        const sa = App.epStart(a), sb = App.epStart(b);
        if (sa !== sb) return sa < sb ? -1 : 1;
        return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
      });
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
    }, archived ? 'archiving the show' : 'restoring the show');
    App.track.audit(archived ? 'show.archive' : 'show.restore', { show: s.name });
    // drop just this one out of the selection — leaves any other selected shows alone
    if (archived && App.state.filters.show.includes(showId)) {
      App.state.filters.show = App.state.filters.show.filter(id => id !== showId);
      App.render();
    }
    App.toast((archived ? 'Archived “' : 'Restored “') + s.name + '”');
  };

  App.setEpisodeArchived = function (epId, archived) {
    if (!guardAdmin()) return;
    const ep = App.state.data.episodes.find(x => x.id === epId); if (!ep) return;
    App.mutate(d => {
      const t = d.episodes.find(x => x.id === epId);
      if (archived) t.archived = true; else delete t.archived;
    }, archived ? 'archiving the episode' : 'restoring the episode');
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
      App.mutate(d => { d.episodes = d.episodes.filter(x => x.id !== epId); }, 'deleting the episode');
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
    }, 'removing the task');
    App.track.audit('task.remove', { episode: g.ep.code, task: g.su.name });
    App.toast('Removed “' + g.su.name + '”');
  };

  /* Add one new task to a show's pipeline, with real dates rather than a
     template duration — the counterpart to the Pipeline Editor's addTask()
     (which only edits the in-memory template) for when the dates are already
     known, e.g. drawn on the Timeline. Reaches every episode of the show,
     same as any other pipeline edit (App.pipelineFor has no per-episode
     opt-in — presence in the pipeline is enough).

     `referenceEpId` anchors the drawn dates: every OTHER episode gets the
     same offset-from-its-own-start and the same duration, the identical
     mechanism App.replicatePlan-style copies already use elsewhere. No
     dependencies and no anchor task — this is a floating new task, wired up
     afterward via the pipeline editor's own dependency picker if needed. */
  App.addTaskAcrossShow = function ({ showId, referenceEpId, name, dept, startIso, dueIso }) {
    if (!App.canEditSchedule(App.state.role)) {
      App.toast('Only Producers, Managers and Post Operations can change the schedule', true); return;
    }
    const show = App.state.data.shows.find(s => s.id === showId); if (!show) return;
    const refEp = App.state.data.episodes.find(e => e.id === referenceEpId); if (!refEp) return;
    name = (name || '').trim(); if (!name) { App.toast('Name the task first', true); return; }

    const key = 'task_' + App.uid().slice(0, 6);
    const offsetDays = App.diffDays(startIso, App.epStart(refEp));
    const duration = App.diffDays(dueIso, startIso);
    let touched = 0;
    App.mutate(d => {
      const s = d.shows.find(x => x.id === showId); if (!s) return;
      // materialize the template before splicing — a legacy show with no
      // stored pipeline reads App.defaultPipelineFor's fallback, but writing
      // needs a real array to push onto, not the shared default object
      const pipe = (s.pipeline || App.defaultPipelineFor(s.type)).map(t => ({ ...t, deps: t.deps.slice() }));
      pipe.push({ key, name, dept, days: Math.max(1, duration + 1), minDays: 1, deps: [] });
      s.pipeline = pipe;
      d.episodes.filter(e => e.showId === showId).forEach(e => {
        const base = App.epStart(e);
        const start = App.shiftIso(base, offsetDays), due = App.shiftIso(start, duration);
        e.dates = e.dates || {}; e.statuses = e.statuses || {};
        e.dates[key] = { start, due };
        e.statuses[key] = 'not_started';
        App.refreshReadiness(e);
        touched++;
      });
    }, 'the new task');
    App.track.audit('task.addAcrossShow', { show: show.name, task: name, dept: App.dept(dept).label, episodes: touched });
    App.toast('“' + name + '” added across ' + touched + ' episode' + (touched === 1 ? '' : 's') + ' of ' + show.name);
  };

  // ---- shows ----
  // pipeline: the show's own task template [{key,name,dept,days,minDays,deps}].
  // scale: squeeze/extend factor from the Add Show dialog (1 = recommended pace;
  // durations never drop below each task's minDays). Episode i starts at
  // startIso + i*cadence; every task gets concrete scheduled dates in ep.dates.
  /* `epStarts` optionally gives each episode its own kick-off date, which is how
     a per-episode live date is honoured: the producer names the day an episode
     goes live, and it starts however many days earlier its pipeline needs.
     Without it, episodes fall on an even `cadence` from startIso as before.
     `epLives` carries the live dates themselves, stamped onto each episode so
     they stand as commitments from the moment the show exists. */
  App.createShow = function ({ name, code, type, epNames, pipeline, startIso, cadence, scale, epStarts, epLives }) {
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
        const epStart = (epStarts && epStarts[i]) || App.shiftIso(startIso, i * cadence);
        const sch = App.schedulePipeline(pipeline, epStart, scale);
        const assignees = {};
        pipeline.forEach(t => { const pool = byDept[t.dept] || []; if (pool.length) assignees[t.key] = pool[i % pool.length]; });
        const ep = {
          id: App.uid(), showId, code: code + '-' + (i + 1), title, index: d.episodes.length,
          shiftDays: 0, dates: sch.dates,
          statuses: App.deriveStatusesFromDates(pipeline, sch.dates, assignees), assignees
        };
        if (epLives && epLives[i]) ep.milestones = { [App.LIVE_KEY]: epLives[i] };
        d.episodes.push(ep);
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

  /* Existing episode codes aren't necessarily contiguous — a show's episodes
     can be numbered 101, 102, 103, 104 or skip around after an archive/delete
     — so the next number is found by scanning what's actually there, not by
     counting how many episodes exist. */
  App.nextEpisodeNumber = function (show) {
    const re = new RegExp('^' + show.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$');
    const nums = App.state.data.episodes.filter(e => e.showId === show.id)
      .map(e => { const m = re.exec(e.code); return m ? parseInt(m[1], 10) : null; })
      .filter(n => n != null);
    return nums.length ? Math.max(...nums) + 1 : 1;
  };

  /* Add one new episode to a show that already exists — App.createShow only
     ever creates a show and its first batch of episodes together; there was
     no way to add a single one afterward. Mirrors createShow's per-episode
     construction exactly, just for one episode against the show's existing
     pipeline. Only the start date is used for scheduling — the pipeline runs
     its own natural length from there; fitting it to a drawn deadline is a
     different, bigger feature (see App.solveScale) and out of scope here. */
  App.addEpisode = function ({ showId, code, title, startIso }) {
    if (!App.canManageShows(App.state.role)) { App.toast('Only Producers can add episodes', true); return; }
    const show = App.state.data.shows.find(s => s.id === showId); if (!show) return;
    code = (code || '').trim(); title = (title || '').trim();
    if (!code || !title) { App.toast('Give the episode a code and a title', true); return; }
    const pipeline = show.pipeline || App.defaultPipelineFor(show.type);
    startIso = startIso || App.isoDate(App.today());
    const sch = App.schedulePipeline(pipeline, startIso, 1);
    if (!sch) { App.toast('The pipeline has a dependency cycle', true); return; }

    let newEpId = null;
    App.mutate(d => {
      const byDept = {};
      d.people.forEach(p => { const dep = App.roleDept(p.role); if (dep) (byDept[dep] = byDept[dep] || []).push(p.id); });
      const assignees = {};
      pipeline.forEach(t => { const pool = byDept[t.dept] || []; if (pool.length) assignees[t.key] = pool[0]; });
      const ep = {
        id: newEpId = App.uid(), showId, code, title, index: d.episodes.length,
        shiftDays: 0, dates: sch.dates,
        statuses: App.deriveStatusesFromDates(pipeline, sch.dates, assignees), assignees
      };
      d.episodes.push(ep);
    }, 'the new episode');
    App.track.audit('episode.add', { show: show.name, episode: code, title });
    App.toast('Added ' + code + ' — “' + title + '”');
    // same follow-up App.createShow does — additive and idempotent, so it's
    // safe to call for just this one new episode's folders
    if (App.masterPathSet() && newEpId) {
      App.api.flush()
        .then(() => App.api.createFolders({ showId, pipeline }))
        .catch(e => App.toast(code + ' created, but folders failed: ' + e.message, true));
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
      App.state.filters.show = App.state.filters.show.filter(id => id !== showId);
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
      if (App.state.filters.person.includes(id)) {
        App.state.filters.person = App.state.filters.person.filter(x => x !== id);
        App.render();
      }
      App.toast(p.name + ' removed');
    }, { title: 'Remove team member', yesLabel: 'Remove' });
  };

  // ---- role preset ----
  App.setRole = function (role) {
    App.state.role = role;
    const r = App.role(role), f = App.state.filters;
    f.person = [];
    // every role lands on the Dashboard — it's the personal starting point
    // (own priorities, journal, roll-ups) whatever the role goes on to do
    App.state.view = 'dashboard';
    f.dept = r.dept ? [r.dept] : [];
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
    App.state.view = 'dashboard';
    if (r.dept) App.state.filters.dept = [r.dept];
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
          prefRow('Latch scrolling', 'latchScroll', false, () => App.render()),
          prefRow('Hide weekends', 'hideWeekends', true, () => App.render()),
          // Time running top-to-bottom instead of left-to-right — Department
          // sort only for now (js/gantt.js render()); picking Portrait while
          // sorted by Episode or Show just has no effect yet, quietly, until
          // you switch to Department.
          segRow('Timeline View', 'timelineOrientation', 'landscape',
            [{ v: 'landscape', label: 'Landscape' }, { v: 'portrait', label: 'Portrait' }])
        ],
        board: () => [
          actionRow('All episode groups', [
            { label: 'Expand', run: () => App.visibleEpisodes().forEach(ep => { App.state.expanded[ep.id] = true; }) },
            { label: 'Collapse', run: () => { App.state.expanded = {}; } }
          ])
        ],
        dashboard: () => [
          actionRow('Widget layout', [
            { label: 'Reset to default', run: () => {
              App.prefs.set(App.dashboard.orderKey(), null);
              App.prefs.set(App.dashboard.sizeKey(), null);
            } }
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

      // Not view-scoped, and not tied to any episode/task, so it gets its own
      // section below Appearance rather than a slot in viewRows.
      const byokRow = el('.prefs-row', { onclick: () => { this.close(); App.byokKey.open(); } }, [
        el('.prefs-row-title', null, 'Your Gemini API key'),
        el('button.prefs-btn', { onclick: (e) => { e.stopPropagation(); this.close(); App.byokKey.open(); } }, 'Manage')
      ]);

      const pop = el('.prefs-pop', { onclick: e => e.stopPropagation() },
        [el('.prefs-title', null, label + ' preferences')]
          .concat(rows.length ? rows : [el('.prefs-note', null, 'No display options for this view.')])
          .concat([el('.prefs-title.sep', null, 'Appearance'), themeRow])
          .concat(App.api.online ? [el('.prefs-title.sep', null, 'AI features'), byokRow] : []));
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
      if (remote) { App.state.data = App.migrate(remote); App.save(); }
      else { App.load(); App.api.push(); }                  // fresh server: seed it
      if (!applyIdentity()) { notInDirectoryScreen(); return; }
      App.api.startPolling();
    } else {
      App.load();                                           // no backend: localStorage mode
    }

    document.getElementById('brand-logo').addEventListener('click', e => {
      e.stopPropagation();
      App.prefsMenu.toggle();
    });
    document.addEventListener('click', () => {
      App.board.closePop && App.board.closePop();
      App.prefsMenu.close();
      App.filterMenu && App.filterMenu.close();
    });
    /* ---- keyboard shortcuts ----
       Every one of these is scoped to what's actually on screen: a shortcut
       only fires if the thing it drives is present and reachable on the page
       the user is looking at, and otherwise falls through to the browser. So
       Cmd+Z is undo only where an undo history exists, and Cmd+F opens the
       episode search only when that search box is in front of the user. */
    const modalOpen = () => !!document.querySelector('.modal-overlay');
    // the pipeline editor publishes itself while mounted; a closed dialog
    // leaves its list detached, which is how we know it's gone
    const liveEditor = () => {
      const ed = App._pipeEditor;
      return (ed && ed.list && ed.list.isConnected) ? ed : null;
    };
    const inTextField = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        App.board.closePop && App.board.closePop();
          App.prefsMenu.close();
        return;
      }

      const mod = App.isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();

      /* Cmd+/Cmd− — zoom the timeline, the same step as the toolbar buttons.
         Only on the Timeline with no dialog open; anywhere else these stay the
         browser's page zoom, which is what someone pressing them expects.
         '=' and '-' are the unshifted keys; '+' and '_' arrive when Shift is
         held, and the numpad sends 'Add'/'Subtract'. */
      if (App.state.view === 'timeline' && !modalOpen() && !inTextField(e.target)) {
        const zin = key === '=' || key === '+' || e.code === 'NumpadAdd';
        const zout = key === '-' || key === '_' || e.code === 'NumpadSubtract';
        if (zin || zout) { e.preventDefault(); App.gantt.zoomBy(zin ? 1.25 : 0.8); return; }
      }

      // Cmd+F — jump to the episode search. Skipped while a dialog covers it,
      // where the browser's own find is the more useful thing to leave alone.
      if (key === 'f') {
        if (modalOpen()) return;
        const box = document.getElementById('search');
        if (!box || !box.offsetParent) return;      // not on this page / hidden
        e.preventDefault();
        box.focus();
        box.select();
        return;
      }

      /* Cmd+Z / Cmd+Shift+Z / Cmd+Y — undo & redo.

         Two histories, and the one in front of you wins: with the pipeline
         editor open the keys drive its task list, otherwise they drive the
         board (a dragged bar, a status change, an archive). Typing is always
         left to the browser so a text field keeps its own native undo. */
      if (key === 'z' || key === 'y') {
        if (inTextField(e.target)) return;
        const redo = key === 'y' || e.shiftKey;
        const ed = liveEditor();

        if (ed) {
          // an exhausted history isn't ours to swallow — hand the key back
          if ((redo ? ed.redoBtn : ed.undoBtn).disabled) return;
          e.preventDefault();
          if (redo) ed.redo(); else ed.undo();
          return;
        }

        if (redo ? !App.history.canRedo() : !App.history.canUndo()) return;
        e.preventDefault();
        const r = redo ? App.history.redo() : App.history.undo();
        if (!r) return;
        if (r.ok) App.toast((redo ? 'Redid ' : 'Undid ') + r.label);
        // refused: a teammate has changed the same thing since. The step stays
        // on the stack — once they're done, or once you've looked, try again.
        else App.toast('Can’t ' + (redo ? 'redo' : 'undo') + ' ' + r.label +
          ' — someone else has changed it since', true);
      }
    });
    App.render();
    openTaskFromHash();
    // a Slack link clicked into an already-open tab changes only the hash
    window.addEventListener('hashchange', openTaskFromHash);
  }

  /* Deep link: #task=<episodeId>::<taskKey> opens that task's discussion —
     the URL the Slack Task Card advertises. One-shot: the hash is cleared
     once acted on, so closing the dialog and reloading doesn't trap the user
     back in it. A stale link (episode deleted since) says so rather than
     silently landing on the dashboard, which is exactly where a dead link
     would otherwise leave someone none the wiser. */
  function openTaskFromHash() {
    const m = location.hash.match(/^#task=(.+)$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (!App.state.data) return;                    // login screen showed instead
    const composite = decodeURIComponent(m[1]);
    const sep = composite.indexOf('::');
    if (sep < 0) return;
    const epId = composite.slice(0, sep), taskKey = composite.slice(sep + 2);
    const ep = App.state.data.episodes.find(e => e.id === epId);
    if (!ep || !App.subitem(ep, taskKey)) {
      App.toast('That task is no longer on the board', true);
      return;
    }
    App.editTask.open(epId, taskKey, { tab: 'chat' });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
