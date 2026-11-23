/** Pairs a person marked "Not the same" on the duplicates page. Kept in this browser only. */
export const DISMISS_KEY = 'tapestrai.merge.dismissed';

/** One key per pair, whichever side is left. */
export function pairKey(candidate: { left: { id: string }; right: { id: string } }) {
  return candidate.left.id < candidate.right.id
    ? `${candidate.left.id}:${candidate.right.id}`
    : `${candidate.right.id}:${candidate.left.id}`;
}

export function readDismissed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

/** How many of a record's candidate pairs are still open, leaving out the ones dismissed. */
export function openPairCount(candidates: ReadonlyArray<{ left: { id: string }; right: { id: string } }>, dismissed: ReadonlySet<string>) {
  return new Set(candidates.map(pairKey).filter((key) => !dismissed.has(key))).size;
}
