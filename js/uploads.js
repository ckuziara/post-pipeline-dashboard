/* Smart Upload — a per-subtask attachments tool shown inside the Edit Task
   dialog. Files (or whole folders) are dropped/browsed and external links are
   pasted; each is auto-categorised by type and stored with rich metadata so the
   library is searchable later (by task, uploader, type, show, department, date).
   This is a metadata catalogue: it records each file + a mock lucid:// location
   rather than uploading bytes (real transfer is the LucidLink Phase-2 job).
   Attachments live in the shared state: data.attachments["<epId>::<taskKey>"]. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  const CKEY = (epId, suKey) => epId + '::' + suKey;
  const nowIso = () => new Date().toISOString();
  function me() { const u = App.state.user; return { userId: u && u.personId, userName: (u && u.name) || 'You' }; }

  // extension → smart category (mirrors the studio's file taxonomy)
  const TYPES = {
    Video: ['mp4', 'mov', 'avi', 'mkv', 'prproj', 'mxf', 'r3d', 'braw', 'aep'],
    Audio: ['mp3', 'wav', 'aac', 'flac', 'ptx', 'aif', 'aiff', 'ptf'],
    Images: ['jpg', 'jpeg', 'png', 'gif', 'svg', 'psd', 'ai', 'tif', 'tiff', 'exr', 'webp'],
    Documents: ['pdf', 'doc', 'docx', 'txt', 'csv', 'xlsx', 'pptx', 'key', 'rtf']
  };
  const CAT_ORDER = ['Folders', 'Video', 'Audio', 'Images', 'Documents', 'External Links', 'Other'];
  const CAT_ICON = { Folders: '📁', Video: '🎬', Audio: '🎵', Images: '🖼️', Documents: '📄', 'External Links': '🔗', Other: '📦' };

  function categorize(ext) {
    for (const cat in TYPES) if (TYPES[cat].includes(ext)) return cat;
    return 'Other';
  }
  function fmtSize(bytes) {
    if (!bytes) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function linkName(url) {
    if (/drive\.google/i.test(url)) return 'Google Drive';
    if (/aspera/i.test(url)) return 'Aspera Package';
    if (/frame\.io/i.test(url)) return 'Frame.io Review';
    if (/dropbox/i.test(url)) return 'Dropbox';
    if (/wetransfer/i.test(url)) return 'WeTransfer';
    if (/youtu\.?be/i.test(url)) return 'YouTube';
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return 'Web Link'; }
  }

  App.uploads = {
    _inline: null,   // { box, epId, suKey }

    key: CKEY,
    list(epId, suKey) { const d = App.state.data; return (d.attachments && d.attachments[CKEY(epId, suKey)]) || []; },
    all() { const d = App.state.data; return d.attachments ? Object.values(d.attachments).flat() : []; },
    // rich-metadata search across the whole board (foundation for smart search)
    search(q) {
      q = String(q || '').toLowerCase().trim(); if (!q) return [];
      return this.all().filter(a => [a.name, a.taskName, a.epCode, a.showName, a.deptLabel, a.byName, a.category, a.ext]
        .some(v => String(v || '').toLowerCase().includes(q)));
    },

    // ---- metadata builders (the "know what/who/where" record) ----
    _context(ep, su) {
      const show = App.show(ep.showId);
      const u = me();
      return {
        epId: ep.id, epCode: ep.code, showId: ep.showId, showName: show.name,
        suKey: su.key, taskName: su.name, dept: su.dept, deptLabel: App.dept(su.dept).label,
        by: u.userId, byName: u.userName, at: nowIso()
      };
    },
    _fileMeta(ep, su, file) {
      const name = file.name;
      const ext = (name.indexOf('.') >= 0 ? name.split('.').pop() : '').toLowerCase();
      const folder = file.webkitRelativePath ? file.webkitRelativePath.split('/')[0] : null;
      const show = App.show(ep.showId);
      return Object.assign({
        id: App.uid(), name, ext, category: categorize(ext),
        size: file.size || 0, sizeLabel: fmtSize(file.size || 0),
        kind: folder ? 'folder-file' : 'file', folder: folder || null,
        link: 'lucid://' + (slug(show.prefix || show.name) || 'workspace') + '/' + ep.code + '/' + su.key + '/' + (folder ? folder + '/' : '') + name.replace(/\s+/g, '_')
      }, this._context(ep, su));
    },
    // a whole folder kept as ONE attachment (not unpacked into its files)
    _folderMeta(ep, su, fo) {
      const show = App.show(ep.showId);
      return Object.assign({
        id: App.uid(), name: fo.name, ext: '', category: 'Folders',
        size: fo.size || 0, sizeLabel: fmtSize(fo.size || 0), fileCount: fo.fileCount || 0,
        kind: 'folder', folder: fo.name,
        link: 'lucid://' + (slug(show.prefix || show.name) || 'workspace') + '/' + ep.code + '/' + su.key + '/' + fo.name.replace(/\s+/g, '_') + '/'
      }, this._context(ep, su));
    },
    _linkMeta(ep, su, url) {
      return Object.assign({
        id: App.uid(), name: linkName(url), ext: '', category: 'External Links',
        size: 0, sizeLabel: '', kind: 'link', folder: null, link: url
      }, this._context(ep, su));
    },

    // ---- mutations ----
    addFiles(epId, suKey, fileList) {
      const ep = App.state.data.episodes.find(e => e.id === epId); if (!ep) return;
      const su = App.subitem(ep, suKey); if (!su) return;
      if (!App.canEditTask(App.state.role, su)) { App.toast('You can’t add files to this task', true); return; }
      const metas = Array.from(fileList).map(f => this._fileMeta(ep, su, f));
      let added = 0;
      App.mutate(d => {
        d.attachments = d.attachments || {};
        const arr = d.attachments[CKEY(epId, suKey)] = d.attachments[CKEY(epId, suKey)] || [];
        metas.forEach(m => { if (!arr.some(a => a.name === m.name && a.folder === m.folder)) { arr.push(m); added++; } });
      });
      App.toast(added ? added + ' file' + (added === 1 ? '' : 's') + ' attached' : 'Already attached', !added);
      this._refresh();
    },
    // whole-folder upload (from the "Choose folder" input): each top-level
    // folder is kept as ONE attachment, not unpacked into its files
    addFolder(epId, suKey, fileList) {
      const groups = {};
      Array.from(fileList).forEach(f => {
        const top = (f.webkitRelativePath || '').split('/')[0] || f.name || 'Folder';
        const g = groups[top] = groups[top] || { name: top, fileCount: 0, size: 0 };
        g.fileCount++; g.size += f.size || 0;
      });
      this._addFolders(epId, suKey, Object.values(groups));
    },
    _addFolders(epId, suKey, folders) {
      if (!folders.length) return;
      const ep = App.state.data.episodes.find(e => e.id === epId); if (!ep) return;
      const su = App.subitem(ep, suKey); if (!su) return;
      if (!App.canEditTask(App.state.role, su)) { App.toast('You can’t add folders to this task', true); return; }
      const metas = folders.map(fo => this._folderMeta(ep, su, fo));
      let added = 0;
      App.mutate(d => {
        d.attachments = d.attachments || {};
        const arr = d.attachments[CKEY(epId, suKey)] = d.attachments[CKEY(epId, suKey)] || [];
        metas.forEach(m => { if (!arr.some(a => a.kind === 'folder' && a.name === m.name)) { arr.push(m); added++; } });
      });
      App.toast(added ? added + ' folder' + (added === 1 ? '' : 's') + ' attached (kept intact)' : 'Already attached', !added);
      this._refresh();
    },

    // drag-and-drop: dropped directories become folder attachments, loose files
    // become file attachments. Uses the FileSystem entry API to recurse for a
    // folder's file count + total size without unpacking it into the catalogue.
    handleDrop(epId, suKey, dt) {
      const entries = [];
      if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
        for (const it of dt.items) { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (en) entries.push(en); }
      }
      if (!entries.length) { if (dt.files && dt.files.length) this.addFiles(epId, suKey, dt.files); return; }
      const files = [], folderJobs = [];
      entries.forEach(en => {
        if (en.isDirectory) folderJobs.push(this._readDir(en).then(r => ({ name: en.name, fileCount: r.count, size: r.size })));
        else if (en.isFile) folderJobs.push(new Promise(res => en.file(f => { files.push(f); res(null); }, () => res(null))));
      });
      Promise.all(folderJobs).then(results => {
        const folders = results.filter(Boolean);
        if (files.length) this.addFiles(epId, suKey, files);
        if (folders.length) this._addFolders(epId, suKey, folders);
      });
    },
    _readDir(dirEntry) {
      return new Promise(resolve => {
        let count = 0, size = 0, pending = 0, done = false;
        const reader = dirEntry.createReader();
        const finish = () => { if (done && pending === 0) resolve({ count, size }); };
        const readBatch = () => reader.readEntries(ents => {
          if (!ents.length) { done = true; finish(); return; }
          ents.forEach(en => {
            pending++;
            if (en.isFile) en.file(f => { count++; size += f.size || 0; pending--; finish(); }, () => { pending--; finish(); });
            else this._readDir(en).then(r => { count += r.count; size += r.size; pending--; finish(); });
          });
          readBatch();
        }, () => { done = true; finish(); });
        readBatch();
      });
    },
    addLink(epId, suKey, url) {
      url = String(url || '').trim(); if (!url) return;
      if (!/^https?:\/\//i.test(url) && !/^lucid:\/\//i.test(url)) url = 'https://' + url;
      const ep = App.state.data.episodes.find(e => e.id === epId); if (!ep) return;
      const su = App.subitem(ep, suKey); if (!su) return;
      if (!App.canEditTask(App.state.role, su)) { App.toast('You can’t add links to this task', true); return; }
      const m = this._linkMeta(ep, su, url);
      App.mutate(d => {
        d.attachments = d.attachments || {};
        (d.attachments[CKEY(epId, suKey)] = d.attachments[CKEY(epId, suKey)] || []).push(m);
      });
      App.toast('Link attached');
      this._refresh();
    },
    remove(epId, suKey, id) {
      App.mutate(d => {
        const k = CKEY(epId, suKey);
        if (d.attachments && d.attachments[k]) {
          d.attachments[k] = d.attachments[k].filter(a => a.id !== id);
          if (!d.attachments[k].length) delete d.attachments[k];
        }
      });
      this._refresh();
    },

    _refresh() {
      const ctx = this._inline; if (!ctx) return;
      if (!ctx.box.isConnected) { this._inline = null; return; }
      this._build(ctx.box, ctx.epId, ctx.suKey);
    },

    // ---- inline section for the Edit Task dialog ----
    inlineSection(epId, suKey) {
      const box = el('.su-uploads');
      this._inline = { box, epId, suKey };
      this._build(box, epId, suKey);
      return box;
    },

    _build(box, epId, suKey) {
      box.innerHTML = '';
      const ep = App.state.data.episodes.find(e => e.id === epId);
      const su = ep && App.subitem(ep, suKey); if (!su) return;
      const items = this.list(epId, suKey);
      const canEdit = App.canEditTask(App.state.role, su);

      box.appendChild(el('.su-head', null, [
        el('span.su-ic', null, '📎'),
        el('span.su-title', null, 'Attachments'),
        el('span.su-count', null, items.length ? String(items.length) : '')
      ]));

      if (canEdit) {
        // drop zone + browse buttons
        const fileInput = el('input', { type: 'file', multiple: 'true', style: { display: 'none' },
          onchange: (e) => { this.addFiles(epId, suKey, e.target.files); e.target.value = ''; } });
        const folderInput = el('input', { type: 'file', multiple: 'true', style: { display: 'none' },
          onchange: (e) => { this.addFolder(epId, suKey, e.target.files); e.target.value = ''; } });
        folderInput.setAttribute('webkitdirectory', 'true'); folderInput.setAttribute('directory', 'true');

        const drop = el('.su-drop', null, [
          el('.su-drop-ic', null, '⬆'),
          el('.su-drop-text', null, 'Drag files here, or'),
          el('.su-drop-btns', null, [
            el('button.su-btn', { onclick: () => fileInput.click() }, 'Choose files'),
            el('button.su-btn.ghost', { onclick: () => folderInput.click() }, 'Choose folder')
          ]),
          fileInput, folderInput
        ]);
        const dz = drop;
        ['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); }));
        ['dragleave', 'drop'].forEach(t => dz.addEventListener(t, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); }));
        dz.addEventListener('drop', (e) => { if (e.dataTransfer) this.handleDrop(epId, suKey, e.dataTransfer); });
        box.appendChild(dz);

        // external link row
        const linkIn = el('input.su-link-in', { type: 'text', placeholder: 'Paste an external link (Frame.io, Drive, Aspera…)',
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = linkIn.value; linkIn.value = ''; this.addLink(epId, suKey, v); } } });
        box.appendChild(el('.su-linkrow', null, [
          el('span.su-link-ic', null, '🔗'), linkIn,
          el('button.su-btn.ghost', { onclick: () => { const v = linkIn.value; linkIn.value = ''; this.addLink(epId, suKey, v); } }, 'Add')
        ]));
      }

      // categorised list
      if (!items.length) {
        box.appendChild(el('.su-empty', null, canEdit ? 'No files yet — drop something above.' : 'No files attached.'));
        return;
      }
      const byCat = {}; items.forEach(a => (byCat[a.category] = byCat[a.category] || []).push(a));
      CAT_ORDER.forEach(cat => {
        const list = byCat[cat]; if (!list || !list.length) return;
        const catEl = el('.su-cat', null, [
          el('.su-cat-head', null, [
            el('span.su-cat-ic', null, CAT_ICON[cat]),
            el('span.su-cat-name', null, cat),
            el('span.su-cat-count', null, String(list.length))
          ])
        ]);
        list.forEach(a => {
          const meta = [];
          if (a.kind === 'folder') meta.push((a.fileCount || 0) + ' file' + (a.fileCount === 1 ? '' : 's'));
          if (a.sizeLabel) meta.push(a.sizeLabel);
          meta.push(a.byName, App.fmtDate(a.at.slice(0, 10)));
          if (a.kind !== 'folder' && a.folder) meta.push('📁 ' + a.folder);
          catEl.appendChild(el('.su-file', { title: a.link }, [
            el('span.su-file-kind', null, a.kind === 'link' ? '🔗' : a.kind === 'folder' ? '📁' : '📄'),
            el('.su-file-main', null, [
              el('.su-file-name', null, a.name),
              el('.su-file-meta', null, meta.join('  ·  '))
            ]),
            canEdit ? el('button.su-file-x', { title: 'Remove', onclick: () => this.remove(epId, suKey, a.id) }, '✕') : null
          ]));
        });
        box.appendChild(catEl);
      });
    }
  };
})();
