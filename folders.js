/* Production folder structure on the LucidLink master directory.

   The tree is DERIVED FROM THE SHOW'S PIPELINE rather than hardcoded, so it
   supports whatever pipeline a show actually has (the 27-task animation
   default, the 14-task live-action one, or any custom Admin preset) and stays
   correct when a pipeline is edited. Every pipeline task gets exactly one
   folder, filed under its department.

   Studio naming conventions (carried over from the existing post structure):
     NNNN_Name   zero-padded numeric prefix, RESTARTING at each level
     !!_Name     pinned to the top of a listing
     zz_Name     pushed to the bottom
     YYMMDD_     reverse-dated folders, newest sorts first

   Inside every task folder:
     0001_Work     working project files — what LucidLink checks out and locks
     0002_Publish  the approved artifact. Dependent tasks read from here, so the
                   tracker's dependency graph becomes a filesystem rule.

   This module runs SERVER-SIDE on purpose: the browser only ever names a show or
   episode id, and every path segment here is generated from sanitised names, so
   a client can't smuggle "../" into a mkdir. */
'use strict';
const fs = require('fs');
const path = require('path');

const DEPT_FOLDER = {
  creative: 'Creative', music: 'Music', animation: 'Animation', audio: 'AudioPost',
  video: 'VideoPost', ops: 'PostOps', qc: 'QC'
};
const DEPT_ORDER = ['creative', 'music', 'animation', 'audio', 'video', 'ops', 'qc'];

const SHOW_LIBRARY = [
  'StyleGuides', 'DesignLibrary', 'Music_AndSFX', 'GFX_AndTemplates', 'LUTs_AndColour'
];
const PRODUCTION = ['Schedules', 'Scripts', 'Contracts_AndCrew', 'Notes'];

/* Deliverable grouping — the main lever on folder count.
   Pipeline tasks that are ITERATIONS of one deliverable share a folder, because
   that's how people actually work: Animatic V2 is a file next to V1, not a new
   directory. Tracking stays per-task on the board; only storage is grouped.

   Keyed by pipeline task key. Anything unmapped (a custom preset's task) falls
   back to its own folder, so no task is ever left without a home. */
const GROUPS = {
  // Creative
  core_premises: 'Story', scripts: 'Story',
  design: 'Design',
  storyboard: 'Storyboard',
  animatic_v1: 'Animatic', animatic_v2: 'Animatic', animatic_v3: 'Animatic',
  // Music
  music_skeleton: 'Skeleton',
  vocal_records: 'Vocals', vocal_comps: 'Vocals',
  song_master: 'Master',
  music_score: 'Score',
  // Animation
  layout: 'Layout_Blocking', blocking: 'Layout_Blocking',
  animation: 'Animation',
  lrc: 'LRC', final_lrc: 'LRC',
  vfx_cleanup: 'VFX_Cleanup',
  // Audio Post
  vo_records: 'VO', vo_comps: 'VO',
  wallah_v1: 'Wallah', wallah_v2: 'Wallah', wallah_v3: 'Wallah',
  sfx_v1: 'SFX', sfx_v2: 'SFX', sfx_v3: 'SFX',
  sound_design: 'SoundDesign', final_mix: 'Mix',
  // Video Post
  edit_v1: 'Edit', edit_v2: 'Edit',
  picture_lock: 'PictureLock',
  color_grade: 'Grade',
  online_conform: 'Online',
  subtitle: 'Subtitle',
  // Post Ops / QC
  footage_ingest: 'Ingest',
  deliverys: 'Deliverys',
  qc: 'QC'
};

const pad = n => String(n).padStart(4, '0');
// Folder-safe name: everything outside [A-Za-z0-9] collapses away, so "../" and
// path separators cannot survive. "Animatic V1" -> "AnimaticV1".
const safe = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').join('');
// Episode/show codes keep their hyphens ("LA-101" must not become "LA101"), which
// is still traversal-proof: dots and separators are stripped either way.
const safeCode = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9-]+/g, '-')
  .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

function showRoot(show) {
  const code = safeCode(show.prefix) || safeCode(show.id) || 'SHOW';
  const name = safe(show.name);
  return name ? code + '_' + name : code;
}
function episodeFolder(ep) {
  const code = safeCode(ep.code) || safeCode(ep.id) || 'EP';
  const title = safe(ep.title);
  return title ? code + '_' + title : code;
}

/* Show-level skeleton: shared libraries + production admin. */
function showSkeleton(show) {
  const dirs = [''];
  dirs.push('!!_ShowLibrary');
  SHOW_LIBRARY.forEach((f, i) => dirs.push('!!_ShowLibrary/' + pad(i + 1) + '_' + f));
  dirs.push('0001_Production');
  PRODUCTION.forEach((f, i) => dirs.push('0001_Production/' + pad(i + 1) + '_' + f));
  dirs.push('0002_Episodes');
  return dirs;
}

