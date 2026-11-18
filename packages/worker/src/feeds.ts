import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { nextCronRun } from '@tapestrai/graphql/src/lib/cron';
import { runWithAgentContext } from '@tapestrai/mcp-server/src/agent/harness';
import { buildConnector, type ConnectionSpec, type Connector, type FeedSpec, type FileOutcome, type SftpOptions } from './connectors';
import { JobError, type JobHandler } from './worker';

/**
 * Feed jobs.
 *
 *   feed.poll         look for a feed's files, and load each new one through its saved map
 *   feed.check        fail when a feed's expected file has not arrived
 *   connection.check  confirm a connection can be reached
 *
 * A file is identified by its content hash. The ledger (ops.received_files)
 * decides whether a file is new, so the same content is never loaded twice,
 * whatever it is called and however often it is seen.
 */

export type LoadStatus = 'LOADED' | 'NEEDS_REVIEW' | 'FAILED';

export interface LoadOutcome {
  status: LoadStatus;
  importInstanceId?: string | null;
  created?: number;
  matched?: number;
  message?: string | null;
}

export interface LoadRequest {
  clientId: string;
  mapCode: string;
  sourceCode: string | null;
  fileName: string;
  mediaType: string;
  bytes: Buffer;
}

/** Loads one file through a saved map. The real one is in feed-loader.ts. */
export type FileLoader = (request: LoadRequest) => Promise<LoadOutcome>;

export interface FeedDeps {
  supabase: SupabaseClient;
  loadFile: FileLoader;
  now?: () => Date;
  connectorFor?: (connection: ConnectionSpec) => Connector;
  /** Options for the connectors. Tests use it to allow local addresses. */
  http?: SftpOptions;
}

type Row = Record<string, any>;

function reason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The request failed';
}

async function call<T>(supabase: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

function connectionSpec(row: Row, secret: unknown): ConnectionSpec {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    kind: String(row.kind),
    config: row.config && typeof row.config === 'object' ? row.config : {},
    secret: typeof secret === 'string' && secret ? secret : null,
  };
}

interface FileReport {
  file: string;
  outcome: FileOutcome;
  message?: string;
}

/** The activity kind and the sentence stored for one file, or null when the file changed nothing. */
export function feedActivity(feedName: string, fileName: string, outcome: FileOutcome, message?: string): { kind: string; summary: string } | null {
  const detail = message ? ` ${message}` : '';
  if (outcome === 'LOADED') return { kind: 'FEED_LOADED', summary: `${feedName}: loaded ${fileName}.` };
  if (outcome === 'NEEDS_REVIEW') return { kind: 'FEED_NEEDS_REVIEW', summary: `${feedName}: ${fileName} is waiting for review.${detail}` };
  if (outcome === 'FAILED' || outcome === 'GAVE_UP') return { kind: 'FEED_FAILED', summary: `${feedName}: ${fileName} failed.${detail}` };
  return null;
}

