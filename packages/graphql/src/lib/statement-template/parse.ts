import type { ParsedLine, ParsedSection, ParsedStatement, StatementSource } from './types';
import { normalizeLabel, titleCaseLabel } from './normalize';

const NUMBER_RE = /^\(?-?[$€£]?\d[\d,]*(?:\.\d+)?\)?%?$/;
const DATE_RE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}-[A-Za-z]{3}-\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})$/;
const BOOL_RE = /^(?:true|false|yes|no|y|n)$/i;
const CURRENCY_RE = /^(?:USD|EUR|GBP|CHF|JPY|CAD|AUD|HKD|SGD|SEK|NOK|DKK|NZD)$/;

const HEADER_HINTS = /section|group|category|heading|line|item|account|description|attribute|field|label|name|particular|caption|amount|value|balance/i;

export function isNumericValue(value: string): boolean {
  return NUMBER_RE.test(value.replace(/\s/g, ''));
}

export function isDateValue(value: string): boolean {
  return DATE_RE.test(value.trim());
}

export function isValueToken(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return isNumericValue(trimmed) || isDateValue(trimmed) || BOOL_RE.test(trimmed) || CURRENCY_RE.test(trimmed);
}

export function inferDataType(label: string, values: Array<string | undefined>): string {
  const present = values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  if (present.length > 0 && present.every(isNumericValue)) return 'NUMBER';
  if (present.length > 0 && present.every(isDateValue)) return 'DATE';
  if (present.length > 0 && present.every((value) => BOOL_RE.test(value))) return 'BOOLEAN';
  if (present.length > 0 && present.every((value) => CURRENCY_RE.test(value))) return 'STRING';
  if (present.length > 0) return 'STRING';
  const normalized = normalizeLabel(label);
  if (/\bdate\b|\bperiod\b|\bas of\b/.test(normalized)) return 'DATE';
  if (/\bcurrency\b|\bname\b|\bstatus\b|\btype\b|\bcountry\b/.test(normalized)) return 'STRING';
  return 'NUMBER';
}

function decodeHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function emptyStatement(source: StatementSource): ParsedStatement {
  return { sourceName: source.sourceName, sourceKind: source.sourceKind, sections: [] };
}

function pushLine(sections: ParsedSection[], sectionName: string, line: ParsedLine) {
  let section = sections.find((item) => normalizeLabel(item.name) === normalizeLabel(sectionName));
  if (!section) {
    section = { name: sectionName, lines: [] };
    sections.push(section);
  }
  const duplicate = section.lines.find((item) => normalizeLabel(item.label) === normalizeLabel(line.label));
  if (!duplicate) section.lines.push(line);
}

export function parseStatementSource(source: StatementSource): ParsedStatement {
  const text = source.text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return emptyStatement(source);

  if (/<table[\s>]/i.test(text)) {
    return { ...emptyStatement(source), sections: parseHtml(text) };
  }

  const blocks = splitHeadingBlocks(text);
  const sections: ParsedSection[] = [];
  for (const block of blocks) {
    const parsed = parseBlock(block.body);
    if (parsed.length === 0) continue;
    if (block.heading && parsed.length === 1 && normalizeLabel(parsed[0].name) === 'statement') {
      parsed[0].name = titleCaseLabel(block.heading);
    } else if (block.heading) {
      for (const section of parsed) {
        if (normalizeLabel(section.name) === 'statement') section.name = titleCaseLabel(block.heading);
      }
    }
    for (const section of parsed) {
      for (const line of section.lines) pushLine(sections, section.name, line);
    }
  }
  return { sourceName: source.sourceName, sourceKind: source.sourceKind, sections };
}

function splitHeadingBlocks(text: string): Array<{ heading?: string; body: string }> {
  const lines = text.split('\n');
  const blocks: Array<{ heading?: string; body: string[] }> = [];
  let heading: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (body.some((line) => line.trim())) blocks.push({ heading, body: [...body] });
    body = [];
  };
  for (const line of lines) {
    const match = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (match) {
      flush();
      heading = match[1].trim();
      continue;
    }
    body.push(line);
  }
  flush();
  if (blocks.length === 0) return [{ body: text }];
  return blocks.map((block) => ({ heading: block.heading, body: block.body.join('\n') }));
}

function parseBlock(body: string): ParsedSection[] {
  if (/^\s*\|.+\|\s*$/m.test(body) && /\|\s*:?-{3,}:?\s*\|/.test(body)) {
    return parseMarkdownTables(body);
  }
  if (looksTabular(body)) return parseTabular(body);
  return parseFreeform(body);
}

