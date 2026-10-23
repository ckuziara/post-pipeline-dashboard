/* AQC — automatic QC of a task's delivered files against the Moonbase
   technical specification (Moonbug KB: "Moonbase Deliverables & Technical
   Specification (Animation)"). Run from the QC tab (POST /api/task/aqc)
   before QC's own eyeball check, so the measurable things — codec, frame
   size, frame rate, timecode start, sample rate, bit depth, loudness, true
   peak — are already answered.

   No media library, like qcreport.js: a .mov/.mp4 is a tree of atoms and a
   .wav is RIFF chunks, so this reads the headers it needs straight from the
   file, and decodes PCM itself for loudness (ITU-R BS.1770-4, gated) and
   true peak (4× oversampled). Nothing is written back to the media.

   Every check comes out as pass, flag (worth a human look) or fail (doesn't
   meet the spec), plus info rows that just report what the file is. */
'use strict';
const fs = require('fs');
const path = require('path');

/* The spec, as the KB states it. Loudness targets only the full mixes —
   stems (DIA, SFX, ACA…) are reported, not held to −14. */
const SPEC = {
  video: {
    containers: ['mov'],
    codecs: ['ap4h', 'ap4x', 'apch', 'apcn'],      // ProRes 4444 (preferred) / 4444 XQ / 422 HQ / 422
    width: 1920, height: 1080,
    fps: [24, 25],                                  // per IP; a show's own rate narrows this
    tcStart: '00:00:00:00',
    alphaSuffixes: ['ALPHA-KAR', 'ALPHA-GFX']       // must carry an alpha channel (ProRes 4444)
  },
  audio: {
    format: 'PCM', sampleRate: 48000, bitDepth: 24, channels: 2,
    truePeakMax: -1,                                // dBTP
    loudnessTarget: -14, loudnessTolerance: 1,      // LUFS integrated, ± LU
    loudnessSuffixes: ['MIX', 'SONGMASTER']
  }
};

const CODECS = {
  ap4h: 'Apple ProRes 4444', ap4x: 'Apple ProRes 4444 XQ', apch: 'Apple ProRes 422 HQ', apcn: 'Apple ProRes 422',
  apcs: 'Apple ProRes 422 LT', apco: 'Apple ProRes 422 Proxy', avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC'
};

const row = (label, expected, actual, result) => ({ label, expected: expected == null ? '' : String(expected), actual: actual == null ? '' : String(actual), result });
const round = (n, d) => { const f = Math.pow(10, d || 1); return Math.round(n * f) / f; };

/* ================================================================ MOV / MP4 */

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return n === len ? b : b.slice(0, n);
}

// top-level atoms by walking sizes on disk — moov is often at the end, after gigabytes of mdat
function topAtoms(fd, size) {
  const out = [];
  let p = 0;
  while (p + 8 <= size && out.length < 1000) {
    const h = readAt(fd, p, 16);
    if (h.length < 8) break;
    let len = h.readUInt32BE(0), hdr = 8;
    const type = h.toString('latin1', 4, 8);
    if (len === 1) { len = Number(h.readBigUInt64BE(8)); hdr = 16; }
    else if (len === 0) len = size - p;
    if (len < hdr) break;
    out.push({ type, start: p, hdr, len });
    p += len;
  }
  return out;
}

// child atoms inside an in-memory buffer
function children(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let len = buf.readUInt32BE(p), hdr = 8;
    const type = buf.toString('latin1', p + 4, p + 8);
    if (len === 1) { len = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (len === 0) len = end - p;
    if (len < hdr || p + len > end) break;
    out.push({ type, start: p, body: p + hdr, end: p + len });
    p += len;
  }
  return out;
}
const child = (buf, a, type) => a && children(buf, a.body, a.end).find(c => c.type === type);
const path_ = (buf, a, types) => types.reduce((x, t) => child(buf, x, t), a);

