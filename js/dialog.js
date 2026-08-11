/* Modal dialogs — a reusable overlay plus the Edit Task dialog (opened from the
   timeline / board) and the Add Show dialog (opened from the board by producers).
   UI only; the actual data mutations live in main.js (applyTaskEdit / removeTask /
   createShow). */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const EP_MAX = 100;   // most episodes a single Add Show can create at once

  // ---- overlay ----
  App.modal = {
    /* opts.onClose fires however the modal goes away — ✕, backdrop, Escape or a
       button calling close() — for dialogs where dismissal is itself an answer.
       A dialog that has already acted marks its own decision first, so its
       close() reaches a no-op rather than being undone by its own teardown. */
    open(card, opts) {
      this.close();
      const ov = el('.modal-overlay', { onclick: (e) => { if (e.target === ov) App.modal.close(); } });
      ov.appendChild(card);
      document.body.appendChild(ov);
      this._ov = ov;
      this._onClose = (opts && opts.onClose) || null;
      this._esc = (e) => { if (e.key === 'Escape') App.modal.close(); };
      document.addEventListener('keydown', this._esc);
      const f = card.querySelector('input,select'); if (f) setTimeout(() => f.focus(), 30);
    },
    close() {
      if (!this._ov) return;          // nothing open — open() calls this defensively
      // cleared before firing so a callback that opens another modal can't
      // re-enter this one's teardown
      const onClose = this._onClose; this._onClose = null;
      // A flow still open as the modal goes away was abandoned: the user walked
      // away without saving. Hooking it here (rather than on each dialog's close
      // button) catches Esc, a backdrop click and the ✕ alike; a successful save
      // closes its own flow first, so this only ever sees genuine drop-offs.
      this._ov.remove(); this._ov = null; document.removeEventListener('keydown', this._esc);
      App.track && App.track.abandonOpenFlows && App.track.abandonOpenFlows();
      if (onClose) onClose();
    }
  };

  /* ---- confirmation prompt ----
     Replaces window.confirm(), which silently returns false (no dialog shown)
     inside embedded webviews like the desktop app's preview pane — that made
     every destructive action a no-op there. Callers pass an onYes callback
     instead of branching on a return value, since this can't block. */
  App.confirm = function (message, onYes, opts) {
    opts = opts || {};
    // opts.onNo runs when the user backs out — used when the prompt replaced a
    // dialog that should come back (e.g. Remove inside the Edit Task modal).
    let settled = false;
    const cancel = () => { if (settled) return; settled = true; App.modal.close(); if (opts.onNo) opts.onNo(); };
    const yes = el('button.btn-danger', {
      onclick: () => { settled = true; App.modal.close(); onYes(); }
    }, opts.yesLabel || 'Delete');

    App.modal.open(el('.modal-card.confirm-card', { onclick: e => e.stopPropagation() }, [
      el('.modal-head', null, [
        el('.modal-head-main', null, [
          App.icon(opts.icon || 'warn', { cls: 'modal-ic' }),
          el('div', null, el('.modal-title', null, opts.title || 'Are you sure?'))
        ]),
        el('button.modal-x', { onclick: cancel, title: 'Close' }, '✕')
      ]),
      el('.modal-body', null, el('.confirm-msg', null, message)),
      el('.modal-foot', null, [
        el('button.btn-ghost', { onclick: cancel }, 'Cancel'),
        yes
      ])
    ]));
    // Esc / backdrop go through App.modal's own close, so mirror them into the
    // cancel path to keep onNo firing however the user dismisses the prompt.
    if (opts.onNo) {
      const ov = App.modal._ov;
      const watch = new MutationObserver(() => {
        if (!ov.isConnected) { watch.disconnect(); if (!settled) { settled = true; opts.onNo(); } }
      });
      watch.observe(document.body, { childList: true });
    }
    setTimeout(() => yes.focus(), 30);   // Enter confirms, Esc cancels
  };

  function fmtBytes(bytes) {
    if (!bytes) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }

  /* ---- folder picker ----
     Browses the filesystem of the machine running the server, because that's
     where the LucidLink mount lives — and because a browser's own folder picker
     deliberately never reveals an absolute path, which is exactly what the
     server needs to create directories. */
  App.folderPicker = {
    /* opts.pickFiles — list files too and return the chosen FILE's path. Used by
       Deliver → "Pick from the volume", so big media already on the mount is
       copied in place instead of pushed through the browser.
       opts.onCancel — runs when the user backs out (the caller's dialog was
       replaced by this one and usually wants to come back). */
    open(startPath, onPick, opts) {
      opts = opts || {};
      const files = !!opts.pickFiles;
      let cur = startPath || '', chosenFile = null;
      const crumb = el('.fp-path');
      const list = el('.fp-list');
      const upBtn = el('button.btn-ghost.fp-up', { title: 'Up one level' }, '↑ Up');
      const roots = el('.fp-roots');
      const chooseBtn = el('button.btn-primary', { disabled: true },
        opts.confirmLabel || (files ? 'Deliver this file' : 'Select this folder'));

      let settled = false;
      const cancel = () => { if (settled) return; settled = true; App.modal.close(); if (opts.onCancel) opts.onCancel(); };

      const select = (name, size) => {
        chosenFile = cur.replace(/\/$/, '') + '/' + name;
        chooseBtn.disabled = false;
        [...list.querySelectorAll('.fp-item.sel')].forEach(n => n.classList.remove('sel'));
        const node = [...list.querySelectorAll('.fp-item')].find(n => n.dataset.file === name);
        if (node) node.classList.add('sel');
        crumb.textContent = chosenFile;
      };

      const go = async (p) => {
        chosenFile = null;
        list.innerHTML = '';
        list.appendChild(el('.fp-loading', null, 'Opening…'));
        try {
          const r = await App.api.browse(p, files);
          cur = r.path;
          crumb.textContent = r.path;
          // in file mode nothing is chosen until a file is clicked
          chooseBtn.disabled = files;
          upBtn.disabled = !r.parent;
          upBtn.onclick = () => r.parent && go(r.parent);

          roots.innerHTML = '';
          (r.roots || []).forEach(rt => roots.appendChild(
            el('button.fp-root' + (rt.path === r.path ? '.active' : ''), { onclick: () => go(rt.path) }, rt.label)));

          list.innerHTML = '';
          // the server redirected us out of an unreadable path — say so
          if (r.notice) list.appendChild(el('.fp-notice', null, 'ⓘ ' + r.notice));
          r.dirs.forEach(name => list.appendChild(
            el('button.fp-item', { onclick: () => go(r.path.replace(/\/$/, '') + '/' + name) },
              [App.icon('folder', { cls: 'fp-ic' }), el('span.fp-name', null, name), el('span.fp-arrow', null, '›')])));
          (r.files || []).forEach(f => list.appendChild(
            el('button.fp-item', { 'data-file': f.name, onclick: () => select(f.name, f.size) },
              [App.icon('file', { cls: 'fp-ic' }), el('span.fp-name', null, f.name),
               el('span.fp-size', null, f.size ? fmtBytes(f.size) : '')])));
          if (!r.dirs.length && !(r.files || []).length) {
            list.appendChild(el('.fp-empty', null, files
              ? 'Nothing here — go up and pick another folder.'
              : 'No subfolders here — you can still select this folder.'));
          }
        } catch (e) {
          list.innerHTML = '';
          list.appendChild(el('.fp-error', null, [App.icon('warn'), ' ' + e.message]));
          chooseBtn.disabled = true;   // don't let a folder we couldn't read be chosen
        }
      };

      App.modal.open(el('.modal-card.fp-card', { onclick: e => e.stopPropagation() }, [
        el('.modal-head', null, [
          el('.modal-head-main', null, [
            App.icon('folderOpen', { cls: 'modal-ic' }),
            el('div', null, [
              el('.modal-title', null, opts.title || 'Choose master directory'),
              el('.modal-subtitle', null, opts.subtitle || (files
                ? 'Files on the machine running Post Pipeline — pick one to deliver.'
                : 'Folders on the machine running Post Pipeline — where your LucidLink volume is mounted.'))
            ])
          ]),
          el('button.modal-x', { onclick: cancel, title: 'Close' }, '✕')
        ]),
        el('.modal-body', null, [roots, el('.fp-bar', null, [upBtn, crumb]), list]),
        el('.modal-foot', null, [
          el('button.btn-ghost', { onclick: cancel }, 'Cancel'),
          chooseBtn
        ])
      ]));
      chooseBtn.onclick = () => {
        settled = true; App.modal.close();
        onPick(files ? chosenFile : cur);
      };
      // Esc / backdrop close through App.modal, so mirror them into cancel
      if (opts.onCancel) {
        const ov = App.modal._ov;
        const watch = new MutationObserver(() => {
          if (!ov.isConnected) { watch.disconnect(); if (!settled) { settled = true; opts.onCancel(); } }
        });
        watch.observe(document.body, { childList: true });
      }
      go(cur);
    }
  };

  function card(icon, title, subtitle, sections, footer, cls) {
    return el('.modal-card' + (cls ? '.' + cls : ''), { onclick: (e) => e.stopPropagation() }, [
      el('.modal-head', null, [
        el('.modal-head-main', null, [
          App.icon(icon, { cls: 'modal-ic' }),
          el('div', null, [el('.modal-title', null, title), subtitle ? el('.modal-subtitle', null, subtitle) : null])
        ]),
        el('button.modal-x', { onclick: () => App.modal.close(), title: 'Close' }, '✕')
      ]),
      el('.modal-body', null, sections),
      el('.modal-foot', null, footer)
    ]);
  }

  function field(label, control, hint) {
    return el('.field', null, [el('label.fld-label', null, label), control, hint ? el('.fld-hint', null, hint) : null]);
  }

  /* Compact click-to-edit row (settings-menu style): shows a read-only value
     that swaps to its control on click, and reverts when focus leaves. The
     control is the source of truth, so Save reads it whether open or not. */
  function editRow(labelText, control, renderDisplay, opts) {
    opts = opts || {};
    const display = el('.et-display', opts.locked ? null : { tabindex: '0' });
    const editKids = [control]; if (opts.hint) editKids.push(el('.fld-hint', null, opts.hint));
    const editWrap = el('.et-edit', { style: { display: 'none' } }, editKids);
    const refresh = () => {
      display.innerHTML = '';
      const v = renderDisplay();
      display.appendChild((v == null || v === '') ? el('span.et-empty', null, '—') : (typeof v === 'string' ? el('span', null, v) : v));
      if (!opts.locked) display.appendChild(App.icon('pencil', { cls: 'et-pencil' }));
    };
    const enter = () => {
      if (opts.locked) return;
      display.style.display = 'none'; editWrap.style.display = '';
      const f = editWrap.querySelector('input,select,textarea');
      if (f) { f.focus(); if (f.select && f.type === 'text') f.select(); }
    };
    const leave = () => { editWrap.style.display = 'none'; display.style.display = ''; refresh(); };
    display.addEventListener('click', enter);
    display.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(); } });
    // collapse once focus leaves the whole edit group (covers multi-input rows)…
    editWrap.addEventListener('focusout', () => setTimeout(() => { if (editWrap.style.display !== 'none' && !editWrap.contains(document.activeElement)) leave(); }, 0));
    // …plus immediate collapse when a dropdown is chosen or a text field commits
    editWrap.addEventListener('change', e => { if (e.target.tagName === 'SELECT') leave(); });
    editWrap.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text') { e.preventDefault(); leave(); } });
    refresh();
    // a locked row never opens, so its hint would stay buried in editWrap —
    // surface it as the row's tooltip instead (explains *why* it's locked)
    return el('.et-row' + (opts.locked ? '.locked' : ''),
      opts.locked && opts.hint ? { title: opts.hint } : null, [
      el('.et-label', null, labelText),
      el('.et-control', null, [display, editWrap])
    ]);
  }

  // ---- Edit Task ----
  App.editTask = {
    open(epId, key) {
      const ep = App.state.data.episodes.find(e => e.id === epId); if (!ep) return;
      const su = App.subitem(ep, key); if (!su) return;
      const role = App.state.role;
      // structural rights — reshaping the plan, as opposed to reporting on it
      const canName = App.canEditTaskName(role);
      const canSched = App.canEditSchedule(role);
      const canRemove = App.canRemoveTask(role);
      // `canTouch` is the department gate (status, owner, files). Schedulers get
      // in regardless — Post Operations reschedules other departments' work.
      const canTouch = App.canEditTask(role, su);
      if (!canTouch && !canSched) {
        const d = App.roleDept(role);
        App.toast('Your role can only edit ' + (d ? App.dept(d).label : 'permitted') + ' tasks', true);
        return;
      }
      App.track.feature('task.editDialog', { dept: su.dept });
      const canApprove = App.canApprove(role);
      const lockedApproved = su.status === 'approved' && !canApprove;

      const nameInput = el('input.fld', { type: 'text', value: su.name });
      const statusSel = el('select.fld');
      App.statusOptionsFor(role).forEach(sk => {
        const o = document.createElement('option'); o.value = sk; o.textContent = App.STATUSES[sk].label;
        if (sk === su.status) o.selected = true; statusSel.appendChild(o);
      });
      if (lockedApproved) {
        const o = document.createElement('option'); o.value = 'approved'; o.textContent = 'Approved'; o.selected = true;
        statusSel.appendChild(o); statusSel.disabled = true;
      }

      // owner — only staff from the task's department are eligible
      const canAssign = App.canAssignOwners(role);
      const deptPeople = App.state.data.people.filter(p => App.roleDept(p.role) === su.dept);
      const ownerSel = el('select.fld');
      const none = document.createElement('option');
      none.value = ''; none.textContent = '— Unassigned —';
      if (!su.assignee) none.selected = true;
      ownerSel.appendChild(none);
      deptPeople.forEach(p => {
        const o = document.createElement('option'); o.value = p.id; o.textContent = p.name;
        if (p.id === su.assignee) o.selected = true; ownerSel.appendChild(o);
      });
      if (!canAssign) ownerSel.disabled = true;
      const ownerHint = !canAssign ? 'Your role cannot assign owners (set in Admin → Privileges)'
        : deptPeople.length ? 'Only ' + App.dept(su.dept).label + ' staff are listed'
        : 'No ' + App.dept(su.dept).label + ' staff yet — add people in Admin';

      const startInput = el('input.fld', { type: 'date', value: su.start });
      const dueInput = el('input.fld', { type: 'date', value: su.due });
      const rangePill = el('.range-pill');
      const updateRange = () => {
        const s = startInput.value, d = dueInput.value; rangePill.innerHTML = '';
        if (s && d && d >= s) {
          const days = App.diffDays(d, s) + 1;
          rangePill.classList.remove('bad');
          rangePill.appendChild(App.icon('calendar', { cls: 'range-ic' }));
          rangePill.appendChild(el('span.range-txt', null, App.fmtRange(s, d) + ', ' + App.parseDate(d).getFullYear()));
          rangePill.appendChild(el('span.range-days', null, days + (days === 1 ? ' day' : ' days')));
        } else {
          rangePill.classList.add('bad');
          rangePill.appendChild(el('span', null, 'Due date must be on or after the start date'));
        }
      };
      startInput.addEventListener('change', updateRange); dueInput.addEventListener('change', updateRange); updateRange();

      // schedule editing group (two dates + a live range/validation pill)
      const schedControl = el('.sched-box', null, [
        el('.sched-grid', null, [field('Start', startInput), el('.sched-arrow', null, '→'), field('Due', dueInput)]),
        rangePill
      ]);
      const schedDisplay = () => {
        const s = startInput.value, d = dueInput.value;
        if (s && d && d >= s) {
          const days = App.diffDays(d, s) + 1;
          return el('span.et-sched', null, [App.icon('calendar', { cls: 'range-ic' }), App.fmtRange(s, d) + ', ' + App.parseDate(d).getFullYear() + '  ·  ' + days + (days === 1 ? ' day' : ' days')]);
        }
        return el('span.et-empty', null, 'Set dates');
      };
      const statusDisplay = () => {
        const st = App.status(statusSel.value);
        return el('span.et-status', { style: { color: st.color } }, [el('span.et-dot', { style: { background: st.color } }), st.label]);
      };
      const ownerDisplay = () => {
        const id = ownerSel.value; if (!id) return el('span.et-empty', null, 'Unassigned');
        const p = App.person(id); if (!p) return 'Unassigned';
        return el('span.et-owner', null, [el('span.avatar', { style: { background: p.color } }, App.initials(p.name)), p.name]);
      };

      const sections = [
        el('.ctx-box.slim', null, [
          el('span.ctx-chip', null, '# ' + ep.code), el('span.ctx-title', null, ep.title),
          el('span.ctx-dept', null, App.dept(su.dept).label)
        ]),
        el('.et-list', null, [
          editRow('Task name', nameInput, () => nameInput.value, {
            locked: !canName, hint: canName ? null : 'Only Producers and Managers can rename a task'
          }),
          editRow('Status', statusSel, statusDisplay, {
            locked: lockedApproved || !canTouch,
            hint: !canTouch ? 'Only the ' + App.dept(su.dept).label + ' team can update this task’s status'
              : lockedApproved ? 'Only Producer, Director or Manager can change an approved task'
              : (canApprove ? null : 'Your role cannot set tasks to Approved')
          }),
          editRow('Owner', ownerSel, ownerDisplay, { locked: !canAssign, hint: ownerHint }),
          editRow('Schedule', schedControl, schedDisplay, {
            locked: !canSched, hint: canSched ? null : 'Only Producers, Managers and Post Operations can change the schedule'
          })
        ]),
        // LucidLink version control — only for tasks flagged version-controlled
        // in the pipeline (enabled in Pipeline Presets, not here)
        (App.vc && App.vc.isVc(ep, key) ? App.vc.inlineSection(epId, key) : null),
        /* The task workspace (Project / Assets / Deliver) works against the real
           production folders, so it needs a master directory. Without one, fall
           back to Smart Upload's metadata catalogue rather than showing nothing. */
        (App.workspace && App.masterPathSet && App.masterPathSet()
          ? App.workspace.inlineSection(epId, key)
          : (App.uploads ? App.uploads.inlineSection(epId, key) : null))
      ];

      const footer = [
        el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Cancel'),
        (canRemove ? el('button.btn-danger', {
          onclick: () => App.confirm('Remove “' + su.name + '” from ' + ep.code + '?',
            () => { App.removeTask(epId, key); App.modal.close(); },
            { title: 'Remove task', yesLabel: 'Remove', onNo: () => App.editTask.open(epId, key) })
        }, [App.icon('trash'), ' Remove']) : null),
        el('button.btn-primary', {
          onclick: () => {
            const s = startInput.value, d = dueInput.value;
            if (canName && !nameInput.value.trim()) { App.toast('Task name is required', true); return; }
            if (canSched && !(s && d && d >= s)) { App.toast('Check the dates', true); return; }
            App.applyTaskEdit(epId, key, {
              name: nameInput.value.trim(),
              status: statusSel.disabled ? su.status : statusSel.value,
              start: s, due: d,
              assignee: canAssign ? ownerSel.value : undefined
            });
            App.track.flowDone('Task edit', true);
            App.modal.close();
          }
        }, [App.icon('save'), ' Save Changes'])
      ];

      App.modal.open(card('pencil', 'Edit Task', 'Update task details and schedule', sections, footer));
      App.track.flowStart('Task edit', { dept: su.dept });   // after open(): its defensive close() must not cancel this
    }
  };

  /* ---- Re-Arrange a show's episodes ----
     Pick a show, reorder its remaining episodes, apply. Each episode then
     slides into the schedule slot of whatever now sits in its place. Delivered
     episodes aren't listed — their slots aren't up for grabs — and approved
     tasks stay put, which is why each row says how much work is pinned. The
     real work is App.reorderEpisodes; this is the picker in front of it.

     `showId` preselects a show (the toolbar passes the current filter when one
     is set); without it the producer chooses from the dropdown. */
  App.rearrange = {
    open(showId) {
      if (!App.canEditSchedule(App.state.role)) {
        App.toast('Only Producers, Managers and Post Operations can change the schedule', true); return;
      }
      const shows = App.activeShows();
      if (!shows.length) { App.toast('No shows to re-arrange', true); return; }

      // Every active show is listed with its count, rather than hiding the ones
      // that can't move — "1 in production" explains itself, where a missing
      // show would just look like a bug.
      const showSel = el('select.fld');
      shows.forEach(s => {
        const n = App.rearrangeableEpisodes(s.id).length;
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.name + '  ·  ' + (n ? n + ' in production' : 'all delivered');
        showSel.appendChild(o);
      });
      // fall back to the first show that actually has something to reorder
      const preferred = (showId && shows.some(s => s.id === showId)) ? showId : null;
      showSel.value = preferred ||
        (shows.find(s => App.rearrangeableEpisodes(s.id).length > 1) || shows[0]).id;

      const listEl = el('.ra-list');
      const noteEl = el('.fld-hint', { style: { margin: '10px 0' } });
      const applyBtn = el('button.btn-primary', {
        onclick: () => {
          const id = showSel.value, ids = order.map(ep => ep.id);
          App.modal.close();                                   // before the re-render underneath
          App.reorderEpisodes(id, ids);
        }
      }, [App.icon('save'), ' Apply new order']);

      // per-show working state, rebuilt whenever the picker changes
      let eps = [], slotStarts = [], order = [];

      const drawList = () => {
        const show = App.show(showSel.value);
        listEl.innerHTML = '';
        let moving = 0;

        if (eps.length < 2) {
          listEl.appendChild(el('.ra-empty', null, eps.length
            ? '“' + show.name + '” has only one episode still in production — there’s nothing to reorder.'
            : 'Every episode of “' + show.name + '” has been delivered.'));
          applyBtn.disabled = true;
          return;
        }

        order.forEach((ep, i) => {
          const origIdx = eps.indexOf(ep);
          const delta = App.diffDays(slotStarts[i], slotStarts[origIdx]);
          if (delta) moving++;
          const subs = App.subitems(ep);
          const lockedCount = subs.filter(s => s.status === 'approved').length;
          const movable = subs.filter(s => s.status !== 'approved');
          // where the first task that CAN move ends up — not the slot date,
          // which an episode with lots of approved work never actually reaches
          const newStart = movable.length
            ? App.shiftIso(movable.reduce((m, s) => s.start < m ? s.start : m, movable[0].start), delta)
            : null;

          listEl.appendChild(el('.ra-row' + (delta ? '.moved' : ''), null, [
            el('span.ra-pos', null, String(i + 1)),
            el('.ra-main', null, [
              el('.ra-title', null, [
                el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color) } }, ep.code),
                el('span', null, ep.title)
              ]),
              el('.ra-sub', null, [
                el('span', null, App.fmtRange(App.epStart(ep), App.epDue(ep))),
                (delta
                  ? el('span.ra-delta', null, (delta > 0 ? '→ later by ' : '→ earlier by ') +
                      Math.abs(delta) + ' day' + (Math.abs(delta) === 1 ? '' : 's') +
                      (newStart ? ', starts ' + App.fmtDate(newStart) : ''))
                  : el('span.ra-same', null, '· unchanged')),
                (lockedCount
                  ? el('span.ra-lock', { title: lockedCount + ' approved task' + (lockedCount === 1 ? '' : 's') +
                      ' stay on their current dates' }, [App.icon('lock'), ' ' + lockedCount])
                  : null)
              ])
            ]),
            el('.ra-move', null, [
              el('button.btn-move', { type: 'button', disabled: i === 0, title: 'Move earlier',
                onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; drawList(); } }, '▲'),
              el('button.btn-move', { type: 'button', disabled: i === order.length - 1, title: 'Move later',
                onclick: () => { [order[i], order[i + 1]] = [order[i + 1], order[i]]; drawList(); } }, '▼')
            ])
          ]));
        });
        applyBtn.disabled = !moving;
      };

      const loadShow = () => {
        eps = App.rearrangeableEpisodes(showSel.value);
        // the slots themselves: where each position starts today. Episodes move
        // between these; the dates stay with the position.
        slotStarts = eps.map(ep => App.epStart(ep));
        order = eps.slice();
        noteEl.textContent = eps.length > 1
          ? 'Episodes swap schedule slots — move one earlier and it takes over the dates of the one it passes. ' +
            'Approved tasks keep their current dates, and delivered episodes aren’t listed.'
          : 'Pick a show with two or more episodes still in production.';
        drawList();
      };
      showSel.addEventListener('change', loadShow);
      loadShow();

      const sections = [
        field('Show', showSel, 'Which show’s episodes to reorder'),
        noteEl,
        listEl
      ];
      const footer = [
        el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Cancel'),
        applyBtn
      ];
      App.modal.open(card('calendar', 'Re-Arrange Episodes',
        'Reorder a show’s remaining episodes', sections, footer));
    }
  };

  /* ---- Milestone (Delivery / Live date) ----
     These aren't tasks, so there's nothing to drag — they're the dates the
     episode is committed to, and this is the only place they change. For the
     delivery date it also lists what has to be in hand on the day, so one click
     answers both "when is it" and "are we ready". */
  App.milestoneDialog = {
    open(epId, key) {
      const ep = App.state.data.episodes.find(x => x.id === epId); if (!ep) return;
      const ms = App.epMilestone(ep, key); if (!ms) return;
      const canEdit = App.canEditSchedule(App.state.role);
      const show = App.show(ep.showId);

      const dateInput = el('input.fld', { type: 'date', value: ms.date });
      if (!canEdit) dateInput.disabled = true;

      const isLive = key === App.LIVE_KEY;
      const autoLine = el('.ms-auto', null, [
        'The work first allows it on ',
        el('strong', null, App.fmtDate(ms.auto)),
        ' — ' + ms.afterQc + ' days after QC finishes.'
      ]);

      const slip = ms.slipDays;
      const status = el('.ms-status' + (slip > 0 ? '.bad' : '.ok'), null, [
        App.icon(slip > 0 ? 'warn' : 'lock'),
        slip > 0
          ? ' Committed date — the work now finishes ' + slip + ' day' + (slip === 1 ? '' : 's') + ' after it'
          : ' Committed date — the schedule still makes it'
      ]);

      const sections = [
        el('.ctx-box.slim', null, [
          el('span.ctx-chip', null, '# ' + ep.code),
          el('span.ctx-title', null, ep.title),
          el('span.ctx-dept', null, show.name)
        ]),
        status,
        field(ms.name, dateInput, !canEdit
          ? 'Only Producers, Managers and Post Operations can change this.'
          : isLive
            ? 'The date the episode goes out. It never moves on its own — moving it moves the delivery date with it.'
            : 'Defaults to ' + ms.lead + ' days before the live date. Set a date to hold it there instead.'),
        autoLine
      ];

      /* What the delivery day is actually made of. Readiness is measured on the
         files, not the task's status — a task can sit at Approved with nothing
         uploaded, and on the day what matters is whether the assets are there. */
      if (key === 'delivery_date') {
        const assets = App.deliveryAssets(ep);
        if (assets.length) {
          sections.push(el('.modal-section-title', { style: { marginTop: '16px' } }, 'Delivery assets'));
          sections.push(el('.dlv-list', null, assets.map(a => {
            const parts = [];
            if (a.files) parts.push(a.files + ' file' + (a.files === 1 ? '' : 's'));
            if (a.links) parts.push(a.links + ' link' + (a.links === 1 ? '' : 's'));
            return el('.dlv-row', null, [
              el('.dlv-what', null, [
                el('.dlv-dept', null, [el('span.dot', { style: { background: a.dept.color } }), a.dept.label]),
                el('.dlv-asset', null, a.label),
                el('.dlv-meta', null, a.count ? parts.join(' · ') : 'nothing uploaded yet')
              ]),
              a.count
                ? el('span.ws-chip.ok', { title: a.su.name + ' — ' + App.status(a.su.status).label },
                    '✓ ' + a.count + ' asset' + (a.count === 1 ? '' : 's'))
                : el('span.ws-chip.pending', { title: a.su.name + ' — ' + App.status(a.su.status).label }, '⏳ Pending')
            ]);
          })));
          const outstanding = assets.filter(a => !a.count);
          sections.push(el('.pop-note', { style: { marginTop: '8px' } }, outstanding.length
            ? 'Not ready to deliver — no assets uploaded for ' + outstanding.map(a => a.label).join(' or ')
            : '✓ All delivery assets uploaded'));
        }
      }

      const footer = [el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Close')];
      if (canEdit) {
        if (ms.fixed && !isLive) {
          footer.push(el('button.btn-ghost', {
            onclick: () => { App.modal.close(); App.setEpisodeMilestone(epId, key, null); }
          }, 'Follow the live date'));
        }
        footer.push(el('button.btn-primary', {
          onclick: () => {
            const v = dateInput.value;
            if (!v) { App.toast('Pick a date', true); return; }
            App.modal.close();
            App.setEpisodeMilestone(epId, key, v);
          }
        }, [App.icon('save'), ' Save date']));
      }

      App.modal.open(card('calendar', ms.name, App.fmtDate(ms.date) + ' · ' + ep.code, sections, footer));
    }
  };

  /* ---- Dependency impact confirmation ----
     Shown when dragging or stretching a bar lands it on top of a dependency.
     The producer gets the two schedules drawn over each other — where the task
     was in dotted grey, where it would go in solid colour — plus a line per
     broken dependency, then decides. Only the tasks actually involved are
     drawn; a full chart is what they just came from.

     Nothing here cascades: only the dragged task moves, so every other bar is
     at its current dates and the overlap band is the literal collision.

     Extension point: `sections` below is where the department-capacity and
     budget consequences of the move will slot in, alongside the dependency
     list — same shape, one more block. */
  App.impactDialog = {
    open(ep, key, impact, handlers) {
      const onConfirm = (handlers && handlers.onConfirm) || function () {};
      const onCancel = (handlers && handlers.onCancel) || function () {};
      /* Exactly one of confirm/cancel runs. The flag is set before close() so
         the dialog's own teardown — which reports dismissal as a cancel — can't
         overturn a choice the producer just made. */
      let decided = false;
      const finish = (fn) => { if (decided) return; decided = true; App.modal.close(); fn(); };

      const moved = impact.moved;
      const movedDept = App.dept(moved.dept);
      const later = impact.shiftDays > 0;

      /* The window spans every bar we draw, old and new, with a day of air
         either side. Plain calendar days: the main chart can hide weekends, but
         here the point is the literal overlap, so a squeezed axis would misread. */
      let winStart = impact.from.start < impact.to.start ? impact.from.start : impact.to.start;
      let winEnd = impact.from.due > impact.to.due ? impact.from.due : impact.to.due;
      impact.clashes.forEach(c => {
        if (c.task.start < winStart) winStart = c.task.start;
        if (c.task.due > winEnd) winEnd = c.task.due;
      });
      winStart = App.shiftIso(winStart, -1);
      winEnd = App.shiftIso(winEnd, 1);
      const winDays = App.diffDays(winEnd, winStart) + 1;
      const left = (iso) => (App.diffDays(iso, winStart) / winDays) * 100;
      const width = (s, d) => ((App.diffDays(d, s) + 1) / winDays) * 100;

      // one row per task involved, earliest first; the moved task carries both
      // its old and new bar, everything else sits still and shows the collision
      const rows = [{ task: moved, isMoved: true, clash: null }]
        .concat(impact.clashes.map(c => ({ task: c.task, isMoved: false, clash: c })))
        .sort((a, b) => {
          const sa = a.isMoved ? impact.to.start : a.task.start;
          const sb = b.isMoved ? impact.to.start : b.task.start;
          return sa < sb ? -1 : sa > sb ? 1 : 0;
        });

      const chart = el('.si-chart', null, [
        el('.si-axis', null, [
          el('span', null, App.fmtDate(winStart)),
          el('span', null, App.fmtDate(winEnd))
        ]),
        el('.si-rows', null, rows.map(r => {
          const dep = App.dept(r.task.dept);
          const bars = [];
          if (r.isMoved) {
            bars.push(el('.si-bar.si-old', {
              title: 'Now: ' + App.fmtRange(impact.from.start, impact.from.due),
              style: { left: left(impact.from.start) + '%', width: width(impact.from.start, impact.from.due) + '%' }
            }));
            bars.push(el('.si-bar.si-new', {
              title: 'After: ' + App.fmtRange(impact.to.start, impact.to.due),
              style: { left: left(impact.to.start) + '%', width: width(impact.to.start, impact.to.due) + '%',
                       background: dep.color, color: App.pickInk(dep.color) }
            }, el('span', null, App.fmtRange(impact.to.start, impact.to.due))));
          } else {
            bars.push(el('.si-bar.si-fixed', {
              title: r.task.name + ': ' + App.fmtRange(r.task.start, r.task.due) + ' (unchanged)',
              style: { left: left(r.task.start) + '%', width: width(r.task.start, r.task.due) + '%',
                       background: dep.color, color: App.pickInk(dep.color) }
            }));
            // the days where this task and the moved task would now sit on top
            // of each other — the reason we're asking
            const oStart = impact.to.start > r.task.start ? impact.to.start : r.task.start;
            const oEnd = impact.to.due < r.task.due ? impact.to.due : r.task.due;
            if (oStart <= oEnd) {
              const shared = App.diffDays(oEnd, oStart) + 1;
              bars.push(el('.si-clash', {
                title: shared + ' day' + (shared === 1 ? '' : 's') + ' running at the same time',
                style: { left: left(oStart) + '%', width: width(oStart, oEnd) + '%' }
              }));
            }
          }
          return el('.si-row' + (r.isMoved ? '.si-row-moved' : ''), null, [
            el('.si-label', null, [
              el('span.si-dot', { style: { background: dep.color } }),
              el('span.si-name', null, r.task.name),
              (r.isMoved ? el('span.si-tag', null, 'moving') : null)
            ]),
            el('.si-track', null, bars)
          ]);
        }))
      ]);

      const legend = el('.si-legend', null, [
        el('span.si-key', null, [el('span.si-swatch.si-old'), 'Now']),
        el('span.si-key', null, [el('span.si-swatch.si-new'), 'After the change']),
        el('span.si-key', null, [el('span.si-swatch.si-clash'), 'Overlap'])
      ]);

      const clashList = el('.si-list', null, impact.clashes.map(c => el('.si-item', null, [
        App.icon('warn', { cls: 'si-item-ic' }),
        el('.si-item-main', null, [
          el('.si-item-title', null, [
            el('span', null, c.task.name),
            el('span.si-dir', null, c.dir === 'upstream' ? 'feeds this task' : 'waits on this task')
          ]),
          el('.si-item-sub', null, App.dept(c.task.dept).label + ' · ' +
            App.fmtRange(c.task.start, c.task.due) + ' · ' + c.text)
        ]),
        el('span.si-overlap', { title: 'The order is out by ' + c.earlyBy + ' day' + (c.earlyBy === 1 ? '' : 's') },
          c.earlyBy + 'd early')
      ])));

      const sections = [
        el('.ctx-box.slim', null, [
          el('span.ctx-chip', null, '# ' + ep.code),
          el('span.ctx-title', null, moved.name),
          el('span.ctx-dept', null, movedDept.label)
        ]),
        el('.si-headline', null, [
          el('strong', null, App.fmtRange(impact.from.start, impact.from.due)),
          el('span.si-arrow', null, '→'),
          el('strong', null, App.fmtRange(impact.to.start, impact.to.due)),
          el('span.si-shift', null, impact.shiftDays
            ? (later ? 'later by ' : 'earlier by ') + Math.abs(impact.shiftDays) + 'd'
            : 'same start, new length')
        ]),
        el('.fld-hint', { style: { margin: '2px 0 10px' } },
          'This would break ' + impact.clashes.length + ' dependenc' +
          (impact.clashes.length === 1 ? 'y' : 'ies') +
          '. Nothing else is rescheduled — the tasks below stay where they are.'),
        clashList,
        chart,
        legend
      ];

      const footer = [
        el('button.btn-ghost', { onclick: () => finish(onCancel) }, 'Keep as it was'),
        el('button.btn-danger', { onclick: () => finish(onConfirm) }, [App.icon('warn'), ' Move anyway'])
      ];

      App.modal.open(
        card('calendar', 'Dependency clash', 'Review what this move breaks before it happens', sections, footer, 'wide'),
        // dismissing by ✕, backdrop or Escape is an answer too, and it's "no"
        { onClose: () => finish(onCancel) }
      );
    }
  };
  /* ---- Reusable pipeline editor ----
     The compact/expandable task list shared by Add Show and Admin → Workflow →
     Pipelines. Mutates the array it's given IN PLACE (push/splice/swap), so the
     caller's reference stays valid; `onChange` fires after anything that could
     alter scheduling (add/remove/reorder/deps/durations). */
  App.pipelineEditor = function (initialPipe, opts) {
    const onChange = (opts && opts.onChange) || function () {};
    const tip = (opts && opts.tooltips === false) ? () => null : (text) => text;
    let pipe = initialPipe;
    let editingKey = null;
    let confirmKey = null;      // task awaiting the inline remove confirmation
    let depMenu = null;
    const closeDepMenu = () => { if (depMenu) { depMenu.remove(); depMenu = null; document.removeEventListener('click', closeDepMenu); } };

    const pipeCount = el('span.count-badge');
    const pipeList = el('.pipe-list');

    /* ---- undo / redo ----
       Snapshots of the whole task list, taken before each structural change
       (add, remove, reorder, dependency edits). Restoring splices the saved
       tasks back into the SAME array rather than swapping in a new one: Add
       Show holds its own reference to this array and reads it when the show is
       created, so replacing it would silently create the show from pre-undo
       state. Free-text/number edits aren't recorded — snapshotting per
       keystroke would bury the structural steps people actually want back. */
    const clonePipe = (p) => p.map(t => Object.assign({}, t, { deps: t.deps.slice() }));
    const HISTORY_LIMIT = 50;
    let undoStack = [], redoStack = [];

    const undoBtn = el('button.btn-icon.pipe-hist', {
      type: 'button', title: tip('Undo (' + App.shortcutLabel('Z') + ')'),
      onclick: (e) => { e.stopPropagation(); undo(); }
    }, '↶');
    const redoBtn = el('button.btn-icon.pipe-hist', {
      type: 'button', title: tip('Redo (' + App.shortcutLabel('\u21e7Z') + ')'),
      onclick: (e) => { e.stopPropagation(); redo(); }
    }, '↷');
    function refreshHistory() {
      undoBtn.disabled = !undoStack.length;
      redoBtn.disabled = !redoStack.length;
    }
    // call immediately BEFORE mutating `pipe`
    function snapshot() {
      undoStack.push({ pipe: clonePipe(pipe), editingKey });
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack = [];
      refreshHistory();
    }
    function restore(entry) {
      pipe.length = 0;
      clonePipe(entry.pipe).forEach(t => pipe.push(t));   // in place — see note above
      editingKey = pipe.some(t => t.key === entry.editingKey) ? entry.editingKey : null;
      renderPipe(); onChange();
      refreshHistory();
    }
    function undo() {
      if (!undoStack.length) return;
      redoStack.push({ pipe: clonePipe(pipe), editingKey });
      restore(undoStack.pop());
    }
    function redo() {
      if (!redoStack.length) return;
      undoStack.push({ pipe: clonePipe(pipe), editingKey });
      restore(redoStack.pop());
    }
    refreshHistory();

    // would adding `candidate` as a dependency of `t` create a cycle?
    const dependsOn = (fromKey, onKey) => {
      const seen = new Set();
      const walk = (k) => {
        if (k === onKey) return true;
        if (seen.has(k)) return false;
        seen.add(k);
        const task = pipe.find(p => p.key === k);
        return !!task && task.deps.some(walk);
      };
      return walk(fromKey);
    };

    function openDepMenu(btn, t) {
      closeDepMenu();
      const options = pipe.filter(p => p.key !== t.key && !t.deps.includes(p.key) && !dependsOn(p.key, t.key));
      depMenu = el('.dep-menu');
      if (!options.length) depMenu.appendChild(el('.dep-menu-empty', null, 'No tasks available (self, existing deps and cycles are excluded)'));
      options.forEach(p => {
        depMenu.appendChild(el('button.dep-menu-item', {
          type: 'button',
          onclick: (e) => { e.stopPropagation(); snapshot(); t.deps.push(p.key); closeDepMenu(); renderPipe(); onChange(); }
        }, [el('span.dot', { style: { background: App.dept(p.dept).color } }), p.name]));
      });
      document.body.appendChild(depMenu);
      const r = btn.getBoundingClientRect();
      requestAnimationFrame(() => {
        const mh = depMenu.offsetHeight, mw = depMenu.offsetWidth;
        depMenu.style.top = (r.bottom + mh + 6 > window.innerHeight ? r.top - mh - 4 : r.bottom + 4) + 'px';
        depMenu.style.left = Math.min(r.left, window.innerWidth - mw - 8) + 'px';
      });
      setTimeout(() => document.addEventListener('click', closeDepMenu), 0);
    }

    const numFld = (t, prop, min) => el('input.fld.fld-num', {
      type: 'number', value: String(t[prop] != null ? t[prop] : min), min: String(min), max: '365',
      onchange: (e) => { t[prop] = Math.max(min, Math.min(365, parseInt(e.target.value) || min)); e.target.value = t[prop]; onChange(); }
    });

    // whole weeks read better than "28d" for the long waits a lag is used for
    const lagLabel = (n) => (n % 7 === 0 ? (n / 7) + 'w' : n + 'd');

    /* Row number that becomes an insert button on hover, so a task can be added
       anywhere in the order rather than only appended. Same 20px footprint
       either way, so revealing it never shifts the row. */
    const leadCell = (i) => el('.pipe-lead', null, [
      el('span.pipe-num', null, i + 1),
      el('button.pipe-insert', {
        type: 'button', title: tip('Add a task below'),
        onclick: (e) => { e.stopPropagation(); addTask(i + 1); }
      }, '＋')
    ]);

    const moveBtns = (i, extraCls) => el('.pipe-move' + (extraCls || ''), null, [
      el('button.btn-move', { type: 'button', disabled: i === 0, title: tip('Move up'),
        onclick: (e) => { e.stopPropagation(); snapshot(); [pipe[i - 1], pipe[i]] = [pipe[i], pipe[i - 1]]; renderPipe(); } }, '▲'),
      el('button.btn-move', { type: 'button', disabled: i === pipe.length - 1, title: tip('Move down'),
        onclick: (e) => { e.stopPropagation(); snapshot(); [pipe[i], pipe[i + 1]] = [pipe[i + 1], pipe[i]]; renderPipe(); } }, '▼')
    ]);

    function compactRow(t, i) {
      const dep = App.dept(t.dept);
      const depNames = t.deps.map(dk => { const d = pipe.find(p => p.key === dk); return d ? d.name : dk; });
      return el('.pipe-row.compact', {
        title: tip('Click to edit'),
        onclick: () => { editingKey = t.key; renderPipe(); }
      }, [
        leadCell(i),
        el('span.pipe-dot', { style: { background: dep.color }, title: tip(dep.label) }),
        el('span.pipe-name-ro', null, t.name || '—'),
        (t.vc ? App.icon('lock', { cls: 'pipe-vc-tag', title: 'LucidLink version control enabled' }) : null),
        el('span.pipe-deps-sum', { title: tip(depNames.join(', ')) }, depNames.length ? '◷ ' + depNames.join(', ') : ''),
        (t.lag ? el('span.pipe-lag', { title: tip('Waits ' + t.lag + ' days after ' + (depNames.join(', ') || 'its dependency') + ' finishes') }, '+' + lagLabel(t.lag)) : null),
        el('span.pipe-dur', { title: tip('Nominal ' + t.days + ' days · minimum ' + t.minDays) }, t.days + 'd'),
        moveBtns(i, '.hov')
      ]);
    }

    function editRow(t, i) {
      const deptSel = el('select.fld.fld-dept', { onchange: (e) => { t.dept = e.target.value; } });
      Object.keys(App.DEPARTMENTS).forEach(dk => {
        const o = document.createElement('option'); o.value = dk; o.textContent = App.DEPARTMENTS[dk].label;
        if (dk === t.dept) o.selected = true; deptSel.appendChild(o);
      });

      const depsBox = el('.dep-tags', null, [
        ...t.deps.map(dk => {
          const dep = pipe.find(p => p.key === dk);
          return el('span.dep-tag', null, [
            dep ? dep.name : dk,
            el('button.dep-tag-x', {
              type: 'button', title: tip('Remove dependency'),
              onclick: () => { snapshot(); t.deps = t.deps.filter(k => k !== dk); renderPipe(); onChange(); }
            }, '✕')
          ]);
        }),
        el('button.dep-add', {
          type: 'button', title: tip('Add dependency'),
          onclick: (e) => { e.stopPropagation(); openDepMenu(e.currentTarget, t); }
        }, '＋')
      ]);

      // LucidLink version-control toggle — the ONLY place VC is switched on for
      // a task, and off by default. Shown only when the connector is enabled.
      const vcToggle = App.connectorEnabled('lucidlink') ? el('button.pipe-vc' + (t.vc ? '.on' : ''), {
        type: 'button', title: tip(t.vc ? 'Version control ON — click to turn off' : 'Enable LucidLink version control for this task'),
        onclick: (e) => { e.stopPropagation(); t.vc = !t.vc; renderPipe(); onChange(); }
      }, App.icon('lock')) : null;

      return el('.pipe-row.editing', null, [
        leadCell(i),
        moveBtns(i),
        el('input.fld.fld-name', { type: 'text', value: t.name, placeholder: 'Task name',
          oninput: (e) => { t.name = e.target.value; } }),
        deptSel,
        el('.pipe-days', null, [el('span.pipe-days-lbl', null, 'days'), numFld(t, 'days', 1)]),
        el('.pipe-days', null, [el('span.pipe-days-lbl', null, 'min'), numFld(t, 'minDays', 1)]),
        // days to wait after the dependencies finish before this task starts
        el('.pipe-days', { title: tip('Days to wait after this task’s dependencies finish before it starts — 0 = start the next day') },
          [el('span.pipe-days-lbl', null, 'wait'), numFld(t, 'lag', 0)]),
        depsBox,
        el('.pipe-actions', null, [
          vcToggle,
          el('button.btn-done', {
            type: 'button', title: tip('Done editing'),
            onclick: () => { editingKey = null; renderPipe(); }
          }, '✓'),
          el('button.btn-row-x', {
            type: 'button', title: tip('Remove task'),
            onclick: () => removeTask(t, i)
          }, App.icon('trash'))
        ])
      ]);
    }

    function renderPipe() {
      closeDepMenu();
      pipeCount.textContent = pipe.length;
      pipeList.innerHTML = '';
      pipe.forEach((t, i) => pipeList.appendChild(
        t.key === confirmKey ? confirmRow(t, i)
        : t.key === editingKey ? editRow(t, i)
        : compactRow(t, i)));
    }

    /* ---- removing a task, and the dependencies it leaves behind ----
       Deleting a task in the middle of a chain orphans everything downstream:
       delete Blocking and Animation is left with nothing to wait for, so it
       jumps to the front of the schedule. Rather than silently dropping those
       links, list the affected tasks and offer to pass the deleted task's own
       dependencies down to them — Animation → Layout, keeping the order the
       pipeline actually meant. Inheriting upstream deps can't create a cycle:
       they already sit above the task being removed.
       A task nothing depends on is deleted without ceremony. */
    const nameOf = (key) => { const p = pipe.find(x => x.key === key); return p ? (p.name || 'Untitled') : key; };

    function applyRemove(t, i, reconnect) {
      snapshot();
      const inherit = t.deps.slice();
      pipe.splice(i, 1);
      pipe.forEach(p => {
        if (!p.deps.includes(t.key)) return;
        p.deps = p.deps.filter(k => k !== t.key);
        if (reconnect) inherit.forEach(k => { if (k !== p.key && !p.deps.includes(k)) p.deps.push(k); });
      });
      editingKey = null; confirmKey = null;
      renderPipe(); onChange();
    }

    function removeTask(t, i) {
      // nothing downstream to strand — just go
      if (!pipe.some(p => p.key !== t.key && p.deps.includes(t.key))) { applyRemove(t, i, false); return; }
      confirmKey = t.key;
      renderPipe();
      const row = pipeList.querySelector('.pipe-confirm');
      if (row) row.scrollIntoView({ block: 'nearest' });
    }

    /* The prompt replaces the row in place rather than opening a modal: this
       editor is itself inside a dialog (Add Show / Admin), and App.modal only
       holds one card at a time — a modal here would tear its own host down. */
    function confirmRow(t, i) {
      const dependents = pipe.filter(p => p.key !== t.key && p.deps.includes(t.key));
      const inherit = t.deps.slice();
      const label = t.name || 'this task';
      const many = dependents.length > 1;

      return el('.pipe-row.pipe-confirm', null, [
        el('.pc-msg', null, [
          App.icon('warn', { cls: 'pc-ic' }),
          el('span', null, 'Removing ' + label + ' leaves ' + dependents.length + ' task' + (many ? 's' : '') +
            ' with nothing to wait for. Re-check ' + (many ? 'these' : 'this') + ':')
        ]),
        el('.dep-migrate', null, dependents.map(d => el('.dm-row', null, [
          el('span.dot', { style: { background: App.dept(d.dept).color } }),
          el('span.dm-name', null, d.name || 'Untitled'),
          el('span.dm-arrow', null, '→'),
          el('span.dm-new', null, inherit.length ? inherit.map(nameOf).join(', ') : 'nothing — free to start immediately')
        ]))),
        el('.pc-foot', null, [
          el('span.pc-hint', null, inherit.length
            ? 'Reconnect hands down ' + label + '’s own dependencies (' + inherit.map(nameOf).join(', ') + ').'
            : label + ' waits on nothing, so there’s nothing to hand down.'),
          el('button.btn-ghost.pc-btn', {
            type: 'button', onclick: (e) => { e.stopPropagation(); confirmKey = null; renderPipe(); }
          }, 'Cancel'),
          (inherit.length ? el('button.btn-ghost.pc-btn', {
            type: 'button', onclick: (e) => { e.stopPropagation(); applyRemove(t, i, false); }
          }, 'Remove only') : null),
          el('button.btn-danger.pc-btn', {
            type: 'button', onclick: (e) => { e.stopPropagation(); applyRemove(t, i, !!inherit.length); }
          }, inherit.length ? 'Reconnect and remove' : 'Remove')
        ])
      ]);
    }

    // `at` is the index to insert at; omitted (the header ＋) appends.
    function addTask(at) {
      snapshot();
      const key = 'task_' + App.uid().slice(0, 6);
      const idx = typeof at === 'number' ? Math.max(0, Math.min(at, pipe.length)) : pipe.length;
      pipe.splice(idx, 0, { key, name: 'New Task', dept: 'creative', days: 5, minDays: 2, deps: [], vc: false });
      editingKey = key;
      renderPipe(); onChange();
      const row = pipeList.querySelector('.pipe-row.editing');
      if (row) row.scrollIntoView({ block: 'nearest' });   // an inserted row may be anywhere in the list
      const fld = pipeList.querySelector('.pipe-row.editing .fld-name');
      if (fld) { fld.focus(); fld.select(); }
    }

    renderPipe();
    /* Published so the global Cmd+Z / Cmd+Y handler can find the editor that's
       on screen. There's only ever one — it lives inside a dialog, and dialogs
       don't stack. No teardown hook to unregister from, so the handler checks
       `list.isConnected` instead: a closed dialog's list is detached. */
    const api = {
      list: pipeList, count: pipeCount, addTask, render: renderPipe,
      undoBtn, redoBtn, undo, redo,
      getPipe: () => pipe,
      // a wholesale swap (different show type or preset) starts a new history —
      // undoing back into a pipeline that's no longer on screen would confuse
      setPipe: (p) => { pipe = p; editingKey = null; undoStack = []; redoStack = []; refreshHistory(); renderPipe(); },
      closeMenus: closeDepMenu
    };
    App._pipeEditor = api;
    return api;
  };

  // ---- Add Show ----
  // Schedule planner + per-show pipeline editor. The producer supplies a start
  // date; a dependency-aware forward pass (App.schedulePipeline) computes the
  // recommended finish. Picking an earlier/later project end date squeezes or
  // extends every task proportionally — but never below a task's minimum days.
  App.addShow = {
    open() {
      if (!App.canManageShows(App.state.role)) { App.toast('Only Producers can add shows', true); return; }
      App.track.feature('show.addDialog');

      // working copy of the pipeline this show will own — reloaded when the
      // show type or preset changes (each type has its own default task set,
      // plus any named presets saved in Admin → Workflow → Pipelines)
      let pipe = App.defaultPipelineFor('animation');
      let targetTouched = false;                    // has the user hand-picked an end date?
      const editor = App.pipelineEditor(pipe, { onChange: () => updateSchedule(), tooltips: false });

      // ---------- show details ----------
      const nameInput = el('input.fld', { type: 'text', placeholder: 'e.g. Little Angel' });
      const codeInput = el('input.fld', { type: 'text', placeholder: 'e.g. LA', maxlength: '6' });
      const typeSel = el('select.fld', {
        onchange: () => { rebuildPresetOptions(); loadPipeline(); }
      });
      [['animation', 'Animation'], ['live_action', 'Live Action']].forEach(([v, l]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = l; typeSel.appendChild(o);
      });

      // pipeline preset picker — the type's built-in default plus any saved
      // presets for that type; the show gets its own deep copy either way
      const presetSel = el('select.fld', { onchange: () => loadPipeline() });
      function rebuildPresetOptions() {
        presetSel.innerHTML = '';
        const t = typeSel.value;
        const def = document.createElement('option');
        def.value = ''; def.textContent = 'Standard ' + (t === 'animation' ? 'Animation' : 'Live Action');
        presetSel.appendChild(def);
        (App.state.data.pipelinePresets || []).filter(p => p.type === t).forEach(p => {
          const o = document.createElement('option');
          o.value = p.id; o.textContent = p.name + ' · ' + p.pipeline.length + ' tasks';
          presetSel.appendChild(o);
        });
      }
      function loadPipeline() {
        const preset = presetSel.value && (App.state.data.pipelinePresets || []).find(p => p.id === presetSel.value);
        pipe = preset
          ? JSON.parse(JSON.stringify(preset.pipeline))
          : App.defaultPipelineFor(typeSel.value);
        editor.setPipe(pipe);
        updateSchedule();
      }
      const countInput = el('input.fld', { type: 'number', value: '3', min: '1', max: '100' });
      const epList = el('.ep-name-list');
      /* Episode rows carry a name and the date that episode goes live. Live
         dates default to the even cadence, but each is editable: naming a date
         moves that one episode's work so it lands there, leaving the others
         where they are. `epLive[i]` holds only the dates actually typed — a
         blank entry means "wherever the cadence puts it" and keeps following
         the plan when the start, cadence or pipeline changes. */
      const epNameVals = [], epLive = [];
      const epCountBadge = el('span.count-badge');
      const rebuildEps = () => {
        const n = Math.max(1, Math.min(EP_MAX, parseInt(countInput.value) || 1));
        [...epList.querySelectorAll('.ep-name-row')].forEach((row, i) => {
          epNameVals[i] = row.querySelector('.ep-name-fld').value;
        });
        epList.innerHTML = '';
        for (let i = 0; i < n; i++) {
          const idx = i;
          const liveInput = el('input.fld.ep-live-fld', { type: 'date' });
          liveInput.addEventListener('change', () => {
            epLive[idx] = liveInput.value || null;
            updateSchedule();
          });
          epList.appendChild(el('.ep-name-row', null, [
            el('span.ep-name-num', null, '#' + (i + 1)),
            el('input.fld.ep-name-fld', { type: 'text', value: epNameVals[i] || ('Episode ' + (i + 1)), placeholder: 'Episode ' + (i + 1) }),
            el('.ep-live-cell', null, [el('span.ep-live-lbl', null, 'Live'), liveInput])
          ]));
        }
        epLive.length = n;
        if (epCountBadge) epCountBadge.textContent = String(n);
      };

      // ---------- schedule ----------
      const startInput = el('input.fld', { type: 'date', value: App.isoDate(App.today()) });
      const cadenceInput = el('input.fld', { type: 'number', value: '14', min: '1', max: '90' });
      const endInput = el('input.fld', { type: 'date' });
      const recPill = el('.rec-pill');
      const endFeedback = el('.end-feedback');
      const useRecBtn = el('button.btn-icon', {
        type: 'button',
        onclick: () => { targetTouched = false; updateSchedule(); }
      }, '↺');

      const readPlan = () => ({
        start: startInput.value || App.isoDate(App.today()),
        cadence: Math.max(1, parseInt(cadenceInput.value) || 14),
        epCount: Math.max(1, Math.min(EP_MAX, parseInt(countInput.value) || 1))
      });

      function updateSchedule() {
        const { start, cadence, epCount } = readPlan();
        const rec = App.scheduleShow(pipe, start, epCount, cadence, 1);
        const floor = App.scheduleShow(pipe, start, epCount, cadence, 0);
        recPill.innerHTML = '';
        endFeedback.innerHTML = '';
        if (!rec) {   // dependency cycle — the dep picker prevents this, but belt & braces
          recPill.appendChild(el('span', { style: { color: 'var(--danger)' } }, [App.icon('warn'), ' Dependency cycle in the pipeline']));
          return;
        }
        if (!targetTouched) endInput.value = rec.end;
        const target = endInput.value || rec.end;

        const recDays = App.diffDays(rec.end, start) + 1;
        recPill.appendChild(App.icon('calendar', { cls: 'range-ic' }));
        recPill.appendChild(el('span.range-txt', null, 'Recommended finish: ' + App.fmtDate(rec.end) + ', ' + App.parseDate(rec.end).getFullYear()));
        recPill.appendChild(el('span.range-days', null, recDays + ' days · ' + pipe.length + ' tasks × ' + epCount + ' ep'));
        if (target !== rec.end) {                 // manual squeeze/extend — compare vs recommended
          const selDays = App.diffDays(target, start) + 1;
          const delta = selDays - recDays;
          recPill.appendChild(el('span.rec-cmp' + (delta < 0 ? '.short' : '.long'), null,
            'Selected: ' + selDays + ' days (' + (delta < 0 ? '−' : '+') + Math.abs(delta) + ' days)'));
        }

        if (target === rec.end) {
          endFeedback.className = 'end-feedback ok';
          endFeedback.textContent = '✓ On the recommended schedule';
        } else if (target < floor.end) {
          endFeedback.className = 'end-feedback bad';
          endFeedback.textContent = 'Impossible — even with every task at its minimum time the earliest finish is ' +
            App.fmtDate(floor.end) + ', ' + App.parseDate(floor.end).getFullYear() + '. It will be clamped to that.';
        } else if (target < rec.end) {
          const solved = App.solveScale(pipe, start, epCount, cadence, target);
          const giveUp = 100 - Math.round(solved.scale * 100);
          endFeedback.className = 'end-feedback warn';
          endFeedback.textContent = 'Squeezed fairly — every task gives up ' + giveUp +
            '% of its squeezable slack; no task goes below its minimum';
        } else {
          const solved = App.solveScale(pipe, start, epCount, cadence, target);
          endFeedback.className = 'end-feedback ok';
          endFeedback.textContent = '⤢ Extended to ' + Math.round(solved.scale * 100) + '% of nominal — extra breathing room on every task';
        }

        paintEpisodeDates();
      }

      /* Every episode's kick-off and live date under the current plan.

         An episode's live date is a fixed buffer past the end of its own work,
         so naming one is really naming when that episode must finish: the whole
         episode slides by the gap between the date it would reach and the date
         asked for. Only that episode moves — the rest keep their cadence, which
         is what makes this useful for pulling a single episode forward.

         The squeeze/stretch from the Project End Date is a separate knob: it
         sets how long each episode's work takes, and applies to all of them. */
      const LIVE_OFFSET = App.milestoneDef(App.LIVE_KEY).afterQc;
      function episodePlan() {
        const { start, cadence, epCount } = readPlan();
        const rec = App.scheduleShow(pipe, start, epCount, cadence, 1);
        if (!rec) return [];
        const target = endInput.value || rec.end;
        const scale = target === rec.end ? 1
          : (App.solveScale(pipe, start, epCount, cadence, target) || { scale: 1 }).scale;
        const out = [];
        for (let i = 0; i < epCount; i++) {
          const baseStart = App.shiftIso(start, i * cadence);
          const sch = App.schedulePipeline(pipe, baseStart, scale);
          if (!sch) return [];
          // milestones hang off QC, not off whatever finishes last — anchor
          // here the same way so the date shown is the date the episode gets
          const anchor = (sch.dates.qc && sch.dates.qc.due) || sch.end;
          const suggestedLive = App.shiftIso(anchor, LIVE_OFFSET);
          const wanted = epLive[i] || null;
          const shift = wanted ? App.diffDays(wanted, suggestedLive) : 0;
          out.push({
            i, scale, suggestedLive,
            live: wanted || suggestedLive,
            start: App.shiftIso(baseStart, shift),
            shift
          });
        }
        return out;
      }

      // fill the per-episode live-date fields with whatever the plan now reaches
      function paintEpisodeDates() {
        const plan = episodePlan();
        [...epList.querySelectorAll('.ep-name-row')].forEach((row, i) => {
          const input = row.querySelector('.ep-live-fld');
          const p = plan[i];
          if (!input || !p) return;
          input.value = p.live;
          input.classList.toggle('moved', !!p.shift);
          row.title = p.shift
            ? 'Starts ' + App.fmtDate(p.start) + ' — ' + Math.abs(p.shift) + ' day' +
              (Math.abs(p.shift) === 1 ? '' : 's') + (p.shift < 0 ? ' earlier' : ' later') +
              ' than the cadence, to go live on ' + App.fmtDate(p.live)
            : 'Starts ' + App.fmtDate(p.start) + ' — on the ' + readPlan().cadence + '-day cadence';
        });
      }

      countInput.addEventListener('input', () => { rebuildEps(); updateSchedule(); });
      // snap an over-the-cap number back on blur, so the field can't keep
      // claiming 250 while the schedule below it is quietly planning 100
      countInput.addEventListener('change', () => {
        const n = Math.max(1, Math.min(EP_MAX, parseInt(countInput.value) || 1));
        if (String(n) !== countInput.value) { countInput.value = n; rebuildEps(); updateSchedule(); }
      });
      startInput.addEventListener('change', updateSchedule);
      cadenceInput.addEventListener('change', updateSchedule);
      endInput.addEventListener('change', () => { targetTouched = true; updateSchedule(); });

      /* ---------- collapsible sections ----------
         The dialog is already taller than most screens, so only one of these
         stands open at a time — opening one folds the rest away. */
      const panels = [];
      function collapsible(label, headExtras, body, onToggle) {
        const chev = el('span.chev', null, '▶');
        body.style.display = 'none';
        const api = {
          open: false,
          setOpen(v) {
            if (v) panels.forEach(p => { if (p !== api && p.open) p.setOpen(false); });
            api.open = v;
            chev.classList.toggle('open', v);
            body.style.display = v ? '' : 'none';
            if (onToggle) onToggle(v);
          }
        };
        api.head = el('.pipe-toggle', { onclick: () => api.setOpen(!api.open) },
          [chev, el('span.pipe-toggle-lbl', null, label)].concat(headExtras || []));
        api.body = body;
        panels.push(api);
        return api;
      }

      // ---------- episodes ----------
      const epBody = el('.pipe-body', null, [
        el('.fld-hint', { style: { margin: '8px 0' } },
          'Name each episode and, if it matters, say when it goes live. Live dates follow the cadence unless you change one — then just that episode moves to land on its date.'),
        epList
      ]);
      const epPanel = collapsible('Episodes', [epCountBadge], epBody);

      // ---------- pipeline editor (shared component) ----------
      const addTaskBtn = el('button.btn-icon', {
        type: 'button',
        onclick: (e) => {
          e.stopPropagation();                      // lives inside the collapse toggle row
          editor.addTask();
        }
      }, '＋');

      const pipeBody = el('.pipe-body', null, [
        el('.fld-hint', { style: { margin: '8px 0' } },
          '“days” is the nominal duration, “min” the floor it can be squeezed to. Dependencies gate when a task can start. Click a task to edit it.'),
        editor.list
      ]);
      // the pipeline controls only make sense once the section is expanded
      const pipeTools = [editor.undoBtn, editor.redoBtn, addTaskBtn];
      pipeTools.forEach(b => { b.style.display = 'none'; });
      const pipePanel = collapsible('Customize Pipeline Tasks',
        [editor.count, editor.undoBtn, editor.redoBtn, addTaskBtn],
        pipeBody,
        (open) => { pipeTools.forEach(b => { b.style.display = open ? '' : 'none'; }); });

      rebuildEps();
      rebuildPresetOptions();
      updateSchedule();

      const sections = [
        el('.modal-section-title', null, 'Show Details'),
        el('.plan-grid', null, [
          field('Show Name', nameInput, 'The full title of the series'),
          field('Show Code', codeInput, 'Prefix for episode codes (LA → LA-1)'),
          field('Show Type', typeSel, 'Sets the default pipeline for this show'),
          field('Pipeline', presetSel, 'The standard pipeline, or a preset saved in Admin → Workflow')
        ]),
        el('.modal-section-title', null, 'Schedule'),
        el('.sched-box', null, [
          el('.plan-grid', null, [
            field('Project Start Date', startInput),
            field('Number of Episodes', countInput),
            field('Episode Cadence', cadenceInput, 'Days between episode kick-offs')
          ]),
          el('.plan-grid.two.end-row', null, [
            field('Project End Date', endInput, 'Pull it earlier to squeeze the pipeline, push it later to extend'),
            el('.field.end-btn-slot', null, useRecBtn)
          ]),
          recPill,
          endFeedback
        ]),
        epPanel.head,
        epPanel.body,
        pipePanel.head,
        pipePanel.body
      ];

      const footer = [
        el('button.btn-ghost', { onclick: () => { editor.closeMenus(); App.modal.close(); } }, 'Cancel'),
        el('button.btn-primary', {
          onclick: () => {
            const name = nameInput.value.trim(), code = codeInput.value.trim().toUpperCase();
            if (!name || !code) { App.toast('Show name and code are required', true); return; }
            if (!pipe.length) { App.toast('The pipeline needs at least one task', true); return; }
            if (!App.topoSort(pipe)) { App.toast('The pipeline has a dependency cycle', true); return; }
            const { start, cadence, epCount } = readPlan();
            const epNames = [...epList.querySelectorAll('.ep-name-fld')].map((inp, idx) => inp.value.trim() || ('Episode ' + (idx + 1))).slice(0, epCount);
            const rec = App.scheduleShow(pipe, start, epCount, cadence, 1);
            const target = endInput.value || rec.end;
            const scale = target === rec.end ? 1 : App.solveScale(pipe, start, epCount, cadence, target).scale;
            // an episode given its own live date starts wherever it must to
            // land there; the rest keep the even cadence. The live date is
            // stamped on the episode either way — it's the commitment now.
            const plan = episodePlan();
            const epStarts = plan.map(p => p.start), epLives = plan.map(p => p.live);
            // keep the optional flags the editor can set — dropping them here
            // silently discarded a task's lag and its version-control toggle
            const pipeline = pipe.map(t => {
              const o = { key: t.key, name: t.name.trim() || t.key, dept: t.dept, days: t.days, minDays: t.minDays, deps: t.deps.slice() };
              if (t.lag) o.lag = t.lag;
              if (t.vc) o.vc = true;
              return o;
            });
            App.createShow({ name, code, type: typeSel.value, epNames, pipeline, startIso: start, cadence, scale, epStarts, epLives });
            App.track.flowDone('Create show', true, { episodes: epNames.length });
            editor.closeMenus();
            App.modal.close();
          }
        }, '＋ Create Show')
      ];

      App.modal.open(card('clapper', 'Add New Show', 'Plan the schedule and customize the pipeline', sections, footer, 'wide'));
      App.track.flowStart('Create show');   // after open() for the same reason
    }
  };
})();
