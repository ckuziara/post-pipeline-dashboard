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
    { key: 'producer',  label: 'Producer',        ico: 'clapper', approve: true, editAll: true, admin: true, manageShows: true, editName: true, removeTask: true, editSchedule: true, hint: 'Full access — all tasks, shows & admin' },
    { key: 'manager',   label: 'Manager',         ico: 'compass', approve: true, editAll: true, admin: true, editName: true, removeTask: true, editSchedule: true, hint: 'Oversight, approvals & admin' },
    { key: 'director',  label: 'Director',        ico: 'target', approve: true, editAll: true, hint: 'Review & approve cuts' },
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
  // An optional `lag` holds a task back instead: it starts that many days after
  // its dependency's finish rather than the next day, which is how a fixed
  // waiting period is expressed (Live Date sits 4 weeks past QC). The lag is a
  // commitment to an outside party, so squeeze/stretch never scales it.
  App.schedulePipeline = function (pipeline, startIso, scale) {
    const order = App.topoSort(pipeline); if (!order) return null;
    const byKey = {}; pipeline.forEach(t => { byKey[t.key] = t; });
    const dates = {}; let end = startIso;
    order.forEach(k => {
      const t = byKey[k];
      let s = startIso;
      t.deps.forEach(d => {
        if (!dates[d]) return;
        const next = App.shiftIso(dates[d].due, t.lag > 0 ? t.lag : 1);
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

  /* What a proposed reschedule of one task would break.

     Dependencies are an ordering promise: a task may not start until everything
     it depends on has finished. Moving a bar can break that from either side —
     drag it earlier and it can open before its own inputs are done; drag it
     later, or stretch its tail, and it can run past the start of whatever was
     waiting on it. Both are collected here, each with the overlap in days, so
     the producer is shown the cost before it's paid rather than told afterwards.

     Nothing cascades: only the dragged task moves, which is why every other
     task in the result keeps its current dates. Pure — safe to call while
     dragging. */
  App.scheduleImpact = function (ep, key, newStart, newDue) {
    const pipe = App.pipelineFor(ep);
    const task = pipe.find(t => t.key === key);
    const byKey = {}; App.subitems(ep).forEach(s => { byKey[s.key] = s; });
    const moved = byKey[key];
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
    view: 'dashboard',                // timeline | board | dashboard — every role starts here
    role: 'producer',
    filters: { show: 'all', dept: 'all', person: 'all', q: '' },
    admin: { view: 'hub', role: 'producer', q: '', editing: null },  // admin page sub-navigation
    planning: { view: 'hub', editing: null, variant: 'C', selected: [] },  // planning module sub-navigation
    expanded: {},                     // episodeId -> bool (board)
    ganttExpanded: {},                // episodeId -> bool (timeline subitem drill-down)
    creatingOnGantt: false,           // "+ Create" toggle armed — transient, never synced to teammates
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
    const drop = (pipe) => Array.isArray(pipe) ? pipe.filter(t => !App.isMilestoneKey(t.key)).map(t => {
      if (t.deps && t.deps.some(App.isMilestoneKey)) t.deps = t.deps.filter(d => !App.isMilestoneKey(d));
      return t;
    }) : pipe;
    (data.shows || []).forEach(s => { if (s.pipeline) s.pipeline = drop(s.pipeline); });
    (data.pipelinePresets || []).forEach(p => { if (p.pipeline) p.pipeline = drop(p.pipeline); });
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
      tip.textContent = text;
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
