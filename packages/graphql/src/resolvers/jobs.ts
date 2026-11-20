import type { Context } from '../context';
import { assertSchedulable, nextCronRun } from '../lib/cron';
import { JOB_TYPES, jobScheduleProblem, jobScopeProblem, jobType } from '../lib/job-types';

/**
 * Job schedules and runs. The tables are reached only through the job_*
 * database functions, which check the caller's client and the job.manage
 * permission. The worker in packages/worker does the running.
 */

type Row = Record<string, any>;

interface MutationError {
  field: string | null;
  message: string;
  code: string;
}

function failure(error: unknown, code: string, field: string | null = null): MutationError {
  const raw = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '';
  const duplicate = /job_schedules_client_code|duplicate key/i.test(raw);
  return {
    field: duplicate ? 'scheduleCode' : field,
    message: duplicate ? 'Another schedule already uses this code.' : raw || 'The request failed.',
    code: duplicate ? 'DUPLICATE' : code,
  };
}

function label(code: string): string {
  return jobType(code)?.label || code;
}

export function mapSchedule(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id || null,
    scheduleCode: row.schedule_code,
    scheduleName: row.schedule_name,
    jobType: row.job_type,
    jobTypeLabel: label(row.job_type),
    payload: row.payload || {},
    cronExpression: row.cron_expression,
    timezone: row.timezone || 'UTC',
    isActive: row.is_active !== false,
    maxAttempts: row.max_attempts ?? 3,
    nextRunAt: row.next_run_at || null,
    lastRunAt: row.last_run_at || null,
    lastRunId: row.last_run_id || null,
    lastRunStatus: row.last_run_status || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapRun(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id || null,
    scheduleId: row.schedule_id || null,
    scheduleName: row.schedule_name || null,
    jobType: row.job_type,
    jobTypeLabel: label(row.job_type),
    payload: row.payload || {},
    status: row.status,
    attempts: row.attempts ?? 0,
    maxAttempts: row.max_attempts ?? 3,
    runAfter: row.run_after,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    result: row.result ?? null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
  };
}

/** One client id from a current_client_ids() row, which PostgREST may return bare or as an object. */
function clientIdOf(row: unknown): string | null {
  if (typeof row === 'string') return row;
  const value = row && typeof row === 'object' ? Object.values(row)[0] : null;
  return typeof value === 'string' ? value : null;
}

/**
 * The client the caller is working in: the simulated client, or their only
 * membership. Null when they have none. current_client_ids() is a set with no
 * order, so a caller in more than one client is refused rather than given
 * whichever row came back first (the same stance as schema-scope.ts).
 */
