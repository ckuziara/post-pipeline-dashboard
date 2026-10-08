/* Dashboard backdrop — a cozy room drawn around the Dashboard, in the setup
   wizard's thick-outline, flat-pastel hand. It's a frame, not a scene: every
   prop hugs an edge or a corner, the middle is plain wall, and while it's on
   #view gets a wider margin so the room shows around the tiles. The widgets
   always lead.

   Everything in a room is drawn to one real-world scale (see piece()), so
   a desk is desk-sized beside a window at any window size.

   Rooms (Preferences → Dashboard → Room, saved per device). Each has the
   main desk in the lower middle, and the offices have a big
   window centred on the wall, behind everything:
     edit    the edit suite: two monitors, fairy lights, the wizard's ivy,
             a plant, a film reel, a little shelf with snapshots
     loft    a brick loft office: a 2.2 m factory window, ceiling duct and
             pendants, a filing cabinet, binders, a printer
     study   a sunset study: warm walls, a tall sunset window and sun
             shaft, a shelf with trailing pothos, a bookcase, a laptop
     music   a music room: lilac walls, drifting notes, a framed LP,
             a hanging plant, studio speakers, a tripod
     night   a cool-blue den: a frosty window with pines, floating
             shelves, a white bookcase
     neon    a synth studio: neon tube along the ceiling, a synth on the
             desk, a rack with blinking LEDs. Always after dark.

   Lighting follows the theme (see mood()), on top of whichever room:
   daytime for the light theme, a blackout suite for the dark ones, warm
   accent-tinted mood lighting for the colourful expressive skins. The neon
   studio keeps its own night lighting. Props marked emissive (screens,
   lamps, neon) stay lit when the rest of the room goes dark.

   One persistent layer, mounted once and only shown or hidden on render, so
   App.render()'s frequent rebuilds of #view never restart the animations.
   It sits at z-index -1 under #view, which has no background of its own, so
   nothing in it can steal a click.

   The film poster is the one interactive piece, an easter egg with no
   menu entry: click it to pick an image (Option/Alt-click restores the
   stock poster), which is turned into pixel art in the
   scene's own palette and kept on this device only. Because the layer can't
   take clicks, #view's own clicks on bare background are tested against the
   poster's on-screen box instead.

   Device-local prefs: dashScene (on/off, default on), dashRoom (which room),
   dashPoster (the pixel art, a PNG data URL of a few KB). */
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

  /* One prop: the wizard's outline style (.if-svg .sc-o) in its own viewBox.
     Every prop is drawn to one real-world scale, so a desk is desk-sized
     next to a window: `spec` gives its true height in centimetres (`h`, the
     height of the whole viewBox), how far its bottom edge sits above the
     floor (`y`, 0 for anything standing on it), and where it sits across
     the wall: `left` or `right` (cm in from that edge, negative to run off
     it) or `cx` (its centre, as a fraction of the width). Band pieces
     (`band`) hang in the strip above the widgets beside the clock and
     poster, and hangArt sets their left. place() turns cm into pixels from
     the room's height (see CEILING). `emit` marks a prop that gives off
     light, so it stays lit in the dark. */
  const piece = (cls, viewBox, spec, body, opt) => {
    const o = opt || {};
    return `<svg class="if-svg ds-piece ${cls}${spec.band ? ' ds-band' : ''}${o.emit ? ' ds-emit' : ''}" viewBox="${viewBox}" ` +
      `data-spec="${JSON.stringify(spec).replace(/"/g, '&quot;')}" preserveAspectRatio="${o.align || 'xMidYMid meet'}" ` +
      `style="aspect-ratio:${viewBox.split(' ').slice(2).join('/')}" ` +
      `xmlns="http://www.w3.org/2000/svg"><g class="sc-o">${body}</g></svg>`;
  };
  const spec_aspect = n => { const v = n.getAttribute('viewBox').split(' ').map(Number); return v[2] / v[3]; };
  // floor-to-ceiling height the view's wall stands for, in cm
  const CEILING = 300;
  const FLOOR_PX = 34;   // the strip of floor along the bottom (.ds-floor)

  /* The main desk, lower middle, 75 cm to the desktop, with whatever this
     room keeps on it.
     Drawn at 4 units to the centimetre with the floor at y=500 and the
     desktop at y=200, so every desk piece is 125 cm tall and only its width
     differs. Three kinds:
       trestle  220 cm of wooden top on A-frame legs, with two drawer
                pedestals (the music-room desk)
       tapered  a 150 cm light top on dark, splayed, tapering legs (the
                study desk)
       frame    a 160 cm top on a black steel frame, a white filing
                pedestal on casters to one side and a tower to the other
                (the loft desk) */
  const DESK_W = { trestle: 880, tapered: 600, frame: 640 };

  // a monitor standing on the desktop: x, width and height in units
  const screen = (x, w, h, fill, extra) =>
    `<path d="M${x + w / 2} 200 V160 M${x + w / 2 - 30} 200 H${x + w / 2 + 30}" style="stroke-width:8"/>` +
    `<rect x="${x}" y="${160 - h}" width="${w}" height="${h}" rx="8" fill="#3b3b44"/>` +
    `<rect class="ds-glass" x="${x + 10}" y="${170 - h}" width="${w - 20}" height="${h - 20}" rx="4" fill="${fill}" style="stroke-width:3"/>` + (extra || '');

  // three drawers stacked in a pedestal at x, w wide, from the desktop down
  const drawers = (x, w, top, bottom, fill, handle) => {
    const n = 3, gap = 10, dh = (bottom - top - gap * (n + 1)) / n;
    return `<rect x="${x}" y="${top}" width="${w}" height="${bottom - top}" rx="5" fill="${fill}"/>` +
      rep(n, i => `<rect x="${x + 10}" y="${top + gap + i * (dh + gap)}" width="${w - 20}" height="${dh}" rx="4" fill="${fill}" style="stroke-width:3"/>` +
        `<rect x="${x + w / 2 - 22}" y="${top + gap + i * (dh + gap) + dh / 2 - 4}" width="44" height="8" rx="4" fill="${handle || '#e6e8eb'}" style="stroke-width:2"/>`);
  };

  function deskPiece(k) {
    const c = Object.assign({ style: 'tapered', top: '#c9a074', leg: '#3b3b44', ped: '#d8b48a' }, k);
    const W = DESK_W[c.style];
    let frame = '';
    if (c.style === 'trestle') {
      frame = `<rect x="20" y="200" width="${W - 40}" height="22" rx="4" fill="${c.top}"/>` +
        // A-frame legs at each end, with a stretcher
        [70, W - 70].map(x => `<path d="M${x - 28} 222 L${x - 46} 500 M${x + 28} 222 L${x + 46} 500 M${x - 36} 380 H${x + 36}" style="stroke:${c.leg};stroke-width:16;stroke-linecap:butt"/>`).join('') +
        drawers(170, 150, 222, 470, c.ped, '#e6e8eb') + drawers(W - 320, 150, 222, 470, c.ped, '#e6e8eb') +
        `<path d="M180 470 v16 M310 470 v16 M${W - 310} 470 v16 M${W - 180} 470 v16" style="stroke-width:8"/>`;
    } else if (c.style === 'tapered') {
      frame = `<rect x="20" y="200" width="${W - 40}" height="16" rx="4" fill="${c.top}"/>` +
        `<rect x="40" y="216" width="${W - 80}" height="14" fill="${c.top}" style="stroke-width:3"/>` +
        // splayed, tapering legs
        `<path d="M58 230 h26 l-24 270 h-12Z M${W - 84} 230 h26 l12 270 h-12Z" fill="${c.leg}"/>`;
    } else {
      frame = `<rect x="20" y="200" width="${W - 40}" height="18" rx="4" fill="${c.top}"/>` +
        `<path d="M44 218 V500 M${W - 44} 218 V500 M44 232 H${W - 44}" style="stroke:${c.leg};stroke-width:14"/>` +
        // white filing pedestal on casters, and a tower with vents
        drawers(70, 120, 260, 470, c.ped, '#9aa1ab') + `<circle cx="84" cy="484" r="9" fill="#2b2b2b"/><circle cx="176" cy="484" r="9" fill="#2b2b2b"/>` +
        `<rect x="${W - 190}" y="300" width="96" height="196" rx="6" fill="#2a2630"/>` +
        rep(6, i => `<path d="M${W - 176} ${330 + i * 22} H${W - 108}" style="stroke:#4a4a4a;stroke-width:4"/>`) +
        `<circle class="ds-led" cx="${W - 142}" cy="316" r="5" fill="#5ee7f0" style="stroke-width:1.5"/>`;
    }
    const body = (c.items || '') + (c.screens ? c.screens(screen) : '') + frame;
    return piece('ds-desk', `0 0 ${W} 500`, { h: 125, cx: 0.5 }, body, { emit: true });
  }

  const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('');
  // a row of book spines standing on y, from x, in these colours
  const books = (x, y, cols, h) => {
    let cx = x;
    return cols.map((c, i) => {
      const w = 12 + (i * 7) % 8, bh = (h || 52) - (i * 11) % 14;
      const r = `<rect x="${cx}" y="${y - bh}" width="${w}" height="${bh}" rx="2" fill="${c}" style="stroke-width:3"/>`;
      cx += w + 2;
      return r;
    }).join('');
  };
  const leafy = (pts, fill) => pts.map(([x, y, r]) =>
    `<ellipse cx="${x}" cy="${y}" rx="11" ry="6" transform="rotate(${r} ${x} ${y})" fill="${fill || '#7cb86a'}" style="stroke-width:2.5"/>`).join('');
  const notes = (pts) => pts.map(([x, y, s, d]) =>
    `<text class="sc-t ds-note" x="${x}" y="${y}" font-size="${s}" style="animation-delay:-${d}s">${d % 2 ? '♪' : '♫'}</text>`).join('');

  /* ---- top-of-frame strips, drawn to the view's actual width ---- */
  function fairyLights(w) {
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
    return `<path d="${d}" fill="none" style="stroke-width:2.5"/>${bulbs}`;
  }
  // an exposed duct along the ceiling, with two pendant lamps hung off it
  function loftPipe(w) {
    const brackets = rep(Math.ceil(w / 240), i => `<path d="M${120 + i * 240} 2 V22" style="stroke-width:4"/>`);
    const lamp = (x) => `<path d="M${x} 20 V34" style="stroke-width:2.5"/>` +
      `<path class="ds-glow" d="M${x - 16} 50 L${x - 10} 36 H${x + 10} L${x + 16} 50Z" fill="#3b3b44"/>` +
      `<ellipse class="ds-bulb" cx="${x}" cy="52" rx="7" ry="4" fill="#ffd166" style="stroke-width:2"/>`;
    return `<rect x="-10" y="6" width="${w + 20}" height="14" rx="7" fill="#7d838d"/>${brackets}${lamp(Math.round(w * 0.22))}${lamp(Math.round(w * 0.78))}`;
  }
  // a pink neon tube tracing a circuit along the ceiling
  function neonTube(w) {
    let d = 'M-10 14';
    for (let x = 0; x < w; x += 260) d += ` H${x + 120} l14 16 H${x + 210} l14 -16`;
    d += ` H${w + 10}`;
    return `<path class="ds-neon" d="${d}" fill="none" style="stroke:#ff4f86;stroke-width:4"/>` +
      `<path class="ds-neon" d="${d.replace(/M-10 14/, 'M-10 22')}" transform="translate(0 8)" fill="none" style="stroke:#ff4f86;stroke-width:2;opacity:.55"/>`;
  }

  /* ---- the rooms ----
     Everything is to one scale (cm, see piece()). Each room has:
       back    its big window, centred on the wall and drawn behind
               everything else, as in a real office
       band    the small things hung in the strip above the widgets,
               beside the clock and poster (laid out by hangArt)
       pieces  the rest: the desk in the lower middle, side props hung
               from the ceiling or on the wall, floor props in the corners */
  const ROOMS = {
    edit: {
      label: 'Edit suite',
      wall: 'radial-gradient(ellipse at 50% 40%, #fbf8f0 0%, #f4eee0 70%, #eee5d0 100%)',
      floor: '#e8d6b3', top: fairyLights,
      // a little floating shelf, 60 cm: two snapshots and a candle
      band: () => piece('ds-shelfette', '0 0 260 180', { band: true, h: 42, y: 224 }, `
        <rect x="0" y="150" width="260" height="12" rx="3" fill="#c9a074"/>
        <rect x="18" y="52" width="74" height="98" rx="4" fill="#fffdf5"/><rect x="28" y="62" width="54" height="66" fill="#8fb7e8" style="stroke-width:3"/>
        <path d="M28 128 l18 -24 l14 14 l10 -10 l12 20Z" fill="#6c9a5e" style="stroke-width:2"/>
        <rect x="108" y="84" width="64" height="66" rx="4" fill="#fffdf5" transform="rotate(4 140 117)"/><rect x="117" y="93" width="46" height="40" fill="#f7a6b8" transform="rotate(4 140 117)" style="stroke-width:3"/>
        <rect x="196" y="110" width="26" height="40" rx="4" fill="#fffdf5"/>
        <ellipse class="ds-glow" cx="209" cy="98" rx="6" ry="10" fill="#ffd166" style="stroke-width:2.5"/>`),
      pieces: () => {
        const ivy = App.guide.ivySVG();
        return deskPiece({
          style: 'trestle', top: '#c08a55', leg: '#8f5f3a', ped: '#c9935e',
          // two monitors: the timeline, and a viewer
          screens: s => s(250, 200, 120, '#20222b',
            `<g stroke="none"><rect x="272" y="62" width="70" height="10" rx="4" fill="#ff6f9c"/><rect x="300" y="80" width="90" height="10" rx="4" fill="#ffd166"/><rect x="340" y="98" width="70" height="10" rx="4" fill="#6cc24a"/><rect x="280" y="116" width="60" height="10" rx="4" fill="#8fb7e8"/></g>`) +
            s(470, 180, 110, '#5d6fd6'),
          items: `<path d="M690 200 h40 v-34 a10 10 0 0 0 -10 -10 h-20 a10 10 0 0 0 -10 10Z" fill="#f28c6b"/>`
        }) +
          piece('ds-ivy-r', '1500 -10 300 700', { h: 150, y: 150, right: -8 }, ivy, { align: 'xMaxYMin meet' }) +
          piece('ds-ivy-l', '1500 -10 300 700', { h: 120, y: 180, left: -8 }, `<g transform="translate(3300 0) scale(-1 1)">${ivy}</g>`, { align: 'xMinYMin meet' }) +
          piece('ds-plant', '1340 470 210 230', { h: 70, left: 6 }, `
            <path d="M1440 610 q-40 -70 10 -120 q10 60 -10 120 M1460 610 q10 -90 70 -110 q-20 70 -70 110 M1450 610 q-60 -40 -90 -100 q60 20 90 100" fill="#7cb86a"/>
            <path d="M1410 600 h90 l-12 90 h-66Z" fill="#e8946b"/>`) +
          // a 38 cm film reel leaning on the wall, and a mug on the floor beside it
          piece('ds-reel', '140 470 300 235', { h: 46, right: 8 }, `
            <circle cx="250" cy="600" r="96" fill="#5d6fd6"/>
            <circle cx="250" cy="600" r="20" fill="#f4ecd6"/>
            ${[0, 72, 144, 216, 288].map(a => `<circle cx="${250 + Math.cos(a * Math.PI / 180) * 54}" cy="${600 + Math.sin(a * Math.PI / 180) * 54}" r="20" fill="#f4ecd6"/>`).join('')}
            <g transform="translate(-1080 172)">
              <path d="M1440 470 h56 v40 a14 14 0 0 1 -14 14 h-28 a14 14 0 0 1 -14 -14Z" fill="#f28c6b"/>
              <path d="M1496 480 a14 14 0 0 1 0 28" fill="none"/>
              <path class="sc-steam" d="M1458 455 q-10 -16 0 -30 M1478 455 q-10 -16 0 -30" fill="none" stroke-width="4" opacity=".45"/>
            </g>`);
      }
    },

    loft: {
      label: 'Brick loft',
      // brick courses, offset every other row, in a soft terracotta
      wall: `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#e6c3b0"/><g fill="none" stroke="#f3dccf" stroke-width="2"><path d="M0 1H64M0 17H64M1 1V17M33 17V32"/></g></svg>')}") repeat, #e6c3b0`,
      floor: '#b9bec4', top: loftPipe,
      // the steel-framed factory window, 2.2 m wide, the city outside. Every
      // window's top stops at about 205 cm, so the wall above it is clear
      // for the clock, poster and shelves (they hang from 222 cm up)
      back: () => piece('ds-window', '0 0 400 236', { h: 130, y: 75, cx: 0.5 }, `
        <rect x="10" y="10" width="380" height="204" rx="6" fill="#5a6470"/>
        <rect class="ds-glass" x="24" y="24" width="352" height="176" fill="#bfe3f7"/>
        <g stroke="none"><ellipse cx="90" cy="64" rx="34" ry="10" fill="#fff"/><ellipse cx="270" cy="88" rx="26" ry="8" fill="#fff"/>
        <path d="M24 200 V150 h22 v-28 h20 v40 h24 v-62 h26 v54 h18 v-34 h26 v66 h24 v-22 h22 v-44 h28 v58 h20 v-30 h24 v46 h26 v-20 h28 V200Z" fill="#98b6cc"/>
        <path d="M40 30 L110 30 L40 120Z" fill="#fff" opacity=".35"/></g>
        <path d="M112 24 V200 M200 24 V200 M288 24 V200 M24 112 H376" style="stroke:#5a6470;stroke-width:7"/>
        <rect x="0" y="212" width="400" height="14" rx="3" fill="#8a939e"/>`, { emit: true }),
      pieces: () =>
        deskPiece({
          style: 'frame', top: '#c9935e', leg: '#2b2b2b', ped: '#e6e8eb',
          screens: s => s(250, 220, 140, '#dfe8f2'),
          // an anglepoise lamp and a pen cup
          items: `<path d="M110 200 V150 L160 96" fill="none" style="stroke:#e6e8eb;stroke-width:8"/><path d="M90 200 h40" style="stroke-width:8"/>
            <path class="ds-glow" d="M150 80 l40 -14 l12 32 l-38 10Z" fill="#e6e8eb"/>
            <rect x="500" y="164" width="30" height="36" rx="4" fill="#6b6f78"/><path d="M508 164 l-6 -24 M518 164 v-28 M526 164 l8 -22" style="stroke-width:4"/>`
        }) +
        // a row of binders on a 70 cm wall shelf
        piece('ds-binders', '0 0 210 140', { h: 47, y: 226, right: 10 }, `
          <rect x="0" y="118" width="210" height="12" rx="3" fill="#a07a58"/>
          ${['#3b4a6b', '#4a4a4a', '#6c9a5e', '#3b4a6b', '#c9a074'].map((c, i) =>
            `<rect x="${14 + i * 34}" y="${i === 4 ? 70 : 34}" width="28" height="${i === 4 ? 48 : 84}" rx="3" fill="${c}"/><rect x="${20 + i * 34}" y="${i === 4 ? 80 : 50}" width="16" height="10" rx="2" fill="#fffdf5" style="stroke-width:2"/>`).join('')}`) +
        // a 70 cm two-drawer cabinet with a plant on the floor beside it
        piece('ds-cabinet', '0 120 270 180', { h: 84, left: 6 }, `
          <rect x="10" y="140" width="150" height="150" rx="8" fill="#c9a074"/>
          ${rep(2, i => `<rect x="24" y="${154 + i * 66}" width="122" height="56" rx="5" fill="#d8b48a"/><rect x="71" y="${172 + i * 66}" width="28" height="8" rx="4" fill="#6b5844" style="stroke-width:2"/>`)}
          <path d="M184 230 h70 l-8 60 h-54Z" fill="#6b6f78"/>
          <path d="M219 230 q-30 -60 0 -100 q20 50 0 100 M219 230 q20 -70 46 -76 q-10 56 -46 76 M219 230 q-40 -30 -46 -76 q36 20 46 76" fill="#7cb86a"/>`) +
        // a printer on a low cabinet
        piece('ds-printer', '0 20 230 210', { h: 95, right: 8 }, `
          <rect x="30" y="110" width="180" height="114" rx="8" fill="#9aa1ab"/>
          <path d="M120 120 V214" style="stroke-width:3;opacity:.5"/>
          <rect x="48" y="60" width="144" height="50" rx="8" fill="#e6e8eb"/>
          <rect x="70" y="30" width="100" height="34" rx="3" fill="#fffdf5"/>
          <rect x="150" y="74" width="22" height="8" rx="4" class="ds-led" fill="#6cc24a" style="stroke-width:1.5"/>`)
    },

    study: {
      label: 'Sunset study',
      // warm dusk plaster rather than cold slate, so the sunset reads warm
      wall: 'linear-gradient(180deg, #e7cfc6 0%, #d9bdb9 100%)',
      light: 'linear-gradient(118deg, transparent 52%, rgba(255, 186, 110, .5) 60%, rgba(255, 186, 110, .2) 72%, transparent 80%)',
      floor: '#8a6a6e',
      // the tall window the sun's coming in through, the city going gold
      back: () => piece('ds-window', '0 0 230 250', { h: 120, y: 85, cx: 0.5 }, `
        <defs><linearGradient id="ds-sunset" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe2a8"/><stop offset=".6" stop-color="#ffb37a"/><stop offset="1" stop-color="#f28c6b"/></linearGradient></defs>
        <rect x="10" y="10" width="210" height="226" rx="6" fill="#fffdf5"/>
        <rect class="ds-glass" x="24" y="24" width="182" height="198" fill="url(#ds-sunset)"/>
        <circle cx="150" cy="150" r="26" fill="#fff4cf" stroke="none"/>
        <path d="M24 222 V178 h20 v-30 h22 v44 h18 v-56 h24 v40 h20 v-26 h24 v52 h22 v-18 h32 V222Z" fill="#c9787a" stroke="none" opacity=".85"/>
        <path d="M115 24 V222 M24 110 H206" style="stroke:#fffdf5;stroke-width:9"/>`, { emit: true }),
      pieces: () =>
        deskPiece({
          style: 'tapered', top: '#d9b98f', leg: '#2f3442',
          // a laptop, the orange lamp, a little plant
          items: `<path d="M260 200 l20 -96 h150 l-20 96Z" fill="#9aa1ab"/><path class="ds-glass" d="M286 112 h132 l-16 78 h-132Z" fill="#fff4cf" style="stroke-width:3"/><path d="M230 200 h220" style="stroke-width:8"/>
            <path d="M120 200 V150 L160 96" fill="none" style="stroke:#e8946b;stroke-width:8"/><path d="M100 200 h40" style="stroke-width:8"/>
            <path class="ds-glow" d="M150 80 l40 -14 l12 32 l-38 10Z" fill="#f28c6b"/>
            <path d="M500 200 h40 l-5 -30 h-30Z" fill="#fffdf5"/><path d="M520 170 q-12 -26 0 -40 q10 20 0 40 M520 170 q10 -24 26 -28 q-6 22 -26 28" fill="#6c9a5e"/>`
        }) +
        // a 70 cm wall shelf of books with pothos trailing off it
        piece('ds-shelf', '0 0 270 260', { h: 73, y: 184, left: 4 }, `
          <rect x="0" y="96" width="250" height="14" rx="3" fill="#a07a58"/>
          <path d="M40 110 V140 M210 110 V140" style="stroke-width:6"/>
          ${books(30, 96, ['#e8946b', '#8fb7e8', '#fffdf5', '#6c9a5e', '#b98ce6'], 60)}
          <path d="M170 96 h46 l-6 -30 h-34Z" fill="#e8946b"/>
          <path d="M194 66 q-6 -26 10 -40 M194 66 q-18 -16 -26 -34" fill="none" style="stroke:#5f9a57;stroke-width:3"/>
          <path d="M190 100 C 200 150, 170 190, 196 250" fill="none" style="stroke:#5f9a57;stroke-width:3"/>
          ${leafy([[196, 130, 30], [182, 160, -20], [190, 196, 40], [184, 226, -30], [200, 18, -40], [168, 30, 20]], '#7cb86a')}`) +
        // the low end of an 80 cm bookcase: a shelf of books and a cupboard
        piece('ds-bookcase', '0 214 190 220', { h: 103, right: 4 }, `
          <rect x="10" y="214" width="170" height="220" rx="8" fill="#b07a4c"/>
          <rect x="24" y="226" width="142" height="196" rx="4" fill="#8f5f3a"/>
          <rect x="24" y="310" width="142" height="10" fill="#b07a4c" style="stroke-width:3"/>
          ${books(30, 310, ['#b98ce6', '#fffdf5', '#8fb7e8', '#f28c6b', '#c9a074', '#6c9a5e'], 76)}
          <rect x="34" y="330" width="122" height="82" rx="4" fill="#a8703f"/><circle cx="95" cy="370" r="5" fill="#2b2b2b"/>`) +
        // a 60 cm side cabinet with a pot plant
        piece('ds-sidecab', '0 140 300 160', { h: 53, left: 4 }, `
          <rect x="10" y="150" width="180" height="140" rx="8" fill="#7a6a86"/>
          ${rep(2, i => `<rect x="24" y="${164 + i * 62}" width="152" height="50" rx="5" fill="#90819e"/><rect x="86" y="${184 + i * 62}" width="28" height="8" rx="4" fill="#2b2b2b" style="stroke-width:2"/>`)}
          <path d="M215 290 h70 l-8 -50 h-54Z" fill="#fffdf5"/>
          <path d="M250 240 q-30 -50 0 -90 q20 40 0 90 M250 240 q20 -60 44 -66 q-10 50 -44 66 M250 240 q-34 -24 -44 -66 q34 16 44 66" fill="#6c9a5e"/>`)
    },

    music: {
      label: 'Music room',
      wall: 'linear-gradient(180deg, #ecd9ee 0%, #e2cbe6 100%)',
      floor: '#8e7fa3', top: fairyLights,
      // a framed LP (31 cm), and a hanging plant on a cord from the ceiling
      band: () =>
        piece('ds-record', '0 0 200 200', { band: true, h: 34, y: 230 }, `
          <rect x="10" y="10" width="180" height="180" rx="6" fill="#fffdf5"/>
          <circle cx="100" cy="100" r="70" fill="#2b2b2b"/>
          <g fill="none" style="stroke:#4a4a4a;stroke-width:2"><circle cx="100" cy="100" r="58"/><circle cx="100" cy="100" r="46"/><circle cx="100" cy="100" r="34"/></g>
          <circle cx="100" cy="100" r="20" fill="#ff6f9c"/><circle cx="100" cy="100" r="4" fill="#fffdf5" style="stroke-width:2"/>`) +
        piece('ds-hang', '30 0 140 330', { band: true, h: 103, y: 197 }, `
          <path d="M100 0 V96" style="stroke-width:2.5"/>
          <path d="M60 96 h80 l-10 46 h-60Z" fill="#f28c6b"/>
          <path d="M70 136 C 50 186, 80 226, 60 296 M130 136 C 150 196, 120 236, 140 276 M100 142 C 104 196, 90 226, 100 256" fill="none" style="stroke:#5f9a57;stroke-width:3"/>
          ${leafy([[66, 166, 30], [58, 212, -30], [70, 256, 40], [62, 288, -20], [140, 172, -30], [128, 216, 20], [142, 260, -40], [98, 190, 60], [96, 236, -50], [80, 88, -30], [120, 86, 30]])}`),
      pieces: () =>
        deskPiece({
          style: 'trestle', top: '#b07a4c', leg: '#8f5f3a', ped: '#c08a55',
          // a monitor between two studio speakers
          screens: s => s(340, 200, 120, '#fff4cf'),
          items: `<rect x="210" y="110" width="70" height="90" rx="8" fill="#3b3b44"/><circle cx="245" cy="168" r="18" fill="#6b6f78"/><circle cx="245" cy="132" r="8" fill="#6b6f78"/>
            <rect x="600" y="110" width="70" height="90" rx="8" fill="#3b3b44"/><circle cx="635" cy="168" r="18" fill="#6b6f78"/><circle cx="635" cy="132" r="8" fill="#6b6f78"/>`
        }) +
        piece('ds-notes-l', '0 0 120 300', { h: 60, y: 110, left: 2 }, notes([[20, 60, 34, 1], [70, 140, 26, 2], [24, 230, 30, 3]])) +
        piece('ds-notes-r', '0 0 120 300', { h: 55, y: 90, right: 3 }, notes([[60, 50, 30, 2], [20, 150, 26, 1], [70, 250, 32, 4]])) +
        // an 80 cm wall shelf: a speaker, records, a plant
        piece('ds-mshelf', '0 0 270 170', { h: 50, y: 219, right: 6 }, `
          <rect x="0" y="140" width="270" height="12" rx="3" fill="#a07a58"/>
          <rect x="16" y="64" width="60" height="76" rx="6" fill="#3b3b44"/><circle cx="46" cy="114" r="16" fill="#6b6f78"/><circle cx="46" cy="84" r="7" fill="#6b6f78"/>
          ${books(96, 140, ['#ff6f9c', '#8fb7e8', '#ffd166', '#6c9a5e'], 66)}
          <path d="M190 140 h50 l-6 -30 h-38Z" fill="#e8946b"/>
          ${leafy([[204, 98, -40], [222, 92, 30], [214, 78, -10], [196, 84, 20]])}`) +
        // a 90 cm floor plant in a 35 cm pot
        piece('ds-bigplant', '0 60 230 270', { h: 90, left: 4 }, `
          <path d="M70 330 l-8 -80 h106 l-8 80Z" fill="#4a4a4a"/>
          <path d="M115 250 C 60 200, 40 120, 70 60 C 100 120, 110 190, 115 250Z M115 250 C 150 190, 190 150, 210 90 C 180 160, 150 210, 115 250Z M115 250 C 100 170, 130 90, 150 30 C 150 120, 130 190, 115 250Z M115 250 C 70 230, 30 200, 10 150 C 60 170, 90 210, 115 250Z" fill="#6c9a5e"/>`) +
        // a camera on a low tripod, and a floor monitor speaker
        piece('ds-tripod', '0 60 230 210', { h: 66, right: 6 }, `
          <path d="M150 120 L110 262 M150 120 L190 262 M150 120 V262" style="stroke-width:5"/>
          <rect x="120" y="70" width="60" height="50" rx="8" fill="#4a4a4a"/><circle cx="150" cy="95" r="14" fill="#8fb7e8"/>
          <rect x="10" y="150" width="80" height="112" rx="8" fill="#3b3b44"/><circle cx="50" cy="222" r="24" fill="#6b6f78"/><circle cx="50" cy="176" r="10" fill="#6b6f78"/>`)
    },

    night: {
      label: 'Cool-blue den',
      wall: 'linear-gradient(180deg, #b4c1e8 0%, #a5b3df 100%)',
      floor: '#7f72bd',
      // the frosty window, moonlit, with pines outside
      back: () => piece('ds-window', '0 0 300 236', { h: 115, y: 90, cx: 0.5 }, `
        <rect x="10" y="10" width="280" height="206" rx="6" fill="#fffdf5"/>
        <rect class="ds-glass" x="26" y="26" width="248" height="174" fill="#def5f4"/>
        <circle cx="220" cy="70" r="18" fill="#fffef0" stroke="none"/>
        <g stroke="none" fill="#7cc3b5"><path d="M50 200 l26 -100 l26 100Z"/><path d="M120 200 l18 -70 l18 70Z" opacity=".8"/><path d="M190 200 l24 -116 l24 116Z"/><path d="M240 200 l14 -52 l14 52Z" opacity=".8"/></g>
        <path d="M150 26 V200 M26 113 H274" style="stroke:#fffdf5;stroke-width:10"/>
        <rect x="0" y="212" width="300" height="14" rx="3" fill="#e6e8f2"/>`, { emit: true }),
      pieces: () =>
        deskPiece({
          style: 'tapered', top: '#f2f3f8', leg: '#cfd5ea',
          // a wide curved monitor, headphones, a cactus, a mug
          screens: s => s(170, 300, 130, '#ffe9c4'),
          items: `<path d="M500 200 v-26 a24 24 0 0 1 48 0 v26" fill="none" style="stroke-width:7"/><rect x="494" y="180" width="14" height="22" rx="5" fill="#e6e8f2"/><rect x="540" y="180" width="14" height="22" rx="5" fill="#e6e8f2"/>
            <rect x="90" y="176" width="30" height="24" rx="4" fill="#e8946b"/><path d="M98 176 v-30 a7 7 0 0 1 14 0 v30" fill="#7cb86a"/>
            <path d="M140 200 h26 v-26 h-26Z" fill="#fffdf5"/>`
        }) +
        // three 60 cm floating shelves: books, a puzzle cube, a figure
        piece('ds-floats', '0 0 220 380', { h: 120, y: 145, right: 4 }, `
          ${rep(3, i => `<rect x="20" y="${110 + i * 120}" width="190" height="12" rx="3" fill="#fffdf5"/>`)}
          ${books(40, 110, ['#5d6fd6', '#a85a5a', '#fffdf5'], 70)}
          <g transform="translate(140 64)"><rect width="44" height="44" rx="4" fill="#ffd166"/><path d="M15 0 V44 M29 0 V44 M0 15 H44 M0 29 H44" style="stroke-width:2"/><rect x="1" y="1" width="14" height="14" fill="#ff6f9c" stroke="none"/><rect x="29" y="29" width="14" height="14" fill="#5d6fd6" stroke="none"/></g>
          ${books(110, 230, ['#8fb7e8', '#a85a5a', '#6c9a5e', '#fffdf5'], 70)}
          <path d="M50 350 l14 -40 h24 l14 40Z" fill="#3b3b44"/><circle cx="76" cy="300" r="12" fill="#3b3b44"/>`) +
        // an 88 cm, 80 cm-wide white bookcase
        piece('ds-lowcase', '0 20 220 220', { h: 88, left: 4 }, `
          <rect x="10" y="20" width="200" height="214" rx="8" fill="#fffdf5"/>
          <rect x="10" y="122" width="200" height="10" fill="#e6e8f2" style="stroke-width:3"/>
          ${books(24, 122, ['#a85a5a', '#8fb7e8', '#6c9a5e', '#5d6fd6', '#f7a6b8', '#ffd166'], 86)}
          ${books(30, 224, ['#5d6fd6', '#fffdf5', '#a85a5a', '#ffd166'], 80)}
          <rect x="128" y="170" width="66" height="54" rx="4" fill="#cfd5ea"/>`)
    },

    neon: {
      label: 'Neon synth studio', mood: 'neon',
      wall: 'radial-gradient(ellipse at 50% 30%, #2a1f31 0%, #1b1622 60%, #120e17 100%)',
      floor: '#100d14', top: neonTube,
      pieces: () =>
        deskPiece({
          style: 'frame', top: '#2a2630', leg: '#3b3443', ped: '#3b3443',
          // a synth across the desk, LEDs lit
          items: `<rect x="110" y="150" width="420" height="50" rx="8" fill="#2a2630"/>
            ${rep(24, k => `<rect x="${124 + k * 16.5}" y="172" width="13" height="26" rx="2" fill="#e8e4ee" style="stroke-width:1.5"/>`)}
            ${rep(8, k => `<circle class="ds-led" style="animation-delay:-${k * 0.31}s" cx="${140 + k * 48}" cy="161" r="4" fill="${['#ff4f86', '#5ee7f0', '#ffd166'][k % 3]}" style="stroke-width:1.5"/>`)}`
        }) +
        // a 19-inch rack, 90 cm: four units of blinking LEDs and keys on top
        piece('ds-rack', '0 10 240 356', { h: 90, left: 4 }, `
          ${rep(4, i => `<rect x="10" y="${20 + i * 74}" width="190" height="64" rx="6" fill="#2a2630"/>` +
            rep(6, k => `<circle class="ds-led" style="animation-delay:-${(i * 6 + k) * 0.37 % 2}s" cx="${32 + k * 26}" cy="${42 + i * 74}" r="5" fill="${['#ff4f86', '#5ee7f0', '#ffd166'][(i + k) % 3]}" style="stroke-width:1.5"/>`) +
            `<rect x="26" y="${60 + i * 74}" width="150" height="10" rx="3" fill="#3b3443" style="stroke-width:2"/>`)}
          <rect x="0" y="320" width="230" height="38" rx="6" fill="#2a2630"/>
          ${rep(14, k => `<rect x="${10 + k * 15}" y="326" width="12" height="26" rx="2" fill="#e8e4ee" style="stroke-width:1.5"/>`)}`, { emit: true })
    }
  };
  const ROOM_LIST = Object.keys(ROOMS).map(v => ({ v, label: ROOMS[v].label }));
  const room = () => ROOMS[App.prefs.get('dashRoom', 'edit')] || ROOMS.edit;

  function frameHTML(r) {
    return `<div class="ds-wall" style="background:${r.wall.replace(/"/g, '&quot;')}"></div>` +
      '<div class="ds-light"></div>' +
      (r.light ? `<div class="ds-roomlight" style="background:${r.light}"></div>` : '') +
      // the room's big window first, behind everything
      (r.back ? r.back() : '') +
      // then the floor, so every prop stands on it rather than in it
      `<div class="ds-floor" style="background:${r.floor}"></div>` +
      '<svg class="if-svg ds-piece ds-top" xmlns="http://www.w3.org/2000/svg"></svg>' +
      // the clock and the poster, in the band beside the greeting — hung
      // before the props, so the hanging plants trail in front of them
      piece('ds-wallart', '1080 25 365 255', { art: true, h: 58, y: 222 }, `
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
        </g>`) +
      (r.band ? r.band() : '') +
      r.pieces() +
      // props are drawn solid (so nothing shows through them); this veil over
      // the whole room is what washes it out, so the widgets lead
      '<div class="ds-wash"></div>' +
      // depth of field: the room falls out of focus toward the edges, so the
      // eye stays on the widgets in the middle (two rings, softer further out)
      '<div class="ds-dof ds-dof-near"></div><div class="ds-dof ds-dof-far"></div>';
  }

  App.dashScene = {
    layer: null, _tick: null, _topW: 0, ROOMS: ROOM_LIST,

    mount() {
      if (this.layer) return;
      const layer = document.createElement('div');
      layer.className = 'dash-scene';
      layer.setAttribute('aria-hidden', 'true');
      this._room = room();
      layer.dataset.room = App.prefs.get('dashRoom', 'edit');
      layer.innerHTML = frameHTML(this._room);
      document.body.appendChild(layer);
      this.layer = layer;
      this.groundFloorProps();
      this.applyPoster();
      if (this._wired) return;
      this._wired = true;
      window.addEventListener('resize', () => this.place());
      const view = document.getElementById('view');
      // the easter egg: click the picture to hang your own; Option/Alt-click
      // to put the stock poster back
      view.addEventListener('click', e => {
        if (!this.overPoster(e)) return;
        if (e.altKey) { if (App.prefs.get('dashPoster', null)) { this.resetPoster(); App.toast('The old poster’s back up'); } }
        else this.pickPoster();
      });
      view.addEventListener('mousemove', e => {
        const hot = this.overPoster(e);
        if (hot === this._hot) return;
        this._hot = hot;
        this.layer.classList.toggle('poster-hot', hot);
        view.classList.toggle('dash-poster-hot', hot);
        // no tooltip — it's a secret; the lift on hover is the only hint
      });
    },

    /* Make everything that stands on the floor actually touch it. A prop's
       drawing rarely reaches the very bottom of its viewBox, which left it
       hovering; so once the room is on screen, trim each floor prop's
       viewBox to the bottom of what's drawn (plus half the outline), and
       shrink its height in cm by the same share, so its scale is unchanged. */
    groundFloorProps() {
      this.layer.querySelectorAll('.ds-piece[data-spec]').forEach(n => {
        const sp = JSON.parse(n.dataset.spec);
        if (sp.band || sp.art || sp.y) return;
        const g = n.querySelector('g.sc-o');
        let bb;
        try { bb = g.getBBox(); } catch (e) { return; }
        const [vx, vy, vw, vh] = n.getAttribute('viewBox').split(' ').map(Number);
        const bottom = Math.min(vy + vh, bb.y + bb.height + 2.5);
        if (!(bottom > vy) || bottom >= vy + vh - 0.5) return;
        const nh = bottom - vy;
        sp.h = sp.h * nh / vh;
        n.setAttribute('viewBox', `${vx} ${vy} ${vw} ${nh}`);
        n.style.aspectRatio = `${vw}/${nh}`;
        n.dataset.spec = JSON.stringify(sp);
      });
    },

    // a different room: take this one down and put the new one up
    rebuild() {
      if (this.layer) { this.layer.remove(); this.layer = null; }
      this._topW = 0; this._hot = false;
      this.sync();
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
        view.classList.remove('dash-poster-hot');
      }
    },

    /* The room's lighting follows the theme: a daytime room for the plain
       light theme, a blacked-out edit suite for the dark ones, and warm mood
       lighting (tinted by the theme's accent) for the colourful, expressive
       skins, whatever their mode. A room can keep its own (the neon studio
       is always after dark). */
    mood() {
      if (this._room && this._room.mood) return this._room.mood;
      const root = document.documentElement;
      if (root.getAttribute('data-skin') === 'expressive') return 'mood';
      return root.getAttribute('data-mode') === 'light' ? 'day' : 'blackout';
    },

    // fill exactly the area under #view, so the frame isn't hidden behind the topbar
    // fill exactly the area under #view, so the frame isn't hidden behind the topbar
    place() {
      if (!this.layer) return;
      const r = document.getElementById('view').getBoundingClientRect();
      Object.assign(this.layer.style, { top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' });
      // one scale for the whole room: the wall, floor to ceiling, is CEILING cm
      const ppc = Math.max(1, (r.height - FLOOR_PX) / CEILING);
      this.layer.querySelectorAll('.ds-piece[data-spec]').forEach(n => {
        const sp = JSON.parse(n.dataset.spec);
        const h = sp.h * ppc, w = h * spec_aspect(n);
        const st = { height: h + 'px', bottom: (FLOOR_PX + (sp.y || 0) * ppc) + 'px', top: 'auto' };
        if (!(sp.band || sp.art)) {
          if (sp.cx != null) st.left = (r.width * sp.cx - w / 2) + 'px';
          else if (sp.left != null) st.left = (sp.left * ppc) + 'px';
          else st.right = (sp.right * ppc) + 'px';
        }
        Object.assign(n.style, st);
      });
      this.hangArt(r);
      const w = Math.round(r.width);
      if (w && w !== this._topW) {
        this._topW = w;
        const svg = this.layer.querySelector('.ds-top');
        svg.setAttribute('viewBox', `0 0 ${w} 60`);
        svg.innerHTML = this._room.top ? `<g class="sc-o">${this._room.top(w)}</g>` : '';
      }
    },

    /* Hang the clock and poster, and the room's own band pieces beside
       them, as one group centred in the gap between the greeting and the
       Edit button. Sizes are true to scale (place() has set each height);
       when the group won't fit the gap, the room's pieces come down first,
       then the clock and poster too. */
    hangArt(vr) {
      const art = this.layer.querySelector('.ds-wallart');
      const all = [art].concat([...this.layer.querySelectorAll('.ds-band')]);
      const hi = document.querySelector('.dash-hello > :first-child');
      const tools = document.querySelector('.dash-tools');
      all.forEach(n => { n.style.display = 'none'; });
      if (!hi) return;
      const a = hi.getBoundingClientRect(), right = tools ? tools.getBoundingClientRect().left : vr.right - 46;
      const gap = right - a.right - 32, GAP = 22;
      const wOf = n => parseFloat(n.style.height) * spec_aspect(n);
      const show = all.slice();
      const width = () => show.reduce((t, n) => t + wOf(n), 0) + GAP * (show.length - 1);
      while (show.length && width() > gap) show.pop();
      if (!show.length) return;
      // the room's pieces first, then the clock and poster nearest the middle
      const order = show.slice(1).concat(show[0]);
      let x = a.right - vr.left + 16 + (gap - width()) / 2;
      order.forEach(n => { Object.assign(n.style, { display: '', left: x + 'px' }); x += wOf(n) + GAP; });
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
