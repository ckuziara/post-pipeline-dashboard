/* Admin page — Producer/Manager only. A settings hub with isolated scopes:
   the hub (module cards), the User Directory (inline-editable roster rows) and
   Access Control (per-role permission toggles, persisted in data.rolePerms /
   data.assignPriv). Sub-navigation lives in App.state.admin. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  App.admin = {
    render() {
      const wrap = el('.admin');
      if (!App.isAdminRole(App.state.role)) {
        wrap.appendChild(el('.empty', null, 'The Admin page is available to Producers and Managers.'));
        return wrap;
      }
      const v = App.state.admin.view;
      wrap.appendChild(v === 'directory' ? directory() : v === 'roles' ? accessControl() : v === 'workflow' ? workflow() : hub());
      return wrap;
    }
  };

  const go = (view) => { App.state.admin.view = view; App.state.admin.editing = null; App.render(); };

  function crumb(current) {
    return el('.adm-crumb', null, [
      el('span.adm-crumb-link', { onclick: () => go('hub') }, 'Admin Hub'),
      el('span', null, '/'),
      el('span.adm-crumb-here', null, current)
    ]);
  }

  function head(title, sub, right) {
    return el('.adm-head', null, [
      el('div', null, [el('.adm-title', null, title), el('.adm-sub', null, sub)]),
      right || null
    ]);
  }

  /* ------------------------------------------------------------- hub ---- */
  function hub() {
    const box = el('div');
    box.appendChild(head('Admin — System Configuration', 'Select a management scope below to configure the tracker.'));
    const n = App.state.data.people.length;
    const cards = [
      { ic: '👥', tint: 'blue', title: 'User Directory & Teams', primary: true,
        desc: 'Manage the team roster, assign pipeline roles and check each member’s live task load. Currently ' + n + ' team member' + (n === 1 ? '' : 's') + '.',
        btn: 'Manage Users', onclick: () => go('directory') },
      { ic: '🔑', tint: 'purple', title: 'Access Control & Privileges',
        desc: 'Configure what each role can do — approving tasks, assigning owners, managing shows and admin access.',
        btn: 'Configure Roles', onclick: () => go('roles') },
      { ic: '🗂', tint: 'green', title: 'Workflow & Status Settings',
        desc: 'Rename and recolour task statuses and departments across the whole tracker. Pipelines themselves are customised per show when it’s created.',
        btn: 'Configure Workflow', onclick: () => go('workflow') },
      { ic: '📜', tint: 'amber', title: 'Audit & Event Logs',
        desc: 'A timestamped record of every change made across the tracker, for project auditing.',
        btn: 'Coming soon', soon: true }
    ];
    const grid = el('.adm-cards');
    cards.forEach(c => {
      grid.appendChild(el('.adm-card' + (c.primary ? '.primary' : ''), null, [
        el('.adm-card-top', null, [
          el('span.adm-card-ic.' + c.tint, null, c.ic),
          el('span.adm-card-title', null, c.title)
        ]),
        el('.adm-card-desc', null, c.desc),
        el('button.adm-btn' + (c.primary ? '.primary' : '') + (c.soon ? '.soon' : ''),
          { onclick: c.soon ? () => App.toast('Coming soon') : c.onclick }, c.btn)
      ]));
    });
    box.appendChild(grid);
    return box;
  }

  /* ------------------------------------------------------- directory ---- */
  function directory() {
    const box = el('div');
    box.appendChild(crumb('User Directory'));
    box.appendChild(head('Directory — All Users', 'Click a row to edit a member’s name and pipeline role inline.'));

    // search (kept in admin state so it survives re-renders; rows rebuilt
    // locally on input so the field never loses focus)
    const search = el('input.adm-search', { type: 'text', placeholder: '🔍  Search team members…', value: App.state.admin.q });
    box.appendChild(search);

    // live task load per person: active / total assigned (archived excluded)
    const load = {};
    App.activeEpisodes().forEach(ep => App.subitems(ep).forEach(su => {
      if (!su.assignee) return;
      const l = load[su.assignee] = load[su.assignee] || { active: 0, total: 0 };
      l.total++;
      if (['ready', 'in_progress', 'review'].includes(su.status)) l.active++;
    }));

    const panel = el('.adm-table');
    panel.appendChild(el('.adm-thead', null, [
      el('.cell', null, 'User'), el('.cell', null, 'Department'),
      el('.cell', null, 'Integrations'), el('.cell', null, 'Live tasks'), el('.cell', null, '')
    ]));
    const body = el('.adm-tbody');
    panel.appendChild(body);

    const buildRows = () => {
      body.innerHTML = '';
      const q = App.state.admin.q.toLowerCase();
      const people = App.state.data.people.filter(p =>
        !q || p.name.toLowerCase().includes(q) || App.role(p.role).label.toLowerCase().includes(q));
      if (!people.length) body.appendChild(el('.adm-empty', null, 'No team members match the search.'));
      people.forEach(p => body.appendChild(userRow(p, load[p.id] || { active: 0, total: 0 })));
    };
    search.addEventListener('input', () => { App.state.admin.q = search.value; buildRows(); });
    buildRows();
    box.appendChild(panel);

    // add a member
    const nameInput = el('input.fld', { type: 'text', placeholder: 'New team member name', style: { maxWidth: '220px' } });
    const emailInput = el('input.fld', { type: 'email', placeholder: 'Work email', style: { maxWidth: '220px' } });
    let newRole = 'creative';
    box.appendChild(el('.adm-add', null, [
      el('.modal-section-title', { style: { marginBottom: '8px' } }, 'Add a team member'),
      el('.fld-hint', { style: { margin: '-4px 0 10px' } }, 'A Sign-in with SSO invite will be sent to this address once that’s wired up.'),
      el('.admin-add-row', null, [
        nameInput, emailInput, roleSelect(newRole, v => { newRole = v; }),
        el('button.btn-primary', {
          onclick: () => {
            if (!nameInput.value.trim()) { App.toast('Enter a name', true); return; }
            if (!emailInput.value.trim()) { App.toast('Enter a work email', true); return; }
            App.addPerson(nameInput.value.trim(), newRole, emailInput.value.trim());
          }
        }, '＋ Add member')
      ])
    ]));
    return box;
  }

  // grey silhouette by default; brand colour on hover (and once "connected").
  // Toggling is just a placeholder until real OAuth/SSO linking exists.
  const INTEGRATIONS = [
    { key: 'slack', label: 'Slack', color: '#e01e5a',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523 2.528 2.528 0 0 1-2.522-2.523 2.528 2.528 0 0 1 2.522-2.52h2.52v2.52zm1.261 0a2.528 2.528 0 0 1 2.52-2.52h5.043a2.528 2.528 0 0 1 2.522 2.52v5.042a2.528 2.528 0 0 1-2.522 2.52H8.823a2.528 2.528 0 0 1-2.52-2.52v-5.042zM8.823 5.043a2.528 2.528 0 0 1-2.52-2.52A2.528 2.528 0 0 1 8.823 0a2.528 2.528 0 0 1 2.52 2.522v2.521h-2.52zm0 1.261a2.528 2.528 0 0 1 2.52 2.52v5.043a2.528 2.528 0 0 1-2.52 2.522H3.78a2.528 2.528 0 0 1-2.52-2.522V8.824a2.528 2.528 0 0 1 2.52-2.52h5.043zm10.135 3.761a2.528 2.528 0 0 1 2.522-2.52 2.528 2.528 0 0 1 2.52 2.52 2.528 2.528 0 0 1-2.52 2.522h-2.522v-2.522zm-1.262 0a2.528 2.528 0 0 1-2.52 2.52h-5.043a2.528 2.528 0 0 1-2.522-2.52V3.78a2.528 2.528 0 0 1 2.522-2.52h5.043a2.528 2.528 0 0 1 2.52 2.52v5.043zm-3.781 10.133a2.528 2.528 0 0 1 2.52 2.522c0 1.393-1.13 2.521-2.52 2.521a2.528 2.528 0 0 1-2.522-2.521v-2.522h2.522zm0-1.262a2.528 2.528 0 0 1-2.522-2.52v-5.043a2.528 2.528 0 0 1 2.522-2.52h5.043a2.528 2.528 0 0 1 2.52 2.52v5.043a2.528 2.528 0 0 1-2.52 2.52h-5.043z"/></svg>' },
    { key: 'gmail', label: 'Gmail', color: '#ea4335',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 5.5v13a1.5 1.5 0 0 1-1.5 1.5H19V8.3l-7 5.15L5 8.3V20H3.5A1.5 1.5 0 0 1 2 18.5v-13A1.5 1.5 0 0 1 3.5 4h.6L12 9.9 19.9 4h.6A1.5 1.5 0 0 1 22 5.5z"/></svg>' }
  ];

  function integrationsCell(p, editing) {
    const box = el('.integ-icons');
    INTEGRATIONS.forEach(i => {
      const on = !!(p.integrations && p.integrations[i.key]);
      const status = on ? i.label + ' connected' : i.label + ' not connected';
      box.appendChild(el('span.integ-ic.' + i.key + (on ? '.on' : '') + (editing ? '.editable' : ''), {
        html: i.svg,
        title: editing ? status + ' — click to toggle' : status,
        onclick: editing ? (e) => { e.stopPropagation(); App.toggleIntegration(p.id, i.key); } : null
      }));
    });
    return box;
  }

  function userRow(p, load) {
    const editing = App.state.admin.editing === p.id;
    const dept = App.roleDept(p.role);
    const pct = load.total ? Math.round(100 * load.active / load.total) : 0;

    const row = el('.adm-row' + (editing ? '.editing' : ''), {
      onclick: () => { if (!editing) { App.state.admin.editing = p.id; App.render(); } }
    }, [
      el('.cell.u', null, [
        el('span.avatar', { style: { background: p.color } }, App.initials(p.name)),
        editing
          ? el('div.adm-edit-stack', null, [
              el('input.adm-inline', {
                type: 'text', value: p.name,
                onclick: e => e.stopPropagation(),
                onchange: e => App.renamePerson(p.id, e.target.value)
              }),
              el('input.adm-inline.adm-inline-sm', {
                type: 'email', value: p.email || '', placeholder: 'Work email',
                onclick: e => e.stopPropagation(),
                onchange: e => App.setPersonEmail(p.id, e.target.value)
              })
            ])
          : el('div', null, [
              el('.adm-name', null, p.name),
              el('.adm-name-sub', null, p.email || App.role(p.role).hint)
            ])
      ]),
      el('.cell', null, editing
        ? (() => { const s = roleSelect(p.role, v => App.setPersonRole(p.id, v)); s.addEventListener('click', e => e.stopPropagation()); return s; })()
        : dept
          ? el('span.dept-chip', null, [el('span.dot', { style: { background: App.dept(dept).color } }), App.dept(dept).label])
          : el('span.adm-role-chip', null, App.role(p.role).label + ' · oversight')),
      el('.cell', null, integrationsCell(p, editing)),
      el('.cell', null, el('.adm-load', { title: load.total ? load.active + ' active of ' + load.total + ' assigned task' + (load.total === 1 ? '' : 's') : 'No assigned tasks' }, [
        el('span.adm-load-num', null, load.active + '/' + load.total),
        el('.adm-load-track', null, el('.adm-load-fill', { style: { width: pct + '%' } }))
      ])),
      el('.cell.adm-actions', null, editing
        ? [el('button.btn-mini', { onclick: e => { e.stopPropagation(); App.state.admin.editing = null; App.render(); }, title: 'Done editing' }, '✓'),
           el('button.btn-mini.danger', { onclick: e => { e.stopPropagation(); App.removePerson(p.id); }, title: 'Remove user' }, '✕')]
        : el('span.adm-edit-hint', null, '✎'))
    ]);
    return row;
  }

  /* --------------------------------------------------- access control ---- */
  // Each item reads/writes real capability state: assignPriv for owner
  // assignment, rolePerms overrides (with ROLES defaults) for everything else.
  const PERMS = [
    { title: 'Task Management', desc: 'How this role interacts with tasks and assignments.', items: [
      { title: 'Assign Task Owners', desc: 'Can set or change a task’s owner from the Edit Task dialog.',
        get: k => App.canAssignOwners(k), set: (k, v) => App.setAssignPriv(k, v) },
      { title: 'Approve Tasks', desc: 'Can move tasks to Approved, and change tasks that are already approved.',
        get: k => App.canApprove(k), set: (k, v) => App.setRolePerm(k, 'approve', v, 'Approve Tasks') }
    ]},
    { title: 'Pipeline Oversight', desc: 'High-level access to shows and scheduling.', items: [
      { title: 'Manage Shows', danger: true, desc: 'Can create new shows — and permanently remove a show together with all of its episodes.',
        get: k => App.canManageShows(k), set: (k, v) => App.setRolePerm(k, 'manageShows', v, 'Manage Shows') }
    ]},
    { title: 'System Administration', desc: 'Access to this admin area and the team roster.', items: [
      { title: 'Admin Access', desc: 'Can open the Admin page: manage users, privileges and system settings.',
        get: k => App.isAdminRole(k), set: (k, v) => App.setRolePerm(k, 'admin', v, 'Admin Access') }
    ]}
  ];

  function accessControl() {
    const box = el('div');
    box.appendChild(crumb('Access Control'));
    box.appendChild(head('Role Permissions', 'Select a role to configure its capabilities. Changes apply immediately.'));

    const roleKey = App.state.admin.role;
    const locked = roleKey === 'producer';
    const layout = el('.adm-split');

    const side = el('.adm-side');
    side.appendChild(el('.adm-side-label', null, 'Pipeline roles'));
    App.ROLES.forEach(r => {
      side.appendChild(el('button.adm-role' + (roleKey === r.key ? '.active' : ''), {
        onclick: () => { App.state.admin.role = r.key; App.render(); }
      }, [el('span.adm-role-ic', null, r.icon), r.label]));
    });

    const panel = el('.adm-perms');
    if (locked) panel.appendChild(el('.adm-note', null, '🔒 The Producer role always keeps full access, so nobody can be locked out.'));
    PERMS.forEach(cat => {
      const card = el('.adm-permcard');
      card.appendChild(el('.adm-permcard-head', null, [
        el('.adm-permcard-title', null, cat.title),
        el('.adm-permcard-desc', null, cat.desc)
      ]));
      cat.items.forEach(item => {
        const on = item.get(roleKey);
        card.appendChild(el('.adm-permrow' + (locked ? '.locked' : ''), {
          onclick: locked ? null : () => item.set(roleKey, !on)
        }, [
          el('div', null, [
            el('.adm-perm-title' + (item.danger && on ? '.danger' : ''), null, item.title),
            el('.adm-perm-desc', null, item.desc)
          ]),
          el('span.switch' + (on ? '.on' : '') + (item.danger ? '.danger' : ''), null, el('span.knob'))
        ]));
      });
      panel.appendChild(card);
    });

    layout.appendChild(side);
    layout.appendChild(panel);
    box.appendChild(layout);
    return box;
  }

  /* --------------------------------------------------- workflow & status ---- */
  // A colour-swatch input + live-editable name row, shared by the statuses and
  // departments lists. `preview` is the chip shown as it will actually appear.
  function styleRow(opts) {
    // opts: { color, label, preview, onColor, onLabel, onRemove }
    const swatch = el('label.wf-swatch', { title: 'Pick a colour', style: { background: opts.color } });
    const picker = el('input', { type: 'color', value: opts.color });
    picker.addEventListener('input', () => { swatch.style.background = picker.value; });
    picker.addEventListener('change', () => opts.onColor(picker.value));
    swatch.appendChild(picker);

    const name = el('input.wf-name', { type: 'text', value: opts.label });
    name.addEventListener('change', () => opts.onLabel(name.value));
    name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); });

    return el('.wf-row', null, [
      swatch,
      name,
      opts.preview || el('span'),
      opts.onRemove
        ? el('button.btn-mini.danger', { onclick: opts.onRemove, title: 'Remove department' }, '✕')
        : el('span.wf-lock', { title: 'Built-in — colour & name only' }, '')
    ]);
  }

  function workflow() {
    const box = el('div');
    box.appendChild(crumb('Workflow & Status'));
    const tab = App.state.admin.wfTab || 'statuses';
    box.appendChild(head('Workflow & Status Settings',
      'Statuses, departments and reusable pipelines. Changes apply across the whole tracker for everyone.',
      (tab === 'statuses' || tab === 'departments') ? el('button.ghost', { onclick: () => App.resetWorkflow() }, '↺ Reset colours & names') : null));

    const layout = el('.adm-split');
    const side = el('.adm-side');
    side.appendChild(el('.adm-side-label', null, 'Workflow'));
    [['statuses', '🎨', 'Task statuses'], ['departments', '🏷️', 'Departments'], ['pipelines', '🧬', 'Pipelines'], ['shows', '📚', 'Shows']].forEach(([k, ic, lbl]) => {
      side.appendChild(el('button.adm-role' + (tab === k ? '.active' : ''), {
        onclick: () => { App.state.admin.wfTab = k; App.render(); }
      }, [el('span.adm-role-ic', null, ic), lbl]));
    });

    // the pipeline editor's rows need real width for their columns (name,
    // dept, days, min, deps) — the 640px cap that suits the toggle-style
    // statuses/departments lists would clip its controls
    const panel = el('.adm-perms' + (tab === 'pipelines' ? '.wide' : ''));
    panel.appendChild(
      tab === 'departments' ? departmentsCard()
      : tab === 'pipelines' ? pipelinesPanel()
      : tab === 'shows' ? showsPanel()
      : statusesCard());

    layout.appendChild(side);
    layout.appendChild(panel);
    box.appendChild(layout);
    return box;
  }

  function statusesCard() {
    const stCard = el('.adm-permcard');
    stCard.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, 'Task statuses'),
      el('.adm-permcard-desc', null, 'The label set every task moves through. Order and meaning are fixed; colour and name are yours.')
    ]));
    const stBody = el('.wf-list');
    App.STATUS_ORDER.forEach(k => {
      const s = App.STATUSES[k];
      const chip = el('span.status-cell.wf-preview', { style: { background: s.color, color: s.ink } }, s.label);
      stBody.appendChild(styleRow({
        color: s.color, label: s.label, preview: chip,
        onColor: v => App.setStatusStyle(k, { color: v }),
        onLabel: v => App.setStatusStyle(k, { label: v })
      }));
    });
    stCard.appendChild(stBody);
    return stCard;
  }

  function departmentsCard() {
    const dpCard = el('.adm-permcard');
    dpCard.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, 'Departments'),
      el('.adm-permcard-desc', null, 'Pipeline departments and their colours. Add your own; built-ins can be recoloured and renamed but not removed.')
    ]));
    const dpBody = el('.wf-list');
    Object.keys(App.DEPARTMENTS).forEach(k => {
      const d = App.DEPARTMENTS[k];
      const chip = el('span.dept-chip.wf-preview', null, [el('span.dot', { style: { background: d.color } }), d.label]);
      dpBody.appendChild(styleRow({
        color: d.color, label: d.label, preview: chip,
        onColor: v => App.setDeptStyle(k, { color: v }),
        onLabel: v => App.setDeptStyle(k, { label: v }),
        onRemove: App.isDefaultDept(k) ? null : () => App.removeDept(k)
      }));
    });
    dpCard.appendChild(dpBody);

    const nameInput = el('input.fld', { type: 'text', placeholder: 'New department name', style: { maxWidth: '260px' } });
    const add = () => { if (nameInput.value.trim()) { App.addDept(nameInput.value.trim()); } else App.toast('Enter a department name', true); };
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    dpCard.appendChild(el('.wf-add', null, [
      nameInput,
      el('button.btn-primary', { onclick: add }, '＋ Add department')
    ]));
    return dpCard;
  }

  /* ---- Pipelines: named presets a Producer/Manager can build once and pick
     from in Add Show. The draft being edited lives on App.state.admin so a
     background re-render (teammate sync) never wipes in-progress work. ---- */
  function pipelinesPanel() {
    const draft = App.state.admin.presetDraft;
    if (draft) return presetEditor(draft);

    const cardEl = el('.adm-permcard');
    cardEl.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, 'Pipeline presets'),
      el('.adm-permcard-desc', null, 'Reusable task pipelines for Animation or Live Action shows. When adding a show, pick a preset instead of the standard pipeline.')
    ]));

    const presets = App.state.data.pipelinePresets || [];
    const list = el('.wf-list');
    if (!presets.length) list.appendChild(el('.adm-empty', null, 'No presets yet — create one below, starting from a standard pipeline.'));
    presets.forEach(p => {
      list.appendChild(el('.preset-row', null, [
        el('span.preset-type.' + p.type, null, p.type === 'live_action' ? 'Live Action' : 'Animation'),
        el('div', { style: { minWidth: 0 } }, [
          el('.adm-name', null, p.name),
          el('.adm-name-sub', null, p.pipeline.length + ' tasks · ' +
            [...new Set(p.pipeline.map(t => t.dept))].map(d => App.dept(d).label).join(', '))
        ]),
        el('.preset-actions', null, [
          el('button.btn-mini', { title: 'Edit preset',
            onclick: () => { App.state.admin.presetDraft = JSON.parse(JSON.stringify(p)); App.render(); } }, '✎'),
          el('button.btn-mini', { title: 'Duplicate preset', onclick: () => App.duplicatePipelinePreset(p.id) }, '⧉'),
          el('button.btn-mini.danger', { title: 'Delete preset', onclick: () => App.deletePipelinePreset(p.id) }, '✕')
        ])
      ]));
    });
    cardEl.appendChild(list);

    // create: name + base type → opens the editor seeded with that default
    const nameInput = el('input.fld', { type: 'text', placeholder: 'New pipeline name (e.g. “Blippi 2-week turnaround”)', style: { flex: '1', minWidth: '180px' } });
    const typeSel = el('select.fld', { style: { maxWidth: '150px' } });
    [['animation', 'Animation'], ['live_action', 'Live Action']].forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l; typeSel.appendChild(o);
    });
    const create = () => {
      if (!nameInput.value.trim()) { App.toast('Give the pipeline a name', true); return; }
      App.state.admin.presetDraft = {
        id: null, name: nameInput.value.trim(), type: typeSel.value,
        pipeline: App.defaultPipelineFor(typeSel.value)
      };
      App.render();
    };
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') create(); });
    cardEl.appendChild(el('.wf-add', null, [nameInput, typeSel, el('button.btn-primary', { onclick: create }, '＋ New pipeline')]));
    return cardEl;
  }

  function presetEditor(draft) {
    const wrap = el('div');
    const editor = App.pipelineEditor(draft.pipeline, {});

    const nameInput = el('input.wf-name', { type: 'text', value: draft.name, placeholder: 'Pipeline name', style: { maxWidth: '280px' } });
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; });
    const typeSel = el('select.fld', { style: { maxWidth: '150px' }, onchange: () => { draft.type = typeSel.value; } });
    [['animation', 'Animation'], ['live_action', 'Live Action']].forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l;
      if (v === draft.type) o.selected = true; typeSel.appendChild(o);
    });

    const cardEl = el('.adm-permcard');
    cardEl.appendChild(el('.adm-permcard-head.preset-edit-head', null, [
      el('div', null, [
        el('.adm-permcard-title', null, draft.id ? 'Edit pipeline' : 'New pipeline'),
        el('.adm-permcard-desc', null, 'Add, remove, reorder and re-time tasks; set dependencies. Shows made from this preset take their own copy.')
      ]),
      el('.preset-edit-flds', null, [nameInput, typeSel])
    ]));

    cardEl.appendChild(el('.preset-pipe-bar', null, [
      el('span.pipe-toggle-lbl', null, 'Pipeline tasks'),
      editor.count,
      el('button.btn-icon', { type: 'button', title: 'Add task', onclick: () => editor.addTask() }, '＋')
    ]));
    cardEl.appendChild(el('.preset-pipe-body', null, editor.list));

    cardEl.appendChild(el('.wf-add', { style: { justifyContent: 'flex-end' } }, [
      el('button.btn-ghost', {
        onclick: () => { editor.closeMenus(); App.state.admin.presetDraft = null; App.render(); }
      }, 'Cancel'),
      el('button.btn-primary', {
        onclick: () => {
          editor.closeMenus();
          if (App.savePipelinePreset(draft)) { App.state.admin.presetDraft = null; App.render(); }
        }
      }, '💾 Save pipeline')
    ]));
    wrap.appendChild(cardEl);
    return wrap;
  }

  /* ------------------------------------------------- shows & archive ---- */
  // Active shows with their episodes nested beneath; archive a whole show or
  // a single episode. The Archive card below holds everything archived, where
  // content can be restored — or permanently deleted.
  function showsPanel() {
    const wrapP = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });
    const shows = App.state.data.shows;
    const eps = App.state.data.episodes;

    // ---- active ----
    const act = el('.adm-permcard');
    act.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, 'Active shows'),
      el('.adm-permcard-desc', null, 'Archiving hides a show or episode from every view without losing any of its data.')
    ]));
    const actList = el('.wf-list');
    const activeShows = shows.filter(s => !s.archived);
    if (!activeShows.length) actList.appendChild(el('.adm-empty', null, 'No active shows.'));
    // shows collapse to a single line by default; expansion state lives on
    // admin state so it survives re-renders (archive clicks, teammate sync)
    const open = App.state.admin.showsOpen = App.state.admin.showsOpen || {};
    activeShows.forEach(s => {
      const sEps = eps.filter(e => e.showId === s.id && !e.archived);
      const isOpen = !!open[s.id];
      actList.appendChild(el('.show-arch-row.expandable', {
        onclick: () => { open[s.id] = !isOpen; App.render(); }
      }, [
        el('span.chev' + (isOpen ? '.open' : ''), null, '▶'),
        el('span.show-arch-dot', { style: { background: s.color } }),
        el('div', { style: { minWidth: 0 } }, [
          el('.adm-name', null, s.name),
          el('.adm-name-sub', null, (s.prefix || '—') + ' · ' + sEps.length + ' active episode' + (sEps.length === 1 ? '' : 's'))
        ]),
        el('.arch-actions', null,
          el('button.btn-mini', { onclick: (e) => { e.stopPropagation(); App.setShowArchived(s.id, true); } }, '🗄 Archive show'))
      ]));
      if (isOpen) sEps.forEach(ep => {
        actList.appendChild(el('.ep-arch-row', null, [
          el('span.ep-arch-code', { style: { background: s.color, color: App.pickInkFor(s.color) } }, ep.code),
          el('span.ep-arch-title', null, ep.title),
          el('span.ep-arch-dates', null, App.fmtRange(App.epStart(ep), App.epDue(ep))),
          el('.arch-actions', null,
            el('button.btn-mini', { onclick: () => App.setEpisodeArchived(ep.id, true) }, '🗄'))
        ]));
      });
    });
    act.appendChild(actList);
    wrapP.appendChild(act);

    // ---- archive ----
    const arch = el('.adm-permcard');
    arch.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, '🗄 Archive'),
      el('.adm-permcard-desc', null, 'Restore brings content back exactly as it was. Deleting is permanent and can’t be undone.')
    ]));
    const archList = el('.wf-list');
    const archShows = shows.filter(s => s.archived);
    // episodes archived on their own (their show is still active)
    const archEps = eps.filter(e => e.archived && !(shows.find(x => x.id === e.showId) || {}).archived);
    if (!archShows.length && !archEps.length) archList.appendChild(el('.adm-empty', null, 'Nothing is archived.'));
    archShows.forEach(s => {
      const n = eps.filter(e => e.showId === s.id).length;
      archList.appendChild(el('.show-arch-row.archived', null, [
        el('span.show-arch-dot', { style: { background: s.color } }),
        el('div', { style: { minWidth: 0 } }, [
          el('.adm-name', null, s.name),
          el('.adm-name-sub', null, 'Whole show · ' + n + ' episode' + (n === 1 ? '' : 's') + ' inside')
        ]),
        el('.arch-actions', null, [
          el('button.btn-mini', { onclick: () => App.setShowArchived(s.id, false) }, '↩ Restore'),
          el('button.btn-mini.danger', { onclick: () => App.deleteShow(s.id) }, '✕ Delete')
        ])
      ]));
    });
    archEps.forEach(ep => {
      const s = App.show(ep.showId);
      archList.appendChild(el('.show-arch-row.archived', null, [
        el('span.ep-arch-code', { style: { background: s.color, color: App.pickInkFor(s.color) } }, ep.code),
        el('div', { style: { minWidth: 0 } }, [
          el('.adm-name', null, ep.title),
          el('.adm-name-sub', null, s.name)
        ]),
        el('.arch-actions', null, [
          el('button.btn-mini', { onclick: () => App.setEpisodeArchived(ep.id, false) }, '↩ Restore'),
          el('button.btn-mini.danger', { onclick: () => App.deleteEpisode(ep.id) }, '✕ Delete')
        ])
      ]));
    });
    arch.appendChild(archList);
    wrapP.appendChild(arch);
    return wrapP;
  }

  /* ------------------------------------------------------------ helpers */
  function roleSelect(value, onChange) {
    const sel = el('select.filter');
    App.ROLES.forEach(r => {
      const o = document.createElement('option'); o.value = r.key; o.textContent = r.label;
      if (r.key === value) o.selected = true; sel.appendChild(o);
    });
    sel.addEventListener('change', e => onChange(e.target.value));
    return sel;
  }
})();
