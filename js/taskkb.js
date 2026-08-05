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
  function seedLibrary() {
    return SEED.map(t => Object.assign({ id: t.dept + ':' + slug(t.name), enabled: true }, t));
  }

  // total working days one instance of this task consumes, revisions included
  const taskDays = (t) => Math.max(1, (t.days || 0) + (t.rev || 0) * (t.revDays || 0));

  const library = () => {
    const d = App.state.data;
    if (!d) return [];
    if (!d.taskKb || !d.taskKb.length) return seedLibrary();
    return d.taskKb;
  };
  const isSeeded = () => !!(App.state.data && App.state.data.taskKb && App.state.data.taskKb.length);

  function saveLibrary(lib) {
    App.mutate(d => { d.taskKb = lib; });
  }
  function ensureSeeded() {
    if (!isSeeded()) saveLibrary(seedLibrary());
  }

  /* The tasks that apply to a show type, in waterfall order. This is what the
     planner consumes instead of a hand-written pipeline. */
  function tasksFor(type) {
    return library()
      .filter(t => t.enabled !== false && (t.types || BOTH).includes(type))
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
    const lib = JSON.parse(JSON.stringify(library()));
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
      ])
    ]));

    // what the library implies for a typical order, so edits have consequences
    const statsBox = el('.pl-stats');
    function refreshStats() {
      statsBox.innerHTML = '';
      const a = summary('animation', 10), l = summary('live_action', 10);
      [['Animation', a], ['Live Action', l]].forEach(([label, s]) => {
        statsBox.appendChild(el('.pl-stat', null, [
          el('.pl-stat-lab', null, label + ' · 10 eps'),
          el('.pl-stat-val', null, s.totalDays + ' task-days'),
          el('.pl-stat-sub', null, s.taskCount + ' tasks → ' + s.instances + ' instances · ' +
            Math.round(s.revShare * 100) + '% of it revisions')
        ]));
      });
      statsBox.appendChild(el('.pl-stat', null, [
        el('.pl-stat-lab', null, 'Library'),
        el('.pl-stat-val', null, lib.filter(t => t.enabled !== false).length + ' active'),
        el('.pl-stat-sub', null, lib.length + ' total across ' + DEPT_ORDER.length + ' departments')
      ]));
    }

    const table = el('.pl-kb');
    function render() {
      table.innerHTML = '';
      table.appendChild(el('.pl-kb-head', null, [
        el('.cell', null, 'Task'), el('.cell', null, 'Scope'), el('.cell', null, 'Stage'),
        el('.cell', null, 'Days'), el('.cell', null, 'Revs'), el('.cell', null, 'Days / rev'),
        el('.cell', null, 'Total'), el('.cell', null, 'Types'), el('.cell', null, '')
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
                         stage: Math.max(1, maxStage), days: 3, rev: 1, revDays: 1, types: BOTH.slice(), enabled: true });
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

          const typeBox = el('.pl-kb-types');
          [['animation', 'Anim'], ['live_action', 'Live']].forEach(([v, l]) => {
            const c = el('input', { type: 'checkbox' });
            c.checked = (t.types || BOTH).includes(v);
            c.addEventListener('change', () => {
              const set = new Set(t.types || BOTH);
              if (c.checked) set.add(v); else set.delete(v);
              t.types = [...set];
              refreshStats();
            });
            typeBox.appendChild(el('label.pl-kb-type', null, [c, el('span', null, l)]));
          });

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
            el('.cell', null, typeBox),
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
        onclick: () => App.confirm('Reset the library to the seeded studio defaults? Your edits will be lost.',
          () => { saveLibrary(seedLibrary()); App.toast('Task library reset to defaults'); },
          { title: 'Reset task library', yesLabel: 'Reset' })
      }, 'Reset to defaults'),
      el('button.btn-primary', {
        onclick: () => {
          const bad = lib.find(t => !(t.name || '').trim());
          if (bad) { App.toast('Every task needs a name', true); return; }
          saveLibrary(lib);
          App.toast('Task knowledge base saved — ' + lib.filter(t => t.enabled !== false).length + ' active tasks');
          App.state.planning.view = 'hub'; App.render();
        }
      }, [App.icon('save'), ' Save library'])
    ]));

    render(); refreshStats();
    return box;
  }

  App.taskKb = {
    seedLibrary, library, saveLibrary, ensureSeeded, isSeeded,
    taskDays, tasksFor, stagesFor, stagesFromTasks, summary, editor, DEPT_ORDER
  };
})();
