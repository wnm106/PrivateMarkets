/**
 * Finds a document's headings and cuts it into clauses.
 *
 * Headings come from how agreements number themselves ("SECTION 7", "7.1",
 * "EXHIBIT A") and from heading marks in the file. A table of contents lists
 * the same headings with nothing between them, which is how it is told apart
 * from the body and left out.
 */

import { isPageFurniture } from './read';
import { isThin } from './refine';
import type { Block, Chunk, ChunkKind, Outline, ReadDocument, Section } from './types';

interface Candidate {
  index: number;
  level: number;
  number: string;
  heading: string;
  /** How a numbered heading opens: "SECTION", "Section", or nothing. A document uses one form for its headings. */
  prefix: string;
}

const ANNEX_HEADING = /^(EXHIBIT|SCHEDULE|ANNEX|APPENDIX|Exhibit|Schedule|Annex|Appendix)\s+([A-Z0-9][A-Z0-9.()-]*)\b\s*[.:\u2013\u2014-]?\s*(.*)$/;
const TOP_KEYWORD = /^(SECTION|ARTICLE|PART|Section|Article|Part)\s*([IVXLCl1r]{1,7}|\d{1,2})(?![A-Za-z0-9])\s*([.:,\u2013\u2014-]?)(\s*)(.*)$/;
const PLAIN_NUMBERED = /^(\d{1,2})\.(\d{1,3})\.?\s+(\S.*)$/;
// After SECTION, a scan may read 1 as I or l, 0 as O, a full stop as a comma, and put a space inside the number.
const DIGIT = '(?:\\d|[IlO](?=[\\s\\d.,]|$))';
const SCANNED_NUMBERED = new RegExp(`^SECTION\\s*(\\d{1,2}|[Il])\\s*[.,]\\s*(${DIGIT}(?:\\s?${DIGIT}){0,2})\\.?(?:\\s+|$)(.*)$`);
const TRAILING_PAGE = /(\s*\|\s*|\s*\.{3,}\s*|\s{2,})(\d{1,4}|[ivxlc]{1,7})$/i;

function stripTrailingPage(text: string): string {
  return text.replace(TRAILING_PAGE, '').replace(/[\s|]+$/g, '').trim();
}

/** The heading of a run-in section: the words up to the first full stop. */
function leadingTitle(text: string): string {
  const stop = /^(.{2,140}?)\.(\s|$)/.exec(text);
  return (stop ? stop[1] : text).trim();
}

