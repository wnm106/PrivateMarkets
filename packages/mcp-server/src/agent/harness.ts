/**
 * The one door every model call goes through.
 *
 * A caller names the provider, the model, and the feature that asked. The
 * harness makes the call (or runs a caller-supplied request, for the Claude
 * SDK), reads the token counts and the thinking text, prices the call, and
 * writes an audit row for the client the call was made for. The caller gets
 * the provider response and a receipt it can hand back to its own client.
 *
 * Call sites that already know the user and the client pass them. Nested work
 * (a tool that itself calls a model) inherits them from the surrounding
 * context, and adds its own feature.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { geminiKey } from '../feeds/model';
import { priceUsage, type PriceCatalog, type PricedUsage } from './pricing';
import { extractUsage, redactSecrets } from './usage';

export type AgentProvider = 'gemini' | 'claude' | 'openai';

export interface AgentContext {
  userId?: string | null;
  clientId?: string | null;
  feature: string;
  activity?: string;
  agent?: string | null;
  metadata?: Record<string, unknown>;
}

interface AgentStore extends Required<Pick<AgentContext, 'feature'>> {
  userId: string | null;
  clientId: string | null;
  activity: string;
  agent: string | null;
  metadata: Record<string, unknown>;
  audits: AgentAudit[];
  parent?: AgentStore;
}

const storage = new AsyncLocalStorage<AgentStore>();

export function currentAgentContext(): AgentContext | undefined {
  const store = storage.getStore();
  if (!store) return undefined;
  return {
    userId: store.userId,
    clientId: store.clientId,
    feature: store.feature,
    activity: store.activity,
    agent: store.agent,
    metadata: store.metadata,
  };
}

/** The receipts recorded in the current context, oldest first. */
export function takeAgentAudits(): AgentAudit[] {
  return storage.getStore()?.audits ?? [];
}

function agentStore(context: AgentContext): AgentStore {
  const parent = storage.getStore();
  return {
    userId: context.userId !== undefined ? context.userId : parent?.userId ?? null,
    clientId: context.clientId !== undefined ? context.clientId : parent?.clientId ?? null,
    feature: context.feature || parent?.feature || 'unspecified',
    activity: context.activity || parent?.activity || context.feature || parent?.feature || 'unspecified',
    agent: context.agent !== undefined ? context.agent : parent?.agent ?? null,
    metadata: { ...(parent?.metadata ?? {}), ...(context.metadata ?? {}) },
    audits: [],
    parent,
  };
}

export function runWithAgentContext<T>(context: AgentContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(agentStore(context), fn);
}

/** Applies to the rest of this request, so a tool that calls a model keeps the caller's user and client. */
export function bindAgentContext(context: AgentContext): void {
  storage.enterWith(agentStore(context));
}

/**
 * Runs fn as a feed or import for a client. A surrounding context keeps its
 * user. A signed-in client is asked who it is when nobody has said.
 */
