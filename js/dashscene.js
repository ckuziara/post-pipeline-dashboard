/* Dashboard backdrop — the setup wizard's edit suite (js/guide.js sceneSVG),
   living behind the Dashboard's widgets: the vine sways, the mug steams and
   the wall clock keeps real time.

   One persistent layer, mounted once and only shown or hidden on render, so
   App.render()'s frequent rebuilds of #view never restart the animations.
   It sits at z-index -1 under #view, which has no background of its own, so
   the room shows through the gaps between tiles and nothing in it can steal
   a click.

   The film poster on the wall is the one interactive piece: click it (or
   Preferences → Wall poster) to pick an image, which is turned into pixel
   art in the scene's own palette and kept on this device only. Because the
   layer can't take clicks, #view's own clicks on bare background are tested
   against the poster's on-screen box instead.

   Device-local prefs: dashScene (on/off, default on), dashPoster (the pixel
   art, a PNG data URL of a few KB). */
window.App = window.App || {};
(function () {
  'use strict';

  // poster frame in the scene's 1600×900 viewBox (see #sc-poster in guide.js)
  const PX = 1240, PY = 40, PW = 190, PH = 220;
  // pixel-art grid: the poster's aspect, coarse enough to read as pixels
  const GW = 38, GH = 44;
  // the scene's own colours, so a photo comes out looking drawn in the room
  const PALETTE = ['#2b2b2b', '#4a4a4a', '#fffdf5', '#f4ecd6', '#e3c99b', '#c9a074', '#8fb7e8', '#5d6fd6',
    '#a06cd5', '#b98ce6', '#f7a6b8', '#ff6f9c', '#f28c6b', '#ffd166', '#7cb86a', '#6c9a5e']
    .map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));

  const visible = () => App.state.view === 'dashboard' && App.prefs.get('dashScene', true) && !App.isPhone();

  App.dashScene = {
    layer: null, _tick: null,

    mount() {
      if (this.layer) return;
      const layer = document.createElement('div');
      layer.className = 'dash-scene';
      layer.setAttribute('aria-hidden', 'true');
      layer.innerHTML = App.guide.sceneSVG('dash-scene-svg');
      document.body.appendChild(layer);
      this.layer = layer;
      this.applyPoster();
      window.addEventListener('resize', () => this.place());
      const view = document.getElementById('view');
      view.addEventListener('click', e => { if (this.overPoster(e)) this.pickPoster(); });
      view.addEventListener('mousemove', e => {
        const hot = this.overPoster(e);
        if (hot === this._hot) return;
        this._hot = hot;
        this.layer.classList.toggle('poster-hot', hot);
        view.classList.toggle('dash-poster-hot', hot);
        view.title = hot ? 'Change the wall poster' : '';
      });
    },

    // show or hide for the current view; called after every render
    sync() {
      const on = visible();
      if (on) this.mount();
      if (!this.layer) return;
      this.layer.style.display = on ? '' : 'none';
      document.body.classList.toggle('has-dash-scene', on);
      if (on) {
        this.place();
        this.clock();
        this.nameClapper();
        if (!this._tick) this._tick = setInterval(() => this.clock(), 30000);
      } else {
        if (this._tick) { clearInterval(this._tick); this._tick = null; }
        if (this._hot) { this._hot = false; this.layer.classList.remove('poster-hot'); }
        const view = document.getElementById('view');
        view.classList.remove('dash-poster-hot'); view.title = '';
      }
    },

    // fill exactly the area under #view, so the room isn't hidden behind the topbar
    place() {
      if (!this.layer) return;
      const r = document.getElementById('view').getBoundingClientRect();
      Object.assign(this.layer.style, { top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' });
    },

    clock() {
      const hands = this.layer && this.layer.querySelectorAll('#sc-clock path[transform]');
      if (!hands || hands.length < 2) return;
      const now = new Date();
      hands[0].setAttribute('transform', `rotate(${((now.getHours() % 12) + now.getMinutes() / 60) * 30})`);
      hands[1].setAttribute('transform', `rotate(${now.getMinutes() * 6})`);
    },

    // the clapperboard credits whoever's looking at it
    nameClapper() {
      const t = this.layer.querySelector('#sc-clap-name');
      const user = App.state.user;
      if (t) t.textContent = 'DIR: ' + (user && user.name ? user.name.split(' ')[0].toUpperCase().slice(0, 10) : '?');
    },

    // is the pointer over the poster, on bare background (not a tile or control)?
    overPoster(e) {
      if (!this.layer || !visible()) return false;
      if (e.target.closest('.dw, .widget, button, a, input, select, textarea, .dash-hello > :first-child, .dash-tools')) return false;
      const p = this.layer.querySelector('#sc-poster');
      if (!p) return false;
      const r = p.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    },

    pickPoster() {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*';
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        if (!/^image\//.test(f.type)) { App.toast('That isn’t an image — pick a PNG, JPEG, GIF or WebP', true); return; }
        try {
          const url = await this.pixelate(f);
          App.prefs.set('dashPoster', url);
          if (App.prefs.get('dashPoster', null) !== url) throw new Error('not saved');
          this.applyPoster();
          App.toast('New poster on the wall');
        } catch (err) {
          App.toast('Couldn’t turn that image into a poster', true);
        }
      };
      input.click();
    },

    resetPoster() {
      App.prefs.set('dashPoster', null);
      this.applyPoster();
    },

    /* Image → pixel art: centre-crop to the poster's shape, shrink to a coarse
       grid (via an intermediate size, so the averaging is smooth rather than
       aliased), then snap every cell to the scene palette with a light
       Floyd–Steinberg dither. Returns a tiny PNG data URL. */
    async pixelate(file) {
      const img = await new Promise((res, rej) => {
        const i = new Image(), u = URL.createObjectURL(file);
        i.onload = () => { URL.revokeObjectURL(u); res(i); };
        i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode')); };
        i.src = u;
      });
      const want = GW / GH, have = img.naturalWidth / img.naturalHeight;
      const sw = have > want ? img.naturalHeight * want : img.naturalWidth;
      const sh = have > want ? img.naturalHeight : img.naturalWidth / want;
      const sx = (img.naturalWidth - sw) / 2, sy = (img.naturalHeight - sh) / 2;

      const mid = document.createElement('canvas');
      mid.width = GW * 4; mid.height = GH * 4;
      const mc = mid.getContext('2d');
      mc.imageSmoothingQuality = 'high';
      mc.drawImage(img, sx, sy, sw, sh, 0, 0, mid.width, mid.height);

      const cv = document.createElement('canvas');
      cv.width = GW; cv.height = GH;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(mid, 0, 0, GW, GH);

      const id = ctx.getImageData(0, 0, GW, GH), d = id.data;
      const buf = Float32Array.from(d);
      const DITHER = 0.6;   // light: keeps flat areas flat
      for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
        const i = (y * GW + x) * 4;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        let best = PALETTE[0], bd = Infinity;
        for (const c of PALETTE) {
          // weighted RGB distance — cheap, and closer to how the eye judges it
          const dr = r - c[0], dg = g - c[1], db = b - c[2];
          const dist = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
          if (dist < bd) { bd = dist; best = c; }
        }
        d[i] = best[0]; d[i + 1] = best[1]; d[i + 2] = best[2]; d[i + 3] = 255;
        const er = (r - best[0]) * DITHER, eg = (g - best[1]) * DITHER, eb = (b - best[2]) * DITHER;
        const push = (dx, dy, k) => {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= GW || ny >= GH) return;
          const j = (ny * GW + nx) * 4;
          buf[j] += er * k; buf[j + 1] += eg * k; buf[j + 2] += eb * k;
        };
        push(1, 0, 7 / 16); push(-1, 1, 3 / 16); push(0, 1, 5 / 16); push(1, 1, 1 / 16);
      }
      ctx.putImageData(id, 0, 0);
      return cv.toDataURL('image/png');
    },

    // draw the saved pixel art into the frame, or put the stock poster back
    applyPoster() {
      const g = this.layer && this.layer.querySelector('#sc-poster');
      if (!g) return;
      const old = g.querySelector('.dsp-art');
      if (old) old.remove();
      const url = App.prefs.get('dashPoster', null);
      g.classList.toggle('dsp-custom', !!url);
      if (!url || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url)) return;
      g.insertAdjacentHTML('beforeend', `
        <g class="dsp-art">
          <clipPath id="dsp-clip"><rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" rx="10"/></clipPath>
          <image href="${url}" x="${PX}" y="${PY}" width="${PW}" height="${PH}" preserveAspectRatio="none" clip-path="url(#dsp-clip)"/>
          <rect x="${PX}" y="${PY + PH - 36}" width="${PW}" height="36" fill="#fffdf5" clip-path="url(#dsp-clip)" stroke="none"/>
          <rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" rx="10" fill="none"/>
          <text x="${PX + PW / 2}" y="${PY + PH - 10}" class="sc-t" text-anchor="middle" font-size="20">NOW SHOWING</text>
        </g>`);
    }
  };
})();
