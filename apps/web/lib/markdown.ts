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
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic (*text* or _text_)
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color: var(--accent-2); text-decoration: underline;">$1</a>');

  // Tables
  html = html.replace(/^\|(.+)\|$/gm, (match, content) => {
    const cells = content.split('|').map(cell => cell.trim());
    const isHeader = cells.some(cell => /^-+$/.test(cell));
    
    if (isHeader) {
      return ''; // Skip separator rows
    }
    
    const row = cells.map(cell => `<td style="padding: 8px; border: 1px solid var(--line);">${cell}</td>`).join('');
    return `<tr>${row}</tr>`;
  });

  // Wrap consecutive table rows in a table
  html = html.replace(/(<tr>.*<\/tr>\n?)+/g, (match) => {
    return `<table style="width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px;">${match}</table>`;
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
