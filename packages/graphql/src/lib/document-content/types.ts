/**
 * Document content: a file read into its text, its headings and its clauses.
 *
 * Offsets (start, end, charStart, charEnd) count characters of `body`. The
 * readers replace characters outside the basic plane, so a JavaScript string
 * index and a Postgres character position are the same number.
 */

export type DocumentFormat = 'html' | 'pdf' | 'text';

/** One paragraph, heading, list item or table row, in reading order. */
export interface Block {
  text: string;
  start: number;
  end: number;
  /** Every word of the block is bold. Always false where the format cannot say. */
  bold: boolean;
  /** How many characters at the start of the block are bold: the run-in heading of "7.2 Indebtedness. Create, ...". */
  lead: number;
  /** 1 to 6 when the file marks the block as a heading (an h tag, a markdown #). */
  headingLevel: number | null;
  /** Rows of the same table share a number. Null outside a table. */
  table: number | null;
  page: number | null;
  /** Where the block sits in the original file, for formats that are text (HTML). */
  sourceStart: number | null;
  sourceEnd: number | null;
}

export interface ReadDocument {
  format: DocumentFormat;
  body: string;
  blocks: Block[];
  pageCount: number | null;
  title: string | null;
}

/** A heading of the document and the stretch of text under it. */
export interface Section {
  seq: number;
  parentSeq: number | null;
  /** 1 for an article or top section, 2 for a numbered section inside it. */
  level: number;
  number: string;
  heading: string;
  charStart: number;
  charEnd: number;
}

export type ChunkKind = 'CLAUSE' | 'DEFINITION' | 'TABLE' | 'FRONT';

export interface ChunkLocator {
  page: number | null;
  pageEnd: number | null;
  sectionNumber: string | null;
  /** The clause label the chunk opens with, such as "(a)". */
  clause: string | null;
  /** The headings above the chunk, outermost first. */
  path: string[];
  sourceStart: number | null;
  sourceEnd: number | null;
}

export interface Chunk {
  seq: number;
  sectionSeq: number | null;
  kind: ChunkKind;
  charStart: number;
  charEnd: number;
  locator: ChunkLocator;
  /** Tags that belong to the chunk itself: kind:, term:. */
  tags: string[];
  /** Mostly names and numbers. Its own words embed poorly, so it is described before it is embedded. */
  thin: boolean;
}

export interface Outline {
  sections: Section[];
  /** Indexes of blocks that are headings, a table of contents, or page furniture. Not chunked. */
  skip: Set<number>;
  /** Block index to the seq of the deepest section it falls under. */
  sectionOfBlock: Array<number | null>;
}

/** One expected section of a kind of document. Stored in docs.templates.sections. */
export interface TemplateSection {
  code: string;
  title: string;
  parentCode: string | null;
  /** Other headings that mean this section. */
  aliases: string[];
  /** Tags every chunk under this section carries. */
  tags: string[];
  /** What belongs here, for a person tagging by hand. */
  guidance: string;
  required: boolean;
  order: number;
  /** How many of the source documents had it. */
  seenIn: number;
}

/** A subject a kind of document covers, such as lenders or pricing. Stored in docs.templates.topics. */
export interface TemplateTopic {
  code: string;
  title: string;
  /** What belongs under the topic. A search question is compared with it. */
  description: string;
}

export type MatchMethod = 'EXACT' | 'ALIAS' | 'SIMILAR' | 'EMBEDDING';

export interface SectionMatch {
  seq: number;
  code: string;
  method: MatchMethod;
  score: number;
}
