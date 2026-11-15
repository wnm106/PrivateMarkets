import type { Context } from '../context';
import { assertSchedulable, nextCronRun } from '../lib/cron';
import { CONNECTION_KINDS, cleanConnectionConfig, cleanFeedPath, codeFrom, needsSecret } from '../lib/feed-config';
import { callerClientId, enqueueJob, mapRun } from './jobs';

/**
 * Connections, feeds and the received-file ledger. Everything goes through the
 * feed_* database functions, which check the caller's client and feed.manage.
 * A connection's credential is write-only: it goes to Supabase Vault and no
 * query returns it. The worker in packages/worker does the polling.
 */

type Row = Record<string, any>;
type FieldError = { field: string | null; message: string; code: string };

const FEED_BUCKET = 'feed-inbox';

function fail(message: string, field: string | null = null, code = 'VALIDATION'): FieldError {
  return { field, message, code };
}

function failure(error: unknown, code: string): FieldError {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  if (/duplicate key/i.test(raw)) return fail('That code is already in use.', 'code', 'DUPLICATE');
  return fail(raw || 'The request failed.', null, code);
}

export function mapConnection(row: Row) {
  const config = row.config && typeof row.config === 'object' ? row.config : {};
  return {
    id: row.id,
    clientId: row.client_id,
    connectionCode: row.connection_code,
    connectionName: row.connection_name,
    kind: row.kind,
    config,
    hasSecret: row.has_secret === true,
    isActive: row.is_active !== false,
    lastCheckedAt: row.last_checked_at || null,
    lastCheckOk: row.last_check_ok ?? null,
    lastCheckMessage: row.last_check_message || null,
    inboxPath: row.kind === 'STORAGE' ? [FEED_BUCKET, row.client_id, config.folder].filter(Boolean).join('/') : null,
  };
}

export function mapFeed(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id,
    connectionId: row.connection_id,
    connectionName: row.connection_name || '',
    connectionKind: row.connection_kind || '',
    feedCode: row.feed_code,
    feedName: row.feed_name,
    path: row.path || '',
    filePattern: row.file_pattern || '*',
    mapCode: row.map_code,
    sourceCode: row.source_code || null,
    isActive: row.is_active !== false,
    pollCron: row.poll_cron || null,
    pollTimezone: row.poll_timezone || null,
    nextPollAt: row.poll_active ? row.next_poll_at || null : null,
    expectedCron: row.expected_cron || null,
    expectedTimezone: row.expected_timezone || 'UTC',
    graceMinutes: row.grace_minutes ?? 120,
    lastPolledAt: row.last_polled_at || null,
    lastReceivedAt: row.last_received_at || null,
    lastFileName: row.last?.file_name || null,
    lastFileStatus: row.last?.status || null,
    lastFileMessage: row.last?.message || null,
  };
}

function mapReceivedFile(row: Row) {
  return {
    id: row.id,
    feedId: row.feed_id,
    feedName: row.feed_name || null,
    fileName: row.file_name,
    remoteRef: row.remote_ref || null,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    sha256: String(row.sha256 || '').trim(),
    status: row.status,
    attempts: row.attempts ?? 1,
    importInstanceId: row.import_instance_id || null,
    rowsCreated: row.rows_created ?? null,
    rowsMatched: row.rows_matched ?? null,
    message: row.message || null,
    receivedAt: row.received_at,
    lastSeenAt: row.last_seen_at,
    finishedAt: row.finished_at || null,
  };
}

async function rows(context: Context, fn: string, args: Record<string, unknown> = {}): Promise<Row[]> {
  const { data, error } = await context.supabase.rpc(fn, args);
  if (error) throw error;
  return (data as Row[] | null) || [];
}

async function findConnection(context: Context, id: string): Promise<Row | null> {
  return (await rows(context, 'feed_connections_list')).find((row) => row.id === id) || null;
}

async function findFeed(context: Context, id: string): Promise<Row | null> {
  return (await rows(context, 'feeds_list')).find((row) => row.id === id) || null;
}

/** Saved maps the caller's client may load through: its own and the built-in ones. */
async function visibleMaps(context: Context): Promise<Array<{ mapCode: string; mapName: string }>> {
  const { data, error } = await context.supabase
    .schema('entity_instances')
    .from('feed_maps')
    .select('map_code, map_name, is_active')
    .order('map_name');
  if (error) throw error;
  return (data || [])
    .filter((row: Row) => row.is_active !== false)
    .map((row: Row) => ({ mapCode: row.map_code, mapName: row.map_name || row.map_code }));
}

function checkCron(expression: string, timezone: string, field: string): FieldError | null {
  try {
    assertSchedulable(expression, timezone);
    return null;
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The schedule is not valid.', field);
  }
}

