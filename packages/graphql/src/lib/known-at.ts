/**
 * Whether a row was current knowledge at a knowledge instant: recorded at or
 * before it, and not yet ended then. An open end (9999-12-31 or none) has not
 * ended.
 */
export function knownAt(systemFrom: string | null | undefined, systemTo: string | null | undefined, knowledge: string): boolean {
  const at = Date.parse(knowledge);
  if (!Number.isFinite(at)) return false;
  const from = systemFrom ? Date.parse(systemFrom) : Number.NEGATIVE_INFINITY;
  if (Number.isFinite(from) && from > at) return false;
  if (!systemTo || String(systemTo).startsWith('9999')) return true;
  const to = Date.parse(systemTo);
  return !Number.isFinite(to) || to > at;
}