export async function userIdOf(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

export async function runAsFeedClient<T>(
  args: { clientId: string; activity: string; metadata?: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  const userId = currentAgentContext()?.userId ?? null;
  return runWithAgentContext(
    {
      userId,
      clientId: args.clientId,
      feature: 'feed-intake',
      activity: args.activity,
      metadata: args.metadata,
    },
    fn,
  );
}

/** Names the signed-in user on the calls fn makes. A surrounding context keeps its user when this client has none. */
export async function withSupabaseCaller<T>(
  supabase: SupabaseClient,
  clientId: string,
  fields: Omit<AgentContext, 'userId' | 'clientId'>,
  fn: () => Promise<T>,
): Promise<T> {
  const ambient = currentAgentContext();
  const userId = ambient?.userId ?? (await userIdOf(supabase));
  return runWithAgentContext({ ...fields, userId, clientId }, fn);
}

export interface AgentAudit {
  id: string | null;
  provider: AgentProvider | string;
  model: string;
  feature: string;
  activity: string;
  agent: string | null;
  userId: string | null;
  clientId: string | null;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  thinking: string;
  status: 'ok' | 'error';
  error: string | null;
  latencyMs: number;
  persisted: boolean;
}

/** What a caller returns to its own client: the calls just made, and what they cost. */
export interface ClientUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  costUsd: number;
  audits: Array<Omit<AgentAudit, 'persisted' | 'cacheWriteTokens' | 'cachedInputTokens'> & { thinkingTruncated: boolean }>;
}

const CLIENT_THINKING_LIMIT = 8_000;

export function usageForClient(audits: readonly AgentAudit[]): ClientUsage {
  const totals = audits.reduce(
    (acc, audit) => ({
      calls: acc.calls + 1,
      inputTokens: acc.inputTokens + audit.inputTokens,
      outputTokens: acc.outputTokens + audit.outputTokens,
      thinkingTokens: acc.thinkingTokens + audit.thinkingTokens,
      totalTokens: acc.totalTokens + audit.totalTokens,
      costUsd: acc.costUsd + audit.costUsd,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, costUsd: 0 },
  );
  return {
    ...totals,
    costUsd: Math.round(totals.costUsd * 1_000_000) / 1_000_000,
    audits: audits.map((audit) => {
      const thinkingTruncated = audit.thinking.length > CLIENT_THINKING_LIMIT;
      return {
        id: audit.id,
        provider: audit.provider,
        model: audit.model,
        feature: audit.feature,
        activity: audit.activity,
        agent: audit.agent,
        userId: audit.userId,
        clientId: audit.clientId,
        inputTokens: audit.inputTokens,
        outputTokens: audit.outputTokens,
        thinkingTokens: audit.thinkingTokens,
        totalTokens: audit.totalTokens,
        costUsd: audit.costUsd,
        thinking: thinkingTruncated ? `${audit.thinking.slice(0, CLIENT_THINKING_LIMIT)}\n[thinking truncated]` : audit.thinking,
        thinkingTruncated,
        status: audit.status,
        error: audit.error,
        latencyMs: audit.latencyMs,
      };
    }),
  };
}

export interface AuditSink {
  record(row: AuditRow): Promise<string | null>;
}

export interface AuditRow {
  userId: string | null;
  clientId: string | null;
  feature: string;
  activity: string;
  agent: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  priceInputPerMillion: number;
  priceOutputPerMillion: number;
  priceThinkingPerMillion: number;
  thinking: string;
  status: 'ok' | 'error';
  error: string | null;
  latencyMs: number;
  metadata: Record<string, unknown>;
}

let sinkOverride: AuditSink | null = null;
let service: SupabaseClient | null | undefined;

/** Tests record into their own sink. Pass null to restore the database sink. */
export function setAgentAuditSink(sink: AuditSink | null): void {
  sinkOverride = sink;
}

function serviceClient(): SupabaseClient | null {
  if (service !== undefined) return service;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  service = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  return service;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

async function databaseRecord(row: AuditRow, supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.rpc('record_agent_call', {
    p_client_id: row.clientId,
    p_user_id: row.userId,
    p_feature: clip(row.feature, 120),
    p_activity: clip(row.activity, 120),
    p_agent: row.agent ? clip(row.agent, 200) : null,
    p_provider: clip(row.provider, 40),
    p_model: clip(row.model, 120),
    p_input_tokens: row.inputTokens,
    p_output_tokens: row.outputTokens,
    p_thinking_tokens: row.thinkingTokens,
    p_cached_input_tokens: row.cachedInputTokens,
    p_cache_write_tokens: row.cacheWriteTokens,
    p_total_tokens: row.totalTokens,
    p_cost_usd: row.costUsd,
    p_price_input_per_million: row.priceInputPerMillion,
    p_price_output_per_million: row.priceOutputPerMillion,
    p_price_thinking_per_million: row.priceThinkingPerMillion,
    p_thinking: row.thinking || null,
    p_status: row.status,
    p_error: row.error ? clip(row.error, 2000) : null,
    p_latency_ms: row.latencyMs,
    p_metadata: row.metadata,
  });
  if (error) throw new Error(error.message);
  return typeof data === 'string' ? data : null;
}

async function persist(row: AuditRow, supabase?: SupabaseClient): Promise<{ id: string | null; persisted: boolean }> {
  // Unit tests must not try the database. A test that wants a row sets a sink.
  if (!sinkOverride && process.env.VITEST && process.env.AGENT_AUDIT_TEST_DB !== '1') {
    return { id: null, persisted: false };
  }
  try {
    if (sinkOverride) return { id: await sinkOverride.record(row), persisted: true };
    const client = supabase ?? serviceClient();
    if (!client) return { id: null, persisted: false };
    return { id: await databaseRecord(row, client), persisted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!process.env.VITEST) console.error(`[agent-audit] ${message}`);
    return { id: null, persisted: false };
  }
}

function remember(audit: AgentAudit): void {
  let store = storage.getStore();
  while (store) {
    store.audits.push(audit);
    store = store.parent;
  }
}

function logAudit(audit: AgentAudit): void {
  if (process.env.VITEST) return;
  console.info(
    JSON.stringify({
      audit: 'agent_call',
      id: audit.id,
      clientId: audit.clientId,
      userId: audit.userId,
      feature: audit.feature,
      activity: audit.activity,
      agent: audit.agent,
      provider: audit.provider,
      model: audit.model,
      inputTokens: audit.inputTokens,
      outputTokens: audit.outputTokens,
      thinkingTokens: audit.thinkingTokens,
      totalTokens: audit.totalTokens,
      costUsd: audit.costUsd,
      status: audit.status,
      latencyMs: audit.latencyMs,
      persisted: audit.persisted,
    }),
  );
}

export interface AgentCall {
  provider: AgentProvider;
  model: string;
  feature?: string;
  activity?: string;
  agent?: string | null;
  userId?: string | null;
  clientId?: string | null;
  metadata?: Record<string, unknown>;
  /** Provider request body. Gemini generateContent, or OpenAI chat completions. */
  body?: unknown;
  /** Used instead of the environment key. Tests pass a stand-in. */
  apiKey?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** A caller that already speaks the provider's SDK. The harness still audits the result. */
  execute?: () => Promise<unknown>;
  /** Writes the audit with this client instead of the service-role client. */
  supabase?: SupabaseClient;
  catalog?: PriceCatalog;
}

export interface AgentCallResult<T> {
  response: T;
  audit: AgentAudit;
}

function resolved(call: AgentCall): {
  userId: string | null;
  clientId: string | null;
  feature: string;
  activity: string;
  agent: string | null;
  metadata: Record<string, unknown>;
} {
  const ambient = storage.getStore();
  return {
    userId: call.userId !== undefined ? call.userId : ambient?.userId ?? null,
    clientId: call.clientId !== undefined ? call.clientId : ambient?.clientId ?? null,
    feature: call.feature || ambient?.feature || 'unspecified',
    activity: call.activity || ambient?.activity || call.feature || ambient?.feature || 'unspecified',
    agent: call.agent !== undefined ? call.agent : ambient?.agent ?? null,
    metadata: { ...(ambient?.metadata ?? {}), ...(call.metadata ?? {}), requestedModel: call.model },
  };
}

async function providerFetch(url: string, apiKeyHeader: Record<string, string>, body: unknown, signal: AbortSignal | undefined, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiKeyHeader },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  const readable = response as Response & { text?: () => Promise<string>; json?: () => Promise<unknown> };
  if (typeof readable.text === 'function') {
    const raw = await readable.text();
    if (!response.ok) throw new Error(`The model returned an error (${response.status}). ${redactSecrets(raw).slice(0, 500)}`);
    return raw ? JSON.parse(raw) : {};
  }
  if (!response.ok) throw new Error(`The model returned an error (${response.status}).`);
  if (typeof readable.json === 'function') return readable.json();
  throw new Error('The model returned an unreadable response.');
}

async function defaultExecute(call: AgentCall): Promise<unknown> {
  const fetchImpl = call.fetchImpl ?? fetch;
  if (call.provider === 'gemini') {
    const key = call.apiKey ?? geminiKey();
    // A test transport does not need a live key. A real request does.
    if (!key && call.fetchImpl === undefined) throw new Error('No Gemini key is set.');
    return providerFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(call.model)}:generateContent`,
      key ? { 'x-goog-api-key': key } : {},
      call.body,
      call.signal,
      fetchImpl,
    );
  }
  if (call.provider === 'openai') {
    const key = call.apiKey || process.env.OPENAI_API_KEY || '';
    if (!key) throw new Error('No OpenAI key is set.');
    const body = call.body && typeof call.body === 'object' ? { ...(call.body as Record<string, unknown>), model: call.model } : { model: call.model };
    return providerFetch('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${key}` }, body, call.signal, fetchImpl);
  }
  const key = call.apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!key) throw new Error('No Anthropic key is set.');
  const body = call.body && typeof call.body === 'object' ? { ...(call.body as Record<string, unknown>), model: call.model } : { model: call.model };
  return providerFetch(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body,
    call.signal,
    fetchImpl,
  );
}

