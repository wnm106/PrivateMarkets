/**
 * The Claude side of the chat route, for skills that name a Claude model
 * (SkillDef.model): dashboard and narrative design. Server only.
 *
 * The route keeps one tool loop. This module turns the stored thread into
 * Messages API input, makes one audited, streamed call per round, and reads the
 * answer text. Thinking and tool_use blocks are sent back exactly as returned,
 * so each round continues the model's own reasoning.
 */
import Anthropic from '@anthropic-ai/sdk';
import { invokeAgent, type AgentAudit } from '@tapestrai/mcp-server/src/agent/harness';
import type { SkillModel } from '@tapestrai/mcp-server/src/lib/chat-skills';
import { anthropicKey } from '@/lib/anthropic-key';

type Effort = SkillModel['effort'];
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ClaudeChoice {
  model: string;
  effort: Effort;
}

/** The Claude model a skill runs on, or null when it names none or no Anthropic key is set. */
export function claudeFor(model: SkillModel | undefined): ClaudeChoice | null {
  if (!model || model.provider !== 'claude' || !anthropicKey()) return null;
  const override = (process.env.CHAT_DESIGN_EFFORT || '').toLowerCase() as Effort;
  return {
    model: process.env.CHAT_DESIGN_MODEL || model.model,
    effort: EFFORTS.includes(override) ? override : model.effort,
  };
}

/** Stored turns plus this turn's files, as Messages API input. */
export function toClaudeMessages(
  turns: Array<{ role: string; content?: string; text?: string }>,
  attachmentParts: any[],
): Anthropic.Beta.BetaMessageParam[] {
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const turn of turns) {
    const text = (turn.content ?? turn.text ?? '').trim();
    if (!text) continue;
    const role = turn.role === 'user' ? 'user' : 'assistant';
    // The first turn must be the user's.
    if (!messages.length && role !== 'user') continue;
    messages.push({ role, content: [{ type: 'text', text }] });
  }
  if (!messages.length) messages.push({ role: 'user', content: [{ type: 'text', text: '(no message)' }] });

  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  if (lastUser && attachmentParts.length && Array.isArray(lastUser.content)) {
    for (const part of attachmentParts) {
      if (part?.inlineData?.data) {
        const mediaType = String(part.inlineData.mimeType || '');
        if (mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/gif' || mediaType === 'image/webp') {
          lastUser.content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: part.inlineData.data } });
        }
      } else if (typeof part?.text === 'string' && part.text.trim()) {
        lastUser.content.push({ type: 'text', text: part.text });
      }
    }
  }
  return messages;
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

export interface ClaudeRound {
  choice: ClaudeChoice;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
  /** The last round may not call tools, so the model must answer. */
  allowTools: boolean;
}

export async function callClaude(
  round: ClaudeRound,
  scope: { userId: string | null; clientId: string | null; agent: string | null; conversationId: string | null; metadata?: Record<string, unknown> },
  audits: AgentAudit[],
): Promise<Anthropic.Beta.BetaMessage> {
  const client = new Anthropic({ apiKey: anthropicKey() });
  const tools = round.tools.map((tool, index) => (
    // The tool list is stable within a phase, so it is cached with the system prompt.
    index === round.tools.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' as const } } : tool
  ));
  const { response, audit } = await invokeAgent<Anthropic.Beta.BetaMessage>({
    provider: 'claude',
    model: round.choice.model,
    feature: 'chat',
    activity: 'chat.turn',
    agent: scope.agent,
    userId: scope.userId,
    clientId: scope.clientId,
    conversationId: scope.conversationId,
    metadata: { ...scope.metadata, effort: round.choice.effort },
    execute: async () => {
      try {
        const stream = client.beta.messages.stream({
          model: round.choice.model,
          max_tokens: 64000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          thinking: { type: 'adaptive' },
          output_config: { effort: round.choice.effort },
          system: [{ type: 'text', text: round.system, cache_control: { type: 'ephemeral' } }],
          messages: round.messages,
          ...(tools.length ? { tools, tool_choice: { type: round.allowTools ? 'auto' : 'none' } as const } : {}),
        });
        return await stream.finalMessage();
      } catch (error) {
        throw explain(error);
      }
    },
  });
  audits.push(audit);
  return response;
}

/** The visible answer: the text blocks, or why there is none. */
export function claudeAnswerText(response: Anthropic.Beta.BetaMessage): string {
  const text = response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (response.stop_reason === 'refusal') return text || 'I cannot help with that request.';
  return text;
}

export function claudeToolCalls(response: Anthropic.Beta.BetaMessage): Anthropic.Beta.BetaToolUseBlock[] {
  return response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use');
}
