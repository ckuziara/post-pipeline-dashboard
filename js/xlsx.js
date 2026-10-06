/* A small .xlsx reader — values, cell fill colours and merges, nothing else.

   Why not a library: the app has no build step, and the colour of a cell is
   the whole point here. A production schedule kept in a spreadsheet draws its
   bars by filling cells; a CSV export throws that away, and the free builds
   of the usual libraries don't read fills either. An .xlsx is a zip of XML,
   so this unzips with the browser's own DecompressionStream and pulls the
   few parts it needs out with regular expressions (no DOMParser, so the same
   code runs under Node for tests).

   App.xlsxReader.open(arrayBuffer) → Promise<book>
     book.sheets            [{ name, hidden }] in workbook order
     book.sheet(name)       → Promise<{ name, cells, rows, cols, merges, hiddenRows }>
       cells  Map "r,c" → { v, fill }   r and c are 0-based
              v is a string, or a number for numeric cells
              fill is "#rrggbb" or null (no fill, or a non-solid pattern)
   Conditional formatting colours aren't read — only the fills set on cells. */
(function (root) {
  'use strict';
  const App = root.App = root.App || {};

  /* ---------------- zip ---------------- */
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }

  function zipEntries(buf) {
    const b = new Uint8Array(buf);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('That file isn’t an .xlsx workbook');
    const count = u16(b, eocd + 10);
    let p = u32(b, eocd + 16);
    const out = {};
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (u32(b, p) !== 0x02014b50) break;
      const method = u16(b, p + 10), csize = u32(b, p + 20);
      const nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32);
      const local = u32(b, p + 42);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
      out[name] = { method, csize, local };
      p += 46 + nlen + xlen + clen;
    }
    return { b, entries: out };
  }

  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readEntry(zip, name) {
    const e = zip.entries[name];
    if (!e) return null;
    const b = zip.b, o = e.local;
    const start = o + 30 + u16(b, o + 26) + u16(b, o + 28);
    const raw = b.subarray(start, start + e.csize);
    const bytes = e.method === 0 ? raw : await inflate(raw);
    return new TextDecoder().decode(bytes);
  }

  /* ---------------- xml bits ---------------- */
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unesc(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENT[e] != null ? ENT[e] : m;
    });
  }
  function attrs(s) {
    const a = {};
    s.replace(/([\w:]+)\s*=\s*"([^"]*)"/g, (m, k, v) => { a[k] = unesc(v); return m; });
    return a;
  }
  // the text of every <t> in a run, phonetic hints (<rPh>) left out
  function textOf(xml) {
    let s = '';
    xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g, (m, t) => { s += t ? unesc(t) : ''; return m; });
    return s;
  }
  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + c - 64;
    }
    return n - 1;
  }
  function parseRef(ref) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    return m ? { r: +m[2] - 1, c: colIndex(m[1]) } : null;
  }

  /* ---------------- colour ---------------- */
  // Excel's legacy indexed palette (0–63); 64/65 are system fg/bg
  const INDEXED = ('000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
    '800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF ' +
    '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 ' +
    '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333').split(' ');

  function applyTint(hex, tint) {
    if (!tint) return hex;
    let r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
    const hue = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    if (s === 0) { r = g = b = l; } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
    }
    const x = (v) => ('0' + Math.round(v * 255).toString(16)).slice(-2);
    return (x(r) + x(g) + x(b)).toUpperCase();
  }

  function themeColours(xml) {
    // clrScheme order: dk1 lt1 dk2 lt2 accent1–6 hlink folHlink.
    // Excel's theme index swaps the first two pairs: 0=lt1 1=dk1 2=lt2 3=dk2.
    const m = /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/.exec(xml || '');
    if (!m) return [];
    const list = [];
    m[0].replace(/<a:(dk1|lt1|dk2|lt2|accent\d|hlink|folHlink)>([\s\S]*?)<\/a:\1>/g, (all, k, inner) => {
      const c = /srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(inner) || /lastClr="([0-9A-Fa-f]{6})"/.exec(inner);
      list.push(c ? c[1].toUpperCase() : '000000');
      return all;
    });
    return [list[1], list[0], list[3], list[2]].concat(list.slice(4));
  }

  function colourOf(a, theme) {
    if (!a) return null;
    let hex = null;
    if (a.rgb) hex = a.rgb.slice(-6).toUpperCase();
    else if (a.theme != null && theme[+a.theme]) hex = theme[+a.theme];
    else if (a.indexed != null && INDEXED[+a.indexed]) hex = INDEXED[+a.indexed];
    if (!hex) return null;
    return '#' + applyTint(hex, a.tint ? parseFloat(a.tint) : 0);
  }

  function parseStyles(xml, theme) {
    const fills = [];
    const fm = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(xml || '');
    if (fm) fm[1].replace(/<fill>([\s\S]*?)<\/fill>|<fill\/>/g, (m, inner) => {
      let col = null;
      const pf = /<patternFill\b([^>]*?)(?:\/>|>([\s\S]*?)<\/patternFill>)/.exec(inner || '');
      if (pf) {
        const pa = attrs(pf[1]);
        if (pa.patternType && pa.patternType !== 'none') {
          const fg = /<fgColor\b([^>]*)\/?>/.exec(pf[2] || '');
          col = colourOf(fg ? attrs(fg[1]) : null, theme);
        }
      }
      fills.push(col);
      return m;
    });
    const xfFill = [];
    const xm = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml || '');
    if (xm) xm[1].replace(/<xf\b([^>]*?)(?:\/>|>)/g, (m, a) => { xfFill.push(fills[+(attrs(a).fillId || 0)] || null); return m; });
    return xfFill;
  }

  /* ---------------- workbook ---------------- */
  async function open(buf) {
    const zip = zipEntries(buf);
    const [wb, rels, sst, styles, theme] = await Promise.all([
      readEntry(zip, 'xl/workbook.xml'), readEntry(zip, 'xl/_rels/workbook.xml.rels'),
      readEntry(zip, 'xl/sharedStrings.xml'), readEntry(zip, 'xl/styles.xml'), readEntry(zip, 'xl/theme/theme1.xml')
    ]);
    if (!wb) throw new Error('That file isn’t an .xlsx workbook');
    const target = {};
    (rels || '').replace(/<Relationship\b([^>]*)\/?>/g, (m, a) => { const x = attrs(a); target[x.Id] = x.Target; return m; });
    const sheets = [];
    wb.replace(/<sheet\b([^>]*)\/?>/g, (m, a) => {
      const x = attrs(a);
      let t = target[x['r:id']] || '';
      t = t.charAt(0) === '/' ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
      sheets.push({ name: x.name, hidden: !!x.state && x.state !== 'visible', path: t });
      return m;
    });
    const strings = [];
    (sst || '').replace(/<si>([\s\S]*?)<\/si>|<si\/>/g, (m, inner) => { strings.push(inner ? textOf(inner) : ''); return m; });
    const xfFill = parseStyles(styles, themeColours(theme));

    async function sheet(name) {
      const s = sheets.find(x => x.name === name);
      if (!s) throw new Error('No sheet called “' + name + '”');
      const xml = await readEntry(zip, s.path);
      if (!xml) throw new Error('Couldn’t read the sheet “' + name + '”');
      const cells = new Map();
      const hiddenRows = new Set();
      let rows = 0, cols = 0;
      xml.replace(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, (rm, ra, inner) => {
        const rowA = attrs(ra);
        const rIdx = rowA.r ? +rowA.r - 1 : rows;
        if (rowA.hidden === '1' || rowA.hidden === 'true') hiddenRows.add(rIdx);
        rows = Math.max(rows, rIdx + 1);
        let next = 0;
        (inner || '').replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (cm, ca, cin) => {
          const a = attrs(ca);
          const c = a.r ? colIndex(a.r) : next;
          next = c + 1;
          let v = null;
          if (cin) {
            if (a.t === 'inlineStr') v = textOf(cin);
            else {
              const vm = /<v>([\s\S]*?)<\/v>/.exec(cin);
              if (vm) {
                const raw = unesc(vm[1]);
                if (a.t === 's') v = strings[+raw] != null ? strings[+raw] : '';
                else if (a.t === 'str' || a.t === 'e') v = raw;
                else if (a.t === 'b') v = raw === '1' ? 'TRUE' : 'FALSE';
                else v = isFinite(+raw) ? +raw : raw;
              }
            }
          }
          if (typeof v === 'string' && !v.trim()) v = null;
          const fill = xfFill[+(a.s || 0)] || null;
          if (v == null && !fill) return cm;
          cells.set(rIdx + ',' + c, { v, fill });
          cols = Math.max(cols, c + 1);
          return cm;
        });
        return rm;
      });
      const merges = [];
      xml.replace(/<mergeCell\b([^>]*)\/?>/g, (m, a) => {
        const [x, y] = (attrs(a).ref || '').split(':');
        const p = parseRef(x), q = parseRef(y || x);
        if (p && q) merges.push({ r0: p.r, c0: p.c, r1: q.r, c1: q.c });
        return m;
      });
      // a merged block shows its top-left value and fill across every cell
      merges.forEach(mg => {
        const tl = cells.get(mg.r0 + ',' + mg.c0);
        if (!tl) return;
        for (let r = mg.r0; r <= mg.r1; r++) for (let c = mg.c0; c <= mg.c1; c++) {
          if (r === mg.r0 && c === mg.c0) continue;
          const k = r + ',' + c, cur = cells.get(k);
          cells.set(k, { v: null, fill: (cur && cur.fill) || tl.fill, merged: true });
        }
      });
      return { name, cells, rows, cols, merges, hiddenRows };
    }

    return { sheets: sheets.map(s => ({ name: s.name, hidden: s.hidden })), sheet };
  }

  App.xlsxReader = { open };
})(typeof window !== 'undefined' ? window : globalThis);
