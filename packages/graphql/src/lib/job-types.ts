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
