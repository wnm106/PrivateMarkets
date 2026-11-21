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
| `dq.scan` | One client | `domainCode` (optional) | The data quality dashboard's headline figures, and how many records began failing since the day before. Those are also recorded as a `DQ_NEW_FAILURES` event, which workflow triggers can start from |
| `stale.scan` | One client | `olderThanDays` (default 30), `domainCode` (optional) | Count of stale values and the 25 oldest |
| `feed.poll` | One client | `feedId` | Files seen, loaded, duplicates, needing review, failed. See [FEEDS.md](FEEDS.md) |
| `feed.check` | One client | none | Fails and names the feeds whose file is late |
| `connection.check` | One client | `connectionId` | Whether the connection can be reached |
| `email.screen` | One client | `messageId` | The verdict on one email sent to an email connection (accepted, quarantined, rejected), how many attachments were taken, and how many polls were queued. Queued when an email arrives or is released. Not put on a schedule. A quarantined email fails the run so it is seen. See [FEEDS.md](FEEDS.md#inbound-email) |
| `loader.run` | One client | `loaderId` | Always fails: data loaders were replaced by feeds |
| `assistant.sweep` | One client | none | How many people were due for a summary, and how many urgent notes were queued. Created when someone turns the assistant on. One per client is enough. |
| `assistant.brief` | One client | none | Whether a summary was written, and how many changes it included. Not put on a schedule. Queued for one person by the sweep, or when they ask for a summary now. |
| `assistant.watch` | One client | none | The same, for a change they asked to hear about right away. Not put on a schedule. |
| `workflow.start` | One client | `workflowCode`, `input` (optional) | The run it started. See [WORKFLOWS.md](WORKFLOWS.md) |
| `workflow.advance` | One client | none | Where the run got to: finished, failed, or waiting for a person. Not put on a schedule. Queued when a run starts and when a review is decided. |
| `workflow.reviews_due` | Platform | none | How many reviews, forms (`overdueForms`) and screens (`overdueStages`) became overdue, how many people were told, and how many undelivered notes were queued again. Runs every 15 minutes from the `WORKFLOW_REVIEWS_DUE` schedule, which the migration creates. |
| `workflow.triggers` | Platform | none | How many triggers were checked, how many started a run, and how many were waiting on a run already going. Queued when a feed or data quality scan event is written, and every 5 minutes from the `WORKFLOW_TRIGGERS` schedule, which the migration creates. See [WORKFLOWS.md](WORKFLOWS.md). |
| `notify.deliver` | One client | `eventId` | How many emails and Slack posts were sent, and what was skipped and why. Queued with each review notice when the client sends by email or Slack. Not put on a schedule. A failed send fails the run so it is tried again; what was sent is not sent twice. |

`assistant.brief` and `assistant.watch` run as the person the note is for. See [who a job runs as](#who-a-job-runs-as). What they follow, and when the summary is sent, is set at Assistant, not on this page. A summary is not sent when nothing they follow has changed.

A platform schedule has no client and only a tenant admin can create one. Compliance is a platform job because a rule is scored for every fund it covers, in every client.

## Who a job runs as

The worker uses the service role. `calc.process` and `compliance.evaluate` call functions that need no signed-in user.

`dq.scan` and `stale.scan` read reports that decide access from who is signed in. They run as the job's owner: the person who created the schedule, or who pressed Run now. The owner must still belong to the job's client, belong to no other client, and hold `entity.read` there. Otherwise the run fails with that reason and is not retried. To change the owner, delete the schedule and have the new owner create it.

`assistant.brief` and `assistant.watch` run the same way, as the person the note is for. The sweep does not read their records. It only queues the run.

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
