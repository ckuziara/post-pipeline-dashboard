/* Task Knowledge Base — every task the studio knows how to do, per department,
   with the time it takes and the revisions it habitually needs.

   This is the reference layer the planner reasons from. Two facts make it
   useful that a flat task list can't express:

     • REVISIONS ARE THE REAL SCHEDULE. A storyboard isn't 8 days, it's 8 days
       plus two rounds of 3. Quoting base time only is how animation schedules
       get sold short, so every entry carries `revisions` × `revisionDays` and
       the planner books all of it.

     • SCOPE DIFFERS. A series bible is written once; an animatic is drawn per
       episode. `scope: 'series' | 'episode'` is what makes the pipeline scale
       with episode count instead of multiplying fixed costs.

   `stage` orders the waterfall: lower stages finish before higher ones start,
   and tasks sharing a stage run in parallel. That expresses a real pipeline
   without asking anyone to author a full dependency graph by hand.

   Entries are seeded from studio norms and are fully editable — this is a
   living document, not a constant. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  const BOTH = ['animation', 'live_action'];

  /* Seeded library. days = first pass; rev × revDays = the rounds that follow.
     Kept deliberately explicit rather than derived so a producer can argue with
     any single number without unpicking a formula. */
  const SEED = [
    // ---- development & creative -------------------------------------------
    { dept: 'creative', name: 'Series Bible',            scope: 'series',  stage: 1,  days: 10, rev: 2, revDays: 3, types: BOTH },
    { dept: 'creative', name: 'Style Guide',             scope: 'series',  stage: 2,  days: 8,  rev: 2, revDays: 2, types: ['animation'] },
    { dept: 'creative', name: 'Character Design',        scope: 'series',  stage: 3,  days: 12, rev: 3, revDays: 2, types: ['animation'] },
    { dept: 'creative', name: 'Environment & Prop Design', scope: 'series', stage: 4, days: 10, rev: 2, revDays: 2, types: ['animation'] },
    { dept: 'creative', name: 'Episode Outline',         scope: 'episode', stage: 5,  days: 3,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'creative', name: 'Script Draft',            scope: 'episode', stage: 6,  days: 5,  rev: 2, revDays: 2, types: BOTH },
    { dept: 'creative', name: 'Storyboard',              scope: 'episode', stage: 7,  days: 8,  rev: 2, revDays: 3, types: BOTH },
    { dept: 'creative', name: 'Animatic',                scope: 'episode', stage: 8,  days: 5,  rev: 2, revDays: 2, types: ['animation'] },

    // ---- music -------------------------------------------------------------
    { dept: 'music', name: 'Theme & Title Music',        scope: 'series',  stage: 3,  days: 6,  rev: 2, revDays: 2, types: BOTH },
    { dept: 'music', name: 'Music Spotting',             scope: 'episode', stage: 7,  days: 2,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'music', name: 'Song Composition',           scope: 'episode', stage: 9,  days: 4,  rev: 2, revDays: 2, types: ['animation'] },
    { dept: 'music', name: 'Vocal Record',               scope: 'episode', stage: 10, days: 2,  rev: 1, revDays: 1, types: ['animation'] },
    { dept: 'music', name: 'Vocal Comp & Tuning',        scope: 'episode', stage: 11, days: 3,  rev: 1, revDays: 1, types: ['animation'] },
    { dept: 'music', name: 'Score Record',               scope: 'episode', stage: 11, days: 3,  rev: 1, revDays: 2, types: ['live_action'] },
    { dept: 'music', name: 'Music Mix & Master',         scope: 'episode', stage: 13, days: 3,  rev: 1, revDays: 2, types: BOTH },

    // ---- animation (out of house) -----------------------------------------
    { dept: 'animation', name: 'Rigging',                scope: 'series',  stage: 4,  days: 15, rev: 2, revDays: 3, types: ['animation'] },
    { dept: 'animation', name: 'Layout & Blocking',      scope: 'episode', stage: 10, days: 6,  rev: 2, revDays: 2, types: ['animation'] },
    { dept: 'animation', name: 'Animation',              scope: 'episode', stage: 11, days: 15, rev: 2, revDays: 4, types: ['animation'] },
    { dept: 'animation', name: 'Lighting & Render',      scope: 'episode', stage: 12, days: 6,  rev: 1, revDays: 2, types: ['animation'] },
    { dept: 'animation', name: 'Compositing',            scope: 'episode', stage: 13, days: 5,  rev: 1, revDays: 2, types: ['animation'] },

    // ---- picture editorial (live action) ----------------------------------
    { dept: 'video', name: 'Footage Ingest & Sync',      scope: 'episode', stage: 6,  days: 2,  rev: 0, revDays: 0, types: ['live_action'] },
    { dept: 'video', name: 'Assembly Edit',              scope: 'episode', stage: 7,  days: 5,  rev: 1, revDays: 2, types: ['live_action'] },
    { dept: 'video', name: 'Rough Cut',                  scope: 'episode', stage: 8,  days: 5,  rev: 2, revDays: 2, types: ['live_action'] },
    { dept: 'video', name: 'Fine Cut',                   scope: 'episode', stage: 10, days: 4,  rev: 2, revDays: 2, types: ['live_action'] },
    { dept: 'video', name: 'Picture Lock',               scope: 'episode', stage: 11, days: 1,  rev: 0, revDays: 0, types: ['live_action'] },
    { dept: 'video', name: 'VFX Shots',                  scope: 'episode', stage: 12, days: 8,  rev: 2, revDays: 3, types: ['live_action'] },

    // ---- audio post --------------------------------------------------------
    { dept: 'audio', name: 'VO Record',                  scope: 'episode', stage: 9,  days: 2,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'audio', name: 'VO Edit & Comp',             scope: 'episode', stage: 10, days: 3,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'audio', name: 'Dialogue Edit',              scope: 'episode', stage: 13, days: 3,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'audio', name: 'Foley & Wallah',             scope: 'episode', stage: 12, days: 3,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'audio', name: 'SFX Design',                 scope: 'episode', stage: 12, days: 5,  rev: 2, revDays: 2, types: BOTH },
    { dept: 'audio', name: 'Pre-Dub',                    scope: 'episode', stage: 14, days: 2,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'audio', name: 'Final Mix',                  scope: 'episode', stage: 15, days: 4,  rev: 2, revDays: 2, types: BOTH },

    // ---- finishing ---------------------------------------------------------
    { dept: 'video', name: 'Online Conform',             scope: 'episode', stage: 16, days: 2,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'video', name: 'Colour Grade',               scope: 'episode', stage: 17, days: 3,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'video', name: 'Titles & Graphics',          scope: 'episode', stage: 17, days: 2,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'video', name: 'Subtitles & Captions',       scope: 'episode', stage: 18, days: 2,  rev: 1, revDays: 1, types: BOTH },

    // ---- operations & QC ---------------------------------------------------
    { dept: 'ops', name: 'Media Setup & Naming',         scope: 'series',  stage: 4,  days: 3,  rev: 0, revDays: 0, types: BOTH },
    { dept: 'ops', name: 'Deliverable Creation',         scope: 'episode', stage: 19, days: 2,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'qc',  name: 'Technical QC',                 scope: 'episode', stage: 20, days: 2,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'qc',  name: 'Compliance QC',                scope: 'episode', stage: 20, days: 2,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'qc',  name: 'Client Review',                scope: 'episode', stage: 21, days: 3,  rev: 2, revDays: 2, types: BOTH },
    { dept: 'ops', name: 'Master Delivery',              scope: 'episode', stage: 22, days: 2,  rev: 1, revDays: 1, types: BOTH },
    { dept: 'ops', name: 'Archive & Wrap',               scope: 'episode', stage: 23, days: 1,  rev: 0, revDays: 0, types: BOTH }
  ];

  /* Ids are derived from dept+name rather than random, so the unsaved fallback
     library is byte-identical every time it's built. The scheduler calls this
     on every simulation; churning ids would make bars unstable between runs. */
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const TYPES = ['animation', 'live_action'];
  const TYPE_LABEL = { animation: 'Animation', live_action: 'Live Action' };

  /* Animation and Live Action are SEPARATE libraries, not one list with a type
     flag. A final mix on a live-action episode isn't the same job as one on an
     animated episode — different days, different revision counts — and sharing
     one entry meant tuning either was impossible without disturbing the other.
     Each type therefore owns its own copy, editable independently. */
  function seedFor(type) {
    return SEED
      .filter(t => (t.types || TYPES).includes(type))
      .map(t => {
        const c = Object.assign({}, t);
        delete c.types;                                  // the list it lives in IS its type
        return Object.assign({ id: t.dept + ':' + slug(t.name), enabled: true }, c);
      });
  }
  function seedLibrary() {
    return { animation: seedFor('animation'), live_action: seedFor('live_action') };
  }

  // total working days one instance of this task consumes, revisions included
  const taskDays = (t) => Math.max(1, (t.days || 0) + (t.rev || 0) * (t.revDays || 0));

  /* Older saves hold a single shared array. Split it per type, deep-copying so
     the two sides are genuinely independent from the first edit onward. */
  function migrate(stored) {
    if (!Array.isArray(stored)) return stored;
    const out = {};
    TYPES.forEach(type => {
      out[type] = stored
        .filter(t => (t.types || TYPES).includes(type))
        .map(t => { const c = JSON.parse(JSON.stringify(t)); delete c.types; return c; });
    });
    return out;
  }

  const store = () => {
    const d = App.state.data;
    if (!d || !d.taskKb) return null;
    const s = migrate(d.taskKb);
    return (s && (s.animation || s.live_action)) ? s : null;
  };
  const library = (type) => {
    const s = store();
    if (!s) return seedFor(type);
    return s[type] && s[type].length ? s[type] : seedFor(type);
  };
  const isSeeded = () => !!store();

  // writes one type's list, leaving the other untouched
  function saveLibrary(type, lib) {
    App.mutate(d => {
      const cur = migrate(d.taskKb) || {};
      d.taskKb = Object.assign({ animation: library('animation'), live_action: library('live_action') }, cur);
      d.taskKb[type] = lib;
    });
  }
  function ensureSeeded() {
    if (!isSeeded()) App.mutate(d => { d.taskKb = seedLibrary(); });
  }

  /* The tasks that apply to a show type, in waterfall order. This is what the
     planner consumes instead of a hand-written pipeline. */
  function tasksFor(type) {
    return library(type)
      .filter(t => t.enabled !== false)
      .slice()
      .sort((a, b) => (a.stage - b.stage) || (a.dept < b.dept ? -1 : 1));
  }

  /* Roll the library into per-stage groups, which is the shape the scheduler
     wants: everything in a stage may run at once, stages run in order. */
  function stagesFor(type, episodes) {
    return stagesFromTasks(tasksFor(type), episodes);
  }

  // same grouping over an explicit task list — used by a crafted, show-specific
  // pipeline, which is a subset of the library with its own revision counts
  function stagesFromTasks(tasks, episodes) {
    const eps = Math.max(1, episodes || 1);
    const byStage = {};
    (tasks || []).forEach(t => {
      const s = byStage[t.stage] = byStage[t.stage] || { stage: t.stage, tasks: [] };
      s.tasks.push(t);
    });
    return Object.keys(byStage).map(Number).sort((a, b) => a - b).map(k => {
      const g = byStage[k];
      // a stage is only as short as its longest task; series work happens once,
      // episode work repeats, which is what makes the plan scale
      g.seriesDays = g.tasks.filter(t => t.scope === 'series').reduce((m, t) => Math.max(m, taskDays(t)), 0);
      g.episodeDays = g.tasks.filter(t => t.scope === 'episode').reduce((m, t) => Math.max(m, taskDays(t)), 0);
      g.instances = g.tasks.reduce((s, t) => s + (t.scope === 'series' ? 1 : eps), 0);
      return g;
    });
  }

  // headline totals for the intake/report summaries
  function summary(type, episodes) {
    const eps = Math.max(1, episodes || 1);
    const tasks = tasksFor(type);
    const series = tasks.filter(t => t.scope === 'series');
    const perEp = tasks.filter(t => t.scope === 'episode');
    const revDays = tasks.reduce((s, t) => s + (t.rev || 0) * (t.revDays || 0) * (t.scope === 'series' ? 1 : eps), 0);
    const baseDays = tasks.reduce((s, t) => s + (t.days || 0) * (t.scope === 'series' ? 1 : eps), 0);
    return {
      taskCount: tasks.length,
      seriesCount: series.length,
      episodeCount: perEp.length,
      instances: series.length + perEp.length * eps,
      baseDays, revDays, totalDays: baseDays + revDays,
      revShare: baseDays + revDays ? revDays / (baseDays + revDays) : 0
    };
  }

  /* ============================================================== editor === */
  const DEPT_ORDER = ['creative', 'music', 'animation', 'audio', 'video', 'ops', 'qc'];

  function editor() {
    /* Deliberately does NOT persist the seed on open. Saving during a render
       would re-enter App.render() and paint the view twice; the fallback
       library is already returned by library(), and Save writes it for real. */
    const st = App.state.planning;
    const type = (st.kbType = st.kbType || 'animation');
    const lib = JSON.parse(JSON.stringify(library(type)));
    const box = el('div');

    box.appendChild(el('.pl-crumb', null, [
      el('span.pl-crumb-link', { onclick: () => { App.state.planning.view = 'hub'; App.render(); } }, 'Planning'),
      el('span', null, '/'),
      el('span.pl-crumb-here', null, 'Task Knowledge Base')
    ]));
    box.appendChild(el('.pl-head', null, [
      el('div', null, [
        el('.pl-title', null, 'Task Knowledge Base'),
        el('.pl-sub', null, 'Every task the studio knows how to do, with the revisions it actually needs. The planner books base time plus every revision round — this is where a schedule stops being optimistic.')
      ]),
      el('button.btn-ghost', {
        title: 'See the stage order as a pipeline',
        onclick: () => { commit(); st.view = 'kbflow'; App.render(); }
      }, [App.icon('chart'), ' Stage flow'])
    ]));

    /* Animation and Live Action are independent libraries; the switch changes
       which one you're editing, not a filter over a shared list. Unsaved edits
       are carried over so switching to compare doesn't cost you your work. */
    const tabs = el('.pl-kb-types-bar');
    TYPES.forEach(tp => {
      tabs.appendChild(el('button.pl-kb-typetab' + (tp === type ? '.active' : ''), {
        onclick: () => {
          if (tp === type) return;
          commit();                       // keep this type's edits in the draft
          st.kbType = tp; App.render();
        }
      }, [
        TYPE_LABEL[tp],
        el('span.pl-kb-typecount', null, String(library(tp).filter(t => t.enabled !== false).length))
      ]));
    });
    box.appendChild(tabs);

    // Unsaved edits survive a type switch or a hop to the stage flow.
    const DRAFTS = (App.taskKb._drafts = App.taskKb._drafts || {});
    if (DRAFTS[type]) lib.splice(0, lib.length, ...JSON.parse(JSON.stringify(DRAFTS[type])));
    function commit() { DRAFTS[type] = JSON.parse(JSON.stringify(lib)); }

    // what this library implies for a typical order, so edits have consequences
    const statsBox = el('.pl-stats');
    function refreshStats() {
      statsBox.innerHTML = '';
      const active = lib.filter(t => t.enabled !== false);
      const eps = 10;
      const base = active.reduce((s, t) => s + (t.days || 0) * (t.scope === 'series' ? 1 : eps), 0);
      const rev = active.reduce((s, t) => s + (t.rev || 0) * (t.revDays || 0) * (t.scope === 'series' ? 1 : eps), 0);
      const inst = active.reduce((s, t) => s + (t.scope === 'series' ? 1 : eps), 0);
      const stages = new Set(active.map(t => t.stage)).size;
      statsBox.appendChild(el('.pl-stat', null, [
        el('.pl-stat-lab', null, TYPE_LABEL[type] + ' · 10 eps'),
        el('.pl-stat-val', null, (base + rev) + ' task-days'),
        el('.pl-stat-sub', null, active.length + ' tasks → ' + inst + ' instances · ' +
          Math.round((base + rev ? rev / (base + rev) : 0) * 100) + '% of it revisions')
      ]));
      statsBox.appendChild(el('.pl-stat', null, [
        el('.pl-stat-lab', null, 'Pipeline'),
        el('.pl-stat-val', null, stages + ' stages'),
        el('.pl-stat-sub', null, 'lower stages finish before higher ones start')
      ]));
      statsBox.appendChild(el('.pl-stat', null, [
        el('.pl-stat-lab', null, TYPE_LABEL[type] + ' library'),
        el('.pl-stat-val', null, active.length + ' active'),
        el('.pl-stat-sub', null, lib.length + ' total across ' + DEPT_ORDER.length + ' departments')
      ]));
    }

    const table = el('.pl-kb');
    function render() {
      table.innerHTML = '';
      table.appendChild(el('.pl-kb-head', null, [
        el('.cell', null, 'Task'), el('.cell', null, 'Scope'), el('.cell', null, 'Stage'),
        el('.cell', null, 'Days'), el('.cell', null, 'Revs'), el('.cell', null, 'Days / rev'),
        el('.cell', null, 'Total'), el('.cell', null, '')
      ]));

      DEPT_ORDER.forEach(dept => {
        const rows = lib.filter(t => t.dept === dept);
        const dep = App.dept(dept);
        table.appendChild(el('.pl-kb-group', null, [
          el('.pl-rate-group-name', null, [
            el('span.dot', { style: { background: dep.color } }),
            el('span', null, dep.label),
            el('span.pl-rate-count', null, rows.length + (rows.length === 1 ? ' task' : ' tasks'))
          ]),
          el('button.btn-mini', {
            title: 'Add a task to ' + dep.label,
            onclick: () => {
              const maxStage = lib.reduce((m, t) => Math.max(m, t.stage || 0), 0);
              lib.push({ id: App.uid(), dept, name: 'New task', scope: 'episode',
                         stage: Math.max(1, maxStage), days: 3, rev: 1, revDays: 1, enabled: true });
              render(); refreshStats();
            }
          }, '＋ Task')
        ]));

        rows.forEach(t => {
          const num = (prop, min, max, w) => {
            const i = el('input.fld.pl-kb-num', { type: 'number', min: String(min), max: String(max), value: String(t[prop] != null ? t[prop] : min) });
            i.addEventListener('input', () => {
              t[prop] = Math.max(min, Math.min(max, parseInt(i.value, 10) || min));
              totalOut.textContent = taskDays(t) + 'd';
              refreshStats();
            });
            return i;
          };
          const totalOut = el('span.pl-kb-total', null, taskDays(t) + 'd');

          const nameI = el('input.fld.pl-kb-name', { type: 'text', value: t.name });
          nameI.addEventListener('input', () => { t.name = nameI.value; });

          const scopeSel = el('select.fld.pl-kb-scope');
          [['episode', 'Per episode'], ['series', 'Once per series']].forEach(([v, l]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = l;
            if (v === t.scope) o.selected = true; scopeSel.appendChild(o);
          });
          scopeSel.addEventListener('change', () => { t.scope = scopeSel.value; refreshStats(); });

          const onChk = el('input', { type: 'checkbox' });
          onChk.checked = t.enabled !== false;
          onChk.addEventListener('change', () => { t.enabled = onChk.checked; render(); refreshStats(); });

          table.appendChild(el('.pl-kb-row' + (t.enabled === false ? '.off' : ''), null, [
            el('.cell.pl-kb-namecell', null, [onChk, nameI]),
            el('.cell', null, scopeSel),
            el('.cell', null, num('stage', 1, 60)),
            el('.cell', null, num('days', 1, 200)),
            el('.cell', null, num('rev', 0, 10)),
            el('.cell', null, num('revDays', 0, 60)),
            el('.cell.pl-kb-totalcell', null, totalOut),
            el('.cell.pl-rate-x', null, el('button.btn-mini.danger', {
              title: 'Delete this task from the library',
              onclick: () => {
                lib.splice(lib.findIndex(x => x.id === t.id), 1);
                render(); refreshStats();
              }
            }, App.icon('trash')))
          ]));
        });
      });
    }

    box.appendChild(statsBox);
    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Task library'),
        el('.pl-card-desc', null, 'Total = base days + revisions × days per revision. Stage sets the waterfall: lower stages finish first, tasks sharing a stage run in parallel.')
      ]),
      table
    ]));

    box.appendChild(el('.pl-actions', null, [
      el('button.btn-ghost', { onclick: () => { App.state.planning.view = 'hub'; App.render(); } }, 'Cancel'),
      el('button.btn-ghost', {
        onclick: () => App.confirm('Reset the ' + TYPE_LABEL[type] + ' library to the seeded studio defaults? Only this library is affected — ' + TYPE_LABEL[type === 'animation' ? 'live_action' : 'animation'] + ' is left alone.',
          () => { delete DRAFTS[type]; saveLibrary(type, seedFor(type)); App.toast(TYPE_LABEL[type] + ' library reset to defaults'); },
          { title: 'Reset ' + TYPE_LABEL[type] + ' library', yesLabel: 'Reset' })
      }, 'Reset to defaults'),
      el('button.btn-primary', {
        onclick: () => {
          const bad = lib.find(t => !(t.name || '').trim());
          if (bad) { App.toast('Every task needs a name', true); return; }
          delete DRAFTS[type];
          saveLibrary(type, lib);
          App.toast(TYPE_LABEL[type] + ' library saved — ' + lib.filter(t => t.enabled !== false).length + ' active tasks');
          App.state.planning.view = 'hub'; App.render();
        }
      }, [App.icon('save'), ' Save library'])
    ]));

    render(); refreshStats();
    return box;
  }

  /* ========================================================= stage flow ===
     A number in a box can't show a pipeline. This view draws the same `stage`
     data two ways at once:

       • a proportional strip — each stage as wide as it is long, so you can
         see where the weeks actually go, not just what order things happen in
       • columns of cards — one per stage, holding the tasks that run in
         PARALLEL there, which is the fact the integer hides completely

     Dragging a card to another column restages it, so ordering the pipeline is
     a physical act rather than arithmetic. */
  function stageFlow() {
    const st = App.state.planning;
    const type = st.kbType || 'animation';
    const DRAFTS = (App.taskKb._drafts = App.taskKb._drafts || {});
    // edit the same draft the table is editing, so the two stay in step
    const lib = DRAFTS[type] ? JSON.parse(JSON.stringify(DRAFTS[type]))
                             : JSON.parse(JSON.stringify(library(type)));
    const commit = () => { DRAFTS[type] = JSON.parse(JSON.stringify(lib)); };

    const box = el('div');
    box.appendChild(el('.pl-crumb', null, [
      el('span.pl-crumb-link', { onclick: () => { st.view = 'hub'; App.render(); } }, 'Planning'),
      el('span', null, '/'),
      el('span.pl-crumb-link', { onclick: () => { st.view = 'kb'; App.render(); } }, 'Task Knowledge Base'),
      el('span', null, '/'),
      el('span.pl-crumb-here', null, 'Stage flow')
    ]));

    const head = el('.pl-head', null, [
      el('div', null, [
        el('.pl-title', null, TYPE_LABEL[type] + ' pipeline'),
        el('.pl-sub', null, 'Each column is a stage; everything in a column runs at the same time. Drag a task to another stage to reorder the pipeline.')
      ]),
      el('.pl-kb-types-bar', null, TYPES.map(tp =>
        el('button.pl-kb-typetab' + (tp === type ? '.active' : ''), {
          onclick: () => { if (tp !== type) { commit(); st.kbType = tp; App.render(); } }
        }, TYPE_LABEL[tp])))
    ]);
    box.appendChild(head);

    const wrap = el('div');
    let dragId = null;

    function stages() {
      const map = {};
      lib.filter(t => t.enabled !== false).forEach(t => {
        (map[t.stage] = map[t.stage] || []).push(t);
      });
      return Object.keys(map).map(Number).sort((a, b) => a - b)
        .map(s => ({ stage: s, tasks: map[s], days: map[s].reduce((m, t) => Math.max(m, taskDays(t)), 0) }));
    }

    /* Renumber to a dense 1..n after every move. Emptying a stage otherwise
       leaves a hole — the pipeline would still run correctly, but the labels
       would start at "Stage 2" and the numbers would drift further from the
       column count with each drag. Order is preserved; only the labels close up.
       Disabled tasks are renumbered too, so re-enabling one can't resurrect a
       stale stage number. */
    function renumber() {
      const used = [...new Set(lib.map(t => t.stage))].sort((a, b) => a - b);
      const map = new Map(used.map((s, i) => [s, i + 1]));
      lib.forEach(t => { t.stage = map.get(t.stage); });
    }
    function moveTo(taskId, targetStage) {
      const t = lib.find(x => x.id === taskId);
      if (!t || t.stage === targetStage) return;
      t.stage = targetStage;
      renumber();
      commit();
      draw();
    }

    function draw() {
      wrap.innerHTML = '';
      const list = stages();
      if (!list.length) {
        wrap.appendChild(el('.pl-empty', null, 'No active tasks in this library yet.'));
        return;
      }
      const total = list.reduce((s, g) => s + g.days, 0) || 1;

      // ---- proportional duration strip ----
      const strip = el('.kbf-strip');
      list.forEach(g => {
        const seg = el('.kbf-seg', {
          style: { width: (g.days / total * 100) + '%' },
          title: 'Stage ' + g.stage + ' — ' + g.days + ' days (longest task), ' + g.tasks.length + ' in parallel'
        }, [
          el('span.kbf-seg-n', null, String(g.stage)),
          el('span.kbf-seg-d', null, g.days + 'd')
        ]);
        strip.appendChild(seg);
      });
      wrap.appendChild(el('.pl-card', null, [
        el('.pl-card-head', null, [
          el('.pl-card-title', null, 'Where the time goes'),
          el('.pl-card-desc', null, 'Each stage sized by its longest task — ' + total +
            ' working days end to end if every stage waits for the one before.')
        ]),
        strip
      ]));

      // ---- columns of parallel work ----
      const cols = el('.kbf-cols');
      list.forEach(g => {
        const col = el('.kbf-col');
        col.appendChild(el('.kbf-col-head', null, [
          el('span.kbf-col-n', null, 'Stage ' + g.stage),
          el('span.kbf-col-d', null, g.days + 'd')
        ]));
        const body = el('.kbf-col-body');
        // drop target
        body.addEventListener('dragover', e => { e.preventDefault(); body.classList.add('over'); });
        body.addEventListener('dragleave', () => body.classList.remove('over'));
        body.addEventListener('drop', e => {
          e.preventDefault(); body.classList.remove('over');
          if (dragId) moveTo(dragId, g.stage);
        });

        g.tasks.forEach(t => {
          const dep = App.dept(t.dept);
          const card = el('.kbf-card', {
            draggable: 'true',
            title: t.name + ' — ' + taskDays(t) + 'd (' + (t.days || 0) + ' + ' +
              (t.rev || 0) + '×' + (t.revDays || 0) + ' revisions)'
          }, [
            el('.kbf-card-top', null, [
              el('span.dot', { style: { background: dep.color } }),
              el('span.kbf-card-name', null, t.name)
            ]),
            el('.kbf-card-meta', null, [
              el('span', null, taskDays(t) + 'd'),
              el('span.kbf-card-scope', null, t.scope === 'series' ? 'per series' : 'per episode')
            ])
          ]);
          card.addEventListener('dragstart', () => { dragId = t.id; card.classList.add('dragging'); });
          card.addEventListener('dragend', () => { dragId = null; card.classList.remove('dragging'); });
          body.appendChild(card);
        });
        col.appendChild(body);
        cols.appendChild(col);
      });
      wrap.appendChild(el('.pl-card', null, [
        el('.pl-card-head', null, [
          el('.pl-card-title', null, 'Stages'),
          el('.pl-card-desc', null, 'Tasks in the same column run in parallel. Drag one sideways to move it to another stage.')
        ]),
        cols
      ]));
    }

    box.appendChild(wrap);
    box.appendChild(el('.pl-actions', null, [
      el('button.btn-ghost', { onclick: () => { st.view = 'kb'; App.render(); } }, '‹ Back to the table'),
      el('button.btn-primary', {
        onclick: () => {
          delete DRAFTS[type];
          saveLibrary(type, lib);
          App.toast(TYPE_LABEL[type] + ' pipeline saved');
          st.view = 'kb'; App.render();
        }
      }, [App.icon('save'), ' Save pipeline'])
    ]));
    draw();
    return box;
  }

  App.taskKb = {
    seedLibrary, seedFor, library, saveLibrary, ensureSeeded, isSeeded, TYPES, TYPE_LABEL,
    taskDays, tasksFor, stagesFor, stagesFromTasks, summary, editor, stageFlow, DEPT_ORDER
  };
})();
