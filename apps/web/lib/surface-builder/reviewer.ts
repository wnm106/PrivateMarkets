/**
 * The Surface Builder's reviewer: the model that reads a prototype (its
 * source, its rendered views and their screenshots) against the catalog.
 * Server only.
 *
 * The model is SURFACE_BUILDER_MODEL, or claude-opus-5-5, with adaptive
 * thinking at SURFACE_BUILDER_EFFORT (default high: the blueprint decides the
 * entity model a developer builds). It streams, so a long blueprint does not
 * hit a request timeout. With no Anthropic key, it falls back to Gemini and
 * says so in the result.
 *
 * Both passes (understand, then blueprint) send the same system prompt and the
 * same prototype first, marked for caching, so the second pass reads the
 * prototype from the cache.
 */
import Anthropic from '@anthropic-ai/sdk';
import { invokeAgent, type AgentAudit } from '@tapestrai/mcp-server/src/agent/harness';
import { geminiAnswerText } from '@tapestrai/mcp-server/src/agent/usage';
import { anthropicKey } from '@/lib/anthropic-key';

export type ReviewPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: 'image/jpeg' | 'image/png' };

export interface ReviewCall {
  system: string;
  /** Shared by both passes; cached. */
  shared: ReviewPart[];
  /** What this pass asks for. */
  ask: string;
  maxTokens: number;
  /** Whether the reply is JSON (the default). A redesign replies with HTML. */
  json?: boolean;
  activity: string;
  userId: string;
  clientId: string | null;
  subject: { type: string; id: string; label: string };
  metadata: Record<string, unknown>;
}

export interface ReviewResult {
  text: string;
  provider: 'claude' | 'gemini';
  model: string;
  audit: AgentAudit;
  /** Why the reply may be incomplete, when it is. */
  stopped?: 'max_tokens' | 'refusal';
}

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function effort(): Effort {
  const value = (process.env.SURFACE_BUILDER_EFFORT || 'high').toLowerCase() as Effort;
  return EFFORTS.includes(value) ? value : 'high';
}

function geminiKey(): string {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
}

/** Which reviewer will run, or null when no model key is configured. */
export function reviewerAvailable(): { provider: 'claude' | 'gemini'; model: string } | null {
  if (anthropicKey()) return { provider: 'claude', model: process.env.SURFACE_BUILDER_MODEL || 'claude-opus-5-5' };
  if (geminiKey()) return { provider: 'gemini', model: process.env.SURFACE_BUILDER_GEMINI_MODEL || 'gemini-3.8-flash' };
  return null;
}

/** What a person should do about a model error, in one sentence. */
function explain(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) return new Error('The Anthropic key was rejected. Check ANTHROPIC_API_KEY.');
  if (error instanceof Anthropic.PermissionDeniedError) return new Error(`This Anthropic key cannot use the model. ${error.message}`);
  if (error instanceof Anthropic.RateLimitError) return new Error('The model is rate limited right now. Try again in a few minutes.');
  if (error instanceof Anthropic.BadRequestError) return new Error(`The model rejected the request. ${error.message}`);
  if (error instanceof Anthropic.APIConnectionError) return new Error('The model could not be reached. Try again.');
  if (error instanceof Anthropic.APIError) return new Error(`The model returned an error (${error.status ?? 'no status'}). ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

async function reviewWithClaude(call: ReviewCall, model: string): Promise<ReviewResult> {
  const client = new Anthropic({ apiKey: anthropicKey() });
  const shared: Anthropic.Beta.BetaContentBlockParam[] = call.shared.map((part) => (part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }));
  // The cache breakpoint sits on the last shared block, so the pass-specific
  // ask after it does not change the cached prefix.
  const last = shared[shared.length - 1];
  if (last && (last.type === 'text' || last.type === 'image')) last.cache_control = { type: 'ephemeral', ttl: '1h' };

  const { response, audit } = await invokeAgent<Anthropic.Beta.BetaMessage>({
    provider: 'claude',
    model,
    feature: 'surface-builder',
    activity: call.activity,
    agent: 'surface-architect',
    userId: call.userId,
    clientId: call.clientId,
    subject: call.subject,
    metadata: { ...call.metadata, effort: effort() },
    execute: async () => {
      try {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: call.maxTokens,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          thinking: { type: 'adaptive' },
          output_config: { effort: effort() },
          system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
          messages: [{ role: 'user', content: [...shared, { type: 'text', text: call.ask }] }],
        });
        return await stream.finalMessage();
      } catch (error) {
        throw explain(error);
      }
    },
  });
  const text = response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const stopped = response.stop_reason === 'max_tokens' ? 'max_tokens' : response.stop_reason === 'refusal' ? 'refusal' : undefined;
  return { text, provider: 'claude', model: response.model || model, audit, stopped };
}

async function reviewWithGemini(call: ReviewCall, model: string): Promise<ReviewResult> {
  const parts = [
    ...call.shared.map((part) => (part.type === 'text' ? { text: part.text } : { inlineData: { mimeType: part.mediaType, data: part.data } })),
    { text: call.ask },
  ];
  const { response, audit } = await invokeAgent({
    provider: 'gemini',
    model,
    feature: 'surface-builder',
    activity: call.activity,
    agent: 'surface-architect',
    userId: call.userId,
    clientId: call.clientId,
    subject: call.subject,
    metadata: call.metadata,
    apiKey: geminiKey(),
    body: {
      systemInstruction: { parts: [{ text: call.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2, maxOutputTokens: Math.min(call.maxTokens, 65536), ...(call.json === false ? {} : { responseMimeType: 'application/json' }), thinkingConfig: { thinkingBudget: 8192 } },
    },
  });
  const finish = (response as { candidates?: Array<{ finishReason?: string }> } | null)?.candidates?.[0]?.finishReason;
  return { text: geminiAnswerText(response), provider: 'gemini', model, audit, stopped: finish === 'MAX_TOKENS' ? 'max_tokens' : undefined };
}

export async function review(call: ReviewCall): Promise<ReviewResult> {
  const reviewer = reviewerAvailable();
  if (!reviewer) throw new Error('No model key is configured.');
  return reviewer.provider === 'claude' ? reviewWithClaude(call, reviewer.model) : reviewWithGemini(call, reviewer.model);
}

/** The JSON object in a model reply, with or without a code fence around it. */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    const body = fenced ? fenced[1] : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
    try {
      return body ? JSON.parse(body) : null;
    } catch {
      return null;
    }
  }
}
