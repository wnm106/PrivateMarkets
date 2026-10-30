import { nestTable, parseChatAnswer, type ChatAnswer, type ChatTable } from '@tapestrai/mcp-server/src/lib/chat-answer';

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

function cellHtml(value: unknown, header: string): string {
  if (value == null || value === '') return '';
  if (typeof value !== 'number') return esc(String(value));
  const name = header.toLowerCase();
  if (/share|weight|percent|pct/.test(name)) return `${(Math.abs(value) <= 1 ? value * 100 : value).toFixed(1)}%`;
  if (/exposure|value|amount|nav|market|commitment|contribution|distribution|asset|liabilit/.test(name)) return money(value);
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
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
      const share = /share|weight|percent|pct/i.test(column.name) && group.total && typeof row[nested.valueIndex] === 'number'
        ? `${((row[nested.valueIndex] as number / group.total) * 100).toFixed(1)}%`
        : cellHtml(row[column.index], column.name);
      const numeric = typeof row[column.index] === 'number';
      return `<td${numeric ? ' class="num"' : ''}>${share}</td>`;
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
  const body = table.rows.map((row) => `<tr>${table.columns.map((column, index) => {
    const numeric = typeof row[index] === 'number';
    return `<td${numeric ? ' class="num"' : ''}>${cellHtml(row[index], column)}</td>`;
  }).join('')}</tr>`).join('');
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
  return `<div class="chat-answer">${lead}${kpis}${meters}${tables}</div>`;
}

export function markdownToHtml(markdown: string): string {
  return renderMarkdown(markdown, true);
}

function renderMarkdown(markdown: string, allowAnswer: boolean): string {
  if (allowAnswer) {
    const answer = parseChatAnswer(markdown);
    if (answer && (answer.kpis.length || answer.meters.length || answer.tables.length)) {
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
