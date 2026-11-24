import { createHash, randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DOCUMENT_BUCKET, decodeBytes, formatOfFile, loadReading, readHtml, saveReading, sha256Hex, type DocumentReading, type ReadingPage } from '@tapestrai/graphql/src/lib/document-content';
import { extractPdfPages } from '@tapestrai/graphql/src/lib/import-intake';
import { assertLocalSupabase, localSupabase } from './feed-loader';
import { llamaParseConfigured, readWithLlamaParse } from './llama-parse';
import { couldBeName, rankHits, type EntityLookup, type StoredHit } from './entity-values';
import type { ColumnAssignment } from './suggest';

/**
 * A file in Load data, understood, read in full and made searchable.
 *
 * Indexing keeps the file as a document. A document (a PDF, a scan, a picture,
 * a Word file, a web page) is kept as the file itself, so every page is read:
 * the paragraphs, the tables, the notes under them and the footnotes. A page
 * with no text of its own is read by the outside reader, once. A spreadsheet
 * or a delimited file is kept as a text rendering of its tables.
 *
 * Reading gives the same words back a page at a time, for a person or an agent
 * who needs what a table leaves out. Understanding says what the file is, what
 * was found in it, and which stored records it seems to be about, for a person
 * to confirm before any column is mapped.
 */

/** Fewer characters a page than this, and a PDF's own text is not worth reading: the page is a picture. */
const SCAN_CHARS_PER_PAGE = 120;
const PICTURE = /\.(png|jpe?g|tiff?|bmp)$/i;
const WORD = /\.docx?$/i;

