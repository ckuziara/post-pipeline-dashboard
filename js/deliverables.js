/* Deliverables page — what every task in a pipeline hands over.

   Opened from Edit Pipeline / Add Show and from Admin → Workflow pipeline
   presets ("PAM", or a task's "Edit in PAM…"), and from Edit Show ("PAM",
   App.openShowPam, which saves on Done). It edits the
   pipeline it was given IN PLACE — the same array the pipeline editor holds —
   so the draft, and the editor's undo step taken before opening, stay whole.

     top      the pipeline's tasks, grouped by department; pick one
     bottom   left: suggestions (learned from every pipeline on the board,
                    App.suggestDeliverables) and a smart search of the
                    Naming Conventions catalogue (App.searchDeliverables)
              right: what the selected task delivers, each with the file name
                    PAM will give it

   An output is exact ({ suffix, type }), internal (the studio's own suffix,
   never for Moonbase) or soft (a versioned folder of files that keep their
   own names) — see js/naming.js App.taskOutputs. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const SAMPLE = { contentCode: 'KYI0246', languages: ['ENUS'], format: 'FD' };
  const TYPE_CHIPS = ['WAV', 'MOV', 'MP4', 'SRT', 'PDF', 'DOCX', 'XLSX', 'PNG'];

  App.deliverablesPage = {
    _layer: null,

    /* pipe: the pipeline array (edited in place). opts.focusKey: the task to
       open on. opts.identity(): { contentCode, languages, format } for real
       file-name previews (a show being edited); without it, a sample name.
       opts.onDone(): called once on close. */
    open(pipe, opts) {
      this.close();
      opts = opts || {};
      const tasks = () => pipe.filter(t => !t.ko);
      const st = {
        key: (opts.focusKey && tasks().some(t => t.key === opts.focusKey)) ? opts.focusKey : (tasks()[0] || {}).key,
        dept: 'all', attention: false, q: '', type: 'All', adding: null
      };
      let id = SAMPLE;
      try { const got = opts.identity && opts.identity(); if (got && got.contentCode && got.format) id = got; } catch (e) { /* sample it is */ }
      const catalogue = App.deliverableCatalogue();
      const labelOf = (o) => {
        if (o.soft) return o.label || o.suffix;
        const hit = catalogue.find(c => c.suffix === o.suffix && (!o.type || c.type === o.type)) || catalogue.find(c => c.suffix === o.suffix);
        return hit ? hit.label : o.suffix;
      };
      const task = () => pipe.find(t => t.key === st.key);
      const outsOf = (t) => App.taskOutputs(t, null);
      const has = (t, o) => outsOf(t).some(x => App.outputKey(x) === App.outputKey(o));
      // every edit materialises the list as the task's own (no longer the default)
      const setOuts = (t, list) => { if (list) t.outputs = list.map(App.cleanOutput); else delete t.outputs; drawTasks(); drawBottom(); };
      const toggle = (o) => {
        const t = task(); if (!t) return;
        const cur = outsOf(t);
        setOuts(t, has(t, o) ? cur.filter(x => App.outputKey(x) !== App.outputKey(o)) : cur.concat([o]));
      };
      const addAll = (list) => { const t = task(); if (!t) return; const cur = outsOf(t); setOuts(t, cur.concat(list.filter(o => !cur.some(x => App.outputKey(x) === App.outputKey(o))))); };
      const preview = (o) => {
        const lang = (id.languages && id.languages[0]) || 'ENUS';
        const base = App.buildName({ contentCode: id.contentCode, language: lang, format: id.format, suffix: o.suffix, version: 1 });
        return o.soft ? base + '/' : base + (o.type ? '.' + o.type.toLowerCase() : '.*');
      };

      // ---------------------------------------------------------------- shell
      const layer = el('.dlv-layer', { onclick: (e) => e.stopPropagation() });
      const tasksBox = el('.dlv-tasks');
      const filters = el('.dlv-filters');
      const left = el('.dlv-left');
      const right = el('.dlv-right');
      const done = () => { this.close(); if (opts.onDone) opts.onDone(); };
      const searchIn = el('input.fld.dlv-search', {
        id: 'dlv-search', type: 'text', spellcheck: 'false',
        placeholder: 'Search: m&e, dialogue, textless mp4 no intro, srt…',
        oninput: () => { st.q = searchIn.value; drawResults(); }
      });
      const results = el('.dlv-results');
      const typeRow = el('.dlv-typechips');

      layer.appendChild(el('.dlv-page', null, [
        el('.dlv-head', null, [
          el('div', null, [
            el('.dlv-title', null, [App.icon('package'), ' PAM · Deliverables', opts.title ? el('span.dlv-title-sub', null, ' · ' + opts.title) : null])
          ]),
          el('button.btn-primary', { onclick: done }, 'Done')
        ]),
        filters,
        tasksBox,
        el('.dlv-bottom', null, [left, right])
      ]));
      document.body.appendChild(layer);
      this._layer = layer;
      this._keys = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(); return; }
        if (!['ArrowDown', 'ArrowUp'].includes(e.key) || /input|select|textarea/i.test((document.activeElement || {}).tagName || '')) return;
        const list = visibleTasks(); const i = list.findIndex(t => t.key === st.key);
        const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next && next.key !== st.key) { e.preventDefault(); st.key = next.key; st.adding = null; drawTasks(); drawBottom(); }
      };
      document.addEventListener('keydown', this._keys, true);

      // ----------------------------------------------------------- top half
      const visibleTasks = () => tasks().filter(t => (st.dept === 'all' || t.dept === st.dept) && (!st.attention || !(t.outputs && t.outputs.length)));
      const summary = (t) => {
        const outs = outsOf(t), soft = outs.filter(o => o.soft).length, files = outs.length - soft;
        return [files ? files + ' file' + (files === 1 ? '' : 's') : null, soft ? soft + ' soft folder' + (soft === 1 ? '' : 's') : null].filter(Boolean).join(' · ') || 'nothing';
      };
      function drawFilters() {
        filters.innerHTML = '';
        const depts = [...new Set(tasks().map(t => t.dept))];
        const chip = (label, on, fn) => el('button.dlv-chip' + (on ? '.on' : ''), { type: 'button', onclick: fn }, label);
        filters.appendChild(chip('All departments', st.dept === 'all', () => { st.dept = 'all'; drawFilters(); drawTasks(); }));
        depts.forEach(d => filters.appendChild(chip(App.dept(d).label, st.dept === d, () => { st.dept = d; drawFilters(); drawTasks(); })));
        const custom = tasks().filter(t => t.outputs && t.outputs.length).length;
        filters.appendChild(el('span.dlv-spacer'));
        filters.appendChild(chip('Still on defaults · ' + (tasks().length - custom), st.attention, () => { st.attention = !st.attention; drawFilters(); drawTasks(); }));
      }
      function drawTasks() {
        tasksBox.innerHTML = '';
        let lastDept = null;
        visibleTasks().forEach(t => {
          if (t.dept !== lastDept) {
            lastDept = t.dept;
            tasksBox.appendChild(el('.dlv-dept', null, [el('span.dot', { style: { background: App.dept(t.dept).color } }), App.dept(t.dept).label]));
          }
          const own = !!(t.outputs && t.outputs.length);
          const row = el('button.dlv-task' + (t.key === st.key ? '.on' : ''), {
            type: 'button', onclick: () => { st.key = t.key; st.adding = null; drawTasks(); drawBottom(); }
          }, [
            el('span.dlv-task-name', null, t.name),
            el('span.dlv-task-sum', null, summary(t)),
            el('span.dlv-state.' + (own ? 'custom' : 'default'), null, own ? 'custom' : 'default')
          ]);
          tasksBox.appendChild(row);
        });
        if (!tasksBox.children.length) tasksBox.appendChild(el('.dlv-empty', null, 'No tasks match these filters.'));
        const on = tasksBox.querySelector('.dlv-task.on');
        if (on) on.scrollIntoView({ block: 'nearest' });
      }

      // -------------------------------------------------------- bottom left
      function suggestions(t) {
        const s = App.suggestDeliverables(t.key, t.dept);
        const box = el('.dlv-sugg');
        const chip = (o, meta) => el('button.dlv-chip' + (has(t, o) ? '.added' : ''), {
          type: 'button', title: has(t, o) ? 'Remove from ' + t.name : 'Add to ' + t.name, onclick: () => toggle(o)
        }, [has(t, o) ? '✓ ' : '+ ', labelOf(o), o.soft ? ' · folder' : o.type ? ' · ' + o.type : '', meta ? el('span.dlv-chip-meta', null, meta) : null]);
        const group = (title, items) => { if (!items.length) return; box.appendChild(el('.dlv-sugg-title', null, title)); box.appendChild(el('.dlv-chiprow', null, items)); };
        if (s.set) {
          const all = s.set.items.every(o => has(t, o));
          group('The usual set for ' + t.name, [el('button.dlv-chip.set' + (all ? '.added' : ''), {
            type: 'button', onclick: () => addAll(s.set.items)
          }, [App.icon('package'), ' ', s.set.items.map(labelOf).join(', '), el('span.dlv-chip-meta', null, s.set.count + ' of ' + s.set.of)])]);
        }
        group(t.name + ' usually delivers', s.task.map(o => chip(o, o.count + ' of ' + o.of)));
        group(App.dept(t.dept).label + ' often picks', s.dept.map(o => chip(o, o.count + '×')));
        if (!s.task.length && s.defaults.length) group('Standard for ' + t.name, s.defaults.map(o => chip(o)));
        if (!box.children.length) box.appendChild(el('.dlv-sugg-none', null, 'No history for ' + t.name + ' yet — what you pick here becomes the suggestion next time.'));
        return box;
      }
      function drawResults() {
        const t = task(); results.innerHTML = '';
        if (!t) return;
        let found = App.searchDeliverables(st.q, { catalogue });
        if (st.type !== 'All') found = found.filter(e => e.type === st.type);
        const row = (e) => el('.dlv-row' + (has(t, e) ? '.added' : ''), null, [
          el('div', { style: { minWidth: 0 } }, [
            el('.dlv-row-label', null, [e.label, el('span.dlv-code', null, e.suffix)]),
            e.desc ? el('.dlv-row-desc', null, e.desc) : null
          ]),
          el('span.dlv-type', null, e.type || 'any'),
          el('button.dlv-add', { type: 'button', title: has(t, e) ? 'Remove' : 'Add', onclick: () => toggle({ suffix: e.suffix, type: e.type }) }, has(t, e) ? '✓' : '+')
        ]);
        if (!st.q.trim()) {
          App.DELIVERABLE_CATEGORIES.forEach(c => {
            const inCat = found.filter(e => e.category === c); if (!inCat.length) return;
            results.appendChild(el('.dlv-cat', null, c));
            inCat.forEach(e => results.appendChild(row(e)));
          });
        } else {
          found.slice(0, 40).forEach(e => results.appendChild(row(e)));
          if (!found.length) results.appendChild(el('.dlv-empty', null, 'Nothing in Naming Conventions matches “' + st.q.trim() + '”.'));
          // not in the convention: make it the studio's own
          const name = st.q.trim();
          results.appendChild(el('.dlv-make', null, [
            el('button.dlv-chip', { type: 'button', onclick: () => { st.adding = { kind: 'soft', text: name }; drawRight(); } },
              ['+ Soft delivery “', name, '” (folder)']),
            el('button.dlv-chip', { type: 'button', onclick: () => { st.adding = { kind: 'internal', text: name }; drawRight(); } },
              ['+ Custom internal file “', name, '”'])
          ]));
        }
      }
      function drawLeft() {
        const t = task(); left.innerHTML = '';
        if (!t) return;
        left.appendChild(suggestions(t));
        typeRow.innerHTML = '';
        ['All'].concat(TYPE_CHIPS).forEach(ty => typeRow.appendChild(el('button.dlv-chip.sm' + (st.type === ty ? '.on' : ''), {
          type: 'button', onclick: () => { st.type = ty; drawLeft(); }
        }, ty)));
        left.appendChild(el('.dlv-searchbar', null, [searchIn, typeRow]));
        left.appendChild(results);
        drawResults();
      }

      // ------------------------------------------------------- bottom right
      function adder() {
        const a = st.adding; if (!a) return null;
        const nameIn = el('input.fld', { type: 'text', value: a.text || '', placeholder: a.kind === 'soft' ? 'VO stems' : 'Walla' });
        const typeSel = el('select.fld');
        [['', a.kind === 'soft' ? 'Any type' : 'Any type'], ...['WAV', 'MOV', 'MP4', 'PDF', 'PNG', 'AEP', 'PSD'].map(x => [x, x])].forEach(([v, l]) => {
          const o = document.createElement('option'); o.value = v; o.textContent = l; typeSel.appendChild(o);
        });
        const commit = () => {
          const label = nameIn.value.trim();
          const suffix = App.suffixFromLabel(label);
          if (!suffix) { App.toast('Give it a name first', true); return; }
          const o = a.kind === 'soft'
            ? { suffix, soft: true, label, types: typeSel.value ? [typeSel.value] : [] }
            : { suffix, type: typeSel.value, internal: true };
          st.adding = null; st.q = ''; searchIn.value = '';
          addAll([o]); drawResults();
        };
        nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });
        setTimeout(() => nameIn.focus(), 0);
        return el('.dlv-adder', null, [
          el('.dlv-adder-title', null, a.kind === 'soft'
            ? 'Soft delivery — a folder of files that keep their own names'
            : 'Custom internal file — the studio’s own, never sent to Moonbase'),
          el('.dlv-adder-row', null, [nameIn, typeSel,
            el('button.btn-primary', { type: 'button', onclick: commit }, 'Add'),
            el('button.btn-ghost', { type: 'button', onclick: () => { st.adding = null; drawRight(); } }, 'Cancel')])
        ]);
      }
      function drawRight() {
        const t = task(); right.innerHTML = '';
        if (!t) return;
        const outs = outsOf(t);
        right.appendChild(el('.dlv-right-head', null, [
          el('div', null, [el('.dlv-right-title', null, t.name + ' delivers'), el('.dlv-sub', null, App.dept(t.dept).label + (t.outputs && t.outputs.length ? '' : ' · the default list'))]),
          el('span.dlv-count', null, outs.length + ' item' + (outs.length === 1 ? '' : 's'))
        ]));
        const list = el('.dlv-sel');
        outs.forEach(o => {
          const labelEl = o.soft
            ? el('input.fld.dlv-soft-label', { type: 'text', value: o.label || o.suffix, title: 'What people call this folder',
                onchange: (e) => { const cur = outsOf(t).map(x => App.outputKey(x) === App.outputKey(o) ? Object.assign({}, x, { label: e.target.value.trim() || x.suffix }) : x); setOuts(t, cur); } })
            : el('.dlv-row-label', null, [labelOf(o), el('span.dlv-code', null, o.suffix)]);
          list.appendChild(el('.dlv-row.sel', null, [
            el('div', { style: { minWidth: 0 } }, [labelEl, el('code.dlv-name', null, preview(o))]),
            el('span.dlv-type' + (o.soft ? '.soft' : o.internal ? '.internal' : ''), null, o.soft ? 'folder' : o.internal ? (o.type || 'any') + ' · internal' : (o.type || 'any')),
            el('button.dlv-add', { type: 'button', title: 'Remove', onclick: () => toggle(o) }, '×')
          ]));
        });
        if (!outs.length) list.appendChild(el('.dlv-empty', null, t.name + ' hands nothing over. Add something from the left.'));
        right.appendChild(list);
        const ad = adder(); if (ad) right.appendChild(ad);
        right.appendChild(el('.dlv-right-foot', null, [
          el('button.dlv-chip', { type: 'button', onclick: () => { st.adding = { kind: 'soft', text: '' }; drawRight(); } }, '+ Soft delivery (folder)'),
          el('button.dlv-chip', { type: 'button', onclick: () => { st.adding = { kind: 'internal', text: '' }; drawRight(); } }, '+ Custom internal file'),
          t.outputs && t.outputs.length ? el('button.dlv-chip.ghost', { type: 'button', title: 'Back to the standard list for this task', onclick: () => setOuts(t, null) }, 'Reset to default') : null
        ]));
      }
      function drawBottom() { drawLeft(); drawRight(); }

      drawFilters(); drawTasks(); drawBottom();
    },

    close() {
      if (this._keys) { document.removeEventListener('keydown', this._keys, true); this._keys = null; }
      if (this._layer) { this._layer.remove(); this._layer = null; }
    }
  };

  /* PAM from Edit Show: the page over a copy of the show's pipeline, saved
     to the show on Done. Only deliverables change — nothing is re-planned. A
     show still on the built-in pipeline takes its own copy the first time
     its deliverables are set, as Edit Pipeline would. */
  App.openShowPam = function (showId) {
    const show = App.state.data.shows.find(s => s.id === showId);
    if (!show) return;
    if (!App.canManageShows(App.state.role)) { App.toast('Only Producers can change shows', true); return; }
    const pipe = JSON.parse(JSON.stringify(App.showPipeline(show)));
    const before = JSON.stringify(pipe.map(t => t.outputs || null));
    const ep0 = App.state.data.episodes.find(e => e.showId === showId && !e.archived) || {};
    App.deliverablesPage.open(pipe, {
      title: show.name,
      identity: () => App.namingIdentity(ep0, show),
      onDone: () => {
        if (JSON.stringify(pipe.map(t => t.outputs || null)) === before) return;
        App.mutate(d => {
          const s = d.shows.find(x => x.id === showId); if (!s) return;
          if (!Array.isArray(s.pipeline)) s.pipeline = JSON.parse(JSON.stringify(App.showPipeline(s)));
          s.pipeline.forEach(t => {
            const mine = pipe.find(x => x.key === t.key);
            if (mine && mine.outputs && mine.outputs.length) t.outputs = mine.outputs.map(App.cleanOutput); else delete t.outputs;
          });
        }, 'deliverables');
        App.toast('Saved deliverables for ' + show.name);
      }
    });
  };
})();
