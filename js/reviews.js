/* Reviews tab — the director's queue, grouped Series → Episode.

   One row per task that wants looking at, carrying the seven things a review
   actually needs: the task, the link to the cut, where the review has got to,
   when the cut went up, when the review is due, a way into the discussion,
   and a way to write a note down.

   This is the LAST of three desks (see js/reviewflow.js for the other two):
   a department puts a cut up, Post Operations makes the Frame.io review and
   sends it, and it lands here. So a task at Ready for Review does NOT appear
   on this tab until it's actually been sent — until then it's on Post
   Operations' desk, not the Director's, and showing it here would mean
   showing reviews with no cut to watch.

   Very little of a row is new state. Most of it is read, not copied:

     · the Frame.io link is the one Post Operations pasted when they sent it;
     · the upload date is when the department put the cut up;
     · "Completed" is the task being Approved, not a separate flag;
     · the due date is the task's due date.

   The one thing that can't be derived is the middle stage: a sent review
   looks identical whether nobody has opened it yet or a director is halfway
   through watching it. The Reviews tab no longer offers "Start review" —
   Directors would rather not broadcast that they've started — so rows go
   from waiting straight to Approve or Send Feedback. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  /* An approved task drops out of the queue once its review is old news —
     otherwise every task ever approved would pile up under its episode and
     the tab would stop being a to-do list. Two weeks is long enough to still
     be "what we just signed off". */
  const DONE_DAYS = 14;
  // how many reviews the Director's Priority calendar plans on any one day
  const REVIEWS_PER_DAY = 4;

  const STAGES = {
    waiting: { label: 'Waiting for review', color: '#5fb0f0' },
    under:   { label: 'Under review',       color: '#a25ddc' },
    done:    { label: 'Completed',          color: '#00c875' }
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const record = (epId, key) => App.review.get(epId, key);
  const KEY = (epId, key) => epId + '::' + key;

  function stage(ep, su) {
    if (su.status === 'approved') return 'done';
    const r = record(ep.id, su.key);
    return r && r.state === 'under' ? 'under' : 'waiting';
  }

  // When the department actually put the cut up — not when the link was
  // pasted, which is a Post Operations timestamp and answers a different
  // question. Newest upload wins: a fixed cut goes up as a new one.
  function uploadedAt(ep, su) {
    const ups = App.reviewUploads.list(ep.id, su.key);
    if (!ups.length) return null;
    return ups.reduce((a, b) => (String(b.at) > String(a.at) ? b : a)).at;
  }
  // paranoia for older/imported rows: only ever build an href for a scheme we
  // put there ourselves (App.review.send forces http/https)
  const safeHref = (u) => /^https?:\/\//i.test(String(u || '')) ? String(u) : null;

  /* The cut a row is about: V1 is the first pass, and each revision sent
     (App.requestRevision) makes the next one V2, V3… */
  const version = (ep, su) => 'V' + (App.revisionsUsed(ep, su.key) + 1);
  const taskLabel = (ep, su) => su.name + ' ' + version(ep, su);

  /* ---------------------------------------------------------------- rows */
  function collect(episodes) {
    const showDone = App.prefs.get('reviewShowDone', true);
    const cutoff = App.isoDate(App.addDays(App.today(), -DONE_DAYS));
    const out = [];
    episodes.forEach(ep => App.subsView(ep).forEach(su => {
      const st = stage(ep, su);
      if (st === 'done') {
        // listed only if it actually went through this tab (there's a record)
        // and only while it's still recent
        const r = record(ep.id, su.key);
        if (!showDone || !r || String(r.at).slice(0, 10) < cutoff) return;
      } else if (su.status !== 'review' || !App.review.sent(ep.id, su.key)) return;
      out.push({ ep, su, stage: st });
    }));
    return out;
  }

  /* ------------------------------------------------------------ priority
     The order the queue should be worked in comes from the Daily Summary's
     Priority (Highest … Priority 3), set by Post Operations: highest first,
     then soonest due, and anything without a Priority after the rest. There's
     no separate hand-dragged order any more — one place decides. */
  const dsPriority = (k) => (App.dailySummary ? App.dailySummary.priority(k) : null);
  const dsRank = (k) => (App.dailySummary ? App.dailySummary.priorityRank(dsPriority(k)) : 99);
  const byDue = (a, b) => (a.su.due < b.su.due ? -1 : a.su.due > b.su.due ? 1 : 0);
  function byPriority(list) {
    const band = (x) => dsRank(KEY(x.ep.id, x.su.key));
    return list.sort((a, b) => (band(a) - band(b)) || byDue(a, b));
  }

  /* One card, split by department with a slim header line each — in the
     pipeline's department order — so a Director can take one department's
     reviews in a sitting. Ranks restart in each department. */
  function priorityList(items) {
    const open = byPriority(items.filter(x => x.stage !== 'done'));
    const done = items.filter(x => x.stage === 'done');
    const out = el('div');
    if (open.length) {
      const order = Object.keys(App.DEPARTMENTS);
      const groups = new Map();
      open.forEach(x => { if (!groups.has(x.su.dept)) groups.set(x.su.dept, []); groups.get(x.su.dept).push(x); });
      const depts = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
      const list = el('.rvq-ep.rvq-prio');
      depts.forEach(k => {
        const dep = App.dept(k), rows = groups.get(k);
        list.appendChild(el('.rvq-dept-head', null, [
          el('span.dot', { style: { background: dep.color } }),
          el('span.rvq-dept-name', null, dep.label),
          el('span.rvq-dept-n', null, rows.length)
        ]));
        rows.forEach((x, i) => list.appendChild(taskRow(x, { rank: i + 1 })));
      });
      out.appendChild(list);
    }
    if (done.length) {
      const blk = el('.rvq-ep', null, el('.rvq-ep-head', null, el('span.rvq-ep-title', null, 'Completed')));
      done.forEach(x => blk.appendChild(taskRow(x, { rank: null })));
      out.appendChild(blk);
    }
    return out;
  }

  /* -------------------------------------------------------------- render */
  App.reviews = {
    /* What's open on the Director's desk, for the Dashboard's Priority
       calendar: every review that's been sent and isn't signed off yet, with
       where it's got to, the link to watch, and the day to watch it.

       The day is planned, not just the due date, so reviews spread out
       instead of piling up on their deadlines. In the Producer's priority
       order (then soonest due), each review takes the first working day
       that still has room — at most REVIEWS_PER_DAY — from the day after it
       was sent (never before today) up to its due date. One that can't fit
       before it's due goes on its due date, flagged at risk. One already past
       its due date has no plan: it's overdue. A review someone has pinned to
       a day (dragged there on the calendar, App.review.pin) keeps that day,
       and the rest are planned around it. The plan is worked out over
       every open review on the board, then cut down to `episodes`, so
       filtering the Dashboard doesn't change anyone's schedule. */
    open(episodes) {
      const want = new Set(episodes.map(ep => ep.id));
      const all = byPriority(collect(App.activeEpisodes()).filter(x => x.stage !== 'done'));
      const today = App.today(), todayIso = App.isoDate(today);
      const isWork = (d) => d.getDay() !== 0 && d.getDay() !== 6;
      const nextWork = (d) => { let n = App.addDays(d, 1); while (!isWork(n)) n = App.addDays(n, 1); return n; };
      const onOrBefore = (d) => { let n = new Date(d); while (!isWork(n)) n = App.addDays(n, -1); return n; };
      const load = {};
      // pinned first (a pin on a day that's passed no longer holds): they keep
      // their day and count against it, and everything else plans around them
      const pinOf = (x) => { const r = record(x.ep.id, x.su.key); return r && r.planDate && r.planDate >= todayIso ? r.planDate : null; };
      all.forEach(x => { const p = pinOf(x); if (p && x.su.due >= todayIso) load[p] = (load[p] || 0) + 1; });
      const out = all.map(x => {
        const rec = record(x.ep.id, x.su.key) || {};
        const due = x.su.due;
        const base = {
          kind: 'review', ep: x.ep, su: x.su, due,
          stage: x.stage, stageLabel: STAGES[x.stage].label, color: STAGES[x.stage].color,
          url: safeHref(App.review.frameUrl(x.ep.id, x.su.key))
        };
        if (!due || due < todayIso) return Object.assign(base, { date: due || todayIso, overdue: true });
        const pinned = pinOf(x);
        if (pinned) return Object.assign(base, { date: pinned, pinned: true, atRisk: pinned > due });
        const sent = rec.sentAt ? App.parseDate(String(rec.sentAt).slice(0, 10)) : today;
        let day = nextWork(sent);
        if (App.isoDate(day) < todayIso) day = isWork(today) ? today : nextWork(today);
        const last = onOrBefore(App.parseDate(due));
        for (; App.isoDate(day) <= App.isoDate(last); day = nextWork(day)) {
          const k = App.isoDate(day);
          if ((load[k] || 0) < REVIEWS_PER_DAY) { load[k] = (load[k] || 0) + 1; return Object.assign(base, { date: k }); }
        }
        // no room before it's due: on its due date, and said so
        const k = App.isoDate(last) < todayIso ? todayIso : App.isoDate(last);
        load[k] = (load[k] || 0) + 1;
        return Object.assign(base, { date: k, atRisk: true });
      });
      return out.filter(x => want.has(x.ep.id));
    },

    /* Open the Reviews tab on one review and flash its row, so a review
       clicked on the Dashboard is easy to spot. Says so if the tab's filters
       are hiding it. */
    focus(epId, taskKey) {
      App.state.view = 'review';
      App.render();
      requestAnimationFrame(() => {
        const row = document.querySelector('.rvq-row[data-key="' + CSS.escape(KEY(epId, taskKey)) + '"]');
        if (!row) { App.toast('That review is hidden by the current filters', true); return; }
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.remove('rvq-flash'); void row.offsetWidth; row.classList.add('rvq-flash');
        setTimeout(() => row.classList.remove('rvq-flash'), 1400);
      });
    },

    render(episodes) {
      const wrap = el('.rvq');
      wrap.appendChild(el('.section-title', null, [App.icon('target'), ' Reviews']));

      const items = collect(episodes);
      if (!items.length) {
        wrap.appendChild(el('.empty', null, [App.icon('checkBadge'), ' Nothing is waiting for review right now.']));
        return wrap;
      }

      // one list across every show, since what to watch first doesn't stop at an episode's edge
      wrap.appendChild(priorityList(items));
      return wrap;
    }
  };

  /* `prio` is set in the Priority list: a rank (null for a completed row).
     The row also names its episode, since the list isn't grouped by one. */
  function taskRow(x, prio) {
    const { ep, su } = x;
    const dep = App.dept(su.dept);
    const person = su.assignee ? App.person(su.assignee) : null;
    const link = App.review.frameUrl(ep.id, su.key);
    const overdue = x.stage !== 'done' && su.due && su.due < App.isoDate(App.today());

    const show = App.show(ep.showId);
    const row = el('.rvq-row' + (x.stage === 'done' ? '.done' : '') + (prio ? '.in-prio' : ''), null, [
      // 0. its place in its department's priority order
      prio ? el('.rvq-cell.rvq-rank', null, prio.rank ? el('span.rvq-rank-n', null, prio.rank) : null) : null,
      // 1. the task
      el('.rvq-cell.rvq-task', null, [
        el('.rvq-task-name', null, [su.name, ' ', el('span.rvq-ver', null, version(ep, su))]),
        el('.rvq-task-sub', null, [
          prio ? el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color) }, title: show.name + ' · ' + (ep.title || '') }, ep.code) : null,
          // under a department header the chip would repeat it; Completed has no header
          !(prio && prio.rank) ? el('span.dept-chip', null, [el('span.dot', { style: { background: dep.color } }), dep.label]) : null,
          person ? el('span.rvq-who', null, person.name) : null
        ])
      ]),
      // 2. the link to the cut  (+ 4. when it went up, under it)
      linkCell(ep, su, link),
      // 5. when the review is due
      el('.rvq-cell.rvq-due' + (overdue ? '.late' : ''), null, [
        el('.rvq-lbl', null, 'Review due'),
        el('.rvq-val', null, su.due ? App.fmtDate(su.due) : '—')
      ]),
      // 6 + 7, and the decision itself
      el('.rvq-cell.rvq-acts', null, actions(x, link))
    ]);
    row.dataset.key = KEY(ep.id, su.key);
    return row;
  }

  /* Read-only, and it can afford to be: nothing reaches this tab until Post
     Operations has sent it, and sending it IS pasting the link. A director
     never has to hunt for the cut, and never has to file one. */
  function linkCell(ep, su, link) {
    const href = safeHref(link);
    const up = uploadedAt(ep, su);
    const cell = el('.rvq-cell.rvq-link', null, el('.rvq-link-text', null, [
      href
        ? el('a.rvq-linkbtn', { href, target: '_blank', rel: 'noopener', title: 'Open the cut in a new tab — ' + href },
            [App.icon('link'), ' ' + (App.linkLabel ? App.linkLabel(href) : 'Watch the cut')])
        : el('.rvq-val.rvq-none', null, 'No review link'),
      up ? el('.rvq-val.rvq-uploaded', null, 'Uploaded ' + App.fmtDate(String(up).slice(0, 10))) : null
    ]));
    if (href) withThumb(cell, href);
    return cell;
  }

  /* ----------------------------------------------------------- thumbnail
     The preview image the review link publishes, looked up by the server
     (/api/link-preview: Frame.io links only). Nothing is shown until there
     is an image — a link without one just stays text — and the lookup is
     remembered for the session, so re-renders draw it straight away. It's
     added to the cell when it arrives rather than by re-rendering the tab,
     which would close an open note or interrupt a drag. */
  const thumbs = new Map();   // href -> image url | null | Promise
  function withThumb(cell, href) {
    const known = thumbs.get(href);
    if (typeof known === 'string') { addThumb(cell, href, known); return; }
    if (known === null) return;
    if (!known) {
      thumbs.set(href, fetch('/api/link-preview?url=' + encodeURIComponent(href))
        .then(r => r.ok ? r.json() : {}).catch(() => ({}))
        .then(d => { const img = typeof d.image === 'string' && /^https:\/\//.test(d.image) ? d.image : null; thumbs.set(href, img); return img; }));
    }
    thumbs.get(href).then(img => { if (img && cell.isConnected) addThumb(cell, href, img); });
  }
  function addThumb(cell, href, src) {
    if (cell.querySelector('.rvq-thumb')) return;
    const img = el('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    // a broken image takes the thumbnail away rather than leaving an empty frame
    img.addEventListener('error', () => { thumbs.set(href, null); a.remove(); cell.classList.remove('has-thumb'); });
    const a = el('a.rvq-thumb', { href, target: '_blank', rel: 'noopener', title: 'Open the cut in a new tab', tabindex: '-1' }, img);
    cell.insertBefore(a, cell.firstChild);
    cell.classList.add('has-thumb');
  }

  function actions(x, link) {
    const { ep, su } = x;
    const out = [];

    // 6. straight into the task's Discussion tab
    out.push(el('button.rvq-icon', {
      title: 'Open the discussion on this task', 'aria-label': 'Open discussion',
      onclick: () => App.openTaskChat(ep.id, su.key)
    }, App.icon('chat')));

    /* 7. a note, written into today's journal with links back. The click is
       stopped here because the popover is opened BY this click: letting it
       reach the document listener that dismisses every other popover would
       close the note the instant it opened. */
    out.push(el('button.rvq-icon', {
      title: 'Write a note about this review into today’s journal', 'aria-label': 'Add a note',
      onclick: (e) => { e.stopPropagation(); noteBox(e.currentTarget, x, link); }
    }, App.icon('note')));

    if (x.stage !== 'done') {
      out.push(el('button.rvq-mini.ok', { onclick: () => App.setStatus(ep.id, su.key, 'approved') }, '✓ Approve'));
      out.push(revisionButton(ep, su));
    } else {
      /* a signed-off row keeps the button, now saying so. Not `disabled`:
         a disabled button never receives the right-click that reverses it. */
      out.push(el('button.rvq-mini.ok.approved', {
        type: 'button', 'aria-disabled': 'true',
        title: App.canApprove(App.state.role) ? 'Approved — right-click to reverse' : 'This task has been approved',
        oncontextmenu: (e) => approvedMenu(e, ep, su)
      }, '✓ Approved'));
    }
    return out;
  }

  /* Right-click on ✓ Approved. Only for roles that can approve: taking an
     approval back is the same right as giving it (App.reverseApproval). */
  function approvedMenu(e, ep, su) {
    e.preventDefault(); e.stopPropagation();
    if (!App.canApprove(App.state.role)) return;
    const close = () => { menu.remove(); document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', esc, true); };
    const off = (ev) => { if (!menu.contains(ev.target)) close(); };
    const esc = (ev) => { if (ev.key === 'Escape') close(); };
    const menu = el('.ctx-menu.no-copy', null, [
      el('button.ctx-item', { type: 'button', onclick: () => { close(); App.reverseApproval(ep.id, su.key); } },
        [el('span.ctx-item-lbl', null, 'Reverse Approval'), el('span.ctx-item-sub', null, taskLabel(ep, su))])
    ]);
    document.body.appendChild(menu);
    menu.style.top = Math.min(e.clientY + 2, window.innerHeight - menu.offsetHeight - 8) + 'px';
    menu.style.left = Math.min(e.clientX + 2, window.innerWidth - menu.offsetWidth - 8) + 'px';
    setTimeout(() => { document.addEventListener('mousedown', off, true); document.addEventListener('keydown', esc, true); }, 0);
  }

  /* Reviews' "Send back", replaced: a Director spends one of the task's
     budgeted revisions rather than bouncing it for an open-ended redo. The
     count on the button is the whole point — it's what tells a Director this
     is the last one before the schedule has to absorb extra passes. At zero
     it still works — feedback is never blocked — and the tooltip says the
     pass is over budget. */
  function revisionButton(ep, su) {
    const { max, used, left } = App.taskRevisions(ep, su.key);
    return el('button.rvq-mini.warn', {
      title: left
        ? 'Send feedback — revision ' + (used + 1) + ' of ' + max
        : max ? 'Send feedback — all ' + max + ' budgeted revision' + (max === 1 ? '' : 's') + ' already used, so this one is extra'
          : 'Send feedback — this task has no revisions budgeted, so this one is extra',
      onclick: () => App.requestRevision(ep.id, su.key)
    }, max ? '↺ Send Feedback (' + left + ')' : '↺ Send Feedback');
  }

  /* ---------------------------------------------------------------- note */
  /* A one-field popover rather than a row that expands: the note is written
     and gone in a few seconds, and growing the row would push every review
     below it down the page mid-read. Same anchored-to-its-own-button shape as
     the toolbar popovers, and the one global click listener closes it. */
  const note = { pop: null };
  App.reviews.closeNote = function () { if (note.pop) { note.pop.remove(); note.pop = null; } };

  function noteBox(btn, x, link) {
    const open = note.pop;
    App.reviews.closeNote();
    if (open) return;                    // clicking the same button again closes it

    const { ep, su } = x;
    const ta = el('textarea.rvq-note-in', { rows: '3', placeholder: 'What did you think?' });
    const save = () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      App.reviews.closeNote();
      App.journal.addNote(noteHtml(ep, su, link, text));
      App.toast('Added to today’s journal');
    };
    const pop = el('.rvq-note-pop', { onclick: (e) => e.stopPropagation() }, [
      el('.rvq-note-head', null, ep.code + ' · ' + taskLabel(ep, su)),
      ta,
      el('.rvq-note-foot', null, [
        el('span.rvq-note-hint', null, link ? 'Saved with a link to the review' : 'Saved with a link to the task'),
        el('button.rvq-mini.go', { onclick: save }, 'Add to journal')
      ])
    ]);
    const r = btn.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + 'px';
    // keep it on screen when the button is near the right edge
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 308)) + 'px';
    document.body.appendChild(pop);
    note.pop = pop;
    ta.focus();
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') App.reviews.closeNote();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    });
  }

  /* The journal stores block HTML, so the note carries real anchors: one into
     the task's discussion (the #task= deep link the Slack card already uses)
     and, when there is one, one straight to the cut that was reviewed. That's
     what makes the journal entry still useful a week later. */
  function noteHtml(ep, su, link, text) {
    const deep = '#task=' + encodeURIComponent(ep.id + '::' + su.key);
    let html = '<strong>' + esc(ep.code + ' · ' + taskLabel(ep, su)) + '</strong> — ' + esc(text)
      + ' <a href="' + esc(deep) + '">task</a>';
    // `link` is the review's Frame.io URL — a plain string
    const href = link && safeHref(link);
    if (href) html += ' · <a href="' + esc(href) + '" target="_blank" rel="noopener">review link</a>';
    return html;
  }
})();
