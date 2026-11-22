import { createHash, randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DOCUMENT_BUCKET, formatOfFile } from '@tapestrai/graphql/src/lib/document-content';
import { assertLocalSupabase, localSupabase } from './feed-loader';
import type { ColumnAssignment } from './suggest';

/**
 * A file in Load data, understood and made searchable.
 *
 * Indexing keeps the file as a document: the original when its text can be
 * read, otherwise a text rendering of the tables read from it, so a spreadsheet
 * or a scan is searchable too. Understanding says what the file is, what was
 * found in it, and which stored records it seems to be about, for a person to
 * confirm before any column is mapped.
 */

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
  /** Stored records the subject could be. */
  matches: { id: string; code: string; name: string; domainCode: string }[];
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
const OUTSIDE_READERS = new Set(['llamaparse', 'azure_layout', 'agent']);
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
    // A file an outside reader had to read has no text layer of its own, so its tables are what can be searched.
    // A delimited file is text too, but it reads as a table, so its rendering is indexed and not its commas.
    const format = /\.(csv|tsv|json)$/i.test(String(file.file_name)) ? null : formatOfFile(file.file_name, mediaType, original);
    const readable = Boolean(format) && !OUTSIDE_READERS.has(String(file.intake_method || ''));
    let bytes = original;
    let fileName = String(file.file_name);
    let storedType = mediaType;
    let from: 'original' | 'tables' = 'original';
    let what = 'The file itself is indexed for search.';
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

/** What a stored file is and what was found in it. Reads only. */
export async function understandImportFile(id: string, clientId: string, client?: SupabaseClient): Promise<FileUnderstanding> {
  const db = useClient(client);
  const file = await readFile(db, id, clientId);
  const mappings = (Array.isArray(file.column_mappings) ? file.column_mappings : []) as ColumnAssignment[];
  const tables = storedTables(file as never);
  const selectedId = file.table_id || tables[0]?.id || null;
  const mapCode = String(file.map_code || '');
  const subject = subjectOf(file, mappings);

  const recordTypes = mappings
    .filter((item) => item.role === 'identity' && item.domainCode)
    .map((item) => ({ domainCode: item.domainCode as string, identifiedBy: item.sourceColumn, count: item.distinctCount ?? 0 }));

  let matches: FileUnderstanding['matches'] = [];
  if (subject) {
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
