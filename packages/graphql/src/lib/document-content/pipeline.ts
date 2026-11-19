/**
 * Takes a stored file to searchable chunks, in four steps:
 *
 *   READING    the file becomes text, headings and chunks
 *   TAGGING    each heading is placed on a section of the type's template
 *   REFINING   a passage that is mostly names and numbers gets a description and topics
 *   EMBEDDING  each chunk gets a vector
 *
 * Embedding saves as it goes. A run stopped by the service's rate limit picks
 * up at the first chunk without a vector, and keyword search works meanwhile.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { batchesOf, embedPatiently, EmbedRateLimited, rerank, vectorLiteral, type EmbedConfig, type EmbedPacing } from './embed';
import { buildChunks, buildOutline, guessTitle } from './outline';
import { readDocument, UnreadableDocument } from './read';
import { cleanRefineResult, cleanTopics, ensureTemplateRoutes, type RefineRequest, type Refiner } from './refine';
import { cleanTemplateSections, labelsToEmbed, matchSections } from './template';
import type { Section, SectionMatch, TemplateSection } from './types';

export const DOCUMENT_BUCKET = 'documents';

type Row = Record<string, any>;

async function call<T>(supabase: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

function outlineRows(sections: Row[]): Array<Pick<Section, 'seq' | 'parentSeq' | 'level' | 'heading'>> {
  return sections.map((section) => ({
    seq: Number(section.seq),
    parentSeq: section.parent_seq === null || section.parent_seq === undefined ? null : Number(section.parent_seq),
    level: Number(section.level),
    heading: String(section.heading || ''),
  }));
}

export interface TagResult {
  templateId: string | null;
  headings: number;
  matched: number;
}

/**
 * Places a document's headings on its type's published template and records the
 * result. Works for a signed-in person with document.manage and for the worker.
 * With an embedding key, headings the words did not place are compared by meaning.
 */
export async function tagDocument(supabase: SupabaseClient, documentId: string, embed: EmbedConfig | null, pacing: EmbedPacing = {}): Promise<TagResult> {
  const document = await call<Row | null>(supabase, 'document_get', { p_id: documentId });
  if (!document) throw new Error('Document was not found');
  const templates = await call<Row[] | null>(supabase, 'document_templates_list', { p_type_id: document.type_id });
  // The client's own published template, else the shared one.
  const published = (templates || [])
    .filter((template) => template.status === 'PUBLISHED' && (template.client_id === document.client_id || template.client_id === null))
    .sort((a, b) => Number(a.client_id === null) - Number(b.client_id === null) || Number(b.version) - Number(a.version))[0];
  const sections = outlineRows(document.sections || []);

  if (!published) {
    await call(supabase, 'document_apply_tagging', { p_id: documentId, p_template_id: null, p_matches: [] });
    return { templateId: null, headings: sections.length, matched: 0 };
  }

  const template: TemplateSection[] = cleanTemplateSections(published.sections);
  let vectors: Map<string, number[]> | undefined;
  if (embed) {
    const labels = labelsToEmbed(sections, template);
    if (labels.length > 0) {
      try {
        vectors = new Map();
        for (const batch of batchesOf(labels.map((text) => ({ text })))) {
          const embedded = await embedPatiently(batch.map((item) => item.text), 'document', embed, pacing);
          batch.forEach((item, index) => vectors!.set(item.text, embedded[index]));
        }
      } catch (error) {
        // Tagging by words still stands; meaning is an extra.
        if (!(error instanceof EmbedRateLimited)) throw error;
        vectors = undefined;
      }
    }
  }
  const matches: SectionMatch[] = matchSections(sections, template, { vectors });
  await call(supabase, 'document_apply_tagging', { p_id: documentId, p_template_id: published.id, p_matches: matches });
  return { templateId: String(published.id), headings: sections.length, matched: matches.length };
}

export interface ProcessOptions extends EmbedPacing {
  embed: EmbedConfig | null;
  /** Describes thin passages. Without it they are embedded as they are. */
  refiner?: Refiner | null;
  /** Read the file again even when its text is already stored. */
  reread?: boolean;
}

export interface ProcessResult {
  documentId: string;
  status: 'READY' | 'PROCESSING' | 'FAILED';
  chunks: number;
  embedded: number;
  remaining: number;
  matchedHeadings: number;
  /** Thin passages described in this run. */
  refined: number;
  message: string | null;
}

/**
 * Describes the thin passages nobody has described yet. A passage the model
 * could not describe stays as it is; how many remain is returned so the caller
 * can say so.
 */
