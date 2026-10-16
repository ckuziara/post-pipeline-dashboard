/* QC Report — the spreadsheet QC fills in for one check, made alongside the
   QC project by Create QC Project (POST /api/task/qc-project).

   templates/qc-report.xlsx is the studio's QC report form with nothing in
   it: every label, guideline, colour rule (PASS / FLAG / FAIL / FIXED) and
   dropdown kept, no example data, no logo — the studio's logo and report
   title are form branding, set in Admin and added here (qcbranding.js).
   This fills in what the board already knows — show, content code, date,
   QC operator, the task and its QC version, and the files that were
   delivered — and leaves the QC results and notes for QC.

   No spreadsheet library: an .xlsx is a zip of XML, so this reads the
   template's parts, rewrites two of them, and zips them back up. Every value
   goes in as an inline string (escaped), into a cell the template already
   styles, so nothing a board value contains can become markup. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const branding = require('./qcbranding');
const naming = require('./js/naming.js');

const TEMPLATE = path.join(__dirname, 'templates', 'qc-report.xlsx');

/* ---------------------------------------------------------------- zip */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// [{ name, data }] in the archive's own order
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(start, start + csize);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function writeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  // a fixed timestamp (1 Jan 2020): the file's own mtime says when it was made
  const time = 0, date = ((2020 - 1980) << 9) | (1 << 5) | 1;
  entries.forEach(({ name, data }) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}

/* --------------------------------------------------------------- cells */
const esc = (s) => String(s == null ? '' : s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cellRe = (ref) => new RegExp('<c r="' + ref + '"((?:\\s+[\\w:]+="[^"]*")*)\\s*(?:/>|>[\\s\\S]*?</c>)');
/* Write one cell, keeping its style. value: a string (inline string), a
   number, or null to empty it. A cell the template doesn't have is left
   alone — the template has every cell this writes. */
function setCell(xml, ref, value) {
  return xml.replace(cellRe(ref), (m, a) => {
    const attrs = a.replace(/\s+t="[^"]*"/, '');
    if (value == null || value === '') return '<c r="' + ref + '"' + attrs + '/>';
    if (typeof value === 'number') return '<c r="' + ref + '"' + attrs + '><v>' + value + '</v></c>';
    return '<c r="' + ref + '"' + attrs + ' t="inlineStr"><is><t xml:space="preserve">' + esc(value) + '</t></is></c>';
  });
}

// Excel's day number for a date (1900 system)
const excelDate = (d) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 864e5);

const VIDEO = ['mov', 'mp4', 'mxf', 'm4v', 'avi', 'mkv', 'r3d', 'braw'];
/* The Assets column: what each file is by the naming convention — "ACA" for
   EMWW0103_ACA.wav (Admin → Workflow → Naming Conventions; see js/naming.js).
   A name ending in no known suffix is flagged on the row instead: UNKNOWN in
   Assets, FLAG in QC Result (the form colours it) and the reason in Summary
   of QC. All three are QC's to change. */
const OFF_CONVENTION = 'File name doesn’t follow the naming convention: no known suffix';
/* File names have no spaces, and Excel only wraps at spaces and hyphens, so a
   long one ran off the edge of the File Name column. An invisible break
   (zero-width space) after each underscore lets it wrap there, and the row is
   made tall enough for the lines it takes. The column is 24.5 characters wide;
   lines are packed the way Excel will, part by part. */
const FILE_COL_CHARS = 24;
const ZWSP = '\u200b';
function wrapName(name) {
  const parts = String(name).split(/(?<=_)/);
  let lines = 1, len = 0;
  parts.forEach(p => {
    if (len && len + p.length > FILE_COL_CHARS) { lines++; len = 0; }
    len += p.length;
    while (len > FILE_COL_CHARS) { lines++; len -= FILE_COL_CHARS; }   // a part longer than a line breaks anywhere
  });
  return { text: parts.join(ZWSP), lines };
}
function fitRow(s, r, lines) {
  const need = lines * 14.5 + 8;                       // 11pt Arial lines, plus the cell's padding
  return s.replace(new RegExp('(<row r="' + r + '"[^>]*?) ht="([\\d.]+)"'), (m, head, ht) =>
    head + ' ht="' + Math.max(+ht, need) + '"');
}
function assetRow(s, r, name, suffixes, cols) {
  const hit = naming.assetSuffix(name, suffixes);
  const w = wrapName(name);
  s = setCell(s, 'B' + r, hit || 'UNKNOWN');
  s = setCell(s, 'C' + r, w.text);
  s = fitRow(s, r, w.lines);
  if (!hit) {
    s = setCell(s, cols.summary + r, OFF_CONVENTION);
    s = setCell(s, cols.result + r, 'FLAG');
  }
  return s;
}