function parseTrack(buf, trak) {
  const mdia = child(buf, trak, 'mdia');
  const hdlr = child(buf, mdia, 'hdlr');
  const mdhd = child(buf, mdia, 'mdhd');
  const stbl = path_(buf, mdia, ['minf', 'stbl']);
  if (!hdlr || !mdhd || !stbl) return null;
  const handler = buf.toString('latin1', hdlr.body + 8, hdlr.body + 12);
  const v = buf[mdhd.body];
  const timescale = v === 1 ? buf.readUInt32BE(mdhd.body + 20) : buf.readUInt32BE(mdhd.body + 12);
  const duration = v === 1 ? Number(buf.readBigUInt64BE(mdhd.body + 24)) : buf.readUInt32BE(mdhd.body + 16);
  const t = { handler, timescale, duration };

  const stsd = child(buf, stbl, 'stsd');
  const entry = stsd && children(buf, stsd.body + 8, stsd.end)[0];
  if (entry) {
    t.format = entry.type;
    const e = entry.start;
    if (handler === 'vide') {
      t.width = buf.readUInt16BE(e + 32);
      t.height = buf.readUInt16BE(e + 34);
      t.depth = buf.readUInt16BE(e + 82);
      children(buf, e + 86, entry.end).forEach(c => {
        if (c.type === 'pasp') t.par = [buf.readUInt32BE(c.body), buf.readUInt32BE(c.body + 4)];
        if (c.type === 'fiel') t.fields = buf[c.body];
        if (c.type === 'colr') t.colr = buf.toString('latin1', c.body, c.body + 4);
      });
    } else if (handler === 'soun') {
      t.channels = buf.readUInt16BE(e + 24);
      t.sampleSize = buf.readUInt16BE(e + 26);
      t.sampleRate = buf.readUInt32BE(e + 32) / 65536;
    } else if (handler === 'tmcd') {
      t.tcFlags = buf.readUInt32BE(e + 20);
      t.tcScale = buf.readUInt32BE(e + 24);
      t.tcFrameDur = buf.readUInt32BE(e + 28);
      t.tcFrames = buf[e + 32];
    }
  }
  const stts = child(buf, stbl, 'stts');
  if (stts && buf.readUInt32BE(stts.body + 4) > 0) t.sampleDelta = buf.readUInt32BE(stts.body + 12);
  const stco = child(buf, stbl, 'stco'), co64 = child(buf, stbl, 'co64');
  if (stco && buf.readUInt32BE(stco.body + 4) > 0) t.firstChunk = buf.readUInt32BE(stco.body + 8);
  else if (co64 && buf.readUInt32BE(co64.body + 4) > 0) t.firstChunk = Number(buf.readBigUInt64BE(co64.body + 8));
  return t;
}

const pad2 = (n) => String(n).padStart(2, '0');
function framesToTc(frames, fps, drop) {
  if (drop && (fps === 30 || fps === 60)) {
    // drop-frame: two (or four) frame numbers skipped every minute but each tenth
    const d = fps === 30 ? 2 : 4, perMin = fps * 60 - d, per10 = perMin * 10 + d;
    const tens = Math.floor(frames / per10), rem = frames % per10;
    frames += d * 9 * tens + (rem > d ? d * Math.floor((rem - d) / perMin) : 0);
  }
  const f = frames % fps, s = Math.floor(frames / fps) % 60, m = Math.floor(frames / (fps * 60)) % 60, h = Math.floor(frames / (fps * 3600));
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s) + (drop ? ';' : ':') + pad2(f);
}

