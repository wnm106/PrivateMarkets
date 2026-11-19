/**
 * A person's universe on the home page: the records they follow and the ones
 * they are responsible for. When they have one, the page can be narrowed to it
 * ("My records") or left on everything. Everything here is pure.
 */

import type { NeedsYouItem, ReviewSource } from './home';

export interface Universe {
  /** False when the person follows no record and is responsible for nothing. */
  hasAny: boolean;
  followed: number;
  responsibleRecords: number;
  responsibleDomains: string[];
  /** The open reviews that are the person's business. */
  reviewIds: string[];
}

export const UNIVERSE_QUERY = `query HomeUniverse { myUniverse { hasAny followed responsibleRecords responsibleDomains reviewIds } }`;

export type HomeScope = 'mine' | 'all';

export const HOME_SCOPE_KEY = 'home-scope';

/** The scope a saved choice means. Anything but "all" is "mine": the narrower view is the default. */
export function parseScope(saved: string | null | undefined): HomeScope {
  return saved === 'all' ? 'all' : 'mine';
}

/** Whether the page is narrowed. It is only when there is a universe to narrow to. */
export function isNarrowed(universe: Universe | null, scope: HomeScope): boolean {
  return Boolean(universe?.hasAny) && scope === 'mine';
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** What the universe is made of, in a sentence fragment: "2 records you follow, 1 you are responsible for, and every ISSUER". */
export function universeLabel(universe: Universe): string {
  const parts: string[] = [];
  if (universe.followed > 0) parts.push(`${plural(universe.followed, 'record')} you follow`);
  if (universe.responsibleRecords > 0) parts.push(`${universe.followed > 0 ? universe.responsibleRecords : plural(universe.responsibleRecords, 'record')} you are responsible for`);
  if (universe.responsibleDomains.length > 0) parts.push(`every ${universe.responsibleDomains.join(' and ')}`);
  if (parts.length === 0) return 'nothing yet';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')}${parts.length > 2 ? ',' : ''} and ${parts[parts.length - 1]}`;
}

export interface Narrowed {
  items: NeedsYouItem[];
  reviews: ReviewSource[];
  /** Reviews left out because they are not the person's business. */
  hiddenReviews: number;
}

/**
 * The waiting list narrowed to a universe. Only reviews are narrowed: a review
 * is about particular records, so it can be someone else's. A failed file, job,
 * or run of the person's own is not about a record and always stays.
 */
export function narrowNeedsYou(items: readonly NeedsYouItem[], reviews: readonly ReviewSource[], reviewIds: readonly string[], narrowed: boolean): Narrowed {
  if (!narrowed) return { items: [...items], reviews: [...reviews], hiddenReviews: 0 };
  const mine = new Set(reviewIds);
  const keptItems = items.filter((item) => item.kind !== 'review' || mine.has(item.id.slice('review-'.length)));
  return {
    items: keptItems,
    reviews: reviews.filter((review) => mine.has(review.id)),
    hiddenReviews: items.length - keptItems.length,
  };
}
