/** What is on screen, read from the page itself so every route can feed the assistant. */

export interface VisiblePage {
  title: string;
  summary?: string;
  data: Record<string, unknown>;
}

function clean(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function cellText(cell: Element): string {
  return clean(cell.textContent);
}

function readTable(table: HTMLTableElement): { name?: string; rows: Array<Record<string, string>> } | null {
  const headers = [...table.querySelectorAll(':scope > thead th, :scope > thead td')].map(cellText).filter(Boolean);
  const bodyRows = [...table.querySelectorAll(':scope > tbody > tr')].slice(0, 40);
  const rows = bodyRows.map((row) => {
    const cells = [...row.children].filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH');
    if (cells.length === 1 && cells[0].getAttribute('colspan')) {
      const group = cellText(cells[0]);
      return group ? { group } : null;
    }
    if (headers.length) {
      const record: Record<string, string> = {};
      cells.forEach((cell, index) => {
        const key = headers[index] || `column ${index + 1}`;
        const value = cellText(cell);
        if (value) record[key] = value;
      });
      return Object.keys(record).length ? record : null;
    }
    const values = cells.map(cellText).filter(Boolean);
    return values.length ? { cells: values.join(' | ') } : null;
  }).filter((row): row is Record<string, string> => Boolean(row));
  if (!rows.length) return null;
  const name = clean(table.getAttribute('aria-label')) || undefined;
  return name ? { name, rows } : { rows };
}

function readFacts(root: ParentNode): Record<string, string> {
  const facts: Record<string, string> = {};
  root.querySelectorAll('.da-fact, .da-holdbox').forEach((block) => {
    const label = clean(block.querySelector('span')?.textContent);
    const value = clean(block.querySelector('strong, b')?.textContent);
    if (label && value) facts[label] = value;
  });
  return facts;
}

/** Headings, labeled figures, and tables currently rendered in the page. */
export function readVisiblePage(root: ParentNode, path: string): VisiblePage {
  const title = clean(root.querySelector('h1')?.textContent);
  const summary = clean(root.querySelector('h1 + p, .da-title p')?.textContent).slice(0, 280);
  const headings = [...root.querySelectorAll('h2')]
    .map((heading) => clean(heading.textContent))
    .filter(Boolean)
    .slice(0, 12);
  const facts = readFacts(root);
  const filters = [...root.querySelectorAll('[aria-pressed="true"]')]
    .map((control) => clean(control.textContent))
    .filter(Boolean)
    .slice(0, 12);
  const tables = [...root.querySelectorAll('table')]
    .slice(0, 6)
    .map((table) => readTable(table))
    .filter((table): table is NonNullable<typeof table> => Boolean(table));

  const data: Record<string, unknown> = { path };
  if (title) data.title = title;
  if (summary) data.summary = summary;
  if (headings.length) data.headings = headings;
  if (Object.keys(facts).length) data.facts = facts;
  if (filters.length) data.filters = filters;
  if (tables.length) data.tables = tables;

  let json = JSON.stringify(data);
  if (json.length > 24_000 && Array.isArray(data.tables)) {
    data.tables = (data.tables as Array<{ rows: unknown[] }>).map((table) => ({
      ...table,
      rows: table.rows.slice(0, 12),
      truncated: table.rows.length > 12,
    }));
    json = JSON.stringify(data);
  }

  return { title, summary: summary || undefined, data };
}
