/* Dashboard backdrop — a cozy room drawn around the Dashboard, in the setup
   wizard's thick-outline, flat-pastel hand. It's a frame, not a scene: every
   prop hugs an edge or a corner, the middle is plain wall, and while it's on
   #view gets a wider margin so the room shows around the tiles. The widgets
   always lead.

   Rooms (Preferences → Dashboard → Room, saved per device):
     edit    the edit suite: fairy lights, the wizard's ivy, a plant, a reel
     loft    a brick loft office: tall window, ceiling pipe and pendants,
             filing cabinet, binders, a printer
     study   a sunset study: slate walls, a sun shaft, a book shelf with
             trailing pothos, a tall bookcase, a lamp on a side cabinet
     music   a music room: lilac walls, drifting notes, hanging plant,
             speakers, a shelf, a tripod
     night   a cool-blue den: a frosty window with pines, floating shelves,
             a low bookcase, a yellow chair
     neon    a synth studio: neon tube along the ceiling, a rack with
             blinking LEDs and keys. Always after dark.

   Lighting follows the theme (see mood()), on top of whichever room:
   daytime for the light theme, a blackout suite for the dark ones, warm
   accent-tinted mood lighting for the colourful expressive skins. The neon
   studio keeps its own night lighting. Props marked emissive (screens,
   lamps, neon) stay lit when the rest of the room goes dark.

   One persistent layer, mounted once and only shown or hidden on render, so
   App.render()'s frequent rebuilds of #view never restart the animations.
   It sits at z-index -1 under #view, which has no background of its own, so
   nothing in it can steal a click.

   The film poster is the one interactive piece: click it (or Preferences →
   Wall poster) to pick an image, which is turned into pixel art in the
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

  /* One prop: the wizard's outline style (.if-svg .sc-o) in its own viewBox,
     pinned to the frame by `place` (inline CSS: an edge or corner, and a
     height — the width follows from the viewBox). `emit` marks a prop that
     gives off light, so it stays lit in the dark. */
  const piece = (cls, viewBox, place, body, opt) => {
    const o = opt || {};
    return `<svg class="if-svg ds-piece ${cls}${o.emit ? ' ds-emit' : ''}" viewBox="${viewBox}" ` +
      `preserveAspectRatio="${o.align || 'xMidYMid meet'}" style="${place};aspect-ratio:${viewBox.split(' ').slice(2).join('/')}" ` +
      `xmlns="http://www.w3.org/2000/svg"><g class="sc-o">${body}</g></svg>`;
  };
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
     Only three parts of the frame are ever really seen: the band above the
     widgets (between the greeting and the Edit button), the side margins,
     and the strip of floor. So each room's signature piece — a window, a
     record, a sign — hangs in the band beside the clock and poster
     (`band`, laid out by hangArt), side props are tall and narrow, and
     floor props are short enough to stand in the bottom margin. */
  const ROOMS = {
    edit: {
      label: 'Edit suite',
      wall: 'radial-gradient(ellipse at 50% 40%, #fbf8f0 0%, #f4eee0 70%, #eee5d0 100%)',
      floor: '#e8d6b3', top: fairyLights,
      // a little floating shelf: two snapshots and a candle
      band: () => piece('ds-band', '0 0 260 180', '', `
        <rect x="0" y="150" width="260" height="12" rx="3" fill="#c9a074"/>
        <rect x="18" y="52" width="74" height="98" rx="4" fill="#fffdf5"/><rect x="28" y="62" width="54" height="66" fill="#8fb7e8" style="stroke-width:3"/>
        <path d="M28 128 l18 -24 l14 14 l10 -10 l12 20Z" fill="#6c9a5e" style="stroke-width:2"/>
        <rect x="108" y="84" width="64" height="66" rx="4" fill="#fffdf5" transform="rotate(4 140 117)"/><rect x="117" y="93" width="46" height="40" fill="#f7a6b8" transform="rotate(4 140 117)" style="stroke-width:3"/>
        <rect x="196" y="110" width="26" height="40" rx="4" fill="#fffdf5"/>
        <ellipse class="ds-glow" cx="209" cy="98" rx="6" ry="10" fill="#ffd166" style="stroke-width:2.5"/>`),
      pieces: () => {
        const ivy = App.guide.ivySVG();
        return piece('ds-ivy-r', '1500 -10 300 700', 'top:0;right:-18px;height:min(55%,460px)', ivy, { align: 'xMaxYMin meet' }) +
          piece('ds-ivy-l', '1500 -10 300 700', 'top:0;left:-18px;height:min(42%,360px)', `<g transform="translate(3300 0) scale(-1 1)">${ivy}</g>`, { align: 'xMinYMin meet' }) +
          piece('ds-plant', '1340 470 210 230', 'left:10px;bottom:14px;height:96px', `
            <path d="M1440 610 q-40 -70 10 -120 q10 60 -10 120 M1460 610 q10 -90 70 -110 q-20 70 -70 110 M1450 610 q-60 -40 -90 -100 q60 20 90 100" fill="#7cb86a"/>
            <path d="M1410 600 h90 l-12 90 h-66Z" fill="#e8946b"/>`) +
          piece('ds-reel', '140 470 300 235', 'right:14px;bottom:16px;height:84px', `
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
      // the big steel-framed window, with the city outside
      band: () => piece('ds-band', '0 0 400 236', '', `
        <rect x="10" y="10" width="380" height="204" rx="6" fill="#5a6470"/>
        <rect class="ds-glass" x="24" y="24" width="352" height="176" fill="#bfe3f7"/>
        <g stroke="none"><ellipse cx="90" cy="64" rx="34" ry="10" fill="#fff"/><ellipse cx="270" cy="88" rx="26" ry="8" fill="#fff"/>
        <path d="M24 200 V150 h22 v-28 h20 v40 h24 v-62 h26 v54 h18 v-34 h26 v66 h24 v-22 h22 v-44 h28 v58 h20 v-30 h24 v46 h26 v-20 h28 V200Z" fill="#98b6cc"/>
        <path d="M40 30 L110 30 L40 120Z" fill="#fff" opacity=".35"/></g>
        <path d="M112 24 V200 M200 24 V200 M288 24 V200 M24 112 H376" style="stroke:#5a6470;stroke-width:7"/>
        <rect x="0" y="212" width="400" height="14" rx="3" fill="#8a939e"/>`, { emit: true }),
      pieces: () =>
        piece('ds-binders', '0 0 210 140', 'top:30px;right:14px;height:64px', `
          <rect x="0" y="118" width="210" height="12" rx="3" fill="#a07a58"/>
          ${['#3b4a6b', '#4a4a4a', '#6c9a5e', '#3b4a6b', '#c9a074'].map((c, i) =>
            `<rect x="${14 + i * 34}" y="${i === 4 ? 70 : 34}" width="28" height="${i === 4 ? 48 : 84}" rx="3" fill="${c}"/><rect x="${20 + i * 34}" y="${i === 4 ? 80 : 50}" width="16" height="10" rx="2" fill="#fffdf5" style="stroke-width:2"/>`).join('')}`) +
        // a squat two-drawer cabinet with a plant, and a printer on a stand
        piece('ds-cabinet', '0 120 270 180', 'left:8px;bottom:14px;height:92px', `
          <rect x="10" y="140" width="150" height="150" rx="8" fill="#c9a074"/>
          ${rep(2, i => `<rect x="24" y="${154 + i * 66}" width="122" height="56" rx="5" fill="#d8b48a"/><rect x="71" y="${172 + i * 66}" width="28" height="8" rx="4" fill="#6b5844" style="stroke-width:2"/>`)}
          <path d="M184 230 h70 l-8 60 h-54Z" fill="#6b6f78"/>
          <path d="M219 230 q-30 -60 0 -100 q20 50 0 100 M219 230 q20 -70 46 -76 q-10 56 -46 76 M219 230 q-40 -30 -46 -76 q36 20 46 76" fill="#7cb86a"/>`) +
        piece('ds-printer', '0 20 230 210', 'right:12px;bottom:14px;height:88px', `
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
      // the window the sun's coming in through, the city going gold
      band: () => piece('ds-band', '0 0 230 250', '', `
        <defs><linearGradient id="ds-sunset" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe2a8"/><stop offset=".6" stop-color="#ffb37a"/><stop offset="1" stop-color="#f28c6b"/></linearGradient></defs>
        <rect x="10" y="10" width="210" height="226" rx="6" fill="#fffdf5"/>
        <rect class="ds-glass" x="24" y="24" width="182" height="198" fill="url(#ds-sunset)"/>
        <circle cx="150" cy="150" r="26" fill="#fff4cf" stroke="none"/>
        <path d="M24 222 V178 h20 v-30 h22 v44 h18 v-56 h24 v40 h20 v-26 h24 v52 h22 v-18 h32 V222Z" fill="#c9787a" stroke="none" opacity=".85"/>
        <path d="M115 24 V222 M24 110 H206" style="stroke:#fffdf5;stroke-width:9"/>`, { emit: true }),
      pieces: () =>
        piece('ds-shelf', '0 0 270 260', 'top:-14px;left:10px;height:150px', `
          <rect x="0" y="96" width="250" height="14" rx="3" fill="#a07a58"/>
          <path d="M40 110 V140 M210 110 V140" style="stroke-width:6"/>
          ${books(30, 96, ['#e8946b', '#8fb7e8', '#fffdf5', '#6c9a5e', '#b98ce6'], 60)}
          <path d="M170 96 h46 l-6 -30 h-34Z" fill="#e8946b"/>
          <path d="M194 66 q-6 -26 10 -40 M194 66 q-18 -16 -26 -34" fill="none" style="stroke:#5f9a57;stroke-width:3"/>
          <path d="M190 100 C 200 150, 170 190, 196 250" fill="none" style="stroke:#5f9a57;stroke-width:3"/>
          ${leafy([[196, 130, 30], [182, 160, -20], [190, 196, 40], [184, 226, -30], [200, 18, -40], [168, 30, 20]], '#7cb86a')}`) +
        // just the bottom of the bookcase: a low shelf of books and a cupboard
        piece('ds-bookcase', '0 214 190 220', 'right:6px;bottom:14px;height:100px', `
          <rect x="10" y="214" width="170" height="220" rx="8" fill="#b07a4c"/>
          <rect x="24" y="226" width="142" height="196" rx="4" fill="#8f5f3a"/>
          <rect x="24" y="310" width="142" height="10" fill="#b07a4c" style="stroke-width:3"/>
          ${books(30, 310, ['#b98ce6', '#fffdf5', '#8fb7e8', '#f28c6b', '#c9a074', '#6c9a5e'], 76)}
          <rect x="34" y="330" width="122" height="82" rx="4" fill="#a8703f"/><circle cx="95" cy="370" r="5" fill="#2b2b2b"/>`) +
        piece('ds-sidecab', '0 40 300 260', 'left:8px;bottom:14px;height:104px', `
          <rect x="10" y="150" width="180" height="140" rx="8" fill="#7a6a86"/>
          ${rep(2, i => `<rect x="24" y="${164 + i * 62}" width="152" height="50" rx="5" fill="#90819e"/><rect x="86" y="${184 + i * 62}" width="28" height="8" rx="4" fill="#2b2b2b" style="stroke-width:2"/>`)}
          <path d="M60 150 V110 L100 60" fill="none" style="stroke:#e8946b;stroke-width:6"/>
          <path class="ds-glow" d="M86 48 l36 -16 l14 30 l-34 12Z" fill="#f28c6b"/>
          <path d="M40 150 h50" style="stroke-width:6"/>
          <path d="M215 290 h70 l-8 -50 h-54Z" fill="#fffdf5"/>
          <path d="M250 240 q-30 -50 0 -90 q20 40 0 90 M250 240 q20 -60 44 -66 q-10 50 -44 66 M250 240 q-34 -24 -44 -66 q34 16 44 66" fill="#6c9a5e"/>`, { emit: true })
    },

    music: {
      label: 'Music room',
      wall: 'linear-gradient(180deg, #ecd9ee 0%, #e2cbe6 100%)',
      floor: '#8e7fa3', top: fairyLights,
      // a framed record, and the hanging plant beside it where it can be seen
      band: () =>
        piece('ds-band', '0 0 200 200', '', `
          <rect x="10" y="10" width="180" height="180" rx="6" fill="#fffdf5"/>
          <circle cx="100" cy="100" r="70" fill="#2b2b2b"/>
          <g fill="none" style="stroke:#4a4a4a;stroke-width:2"><circle cx="100" cy="100" r="58"/><circle cx="100" cy="100" r="46"/><circle cx="100" cy="100" r="34"/></g>
          <circle cx="100" cy="100" r="20" fill="#ff6f9c"/><circle cx="100" cy="100" r="4" fill="#fffdf5" style="stroke-width:2"/>`) +
        piece('ds-band', '30 0 140 330', '', `
          <path d="M100 0 V96" style="stroke-width:2.5"/>
          <path d="M60 96 h80 l-10 46 h-60Z" fill="#f28c6b"/>
          <path d="M70 136 C 50 186, 80 226, 60 296 M130 136 C 150 196, 120 236, 140 276 M100 142 C 104 196, 90 226, 100 256" fill="none" style="stroke:#5f9a57;stroke-width:3"/>
          ${leafy([[66, 166, 30], [58, 212, -30], [70, 256, 40], [62, 288, -20], [140, 172, -30], [128, 216, 20], [142, 260, -40], [98, 190, 60], [96, 236, -50], [80, 88, -30], [120, 86, 30]])}`),
      pieces: () =>
        piece('ds-notes-l', '0 0 120 300', 'top:34%;left:4px;height:min(30%,220px)', notes([[20, 60, 34, 1], [70, 140, 26, 2], [24, 230, 30, 3]])) +
        piece('ds-notes-r', '0 0 120 300', 'top:44%;right:6px;height:min(26%,190px)', notes([[60, 50, 30, 2], [20, 150, 26, 1], [70, 250, 32, 4]])) +
        piece('ds-mshelf', '0 0 270 170', 'top:34px;right:10px;height:70px', `
          <rect x="0" y="140" width="270" height="12" rx="3" fill="#a07a58"/>
          <rect x="16" y="64" width="60" height="76" rx="6" fill="#3b3b44"/><circle cx="46" cy="114" r="16" fill="#6b6f78"/><circle cx="46" cy="84" r="7" fill="#6b6f78"/>
          ${books(96, 140, ['#ff6f9c', '#8fb7e8', '#ffd166', '#6c9a5e'], 66)}
          <path d="M190 140 h50 l-6 -30 h-38Z" fill="#e8946b"/>
          ${leafy([[204, 98, -40], [222, 92, 30], [214, 78, -10], [196, 84, 20]])}`) +
        piece('ds-bigplant', '0 60 230 270', 'left:6px;bottom:12px;height:110px', `
          <path d="M70 330 l-8 -80 h106 l-8 80Z" fill="#4a4a4a"/>
          <path d="M115 250 C 60 200, 40 120, 70 60 C 100 120, 110 190, 115 250Z M115 250 C 150 190, 190 150, 210 90 C 180 160, 150 210, 115 250Z M115 250 C 100 170, 130 90, 150 30 C 150 120, 130 190, 115 250Z M115 250 C 70 230, 30 200, 10 150 C 60 170, 90 210, 115 250Z" fill="#6c9a5e"/>`) +
        piece('ds-tripod', '0 60 230 210', 'right:10px;bottom:12px;height:96px', `
          <path d="M150 120 L110 262 M150 120 L190 262 M150 120 V262" style="stroke-width:5"/>
          <rect x="120" y="70" width="60" height="50" rx="8" fill="#4a4a4a"/><circle cx="150" cy="95" r="14" fill="#8fb7e8"/>
          <rect x="10" y="150" width="80" height="112" rx="8" fill="#3b3b44"/><circle cx="50" cy="222" r="24" fill="#6b6f78"/><circle cx="50" cy="176" r="10" fill="#6b6f78"/>`)
    },

    night: {
      label: 'Cool-blue den',
      wall: 'linear-gradient(180deg, #b4c1e8 0%, #a5b3df 100%)',
      floor: '#7f72bd',
      // the frosty window, moonlit, with pines outside
      band: () => piece('ds-band', '0 0 300 236', '', `
        <rect x="10" y="10" width="280" height="206" rx="6" fill="#fffdf5"/>
        <rect class="ds-glass" x="26" y="26" width="248" height="174" fill="#def5f4"/>
        <circle cx="220" cy="70" r="18" fill="#fffef0" stroke="none"/>
        <g stroke="none" fill="#7cc3b5"><path d="M50 200 l26 -100 l26 100Z"/><path d="M120 200 l18 -70 l18 70Z" opacity=".8"/><path d="M190 200 l24 -116 l24 116Z"/><path d="M240 200 l14 -52 l14 52Z" opacity=".8"/></g>
        <path d="M150 26 V200 M26 113 H274" style="stroke:#fffdf5;stroke-width:10"/>
        <rect x="0" y="212" width="300" height="14" rx="3" fill="#e6e8f2"/>`, { emit: true }),
      pieces: () =>
        piece('ds-floats', '0 0 220 380', 'top:56px;right:8px;height:min(46%,330px)', `
          ${rep(3, i => `<rect x="20" y="${110 + i * 120}" width="190" height="12" rx="3" fill="#fffdf5"/>`)}
          ${books(40, 110, ['#5d6fd6', '#a85a5a', '#fffdf5'], 70)}
          <g transform="translate(140 64)"><rect width="44" height="44" rx="4" fill="#ffd166"/><path d="M15 0 V44 M29 0 V44 M0 15 H44 M0 29 H44" style="stroke-width:2"/><rect x="1" y="1" width="14" height="14" fill="#ff6f9c" stroke="none"/><rect x="29" y="29" width="14" height="14" fill="#5d6fd6" stroke="none"/></g>
          ${books(110, 230, ['#8fb7e8', '#a85a5a', '#6c9a5e', '#fffdf5'], 70)}
          <path d="M50 350 l14 -40 h24 l14 40Z" fill="#3b3b44"/><circle cx="76" cy="300" r="12" fill="#3b3b44"/>`) +
        piece('ds-lowcase', '0 110 220 130', 'left:8px;bottom:14px;height:84px', `
          <rect x="10" y="20" width="200" height="214" rx="8" fill="#fffdf5"/>
          <rect x="10" y="122" width="200" height="10" fill="#e6e8f2" style="stroke-width:3"/>
          ${books(30, 224, ['#5d6fd6', '#fffdf5', '#a85a5a', '#ffd166'], 80)}
          <rect x="128" y="170" width="66" height="54" rx="4" fill="#cfd5ea"/>`) +
        // the yellow chair, angled toward the room
        piece('ds-chair', '0 0 240 250', 'right:16px;bottom:12px;height:104px', `
          <path d="M70 20 h110 l18 120 h-146Z" fill="#ffc94a"/>
          <path d="M78 34 h94 l12 92 h-118Z" fill="#ffd774" style="stroke-width:3"/>
          <path d="M34 140 h176 l-12 42 h-152Z" fill="#ffd774"/>
          <path d="M122 182 V214 M78 244 L122 214 L166 244" style="stroke-width:7"/>
          <circle cx="78" cy="244" r="6" fill="#2b2b2b"/><circle cx="166" cy="244" r="6" fill="#2b2b2b"/>`)
    },

    neon: {
      label: 'Neon synth studio', mood: 'neon',
      wall: 'radial-gradient(ellipse at 50% 30%, #2a1f31 0%, #1b1622 60%, #120e17 100%)',
      floor: '#100d14', top: neonTube,
      pieces: () =>
        // the bottom of the rack: two units of blinking LEDs and the keys on top
        piece('ds-rack', '0 166 240 200', 'left:0;bottom:14px;height:104px', `
          ${rep(2, j => { const i = j + 2;
            return `<rect x="10" y="${20 + i * 74}" width="190" height="64" rx="6" fill="#2a2630"/>` +
              rep(6, k => `<circle class="ds-led" style="animation-delay:-${(i * 6 + k) * 0.37 % 2}s" cx="${32 + k * 26}" cy="${42 + i * 74}" r="5" fill="${['#ff4f86', '#5ee7f0', '#ffd166'][(i + k) % 3]}" style="stroke-width:1.5"/>`) +
              `<rect x="26" y="${60 + i * 74}" width="150" height="10" rx="3" fill="#3b3443" style="stroke-width:2"/>`; })}
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
      // the floor goes down first, so every prop stands on it rather than in it
      `<div class="ds-floor" style="background:${r.floor}"></div>` +
      '<svg class="if-svg ds-piece ds-top" xmlns="http://www.w3.org/2000/svg"></svg>' +
      // the clock and the poster, in the band beside the greeting — hung
      // before the props, so the hanging plants trail in front of them
      piece('ds-wallart', '1080 25 365 255', 'top:26px;left:50%;height:112px', `
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
      this.applyPoster();
      if (this._wired) return;
      this._wired = true;
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
        view.classList.remove('dash-poster-hot'); view.title = '';
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
    place() {
      if (!this.layer) return;
      const r = document.getElementById('view').getBoundingClientRect();
      Object.assign(this.layer.style, { top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' });
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
       Edit button. The group scales down to fit a narrow gap; when even that
       won't do, the room's pieces come down first, then the clock and
       poster too. */
    hangArt(vr) {
      const art = this.layer.querySelector('.ds-wallart');
      const extras = [...this.layer.querySelectorAll('.ds-band')];
      const all = [art].concat(extras);
      const hi = document.querySelector('.dash-hello > :first-child');
      const tools = document.querySelector('.dash-tools');
      all.forEach(n => { n.style.display = 'none'; });
      if (!hi) return;
      const a = hi.getBoundingClientRect(), right = tools ? tools.getBoundingClientRect().left : vr.right - 46;
      const gap = right - a.right - 32, GAP = 22, MAX = 112, MIN = 64;
      const aspect = n => { const v = n.getAttribute('viewBox').split(' ').map(Number); return v[2] / v[3]; };
      let show = all.slice(), h = 0;
      while (show.length) {
        h = Math.min(MAX, (gap - GAP * (show.length - 1)) / show.reduce((t, n) => t + aspect(n), 0));
        if (h >= MIN) break;
        show.pop();
      }
      if (!show.length) return;
      const width = show.reduce((t, n) => t + aspect(n) * h, 0) + GAP * (show.length - 1);
      // the room's piece first, then the clock and poster — the poster stays nearest the middle
      const order = show.slice(1).concat(show[0]);
      let x = a.right - vr.left + 16 + (gap - width) / 2;
      const top = Math.max(26, a.top - vr.top + a.height - h);
      order.forEach(n => {
        Object.assign(n.style, { display: '', height: h + 'px', left: x + 'px', top: top + 'px' });
        x += aspect(n) * h + GAP;
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