export function feedPollHandler(deps: FeedDeps): JobHandler {
  const now = deps.now || (() => new Date());
  const connectorFor = deps.connectorFor || ((connection: ConnectionSpec) => buildConnector(deps.supabase, connection, deps.http));

  return async (run) => {
    const feedId = typeof run.payload.feedId === 'string' ? run.payload.feedId : '';
    if (!feedId) throw new JobError('The job has no feedId.');
    const context = await call<Row | null>(deps.supabase, 'feed_poll_context', { p_feed_id: feedId });
    if (!context?.feed) throw new JobError('The feed no longer exists.');
    const feed = context.feed as Row;
    if (feed.client_id !== run.clientId) throw new JobError('The feed belongs to another client.');
    if (!feed.is_active) throw new JobError('The feed is paused.');
    if (!context.connection?.is_active) throw new JobError('The feed\'s connection is paused.');

    const connector = connectorFor(connectionSpec(context.connection, context.secret));
    const spec: FeedSpec = { feedCode: feed.feed_code, path: feed.path || '', filePattern: feed.file_pattern || '*' };
    const started = now();
    const reports: FileReport[] = [];
    try {
      const files = await connector.list(spec, started);

      for (const file of files) {
        let outcome: FileOutcome = 'FAILED';
        let message: string | undefined;
        try {
          const fetched = await connector.fetch(file);
          if (!fetched) continue;
          const sha256 = createHash('sha256').update(fetched.bytes).digest('hex');
          const ledger = await call<Row>(deps.supabase, 'feed_file_begin', {
            p_feed_id: feedId,
            p_file_name: fetched.name,
            p_remote_ref: file.ref,
            p_size_bytes: fetched.bytes.length,
            p_sha256: sha256,
            p_job_run_id: run.id,
          });

          if (ledger.action !== 'LOAD') {
            // Another poll is loading this content right now. Leave it alone.
            if (ledger.status === 'LOADING') continue;
            // Seen before. A file that used up its attempts is set aside; anything else is a repeat.
            outcome = ledger.status === 'FAILED' ? 'GAVE_UP' : 'DUPLICATE';
          } else {
            let loaded: LoadOutcome;
            try {
              loaded = await runWithAgentContext(
                {
                  userId: run.requestedBy,
                  clientId: String(feed.client_id),
                  feature: 'feed-intake',
                  activity: 'feed.load',
                  metadata: { feedId, fileName: fetched.name, jobRunId: run.id },
                },
                () =>
                  deps.loadFile({
                    clientId: feed.client_id,
                    mapCode: feed.map_code,
                    sourceCode: feed.source_code || null,
                    fileName: fetched.name,
                    mediaType: fetched.mediaType,
                    bytes: fetched.bytes,
                  }),
              );
            } catch (error) {
              loaded = { status: 'FAILED', message: reason(error) };
            }
            await call(deps.supabase, 'feed_file_finish', {
              p_id: ledger.id,
              p_status: loaded.status,
              p_import_instance_id: loaded.importInstanceId || null,
              p_rows_created: loaded.created ?? null,
              p_rows_matched: loaded.matched ?? null,
              p_message: loaded.message || null,
            });
            outcome = loaded.status;
            message = loaded.message || undefined;
          }
        } catch (error) {
          outcome = 'FAILED';
          message = reason(error);
        }

        try {
          await connector.settle?.(file, outcome, started);
        } catch (error) {
          message = message ? `${message} ${reason(error)}` : reason(error);
          if (outcome === 'LOADED' || outcome === 'DUPLICATE') outcome = 'FAILED';
        }
        reports.push({ file: file.name, outcome, ...(message ? { message } : {}) });
      }
    } finally {
      await connector.close?.().catch(() => undefined);
    }

    await call(deps.supabase, 'feed_polled', { p_feed_id: feedId });

    for (const report of reports) {
      const noted = feedActivity(String(feed.feed_name || feed.feed_code), report.file, report.outcome, report.message);
      if (!noted) continue;
      await call(deps.supabase, 'activity_record', {
        p_client_id: feed.client_id,
        p_kind: noted.kind,
        p_subject_type: 'FEED',
        p_subject_id: feed.id,
        p_subject_code: feed.feed_code,
        p_summary: noted.summary,
        p_payload: { file: report.file, outcome: report.outcome },
      });
    }

    const count = (wanted: FileOutcome) => reports.filter((report) => report.outcome === wanted).length;
    const result = {
      feed: feed.feed_code,
      files: reports.length,
      loaded: count('LOADED'),
      duplicates: count('DUPLICATE'),
      needsReview: count('NEEDS_REVIEW'),
      failed: count('FAILED') + count('GAVE_UP'),
      details: reports.filter((report) => report.outcome !== 'DUPLICATE').slice(0, 20),
    };

    // Nothing sends alerts yet, so a file that needs a person makes the run fail where it will be seen.
    const attention = reports.filter((report) => report.outcome === 'NEEDS_REVIEW' || report.outcome === 'FAILED' || report.outcome === 'GAVE_UP');
    if (attention.length > 0) {
      const lines = attention.slice(0, 5).map((report) => `${report.file}: ${report.message || report.outcome.toLowerCase().replace('_', ' ')}`);
      throw new JobError(
        `${feed.feed_name}: ${result.loaded} loaded, ${result.needsReview} waiting for review, ${result.failed} failed. ${lines.join(' ')}`,
      );
    }
    return result;
  };
}

