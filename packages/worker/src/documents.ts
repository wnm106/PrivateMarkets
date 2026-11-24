import type { SupabaseClient } from '@supabase/supabase-js';
import { embedConfigFromEnv, processDocument, type OutsideReader } from '@tapestrai/graphql/src/lib/document-content';
import { llamaParseConfigured, readWithLlamaParse } from '@tapestrai/mcp-server/src/feeds/llama-parse';
import { refinerFromEnv } from './document-refiner';
import { JobError, type JobContext, type JobHandler } from './worker';

/**
 * The same client, refusing every call once the run's claim is lost.
 * processDocument does all its reading and writing through the client it is
 * given, so this stops it at its next step without it knowing about claims.
 */
function whileHeld(supabase: SupabaseClient, job?: JobContext): SupabaseClient {
  if (!job) return supabase;
  return new Proxy(supabase, {
    get(target, key) {
      job.signal.throwIfAborted();
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The reader for a file this worker cannot read itself: a scan, a picture, a Word file. LlamaParse,
 * when LLAMA_CLOUD_API_KEY is set, and null when it is not. The file leaves for that service here.
 */
export function outsideReaderFromEnv(env: Record<string, string | undefined> = process.env): OutsideReader | null {
  if (!llamaParseConfigured(env as NodeJS.ProcessEnv)) return null;
  // A long agreement takes minutes to read, so the reader is given longer here than when a person is waiting on an upload.
  return (fileName, mediaType, bytes) => readWithLlamaParse(fileName, mediaType, bytes, { env: env as NodeJS.ProcessEnv, timeoutMs: 10 * 60 * 1000 });
}

/**
 * Reads one document into chunks and embeds them. See docs/DOCUMENTS.md.
 *
 * A file that cannot be read (a scan with no reader set up, a format no reader takes) fails the run at
 * once: another attempt would read the same file. A run the embedding service
 * slowed down is tried again later and carries on from the chunks already done.
 */
export function documentProcessHandler(supabase: SupabaseClient, env: Record<string, string | undefined> = process.env): JobHandler {
  return async (run, job) => {
    const documentId = typeof run.payload.documentId === 'string' ? run.payload.documentId : '';
    if (!documentId) throw new JobError('The job has no documentId.');
    // The id comes from the job, and a job can be queued with any id. The document must be the job's client's own
    // before any of it is read, sent to a model, or written.
    // One answer whether the document is gone or is another client's, so a run cannot be used to learn which ids exist.
    const found = await supabase.rpc('document_job_context', { p_id: documentId });
    if (found.error) throw new Error(found.error.message);
    const document = (found.data || null) as { client_id?: unknown } | null;
    if (!document || !run.clientId || document.client_id !== run.clientId) throw new JobError('This client has no document with that id.');

    // Wait up to five minutes on any one request before leaving the rest for the next attempt.
    const result = await processDocument(whileHeld(supabase, job), documentId, {
      embed: embedConfigFromEnv(env),
      // Tables and lists are described by the model when ANTHROPIC_API_KEY is set, and left as they are when it is not.
      refiner: refinerFromEnv(env, { clientId: run.clientId, userId: run.requestedBy, signal: job?.signal }),
      // A scan, a picture or a Word file is read by LlamaParse when LLAMA_CLOUD_API_KEY is set, and refused when it is not.
      reader: outsideReaderFromEnv(env),
      budgetMs: 5 * 60 * 1000,
    });
    if (result.status === 'FAILED') throw new JobError(result.message || 'The document could not be read.');
    if (result.status === 'PROCESSING') {
      throw new JobError(result.message || 'The embedding service is limiting requests.', { retryable: true });
    }
    return { ...result };
  };
}
