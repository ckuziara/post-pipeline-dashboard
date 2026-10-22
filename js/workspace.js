/* Per-subtask workspace — the panel inside the Edit Task dialog.

   The point is that nobody should ever need Finder or Explorer:
     • Project   — create the working project from a show template, or open the
                   existing one / its folder natively.
     • Assets    — only what THIS task needs: each dependency's published files,
                   folders and links, labelled by source. A dependency that
                   hasn't published anything shows as Pending.
     • Deliverables — a checklist of the files this task owes (js/naming.js),
                   filled by picking each from the volume (or a link, for
                   online documents). Each is COPIED into !!_Mezzanine under
                   its convention name — nobody types a name or a path — and
                   approval publishes a copy to !!_Publish, which is what
                   dependent tasks then see as their assets.

   Files are the filesystem's truth (listed live by the server); links live in
   shared board state, since there's nothing on disk to point at. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const KEY = (epId, taskKey) => epId + '::' + taskKey;

  const EXT_ICON = {
    mov: 'clapper', mp4: 'clapper', mxf: 'clapper', prproj: 'clapper', aep: 'clapper', r3d: 'clapper', braw: 'clapper',
    wav: 'music', mp3: 'music', aif: 'music', aiff: 'music', ptx: 'music',
    jpg: 'image', jpeg: 'image', png: 'image', psd: 'image', ai: 'image', tif: 'image', exr: 'image',
    pdf: 'file', doc: 'file', docx: 'file', txt: 'file', csv: 'file', xlsx: 'file', fdx: 'file'
  };
  const iconFor = (name, isDir) => isDir ? 'folder' : (EXT_ICON[String(name).split('.').pop().toLowerCase()] || 'package');

  /* ---- software per department -------------------------------------------
     Create Project asks which application first, then shows only that app's
     templates — so a Music editor never scrolls past Nuke scripts.

     Desktop apps match template files by extension in the show's template
     library. Online apps (Google) have no file on disk: they open their template
     gallery in the real default browser instead.

     If an extension guess here is wrong, nothing is lost — every app's template
     list ends with "Show every template", so a mismatch can't block anyone. */
  const SOFTWARE = {
    gdocs:    { label: 'Google Docs',          kind: 'online',  icon: 'note',
                gallery: 'https://docs.google.com/document/u/0/',     blank: 'https://docs.google.com/document/create' },
    gsheets:  { label: 'Google Sheets',        kind: 'online',  icon: 'chart',
                gallery: 'https://docs.google.com/spreadsheets/u/0/', blank: 'https://docs.google.com/spreadsheets/create' },
    logic:    { label: 'Logic Pro X',          kind: 'desktop', icon: 'piano', ext: ['logicx', 'logic'] },
    protools: { label: 'Pro Tools',            kind: 'desktop', icon: 'sliders', ext: ['ptx', 'ptt', 'ptf'] },
    audition: { label: 'Adobe Audition',       kind: 'desktop', icon: 'headphones', ext: ['sesx'] },
    resolve:  { label: 'DaVinci Resolve',      kind: 'desktop', icon: 'palette', ext: ['drp', 'drt'] },
    premiere: { label: 'Adobe Premiere Pro',   kind: 'desktop', icon: 'clapper', ext: ['prproj'] },
    ae:       { label: 'Adobe After Effects',  kind: 'desktop', icon: 'sparkle', ext: ['aep', 'aet'] },
    nuke:     { label: 'Foundry Nuke',         kind: 'desktop', icon: 'puzzle', ext: ['nk', 'nknc'] },
    vantage:  { label: 'Vantage (Telestream)', kind: 'desktop', icon: 'gear', ext: ['xml', 'vwf'] }
  };
  const DEPT_SOFTWARE = {
    creative:  ['gdocs', 'gsheets'],
    music:     ['logic', 'protools', 'gdocs'],
    animation: [],                                        // no templated software
    audio:     ['logic', 'protools', 'audition', 'resolve', 'gdocs'],
    video:     ['premiere', 'resolve', 'ae', 'nuke'],
    ops:       ['premiere', 'vantage', 'gdocs', 'gsheets'],
    qc:        ['premiere', 'gsheets']
  };
  App.SOFTWARE = SOFTWARE;
  App.DEPT_SOFTWARE = DEPT_SOFTWARE;

  /* Software a studio added itself (Admin → Workflow → Department Software →
     Add new software). Same shape as the built-ins, plus custom:true so the UI
     can offer to rename or remove it — a built-in can only be switched off.
     Held in shared board state, since a tool the studio uses is a fact about
     the studio, not about one person's laptop. */
  App.customSoftware = () => (App.state && App.state.data && App.state.data.software) || {};

  /* Every application available, built-ins in catalogue order then anything
     the studio added, alphabetically. What the department lists offer, and
     what Create Project's "add an application" step draws from. */
  App.softwareCatalog = function () {
    const custom = App.customSoftware();
    return Object.keys(SOFTWARE).map(k => Object.assign({ key: k }, SOFTWARE[k]))
      .concat(Object.keys(custom)
        .map(k => Object.assign({ key: k, kind: 'desktop', icon: 'package' }, custom[k], { custom: true }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { sensitivity: 'base' })));
  };
  App.software = function (k) {
    if (SOFTWARE[k]) return Object.assign({ key: k }, SOFTWARE[k]);
    const c = App.customSoftware()[k];
    return c ? Object.assign({ key: k, kind: 'desktop', icon: 'package' }, c, { custom: true }) : null;
  };

  /* Which apps a department uses. The lists above are the defaults; once an
     admin edits a department (in Admin, or by adding an app from inside Create
     Project) the whole list for that department is stored in shared board
     state, so everyone sees the same options. Stored per department rather
     than as a diff: "Video Post uses these four" survives a change to the
     defaults, where a remembered "minus nuke" would silently reinterpret it. */
  App.deptAppKeys = function (dept) {
    const ov = App.state && App.state.data && App.state.data.deptApps;
    const list = (ov && ov[dept]) || DEPT_SOFTWARE[dept] || [];
    return list.filter(k => !!App.software(k));   // a removed entry just drops out
  };
  App.deptSoftware = (dept) => App.deptAppKeys(dept).map(k => App.software(k));

  const extOf = (name) => String(name).split('.').pop().toLowerCase();
  const templatesFor = (all, sw) => (all || []).filter(t => sw.ext && sw.ext.includes(extOf(t.name)));

  function fmtSize(bytes) {
    if (!bytes) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }

  /* ---- links (state, not filesystem) ---- */
  App.taskLinks = (epId, taskKey) => {
    const d = App.state.data;
    return (d.taskLinks && d.taskLinks[KEY(epId, taskKey)]) || [];
  };
  App.addTaskLink = function (epId, taskKey, url) {
    url = String(url || '').trim();
    if (!url) return false;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch (e) { App.toast('That doesn’t look like a link', true); return false; }
    const u = App.state.user;
    App.mutate(d => {
      d.taskLinks = d.taskLinks || {};
      const k = KEY(epId, taskKey);
      (d.taskLinks[k] = d.taskLinks[k] || []).push({
        id: App.uid(), url, by: (u && u.name) || 'Someone', at: new Date().toISOString()
      });
    });
    return true;
  };
  App.removeTaskLink = function (epId, taskKey, id) {
    App.mutate(d => {
      const k = KEY(epId, taskKey);
      if (d.taskLinks && d.taskLinks[k]) d.taskLinks[k] = d.taskLinks[k].filter(l => l.id !== id);
    });
  };

  /* A send button that's been pressed: it turns into a green "✓ Sent" with a
     little pop, so the click visibly landed, then the step runs (which
     redraws the section). */
  App.sendPulse = function (btn, fn) {
    if (!btn || btn.classList.contains('ws-sent')) return;
    btn.classList.add('ws-sent'); btn.disabled = true;
    btn.innerHTML = ''; btn.appendChild(document.createTextNode('✓ Sent'));
    setTimeout(() => { fn(); App.editTask && App.editTask._refresh && App.editTask._refresh(); }, 650);
  };

  App.workspace = {
    _mounted: null,   // { box, epId, taskKey } — the panel currently in a dialog

    /* Mounted into the Edit Task dialog. Renders a placeholder immediately and
       fills in once the server has listed the folders. */
    inlineSection(epId, taskKey, focus) {
      const box = el('.ws');
      this._mounted = { box, epId, taskKey, data: null, busy: false, focus: focus || null };
      this._render();
      this.reload();
      return box;
    },

    // called by App.render() so a teammate's delivery shows up while the dialog is open
    syncOpen() { if (this._mounted && this._mounted.box.isConnected) this._render(); },

    async reload() {
      const m = this._mounted; if (!m) return;
      const ep = App.state.data.episodes.find(e => e.id === m.epId); if (!ep) return;
      try {
        m.data = await App.api.taskWorkspace({
          epId: m.epId, taskKey: m.taskKey, pipeline: App.pipelineFor(ep)
        });
        m.error = null;
        /* PAM renames misnamed exports as it lists them (server.js reconcile);
           the record of it goes to the board's activity log from here, since a
           companion has no board of its own to write to. */
        ((m.data && m.data.reconciled && m.data.reconciled.renamed) || []).forEach(x =>
          App.track.audit('pam.rename', { episode: ep.code, task: m.taskKey, from: x.from, to: x.to }));
      } catch (e) {
        m.error = e.message;
      }
      this._render();
    },

    _render() {
      const m = this._mounted; if (!m || !m.box) return;
      const box = m.box; box.innerHTML = '';
      const ep = App.state.data.episodes.find(e => e.id === m.epId); if (!ep) return;
      const su = App.subitem(ep, m.taskKey); if (!su) return;

      if (m.error) {
        box.appendChild(el('.modal-section-title', null, 'Workspace'));
        box.appendChild(el('.ws-note', null, '⚠ ' + m.error));
        return;
      }
      if (!m.data) {
        box.appendChild(el('.modal-section-title', null, 'Workspace'));
        box.appendChild(el('.ws-note', null, 'Reading the production folders…'));
        return;
      }
      /* Project is dropped from the phone panel entirely, not just its
         upload/create action — "Create Project" opens a multi-step picker
         (application → template → copy) built for a mouse and a desktop app
         to hand off to, neither of which exists on a phone, and "Open
         Project"/"Open folder" launch a desktop app on the machine running
         the server, which is meaningless from a phone anyway. Assets and
         Deliver stay: what's already there is worth seeing on the go, and
         Deliver's own upload actions are what's actually being asked for
         below — this just also removes the one section that has no
         read-only mode to fall back to. */
      const mode = this._modeNote(m.data);
      if (mode) box.appendChild(mode);
      const wrongRoot = this._rootWarning(m.data);
      if (wrongRoot) box.appendChild(wrongRoot);

      /* Only what this stage of the task needs, in full; the rest folds into
         one "Project & files" line (or a compact history) so the dialog says
         what's next instead of showing every tool at once:
           not started                 Project · Assets
           in progress                 Project · Assets · Review Uploads
           review                      Review Uploads
           approved (to deliver)       Deliver · past reviews (compact)
           back from QC (qcfix)        Deliver, with Resubmit to QC · Project · Assets
           in QC / done                past reviews · what was delivered (compact)
         Review Uploads sits before Deliver on purpose: it's the work BEFORE
         sign-off, Deliver what happens after. Owned by js/reviewflow.js. */
      const stage = App.taskStage(ep, su);
      const project = () => App.isPhone() ? null : this._project(ep, su, m.data);
      const assets = () => this._assets(ep, su, m.data);
      const review = () => App.reviewFlow ? App.reviewFlow.inlineSection(ep, su, m.data) : null;
      const reviewPast = () => App.reviewFlow ? App.reviewFlow.compactSection(ep, su) : null;
      const deliver = () => this._deliver(ep, su, m.data);
      const folded = (label, nodes) => {
        nodes = nodes.filter(Boolean); if (!nodes.length) return null;
        return el('details.ws-more', null, [el('summary', null, label)].concat(nodes));
      };
      const parts = stage === 'start' ? [project(), assets()]
        : stage === 'work' ? [project(), assets(), review()]
        : stage === 'review' ? [review(), folded('Project & files', [project(), assets()])]
        : stage === 'deliver' ? [deliver(), reviewPast(), folded('Project & files', [project(), assets()])]
        // QC's fix is a delivery fix: the project to fix it in, and Deliver to put it back
        : stage === 'qcfix' ? [deliver(), project(), folded('Assets & past reviews', [assets(), reviewPast()])]
        : /* qc, done */ [reviewPast(), folded(stage === 'qc' ? 'Delivered files & project' : 'Files & project', [deliver(), project(), assets()])];
      parts.filter(Boolean).forEach(n => box.appendChild(n));
      // opened to deliver (the Priority widget's Deliver button): bring that section into view
      if (m.focus === 'deliver') {
        m.focus = null;
        const d = [...box.querySelectorAll('.ws-block')].find(b => /Deliver/.test((b.querySelector('.modal-section-title') || {}).textContent || ''));
        if (d) requestAnimationFrame(() => { d.scrollIntoView({ block: 'center', behavior: 'smooth' }); d.classList.add('ws-flash'); setTimeout(() => d.classList.remove('ws-flash'), 1400); });
      }
      App.editTask && App.editTask._refresh && App.editTask._refresh();   // the To-Do follows the stage
    },

    /* Which machine's filesystem this panel is actually talking to.

       Without this the companion is invisible in both directions: when one
       answers, the panel silently works and nobody knows why it does here
       but not on their laptop; when none does, three blocks each explain
       they can't reach anything, and none of them mentions that running the
       app locally is what closes the gap. Said once, at the top, rather than
       repeated in every block. */
    _modeNote(d) {
      const c = App.companion;
      if (!c) return null;

      if (c.usable() && d.masterOk) {
        return el('.ws-note.ws-mode', null, [
          App.icon('plug'), ' ' + c.describe(),
          /* Unpairing has to live somewhere, and here is where someone
             actually notices they're paired to the wrong machine. */
          el('button.ws-x', {
            title: 'Stop using this computer\u2019s volume',
            onclick: () => { c.forget(); this.reload(); }
          }, '✕')
        ]);
      }

      /* A companion is here and only wants its code. Worth a field rather
         than a sentence: the alternative is telling someone to open a
         console, which nobody in post is going to do. */
      if (c.unpaired()) {
        const fld = el('input.fld.ws-pair-in', {
          type: 'text', placeholder: 'ABCD-EFGH-JKLM', maxlength: '20', spellcheck: 'false'
        });
        const pair = () => {
          if (!fld.value.trim()) { App.toast('Paste the code from the companion window', true); return; }
          c.setCode(fld.value);
          this.reload();                     // re-probe, then re-render with the result
        };
        fld.addEventListener('keydown', e => { if (e.key === 'Enter') pair(); });
        return el('.ws-note.ws-mode.ws-pair', null, [
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
            [App.icon('plug'), ' ' + c.describe()]),
          el('.ws-pair-row', null, [fld, el('button.ws-btn.btn-primary', { onclick: pair }, 'Pair')])
        ]);
      }
      /* Only worth suggesting from a page that ISN'T the local server
         already — being told to "run it locally" while running locally is
         just confusing, and there the missing piece is the volume itself,
         which masterError already names in each block. */
      if (!d.masterOk && c.wanted()) {
        return el('.ws-note.ws-mode', null, [
          App.icon('plug'),
          ' Running PipeDream on the machine that has the volume mounted lets this page use it for files.'
        ]);
      }
      return null;
    },

    /* A companion pointed one level off is the failure this catches.

       MASTER_PATH on a companion OVERRIDES whatever the board has configured,
       so a companion launched against the folder CONTAINING the production
       root builds every show tree beside it instead of inside it — silently,
       because each path still resolves inside its own declared master
       directory, so every guard in folders.js is satisfied. Nothing is wrong
       from the server's point of view. It's only wrong compared to what the
       board thinks its production root is, and the browser is the one place
       that knows both.

       Compared by FOLDER NAME, not by full path, deliberately: a companion is
       expected to have the volume somewhere else on its own machine — that's
       what MOUNT "as it looks HERE" means — so /Volumes/LucidLink/PRODUCTIONS
       and /Users/sam/LucidLink/PRODUCTIONS agree, while .../Claude-Projects
       and .../PRODUCTIONS do not. Comparing full paths would cry wolf at every
       legitimate companion. */
    _rootWarning(d) {
      const c = App.companion;
      if (!c || !c.usable() || !d || !d.masterOk || !d.root) return null;
      const boardMaster = ((App.state.data.storage || {}).masterPath || '').replace(/\/+$/, '');
      if (!boardMaster) return null;
      const leaf = (p) => p.split('/').filter(Boolean).pop() || '';
      // d.root is <master>/<showRoot>, so its parent is the master root
      const servedMaster = d.root.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
      if (!servedMaster || leaf(servedMaster) === leaf(boardMaster)) return null;
      return el('.ws-note.ws-wrongroot', null, [
        App.icon('warn'),
        ' This computer is serving files from ',
        el('code', null, leaf(servedMaster) + '/'),
        ' but the board’s production folder is ',
        el('code', null, leaf(boardMaster) + '/'),
        '. Show folders are being built in the wrong place — fix MOUNT in ' +
        '“Start Post Pipeline Companion.command” and restart it.'
      ]);
    },

    /* ---------------------------------------------------------- project ---- */
    _project(ep, su, d) {
      const wrap = el('.ws-block');
      wrap.appendChild(el('.ws-head', null, [
        el('.modal-section-title', { style: { margin: '0' } }, [App.icon('mixer'), ' Project']),
        el('span.ws-path', null, d.deliverable + '/')
      ]));

      /* Every project action needs a real filesystem to create, list or open
         a file in — there's no read-only fallback the way Assets and Deliver
         have one, so this server saying so plainly is the whole section. */
      if (!d.masterOk) {
        wrap.appendChild(el('.ws-note', null, d.masterError));
        return wrap;
      }

      const projects = d.work.filter(f => !f.dir);
      const actions = el('.ws-actions');

      if (!projects.length) {
        actions.appendChild(el('button.btn-primary.ws-btn', {
          onclick: () => this._createProject(d)
        }, '＋ Create Project'));
      } else {
        // open the newest file directly — that's almost always the live one
        const newest = projects.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0];
        actions.appendChild(el('button.btn-primary.ws-btn', {
          onclick: () => this._open({ which: 'work', name: newest.name })
        }, '▶ Open Project'));
        // the newest project, copied up a version (server.js /api/task/project)
        actions.appendChild(el('button.btn-ghost.ws-btn', {
          title: 'Copy ' + newest.name + ' to the next version',
          onclick: () => this._newVersion()
        }, '＋ New version'));
      }
      actions.appendChild(el('button.btn-ghost.ws-btn', {
        onclick: () => this._open({ which: 'work' })
      }, [App.icon('folderOpen'), ' Open folder']));
      wrap.appendChild(actions);

      if (projects.length) {
        const list = el('.ws-list');
        projects.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).forEach(f => {
          list.appendChild(el('button.ws-item', {
            onclick: () => this._open({ which: 'work', name: f.name })
          }, [
            App.icon(iconFor(f.name, false), { cls: 'ws-ic' }),
            el('span.ws-name', null, f.name),
            el('span.ws-meta', null, fmtSize(f.size)),
            el('span.ws-go', null, '↗')
          ]));
        });
        wrap.appendChild(list);
      } else {
        const apps = App.deptSoftware(su.dept);
        wrap.appendChild(el('.ws-note', null, apps.length
          ? 'No project yet. Create Project offers ' +
            apps.map(a => a.label).join(', ') + ' — the software ' + App.dept(su.dept).label + ' uses.'
          : 'No project yet. ' + App.dept(su.dept).label + ' has no templated software, so Create Project just prepares the folder.'));
      }
      return wrap;
    },

    _newVersion() {
      const m = this._mounted;
      const ep = App.state.data.episodes.find(e => e.id === m.epId);
      App.api.taskProject({ epId: m.epId, taskKey: m.taskKey, pipeline: App.pipelineFor(ep), newVersion: true })
        .then(r => { App.toast(r.created ? 'Created ' + r.created : 'Folder ready'); this.reload(); })
        .catch(e => App.toast(e.message, true));
    },

    /* What a deliverable is called in plain words: the Naming Conventions
       label for its suffix ("Mix", "No IO Texted Video Master"), else the
       suffix itself in title case (STORYBOARD → Storyboard). */
    _outLabel(o) {
      const rows = App.namingConfig().tables.find(t => t.key === 'suffixes').rows;
      const hit = rows.find(rw => rw[0] === o.suffix && (!o.type || rw[1] === o.type)) || rows.find(rw => rw[0] === o.suffix);
      return hit ? hit[2] : o.suffix.toLowerCase().replace(/(^|-)([a-z])/g, (m, p, c) => (p ? ' ' : '') + c.toUpperCase());
    },

    _assign(file, stem) {
      const m = this._mounted;
      const ep = App.state.data.episodes.find(e => e.id === m.epId);
      App.api.taskAssign({ epId: m.epId, taskKey: m.taskKey, pipeline: App.pipelineFor(ep), file, stem })
        .then(r => {
          App.track.audit('pam.rename', { episode: ep.code, task: m.taskKey, from: r.from, to: r.to });
          App.toast('Filed as ' + r.to); this.reload();
        })
        .catch(e => App.toast(e.message, true));
    },

    // shared shell for the Create Project steps, so Back/Cancel behave the same
    _step(icon, title, subtitle, body, footer) {
      App.modal.open(el('.modal-card.confirm-card.ws-step', { onclick: e => e.stopPropagation() }, [
        el('.modal-head', null, [
          el('.modal-head-main', null, [
            App.icon(icon, { cls: 'modal-ic' }),
            el('div', null, [
              el('.modal-title', null, title),
              el('.modal-subtitle', null, subtitle)
            ])
          ]),
          el('button.modal-x', { onclick: () => this._back(), title: 'Close' }, '✕')
        ]),
        el('.modal-body', null, body),
        el('.modal-foot', null, footer)
      ]));
    },

    // copy a desktop template into the working folder (or just make the folder)
    _makeProject(template, templateSource) {
      const m = this._mounted;
      const ep = App.state.data.episodes.find(e => e.id === m.epId);
      App.toast(template ? 'Creating project from ' + template + '…' : 'Opening working folder…');
      App.editTask.open(m.epId, m.taskKey);          // step dialogs replaced it — put it back
      App.api.taskProject({ epId: m.epId, taskKey: m.taskKey, pipeline: App.pipelineFor(ep), template, templateSource })
        .then(r => {
          App.toast(r.created ? 'Created ' + r.created : 'Folder ready' + (r.opened ? '' : ' — ' + r.dir));
          this.reload();
        })
        .catch(e => App.toast(e.message, true));
    },

    /* Step 1 — which application. Only the ones that department actually uses. */
    _createProject(d) {
      const m = this._mounted;
      const ep = App.state.data.episodes.find(e => e.id === m.epId);
      const su = App.subitem(ep, m.taskKey);
      const apps = App.deptSoftware(su.dept);
      const deptLabel = App.dept(su.dept).label;

      if (!apps.length) {
        // Animation is N/A out of the box — no templated software, so just
        // prepare the folder. An admin can still add an app to the department
        // from here, which is how that changes without a trip to Admin.
        return this._step('mixer', 'Create project', deptLabel + ' has no applications configured.',
          el('.ws-note', null, deptLabel + ' work isn’t template-driven by default, so there’s nothing to copy. ' +
            'PipeDream can still create and open the working folder for you.'),
          [
            el('button.btn-ghost', { onclick: () => this._back() }, 'Cancel'),
            this._canAdmin() ? el('button.btn-ghost', { onclick: () => this._addAppPicker(d) }, '＋ Add an application') : null,
            el('button.btn-primary', { onclick: () => this._makeProject(null) }, 'Make & open the folder')
          ]);
      }

      const list = el('.ws-list');
      apps.forEach(sw => {
        const n = sw.kind === 'online' ? null : templatesFor(d.templates, sw).length;
        list.appendChild(el('button.ws-item', {
          onclick: () => (sw.kind === 'online' ? this._onlinePicker(d, sw) : this._templatePicker(d, sw))
        }, [
          App.icon(sw.icon, { cls: 'ws-ic' }),
          el('span.ws-name', null, sw.label),
          el('span.ws-meta', null, sw.kind === 'online'
            ? 'template gallery'
            : (n ? n + ' template' + (n === 1 ? '' : 's') : 'no templates yet')),
          el('span.ws-go', null, '›')
        ]));
      });

      /* Growing the list is part of the same job as choosing from it: the
         moment someone finds their app missing is right here, not later in
         Admin. Admin-only, because the department's app list is shared by
         every show. */
      if (this._canAdmin()) {
        list.appendChild(el('button.ws-item.ws-add', {
          onclick: () => this._addAppPicker(d)
        }, [
          App.icon('plus', { cls: 'ws-ic' }),
          el('span.ws-name', null, 'Add an application…'),
          el('span.ws-meta', null, 'for all ' + deptLabel + ' tasks'),
          el('span.ws-go', null, '›')
        ]));
      }

      this._step('mixer', 'Create project', 'Which application? — ' + deptLabel + ' · ' + d.deliverable, list, [
        el('button.btn-ghost', { onclick: () => this._back() }, 'Cancel'),
        el('button.btn-ghost', { onclick: () => this._makeProject(null) }, 'Just make the folder')
      ]);
    },

    /* Only a producer/admin can change what every show sees — the department's
       app list and the studio template library are both shared. Read-only users
       simply don't get the add rows, rather than getting a row that scolds. */
    _canAdmin() { return !!(App.isAdminRole && App.isAdminRole(App.state.role)); },

    /* Step 1b — every app in the catalogue this department doesn't have yet.
       Adding one puts it in front of every task in that department (the same
       edit as Admin → Workflow → Apps) and then steps straight into its
       templates, since choosing an app is what they came here to do. */
    _addAppPicker(d) {
      const m = this._mounted;
      const ep = App.state.data.episodes.find(e => e.id === m.epId);
      const su = App.subitem(ep, m.taskKey);
      const dept = su.dept, deptLabel = App.dept(dept).label;
      const have = App.deptAppKeys(dept);
      const rest = App.softwareCatalog().filter(sw => !have.includes(sw.key));

      const list = el('.ws-list');
      if (!rest.length) {
        list.appendChild(el('.ws-note', null,
          deptLabel + ' already has every application in the catalogue.'));
        list.appendChild(el('.ws-note.tight', null,
          'The catalogue itself is part of the app — each entry knows its template ' +
          'extensions, or its online template gallery. Ask for a new one to be added if ' +
          'something you use is missing.'));
      } else {
        rest.forEach(sw => {
          list.appendChild(el('button.ws-item', {
            onclick: () => {
              if (!App.setDeptApp(dept, sw.key, true)) return;
              App.editTask.open(m.epId, m.taskKey);       // the step dialogs replaced it
              sw.kind === 'online' ? this._onlinePicker(d, sw) : this._templatePicker(d, sw);
            }
          }, [
            App.icon(sw.icon, { cls: 'ws-ic' }),
            el('span.ws-name', null, sw.label),
            el('span.ws-meta', null, sw.kind === 'online'
              ? 'opens in the browser'
              : 'templates: ' + (sw.ext || []).map(x => '.' + x).join(', ')),
            el('span.ws-go', null, '＋')
          ]));
        });
        list.appendChild(el('.ws-note.tight', null,
          'Adding an application shows it to every ' + deptLabel + ' task, on every show — ' +
          'the same list as Admin → Workflow → Apps.'));
      }

      this._step('plus', 'Add an application', 'To ' + deptLabel + '’s Create Project list', list, [
        el('button.btn-ghost', { onclick: () => this._createProject(d) }, '‹ Back')
      ]);
    },

    /* Add a template to a library, from a file already on the volume. Copied,
       never moved — a template is reference material, and a library that
       empties itself as people use it is data loss. */
    _addTemplate(d, sw, source) {
      const m = this._mounted;
      const ep = App.state.data.episodes.find(e => e.id === m.epId);
      const st = App.state.data.storage || {};
      // Start where templates live if we can, so the common case is one click.
      const start = st.masterPath || (m.data && m.data.root) || undefined;
      const exts = (sw.ext || []).map(x => x.toLowerCase());
      const where = source === 'show' ? 'this show' : 'the studio library';

      App.folderPicker.open(start, (src) => {
        if (!src) return this._templatePicker(d, sw);
        const name = String(src).replace(/\/+$/, '').replace(/^.*\//, '');
        const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
        /* Refuse a mismatch rather than copying it: templatesFor() filters the
           library by extension, so a .nk added under Premiere wouldn't appear
           anywhere — it would just look like the add silently failed. */
        if (exts.length && !exts.includes(ext)) {
          App.editTask.open(m.epId, m.taskKey);
          App.toast(name + ' isn’t ' + sw.label + ' — that needs ' +
            exts.map(x => '.' + x).join(' or '), true);
          return this._templatePicker(d, sw);
        }
        App.toast('Adding ' + name + ' to ' + where + '…');
        App.editTask.open(m.epId, m.taskKey);
        App.api.templateAdd({
          epId: m.epId, taskKey: m.taskKey, pipeline: App.pipelineFor(ep), src, source
        }).then(async (r) => {
          App.toast(r.added + ' added to ' + where);
          App.editTask.open(m.epId, m.taskKey);
          await this.reload();                    // pick the new file up in d.templates
          const mm = this._mounted;
          if (mm && mm.data) this._templatePicker(mm.data, sw);
        }).catch(e => {
          App.toast(e.message, true);
          App.editTask.open(m.epId, m.taskKey);
          this._templatePicker(d, sw);
        });
      }, {
        pickFiles: true,
        title: 'Add a ' + sw.label + ' template',
        subtitle: 'Pick the project file to copy into ' + where + '. It stays where it is — ' +
          'templates are copied, not moved. Expects ' +
          (exts.length ? exts.map(x => '.' + x).join(' or ') : 'a project file') + '.',
        confirmLabel: 'Add this template',
        onCancel: () => { App.editTask.open(m.epId, m.taskKey); this._templatePicker(d, sw); }
      });
    },

    /* Step 2a — desktop app: its own templates, copied into the task folder. */
    _templatePicker(d, sw) {
      const mine = templatesFor(d.templates, sw);
      const list = el('.ws-list');

      const addRow = (t) => list.appendChild(el('button.ws-item', {
        title: t.source === 'show' ? 'This show’s own version, overriding the studio template' : 'Studio template library',
        onclick: () => this._makeProject(t.name, t.source)
      }, [
        App.icon(iconFor(t.name, false), { cls: 'ws-ic' }),
        el('span.ws-name', null, t.name),
        // only call out the exception — studio templates are the norm
        (t.source === 'show' ? el('span.ws-chip.ok', null, 'show') : null),
        el('span.ws-meta', null, fmtSize(t.size))
      ]));

      /* Only this application's templates — never another app's. Offering a
         Nuke script under Premiere is worse than offering nothing, so when
         there's no match we say exactly what to add and where. */
      if (mine.length) {
        mine.forEach(addRow);
      } else {
        const article = /^[aeiou]/i.test(sw.label) ? 'an' : 'a';
        list.appendChild(el('.ws-note', null, 'No ' + sw.label + ' templates yet.'));
        list.appendChild(el('.ws-note.tight', null,
          'An admin can add one by saving ' + article + ' ' + sw.label + ' template as ' +
          (sw.ext || []).map(x => '.' + x).join(' or ') + ' into !!_Templates ' +
          'on the master directory — it then appears here for every show.'));
      }

      /* Same reasoning as the app list: the moment the right template is
         missing is the moment you're looking for it. Two destinations, offered
         as separate rows rather than a follow-up question — the choice is
         "everyone" or "just this show", and it reads better as a label than as
         a dialog. */
      if (this._canAdmin()) {
        list.appendChild(el('button.ws-item.ws-add', {
          onclick: () => this._addTemplate(d, sw, 'master')
        }, [
          App.icon('plus', { cls: 'ws-ic' }),
          el('span.ws-name', null, 'Add a ' + sw.label + ' template…'),
          el('span.ws-meta', null, 'studio library · every show'),
          el('span.ws-go', null, '›')
        ]));
        list.appendChild(el('button.ws-item.ws-add', {
          onclick: () => this._addTemplate(d, sw, 'show')
        }, [
          App.icon('plus', { cls: 'ws-ic' }),
          el('span.ws-name', null, 'Add one for this show only…'),
          el('span.ws-meta', null, 'overrides the studio version'),
          el('span.ws-go', null, '›')
        ]));
      }

      this._step(sw.icon, sw.label, 'Copies the template into ' + d.deliverable + '/ and opens it', list, [
        el('button.btn-ghost', { onclick: () => this._createProject(d) }, '‹ Back'),
        el('button.btn-ghost', { onclick: () => this._makeProject(null) }, 'Just make the folder')
      ]);
    },

    /* Step 2b — online app: no file on disk, so open Google's own template
       gallery (or a blank doc) in the real default browser. */
    _onlinePicker(d, sw) {
      const list = el('.ws-list');
      const open = (url, label) => {
        App.editTask.open(this._mounted.epId, this._mounted.taskKey);
        App.api.openUrl(url)
          .then(r => {
            if (r.opened) App.toast('Opened ' + label + ' in your browser');
            else { window.open(url, '_blank', 'noopener'); App.toast('Opened ' + label); }
          })
          .catch(() => { window.open(url, '_blank', 'noopener'); App.toast('Opened ' + label); });
      };
      list.appendChild(el('button.ws-item', { onclick: () => open(sw.gallery, sw.label + ' template gallery') }, [
        App.icon('folderOpen', { cls: 'ws-ic' }),
        el('span.ws-name', null, 'Browse the ' + sw.label + ' template gallery'),
        el('span.ws-go', null, '↗')
      ]));
      list.appendChild(el('button.ws-item', { onclick: () => open(sw.blank, 'a blank ' + sw.label) }, [
        App.icon(sw.icon, { cls: 'ws-ic' }),
        el('span.ws-name', null, 'Start a blank ' + sw.label),
        el('span.ws-go', null, '↗')
      ]));
      list.appendChild(el('.ws-note', null,
        sw.label + ' files live in Drive, not on the volume — once you’ve made the document, ' +
        'come back and use Deliver → Add a link so the next department can find it.'));

      this._step(sw.icon, sw.label, 'Opens in your default browser', list, [
        el('button.btn-ghost', { onclick: () => this._createProject(d) }, '‹ Back'),
        el('button.btn-ghost', { onclick: () => this._back() }, 'Done')
      ]);
    },

    // these sub-dialogs replace the Edit Task modal, so put it back on the way out
    _back() {
      const m = this._mounted; App.modal.close();
      if (m) App.editTask.open(m.epId, m.taskKey);
    },

    _open(opts) {
      const m = this._mounted;
      const ep = App.state.data.episodes.find(e => e.id === m.epId);
      App.api.taskOpen(Object.assign({ epId: m.epId, taskKey: m.taskKey, pipeline: App.pipelineFor(ep) }, opts))
        .then(r => { if (!r.opened) App.toast('Server isn’t on this machine — path: ' + r.path); })
        .catch(e => App.toast(e.message, true));
    },

    /* ----------------------------------------------------------- assets ---- */
    _assets(ep, su, d) {
      const wrap = el('.ws-block');
      // Incoming assets only. A dependency on an earlier version of this same
      // deliverable isn't a handoff — those files sit in this task's own folder
      // and are already listed under Project.
      const deps = d.deps.filter(x => !x.sameFolder);
      const priorVersions = d.deps.filter(x => x.sameFolder);
      /* `items` is null rather than [] for a dependency this server couldn't
         check (no mounted master directory) — see server.js. Kept out of the
         ready count entirely: "0 of 3 ready" would read as nothing's arrived,
         when the honest answer is this server can't tell. */
      const checked = deps.filter(x => x.items !== null);
      const unchecked = deps.length - checked.length;
      const ready = checked.filter(x => x.items.length || App.taskLinks(ep.id, x.key).length).length;
      wrap.appendChild(el('.ws-head', null, [
        el('.modal-section-title', { style: { margin: '0' } }, [App.icon('download'), ' Assets']),
        el('span.ws-path', null, !deps.length ? 'no incoming assets'
          : ready + ' of ' + checked.length + ' ready' + (unchecked ? ' · ' + unchecked + ' unconfirmed' : ''))
      ]));

      if (!deps.length) {
        wrap.appendChild(el('.ws-note', null, priorVersions.length
          ? 'Nothing incoming — this follows on from ' +
            priorVersions.map(p => p.name).join(', ') + ' in the same folder.'
          : 'This task doesn’t wait on anything — nothing to collect.'));
        return wrap;
      }

      deps.forEach(dep => {
        const links = App.taskLinks(ep.id, dep.key);
        const items = dep.items;              // an array, or null if unchecked
        const unknown = items === null;
        const has = unknown ? links.length : items.length + links.length;
        const dept = App.dept(dep.dept);
        const st = App.status(dep.status);

        const row = el('.ws-dep' + (has ? '' : '.pending'));
        row.appendChild(el('.ws-dep-head', null, [
          el('span.dept-chip', { style: { padding: '1px 7px', fontSize: '10px' } },
            [el('span.dot', { style: { background: dept.color } }), dept.label]),
          el('span.ws-dep-name', null, dep.name),
          has ? el('span.ws-chip.ok', null, '✓ ' + has + ' asset' + (has === 1 ? '' : 's'))
            // unknown: this server can't list files at all — distinct from
            // "checked, and there's genuinely nothing" (Pending, below)
            : unknown ? el('span.ws-chip.pending', { title: 'This server has no access to production files — upstream status: ' + st.label }, '? Unconfirmed')
            // nothing published yet — say why, using the upstream task's own status
            : el('span.ws-chip.pending', { title: 'Upstream status: ' + st.label }, '⏳ Pending')
        ]));

        if (has) {
          const list = el('.ws-list');
          (items || []).forEach(f => list.appendChild(el('button.ws-item', {
            onclick: () => this._openDep(dep, f.name)
          }, [
            App.icon(iconFor(f.name, f.dir), { cls: 'ws-ic' }),
            el('span.ws-name', null, f.name),
            el('span.ws-meta', null, f.dir ? 'folder' : fmtSize(f.size)),
            el('span.ws-go', null, '↗')
          ])));
          links.forEach(l => list.appendChild(el('a.ws-item', {
            href: l.url, target: '_blank', rel: 'noopener noreferrer'
          }, [
            App.icon('link', { cls: 'ws-ic' }),
            el('span.ws-name', null, l.url.replace(/^https?:\/\//, '')),
            el('span.ws-meta', null, 'link'),
            el('span.ws-go', null, '↗')
          ])));
          row.appendChild(list);
        } else {
          row.appendChild(el('.ws-note.tight', null,
            unknown
              ? 'This server can’t check ' + dept.label + '’s files — currently ' + st.label + '.'
              : st.key === 'approved'
                ? 'Approved, but nothing was delivered for it.'
                : 'Waiting on ' + dept.label + ' — currently ' + st.label +
                  '. Anything already delivered stays in Mezzanine until it’s approved.'));
        }
        wrap.appendChild(row);
      });
      return wrap;
    },

    _openDep(dep, name) {
      const m = this._mounted;
      const ep = App.state.data.episodes.find(e => e.id === m.epId);
      // open through the dependency's own task so the server resolves its folder
      App.api.taskOpen({ epId: m.epId, taskKey: dep.key, pipeline: App.pipelineFor(ep), which: 'publish', name })
        .then(r => { if (!r.opened) App.toast('Path: ' + r.path); })
        .catch(e => App.toast(e.message, true));
    },

    /* ---------------------------------------------------------- deliver ---- */
    _deliver(ep, su, d) {
      const wrap = el('.ws-block');
      /* Checklist mode — whenever PAM can name this task's files. The person
         never sees a path or a file name: each file the task owes is a row,
         ticked once a version is in, and picking a file from the volume (or
         clicking its row) is the whole job — PipeDream copies it into place
         under the right name. */
      /* A document handed over as a link (Add a link) counts as in: its row is
         ticked "link" and it doesn't hold up Publish. */
      const hasLink = App.taskLinks(ep.id, su.key).length > 0;
      const isDoc = (o) => !o.type || /^(PDF|DOCX?|XLSX?|CSV|TXT|RTF)$/.test(o.type);
      const outs = ((d.masterOk && !(d.namingProblems || []).length && d.outputs) || [])
        .map(o => Object.assign({}, o, { linked: !o.version && hasLink && isDoc(o) }));
      const checklist = outs.length > 0;
      const readyN = outs.filter(o => o.version || o.linked).length;
      wrap.appendChild(el('.ws-head', null, [
        el('.modal-section-title', { style: { margin: '0' } }, [App.icon('upload'), checklist ? ' Deliverables' : ' Deliver']),
        checklist
          ? el('span.ws-chip' + (readyN === outs.length ? '.ok' : '.pending'), null, readyN + ' of ' + outs.length + ' ready')
          : el('span.ws-path', null, '!!_Mezzanine/' + d.deliverable + '/')
      ]));

      const canEdit = App.canEditTask(App.state.role, su);
      if (!canEdit) {
        wrap.appendChild(el('.ws-note', null, 'Your role can’t deliver for this task.'));
        return wrap;
      }

      /* Two different reasons end up hiding the same upload UI, so both are
         checked together rather than nested: phone drops it because there's
         nothing to drag from and no mounted drive to pick from on a phone;
         no master directory drops it because this SERVER has no mounted
         drive, on any device. What's already delivered — files a server
         with a real mount put there, and links, which are board state and
         never needed a mount at all — still renders below either way; this
         is the one section that genuinely has a read-only mode to fall back
         to, unlike Project. */
      const phone = App.isPhone();
      if (d.masterOk && (d.namingProblems || []).length && d.outputs) {
        wrap.appendChild(el('.ws-note', null, [
          '⚠ PipeDream can’t name this task’s files until the show has a Format. ',
          App.canManageShows(App.state.role)
            ? el('button.btn-mini.ws-inline-btn', { onclick: () => App.editShowDialog.open(ep.showId) }, 'Edit Show')
            : 'Ask a Producer to set it in Edit Show.'
        ]));
      }
      if (checklist) {
        /* A link is for documents that live online (Google Docs/Sheets): offered when the
           department works in online software AND this task owes a document — never for a WAV. */
        const docOut = outs.some(isDoc);
        const online = docOut && App.deptSoftware(su.dept).some(sw => sw.kind === 'online');
        const list = el('.ws-list');
        // a show delivered in several languages has one row per language — say which
        const multiLang = new Set(outs.map(o => o.language)).size > 1;
        outs.forEach(o => {
          const label = this._outLabel(o) + (multiLang && o.language ? ' · ' + o.language : '');
          list.appendChild(el('button.ws-item.ws-out' + (o.version || o.linked ? '.done' : ''), {
            disabled: phone,
            title: (o.version ? 'In: ' + o.latest + ' — click to deliver a newer version' : 'Pick the ' + label + ' file from the volume'),
            onclick: () => this._pickFromMount(o.stem, label)
          }, [
            el('span.ws-out-tick', null, o.version || o.linked ? '✓' : ''),
            el('span.ws-name', null, label),
            el('span.ws-out-type', null, o.type || ''),
            o.version ? el('span.ws-chip.ok', null, 'v' + String(o.version).padStart(3, '0'))
              : o.linked ? el('span.ws-chip.ok', null, 'link') : el('span.ws-chip.pending', null, 'needed')
          ]));
        });
        wrap.appendChild(list);
        // files saved straight into the folder that could be either of two deliverables
        ((d.reconciled && d.reconciled.ambiguous) || []).forEach(x => {
          wrap.appendChild(el('.ws-note.ws-ambig', null, [el('span', null, 'Which is ' + x.name + '?')].concat(
            x.stems.map(st => { const o = outs.find(q => q.stem === st); return el('button.btn-mini.ws-inline-btn', { onclick: () => this._assign(x.name, st) }, o ? this._outLabel(o) : st); }))));
        });
        if (!phone) {
          wrap.appendChild(el('.ws-actions', null, [
            // the primary action only while something's still needed — after that it's Publish / Send to QC
            el('button.ws-btn' + (readyN < outs.length ? '.btn-primary' : '.btn-ghost'), { onclick: () => this._pickFromMount() }, [App.icon('archive'), ' Pick from the volume']),
            // documents that live online (Google Docs/Sheets) are handed over as a link
            online ? el('button.btn-ghost.ws-btn', { onclick: () => this._addLink() }, [App.icon('link'), ' Add a link']) : null
          ]));
        }
      } else if (!phone && d.masterOk) {
        const status = el('.ws-progress');
        // what the files are waiting on: QC sent back a fix → QC passing it, not approval
        const sentBack = App.isQcFix(ep, su);
        const drop = el('.ws-drop', null, [
          el('.ws-drop-main', null, [App.icon('upload'), sentBack ? '  Drop the fixed files here' : '  Drop files here to deliver']),
          el('.ws-drop-sub', null, 'or click to browse the volume — held in !!_Mezzanine/' +
            d.deliverable + (sentBack ? ' until QC passes the fix' : ' until this task is approved'))
        ]);

        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
          e.preventDefault(); e.stopPropagation(); drop.classList.add('over');
        }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
          e.preventDefault(); e.stopPropagation(); if (ev === 'dragleave') drop.classList.remove('over');
        }));
        drop.addEventListener('drop', e => {
          drop.classList.remove('over');
          const dt = e.dataTransfer; if (!dt) return;
          /* A dropped folder arrives as a bogus zero-byte "file" that would fail
             mid-upload, and pushing a folder's contents through the browser is
             the very thing "Pick from the volume" exists to avoid — so name the
             better route instead of failing. */
          let dirs = 0;
          if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
            for (const it of dt.items) {
              const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
              if (en && en.isDirectory) dirs++;
            }
          }
          const files = [...(dt.files || [])].filter(f => f.size > 0 || f.type);
          if (dirs) {
            App.toast(dirs === 1 && !files.length
              ? 'Folders can’t be dropped in — use “Pick from the volume” to deliver a folder whole'
              : 'Skipped ' + dirs + ' folder' + (dirs === 1 ? '' : 's') + ' — use “Pick from the volume” for those', true);
          }
          if (files.length) this._upload(files, status);
        });
        /* Clicking opens OUR file browser, never <input type="file">. A native file
           dialog crashes the embedded webview the app runs in — the same reason
           window.confirm() had to be replaced — and a native dialog is Finder,
           which this whole feature exists to avoid. */
        drop.addEventListener('click', () => this._pickFromMount());

        wrap.appendChild(drop);
        wrap.appendChild(status);

        wrap.appendChild(el('.ws-actions', null, [
          // big media is already on the mount — copy it in place instead of
          // pushing gigabytes through the browser
          el('button.btn-ghost.ws-btn', { onclick: () => this._pickFromMount() }, [App.icon('archive'), ' Pick from the volume']),
          el('button.btn-ghost.ws-btn', { onclick: () => this._addLink() }, [App.icon('link'), ' Add a link'])
        ]));
      }

      const fileRow = (f, which) => el('button.ws-item', {
        onclick: () => this._open({ which, name: f.name })
      }, [
        App.icon(iconFor(f.name, f.dir), { cls: 'ws-ic' }),
        el('span.ws-name', null, f.name),
        el('span.ws-meta', null, f.dir ? 'folder' : fmtSize(f.size)),
        el('span.ws-go', null, '↗')
      ]);

      /* Awaiting approval — delivered, but deliberately NOT yet visible to the
         departments downstream. Approving this task moves these into Publish. */
      const mezz = d.mezzanine || [];
      const links = App.taskLinks(ep.id, su.key);
      if (checklist || mezz.length || links.length) {
        const list = el('.ws-list');
        if (!checklist) mezz.forEach(f => list.appendChild(fileRow(f, 'mezzanine')));
        links.forEach(l => list.appendChild(el('.ws-item.static', null, [
          App.icon('link', { cls: 'ws-ic' }),
          el('a.ws-name', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.url.replace(/^https?:\/\//, '')),
          el('span.ws-meta', null, l.by),
          // removing is a mutation, not a view — stays off phone with the
          // rest of this section's editing actions
          phone ? null : el('button.ws-x', { title: 'Remove link', onclick: () => { App.removeTaskLink(ep.id, su.key, l.id); this._render(); } }, '✕')
        ])));
        /* The send button, once delivered: with QC it goes to QC (In QC),
           without it the files are published (Delivered). Both need the
           Director's approval first; before that, nothing to send. */
        const needsQc = App.qcFor(ep, su.key).on;
        const qcFix = needsQc && App.isQcFix(ep, su);
        const canSendHere = !phone && App.canEditTask(App.state.role, su) && su.status === 'approved';
        // QC tasks go to QC (passing QC publishes them); others are published here.
        // Back from QC, the fixed delivery goes straight back to QC from here.
        // the fix: what's gone into Deliver since QC's report — nothing new, nothing to resubmit
        const fresh = qcFix ? App.qcQueue.fixDelivered(ep, su.key, mezz, links) : 0;
        const sendBtn = qcFix && !phone && App.canEditTask(App.state.role, su)
          ? el('button.btn-primary.ws-btn', {
              disabled: !fresh,
              title: fresh ? '' : 'Deliver the fix first',
              onclick: (e) => App.sendPulse(e.currentTarget, () => { App.qcQueue.resubmit(ep.id, su.key, { fresh }); this._render(); })
            }, [App.icon('checkBadge'), ' Resubmit to QC V' + (App.qcVersion(ep, su.key) + 1)])
          : !canSendHere ? null
          : needsQc
            ? (App.qcState(ep, su.key) !== 'passed' ? el('button.btn-primary.ws-btn', {
                onclick: (e) => App.sendPulse(e.currentTarget, () => { App.qcQueue.sendToQc(ep.id, su.key, { delivered: mezz.length + links.length }); this._render(); })
              }, [App.icon('checkBadge'), ' Send to QC']) : null)
            : (mezz.length ? el('button.btn-primary.ws-btn', {
                onclick: (e) => App.sendPulse(e.currentTarget, () => App.promoteDelivered(ep.id, su.key))
              }, [App.icon('package'), ' Publish']) : null);
        /* Publish copies each output's latest version, so it (and QC, who
           checks what will be published) waits until every output has one. */
        const missing = (checklist ? outs : []).filter(o => !o.version && !o.linked);
        if (sendBtn && missing.length) {
          sendBtn.disabled = true;
          sendBtn.title = 'Still to export: ' + missing.map(o => o.suffix + (o.type ? ' ' + o.type : '')).join(', ');
        }
        const chip = qcFix ? el('span.ws-chip.pending', null, 'QC sent it back — fix it here')
          : su.status === 'in_qc' ? el('span.ws-chip.pending', null, 'with QC')
          : App.isApproved(su.status) ? el('span.ws-chip.ok', null, needsQc && App.qcState(ep, su.key) !== 'passed' ? 'approved — not sent to QC' : 'approved')
          : el('span.ws-chip.pending', null, 'awaiting approval');
        wrap.appendChild(el('.ws-delivered', null, [
          el('.ws-sub', null, [checklist ? 'Status · ' : 'Delivered · ', chip]),
          list.children.length ? list : null,
          sendBtn ? el('.ws-actions', null, sendBtn) : null,
          sendBtn && missing.length && !checklist ? el('.ws-note.tight', null, '⚠ ' + sendBtn.title) : null,
          qcFix ? el('.ws-note.tight', null, fresh
            ? fresh + ' new since QC’s report — Resubmit sends the fix back to QC.'
            : 'Nothing new since QC’s report yet — pick the fixed file above, then Resubmit.') : null,
          App.isApproved(su.status) || qcFix ? null : el('.ws-note.tight', null,
            'These stay out of the next department’s Assets until ' + su.name + (needsQc ? ' passes QC' : ' is approved and published') + '.')
        ]));
      }

      // already approved and published — what downstream tasks can actually see
      const publish = d.publish || [];
      if (publish.length && !checklist) {
        const list = el('.ws-list');
        publish.forEach(f => list.appendChild(fileRow(f, 'publish')));
        wrap.appendChild(el('.ws-delivered', null, [
          el('.ws-sub', null, ['Published · ', el('span.ws-chip.ok', null, 'in use downstream')]),
          list
        ]));
      }

      /* Nothing awaiting approval, nothing published, and (for whichever
         reason) no drop zone above to give the section content either — on
         desktop with a working mount that combination can't happen, since
         the drop zone itself is always there; here it means the block would
         otherwise be a bare "Deliver" header over empty space. Assets
         already says something in its own empty case; this is the same
         courtesy, worded for whichever reason actually applies — a missing
         mount is a fact about this server, true on any device, so it's
         named first when both happen to apply at once. */
      if ((phone || !d.masterOk) && !mezz.length && !links.length && !publish.length) {
        wrap.appendChild(el('.ws-note', null, !d.masterOk
          ? d.masterError
          : 'Nothing delivered yet — adding files or a link needs a desktop.'));
      }
      return wrap;
    },

    /* Upload one file per request so multi-GB media streams straight to disk
       instead of buffering. The destination comes from a server-issued token. */
    async _upload(files, statusBox, stem) {
      const m = this._mounted; if (!m || !files.length) return;
      const ep = App.state.data.episodes.find(e => e.id === m.epId);
      statusBox.innerHTML = '';
      const line = el('.ws-prog-line', null, 'Preparing…');
      statusBox.appendChild(line);

      App.track.flowStart('LucidLink delivery', { files: files.length });
      let token;
      try {
        const prep = await App.api.deliverPrepare({ epId: m.epId, taskKey: m.taskKey, pipeline: App.pipelineFor(ep) });
        token = prep.token;
      } catch (e) {
        App.track.error('lucidlink.prepareFailed', { flow: 'LucidLink delivery', message: e.message });
        App.track.flowDone('LucidLink delivery', false, { reason: 'prepare failed' });
        line.textContent = '⚠ ' + e.message; line.classList.add('err'); return;
      }

      let done = 0;
      for (const f of files) {
        line.textContent = 'Delivering ' + f.name + ' (' + (done + 1) + ' of ' + files.length + ')…';
        try {
          const r = await App.api.deliverUpload(token, f, stem);
          done++;
          if (r.filed !== f.name) App.toast('Filed as ' + r.filed);
        } catch (e) {
          App.track.error('lucidlink.uploadFailed', { flow: 'LucidLink delivery', file: f.name, message: e.message });
          App.track.flowDone('LucidLink delivery', false, { reason: 'upload failed', delivered: done });
          line.textContent = '⚠ ' + f.name + ': ' + e.message;
          line.classList.add('err');
          return;
        }
      }
      App.track.flowDone('LucidLink delivery', true, { files: done });
      line.textContent = '✓ Delivered ' + done + ' file' + (done === 1 ? '' : 's');
      line.classList.add('ok');
      this.reload();
    },

    // stem/label: deliver the pick as THAT deliverable (a row was clicked)
    _pickFromMount(stem, label) {
      const m = this._mounted;
      const epId = m.epId, taskKey = m.taskKey;
      const ep = App.state.data.episodes.find(e => e.id === epId);
      // Open where the exports actually are — the task's own working folder —
      // rather than the show root, mirroring Project → Open folder.
      const start = (m.data && m.data.absolute && m.data.absolute.work) || (m.data && m.data.root);
      App.folderPicker.open(start, (chosen) => {
        // multi mode hands back an array; tolerate a bare path either way
        const items = Array.isArray(chosen) ? chosen : (chosen ? [chosen] : []);
        if (!items.length) return this._back();
        // the picker replaced the Edit Task dialog — put it back so the delivery
        // shows up where the user started, then refresh it with the result
        // several files for a task with a checklist: match each to its deliverable, and let the person check
        const d = m.data || {};
        const outs = (d.masterOk && !(d.namingProblems || []).length && d.outputs) || [];
        if (!stem && outs.length) { this._matchFiles(items, outs); return; }
        App.editTask.open(epId, taskKey);
        this._deliverFromMount(epId, taskKey, ep, items, stem);
      }, {
        pickFiles: true,
        title: label ? 'Pick the ' + label + ' file' : 'Deliver from the volume',
        subtitle: stem
          ? 'Starts in this task’s working folder. PipeDream copies it into place and names it — the original stays where it is.'
          : 'Starts in this task’s working folder. Tick any number of files. PipeDream works out which deliverable each one is, copies it into place and names it — the originals stay where they are.',
        multiple: !stem,
        confirmLabel: 'Deliver',
        onCancel: () => this._back()
      });
    },

    /* One prepare call per picked item — the endpoint copies a file or a whole
       directory, so a ticked folder arrives intact rather than flattened. Run
       in sequence, so a 40GB master doesn't race three others for the disk,
       and each takes the next version number in turn. */
    async _deliverFromMount(epId, taskKey, ep, items, stem) {
      const m = this._mounted;
      const label = (p) => p.replace(/\/+$/, '').replace(/^.*\//, '');
      // items: paths, or { src, stem } when each was matched to a deliverable (_matchFiles)
      items = items.map(it => typeof it === 'string' ? { src: it, stem: stem || null } : it);
      App.toast(items.length === 1
        ? 'Copying ' + label(items[0].src) + ' into place…'
        : 'Delivering ' + items.length + ' items…');

      App.track.flowStart('LucidLink delivery', { files: items.length, source: 'volume' });
      const failed = [];
      let done = 0, lastFiled = '', lastFrom = '';
      for (const { src, stem: one } of items) {
        try {
          const r = await App.api.deliverPrepare({ epId, taskKey, pipeline: App.pipelineFor(ep), src, stem: one || undefined });
          done++; lastFiled = r.filed; lastFrom = r.from;
        } catch (e) {
          App.track.error('lucidlink.deliverFailed', { flow: 'LucidLink delivery', file: label(src), message: e.message });
          failed.push(label(src) + ': ' + e.message);
        }
      }
      App.track.flowDone('LucidLink delivery', !failed.length, { files: done, failed: failed.length });

      if (done === 1 && !failed.length) {
        App.toast('Delivered ' + lastFiled + (lastFrom && lastFrom !== lastFiled ? ' (from ' + lastFrom + ')' : ''));
      } else if (done && !failed.length) {
        App.toast('Delivered ' + done + ' items');
      } else if (done) {
        App.toast('Delivered ' + done + ', ' + failed.length + ' failed — ' + failed[0], true);
      } else {
        App.toast(failed[0] || 'Nothing was delivered', true);
      }
      this.reload();
    },

    /* Picked several files: PipeDream works out which deliverable each one is
       from its name (App.matchDeliverables) and shows the result to check —
       one dropdown per file, already set, so a long delivery (MIX, MNE, SFX,
       DIA, ACA, INST, SONGMASTER) is one look and one click. */
    _matchFiles(paths, outs) {
      const m = this._mounted;
      const ep = App.state.data.episodes.find(e => e.id === m.epId);
      const name = (p) => p.replace(/\/+$/, '').replace(/^.*\//, '');
      const names = paths.map(name);
      const found = App.matchDeliverables(names, outs);
      const pick = found.map(r => r.out);                  // index into outs, -1 = don't deliver
      const multiLang = new Set(outs.map(o => o.language)).size > 1;
      const optLabel = (o) => this._outLabel(o) + (o.type ? ' · ' + o.type : '') + (multiLang && o.language ? ' · ' + o.language : '');

      const body = el('div');
      const footBtn = el('button.btn-primary');
      const draw = () => {
        body.innerHTML = '';
        const counts = {};
        pick.forEach(i => { if (i >= 0) counts[i] = (counts[i] || 0) + 1; });
        const list = el('.ws-match-list');
        paths.forEach((p, fi) => {
          const ext = (names[fi].split('.').pop() || '').toLowerCase();
          const sel = el('select.fld.ws-match-sel');
          const add = (v, t) => { const o = document.createElement('option'); o.value = String(v); o.textContent = t; sel.appendChild(o); };
          add(-1, pick[fi] < 0 && found[fi].out < 0 ? 'Choose…' : 'Don’t deliver');
          outs.forEach((o, oi) => { if (App.typeFits(o.type, names[fi].includes('.') ? ext : '')) add(oi, optLabel(o)); });
          sel.value = String(pick[fi]);
          sel.addEventListener('change', () => { pick[fi] = parseInt(sel.value, 10); draw(); });
          const dup = pick[fi] >= 0 && counts[pick[fi]] > 1;
          const state = dup ? 'dup' : pick[fi] < 0 ? 'none' : found[fi].out === pick[fi] ? 'auto' : 'set';
          list.appendChild(el('.ws-match-row.' + state, null, [
            el('.ws-match-file', { title: p }, [App.icon(iconFor(names[fi], false), { cls: 'ws-ic' }), el('span', null, names[fi])]),
            el('span.ws-match-arrow', null, '→'),
            sel,
            el('span.ws-match-flag', null, dup ? 'twice' : state === 'none' ? 'skip' : state === 'auto' ? '✓' : 'set')
          ]));
        });
        body.appendChild(list);
        const n = pick.filter(i => i >= 0).length;
        const dups = Object.keys(counts).filter(k => counts[k] > 1).map(k => this._outLabel(outs[k]));
        const unmatched = pick.filter(i => i < 0).length;
        // what this delivery still leaves out
        const still = outs.filter((o, oi) => !o.version && !pick.includes(oi)).map(o => optLabel(o));
        const notes = [];
        if (dups.length) notes.push(el('.ws-note.tight.bad', null, '⚠ Two files are set to ' + dups.join(', ') + ' — pick one.'));
        if (unmatched) notes.push(el('.ws-note.tight', null, unmatched + ' file' + (unmatched === 1 ? '' : 's') + ' won’t be delivered — choose a deliverable to include ' + (unmatched === 1 ? 'it' : 'them') + '.'));
        if (still.length) notes.push(el('.ws-note.tight', null, 'Still needed after this: ' + still.join(', ') + '.'));
        notes.forEach(x => body.appendChild(x));
        footBtn.disabled = !n || dups.length > 0;
        footBtn.textContent = n ? 'Deliver ' + n + ' file' + (n === 1 ? '' : 's') : 'Deliver';
      };
      footBtn.onclick = () => {
        const items = paths.map((p, fi) => ({ src: p, stem: pick[fi] >= 0 ? outs[pick[fi]].stem : null })).filter(x => x.stem);
        App.editTask.open(m.epId, m.taskKey);
        this._deliverFromMount(m.epId, m.taskKey, ep, items);
      };
      draw();
      const auto = found.filter(r => r.out >= 0).length;
      this._step('archive', 'Check the matches',
        'PipeDream matched ' + auto + ' of ' + paths.length + ' file' + (paths.length === 1 ? '' : 's') + ' by name. Change any that are wrong.',
        body, [el('button.btn-ghost', { onclick: () => this._back() }, 'Cancel'), footBtn]);
      const card = document.querySelector('.modal-card.ws-step');
      if (card) card.classList.add('ws-match');
    },

    _addLink() {
      const m = this._mounted;
      const input = el('input.fld', { type: 'text', placeholder: 'https://frame.io/… or a Drive link', style: { width: '100%' } });
      const submit = () => {
        if (App.addTaskLink(m.epId, m.taskKey, input.value)) { this._back(); }
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
      App.modal.open(el('.modal-card.confirm-card', { onclick: e => e.stopPropagation() }, [
        el('.modal-head', null, [
          el('.modal-head-main', null, [
            App.icon('link', { cls: 'modal-ic' }),
            el('div', null, [
              el('.modal-title', null, 'Add a link'),
              el('.modal-subtitle', null, 'For assets that live somewhere else — Frame.io, Drive, Aspera')
            ])
          ]),
          el('button.modal-x', { onclick: () => this._back(), title: 'Close' }, '✕')
        ]),
        el('.modal-body', null, input),
        el('.modal-foot', null, [
          el('button.btn-ghost', { onclick: () => this._back() }, 'Cancel'),
          el('button.btn-primary', { onclick: submit }, 'Add link')
        ])
      ]));
      setTimeout(() => input.focus(), 40);
    }
  };
})();
