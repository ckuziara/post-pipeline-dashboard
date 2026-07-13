/* Journal widget — a per-day notebook on the Dashboard. Block-based editor:
   plain text, to-dos, bullets and headings, with markdown-style triggers
   ("- " or "[] " → to-do, "* " → bullet, "# " → heading), a floating
   format toolbar on text selection, and ruled-paper styling.

   Notes are stored per signed-in user (keyed by email) inside the shared
   board data, so a person's journal follows them to any machine and is
   backed up with everything else. Edits save WITHOUT re-rendering the app —
   the editor owns its DOM while you type. */
window.App = window.App || {};
(function () {
  'use strict';
  const el = (s, p, c) => App.el(s, p, c);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const view = { offset: 0 };          // which day is open (0 = today)
  let cur = null;                      // { dk, blocks } — the live working copy

  /* ------------------------------------------------------------ storage */
  const userKey = () => (App.state.user && App.state.user.email) || 'local';
  const dkFor = (off) => App.isoDate(App.addDays(App.today(), off));

  function loadBlocks(dk) {
    const j = App.state.data.journal;
    const list = j && j[userKey()] && j[userKey()][dk];
    return list && list.length ? JSON.parse(JSON.stringify(list)) : [newBlock('text')];
  }
  function persist() {
    const d = App.state.data;
    d.journal = d.journal || {};
    d.journal[userKey()] = d.journal[userKey()] || {};
    // don't store a single empty text block — keeps the data clean
    const empty = cur.blocks.length === 1 && cur.blocks[0].type === 'text' && !cur.blocks[0].content.trim();
    if (empty) delete d.journal[userKey()][cur.dk];
    else d.journal[userKey()][cur.dk] = cur.blocks;
    App.save();                        // localStorage + debounced server push; no re-render
    updateFooter();
  }
  function newBlock(type) { return { id: uid(), type, content: '', checked: false }; }

  /* ------------------------------------------------------------- render */
  App.journal = {
    render() {
      cur = { dk: dkFor(view.offset), blocks: loadBlocks(dkFor(view.offset)) };

      const body = el('.jr-body');
      cur.blocks.forEach(b => body.appendChild(buildRow(b)));

      const card = el('.jr', null, [
        el('.jr-nav', null, [
          el('button.jr-arrow', { onclick: () => nav(-1) }, '‹'),
          el('span.jr-date', null, dateLabel(view.offset)),
          el('button.jr-arrow', { onclick: () => nav(1) }, '›')
        ]),
        el('.jr-paper', null, body),
        el('.jr-foot', null, [
          el('span.jr-count'),
          el('span.jr-foot-r', null, [
            carryLink(),
            el('button.jr-today' + (view.offset === 0 ? '.off' : ''), {
              onclick: () => { if (view.offset !== 0) nav(-view.offset); }
            }, 'Jump to Today')
          ])
        ]),
        buildToolbar()
      ]);
      this._card = card;
      wireToolbar(card);
      setTimeout(updateFooter, 0);
      return card;
    }
  };

  function nav(delta) {
    view.offset += delta;
    const card = App.journal._card;
    if (card && card.isConnected) card.replaceWith(App.journal.render());
  }

  function dateLabel(off) {
    const d = App.addDays(App.today(), off);
    const nice = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (off === 0) return 'Today, ' + nice;
    if (off === -1) return 'Yesterday, ' + nice;
    if (off === 1) return 'Tomorrow, ' + nice;
    return d.toLocaleDateString('en-US', { weekday: 'short' }) + ', ' + nice;
  }

  /* -------------------------------------------------------------- rows */
  function buildRow(block) {
    const row = el('.jr-row.t-' + block.type + (block.checked ? '.done' : ''));
    row.dataset.bid = block.id;

    if (block.type === 'todo') {
      row.appendChild(el('button.jr-check' + (block.checked ? '.on' : ''), {
        onmousedown: (e) => { e.preventDefault(); toggleTodo(block, row); }
      }, block.checked ? '✓' : ''));
    }
    if (block.type === 'bullet') row.appendChild(el('span.jr-dot'));

    const ed = el('.jr-block', { contenteditable: 'true' });
    ed.innerHTML = block.content;
    if (block.type === 'text' && !block.content) ed.setAttribute('data-ph', 'Start writing…');
    ed.addEventListener('input', () => onInput(block, row, ed));
    ed.addEventListener('keydown', (e) => onKeyDown(e, block, row, ed));
    row.appendChild(ed);
    return row;
  }

  function onInput(block, row, ed) {
    const text = ed.textContent;
    if (block.type === 'text') {          // markdown triggers
      if (text === '- ' || text === '[] ') return convert(block, row, 'todo');
      if (text === '* ') return convert(block, row, 'bullet');
      if (text === '# ') return convert(block, row, 'h1');
    }
    block.content = ed.innerHTML;
    if (block.type === 'text') ed.toggleAttribute('data-ph', false);
    persist();
  }

  function convert(block, row, type) {
    block.type = type; block.content = ''; block.checked = false;
    const nr = buildRow(block);
    row.replaceWith(nr);
    focusEnd(nr.querySelector('.jr-block'));
    persist();
  }

  function toggleTodo(block, row) {
    block.checked = !block.checked;
    row.classList.toggle('done', block.checked);
    const chk = row.querySelector('.jr-check');
    chk.classList.toggle('on', block.checked);
    chk.textContent = block.checked ? '✓' : '';
    persist();
  }

  function onKeyDown(e, block, row, ed) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const inherit = (block.type === 'todo' || block.type === 'bullet') ? block.type : 'text';
      const nb = newBlock(inherit);
      const idx = cur.blocks.findIndex(b => b.id === block.id);
      cur.blocks.splice(idx + 1, 0, nb);
      const nr = buildRow(nb);
      row.after(nr);
      focusEnd(nr.querySelector('.jr-block'));
      persist();
      return;
    }
    if (e.key === 'Backspace' && ed.textContent.trim() === '' && !ed.querySelector('img')) {
      e.preventDefault();
      if (block.type !== 'text') {                       // step 1: strip the format
        convert(block, row, 'text');
        return;
      }
      if (cur.blocks.length > 1) {                       // step 2: remove the line
        const idx = cur.blocks.findIndex(b => b.id === block.id);
        cur.blocks.splice(idx, 1);
        const prev = row.previousElementSibling;
        row.remove();
        if (prev) focusEnd(prev.querySelector('.jr-block'));
        persist();
      }
    }
  }

  function focusEnd(node) {
    if (!node) return;
    node.focus();
    const r = document.createRange();
    r.selectNodeContents(node); r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(r);
  }

  /* ------------------------------------------------------------ footer */
  function updateFooter() {
    const card = App.journal._card;
    if (!card || !card.isConnected) return;
    const todos = cur.blocks.filter(b => b.type === 'todo');
    const donec = todos.filter(b => b.checked).length;
    const c = card.querySelector('.jr-count');
    if (c) c.textContent = todos.length ? donec + ' / ' + todos.length + ' tasks done' : '';
  }

  // "↩ N from yesterday" — offer to pull unfinished to-dos into today
  function carryLink() {
    if (view.offset !== 0) return null;
    const j = App.state.data.journal;
    const y = j && j[userKey()] && j[userKey()][dkFor(-1)];
    const open = (y || []).filter(b => b.type === 'todo' && !b.checked);
    if (!open.length) return null;
    // skip ones already carried over (same text already present today)
    const have = new Set(cur.blocks.map(b => b.content));
    const fresh = open.filter(b => !have.has(b.content));
    if (!fresh.length) return null;
    return el('button.jr-carry', {
      title: 'Copy yesterday’s unfinished to-dos into today',
      onclick: () => {
        fresh.forEach(b => cur.blocks.push({ id: uid(), type: 'todo', content: b.content, checked: false }));
        // drop a lone empty starter block so the list reads cleanly
        if (cur.blocks[0] && cur.blocks[0].type === 'text' && !cur.blocks[0].content.trim() && cur.blocks.length > fresh.length) cur.blocks.shift();
        persist();
        nav(0);
      }
    }, '↩ ' + fresh.length + ' from yesterday');
  }

  /* -------------------------------------------------- floating toolbar */
  function buildToolbar() {
    const btn = (label, cls, cmd, val) => el('button.jr-tb-btn' + (cls || ''), {
      onmousedown: (e) => {
        e.preventDefault();
        document.execCommand('styleWithCSS', false, true);
        document.execCommand(cmd, false, val || null);
        // capture the result into the block model
        const sel = window.getSelection();
        const blockEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
        const host = blockEl && blockEl.closest && blockEl.closest('.jr-block');
        if (host) {
          const row = host.closest('.jr-row');
          const b = cur.blocks.find(x => x.id === row.dataset.bid);
          if (b) { b.content = host.innerHTML; persist(); }
        }
      }
    }, label);
    return el('.jr-toolbar', null, [
      btn('B', '.b', 'bold'),
      btn('I', '.i', 'italic'),
      btn('U', '.u', 'underline'),
      btn('S', '.s', 'strikeThrough'),
      el('span.jr-tb-sep'),
      btn('', '.hl.purple', 'hiliteColor', 'rgba(168,85,247,.45)'),
      btn('', '.hl.amber', 'hiliteColor', 'rgba(240,173,78,.45)'),
      btn('✕', '.hl.clear', 'hiliteColor', 'transparent')
    ]);
  }

  function wireToolbar(card) {
    if (App.journal._selHandler) document.removeEventListener('selectionchange', App.journal._selHandler);
    const handler = () => {
      if (!card.isConnected) { document.removeEventListener('selectionchange', handler); return; }
      const tb = card.querySelector('.jr-toolbar');
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) { tb.classList.remove('show'); return; }
      const range = sel.getRangeAt(0);
      const anchor = range.commonAncestorContainer;
      const node = anchor.nodeType === 1 ? anchor : anchor.parentElement;
      if (!node || !card.contains(node) || !node.closest('.jr-block')) { tb.classList.remove('show'); return; }
      const r = range.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      tb.classList.add('show');
      const left = Math.max(6, Math.min(r.left - cr.left + r.width / 2 - tb.offsetWidth / 2, cr.width - tb.offsetWidth - 6));
      tb.style.left = left + 'px';
      tb.style.top = Math.max(6, r.top - cr.top - 40) + 'px';
    };
    App.journal._selHandler = handler;
    document.addEventListener('selectionchange', handler);
  }
})();