function looksTabular(text: string): boolean {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const tabLines = lines.filter((line) => line.includes('\t')).length;
  if (tabLines >= Math.ceil(lines.length * 0.6)) {
    const counts = lines.filter((line) => line.includes('\t')).map((line) => line.split('\t').length);
    const mode = counts[0];
    return counts.filter((count) => count === mode).length >= Math.ceil(counts.length * 0.7) && mode >= 2;
  }
  const commaLines = lines.filter((line) => line.includes(',')).length;
  if (commaLines < Math.ceil(lines.length * 0.7)) return false;
  const rows = parseCsv(text);
  if (rows.length < 2 || rows[0].length < 2) return false;
  const width = rows[0].length;
  const consistent = rows.filter((row) => row.length === width).length;
  return consistent >= Math.ceil(rows.length * 0.7);
}

function parseCsv(text: string): string[][] {
  const grid: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const source = text;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (char === '\n') {
      row.push(cell.trim());
      if (row.some(Boolean)) grid.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some(Boolean)) grid.push(row);
  }
  return grid;
}

function splitDelimited(text: string): string[][] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => line.includes('\t'))) {
    return lines.filter((line) => line.includes('\t') || lines.filter((item) => item.includes('\t')).length < lines.length)
      .map((line) => line.split('\t').map((cell) => cell.trim()));
  }
  return parseCsv(text);
}

function parseTabular(text: string): ParsedSection[] {
  const matrix = splitDelimited(text).filter((row) => row.some(Boolean));
  return sectionsFromMatrix(matrix);
}

export function sectionsFromMatrix(matrix: string[][], fallbackSection = 'Statement'): ParsedSection[] {
  const rows = matrix.map((row) => row.map((cell) => cell.trim())).filter((row) => row.some(Boolean));
  if (rows.length === 0) return [];
  const header = rows[0];
  const next = rows[1];
  if (!rowIsHeader(header, next)) return parseFreeform(rows.map((row) => row.join('\t')).join('\n'));

  const sectionIndex = header.findIndex((cell) => /section|group|category|heading/i.test(cell));
  const labelIndex = header.findIndex((cell, index) => index !== sectionIndex && /line|item|account|description|attribute|field|label|name|particular|caption/i.test(cell));
  const valueIndex = header.findIndex((cell, index) => index !== sectionIndex && index !== labelIndex && /amount|value|balance|total|figure/i.test(cell));

  if (labelIndex >= 0 || (sectionIndex >= 0 && header.length >= 2)) {
    const resolvedLabel = labelIndex >= 0 ? labelIndex : header.findIndex((_, index) => index !== sectionIndex);
    const sections: ParsedSection[] = [];
    for (const row of rows.slice(1)) {
      const label = row[resolvedLabel] || '';
      if (!label || isValueToken(label)) continue;
      const sectionName = sectionIndex >= 0 && row[sectionIndex] ? titleCaseLabel(row[sectionIndex]) : fallbackSection;
      const value = valueIndex >= 0 ? row[valueIndex] : row.find((cell, index) => index !== resolvedLabel && index !== sectionIndex && isValueToken(cell));
      pushLine(sections, sectionName, {
        label: label.trim(),
        value: value?.trim() || undefined,
        dataType: inferDataType(label, [value]),
      });
    }
    return sections;
  }

  const lines: ParsedLine[] = header.map((name, index) => {
    const values = rows.slice(1).map((row) => row[index]).filter(Boolean);
    return {
      label: name,
      value: values[0],
      dataType: inferDataType(name, values),
    };
  }).filter((line) => line.label && !/^unnamed/i.test(line.label));
  return lines.length ? [{ name: fallbackSection, lines }] : [];
}

function rowIsHeader(row: string[], next?: string[]): boolean {
  const filled = row.filter(Boolean);
  if (filled.length < 2) return false;
  if (filled.some((cell) => isValueToken(cell))) return false;
  if (filled.some((cell) => HEADER_HINTS.test(cell))) return true;
  if (!next) return true;
  return next.some((cell) => isValueToken(cell)) && filled.every((cell) => cell.length <= 48);
}

