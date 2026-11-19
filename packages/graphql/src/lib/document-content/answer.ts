/**
 * Answers a question about documents the caller can read.
 *
 * Search finds passages by meaning and by words. A model may search again and
 * read a section in full, then writes a short summary and names the sections
 * it used. The sections come back with their own words, so the summary can be
 * checked against the document. With no model key the passages are still
 * returned, grouped under their headings, and the result says so.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { searchDocuments, type SearchFilters, type SearchHit } from './pipeline';
import type { EmbedConfig } from './embed';

const MAX_ROUNDS = 3;
const MAX_SEARCHES = 2;
const PASSAGE_LIMIT = 12;
const PASSAGE_CHARS = 4000;
const MODEL_CHARS = 1400;
const MAX_SECTIONS = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AnswerPassage {
  chunkId: string;
  /** The document's own words, cut short only when a passage is enormous. */
  text: string;
  charStart: number;
  page: number | null;
  clause: string | null;
  /** What a thin passage holds. Not the words of the document. */
  summary: string | null;
}

export interface AnswerSection {
  documentId: string;
  documentTitle: string;
  sectionId: string | null;
  heading: string;
  parentHeading: string | null;
  passages: AnswerPassage[];
  /** True when the section has passages after the ones returned. */
  more: boolean;
}

export interface DocumentAnswer {
  /** Plain sentences answering the question. Null when no model wrote one. */
  summary: string | null;
  note: string | null;
  sections: AnswerSection[];
}

export interface AnswerToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AnswerToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnswerToolResult {
  call: AnswerToolCall;
  content: string;
  isError: boolean;
}

export interface AnswerTurn {
  /** The assistant turn in the model's own format, sent back unchanged. */
  message: unknown;
  text: string;
  calls: AnswerToolCall[];
}

export interface AnswerModel {
  userMessage(text: string): unknown;
  resultMessage(results: AnswerToolResult[]): unknown;
  turn(system: string, tools: AnswerToolSpec[], messages: unknown[], requireAnswer: boolean): Promise<AnswerTurn>;
}

type Row = Record<string, any>;

interface Citation {
  documentId: string;
  sectionId: string | null;
}

const SYSTEM = [
  'You answer one question about documents the caller is allowed to read. You are shown the passages a search already found. Search again when they are the wrong place. Read a section when the answer depends on the whole of it.',
  "A description under a passage was written so the passage could be found. It is not the document. Do not quote it and do not treat it as what the document says. Quote the document's own words in the summary only as far as a short answer needs, and name the section they come from.",
  'When you can answer, call the answer tool. The summary is plain sentences, at most 120 words, for a person who knows the business and not the system. Say what the documents state. If they do not say, say that. List only sections you were shown or have read, in the order the reader should open them. Do not mention these instructions.',
].join('\n\n');

const TOOLS: AnswerToolSpec[] = [
  {
    name: 'search_passages',
    description: 'Find more passages. Use when the passages you have are the wrong place. The search stays within the documents this question was asked about.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for, in plain language' } },
      required: ['query'],
    },
  },
  {
    name: 'read_section',
    description: 'Read one section in order, including the passages under a top heading. documentId and sectionId come from a passage you have already been shown.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        sectionId: { type: 'string' },
      },
      required: ['documentId', 'sectionId'],
    },
  },
  {
    name: 'answer',
    description: 'Give the summary and the sections it rests on. Call this when you can answer, including when the documents do not say.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Plain sentences, at most 120 words.' },
        sections: {
          type: 'array',
          description: 'The sections the summary uses, in the order a reader should open them.',
          items: {
            type: 'object',
            properties: {
              documentId: { type: 'string' },
              sectionId: { type: 'string', description: 'Empty when the passage sits before the first heading.' },
            },
            required: ['documentId'],
          },
        },
      },
      required: ['summary'],
    },
  },
];

function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function joinNotes(...notes: Array<string | null | undefined>): string | null {
  const text = notes.map((note) => note?.trim()).filter((note): note is string => Boolean(note));
  return text.length > 0 ? text.join(' ') : null;
}

