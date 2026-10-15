const STOP_WORDS = new Set(['of', 'the', 'and', 'at', 'for', 'a', 'an', 'to', 'in', 'on', 'or']);

export function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function tokensOf(value: string): string[] {
  return normalizeLabel(value)
    .split(' ')
    .filter((token) => token && !STOP_WORDS.has(token))
    .map(stemToken);
}

export function toAttributeCode(label: string): string {
  const code = normalizeLabel(label)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 100);
  if (!code) return 'LINE_ITEM';
  return /^[0-9]/.test(code) ? `A_${code}` : code;
}

export function toSectionCode(name: string): string {
  return toAttributeCode(name).slice(0, 100);
}

export function titleCaseLabel(label: string): string {
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\w\S*/g, (word) => {
      if (word === word.toUpperCase() && word.length <= 5) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
}

export function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let shared = 0;
  const seen = new Set<string>();
  for (const token of left) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (rightSet.has(token)) shared += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : shared / union;
}

export function labelsEquivalent(left: string, right: string): boolean {
  const a = tokensOf(left).join(' ');
  const b = tokensOf(right).join(' ');
  return a.length > 0 && a === b;
}

/** True when a stored alias is the same wording as a source label. */
export function labelMatchesAlias(sourceLabel: string, aliasLabels: string[]): boolean {
  return aliasLabels.some((alias) => labelsEquivalent(sourceLabel, alias) || normalizeLabel(sourceLabel) === normalizeLabel(alias));
}
