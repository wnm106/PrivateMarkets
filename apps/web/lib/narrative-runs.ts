/**
 * Which finished narrative run a reader sees, and how old it is. Pure, so it can be tested without the app.
 */

export interface RunLike {
  status: string;
  asOfDate?: string | null;
  createdAt: string;
  publishedAt?: string | null;
}

/**
 * A published run for the date wins; then the newest run for the date; then, only if nothing matches
 * the date, the published or newest run on another date, which the reader is told is a different date.
 */
export function chooseRun<T extends RunLike>(runs: T[], asOfDate: string): { run: T | null; sameDate: boolean } {
  const finished = runs.filter((r) => r.status === 'COMPLETED' || r.status === 'PARTIAL');
  const day = (r: T) => (r.asOfDate ?? '').slice(0, 10);
  const byNewest = (a: T, b: T) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0);
  const pick = (list: T[]) =>
    [...list].filter((r) => r.publishedAt).sort(byNewest)[0] ?? [...list].sort(byNewest)[0] ?? null;
  const same = pick(finished.filter((r) => day(r) === asOfDate));
  if (same) return { run: same, sameDate: true };
  return { run: pick(finished), sameDate: false };
}

/** "2 hours ago", "3 days ago", and the whole days for staleness checks. */
export function ageOf(iso: string, now: number = Date.now()): { text: string; days: number } {
  const ms = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return { text: `${days} day${days === 1 ? '' : 's'} ago`, days };
  if (hours >= 1) return { text: `${hours} hour${hours === 1 ? '' : 's'} ago`, days: 0 };
  return { text: minutes < 1 ? 'just now' : `${minutes} minute${minutes === 1 ? '' : 's'} ago`, days: 0 };
}
