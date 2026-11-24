import { extractTableWithAgent } from './agent-extract';
import { azureConfigured, extractTablesWithAzure } from './azure-extract';
import { readImportFile } from './intake';
import { extractPdfFragments, readFinancialReport, reportTables, REPORT_SCHEDULE_TABLE } from '@tapestrai/graphql/src/lib/import-intake';
import { refineLocations } from './locate';
import { extractTablesWithLlamaParse, llamaParseConfigured, profileDocument, type DocumentProfile } from './llama-parse';
import { parseFlexibleTable, parseJsonRecords, parseWorkbook, type NamedTable } from './parse-table';
import type { ParsedTable } from './types';
import type { DocumentReading } from '@tapestrai/graphql/src/lib/document-content/reading';

export interface IntakeTable {
  id: string;
  name: string;
  table: ParsedTable;
}

export interface FileIntake {
  method: 'tabular' | 'json' | 'azure_layout' | 'llamaparse' | 'agent' | 'needs_extract' | 'financial_report';
  note: string;
  tables: IntakeTable[];
  /** How a document was assessed and which reader it was sent to. */
  profile?: DocumentProfile;
  /** Every page's words, when an outside reader read the file. Kept so the file can be indexed whole without being sent out again. */
  reading?: DocumentReading | null;
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
    return intakeDocument(fileName, mediaType, bytes);
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

/**
 * A filed financial report with a text layer (a 10-Q, a 10-K, an annual
 * report) read on this server: one table per primary statement, one per
 * schedule of investments, and the report's checks of itself. Null when the
 * file is not one. Nothing leaves the server, however long the report.
 */
export async function readReportTables(fileName: string, bytes: Buffer): Promise<{ tables: IntakeTable[]; note: string; selected: string } | null> {
  if (!fileName.toLowerCase().endsWith('.pdf') && bytes.subarray(0, 5).toString() !== '%PDF-') return null;
  let pages;
  try {
    pages = await extractPdfFragments(new Uint8Array(bytes));
  } catch {
    return null;
  }
  const report = readFinancialReport(pages);
  if (!report) return null;
  const tables = reportTables(report, pages.map((page) => ({ page: page.page, width: page.width, height: page.height })));
  const investments = report.schedules.reduce((count, schedule) => count + schedule.rows.filter((row) => row.kind === 'investment').length, 0);
  const ties = report.checks.filter((check) => check.result === 'Ties').length;
  const note = [
    `Read as a ${report.form ? `${report.form} ` : ''}financial report${report.entityName ? ` of ${report.entityName}` : ''}${report.periodEnd ? ` at ${report.periodEnd}` : ''}:`,
    `${report.statements.length} statement${report.statements.length === 1 ? '' : 's'}`,
    report.schedules.length ? `and ${report.schedules.length} schedule${report.schedules.length === 1 ? '' : 's'} of investments with ${investments} investments.` : 'and no schedule of investments.',
    report.checks.length ? `${ties} of ${report.checks.length} of the report's own subtotals and totals tie.` : '',
  ].filter(Boolean).join(' ');
  const selected = tables.find((table) => table.id.startsWith(REPORT_SCHEDULE_TABLE))?.id ?? tables[0].id;
  return {
    tables: tables.map((table) => ({ id: table.id, name: table.name, table: { headers: table.headers, rows: table.rows, locations: table.locations, pages: table.pages } })),
    note,
    selected,
  };
}

/**
 * Pick a reader for a document from what it looks like.
 * A short PDF with a text layer that already reads as a statement stays local.
 * Scans, images, Word files, and long or table-heavy PDFs go to LlamaParse when
 * it is configured. Azure Document Intelligence is the fallback, and the file
 * is held as "needs extract" when neither reader is available.
 */
async function intakeDocument(fileName: string, mediaType: string, bytes: Buffer): Promise<FileIntake> {
  const profile = await profileDocument(fileName, bytes);
  const type = mediaType || 'application/octet-stream';
  const notes: string[] = [];

  // A filed report is read here, statement by statement, before it is judged too long for the built-in reader.
  if (profile.format === 'pdf') {
    const report = await readReportTables(fileName, bytes);
    if (report) return { method: 'financial_report', note: report.note, tables: report.tables, profile };
  }

  if (profile.route === 'local' && profile.format === 'pdf') {
    try {
      const read = await readImportFile(fileName, bytes);
      if (read.kind !== 'TABULAR') {
        return {
          method: 'tabular',
          note: `Read on this server as a ${read.kind.toLowerCase().replace(/_/g, ' ')}. ${profile.reasons[0]}`,
          tables: asNamed(read.table, 'pdf-local', 'Statement'),
          profile,
        };
      }
    } catch {
      // The built-in reader found nothing it recognizes. A table reader gets a turn below.
    }
  }

  if (llamaParseConfigured() && (profile.route === 'llamaparse' || !azureConfigured())) {
    try {
      const extracted = await extractTablesWithLlamaParse(fileName, type, bytes);
      if (extracted.tables.length > 0) {
        await tightenLocations(extracted.tables, profile.format === 'pdf' ? bytes : null);
        return {
          method: 'llamaparse',
          note: `${extracted.note} ${profile.reasons[0] || ''} Check the columns before loading.`.trim(),
          tables: extracted.tables.map((table, index) => ({
            id: `llamaparse-${index}`,
            name: extracted.pages[index] ? `Page ${extracted.pages[index]} · Table ${index + 1}` : `Table ${index + 1}`,
            table,
          })),
          profile,
          reading: extracted.reading,
        };
      }
      notes.push(extracted.note);
    } catch (error) {
      notes.push(error instanceof Error ? error.message : 'LlamaParse could not read the file.');
    }
  }

  if (azureConfigured()) {
    const extracted = await extractTablesWithAzure(bytes, type);
    return {
      method: 'azure_layout',
      note: [...notes, extracted.note].join(' '),
      tables: extracted.tables.map((table, index) => ({ id: `azure-${index}`, name: `Table ${index + 1}`, table })),
      profile,
    };
  }

  return {
    method: 'needs_extract',
    note: [
      ...notes,
      'This file is a document, not a table. I can read it with LlamaParse or Azure Document Intelligence when one is configured. A CSV, Excel, or JSON extract works in the meantime.',
    ].join(' '),
    tables: [],
    profile,
  };
}

/**
 * A reader that boxes only the table leaves each value with its row. When the PDF
 * has a text layer, find each value on the page so the highlight lands on it.
 */
async function tightenLocations(tables: ParsedTable[], pdf: Buffer | null): Promise<void> {
  if (!pdf) return;
  try {
    const pages = await extractPdfFragments(new Uint8Array(pdf));
    if (!pages.some((page) => page.fragments.length > 0)) return;
    for (const table of tables) {
      if (table.locations) table.locations = refineLocations(table.headers, table.rows, table.locations, pages);
    }
  } catch {
    // The row boxes stay. A highlight on the row is still useful.
  }
}
