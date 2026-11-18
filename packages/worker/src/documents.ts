import type { SupabaseClient } from '@supabase/supabase-js';
import { embedConfigFromEnv, processDocument } from '@tapestrai/graphql/src/lib/document-content';
import { refinerFromEnv } from './document-refiner';
import { JobError, type JobHandler } from './worker';

/**
 * Reads one document into chunks and embeds them. See docs/DOCUMENTS.md.
 *
 * A file that cannot be read (a scan, a format with no reader) fails the run at
 * once: another attempt would read the same file. A run the embedding service
 * slowed down is tried again later and carries on from the chunks already done.
 */
export function documentProcessHandler(supabase: SupabaseClient, env: Record<string, string | undefined> = process.env): JobHandler {
  return async (run) => {
    const documentId = typeof run.payload.documentId === 'string' ? run.payload.documentId : '';
    if (!documentId) throw new JobError('The job has no documentId.');
    // Wait up to five minutes on any one request before leaving the rest for the next attempt.
    const result = await processDocument(supabase, documentId, {
      embed: embedConfigFromEnv(env),
      // Tables and lists are described by the model when ANTHROPIC_API_KEY is set, and left as they are when it is not.
      refiner: refinerFromEnv(env, { clientId: run.clientId, userId: run.requestedBy }),
      budgetMs: 5 * 60 * 1000,
    });
    if (result.status === 'FAILED') throw new JobError(result.message || 'The document could not be read.');
    if (result.status === 'PROCESSING') {
      throw new JobError(result.message || 'The embedding service is limiting requests.', { retryable: true });
    }
    return { ...result };
  };
}
