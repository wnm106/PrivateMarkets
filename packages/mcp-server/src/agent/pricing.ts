/**
 * What a model call costs.
 *
 * Rates are US dollars per million tokens. They are estimates for the models
 * this platform calls, and AGENT_MODEL_PRICES (a JSON object keyed by model
 * name) replaces any of them. A call stores the rates it was priced with, so
 * a later change does not rewrite history.
 */

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Charged only when the provider bills thinking separately from output. */
  thinkingPerMillion: number;
  /** Share of the input rate charged for a cache read. */
  cacheReadRatio: number;
  /** Multiple of the input rate charged to write a cache. */
  cacheWriteRatio: number;
}

export type PriceCatalog = Record<string, Partial<ModelPrice>>;

const DEFAULT_PRICE: ModelPrice = {
  inputPerMillion: 1,
  outputPerMillion: 5,
  thinkingPerMillion: 5,
  cacheReadRatio: 0.25,
  cacheWriteRatio: 1.25,
};

/**
 * Published-style defaults. Longer names win over shorter prefixes, so
 * gemini-3.8-flash beats gemini, and claude-opus-5-5 beats claude-opus.
 */
export const DEFAULT_PRICES: PriceCatalog = {
  'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4, thinkingPerMillion: 0.4, cacheReadRatio: 0.25, cacheWriteRatio: 1 },
  'gemini-3.8-flash': { inputPerMillion: 0.15, outputPerMillion: 0.6, thinkingPerMillion: 0.6, cacheReadRatio: 0.25, cacheWriteRatio: 1 },
  gemini: { inputPerMillion: 0.15, outputPerMillion: 0.6, thinkingPerMillion: 0.6, cacheReadRatio: 0.25, cacheWriteRatio: 1 },
  'claude-opus-5-5': { inputPerMillion: 5, outputPerMillion: 25, thinkingPerMillion: 25, cacheReadRatio: 0.1, cacheWriteRatio: 1.25 },
  'claude-opus': { inputPerMillion: 15, outputPerMillion: 75, thinkingPerMillion: 75, cacheReadRatio: 0.1, cacheWriteRatio: 1.25 },
  'claude-sonnet': { inputPerMillion: 3, outputPerMillion: 15, thinkingPerMillion: 15, cacheReadRatio: 0.1, cacheWriteRatio: 1.25 },
  'claude-haiku': { inputPerMillion: 0.8, outputPerMillion: 4, thinkingPerMillion: 4, cacheReadRatio: 0.1, cacheWriteRatio: 1.25 },
  'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10, thinkingPerMillion: 10, cacheReadRatio: 0.1, cacheWriteRatio: 1 },
  'gpt-4.1': { inputPerMillion: 2, outputPerMillion: 8, thinkingPerMillion: 8, cacheReadRatio: 0.25, cacheWriteRatio: 1 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10, thinkingPerMillion: 10, cacheReadRatio: 0.5, cacheWriteRatio: 1 },
};

export function priceCatalog(env: NodeJS.ProcessEnv = process.env): PriceCatalog {
  const catalog: PriceCatalog = { ...DEFAULT_PRICES };
  const raw = env.AGENT_MODEL_PRICES;
  if (!raw) return catalog;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return catalog;
    for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      catalog[model] = { ...(catalog[model] || {}), ...(value as Partial<ModelPrice>) };
    }
  } catch {
    // A broken override must not stop the call. The built-in rates still apply.
  }
  return catalog;
}

export function priceFor(model: string, catalog: PriceCatalog = priceCatalog()): ModelPrice {
  if (catalog[model]) return { ...DEFAULT_PRICE, ...catalog[model] };
  const prefix = Object.keys(catalog)
    .filter((key) => key !== 'default' && model.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  const match = prefix ? catalog[prefix] : catalog.default;
  return { ...DEFAULT_PRICE, ...match };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** When true, thinkingTokens are already inside outputTokens and are not billed again. */
  thinkingIncludedInOutput: boolean;
}

export interface PricedUsage extends TokenUsage {
  totalTokens: number;
  costUsd: number;
  priceInputPerMillion: number;
  priceOutputPerMillion: number;
  priceThinkingPerMillion: number;
}

function dollars(tokens: number, perMillion: number): number {
  return (tokens / 1_000_000) * perMillion;
}

export function priceUsage(model: string, usage: TokenUsage, catalog?: PriceCatalog): PricedUsage {
  const card = priceFor(model, catalog);
  const thinkingBilled = usage.thinkingIncludedInOutput ? 0 : usage.thinkingTokens;
  const cost =
    dollars(usage.inputTokens, card.inputPerMillion) +
    dollars(usage.cachedInputTokens, card.inputPerMillion * card.cacheReadRatio) +
    dollars(usage.cacheWriteTokens, card.inputPerMillion * card.cacheWriteRatio) +
    dollars(usage.outputTokens, card.outputPerMillion) +
    dollars(thinkingBilled, card.thinkingPerMillion);
  const total =
    usage.inputTokens +
    usage.cachedInputTokens +
    usage.cacheWriteTokens +
    usage.outputTokens +
    thinkingBilled;
  return {
    ...usage,
    totalTokens: total,
    costUsd: Math.round(cost * 1_000_000) / 1_000_000,
    priceInputPerMillion: card.inputPerMillion,
    priceOutputPerMillion: card.outputPerMillion,
    priceThinkingPerMillion: card.thinkingPerMillion,
  };
}

export function formatUsd(value: number): string {
  const amount = Number.isFinite(value) ? value : 0;
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function formatTokens(value: number): string {
  const amount = Number.isFinite(value) ? Math.round(value) : 0;
  return amount.toLocaleString('en-US');
}
