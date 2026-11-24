import { extractPdfPages } from '@tapestrai/graphql/src/lib/import-intake';
import type { DocumentReading, ReadingPage } from '@tapestrai/graphql/src/lib/document-content/reading';
import type { CellLocation, PageSize, ParsedTable } from './types';

/**
 * LlamaParse (LlamaCloud parse API v2) reads documents that a plain text layer
 * cannot: scans, photographed pages, Word files, and PDFs with dense or
 * multi-page tables. It is an outside service, so a document is sent there only
 * when its profile calls for it and the key is configured.
 *
 * One call returns two things. The tables are what Load data maps. The reading is
 * every page's words (paragraphs, tables, notes and footnotes), which is what
 * Documents indexes, so nothing on the page is lost to search.
 */

const BASE_URL = 'https://api.cloud.llamaindex.ai';

export class LlamaParseUnavailable extends Error {
  constructor() {
    super('LlamaParse is not configured');
    this.name = 'LlamaParseUnavailable';
  }
}

export function llamaParseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.LLAMA_CLOUD_API_KEY);
}

// ---------------------------------------------------------------------------
// Document profile

export type DocumentFormat = 'pdf' | 'image' | 'office' | 'other';

export interface DocumentProfile {
  format: DocumentFormat;
  pages: number | null;
  /** Average characters of selectable text per page. Near zero for a scan. */
  charsPerPage: number | null;
  /** Share of text lines that look like table rows. */
  tableLikeShare: number | null;
  /** 'llamaparse' when the document needs a reader that sees layout or pixels. */
  route: 'llamaparse' | 'local';
  /** Why the route was chosen, in plain words. */
  reasons: string[];
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp'];
const OFFICE_EXTENSIONS = ['.docx', '.doc'];

/** Fewer characters per page than this means the page is an image, not text. */
const SCAN_CHARS_PER_PAGE = 120;
/** Past this many pages, a table is likely to run across page breaks. */
const LONG_DOCUMENT_PAGES = 5;
/** This share of table-like lines marks a document that is mostly tables. */
const TABLE_HEAVY_SHARE = 0.2;

export function isTableLikeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if ((trimmed.match(/\t/g) || []).length >= 2) return true;
  if ((trimmed.match(/\s{2,}/g) || []).length >= 2) return true;
  const numeric = trimmed.split(/\s+/).filter((token) => /^[($€£-]?[\d.,]+%?\)?$/.test(token));
  return numeric.length >= 3;
}

export function formatOf(fileName: string): DocumentFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'image';
  if (OFFICE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'office';
  return 'other';
}

/** Decide from the pages' text which reader a PDF needs. Pure, so it can be tested without a file. */
export function profilePdfPages(pageTexts: string[]): DocumentProfile {
  const pages = pageTexts.length;
  const chars = pageTexts.reduce((sum, text) => sum + text.replace(/\s/g, '').length, 0);
  const charsPerPage = pages > 0 ? Math.round(chars / pages) : 0;
  const lines = pageTexts.flatMap((text) => text.split('\n')).filter((line) => line.trim());
  const tableLikeShare = lines.length > 0 ? Number((lines.filter(isTableLikeLine).length / lines.length).toFixed(2)) : 0;
  const reasons: string[] = [];

  if (pages === 0 || charsPerPage < SCAN_CHARS_PER_PAGE) {
    reasons.push('The pages have little or no selectable text, so they look like scans.');
    return { format: 'pdf', pages, charsPerPage, tableLikeShare, route: 'llamaparse', reasons };
  }
  if (tableLikeShare >= TABLE_HEAVY_SHARE) {
    reasons.push(`${Math.round(tableLikeShare * 100)}% of the lines look like table rows.`);
  }
  if (pages >= LONG_DOCUMENT_PAGES) {
    reasons.push(`${pages} pages, so tables may run across page breaks.`);
  }
  if (reasons.length > 0) return { format: 'pdf', pages, charsPerPage, tableLikeShare, route: 'llamaparse', reasons };
  return {
    format: 'pdf',
    pages,
    charsPerPage,
    tableLikeShare,
    route: 'local',
    reasons: ['A short PDF with selectable text and few tables. The built-in reader is enough.'],
  };
}

