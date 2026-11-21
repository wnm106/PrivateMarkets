import { nextCronRun } from '@tapestrai/graphql/src/lib/cron';

/**
 * The job worker. One tick fires the schedules that are due, claims queued runs,
 * runs each with its handler, and reports the outcome.
 *
 * Nothing here talks to the database directly. The store does, so the loop can
 * be tested with a store held in memory.
 */

export interface JobRun {
  id: string;
  clientId: string | null;
  scheduleId: string | null;
  /** The person the job runs for: the schedule's creator, or whoever queued the run. */
  requestedBy: string | null;
  jobType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface DueSchedule {
  id: string;
  cronExpression: string;
  timezone: string;
  /** Null for a schedule that has never been given a next run. */
  nextRunAt: string | null;
}

export interface JobStore {
  dueSchedules(now: Date): Promise<DueSchedule[]>;
  /** Advances the schedule if nextRunAt is still `expected`. Returns the queued run id, or null. */
  fireSchedule(id: string, expected: string | null, next: string | null, queue: boolean): Promise<string | null>;
  claim(worker: string, limit: number, leaseSeconds: number): Promise<JobRun[]>;
  heartbeat(runId: string, worker: string, leaseSeconds: number): Promise<boolean>;
  complete(runId: string, worker: string, result: Record<string, unknown>): Promise<boolean>;
  /** Returns the run's new status, or null when this worker no longer holds it. */
  fail(runId: string, worker: string, error: string, retryable: boolean): Promise<string | null>;
}

export type JobResult = Record<string, unknown>;

/** What a handler is told about its claim on the run. */
export interface JobContext {
  /**
   * Aborts when this worker no longer holds the run: another worker has claimed
   * it, or the claim could not be renewed. A handler that does more than one
   * thing calls signal.throwIfAborted() before each step that changes or sends
   * something, so a run another worker has picked up is not carried out twice.
   */
  signal: AbortSignal;
}

export type JobHandler = (run: JobRun, job?: JobContext) => Promise<JobResult | void>;

/** Throw this from a handler when trying again cannot help. */
export class JobError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'JobError';
    this.retryable = options.retryable ?? false;
  }
}

/** What signal.throwIfAborted() throws once the claim is lost. No outcome is recorded for the run. */
export class LeaseLostError extends Error {
  constructor() {
    super('This worker no longer holds the run.');
    this.name = 'LeaseLostError';
  }
}

