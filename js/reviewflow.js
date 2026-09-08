/* The review hand-off — how a finished cut gets from the department that made
   it to the Director who signs it off, through Post Operations.

   Three desks, one chain:

     1. the department  uploads the cut into Review Uploads (a block in the
                        Edit Task dialog) and sets the task Ready for Review.
                        The upload is REQUIRED: "Ready for Review" with nothing
                        to review is the thing this exists to stop.
     2. Post Operations picks the task up from the Review Uploads widget on
                        their dashboard, watches what was uploaded, creates the
                        Frame.io review from it, pastes that URL back and hits
                        Send for Review.
     3. the Director    finds it on the Reviews tab (js/reviews.js) with the
                        Frame.io link already attached, and approves it or
                        spends a revision.

   Two pieces of state, both keyed "<epId>::<taskKey>":

     data.reviewUploads[k]  what the department put up — files, volume paths
                            and links. Metadata only, like js/uploads.js: this
                            records what and where, it doesn't move bytes.
     data.reviews[k]        where the review has got to. Written by step 2
                            (`state: 'sent'` + frameUrl) and step 3
                            (`state: 'under'`).

   The gap between steps 1 and 2 is the point of the whole thing: a task at
   Ready for Review has NOT reached the Director yet. It's sitting on Post
   Operations' desk, and it's visible there rather than nowhere. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const KEY = (epId, taskKey) => epId + '::' + taskKey;

  function fmtSize(bytes) {
    if (!bytes) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }
  function me() { const u = App.state.user; return { by: (u && u.personId) || null, byName: (u && u.name) || 'Someone' }; }
  const baseName = (p) => String(p).replace(/\/+$/, '').replace(/^.*\//, '');

  /* Same normalise-and-check as App.addTaskLink, kept here rather than shared
     because this one has to hand back the cleaned URL for the review record
     instead of just storing it. */
  function cleanUrl(raw) {
    let url = String(raw || '').trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch (e) { return null; }
    return url;
  }

  /* ------------------------------------------------------------- uploads */
  App.reviewUploads = {
    list(epId, taskKey) {
      const d = App.state.data;
      return (d.reviewUploads && d.reviewUploads[KEY(epId, taskKey)]) || [];
    },
    has(epId, taskKey) { return this.list(epId, taskKey).length > 0; },

    _add(epId, taskKey, items, label) {
      if (!items.length) return;
      App.mutate(d => {
        d.reviewUploads = d.reviewUploads || {};
        const k = KEY(epId, taskKey);
        (d.reviewUploads[k] = d.reviewUploads[k] || []).push(...items);
      }, label);
    },

    /* Dropped files. Metadata only — the name, size and who put it up — which
       is what Post Operations needs to find it and what the Director's link
       eventually points at. A dropped folder arrives as a bogus zero-byte
       entry, so it's turned away with the route that does work, exactly as
       Deliver does. */
    addFiles(epId, taskKey, fileList) {
      const files = Array.from(fileList || []);
      const real = files.filter(f => f.size > 0 || f.type);
      const u = me();
      const items = real.map(f => Object.assign({
        id: App.uid(), kind: 'file', name: f.name,
        size: f.size || 0, sizeLabel: fmtSize(f.size || 0),
        at: new Date().toISOString()
      }, u));
      this._add(epId, taskKey, items, 'review upload');
      if (items.length) App.toast(items.length + ' file' + (items.length === 1 ? '' : 's') + ' up for review');
      return items.length;
    },

    // something already on the mount, chosen through our own picker
    addPaths(epId, taskKey, paths) {
      const u = me();
      const items = (paths || []).map(p => Object.assign({
        id: App.uid(), kind: 'volume', name: baseName(p), path: p,
        at: new Date().toISOString()
      }, u));
      this._add(epId, taskKey, items, 'review upload');
      if (items.length) App.toast(items.length === 1 ? baseName(paths[0]) + ' up for review' : items.length + ' items up for review');
      return items.length;
    },

    addLink(epId, taskKey, raw) {
      const url = cleanUrl(raw);
      if (!url) { App.toast('That doesn’t look like a link', true); return false; }
      const u = me();
      this._add(epId, taskKey, [Object.assign({
        id: App.uid(), kind: 'link', name: url.replace(/^https?:\/\//, ''), url,
        at: new Date().toISOString()
      }, u)], 'review upload');
      App.toast('Link up for review');
      return true;
    },

    remove(epId, taskKey, id) {
      App.mutate(d => {
        const k = KEY(epId, taskKey);
        if (!d.reviewUploads || !d.reviewUploads[k]) return;
        d.reviewUploads[k] = d.reviewUploads[k].filter(a => a.id !== id);
        if (!d.reviewUploads[k].length) delete d.reviewUploads[k];
      }, 'removing a review upload');
    }
  };

  /* -------------------------------------------------------- review state */
  App.review = {
    get(epId, taskKey) {
      const d = App.state.data;
      return (d.reviews && d.reviews[KEY(epId, taskKey)]) || null;
    },
    // has Post Operations passed it to the Director yet?
    sent(epId, taskKey) { const r = this.get(epId, taskKey); return !!(r && r.frameUrl); },
    frameUrl(epId, taskKey) { const r = this.get(epId, taskKey); return (r && r.frameUrl) || null; },

    /* Step 2 → 3. The Frame.io URL is the payload: it's the whole reason the
       Director's row is clickable, so it's stored ON the review record rather
       than as one more attachment to go looking for. */
    send(epId, taskKey, raw) {
      const url = cleanUrl(raw);
      if (!url) { App.toast('Paste the Frame.io review link first', true); return false; }
      const u = me();
      App.mutate(d => {
        d.reviews = d.reviews || {};
        const k = KEY(epId, taskKey);
        d.reviews[k] = Object.assign({}, d.reviews[k], {
          state: 'sent', frameUrl: url, sentAt: new Date().toISOString(), sentBy: u.byName
        });
      }, 'Send for review');
      return true;
    },

    /* Claiming a review, from the Director's tab. No un-claim: the two ways
       out are in the same row — approve it, or spend a revision. */
    start(epId, taskKey) {
      App.mutate(d => {
        d.reviews = d.reviews || {};
        const k = KEY(epId, taskKey);
        d.reviews[k] = Object.assign({}, d.reviews[k], {
          state: 'under', at: new Date().toISOString(), by: me().by
        });
      }, 'Start review');
    },

    /* The gate on Ready for Review, checked by App.setStatus and
       App.applyTaskEdit. Returns a reason to refuse, or null to allow.

       Only manual moves are gated. A task whose status is DERIVED from its
       dates (see App.deriveStatuses) can reach Ready for Review on its own as
       time passes, and refusing that would just mean refusing the calendar —
       so Post Operations sees those too, with "nothing uploaded" said plainly
       instead. */
    denyReady(ep, su) {
      if (App.reviewUploads.has(ep.id, su.key)) return null;
      return 'Upload the cut to Review Uploads before setting ' + su.name + ' to Ready for Review';
    }
  };

  /* ------------------------------------------- the Edit Task dialog block */
  /* Deliberately the same shape as Deliver (js/workspace.js _deliver): a drop
     zone, the two buttons that work without a native file dialog, then what's
     already there. Uploading for review and delivering downstream are the same
     gesture at different moments, and they shouldn't need learning twice.

     Unlike Deliver this needs no mounted volume — it's board state, not files
     on disk — so the drop zone is there on any machine. */
  App.reviewFlow = {
    inlineSection(ep, su, d) {
      const wrap = el('.ws-block');
      const items = App.reviewUploads.list(ep.id, su.key);
      const sentUrl = App.review.frameUrl(ep.id, su.key);

      wrap.appendChild(el('.ws-head', null, [
        el('.modal-section-title', { style: { margin: '0' } }, [App.icon('target'), ' Review Uploads']),
        el('span.ws-path', null, items.length
          ? items.length + ' up for review'
          : 'nothing up for review')
      ]));

      const canEdit = App.canEditTask(App.state.role, su);
      const phone = App.isPhone();

      if (canEdit && !phone) {
        const drop = el('.ws-drop', null, [
          el('.ws-drop-main', null, [App.icon('upload'), '  Drop the cut here for review']),
          el('.ws-drop-sub', null, 'Post Operations picks it up from here, makes the Frame.io review and sends it to the Director')
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
          let dirs = 0;
          if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
            for (const it of dt.items) {
              const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
              if (en && en.isDirectory) dirs++;
            }
          }
          if (dirs) App.toast('Folders can’t be dropped in — use “Pick from the volume” for those', true);
          App.reviewUploads.addFiles(ep.id, su.key, dt.files);
        });
        /* Same reason as Deliver: never <input type="file">. A native file
           dialog crashes the embedded webview, and Finder is what this whole
           panel exists to avoid. */
        if (d && d.masterOk) drop.addEventListener('click', () => this._pickFromVolume(ep, su, d));
        wrap.appendChild(drop);

        wrap.appendChild(el('.ws-actions', null, [
          d && d.masterOk
            ? el('button.btn-ghost.ws-btn', { onclick: () => this._pickFromVolume(ep, su, d) }, [App.icon('archive'), ' Pick from the volume'])
            : null,
          el('button.btn-ghost.ws-btn', { onclick: () => this._addLink(ep, su) }, [App.icon('link'), ' Add a link'])
        ]));
      }

      if (items.length) {
        const list = el('.ws-list');
        items.forEach(a => list.appendChild(el('.ws-item.static', null, [
          App.icon(a.kind === 'link' ? 'link' : 'clapper', { cls: 'ws-ic' }),
          a.kind === 'link'
            ? el('a.ws-name', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.name)
            : el('span.ws-name', a.path ? { title: a.path } : null, a.name),
          el('span.ws-meta', null, [a.sizeLabel, a.byName].filter(Boolean).join(' · ')),
          (canEdit && !phone && !sentUrl)
            ? el('button.ws-x', { title: 'Remove', onclick: () => App.reviewUploads.remove(ep.id, su.key, a.id) }, '✕')
            : null
        ])));
        wrap.appendChild(el('.ws-delivered', null, [
          el('.ws-sub', null, ['Up for review · ', sentUrl
            ? el('span.ws-chip.ok', null, 'sent to the Director')
            : el('span.ws-chip.pending', null, su.status === 'review' ? 'with Post Operations' : 'not sent yet')]),
          list
        ]));
      }

      // What happens next, said once, in whichever of the three states this is
      wrap.appendChild(el('.ws-note.tight', null, sentUrl
        ? 'Sent for review — the Director has this on their Reviews tab.'
        : items.length
          ? (su.status === 'review'
            ? 'Post Operations will make the Frame.io review and send it to the Director.'
            : 'Set this task to Ready for Review to put it on Post Operations’ desk.')
          : 'Nothing here yet. A task can’t be set to Ready for Review until the cut is up.'));
      return wrap;
    },

    _pickFromVolume(ep, su, d) {
      const start = (d && d.absolute && d.absolute.work) || (d && d.root);
      App.folderPicker.open(start, (chosen) => {
        const items = Array.isArray(chosen) ? chosen : (chosen ? [chosen] : []);
        // the picker replaced the Edit Task dialog — put it back either way
        App.editTask.open(ep.id, su.key);
        if (items.length) App.reviewUploads.addPaths(ep.id, su.key, items);
      }, {
        pickFiles: true, multiple: true,
        title: 'Put a cut up for review',
        subtitle: 'Starts in this task’s working folder. Nothing is moved — this just tells ' +
          'Post Operations which file to make the review from.',
        confirmLabel: 'Put up for review',
        onCancel: () => App.editTask.open(ep.id, su.key)
      });
    },

    _addLink(ep, su) {
      const input = el('input.fld', { type: 'text', placeholder: 'https://…', style: { width: '100%' } });
      const back = () => App.editTask.open(ep.id, su.key);
      const submit = () => { if (App.reviewUploads.addLink(ep.id, su.key, input.value)) back(); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
      App.modal.open(el('.modal-card.confirm-card', { onclick: e => e.stopPropagation() }, [
        el('.modal-head', null, [
          el('.modal-head-main', null, [
            App.icon('link', { cls: 'modal-ic' }),
            el('div', null, [
              el('.modal-title', null, 'Add a link for review'),
              el('.modal-subtitle', null, 'For a cut that already lives somewhere else — Drive, Aspera, a screener')
            ])
          ]),
          el('button.modal-x', { onclick: back, title: 'Close' }, '✕')
        ]),
        el('.modal-body', null, input),
        el('.modal-foot', null, [
          el('button.btn-ghost', { onclick: back }, 'Cancel'),
          el('button.btn-primary', { onclick: submit }, 'Add')
        ])
      ]));
      setTimeout(() => input.focus(), 40);
    },

    /* ------------------------------------- Post Operations' dashboard widget */
    /* Everything at Ready for Review that hasn't been passed on yet. This is a
       queue of work for the coordinator, so it empties as they clear it —
       sending one takes it off this list and puts it on the Director's. */
    pending(m) {
      const out = [];
      m.subs.forEach(x => {
        if (x.su.status !== 'review') return;
        if (App.review.sent(x.ep.id, x.su.key)) return;
        out.push(x);
      });
      return out.sort((a, b) => (a.su.due < b.su.due ? -1 : a.su.due > b.su.due ? 1 : 0));
    },

    widget(m, tile, cap) {
      const items = this.pending(m);
      if (!items.length) {
        return el('.dw-calm', null, 'Nothing waiting to be sent for review.');
      }
      const list = el('.risk-list');
      items.slice(0, cap).forEach(x => {
        const show = App.show(x.ep.showId), dep = App.dept(x.su.dept);
        const n = App.reviewUploads.list(x.ep.id, x.su.key).length;
        list.appendChild(el('.risk-item', {
          title: x.ep.code + ' · ' + x.ep.title + ' — ' + x.su.name,
          onclick: () => this.sendDialog(x.ep, x.su)
        }, [
          el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color), fontSize: '10px', padding: '2px 7px' } }, x.ep.code),
          el('.ri-main', null, [
            el('.ri-title', null, x.su.name),
            el('.ri-sub', null, [
              el('span.dept-chip', { style: { padding: '1px 7px', fontSize: '10px', marginRight: '8px' } },
                [el('span.dot', { style: { background: dep.color } }), dep.label]),
              n ? n + ' upload' + (n === 1 ? '' : 's') : 'nothing uploaded'
            ])
          ]),
          el('span.ri-tag', { style: { background: 'rgba(91,108,255,.16)', color: '#b3bcff' } }, 'Send →')
        ]));
      });
      if (items.length > cap) list.appendChild(el('.pr-more', null, '+' + (items.length - cap) + ' more'));
      return list;
    },

    /* Step 2 itself: what was uploaded, and the one field that moves it on.
       Purposely a modal rather than an expanding row — the coordinator is
       reading file names and pasting a URL, which needs more room than a
       dashboard tile has. */
    sendDialog(ep, su) {
      const items = App.reviewUploads.list(ep.id, su.key);
      const show = App.show(ep.showId);

      const assets = el('.ws-list');
      if (items.length) {
        items.forEach(a => assets.appendChild(el('.ws-item.static', null, [
          App.icon(a.kind === 'link' ? 'link' : 'clapper', { cls: 'ws-ic' }),
          a.kind === 'link'
            ? el('a.ws-name', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.name)
            : el('span.ws-name', a.path ? { title: a.path } : null, a.name),
          el('span.ws-meta', null, [a.sizeLabel, a.byName].filter(Boolean).join(' · '))
        ])));
      }

      const input = el('input.fld', { type: 'text', placeholder: 'https://frame.io/…', style: { width: '100%' } });
      const send = () => {
        if (!App.review.send(ep.id, su.key, input.value)) { input.focus(); return; }
        App.modal.close();
        App.toast(su.name + ' sent to the Director');
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });

      App.modal.open(el('.modal-card.confirm-card', { onclick: e => e.stopPropagation() }, [
        el('.modal-head', null, [
          el('.modal-head-main', null, [
            App.icon('target', { cls: 'modal-ic' }),
            el('div', null, [
              el('.modal-title', null, 'Send for review'),
              el('.modal-subtitle', null, su.name + ' · ' + ep.code + ' ' + ep.title + ' · ' + show.name)
            ])
          ]),
          el('button.modal-x', { onclick: () => App.modal.close(), title: 'Close' }, '✕')
        ]),
        el('.modal-body', null, [
          el('.modal-section-title', null, [App.icon('clapper'), ' Uploaded for review']),
          items.length ? assets : el('.ws-note', null,
            'Nothing was uploaded for this task — its status came from its dates rather than from someone putting a cut up. Chase the department, or send a link you have anyway.'),
          el('.modal-section-title', { style: { marginTop: '16px' } }, [App.icon('link'), ' Frame.io Link']),
          input,
          el('.fld-hint', null, 'Make the Frame.io review from the file above, then paste its URL here. This is the link the Director clicks.')
        ]),
        el('.modal-foot', null, [
          el('button.btn-ghost', { onclick: () => App.modal.close() }, 'Cancel'),
          el('button.btn-primary', { onclick: send }, 'Send for Review')
        ])
      ]));
      setTimeout(() => input.focus(), 40);
    }
  };
})();
