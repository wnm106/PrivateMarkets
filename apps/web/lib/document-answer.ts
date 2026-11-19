import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { invokeAgent } from '@tapestrai/mcp-server/src/agent/harness';
import type { AnswerModel, AnswerToolResult, AnswerToolSpec } from '@tapestrai/graphql/src/lib/document-content/answer';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Claude as the model that answers a question about documents.
 *
 * The model is DOCUMENT_ANSWER_MODEL, or the describer's model, or
 * claude-opus-5-5. Each turn is recorded in agent usage as document.answer.
 * Returns null when no Anthropic key is set, and the question is answered
 * from the passages alone.
 *
 * The worker reads ANTHROPIC_API_KEY from the repository .env. Next does not
 * load that file, so a key that is only there is read once and kept.
 */

let repoKey: string | null = null;

function keyIn(text: string): string {
  const match = text.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/m);
  if (!match) return '';
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value.trim();
}

function anthropicKey(): string {
  const current = (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '').trim();
  if (current) return current;
  if (repoKey !== null) return repoKey;
  repoKey = '';
  for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env'), resolve(process.cwd(), '../../.env')]) {
    try {
      const value = keyIn(readFileSync(path, 'utf8'));
      if (value) {
        repoKey = value;
        break;
      }
    } catch {
      // This candidate is not the repository env file.
    }
  }
  return repoKey;
}

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
