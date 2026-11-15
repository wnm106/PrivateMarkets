import type { SupabaseClient } from '@supabase/supabase-js';
import type { DueSchedule, JobRun, JobStore } from './worker';

/**
 * The job store on Supabase. Every call is one of the worker functions in
 * supabase/migrations/20261114190000_job_backbone.sql, which only the service
 * role may execute.
 */

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function toJobRun(row: Row): JobRun {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {};
  return {
    id: String(row.id),
    clientId: text(row.client_id),
    scheduleId: text(row.schedule_id),
    requestedBy: text(row.requested_by),
    jobType: String(row.job_type),
    payload,
    attempts: Number(row.attempts) || 0,
    maxAttempts: Number(row.max_attempts) || 1,
  };
}

export function toDueSchedule(row: Row): DueSchedule {
  return {
    id: String(row.id),
    cronExpression: String(row.cron_expression),
    timezone: text(row.timezone) || 'UTC',
    nextRunAt: text(row.next_run_at),
  };
}

export function supabaseJobStore(supabase: SupabaseClient): JobStore {
  async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  }

  return {
    async dueSchedules(now) {
      const rows = await call<Row[] | null>('job_due_schedules', { p_now: now.toISOString() });
      return (rows || []).map(toDueSchedule);
    },
    async fireSchedule(id, expected, next, queue) {
      const runId = await call<string | null>('job_fire_schedule', {
        p_schedule_id: id,
        p_expected_next_run_at: expected,
        p_new_next_run_at: next,
        p_queue: queue,
      });
      return runId || null;
    },
    async claim(worker, limit, leaseSeconds) {
      const rows = await call<Row[] | null>('job_claim', { p_worker: worker, p_limit: limit, p_lease_seconds: leaseSeconds });
      return (rows || []).map(toJobRun);
    },
    async heartbeat(runId, worker, leaseSeconds) {
      return (await call<boolean | null>('job_heartbeat', { p_run_id: runId, p_worker: worker, p_lease_seconds: leaseSeconds })) === true;
    },
    async complete(runId, worker, result) {
      return (await call<boolean | null>('job_complete', { p_run_id: runId, p_worker: worker, p_result: result })) === true;
    },
    async fail(runId, worker, error, retryable) {
      return (await call<string | null>('job_fail', { p_run_id: runId, p_worker: worker, p_error: error, p_retryable: retryable })) || null;
    },
  };
}
