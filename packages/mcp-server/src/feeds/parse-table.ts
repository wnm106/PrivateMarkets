import * as XLSX from 'xlsx';
import type { ParsedTable } from './types';

export function parseDelimited(text: string, delimiter: ',' | '\t' | ';'): ParsedTable {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const grid: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

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
    if (char === '"') {
      inQuotes = true;
    } else     if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      grid.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    grid.push(row);
  }

  const headers = (grid.shift() || []).map((header) => header.trim());
  const rows = grid
    .filter((cells) => cells.some((value) => value.trim() !== ''))
    .map((cells) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        if (!header) return;
        record[header] = (cells[index] ?? '').trim();
      });
      return record;
    });
  return { headers: headers.filter(Boolean), rows };
}

export function parseCsv(text: string): ParsedTable {
  return parseDelimited(text, ',');
}

/** Pick the delimiter that yields the widest header row. */
export function parseFlexibleTable(text: string): ParsedTable {
  const candidates = [parseDelimited(text, ','), parseDelimited(text, '\t'), parseDelimited(text, ';')];
  return candidates.sort((left, right) => right.headers.length - left.headers.length || right.rows.length - left.rows.length)[0];
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = value.getUTCMonth() + 1;
    const day = value.getUTCDate();
    const year = value.getUTCFullYear();
    return `${month}/${day}/${year}`;
  }
  return String(value).trim();
}

export function parseXlsx(buffer: Buffer): ParsedTable {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<(string | number | Date | null)[]>(sheet, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: false,
  });
  const [headerRow, ...body] = matrix;
  const headers = (headerRow || []).map((cell) => cellToString(cell)).filter(Boolean);
  const rows = body
    .filter((cells) => cells.some((cell) => cellToString(cell) !== ''))
    .map((cells) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = cellToString(cells[index]);
      });
      return record;
    });
  return { headers, rows };
}

export function parseTabularFile(fileName: string, bytes: Buffer): ParsedTable {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    return parseCsv(bytes.toString('utf8'));
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return parseXlsx(bytes);
  }
  throw new Error('Upload a CSV or Excel file');
}

export interface NamedTable {
  id: string;
  name: string;
  table: ParsedTable;
}

function matrixToTable(matrix: (string | number | Date | null)[][]): ParsedTable {
  const [headerRow, ...body] = matrix;
  const headers = (headerRow || []).map((cell) => cellToString(cell)).filter(Boolean);
  const rows = body
    .filter((cells) => cells.some((cell) => cellToString(cell) !== ''))
    .map((cells) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = cellToString(cells[index]);
      });
      return record;
    });
  return { headers, rows };
}

export function parseWorkbook(buffer: Buffer): NamedTable[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  return workbook.SheetNames.map((name, index) => {
    const sheet = workbook.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json<(string | number | Date | null)[]>(sheet, {
      header: 1,
      raw: true,
      defval: '',
      blankrows: false,
    });
    return { id: `sheet-${index}`, name, table: matrixToTable(matrix) };
  }).filter((item) => item.table.headers.length > 0 && item.table.rows.length > 0);
}

function flattenRecord(value: unknown, prefix = '', depth = 0): Record<string, string> {
  if (value === null || value === undefined) return prefix ? { [prefix]: '' } : {};
  if (Array.isArray(value)) {
    const rendered = value.map((item) => (item !== null && typeof item === 'object' ? JSON.stringify(item) : cellToString(item))).join('; ');
    return { [prefix || 'value']: rendered };
  }
  if (typeof value !== 'object' || value instanceof Date || depth >= 2) {
    return { [prefix || 'value']: cellToString(value) };
  }
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, flattenRecord(child, prefix ? `${prefix}.${key}` : key, depth + 1));
  }
  return out;
}

function unwrapRecords(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['rows', 'data', 'records', 'items', 'results']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return null;
}

export function parseJsonRecords(text: string): ParsedTable {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { headers: [], rows: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const records = trimmed.split(/\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    parsed = records;
  }
  const records = unwrapRecords(parsed);
  if (!records) throw new Error('JSON must be a list of records, or an object with rows, data, or records');
  const rows = records.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item) => flattenRecord(item));
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  return { headers, rows };
}
