/**
 * Turns text into vectors with a Voyage AI model. Anthropic has no embedding
 * model of its own. Text leaves for an outside service here, so nothing is
 * sent unless VOYAGE_API_KEY is set.
 *
 * A key made in MongoDB Atlas is served from ai.mongodb.com; a key from the
 * Voyage platform from api.voyageai.com. The first is tried, then the other.
 */

export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbedConfig {
  apiKey: string;
  model: string;
  /** The model for the second ranking pass over search results. Null or missing turns the pass off. */
  rerankModel?: string | null;
  /** Tried in order until one accepts the key. */
  baseUrls: string[];
  fetch?: typeof fetch;
}

export class EmbedRateLimited extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('The embedding service is limiting requests.');
    this.name = 'EmbedRateLimited';
    this.retryAfterMs = retryAfterMs;
  }
}

/** DOCUMENT_RERANK_MODEL: a model name, or "off" for no second pass. Unset means rerank-3. */
function rerankModelFrom(value: string | undefined): string | null {
  const name = (value || '').trim();
  if (!name) return 'rerank-3';
  return /^(off|none|false|0)$/i.test(name) ? null : name;
}

/** The settings from the environment, or null when no key is set. */
export function embedConfigFromEnv(env: Record<string, string | undefined> = process.env): EmbedConfig | null {
  const apiKey = (env.VOYAGE_API_KEY || '').trim();
  if (!apiKey) return null;
  const configured = (env.VOYAGE_API_BASE || '').trim().replace(/\/+$/, '');
  return {
    apiKey,
    model: (env.DOCUMENT_EMBEDDING_MODEL || '').trim() || 'voyage-4',
    rerankModel: rerankModelFrom(env.DOCUMENT_RERANK_MODEL),
    baseUrls: configured ? [configured] : ['https://ai.mongodb.com/v1', 'https://api.voyageai.com/v1'],
  };
}

/** A vector as Postgres reads it. */
export function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

// The address that accepted this key, so the other is not tried on every call.
const acceptedBase = new Map<string, string>();

/** One POST to the service, at whichever address takes the key. Throws EmbedRateLimited when asked to slow down. */
async function post<T>(path: string, body: unknown, config: EmbedConfig): Promise<T> {
  const send = config.fetch || fetch;
  const known = acceptedBase.get(config.apiKey);
  const bases = known ? [known] : config.baseUrls;
  let lastError = 'The embedding service could not be reached.';
  for (const base of bases) {
    const response = await send(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw new EmbedRateLimited(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) * 1000 : 20000);
    }
    if (response.status === 401 || response.status === 403) {
      lastError = 'The embedding service refused the key in VOYAGE_API_KEY.';
      continue;
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`The embedding service answered ${response.status}. ${detail}`.trim());
    }
    const payload = (await response.json()) as T;
    acceptedBase.set(config.apiKey, base);
    return payload;
  }
  throw new Error(lastError);
}

/**
 * One request. `kind` tells the model whether the text is stored or asked, which
 * it embeds differently. Throws EmbedRateLimited when asked to slow down.
 */
export async function embedBatch(texts: string[], kind: 'document' | 'query', config: EmbedConfig): Promise<number[][]> {
  if (texts.length === 0) return [];
  const payload = await post<{ data?: Array<{ index: number; embedding: number[] }> }>(
    '/embeddings',
    { input: texts, model: config.model, input_type: kind, output_dimension: EMBEDDING_DIMENSIONS },
    config,
  );
  const rows = [...(payload.data || [])].sort((a, b) => a.index - b.index);
  if (rows.length !== texts.length || rows.some((row) => !Array.isArray(row.embedding) || row.embedding.length !== EMBEDDING_DIMENSIONS)) {
    throw new Error('The embedding service did not return one vector of the expected size for each text.');
  }
  return rows.map((row) => row.embedding);
}

/**
 * Scores each passage against the question with a model that reads the two
 * together, which tells a passage that answers the question from one that only
 * shares its words. Returns one score per passage, in the order given, from 0
 * to 1. Throws EmbedRateLimited when asked to slow down.
 */
export async function rerank(query: string, passages: string[], config: EmbedConfig): Promise<number[]> {
  if (passages.length === 0) return [];
  const payload = await post<{ data?: Array<{ index: number; relevance_score: number }> }>(
    '/rerank',
    { query, documents: passages, model: config.rerankModel, truncation: true },
    config,
  );
  const scores = new Array<number>(passages.length).fill(Number.NaN);
  for (const row of payload.data || []) {
    if (Number.isInteger(row.index) && row.index >= 0 && row.index < scores.length) scores[row.index] = Number(row.relevance_score);
  }
  if (scores.some((score) => !Number.isFinite(score))) throw new Error('The ranking service did not return a score for every passage.');
  return scores;
}

/**
 * Splits texts into requests small enough for an account on the free tier,
 * which allows few tokens a minute: about 24,000 characters a request.
 */
export function batchesOf<T extends { text: string }>(items: T[], maxChars = 24000, maxItems = 48): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length > 0 && (size + item.text.length > maxChars || current.length >= maxItems)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface EmbedPacing {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stop waiting on rate limits after this long. What is left stays for the next run. */
  budgetMs?: number;
}

/** embedBatch that waits and tries again when asked to slow down, until the budget runs out. */
export async function embedPatiently(texts: string[], kind: 'document' | 'query', config: EmbedConfig, pacing: EmbedPacing = {}): Promise<number[][]> {
  const sleep = pacing.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = pacing.now || Date.now;
  const deadline = now() + (pacing.budgetMs ?? 60000);
  for (;;) {
    try {
      return await embedBatch(texts, kind, config);
    } catch (error) {
      if (!(error instanceof EmbedRateLimited) || now() + error.retryAfterMs > deadline) throw error;
      await sleep(error.retryAfterMs);
    }
  }
}
