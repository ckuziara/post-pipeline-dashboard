/* LucidLink Version Control connector (PostLab-style branch-and-promote).
   Implements the technical brief's architecture:
     • Adapter facade — MockLucidAdapter (Phase 1) and RealLucidAdapter (Phase 2).
       The active adapter is chosen by data.lucid.mode ('mock' | 'live').
     • Branch-and-Promote lifecycle — checkout clones the master into a working
       copy, check-in verifies the upload queue has drained then promotes a new
       version, force-unlock releases a stuck lock without promoting.
     • The SQL "source of truth" from the brief maps onto the app's shared server
       state: data.vc[episodeId] = { status, version, versions[], lock }.
       Locks sync to every teammate through the existing state polling (the
       Phase-2 upgrade path is Server-Sent Events on a /stream endpoint).
   The whole feature is gated on the 'lucidlink' connector being enabled
   (Admin → Workflow & Status → Connectors). */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);

  /* ======================================================================
     Adapter facade — every LucidLink interaction routes through here so the
     UI never knows whether it's talking to the mock or the live service.
  ====================================================================== */
  App.lucid = {
    MOCK_ERROR_RATE: 0.1,          // 10% simulated failures, per the brief
    UPLOAD_MBPS: 50,               // simulated local upload speed

    cfg() { return App.state.data.lucid || { mode: 'mock', apiUrl: '' }; },
    mode() { return this.cfg().mode || 'mock'; },
    isLive() { return this.mode() === 'live'; },
    adapter() { return this.isLive() ? this.real : this.mock; },
    adapterLabel() { return this.isLive() ? 'LucidLink API (live)' : 'Mock adapter'; },
    _key: '',                      // live Service Account key — in memory only, never persisted to the shared board

    // ---- MockLucidAdapter (Phase 1) ----
    mock: {
      _latency() { return 300 + Math.random() * 500; },
      _maybeFail(op) { if (Math.random() < App.lucid.MOCK_ERROR_RATE) throw new Error('LucidLink ' + op + ' failed (simulated network error) — try again'); },

      // clone the master → an isolated working copy (e.g. LA-101_Animatic-V1_v14_EA.prproj)
      branch({ fileBase, version, editor }) {
        return new Promise((resolve, reject) => setTimeout(() => {
          try { this._maybeFail('checkout'); } catch (e) { return reject(e); }
          const initials = (editor || 'Editor').replace(/[^A-Za-z ]/g, '').split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('') || 'ED';
          resolve({ workingFile: fileBase + '_v' + version + '_' + initials + '.prproj' });
        }, this._latency()));
      },

      // simulate the local daemon draining its upload queue at UPLOAD_MBPS.
      // onTick(pct, mbRemaining, mbTotal) drives the "Syncing… do not close" UI.
      verifySync(onTick) {
        const totalMB = Math.round(120 + Math.random() * 220);
        let remaining = totalMB;
        return new Promise((resolve) => {
          const stepMB = App.lucid.UPLOAD_MBPS * 0.25;   // 50 MB/s, ticking 4×/s
          onTick(0, totalMB, totalMB);
          const timer = setInterval(() => {
            remaining = Math.max(0, remaining - stepMB);
            onTick(Math.round(100 * (1 - remaining / totalMB)), Math.round(remaining), totalMB);
            if (remaining <= 0) { clearInterval(timer); resolve(); }
          }, 250);
        });
      },

      // register the synced working copy as the new master version
      promote({ fileBase, version }) {
        return new Promise((resolve, reject) => setTimeout(() => {
          try { this._maybeFail('promote'); } catch (e) { return reject(e); }
          resolve({ versionNumber: version, fileName: fileBase + '_v' + version + '.prproj' });
        }, this._latency()));
      },

      // downgrade a stuck editor's copy to read-only so a late sync can't overwrite
      quarantine() { return new Promise((resolve) => setTimeout(resolve, this._latency())); }
    },

    // ---- RealLucidAdapter (Phase 2 — LucidLink Service Account) ----
    // Wired to the same interface; swaps in the moment a live connection is
    // configured. Authenticates with a Bearer Service-Account token against the
    // self-hosted LucidLink REST API and (server-side) runs `lucid status`.
    real: {
      _ready() { const c = App.lucid.cfg(); return !!(c.apiUrl && App.lucid._key); },
      _guard() { if (!this._ready()) throw new Error('LucidLink live API isn’t connected — add the API URL and Service Account key in Connector settings.'); },
      async _req(path, opts) {
        this._guard();
        const base = App.lucid.cfg().apiUrl.replace(/\/+$/, '');
        const r = await fetch(base + path, Object.assign({
          headers: { 'Authorization': 'Bearer ' + App.lucid._key, 'Content-Type': 'application/json' }
        }, opts || {}));
        if (!r.ok) throw new Error('LucidLink API error ' + r.status);
        return r.json();
      },
      branch(p) { return this._req('/projects/' + encodeURIComponent(p.projectId) + '/checkout', { method: 'POST', body: JSON.stringify({ user: p.userId }) }); },
      // Phase 2: the client polls `lucid status` every 2s until the queue hits 0 bytes
      verifySync() { this._guard(); throw new Error('Live sync verification runs against the LucidLink daemon (Phase 2).'); },
      promote(p) { return this._req('/projects/' + encodeURIComponent(p.projectId) + '/promote', { method: 'POST' }); },
      quarantine(p) { return this._req('/projects/' + encodeURIComponent(p.projectId) + '/quarantine', { method: 'POST', body: JSON.stringify({ user: p.offlineUserId }) }); }
    }
  };

  /* ======================================================================
     Version-control data layer + orchestration — keyed per SUBTASK, not per
     episode. Producers "select" which subtasks hold NLE project files and
     enable version control on them; the checkout/check-in controls then live
     inside that subtask's Edit Task dialog.
     data.vc["<episodeId>::<taskKey>"] = { epId, suKey, status, version, versions[], lock }
  ====================================================================== */
  const STATUS = { AVAILABLE: { label: 'Available', color: '#00c875' }, LOCKED: { label: 'Locked', color: '#fdab3d' }, QUARANTINED: { label: 'Quarantined', color: '#ff5b6e' } };
  const nowIso = () => new Date().toISOString();
  const CKEY = (epId, suKey) => epId + '::' + suKey;
  function me() { const u = App.state.user; return { userId: u && u.personId, userName: (u && u.name) || 'You' }; }

  App.vc = {
    STATUS,
    _busy: {},        // ckey -> label while a checkout / force-unlock is in flight
    _syncing: null,   // { ckey, pct, mb, total } during a check-in
    _inline: null,    // { box, epId, suKey } — the section mounted in an Edit Task dialog

    key: CKEY,
    fileBase(ep, su) { return ep.code + '_' + String(su.name || su.key).replace(/[^A-Za-z0-9]+/g, '-'); },
    // A subtask is version-controlled when its PIPELINE task carries vc:true
    // (set in Pipeline Presets). The lock/version record is created lazily.
    isVc(ep, suKey) {
      if (!App.connectorEnabled('lucidlink')) return false;
      if (typeof ep === 'string') ep = App.state.data.episodes.find(e => e.id === ep);
      if (!ep) return false;
      const t = App.pipelineFor(ep).find(x => x.key === suKey);
      return !!(t && t.vc);
    },
    _defaultRecord(ep, su) {
      return { epId: ep.id, suKey: su.key, status: 'AVAILABLE', version: 1,
        versions: [{ n: 1, file: this.fileBase(ep, su) + '_v1.prproj', at: nowIso(), by: 'system' }], lock: null };
    },
    get(epId, suKey) {
      const d = App.state.data;
      const rec = d.vc && d.vc[CKEY(epId, suKey)];
      if (rec) return rec;
      const ep = d.episodes.find(e => e.id === epId), su = ep && App.subitem(ep, suKey);
      return (ep && su && this.isVc(ep, suKey)) ? this._defaultRecord(ep, su) : null;   // virtual default until first checkout
    },
    isMine(lock) {
      if (!lock) return false;
      const u = me();
      return (lock.userId && u.userId && lock.userId === u.userId) || (!u.userId && lock.userName === u.userName);
    },
    lockedInEpisode(epId) {
      const d = App.state.data; if (!d.vc) return [];
      return Object.values(d.vc).filter(p => p.epId === epId && p.lock);
    },

    async checkout(epId, suKey) {
      const ep = App.state.data.episodes.find(e => e.id === epId); if (!ep) return;
      const su = App.subitem(ep, suKey); const proj = this.get(epId, suKey); if (!proj) return;
      if (proj.lock) { App.toast('Already checked out by ' + (proj.lock.userName || 'someone'), true); return; }  // UNIQUE-lock constraint
      const u = me(), k = CKEY(epId, suKey);
      this._busy[k] = 'Checking out…'; this._refresh();
      try {
        const { workingFile } = await App.lucid.adapter().branch({ projectId: k, fileBase: this.fileBase(ep, su), version: proj.version, editor: u.userName, userId: u.userId });
        App.mutate(d => {
          d.vc = d.vc || {};
          const p = d.vc[k] || (d.vc[k] = this._defaultRecord(ep, su));   // lazily persist on first checkout
          if (p.lock) return;                                            // race guard — someone won the lock first
          p.status = 'LOCKED';
          p.lock = { userId: u.userId, userName: u.userName, workingFile, at: nowIso() };
        });
        App.toast('Checked out — editing ' + workingFile);
      } catch (e) { App.toast(e.message, true); }
      finally { delete this._busy[k]; this._refresh(); }
    },

    async checkIn(epId, suKey) {
      const ep = App.state.data.episodes.find(e => e.id === epId); if (!ep) return;
      const su = App.subitem(ep, suKey); const proj = this.get(epId, suKey); if (!proj || !proj.lock) return;
      const k = CKEY(epId, suKey), nextV = proj.version + 1;
      this._syncing = { ckey: k, pct: 0, mb: 0, total: 0 }; this._refresh();
      try {
        await App.lucid.adapter().verifySync((pct, mb, total) => { this._syncing = { ckey: k, pct, mb, total }; this._refresh(); });
        const { versionNumber, fileName } = await App.lucid.adapter().promote({ projectId: k, fileBase: this.fileBase(ep, su), version: nextV });
        App.mutate(d => {
          const p = d.vc && d.vc[k]; if (!p) return;
          p.version = versionNumber;
          p.versions.push({ n: versionNumber, file: fileName, at: nowIso(), by: p.lock && p.lock.userName });
          p.status = 'AVAILABLE'; p.lock = null;
        });
        App.toast('Checked in as v' + nextV);
      } catch (e) { App.toast(e.message, true); }
      finally { this._syncing = null; this._refresh(); }
    },

    forceUnlock(epId, suKey) {
      if (!App.canManageShows(App.state.role)) { App.toast('Only Producers can force-unlock', true); return; }
      const proj = this.get(epId, suKey); if (!proj || !proj.lock) return;
      App.confirm('Releases ' + proj.lock.userName + '’s lock without saving their working copy, and quarantines it (read-only) so a late sync can’t overwrite the master.',
        () => this._doForceUnlock(epId, suKey),
        { title: 'Force unlock this file?', yesLabel: 'Force unlock', icon: '🔓' });
    },

    async _doForceUnlock(epId, suKey) {
      const proj = this.get(epId, suKey); if (!proj || !proj.lock) return;
      const holder = proj.lock.userName, k = CKEY(epId, suKey);
      this._busy[k] = 'Releasing…'; this._refresh();
      try {
        await App.lucid.adapter().quarantine({ projectId: k, offlineUserId: proj.lock.userId });
        App.mutate(d => { const p = d.vc && d.vc[k]; if (p) { p.lock = null; p.status = 'AVAILABLE'; } });  // master stays at last good version
        App.toast('Force-unlocked — ' + holder + '’s copy quarantined');
      } catch (e) { App.toast(e.message, true); }
      finally { delete this._busy[k]; this._refresh(); }
    },

    _refresh() { this.renderInline(); this.syncOpen(); },

    /* ---- inline section, shown inside the Edit Task dialog ---- */
    inlineSection(epId, suKey) {
      const box = el('.vc-inline');
      this._inline = { box, epId, suKey };
      this._buildInline(box, epId, suKey);      // initial build (box not yet in the DOM)
      return box;
    },
    // async refresh after an action — only if the section is still mounted
    renderInline() {
      const ctx = this._inline; if (!ctx) return;
      if (!ctx.box.isConnected) { this._inline = null; return; }
      this._buildInline(ctx.box, ctx.epId, ctx.suKey);
    },
    _buildInline(box, epId, suKey) {
      box.innerHTML = '';
      const proj = this.get(epId, suKey);
      const canManage = App.canManageShows(App.state.role);
      const k = CKEY(epId, suKey);

      box.appendChild(el('.vc-inline-head', null, [
        el('span.vc-inline-ic', null, '🔒'),
        el('span.vc-inline-title', null, 'LucidLink Version Control'),
        el('span.vc-source-mini' + (App.lucid.isLive() ? '.live' : ''), null, App.lucid.isLive() ? 'Live API' : 'Mock')
      ]));

      if (!proj) return;   // not version-controlled (the dialog only mounts this for vc tasks)

      const st = STATUS[proj.status] || STATUS.AVAILABLE;
      const mine = this.isMine(proj.lock);
      const last = proj.versions[proj.versions.length - 1] || {};
      const syncing = this._syncing && this._syncing.ckey === k;
      const busy = this._busy[k];

      const bodyEls = [
        el('.vc-inline-row', null, [
          el('span.vc-badge', { style: { background: st.color + '22', color: st.color, borderColor: st.color + '55' } },
            [el('span.vc-dot', { style: { background: st.color } }), st.label]),
          el('span.vc-inline-ver', null, 'v' + proj.version + ' · ' + last.file)
        ])
      ];
      if (proj.lock) bodyEls.push(el('.vc-lockinfo', null, '🔒 ' + (mine ? 'You' : proj.lock.userName) + ' · ' + proj.lock.workingFile));

      // action zone
      if (syncing) {
        const s = this._syncing;
        bodyEls.push(el('.vc-sync', null, [
          el('.vc-sync-label', null, '⚠ Syncing… do not close (' + s.mb + ' MB left)'),
          el('.vc-bar', null, el('.vc-bar-fill', { style: { width: s.pct + '%' } }))
        ]));
      } else if (busy) {
        bodyEls.push(el('.vc-actions', null, el('span.vc-working', null, busy)));
      } else {
        const actions = [];
        if (!proj.lock) actions.push(el('button.btn-primary.vc-btn', { onclick: () => this.checkout(epId, suKey) }, '↧ Open (check out)'));
        else if (mine) actions.push(el('button.btn-primary.vc-btn', { onclick: () => this.checkIn(epId, suKey) }, '↥ Check in'));
        else {
          actions.push(el('span.vc-lockedby', null, '🔒 Locked by ' + proj.lock.userName));
          if (canManage) actions.push(el('button.btn-ghost.vc-btn.vc-force', { onclick: () => this.forceUnlock(epId, suKey) }, 'Force unlock'));
        }
        bodyEls.push(el('.vc-actions', null, actions));
      }
      box.appendChild(el('.vc-inline-body', null, bodyEls));
    },

    /* ---- producer overview modal (lists every tracked subtask) ---- */
    open() {
      if (!App.connectorEnabled('lucidlink')) { App.toast('Enable the LucidLink connector first (Admin → Connectors)', true); return; }
      this.ensureSeed(App.visibleEpisodes());
      this.close();
      const ov = el('.modal-overlay', { onclick: (e) => { if (e.target === ov && !this._syncing) this.close(); } });
      this._ov = ov;
      this._card = el('.modal-card.wide.vc-modal');
      ov.appendChild(this._card);
      document.body.appendChild(ov);
      this._esc = (e) => { if (e.key === 'Escape' && !this._syncing) this.close(); };
      document.addEventListener('keydown', this._esc);
      this._rerender();
    },
    close() {
      if (this._ov) { this._ov.remove(); this._ov = null; document.removeEventListener('keydown', this._esc); }
      this._syncing = null; this._busy = {};
    },
    syncOpen() { if (this._ov) this._rerender(); },

    // every version-controlled subtask (pipeline vc:true) across visible episodes
    tracked() {
      const out = [];
      App.visibleEpisodes().forEach(ep => {
        App.subitems(ep).forEach(su => { if (this.isVc(ep, su.key)) out.push({ ep, su, proj: this.get(ep.id, su.key) }); });
      });
      return out;
    },

    _rerender() {
      const card = this._card; if (!card) return;
      card.innerHTML = '';
      const showName = App.state.filters.show === 'all' ? 'All shows' : App.show(App.state.filters.show).name;
      const live = App.lucid.isLive();
      const items = this.tracked();

      card.appendChild(el('.modal-head', null, [
        el('.modal-head-main', null, [
          el('span.modal-ic', null, '🔒'),
          el('div', null, [
            el('.modal-title', null, 'LucidLink Version Control'),
            el('.modal-subtitle', null, showName + ' · ' + items.length + ' version-controlled subtask' + (items.length === 1 ? '' : 's'))
          ])
        ]),
        el('.vc-source' + (live ? '.live' : ''), { title: live ? 'Connected to the live LucidLink API' : 'Running on simulated mock data' }, live ? '● Live API' : '● Mock data'),
        el('button.modal-x', { onclick: () => { if (!this._syncing) this.close(); }, title: this._syncing ? 'Finish syncing first' : 'Close', disabled: !!this._syncing }, '✕')
      ]));

      const body = el('.modal-body.vc-body');
      if (!items.length) body.appendChild(el('.empty', null, 'No subtasks are under version control yet. Open a subtask’s Edit dialog to enable it.'));
      items.forEach(it => body.appendChild(this._row(it)));
      card.appendChild(body);

      card.appendChild(el('.modal-foot.vc-foot', null, [
        el('.vc-legend', null, 'Master files stay read-only; editors work on isolated branch copies.'),
        el('button.btn-ghost', { onclick: () => { if (!this._syncing) this.close(); }, disabled: !!this._syncing }, 'Close')
      ]));
    },

    _row({ ep, su, proj }) {
      const st = STATUS[proj.status] || STATUS.AVAILABLE;
      const k = CKEY(ep.id, su.key);
      const busy = this._busy[k];
      const syncing = this._syncing && this._syncing.ckey === k;
      const show = App.show(ep.showId);
      const mine = this.isMine(proj.lock);
      const last = proj.versions[proj.versions.length - 1] || {};

      const left = el('.vc-left', null, [
        el('.vc-ep', null, [
          el('span.ep-code', { style: { background: show.color, color: App.pickInk(show.color) } }, ep.code),
          el('span.vc-title', null, su.name),
          el('span.vc-task-dept', null, App.dept(su.dept).label)
        ]),
        el('.vc-ver', null, 'v' + proj.version + ' · ' + last.file)
      ]);

      const mid = el('.vc-status', null, [
        el('span.vc-badge', { style: { background: st.color + '22', color: st.color, borderColor: st.color + '55' } },
          [el('span.vc-dot', { style: { background: st.color } }), st.label]),
        proj.lock ? el('.vc-lockinfo', null, (mine ? 'You' : proj.lock.userName) + ' · ' + proj.lock.workingFile) : null
      ]);

      let actions;
      if (syncing) {
        const s = this._syncing;
        actions = el('.vc-sync', null, [
          el('.vc-sync-label', null, '⚠ Syncing… do not close (' + s.mb + ' MB left)'),
          el('.vc-bar', null, el('.vc-bar-fill', { style: { width: s.pct + '%' } }))
        ]);
      } else if (busy) {
        actions = el('.vc-actions', null, el('span.vc-working', null, busy));
      } else if (!proj.lock) {
        actions = el('.vc-actions', null, el('button.btn-primary.vc-btn', { onclick: () => this.checkout(ep.id, su.key) }, '↧ Open'));
      } else if (mine) {
        actions = el('.vc-actions', null, el('button.btn-primary.vc-btn', { onclick: () => this.checkIn(ep.id, su.key) }, '↥ Check in'));
      } else {
        const btns = [el('span.vc-lockedby', null, '🔒 Locked')];
        if (App.canManageShows(App.state.role)) btns.push(el('button.btn-ghost.vc-btn.vc-force', { onclick: () => this.forceUnlock(ep.id, su.key) }, 'Force unlock'));
        actions = el('.vc-actions', null, btns);
      }
      return el('.vc-row' + (syncing ? '.syncing' : ''), null, [left, mid, actions]);
    },

    // Version control is now pipeline-driven (a task's vc:true flag, set in
    // Pipeline Presets), so there's nothing to auto-enable here. For a live
    // demo we just lock ONE already-vc-enabled subtask by a teammate the first
    // time the overview opens, to show the "locked by someone else" path.
    ensureSeed(episodes) {
      const d = App.state.data;
      if (d.vc && Object.values(d.vc).some(p => p.lock)) return;   // a lock already exists
      const editors = d.people.filter(p => App.roleDept(p.role));
      if (!editors.length) return;
      for (const ep of episodes) {
        const su = App.subitems(ep).find(s => this.isVc(ep, s.key) && !(d.vc && d.vc[CKEY(ep.id, s.key)] && d.vc[CKEY(ep.id, s.key)].lock));
        if (!su) continue;
        const ed = editors[0], base = this.fileBase(ep, su);
        App.mutate(data => {
          data.vc = data.vc || {};
          const rec = data.vc[CKEY(ep.id, su.key)] || (data.vc[CKEY(ep.id, su.key)] = this._defaultRecord(ep, su));
          rec.status = 'LOCKED';
          rec.lock = { userId: ed.id, userName: ed.name, workingFile: base + '_v' + rec.version + '_' + ed.name.split(' ').map(w => w[0]).join('') + '.prproj', at: nowIso() };
        });
        return;
      }
    },

    // Board episode chip — aggregate count of locked subtasks (real-time via state sync)
    boardBadge(ep) {
      if (!App.connectorEnabled('lucidlink')) return null;
      const locks = this.lockedInEpisode(ep.id);
      if (!locks.length) return null;
      const mine = locks.some(l => this.isMine(l.lock));
      return el('span.vc-flag' + (mine ? '.mine' : ''), { title: locks.length + ' file' + (locks.length === 1 ? '' : 's') + ' checked out in LucidLink' },
        '🔒 ' + locks.length);
    }
  };

  // config setter (Connector settings). The Service Account key is held in
  // memory only — the live secret belongs to the backend, not the shared board.
  App.setLucidConfig = function (patch) {
    if (!App.isAdminRole(App.state.role)) { App.toast('Only admins can change connector settings', true); return; }
    if ('key' in patch) { App.lucid._key = patch.key; delete patch.key; }
    if (!Object.keys(patch).length) { App.render(); return; }
    App.mutate(d => { d.lucid = Object.assign({ mode: 'mock', apiUrl: '' }, d.lucid, patch); });
  };
})();
