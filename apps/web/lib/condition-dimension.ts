/** Source and time settings of an attribute reference in a condition, and how they are stored. */

// Source / time dimension of an attribute reference. Empty = golden, run as-of date.
export interface DimensionState {
  sourceScope: string;
  offsetAmount: string; // negative = past, e.g. -1 with MONTH = one month prior
  offsetUnit: string;
  snapTo: string;
  knowledgeMode: string;
}

export const emptyDimension = (): DimensionState => ({
  sourceScope: '',
  offsetAmount: '',
  offsetUnit: 'DAY',
  snapTo: '',
  knowledgeMode: 'RUN',
});

export function dimensionToInput(d?: DimensionState | null, path?: Array<{ relationshipCode: string; direction: string }> | null) {
  const out: Record<string, any> = {};
  if (d) {
    const hasOffset = d.offsetAmount !== '' && Number(d.offsetAmount) !== 0;
    if (d.sourceScope) out.sourceScope = d.sourceScope;
    if (hasOffset) {
      out.offsetAmount = parseInt(d.offsetAmount, 10);
      out.offsetUnit = d.offsetUnit;
    }
    if (d.snapTo) out.snapTo = d.snapTo;
    if (d.knowledgeMode && d.knowledgeMode !== 'RUN') out.knowledgeMode = d.knowledgeMode;
  }
  const hops = (path || []).filter((hop) => hop.relationshipCode);
  if (hops.length) {
    out.relationshipPath = hops.map((hop) => ({
      relationshipCode: hop.relationshipCode,
      direction: hop.direction,
      recursive: false,
    }));
  }
  return Object.keys(out).length ? out : undefined;
}

export function dimensionFromDto(d: any): DimensionState {
  if (!d) return emptyDimension();
  return {
    sourceScope: d.sourceScope || '',
    offsetAmount: d.offsetAmount != null ? String(d.offsetAmount) : '',
    offsetUnit: d.offsetUnit || 'DAY',
    snapTo: d.snapTo || '',
    knowledgeMode: d.knowledgeMode || 'RUN',
  };
}
