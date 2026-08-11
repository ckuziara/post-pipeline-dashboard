/* Planning & Optimization engine — a sandbox for costing a show before it
   exists. A proposal carries its own intake brief, rate card and simulated
   variants; nothing here touches the live board until it's green-lighted and
   ingested, so producers can model freely.

   This file owns:
     • the working-day calendar (weekends, UK bank holidays, studio shutdowns)
     • the simulation "brain" setting — which expert the cost/timeline logic
       imitates, and the seam where an internal knowledge base can plug in
     • proposal CRUD + the intake form (Step 1)

   Mutations go through App.mutate like everywhere else, so a proposal syncs to
   the shared board and to teammates. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  /* ===================================================== calendar engine ===
     Every cost and duration in this module counts *working* days, so the
     calendar is the foundation the rest of it stands on. Non-working days are
     resolved to a Set of ISO dates for a given window, which the schedulers
     and the ledger both walk. */

  // Meeus/Jones/Butcher — Gregorian Easter Sunday. Computed rather than tabled
  // so the holiday list stays correct in any year without maintenance.
  function easterSunday(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);      // 3 = Mar, 4 = Apr
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  const isWeekendDate = (d) => d.getDay() === 0 || d.getDay() === 6;
  const nthMonday = (year, month, n) => {          // n = 1 → first Monday
    const d = new Date(year, month, 1);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    d.setDate(d.getDate() + (n - 1) * 7);
    return d;
  };
  const lastMondayOf = (year, month) => {
    const d = new Date(year, month + 1, 0);        // last day of the month
    while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
    return d;
  };

  /* England & Wales bank holidays. Fixed-date holidays that land on a weekend
     move to the next free weekday — which is why Boxing Day can land on the
     Tuesday when Christmas Day has already taken the Monday. */
  function ukBankHolidays(year) {
    const out = [];
    const easter = easterSunday(year);
    const add = (d, name) => out.push({ iso: App.isoDate(d), name });

    const substituted = (month, day, name) => {
      const d = new Date(year, month, day);
      const taken = new Set(out.map(x => x.iso));
      while (isWeekendDate(d) || taken.has(App.isoDate(d))) d.setDate(d.getDate() + 1);
      add(d, name);
    };

    substituted(0, 1, 'New Year’s Day');
    add(App.addDays(easter, -2), 'Good Friday');
    add(App.addDays(easter, 1), 'Easter Monday');
    add(nthMonday(year, 4, 1), 'Early May bank holiday');
    add(lastMondayOf(year, 4), 'Spring bank holiday');
    add(lastMondayOf(year, 7), 'Summer bank holiday');
    substituted(11, 25, 'Christmas Day');
    substituted(11, 26, 'Boxing Day');
    return out.sort((a, b) => a.iso < b.iso ? -1 : 1);
  }

  const DEFAULT_CALENDAR = { excludeWeekends: true, excludeUkHolidays: true, customHolidays: [] };

  /* All non-working days in [fromIso, toIso] as a Map iso → reason, so the
     Gantt can grey a block *and* say why it's grey. */
  function nonWorkingDays(cal, fromIso, toIso) {
    cal = Object.assign({}, DEFAULT_CALENDAR, cal || {});
    const out = new Map();
    const from = App.parseDate(fromIso), to = App.parseDate(toIso);
    if (cal.excludeWeekends) {
      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        if (isWeekendDate(d)) out.set(App.isoDate(d), 'Weekend');
      }
    }
    if (cal.excludeUkHolidays) {
      for (let y = from.getFullYear(); y <= to.getFullYear(); y++) {
        ukBankHolidays(y).forEach(h => {
          if (h.iso >= fromIso && h.iso <= toIso) out.set(h.iso, h.name);
        });
      }
    }
    (cal.customHolidays || []).forEach(iso => {
      if (iso >= fromIso && iso <= toIso) out.set(iso, 'Studio shutdown');
    });
    return out;
  }

  // Single-date test. Cheap enough for scheduling loops: the holiday list for
  // one year is eight entries.
  function isWorkingDay(iso, cal) {
    cal = Object.assign({}, DEFAULT_CALENDAR, cal || {});
    const d = App.parseDate(iso);
    if (cal.excludeWeekends && isWeekendDate(d)) return false;
    if ((cal.customHolidays || []).includes(iso)) return false;
    if (cal.excludeUkHolidays && ukBankHolidays(d.getFullYear()).some(h => h.iso === iso)) return false;
    return true;
  }

  // First working day on or after `iso` — where a phase actually starts.
  function nextWorkingDay(iso, cal) {
    let d = iso, guard = 0;
    while (!isWorkingDay(d, cal) && guard++ < 400) d = App.shiftIso(d, 1);
    return d;
  }

  /* Advance `n` working days from a working start. n = 1 returns the start
     itself, so a 5-day task spans start → start+4 working days: the durations
     producers quote are inclusive. */
  function addWorkingDays(iso, n, cal) {
    let d = nextWorkingDay(iso, cal), left = Math.max(1, n) - 1, guard = 0;
    while (left > 0 && guard++ < 5000) {
      d = App.shiftIso(d, 1);
      if (isWorkingDay(d, cal)) left--;
    }
    return d;
  }

  function workingDaysBetween(aIso, bIso, cal) {
    if (bIso < aIso) return 0;
    let n = 0, d = aIso, guard = 0;
    while (d <= bIso && guard++ < 5000) {
      if (isWorkingDay(d, cal)) n++;
      d = App.shiftIso(d, 1);
    }
    return n;
  }

  /* ================================================== simulation persona ===
     Which expert the engine imitates. The heuristics in Step 3 read
     `weights()`; `systemPrompt()` is the text an external model would be given,
     kept real now so wiring a knowledge base later is a transport change rather
     than a rewrite. */
  const PERSONAS = [
    {
      key: 'upm',
      label: 'Veteran Line Producer / UPM',
      blurb: 'Optimises like a studio UPM: protects the critical path, keeps internal crew loaded before hiring, and prices contingency against risk.',
      weights: { parallelBias: 1, crewFirst: 1, riskPadding: 1 },
      prompt:
        'You are a veteran Line Producer / Unit Production Manager optimising ' +
        'high-stakes studio operations. When calculating timelines, resource ' +
        'curves and cost logic, reason as a UPM does: protect the critical ' +
        'path, load in-house crew to capacity before engaging contractors, ' +
        'respect the non-working calendar absolutely, and price contingency ' +
        'against concrete delivery risk rather than as a flat markup.'
    },
    {
      key: 'plain',
      label: 'Neutral scheduler',
      blurb: 'No domain bias — straight critical-path maths on the rates and durations as entered. Useful as a control when sanity-checking a UPM plan.',
      weights: { parallelBias: 0, crewFirst: 0, riskPadding: 0 },
      prompt: 'Compute the schedule and budget arithmetically from the supplied durations, dependencies and rates. Apply no domain heuristics or judgement.'
    },
    {
      key: 'kb',
      label: 'Internal knowledge base (API)',
      blurb: 'Defers to your studio’s own historical actuals. Needs the knowledge-base endpoint connected before it can be selected.',
      requiresApi: true,
      weights: { parallelBias: 1, crewFirst: 1, riskPadding: 1 },
      prompt: 'Use the studio’s internal production knowledge base as the primary authority for rates, durations and risk, falling back to UPM heuristics where it has no precedent.'
    }
  ];

  const planningCfg = () => (App.state.data && App.state.data.planning) || {};
  const personaKey = () => {
    const k = planningCfg().persona;
    const p = PERSONAS.find(x => x.key === k);
    return (p && !(p.requiresApi && !kbConnected())) ? k : 'upm';
  };
  const persona = () => PERSONAS.find(p => p.key === personaKey()) || PERSONAS[0];
  const kbConnected = () => !!(planningCfg().kbEndpoint || '').trim();

  /* ======================================================== proposal data ===
     Kept in data.proposals so proposals sync like every other board object.
     Created lazily by the mutators — the same pattern as pipeline presets. */
  const CURRENCIES = { USD: '$', GBP: '£' };
  const money = (n, cur) => (CURRENCIES[cur] || '$') + Math.round(n || 0).toLocaleString('en-US');

  function blankIntake() {
    return {
      name: '', code: '', type: 'animation', episodes: 6,
      budget: 0, currency: 'GBP', startIso: App.isoDate(App.today()),
      brief: '',
      priorities: { budget: 3, timeline: 3, staffCap: 3 },
      contingencyPct: 10,
      calendar: { excludeWeekends: true, excludeUkHolidays: true, customHolidays: [] }
    };
  }

  const proposals = () => (App.state.data && App.state.data.proposals) || [];
  const proposal = (id) => proposals().find(p => p.id === id);

  function saveProposal(intake, id) {
    let newId = id;
    App.mutate(d => {
      d.proposals = d.proposals || [];
      const existing = id && d.proposals.find(p => p.id === id);
      if (existing) {
        existing.intake = intake;
        existing.updatedAt = App.nowIso ? App.nowIso() : new Date().toISOString();
        // the rate card and any simulated variants were costed against the old
        // intake, so they're stale the moment the brief changes
        existing.variants = null;
      } else {
        newId = App.uid();
        d.proposals.push({
          id: newId, status: 'draft', intake: intake, rates: null, variants: null,
          createdBy: (App.state.user && App.state.user.email) || null,
          createdAt: new Date().toISOString()
        });
      }
    });
    return newId;
  }

  function removeProposal(id) {
    App.mutate(d => { d.proposals = (d.proposals || []).filter(p => p.id !== id); });
  }

  function setProposalStatus(id, status) {
    App.mutate(d => {
      const p = (d.proposals || []).find(x => x.id === id);
      if (p) { p.status = status; p.statusAt = new Date().toISOString(); }
    });
  }

  function setPlanningCfg(patch) {
    App.mutate(d => { d.planning = Object.assign({}, d.planning, patch); });
  }

  /* ============================================================ intake UI === */
  const S = () => App.state.planning;

  function go(view, id) {
    S().view = view;
    S().editing = id || null;
    App.render();
  }

  const field = (label, control, hint) =>
    el('.pl-field', null, [el('label.pl-label', null, label), control, hint ? el('.fld-hint', null, hint) : null]);

  /* 1–5 priority slider. The live value label matters more than the number: a
     producer setting "Timeline aggressiveness" wants to read the intent back. */
  function prioritySlider(value, labels, onInput) {
    const out = el('span.pl-slider-val', null, labels[value - 1]);
    const input = el('input.pl-range', { type: 'range', min: '1', max: '5', step: '1', value: String(value) });
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 10);
      out.textContent = labels[v - 1];
      onInput(v);
    });
    return el('.pl-slider', null, [input, out]);
  }

  function intakeForm(existing) {
    const intake = existing
      ? JSON.parse(JSON.stringify(existing.intake))
      : blankIntake();
    intake.calendar = Object.assign({}, DEFAULT_CALENDAR, intake.calendar);
    intake.priorities = Object.assign({ budget: 3, timeline: 3, staffCap: 3 }, intake.priorities);

    const box = el('div');
    box.appendChild(el('.pl-crumb', null, [
      el('span.pl-crumb-link', { onclick: () => go('hub') }, 'Planning'),
      el('span', null, '/'),
      el('span.pl-crumb-here', null, existing ? 'Edit proposal' : 'New proposal')
    ]));
    box.appendChild(el('.pl-head', null, [
      el('div', null, [
        el('.pl-title', null, existing ? 'Edit intake — ' + (existing.intake.name || 'Untitled') : 'Production intake'),
        el('.pl-sub', null, 'Everything the simulation needs. Nothing here affects the live board until the proposal is green-lit.')
      ])
    ]));

    // ---- identity ----
    const nameI = el('input.fld', { type: 'text', value: intake.name, placeholder: 'e.g. Emmie’s Wonder Wardrobe' });
    const codeI = el('input.fld', { type: 'text', value: intake.code, placeholder: 'e.g. EWW', maxlength: '6' });
    const typeI = el('select.fld');
    [['animation', 'Animation'], ['live_action', 'Live Action']].forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l;
      if (v === intake.type) o.selected = true; typeI.appendChild(o);
    });
    const epI = el('input.fld', { type: 'number', value: String(intake.episodes), min: '1', max: '260' });

    const curI = el('select.fld.pl-cur');
    Object.keys(CURRENCIES).forEach(c => {
      const o = document.createElement('option'); o.value = c; o.textContent = CURRENCIES[c] + ' ' + c;
      if (c === intake.currency) o.selected = true; curI.appendChild(o);
    });
    const budgetI = el('input.fld', { type: 'number', value: String(intake.budget || ''), min: '0', step: '1000', placeholder: 'Ballpark total' });
    const startI = el('input.fld', { type: 'date', value: intake.startIso });

    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [el('.pl-card-title', null, 'Show'), el('.pl-card-desc', null, 'What we’re costing.')]),
      el('.pl-grid', null, [
        field('Show name', nameI),
        field('Show code', codeI, 'Prefix for episode codes'),
        field('Show type', typeI, 'Sets which default pipeline the simulation plans against'),
        field('Episodes', epI),
        field('Ballpark budget', el('.pl-money', null, [curI, budgetI]), 'The target the ledger is measured against'),
        field('Rough start date', startI, 'Nudged to the next working day if it lands on a non-working one')
      ])
    ]));

    // ---- brief ----
    const briefI = el('textarea.fld.pl-brief', {
      rows: '7',
      placeholder: 'Anything the numbers can’t capture: creative ambition, delivery commitments, known risks, talent availability, co-production constraints, previous seasons to benchmark against…'
    });
    briefI.value = intake.brief || '';
    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Production brief'),
        el('.pl-card-desc', null, 'Unstructured context. Read alongside the numbers when the simulation weighs trade-offs.')
      ]),
      el('.pl-card-body', null, briefI)
    ]));

    // ---- priority vectors ----
    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Priority vectors'),
        el('.pl-card-desc', null, 'What to protect when the three pull against each other. Variant C is tuned from these.')
      ]),
      el('.pl-card-body', null, [
        field('Budget constraint',
          prioritySlider(intake.priorities.budget,
            ['Budget is flexible', 'Some headroom', 'Balanced', 'Tight', 'Hard ceiling'],
            v => { intake.priorities.budget = v; }),
          'How hard the ballpark figure binds'),
        field('Timeline aggressiveness',
          prioritySlider(intake.priorities.timeline,
            ['Relaxed', 'Comfortable', 'Balanced', 'Compressed', 'Ship at all costs'],
            v => { intake.priorities.timeline = v; }),
          'How much overhead is acceptable to pull delivery in'),
        field('Staff cap',
          prioritySlider(intake.priorities.staffCap,
            ['Hire freely', 'Mostly flexible', 'Balanced', 'Prefer in-house', 'In-house only'],
            v => { intake.priorities.staffCap = v; }),
          'How far the internal team is stretched before contractors are engaged')
      ])
    ]));

    // ---- contingency ----
    const contOut = el('span.pl-slider-val.pl-cont-val', null, intake.contingencyPct + '%');
    const contI = el('input.pl-range', { type: 'range', min: '0', max: '30', step: '1', value: String(intake.contingencyPct) });
    contI.addEventListener('input', () => {
      intake.contingencyPct = parseInt(contI.value, 10);
      contOut.textContent = intake.contingencyPct + '%';
    });
    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Financial safety'),
        el('.pl-card-desc', null, 'Padding applied on top of every calculated expense sheet.')
      ]),
      el('.pl-card-body', null,
        field('Contingency buffer', el('.pl-slider', null, [contI, contOut]),
          '0–30%. Added to the variant totals before they’re compared with the ballpark.'))
    ]));

    // ---- calendar & shutdowns ----
    const calSummary = el('.pl-cal-summary');
    const tagBox = el('.pl-tags');

    const weekendsI = el('input', { type: 'checkbox' });
    weekendsI.checked = !!intake.calendar.excludeWeekends;
    const holsI = el('input', { type: 'checkbox' });
    holsI.checked = !!intake.calendar.excludeUkHolidays;

    const customDateI = el('input.fld.pl-date-add', { type: 'date' });

    function addCustom(iso) {
      if (!iso) return;
      if (intake.calendar.customHolidays.includes(iso)) { App.toast('That date is already a shutdown day', true); return; }
      intake.calendar.customHolidays.push(iso);
      intake.calendar.customHolidays.sort();
      customDateI.value = '';
      renderTags(); refreshCal();
    }
    function renderTags() {
      tagBox.innerHTML = '';
      const list = intake.calendar.customHolidays;
      if (!list.length) { tagBox.appendChild(el('span.pl-tags-empty', null, 'No studio shutdown dates yet')); return; }
      list.forEach(iso => {
        tagBox.appendChild(el('span.pl-tag', null, [
          App.fmtDate(iso) + ', ' + App.parseDate(iso).getFullYear(),
          el('button.pl-tag-x', {
            type: 'button', title: 'Remove',
            onclick: () => {
              intake.calendar.customHolidays = intake.calendar.customHolidays.filter(x => x !== iso);
              renderTags(); refreshCal();
            }
          }, '✕')
        ]));
      });
    }
    // Enter in the date field adds the tag, per the brief's tag-input behaviour
    customDateI.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCustom(customDateI.value); }
    });

    /* Live read-out of what the rules actually cost. This is the calendar
       engine running for real, so a mistyped shutdown date is obvious here
       rather than surfacing as a wrong delivery date two steps later. */
    function refreshCal() {
      intake.calendar.excludeWeekends = weekendsI.checked;
      intake.calendar.excludeUkHolidays = holsI.checked;
      const start = nextWorkingDay(startI.value || intake.startIso, intake.calendar);
      const horizonEnd = App.shiftIso(start, 364);
      const nw = nonWorkingDays(intake.calendar, start, horizonEnd);
      const working = 365 - nw.size;
      const hols = [...nw.entries()].filter(([, why]) => why !== 'Weekend');
      calSummary.innerHTML = '';
      calSummary.appendChild(el('.pl-cal-stat', null, [
        el('strong', null, String(working)), ' working days in the 12 months from ',
        el('strong', null, App.fmtDate(start))
      ]));
      calSummary.appendChild(el('.pl-cal-stat.dim', null,
        nw.size + ' non-working (' + (nw.size - hols.length) + ' weekend, ' + hols.length + ' holiday/shutdown)'));
      if (hols.length) {
        calSummary.appendChild(el('.pl-cal-hols', null, hols.slice(0, 12).map(([iso, why]) =>
          el('span.pl-cal-hol', { title: why }, App.fmtDate(iso) + ' · ' + why))));
      }
    }
    weekendsI.addEventListener('change', refreshCal);
    holsI.addEventListener('change', refreshCal);
    startI.addEventListener('change', refreshCal);

    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Calendar & shutdown rules'),
        el('.pl-card-desc', null, 'Non-working days are excluded from task durations and from billing cycles.')
      ]),
      el('.pl-card-body', null, [
        el('label.pl-check', null, [weekendsI, el('span', null, 'Exclude weekends from the schedule'),
          el('span.pl-check-hint', null, 'Saturdays and Sundays stop counting as active duration or billable days')]),
        el('label.pl-check', null, [holsI, el('span', null, 'Exclude UK national holidays'),
          el('span.pl-check-hint', null, 'England & Wales bank holidays, including weekend substitutions')]),
        field('Custom studio shutdowns',
          el('.pl-date-add-row', null, [
            customDateI,
            el('button.btn-ghost', { type: 'button', onclick: () => addCustom(customDateI.value) }, 'Add date')
          ]),
          'Pick a date and press Enter. Added dates become non-working days in every calculation.'),
        tagBox,
        calSummary
      ])
    ]));

    renderTags();
    refreshCal();

    // ---- save ----
    function collect() {
      intake.name = nameI.value.trim();
      intake.code = codeI.value.trim().toUpperCase();
      intake.type = typeI.value;
      intake.episodes = Math.max(1, parseInt(epI.value, 10) || 1);
      intake.currency = curI.value;
      intake.budget = Math.max(0, parseFloat(budgetI.value) || 0);
      intake.startIso = startI.value || intake.startIso;
      intake.brief = briefI.value;
      intake.calendar.excludeWeekends = weekendsI.checked;
      intake.calendar.excludeUkHolidays = holsI.checked;
      return intake;
    }

    box.appendChild(el('.pl-actions', null, [
      el('button.btn-ghost', { onclick: () => go('hub') }, 'Cancel'),
      el('button.btn-primary', {
        onclick: () => {
          const v = collect();
          if (!v.name) { App.toast('Show name is required', true); nameI.focus(); return; }
          if (!v.code) { App.toast('Show code is required', true); codeI.focus(); return; }
          if (!v.budget) { App.toast('Enter a ballpark budget to measure the variants against', true); budgetI.focus(); return; }
          const id = saveProposal(v, existing && existing.id);
          App.toast('Saved “' + v.name + '” as a draft proposal');
          go('hub');
          return id;
        }
      }, [App.icon('save'), ' Save intake'])
    ]));

    return box;
  }

  /* ================================================================= hub === */
  const STATUSES = {
    draft: { label: 'Draft', cls: 'draft' },
    green: { label: 'Green-lighted', cls: 'green' },
    red: { label: 'Red-lighted', cls: 'red' }
  };

  function personaCard() {
    const cur = persona();
    const sel = el('select.fld');
    PERSONAS.forEach(p => {
      const o = document.createElement('option');
      o.value = p.key;
      o.textContent = p.label + (p.requiresApi && !kbConnected() ? ' — not connected' : '');
      if (p.requiresApi && !kbConnected()) o.disabled = true;
      if (p.key === cur.key) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      setPlanningCfg({ persona: sel.value });
      App.toast('Simulation brain: ' + (PERSONAS.find(p => p.key === sel.value) || {}).label);
    });

    const kbI = el('input.fld', {
      type: 'text', value: planningCfg().kbEndpoint || '',
      placeholder: 'https://…  (internal knowledge base endpoint)'
    });
    kbI.addEventListener('change', () => setPlanningCfg({ kbEndpoint: kbI.value.trim() }));

    return el('.pl-card.pl-brain', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, [App.icon('sparkle'), ' Simulation brain']),
        el('.pl-card-desc', null, 'Whose judgement the timeline, resource and cost logic imitates.')
      ]),
      el('.pl-card-body', null, [
        field('Expert model', sel, cur.blurb),
        field('Knowledge base API', kbI,
          kbConnected()
            ? 'Connected. The knowledge-base model can now be selected above.'
            : 'Optional. Point this at an internal endpoint to unlock the knowledge-base model — the request contract is not wired up yet.'),
        el('details.pl-prompt', null, [
          el('summary', null, 'View the system context this sends'),
          el('pre.pl-prompt-text', null, cur.prompt)
        ])
      ])
    ]);
  }

  /* What the library implies for this studio, so the planner's assumptions are
     visible on the hub rather than buried in the simulation. */
  function kbCard() {
    const a = App.taskKb.summary('animation', 10);
    const l = App.taskKb.summary('live_action', 10);
    return el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, [App.icon('book'), ' Task knowledge base']),
        el('.pl-card-desc', null, 'What the planner books. Every task carries its revision rounds, so the schedule reflects the notes a show actually gets.')
      ]),
      el('.pl-card-body', null, el('.pl-kb-summary', null, [
        el('.pl-kb-sum', null, [
          el('.pl-kb-sum-lab', null, 'Animation · 10 eps'),
          el('.pl-kb-sum-val', null, a.totalDays + ' task-days'),
          el('.pl-kb-sum-sub', null, a.taskCount + ' tasks → ' + a.instances + ' instances · ' + Math.round(a.revShare * 100) + '% revisions')
        ]),
        el('.pl-kb-sum', null, [
          el('.pl-kb-sum-lab', null, 'Live Action · 10 eps'),
          el('.pl-kb-sum-val', null, l.totalDays + ' task-days'),
          el('.pl-kb-sum-sub', null, l.taskCount + ' tasks → ' + l.instances + ' instances · ' + Math.round(l.revShare * 100) + '% revisions')
        ]),
        el('button.btn-ghost', { onclick: () => go('kb') }, 'Edit library')
      ]))
    ]);
  }

  function hub() {
    const box = el('div');
    box.appendChild(el('.pl-head', null, [
      el('div', null, [
        el('.pl-title', null, 'Planning & Optimization'),
        el('.pl-sub', null, 'Model a show’s schedule and cost before committing it. Proposals stay sandboxed until green-lit.')
      ]),
      el('.pl-head-actions', null, [
        el('button.btn-ghost', { onclick: () => go('kb') }, [App.icon('book'), ' Task Knowledge Base']),
        el('button.btn-primary', { onclick: () => go('intake') }, '＋ New proposal')
      ])
    ]));

    box.appendChild(personaCard());
    box.appendChild(kbCard());

    /* The slate is a year's worth of proposals — a producer green-lights against
       an annual plan, so the list is scoped to a production year by start date. */
    const all = proposals();
    const years = [...new Set(all.map(p => App.parseDate(p.intake.startIso).getFullYear()))].sort();
    const thisYear = App.today().getFullYear();
    if (S().year == null) S().year = years.includes(thisYear) ? thisYear : (years[0] || thisYear);
    const year = S().year;
    const list = all.filter(p => year === 'all' || App.parseDate(p.intake.startIso).getFullYear() === year);

    const yearSel = el('select.fld.pl-year');
    [['all', 'All years']].concat(years.map(y => [y, String(y)])).forEach(([v, l]) => {
      const o = document.createElement('option'); o.value = String(v); o.textContent = l;
      if (String(v) === String(year)) o.selected = true; yearSel.appendChild(o);
    });
    yearSel.addEventListener('change', () => {
      S().year = yearSel.value === 'all' ? 'all' : parseInt(yearSel.value, 10);
      App.render();
    });

    // governance roll-up for the scoped year
    const counts = { draft: 0, green: 0, red: 0 };
    list.forEach(p => { counts[p.status] = (counts[p.status] || 0) + 1; });
    const committed = list.filter(p => p.status === 'green')
      .reduce((s, p) => s + (p.intake.budget || 0), 0);

    const panel = el('.pl-card', null, [
      el('.pl-card-head.pl-slate-head', null, [
        el('div', null, [
          el('.pl-card-title', null, 'Portfolio slate'),
          el('.pl-card-desc', null, list.length
            ? list.length + ' proposal' + (list.length === 1 ? '' : 's') + ' · ' +
              counts.green + ' green-lit, ' + counts.draft + ' draft, ' + counts.red + ' red-lit' +
              (committed ? ' · ' + money(committed, (list[0] || {}).intake.currency) + ' committed' : '')
            : 'Nothing modelled for this year yet')
        ]),
        el('.pl-slate-tools', null, [el('span.pl-year-lab', null, 'Year'), yearSel])
      ])
    ]);

    if (!list.length) {
      panel.appendChild(el('.pl-empty', null, [
        el('div', null, 'No proposals yet.'),
        el('.pl-empty-hint', null, 'Start with an intake brief — the show, its ballpark budget, and the calendar it has to fit.')
      ]));
    } else {
      const table = el('.pl-table');
      table.appendChild(el('.pl-thead', null, [
        el('.cell', null, ''),
        el('.cell', null, 'Show'), el('.cell', null, 'Type'), el('.cell', null, 'Episodes'),
        el('.cell', null, 'Ballpark'), el('.cell', null, 'Start'), el('.cell', null, 'Governance'), el('.cell', null, '')
      ]));
      list.slice().sort((a, b) => (b.createdAt || '') < (a.createdAt || '') ? -1 : 1).forEach(p => {
        const it = p.intake, st = STATUSES[p.status] || STATUSES.draft;

        // selection for the portfolio optimizer
        const pick = el('input', { type: 'checkbox' });
        pick.checked = (S().selected || []).includes(p.id);
        pick.addEventListener('change', () => {
          const sel = new Set(S().selected || []);
          if (pick.checked) sel.add(p.id); else sel.delete(p.id);
          S().selected = [...sel];
          App.render();
        });

        // governance: the explicit green/red decision
        const statusSel = el('select.fld.pl-status-sel.' + st.cls);
        [['draft', 'Draft'], ['green', 'Green-lighted'], ['red', 'Red-lighted']].forEach(([v, l]) => {
          const o = document.createElement('option'); o.value = v; o.textContent = l;
          if (v === p.status) o.selected = true; statusSel.appendChild(o);
        });
        statusSel.addEventListener('change', () => {
          setProposalStatus(p.id, statusSel.value);
          App.toast((it.name || 'Proposal') + ' → ' + (STATUSES[statusSel.value] || {}).label);
        });

        table.appendChild(el('.pl-row' + (pick.checked ? '.picked' : ''), null, [
          el('.cell.pl-row-pick', null, pick),
          el('.cell.pl-row-name', null, [
            el('.pl-row-title', null, it.name || 'Untitled'),
            el('.pl-row-code', null, [
              it.code || '—',
              (p.slate ? el('span.pl-slate-tag', { title: 'Start date set by the ' + (SLATE_MODELS.find(m => m.key === p.slate.model) || {}).name + ' model' }, 'optimised') : null)
            ])
          ]),
          el('.cell', null, it.type === 'live_action' ? 'Live Action' : 'Animation'),
          el('.cell', null, String(it.episodes)),
          el('.cell', null, money(it.budget, it.currency)),
          el('.cell', null, App.fmtDate(it.startIso) + ', ' + App.parseDate(it.startIso).getFullYear()),
          el('.cell', null, statusSel),
          el('.cell.pl-row-actions', null, [
            (p.variants ? el('button.btn-mini', { title: 'Open proposal report', onclick: () => go('report', p.id) }, App.icon('chart')) : null),
            el('button.btn-mini' + (p.craft ? '.on' : ''), {
              title: p.craft
                ? 'Crafted pipeline — ' + p.craft.tasks.filter(t => t.include).length + ' of ' + p.craft.tasks.length + ' tasks'
                : 'Craft the pipeline from the brief',
              onclick: () => go('craft', p.id)
            }, App.icon('pipeline')),
            el('button.btn-mini' + (ratesLocked(p) ? '' : '.warn'), {
              title: ratesLocked(p) ? 'Rate sheet — locked and verified' : 'Rate sheet — needs rates before it can simulate',
              onclick: () => go('rates', p.id)
            }, App.icon('sliders')),
            el('button.btn-mini', { title: 'Edit intake', onclick: () => go('intake', p.id) }, App.icon('pencil')),
            el('button.btn-mini.danger', {
              title: 'Delete proposal',
              onclick: () => App.confirm('Delete the proposal for “' + (it.name || 'Untitled') + '”?',
                () => { removeProposal(p.id); App.toast('Proposal deleted'); },
                { title: 'Delete proposal', yesLabel: 'Delete' })
            }, App.icon('trash'))
          ])
        ]));
      });
      panel.appendChild(table);
    }
    box.appendChild(panel);

    /* Portfolio optimizer bar — only meaningful once two shows are competing for
       the same crew, so it stays out of the way until then. */
    const sel = (S().selected || []).filter(id => list.some(p => p.id === id));
    if (sel.length) {
      const ready = sel.filter(id => ratesLocked(proposal(id))).length;
      box.appendChild(el('.pl-optbar', null, [
        el('.pl-optbar-txt', null, [
          el('strong', null, sel.length + ' selected'),
          el('span', null, ready < sel.length
            ? ' · ' + (sel.length - ready) + ' still need verified rates'
            : ' · ready to optimise across the slate')
        ]),
        el('button.btn-ghost', { onclick: () => { S().selected = []; App.render(); } }, 'Clear'),
        el('button.btn-primary', {
          disabled: ready < 2,
          title: ready < 2 ? 'Select at least two proposals with locked rates' : null,
          onclick: () => { S().slateModel = S().slateModel || 'smooth'; go('slate'); }
        }, [App.icon('sparkle'), ' Optimize slate'])
      ]));
    }
    return box;
  }

  /* ==================================================== rate sheet (Step 2) ===
     Rows are departments rather than free-text job titles: the pipeline already
     assigns every task a department, so costing by department is what lets a
     phase's working days multiply straight into money with nothing to reconcile.

     Each row can be staffed in-house, by contractors, or both, each with its own
     rate — the variants need both numbers to trade capital against speed. */
  const HOURS_PER_DAY = 8;               // a standard production day, for hour-based rates

  /* Default roles per department. Animation ships as a single blended line
     because that work always goes to an outside studio — a vendor quote is one
     line item, not a crew breakdown. Every other department is priced by role,
     since a Re-recording Mixer and a Foley Artist are not interchangeable
     money. Roles can be added or removed per proposal; Animation can be broken
     out into roles later the same way, with no special case. */
  const DEFAULT_ROLES = {
    creative:  ['Script Editor', 'Character Designer', 'Storyboard Artist', 'Animatic Editor'],
    music:     ['Composer', 'Session Engineer', 'Music Mixer'],
    animation: ['Animation Studio (out of house)'],
    audio:     ['Dialogue Editor', 'Sound Designer', 'Foley / Wallah Artist', 'Re-recording Mixer'],
    video:     ['Online Editor', 'Colourist', 'VFX Artist', 'Subtitle Editor'],
    ops:       ['Post Coordinator', 'Delivery Technician'],
    qc:        ['QC Technician']
  };

  function newRole(name, opts) {
    return Object.assign({
      id: App.uid(), name: name || 'New role', unit: 'day', heads: 1,
      inHouse: { active: true, rate: 0 },
      contractor: { active: true, rate: 0 }
    }, opts || {});
  }

  function defaultRates(type) {
    const pipe = App.defaultPipelineFor(type);
    const order = [];
    pipe.forEach(t => { if (!order.includes(t.dept)) order.push(t.dept); });
    return order.map(dept => ({
      dept,
      roles: (DEFAULT_ROLES[dept] || [App.dept(dept).label]).map(n =>
        // an out-of-house vendor is never in-house staff
        dept === 'animation'
          ? newRole(n, { inHouse: { active: false, rate: 0 }, contractor: { active: true, rate: 0 } })
          : newRole(n))
    }));
  }

  /* Older proposals stored one flat rate line per department. Fold that into a
     single role so an existing rate card keeps working instead of vanishing. */
  function normaliseRates(rates) {
    return (rates || []).map(r => {
      if (r.roles) return r;
      return {
        dept: r.dept,
        roles: [newRole(App.dept(r.dept).label, {
          unit: r.unit || 'day',
          inHouse: Object.assign({ active: true, rate: 0 }, r.inHouse),
          contractor: Object.assign({ active: true, rate: 0 }, r.contractor)
        })]
      };
    });
  }

  // Day-equivalent cost of one head of this role for one working day.
  const dayRate = (role, mode) => {
    const m = role[mode];
    if (!m || !m.active) return 0;
    return role.unit === 'hour' ? (m.rate || 0) * HOURS_PER_DAY : (m.rate || 0);
  };
  const roleActive = (role) => role.inHouse.active || role.contractor.active;

  /* The simulation gate. Every switched-on line must carry a real rate, because
     a zero would silently under-price the slate rather than fail loudly. */
  function rateIssues(rates) {
    const out = [];
    const groups = normaliseRates(rates);
    const anyActive = groups.some(g => (g.roles || []).some(roleActive));
    if (!anyActive) out.push('At least one role must be staffed.');
    groups.forEach(g => {
      const dl = App.dept(g.dept).label;
      const roles = g.roles || [];
      if (!roles.length) { out.push(dl + ' — add at least one role, or it can’t be costed.'); return; }
      if (!roles.some(roleActive)) out.push(dl + ' — every role is switched off.');
      roles.forEach(r => {
        const who = dl + ' · ' + (r.name || 'Untitled role');
        if (!(r.name || '').trim()) out.push(dl + ' — a role is missing its name.');
        if (!(r.heads > 0)) out.push(who + ' — crew size must be at least 1.');
        if (r.inHouse.active && !(r.inHouse.rate > 0)) out.push(who + ' — in-house rate must be greater than 0.');
        if (r.contractor.active && !(r.contractor.rate > 0)) out.push(who + ' — contractor rate must be greater than 0.');
      });
    });
    return out;
  }
  const ratesLocked = (p) => !!(p && p.rates && p.rates.length && !rateIssues(p.rates).length);

  function saveRates(id, rates) {
    App.mutate(d => {
      const p = (d.proposals || []).find(x => x.id === id);
      if (!p) return;
      p.rates = rates;
      p.variants = null;    // any previous simulation was costed on the old card
    });
  }

  function rateSheet(p) {
    const cur = p.intake.currency;
    const rates = p.rates && p.rates.length
      ? normaliseRates(JSON.parse(JSON.stringify(p.rates)))
      : defaultRates(p.intake.type);

    const box = el('div');
    box.appendChild(el('.pl-crumb', null, [
      el('span.pl-crumb-link', { onclick: () => go('hub') }, 'Planning'),
      el('span', null, '/'),
      el('span.pl-crumb-here', null, 'Rate sheet')
    ]));
    box.appendChild(el('.pl-head', null, [
      el('div', null, [
        el('.pl-title', null, 'Rate sheet — ' + (p.intake.name || 'Untitled')),
        el('.pl-sub', null, 'Locked rates for every department the pipeline touches. The simulation stays disabled until each active line carries a real rate.')
      ])
    ]));

    const issueBox = el('.pl-issues');
    const runBtn = el('button.btn-primary', {
      onclick: () => {
        const issues = rateIssues(rates);
        if (issues.length) { App.toast('Every active rate needs a value above 0', true); return; }
        saveRates(p.id, rates);
        runSimulation(p.id);
      }
    }, [App.icon('sparkle'), ' Run AI Simulation']);

    function refresh() {
      const issues = rateIssues(rates);
      runBtn.disabled = issues.length > 0;
      issueBox.innerHTML = '';
      if (issues.length) {
        issueBox.className = 'pl-issues bad';
        issueBox.appendChild(el('.pl-issues-head', null, [App.icon('warn'), ' Simulation locked — ' + issues.length + ' rate ' + (issues.length === 1 ? 'issue' : 'issues')]));
        issues.slice(0, 8).forEach(t => issueBox.appendChild(el('.pl-issue', null, t)));
      } else {
        issueBox.className = 'pl-issues ok';
        const nRoles = rates.reduce((s, g) => s + (g.roles || []).filter(roleActive).length, 0);
        issueBox.appendChild(el('.pl-issues-head', null, [App.icon('unlock'),
          ' Rates verified — ' + nRoles + ' roles costed across ' + rates.length + ' departments. Simulation unlocked.']));
      }
    }

    const table = el('.pl-rate-table');

    /* Rebuilt wholesale after any add/remove so the row keys and the "crew
       share" read-outs stay in step with the array they describe. */
    function renderRates() {
      table.innerHTML = '';
      table.appendChild(el('.pl-rate-head', null, [
        el('.cell', null, 'Role'),
        el('.cell', null, 'Unit'),
        el('.cell', null, 'Crew'),
        el('.cell', null, 'In-house'),
        el('.cell', null, cur + ' rate'),
        el('.cell', null, 'Contractor'),
        el('.cell', null, cur + ' rate'),
        el('.cell', null, '')
      ]));

      rates.forEach(group => {
        const dep = App.dept(group.dept);
        group.roles = group.roles || [];
        const totalHeads = group.roles.filter(roleActive).reduce((s, r) => s + (r.heads || 0), 0);

        table.appendChild(el('.pl-rate-group', null, [
          el('.pl-rate-group-name', null, [
            el('span.dot', { style: { background: dep.color } }),
            el('span', null, dep.label),
            el('span.pl-rate-count', null, group.roles.length + (group.roles.length === 1 ? ' role' : ' roles'))
          ]),
          el('button.btn-mini', {
            title: 'Add a role to ' + dep.label,
            onclick: () => { group.roles.push(newRole()); renderRates(); refresh(); }
          }, '＋ Role')
        ]));

        if (!group.roles.length) {
          table.appendChild(el('.pl-rate-none', null, 'No roles — this department can’t be costed until one is added.'));
        }

        group.roles.forEach(role => {
          const nameI = el('input.fld.pl-role-name', { type: 'text', value: role.name, placeholder: 'Role name' });
          nameI.addEventListener('input', () => { role.name = nameI.value; refresh(); });

          const unitSel = el('select.fld.pl-unit');
          [['day', 'Per day'], ['hour', 'Per hour']].forEach(([v, l]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = l;
            if (v === role.unit) o.selected = true; unitSel.appendChild(o);
          });
          unitSel.addEventListener('change', () => { role.unit = unitSel.value; refresh(); });

          // crew size decides how much of the department's demand this role
          // carries — 2 animators to 1 rigger is not an average of the two
          const headsI = el('input.fld.pl-heads', { type: 'number', min: '1', max: '99', value: String(role.heads || 1) });
          const shareOut = el('span.pl-role-share', null,
            totalHeads && roleActive(role) ? Math.round((role.heads || 0) / totalHeads * 100) + '%' : '—');
          headsI.addEventListener('input', () => {
            role.heads = Math.max(1, parseInt(headsI.value, 10) || 1);
            renderRates(); refresh();
          });

          const mode = (key) => {
            const chk = el('input', { type: 'checkbox' });
            chk.checked = !!role[key].active;
            const rateI = el('input.fld.pl-rate', {
              type: 'number', min: '0', step: '10',
              value: role[key].rate ? String(role[key].rate) : ''
            });
            rateI.disabled = !chk.checked;
            chk.addEventListener('change', () => {
              role[key].active = chk.checked;
              rateI.disabled = !chk.checked;
              renderRates(); refresh();
            });
            rateI.addEventListener('input', () => {
              role[key].rate = Math.max(0, parseFloat(rateI.value) || 0);
              refresh();
            });
            return { chk, rateI };
          };
          const ih = mode('inHouse'), co = mode('contractor');

          table.appendChild(el('.pl-rate-row' + (roleActive(role) ? '' : '.off'), null, [
            el('.cell', null, nameI),
            el('.cell', null, unitSel),
            el('.cell.pl-heads-cell', null, [headsI, shareOut]),
            el('.cell.pl-rate-tog', null, el('label.pl-switch-lab', null, [ih.chk, el('span', null, 'Staff')])),
            el('.cell', null, ih.rateI),
            el('.cell.pl-rate-tog', null, el('label.pl-switch-lab', null, [co.chk, el('span', null, 'Hire')])),
            el('.cell', null, co.rateI),
            el('.cell.pl-rate-x', null, el('button.btn-mini.danger', {
              title: 'Remove this role',
              onclick: () => {
                group.roles = group.roles.filter(r => r.id !== role.id);
                renderRates(); refresh();
              }
            }, App.icon('trash')))
          ]));
        });
      });
    }

    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Department & role rates'),
        el('.pl-card-desc', null, 'Crew size sets how much of a department’s demand each role carries. Hourly rates convert at ' +
          HOURS_PER_DAY + ' hours per production day, and only active working days are ever billed.')
      ]),
      table
    ]));
    renderRates();
    box.appendChild(issueBox);
    box.appendChild(el('.pl-actions', null, [
      el('button.btn-ghost', { onclick: () => go('hub') }, 'Back'),
      el('button.btn-ghost', { onclick: () => { saveRates(p.id, rates); App.toast('Rate sheet saved'); } }, [App.icon('save'), ' Save rates']),
      runBtn
    ]));
    refresh();
    return box;
  }

  /* ============================================== simulation engine (Step 3) ===
     Three strategies over the same brief. The engine plans in *department
     phases* rather than individual tasks: a UPM commits crew to a phase, and
     phase-level granularity is what makes the resource curve and the ledger
     legible. Every duration is counted in working days from the intake
     calendar, so weekends and shutdowns cost time but never money. */
  const VARIANTS = [
    { key: 'A', name: 'Timeline Aggressive', blurb: 'Doubles up parallel contractor workflows on active working days to compress the schedule. Fastest delivery, highest overhead.' },
    { key: 'B', name: 'Budget Restrictive', blurb: 'Maximises internal staff and routes phases strictly linearly. Protects capital, extends the delivery window.' },
    { key: 'C', name: 'Balanced Matrix', blurb: 'Tuned from the intake priority sliders — the sweet spot between the two extremes for this specific brief.' }
  ];

  // 1–5 slider → 0–1
  const norm = (v) => Math.max(0, Math.min(1, ((v || 3) - 1) / 4));

  /* Crew size is the only thing that compresses a phase, because that's how it
     works on a real unit: a phase holds a fixed amount of work, and doubling up
     divides the calendar rather than multiplying the bill. What parallelising
     genuinely costs is coordination — two crews never deliver 2× — so total
     head-days creep up as crew grows. That creep plus the contractor premium is
     the "raised overhead" of an aggressive plan. */
  const CREW_LOSS = 0.12;                 // efficiency lost per extra body on a phase
  const effectiveCrew = (crew) => crew * (1 - CREW_LOSS * (crew - 1));

  function variantParams(p, key) {
    if (key === 'A') return { overlap: 0.45, crew: 2, contractorShare: 0.65, cadence: 7 };
    if (key === 'B') return { overlap: 0, crew: 1, contractorShare: 0.08, cadence: 21 };
    // C — read the producer's own priorities back out of the sliders
    const pr = p.intake.priorities || {};
    const timeline = norm(pr.timeline), budget = norm(pr.budget), staff = norm(pr.staffCap);
    return {
      overlap: +(0.45 * timeline * (1 - 0.4 * budget)).toFixed(3),
      // a tight budget also argues against paying the parallelisation premium
      crew: 1 + Math.round(timeline * (1 - staff) * (1 - 0.5 * budget)),
      // a hard staff cap or a hard budget both push work back in-house
      contractorShare: +(0.6 * timeline * (1 - staff) * (1 - 0.4 * budget)).toFixed(3),
      cadence: Math.max(5, Math.round(21 - 13 * timeline))
    };
  }

  const isoWeekKey = (iso) => {
    const d = App.parseDate(iso);
    const day = (d.getDay() + 6) % 7;              // Monday-based
    return App.isoDate(App.addDays(d, -day));      // the Monday of that week
  };

  function simulate(p, key) {
    const cal = Object.assign({}, DEFAULT_CALENDAR, p.intake.calendar);
    const prm = variantParams(p, key);
    const rateBy = {};
    normaliseRates(p.rates).forEach(g => { rateBy[g.dept] = g; });

    const epCount = Math.max(1, p.intake.episodes || 1);
    const start = nextWorkingDay(p.intake.startIso, cal);
    const eff = effectiveCrew(prm.crew);

    /* Duration of one task instance. Crew compresses the FIRST PASS only —
       revision rounds wait on someone else's review, and no amount of extra
       staff shortens a client note. That's why an aggressive plan can't simply
       buy its way out of a revision-heavy pipeline. */
    const durationOf = (t) => {
      const base = Math.max(1, Math.ceil((t.days || 1) / eff));
      return base + (t.rev || 0) * (t.revDays || 0);
    };

    // a crafted pipeline (brief-driven subset) wins over the whole library
    const stages = App.taskKb.stagesFromTasks(App.craft.effectiveTasks(p), epCount);
    const bars = [];
    const perDept = {};
    let projectEnd = start;

    /* Cost one scheduled task instance against its department's role card, and
       record it on the department and role rollups. */
    function chargeTask(t, dept, dur) {
      const group = rateBy[dept] || { roles: [] };
      const active = (group.roles || []).filter(roleActive);
      const totalHeads = active.reduce((s, r) => s + (r.heads || 0), 0);
      const headDays = dur * prm.crew;
      const dep = App.dept(dept);
      const d = perDept[dept] = perDept[dept] || {
        label: dep.label, color: dep.color, days: 0,
        internalCost: 0, contractorCost: 0, internalHead: 0, contractorHead: 0, roles: {}
      };
      d.days += dur;
      let iTot = 0, cTot = 0;
      active.forEach(r => {
        const ihDay = dayRate(r, 'inHouse'), coDay = dayRate(r, 'contractor');
        let share = prm.contractorShare;
        if (!coDay) share = 0; else if (!ihDay) share = 1;
        const rHead = totalHeads ? headDays * ((r.heads || 0) / totalHeads) : 0;
        const iH = rHead * (1 - share), cH = rHead * share;
        const iC = iH * ihDay, cC = cH * coDay;
        iTot += iH; cTot += cH;
        d.internalHead += iH; d.contractorHead += cH;
        d.internalCost += iC; d.contractorCost += cC;
        const rl = d.roles[r.id] = d.roles[r.id] || { name: r.name, internalCost: 0, contractorCost: 0, headDays: 0 };
        rl.name = r.name; rl.headDays += rHead; rl.internalCost += iC; rl.contractorCost += cC;
      });
      return { internalHead: iTot, contractorHead: cTot };
    }

    /* ---- pass 1: series-level work, scheduled once ----
       Bibles, designs, rigs. These gate every episode, so they run up front in
       stage order and the whole run waits on the ones below it. */
    const seriesEndByStage = {};
    let seriesCursor = start;
    stages.forEach(g => {
      const list = g.tasks.filter(t => t.scope === 'series');
      if (!list.length) return;
      let stageEnd = seriesCursor;
      list.forEach(t => {
        const dur = durationOf(t);
        const s = nextWorkingDay(seriesCursor, cal);
        const due = addWorkingDays(s, dur, cal);
        const heads = chargeTask(t, t.dept, dur);
        bars.push({ dept: t.dept, label: t.name, taskId: t.id, scope: 'series',
                    color: App.dept(t.dept).color, ep: 0, start: s, due, days: dur,
                    rev: t.rev || 0, internalHead: heads.internalHead, contractorHead: heads.contractorHead });
        if (due > stageEnd) stageEnd = due;
        if (due > projectEnd) projectEnd = due;
      });
      seriesEndByStage[g.stage] = stageEnd;
      seriesCursor = addWorkingDays(stageEnd, 2, cal);   // next working day after the stage
    });
    // latest series finish at or below a given stage — episode work can't precede it
    const seriesGate = (stage) => Object.keys(seriesEndByStage)
      .filter(s => Number(s) < stage)
      .reduce((m, s) => (seriesEndByStage[s] > m ? seriesEndByStage[s] : m), '');

    /* ---- pass 2: per-episode work ----
       Each episode enters on the cadence and walks the same stage order. Stages
       are sequential within an episode; `overlap` lets a stage start before the
       previous one has fully cleared, which is how an aggressive plan compresses. */
    for (let e = 0; e < epCount; e++) {
      let cursor = nextWorkingDay(App.shiftIso(start, e * prm.cadence), cal);
      let prevEnd = null, prevDur = 0;

      stages.forEach(g => {
        const list = g.tasks.filter(t => t.scope === 'episode');
        if (!list.length) return;

        let stageStart = cursor;
        if (prevEnd) {
          stageStart = addWorkingDays(prevEnd, 2, cal);      // day after the last stage
          const back = Math.floor(prevDur * prm.overlap);
          if (back > 0) {
            let t = prevEnd;
            for (let i = 0; i < back; i++) t = App.shiftIso(t, -1);
            stageStart = nextWorkingDay(t, cal);
          }
          if (stageStart < cursor) stageStart = cursor;
        }
        const gate = seriesGate(g.stage);
        if (gate && stageStart <= gate) stageStart = addWorkingDays(gate, 2, cal);

        let stageEnd = stageStart, longest = 0;
        list.forEach(t => {
          const dur = durationOf(t);
          const s = nextWorkingDay(stageStart, cal);
          const due = addWorkingDays(s, dur, cal);
          const heads = chargeTask(t, t.dept, dur);
          bars.push({ dept: t.dept, label: t.name, taskId: t.id, scope: 'episode',
                      color: App.dept(t.dept).color, ep: e + 1, start: s, due, days: dur,
                      rev: t.rev || 0, internalHead: heads.internalHead, contractorHead: heads.contractorHead });
          if (due > stageEnd) stageEnd = due;
          if (dur > longest) longest = dur;
          if (due > projectEnd) projectEnd = due;
        });
        prevEnd = stageEnd; prevDur = longest;
        cursor = stageStart;
      });
    }

    // ---- weekly resource curve ----
    const weeks = {};
    bars.forEach(b => {
      // spread each bar's head-days across the working days it actually spans
      const wd = [];
      let d = b.start;
      while (d <= b.due) { if (isWorkingDay(d, cal)) wd.push(d); d = App.shiftIso(d, 1); }
      const per = wd.length ? 1 / wd.length : 0;
      wd.forEach(iso => {
        const k = isoWeekKey(iso);
        const w = weeks[k] = weeks[k] || { internal: 0, contractor: 0 };
        w.internal += b.internalHead * per;
        w.contractor += b.contractorHead * per;
      });
    });
    const weekKeys = Object.keys(weeks).sort();

    // ---- ledger ----
    const depts = Object.keys(perDept).map(k => Object.assign({ dept: k }, perDept[k]));
    const internal = depts.reduce((s, d) => s + d.internalCost, 0);
    const contractor = depts.reduce((s, d) => s + d.contractorCost, 0);
    const base = internal + contractor;
    const contingency = base * ((p.intake.contingencyPct || 0) / 100);
    const total = base + contingency;
    const target = p.intake.budget || 0;

    return {
      key, params: prm, start, end: projectEnd,
      workingDays: workingDaysBetween(start, projectEnd, cal),
      calendarDays: App.diffDays(projectEnd, start) + 1,
      bars, depts, weeks, weekKeys,
      ledger: { internal, contractor, base, contingency, total, target, delta: total - target, over: total > target },
      peakWeek: weekKeys.reduce((m, k) => Math.max(m, weeks[k].internal + weeks[k].contractor), 0)
    };
  }

  function runSimulation(id) {
    const p = proposal(id);
    if (!p) return;
    if (!ratesLocked(p)) { App.toast('Lock the rate sheet first', true); return; }
    const out = {};
    VARIANTS.forEach(v => {
      const s = simulate(p, v.key);
      // store only what the report needs — the bars/weeks are recomputed on view
      out[v.key] = { end: s.end, workingDays: s.workingDays, ledger: s.ledger, params: s.params };
    });
    App.mutate(d => {
      const t = (d.proposals || []).find(x => x.id === id);
      if (t) t.variants = { ranAt: new Date().toISOString(), persona: personaKey(), summary: out };
    });
    App.state.planning.variant = 'C';
    go('report', id);
    App.toast('Simulated three strategies with the ' + persona().label + ' model');
  }

  /* ================================================= proposal report (Step 3) === */
  function variantTabs(p, active) {
    return el('.pl-tabs', null, VARIANTS.map(v => el('button.pl-tab' + (v.key === active ? '.active' : ''), {
      onclick: () => { App.state.planning.variant = v.key; App.render(); }
    }, [
      el('span.pl-tab-key', null, 'Variant ' + v.key),
      el('span.pl-tab-name', null, v.name)
    ])));
  }

  /* Phase Gantt. Rows are departments, bars are episodes — 7 rows reads where 7
     phases × 10 episodes would not. Non-working days are drawn as grey columns
     behind the bars so a shutdown is visible as a gap in the plan. */
  function gantt(p, sim) {
    const cal = Object.assign({}, DEFAULT_CALENDAR, p.intake.calendar);
    const dw = 4;                                     // px per calendar day
    const total = App.diffDays(sim.end, sim.start) + 1;
    const width = Math.max(320, total * dw);
    const xOf = (iso) => App.diffDays(iso, sim.start) * dw;

    const grid = el('.pl-g-grid', { style: { width: width + 'px' } });
    const nw = nonWorkingDays(cal, sim.start, sim.end);
    nw.forEach((why, iso) => {
      grid.appendChild(el('.pl-g-off' + (why === 'Weekend' ? '' : '.hol'), {
        title: App.fmtDate(iso) + ' · ' + why,
        style: { left: xOf(iso) + 'px', width: dw + 'px' }
      }));
    });
    // month ticks
    let m = App.parseDate(sim.start);
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    while (App.isoDate(m) <= sim.end) {
      const iso = App.isoDate(m);
      grid.appendChild(el('.pl-g-tick', { style: { left: xOf(iso) + 'px' } },
        el('span.pl-g-tick-lab', null, m.toLocaleDateString('en-US', { month: 'short' }))));
      m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    }

    const byDept = {};
    sim.bars.forEach(b => (byDept[b.dept] = byDept[b.dept] || []).push(b));

    const rows = el('.pl-g-rows');
    Object.keys(byDept).forEach(dept => {
      const list = byDept[dept];
      const track = el('.pl-g-track', { style: { width: width + 'px' } });
      list.forEach(b => {
        const w = Math.max(2, (App.diffDays(b.due, b.start) + 1) * dw);
        track.appendChild(el('.pl-g-bar', {
          title: b.label + ' · Ep ' + b.ep + ' — ' + App.fmtRange(b.start, b.due) +
                 ' · ' + b.days + ' working days',
          style: { left: xOf(b.start) + 'px', width: w + 'px', background: b.color }
        }, list.length <= 12 ? el('span', null, 'E' + b.ep) : null));
      });
      rows.appendChild(el('.pl-g-row', null, [
        el('.pl-g-lab', null, [
          el('span.dot', { style: { background: App.dept(dept).color } }),
          el('span', null, App.dept(dept).label)
        ]),
        track
      ]));
    });

    return el('.pl-gantt', null, [
      el('.pl-g-scroll', null, el('.pl-g-inner', null, [grid, rows])),
      el('.pl-g-key', null, [
        el('span.pl-g-key-item', null, [el('span.pl-g-key-sw.off'), 'Weekend']),
        el('span.pl-g-key-item', null, [el('span.pl-g-key-sw.hol'), 'Holiday / studio shutdown'])
      ])
    ]);
  }

  function resourceChart(p, sim) {
    // internal capacity from the real roster: the people who could take this on
    const deptSet = new Set(sim.depts.map(d => d.dept));
    const heads = (App.state.data.people || []).filter(x => deptSet.has(App.roleDept(x.role))).length;
    const capacity = heads * 5;                       // head-days per working week

    const labels = sim.weekKeys.map(k => App.fmtDate(k));
    const series = [
      { label: 'Internal crew', color: 'var(--accent)', values: sim.weekKeys.map(k => Math.round(sim.weeks[k].internal * 10) / 10) },
      { label: 'Contractors', color: '#fdab3d', values: sim.weekKeys.map(k => Math.round(sim.weeks[k].contractor * 10) / 10) }
    ];
    const box = el('div');
    box.appendChild(App.charts.stackedBars(labels, series, {
      height: 200,
      capacity: capacity || 0,
      capacityLabel: capacity ? 'internal capacity (' + heads + ' staff)' : ''
    }));
    box.appendChild(App.charts.legend(series));
    return box;
  }

  function ledgerTable(p, sim) {
    const cur = p.intake.currency, L = sim.ledger;
    const t = el('.pl-ledger');
    t.appendChild(el('.pl-led-head', null, [
      el('.cell', null, 'Department'), el('.cell', null, 'Working days'),
      el('.cell', null, 'Internal'), el('.cell', null, 'Contractor'), el('.cell', null, 'Subtotal')
    ]));
    sim.depts.forEach(d => {
      t.appendChild(el('.pl-led-row', null, [
        el('.cell.pl-led-dept', null, [el('span.dot', { style: { background: d.color } }), el('span', null, d.label)]),
        el('.cell', null, String(Math.round(d.days))),
        el('.cell', null, money(d.internalCost, cur)),
        el('.cell', null, money(d.contractorCost, cur)),
        el('.cell.pl-led-sub', null, money(d.internalCost + d.contractorCost, cur))
      ]));
      // role detail — where a department's money actually goes
      Object.keys(d.roles || {}).forEach(rid => {
        const r = d.roles[rid];
        t.appendChild(el('.pl-led-row.role', null, [
          el('.cell.pl-led-role', null, r.name),
          el('.cell', null, Math.round(r.headDays) + ' hd'),
          el('.cell', null, r.internalCost ? money(r.internalCost, cur) : '—'),
          el('.cell', null, r.contractorCost ? money(r.contractorCost, cur) : '—'),
          el('.cell.pl-led-sub', null, money(r.internalCost + r.contractorCost, cur))
        ]));
      });
    });
    t.appendChild(el('.pl-led-row.total', null, [
      el('.cell', null, 'Base cost'), el('.cell', null, ''),
      el('.cell', null, money(L.internal, cur)), el('.cell', null, money(L.contractor, cur)),
      el('.cell.pl-led-sub', null, money(L.base, cur))
    ]));
    t.appendChild(el('.pl-led-row.total', null, [
      el('.cell', null, 'Contingency (' + (p.intake.contingencyPct || 0) + '%)'),
      el('.cell', null, ''), el('.cell', null, ''), el('.cell', null, ''),
      el('.cell.pl-led-sub', null, money(L.contingency, cur))
    ]));
    t.appendChild(el('.pl-led-row.grand', null, [
      el('.cell', null, 'Total exposure'), el('.cell', null, ''), el('.cell', null, ''), el('.cell', null, ''),
      el('.cell.pl-led-sub', null, money(L.total, cur))
    ]));

    const pct = L.target ? Math.round((L.total / L.target) * 100) : 0;
    return el('div', null, [
      t,
      el('.pl-budget-bar', null, [
        el('.pl-bb-track', null, el('.pl-bb-fill' + (L.over ? '.over' : ''), {
          style: { width: Math.min(100, pct) + '%' }
        })),
        el('.pl-bb-meta', null, [
          el('span', null, money(L.total, cur) + ' of ' + money(L.target, cur) + ' ballpark'),
          el('span.pl-bb-delta' + (L.over ? '.over' : '.under'), null,
            (L.over ? '▲ ' + money(L.delta, cur) + ' over' : '▼ ' + money(-L.delta, cur) + ' under') + ' · ' + pct + '%')
        ])
      ])
    ]);
  }

  /* Mock pitch-deck export. Produces the real summary text so it's useful to
     paste into a deck, and is explicit that it isn't a rendered PDF yet. */
  function exportSummary(p, sim, v) {
    const cur = p.intake.currency, L = sim.ledger;
    const lines = [
      p.intake.name + ' (' + p.intake.code + ') — ' + (p.intake.type === 'live_action' ? 'Live Action' : 'Animation'),
      p.intake.episodes + ' episodes · Variant ' + v.key + ': ' + v.name,
      'Modelled by: ' + persona().label,
      '',
      'Delivery:      ' + App.fmtDate(sim.start) + ' → ' + App.fmtDate(sim.end) + ', ' + App.parseDate(sim.end).getFullYear(),
      'Working days:  ' + sim.workingDays + ' (of ' + sim.calendarDays + ' calendar days)',
      'Peak weekly:   ' + Math.round(sim.peakWeek) + ' head-days',
      '',
      'Internal:      ' + money(L.internal, cur),
      'Contractors:   ' + money(L.contractor, cur),
      'Base:          ' + money(L.base, cur),
      'Contingency:   ' + money(L.contingency, cur) + '  (' + (p.intake.contingencyPct || 0) + '%)',
      'TOTAL:         ' + money(L.total, cur),
      'Ballpark:      ' + money(L.target, cur),
      'Variance:      ' + (L.over ? '+' : '−') + money(Math.abs(L.delta), cur)
    ];
    const text = lines.join('\n');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text)
        .then(() => App.toast('Pitch summary copied — PDF rendering is not wired up yet'))
        .catch(() => App.toast('Summary ready in the console — PDF rendering is not wired up yet'));
    } else {
      App.toast('Summary ready in the console — PDF rendering is not wired up yet');
    }
    console.log('[Pitch Deck Summary]\n' + text);
  }

  function report(p) {
    const active = App.state.planning.variant || 'C';
    const v = VARIANTS.find(x => x.key === active) || VARIANTS[2];
    const sim = simulate(p, active);
    const cur = p.intake.currency;

    const box = el('div');
    box.appendChild(el('.pl-crumb', null, [
      el('span.pl-crumb-link', { onclick: () => go('hub') }, 'Planning'),
      el('span', null, '/'),
      el('span.pl-crumb-here', null, 'Proposal report')
    ]));
    box.appendChild(el('.pl-head', null, [
      el('div', null, [
        el('.pl-title', null, p.intake.name || 'Untitled'),
        el('.pl-sub', null, [
          p.intake.episodes + ' episodes · ' + (p.intake.type === 'live_action' ? 'Live Action' : 'Animation') +
          ' · modelled by ' + persona().label
        ])
      ]),
      el('.pl-head-actions', null, [
        el('button.btn-ghost', { onclick: () => go('rates', p.id) }, [App.icon('sliders'), ' Rates']),
        el('button.btn-ghost', { onclick: () => exportSummary(p, sim, v) }, [App.icon('download'), ' Export Pitch Deck Summary (PDF)'])
      ])
    ]));

    box.appendChild(variantTabs(p, active));
    box.appendChild(el('.pl-variant-note', null, v.blurb));

    // headline numbers for the selected strategy
    const L = sim.ledger;
    box.appendChild(el('.pl-stats', null, [
      statTile('Delivery', App.fmtDate(sim.end) + ', ' + App.parseDate(sim.end).getFullYear(), sim.workingDays + ' working days'),
      statTile('Total exposure', money(L.total, cur), 'incl. ' + (p.intake.contingencyPct || 0) + '% contingency'),
      statTile('Against ballpark', (L.over ? '+' : '−') + money(Math.abs(L.delta), cur), L.over ? 'over target' : 'under target', L.over ? 'bad' : 'good'),
      statTile('Peak crew week', Math.round(sim.peakWeek) + ' head-days', 'contractor share ' + Math.round(sim.params.contractorShare * 100) + '%')
    ]));

    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Production phases'),
        el('.pl-card-desc', null, 'Departments down the side, one bar per episode. Grey columns are non-working days — no duration, no billing.')
      ]),
      el('.pl-card-body', null, gantt(p, sim))
    ]));

    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Internal workload vs contractor hiring'),
        el('.pl-card-desc', null, 'Head-days per week. Anything above the dashed line has to be hired in.')
      ]),
      el('.pl-card-body', null, resourceChart(p, sim))
    ]));

    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Budget ledger'),
        el('.pl-card-desc', null, 'Active working days × verified rates, plus contingency, against the ballpark.')
      ]),
      el('.pl-card-body', null, ledgerTable(p, sim))
    ]));

    return box;
  }

  /* ============================================ slate optimizer (Step 4) ===
     Two models over a set of proposals. Both work by nudging *start dates* —
     the one lever a producer actually controls once a show is costed — and by
     choosing which variant each show runs. Nothing is written until the
     producer applies it. */
  const SLATE_MODELS = [
    {
      key: 'smooth', name: 'Resource Smoothing',
      blurb: 'Flattens staff spikes. Slides show start dates so combined internal demand never exceeds team capacity, keeping delivery as early as each show allows.'
    },
    {
      key: 'capital', name: 'Capital Preservation',
      blurb: 'Lowers the combined slate budget. Runs every show on its budget-restrictive plan and spreads starts so contractor-heavy phases stop colliding — longer windows, more internal sharing, less concurrent hiring.'
    }
  ];

  // total internal head-days the studio can absorb in one working week
  function slateCapacity() {
    const heads = (App.state.data.people || []).filter(x => App.roleDept(x.role)).length;
    return heads * 5;
  }

  function simulateShifted(p, key, shiftDays) {
    if (!shiftDays) return simulate(p, key);
    const c = JSON.parse(JSON.stringify(p));
    c.intake.startIso = App.shiftIso(p.intake.startIso, shiftDays);
    return simulate(c, key);
  }

  // merge several sims' weekly curves into one slate-wide curve
  function combineWeeks(sims) {
    const weeks = {};
    sims.forEach(s => {
      Object.keys(s.weeks).forEach(k => {
        const w = weeks[k] = weeks[k] || { internal: 0, contractor: 0 };
        w.internal += s.weeks[k].internal;
        w.contractor += s.weeks[k].contractor;
      });
    });
    const keys = Object.keys(weeks).sort();
    let peakInternal = 0, peakContractor = 0, peakTotal = 0;
    keys.forEach(k => {
      peakInternal = Math.max(peakInternal, weeks[k].internal);
      peakContractor = Math.max(peakContractor, weeks[k].contractor);
      peakTotal = Math.max(peakTotal, weeks[k].internal + weeks[k].contractor);
    });
    return { weeks, keys, peakInternal, peakContractor, peakTotal };
  }

  function rollUp(entries) {
    const sims = entries.map(e => e.sim);
    const c = combineWeeks(sims);
    return {
      entries, ...c,
      budget: entries.reduce((s, e) => s + e.sim.ledger.total, 0),
      target: entries.reduce((s, e) => s + (e.p.intake.budget || 0), 0),
      end: entries.reduce((m, e) => (e.sim.end > m ? e.sim.end : m), ''),
      totalShift: entries.reduce((s, e) => s + e.shiftDays, 0)
    };
  }

  /* Baseline: every show on its tuned Balanced plan, starting when the intake
     said. This is what the models are measured against. */
  function slateBaseline(list) {
    return rollUp(list.map(p => ({ p, shiftDays: 0, variant: 'C', sim: simulate(p, 'C') })));
  }

  /* Greedy sequential placement. Shows are placed in start order; each is slid
     forward a week at a time until adding it no longer pushes the running total
     past the ceiling. Greedy rather than exhaustive because a producer needs an
     answer they can read and argue with, not a global optimum they can't. */
  function placeSequentially(list, variantFor, ceiling, metric, maxWeeks) {
    const placed = [];
    list.slice().sort((a, b) => a.intake.startIso < b.intake.startIso ? -1 : 1).forEach(p => {
      const variant = variantFor(p);
      let best = null;
      for (let wk = 0; wk <= maxWeeks; wk++) {
        const sim = simulateShifted(p, variant, wk * 7);
        const merged = combineWeeks(placed.map(e => e.sim).concat([sim]));
        const peak = metric(merged);
        if (best === null || peak < best.peak) best = { peak, sim, shiftDays: wk * 7, variant };
        if (ceiling && peak <= ceiling) { best = { peak, sim, shiftDays: wk * 7, variant }; break; }
      }
      placed.push({ p, sim: best.sim, shiftDays: best.shiftDays, variant: best.variant });
    });
    return placed;
  }

  function optimizeSlate(list, model) {
    if (model === 'capital') {
      // cheapest plan for every show, then spread to stop contractor peaks stacking
      return rollUp(placeSequentially(list, () => 'B', 0, (m) => m.peakContractor, 20));
    }
    // smoothing: keep the balanced plan, fit internal demand under capacity
    const cap = slateCapacity();
    return rollUp(placeSequentially(list, () => 'C', cap, (m) => m.peakInternal, 20));
  }

  function slateChart(roll, cap) {
    const labels = roll.keys.map(k => App.fmtDate(k));
    const series = [
      { label: 'Internal crew', color: 'var(--accent)', values: roll.keys.map(k => Math.round(roll.weeks[k].internal * 10) / 10) },
      { label: 'Contractors', color: '#fdab3d', values: roll.keys.map(k => Math.round(roll.weeks[k].contractor * 10) / 10) }
    ];
    const box = el('div');
    box.appendChild(App.charts.stackedBars(labels, series, {
      height: 190, capacity: cap || 0, capacityLabel: cap ? 'internal capacity' : ''
    }));
    box.appendChild(App.charts.legend(series));
    return box;
  }

  function slateOptimizer() {
    const ids = S().selected || [];
    const list = ids.map(id => proposal(id)).filter(Boolean).filter(p => ratesLocked(p));
    const skipped = ids.length - list.length;
    const modelKey = S().slateModel || 'smooth';
    const model = SLATE_MODELS.find(m => m.key === modelKey) || SLATE_MODELS[0];
    const cap = slateCapacity();
    const cur = (list[0] && list[0].intake.currency) || 'GBP';

    const box = el('div');
    box.appendChild(el('.pl-crumb', null, [
      el('span.pl-crumb-link', { onclick: () => go('hub') }, 'Planning'),
      el('span', null, '/'),
      el('span.pl-crumb-here', null, 'Slate Optimization Variations')
    ]));

    if (list.length < 2) {
      box.appendChild(el('.pl-head', null, el('div', null, [
        el('.pl-title', null, 'Slate Optimization Variations'),
        el('.pl-sub', null, 'Select at least two proposals with a locked rate sheet — the optimizer works by resolving shows against each other.')
      ])));
      box.appendChild(el('.pl-empty', null, [
        el('div', null, list.length + ' of ' + ids.length + ' selected proposals can be optimised.'),
        el('.pl-empty-hint', null, 'A proposal needs verified rates before it can be costed into a slate.')
      ]));
      box.appendChild(el('.pl-actions', null, el('button.btn-ghost', { onclick: () => go('hub') }, 'Back to slate')));
      return box;
    }

    const base = slateBaseline(list);
    const opt = optimizeSlate(list, modelKey);

    box.appendChild(el('.pl-head', null, [
      el('div', null, [
        el('.pl-title', null, 'Slate Optimization Variations'),
        el('.pl-sub', null, list.length + ' shows · ' + model.name + (skipped ? ' · ' + skipped + ' skipped for missing rates' : ''))
      ]),
      el('button.btn-ghost', { onclick: () => go('hub') }, 'Back to slate')
    ]));

    box.appendChild(el('.pl-tabs', null, SLATE_MODELS.map(m => el('button.pl-tab' + (m.key === modelKey ? '.active' : ''), {
      onclick: () => { S().slateModel = m.key; App.render(); }
    }, [
      el('span.pl-tab-key', null, m.key === 'smooth' ? 'Variation 1' : 'Variation 2'),
      el('span.pl-tab-name', null, m.name)
    ]))));
    box.appendChild(el('.pl-variant-note', null, model.blurb));

    // headline: what the model bought, against the untouched baseline
    const dBudget = Math.round(opt.budget - base.budget);
    const dInt = Math.round(opt.peakInternal - base.peakInternal);
    const dCon = Math.round(opt.peakContractor - base.peakContractor);
    // shifting start dates alone never changes cost — only re-planning does, so
    // an exact zero is the honest answer for a pure smoothing pass
    const budgetSub = dBudget === 0 ? 'unchanged vs baseline'
      : dBudget < 0 ? '▼ ' + money(-dBudget, cur) + ' saved vs baseline'
      : '▲ ' + money(dBudget, cur) + ' added vs baseline';
    const delta = (d, unit) => d === 0 ? 'unchanged' : (d < 0 ? '▼ ' : '▲ ') + Math.abs(d) + ' ' + unit;
    box.appendChild(el('.pl-stats', null, [
      statTile('Combined budget', money(opt.budget, cur), budgetSub,
        dBudget < 0 ? 'good' : dBudget > 0 ? 'bad' : null),
      statTile('Peak internal week', Math.round(opt.peakInternal) + ' head-days',
        cap ? (opt.peakInternal <= cap ? 'within ' + cap + ' capacity' : Math.round(opt.peakInternal - cap) + ' over capacity') : 'no capacity set',
        cap && opt.peakInternal <= cap ? 'good' : 'bad'),
      statTile('Peak contractor week', Math.round(opt.peakContractor) + ' head-days',
        delta(dCon, 'vs baseline'), dCon < 0 ? 'good' : null),
      statTile('Slate delivery', App.fmtDate(opt.end) + ', ' + App.parseDate(opt.end).getFullYear(),
        'last show wraps · internal spike ' + delta(dInt, 'head-days'), null)
    ]));

    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Combined resource curve'),
        el('.pl-card-desc', null, 'Every selected show stacked together. The dashed line is what the internal team can actually absorb.')
      ]),
      el('.pl-card-body', null, slateChart(opt, cap))
    ]));

    // per-show moves
    const moves = el('.pl-moves');
    moves.appendChild(el('.pl-moves-head', null, [
      el('.cell', null, 'Show'), el('.cell', null, 'Plan'), el('.cell', null, 'Start shift'),
      el('.cell', null, 'New start'), el('.cell', null, 'Delivery'), el('.cell', null, 'Budget')
    ]));
    opt.entries.forEach(e => {
      const b = base.entries.find(x => x.p.id === e.p.id);
      const v = VARIANTS.find(x => x.key === e.variant);
      moves.appendChild(el('.pl-moves-row', null, [
        el('.cell.pl-moves-name', null, e.p.intake.name || 'Untitled'),
        el('.cell', null, 'Variant ' + e.variant + ' · ' + (v ? v.name : '')),
        el('.cell', null, e.shiftDays
          ? el('span.pl-shift', null, '+' + Math.round(e.shiftDays / 7) + ' wk')
          : el('span.pl-shift.none', null, 'held')),
        el('.cell', null, App.fmtDate(e.sim.start)),
        el('.cell', null, App.fmtDate(e.sim.end) + ', ' + App.parseDate(e.sim.end).getFullYear()),
        el('.cell.pl-moves-cost', null, money(e.sim.ledger.total, cur) +
          (b ? '' : ''))
      ]));
    });
    box.appendChild(el('.pl-card', null, [
      el('.pl-card-head', null, [
        el('.pl-card-title', null, 'Proposed moves'),
        el('.pl-card-desc', null, 'What the model changes. Applying writes the new start date and chosen plan back onto each proposal.')
      ]),
      moves
    ]));

    box.appendChild(el('.pl-actions', null, [
      el('button.btn-ghost', { onclick: () => go('hub') }, 'Discard'),
      el('button.btn-primary', {
        onclick: () => App.confirm('Apply ' + model.name + ' to ' + opt.entries.length + ' proposals? Start dates and chosen plans will be updated.',
          () => {
            App.mutate(d => {
              opt.entries.forEach(e => {
                const t = (d.proposals || []).find(x => x.id === e.p.id);
                if (!t) return;
                t.intake.startIso = e.sim.start;
                t.slate = { model: modelKey, variant: e.variant, shiftDays: e.shiftDays, appliedAt: new Date().toISOString() };
                t.variants = null;             // the plan moved, so re-run to refresh its report
              });
            });
            /* A push can move a show into next year, which would silently drop
               it out of the year-scoped slate — say so rather than let it
               look like the proposal disappeared. */
            const moved = opt.entries.filter(e =>
              App.parseDate(e.sim.start).getFullYear() !== App.parseDate(e.p.intake.startIso).getFullYear());
            App.toast(model.name + ' applied to ' + opt.entries.length + ' proposals' +
              (moved.length ? ' — ' + moved.length + ' now start in a later year' : ''));
            go('hub');
          }, { title: 'Apply slate optimization', yesLabel: 'Apply' })
      }, [App.icon('sparkle'), ' Apply ' + model.name])
    ]));
    return box;
  }

  function statTile(label, value, sub, tone) {
    return el('.pl-stat' + (tone ? '.' + tone : ''), null, [
      el('.pl-stat-lab', null, label),
      el('.pl-stat-val', null, value),
      el('.pl-stat-sub', null, sub)
    ]);
  }

  /* ============================================================== exports === */
  App.plan = {
    // calendar
    DEFAULT_CALENDAR, ukBankHolidays, easterSunday,
    nonWorkingDays, isWorkingDay, nextWorkingDay, addWorkingDays, workingDaysBetween,
    // persona
    PERSONAS, persona, personaKey, kbConnected,
    systemPrompt: () => persona().prompt,
    weights: () => persona().weights,
    // data
    CURRENCIES, money, blankIntake, proposals, proposal, saveProposal, removeProposal, setPlanningCfg,
    // rates (Step 2)
    HOURS_PER_DAY, defaultRates, dayRate, rateIssues, ratesLocked, saveRates,
    // simulation (Step 3)
    VARIANTS, variantParams, simulate, runSimulation,
    // slate optimizer (Step 4)
    SLATE_MODELS, setProposalStatus, slateCapacity, slateBaseline, optimizeSlate, combineWeeks
  };

  App.planning = {
    render() {
      const wrap = el('.planning');
      if (!App.isAdminRole(App.state.role)) {
        wrap.appendChild(el('.empty', null, 'Planning is available to Producers and Managers.'));
        return wrap;
      }
      const s = S();
      const editing = s.editing && proposal(s.editing);
      // a sub-view whose proposal has gone (deleted elsewhere) falls back to the hub
      if (s.view === 'intake') wrap.appendChild(intakeForm(editing));
      else if (s.view === 'rates' && editing) wrap.appendChild(rateSheet(editing));
      else if (s.view === 'report' && editing) wrap.appendChild(report(editing));
      else if (s.view === 'slate') wrap.appendChild(slateOptimizer());
      else if (s.view === 'kb') wrap.appendChild(App.taskKb.editor());
      else if (s.view === 'kbflow') wrap.appendChild(App.taskKb.stageFlow());
      else if (s.view === 'craft' && editing) wrap.appendChild(App.craft.editor(editing));
      else wrap.appendChild(hub());
      return wrap;
    }
  };
})();