function parseMarkdownTables(text: string): ParsedSection[] {
  const lines = text.split('\n');
  const sections: ParsedSection[] = [];
  let heading = 'Statement';
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      heading = titleCaseLabel(headingMatch[1]);
      index += 1;
      continue;
    }
    if (line.startsWith('|')) {
      const table: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        table.push(lines[index].trim());
        index += 1;
      }
      const matrix = table
        .filter((row) => !/^\|\s*:?-{3,}/.test(row))
        .map((row) => row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
      const parsed = sectionsFromMatrix(matrix, heading);
      for (const section of parsed) {
        for (const item of section.lines) pushLine(sections, section.name, item);
      }
      continue;
    }
    index += 1;
  }
  return sections;
}

function parseFreeform(text: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current = 'Statement';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /^[-_=]{3,}$/.test(line)) continue;
    const split = splitLabelValue(line);
    if (!split.value) {
      if (isSectionHeader(split.label)) current = titleCaseLabel(split.label.replace(/:$/, ''));
      continue;
    }
    pushLine(sections, current, {
      label: split.label.replace(/:$/, '').trim(),
      value: split.value,
      dataType: inferDataType(split.label, [split.value]),
    });
  }
  return sections;
}

function isSectionHeader(label: string): boolean {
  const clean = label.replace(/:$/, '').trim();
  if (!clean || clean.length > 60) return false;
  if (isValueToken(clean)) return false;
  const words = clean.split(/\s+/);
  return words.length <= 8;
}

function splitLabelValue(line: string): { label: string; value?: string } {
  if (line.includes('\t')) {
    const cells = line.split('\t').map((cell) => cell.trim()).filter((cell) => cell !== '');
    if (cells.length <= 1) return { label: cells[0] || line.trim() };
    const value = [...cells].reverse().find((cell) => isValueToken(cell));
    const label = cells[0];
    if (!value || label === value) return { label };
    return { label, value };
  }

  const spaced = line.match(/^(.*?\S)\s{2,}(\S.*?)$/);
  if (spaced && isValueToken(spaced[2].trim())) {
    return { label: spaced[1].trim(), value: spaced[2].trim() };
  }

  const trailing = line.match(/^(.*\S)\s+(\(?-?[$€£]?\d[\d,]*(?:\.\d+)?\)?%?|[A-Z]{3}|\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}-[A-Za-z]{3}-\d{2,4}|(?:true|false|yes|no))$/i);
  if (trailing && trailing[1].trim() && isValueToken(trailing[2])) {
    return { label: trailing[1].trim(), value: trailing[2].trim() };
  }

  const colon = line.match(/^([^:]{1,80}):\s*(\S.*?)$/);
  if (colon && isValueToken(colon[2].trim())) {
    return { label: colon[1].trim(), value: colon[2].trim() };
  }

  return { label: line.trim() };
}

function parseHtml(html: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  let searchFrom = 0;
  tables.forEach((table, tableIndex) => {
    const start = html.indexOf(table, searchFrom);
    const before = html.slice(Math.max(0, start - 400), start);
    searchFrom = start + table.length;
    const heading = before.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const caption = table.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const sectionHint = titleCaseLabel(decodeHtml(caption?.[1] || heading?.[1] || `Statement${tableIndex === 0 ? '' : ` ${tableIndex + 1}`}`));
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((row) => {
      const cells = row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
      return cells.map((cell) => decodeHtml(cell));
    });
    const parsed = sectionsFromMatrix(rows, sectionHint || 'Statement');
    for (const section of parsed) {
      const name = normalizeLabel(section.name) === 'statement' ? sectionHint : section.name;
      for (const line of section.lines) pushLine(sections, name, line);
    }
  });
  return sections;
}

export interface VisionLine {
  label?: string;
  value?: string;
}

export interface VisionSection {
  name?: string;
  lines?: VisionLine[];
}

export interface VisionStatement {
  sections?: VisionSection[];
}

export function visionJsonToStatementText(payload: unknown): string {
  const statement = unwrapVision(payload);
  if (!statement?.sections?.length) return '';
  const blocks: string[] = [];
  for (const section of statement.sections) {
    const name = String(section?.name || 'Statement').trim();
    const lines = (section?.lines || [])
      .map((line) => {
        const label = String(line?.label || '').trim();
        if (!label) return '';
        const value = String(line?.value ?? '').trim();
        return value ? `${label}\t${value}` : label;
      })
      .filter(Boolean);
    if (lines.length === 0) continue;
    blocks.push(`# ${name}`, ...lines);
  }
  return blocks.join('\n');
}

function unwrapVision(payload: unknown): VisionStatement | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as VisionStatement & { statement?: VisionStatement };
  if (Array.isArray(record.sections)) return record;
  if (record.statement && Array.isArray(record.statement.sections)) return record.statement;
  return null;
}
