import { nestTable, parseChatAnswer, toneFor, isTonedCell, type ChatAnswer, type ChatChart, type ChatTable } from '@tapestrai/mcp-server/src/lib/chat-answer';

/**
 * Simple markdown to HTML converter for chat messages
 * Handles: headers, bold, italic, bullet points, code blocks, links, and tables.
 * An ```answer block becomes KPI cards, bars, and a table.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function shown(value: unknown): unknown {
  return isTonedCell(value) ? value.text : value;
}

function cellHtml(value: unknown, header: string): string {
  const tone = toneFor(header, value);
  const raw = shown(value);
  let body = '';
  if (raw != null && raw !== '') {
    if (typeof raw !== 'number') body = esc(String(raw));
    else {
      const name = header.toLowerCase();
      if (/share|weight|percent|pct/.test(name)) body = `${(Math.abs(raw) <= 1 ? raw * 100 : raw).toFixed(1)}%`;
      else if (/exposure|value|amount|nav|market|commitment|contribution|distribution|asset|liabilit/.test(name)) body = money(raw);
      else body = raw.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
  }
  const cls = [typeof raw === 'number' ? 'num' : '', tone ? `tone-${tone}` : ''].filter(Boolean).join(' ');
  return `<td${cls ? ` class="${cls}"` : ''}>${body}</td>`;
}

function groupedHtml(table: ChatTable): string | null {
  const nested = nestTable(table);
  if (!nested) return null;
  const detail = table.columns
    .map((name, index) => ({ name, index }))
    .filter((column) => column.index !== nested.groupIndex);
  const sections = nested.groups.map((group) => {
    const total = group.total == null ? '' : `<span>${esc(money(group.total))}</span>`;
    const head = detail.map((column) => `<th>${esc(column.name)}</th>`).join('');
    const body = group.rows.map((row) => `<tr>${detail.map((column) => {
      const share = /share|weight|percent|pct/i.test(column.name) && group.total && typeof shown(row[nested.valueIndex]) === 'number'
        ? `${(((shown(row[nested.valueIndex]) as number) / group.total) * 100).toFixed(1)}%`
        : null;
      if (share != null) {
        const tone = toneFor(column.name, row[column.index]);
        return `<td class="num${tone ? ` tone-${tone}` : ''}">${share}</td>`;
      }
      return cellHtml(row[column.index], column.name);
    }).join('')}</tr>`).join('');
    return `<section class="chat-group"><div class="chat-group-head"><span>${esc(group.label)}</span>${total}</div><table class="chat-answer-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
  }).join('');
  const title = table.title ? `<div class="chat-answer-kicker">${esc(table.title)}</div>` : '';
  return `${title}<div class="chat-groups">${sections}</div>`;
}

function tableHtml(table: ChatTable): string {
  const grouped = groupedHtml(table);
  if (grouped) return grouped;
  const head = table.columns.map((column) => `<th>${esc(column)}</th>`).join('');
  const body = table.rows.map((row) => `<tr>${table.columns.map((column, index) => cellHtml(row[index], column)).join('')}</tr>`).join('');
  const title = table.title ? `<div class="chat-answer-kicker">${esc(table.title)}</div>` : '';
  return `${title}<div class="md-table-scroll"><table class="chat-answer-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function answerHtml(answer: ChatAnswer): string {
  const lead = answer.lead ? `<p class="chat-answer-lead">${esc(answer.lead)}</p>` : '';
  const kpis = answer.kpis.length
    ? `<div class="chat-kpis">${answer.kpis.map((kpi) => `<div class="chat-kpi"><div class="chat-kpi-label">${esc(kpi.label)}</div><div class="chat-kpi-value">${esc(kpi.value)}</div>${kpi.detail ? `<div class="chat-kpi-detail">${esc(kpi.detail)}</div>` : ''}</div>`).join('')}</div>`
    : '';
  const meters = answer.meters.map((group) => {
    const max = Math.max(...group.items.map((item) => Math.abs(item.value)), 1);
    const rows = group.items.map((item) => {
      const width = Math.min(100, (Math.abs(item.value) / max) * 100);
      const shown = group.format === 'percent'
        ? `${(Math.abs(item.value) <= 1 ? item.value * 100 : item.value).toFixed(1)}%`
        : group.format === 'number'
          ? item.value.toLocaleString(undefined, { maximumFractionDigits: 1 })
          : money(item.value);
      const marker = item.marker == null ? '' : `<div class="chat-meter-marker" style="left:${Math.min(100, (Math.abs(item.marker) / max) * 100)}%"></div>`;
      return `<div class="chat-meter"><div class="chat-meter-top"><span>${esc(item.label)}</span><span>${esc(shown)}${item.detail ? ` · ${esc(item.detail)}` : ''}</span></div><div class="chat-meter-track"><div class="chat-meter-fill" style="width:${width}%"></div>${marker}</div></div>`;
    }).join('');
    const title = group.title ? `<div class="chat-answer-kicker">${esc(group.title)}</div>` : '';
    return `<div class="chat-meters">${title}${rows}</div>`;
  }).join('');
  const tables = answer.tables.map(tableHtml).join('');
  const chart = answer.chart ? chartHtml(answer.chart) : '';
  return `<div class="chat-answer">${lead}${kpis}${meters}${chart}${tables}</div>`;
}

const CHART_COLORS = ['#0e7490', '#00334e', '#b45309', '#047857'];

function chartHtml(chart: ChatChart): string {
  const labels = chart.labels;
  const series = chart.series.filter((item) => item.values.length);
  if (!labels.length || !series.length) return '';
  const w = 520;
  const h = 210;
  const pad = { l: 44, r: 12, t: 12, b: 36 };
  const flat = series.flatMap((item) => item.values);
  const min = Math.min(0, ...flat);
  const max = Math.max(...flat);
  const span = max - min || 1;
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const yOf = (value: number) => pad.t + (1 - (value - min) / span) * plotH;
  const xOf = (index: number) => pad.l + (labels.length <= 1 ? plotW / 2 : (index * plotW) / (labels.length - 1));
  const ticks = [max, min + span / 2, min].map((value) => {
    const y = yOf(value);
    const label = Math.abs(value) >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="#e2e8f0"/><text x="${pad.l - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="#64748b">${esc(label)}</text>`;
  }).join('');
  const axisLabels = labels.map((label, index) => {
    const x = chart.chartType === 'bar'
      ? pad.l + (index + 0.5) * (plotW / labels.length)
      : xOf(index);
    return `<text x="${x}" y="${h - 14}" text-anchor="middle" font-size="10" fill="#475569">${esc(label)}</text>`;
  }).join('');
  let marks = '';
  if (chart.chartType === 'bar') {
    const groupW = plotW / labels.length;
    const barW = Math.max(4, (groupW * 0.7) / series.length);
    marks = labels.map((_, index) => series.map((item, seriesIndex) => {
      const value = item.values[index] ?? 0;
      const x = pad.l + index * groupW + (groupW - barW * series.length) / 2 + seriesIndex * barW;
      const y = yOf(Math.max(value, 0));
      const base = yOf(0);
      const height = Math.max(1, Math.abs(base - yOf(value)));
      return `<rect x="${x}" y="${Math.min(y, base)}" width="${barW - 2}" height="${height}" fill="${CHART_COLORS[seriesIndex % CHART_COLORS.length]}" rx="1"/>`;
    }).join('')).join('');
  } else {
    marks = series.map((item, seriesIndex) => {
      const color = CHART_COLORS[seriesIndex % CHART_COLORS.length];
      const points = labels.map((_, index) => `${xOf(index)},${yOf(item.values[index] ?? 0)}`).join(' ');
      const dots = labels.map((_, index) => `<circle cx="${xOf(index)}" cy="${yOf(item.values[index] ?? 0)}" r="2.5" fill="${color}"/>`).join('');
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>${dots}`;
    }).join('');
  }
  const title = chart.title ? `<figcaption>${esc(chart.title)}</figcaption>` : '';
  const legend = series.length > 1
    ? `<div class="chat-chart-legend">${series.map((item, index) => `<span><i style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></i>${esc(item.name)}</span>`).join('')}</div>`
    : '';
  return `<figure class="chat-chart">${title}<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(chart.title || 'Chart')}">${ticks}${marks}${axisLabels}</svg>${legend}</figure>`;
}

export function markdownToHtml(markdown: string): string {
  return renderMarkdown(markdown, true);
}

function renderMarkdown(markdown: string, allowAnswer: boolean): string {
  if (allowAnswer) {
    const answer = parseChatAnswer(markdown);
    if (answer && (answer.lead || answer.kpis.length || answer.meters.length || answer.tables.length || answer.chart)) {
      const rest = answer.prose ? renderMarkdown(answer.prose, false) : '';
      return answerHtml(answer) + rest;
    }
  }

  let html = markdown;

  // Escape HTML entities first (but preserve markdown syntax)
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (```...```)
  html = html.replace(/```([\s\S]*?)```/g, (match, code) => {
    return `<pre style="background: var(--bg); padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0;"><code>${code.trim()}</code></pre>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`]+)`/g, '<code style="background: var(--bg); padding: 2px 6px; border-radius: 3px; font-family: var(--font-ibm-plex-mono), monospace; font-size: 12px;">$1</code>');

  // Headers (### or ## or #)
  html = html.replace(/^### (.+)$/gm, '<h3 style="font-size: 15px; font-weight: 600; margin: 12px 0 8px 0; color: var(--ink);">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="font-size: 16px; font-weight: 600; margin: 14px 0 10px 0; color: var(--ink);">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="font-size: 18px; font-weight: 600; margin: 16px 0 12px 0; color: var(--ink);">$1</h1>');

  // Bold (**text** or __text__)
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');

  // Italic (*text* or _text_). The underscore form must not fire inside a word,
  // otherwise identifiers like DEAL_STANDARD lose their underscore and render as
  // emphasis (and a stray underscore can then pair with a distant one across lines).
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/gm, '$1<em>$2</em>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color: var(--accent-2); text-decoration: underline;">$1</a>');

  // Tables. A separator is `| --- |` or an alignment marker such as `|:---|`.
  html = html.replace(/^\|(.+)\|[ \t]*\r?\n?/gm, (match, content) => {
    const cells = content.split('|').map((cell: string) => cell.trim());
    const isSeparator = cells.length > 0 && cells.every((cell: string) => /^:?-+:?$/.test(cell));

    if (isSeparator) return '';

    const row = cells.map((cell: string) => `<td>${cell}</td>`).join('');
    return `<tr>${row}</tr>\n`;
  });

  // Wrap consecutive rows. The first row is the header. The table sits in a
  // scroller so wide columns stay intact instead of being crushed to the bubble.
  html = html.replace(/(<tr>.*<\/tr>\n?)+/g, (match) => {
    const withHeader = match.replace(/<tr>([\s\S]*?)<\/tr>/, (row) =>
      row.replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>')
    );
    return `<div class="md-table-scroll"><table>${withHeader.replace(/\s*\n\s*/g, '')}</table></div>`;
  });

  html = paintChangeColumns(html);

  // Unordered lists (- or * at start of line)
  html = html.replace(/^[\-\*] (.+)$/gm, '<li style="margin-left: 20px; margin-bottom: 4px;">$1</li>');
  
  // Ordered lists (1. 2. 3. etc)
  html = html.replace(/^\d+\. (.+)$/gm, '<li style="margin-left: 20px; margin-bottom: 4px; list-style-type: decimal;">$1</li>');

  // Wrap consecutive list items in ul/ol
  html = html.replace(/(<li[^>]*>.*<\/li>\n?)+/g, (match) => {
    if (match.includes('list-style-type: decimal')) {
      return `<ol style="margin: 8px 0;">${match}</ol>`;
    }
    return `<ul style="margin: 8px 0; list-style-type: disc;">${match}</ul>`;
  });

  // Paragraphs (double newline)
  html = html.replace(/\n\n/g, '</p><p style="margin: 8px 0;">');
  
  // Single newlines to <br>
  html = html.replace(/\n/g, '<br/>');

  // Wrap in paragraph if not already wrapped
  if (!html.startsWith('<')) {
    html = `<p style="margin: 8px 0;">${html}</p>`;
  }

  return html;
}

/** Colors Change columns in a markdown table the model wrote by hand. */
function paintChangeColumns(html: string): string {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (table, inner: string) => {
    const rows = inner.match(/<tr>[\s\S]*?<\/tr>/g);
    if (!rows || rows.length < 2) return table;
    const headers = [...rows[0].matchAll(/<th>([\s\S]*?)<\/th>/g)].map((match) => match[1].replace(/<[^>]+>/g, ''));
    if (!headers.some((header) => /change|variance|\bvar\b|delta|growth|trend|diff/i.test(header))) return table;
    const painted = rows.map((row, rowIndex) => {
      if (rowIndex === 0) return row;
      let column = 0;
      return row.replace(/<td>/g, () => {
        const header = headers[column] || '';
        column += 1;
        return /change|variance|\bvar\b|delta|growth|trend|diff/i.test(header) ? '<td class="tone-pending">' : '<td>';
      }).replace(/<td class="tone-pending">([\s\S]*?)<\/td>/g, (_cell, content: string) => {
        const text = content.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
        const negative = /^[−-]/.test(text) || /^\(.*\)$/.test(text);
        const positive = /^\+/.test(text);
        const amount = Number(text.replace(/[$,%\s,]/g, '').replace(/[()]/g, ''));
        const tone = negative || (Number.isFinite(amount) && text.startsWith('-'))
          ? 'down'
          : positive || (Number.isFinite(amount) && amount > 0)
            ? 'up'
            : Number.isFinite(amount) && amount === 0
              ? 'flat'
              : '';
        return `<td${tone ? ` class="tone-${tone}"` : ''}>${content}</td>`;
      });
    }).join('');
    return table.replace(inner, painted);
  });
}