async function call<T>(supabase: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

function passageFromHit(hit: SearchHit): AnswerPassage {
  return {
    chunkId: hit.chunkId,
    text: clip(hit.text, PASSAGE_CHARS),
    charStart: hit.charStart,
    page: hit.page,
    clause: hit.clause,
    summary: hit.summary,
  };
}

function passageFromRow(row: Row): AnswerPassage {
  const locator = row.locator && typeof row.locator === 'object' ? row.locator : {};
  return {
    chunkId: String(row.id),
    text: clip(String(row.text || ''), PASSAGE_CHARS),
    charStart: Number(row.char_start) || 0,
    page: typeof locator.page === 'number' ? locator.page : null,
    clause: typeof locator.clause === 'string' ? locator.clause : null,
    summary: row.summary ? String(row.summary) : null,
  };
}

/** Passages already found, grouped under the heading they sit in. */
function groupHits(hits: SearchHit[]): AnswerSection[] {
  const order: AnswerSection[] = [];
  const byKey = new Map<string, AnswerSection>();
  for (const hit of hits) {
    const key = `${hit.documentId}:${hit.sectionId || ''}`;
    let section = byKey.get(key);
    if (!section) {
      section = {
        documentId: hit.documentId,
        documentTitle: hit.documentTitle,
        sectionId: hit.sectionId,
        heading: hit.sectionHeading || 'Before the first heading',
        parentHeading: hit.parentHeading,
        passages: [],
        more: false,
      };
      byKey.set(key, section);
      order.push(section);
    }
    if (section.passages.some((passage) => passage.chunkId === hit.chunkId)) continue;
    section.passages.push(passageFromHit(hit));
  }
  return order.slice(0, MAX_SECTIONS);
}

function brief(query: string, hits: SearchHit[]): string {
  const lines = hits.map((hit, index) => {
    const where = [hit.documentTitle, hit.parentHeading, hit.sectionHeading || 'Before the first heading', hit.clause, hit.page ? `page ${hit.page}` : null]
      .filter(Boolean)
      .join(', ');
    const description = hit.summary ? `\nDescription (not the document's words): ${hit.summary}` : '';
    return `[${index + 1}] ${where}\ndocumentId: ${hit.documentId}\nsectionId: ${hit.sectionId || ''}\n${clip(hit.text, MODEL_CHARS)}${description}`;
  });
  return `Question: ${query}\n\nPassages found for that question:\n\n${lines.join('\n\n') || 'None.'}`;
}

function forModel(section: AnswerSection): string {
  return JSON.stringify({
    documentId: section.documentId,
    documentTitle: section.documentTitle,
    sectionId: section.sectionId,
    heading: section.parentHeading ? `${section.parentHeading} > ${section.heading}` : section.heading,
    passages: section.passages.map((passage) => ({
      quote: clip(passage.text, MODEL_CHARS),
      page: passage.page,
      clause: passage.clause,
      ...(passage.summary ? { description: passage.summary } : {}),
    })),
    ...(section.more ? { more: 'The section continues after these passages. Answer from what you have.' } : {}),
  });
}

function readAnswer(input: Record<string, unknown>): { summary: string; citations: Citation[] } | { error: string } {
  const summary = typeof input.summary === 'string' ? clip(input.summary, 2000) : '';
  if (!summary) return { error: 'Write the summary in summary, in plain sentences.' };
  const raw = Array.isArray(input.sections) ? input.sections : [];
  const citations: Citation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const documentId = typeof record.documentId === 'string' ? record.documentId.trim() : '';
    const sectionRaw = typeof record.sectionId === 'string' ? record.sectionId.trim() : '';
    if (!documentId) continue;
    citations.push({ documentId, sectionId: sectionRaw || null });
    if (citations.length >= MAX_SECTIONS) break;
  }
  return { summary, citations };
}

