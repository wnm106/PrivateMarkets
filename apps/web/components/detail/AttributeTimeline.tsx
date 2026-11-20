'use client';

import { useEffect, useState } from 'react';
import { formatAttributeDisplay } from '@/lib/attribute-display';
import { useAttributeDisplay } from '@/components/forms/AttributeValueInput';
import { DELETE_ATTRIBUTE_VERSION_MUTATION, ENTITY_ACTIVITY_QUERY, graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { useTemporalStore } from '@/lib/store';
import { useRecordValues } from '@/components/forms/RecordValues';
import { timelineState, type TimelineState } from '@/lib/timeline-state';

interface TimelineEntry {
  id?: string | null;
  attributeCode: string;
  attributeName: string;
  value: string | null;
  updatedAt: string;
  updatedBy: string;
  sourceName: string | null;
  validFrom: string;
  validTo: string;
  /** Still believed at the knowledge date. False once a later write replaced or deleted it. */
  current?: boolean;
}

const STATE_LABEL: Record<TimelineState, string | null> = {
  upcoming: 'Not yet effective',
  effective: 'Effective',
  past: null,
  replaced: 'Replaced',
};

interface AttributeTimelineProps {
  entityId: string;
  attributes: Array<{ code: string; name: string }>;
  /** Renders inside an expanded attribute, locked to that attribute. */
  embedded?: boolean;
  /** Offers Delete on each version still believed. */
  canDelete?: boolean;
}

function TimelineValue({ attributeCode, value }: { attributeCode: string; value: string | null }) {
  const meta = useAttributeDisplay(attributeCode);
  if (value == null || value === '') return <>Cleared</>;
  return <>{formatAttributeDisplay(value, meta) || value}</>;
}

function formatWritten(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDay(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function periodLabel(from: string, to: string) {
  const start = formatDay(from);
  if (!to || to.startsWith('9999')) return `As of ${start}`;
  return `${start} – ${formatDay(to)}`;
}

export function AttributeTimeline({ entityId, attributes, embedded = false, canDelete = false }: AttributeTimelineProps) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [choice, setChoice] = useState<string | null>(null);
  const attributeCode = choice === '' || (choice !== null && attributes.some((attribute) => attribute.code === choice))
    ? choice
    : (attributes[0]?.code ?? '');
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showReplaced, setShowReplaced] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const record = useRecordValues();

  const deleteVersion = async (versionId: string) => {
    setDeleting(versionId);
    setDeleteError(null);
    const result = await graphqlMutation<
      { deleteAttributeVersion: { success: boolean; errors: Array<{ message: string }> } },
      { input: { entityId: string; versionId: string } }
    >(DELETE_ATTRIBUTE_VERSION_MUTATION, { input: { entityId, versionId } });
    const message = result.error?.message || result.data?.deleteAttributeVersion?.errors?.[0]?.message;
    setDeleting(null);
    setConfirming(null);
    if (message || !result.data?.deleteAttributeVersion?.success) {
      setDeleteError(message || 'Could not delete that version.');
      return;
    }
    setReloadKey((key) => key + 1);
    await record?.reload?.();
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    graphqlQuery<
      { entityActivity: TimelineEntry[] },
      { entityId: string; knowledgeDate: string; attributeCode?: string; limit: number }
    >(
      ENTITY_ACTIVITY_QUERY,
      {
        entityId,
        knowledgeDate,
        attributeCode: attributeCode || undefined,
        limit: attributeCode ? 100 : 40,
      },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      const rows = result.data?.entityActivity ?? [];
      rows.sort((a, b) => {
        if (attributeCode) {
          return b.validFrom.localeCompare(a.validFrom) || b.updatedAt.localeCompare(a.updatedAt);
        }
        return b.updatedAt.localeCompare(a.updatedAt) || b.validFrom.localeCompare(a.validFrom);
      });
      setEntries(rows);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setEntries([]);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [entityId, knowledgeDate, attributeCode, reloadKey]);

  const asOfDay = asOfDate?.slice(0, 10) ?? '';
  // Every version still believed is shown, including ones that start after the As Of date.
  // Versions a later write replaced stay behind a toggle.
  const replacedCount = entries.filter((entry) => entry.current === false).length;
  const visibleEntries = showReplaced ? entries : entries.filter((entry) => entry.current !== false);

  const replacedToggle = replacedCount > 0 ? (
    <button type="button" className="value-timeline-toggle" onClick={() => setShowReplaced((open) => !open)}>
      {showReplaced ? 'Hide replaced versions' : `Show replaced versions (${replacedCount})`}
    </button>
  ) : null;

  const body = loading ? (
        <div className="value-timeline-empty">Loading timeline…</div>
      ) : visibleEntries.length === 0 ? (
        <>
          <div className="value-timeline-empty">No recorded values for this attribute.</div>
          {replacedToggle}
        </>
      ) : (
        <>
          <div className={`value-timeline${embedded ? ' embedded' : ''}`}>
            {visibleEntries.map((entry, index) => {
              const state = timelineState(entry, asOfDay);
              const label = STATE_LABEL[state];
              const versionId = entry.id || '';
              const deletable = canDelete && state !== 'replaced' && Boolean(versionId);
              return (
                <div className={`value-timeline-item ${state}`} key={`${versionId || entry.attributeCode}-${entry.validFrom}-${entry.updatedAt}-${index}`}>
                  <div className="value-timeline-rail" aria-hidden>
                    <span className="value-timeline-dot" />
                  </div>
                  <div className="value-timeline-body">
                    <div className="value-timeline-when">
                      {periodLabel(entry.validFrom, entry.validTo)}
                      {label && <span className={`value-timeline-badge ${state}`}>{label}</span>}
                    </div>
                    {!attributeCode && <div className="value-timeline-attr">{entry.attributeName}</div>}
                    <div className="value-timeline-value"><TimelineValue attributeCode={entry.attributeCode} value={entry.value} /></div>
                    <div className="value-timeline-meta">
                      {[entry.updatedBy || 'System', entry.sourceName, `written ${formatWritten(entry.updatedAt)}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {deletable && (
                    <div className="value-timeline-actions">
                      {confirming === versionId ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={deleting === versionId}
                            title="Removes this version. The same source's version just before it runs on over these dates."
                            onClick={() => void deleteVersion(versionId)}
                          >
                            {deleting === versionId ? 'Deleting…' : 'Delete version'}
                          </button>
                          <button type="button" className="btn btn-sm" disabled={deleting === versionId} onClick={() => setConfirming(null)}>Cancel</button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          title="Delete this version"
                          onClick={() => {
                            setDeleteError(null);
                            setConfirming(versionId);
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {deleteError && <div className="value-timeline-error">{deleteError}</div>}
          {replacedToggle}
        </>
      );

  if (embedded) {
    return <div className="value-timeline-embed">{body}</div>;
  }

  return (
    <div className="field-section">
      <div className="field-section-head">
        <div className="field-section-name">Value timeline</div>
        <select
          className="select"
          aria-label="Attribute"
          value={attributeCode}
          onChange={(event) => setChoice(event.target.value)}
          style={{ fontSize: '12px', padding: '6px 8px', maxWidth: '280px' }}
        >
          <option value="">All attributes</option>
          {attributes.map((attribute) => (
            <option key={attribute.code} value={attribute.code}>{attribute.name}</option>
          ))}
        </select>
      </div>
      {body}
    </div>
  );
}