export async function refineDocument(supabase: SupabaseClient, documentId: string, refiner: Refiner): Promise<{ refined: number; left: number }> {
  let refined = 0;
  const tried = new Set<string>();
  for (;;) {
    const work = await call<Row | null>(supabase, 'document_chunks_to_refine', { p_id: documentId, p_limit: 200 });
    const requests: RefineRequest[] = ((work?.chunks as Row[] | undefined) || [])
      .filter((row) => !tried.has(String(row.id)))
      .slice(0, 24)
      .map((row) => ({ id: String(row.id), kind: String(row.kind), text: String(row.text), path: String(row.path || ''), before: row.before || null }));
    if (!work || requests.length === 0) return { refined, left: Number(work?.waiting) || 0 };
    requests.forEach((request) => tried.add(request.id));
    const topics = cleanTopics(work.topics);
    const results = await refiner(requests, { documentTitle: String(work.title), typeName: String(work.type_name), topics });
    const asked = new Set(requests.map((request) => request.id));
    const rows = results.filter((result) => asked.has(result.id)).map((result) => cleanRefineResult(result, topics)).filter((result) => result.summary);
    if (rows.length > 0) refined += await call<number>(supabase, 'document_chunks_refined', { p_id: documentId, p_rows: rows });
  }
}

/**
 * Runs the steps a document still needs. Needs the service role. Returns
 * PROCESSING with `remaining` above zero when the rate limit outlasted the
 * budget: call again to carry on.
 */
export async function processDocument(supabase: SupabaseClient, documentId: string, options: ProcessOptions): Promise<ProcessResult> {
  const context = await call<Row | null>(supabase, 'document_job_context', { p_id: documentId });
  if (!context) throw new Error('Document was not found');
  const setStatus = (status: string, stage: string | null, message: string | null) =>
    call(supabase, 'document_set_status', { p_id: documentId, p_status: status, p_stage: stage, p_message: message });
  const base = { documentId, matchedHeadings: 0, refined: 0 };

  // Already read and nobody asked for it again: a run queued twice, or one a person finished by hand.
  if (!options.reread && context.status === 'READY' && context.has_body === true) {
    const done = Number(context.embedded_count) || 0;
    const total = Number(context.chunk_count) || 0;
    return { ...base, status: 'READY', chunks: total, embedded: done, remaining: total - done, message: context.message || null };
  }

  const resume = !options.reread && context.has_body === true && context.status === 'PROCESSING'
    && (context.stage === 'REFINING' || context.stage === 'EMBEDDING');
  let chunkCount = Number(context.chunk_count) || 0;
  let matched = 0;

  if (!resume) {
    await setStatus('PROCESSING', 'READING', null);
    const { data: blob, error: downloadError } = await supabase.storage.from(DOCUMENT_BUCKET).download(context.storage_path);
    if (downloadError || !blob) {
      const message = `The stored file could not be opened. ${downloadError?.message || ''}`.trim();
      await setStatus('FAILED', null, message);
      return { ...base, status: 'FAILED', chunks: 0, embedded: 0, remaining: 0, message };
    }
    let read;
    try {
      read = await readDocument(String(context.file_name), context.media_type, new Uint8Array(await blob.arrayBuffer()));
    } catch (error) {
      if (!(error instanceof UnreadableDocument)) throw error;
      await setStatus('FAILED', null, error.message);
      return { ...base, status: 'FAILED', chunks: 0, embedded: 0, remaining: 0, message: error.message };
    }
    const outline = buildOutline(read);
    const chunks = buildChunks(read, outline);
    const stored = await call<Row>(supabase, 'document_store_content', {
      p_id: documentId,
      p_body: read.body,
      p_format: read.format,
      p_page_count: read.pageCount,
      // A file with no title of its own is called by its name, without the extension.
      p_title: guessTitle(read, outline) || String(context.file_name).replace(/\.[A-Za-z0-9]{1,5}$/, ''),
      p_sections: outline.sections,
      p_chunks: chunks,
    });
    chunkCount = Number(stored.chunks) || 0;
    // Passages whose words and place did not change take back the vector they had, a batch at a time.
    if (Number(stored.kept) > 0) {
      for (let left = Number(stored.kept), rounds = 0; left > 0 && rounds < 500; rounds += 1) {
        left = await call<number>(supabase, 'document_restore_kept', { p_id: documentId, p_limit: 150 });
      }
    }

    await setStatus('PROCESSING', 'TAGGING', null);
    const tagged = await tagDocument(supabase, documentId, options.embed, options);
    matched = tagged.matched;
    // The template's topics and top sections need vectors before a search can be routed by them.
    if (options.embed && tagged.templateId) {
      try {
        await ensureTemplateRoutes(supabase, tagged.templateId, options.embed, options);
      } catch {
        // Search still works without routes; publishing the template builds them again.
      }
    }
  }

  // A document is still worth having when its tables could not be described, so this step never fails the run.
  let refined = 0;
  let refineNote: string | null = null;
  if (options.refiner) {
    await setStatus('PROCESSING', 'REFINING', null);
    try {
      const outcome = await refineDocument(supabase, documentId, options.refiner);
      refined = outcome.refined;
      if (outcome.left > 0) refineNote = `${outcome.left} tables or lists could not be described and are found by their own words only.`;
    } catch (error) {
      refineNote = `Tables and lists were not described. ${error instanceof Error ? error.message : 'The model could not be reached.'}`;
    }
  }

  if (!options.embed) {
    const message = 'Search by words only. Set VOYAGE_API_KEY to search by meaning.';
    await setStatus('READY', null, message);
    return { documentId, status: 'READY', chunks: chunkCount, embedded: 0, remaining: chunkCount, matchedHeadings: matched, refined, message };
  }

  await setStatus('PROCESSING', 'EMBEDDING', refineNote);
  let remaining = chunkCount;
  for (;;) {
    const pending = await call<Row[] | null>(supabase, 'document_chunks_pending', { p_id: documentId, p_limit: 128 });
    if (!pending || pending.length === 0) {
      remaining = 0;
      break;
    }
    // The heading path and any description go in with the words, so a passage is embedded knowing where it sits and what it holds.
    const items = pending.map((row) => ({
      id: String(row.id),
      text: [row.path, row.summary, row.text].filter(Boolean).join('\n').slice(0, 16000),
    }));
    let limited = false;
    for (const batch of batchesOf(items)) {
      let vectors: number[][];
      try {
        vectors = await embedPatiently(batch.map((item) => item.text), 'document', options.embed, options);
      } catch (error) {
        if (!(error instanceof EmbedRateLimited)) throw error;
        limited = true;
        break;
      }
      remaining = await call<number>(supabase, 'document_chunks_embedded', {
        p_id: documentId,
        p_model: options.embed.model,
        p_rows: batch.map((item, index) => ({ id: item.id, embedding: vectorLiteral(vectors[index]) })),
      });
    }
    if (limited) {
      const message = `${chunkCount - remaining} of ${chunkCount} chunks embedded. The embedding service is limiting requests; the rest follow on the next run.`;
      await setStatus('PROCESSING', 'EMBEDDING', message);
      return { documentId, status: 'PROCESSING', chunks: chunkCount, embedded: chunkCount - remaining, remaining, matchedHeadings: matched, refined, message };
    }
  }
  await setStatus('READY', null, refineNote);
  return { documentId, status: 'READY', chunks: chunkCount, embedded: chunkCount, remaining: 0, matchedHeadings: matched, refined, message: refineNote };
}

