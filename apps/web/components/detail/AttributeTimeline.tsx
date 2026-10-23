'use client';

import { useEffect, useState } from 'react';
import { ENTITY_ACTIVITY_QUERY, graphqlQuery } from '@/lib/graphql';
import { useTemporalStore } from '@/lib/store';

interface TimelineEntry {
  attributeCode: string;
  attributeName: string;
  value: string | null;
  updatedAt: string;
  updatedBy: string;
  sourceName: string | null;
  validFrom: string;
  validTo: string;
}

interface AttributeTimelineProps {
  entityId: string;
  attributes: Array<{ code: string; name: string }>;
  /** Renders inside an expanded attribute, locked to that attribute. */
  embedded?: boolean;
}

function formatValue(value: string | null) {
  if (value == null || value === '') return 'Cleared';
  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return value;
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

export function AttributeTimeline({ entityId, attributes, embedded = false }: AttributeTimelineProps) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [choice, setChoice] = useState<string | null>(null);
  const attributeCode = choice === '' || (choice !== null && attributes.some((attribute) => attribute.code === choice))
    ? choice
    : (attributes[0]?.code ?? '');
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);

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
  }, [entityId, knowledgeDate, attributeCode]);

  const asOfDay = asOfDate?.slice(0, 10) ?? '';
  const visibleEntries = asOfDay
    ? entries.filter((entry) => entry.validFrom.slice(0, 10) <= asOfDay)
    : entries;

  const body = loading ? (
        <div className="value-timeline-empty">Loading timeline…</div>
      ) : visibleEntries.length === 0 ? (
        <div className="value-timeline-empty">No recorded values for this attribute as of this date.</div>
      ) : (
        <div className={`value-timeline${embedded ? ' embedded' : ''}`}>
          {visibleEntries.map((entry, index) => (
            <div className="value-timeline-item" key={`${entry.attributeCode}-${entry.validFrom}-${entry.updatedAt}-${index}`}>
              <div className="value-timeline-rail" aria-hidden>
                <span className="value-timeline-dot" />
              </div>
              <div className="value-timeline-body">
                <div className="value-timeline-when">{periodLabel(entry.validFrom, entry.validTo)}</div>
                {!attributeCode && <div className="value-timeline-attr">{entry.attributeName}</div>}
                <div className="value-timeline-value">{formatValue(entry.value)}</div>
                <div className="value-timeline-meta">
                  {[entry.updatedBy || 'System', entry.sourceName, `written ${formatWritten(entry.updatedAt)}`].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
          ))}
        </div>
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
