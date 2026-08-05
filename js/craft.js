/* Pipeline crafting — turning a production brief into a specific pipeline.

   The knowledge base says what the studio *can* do. This decides what a
   particular show actually needs: a returning season doesn't rebuild its rigs,
   a library-music show doesn't record vocals, a compliance-heavy broadcaster
   delivery earns an extra QC round.

   Two inputs drive it:
     • the Production Brief, read for concrete signals (returning season, reuse,
       new IP, library music, hard date, compliance…)
     • the priority sliders, which trade revision rounds against time and money

   Every decision carries its reason, and every one is overridable. The point is
   a pipeline a producer can audit and argue with — not a black box. Cutting
   revisions is surfaced as a RISK rather than a saving, because that's what it
   is: the work doesn't disappear, it just stops being budgeted. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const KB = () => App.taskKb;

  /* ---- brief signals -----------------------------------------------------
     Deliberately conservative patterns. A false positive silently removes work
     from a plan, which is worse than missing a hint the producer can toggle on. */
  const SIGNALS = [
    { key: 'returningSeason', label: 'Returning season',
      hint: 'Series-level design and build already exist',
      patterns: [/\bseason\s*([2-9]|\d\d)\b/i, /\breturning\b/i, /\bS([2-9]|\d\d)\b/, /\bsecond|third|fourth season\b/i, /\brenewal\b/i] },
    { key: 'reuseAssets', label: 'Reuses existing assets',
      hint: 'Rigs, designs or sets carried over',
      patterns: [/\breus(e|ing)\b/i, /\bexisting (rig|asset|design|model|set)/i, /\bcarry(ing)? over\b/i, /\bsame (rig|cast|design)/i] },
    { key: 'newIp', label: 'New IP',
      hint: 'Original property — design needs more rounds',
      patterns: [/\bnew (ip|series|show|property|format)\b/i, /\boriginal series\b/i, /\bfrom scratch\b/i, /\bgreenfield\b/i] },
    { key: 'pilot', label: 'Pilot / proof of concept',
      hint: 'Single-episode proof, lighter finishing',
      patterns: [/\bpilot\b/i, /\bproof of concept\b/i, /\bsizzle\b/i, /\btaster\b/i] },
    { key: 'hardDate', label: 'Hard delivery date',
      hint: 'Fixed slot — schedule risk matters more than polish',
      patterns: [/\bhard (deadline|date|slot)\b/i, /\bmust (hit|deliver|land)\b/i, /\bbroadcast slot\b/i, /\bair date\b/i, /\bimmovable\b/i] },
    { key: 'premium', label: 'Premium / flagship',
      hint: 'Higher finish bar — more revision rounds',
      patterns: [/\bpremium\b/i, /\bflagship\b/i, /\btentpole\b/i, /\bhigh[- ]end\b/i, /\bawards\b/i] },
    { key: 'compliance', label: 'Compliance-heavy',
      hint: 'Broadcaster or regulatory review',
      patterns: [/\bcompliance\b/i, /\bbroadcaster\b/i, /\bofcom\b/i, /\bclearance\b/i, /\bregulat/i, /\bnetwork notes\b/i] },
    { key: 'libraryMusic', label: 'Library music',
      hint: 'No original composition or vocal sessions',
      patterns: [/\blibrary music\b/i, /\bstock music\b/i, /\bno original (music|song)/i, /\bproduction music\b/i] },
    { key: 'noSubtitles', label: 'No subtitles required',
      hint: 'Subtitle pass not in the deliverable spec',
      // the last two catch the same statement phrased as a negation of the noun
      // ("subtitles are not required"), which the "no subtitle" forms miss
      patterns: [/\bno subtitle/i, /\bwithout subtitle/i, /\bno caption/i,
                 /\bsubtitles?\b[^.;,]{0,24}\bnot\s+(?:required|needed|in scope|applicable)\b/i,
                 /\bcaptions?\b[^.;,]{0,24}\bnot\s+(?:required|needed|in scope|applicable)\b/i] },
    { key: 'localisation', label: 'Localisation',
      hint: 'Multi-language delivery — subtitle work grows',
      patterns: [/\blocalis|\blocaliz/i, /\bmulti[- ]language\b/i, /\bdub(bing|bed)?\b/i, /\bterritor(y|ies)\b/i] }
  ];

  /* ---- negation scope -----------------------------------------------------
     Keyword matching alone reads "we are NOT reusing the rigs" as reuse. Rather
     than guess at intent, we do what clinical NLP does for the same problem
     (NegEx): look for a negation cue in the clause immediately before a match,
     stopping at a clause boundary so a cue can't leak across "…, but…".

     Two properties make this safe to rely on:

     • A cue that is part of the match itself never cancels it. "no original
       music" IS the library-music signal — the window we inspect ends where the
       match begins, so its own "no" is never seen as external negation.

     • The failure mode is deliberate. A false cancel means the planner keeps
       tasks it might not need; a missed negation would silently delete work
       from a budget. So when in doubt this errs toward planning MORE work, and
       every cancellation is shown to the producer to accept or override. */
  /* A comma ends the cue's reach too. "No new designs, reusing existing rigs"
     asserts reuse — without the comma break the leading "No" would cancel it.
     Erring this way keeps work in the plan, which is the safe direction. */
  const CLAUSE_BREAK = /[.;!?,]|\b(?:but|however|although|though|except|whereas|otherwise|aside from|that said)\b/gi;
  const NEG_CUE = new RegExp([
    '\\b(?:no|not|never|none|without|sans|excluding|exclude[sd]?|omit(?:ting|ted)?',
    '|avoid(?:ing)?|skip(?:ping)?|drop(?:ping)?|minus|lacking|zero)\\b',
    "|\\b(?:won'?t|will not|would not|wouldn'?t|do(?:es)?\\s*n[o']?t|did not|didn'?t",
    "|is\\s*n[o']?t|are\\s*n[o']?t|cannot|can'?t|shan'?t|rather than|instead of|as opposed to",
    '|no need (?:for|to)|not going to|nothing (?:to|for))\\b'
  ].join(''), 'i');
  const NEG_POST = /\b(?:not (?:required|needed|applicable|in scope|planned)|is\s*n[o']?t (?:required|needed)|are\s*n[o']?t (?:required|needed)|out of scope|n\/a|won'?t be (?:needed|required))\b/i;

  const WINDOW_WORDS = 9;      // how far back a cue can reach

  // the clause fragment immediately before `idx`, capped to a few words
  function clauseBefore(text, idx) {
    const pre = text.slice(0, idx);
    CLAUSE_BREAK.lastIndex = 0;
    let cut = 0, m;
    while ((m = CLAUSE_BREAK.exec(pre)) !== null) cut = m.index + m[0].length;
    const words = pre.slice(cut).trim().split(/\s+/).filter(Boolean);
    return words.slice(-WINDOW_WORDS).join(' ');
  }
  // and the fragment just after, for "subtitles are not required"
  function clauseAfter(text, endIdx) {
    const post = text.slice(endIdx, endIdx + 90);
    CLAUSE_BREAK.lastIndex = 0;
    const m = CLAUSE_BREAK.exec(post);
    return m ? post.slice(0, m.index) : post;
  }

  function negationAround(text, start, end) {
    const before = clauseBefore(text, start);
    const hit = before.match(NEG_CUE);
    if (hit) return hit[0];
    const after = clauseAfter(text, end);
    const hitAfter = after.match(NEG_POST);
    return hitAfter ? hitAfter[0] : null;
  }

  /* A signal survives if ANY of its matches is un-negated — "no library music,
     we're scoring it live" shouldn't be cancelled by an unrelated earlier "no". */
  function detectSignals(intake) {
    const text = String(intake.brief || '') + ' ' + String(intake.name || '');
    const found = {}, cancelled = {};
    SIGNALS.forEach(s => {
      let survived = null, blockedBy = null, blockedText = null;
      s.patterns.forEach(re => {
        if (survived) return;
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
        let m;
        while ((m = g.exec(text)) !== null) {
          if (m[0] === '') { g.lastIndex++; continue; }
          const neg = negationAround(text, m.index, m.index + m[0].length);
          if (!neg) { survived = m[0].trim(); break; }
          if (!blockedBy) { blockedBy = neg; blockedText = m[0].trim(); }
        }
      });
      if (survived) found[s.key] = { label: s.label, hint: s.hint, matched: survived };
      else if (blockedBy) cancelled[s.key] = { label: s.label, matched: blockedText, cue: blockedBy };
    });
    return { found, cancelled };
  }

  /* ---- rules ------------------------------------------------------------
     `skip` removes a task; `rev` adjusts its revision rounds. Matching is by
     task name so the rules survive library edits and re-seeds. */
  const SKIP_ON_RETURNING = ['Series Bible', 'Style Guide', 'Character Design', 'Environment & Prop Design', 'Rigging'];
  const MUSIC_ORIGINAL = ['Theme & Title Music', 'Song Composition', 'Vocal Record', 'Vocal Comp & Tuning', 'Score Record'];

  function applyRules(tasks, signals, intake, cancelled) {
    cancelled = cancelled || {};
    const notes = [];
    const byName = (n) => tasks.filter(t => t.name === n);
    const skip = (names, why) => names.forEach(n => byName(n).forEach(t => {
      if (!t.include) return;
      t.include = false;
      t.reasons.push({ kind: 'skip', text: why });
      notes.push({ tone: 'ok', text: 'Skipped ' + t.name + ' — ' + why });
    }));
    const bump = (names, delta, why, tone) => names.forEach(n => byName(n).forEach(t => {
      if (!t.include) return;
      const next = Math.max(0, t.rev + delta);
      if (next === t.rev) return;
      t.reasons.push({ kind: delta > 0 ? 'more' : 'less', text: why });
      t.rev = next;
      notes.push({ tone: tone || (delta > 0 ? 'info' : 'warn'),
                   text: t.name + ' → ' + next + ' revision round' + (next === 1 ? '' : 's') + ' — ' + why });
    }));

    // ---- brief-driven ----
    /* "Season 5. Not reusing existing rigs — full rebuild" matches BOTH a
       returning season and a negated reuse. The season number is an inference;
       the denial is explicit, so it wins. Dropping a rig build on an inference
       the brief directly contradicts is exactly the mistake worth blocking. */
    const reuseDenied = !!cancelled.reuseAssets;
    if ((signals.returningSeason || signals.reuseAssets) && !reuseDenied) {
      skip(SKIP_ON_RETURNING, signals.returningSeason ? 'returning season, series design already exists' : 'brief says assets are reused');
    } else if (signals.returningSeason && reuseDenied) {
      notes.push({ tone: 'warn', text: 'Returning season, but the brief says assets are NOT reused — series design and build kept in the plan.' });
    }
    if (signals.newIp) bump(['Series Bible', 'Style Guide', 'Character Design'], 1, 'new IP — design lands after more rounds', 'info');
    if (signals.premium) bump(['Animation', 'Colour Grade', 'Final Mix', 'Fine Cut'], 1, 'premium finish bar', 'info');
    if (signals.compliance) bump(['Compliance QC'], 1, 'broadcaster compliance review', 'info');
    if (signals.libraryMusic) skip(MUSIC_ORIGINAL, 'library music — no original composition');
    if (signals.noSubtitles) skip(['Subtitles & Captions'], 'not in the deliverable spec');
    if (signals.localisation) bump(['Subtitles & Captions'], 1, 'multi-language delivery', 'info');
    if (signals.pilot) {
      skip(['Archive & Wrap'], 'pilot — no series archive pass');
      bump(['Compliance QC'], -1, 'pilot is not a broadcast master', 'ok');
    }

    // ---- slider-driven ----
    // Cutting rounds is the only real lever left once scope is set, so it's
    // reported as accepted risk rather than an efficiency.
    const pr = intake.priorities || {};
    if ((pr.timeline || 3) >= 4) {
      const heavy = tasks.filter(t => t.include && t.rev >= 2).map(t => t.name);
      bump(heavy, -1, 'timeline aggressiveness ' + pr.timeline + '/5 — a round removed, notes may land late', 'warn');
    }
    if ((pr.budget || 3) === 5) {
      const heavy = tasks.filter(t => t.include && t.rev >= 2).map(t => t.name);
      bump(heavy, -1, 'hard budget ceiling — a further round removed', 'warn');
    }
    return notes;
  }

  /* Build a crafted pipeline for a proposal. Any manual override the producer
     has already made is preserved — re-crafting refreshes the reasoning without
     throwing away a decision someone made deliberately. */
  function craftPipeline(p, opts) {
    const keepOverrides = !(opts && opts.fresh) && p.craft ? p.craft.tasks : null;
    const overrideBy = {};
    (keepOverrides || []).forEach(t => { if (t.manual) overrideBy[t.id] = t; });

    const tasks = KB().tasksFor(p.intake.type).map(t => ({
      id: t.id, name: t.name, dept: t.dept, scope: t.scope, stage: t.stage,
      days: t.days, revDays: t.revDays, baseRev: t.rev, rev: t.rev,
      include: true, manual: false, reasons: []
    }));
    const det = detectSignals(p.intake);
    const signals = det.found, cancelled = det.cancelled;
    const notes = applyRules(tasks, signals, p.intake, cancelled);
    // surface what negation stopped, so a cancelled rule is a visible decision
    Object.keys(cancelled).forEach(k => notes.push({
      tone: 'info',
      text: cancelled[k].label + ' ignored — “' + cancelled[k].matched + '” is negated by “' + cancelled[k].cue + '”'
    }));

    // re-apply anything the producer set by hand
    tasks.forEach(t => {
      const o = overrideBy[t.id];
      if (!o) return;
      t.include = o.include; t.rev = o.rev; t.manual = true;
      t.reasons.push({ kind: 'manual', text: 'set by hand' });
    });

    return { tasks, signals, cancelled, notes, craftedAt: new Date().toISOString(), episodes: p.intake.episodes };
  }

  const saveCraft = (id, craft) => App.mutate(d => {
    const p = (d.proposals || []).find(x => x.id === id);
    if (p) { p.craft = craft; p.variants = null; }   // plan changed → report is stale
  });
  const clearCraft = (id) => App.mutate(d => {
    const p = (d.proposals || []).find(x => x.id === id);
    if (p) { delete p.craft; p.variants = null; }
  });

  // the task list the scheduler should use: crafted if present, else the library
  function effectiveTasks(p) {
    if (p.craft && p.craft.tasks) {
      return p.craft.tasks.filter(t => t.include)
        .map(t => ({ id: t.id, name: t.name, dept: t.dept, scope: t.scope, stage: t.stage,
                     days: t.days, rev: t.rev, revDays: t.revDays }));
    }
    return KB().tasksFor(p.intake.type);
  }

  const totalDays = (tasks, eps) => tasks.reduce((s, t) =>
    s + KB().taskDays(t) * (t.scope === 'series' ? 1 : Math.max(1, eps || 1)), 0);

  /* ---- export to a reusable pipeline preset -----------------------------
     Bridges planning to production: a crafted pipeline becomes a preset Add Show
     can build a real board from. Dependencies come from the stage ordering —
     every task waits on the previous populated stage — which yields a valid DAG
     without anyone drawing one. minDays is the base pass, so a squeeze can eat
     into revisions but never into the work itself. */
  function toPreset(p, name) {
    const chosen = effectiveTasks(p).slice().sort((a, b) => (a.stage - b.stage) || (a.dept < b.dept ? -1 : 1));
    const stages = [...new Set(chosen.map(t => t.stage))].sort((a, b) => a - b);
    const keyOf = (t) => (t.dept + '_' + t.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    const byStage = {};
    chosen.forEach(t => (byStage[t.stage] = byStage[t.stage] || []).push(t));

    const pipeline = [];
    stages.forEach((st, i) => {
      const prev = i > 0 ? byStage[stages[i - 1]].map(keyOf) : [];
      byStage[st].forEach(t => {
        pipeline.push({
          key: keyOf(t), name: t.name, dept: t.dept,
          days: KB().taskDays(t),                       // base + every revision round
          minDays: Math.max(1, t.days || 1),            // the first pass is the floor
          deps: prev.slice()
        });
      });
    });
    return { id: App.uid(), name: name, type: p.intake.type, pipeline, source: 'craft:' + p.id };
  }

  function savePreset(preset) {
    App.mutate(d => {
      d.pipelinePresets = d.pipelinePresets || [];
      d.pipelinePresets.push(preset);
    });
  }

  /* ============================================================== editor === */
  function editor(p) {
    const craft = p.craft || craftPipeline(p);
    const tasks = JSON.parse(JSON.stringify(craft.tasks));
    const signals = craft.signals || {};
    const eps = p.intake.episodes || 1;
    const go = (v) => { App.state.planning.view = v; App.render(); };

    const box = el('div');
    box.appendChild(el('.pl-crumb', null, [
      el('span.pl-crumb-link', { onclick: () => go('hub') }, 'Planning'),
      el('span', null, '/'),
      el('span.pl-crumb-here', null, 'Crafted pipeline')
    ]));
    box.appendChild(el('.pl-head', null, [
      el('div', null, [
        el('.pl-title', null, 'Crafted pipeline — ' + (p.intake.name || 'Untitled')),
        el('.pl-sub', null, 'The knowledge base filtered down to what this show actually needs, read from the brief and the priority sliders. Every call is overridable.')
      ]),
      el('.pl-head-actions', null, [
        el('button.btn-ghost', {
          title: 'Re-read the brief and rebuild, keeping hand-set rows',
          onclick: () => { saveCraft(p.id, craftPipeline(p)); App.toast('Re-crafted from the brief'); }
        }, [App.icon('sparkle'), ' Re-craft'])
      ])
    ]));

    // ---- signals ----
    const sigKeys = Object.keys(signals);
    const cancelled = craft.cancelled || {};
    const cancelKeys = Object.keys(cancelled);
    const sigBody = el('.pl-card-body');
    sigBody.appendChild(sigKeys.length
      ? el('.pl-sigs', null, sigKeys.map(k => el('.pl-sig', { title: signals[k].hint }, [
          el('span.pl-sig-lab', null, signals[k].label),
          el('span.pl-sig-hit', null, '“' + signals[k].matched + '”')
        ])))
      : el('.pl-sig-none', null, 'Nothing detected'));
    // negated matches, shown rather than dropped quietly
    if (cancelKeys.length) {
      sigBody.appendChild(el('.pl-sig-cancel-lab', null, 'Ignored — negated in the brief'));
      sigBody.appendChild(el('.pl-sigs', null, cancelKeys.map(k =>
        el('.pl-sig.cancelled', { title: 'Matched “' + cancelled[k].matched + '” but it is negated, so the rule did not fire' }, [
          el('span.pl-sig-lab', null, cancelled[k].label),
          el('span.pl-sig-hit', null, '“' + cancelled[k].cue + ' … ' + cancelled[k].matched + '”')
        ]))));
    }
    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Signals read from the brief'),
        el('.pl-card-desc', null, sigKeys.length || cancelKeys.length
          ? 'Matched phrases in the Production Brief. A match inside a negated clause is ignored — “not reusing the rigs” doesn’t count as reuse.'
          : 'No recognised signals — the full library is planned. Mention things like “returning season”, “library music” or “compliance” in the brief to narrow it.')
      ]),
      sigBody
    ]));

    // ---- effect summary ----
    const statsBox = el('.pl-stats');
    const included = () => tasks.filter(t => t.include);
    function refreshStats() {
      const full = KB().tasksFor(p.intake.type);
      const fullDays = totalDays(full, eps);
      const nowDays = totalDays(included().map(t => ({ ...t, rev: t.rev })), eps);
      const cutRev = tasks.filter(t => t.include && t.rev < t.baseRev).length;
      statsBox.innerHTML = '';
      statsBox.appendChild(el('.pl-stat', null, [
        el('.pl-stat-lab', null, 'Tasks planned'),
        el('.pl-stat-val', null, included().length + ' of ' + tasks.length),
        el('.pl-stat-sub', null, (tasks.length - included().length) + ' skipped for this show')
      ]));
      statsBox.appendChild(el('.pl-stat' + (nowDays < fullDays ? '.good' : ''), null, [
        el('.pl-stat-lab', null, 'Task-days'),
        el('.pl-stat-val', null, nowDays + ''),
        el('.pl-stat-sub', null, nowDays === fullDays ? 'same as the full library'
          : (fullDays - nowDays) + ' fewer than the full library (' + fullDays + ')')
      ]));
      statsBox.appendChild(el('.pl-stat' + (cutRev ? '.bad' : ''), null, [
        el('.pl-stat-lab', null, 'Revision risk'),
        el('.pl-stat-val', null, cutRev ? cutRev + ' tasks' : 'none'),
        el('.pl-stat-sub', null, cutRev ? 'have had a round removed' : 'all rounds intact')
      ]));
    }

    // ---- decisions ----
    if (craft.notes && craft.notes.length) {
      const notes = el('.pl-notes');
      craft.notes.forEach(n => notes.appendChild(el('.pl-note.' + (n.tone || 'info'), null, [
        App.icon(n.tone === 'warn' ? 'warn' : n.tone === 'ok' ? 'unlock' : 'sparkle'),
        el('span', null, n.text)
      ])));
      box.appendChild(el('.pl-card', null, [
        el('.pl-card-head', null, [
          el('.pl-card-title', null, 'Decisions'),
          el('.pl-card-desc', null, 'Amber entries are accepted risk — the work still exists, it just isn’t budgeted.')
        ]),
        el('.pl-card-body', null, notes)
      ]));
    }

    // ---- task table ----
    const table = el('.pl-kb');
    function render() {
      table.innerHTML = '';
      table.appendChild(el('.pl-craft-head', null, [
        el('.cell', null, 'Task'), el('.cell', null, 'Scope'), el('.cell', null, 'Stage'),
        el('.cell', null, 'Days'), el('.cell', null, 'Revisions'), el('.cell', null, 'Total'),
        el('.cell', null, 'Why')
      ]));
      KB().DEPT_ORDER.forEach(dept => {
        const rows = tasks.filter(t => t.dept === dept);
        if (!rows.length) return;
        const dep = App.dept(dept);
        table.appendChild(el('.pl-kb-group', null, el('.pl-rate-group-name', null, [
          el('span.dot', { style: { background: dep.color } }),
          el('span', null, dep.label),
          el('span.pl-rate-count', null, rows.filter(t => t.include).length + ' of ' + rows.length)
        ])));
        rows.forEach(t => {
          const chk = el('input', { type: 'checkbox' });
          chk.checked = t.include;
          chk.addEventListener('change', () => {
            t.include = chk.checked; t.manual = true;
            render(); refreshStats();
          });
          const revI = el('input.fld.pl-kb-num', { type: 'number', min: '0', max: '10', value: String(t.rev) });
          revI.disabled = !t.include;
          revI.addEventListener('input', () => {
            t.rev = Math.max(0, Math.min(10, parseInt(revI.value, 10) || 0));
            t.manual = true;
            totalOut.textContent = KB().taskDays(t) + 'd';
            refreshStats();
          });
          const totalOut = el('span.pl-kb-total', null, KB().taskDays(t) + 'd');
          const why = t.reasons.length
            ? t.reasons.map(r => r.text).join(' · ')
            : (t.manual ? 'set by hand' : 'library default');

          table.appendChild(el('.pl-craft-row' + (t.include ? '' : '.off') + (t.manual ? '.manual' : ''), null, [
            el('.cell.pl-kb-namecell', null, [chk, el('span.pl-craft-name', null, t.name)]),
            el('.cell.pl-craft-scope', null, t.scope === 'series' ? 'Series' : 'Per ep'),
            el('.cell', null, String(t.stage)),
            el('.cell', null, String(t.days)),
            el('.cell.pl-craft-rev', null, [revI,
              (t.rev !== t.baseRev ? el('span.pl-craft-delta' + (t.rev < t.baseRev ? '.down' : '.up'), null,
                (t.rev < t.baseRev ? '↓' : '↑') + ' was ' + t.baseRev) : null)]),
            el('.cell.pl-kb-totalcell', null, totalOut),
            el('.cell.pl-craft-why', { title: why }, why)
          ]));
        });
      });
    }

    box.appendChild(statsBox);
    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Pipeline for this show'),
        el('.pl-card-desc', null, 'Untick to drop a task, or change its revision rounds. Hand edits survive a re-craft.')
      ]),
      table
    ]));

    // ---- actions ----
    const presetName = el('input.fld', { type: 'text', placeholder: (p.intake.name || 'Crafted') + ' pipeline', style: { maxWidth: '260px' } });
    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Reuse this pipeline'),
        el('.pl-card-desc', null, 'Saves the included tasks as a preset Add Show can build a real board from. Dependencies come from the stage order; the base pass becomes each task’s minimum.')
      ]),
      el('.pl-card-body', null, el('.admin-add-row', null, [
        presetName,
        el('button.btn-ghost', {
          onclick: () => {
            const nm = (presetName.value || '').trim() || ((p.intake.name || 'Crafted') + ' pipeline');
            const staged = Object.assign({}, p, { craft: { tasks } });
            const preset = toPreset(staged, nm);
            if (!preset.pipeline.length) { App.toast('Nothing included to save', true); return; }
            savePreset(preset);
            App.toast('Saved “' + nm + '” — ' + preset.pipeline.length + ' tasks, available in Add Show');
          }
        }, [App.icon('pipeline'), ' Save as pipeline preset'])
      ]))
    ]));

    box.appendChild(el('.pl-actions', null, [
      el('button.btn-ghost', { onclick: () => go('hub') }, 'Cancel'),
      el('button.btn-ghost', {
        onclick: () => App.confirm('Drop the crafted pipeline and plan the full library again?',
          () => { clearCraft(p.id); App.toast('Reverted to the full library'); go('hub'); },
          { title: 'Discard crafted pipeline', yesLabel: 'Discard' })
      }, 'Use full library'),
      el('button.btn-primary', {
        onclick: () => {
          if (!tasks.some(t => t.include)) { App.toast('Include at least one task', true); return; }
          saveCraft(p.id, Object.assign({}, craft, { tasks }));
          App.toast('Pipeline saved — ' + tasks.filter(t => t.include).length + ' tasks planned');
          go('hub');
        }
      }, [App.icon('save'), ' Save pipeline'])
    ]));

    render(); refreshStats();
    return box;
  }

  App.craft = {
    SIGNALS, detectSignals, craftPipeline, saveCraft, clearCraft,
    effectiveTasks, totalDays, toPreset, savePreset, editor
  };
})();