function looksLikeTitle(text: string): boolean {
  if (text.length < 2 || text.length > 140) return false;
  return /^[\[A-Z\u201C"(]/.test(text);
}

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };

/** "XVIII" or "18" as a number. A scan's l, 1 and r inside a roman numeral are read as I. Null when it is neither. */
function numeralValue(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const roman = raw.replace(/[l1r]/g, 'I');
  if (!/^[IVXLC]+$/.test(roman)) return null;
  let total = 0;
  for (let i = 0; i < roman.length; i += 1) {
    const value = ROMAN[roman[i]];
    total += value < (ROMAN[roman[i + 1]] || 0) ? -value : value;
  }
  return total > 0 && total < 200 ? total : null;
}

function digitsOf(raw: string): string {
  return raw.replace(/\s/g, '').replace(/[Il]/g, '1').replace(/O/g, '0');
}

/** "ARTICLE VII. ADDITIONAL LIMITED PARTNERS", "SECTION 7", "ARTICLEll. ORGANIZATION" from a scan. */
function topCandidate(block: Block, index: number, text: string, anyBold: boolean): Candidate | null {
  const match = TOP_KEYWORD.exec(text);
  if (!match) return null;
  const [, keyword, numeral, mark, gap, rest] = match;
  // "SECTION 2.1 Formation": the mark runs straight into more of the number, so this is a numbered heading.
  if (mark && !gap && rest) return null;
  if (/^\d/.test(rest)) return null;
  const shouting = keyword === keyword.toUpperCase();
  // Only a heading in capitals is trusted to have been misread by a scan.
  if (!shouting && !/^([IVXLC]+|\d+)$/.test(numeral)) return null;
  const value = numeralValue(numeral);
  if (value === null) return null;

  let title = rest.trim();
  if (shouting) {
    // "ARTICLE I. DEFINITIONS Capitalized terms used herein...": the capitals are the title.
    const capitals = /^([A-Z][A-Z0-9 ;,&'()\/-]*[A-Z)])(?=\s+[A-Z\u201C"(]?[a-z])/.exec(title);
    if (capitals) title = capitals[1];
    else if (text.length > 160) return null;
  } else if (!block.bold && (text.length > 80 || /[.;,)]$/.test(text))) {
    // "Article X of Profit or Loss ...", "Article XIX.": the end or middle of a sentence.
    return null;
  } else if (text.length > 160) {
    return null;
  }
  if (!(block.bold || !anyBold || shouting)) return null;
  const shown = /^\d+$/.test(numeral) ? numeral : numeral.replace(/[l1r]/g, 'I');
  return { index, level: 1, number: `${keyword.toUpperCase()} ${value}`, heading: [keyword, shown, title.replace(/\.$/, '')].filter(Boolean).join(' '), prefix: '' };
}

/** "7.1 Financial Condition Covenants", "SECTION 3.6 Salaries; Special Income.", "SECTION 3. I 7 Media ..." from a scan. */
function numberedCandidate(block: Block, index: number, text: string, anyBold: boolean): Candidate | null {
  let number: string;
  let rest: string;
  let prefix = '';
  const scanned = SCANNED_NUMBERED.exec(text);
  if (scanned) {
    number = `${digitsOf(scanned[1])}.${digitsOf(scanned[2])}`;
    rest = scanned[3];
    prefix = 'SECTION';
  } else {
    const mixed = /^Section\s+/.exec(text);
    const plain = PLAIN_NUMBERED.exec(mixed ? text.slice(mixed[0].length) : text);
    if (!plain) return null;
    number = `${plain[1]}.${plain[2]}`;
    rest = plain[3];
    prefix = mixed ? 'Section' : '';
  }
  if (!rest) return null;

  let title: string;
  if (block.bold) {
    title = rest.replace(/\.$/, '').trim();
  } else if (block.lead > text.length - rest.length + 1) {
    // The heading runs into its first sentence: only the bold opening is the heading.
    title = text.slice(text.length - rest.length, block.lead).replace(/\.$/, '').trim();
  } else if (!anyBold || block.table !== null) {
    title = leadingTitle(rest);
  } else {
    // The file marks bold and this line has none: a sentence that happens to open with a number.
    return null;
  }
  if (!looksLikeTitle(title)) return null;
  return { index, level: 2, number, heading: `${number} ${title}`, prefix };
}

function candidateOf(block: Block, index: number, anyBold: boolean): Candidate | null {
  const text = stripTrailingPage(block.text);
  if (!text) return null;

  if (block.headingLevel !== null && block.headingLevel <= 3) {
    const numbered = PLAIN_NUMBERED.exec(text);
    return { index, level: Math.min(block.headingLevel, 2), number: numbered ? `${numbered[1]}.${numbered[2]}` : '', heading: text, prefix: '' };
  }
  // "SECTION 3. I 7 Media ...": a numbered heading a scan put a space in, not a top heading called "SECTION 3".
  if (SCANNED_NUMBERED.test(text)) return numberedCandidate(block, index, text, anyBold);
  const top = topCandidate(block, index, text, anyBold);
  if (top) return top;
  const annex = ANNEX_HEADING.exec(text);
  if (annex && text.length <= 160 && (block.bold || text === text.toUpperCase())) {
    return { index, level: 1, number: `${annex[1].toUpperCase()} ${annex[2]}`, heading: text, prefix: '' };
  }
  if (/^in witness whereof\b/i.test(text)) return { index, level: 1, number: '', heading: 'Signatures', prefix: '' };
  return numberedCandidate(block, index, text, anyBold);
}

/** A candidate whose block is only the heading, as a contents entry is. */
function isBare(candidate: Candidate, block: Block): boolean {
  const core = stripTrailingPage(block.text).replace(/^(SECTION|Section)\s*/, '').replace(/\.$/, '');
  return core.length <= candidate.heading.length + 3;
}

/**
 * Runs of bare headings with nothing between them: a table of contents. In the
 * body a heading is followed by its text, or is one of a few reserved sections.
 * One short line between two entries is allowed for: a scan garbles the odd one.
 */
function contentsRuns(candidates: Candidate[], blocks: Block[], skip: Set<number>): Array<[number, number]> {
  const bare = candidates.filter((candidate) => isBare(candidate, blocks[candidate.index]));
  const adjacent = (left: number, right: number) => {
    let strays = 0;
    for (let index = left + 1; index < right; index += 1) {
      if (skip.has(index)) continue;
      strays += 1;
      // Only a line that opens like a heading: a paragraph between two headings means this is the body.
      if (strays > 1 || blocks[index].text.length > 160 || !/^(SECTION|ARTICLE|Section|Article|\d)/.test(blocks[index].text)) return false;
    }
    return true;
  };
  const runs: Array<[number, number]> = [];
  let from = 0;
  for (let i = 1; i <= bare.length; i += 1) {
    if (i < bare.length && adjacent(bare[i - 1].index, bare[i].index)) continue;
    if (i - from >= 8) runs.push([bare[from].index, bare[i - 1].index]);
    from = i;
  }
  return runs;
}

/** A document writes its numbered headings one way. Lines that open another way are references to them. */
function keepHouseStyle(candidates: Candidate[]): Candidate[] {
  const counts = new Map<string, number>();
  const numbered = candidates.filter((candidate) => candidate.level === 2 && candidate.number);
  for (const candidate of numbered) counts.set(candidate.prefix, (counts.get(candidate.prefix) || 0) + 1);
  const [style, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  if (count < 5 || count < numbered.length * 0.6) return candidates;
  return candidates.filter((candidate) => candidate.level !== 2 || !candidate.number || candidate.prefix === style);
}

export function buildOutline(document: ReadDocument): Outline {
  const { blocks, body } = document;
  const anyBold = blocks.some((block) => block.bold);
  const skip = new Set<number>();
  blocks.forEach((block, index) => {
    if (isPageFurniture(block.text) || /^table of contents(\s*\(continued\))?(\s*\|?\s*page)?$/i.test(block.text) || /^page$/i.test(block.text)) skip.add(index);
  });

  // A short line that closes three or more pages is a footer.
  const closesPage = (index: number) => blocks[index].page !== null && index + 1 < blocks.length && blocks[index + 1].page !== blocks[index].page;
  const footers = new Map<string, number>();
  blocks.forEach((block, index) => {
    if (block.text.length <= 60 && block.table === null && closesPage(index)) footers.set(block.text, (footers.get(block.text) || 0) + 1);
  });
  blocks.forEach((block, index) => {
    if ((footers.get(block.text) || 0) >= 3 && closesPage(index)) skip.add(index);
  });

  let candidates = blocks
    .map((block, index) => (skip.has(index) ? null : candidateOf(block, index, anyBold)))
    .filter((candidate): candidate is Candidate => candidate !== null);
  candidates = keepHouseStyle(candidates);

  for (const [first, last] of contentsRuns(candidates, blocks, skip)) {
    for (let index = first; index <= last; index += 1) skip.add(index);
  }
  // A heading inside a table that survived is still a contents row when it ends in a page number.
  candidates = candidates.filter((candidate) => {
    if (skip.has(candidate.index)) return false;
    const block = blocks[candidate.index];
    if (block.table !== null && TRAILING_PAGE.test(block.text)) {
      skip.add(candidate.index);
      return false;
    }
    return true;
  });

  // The same number twice: the earlier, bare one is a contents entry that was not in a run.
  const lastOf = new Map<string, number>();
  candidates.forEach((candidate) => {
    if (candidate.number) lastOf.set(candidate.number, candidate.index);
  });
  candidates = candidates.filter((candidate) => {
    if (!candidate.number || lastOf.get(candidate.number) === candidate.index) return true;
    if (!isBare(candidate, blocks[candidate.index])) return true;
    skip.add(candidate.index);
    return false;
  });

  // "Exhibit 10.1" on a cover page is a filing label, not an exhibit of this document.
  const firstTop = candidates.find((candidate) => candidate.level === 1 && /^(SECTION|ARTICLE|PART) /.test(candidate.number));
  if (firstTop) {
    candidates = candidates.filter((candidate) => candidate.index >= firstTop.index || !ANNEX_HEADING.test(candidate.heading));
  }

  // A numbered heading belongs under the top heading with its number. One that
  // names another section ("2.5" under SECTION 7) is a cross-reference in a table or list.
  const sections: Section[] = [];
  let parent: Section | null = null;
  let parentMajor: string | null = null;
  for (const candidate of candidates) {
    const block = blocks[candidate.index];
    if (candidate.level === 1) {
      // "SECTION 1" on one line and "DEFINITIONS" on the next: the next line is the title.
      const bare = /^\S+\s+\S+$/.test(candidate.heading) && candidate.number !== '';
      const after = blocks[candidate.index + 1];
      if (bare && after && !skip.has(candidate.index + 1) && after.table === null && after.text.length <= 120
        && (after.bold || after.text === after.text.toUpperCase()) && !candidates.some((other) => other.index === candidate.index + 1)) {
        candidate.heading = `${candidate.heading} ${after.text}`;
        skip.add(candidate.index + 1);
      }
      parent = { seq: sections.length + 1, parentSeq: null, level: 1, number: candidate.number, heading: candidate.heading, charStart: block.start, charEnd: body.length };
      parentMajor = /(\d+)$/.exec(candidate.number)?.[1] ?? null;
      sections.push(parent);
    } else {
      const major = candidate.number.split('.')[0];
      if (parent && parentMajor !== null && candidate.number && major !== parentMajor) continue;
      sections.push({
        seq: sections.length + 1,
        parentSeq: parent ? parent.seq : null,
        level: parent ? 2 : 1,
        number: candidate.number,
        heading: candidate.heading,
        charStart: block.start,
        charEnd: body.length,
      });
    }
    // The heading stands alone when the block is no more than the heading.
    if (candidate.number !== '' || candidate.level !== 1 || block.headingLevel !== null) {
      if (isBare(candidate, block)) skip.add(candidate.index);
    }
  }

  // A section ends where the next one at its level or above begins.
  for (let i = 0; i < sections.length; i += 1) {
    const next = sections.slice(i + 1).find((later) => later.level <= sections[i].level);
    if (next) sections[i].charEnd = next.charStart;
  }

  const sectionOfBlock: Array<number | null> = [];
  let cursor = 0;
  let current: number | null = null;
  for (const block of blocks) {
    while (cursor < sections.length && sections[cursor].charStart <= block.start) {
      current = sections[cursor].seq;
      cursor += 1;
    }
    sectionOfBlock.push(current);
  }
  return { sections, skip, sectionOfBlock };
}

const CLAUSE_LABEL = /^(\((?:[a-z]{1,3}|[ivxlc]{1,6}|\d{1,2})\))\s/i;
const DEFINITION = /^[\u201C"]([^\u201D"]{2,90})[\u201D"]\s*(:|\u2013|\u2014|-|means|shall mean|has the meaning|is defined|or\s+[\u201C"])/;

export interface ChunkOptions {
  /** A chunk is closed before it would pass this many characters. */
  maxChars?: number;
  /** A new clause does not start a new chunk until the current one has this many. */
  minChars?: number;
}

/** Cuts one long block at sentence ends so no piece is longer than max. Returns offsets within the block. */
function splitLong(text: string, max: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  let from = 0;
  while (text.length - from > max) {
    const window = text.slice(from, from + max);
    let cut = Math.max(window.lastIndexOf('; '), window.lastIndexOf('. '), window.lastIndexOf(': '));
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut < 1) cut = max - 1;
    pieces.push([from, from + cut + 1]);
    from += cut + 1;
    while (text[from] === ' ') from += 1;
  }
  if (from < text.length) pieces.push([from, text.length]);
  return pieces;
}

