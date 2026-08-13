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

    onCleared() { /* notification badge state — stage 5 */ },

    async _send(text) {
      const m = this._mounted;
      if (!m || m.sending) return;
      const content = String(text || '').trim();
      if (!content) return;
      m.sending = true; this._render();
      try {
        const r = await App.api.chatSend(taskIdOf(m.epId, m.taskKey), content);
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
        placeholder: 'Write a message…  (Enter to send, Shift+Enter for a new line)',
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
        refs.length ? el('.chat-refs', null, refs.map(r =>
          el('span.chat-ref', null, String(r)))) : null
      ])
    ]);
  }
})();
