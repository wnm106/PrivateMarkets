'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAttributeDisplay } from '@/components/forms/AttributeValueInput';
import { formatAttributeDisplay } from '@/lib/attribute-display';
import { ENTITY_TIMELINE_QUERY, graphqlQuery } from '@/lib/graphql';
import { timelineChanges, type EntityTimelineResult } from '@/lib/entity-timeline';
import { usePublishTab } from '@/lib/view-context';

const PURPOSE = 'The full record over effective time: one row for each day any field changed, with the fields that changed from the row before highlighted.';
const HOW_TO_READ = 'Rows are versions of the record, newest first. Each is in force from effectiveFrom to effectiveTo (null means it still is). '
  + 'changes lists the fields that differ from the version before it, with the prior and new value; on the oldest version every field is new. '
  + 'Values are the winning golden values as believed at the Knowledge date, as stored (list codes and raw numbers). current is the record on the newest version.';

function formatDay(value: string | null) {
  if (!value) return 'Open';
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function TimelineCellValue({ attributeCode, value }: { attributeCode: string; value: string | null }) {
  const meta = useAttributeDisplay(attributeCode);
  if (value == null || value === '') return <span className="entity-timeline-blank">—</span>;
  return <>{formatAttributeDisplay(value, meta) || value}</>;
}

export function EntityTimeline({
  entityId,
  entityLabel,
  knowledgeDate,
}: {
  entityId: string;
  entityLabel?: string | null;
  knowledgeDate?: string | null;
}) {
  const [timeline, setTimeline] = useState<EntityTimelineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingOnly, setChangingOnly] = useState(false);

  useEffect(() => {
    setTimeline(null);
    setError(null);
    let cancelled = false;
    graphqlQuery<{ entityTimeline: EntityTimelineResult }, { entityId: string; knowledgeDate?: string; limit: number }>(
      ENTITY_TIMELINE_QUERY,
      { entityId, knowledgeDate: knowledgeDate || undefined, limit: 120 },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data?.entityTimeline) {
        setError(result.error?.message || 'Could not load the timeline.');
        return;
      }
      setTimeline(result.data.entityTimeline);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load the timeline.');
    });
    return () => { cancelled = true; };
  }, [entityId, knowledgeDate]);

  const changes = useMemo(() => (timeline ? timelineChanges(timeline) : []), [timeline]);

  // Fields that change after the first version. The rest are shown only when asked for.
  const changingCodes = useMemo(() => {
    const codes = new Set<string>();
    changes.slice(0, -1).forEach((version) => version.changes.forEach((change) => codes.add(change.attributeCode)));
    return codes;
  }, [changes]);

  const columns = useMemo(() => {
    const all = timeline?.attributes || [];
    return changingOnly ? all.filter((attribute) => changingCodes.has(attribute.attributeCode)) : all;
  }, [timeline, changingOnly, changingCodes]);

  usePublishTab('timeline', {
    label: 'Timeline',
    purpose: PURPOSE,
    howToRead: HOW_TO_READ,
    data: !timeline ? null : {
      record: entityLabel || null,
      versionCount: changes.length,
      olderVersionsLeftOut: timeline.truncated,
      fieldsThatChange: timeline.attributes.filter((attribute) => changingCodes.has(attribute.attributeCode)).map((attribute) => attribute.attributeName),
      current: changes[0]
        ? Object.fromEntries(timeline.attributes.map((attribute, index) => [attribute.attributeName, timeline.versions[0].values[index]?.value ?? null]))
        : null,
      versions: changes.slice(0, 60).map((version) => ({
        effectiveFrom: version.effectiveFrom,
        effectiveTo: version.effectiveTo,
        changes: version.changes.map((change) => ({ field: change.attributeName, from: change.from, to: change.to })),
      })),
    },
  });

  if (error) return <div className="value-timeline-empty">{error}</div>;
  if (!timeline) return <div className="value-timeline-empty">Loading timeline…</div>;
  if (!timeline.versions.length) return <div className="value-timeline-empty">No recorded values for this record.</div>;

  return (
    <div className="entity-timeline">
      <div className="entity-timeline-head">
        <span>
          {timeline.versions.length} {timeline.versions.length === 1 ? 'version' : 'versions'}, newest first.
          {' '}<span className="entity-timeline-key">Changed</span> marks a field that differs from the version below it.
          {timeline.truncated && ' Older versions are not shown.'}
        </span>
        <label className="entity-timeline-toggle">
          <input type="checkbox" checked={changingOnly} onChange={(event) => setChangingOnly(event.target.checked)} />
          Only fields that change
        </label>
      </div>
      <div className="entity-timeline-scroll">
        <table className="entity-timeline-table">
          <thead>
            <tr>
              <th className="entity-timeline-when">Effective</th>
              {columns.map((attribute) => <th key={attribute.attributeCode}>{attribute.attributeName}</th>)}
            </tr>
          </thead>
          <tbody>
            {timeline.versions.map((version, row) => {
              const byCode = new Map(version.values.map((value) => [value.attributeCode, value]));
              const changed = new Set(version.changed);
              const prior = timeline.versions[row + 1];
              const priorByCode = prior ? new Map(prior.values.map((value) => [value.attributeCode, value])) : null;
              return (
                <tr key={version.effectiveFrom}>
                  <th scope="row" className="entity-timeline-when">
                    <div>{formatDay(version.effectiveFrom)}</div>
                    <div className="entity-timeline-to">to {formatDay(version.effectiveTo)}</div>
                  </th>
                  {columns.map((attribute) => {
                    const cell = byCode.get(attribute.attributeCode);
                    const isChanged = changed.has(attribute.attributeCode) && Boolean(priorByCode);
                    const before = priorByCode?.get(attribute.attributeCode)?.value;
                    const title = [
                      cell?.sourceName ? `Source: ${cell.sourceName}` : null,
                      isChanged ? `Was: ${before == null || before === '' ? 'blank' : before}` : null,
                    ].filter(Boolean).join('\n') || undefined;
                    return (
                      <td key={attribute.attributeCode} className={isChanged ? 'changed' : undefined} title={title}>
                        <TimelineCellValue attributeCode={attribute.attributeCode} value={cell?.value ?? null} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
