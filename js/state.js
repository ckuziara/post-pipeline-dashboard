/* Post Pipeline — data model, pipeline template, derived metrics, persistence.
   Buildless: plain JS in window.App, loaded as classic deferred scripts. No Node, no bundler.
   The pipeline TEMPLATE below is transcribed straight from the Monday board (Episode 1:
   "Joe's Little Angel") — 27 subitems, their departments, dependencies and dates. */
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
    { key: 'producer',  label: 'Producer',        ico: 'clapper', view: 'timeline',  approve: true, editAll: true, admin: true, manageShows: true, editName: true, removeTask: true, editSchedule: true, hint: 'Full access — all tasks, shows & admin' },
    { key: 'manager',   label: 'Manager',         ico: 'compass', view: 'dashboard', approve: true, editAll: true, admin: true, editName: true, removeTask: true, editSchedule: true, hint: 'Oversight, approvals & admin' },
    { key: 'director',  label: 'Director',        ico: 'target', view: 'review',    approve: true, editAll: true, hint: 'Review & approve cuts' },
    { key: 'creative',  label: 'Creative',        ico: 'pencil', view: 'board', dept: 'creative',  hint: 'Creative department tasks' },
    { key: 'music',     label: 'Music',           ico: 'music', view: 'board', dept: 'music',     hint: 'Music department tasks' },
    { key: 'animation', label: 'Animation',       ico: 'film', view: 'board', dept: 'animation', hint: 'Animation department tasks' },
    { key: 'audio',     label: 'Audio Post',      ico: 'headphones', view: 'board', dept: 'audio',     hint: 'Audio Post department tasks' },
    { key: 'video',     label: 'Video Post',      ico: 'camera', view: 'board', dept: 'video',     hint: 'Video Post department tasks' },
    { key: 'ops',       label: 'Post Operations', ico: 'package', view: 'board', dept: 'ops', editSchedule: true, hint: 'Post Operations tasks & scheduling' },
    { key: 'qc',        label: 'QC',              ico: 'checkBadge', view: 'board', dept: 'qc',        hint: 'QC tasks' }
  ];
  App.role = (k) => App.ROLES.find(r => r.key === k) || App.ROLES[0];
  // Role capabilities are data-driven (Admin → Access Control) with the ROLES
  // flags above as the defaults until an admin overrides them.
  App.rolePerm = function (k, perm, builtin) {
    const t = App.state && App.state.data && App.state.data.rolePerms;
    if (t && t[k] && perm in t[k]) return !!t[k][perm];
    return !!builtin;
  };
  App.canApprove = (k) => App.rolePerm(k, 'approve', App.role(k).approve);
  App.isAdminRole = (k) => App.rolePerm(k, 'admin', App.role(k).admin);
  App.canManageShows = (k) => App.rolePerm(k, 'manageShows', App.role(k).manageShows);
  // Which roles may assign task owners — selectable in the Admin panel and
  // persisted in data.assignPriv. Until an admin changes it, the approver
  // (oversight) roles hold the privilege.
  App.defaultAssignPriv = () => App.ROLES.filter(r => r.approve).map(r => r.key);
  App.canAssignOwners = function (k) {
    const priv = App.state && App.state.data && App.state.data.assignPriv;
    return priv ? priv.includes(k) : !!App.role(k).approve;
  };
  App.roleDept = (k) => App.role(k).dept || null;
  App.canEditTask = function (k, task) {
    const r = App.role(k);
    if (r.editAll) return true;
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
      return { key: t.key, name: t.name, dept: t.dept, days, minDays: Math.max(1, Math.ceil(days / 2)), deps: t.deps.slice() };
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
  App.defaultPipelineFor = function (type) {
    if (type === 'live_action') return App.LIVE_PIPELINE.map(t => ({ ...t, deps: t.deps.slice() }));
    return App.defaultPipeline();
  };

  App.pipelineFor = function (ep) {
    const show = ep && App.state.data && App.state.data.shows.find(s => s.id === ep.showId);
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
  App.schedulePipeline = function (pipeline, startIso, scale) {
    const order = App.topoSort(pipeline); if (!order) return null;
    const byKey = {}; pipeline.forEach(t => { byKey[t.key] = t; });
    const dates = {}; let end = startIso;
    order.forEach(k => {
      const t = byKey[k];
      let s = startIso;
      t.deps.forEach(d => {
        if (!dates[d]) return;
        const next = App.shiftIso(dates[d].due, 1);
        if (next > s) s = next;
      });
      const due = App.shiftIso(s, App.taskDuration(t, scale) - 1);
      dates[k] = { start: s, due };
      if (due > end) end = due;
    });
    return { dates, end };
  };

  // Whole-show schedule: episode i kicks off at startIso + i*cadence days.
  // Project end = the last episode's critical-path finish.
  App.scheduleShow = function (pipeline, startIso, epCount, cadence, scale) {
    const one = App.schedulePipeline(pipeline, startIso, scale); if (!one) return null;
    const lastStart = App.shiftIso(startIso, Math.max(0, epCount - 1) * cadence);
    const last = App.schedulePipeline(pipeline, lastStart, scale);
    return { end: last.end };
  };

  // Largest scale whose project end still fits targetIso (binary search over a
  // monotonic end(scale)). scale=0 means every task at its minDays — the floor.
  App.solveScale = function (pipeline, startIso, epCount, cadence, targetIso) {
    const floor = App.scheduleShow(pipeline, startIso, epCount, cadence, 0);
    if (!floor) return null;
    if (targetIso <= floor.end) return { scale: 0, end: floor.end, clamped: targetIso < floor.end };
    let lo = 0, hi = 1;
    while (hi < 16 && App.scheduleShow(pipeline, startIso, epCount, cadence, hi).end < targetIso) hi *= 2;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (App.scheduleShow(pipeline, startIso, epCount, cadence, mid).end <= targetIso) lo = mid; else hi = mid;
    }
    return { scale: lo, end: App.scheduleShow(pipeline, startIso, epCount, cadence, lo).end, clamped: false };
  };

  // Status derivation for freshly scheduled episodes (same rules as
  // deriveStatuses below, but driven by concrete per-task dates).
  App.deriveStatusesFromDates = function (pipeline, dates, assignees) {
    const today = App.today();
    const status = {};
    pipeline.forEach(t => {
      const d = dates[t.key];
      if (!d) { status[t.key] = 'not_started'; return; }
      const start = App.parseDate(d.start), due = App.parseDate(d.due);
      if (due < App.addDays(today, -3)) status[t.key] = 'approved';
      else if (due <= today) status[t.key] = 'review';
      else if (start <= today) status[t.key] = 'in_progress';
      else status[t.key] = 'not_started';
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
     Episode-derived metrics
  --------------------------------------------------------------------------- */
  App.show = (id) => App.state.data.shows.find(s => s.id === id) || { name: '—', color: '#888' };
  App.person = (id) => App.state.data.people.find(p => p.id === id) || null;

  // Archival (Admin → Workflow → Shows): archived shows/episodes keep all
  // their data but vanish from every view until restored. An episode is
  // archived either directly or by its whole show being archived.
  App.activeShows = () => App.state.data.shows.filter(s => !s.archived);
  App.isEpArchived = (ep) => !!ep.archived || !!App.show(ep.showId).archived;
  App.activeEpisodes = () => App.state.data.episodes.filter(ep => !App.isEpArchived(ep));

  App.epStart = function (ep) {
    return App.subitems(ep).reduce((m, s) => s.start < m ? s.start : m, '9999-99-99');
  };
  App.epDue = function (ep) {
    return App.subitems(ep).reduce((m, s) => s.due > m ? s.due : m, '0000-00-00');
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
      if (due < App.addDays(today, -3)) status[t.key] = 'approved';
      else if (due <= today) status[t.key] = 'review';
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
    view: 'timeline',                 // timeline | board | dashboard
    role: 'producer',
    filters: { show: 'all', dept: 'all', person: 'all', q: '' },
    admin: { view: 'hub', role: 'producer', q: '', editing: null },  // admin page sub-navigation
    expanded: {},                     // episodeId -> bool (board)
    ganttExpanded: {},                // episodeId -> bool (timeline subitem drill-down)
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
  App.load = function () {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { stored = null; }
    App.state.data = (stored && stored.episodes && stored.episodes.length) ? stored : App.seedData();
  };
  App.resetData = function () {
    App.state.data = App.seedData();
    App.save();
    App.render();
    App.toast('Demo data reset to the reference board');
  };
  App.mutate = function (fn) { fn(App.state.data); App.save(); App.render(); };

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
      if (!text) return;
      const tip = this.ensure();
      tip.textContent = text;
      tip.classList.add('show');
      requestAnimationFrame(() => {
        if (!tip.classList.contains('show')) return;
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
    // Only reveal if `target` is still the frontmost hovered element —
    // a slower ancestor timer firing after a nested element took over is a no-op.
    _reveal(target) {
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
      target.addEventListener('mousedown', () => this.hide());
    }
  };

  /* ---------------------------------------------------------------------------
     Tiny DOM helper:  el('div.cls#id', {attr|on…}, [children|string])
  --------------------------------------------------------------------------- */
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