/**
 * Cuts the body into chunks. A chunk never crosses a heading. Within a section
 * a new clause label starts a new chunk once the current one is long enough,
 * each defined term is its own chunk, and the rows of a table stay together.
 */
export function buildChunks(document: ReadDocument, outline: Outline, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? 2400;
  const minChars = options.minChars ?? 500;
  const { blocks } = document;
  const bySeq = new Map(outline.sections.map((section) => [section.seq, section]));
  const chunks: Chunk[] = [];

  interface Open {
    kind: ChunkKind;
    sectionSeq: number | null;
    table: number | null;
    start: number;
    end: number;
    first: Block;
    last: Block;
    term: string | null;
  }
  let open: Open | null = null;

  const pathOf = (sectionSeq: number | null): { path: string[]; number: string | null } => {
    const section = sectionSeq === null ? undefined : bySeq.get(sectionSeq);
    if (!section) return { path: [], number: null };
    const parent = section.parentSeq === null ? undefined : bySeq.get(section.parentSeq);
    return { path: parent ? [parent.heading, section.heading] : [section.heading], number: section.number || null };
  };

  const close = () => {
    if (!open) return;
    const { path, number } = pathOf(open.sectionSeq);
    const tags = [`kind:${open.kind.toLowerCase()}`];
    if (open.term) tags.push(`term:${open.term.toLowerCase().replace(/\s+/g, ' ').slice(0, 70)}`);
    chunks.push({
      seq: chunks.length + 1,
      sectionSeq: open.sectionSeq,
      kind: open.kind,
      charStart: open.start,
      charEnd: open.end,
      locator: {
        page: open.first.page,
        pageEnd: open.last.page,
        sectionNumber: number,
        clause: CLAUSE_LABEL.exec(document.body.slice(open.start, open.start + 12))?.[1] ?? null,
        path,
        sourceStart: open.first.sourceStart,
        sourceEnd: open.last.sourceEnd,
      },
      tags,
      thin: isThin(document.body.slice(open.start, open.end), open.kind),
    });
    open = null;
  };

  blocks.forEach((block, index) => {
    // A chunk is one unbroken stretch of the body, so it ends at anything left out.
    if (outline.skip.has(index)) {
      close();
      return;
    }
    const sectionSeq = outline.sectionOfBlock[index];
    const definition = block.table === null ? DEFINITION.exec(block.text) : null;
    const baseKind: ChunkKind = block.table !== null ? 'TABLE' : sectionSeq === null ? 'FRONT' : 'CLAUSE';

    const pieces: Array<[number, number]> = block.text.length > maxChars * 1.5
      ? splitLong(block.text, maxChars).map(([from, to]) => [block.start + from, block.start + to])
      : [[block.start, block.end]];

    pieces.forEach(([start, end], pieceIndex) => {
      const length = end - start;
      const startsDefinition = Boolean(definition) && pieceIndex === 0;
      // What follows a definition, until the next heading, clause run or definition, is still that definition.
      const continuesDefinition = !startsDefinition && open !== null && open.kind === 'DEFINITION' && baseKind === 'CLAUSE' && open.sectionSeq === sectionSeq;
      const kind: ChunkKind = startsDefinition || continuesDefinition ? 'DEFINITION' : baseKind;
      const term: string | null = startsDefinition ? definition![1] : continuesDefinition ? open!.term : null;

      const mustClose = open !== null && (
        open.sectionSeq !== sectionSeq
        || open.kind !== kind
        || open.table !== block.table
        || startsDefinition
        || open.end - open.start + length + 1 > maxChars
        || (kind === 'CLAUSE' && pieceIndex === 0 && CLAUSE_LABEL.test(block.text) && open.end - open.start >= minChars)
      );
      // A short line that is not a sentence, straight before a table, is its caption.
      const caption = kind === 'TABLE' && open !== null && (open.kind === 'CLAUSE' || open.kind === 'FRONT')
        && open.sectionSeq === sectionSeq && open.first === open.last && open.end - open.start <= 80
        && !/[.;:,]$/.test(open.last.text);
      if (caption) {
        open!.kind = 'TABLE';
        open!.table = block.table;
      } else if (mustClose) close();
      if (open === null) {
        open = { kind, sectionSeq, table: block.table, start, end, first: block, last: block, term };
      } else {
        open.end = end;
        open.last = block;
      }
    });
  });
  close();
  return chunks;
}

