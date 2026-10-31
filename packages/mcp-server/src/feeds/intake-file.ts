import { extractTableWithAgent } from './agent-extract';
import { azureConfigured, extractTablesWithAzure } from './azure-extract';
import { parseFlexibleTable, parseJsonRecords, parseWorkbook, type NamedTable } from './parse-table';
import type { ParsedTable } from './types';

export interface IntakeTable {
  id: string;
  name: string;
  table: ParsedTable;
}

export interface FileIntake {
  method: 'tabular' | 'json' | 'azure_layout' | 'agent' | 'needs_extract';
  note: string;
  tables: IntakeTable[];
}

const DOCUMENT_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.docx', '.doc'];

function asNamed(table: ParsedTable, id: string, name: string): IntakeTable[] {
  if (table.headers.length === 0 || table.rows.length === 0) return [];
  return [{ id, name, table }];
}

/**
 * Turn an upload into one or more tables.
 * Structured files are parsed directly. Documents go through Azure Document Intelligence
 * when it is configured, and loose text can be lifted into a table by the model.
 */
export async function intakeFile(fileName: string, mediaType: string, bytes: Buffer): Promise<FileIntake> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) {
    const table = parseJsonRecords(bytes.toString('utf8'));
    return { method: 'json', note: 'I read the file as JSON records.', tables: asNamed(table, 'json', 'Records') };
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const sheets: NamedTable[] = parseWorkbook(bytes);
    return {
      method: 'tabular',
      note: sheets.length > 1 ? `The workbook has ${sheets.length} sheets.` : 'I read the workbook.',
      tables: sheets,
    };
  }
  if (DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    if (!azureConfigured()) {
      return {
        method: 'needs_extract',
        note: 'This file is a document, not a table. I can read it with Azure Document Intelligence when that is configured. A CSV, Excel, or JSON extract works in the meantime.',
        tables: [],
      };
    }
    const extracted = await extractTablesWithAzure(bytes, mediaType || 'application/octet-stream');
    return {
      method: 'azure_layout',
      note: extracted.note,
      tables: extracted.tables.map((table, index) => ({ id: `azure-${index}`, name: `Table ${index + 1}`, table })),
    };
  }

  const text = bytes.toString('utf8');
  if (!text.includes('\0')) {
    const table = parseFlexibleTable(text);
    if (table.headers.length >= 2 && table.rows.length > 0) {
      return { method: 'tabular', note: 'I read the file as a table.', tables: asNamed(table, 'table', fileName) };
    }
    const extracted = await extractTableWithAgent(text, fileName);
    if (extracted) {
      return {
        method: 'agent',
        note: 'The file was not a clean table, so I extracted one. Check the columns before loading.',
        tables: asNamed(extracted, 'agent', 'Extracted table'),
      };
    }
  }
  return {
    method: 'needs_extract',
    note: 'I could not find a table in this file. Upload CSV, Excel, or JSON, or configure Azure Document Intelligence for PDFs and scans.',
    tables: [],
  };
}
