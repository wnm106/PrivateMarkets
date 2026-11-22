import Anthropic from '@anthropic-ai/sdk';
import { invokeAgent } from '@tapestrai/mcp-server/src/agent/harness';
import type { AgentModel, ModelToolCall, ModelTurn } from './agent';

/**
 * Claude as the model behind an agent step.
 *
 * The model is WORKFLOW_AGENT_MODEL, or claude-opus-5-5. Thinking is adaptive,
 * and WORKFLOW_AGENT_EFFORT sets its depth (default high: these steps decide
 * what a person is asked to approve).
 *
 * When the model declines a request, the API re-runs it on a fallback model
 * (fallbacks: "default") rather than failing the step.
 */

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function effort(): Effort {
  const value = (process.env.WORKFLOW_AGENT_EFFORT || 'high').toLowerCase() as Effort;
  return EFFORTS.includes(value) ? value : 'high';
}

/** What a person reading the failed step should do about a model error. */
export function explain(error: unknown): Error {
  // The SDK says this, as a plain Error, before sending anything when no key is set.
  if (error instanceof Error && !(error instanceof Anthropic.APIError) && /could not resolve authentication method/i.test(error.message)) {
    return new Error('No Anthropic key is set where the worker runs. Set ANTHROPIC_API_KEY for the worker, then retry the run: it continues from this step.');
  }
  if (error instanceof Anthropic.AuthenticationError) return new Error('The Anthropic key was rejected. Check ANTHROPIC_API_KEY for the worker.');
  if (error instanceof Anthropic.PermissionDeniedError) return new Error(`This Anthropic key cannot use the model. ${error.message}`);
  if (error instanceof Anthropic.RateLimitError) return new Error('The model is rate limited right now. Retry the run in a few minutes.');
  if (error instanceof Anthropic.BadRequestError) return new Error(`The model rejected the request. ${error.message}`);
  if (error instanceof Anthropic.APIConnectionError) return new Error('The model could not be reached. Retry the run.');
  if (error instanceof Anthropic.APIError) return new Error(`The model returned an error (${error.status ?? 'no status'}). ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

export function claudeModel(client: Anthropic = new Anthropic()): AgentModel {
  const model = process.env.WORKFLOW_AGENT_MODEL || 'claude-opus-5-5';
  return {
    provider: 'claude',
    model,
    userMessage: (text): Anthropic.Beta.BetaMessageParam => ({ role: 'user', content: text }),
    // Every result of one turn goes back in a single message.
    resultMessage: (results): Anthropic.Beta.BetaMessageParam => ({
      role: 'user',
      content: results.map(
        (result): Anthropic.Beta.BetaToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: result.call.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        }),
      ),
    }),
    async turn(system, tools, messages): Promise<ModelTurn> {
      const { response } = await invokeAgent<Anthropic.Beta.BetaMessage>({
        provider: 'claude',
        model,
        feature: 'workflow',
        activity: 'workflow.agent',
        execute: async () => {
          try {
            return await client.beta.messages.create({
              model,
              max_tokens: 16000,
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default',
              thinking: { type: 'adaptive' },
              output_config: { effort: effort() },
              // Caches the prompt up to the newest message, so each round only pays for what is new.
              cache_control: { type: 'ephemeral' },
              system,
              ...(tools.length > 0
                ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema })) }
                : {}),
              messages: messages as Anthropic.Beta.BetaMessageParam[],
            });
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
      const calls: ModelToolCall[] = response.content
        .filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? (block.input as Record<string, unknown>) : {},
        }));

      const stop: ModelTurn['stop'] =
        response.stop_reason === 'refusal'
          ? 'refused'
          : response.stop_reason === 'max_tokens'
            ? 'limit'
            : response.stop_reason === 'pause_turn'
              ? 'pause'
              : calls.length > 0
                ? 'tools'
                : 'end';
      return {
        // The whole content goes back next round, thinking blocks included, unchanged.
        message: { role: 'assistant', content: response.content },
        text,
        // A turn cut off by the token limit may hold a half-written tool call. It is not run.
        calls: stop === 'limit' ? [] : calls,
        stop,
        ...(stop === 'refused' && response.stop_details?.explanation ? { refusal: response.stop_details.explanation } : {}),
      };
    },
  };
}
