import type { SupabaseClient } from '@supabase/supabase-js';
import { mapFileLoader } from './feed-loader';
import { connectionCheckHandler, feedCheckHandler, feedPollHandler } from './feeds';
import { JobError, type JobHandler, type JobRun } from './worker';

/**
 * One handler per job type in packages/graphql/src/lib/job-types.ts.
 *
 * Handlers use the service-role client, which has no signed-in user. Reports
 * that decide access from who is signed in (the data quality dashboard, stale
 * attributes) are reached through job_run_* functions, which run them as the
 * job's owner. See supabase/migrations/20261114200000_job_run_as.sql.
 */

function wholeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function isoDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** Drains the calculated attribute queue a batch at a time. */
export function calcProcessHandler(supabase: SupabaseClient): JobHandler {
  return async (run) => {
    const limit = wholeNumber(run.payload.limit, 500, 1, 5000);
    const maxRounds = wholeNumber(run.payload.maxRounds, 20, 1, 200);
    let processed = 0;
    let failed = 0;
    let pending = 0;
    let rounds = 0;
    for (;;) {
      const { data, error } = await supabase.rpc('process_calculated_attributes', { p_limit: limit });
      if (error) throw new Error(error.message);
      const round = (data || {}) as { processed?: number; failed?: number; pending?: number };
      const done = Number(round.processed) || 0;
      processed += done;
      failed += Number(round.failed) || 0;
      pending = Number(round.pending) || 0;
      rounds += 1;
      // Stop when the queue is empty, when a round made no progress (what is left
      // keeps failing), or at the round limit. The next run picks up the rest.
      if (pending === 0 || done === 0 || rounds >= maxRounds) break;
    }
    return { processed, failed, pending, rounds };
  };
}

interface RuleOutcome {
  ruleCode: string;
  runId: string | null;
  status: string | null;
  results: number;
  breaches: number;
}

/**
 * Scores compliance rules. payload.ruleCodes picks rules; without it every
 * active rule the run's client can use is scored (shared rules, plus the
 * client's own). payload.asOfDate defaults to today.
 */
export function complianceEvaluateHandler(supabase: SupabaseClient, now: () => Date = () => new Date()): JobHandler {
  return async (run: JobRun) => {
    const compliance = supabase.schema('compliance');
    const asOfDate = isoDate(run.payload.asOfDate) || now().toISOString().slice(0, 10);
    if (run.payload.asOfDate !== undefined && run.payload.asOfDate !== null && !isoDate(run.payload.asOfDate)) {
      throw new JobError('asOfDate must be a date written as YYYY-MM-DD.');
    }
    const requested = Array.isArray(run.payload.ruleCodes)
      ? run.payload.ruleCodes.filter((code): code is string => typeof code === 'string' && code.trim() !== '').map((code) => code.trim())
      : [];

    const { data: ruleRows, error: ruleError } = await compliance.from('rules').select('rule_code, client_id').eq('is_active', true);
    if (ruleError) throw new Error(ruleError.message);
    const usable = (ruleRows || []).filter((rule) => !rule.client_id || !run.clientId || rule.client_id === run.clientId);
    const usableCodes = new Set(usable.map((rule) => String(rule.rule_code)));

    const unknown = requested.filter((code) => !usableCodes.has(code));
    if (unknown.length > 0) {
      throw new JobError(`These rules are not active or not available to this client: ${unknown.join(', ')}.`);
    }
    const codes = requested.length > 0 ? requested : [...usableCodes].sort();
    if (codes.length === 0) return { asOfDate, evaluated: 0, breaches: 0, rules: [] };

    const outcomes: RuleOutcome[] = [];
    const errors: string[] = [];
    for (const ruleCode of codes) {
      const { data: runId, error } = await compliance.rpc('evaluate_rule', { p_rule_code: ruleCode, p_as_of_date: asOfDate });
      if (error || !runId) {
        errors.push(`${ruleCode}: ${error?.message || 'no run was recorded'}`);
        continue;
      }
      const { data: row } = await compliance
        .from('rule_evaluation_runs')
        .select('run_status, result_count, breach_count, error_message')
        .eq('id', runId)
        .maybeSingle();
      if (row?.run_status === 'FAILED') {
        errors.push(`${ruleCode}: ${row.error_message || 'the evaluation failed'}`);
        continue;
      }
      outcomes.push({
        ruleCode,
        runId: String(runId),
        status: row?.run_status ?? null,
        results: Number(row?.result_count) || 0,
        breaches: Number(row?.breach_count) || 0,
      });
    }

    if (errors.length > 0) {
      // Not retried: the rules that did score would be scored a second time.
      throw new JobError(`${errors.length} of ${codes.length} rules could not be scored. ${errors.join('; ')}`);
    }
    return {
      asOfDate,
      evaluated: outcomes.length,
      breaches: outcomes.reduce((sum, outcome) => sum + outcome.breaches, 0),
      rules: outcomes,
    };
  };
}

