/* Demo tour — a big animated cursor for screen-recording a trailer.
   Two ways to drive it:
     App.tour.play()             — a hand-written showcase sequence
     App.tour.replay(log, opts)  — an EXACT 1:1 replay of a real recording
                                    from App.recorder (App.recorder.log, or
                                    the JSON you pasted back from a session)
   Both snapshot the whole board first and restore it byte-for-byte at the
   end (drag, new show, new pipeline preset, archive — everything), so the
   staged data is untouched afterward and either can be re-run any number of
   times. Stop early with App.tour.stop(). */
window.App = window.App || {};
(function () {
  'use strict';

  const CURSOR_SVG = '<svg width="40" height="40" viewBox="0 0 24 24">' +
    '<path fill="#fff" stroke="#111318" stroke-width="1.4" stroke-linejoin="round" ' +
    'd="M5 2.5 L5 20.5 L9.7 16.2 L12.7 22.5 L15.2 21.4 L12.3 15.3 L18.6 15 Z"/></svg>';

  // ---- element relocation for replay ----
  // Recorder entries carry `loc` ({tag, cls, text, attrs}). Older recordings
  // (before this was added) only have a human `desc` string — parseDescToLoc
  // recovers an equivalent loc from that, so old logs still replay.
  function parseDescToLoc(desc) {
    if (!desc) return null;
    const m = desc.match(/^<([a-z0-9]+)(?:#[\w-]+)?((?:\.[\w-]+)*)>(?:\s+"([^"]*)")?(?:\s+\[([^\]]*)\])?/i);
    if (!m) return null;
    const cls = (m[2] || '').split('.').filter(Boolean).join(' ');
    const bracket = m[4] || '';
    const attrs = bracket.split(',').filter(Boolean).map(kv => {
      const [k, v] = kv.split('=');
      const a = k === 'ep' ? 'data-episode-id' : k === 'task' ? 'data-su-key' : k === 'view' ? 'data-view' : k;
      return { a, v };
    });
    return { tag: m[1], cls, text: m[3] || '', attrs };
  }
  const escapeAttr = (v) => (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/"/g, '\\"');

  // The narrowest candidate set this loc can identify: tag+class+attrs first
  // (e.g. two number inputs — episode count vs. cadence — share tag/class,
  // so attrs alone isn't always unique either), THEN filtered by own text if
  // that narrows further (e.g. many ".pipe-row.compact" rows share tag/class
  // but each has distinct text — "19 Wallah V2 4d"). Only a final count of 1
  // counts as unambiguous; anything else goes through the claim-order
  // fallback in replay() rather than silently guessing the first match.
  function candidatesFor(loc) {
    if (!loc) return [];
    let sel = loc.tag || '*';
    if (loc.cls) sel += '.' + loc.cls.split(/\s+/).join('.');
    if (loc.attrs && loc.attrs.length) sel += loc.attrs.map(a => '[' + a.a + '="' + escapeAttr(a.v) + '"]').join('');
    let cands;
    try { cands = [...document.querySelectorAll(sel)]; } catch (e) { cands = []; }
    if (cands.length > 1 && loc.text) {
      const exact = cands.filter(c => (c.textContent || '').trim() === loc.text);
      if (exact.length) return exact;
      const partial = cands.filter(c => (c.textContent || '').trim().includes(loc.text.slice(0, 24)));
      if (partial.length) return partial;
    }
    return cands;
  }
  function locateByAttrsOrText(loc) {
    const cands = candidatesFor(loc);
    return cands[0] || null;
  }

  App.tour = {
    playing: false,
    _abort: false,

    ensure() {
      if (this.cursor) return;
      const c = document.createElement('div');
      c.className = 'tour-cursor';
      c.innerHTML = CURSOR_SVG;
      document.body.appendChild(c);
      const cap = document.createElement('div');
      cap.className = 'tour-caption';
      document.body.appendChild(cap);
      this.cursor = c; this.caption = cap;
      this.x = window.innerWidth / 2; this.y = window.innerHeight * 0.5;
      this._place(0);
    },
    teardown() {
      if (this.cursor) this.cursor.remove();
      if (this.caption) this.caption.remove();
      this.cursor = this.caption = null;
    },

    _place(dur) {
      this.cursor.style.transition = dur ? 'transform ' + dur + 'ms cubic-bezier(.45,.05,.2,1)' : 'none';
      this.cursor.style.transform = 'translate(' + this.x + 'px,' + this.y + 'px)';
    },
    sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

    async moveTo(x, y, dur) {
      dur = dur || 950;
      this.x = x; this.y = y; this._place(dur);
      await this.sleep(dur + 70);
    },
    async moveToEl(elm, dur, ox, oy) {
      if (!elm) return;
      const r = elm.getBoundingClientRect();
      await this.moveTo(r.left + r.width / 2 + (ox || 0), r.top + r.height / 2 + (oy || 0), dur);
    },
    ripple() {
      const rp = document.createElement('div');
      rp.className = 'tour-ripple';
      rp.style.left = this.x + 'px'; rp.style.top = this.y + 'px';
      document.body.appendChild(rp);
      setTimeout(() => rp.remove(), 550);
    },
    async clickEl(elm) {
      if (!elm) return;
      this.ripple();
      await this.sleep(200);
      elm.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: this.x, clientY: this.y }));
      await this.sleep(150);
    },
    say(text) { this.caption.textContent = text || ''; this.caption.classList.toggle('show', !!text); },

    // types into a native input/textarea one character at a time, cursor
    // hovering over the field, so real keystrokes are visible on camera
    async typeInto(input, text, dur) {
      if (!input) return;
      await this.moveToEl(input, dur || 700);
      this.ripple();
      input.focus();
      input.value = '';
      for (const ch of text) {
        if (this._abort) break;
        input.value += ch;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await this.sleep(55 + Math.random() * 70);
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await this.sleep(300);
    },

    // horizontally centre a timeline element within the gantt scroller
    scrollIntoTimeline(elm, frac) {
      const s = App.gantt && App.gantt._scrollEl;
      if (!s || !elm) return;
      const r = elm.getBoundingClientRect(), sr = s.getBoundingClientRect();
      s.scrollLeft += (r.left - sr.left) - s.clientWidth * (frac == null ? 0.4 : frac);
    },

    // move-drag a task bar by `cols` columns, then commit; cursor rides along
    async dragBar(bar, cols) {
      if (!bar) return;
      const r = bar.getBoundingClientRect();
      const startX = r.left + r.width / 2, y = r.top + r.height / 2;
      await this.moveTo(startX, y, 650);
      const dw = App.state.zoom, total = cols * dw, steps = 16;
      bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: y }));
      for (let i = 1; i <= steps; i++) {
        if (this._abort) break;
        const cx = startX + total * (i / steps);
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: y }));
        this.x = cx; this.y = y; this._place(60);
        await this.sleep(55);
      }
      await this.sleep(750);   // hold so the date / dependency tooltip reads on camera
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: startX + total, clientY: y }));
      await this.sleep(500);
    },

    // same as dragBar, but by an exact recorded pixel delta (for replay)
    async dragBarPx(bar, deltaPx) {
      if (!bar) return;
      const r = bar.getBoundingClientRect();
      const startX = r.left + r.width / 2, y = r.top + r.height / 2;
      await this.moveTo(startX, y, 650);
      const steps = Math.max(6, Math.min(24, Math.round(Math.abs(deltaPx) / 8)));
      bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: y }));
      for (let i = 1; i <= steps; i++) {
        if (this._abort) break;
        const cx = startX + deltaPx * (i / steps);
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: y }));
        this.x = cx; this.y = y; this._place(60);
        await this.sleep(45);
      }
      await this.sleep(600);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: startX + deltaPx, clientY: y }));
      await this.sleep(350);
    },

    stop() { this._abort = true; },

    // ---- exact replay of a App.recorder log ----
    // Preserves order and (by default) real inter-action timing. Elements are
    // re-found live via each entry's loc (data attrs / placeholder+type / own
    // text) rather than the recorded x,y, so it's resilient to the window
    // being a different size than when you recorded. Same-shaped, text-less
    // inputs (e.g. several plain "Add Show" fields) are disambiguated by
    // claim order: a click on one claims "the next unclaimed match in DOM
    // order", and subsequent keystrokes on the same ambiguous shape reuse
    // that claim until a new ambiguous click reassigns it — mirroring how you
    // actually tabbed between fields while recording.
    async replay(log, opts) {
      log = log || (App.recorder && App.recorder.log);
      if (!log || !log.length) { console.log('Nothing to replay — pass a log, e.g. App.tour.replay(App.recorder.log)'); return; }
      if (this.playing) return;
      this.playing = true; this._abort = false;
      this.ensure();

      const speed = (opts && opts.speed) || 1;
      const maxGap = (opts && opts.maxGap) || Infinity;
      const sortBefore = App.prefs.get('timelineSort', 'department');
      const filtersBefore = JSON.parse(JSON.stringify(App.state.filters));
      const snapshot = JSON.parse(JSON.stringify(App.state.data));
      if (App.api && App.api._pollTimer) { clearInterval(App.api._pollTimer); App.api._pollTimer = null; }

      const claimed = [];               // elements already assigned to an ambiguous shape this run
      let currentAmbiguous = null;      // the field currently "focused" for ambiguous typing
      const resolveAmbiguous = (loc) => {
        const cands = candidatesFor(loc);
        const avail = cands.filter(c => !claimed.includes(c));
        const chosen = avail[0] || cands[0] || null;
        if (chosen) claimed.push(chosen);
        return chosen;
      };
      // ambiguous = this loc's most specific selector still matches more than
      // one live element (e.g. episode-count vs. cadence are both bare
      // number inputs) — only then do we fall back to claim-order guessing
      const resolve = (loc, isClickLike) => {
        if (!loc) return null;
        if (candidatesFor(loc).length !== 1) {
          if (isClickLike || !currentAmbiguous) currentAmbiguous = resolveAmbiguous(loc);
          return currentAmbiguous;
        }
        currentAmbiguous = null;
        return locateByAttrsOrText(loc);
      };

      // If the log both creates a show AND later drags/clicks one of its
      // episodes, those episode ids were random at record time and won't
      // exist under the same value now — a fresh id is minted on replay too.
      // Track any data-episode-id that doesn't resolve, then once a new show
      // appears, map its episodes (in code order) onto whichever stale ids
      // were seen first — same relative order they were originally created in.
      const episodeIdMap = {};
      const pendingEpisodeIds = [];
      const remapLoc = (loc) => {
        if (!loc || !loc.attrs || !loc.attrs.length) return loc;
        const attrs = loc.attrs.map(a => {
          if (a.a !== 'data-episode-id') return a;
          if (episodeIdMap[a.v]) return { a: a.a, v: episodeIdMap[a.v] };
          if (!App.state.data.episodes.some(ep => ep.id === a.v) && !pendingEpisodeIds.includes(a.v)) pendingEpisodeIds.push(a.v);
          return a;
        });
        return { tag: loc.tag, cls: loc.cls, text: loc.text, attrs };
      };
      const claimNewShowEpisodes = (showsBefore) => {
        if (!pendingEpisodeIds.length) return;
        const newShow = App.state.data.shows.find(s => !showsBefore.some(b => b.id === s.id));
        if (!newShow) return;
        const eps = App.state.data.episodes.filter(ep => ep.showId === newShow.id).sort((a, b) => a.code < b.code ? -1 : 1);
        eps.forEach((ep, i) => { if (i < pendingEpisodeIds.length) episodeIdMap[pendingEpisodeIds[i]] = ep.id; });
        pendingEpisodeIds.length = 0;
      };

      try {
        let lastT = 0;
        for (let i = 0; i < log.length; i++) {
          if (this._abort) break;
          const e = log[i];
          const gap = Math.min(Math.max(e.t - lastT, 0), maxGap) / speed;
          if (gap > 0) await this.sleep(gap);
          lastT = e.t;
          const loc = remapLoc(e.loc || parseDescToLoc(e.desc));

          if (e.type === 'click') {
            const target = resolve(loc, true);
            if (!target) continue;
            const showsBefore = App.state.data.shows.slice();
            await this.moveToEl(target, Math.min(900, Math.max(350, gap || 500)));
            await this.clickEl(target);
            claimNewShowEpisodes(showsBefore);
          } else if (e.type === 'input') {
            const target = resolve(loc, false);
            if (!target) continue;
            if (document.activeElement !== target) { await this.moveToEl(target, 500); target.focus(); }
            if ('value' in target) target.value = e.value; else target.textContent = e.value;
            target.dispatchEvent(new Event('input', { bubbles: true }));
          } else if (e.type === 'select') {
            const target = resolve(loc, true);
            if (!target) continue;
            await this.moveToEl(target, 600);
            target.value = e.value;
            target.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (e.type === 'key') {
            const target = resolve(loc, false) || document.activeElement;
            if (target) target.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true }));
            // Tab/Enter move focus to a different field without a click —
            // release the ambiguous claim so the next keystroke re-resolves
            if (e.key === 'Tab' || e.key === 'Enter') currentAmbiguous = null;
          } else if (e.type === 'drag') {
            const target = locateByAttrsOrText(loc);
            if (target) await this.dragBarPx(target, e.deltaPx);
          } else if (e.type === 'scroll') {
            const scroller = (loc && loc.tag === '__window__')
              ? (document.scrollingElement || document.documentElement)
              : (locateByAttrsOrText(loc) || (App.gantt && App.gantt._scrollEl));
            if (scroller) {
              try { scroller.scrollTo({ left: e.left, top: e.top, behavior: 'smooth' }); }
              catch (err) { scroller.scrollLeft = e.left; scroller.scrollTop = e.top; }
              await this.sleep(Math.min(500, Math.max(180, gap || 260)));
            }
          }
        }
      } finally {
        App.state.data = snapshot;
        App.state.filters = filtersBefore;
        App.prefs.set('timelineSort', sortBefore);
        App.state.ganttExpanded = {}; App.state.expanded = {};
        if (App.state.admin) App.state.admin.presetDraft = null;
        App.save();
        App.render();
        App.gantt.centerToday && App.gantt.centerToday();
        if (App.api && App.api.online && App.api.me && App.api.startPolling) App.api.startPolling();
        this.teardown();
        this.playing = false;
      }
    },

    async play() {
      if (this.playing) return;
      this.playing = true; this._abort = false;
      this.ensure();
      const sortBefore = App.prefs.get('timelineSort', 'department');
      const filtersBefore = JSON.parse(JSON.stringify(App.state.filters));
      // snapshot the whole board so every change the tour makes — new show,
      // dragged task, new pipeline preset, archived show, flipped permission —
      // is reverted cleanly at the end. The staged data is left byte-for-byte
      // identical and the tour is fully re-runnable.
      const snapshot = JSON.parse(JSON.stringify(App.state.data));
      if (App.api && App.api._pollTimer) { clearInterval(App.api._pollTimer); App.api._pollTimer = null; }

      const step = async (fn) => { if (!this._abort) await fn(); };
      const findRow = (title) => [...document.querySelectorAll('.g-row:not(.sub)')].find(r => r.textContent.includes(title));
      const goToTab = async (view) => {
        const tab = [...document.querySelectorAll('.view-tab')].find(t => t.dataset.view === view);
        await this.moveToEl(tab, 900);
        await this.clickEl(tab);
        await this.sleep(700);
      };

      try {
        // ---- 1. intro ----
        App.state.view = 'timeline'; App.state.ganttExpanded = {}; App.render();
        App.gantt.centerToday && App.gantt.centerToday();
        await this.moveTo(window.innerWidth / 2, window.innerHeight * 0.45, 10);
        this.say('Post Pipeline — episodic post-production, under control');
        await this.sleep(2400);

        // ---- 2. timeline overview ----
        await step(async () => {
          this.say('Every episode of every show on one timeline');
          await this.moveTo(window.innerWidth * 0.3, window.innerHeight * 0.35, 1100);
          await this.moveTo(window.innerWidth * 0.6, window.innerHeight * 0.55, 1100);
          await this.sleep(600);
        });

        // ---- 3. create a show, live ----
        let newShowId = null;
        await step(async () => {
          this.say('Spin up a new show in seconds');
          await goToTab('board');
          const addBtn = document.querySelector('.btn-addshow');
          await this.moveToEl(addBtn, 900);
          await this.clickEl(addBtn);
          await this.sleep(700);

          const modal = document.querySelector('.modal-card');
          if (modal) {
            const nameInput = modal.querySelector('input.fld[placeholder="e.g. Little Angel"]');
            const codeInput = modal.querySelector('input.fld[placeholder="e.g. LA"]');
            await this.typeInto(nameInput, 'Air Asia Safari', 800);
            await this.typeInto(codeInput, 'AS', 500);

            this.say('Customize the pipeline — add, remove, reorder, retime');
            const toggle = [...modal.querySelectorAll('.pipe-toggle-lbl')].find(s => /Customize Pipeline/.test(s.textContent));
            await this.moveToEl(toggle, 800);
            await this.clickEl(toggle);
            await this.sleep(500);
            const row = modal.querySelector('.pipe-row.compact');
            await this.moveToEl(row, 800);
            await this.clickEl(row);
            await this.sleep(900);
            const done = modal.querySelector('.btn-done');
            await this.moveToEl(done, 700);
            await this.clickEl(done);
            await this.sleep(400);

            this.say('One click — fully scheduled from a recommended pace');
            const create = [...modal.querySelectorAll('.btn-primary')].find(b => /Create Show/.test(b.textContent));
            await this.moveToEl(create, 900);
            const before = new Set(App.state.data.shows.map(s => s.id));
            await this.clickEl(create);
            await this.sleep(900);
            const after = App.state.data.shows.find(s => !before.has(s.id));
            if (after) newShowId = after.id;
          }
        });

        // ---- 4. filter to the new show on the board ----
        await step(async () => {
          if (newShowId) { App.state.filters.show = [newShowId]; App.render(); }
          await this.sleep(500);
          const grp = document.querySelector('.ep-row');
          await this.moveToEl(grp, 800);
          await this.clickEl(grp);
          await this.sleep(1300);
        });

        // ---- 5. timeline: expand + drag to reschedule ----
        await step(async () => {
          await goToTab('timeline');
          App.state.ganttExpanded = {};
          App.render();
          App.gantt.centerToday && App.gantt.centerToday();
          const row = [...document.querySelectorAll('.g-row:not(.sub)')][0];
          await this.moveToEl(row && row.querySelector('.g-label'), 900);
          await this.clickEl(row && row.querySelector('.g-label'));
          await this.sleep(900);

          this.say('Drag to reschedule — minimums and dependencies are checked live');
          let bar = [...document.querySelectorAll('.g-row.sub .bar[data-su-key]')][2];
          if (bar) {
            this.scrollIntoTimeline(bar, 0.35);
            await this.sleep(450);
            bar = [...document.querySelectorAll('.g-row.sub .bar[data-su-key]')][2];
            const key = bar.dataset.suKey;
            await this.dragBar(bar, 4);
            const back = [...document.querySelectorAll('.g-row.sub .bar[data-su-key="' + key + '"]')][0];
            await this.dragBar(back, -4);
          }
          await this.sleep(400);
        });

        // ---- 6. board: change a status, approve as a reviewer ----
        await step(async () => {
          App.state.filters.show = filtersBefore.show; App.render();
          await goToTab('board');
          this.say('Change status inline — or approve as a reviewer');
          const cell = document.querySelector('.status-cell');
          await this.moveToEl(cell, 900);
          await this.clickEl(cell);
          await this.sleep(500);
          const opt = [...document.querySelectorAll('.status-opt')].find(b => /Review/.test(b.textContent));
          await this.moveToEl(opt, 700);
          await this.clickEl(opt);
          await this.sleep(900);
        });

        // ---- 7. journal ----
        await step(async () => {
          await goToTab('dashboard');
          this.say('A daily journal for handoff notes');
          const block = document.querySelector('.jr-block');
          if (block) {
            await this.moveToEl(block, 800);
            block.focus();
            const words = ['Great', ' progress', ' today', ' — ', 'on', ' track', '.'];
            for (const w of words) {
              if (this._abort) break;
              for (const ch of w) {
                block.textContent += ch;
                block.dispatchEvent(new Event('input', { bubbles: true }));
                await this.sleep(45 + Math.random() * 60);
              }
            }
            await this.sleep(700);
          }
        });

        // ---- 8. admin: team, access, workflow ----
        await step(async () => {
          this.say('Manage the team, roles and permissions');
          await goToTab('admin');
          const usersCard = [...document.querySelectorAll('.adm-card')].find(c => /User Directory|Manage Users/.test(c.textContent));
          await this.moveToEl(usersCard && usersCard.querySelector('.adm-btn'), 900);
          await this.clickEl(usersCard && usersCard.querySelector('.adm-btn'));
          await this.sleep(1000);
          const userRow = document.querySelector('.adm-row, .cell.u');
          await this.moveToEl(userRow, 800);
          await this.clickEl(userRow);
          await this.sleep(1000);

          const crumb = document.querySelector('.adm-crumb-link');
          await this.clickEl(crumb);
          await this.sleep(500);
          const accessCard = [...document.querySelectorAll('.adm-card')].find(c => /Access Control/.test(c.textContent));
          await this.moveToEl(accessCard && accessCard.querySelector('.adm-btn'), 900);
          await this.clickEl(accessCard && accessCard.querySelector('.adm-btn'));
          await this.sleep(1000);
          const permRow = document.querySelector('.adm-permrow');
          if (permRow) {
            await this.moveToEl(permRow.querySelector('.switch'), 800);
            await this.clickEl(permRow);
            await this.sleep(900);
            await this.clickEl(document.querySelector('.adm-permrow'));   // flip back
          }
          await this.sleep(400);
        });

        // ---- 9. admin: reusable pipelines ----
        await step(async () => {
          this.say('Build reusable pipelines for any show type');
          const crumb = [...document.querySelectorAll('.adm-crumb-link')].pop();
          await this.clickEl(crumb);
          await this.sleep(500);
          const wfCard = [...document.querySelectorAll('.adm-card')].find(c => /Configure Workflow/.test(c.textContent));
          await this.moveToEl(wfCard && wfCard.querySelector('.adm-btn'), 900);
          await this.clickEl(wfCard && wfCard.querySelector('.adm-btn'));
          await this.sleep(800);
          const pipelinesTab = [...document.querySelectorAll('.adm-role')].find(b => /Pipelines/.test(b.textContent));
          await this.moveToEl(pipelinesTab, 800);
          await this.clickEl(pipelinesTab);
          await this.sleep(700);

          const nameInput = document.querySelector('.wf-add input.fld');
          await this.typeInto(nameInput, 'Brand Short', 800);
          const create = [...document.querySelectorAll('.wf-add .btn-primary')].find(b => /New pipeline/.test(b.textContent));
          await this.moveToEl(create, 700);
          await this.clickEl(create);
          await this.sleep(700);

          const row = document.querySelector('.pipe-row.compact');
          const del = row && row.querySelector('.btn-row-x');
          if (del) { await this.moveToEl(del, 700); await this.clickEl(del); await this.sleep(500); }
          const save = [...document.querySelectorAll('.btn-primary')].find(b => /Save pipeline/.test(b.textContent));
          await this.moveToEl(save, 800);
          await this.clickEl(save);
          await this.sleep(900);
        });

        // ---- 10. admin: archive & restore a show ----
        await step(async () => {
          this.say('Archive a wrapped show without losing its history');
          const showsTab = [...document.querySelectorAll('.adm-role')].find(b => /Shows/.test(b.textContent));
          await this.moveToEl(showsTab, 800);
          await this.clickEl(showsTab);
          await this.sleep(700);
          const archBtn = document.querySelector('.show-arch-row.expandable .arch-actions .btn-mini');
          await this.moveToEl(archBtn, 900);
          const showRow = archBtn && archBtn.closest('.show-arch-row');
          const label = showRow ? showRow.querySelector('.adm-name').textContent : null;
          await this.clickEl(archBtn);
          await this.sleep(1300);
          // restore it — the tour leaves the roster exactly as it found it
          if (label) {
            const restore = [...document.querySelectorAll('.show-arch-row.archived')]
              .find(r => r.querySelector('.adm-name') && r.querySelector('.adm-name').textContent === label);
            const restoreBtn = restore && [...restore.querySelectorAll('.btn-mini')].find(b => /Restore/.test(b.textContent));
            if (restoreBtn) { await this.moveToEl(restoreBtn, 700); await this.clickEl(restoreBtn); await this.sleep(600); }
          }
        });

        // ---- 11. group the timeline by show ----
        await step(async () => {
          this.say('Group the timeline by show, department, or episode');
          App.state.view = 'timeline'; App.state.ganttExpanded = {}; App.render();
          const logo = document.getElementById('brand-logo');
          await this.moveToEl(logo, 900);
          await this.clickEl(logo);
          await this.sleep(600);
          const seg = [...document.querySelectorAll('.prefs-seg .seg')].find(b => b.textContent.trim() === 'Show');
          await this.moveToEl(seg, 700);
          await this.clickEl(seg);
          await this.sleep(300);
          document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));  // close menu
          App.gantt.centerToday && App.gantt.centerToday();
          await this.sleep(1700);
        });

        // ---- 12. outro ----
        await step(async () => {
          App.prefs.set('timelineSort', sortBefore);
          App.state.view = 'timeline'; App.state.ganttExpanded = {}; App.render();
          App.gantt.centerToday && App.gantt.centerToday();
          await this.moveTo(window.innerWidth / 2, window.innerHeight * 0.45, 1100);
          this.say('Post Pipeline');
          await this.sleep(2400);
          this.say('');
        });
      } finally {
        // restore the exact staged board, filters, grouping, and live sync no
        // matter how the run ended (completed or stopped early)
        App.state.data = snapshot;
        App.state.filters = filtersBefore;
        App.prefs.set('timelineSort', sortBefore);
        App.state.view = 'timeline'; App.state.ganttExpanded = {}; App.state.expanded = {};
        App.state.admin.presetDraft = null;
        App.save();
        App.render();
        App.gantt.centerToday && App.gantt.centerToday();
        if (App.api && App.api.online && App.api.me && App.api.startPolling) App.api.startPolling();
        this.teardown();
        this.playing = false;
      }
    }
  };
})();
