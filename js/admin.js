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
      wrap.appendChild(v === 'directory' ? directory() : v === 'roles' ? accessControl()
        : v === 'workflow' ? workflow() : v === 'logs' ? logs() : hub());
      return wrap;
    }
  };

  const go = (view) => {
    // provisioning has no modal to close, so navigating away is its abandonment
    App.track && App.track.abandonOpenFlows && App.track.abandonOpenFlows();
    App.state.admin.view = view; App.state.admin.editing = null; App.render();
  };

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
      { ic: 'users', tint: 'blue', title: 'User Directory & Teams', primary: true,
        desc: 'Manage the team roster, assign pipeline roles and check each member’s live task load. Currently ' + n + ' team member' + (n === 1 ? '' : 's') + '.',
        btn: 'Manage Users', onclick: () => go('directory') },
      { ic: 'key', tint: 'purple', title: 'Access Control & Privileges',
        desc: 'Configure what each role can do — approving tasks, assigning owners, managing shows and admin access.',
        btn: 'Configure Roles', onclick: () => go('roles') },
      { ic: 'folderOpen', tint: 'green', title: 'Workflow & Status Settings',
        desc: 'Rename and recolour task statuses and departments across the whole tracker. Pipelines themselves are customised per show when it’s created.',
        btn: 'Configure Workflow', onclick: () => go('workflow') },
      { ic: 'scroll', tint: 'amber', title: 'Audit & Event Logs',
        desc: 'A timestamped record of every change made across the tracker, plus which features each role actually uses.',
        btn: 'View Logs', onclick: () => go('logs') }
    ];
    const grid = el('.adm-cards');
    cards.forEach(c => {
      grid.appendChild(el('.adm-card' + (c.primary ? '.primary' : ''), null, [
        el('.adm-card-top', null, [
          App.icon(c.ic, { cls: 'adm-card-ic ' + c.tint }),
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
    const search = el('input.adm-search', { type: 'text', placeholder: 'Search team members…', value: App.state.admin.q });
    box.appendChild(search);

    // live task load per person: active / total assigned (archived excluded)
    const load = {};
    App.activeEpisodes().forEach(ep => App.subitems(ep).forEach(su => {
      if (!su.assignee) return;
      const l = load[su.assignee] = load[su.assignee] || { active: 0, total: 0 };
      l.total++;
      if (['ready', 'in_progress', 'review'].includes(su.status)) l.active++;
    }));

    const showInteg = App.memberConnectors().length > 0;   // drop the column when no per-member connectors are on
    const panel = el('.adm-table' + (showInteg ? '' : '.no-integ'));
    panel.appendChild(el('.adm-thead', null, [
      el('.cell', null, 'User'), el('.cell', null, 'Department'),
      (showInteg ? el('.cell', null, 'Integrations') : null),
      el('.cell', null, 'Live tasks'), el('.cell', null, '')
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
    // provisioning has no modal, so the flow starts at first keystroke and is
    // abandoned if they navigate away from the directory without adding anyone
    nameInput.addEventListener('input', () => {
      if (nameInput.value.trim()) App.track.flowStart('User provisioning');
    }, { once: true });
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
            App.track.flowDone('User provisioning', true);
          }
        }, '＋ Add member')
      ])
    ]));
    return box;
  }

  // Only enabled connectors (Workflow Settings → Connectors) render — grey
  // silhouette by default, brand colour on hover / once "connected". Toggling
  // a member's flag is a placeholder until real OAuth/SSO linking exists.
  function integrationsCell(p, editing) {
    const box = el('.integ-icons');
    App.memberConnectors().forEach(i => {
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
      (App.memberConnectors().length ? el('.cell', null, integrationsCell(p, editing)) : null),
      el('.cell', null, el('.adm-load', { title: load.total ? load.active + ' active of ' + load.total + ' assigned task' + (load.total === 1 ? '' : 's') : 'No assigned tasks' }, [
        el('span.adm-load-num', null, load.active + '/' + load.total),
        el('.adm-load-track', null, el('.adm-load-fill', { style: { width: pct + '%' } }))
      ])),
      el('.cell.adm-actions', null, editing
        ? [el('button.btn-mini', { onclick: e => { e.stopPropagation(); App.state.admin.editing = null; App.render(); }, title: 'Done editing' }, '✓'),
           el('button.btn-mini.danger', { onclick: e => { e.stopPropagation(); App.removePerson(p.id); }, title: 'Remove user' }, '✕')]
        : App.icon('pencil', { cls: 'adm-edit-hint' }))
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
        get: k => App.canApprove(k), set: (k, v) => App.setRolePerm(k, 'approve', v, 'Approve Tasks') },
      { title: 'Rename Tasks', desc: 'Can change a task’s name from the Edit Task dialog.',
        get: k => App.canEditTaskName(k), set: (k, v) => App.setRolePerm(k, 'editName', v, 'Rename Tasks') },
      { title: 'Remove Tasks', danger: true, desc: 'Can drop a task from an episode’s pipeline.',
        get: k => App.canRemoveTask(k), set: (k, v) => App.setRolePerm(k, 'removeTask', v, 'Remove Tasks') }
    ]},
    { title: 'Pipeline Oversight', desc: 'High-level access to shows and scheduling.', items: [
      { title: 'Change the Schedule', desc: 'Can move task dates — in the Edit Task dialog and by dragging bars on the Timeline — for every department, not just their own.',
        get: k => App.canEditSchedule(k), set: (k, v) => App.setRolePerm(k, 'editSchedule', v, 'Change the Schedule') },
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
    const layout = el('.adm-split');

    const side = el('.adm-side');
    side.appendChild(el('.adm-side-label', null, 'Pipeline roles'));
    App.ROLES.forEach(r => {
      side.appendChild(el('button.adm-role' + (roleKey === r.key ? '.active' : ''), {
        onclick: () => { App.state.admin.role = r.key; App.render(); }
      }, [App.icon(r.ico, { cls: 'adm-role-ic' }), r.label]));
    });

    // Every permission is editable for every role, Producer included — the
    // one thing App.setRolePerm itself refuses is switching off Admin Access
    // on the last role that still holds it, since that's what would actually
    // lock everyone out. That's enforced at the point of the toggle (with its
    // own toast), not by disabling the control here.
    const panel = el('.adm-perms');
    PERMS.forEach(cat => {
      const card = el('.adm-permcard');
      card.appendChild(el('.adm-permcard-head', null, [
        el('.adm-permcard-title', null, cat.title),
        el('.adm-permcard-desc', null, cat.desc)
      ]));
      cat.items.forEach(item => {
        const on = item.get(roleKey);
        card.appendChild(el('.adm-permrow', {
          onclick: () => item.set(roleKey, !on)
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
    [['statuses', 'palette', 'Task statuses'], ['departments', 'tag', 'Departments'], ['pipelines', 'pipeline', 'Pipelines'], ['shows', 'book', 'Shows'], ['storage', 'folderOpen', 'Storage'], ['connectors', 'plug', 'Connectors']].forEach(([k, ic, lbl]) => {
      side.appendChild(el('button.adm-role' + (tab === k ? '.active' : ''), {
        onclick: () => { App.state.admin.wfTab = k; App.render(); }
      }, [App.icon(ic, { cls: 'adm-role-ic' }), lbl]));
    });

    // the pipeline editor's rows need real width for their columns (name,
    // dept, days, min, deps) — the 640px cap that suits the toggle-style
    // statuses/departments lists would clip its controls
    const panel = el('.adm-perms' + (tab === 'pipelines' ? '.wide' : ''));
    panel.appendChild(
      tab === 'departments' ? departmentsCard()
      : tab === 'pipelines' ? pipelinesPanel()
      : tab === 'shows' ? showsPanel()
      : tab === 'storage' ? storageCard()
      : tab === 'connectors' ? connectorsCard()
      : statusesCard());

    layout.appendChild(side);
    layout.appendChild(panel);
    box.appendChild(layout);
    return box;
  }

  /* Storage: the LucidLink master directory new shows are built under. Held in
     shared board state so everyone resolves the same root; the server does the
     actual mkdir and generates every path itself from the show's pipeline. */
  function storageCard() {
    const wrap = el('div');
    const cur = (App.state.data.storage && App.state.data.storage.masterPath) || '';

    const card = el('.adm-permcard');
    card.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, 'Production master directory'),
      el('.adm-permcard-desc', null, 'The LucidLink (or mounted) folder new shows are created under. Adding a show builds its whole structure straight away — shared libraries, production folders, and every episode’s department tree.')
    ]));

    const input = el('input.fld', { type: 'text', value: cur, spellcheck: 'false',
      placeholder: '/Volumes/LucidLink/Productions', style: { flex: '1', minWidth: '260px', fontFamily: 'ui-monospace, monospace' } });
    const save = () => App.setMasterPath(input.value);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });

    card.appendChild(el('.wf-add', null, [
      input,
      // browse the server's filesystem — a browser picker can't return an
      // absolute path, and it's the server that has the LucidLink mount
      el('button.btn-ghost', {
        // only seed the picker from the field when it's already absolute —
        // a relative value would just bounce off the server's fallback
        onclick: () => App.folderPicker.open(/^\//.test(input.value.trim()) ? input.value.trim() : undefined, p => {
          input.value = p;
          App.setMasterPath(p);
        })
      }, [App.icon('folderOpen'), ' Browse…']),
      el('button.btn-primary', { onclick: save }, [App.icon('save'), ' Save']),
      cur ? el('button.btn-ghost', { onclick: () => App.setMasterPath('') }, 'Clear') : null
    ]));
    card.appendChild(
      !cur ? el('.adm-name-sub', { style: { padding: '0 4px 12px' } }, 'Not set — folder creation is off until a path is saved.')
      : cur[0] !== '/' ? el('.fp-error', { style: { padding: '0 4px 12px' } },
          'That’s a relative path, so the server can’t find it. It needs to start with “/” — probably /Volumes/' + cur + '. Use Browse… to pick it.')
      : el('.adm-name-sub', { style: { padding: '0 4px 12px' } }, 'Shows are created at ' + cur + '/<CODE>_<ShowName>/'));
    wrap.appendChild(card);

    // what the generated tree looks like, so the path isn't set blind
    const info = el('.adm-permcard');
    info.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, 'What gets created'),
      el('.adm-permcard-desc', null, 'Generated from each show’s own pipeline, so it always matches the tasks on the board — including custom presets. Kept lean for working storage: tasks that are iterations of one deliverable share a folder (Animatic V1–V3 are versioned files, not three directories), and rearranging for long-term storage is the archival process’s job. About 23 folders per episode.')
    ]));
    info.appendChild(el('pre.storage-tree', null,
      '!!_Templates/              project templates, shared by every show\n' +
      '<CODE>_<ShowName>/\n' +
      '  !!_ShowLibrary/          styleguides, design, music & SFX, GFX, LUTs\n' +
      '  0001_Production/         schedules, scripts, contracts & crew, notes\n' +
      '  0002_Episodes/\n' +
      '    <CODE>-1_<Title>/      every episode, built with the show\n' +
      '      !!_Mezzanine/        delivered, waiting on approval\n' +
      '      !!_Publish/          approved handoffs — what downstream tasks read\n' +
      '      !!_Reviews/          YYMMDD_<Task> review packages\n' +
      '      0001_Creative/       Story · Design · Storyboard · Animatic\n' +
      '      0002_Music/          Skeleton · Vocals · Master\n' +
      '      0003_Animation/      Layout_Blocking · Animation · LRC\n' +
      '      0004_AudioPost/      VO · Wallah · SFX\n' +
      '      0005_VideoPost/      0006_PostOps/      0007_QC/'));
    wrap.appendChild(info);
    return wrap;
  }

  // Connectors: global on/off for each external tool. Disabled → hidden app-wide.
  function connectorsCard() {
    const wrap = el('div');
    const card = el('.adm-permcard');
    card.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, 'Connectors'),
      el('.adm-permcard-desc', null, 'Turn connected tools on or off. A disabled connector is hidden everywhere in the app.')
    ]));
    App.CONNECTORS.forEach(c => {
      const on = App.connectorEnabled(c.key);
      card.appendChild(el('.adm-permrow', { onclick: () => App.setConnector(c.key, !on) }, [
        el('.conn-row-main', null, [
          el('span.conn-ic.' + c.key + (on ? '.on' : ''), { html: c.svg }),
          el('div', null, [
            el('.adm-perm-title', null, c.label),
            el('.adm-perm-desc', null, c.desc)
          ])
        ]),
        el('span.switch' + (on ? '.on' : ''), null, el('span.knob'))
      ]));
    });
    wrap.appendChild(card);
    if (App.connectorEnabled('lucidlink')) wrap.appendChild(lucidConnectionCard());
    // channel mapping is Slack-specific config, same relationship LucidLink's
    // connection card has to its own toggle above — and the same admin gate
    // the server itself enforces on /api/slack/channels, not just the role
    // check that gets you onto this page at all.
    if (App.connectorEnabled('slack') && App.api && App.api.online && App.api.me && App.api.me.admin) {
      wrap.appendChild(slackCard());
    }
    return wrap;
  }

  // LucidLink connection: choose the data source (mock vs live API) and hold
  // the live endpoint / Service Account key. Switching to Live disables the mock.
  function lucidConnectionCard() {
    const cfg = App.lucid.cfg();
    const live = App.lucid.isLive();
    const card = el('.adm-permcard', { style: { marginTop: '16px' } });
    card.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, 'LucidLink connection'),
      el('.adm-permcard-desc', null, 'Phase 1 runs on simulated mock data. Switch to Live once a self-hosted LucidLink REST API + Service Account is available.')
    ]));

    // data source segmented control
    card.appendChild(el('.adm-permrow', { style: { cursor: 'default' } }, [
      el('div', null, [
        el('.adm-perm-title', null, 'Data source'),
        el('.adm-perm-desc', null, live ? 'Live — calls the LucidLink API for every checkout / check-in.' : 'Mock — simulated latency, 10% error rate and a 50 MB/s upload queue.')
      ]),
      el('.prefs-seg', null, [['mock', 'Mock'], ['live', 'Live API']].map(([v, lbl]) =>
        el('button.seg' + (cfg.mode === v || (!cfg.mode && v === 'mock') ? '.active' : ''), {
          onclick: () => App.setLucidConfig({ mode: v })
        }, lbl)))
    ]));

    // live connection fields
    const urlIn = el('input.fld', { type: 'text', value: cfg.apiUrl || '', placeholder: 'https://lucidlink.internal/api', style: { width: '100%' } });
    urlIn.addEventListener('change', () => App.setLucidConfig({ apiUrl: urlIn.value.trim() }));
    const keyIn = el('input.fld', { type: 'password', value: App.lucid._key || '', placeholder: 'Service Account key (kept in memory only)', style: { width: '100%' } });
    keyIn.addEventListener('change', () => App.setLucidConfig({ key: keyIn.value }));
    const conn = el('.wf-add', { style: { flexDirection: 'column', alignItems: 'stretch', gap: '8px', opacity: live ? '1' : '.5', pointerEvents: live ? 'auto' : 'none' } }, [
      el('label.fld-label', null, 'API base URL'), urlIn,
      el('label.fld-label', { style: { marginTop: '4px' } }, 'Service Account key'), keyIn,
      el('.fld-hint', null, live && !App.lucid.real._ready() ? 'Enter the URL and key to activate live calls — until then actions will error.' : 'The key is never written to the shared board; the backend holds the real Service Account.')
    ]);
    card.appendChild(conn);
    return card;
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
            onclick: () => { App.state.admin.presetDraft = JSON.parse(JSON.stringify(p)); App.render(); } }, App.icon('pencil')),
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
      editor.undoBtn,
      editor.redoBtn,
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
      }, [App.icon('save'), ' Save pipeline'])
    ]));
    wrap.appendChild(cardEl);
    return wrap;
  }

  /* ------------------------------------------------- shows & archive ---- */
  // Active shows with their episodes nested beneath; archive a whole show or
  // a single episode. The Archive card below holds everything archived, where
  // content can be restored — or permanently deleted.
  /* ---- whole-board backups ----
     Kept on the server, not downloaded: a snapshot is only useful if it's
     there for whoever needs it, from wherever they are. The list loads async
     (it's a round trip) and redraws itself in place, so the rest of the panel
     doesn't wait on it. Admin-only, enforced server-side too. */
  /* Slack channel mappings — where each show's task chatter goes. A mapping
     is prerequisite plumbing for the bridge, so this card works (and is worth
     filling in) even while the bot's install is still pending IT approval:
     the moment credentials land, threads start flowing to whatever is mapped
     here. */
  function slackCard() {
    const card = el('.adm-permcard');
    card.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, [App.icon('plug'), ' Slack channels']),
      el('.adm-permcard-desc', null, 'Map a show to the Slack channel its task discussions post into. ' +
        'Add a department-specific row to split one show across channels — the department row wins. ' +
        'In Slack: channel name → ⋯ → Copy channel ID.')
    ]));

    const showSel = el('select.fld');
    App.activeShows().forEach(sw => {
      const o = document.createElement('option'); o.value = sw.id; o.textContent = sw.name; showSel.appendChild(o);
    });
    const deptSel = el('select.fld');
    [['', 'Whole show']].concat(Object.keys(App.DEPARTMENTS).map(k => [k, App.DEPARTMENTS[k].label]))
      .forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; deptSel.appendChild(o); });
    const chanFld = el('input.fld', { type: 'text', placeholder: 'Channel ID — C0123ABCD', maxlength: '30' });
    const addBtn = el('button.adm-btn', null, 'Map channel');
    card.appendChild(el('.adm-backup-bar', null, [showSel, deptSel, chanFld, addBtn]));

    const list = el('.wf-list', null, el('.adm-empty', null, 'Loading…'));
    card.appendChild(list);
    const note = el('.adm-name-sub.adm-backup-cap');
    card.appendChild(note);

    const draw = (r) => {
      list.innerHTML = '';
      note.textContent = r.bridge
        ? 'The Slack bridge is connected — mapped shows post live.'
        : 'The bridge isn’t connected yet (bot credentials pending) — mappings save now and take effect the moment it is.';
      if (!r.mappings.length) { list.appendChild(el('.adm-empty', null, 'No channels mapped yet.')); return; }
      r.mappings.forEach(m => {
        const show = App.state.data.shows.find(x => x.id === m.show_id);
        list.appendChild(el('.show-arch-row', null, [
          el('span.show-arch-dot', { style: { background: show ? show.color : 'var(--text-3)' } }),
          el('div', { style: { minWidth: 0 } }, [
            el('.adm-name', null, (show ? show.name : m.show_id) +
              (m.dept_key ? ' · ' + App.dept(m.dept_key).label : '')),
            el('.adm-name-sub', null, m.slack_channel_id + (m.dept_key ? '' : ' · whole show'))
          ]),
          el('button.adm-btn.subtle', {
            onclick: () => App.api._chat('DELETE', '/api/slack/channels?id=' + encodeURIComponent(m.id))
              .then(load).catch(e => App.toast(e.message, true))
          }, 'Unmap')
        ]));
      });
    };
    const load = () => App.api._chat('GET', '/api/slack/channels').then(draw)
      .catch(e => { list.innerHTML = ''; list.appendChild(el('.adm-empty', null, e.message)); });

    addBtn.addEventListener('click', () => {
      App.api._chat('POST', '/api/slack/channels', {
        showId: showSel.value, deptKey: deptSel.value || null, slackChannelId: chanFld.value
      }).then(() => { chanFld.value = ''; App.toast('Channel mapped'); load(); })
        .catch(e => App.toast(e.message, true));
    });

    load();
    return card;
  }

  function backupsCard() {
    const card = el('.adm-permcard');
    card.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, [App.icon('archive'), ' Board backups']),
      el('.adm-permcard-desc', null, 'A snapshot of the entire board — every show, episode, task and setting — stored in the ' +
        'database. Take one before anything irreversible. Restoring replaces the board for everyone.')
    ]));

    const labelFld = el('input.fld', { type: 'text', placeholder: 'Optional label — e.g. before the Q3 re-plan', maxlength: '120' });
    const nowBtn = el('button.adm-btn', null, 'Back up now');
    card.appendChild(el('.adm-backup-bar', null, [labelFld, nowBtn]));

    const list = el('.wf-list', null, el('.adm-empty', null, 'Loading…'));
    card.appendChild(list);
    // outside the list, so a redraw doesn't stack copies of it
    const capNote = el('.adm-name-sub.adm-backup-cap');
    card.appendChild(capNote);

    const draw = (r) => {
      list.innerHTML = '';
      capNote.textContent = '';
      if (!r.backups.length) { list.appendChild(el('.adm-empty', null, 'No backups yet.')); return; }
      r.backups.forEach((b, i) => {
        const when = new Date(b.ts);
        const kb = Math.max(1, Math.round((b.meta && b.meta.bytes || 0) / 1024));
        list.appendChild(el('.show-arch-row', null, [
          el('span.show-arch-dot', { style: { background: i === 0 ? '#00c875' : 'var(--text-3)' } }),
          el('div', { style: { minWidth: 0 } }, [
            el('.adm-name', null, b.label || when.toLocaleString()),
            el('.adm-name-sub', null, (b.label ? when.toLocaleString() + ' · ' : '') +
              (b.meta ? b.meta.shows + ' shows · ' + b.meta.episodes + ' episodes · ' + kb + ' KB' : '') +
              (b.email ? ' · ' + b.email : ''))
          ]),
          el('.arch-actions', null, [
            el('button.btn-mini', {
              title: 'Replace the current board with this snapshot',
              onclick: () => App.confirm(
                'This replaces the whole board — every show, episode and setting — with the snapshot from ' +
                when.toLocaleString() + '. Everyone’s view changes immediately. The board as it stands now is ' +
                'backed up first, so this can be undone.',
                () => App.api.restoreBackup(b.id)
                  .then(() => { App.toast('Board restored'); load(); })
                  .catch(e => App.toast(e.message, true)),
                { title: 'Restore this backup?', yesLabel: 'Restore board' })
            }, '↩ Restore'),
            el('button.btn-mini.danger', {
              onclick: () => App.confirm('Delete this backup? The snapshot is gone for good.',
                () => App.api.deleteBackup(b.id).then(load).catch(e => App.toast(e.message, true)),
                { title: 'Delete backup?' })
            }, '✕')
          ])
        ]));
      });
      capNote.textContent = 'The newest ' + r.cap + ' backups are kept; older ones drop off automatically.';
    };

    const load = () => App.api.backups().then(draw).catch(e => {
      list.innerHTML = '';
      list.appendChild(el('.adm-empty', null, 'Could not load backups — ' + e.message));
    });

    nowBtn.onclick = () => {
      nowBtn.disabled = true; nowBtn.textContent = 'Backing up…';
      App.api.backupNow(labelFld.value.trim())
        .then(b => { labelFld.value = ''; App.toast('Board backed up — ' + b.meta.episodes + ' episodes'); return load(); })
        .catch(e => App.toast(e.message, true))
        .then(() => { nowBtn.disabled = false; nowBtn.textContent = 'Back up now'; });
    };

    load();
    return card;
  }

  function showsPanel() {
    const wrapP = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });
    const shows = App.state.data.shows;
    const eps = App.state.data.episodes;

    // ---- active ----
    const act = el('.adm-permcard');
    act.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, 'Active shows'),
      el('.adm-permcard-desc', null, 'Back up downloads a show and its episodes as a JSON file. ' +
        'Archiving hides a show or episode from every view without losing any of its data.' +
        (App.masterPathSet() ? ' Rebuild only adds folders that are missing on the master directory — it never touches existing files.' : ''))
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
        el('.arch-actions', null, [
          // restore anything missing from this show's tree on the master directory
          (App.masterPathSet()
            ? el('button.btn-mini', {
                title: 'Create any of this show’s production folders that are missing',
                onclick: (e) => { e.stopPropagation(); App.rebuildShowFolders(s.id); }
              }, [App.icon('folderOpen'), ' Rebuild folders'])
            : null),
          el('button.btn-mini', {
            title: 'Download this show and all its episodes as a JSON file',
            onclick: (e) => { e.stopPropagation(); App.downloadShowBackup(s.id); }
          }, [App.icon('download'), ' Back up']),
          el('button.btn-mini', { onclick: (e) => { e.stopPropagation(); App.setShowArchived(s.id, true); } }, [App.icon('archive'), ' Archive show'])
        ])
      ]));
      if (isOpen) sEps.forEach(ep => {
        actList.appendChild(el('.ep-arch-row', null, [
          el('span.ep-arch-code', { style: { background: s.color, color: App.pickInkFor(s.color) } }, ep.code),
          el('span.ep-arch-title', null, ep.title),
          el('span.ep-arch-dates', null, App.fmtRange(App.epStart(ep), App.epDue(ep))),
          el('.arch-actions', null,
            el('button.btn-mini', { onclick: () => App.setEpisodeArchived(ep.id, true) }, App.icon('archive')))
        ]));
      });
    });
    act.appendChild(actList);
    wrapP.appendChild(act);

    // ---- archive ----
    const arch = el('.adm-permcard');
    arch.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, [App.icon('archive'), ' Archive']),
      el('.adm-permcard-desc', null, 'Restore brings content back exactly as it was. Deleting is permanent and can’t be undone — take a backup first.')
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
          el('button.btn-mini', {
            title: 'Download this show and all its episodes as a JSON file',
            onclick: () => App.downloadShowBackup(s.id)
          }, [App.icon('download'), ' Back up']),
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

    // the whole-board safety net sits last — per-show tools first, big red button last
    if (App.api && App.api.online && App.api.me && App.api.me.admin) {
      wrapP.appendChild(backupsCard());
    }

    return wrapP;
  }

  /* ------------------------------------------- audit & event logs ------- */
  /* Two readings of one event stream (see js/track.js):
       Activity — the audit trail: who changed what, when.
       Feature Usage — which parts of the tool each role actually reaches for,
                       to steer what gets built next.
     Both fetch on demand and render into a placeholder, since App.admin.render()
     is synchronous. */

  // human labels for the action keys the tracker emits
  const ACTION_LABELS = {
    'task.status': 'Task status changed', 'task.edit': 'Task edited',
    'task.reschedule': 'Task rescheduled', 'task.remove': 'Task removed',
    'show.create': 'Show created', 'show.remove': 'Show removed', 'show.delete': 'Show deleted',
    'show.archive': 'Show archived', 'show.restore': 'Show restored', 'show.backup': 'Show backed up',
    'episode.archive': 'Episode archived', 'episode.restore': 'Episode restored', 'episode.delete': 'Episode deleted',
    'person.add': 'Team member added', 'person.remove': 'Team member removed', 'person.role': 'Role reassigned',
    'perm.change': 'Permission changed',
    'workflow.status': 'Status style changed', 'workflow.department': 'Department style changed',
    'workflow.deptAdd': 'Department added', 'workflow.deptRemove': 'Department removed',
    'workflow.reset': 'Workflow reset',
    'note.add': 'Producer note added', 'note.remove': 'Producer note removed',
    'view.timeline': 'Timeline view', 'view.board': 'Board view', 'view.dashboard': 'Dashboard view',
    'view.admin': 'Admin view', 'view.review': 'Review queue',
    'admin.hub': 'Admin hub', 'admin.directory': 'User directory', 'admin.roles': 'Access control',
    'admin.workflow': 'Workflow settings', 'admin.logs': 'Audit logs',
    'task.editDialog': 'Edit Task dialog', 'timeline.dragReschedule': 'Timeline drag-reschedule',
    'lucidlink.delivered': 'LucidLink upload', 'lucidlink.uploadFailed': 'LucidLink upload failed',
    'lucidlink.prepareFailed': 'LucidLink prepare failed',
    'flow.start': 'Workflow started', 'flow.complete': 'Workflow completed', 'flow.abandon': 'Workflow abandoned',
    'assistant.miss': 'Assistant didn’t understand', 'assistant.unresolved': 'Assistant couldn’t resolve a name',
    'assistant.parsed': 'Assistant understood', 'assistant.blocked': 'Assistant unavailable',
    'assistant.cancelled': 'Assistant plan cancelled',
    'assistant.replicate': 'Pipeline replicated', 'assistant.dependency': 'Dependency changed',
    'view.workspace': 'Task workspace', 'admin.logs': 'Audit logs'
  };
  const actionLabel = (a) => ACTION_LABELS[a] || a;

  function relTime(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Flatten an event's detail object into one readable line.
  function detailText(d) {
    if (!d || typeof d !== 'object') return '';
    const bits = [];
    Object.keys(d).forEach(k => {
      const v = d[k];
      if (v == null || v === '' || k === 'changed') return;
      if (typeof v === 'object') return;
      bits.push(k + ': ' + v);
    });
    if (d.changed && typeof d.changed === 'object') {
      Object.keys(d.changed).forEach(f => {
        const c = d.changed[f];
        bits.push(c && c.from !== undefined ? f + ' ' + c.from + ' → ' + c.to : f);
      });
    }
    return bits.join('  ·  ');
  }

  function logs() {
    const box = el('div');
    box.appendChild(crumb('Audit & Event Logs'));
    const st = App.state.admin;
    st.logTab = st.logTab || 'activity';
    st.logDays = st.logDays == null ? 30 : st.logDays;

    box.appendChild(head('Audit & Event Logs',
      'Every change made across the tracker, and which features each role uses.'));

    // range + tab controls
    const tabs = el('.adm-tabs', null, [
      el('button.adm-tab' + (st.logTab === 'activity' ? '.active' : ''),
        { onclick: () => { st.logTab = 'activity'; App.render(); } }, 'Activity'),
      el('button.adm-tab' + (st.logTab === 'usage' ? '.active' : ''),
        { onclick: () => { st.logTab = 'usage'; App.render(); } }, 'Feature Usage')
    ]);
    const rangeSel = el('select.filter');
    [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [0, 'All time']].forEach(([v, label]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = label;
      if (v === st.logDays) o.selected = true; rangeSel.appendChild(o);
    });
    rangeSel.addEventListener('change', e => { st.logDays = parseInt(e.target.value, 10); App.render(); });
    // the Feature Usage tab has its own segmentation bar (horizon lives there),
    // so this range control belongs to the Activity tab alone
    box.appendChild(el('.adm-logbar', null, [tabs,
      st.logTab === 'usage' ? null : el('.adm-logbar-right', null, rangeSel)]));

    const panel = el('.adm-logpanel', null, el('.adm-empty', null, 'Loading…'));
    box.appendChild(panel);
    (st.logTab === 'usage' ? renderUsage : renderActivity)(panel, st);
    return box;
  }

  function fail(panel, e) {
    panel.innerHTML = '';
    panel.appendChild(el('.adm-empty', null, 'Could not load the log — ' + e.message));
  }

  function renderActivity(panel, st) {
    const filters = st.logFilters = st.logFilters || { kind: 'audit', role: '', action: '' };
    let offset = 0, loaded = [];

    const draw = (total) => {
      panel.innerHTML = '';

      const kindSel = el('select.filter');
      // 'error' was always stored and counted, but had no way to be filtered to
      // — which is where the assistant's miss log and the LucidLink failures live
      [['', 'All events'], ['audit', 'Changes only'], ['usage', 'Feature usage only'],
       ['error', 'Problems only']].forEach(([v, l]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = l;
        if (v === filters.kind) o.selected = true; kindSel.appendChild(o);
      });
      kindSel.addEventListener('change', e => { filters.kind = e.target.value; App.render(); });

      const roleSel2 = el('select.filter');
      [['', 'All roles']].concat(App.ROLES.map(r => [r.key, r.label])).forEach(([v, l]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = l;
        if (v === filters.role) o.selected = true; roleSel2.appendChild(o);
      });
      roleSel2.addEventListener('change', e => { filters.role = e.target.value; App.render(); });

      panel.appendChild(el('.adm-logfilters', null, [
        kindSel, roleSel2,
        el('span.adm-logcount', null, total + ' event' + (total === 1 ? '' : 's'))
      ]));

      if (!loaded.length) {
        panel.appendChild(el('.adm-empty', null, 'No activity recorded yet for this range.'));
        return;
      }

      const table = el('.adm-table');
      table.appendChild(el('.adm-logrow.head', null, [
        el('.cell', null, 'When'), el('.cell', null, 'Who'), el('.cell', null, 'Role'),
        el('.cell', null, 'Event'), el('.cell', null, 'Details')
      ]));
      loaded.forEach(r => {
        const person = (App.state.data.people || []).find(p => (p.email || '').toLowerCase() === (r.email || '').toLowerCase());
        table.appendChild(el('.adm-logrow', null, [
          el('.cell.adm-when', { title: new Date(r.ts).toLocaleString() }, relTime(r.ts)),
          el('.cell.adm-who', null, person ? person.name : (r.email || '—')),
          el('.cell', null, el('span.adm-role-chip', null, r.role ? App.role(r.role).label : '—')),
          el('.cell', null, [
            el('span.adm-kind.' + (r.kind === 'audit' ? 'audit' : r.kind === 'error' ? 'error' : 'usage'), null,
              r.kind === 'audit' ? 'change' : r.kind === 'error' ? 'problem' : 'usage'),
            el('span', null, actionLabel(r.action))
          ]),
          el('.cell.adm-detail', { title: detailText(r.detail) }, detailText(r.detail))
        ]));
      });
      panel.appendChild(table);

      if (loaded.length < total) {
        panel.appendChild(el('button.adm-btn', {
          style: { marginTop: '12px' },
          onclick: (e) => { e.target.textContent = 'Loading…'; offset = loaded.length; load(true); }
        }, 'Load older events'));
      }
    };

    const load = (append) => {
      App.api.activity({
        kind: filters.kind, role: filters.role,
        days: st.logDays || '', limit: 100, offset
      }).then(r => {
        loaded = append ? loaded.concat(r.rows) : r.rows;
        draw(r.total);
      }).catch(e => fail(panel, e));
    };
    load(false);
  }

  /* The usage view answers "where is the tool actually being used, and is that
     changing?" — so every figure is paired with the previous equal-length period
     and the page leads with trends rather than standing totals. */
  /* ---- Feature Usage: the product-decision view ----
     Every figure is scoped by the segmentation bar (role / department / horizon)
     and paired with the previous equal-length window, so the page reads as
     "what changed and where are people stuck" rather than a pile of totals. */
  function renderUsage(panel, st) {
    const seg = st.seg = st.seg || { role: '', dept: '', hours: 0, days: 30 };
    const query = { role: seg.role, dept: seg.dept };
    if (seg.hours) query.hours = seg.hours; else query.days = seg.days;

    App.api.activityStats(query).then(s => {
      panel.innerHTML = '';
      panel.appendChild(segmentBar(seg, s));
      if (!s.total) {
        panel.appendChild(el('.adm-empty', null, 'No activity recorded for this segment. Widen the horizon or clear a filter.'));
        return;
      }
      const C = App.charts;
      const pct = (now, prev) => prev ? Math.round((now - prev) / prev * 100) : (now ? 100 : null);
      const horizonLabel = seg.hours ? 'vs previous 24h' : 'vs previous ' + seg.days + ' days';

      /* ---- 1. KPI scorecards ---- */
      const cards = el('.adm-kpi-row');

      // DAU by role — the headline is the overall daily average; the breakdown
      // underneath is what makes it actionable ("Producers are in daily, QC isn't")
      const dauRoles = Object.keys(s.dauByRole)
        .filter(r => s.dauByRole[r] > 0)
        .sort((a, b) => s.dauByRole[b] - s.dauByRole[a]).slice(0, 4);
      const prevDau = s.prev ? s.prev.dau : null;
      cards.appendChild(kpiCard({
        label: 'Daily Active Users', value: s.dau, sub: 'avg per active day',
        delta: s.prev ? pct(s.dau, prevDau) : null, deltaNote: horizonLabel,
        spark: s.series.users, color: C.seriesColor(0),
        rows: dauRoles.map(r => ({ label: roleName(r), value: s.dauByRole[r] }))
      }));

      // Top feature leveraged
      const tf = s.topFeature;
      const tfPrev = tf && s.prev ? (s.prev.featureCounts || {})[tf.action] || 0 : 0;
      cards.appendChild(kpiCard({
        label: 'Top Feature Leveraged',
        value: tf ? actionLabel(tf.action) : '—', valueSmall: true,
        sub: tf ? tf.count.toLocaleString() + ' opens · ' + tf.share + '% of all usage' : '',
        delta: tf && s.prev ? pct(tf.count, tfPrev) : null, deltaNote: horizonLabel,
        spark: tf ? (s.series.byAction[tf.action] || []) : [], color: C.seriesColor(1)
      }));

      // Total events fired
      cards.appendChild(kpiCard({
        label: 'Total Events Fired', value: s.total.toLocaleString(),
        sub: s.usage.toLocaleString() + ' usage · ' + s.audit.toLocaleString() + ' changes',
        delta: s.prev ? pct(s.total, s.prev.total) : null, deltaNote: horizonLabel,
        spark: s.series.total, color: C.seriesColor(2)
      }));

      // Average session time
      cards.appendChild(kpiCard({
        label: 'Avg Session Time', value: fmtDur(s.avgSessionMs),
        sub: s.sessions.toLocaleString() + ' session' + (s.sessions === 1 ? '' : 's') + ' · 30-min idle cut-off',
        delta: s.prev ? pct(s.avgSessionMs, s.prev.avgSessionMs) : null, deltaNote: horizonLabel,
        spark: null, color: C.seriesColor(3)
      }));
      panel.appendChild(cards);

      /* ---- 2. Feature adoption ---- */
      // A named shortlist, so the question is "is adoption sticking?" for the
      // features we actually care about — not whatever happens to rank today.
      const WATCH = [
        { action: 'timeline.dragReschedule', label: 'Timeline dragging' },
        { action: 'note.add', label: 'Notes creation' },
        { action: 'lucidlink.delivered', label: 'LucidLink uploads' },
        { action: 'task.editDialog', label: 'Task editing' }
      ];
      const watched = WATCH
        .map((wf, i) => ({ label: wf.label, values: s.series.byAction[wf.action] || null, color: C.seriesColor(i) }))
        .filter(x => x.values);
      const adopt = chartCard('Feature adoption over time',
        'Tracked features per ' + s.bucket + '. A line flattening out is adoption stalling.');
      if (watched.length) {
        adopt.appendChild(C.lineChart(s.buckets, watched, { height: 200 }));
        adopt.appendChild(C.legend(watched));
      } else {
        adopt.appendChild(el('.adm-empty', null, 'None of the tracked features were used in this segment yet.'));
      }
      panel.appendChild(adopt);

      // Popularity ranking — what to prioritise
      const ranked = Object.keys(s.featureCounts || {})
        .sort((a, b) => s.featureCounts[b] - s.featureCounts[a]).slice(0, 12);
      if (ranked.length) {
        const totalFeat = Object.values(s.featureCounts).reduce((a, b) => a + b, 0);
        const popCard = chartCard('Feature popularity',
          'Most to least used, across this segment — the top of this list is where effort pays back.');
        popCard.appendChild(C.barChart(ranked.map(a => ({
          label: actionLabel(a), value: s.featureCounts[a],
          share: totalFeat ? Math.round(s.featureCounts[a] / totalFeat * 100) : 0
        })), { unit: 'opens' }));
        panel.appendChild(popCard);
      }

      /* ---- 3. Friction & usability ---- */
      panel.appendChild(frictionSection(s, seg, pct));

      /* ---- 4. Who uses what (kept — the role × feature matrix) ---- */
      const roleKeys = Object.keys(s.byRole).sort((a, b) => s.byRole[b] - s.byRole[a]);
      const topActions = Object.keys(s.featureCounts || {}).sort((a, b) => s.featureCounts[b] - s.featureCounts[a]).slice(0, 8);
      if (topActions.length && roleKeys.length) {
        const rows = roleKeys.slice(0, 8).map(rk => ({ key: rk, label: roleName(rk) }));
        const cols = topActions.map(a => ({ label: actionLabel(a), short: shortLabel(actionLabel(a)) }));
        const matrix = rows.map(r => topActions.map(a => (s.byRoleAction[r.key] || {})[a] || 0));
        const hCard = chartCard('Who uses what',
          'Darker means that role leans on that feature more. The empty cells are the story too.');
        hCard.appendChild(C.heatmap(rows, cols, matrix));
        panel.appendChild(hCard);

        const tableWrap = el('.adm-tableview', { style: { display: 'none' } });
        const tbl = el('.adm-table');
        tbl.appendChild(el('.adm-logrow.head.adm-usagerow', null,
          [el('.cell', null, 'Role')].concat(cols.map(c => el('.cell', null, c.short)))));
        rows.forEach((r, i) => {
          tbl.appendChild(el('.adm-logrow.adm-usagerow', null,
            [el('.cell', null, r.label)].concat(matrix[i].map(v => el('.cell', null, String(v))))));
        });
        tableWrap.appendChild(tbl);
        const toggle = el('button.adm-btn', {
          onclick: () => {
            const open = tableWrap.style.display !== 'none';
            tableWrap.style.display = open ? 'none' : '';
            toggle.textContent = open ? 'Show as table' : 'Hide table';
          }
        }, 'Show as table');
        hCard.appendChild(el('div', { style: { padding: '0 18px 14px' } }, [toggle, tableWrap]));
      }
    }).catch(e => fail(panel, e));
  }

  const avgOf = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const roleName = (rk) => rk === 'unknown' ? 'Unknown' : App.role(rk).label;

  function fmtDur(ms) {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  /* Segmentation bar — role, department and time horizon. Changing any of these
     re-queries the server so every section below is scoped identically. */
  function segmentBar(seg, s) {
    const apply = () => App.render();
    const bar = el('.adm-segbar');

    const horizons = [[24, 0, 'Last 24h'], [0, 7, '7 days'], [0, 30, '30 days'], [0, 90, '90 days']];
    bar.appendChild(el('.adm-seg-group', null, [
      el('span.adm-seg-lab', null, 'Horizon'),
      el('.adm-seg-pills', null, horizons.map(([h, d, label]) =>
        el('button.adm-seg-pill' + ((seg.hours === h && seg.days === d) ? '.active' : ''), {
          onclick: () => { seg.hours = h; seg.days = d; apply(); }
        }, label)))
    ]));

    const roleSel = el('select.filter');
    [['', 'All roles']].concat(App.ROLES.map(r => [r.key, r.label])).forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l;
      if (v === seg.role) o.selected = true; roleSel.appendChild(o);
    });
    roleSel.addEventListener('change', e => { seg.role = e.target.value; apply(); });
    bar.appendChild(el('.adm-seg-group', null, [el('span.adm-seg-lab', null, 'Role'), roleSel]));

    const deptSel = el('select.filter');
    [['', 'All departments']].concat(Object.keys(App.DEPARTMENTS).map(k => [k, App.dept(k).label])).forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l;
      if (v === seg.dept) o.selected = true; deptSel.appendChild(o);
    });
    deptSel.addEventListener('change', e => { seg.dept = e.target.value; apply(); });
    bar.appendChild(el('.adm-seg-group', null, [el('span.adm-seg-lab', null, 'Department'), deptSel]));

    const active = (seg.role ? 1 : 0) + (seg.dept ? 1 : 0);
    const right = el('.adm-seg-right', null, [
      el('span.adm-seg-count', null, s.total.toLocaleString() + ' events in view')
    ]);
    if (active) {
      right.appendChild(el('button.adm-btn.adm-seg-clear', {
        onclick: () => { seg.role = ''; seg.dept = ''; apply(); }
      }, 'Clear filters'));
    }
    bar.appendChild(right);
    return bar;
  }

  /* Friction: three questions in one section — do things fail, do people give
     up, and how long does the work take? All three come from the same flow.*
     and error events, so they stay consistent with each other. */
  function frictionSection(s, seg, pct) {
    const f = s.friction || { flows: [], errors: [] };
    const pf = (s.prev && s.prev.friction) || { flows: [], errors: [] };
    const prevFlow = (name) => pf.flows.find(x => x.flow === name) || null;

    const wrap = el('.adm-permcard.adm-chartcard.adm-friction');
    wrap.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, 'Friction & usability'),
      el('.adm-permcard-desc', null, 'Where the tool fights back: failures, drop-offs, and how long core work takes.')
    ]));

    // --- error rates ---
    const errBox = el('.adm-fr-block');
    errBox.appendChild(el('.adm-fr-h', null, 'Error rates'));
    if (!f.errors.length) {
      errBox.appendChild(el('.adm-fr-none', null, [App.icon('check', { cls: 'adm-fr-ok' }), ' No failures recorded in this segment.']));
    } else {
      const grid = el('.adm-fr-grid');
      f.errors.slice(0, 4).forEach(e => {
        const prev = pf.errors.find(x => x.action === e.action);
        const d = prev ? pct(e.count, prev.count) : null;
        // more errors is worse, so the delta's polarity is inverted here
        grid.appendChild(el('.adm-fr-card' + (e.rate != null && e.rate >= 10 ? '.bad' : ''), null, [
          el('.adm-fr-card-top', null, [
            el('.adm-fr-n', null, e.rate != null ? e.rate + '%' : String(e.count)),
            d == null ? null : el('span.adm-delta.' + (d > 0 ? 'down' : 'up'), null, (d > 0 ? '▲ +' : '▼ ') + d + '%')
          ]),
          el('.adm-fr-lab', null, actionLabel(e.action)),
          el('.adm-fr-sub', null, e.rate != null
            ? e.count + ' of ' + e.attempts + ' attempts failed'
            : e.count + ' occurrence' + (e.count === 1 ? '' : 's'))
        ]));
      });
      errBox.appendChild(grid);
    }
    wrap.appendChild(errBox);

    // --- abandoned actions ---
    const abBox = el('.adm-fr-block');
    abBox.appendChild(el('.adm-fr-h', null, 'Abandoned actions'));
    const closed = f.flows.filter(x => x.completed + x.abandoned > 0);
    if (!closed.length) {
      abBox.appendChild(el('.adm-fr-none', null, 'No tracked workflows were started in this segment yet.'));
    } else {
      closed.slice(0, 6).forEach(fl => {
        const prev = prevFlow(fl.flow);
        const d = prev && prev.abandonRate != null ? fl.abandonRate - prev.abandonRate : null;
        const total = fl.completed + fl.abandoned;
        abBox.appendChild(el('.adm-fr-row', null, [
          el('.adm-fr-row-lab', null, [
            el('span.adm-fr-flow', null, fl.flow),
            el('span.adm-fr-sub', null, fl.abandoned + ' of ' + total + ' closed without saving')
          ]),
          // completed vs abandoned as one part-to-whole bar (2px surface gap)
          el('.adm-fr-bar', null, [
            el('.adm-fr-bar-done', { style: { width: (fl.completed / total * 100) + '%' } }),
            el('.adm-fr-bar-drop', { style: { width: (fl.abandoned / total * 100) + '%' } })
          ]),
          el('.adm-fr-row-val', null, [
            el('span.adm-fr-pct' + (fl.abandonRate >= 40 ? '.bad' : ''), null, fl.abandonRate + '%'),
            d == null || d === 0 ? null
              : el('span.adm-delta.' + (d > 0 ? 'down' : 'up'), null, (d > 0 ? '▲ +' : '▼ ') + d + 'pt')
          ])
        ]));
      });
      abBox.appendChild(el('.viz-legend', null, [
        legendKey('Saved', 'var(--viz-up)'), legendKey('Abandoned', 'var(--viz-down)')
      ]));
    }
    wrap.appendChild(abBox);

    // --- time to completion ---
    const ttcBox = el('.adm-fr-block');
    ttcBox.appendChild(el('.adm-fr-h', null, 'Time to completion'));
    const timed = f.flows.filter(x => x.medianMs != null);
    if (!timed.length) {
      ttcBox.appendChild(el('.adm-fr-none', null, 'No completed workflows have been timed in this segment yet.'));
    } else {
      const grid = el('.adm-fr-grid');
      timed.slice(0, 4).forEach(fl => {
        const prev = prevFlow(fl.flow);
        // slower is worse, so this delta is inverted too
        const d = prev && prev.medianMs ? pct(fl.medianMs, prev.medianMs) : null;
        grid.appendChild(el('.adm-fr-card', null, [
          el('.adm-fr-card-top', null, [
            el('.adm-fr-n', null, fmtDur(fl.medianMs)),
            d == null || d === 0 ? null
              : el('span.adm-delta.' + (d > 0 ? 'down' : 'up'), null, (d > 0 ? '▲ +' : '▼ ') + d + '%')
          ]),
          el('.adm-fr-lab', null, fl.flow),
          el('.adm-fr-sub', null, 'median · p90 ' + fmtDur(fl.p90Ms) + ' · n=' + fl.samples)
        ]));
      });
      ttcBox.appendChild(grid);
    }
    wrap.appendChild(ttcBox);
    return wrap;
  }

  function legendKey(label, color) {
    return el('span.viz-legend-item', null, [
      el('span.viz-legend-key', { style: { background: color } }), el('span', null, label)
    ]);
  }

  // trim a long feature label for a cramped axis, without clipping mid-word
  function shortLabel(s) {
    if (s.length <= 16) return s;
    const cut = s.slice(0, 15);
    const sp = cut.lastIndexOf(' ');
    return (sp > 8 ? cut.slice(0, sp) : cut) + '…';
  }

  function chartCard(title, desc) {
    const card = el('.adm-permcard.adm-chartcard');
    card.appendChild(el('.adm-permcard-head', null, [
      el('.adm-permcard-title', null, title),
      el('.adm-permcard-desc', null, desc)
    ]));
    return card;
  }

  /* A KPI scorecard: headline value, delta against the previous window, an
     optional sparkline, and an optional per-role breakdown. */
  function kpiCard(o) {
    const head = el('.adm-kpi-top', null, [
      el('.adm-kpi-v' + (o.valueSmall ? '.small' : ''), null, String(o.value)),
      o.delta == null ? null
        : el('span.adm-delta.' + (o.delta > 0 ? 'up' : o.delta < 0 ? 'down' : 'flat'),
            { title: o.deltaNote },
            (o.delta > 0 ? '▲ +' : o.delta < 0 ? '▼ ' : '') + o.delta + '%')
    ]);
    const card = el('.adm-kpi', null, [
      el('.adm-kpi-l', null, o.label),
      head,
      o.sub ? el('.adm-kpi-sub', null, o.sub) : null,
      o.delta == null ? null : el('.adm-kpi-note', null, o.deltaNote)
    ]);
    if (o.spark && o.spark.length > 1) card.appendChild(App.charts.sparkline(o.spark, { color: o.color, height: 28 }));
    if (o.rows && o.rows.length) {
      card.appendChild(el('.adm-kpi-rows', null, o.rows.map(r => el('.adm-kpi-row2', null, [
        el('span.adm-kpi-rk', null, r.label), el('span.adm-kpi-rv', null, String(r.value))
      ]))));
    }
    return card;
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
