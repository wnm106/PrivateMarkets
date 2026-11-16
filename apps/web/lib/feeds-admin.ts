import { nextCronRun } from '@tapestrai/graphql/src/lib/cron';

/** Helpers for the admin feeds page. */

export interface FeedRow {
  id: string;
  connectionId: string;
  connectionName: string;
  connectionKind: string;
  feedCode: string;
  feedName: string;
  path: string;
  filePattern: string;
  mapCode: string;
  sourceCode: string | null;
  isActive: boolean;
  pollCron: string | null;
  pollTimezone: string | null;
  nextPollAt: string | null;
  expectedCron: string | null;
  expectedTimezone: string;
  graceMinutes: number;
  lastPolledAt: string | null;
  lastReceivedAt: string | null;
  lastFileName: string | null;
  lastFileStatus: string | null;
  lastFileMessage: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  LOADING: 'Loading',
  LOADED: 'Loaded',
  NEEDS_REVIEW: 'Needs review',
  FAILED: 'Failed',
};

export function feedStatusLabel(status: string | null): string {
  return status ? STATUS_LABEL[status] || status : '';
}

export function fileSize(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Whether the feed's expected file is overdue. This is the same rule the Late
 * file check job uses, without the "never received" case: a feed that has
 * never had a file is shown as such, not as late.
 */
export function isLate(feed: Pick<FeedRow, 'isActive' | 'expectedCron' | 'expectedTimezone' | 'graceMinutes' | 'lastReceivedAt'>, now: Date): boolean {
  if (!feed.isActive || !feed.expectedCron || !feed.lastReceivedAt) return false;
  try {
    const expected = nextCronRun(feed.expectedCron, new Date(feed.lastReceivedAt), feed.expectedTimezone || 'UTC');
    return Boolean(expected) && expected!.getTime() + feed.graceMinutes * 60_000 < now.getTime();
  } catch {
    return false;
  }
}
