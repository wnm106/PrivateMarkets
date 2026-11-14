export const COMPOSITE_METADATA_KEYS = ['logic', 'numerator_terms', 'denominator_terms', 'limit_term'] as const;

/** The formula lives on measure lines. These keys are the old hidden copy. */
export function stripCompositeMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(metadata || {}) };
  for (const key of COMPOSITE_METADATA_KEYS) delete next[key];
  return next;
}

const VERSION_AGGREGATIONS = new Set(['SUM', 'AVG', 'COUNT', 'MIN', 'MAX', 'VALUE', 'CONSTANT']);

export interface MeasureColumnLine {
  side: string;
  kind: string;
  attributeCode?: string | null;
}

/**
 * The version row still requires a numerator column and a legal aggregation.
 * Weighted averages and excess lines keep SUM there; the line itself holds the real kind.
 */
export function columnsFromMeasureLines(lines: MeasureColumnLine[]) {
  const numerator = lines.find((line) => line.side === 'NUMERATOR' && line.attributeCode);
  const denominator = lines.find((line) => line.side === 'DENOMINATOR' && line.attributeCode);
  return {
    numeratorAttributeCode: numerator?.attributeCode || '',
    numeratorAggregation: numerator && VERSION_AGGREGATIONS.has(numerator.kind) ? numerator.kind : 'SUM',
    denominatorAttributeCode: denominator?.attributeCode || '',
    hasDenominator: lines.some((line) => line.side === 'DENOMINATOR'),
    hasLimit: lines.some((line) => line.side === 'LIMIT'),
  };
}

export interface DomainRelationship {
  relationshipCode: string;
  parentDomainCode: string;
  childDomainCode: string;
}

/**
 * Domain at the end of a path. Stored hops sometimes say UP where the
 * relationship type's parent is the side we start on; the walk follows the
 * other domain on that relationship, which is the entity the line reads.
 */
export function domainAfterPath(
  root: string,
  path: Array<{ relationshipCode: string; direction: string }> | null | undefined,
  relationships: DomainRelationship[],
): string {
  let domain = root;
  for (const hop of path || []) {
    const relationship = relationships.find((item) => item.relationshipCode === hop.relationshipCode);
    if (!relationship) break;
    if (relationship.parentDomainCode === domain) domain = relationship.childDomainCode;
    else if (relationship.childDomainCode === domain) domain = relationship.parentDomainCode;
    else break;
  }
  return domain;
}

export interface AlignableHop {
  relationshipCode: string;
  direction: string;
  recursive?: boolean;
}

/**
 * Rewrite each hop to the direction the attribute picker uses from the domain
 * it starts on. Stored terms sometimes say UP for a hop the picker calls DOWN.
 * Scoring walks either direction, so the rewritten path still reaches the same records.
 */
export function alignPathToPicker<T extends AlignableHop>(
  root: string,
  path: T[] | null | undefined,
  relationships: DomainRelationship[],
): T[] {
  let domain = root;
  return (path || []).map((hop) => {
    const relationship = relationships.find((item) => item.relationshipCode === hop.relationshipCode);
    let direction: 'UP' | 'DOWN' = hop.direction === 'DOWN' ? 'DOWN' : 'UP';
    if (relationship?.parentDomainCode === domain) direction = 'DOWN';
    else if (relationship?.childDomainCode === domain) direction = 'UP';
    if (relationship?.parentDomainCode === domain) domain = relationship.childDomainCode;
    else if (relationship?.childDomainCode === domain) domain = relationship.parentDomainCode;
    return direction === hop.direction ? hop : { ...hop, direction };
  });
}

/** Same route, ignoring hop direction. The picker and the stored term can disagree on it. */
export function sameAttributeRoute(
  left: Array<{ relationshipCode: string }> | null | undefined,
  right: Array<{ relationshipCode: string }> | null | undefined,
): boolean {
  const a = left || [];
  const b = right || [];
  return a.length === b.length && a.every((hop, index) => hop.relationshipCode === b[index]?.relationshipCode);
}
