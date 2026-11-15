import { describe, expect, it } from 'vitest';
import { calcProcessHandler, complianceEvaluateHandler, dqScanHandler, loaderRunHandler, staleScanHandler } from './handlers';
import { toDueSchedule, toJobRun } from './store';
import { JobError, fireDueSchedules, runLoop, tick, type DueSchedule, type JobHandler, type JobRun, type JobStore } from './worker';

function run(overrides: Partial<JobRun> = {}): JobRun {
  return { id: 'run-1', clientId: 'client-a', scheduleId: null, requestedBy: 'user-1', jobType: 'test', payload: {}, attempts: 1, maxAttempts: 3, ...overrides };
}

/** A store held in memory that records what the worker asked of it. */
function memoryStore(seed: { schedules?: DueSchedule[]; runs?: JobRun[] } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const schedules = [...(seed.schedules || [])];
  const queue = [...(seed.runs || [])];
  const store: JobStore = {
    async dueSchedules() {
      return schedules;
    },
    async fireSchedule(id, expected, next, queueRun) {
      calls.push(['fire', id, expected, next, queueRun]);
      return queueRun ? `run-for-${id}` : null;
    },
    async claim(worker, limit) {
      calls.push(['claim', worker, limit]);
      return queue.splice(0, limit);
    },
    async heartbeat(runId) {
      calls.push(['heartbeat', runId]);
      return true;
    },
    async complete(runId, _worker, result) {
      calls.push(['complete', runId, result]);
      return true;
    },
    async fail(runId, _worker, error, retryable) {
      calls.push(['fail', runId, error, retryable]);
      return retryable ? 'QUEUED' : 'FAILED';
    },
  };
  return { store, calls };
}

const NOW = new Date('2026-11-14T12:00:00Z');

describe('fireDueSchedules', () => {
  it('queues a due schedule and moves it to the next slot counted from now', async () => {
    const { store, calls } = memoryStore({
      // Due since three days ago: it runs once and the next slot is tomorrow.
      schedules: [{ id: 's1', cronExpression: '0 6 * * *', timezone: 'UTC', nextRunAt: '2026-11-11T06:00:00.000Z' }],
    });
    const fired = await fireDueSchedules({ store, handlers: {}, workerName: 'w', now: () => NOW });
    expect(fired).toBe(1);
    expect(calls).toEqual([['fire', 's1', '2026-11-11T06:00:00.000Z', '2026-11-15T06:00:00.000Z', true]]);
  });

  it('gives a new schedule its first time without running it', async () => {
    const { store, calls } = memoryStore({
      schedules: [{ id: 's1', cronExpression: '0 6 * * *', timezone: 'America/New_York', nextRunAt: null }],
    });
    const fired = await fireDueSchedules({ store, handlers: {}, workerName: 'w', now: () => NOW });
    expect(fired).toBe(0);
    expect(calls).toEqual([['fire', 's1', null, '2026-11-15T11:00:00.000Z', false]]);
  });

  it('skips a schedule it cannot read and carries on', async () => {
    const { store, calls } = memoryStore({
      schedules: [
        { id: 'bad', cronExpression: 'every day', timezone: 'UTC', nextRunAt: '2026-11-14T06:00:00.000Z' },
        { id: 'good', cronExpression: '*/5 * * * *', timezone: 'UTC', nextRunAt: '2026-11-14T11:55:00.000Z' },
      ],
    });
    const logged: string[] = [];
    const fired = await fireDueSchedules({ store, handlers: {}, workerName: 'w', now: () => NOW, log: (message) => logged.push(message) });
    expect(fired).toBe(1);
    expect(calls.map((call) => call[1])).toEqual(['good']);
    expect(logged).toContain('Schedule cannot be read');
  });
});

