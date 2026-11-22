import { randomBytes } from 'node:crypto';
import { config } from 'dotenv';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { buildHandlers } from './handlers';
import { supabaseJobStore } from './store';
import { runLoop, tick, type WorkerOptions } from './worker';

/**
 * Runs the job worker.
 *
 *   npm run start --workspace @tapestrai/worker    keep working until stopped
 *   npm run tick --workspace @tapestrai/worker     one pass, for an external cron
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment, or from
 * the repository .env file. WORKER_CONCURRENCY, WORKER_LEASE_SECONDS and
 * WORKER_POLL_MS are optional.
 */

config({ path: resolve(__dirname, '../../../.env') });
config();

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const options: WorkerOptions = {
    store: supabaseJobStore(supabase),
    handlers: buildHandlers(supabase),
    // WORKER_NAME is a label. The suffix keeps it unique to this process, so replicas started with the
    // same WORKER_NAME (or the same host name and process id, as containers often are) never share a claim.
    workerName: `${process.env.WORKER_NAME || hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`,
    concurrency: positive(process.env.WORKER_CONCURRENCY, 5),
    leaseSeconds: positive(process.env.WORKER_LEASE_SECONDS, 300),
    log: (message, detail) => console.log(JSON.stringify({ at: new Date().toISOString(), message, ...detail })),
  };

  if (process.argv.includes('--once')) {
    const result = await tick(options);
    options.log?.('Tick finished', { ...result });
    return;
  }

  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      options.log?.('Stopping after the current jobs finish', { signal });
      stop.abort();
    });
  }
  options.log?.('Worker started', { worker: options.workerName, database: new URL(url).host });
  await runLoop({ ...options, pollMs: positive(process.env.WORKER_POLL_MS, 5000), signal: stop.signal });
  options.log?.('Worker stopped');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