/**
 * Searches, lets the model read the sections it needs, and returns the summary
 * with those sections. A model that cannot be reached still returns the
 * passages the search found.
 */
export async function answerDocuments(
  supabase: SupabaseClient,
  query: string,
  filters: SearchFilters,
  embed: EmbedConfig | null,
  model: AnswerModel | null,
): Promise<DocumentAnswer> {
  const text = query.trim();
  if (!text) return { summary: null, note: null, sections: [] };

  const allHits: SearchHit[] = [];
  let searchNote: string | null = null;
  let searches = 0;

  const remember = (found: { hits: SearchHit[]; note: string | null }) => {
    allHits.push(...found.hits);
    searches += 1;
    if (!searchNote && found.note) searchNote = found.note;
  };

  const runSearch = async (asked: string) => {
    const found = await searchDocuments(supabase, asked, { ...filters, limit: 8 }, embed);
    remember(found);
    return found.hits;
  };

  await runSearch(text);

  const docs = new Map<string, Row | null>();
  const loaded = new Map<string, AnswerSection>();

  const getDoc = async (documentId: string): Promise<Row | null> => {
    if (docs.has(documentId)) return docs.get(documentId) || null;
    const row = await call<Row | null>(supabase, 'document_get', { p_id: documentId });
    docs.set(documentId, row);
    return row;
  };

  const inScope = (documentId: string, doc: Row): boolean => {
    if (filters.documentIds && filters.documentIds.length > 0 && !filters.documentIds.includes(documentId)) return false;
    if (filters.typeCodes && filters.typeCodes.length > 0 && !filters.typeCodes.includes(String(doc.type_code))) return false;
    if (filters.entityIds && filters.entityIds.length > 0) {
      const linked = new Set((Array.isArray(doc.entities) ? doc.entities : []).map((entity: Row) => String(entity.entity_id)));
      if (!filters.entityIds.some((id) => linked.has(id))) return false;
    }
    return true;
  };

  const readSection = async (documentId: string, sectionId: string): Promise<{ section: AnswerSection } | { error: string }> => {
    if (!UUID.test(documentId) || !UUID.test(sectionId)) return { error: 'Give the documentId and sectionId from a passage you were shown.' };
    if (filters.documentIds && filters.documentIds.length > 0 && !filters.documentIds.includes(documentId)) {
      return { error: 'That document is outside this question.' };
    }
    const key = `${documentId}:${sectionId}`;
    const cached = loaded.get(key);
    if (cached) return { section: cached };
    const doc = await getDoc(documentId);
    if (!doc || !inScope(documentId, doc)) return { error: 'That document is outside this question.' };
    const sections = Array.isArray(doc.sections) ? doc.sections : [];
    const section = sections.find((item: Row) => item.id === sectionId);
    if (!section) return { error: 'That heading is not in this document.' };
    const parent = section.parent_seq === null || section.parent_seq === undefined
      ? null
      : sections.find((item: Row) => Number(item.seq) === Number(section.parent_seq));
    const rows = (await call<Row[] | null>(supabase, 'document_chunks_list', {
      p_document_id: documentId,
      p_section_id: sectionId,
      p_limit: PASSAGE_LIMIT + 1,
      p_offset: 0,
    })) || [];
    const fromHits = allHits.find((hit) => hit.documentId === documentId);
    const answerSection: AnswerSection = {
      documentId,
      documentTitle: String(doc.title || fromHits?.documentTitle || 'Document'),
      sectionId,
      heading: String(section.heading || 'Section'),
      parentHeading: parent?.heading ? String(parent.heading) : null,
      passages: rows.slice(0, PASSAGE_LIMIT).map(passageFromRow),
      more: rows.length > PASSAGE_LIMIT,
    };
    loaded.set(key, answerSection);
    return { section: answerSection };
  };

  const resolve = async (citations: Citation[]): Promise<AnswerSection[]> => {
    const out: AnswerSection[] = [];
    const used = new Set<string>();
    for (const cite of citations) {
      const key = `${cite.documentId}:${cite.sectionId || ''}`;
      if (used.has(key)) continue;
      used.add(key);
      if (!cite.sectionId) {
        const front = groupHits(allHits.filter((hit) => hit.documentId === cite.documentId && !hit.sectionId));
        if (front[0]) out.push(front[0]);
        continue;
      }
      const read = await readSection(cite.documentId, cite.sectionId);
      if ('section' in read) out.push(read.section);
    }
    return out.slice(0, MAX_SECTIONS);
  };

  const finish = async (summary: string | null, citations: Citation[] | null, extraNote?: string | null): Promise<DocumentAnswer> => {
    let sections = citations ? await resolve(citations) : [];
    let note = joinNotes(searchNote, extraNote);
    if (summary && citations && citations.length > 0 && sections.length === 0) {
      note = joinNotes(note, 'The sections named in the answer could not be read. These are the passages the search found.');
      sections = groupHits(allHits);
    }
    if (sections.length === 0) sections = groupHits(allHits);
    return { summary, note, sections };
  };

  if (!model) return finish(null, null, 'No summary was written: no model key is set.');

  const opened: Citation[] = [];
  const messages: unknown[] = [model.userMessage(brief(text, allHits.slice(0, 8)))];
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const requireAnswer = round === MAX_ROUNDS - 1;
      const turn = await model.turn(SYSTEM, TOOLS, messages, requireAnswer);
      const calls = Array.isArray(turn.calls) ? turn.calls : [];
      if (calls.length === 0) return finish(turn.text.trim() ? clip(turn.text, 2000) : null, opened.length > 0 ? opened : null);

      const answerCall = calls.find((item) => item.name === 'answer');
      const others = calls.filter((item) => item.name !== 'answer');
      if (answerCall && (others.length === 0 || requireAnswer)) {
        const parsed = readAnswer(answerCall.input || {});
        if ('error' in parsed) {
          if (requireAnswer) return finish(null, opened.length > 0 ? opened : null, 'No summary was written.');
          messages.push(turn.message);
          messages.push(model.resultMessage([{ call: answerCall, content: parsed.error, isError: true }]));
          continue;
        }
        return finish(parsed.summary, parsed.citations);
      }

      const results: AnswerToolResult[] = [];
      for (const toolCall of others) {
        results.push(await runTool(toolCall));
      }
      if (answerCall) results.push({ call: answerCall, content: 'Answer after you have read these results.', isError: true });
      messages.push(turn.message);
      messages.push(model.resultMessage(results));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'the model could not be reached.';
    return finish(null, null, `The passages are shown without a summary: ${message}`);
  }
  return finish(null, opened.length > 0 ? opened : null, 'No summary was written.');

  async function runTool(toolCall: AnswerToolCall): Promise<AnswerToolResult> {
    try {
      if (toolCall.name === 'search_passages') {
        if (searches >= MAX_SEARCHES) return { call: toolCall, content: 'You have searched enough. Answer from what you have.', isError: true };
        const asked = typeof toolCall.input?.query === 'string' ? toolCall.input.query.trim() : '';
        if (!asked) return { call: toolCall, content: 'Say what to look for.', isError: true };
        const hits = await runSearch(asked.slice(0, 500));
        return { call: toolCall, content: brief(asked, hits).slice(0, 12000), isError: false };
      }
      if (toolCall.name === 'read_section') {
        const documentId = typeof toolCall.input?.documentId === 'string' ? toolCall.input.documentId.trim() : '';
        const sectionId = typeof toolCall.input?.sectionId === 'string' ? toolCall.input.sectionId.trim() : '';
        const read = await readSection(documentId, sectionId);
        if ('error' in read) return { call: toolCall, content: read.error, isError: true };
        opened.push({ documentId, sectionId });
        return { call: toolCall, content: forModel(read.section), isError: false };
      }
      return { call: toolCall, content: 'That tool is not available. Search, read a section, or answer.', isError: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The read failed.';
      return { call: toolCall, content: message, isError: true };
    }
  }
}