/**
 * Data loaders were replaced by feeds (see feeds.ts). A loader run fails with
 * that message and marks the loader, so the screen never shows a load that did not happen.
 */
export function loaderRunHandler(supabase: SupabaseClient, now: () => Date = () => new Date()): JobHandler {
  return async (run) => {
    const loaderId = typeof run.payload.loaderId === 'string' ? run.payload.loaderId : '';
    if (!loaderId) throw new JobError('The job has no loaderId.');
    const reason = 'Data loaders were replaced by feeds. Set this file up under Admin, Feeds.';
    const { error } = await supabase
      .schema('entity_instances')
      .from('data_loaders')
      .update({ loader_status: 'FAILED', last_run_at: now().toISOString(), last_run_result: { runId: run.id, error: reason } })
      .eq('id', loaderId);
    if (error) throw new Error(error.message);
    throw new JobError(reason);
  };
}

/** A database refusal that another attempt cannot change: no owner, or the owner lost access. */
function ownerProblem(error: { code?: string; message: string }): boolean {
  return error.code === '42501' || error.code === '22023';
}

function domainCode(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

/** The data quality dashboard's headline figures for the run's client, read as the job's owner. */
export function dqScanHandler(supabase: SupabaseClient): JobHandler {
  return async (run) => {
    const { data, error } = await supabase.rpc('job_run_dq_scan', {
      p_user_id: run.requestedBy,
      p_client_id: run.clientId,
      p_domain_code: domainCode(run.payload.domainCode),
    });
    if (error) {
      if (ownerProblem(error)) throw new JobError(error.message);
      throw new Error(error.message);
    }
    return (data || {}) as Record<string, unknown>;
  };
}

/** Counts prevailing values not received for payload.olderThanDays (default 30), read as the job's owner. */
export function staleScanHandler(supabase: SupabaseClient): JobHandler {
  return async (run) => {
    const { data, error } = await supabase.rpc('job_run_stale_scan', {
      p_user_id: run.requestedBy,
      p_client_id: run.clientId,
      p_older_than_days: wholeNumber(run.payload.olderThanDays, 30, 1, 3650),
      p_domain_code: domainCode(run.payload.domainCode),
    });
    if (error) {
      if (ownerProblem(error)) throw new JobError(error.message);
      throw new Error(error.message);
    }
    return (data || {}) as Record<string, unknown>;
  };
}

export function buildHandlers(supabase: SupabaseClient): Record<string, JobHandler> {
  return {
    'dq.scan': dqScanHandler(supabase),
    'stale.scan': staleScanHandler(supabase),
    'calc.process': calcProcessHandler(supabase),
    'compliance.evaluate': complianceEvaluateHandler(supabase),
    'loader.run': loaderRunHandler(supabase),
    'feed.poll': feedPollHandler({ supabase, loadFile: mapFileLoader(supabase) }),
    'feed.check': feedCheckHandler({ supabase }),
    'connection.check': connectionCheckHandler({ supabase }),
  };
}
