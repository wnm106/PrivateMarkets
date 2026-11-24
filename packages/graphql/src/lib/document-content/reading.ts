/**
 * A reading: every page of a file as an outside reader read it, in markdown.
 *
 * A scan, a photographed page or a Word file has no text of its own to read
 * here, so a reader that sees the page (LlamaParse) reads it. What it returns
 * is the whole page: the paragraphs, the tables, the notes under them and the
 * footnotes at the foot. The tables alone are what Load data maps; the reading
 * is what Documents indexes, so nothing on the page is lost to search.
 *
 * A reading is kept once per client and file content, in the documents bucket,
 * so a file read when it was loaded is not sent out again when it is indexed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ReadingPage {
  /** 1 for the first page. */
  page: number;
  /** The page's words as markdown. */
  text: string;
}

export interface DocumentReading {
  /** Which reader read it, for the record: "llamaparse". */
  reader: string;
  pages: ReadingPage[];
}

/**
 * Reads a file this server cannot read itself. Returns null when no reader is
 * set up. The file leaves for an outside service here.
 */
export type OutsideReader = (fileName: string, mediaType: string | null, bytes: Uint8Array) => Promise<DocumentReading | null>;

/** The bucket readings are kept in. The same one documents are stored in. */
const READING_BUCKET = 'documents';

/** A reading as stored, checked: pages in order, each with words. Null when there is nothing to read. */
export function cleanReading(value: unknown): DocumentReading | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { reader?: unknown; pages?: unknown };
  const pages = (Array.isArray(raw.pages) ? raw.pages : [])
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { page?: unknown; text?: unknown }) : {}))
    .map((entry) => ({ page: Math.trunc(Number(entry.page)), text: typeof entry.text === 'string' ? entry.text.trim() : '' }))
    .filter((entry) => Number.isFinite(entry.page) && entry.page > 0 && entry.text !== '')
    .sort((a, b) => a.page - b.page);
  if (pages.length === 0) return null;
  return { reader: typeof raw.reader === 'string' && raw.reader ? raw.reader : 'reader', pages };
}

/** How many characters a reading holds, to tell a real reading from an empty one. */
export function readingLength(reading: DocumentReading | null): number {
  return reading ? reading.pages.reduce((sum, page) => sum + page.text.replace(/\s/g, '').length, 0) : 0;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Where a client's reading of one file's content is kept. */
export function readingPath(clientId: string, sha256: string): string {
  return `${clientId}/readings/${sha256}.json`;
}

/** The reading kept for this content, or null. Never throws: a reading that cannot be fetched is read again. */
export async function loadReading(supabase: SupabaseClient, clientId: string, sha256: string): Promise<DocumentReading | null> {
  try {
    const { data, error } = await supabase.storage.from(READING_BUCKET).download(readingPath(clientId, sha256));
    if (error || !data) return null;
    return cleanReading(JSON.parse(await data.text()));
  } catch {
    return null;
  }
}

/** Keeps a reading for this content. Never throws: a reading that cannot be kept only costs another read later. */
export async function saveReading(supabase: SupabaseClient, clientId: string, sha256: string, reading: DocumentReading): Promise<boolean> {
  const clean = cleanReading(reading);
  if (!clean) return false;
  try {
    const { error } = await supabase.storage
      .from(READING_BUCKET)
      .upload(readingPath(clientId, sha256), new Blob([JSON.stringify(clean)], { type: 'application/json' }), { contentType: 'application/json', upsert: true });
    return !error;
  } catch {
    return false;
  }
}

/**
 * The reading of a file this server cannot read: the one kept, or a new one
 * from the reader, which is then kept. Null when there is none and no reader.
 */
export async function outsideReading(
  supabase: SupabaseClient,
  clientId: string,
  file: { fileName: string; mediaType: string | null; bytes: Uint8Array },
  reader: OutsideReader | null | undefined,
): Promise<DocumentReading | null> {
  const sha = await sha256Hex(file.bytes);
  const kept = await loadReading(supabase, clientId, sha);
  if (kept) return kept;
  if (!reader) return null;
  const read = cleanReading(await reader(file.fileName, file.mediaType, file.bytes));
  if (read) await saveReading(supabase, clientId, sha, read);
  return read;
}
