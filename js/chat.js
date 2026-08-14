/* Contextual task chat — the conversation attached to one task.

   Mounts inside the Edit Task dialog the same way the workspace and version
   control sections do (App.chat.inlineSection), because that is already the
   place you go to think about a single task. A separate chat surface would
   mean deciding which of the two is the real one.

   ── ONE THREAD, MILESTONE DIVIDERS ───────────────────────────────────────
   Revisions don't start new threads. A round of notes inserts a divider into
   the ongoing conversation, so the history of a task reads top to bottom
   including the reasons it changed. The server already returns dividers as
   system messages inside the stream, so there is nothing to merge here.

   ── POSTGRES ONLY ────────────────────────────────────────────────────────
   The board runs on a JSON file when DATABASE_URL isn't set, and chat needs
   Postgres. That's the common case in local development, so an unavailable
   thread says why in one quiet line rather than reading as a failure. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  const taskIdOf = (epId, taskKey) => epId + '::' + taskKey;

  // Message times are read in relation to now ("4m ago"), not as dates — a
  // conversation is about recency, unlike the schedule around it.
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 604800) return Math.round(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const initialsOf = (name, email) =>
    App.initials(name || (email || '?').split('@')[0].replace(/[._-]+/g, ' '));

  App.chat = {
    _mounted: null,

    /* Same contract as App.workspace.inlineSection: build the box, kick off a
       load, hand the node straight back so the dialog can place it. */
    /* opts.onCount(n) lets the host surface a message count without knowing
       anything about the thread — the Edit Task tab uses it for its badge.
       Loading happens immediately even though the panel starts hidden, which
       is what makes the count available before anyone opens the tab. */
    inlineSection(epId, taskKey, opts) {
      const box = el('.chat');
      this._mounted = {
        box, epId, taskKey, thread: null, error: null, busy: false, sending: false,
        onCount: (opts && opts.onCount) || null
      };
      this._render();
      this.reload();
      return box;
    },

    _count() {
      const m = this._mounted;
      if (!m || !m.onCount) return;
      // dividers aren't messages anyone wrote, so they don't count as unread
      const n = m.thread ? m.thread.messages.filter(x => !x.is_system_event).length : 0;
      m.onCount(n);
    },

    // App.render() calls this so a teammate's message appears while the dialog
    // is open, matching how the workspace section refreshes.
    syncOpen() {
      const m = this._mounted;
      if (m && m.box.isConnected) this._render();
    },

    async reload() {
      const m = this._mounted; if (!m) return;
      m.busy = true; this._render();
      try {
        m.thread = await App.api.chatThread(taskIdOf(m.epId, m.taskKey));
        m.error = null;
      } catch (e) {
        m.thread = null;
        m.error = e.chatUnavailable ? { quiet: true, text: e.message } : { text: e.message };
      }
      m.busy = false;
      this._render();
      this._count();
      /* Reading the thread is the web's version of the spec's reply/react
         clear: it's on screen, so it stops being unread. Server no-ops (and
         stays silent) when there was nothing to clear. */
      if (m.thread) {
        App.api.markNotificationsRead({ taskId: taskIdOf(m.epId, m.taskKey) })
          .then(r => { if (r && r.cleared) this.bellBoot(); })
          .catch(() => {});
      }
    },

    /* A message arriving over SSE. Every client hears every message, so the
       taskId filter is what makes it ours. Appended in place rather than
       re-fetching: a reload would scroll the reader away from what they were
       reading mid-conversation. */
    onLive(payload) {
      const m = this._mounted;
      if (!m || !m.box.isConnected || !m.thread) return;
      if (!payload || payload.taskId !== taskIdOf(m.epId, m.taskKey)) return;
      if (m.thread.messages.some(x => x.id === payload.message.id)) return;   // our own echo
      m.thread.messages.push(payload.message);
      this._render();
      this._count();
      this._scroll();
    },

    /* A pin arriving (or being removed) over SSE — refresh just the strip. */
    onPinned(payload) {
      const m = this._mounted;
      if (!m || !m.box.isConnected || !m.thread) return;
      if (!payload || payload.taskId !== taskIdOf(m.epId, m.taskKey)) return;
      App.api.chatReferences(payload.taskId)
        .then(r => { m.thread.references = r.references; this._render(); })
        .catch(() => {});
    },

    /* ---- the notification bell ------------------------------------------
       Lives in the topbar (mounted by render.js). Unread state is owned by
       the server; this is a cache of it, corrected by three signals: the boot
       fetch, a live `notification` event naming this user, and a
       `notification_cleared` from any tab — including someone else's read on
       another machine, which is the point of clearing over SSE. */
    _bell: { items: [], count: 0, open: false, node: null, loaded: false },

    async bellBoot() {
      if (!App.api.online || !App.api.me) return;
      try {
        const r = await App.api.notifications();
        this._bell.items = r.unread || [];
        this._bell.count = r.count || 0;
        this._bell.me = r.userId || null;
        this._bell.loaded = !r.disabled;
      } catch (e) { this._bell.loaded = false; }
      this._bellDraw();
    },

    onNotify(payload) {
      // every client hears every event; it's ours only if we're named
      const me = this._myUserIdGuess();
      if (!payload || !Array.isArray(payload.userIds)) return;
      if (me && !payload.userIds.includes(me)) return;
      // unknown self (fetch not landed yet): refetch anyway — it's cheap and
      // teaches us our id for next time
      this.bellBoot();
    },

    onCleared(payload) {
      const me = this._myUserIdGuess();
      if (payload && payload.userId && me && payload.userId !== me) return;
      this.bellBoot();
    },

    /* The users row is created lazily server-side, so the client learns its
       own uuid from the first notifications fetch (rows carry user_id). */
    _myUserIdGuess() {
      const it = this._bell.items[0];
      return (it && it.user_id) || this._bell.me || null;
    },

    bellMount(box) {
      this._bell.node = box;
      this._bellDraw();
      if (!this._bell.loaded) this.bellBoot();
    },

    _bellDraw() {
      const b = this._bell;
      if (!b.node || !b.node.isConnected) return;
      b.node.innerHTML = '';
      const btn = el('button.bell', {
        title: b.count ? b.count + ' unread' : 'Notifications',
        onclick: (e) => { e.stopPropagation(); b.open = !b.open; this._bellDraw(); }
      }, [
        App.icon('bolt', { cls: 'bell-ic' }),
        b.count ? el('span.bell-badge', null, String(Math.min(b.count, 99))) : null
      ]);
      b.node.appendChild(btn);
      if (!b.open) return;

      const pop = el('.bell-pop', { onclick: (e) => e.stopPropagation() });
      if (!b.items.length) {
        pop.appendChild(el('.bell-empty', null, 'Nothing unread. Mentions and messages on your tasks land here.'));
      }
      b.items.slice(0, 12).forEach(n => {
        const ep = App.state.data.episodes.find(e => e.id === n.episode_id);
        const code = ep ? ep.code : n.episode_id;
        const taskName = ep ? App.taskNameFor(ep, n.task_key) : n.task_key;
        pop.appendChild(el('button.bell-item', {
          onclick: async () => {
            b.open = false; this._bellDraw();
            try { await App.api.markNotificationsRead({ taskId: n.episode_id + '::' + n.task_key }); } catch (e) {}
            if (ep) App.editTask.open(n.episode_id, n.task_key, { tab: 'chat' });
            else App.toast('That episode is no longer on the board', true);
          }
        }, [
          el('.bell-item-top', null, [
            el('span.bell-item-code', null, code + ' · ' + taskName),
            el('span.bell-item-why', null, n.type === 'mention' ? 'mentioned you' : 'your task')
          ]),
          el('.bell-item-text', null, (n.author_name ? n.author_name + ': ' : '') + String(n.content || '').slice(0, 90))
        ]));
      });
      if (b.count > 12) pop.appendChild(el('.bell-more', null, '+' + (b.count - 12) + ' more'));
      b.node.appendChild(pop);
      // one shot: any click elsewhere closes it
      setTimeout(() => document.addEventListener('click', () => {
        if (b.open) { b.open = false; this._bellDraw(); }
      }, { once: true }), 0);
    },

    async _send(text) {
      const m = this._mounted;
      if (!m || m.sending) return;
      const content = String(text || '').trim();
      if (!content) return;
      m.sending = true; this._render();
      try {
        const r = await App.api.chatSend(taskIdOf(m.epId, m.taskKey), content);   // refs extracted server-side
        if (m.thread && !m.thread.messages.some(x => x.id === r.message.id)) {
          m.thread.messages.push(r.message);
        }
        m.draft = '';
      } catch (e) {
        App.toast(e.message, true);
      }
      m.sending = false;
      this._render();
      this._count();
      this._scroll();
    },

    async _startRevision(label) {
      const m = this._mounted; if (!m) return;
      try {
        const r = await App.api.chatStartRevision(taskIdOf(m.epId, m.taskKey), label);
        if (m.thread && !m.thread.messages.some(x => x.id === r.divider.id)) {
          m.thread.messages.push(r.divider);
          m.thread.currentRevision = r.revision;
        }
        App.toast('Revision ' + r.revision.idx + ' started');
      } catch (e) {
        App.toast(e.message, true);
      }
      this._render();
      this._scroll();
    },

    _scroll() {
      const m = this._mounted; if (!m) return;
      const log = m.box.querySelector('.chat-log');
      if (log) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    },

    _render() {
      const m = this._mounted; if (!m) return;
      const ep = App.state.data.episodes.find(e => e.id === m.epId);
      const su = ep && App.subitem(ep, m.taskKey);
      const box = m.box;
      const focused = document.activeElement && document.activeElement.classList.contains('chat-input');
      const caret = focused ? document.activeElement.selectionStart : null;
      box.innerHTML = '';

      // No heading: the tab already says Discussion. Only the current round
      // needs stating, and only once there is one.
      const rev = m.thread && m.thread.currentRevision;
      if (rev) box.appendChild(el('.chat-head', null, el('span.chat-rev-pill', null, 'Revision ' + rev.idx)));

      // Unavailable is the normal case in local development, so it reads as a
      // note about configuration rather than something being broken.
      if (m.error) {
        box.appendChild(el('.chat-note' + (m.error.quiet ? '' : '.bad'), null, [
          App.icon(m.error.quiet ? 'plug' : 'warn'), ' ' + m.error.text
        ]));
        return;
      }
      if (!m.thread) {
        box.appendChild(el('.chat-note', null, 'Loading…'));
        return;
      }

      /* Pinned references — the durable outcome of LucidLink interception.
         Above the log because they outlive the scrollback that produced them. */
      const pins = (m.thread.references || []);
      if (pins.length) {
        box.appendChild(el('.chat-pins', null, pins.map(p =>
          el('.chat-pin', null, [
            el('a.chat-pin-link', { href: p.url, target: '_blank', rel: 'noopener',
              title: p.url + (p.created_by_name ? '\nPinned by ' + p.created_by_name : '') },
              [App.icon('link'), ' ' + (p.display_name || p.url)]),
            el('button.chat-pin-x', { title: 'Remove this pin',
              onclick: () => App.api.removeChatReference(taskIdOf(m.epId, m.taskKey), p.id)
                .then(() => this.reload()).catch(e => App.toast(e.message, true))
            }, '✕')
          ]))));
      }

      const log = el('.chat-log');
      if (!m.thread.messages.length) {
        log.appendChild(el('.chat-empty', null, 'No discussion yet. The first message starts the thread.'));
      }
      m.thread.messages.forEach(msg => log.appendChild(
        msg.is_system_event ? divider(msg) : bubble(msg)));
      box.appendChild(log);

      // Posting is open to anyone signed in — a conversation everyone can read
      // but only some can join isn't a conversation. Starting a revision is a
      // change to the plan, so it rides the same right as editing the task.
      const canRevise = !!su && App.canEditTask(App.state.role, su);

      const input = el('textarea.chat-input', {
        rows: 2,
        placeholder: 'Write a message…  @name mentions · #' + ((App.state.data.episodes[0] || {}).code || 'LA-101') + '/Task links a task',
        disabled: m.sending
      });
      input.value = m.draft || '';
      input.addEventListener('input', () => { m.draft = input.value; });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(input.value); }
      });

      /* The revision label is collected inline rather than in a confirm
         dialog: this section lives inside the Edit Task modal, and opening a
         second modal would replace the first (which is why the Remove flow has
         to re-open the dialog afterwards). */
      const revRow = el('.chat-revrow' + (m.revOpen ? '' : '.hidden'));
      const revInput = el('input.chat-revlabel', {
        type: 'text', placeholder: 'What changed? (optional)'
      });
      revInput.value = m.revDraft || '';
      revInput.addEventListener('input', () => { m.revDraft = revInput.value; });
      revInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); startRev(); }
        if (e.key === 'Escape') { e.preventDefault(); m.revOpen = false; this._render(); }
      });
      const startRev = () => {
        const label = (m.revDraft || '').trim();
        m.revOpen = false; m.revDraft = '';
        this._startRevision(label || null);
      };
      revRow.appendChild(revInput);
      revRow.appendChild(el('button.chat-rev-go', { type: 'button', onclick: startRev }, 'Start'));
      revRow.appendChild(el('button.chat-rev-x', {
        type: 'button', onclick: () => { m.revOpen = false; this._render(); }
      }, 'Cancel'));

      box.appendChild(el('.chat-compose', null, [
        revRow,
        input,
        el('.chat-actions', null, [
          canRevise ? el('button.chat-rev', {
            type: 'button',
            title: 'Insert a milestone divider — the thread continues, the round changes',
            onclick: () => { m.revOpen = !m.revOpen; this._render(); }
          }, [App.icon('scroll'), ' New revision']) : null,
          el('button.chat-send', {
            type: 'button', disabled: m.sending,
            onclick: () => this._send(input.value)
          }, m.sending ? 'Sending…' : 'Send')
        ])
      ]));

      if (m.revOpen) setTimeout(() => revInput.focus(), 0);

      if (focused) {
        input.focus();
        try { input.setSelectionRange(caret, caret); } catch (e) {}
      }
    }
  };

  /* A cross-reference chip. Every kind goes somewhere: a task chip opens that
     task's own conversation, an episode chip lands on its board card, a
     LucidLink chip is simply the link. The server only emits chips it could
     resolve, so none of these can dead-end. */
  function chip(r) {
    if (!r || typeof r !== 'object') return el('span.chat-ref', null, String(r));
    if (r.kind === 'lucidlink') {
      return el('a.chat-ref.link', { href: r.url, target: '_blank', rel: 'noopener', title: r.url },
        [App.icon('link'), ' ' + (r.url.split('/').filter(Boolean).pop() || 'LucidLink')]);
    }
    if (r.kind === 'task') {
      /* The server resolves WHICH task; the display name is re-derived here,
         because seed shows carry no stored pipeline server-side and the label
         would otherwise be the raw key ("blocking" instead of "Blocking"). */
      const ep = App.state.data.episodes.find(e => e.id === r.epId);
      const label = (r.code || '') + ' / ' + (ep ? App.taskNameFor(ep, r.taskKey) : r.taskKey);
      return el('button.chat-ref.jump', {
        type: 'button', title: 'Open ' + label + '’s discussion',
        onclick: () => { App.modal.close(); App.editTask.open(r.epId, r.taskKey, { tab: 'chat' }); }
      }, ['# ' + label]);
    }
    if (r.kind === 'episode') {
      return el('button.chat-ref.jump', {
        type: 'button', title: 'Show ' + r.code + ' on the board',
        onclick: () => {
          App.modal.close();
          App.state.view = 'board';
          App.state.expanded[r.epId] = true;
          App.render();
        }
      }, ['# ' + r.code]);
    }
    return el('span.chat-ref', null, r.label || r.kind);
  }

  function divider(msg) {
    return el('.chat-divider', null, [el('span', null, msg.content), el('span.chat-divider-at', null, ago(msg.created_at))]);
  }

  function bubble(msg) {
    const mine = App.api.me && msg.author_email &&
      msg.author_email.toLowerCase() === String(App.api.me.email || '').toLowerCase();
    const who = msg.author_name || msg.author_email || 'Someone';
    const refs = Array.isArray(msg.cross_references) ? msg.cross_references : [];
    return el('.chat-msg' + (mine ? '.mine' : ''), null, [
      el('span.avatar.chat-av', null, initialsOf(msg.author_name, msg.author_email)),
      el('.chat-body', null, [
        el('.chat-meta', null, [el('span.chat-who', null, mine ? 'You' : who), ' · ' + ago(msg.created_at)]),
        el('.chat-text', null, msg.content),
        refs.length ? el('.chat-refs', null, refs.map(r => chip(r))) : null
      ])
    ]);
  }
})();
