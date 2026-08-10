/* App shell — role tabs, contextual toolbar (filters / legend / zoom), KPI strip,
   the Director review queue, and dispatch to the timeline / board / dashboard views. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  // detail listings (board rows, timeline sub-bars, dashboard aggregates) honour
  // the department / owner filters; episode-level rollups always use all subitems.
  App.subsView = function (ep) {
    const f = App.state.filters;
    return App.subitems(ep).filter(su =>
      (f.dept === 'all' || su.dept === f.dept) &&
      (f.person === 'all' || su.assignee === f.person));
  };

  App.visibleEpisodes = function () {
    const f = App.state.filters;
    let eps = App.activeEpisodes().filter(ep =>      // archived shows/episodes never surface
      (f.show === 'all' || ep.showId === f.show) &&
      (f.q === '' || (ep.title + ' ' + ep.code).toLowerCase().includes(f.q.toLowerCase())));
    if (f.person !== 'all') eps = eps.filter(ep => Object.values(ep.assignees || {}).includes(f.person));
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
    if (App.tooltip) App.tooltip.reset();   // a redraw strips hovered nodes without firing mouseleave

    // guard: only admins may sit on the Admin view
    if (App.state.view === 'admin' && !App.isAdminRole(App.state.role)) App.state.view = 'timeline';

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

    // Preserve scroll position when re-rendering within the same view
    const sameView = App.state._lastRenderedView === App.state.view;
    const savedScroll = (sameView && view) ? view.scrollTop : 0;

    // Snapshot the gantt's scroll position while its DOM is still alive — this
    // makes restoration correct for EVERY render trigger (filters, edits,
    // expand clicks) without depending on async scroll events having fired.
    if (App.gantt && App.gantt.syncScrollState) App.gantt.syncScrollState();
    view.innerHTML = '';

    if (App.state.view === 'admin') { view.appendChild(App.admin.render()); }
    else if (App.state.view === 'review') { view.appendChild(reviewQueue(episodes)); }
    else if (App.state.view === 'board') view.appendChild(App.board.render(episodes));
    else if (App.state.view === 'dashboard') view.appendChild(App.dashboard.render(episodes));
    else { view.appendChild(App.gantt.render(episodes)); App.gantt.afterMount(); }

    // Restore scroll after the browser has painted the new content
    if (savedScroll > 0) requestAnimationFrame(() => { if (view) view.scrollTop = savedScroll; });
    // Which views each role actually works in. Deduped to once a minute inside
    // App.track, so the constant re-renders here cost one event, not hundreds.
    App.track && App.track.feature('view.' + App.state.view);
    if (App.state.view === 'admin') App.track.feature('admin.' + (App.state.admin.view || 'hub'));
    App.state._lastRenderedView = App.state.view;
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
    const tabs = [['timeline', 'chart', 'Timeline'], ['board', 'grid', 'Board'], ['dashboard', 'compass', 'Dashboard']];
    if (App.state.role === 'director') tabs.push(['review', 'target', 'Reviews']);
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
    bar.appendChild(selectEl([['all', 'All shows']].concat(App.activeShows().map(s => [s.id, s.name])),
      f.show, v => { f.show = v; App.render(); }));

    bar.appendChild(el('span.toolbar-label', null, 'Dept'));
    bar.appendChild(selectEl([['all', 'All departments']].concat(Object.keys(App.DEPARTMENTS).map(k => [k, App.DEPARTMENTS[k].label])),
      f.dept, v => { f.dept = v; App.render(); }));

    bar.appendChild(el('span.toolbar-label', null, 'Owner'));
    bar.appendChild(selectEl([['all', 'Everyone']].concat(App.state.data.people.filter(p => App.roleDept(p.role)).map(p => [p.id, p.name])),
      f.person, v => { f.person = v; App.render(); }));

    const search = el('input#search', {
      type: 'text', placeholder: 'Search episodes…  ' + App.shortcutLabel('F'), value: f.q });
    search.addEventListener('input', e => { f.q = e.target.value; debouncedRender(); });
    bar.appendChild(search);

    if (App.state.view === 'timeline') {
      /* How the timeline is grouped is the setting people reach for most, so it
         sits in the toolbar with the other filters rather than two clicks deep
         in preferences. No label: three view names in a segmented control read
         as what they are. */
      const sort = App.prefs.get('timelineSort', 'department');
      bar.appendChild(el('.prefs-seg.toolbar-seg', null,
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

      /* Re-Arrange opens straight into its own dialog, which picks the show
         itself — the current filter just preselects it when there is one. Only
         offered to whoever may move dates at all. */
      if (App.canEditSchedule(App.state.role)) {
        bar.appendChild(el('button.ghost', {
          onclick: () => App.rearrange.open(f.show !== 'all' ? f.show : null),
          title: 'Re-Arrange: reorder a show’s remaining episodes'
        }, '⇅ Re-Arrange'));
      }
    }

    /* Legend — Timeline only, where bars are colour-coded by show and there's
       nothing else to decode them by. The Board and Dashboard label their
       statuses on the chips themselves, so a key for them is just a second
       row of noise above the work. */
    if (App.state.view === 'timeline') {
      const legend = el('.legend');
      App.activeShows().forEach(s => legend.appendChild(legItem(s.color, s.name)));
      bar.appendChild(legend);
    }

    if (searchFocused) {
      search.focus();
      try { search.setSelectionRange(caret[0], caret[1]); } catch (e) {}   // not all inputs allow it
    }
  }

  function legItem(color, label) {
    return el('.legend-item', null, [el('span.swatch', { style: { background: color } }), label]);
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
  }

  // ---- Director: ready-for-review queue ----
  function reviewQueue(episodes) {
    const wrap = el('div');
    wrap.appendChild(el('.section-title', null, [App.icon('target'), ' Ready for Review — director queue']));
    const items = [];
    episodes.forEach(ep => App.subsView(ep).forEach(su => { if (su.status === 'review') items.push({ ep, su }); }));
    if (!items.length) return wrap.appendChild(el('.empty', null, [App.icon('checkBadge'), ' Nothing is waiting for review right now.'])), wrap;

    const list = el('.risk-list');
    // sort order comes from the Reviews tab's own preferences popover
    const byDue = (a, b) => a.su.due < b.su.due ? -1 : a.su.due > b.su.due ? 1 : 0;
    const sorters = {
      due: byDue,
      show: (a, b) => App.show(a.ep.showId).name.localeCompare(App.show(b.ep.showId).name) || byDue(a, b),
      dept: (a, b) => App.dept(a.su.dept).label.localeCompare(App.dept(b.su.dept).label) || byDue(a, b)
    };
    items.sort(sorters[App.prefs.get('reviewSort', 'due')] || byDue).forEach(x => {
      const show = App.show(x.ep.showId), dep = App.dept(x.su.dept);
      const person = x.su.assignee ? App.person(x.su.assignee) : null;
      list.appendChild(el('.risk-item', { style: { padding: '12px 14px' } }, [
        el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color), fontSize: '10px', padding: '2px 7px' } }, x.ep.code),
        el('.ri-main', null, [
          el('.ri-title', { style: { fontSize: '13px' } }, x.su.name + '  ·  ' + x.ep.title),
          el('.ri-sub', null, [
            el('span.dept-chip', { style: { padding: '1px 7px', fontSize: '10px', marginRight: '8px' } }, [el('span.dot', { style: { background: dep.color } }), dep.label]),
            (person ? person.name + ' · ' : '') + 'due ' + App.fmtDate(x.su.due)
          ])
        ]),
        el('button.ghost', { style: { borderColor: 'rgba(0,200,117,.5)', color: '#6ee0aa' }, onclick: () => App.setStatus(x.ep.id, x.su.key, 'approved') }, '✓ Approve'),
        el('button.ghost', { style: { borderColor: 'rgba(253,171,61,.5)', color: '#ffce8e' }, onclick: () => App.setStatus(x.ep.id, x.su.key, 'in_progress') }, '↩ Send back')
      ]));
    });
    wrap.appendChild(list);
    return wrap;
  }

  // ---- helpers ----
  function selectEl(options, value, onChange) {
    const sel = el('select.filter');
    options.forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = label; if (v === value) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', e => onChange(e.target.value));
    return sel;
  }

  let _t = null;
  function debouncedRender() { clearTimeout(_t); _t = setTimeout(App.render, 160); }
})();
