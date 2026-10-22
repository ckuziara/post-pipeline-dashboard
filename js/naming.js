/* Naming Conventions (Admin → Workflow → Naming Conventions): how delivered
   files are named, and the codes each part of a name can take. The defaults
   are the company's standard document; admins edit any table, and an edited
   table replaces its default for everyone (d.naming).

   Also loaded by the server (require('./js/naming.js')), where the QC report
   uses the suffix table to label its Assets column — so nothing above the
   Admin panel may touch the DOM. */
(function (App) {
  App.NAMING_DEFAULTS = {
    pattern: '[Content Code][Language]_[Format]_[Suffix]',
    // two made-up deliveries the examples are built from, by filling each
    // [Part] of the format in with its value here
    samples: [
      { 'Content Code': 'KYI0246', Language: 'ENUS', Format: 'SONG', Suffix: 'SONGMASTER' },
      { 'Content Code': 'KYI0246', Language: 'ENUS', Format: 'FD', Suffix: 'NOIO-TEXTED-BITC' }
    ],
    tables: [
      { key: 'formats', title: 'Formats', desc: 'The Format is one of these options.',
        cols: ['Format Code', 'Full Name', 'Description'],
        rows: [["FN", "Full Narration", "Episode is driven by narration rather than character speech."], ["FD", "Full Dialogue", "Episode is driven by characters speech."], ["ND", "Non Dialogue", "There is no speech or narration."], ["Song", "Song", "Episode is driven by Song rather than speech or narration."]] },
      { key: 'suffixes', title: 'Suffixes', desc: 'The Suffix drives processes in Moonbase — files that don’t match the naming convention are rejected at ingest.',
        cols: ['Suffix', 'Type', 'Label', 'Description'], typeCol: 1,
        rows: [["IO-TEXTED", "MOV", "IO Texted Video Master", "Video Master With text on screen with Intro / Outro"], ["NOIO-TEXTED", "MOV", "No IO Texted Video Master", "Video Master With text on screen without Intro / Outro"], ["IO-TEXTED", "MP4", "IO Texted Video MP4", "Video Master MP4 Copy with text on screen with Intro / Outro"], ["NOIO-TEXTED", "MP4", "No IO Texted Video MP4", "Video Master MP4 Copy with text on screen without Intro / Outro"], ["IO-TEXTED-BITC", "MP4", "IO Texted BITC", "Video Master MP4 Copy With Burnt In Timecode with Intro / Outro"], ["NOIO-TEXTED-BITC", "MP4", "No IO Texted BITC", "Video Master MP4 Copy With Burnt In Timecode without Intro / Outro"], ["IO-TEXTLESS", "MOV", "IO Textless Video Master", "Video Master with no text on screen with Intro / Outro"], ["NOIO-TEXTLESS", "MOV", "No IO Textless Video Master", "Video Master with no text on screen without Intro / Outro"], ["IO-TEXTLESS", "MP4", "IO Textless Video MP4", "Video Master MP4 Copy with no text on screen with Intro / Outro"], ["NOIO-TEXTLESS", "MP4", "No IO Textless Video MP4", "Video Master MP4 Copy with no text on screen without Intro / Outro"], ["IO-TEXTLESS-BITC", "MP4", "IO Textless BITC", "Video Master MP4 Copy with Burnt In Timecode with Intro / Outro"], ["NOIO-TEXTLESS-BITC", "MP4", "No IO Textless BITC", "Video Master MP4 Copy with Burnt In Timecode without Intro / Outro"], ["MNE", "WAV", "M&E Mix", "M&E mix (Score and SFX)"], ["MIX", "WAV", "Mix", "Mixed Audio Master"], ["SFX", "WAV", "SFX", "SFX only"], ["SCR", "WAV", "Score", "Score audio stem"], ["DIA", "WAV", "Dialogue", "Clean Spoken Dialogue"], ["ACA", "WAV", "Vocal Only Song Master", "A cappella. Clean Song Vocals."], ["EPISODIC-MUSICMIX", "WAV", "Inst Sync To Episode", "Synchronised Instrumental music to the final episode"], ["MNE-FOLEY", "WAV", "Foley MNE", "MNE with Foley"], ["SP", "DOCX, DOC, PDF", "Script", "Script (Time coded final transcript)"], ["GFXINS-SP", "DOC, DOCX, PDF, XLSX, XLS", "Graphics Insert Report", "Localised Graphics Script"], ["SPSUB", "DOCX, DOC, PDF", "TC Script Standard Sub", "Time-coded Scripts (Standard Subs only) Different from Dia"], ["CREDIT", "csv, PNG, XLS, XLSX, tiff / tif", "Credit", "Dub Cards"], ["IO-TEXTED-CATSUB", "MP4", "Caterpillar Subtitles MP4 with Intro / Outro", "Burnt in Caterpillar Style Subtitles for YouTube Subtitle Channel with Intro/Outro"], ["NOIO-TEXTED-CATSUB", "MP4", "Caterpillar Subtitles MP4 without Intro / Outro", "Burnt in Caterpillar Style Subtitles for YouTube Subtitle Channel without Intro/Outro"], ["AD-MIX", "WAV", "Audio Desc Mix", "Audio Described Final Mix"], ["AD-VOX", "WAV", "Audio Desc Clean Vocal / Dia", "Audio Described Clean Vocal Stems"], ["AD-SP", "DOCX, DOC, PDF", "Audio Desc Script", "Audio Description Script"], ["SUB", "SRT", "Subtitles", "Standard Subtitles"], ["SCC", "SRT", "CC Subtitles", "Closed Caption Subtitles (Also known as Scenarist Closed Captions)"], ["SUB-KAR", "aep", "Karaoke Subs aep", "Karaoke Subtitles"], ["ALPHA-KAR", "MOV", "Karaoke Subs Alpha", "Karaoke Subtitles"], ["SONGMASTER", "WAV", "Mixed Song Master", "Mixed Song Master (No SFX)"], ["SONGMASTER-RADIOEDIT", "WAV", "Songmaster Radio Edit", "Created when SONGMASTER needs to be trimmed"], ["ACA -RADIOEDIT", "WAV", "ACA / Clean Vocal Radio Edit", "Created when ACA needs to be trimmed"], ["AMB", "WAV", "Ambience", "Ambience SFX"], ["SCR-CUE", "WAV", "Score Cue", "Score Cue"], ["INST", "WAV", "Instrumental Master Mix", "Instrumental only mix (no vocals or SFX)"], ["INST-RADIOEDIT", "WAV", "Instrumental Master Radio Edit", "Created when INST needs to be trimmed"], ["THUMB-SINGLE", "PNG, JPG", "Thumbnail Single", "Thumbnail to identify single episode"], ["THUMB-COMP", "PNG, JPG", "Thumbnail Compilation", "Thumbnail to identify compilations"], ["GFX", "aep", "Graphics", "GFX Files (On Screen Graphics)"], ["TITLECARD", "PNG, JPG, MP4, MOV", "Title Card", "Title Card to go in front of episodes or compilations."], ["ENHANCED-TITLECARD", "MOV", "Enhanced Title Card Video Master", "Enhanced Title Card with Parental messaging and Voice Over Video Master"], ["ENHANCED-TITLECARD", "MP4", "Enhanced Title Card MP4", "Enhanced Title Card with Parental messaging and Voice Over MP4"], ["ENHANCED-TITLECARD", "WAV", "Enhanced Title Card Dialogue", "Enhanced Title Card Clean Voice Over"], ["LY-TC", "DOCX, DOC, PDF", "Timecoded Lyrics", "Timecoded Lyrics for QC and Localisation"], ["LY-CL", "DOCX, DOC, PDF, TXT", "Clean Lyrics", "Clean Lyrics"], ["LY-TCSUB", "DOCX, DOC, PDF, TXT", "TC Sub Lyrics", "Timecoded Lyrics for Subtitles Only"], ["VOTITLE", "WAV", "Voice Over Title", "Used for Netflix Cocomelon deliveries character voice introduction to episode"], ["ALPHA-GFX", "MOV", "Alpha Channel", "GFX Alpha File"], ["IO-TEXTED-MP4-QC", "PDF, CSV, XLSX, XLS", "IO Auto QC Texted MP4", "Vidchecker or other automated QC Texted MP4 with Intro / Outro"], ["NOIO-TEXTED-MP4-QC", "PDF, CSV, XLSX, XLS", "No IO Auto QC Texted MP4", "Vidchecker or other automated QC Texted MP4 without Intro / Outro"], ["IO-TEXTED-PR-QC", "PDF, CSV, XLSX, XLS", "IO Auto QC Texted ProRes", "Vidchecker or other automated QC Texted ProRes with Intro / Outro"], ["NOIO-TEXTED-PR-QC", "PDF, CSV, XLSX, XLS", "No IO Auto QC Texted ProRes", "Vidchecker or other automated QC Texted ProRes without Intro / Outro"], ["IO-TEXTLESS-MP4-QC", "PDF, CSV, XLSX, XLS", "IO Auto QC Textless MP4", "Vidchecker or other automated QC Textless MP4 with Intro / Outro"], ["NOIO-TEXTLESS-MP4-QC", "PDF, CSV, XLSX, XLS", "No IO Auto QC Textless MP4", "Vidchecker or other automated QC Textless MP4 without Intro / Outro"], ["IO-TEXTLESS-PR-QC", "PDF, CSV, XLSX, XLS", "IO Auto QC Textless ProRes", "Vidchecker or other automated QC Textless ProRes with Intro / Outro"], ["NOIO-TEXTLESS-PR-QC", "PDF, CSV, XLSX, XLS", "No IO Auto QC Textless ProRes", "Vidchecker or other automated QC Textless ProRes without Intro / Outro"], ["EQC", "PDF, CSV, XLSX", "Eyeball QC", "Eyeball QC"], ["MCS", "TXT, CSV, XLSX, XLS", "Music Cue Sheet", "EDL export to be used as a Cue Sheet"]] },
      { key: 'languages', title: 'Language Codes', desc: 'Also listed in the Reference Data section on Moonbase.',
        cols: ['Code', 'Language'],
        rows: [["ASL", "American Sign Language"], ["MSA", "Arabic (Modern Standard)"], ["ARA", "Arabic (Unknown Dialect)"], ["AD-ENUS", "Audio Description English US"], ["AD-ENGB", "Audio Description English GB"], ["IND", "Bahasa Indonesia (Indonesian)"], ["MAY", "Bahasa Malayu (Malaysia)"], ["BUL", "Bulgarian"], ["MAN", "Chinese (Mandarin)"], ["TWN", "Chinese (Taiwan)"], ["CRO", "Croatian"], ["CZE", "Czech"], ["DAN", "Danish"], ["DUT", "Dutch"], ["ENUS", "English (American)"], ["ENGB", "English (British)"], ["EST", "Estonian"], ["FIN", "Finnish"], ["FRE", "French"], ["FR-CA", "French (Canadian)"], ["FRP", "French (Parisian)"], ["GER", "German"], ["GRE", "Greek"], ["HEB", "Hebrew"], ["HIN", "Hindi"], ["HUN", "Hungarian"], ["ICE", "Icelandic"], ["ITA", "Italian"], ["JPN", "Japanese"], ["KOR", "Korean"], ["LAT", "Latvian"], ["LIT", "Lithuanian"], ["MAO", "Maori"], ["MAL", "Malay"], ["NON", "Non Dialogue"], ["NOR", "Norwegian"], ["POL", "Polish"], ["BPOR", "Portuguese (Brazilian)"], ["EPOR", "Portuguese (European)"], ["ROM", "Romanian"], ["RUS", "Russian"], ["SER", "Serbian"], ["SLK", "Slovakian"], ["SLO", "Slovenian"], ["CAS", "Spanish (Castillian)"], ["LAS", "Spanish (Latin American)"], ["SWE", "Swedish"], ["TAG", "Tagalog"], ["TAM", "Tamil"], ["THA", "Thai"], ["TUR", "Turkish"], ["UKR", "Ukrainian"], ["VIE", "Vietnamese"], ["EAMN", "Vocal English American. English & Mandarin Subtitles"], ["EBMN", "Vocal English British. English & Mandarin Subtitles"]] }
    ]
  };

  /* File types a suffix can be delivered as — exactly one per row. A suffix
     that comes in several types (a script as DOCX, DOC or PDF) is one row per
     type, the way the standard document already lists IO-TEXTED as MOV and
     MP4. Any type already used in the table is offered too, and a new one can
     be typed in. */
  App.FILE_TYPES = ['MOV', 'MP4', 'MXF', 'WAV', 'AIFF', 'MP3', 'AAC', 'DOCX', 'DOC', 'PDF', 'TXT', 'RTF',
    'XLSX', 'XLS', 'CSV', 'XML', 'JSON', 'SRT', 'SCC', 'VTT', 'STL', 'PNG', 'JPG', 'TIFF', 'TIF', 'PSD',
    'EXR', 'DPX', 'AEP', 'PRPROJ', 'ZIP'];
  const splitTypes = (v) => String(v || '').split(/[,/]/).map(s => s.trim().toUpperCase()).filter(Boolean)
    .filter((t, i, a) => a.indexOf(t) === i);

  /* The live convention: each part falls back to its default until an admin
     saves their own. Tables are copied, so callers can't edit state by accident;
     a row naming several types (the source document does) becomes one row each. */
  App.namingConfig = function (stored) {
    // stored: a board's d.naming — the server passes its own; the browser reads the live board
    const raw = (stored !== undefined ? stored : App.state && App.state.data && App.state.data.naming) || {};
    const D = App.NAMING_DEFAULTS;
    return {
      pattern: raw.pattern || D.pattern,
      tables: D.tables.map(t => {
        const src = raw.tables && Array.isArray(raw.tables[t.key]) ? raw.tables[t.key] : t.rows;
        const rows = [];
        src.forEach(r => {
          const row = t.cols.map((_, i) => r[i] || '');
          if (t.typeCol == null) { rows.push(row); return; }
          const types = splitTypes(row[t.typeCol]);
          (types.length ? types : ['']).forEach(ty => { const x = row.slice(); x[t.typeCol] = ty; rows.push(x); });
        });
        return Object.assign({}, t, { rows, custom: src !== t.rows });
      })
    };
  };

  /* The suffix codes, longest first, so NOIO-TEXTED-BITC is found before
     TEXTED-BITC could be. */
  App.namingSuffixes = (stored) => {
    const t = App.namingConfig(stored).tables.find(x => x.key === 'suffixes');
    return t.rows.map(r => r[0].trim()).filter((v, i, a) => v && a.indexOf(v) === i).sort((a, b) => b.length - a.length);
  };

  /* What a delivered file is, by the naming convention: the suffix the name
     ends with. "EMWW0103_ACA.wav" → ACA, "KYI0246ENUS_SONG_NOIO-TEXTED-BITC.mp4"
     → NOIO-TEXTED-BITC. A version tag after the suffix is looked past
     ("EMWW0122_SFX_v2.mov" → SFX). null when the name ends in no known
     suffix — the file doesn't follow the convention, and the QC report
     flags it rather than guessing. */
  App.assetSuffix = (name, suffixes) => {
    const n = String(name || '');
    const dot = n.lastIndexOf('.');
    const B = (dot > 0 ? n.slice(0, dot) : n).replace(/[_\- ]v\d+$/i, '').toUpperCase();
    return (suffixes || []).find(sx => { const S = sx.toUpperCase(); return B === S || B.endsWith('_' + S); }) || null;
  };

  /* ---- Building names (PAM) -------------------------------------------
     Every file PAM writes is named here, browser and server alike:
       [Content Code][Language]_[Format]_[Suffix]_v###.<ext>
     Mezzanine and Reviews keep the version tag; Publish drops it, so what
     lands there is exactly what Moonbase ingests. */

  // LA-101 → LA0101, KYI-246 → KYI0246: letters, then the number padded to 4
  App.contentCodeFor = (ep) => {
    if (ep && ep.contentCode) return String(ep.contentCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const c = String((ep && ep.code) || '').toUpperCase();
    const m = c.match(/^([A-Z]+)[^A-Z0-9]*(\d+)$/);
    return m ? m[1] + m[2].padStart(4, '0') : c.replace(/[^A-Z0-9]/g, '');
  };

  /* What a pipeline task must hand over: one row per file, by suffix and
     type. A task's own `outputs` win; then these defaults for the stock
     pipelines; anything else delivers one file named after its deliverable
     folder (STORYBOARD, ANIMATIC…) in whatever type it is. */
  App.DEFAULT_OUTPUTS = {
    scripts: [['SP', 'PDF']],
    song_master: [['SONGMASTER', 'WAV'], ['ACA', 'WAV'], ['INST', 'WAV']],
    music_score: [['SCR', 'WAV']],
    final_mix: [['MIX', 'WAV'], ['MNE', 'WAV'], ['DIA', 'WAV']],
    subtitle: [['SUB', 'SRT']],
    final_lrc: [['NOIO-TEXTED', 'MOV']],
    online_conform: [['NOIO-TEXTED', 'MOV'], ['NOIO-TEXTLESS', 'MOV']],
    deliverys: [['IO-TEXTED', 'MOV'], ['IO-TEXTED', 'MP4'], ['NOIO-TEXTED-BITC', 'MP4']]
  };
  // deliverable folder → suffix: "Layout_Blocking" → LAYOUT-BLOCKING
  const groupSuffix = (g) => String(g || 'FILE').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  App.taskOutputs = (task, deliverable) => {
    const own = task && Array.isArray(task.outputs) && task.outputs.length ? task.outputs.map(o => [o.suffix, o.type]) : null;
    const rows = own || (task && App.DEFAULT_OUTPUTS[task.key]) || [[groupSuffix(deliverable || (task && task.name)), '']];
    return rows.map(([suffix, type]) => ({ suffix: String(suffix || '').trim().toUpperCase(), type: String(type || '').trim().toUpperCase() }))
      .filter(o => o.suffix);
  };

  // Language and format: the episode's own, else the show's, else English US / no format yet
  App.namingIdentity = (ep, show) => ({
    contentCode: App.contentCodeFor(ep),
    languages: [].concat((ep && ep.languages) || (show && show.languages) || ['ENUS']).filter(Boolean),
    format: (ep && ep.format) || (show && show.format) || ''
  });

  App.buildName = ({ contentCode, language, format, suffix, version, ext }) => {
    const v = version == null ? '' : '_v' + String(version).padStart(3, '0');
    const e = ext ? '.' + String(ext).replace(/^\./, '').toLowerCase() : '';
    return String(contentCode) + String(language || '') + '_' + String(format) + '_' + String(suffix) + v + e;
  };

  /* Every file one task is expected to deliver, as name stems (no version, no
     extension). Missing pieces come back in `problems` rather than as a
     half-built name, so PAM can say what to fill in. */
  App.expectedFiles = (ep, show, task, deliverable) => {
    const id = App.namingIdentity(ep, show);
    const problems = [];
    if (!id.contentCode) problems.push('This episode has no content code');
    if (!id.format) problems.push('Set the show’s Format (FN, FD, ND or Song) in Edit Show');
    const files = [];
    App.taskOutputs(task, deliverable).forEach(o => id.languages.forEach(lang => {
      files.push(Object.assign({}, o, { language: lang,
        stem: problems.length ? null : App.buildName({ contentCode: id.contentCode, language: lang, format: id.format, suffix: o.suffix }) }));
    }));
    return { files, problems };
  };

  /* A name back into its parts, or null if it doesn't follow the convention.
     "KYI0246ENUS_FD_NOIO-TEXTED-BITC_v003.mp4" → { stem, version: 3, ext: 'mp4', … } */
  App.parseName = (name) => {
    const m = String(name || '').match(/^([A-Z0-9-]+)_([A-Za-z]+)_([A-Z0-9-]+?)(?:_v(\d{3,}))?(?:\.([A-Za-z0-9]+))?$/);
    if (!m) return null;
    return { head: m[1], format: m[2], suffix: m[3], version: m[4] ? parseInt(m[4], 10) : null, ext: (m[5] || '').toLowerCase(),
      stem: m[1] + '_' + m[2] + '_' + m[3] };
  };

  // Does a file's extension fit an output's type? An output with no type takes anything.
  App.typeFits = (type, ext) => !type || String(type).toUpperCase() === String(ext || '').toUpperCase() ||
    (/^TIFF?$/i.test(type) && /^tiff?$/i.test(ext)) || (/^JPE?G$/i.test(type) && /^jpe?g$/i.test(ext));

  /* Example names for a format: each [Part] filled in from a sample
     delivery. A part the samples don't know stays as written, [Like This]. */
  App.namingExamples = (pattern) => App.NAMING_DEFAULTS.samples.map(smp =>
    String(pattern || '').replace(/\[([^\]]+)\]/g, (m, k) => {
      const hit = Object.keys(smp).find(x => x.toLowerCase() === k.trim().toLowerCase());
      return hit ? smp[hit] : m;
    }));

  /* patch: { pattern } and/or { table: key, rows } —
     rows: null puts that table back to its default */
  App.setNaming = function (patch, label) {
    if (!App.isAdminRole(App.state.role)) { App.toast('Only admins can change naming conventions', true); return false; }
    App.mutate(d => {
      const n = d.naming = Object.assign({}, d.naming);
      ['pattern'].forEach(k => { if (k in patch) { if (patch[k] == null || patch[k] === '') delete n[k]; else n[k] = patch[k]; } });
      if (patch.table) {
        n.tables = Object.assign({}, n.tables);
        if (patch.rows == null) delete n.tables[patch.table]; else n.tables[patch.table] = patch.rows;
      }
    }, label || 'the naming conventions');
    App.track.audit('naming.change', { part: patch.table || Object.keys(patch).join(', ') });
    return true;
  };

  /* ------------------------------------------------ Admin panel
     Every card reads as plain text until its Edit button is pressed. While
     editing, changes are a draft until Save, so retyping a dozen cells is
     one change (and one undo step) for everyone else, and the draft survives
     the redraws other people's edits cause. */
  const editing = {};         // 'format' or a table key → its draft
  const filters = {};         // table key → search text

  const cardHead = (title, desc, key, extra) => {
    const el = App.el;
    return el('.adm-permcard-head.ncv-head', null, [
      el('div', null, [el('.adm-permcard-title', null, title), el('.adm-permcard-desc', null, desc)]),
      el('.ncv-head-r', null, [extra || null, editing[key]
        ? el('span.ncv-editing', null, 'Editing')
        : el('button.btn-ghost.ncv-edit', { onclick: () => { editing[key] = null; startEdit(key); } }, [App.icon('pencil', { size: 13 }), ' Edit'])])
    ]);
  };
  // the draft is a fresh copy of what's live, taken when Edit is pressed
  function startEdit(key) {
    const cfg = App.namingConfig();
    if (key === 'format') editing.format = { pattern: cfg.pattern };
    else editing[key] = cfg.tables.find(t => t.key === key).rows.map(r => r.slice());
    App.render();
  }
  const stopEdit = (key) => { delete editing[key]; App.render(); };

  App.namingAdmin = function () {
    const el = App.el;
    const cfg = App.namingConfig();
    const wrap = el('.gd-adm');
    wrap.appendChild(formatCard(cfg));
    cfg.tables.forEach(t => wrap.appendChild(tableCard(t)));
    return wrap;
  };

  function formatCard(cfg) {
    const el = App.el;
    const card = el('.adm-permcard');
    card.appendChild(cardHead('File name format', 'How every delivered file is named. The tables below list the codes each part can take.', 'format'));
    const field = (label, body, hint) => el('.ncv-field', null, [el('span.ncv-label', null, label), body, hint ? el('.fld-hint', null, hint) : null]);
    const dr = editing.format;
    if (!dr) {
      card.appendChild(el('.gd-adm-body', null, [
        field('Format', el('.ncv-read.ncv-mono.ncv-pattern', null, cfg.pattern)),
        field('Examples', exampleList(cfg.pattern))
      ]));
      return card;
    }
    const patIn = el('input.fld.ncv-mono', { type: 'text', placeholder: App.NAMING_DEFAULTS.pattern, spellcheck: 'false' });
    patIn.value = dr.pattern;
    // the examples follow the format as it's typed
    const exWrap = el('div', null, exampleList(dr.pattern));
    patIn.addEventListener('input', () => { dr.pattern = patIn.value; exWrap.replaceChildren(exampleList(dr.pattern)); });
    card.appendChild(el('.gd-adm-body', null, [
      field('Format', patIn, 'Write each part in square brackets: [Content Code], [Language], [Format], [Suffix].'),
      field('Examples', exWrap),
      el('.gd-adm-acts', null, [
        el('button.btn-ghost.ncv-reset', {
          title: 'Put the format back to the standard document',
          onclick: () => { dr.pattern = App.NAMING_DEFAULTS.pattern; App.render(); }
        }, '↺ Use the default'),
        el('button.btn-ghost', { onclick: () => stopEdit('format') }, 'Cancel'),
        el('button.btn-primary', {
          onclick: () => {
            // whatever still matches the default is stored as "use the default", so it follows any later change to it
            const D = App.NAMING_DEFAULTS;
            const pat = dr.pattern.trim();
            delete editing.format;
            if (App.setNaming({ pattern: pat === D.pattern ? null : pat }, 'the naming format')) App.toast('Naming format saved');
            else App.render();
          }
        }, 'Save')
      ])
    ]));
    return card;
  }

  function exampleList(pattern) {
    const el = App.el;
    return el('.ncv-read.ncv-mono', null, App.namingExamples(pattern).map(x => el('div', null, x)));
  }

  function tableCard(t) {
    const el = App.el;
    const rows = editing[t.key];
    const edit = !!rows;
    const list = rows || t.rows;
    const widths = t.cols.map((_, i) => i === t.cols.length - 1 ? 'minmax(200px, 2.4fr)' : i === 0 ? 'minmax(170px, 1.2fr)' : 'minmax(100px, 1fr)');
    const cols = 'grid-template-columns: ' + widths.join(' ') + (edit ? ' 30px' : '');
    const card = el('.adm-permcard.ncv-card' + (edit ? '.editing' : ''));
    const count = el('span.ncv-count', null, list.length + ' rows');
    card.appendChild(cardHead(t.title, t.desc, t.key, count));

    const search = el('input.fld.ncv-search', { type: 'search', placeholder: 'Search ' + t.title.toLowerCase() + '…', spellcheck: 'false' });
    search.value = filters[t.key] || '';
    const grid = el('.ncv-grid');
    const applyFilter = () => {
      const q = (filters[t.key] = search.value).trim().toLowerCase();
      grid.querySelectorAll('.ncv-row:not(.head)').forEach(rowEl => {
        rowEl.style.display = !q || rowEl._cells.some(c => c.toLowerCase().includes(q)) ? '' : 'none';
      });
    };
    search.addEventListener('input', applyFilter);

    grid.appendChild(el('.ncv-row.head', { style: cols }, t.cols.map(c => el('.ncv-th', null, c)).concat(edit ? [el('span')] : [])));
    const touch = () => { count.textContent = rows.length + ' rows'; };
    const addRowEl = (r, focus) => {
      const rowEl = el('.ncv-row', { style: cols });
      rowEl._cells = r;
      t.cols.forEach((_, i) => {
        const mono = i === 0 ? '.ncv-mono' : '';
        if (!edit) {
          rowEl.appendChild(el('.ncv-td' + mono, null,
            i === t.typeCol && r[i] ? el('span.ncv-chip', null, r[i]) : r[i]));
        } else if (i === t.typeCol) {
          rowEl.appendChild(typeCell(r, i, () => rows));
        } else {
          // grows with what's typed, so a long description is all on show
          const inp = el('textarea.ncv-cell' + mono, { rows: '1', spellcheck: 'false', 'aria-label': t.cols[i] });
          inp.value = r[i];
          const fit = () => { inp.style.height = 'auto'; inp.style.height = inp.scrollHeight + 'px'; };
          inp.addEventListener('input', () => { r[i] = inp.value.replace(/\n/g, ' '); fit(); });
          inp.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
          requestAnimationFrame(fit);
          rowEl.appendChild(inp);
        }
      });
      if (edit) rowEl.appendChild(el('button.ncv-del', {
        title: 'Remove this row',
        onclick: () => { rows.splice(rows.indexOf(r), 1); rowEl.remove(); touch(); }
      }, App.icon('trash', { size: 13 })));
      grid.appendChild(rowEl);
      if (focus) rowEl.querySelector('textarea, input').focus();
    };
    list.forEach(r => addRowEl(r));

    card.appendChild(el('.ncv-tools', null, [
      search,
      edit ? el('button.btn-ghost', {
        onclick: () => {
          search.value = ''; applyFilter();
          const r = t.cols.map(() => ''); rows.push(r); touch(); addRowEl(r, true);
          grid.lastChild.scrollIntoView({ block: 'nearest' });
        }
      }, '＋ Add row') : null
    ]));
    card.appendChild(el('.ncv-scroll', null, grid));

    if (edit) {
      const save = () => {
        // a row with nothing in it is a mistake, not an entry
        const clean = rows.filter(r => r.some(c => c.trim())).map(r => r.map(c => c.trim()));
        if (t.typeCol != null) {
          const missing = clean.filter(r => !r[t.typeCol]);
          if (missing.length) {
            grid.querySelectorAll('.ncv-row:not(.head)').forEach(n => {
              const cell = n.querySelector('.ncv-type-fld');
              if (cell) cell.classList.toggle('missing', !n._cells[t.typeCol] && n._cells.some(c => c.trim()));
            });
            const first = grid.querySelector('.ncv-type-fld.missing');
            if (first) { search.value = ''; applyFilter(); first.scrollIntoView({ block: 'nearest' }); }
            App.toast(missing.length === 1 ? 'Pick a file type for ' + (missing[0][0] || 'the new row') : 'Pick a file type for ' + missing.length + ' rows', true);
            return;
          }
        }
        delete editing[t.key];
        if (App.setNaming({ table: t.key, rows: clean }, t.title)) App.toast(t.title + ' saved');
        else App.render();
      };
      card.appendChild(el('.ncv-acts', null, [
        t.custom ? el('button.btn-ghost.ncv-reset', {
          title: 'Throw away this table’s edits and use the standard document again',
          onclick: () => {
            if (!confirm('Put ' + t.title + ' back to the default list? Your edits to it are lost.')) return;
            delete editing[t.key];
            App.setNaming({ table: t.key, rows: null }, t.title);
          }
        }, '↺ Back to the default') : null,
        el('button.btn-ghost', { onclick: () => stopEdit(t.key) }, 'Cancel'),
        el('button.btn-primary', { onclick: save }, 'Save')
      ]));
    }
    applyFilter();
    return card;
  }

  /* The Type cell while editing: one file type, picked from a type-to-search
     list. Only a picked (or deliberately created) type counts — half-typed
     text goes back to the last pick when the box is left. */
  function typeCell(r, i, allRows) {
    const offered = () => {
      const used = allRows().map(x => x[i]).filter(Boolean);
      return App.FILE_TYPES.concat(used.filter((u, j, a) => !App.FILE_TYPES.includes(u) && a.indexOf(u) === j));
    };
    const choose = (v) => {
      const ty = splitTypes(v)[0] || '';
      r[i] = ty; combo.set(ty);
      combo.input.classList.remove('missing');
    };
    const combo = App.combo({
      cls: 'ncv-type-fld', value: r[i], placeholder: 'Pick a type…', noun: 'file type',
      values: offered, onPick: choose, onCreate: choose
    });
    combo.input.addEventListener('keydown', (e) => {
      // Enter with nothing highlighted takes the first match ("mx" → MXF);
      // the combo has already handled it when a row was highlighted
      if (e.key === 'Enter' && !e.defaultPrevented && combo.input.value.trim()) {
        e.preventDefault();
        const q = combo.input.value.trim().toLowerCase();
        const hit = offered().find(t => t.toLowerCase().startsWith(q)) || offered().find(t => t.toLowerCase().includes(q));
        combo.close();
        choose(hit || combo.input.value);
      }
    });
    combo.input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== combo.input) combo.set(r[i]); }, 0));
    return combo.input;
  }
})(typeof window !== 'undefined' ? (window.App = window.App || {}) : module.exports);