export interface SearchFilters {
  tags?: string[] | null;
  entityIds?: string[] | null;
  typeCodes?: string[] | null;
  documentIds?: string[] | null;
  limit?: number | null;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  documentDate: string | null;
  typeCode: string;
  typeName: string;
  sectionId: string | null;
  sectionNumber: string | null;
  sectionHeading: string | null;
  parentHeading: string | null;
  templateSectionCode: string | null;
  kind: string;
  /** The exact words of the document. Quote this. */
  text: string;
  /** What the passage holds, where its own words say little. Written by a model or a person. Never quote it as the document. */
  summary: string | null;
  /** The topic or section of the template that brought the passage forward, if one did. */
  routedBy: string | null;
  charStart: number;
  charEnd: number;
  page: number | null;
  clause: string | null;
  locator: Record<string, unknown>;
  tags: string[];
  score: number;
  similarity: number | null;
  /** How well the passage answers the question, from 0 to 1, when the second ranking pass ran. */
  relevance: number | null;
  /** How the chunk was found: by meaning, by words, or both. */
  /** TOPIC: found only because it carries the topic or sits in the section the question is about. */
  foundBy: 'MEANING' | 'WORDS' | 'BOTH' | 'TOPIC';
  entities: Array<{ entityId: string; entityName: string; role: string }>;
}