export async function profileDocument(fileName: string, bytes: Buffer): Promise<DocumentProfile> {
  const format = formatOf(fileName);
  if (format === 'image') {
    return { format, pages: 1, charsPerPage: null, tableLikeShare: null, route: 'llamaparse', reasons: ['An image has to be read with OCR.'] };
  }
  if (format === 'office') {
    return { format, pages: null, charsPerPage: null, tableLikeShare: null, route: 'llamaparse', reasons: ['A Word file keeps its tables in layout, not as a grid.'] };
  }
  if (format === 'pdf') {
    try {
      return profilePdfPages(await extractPdfPages(new Uint8Array(bytes)));
    } catch {
      return { format, pages: null, charsPerPage: null, tableLikeShare: null, route: 'llamaparse', reasons: ['The built-in reader could not open this PDF.'] };
    }
  }
  return { format, pages: null, charsPerPage: null, tableLikeShare: null, route: 'local', reasons: ['Not a document that needs layout reading.'] };
}

// ---------------------------------------------------------------------------
// Result to tables

interface ParseBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ParseItem {
  type?: string;
  rows?: unknown[][];
  md?: string;
  bbox?: ParseBox[];
}

function cleanCell(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function uniqueHeaders(row: unknown[]): string[] {
  const seen = new Map<string, number>();
  return row.map((cell, index) => {
    const label = cleanCell(cell) || `Column ${index + 1}`;
    const count = (seen.get(label) || 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label} (${count})`;
  });
}

function sameHeaders(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((cell, index) => cell.toLowerCase() === right[index].toLowerCase());
}

/**
 * Tables from a parse result. The first row of each table is its header. A table
 * on a later page that starts with the same header row continues the earlier one.
 */
export function tablesFromParse(result: any): { tables: ParsedTable[]; pages: number[] } {
  const tables: ParsedTable[] = [];
  const pageOf: number[] = [];
  const pages: { page_number?: number; page_width?: number; page_height?: number; items?: ParseItem[] }[] = result?.items?.pages || [];
  for (const page of pages) {
    for (const item of page.items || []) {
      if (item.type !== 'table' || !Array.isArray(item.rows) || item.rows.length < 2) continue;
      const width = Math.max(...item.rows.map((row) => (Array.isArray(row) ? row.length : 0)));
      if (width < 2) continue;
      const matrix = item.rows.map((row) => {
        const cells = Array.isArray(row) ? row.map(cleanCell) : [];
        while (cells.length < width) cells.push('');
        return cells;
      });
      const headers = uniqueHeaders(matrix[0]);
      const pageNumber = page.page_number ?? pageOf.length + 1;
      // The reader boxes the whole table. Each row gets its share of that box.
      const box = Array.isArray(item.bbox) && item.bbox.length > 0 ? item.bbox[0] : null;
      const bandFor = (rowIndex: number): CellLocation | null => {
        if (!box || ![box.x, box.y, box.w, box.h].every((value) => Number.isFinite(value))) return null;
        const band = box.h / matrix.length;
        return { page: pageNumber, x: box.x, y: Math.round((box.y + rowIndex * band) * 100) / 100, w: box.w, h: Math.round(band * 100) / 100, precision: 'row' };
      };
      const body = matrix.slice(1).map((row, index) => ({ row, band: bandFor(index + 1) })).filter((entry) => entry.row.some(Boolean));
      const previous = tables[tables.length - 1];
      const repeated = previous && sameHeaders(previous.headers, headers);
      const target: ParsedTable = repeated ? previous : { headers, rows: [], locations: [], pages: [] };
      if (page.page_width && page.page_height && !(target.pages || []).some((size) => size.page === pageNumber)) {
        (target.pages as PageSize[]).push({ page: pageNumber, width: page.page_width, height: page.page_height });
      }
      for (const { row, band } of body) {
        const record: Record<string, string> = {};
        target.headers.forEach((header, index) => { record[header] = row[index] ?? ''; });
        target.rows.push(record);
        (target.locations as (CellLocation | null)[][]).push(target.headers.map(() => (band ? { ...band } : null)));
      }
      if (!repeated && target.rows.length > 0) {
        tables.push(target);
        pageOf.push(page.page_number ?? pageOf.length + 1);
      }
    }
  }
  return { tables, pages: pageOf };
}

// ---------------------------------------------------------------------------
// Result to a reading: every page's words

interface ParseTextPage {
  page_number?: number;
  success?: boolean;
  markdown?: string;
  header?: string;
  footer?: string;
}

/** A header or footer with its numbers taken out, so "Page 3 of 90" and "Page 4 of 90" are the same line. */
function furnitureKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** The words of an item and of anything inside it, for a page the reader gave no markdown for. */
function itemText(item: any): string {
  if (!item || typeof item !== 'object') return '';
  const own = typeof item.md === 'string' && item.md.trim() ? item.md : typeof item.value === 'string' ? item.value : '';
  if (own.trim()) return own.trim();
  return (Array.isArray(item.items) ? item.items : []).map(itemText).filter(Boolean).join('\n\n');
}

/** A table cell's words, with its tags and line breaks taken out. */
function cellWords(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An HTML table as markdown rows, one line a row, so a row reads as words and not as tags. */
function htmlTableToMarkdown(html: string): string {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => cellWords(cell[1])))
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return cellWords(html);
  const width = Math.max(...rows.map((cells) => cells.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cells[index] || '').join(' | ')} |`;
  return ['', line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line), ''].join('\n');
}

/**
 * A page's markdown as the document reader reads best: a table as rows of words, a heading without
 * the bold marks the reader wraps it in, and no rule lines, which only separate the footnotes.
 */
export function tidyPageMarkdown(markdown: string): string {
  return markdown
    .replace(/<table[\s\S]*?<\/table>/gi, htmlTableToMarkdown)
    .replace(/^(#{1,6})\s+\*\*(.+?)\*\*\s*$/gm, '$1 $2')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Every page of a parse result as markdown: the paragraphs, the tables, and what sits at the foot of
 * the page. The reader returns a page's header and footer apart from its body. A line that runs along
 * most pages (the document's name, a page number) is page furniture and is left out. A footer that
 * differs from page to page is a footnote or a note to a table, and is kept with its page.
 */
export function readingFromParse(result: any): ReadingPage[] {
  const textPages: ParseTextPage[] = Array.isArray(result?.markdown?.pages) ? result.markdown.pages : [];
  const itemPages: { page_number?: number; items?: unknown[] }[] = Array.isArray(result?.items?.pages) ? result.items.pages : [];
  const numbers = [...new Set([...textPages, ...itemPages].map((page, index) => Math.trunc(Number(page?.page_number)) || index + 1))].sort((a, b) => a - b);
  const textOf = new Map(textPages.map((page, index) => [Math.trunc(Number(page?.page_number)) || index + 1, page]));
  const itemsOf = new Map(itemPages.map((page, index) => [Math.trunc(Number(page?.page_number)) || index + 1, page]));

  const seen = new Map<string, number>();
  for (const page of textPages) {
    for (const line of [page?.header, page?.footer]) {
      const key = typeof line === 'string' ? furnitureKey(line) : '';
      if (key) seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  const running = (line: string) => numbers.length >= 3 && (seen.get(furnitureKey(line)) || 0) >= Math.ceil(numbers.length * 0.6);

  const pages: ReadingPage[] = [];
  for (const number of numbers) {
    const page = textOf.get(number);
    let body = page && page.success !== false && typeof page.markdown === 'string' ? page.markdown.trim() : '';
    // A page the reader gave no markdown for is put together from its items, in reading order.
    if (!body) body = (itemsOf.get(number)?.items || []).filter((item: any) => item?.type !== 'header' && item?.type !== 'footer').map(itemText).filter(Boolean).join('\n\n');
    body = tidyPageMarkdown(body);
    const edge = (line: unknown) => {
      const text = typeof line === 'string' ? line.trim() : '';
      return text && !running(text) && !body.includes(text) ? text : '';
    };
    const text = [edge(page?.header), body, edge(page?.footer)].filter(Boolean).join('\n\n').trim();
    if (text) pages.push({ page: number, text });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// API client

export interface LlamaParseOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  timeoutMs?: number;
}

/** Upload a document, wait for the parse job, and return the whole result: each page's items and its markdown. */
async function parseWithLlama(fileName: string, mediaType: string, bytes: Uint8Array, options: LlamaParseOptions = {}): Promise<any> {
  const env = options.env || process.env;
  if (!llamaParseConfigured(env)) throw new LlamaParseUnavailable();
  const fetchImpl = options.fetchImpl || fetch;
  const pollMs = options.pollMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 90000;
  const headers = { Authorization: `Bearer ${env.LLAMA_CLOUD_API_KEY}` };

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mediaType || 'application/octet-stream' }), fileName);
  form.append('configuration', JSON.stringify({ tier: env.LLAMA_PARSE_TIER || 'cost_effective', version: 'latest' }));
  const upload = await fetchImpl(`${BASE_URL}/api/v2/parse/upload`, { method: 'POST', headers, body: form });
  if (!upload.ok) {
    const text = await upload.text().catch(() => '');
    throw new Error(`LlamaParse rejected the file (${upload.status}). ${text.slice(0, 160)}`);
  }
  const created = await upload.json();
  const jobId = created?.id;
  if (!jobId) throw new Error('LlamaParse did not return a job to follow');

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const poll = await fetchImpl(`${BASE_URL}/api/v2/parse/${encodeURIComponent(jobId)}?expand=items,markdown`, { headers });
    if (!poll.ok) throw new Error(`LlamaParse could not report on the job (${poll.status})`);
    const body = await poll.json();
    const status = body?.job?.status;
    if (status === 'COMPLETED') return body;
    if (status === 'FAILED' || status === 'CANCELLED') {
      throw new Error(body?.job?.error_message || `LlamaParse ${String(status).toLowerCase()} the job`);
    }
  }
  throw new Error('LlamaParse did not finish in time. Try the file again, or upload a CSV or Excel extract.');
}

/** Read a document for Load data: its tables, and the reading of every page, from one call. */
export async function extractTablesWithLlamaParse(
  fileName: string,
  mediaType: string,
  bytes: Buffer,
  options: LlamaParseOptions = {},
): Promise<{ tables: ParsedTable[]; pages: number[]; note: string; reading: DocumentReading | null }> {
  const body = await parseWithLlama(fileName, mediaType, bytes, options);
  const { tables, pages } = tablesFromParse(body);
  const read = readingFromParse(body);
  const note = tables.length
    ? `LlamaParse found ${tables.length} table${tables.length === 1 ? '' : 's'}.`
    : 'LlamaParse read the file but did not find a table.';
  return { tables, pages, note, reading: read.length > 0 ? { reader: 'llamaparse', pages: read } : null };
}

/** Read a document for its words alone: every page as markdown. Null when the reader found none. */
export async function readWithLlamaParse(fileName: string, mediaType: string | null, bytes: Uint8Array, options: LlamaParseOptions = {}): Promise<DocumentReading | null> {
  const read = readingFromParse(await parseWithLlama(fileName, mediaType || 'application/octet-stream', bytes, options));
  return read.length > 0 ? { reader: 'llamaparse', pages: read } : null;
}
