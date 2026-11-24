/**
 * Reads a file into blocks of text. HTML and plain text are read here with no
 * outside service. A PDF needs a text layer; a scan, a picture or a Word file
 * has none this server can read, and is read by an outside reader when one is
 * set up (see reading.ts).
 */

import { extractPdfPages } from '../import-intake/pdf-text';
import type { ReadingPage } from './reading';
import type { Block, DocumentFormat, ReadDocument } from './types';

export class UnreadableDocument extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableDocument';
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  sect: '\u00A7', para: '\u00B6', copy: '\u00A9', reg: '\u00AE', trade: '\u2122', hellip: '\u2026',
  bull: '\u2022', middot: '\u00B7', deg: '\u00B0', frac12: '\u00BD', frac14: '\u00BC', frac34: '\u00BE',
  times: '\u00D7', divide: '\u00F7', plusmn: '\u00B1', euro: '\u20AC', pound: '\u00A3', yen: '\u00A5', cent: '\u00A2',
  le: '\u2264', ge: '\u2265', ne: '\u2260', minus: '\u2212', shy: '',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const known = NAMED_ENTITIES[name.toLowerCase()];
    return known === undefined ? whole : known;
  });
}

/**
 * One line of clean text. Characters outside the basic plane become U+FFFD so
 * that every character is one UTF-16 unit, and offsets agree with Postgres.
 */
