export interface EntityTypeGroup<T> {
  code: string;
  items: T[];
}

/** Bucket rows by entity type. Blank types sort last. Item order inside a type is kept. */
export function groupByEntityType<T>(
  rows: readonly T[],
  domainOf: (row: T) => string | null | undefined,
  labelOf: (code: string) => string = (code) => code,
): Array<EntityTypeGroup<T>> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const code = (domainOf(row) ?? '').trim();
    const existing = groups.get(code);
    if (existing) existing.push(row);
    else groups.set(code, [row]);
  }
  return [...groups.entries()]
    .sort((a, b) => {
      if (!a[0] && b[0]) return 1;
      if (a[0] && !b[0]) return -1;
      return labelOf(a[0]).localeCompare(labelOf(b[0]));
    })
    .map(([code, items]) => ({ code, items }));
}

interface AvailabilityMember {
  domainCode: string;
}

interface AvailabilityValue extends AvailabilityMember {
  value: string | null;
}

export interface AvailabilityByType {
  domainCode: string | null;
  requiredCount: number;
  missingCount: number;
  availabilityPercent: number | null;
  resolvedCount: number;
  introducedCount: number;
  missingEntities: AvailabilityMember[];
  resolvedEntities: AvailabilityMember[];
  introducedEntities: AvailabilityMember[];
  entities?: AvailabilityValue[] | null;
}

function roundPercent(populated: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((populated * 1000) / total) / 10;
}

/** One availability row per entity type. Counts follow the entities in that type. */
export function splitAvailabilityByEntityType<T extends AvailabilityByType>(rows: readonly T[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const members = [
      ...(row.entities ?? []),
      ...row.missingEntities,
      ...row.resolvedEntities,
      ...row.introducedEntities,
    ];
    const codes = [...new Set(members.map((member) => member.domainCode.trim()).filter(Boolean))];
    if (codes.length <= 1) {
      out.push({ ...row, domainCode: codes[0] || row.domainCode || null });
      continue;
    }
    for (const code of codes) {
      const entities = row.entities?.filter((entity) => entity.domainCode.trim() === code) ?? null;
      const missingEntities = row.missingEntities.filter((entity) => entity.domainCode.trim() === code);
      const resolvedEntities = row.resolvedEntities.filter((entity) => entity.domainCode.trim() === code);
      const introducedEntities = row.introducedEntities.filter((entity) => entity.domainCode.trim() === code);
      const requiredCount = entities ? entities.length : row.requiredCount;
      const missingCount = entities
        ? entities.filter((entity) => entity.value == null || entity.value === '').length
        : missingEntities.length;
      out.push({
        ...row,
        domainCode: code,
        requiredCount,
        missingCount,
        availabilityPercent: roundPercent(Math.max(0, requiredCount - missingCount), requiredCount),
        resolvedCount: resolvedEntities.length,
        introducedCount: introducedEntities.length,
        missingEntities,
        resolvedEntities,
        introducedEntities,
        entities,
      });
    }
  }
  return out;
}

export interface RuleByType<E extends { domainCode: string }> {
  domainCode: string | null;
  entityCount: number;
  failingCount: number;
  acceptedCount: number;
  resolvedCount: number;
  introducedCount: number;
  failingEntities: E[];
  acceptedEntities: E[];
  resolvedEntities: E[];
  introducedEntities: E[];
  checkedKnown?: boolean;
}

export type RuleWithScope<T> = T & { checkedKnown: boolean };

/** A rule scoped to one entity type stays there. An unscoped rule with results in several types is repeated once per type. */
export function splitRulesByEntityType<T extends RuleByType<E>, E extends { domainCode: string }>(rules: readonly T[]): Array<RuleWithScope<T>> {
  const out: Array<RuleWithScope<T>> = [];
  for (const rule of rules) {
    const members = [...rule.failingEntities, ...rule.acceptedEntities, ...rule.resolvedEntities, ...rule.introducedEntities];
    const codes = [...new Set(members.map((entity) => entity.domainCode.trim()).filter(Boolean))];
    if (rule.domainCode || codes.length <= 1) {
      out.push({ ...rule, domainCode: rule.domainCode || codes[0] || null, checkedKnown: true });
      continue;
    }
    for (const code of codes) {
      const failingEntities = rule.failingEntities.filter((entity) => entity.domainCode.trim() === code);
      const acceptedEntities = rule.acceptedEntities.filter((entity) => entity.domainCode.trim() === code);
      const resolvedEntities = rule.resolvedEntities.filter((entity) => entity.domainCode.trim() === code);
      const introducedEntities = rule.introducedEntities.filter((entity) => entity.domainCode.trim() === code);
      out.push({
        ...rule,
        domainCode: code,
        checkedKnown: false,
        failingCount: failingEntities.length,
        acceptedCount: acceptedEntities.length,
        resolvedCount: resolvedEntities.length,
        introducedCount: introducedEntities.length,
        failingEntities,
        acceptedEntities,
        resolvedEntities,
        introducedEntities,
      });
    }
  }
  return out;
}

export interface ChangesByType<C> {
  domainCode: string | null;
  changeCount: number;
  changes: C[];
}

/** Attribute changes that span entity types become one row per type. */
export function splitChangesByEntityType<T extends ChangesByType<C>, C extends { domainCode: string }>(rows: readonly T[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const groups = groupByEntityType(row.changes, (change) => change.domainCode);
    if (groups.length === 0) {
      out.push(row);
      continue;
    }
    for (const group of groups) {
      out.push({
        ...row,
        domainCode: group.code || row.domainCode || null,
        changeCount: group.items.length,
        changes: group.items,
      });
    }
  }
  return out;
}
