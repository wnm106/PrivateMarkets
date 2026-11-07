import * as XLSX from 'xlsx';
import {
  extractPdfText,
  interpretMatrices,
  interpretText,
  type ImportFormat,
  type ImportTarget,
  type InterpretedImport,
} from '@tapestrai/graphql/src/lib/import-intake';
import type { ColumnHint } from './suggest';
import type { ParsedTable } from './types';

export interface ImportRead extends InterpretedImport {
  table: ParsedTable;
  hints: ColumnHint[];
}

export async function readImportFile(fileName: string, bytes: Buffer): Promise<ImportRead> {
  const format = sniffFormat(fileName, bytes);
  if (format === 'pdf') {
    const text = await extractPdfText(new Uint8Array(bytes));
    if (!text.trim()) {
      throw new Error(`${fileName} has no text layer. Export the statement to Excel or CSV, or upload a PDF with selectable text.`);
    }
    return pack(interpretText(fileName, text, 'pdf'));
  }
  if (format === 'xlsx') return pack(interpretMatrices(fileName, workbookSheets(bytes), 'xlsx'));
  return pack(interpretText(fileName, bytes.toString('utf8'), format));
}

export function sniffFormat(fileName: string, bytes: Buffer): ImportFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf') || bytes.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return 'xlsx';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  const start = bytes.subarray(0, 1).toString('utf8');
  if (start === '{' || start === '[') return 'json';
  return 'csv';
}

function pack(doc: InterpretedImport): ImportRead {
  if (doc.headers.length === 0 || doc.rows.length === 0) {
    throw new Error(doc.reason || 'The file did not contain any rows.');
  }
  return {
    ...doc,
    table: { headers: doc.headers, rows: doc.rows },
    hints: doc.targets.map(toHint),
  };
}

function toHint(target: ImportTarget): ColumnHint {
  return {
    sourceColumn: target.column,
    role: target.role,
    domainCode: target.domainCode,
    attributeCode: target.attributeCode,
    parentDomainCode: target.parentDomainCode,
    confidence: target.confidence,
    reason: target.reason,
  };
}

function workbookSheets(bytes: Buffer): Array<{ name: string; rows: string[][] }> {
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: true });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json<(string | number | Date | null)[]>(sheet, {
      header: 1,
      raw: true,
      defval: '',
      blankrows: false,
    });
    return {
      name,
      rows: matrix.map((row) => (row || []).map((cell) => cellToString(cell))),
    };
  });
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