/* The deliverable folders a department needs, in pipeline order, de-duplicated.
   Several tasks collapsing to one group yields one folder. */
function groupsFor(tasks) {
  const seen = [];
  tasks.forEach(t => {
    const g = GROUPS[t.key] || safe(t.name);   // unmapped task keeps its own folder
    if (g && !seen.includes(g)) seen.push(g);
  });
  return seen;
}

/* One episode's tree. Kept deliberately lean — working storage, not an archive:
   departments hold a folder per DELIVERABLE (iterations live inside as versioned
   files), approved handoffs collect in one !!_Publish, review packages in
   !!_Reviews. Long-term arrangement is the archival process's job, so nothing
   here exists purely for future browsing. */
function episodeTree(ep, pipeline) {
  const epRoot = '0002_Episodes/' + episodeFolder(ep);
  // Mezzanine holds delivered-but-unapproved work; Publish holds approved
  // handoffs. Per-deliverable subfolders inside both are created on demand.
  const dirs = [epRoot, epRoot + '/!!_Mezzanine', epRoot + '/!!_Publish', epRoot + '/!!_Reviews'];
  const used = DEPT_ORDER.filter(d => pipeline.some(t => t.dept === d));
  used.forEach((dept, di) => {
    const dRoot = epRoot + '/' + pad(di + 1) + '_' + DEPT_FOLDER[dept];
    dirs.push(dRoot);
    const groups = groupsFor(pipeline.filter(t => t.dept === dept));
    // A department with a single deliverable IS that folder — no Music/Music,
    // no QC/QC. Otherwise each deliverable gets a numbered subfolder.
    if (groups.length > 1) groups.forEach((g, gi) => dirs.push(dRoot + '/' + pad(gi + 1) + '_' + g));
  });
  return dirs;
}

/* Where one task's files live, relative to the show root. Same rules as
   episodeTree, so these paths always land inside the generated structure:
     work    — the deliverable folder; project files and WIP live here
     publish — !!_Publish/<Deliverable>/, the approved handoff downstream reads.
               Created lazily on first delivery, so it costs nothing until used.
   Returns null if the task isn't in this pipeline. */
function taskPaths(ep, pipeline, taskKey) {
  const task = pipeline.find(t => t.key === taskKey);
  if (!task) return null;
  const epRoot = '0002_Episodes/' + episodeFolder(ep);
  const used = DEPT_ORDER.filter(d => pipeline.some(t => t.dept === d));
  const di = used.indexOf(task.dept);
  if (di < 0) return null;
  const dRoot = epRoot + '/' + pad(di + 1) + '_' + DEPT_FOLDER[task.dept];

  const groups = groupsFor(pipeline.filter(t => t.dept === task.dept));
  const group = GROUPS[task.key] || safe(task.name);
  const gi = groups.indexOf(group);
  // single-deliverable departments collapse, exactly as episodeTree builds them
  const work = groups.length > 1 ? dRoot + '/' + pad(gi + 1) + '_' + group : dRoot;

  return {
    deliverable: group,
    work,
    // Deliveries land in Mezzanine and are promoted to Publish on approval, so a
    // downstream department never picks up an unapproved handoff.
    mezzanine: epRoot + '/!!_Mezzanine/' + group,
    publish: epRoot + '/!!_Publish/' + group,
    reviews: epRoot + '/!!_Reviews'
  };
}

/* Legacy/seed shows carry no `show.pipeline` (the client derives one from its
   TEMPLATE), so the task list comes from the client. Identity — show and episode
   names — still comes from stored state, and every task name is sanitised into a
   path segment, so the worst a bad payload can do is make oddly-named folders
   inside the show it already had access to. */
function normalisePipeline(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('pipeline must be a non-empty array');
  if (raw.length > 200) throw new Error('pipeline is implausibly long');
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') throw new Error('bad pipeline entry');
    if (!DEPT_FOLDER[t.dept]) throw new Error('unknown department: ' + t.dept);
    const name = safe(t.name);
    if (!name) throw new Error('task name has no usable characters: ' + t.name);
    // `key` drives the deliverable grouping and `deps` the Assets panel; both are
    // only ever used as task lookups, never as path segments, so they need no
    // sanitising beyond being strings.
    out.push({
      key: String(t.key || ''),
      name: String(t.name),
      dept: t.dept,
      deps: Array.isArray(t.deps) ? t.deps.map(String) : []
    });
  }
  return out;
}

