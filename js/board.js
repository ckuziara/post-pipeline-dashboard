/* Board view — the Monday-style table. Episodes are collapsible groups; each opens
   into the 27-subitem grid with Department, Owner, Status (solid colour cell, click
   to change), Start/Due dates and Dependency chips. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  App.board = {
    render(episodes) {
      const wrap = el('.board');
      if (App.canManageShows(App.state.role)) wrap.appendChild(this.showManager());
      if (!episodes.length) { wrap.appendChild(el('.empty', null, 'No episodes match the current filters.')); return wrap; }
      App.sortEpisodes(episodes, 'board').forEach(ep => wrap.appendChild(this.group(ep)));
      return wrap;
    },

    // Timeline has no equivalent bar of its own — its Add Show lives in the
    // kpis strip instead (see renderKpis in render.js) — so this stays
    // Board-only.
    showManager() {
      const bar = el('.show-manager');
      bar.appendChild(el('button.btn-addshow', { onclick: () => App.addShow.open() }, '＋ Add show'));
      return bar;
    },

    // Role-aware episode rollup: simple Pending / In Production status, the
    // department currently being waited on (the "stage"), an estimate of when
    // the viewer's own department can start, and dept-scoped completion.
    epSummary(ep) {
      const subs = App.subitems(ep);
      const myDept = App.roleDept(App.state.role);
      const allDone = subs.length > 0 && subs.every(s => s.status === 'approved');
      const started = subs.some(s => ['in_progress', 'review', 'approved'].includes(s.status));
      const status = allDone ? { label: 'Delivered', color: '#00c875' }
        : started ? { label: 'In Production', color: '#fdab3d' }
        : { label: 'Pending', color: '#9aa0ad' };

      // the viewer's next open task on this episode, and whether it can start now
      const byKey = {}; subs.forEach(s => { byKey[s.key] = s; });
      const next = myDept ? subs.find(s => s.dept === myDept && s.status !== 'approved') : null;
      const openDeps = next ? next.deps.filter(k => byKey[k] && byKey[k].status !== 'approved') : [];
      const startable = !!next && !openDeps.length;

      // stage = dept of the first unapproved task in pipeline order — unless the
      // viewer's own next task is already startable (parallel branch): then it's
      // their turn and the chip shows their department.
      const stageTask = subs.find(s => s.status !== 'approved') || null;
      const stageDept = startable ? myDept : stageTask ? stageTask.dept : null;
      const mine = startable || !!(myDept && stageTask && stageTask.dept === myDept);

      // completion scoped to the viewer's department (oversight roles see all)
      const scope = myDept ? subs.filter(s => s.dept === myDept) : subs;
      const done = scope.filter(s => s.status === 'approved').length;
      const prog = scope.length ? Math.round(100 * done / scope.length) : 100;

      // hover text: when can the viewer's department start its next task?
      const todayIso = App.isoDate(App.today());
      let stageTip;
      if (!stageTask) stageTip = 'All tasks approved';
      else if (!myDept) stageTip = 'Waiting on ' + App.dept(stageTask.dept).label + ' — ' + stageTask.name;
      else if (!next) stageTip = 'No remaining ' + App.dept(myDept).label + ' tasks on this episode';
      else if (startable) stageTip = '“' + next.name + '” is ready for you now';
      else {
        let est = next.start > todayIso ? next.start : todayIso;   // late deps push past the plan
        openDeps.forEach(k => { const d = App.shiftIso(byKey[k].due, 1); if (d > est) est = d; });
        const days = App.diffDays(est, todayIso);
        stageTip = '“' + next.name + '” — you can start in ~' + days + ' day' + (days === 1 ? '' : 's') +
          ' (est. ' + App.fmtDate(est) + ')';
      }
      return { status, stageTask, stageDept, mine, myDept, prog, done, total: scope.length, stageTip };
    },

    group(ep) {
      const show = App.show(ep.showId);
      const open = !!App.state.expanded[ep.id];
      const overdueTasks = App.epOverdueTasks(ep), overdue = overdueTasks.length;
      const overdueTip = overdue ? overdueTasks.map(t => {
        const owner = t.assignee ? App.person(t.assignee).name : 'Unassigned';
        return App.dept(t.dept).label + ' — ' + t.name + ' (' + owner + ')';
      }).join('\n') : '';
      const blockedTasks = App.epBlockedTasks(ep), blocked = blockedTasks.length;
      const byKey = {}; App.subitems(ep).forEach(su => { byKey[su.key] = su; });
      const blockedTip = blocked ? blockedTasks.map(t => {
        const waitingOn = t.deps
          .map(k => byKey[k])
          .filter(d => d && (ep.statuses[d.key] || 'not_started') !== 'approved')
          .map(d => App.dept(d.dept).label + ' — ' + d.name)
          .join(', ');
        return App.dept(t.dept).label + ' — ' + t.name + ' waiting on: ' + (waitingOn || '—');
      }).join('\n') : '';
      const s = this.epSummary(ep);
      const stageCls = !s.stageTask ? '.done' : s.mine ? '.mine' : s.myDept ? '.dim' : '';
      const progLabel = s.myDept ? App.dept(s.myDept).label + ' tasks' : 'complete';

      const grp = el('.ep-group');
      // ⌥-click opens or closes every episode on the board, like the Timeline
      const head = el('.ep-row', { onclick: (e) => {
        if (e.altKey) App.visibleEpisodes().forEach(x => { App.state.expanded[x.id] = !open; });
        else App.state.expanded[ep.id] = !open;
        App.render();
      } }, [
        el('.ep-accent', { style: { background: show.color } }),
        el('span.chev' + (open ? '.open' : ''), null, '▶'),
        el('.ep-headline', null, [
          el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color) } }, ep.code),
          el('span.ep-title', null, ep.title),
          el('span.ep-show', null, show.name),
          (overdue ? el('span.risk-flag', { title: overdueTip }, [App.icon('warn'), ' ' + overdue + ' overdue']) : null),
          (blocked ? el('span.risk-flag', { title: blockedTip, style: { color: '#ffce8e', background: 'rgba(253,171,61,.14)', borderColor: 'rgba(253,171,61,.3)' } }, [App.icon('blocked'), ' ' + blocked + ' blocked']) : null),
          (App.vc && App.vc.boardBadge(ep))
        ]),
        el('.ep-right', null, [
          // the two dates the episode is committed to downstream — derived, so
          // there's nothing to click here, they just move with the work
          el('.ep-meta.dates-meta', {
            title: App.epMilestones(ep).map(m => m.name + ': ' + App.fmtDate(m.date)).join('\n')
          }, [
            el('.m-label', null, 'Delivery · Live'),
            el('.m-val', null, App.epMilestones(ep).map(m => App.fmtDate(m.date)).join(' · '))
          ]),
          el('.ep-meta.status-meta', null, [
            el('.m-label', null, 'Status'),
            el('.m-val', { style: { color: s.status.color } }, s.status.label)
          ]),
          el('.ep-meta.stage-meta', null, [
            el('.m-label', null, 'Stage'),
            s.stageDept
              ? el('span.stage-chip' + stageCls, { title: s.stageTip }, [
                  el('span.dot', { style: { background: App.dept(s.stageDept).color } }),
                  App.dept(s.stageDept).label
                ])
              : el('span.stage-chip.done', { title: s.stageTip }, '✓ Complete')
          ]),
          el('.ep-prog', { title: s.prog + '% ' + progLabel + ' — ' + s.done + ' of ' + s.total + ' approved' }, [
            el('.prog-track', null, [el('.prog-fill', { style: { width: s.prog + '%' } })])
          ])
        ])
      ]);
      grp.appendChild(head);
      if (open) grp.appendChild(this.subtable(ep));
      return grp;
    },

    /* the KO column: an open ring where a task needs a Kick Off, a green tick
       once it's done, nothing where it doesn't need one. Red ring when the
       Kick Off is overdue (App.koOverdue). */
    koTag(ep, su) {
      const st = App.koState(ep, su.key); if (!st) return null;
      const can = App.canSetKickOff(App.state.role);
      if (st === 'done') {
        const d = ep.ko.done[su.key];
        return el('span.ko-tick', {
          title: 'Kick Off done' + (d && d.by ? ' — ' + d.by : '') + (d && d.at ? ', ' + App.fmtDate(d.at.slice(0, 10)) : '') + (can ? '\nClick to undo' : '')
        }, '✓');
      }
      const due = App.koOverdue(ep, su);
      return el('span.ko-ring' + (due ? '.due' : ''), {
        title: (due ? 'Kick Off overdue — was due ' : 'Kick Off due ') + App.fmtDate(su.start) + (can ? '\nClick to mark it done' : '')
      });
    },

    // right-click a Kick Off: take the task off this episode's KO list
    koMenu(e, ep, su) {
      e.preventDefault(); e.stopPropagation();
      const close = () => { menu.remove(); document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', esc, true); };
      const off = (ev) => { if (!menu.contains(ev.target)) close(); };
      const esc = (ev) => { if (ev.key === 'Escape') close(); };
      const menu = el('.ctx-menu', null, [
        el('button.ctx-item', { type: 'button', onclick: () => {
          close(); App.setEpisodeKo(ep.id, App.epKoTasks(ep).filter(k => k !== su.key));
        } }, [el('span.ctx-item-lbl', null, 'Remove Kick Off'), el('span.ctx-item-sub', null, su.name)])
      ]);
      document.body.appendChild(menu);
      menu.style.top = Math.min(e.clientY + 2, window.innerHeight - menu.offsetHeight - 8) + 'px';
      menu.style.left = Math.min(e.clientX + 2, window.innerWidth - menu.offsetWidth - 8) + 'px';
      setTimeout(() => { document.addEventListener('mousedown', off, true); document.addEventListener('keydown', esc, true); }, 0);
    },

    subtable(ep) {
      const box = el('.subtable');
      const grid = el('.subgrid');
      /* Click a heading (all but Dependency) to sort by it: ascending, descending, then back to
         pipeline order. One choice for every episode on the board, kept on
         this device. The row number stays the task's place in the pipeline,
         so a sorted list still says where each task sits in the flow. */
      const cs = App.prefs.get('boardColSort', null) || {};
      const cols = [['name', 'Subitem'], ['dept', 'Department'], ['owner', 'Owner'], ['status', 'Status'],
        ['start', 'Start'], ['due', 'Due']];
      // # is pipeline order — clicking it drops any column sort
      const numHead = el('.cell.c-num' + (!cs.key ? '.sorted' : ''), {
        title: cs.key ? 'Back to pipeline order' : 'Pipeline order',
        onclick: (e) => { e.stopPropagation(); if (cs.key) { App.prefs.set('boardColSort', null); App.render(); } }
      }, '#');
      const koHead = el('.cell.c-ko', { title: 'Kick Off — click a cell to add one, click again to mark it done, right-click to remove' }, 'KO');
      grid.appendChild(el('.subrow.head', null, [numHead].concat(cols.map(([k, label]) => {
        const on = cs.key === k;
        return el('.cell.sortable' + (on ? '.sorted' : ''), {
          title: !on ? 'Sort by ' + label.toLowerCase() : cs.dir === 'asc' ? 'Sorted ascending — click for descending' : 'Sorted descending — click for pipeline order',
          onclick: (e) => {
            e.stopPropagation();
            App.prefs.set('boardColSort', !on ? { key: k, dir: 'asc' } : cs.dir === 'asc' ? { key: k, dir: 'desc' } : null);
            App.render();
          }
        }, [label, el('span.sort-ind', null, on ? (cs.dir === 'asc' ? '↑' : '↓') : '↕')]);
      })).concat([el('.cell', null, 'Dependency')]).reduce((a, c, i) => a.concat(i === 4 ? [koHead, c] : [c]), [])));
      const todayIso = App.isoDate(App.today());
      const view = App.subsView(ep);
      const pos = {}; App.subitems(ep).forEach((su, i) => { pos[su.key] = i; });
      if (cs.key) {
        const val = {
          name: su => su.name.toLowerCase(),
          dept: su => App.dept(su.dept).label.toLowerCase(),
          owner: su => { const p = su.assignee && App.person(su.assignee); return p ? p.name.toLowerCase() : '\uffff'; },
          status: su => App.STATUS_ORDER.indexOf(su.status),
          start: su => su.start, due: su => su.due
        }[cs.key];
        const sign = cs.dir === 'desc' ? -1 : 1;
        if (val) view.sort((a, b) => {
          const x = val(a), y = val(b);
          const c = typeof x === 'number' ? x - y : x < y ? -1 : x > y ? 1 : 0;
          return c ? sign * c : pos[a.key] - pos[b.key];
        });
      }
      view.forEach((su) => {
        const i = pos[su.key];
        const dep = App.dept(su.dept);
        const person = su.assignee ? App.person(su.assignee) : null;
        const st = App.status(su.status);
        const blocked = App.isRiskBlocked(ep, su.key);
        const overdue = su.status !== 'approved' && su.due < todayIso;

        grid.appendChild(el('.subrow', null, [
          el('.cell.c-num', null, i + 1),
          el('.cell.c-name', { style: { cursor: 'pointer' }, title: 'Edit task', onclick: (e) => { e.stopPropagation(); App.editTask.open(ep.id, su.key); } }, [
            el('span', null, su.name),
            App.icon('pencil', { cls: 'edit-hint' })
          ]),
          el('.cell.c-dept', null, el('span.dept-chip', null, [
            el('span.dot', { style: { background: dep.color } }), dep.label
          ])),
          el('.cell.c-assignee', null, person
            ? el('span.avatar', { style: { background: person.color }, title: person.name }, App.initials(person.name))
            : el('span.avatar.avatar-none', { title: 'Unassigned' }, '?')),
          // none → click to add a Kick Off; needed → click to mark it done; done → click to undo (Producer / Director)
          (() => {
            const st = App.koState(ep, su.key), can = App.canSetKickOff(App.state.role);
            return el('.cell.c-ko' + (can ? '.can' : ''), can ? {
              title: st ? null : 'Add a Kick Off for this task',
              onclick: (e) => {
                e.stopPropagation();
                if (st) App.setKoDone(ep.id, su.key, st !== 'done');
                else App.setEpisodeKo(ep.id, App.epKoTasks(ep).concat(su.key));
              },
              oncontextmenu: st ? (e) => this.koMenu(e, ep, su) : null
            } : null, this.koTag(ep, su));
          })(),
          // status cell — solid colour, click to change
          el('.cell.c-status', null, el('.status-cell', {
            style: { background: st.color, color: st.ink },
            onclick: (e) => { e.stopPropagation(); App.board.openStatusPop(e.currentTarget, ep, su.key); }
          }, [
            document.createTextNode(st.label),
            (blocked ? App.icon('blocked', { cls: 'blk', title: 'Waiting on a dependency' }) : null)
          ])),
          el('.cell.c-date' + (overdue ? '.overdue' : ''), null, App.fmtDate(su.start)),
          el('.cell.c-date' + (overdue ? '.overdue' : ''), null, App.fmtDate(su.due)),
          el('.cell.c-deps', null, su.deps.length
            ? su.deps.map(dk => {
                const depDone = ((ep.statuses && ep.statuses[dk]) || 'not_started') === 'approved';
                return el('span.dep-chip' + (depDone ? '.ok' : '.wait'),
                  { title: App.taskNameFor(ep, dk) + ' — ' + (depDone ? 'Approved' : 'not ready') },
                  [(depDone ? '✓ ' : '◷ ') + App.taskNameFor(ep, dk)]);
              })
            : [el('span', { style: { color: 'var(--text-3)', fontSize: '11px' } }, '—')])
        ]));
      });
      box.appendChild(grid);
      return box;
    },

    // ---- status picker popup ----
    closePop() { if (this._pop) { this._pop.remove(); this._pop = null; } },
    openStatusPop(cell, ep, key) {
      this.closePop();
      const su = App.subitem(ep, key);
      if (!App.canEditTask(App.state.role, su)) {
        const d = App.roleDept(App.state.role);
        App.toast('Your role can only edit ' + (d ? App.dept(d).label : 'permitted') + ' tasks', true); return;
      }
      if (su.status === 'approved' && !App.canApprove(App.state.role)) {
        App.toast('Only Producer, Director or Manager can change an approved task', true); return;
      }
      const r = cell.getBoundingClientRect();
      const pop = el('.status-pop');
      App.statusOptionsFor(App.state.role).forEach(sk => {
        const s = App.STATUSES[sk];
        pop.appendChild(el('button.status-opt', {
          style: { background: s.color, color: s.ink },
          onclick: (e) => { e.stopPropagation(); App.setStatus(ep.id, key, sk); App.board.closePop(); }
        }, s.label));
      });
      const startable = App.isStartable(ep, key);
      const blocked = App.isBlocked(ep, key);
      pop.appendChild(el('.pop-note', null,
        blocked ? 'Waiting on: ' + (App.pTask(ep, key) || { deps: [] }).deps.filter(d => (ep.statuses[d] || 'not_started') !== 'approved').map(d => App.taskNameFor(ep, d)).join(', ')
        : startable ? '✓ All dependencies approved — ready to start' : 'Dependencies approved'));
      document.body.appendChild(pop);
      // Position after paint so offsetHeight/offsetWidth are real.
      // Flip upward if too close to the bottom edge; clamp to viewport edges.
      requestAnimationFrame(() => {
        const ph = pop.offsetHeight, pw = pop.offsetWidth;
        const flipUp = r.bottom + ph + 8 > window.innerHeight;
        const top  = flipUp ? r.top - ph - 4 : r.bottom + 4;
        let   left = r.left;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
        pop.style.top  = Math.max(8, top) + 'px';
        pop.style.left = Math.max(8, left) + 'px';
      });
      this._pop = pop;
    }
  };
})();
