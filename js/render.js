/* App shell — role tabs, contextual toolbar (filters / legend / zoom), KPI strip,
   the Director review queue, and dispatch to the timeline / board / dashboard views. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  // Show/Dept/Owner are multi-select arrays; an empty array means "All" (no
  // restriction) — every predicate below reads them through this one helper
  // rather than each re-deriving what "nothing selected" should mean.
  App.filterHas = (arr, id) => !arr.length || arr.includes(id);

  /* A handful of features (Producer Notes, Re-Arrange's
     preselect, the Schedule Assistant) are inherently per-show — a note or a
     dragged-out task has to belong to exactly one show, and a scheduling
     command needs one clear target. Multi-select doesn't remove that need;
     it just means "exactly one show chosen" is no longer the same thing as
     "the filter isn't empty." This is the one place that distinction is
     made, so those features see the same null-means-unavailable signal they
     already handled for the old 'all' state, whether 0 or 2+ are selected. */
  App.singleShowFilter = () => App.state.filters.show.length === 1 ? App.state.filters.show[0] : null;

  // detail listings (board rows, timeline sub-bars, dashboard aggregates) honour
  // the department / owner filters; episode-level rollups always use all subitems.
  App.subsView = function (ep) {
    const f = App.state.filters;
    return App.subitems(ep).filter(su =>
      App.filterHas(f.dept, su.dept) &&
      App.filterHas(f.person, su.assignee));
  };

  /* Sort By — the Board's episode order (the Timeline stays in start
     order). Device-local like the other view settings, never synced to teammates. Every
     option breaks ties by running order, so equal keys never shuffle. */
  App.SORT_OPTIONS = [
    ['running', 'Running order', 'Show, then episode number'],
    ['start', 'Start date', 'When each episode’s first task starts'],
    ['live', 'Live date', 'The date each episode goes live'],
    ['delivery', 'Delivery date', 'The date each episode is delivered'],
    ['progress', 'Progress', 'How much of each episode is done'],
    ['overdue', 'Overdue tasks', 'Episodes with the most overdue work'],
    ['code', 'Episode code', 'Alphabetical by code'],
    ['title', 'Title', 'Alphabetical by episode title']
  ];
  const SORT_DEFAULT = { board: { key: 'running', dir: 'asc' } };
  App.sortPref = function (view) {
    const v = App.prefs.get('sortBy.' + view, null) || {};
    const d = SORT_DEFAULT[view] || SORT_DEFAULT.board;
    return { key: App.SORT_OPTIONS.some(o => o[0] === v.key) ? v.key : d.key, dir: v.dir === 'desc' ? 'desc' : 'asc' };
  };
  App.episodeComparator = function (view) {
    const { key, dir } = App.sortPref(view);
    const running = (a, b) => App.show(a.showId).name.localeCompare(App.show(b.showId).name) || (a.index || 0) - (b.index || 0);
    const ms = (ep, k) => { const m = App.epMilestone(ep, k); return m ? m.date : '9999-99-99'; };
    const val = {
      start: App.epStart, live: (ep) => ms(ep, App.LIVE_KEY), delivery: (ep) => ms(ep, 'delivery_date'),
      progress: App.progressPct, overdue: App.epOverdueCount,
      code: (ep) => String(ep.code || ''), title: (ep) => String(ep.title || '')
    }[key];
    const sign = dir === 'desc' ? -1 : 1;
    return (a, b) => {
      if (!val) return sign * running(a, b);
      const x = val(a), y = val(b);
      const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return c ? sign * c : running(a, b);
    };
  };
  App.sortEpisodes = (eps, view) => eps.slice().sort(App.episodeComparator(view));

  /* Timeline grouping (Episode / Department / Show). Switched off for now:
     the toolbar control is hidden and the timeline always groups by episode.
     Set to true to bring the control — and each person's saved choice — back. */
  App.TIMELINE_GROUPING = false;
  App.timelineGrouping = () => App.TIMELINE_GROUPING ? App.prefs.get('timelineSort', 'department') : 'episode';

  App.visibleEpisodes = function () {
    const f = App.state.filters;
    let eps = App.activeEpisodes().filter(ep =>      // archived shows/episodes never surface
      App.filterHas(f.show, ep.showId) &&
      (f.q === '' || (ep.title + ' ' + ep.code).toLowerCase().includes(f.q.toLowerCase())));
    if (f.person.length) eps = eps.filter(ep => Object.values(ep.assignees || {}).some(a => f.person.includes(a)));
    // Timeline and Board each have their own "Hide completed episodes" preference
    const v = App.state.view;
    if ((v === 'timeline' || v === 'board') && App.prefs.get(v === 'board' ? 'hideDoneBoard' : 'hideDoneTimeline', false)) {
      eps = eps.filter(ep => !App.isDelivered(ep));
    }
    return eps;
  };

  App.render = function () {
    if (!App.state.data) return;
    App.applyWorkflow && App.applyWorkflow();   // fold any workflow overrides into DEPARTMENTS/STATUSES
    App.board.closePop && App.board.closePop();
    App.gantt && App.gantt.closeNoteEditor && App.gantt.closeNoteEditor();
    App.vc && App.vc.syncOpen && App.vc.syncOpen();   // live-refresh the Version Control panel on state sync
    App.uploads && App.uploads._refresh && App.uploads._refresh();   // live-refresh the attachments section
    App.workspace && App.workspace.syncOpen && App.workspace.syncOpen();   // reflect a teammate's delivery
    App.chat && App.chat.syncOpen && App.chat.syncOpen();                  // and a teammate's message
    App.reviews && App.reviews.closeNote && App.reviews.closeNote();       // its row is about to be rebuilt
    if (App.tooltip) App.tooltip.reset();   // a redraw strips hovered nodes without firing mouseleave

    // guard: only admins may sit on the Admin or Planning views
    if ((App.state.view === 'admin' || App.state.view === 'planning') && !App.isAdminRole(App.state.role)) App.state.view = 'timeline';
    /* guard: same for Reviews, now that it's a revocable permission rather
       than a fixed director-only tab — an admin turning it off mid-session
       would otherwise leave that person parked on a view whose tab is gone. */
    if (App.state.view === 'review' && !App.canSeeReviewQueue(App.state.role)) App.state.view = 'timeline';
    /* guard: phone mode only ever offers Dashboard / Board / Admin (see
       renderViewTabs), so a view that isn't reachable from the tab bar there
       isn't reachable here either — the redirect fires every render, so
       rotating a phone or shrinking a test window off Timeline/Planning/
       Reviews mid-session lands on Dashboard rather than a view with no tab
       to get back out of. Runs after the admin guard above, since that one
       can itself hand back 'timeline', which still needs catching here. */
    if (App.isPhone() && ['timeline', 'planning', 'review'].includes(App.state.view)) App.state.view = 'dashboard';

    renderBrandMark();
    renderViewTabs();
    renderRoleSelect();

    const episodes = App.visibleEpisodes();
    // Admin configures the tracker rather than looking at episodes, so the
    // show/department/owner filters and the status legend have nothing to act
    // on there — the whole strip goes rather than sitting empty.
    const toolbar = document.getElementById('toolbar');
    const wantToolbar = App.state.view !== 'admin';
    toolbar.style.display = wantToolbar ? '' : 'none';
    if (wantToolbar) renderToolbar(episodes); else toolbar.innerHTML = '';
    if (App.state.view === 'timeline') renderKpis(episodes);
    else document.getElementById('kpis').innerHTML = '';

    const view = document.getElementById('view');
    const phone = App.isPhone();

    // Preserve scroll position when re-rendering within the same view
    const sameView = App.state._lastRenderedView === App.state.view;
    const savedScroll = (sameView && view && !phone) ? view.scrollTop : 0;
    /* Phone mode scrolls the whole page (topbar, toolbar and #view all in one
       flow — see the phone media query in style.css, which turns off #view's
       own inner scrollbar) rather than #view alone, so the position worth
       keeping across a same-view re-render is window.scrollY instead. Every
       filter change, live sync tick and mutation calls App.render() while
       staying on the same view, so this is the common case — it has to never
       fight someone's own scroll position. */
    const savedWinScroll = (sameView && phone) ? window.scrollY : null;

    // Snapshot the gantt's scroll position while its DOM is still alive — this
    // makes restoration correct for EVERY render trigger (filters, edits,
    // expand clicks) without depending on async scroll events having fired.
    if (App.gantt && App.gantt.syncScrollState) App.gantt.syncScrollState();
    view.innerHTML = '';

    if (App.state.view === 'admin') { view.appendChild(App.admin.render()); }
    else if (App.state.view === 'planning') { view.appendChild(App.planning.render()); }
    else if (App.state.view === 'review') { view.appendChild(App.reviews.render(episodes)); }
    else if (App.state.view === 'board') view.appendChild(App.board.render(episodes));
    else if (App.state.view === 'dashboard') view.appendChild(App.dashboard.render(episodes));
    else { view.appendChild(App.gantt.render(episodes)); App.gantt.afterMount(); }

    if (phone) {
      /* Landing on a view (a tab tap, the phone redirect guard, or the very
         first render after signing in) opens already past the topbar/toolbar
         cluster — "scrolled out of the way" by default — rather than atop
         the filters every time. #view's own top edge is exactly that
         boundary, and it adapts on its own to whichever chrome is actually
         visible (the toolbar is hidden entirely on Admin) without needing to
         add up each piece by hand. A same-view re-render restores exactly
         where the reader was instead — see savedWinScroll above. */
      requestAnimationFrame(() => {
        if (!view) return;
        if (savedWinScroll != null) { window.scrollTo(0, savedWinScroll); return; }
        window.scrollTo(0, Math.max(0, view.getBoundingClientRect().top + window.scrollY));
      });
    } else if (savedScroll > 0) {
      // Restore scroll after the browser has painted the new content
      requestAnimationFrame(() => { if (view) view.scrollTop = savedScroll; });
    }
    // Which views each role actually works in. Deduped to once a minute inside
    // App.track, so the constant re-renders here cost one event, not hundreds.
    App.track && App.track.feature('view.' + App.state.view);
    if (App.state.view === 'admin') App.track.feature('admin.' + (App.state.admin.view || 'hub'));
    App.state._lastRenderedView = App.state.view;
    // The assistant lives on <body>, outside the view that was just rebuilt, so
    // its transcript survives a redraw; this only follows the view and the show
    // filter it's scoped to.
    App.assistant && App.assistant.sync();
    // remember where the reader is, so a refresh puts them back (App.session)
    App.session && App.session.save();
  };

  // the brand mark doubles as the preferences button: clapper normally, gear
  // on hover (both from the icon set, so they match whatever theme is active)
  function renderBrandMark() {
    const film = document.getElementById('logo-film');
    const cog = document.getElementById('logo-cog');
    if (film && !film.firstChild) film.appendChild(App.icon('clapper', { size: 17 }));
    if (cog && !cog.firstChild) cog.appendChild(App.icon('gear', { size: 17 }));
  }

  function renderViewTabs() {
    const box = document.getElementById('view-tabs'); box.innerHTML = '';
    const phone = App.isPhone();
    /* Phone mode caps the tab bar at Dashboard, Board and (role permitting)
       Admin — Timeline's drag-to-reschedule and hover tooltips and
       Planning's variant-comparison tables are desktop surfaces that don't
       reduce to a phone screen, so rather than cram a worse version of them
       in, they're simply not offered here. See App.isPhone in state.js and
       the redirect guard in App.render above, which keeps someone from
       being stuck on one of them if the window narrows while they're on it. */
    const tabs = phone
      ? [['dashboard', 'compass', 'Dashboard'], ['board', 'grid', 'Board']]
      : [['timeline', 'chart', 'Timeline'], ['board', 'grid', 'Board'], ['dashboard', 'compass', 'Dashboard']];
    if (!phone && App.canSeeReviewQueue(App.state.role)) tabs.push(['review', 'target', 'Reviews']);
    // budget modelling is oversight work, so it rides the same gate as Admin
    if (!phone && App.isAdminRole(App.state.role)) tabs.push(['planning', 'sparkle', 'Planning']);
    if (App.isAdminRole(App.state.role)) tabs.push(['admin', 'tools', 'Admin']);
    tabs.forEach(([v, ic, lbl]) => {
      box.appendChild(el('button.view-tab' + (App.state.view === v ? '.active' : ''),
        { 'data-view': v, onclick: () => { App.state.view = v; App.render(); } },
        [App.icon(ic, { cls: 'ic' }), lbl]));
    });
  }

  function renderRoleSelect() {
    const box = document.getElementById('role-select'); box.innerHTML = '';
    const user = App.state.user;

    // the notification bell — mentions and messages on your tasks. Chat owns
    // its state; this only gives it a place to live in the topbar.
    if (App.chat && App.api.online && App.api.me) {
      const bellBox = el('span.bell-box');
      box.appendChild(bellBox);
      App.chat.bellMount(bellBox);
    }

    // signed in: show who you are, with sign-out
    if (user) {
      box.appendChild(el('.user-chip', { title: user.email + ' — signed in via ' + (App.api.me && App.api.me.via === 'google' ? 'Google' : 'team sign-in') }, [
        user.picture
          ? el('img.user-pic', { src: user.picture, alt: '' })
          : el('span.avatar', { style: { background: 'var(--accent)' } }, App.initials(user.name)),
        el('span.user-name', null, user.name),
        el('button.user-out', { onclick: () => App.api.logout(), title: 'Sign out' }, '⎋')
      ]));
    }

    // admins (and the offline demo) may switch the viewing role; everyone
    // else is pinned to the role their directory entry gives them
    const canSwitch = !user || user.admin;
    if (canSwitch) {
      // a native <option> can only hold text, so the role's icon rides in the
      // chip beside the select rather than inside it (which is also how we
      // avoid the OS's own emoji artwork leaking back in)
      const cur = App.role(App.state.role);
      box.appendChild(App.icon(cur.ico, { cls: 'role-ic', title: cur.label }));
      const sel = el('select.role-dd', { title: 'View as role' });
      App.ROLES.forEach(r => {
        const o = document.createElement('option'); o.value = r.key; o.textContent = r.label;
        if (r.key === App.state.role) o.selected = true; sel.appendChild(o);
      });
      sel.addEventListener('change', e => App.setRole(e.target.value));
      box.appendChild(sel);
    } else {
      const r = App.role(App.state.role);
      box.appendChild(el('span.role-pin', { title: 'Your pipeline role' }, [App.icon(r.ico), ' ' + r.label]));
    }

  }

  function renderToolbar(episodes) {
    const bar = document.getElementById('toolbar');
    /* The toolbar is rebuilt wholesale on every render, and the search box is
       what triggers most of those renders — so without this, typing tears the
       caret out of the field mid-word. Remember where the cursor was and put
       it back once the new field is in place. Also covers a render arriving
       from a teammate's edit while someone is mid-search. */
    const active = document.activeElement;
    const searchFocused = !!active && active.id === 'search';
    const caret = searchFocused ? [active.selectionStart, active.selectionEnd] : null;
    bar.innerHTML = '';
    const f = App.state.filters;

    bar.appendChild(el('span.toolbar-label', null, 'Show'));
    bar.appendChild(multiSelectEl('show', App.activeShows().map(s => [s.id, s.name]), f.show, 'All shows',
      arr => { f.show = arr; App.render(); }));

    bar.appendChild(el('span.toolbar-label', null, 'Dept'));
    bar.appendChild(multiSelectEl('dept', Object.keys(App.DEPARTMENTS).map(k => [k, App.DEPARTMENTS[k].label]), f.dept, 'All departments',
      arr => { f.dept = arr; App.render(); }));

    bar.appendChild(el('span.toolbar-label', null, 'Owner'));
    bar.appendChild(multiSelectEl('person', App.state.data.people.filter(p => App.roleDept(p.role)).map(p => [p.id, p.name]), f.person, 'Everyone',
      arr => { f.person = arr; App.render(); }));

    // Sort By — Board only. The same trigger and popover as the filters beside it; direction is picked
    // in the same menu rather than on a separate button.
    if (App.state.view === 'board') {
      const view = 'board', cur = App.sortPref(view);
      const setSort = (patch) => { App.prefs.set('sortBy.' + view, Object.assign({}, cur, patch)); App.filterMenu.close(); App.render(); };
      const opt = App.SORT_OPTIONS.find(o => o[0] === cur.key);
      bar.appendChild(el('span.toolbar-label', null, 'Sort'));
      bar.appendChild(sortMenuEl('sort', opt[1] + (cur.dir === 'desc' ? ' ↓' : ' ↑'), [
        App.SORT_OPTIONS.map(([v, l, tip]) => ({ label: l, tip, on: v === cur.key, pick: () => setSort({ key: v }) })),
        [['asc', 'Ascending ↑'], ['desc', 'Descending ↓']].map(([d, l]) => ({ label: l, on: d === cur.dir, pick: () => setSort({ dir: d }) }))
      ]));
    }

    const search = el('input#search', {
      type: 'text', placeholder: 'Search episodes…  ' + App.shortcutLabel('F'), value: f.q });
    search.addEventListener('input', e => { f.q = e.target.value; debouncedRender(); });
    bar.appendChild(search);

    if (App.state.view === 'timeline') {
      /* How the timeline is grouped is the setting people reach for most, so it
         sits in the toolbar with the other filters rather than two clicks deep
         in preferences. No label: three view names in a segmented control read
         as what they are. */
      // hidden while App.TIMELINE_GROUPING is off (see above)
      const sort = App.timelineGrouping();
      if (App.TIMELINE_GROUPING) bar.appendChild(el('.prefs-seg.toolbar-seg', null,
        [['episode', 'Episode'], ['department', 'Department'], ['show', 'Show']].map(([v, label]) =>
          el('button.seg' + (sort === v ? '.active' : ''), {
            title: 'Group the timeline by ' + label.toLowerCase(),
            onclick: () => { App.prefs.set('timelineSort', v); App.render(); }
          }, label))));
      // kept together so a wrap can't strand the − from the + it belongs with
      bar.appendChild(el('.toolbar-group', null, [
        el('button.ghost', { onclick: () => App.gantt.zoomBy(0.8), title: 'Zoom out (' + App.shortcutLabel('−') + ', or Ctrl+scroll on the chart)' }, '−'),
        el('button.ghost', { onclick: () => App.gantt.zoomBy(1.25), title: 'Zoom in (' + App.shortcutLabel('+') + ', or Ctrl+scroll on the chart)' }, '+'),
        el('button.ghost', { onclick: () => App.gantt.centerToday(), title: 'Scroll to today' }, '⊙ Today')
      ]));
    }

    /* Shift-selection pill (Timeline and Board — one selection, shared). Only
       here while something is picked — but then it has to be, because the
       selection otherwise lives entirely in outlines that can be scrolled off
       screen, and a group you've forgotten about owns your next drag. Doubles
       as the discoverable way out. */
    const sel = (App.state.view === 'timeline' || App.state.view === 'board') && App.ganttSelection
      ? App.ganttSelection.resolved() : [];
    if (sel.length) {
      const eps = new Set(sel.map(s => s.epId)).size;
      bar.appendChild(el('.sel-pill', {
        title: sel.map(s => s.ep.code + ' — ' + s.su.name).slice(0, 14).join('\n') +
               (sel.length > 14 ? '\n+' + (sel.length - 14) + ' more' : '')
      }, [
        el('span.sel-dot'),
        el('span.sel-count', null, sel.length + ' selected'),
        el('span.sel-sub', null, 'in ' + eps + ' episode' + (eps === 1 ? '' : 's') + (App.state.view === 'board' ? ' · right-click to set status, owner or dates' : ' · drag to move or resize together')),
        el('button.sel-clear', {
          title: 'Clear the selection (Esc)',
          onclick: () => { App.ganttSelection.clear(); App.render(); }
        }, '✕')
      ]));
    }

    // Print / Export — the same as ⌘P: a breakdown of the episodes above
    if (App.state.view === 'timeline' || App.state.view === 'board') {
      bar.appendChild(el('button.ghost.tb-export', {
        onclick: () => App.exporter.open(),
        title: 'Print or export a production breakdown of what’s showing (' + App.shortcutLabel('P') + ')'
      }, [App.icon('printer'), ' Export']));
    }

    if (searchFocused) {
      search.focus();
      try { search.setSelectionRange(caret[0], caret[1]); } catch (e) {}   // not all inputs allow it
    }
  }

  function renderKpis(episodes) {
    const box = document.getElementById('kpis');
    box.innerHTML = '';
    const today = App.isoDate(App.today());
    const deliveredEps = [], inProg = [], review = [], overdue = [], blocked = [];
    episodes.forEach(ep => {
      if (App.isDelivered(ep)) deliveredEps.push(ep.code + ' — ' + ep.title);
      App.subitems(ep).forEach(su => {
        const tag = ep.code + ' — ' + su.name;
        if (su.status === 'in_progress') inProg.push(tag);
        if (su.status === 'review') review.push(tag);
        if (su.status !== 'approved' && su.due < today) overdue.push(tag);
        if (App.isRiskBlocked(ep, su.key)) blocked.push(tag);
      });
    });
    // cap long lists so the tooltip stays readable
    const tip = (list) => {
      if (!list.length) return null;
      const cap = 14, shown = list.slice(0, cap), extra = list.length - shown.length;
      return shown.join('\n') + (extra > 0 ? '\n+' + extra + ' more' : '');
    };
    const kpi = (cls, num, sub, label, list) => el('.kpi.' + cls, { title: tip(list), tipPos: 'below' }, [
      el('.kpi-num', null, [String(num), sub ? el('span.kpi-sub', null, sub) : null]),
      el('.kpi-label', null, label)
    ]);
    box.appendChild(kpi('k-green', deliveredEps.length, ' / ' + episodes.length, 'Delivered', deliveredEps));
    box.appendChild(kpi('k-orange', inProg.length, '', 'In progress', inProg));
    box.appendChild(kpi('k-purple', review.length, '', 'Ready for review', review));
    box.appendChild(kpi('k-red', overdue.length, '', 'Overdue subitems', overdue));
    if (blocked.length) box.appendChild(kpi('k-red', blocked.length, '', 'Blocked by deps', blocked));

    /* Re-Arrange, Create and Add Show all reshape the schedule rather than
       filter the view, so they cluster together on the right of the KPI
       strip, in one wrapper that owns the push-right — not each button
       floating there on its own margin. Timeline has no separate toolbar of
       its own the way Board does (see App.board.showManager), so this strip
       is where they ride. */
    const actions = el('.kpi-actions');

    // Re-Arrange opens straight into its own dialog, which picks the show
    // itself — the current filter just preselects it when exactly one show
    // is selected. Only offered to whoever may move dates at all.
    if (App.canEditSchedule(App.state.role)) {
      actions.appendChild(el('button.ghost', {
        onclick: () => App.rearrange.open(App.singleShowFilter()),
        title: 'Re-Arrange: reorder a show’s remaining episodes'
      }, '⇅ Re-Arrange'));
    }

    /* Shows is a menu, not a single action: adding one is only one of the
       three things done to the show list from here — the others being opening
       an existing show to rename or recolour it, and importing one from a
       back-up file. */
    if (App.canManageShows(App.state.role)) {
      actions.appendChild(el('button.btn-addshow', {
        title: 'Browse this board’s shows — open one to edit it, add one, or import one',
        onclick: () => App.showsBrowser.open()
      }, 'Shows'));
    }
    if (actions.children.length) box.appendChild(actions);
  }

  // ---- helpers ----
  /* Multi-select trigger + popover for the toolbar's Show/Dept/Owner filters.
     Same open/close shape as App.prefsMenu (js/main.js) — a fixed-position
     popover anchored off the trigger's own rect, appended to <body>, and
     dismissed by the one global click listener every other toolbar popover
     already shares (see main.js's boot()). Only one is ever open at a time.

     Unlike prefsMenu's trigger (the brand logo, a stable node that survives
     every render), the toolbar is torn down and rebuilt wholesale on every
     App.render() — and picking a checkbox calls onChange, which sets the
     filter and calls App.render() synchronously. A popover left open across
     that rebuild would be anchored to a button no longer in the document.
     So the open state is tracked by KEY, not by DOM reference: each redraw
     checks whether ITS filter was the one open and, if so, redraws the
     popover fresh against the new button — the same trick the search box
     above already uses to survive a rebuild mid-keystroke, applied here to
     "stay open mid-selection" instead of "keep the caret." */
  App.filterMenu = {
    openKey: null,
    _pop: null,
    close() {
      if (this._pop) { this._pop.remove(); this._pop = null; }
      this.openKey = null;
    }
  };

  /* ---- Picking from a list: the same modifiers everywhere ----
       click              toggle this one
       Opt/Alt+click      all of them
       Cmd/Ctrl+click     only this one
       …again             all but this one (the reverse of "only")
     App.pickMode reads the modifier; App.pickApply turns it into the new
     picked set, given every id and the ids picked now. Plain clicks stay with
     each list, since what a toggle means (and what "none" means) is its own. */
  App.pickMode = (e) => e.altKey ? 'all' : (App.isMac ? e.metaKey : e.ctrlKey) ? 'only' : null;
  App.pickApply = function (mode, id, all, cur) {
    if (mode === 'all') return all.slice();
    return cur.length === 1 && cur[0] === id ? all.filter(x => x !== id) : [id];
  };

  /* The same rules for a plain list of checkboxes, without touching the list's
     own code: a modified click on a box, or on the row/label that holds just
     that box, is taken over here and the boxes that need to flip are flipped
     by dispatching `change` — so every list's existing handler does the
     saving, exactly as if each box had been clicked by hand. Clicks on the
     row's other controls (a number field, a select) are left alone. */
  App.wireCheckList = function (box) {
    box.addEventListener('click', (e) => {
      const mode = App.pickMode(e);
      if (!mode || e.target.closest('input:not([type="checkbox"]), select, textarea, button')) return;
      let cb = e.target.matches('input[type="checkbox"]') ? e.target : null;
      for (let n = e.target; !cb && n && n !== box; n = n.parentElement) {
        const inside = n.querySelectorAll('input[type="checkbox"]');
        if (inside.length === 1) cb = inside[0];
        else if (inside.length > 1) break;
      }
      if (!cb || cb.disabled) return;
      e.preventDefault(); e.stopPropagation();
      const boxes = [...box.querySelectorAll('input[type="checkbox"]')].filter(b => !b.disabled);
      // a click straight on the box has already flipped it, and the browser
      // flips it back once this handler returns (the default was prevented) —
      // so read it as it was, and apply after that restore
      const was = (b) => (b === cb && e.target === cb) ? !b.checked : b.checked;
      const want = App.pickApply(mode, cb, boxes, boxes.filter(was));
      setTimeout(() => boxes.forEach(b => {
        const on = want.includes(b);
        if (b.checked !== on) { b.checked = on; b.dispatchEvent(new Event('change', { bubbles: true })); }
      }), 0);
    }, true);
    return box;
  };

  function multiSelectEl(key, options, selected, allLabel, onChange) {
    // 0 selected -> allLabel; 1 -> its name; 2+ -> first two names + a count,
    // the same truncation shape the KPI tooltips already use for long lists.
    const label = () => {
      if (!selected.length) return allLabel;
      const names = selected.map(id => { const o = options.find(o => o[0] === id); return o ? o[1] : id; });
      return names.length <= 2 ? names.join(', ') : names.slice(0, 2).join(', ') + ' +' + (names.length - 2) + ' more';
    };

    const btn = el('button.filter.filter-multi', { type: 'button', title: label() }, [
      el('span.filter-multi-label', null, label()),
      el('span.filter-multi-chev', null, '▾')
    ]);

    const draw = () => {
      // Called right after the button is (re)built, which for a reopen-on-
      // rebuild is BEFORE the caller has appended it into the toolbar — its
      // rect is all zeros while detached, which is what pinned the popover to
      // the top-left corner. Defer one frame so the button is on-page first;
      // by then it's either still the open one (draw for real) or a later
      // rebuild has moved on (do nothing, that rebuild's own draw wins).
      if (!btn.isConnected) { requestAnimationFrame(() => { if (App.filterMenu.openKey === key) draw(); }); return; }
      if (App.filterMenu._pop) { App.filterMenu._pop.remove(); App.filterMenu._pop = null; }
      const pop = el('.filter-pop', { onclick: e => e.stopPropagation() });
      pop.appendChild(el('.filter-pop-row' + (!selected.length ? '.active' : ''), {
        onclick: () => onChange([])
      }, [el('span.filter-pop-check', null, !selected.length ? '✓' : ''), el('span', null, allLabel)]));
      pop.appendChild(el('.filter-pop-sep'));
      options.forEach(([v, name]) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = selected.includes(v);
        pop.appendChild(el('.filter-pop-row', {
          onclick: (e) => {
            // nothing picked means everything shows, so that's the "current" set here —
            // and a result that picks everything is written back as nothing
            const mode = App.pickMode(e);
            if (mode) {
              e.preventDefault();
              const all = options.map(o => o[0]);
              const next = App.pickApply(mode, v, all, selected.length ? selected : all);
              onChange(next.length === all.length ? [] : next);
              return;
            }
            if (e.target !== cb) cb.checked = !cb.checked;
            onChange(cb.checked ? selected.concat([v]) : selected.filter(x => x !== v));
          }
        }, [cb, el('span', null, name)]));
      });
      const r = btn.getBoundingClientRect();
      pop.style.top = (r.bottom + 6) + 'px';
      pop.style.left = r.left + 'px';
      document.body.appendChild(pop);
      App.filterMenu._pop = pop;
    };

    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (App.filterMenu.openKey === key) App.filterMenu.close();
      else { App.filterMenu.openKey = key; draw(); }
    });
    // survives the rebuild a selection just triggered — see the note above
    if (App.filterMenu.openKey === key) draw();
    return btn;
  }

  /* Single-choice sibling of multiSelectEl: same trigger, same popover, same
     open-by-key survival across the rebuild — a tick instead of checkboxes.
     `sections` are lists of { label, tip, on, pick }, drawn with a rule
     between them. */
  function sortMenuEl(key, label, sections) {
    const btn = el('button.filter.filter-multi', { type: 'button', title: 'Sort the episodes' }, [
      el('span.filter-multi-label', null, label),
      el('span.filter-multi-chev', null, '▾')
    ]);
    const draw = () => {
      if (!btn.isConnected) { requestAnimationFrame(() => { if (App.filterMenu.openKey === key) draw(); }); return; }
      if (App.filterMenu._pop) { App.filterMenu._pop.remove(); App.filterMenu._pop = null; }
      // short and fixed, so it shows in full rather than scrolling
      const pop = el('.filter-pop', { style: { maxHeight: 'none' }, onclick: e => e.stopPropagation() });
      sections.forEach((items, i) => {
        if (i) pop.appendChild(el('.filter-pop-sep'));
        items.forEach(it => pop.appendChild(el('.filter-pop-row' + (it.on ? '.active' : ''), { title: it.tip || null, onclick: it.pick },
          [el('span.filter-pop-check', null, it.on ? '✓' : ''), el('span', null, it.label)])));
      });
      const r = btn.getBoundingClientRect();
      pop.style.top = (r.bottom + 6) + 'px';
      pop.style.left = r.left + 'px';
      document.body.appendChild(pop);
      App.filterMenu._pop = pop;
    };
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (App.filterMenu.openKey === key) App.filterMenu.close();
      else { App.filterMenu.openKey = key; draw(); }
    });
    if (App.filterMenu.openKey === key) draw();
    return btn;
  }

  let _t = null;
  function debouncedRender() { clearTimeout(_t); _t = setTimeout(App.render, 160); }
})();
