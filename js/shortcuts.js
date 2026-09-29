/* Keyboard shortcuts that aren't chords: arrow-key nudges on a timeline
   selection, G-then-a-letter to change page, T for today, ? for the cheat
   sheet — plus the ⌘K command palette and the cheat sheet itself.

   The key listener lives in main.js with every other shortcut; it hands
   single keys to App.keys.single once it has ruled out typing, an open dialog
   and Cmd/Ctrl, so nothing here has to check those again. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  // the Opt / Shift / Cmd a person actually sees on their keyboard
  const OPT = () => App.isMac ? '⌥' : 'Alt';
  const SHIFT = () => App.isMac ? '⇧' : 'Shift';
  const CMD = () => App.isMac ? '⌘' : 'Ctrl';

  const G_WINDOW_MS = 1500;          // how long G waits for its second letter
  const G_VIEWS = { t: 'timeline', b: 'board', d: 'dashboard', p: 'planning' };

  // a page is only reachable if its tab is on screen — the tabs already encode
  // the role and phone rules, so reading them keeps this from disagreeing
  const tabFor = (view) => document.querySelector('.view-tab[data-view="' + view + '"]');
  function goView(view) {
    if (!tabFor(view)) return false;
    App.state.view = view;
    App.render();
    return true;
  }

  function jumpToday() {
    if (App.state.view !== 'timeline') {
      if (!tabFor('timeline')) return false;
      App.state.view = 'timeline';
      App.gantt._wantCenter = true;
      App.render();
      return true;
    }
    App.gantt.centerToday();
    return true;
  }

  let gAt = 0;
  App.keys = {
    // true = handled (the caller prevents the browser's default)
    single(e) {
      const k = e.key;

      if (k === '?') { App.shortcuts.open(); return true; }

      // ← / → nudge a timeline selection; ↑ / ↓ too when time runs downwards
      const portrait = !!(App.gantt._axis && App.gantt._axis.portrait);
      const back = k === 'ArrowLeft' || (portrait && k === 'ArrowUp');
      const fwd = k === 'ArrowRight' || (portrait && k === 'ArrowDown');
      if ((back || fwd) && App.state.view === 'timeline' && App.ganttSelection.resolved().length) {
        const hw = App.prefs.get('hideWeekends', true);
        const days = e.shiftKey ? (hw ? 5 : 7) : 1;        // a week of the columns on screen
        App.gantt.nudgeSelection(back ? -days : days, e.altKey);
        return true;
      }

      if (e.altKey || e.shiftKey) return false;
      const low = k.toLowerCase();

      // the second half of G-then-a-letter
      if (gAt && Date.now() - gAt < G_WINDOW_MS) {
        gAt = 0;
        if (G_VIEWS[low]) { if (!goView(G_VIEWS[low])) App.toast('That page isn’t available to your role'); return true; }
      }
      gAt = 0;
      if (low === 'g') { gAt = Date.now(); return true; }
      if (low === 't') return jumpToday();
      return false;
    }
  };

  /* ---- cheat sheet ---- */
  const kbd = (...keys) => el('span.kb-keys', null, keys.map(x => el('kbd', null, x)));
  const then = (a, b) => el('span.kb-keys', null, [el('kbd', null, a), el('span.kb-then', null, 'then'), el('kbd', null, b)]);

  function sections() {
    return [
      ['Anywhere', [
        [kbd(CMD(), 'K'), 'Command palette — find a show, an episode or an action'],
        [kbd('?'), 'This cheat sheet'],
        [then('G', 'T'), 'Go to Timeline'],
        [then('G', 'B'), 'Go to Board'],
        [then('G', 'D'), 'Go to Dashboard'],
        [then('G', 'P'), 'Go to Planning'],
        [kbd(CMD(), 'F'), 'Search episodes'],
        [kbd(CMD(), 'Z'), 'Undo'],
        [kbd(CMD(), SHIFT(), 'Z'), 'Redo'],
        [kbd(CMD(), 'P'), 'Print or export what’s showing'],
        [kbd('Esc'), 'Close / clear the selection']
      ]],
      ['Timeline', [
        [kbd('T'), 'Jump to today'],
        [kbd(CMD(), '+'), 'Zoom in'],
        [kbd(CMD(), '−'), 'Zoom out'],
        [kbd(OPT(), 'click'), 'On an episode name: open or close every episode (works on shows and departments too)']
      ]],
      ['Board & Dashboard', [
        [kbd(OPT(), 'click'), 'On an episode (Board) or a group (Dashboard): open or close them all'],
        [kbd(SHIFT(), 'click'), 'On a Board task: add or remove it from the selection'],
        [kbd(OPT(), SHIFT(), 'click'), 'On a Board task: that task on every episode'],
        [kbd(OPT(), SHIFT(), 'click'), 'On a Board episode: all of its tasks'],
        [kbd('right-click'), 'On a selected Board task: Batch Set Dates']
      ]],
      ['Lists & filters', [
        [kbd('click'), 'Tick or untick one'],
        [kbd(OPT(), 'click'), 'Tick them all'],
        [kbd(CMD(), 'click'), 'Only this one'],
        [kbd(CMD(), 'click'), 'Again: everything but this one']
      ]],
      ['Selecting', [
        [kbd(SHIFT(), 'click'), 'Add or remove a task'],
        [kbd(SHIFT(), 'drag'), 'Sweep a box over tasks'],
        [kbd(OPT(), SHIFT(), 'click'), 'On a task: that task on every episode'],
        [kbd(OPT(), SHIFT(), 'click'), 'On an episode name: all of that episode’s tasks'],
        [kbd(OPT(), SHIFT(), 'click'), 'On a department row: all of that department’s tasks']
      ]],
      ['Moving a selection', [
        [kbd('←', '→'), 'One day earlier / later'],
        [kbd(SHIFT(), '←', '→'), 'One week'],
        [kbd(OPT(), '←', '→'), 'One day, carrying everything that depends on it'],
        [kbd('drag'), 'Move or resize the whole selection']
      ]]
    ];
  }

  App.shortcuts = {
    open() {
      App.track && App.track.feature && App.track.feature('shortcuts.cheatsheet');
      const card = el('.modal-card.kb-card', { onclick: e => e.stopPropagation() }, [
        el('.modal-head', null, [
          el('.modal-head-main', null, [
            el('.modal-ic', null, '⌨'),
            el('div', null, [
              el('.modal-title', null, 'Keyboard shortcuts'),
              el('.modal-subtitle', null, OPT() + ' means “all” — add it to a click to reach every one of that kind')
            ])
          ]),
          el('button.modal-x', { title: 'Close (Esc)', onclick: () => App.modal.close() }, '✕')
        ]),
        el('.modal-body.kb-body', null, sections().map(([title, rows]) => el('.kb-sec', null, [
          el('.kb-sec-title', null, title),
          ...rows.map(([keys, what]) => el('.kb-row', null, [keys, el('span.kb-what', null, what)]))
        ])))
      ]);
      App.modal.open(card);
    }
  };

  /* ---- ⌘K command palette ----
     Three kinds of thing in one list: actions, shows and episodes. Matching is
     every typed word appearing somewhere in the entry, so "la 101" finds
     LA-101 and "go board" finds the Board. Actions list first when there's no
     query, since that's what an empty palette is for. */
  function actions() {
    const onTimeline = App.state.view === 'timeline';
    const list = [];
    [['timeline', 'Timeline', 'G T'], ['board', 'Board', 'G B'], ['dashboard', 'Dashboard', 'G D'],
     ['review', 'Reviews', ''], ['planning', 'Planning', 'G P'], ['admin', 'Admin', '']].forEach(([v, label, hint]) => {
      if (tabFor(v)) list.push({ kind: 'Page', label: 'Go to ' + label, hint, run: () => goView(v) });
    });
    if (tabFor('timeline')) list.push({ kind: 'Action', label: 'Jump to today', hint: 'T', run: jumpToday });
    if (onTimeline) {
      list.push({ kind: 'Action', label: 'Zoom in', hint: CMD() + '+', run: () => App.gantt.zoomBy(1.25) });
      list.push({ kind: 'Action', label: 'Zoom out', hint: CMD() + '−', run: () => App.gantt.zoomBy(0.8) });
      list.push({ kind: 'Action', label: 'Open every episode', hint: OPT() + ' click', run: () => {
        App.visibleEpisodes().forEach(ep => { App.state.ganttExpanded[ep.id] = true; }); App.render();
      } });
      list.push({ kind: 'Action', label: 'Close every episode', hint: OPT() + ' click', run: () => {
        App.visibleEpisodes().forEach(ep => { delete App.state.ganttExpanded[ep.id]; }); App.render();
      } });
      if (App.ganttSelection.resolved().length) {
        list.push({ kind: 'Action', label: 'Clear the selection', hint: 'Esc', run: () => { App.ganttSelection.clear(); App.render(); } });
      }
    }
    if (document.getElementById('search')) {
      list.push({ kind: 'Action', label: 'Search episodes', hint: CMD() + 'F', run: () => {
        const b = document.getElementById('search'); if (b) { b.focus(); b.select(); }
      } });
    }
    if (App.state.filters.show.length || App.state.filters.q) {
      list.push({ kind: 'Action', label: 'Show all shows', hint: '', run: () => {
        App.state.filters.show = []; App.state.filters.q = ''; App.render();
      } });
    }
    if (App.exporter && (onTimeline || App.state.view === 'board')) {
      list.push({ kind: 'Action', label: 'Print or export', hint: CMD() + 'P', run: () => App.exporter.open() });
    }
    list.push({ kind: 'Action', label: 'Keyboard shortcuts', hint: '?', run: () => App.shortcuts.open() });
    return list;
  }

  // the page an episode or show opens on: stay put on Timeline or Board,
  // otherwise the Timeline (or the Board where there's no Timeline, on a phone)
  const listView = () => (App.state.view === 'board' || App.state.view === 'timeline') ? App.state.view
    : (tabFor('timeline') ? 'timeline' : 'board');

  function openShow(show) {
    App.state.filters.show = [show.id];
    App.state.view = listView();
    App.render();
  }

  function openEpisode(ep) {
    const f = App.state.filters;
    // make sure it can be seen — a filter that hides it would make this a no-op
    if (f.show.length && !f.show.includes(ep.showId)) f.show = [];
    if (f.q && !(ep.title + ' ' + ep.code).toLowerCase().includes(f.q.toLowerCase())) f.q = '';
    if (f.person.length) f.person = [];
    const view = listView();
    App.state.view = view;
    if (view === 'timeline') App.state.ganttExpanded[ep.id] = true;
    else App.state.expanded[ep.id] = true;
    App.render();
    requestAnimationFrame(() => {
      const row = document.querySelector('.g-row[data-episode-id="' + ep.id + '"], [data-episode-id="' + ep.id + '"]');
      if (!row) return;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('kb-flash');
      setTimeout(() => row.classList.remove('kb-flash'), 1400);
    });
  }

  function entries() {
    const shows = App.activeShows().map(s => ({
      kind: 'Show', label: s.name, hint: s.prefix || '', color: s.color, run: () => openShow(s)
    }));
    const eps = App.activeEpisodes().map(ep => {
      const show = App.show(ep.showId);
      return { kind: 'Episode', label: ep.code + ' · ' + ep.title, hint: show.name, color: show.color, run: () => openEpisode(ep) };
    });
    return actions().concat(shows, eps);
  }

  const MAX_ROWS = 50;

  App.palette = {
    open() {
      App.track && App.track.feature && App.track.feature('shortcuts.palette');
      const all = entries();
      let shown = [], active = 0;

      const input = el('input.kb-pal-input', { type: 'text', placeholder: 'Find a show, an episode or an action…', spellcheck: 'false' });
      const list = el('.kb-pal-list');

      const choose = (item) => { App.modal.close(); if (item) item.run(); };

      const paint = () => {
        list.innerHTML = '';
        if (!shown.length) { list.appendChild(el('.kb-pal-empty', null, 'Nothing matches')); return; }
        shown.forEach((it, i) => {
          const row = el('.kb-pal-row' + (i === active ? '.active' : ''), {
            onmousemove: () => { if (active !== i) { active = i; paint(); } },
            onclick: () => choose(it)
          }, [
            el('span.kb-pal-dot', { style: { background: it.color || 'transparent' } }),
            el('span.kb-pal-label', null, it.label),
            it.hint ? el('span.kb-pal-hint', null, it.hint) : null,
            el('span.kb-pal-kind', null, it.kind)
          ]);
          list.appendChild(row);
        });
        const cur = list.children[active];
        if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
      };

      const filter = () => {
        const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
        shown = (words.length
          ? all.filter(it => { const hay = (it.kind + ' ' + it.label + ' ' + it.hint).toLowerCase(); return words.every(w => hay.includes(w)); })
          : all).slice(0, MAX_ROWS);
        active = 0;
        paint();
      };

      input.addEventListener('input', filter);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (shown.length) { active = (active + 1) % shown.length; paint(); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) { active = (active - 1 + shown.length) % shown.length; paint(); } }
        else if (e.key === 'Enter') { e.preventDefault(); choose(shown[active]); }
      });

      const card = el('.modal-card.kb-pal', { onclick: e => e.stopPropagation() }, [
        el('.kb-pal-head', null, [input, el('kbd.kb-pal-esc', null, 'Esc')]),
        list,
        el('.kb-pal-foot', null, [
          el('span', null, [el('kbd', null, '↑'), el('kbd', null, '↓'), ' to move']),
          el('span', null, [el('kbd', null, '↵'), ' to open']),
          el('span', null, [el('kbd', null, '?'), ' all shortcuts'])
        ])
      ]);
      filter();
      App.modal.open(card);
    }
  };
})();
