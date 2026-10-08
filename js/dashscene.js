/* Dashboard backdrop — the setup wizard's cozy hand, as a frame around the
   Dashboard rather than a room behind it. The middle stays a plain, washed-
   out wall, so the widgets are what you look at. The edges carry the
   costume: fairy lights strung along the top, the wizard's ivy trailing
   down both sides (js/guide.js ivySVG), a plant and a film reel with a
   steaming mug on a strip of floor, and a little clock and film poster hung
   in the band above the widgets. Each piece is its own SVG pinned to an
   edge or corner, so the frame holds its shape at any window size. While
   it's on, #view gets a wider margin so the frame shows around the tiles.

   One persistent layer, mounted once and only shown or hidden on render, so
   App.render()'s frequent rebuilds of #view never restart the animations.
   It sits at z-index -1 under #view, which has no background of its own, so
   nothing in it can steal a click.

   The film poster is the one interactive piece: click it (or Preferences →
   Wall poster) to pick an image, which is turned into pixel art in the
   scene's own palette and kept on this device only. Because the layer can't
   take clicks, #view's own clicks on bare background are tested against the
   poster's on-screen box instead.

   Lighting follows the theme (see mood()): daytime, blackout or mood.

   Device-local prefs: dashScene (on/off, default on), dashPoster (the pixel
   art, a PNG data URL of a few KB). */
