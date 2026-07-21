/* Action recorder — captures a real user's clicks, timeline drags, select
   choices, and keystroke-level typing (with real timing) while they manually
   walk through the app. The log is built to be exactly replayable — every
   entry carries a `loc` (tag/class/text/attrs) App.tour.replay() uses to
   re-find the same live element later, not just a human description.
   Dormant until started. Console-only:
     App.recorder.start()   — begin logging (shows a REC badge)
     App.recorder.stop()    — stop, print + return the log (paste it to chat,
                               or run App.tour.replay(result.raw) yourself)
     App.recorder.copy()    — copy the human-readable script to the clipboard
     App.recorder.clear()   — discard the current log
*/
window.App = window.App || {};
(function () {
  'use strict';

  // A stable locator for replay: prefer data-/placeholder-/type- attributes
  // (survive re-renders and disambiguate same-class fields), else fall back
  // to this element's own text.
  function captureLoc(el) {
    if (!el || el === document.body) return null;
    const tag = el.tagName.toLowerCase();
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? el.className.trim().split(/\s+/).slice(0, 3).join(' ') : '';
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const attrs = [];
    if (el.dataset) {
      if (el.dataset.view) attrs.push({ a: 'data-view', v: el.dataset.view });
      if (el.dataset.episodeId) attrs.push({ a: 'data-episode-id', v: el.dataset.episodeId });
      if (el.dataset.suKey) attrs.push({ a: 'data-su-key', v: el.dataset.suKey });
    }
    if (el.placeholder) attrs.push({ a: 'placeholder', v: el.placeholder });
    if (tag === 'input' && el.type) attrs.push({ a: 'type', v: el.type });
    return { tag, cls, text, attrs };
  }

  function describeTarget(el) {
    if (!el || el === document.body) return '<body>';
    const loc = captureLoc(el);
    const id = el.id ? '#' + el.id : '';
    const clsOut = loc.cls ? '.' + loc.cls.split(' ').join('.') : '';
    const attrOut = loc.attrs.length ? ' [' + loc.attrs.map(a => a.a.replace('data-', '') + '=' + a.v).join(',') : '';
    const ctxEl = el.closest('.view-tab, .g-row, .ep-row, .modal-card, .bar, .prefs-row, .adm-card, .adm-row, .adm-permrow, button, a, select, input, textarea');
    let ctx = '';
    if (ctxEl && ctxEl !== el) {
      const ctxText = (ctxEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      ctx = ' in <' + ctxEl.tagName.toLowerCase() + '>' + (ctxText ? ' "' + ctxText + '"' : '');
    }
    return '<' + loc.tag + id + clsOut + '>' + (loc.text ? ' "' + loc.text + '"' : '') + (attrOut ? attrOut + ']' : '') + ctx;
  }

  function isTypeable(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  App.recorder = {
    recording: false,
    log: [],
    _t0: 0,
    _drag: null,

    _now() { return Date.now() - this._t0; },
    _push(entry) { entry.t = this._now(); this.log.push(entry); },

    _onClick(e) {
      if (e.target.closest('.rec-badge')) return;
      // a drag just ended on this same bar — the mouseup handler already
      // logged it as a drag, so skip the trailing click to avoid double entries
      if (this._justDragged) { this._justDragged = false; return; }
      this._push({ type: 'click', desc: describeTarget(e.target), loc: captureLoc(e.target), x: e.clientX, y: e.clientY });
    },

    _onMousedown(e) {
      const bar = e.target.closest('.bar');
      if (!bar) return;
      this._drag = { bar, desc: describeTarget(bar), loc: captureLoc(bar), startX: e.clientX, startY: e.clientY };
    },
    _onMouseup(e) {
      if (!this._drag) return;
      const d = this._drag; this._drag = null;
      const dx = e.clientX - d.startX;
      if (Math.abs(dx) < 6) return;                 // too small to be a real drag
      this._justDragged = true;
      const dw = App.state.zoom || 16;
      this._push({ type: 'drag', desc: d.desc, loc: d.loc, deltaPx: dx, approxDays: Math.round(dx / dw) });
    },

    _onInput(e) {
      if (!isTypeable(e.target)) return;
      const value = e.target.isContentEditable ? e.target.textContent : e.target.value;
      this._push({ type: 'input', desc: describeTarget(e.target), loc: captureLoc(e.target), value });
    },
    _onChange(e) {
      const t = e.target;
      if (t.tagName !== 'SELECT') return;
      const opt = t.options[t.selectedIndex];
      this._push({ type: 'select', desc: describeTarget(t), loc: captureLoc(t), value: t.value, label: opt ? opt.textContent : '' });
    },
    _onKeydown(e) {
      if (e.key !== 'Enter' && e.key !== 'Escape' && e.key !== 'Tab') return;
      this._push({ type: 'key', key: e.key, desc: describeTarget(e.target), loc: captureLoc(e.target) });
    },
    // Scroll fires far too often (and the app's own scroll-settle animation
    // fires more), so record only the RESTING position of each gesture: keep
    // the latest position and flush it ~180ms after scrolling stops. Replay
    // then animates from the previous spot to this one — one clean move per
    // scroll, no intermediate-frame noise.
    _onScroll(e) {
      const t = e.target;
      const isWin = (t === document || t === document.documentElement || t === window);
      const el = isWin ? (document.scrollingElement || document.documentElement) : t;
      if (!el || typeof el.scrollLeft !== 'number') return;
      this._pendingScroll = {
        loc: isWin ? { tag: '__window__', cls: '', text: '', attrs: [] } : captureLoc(el),
        left: Math.round(el.scrollLeft), top: Math.round(el.scrollTop)
      };
      clearTimeout(this._scrollSettle);
      this._scrollSettle = setTimeout(() => this._flushScroll(), 180);
    },
    _flushScroll() {
      const s = this._pendingScroll; if (!s || !this.recording) return;
      const last = this.log[this.log.length - 1];
      if (last && last.type === 'scroll' && last.left === s.left && last.top === s.top &&
          JSON.stringify(last.loc) === JSON.stringify(s.loc)) return;
      this._push({ type: 'scroll', desc: '<scroll>', loc: s.loc, left: s.left, top: s.top });
    },

    start() {
      if (this.recording) return;
      this.recording = true;
      this.log = [];
      this._t0 = Date.now();
      this._drag = null; this._justDragged = false;

      this._click = this._onClick.bind(this);
      this._mousedown = this._onMousedown.bind(this);
      this._mouseup = this._onMouseup.bind(this);
      this._input = this._onInput.bind(this);
      this._change = this._onChange.bind(this);
      this._keydown = this._onKeydown.bind(this);
      this._scroll = this._onScroll.bind(this);
      this._pendingScroll = null;
      document.addEventListener('click', this._click, true);
      document.addEventListener('mousedown', this._mousedown, true);
      document.addEventListener('mouseup', this._mouseup, true);
      document.addEventListener('input', this._input, true);
      document.addEventListener('change', this._change, true);
      document.addEventListener('keydown', this._keydown, true);
      document.addEventListener('scroll', this._scroll, { capture: true, passive: true });

      const badge = document.createElement('div');
      badge.className = 'rec-badge';
      badge.innerHTML = '<span class="rec-dot"></span>REC';
      document.body.appendChild(badge);
      this._badge = badge;

      console.log('%c● Recording started — walk through the app now.', 'color:#ff5b6e;font-weight:700');
      return 'recording…';
    },

    stop() {
      if (!this.recording) return null;
      clearTimeout(this._scrollSettle);
      this.recording = false;
      document.removeEventListener('click', this._click, true);
      document.removeEventListener('mousedown', this._mousedown, true);
      document.removeEventListener('mouseup', this._mouseup, true);
      document.removeEventListener('input', this._input, true);
      document.removeEventListener('change', this._change, true);
      document.removeEventListener('keydown', this._keydown, true);
      document.removeEventListener('scroll', this._scroll, true);
      if (this._badge) { this._badge.remove(); this._badge = null; }

      const script = this.export();
      console.log('%c● Recording stopped — ' + this.log.length + ' step(s)', 'color:#00c875;font-weight:700');
      console.log('%cReplay it exactly with: App.tour.replay(App.recorder.log)', 'color:#5b9bff;font-weight:700');
      console.log(script);
      console.log(JSON.stringify(this.log, null, 2));
      return { steps: script, raw: this.log };
    },

    clear() { this.log = []; },

    // human-readable numbered script — paste this back into chat
    export() {
      return this.log.map((e, i) => {
        const time = (e.t / 1000).toFixed(1) + 's';
        if (e.type === 'click') return (i + 1) + '. [' + time + '] Click ' + e.desc;
        if (e.type === 'drag') return (i + 1) + '. [' + time + '] Drag ' + e.desc + ' by ' + e.deltaPx + 'px (~' + e.approxDays + ' day' + (Math.abs(e.approxDays) === 1 ? '' : 's') + ')';
        if (e.type === 'input') return (i + 1) + '. [' + time + '] Type in ' + e.desc + ': "' + e.value + '"';
        if (e.type === 'select') return (i + 1) + '. [' + time + '] Select "' + e.label + '" in ' + e.desc;
        if (e.type === 'key') return (i + 1) + '. [' + time + '] Press ' + e.key + ' on ' + e.desc;
        if (e.type === 'scroll') return (i + 1) + '. [' + time + '] Scroll ' + (e.loc && e.loc.tag === '__window__' ? 'page' : (e.loc && e.loc.cls ? '.' + e.loc.cls.split(' ')[0] : 'container')) + ' to (' + e.left + ', ' + e.top + ')';
        return (i + 1) + '. [' + time + '] ' + e.type;
      }).join('\n');
    },

    async copy() {
      const text = this.export();
      try { await navigator.clipboard.writeText(text); console.log('Copied ' + this.log.length + ' step(s) to clipboard.'); }
      catch (e) { console.log('Clipboard unavailable — copy manually from the log above.'); }
      return text;
    }
  };
})();
