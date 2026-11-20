/** A source value that disagrees with the golden source, as the score returns it. */
export interface ConflictRow {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  attributeCode: string;
  attributeName: string;
  goldenSourceCode: string;
  goldenSourceName: string;
  goldenValue: string | null;
  sourceCode: string;
  sourceName: string;
  value: string | null;
}

export interface SourceCandidate {
  source: string;
  sourceName: string;
  value: string;
  receivedAt: string | null;
  precedenceRank: number;
  golden: boolean;
}

export interface LineageField {
  attributeCode: string;
  attributeName: string;
  currentValue: string | null;
  resolutionRule: string | null;
  competingValues: Array<{
    source: string;
    sourceName: string;
    value: string | null;
    precedenceRank: number;
    receivedAt?: string | null;
  }>;
}

export interface ResolutionField {
  attributeCode: string;
  attributeName: string;
  currentValue: string | null;
  rule: string | null;
  candidates: SourceCandidate[];
}

export interface ConflictEntity {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  conflictCount: number;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** True when two stored values are the same text, ignoring case and space, or the same number. */
export function valuesAgree(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = (left ?? '').trim();
  const b = (right ?? '').trim();
  if (!a || !b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  return NUMERIC.test(a) && NUMERIC.test(b) && Number(a) === Number(b);
}

/** One row per record that has a conflict, the most conflicts first. */
export function entitiesFromConflicts(rows: readonly ConflictRow[]): ConflictEntity[] {
  const groups = new Map<string, ConflictEntity>();
  for (const row of rows) {
    const existing = groups.get(row.id);
    if (existing) existing.conflictCount += 1;
    else {
      groups.set(row.id, {
        id: row.id,
        entityCode: row.entityCode,
        entityName: row.entityName,
        domainCode: row.domainCode,
        conflictCount: 1,
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.conflictCount - a.conflictCount || a.entityName.localeCompare(b.entityName));
}

function candidateFrom(source: string, sourceName: string, value: string | null | undefined, receivedAt: string | null, precedenceRank: number, golden: boolean): SourceCandidate | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  return { source, sourceName, value: text, receivedAt, precedenceRank, golden };
}

/**
 * The attributes to resolve for one record. A field is included when another
 * active value disagrees with the golden source. Lineage supplies every source;
 * the score rows fill a field the lineage has not loaded.
 */
export function fieldsForEntity(lineage: readonly LineageField[], conflicts: readonly ConflictRow[]): ResolutionField[] {
  const byCode = new Map<string, ResolutionField>();

  for (const field of lineage) {
    const populated = field.competingValues
      .map((row, index) => candidateFrom(row.source, row.sourceName, row.value, row.receivedAt ?? null, row.precedenceRank, index === 0))
      .filter((row): row is SourceCandidate => row != null);
    const golden = populated.find((row) => row.golden) ?? populated[0];
    const reference = golden?.value ?? field.currentValue;
    const disagrees = populated.some((row) => !row.golden && !valuesAgree(row.value, reference));
    if (!disagrees || !golden) continue;
    byCode.set(field.attributeCode, {
      attributeCode: field.attributeCode,
      attributeName: field.attributeName,
      currentValue: field.currentValue,
      rule: field.resolutionRule,
      candidates: populated,
    });
  }

  for (const row of conflicts) {
    const other = candidateFrom(row.sourceCode, row.sourceName, row.value, null, 1, false);
    if (!other) continue;
    const existing = byCode.get(row.attributeCode);
    if (existing) {
      const reference = existing.candidates.find((candidate) => candidate.golden)?.value ?? existing.currentValue;
      if (valuesAgree(other.value, reference)) continue;
      if (!existing.candidates.some((candidate) => candidate.source === other.source && valuesAgree(candidate.value, other.value))) {
        existing.candidates.push(other);
      }
      continue;
    }
    const golden = candidateFrom(row.goldenSourceCode, row.goldenSourceName, row.goldenValue, null, 0, true);
    if (!golden || valuesAgree(golden.value, other.value)) continue;
    byCode.set(row.attributeCode, {
      attributeCode: row.attributeCode,
      attributeName: row.attributeName,
      currentValue: row.goldenValue,
      rule: null,
      candidates: [golden, other],
    });
  }

  return [...byCode.values()].sort((a, b) => a.attributeName.localeCompare(b.attributeName));
}
