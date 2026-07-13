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
      wrap.appendChild(v === 'directory' ? directory() : v === 'roles' ? accessControl() : hub());
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
        desc: 'Department states and status colour sequences. Pipelines are currently customised per show when it’s created.',
        btn: 'Coming soon', soon: true },
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

    // live task load per person: active / total assigned
    const load = {};
    App.state.data.episodes.forEach(ep => App.subitems(ep).forEach(su => {
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
