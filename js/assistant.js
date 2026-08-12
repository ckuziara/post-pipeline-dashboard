/* Schedule Assistant — a chat overlay on the Timeline for the bulk scheduling
   edits that are tedious to do bar by bar.

   IT IS NOT A LANGUAGE MODEL. There is no model behind this app and pretending
   otherwise would be the worst kind of interface: a box that accepts any
   sentence and silently does the wrong thing to a shared board. What this is
   instead is a small, honest command interpreter — a fixed set of intents,
   matched by pattern, that says plainly when it hasn't understood and offers
   the phrasings it does know.

   Two rules shape everything below:

     · NOTHING APPLIES ON ITS OWN. Every request is answered with a plan — what
       would change, on which episodes, and what it would cost — and a button.
       The board is shared, and these are the widest edits in the app; the same
       show-me-first courtesy the Re-Arrange dialog and scheduleImpact extend
       applies here.

     · THE PLAN IS RE-DERIVED WHEN IT'S APPLIED, never replayed from what was
       computed when it was drawn. A teammate may have moved something in
       between, and applying a stale plan would stamp over them.

   Everything lands through App.mutate, so an assistant edit is one Cmd+Z like
   any other.

   Scope is the show in the toolbar filter. These commands reach every episode
   of a show at once, so "all shows" is not a scope anyone means — the assistant
   asks for a show rather than guessing. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

  /* ---- resolution -------------------------------------------------------
     Turning the words someone typed into the show, episode and pipeline task
     they meant. Each resolver returns null rather than a best guess when the
     phrase is ambiguous: on an edit this wide, guessing wrong is much more
     expensive than asking. */

  function focusShow() {
    const id = App.state.filters.show;
    if (id === 'all') return null;
    return App.activeShows().find(s => s.id === id) || null;
  }

  // Mirrors App.pipelineFor's fallback exactly, so what the assistant edits is
  // what every reader of the board resolves.
  const showPipeline = (show) => show.pipeline ? show.pipeline : App.defaultPipeline();

  // Ordered the way Re-Arrange orders them — by where they sit, code breaking
  // the tie — so "episode 2" means the second one on the chart, not the second
  // one that happens to be in the array.
  function showEpisodes(showId) {
    return App.activeEpisodes().filter(e => e.showId === showId).sort((a, b) => {
      const sa = App.epStart(a), sb = App.epStart(b);
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    });
  }

  /* Task by name or key. Exact beats prefix beats substring, and a tie at the
     winning tier is reported as an ambiguity — "animatic" legitimately names
     three tasks, and picking one for the user would be a coin flip. */
  function findTasks(pipe, phrase) {
    const n = norm(phrase);
    if (!n) return [];
    const tiers = [
      (t) => norm(t.name) === n || norm(t.key) === n,
      (t) => norm(t.name).startsWith(n) || norm(t.key).startsWith(n),
      (t) => norm(t.name).includes(n) || norm(t.key).includes(n)
    ];
    for (const hit of tiers) {
      const found = pipe.filter(hit);
      if (found.length) return found;
    }
    return [];
  }

  /* Episode by code ("LA-101", "101"), by title, or by position ("episode 2").
     A bare number is tried as a code first — on a board where episodes are
     called LA-101 and LA-102, "102" almost never means "the second one". */
  function findEpisode(eps, phrase) {
    const n = norm(phrase).replace(/^(?:the|episode|episodes|ep|eps)/, '');
    if (!n) return null;
    let hit = eps.filter(e => norm(e.code) === n);
    if (hit.length === 1) return hit[0];
    if (/^\d+$/.test(n)) {
      hit = eps.filter(e => norm(e.code).endsWith(n));
      if (hit.length === 1) return hit[0];
      const i = parseInt(n, 10);
      if (i >= 1 && i <= eps.length) return eps[i - 1];
      return null;
    }
    hit = eps.filter(e => norm(e.title) === n);
    if (hit.length === 1) return hit[0];
    hit = eps.filter(e => n.length >= 3 && norm(e.title).includes(n));
    return hit.length === 1 ? hit[0] : null;
  }

  // "…in this show" / "…for Little Angel" is scope the toolbar already carries,
  // so it's stripped before the phrase is read as a task name.
  function stripScope(text) {
    return text
      .replace(/\s+(?:in|for|on|across|throughout)\s+(?:this|the|every|all)\s+(?:show|series|episodes?)\b.*$/i, '')
      .replace(/\s+(?:in|for|across)\s+["“]?([\w\s'’-]+?)["”]?\s*$/i, (m, name) =>
        App.activeShows().some(s => norm(s.name) === norm(name)) ? '' : m)
      .replace(/[.!?]+\s*$/, '')
      .trim();
  }

  /* ---- intents ----------------------------------------------------------
     Each builder is handed the show and the captured phrases and returns
     either { error } — something to say, nothing to do — or a plan:

       title   one line naming the change
       lines   what would happen, per episode
       warn    what it would cost (never a blocker; the producer decides)
       label   the button
       run()   performs it, reading live board state

     Builders are pure and cheap, which is what lets the same builder draw the
     preview and then run again at apply time against a board that may have
     moved underneath it. */

  const INTENTS = [
    {
      // "replicate LA-101's pipeline to the remaining episodes"
      re: /^(?:replicate|copy|clone|apply|duplicate)\s+(.+?)(?:['’]s|s['’])?\s+(?:pipeline|schedule|shape|plan)\b/i,
      build: (show, m) => replicatePlan(show, m[1])
    },
    {
      // "make all Blocking dependent on Layout"
      re: /^(?:make|set|have)\s+(?:all\s+|every\s+)?(.+?)\s+(?:depend(?:ent|ant)?\s+(?:on|upon)|depends?\s+on|wait\s+(?:for|on)|follow)\s+(.+)$/i,
      build: (show, m) => dependPlan(show, m[1], m[2], true)
    },
    {
      // "make Blocking no longer depend on Layout"
      re: /^(?:make\s+)?(?:all\s+|every\s+)?(.+?)\s+(?:no\s+longer|not|stop)\s+(?:depend(?:ent|ant)?\s+(?:on|upon)|depends?\s+on|waiting\s+for)\s+(.+)$/i,
      build: (show, m) => dependPlan(show, m[1], m[2], false)
    },
    {
      // "remove the dependency between Blocking and Layout"
      re: /^(?:remove|drop|clear|delete|unlink)\s+(?:the\s+)?dependenc(?:y|ies)\s+(?:between\s+|from\s+|of\s+)?(.+?)\s+(?:and|on|from|to)\s+(.+)$/i,
      build: (show, m) => dependPlan(show, m[1], m[2], false)
    }
  ];

  /* ---- replicate one episode's pipeline ---------------------------------

     What gets copied is the episode's SHAPE, not its dates: how long each task
     runs and how far into the episode it sits. Every target keeps its own
     start date and slot in the show — the point is to standardise how an
     episode is built, not to pile them all onto the same week.

     Approved work never moves, for the same reason it doesn't in a Re-Arrange:
     it already happened, and back-dating history to fit a new plan is how a
     schedule stops being believable. That extends to structure — a task the
     source episode has removed stays in a target that has already approved it.

     Delivered episodes aren't targets at all. */
  function replicatePlan(show, epPhrase) {
    const eps = showEpisodes(show.id);
    const src = findEpisode(eps, stripScope(epPhrase));
    if (!src) {
      return { reason: 'no_episode', kind: 'replicate',
        error: 'I couldn’t tell which episode of ' + show.name + ' you meant by “' +
        stripScope(epPhrase).trim() + '”.',
        hint: 'Try its code or its position — ' + eps.slice(0, 3).map(e => '“' + e.code + '”').join(', ') +
              (eps.length ? ', or “episode 1”.' : '') };
    }
    const targets = eps.filter(e => e.id !== src.id && !App.isDelivered(e));
    if (!targets.length) {
      return { reason: 'no_targets', kind: 'replicate',
        error: 'There’s nothing to copy ' + src.code + '’s shape onto — every other episode of ' +
        show.name + ' is either delivered or missing.' };
    }

    const srcStart = App.epStart(src);
    const shape = App.subitems(src).map(su => ({
      key: su.key,
      name: su.name,
      off: App.diffDays(su.start, srcStart),
      len: App.diffDays(su.due, su.start)
    }));
    const srcRemoved = (src.removed || []).slice();
    const srcNames = Object.assign({}, src.names || {});

    const lines = [], warn = [];
    targets.forEach(ep => {
      const base = App.epStart(ep);
      const statusOf = (k) => (ep.statuses && ep.statuses[k]) || 'not_started';
      let moves = 0, locked = 0, ends = '0000-00-00';
      shape.forEach(s => {
        const start = App.shiftIso(base, s.off), due = App.shiftIso(start, s.len);
        if (statusOf(s.key) === 'approved') {
          locked++;
          const cur = App.subitem(ep, s.key);
          if (cur && cur.due > ends) ends = cur.due;
          return;
        }
        const cur = App.subitem(ep, s.key);
        if (!cur || cur.start !== start || cur.due !== due) moves++;
        if (due > ends) ends = due;
      });
      const drops = srcRemoved.filter(k => statusOf(k) !== 'approved' && !(ep.removed || []).includes(k)).length;
      const restores = (ep.removed || []).filter(k => !srcRemoved.includes(k)).length;

      const bits = [];
      bits.push(moves ? plural(moves, 'task') + ' move' : 'already matches');
      if (drops) bits.push(plural(drops, 'task') + ' dropped');
      if (restores) bits.push(plural(restores, 'task') + ' restored');
      if (locked) bits.push(plural(locked, 'approved task') + ' stay put');
      lines.push({ code: ep.code, title: ep.title, text: bits.join(' · '), muted: !moves && !drops && !restores });

      // The live date is a commitment that never moves on its own, so the
      // honest thing is to say when this shape would push the work past it.
      const live = App.epMilestone(ep, App.LIVE_KEY);
      if (live && ends >= live.date) {
        warn.push(ep.code + ' would run to ' + App.fmtDate(ends) + ', on or past its live date (' +
          App.fmtDate(live.date) + ').');
      }
    });

    if (!lines.some(l => !l.muted)) {
      return { reason: 'noop', kind: 'replicate',
        error: 'Every episode of ' + show.name + ' already matches ' + src.code + '’s shape — nothing to do.' };
    }

    return {
      kind: 'replicate',
      title: 'Copy ' + src.code + '’s shape onto ' + plural(targets.length, 'episode'),
      note: 'Each episode keeps its own start date and slot; it takes on ' + src.code +
            '’s task durations, spacing and structure. Approved work stays exactly where it is.',
      lines, warn,
      label: 'Replicate to ' + plural(targets.length, 'episode'),
      run: () => {
        let moved = 0, locked = 0;
        App.mutate(d => {
          targets.forEach(t => {
            const e = d.episodes.find(x => x.id === t.id); if (!e) return;
            e.statuses = e.statuses || {};
            const statusOf = (k) => e.statuses[k] || 'not_started';
            const base = App.epStart(e);            // before any of its dates are rewritten
            e.dates = e.dates || {};
            shape.forEach(s => {
              if (statusOf(s.key) === 'approved') { locked++; return; }
              const start = App.shiftIso(base, s.off);
              e.dates[s.key] = { start, due: App.shiftIso(start, s.len) };
              moved++;
            });
            // structure: match the source's removals, except where the target
            // has already approved the task in question
            const removed = srcRemoved.filter(k => statusOf(k) !== 'approved');
            if (removed.length) e.removed = removed; else delete e.removed;
            // renamed tasks travel with the shape; a target's own rename of a
            // task the source didn't rename goes back to the pipeline name
            const names = {};
            Object.keys(srcNames).forEach(k => { names[k] = srcNames[k]; });
            if (Object.keys(names).length) e.names = names; else delete e.names;
            App.refreshReadiness(e);
          });
        }, 'the pipeline replication');

        App.track && App.track.audit && App.track.audit('assistant.replicate', {
          show: show.name, source: src.code,
          episodes: targets.map(t => t.code).join(', '), tasksMoved: moved, tasksLocked: locked
        });
        return plural(targets.length, 'episode') + ' now follow ' + src.code + '’s shape' +
          (locked ? ' · ' + plural(locked, 'approved task') + ' left in place' : '') + '.';
      }
    };
  }

  /* ---- add or remove a dependency across a show -------------------------

     A dependency lives on the SHOW's pipeline, not on an episode, so this is
     one edit that every episode reads. Seed shows carry no stored pipeline —
     they resolve to the default — so the first such edit materialises it onto
     the show, which is exactly what App.pipelineFor expects to find.

     Nothing is rescheduled. That's deliberate and matches the rest of the app:
     App.scheduleImpact reports what a move would break rather than cascading
     it, because a producer, not a solver, decides who gives up the days. So
     this reports which episodes now have the two tasks in the wrong order and
     leaves the dates alone. */
  function dependPlan(show, aPhrase, bPhrase, add) {
    const pipe = showPipeline(show);
    const pick = (phrase, role) => {
      const found = findTasks(pipe, stripScope(phrase));
      if (!found.length) {
        return { reason: 'no_task', kind: 'dep',
          error: 'There’s no task called “' + stripScope(phrase).trim() + '” in ' + show.name + '’s pipeline.',
          hint: 'Its tasks are: ' + pipe.map(t => t.name).join(', ') + '.' };
      }
      if (found.length > 1) {
        return { reason: 'ambiguous_task', kind: 'dep',
          error: '“' + stripScope(phrase).trim() + '” matches ' + found.length + ' tasks — ' +
          found.map(t => '“' + t.name + '”').join(', ') + '.', hint: 'Name the ' + role + ' one exactly.' };
      }
      return { task: found[0] };
    };
    const A = pick(aPhrase, 'waiting'), B = pick(bPhrase, 'blocking');
    if (A.error) return A;
    if (B.error) return B;
    const a = A.task, b = B.task;
    if (a.key === b.key) return { reason: 'same_task', kind: 'dep', error: 'A task can’t depend on itself.' };

    const has = a.deps.includes(b.key);
    if (add && has) return { reason: 'already', kind: 'dep',
      error: '“' + a.name + '” already waits for “' + b.name + '” in ' + show.name + '.' };
    if (!add && !has) return { reason: 'already', kind: 'dep',
      error: '“' + a.name + '” doesn’t depend on “' + b.name + '” in ' + show.name + '.' };

    // the candidate pipeline, checked for a cycle before it's ever offered
    const next = JSON.parse(JSON.stringify(pipe));
    const target = next.find(t => t.key === a.key);
    target.deps = add ? target.deps.concat([b.key]) : target.deps.filter(k => k !== b.key);
    if (add && !App.topoSort(next)) {
      return { reason: 'cycle', kind: 'dep',
        error: 'That would make a dependency loop — “' + b.name + '” already waits on “' + a.name +
        '”, directly or through another task.' };
    }

    const eps = showEpisodes(show.id);
    const lines = [], warn = [];
    eps.forEach(ep => {
      const sa = App.subitem(ep, a.key), sb = App.subitem(ep, b.key);
      if (!sa || !sb) { lines.push({ code: ep.code, title: ep.title, text: 'doesn’t run both tasks', muted: true }); return; }
      if (!add) { lines.push({ code: ep.code, title: ep.title, text: '“' + a.name + '” no longer waits' }); return; }
      const early = App.diffDays(sb.due, sa.start) + 1;
      const bits = [];
      if (early > 0) {
        bits.push('starts ' + plural(early, 'day') + ' before “' + b.name + '” finishes');
        warn.push(ep.code + ': “' + a.name + '” starts ' + plural(early, 'day') + ' before “' + b.name + '” finishes.');
      } else bits.push('order already holds');
      if (sa.status === 'in_progress' || sa.status === 'review') {
        if (sb.status !== 'approved') bits.push('and is already under way');
      }
      lines.push({ code: ep.code, title: ep.title, text: bits.join(' · '), muted: early <= 0 });
    });

    return {
      kind: 'dep',
      title: add
        ? '“' + a.name + '” waits for “' + b.name + '” across ' + show.name
        : '“' + a.name + '” no longer waits for “' + b.name + '” in ' + show.name,
      note: add
        ? 'This edits ' + show.name + '’s pipeline, so it applies to every episode — including ones added later. ' +
          'No dates are moved: the clashes below are reported, not resolved.'
        : 'This edits ' + show.name + '’s pipeline, so it applies to every episode. Dates are left alone.',
      lines, warn,
      label: add ? 'Add the dependency' : 'Remove the dependency',
      run: () => {
        App.mutate(d => {
          const s = d.shows.find(x => x.id === show.id); if (!s) return;
          s.pipeline = next;
          d.episodes.filter(e => e.showId === s.id).forEach(e => {
            e.statuses = e.statuses || {};
            App.refreshReadiness(e);
          });
        }, 'the dependency change');
        App.track && App.track.audit && App.track.audit('assistant.dependency', {
          show: show.name, task: a.name, dependsOn: b.name, added: add, episodes: eps.length
        });
        return add
          ? '“' + a.name + '” now waits for “' + b.name + '” in every episode of ' + show.name + '.'
          : '“' + a.name + '” no longer waits for “' + b.name + '” in ' + show.name + '.';
      }
    };
  }

  /* ---- interpreter ------------------------------------------------------ */

  function interpret(text) {
    const q = text.trim();
    if (!q) return null;

    if (/^(?:help|what can you do|commands?|\?)$/i.test(q)) {
      return { reason: 'help',
        error: 'I handle two kinds of change across a whole show — copying one episode’s shape onto the rest, and adding or removing a dependency everywhere at once.',
        hint: 'Try one of the suggestions below.' };
    }

    const show = focusShow();
    if (!show) {
      return { reason: 'no_show',
        error: 'Pick a show in the toolbar first. These changes reach every episode of a show at once, so “All shows” isn’t something I should guess at.' };
    }
    if (!App.canEditSchedule(App.state.role)) {
      return { reason: 'no_permission',
        error: 'Only Producers, Managers and Post Operations can change the schedule, so there’s nothing I can apply for you here.' };
    }

    for (const intent of INTENTS) {
      const m = q.match(intent.re);
      if (m) return intent.build(show, m);
    }
    return { reason: 'unmatched',
      error: 'I didn’t understand that one. I’m a small command interpreter, not a language model — I only know a few phrasings.',
      hint: 'Try one of the suggestions below.' };
  }

  /* ---- the miss log -----------------------------------------------------

     The interpreter only knows a handful of phrasings, and the question that
     decides what to do about that is one neither of us can answer from a
     hunch: are people typing five variants a few regexes would cover, or
     genuinely open-ended requests that need a model behind them?

     So every ask is recorded through the existing tracker (Admin → Audit &
     Event Logs), classified by what actually went wrong:

       assistant.miss        no intent matched — a gap in the grammar
       assistant.unresolved  intent understood, name didn't resolve — a gap in
                             the matching, which is a different fix
       assistant.parsed      understood, including when the honest answer was
                             "already true" or "nothing to do"
       assistant.blocked     refused before parsing (no show, no permission)

     The raw text rides along on the first three, capped, because the phrasing
     IS the finding. Two things make the number trustworthy: `via` separates
     typed input from suggestion-chip clicks (chips always parse by
     construction, so counting them would flatter the miss rate), and
     `assistant.parsed` gives the denominator — "37 misses" means nothing
     without knowing whether there were 40 asks or 4,000. */
  function logAsk(q, plan, via) {
    const t = App.track; if (!t) return;
    const show = focusShow();
    const base = { via: via || 'typed', show: show ? show.name : null };
    const withText = (o) => Object.assign({ text: q.slice(0, 200) }, o, base);

    if (!plan.error) return t.usage('assistant.parsed', Object.assign({ kind: plan.kind }, base));
    const r = plan.reason;
    if (r === 'unmatched') return t.error('assistant.miss', withText({ reason: r }));
    if (r === 'no_task' || r === 'ambiguous_task' || r === 'no_episode')
      return t.error('assistant.unresolved', withText({ reason: r, kind: plan.kind }));
    if (r === 'no_show') return t.usage('assistant.blocked', withText({ reason: r }));
    if (r === 'no_permission' || r === 'help') return t.usage('assistant.blocked', Object.assign({ reason: r }, base));
    // understood perfectly; the board's answer was simply "no"
    return t.usage('assistant.parsed', Object.assign({ kind: plan.kind, outcome: r }, base));
  }

  /* ---- what to suggest next ---------------------------------------------

     Suggestions are the assistant's only documentation — there's no command
     list anywhere else — so they have to be things that would genuinely work
     on THIS board right now, not a fixed menu that half-fails when clicked.

     So candidates are read off the board (which episode is furthest along,
     which task is floating unanchored, which dependency is being violated) and
     then every one of them is run through the interpreter and DROPPED IF IT
     WOULD ERROR. A chip that survives is a chip that does something. It's also
     why the list keeps changing: replicate an episode's shape and the offer to
     replicate it again disappears, because by then it's a no-op.

     `after` is what just happened, so the next step follows the last one
     rather than restarting the same menu. */
  function candidates(show, after) {
    const eps = showEpisodes(show.id);
    const pipe = showPipeline(show);
    const out = [];
    const push = (key, text) => { if (!out.some(c => c.key === key)) out.push({ key, text }); };

    const approved = (e) => App.subitems(e).filter(s => s.status === 'approved').length;

    // Replicating copies a reference episode's shape onto the rest, so the
    // episode furthest along is the one worth offering as the reference.
    const ranked = eps.slice().sort((a, b) => approved(b) - approved(a));
    ranked.slice(0, 2).forEach(e =>
      push('rep:' + e.id, 'Replicate ' + e.code + '’s pipeline to the remaining episodes'));

    /* A task with no dependencies that doesn't start first is floating: nothing
       holds it in place, so it drifts when everything around it moves. Offer to
       anchor it to whatever currently finishes just before it. */
    const ref = eps[0];
    if (ref) {
      const subs = {};
      App.subitems(ref).forEach(s => { subs[s.key] = s; });
      const first = App.epStart(ref);
      pipe.forEach(t => {
        if (t.deps.length) return;
        const s = subs[t.key];
        if (!s || s.start === first) return;
        const before = pipe.map(x => subs[x.key])
          .filter(x => x && x.key !== t.key && x.due < s.start)
          .sort((a, b) => a.due < b.due ? 1 : -1)[0];
        if (before) push('dep:' + t.key + ':' + before.key,
          'Make all ' + s.name + ' dependent on ' + before.name);
      });
    }

    /* A dependency the schedule already ignores everywhere — the dependent
       starts before its input finishes in every episode — is either a wrong
       link or a wrong plan. Worth putting in front of someone either way. */
    if (ref) {
      const subs = {};
      App.subitems(ref).forEach(s => { subs[s.key] = s; });
      pipe.forEach(t => {
        const a = subs[t.key]; if (!a) return;
        t.deps.forEach(dk => {
          const b = subs[dk];
          if (b && a.start <= b.due) push('undep:' + t.key + ':' + dk,
            'Remove the dependency between ' + a.name + ' and ' + b.name);
        });
      });
    }

    /* Follow the thread. Having just linked two tasks, the useful next move is
       usually to spread the shape that link implies — and having just
       replicated, it's to fix the ordering the copy exposed. */
    const lead = after === 'dep' ? 'rep:' : after === 'replicate' ? 'undep:' : null;
    if (lead) out.sort((a, b) => (b.key.startsWith(lead) ? 1 : 0) - (a.key.startsWith(lead) ? 1 : 0));
    return out;
  }

  /* ---- the overlay ------------------------------------------------------
     Mounted on <body> once and toggled, rather than built inside #view: the
     view is torn down and rebuilt on every render, and a chat that lost its
     history each time a filter changed would be useless. */

  App.assistant = {
    open: false,
    _root: null,
    _log: null,
    _msgs: [],          // session-only; a transcript isn't board data
    _asked: new Set(),  // so a suggestion is never handed back after it's been used

    mount() {
      if (this._root) return this._root;
      const fab = el('button.ai-fab', {
        id: 'ai-fab',
        'aria-label': 'Schedule assistant',
        onclick: () => this.toggle()
      }, [App.icon('sparkle', { cls: 'ai-fab-ic' }), el('span.ai-fab-x', null, '✕')]);

      const panel = el('.ai-panel', { id: 'ai-panel' }, [
        el('.ai-head', null, [
          el('.ai-head-main', null, [
            el('.ai-title', null, [App.icon('sparkle'), ' Schedule Assistant']),
            el('.ai-scope', { id: 'ai-scope' })
          ]),
          el('button.ai-close', { title: 'Close', onclick: () => this.toggle(false) }, '✕')
        ]),
        el('.ai-log', { id: 'ai-log' }),
        el('form.ai-input', {
          onsubmit: (e) => {
            e.preventDefault();
            const box = document.getElementById('ai-ask');
            const v = box.value;
            box.value = '';
            this.ask(v);
          }
        }, [
          el('input#ai-ask', { type: 'text', autocomplete: 'off',
            placeholder: 'Ask for a scheduling change…' }),
          el('button.ai-send', { type: 'submit', title: 'Send' }, '↩')
        ])
      ]);

      const root = el('.ai-root', null, [panel, fab]);
      document.body.appendChild(root);
      this._root = root;
      this._log = panel.querySelector('#ai-log');
      if (!this._msgs.length) {
        this.say('assistant',
          'I make show-wide scheduling changes on the Timeline. Tell me what you want and I’ll show you the plan before anything moves.');
        this.offer();
      }
      return root;
    },

    /* Called from App.render(). The assistant only belongs on the Timeline —
       it talks about bars, dependencies and episode shape — and its scope line
       has to follow whatever show the toolbar is filtered to. */
    sync() {
      const on = App.state.view === 'timeline';
      if (!on && !this._root) return;
      this.mount();
      this._root.classList.toggle('hidden', !on);
      if (!on) this.toggle(false);
      const scope = document.getElementById('ai-scope');
      if (scope) {
        const show = focusShow();
        scope.textContent = show ? show.name : 'No show selected';
        scope.classList.toggle('none', !show);
      }
    },

    toggle(want) {
      const next = want == null ? !this.open : !!want;
      if (next === this.open) return;
      this.open = next;
      this.mount();
      this._root.classList.toggle('open', this.open);
      if (this.open) {
        App.track && App.track.feature && App.track.feature('assistant.open');
        const box = document.getElementById('ai-ask');
        if (box) setTimeout(() => box.focus(), 120);
        this.scroll();
      }
    },

    /* Offered at the END of a turn, inside the transcript — the assistant
       having finished answering is exactly when there's a next step to name,
       and it can be a better one for having seen what just happened.

       Every candidate is run through the interpreter first and kept only if it
       returns a plan, so a chip never leads to an error. Things already asked
       for this session drop out too: re-offering what someone just did is how
       a suggestion list stops being read. */
    offer(after) {
      const show = focusShow();
      if (!show || !this._log) return;
      const picks = [];
      for (const c of candidates(show, after)) {
        if (this._asked.has(norm(c.text))) continue;
        const plan = interpret(c.text);
        if (!plan || plan.error) continue;              // it wouldn't work — don't offer it
        picks.push(c);
        if (picks.length === 3) break;
      }
      if (!picks.length) return;
      const row = el('.ai-suggest', null, [
        el('.ai-suggest-lab', null, after ? 'What next' : 'Try'),
        el('.ai-suggest-list', null, picks.map(c =>
          el('button.ai-chip', { type: 'button', onclick: () => this.ask(c.text, 'chip') }, c.text)))
      ]);
      this._msgs.push(row);
      this._log.appendChild(row);
      this.scroll();
    },

    say(who, text, extra) {
      const node = el('.ai-msg.' + who, null, [el('.ai-bubble', null, [el('.ai-text', null, text)])]);
      if (extra) node.querySelector('.ai-bubble').appendChild(extra);
      this._msgs.push(node);
      if (this._log) { this._log.appendChild(node); this.scroll(); }
      return node;
    },

    scroll() {
      if (this._log) requestAnimationFrame(() => { this._log.scrollTop = this._log.scrollHeight; });
    },

    ask(text, via) {
      const q = String(text || '').trim();
      if (!q) return;
      this.mount();
      this.toggle(true);
      this._asked.add(norm(q));
      this.say('me', q);

      const plan = interpret(q);
      if (!plan) return;
      logAsk(q, plan, via);
      if (plan.error) {
        const body = el('.ai-note');
        if (plan.hint) body.appendChild(el('.ai-hint', null, plan.hint));
        this.say('assistant', plan.error, plan.hint ? body : null);
        this.offer();                 // the turn is over — name a way forward
        return;
      }
      this.drawPlan(q, plan);
    },

    /* A plan is drawn from the preview it was built with, but applied by
       re-running the interpreter against live board state — see the note at
       the top of the file. If the world moved underneath it, the fresh answer
       is shown instead of the stale one being forced through. */
    drawPlan(q, plan) {
      const card = el('.ai-plan');
      card.appendChild(el('.ai-plan-title', null, plan.title));
      if (plan.note) card.appendChild(el('.ai-plan-note', null, plan.note));

      if (plan.lines.length) {
        const list = el('.ai-rows');
        plan.lines.forEach(l => list.appendChild(el('.ai-row' + (l.muted ? '.muted' : ''), null, [
          el('span.ai-row-code', null, l.code),
          el('span.ai-row-text', null, l.text)
        ])));
        card.appendChild(list);
      }
      (plan.warn || []).forEach(w => card.appendChild(el('.ai-warn', null, [App.icon('warn'), ' ' + w])));

      const actions = el('.ai-actions');
      const apply = el('button.ai-apply', {
        onclick: () => {
          const fresh = interpret(q);
          if (!fresh || fresh.error) {
            actions.remove();
            card.appendChild(el('.ai-warn', null, [App.icon('warn'),
              ' ' + ((fresh && fresh.error) || 'That’s no longer possible.') + ' Nothing was changed.']));
            this.scroll();
            return;
          }
          const msg = fresh.run();
          actions.remove();
          card.appendChild(el('.ai-done', null, [App.icon('checkBadge'), ' ' + msg]));
          this.say('assistant', 'Done — ' + App.shortcutLabel('Z') + ' undoes it in one step.');
          // the board has moved, so this reads it afresh: whatever was just
          // done drops off the list, and what it made possible appears
          this.offer(plan.kind);
        }
      }, [App.icon('bolt'), ' ' + plan.label]);
      actions.appendChild(apply);
      actions.appendChild(el('button.ai-cancel', {
        onclick: () => {
          actions.remove();
          card.appendChild(el('.ai-note', null, 'Left as it was.'));
          // a plan someone asked for and then backed out of is worth knowing
          // about: either the preview did its job, or the parse was wrong
          App.track && App.track.usage('assistant.cancelled', { kind: plan.kind });
          this.offer();
        }
      }, 'Cancel'));
      card.appendChild(actions);

      this.say('assistant', 'Here’s what that would do:', card);
    }
  };

  // Esc closes it, the same as every other overlay in the app — but only when
  // it's the frontmost thing, so it never steals the key from a modal.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !App.assistant.open) return;
    if (document.querySelector('.modal-overlay')) return;
    App.assistant.toggle(false);
  });
})();
