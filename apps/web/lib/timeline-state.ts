export type TimelineState = 'upcoming' | 'effective' | 'past' | 'replaced';

/**
 * Where one stored version sits against the As Of day. A version a later write replaced is no
 * longer believed at all. One that starts after As Of is scheduled and not yet effective.
 */
export function timelineState(
  entry: { validFrom: string; validTo?: string | null; current?: boolean | null },
  asOfDay: string,
): TimelineState {
  if (entry.current === false) return 'replaced';
  if (!asOfDay) return 'effective';
  const day = asOfDay.slice(0, 10);
  if (entry.validFrom.slice(0, 10) > day) return 'upcoming';
  if (entry.validTo && entry.validTo.slice(0, 10) < day) return 'past';
  return 'effective';
}
