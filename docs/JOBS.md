# Jobs

Jobs are work that runs without anyone signed in: on a schedule, or queued on request. Schedules and run history are at `/admin/jobs`.

## Parts

| Part | Where | What it does |
|---|---|---|
| Queue and schedules | `supabase/migrations/20261114190000_job_backbone.sql` | `ops.job_schedules` and `ops.job_runs`, reached only through the `job_*` functions |
| Run-as | `supabase/migrations/20261114200000_job_run_as.sql` | Lets a job read reports as its owner |
| Worker | `packages/worker` | Fires due schedules, claims runs, runs the handler, records the outcome |
| Job types | `packages/graphql/src/lib/job-types.ts` | The list the API accepts. The worker has one handler per code |
| API | `packages/graphql/src/resolvers/jobs.ts` | `jobTypes`, `jobSchedules`, `jobRuns`, and the mutations the page uses |

## Running the worker

Nothing runs until a worker is running. It needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, from the environment or the repository `.env`.

```bash
npm run start --workspace @tapestrai/worker
```

That keeps working until stopped (Ctrl+C lets the current jobs finish). For a host that only offers a cron trigger, run one pass a minute instead:

```bash
npm run tick --workspace @tapestrai/worker
```

Several workers can run at once. A schedule fires once and a run is claimed once.

Optional settings: `WORKER_CONCURRENCY` (runs side by side, default 5), `WORKER_LEASE_SECONDS` (how long a claim holds, default 300), `WORKER_POLL_MS` (wait when the queue is empty, default 5000), `WORKER_NAME`.

## Job types

| Code | Belongs to | Settings | Result |
|---|---|---|---|
| `calc.process` | Platform | `limit` (batch size, default 500), `maxRounds` (default 20) | Processed, failed, still pending |
| `compliance.evaluate` | Platform | `ruleCodes` (leave out for every active rule), `asOfDate` (default today) | Results and breaches per rule |
| `dq.scan` | One client | `domainCode` (optional) | The data quality dashboard's headline figures |
| `stale.scan` | One client | `olderThanDays` (default 30), `domainCode` (optional) | Count of stale values and the 25 oldest |
| `loader.run` | One client | `loaderId` | Fails until connectors are built |

A platform schedule has no client and only a tenant admin can create one. Compliance is a platform job because a rule is scored for every fund it covers, in every client.

## Who a job runs as

The worker uses the service role. `calc.process` and `compliance.evaluate` call functions that need no signed-in user.

`dq.scan` and `stale.scan` read reports that decide access from who is signed in. They run as the job's owner: the person who created the schedule, or who pressed Run now. The owner must still belong to the job's client, belong to no other client, and hold `entity.read` there. Otherwise the run fails with that reason and is not retried. To change the owner, delete the schedule and have the new owner create it.

## Retries

A failed run waits 30 seconds, then twice as long each time up to an hour, until its attempts are used. Then it is `FAILED` and stays that way until someone presses Retry. A handler throws `JobError` when another attempt cannot help; that fails the run at once.

A worker that dies mid-run loses its claim when the lease expires, and another worker picks the run up.

After an outage a schedule runs once, not once for every slot it missed. A schedule whose last run is still queued or running skips its next slot.

## Permissions

`job.manage` lets a person create and change schedules, queue jobs, and retry or cancel runs for their client. Client admins have it. Any member of a client can see that client's schedules and runs.

## Adding a job type

1. Add it to `JOB_TYPES` in `packages/graphql/src/lib/job-types.ts`.
2. Write a handler in `packages/worker/src/handlers.ts` and register it in `buildHandlers`.
3. Return a small JSON result. It is stored on the run and shown in the history.
