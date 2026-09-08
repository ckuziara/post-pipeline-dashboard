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
   through watching it. That's what "Start review" writes. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  /* An approved task drops out of the queue once its review is old news —
     otherwise every task ever approved would pile up under its episode and
     the tab would stop being a to-do list. Two weeks is long enough to still
     be "what we just signed off". */
  const DONE_DAYS = 14;

  const STAGES = {
    waiting: { label: 'Waiting for review', color: '#5fb0f0' },
    under:   { label: 'Under review',       color: '#a25ddc' },
    done:    { label: 'Completed',          color: '#00c875' }
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const record = (epId, key) => App.review.get(epId, key);

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

  /* -------------------------------------------------------------- render */
  App.reviews = {
    render(episodes) {
      const wrap = el('.rvq');
      wrap.appendChild(el('.section-title', null, [App.icon('target'), ' Reviews']));

      const items = collect(episodes);
      if (!items.length) {
        wrap.appendChild(el('.empty', null, [App.icon('checkBadge'), ' Nothing is waiting for review right now.']));
        return wrap;
      }

      /* Series → Episode. Built by walking `episodes`, so both levels come out
         in the board's own order rather than alphabetically — a series' first
         episode is what places the series. */
      const shows = new Map();
      items.forEach(x => {
        if (!shows.has(x.ep.showId)) shows.set(x.ep.showId, new Map());
        const eps = shows.get(x.ep.showId);
        if (!eps.has(x.ep.id)) eps.set(x.ep.id, []);
        eps.get(x.ep.id).push(x);
      });

      shows.forEach((eps, showId) => {
        const show = App.show(showId);
        let n = 0;
        eps.forEach(list => { n += list.length; });
        const grp = el('.rvq-series', null, [
          el('.rvq-series-head', null, [
            el('span.rvq-dot', { style: { background: show.color } }),
            el('span.rvq-series-name', null, show.name),
            el('span.rvq-series-n', null, n + ' in review')
          ])
        ]);
        eps.forEach(list => grp.appendChild(episodeBlock(list[0].ep, list)));
        wrap.appendChild(grp);
      });
      return wrap;
    }
  };

  function episodeBlock(ep, list) {
    const byDue = (a, b) => (a.su.due < b.su.due ? -1 : a.su.due > b.su.due ? 1 : 0);
    const sorters = {
      due: byDue,
      dept: (a, b) => App.dept(a.su.dept).label.localeCompare(App.dept(b.su.dept).label) || byDue(a, b)
    };
    list.sort(sorters[App.prefs.get('reviewSort', 'due')] || byDue);

    const show = App.show(ep.showId);
    const block = el('.rvq-ep', null, [
      el('.rvq-ep-head', null, [
        el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color) } }, ep.code),
        el('span.rvq-ep-title', null, ep.title || '')
      ])
    ]);
    list.forEach(x => block.appendChild(taskRow(x)));
    return block;
  }

  function taskRow(x) {
    const { ep, su } = x;
    const dep = App.dept(su.dept);
    const person = su.assignee ? App.person(su.assignee) : null;
    const link = App.review.frameUrl(ep.id, su.key);
    const st = STAGES[x.stage];
    const overdue = x.stage !== 'done' && su.due && su.due < App.isoDate(App.today());

    const row = el('.rvq-row' + (x.stage === 'done' ? '.done' : ''), null, [
      // 1. the task
      el('.rvq-cell.rvq-task', null, [
        el('.rvq-task-name', null, su.name),
        el('.rvq-task-sub', null, [
          el('span.dept-chip', null, [el('span.dot', { style: { background: dep.color } }), dep.label]),
          person ? el('span.rvq-who', null, person.name) : null
        ])
      ]),
      // 2. the link to the cut  (+ 4. when it went up, under it)
      el('.rvq-cell.rvq-link', null, linkCell(ep, su, link)),
      // 3. where the review has got to
      el('.rvq-cell.rvq-stage', null,
        el('span.rvq-pill', { style: { background: st.color, color: App.pickInk(st.color) } }, st.label)),
      // 5. when the review is due
      el('.rvq-cell.rvq-due' + (overdue ? '.late' : ''), null, [
        el('.rvq-lbl', null, 'Review due'),
        el('.rvq-val', null, su.due ? App.fmtDate(su.due) : '—')
      ]),
      // 6 + 7, and the decision itself
      el('.rvq-cell.rvq-acts', null, actions(x, link))
    ]);
    return row;
  }

  /* Read-only, and it can afford to be: nothing reaches this tab until Post
     Operations has sent it, and sending it IS pasting the link. A director
     never has to hunt for the cut, and never has to file one. */
  function linkCell(ep, su, link) {
    const href = safeHref(link);
    const up = uploadedAt(ep, su);
    return [
      href
        ? el('a.rvq-linkbtn', { href, target: '_blank', rel: 'noopener', title: 'Open ' + link },
            [App.icon('link'), ' Watch the cut'])
        : el('.rvq-val.rvq-none', null, 'No review link'),
      up ? el('.rvq-val.rvq-uploaded', null, 'Uploaded ' + App.fmtDate(String(up).slice(0, 10))) : null
    ];
  }

  function actions(x, link) {
    const { ep, su } = x;
    const out = [];

    // 6. straight into the task's Discussion tab
    out.push(el('button.rvq-icon', {
      title: 'Open the discussion on this task', 'aria-label': 'Open discussion',
      onclick: () => App.editTask.open(ep.id, su.key, { tab: 'chat' })
    }, App.icon('chat')));

    /* 7. a note, written into today's journal with links back. The click is
       stopped here because the popover is opened BY this click: letting it
       reach the document listener that dismisses every other popover would
       close the note the instant it opened. */
    out.push(el('button.rvq-icon', {
      title: 'Write a note about this review into today’s journal', 'aria-label': 'Add a note',
      onclick: (e) => { e.stopPropagation(); noteBox(e.currentTarget, x, link); }
    }, App.icon('note')));

    if (x.stage === 'waiting') {
      out.push(el('button.rvq-mini.go', { onclick: () => App.review.start(ep.id, su.key) }, 'Start review'));
    }
    if (x.stage !== 'done') {
      out.push(el('button.rvq-mini.ok', { onclick: () => App.setStatus(ep.id, su.key, 'approved') }, '✓ Approve'));
      out.push(revisionButton(ep, su));
    }
    return out;
  }

  /* Reviews' "Send back", replaced: a Director spends one of the task's
     budgeted revisions rather than bouncing it for an open-ended redo. The
     count on the button is the whole point — it's what tells a Director this
     is the last one before they need another way to fix things. Disabled at
     zero rather than hidden, so a task with no revisions left still shows
     why the option isn't there. */
  function revisionButton(ep, su) {
    const { max, used, left } = App.taskRevisions(ep, su.key);
    return el('button.rvq-mini.warn', {
      disabled: left <= 0,
      title: max
        ? (left ? 'Revision ' + (used + 1) + ' of ' + max : 'All ' + max + ' revision' + (max === 1 ? '' : 's') + ' already used')
        : 'This task has no revisions configured in its pipeline',
      onclick: () => { if (left > 0) App.requestRevision(ep.id, su.key); }
    }, max ? '↺ Revision (' + left + ')' : '↺ No revisions');
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
      el('.rvq-note-head', null, ep.code + ' · ' + su.name),
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
    let html = '<strong>' + esc(ep.code + ' · ' + su.name) + '</strong> — ' + esc(text)
      + ' <a href="' + esc(deep) + '">task</a>';
    const href = link && safeHref(link.link);
    if (href) html += ' · <a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(link.name) + '</a>';
    return html;
  }
})();