function probeMovie(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const atoms = topAtoms(fd, size);
    const ftyp = atoms.find(a => a.type === 'ftyp');
    const moovA = atoms.find(a => a.type === 'moov');
    if (!moovA) return { error: 'no movie header (moov) — not a QuickTime/MP4 file, or it’s incomplete' };
    if (moovA.len > 64 * 1024 * 1024) return { error: 'movie header too large to read' };
    const buf = readAt(fd, moovA.start, moovA.len);
    const moov = { body: moovA.hdr, end: buf.length };
    const tracks = children(buf, moov.body, moov.end).filter(c => c.type === 'trak').map(t => parseTrack(buf, t)).filter(Boolean);
    const brand = ftyp ? readAt(fd, ftyp.start + ftyp.hdr, 4).toString('latin1') : null;
    const out = { brand, tracks };
    const tc = tracks.find(t => t.handler === 'tmcd');
    if (tc && tc.firstChunk != null && tc.tcFrames) {
      const n = readAt(fd, tc.firstChunk, 4);
      if (n.length === 4) out.tcStart = framesToTc(n.readUInt32BE(0), tc.tcFrames, !!(tc.tcFlags & 1));
    }
    return out;
  } finally { fs.closeSync(fd); }
}

function checkMovie(file, suffix, opts) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const p = probeMovie(file);
  if (p.error) return [row('Readable', 'QuickTime movie', p.error, 'fail')];
  const S = SPEC.video, rows = [];
  const v = p.tracks.find(t => t.handler === 'vide');
  const isMov = ext === 'mov';
  rows.push(row('Container', 'MOV (QuickTime)', (p.brand === 'qt  ' ? 'QuickTime' : (p.brand || '?').trim()) + ' · .' + ext,
    isMov ? 'pass' : 'info'));
  if (!v) { rows.push(row('Video track', 'present', 'none', 'fail')); return rows; }

  const codec = CODECS[v.format] || v.format;
  const alpha = S.alphaSuffixes.includes(suffix);
  if (isMov) {
    const ok = S.codecs.includes(v.format);
    rows.push(row('Codec', alpha ? 'ProRes 4444 with alpha' : 'ProRes 4444 (preferred) / 422', codec,
      !ok || (alpha && !/^ap4/.test(v.format)) ? 'fail' : 'pass'));
    if (alpha) rows.push(row('Alpha channel', 'yes', v.depth === 32 ? 'yes' : 'no (depth ' + v.depth + ')', v.depth === 32 ? 'pass' : 'fail'));
    rows.push(row('Chroma', '4:4:4', /^ap4/.test(v.format) ? '4:4:4' : /^apc/.test(v.format) ? '4:2:2' : '—',
      /^ap4/.test(v.format) ? 'pass' : 'info'));
    rows.push(row('Bit depth', '10-bit or greater', /^ap/.test(v.format) ? (/^ap4/.test(v.format) ? '12-bit' : '10-bit') : '—',
      /^ap/.test(v.format) ? 'pass' : 'flag'));
  } else {
    rows.push(row('Codec', '—', codec, 'info'));
  }
  rows.push(row('Frame size', S.width + '×' + S.height, v.width + '×' + v.height, v.width === S.width && v.height === S.height ? 'pass' : 'fail'));
  const par = v.par ? v.par[0] + ':' + v.par[1] : '1:1';
  rows.push(row('Pixel aspect', 'square (1:1)', par, !v.par || v.par[0] === v.par[1] ? 'pass' : 'fail'));
  rows.push(row('Scan type', 'progressive', v.fields == null ? 'progressive (no field info)' : v.fields === 1 ? 'progressive' : 'interlaced', v.fields == null || v.fields === 1 ? 'pass' : 'fail'));
  const fps = v.sampleDelta ? v.timescale / v.sampleDelta : null;
  const allowed = opts && opts.fps ? [Number(opts.fps)] : S.fps;
  rows.push(row('Frame rate', allowed.join(' or ') + ' fps', fps ? round(fps, 3) + ' fps' : 'unknown',
    fps && allowed.some(f => Math.abs(f - fps) < 0.01) ? 'pass' : 'fail'));
  if (v.duration && v.timescale) rows.push(row('Duration', '', round(v.duration / v.timescale, 2) + ' s', 'info'));
  if (isMov) rows.push(row('Timecode start', S.tcStart, p.tcStart || 'no timecode track', p.tcStart === S.tcStart ? 'pass' : p.tcStart ? 'fail' : 'flag'));
  const a = p.tracks.find(t => t.handler === 'soun');
  if (a) rows.push(row('Embedded audio', '', a.channels + ' ch · ' + a.sampleRate + ' Hz · ' + a.format, 'info'));
  return rows;
}

