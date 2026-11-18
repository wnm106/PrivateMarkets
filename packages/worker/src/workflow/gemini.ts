import { invokeAgent } from '@tapestrai/mcp-server/src/agent/harness';
import { geminiAnswerText } from '@tapestrai/mcp-server/src/agent/usage';
import { GEMINI_MODEL } from '@tapestrai/mcp-server/src/feeds/model';
import type { AgentModel, ModelToolCall, ModelTurn } from './agent';

/**
 * Gemini as the model behind an agent step, for a workflow whose agent step
 * sets provider "gemini". It uses the same model and key as the chat assistant.
 */

type Part = Record<string, unknown>;

/** JSON Schema to the subset Gemini accepts for a function's parameters. */
function toGeminiSchema(schema: unknown): Record<string, unknown> {
  const raw = schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : {};
  const type = String(raw.type || 'string').toUpperCase();
  const result: Record<string, unknown> = { type };
  if (typeof raw.description === 'string') result.description = raw.description;
  if (Array.isArray(raw.enum)) result.enum = raw.enum;
  if (type === 'ARRAY') result.items = toGeminiSchema(raw.items);
  if (type === 'OBJECT' && raw.properties && typeof raw.properties === 'object') {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw.properties as Record<string, unknown>)) properties[key] = toGeminiSchema(value);
    // Gemini rejects an object with no declared properties.
    if (Object.keys(properties).length > 0) {
      result.properties = properties;
      if (Array.isArray(raw.required)) result.required = raw.required;
    }
  }
  return result;
}

export function geminiModel(fetcher: typeof fetch = fetch): AgentModel {
  return {
    provider: 'gemini',
    model: GEMINI_MODEL,
    userMessage: (text) => ({ role: 'user', parts: [{ text }] }),
    resultMessage: (results) => ({
      role: 'user',
      parts: results.map((result) => ({
        functionResponse: { name: result.call.name, response: result.isError ? { error: result.content } : { result: result.content } },
      })),
    }),
    async turn(system, tools, messages): Promise<ModelTurn> {
      const { response } = await invokeAgent<{ candidates?: Array<{ content?: { role?: string; parts?: Part[] }; finishReason?: string }> }>({
        provider: 'gemini',
        model: GEMINI_MODEL,
        feature: 'workflow',
        activity: 'workflow.agent',
        fetchImpl: fetcher,
        body: {
          contents: messages,
          systemInstruction: { parts: [{ text: system }] },
          ...(tools.length > 0
            ? {
                tools: [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: toGeminiSchema(tool.inputSchema) })) }],
                toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
              }
            : {}),
          generationConfig: { temperature: 0.2, maxOutputTokens: 16000 },
        },
      });
      const data = response;
      const candidate = data.candidates?.[0];
      if (!candidate) throw new Error('The model returned nothing.');
      const parts = candidate.content?.parts || [];
      const calls: ModelToolCall[] = parts
        .filter((part) => part.functionCall)
        .map((part, index) => {
          const call = part.functionCall as { name: string; args?: Record<string, unknown> };
          return { id: `${call.name}#${index}`, name: call.name, input: call.args || {} };
        });
      return {
        // Echoed back whole: each function call carries a signature the next request needs.
        message: { role: candidate.content?.role || 'model', parts },
        text: geminiAnswerText(data),
        calls,
        stop: candidate.finishReason === 'SAFETY' ? 'refused' : candidate.finishReason === 'MAX_TOKENS' && calls.length === 0 ? 'limit' : calls.length > 0 ? 'tools' : 'end',
      };
    },
  };
}