async function runResult(context: Context, runId: string) {
  const { data, error } = await context.supabase.rpc('job_run_get', { p_run_id: runId });
  if (error) throw error;
  return data ? mapRun(data as Row) : null;
}

export const feedResolvers = {
  Query: {
    feedConnections: async (_: unknown, __: unknown, context: Context) => (await rows(context, 'feed_connections_list')).map(mapConnection),
    feeds: async (_: unknown, __: unknown, context: Context) => (await rows(context, 'feeds_list')).map(mapFeed),
    receivedFiles: async (_: unknown, args: { feedId?: string | null; first?: number | null }, context: Context) =>
      (await rows(context, 'feed_received_files_list', { p_feed_id: args.feedId || null, p_limit: args.first ?? 50 })).map(mapReceivedFile),
    feedMaps: async (_: unknown, __: unknown, context: Context) => visibleMaps(context),
  },

  Mutation: {
    saveFeedConnection: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const name = String(input.connectionName || '').trim();
        if (!name) return { connection: null, errors: [fail('Give the connection a name.', 'connectionName')] };
        const kind = String(input.kind || '').toUpperCase();
        if (!(CONNECTION_KINDS as readonly string[]).includes(kind)) {
          return { connection: null, errors: [fail('Choose where the files come from.', 'kind')] };
        }
        let config: Record<string, unknown>;
        try {
          config = cleanConnectionConfig(kind, input.config);
        } catch (error) {
          return { connection: null, errors: [fail(error instanceof Error ? error.message : 'The settings are not valid.', 'config')] };
        }

        const existing = input.id ? await findConnection(context, input.id) : null;
        if (input.id && !existing) return { connection: null, errors: [fail('Connection was not found.', 'id', 'NOT_FOUND')] };
        const clientId = existing ? existing.client_id : await callerClientId(context);
        if (!clientId) return { connection: null, errors: [fail('Choose a client before adding a connection.', null, 'NO_CLIENT')] };

        // null keeps what is stored, '' removes it.
        const secret = typeof input.secret === 'string' ? input.secret : null;
        const willHaveSecret = secret === null ? existing?.has_secret === true : secret !== '';
        if (needsSecret(kind, config) && !willHaveSecret) {
          return { connection: null, errors: [fail('Enter the credential for this connection.', 'secret')] };
        }

        const { data, error } = await context.supabase.rpc('feed_connection_save', {
          p_id: input.id || null,
          p_client_id: clientId,
          p_connection_code: String(input.connectionCode || '').trim() || existing?.connection_code || codeFrom(name, 'CONNECTION'),
          p_connection_name: name,
          p_kind: kind,
          p_config: config,
          // A connection that no longer signs in does not keep a credential.
          p_secret: needsSecret(kind, config) ? secret : '',
          p_is_active: input.isActive !== false,
        });
        if (error) throw error;
        return { connection: mapConnection(data as Row), errors: [] };
      } catch (error) {
        return { connection: null, errors: [failure(error, 'SAVE_FAILED')] };
      }
    },

    deleteFeedConnection: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('feed_connection_delete', { p_id: args.id });
      if (error) return { success: false, errors: [failure(error, 'DELETE_FAILED')] };
      if (data !== true) return { success: false, errors: [fail('Connection was not found.', 'id', 'NOT_FOUND')] };
      return { success: true, errors: [] };
    },

    checkFeedConnection: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const connection = await findConnection(context, args.id);
        if (!connection) return { run: null, errors: [fail('Connection was not found.', 'id', 'NOT_FOUND')] };
        const runId = await enqueueJob(context, {
          clientId: connection.client_id,
          jobType: 'connection.check',
          payload: { connectionId: connection.id },
          dedupeKey: `connection:${connection.id}`,
          maxAttempts: 1,
        });
        return { run: await runResult(context, runId), errors: [] };
      } catch (error) {
        return { run: null, errors: [failure(error, 'ENQUEUE_FAILED')] };
      }
    },

    saveFeed: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const name = String(input.feedName || '').trim();
        if (!name) return { feed: null, errors: [fail('Give the feed a name.', 'feedName')] };
        const connection = await findConnection(context, input.connectionId);
        if (!connection) return { feed: null, errors: [fail('Choose a connection.', 'connectionId', 'NOT_FOUND')] };
        const existing = input.id ? await findFeed(context, input.id) : null;
        if (input.id && !existing) return { feed: null, errors: [fail('Feed was not found.', 'id', 'NOT_FOUND')] };

        let path: string;
        try {
          path = cleanFeedPath(connection.kind, input.path);
        } catch (error) {
          return { feed: null, errors: [fail(error instanceof Error ? error.message : 'The path is not valid.', 'path')] };
        }
        if (connection.kind === 'HTTP' && !path && !String(connection.config?.baseUrl || '').replace(/\/+$/, '').includes('/', 8)) {
          return { feed: null, errors: [fail('Enter the file\'s address after the connection address.', 'path')] };
        }

        const mapCode = String(input.mapCode || '').trim();
        if (!(await visibleMaps(context)).some((map) => map.mapCode === mapCode)) {
          return { feed: null, errors: [fail('Choose a saved map. Load one file by hand first to create it.', 'mapCode')] };
        }

        const pollCron = String(input.pollCron || '').trim();
        const pollTimezone = String(input.pollTimezone || 'UTC').trim() || 'UTC';
        const expectedCron = String(input.expectedCron || '').trim();
        const expectedTimezone = String(input.expectedTimezone || 'UTC').trim() || 'UTC';
        const cronError = (pollCron && checkCron(pollCron, pollTimezone, 'pollCron')) || (expectedCron && checkCron(expectedCron, expectedTimezone, 'expectedCron'));
        if (cronError) return { feed: null, errors: [cronError] };
        const graceMinutes = input.graceMinutes ?? 120;
        if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 10080) {
          return { feed: null, errors: [fail('The grace period must be between 0 minutes and 7 days.', 'graceMinutes')] };
        }

        const isActive = input.isActive !== false;
        const feedCode = String(input.feedCode || '').trim() || existing?.feed_code || codeFrom(name, 'FEED');
        const saveFeedRow = async (id: string | null, scheduleId: string | null) => {
          const { data, error } = await context.supabase.rpc('feed_save', {
            p_id: id,
            p_connection_id: connection.id,
            p_feed_code: feedCode,
            p_feed_name: name,
            p_path: path,
            p_file_pattern: String(input.filePattern || '').trim() || '*',
            p_map_code: mapCode,
            p_source_code: String(input.sourceCode || '').trim() || null,
            p_is_active: isActive,
            p_schedule_id: scheduleId,
            p_expected_cron: expectedCron || null,
            p_expected_timezone: expectedTimezone,
            p_grace_minutes: graceMinutes,
          });
          if (error) throw error;
          return data as Row;
        };

        // The feed first: its poll schedule needs the feed's id.
        let saved = await saveFeedRow(existing?.id || null, existing?.schedule_id || null);
        let scheduleId: string | null = saved.schedule_id || null;

        if (pollCron) {
          const active = isActive && connection.is_active !== false;
          const { data, error } = await context.supabase.rpc('job_schedule_save', {
            p_id: scheduleId,
            p_client_id: saved.client_id,
            p_schedule_code: `FEED_POLL_${feedCode}`.slice(0, 100),
            p_schedule_name: `Poll ${name}`.slice(0, 200),
            p_job_type: 'feed.poll',
            p_payload: { feedId: saved.id },
            p_cron_expression: pollCron,
            p_timezone: pollTimezone,
            p_is_active: active,
            p_max_attempts: 1,
            p_next_run_at: active ? nextCronRun(pollCron, new Date(), pollTimezone)?.toISOString() || null : null,
          });
          if (error) throw error;
          const newScheduleId = (data as Row).id as string;
          if (newScheduleId !== scheduleId) {
            scheduleId = newScheduleId;
            saved = await saveFeedRow(saved.id, scheduleId);
          } else {
            saved = (await findFeed(context, saved.id)) || saved;
          }
        } else if (scheduleId) {
          saved = await saveFeedRow(saved.id, null);
          const { error } = await context.supabase.rpc('job_schedule_delete', { p_id: scheduleId });
          if (error) throw error;
        }

        return { feed: mapFeed(saved), errors: [] };
      } catch (error) {
        return { feed: null, errors: [failure(error, 'SAVE_FAILED')] };
      }
    },

    deleteFeed: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('feed_delete', { p_id: args.id });
      if (error) return { success: false, errors: [failure(error, 'DELETE_FAILED')] };
      if (data !== true) return { success: false, errors: [fail('Feed was not found.', 'id', 'NOT_FOUND')] };
      return { success: true, errors: [] };
    },

    pollFeedNow: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const feed = await findFeed(context, args.id);
        if (!feed) return { run: null, errors: [fail('Feed was not found.', 'id', 'NOT_FOUND')] };
        const runId = await enqueueJob(context, {
          clientId: feed.client_id,
          jobType: 'feed.poll',
          payload: { feedId: feed.id },
          // The same key the poll schedule uses, so a scheduled and a manual poll never overlap.
          dedupeKey: feed.schedule_id ? `schedule:${feed.schedule_id}` : `feed:${feed.id}`,
          maxAttempts: 1,
        });
        return { run: await runResult(context, runId), errors: [] };
      } catch (error) {
        return { run: null, errors: [failure(error, 'ENQUEUE_FAILED')] };
      }
    },
  },
};