/* The hidden QCdropdownlists sheet: the form's dropdowns read their choices
   from it. IP and QC Operator come from the board (its shows, and the QC
   team); the rest are the form's own fixed lists. Column letters and ranges
   match the template's validations (A2:A40, B2:B15, E2:E7, F2:F3, G2:G6,
   H2:H4, I2:I7). */
function listsSheet(base, ips, operators) {
  const cols = {
    A: ['IP'].concat(ips.slice(0, 39)),
    B: ['QC Operator'].concat(operators.slice(0, 14)),
    E: ['Version', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'],
    F: ['Audio', 'Mono', 'Stereo'],
    G: ['FPS', '23.98 fps', '24 fps', '25 fps', '29.97 fps', '30 fps'],
    H: ['Field', 'PROGRESSIVE', 'INTERLACED', 'N/A'],
    I: ['Status', 'PASS', 'FAIL', 'N/A', 'MISSING', 'FLAG', 'FIXED']
  };
  const rows = Math.max(...Object.values(cols).map(c => c.length));
  let data = '<sheetData>';
  for (let r = 1; r <= rows; r++) {
    const cells = Object.keys(cols).filter(k => cols[k][r - 1] != null && cols[k][r - 1] !== '')
      .map(k => '<c r="' + k + r + '" t="inlineStr"><is><t xml:space="preserve">' + esc(cols[k][r - 1]) + '</t></is></c>').join('');
    if (cells) data += '<row r="' + r + '">' + cells + '</row>';
  }
  data += '</sheetData>';
  return base.replace(/<sheetData>[\s\S]*?<\/sheetData>|<sheetData\/>/, data);
}

/* info: {
     show, contentCode, operator, date (Date), task, version (n),
     files: [names delivered], ips: [show names], operators: [QC people],
     suffixes: [the naming convention's suffix codes] (optional — the defaults),
     branding: { logo: data URL, title } (optional — data.formBranding)
   } → the finished .xlsx as a Buffer */
function build(info) {
  const parts = readZip(fs.readFileSync(TEMPLATE));
  const get = (n) => parts.find(p => p.name === n);
  const v = 'V' + (info.version || 1);
  const suffixes = Array.isArray(info.suffixes) && info.suffixes.length ? info.suffixes : naming.namingSuffixes(null);

  let s = get('xl/worksheets/sheet1.xml').data.toString('utf8');
  s = setCell(s, 'A1', branding.titleFor(info.branding, info.show) || (info.show ? info.show + ' ' : '') + 'QC Report');
  s = setCell(s, 'E3', info.show || '');
  s = setCell(s, 'H3', excelDate(info.date || new Date()));
  s = setCell(s, 'E4', info.contentCode || '');
  s = setCell(s, 'H4', info.operator || '');

  // Assets: one row per delivered file (8 rows on the form)
  const files = (info.files || []).slice(0, 8);
  if (!files.length) s = setCell(s, 'B7', info.task || '');
  files.forEach((f, i) => {
    const r = 7 + i;
    s = assetRow(s, r, f, suffixes, { summary: 'E', result: 'F' });
    s = setCell(s, 'D' + r, v);
  });
  // Vidchecker: the video files (2 rows on the form)
  files.filter(f => VIDEO.includes(String(f).split('.').pop().toLowerCase())).slice(0, 2).forEach((f, i) => {
    // here the summary is D (merged across D:E)
    s = assetRow(s, 17 + i, f, suffixes, { summary: 'D', result: 'F' });
  });
  s = setCell(s, 'G32', v);
  get('xl/worksheets/sheet1.xml').data = Buffer.from(s, 'utf8');

  const l = get('xl/worksheets/sheet2.xml');
  l.data = Buffer.from(listsSheet(l.data.toString('utf8'), info.ips || [], info.operators || []), 'utf8');

  const core = get('docProps/core.xml');
  if (core) {
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    core.data = Buffer.from(core.data.toString('utf8')
      .replace(/<dc:title>[\s\S]*?<\/dc:title>/, '')
      .replace(/(<dcterms:created[^>]*>)[^<]*/, '$1' + now)
      .replace(/(<dcterms:modified[^>]*>)[^<]*/, '$1' + now)
      .replace(/<dc:creator>[\s\S]*?<\/dc:creator>/, '<dc:creator>' + esc(info.operator || 'QC') + '</dc:creator>')
      .replace(/<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/, '<cp:lastModifiedBy>' + esc(info.operator || 'QC') + '</cp:lastModifiedBy>'), 'utf8');
  }
  if (info.branding && info.branding.logo) branding.addLogo(parts, info.branding.logo);
  return writeZip(parts);
}

module.exports = { build, readZip, writeZip, setCell, TEMPLATE };
