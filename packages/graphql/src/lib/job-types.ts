/**
 * The job types the worker can run. The worker registers one handler per code,
 * and the API refuses a schedule for a code that is not listed here.
 *
 * scope says who a job belongs to:
 *   PLATFORM  not per client. Scheduled without a client, by a tenant admin.
 *   CLIENT    always for one client.
 *   ANY       either.
 */

export type JobScope = 'PLATFORM' | 'CLIENT' | 'ANY';

export interface JobTypeDef {
  code: string;
  label: string;
  description: string;
  scope: JobScope;
  /** Shown in the schedule form as the starting payload. */
  payloadExample: Record<string, unknown>;
  /**
   * False for a job the worker queues itself. It stays out of the schedule
   * form. Omitted means a person can put it on a cron.
   */
  schedulable?: boolean;
}

export const JOB_TYPES: readonly JobTypeDef[] = [
  {
    code: 'calc.process',
    label: 'Process calculated attributes',
    description: 'Works through the queue of calculated attributes waiting to be refreshed.',
    scope: 'PLATFORM',
    payloadExample: { limit: 500 },
  },
  {
    code: 'compliance.evaluate',
    label: 'Evaluate compliance rules',
    description:
      'Scores active compliance rules as of the run date. Leave ruleCodes out to score every active rule. A rule is scored for every fund it covers, in every client, so this is a platform job.',
    scope: 'PLATFORM',
    payloadExample: { ruleCodes: [] },
  },
  {
    code: 'dq.scan',
    label: 'Data quality scan',
    description:
      "Records the data quality dashboard's headline figures: availability, failing checks, and what changed since the day before. Runs as the person who created the schedule, who must belong to this client only.",
    scope: 'CLIENT',
    payloadExample: { domainCode: '' },
  },
  {
    code: 'stale.scan',
    label: 'Stale data scan',
    description:
      'Counts values that have not been received for olderThanDays and lists the oldest. Runs as the person who created the schedule, who must belong to this client only.',
    scope: 'CLIENT',
    payloadExample: { olderThanDays: 30 },
  },
  {
    code: 'loader.run',
    label: 'Run a data loader',
    description: 'Data loaders were replaced by feeds, so this job fails with that message. Use a feed instead.',
    scope: 'CLIENT',
    payloadExample: { loaderId: '' },
  },
  {
    code: 'feed.poll',
    label: 'Poll a feed',
    description: 'Looks for the feed\'s files and loads each new one through its saved map. Set up from Admin, Feeds.',
    scope: 'CLIENT',
    payloadExample: { feedId: '' },
  },
  {
    code: 'feed.check',
    label: 'Late file check',
    description: 'Fails when a feed has not received the file it expects by its deadline, and names the feeds that are late.',
    scope: 'CLIENT',
    payloadExample: {},
  },
  {
    code: 'connection.check',
    label: 'Check a connection',
    description: 'Confirms a feed connection can be reached with its stored credential.',
    scope: 'CLIENT',
    payloadExample: { connectionId: '' },
  },
  {
    code: 'assistant.sweep',
    label: 'Assistant summaries',
    description:
      'Looks for people whose summary is due, and for urgent changes still waiting. Created when someone turns the assistant on. One per client is enough.',
    scope: 'CLIENT',
    payloadExample: {},
  },
  {
    code: 'assistant.brief',
    label: 'Assistant brief',
    description: 'Writes one person a summary of what they follow. Queued by the assistant sweep, or when they ask for a summary now.',
    scope: 'CLIENT',
    payloadExample: {},
    schedulable: false,
  },
  {
    code: 'assistant.watch',
    label: 'Assistant watch',
    description: 'Writes one person an immediate note about a change they asked to hear about right away.',
    scope: 'CLIENT',
    payloadExample: {},
    schedulable: false,
  },
  {
    code: 'workflow.start',
    label: 'Start a workflow',
    description:
      'Starts a run of a published workflow. workflowCode names it; input is what the run starts with. The run belongs to the person who created the schedule, who must be allowed to run workflows. See docs/WORKFLOWS.md.',
    scope: 'CLIENT',
    payloadExample: { workflowCode: '', input: {} },
  },
  {
    code: 'workflow.reviews_due',
    label: 'Overdue workflow reviews',
    description:
      'Tells the reviewers, and any role the step escalates to, once a workflow review passes its due date. Also sends again any review note that was not delivered. Runs every 15 minutes for every client, from a platform schedule the migration creates.',
    scope: 'PLATFORM',
    payloadExample: {},
  },
  {
    code: 'workflow.triggers',
    label: 'Workflow triggers',
    description:
      'Starts a workflow run for each trigger whose feed events or new data quality failures have arrived, one run for everything new since it last fired. Queued when a feed or scan event is written, and every 5 minutes from a platform schedule the migration creates.',
    scope: 'PLATFORM',
    payloadExample: {},
  },
  {
    code: 'workflow.advance',
    label: 'Advance a workflow run',
    description: 'Moves one workflow run forward until it finishes, fails, or waits for a person. Queued when a run starts and when a review is decided.',
    scope: 'CLIENT',
    payloadExample: {},
    schedulable: false,
  },
];

export function jobType(code: string): JobTypeDef | null {
  return JOB_TYPES.find((type) => type.code === code) || null;
}

/** Returns a message when the job type cannot be used for this client, or null when it can. */
export function jobScopeProblem(code: string, clientId: string | null): string | null {
  const type = jobType(code);
  if (!type) return `"${code}" is not a job type.`;
  if (type.scope === 'PLATFORM' && clientId) return `${type.label} is a platform job and cannot belong to a client.`;
  if (type.scope === 'CLIENT' && !clientId) return `${type.label} needs a client.`;
  return null;
}

/** Returns a message when this type cannot be put on a schedule, or null when it can. */
export function jobScheduleProblem(code: string, clientId: string | null): string | null {
  const scope = jobScopeProblem(code, clientId);
  if (scope) return scope;
  const type = jobType(code);
  if (type && type.schedulable === false) {
    return `${type.label} runs when someone is due. It is not put on a schedule from this page.`;
  }
  return null;
}