describe('tick', () => {
  it('completes a run with the handler result', async () => {
    const { store, calls } = memoryStore({ runs: [run()] });
    const result = await tick({ store, handlers: { test: async () => ({ rows: 3 }) }, workerName: 'w' });
    expect(result).toEqual({ fired: 0, claimed: 1, succeeded: 1, failed: 0 });
    expect(calls).toContainEqual(['complete', 'run-1', { rows: 3 }]);
  });

  it('asks for a retry when a handler throws an ordinary error', async () => {
    const { store, calls } = memoryStore({ runs: [run()] });
    const handler: JobHandler = async () => {
      throw new Error('connection reset');
    };
    const result = await tick({ store, handlers: { test: handler }, workerName: 'w' });
    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(calls).toContainEqual(['fail', 'run-1', 'connection reset', true]);
  });

  it('does not retry a JobError', async () => {
    const { store, calls } = memoryStore({ runs: [run()] });
    const handler: JobHandler = async () => {
      throw new JobError('the file is not a statement');
    };
    await tick({ store, handlers: { test: handler }, workerName: 'w' });
    expect(calls).toContainEqual(['fail', 'run-1', 'the file is not a statement', false]);
  });

  it('fails a run whose job type has no handler, without a retry', async () => {
    const { store, calls } = memoryStore({ runs: [run({ jobType: 'unknown.type' })] });
    await tick({ store, handlers: {}, workerName: 'w' });
    expect(calls).toContainEqual(['fail', 'run-1', 'No handler is registered for job type "unknown.type".', false]);
  });

  it('runs claimed jobs side by side and one failure does not stop the others', async () => {
    const { store } = memoryStore({ runs: [run({ id: 'a' }), run({ id: 'b' }), run({ id: 'c' })] });
    let active = 0;
    let peak = 0;
    const handler: JobHandler = async (job) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (job.id === 'b') throw new Error('boom');
    };
    const result = await tick({ store, handlers: { test: handler }, workerName: 'w', concurrency: 3 });
    expect(result).toEqual({ fired: 0, claimed: 3, succeeded: 2, failed: 1 });
    expect(peak).toBe(3);
  });

  it('counts a run as failed when the store cannot record the outcome', async () => {
    const { store } = memoryStore({ runs: [run()] });
    store.complete = async () => {
      throw new Error('database unavailable');
    };
    const result = await tick({ store, handlers: { test: async () => ({}) }, workerName: 'w' });
    expect(result).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
  });
});

describe('runLoop', () => {
  it('keeps ticking after a failed tick and stops on the signal', async () => {
    const { store } = memoryStore();
    const stop = new AbortController();
    let claims = 0;
    store.claim = async () => {
      claims += 1;
      if (claims === 1) throw new Error('database unavailable');
      if (claims === 3) stop.abort();
      return [];
    };
    await runLoop({ store, handlers: {}, workerName: 'w', pollMs: 1, signal: stop.signal });
    expect(claims).toBe(3);
  });
});