export interface LateFeed {
  feed: string;
  name: string;
  expectedAt: string;
  lastReceivedAt: string | null;
}

/** The feeds whose next expected file, plus the grace period, is already in the past. */
export function lateFeeds(expectations: Row[], now: Date): LateFeed[] {
  const late: LateFeed[] = [];
  for (const row of expectations) {
    // The next file is expected at the first slot after the last one arrived.
    const since = new Date(row.last_received_at || row.created_at);
    let expected: Date | null;
    try {
      expected = nextCronRun(String(row.expected_cron), since, row.expected_timezone || 'UTC');
    } catch {
      continue;
    }
    if (!expected) continue;
    const deadline = expected.getTime() + (Number(row.grace_minutes) || 0) * 60_000;
    if (deadline < now.getTime()) {
      late.push({ feed: row.feed_code, name: row.feed_name, expectedAt: expected.toISOString(), lastReceivedAt: row.last_received_at || null });
    }
  }
  return late;
}

export function feedCheckHandler(deps: Pick<FeedDeps, 'supabase' | 'now'>): JobHandler {
  const now = deps.now || (() => new Date());
  return async (run) => {
    if (!run.clientId) throw new JobError('This job needs a client.');
    const expectations = (await call<Row[] | null>(deps.supabase, 'feed_expectations', { p_client_id: run.clientId })) || [];
    const late = lateFeeds(expectations, now());
    if (late.length > 0) {
      for (const item of late) {
        const row = expectations.find((expectation) => expectation.feed_code === item.feed);
        await call(deps.supabase, 'activity_record', {
          p_client_id: run.clientId,
          p_kind: 'FEED_LATE',
          p_subject_type: 'FEED',
          p_subject_id: row?.id || null,
          p_subject_code: item.feed,
          p_summary: `${item.name} has not received the file expected ${item.expectedAt.slice(0, 16).replace('T', ' ')} UTC.`,
          p_payload: { expectedAt: item.expectedAt },
        });
      }
      const lines = late.map((item) => `${item.name} (expected ${item.expectedAt.slice(0, 16).replace('T', ' ')} UTC)`);
      throw new JobError(`${late.length} of ${expectations.length} feeds are late: ${lines.join('; ')}.`);
    }
    return { checked: expectations.length, late: 0 };
  };
}

export function connectionCheckHandler(deps: Pick<FeedDeps, 'supabase' | 'connectorFor' | 'http'>): JobHandler {
  const connectorFor = deps.connectorFor || ((connection: ConnectionSpec) => buildConnector(deps.supabase, connection, deps.http));
  return async (run) => {
    const connectionId = typeof run.payload.connectionId === 'string' ? run.payload.connectionId : '';
    if (!connectionId) throw new JobError('The job has no connectionId.');
    const context = await call<Row | null>(deps.supabase, 'feed_connection_context', { p_connection_id: connectionId });
    if (!context?.connection) throw new JobError('The connection no longer exists.');
    if (context.connection.client_id !== run.clientId) throw new JobError('The connection belongs to another client.');
    const connector = connectorFor(connectionSpec(context.connection, context.secret));
    try {
      const message = await connector.check();
      await call(deps.supabase, 'feed_connection_checked', { p_connection_id: connectionId, p_ok: true, p_message: message });
      return { ok: true, message };
    } catch (error) {
      await call(deps.supabase, 'feed_connection_checked', { p_connection_id: connectionId, p_ok: false, p_message: reason(error) });
      throw new JobError(reason(error));
    } finally {
      await connector.close?.().catch(() => undefined);
    }
  };
}
