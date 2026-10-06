/* Smart Import — the reading half. Turns one spreadsheet sheet into a first
   draft of shows, episodes and tasks; the wizard in js/smartimport.js puts
   that draft in front of a producer to correct before anything is created.

   Two shapes of sheet are understood:

   GRID  — a calendar laid out across the columns: a row of real dates near
           the top, one row per episode beneath, and the work drawn as filled
           cells. A bar is a run of cells of one fill colour; its label is any
           text written inside the run (not necessarily in its first cell).
           Rows directly under an episode whose label repeats down the sheet
           ("RED DATES", "Walla/ Audio reviews") are that episode's sub-tracks.
           A colour that fills most of a column top to bottom — bank holidays,
           a studio closure — is the calendar's background, not work, and is
           looked through rather than read as a bar.

   TABLE — a row per episode and a column per stage, each cell a date
           ("Premise Lock", "Master Date", "Delivery Date"). Each column is a
           task that runs from the previous date in the row up to its own.

   Everything here is a pure function of the sheet (no App state, no DOM), so
   it runs under Node for tests. */
(function (root) {
  'use strict';
  const App = root.App = root.App || {};

  /* ---------------- dates ---------------- */
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const isoUTC = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  // Excel's day 0 is 1899-12-30 (the 1900 leap-year bug is baked into it)
  const serialToIso = (n) => isoUTC(new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000));
  const isSerialDate = (v) => typeof v === 'number' && v > 20000 && v < 80000;
  const addDaysIso = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return isoUTC(d); };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  /* "31st Dec", "4 Feb", "15th April" — a day and month with no year. Given
     the date it must fall after, the first such day on or after it. */
  function textDateAfter(s, afterIso) {
    const m = /^\s*(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?\s*$/i.exec(String(s || ''));
    if (!m) return null;
    const mon = MONTHS[m[2].toLowerCase().slice(0, m[2].length > 3 && m[2].toLowerCase().startsWith('sept') ? 4 : 3)];
    if (mon == null) return null;
    const after = afterIso || '2000-01-01';
    let y = +after.slice(0, 4);
    for (let i = 0; i < 3; i++, y++) {
      const iso = y + '-' + pad(mon + 1) + '-' + pad(+m[1]);
      if (iso >= after) return iso;
    }
    return null;
  }

  /* ---------------- text helpers ---------------- */
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  // "LA0103Walla/ Audio reviews" and "Walla/ Audio reviews" are the same track
  const trackKey = (s) => clean(s).replace(/^[A-Z]{2,}\d+/, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const slug = (s) => clean(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'task';
  const isNumberLabel = (s) => /^-?\d+(\.\d+)?$/.test(clean(s));
  // "ANIMATIC" → "Animatic"; short codes (LYT, V1, QC) stay as written
  function prettyLabel(s) {
    const t = clean(s);
    if (t.length <= 4) return t;
    return t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t;
  }
  // the colour a fill reads as "nothing" — white, or near enough
  const isBlankFill = (f) => !f || /^#F{6}$/i.test(f) || /^#FEFEFE$/i.test(f);

  /* Episode code and title out of one label:
       "EMWW0101 (Class Photo Day - This is Me!)" → EMWW0101, Class Photo Day - This is Me!
       "EMWW0119  - Valentines"                  → EMWW0119, Valentines
       "Short 01"                                → Short01,  Short 01
       "Prelude06"                               → Prelude06, Prelude06            */
  function parseEpisodeLabel(label) {
    const t = clean(label);
    const m = /^([A-Za-z][A-Za-z ]{0,14}?\s?\d{1,5}[A-Za-z]?)\b\s*(?:[-–—:]\s*)?(.*)$/.exec(t);
    if (m && /\d/.test(m[1])) {
      const code = m[1].replace(/\s+/g, '');
      let rest = clean(m[2]);
      // "EMWW0101 (Class Photo Day)" — the whole title in brackets
      if (/^\(.*\)$/.test(rest) && rest.indexOf(')') === rest.length - 1) rest = rest.slice(1, -1).trim();
      const title = rest || t;
      return { code, title };
    }
    return { code: '', title: t };
  }
  // what makes a run of episodes one family: the code without its number
  const familyOf = (label) => {
    const p = parseEpisodeLabel(label);
    return (p.code ? p.code.replace(/\d+[A-Za-z]?$/, '') : clean(label).replace(/\d+/g, '').trim()).toLowerCase() || '?';
  };

  /* ---------------- department & kind guesses ---------------- */
  // checked in order; first match wins. Labels in spreadsheets are terse, so
  // short codes get whole-word matches and words get substring matches.
  const DEPT_RULES = [
    [/\b(ld|live|live date|air|tx)\b/i, null, 'live'],
    [/\b(nd|final delivery|delivery date|deliver(y|ies)? date)\b/i, 'ops', 'delivery'],
    [/\bqc\b|quality/i, 'qc'],
    [/deliver|\bd\b|ship|upload|subtitle|captions?/i, 'ops'],
    [/music|song|skeleton|score|lyric|compos|vocal/i, 'music'],
    [/walla|wallah|\bvo\b|voice|audio|sfx|sound|foley|\bdub/i, 'audio'],
    [/layout|\blyt\b|block|\bblk\b|spline|\bspl\b|\blrc\b|light|render|comp|anim(?!atic)|rig|model|surfac|studio|\bred\b|master|\bm\b|\bl\b|\bp\b|polish/i, 'animation'],
    // the terse audio review codes, only once nothing stronger has matched
    [/mix|\bol\b|\bw\d\b|\bv\d\b|\br\d\b|\brev\b|\bf\b/i, 'audio'],
    [/edit|grade|colou?r|conform|online|picture/i, 'video'],
    [/premise|script|writer|design|story|board|animatic|\bko\b|kick ?off|matrix|pitch|greenlight|\bcr\b|review|feedback|cast/i, 'creative']
  ];
  function guessDept(label, trackLabel, depts) {
    const ok = (k) => !depts || depts.indexOf(k) >= 0;
    const tryText = (s) => {
      for (const r of DEPT_RULES) if (r[0].test(s)) return { dept: r[1], kind: r[2] || 'task' };
      return null;
    };
    const own = tryText(clean(label));
    if (own && own.kind !== 'task') return own;
    if (own && own.dept && ok(own.dept)) return own;
    const tr = trackLabel ? tryText(trackLabel) : null;
    if (tr && tr.dept && ok(tr.dept)) return { dept: tr.dept, kind: 'task' };
    return { dept: depts && depts.length ? (ok('creative') ? 'creative' : depts[0]) : 'creative', kind: 'task' };
  }

  /* ---------------- sheet access ---------------- */
  const cellAt = (sheet, r, c) => sheet.cells.get(r + ',' + c) || null;
  const valAt = (sheet, r, c) => { const x = cellAt(sheet, r, c); return x ? x.v : null; };

  /* The row of real dates a grid hangs from: the row near the top with the
     most date cells, provided they climb left to right. */
  function findDateRow(sheet) {
    let best = null;
    const limit = Math.min(sheet.rows, 25);
    for (let r = 0; r < limit; r++) {
      const cols = [];
      for (let c = 0; c < sheet.cols; c++) { const v = valAt(sheet, r, c); if (isSerialDate(v)) cols.push(c); }
      if (cols.length < 10) continue;
      let rising = 0;
      for (let i = 1; i < cols.length; i++) if (valAt(sheet, r, cols[i]) > valAt(sheet, r, cols[i - 1])) rising++;
      if (rising < (cols.length - 1) * 0.9) continue;
      if (!best || cols.length > best.cols.length) best = { row: r, cols };
    }
    return best;
  }

  /* A header row for a table: a row with several text cells, followed by
     rows holding several date cells in those same columns. */
  function findTableHeader(sheet) {
    const limit = Math.min(sheet.rows, 15);
    let best = null;
    for (let r = 0; r < limit; r++) {
      const textCols = [];
      for (let c = 0; c < Math.min(sheet.cols, 60); c++) { const v = valAt(sheet, r, c); if (typeof v === 'string' && clean(v)) textCols.push(c); }
      if (textCols.length < 3) continue;
      const dateCols = textCols.filter(c => {
        let n = 0;
        for (let rr = r + 1; rr < Math.min(sheet.rows, r + 12); rr++) if (isSerialDate(valAt(sheet, rr, c))) n++;
        return n >= 2;
      });
      if (dateCols.length >= 2 && (!best || dateCols.length > best.dateCols.length)) best = { row: r, textCols, dateCols };
    }
    return best;
  }

  function detect(sheet) {
    const g = findDateRow(sheet);
    if (g && g.cols.length >= 20) return { layout: 'grid', dateRow: g.row, dateCols: g.cols };
    const t = findTableHeader(sheet);
    if (t) return { layout: 'table', headerRow: t.row, dateCols: t.dateCols, textCols: t.textCols };
    if (g) return { layout: 'grid', dateRow: g.row, dateCols: g.cols };
    return { layout: 'unknown' };
  }

  /* ================= GRID ================= */
  function analyseGrid(sheet, det) {
    const dateRow = det.dateRow;
    const dateCols = det.dateCols;
    const firstDateCol = dateCols[0], lastDateCol = dateCols[dateCols.length - 1];
    const dateOf = {};
    dateCols.forEach(c => { dateOf[c] = serialToIso(valAt(sheet, dateRow, c)); });
    const gridEnd = dateOf[lastDateCol];

    // label columns are everything left of the calendar
    const labelOf = (r) => {
      const parts = [];
      for (let c = 0; c < firstDateCol; c++) { const v = valAt(sheet, r, c); if (v != null && clean(v)) parts.push(clean(v)); }
      return parts;
    };

    // rows below the dates that hold anything at all
    const dataRows = [];
    for (let r = dateRow + 1; r < sheet.rows; r++) {
      let any = labelOf(r).length > 0;
      if (!any) for (const c of dateCols) { const x = cellAt(sheet, r, c); if (x && (x.v != null || !isBlankFill(x.fill))) { any = true; break; } }
      if (any) dataRows.push(r);
    }

    /* Background: a fill covering at least half of the data rows in a column
       belongs to the calendar (a holiday, a closure), not to any one row. */
    const background = {};             // col → Set of fills
    const bgSeen = {};                 // fill → number of columns it backgrounds
    dateCols.forEach(c => {
      const count = {};
      dataRows.forEach(r => { const x = cellAt(sheet, r, c); if (x && !isBlankFill(x.fill)) count[x.fill] = (count[x.fill] || 0) + 1; });
      Object.keys(count).forEach(f => {
        if (count[f] >= Math.max(3, dataRows.length * 0.5)) {
          (background[c] = background[c] || new Set()).add(f);
          bgSeen[f] = (bgSeen[f] || 0) + 1;
        }
      });
    });
    /* a colour that backgrounds at least three whole columns is a calendar
       colour everywhere — a stray holiday cell on one row is still a holiday */
    const isBg = (c, fill) => !!(background[c] && background[c].has(fill)) || (bgSeen[fill] || 0) >= 3;

    /* One row's bars. Walk the calendar left to right; a background cell is
       looked through (it neither ends nor extends a bar), anything else that
       isn't filled ends the current bar. Within a run of one colour each
       label starts a new bar, and any unlabelled lead-in belongs to the
       first label after it. */
    function barsOf(r) {
      const bars = [];
      let cur = null;
      const close = () => { if (cur) bars.push(cur); cur = null; };
      for (const c of dateCols) {
        const x = cellAt(sheet, r, c);
        const fill = x && !isBlankFill(x.fill) ? x.fill : null;
        const label = x && x.v != null && !x.merged ? clean(typeof x.v === 'number' && isSerialDate(x.v) ? serialToIso(x.v) : x.v) : '';
        if (fill && isBg(c, fill) && !label) continue;          // holiday: look through it
        if (!fill && !label) { close(); continue; }
        const iso = dateOf[c];
        if (cur && fill && cur.fill === fill) {
          if (label && cur.label) { close(); cur = { label, fill, start: iso, end: iso, cols: [c] }; }
          else { if (label) cur.label = label; cur.end = iso; cur.cols.push(c); }
        } else {
          close();
          cur = { label, fill, start: iso, end: iso, cols: [c] };
        }
      }
      close();
      // notes past the calendar's last column: "31st Dec" — a date beyond the grid
      const notes = [];
      for (let c = lastDateCol + 1; c < sheet.cols; c++) {
        const v = valAt(sheet, r, c);
        if (v == null) continue;
        const after = bars.length ? bars[bars.length - 1].end : gridEnd;
        const iso = typeof v === 'string' ? textDateAfter(v, after) : (isSerialDate(v) ? serialToIso(v) : null);
        if (iso) notes.push({ label: clean(v), fill: null, start: iso, end: iso, offGrid: true, cols: [c] });
      }
      return bars.concat(notes);
    }

    /* The row as the spreadsheet shows it, for drawing under the reading:
       runs of one fill across consecutive calendar columns, and any text. */
    function rawOf(r) {
      const out = [];
      let cur = null;
      dateCols.forEach(c => {
        const x = cellAt(sheet, r, c);
        const fill = x && !isBlankFill(x.fill) ? x.fill : null;
        const text = x && x.v != null && !x.merged ? clean(typeof x.v === 'number' && isSerialDate(x.v) ? serialToIso(x.v) : x.v) : '';
        const iso = dateOf[c];
        if (cur && fill && cur.fill === fill && !text) { cur.end = iso; return; }
        if (cur) out.push(cur);
        cur = fill || text ? { start: iso, end: iso, fill, text, bg: !!fill && isBg(c, fill) } : null;
      });
      if (cur) out.push(cur);
      return out;
    }

    // first pass: every row's label and bars
    const rows = dataRows.map(r => {
      const parts = labelOf(r);
      const bars = barsOf(r);
      return {
        r, hidden: sheet.hiddenRows.has(r), label: parts[0] || '', extra: parts.slice(1).join(' · '),
        bars, raw: rawOf(r), worth: bars.filter(b => b.label && !isNumberLabel(b.label)).length
      };
    });

    // labels that repeat down the sheet are sub-track names, not episodes
    const tkCount = {};
    rows.forEach(x => { const k = trackKey(x.label); if (k) tkCount[k] = (tkCount[k] || 0) + 1; });
    const isTrackLabel = (x) => { const k = trackKey(x.label); return !!k && tkCount[k] >= 3 && !parseEpisodeLabel(x.label).code; };

    // second pass: classify
    let lastEpisode = null, heading = null;
    rows.forEach(x => {
      if (!x.label) { x.role = 'ignore'; x.why = 'No label'; return; }
      if (isTrackLabel(x) && lastEpisode) {
        x.role = 'track'; x.parent = lastEpisode.r; x.track = trackKey(x.label); x.trackLabel = x.label.replace(/^[A-Z]{2,}\d+/, '').trim();
        // "Walla/ Audio reviews" → "Walla", "RED DATES" → "Red" — a short tag for task names
        x.trackTag = prettyLabel(x.trackLabel.split(/[\/\s]+/)[0] || x.trackLabel).replace(/^./, ch => ch.toUpperCase());
        return;
      }
      lastEpisode = null;
      if (/new series/i.test(x.extra) || (!x.worth && !x.bars.some(b => b.fill && !isNumberLabel(b.label)))) {
        x.role = 'heading'; heading = x; return;
      }
      if (!x.worth) { x.role = 'ignore'; x.why = 'Only numbers or blank colour — no labelled work'; return; }
      x.role = 'episode'; x.heading = heading ? heading.label : '';
      x.family = familyOf(x.label);
      lastEpisode = x;
    });

    /* Groups → shows. A family of three or more episodes (EMWW01xx, Short 01–30)
       is its own show; odd ones out (an intro, three outros) go together
       under the heading above them. */
    const famSize = {};
    rows.forEach(x => { if (x.role === 'episode') famSize[x.family] = (famSize[x.family] || 0) + 1; });
    const groups = [];
    const groupById = {};
    rows.forEach(x => {
      if (x.role !== 'episode') return;
      const big = famSize[x.family] >= 3;
      const id = big ? 'f:' + x.family : 'h:' + (x.heading || 'other');
      let g = groupById[id];
      if (!g) {
        const firstLabel = parseEpisodeLabel(x.label);
        // the heading names a family only when it sits right above that family
        const name = big
          ? (x.heading && !groups.some(o => o.heading === x.heading) ? x.heading : (firstLabel.code ? firstLabel.code.replace(/\d+[A-Za-z]?$/, '') : x.family))
          : (x.heading || 'Other');
        g = groupById[id] = { id, name: clean(name.replace(/\(new series\)/i, '')), heading: x.heading, rows: [] };
        groups.push(g);
      }
      g.rows.push(x.r);
      x.group = id;
    });
    groups.forEach(g => {
      const eps = rows.filter(x => x.group === g.id);
      g.hiddenAll = eps.every(x => x.hidden);
      const fam = eps[0] ? parseEpisodeLabel(eps[0].label).code.replace(/\d+[A-Za-z]?$/, '') : '';
      g.prefix = (fam || g.name).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'SHOW';
    });

    /* Unlabelled bars borrow the label their colour carries elsewhere on the
       same track — the sheet's own colour key, learned from the sheet. */
    const colourName = {};             // track|fill → { label: count }
    rows.forEach(x => {
      if (x.role !== 'episode' && x.role !== 'track') return;
      const tk = x.role === 'track' ? x.track : '';
      x.bars.forEach(b => {
        if (!b.label || !b.fill || isNumberLabel(b.label)) return;
        const k = tk + '|' + b.fill;
        const m = colourName[k] = colourName[k] || {};
        m[b.label] = (m[b.label] || 0) + 1;
      });
    });
    const nameForColour = (tk, fill) => {
      const m = colourName[tk + '|' + fill];
      if (!m) return '';
      return Object.keys(m).sort((a, b) => m[b] - m[a])[0];
    };

    /* Tidy one row's bars:
       1. an unlabelled run takes the label of the next run of its colour in
          the row when that's a few days on (the lead-in to "Studio" that a
          one-day KO interrupts), otherwise the colour's usual name;
       2. runs of the same label and colour a few days apart are one bar —
          a cell between them (that KO) stays a bar of its own. */
    const NEAR = 5;
    function tidy(x) {
      const tk = x.role === 'track' ? x.track : '';
      const bars = x.bars.map(b => Object.assign({}, b, { guessed: !b.label }));
      bars.forEach((b, i) => {
        if (b.label || !b.fill) return;
        const next = bars.slice(i + 1).find(o => o.fill === b.fill && o.label && !o.guessed);
        b.label = next && daysBetween(b.end, next.start) <= NEAR ? next.label : nameForColour(tk, b.fill);
      });
      const out = [];
      bars.forEach(b => {
        const prev = out.slice().reverse().find(o => o.label === b.label && o.fill === b.fill && !o.offGrid);
        // merge when nothing sits between them, or when one side is only an
        // unlabelled lead-in — two labelled reviews a few days apart stay two
        const between = prev ? out.length - 1 - out.indexOf(prev) : 0;
        if (prev && b.label && !b.offGrid && b.fill && daysBetween(prev.end, b.start) <= NEAR &&
            (between === 0 || (between === 1 && (prev.guessed || b.guessed)))) {
          prev.end = b.end > prev.end ? b.end : prev.end;
          prev.guessed = prev.guessed && b.guessed;
          return;
        }
        out.push(b);
      });
      return out;
    }

    // background colours, for the wizard to show what was looked through
    const backgroundFills = Object.keys(bgSeen).sort((a, b) => bgSeen[b] - bgSeen[a]).map(f => ({ fill: f, columns: bgSeen[f] }));

    return {
      layout: 'grid', gridStart: dateOf[firstDateCol], gridEnd, backgroundFills, sheetDays: dateCols.map(c => dateOf[c]),
      rows: rows.map(x => ({
        r: x.r, label: x.label, extra: x.extra, hidden: x.hidden, role: x.role, why: x.why || '', raw: x.raw,
        parent: x.parent, track: x.track || '', trackLabel: x.trackLabel || '', trackTag: x.trackTag || '', group: x.group || '',
        bars: tidy(x).map(b => ({
          label: b.label, guessed: !!b.guessed, fill: b.fill, start: b.start, end: b.end, offGrid: !!b.offGrid
        }))
      })),
      groups
    };
  }

  /* ================= TABLE ================= */
  function analyseTable(sheet, det) {
    const h = det.headerRow;
    const header = (c) => clean(valAt(sheet, h, c));
    // any column that isn't a date column — a code column's heading may be blank
    const textCols = [];
    for (let c = 0; c < Math.min(sheet.cols, 60); c++) if (det.dateCols.indexOf(c) < 0) textCols.push(c);
    // the code column: the first column whose cells look like episode codes
    const codeCol = textCols.find(c => {
      let n = 0;
      for (let r = h + 1; r < Math.min(sheet.rows, h + 15); r++) if (parseEpisodeLabel(valAt(sheet, r, c)).code) n++;
      return n >= 2;
    });
    const titleCol = textCols.find(c => c !== codeCol && /title|episode|ep\b|name/i.test(header(c)));
    const rows = [];
    for (let r = h + 1; r < sheet.rows; r++) {
      const codeV = codeCol != null ? clean(valAt(sheet, r, codeCol)) : '';
      const titleV = titleCol != null ? clean(valAt(sheet, r, titleCol)) : '';
      const label = [codeV, titleV && !/^#/.test(titleV) ? titleV : ''].filter(Boolean).join(' - ');
      // each date column: a task from the previous date in the row to this one
      const bars = [];
      let prev = null;
      det.dateCols.forEach(c => {
        const v = valAt(sheet, r, c);
        if (!isSerialDate(v)) return;
        const iso = serialToIso(v);
        const start = prev && prev < iso ? addDaysIso(prev, 1) : iso;
        bars.push({ label: header(c), guessed: false, fill: null, start, end: iso, offGrid: false, column: true });
        prev = iso;
      });
      if (!label && !bars.length) continue;
      const role = label && bars.length ? 'episode' : 'ignore';
      rows.push({ r, label, extra: '', hidden: sheet.hiddenRows.has(r), role, why: role === 'ignore' ? (label ? 'No dates' : 'No episode code') : '',
        track: '', trackLabel: '', group: role === 'episode' ? 'table' : '', bars });
    }
    const eps = rows.filter(x => x.role === 'episode');
    const fam = eps[0] ? parseEpisodeLabel(eps[0].label).code.replace(/\d+[A-Za-z]?$/, '') : '';
    const groups = eps.length ? [{ id: 'table', name: clean(sheet.name), heading: '', rows: eps.map(x => x.r), hiddenAll: false,
      prefix: (fam || sheet.name).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'SHOW' }] : [];
    return { layout: 'table', backgroundFills: [], rows, groups };
  }

  function analyse(sheet) {
    const det = detect(sheet);
    if (det.layout === 'grid') return analyseGrid(sheet, det);
    if (det.layout === 'table') return analyseTable(sheet, det);
    return { layout: 'unknown', rows: [], groups: [], backgroundFills: [] };
  }

  /* ================= TASKS =================
     The distinct things the sheet schedules, per show group: one per
     (track, label, nth time that label appears on the track within an
     episode). The nth matters — RED DATES has a "D" after every stage, and
     each is its own deadline.

     Returns { tasks, instances }. A task is the kind of thing ("Studio",
     "D 3 (Red)"); an instance is one bar of it on one episode, with its own
     dates — the wizard edits instances (drag, stretch, remove) and tasks
     (name, department, what it's used as) separately. */
  const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  function collectTasks(model, groupId, depts) {
    const rows = model.rows;
    const eps = rows.filter(x => x.role === 'episode' && x.group === groupId);
    const tasks = {};
    const order = [];
    const instances = [];
    eps.forEach(ep => {
      const tracks = [{ key: '', label: '', row: ep, bars: ep.bars }].concat(
        rows.filter(x => x.role === 'track' && x.parent === ep.r).map(x => ({ key: x.track, label: x.trackLabel, tag: x.trackTag, row: x, bars: x.bars })));
      tracks.forEach(t => {
        const seen = {};
        t.bars.forEach(b => {
          const label = b.offGrid ? '(date after the calendar)' : (b.label || '(unlabelled ' + (b.fill || '') + ')');
          const n = seen[label] = (seen[label] || 0) + 1;
          const id = t.key + '|' + label + '|' + n;
          let tk = tasks[id];
          if (!tk) {
            const g = guessDept(b.offGrid ? 'live' : label, t.label, depts);
            const base = prettyLabel(label);
            tk = tasks[id] = {
              id, track: t.key, trackLabel: t.label, label, nth: n, fill: b.fill, offGrid: !!b.offGrid, firstEp: ep.label,
              name: (b.offGrid ? 'Live date' : base) + (n > 1 ? ' ' + n : '') + (t.tag && !b.offGrid ? ' (' + t.tag + ')' : ''),
              dept: g.dept || 'ops',
              kind: b.offGrid ? 'live' : isNumberLabel(label) || /^\(unlabelled/.test(label) ? 'ignore' : g.kind,
              count: 0
            };
            order.push(id);
          }
          tk.count++;
          instances.push({ id: 'i' + instances.length, task: id, ep: ep.r, row: t.row.r, start: b.start, end: b.end, fill: b.fill, offGrid: !!b.offGrid, guessed: !!b.guessed });
        });
      });
    });
    const list = order.map(id => tasks[id]);
    // a label seen only once on one episode is usually a note, not a stage
    list.forEach(t => { if (t.kind === 'task' && t.count === 1 && eps.length >= 5) { t.rare = true; t.kind = 'ignore'; } });
    measure(list, instances);
    list.sort((a, b) => a.offset - b.offset || (a.track < b.track ? -1 : a.track > b.track ? 1 : 0));
    detectStructure(list, instances);
    return { tasks: list, instances };
  }

  /* ---- versions and Kick Offs ----
     A schedule writes a task's rounds as bars of their own along its row —
     ANIMATIC · 1st · 2nd · 3rd, or V1 · R1 · V2 · R2 · V3 — and a Kick Off as
     a one-day "KO" in front of the work it starts. Add Show models both: a
     task's later versions are its revisions (maxRev, revDays, revGaps), and
     a Kick Off is a one-day task of its own (ko, koFor) that its task waits
     on. These read the sheet's rows for both, voting across episodes so one
     odd row doesn't decide it:
       task.versionOf = the task this bar is a later version of
       task.koFor     = the task this Kick Off starts                       */
  const ORDINAL = /^(\d+)\s*(st|nd|rd|th)$/i;
  const VNUM = /^v\s*(\d+)$/i;
  const KO_RE = /^(ko|kick\s*-?\s*off)$/i;
  const versionNum = (label) => {
    const t = clean(label);
    let m = ORDINAL.exec(t); if (m) return { kind: 'ord', n: +m[1] };
    m = VNUM.exec(t); if (m) return { kind: 'v', n: +m[1] };
    return null;
  };
  function detectStructure(tasks, instances) {
    const byId = {};
    tasks.forEach(t => { byId[t.id] = t; delete t.versionOf; delete t.koFor; delete t.reviewOf; });
    const rows = {};
    instances.forEach(i => { if (!i.offGrid) (rows[i.ep + '/' + i.row] = rows[i.ep + '/' + i.row] || []).push(i); });
    const vVotes = {}, kVotes = {};
    const vote = (box, a, b) => { const m = box[a] = box[a] || {}; m[b] = (m[b] || 0) + 1; };
    Object.keys(rows).forEach(k => {
      const bars = rows[k].slice().sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
      const root = {};                    // instance id → the task it's a version of
      bars.forEach((b, idx) => {
        const t = byId[b.task]; if (!t || t.kind === 'ignore') return;
        if (KO_RE.test(clean(t.label))) {
          // the work it kicks off: the next bar to start, else the one it sits inside
          const next = bars.slice(idx + 1).find(o => byId[o.task] && !KO_RE.test(clean(byId[o.task].label)) && byId[o.task].kind === 'task' && daysBetween(b.end, o.start) <= 21);
          const inside = bars.find(o => o !== b && o.start <= b.start && o.end >= b.end && byId[o.task] && !KO_RE.test(clean(byId[o.task].label)) && byId[o.task].kind === 'task');
          const owner = inside && (!next || daysBetween(inside.start, b.start) <= daysBetween(b.end, next.start) + 30) ? inside : next;
          if (owner) vote(kVotes, t.id, owner.task);
          return;
        }
        const v = versionNum(t.label);
        if (!v) return;
        let parent = null;
        if (v.kind === 'v' && v.n >= 2) {
          // V3 follows the V2 before it on the row, V2 the V1
          parent = bars.slice(0, idx).reverse().find(o => { const x = byId[o.task] && versionNum(byId[o.task].label); return x && x.kind === 'v' && x.n === v.n - 1; });
        } else if (v.kind === 'ord') {
          // 1st follows whatever's just before it; 2nd follows 1st…
          const prev = bars.slice(0, idx).reverse().find(o => byId[o.task] && !KO_RE.test(clean(byId[o.task].label)));
          if (prev && daysBetween(prev.end, b.start) <= 7) parent = prev;
        }
        if (!parent) return;
        const r = root[parent.id] || parent.task;
        if (r === t.id) return;
        root[b.id] = r;
        vote(vVotes, t.id, r);
      });
    });
    const winner = (m, need) => {
      const k = Object.keys(m || {}).sort((a, b) => m[b] - m[a])[0];
      return k && m[k] >= need ? k : null;
    };
    tasks.forEach(t => {
      const r = winner(vVotes[t.id], Math.max(1, Math.ceil(t.count / 2)));
      if (r && byId[r] && byId[r].kind === 'task') t.versionOf = r;
    });
    // a chain resolves to its first task (1st → ANIMATIC, so 2nd → ANIMATIC too)
    tasks.forEach(t => { let g = 0; while (t.versionOf && byId[t.versionOf] && byId[t.versionOf].versionOf && g++ < 20) t.versionOf = byId[t.versionOf].versionOf; });
    /* Anything sitting between a task's versions on the same row (R1 between
       V1 and V2, a "Rev") is that task's review time — the gap before the
       next version already holds it — so it's set aside, not made a task. */
    const roots = {};
    tasks.forEach(t => { if (t.versionOf) roots[t.versionOf] = 1; });
    const span = {};                    // ep/row → [{ root, start, end }]
    instances.forEach(i => {
      const t = byId[i.task]; if (!t || i.offGrid) return;
      const root = t.versionOf || (roots[t.id] ? t.id : null); if (!root) return;
      const k = i.ep + '/' + i.row, list = span[k] = span[k] || [];
      let x = list.find(z => z.root === root);
      if (!x) list.push(x = { root, start: i.start, end: i.end });
      if (i.start < x.start) x.start = i.start; if (i.end > x.end) x.end = i.end;
    });
    tasks.forEach(t => {
      if (t.versionOf || roots[t.id] || t.kind !== 'task' || KO_RE.test(clean(t.label))) return;
      const mine = instances.filter(i => i.task === t.id && !i.offGrid);
      const inside = {};
      mine.forEach(i => (span[i.ep + '/' + i.row] || []).forEach(x => { if (i.start > x.start && i.end < x.end) inside[x.root] = (inside[x.root] || 0) + 1; }));
      const r = winner(inside, Math.max(1, Math.ceil(mine.length / 2)));
      if (r) { t.reviewOf = r; t.kind = 'ignore'; }
    });
    tasks.forEach(t => {
      const o = winner(kVotes[t.id], Math.max(1, Math.ceil(t.count / 2)));
      if (o && byId[o] && !byId[o].versionOf && byId[o].kind === 'task' && !tasks.some(x => x !== t && x.koFor === o)) { t.koFor = o; t.kind = 'task'; t.dept = byId[o].dept; }
    });
    /* A Kick Off comes before its work. Where the sheet coloured the task's
       bar from before its KO (Studio from the 26th, KO on the 28th), the task
       starts the working day after the KO instead. */
    const nextWorkday = (iso) => { let x = addDaysIso(iso, 1); while ([0, 6].indexOf(new Date(x + 'T00:00:00Z').getUTCDay()) >= 0) x = addDaysIso(x, 1); return x; };
    tasks.forEach(ko => {
      if (!ko.koFor) return;
      instances.forEach(k => {
        if (k.task !== ko.id || k.removed) return;
        const own = instances.find(i => i.task === ko.koFor && i.ep === k.ep && !i.removed && i.start <= k.start && i.end > k.end);
        if (own) { own.start = nextWorkday(k.end); own.afterKo = true; }
      });
    });
    measure(tasks, instances);
  }
  // a task's versions after V1, in the order they run
  function versionsOf(tasks, rootId) {
    return tasks.filter(t => t.versionOf === rootId && t.kind === 'task').sort((a, b) => a.offset - b.offset);
  }

  /* Each task's typical length and where it typically starts relative to
     its episode — from the instances as they stand, so a stretched bar
     counts. Called again whenever the wizard needs fresh numbers. */
  function measure(tasks, instances) {
    const epStart = {};
    instances.forEach(i => { if (!i.removed && !i.offGrid && (!epStart[i.ep] || i.start < epStart[i.ep])) epStart[i.ep] = i.start; });
    const by = {};
    instances.forEach(i => { if (!i.removed) (by[i.task] = by[i.task] || []).push(i); });
    tasks.forEach(t => {
      const mine = by[t.id] || [];
      t.count = mine.length;
      t.days = Math.max(1, median(mine.map(i => daysBetween(i.start, i.end) + 1)));
      t.offset = median(mine.filter(i => epStart[i.ep]).map(i => daysBetween(epStart[i.ep], i.start)));
    });
  }

  /* Would making `task` wait for `on` close a loop? deps: id → [ids]. */
  function wouldLoop(deps, task, on) {
    if (task === on) return true;
    const seen = {};
    const stack = [on];
    while (stack.length) {
      const k = stack.pop();
      if (k === task) return true;
      if (seen[k]) continue;
      seen[k] = 1;
      (deps[k] || []).forEach(d => stack.push(d));
    }
    return false;
  }

  /* A first pass at dependencies, from the dates alone: each task waits for
     the task that, across most episodes, finishes closest before it starts —
     on its own track first (RED DATES follows RED DATES), else anywhere. */
  function suggestDeps(tasks, instances) {
    // a task and its later versions are one thing here, ending with its last version
    const byId = {}; tasks.forEach(t => { byId[t.id] = t; });
    const use = tasks.filter(t => t.kind === 'task' && !t.versionOf);
    const at = {};                                // ep → task → { start, end }
    instances.forEach(i => {
      if (i.removed) return;
      const t = byId[i.task]; if (!t || t.kind !== 'task') return;
      const id = t.versionOf || t.id;
      const m = at[i.ep] = at[i.ep] || {};
      if (!m[id]) m[id] = { start: i.start, end: i.end };
      else { if (i.start < m[id].start && !t.versionOf) m[id].start = i.start; if (i.end > m[id].end) m[id].end = i.end; }
    });
    const deps = {};
    use.forEach(t => {
      const score = {};
      Object.keys(at).forEach(ep => {
        const me = at[ep][t.id]; if (!me) return;
        let best = null;
        use.forEach(o => {
          if (o.id === t.id) return;
          const it = at[ep][o.id];
          if (!it || it.end >= me.start) return;
          const gap = daysBetween(it.end, me.start);
          const rank = gap + (o.track === t.track ? 0 : 3);
          if (!best || rank < best.rank) best = { id: o.id, rank };
        });
        if (best) score[best.id] = (score[best.id] || 0) + 1;
      });
      const top = Object.keys(score).sort((a, b) => score[b] - score[a])[0];
      if (top && score[top] >= Math.max(1, Math.floor(t.count / 2)) && !wouldLoop(deps, t.id, top)) deps[t.id] = [top];
    });
    return deps;
  }

  /* ================= BUILD =================
     The confirmed draft → a show back-up App.importShow already knows how to
     load. plan = { show: {name, prefix, type}, episodes: [{r, code, title,
     include}], tasks: [{id, name, dept, kind}], instances, deps: {taskId:
     [taskId]}, order: [taskId] }. kind is task | live | delivery | note | ignore. Returns the
     payload and a list of warnings worth showing before Create. */
  function build(model, plan) {
    const taskBy = {};
    plan.tasks.forEach(t => { taskBy[t.id] = t; });
    measure(plan.tasks, plan.instances);
    // a task's later versions aren't pipeline tasks — they're its revisions
    const live = plan.tasks.filter(t => t.kind === 'task' && !(t.versionOf && taskBy[t.versionOf] && taskBy[t.versionOf].kind === 'task'));
    const liveIds = {}; live.forEach(t => { liveIds[t.id] = 1; });
    const vers = {};                    // root id → its version tasks, in order
    live.forEach(t => { const v = versionsOf(plan.tasks, t.id); if (v.length) vers[t.id] = v; });
    // an instance per episode per task, for the version maths below
    const at = {};
    plan.instances.forEach(i => { if (!i.removed) (at[i.ep] = at[i.ep] || {})[i.task] = i; });
    const kos = {};                     // owner id → its Kick Off task
    live.forEach(t => { if (t.koFor && liveIds[t.koFor]) kos[t.koFor] = t; });
    // pipeline keys: unique slugs of the names
    const used = {};
    live.forEach(t => {
      let k = slug(t.name), i = 2;
      while (used[k]) k = slug(t.name) + '_' + i++;
      used[k] = 1; t.key = k;
    });
    // dependencies the way Add Show keeps them: a task with a Kick Off waits
    // on the KO alone, and the KO carries what the task would have waited on
    const deps = {};
    // a link to a later version is a link to its task
    const owner = (d) => taskBy[d] && taskBy[d].versionOf && liveIds[taskBy[d].versionOf] ? taskBy[d].versionOf : d;
    Object.keys(plan.deps || {}).forEach(k => {
      const kk = owner(k);
      deps[kk] = (deps[kk] || []).concat((plan.deps[k] || []).map(owner)).filter((d, i, a) => liveIds[d] && d !== kk && a.indexOf(d) === i);
    });
    Object.keys(kos).forEach(owner => {
      const ko = kos[owner];
      const pass = (deps[owner] || []).concat(deps[ko.id] || []).filter(d => d !== ko.id && d !== owner);
      deps[ko.id] = pass.filter((d, i) => pass.indexOf(d) === i);
      deps[owner] = [ko.id];
    });
    // the order the producer left the list in, else the order the work runs
    const pos = {};
    (plan.order || []).forEach((id, i) => { pos[id] = i; });
    const rank = (t) => pos[t.id] != null ? pos[t.id] : 1e6 + t.offset;
    const pipeline = live.slice().sort((a, b) => rank(a) - rank(b) || a.offset - b.offset).map(t => {
      const p = { key: t.key, name: clean(t.name) || t.label, dept: t.dept, days: t.days, minDays: Math.max(1, Math.ceil(t.days / 2)),
        deps: (deps[t.id] || []).map(d => taskBy[d]).filter(d => d && d.kind === 'task').map(d => d.key) };
      // versions: one revision per later round, its typical days and the
      // typical review before it; each episode keeps its own (below)
      const v = vers[t.id];
      if (v) {
        p.maxRev = v.length;
        p.revDays = v.map(x => x.days);
        const gaps = v.map((x, r) => median(Object.keys(at).map(ep => {
          const prev = at[ep][r ? v[r - 1].id : t.id], me = at[ep][x.id];
          return prev && me ? Math.max(0, daysBetween(prev.end, me.start) - 1) : null;
        }).filter(n => n != null)));
        if (gaps.some(n => n > 0)) p.revGaps = gaps;
      }
      // a Kick Off: one day, on the weekday it's usually held
      if (t.koFor && kos[t.koFor] === t) {
        p.ko = true; p.koFor = taskBy[t.koFor].key; p.days = 1; p.minDays = 1;
        const dows = {};
        plan.instances.forEach(i => { if (i.task === t.id && !i.removed) { const d = new Date(i.start + 'T00:00:00Z').getUTCDay(); dows[d] = (dows[d] || 0) + 1; } });
        const top = Object.keys(dows).sort((a, b) => dows[b] - dows[a])[0];
        if (top != null) p.koDay = +top;
        p.name = (clean(taskBy[t.koFor].name) || 'Task') + ' KO';
      }
      return p;
    });
    // a KO sits directly above its task, the way Add Show orders them
    pipeline.slice().forEach(p => {
      if (!p.ko) return;
      pipeline.splice(pipeline.indexOf(p), 1);
      const o = pipeline.findIndex(x => x.key === p.koFor);
      pipeline.splice(o < 0 ? pipeline.length : o, 0, p);
    });
    const warnings = [];
    const episodes = [];
    const notes = [];
    const byEp = {};
    plan.instances.forEach(i => { if (!i.removed) (byEp[i.ep] = byEp[i.ep] || []).push(i); });
    plan.episodes.filter(e => e.include).forEach((e, n) => {
      const code = clean(e.code) || ('EP' + (n + 1));
      const dates = {}, milestones = {};
      (byEp[e.r] || []).forEach(i => {
        const tk = taskBy[i.task];
        if (!tk || tk.kind === 'ignore') return;
        if (tk.kind === 'live') { if (!milestones.live_date || i.start < milestones.live_date) milestones.live_date = i.start; return; }
        if (tk.kind === 'delivery') { if (!milestones.delivery_date || i.start < milestones.delivery_date) milestones.delivery_date = i.start; return; }
        if (tk.kind === 'note') { notes.push({ start: i.start, due: i.end, text: code + ' · ' + (clean(tk.name) || tk.label), color: '#f6be00' }); return; }
        if (!liveIds[tk.id]) return;           // a later version — handled with its task
        dates[tk.key] = { start: i.start, due: i.end };
      });
      // each task's later versions in this episode: their own days and gaps,
      // and their dates (for statuses and the clash check)
      const revDays = {}, revGaps = {}, versions = {};
      Object.keys(vers).forEach(rid => {
        const root = taskBy[rid], first = at[e.r] && at[e.r][rid];
        if (!first || !dates[root.key]) return;
        let prev = first;
        const ds = [], gs = [], vs = [];
        vers[rid].forEach((x, r) => {
          const me = at[e.r][x.id];
          if (!me) { ds[r] = undefined; gs[r] = undefined; return; }
          ds[r] = daysBetween(me.start, me.end) + 1;
          gs[r] = Math.max(0, daysBetween(prev.end, me.start) - 1);
          vs.push({ start: me.start, due: me.end });
          prev = me;
        });
        if (vs.length) { revDays[root.key] = ds; revGaps[root.key] = gs; versions[root.key] = vs; }
      });
      const removed = pipeline.filter(p => !dates[p.key]).map(p => p.key);
      if (!Object.keys(dates).length) { warnings.push({ code, msg: 'No tasks left — skipped' }); return; }
      const lastDue = Object.keys(dates).reduce((m, k) => dates[k].due > m ? dates[k].due : m, '');
      if (milestones.live_date && lastDue > milestones.live_date) warnings.push({ code, msg: 'Work runs to ' + lastDue + ', past its live date ' + milestones.live_date });
      // a task that starts before something it waits for has finished —
      // its last version, since dependents wait for that
      const lastEnd = (k) => versions[k] && versions[k].length ? versions[k][versions[k].length - 1].due : dates[k].due;
      pipeline.forEach(p => {
        const me = dates[p.key]; if (!me) return;
        p.deps.forEach(dk => {
          if (dates[dk] && lastEnd(dk) >= me.start) warnings.push({ code, msg: p.name + ' starts before ' + (pipeline.find(x => x.key === dk) || {}).name + ' has finished', clash: true });
        });
      });
      if (!milestones.live_date) warnings.push({ code, msg: 'No live date found — one will be worked out from the schedule', soft: true });
      const out = { id: 'imp' + n, code, title: clean(e.title) || code, shiftDays: 0, dates, statuses: {}, assignees: {} };
      if (removed.length) out.removed = removed;
      if (Object.keys(revDays).length) { out.revDays = revDays; out.revGaps = revGaps; }
      // the versions' own dates, for working out statuses — not stored
      if (Object.keys(versions).length) out._versions = versions;
      if (Object.keys(milestones).length) out.milestones = milestones;
      episodes.push(out);
    });
    const show = { name: clean(plan.show.name), prefix: clean(plan.show.prefix).toUpperCase(), type: plan.show.type || 'animation', pipeline };
    if (notes.length) show.notes = notes;
    return {
      warnings,
      payload: { format: 'postpipeline.show-backup', exportedAt: null, show, episodes }
    };
  }

  App.smartImportEngine = {
    analyse, collectTasks, measure, suggestDeps, wouldLoop, build, detect, detectStructure, versionsOf, parseEpisodeLabel, guessDept, textDateAfter, serialToIso, prettyLabel,
    addDays: addDaysIso, daysBetween,
    _internal: { trackKey, familyOf, slug }
  };
})(typeof window !== 'undefined' ? window : globalThis);
