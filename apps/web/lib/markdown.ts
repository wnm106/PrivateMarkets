/**
 * Simple markdown to HTML converter for chat messages
 * Handles: headers, bold, italic, bullet points, code blocks, links, and tables
 */
export function markdownToHtml(markdown: string): string {
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
