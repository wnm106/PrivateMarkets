import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, embedConfigFromEnv, rerank, type EmbedConfig } from './embed';
import { searchDocuments } from './pipeline';

const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);

/** Search rows as document_search returns them, best joined score first. */
function row(id: string, text: string, score: number, extra: Record<string, unknown> = {}) {
  return {
    chunk_id: id, document_id: 'doc', document_title: 'Credit Agreement', type_code: 'CREDIT_AGREEMENT', type_name: 'Credit agreement',
    section_heading: 'Signatures', parent_heading: null, kind: 'CLAUSE', text, char_start: 0, char_end: text.length,
    locator: {}, tags: [], score, similarity: 0.4, meaning_rank: 1, word_rank: null, entities: [], ...extra,
  };
}

function store(rows: Array<Record<string, unknown>>) {
  const calls: Array<Record<string, any>> = [];
  const supabase = {
    rpc: async (fn: string, args: Record<string, any>) => {
      calls.push({ fn, ...args });
      return { data: rows.slice(0, args.p_limit), error: null };
    },
  } as any;
  return { supabase, calls };
}

/** A stand-in for the service: embeds anything, and scores passages by a rule the test gives. */
function service(score: (passage: string) => number, options: { rerankStatus?: number; key?: string } = {}) {
  const seen: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ url, body });
    if (url.endsWith('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: vector }] }), { status: 200 });
    if (options.rerankStatus) return new Response('no', { status: options.rerankStatus, headers: { 'retry-after': '90' } });
    // The service answers best first, not in the order sent.
    const data = (body.documents as string[]).map((passage, index) => ({ index, relevance_score: score(passage) }))
      .sort((a, b) => b.relevance_score - a.relevance_score);
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
  const config: EmbedConfig = { apiKey: options.key || 'rerank-key', model: 'voyage-4', rerankModel: 'rerank-3', baseUrls: ['https://svc.test/v1'], fetch: fetchImpl };
  return { config, seen };
}

describe('the second ranking pass', () => {
  it('is on by default and can be turned off', () => {
    expect(embedConfigFromEnv({ VOYAGE_API_KEY: 'k' })!.rerankModel).toBe('rerank-3');
    expect(embedConfigFromEnv({ VOYAGE_API_KEY: 'k', DOCUMENT_RERANK_MODEL: 'rerank-3-lite' })!.rerankModel).toBe('rerank-3-lite');
    expect(embedConfigFromEnv({ VOYAGE_API_KEY: 'k', DOCUMENT_RERANK_MODEL: 'off' })!.rerankModel).toBeNull();
  });

  it('returns a score for each passage in the order they were sent', async () => {
    const { config, seen } = service((passage) => (passage.includes('signed') ? 0.9 : 0.2));
    expect(await rerank('who signed', ['a clause', 'signed by the CFO', 'another'], config)).toEqual([0.2, 0.9, 0.2]);
    expect(seen[0]).toMatchObject({ url: 'https://svc.test/v1/rerank', body: { query: 'who signed', model: 'rerank-3', truncation: true } });
  });

  it('puts the passage that answers the question first, whatever its joined rank', async () => {
    const rows = [
      row('a', 'Each entity composing the Borrower appoints PubMatic as agent.', 0.031),
      row('b', 'The Borrower shall be jointly and severally liable.', 0.030),
      row('c', 'PUBMATIC, INC.\nBy: /s/ Steven Pantelick', 0.019, { summary: 'Signature page signed for the borrower by its CFO.' }),
    ];
    const { supabase, calls } = store(rows);
    const { config, seen } = service((passage) => (passage.includes('Signature page') ? 0.8 : 0.3));
    const result = await searchDocuments(supabase, 'who signed for the borrower', { limit: 2 }, config);

    expect(result.reranked).toBe(true);
    expect(result.hits.map((hit) => hit.chunkId)).toEqual(['c', 'a']);
    expect(result.hits[0].relevance).toBe(0.8);
    // More candidates are fetched than are returned, and the model reads the heading and description with the words.
    expect(calls[0].p_limit).toBe(30);
    expect(seen[1].body.documents[2]).toBe('Signatures\nSignature page signed for the borrower by its CFO.\nPUBMATIC, INC.\nBy: /s/ Steven Pantelick');
  });

  it('falls back to the joined order when the service is busy, and says so', async () => {
    const rows = [row('a', 'first', 0.03), row('b', 'second', 0.02)];
    const { supabase } = store(rows);
    const { config } = service(() => 0, { rerankStatus: 429, key: 'busy-key' });
    const result = await searchDocuments(supabase, 'anything', { limit: 5 }, config);
    expect(result.reranked).toBe(false);
    expect(result.hits.map((hit) => hit.chunkId)).toEqual(['a', 'b']);
    expect(result.hits[0].relevance).toBeNull();
    expect(result.note).toMatch(/without the second pass/);
  });

  it('does not run when it is off, or when there is no question to rank against', async () => {
    const rows = [row('a', 'first', 0.03), row('b', 'second', 0.02)];
    const off = service(() => 1, { key: 'off-key' });
    off.config.rerankModel = null;
    const first = store(rows);
    expect((await searchDocuments(first.supabase, 'question', { limit: 5 }, off.config)).reranked).toBe(false);
    expect(first.calls[0].p_limit).toBe(5);
    expect(off.seen.some((call) => call.url.endsWith('/rerank'))).toBe(false);

    const tagsOnly = service(() => 1, { key: 'tags-key' });
    const second = store(rows);
    expect((await searchDocuments(second.supabase, '  ', { tags: ['kind:table'], limit: 5 }, tagsOnly.config)).reranked).toBe(false);
    expect(tagsOnly.seen).toHaveLength(0);
  });
});