function metadataOf(metadata: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = JSON.stringify(metadata);
    if (json.length <= 8_000) return metadata;
  } catch {
    return { note: 'metadata could not be stored' };
  }
  return { note: 'metadata truncated', requestedModel: metadata.requestedModel ?? null };
}

function auditFrom(args: {
  context: ReturnType<typeof resolved>;
  provider: string;
  model: string;
  priced: PricedUsage;
  thinking: string;
  status: 'ok' | 'error';
  error: string | null;
  latencyMs: number;
  id: string | null;
  persisted: boolean;
}): AgentAudit {
  return {
    id: args.id,
    provider: args.provider,
    model: args.model,
    feature: args.context.feature,
    activity: args.context.activity,
    agent: args.context.agent,
    userId: args.context.userId,
    clientId: args.context.clientId,
    inputTokens: args.priced.inputTokens,
    outputTokens: args.priced.outputTokens,
    thinkingTokens: args.priced.thinkingTokens,
    cachedInputTokens: args.priced.cachedInputTokens,
    cacheWriteTokens: args.priced.cacheWriteTokens,
    totalTokens: args.priced.totalTokens,
    costUsd: args.priced.costUsd,
    thinking: args.thinking,
    status: args.status,
    error: args.error,
    latencyMs: args.latencyMs,
    persisted: args.persisted,
  };
}