/* ===================================================================== WAV */

function probeWav(fd, size) {
  const h = readAt(fd, 0, 12);
  if (h.length < 12 || h.toString('latin1', 0, 4) !== 'RIFF' || h.toString('latin1', 8, 12) !== 'WAVE') return { error: 'not a RIFF/WAVE file' };
  let p = 12, fmt = null, data = null;
  while (p + 8 <= size && (!fmt || !data)) {
    const c = readAt(fd, p, 8);
    const id = c.toString('latin1', 0, 4), len = c.readUInt32LE(4);
    if (id === 'fmt ') {
      const f = readAt(fd, p + 8, Math.min(len, 40));
      let format = f.readUInt16LE(0);
      if (format === 0xfffe && f.length >= 26) format = f.readUInt16LE(24);   // WAVE_FORMAT_EXTENSIBLE → its sub-format
      fmt = { format, channels: f.readUInt16LE(2), sampleRate: f.readUInt32LE(4), blockAlign: f.readUInt16LE(12), bits: f.readUInt16LE(14) };
    } else if (id === 'data') data = { start: p + 8, len: Math.min(len, size - p - 8) };
    p += 8 + len + (len & 1);
  }
  if (!fmt || !data) return { error: 'no ' + (!fmt ? 'fmt' : 'data') + ' chunk' };
  return Object.assign(fmt, { dataStart: data.start, dataLen: data.len });
}

// one biquad, direct form I, per channel
function biquad(b0, b1, b2, a1, a2) { return { b0, b1, b2, a1, a2, x1: 0, x2: 0, y1: 0, y2: 0 }; }
function run(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
  return y;
}
// BS.1770 K-weighting at any sample rate (the formulas behind the standard's 48 kHz table)
function kWeighting(fs) {
  let K = Math.tan(Math.PI * 1681.974450955533 / fs);
  const Q = 0.7071752369554196, Vh = Math.pow(10, 3.999843853973347 / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = biquad((Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
  K = Math.tan(Math.PI * 38.13547087602444 / fs);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  const hp = biquad(1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q2 + K * K) / a0);
  return [shelf, hp];
}

// 4× oversampling interpolator for true peak: windowed sinc, 12 taps a phase
const TP_PHASES = (() => {
  const taps = 48, L = 4, out = [];
  for (let ph = 0; ph < L; ph++) {
    const c = [];
    for (let k = 0; k < taps / L; k++) {
      const n = k * L + ph - taps / 2;
      const t = n / L;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * (k * L + ph) / (taps - 1)));
      c.push(sinc * w);
    }
    out.push(c);
  }
  return out;
})();