export interface WorkerOptions {
  store: JobStore;
  handlers: Record<string, JobHandler>;
  /**
   * Who holds a claim. Every process needs its own: the store accepts a heartbeat
   * or an outcome only from the name the run is claimed by, so two processes
   * sharing one name could each finish a run the other holds.
   */
  workerName: string;
  /** Runs claimed per tick. They run side by side. */
  concurrency?: number;
  /** How long a claim holds before another worker may take the run. */
  leaseSeconds?: number;
  now?: () => Date;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface TickResult {
  fired: number;
  claimed: number;
  succeeded: number;
  failed: number;
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_LEASE_SECONDS = 300;

function message(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : 'The job failed';
}

/** Queues a run for each schedule that is due and moves the schedule to its next time. */
export async function fireDueSchedules(options: WorkerOptions): Promise<number> {
  const now = (options.now || (() => new Date()))();
  const log = options.log || (() => undefined);
  let fired = 0;
  for (const schedule of await options.store.dueSchedules(now)) {
    let next: string | null = null;
    try {
      // The next run is counted from now, not from the missed time. After an
      // outage a schedule runs once, not once for every slot it missed.
      next = nextCronRun(schedule.cronExpression, now, schedule.timezone)?.toISOString() || null;
    } catch (error) {
      log('Schedule cannot be read', { scheduleId: schedule.id, error: message(error) });
      continue;
    }
    // A schedule with no next run yet is only given one. It runs when that time comes.
    const queue = schedule.nextRunAt !== null;
    const runId = await options.store.fireSchedule(schedule.id, schedule.nextRunAt, next, queue);
    if (runId) {
      fired += 1;
      log('Schedule fired', { scheduleId: schedule.id, runId, next });
    }
  }
  return fired;
}

/** `claimedAt` is when the claim was asked for: the lease is counted from no later than that. */
async function runOne(run: JobRun, options: WorkerOptions, claimedAt = Date.now()): Promise<boolean> {
  const { store, workerName } = options;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const log = options.log || (() => undefined);
  const handler = options.handlers[run.jobType];
  if (!handler) {
    await store.fail(run.id, workerName, `No handler is registered for job type "${run.jobType}".`, false);
    log('Run failed', { runId: run.id, jobType: run.jobType, error: 'no handler' });
    return false;
  }

  // Keep the claim alive while a long job runs, and tell the handler when it is gone.
  // Once the lease runs out another worker claims the run, so carrying on would run the job twice.
  const leaseMs = leaseSeconds * 1000;
  const beatMs = Math.max(1000, Math.floor(leaseMs / 3));
  // The handler is told this long before the lease could run out, so it can stop before anyone else may claim the run.
  const marginMs = Math.floor(beatMs / 2);
  const lost = new AbortController();
  const lose = (reason: string) => {
    if (lost.signal.aborted) return;
    lost.abort(new LeaseLostError());
    log('Run claim lost', { runId: run.id, jobType: run.jobType, reason });
  };
  // Counted from the last time the claim was known to hold: when it was asked for, or when a beat that
  // was then answered yes was sent. A beat that fails or never answers moves nothing, so a store that
  // stops answering still ends the run in time. One missed beat is survived; the next one must get through.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const heldAt = (at: number) => {
    clearTimeout(deadline);
    deadline = setTimeout(() => lose('the claim could not be renewed in time'), Math.max(0, at + leaseMs - marginMs - Date.now()));
  };
  heldAt(claimedAt);
  const beat = setInterval(() => {
    if (lost.signal.aborted) return;
    const sentAt = Date.now();
    store.heartbeat(run.id, workerName, leaseSeconds).then(
      (held) => {
        if (lost.signal.aborted) return;
        if (held) heldAt(sentAt);
        else lose('another worker holds the run');
      },
      () => undefined,
    );
  }, beatMs);

  try {
    const result = (await handler(run, { signal: lost.signal })) || {};
    // Not this worker's run any more: whoever holds it now records the outcome.
    if (lost.signal.aborted) return false;
    const held = await store.complete(run.id, workerName, result);
    log(held ? 'Run succeeded' : 'Run finished after its claim was lost', { runId: run.id, jobType: run.jobType });
    return held;
  } catch (error) {
    if (lost.signal.aborted) return false;
    const retryable = error instanceof JobError ? error.retryable : true;
    const status = await store.fail(run.id, workerName, message(error), retryable);
    log('Run failed', { runId: run.id, jobType: run.jobType, error: message(error), status });
    return false;
  } finally {
    clearInterval(beat);
    clearTimeout(deadline);
  }
}

export async function tick(options: WorkerOptions): Promise<TickResult> {
  const fired = await fireDueSchedules(options);
  const claimedAt = Date.now();
  const runs = await options.store.claim(
    options.workerName,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
  );
  const outcomes = await Promise.all(
    runs.map((run) =>
      runOne(run, options, claimedAt).catch((error) => {
        // The store itself failed. The lease will expire and the run is claimed again.
        (options.log || (() => undefined))('Run outcome could not be recorded', { runId: run.id, error: message(error) });
        return false;
      }),
    ),
  );
  const succeeded = outcomes.filter(Boolean).length;
  return { fired, claimed: runs.length, succeeded, failed: runs.length - succeeded };
}

export interface LoopOptions extends WorkerOptions {
  /** Wait between ticks when the queue was empty. */
  pollMs?: number;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Ticks until the signal aborts. A tick in progress finishes first. */
export async function runLoop(options: LoopOptions): Promise<void> {
  const pollMs = options.pollMs ?? 5000;
  const log = options.log || (() => undefined);
  while (!options.signal?.aborted) {
    let busy = false;
    try {
      const result = await tick(options);
      busy = result.claimed > 0;
    } catch (error) {
      log('Tick failed', { error: message(error) });
    }
    if (!busy) await sleep(pollMs, options.signal);
  }
}