export function mapSearchHit(row: Row): SearchHit {
  const locator = row.locator && typeof row.locator === 'object' ? row.locator : {};
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    documentDate: row.document_date || null,
    typeCode: row.type_code,
    typeName: row.type_name,
    sectionId: row.section_id || null,
    sectionNumber: row.section_number || null,
    sectionHeading: row.section_heading || null,
    parentHeading: row.parent_heading || null,
    templateSectionCode: row.template_section_code || null,
    kind: row.kind,
    text: row.text,
    summary: row.summary || null,
    routedBy: row.topic_route ? `topic:${row.topic_route}` : row.section_route ? `section:${row.section_route}` : null,
    charStart: Number(row.char_start),
    charEnd: Number(row.char_end),
    page: typeof locator.page === 'number' ? locator.page : null,
    clause: typeof locator.clause === 'string' ? locator.clause : null,
    locator,
    tags: Array.isArray(row.tags) ? row.tags : [],
    score: Number(row.score) || 0,
    similarity: row.similarity === null || row.similarity === undefined ? null : Number(row.similarity),
    relevance: null,
    foundBy: row.meaning_rank && row.word_rank ? 'BOTH' : row.meaning_rank ? 'MEANING' : row.word_rank ? 'WORDS' : 'TOPIC',
    entities: (Array.isArray(row.entities) ? row.entities : []).map((entity: Row) => ({
      entityId: entity.entity_id,
      entityName: entity.entity_name,
      role: entity.role,
    })),
  };
}

/** How many candidates the second pass reads, and how much of each. */
const RERANK_POOL = 30;
const RERANK_CHARS = 1600;

/** What the ranking model reads for a passage: where it sits, what it holds, and its words. */
function rankingText(hit: SearchHit): string {
  const where = [hit.parentHeading, hit.sectionHeading].filter(Boolean).join(' > ');
  return [where, hit.summary, hit.text].filter(Boolean).join('\n').slice(0, RERANK_CHARS);
}

/**
 * Orders candidates by how well each answers the question. Joining lists by
 * rank lets a passage that is a middling match two ways outrank one that is
 * by far the closest in meaning; a model that reads question and passage
 * together puts that right. Waits out one short rate limit, then gives up.
 */
async function rerankHits(query: string, hits: SearchHit[], embed: EmbedConfig): Promise<SearchHit[]> {
  let scores: number[];
  try {
    scores = await rerank(query, hits.map(rankingText), embed);
  } catch (error) {
    if (!(error instanceof EmbedRateLimited) || error.retryAfterMs > 25000) throw error;
    await new Promise((done) => setTimeout(done, error.retryAfterMs));
    scores = await rerank(query, hits.map(rankingText), embed);
  }
  return hits
    .map((hit, index) => ({ ...hit, relevance: Math.round(scores[index] * 10000) / 10000 }))
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || b.score - a.score);
}

/**
 * Searches the caller's documents. With an embedding key the question is
 * embedded and chunks are found by meaning as well as by words, and the best
 * candidates are then ranked again by a model that reads each against the
 * question. If the service cannot be reached the search still runs on words,
 * or without the second pass, and the result says so.
 */
export async function searchDocuments(
  supabase: SupabaseClient,
  query: string,
  filters: SearchFilters,
  embed: EmbedConfig | null,
): Promise<{ hits: SearchHit[]; byMeaning: boolean; reranked: boolean; note: string | null }> {
  const text = query.trim();
  let embedding: string | null = null;
  let note: string | null = embed ? null : 'Searched by words only: no embedding key is set.';
  if (embed && text) {
    try {
      const [vector] = await embedPatiently([text.slice(0, 4000)], 'query', embed, { budgetMs: 25000 });
      embedding = vectorLiteral(vector);
    } catch (error) {
      note = `Searched by words only: ${error instanceof Error ? error.message : 'the embedding service failed.'}`;
    }
  }
  const list = (values?: string[] | null) => (values && values.length > 0 ? values : null);
  const limit = Math.min(Math.max(filters.limit ?? 10, 1), 50);
  const secondPass = Boolean(embed?.rerankModel) && text !== '';
  const rows = await call<Row[] | null>(supabase, 'document_search', {
    p_query: text,
    p_embedding: embedding,
    p_tags: list(filters.tags),
    p_entity_ids: list(filters.entityIds),
    p_type_codes: list(filters.typeCodes),
    p_document_ids: list(filters.documentIds),
    // The second pass needs more candidates than it returns.
    p_limit: secondPass ? Math.max(limit, RERANK_POOL) : limit,
  });
  let hits = (rows || []).map(mapSearchHit);
  let reranked = false;
  if (secondPass && hits.length > 1) {
    try {
      hits = await rerankHits(text, hits, embed!);
      reranked = true;
    } catch (error) {
      note = `Ranked without the second pass: ${error instanceof Error ? error.message : 'the ranking service failed.'}`;
    }
  }
  return { hits: hits.slice(0, limit), byMeaning: embedding !== null, reranked, note };
}
