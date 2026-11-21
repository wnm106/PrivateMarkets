import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';
import { invokeAgent } from '@tapestrai/mcp-server/src/agent/harness';
import type { RefineContext, RefineRequest, RefineResult, Refiner } from '@tapestrai/graphql/src/lib/document-content';

/**
 * Claude as the describer of thin passages: tables, schedules, signature
 * blocks. For each it writes one sentence saying what the passage holds and
 * picks its topics from the template's list. See docs/DOCUMENTS.md.
 *
 * The model is DOCUMENT_REFINE_MODEL, or claude-opus-5-5, at low effort: the
 * task is short and there are few passages per document. When the model
 * declines a request, the API re-runs it on a fallback model.
 *
 * A passage that fails is left out, so one bad table does not stop the rest.
 * A key that is refused, or a model that cannot be reached, stops the batch:
 * the next passage would fail the same way.
 */

const Described = z.object({
  description: z.string().describe('One sentence, at most 40 words, saying what the passage holds, so that a person searching for it would find it.'),
  topics: z.array(z.string()).describe('Codes of the topics the passage is about, from the list given. Usually one or two. Empty when none fits.'),
});

const SYSTEM = `You describe passages of legal and financial documents that have little language of their own: tables, schedules, signature blocks, lists of names, addresses and amounts. Your description is stored beside the passage in a search index so that a question in plain words finds it.

Write one sentence that says what the passage holds and whose it is, using the words a person would search with. For a table, say what each row is and what the columns give, and name the parties or items in it when there are only a few. Do not restate every figure. Do not add anything the passage and its context do not show.

Then choose the topics the passage is about, by code, only from the list you are given. Choose a topic only when the passage itself is about it. Most passages have one or two.`;

function prompt(request: RefineRequest, context: RefineContext): string {
  const topics = context.topics.map((topic) => `${topic.code}: ${topic.title}. ${topic.description}`).join('\n');
  return [
    `Document: ${context.documentTitle} (${context.typeName})`,
    `Headings above the passage: ${request.path || 'none'}`,
    request.before ? `The text just before it ends:\n${request.before}` : null,
    `Topics to choose from:\n${topics || 'none'}`,
    `The passage (${request.kind.toLowerCase()}):\n${request.text}`,
  ].filter(Boolean).join('\n\n');
}

/** An error that would repeat for every passage. */
function stopsTheBatch(error: unknown): boolean {
  return error instanceof Anthropic.AuthenticationError
    || error instanceof Anthropic.PermissionDeniedError
    || error instanceof Anthropic.APIConnectionError;
}

function explain(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) return new Error('The Anthropic key was rejected. Check ANTHROPIC_API_KEY for the worker.');
  if (error instanceof Anthropic.PermissionDeniedError) return new Error(`This Anthropic key cannot use the model. ${error.message}`);
  if (error instanceof Anthropic.APIConnectionError) return new Error('The model could not be reached.');
  return error instanceof Error ? error : new Error(String(error));
}

export interface RefinerOptions {
  client?: Anthropic;
  model?: string;
  /** Passages described at once. */
  concurrency?: number;
  /** Who the model calls are recorded against in agent usage. */
  clientId?: string | null;
  userId?: string | null;
  /** Aborts when the job has lost its run. No further passage is sent to the model. */
  signal?: AbortSignal;
}

export function claudeRefiner(options: RefinerOptions = {}): Refiner {
  const client = options.client || new Anthropic();
  const model = options.model || process.env.DOCUMENT_REFINE_MODEL || 'claude-opus-5-5';
  const concurrency = Math.max(1, options.concurrency ?? 4);

  const describe = async (request: RefineRequest, context: RefineContext): Promise<RefineResult | null> => {
    const { response } = await invokeAgent<{ stop_reason: string | null; parsed_output: z.infer<typeof Described> | null }>({
      provider: 'claude',
      model,
      feature: 'documents',
      activity: 'document.refine',
      clientId: options.clientId ?? null,
      userId: options.userId ?? null,
      execute: () => client.beta.messages.parse({
        model,
        max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: betaZodOutputFormat(Described) },
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt(request, context) }],
      }),
    });
    const parsed = response.stop_reason === 'refusal' ? null : response.parsed_output;
    return parsed ? { id: request.id, summary: parsed.description, topics: parsed.topics } : null;
  };

  return async (requests, context) => {
    const results: RefineResult[] = [];
    let next = 0;
    let fatal: Error | null = null;
    const work = async () => {
      while (next < requests.length && !fatal && !options.signal?.aborted) {
        const request = requests[next];
        next += 1;
        try {
          const result = await describe(request, context);
          if (result) results.push(result);
        } catch (error) {
          if (stopsTheBatch(error)) fatal = explain(error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, work));
    if (fatal && results.length === 0) throw fatal;
    return results;
  };
}

/** The refiner for this environment, or null when no Anthropic key is set. */
export function refinerFromEnv(env: Record<string, string | undefined> = process.env, options: RefinerOptions = {}): Refiner | null {
  return (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '').trim() ? claudeRefiner(options) : null;
}
