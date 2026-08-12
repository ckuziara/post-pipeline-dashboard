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

  /* Each intent declares the right it needs, because they genuinely differ:
     asking what's blocked needs none, assigning an owner is its own privilege,
     and everything that moves dates or reshapes a pipeline rides on
     canEditSchedule. `perm: null` means anyone signed in may ask.

     A build() may return null to mean "that wasn't me after all" — the matcher
     then keeps looking. Several of these grammars legitimately overlap ("move
     Layout to Video Post" vs "move LA-102 two weeks later"), and falling
     through beats trying to write one regex that tells them apart. */
  const PERM = {
    schedule: { test: () => App.canEditSchedule(App.state.role),
                deny: 'Only Producers, Managers and Post Operations can change the schedule, so there’s nothing I can apply for you here.' },
    assign:   { test: () => App.canAssignOwners(App.state.role),
                deny: 'Your role can’t assign task owners. An admin sets that in Admin → Access Control.' }
  };

  const INTENTS = [
    /* ---- read-only questions (no permission, no plan, no apply) ---- */
    {
      re: /^(?:what(?:'s|’s| is|s)?\s+)?(?:is\s+)?(?:currently\s+)?(?:blocked|at\s+risk|the\s+blockers?|blockers?)\b/i,
      build: (show) => blockedAnswer(show)
    },
    {
      re: /^(?:what(?:'s|’s| is|s)?\s+)?(?:is\s+)?(?:overdue|late|behind|slipping)\b/i,
      build: (show) => overdueAnswer(show)
    },
    {
      re: /\bdue\s+(?:this|next)\s+week\b|^what(?:'s|’s| is)?\s+due\b|^what\s+is\s+coming\s+up\b/i,
      build: (show, m, q) => dueAnswer(show, /next\s+week/i.test(q))
    },
    {
      re: /^who(?:'s|’s| is)?\s+(?:on|owns|has|assigned\s+to|working\s+on|doing)\s+(.+)$/i,
      build: (show, m) => ownerAnswer(show, m[1])
    },
    {
      re: /^(?:status|summary|overview|how(?:'s|’s| is)\s+(?:this\s+show|it|everything)\s+(?:going|doing|looking))/i,
      build: (show) => summaryAnswer(show)
    },

    /* ---- changes ---- */
    {
      // "replicate LA-101's pipeline to the remaining episodes"
      re: /^(?:replicate|copy|clone|apply|duplicate)\s+(.+?)(?:['’]s|s['’])?\s+(?:pipeline|schedule|shape|plan)\b/i,
      perm: 'schedule',
      build: (show, m) => replicatePlan(show, m[1])
    },
    {
      // "make all Blocking dependent on Layout"
      re: /^(?:make|set|have)\s+(?:all\s+|every\s+)?(.+?)\s+(?:depend(?:ent|ant)?\s+(?:on|upon)|depends?\s+on|wait\s+(?:for|on)|follow)\s+(.+)$/i,
      perm: 'schedule',
      build: (show, m) => dependPlan(show, m[1], m[2], true)
    },
    {
      // "make Blocking no longer depend on Layout"
      re: /^(?:make\s+)?(?:all\s+|every\s+)?(.+?)\s+(?:no\s+longer|not|stop)\s+(?:depend(?:ent|ant)?\s+(?:on|upon)|depends?\s+on|waiting\s+for)\s+(.+)$/i,
      perm: 'schedule',
      build: (show, m) => dependPlan(show, m[1], m[2], false)
    },
    {
      // "remove the dependency between Blocking and Layout"
      re: /^(?:remove|drop|clear|delete|unlink)\s+(?:the\s+)?dependenc(?:y|ies)\s+(?:between\s+|from\s+|of\s+)?(.+?)\s+(?:and|on|from|to)\s+(.+)$/i,
      perm: 'schedule',
      build: (show, m) => dependPlan(show, m[1], m[2], false)
    },
    {
      // "change the department of Layout to Video Post"
      re: /^(?:change|set|switch)\s+(?:the\s+)?(?:department|dept|team)\s+(?:of|for)\s+(.+?)\s+to\s+(.+)$/i,
      perm: 'schedule',
      build: (show, m) => deptPlan(show, m[1], m[2])
    },
    {
      /* "make Spline V2 an Animation task" — the way people actually say it.
         Anchored on the trailing noun so it can't swallow "make all Blocking
         dependent on Layout", which the dependency intents above claim first. */
      re: /^(?:make|set|turn)\s+(.+?)\s+(?:in)?to\s+(?:an?|the)\s+(.+?)\s+(?:task|job|item|step|stage)$/i,
      perm: 'schedule',
      build: (show, m) => deptPlan(show, m[1], m[2])
    },
    {
      re: /^(?:make|set|turn)\s+(.+?)\s+(?:an?|the)\s+(.+?)\s+(?:task|job|item|step|stage)$/i,
      perm: 'schedule',
      build: (show, m) => deptPlan(show, m[1], m[2])
    },
    {
      // "add Spline V2 after Blocking in Animation for 5 days"
      re: /^(?:add|create|insert)\s+(.+)$/i,
      perm: 'schedule',
      build: (show, m) => addTaskPlan(show, m[1])
    },
    {
      // "move Layout to Video Post" — returns null unless the target really is
      // a department, so "move LA-102 two weeks later" falls through to shift
      re: /^(?:move|change|switch|put|reassign)\s+(.+?)\s+(?:in)?to\s+(?:the\s+)?(.+?)(?:\s+(?:department|dept|team))?$/i,
      perm: 'schedule',
      build: (show, m) => deptPlan(show, m[1], m[2], true)
    },
    {
      // "assign all Audio Post tasks to Chris" / "give Layout to Diego"
      re: /^(?:assign|give|hand)\s+(.+?)\s+(?:to|over\s+to)\s+(.+)$/i,
      perm: 'assign',
      build: (show, m) => assignPlan(show, m[1], m[2])
    },
    {
      // "unassign Maya" / "take Layout off Diego"
      re: /^(?:unassign|clear)\s+(.+)$/i,
      perm: 'assign',
      build: (show, m) => assignPlan(show, m[1], null)
    },
    {
      // "push everything after Layout out a week" / "move LA-102 two weeks later"
      re: /^(?:push|shift|move|delay|pull|bring|slip)\s+(.+)$/i,
      perm: 'schedule',
      build: (show, m) => shiftPlan(show, m[1])
    },
    {
      // "get this show finished by March 1" / "fit this show into 8 weeks"
      re: /^(?:fit|finish|get|squeeze|compress|stretch|deliver)\b.*?\b(?:by|in|into|to)\s+(.+)$/i,
      perm: 'schedule',
      build: (show, m) => fitPlan(show, m[1])
    }
  ];

  /* ---- read-only answers -------------------------------------------------

     These return { answer: true } instead of a plan: there is nothing to
     preview and nothing to apply, so the chat renders them as a reply and
     stops. No permission gate either — reading the board is what everyone
     signed in is already doing by looking at it.

     Each one leans on a derivation that already exists in state.js rather than
     recomputing "blocked" or "overdue" a second, subtly different way. */

  const answer = (title, lines, note) => ({ answer: true, kind: 'query', title, lines: lines || [], note });

  function blockedAnswer(show) {
    const eps = showEpisodes(show.id);
    const lines = [];
    eps.forEach(ep => App.epBlockedTasks(ep).forEach(su => {
      const waiting = su.deps
        .filter(d => ((ep.statuses && ep.statuses[d]) || 'not_started') !== 'approved')
        .map(d => App.taskNameFor(ep, d));
      lines.push({ code: ep.code, text: '“' + su.name + '” is ' + App.status(su.status).label.toLowerCase() +
        ', waiting on ' + waiting.join(' + ') });
    }));
    if (!lines.length) {
      return answer('Nothing is blocked in ' + show.name, [],
        'A task counts as blocked when it’s already under way but something it depends on isn’t approved yet.');
    }
    return answer(plural(lines.length, 'task') + ' at risk in ' + show.name, lines,
      'Each of these is already being worked on while something it depends on is still unapproved.');
  }

  function overdueAnswer(show) {
    const today = App.isoDate(App.today());
    const lines = [];
    showEpisodes(show.id).forEach(ep => App.epOverdueTasks(ep).forEach(su => {
      lines.push({ code: ep.code, text: '“' + su.name + '” was due ' + App.fmtDate(su.due) +
        ' — ' + plural(App.diffDays(today, su.due), 'day') + ' ago · ' + App.status(su.status).label });
    }));
    if (!lines.length) return answer('Nothing is overdue in ' + show.name);
    lines.sort((a, b) => a.code < b.code ? -1 : 1);
    return answer(plural(lines.length, 'task') + ' overdue in ' + show.name, lines.slice(0, 20),
      lines.length > 20 ? 'Showing the first 20.' : null);
  }

  function dueAnswer(show, nextWeek) {
    // calendar week, Monday–Sunday — the same boundary the dashboard uses, so
    // the two never disagree about what "this week" means
    const t = App.today();
    const monday = App.addDays(t, -((t.getDay() + 6) % 7));
    const from = App.isoDate(nextWeek ? App.addDays(monday, 7) : monday);
    const to = App.isoDate(App.addDays(App.parseDate(from), 6));
    const lines = [];
    showEpisodes(show.id).forEach(ep => App.subitems(ep).forEach(su => {
      if (su.due >= from && su.due <= to && su.status !== 'approved') {
        const who = su.assignee && App.person(su.assignee);
        lines.push({ code: ep.code, text: '“' + su.name + '” due ' + App.fmtDate(su.due) +
          (who ? ' · ' + who.name : ' · unassigned') });
      }
    }));
    const when = (nextWeek ? 'next week' : 'this week') + ' (' + App.fmtRange(from, to) + ')';
    if (!lines.length) return answer('Nothing due ' + when + ' in ' + show.name);
    lines.sort((a, b) => a.code < b.code ? -1 : 1);
    return answer(plural(lines.length, 'task') + ' due ' + when + ' in ' + show.name, lines);
  }

  function ownerAnswer(show, phrase) {
    const pipe = showPipeline(show);
    const found = findTasks(pipe, stripScope(phrase));
    if (!found.length) {
      return { reason: 'no_task', kind: 'query',
        error: 'There’s no task called “' + stripScope(phrase).trim() + '” in ' + show.name + '’s pipeline.',
        hint: 'Its tasks are: ' + pipe.map(t => t.name).join(', ') + '.' };
    }
    if (found.length > 1) {
      return { reason: 'ambiguous_task', kind: 'query',
        error: '“' + stripScope(phrase).trim() + '” matches ' + found.length + ' tasks — ' +
          found.map(t => '“' + t.name + '”').join(', ') + '.', hint: 'Name one exactly.' };
    }
    const task = found[0];
    const lines = [];
    showEpisodes(show.id).forEach(ep => {
      const su = App.subitem(ep, task.key);
      if (!su) return;
      const who = su.assignee && App.person(su.assignee);
      lines.push({ code: ep.code, text: (who ? who.name : 'nobody assigned') +
        ' · ' + App.status(su.status).label + ' · ' + App.fmtRange(su.start, su.due) });
    });
    if (!lines.length) return answer('No episode of ' + show.name + ' runs “' + task.name + '”');
    return answer('“' + task.name + '” across ' + show.name, lines,
      App.dept(task.dept).label + ' department.');
  }

  function summaryAnswer(show) {
    const eps = showEpisodes(show.id);
    if (!eps.length) return answer(show.name + ' has no active episodes');
    const lines = eps.map(ep => {
      const bits = [App.progressPct(ep) + '% · ' + App.epStatusLabel(ep)];
      const over = App.epOverdueCount(ep), blocked = App.epBlockedCount(ep);
      if (over) bits.push(plural(over, 'overdue task'));
      if (blocked) bits.push(plural(blocked, 'blocked task'));
      const live = App.epMilestone(ep, App.LIVE_KEY);
      if (live) bits.push('live ' + App.fmtDate(live.date) + (live.slipDays > 0 ? ' (slipping ' + live.slipDays + 'd)' : ''));
      return { code: ep.code, text: bits.join(' · '), muted: App.isDelivered(ep) };
    });
    const atRisk = eps.filter(App.isAtRisk).length;
    return answer(show.name + ' — ' + plural(eps.length, 'episode'), lines,
      atRisk ? plural(atRisk, 'episode') + ' at risk.' : 'Nothing overdue across the show.');
  }

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

  /* ---- move a task to another department --------------------------------

     A task's department lives on the SHOW's pipeline, not on an episode, so
     this lands on every episode at once — the same reach as a dependency edit.
     It is also the only way to change a department at all: the Edit Task
     dialog deliberately doesn't offer it, since it isn't a fact about one
     episode's copy of the task.

     Ownership does not survive the move. App.canEditTask is
     department-scoped, so leaving the old department's owner in place would
     hand them a task they can no longer edit — an owner in name only, and the
     work looks covered when nobody can touch it. So the task is left
     deliberately ownerless for the receiving department to claim.

     Approved work is the exception, and for the usual reason: the assignee on
     a finished task is the record of who did it, not a plan for who will.
     Clearing that would rewrite history to tidy up a forward-looking change. */
  function findDept(phrase) {
    const n = norm(phrase);
    if (!n) return null;
    const keys = Object.keys(App.DEPARTMENTS);
    let hit = keys.filter(k => norm(App.DEPARTMENTS[k].label) === n || norm(k) === n);
    if (hit.length === 1) return hit[0];
    hit = keys.filter(k => norm(App.DEPARTMENTS[k].label).startsWith(n) || norm(k).startsWith(n));
    return hit.length === 1 ? hit[0] : null;
  }

  function deptPlan(show, taskPhrase, deptPhrase, soft) {
    const toKey = findDept(stripScope(deptPhrase));
    // the permissive "move X to Y" grammar only claims the sentence when Y is
    // really a department — otherwise this is a date shift and we step aside
    if (!toKey) {
      if (soft) return null;
      return { reason: 'no_task', kind: 'dept',
        error: 'There’s no department called “' + stripScope(deptPhrase).trim() + '”.',
        hint: 'Departments are: ' + Object.keys(App.DEPARTMENTS).map(k => App.DEPARTMENTS[k].label).join(', ') + '.' };
    }

    const pipe = showPipeline(show);
    const found = findTasks(pipe, stripScope(taskPhrase));
    if (!found.length) {
      if (soft) return null;
      return { reason: 'no_task', kind: 'dept',
        error: 'There’s no task called “' + stripScope(taskPhrase).trim() + '” in ' + show.name + '’s pipeline.',
        hint: 'Its tasks are: ' + pipe.map(t => t.name).join(', ') + '.' };
    }
    if (found.length > 1) {
      return { reason: 'ambiguous_task', kind: 'dept',
        error: '“' + stripScope(taskPhrase).trim() + '” matches ' + found.length + ' tasks — ' +
          found.map(t => '“' + t.name + '”').join(', ') + '.', hint: 'Name one exactly.' };
    }
    const task = found[0];
    const fromKey = task.dept;
    if (fromKey === toKey) {
      return { reason: 'already', kind: 'dept',
        error: '“' + task.name + '” is already in ' + App.dept(toKey).label + '.' };
    }

    const eps = showEpisodes(show.id);
    const lines = [], warn = [];
    let freeing = 0, kept = 0;
    eps.forEach(ep => {
      const su = App.subitem(ep, task.key);
      if (!su) { lines.push({ code: ep.code, text: 'doesn’t run this task', muted: true }); return; }
      const who = su.assignee && App.person(su.assignee);
      if (!who) { lines.push({ code: ep.code, text: 'already unassigned', muted: true }); return; }
      if (su.status === 'approved') {
        kept++;
        lines.push({ code: ep.code, text: who.name + ' keeps it — already approved', muted: true });
      } else {
        freeing++;
        lines.push({ code: ep.code, text: who.name + ' → unassigned' });
      }
    });
    const staff = App.state.data.people.filter(p => App.roleDept(p.role) === toKey);
    if (freeing) {
      warn.push(plural(freeing, 'task') + ' will be left without an owner for ' + App.dept(toKey).label +
        ' to pick up' + (staff.length ? ' — ' + staff.map(p => p.name).join(', ') + '.' :
        '. There is nobody in that department yet; add someone in Admin.'));
    }

    return {
      kind: 'dept',
      title: '“' + task.name + '” moves from ' + App.dept(fromKey).label + ' to ' + App.dept(toKey).label,
      note: 'Departments belong to ' + show.name + '’s pipeline, so this applies to every episode — including ones added later. ' +
            'Dates don’t move. Unfinished work is left unassigned for the new department to claim; approved work keeps whoever completed it.',
      lines, warn,
      label: 'Move to ' + App.dept(toKey).label,
      run: () => {
        const next = JSON.parse(JSON.stringify(pipe));
        next.find(t => t.key === task.key).dept = toKey;
        let freed = 0;
        App.mutate(d => {
          const s = d.shows.find(x => x.id === show.id); if (!s) return;
          s.pipeline = next;
          d.episodes.filter(e => e.showId === show.id).forEach(e => {
            e.statuses = e.statuses || {};
            // an owner from the old department would keep the task while losing
            // the right to edit it, so the unfinished ones are handed back
            if (e.assignees && e.assignees[task.key] &&
                (e.statuses[task.key] || 'not_started') !== 'approved') {
              delete e.assignees[task.key];
              freed++;
            }
            App.refreshReadiness(e);
          });
        }, 'the department change');
        App.track && App.track.audit && App.track.audit('assistant.department', {
          show: show.name, task: task.name,
          from: App.dept(fromKey).label, to: App.dept(toKey).label,
          episodes: eps.length, unassigned: freed
        });
        return '“' + task.name + '” is now a ' + App.dept(toKey).label + ' task across ' + show.name +
          (freed ? ' · ' + plural(freed, 'task') + ' left unassigned' : '') + '.';
      }
    };
  }

  /* ---- add a task to the pipeline ----------------------------------------

     Everything else here reshapes tasks that already exist; this is the one
     that makes a new one. It lands on the SHOW's pipeline, so every episode
     gains it — including ones added later.

     "after X" SPLICES rather than branches. Saying a stage goes after Blocking
     almost always means it goes between Blocking and whatever followed it, not
     alongside — so whatever depended on the anchor is rewired to depend on the
     new task instead, and the preview names every rewired task so that isn't a
     surprise. "before X" is the mirror: the new task inherits the anchor's
     dependencies and the anchor waits on it.

     Concrete dates matter here in a way they don't elsewhere. App.subitems
     falls back to "starts today" for a pipeline task an episode has no dates
     for, which would drop the new bar onto today's date in every episode
     regardless of where that episode actually sits. So each episode gets a
     real slot, measured from its own copy of the anchor.

     Nothing downstream is rescheduled. Splicing a task in makes the work
     longer, so the tasks after it are now too early — that's reported, per the
     same rule the rest of the app follows: the producer decides who gives up
     the days. */
  const DEFAULT_DAYS = 5, DEFAULT_MIN = 2;

  function addTaskPlan(show, rest) {
    const pipe = showPipeline(show);
    let text = stripScope(rest);

    // pull the optional modifiers off the end first, so what's left is just
    // "<name> after|before <anchor>"
    let days = null;
    text = text.replace(/\s+(?:for|over|taking)\s+(\d+)\s*(day|week)s?\b/i, (m0, n, unit) => {
      days = parseInt(n, 10) * (/week/i.test(unit) ? 7 : 1);
      return '';
    });
    let deptKey = null;
    text = text.replace(/\s+(?:in|to|under|for)\s+(?:the\s+)?([A-Za-z][\w\s&-]*?)(?:\s+(?:department|dept|team))?\s*$/i,
      (m0, name) => { const k = findDept(name); if (!k) return m0; deptKey = k; return ''; });

    const m = text.match(/^(?:a\s+|an\s+)?(?:new\s+)?(?:task|stage|step|job)?\s*(?:called|named)?\s*(.+?)\s+(after|before|following|ahead\s+of|preceding)\s+(.+)$/i);
    if (!m) return null;                       // no anchor — not something we can place

    const name = m[1].replace(/^["“']|["”']$/g, '').trim();
    const position = /^(?:before|ahead\s+of|preceding)$/i.test(m[2]) ? 'before' : 'after';
    if (!name) return null;

    const found = findTasks(pipe, m[3]);
    if (!found.length) {
      return { reason: 'no_task', kind: 'addtask',
        error: 'There’s no task called “' + m[3].trim() + '” in ' + show.name + '’s pipeline to put it ' + position + '.',
        hint: 'Its tasks are: ' + pipe.map(t => t.name).join(', ') + '.' };
    }
    if (found.length > 1) {
      return { reason: 'ambiguous_task', kind: 'addtask',
        error: '“' + m[3].trim() + '” matches ' + found.length + ' tasks — ' +
          found.map(t => '“' + t.name + '”').join(', ') + '.', hint: 'Name one exactly.' };
    }
    const anchor = found[0];

    // a name already in use would make every later reference ambiguous
    if (pipe.some(t => norm(t.name) === norm(name))) {
      return { reason: 'already', kind: 'addtask',
        error: show.name + '’s pipeline already has a task called “' + pipe.find(t => norm(t.name) === norm(name)).name + '”.' };
    }
    if (deptKey === null) deptKey = anchor.dept;     // same team as the stage it sits beside
    const dur = days || DEFAULT_DAYS;

    // build the candidate pipeline now, so a cycle is caught before it's offered
    let key = norm(name).slice(0, 24) || 'task';
    if (!key || pipe.some(t => t.key === key)) { let i = 2; const base = key; while (pipe.some(t => t.key === key)) key = base + '_' + (i++); }
    const next = JSON.parse(JSON.stringify(pipe));
    const idx = next.findIndex(t => t.key === anchor.key);
    const task = { key, name, dept: deptKey, days: dur, minDays: Math.min(DEFAULT_MIN, dur), deps: [] };
    const rewired = [];
    if (position === 'after') {
      task.deps = [anchor.key];
      next.forEach(t => {
        const i = t.deps.indexOf(anchor.key);
        if (i >= 0) { t.deps[i] = key; rewired.push(t.name); }
      });
      next.splice(idx + 1, 0, task);
    } else {
      task.deps = anchor.deps.slice();
      next.splice(idx, 0, task);
      const a = next.find(t => t.key === anchor.key);
      a.deps = [key];
      rewired.push(anchor.name);
    }
    if (!App.topoSort(next)) {
      return { reason: 'cycle', kind: 'addtask', error: 'Adding it there would make a dependency loop.' };
    }

    // where it lands in each episode, measured from that episode's own anchor
    const eps = showEpisodes(show.id);
    const slots = {};
    eps.forEach(ep => {
      const su = App.subitem(ep, anchor.key);
      if (!su) return;
      slots[ep.id] = position === 'after'
        ? { start: App.shiftIso(su.due, 1), due: App.shiftIso(su.due, dur) }
        : { start: App.shiftIso(su.start, -dur), due: App.shiftIso(su.start, -1) };
    });

    const lines = [], warn = [];
    eps.forEach(ep => {
      const s = slots[ep.id];
      if (!s) { lines.push({ code: ep.code, text: 'doesn’t run “' + anchor.name + '”, so it won’t be added here', muted: true }); return; }
      lines.push({ code: ep.code, text: App.fmtRange(s.start, s.due) + ' · unassigned' });
      // splicing makes the chain longer, so whatever followed the anchor is now
      // too early — reported, never silently pushed
      next.filter(t => t.deps.includes(key) && t.key !== key).forEach(t => {
        const dep = App.subitem(ep, t.key);
        if (dep && dep.start <= s.due) {
          warn.push(ep.code + ': “' + t.name + '” starts ' + plural(App.diffDays(s.due, dep.start) + 1, 'day') +
            ' before “' + name + '” would finish.');
        }
      });
    });
    if (!Object.keys(slots).length) {
      return { reason: 'no_targets', kind: 'addtask',
        error: 'No episode of ' + show.name + ' runs “' + anchor.name + '”, so there’s nowhere to put it.' };
    }

    return {
      kind: 'addtask',
      title: 'Add “' + name + '” ' + position + ' “' + anchor.name + '” in ' + show.name,
      note: plural(dur, 'day') + ' of ' + App.dept(deptKey).label + ' work, added to ' + show.name +
            '’s pipeline so every episode gains it — including ones added later. It starts unassigned, and ' +
            (rewired.length
              ? (position === 'after'
                  ? rewired.join(', ') + ' will wait for it instead of “' + anchor.name + '”.'
                  : '“' + anchor.name + '” will wait for it.')
              : 'nothing else depends on it yet.'),
      lines, warn,
      label: 'Add “' + name + '”',
      run: () => {
        App.mutate(d => {
          const s = d.shows.find(x => x.id === show.id); if (!s) return;
          s.pipeline = next;
          d.episodes.filter(e => e.showId === show.id).forEach(e => {
            if (!slots[e.id]) return;
            e.dates = e.dates || {};
            e.statuses = e.statuses || {};
            e.dates[key] = slots[e.id];
            e.statuses[key] = 'not_started';
            App.refreshReadiness(e);
          });
        }, 'the new task');
        App.track && App.track.audit && App.track.audit('assistant.addTask', {
          show: show.name, task: name, dept: App.dept(deptKey).label,
          position, anchor: anchor.name, days: dur,
          episodes: Object.keys(slots).length, rewired: rewired.join(', ') || null
        });
        return '“' + name + '” added ' + position + ' “' + anchor.name + '” across ' +
          plural(Object.keys(slots).length, 'episode') + ' · unassigned.';
      }
    };
  }

  /* ---- bulk assign an owner ---------------------------------------------

     Owners are per-episode (ep.assignees), so unlike the pipeline edits above
     this writes to every episode individually. The subject may be a department
     ("all Audio Post tasks"), a single pipeline task ("Layout"), or everything.

     Approved work is left alone: reassigning a finished task rewrites who did
     it, which is a different and much worse thing than deciding who does it
     next. */
  function findPerson(phrase) {
    const n = norm(phrase);
    if (!n) return null;
    const people = App.state.data.people.filter(p => App.roleDept(p.role));
    let hit = people.filter(p => norm(p.name) === n);
    if (hit.length === 1) return hit[0];
    hit = people.filter(p => norm(p.name).split(/(?=[A-Z])/).join('').startsWith(n) || norm(p.name).startsWith(n));
    if (hit.length === 1) return hit[0];
    // first name alone, which is how people actually refer to each other
    hit = people.filter(p => norm(p.name.split(/\s+/)[0]) === n);
    return hit.length === 1 ? hit[0] : null;
  }

  function assignPlan(show, subjectPhrase, personPhrase) {
    const pipe = showPipeline(show);
    const eps = showEpisodes(show.id);
    const clearing = personPhrase == null;

    // who is being assigned (or, when clearing, whose work is being cleared)
    const person = findPerson(stripScope(clearing ? subjectPhrase : personPhrase));
    if (!person) {
      const nm = stripScope(clearing ? subjectPhrase : personPhrase).trim();
      return { reason: 'no_person', kind: 'assign',
        error: 'I couldn’t find anyone called “' + nm + '”.',
        hint: 'Team members are: ' + App.state.data.people.filter(p => App.roleDept(p.role)).map(p => p.name).join(', ') + '.' };
    }

    // which tasks: a department, one pipeline task, or everything
    let keys, what;
    if (clearing) {
      keys = pipe.map(t => t.key);
      what = 'everything assigned to ' + person.name;
    } else {
      const deptKey = findDept(stripScope(subjectPhrase).replace(/\s*(?:tasks?|work|subitems?)\s*$/i, '').replace(/^all\s+/i, ''));
      if (deptKey) {
        keys = pipe.filter(t => t.dept === deptKey).map(t => t.key);
        what = 'every ' + App.dept(deptKey).label + ' task';
      } else {
        const found = findTasks(pipe, stripScope(subjectPhrase).replace(/^all\s+/i, ''));
        if (!found.length) {
          return { reason: 'no_task', kind: 'assign',
            error: 'I couldn’t match “' + stripScope(subjectPhrase).trim() + '” to a task or a department in ' + show.name + '.',
            hint: 'Try a department (' + Object.keys(App.DEPARTMENTS).map(k => App.DEPARTMENTS[k].label).join(', ') + ') or a task name.' };
        }
        if (found.length > 1) {
          return { reason: 'ambiguous_task', kind: 'assign',
            error: '“' + stripScope(subjectPhrase).trim() + '” matches ' + found.length + ' tasks — ' +
              found.map(t => '“' + t.name + '”').join(', ') + '.', hint: 'Name one exactly.' };
        }
        keys = [found[0].key];
        what = '“' + found[0].name + '”';
      }
    }
    if (!keys.length) return { reason: 'noop', kind: 'assign', error: 'That matches no tasks in ' + show.name + '’s pipeline.' };

    // a department owner can only be given their own department's work
    const personDept = App.roleDept(person.role);
    const wrongTeam = clearing ? [] : keys.filter(k => {
      const t = pipe.find(x => x.key === k); return t && t.dept !== personDept;
    });

    const lines = [], warn = [];
    let changes = 0, locked = 0;
    eps.forEach(ep => {
      let n = 0, skipped = 0;
      keys.forEach(k => {
        const su = App.subitem(ep, k);
        if (!su) return;
        const cur = su.assignee || null;
        if (clearing) { if (cur !== person.id) return; }
        else if (cur === person.id) return;
        if (su.status === 'approved') { skipped++; return; }
        n++;
      });
      changes += n; locked += skipped;
      const bits = [];
      bits.push(n ? plural(n, 'task') + (clearing ? ' cleared' : ' → ' + person.name) : 'no change');
      if (skipped) bits.push(plural(skipped, 'approved task') + ' left as is');
      lines.push({ code: ep.code, text: bits.join(' · '), muted: !n });
    });
    if (!changes) {
      return { reason: 'noop', kind: 'assign',
        error: clearing
          ? person.name + ' isn’t assigned to anything unapproved in ' + show.name + '.'
          : person.name + ' already owns ' + what + ' across ' + show.name + '.' };
    }
    if (wrongTeam.length) {
      warn.push(person.name + ' is ' + App.dept(personDept).label + ', but ' + plural(wrongTeam.length, 'of these tasks belongs', 'of these tasks belong') +
        ' to another department — they won’t be able to edit those.');
    }

    return {
      kind: 'assign',
      title: clearing
        ? 'Unassign ' + person.name + ' from ' + plural(changes, 'task') + ' in ' + show.name
        : 'Give ' + what + ' to ' + person.name + ' across ' + show.name,
      note: 'Approved work keeps whoever completed it — only unfinished tasks change hands.',
      lines, warn,
      label: clearing ? 'Unassign ' + plural(changes, 'task') : 'Assign ' + plural(changes, 'task'),
      run: () => {
        let n = 0;
        App.mutate(d => {
          eps.forEach(e0 => {
            const e = d.episodes.find(x => x.id === e0.id); if (!e) return;
            e.assignees = e.assignees || {};
            e.statuses = e.statuses || {};
            keys.forEach(k => {
              if ((e.statuses[k] || 'not_started') === 'approved') return;
              const cur = e.assignees[k] || null;
              if (clearing) { if (cur !== person.id) return; delete e.assignees[k]; n++; }
              else { if (cur === person.id) return; e.assignees[k] = person.id; n++; }
            });
            App.refreshReadiness(e);
          });
        }, clearing ? 'the unassignment' : 'the assignment');
        App.track && App.track.audit && App.track.audit('assistant.assign', {
          show: show.name, person: person.name, tasks: n, cleared: clearing
        });
        return clearing
          ? person.name + ' unassigned from ' + plural(n, 'task') + ' in ' + show.name + '.'
          : person.name + ' now owns ' + plural(n, 'task') + ' across ' + show.name + '.';
      }
    };
  }

  /* ---- shift dates -------------------------------------------------------

     The one thing the assistant couldn't do until now: move work. Two shapes,
     because they're the two ways a slip actually gets described —

       "move LA-102 two weeks later"          a whole episode
       "push everything after Layout out a week"   a task and its tail

     Approved work never moves, as everywhere else. Live dates never move
     either: they're commitments, and a slip that quietly drags the live date
     with it hides the exact thing worth seeing — so running past one is
     reported, loudly, and the producer decides. */
  const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

  function parseSpan(text) {
    const m = text.match(/(?:by\s+)?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*(day|week|month)s?\b/i);
    if (!m) return null;
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : WORD_NUM[m[1].toLowerCase()];
    if (!n) return null;
    const unit = m[2].toLowerCase();
    return n * (unit === 'week' ? 7 : unit === 'month' ? 30 : 1);
  }

  // "later/out/back/forward" push into the future; "earlier/in/up" pull back
  function parseDirection(text) {
    if (/\b(?:earlier|sooner|forward\s+to|up|in\s+by)\b/i.test(text)) return -1;
    if (/\b(?:later|out|back|forward|further)\b/i.test(text)) return 1;
    return 1;                        // a bare "delay it 3 days" means later
  }

  function shiftPlan(show, rest) {
    const days = parseSpan(rest);
    if (!days) return null;                     // no duration → not a shift
    const dir = parseDirection(rest);
    const delta = days * dir;

    // strip the duration/direction tail to leave the subject
    const subject = rest
      .replace(/(?:by\s+)?(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:day|week|month)s?\b.*$/i, '')
      .replace(/\b(?:out|back|forward|later|earlier|further|up)\b\s*$/i, '')
      .trim();

    const eps = showEpisodes(show.id);
    const pipe = showPipeline(show);
    let targets, what, fromKey = null;

    const tail = subject.match(/^(?:everything|all|the\s+rest)\s+(?:after|from|beyond|past)\s+(.+)$/i);
    if (tail) {
      const found = findTasks(pipe, stripScope(tail[1]));
      if (!found.length) {
        return { reason: 'no_task', kind: 'shift',
          error: 'There’s no task called “' + stripScope(tail[1]).trim() + '” in ' + show.name + '’s pipeline.',
          hint: 'Its tasks are: ' + pipe.map(t => t.name).join(', ') + '.' };
      }
      if (found.length > 1) {
        return { reason: 'ambiguous_task', kind: 'shift',
          error: '“' + stripScope(tail[1]).trim() + '” matches ' + found.length + ' tasks — ' +
            found.map(t => '“' + t.name + '”').join(', ') + '.', hint: 'Name one exactly.' };
      }
      fromKey = found[0].key;
      targets = eps;
      what = 'everything from “' + found[0].name + '” onward';
    } else if (/^(?:everything|all|the\s+(?:whole\s+)?show|it)$/i.test(subject) || !subject) {
      targets = eps;
      what = 'every unapproved task';
    } else {
      const ep = findEpisode(eps, stripScope(subject));
      if (!ep) return null;                     // can't tell what's being moved
      targets = [ep];
      what = ep.code;
    }
    if (!targets.length) return { reason: 'noop', kind: 'shift', error: 'There’s nothing to move in ' + show.name + '.' };

    /* Which tasks move: from `fromKey` onward means the task itself plus
       everything that transitively depends on it — the tail of the graph, not
       simply the tasks with later dates, so a parallel strand that doesn't
       depend on it stays put. */
    const tailKeys = (() => {
      if (!fromKey) return null;
      const out = new Set([fromKey]);
      let grew = true;
      while (grew) {
        grew = false;
        pipe.forEach(t => {
          if (out.has(t.key)) return;
          if (t.deps.some(d => out.has(d))) { out.add(t.key); grew = true; }
        });
      }
      return out;
    })();

    const lines = [], warn = [];
    let moving = 0, locked = 0;
    targets.forEach(ep => {
      let n = 0, skipped = 0, last = '0000-00-00';
      App.subitems(ep).forEach(su => {
        if (tailKeys && !tailKeys.has(su.key)) return;
        if (su.status === 'approved') { skipped++; if (su.due > last) last = su.due; return; }
        n++;
        const due = App.shiftIso(su.due, delta);
        if (due > last) last = due;
      });
      moving += n; locked += skipped;
      const bits = [n ? plural(n, 'task') + ' move' : 'nothing to move'];
      if (skipped) bits.push(plural(skipped, 'approved task') + ' stay put');
      lines.push({ code: ep.code, text: bits.join(' · '), muted: !n });

      const live = App.epMilestone(ep, App.LIVE_KEY);
      if (n && live && last >= live.date) {
        warn.push(ep.code + ' would run to ' + App.fmtDate(last) + ', on or past its live date (' +
          App.fmtDate(live.date) + ').');
      }
    });
    if (!moving) {
      return { reason: 'noop', kind: 'shift',
        error: 'Nothing there can move — every matching task is already approved.' };
    }

    const dirWord = delta > 0 ? 'later' : 'earlier';
    return {
      kind: 'shift',
      title: 'Move ' + what + ' ' + plural(Math.abs(delta), 'day') + ' ' + dirWord + ' in ' + show.name,
      note: 'Approved work stays exactly where it is. Live dates don’t move — they’re commitments, so a schedule running past one is flagged rather than absorbed.',
      lines, warn,
      label: 'Shift ' + plural(moving, 'task'),
      run: () => {
        let n = 0;
        App.mutate(d => {
          targets.forEach(e0 => {
            const e = d.episodes.find(x => x.id === e0.id); if (!e) return;
            const subs = App.subitems(e);            // snapshot before writing
            e.dates = e.dates || {};
            e.statuses = e.statuses || {};
            subs.forEach(su => {
              if (tailKeys && !tailKeys.has(su.key)) return;
              if (su.status === 'approved') return;
              e.dates[su.key] = { start: App.shiftIso(su.start, delta), due: App.shiftIso(su.due, delta) };
              n++;
            });
            App.refreshReadiness(e);
          });
        }, 'the shift');
        App.track && App.track.audit && App.track.audit('assistant.shift', {
          show: show.name, subject: what, days: delta, tasksMoved: n, tasksLocked: locked
        });
        return plural(n, 'task') + ' moved ' + Math.abs(delta) + ' days ' + dirWord +
          (locked ? ' · ' + plural(locked, 'approved task') + ' left in place' : '') + '.';
      }
    };
  }

  /* ---- fit the show to a deadline ---------------------------------------

     Squeezes or stretches every task's nominal duration so the show's critical
     path lands on a target date. App.solveScale already does the hard part — a
     binary search over a monotonic end(scale) — and it has been sitting unused
     outside the Add Show planner. No task ever drops below its minDays, so a
     target that simply can't be met comes back clamped and says so.

     This is the most invasive thing here: it rewrites every unapproved date in
     the show. Hence the loudest preview. */
  function parseWhen(text) {
    const s = stripScope(text).trim();
    const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[0];
    const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    const m = s.match(/([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i) ||
              s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)(?:,?\s*(\d{4}))?/i);
    if (!m) return null;
    let name = m[1], day = m[2];
    if (/^\d+$/.test(name)) { const t = name; name = day; day = t; }
    const mi = MONTHS.findIndex(x => x.startsWith(String(name).toLowerCase().slice(0, 3)));
    if (mi < 0) return null;
    const today = App.today();
    let year = m[3] ? parseInt(m[3], 10) : today.getFullYear();
    const cand = new Date(year, mi, parseInt(day, 10));
    // a bare month/day that has already passed means next year
    if (!m[3] && cand < today) year++;
    return App.isoDate(new Date(year, mi, parseInt(day, 10)));
  }

  function fitPlan(show, whenPhrase) {
    const target = parseWhen(whenPhrase);
    if (!target) return null;                    // not a date → not a fit

    const eps = showEpisodes(show.id).filter(ep => !App.isDelivered(ep));
    if (!eps.length) return { reason: 'no_targets', kind: 'fit', error: 'Every episode of ' + show.name + ' is already delivered.' };

    const pipe = showPipeline(show);
    const startIso = eps.reduce((m, ep) => { const s = App.epStart(ep); return s < m ? s : m; }, '9999-99-99');
    const today = App.isoDate(App.today());
    if (target <= today) {
      return { reason: 'bad_date', kind: 'fit',
        error: App.fmtDate(target) + ' is in the past — pick a date ahead of today.' };
    }

    // cadence: the average gap between episode starts, which is what the
    // show was actually planned on
    const starts = eps.map(ep => App.epStart(ep)).sort();
    const cadence = starts.length > 1
      ? Math.max(1, Math.round(App.diffDays(starts[starts.length - 1], starts[0]) / (starts.length - 1)))
      : 1;

    const solved = App.solveScale(pipe, startIso, eps.length, cadence, target);
    if (!solved) {
      return { reason: 'cycle', kind: 'fit', error: show.name + '’s pipeline has a dependency cycle, so it can’t be scheduled.' };
    }

    const current = App.scheduleShow(pipe, startIso, eps.length, cadence, 1);
    const lines = [], warn = [];
    const pct = Math.round(solved.scale * 100);
    lines.push({ code: 'Now', text: 'critical path ends ' + App.fmtDate(current.end) });
    lines.push({ code: 'Target', text: App.fmtDate(target) });
    lines.push({ code: 'Fitted', text: 'ends ' + App.fmtDate(solved.end) + ' · durations at ' + pct + '% of nominal' });

    if (solved.clamped) {
      warn.push('Even at every task’s minimum duration the show can’t finish before ' +
        App.fmtDate(solved.end) + ' — that’s ' + plural(App.diffDays(solved.end, target), 'day') + ' past your target.');
    }
    if (solved.scale < 1) {
      warn.push('This compresses the plan. Durations shrink toward each task’s minDays; nothing goes below it.');
    }
    eps.forEach(ep => {
      const approved = App.subitems(ep).filter(s => s.status === 'approved').length;
      if (approved) warn.push(ep.code + ' has ' + plural(approved, 'approved task') + ' that will not move, so its dates will not match the fitted plan exactly.');
    });

    return {
      kind: 'fit',
      title: 'Fit ' + show.name + ' to ' + App.fmtDate(target),
      note: 'Rewrites every unapproved date in ' + plural(eps.length, 'episode') + ', rescheduling each from its own start with durations scaled to ' + pct + '%. The most far-reaching change here — one undo puts it all back.',
      lines, warn,
      label: solved.clamped ? 'Compress as far as it goes' : 'Fit to ' + App.fmtDate(target),
      run: () => {
        let n = 0, locked = 0;
        App.mutate(d => {
          eps.forEach(e0 => {
            const e = d.episodes.find(x => x.id === e0.id); if (!e) return;
            const base = App.epStart(e);
            const sched = App.schedulePipeline(pipe, base, solved.scale);
            if (!sched) return;
            e.dates = e.dates || {};
            e.statuses = e.statuses || {};
            Object.keys(sched.dates).forEach(k => {
              if ((e.statuses[k] || 'not_started') === 'approved') { locked++; return; }
              e.dates[k] = sched.dates[k];
              n++;
            });
            App.refreshReadiness(e);
          });
        }, 'the refit');
        App.track && App.track.audit && App.track.audit('assistant.fit', {
          show: show.name, target, scale: solved.scale, end: solved.end, tasks: n, locked
        });
        return show.name + ' refitted — ' + plural(n, 'task') + ' rescheduled, ending ' + App.fmtDate(solved.end) + '.';
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
    /* Permission is checked per intent rather than up front: a department
       owner may not move dates, but nothing stops them asking what's blocked.
       The check happens only once an intent has claimed the sentence, so a
       refusal always names the thing being refused. */
    for (const intent of INTENTS) {
      const m = q.match(intent.re);
      if (!m) continue;
      const plan = intent.build(show, m, q);
      if (!plan) continue;                       // "not my sentence" — keep looking
      const perm = intent.perm && PERM[intent.perm];
      if (perm && !perm.test()) return { reason: 'no_permission', error: perm.deny };
      return plan;
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
    if (r === 'no_task' || r === 'ambiguous_task' || r === 'no_episode' || r === 'no_person')
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

    /* Questions first, and only when there's actually something to report —
       "What's blocked?" is a poor suggestion on a show with nothing blocked.
       They cost nothing to run and need no permission, so they're the right
       opener for anyone whose role can't change the schedule at all. */
    if (eps.some(e => App.epBlockedCount(e) > 0)) push('q:blocked', 'What’s blocked?');
    if (eps.some(e => App.epOverdueCount(e) > 0)) push('q:overdue', 'What’s overdue?');
    push('q:due', 'What’s due this week?');

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

    /* A department move is only worth suggesting when the pipeline gives a
       reason to think one is misfiled — a lone task sitting in a department
       nothing else around it belongs to. Anything more speculative than that
       would be noise. */
    const deptCount = {};
    pipe.forEach(t => { deptCount[t.dept] = (deptCount[t.dept] || 0) + 1; });
    const lonely = pipe.find(t => deptCount[t.dept] === 1);
    if (lonely) {
      const neighbour = pipe.find(t => t.key !== lonely.key && t.deps.includes(lonely.key)) ||
                        pipe.find(t => lonely.deps.includes(t.key));
      if (neighbour && neighbour.dept !== lonely.dept) {
        push('dept:' + lonely.key, 'Move ' + lonely.name + ' to ' + App.dept(neighbour.dept).label);
      }
    }

    /* A department move deliberately leaves the task ownerless, so the very
       next thing anyone wants is to name who picks it up. Offer whoever is
       actually in the receiving department. */
    // scanned across every episode, not just the first: the episode that lost
    // its owner is rarely the earliest one, and checking only eps[0] misses the
    // very handover this is here to offer
    const orphan = pipe.find(t => eps.some(ep => {
      const su = App.subitem(ep, t.key);
      return su && !su.assignee && su.status !== 'approved';
    }));
    if (orphan) {
      const staff = App.state.data.people.filter(p => App.roleDept(p.role) === orphan.dept);
      if (staff.length) push('assign:' + orphan.key, 'Give ' + orphan.name + ' to ' + staff[0].name);
    }

    /* Follow the thread — the next move usually depends on the last one. After
       a question, offer a change; after a change, offer the question that
       shows what it did; after a department move, offer the handover. */
    const lead = after === 'dept' ? 'assign:'
               : after === 'dep' ? 'rep:'
               : after === 'replicate' ? 'undep:'
               : after === 'query' ? 'rep:'
               : after ? 'q:' : null;
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
      if (plan.answer) { this.drawAnswer(plan); return; }
      this.drawPlan(q, plan);
    },

    /* A question is answered and finished with — there's nothing to preview
       and nothing to apply, so it gets the reply and the follow-up chips
       without the plan card's machinery. */
    drawAnswer(plan) {
      const card = plan.lines.length || plan.note ? el('.ai-plan.ai-answer') : null;
      if (card) {
        if (plan.lines.length) {
          const list = el('.ai-rows');
          plan.lines.forEach(l => list.appendChild(el('.ai-row' + (l.muted ? '.muted' : ''), null, [
            el('span.ai-row-code', null, l.code),
            el('span.ai-row-text', null, l.text)
          ])));
          card.appendChild(list);
        }
        if (plan.note) card.appendChild(el('.ai-plan-note', null, plan.note));
      }
      this.say('assistant', plan.title, card);
      this.offer('query');
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
