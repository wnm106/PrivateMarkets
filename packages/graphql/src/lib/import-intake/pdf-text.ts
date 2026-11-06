/**
 * Reads a text-based PDF into lines. Cells that sit far apart on the same
 * baseline are separated with tabs so a statement keeps its label and amount.
 */

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const unpdf = await import('unpdf');
  const pdf = await unpdf.getDocumentProxy(bytes);
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(itemsToLines(content.items || []));
  }
  return pages.filter(Boolean).join('\n');
}

interface PlacedText {
  text: string;
  x: number;
  y: number;
  width: number;
}

export function itemsToLines(items: unknown[]): string {
  const placed: PlacedText[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { str?: string; transform?: number[]; width?: number };
    const text = String(record.str || '');
    if (!text.trim()) continue;
    const transform = record.transform || [];
    placed.push({
      text,
      x: Number(transform[4] || 0),
      y: Number(transform[5] || 0),
      width: Number(record.width || Math.max(text.length * 4, 4)),
    });
  }
  placed.sort((left, right) => right.y - left.y || left.x - right.x);

  const lines: Array<{ y: number; items: PlacedText[] }> = [];
  for (const item of placed) {
    const line = lines.find((existing) => Math.abs(existing.y - item.y) <= 2.2);
    if (line) line.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }

  return lines.map((line) => lineToText(line.items.sort((left, right) => left.x - right.x))).filter(Boolean).join('\n');
}

function lineToText(items: PlacedText[]): string {
  const cells: string[] = [];
  let current = '';
  let end = -1;
  for (const item of items) {
    const gap = end < 0 ? 0 : item.x - end;
    if (end >= 0 && gap > 16) {
      cells.push(current.trim());
      current = item.text;
    } else {
      if (current && !current.endsWith(' ') && !item.text.startsWith(' ')) current += ' ';
      current += item.text;
    }
    end = item.x + item.width;
  }
  if (current.trim()) cells.push(current.trim());
  return cells.join('\t');
}
