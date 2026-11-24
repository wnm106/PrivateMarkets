import { invokeAgent } from '@tapestrai/mcp-server/src/agent/harness';
import type { AnswerModel, AnswerToolResult, AnswerToolSpec } from '@tapestrai/graphql/src/lib/document-content/answer';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anthropicKey } from '@/lib/anthropic-key';

/**
 * Claude as the model that answers a question about documents.
 *
 * The model is DOCUMENT_ANSWER_MODEL, or the describer's model, or
 * claude-opus-5-5. Each turn is recorded in agent usage as document.answer.
 * Returns null when no Anthropic key is set, and the question is answered
 * from the passages alone. The key comes from lib/anthropic-key.ts.
 */

export function documentAnswerModel(supabase: SupabaseClient): AnswerModel | null {
  const key = anthropicKey();
  if (!key) return null;
  const model = (process.env.DOCUMENT_ANSWER_MODEL || process.env.DOCUMENT_REFINE_MODEL || 'claude-opus-5-5').trim();
  return {
    userMessage: (text) => ({ role: 'user', content: text }),
    resultMessage: (results: AnswerToolResult[]) => ({
      role: 'user',
      content: results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.call.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      })),
    }),
    async turn(system, tools, messages, requireAnswer) {
      const { response } = await invokeAgent<{ content?: Array<Record<string, unknown>> }>({
        provider: 'claude',
        model,
        feature: 'documents',
        activity: 'document.answer',
        agent: 'reader',
        apiKey: key,
        supabase,
        body: {
          max_tokens: 1500,
          system,
          tools: tools.map((tool: AnswerToolSpec) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
          tool_choice: requireAnswer ? { type: 'tool', name: 'answer' } : { type: 'auto' },
          messages,
        },
      });
      const content = Array.isArray(response.content) ? response.content : [];
      const text = content
        .filter((block) => block.type === 'text')
        .map((block) => String(block.text || ''))
        .join('\n')
        .trim();
      const calls = content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({
          id: String(block.id || ''),
          name: String(block.name || ''),
          input: block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input as Record<string, unknown> : {},
        }))
        .filter((call) => call.id && call.name);
      return { message: { role: 'assistant', content }, text, calls };
    },
  };
}
