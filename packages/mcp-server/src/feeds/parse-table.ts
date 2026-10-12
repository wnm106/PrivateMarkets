import * as XLSX from 'xlsx';
import type { ParsedTable } from './types';

export function parseCsv(text: string): ParsedTable {
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
    } else if (char === ',') {
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
