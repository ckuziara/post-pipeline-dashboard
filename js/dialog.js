/* Modal dialogs — a reusable overlay plus the Edit Task dialog (opened from the
   timeline / board) and the Add Show dialog (opened from the board by producers).
   UI only; the actual data mutations live in main.js (applyTaskEdit / removeTask /
   createShow). */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  // ---- overlay ----
  App.modal = {
    open(card) {
      this.close();
      const ov = el('.modal-overlay', { onclick: (e) => { if (e.target === ov) App.modal.close(); } });
      ov.appendChild(card);
      document.body.appendChild(ov);
      this._ov = ov;
      this._esc = (e) => { if (e.key === 'Escape') App.modal.close(); };
      document.addEventListener('keydown', this._esc);
      const f = card.querySelector('input,select'); if (f) setTimeout(() => f.focus(), 30);
    },
    close() { if (this._ov) { this._ov.remove(); this._ov = null; document.removeEventListener('keydown', this._esc); } }
  };

  function card(icon, title, subtitle, sections, footer, cls) {
    return el('.modal-card' + (cls ? '.' + cls : ''), { onclick: (e) => e.stopPropagation() }, [
      el('.modal-head', null, [
        el('.modal-head-main', null, [
          el('span.modal-ic', null, icon),
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

  // ---- Edit Task ----
  App.editTask = {
    open(epId, key) {
      const ep = App.state.data.episodes.find(e => e.id === epId); if (!ep) return;
      const su = App.subitem(ep, key); if (!su) return;
      const role = App.state.role;
      if (!App.canEditTask(role, su)) {
        const d = App.roleDept(role);
        App.toast('Your role can only edit ' + (d ? App.dept(d).label : 'permitted') + ' tasks', true);
        return;
      }
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
          rangePill.appendChild(el('span.range-ic', null, '📅'));
          rangePill.appendChild(el('span.range-txt', null, App.fmtRange(s, d) + ', ' + App.parseDate(d).getFullYear()));
          rangePill.appendChild(el('span.range-days', null, days + (days === 1 ? ' day' : ' days')));
        } else {
          rangePill.classList.add('bad');
          rangePill.appendChild(el('span', null, 'Due date must be on or after the start date'));
        }
      };
      startInput.addEventListener('change', updateRange); dueInput.addEventListener('change', updateRange); updateRange();

      const sections = [
        el('.ctx-box', null, [
          el('.ctx-label', null, 'Episode Context'),
          el('.ctx-row', null, [el('span.ctx-chip', null, '# ' + ep.code), el('span.ctx-title', null, ep.title)])
        ]),
        el('.modal-section-title', null, 'Basic Information'),
        field('Task Name', nameInput, 'A clear, descriptive name for this task'),
        field('Status', statusSel, lockedApproved ? 'Only Producer, Director or Manager can change an approved task'
          : (canApprove ? null : 'Your role cannot set tasks to Approved')),
        field('Owner', ownerSel, ownerHint),
        el('.modal-section-title', null, 'Schedule'),
        el('.sched-box', null, [
          el('.sched-grid', null, [field('Start Date', startInput), el('.sched-arrow', null, '→'), field('Due Date', dueInput)]),
          rangePill
        ]),
        el('.fld-hint', null, 'Select the start and due dates for this task')
      ];

      const footer = [
        el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Cancel'),
        el('button.btn-danger', {
          onclick: () => { if (confirm('Remove “' + su.name + '” from ' + ep.code + '?')) { App.removeTask(epId, key); App.modal.close(); } }
        }, '🗑 Remove'),
        el('button.btn-primary', {
          onclick: () => {
            const s = startInput.value, d = dueInput.value;
            if (!nameInput.value.trim()) { App.toast('Task name is required', true); return; }
            if (!(s && d && d >= s)) { App.toast('Check the dates', true); return; }
            App.applyTaskEdit(epId, key, {
              name: nameInput.value.trim(),
              status: statusSel.disabled ? su.status : statusSel.value,
              start: s, due: d,
              assignee: canAssign ? ownerSel.value : undefined
            });
            App.modal.close();
          }
        }, '💾 Save Changes')
      ];

      App.modal.open(card('✎', 'Edit Task', 'Update task details and schedule', sections, footer));
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
    let depMenu = null;
    const closeDepMenu = () => { if (depMenu) { depMenu.remove(); depMenu = null; document.removeEventListener('click', closeDepMenu); } };

    const pipeCount = el('span.count-badge');
    const pipeList = el('.pipe-list');

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
          onclick: (e) => { e.stopPropagation(); t.deps.push(p.key); closeDepMenu(); renderPipe(); onChange(); }
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
      type: 'number', value: String(t[prop]), min: String(min), max: '365',
      onchange: (e) => { t[prop] = Math.max(min, Math.min(365, parseInt(e.target.value) || min)); e.target.value = t[prop]; onChange(); }
    });

    const moveBtns = (i, extraCls) => el('.pipe-move' + (extraCls || ''), null, [
      el('button.btn-move', { type: 'button', disabled: i === 0, title: tip('Move up'),
        onclick: (e) => { e.stopPropagation(); [pipe[i - 1], pipe[i]] = [pipe[i], pipe[i - 1]]; renderPipe(); } }, '▲'),
      el('button.btn-move', { type: 'button', disabled: i === pipe.length - 1, title: tip('Move down'),
        onclick: (e) => { e.stopPropagation(); [pipe[i], pipe[i + 1]] = [pipe[i + 1], pipe[i]]; renderPipe(); } }, '▼')
    ]);

    function compactRow(t, i) {
      const dep = App.dept(t.dept);
      const depNames = t.deps.map(dk => { const d = pipe.find(p => p.key === dk); return d ? d.name : dk; });
      return el('.pipe-row.compact', {
        title: tip('Click to edit'),
        onclick: () => { editingKey = t.key; renderPipe(); }
      }, [
        el('span.pipe-num', null, i + 1),
        el('span.pipe-dot', { style: { background: dep.color }, title: tip(dep.label) }),
        el('span.pipe-name-ro', null, t.name || '—'),
        el('span.pipe-deps-sum', { title: tip(depNames.join(', ')) }, depNames.length ? '◷ ' + depNames.join(', ') : ''),
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
              onclick: () => { t.deps = t.deps.filter(k => k !== dk); renderPipe(); onChange(); }
            }, '✕')
          ]);
        }),
        el('button.dep-add', {
          type: 'button', title: tip('Add dependency'),
          onclick: (e) => { e.stopPropagation(); openDepMenu(e.currentTarget, t); }
        }, '＋')
      ]);

      return el('.pipe-row.editing', null, [
        el('span.pipe-num', null, i + 1),
        moveBtns(i),
        el('input.fld.fld-name', { type: 'text', value: t.name, placeholder: 'Task name',
          oninput: (e) => { t.name = e.target.value; } }),
        deptSel,
        el('.pipe-days', null, [el('span.pipe-days-lbl', null, 'days'), numFld(t, 'days', 1)]),
        el('.pipe-days', null, [el('span.pipe-days-lbl', null, 'min'), numFld(t, 'minDays', 1)]),
        depsBox,
        el('button.btn-done', {
          type: 'button', title: tip('Done editing'),
          onclick: () => { editingKey = null; renderPipe(); }
        }, '✓'),
        el('button.btn-row-x', {
          type: 'button', title: tip('Remove task'),
          onclick: () => {
            pipe.splice(i, 1);
            pipe.forEach(p => { p.deps = p.deps.filter(k => k !== t.key); });
            editingKey = null;
            renderPipe(); onChange();
          }
        }, '🗑')
      ]);
    }

    function renderPipe() {
      closeDepMenu();
      pipeCount.textContent = pipe.length;
      pipeList.innerHTML = '';
      pipe.forEach((t, i) => pipeList.appendChild(t.key === editingKey ? editRow(t, i) : compactRow(t, i)));
    }

    function addTask() {
      const key = 'task_' + App.uid().slice(0, 6);
      pipe.push({ key, name: 'New Task', dept: 'creative', days: 5, minDays: 2, deps: [] });
      editingKey = key;
      renderPipe(); onChange();
      pipeList.scrollTop = pipeList.scrollHeight;
      const fld = pipeList.querySelector('.pipe-row.editing .fld-name');
      if (fld) { fld.focus(); fld.select(); }
    }

    renderPipe();
    return {
      list: pipeList, count: pipeCount, addTask, render: renderPipe,
      getPipe: () => pipe,
      setPipe: (p) => { pipe = p; editingKey = null; renderPipe(); },
      closeMenus: closeDepMenu
    };
  };

  // ---- Add Show ----
  // Schedule planner + per-show pipeline editor. The producer supplies a start
  // date; a dependency-aware forward pass (App.schedulePipeline) computes the
  // recommended finish. Picking an earlier/later project end date squeezes or
  // extends every task proportionally — but never below a task's minimum days.
  App.addShow = {
    open() {
      if (!App.canManageShows(App.state.role)) { App.toast('Only Producers can add shows', true); return; }

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
      const countInput = el('input.fld', { type: 'number', value: '3', min: '1', max: '30' });
      const epList = el('.ep-name-list');
      const rebuildEps = () => {
        const n = Math.max(1, Math.min(30, parseInt(countInput.value) || 1));
        const existing = [...epList.querySelectorAll('input')].map(i => i.value);
        epList.innerHTML = '';
        for (let i = 0; i < n; i++) {
          epList.appendChild(el('.ep-name-row', null, [
            el('span.ep-name-num', null, '#' + (i + 1)),
            el('input.fld', { type: 'text', value: existing[i] || ('Episode ' + (i + 1)), placeholder: 'Episode ' + (i + 1) })
          ]));
        }
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
        epCount: Math.max(1, Math.min(30, parseInt(countInput.value) || 1))
      });

      function updateSchedule() {
        const { start, cadence, epCount } = readPlan();
        const rec = App.scheduleShow(pipe, start, epCount, cadence, 1);
        const floor = App.scheduleShow(pipe, start, epCount, cadence, 0);
        recPill.innerHTML = '';
        endFeedback.innerHTML = '';
        if (!rec) {   // dependency cycle — the dep picker prevents this, but belt & braces
          recPill.appendChild(el('span', { style: { color: 'var(--danger)' } }, '⚠ Dependency cycle in the pipeline'));
          return;
        }
        if (!targetTouched) endInput.value = rec.end;
        const target = endInput.value || rec.end;

        const recDays = App.diffDays(rec.end, start) + 1;
        recPill.appendChild(el('span.range-ic', null, '📅'));
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
          endFeedback.textContent = '⛔ Impossible — even with every task at its minimum time the earliest finish is ' +
            App.fmtDate(floor.end) + ', ' + App.parseDate(floor.end).getFullYear() + '. It will be clamped to that.';
        } else if (target < rec.end) {
          const solved = App.solveScale(pipe, start, epCount, cadence, target);
          const giveUp = 100 - Math.round(solved.scale * 100);
          endFeedback.className = 'end-feedback warn';
          endFeedback.textContent = '⚡ Squeezed fairly — every task gives up ' + giveUp +
            '% of its squeezable slack; no task goes below its minimum';
        } else {
          const solved = App.solveScale(pipe, start, epCount, cadence, target);
          endFeedback.className = 'end-feedback ok';
          endFeedback.textContent = '⤢ Extended to ' + Math.round(solved.scale * 100) + '% of nominal — extra breathing room on every task';
        }
      }

      countInput.addEventListener('input', () => { rebuildEps(); updateSchedule(); });
      startInput.addEventListener('change', updateSchedule);
      cadenceInput.addEventListener('change', updateSchedule);
      endInput.addEventListener('change', () => { targetTouched = true; updateSchedule(); });

      // ---------- pipeline editor (shared component) ----------
      const addTaskBtn = el('button.btn-icon', {
        type: 'button',
        onclick: (e) => {
          e.stopPropagation();                      // lives inside the collapse toggle row
          editor.addTask();
        }
      }, '＋');

      // pipeline customisation is tucked behind a collapsed toggle by default
      let pipeOpen = false;
      const pipeChev = el('span.chev', null, '▶');
      const pipeBody = el('.pipe-body', { style: { display: 'none' } }, [
        el('.fld-hint', { style: { margin: '8px 0' } },
          '“days” is the nominal duration, “min” the floor it can be squeezed to. Dependencies gate when a task can start. Click a task to edit it.'),
        editor.list
      ]);
      addTaskBtn.style.display = 'none';
      const pipeToggle = el('.pipe-toggle', {
        onclick: () => {
          pipeOpen = !pipeOpen;
          pipeChev.classList.toggle('open', pipeOpen);
          pipeBody.style.display = pipeOpen ? '' : 'none';
          addTaskBtn.style.display = pipeOpen ? '' : 'none';
        }
      }, [
        pipeChev,
        el('span.pipe-toggle-lbl', null, 'Customize Pipeline Tasks'),
        editor.count,
        addTaskBtn
      ]);

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
        el('.modal-section-title', null, 'Episodes'),
        el('.fld-hint', { style: { marginTop: '-4px', marginBottom: '10px' } }, 'Name each episode — dates are scheduled from the show’s pipeline.'),
        epList,
        pipeToggle,
        pipeBody
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
            const epNames = [...epList.querySelectorAll('input')].map((inp, idx) => inp.value.trim() || ('Episode ' + (idx + 1))).slice(0, epCount);
            const rec = App.scheduleShow(pipe, start, epCount, cadence, 1);
            const target = endInput.value || rec.end;
            const scale = target === rec.end ? 1 : App.solveScale(pipe, start, epCount, cadence, target).scale;
            const pipeline = pipe.map(t => ({ key: t.key, name: t.name.trim() || t.key, dept: t.dept, days: t.days, minDays: t.minDays, deps: t.deps.slice() }));
            App.createShow({ name, code, type: typeSel.value, epNames, pipeline, startIso: start, cadence, scale });
            editor.closeMenus();
            App.modal.close();
          }
        }, '＋ Create Show')
      ];

      App.modal.open(card('🎬', 'Add New Show', 'Plan the schedule and customize the pipeline', sections, footer, 'wide'));
    }
  };
})();
