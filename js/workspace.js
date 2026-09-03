/* Per-subtask workspace — the panel inside the Edit Task dialog.

   The point is that nobody should ever need Finder or Explorer:
     • Project   — create the working project from a show template, or open the
                   existing one / its folder natively.
     • Assets    — only what THIS task needs: each dependency's published files,
                   folders and links, labelled by source. A dependency that
                   hasn't published anything shows as Pending.
     • Deliver   — drop files in, or pick something already on the mount, or add
                   a URL. The server files them into the task's !!_Publish folder,
                   which is what dependent tasks then see as their assets.

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
  App.deptSoftware = (dept) => (DEPT_SOFTWARE[dept] || []).map(k => Object.assign({ key: k }, SOFTWARE[k]));

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

  App.workspace = {
    _mounted: null,   // { box, epId, taskKey } — the panel currently in a dialog

    /* Mounted into the Edit Task dialog. Renders a placeholder immediately and
       fills in once the server has listed the folders. */
    inlineSection(epId, taskKey) {
      const box = el('.ws');
      this._mounted = { box, epId, taskKey, data: null, busy: false };
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

      if (!App.isPhone()) box.appendChild(this._project(ep, su, m.data));
      box.appendChild(this._assets(ep, su, m.data));
      box.appendChild(this._deliver(ep, su, m.data));
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
        return el('.ws-note.ws-mode', null, [App.icon('plug'), ' ' + c.describe()]);
      }
      /* Only worth suggesting from a page that ISN'T the local server
         already — being told to "run it locally" while running locally is
         just confusing, and there the missing piece is the volume itself,
         which masterError already names in each block. */
      if (!d.masterOk && c.wanted()) {
        return el('.ws-note.ws-mode', null, [
          App.icon('plug'),
          ' Running Post Pipeline on the machine that has the volume mounted lets this page use it for files.'
        ]);
      }
      return null;
    },

    /* ---------------------------------------------------------- project ---- */
    _project(ep, su, d) {
      const wrap = el('.ws-block');
      wrap.appendChild(el('.ws-head', null, [
        el('.modal-section-title', { style: { margin: '0' } }, [App.icon('mixer'), ' Project']),
        el('span.ws-path', d.masterOk ? { title: d.absolute.work } : null, d.deliverable + '/')
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
        actions.appendChild(el('button.btn-ghost.ws-btn', {
          onclick: () => this._createProject(d)
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
        // Animation is N/A — no templated software, so just prepare the folder
        return this._step('mixer', 'Create project', deptLabel + ' has no templated software configured.',
          el('.ws-note', null, deptLabel + ' work isn’t template-driven, so there’s nothing to copy. ' +
            'Post Pipeline can still create and open the working folder for you.'),
          [
            el('button.btn-ghost', { onclick: () => this._back() }, 'Cancel'),
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

      this._step('mixer', 'Create project', 'Which application? — ' + deptLabel + ' · ' + d.deliverable, list, [
        el('button.btn-ghost', { onclick: () => this._back() }, 'Cancel'),
        el('button.btn-ghost', { onclick: () => this._makeProject(null) }, 'Just make the folder')
      ]);
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
            title: f.path,
            onclick: () => this._openDep(dep, f.name)
          }, [
            App.icon(iconFor(f.name, f.dir), { cls: 'ws-ic' }),
            el('span.ws-name', null, f.name),
            el('span.ws-meta', null, f.dir ? 'folder' : fmtSize(f.size)),
            el('span.ws-go', null, '↗')
          ])));
          links.forEach(l => list.appendChild(el('a.ws-item', {
            href: l.url, target: '_blank', rel: 'noopener noreferrer', title: l.url
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
      wrap.appendChild(el('.ws-head', null, [
        el('.modal-section-title', { style: { margin: '0' } }, [App.icon('upload'), ' Deliver']),
        el('span.ws-path', d.masterOk ? { title: d.absolute.mezzanine } : null, '!!_Mezzanine/' + d.deliverable + '/')
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
      if (!phone && d.masterOk) {
        const status = el('.ws-progress');
        const drop = el('.ws-drop', null, [
          el('.ws-drop-main', null, [App.icon('upload'), '  Drop files here to deliver']),
          el('.ws-drop-sub', null, 'or click to browse the volume — held in !!_Mezzanine/' +
            d.deliverable + ' until this task is approved')
        ]);

        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
          e.preventDefault(); e.stopPropagation(); drop.classList.add('over');
        }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
          e.preventDefault(); e.stopPropagation(); if (ev === 'dragleave') drop.classList.remove('over');
        }));
        drop.addEventListener('drop', e => {
          drop.classList.remove('over');
          const files = e.dataTransfer && e.dataTransfer.files;
          if (files && files.length) this._upload([...files], status);
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
      if (mezz.length || links.length) {
        const list = el('.ws-list');
        mezz.forEach(f => list.appendChild(fileRow(f, 'mezzanine')));
        links.forEach(l => list.appendChild(el('.ws-item.static', null, [
          App.icon('link', { cls: 'ws-ic' }),
          el('a.ws-name', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.url.replace(/^https?:\/\//, '')),
          el('span.ws-meta', null, l.by),
          // removing is a mutation, not a view — stays off phone with the
          // rest of this section's editing actions
          phone ? null : el('button.ws-x', { title: 'Remove link', onclick: () => { App.removeTaskLink(ep.id, su.key, l.id); this._render(); } }, '✕')
        ])));
        wrap.appendChild(el('.ws-delivered', null, [
          el('.ws-sub', null, [
            'Delivered · ',
            su.status === 'approved'
              ? el('span.ws-chip.ok', null, 'approved')
              : el('span.ws-chip.pending', null, 'awaiting approval')
          ]),
          list,
          su.status === 'approved' ? null : el('.ws-note.tight', null,
            'These stay out of the next department’s Assets until ' + su.name + ' is approved.')
        ]));
      }

      // already approved and published — what downstream tasks can actually see
      const publish = d.publish || [];
      if (publish.length) {
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
    async _upload(files, statusBox) {
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
          const r = await App.api.deliverUpload(token, f);
          done++;
          if (r.filed !== f.name) App.toast('Filed as ' + r.filed + ' (a file of that name was already there)');
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

    _pickFromMount() {
      const m = this._mounted;
      const epId = m.epId, taskKey = m.taskKey;
      const ep = App.state.data.episodes.find(e => e.id === epId);
      // Open where the exports actually are — the task's own working folder —
      // rather than the show root, mirroring Project → Open folder.
      const start = (m.data && m.data.absolute && m.data.absolute.work) || (m.data && m.data.root);
      App.folderPicker.open(start, (chosen) => {
        if (!chosen) return this._back();
        App.toast('Moving ' + chosen.replace(/^.*\//, '') + ' into place…');
        // the picker replaced the Edit Task dialog — put it back so the delivery
        // shows up where the user started, then refresh it with the result
        App.editTask.open(epId, taskKey);
        App.api.deliverPrepare({ epId, taskKey, pipeline: App.pipelineFor(ep), src: chosen })
          .then(r => {
            App.toast(r.moved
              ? 'Delivered ' + r.filed + ' — moved out of ' + (m.data ? m.data.deliverable : 'the working folder')
              : 'Delivered ' + r.filed + (r.fromLibrary ? ' — copied, so the library keeps its original' : ''));
            this.reload();
          })
          .catch(e => App.toast(e.message, true));
      }, {
        pickFiles: true,
        title: 'Deliver a file',
        subtitle: 'Starts in this task’s working folder. The file is moved into ' +
          (m.data ? '!!_Publish/' + m.data.deliverable : 'the delivery folder') + '.',
        confirmLabel: 'Move & deliver',
        onCancel: () => this._back()
      });
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