window.App = window.App || {};
(function () {
  'use strict';

  // poster frame, in the wall-art piece's own viewBox (below)
  const PX = 1240, PY = 40, PW = 190, PH = 220;
  // pixel-art grid: the poster's aspect, coarse enough to read as pixels
  const GW = 38, GH = 44;
  // the scene's own colours, so a photo comes out looking drawn in the room
  const PALETTE = ['#2b2b2b', '#4a4a4a', '#fffdf5', '#f4ecd6', '#e3c99b', '#c9a074', '#8fb7e8', '#5d6fd6',
    '#a06cd5', '#b98ce6', '#f7a6b8', '#ff6f9c', '#f28c6b', '#ffd166', '#7cb86a', '#6c9a5e']
    .map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
  const BULBS = ['#ffd166', '#f7a6b8', '#8fb7e8', '#b98ce6', '#7cb86a', '#f28c6b'];

  const visible = () => App.state.view === 'dashboard' && App.prefs.get('dashScene', true) && !App.isPhone();

  // one frame piece: the wizard's outline style (.if-svg .sc-o) in its own viewBox
  const piece = (cls, viewBox, body, align) =>
    `<svg class="if-svg ds-piece ${cls}" viewBox="${viewBox}" preserveAspectRatio="${align || 'xMidYMid meet'}" xmlns="http://www.w3.org/2000/svg"><g class="sc-o">${body}</g></svg>`;

  function frameHTML() {
    const ivy = App.guide.ivySVG();
    return '<div class="ds-wall"></div><div class="ds-light"></div>' +
      '<svg class="if-svg ds-piece ds-lights" xmlns="http://www.w3.org/2000/svg"></svg>' +
      // ivy down the right edge, and its mirror image down the left
      piece('ds-ivy-r', '1500 -10 300 700', ivy, 'xMaxYMin meet') +
      piece('ds-ivy-l', '1500 -10 300 700', `<g transform="translate(3300 0) scale(-1 1)">${ivy}</g>`, 'xMinYMin meet') +
      '<div class="ds-floor"></div>' +
      // a plant, bottom left
      piece('ds-plant', '1340 470 210 230', `
        <path d="M1440 610 q-40 -70 10 -120 q10 60 -10 120 M1460 610 q10 -90 70 -110 q-20 70 -70 110 M1450 610 q-60 -40 -90 -100 q60 20 90 100" fill="#7cb86a"/>
        <path d="M1410 600 h90 l-12 90 h-66Z" fill="#e8946b"/>`, 'xMinYMax meet') +
      // a film reel and a steaming mug, bottom right
      piece('ds-reel', '140 470 300 235', `
        <circle cx="250" cy="600" r="96" fill="#5d6fd6"/>
        <circle cx="250" cy="600" r="20" fill="#f4ecd6"/>
        ${[0, 72, 144, 216, 288].map(a => `<circle cx="${250 + Math.cos(a * Math.PI / 180) * 54}" cy="${600 + Math.sin(a * Math.PI / 180) * 54}" r="20" fill="#f4ecd6"/>`).join('')}
        <g transform="translate(-1080 172)">
          <path d="M1440 470 h56 v40 a14 14 0 0 1 -14 14 h-28 a14 14 0 0 1 -14 -14Z" fill="#f28c6b"/>
          <path d="M1496 480 a14 14 0 0 1 0 28" fill="none"/>
          <path class="sc-steam" d="M1458 455 q-10 -16 0 -30 M1478 455 q-10 -16 0 -30" fill="none" stroke-width="4" opacity=".45"/>
        </g>`, 'xMaxYMax meet') +
      // wall art in the band above the widgets: the clock and the poster
      piece('ds-wallart', '1080 25 365 255', `
        <path d="M1150 70 V40" stroke-width="3" opacity=".5"/>
        <g id="sc-clock" transform="translate(1150 140)">
          <circle r="64" fill="#fffaf0"/>
          <circle r="51" fill="none" stroke-width="3" opacity=".3"/>
          <path d="M0 0 L0 -32" transform="rotate(0)" stroke-width="7"/>
          <path d="M0 0 L0 -45" transform="rotate(0)" stroke-width="4"/>
          <circle r="6" fill="#2b2b2b"/>
        </g>
        <g id="sc-poster">
          <rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" rx="10" fill="#8fb7e8"/>
          <path d="M1262 225 L1310 160 L1345 200 L1375 170 L1410 225Z" fill="#6c9a5e"/>
          <circle cx="1380" cy="100" r="22" fill="#ffd166"/>
          <text x="1335" y="250" class="sc-t" text-anchor="middle" font-size="20">NOW SHOWING</text>
        </g>`);
  }

  // a string of fairy lights the width of the view, drooping between pins
  function lightsSVG(w) {
    const span = 220, sag = 22, n = Math.max(1, Math.round(w / span)), step = w / n;
    let d = 'M0 6', bulbs = '';
    for (let i = 0; i < n; i++) {
      const x0 = i * step, x1 = x0 + step;
      d += ` Q${(x0 + x1) / 2} ${6 + sag * 2} ${x1} 6`;
      // bulbs hang along the droop (a quadratic's y at t is 6 + 2·sag·2t(1−t))
      [0.2, 0.5, 0.8].forEach((t, k) => {
        const x = x0 + step * t, y = 6 + sag * 4 * t * (1 - t);
        const c = BULBS[(i * 3 + k) % BULBS.length];
        bulbs += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><rect x="-3" y="0" width="6" height="5" rx="1" fill="#4a4a4a" style="stroke-width:2"/>` +
          `<ellipse class="ds-bulb" style="animation-delay:-${((i * 3 + k) * 0.7) % 3}s" cx="0" cy="12" rx="6" ry="8" fill="${c}"/></g>`;
      });
    }
    return `<g class="sc-o"><path d="${d}" fill="none" style="stroke-width:2.5"/>${bulbs}</g>`;
  }

  App.dashScene = {
    layer: null, _tick: null, _lightsW: 0,

    mount() {
      if (this.layer) return;
      const layer = document.createElement('div');
      layer.className = 'dash-scene';
      layer.setAttribute('aria-hidden', 'true');
      layer.innerHTML = frameHTML();
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
        this.layer.dataset.mood = this.mood();
        this.place();
        this.clock();
        if (!this._tick) this._tick = setInterval(() => this.clock(), 30000);
      } else {
        if (this._tick) { clearInterval(this._tick); this._tick = null; }
        if (this._hot) { this._hot = false; this.layer.classList.remove('poster-hot'); }
        const view = document.getElementById('view');
        view.classList.remove('dash-poster-hot'); view.title = '';
      }
    },

    /* The room's lighting follows the theme: a daytime room for the plain
       light theme, a blacked-out edit suite for the dark ones, and warm mood
       lighting (tinted by the theme's accent) for the colourful, expressive
       skins, whatever their mode. */
    mood() {
      const root = document.documentElement;
      if (root.getAttribute('data-skin') === 'expressive') return 'mood';
      return root.getAttribute('data-mode') === 'light' ? 'day' : 'blackout';
    },

    // fill exactly the area under #view, so the frame isn't hidden behind the topbar
    place() {
      if (!this.layer) return;
      const r = document.getElementById('view').getBoundingClientRect();
      Object.assign(this.layer.style, { top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' });
      this.hangArt(r);
      const w = Math.round(r.width);
      if (w && w !== this._lightsW) {
        this._lightsW = w;
        const svg = this.layer.querySelector('.ds-lights');
        svg.setAttribute('viewBox', `0 0 ${w} 60`);
        svg.innerHTML = lightsSVG(w);
      }
    },

    /* Hang the clock and poster in the gap between the greeting and the
       Edit button, centred, scaled down to fit a narrow gap and taken down
       altogether when there's no wall left to hang them on. */
    hangArt(vr) {
      const art = this.layer.querySelector('.ds-wallart');
      const hi = document.querySelector('.dash-hello > :first-child');
      const tools = document.querySelector('.dash-tools');
      if (!hi) { art.style.display = 'none'; return; }
      const a = hi.getBoundingClientRect(), right = tools ? tools.getBoundingClientRect().left : vr.right - 46;
      const gap = right - a.right - 32, ASPECT = 365 / 255;
      const h = Math.min(112, gap / ASPECT);
      if (h < 64) { art.style.display = 'none'; return; }
      Object.assign(art.style, {
        display: '', height: h + 'px',
        left: (a.right - vr.left + 16 + (gap - h * ASPECT) / 2) + 'px',
        top: Math.max(26, a.top - vr.top + a.height - h) + 'px'
      });
    },

    clock() {
      const hands = this.layer && this.layer.querySelectorAll('#sc-clock path[transform]');
      if (!hands || hands.length < 2) return;
      const now = new Date();
      hands[0].setAttribute('transform', `rotate(${((now.getHours() % 12) + now.getMinutes() / 60) * 30})`);
      hands[1].setAttribute('transform', `rotate(${now.getMinutes() * 6})`);
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
