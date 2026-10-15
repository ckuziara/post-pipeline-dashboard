/* QC report form branding — the studio's logo in the report's header, set
   in Admin → Workflow → QC (board state: data.formBranding).

   templates/qc-report.xlsx has no logo, on purpose. This places one picture
   in the header row: an image part, a drawing that anchors it to the top-left
   of A1 (the merged A1:I1 title row, whose title is centred, so the logo sits
   clear of it), and the relationships and content types that tie them to the
   sheet. Same no-library approach as qcreport.js — these work on its list of
   zip parts.

   The logo arrives as a data URL from board state (or, for a companion, the
   client's copy of it). Only PNG and JPEG are accepted, checked by their
   bytes rather than the URL's claimed type, so nothing but an image can end
   up in the file. */
'use strict';

const MAX_BYTES = 1.5 * 1024 * 1024;
const EMU_PER_PX = 9525, EMU_PER_PT = 12700;
// the header row is 69.75pt tall; the logo fits inside it with a margin
const ROW_PT = 69.75, MAX_H_PT = 54, MAX_W_PX = 300, LEFT_PX = 12;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// { ext, mime, width, height } for a PNG or JPEG, else null
function imageInfo(buf) {
  if (buf.length > 24 && buf.slice(0, 8).equals(PNG_SIG) && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { ext: 'png', mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) return null;
      const m = buf[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      // start of frame (any SOFn but DHT/JPG/DAC)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { ext: 'jpeg', mime: 'image/jpeg', width: buf.readUInt16BE(p + 7), height: buf.readUInt16BE(p + 5) };
      }
      p += 2 + buf.readUInt16BE(p + 2);
    }
  }
  return null;
}

// a data URL → { data, ext, mime, width, height }, or null if it isn't a usable PNG/JPEG
function decodeLogo(url) {
  const m = /^data:image\/(?:png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(url || ''));
  if (!m) return null;
  const data = Buffer.from(m[1], 'base64');
  if (!data.length || data.length > MAX_BYTES) return null;
  const info = imageInfo(data);
  if (!info || !info.width || !info.height) return null;
  return Object.assign({ data }, info);
}

const nextRid = (rels) => 'rId' + (Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map(x => +x[1])) + 1);

/* The worksheet children that come after <drawing> in the schema: it goes in
   front of the first of these the sheet has (in the template: extLst). */
const AFTER_DRAWING = ['legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls',
  'webPublishItems', 'tableParts', 'extLst'];
function insertDrawing(sheet, rid) {
  const tag = '<drawing r:id="' + rid + '"/>';
  let at = -1;
  AFTER_DRAWING.forEach(n => {
    const i = sheet.search(new RegExp('<' + n + '[\\s/>]'));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  });
  if (at < 0) at = sheet.lastIndexOf('</worksheet>');
  return sheet.slice(0, at) + tag + sheet.slice(at);
}

function drawingXml(logo) {
  // fit inside MAX_W_PX × MAX_H_PT, keeping its shape; never enlarged
  const maxH = MAX_H_PT * EMU_PER_PT, maxW = MAX_W_PX * EMU_PER_PX;
  const scale = Math.min(1, maxW / (logo.width * EMU_PER_PX), maxH / (logo.height * EMU_PER_PX));
  const cx = Math.round(logo.width * EMU_PER_PX * scale), cy = Math.round(logo.height * EMU_PER_PX * scale);
  const rowOff = Math.max(0, Math.round((ROW_PT * EMU_PER_PT - cy) / 2));
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<xdr:oneCellAnchor>'
    + '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>' + LEFT_PX * EMU_PER_PX + '</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>' + rowOff + '</xdr:rowOff></xdr:from>'
    + '<xdr:ext cx="' + cx + '" cy="' + cy + '"/>'
    + '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo" descr="Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
    + '<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
    + '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>'
    + '<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>';
}

const RELS_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

/* Put the logo (a data URL) in the header of the zip parts of a QC report,
   in place. Returns false, changing nothing, when there's no usable logo or
   the sheet already has a drawing. */
function addLogo(parts, logoUrl) {
  const logo = decodeLogo(logoUrl);
  if (!logo) return false;
  const get = (n) => parts.find(p => p.name === n);
  const sheetPart = get('xl/worksheets/sheet1.xml');
  const types = get('[Content_Types].xml');
  if (!sheetPart || !types) return false;
  let sheet = sheetPart.data.toString('utf8');
  if (/<drawing[\s/>]/.test(sheet) || get('xl/drawings/drawing1.xml')) return false;

  const media = 'xl/media/image1.' + logo.ext;
  parts.push({ name: media, data: logo.data });
  parts.push({ name: 'xl/drawings/drawing1.xml', data: Buffer.from(drawingXml(logo), 'utf8') });
  parts.push({ name: 'xl/drawings/_rels/drawing1.xml.rels', data: Buffer.from(RELS_HEAD
    + '<Relationship Id="rId1" Type="' + REL + 'image" Target="../media/image1.' + logo.ext + '"/></Relationships>', 'utf8') });

  // the sheet → its drawing (adding to the sheet's rels if it has some)
  const relsName = 'xl/worksheets/_rels/sheet1.xml.rels';
  let relsPart = get(relsName);
  if (!relsPart) { relsPart = { name: relsName, data: Buffer.from(RELS_HEAD + '</Relationships>', 'utf8') }; parts.push(relsPart); }
  let rels = relsPart.data.toString('utf8');
  const rid = nextRid(rels);
  rels = rels.replace('</Relationships>', '<Relationship Id="' + rid + '" Type="' + REL + 'drawing" Target="../drawings/drawing1.xml"/></Relationships>');
  relsPart.data = Buffer.from(rels, 'utf8');
  sheetPart.data = Buffer.from(insertDrawing(sheet, rid), 'utf8');

  let t = types.data.toString('utf8');
  if (!new RegExp('<Default Extension="' + logo.ext + '"', 'i').test(t)) {
    t = t.replace(/(<Types[^>]*>)/, '$1<Default Extension="' + logo.ext + '" ContentType="' + logo.mime + '"/>');
  }
  t = t.replace('</Types>', '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
  types.data = Buffer.from(t, 'utf8');
  return true;
}

/* The title for A1 from the branding's title, with {show} standing for the
   show's name; null when there's no title set (the report's own default). */
function titleFor(branding, show) {
  const t = branding && typeof branding.title === 'string' ? branding.title.trim() : '';
  if (!t) return null;
  return t.replace(/\{show\}/gi, show || '').replace(/\s{2,}/g, ' ').trim().slice(0, 120);
}

module.exports = { addLogo, titleFor, decodeLogo, imageInfo };