function measureWav(fd, w) {
  const ch = w.channels, bytes = w.bits / 8, float = w.format === 3;
  const read = (b, o) => float ? (bytes === 4 ? b.readFloatLE(o) : b.readDoubleLE(o))
    : bytes === 2 ? b.readInt16LE(o) / 32768 : bytes === 3 ? b.readIntLE(o, 3) / 8388608 : bytes === 4 ? b.readInt32LE(o) / 2147483648 : (b[o] - 128) / 128;
  const filters = Array.from({ length: ch }, () => kWeighting(w.sampleRate));
  const weight = (i) => ch >= 5 && (i === 4 || i === 5) ? 1.41 : ch >= 6 && i === 3 ? 0 : 1;   // 5.1: LFE out, surrounds +1.5 dB
  const seg = Math.round(w.sampleRate * 0.1);               // 100 ms segments; blocks are four of them
  const segSums = [];                                       // per segment: weighted Σ of mean squares
  let acc = new Float64Array(ch), inSeg = 0;
  let peak = 0, tp = 0, sLL = 0, sRR = 0, sLR = 0;
  const hist = Array.from({ length: ch }, () => new Float64Array(12)); let hp = 0;
  const chunk = w.blockAlign * 8192;
  for (let off = 0; off < w.dataLen; off += chunk) {
    const b = readAt(fd, w.dataStart + off, Math.min(chunk, w.dataLen - off));
    const frames = Math.floor(b.length / w.blockAlign);
    for (let f = 0; f < frames; f++) {
      const base = f * w.blockAlign;
      hp = (hp + 1) % 12;
      for (let c = 0; c < ch; c++) {
        const x = read(b, base + c * bytes);
        const ax = Math.abs(x);
        if (ax > peak) peak = ax;
        // true peak: the four interpolated points between this sample and the last
        const h = hist[c]; h[hp] = x;
        for (let p = 0; p < 4; p++) {
          const co = TP_PHASES[p]; let s = 0;
          for (let k = 0; k < 12; k++) s += co[k] * h[(hp - k + 12) % 12];
          const as = Math.abs(s); if (as > tp) tp = as;
        }
        const y = run(filters[c][1], run(filters[c][0], x));
        acc[c] += y * y;
      }
      if (ch >= 2) { const l = read(b, base), r = read(b, base + bytes); sLL += l * l; sRR += r * r; sLR += l * r; }
      if (++inSeg === seg) {
        let s = 0; for (let c = 0; c < ch; c++) s += weight(c) * acc[c];
        segSums.push(s); acc = new Float64Array(ch); inSeg = 0;
      }
    }
  }
  // gated integrated loudness: 400 ms blocks, 75% overlap; −70 LUFS absolute gate, then −10 LU relative
  const blocks = [];
  for (let j = 0; j + 4 <= segSums.length; j++) blocks.push((segSums[j] + segSums[j + 1] + segSums[j + 2] + segSums[j + 3]) / (4 * seg));
  const L = (z) => -0.691 + 10 * Math.log10(z);
  const abs = blocks.filter(z => z > 0 && L(z) > -70);
  let lufs = null;
  if (abs.length) {
    const rel = L(abs.reduce((a, z) => a + z, 0) / abs.length) - 10;
    const g = abs.filter(z => L(z) > rel);
    if (g.length) lufs = L(g.reduce((a, z) => a + z, 0) / g.length);
  }
  const db = (x) => x > 0 ? 20 * Math.log10(x) : -Infinity;
  return {
    lufs, samplePeak: db(peak), truePeak: db(Math.max(tp, peak)),
    correlation: ch >= 2 && sLL > 0 && sRR > 0 ? sLR / Math.sqrt(sLL * sRR) : null,
    seconds: w.dataLen / w.blockAlign / w.sampleRate
  };
}

