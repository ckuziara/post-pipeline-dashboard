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
                            and links. With the volume connected a cut is a
                            real file: it goes into !!_Mezzanine under its
                            versioned name (like any delivery), and a copy of
                            that version into !!_Reviews/<Deliverable>/, which
                            is the path recorded here and what Post Operations
                            opens. Without the volume, a cut goes up as a link.
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
    if (!url || /\s/.test(url)) return null;          // a sentence isn't a link, even if URL() lets it through
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    let host;
    try { host = new URL(url).hostname; } catch (e) { return null; }
    // a real address has a domain (vimeo.com, f.io) — or is this machine
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && host !== 'localhost') return null;
    return url;
  }


  /* A link reads as where it goes — "Frame.io Link" — not as a URL. The
     address itself is one hover (tooltip) or right-click (copy) away. */
  const HOSTS = [
    [/(^|\.)(f\.io|frame\.io)$/, 'Frame.io'], [/(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$/, 'Google Drive'],
    [/(^|\.)dropbox\.com$/, 'Dropbox'], [/(^|\.)box\.com$/, 'Box'], [/(^|\.)vimeo\.com$/, 'Vimeo'],
    [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'], [/(^|\.)(wetransfer\.com|we\.tl)$/, 'WeTransfer'],
    [/(^|\.)ibmaspera\.com$|(^|\.)asperafiles\.com$/, 'Aspera'], [/(^|\.)sharepoint\.com$/, 'SharePoint']
  ];
  App.reviewLinkLabel = function (url) {
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return 'Link'; }
    const known = HOSTS.find(([re]) => re.test(host));
    const name = known ? known[1] : host.charAt(0).toUpperCase() + host.slice(1);
    return name + ' Link';
  };

  /* ------------------------------------------------------------- uploads */
  App.reviewUploads = {
    list(epId, taskKey) {
      const d = App.state.data;
      return (d.reviewUploads && d.reviewUploads[KEY(epId, taskKey)]) || [];
    },
    has(epId, taskKey) { return this.list(epId, taskKey).length > 0; },
    /* What's been put up since the Director last sent feedback — the cut for
       the round in hand. Before any feedback, every upload counts. */
    fresh(epId, taskKey) {
      const since = App.review && App.review.feedbackAt(epId, taskKey);
      const all = this.list(epId, taskKey);
      return since ? all.filter(a => a.at && a.at > since) : all;
    },

    _add(epId, taskKey, items, label) {
      if (!items.length) return;
      App.mutate(d => {
        d.reviewUploads = d.reviewUploads || {};
        const k = KEY(epId, taskKey);
        (d.reviewUploads[k] = d.reviewUploads[k] || []).push(...items);
      }, label);
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

    /* A version in Mezzanine, copied into !!_Reviews and put up (server.js
       /api/task/review-copy). Returns the item, or null on failure. */
    async fromMezzanine(ep, su, file) {
      const r = await App.api.reviewCopy({ epId: ep.id, taskKey: su.key, pipeline: App.pipelineFor(ep), file });
      if (this.list(ep.id, su.key).some(a => a.path === r.path)) { App.toast(r.name + ' is already up for review'); return null; }
      const item = Object.assign({ id: App.uid(), kind: 'volume', name: r.name, path: r.path,
        size: r.size || 0, sizeLabel: fmtSize(r.size || 0), at: new Date().toISOString() }, me());
      this._add(ep.id, su.key, [item], 'review upload');
      return item;
    },

    /* Files picked from the volume: delivered into Mezzanine first — named
       and versioned like every other export — then that version put up. */
    async putUp(ep, su, { srcs }) {
      const P = App.pipelineFor(ep);
      const filed = [];
      try {
        for (const src of (srcs || [])) filed.push((await App.api.deliverPrepare({ epId: ep.id, taskKey: su.key, pipeline: P, src })).filed);
        let n = 0;
        for (const name of filed) if (await this.fromMezzanine(ep, su, name)) n++;
        if (n) App.toast(n === 1 ? filed[filed.length - 1] + ' up for review' : n + ' versions up for review');
      } catch (e) {
        App.toast(e.message, true);
      }
      App.workspace && App.workspace.reload && App.workspace.reload();
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
    feedbackAt(epId, taskKey) { const r = this.get(epId, taskKey); return (r && r.feedbackAt) || null; },

    /* Send Feedback ends a round (App.requestRevision calls this inside its
       mutate, with the draft). The sent link moves into `rounds` and the
       record goes back to unsent, so the next cut goes through the same
       desks as the first: the department uploads it and sends it, Post
       Operations sends the new link, the Director reviews it. `feedbackAt`
       is what tells the new cut from the old one (App.reviewUploads.fresh). */
    closeRound(d, epId, taskKey, version) {
      const k = KEY(epId, taskKey);
      const old = (d.reviews && d.reviews[k]) || {};
      const at = new Date().toISOString();
      const round = { version, frameUrl: old.frameUrl || null, sentAt: old.sentAt || null, sentBy: old.sentBy || null, feedbackAt: at };
      d.reviews = d.reviews || {};
      d.reviews[k] = { rounds: (old.rounds || []).concat([round]), feedbackAt: at };
    },

    /* Step 2 → 3. The Frame.io URL is the payload: it's the whole reason the
       Director's row is clickable, so it's stored ON the review record rather
       than as one more attachment to go looking for. */
    send(epId, taskKey, raw) {
      const url = cleanUrl(raw);
      if (!url) { App.toast('Paste the review link first', true); return false; }
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

    /* Pin a review to the day it'll be watched, from the Director's Priority
       calendar (drag a chip onto a day), or unpin it with null. Stored on the
       review record, so everyone sees the same plan; the calendar's planner
       (App.reviews.open) places pinned reviews first and plans the rest
       around them. */
    canPin(role) { return App.canSeeReviewQueue(role) || App.canPrioritiseReviews(role); },
    pin(epId, taskKey, iso) {
      if (!this.canPin(App.state.role)) { App.toast('Only the Director or a Producer can plan reviews', true); return; }
      App.mutate(d => {
        d.reviews = d.reviews || {};
        const k = KEY(epId, taskKey);
        const next = Object.assign({}, d.reviews[k]);
        if (iso) next.planDate = iso; else delete next.planDate;
        d.reviews[k] = next;
      }, iso ? 'Plan review' : 'Unpin review');
    },

    /* Swapping the link on a review that's already been sent — a re-upload, a
       new share link, a typo. Only the link changes: where the review has got
       to (sent, under review) and when it was sent stay as they were, so the
       Director's queue doesn't treat it as new. */
    setLink(epId, taskKey, raw) {
      const url = cleanUrl(raw);
      if (!url) { App.toast('That doesn’t look like a link', true); return false; }
      if (!this.sent(epId, taskKey)) return this.send(epId, taskKey, url);
      if (url === this.frameUrl(epId, taskKey)) return true;
      const u = me();
      App.mutate(d => {
        const k = KEY(epId, taskKey);
        d.reviews[k] = Object.assign({}, d.reviews[k], {
          frameUrl: url, linkChangedAt: new Date().toISOString(), linkChangedBy: u.byName
        });
      }, 'Change review link');
      App.toast('Review link updated');
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
      if (App.reviewUploads.fresh(ep.id, su.key).length) return null;
      if (this.feedbackAt(ep.id, su.key)) return 'Put the revised cut up in Review Uploads before sending ' + su.name + ' back for review';
      return 'Put the cut up in Review Uploads before setting ' + su.name + ' to ' + App.status('review').label;
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
        /* Pick-only, like Deliverables: the cut is chosen from the volume —
           never dragged in, and never a native file dialog (it crashes the
           embedded webview) — and filed in Mezzanine + Reviews; a link is the
           other way. Pick is the main action until this round's cut is up. */
        const upNow = App.reviewUploads.fresh(ep.id, su.key).length > 0;
        wrap.appendChild(el('.ws-actions', null, [
          d && d.masterOk
            ? el('button.ws-btn' + (upNow ? '.btn-ghost' : '.btn-primary'), { onclick: () => this._pickFromVolume(ep, su, d) }, [App.icon('archive'), ' Pick from the volume'])
            : null,
          el('button.btn-ghost.ws-btn', { onclick: () => this._addLink(ep, su) }, [App.icon('link'), ' Add a link'])
        ]));
        /* Already delivered into Mezzanine? Put that version up
           as it is — the usual way, once renders land in the right place. */
        const ready = ((d && d.outputs) || []).filter(o => o.latest && !items.some(a => a.name === o.latest));
        if (ready.length) {
          wrap.appendChild(el('.ws-actions', null, ready.map(o => el('button.btn-ghost.ws-btn', {
            title: 'Copy ' + o.latest + ' into Reviews and put it up',
            onclick: () => App.reviewUploads.fromMezzanine(ep, su, o.latest)
              .then(it => { if (it) App.toast(it.name + ' up for review'); })
              .catch(e => App.toast(e.message, true))
          }, [App.icon('target'), ' Put up v' + String(o.version).padStart(3, '0') + ' · ' + o.suffix + (o.type ? ' ' + o.type : '')]))));
        }
      }

      // after Send Feedback, only what's gone up since counts as the cut to send
      const fresh = App.reviewUploads.fresh(ep.id, su.key);
      const feedbackAt = App.review.feedbackAt(ep.id, su.key);
      const nextV = 'V' + (App.revisionsUsed(ep, su.key) + 1);
      if (items.length) {
        const list = el('.ws-list');
        items.forEach(a => list.appendChild(el('.ws-item.static', null, [
          App.icon(a.kind === 'link' ? 'link' : 'clapper', { cls: 'ws-ic' }),
          a.kind === 'link'
            ? el('a.ws-name', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.name)
            : el('span.ws-name', null, a.name),
          el('span.ws-meta', null, [a.sizeLabel, a.byName, fresh.includes(a) ? '' : 'earlier cut'].filter(Boolean).join(' · ')),
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

      /* The review link itself, once Post Operations has sent it — the same
         link the Director opens, named by where it lives ("Frame.io Link"). */
      if (sentUrl) {
        const rev = App.review.get(ep.id, su.key) || {};
        wrap.appendChild(el('.ws-delivered', null, [
          el('.ws-sub', null, 'Review link'),
          el('.ws-list', null, el('.ws-item.static', null, [
            App.icon('link', { cls: 'ws-ic' }),
            el('a.ws-name', { href: sentUrl, target: '_blank', rel: 'noopener noreferrer' }, App.reviewLinkLabel(sentUrl)),
            el('span.ws-meta', null, rev.sentBy ? 'sent by ' + rev.sentBy : '')
          ]))
        ]));
      }

      /* Send for Review: once the cut is up, the department sends it on
         here — the task goes to Ready for Review (App.setStatus, which still
         checks there's an upload) and lands on Post Operations' desk. */
      const canSend = canEdit && !phone && fresh.length && !sentUrl && !App.isApproved(su.status) && su.status !== 'review';
      if (canSend) {
        wrap.appendChild(el('.ws-actions', null, el('button.btn-primary.ws-btn', {
          onclick: (e) => App.sendPulse(e.currentTarget, () => { App.setStatus(ep.id, su.key, 'review'); App.workspace && App.workspace.reload && App.workspace.reload(); })
        }, [App.icon('target'), ' Send for Review'])));
      }

      // What happens next, said once, in whichever of the three states this is
      wrap.appendChild(el('.ws-note.tight', null, sentUrl
        ? 'Sent for review — the Director has this on their Reviews tab.'
        : feedbackAt && !fresh.length && su.status !== 'review'
          ? 'The Director sent feedback — pick the revised cut (' + nextV + '), then Send for Review again.'
        : fresh.length
          ? (su.status === 'review'
            ? 'Sent — Post Operations will set up the review and send it to the Director.'
            : 'Send it for review when it’s ready — it goes to ' + App.status('review').label + ' and onto Post Operations’ desk.')
          : 'Nothing here yet. A task can’t be sent for review until the cut is up.'));
      return wrap;
    },

    /* Reviews that are over, kept short: each cut that went up (with when),
       the review link, and how it ended. Shown once the task is past review. */
    compactSection(ep, su) {
      const items = App.reviewUploads.list(ep.id, su.key);
      const link = App.review.frameUrl(ep.id, su.key);
      if (!items.length && !link) return null;
      const used = App.revisionsUsed(ep, su.key);
      const rows = items.map(a => el('.ws-hist-row', null, [
        App.icon(a.kind === 'link' ? 'link' : 'clapper', { cls: 'ws-ic' }),
        a.kind === 'link' ? el('a.ws-name', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.name) : el('span.ws-name', null, a.name),
        el('span.ws-meta', null, a.at ? App.fmtDate(String(a.at).slice(0, 10)) : '')
      ]));
      if (link) rows.push(el('.ws-hist-row', null, [
        App.icon('target', { cls: 'ws-ic' }),
        el('a.ws-name', { href: link, target: '_blank', rel: 'noopener noreferrer' }, App.reviewLinkLabel(link)),
        el('span.ws-meta', null, 'review link')
      ]));
      return el('.ws-block.ws-compact', null, [
        el('.ws-head', null, [
          el('.modal-section-title', { style: { margin: '0' } }, [App.icon('target'), ' Reviews']),
          el('span.ws-chip.ok', null, 'Approved' + (used ? ' · after ' + used + ' revision' + (used === 1 ? '' : 's') : ''))
        ]),
        el('.ws-hist', null, rows)
      ]);
    },

    _pickFromVolume(ep, su, d) {
      const start = (d && d.absolute && d.absolute.work) || (d && d.root);
      App.folderPicker.open(start, (chosen) => {
        const items = Array.isArray(chosen) ? chosen : (chosen ? [chosen] : []);
        // the picker replaced the Edit Task dialog — put it back either way
        App.editTask.open(ep.id, su.key);
        if (!items.length) return;
        if (d && d.outputs) App.reviewUploads.putUp(ep, su, { srcs: items });
        else App.reviewUploads.addPaths(ep.id, su.key, items);
      }, {
        pickFiles: true, multiple: true,
        title: 'Put a cut up for review',
        subtitle: d && d.outputs
          ? 'Starts in this task’s working folder. Each is copied into Mezzanine as the next version and into Reviews for Post Operations — the original stays put.'
          : 'Starts in this task’s working folder. Nothing is moved — this just tells Post Operations which file to make the review from.',
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

    /* `path` null means the task's own folder, which is the only sensible
       target for a dropped file: the browser handed us a name and a size and
       nothing about where it came from. A server that isn't on this machine
       can't open anything, so it hands back the path instead of failing
       silently — same contract as workspace.js's _open. */
    _revealPath(ep, su, absPath) {
      /* reveal takes only the path — it resolves against the master directory
         rather than against a task's folders, so it needs no episode, task or
         pipeline. taskOpen does, because "the work folder" is a question about
         this task. */
      const call = absPath
        ? App.api.taskReveal({ path: absPath })
        : App.api.taskOpen({ epId: ep.id, taskKey: su.key, pipeline: App.pipelineFor(ep), which: 'work' });
      call
        .then(r => { if (!r.opened) App.toast('The server isn’t on this machine — path: ' + r.path); })
        .catch(e => App.toast(e.message, true));
    },

    /* ------------------------------------- Post Operations' dashboard widget */
    /* Post Operations' desk takes reviews from EVERY department, but their
       role opens with the department filter on Ops (and m.subs honours it),
       which would leave the desk empty. So the review widgets read each
       episode in view whole — the show filter still applies, the department
       and owner filters don't. */
    allSubs(m) {
      const out = [];
      m.episodes.forEach(ep => App.subitems(ep).forEach(su => out.push({ ep, su })));
      return out;
    },

    /* Everything at Ready for Review that hasn't been passed on yet. This is a
       queue of work for the coordinator, so it empties as they clear it —
       sending one takes it off this list and puts it on the Director's. */
    pending(m) {
      const out = [];
      this.allSubs(m).forEach(x => {
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

      /* Making the Frame.io review means getting at the actual file, which
         means a folder open in Finder. Doing that by hand — from a path
         printed in a tooltip — is the one step this whole panel exists to
         avoid, so each row that points at something real on the volume opens
         the folder it sits in, and the section header opens the task's own
         folder for everything else (a dropped file, or nothing uploaded at
         all: the browser only ever gave us a name, and the task folder is
         the honest answer to "where would it be"). */
      const assets = el('.ws-list');
      if (items.length) {
        items.forEach(a => {
          const row = a.path
            ? el('button.ws-item', {
                title: 'Open the folder this sits in',
                onclick: () => this._revealPath(ep, su, a.path)
              })
            : el('.ws-item.static');
          [
            App.icon(a.kind === 'link' ? 'link' : 'clapper', { cls: 'ws-ic' }),
            a.kind === 'link'
              ? el('a.ws-name', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.name)
              : el('span.ws-name', null, a.name),
            el('span.ws-meta', null, [a.sizeLabel, a.byName].filter(Boolean).join(' · ')),
            a.path ? el('span.ws-go', null, '↗') : null
          ].forEach(n => { if (n) row.appendChild(n); });
          assets.appendChild(row);
        });
      }

      const folderBtn = el('button.ws-btn.btn-ghost', {
        title: 'Open this task’s folder on the volume',
        onclick: () => this._revealPath(ep, su, null)
      }, [App.icon('folderOpen'), ' Open folder']);

      const input = el('input.fld', { type: 'text', placeholder: 'Paste the review link', style: { width: '100%' } });
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
          el('.ws-head', null, [
            el('.modal-section-title', { style: { margin: '0' } }, [App.icon('clapper'), ' Uploaded for review']),
            folderBtn
          ]),
          items.length ? assets : el('.ws-note', null,
            'Nothing was uploaded for this task — its status came from its dates rather than from someone putting a cut up. Chase the department, or send a link you have anyway.'),
          el('.modal-section-title', { style: { marginTop: '16px' } }, [App.icon('link'), ' Review Link']),
          input,
          el('.fld-hint', null, 'Set up the review from the file above, then paste its link here. This is the link the Director clicks.')
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