/**
 * Makes one model call and audits it.
 * A failed call is audited too, then the error is raised for the caller.
 */
export async function invokeAgent<T = unknown>(call: AgentCall): Promise<AgentCallResult<T>> {
  const context = resolved(call);
  const started = performance.now();
  const finish = async (args: { response: unknown; status: 'ok' | 'error'; error: string | null }): Promise<AgentAudit> => {
    const extracted = args.response == null ? null : extractUsage(call.provider, args.response);
    const model = extracted?.model || call.model;
    const priced = priceUsage(
      model,
      extracted?.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        thinkingIncludedInOutput: true,
      },
      call.catalog,
    );
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    const row: AuditRow = {
      ...context,
      provider: call.provider,
      model,
      inputTokens: priced.inputTokens,
      outputTokens: priced.outputTokens,
      thinkingTokens: priced.thinkingTokens,
      cachedInputTokens: priced.cachedInputTokens,
      cacheWriteTokens: priced.cacheWriteTokens,
      totalTokens: priced.totalTokens,
      costUsd: priced.costUsd,
      priceInputPerMillion: priced.priceInputPerMillion,
      priceOutputPerMillion: priced.priceOutputPerMillion,
      priceThinkingPerMillion: priced.priceThinkingPerMillion,
      thinking: extracted?.thinking ?? '',
      status: args.status,
      error: args.error,
      latencyMs,
      metadata: metadataOf(context.metadata),
    };
    const saved = await persist(row, call.supabase);
    const audit = auditFrom({
      context,
      provider: call.provider,
      model,
      priced,
      thinking: row.thinking,
      status: args.status,
      error: args.error,
      latencyMs,
      id: saved.id,
      persisted: saved.persisted,
    });
    remember(audit);
    logAudit(audit);
    return audit;
  };

  try {
    const response = call.execute ? await call.execute() : await defaultExecute(call);
    const audit = await finish({ response, status: 'ok', error: null });
    return { response: response as T, audit };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    await finish({ response: null, status: 'error', error: message });
    throw error;
  }
}