/** A title for a document that has none: the capital lines at its head, before the first heading. */
export function guessTitle(document: ReadDocument, outline: Outline): string | null {
  if (document.title) return document.title;
  const limit = outline.sections.length > 0 ? outline.sections[0].charStart : Number.MAX_SAFE_INTEGER;
  const lines: string[] = [];
  // A scanned cover page comes out as one line: "LIMITED PARTNERSHIP AGREEMENT OF X, L.P. (A Delaware Limited Partnership)".
  const cover = document.blocks[0];
  if (cover && !outline.skip.has(0) && cover.table === null && cover.text.length > 90 && cover.text.length <= 220) {
    const lead = cover.text.split(' (')[0].trim();
    const letters = lead.replace(/[^A-Za-z]/g, '');
    if (lead.length >= 12 && lead.length <= 140 && letters.length > 0 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8) return titleCase(lead);
  }
  document.blocks.slice(0, 40).some((block, index) => {
    if (block.start >= limit || lines.length >= 2) return true;
    if (outline.skip.has(index)) return false;
    const text = block.text;
    if (block.table !== null || text.length < 6 || text.length > 90) return false;
    if (/^(exhibit|execution version|confidential|table of contents)\b/i.test(text)) return false;
    if (text === text.toUpperCase() && /[A-Z]{3}/.test(text)) lines.push(text);
    else if (lines.length > 0) return true;
    return false;
  });
  if (lines.length === 0) return null;
  return titleCase(lines.join(' '));
}

const SMALL_WORDS = new Set(['OF', 'THE', 'AND', 'TO', 'IN', 'ON', 'OR', 'FOR', 'BY', 'WITH', 'A', 'AN', 'AS', 'AT']);

/** Capitals to title case. Initials and numerals (L.P., II, SCP) stay as they are; small words go lower. */
function titleCase(value: string): string {
  return value.split(' ').map((word, index) => {
    const bare = word.replace(/[^A-Za-z.]/g, '');
    if (index > 0 && SMALL_WORDS.has(bare)) return word.toLowerCase();
    if (bare.includes('.') || /^[IVX]+$/.test(bare) || (bare.length <= 3 && !SMALL_WORDS.has(bare) && !/[AEIOU]/.test(bare))) return word;
    return word.charAt(0) + word.slice(1).toLowerCase();
  }).join(' ');
}
