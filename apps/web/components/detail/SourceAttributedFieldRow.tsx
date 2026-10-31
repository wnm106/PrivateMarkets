'use client';

import { useEffect, useState } from 'react';
import { sources, type SourceKey } from '@/lib/data';
import { formatReceipt, isStaleReceipt, receiptAgeDays } from '@/lib/receipt-freshness';
import { graphqlQuery } from '@/lib/graphql';
import { AttributeSourcePanel, type SourceOption } from './AttributeSourcePanel';
import { listDisplayLabel, useAttributeListOptions } from '@/components/forms/AttributeValueInput';
import { formatAttributeValue, type FieldData } from './attribute-source';

export { formatAttributeValue, type FieldData };

interface SourceAttributedFieldRowProps {
  field: FieldData;
  onDrilldown?: (label: string) => void;
  onSourceChange?: (label: string, newSource: SourceKey) => void;
  onValueChange?: (label: string, newValue: string) => void;
  onAddSourceValue?: (attributeCode: string, source: SourceKey, value: string) => void | Promise<void>;
  onDeleteSourceValue?: (attributeCode: string, sourceCode: string) => void;
  asOfDate?: string;
  entityId?: string;
  calcRefreshKey?: string;
  presentation?: 'row' | 'card';
  spanRows?: number;
}

export function SourceAttributedFieldRow({ field, onDrilldown, onAddSourceValue, onDeleteSourceValue, asOfDate, entityId, calcRefreshKey, presentation = 'row', spanRows = 1 }: SourceAttributedFieldRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [availableSources, setAvailableSources] = useState<SourceOption[]>([]);

  useEffect(() => {
    const fetchSources = async () => {
      try {
        const result = await graphqlQuery<{ dataSources: Array<{ sourceCode: string; sourceName: string; color: string | null; metadata: any }> }>(
          `query { dataSources { sourceCode sourceName color metadata } }`,
          {},
          'network-only'
        );

        if (result.data?.dataSources) {
          const dbSources = result.data.dataSources.map(ds => {
            const key = ds.sourceCode.toLowerCase() as SourceKey;
            const metadata = ds.metadata || {};
            return {
              key,
              name: ds.sourceName,
              hex: ds.color || metadata.color || sources[key]?.hex || '#475569'
            };
          });
          setAvailableSources(dbSources);
        }
      } catch (err) {
        console.error('Failed to fetch sources:', err);
        setAvailableSources(Object.entries(sources).map(([key, src]) => ({
          key: key as SourceKey,
          name: src.name,
          hex: src.hex
        })));
      }
    };

    fetchSources();
  }, []);

  const listOptions = useAttributeListOptions(field.attributeCode);
  const shownValue = listDisplayLabel(field.value, listOptions) || formatAttributeValue(field.value, field.dataType);
  const normalizedFieldSource = (field.source || '').toLowerCase() as SourceKey;
  const dbSource = availableSources.find((source) => source.key === normalizedFieldSource);
  const src = dbSource
    ? { name: dbSource.name, color: dbSource.hex, hex: dbSource.hex }
    : (sources[normalizedFieldSource] ?? { name: field.source, color: '#475569', hex: '#475569' });

  const hasValue = field.value !== '' && field.value !== '—' && field.value != null;
  const hasSource = hasValue && Boolean(field.source);
  const borderColor = hasSource ? src.hex : 'var(--ink-4)';
  const receiptAge = receiptAgeDays(field.receivedAt);
  const receiptStale = isStaleReceipt(field.receivedAt, field.source);

  return (
    <>
      <div
        className={presentation === 'card' ? 'sa-field-card' : 'sa-field-row'}
        style={{ '--field-color': borderColor, '--span-rows': spanRows } as React.CSSProperties}
        onClick={() => setExpanded((open) => !open)}
      >
        <div className="sa-field-label">
          {field.label}
          {field.calculated && (
            <span className="std-icon" title={field.formula || 'Calculated value'}>ƒ</span>
          )}
          {field.standardized && <span className="std-icon" title="Standardized via list mapping">S</span>}
        </div>
        <div className="sa-field-value-cell">
          <span className={`sa-field-value ${field.conflict ? 'conflict' : ''}`}>
            {shownValue}
          </span>
          {field.conflict && <span className="conflict-badge">CONFLICT</span>}
          {field.alt && field.alt > 0 && (
            <span className="alt-count" title={`${field.alt} alternative value(s) available`}>±{field.alt}</span>
          )}
        </div>
        <div className="sa-field-source-cell">
          {hasSource && (
            <span
              className="src-pill"
              style={{ color: `color-mix(in srgb, ${src.hex} 70%, #000)`, background: `color-mix(in srgb, ${src.hex} 14%, #fff)` }}
              title="Golden source, derived from the source values"
            >
              {src.name}
              {field.precedenceRank !== undefined && (
                <span style={{ marginLeft: '4px', fontSize: '11px', opacity: 0.8 }}>
                  (P{field.precedenceRank})
                </span>
              )}
            </span>
          )}
          {hasSource && (
            <span
              className={`receipt-age${receiptStale ? ' stale' : ''}`}
              title={field.receivedAt ? `Last received ${formatReceipt(field.receivedAt)}. A restatement of the same value still updates this time.` : undefined}
            >
              {field.receivedAt && receiptAge != null
                ? (receiptStale ? `Stale ${receiptAge}d` : receiptAge === 0 ? 'Received today' : `Received ${receiptAge}d ago`)
                : ''}
            </span>
          )}
          <button
            className="sa-edit-btn"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((open) => !open);
              onDrilldown?.(field.label);
            }}
            title={field.calculated ? 'Show how this was calculated' : 'Show source values'}
          >
            ⌄
          </button>
        </div>
      </div>

      {expanded && (
        <AttributeSourcePanel
          field={field}
          entityId={entityId}
          asOfDate={asOfDate}
          calcRefreshKey={calcRefreshKey}
          onAddSourceValue={onAddSourceValue}
          onDeleteSourceValue={onDeleteSourceValue}
          availableSources={availableSources}
        />
      )}
    </>
  );
}
