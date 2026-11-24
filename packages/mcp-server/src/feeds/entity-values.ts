import { domainLabel, type ColumnAssignment } from './suggest';

/**
 * Knowing which stored records a file's values name. A column of "Halyard Systems" is a column of
 * issuers because a stored issuer has that name, whatever the column is called.
 * Scoring here is pure. The lookup that fetches stored records is in import-document.ts.
 */

export interface StoredHit {
  id: string;
  code: string;
  name: string;
  domainCode: string;
  /** The other name that matched, when it was not the record's own. */
  alias: string | null;
}

export interface ScoredHit extends StoredHit {
  /** 0 to 1. How surely this record is the one the value names. */
  confidence: number;
  how: string;
}

const COMPANY_WORDS = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'lp', 'llp', 'ltd', 'limited', 'plc', 'gmbh', 'sa', 'the']);

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !COMPANY_WORDS.has(word))
    .join(' ');
}

/** How surely a stored record is what a value names. Exact code and exact name are near certain. */
export function scoreHit(value: string, hit: StoredHit): { confidence: number; how: string } {
  const text = value.trim();
  const lower = text.toLowerCase();
  if (!text) return { confidence: 0, how: '' };
  if (hit.code.toLowerCase() === lower) return { confidence: 1, how: 'its code is exactly this value' };
  if (hit.name.toLowerCase() === lower) return { confidence: 0.97, how: 'its name is exactly this value' };
  if (hit.alias && hit.alias.toLowerCase() === lower) return { confidence: 0.94, how: `it is also known as “${hit.alias}”` };
  const wanted = normalizeName(text);
  if (wanted && normalizeName(hit.name) === wanted) return { confidence: 0.92, how: 'its name is this value apart from a suffix such as Inc or LLC' };
  if (wanted && hit.alias && normalizeName(hit.alias) === wanted) return { confidence: 0.88, how: `it is also known as “${hit.alias}”` };
  const candidate = normalizeName(hit.name);
  // One name inside the other, such as "Halyard" and "Halyard Systems", is a lead for a person or agent to check.
  if (wanted.length >= 4 && candidate.length >= 4 && (candidate.includes(wanted) || wanted.includes(candidate))) {
    return { confidence: Math.min(0.7, 0.45 + 0.25 * (Math.min(wanted.length, candidate.length) / Math.max(wanted.length, candidate.length))), how: 'its name contains or is contained by this value' };
  }
  return { confidence: 0, how: '' };
}

/** Records the value could be, best first. Records that do not resemble the value are dropped. */
export function rankHits(value: string, hits: StoredHit[]): ScoredHit[] {
  return hits
    .map((hit) => ({ ...hit, ...scoreHit(value, hit) }))
    .filter((hit) => hit.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** A value that cannot be a name: a number, a date, or too long to be one. */
export function couldBeName(value: string): boolean {
  const text = value.trim();
  if (text.length < 3 || text.length > 80) return false;
  if (/^[-+$€£(]?[\d,.\s]+%?\)?$/.test(text)) return false;
  if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(text)) return false;
  return /[a-z]/i.test(text);
}

export type EntityLookup = (values: string[]) => Promise<Map<string, StoredHit[]>>;

const MAX_VALUES = 12;
const CONFIRMED_METHODS = new Set(['source_map', 'manual']);
/** A column is a column of one record type when this share of its values name that type's records. */
const COLUMN_SHARE = 0.6;

/**
 * A column nothing else explained, whose values are the names of stored records of one type, is the name of
 * that record type. This is how a file's "Borrower" column of company names is known to hold issuers.
 */
export async function matchColumnsToStoredRecords(
  assignments: ColumnAssignment[],
  rows: Record<string, string>[],
  lookup: EntityLookup,
): Promise<ColumnAssignment[]> {
  const candidates = assignments.filter((assignment) =>
    !CONFIRMED_METHODS.has(assignment.suggestion.method)
    && (assignment.role === 'ignore' || (assignment.role === 'name' && assignment.suggestion.confidence < 0.9)));
  if (candidates.length === 0) return assignments;

  const valuesBy = new Map<string, string[]>();
  for (const assignment of candidates) {
    const seen = new Set<string>();
    for (const row of rows) {
      const value = String(row[assignment.sourceColumn] ?? '').trim();
      if (value && !seen.has(value) && couldBeName(value)) seen.add(value);
      if (seen.size >= MAX_VALUES) break;
    }
    const total = rows.filter((row) => String(row[assignment.sourceColumn] ?? '').trim()).length;
    // Most of the column has to be name-like. A column of amounts with a stray word does not qualify.
    if (seen.size > 0 && seen.size >= Math.min(total, MAX_VALUES) * COLUMN_SHARE) valuesBy.set(assignment.sourceColumn, [...seen]);
  }
  if (valuesBy.size === 0) return assignments;

  const hitsByValue = await lookup([...new Set([...valuesBy.values()].flat())]);
  const taken = new Set(assignments.filter((assignment) => assignment.role === 'name' && assignment.domainCode).map((assignment) => assignment.domainCode));

  return assignments.map((assignment) => {
    const values = valuesBy.get(assignment.sourceColumn);
    if (!values) return assignment;
    const tally = new Map<string, { score: number; matched: number; example: ScoredHit }>();
    for (const value of values) {
      const best = new Map<string, ScoredHit>();
      for (const hit of rankHits(value, hitsByValue.get(value) || [])) {
        if (hit.confidence >= 0.88 && !best.has(hit.domainCode)) best.set(hit.domainCode, hit);
      }
      for (const [domainCode, hit] of best) {
        const current = tally.get(domainCode) || { score: 0, matched: 0, example: hit };
        tally.set(domainCode, { score: current.score + hit.confidence, matched: current.matched + 1, example: current.example });
      }
    }
    const ranked = [...tally.entries()]
      .map(([domainCode, item]) => ({ domainCode, ...item, share: item.matched / values.length }))
      .filter((item) => item.share >= COLUMN_SHARE)
      .sort((a, b) => b.score - a.score);
    const top = ranked[0];
    if (!top) return assignment;
    // Two record types that fit equally well is a question for a person, not a guess.
    if (ranked[1] && ranked[1].score >= top.score * 0.9) return assignment;
    if (taken.has(top.domainCode)) return assignment;
    taken.add(top.domainCode);
    const label = domainLabel(top.domainCode).toLowerCase();
    return {
      ...assignment,
      role: 'name' as const,
      domainCode: top.domainCode,
      attributeCode: null,
      transform: { kind: 'trim' as const },
      suggestion: {
        method: 'sample' as const,
        confidence: Number(Math.min(0.96, 0.6 + 0.36 * (top.score / values.length)).toFixed(2)),
        reason: `${top.matched === values.length ? 'Every' : `${top.matched} of ${values.length}`} value${values.length === 1 ? '' : 's'} here name${values.length === 1 && top.matched === 1 ? 's' : ''} a stored ${label}, such as “${top.example.name}”.`,
      },
    };
  });
}