/** What a stored file is, for deciding how its words are read. */
export function fileKind(fileName: string, mediaType: string, bytes: Uint8Array): 'pdf' | 'html' | 'text' | 'picture' | 'word' | 'table' {
  // A delimited file is text too, but it reads as a table, so its rendering is indexed and not its commas.
  if (/\.(csv|tsv|json|xlsx?|xlsm)$/i.test(fileName)) return 'table';
  if (PICTURE.test(fileName) || /^image\//i.test(mediaType)) return 'picture';
  if (WORD.test(fileName) || /wordprocessingml|msword/i.test(mediaType)) return 'word';
  return formatOfFile(fileName, mediaType, bytes) || 'table';
}

/** A PDF's own text, a page at a time, or null when the pages are pictures. */
async function pdfTextPages(bytes: Uint8Array): Promise<ReadingPage[] | null> {
  try {
    // unpdf takes over the buffer it is given, so hand it a copy.
    const pages = await extractPdfPages(new Uint8Array(bytes));
    const chars = pages.reduce((sum, text) => sum + text.replace(/\s/g, '').length, 0);
    if (pages.length === 0 || chars / pages.length < SCAN_CHARS_PER_PAGE) return null;
    return pages.map((text, index) => ({ page: index + 1, text: text.trim() })).filter((page) => page.text);
  } catch {
    return null;
  }
}

interface StoredTable {
  id: string;
  name: string;
  headers: string[];
  rows: Record<string, string>[];
}

export interface IndexedFile {
  indexed: boolean;
  documentId: string | null;
  /** What was indexed, or why nothing was. */
  note: string;
  /** The text came from the file itself, or from the tables read out of it. */
  from: 'original' | 'tables' | null;
  /** The file was already indexed. */
  existing: boolean;
  typeCode: string | null;
}

export interface FileUnderstanding {
  instanceId: string;
  fileName: string;
  /** What kind of file the reading took it for. */
  kind: { code: string; label: string };
  intake: { method: string; note: string | null } | null;
  rowCount: number;
  asOfDate: string | null;
  tables: { tableId: string; name: string; selected: boolean; rowCount: number; headers: string[]; sampleRows: Record<string, string>[] }[];
  /** The types of record the file holds, by the column that identifies each. */
  recordTypes: { domainCode: string; identifiedBy: string; count: number }[];
  /** Set when the file is about one record, such as one borrower's statement. */
  subject: { domainCode: string; code: string; name: string } | null;
  /** Stored records the subject could be, the most likely first. */
  matches: { id: string; code: string; name: string; domainCode: string; confidence?: number; how?: string }[];
  /** Which value in the file names the subject, and how surely a stored record was found. Null when the file names nothing stored. */
  subjectBasis: { column: string; value: string; confidence: number; how: string } | null;
  document: { id: string; title: string; status: string; message: string | null; typeCode: string | null; chunkCount: number; linked: { entityId: string; name: string; role: string }[] } | null;
  documentNote: string | null;
  documentTypes: { code: string; name: string }[];
  /** Whether the original can be shown as a page: a PDF or a picture. */
  viewable: boolean;
}

const KIND_LABEL: Record<string, string> = {
  FINANCIAL_STATEMENT: 'Financial statement',
  NAV_STATEMENT: 'NAV statement',
  POSITION_FILE: 'Position file',
};
const KIND_TYPE: Record<string, string> = { FINANCIAL_STATEMENT: 'FINANCIAL_STATEMENT', NAV_STATEMENT: 'NAV_STATEMENT' };
/** A rendering longer than this is cut. A search index of a very large table adds little. */
const MAX_RENDER_CHARS = 600_000;
const MAX_RENDER_ROWS = 3_000;

function useClient(client?: SupabaseClient): SupabaseClient {
  const db = client || localSupabase();
  assertLocalSupabase(db);
  return db;
}

function storedTables(row: { tables?: unknown; headers?: unknown; parsed_rows?: unknown; file_name: string }): StoredTable[] {
  const tables = (Array.isArray(row.tables) ? row.tables : []) as StoredTable[];
  if (tables.length > 0) return tables;
  const headers = (Array.isArray(row.headers) ? row.headers : []) as string[];
  const rows = (Array.isArray(row.parsed_rows) ? row.parsed_rows : []) as Record<string, string>[];
  return headers.length > 0 ? [{ id: 'table', name: row.file_name, headers, rows }] : [];
}

function cell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

/** The tables of a file as text a search can read: a heading for each, then its rows. */
export function renderTables(fileName: string, tables: StoredTable[]): { text: string; rows: number; cut: boolean } {
  const lines: string[] = [`# ${fileName}`, ''];
  let rows = 0;
  let size = 0;
  let cut = false;
  for (const table of tables) {
    lines.push(`## ${table.name || 'Table'}`, '');
    if (table.headers.length === 2 || table.rows.length === 1) {
      // A statement reads better line by line: each label with its value.
      for (const row of table.rows) {
        for (const header of table.headers) {
          const value = cell(row[header]);
          if (value) lines.push(`${cell(header)}: ${value}`);
        }
        lines.push('');
        rows += 1;
      }
      continue;
    }
    lines.push(`| ${table.headers.map(cell).join(' | ')} |`, `| ${table.headers.map(() => '---').join(' | ')} |`);
    for (const row of table.rows) {
      if (rows >= MAX_RENDER_ROWS || size > MAX_RENDER_CHARS) {
        cut = true;
        break;
      }
      const line = `| ${table.headers.map((header) => cell(row[header])).join(' | ')} |`;
      lines.push(line);
      size += line.length;
      rows += 1;
    }
    lines.push('');
  }
  return { text: lines.join('\n'), rows, cut };
}

async function documentTypes(db: SupabaseClient, clientId: string): Promise<{ id: string; code: string; name: string }[]> {
  const listed = await db.rpc('document_types_list');
  if (listed.error) throw new Error(listed.error.message);
  return ((listed.data || []) as Array<Record<string, any>>)
    .filter((row) => row.is_active !== false && (!row.client_id || row.client_id === clientId))
    // A client's own type with a code wins over the shared one.
    .sort((a, b) => Number(Boolean(b.client_id)) - Number(Boolean(a.client_id)))
    .map((row) => ({ id: String(row.id), code: String(row.type_code), name: String(row.type_name) }))
    .filter((type, index, all) => all.findIndex((other) => other.code === type.code) === index);
}

async function readFile(db: SupabaseClient, id: string, clientId: string) {
  const row = await db.schema('entity_instances').from('import_instances').select('*').eq('id', id).eq('client_id', clientId).maybeSingle();
  if (row.error) throw new Error(row.error.message);
  if (!row.data) throw new Error('Import instance not found');
  return row.data as Record<string, any>;
}

async function note(db: SupabaseClient, id: string, patch: { document_id?: string | null; document_note: string }) {
  await db.schema('entity_instances').from('import_instances').update(patch).eq('id', id);
}

/**
 * Keep a stored file as a searchable document. Never fails the caller: a file
 * that cannot be indexed still loads, and the result says why it was not.
 */
export async function indexImportFile(id: string, clientId: string, input: { typeCode?: string | null } = {}, client?: SupabaseClient): Promise<IndexedFile> {
  const db = useClient(client);
  const file = await readFile(db, id, clientId);
  if (file.document_id) {
    return { indexed: true, documentId: file.document_id, note: file.document_note || 'Already indexed for search.', from: null, existing: true, typeCode: null };
  }
  const failed = async (reason: string): Promise<IndexedFile> => {
    await note(db, id, { document_note: reason }).catch(() => undefined);
    return { indexed: false, documentId: null, note: reason, from: null, existing: false, typeCode: null };
  };

  try {
    const original = Buffer.from(String(file.source_base64 || ''), 'base64');
    const mediaType = String(file.media_type || 'application/octet-stream');
    // A document is kept as the file itself, so every page is read and not only its tables. A page with no text of
    // its own needs the outside reader: the reading kept when the file was loaded, or a new one on the worker.
    const kind = fileKind(String(file.file_name), mediaType, original);
    let readable = kind === 'html' || kind === 'text';
    let viaReader = false;
    if (kind === 'pdf' || kind === 'picture' || kind === 'word') {
      readable = kind === 'pdf' && (await pdfTextPages(original)) !== null;
      if (!readable) {
        viaReader = llamaParseConfigured() || (await loadReading(db, clientId, await sha256Hex(original))) !== null;
        readable = viaReader;
      }
    }
    let bytes = original;
    let fileName = String(file.file_name);
    let storedType = mediaType;
    let from: 'original' | 'tables' = 'original';
    let what = viaReader
      ? 'The file itself is indexed for search: every page as the outside reader read it, with its notes and footnotes.'
      : 'The file itself is indexed for search: every page, with its notes and footnotes.';
    if (!readable) {
      const tables = storedTables(file as never);
      if (tables.length === 0) return failed('Nothing was read from this file, so there is nothing to index for search.');
      const rendered = renderTables(fileName, tables);
      bytes = Buffer.from(rendered.text, 'utf8');
      fileName = `${fileName.replace(/\.[^.]+$/, '')}.tables.md`;
      storedType = 'text/markdown';
      from = 'tables';
      what = `The ${tables.length === 1 ? 'table' : `${tables.length} tables`} read from the file ${tables.length === 1 ? 'is' : 'are'} indexed for search${rendered.cut ? ', up to the first 3,000 rows' : ''}.`;
    }

    const types = await documentTypes(db, clientId);
    const wanted = (input.typeCode || KIND_TYPE[String(file.map_code)] || 'DATA_FILE').toUpperCase();
    const type = types.find((item) => item.code === wanted) || types.find((item) => item.code === 'DATA_FILE') || types.find((item) => item.code === 'OTHER');
    if (!type) return failed('No document type is set up for files loaded this way. Apply supabase/migrations/20261119140000_intake_documents.sql.');

    const documentId = randomUUID();
    const path = `${clientId}/${documentId}/${fileName.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    const uploaded = await db.storage.from(DOCUMENT_BUCKET).upload(path, bytes, { contentType: storedType, upsert: false });
    if (uploaded.error) return failed(`The file could not be stored for search. ${uploaded.error.message}`);
    const created = await db.rpc('document_create', {
      p_id: documentId,
      p_client_id: clientId,
      p_type_id: type.id,
      p_title: String(file.file_name),
      p_file_name: fileName,
      p_media_type: storedType,
      p_size_bytes: bytes.length,
      p_sha256: createHash('sha256').update(bytes).digest('hex'),
      p_storage_path: path,
      p_document_date: file.as_of_date || null,
      p_tags: ['source:load-data'],
      p_entity_links: [],
    });
    const row = created.data as { id: string; duplicate?: boolean } | null;
    if (created.error || !row || row.duplicate) await db.storage.from(DOCUMENT_BUCKET).remove([path]);
    if (created.error || !row) return failed(`The file could not be recorded for search. ${created.error?.message || ''}`.trim());
    const text = row.duplicate ? 'The same content was already indexed for search, so that document is used.' : what;
    await note(db, id, { document_id: row.id, document_note: text });
    return { indexed: true, documentId: row.id, note: text, from, existing: row.duplicate === true, typeCode: type.code };
  } catch (error: any) {
    return failed(`The file could not be indexed for search. ${error?.message || ''}`.trim());
  }
}

export interface FileText {
  instanceId: string;
  fileName: string;
  /** Where the words came from: the file's own text, the outside reader, or the tables read from it. */
  source: 'text layer' | 'outside reader' | 'file' | 'tables';
  pageCount: number;
  /** The pages returned, each with its words. */
  pages: ReadingPage[];
  /** The first page not returned, when the text was cut to fit. */
  nextPage: number | null;
  /** Passages holding the words asked for, when `find` was given. */
  matches?: Array<{ page: number; text: string }>;
  /** The searchable document the file is kept as, once it is indexed. */
  documentId: string | null;
  note: string;
}

/**
 * Every page of a stored file, with the words its own text or the outside
 * reader gives. Null pages when the file has none that can be read here.
 */
async function fileReading(db: SupabaseClient, clientId: string, file: Record<string, any>): Promise<{ source: FileText['source']; pages: ReadingPage[]; note: string }> {
  const fileName = String(file.file_name);
  const mediaType = String(file.media_type || 'application/octet-stream');
  const original = Buffer.from(String(file.source_base64 || ''), 'base64');
  const kind = fileKind(fileName, mediaType, original);
  const fromTables = () => {
    const rendered = renderTables(fileName, storedTables(file as never));
    return { source: 'tables' as const, pages: rendered.text.trim() ? [{ page: 1, text: rendered.text }] : [], note: 'This file is a table. Its rows are given as text.' };
  };
  if (kind === 'table') return fromTables();
  if (kind === 'html') return { source: 'file', pages: [{ page: 1, text: readHtml(decodeBytes(original)).body }], note: 'The page is given as its text.' };
  if (kind === 'text') return { source: 'file', pages: [{ page: 1, text: decodeBytes(original) }], note: 'The file is given as its text.' };
  if (kind === 'pdf') {
    const own = await pdfTextPages(original);
    if (own) return { source: 'text layer', pages: own, note: "The PDF's own text, a page at a time. Notes and footnotes are where they sit on the page." };
  }
  // A scan, a picture or a Word file: the reading kept when it was loaded, or a new one, which is then kept.
  const sha = await sha256Hex(original);
  let reading: DocumentReading | null = await loadReading(db, clientId, sha);
  if (!reading && llamaParseConfigured()) {
    reading = await readWithLlamaParse(fileName, mediaType, original, { timeoutMs: 240_000 });
    if (reading) await saveReading(db, clientId, sha, reading);
  }
  if (reading) return { source: 'outside reader', pages: reading.pages, note: 'Every page as the outside reader read it, in markdown. Notes and footnotes are where they sit on the page.' };
  const tables = fromTables();
  return { ...tables, note: 'This file has no text of its own and no outside reader is set up (LLAMA_CLOUD_API_KEY), so only the tables read from it are given.' };
}

const DEFAULT_TEXT_CHARS = 30_000;
const MAX_TEXT_CHARS = 120_000;

/** The passages of a page that hold every word asked for: the paragraph, with the line before it. */
export function passagesWith(page: ReadingPage, words: string[]): string[] {
  const paragraphs = page.text.split(/\n\s*\n|\n(?=\(?\d{1,3}[).]\s)/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return paragraphs.filter((paragraph) => {
    const lower = paragraph.toLowerCase();
    return words.every((word) => lower.includes(word));
  }).map((paragraph) => {
    if (paragraph.length <= PASSAGE_CHARS) return paragraph;
    // A PDF's own text often has no blank lines, so a "paragraph" is a whole page. Give the lines around
    // the one that holds most of the words, not the top of the page.
    const lines = paragraph.split('\n');
    const hits = lines.map((line) => words.filter((word) => line.toLowerCase().includes(word)).length);
    const best = hits.indexOf(Math.max(...hits));
    let from = Math.max(0, best - 3);
    let to = Math.min(lines.length, best + 9);
    let passage = lines.slice(from, to).join('\n');
    while (passage.length > PASSAGE_CHARS && to - from > 2) {
      if (to - best > best - from) to -= 1;
      else from += 1;
      passage = lines.slice(from, to).join('\n');
    }
    return passage.slice(0, PASSAGE_CHARS);
  });
}

/** The most a passage holds. A longer one is narrowed to the lines around the words asked for. */
const PASSAGE_CHARS = 1_600;

/**
 * The words of a stored file: its pages in order, or the passages that hold
 * what was asked for. Reads only. A page with no text of its own is read by
 * the outside reader the first time, and that reading is kept.
 */
export async function readImportText(
  id: string,
  clientId: string,
  input: { fromPage?: number | null; toPage?: number | null; find?: string | null; maxChars?: number | null } = {},
  client?: SupabaseClient,
): Promise<FileText> {
  const db = useClient(client);
  const file = await readFile(db, id, clientId);
  const read = await fileReading(db, clientId, file);
  const base = { instanceId: String(file.id), fileName: String(file.file_name), source: read.source, pageCount: read.pages.length, documentId: file.document_id ? String(file.document_id) : null };
  const from = Math.max(1, Math.trunc(Number(input.fromPage)) || 1);
  const to = Math.trunc(Number(input.toPage)) || Number.MAX_SAFE_INTEGER;
  const inRange = read.pages.filter((page) => page.page >= from && page.page <= to);

  const words = String(input.find || '').toLowerCase().split(/\s+/).map((word) => word.trim()).filter((word) => word.length > 1).slice(0, 8);
  if (words.length > 0) {
    const matches = inRange.flatMap((page) => passagesWith(page, words).map((text) => ({ page: page.page, text }))).slice(0, 40);
    return { ...base, pages: [], nextPage: null, matches, note: matches.length > 0 ? `${matches.length} passage${matches.length === 1 ? '' : 's'} hold${matches.length === 1 ? 's' : ''} those words. ${read.note}` : `No passage holds all of those words. ${read.note}` };
  }

  const budget = Math.min(MAX_TEXT_CHARS, Math.max(2_000, Math.trunc(Number(input.maxChars)) || DEFAULT_TEXT_CHARS));
  const pages: ReadingPage[] = [];
  let used = 0;
  let nextPage: number | null = null;
  for (const page of inRange) {
    if (pages.length > 0 && used + page.text.length > budget) {
      nextPage = page.page;
      break;
    }
    // A single page longer than the budget is cut, and says so.
    pages.push(page.text.length > budget ? { page: page.page, text: `${page.text.slice(0, budget)}\n[This page is cut here. Ask for it with a larger maxChars to read the rest.]` } : page);
    used += page.text.length;
  }
  return { ...base, pages, nextPage, note: nextPage ? `${read.note} Pages ${pages[0]?.page} to ${pages[pages.length - 1]?.page} of ${read.pages.length} are given. Ask again with fromPage ${nextPage} for the next.` : read.note };
}

function subjectOf(file: Record<string, any>, mappings: ColumnAssignment[]): FileUnderstanding['subject'] {
  const rows = (Array.isArray(file.parsed_rows) ? file.parsed_rows : []) as Record<string, string>[];
  if (rows.length !== 1) return null;
  const identity = mappings.find((item) => item.role === 'identity' && item.domainCode);
  if (!identity?.domainCode) return null;
  const name = mappings.find((item) => item.role === 'name' && item.domainCode === identity.domainCode);
  const code = String(rows[0][identity.sourceColumn] || '').trim();
  const label = String((name ? rows[0][name.sourceColumn] : '') || code).trim();
  return code || label ? { domainCode: identity.domainCode, code, name: label } : null;
}

/**
 * Stored records whose name, code or alias looks like each value, for this client only. The search function
 * has no client filter of its own, so every hit is checked against the client before it is used.
 */
export function storedRecordLookup(db: SupabaseClient, clientId: string): EntityLookup {
  return async (values) => {
    const found = await Promise.all(values.map(async (value) => {
      const result = await db.rpc('search_entity_names', { p_query: value, p_per_domain: 5 });
      return { value, rows: result.error ? [] : ((result.data || []) as Record<string, any>[]) };
    }));
    const ids = [...new Set(found.flatMap((item) => item.rows.map((row) => String(row.id))))];
    if (ids.length === 0) return new Map();
    const mine = await db.schema('entity_instances').from('master_entities').select('id').eq('client_id', clientId).in('id', ids);
    if (mine.error) throw new Error(mine.error.message);
    const allowed = new Set((mine.data || []).map((row: any) => String(row.id)));
    return new Map(found.map((item) => [item.value, item.rows.filter((row) => allowed.has(String(row.id))).map((row): StoredHit => ({
      id: String(row.id),
      code: String(row.entity_code),
      name: String(row.entity_name),
      domainCode: String(row.domain_code),
      alias: row.matched_alias ? String(row.matched_alias) : null,
    }))]));
  };
}

/**
 * Which stored record a one-row file is about. Every value that could be a name is searched for among the
 * client's records, and the record the most surely named wins, whatever the column is called.
 */
async function resolveSubject(
  db: SupabaseClient,
  clientId: string,
  row: Record<string, string>,
  preferred: string[],
): Promise<{ subject: NonNullable<FileUnderstanding['subject']>; matches: FileUnderstanding['matches']; basis: NonNullable<FileUnderstanding['subjectBasis']> } | null> {
  const columns = Object.keys(row).filter((column) => couldBeName(String(row[column] ?? ''))).slice(0, 12);
  if (columns.length === 0) return null;
  const values = [...new Set(columns.map((column) => String(row[column]).trim()))];
  const hits = await storedRecordLookup(db, clientId)(values);
  let best: { column: string; value: string; ranked: ReturnType<typeof rankHits>; preferred: boolean } | null = null;
  for (const column of columns) {
    const value = String(row[column]).trim();
    const ranked = rankHits(value, hits.get(value) || []);
    if (ranked.length === 0) continue;
    const candidate = { column, value, ranked, preferred: preferred.includes(column) };
    if (!best
      || ranked[0].confidence > best.ranked[0].confidence + 0.001
      || (Math.abs(ranked[0].confidence - best.ranked[0].confidence) <= 0.001 && candidate.preferred && !best.preferred)) best = candidate;
  }
  if (!best || best.ranked[0].confidence < 0.7) return null;
  const top = best.ranked[0];
  // Records of another type with the same score are listed too, so a person can pick between them.
  const close = best.ranked.filter((hit) => hit.confidence >= Math.max(0.45, top.confidence - 0.3)).slice(0, 8);
  return {
    subject: { domainCode: top.domainCode, code: top.code, name: top.name },
    matches: close.map((hit) => ({ id: hit.id, code: hit.code, name: hit.name, domainCode: hit.domainCode, confidence: Number(hit.confidence.toFixed(2)), how: hit.how })),
    basis: { column: best.column, value: best.value, confidence: Number(top.confidence.toFixed(2)), how: top.how },
  };
}

export interface FileRecordIdentity {
  fileName: string;
  /** A stored record of the type was named by the file, or chosen by a person. */
  identified: boolean;
  /** The records, as ids. The same shape the run's selection step gives, so later steps read it the same way. */
  filtered: true;
  entityIds: string[];
  records: { id: string; code: string; name: string; domainCode: string; confidence: number; how: string; column: string | null; value: string | null }[];
  /** Records that resemble a value in the file but not surely enough to use. A person picks among them. */
  candidates: { id: string; code: string; name: string; domainCode: string; confidence: number; how: string; column: string; value: string }[];
  /** Why nothing was identified, or how it was. */
  note: string;
}

/** Surest match a record needs before the file counts as naming it without a person's say. */
const IDENTIFIED_AT = 0.88;

/**
 * Which stored records of one type a file names. Every value that could be a name is searched among the
 * client's records of that type. A record counts when a value names it surely, and one value that two records
 * name equally well is not guessed. A person's choice (chosenEntityId) is used as it is once it is checked.
 */
export async function identifyFileRecord(
  id: string,
  clientId: string,
  recordType: string,
  chosenEntityId?: string | null,
  client?: SupabaseClient,
): Promise<FileRecordIdentity> {
  const db = useClient(client);
  const file = await readFile(db, id, clientId);
  const type = recordType.trim().toUpperCase();
  const empty = (note: string): FileRecordIdentity => ({ fileName: String(file.file_name), identified: false, filtered: true, entityIds: [], records: [], candidates: [], note });

  if (chosenEntityId) {
    const chosen = await db.schema('entity_instances').from('master_entities').select('id, entity_code, entity_name, domain_code')
      .eq('client_id', clientId).eq('domain_code', type).eq('is_active', true).eq('id', chosenEntityId).maybeSingle();
    if (chosen.error) throw new Error(chosen.error.message);
    if (!chosen.data) return empty('The record that was chosen is not a stored record of this type.');
    const row = chosen.data as Record<string, any>;
    return {
      fileName: String(file.file_name),
      identified: true,
      filtered: true,
      entityIds: [String(row.id)],
      records: [{ id: String(row.id), code: row.entity_code, name: row.entity_name, domainCode: row.domain_code, confidence: 1, how: 'a person chose it', column: null, value: null }],
      candidates: [],
      note: `${row.entity_name} was chosen by a person.`,
    };
  }

  const rows = (Array.isArray(file.parsed_rows) ? file.parsed_rows : []) as Record<string, string>[];
  const seen = new Map<string, { column: string; value: string }>();
  for (const row of rows.slice(0, 200)) {
    for (const [column, raw] of Object.entries(row)) {
      const value = String(raw ?? '').trim();
      if (couldBeName(value) && !seen.has(value) && seen.size < 40) seen.set(value, { column, value });
    }
  }
  if (seen.size === 0) return empty('The file has no value that could be a name.');

  const hits = await storedRecordLookup(db, clientId)([...seen.keys()]);
  const named = new Map<string, FileRecordIdentity['records'][number]>();
  const leads = new Map<string, FileRecordIdentity['candidates'][number]>();
  const ambiguous: string[] = [];
  for (const { column, value } of seen.values()) {
    const ranked = rankHits(value, (hits.get(value) || []).filter((hit) => hit.domainCode === type));
    if (ranked.length === 0) continue;
    const top = ranked[0];
    const tied = ranked.filter((hit) => hit.id !== top.id && hit.confidence >= top.confidence - 0.02);
    if (top.confidence >= IDENTIFIED_AT && tied.length === 0) {
      const current = named.get(top.id);
      if (!current || top.confidence > current.confidence) named.set(top.id, { id: top.id, code: top.code, name: top.name, domainCode: top.domainCode, confidence: Number(top.confidence.toFixed(2)), how: top.how, column, value });
      continue;
    }
    if (top.confidence >= IDENTIFIED_AT) ambiguous.push(value);
    for (const hit of ranked.slice(0, 5)) {
      if (named.has(hit.id)) continue;
      const current = leads.get(hit.id);
      if (!current || hit.confidence > current.confidence) leads.set(hit.id, { id: hit.id, code: hit.code, name: hit.name, domainCode: hit.domainCode, confidence: Number(hit.confidence.toFixed(2)), how: hit.how, column, value });
    }
  }
  const records = [...named.values()].sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  const candidates = [...leads.values()].filter((hit) => !named.has(hit.id)).sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name)).slice(0, 8);
  const label = type.toLowerCase().replace(/_/g, ' ');
  if (records.length > 0) {
    return { fileName: String(file.file_name), identified: true, filtered: true, entityIds: records.map((item) => item.id), records, candidates, note: `${records.map((item) => item.name).join(', ')} ${records.length === 1 ? 'is' : 'are'} named in the file.` };
  }
  return {
    ...empty(ambiguous.length > 0
      ? `“${ambiguous[0]}” fits more than one stored ${label} equally well, so a person has to choose.`
      : candidates.length > 0
        ? `No value in the file names a stored ${label} surely enough. The closest are listed.`
        : `No value in the file names a stored ${label}.`),
    candidates,
  };
}

/** The client's stored records of one type whose name, code or alias contains the text, for a person who is choosing. */
export async function searchStoredRecords(clientId: string, recordType: string, query: string, client?: SupabaseClient): Promise<{ id: string; code: string; name: string; domainCode: string }[]> {
  const text = query.trim();
  if (text.length < 2) return [];
  const type = recordType.trim().toUpperCase();
  const hits = await storedRecordLookup(useClient(client), clientId)([text]);
  return (hits.get(text) || [])
    .filter((hit) => hit.domainCode === type)
    .map((hit) => ({ id: hit.id, code: hit.code, name: hit.name, domainCode: hit.domainCode }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What a stored file is and what was found in it. Reads only. */
export async function understandImportFile(id: string, clientId: string, client?: SupabaseClient): Promise<FileUnderstanding> {
  const db = useClient(client);
  const file = await readFile(db, id, clientId);
  const mappings = (Array.isArray(file.column_mappings) ? file.column_mappings : []) as ColumnAssignment[];
  const tables = storedTables(file as never);
  const selectedId = file.table_id || tables[0]?.id || null;
  const mapCode = String(file.map_code || '');
  const fallbackSubject = subjectOf(file, mappings);
  const parsed = (Array.isArray(file.parsed_rows) ? file.parsed_rows : []) as Record<string, string>[];
  // The identity column is only a hint of what the file is about. The stored record the file's values most
  // surely name decides it, so a statement for Halyard Systems is about the issuer, not about its own number.
  const resolved = parsed.length === 1
    ? await resolveSubject(db, clientId, parsed[0], mappings.filter((item) => item.role === 'identity' || item.role === 'name').map((item) => item.sourceColumn)).catch(() => null)
    : null;
  const subject = resolved?.subject || fallbackSubject;
  const subjectBasis = resolved?.basis || null;

  const recordTypes = mappings
    .filter((item) => item.role === 'identity' && item.domainCode)
    .map((item) => ({ domainCode: item.domainCode as string, identifiedBy: item.sourceColumn, count: item.distinctCount ?? 0 }));

  let matches: FileUnderstanding['matches'] = resolved?.matches || [];
  if (subject && !resolved) {
    const safe = (value: string) => value.replace(/[%,()]/g, ' ').trim();
    const filters = [subject.code ? `entity_code.eq.${safe(subject.code)}` : '', subject.name ? `entity_name.ilike.%${safe(subject.name)}%` : ''].filter(Boolean);
    const found = filters.length
      ? await db.schema('entity_instances').from('master_entities').select('id, entity_code, entity_name, domain_code')
          .eq('client_id', clientId).eq('domain_code', subject.domainCode).eq('is_active', true).or(filters.join(',')).limit(5)
      : { data: [], error: null };
    if (found.error) throw new Error(found.error.message);
    matches = (found.data || []).map((row: any) => ({ id: row.id, code: row.entity_code, name: row.entity_name, domainCode: row.domain_code }));
  }

  let document: FileUnderstanding['document'] = null;
  if (file.document_id) {
    const got = await db.rpc('document_get', { p_id: file.document_id });
    const row = got.data as Record<string, any> | null;
    if (row) {
      const sections = Array.isArray(row.sections) ? (row.sections as Array<Record<string, any>>) : [];
      document = {
        id: row.id,
        title: row.title,
        status: String(row.status || ''),
        message: row.status_message || row.message || null,
        typeCode: row.type_code || null,
        chunkCount: sections.reduce((sum, section) => sum + (Number(section.chunk_count) || 0), 0),
        linked: (Array.isArray(row.entities) ? row.entities : []).map((entity: any) => ({ entityId: entity.entity_id, name: entity.entity_name, role: entity.role })),
      };
    }
  }

  return {
    instanceId: file.id,
    fileName: file.file_name,
    kind: { code: mapCode, label: KIND_LABEL[mapCode] || 'Table of records' },
    intake: file.intake_method ? { method: file.intake_method, note: file.intake_note || null } : null,
    rowCount: Number(file.row_count) || 0,
    asOfDate: file.as_of_date || null,
    tables: tables.map((table) => ({
      tableId: table.id,
      name: table.name,
      selected: table.id === selectedId,
      rowCount: table.rows.length,
      headers: table.headers,
      sampleRows: table.rows.slice(0, 8).map((row) => Object.fromEntries(table.headers.map((header) => [header, String(row[header] ?? '').slice(0, 120)]))),
    })),
    recordTypes,
    subject,
    subjectBasis,
    matches,
    document,
    documentNote: file.document_note || null,
    documentTypes: (await documentTypes(db, clientId).catch(() => [])).map(({ code, name }) => ({ code, name })),
    viewable: /\.(pdf|png|jpe?g)$/i.test(String(file.file_name)),
  };
}

/**
 * Record what a person confirmed about a file: the kind of document it is, and
 * the stored record it is about. Both are kept on the file's document, so a
 * search of that record's documents finds it.
 */
export async function confirmImportUnderstanding(
  id: string,
  clientId: string,
  input: { documentTypeCode?: string | null; entityId?: string | null; role?: string | null },
  client?: SupabaseClient,
): Promise<FileUnderstanding> {
  const db = useClient(client);
  const file = await readFile(db, id, clientId);
  if (file.document_id && (input.documentTypeCode || input.entityId)) {
    const types = await documentTypes(db, clientId);
    const type = input.documentTypeCode ? types.find((item) => item.code === String(input.documentTypeCode).toUpperCase()) : null;
    if (input.documentTypeCode && !type) throw new Error('Choose a document type from the list.');
    if (input.entityId) {
      // This runs with the service role, so the record the caller names is checked here: it must be one of this client's.
      const owned = await db.schema('entity_instances').from('master_entities').select('id').eq('id', input.entityId).eq('client_id', clientId).maybeSingle();
      if (owned.error || !owned.data) throw new Error('Choose one of this client\'s records for the file.');
    }
    const updated = await db.rpc('document_update', {
      p_id: file.document_id,
      p_title: null,
      p_type_id: type?.id || null,
      p_document_date: null,
      p_clear_date: false,
      p_tags: null,
      p_entity_links: input.entityId ? [{ entityId: input.entityId, role: input.role || 'SUBJECT' }] : null,
    });
    if (updated.error) throw new Error(updated.error.message);
  }
  return understandImportFile(id, clientId, db);
}
