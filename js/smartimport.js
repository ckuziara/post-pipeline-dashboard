/* Smart Import — the wizard. A producer drops in the .xlsx the production
   already lives in; js/smartimport-engine.js reads a first draft out of it,
   and these four steps put every guess in front of them to correct before
   anything is created:

     1 File          pick the workbook, then the sheet (each one labelled
                     with what it looks like: a calendar grid or a table)
     2 Episodes      which group of rows becomes the show, its name and code,
                     and each episode's code and title — tick out the strays
     3 Tasks         the sheet itself, with the reading drawn over it: drag a
                     bar to move it, drag an end to stretch it; underneath, the
                     pipeline — each task's name, department (or Live date,
                     Delivery date, Producer note), or remove it
     4 Dependencies  the episodes on the Timeline's own axis: link what waits
                     for what, make final adjustments, and Create

   Both timelines use the main Timeline's header, zoom tiers and weekend
   handling (App.ganttAxis), and zoom the same way: −/Fit/＋, Ctrl+scroll or
   pinch, and ⌘+ / ⌘−.

   Create builds a show back-up and hands it to App.importShow — the same
   door Import show uses — so prefix clashes, audit and the toast all come
   from there. Nothing is written before that button. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const E = () => App.smartImportEngine;
  const STEPS = ['File', 'Episodes', 'Tasks', 'Dependencies'];
  const LABEL_W = 220;          // the Timeline's label rail (.g-label)
  const ZOOM_MIN = 0.6, ZOOM_MAX = 60, ZOOM_STEP = 1.25;

  let S = null;               // the wizard's state while it's open

  function fresh() {
    return { step: 0, fileName: '', book: null, sheets: [], sheetName: '', model: null, groupId: '',
      show: { name: '', prefix: '', type: 'animation' }, episodes: [], tasks: [], instances: [], deps: {},
      depsSeeded: false, sel: { task: null, inst: null }, hover: null, zoom: {}, expanded: {}, order: null, editor: null,
      showCells: true, showRemoved: false,
      pastDone: true,     // work dated before today comes in as done — see stepDeps
      busy: '', error: '' };
  }

  /* ---------------- shell ---------------- */
  let card = null, body = null, foot = null, stepper = null;

  /* ---------------- the draft ----------------
     Escape, the backdrop or ✕ partway through keeps the import as a draft,
     the way Add Show keeps a half-planned show (App.draft — this device
     only, never board data), and the next Smart import picks it up on the
     step it was left on. Created, or Start fresh, clears it.

     The workbook itself isn't kept — it can run to megabytes — only what was
     read from the chosen sheet and everything done to it since. So a draft
     resumes on any step; reading a different sheet needs the file again. */
  const DRAFT = 'smartImport';
  const KEEP = ['step', 'fileName', 'sheetName', 'model', 'groupId', 'show', 'episodes', 'tasks', 'instances',
    'deps', 'depsSeeded', 'order', 'zoom', 'expanded', 'showCells', 'showRemoved', 'pastDone'];
  function keepDraft() {
    if (!S) return;
    if (S.created || !S.model || !S.groupId) { App.draft.clear(DRAFT); return; }
    const d = { v: 1, savedAt: new Date().toISOString(),
      sheets: S.sheets.map(x => ({ name: x.name, hidden: x.hidden, summary: x.summary })) };
    KEEP.forEach(k => { d[k] = S[k]; });
    App.draft.set(DRAFT, d);
    // App.draft swallows a full localStorage; say so rather than lose it quietly
    const back = App.draft.get(DRAFT);
    if (!back || back.savedAt !== d.savedAt) App.toast('Couldn’t keep this import as a draft — the browser’s storage is full', true);
  }
  function restoreDraft() {
    const d = App.draft.get(DRAFT);
    if (!d || d.v !== 1 || !d.model || !d.groupId) return null;
    const st = fresh();
    KEEP.forEach(k => { if (d[k] !== undefined) st[k] = d[k]; });
    st.sheets = (d.sheets || []).map(x => Object.assign({}, x, x.name === d.sheetName ? { model: d.model } : {}));
    st.restoredAt = d.savedAt;
    return st;
  }

  function open() {
    if (!App.canManageShows(App.state.role)) { App.toast('Only Producers can add shows', true); return; }
    S = restoreDraft() || fresh();
    stepper = el('.smi-steps');
    body = el('.modal-body.smi-body');
    foot = el('.modal-foot');
    card = el('.modal-card.wide.smi-card', { onclick: (e) => e.stopPropagation() }, [
      el('.modal-head', null, [
        el('.modal-head-main', null, [
          App.icon('sparkle', { cls: 'modal-ic' }),
          el('div', null, [el('.modal-title', null, 'Smart import'),
            el('.modal-subtitle', null, 'Turn a production schedule spreadsheet into a show')])
        ]),
        stepper,
        el('button.modal-x', { onclick: () => App.modal.close(), title: 'Close' }, '✕')
      ]),
      body, foot
    ]);
    App.modal.open(card, { onClose: () => {
      keepDraft();
      S = null;
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pagehide', keepDraft);
    } });
    document.addEventListener('keydown', onKey, true);
    // closing the tab mid-import keeps it too
    window.addEventListener('pagehide', keepDraft);
    draw();
  }

  // the note at the top of a resumed import, with a way out of it
  function draftNote() {
    if (!S.restoredAt) return null;
    const when = new Date(S.restoredAt);
    return el('.draft-note', null, [
      el('span', null, [App.icon('save'), ' Picking up where you left off — ' + (S.fileName || 'your import') +
        (S.sheetName ? ', “' + S.sheetName.trim() + '”' : '') + ', saved ' + when.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '.']),
      el('button.draft-clear', {
        type: 'button', title: 'Throw this draft away and start a new import',
        onclick: () => { App.draft.clear(DRAFT); S.created = true; App.modal.close(); open(); }
      }, 'Start fresh')
    ]);
  }

  function go(step) {
    S.step = step; S.error = ''; S.sel = { task: null, inst: null }; S.hover = null;
    S.editor = null;                      // each step builds its own list
    if (step === 3 && !S.depsSeeded) {
      // a first pass from the dates, so linking starts from a draft, not a blank
      S.deps = E().suggestDeps(S.tasks, liveInstances());
      S.depsSeeded = true;
    }
    draw(); body.scrollTop = 0;
  }

  /* Scroll positions survive a redraw of the same step — a drag or a rename
     rebuilds the view, and it shouldn't jump back to the start. */
  function draw() {
    if (!S) return;
    const keep = {};
    if (S._drawnStep === S.step) {
      body.querySelectorAll('[data-keep]').forEach(n => { keep[n.dataset.keep] = [n.scrollLeft, n.scrollTop]; });
      keep.__body = [0, body.scrollTop];
    }
    S._drawnStep = S.step;
    stepper.innerHTML = '';
    STEPS.forEach((name, i) => {
      const reachable = i <= maxStep();
      stepper.appendChild(el('button.smi-step' + (i === S.step ? '.on' : '') + (i < S.step ? '.done' : ''), {
        type: 'button', disabled: !reachable || null,
        onclick: () => { if (reachable && i !== S.step) go(i); }
      }, [el('span.smi-step-n', null, i < S.step ? '✓' : String(i + 1)), name]));
    });
    body.innerHTML = '';
    foot.innerHTML = '';
    card.classList.toggle('smi-wide', S.step >= 2);
    const note = draftNote();
    if (note) body.appendChild(note);
    [stepFile, stepEpisodes, stepTasks, stepDeps][S.step]();
    if (keep.__body) body.scrollTop = keep.__body[1];
    body.querySelectorAll('[data-keep]').forEach(n => {
      const k = keep[n.dataset.keep]; if (!k) return;
      n.scrollLeft = k[0]; n.scrollTop = k[1];
    });
    if (S.anchor) {                       // a zoom: keep the day under the pointer where it was
      const sc = body.querySelector('[data-keep="tl"]');
      if (sc && S.view) sc.scrollLeft = Math.max(0, S.anchor.col * S.view.axis.dw + LABEL_W - S.anchor.x);
      S.anchor = null;
    }
  }
  // how far the wizard can be clicked forward from the step strip
  function maxStep() {
    if (!S.model) return 0;
    if (!S.groupId) return 1;
    return S.step >= 2 ? 3 : 2;
  }

  /* ---------------- 1 · File ---------------- */
  function stepFile() {
    const pick = () => {
      const inp = el('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', style: { display: 'none' } });
      inp.addEventListener('change', () => { const f = inp.files && inp.files[0]; inp.remove(); if (f) load(f); });
      document.body.appendChild(inp);
      inp.click();
    };
    const drop = el('.smi-drop', {
      onclick: pick,
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) load(f); }
    }, [
      App.icon('upload', { size: 22 }),
      el('.smi-drop-title', null, S.fileName ? S.fileName : 'Drop an .xlsx schedule here, or click to choose one'),
      el('.smi-drop-hint', null, S.busy || 'Coloured cells are read as bars, so keep the file as .xlsx — a CSV loses the colours.')
    ]);
    body.appendChild(drop);
    if (S.error) body.appendChild(el('.smi-error', null, S.error));

    if (S.sheets.length) {
      body.appendChild(el('.modal-section-title', null, 'Which sheet holds the schedule?'));
      const list = el('.smi-sheets');
      const visible = S.sheets.filter(s => !s.hidden), hidden = S.sheets.filter(s => s.hidden);
      const row = (s) => el('button.smi-sheet' + (s.name === S.sheetName ? '.on' : ''), {
        type: 'button', onclick: () => chooseSheet(s.name)
      }, [
        el('span.smi-sheet-name', null, s.name),
        s.hidden ? el('span.smi-tag', null, 'hidden') : null,
        el('span.smi-sheet-what', null, s.summary || 'Not read yet')
      ]);
      visible.forEach(s => list.appendChild(row(s)));
      if (hidden.length) {
        const det = el('details.smi-more', null, [el('summary', null, hidden.length + ' hidden sheet' + (hidden.length === 1 ? '' : 's'))]);
        hidden.forEach(s => det.appendChild(row(s)));
        list.appendChild(det);
      }
      body.appendChild(list);
    }
    foot.appendChild(el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Cancel'));
    foot.appendChild(el('button.btn-primary', { disabled: !S.model || null, onclick: () => go(1) }, 'Next'));
  }

  async function load(file) {
    if (!/\.xlsx$/i.test(file.name)) {
      S.error = /\.csv$/i.test(file.name)
        ? 'That’s a CSV — it has no cell colours, so bars can’t be read from it. Export the sheet as .xlsx instead.'
        : 'Choose an .xlsx file.';
      draw(); return;
    }
    if (typeof DecompressionStream === 'undefined') { S.error = 'This browser can’t open .xlsx files — try a current Chrome, Edge, Safari or Firefox.'; draw(); return; }
    Object.assign(S, fresh(), { fileName: file.name, busy: 'Reading ' + file.name + '…' });
    draw();
    try {
      const buf = await file.arrayBuffer();
      S.book = await App.xlsxReader.open(buf);
      S.sheets = S.book.sheets.map(s => ({ name: s.name, hidden: s.hidden, summary: '' }));
      S.busy = '';
      draw();
      // label each visible sheet with what it looks like, best first
      for (const s of S.sheets) {
        if (!S || s.hidden) continue;
        try {
          const m = E().analyse(await S.book.sheet(s.name));
          s.model = m;
          const eps = m.rows.filter(x => x.role === 'episode').length;
          s.summary = m.layout === 'grid' ? 'Calendar grid · ' + eps + ' episode row' + (eps === 1 ? '' : 's')
            : m.layout === 'table' ? 'Table of dates · ' + eps + ' episode' + (eps === 1 ? '' : 's')
            : 'Not a schedule';
          s.score = m.layout === 'unknown' ? 0 : eps + (m.layout === 'grid' ? 1000 : 0);
        } catch (e) { s.summary = 'Couldn’t read'; s.score = 0; }
        if (S && S.step === 0) draw();
      }
      if (!S) return;
      const best = S.sheets.filter(s => !s.hidden).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      if (best && best.score && !S.sheetName) chooseSheet(best.name);
    } catch (e) {
      S.busy = ''; S.error = e.message || 'Couldn’t read that file';
      draw();
    }
  }

  async function chooseSheet(name) {
    // the sheet already in hand: keep everything done to it
    if (name === S.sheetName && S.model && S.groupId) { if (S.error) { S.error = ''; draw(); } return; }
    const s = S.sheets.find(x => x.name === name);
    S.sheetName = name; S.error = '';
    if (!s.model && !S.book) {
      // a resumed draft kept only the sheet it was working on
      S.error = 'To read another sheet, drop ' + (S.fileName || 'the workbook') + ' in again.'; draw(); return;
    }
    try {
      S.model = s.model || E().analyse(await S.book.sheet(name));
      s.model = S.model;
    } catch (e) { S.model = null; S.error = e.message; draw(); return; }
    if (!S.model.groups.length) { S.error = 'No episodes found on “' + name + '”. Is it a schedule?'; S.model = null; draw(); return; }
    // the biggest group that isn't entirely hidden
    const g = S.model.groups.filter(x => !x.hiddenAll).sort((a, b) => b.rows.length - a.rows.length)[0] || S.model.groups[0];
    chooseGroup(g.id);
    draw();
  }

  function chooseGroup(id) {
    const g = S.model.groups.find(x => x.id === id);
    S.groupId = id;
    S.show.name = g.name;
    S.show.prefix = g.prefix;
    const rows = S.model.rows.filter(x => x.role === 'episode' && x.group === id);
    S.episodes = rows.map((x, i) => {
      const p = E().parseEpisodeLabel(x.label);
      return { r: x.r, code: p.code || (g.prefix + '-' + (i + 1)), title: p.title, include: true, hidden: x.hidden,
        bars: x.bars.length, label: x.label };
    });
    const c = E().collectTasks(S.model, id, Object.keys(App.DEPARTMENTS));
    S.tasks = c.tasks;
    S.instances = c.instances;
    S.deps = {}; S.depsSeeded = false; S.order = null; S.editor = null;
    S.sel = { task: null, inst: null };
  }

  /* ---------------- 2 · Episodes ---------------- */
  function stepEpisodes() {
    const m = S.model;
    if (m.groups.length > 1) {
      body.appendChild(el('.modal-section-title', null, 'This sheet holds ' + m.groups.length + ' groups — which one is the show?'));
      body.appendChild(el('.smi-hint', null, 'One show per import. Come back for the others once this one is in.'));
      const gl = el('.smi-groups');
      m.groups.forEach(g => gl.appendChild(el('button.smi-group' + (g.id === S.groupId ? '.on' : ''), {
        type: 'button', onclick: () => { if (g.id !== S.groupId) { chooseGroup(g.id); draw(); } }
      }, [
        el('span.smi-group-name', null, g.name),
        el('span.smi-group-n', null, g.rows.length + ' episode' + (g.rows.length === 1 ? '' : 's')),
        g.hiddenAll ? el('span.smi-tag', null, 'hidden in sheet') : null
      ])));
      body.appendChild(gl);
    }

    body.appendChild(el('.modal-section-title', null, 'The show'));
    const nameIn = el('input.fld', { type: 'text', value: S.show.name, oninput: (e) => { S.show.name = e.target.value; } });
    const codeIn = el('input.fld', { type: 'text', value: S.show.prefix, maxlength: '8', style: { textTransform: 'uppercase' },
      oninput: (e) => { S.show.prefix = e.target.value.toUpperCase(); } });
    const typeSel = el('select.fld', { onchange: (e) => { S.show.type = e.target.value; } });
    [['animation', 'Animation'], ['live_action', 'Live action']].forEach(([v, l]) => {
      const o = el('option', { value: v }, l); if (v === S.show.type) o.selected = true; typeSel.appendChild(o);
    });
    body.appendChild(el('.smi-showrow', null, [
      el('.field', null, [el('label.fld-label', null, 'Show name'), nameIn]),
      el('.field', null, [el('label.fld-label', null, 'Code'), codeIn]),
      el('.field', null, [el('label.fld-label', null, 'Type'), typeSel])
    ]));

    const on = S.episodes.filter(e => e.include).length;
    body.appendChild(el('.modal-section-title', null, [
      'Episodes ', el('span.smi-count', null, on + ' of ' + S.episodes.length)
    ]));
    const anyHidden = S.episodes.some(e => e.hidden);
    if (anyHidden) body.appendChild(el('.smi-hint', null, 'Rows marked “hidden” are hidden in the spreadsheet — often finished or parked work. They’re included unless you untick them.'));
    const tbl = el('.smi-table.smi-eps');
    tbl.appendChild(el('.smi-tr.smi-th', null, [el('span'), el('span', null, 'Code'), el('span', null, 'Title'), el('span', null, 'In the sheet')]));
    S.episodes.forEach(ep => {
      tbl.appendChild(el('.smi-tr' + (ep.include ? '' : '.off'), null, [
        el('input', { type: 'checkbox', checked: ep.include || null, onchange: (e) => { ep.include = e.target.checked; draw(); } }),
        el('input.fld.smi-in', { type: 'text', value: ep.code, oninput: (e) => { ep.code = e.target.value; } }),
        el('input.fld.smi-in', { type: 'text', value: ep.title, oninput: (e) => { ep.title = e.target.value; } }),
        el('span.smi-src', { title: ep.label }, [ep.label, ep.hidden ? el('span.smi-tag', null, 'hidden') : null])
      ]));
    });
    body.appendChild(tbl);

    foot.appendChild(el('button.btn-ghost', { onclick: () => go(0) }, 'Back'));
    foot.appendChild(el('button.btn-primary', {
      disabled: !on || null,
      onclick: () => {
        if (!S.show.name.trim()) { App.toast('Give the show a name', true); return; }
        if (!S.show.prefix.trim()) { App.toast('Give the show a code', true); return; }
        go(2);
      }
    }, 'Next'));
  }


  /* ================= shared: data helpers ================= */
  const taskOf = (id) => S.tasks.find(t => t.id === id) || null;
  const instOf = (id) => S.instances.find(i => i.id === id) || null;
  const included = () => { const m = {}; S.episodes.forEach(e => { if (e.include) m[e.r] = e; }); return m; };
  // the bars that will become something: on an included episode, not removed
  function liveInstances() {
    const inc = included();
    return S.instances.filter(i => inc[i.ep] && !i.removed);
  }
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  const longDate = (iso) => App.parseDate(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const shortRange = (a, b) => a === b ? longDate(a) : App.fmtDate(a) + ' – ' + longDate(b);
  function rgba(hex, a) {
    const h = String(hex || '#888888').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  // what a task becomes, as one value: a department, or a kind of date
  const TYPE_EXTRA = [['live', 'Live date'], ['delivery', 'Delivery date'], ['note', 'Producer note']];
  const typeOf = (t) => t.kind === 'task' ? 'd:' + t.dept : t.kind;
  // a later version reads as its task's ("Animatic · V3"), a Kick Off as its task's KO
  const rootOf = (t) => isVersion(t) ? taskOf(t.versionOf) : null;
  const ownerOf = (t) => t && t.koFor && taskOf(t.koFor) && taskOf(t.koFor).kind === 'task' ? taskOf(t.koFor) : null;
  const vIndex = (t) => versionsOfTask(t.versionOf).indexOf(t) + 2;
  const displayName = (t) => rootOf(t) ? (rootOf(t).name || rootOf(t).label) + ' · V' + vIndex(t)
    : ownerOf(t) ? 'KO · ' + (ownerOf(t).name || ownerOf(t).label) : (t.name || t.label);
  const typeLabel = (t) => rootOf(t) ? 'Version ' + vIndex(t) + ' of ' + rootOf(t).name
    : ownerOf(t) ? 'Kick Off for ' + ownerOf(t).name
    : t.kind === 'task' ? App.dept(t.dept).label : (TYPE_EXTRA.find(x => x[0] === t.kind) || [, 'Removed'])[1];
  const colourOf = (t) => rootOf(t) ? colourOf(rootOf(t)) : t.kind === 'task' ? App.dept(t.dept).color
    : t.kind === 'live' ? '#ff5b6e' : t.kind === 'delivery' ? '#aeb2c0' : t.kind === 'note' ? '#f6be00' : '#777c8c';
  function typeSelect(t, onPick) {
    const sel = el('select.fld.smi-in', { onchange: (e) => onPick(e.target.value) });
    const add = (v, l) => { const o = el('option', { value: v }, l); if (v === typeOf(t)) o.selected = true; sel.appendChild(o); };
    const g1 = el('optgroup', { label: 'Task in department' });
    Object.keys(App.DEPARTMENTS).forEach(k => { const o = el('option', { value: 'd:' + k }, App.dept(k).label); if ('d:' + k === typeOf(t)) o.selected = true; g1.appendChild(o); });
    sel.appendChild(g1);
    const g2 = el('optgroup', { label: 'Not a task' });
    TYPE_EXTRA.forEach(([v, l]) => { const o = el('option', { value: v }, l); if (v === typeOf(t)) o.selected = true; g2.appendChild(o); });
    sel.appendChild(g2);
    if (t.kind === 'ignore') add('ignore', 'Removed');
    return sel;
  }
  function setType(t, v) {
    if (v.indexOf('d:') === 0) { t.kind = 'task'; t.dept = v.slice(2); } else t.kind = v;
  }

  /* ================= shared: the time axis =================
     The main Timeline's: the same mondays-padded window, weekends hidden or
     not per the same preference, the same header tiers and grid lines. */
  function makeAxis(fromIso, toIso, dw) {
    const A = App.ganttAxis;
    const start = A.mondayOf(App.addDays(App.parseDate(fromIso), -2));
    const end = App.addDays(A.mondayOf(App.addDays(App.parseDate(toIso), 9)), 6);
    const startIso = App.isoDate(start);
    const totalCalDays = App.diffDays(App.isoDate(end), startIso) + 1;
    const hide = App.prefs.get('hideWeekends', true);
    const prefix = [0], vis = [];
    for (let i = 0; i < totalCalDays; i++) {
      const d = App.addDays(start, i), dow = d.getDay();
      const shown = !hide || (dow !== 0 && dow !== 6);
      prefix.push(prefix[i] + (shown ? 1 : 0));
      if (shown) vis.push(App.isoDate(d));
    }
    const totalCols = prefix[totalCalDays];
    const colOf = (iso) => prefix[Math.max(0, Math.min(totalCalDays, App.diffDays(iso, startIso)))];
    const ax = { startIso, totalCalDays, totalCols, vis, colOf, dw };
    ax.x = (iso) => colOf(iso) * dw;
    ax.w = (s, d) => Math.max(dw, (colOf(App.shiftIso(d, 1)) - colOf(s)) * dw);
    // a date moved by n visible columns (a drag snaps to working days)
    ax.shift = (iso, n) => vis[Math.max(0, Math.min(vis.length - 1, colOf(iso) + n))];
    ax.width = totalCols * dw;
    ax.ctx = { start, totalCalDays, totalCols, dw, colOf };
    ax.tier = A.tierFor(dw);
    return ax;
  }
  function axisHead(ax, corner) {
    const A = App.ganttAxis;
    const cols = el('.th-cols.smi-th-cols', { style: { width: ax.width + 'px' } }, [
      A.buildSegRow(ax.ctx, ax.tier.primary, 'primary'),
      A.buildSegRow(ax.ctx, ax.tier.secondary, 'secondary')
    ]);
    return el('.time-head', null, el('', { style: { display: 'flex' } }, [
      el('.th-corner.smi-corner', { style: { width: LABEL_W + 'px', minWidth: LABEL_W + 'px' } }, corner), cols]));
  }
  function axisGrid(ax) {
    const A = App.ganttAxis;
    const grid = el('.grid-bg', { style: { left: LABEL_W + 'px', width: ax.width + 'px' } });
    A.gridLines(grid, ax.ctx, ax.tier.secondary, false, false);
    A.gridLines(grid, ax.ctx, ax.tier.primary, true, false);
    const today = App.isoDate(App.today());
    if (today >= ax.startIso && today <= ax.vis[ax.vis.length - 1]) grid.appendChild(el('.today-line', { style: { left: (ax.x(today) + ax.dw / 2) + 'px' } }));
    return grid;
  }

  /* The zoomable frame both timelines sit in: toolbar, header, scroller.
     `span` is [from, to]; build(ax, rows, inner) adds the rows. Zoom is px
     per day. */
  function timeline(span, corner, build, tools) {
    const step = S.step;
    const scroller = el('.smi-tl-scroll', { 'data-keep': 'tl' });
    const panelW = Math.max(400, (body.clientWidth || 1000) - 46);
    const fit = (() => { const a = makeAxis(span[0], span[1], 1); return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (panelW - LABEL_W - 4) / a.totalCols)); })();
    /* zoom: unset opens at a readable scale (the sheet at a few px a day, the
       episodes at about the Timeline's weeks tier); null is Fit */
    const dw = S.zoom[step] === null ? fit : S.zoom[step] == null ? Math.max(fit, step === 2 ? 5 : 9) : S.zoom[step];
    const ax = makeAxis(span[0], span[1], dw);
    const inner = el('.gantt-inner.smi-inner', { style: { width: (LABEL_W + ax.width) + 'px' } });
    inner.appendChild(axisHead(ax, corner));
    const rows = el('.gantt-body.smi-rows');
    rows.appendChild(axisGrid(ax));
    inner.appendChild(rows);
    scroller.appendChild(inner);
    S.view = { axis: ax, scroller, inner, rows };
    build(ax, rows, inner);

    const zoomTo = (nz, clientX) => {
      nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nz));
      if (Math.abs(nz - dw) < 0.001) return;
      const r = scroller.getBoundingClientRect();
      const x = clientX == null ? r.width / 2 : clientX - r.left;
      S.anchor = { col: (scroller.scrollLeft + x - LABEL_W) / dw, x };
      S.zoom[step] = nz;
      draw();
    };
    S.view.zoomBy = (f, clientX) => zoomTo(dw * f, clientX);
    scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;                       // pinch arrives as ctrl+wheel too
      e.preventDefault();
      zoomTo(dw * App.wheelZoomFactor(e), e.clientX);
    }, { passive: false });

    const btn = (label, title, fn, on) => el('button.btn-icon.pv-zoom-btn' + (on ? '.active' : ''), { type: 'button', title, onclick: fn }, label);
    const bar = el('.smi-tl-bar', null, [
      el('.smi-tl-tools', null, tools || []),
      el('.pv-zoom', null, [
        btn('−', 'Zoom out (' + App.shortcutLabel('−') + ', or Ctrl+scroll)', () => zoomTo(dw / ZOOM_STEP), false),
        btn('Fit', 'Fit everything to the panel', () => { S.zoom[step] = null; draw(); }, S.zoom[step] === null),
        btn('＋', 'Zoom in (' + App.shortcutLabel('+') + ', or Ctrl+scroll)', () => zoomTo(dw * ZOOM_STEP), false)
      ])
    ]);
    return el('.smi-tl', null, [bar, el('.gantt.smi-gantt', null, scroller)]);
  }

  // ⌘+ / ⌘− zoom, Delete removes the selected bar — while the wizard is open
  function onKey(e) {
    if (!S || !S.view || (S.step !== 2 && S.step !== 3)) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '');
    if ((App.isMac ? e.metaKey : e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      const zin = k === '=' || k === '+' || e.code === 'NumpadAdd', zout = k === '-' || k === '_' || e.code === 'NumpadSubtract';
      if (zin || zout) { e.preventDefault(); e.stopPropagation(); S.view.zoomBy(zin ? ZOOM_STEP : 1 / ZOOM_STEP); }
      return;
    }
    if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && S.sel.inst) {
      e.preventDefault();
      const i = instOf(S.sel.inst);
      if (i) { i.removed = !i.removed; draw(); }
    }
  }

  /* ---- dragging a bar: the middle moves it, an end stretches it ----
     Snaps to the axis's columns, so a drag lands on working days. The bar
     follows the pointer; the instance only changes on release, and a press
     that never moved is a click. */
  function dragBar(barEl, inst, ax, onClick, oneDay) {
    barEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const r = barEl.getBoundingClientRect();
      const edge = oneDay || r.width < 16 ? 'move' : e.clientX - r.left < 7 ? 'start' : r.right - e.clientX < 7 ? 'end' : 'move';
      const x0 = e.clientX;
      let live = false, ns = inst.start, ne = inst.end;
      const badge = el('.pv-drag-badge');
      const move = (ev) => {
        if (!live && Math.abs(ev.clientX - x0) < 3) return;
        if (!live) { live = true; barEl.classList.add('smi-dragging'); document.body.appendChild(badge); }
        const n = Math.round((ev.clientX - x0) / ax.dw);
        if (edge === 'move') { ns = ax.shift(inst.start, n); ne = oneDay ? ns : ax.shift(inst.end, n); }
        else if (edge === 'start') { ns = ax.shift(inst.start, n); if (ns > inst.end) ns = inst.end; ne = inst.end; }
        else { ne = ax.shift(inst.end, n); if (ne < inst.start) ne = inst.start; ns = inst.start; }
        barEl.style.left = ax.x(ns) + 'px';
        if (!oneDay) barEl.style.width = ax.w(ns, ne) + 'px';
        badge.textContent = shortRange(ns, ne) + (oneDay ? '' : ' · ' + (App.diffDays(ne, ns) + 1) + ' days');
        badge.style.left = (ev.clientX + 14) + 'px'; badge.style.top = (ev.clientY - 30) + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        badge.remove();
        if (!live) { onClick(); return; }
        if (ns !== inst.start || ne !== inst.end) { inst.start = ns; inst.end = ne; inst.edited = true; }
        S.sel = { task: inst.task, inst: inst.id };
        draw();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    barEl.addEventListener('mousemove', (e) => {
      if (oneDay) return;
      const r = barEl.getBoundingClientRect();
      barEl.style.cursor = r.width >= 16 && (e.clientX - r.left < 7 || r.right - e.clientX < 7) ? 'ew-resize' : 'grab';
    });
  }

  /* ---- what's picked, and what's lit ----
     Like Add Show's episode preview: picking (or hovering) a task lights its
     bars, what it waits for and what waits for it, and dims the rest — no
     lines drawn between them. Done with classes, so it never rebuilds. */
  function applySel() {
    const t = S.hover || S.sel.task, i = S.sel.inst;
    const linked = new Set();
    if (t) {
      linked.add(t);
      if (S.step === 3) {
        (S.deps[t] || []).forEach(d => linked.add(d));
        Object.keys(S.deps).forEach(k => { if (S.deps[k].indexOf(t) >= 0) linked.add(k); });
      }
    }
    body.querySelectorAll('[data-task]').forEach(n => {
      const k = n.getAttribute('data-task');
      n.classList.toggle('sel', k === S.sel.task);
      n.classList.toggle('lit', !!t && linked.has(k) && k !== t);
      n.classList.toggle('dim', !!t && !linked.has(k));
      n.classList.toggle('one', !!i && n.getAttribute('data-inst') === i);
    });
  }
  function select(task, inst, openInList) {
    const t = taskOf(task);
    if (t && isVersion(t)) task = t.versionOf;
    S.sel = { task, inst: inst || null };
    if (S.step === 2) drawSelPanel();
    applySel();
    // a bar picked on the timeline opens its task in the list, as in Add Show
    const row = t && ownerOf(t) ? t.koFor : task;           // a KO shows on its task's row
    // opening the row reports back through onEdit — that echo mustn't replace
    // the bar just picked (a KO or a version opens a different row)
    if (openInList && S.editor && S.editor.pipe.some(p => p.key === row)) { S.quiet = true; S.editor.api.edit(row); S.quiet = false; }
  }
  function hoverable(n, taskId) {
    n.addEventListener('mouseenter', () => { if (document.querySelector('.smi-dragging')) return; S.hover = taskId; applySel(); });
    n.addEventListener('mouseleave', () => { if (S.hover === taskId) { S.hover = null; applySel(); } });
  }

  /* ================= the pipeline list — Add Show's own =================
     App.pipelineEditor, the task list Add Show and Admin use: name, department,
     remove (with its offer to reconnect what waited on the removed task),
     drag to reorder, undo and redo. Step 3 adds Live date, Delivery date and
     Producer note to the department picker and hides dependencies; step 4
     shows the dependency chips and days per version.

     The editor works on its own array of tasks; whatever it changes is read
     back into the import (syncFromPipe). It lives for as long as its step is
     on screen, so its undo history and open row survive the redraws. */
  const EXTRA_TYPES = [
    { key: '@live', label: 'Live date', color: '#ff5b6e' },
    { key: '@delivery', label: 'Delivery date', color: '#aeb2c0' },
    { key: '@note', label: 'Producer note', color: '#f6be00' }
  ];
  const inScope = (t, step) => (step === 3 ? t.kind === 'task' : t.kind !== 'ignore') && !isVersion(t);
  // a later version (2nd, V3…) lives inside its task — it's never a row of its own
  const isVersion = (t) => !!(t && t.versionOf && taskOf(t.versionOf) && taskOf(t.versionOf).kind === 'task');
  const versionsOfTask = (id) => E().versionsOf(S.tasks, id);
  const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  function currentOrder() {
    if (S.order) return S.order.concat(S.tasks.filter(t => S.order.indexOf(t.id) < 0).map(t => t.id));
    E().measure(S.tasks, liveInstances());
    return S.tasks.slice().sort((a, b) => a.offset - b.offset).map(t => t.id);
  }
  /* A task as Add Show's list holds it: its versions as revisions (days
     per version, review before each), and a Kick Off as a KO row of its
     own the list keeps directly above its task. */
  function toPipe(t) {
    const p = { key: t.id, name: t.name, dept: t.kind === 'task' ? t.dept : '@' + t.kind, days: t.days,
      minDays: Math.max(1, Math.ceil(t.days / 2)), deps: (S.deps[t.id] || []).filter(d => { const x = taskOf(d); return x && x.kind === 'task'; }), vc: false };
    const v = versionsOfTask(t.id);
    if (v.length) {
      const live = liveInstances();
      p.maxRev = v.length;
      p.revDays = v.map(x => x.days);
      const gaps = v.map((x, r) => median(live.filter(i => i.task === x.id).map(me => {
        const prev = live.find(i => i.ep === me.ep && i.task === (r ? v[r - 1].id : t.id));
        return prev ? Math.max(0, E().daysBetween(prev.end, me.start) - 1) : null;
      }).filter(n => n != null)));
      if (gaps.some(n => n > 0)) p.revGaps = gaps;
    }
    if (t.koFor && taskOf(t.koFor) && taskOf(t.koFor).kind === 'task') { p.ko = true; p.koFor = t.koFor; p.days = 1; p.minDays = 1; }
    return p;
  }
  const versionCount = (id) => versionsOfTask(id).length;

  function editorPanel(step) {
    if (!S.editor || S.editor.step !== step) {
      const pipe = currentOrder().map(taskOf).filter(t => t && inScope(t, step)).map(toPipe);
      const api = App.pipelineEditor(pipe, {
        onChange: () => { if (syncFromPipe(pipe, step)) S.editor = null; draw(); },
        onDraft: () => {},
        onEdit: (key) => { if (key && key !== S.sel.task && !S.quiet) { S.sel = { task: key, inst: null }; if (S.step === 2) drawSelPanel(); applySel(); } },
        tooltips: false, vcToggle: false,
        deps: step === 3, versions: step === 3,
        extraTypes: step === 3 ? [] : EXTRA_TYPES
      });
      S.editor = { step, api, pipe };
    }
    const api = S.editor.api;
    const addBtn = el('button.btn-icon', { type: 'button', title: 'Add a task — it’s placed after the one before it in every episode', onclick: () => api.addTask() }, '＋');
    const wrap = el('.smi-plist', null, [
      el('.pipe-toggle.smi-pipe-head', null, [el('span.chev.open', null, '▶'), el('span.pipe-toggle-lbl', null, step === 3 ? 'Pipeline & dependencies' : 'Pipeline'),
        api.count, api.undoBtn, api.redoBtn, addBtn]),
      el('.pipe-body', null, api.list)
    ]);
    const removed = S.tasks.filter(t => !isVersion(t) && (t.kind === 'ignore' || (step === 3 && t.kind !== 'task')));
    if (removed.length) {
      const det = el('details.smi-more', S.showRemoved ? { open: '' } : null, [
        el('summary', { onclick: () => { S.showRemoved = !S.showRemoved; } }, step === 3
          ? removed.length + ' not in the pipeline — removed, review time, or used as a date or note'
          : removed.length + ' removed — review time between versions, one-off notes, plain numbers, unlabelled colour, and anything you removed')
      ]);
      const list = el('.smi-removed');
      removed.forEach(t => list.appendChild(el('.smi-rrow', { 'data-task': t.id }, [
        el('span.smi-sw', { style: { background: t.fill || colourOf(t) }, title: t.fill ? 'Colour in the sheet: ' + t.fill : '' }),
        el('span.smi-src', { title: (t.trackLabel ? t.trackLabel + ' · ' : '') + '“' + t.label + '”' + (t.nth > 1 ? ', ' + ordinal(t.nth) + ' in its row' : '') },
          [el('b', null, t.name || t.label), el('span.smi-track', null, [
            t.reviewOf && taskOf(t.reviewOf) ? 'Review time between ' + taskOf(t.reviewOf).name + '’s versions' : typeLabel(t),
            t.trackLabel ? ' · ' + t.trackLabel : '', t.rare ? ' · only on ' + t.firstEp : ''].join(''))]),
        el('span.smi-meta', null, countOf(t) + ' of ' + S.episodes.filter(e => e.include).length),
        t.kind === 'ignore' ? el('button.btn-ghost.smi-mini', { type: 'button', onclick: () => {
          t.kind = t.wasKind && t.wasKind !== 'ignore' ? t.wasKind : 'task'; delete t.reviewOf; S.editor = null; draw();
        } }, 'Restore') : el('span')
      ])));
      det.appendChild(list);
      wrap.appendChild(det);
    }
    return wrap;
  }

  /* The editor's array → the import: names, types, order, links, lengths,
     Kick Offs and versions. Returns true when the list needs rebuilding
     (a version came off or went on, which changes what rows there are). */
  function syncFromPipe(pipe, step) {
    const keys = pipe.map(p => p.key);
    let rebuild = false;
    pipe.forEach((p, idx) => {
      let t = taskOf(p.key);
      if (!t) t = newTask(p, pipe, idx);
      t.name = p.name;
      if (String(p.dept).charAt(0) === '@') t.kind = p.dept.slice(1); else { t.kind = 'task'; t.dept = p.dept; }
      if (p.ko) { t.koFor = p.koFor; t.kind = 'task'; } else delete t.koFor;
      if (step === 3) {
        const d = p.deps.filter(k => keys.indexOf(k) >= 0);
        if (d.length) S.deps[p.key] = d; else delete S.deps[p.key];
        // a new first-pass length is applied to the task's bar in every episode
        if (!p.ko && p.days !== t.days) resizeAll(t.id, p.days);
        // versions: one fewer takes the last off as a task of its own again;
        // one more adds a version after the last; new days resize them
        const v = versionsOfTask(t.id), want = p.maxRev || 0;
        if (want < v.length) { v.slice(want).forEach(x => { delete x.versionOf; }); rebuild = true; }
        if (want > v.length) { for (let r = v.length; r < want; r++) addVersion(t, r, (p.revDays || [])[r] || 1); rebuild = true; }
        versionsOfTask(t.id).forEach((x, r) => { const n = (p.revDays || [])[r]; if (n && n !== x.days) resizeAll(x.id, n); });
      }
    });
    // anything the list no longer has was removed (a KO's ✕ included)
    S.tasks.forEach(t => {
      if (keys.indexOf(t.id) < 0 && inScope(t, step)) { t.wasKind = t.kind; t.kind = 'ignore'; delete t.koFor; }
    });
    Object.keys(S.deps).forEach(k => {
      if (!taskOf(k) || taskOf(k).kind !== 'task') { delete S.deps[k]; return; }
      S.deps[k] = S.deps[k].filter(d => taskOf(d) && taskOf(d).kind === 'task');
      if (!S.deps[k].length) delete S.deps[k];
    });
    S.order = keys.concat(currentOrder().filter(id => keys.indexOf(id) < 0));
    E().measure(S.tasks, liveInstances());
    return rebuild;
  }
  // every bar of a task made `days` long, from where each starts (calendar
  // days — the same days the list counts)
  function resizeAll(id, days) {
    S.instances.forEach(i => { if (i.task === id && !i.removed) { i.end = App.shiftIso(i.start, Math.max(1, days) - 1); i.edited = true; } });
  }
  // a version added in the list: a bar after the task's last version in every episode
  function addVersion(root, r, days) {
    const prevId = r ? versionsOfTask(root.id)[r - 1].id : root.id;
    const t = { id: 'v' + App.uid(), track: root.track, trackLabel: root.trackLabel, label: 'V' + (r + 2), nth: 1, fill: null, offGrid: false,
      firstEp: '', name: root.name + ' V' + (r + 2), dept: root.dept, kind: 'task', count: 0, days, offset: (root.offset || 0) + 1 + r, added: true, versionOf: root.id };
    S.tasks.push(t);
    S.instances.filter(i => i.task === prevId && !i.removed).forEach(prev => {
      const start = App.shiftIso(prev.end, 1);
      S.instances.push({ id: 'n' + App.uid(), task: t.id, ep: prev.ep, row: prev.row, start, end: App.shiftIso(start, days - 1), fill: null, offGrid: false, edited: true });
    });
  }

  /* A task added in the list has no bars yet: give it one in every episode,
     straight after the task above it in the list (or at the episode's start),
     as long as the editor says — then it can be dragged like any other.
     A Kick Off added from the dependency menu lands on the day before its task. */
  function newTask(p, pipe, idx) {
    const t = { id: p.key, track: '', trackLabel: '', label: p.ko ? 'KO' : p.name, nth: 1, fill: null, offGrid: false, firstEp: '',
      name: p.name, dept: p.dept, kind: 'task', count: 0, days: p.days, offset: 0, added: true };
    if (p.ko) t.koFor = p.koFor;
    S.tasks.push(t);
    S.episodes.filter(e => e.include).forEach(e => {
      const mine = S.instances.filter(i => i.ep === e.r && !i.removed);
      if (!mine.length) return;
      if (p.ko) {
        const own = mine.find(i => i.task === p.koFor); if (!own) return;
        let d = App.shiftIso(own.start, -1);
        while ([0, 6].indexOf(App.parseDate(d).getDay()) >= 0) d = App.shiftIso(d, -1);
        S.instances.push({ id: 'n' + App.uid(), task: t.id, ep: e.r, row: own.row, start: d, end: d, fill: null, offGrid: false, edited: true });
        return;
      }
      let start = mine.reduce((m, i) => i.start < m ? i.start : m, '9999');
      for (let j = idx - 1; j >= 0; j--) {
        const prev = mine.find(i => i.task === pipe[j].key);
        if (prev) { start = App.shiftIso(prev.end, 1); break; }
      }
      S.instances.push({ id: 'n' + App.uid(), task: t.id, ep: e.r, row: e.r, start, end: App.shiftIso(start, Math.max(1, p.days) - 1), fill: null, offGrid: false, edited: true });
    });
    return t;
  }

  /* ================= 3 · Tasks =================
     The sheet as it is, faintly, with the reading on top. Top: rows of the
     sheet (each episode and its sub-tracks), cells in their own colours,
     the bars read from them outlined in their task's department colour.
     Bottom: the pipeline those bars make, in Add Show's task list. */
  let selPanel = null;
  function stepTasks() {
    const inc = included();
    const rowsBy = {};
    S.model.rows.forEach(x => { rowsBy[x.r] = x; });
    const sheetRows = [];
    S.episodes.filter(e => e.include).forEach(e => {
      sheetRows.push({ row: rowsBy[e.r], ep: e, track: false });
      S.model.rows.filter(x => x.role === 'track' && x.parent === e.r).forEach(x => sheetRows.push({ row: x, ep: e, track: true }));
    });
    const insts = S.instances.filter(i => inc[i.ep]);
    let from = '9999', to = '0000';
    insts.forEach(i => { if (i.start < from) from = i.start; if (i.end > to) to = i.end; });
    if (from === '9999') { body.appendChild(el('.smi-error', null, 'No bars to show.')); return; }

    body.appendChild(el('.smi-hint', null, [
      'The sheet underneath, the reading on top. ', el('b', null, 'Drag'), ' a bar to move it, drag an ', el('b', null, 'end'),
      ' to stretch it, click to pick it. ', el('b', null, 'Delete'), ' removes just that bar. Name each task and pick its department below.'
    ]));

    const tools = [
      el('label.smi-check', null, [
        el('input', { type: 'checkbox', checked: S.showCells || null, onchange: (e) => { S.showCells = e.target.checked; draw(); } }),
        'Sheet cells'
      ]),
      S.model.backgroundFills && S.model.backgroundFills.length ? el('span.smi-bg', null, ['Looked through: ',
        ...S.model.backgroundFills.map(b => el('span.smi-sw', { style: { background: b.fill }, title: b.fill + ' fills ' + b.columns + ' whole columns — a holiday or closure, not work' }))]) : null
    ];

    body.appendChild(timeline([from, to], 'SHEET ROW', (ax, rows) => {
      sheetRows.forEach(sr => {
        const x = sr.row;
        const row = el('.g-row.smi-srow' + (sr.track ? '.sub' : ''));
        row.appendChild(el('.g-label', { title: x.label }, sr.track
          ? el('.l-title', { style: { fontWeight: '600', fontSize: '10.5px' } }, x.trackLabel || x.label)
          : [el('.l-title', null, el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, sr.ep.title)),
             el('.l-sub', null, el('span.code', null, sr.ep.code))]));
        const track = el('.g-track');
        /* The spreadsheet as it is: its own fills at full strength, its own
           text in its own ink, and a line between days the way Excel draws
           its columns once they're wide enough to see. */
        const gridLines = ax.dw >= 6 ? 'repeating-linear-gradient(90deg, transparent 0 ' + (ax.dw - 1) + 'px, rgba(0,0,0,.14) ' + (ax.dw - 1) + 'px ' + ax.dw + 'px)' : 'none';
        if (S.showCells) (x.raw || []).forEach(c => {
          if (c.end < ax.startIso) return;
          const w = ax.w(c.start, c.end);
          track.appendChild(el('.smi-cell' + (c.bg ? '.bg' : '') + (c.fill ? '' : '.bare'), {
            style: { left: ax.x(c.start) + 'px', width: w + 'px', background: c.fill || 'transparent', backgroundImage: c.fill ? gridLines : 'none',
              color: c.fill && App.pickInk ? App.pickInk(c.fill) : 'var(--text-2)' },
            title: (c.text ? '“' + c.text + '” · ' : '') + shortRange(c.start, c.end)
          }, c.text ? el('span', null, c.text) : null));
        });
        /* The reading, over the top: a translucent outline over the cells it
           covers, so the sheet shows through, and the task's name on a tab
           above them, where nothing of the sheet's sits under it. */
        insts.filter(i => i.row === x.r).forEach(i => {
          const t = taskOf(i.task); if (!t) return;
          const col = colourOf(t);
          const oneDay = t.kind === 'live' || t.kind === 'delivery';
          const cls = '.smi-ib' + (t.kind === 'ignore' ? '.ign' : '') + (i.removed ? '.gone' : '') + (oneDay ? '.ms' : '') + (t.kind === 'note' ? '.note' : '');
          const w = ax.w(i.start, i.end);
          const name = oneDay ? (t.kind === 'live' ? 'Live' : 'Delivery') : displayName(t);
          // a version lights and opens with its task, so the whole run reads as one
          const group = rootOf(t) ? rootOf(t).id : t.id;
          const b = el(cls + (rootOf(t) ? '.ver' : '') + (ownerOf(t) ? '.ko' : ''), {
            'data-task': group, 'data-inst': i.id,
            title: displayName(t) + ' — ' + typeLabel(t) + '\n' + shortRange(i.start, i.end) + (i.afterKo ? '\nStarts after its Kick Off' : '') +
              (i.removed ? '\nRemoved — press Delete to bring it back' : '') + (i.edited ? '\nMoved from the sheet' : '') +
              (i.guessed ? '\nUnlabelled in the sheet — named from its colour' : ''),
            style: oneDay ? { left: (ax.x(i.start) + ax.dw / 2 - 7) + 'px' } : { left: ax.x(i.start) + 'px', width: w + 'px' }
          }, [
            oneDay ? el('span.smi-dia') : null,
            oneDay || w >= 16 ? el('span.smi-ib-name', null, name) : null
          ]);
          b.style.setProperty('--c', col);
          b.style.setProperty('--cf', rgba(col, t.kind === 'ignore' || i.removed ? 0 : 0.16));
          b.style.setProperty('--ink', App.pickInk ? App.pickInk(col) : '#11131a');
          dragBar(b, i, ax, () => select(t.id, i.id, true), oneDay);
          hoverable(b, group);
          track.appendChild(b);
        });
        row.appendChild(track);
        rows.appendChild(row);
      });
    }, tools));

    selPanel = el('.smi-selpanel');
    body.appendChild(selPanel);
    drawSelPanel();
    body.appendChild(editorPanel(2));
    applySel();

    // the list's own count: versions ride inside their task, Kick Offs are rows of their own
    const n = S.tasks.filter(t => t.kind === 'task' && !isVersion(t) && countOf(t) > 0).length;
    foot.appendChild(el('span.smi-foot-note', null, n + ' task' + (n === 1 ? '' : 's') + ' in the pipeline'));
    foot.appendChild(el('button.btn-ghost', { onclick: () => go(1) }, 'Back'));
    foot.appendChild(el('button.btn-primary', { disabled: !n || null, onclick: () => go(3) }, 'Next: dependencies'));
  }
  const countOf = (t) => { const inc = included(); return S.instances.filter(i => i.task === t.id && inc[i.ep] && !i.removed).length; };

  // what's picked, in a line: the bar's episode and dates, and what it can do
  function drawSelPanel() {
    if (!selPanel) return;
    selPanel.innerHTML = '';
    const i = S.sel.inst && instOf(S.sel.inst);
    const t = i ? taskOf(i.task) : S.sel.task && taskOf(S.sel.task);
    if (!t) { selPanel.appendChild(el('span.smi-hint', null, 'Nothing picked — click a bar, or a task in the list.')); return; }
    const ep = i && S.episodes.find(e => e.r === i.ep);
    selPanel.appendChild(el('span.smi-sw', { style: { background: colourOf(t) } }));
    selPanel.appendChild(el('b', null, displayName(t)));
    selPanel.appendChild(el('span.smi-selmeta', null, typeLabel(t) + ' · ' + countOf(t) + ' bar' + (countOf(t) === 1 ? '' : 's') +
      ' · “' + t.label + '”' + (t.trackLabel ? ' on ' + t.trackLabel : '')));
    if (!i) return;
    selPanel.appendChild(el('span.smi-selmeta', null, '· ' + (ep ? ep.code : '') + ' · ' + shortRange(i.start, i.end)));
    const btn = (label, title, fn) => el('button.btn-ghost.smi-mini', { type: 'button', title, onclick: () => { fn(); S.editor = null; draw(); } }, label);
    selPanel.appendChild(el('button.btn-ghost.smi-mini', { type: 'button', onclick: () => { i.removed = !i.removed; draw(); } },
      i.removed ? 'Bring this bar back' : 'Remove this bar'));
    /* What the bar is, as Add Show knows it — a version of the task before
       it, a Kick Off for the work after it, or a task of its own. Each is
       decided for the task in every episode, not just this bar. */
    const row = S.instances.filter(x => x.ep === i.ep && x.row === i.row && !x.removed && x !== i && taskOf(x.task) && taskOf(x.task).kind === 'task')
      .sort((a, b) => a.start < b.start ? -1 : 1);
    if (rootOf(t)) {
      selPanel.appendChild(btn('Make it a task of its own', 'Stop treating “' + t.label + '” as a version of ' + rootOf(t).name, () => { delete t.versionOf; }));
    } else if (ownerOf(t)) {
      selPanel.appendChild(btn('Not a Kick Off', 'Make “' + t.label + '” a task of its own', () => { delete t.koFor; }));
    } else if (t.kind === 'task') {
      const prev = row.filter(x => x.end < i.start).pop();
      const prevRoot = prev && (rootOf(taskOf(prev.task)) || taskOf(prev.task));
      if (prevRoot && prevRoot.id !== t.id && !ownerOf(prevRoot) && !versionsOfTask(t.id).length) {
        selPanel.appendChild(btn('Make it a version of ' + prevRoot.name, 'Its bars become ' + prevRoot.name + '’s next version (a revision) in every episode', () => {
          t.versionOf = prevRoot.id;
          if (S.deps[t.id]) delete S.deps[t.id];
        }));
      }
      const next = row.find(x => x.start >= i.start && x.task !== t.id && !isVersion(taskOf(x.task))) || row.find(x => x.start <= i.start && x.end >= i.end && !isVersion(taskOf(x.task)));
      const nt = next && taskOf(next.task);
      if (nt && !ownerOf(nt) && !S.tasks.some(x => x.koFor === nt.id) && !versionsOfTask(t.id).length && countOf(t) && E().daysBetween(i.start, i.end) <= 2) {
        selPanel.appendChild(btn('Make it the Kick Off for ' + nt.name, nt.name + ' will wait on it, as with a Kick Off in Add Show', () => { t.koFor = nt.id; t.dept = nt.dept; }));
      }
    }
  }

  /* ================= 4 · Dependencies =================
     The episodes as the Timeline draws them: a row each, opening into its
     tasks by department. Links are made in the list underneath — Add Show's
     own dependency chips — and shown the way Add Show's preview shows them:
     pick or hover a task and what it waits for and what waits for it light
     up. Bars still move and stretch for final adjustments. A link is between
     tasks, so it holds in every episode. */
  function stepDeps() {
    const insts = liveInstances();
    const use = S.tasks.filter(t => t.kind !== 'ignore');
    const useBy = {}; use.forEach(t => { useBy[t.id] = t; });
    let from = '9999', to = '0000';
    insts.forEach(i => { if (!useBy[i.task]) return; if (i.start < from) from = i.start; if (i.end > to) to = i.end; });
    if (from === '9999') { body.appendChild(el('.smi-error', null, 'No tasks left to link.')); return; }
    const eps = S.episodes.filter(e => e.include);
    if (!Object.keys(S.expanded).length && eps[0]) S.expanded[eps[0].r] = true;

    const nLinks = Object.keys(S.deps).reduce((n, k) => n + (useBy[k] && useBy[k].kind === 'task' ? S.deps[k].filter(d => useBy[d] && useBy[d].kind === 'task').length : 0), 0);
    const tools = [
      el('button.btn-ghost.smi-mini', { type: 'button', onclick: () => { eps.forEach(e => { S.expanded[e.r] = true; }); draw(); } }, 'Expand all'),
      el('button.btn-ghost.smi-mini', { type: 'button', onclick: () => { S.expanded = {}; eps[0] && (S.expanded[eps[0].r] = false); draw(); } }, 'Collapse all'),
      el('button.btn-ghost.smi-mini', { type: 'button', title: 'Link each task to whatever finishes just before it in most episodes', onclick: () => {
        S.deps = E().suggestDeps(S.tasks, liveInstances()); S.editor = null; draw(); App.toast('Links suggested from the dates — check them');
      } }, 'Suggest from dates'),
      el('button.btn-ghost.smi-mini', { type: 'button', onclick: () => { S.deps = {}; S.editor = null; draw(); } }, 'Clear links'),
      el('span.smi-count', null, nLinks + ' link' + (nLinks === 1 ? '' : 's'))
    ];

    body.appendChild(el('.smi-hint', null, [
      'Pick a bar to open its task below, then set what it waits for with ', el('b', null, '＋'), '. ',
      'Hovering a task lights what it waits for and what waits for it. Bars still move and stretch.'
    ]));

    body.appendChild(timeline([from, to], 'EPISODE / SUBITEM', (ax, rows) => {
      eps.forEach(e => {
        const mine = insts.filter(i => i.ep === e.r && useBy[i.task]);
        const allWork = mine.filter(i => useBy[i.task].kind === 'task');
        // a task's later versions ride on its own line, after V1
        const work = allWork.filter(i => !isVersion(useBy[i.task]));
        const versOf = (i) => allWork.filter(x => isVersion(useBy[x.task]) && useBy[x.task].versionOf === i.task).sort((a, b) => a.start < b.start ? -1 : 1);
        const lastEnd = (i) => versOf(i).reduce((m, x) => x.end > m ? x.end : m, i.end);
        let s0 = '9999', e0 = '0000';
        allWork.forEach(i => { if (i.start < s0) s0 = i.start; if (i.end > e0) e0 = i.end; });
        const open = !!S.expanded[e.r];
        const top = el('.g-row');
        top.appendChild(el('.g-label', { onclick: () => { S.expanded[e.r] = !open; draw(); } }, [
          el('.l-title', null, [el('span.chev' + (open ? '.open' : ''), null, '▶'), el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, e.title)]),
          el('.l-sub', null, [el('span.code', null, e.code), s0 < '9999' ? el('span', null, '· ' + App.fmtRange(s0, e0)) : null])
        ]));
        const tt = el('.g-track');
        if (s0 < '9999') tt.appendChild(el('.bar.smi-epbar', { style: { left: ax.x(s0) + 'px', width: ax.w(s0, e0) + 'px' } },
          ax.w(s0, e0) > 60 ? el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, e.code) : null));
        mine.filter(i => useBy[i.task].kind !== 'task').forEach(i => {
          const t = useBy[i.task];
          const m = el('.smi-ms' + (t.kind === 'live' ? '.live' : t.kind === 'note' ? '.note' : ''), {
            'data-task': t.id, 'data-inst': i.id, title: (t.name || t.label) + ' · ' + shortRange(i.start, i.end) + '\nDrag to move it',
            style: { left: (ax.x(i.start) + ax.dw / 2) + 'px' }
          });
          dragBar(m, i, ax, () => select(t.id, i.id, false), true);
          tt.appendChild(m);
        });
        top.appendChild(tt);
        rows.appendChild(top);
        if (!open) return;
        Object.keys(App.DEPARTMENTS).concat([...new Set(work.map(i => useBy[i.task].dept))].filter(k => !App.DEPARTMENTS[k])).forEach(dk => {
          const items = work.filter(i => useBy[i.task].dept === dk).sort((a, b) => a.start < b.start ? -1 : 1);
          if (!items.length) return;
          const lines = [];
          items.forEach(i => {
            const l = lines.find(x => i.start > x.last);
            if (l) { l.items.push(i); l.last = lastEnd(i); } else lines.push({ last: lastEnd(i), items: [i] });
          });
          const dep = App.dept(dk);
          lines.forEach((l, li) => {
            const r = el('.g-row.sub', { style: { background: rgba(dep.color, 0.05) } });
            r.appendChild(el('.g-label', { title: dep.label }, el('.l-title', { style: { fontWeight: '600', fontSize: '10.5px' } },
              li ? [] : [el('span.smi-dot', { style: { background: dep.color } }), el('span', null, dep.label)])));
            const tr = el('.g-track');
            l.items.forEach(i => {
              const t = useBy[i.task];
              const w = ax.w(i.start, i.end);
              const waits = (S.deps[t.id] || []).map(d => (taskOf(d) || {}).name).filter(Boolean);
              const vs = versOf(i);
              const label = ownerOf(t) ? 'KO' : (t.name || t.label) + (vs.length ? ' · V1' : '');
              const b = el('.bar.smi-tbar' + (ownerOf(t) ? '.ko' : ''), {
                'data-task': t.id, 'data-inst': i.id,
                title: displayName(t) + ' — ' + dep.label + '\n' + shortRange(i.start, i.end) + (vs.length ? '\nV1 of ' + (vs.length + 1) : '') +
                  (waits.length ? '\nWaits for ' + waits.join(', ') : '\nWaits for nothing'),
                style: { left: ax.x(i.start) + 'px', width: w + 'px', background: dep.color, color: App.pickInk ? App.pickInk(dep.color) : '#11131a' }
              }, w > 22 ? el('span.smi-tbar-txt', null, label) : null);
              // its revisions, striped like the Timeline's, each its own days
              vs.forEach(v => {
                const vt = useBy[v.task], vw = ax.w(v.start, v.end);
                const vb = el('.bar.smi-tbar.smi-ver', {
                  'data-task': t.id, 'data-inst': v.id,
                  title: displayName(vt) + '\n' + shortRange(v.start, v.end),
                  style: { left: ax.x(v.start) + 'px', width: vw + 'px', '--c': dep.color }
                }, vw > 16 ? el('span.smi-tbar-txt', null, 'V' + vIndex(vt)) : null);
                vb.style.setProperty('--c', dep.color);
                dragBar(vb, v, ax, () => select(t.id, v.id, true), false);
                hoverable(vb, t.id);
                tr.appendChild(vb);
              });
              // a task that starts before something it waits for has finished
              const clash = (S.deps[t.id] || []).some(d => { const o = mine.find(x => x.task === d); return o && lastEnd(o) >= i.start; });
              if (clash) b.classList.add('smi-clash');
              dragBar(b, i, ax, () => select(t.id, i.id, true), false);
              hoverable(b, t.id);
              tr.appendChild(b);
            });
            r.appendChild(tr);
            rows.appendChild(r);
          });
        });
      });
    }, tools));

    body.appendChild(editorPanel(3));
    applySel();

    const res = built();
    const today = App.isoDate(App.today());
    let past = 0, now = 0;
    res.payload.episodes.forEach(ep => Object.keys(ep.dates).forEach(k => {
      const d = ep.dates[k]; if (d.due < today) past++; else if (d.start <= today) now++;
    }));
    const clashes = res.warnings.filter(w => w.clash), hard = res.warnings.filter(w => !w.soft && !w.clash);
    if (clashes.length || hard.length) {
      const det = el('details.smi-more.smi-warns', null, [el('summary', null, [App.icon('warn'), ' ' + (clashes.length + hard.length) + ' thing' + (clashes.length + hard.length === 1 ? '' : 's') + ' worth a look' +
        (clashes.length ? ' — bars outlined red start before what they wait for has finished' : '')])]);
      const wl = el('.smi-warn');
      hard.concat(clashes).slice(0, 80).forEach(w => wl.appendChild(el('div', null, [el('b', null, w.code), ' ' + w.msg])));
      if (clashes.length + hard.length > 80) wl.appendChild(el('div.soft', null, '…and ' + (clashes.length + hard.length - 80) + ' more'));
      det.appendChild(wl);
      body.appendChild(det);
    }
    if (past || now) {
      const sel = el('select.fld.smi-in.smi-past', { title: 'Work already under way', onchange: (e) => { S.pastDone = e.target.value === '1'; } }, [
        el('option', { value: '1' }, past + ' past task' + (past === 1 ? '' : 's') + ' Approved' + (now ? ', ' + now + ' In progress' : '')),
        el('option', { value: '0' }, 'Everything Not started')
      ]);
      sel.value = S.pastDone ? '1' : '0';
      foot.appendChild(el('label.smi-foot-note', null, ['Work under way: ', sel]));
    }
    foot.appendChild(el('button.btn-ghost', { onclick: () => go(2) }, 'Back'));
    foot.appendChild(el('button.btn-primary', { disabled: !res.payload.episodes.length || null, onclick: () => create(built()) },
      [App.icon('save'), ' Create show']));
  }

  /* ================= create ================= */
  function built() {
    return E().build(S.model, { show: S.show, episodes: S.episodes, tasks: S.tasks, instances: S.instances.filter(i => included()[i.ep]), deps: S.deps,
      order: currentOrder() });
  }

  function create(res) {
    const p = res.payload;
    p.exportedAt = new Date().toISOString();
    // statuses the way Add Show derives them, now the pipeline is known
    const today = App.isoDate(App.today());
    p.episodes.forEach(ep => {
      ep.statuses = App.deriveStatusesFromDates(p.show.pipeline, ep.dates, {});
      const vers = ep._versions || {};
      delete ep._versions;
      if (!S.pastDone) return;
      /* Versions already done count as revisions spent, the way the app
         records one a Director sent back (App.requestRevision): the task's
         due date grows to the end of the last one, and ep.revisions says how
         many — so what's left is planned from there. */
      const spend = (k, n) => { (ep.revisions = ep.revisions || {})[k] = n; ep.dates[k].due = vers[k][n - 1].due; };
      Object.keys(ep.dates).forEach(k => {
        const dt = ep.dates[k], vs = vers[k] || [];
        const last = vs.length ? vs[vs.length - 1].due : dt.due;
        if (last < today) { ep.statuses[k] = 'approved'; if (vs.length) spend(k, vs.length); }
        else if (dt.start <= today) {
          ep.statuses[k] = 'in_progress';
          const used = vs.filter(v => v.start <= today).length;
          if (used) spend(k, used);
        }
      });
    });
    const out = App.importShow(p);
    if (!out) return;
    const links = p.show.pipeline.reduce((n, t) => n + t.deps.length, 0);
    App.track && App.track.audit && App.track.audit('show.smartImport', { show: p.show.name, sheet: S.sheetName,
      file: S.fileName, episodes: p.episodes.length, tasks: p.show.pipeline.length, links, notes: (p.show.notes || []).length,
      edited: S.instances.filter(i => i.edited).length, pastDone: S.pastDone });
    App.state.filters.show = [out.showId];
    S.created = true;                     // closing now clears the draft rather than keeping it
    App.modal.close();
    App.render();
  }

  App.smartImport = { open };
})();
