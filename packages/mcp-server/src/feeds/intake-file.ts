import { extractTableWithAgent } from './agent-extract';
import { azureConfigured, extractTablesWithAzure } from './azure-extract';
import { readImportFile } from './intake';
import { extractPdfFragments } from '@tapestrai/graphql/src/lib/import-intake';
import { refineLocations } from './locate';
import { extractTablesWithLlamaParse, llamaParseConfigured, profileDocument, type DocumentProfile } from './llama-parse';
import { parseFlexibleTable, parseJsonRecords, parseWorkbook, type NamedTable } from './parse-table';
import type { ParsedTable } from './types';

export interface IntakeTable {
  id: string;
  name: string;
  table: ParsedTable;
}

export interface FileIntake {
  method: 'tabular' | 'json' | 'azure_layout' | 'llamaparse' | 'agent' | 'needs_extract';
  note: string;
  tables: IntakeTable[];
  /** How a document was assessed and which reader it was sent to. */
  profile?: DocumentProfile;
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