describe('store rows', () => {
  it('reads a run and a schedule from database rows', () => {
    expect(
      toJobRun({ id: 'r', client_id: null, schedule_id: 's', job_type: 'calc.process', payload: { limit: 5 }, attempts: 2, max_attempts: 3 }),
    ).toEqual({ id: 'r', clientId: null, scheduleId: 's', requestedBy: null, jobType: 'calc.process', payload: { limit: 5 }, attempts: 2, maxAttempts: 3 });
    expect(toJobRun({ id: 'r', job_type: 't', payload: null }).payload).toEqual({});
    expect(toDueSchedule({ id: 's', cron_expression: '0 6 * * *', timezone: null, next_run_at: null })).toEqual({
      id: 's',
      cronExpression: '0 6 * * *',
      timezone: 'UTC',
      nextRunAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Handlers, against a stand-in for the Supabase client
// ---------------------------------------------------------------------------

type Reply = { data: unknown; error: { message: string; code?: string } | null };

function fakeSupabase(script: { rpc?: (fn: string, args: Record<string, unknown>) => Reply; rows?: (table: string, filters: Record<string, unknown>) => Reply }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push(['rpc', fn, args]);
      return Promise.resolve(script.rpc ? script.rpc(fn, args) : { data: null, error: null });
    },
    schema() {
      return client;
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let updated: unknown;
      const reply = () => {
        if (updated !== undefined) calls.push(['update', table, updated, { ...filters }]);
        return script.rows ? script.rows(table, filters) : { data: null, error: null };
      };
      const query = {
        select: () => query,
        update(values: unknown) {
          updated = values;
          return query;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return query;
        },
        maybeSingle: () => Promise.resolve(reply()),
        then: (resolve: (value: Reply) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(reply()).then(resolve, reject),
      };
      return query;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { supabase: client as any, calls };
}

describe('calcProcessHandler', () => {
  it('keeps going until the queue is empty and adds up the rounds', async () => {
    const rounds = [
      { processed: 500, failed: 1, pending: 700 },
      { processed: 500, failed: 0, pending: 200 },
      { processed: 200, failed: 0, pending: 0 },
    ];
    const { supabase, calls } = fakeSupabase({ rpc: () => ({ data: rounds.shift(), error: null }) });
    const result = await calcProcessHandler(supabase)(run({ payload: { limit: 500 } }));
    expect(result).toEqual({ processed: 1200, failed: 1, pending: 0, rounds: 3 });
    expect(calls[0]).toEqual(['rpc', 'process_calculated_attributes', { p_limit: 500 }]);
  });

  it('stops when a round makes no progress', async () => {
    const { supabase, calls } = fakeSupabase({ rpc: () => ({ data: { processed: 0, failed: 4, pending: 4 }, error: null }) });
    const result = await calcProcessHandler(supabase)(run());
    expect(result).toMatchObject({ pending: 4, rounds: 1 });
    expect(calls).toHaveLength(1);
  });

  it('stops at the round limit', async () => {
    const { supabase } = fakeSupabase({ rpc: () => ({ data: { processed: 10, failed: 0, pending: 99 }, error: null }) });
    const result = await calcProcessHandler(supabase)(run({ payload: { maxRounds: 2 } }));
    expect(result).toMatchObject({ processed: 20, rounds: 2 });
  });

  it('throws a retryable error when the database call fails', async () => {
    const { supabase } = fakeSupabase({ rpc: () => ({ data: null, error: { message: 'timeout' } }) });
    const failure = await calcProcessHandler(supabase)(run()).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(JobError);
  });
});

describe('complianceEvaluateHandler', () => {
  const rules = [
    { rule_code: 'SHARED_ISSUER', client_id: null },
    { rule_code: 'A_ONLY', client_id: 'client-a' },
    { rule_code: 'B_ONLY', client_id: 'client-b' },
  ];
  const today = () => new Date('2026-11-14T03:00:00Z');

  function scripted(fail: string[] = []) {
    return fakeSupabase({
      rpc: (_fn, args) =>
        fail.includes(String(args.p_rule_code))
          ? { data: null, error: { message: 'rule has no version' } }
          : { data: `eval-${args.p_rule_code}`, error: null },
      rows: (table) =>
        table === 'rules'
          ? { data: rules, error: null }
          : { data: { run_status: 'COMPLETED', result_count: 4, breach_count: 1, error_message: null }, error: null },
    });
  }

  it('scores shared rules and the client\'s own, as of today', async () => {
    const { supabase, calls } = scripted();
    const result = await complianceEvaluateHandler(supabase, today)(run());
    expect(result).toMatchObject({ asOfDate: '2026-11-14', evaluated: 2, breaches: 2 });
    const scored = calls.filter((call) => call[0] === 'rpc').map((call) => (call[2] as { p_rule_code: string }).p_rule_code);
    expect(scored).toEqual(['A_ONLY', 'SHARED_ISSUER']);
  });

  it('scores every active rule for a platform run', async () => {
    const { supabase } = scripted();
    const result = await complianceEvaluateHandler(supabase, today)(run({ clientId: null }));
    expect(result).toMatchObject({ evaluated: 3 });
  });

  it('scores only the rules asked for, on the date asked for', async () => {
    const { supabase, calls } = scripted();
    await complianceEvaluateHandler(supabase, today)(run({ payload: { ruleCodes: ['SHARED_ISSUER'], asOfDate: '2026-09-30' } }));
    expect(calls.filter((call) => call[0] === 'rpc')).toEqual([
      ['rpc', 'evaluate_rule', { p_rule_code: 'SHARED_ISSUER', p_as_of_date: '2026-09-30' }],
    ]);
  });

  it('refuses another client\'s rule and a bad date without scoring anything', async () => {
    const { supabase, calls } = scripted();
    await expect(complianceEvaluateHandler(supabase, today)(run({ payload: { ruleCodes: ['B_ONLY'] } }))).rejects.toThrow(/B_ONLY/);
    await expect(complianceEvaluateHandler(supabase, today)(run({ payload: { asOfDate: '30/09/2026' } }))).rejects.toThrow(/YYYY-MM-DD/);
    expect(calls.filter((call) => call[0] === 'rpc')).toHaveLength(0);
  });

  it('scores the rest when one rule fails, then fails the job without a retry', async () => {
    const { supabase, calls } = scripted(['A_ONLY']);
    const failure = await complianceEvaluateHandler(supabase, today)(run()).catch((error) => error);
    expect(failure).toBeInstanceOf(JobError);
    expect(failure.retryable).toBe(false);
    expect(failure.message).toMatch(/1 of 2 rules could not be scored\. A_ONLY: rule has no version/);
    expect(calls.filter((call) => call[0] === 'rpc')).toHaveLength(2);
  });
});

describe('loaderRunHandler', () => {
  it('marks the loader failed and fails the job without a retry', async () => {
    const { supabase, calls } = fakeSupabase({});
    const failure = await loaderRunHandler(supabase, () => NOW)(run({ payload: { loaderId: 'loader-1' } })).catch((error) => error);
    expect(failure).toBeInstanceOf(JobError);
    expect(failure.message).toMatch(/replaced by feeds/);
    expect(calls).toEqual([
      [
        'update',
        'data_loaders',
        { loader_status: 'FAILED', last_run_at: NOW.toISOString(), last_run_result: { runId: 'run-1', error: failure.message } },
        { id: 'loader-1' },
      ],
    ]);
  });

  it('needs a loader id', async () => {
    const { supabase } = fakeSupabase({});
    await expect(loaderRunHandler(supabase)(run())).rejects.toThrow(/no loaderId/);
  });
});

describe('dqScanHandler and staleScanHandler', () => {
  it('runs the data quality report as the job owner for the job client', async () => {
    const { supabase, calls } = fakeSupabase({ rpc: () => ({ data: { summary: { failingChecks: 7 } }, error: null }) });
    const result = await dqScanHandler(supabase)(run({ payload: { domainCode: ' fund ' } }));
    expect(result).toEqual({ summary: { failingChecks: 7 } });
    expect(calls).toEqual([['rpc', 'job_run_dq_scan', { p_user_id: 'user-1', p_client_id: 'client-a', p_domain_code: 'FUND' }]]);
  });

  it('passes the age for a stale scan and defaults it to 30 days', async () => {
    const { supabase, calls } = fakeSupabase({ rpc: () => ({ data: { count: 3 }, error: null }) });
    await staleScanHandler(supabase)(run({ payload: { olderThanDays: 90 } }));
    await staleScanHandler(supabase)(run());
    expect(calls.map((call) => (call[2] as { p_older_than_days: number }).p_older_than_days)).toEqual([90, 30]);
  });

  it('does not retry when the owner has lost access, and retries anything else', async () => {
    const refused = fakeSupabase({
      rpc: () => ({ data: null, error: { code: '42501', message: 'The person who scheduled this job no longer belongs to this client' } }),
    });
    const denied = await dqScanHandler(refused.supabase)(run()).catch((error) => error);
    expect(denied).toBeInstanceOf(JobError);
    expect(denied.message).toMatch(/no longer belongs/);

    const slow = fakeSupabase({ rpc: () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) });
    const timedOut = await staleScanHandler(slow.supabase)(run()).catch((error) => error);
    expect(timedOut).toBeInstanceOf(Error);
    expect(timedOut).not.toBeInstanceOf(JobError);
  });
});