/* Create dirs under <masterPath>/<showRoot>/. Returns which were newly made vs
   already there, so re-running is safe and reports honestly. */
function createDirs(masterPath, show, relDirs) {
  const root = path.resolve(masterPath, showRoot(show));
  const base = path.resolve(masterPath);
  // belt-and-braces: nothing may escape the master directory
  if (root !== base && !root.startsWith(base + path.sep)) throw new Error('resolved outside the master directory');

  const created = [], existed = [];
  for (const rel of relDirs) {
    const full = rel ? path.join(root, rel) : root;
    if (!full.startsWith(base + path.sep) && full !== base) throw new Error('path escapes the master directory: ' + rel);
    if (fs.existsSync(full)) { existed.push(rel); continue; }
    fs.mkdirSync(full, { recursive: true });
    created.push(rel);
  }
  return { root, created, existed };
}

/* Studio-wide template library, one level above the shows. Project templates are
   the same across a slate, so they live here rather than being copied into every
   show; a show's own !!_ShowLibrary/0004_GFX_AndTemplates still works and takes
   precedence, for a show that needs a bespoke version. */
const MASTER_TEMPLATES = '!!_Templates';
const SHOW_TEMPLATES = '!!_ShowLibrary/0004_GFX_AndTemplates';

// Resolve inside the master directory itself (not scoped to a show).
function resolveMaster(masterPath, rel) {
  const base = path.resolve(masterPath);
  const full = path.resolve(base, rel || '');
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('path escapes the master directory');
  }
  return full;
}

/* Resolve a show-relative path to an absolute one, refusing anything that would
   escape the master directory. Every filesystem call below goes through this. */
function resolveIn(masterPath, show, rel) {
  const base = path.resolve(masterPath);
  const root = path.resolve(base, showRoot(show));
  const full = path.resolve(root, rel || '');
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('path escapes the master directory');
  }
  return full;
}

// A filename we're willing to write. Keeps dots (extensions matter) but strips
// separators and leading dots so nothing can traverse or become hidden.
function safeFile(name) {
  const base = path.basename(String(name == null ? '' : name));
  const clean = base.replace(/[/\\:]+/g, '_').replace(/^\.+/, '').trim();
  return clean || 'untitled';
}

// Never silently overwrite a teammate's delivery: file.mov -> file_2.mov
function uniquePath(dir, filename) {
  const ext = path.extname(filename), stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename), n = 1;
  while (fs.existsSync(candidate)) { n++; candidate = path.join(dir, stem + '_' + n + ext); }
  return candidate;
}

/* List a folder's contents (files and directories) — backs the Assets panel and
   the in-app "pick from the mount" browser, so nobody needs Finder. */
function listDir(absDir) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (e) { return []; }
  return entries
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const full = path.join(absDir, e.name);
      let dir = e.isDirectory(), size = 0, mtime = 0;
      try {
        const st = fs.statSync(full);
        dir = st.isDirectory(); size = st.size; mtime = st.mtimeMs;
      } catch (err) { /* vanished or unreadable — report what we know */ }
      return { name: e.name, dir, size, mtime, path: full };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
}

/* Every template available to a task, studio library first, then anything the
   show overrides. A show-specific file with the same name wins, so a bespoke
   version replaces the studio one rather than appearing twice. */
function templatesFor(masterPath, show) {
  const NOT_TEMPLATE = ['txt', 'md', 'rtf', 'pdf', 'doc', 'docx'];
  const usable = f => !f.dir && !NOT_TEMPLATE.includes(f.name.split('.').pop().toLowerCase());
  const pick = (absDir, source) => listDir(absDir).filter(usable)
    .map(f => ({ name: f.name, size: f.size, source }));

  const master = pick(resolveMaster(masterPath, MASTER_TEMPLATES), 'master');
  const own = pick(resolveIn(masterPath, show, SHOW_TEMPLATES), 'show');
  const ownNames = own.map(t => t.name);
  return own.concat(master.filter(t => !ownNames.includes(t.name)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// Absolute path of one template, from whichever library it came from.
function templatePath(masterPath, show, name, source) {
  const file = safeFile(name);
  return source === 'show'
    ? resolveIn(masterPath, show, SHOW_TEMPLATES + '/' + file)
    : resolveMaster(masterPath, MASTER_TEMPLATES + '/' + file);
}

module.exports = {
  showSkeleton, episodeTree, taskPaths, createDirs, normalisePipeline,
  showRoot, episodeFolder, safe, safeFile, resolveIn, resolveMaster,
  uniquePath, listDir, templatesFor, templatePath,
  MASTER_TEMPLATES, SHOW_TEMPLATES, GROUPS
};
