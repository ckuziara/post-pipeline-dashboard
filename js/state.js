/* Post Pipeline — data model, pipeline template, derived metrics, persistence.
   Buildless: plain JS in window.App, loaded as classic deferred scripts. No Node, no bundler.
   The pipeline TEMPLATE below is transcribed straight from the Monday board (Episode 1:
   "Episode One") — 27 subitems, their departments, dependencies and dates. */
window.App = window.App || {};
(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
     "Today" tracks the real clock. DEMO_TODAY is the date the reference plan in
     seed.js was authored around — the seed re-anchors itself onto the real
     today so the demo timeline always spans past/present/future.
  --------------------------------------------------------------------------- */
  App.DEMO_TODAY = '2025-11-12';
  App.useRealClock = true;

  App.today = function () {
    const d = App.useRealClock ? new Date() : App.parseDate(App.DEMO_TODAY);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  /* ---------------------------------------------------------------------------
     Departments — colour-coded for the timeline bars & legend (image 1 used
     colour-by-worktype; we colour by department).
  --------------------------------------------------------------------------- */
  App.DEPARTMENTS = {
    creative: { label: 'Creative',        color: '#6c8cff' },
    music:    { label: 'Music',           color: '#b06cff' },
    animation:{ label: 'Animation',       color: '#29c2d6' },
    audio:    { label: 'Audio Post',      color: '#ffb02e' },
    video:    { label: 'Video Post',      color: '#ff7ab2' },
    ops:      { label: 'Post Operations', color: '#59d98f' },
    qc:       { label: 'QC',              color: '#ff6b6b' }
  };
  App.dept = (k) => App.DEPARTMENTS[k] || { label: k, color: '#888' };

  /* ---------------------------------------------------------------------------
     Connectors — external tools that can be linked to team members. Admins turn
     these on/off in Workflow Settings → Connectors; a disabled connector is
     hidden everywhere in the app. `enabled` here is the default until an admin
     overrides it in data.connectors.
  --------------------------------------------------------------------------- */
  App.CONNECTORS = [
    { key: 'slack', label: 'Slack', color: '#e01e5a', perMember: true, desc: 'Show each member’s Slack link and (later) send notifications.',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523 2.528 2.528 0 0 1-2.522-2.523 2.528 2.528 0 0 1 2.522-2.52h2.52v2.52zm1.261 0a2.528 2.528 0 0 1 2.52-2.52h5.043a2.528 2.528 0 0 1 2.522 2.52v5.042a2.528 2.528 0 0 1-2.522 2.52H8.823a2.528 2.528 0 0 1-2.52-2.52v-5.042zM8.823 5.043a2.528 2.528 0 0 1-2.52-2.52A2.528 2.528 0 0 1 8.823 0a2.528 2.528 0 0 1 2.52 2.522v2.521h-2.52zm0 1.261a2.528 2.528 0 0 1 2.52 2.52v5.043a2.528 2.528 0 0 1-2.52 2.522H3.78a2.528 2.528 0 0 1-2.52-2.522V8.824a2.528 2.528 0 0 1 2.52-2.52h5.043zm10.135 3.761a2.528 2.528 0 0 1 2.522-2.52 2.528 2.528 0 0 1 2.52 2.52 2.528 2.528 0 0 1-2.52 2.522h-2.522v-2.522zm-1.262 0a2.528 2.528 0 0 1-2.52 2.52h-5.043a2.528 2.528 0 0 1-2.522-2.52V3.78a2.528 2.528 0 0 1 2.522-2.52h5.043a2.528 2.528 0 0 1 2.52 2.52v5.043zm-3.781 10.133a2.528 2.528 0 0 1 2.52 2.522c0 1.393-1.13 2.521-2.52 2.521a2.528 2.528 0 0 1-2.522-2.521v-2.522h2.522zm0-1.262a2.528 2.528 0 0 1-2.522-2.52v-5.043a2.528 2.528 0 0 1 2.522-2.52h5.043a2.528 2.528 0 0 1 2.52 2.52v5.043a2.528 2.528 0 0 1-2.52 2.52h-5.043z"/></svg>' },
    { key: 'gmail', label: 'Gmail', color: '#ea4335', perMember: true, desc: 'Show each member’s email link and (later) send invites.',
      svg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 5.5v13a1.5 1.5 0 0 1-1.5 1.5H19V8.3l-7 5.15L5 8.3V20H3.5A1.5 1.5 0 0 1 2 18.5v-13A1.5 1.5 0 0 1 3.5 4h.6L12 9.9 19.9 4h.6A1.5 1.5 0 0 1 22 5.5z"/></svg>' },
    { key: 'lucidlink', label: 'LucidLink Version Control', color: '#2fbf9f',
      desc: 'PostLab-style checkout / check-in & file locking for NLE project files. Adds a Version Control panel on the Board.',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="12" r="2.4"/><path d="M6 8.4v7.2M8.2 6.6c4 0 7.6 1.4 7.6 5.4M8.1 17.2c4 0 7.5-1 7.7-4.9"/></svg>' }
  ];
  App.connector = (k) => App.CONNECTORS.find(c => c.key === k);
  App.connectorEnabled = function (k) {
    const c = App.state && App.state.data && App.state.data.connectors;
    return (c && k in c) ? !!c[k] : true;         // enabled by default until an admin turns it off
  };
  App.enabledConnectors = () => App.CONNECTORS.filter(c => App.connectorEnabled(c.key));
  // per-member connectors (shown as icons on each User Directory row)
  App.memberConnectors = () => App.enabledConnectors().filter(c => c.perMember);

  /* ---------------------------------------------------------------------------
     Statuses — the Monday label set from the board.
     `group` rolls several statuses up for the timeline's status swimlanes.
     `weight` drives the progress %.
  --------------------------------------------------------------------------- */
  App.STATUSES = {
    not_started: { label: 'Not Started',      color: '#c4c4c4', ink: '#33353d', weight: 0.0,  group: 'pending' },
    ready:       { label: 'Ready to Start',   color: '#5fb0f0', ink: '#06203f', weight: 0.1,  group: 'pending' },
    in_progress: { label: 'In Progress',      color: '#fdab3d', ink: '#3a2400', weight: 0.5,  group: 'working' },
    review:      { label: 'Ready for Review', color: '#a25ddc', ink: '#ffffff', weight: 0.85, group: 'review'  },
    approved:    { label: 'Approved',         color: '#00c875', ink: '#04321d', weight: 1.0,  group: 'done'    }
  };
  // order used by the status picker / cycling
  App.STATUS_ORDER = ['not_started', 'ready', 'in_progress', 'review', 'approved'];
  App.status = (k) => App.STATUSES[k] || App.STATUSES.not_started;

  /* ---------------------------------------------------------------------------
     Workflow customisation (Admin → Workflow & Status Settings).
     Departments and status colours/labels are editable and persist in
     data.workflow as overrides; structural status fields (weight/group/order)
     stay fixed. applyWorkflow() rebuilds the live DEPARTMENTS/STATUSES objects
     from the pristine defaults + overrides, so every reader (which all go
     through App.DEPARTMENTS / App.STATUSES / App.dept / App.status at call
     time) picks up edits with no other code change. Custom departments are
     appended after the built-ins, preserving order.
  --------------------------------------------------------------------------- */
  App._DEFAULT_DEPARTMENTS = JSON.parse(JSON.stringify(App.DEPARTMENTS));
  App._DEFAULT_STATUSES = JSON.parse(JSON.stringify(App.STATUSES));
  App.isDefaultDept = (k) => Object.prototype.hasOwnProperty.call(App._DEFAULT_DEPARTMENTS, k);

  // readable ink for a background colour (relative luminance threshold)
  App.pickInkFor = function (hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#ffffff';
    const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#11131a' : '#ffffff';
  };

  App.applyWorkflow = function () {
    const wf = (App.state.data && App.state.data.workflow) || {};

    const deps = {};
    Object.keys(App._DEFAULT_DEPARTMENTS).forEach(k => { deps[k] = Object.assign({}, App._DEFAULT_DEPARTMENTS[k]); });
    if (wf.departments) Object.keys(wf.departments).forEach(k => {
      deps[k] = Object.assign(deps[k] || {}, wf.departments[k]);   // new keys land after the built-ins
    });
    App.DEPARTMENTS = deps;

    const sts = {};
    App.STATUS_ORDER.forEach(k => {
      sts[k] = Object.assign({}, App._DEFAULT_STATUSES[k]);
      const ov = wf.statuses && wf.statuses[k];
      if (ov) {
        if (ov.label != null && ov.label !== '') sts[k].label = ov.label;
        if (ov.color) { sts[k].color = ov.color; sts[k].ink = App.pickInkFor(ov.color); }
      }
    });
    App.STATUSES = sts;

    // keep the pure-CSS status colours (KPI accents, dashboard bar) in sync
    const root = document.documentElement && document.documentElement.style;
    if (root) App.STATUS_ORDER.forEach(k => root.setProperty('--st-' + k, sts[k].color));
  };

  // episode-level swimlane groups (mirrors the reference Gantt's groupings)
  App.EP_GROUPS = {
    working:   { label: 'Working on it', color: '#fdab3d' },
    review:    { label: 'In Review',     color: '#a25ddc' },
    pending:   { label: 'Pending',       color: '#9aa0ad' },
    delivered: { label: 'Delivered',     color: '#00c875' }
  };
  App.EP_GROUP_ORDER = ['working', 'review', 'pending', 'delivered'];

  /* Roles. Three oversight roles + one role per department. Permission flags:
     approve = may set a task to Approved; editAll = may edit any task; admin = sees
     the Admin page; manageShows = may add/remove shows; dept = limits editing to that
     department's tasks (dept roles cannot approve).
     Structural rights — renaming a task, removing it, and moving its dates — are
     separate and deliberately narrow: they reshape the plan itself rather than
     record progress against it. Producers and Managers hold all three; Post
     Operations also owns scheduling (across every department, since that's the
     coordinating job), so it carries editSchedule without editAll. */
  App.ROLES = [
    { key: 'producer',  label: 'Producer',        ico: 'clapper', approve: true, editAll: true, admin: true, manageShows: true, editName: true, removeTask: true, editSchedule: true, kickOff: true, reviewQueue: true, reviewPriority: true, resourceView: 'all', hint: 'Full access — all tasks, shows & admin' },
    { key: 'manager',   label: 'Manager',         ico: 'compass', approve: true, editAll: true, admin: true, editName: true, removeTask: true, editSchedule: true, resourceView: 'all', manageResources: true, hint: 'Oversight, approvals & admin' },
    { key: 'director',  label: 'Director',        ico: 'target', approve: true, editAll: true, reviewQueue: true, kickOff: true, resourceView: 'none', hint: 'Review & approve cuts' },
    { key: 'creative',  label: 'Creative',        ico: 'pencil', dept: 'creative',  hint: 'Creative department tasks' },
    { key: 'music',     label: 'Music',           ico: 'music', dept: 'music',     hint: 'Music department tasks' },
    { key: 'animation', label: 'Animation',       ico: 'film', dept: 'animation', hint: 'Animation department tasks' },
    { key: 'audio',     label: 'Audio Post',      ico: 'headphones', dept: 'audio',     hint: 'Audio Post department tasks' },
    { key: 'video',     label: 'Video Post',      ico: 'camera', dept: 'video',     hint: 'Video Post department tasks' },
    { key: 'ops',       label: 'Post Operations', ico: 'package', dept: 'ops', editSchedule: true, hint: 'Post Operations tasks & scheduling' },
    { key: 'qc',        label: 'QC',              ico: 'checkBadge', dept: 'qc',        hint: 'QC tasks' }
  ];
  App.role = (k) => App.ROLES.find(r => r.key === k) || App.ROLES[0];
  // Role capabilities are data-driven (Admin → Access Control) with the ROLES
  // flags above as the defaults until an admin overrides them.
  /* ---- sub-roles ----
     Manager is not a job of its own but something layered on top of one: an
     Audio Post lead who also manages is "Audio Post and Manager", not a person
     who stopped being Audio Post. So it lives on the person as a flag rather
     than in `p.role`, which stays their base role — that keeps their
     department identity intact for "my department" filters and task
     ownership, both of which read App.roleDept(p.role).

     Capabilities are then the union of the base role and the sub-role. Manager
     carries editAll, which subsumes a department role's department scoping, so
     in practice a departmental manager can touch everything a Manager can
     while still belonging to their department.

     `App.rolePermOf` is the pure per-role answer — what a ROLE may do,
     regardless of who is asking. Admin → Access Control renders from it, so
     its matrix keeps showing each role's own settings. `App.rolePerm` is the
     "may I" answer, and elevates through the sub-roles the signed-in person
     carries. Every App.canX helper goes through the latter and is only ever
     asked about the current user. */
  App.rolePermOf = function (k, perm, builtin) {
    const t = App.state && App.state.data && App.state.data.rolePerms;
    if (t && t[k] && perm in t[k]) return !!t[k][perm];
    return !!builtin;
  };
  App.SUB_ROLES = ['manager'];
  App.isManager = (person) => !!(person && person.manager);
  // sub-roles held by the signed-in user; a sub-role elevates the person who
  // carries it, never the role itself
  App.mySubRoles = () => (App.state && App.state.subRoles) || [];
  App.rolePerm = function (k, perm, builtin) {
    if (App.rolePermOf(k, perm, builtin)) return true;
    return App.mySubRoles().some(sk => App.rolePermOf(sk, perm, !!App.role(sk)[perm]));
  };
  App.canApprove = (k) => App.rolePerm(k, 'approve', App.role(k).approve);
  App.isAdminRole = (k) => App.rolePerm(k, 'admin', App.role(k).admin);
  // The Reviews tab (the ready-for-review queue). Director and Producer by default.
  App.canSeeReviewQueue = (k) => App.rolePerm(k, 'reviewQueue', App.role(k).reviewQueue);
  // setting the queue's priority order by hand (drag a review up or down) — Producer by default
  App.canPrioritiseReviews = (k) => App.rolePerm(k, 'reviewPriority', App.role(k).reviewPriority);
  App.canManageShows = (k) => App.rolePerm(k, 'manageShows', App.role(k).manageShows);
  // Which roles may assign task owners — selectable in the Admin panel and
  // persisted in data.assignPriv. Until an admin changes it, the approver
  // (oversight) roles hold the privilege.
  App.defaultAssignPriv = () => App.ROLES.filter(r => r.approve).map(r => r.key);
  // the pure per-role answer, for Admin → Access Control's matrix; no sub-role
  // elevation, because the matrix is about roles rather than about the viewer
  App.assignPrivOf = function (k) {
    const priv = App.state && App.state.data && App.state.data.assignPriv;
    return priv ? priv.includes(k) : !!App.role(k).approve;
  };
  App.canAssignOwners = function (k) {
    const priv = App.state && App.state.data && App.state.data.assignPriv;
    const holds = (key) => priv ? priv.includes(key) : !!App.role(key).approve;
    return holds(k) || App.mySubRoles().some(holds);
  };
  App.roleDept = (k) => App.role(k).dept || null;
  App.canEditTask = function (k, task) {
    // editAll from either the base role or a sub-role opens every task; a
    // department role on its own stays scoped to its own department
    const keys = [k].concat(App.mySubRoles());
    if (keys.some(key => App.role(key).editAll)) return true;
    const r = App.role(k);
    if (r.dept && task) return task.dept === r.dept;
    return false;
  };
  /* Structural rights, checked on top of canEditTask (which stays the
     department-scoped "may I touch this task at all" gate for status, owners
     and files). These three are NOT department-scoped: a holder may reshape any
     task, because a plan change in one department moves work in the next. */
  App.canEditTaskName = (k) => App.rolePerm(k, 'editName', App.role(k).editName);
  App.canRemoveTask   = (k) => App.rolePerm(k, 'removeTask', App.role(k).removeTask);
  App.canEditSchedule = (k) => App.rolePerm(k, 'editSchedule', App.role(k).editSchedule);
  /* Highlighting tasks — Shift+click, the sweep, Opt+Shift, the ruler's Select
     Tasks — is the Producer's alone. Every other shortcut only changes what's
     on screen (open/close, filters, lists, the ruler), so it works for all. */
  App.canSelectTasks  = (k) => k === 'producer';
  // choosing which tasks need a Kick Off, and ticking them done — Producer and Director by default
  App.canSetKickOff   = (k) => App.rolePerm(k, 'kickOff', App.role(k).kickOff);
  /* ---- resourcing ----
     Who sees the Resources tab, and how much of the team. Unlike the switches
     above this is a three-way choice per role — 'none', 'team' (their own
     department) or 'all' — kept as a string in data.rolePerms[k].resourceView.
     Department roles default to 'team'; a role without a department can't see
     a team, so 'team' falls back to just themselves. Managing (allocations,
     capacity, contractors) is a plain switch, Manager by default. */
  App.RESOURCE_VIEWS = [['none', 'None'], ['team', 'Own team'], ['all', 'All']];
  const RV_RANK = { none: 0, team: 1, all: 2 };
  App.resourceViewOf = function (k) {
    const t = App.state && App.state.data && App.state.data.rolePerms;
    const v = t && t[k] && t[k].resourceView;
    if (v in RV_RANK) return v;
    const r = App.role(k);
    return r.resourceView || (r.dept ? 'team' : 'none');
  };
  // the widest of the base role and the viewer's sub-roles, like rolePerm
  App.resourceView = function (k) {
    return [k].concat(App.mySubRoles()).map(App.resourceViewOf)
      .reduce((a, b) => RV_RANK[b] > RV_RANK[a] ? b : a, 'none');
  };
  App.canSeeResources = (k) => App.resourceView(k) !== 'none';
  App.canManageResources = (k) => App.rolePerm(k, 'manageResources', App.role(k).manageResources);
  // the Timeline's Schedule / Resources switch — this device's choice, and
  // only Resources for a role that may see it
  App.timelineMode = () => App.prefs.get('timelineMode', 'schedule') === 'resources' && App.canSeeResources(App.state.role) ? 'resources' : 'schedule';

  /* Weekly load for the Resources grid, in working days. For each person and
     each week (keyed by its Monday):
       cap     — their days per week, less any of their own time off
       booked  — working days in the week with at least one of their open
                 (not approved) tasks. Tasks running side by side share the
                 day — two on Monday are half a day each, not two days — so a
                 week of overlapping tasks reads as a full week, not 2x
       tasks   — their open tasks that touch the week, as { ep, su }
       planned — their allocations: pct of capacity over the days in range
       off     — working days of time off */
  App.mondayIso = function (iso) {
    const d = App.parseDate(iso); const dow = (d.getDay() + 6) % 7;
    return App.isoDate(App.addDays(d, -dow));
  };
  const overlapWorkdays = (aS, aE, bS, bE) => {
    const s = aS > bS ? aS : bS, e = aE < bE ? aE : bE;
    return s > e ? 0 : App.visibleDayCount(s, e, true);
  };
  App.personCapacity = (p) => { const v = p && p.capacity && p.capacity.daysPerWeek; return typeof v === 'number' && v >= 0 ? v : 5; };
  App.resourceLoad = function (people, weeks) {
    const out = {};
    const tasks = {};
    App.activeEpisodes().forEach(ep => App.subitems(ep).forEach(su => {
      if (!su.assignee || su.status === 'approved') return;
      (tasks[su.assignee] = tasks[su.assignee] || []).push({ ep, su });
    }));
    const allocs = (App.state.data.allocations || []);
    people.forEach(p => {
      const base = App.personCapacity(p);
      out[p.id] = {};
      weeks.forEach(wk => {
        const end = App.shiftIso(wk, 4);
        const off = Math.min(5, (p.timeOff || []).reduce((n, t) => n + overlapWorkdays(wk, end, t.start, t.end || t.start), 0));
        const cap = base * (5 - off) / 5;
        const mine = (tasks[p.id] || []).filter(({ su }) => su.start <= end && su.due >= wk);
        let booked = 0;
        for (let i = 0; i < 5; i++) {
          const day = App.shiftIso(wk, i);
          if (mine.some(({ su }) => su.start <= day && su.due >= day)) booked++;
        }
        const planned = allocs.filter(a => a.personId === p.id)
          .reduce((n, a) => n + (+a.pct || 0) / 100 * base * overlapWorkdays(wk, end, a.start, a.end) / 5, 0);
        out[p.id][wk] = { cap, booked, planned, off, tasks: mine };
      });
    });
    return out;
  };

  // status choices a role may set (non-approvers can't choose Approved)
  App.statusOptionsFor = (k) => App.canApprove(k) ? App.STATUS_ORDER : App.STATUS_ORDER.filter(s => s !== 'approved');

  /* ---------------------------------------------------------------------------
     THE PIPELINE TEMPLATE — 27 subitems, top to bottom, from the board.
     `start`/`due` are Episode-1's real dates; other episodes shift these.
     `deps` are subitem keys that must be Approved before this can truly start.
     `status` is Episode-1's exact board state (other episodes derive their own).
  --------------------------------------------------------------------------- */
  App.TEMPLATE = [
    { key: 'core_premises', name: 'Core Premises', dept: 'creative',  start: '2025-11-04', due: '2025-11-10', deps: [],                                   status: 'approved'    },
    { key: 'design',        name: 'Design',        dept: 'creative',  start: '2025-11-11', due: '2025-11-14', deps: ['core_premises'],                    status: 'ready'       },
    { key: 'scripts',       name: 'Scripts',       dept: 'creative',  start: '2025-11-11', due: '2025-11-14', deps: ['core_premises'],                    status: 'ready'       },
    { key: 'storyboard',    name: 'Storyboard',    dept: 'creative',  start: '2025-11-17', due: '2025-11-21', deps: ['core_premises', 'scripts'],         status: 'ready'       },
    { key: 'music_skeleton',name: 'Music Skeleton',dept: 'music',     start: '2025-11-13', due: '2025-11-18', deps: ['core_premises', 'design', 'scripts'], status: 'ready'     },
    { key: 'vocal_records', name: 'Vocal Records', dept: 'music',     start: '2025-11-19', due: '2025-11-24', deps: ['music_skeleton'],                   status: 'approved'    },
    { key: 'vocal_comps',   name: 'Vocal Comps',   dept: 'music',     start: '2025-11-28', due: '2025-12-01', deps: ['vocal_records'],                    status: 'ready'       },
    { key: 'song_master',   name: 'Song Master',   dept: 'music',     start: '2025-12-02', due: '2025-12-09', deps: ['vocal_comps'],                      status: 'not_started' },
    { key: 'animatic_v1',   name: 'Animatic V1',   dept: 'creative',  start: '2025-11-19', due: '2025-11-25', deps: ['design', 'scripts', 'music_skeleton'], status: 'ready'    },
    { key: 'animatic_v2',   name: 'Animatic V2',   dept: 'creative',  start: '2025-12-01', due: '2025-12-05', deps: ['animatic_v1'],                      status: 'not_started' },
    { key: 'animatic_v3',   name: 'Animatic V3',   dept: 'creative',  start: '2025-12-08', due: '2025-12-12', deps: ['animatic_v2'],                      status: 'not_started' },
    { key: 'layout',        name: 'Layout',        dept: 'animation', start: '2025-12-15', due: '2025-12-26', deps: ['animatic_v3'],                      status: 'not_started' },
    { key: 'blocking',      name: 'Blocking',      dept: 'animation', start: '2025-12-29', due: '2026-01-03', deps: ['layout', 'wallah_v3'],              status: 'not_started' },
    { key: 'animation',     name: 'Animation',     dept: 'animation', start: '2026-01-05', due: '2026-01-21', deps: ['blocking'],                         status: 'not_started' },
    { key: 'lrc',           name: 'LRC',           dept: 'animation', start: '2026-01-22', due: '2026-01-30', deps: ['animation'],                        status: 'not_started' },
    { key: 'final_lrc',     name: 'Final LRC',     dept: 'animation', start: '2026-02-02', due: '2026-02-09', deps: ['lrc'],                              status: 'not_started' },
    { key: 'vo_records',    name: 'VO Records',    dept: 'audio',     start: '2025-11-24', due: '2025-11-27', deps: ['scripts'],                          status: 'in_progress' },
    { key: 'vo_comps',      name: 'VO Comps',      dept: 'audio',     start: '2025-11-28', due: '2025-12-01', deps: ['vo_records'],                        status: 'not_started' },
    { key: 'wallah_v1',     name: 'Wallah V1',     dept: 'audio',     start: '2025-12-15', due: '2025-12-19', deps: ['animatic_v3'],                      status: 'not_started' },
    { key: 'wallah_v2',     name: 'Wallah V2',     dept: 'audio',     start: '2025-12-22', due: '2025-12-24', deps: ['wallah_v1'],                        status: 'not_started' },
    { key: 'wallah_v3',     name: 'Wallah V3',     dept: 'audio',     start: '2025-12-25', due: '2026-01-02', deps: ['wallah_v2'],                        status: 'not_started' },
    { key: 'sfx_v1',        name: 'SFX V1',        dept: 'audio',     start: '2026-02-02', due: '2026-02-06', deps: ['lrc'],                              status: 'not_started' },
    { key: 'sfx_v2',        name: 'SFX V2',        dept: 'audio',     start: '2026-02-09', due: '2026-02-13', deps: ['sfx_v1'],                            status: 'not_started' },
    { key: 'sfx_v3',        name: 'SFX V3',        dept: 'audio',     start: '2026-02-16', due: '2026-02-20', deps: ['final_lrc', 'sfx_v2'],              status: 'not_started' },
    { key: 'subtitle',      name: 'Subtitle',      dept: 'video',     start: '2025-12-23', due: '2026-02-10', deps: ['scripts', 'final_lrc'],             status: 'not_started' },
    { key: 'deliverys',     name: 'Deliverys',     dept: 'ops',       start: '2026-02-10', due: '2026-02-21', deps: ['final_lrc', 'sfx_v3', 'subtitle'],  status: 'not_started' },
    { key: 'qc',            name: 'QC',            dept: 'qc',        start: '2026-02-11', due: '2026-02-22', deps: ['deliverys'],                         status: 'not_started' }
  ];
  App.TASK = (key) => App.TEMPLATE.find(t => t.key === key);
  App.taskName = (key) => { const t = App.TASK(key); return t ? t.name : key; };

  /* ---------------------------------------------------------------------------
     Per-show pipelines. A show created through Add Show carries its own
     pipeline: [{ key, name, dept, days, minDays, deps }] — durations instead
     of fixed dates (concrete dates are scheduled per episode at creation and
     stored in ep.dates). Seed/legacy shows fall back to a pipeline derived
     from TEMPLATE.
  --------------------------------------------------------------------------- */
  App.defaultPipeline = function () {
    return App.TEMPLATE.map(t => {
      const days = App.diffDays(t.due, t.start) + 1;
      const p = { key: t.key, name: t.name, dept: t.dept, days, minDays: Math.max(1, Math.ceil(days / 2)), deps: t.deps.slice() };
      if (t.lag) p.lag = t.lag;   // only carried when set, so existing pipelines are unchanged
      return p;
    });
  };
  // Live-action shows skip the animation stages and run a leaner post pipeline.
  App.LIVE_PIPELINE = [
    { key: 'scripts',        name: 'Scripts',         dept: 'creative', days: 4, minDays: 2, deps: [] },
    { key: 'footage_ingest', name: 'Footage Ingest',  dept: 'ops',      days: 2, minDays: 1, deps: ['scripts'] },
    { key: 'edit_v1',        name: 'Edit V1',         dept: 'video',    days: 7, minDays: 4, deps: ['footage_ingest'] },
    { key: 'edit_v2',        name: 'Edit V2',         dept: 'video',    days: 5, minDays: 3, deps: ['edit_v1'] },
    { key: 'picture_lock',   name: 'Picture Lock',    dept: 'video',    days: 3, minDays: 2, deps: ['edit_v2'] },
    { key: 'music_score',    name: 'Music Score',     dept: 'music',    days: 6, minDays: 3, deps: ['picture_lock'] },
    { key: 'sound_design',   name: 'Sound Design',    dept: 'audio',    days: 5, minDays: 3, deps: ['picture_lock'] },
    { key: 'vfx_cleanup',    name: 'VFX & Cleanup',   dept: 'animation',days: 6, minDays: 3, deps: ['picture_lock'] },
    { key: 'color_grade',    name: 'Color Grade',     dept: 'video',    days: 4, minDays: 2, deps: ['picture_lock'] },
    { key: 'final_mix',      name: 'Final Mix',       dept: 'audio',    days: 4, minDays: 2, deps: ['music_score', 'sound_design'] },
    { key: 'online_conform', name: 'Online Conform',  dept: 'video',    days: 3, minDays: 2, deps: ['color_grade', 'vfx_cleanup', 'final_mix'] },
    { key: 'subtitle',       name: 'Subtitle',        dept: 'ops',      days: 3, minDays: 2, deps: ['picture_lock'] },
    { key: 'deliverys',      name: 'Deliverys',       dept: 'ops',      days: 2, minDays: 1, deps: ['online_conform', 'subtitle'] },
    { key: 'qc',             name: 'QC',              dept: 'qc',       days: 2, minDays: 1, deps: ['deliverys'] }
  ];
  // The pipeline each show type ships with, before any Admin change.
  App.builtinPipelineFor = function (type) {
    if (type === 'live_action') return App.LIVE_PIPELINE.map(t => ({ ...t, deps: t.deps.slice() }));
    return App.defaultPipeline();
  };
  /* The pipeline a NEW show of this type starts from: the Admin's version from
     Admin → Workflow → Pipelines when one is saved, otherwise the built-in one.
     Always a deep copy. Existing shows with no stored pipeline keep running on
     the built-in one (App.showPipeline), so changing a default never replans
     a show that is already underway. */
  App.defaultPipelineFor = function (type) {
    const t = type === 'live_action' ? 'live_action' : 'animation';
    const custom = App.state.data && App.state.data.defaultPipelines && App.state.data.defaultPipelines[t];
    return Array.isArray(custom) && custom.length ? JSON.parse(JSON.stringify(custom)) : App.builtinPipelineFor(t);
  };
  App.isDefaultPipelineCustom = (type) => {
    const d = App.state.data && App.state.data.defaultPipelines;
    return !!(d && Array.isArray(d[type]) && d[type].length);
  };
  // An existing show's pipeline: its own copy, or the built-in one it has always run on.
  App.showPipeline = (show) => show.pipeline || App.builtinPipelineFor(show.type);

  App.pipelineFor = function (ep) {
    const show = ep && App.state.data && App.state.data.shows.find(s => s.id === ep.showId);
    // an episode locked while its show's pipeline changed keeps the pipeline
    // it was being made with (see App.replanShow)
    if (ep && ep.pipeline) return ep.pipeline;
    return (show && show.pipeline) || App.defaultPipeline();
  };
  App.pTask = (ep, key) => App.pipelineFor(ep).find(t => t.key === key);
  App.taskNameFor = function (ep, key) {
    if (ep.names && ep.names[key]) return ep.names[key];
    const t = App.pTask(ep, key); return t ? t.name : key;
  };

  /* ---------------------------------------------------------------------------
     Pipeline scheduling — dependency-aware forward pass.
     `scale` stretches (>1) or squeezes (<1) every task's nominal duration,
     but a task never drops below its minDays.
  --------------------------------------------------------------------------- */
  App.taskDuration = function (t, scale) {
    const s = scale == null ? 1 : scale;
    const days = t.days || 1, min = Math.min(t.minDays || 1, days);
    if (s >= 1) return Math.max(t.minDays || 1, Math.round(days * s));
    // squeeze (s < 1): shrink the SLACK (days − min), not the nominal duration,
    // so every task gives up the same fraction of its squeezable range and
    // none is ever pushed below its minimum. s=1 → nominal, s=0 → minimum.
    return min + Math.round((days - min) * s);
  };

  /* ---------------------------------------------------------------------------
     Working days & holidays.

     A show's calendar (show.calendar) says which days work happens on:
       workWeekends   Saturdays and Sundays count as working days
       region         'none' | 'uk' | 'us' — national holidays, by rule
       skipNational   national holidays the production works through, as
                      'uk:2026-12-25' — per country, so switching country
                      and back keeps the choices (a bare date is older data)
       offDays        [{ id, label, start, end, scope, target }]
                        scope 'show'   the whole production
                              'dept'   one department (target = dept key)
                              'role'   everyone in a role (target = role key;
                                       'director' also blocks Director reviews)
                              'person' one person (target = person id)
     Durations are working days: a 5-day task takes five days its department,
     role and owner are actually in — a holiday pushes the work back rather
     than shortening it. Without a calendar the scheduler counts calendar
     days, exactly as before.
  --------------------------------------------------------------------------- */
  App.normCal = function (c) {
    c = c || {};
    return {
      workWeekends: !!c.workWeekends,
      region: ['uk', 'us'].includes(c.region) ? c.region : 'none',
      skipNational: (c.skipNational || []).slice(),
      offDays: (c.offDays || []).filter(o => o && o.start).map(o => ({
        id: o.id || App.uid(), label: o.label || '', start: o.start, end: o.end && o.end >= o.start ? o.end : o.start,
        scope: ['show', 'dept', 'role', 'person'].includes(o.scope) ? o.scope : 'show', target: o.target || null
      }))
    };
  };
  App.calIsEmpty = (c) => { const n = App.normCal(c); return n.workWeekends && n.region === 'none' && !n.offDays.length; };

  // national holidays, worked out by rule so any year is right
  const iso3 = (y, m, d) => App.isoDate(new Date(y, m, d));
  const nthDow = (y, m, dow, n) => {          // n = 1..4, or -1 for the last
    if (n > 0) { const f = new Date(y, m, 1); const off = (dow - f.getDay() + 7) % 7; return iso3(y, m, 1 + off + (n - 1) * 7); }
    const l = new Date(y, m + 1, 0); const off = (l.getDay() - dow + 7) % 7; return iso3(y, m, l.getDate() - off);
  };
  const easter = (y) => {                      // anonymous Gregorian algorithm
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month - 1, day);
  };
  const dow = (iso) => App.parseDate(iso).getDay();
  App.nationalHolidays = function (region, fromIso, toIso) {
    if (region !== 'uk' && region !== 'us') return [];
    const out = [];
    const y0 = App.parseDate(fromIso).getFullYear(), y1 = App.parseDate(toIso).getFullYear();
    for (let y = y0; y <= y1; y++) {
      if (region === 'uk') {
        const e = easter(y);
        const list = [
          ['New Year’s Day', iso3(y, 0, 1)],
          ['Good Friday', App.isoDate(App.addDays(e, -2))],
          ['Easter Monday', App.isoDate(App.addDays(e, 1))],
          ['Early May bank holiday', nthDow(y, 4, 1, 1)],
          ['Spring bank holiday', nthDow(y, 4, 1, -1)],
          ['Summer bank holiday', nthDow(y, 7, 1, -1)]
        ];
        // a New Year on a weekend moves to the Monday
        if (dow(list[0][1]) === 6) list[0][1] = App.shiftIso(list[0][1], 2);
        else if (dow(list[0][1]) === 0) list[0][1] = App.shiftIso(list[0][1], 1);
        // Christmas and Boxing Day each take the next free weekday if they
        // fall on a weekend
        const taken = new Set();
        [['Christmas Day', iso3(y, 11, 25)], ['Boxing Day', iso3(y, 11, 26)]].forEach(([n, d]) => {
          let x = d;
          while (dow(x) === 0 || dow(x) === 6 || taken.has(x)) x = App.shiftIso(x, 1);
          taken.add(x); list.push([n + (x !== d ? ' (substitute)' : ''), x]);
        });
        list.forEach(([name, date]) => out.push({ name, date }));
      } else {
        // a fixed-date US holiday on Saturday is observed Friday, Sunday → Monday
        const obs = (d) => dow(d) === 6 ? App.shiftIso(d, -1) : dow(d) === 0 ? App.shiftIso(d, 1) : d;
        [
          ['New Year’s Day', obs(iso3(y, 0, 1))],
          ['Martin Luther King Jr. Day', nthDow(y, 0, 1, 3)],
          ['Presidents’ Day', nthDow(y, 1, 1, 3)],
          ['Memorial Day', nthDow(y, 4, 1, -1)],
          ['Juneteenth', obs(iso3(y, 5, 19))],
          ['Independence Day', obs(iso3(y, 6, 4))],
          ['Labor Day', nthDow(y, 8, 1, 1)],
          ['Columbus Day', nthDow(y, 9, 1, 2)],
          ['Veterans Day', obs(iso3(y, 10, 11))],
          ['Thanksgiving', nthDow(y, 10, 4, 4)],
          ['Christmas Day', obs(iso3(y, 11, 25))]
        ].forEach(([name, date]) => out.push({ name, date }));
      }
    }
    return out.filter(h => h.date >= fromIso && h.date <= toIso).sort((a, b) => a.date < b.date ? -1 : 1);
  };

  /* The calendar as something the scheduler can ask: is this day off for
     this piece of work? `who` = { dept, person, review } — `review` marks a
     Director review day. Built once per plan; national holidays are cached
     per year as they're needed. */
  App.makeCalendar = function (c, team) {
    const cal = App.normCal(c);
    const skip = new Set(cal.skipNational);
    const natCache = {};
    const national = (iso) => {
      if (cal.region === 'none') return null;
      const y = iso.slice(0, 4);
      if (!natCache[y]) {
        natCache[y] = {};
        App.nationalHolidays(cal.region, y + '-01-01', y + '-12-31').forEach(h => { natCache[y][h.date] = h.name; });
      }
      const n = natCache[y][iso];
      return n && !skip.has(cal.region + ':' + iso) && !skip.has(iso) ? n : null;
    };
    const within = (o, iso) => iso >= o.start && iso <= o.end;
    // the show's Directors — their personal time off blocks review days too
    const directors = team ? App.deptTeam({ team }, App.ROLE_SLOT + 'director').ids : [];
    const roleOf = (pid) => { const p = pid && App.person(pid); return p ? p.role : null; };
    const api = {
      cal,
      weekend: (iso) => !cal.workWeekends && (dow(iso) === 0 || dow(iso) === 6),
      national,
      // off for everyone on the production: weekend, national holiday, or a
      // whole-production off day
      prodOff: (iso) => api.weekend(iso) || !!national(iso) || cal.offDays.some(o => o.scope === 'show' && within(o, iso)),
      isOff(iso, who) {
        if (api.prodOff(iso)) return true;
        who = who || {};
        return cal.offDays.some(o => {
          if (!within(o, iso)) return false;
          if (o.scope === 'dept') return !who.review && o.target === who.dept;
          if (o.scope === 'role') {
            if (who.review) return o.target === 'director';
            return (o.target === who.dept && !who.person) || (!!who.person && roleOf(who.person) === o.target);
          }
          if (o.scope === 'person') return who.review ? directors.includes(o.target) : o.target === who.person;
          return false;
        });
      },
      // why a day is off for this work, in words — for clash messages
      reason(iso, who) {
        if (api.weekend(iso)) return 'the weekend';
        const nat = national(iso); if (nat) return nat;
        who = who || {};
        const o = cal.offDays.find(x => within(x, iso) && (x.scope === 'show' ||
          (x.scope === 'dept' && x.target === who.dept) ||
          (x.scope === 'role' && ((x.target === who.dept && !who.person) || (!!who.person && roleOf(who.person) === x.target))) ||
          (x.scope === 'person' && x.target === who.person)));
        if (!o) return null;
        const who2 = o.scope === 'person' ? (App.person(o.target) || {}).name || 'Someone'
          : o.scope === 'dept' ? App.dept(o.target).label
          : o.scope === 'role' ? App.role(o.target).label : 'the whole production';
        return who2 + ' off' + (o.label ? ' · ' + o.label : '');
      },
      // the first working day on or after iso
      nextWork(iso, who) { let x = iso, g = 0; while (api.isOff(x, who) && g++ < 400) x = App.shiftIso(x, 1); return x; },
      // the last day of `n` working days that start on (or after) iso
      addWork(iso, n, who) {
        let x = api.nextWork(iso, who), left = Math.max(1, n) - 1, g = 0;
        while (left > 0 && g++ < 2000) { x = App.shiftIso(x, 1); if (!api.isOff(x, who)) left--; }
        return x;
      }
    };
    return api;
  };
  // the calendar a show schedules by — null when it has none worth applying
  App.showCalendar = function (showOrId) {
    const show = typeof showOrId === 'string' ? App.state.data.shows.find(s => s.id === showOrId) : showOrId;
    if (!show || !show.calendar) return null;
    return App.makeCalendar(show.calendar, show.team);
  };

  /* Holiday clashes: open tasks whose dates include a day off for the people
     doing them — their department, role or owner. The scheduler never plans
     one, but work already under way, padlocked episodes, drags and time off
     added later can all leave one behind. Each needs a decision: hand the
     task to someone who's in, or shift it so it gets its full working days.
     `onlyKey` narrows to one episode task ("epId::taskKey"). */
  App.holidayClashes = function (showId, onlyKey) {
    const show = App.state.data.shows.find(s => s.id === showId);
    const cal = show && App.showCalendar(show);
    if (!cal) return [];
    const out = [];
    App.state.data.episodes.filter(e => e.showId === showId && !e.archived).forEach(ep => {
      App.subitems(ep).forEach(su => {
        if (su.status === 'approved') return;
        if (onlyKey && onlyKey !== ep.id + '::' + su.key) return;
        // time off this task has already been planned around (see App.markHolidayOk)
        const ok = App.holidayOkRanges(ep, su.key);
        const who = { dept: su.dept, person: su.assignee };
        const days = [];
        for (let x = su.start; x <= su.due; x = App.shiftIso(x, 1)) {
          // a weekend inside a task is only a clash when the show works weekends… which
          // then isn't off at all — so weekends never count here
          if (cal.weekend(x)) continue;
          if (cal.isOff(x, who) && !ok.some(r => x >= r[0] && x <= r[1])) days.push(x);
        }
        if (days.length) out.push({ ep, su, days, reason: cal.reason(days[0], who), cal, who });
      });
    });
    return out.sort((a, b) => a.su.start < b.su.start ? -1 : 1);
  };
  /* Resolving a clash (a shift or a holiday split) marks the dates the task
     then ran across as planned around. The mark is kept by date, not by the
     task's own dates, so moving the task later doesn't raise the same
     holiday again — only time off it hasn't been planned around yet counts.
     Stored per task as "start|due" ranges joined by commas. */
  App.holidayOkRanges = function (ep, key) {
    const v = ep.holidayOk && ep.holidayOk[key];
    return v ? String(v).split(',').map(r => r.split('|')).filter(r => r.length === 2) : [];
  };
  App.markHolidayOk = function (e, key, start, due) {
    e.holidayOk = e.holidayOk || {};
    const ranges = App.holidayOkRanges(e, key).filter(r => !(r[0] === start && r[1] === due));
    ranges.push([start, due]);
    e.holidayOk[key] = ranges.map(r => r.join('|')).join(',');
  };
  App.hasHolidayClash = (ep, su) => App.holidayClashes(ep.showId, ep.id + '::' + su.key).length > 0;

  /* The revisions that can follow a task's pass ending `due`: V(n+1), V(n+2)…
     back to back, each its task's own people's working days. The Director's
     review sits between versions but takes no scheduled time of its own — the
     next version only starts once the Director sends the task back for it
     (App.requestRevision). `used` revisions are already inside the pass.
     A pipeline can also hold a version back: t.revGaps[r] is the days planned
     for review before revision r starts (0 or missing = straight after the
     one before, as always). Set by dragging a revision in the Add Show
     preview. opts.now: the first version is being started now — the review
     has happened, so its gap no longer applies.
     Returns { revs, end }. */
  App.hasRevGaps = (t) => !!(t && Array.isArray(t.revGaps) && t.revGaps.slice(0, t.maxRev || 0).some(n => n > 0));
  App.revGap = (t, r) => Math.max(0, Math.round((t && t.revGaps && t.revGaps[r]) || 0));
  App.revisionSteps = function (t, due, cal, who, used, opts) {
    const out = { revs: [], end: due };
    const max = (t && t.maxRev) || 0;
    if (!max) return out;
    let at = due;
    for (let r = used || 0; r < max; r++) {
      const n = Math.max(1, (t.revDays || [])[r] || 1);
      const gap = opts && opts.now && r === (used || 0) ? 0 : App.revGap(t, r);
      // the gap is counted in the same days as the work — working days on a calendar
      if (gap) at = cal ? cal.addWork(cal.nextWork(App.shiftIso(at, 1), who), gap, who) : App.shiftIso(at, gap);
      const s0 = cal ? cal.nextWork(App.shiftIso(at, 1), who) : App.shiftIso(at, 1);
      const e0 = cal ? cal.addWork(s0, n, who) : App.shiftIso(at, n);
      out.revs.push({ start: s0, due: e0, label: 'V' + (r + 2), idx: r });
      at = e0;
    }
    out.end = at;
    return out;
  };

  // Kahn topological sort; returns ordered keys, or null on a dependency cycle
  App.topoSort = function (pipeline) {
    const indeg = {}, out = {};
    pipeline.forEach(t => { indeg[t.key] = indeg[t.key] || 0; });
    pipeline.forEach(t => t.deps.forEach(d => {
      if (indeg[d] === undefined) return;           // dep points at a removed task
      indeg[t.key]++; (out[d] = out[d] || []).push(t.key);
    }));
    const q = pipeline.filter(t => !indeg[t.key]).map(t => t.key);
    const order = [];
    while (q.length) {
      const k = q.shift(); order.push(k);
      (out[k] || []).forEach(n => { if (--indeg[n] === 0) q.push(n); });
    }
    return order.length === pipeline.length ? order : null;
  };

  // Forward pass: each task starts the day after its last dependency finishes
  // (or on startIso if unblocked). Returns { dates: {key:{start,due}}, end } —
  // `end` is the critical-path finish — or null if the deps contain a cycle.
  // An optional `lag` holds a task back instead: it starts that many days after
  // its dependency's finish rather than the next day, which is how a fixed
  // waiting period is expressed (Live Date sits 4 weeks past QC). The lag is a
  // commitment to an outside party, so squeeze/stretch never scales it.
  //
  // Shows are planned for the worst case: every task is assumed to spend its
  // whole revision budget, versions back to back with no gap for the review
  // between them (App.REVIEW_DAYS is 0). So a task runs
  //     V1 · V2 · … · last version
  // and its dependents wait for the last version, not the first pass.
  // `dates[k].due` is still the first pass — the date the work is due for
  // review — and everything between it and `done[k]` is held in reserve.
  // Sending a task back (App.requestRevision) stretches its due date into
  // that reserve, so it never pushes a dependent and never counts the same
  // days twice. opts.withRevisions: false leaves the revisions out.
  App.REVIEW_DAYS = 0;
  App.KO_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // "Thursday", or "Thursday · 2 weeks on" when held back past the first one
  App.koLabel = (t) => t.koDay == null ? 'Kick Off'
    : App.KO_DAYS[t.koDay] + (t.koWeeks > 0 ? ' · ' + t.koWeeks + ' week' + (t.koWeeks === 1 ? '' : 's') + ' on' : '');
  App.schedulePipeline = function (pipeline, startIso, scale, opts) {
    const order = App.topoSort(pipeline); if (!order) return null;
    const withRev = !(opts && opts.withRevisions === false);
    // opts.cal (App.makeCalendar) switches durations to working days;
    // opts.assignees ({ taskKey: personId }) lets personal holidays count
    const cal = (opts && opts.cal) || null;
    const assignees = (opts && opts.assignees) || {};
    const byKey = {}; pipeline.forEach(t => { byKey[t.key] = t; });
    // `dates` is stored on episodes as-is, so `done` lives apart from it and
    // is only handed back when asked for
    const dates = {}, done = {}, ready = {}; let end = startIso;
    const fixed = (opts && opts.fixed) || {};
    order.forEach(k => {
      const t = byKey[k];
      // a batch task already scheduled by its group's first episode keeps
      // those dates here — see App.scheduleEpisodes
      if (fixed[k]) {
        dates[k] = { start: fixed[k].start, due: fixed[k].due };
        done[k] = fixed[k].done;
        if (done[k] > end) end = done[k];
        return;
      }
      // a batch run spaced out on the calendar can't start before its slot
      let s = (opts && opts.notBefore && opts.notBefore[k] > startIso) ? opts.notBefore[k] : startIso;
      t.deps.forEach(d => {
        if (!dates[d]) return;
        const next = App.shiftIso(done[d], t.lag > 0 ? t.lag : 1);
        if (next > s) s = next;
      });
      // with a calendar, the task's days are its people's working days
      const who = cal ? { dept: t.dept, person: assignees[k] || null } : null;
      if (cal) s = cal.nextWork(s, who);           // work can't begin on a day off
      /* A Kick Off is a one-day meeting held on a set weekday (t.koDay,
         0 = Sunday … 6 = Saturday): it waits for the next one once its
         dependencies are done. Left unset, it's simply the next working day. */
      // t.koWeeks holds it back that many more weeks, on the same weekday
      ready[k] = s;
      if (t.ko && t.koDay != null) {
        for (let i = 0; i < 7 && App.parseDate(s).getDay() !== t.koDay; i++) s = App.shiftIso(s, 1);
        if (t.koWeeks > 0) s = App.shiftIso(s, 7 * t.koWeeks);
        if (cal) s = cal.nextWork(s, who);
      }
      const dur = t.ko ? 1 : App.taskDuration(t, scale);
      const due = cal ? cal.addWork(s, dur, who) : App.shiftIso(s, dur - 1);
      // worst case: every revision spent, back to back after the first pass
      const steps = t.maxRev > 0 && withRev ? App.revisionSteps(t, due, cal, who, 0) : null;
      done[k] = steps ? steps.end : due;
      dates[k] = { start: s, due };
      if (done[k] > end) end = done[k];
    });
    return { dates, done, end, ready };
  };

  /* Batch tasks — the Timeline's Batch Set Dates rule, applied to a pipeline
     task across the episodes of a show, in episode order:
       fixed    one run shared by every episode ("Same start")
       stagger  a run per episode, spaced `every` `unit` apart
       group    a run per `size` episodes, groups spaced `every` `unit` apart
     Spacing is a count of days or weeks from the first episode's kick-off —
     never a calendar date — and only ever holds a run back; it never pulls
     one ahead of its dependencies. every = 0 means no spacing: runs follow
     the episode rate.
     Stored as t.batch = { mode, size, every, unit }. A bare number is an
     older form of group-of-N. */
  App.batchCfg = function (t) {
    const b = t && t.batch;
    if (!b) return null;
    if (typeof b === 'number') return b >= 2 ? { mode: 'group', size: Math.floor(b), every: 0, unit: 'week' } : null;
    const mode = ['fixed', 'stagger', 'group'].includes(b.mode) ? b.mode : 'group';
    return {
      mode,
      size: Math.max(1, Math.min(99, parseInt(b.size, 10) || 2)),
      every: Math.max(0, Math.min(365, parseInt(b.every, 10) || 0)),
      unit: b.unit === 'day' ? 'day' : 'week'
    };
  };
  App.batchGroup = (cfg, i) => cfg.mode === 'fixed' ? 0 : cfg.mode === 'stagger' ? i : Math.floor(i / cfg.size);
  App.batchLabel = function (t) {
    const c = App.batchCfg(t); if (!c) return '';
    const unit = c.unit;
    const every = c.every ? ' · every ' + c.every + ' ' + unit + (c.every === 1 ? '' : 's') : '';
    return c.mode === 'fixed' ? 'Same start' : c.mode === 'stagger' ? 'Stagger' + every : 'Groups of ' + c.size + every;
  };

  // calendar arithmetic: "a week" is seven calendar dates, and month-ends
  // clamp (Jan 31 + 1 month = Feb 28)
  App.addInterval = function (iso, n, unit) {
    if (!n) return iso;
    if (unit === 'day') return App.shiftIso(iso, n);
    if (unit === 'week') return App.shiftIso(iso, n * 7);
    const d = App.parseDate(iso), day = d.getDate();
    const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    t.setDate(Math.min(day, last));
    return App.isoDate(t);
  };

  /* Every episode of a show, scheduled together — which only matters once a
     pipeline has a batch task. The first episode of each run's group
     schedules it; the rest of the group take those same dates, so their own
     downstream work waits on the one shared piece rather than each doing it
     again. Each result carries `group` — { taskKey: group index } — for the
     episode to store, so an edit to the shared task can reach every episode
     in its group (App.syncBatch). `starts` is each episode's kick-off date.
     Null on a dependency cycle. */
  App.scheduleEpisodes = function (pipeline, starts, scale, opts) {
    const batched = pipeline.map(t => ({ t, cfg: App.batchCfg(t) })).filter(b => b.cfg);
    const leads = {};               // "taskKey:group" -> the lead episode's schedule
    const out = [];
    for (let i = 0; i < starts.length; i++) {
      const fixed = {}, group = {}, notBefore = {};
      batched.forEach(({ t, cfg }) => {
        const g = App.batchGroup(cfg, i);
        group[t.key] = g;
        const L = leads[t.key + ':' + g];
        if (L) fixed[t.key] = { start: L.dates[t.key].start, due: L.dates[t.key].due, done: L.done[t.key] };
        else if (cfg.every && cfg.mode !== 'fixed') notBefore[t.key] = App.shiftIso(starts[0], g * cfg.every * (cfg.unit === 'week' ? 7 : 1));
      });
      // opts.assigneesFor(i) — who owns each task in episode i, for personal holidays
      const assignees = opts && opts.assigneesFor ? opts.assigneesFor(i) : (opts && opts.assignees);
      const sch = App.schedulePipeline(pipeline, starts[i], scale, Object.assign({}, opts, { fixed, notBefore, assignees }));
      if (!sch) return null;
      batched.forEach(({ t }) => { const k = t.key + ':' + group[t.key]; if (!leads[k]) leads[k] = sch; });
      sch.group = group;
      out.push(sch);
    }
    return out;
  };

  // Whole-show schedule: episode i kicks off at startIso + i*cadence days.
  // Project end = whichever episode finishes last — usually the last one, but
  // with batch tasks a later episode can reuse work an earlier one waited for.
  App.scheduleShow = function (pipeline, startIso, epCount, cadence, scale, opts) {
    const starts = [];
    for (let i = 0; i < Math.max(1, epCount); i++) starts.push(App.shiftIso(startIso, i * cadence));
    const eps = App.scheduleEpisodes(pipeline, starts, scale, opts);
    if (!eps) return null;
    return { end: eps.reduce((m, e) => e.end > m ? e.end : m, eps[0].end) };
  };

  // Largest scale whose project end still fits targetIso (binary search over a
  // monotonic end(scale)). scale=0 means every task at its minDays — the floor.
  App.solveScale = function (pipeline, startIso, epCount, cadence, targetIso, opts) {
    const floor = App.scheduleShow(pipeline, startIso, epCount, cadence, 0, opts);
    if (!floor) return null;
    if (targetIso <= floor.end) return { scale: 0, end: floor.end, clamped: targetIso < floor.end };
    let lo = 0, hi = 1;
    while (hi < 16 && App.scheduleShow(pipeline, startIso, epCount, cadence, hi, opts).end < targetIso) hi *= 2;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (App.scheduleShow(pipeline, startIso, epCount, cadence, mid, opts).end <= targetIso) lo = mid; else hi = mid;
    }
    return { scale: lo, end: App.scheduleShow(pipeline, startIso, epCount, cadence, lo, opts).end, clamped: false };
  };

  /* Status derivation for freshly scheduled episodes (same rules as
     deriveStatuses below, but driven by concrete per-task dates).

     A passed due date lands on In Progress rather than Ready for Review: a
     date can say work should be FINISHED, but only an upload can say there's
     something to watch (see App.review.denyReady in js/reviewflow.js). A new
     episode has nothing uploaded by definition, so deriving Ready for Review
     here would manufacture exactly the state that gate exists to prevent —
     and put a review on Post Operations' desk with no cut behind it. */
  App.deriveStatusesFromDates = function (pipeline, dates, assignees) {
    const today = App.today();
    const status = {};
    pipeline.forEach(t => {
      const d = dates[t.key];
      if (!d) { status[t.key] = 'not_started'; return; }
      /* Dates in the past don't say the work happened: a show entered with
         a start behind today is still the producer's to mark up, so nothing
         is set approved or under way from the calendar alone. */
      status[t.key] = 'not_started';
    });
    for (let pass = 0; pass < 4; pass++) {
      pipeline.forEach(t => {
        const depsOK = t.deps.every(d => status[d] === 'approved' || status[d] === undefined);
        if (['approved', 'review', 'in_progress'].includes(status[t.key]) && !depsOK) {
          status[t.key] = 'not_started';
        } else if (status[t.key] === 'not_started' && depsOK && (
                   // owned tasks with no dependencies are ready from day one
                   (!t.deps.length && assignees && assignees[t.key]) ||
                   (dates[t.key] && App.parseDate(dates[t.key].start) <= App.addDays(today, 10)))) {
          status[t.key] = 'ready';
        }
      });
    }
    return status;
  };

  /* ---------------------------------------------------------------------------
     Date helpers (ISO 'YYYY-MM-DD' <-> Date at local midnight)
  --------------------------------------------------------------------------- */
  App.parseDate = function (iso) { return new Date(iso + 'T00:00:00'); };
  App.isoDate = function (date) {
    const d = new Date(date);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  App.addDays = function (date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; };
  App.shiftIso = function (iso, days) { return App.isoDate(App.addDays(App.parseDate(iso), days)); };
  App.diffDays = function (a, b) { return Math.round((App.parseDate(a) - App.parseDate(b)) / 86400000); };
  // "Visible day" variants used by the timeline's hide-weekends preference and
  // its drag-to-reschedule math — a visible day is any calendar day when
  // hideWeekends is false, or a weekday when it's true.
  App.addVisibleDays = function (iso, n, hideWeekends) {
    if (!hideWeekends || n === 0) return App.shiftIso(iso, n);
    let d = App.parseDate(iso);
    const step = n > 0 ? 1 : -1;
    let remaining = Math.abs(n);
    while (remaining > 0) {
      d = App.addDays(d, step);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) remaining--;
    }
    return App.isoDate(d);
  };
  App.visibleDayCount = function (startIso, dueIso, hideWeekends) {
    if (!hideWeekends) return App.diffDays(dueIso, startIso) + 1;
    let d = App.parseDate(startIso); const end = App.parseDate(dueIso); let n = 0;
    while (d <= end) { const dow = d.getDay(); if (dow !== 0 && dow !== 6) n++; d = App.addDays(d, 1); }
    return n;
  };
  App.daysUntil = function (iso) { return Math.round((App.parseDate(iso) - App.today()) / 86400000); };
  App.fmtDate = function (iso) {
    const d = App.parseDate(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  App.fmtRange = function (a, b) {
    const da = App.parseDate(a), db = App.parseDate(b);
    const sameMonth = da.getMonth() === db.getMonth() && da.getFullYear() === db.getFullYear();
    if (sameMonth) return da.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' – ' + db.getDate();
    return App.fmtDate(a) + ' – ' + App.fmtDate(b);
  };

  /* Keyboard shortcuts read in the platform's own idiom — ⌘ on a Mac, Ctrl
     everywhere else — so a hint never tells someone to press a key they
     haven't got. */
  App.isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  App.shortcutLabel = (keys) => (App.isMac ? '⌘' : 'Ctrl+') + keys;

  /* Phone mode — driven by viewport width, not device sniffing, so a narrow
     desktop window and a real phone get the same treatment (and a tablet or
     a phone turned sideways doesn't). Timeline and Planning are dense,
     drag-and-resize, hover-tooltip surfaces that don't survive a touch
     screen at this width, so phone mode drops them from the tab bar
     entirely (see renderViewTabs in render.js) rather than trying to cram
     them in — Dashboard, Board and (role permitting) Admin cover what's
     actually usable one-handed.
     The matchMedia listener means rotating a phone or resizing a test
     window flips the mode live — App.render() re-derives the tab bar and
     the phone/desktop redirect guard on every call, so nothing needs to
     poll. Same breakpoint as the CSS "phone" media query in style.css —
     keep the two numbers in sync if either ever changes. */
  const PHONE_MQ = window.matchMedia('(max-width: 640px)');
  App.isPhone = () => PHONE_MQ.matches;
  PHONE_MQ.addEventListener('change', () => { if (App.state.data) App.render(); });

  App.uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  App.initials = (name) => name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

  /* ---------------------------------------------------------------------------
     Per-episode subitem expansion. Each episode stores a status + assignee map
     keyed by template key; dates derive from template + episode.shiftDays.
  --------------------------------------------------------------------------- */
  App.subitems = function (ep) {
    const removed = ep.removed || [];
    const pipe = App.pipelineFor(ep);
    return pipe.filter(t => !removed.includes(t.key)).map(t => {
      const dOv = ep.dates && ep.dates[t.key];
      const tpl = App.TASK(t.key);      // template dates — legacy/seed episodes only
      let start, due;
      if (dOv) { start = dOv.start; due = dOv.due; }
      else if (tpl) { start = App.shiftIso(tpl.start, ep.shiftDays || 0); due = App.shiftIso(tpl.due, ep.shiftDays || 0); }
      else { start = App.isoDate(App.today()); due = App.shiftIso(start, (t.days || 1) - 1); }
      // unsaved Timeline changes show as if made (see js/draft.js)
      const dr = App.timelineDraft && App.timelineDraft.dates(ep.id, t.key);
      if (dr) { start = dr.start; due = dr.due; }
      return {
        key: t.key,
        name: (ep.names && ep.names[t.key]) || t.name,
        dept: t.dept,
        deps: t.deps.filter(d => !removed.includes(d) && pipe.some(p => p.key === d)),
        start, due,
        status: (ep.statuses && ep.statuses[t.key]) || 'not_started',
        assignee: (ep.assignees && ep.assignees[t.key]) || null
      };
    });
  };
  App.subitem = function (ep, key) { return App.subitems(ep).find(s => s.key === key); };

  /* ---- Kick Offs (KO) ----
     The Director's in-person/call briefing of a department before its work on
     an episode starts. The show carries the usual list (show.koTasks); an
     episode follows it until someone changes that episode's own list, when it
     is snapshotted into ep.ko = { tasks, done: { key: {by, at} } } and stops
     following. Departments aren't stored — a department "needs a KO" when any
     of its tasks does. Keys for tasks since removed are simply ignored. */
  App.epKoTasks = function (ep) {
    const list = ep.ko ? ep.ko.tasks : ((App.show(ep.showId) || {}).koTasks || []);
    const live = App.subitems(ep).map(s => s.key);
    return (list || []).filter(k => live.includes(k));
  };
  App.koState = function (ep, key) {
    if (!App.epKoTasks(ep).includes(key)) return null;
    return ep.ko && ep.ko.done && ep.ko.done[key] ? 'done' : 'needed';
  };
  /* A Kick Off is due on its booked day (App.koDate) and overdue once that day has
     passed without it being done. One definition, used by the Board, Edit Task
     and the Director's calendar alike — a warning, never a block. */
  /* The day a Kick Off is booked for: a date picked when it was added
     (ep.ko.dates, for a last-minute unscheduled KO), otherwise the task's start. */
  App.koDate = (ep, su) => (ep.ko && ep.ko.dates && ep.ko.dates[su.key]) || su.start;
  App.koOverdue = function (ep, su) {
    return App.koState(ep, su.key) === 'needed' && App.koDate(ep, su) < App.isoDate(App.today());
  };
  /* One calendar item per (episode, department) briefing that still has an
     outstanding task, dated on the earliest start among those outstanding
     tasks — the day the briefing is due. */
  App.koItems = function (eps) {
    const out = [];
    eps.forEach(ep => {
      const keys = App.epKoTasks(ep); if (!keys.length) return;
      const byDept = {};
      App.subitems(ep).forEach(su => {
        if (!keys.includes(su.key)) return;
        (byDept[su.dept] = byDept[su.dept] || []).push(su);
      });
      Object.keys(byDept).forEach(dept => {
        const subs = byDept[dept];
        const open = subs.filter(su => App.koState(ep, su.key) === 'needed');
        if (!open.length) return;
        const date = open.map(su => App.koDate(ep, su)).sort()[0];
        out.push({ ep, dept, subs, open, date });
      });
    });
    return out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  };

  // a subitem is blocked if any (non-removed) dependency isn't approved yet
  App.isBlocked = function (ep, key) {
    const t = App.pTask(ep, key); if (!t) return false;
    const removed = ep.removed || [];
    const deps = t.deps.filter(d => !removed.includes(d));
    if (!deps.length) return false;
    return deps.some(d => ((ep.statuses && ep.statuses[d]) || 'not_started') !== 'approved');
  };
  // can it legitimately start right now? all deps approved & not yet done
  App.isStartable = function (ep, key) {
    const st = (ep.statuses && ep.statuses[key]) || 'not_started';
    return st === 'not_started' && !App.isBlocked(ep, key);
  };
  // a genuine risk: work that is being acted on (In Progress / In Review) while a
  // dependency still isn't Approved. (A not-started/ready task merely "waiting" isn't flagged.)
  App.isRiskBlocked = function (ep, key) {
    const st = (ep.statuses && ep.statuses[key]) || 'not_started';
    return (st === 'in_progress' || st === 'review') && App.isBlocked(ep, key);
  };

  /* ---------------------------------------------------------------------------
     Revisions — a task's budget for being sent back.

     A pipeline task optionally carries `maxRev` (how many times it can be
     bounced) and `revDays` (one duration per revision, since a first pass
     tends to need longer than a polish). Neither is squeezable. The schedule
     plans for the worst case — dependents wait for the whole budget (see
     App.schedulePipeline) — but a task's own due date only grows into that
     reserve when a Director actually spends a revision (App.requestRevision
     in main.js). What's reserved but never spent is left visible rather than
     silently forgotten — see revisionGhostDays below.
  --------------------------------------------------------------------------- */
  /* A task's pipeline entry with this episode's own version lengths laid
     over it. A version dragged longer or shorter on the Timeline is stored
     per episode (ep.revDays[key][r] = days, sparse), so one episode's V2
     can run long without touching the show's pipeline. Anything not set
     falls back to the pipeline's own days. */
  App.revTask = function (ep, key) {
    const t = App.pTask(ep, key);
    const own = ep && ep.revDays && ep.revDays[key];
    if (!t || !own) return t;
    const days = (t.revDays || []).slice();
    own.forEach((n, r) => { if (n > 0) days[r] = n; });
    return Object.assign({}, t, { revDays: days });
  };
  // how many of a task's budgeted revisions this episode has actually spent
  App.revisionsUsed = function (ep, key) { return (ep.revisions && ep.revisions[key]) || 0; };
  App.taskRevisions = function (ep, key) {
    const t = App.revTask(ep, key);
    const max = Math.max(0, (t && t.maxRev) || 0);
    const days = (t && t.revDays) || [];
    const used = App.revisionsUsed(ep, key);
    return { max, days, used, left: Math.max(0, max - used) };
  };
  /* Revision time that was budgeted and never spent, still on the books after
     the task closed out — the "it never needed the worst case" slack a
     producer might want to see at a glance, and later reclaim. Nothing to
     show for a task still open (it might yet use them) or once the producer
     has explicitly cleared it (see App.clearRevisionGhost). */
  App.revisionGhostDays = function (ep, su) {
    if (su.status !== 'approved') return 0;
    if (ep.revisionsCleared && ep.revisionsCleared[su.key]) return 0;
    const { days, used } = App.taskRevisions(ep, su.key);
    return days.slice(used).reduce((a, n) => a + (n || 0), 0);
  };

  /* The revisions still ahead of an open task — the reserve the worst-case
     schedule holds for it (App.schedulePipeline), laid out back to back from
     the task's current due date: V2 · V3 · …
     Revisions already spent are inside the bar (App.requestRevision grew the
     due date), so the next version number follows on from them. An approved
     task has nothing ahead (its unspent budget is the grey ghost instead). */
  App.plannedRevisions = function (ep, su) {
    if (su.status === 'approved') return { revs: [], end: su.due };
    const t = App.revTask(ep, su.key);
    if (!t || !t.maxRev) return { revs: [], end: su.due };
    return App.revisionSteps(t, su.due, App.showCalendar(ep.showId),
      { dept: su.dept, person: su.assignee }, App.revisionsUsed(ep, su.key));
  };

  /* What a proposed reschedule of one task would break.

     Dependencies are an ordering promise: a task may not start until everything
     it depends on has finished. Moving a bar can break that from either side —
     drag it earlier and it can open before its own inputs are done; drag it
     later, or stretch its tail, and it can run past the start of whatever was
     waiting on it. Both are collected here, each with the overlap in days, so
     the producer is shown the cost before it's paid rather than told afterwards.

     Nothing cascades: only the dragged task moves, which is why every other
     task in the result keeps its current dates. Pure — safe to call while
     dragging.

     `alsoMoving` is the exception, and only for a group drag: a map of
     taskKey -> {start, due} for the OTHER tasks travelling in the same gesture.
     Without it a group move reads as a wall of clashes between tasks that are
     all moving together and so never actually collide — the ordering between
     two selected tasks is preserved by the move, not broken by it. */
  App.scheduleImpact = function (ep, key, newStart, newDue, alsoMoving) {
    const pipe = App.pipelineFor(ep);
    const task = pipe.find(t => t.key === key);
    const byKey = {};
    let moved = null;
    App.subitems(ep).forEach(s => {
      if (s.key === key) moved = s;              // always its dates as they stand — that's `from`
      const to = alsoMoving && alsoMoving[s.key];
      byKey[s.key] = (to && s.key !== key) ? Object.assign({}, s, { start: to.start, due: to.due }) : s;
    });
    const clashes = [];

    /* `earlyBy` is how badly the ordering is violated — the days between the
       finish that should gate the start and that start, inclusive. Deliberately
       not called an overlap: a dependent scheduled long before its input isn't
       overlapping it at all, it's simply far too early, and calling 77 days of
       that "overlap" would misdescribe a number the producer decides on. */
    (task ? task.deps : []).forEach(dk => {
      const dep = byKey[dk];
      if (dep && newStart <= dep.due) {
        clashes.push({
          dir: 'upstream', task: dep,
          earlyBy: App.diffDays(dep.due, newStart) + 1,
          text: 'would start before “' + dep.name + '” finishes'
        });
      }
    });
    // downstream: something waiting on this task would now start too early
    pipe.forEach(t => {
      if (t.key === key || !t.deps.includes(key)) return;
      const dependent = byKey[t.key];
      if (dependent && dependent.start <= newDue) {
        clashes.push({
          dir: 'downstream', task: dependent,
          earlyBy: App.diffDays(newDue, dependent.start) + 1,
          text: 'starts before this would finish'
        });
      }
    });

    /* The two committed dates put a hard edge round the work.

       Nothing may run to or past the live date: the episode is out by then, so
       there is no work left to do — that move is refused outright, not argued
       about. Running to or past the DELIVERY date is a real thing producers
       sometimes have to do, but it can't happen quietly: the delivery date is a
       promise, so the honest response is to move the promise, and that's what
       the mover is offered.

       A shifted delivery date still has to land before the live date. When it
       can't, there's no room left to deliver and the move is refused for that
       reason instead — which is the same refusal, arrived at one step later. */
    const ms = App.epMilestones(ep);
    const liveMs = ms.find(m => m.key === App.LIVE_KEY) || null;
    const delMs = ms.find(m => m.key !== App.LIVE_KEY) || null;
    let deny = null, delivery = null;
    if (moved) {
      if (liveMs && newDue >= liveMs.date) {
        deny = {
          ms: liveMs,
          text: '“' + moved.name + '” would run to ' + App.fmtDate(newDue) +
                ', on or past the live date (' + App.fmtDate(liveMs.date) + ')'
        };
      } else if (delMs && newDue >= delMs.date) {
        const suggest = App.shiftIso(newDue, delMs.afterQc);
        if (liveMs && suggest >= liveMs.date) {
          deny = {
            ms: delMs,
            text: 'There would be no room left to deliver — the work would finish ' +
                  App.fmtDate(newDue) + ', and the episode goes live ' + App.fmtDate(liveMs.date)
          };
        } else {
          delivery = {
            ms: delMs, suggest: suggest,
            // 0 = lands exactly on the delivery date
            pastBy: App.diffDays(newDue, delMs.date)
          };
        }
      }
    }

    return {
      moved: moved,
      from: moved ? { start: moved.start, due: moved.due } : null,
      to: { start: newStart, due: newDue },
      shiftDays: moved ? App.diffDays(newStart, moved.start) : 0,
      clashes: clashes,
      deny: deny,
      delivery: delivery
    };
  };

  /* ---------------------------------------------------------------------------
     Episode-derived metrics
  --------------------------------------------------------------------------- */
  App.show = (id) => App.state.data.shows.find(s => s.id === id) || { name: '—', color: '#888' };
  App.person = (id) => App.state.data.people.find(p => p.id === id) || null;

  /* ---------------------------------------------------------------------------
     Production team (a show's staffing, by department)

     A show's pipeline says what work exists; its team says who does it.
     `show.team` maps a department key to the staff assigned to it on this show
     plus which of them leads it:

       show.team = { audio: { ids: ['chris', 'noah'], lead: 'chris' } }

     Only departments the show's own pipeline actually uses are ever staffed —
     a show with no music tasks has no music team to fill in. Reads go through
     App.deptTeam so a person deleted in Admin drops out of every show that had
     them, rather than leaving an id nothing resolves to.
  --------------------------------------------------------------------------- */
  App.pipelineDepts = function (pipeline) {
    const out = [];
    (pipeline || []).forEach(t => { if (t.dept && !out.includes(t.dept)) out.push(t.dept); });
    // department order follows the workflow's own, not first-task-wins, so the
    // team page reads in the same order as every other department list
    const order = Object.keys(App.DEPARTMENTS);
    return out.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  };
  App.showDepts = (show) => App.pipelineDepts((show && show.pipeline) || App.TEMPLATE);

  // Who may be staffed to a department: the same pool the task Owner picker
  // offers, so a lead can always actually own that department's tasks.
  App.deptStaff = (dept) => (App.state.data.people || []).filter(p => App.roleDept(p.role) === dept);

  App.deptTeam = function (show, dept) {
    const t = ((show && show.team) || {})[dept] || {};
    const ids = (t.ids || []).filter(id => App.person(id));
    // one person on a department leads it whether or not anyone starred them
    const lead = ids.includes(t.lead) ? t.lead : (ids.length === 1 ? ids[0] : null);
    return { ids, lead };
  };
  App.deptLead = (show, dept) => App.deptTeam(show, dept).lead;

  /* The staff a task should fall to, best first: this show's team for that
     department (its lead ahead of the rest), or — for a show with no team on
     that department — every staff member who could do the work. */
  App.deptPool = function (show, dept) {
    const { ids, lead } = App.deptTeam(show, dept);
    if (ids.length) return lead ? [lead].concat(ids.filter(id => id !== lead)) : ids;
    return App.deptStaff(dept).map(p => p.id);
  };

  /* ---- team slots: departments AND oversight roles ----
     A show is not only staffed by department. Someone produces it and someone
     directs it, and those roles carry no department at all — App.roleDept is
     null for them — so they could never be staffed by the department rows
     alone.

     `show.team` therefore keys two kinds of slot:

       'audio'          a department, from the show's own pipeline
       'role:producer'  an oversight role, from App.ROLES

     Role keys are prefixed because they would otherwise collide: the
     department roles share their department's key, and a studio can add a
     custom department under any name it likes (see applyWorkflow). Reads of a
     single slot go through App.deptTeam either way — it indexes show.team by
     whatever key it is handed, so it needs no change to serve both. */
  App.ROLE_SLOT = 'role:';
  App.isRoleSlot = (slot) => String(slot).indexOf(App.ROLE_SLOT) === 0;
  App.roleSlot = (roleKey) => App.ROLE_SLOT + roleKey;
  App.slotRoleKey = (slot) => String(slot).slice(App.ROLE_SLOT.length);

  /* Producer and Director are the two every production has, and the only
     oversight roles that are jobs in their own right. Manager is excluded
     deliberately: it is a sub-role layered on a base role (see App.rolePerm),
     so a show's managers are already on their own department's row, marked
     there — a separate Manager row would list the same people twice and imply
     managing is instead of a department rather than as well as one. */
  App.DEFAULT_ROLE_SLOTS = ['producer', 'director'];
  App.isSubRole = (roleKey) => App.SUB_ROLES.indexOf(roleKey) >= 0;

  App.roleStaff = (roleKey) => (App.state.data.people || []).filter(p => p.role === roleKey);

  /* Which role rows a show shows: the two defaults, plus any other role
     already staffed on it — so a Manager added by hand comes back next time
     rather than vanishing because it isn't one of the defaults. */
  App.showRoleSlots = function (show) {
    const stored = Object.keys((show && show.team) || {})
      .filter(App.isRoleSlot).map(App.slotRoleKey);
    const keys = App.DEFAULT_ROLE_SLOTS.concat(
      stored.filter(r => App.DEFAULT_ROLE_SLOTS.indexOf(r) < 0));
    // real roles only, in App.ROLES' own order, so the list can't be reordered
    // by the order someone happened to staff them in
    return App.ROLES.map(r => r.key).filter(k => keys.indexOf(k) >= 0);
  };

  // every slot on a show, roles before departments — the order the team page
  // and Admin's roster both read in
  App.teamSlots = function (show) {
    return App.showRoleSlots(show).map(App.roleSlot).concat(App.showDepts(show));
  };

  App.slotStaff = (slot) => App.isRoleSlot(slot)
    ? App.roleStaff(App.slotRoleKey(slot))
    : App.deptStaff(slot);
  App.slotLabel = (slot) => App.isRoleSlot(slot)
    ? App.role(App.slotRoleKey(slot)).label
    : App.dept(slot).label;

  /* ---- how spread thin someone already is ----
     Which active shows a person is on. Counted per show, not per slot:
     someone producing a show and covering its Audio is on one show, not two.
     Archived shows release their crew, so they don't count. */
  App.personShows = function (personId) {
    return App.activeShows().filter(s =>
      App.teamSlots(s).some(slot => App.deptTeam(s, slot).ids.includes(personId)));
  };

  /* Availability as the share of themselves each show gets: one show has all
     of someone, two shows have half of them each. Someone on nothing reads as
     100% rather than as a share of no work — they're free, not idle-at-zero. */
  App.availabilityPct = (showCount) => Math.round(100 / Math.max(1, showCount));

  App.personLoad = function (personId) {
    const shows = App.personShows(personId);
    return { shows: shows, count: shows.length, pct: App.availabilityPct(shows.length) };
  };

  // the hover answer to "can I actually have them?" — the share, and the
  // shows it's divided between, named
  App.personLoadTip = function (p) {
    const l = App.personLoad(p.id);
    if (!l.count) return p.name + ' isn’t on any show — fully available';
    return [p.name + ' is on ' + l.count + ' show' + (l.count === 1 ? '' : 's') +
      ' · ' + l.pct + '% of their time each'].concat(l.shows.map(s => '• ' + s.name)).join('\n');
  };

  // headcount across the whole show — one person can lead two departments and
  // is still one person on the production
  App.showTeamSize = function (show) {
    const seen = {};
    App.teamSlots(show).forEach(slot => App.deptTeam(show, slot).ids.forEach(id => { seen[id] = 1; }));
    return Object.keys(seen).length;
  };

  // Archival (Admin → Workflow → Shows): archived shows/episodes keep all
  // their data but vanish from every view until restored. An episode is
  // archived either directly or by its whole show being archived.
  App.activeShows = () => App.state.data.shows.filter(s => !s.archived);

  /* Where a show sits in the catalogue, broadest first:
       Brand › Show › Series › Season   (Little Angels › Emmie › Emmie Wonder Wardrobe › Season 1)
     All four are optional labels on the show record, separate from its own
     name. `series` has always held the season ("Season 3"), so it keeps that
     job and the Show and Series levels are keys of their own. */
  App.SHOW_LEVELS = [
    { key: 'brand', label: 'Brand', any: 'Any brand' },
    { key: 'franchise', label: 'Show', any: 'Any show' },
    { key: 'seriesName', label: 'Series', any: 'Any series' },
    { key: 'series', label: 'Season', any: 'Any season' }
  ];
  App.showPath = (s) => App.SHOW_LEVELS.map(l => s[l.key]).filter(Boolean).join(' › ');
  /* The values in use at level `i`, among `shows` that sit under `above`
     ({ brand: 'Little Angels', … } — blank levels don't narrow). */
  App.showLevelValues = function (i, above, shows) {
    const key = App.SHOW_LEVELS[i].key, seen = {};
    (shows || App.state.data.shows).forEach(s => {
      for (let j = 0; j < i; j++) {
        const k = App.SHOW_LEVELS[j].key, want = above && above[k];
        if (want && (s[k] || '') !== want) return;
      }
      if (s[key]) seen[s[key]] = 1;
    });
    return Object.keys(seen).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  };
  /* A placeholder example taken from the board's own shows — the most
     recently added live one that has this field set — so hints read like this
     studio's work, not a made-up show. Blank when there's nothing stored. */
  App.exampleOf = function (key) {
    const shows = App.state.data.shows || [];
    for (let i = shows.length - 1; i >= 0; i--) if (shows[i][key] && !shows[i].archived) return 'e.g. ' + shows[i][key];
    return '';
  };
  App.isEpArchived = (ep) => !!ep.archived || !!App.show(ep.showId).archived;
  App.activeEpisodes = () => App.state.data.episodes.filter(ep => !App.isEpArchived(ep));

  App.epStart = function (ep) {
    return App.subitems(ep).reduce((m, s) => s.start < m ? s.start : m, '9999-99-99');
  };
  /* An episode is in production once any of its work has started. Edit Show
     locks these by default — a plan change shouldn't quietly reach into work
     people are already doing. */
  App.IN_PRODUCTION = ['in_progress', 'review', 'approved'];
  App.inProduction = function (ep) {
    const st = (ep && ep.statuses) || {};
    return Object.keys(st).some(k => App.IN_PRODUCTION.includes(st[k]));
  };

  /* When the show's work says it will finish: the latest date any active
     episode's work allows it to go live (App.msEarliest) — what the plan
     predicts, not the dates that were promised. */
  App.showPredictedFinish = function (showId) {
    return App.state.data.episodes
      .filter(e => e.showId === showId && !e.archived)
      .reduce((m, e) => { const f = App.msEarliest(e, App.LIVE_KEY); return f && f > m ? f : m; }, '');
  };

  /* Plan iterations. A show remembers each version of its plan: iteration 1
     is how it was created, and every Edit Show save that changes the
     schedule or pipeline adds the next — when, by whom, what changed and the
     finish it then predicted — so a show's length reads as a history of
     decisions rather than one number that silently moved. A show made
     before iterations existed gets its first one written, from the plan as
     it stood, the first time it's edited. */
  App.addPlanIteration = function (show, note) {
    const u = App.state.user;
    show.iterations = show.iterations || [];
    const finish = App.showPredictedFinish(show.id);
    const prev = show.iterations[show.iterations.length - 1];
    show.iterations.push({
      n: show.iterations.length + 1,
      at: App.isoDate(App.today()),
      by: (u && u.name) || null,
      note: note || '',
      finish: finish || null,
      delta: prev && prev.finish && finish ? App.diffDays(finish, prev.finish) : null
    });
  };

  App.epDue = function (ep) {
    return App.subitems(ep).reduce((m, s) => s.due > m ? s.due : m, '0000-00-00');
  };

  /* ---------------------------------------------------------------------------
     End-of-episode milestones.

     Delivery Date and Live Date are NOT tasks: nobody works on them, they have
     no duration, department, assignee or status. They are the two dates the
     episode is committed to downstream. Every episode has both.

     The Live Date is the anchor and it NEVER moves on its own. It's a date the
     business has already given out; a live date that quietly slides when the
     work slips hides exactly the problem worth seeing. Every episode stores its
     own (see `migrate`), and it changes only when someone changes it.

     The Delivery Date hangs off the live date instead of off the work: `lead`
     days in front of it — the window the partner needs to get the episode out.
     It can be pinned to its own date when a partner asks for something else.

     `afterQc` is how long each date needs past the end of the work, so both can
     report how far the schedule now runs past what was promised. Days are
     calendar days, the same as a pipeline task's `lag`.
  --------------------------------------------------------------------------- */
  App.MILESTONES = [
    { key: 'delivery_date', name: 'Delivery Date', short: 'Delivery', lead: 7, afterQc: 2 },
    { key: 'live_date',     name: 'Live Date',     short: 'Live',     lead: 0, afterQc: 9 }
  ];
  App.LIVE_KEY = 'live_date';
  App.isMilestoneKey = (key) => App.MILESTONES.some(m => m.key === key);
  App.milestoneDef = (key) => App.MILESTONES.find(m => m.key === key) || null;

  // where the work would first allow a milestone — the earliest honest date,
  // used to seed a live date and to report slip against a promised one
  App.msEarliest = function (ep, key) {
    const subs = App.subitems(ep);
    if (!subs.length) return null;
    // a pipeline without a QC step still gets its milestones — they hang off
    // whatever finishes last instead
    const qc = subs.find(s => s.key === 'qc');
    const qcDue = qc ? qc.due : subs.reduce((m, s) => s.due > m ? s.due : m, subs[0].due);
    const def = App.milestoneDef(key);
    return def ? App.shiftIso(qcDue, def.afterQc) : null;
  };

  /* Both dates, resolved for one episode.

     `date` is what has been promised. `auto` is the earliest the work allows,
     so `slipDays` says how far the schedule now runs past the promise — the
     warning that replaces the old silent drift. `fixed` means this particular
     date was set by hand rather than derived from the live date. */
  App.epMilestones = function (ep) {
    const subs = App.subitems(ep);
    if (!subs.length) return [];
    const set = ep.milestones || {};
    const live = set[App.LIVE_KEY] || App.msEarliest(ep, App.LIVE_KEY);
    return App.MILESTONES.map(m => {
      const date = m.key === App.LIVE_KEY ? live : (set[m.key] || App.shiftIso(live, -m.lead));
      const auto = App.msEarliest(ep, m.key);
      return {
        key: m.key, name: m.name, short: m.short, lead: m.lead, afterQc: m.afterQc,
        date: date, auto: auto, fixed: !!set[m.key],
        // positive = the work now finishes later than the date we committed to
        slipDays: App.diffDays(auto, date)
      };
    });
  };
  App.epMilestone = function (ep, key) { return App.epMilestones(ep).find(m => m.key === key) || null; };

  /* What the Delivery Date actually consists of: the assets that have to be in
     hand on the day, and the pipeline task they're uploaded against. The asset
     is named separately from the task because it's what the partner receives
     ("Reports"), not what the studio calls the work ("QC"). A pipeline that
     doesn't run one of these tasks simply doesn't list that asset.

     Readiness is measured on the FILES, not the task's status: a task can sit
     at Approved with nothing uploaded against it, and on delivery day what
     matters is whether the assets are actually there. Counts attachments and
     external links the same way the Workspace does. */
  App.DELIVERY_ASSETS = [
    { task: 'deliverys', label: 'Deliveries' },
    { task: 'qc',        label: 'Reports' }
  ];
  App.deliveryAssets = function (ep) {
    return App.DELIVERY_ASSETS.map(a => {
      const su = App.subitem(ep, a.task);
      if (!su) return null;
      const files = (App.uploads && App.uploads.list(ep.id, su.key)) || [];
      const links = (App.taskLinks && App.taskLinks(ep.id, su.key)) || [];
      return {
        label: a.label, su: su, dept: App.dept(su.dept),
        files: files.length, links: links.length, count: files.length + links.length
      };
    }).filter(Boolean);
  };
  // the episode's true end — the last milestone, not the last piece of work.
  // Used wherever a view needs to reserve room out to the Live Date.
  App.epFinal = function (ep) {
    const ms = App.epMilestones(ep);
    return ms.length ? ms[ms.length - 1].date : App.epDue(ep);
  };
  App.progressPct = function (ep) {
    const subs = App.subitems(ep);
    const sum = subs.reduce((a, s) => a + (App.status(s.status).weight || 0), 0);
    return Math.round((sum / subs.length) * 100);
  };
  App.countByStatus = function (ep) {
    const c = { not_started: 0, ready: 0, in_progress: 0, review: 0, approved: 0 };
    App.subitems(ep).forEach(s => { c[s.status] = (c[s.status] || 0) + 1; });
    return c;
  };
  App.isDelivered = (ep) => App.subitems(ep).every(s => s.status === 'approved');

  // roll the episode up into one of the four swimlane groups
  App.epGroup = function (ep) {
    const c = App.countByStatus(ep);
    if (c.approved === App.subitems(ep).length) return 'delivered';
    if (c.in_progress > 0) return 'working';
    if (c.review > 0) return 'review';
    if (c.approved > 0) return 'working';
    return 'pending';
  };
  App.epStatusLabel = function (ep) {
    const g = App.epGroup(ep);
    if (g === 'delivered') return 'Delivered';
    if (g === 'pending') return 'Not started';
    // name the current focus subitem
    const subs = App.subitems(ep);
    const focus = subs.find(s => s.status === 'in_progress') || subs.find(s => s.status === 'review');
    return App.EP_GROUPS[g].label + (focus ? ' · ' + focus.name : '');
  };
  // is anything blocked / at risk?
  App.epBlockedTasks = function (ep) {
    return App.subitems(ep).filter(s => App.isRiskBlocked(ep, s.key));
  };
  App.epBlockedCount = function (ep) {
    return App.epBlockedTasks(ep).length;
  };
  App.epOverdueTasks = function (ep) {
    const today = App.isoDate(App.today());
    return App.subitems(ep).filter(s => s.status !== 'approved' && s.due < today);
  };
  App.epOverdueCount = function (ep) {
    return App.epOverdueTasks(ep).length;
  };
  App.isAtRisk = (ep) => !App.isDelivered(ep) && (App.epOverdueCount(ep) > 0);

  /* ---------------------------------------------------------------------------
     Status derivation for generated episodes (dependency-valid, date-driven).
     Episode 1 keeps its hand-set board statuses; the rest derive from "today".
  --------------------------------------------------------------------------- */
  App.deriveStatuses = function (shiftDays) {
    const today = App.today();
    const at = (iso) => App.parseDate(App.shiftIso(iso, shiftDays));
    const status = {};
    App.TEMPLATE.forEach(t => {
      const start = at(t.start), due = at(t.due);
      // no date-derived Ready for Review — see deriveStatusesFromDates above
      if (due < App.addDays(today, -3)) status[t.key] = 'approved';
      else if (start <= today) status[t.key] = 'in_progress';
      else status[t.key] = 'not_started';
    });
    // enforce dependency validity + surface "ready" tasks
    for (let pass = 0; pass < 4; pass++) {
      App.TEMPLATE.forEach(t => {
        const depsOK = t.deps.every(d => status[d] === 'approved');
        if (['approved', 'review', 'in_progress'].includes(status[t.key]) && !depsOK) {
          status[t.key] = 'not_started';
        } else if (status[t.key] === 'not_started' && depsOK && at(t.start) <= App.addDays(today, 10)) {
          status[t.key] = 'ready';
        }
      });
    }
    return status;
  };

  /* ---------------------------------------------------------------------------
     State
  --------------------------------------------------------------------------- */
  App.state = {
    view: 'dashboard',                // timeline | board | dashboard — every role starts here
    role: 'producer',
    // show/dept/person are multi-select: an empty array means "All" (no
    // restriction) — the direct replacement for the old 'all' sentinel. See
    // App.filterHas / App.singleShowFilter in render.js for how consumers
    // read them.
    filters: { show: [], dept: [], person: [], q: '' },
    admin: { view: 'hub', role: 'producer', q: '', editing: null },  // admin page sub-navigation
    planning: { view: 'hub', editing: null, variant: 'C', selected: [] },  // planning module sub-navigation
    expanded: {},                     // episodeId -> bool (board)
    ganttExpanded: {},                // episodeId -> bool (timeline subitem drill-down)
    // Shift-selected task bars, as 'epId|taskKey' strings. A view-local
    // scratch selection — never synced to teammates, and dropped on reload.
    ganttSel: [],
    zoom: 16,                         // px per day on the timeline
    data: null
  };

  /* ---------------------------------------------------------------------------
     Persistence (localStorage; JSON is small)
  --------------------------------------------------------------------------- */
  // v3: bumped when "today" switched to the real clock — v2 data has dates
  // anchored to the old demo date and must reseed
  const KEY = 'postpipeline_v3';
  App.save = function () {
    try { localStorage.setItem(KEY, JSON.stringify(App.state.data)); }
    catch (e) { console.error('save failed', e); }
    if (App.api && App.api.online) App.api.push();   // sync to the shared server store
  };
  /* Boards saved before Delivery/Live became milestones still carry a
     `live_date` *task* in their stored pipelines (and its per-episode date,
     status and name overrides). Strip it wherever data enters — localStorage,
     the shared server, a preset — so no board resurrects it. Idempotent, and
     cheap enough to run on every ingress rather than tracking a schema
     version. Everything else about the board is left exactly as found. */
  App.migrate = function (data) {
    if (!data) return data;
    /* data.lucid.mode chose between a simulated LucidLink adapter and the
       real API. The mock is gone — a 10% synthetic failure rate is useful
       while building and misleading afterwards — so the field selects
       nothing. Dropped wherever a board enters, same as the live_date task
       below: idempotent, and cheaper than tracking a schema version. */
    if (data.lucid && 'mode' in data.lucid) delete data.lucid.mode;
    const drop = (pipe) => Array.isArray(pipe) ? pipe.filter(t => !App.isMilestoneKey(t.key)).map(t => {
      if (t.deps && t.deps.some(App.isMilestoneKey)) t.deps = t.deps.filter(d => !App.isMilestoneKey(d));
      return t;
    }) : pipe;
    (data.shows || []).forEach(s => { if (s.pipeline) s.pipeline = drop(s.pipeline); });
    (data.pipelinePresets || []).forEach(p => { if (p.pipeline) p.pipeline = drop(p.pipeline); });
    if (data.defaultPipelines) Object.keys(data.defaultPipelines).forEach(k => { data.defaultPipelines[k] = drop(data.defaultPipelines[k]); });
    (data.episodes || []).forEach(ep => {
      ['dates', 'statuses', 'names', 'assignees'].forEach(f => {
        if (ep[f]) App.MILESTONES.forEach(m => { delete ep[f][m.key]; });
      });
      if (Array.isArray(ep.removed)) ep.removed = ep.removed.filter(k => !App.isMilestoneKey(k));
    });
    /* Live dates used to be derived from the work, so they drifted with it.
       They're commitments now, so every episode carries its own — stamp the
       date each one currently shows. Nothing appears to move on upgrade, and
       nothing moves after. */
    const prevBoard = App.state.data;
    App.state.data = data;                    // epMilestones reads the live board
    try {
      (data.episodes || []).forEach(ep => {
        if (ep.milestones && ep.milestones[App.LIVE_KEY]) return;
        const live = App.msEarliest(ep, App.LIVE_KEY);
        if (live) (ep.milestones = ep.milestones || {})[App.LIVE_KEY] = live;
      });
    } finally { App.state.data = prevBoard; }
    return data;
  };
  App.load = function () {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { stored = null; }
    App.state.data = App.migrate((stored && stored.episodes && stored.episodes.length) ? stored : App.seedData());
  };
  /* ---------------------------------------------------------------------------
     Board history — undo / redo, scoped to your own edits.

     This is a SHARED board, so an undo must never be a rewind. Restoring a
     whole-board snapshot would quietly revert whatever a teammate changed in
     the meantime, which is worse than not having undo at all. Instead each
     mutation is recorded as a set of precise before/after values, addressed by
     path — "this episode's status for this task", not "the board".

     Undo then does two things:
       · it touches only the paths YOUR action changed, leaving everything
         else — including a teammate's concurrent edits — exactly as it is;
       · it refuses if the value it's about to revert is no longer the value it
         wrote. Someone else has moved that task since, and silently stamping
         over their work is the one thing undo must not do.

     Session-only, in memory, capped. The activity log is not rewound: an undo
     is a new change, not an erasure of what happened.
  --------------------------------------------------------------------------- */
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  // arrays of records (shows, episodes, people) are matched by id, so an edit
  // to one episode never reads as "the whole episodes list changed"
  const keyed = (v) => Array.isArray(v) && v.every(x => x && typeof x === 'object' && typeof x.id === 'string');

  function diffInto(before, after, path, out) {
    if (before === after) return;
    if (isObj(before) && isObj(after)) {
      const keys = new Set(Object.keys(before).concat(Object.keys(after)));
      keys.forEach(k => diffInto(before[k], after[k], path.concat(k), out));
      return;
    }
    if (keyed(before) && keyed(after)) {
      const b = new Map(), a = new Map();
      before.forEach((x, i) => b.set(x.id, { x, i }));
      after.forEach((x, i) => a.set(x.id, { x, i }));
      new Set(Array.from(b.keys()).concat(Array.from(a.keys()))).forEach(id => {
        const bv = b.get(id), av = a.get(id);
        if (!bv) out.push({ path: path.concat([{ id }]), before: undefined, after: clone(av.x), at: av.i });
        else if (!av) out.push({ path: path.concat([{ id }]), before: clone(bv.x), after: undefined, at: bv.i });
        else diffInto(bv.x, av.x, path.concat([{ id }]), out);
      });
      return;
    }
    if (!same(before, after)) out.push({ path: path, before: clone(before), after: clone(after) });
  }

  function getAt(root, path) {
    let cur = root;
    for (let i = 0; i < path.length; i++) {
      if (cur == null) return undefined;
      const seg = path[i];
      cur = (typeof seg === 'object')
        ? (Array.isArray(cur) ? cur.find(x => x && x.id === seg.id) : undefined)
        : cur[seg];
    }
    return cur;
  }

  // Writes one value back. Missing intermediate objects are rebuilt, so undoing
  // a change that created `ep.dates` from nothing still lands.
  function setAt(root, path, value, at) {
    let parent = root;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i];
      if (typeof seg === 'object') {
        if (!Array.isArray(parent)) return false;
        parent = parent.find(x => x && x.id === seg.id);
      } else {
        if (parent[seg] == null) parent[seg] = {};
        parent = parent[seg];
      }
      if (parent == null) return false;
    }
    const last = path[path.length - 1];
    if (typeof last === 'object') {
      if (!Array.isArray(parent)) return false;
      const i = parent.findIndex(x => x && x.id === last.id);
      if (value === undefined) { if (i >= 0) parent.splice(i, 1); }
      else if (i >= 0) parent[i] = value;
      else parent.splice(Math.min(at == null ? parent.length : at, parent.length), 0, value);
    } else if (value === undefined) {
      delete parent[last];
    } else {
      parent[last] = value;
    }
    return true;
  }

  App.history = {
    _undo: [], _redo: [],
    LIMIT: 50,

    record(label, changes) {
      if (!changes.length) return;              // a no-op action isn't a history step
      this._undo.push({ label: label || 'the last change', changes: changes });
      if (this._undo.length > this.LIMIT) this._undo.shift();
      this._redo.length = 0;                    // a new action forks the timeline
    },
    canUndo() { return this._undo.length > 0; },
    canRedo() { return this._redo.length > 0; },
    clear() { this._undo.length = 0; this._redo.length = 0; },

    /* `dir` is 'before' to undo and 'after' to redo. Every value is checked
       against what we expect to still be there before ANY of them is written,
       so a refused step leaves the board completely untouched. */
    _apply(entry, dir) {
      const expect = dir === 'before' ? 'after' : 'before';
      const stale = entry.changes.some(c => !same(getAt(App.state.data, c.path), c[expect]));
      if (stale) return { ok: false, label: entry.label };
      entry.changes.forEach(c => setAt(App.state.data, c.path, clone(c[dir]), c.at));
      App.applyWorkflow && App.applyWorkflow();
      App.save();
      App.render();
      return { ok: true, label: entry.label };
    },
    undo() {
      if (!this._undo.length) return null;
      const entry = this._undo[this._undo.length - 1];
      const r = this._apply(entry, 'before');
      if (!r.ok) return r;                      // left in place; the user can retry after looking
      this._undo.pop(); this._redo.push(entry);
      return r;
    },
    redo() {
      if (!this._redo.length) return null;
      const entry = this._redo[this._redo.length - 1];
      const r = this._apply(entry, 'after');
      if (!r.ok) return r;
      this._redo.pop(); this._undo.push(entry);
      return r;
    }
  };

  /* `label` names the action for the undo toast — "Undid the reschedule".
     The board is cloned before the change so the two can be diffed; at ~50KB
     that's cheap next to the render the mutation triggers anyway. */
  App.mutate = function (fn, label) {
    const before = clone(App.state.data);
    fn(App.state.data);
    const changes = [];
    diffInto(before, App.state.data, [], changes);
    App.history.record(label, changes);
    App.save();
    App.render();
  };

  /* ---------------------------------------------------------------------------
     Show backup — everything belonging to one show, as a JSON file.

     Board data lives on the server, never in the repo, so a deploy can't touch
     it — but a bad edit, a delete or a data migration can. This is the way to
     take a copy before doing something irreversible. It's a snapshot for
     safekeeping and inspection, NOT an importer: nothing in the app reads these
     files back in, so restoring one is a manual job.

     The show's own record and episodes are the substance; attachments and task
     links are keyed by episode so they're filtered out of the board-wide maps.
     `context` carries the workflow and the people referenced, so the file can
     be read on its own without the rest of the board to decode it.
  --------------------------------------------------------------------------- */
  App.showBackup = function (showId) {
    const d = App.state.data;
    const show = d.shows.find(s => s.id === showId);
    if (!show) return null;
    const episodes = d.episodes.filter(e => e.showId === showId);
    const epIds = episodes.map(e => e.id);
    const mine = (map) => {
      const out = {};
      Object.keys(map || {}).forEach(k => { if (epIds.includes(String(k).split('::')[0])) out[k] = map[k]; });
      return out;
    };
    // only the people actually referenced, so the file doesn't carry the whole directory
    const used = new Set();
    episodes.forEach(e => Object.values(e.assignees || {}).forEach(p => p && used.add(p)));

    return {
      format: 'postpipeline.show-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: (App.state.user && App.state.user.name) || null,
      show: show,
      episodes: episodes,
      attachments: mine(d.attachments),
      taskLinks: mine(d.taskLinks),
      context: {
        workflow: d.workflow || null,
        people: (d.people || []).filter(p => used.has(p.id))
      }
    };
  };

  App.downloadShowBackup = function (showId) {
    const data = App.showBackup(showId);
    if (!data) { App.toast('That show no longer exists', true); return; }
    const slug = String(data.show.prefix || data.show.name || 'show')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'show';
    const name = 'postpipeline_' + slug + '_' + App.isoDate(App.today()) + '.json';
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    // give the download a tick to start before the blob is thrown away
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    App.track && App.track.audit && App.track.audit('show.backup', { show: data.show.name, episodes: data.episodes.length });
    App.toast('Backed up ' + data.show.name + ' — ' + data.episodes.length +
      ' episode' + (data.episodes.length === 1 ? '' : 's'));
  };

  /* Personal quick preferences — device-local (localStorage), deliberately NOT
     part of the shared board data so one user's view settings don't sync to
     everyone else. */
  App.prefs = (function () {
    const PKEY = 'postpipeline_prefs';
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PKEY) || '{}'); } catch (e) { p = {}; }
    return {
      get: (k, def) => (k in p ? p[k] : def),
      set: (k, v) => { p[k] = v; try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch (e) {} }
    };
  })();

  /* ---------------------------------------------------------------------------
     Session restore — where you were, per device.

     The Dashboard is home: it's where every role lands on their first visit of
     the day, because that's the "what needs me today" view. But a refresh
     mid-task is not a new day, and being thrown back to the Dashboard from the
     Timeline loses the filters, the zoom and every expanded row. So the whole
     navigation position is written back on each render and restored on boot —
     unless the saved position is from an earlier day, in which case it's a new
     morning and the Dashboard wins.

     Device-local (like App.prefs), never shared board data: where a teammate
     is looking is their business. Only navigation lives here — nothing that
     belongs to the board itself, and nothing transient like an `editing` reference that may since have been
     deleted by someone else.
  --------------------------------------------------------------------------- */
  App.session = {
    KEY: 'postpipeline_session',
    _t: null,

    snapshot() {
      const s = App.state;
      return {
        day: App.isoDate(App.today()),
        view: s.view,
        filters: { show: s.filters.show, dept: s.filters.dept, person: s.filters.person, q: s.filters.q },
        zoom: s.zoom,
        expanded: s.expanded,
        ganttExpanded: s.ganttExpanded,
        gantt: s.gantt || null,
        admin: { view: s.admin.view, role: s.admin.role, q: s.admin.q },
        planning: { view: s.planning.view, variant: s.planning.variant }
      };
    },

    // Debounced: a drag or a keystroke can trigger many renders a second, and
    // this only has to be right by the time the tab actually goes away.
    save() {
      clearTimeout(this._t);
      this._t = setTimeout(() => {
        try { localStorage.setItem(this.KEY, JSON.stringify(this.snapshot())); } catch (e) {}
      }, 250);
    },

    /* Returns true if a position was restored, false to leave the caller's
       default (the Dashboard) in place. Every field is applied defensively:
       a stored view the role can't reach is caught by the guards at the top
       of App.render, and anything missing or malformed is simply skipped. */
    restore() {
      let s = null;
      try { s = JSON.parse(localStorage.getItem(this.KEY) || 'null'); } catch (e) { s = null; }
      if (!s || s.day !== App.isoDate(App.today())) return false;   // new day → start at home
      const st = App.state;
      if (typeof s.view === 'string') st.view = s.view;
      if (s.filters) {
        ['show', 'dept', 'person'].forEach(k => { if (Array.isArray(s.filters[k])) st.filters[k] = s.filters[k]; });
        if (typeof s.filters.q === 'string') st.filters.q = s.filters.q;
      }
      if (typeof s.zoom === 'number' && s.zoom > 0) st.zoom = s.zoom;
      if (s.expanded && typeof s.expanded === 'object') st.expanded = s.expanded;
      if (s.ganttExpanded && typeof s.ganttExpanded === 'object') st.ganttExpanded = s.ganttExpanded;
      if (s.gantt && typeof s.gantt === 'object') st.gantt = s.gantt;
      if (s.admin) Object.keys(s.admin).forEach(k => { if (s.admin[k] != null) st.admin[k] = s.admin[k]; });
      if (s.planning) Object.keys(s.planning).forEach(k => { if (s.planning[k] != null) st.planning[k] = s.planning[k]; });
      return true;
    },

    // a deliberate "take me home" — used when the day rolls over mid-session
    clear() { try { localStorage.removeItem(this.KEY); } catch (e) {} }
  };

  /* ---------------------------------------------------------------------------
     Dialog drafts — a dismissed form keeps what was typed into it.

     Clicking the backdrop, pressing Escape or hitting ✕ is how people get a
     second look at the board behind a dialog; it shouldn't cost them the form.
     Each dialog stores its own draft under its own id, restores it on reopen,
     and clears it the moment the thing is actually created. Device-local, and
     kept out of the board data: an unfinished form is not a fact about the show.
  --------------------------------------------------------------------------- */
  App.draft = {
    KEY: 'postpipeline_drafts',
    _all() { try { return JSON.parse(localStorage.getItem(this.KEY) || '{}') || {}; } catch (e) { return {}; } },
    _write(all) { try { localStorage.setItem(this.KEY, JSON.stringify(all)); } catch (e) {} },
    get(id) { const v = this._all()[id]; return (v && typeof v === 'object') ? v : null; },
    set(id, val) { const a = this._all(); a[id] = val; this._write(a); },
    clear(id) { const a = this._all(); delete a[id]; this._write(a); }
  };

  /* Themes — each is a named set of CSS-variable overrides living in
     style.css under :root[data-theme="…"]; switching one only swaps that
     attribute, so every surface, border and accent follows at once. Like the
     other view preferences this is per-device (localStorage), not shared
     board data — one person's theme never lands on a teammate's screen.

     Three attributes get written to <html>, and each does a different job:
       data-theme  the palette (every theme has one)
       data-mode   'dark' | 'light' — drives the handful of overlays that are
                   tuned for a dark canvas (weekend shading, zebra rows)
       data-skin   'expressive' opts a theme into the structural rules too:
                   font, corner radii, border weight and card shadow, so the
                   UI itself changes shape and not just colour.

     STATUS COLOURS ARE DELIBERATELY OUT OF SCOPE. No theme may re-declare
     --st-* : Not Started / Ready to Start / In Progress / Ready for Review /
     Approved must read identically in every theme, because people scan the
     board by those colours. Status cells and legend swatches are painted from
     App.STATUSES in JS (with pickInk picking readable ink), so a theme can
     restyle their shape but never their hue. */
  App.THEMES = [
    { v: 'midnight', label: 'Midnight (default)', mode: 'dark' },
    { v: 'graphite', label: 'Graphite',           mode: 'dark' },
    { v: 'nord',     label: 'Nord',               mode: 'dark' },
    { v: 'indigo',   label: 'Indigo',             mode: 'dark' },
    { v: 'forest',   label: 'Forest',             mode: 'dark' },
    { v: 'daylight', label: 'Daylight',           mode: 'light' },
    // expressive skins — these restyle the furniture as well as the palette
    { v: 'moppets',   label: 'Playful',        mode: 'light', skin: 'expressive' },
    { v: 'cardio',    label: 'Tech',           mode: 'dark',  skin: 'expressive' },
    { v: 'bookshop',  label: 'Bookshop',       mode: 'light', skin: 'expressive' },
    { v: 'retro',     label: 'Wireframe',      mode: 'light', skin: 'expressive' },
    { v: 'botanical', label: 'Botanical',      mode: 'light', skin: 'expressive' }
  ];
  App.applyTheme = function () {
    const want = App.prefs.get('theme', 'midnight');
    const t = App.THEMES.find(x => x.v === want) || App.THEMES[0];
    const root = document.documentElement;
    root.setAttribute('data-theme', t.v);
    root.setAttribute('data-mode', t.mode || 'dark');
    if (t.skin) root.setAttribute('data-skin', t.skin);
    else root.removeAttribute('data-skin');
    return t.v;
  };
  // deferred script: the document element already exists, so applying here
  // paints the right palette on the very first frame (no flash of default)
  App.applyTheme();

  /* ---------------------------------------------------------------------------
     Shared hover tooltip — a single fixed-position element positioned by
     getBoundingClientRect (same pattern as the status/dep popups), so it
     floats above scroll containers instead of getting clipped by them like a
     pure-CSS ::after tooltip would inside .modal-body / .subtable / .pipe-list.
  --------------------------------------------------------------------------- */
  App.tooltip = {
    node: null,
    delay: 500,
    // Bars nest smaller elements with their own tooltip (e.g. a ⛔ blocked
    // icon inside its bar) — both are "hovered" at once since mouseleave only
    // fires when the cursor truly exits an element's box, not when it moves
    // onto a child. `_stack` tracks hover order so the most specific (topmost,
    // last-entered) element always wins; ancestor tooltips never fight it.
    _stack: [],
    _info: new WeakMap(),
    ensure() {
      if (!this.node) {
        this.node = document.createElement('div');
        this.node.className = 'app-tooltip';
        document.body.appendChild(this.node);
        window.addEventListener('scroll', () => this.hide(), true);
      }
      return this.node;
    },
    // pos: 'auto' (default) flips above/below to fit the viewport; 'below'
    // pins it under the target regardless of available space.
    show(target, text, pos) {
      if (!text || !target.isConnected) return;
      const tip = this.ensure();
      /* `text` may also be a function returning a Node, built on hover — a
         richer tooltip (the Timeline's resource circles list their tasks)
         in the same themed box, without building it for every cell up front. */
      const content = typeof text === 'function' ? text() : text;
      if (content instanceof Node) { tip.textContent = ''; tip.appendChild(content); tip.classList.add('rich'); }
      else { tip.textContent = content; tip.classList.remove('rich'); }
      tip.classList.add('show');
      requestAnimationFrame(() => {
        if (!tip.classList.contains('show')) return;
        // A re-render between the reveal and this frame detaches the target;
        // its rect would then be all zeros and pin the tooltip to the top-left
        // corner of the app, orphaned from whatever it was describing.
        if (!target.isConnected) { this.hide(); return; }
        const r = target.getBoundingClientRect();
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let left = r.left + r.width / 2 - tw / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
        const above = pos !== 'below' && (r.top - th - 10 >= 4);
        tip.style.left = left + 'px';
        tip.style.top = (above ? r.top - th - 10 : r.bottom + 10) + 'px';
        tip.classList.toggle('flip', !above);
        const arrowX = Math.max(10, Math.min(r.left + r.width / 2 - left, tw - 10));
        tip.style.setProperty('--arrow-x', arrowX + 'px');
      });
    },
    hide() {
      if (this.node) this.node.classList.remove('show');
    },
    /* Called by App.render(): a redraw removes hovered elements without ever
       firing their mouseleave, so anything still on the stack is stale and any
       tooltip on screen is describing a node that no longer exists. */
    reset() {
      this._stack = [];
      this.hide();
    },
    // Only reveal if `target` is still the frontmost hovered element —
    // a slower ancestor timer firing after a nested element took over is a no-op.
    _reveal(target) {
      this._stack = this._stack.filter(t => t.isConnected);   // drop anything a re-render took away
      if (this._stack[this._stack.length - 1] !== target) return;
      const info = this._info.get(target);
      if (info) this.show(target, info.text, info.pos);
    },
    bind(target, text, pos) {
      this._info.set(target, { text, pos });
      let timer = null;
      target.addEventListener('mouseenter', () => {
        this._stack = this._stack.filter(t => t !== target);
        this._stack.push(target);
        clearTimeout(timer);
        timer = setTimeout(() => this._reveal(target), this.delay);
      });
      target.addEventListener('mouseleave', () => {
        clearTimeout(timer);
        this._stack = this._stack.filter(t => t !== target);
        this.hide();
        // the cursor is still over a less-specific ancestor — hand it the spotlight
        const top = this._stack[this._stack.length - 1];
        if (top) this._reveal(top);
      });
      // A click means the tooltip is no longer wanted — and the button may be
      // about to remove itself (a modal ✕, a row that re-renders). Cancelling
      // the pending timer as well as hiding stops it reappearing afterwards.
      target.addEventListener('mousedown', () => {
        clearTimeout(timer);
        this._stack = this._stack.filter(t => t !== target);
        this.hide();
      });
    }
  };

  /* ---------------------------------------------------------------------------
     Tiny DOM helper:  el('div.cls#id', {attr|on…}, [children|string])
  --------------------------------------------------------------------------- */
  /* Close a floating menu when the pointer goes down anywhere outside it.
     Listens in the capture phase, because dialogs stop their clicks from
     bubbling (so the backdrop can tell a click on the card from a click
     beside it) — a plain document click listener never hears a press inside
     a dialog, which left menus open over the form. Returns the un-listener. */
  App.onPressOutside = function (menu, close) {
    const h = (e) => { if (menu.isConnected && !menu.contains(e.target)) close(); };
    // armed on the next tick so the press that opened the menu can't close it
    const t = setTimeout(() => document.addEventListener('pointerdown', h, true), 0);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', h, true); };
  };

  /* Drag to reorder a list — the pipeline editor's gesture, shared so every
     reorderable list behaves the same. Grab a row's grip and it lifts under
     the cursor while the rest slide apart to open a gap where it will land.
     Nothing is re-rendered mid-drag: rows move by transform only, and the
     caller's onDrop(from, to) is told once, on release, so the animation
     can't fight a rebuild.

     Rows are measured at pick-up rather than per frame; the list doesn't
     reflow during a drag, so those measurements stay true, and it keeps the
     move handler to arithmetic.

       rows()    the rows that take part, in order
       grip      selector for the grab point (only the grip starts a drag)
       lifted    class for the row being carried
       onStart() optional, called at pick-up
       onDrop(from, to)  indexes into rows(); only called when it moved */
  App.dragReorder = function (listEl, opts) {
    let d = null;
    const lifted = opts.lifted || 'reorder-lifted';
    listEl.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest(opts.grip);
      if (!grip || !listEl.contains(grip)) return;
      const rows = opts.rows();
      const row = rows.find(r => r.contains(grip));
      const from = rows.indexOf(row);
      if (from < 0 || rows.length < 2) return;
      e.preventDefault();
      if (opts.onStart) opts.onStart();
      const gap = parseFloat(getComputedStyle(row.parentNode).rowGap) || 0;
      // offsetTop is measured against the offset parent, so every row has to
      // share one; getBoundingClientRect doesn't care
      const box = rows.map(r => { const b = r.getBoundingClientRect(); return { el: r, top: b.top, h: b.height }; });
      d = { row, rows: box, from, to: from, y: e.clientY, step: box[from].h + gap };
      listEl.classList.add('reordering');
      row.classList.add(lifted);
      row.style.width = row.offsetWidth + 'px';      // pin the width; it leaves the flow visually
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    });
    listEl.addEventListener('pointermove', (e) => {
      if (!d) return;
      const dy = e.clientY - d.y;
      d.row.style.transform = 'translateY(' + dy + 'px)';
      // where the carried row's own middle now sits, against everyone else's
      const mid = d.rows[d.from].top + d.rows[d.from].h / 2 + dy;
      let to = d.from;
      d.rows.forEach((r, i) => {
        if (i === d.from) return;
        const rMid = r.top + r.h / 2;
        if (i < d.from && mid < rMid) to = Math.min(to, i);
        if (i > d.from && mid > rMid) to = Math.max(to, i);
      });
      if (to === d.to) return;
      d.to = to;
      d.rows.forEach((r, i) => {
        if (i === d.from) return;
        const shift = (i > d.from && i <= to) ? -d.step : (i < d.from && i >= to) ? d.step : 0;
        r.el.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
      });
    });
    const end = () => {
      if (!d) return;
      const x = d; d = null;
      listEl.classList.remove('reordering');
      x.row.classList.remove(lifted);
      x.row.style.transform = ''; x.row.style.width = '';
      x.rows.forEach(r => { r.el.style.transform = ''; });
      if (x.to !== x.from) opts.onDrop(x.from, x.to);
    };
    listEl.addEventListener('pointerup', end);
    listEl.addEventListener('pointercancel', end);
  };

  App.el = function (sel, props, children) {
    const m = sel.match(/^([a-z0-9]+)?(.*)$/i);
    const node = document.createElement(m[1] || 'div');
    const rest = m[2] || '';
    const idm = rest.match(/#([\w-]+)/);
    if (idm) node.id = idm[1];
    const classes = (rest.match(/\.([\w-]+)/g) || []).map(c => c.slice(1));
    if (classes.length) node.className = classes.join(' ');
    let deferredTitle = null, tipPos = 'auto';
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className += ' ' + v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'title') deferredTitle = v;      // routed through App.tooltip below — see note
      else if (k === 'tipPos') tipPos = v;             // 'below' pins the tooltip under the target
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    // Custom styled tooltip instead of the native browser one — except on
    // disabled controls, which don't reliably fire mouse events for it anyway
    // (native title is the only thing that reaches the user there).
    if (deferredTitle) {
      if (node.disabled) node.setAttribute('title', deferredTitle);
      else App.tooltip.bind(node, deferredTitle, tipPos);
    }
    const kids = children == null ? [] : (Array.isArray(children) ? children : [children]);
    for (const c of kids) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return node;
  };

  App.toast = function (msg, isError) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    // error toasts get the warning mark here rather than every caller
    // hand-prefixing a '⚠' into its message copy
    const t = App.el('div.toast' + (isError ? '.error' : ''), null,
      isError ? [App.icon('warn'), ' ' + msg] : msg);
    root.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, isError ? 5000 : 2800);
  };
})();
