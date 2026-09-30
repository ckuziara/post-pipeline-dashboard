/* Unsaved Timeline changes.

   Dragging, stretching or nudging bars on the Timeline doesn't commit each
   move any more. The moves collect here as a draft: the bars (and everything
   else that reads App.subitems) show the new dates straight away, but nothing
   is written, synced or flagged mid-adjustment. A bar slides up from the
   bottom with the number of changes, small icons for what the draft would set
   off (a broken dependency, a delivery date overrun, a move that can't be
   saved at all) and Discard / Save.

   Save sends the whole draft through App.moveTasks as one change — the same
   rules as always: the live date still refuses, and a delivery date overrun
   is still a decision put to the producer. Plain dependency clashes are
   accepted on save, then listed in the bar so nothing lands unseen.

   Keys: Enter saves, Esc discards (Esc closes an open menu first). Both only
   when no dialog is up and nothing is being typed into.

   Named App.timelineDraft, not App.draft: App.draft is the dialog-draft
   store in state.js (Add Show keeps its unfinished form there).

   The draft is this person's alone and lives only in memory; it's never
   synced to teammates. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const keyOf = (epId, suKey) => epId + '::' + suKey;

  App.timelineDraft = {
    moves: {},          // 'epId::taskKey' -> { epId, suKey, start, due }
    suspended: false,   // true while reading the committed schedule (flags, saving)
    saved: null,        // after a save: { n, flags } — the list shown in the bar
    _bar: null,
    _open: false,       // flag list expanded

    // the draft's dates for one task, or null — read by App.subitems
    dates(epId, suKey) {
      if (this.suspended) return null;
      return this.moves[keyOf(epId, suKey)] || null;
    },
    list() { return Object.values(this.moves); },
    count() { return Object.keys(this.moves).length; },

    // the schedule as committed, ignoring the draft
    committed(fn) {
      const was = this.suspended; this.suspended = true;
      try { return fn(); } finally { this.suspended = was; }
    },

    /* Add moves to the draft. A task dragged back onto its committed dates
       drops out of it again. */
    stage(moves) {
      if (!App.canEditSchedule(App.state.role)) {
        App.toast('Only Producers, Managers and Post Operations can change the schedule', true);
        App.render(); return;
      }
      (moves || []).filter(m => m && m.epId && m.suKey).forEach(m => {
        const k = keyOf(m.epId, m.suKey);
        const cur = this.committed(() => {
          const ep = App.state.data.episodes.find(e => e.id === m.epId);
          return ep && App.subitem(ep, m.suKey);
        });
        if (!cur) return;
        if (cur.start === m.start && cur.due === m.due) delete this.moves[k];
        else this.moves[k] = { epId: m.epId, suKey: m.suKey, start: m.start, due: m.due };
      });
      this.saved = null;
      App.render();
    },

    /* What saving the draft would set off, worked out against the committed
       schedule with every drafted task in its episode travelling together
       (App.scheduleImpact's alsoMoving), so two drafted tasks never flag
       each other. */
    flags() {
      const out = { deny: [], clash: [], delivery: [] };
      const moves = this.list(); if (!moves.length) return out;
      const perEp = {};
      moves.forEach(m => { (perEp[m.epId] = perEp[m.epId] || {})[m.suKey] = { start: m.start, due: m.due }; });
      const hw = App.prefs.get('hideWeekends', true);
      this.committed(() => moves.forEach(m => {
        const ep = App.state.data.episodes.find(e => e.id === m.epId);
        const su = ep && App.subitem(ep, m.suKey); if (!su) return;
        const where = su.name + ' · ' + ep.code;
        const task = App.pTask(ep, m.suKey);
        const minDays = (task && task.minDays) || 1;
        if (App.visibleDayCount(m.start, m.due, hw) < minDays) {
          out.deny.push({ where, text: 'needs at least ' + minDays + ' day' + (minDays === 1 ? '' : 's') }); return;
        }
        const imp = App.scheduleImpact(ep, m.suKey, m.start, m.due, perEp[m.epId]);
        if (imp.deny) { out.deny.push({ where, text: imp.deny.text.replace(/^“[^”]*” /, '') }); return; }
        imp.clashes.forEach(c => out.clash.push({ where, text: (c.dir === 'upstream' ? '' : '“' + c.task.name + '” ') + c.text }));
        if (imp.delivery) out.delivery.push({ where, text: 'runs past the delivery date (' + App.fmtDate(imp.delivery.ms.date) + ')' });
      }));
      // a clash between two drafted tasks is reported from both ends — keep one
      const seen = new Set();
      out.clash = out.clash.filter(f => { const s = f.where + f.text; if (seen.has(s)) return false; seen.add(s); return true; });
      return out;
    },

    save() {
      const moves = this.list(); if (!moves.length) return;
      const flags = this.flags();
      if (flags.deny.length) {
        this._open = true; this.sync();
        App.toast(flags.deny.length + ' change' + (flags.deny.length === 1 ? '' : 's') + ' can’t be saved — fix ' +
          (flags.deny.length === 1 ? 'it' : 'them') + ' or discard', true);
        return;
      }
      const n = moves.length;
      this.suspended = true;          // App.moveTasks measures from the committed dates
      this._saving = true; this.sync();
      App.moveTasks(moves, {
        // a delivery date overrun is still asked about; a plain clash is
        // accepted here and listed afterwards
        confirmed: !flags.delivery.length,
        quiet: true,
        onApplied: () => {
          this.moves = {}; this.suspended = false; this._saving = false;
          const listed = { clash: flags.clash, delivery: flags.delivery, deny: [] };
          this.saved = { n, flags: listed, any: listed.clash.length + listed.delivery.length > 0 };
          this._open = this.saved.any;
          App.render();
          clearTimeout(this._t);
          if (!this.saved.any) this._t = setTimeout(() => { this.saved = null; this.sync(); }, 2600);
        },
        onAbort: () => { this.suspended = false; this._saving = false; App.render(); }
      });
    },

    dismiss() { clearTimeout(this._t); this.saved = null; this._open = false; this.sync(); },

    discard() {
      const n = this.count(); if (!n) return;
      this.moves = {}; this.saved = null; this._open = false;
      App.render();
      App.toast(n + ' unsaved change' + (n === 1 ? '' : 's') + ' discarded');
    },

    /* ---- the bar ---- */
    sync() {
      if (!this._bar) {
        this._bar = el('.draft-bar', { role: 'status', 'aria-live': 'polite' });
        document.body.appendChild(this._bar);
      }
      const bar = this._bar, n = this.count();
      const show = !this._saving && (n > 0 || !!this.saved);
      bar.classList.toggle('show', show);
      document.body.classList.toggle('has-draft', show);
      if (!show) return;
      bar.innerHTML = '';

      const f = this.saved ? this.saved.flags : this.flags();
      const kinds = [
        ['deny', 'blocked', 'Can’t be saved'],
        ['delivery', 'calendar', 'Past a delivery date'],
        ['clash', 'link', 'Breaks a dependency']
      ].filter(([k]) => f[k].length);

      if (this._open && kinds.length) {
        bar.appendChild(el('.draft-list', null, kinds.map(([k, ic, label]) => el('.draft-group.' + k, null, [
          el('.draft-group-head', null, [App.icon(ic), ' ' + label]),
          ...f[k].map(x => el('.draft-item', null, [el('b', null, x.where), ' ' + x.text]))
        ]))));
      }

      const row = el('.draft-row');
      row.appendChild(el('span.draft-count', null, this.saved
        ? [App.icon('checkBadge'), ' Saved ' + this.saved.n + ' change' + (this.saved.n === 1 ? '' : 's')]
        : [el('span.draft-dot'), n + ' unsaved change' + (n === 1 ? '' : 's')]));
      if (kinds.length) {
        row.appendChild(el('button.draft-flags', {
          type: 'button', title: this._open ? 'Hide the list' : 'Show what these flag',
          onclick: () => { this._open = !this._open; this.sync(); }
        }, kinds.map(([k, ic, label]) => el('span.draft-flag.' + k, { title: f[k].length + ' — ' + label.toLowerCase() },
          [App.icon(ic), String(f[k].length)]))));
      }
      if (this.saved) {
        row.appendChild(el('button.btn-ghost.draft-btn', { type: 'button', title: 'Close (Esc)', onclick: () => this.dismiss() }, 'Close'));
      } else {
        row.appendChild(el('button.btn-ghost.draft-btn', { type: 'button', title: 'Discard the changes (Esc)', onclick: () => this.discard() },
          'Discard'));
        row.appendChild(el('button.btn-primary.draft-btn', { type: 'button', title: 'Save the changes (Enter)', onclick: () => this.save() },
          [App.icon('save'), ' Save']));
      }
      bar.appendChild(row);
    }
  };

  /* Enter / Esc. Capture phase, so Esc reaches the draft before it's used to
     clear a shift-selection — while there are unsaved changes, Esc means
     "undo what I just did". Anything else that's open gets the key first:
     a dialog, a text field, a menu, or a drag still in progress. */
  const busy = (e) => {
    const t = e.target;
    if (App.modal && App.modal._ov) return true;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return true;
    if ((App.board && App.board._pop) || (App.gantt && (App.gantt._barMenu || App.gantt._drag)) || (App.prefsMenu && App.prefsMenu._pop)) return true;
    if (document.querySelector('.ctx-menu, .filter-pop')) return true;
    return false;
  };
  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    const d = App.timelineDraft;
    if (!d.count() && !d.saved) return;
    if (d._saving || busy(e)) return;
    // Enter on a focused button is that button's own click
    if (e.key === 'Enter' && e.target && (e.target.tagName === 'BUTTON' || e.target.tagName === 'A') && !d._bar.contains(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (d.saved) { d.dismiss(); return; }
    if (e.key === 'Enter') d.save(); else d.discard();
  }, true);

  // leaving with unsaved changes asks first
  window.addEventListener('beforeunload', (e) => {
    if (App.timelineDraft.count()) { e.preventDefault(); e.returnValue = ''; }
  });
})();
