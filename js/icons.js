/* Icon set — replaces the emoji the app used to lean on.

   Why not emoji: they render as each OS's own artwork (Apple's glossy colour
   set on a Mac, something else entirely on Windows), so they never matched the
   theme, they carry colour we can't control, and at 12–14px several of them
   (🗂 vs 🗄, 🎚 vs 🎛) are indistinguishable.

   These are one geometric line set drawn on a 24×24 grid, stroked in
   currentColor, so an icon inherits the colour of whatever it sits in. The
   three knobs below are themed in style.css, which is how the SAME icon reads
   correctly in every skin:
     --icon-stroke  weight   (thin for Bookshop, heavy for Wireframe)
     --icon-cap     linecap  (round normally, butt for Wireframe)
     --icon-join    linejoin (round normally, miter for Wireframe)

   Usage:  App.icon('clapper')            → a <span class="ico"> node
           App.icon('warn', { size: 16 }) → override the 1em default
   Anywhere a string is expected, App.iconHTML(name) gives the raw markup. */
window.App = window.App || {};
(function () {
  'use strict';

  // Each entry is the inner markup of a 24×24 viewBox. Keep shapes simple —
  // they have to stay legible at 12px in the timeline's label rail.
  const P = {
    /* ---- production / departments ---- */
    // NB: write the stripes with explicit relative `l` commands — a bare
    // "M13 5-14 9.6" parses the minus as a separator and flings the line
    // off-canvas, which is exactly what broke this icon the first time.
    clapper:  '<path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z"/>' +
              '<path d="M3.3 8.9 4.7 4.3a1 1 0 0 1 1.2-.7l12.6 2.5a1 1 0 0 1 .8 1.2L19 9"/>' +
              '<path d="M8.2 4.2 l-1.1 4.6 M12.7 5.1 l-1.1 4.6 M17.2 6 l-1.1 4.6"/>',
    film:     '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    camera:   '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h9A1.5 1.5 0 0 1 15 7.5v9A1.5 1.5 0 0 1 13.5 18h-9A1.5 1.5 0 0 1 3 16.5v-9Z"/><path d="m15 10.5 5-3v9l-5-3z"/>',
    music:    '<path d="M9 18V6.5l10-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><path d="M4 14h2.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5Z"/><path d="M20 14h-2.5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1H19a1 1 0 0 0 1-1v-5Z"/>',
    piano:    '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v8M12 5v8M16 5v8M3 13h18"/>',
    sliders:  '<path d="M5 4v6M5 14v6M12 4v9M12 17v3M19 4v3M19 11v9"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="15" r="2"/><circle cx="19" cy="9" r="2"/>',
    palette:  '<path d="M12 3a9 9 0 0 0 0 18 2.4 2.4 0 0 0 2.4-2.4c0-1.3-1-1.9-1-3 0-.9.7-1.6 1.6-1.6H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z"/><circle cx="8" cy="9" r="1.2"/><circle cx="12.5" cy="7" r="1.2"/><circle cx="7.5" cy="14" r="1.2"/>',
    pencil:   '<path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m14.5 5.5 4 4"/>',
    target:   '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
    compass:  '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5.5-5.5 2 2-5.5 5.5-2Z"/>',
    chart:    '<path d="M4 20h16"/><path d="M7 20v-6M12 20V6M17 20v-9"/>',
    grid:     '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    tools:    '<path d="M14.5 5.5a3.5 3.5 0 0 1 4.7 4.7L18 9l-2 2-2-2 2-2-1.5-1.5Z"/><path d="m13 11-8 8 2.5 2.5 8-8"/><path d="M4.5 6.5 7 4l3.5 3.5L8 10 4.5 6.5Z"/>',
    // a plain square reads as nothing; the two interlocking tabs are what
    // makes it legible as a puzzle piece at 14px
    puzzle:   '<rect x="4" y="4" width="16" height="16" rx="2"/>' +
              '<path d="M12 4v4.2a1.8 1.8 0 1 1 0 3.6V20"/><path d="M4 12h4.2a1.8 1.8 0 1 0 3.6 0"/>',

    /* ---- people / access ---- */
    users:    '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.4a3.2 3.2 0 0 1 0 6.2M17 14.4a6 6 0 0 1 4 5.6"/>',
    key:      '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M17 12v3.5M20 12v2.5"/>',
    lock:     '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2.5"/>',
    unlock:   '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 7.5-2"/><path d="M12 14.5v2.5"/>',
    plug:     '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z"/><path d="M12 17v4"/>',

    /* ---- files / storage ---- */
    folder:   '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4L11 8.5h8.5A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V7.5Z"/>',
    folderOpen: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4L11 8.5h8.5A1.5 1.5 0 0 1 21 10v1H3V7.5Z"/><path d="M3 11h18l-1.7 7.6a1.5 1.5 0 0 1-1.5 1.2H6.2a1.5 1.5 0 0 1-1.5-1.2L3 11Z"/>',
    archive:  '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 13h4"/>',
    file:     '<path d="M6 3.5h7L19 9v11.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z"/><path d="M13 3.5V9h6"/>',
    note:     '<path d="M6 3.5h7L19 9v11.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z"/><path d="M13 3.5V9h6M8.5 13h7M8.5 17h4"/>',
    paperclip: '<path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.8 1.8 0 0 1-2.5-2.5l7-7"/>',
    image:    '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="10" r="1.8"/><path d="m3.5 17.5 5-4.5 4 3.5 3-2.5 5 4"/>',
    link:     '<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.5 1.5"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5L12 17"/>',
    save:     '<path d="M4 5.5a1.5 1.5 0 0 1 1.5-1.5h10L20 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Z"/><path d="M8 4v5h8V6M8 20v-5h8v5"/>',
    upload:   '<path d="M12 16V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4 15v4a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-4"/>',
    download: '<path d="M12 4v12"/><path d="m7.5 11.5 4.5 4.5 4.5-4.5"/><path d="M4 15v4a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-4"/>',
    trash:    '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 20l1-13"/><path d="M10 11v6M14 11v6"/>',
    package:  '<path d="m12 3 9 4.5v9L12 21 3 16.5v-9L12 3Z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
    book:     '<path d="M4 5a2 2 0 0 1 2-2h5v18H6a2 2 0 0 1-2-2V5Z"/><path d="M20 5a2 2 0 0 0-2-2h-5v18h5a2 2 0 0 0 2-2V5Z"/>',
    scroll:   '<path d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6"/><path d="M6 4a2 2 0 0 0 0 4h2V4H6ZM6 20a2 2 0 0 0 0-4h2v4H6Z"/><path d="M11 9h5M11 13h5"/>',
    search:   '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/>',
    tag:      '<path d="M4 11V5a1 1 0 0 1 1-1h6l9 9-7 7-9-9Z"/><circle cx="8" cy="8" r="1.4"/>',
    pipeline: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="12" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8.5 6h4a3 3 0 0 1 3 3v.5M15.5 14.5V15a3 3 0 0 1-3 3h-4"/>',
    calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/>',
    hourglass: '<path d="M7 3h10M7 21h10"/><path d="M8 3v3.5c0 2 4 3.7 4 5.5s-4 3.5-4 5.5V21M16 3v3.5c0 2-4 3.7-4 5.5s4 3.5 4 5.5V21"/>',
    sparkle:  '<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9L4.5 10.8 10.2 9 12 3.5Z"/><path d="M18.5 16.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z"/>',

    /* ---- state / risk. These are shape-coded, never colour-coded, so they
       stay legible against every theme and don't compete with the status
       palette (which is the app's one reserved colour language). ---- */
    warn:     '<path d="M12 4.5 21 19.5H3L12 4.5Z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.4" r=".9" fill="currentColor" stroke="none"/>',
    blocked:  '<circle cx="12" cy="12" r="8.5"/><path d="M7.5 12h9"/>',
    bolt:     '<path d="M13.5 3 5.5 14h5l-1 7 8-11h-5l1-7Z"/>',
    checkBadge: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.2 2.7 2.8L16 9.5"/>',
    // hub + rim + eight teeth. Without the rim this reads as a sun/brightness
    // control rather than a cog.
    gear:     '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.2"/>' +
              '<path d="M12 4.8V3M12 21v-1.8M4.8 12H3M21 12h-1.8' +
              'M6.9 6.9 5.6 5.6M18.4 18.4l1.3 1.3M6.9 17.1 5.6 18.4M18.4 5.6l1.3-1.3"/>'
  };
  // aliases so call sites can use the name that reads best where they are
  P.show = P.clapper; P.video = P.camera; P.audio = P.headphones;
  P.mixer = P.sliders; P.doc = P.file; P.files = P.folder;

  App.ICONS = P;

  App.iconHTML = function (name, opts) {
    const d = P[name];
    if (!d) return '';
    const o = opts || {};
    const size = o.size ? o.size + 'px' : '1em';
    return '<svg class="ico-svg" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" ' +
      'fill="none" stroke="currentColor" aria-hidden="true" focusable="false">' + d + '</svg>';
  };

  // Returns a span so the icon can sit inline next to text and inherit colour;
  // callers that need a bare string use iconHTML.
  App.icon = function (name, opts) {
    const o = opts || {};
    const span = document.createElement('span');
    span.className = 'ico' + (o.cls ? ' ' + o.cls : '');
    span.innerHTML = App.iconHTML(name, o);
    if (o.title) span.title = o.title;
    return span;
  };
})();