export function cleanText(value: string): string {
  return value
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/[\uD800-\uDFFF]/g, '\uFFFD')
    .replace(/[\u0000-\u001F\u007F\u00A0\u2000-\u200B\u202F\u2028\u2029\uFEFF]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** A line that is only a page number: "13", "-ii-", "Page 4 of 90". */
export function isPageFurniture(text: string): boolean {
  return /^(-\s*)?(\d{1,4}|[ivxlc]{1,7})(\s*-)?$/i.test(text) || /^page \d+( of \d+)?$/i.test(text);
}

function endsSentence(text: string): boolean {
  return /[.:;!?\u201D"')\]]$/.test(text);
}

interface Draft {
  parts: string[];
  leadParts: string[];
  leadOpen: boolean;
  boldChars: number;
  chars: number;
  headingLevel: number | null;
  table: number | null;
  page: number | null;
  sourceStart: number | null;
  sourceEnd: number | null;
}

/** Joins drafts into the body and gives each block its offsets. */
function assemble(format: DocumentFormat, drafts: Array<Omit<Block, 'start' | 'end'>>, pageCount: number | null, title: string | null): ReadDocument {
  const blocks: Block[] = [];
  let body = '';
  for (const draft of drafts) {
    if (!draft.text) continue;
    if (body) body += '\n';
    const start = body.length;
    body += draft.text;
    blocks.push({ ...draft, start, end: body.length });
  }
  return { format, body, blocks, pageCount, title };
}

const BREAKERS = new Set([
  'div', 'p', 'br', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol', 'hr', 'blockquote',
  'title', 'body', 'section', 'article', 'header', 'footer', 'pre', 'center', 'dd', 'dt', 'caption',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'area', 'base', 'wbr']);
const SKIPPED = new Set(['script', 'style', 'head', 'noscript', 'template']);
// The label lines at the head of an EDGAR filing. They are never closed; the text after each is not part of the document.
const FILING_LABELS = new Set(['type', 'sequence', 'filename', 'description']);

function styleBold(tag: string, attributes: string, inherited: boolean): boolean {
  if (tag === 'b' || tag === 'strong' || tag === 'th' || /^h[1-6]$/.test(tag)) return true;
  const weight = /font-weight\s*:\s*([a-z0-9]+)/i.exec(attributes);
  if (!weight) return inherited;
  const value = weight[1].toLowerCase();
  if (value === 'bold' || value === 'bolder') return true;
  const number = Number(value);
  return Number.isFinite(number) ? number >= 600 : false;
}

/**
 * HTML to blocks. A block ends at a block-level tag; inside a table only a row
 * ends it, and cells are joined with " | ". A horizontal rule is a page break,
 * as in filings saved from EDGAR: the page number before it is dropped and a
 * paragraph the break cut in two is joined again.
 */
export function readHtml(source: string): ReadDocument {
  const drafts: Array<Omit<Block, 'start' | 'end'>> = [];
  const stack: Array<{ tag: string; bold: boolean }> = [];
  let draft: Draft | null = null;
  let tableDepth = 0;
  let tableCount = 0;
  let tableId: number | null = null;
  let headingLevel: number | null = null;
  let page = 1;
  let sawPageBreak = false;
  let afterBreak = false;
  let skipUntil: string | null = null;
  let title: string | null = null;
  let inTitle = false;
  let dropText = false;

  const flush = () => {
    if (!draft) return;
    const text = cleanText(draft.parts.join('')).replace(/(\s*\|\s*)+$/g, '').replace(/^(\s*\|\s*)+/g, '').trim();
    const finished = draft;
    draft = null;
    if (!text) return;
    const block = {
      text,
      bold: finished.chars > 0 && finished.boldChars === finished.chars,
      lead: finished.table === null ? cleanText(finished.leadParts.join('')).length : 0,
      headingLevel: finished.headingLevel,
      table: finished.table,
      page: finished.page,
      sourceStart: finished.sourceStart,
      sourceEnd: finished.sourceEnd,
    };
    const previous = drafts[drafts.length - 1];
    // A page break in the middle of a sentence: carry on the paragraph it cut.
    if (afterBreak && previous && previous.table === null && block.table === null
      && !previous.bold && previous.headingLevel === null && previous.text.length >= 150
      && !endsSentence(previous.text) && /^[a-z0-9(]/.test(block.text)) {
      previous.text = `${previous.text} ${block.text}`;
      previous.sourceEnd = block.sourceEnd;
      afterBreak = false;
      return;
    }
    afterBreak = false;
    drafts.push(block);
  };

  const addText = (raw: string, at: number) => {
    const text = decodeEntities(raw);
    if (inTitle) {
      title = cleanText(`${title || ''} ${text}`) || null;
      return;
    }
    if (!draft) {
      if (!text.trim()) return;
      draft = { parts: [], leadParts: [], leadOpen: true, boldChars: 0, chars: 0, headingLevel, table: tableId, page: sawPageBreak ? page : null, sourceStart: at, sourceEnd: at };
    }
    draft.parts.push(text);
    const visible = text.replace(/\s/g, '').length;
    draft.chars += visible;
    const bold = stack.length > 0 && stack[stack.length - 1].bold;
    if (bold) draft.boldChars += visible;
    if (draft.leadOpen) {
      if (bold || visible === 0) draft.leadParts.push(text);
      else draft.leadOpen = false;
    }
    if (visible > 0) draft.sourceEnd = at + raw.length;
  };

  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|<![^>]*>|([^<]+)|</g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(source)) !== null) {
    const [whole, closing, rawTag, attributes, text] = match;
    if (text !== undefined) {
      if (!skipUntil && !dropText) addText(text, match.index);
      dropText = false;
      continue;
    }
    dropText = false;
    if (!rawTag) {
      if (whole === '<' && !skipUntil) addText('<', match.index);
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (skipUntil) {
      if (closing && tag === skipUntil) skipUntil = null;
      continue;
    }
    if (!closing && SKIPPED.has(tag)) {
      if (!/\/\s*$/.test(attributes)) skipUntil = tag;
      continue;
    }
    if (tag === 'title') {
      inTitle = !closing;
      continue;
    }
    if (!closing && FILING_LABELS.has(tag)) {
      dropText = true;
      continue;
    }

    if (tag === 'table') {
      flush();
      if (closing) {
        tableDepth = Math.max(0, tableDepth - 1);
        if (tableDepth === 0) tableId = null;
      } else {
        tableDepth += 1;
        if (tableDepth === 1) {
          tableCount += 1;
          tableId = tableCount;
        }
      }
    } else if (tableDepth > 0) {
      if (tag === 'tr') flush();
      else if ((tag === 'td' || tag === 'th') && closing && draft) (draft as Draft).parts.push(' | ');
      else if (BREAKERS.has(tag) && draft) (draft as Draft).parts.push(' ');
    } else if (BREAKERS.has(tag)) {
      flush();
      if (tag === 'hr') {
        // The first rule shows the file has pages; what came before it was page one.
        if (!sawPageBreak) {
          sawPageBreak = true;
          for (const earlier of drafts) earlier.page = 1;
        }
        const last = drafts[drafts.length - 1];
        if (last && isPageFurniture(last.text)) drafts.pop();
        page += 1;
        afterBreak = true;
      }
    }

    if (/^h[1-6]$/.test(tag)) headingLevel = closing ? null : Number(tag[1]);

    if (VOID_TAGS.has(tag) || /\/\s*$/.test(attributes)) continue;
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
    } else {
      stack.push({ tag, bold: styleBold(tag, attributes, stack.length > 0 ? stack[stack.length - 1].bold : false) });
    }
  }
  flush();

  const usefulTitle = title && !/^(document|untitled)$/i.test(title) ? title : null;
  return assemble('html', drafts, sawPageBreak ? page : null, usefulTitle);
}

const PARAGRAPH_OPENERS = /^(\(?[a-z0-9]{1,4}\)|\d+(\.\d+)*\.?\s|(SECTION|ARTICLE|Section|Article|EXHIBIT|SCHEDULE|ANNEX)\s|[\u201C"]|[\u2022\u00B7*-]\s)/;

/**
 * Lines to blocks for a format that only has lines. A blank line ends a
 * paragraph. So does a line that opens like a clause or a heading, or one that
 * follows a short line ending a sentence.
 */
function linesToDrafts(lines: string[], page: number | null, drafts: Array<Omit<Block, 'start' | 'end'>>, markdown: boolean) {
  const widest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  let current: string[] = [];
  const flush = () => {
    const text = cleanText(current.join(' '));
    current = [];
    if (!text || isPageFurniture(text)) return;
    const heading = markdown ? /^(#{1,6})\s+(.+)$/.exec(text) : null;
    drafts.push({
      text: heading ? heading[2].replace(/\s*#+$/, '') : text,
      bold: false,
      lead: 0,
      headingLevel: heading ? heading[1].length : null,
      table: null,
      page,
      sourceStart: null,
      sourceEnd: null,
    });
  };
  let previous = '';
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ').trim();
    if (!line) {
      flush();
      previous = '';
      continue;
    }
    const startsNew = PARAGRAPH_OPENERS.test(line) || (markdown && /^#{1,6}\s/.test(line))
      || (previous !== '' && endsSentence(previous) && previous.length < widest * 0.7);
    if (current.length > 0 && startsNew) flush();
    current.push(line);
    previous = line;
    if (markdown && /^#{1,6}\s/.test(line)) {
      flush();
      previous = '';
    }
  }
  flush();
}

export function readPlainText(source: string, markdown = false): ReadDocument {
  const drafts: Array<Omit<Block, 'start' | 'end'>> = [];
  linesToDrafts(source.replace(/\r\n?/g, '\n').split('\n'), null, drafts, markdown);
  return assemble('text', drafts, null, null);
}

export function readPdfPages(pages: string[]): ReadDocument {
  const drafts: Array<Omit<Block, 'start' | 'end'>> = [];
  pages.forEach((text, index) => {
    const before = drafts.length;
    linesToDrafts(text.split('\n'), index + 1, drafts, false);
    // A paragraph that runs over the page: join it to the one it continues.
    const previous = before > 0 ? drafts[before - 1] : null;
    const first = drafts[before];
    if (previous && first && !endsSentence(previous.text) && !PARAGRAPH_OPENERS.test(first.text)) {
      previous.text = `${previous.text} ${first.text}`;
      drafts.splice(before, 1);
    }
  });
  return assemble('pdf', drafts, pages.length, null);
}

/**
 * Pages an outside reader read, as markdown, into blocks that keep their page. A heading mark is a
 * heading, and a paragraph the page break cut in two is joined again, as for a PDF's own text.
 */
export function readMarkdownPages(pages: ReadingPage[], format: DocumentFormat = 'text'): ReadDocument {
  const drafts: Array<Omit<Block, 'start' | 'end'>> = [];
  let last = 0;
  for (const page of pages) {
    const before = drafts.length;
    linesToDrafts(page.text.replace(/\r\n?/g, '\n').split('\n'), page.page, drafts, true);
    const previous = before > 0 ? drafts[before - 1] : null;
    const first = drafts[before];
    // A heading, a table row or a list item starts where it stands; only running prose is joined across the break.
    if (previous && first && previous.headingLevel === null && first.headingLevel === null && !endsSentence(previous.text) && !PARAGRAPH_OPENERS.test(first.text) && !/^[|>]/.test(first.text) && !/\|$/.test(previous.text)) {
      previous.text = `${previous.text} ${first.text}`;
      drafts.splice(before, 1);
    }
    last = Math.max(last, page.page);
  }
  return assemble(format, drafts, last || null, null);
}

// Windows-1252 code points for bytes 0x80 to 0x9F. Zero where the byte has no character.
const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

/**
 * Bytes as Windows-1252. Some runtimes decode that label as Latin-1, which
 * turns curly quotes and dashes into control characters, so the range that
 * differs is mapped here.
 */
function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (let from = 0; from < bytes.length; from += 8192) {
    const slice = bytes.subarray(from, from + 8192);
    const codes = new Array<number>(slice.length);
    for (let i = 0; i < slice.length; i += 1) {
      const byte = slice[i];
      codes[i] = byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] || 0x20 : byte;
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

const SINGLE_BYTE = new Set(['windows-1252', 'cp1252', 'latin1', 'iso-8859-1', 'iso8859-1', 'us-ascii', 'ascii']);

/** Decodes with the charset the file declares; a file that is not valid UTF-8 is read as Windows-1252. */
export function decodeBytes(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const declared = /charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(head)?.[1]?.toLowerCase();
  if (declared && SINGLE_BYTE.has(declared)) return decodeWindows1252(bytes);
  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // An unknown label: fall through to the checks below.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeWindows1252(bytes);
  }
}

export function formatOfFile(fileName: string, mediaType: string | null | undefined, bytes: Uint8Array): DocumentFormat | null {
  const lower = fileName.toLowerCase();
  const media = (mediaType || '').toLowerCase();
  if (lower.endsWith('.pdf') || media === 'application/pdf' || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) return 'pdf';
  if (/\.(html?|xhtml)$/.test(lower) || media.includes('html')) return 'html';
  if (/\.(txt|md|markdown|text)$/.test(lower) || media.startsWith('text/')) return 'text';
  return null;
}

/** Reads a file by its kind. Throws UnreadableDocument with a reason a person can act on. */
export async function readDocument(fileName: string, mediaType: string | null | undefined, bytes: Uint8Array): Promise<ReadDocument> {
  const format = formatOfFile(fileName, mediaType, bytes);
  if (!format) {
    throw new UnreadableDocument('This kind of file has no text this server can read itself. It needs an outside reader: set LLAMA_CLOUD_API_KEY on the worker, or use a PDF with selectable text, an HTML file or a text file.');
  }
  let document: ReadDocument;
  if (format === 'pdf') {
    // unpdf takes over the buffer it is given, so hand it a copy.
    const pages = await extractPdfPages(new Uint8Array(bytes));
    document = readPdfPages(pages);
    if (document.body.replace(/\s/g, '').length < Math.max(200, pages.length * 40)) {
      throw new UnreadableDocument('The PDF has no selectable text, so it looks like a scan. It needs an outside reader: set LLAMA_CLOUD_API_KEY on the worker.');
    }
  } else if (format === 'html') {
    document = readHtml(decodeBytes(bytes));
  } else {
    document = readPlainText(decodeBytes(bytes), /\.(md|markdown)$/i.test(fileName));
  }
  if (!document.body.trim()) throw new UnreadableDocument('The file has no text.');
  return document;
}