function checkWav(file, suffix) {
  const fd = fs.openSync(file, 'r');
  try {
    const S = SPEC.audio, rows = [];
    const w = probeWav(fd, fs.fstatSync(fd).size);
    if (w.error) return [row('Readable', 'WAV (PCM)', w.error, 'fail')];
    const pcm = w.format === 1;
    rows.push(row('Codec', 'PCM, uncompressed', pcm ? 'PCM' : w.format === 3 ? 'IEEE float' : 'format ' + w.format, pcm ? 'pass' : 'fail'));
    rows.push(row('Sample rate', '48.0 kHz', round(w.sampleRate / 1000, 1) + ' kHz', w.sampleRate === S.sampleRate ? 'pass' : 'fail'));
    rows.push(row('Bit depth', S.bitDepth + '-bit', w.bits + '-bit', w.bits === S.bitDepth ? 'pass' : 'fail'));
    rows.push(row('Channels', '2.0 stereo', w.channels === 1 ? 'mono' : w.channels === 2 ? '2.0 stereo' : w.channels + ' ch', w.channels === S.channels ? 'pass' : 'fail'));
    if (!pcm && w.format !== 3) return rows;
    const m = measureWav(fd, w);
    rows.push(row('Duration', '', round(m.seconds, 2) + ' s', 'info'));
    rows.push(row('True peak', '≤ ' + S.truePeakMax + ' dBTP', isFinite(m.truePeak) ? round(m.truePeak, 1) + ' dBTP' : 'silent',
      !isFinite(m.truePeak) ? 'flag' : m.truePeak <= S.truePeakMax ? 'pass' : 'fail'));
    const targeted = S.loudnessSuffixes.includes(suffix);
    const lu = m.lufs == null ? 'below −70 (silent)' : round(m.lufs, 1) + ' LUFS';
    if (targeted) {
      const off = m.lufs == null ? Infinity : Math.abs(m.lufs - S.loudnessTarget);
      rows.push(row('Integrated loudness', S.loudnessTarget + ' LUFS ±' + S.loudnessTolerance, lu,
        off <= S.loudnessTolerance ? 'pass' : off <= S.loudnessTolerance * 2 ? 'flag' : 'fail'));
    } else {
      rows.push(row('Integrated loudness', 'reported (stem)', lu, 'info'));
    }
    if (m.correlation != null) {
      const c = round(m.correlation, 2);
      rows.push(row('Mono compatible', 'L/R correlation ≥ 0', String(c), c >= 0 ? 'pass' : 'flag'));
    }
    return rows;
  } finally { fs.closeSync(fd); }
}

/* ================================================================== the run */

const MEDIA = { mov: 'movie', mp4: 'movie', m4v: 'movie', wav: 'wav' };

/* files: [{ name, abs }]. suffixOf(name) → the naming convention's suffix,
   or null. opts.fps narrows the frame-rate check to the show's own rate.
   Returns { files: [{ name, suffix, kind, rows, result }], result, counts }. */
function run_(files, suffixOf, opts) {
  const out = [];
  files.forEach(f => {
    const ext = path.extname(f.name).slice(1).toLowerCase();
    const suffix = suffixOf(f.name);
    const rows = [row('Naming convention', 'a known suffix', suffix || 'none found', suffix ? 'pass' : 'flag')];
    let kind = MEDIA[ext] || 'other';
    try {
      if (kind === 'movie') rows.push(...checkMovie(f.abs, suffix, opts));
      else if (kind === 'wav') rows.push(...checkWav(f.abs, suffix));
      else rows.push(row('Media checks', '', 'not a movie or WAV — naming only', 'info'));
    } catch (e) {
      rows.push(row('Readable', '', 'couldn’t read: ' + e.message, 'fail'));
    }
    out.push({ name: f.name, suffix, kind, rows, result: worst(rows) });
  });
  const counts = { pass: 0, flag: 0, fail: 0 };
  out.forEach(f => { counts[f.result] = (counts[f.result] || 0) + 1; });
  return { files: out, result: out.length ? worst(out) : 'flag', counts };
}
function worst(list) {
  const r = list.map(x => x.result);
  return r.includes('fail') ? 'fail' : r.includes('flag') ? 'flag' : 'pass';
}

// the run as CSV, saved beside QC's project and report
function toCsv(res, meta) {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [
    ['AQC report', meta.show, meta.code, meta.task, 'QC V' + meta.version, meta.date].map(q).join(','),
    ['Overall', res.result.toUpperCase(), res.counts.pass + ' pass', res.counts.flag + ' flag', res.counts.fail + ' fail'].map(q).join(','),
    '',
    ['File', 'Suffix', 'Check', 'Expected', 'Actual', 'Result'].map(q).join(',')
  ];
  res.files.forEach(f => f.rows.forEach(r => lines.push([f.name, f.suffix || '', r.label, r.expected, r.actual, r.result.toUpperCase()].map(q).join(','))));
  return lines.join('\r\n') + '\r\n';
}

module.exports = { SPEC, run: run_, toCsv, probeMovie, framesToTc, _measure: { probeWav, measureWav } };
