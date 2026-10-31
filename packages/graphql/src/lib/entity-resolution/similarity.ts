/**
 * String similarity for entity resolution.
 * Scores are in [0, 1]. Blank input never matches.
 */

const LEGAL_SUFFIXES = new Set([
  'lp', 'lps', 'llc', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'plc', 'sa', 'gmbh', 'nv', 'bv', 'ag', 'llp',
]);

export type MatchAlgorithm = 'exact' | 'jaro_winkler' | 'levenshtein' | 'jaccard';

export const MATCH_ALGORITHMS: MatchAlgorithm[] = ['exact', 'jaro_winkler', 'levenshtein', 'jaccard'];

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !LEGAL_SUFFIXES.has(token))
    .join(' ');
}

/** Letters and digits only, uppercased. Used for tax ids, LEIs, CUSIPs, and internal keys. */
export function compactIdentifier(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function jaro(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const matchDistance = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatches = new Array<boolean>(left.length).fill(false);
  const rightMatches = new Array<boolean>(right.length).fill(false);
  let matches = 0;

  for (let i = 0; i < left.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, right.length);
    for (let j = start; j < end; j++) {
      if (rightMatches[j] || left[i] !== right[j]) continue;
      leftMatches[i] = true;
      rightMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < left.length; i++) {
    if (!leftMatches[i]) continue;
    while (!rightMatches[k]) k++;
    if (left[i] !== right[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  return (matches / left.length + matches / right.length + (matches - transpositions) / matches) / 3;
}

/** Jaro-Winkler with the standard prefix scale of 0.1 and a prefix cap of 4. */
export function jaroWinkler(left: string, right: string): number {
  const base = jaro(left, right);
  if (base === 0) return 0;
  let prefix = 0;
  const cap = Math.min(4, left.length, right.length);
  while (prefix < cap && left[prefix] === right[prefix]) prefix++;
  return base + prefix * 0.1 * (1 - base);
}

export function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const boundedLeft = left.slice(0, 256);
  const boundedRight = right.slice(0, 256);
  let previous = Array.from({ length: boundedRight.length + 1 }, (_, index) => index);
  for (let i = 1; i <= boundedLeft.length; i++) {
    const current = [i];
    for (let j = 1; j <= boundedRight.length; j++) {
      const cost = boundedLeft[i - 1] === boundedRight[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    previous = current;
  }
  return previous[boundedRight.length];
}

export function levenshteinSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  const distance = levenshteinDistance(left, right);
  const scale = Math.max(left.length, right.length);
  return scale === 0 ? 0 : 1 - distance / scale;
}

export function jaccard(left: string, right: string): number {
  const leftTokens = new Set(left.split(/\s+/).filter((token) => token.length >= 2));
  const rightTokens = new Set(right.split(/\s+/).filter((token) => token.length >= 2));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection++;
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function exactSimilarity(left: string, right: string): number {
  const a = compactIdentifier(left);
  const b = compactIdentifier(right);
  if (a.length < 2 || b.length < 2) return 0;
  return a === b ? 1 : 0;
}

/** Digits that distinguish a series, such as Fund 1 and Fund 3. */
export function seriesNumbers(value: string): string[] {
  return normalizeName(value).match(/\d+/g) || [];
}

export function conflictingSeriesNumbers(left: string, right: string): boolean {
  const a = seriesNumbers(left);
  const b = seriesNumbers(right);
  if (a.length === 0 && b.length === 0) return false;
  if (a.length !== b.length) return true;
  return a.some((number, index) => number !== b[index]);
}

export function similarity(algorithm: MatchAlgorithm, left: string, right: string): number {
  if (algorithm === 'exact') return exactSimilarity(left, right);
  if (conflictingSeriesNumbers(left, right)) return 0;
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (a.length < 4 || b.length < 4) return 0;
  if (algorithm === 'jaro_winkler') return jaroWinkler(a, b);
  if (algorithm === 'levenshtein') return levenshteinSimilarity(a, b);
  return jaccard(a, b);
}
