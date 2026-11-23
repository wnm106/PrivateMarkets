/** The record over effective time, as `entityTimeline` returns it. Versions are newest first. */
export interface EntityTimelineResult {
  attributes: Array<{ attributeCode: string; attributeName: string }>;
  versions: Array<{
    effectiveFrom: string;
    effectiveTo: string | null;
    values: Array<{ attributeCode: string; value: string | null; sourceName: string | null }>;
    changed: string[];
  }>;
  truncated: boolean;
}

export interface TimelineChange {
  attributeCode: string;
  attributeName: string;
  from: string | null;
  to: string | null;
}

/** Each version with what changed from the version before it (the next one in the list). */
export function timelineChanges(timeline: EntityTimelineResult) {
  const names = new Map(timeline.attributes.map((attribute) => [attribute.attributeCode, attribute.attributeName]));
  return timeline.versions.map((version, index) => {
    const prior = timeline.versions[index + 1];
    const valueOf = (values: EntityTimelineResult['versions'][number]['values'] | undefined, code: string) => {
      const value = values?.find((item) => item.attributeCode === code)?.value;
      return value == null || value === '' ? null : value;
    };
    return {
      effectiveFrom: version.effectiveFrom,
      effectiveTo: version.effectiveTo,
      changes: version.changed.map((code): TimelineChange => ({
        attributeCode: code,
        attributeName: names.get(code) || code,
        from: prior ? valueOf(prior.values, code) : null,
        to: valueOf(version.values, code),
      })),
    };
  });
}