export async function callerClientId(context: Context): Promise<string | null> {
  const { data, error } = await context.supabase.schema('tenancy').rpc('current_client_ids');
  if (error) throw error;
  const ids = [...new Set((Array.isArray(data) ? data : []).map(clientIdOf).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return null;
  if (ids.length > 1) {
    throw new Error('You belong to more than one client, so this cannot tell which one to use. Open the client you are working in first.');
  }
  return ids[0];
}

async function readRun(context: Context, id: string) {
  const { data, error } = await context.supabase.rpc('job_run_get', { p_run_id: id });
  if (error) throw error;
  return data ? mapRun(data as Row) : null;
}

/** Queues one run for the caller's client. Returns the run id. */
export async function enqueueJob(
  context: Context,
  input: { clientId: string | null; jobType: string; payload?: Record<string, unknown>; dedupeKey?: string; maxAttempts?: number },
): Promise<string> {
  const problem = jobScopeProblem(input.jobType, input.clientId);
  if (problem) throw new Error(problem);
  const { data, error } = await context.supabase.rpc('job_enqueue', {
    p_client_id: input.clientId,
    p_job_type: input.jobType,
    p_payload: input.payload || {},
    p_dedupe_key: input.dedupeKey || null,
    p_max_attempts: input.maxAttempts ?? 3,
  });
  if (error) throw error;
  if (!data) throw new Error('The job could not be queued.');
  return String(data);
}

export const jobResolvers = {
  Query: {
    jobTypes: () => JOB_TYPES.filter((type) => type.schedulable !== false),

    jobSchedules: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase.rpc('job_schedules_list', {});
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapSchedule);
    },

    jobRuns: async (_: unknown, args: { status?: string | null; scheduleId?: string | null; first?: number | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('job_runs_list', {
        p_status: args.status || null,
        p_schedule_id: args.scheduleId || null,
        p_limit: args.first ?? 50,
      });
      if (error) throw error;
      return ((data as Row[] | null) || []).map(mapRun);
    },
  },

  Mutation: {
    saveJobSchedule: async (_: unknown, args: { input: Row }, context: Context) => {
      const input = args.input;
      try {
        const cron = String(input.cronExpression || '').trim();
        const timezone = String(input.timezone || 'UTC').trim() || 'UTC';
        try {
          assertSchedulable(cron, timezone);
        } catch (error) {
          const text = error instanceof Error ? error.message : 'The schedule is not valid.';
          return { schedule: null, errors: [{ field: /time zone/.test(text) ? 'timezone' : 'cronExpression', message: text, code: 'VALIDATION' }] };
        }
        if (input.payload != null && (typeof input.payload !== 'object' || Array.isArray(input.payload))) {
          return { schedule: null, errors: [{ field: 'payload', message: 'The payload must be a JSON object.', code: 'VALIDATION' }] };
        }
        const maxAttempts = input.maxAttempts ?? 3;
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
          return { schedule: null, errors: [{ field: 'maxAttempts', message: 'Attempts must be between 1 and 10.', code: 'VALIDATION' }] };
        }

        // An existing schedule keeps its client. The database ignores p_client_id on update.
        let clientId: string | null = null;
        if (input.id) {
          const { data: existing, error } = await context.supabase.rpc('job_schedules_list', {});
          if (error) throw error;
          const current = ((existing as Row[] | null) || []).find((row) => row.id === input.id);
          if (!current) return { schedule: null, errors: [{ field: 'id', message: 'Schedule was not found.', code: 'NOT_FOUND' }] };
          clientId = current.client_id || null;
        } else if (!input.platform) {
          clientId = await callerClientId(context);
          if (!clientId) {
            return { schedule: null, errors: [{ field: null, message: 'Choose a client before adding a schedule.', code: 'NO_CLIENT' }] };
          }
        }

        const problem = jobScheduleProblem(String(input.jobType || ''), clientId);
        if (problem) return { schedule: null, errors: [{ field: 'jobType', message: problem, code: 'VALIDATION' }] };

        const isActive = input.isActive !== false;
        const nextRunAt = isActive ? nextCronRun(cron, new Date(), timezone)?.toISOString() || null : null;
        const { data, error } = await context.supabase.rpc('job_schedule_save', {
          p_id: input.id || null,
          p_client_id: clientId,
          p_schedule_code: String(input.scheduleCode || '').trim(),
          p_schedule_name: String(input.scheduleName || '').trim(),
          p_job_type: String(input.jobType || '').trim(),
          p_payload: input.payload || {},
          p_cron_expression: cron,
          p_timezone: timezone,
          p_is_active: isActive,
          p_max_attempts: maxAttempts,
          p_next_run_at: nextRunAt,
        });
        if (error) throw error;
        return { schedule: mapSchedule(data as Row), errors: [] };
      } catch (error) {
        return { schedule: null, errors: [failure(error, 'SAVE_FAILED')] };
      }
    },

    deleteJobSchedule: async (_: unknown, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase.rpc('job_schedule_delete', { p_id: args.id });
      if (error) return { success: false, errors: [failure(error, 'DELETE_FAILED')] };
      if (data !== true) return { success: false, errors: [{ field: 'id', message: 'Schedule was not found.', code: 'NOT_FOUND' }] };
      return { success: true, errors: [] };
    },

    runJobScheduleNow: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('job_enqueue', {
          p_client_id: null,
          p_job_type: null,
          p_schedule_id: args.id,
        });
        if (error) throw error;
        return { run: data ? await readRun(context, String(data)) : null, errors: [] };
      } catch (error) {
        return { run: null, errors: [failure(error, 'ENQUEUE_FAILED')] };
      }
    },

    retryJobRun: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('job_run_retry', { p_run_id: args.id });
        if (error) throw error;
        if (data !== true) {
          return { run: null, errors: [{ field: 'id', message: 'Only a failed or cancelled run can be retried.', code: 'NOT_RETRYABLE' }] };
        }
        return { run: await readRun(context, args.id), errors: [] };
      } catch (error) {
        return { run: null, errors: [failure(error, 'RETRY_FAILED')] };
      }
    },

    cancelJobRun: async (_: unknown, args: { id: string }, context: Context) => {
      try {
        const { data, error } = await context.supabase.rpc('job_run_cancel', { p_run_id: args.id });
        if (error) throw error;
        if (data !== true) {
          return { run: null, errors: [{ field: 'id', message: 'Only a queued run can be cancelled.', code: 'NOT_CANCELLABLE' }] };
        }
        return { run: await readRun(context, args.id), errors: [] };
      } catch (error) {
        return { run: null, errors: [failure(error, 'CANCEL_FAILED')] };
      }
    },
  },
};
