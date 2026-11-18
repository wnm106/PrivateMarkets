/**
 * Turns a provider response into token counts and the thinking text.
 *
 * Gemini bills thinking apart from the answer. Claude and OpenAI include it
 * in the output count, so those thinking tokens are kept for the audit and
 * are not added to the cost a second time.
 */

import type { TokenUsage } from './pricing';

const THINKING_LIMIT = 200_000;

export interface ExtractedUsage {
  usage: TokenUsage;
  /** The model that actually answered, when the provider names it. */
  model: string | null;
  thinking: string;
}

function whole(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function capThinking(parts: string[]): string {
  const joined = parts.map((part) => part.trim()).filter(Boolean).join('\n\n');
  if (joined.length <= THINKING_LIMIT) return joined;
  return `${joined.slice(0, THINKING_LIMIT)}\n[thinking truncated]`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function gemini(data: Record<string, unknown>): ExtractedUsage {
  const meta = record(data.usageMetadata ?? data.usage_metadata);
  const prompt = whole(meta.promptTokenCount ?? meta.prompt_token_count);
  const cached = Math.min(prompt, whole(meta.cachedContentTokenCount ?? meta.cached_content_token_count));
  const output = whole(meta.candidatesTokenCount ?? meta.candidates_token_count);
  const thinkingTokens = whole(meta.thoughtsTokenCount ?? meta.thoughts_token_count);
  const parts = geminiParts(data);
  const thinking = capThinking(
    parts.flatMap((part) => {
      if (part.thought === true) return [text(part.text)];
      if (typeof part.thought === 'string') return [part.thought];
      return [];
    }),
  );
  return {
    model: text(data.modelVersion ?? data.model) || null,
    thinking,
    usage: {
      inputTokens: Math.max(0, prompt - cached),
      outputTokens: output,
      thinkingTokens,
      cachedInputTokens: cached,
      cacheWriteTokens: 0,
      thinkingIncludedInOutput: false,
    },
  };
}

function geminiParts(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const content = record(record(candidates[0]).content);
  return Array.isArray(content.parts) ? content.parts.map(record) : [];
}

/** The answer text, leaving thinking parts for the audit log. */
export function geminiAnswerText(data: unknown): string {
  return geminiParts(record(data))
    .filter((part) => part.thought !== true && typeof part.thought !== 'string')
    .map((part) => text(part.text))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function claude(data: Record<string, unknown>): ExtractedUsage {
  const usage = record(data.usage);
  const blocks = Array.isArray(data.content) ? data.content.map(record) : [];
  const thinking = capThinking(
    blocks.flatMap((block) => {
      if (block.type === 'thinking') return [text(block.thinking)];
      if (block.type === 'redacted_thinking') return ['[redacted thinking]'];
      return [];
    }),
  );
  const reportedThinking = whole(usage.thinking_tokens ?? usage.thinkingTokens);
  return {
    model: text(data.model) || null,
    thinking,
    usage: {
      inputTokens: whole(usage.input_tokens ?? usage.inputTokens),
      outputTokens: whole(usage.output_tokens ?? usage.outputTokens),
      thinkingTokens: reportedThinking,
      cachedInputTokens: whole(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
      cacheWriteTokens: whole(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
      // Claude counts thinking inside output tokens.
      thinkingIncludedInOutput: true,
    },
  };
}

function openai(data: Record<string, unknown>): ExtractedUsage {
  const usage = record(data.usage);
  const promptDetails = record(usage.prompt_tokens_details);
  const completionDetails = record(usage.completion_tokens_details);
  const prompt = whole(usage.prompt_tokens ?? usage.input_tokens);
  const cached = Math.min(prompt, whole(promptDetails.cached_tokens));
  const choices = Array.isArray(data.choices) ? data.choices.map(record) : [];
  const message = record(choices[0]?.message);
  const outputItems = Array.isArray(data.output) ? data.output.map(record) : [];
  const thinking = capThinking([
    text(message.reasoning_content ?? message.reasoning),
    ...outputItems.filter((item) => item.type === 'reasoning').map((item) => text(item.summary ?? item.content ?? item.text)),
  ]);
  return {
    model: text(data.model) || null,
    thinking,
    usage: {
      inputTokens: Math.max(0, prompt - cached),
      outputTokens: whole(usage.completion_tokens ?? usage.output_tokens),
      thinkingTokens: whole(completionDetails.reasoning_tokens),
      cachedInputTokens: cached,
      cacheWriteTokens: 0,
      thinkingIncludedInOutput: true,
    },
  };
}

export function extractUsage(provider: string, data: unknown): ExtractedUsage {
  const body = record(data);
  if (provider === 'claude') return claude(body);
  if (provider === 'openai') return openai(body);
  return gemini(body);
}

export function redactSecrets(value: string): string {
  return value
    .replace(/key=[^&\s"]+/gi, 'key')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, 'AIza…');
}
