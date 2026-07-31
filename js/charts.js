/* Small SVG chart primitives for the Admin usage dashboard.

   Deliberately dependency-free and hand-rolled: the app ships no build step and
   no CDN is reachable from a locked-down deploy, so a charting library isn't an
   option. Only the four forms the usage page actually needs are here.

   Conventions come from the project's data-viz rules and are applied uniformly:
     • 2px lines, ≥8px end markers with a 2px surface ring, 10%-opacity area wash
     • hairline recessive gridlines; no chart junk
     • text always wears text tokens — never a series colour (identity comes from
       the coloured mark beside the label)
     • ≥2 series always get a legend; a crosshair tooltip lists every series at
       the hovered X, so the pointer never has to land on a 2px line
   Series colours live in CSS (--viz-1…6) so themes — including the light
   "daylight" theme — swap them in one place. */
window.App = window.App || {};
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const SERIES = 6;   // validated palette length; a 7th series folds into "Other"

  function svgEl(name, attrs) {
    const n = document.createElementNS(NS, name);
    if (attrs) for (const k in attrs) { if (attrs[k] != null) n.setAttribute(k, attrs[k]); }
    return n;
  }
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const seriesColor = (i) => cssVar('--viz-' + ((i % SERIES) + 1)) || '#5b6cff';
  const fmtDay = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  // "nice" axis top so ticks land on round numbers rather than the raw max
  function niceMax(v) {
    if (v <= 4) return Math.max(1, v);
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    return Math.ceil(v / (mag / 2)) * (mag / 2);
  }

  /* Charts need their container's real width, which doesn't exist until layout.
     Measure on mount, redraw on resize — one observer per chart, disconnected
     automatically once the node leaves the DOM. */
  function mount(box, draw) {
    const run = () => {
      // content box, not clientWidth — clientWidth includes padding, which would
      // draw the SVG wider than its slot and clip the right-hand value labels
      const cs = getComputedStyle(box);
      const w = Math.floor(box.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0));
      if (!w || w < 40) return;
      box.innerHTML = '';
      box.appendChild(draw(w));
    };
    requestAnimationFrame(run);
    if (window.ResizeObserver) {
      let t = null, last = 0;
      const ro = new ResizeObserver(() => {
        if (!box.isConnected) { ro.disconnect(); return; }
        if (Math.abs(box.clientWidth - last) < 8) return;      // ignore sub-pixel churn
        last = box.clientWidth;
        clearTimeout(t); t = setTimeout(run, 120);
      });
      ro.observe(box);
    }
    return box;
  }

  // one shared floating readout for every chart on the page
  function tipEl() {
    if (!App._vizTip) {
      App._vizTip = document.createElement('div');
      App._vizTip.className = 'viz-tip';
      App._vizTip.style.display = 'none';
      document.body.appendChild(App._vizTip);
    }
    return App._vizTip;
  }
  function hideTip() { if (App._vizTip) App._vizTip.style.display = 'none'; }
  function showTip(x, y, rows, title) {
    const t = tipEl();
    t.innerHTML = '';
    if (title) { const h = document.createElement('div'); h.className = 'viz-tip-h'; h.textContent = title; t.appendChild(h); }
    rows.forEach(r => {
      const line = document.createElement('div'); line.className = 'viz-tip-row';
      const key = document.createElement('span'); key.className = 'viz-tip-key';
      key.style.background = r.color || 'transparent';        // line-key, not a box
      const val = document.createElement('span'); val.className = 'viz-tip-val';
      val.textContent = String(r.value);                      // untrusted → textContent
      const lab = document.createElement('span'); lab.className = 'viz-tip-lab';
      lab.textContent = r.label;
      line.appendChild(key); line.appendChild(val); line.appendChild(lab);
      t.appendChild(line);
    });
    t.style.display = 'block';
    const w = t.offsetWidth, h = t.offsetHeight;
    t.style.left = Math.max(8, Math.min(x + 14, innerWidth - w - 8)) + 'px';
    t.style.top = Math.max(8, y - h - 12) + 'px';
  }

  App.charts = {
    /* Sparkline for a stat tile: shape only, no axes. The trend *is* the value's
       context, so the tile shows both and neither needs a legend. */
    sparkline(values, opts) {
      opts = opts || {};
      const box = document.createElement('div');
      box.className = 'viz-spark';
      return mount(box, (w) => {
        const h = opts.height || 34, pad = 2;
        const svg = svgEl('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, class: 'viz-svg' });
        const n = values.length;
        if (!n) return svg;
        const max = niceMax(Math.max(1, ...values));
        const x = (i) => n === 1 ? w / 2 : pad + i * ((w - pad * 2) / (n - 1));
        const y = (v) => h - pad - (v / max) * (h - pad * 2);
        const color = opts.color || seriesColor(0);
        const line = values.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
        svg.appendChild(svgEl('path', {
          d: line + ' L' + x(n - 1).toFixed(1) + ' ' + h + ' L' + x(0).toFixed(1) + ' ' + h + ' Z',
          fill: color, 'fill-opacity': '0.1', stroke: 'none'
        }));
        svg.appendChild(svgEl('path', { d: line, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        // end marker with its surface ring, so the latest point reads as "now"
        svg.appendChild(svgEl('circle', { cx: x(n - 1), cy: y(values[n - 1]), r: 3.5, fill: color, stroke: 'var(--surface)', 'stroke-width': '2' }));
        return svg;
      });
    },

    /* Multi-series trend line with a snapping crosshair.
       series: [{ label, values[] }] aligned to `labels` (ISO days). */
    lineChart(labels, series, opts) {
      opts = opts || {};
      const box = document.createElement('div');
      box.className = 'viz-chart';
      return mount(box, (w) => {
        const h = opts.height || 220;
        const padL = 34, padR = 12, padT = 10, padB = 22;
        const iw = Math.max(10, w - padL - padR), ih = h - padT - padB;
        const svg = svgEl('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, class: 'viz-svg' });
        const n = labels.length;
        if (!n) return svg;

        const max = niceMax(Math.max(1, ...series.flatMap(s => s.values)));
        const X = (i) => padL + (n === 1 ? iw / 2 : i * (iw / (n - 1)));
        const Y = (v) => padT + ih - (v / max) * ih;

        // gridlines + y ticks (hairline, recessive, solid)
        const ticks = max <= 4 ? max : 4;
        for (let t = 0; t <= ticks; t++) {
          const v = Math.round(max * t / ticks), yy = Y(v);
          svg.appendChild(svgEl('line', { x1: padL, x2: w - padR, y1: yy, y2: yy, class: 'viz-grid' }));
          const lab = svgEl('text', { x: padL - 6, y: yy + 3.5, class: 'viz-axis', 'text-anchor': 'end' });
          lab.textContent = String(v); svg.appendChild(lab);
        }
        // x labels — a handful, never one per point
        const every = Math.max(1, Math.ceil(n / 6));
        labels.forEach((d, i) => {
          if (i % every && i !== n - 1) return;
          const lab = svgEl('text', { x: X(i), y: h - 6, class: 'viz-axis', 'text-anchor': i === n - 1 ? 'end' : 'middle' });
          lab.textContent = fmtDay(d); svg.appendChild(lab);
        });

        // one area wash when a single series is plotted; lines always
        series.forEach((s, si) => {
          const color = s.color || seriesColor(si);
          const d = s.values.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
          if (series.length === 1) {
            svg.appendChild(svgEl('path', { d: d + ' L' + X(n - 1) + ' ' + Y(0) + ' L' + X(0) + ' ' + Y(0) + ' Z', fill: color, 'fill-opacity': '0.1' }));
          }
          svg.appendChild(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
          svg.appendChild(svgEl('circle', { cx: X(n - 1), cy: Y(s.values[n - 1]), r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': '2' }));
        });

        // crosshair: readers aim at a date, not at a 2px line
        const hair = svgEl('line', { y1: padT, y2: padT + ih, class: 'viz-hair', style: 'display:none' });
        svg.appendChild(hair);
        const dots = series.map((s, si) => {
          const c = svgEl('circle', { r: 4, fill: s.color || seriesColor(si), stroke: 'var(--surface)', 'stroke-width': '2', style: 'display:none' });
          svg.appendChild(c); return c;
        });
        const hit = svgEl('rect', { x: padL, y: padT, width: iw, height: ih, fill: 'transparent', style: 'cursor:crosshair' });
        svg.appendChild(hit);
        const move = (e) => {
          const r = svg.getBoundingClientRect();
          const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) - padL) / (iw / Math.max(1, n - 1)))));
          hair.setAttribute('x1', X(i)); hair.setAttribute('x2', X(i)); hair.style.display = '';
          dots.forEach((c, si) => { c.setAttribute('cx', X(i)); c.setAttribute('cy', Y(series[si].values[i])); c.style.display = ''; });
          showTip(e.clientX, r.top + Y(Math.max(...series.map(s => s.values[i]))),
            series.map((s, si) => ({ label: s.label, value: s.values[i], color: s.color || seriesColor(si) })),
            fmtDay(labels[i]));
        };
        hit.addEventListener('pointermove', move);
        hit.addEventListener('pointerleave', () => {
          hair.style.display = 'none'; dots.forEach(c => { c.style.display = 'none'; }); hideTip();
        });
        return svg;
      });
    },

    /* Momentum: change vs the previous period, as a diverging bar around a zero
       axis. Growth and decline are opposite polarities, so this is the one place
       a diverging pair (blue ↔ red) is the right colour job. */
    divergingBars(items, opts) {
      opts = opts || {};
      const box = document.createElement('div');
      box.className = 'viz-chart';
      return mount(box, (w) => {
        const rowH = 26, padT = 6, labW = Math.min(190, Math.max(120, Math.round(w * 0.34)));
        const h = padT * 2 + items.length * rowH;
        const svg = svgEl('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, class: 'viz-svg' });
        if (!items.length) return svg;
        const valW = 44;
        const trackX = labW + 8, trackW = Math.max(20, w - trackX - valW - 6);
        const mid = trackX + trackW / 2;
        const peak = Math.max(1, ...items.map(i => Math.abs(i.pct)));

        svg.appendChild(svgEl('line', { x1: mid, x2: mid, y1: padT, y2: h - padT, class: 'viz-axisline' }));
        items.forEach((it, i) => {
          const cy = padT + i * rowH + rowH / 2;
          const lab = svgEl('text', { x: labW, y: cy + 3.5, class: 'viz-lab', 'text-anchor': 'end' });
          lab.textContent = it.label; svg.appendChild(lab);

          const up = it.pct >= 0;
          const len = Math.abs(it.pct) / peak * (trackW / 2 - 2);
          const bh = 12;
          // rounded on the growing end, square against the zero axis
          const r = 4, x0 = up ? mid : mid - len, x1 = up ? mid + len : mid;
          const d = up
            ? 'M' + x0 + ' ' + (cy - bh / 2) + ' H' + (x1 - r) + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r +
              ' v' + (bh - 2 * r) + ' a' + r + ' ' + r + ' 0 0 1 ' + (-r) + ' ' + r + ' H' + x0 + ' Z'
            : 'M' + x1 + ' ' + (cy - bh / 2) + ' H' + (x0 + r) + ' a' + r + ' ' + r + ' 0 0 0 ' + (-r) + ' ' + r +
              ' v' + (bh - 2 * r) + ' a' + r + ' ' + r + ' 0 0 0 ' + r + ' ' + r + ' H' + x1 + ' Z';
          const bar = svgEl('path', { d, fill: up ? 'var(--viz-up)' : 'var(--viz-down)' });
          svg.appendChild(bar);

          const val = svgEl('text', { x: w - 4, y: cy + 3.5, class: 'viz-val', 'text-anchor': 'end' });
          val.textContent = (up ? '+' : '') + it.pct + '%'; svg.appendChild(val);

          // the mark is the hit target on bars — no crosshair here
          const hit = svgEl('rect', { x: trackX, y: cy - rowH / 2, width: trackW, height: rowH, fill: 'transparent' });
          hit.addEventListener('pointerenter', (e) => showTip(e.clientX, e.clientY,
            [{ label: 'this period', value: it.now, color: 'var(--viz-up)' },
             { label: 'previous', value: it.prev, color: 'var(--viz-down)' }], it.label));
          hit.addEventListener('pointerleave', hideTip);
          svg.appendChild(hit);
        });
        return svg;
      });
    },

    /* Role × feature intensity. A grid of magnitudes is a heatmap's job, and it
       stays readable where 6 overlaid lines would not. Sequential = one hue. */
    heatmap(rows, cols, matrix, opts) {
      opts = opts || {};
      const box = document.createElement('div');
      box.className = 'viz-chart';
      return mount(box, (w) => {
        const labW = Math.min(150, Math.max(96, Math.round(w * 0.22)));
        const cellH = 26, gap = 2;
        const cw = Math.max(18, (w - labW - 8) / Math.max(1, cols.length));
        /* Column headers sit at 45°, anchored at their column's left edge so the
           text runs up-and-right into empty space instead of across a neighbour.
           Reserve height for the longest label's vertical rise (cos45 ≈ 0.7). */
        const longest = cols.reduce((m, c) => Math.max(m, c.short.length), 0);
        const headH = Math.min(96, Math.max(34, Math.round(longest * 5.4 * 0.7) + 14));
        const h = headH + rows.length * cellH + 4;
        const svg = svgEl('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, class: 'viz-svg' });
        const peak = Math.max(1, ...matrix.flat());

        cols.forEach((c, j) => {
          const x = labW + 8 + j * cw + 3, y = headH - 7;
          const t = svgEl('text', { x, y, class: 'viz-axis', transform: 'rotate(-45 ' + x + ' ' + y + ')' });
          t.textContent = c.short; svg.appendChild(t);
        });
        rows.forEach((r, i) => {
          const y = headH + i * cellH;
          const lab = svgEl('text', { x: labW, y: y + cellH / 2 + 3.5, class: 'viz-lab', 'text-anchor': 'end' });
          lab.textContent = r.label; svg.appendChild(lab);
          cols.forEach((c, j) => {
            const v = matrix[i][j];
            const cell = svgEl('rect', {
              x: labW + 8 + j * cw + gap / 2, y: y + gap / 2,
              width: Math.max(1, cw - gap), height: cellH - gap, rx: 3,
              fill: v ? 'var(--viz-seq)' : 'var(--viz-seq-empty)',
              'fill-opacity': v ? (0.18 + 0.82 * (v / peak)).toFixed(3) : 1
            });
            cell.addEventListener('pointerenter', (e) => showTip(e.clientX, e.clientY,
              [{ label: c.label, value: v, color: 'var(--viz-seq)' }], r.label));
            cell.addEventListener('pointerleave', hideTip);
            svg.appendChild(cell);
          });
        });
        return svg;
      });
    },

    /* Ranked horizontal bars. Magnitude low→high is a sequential job, so this is
       one hue throughout — a different colour per bar would imply the categories
       differ in kind, when the only thing that differs is the number. Horizontal
       because feature names are long. */
    barChart(items, opts) {
      opts = opts || {};
      const box = document.createElement('div');
      box.className = 'viz-chart';
      return mount(box, (w) => {
        const rowH = 25, padT = 4;
        const labW = Math.min(210, Math.max(120, Math.round(w * 0.36)));
        const valW = 46;
        const h = padT * 2 + items.length * rowH;
        const svg = svgEl('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, class: 'viz-svg' });
        if (!items.length) return svg;
        const trackX = labW + 8, trackW = Math.max(20, w - trackX - valW);
        const peak = Math.max(1, ...items.map(i => i.value));

        items.forEach((it, i) => {
          const cy = padT + i * rowH + rowH / 2;
          const lab = svgEl('text', { x: labW, y: cy + 3.5, class: 'viz-lab', 'text-anchor': 'end' });
          lab.textContent = it.label; svg.appendChild(lab);

          const bw = Math.max(2, it.value / peak * trackW);
          const bh = 13, r = 4;
          // 4px rounded data-end, square against the baseline it grows from
          svg.appendChild(svgEl('path', {
            d: 'M' + trackX + ' ' + (cy - bh / 2) + ' H' + (trackX + bw - r) +
               ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + ' v' + (bh - 2 * r) +
               ' a' + r + ' ' + r + ' 0 0 1 ' + (-r) + ' ' + r + ' H' + trackX + ' Z',
            fill: 'var(--viz-seq)', 'fill-opacity': (0.45 + 0.55 * (it.value / peak)).toFixed(3)
          }));
          const val = svgEl('text', { x: w - 4, y: cy + 3.5, class: 'viz-val', 'text-anchor': 'end' });
          val.textContent = String(it.value); svg.appendChild(val);

          const hit = svgEl('rect', { x: trackX, y: cy - rowH / 2, width: trackW, height: rowH, fill: 'transparent' });
          hit.addEventListener('pointerenter', (e) => showTip(e.clientX, e.clientY,
            [{ label: opts.unit || 'events', value: it.value, color: 'var(--viz-seq)' }]
              .concat(it.share != null ? [{ label: 'of all usage', value: it.share + '%', color: 'transparent' }] : []),
            it.label));
          hit.addEventListener('pointerleave', hideTip);
          svg.appendChild(hit);
        });
        return svg;
      });
    },

    // legend — always present for ≥2 series; mirrors the mark (line key)
    legend(series) {
      const box = document.createElement('div');
      box.className = 'viz-legend';
      series.forEach((s, i) => {
        const item = document.createElement('span'); item.className = 'viz-legend-item';
        const key = document.createElement('span'); key.className = 'viz-legend-key';
        key.style.background = s.color || seriesColor(i);
        const lab = document.createElement('span'); lab.textContent = s.label;
        item.appendChild(key); item.appendChild(lab); box.appendChild(item);
      });
      return box;
    },

    seriesColor,
    hideTip
  };
})();
