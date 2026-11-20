'use client';

import { useEffect, useRef, useState } from 'react';
import { sources, type SourceKey } from '@/lib/data';
import { inlineCommitValue, inlineDraft } from '@/lib/inline-field';
import { formatReceipt, isStaleReceipt, receiptAgeDays } from '@/lib/receipt-freshness';
import { graphqlQuery } from '@/lib/graphql';
import { AttributeSourcePanel, type SourceOption } from './AttributeSourcePanel';
import Link from 'next/link';
import { AttributeValueInput, listDisplayLabel, useAttributeDisplay, useAttributeListOptions, useParentConflict } from '@/components/forms/AttributeValueInput';
import { referenceTarget } from '@/lib/attribute-display';
import { entityRefHref, useEntityRef } from '@/lib/entity-reference';
import { formatAttributeValue, isNumericAttribute, type FieldData } from './attribute-source';

export { formatAttributeValue, type FieldData };

interface SourceAttributedFieldRowProps {
  field: FieldData;
  onDrilldown?: (label: string) => void;
  onSourceChange?: (label: string, newSource: SourceKey) => void;
  onValueChange?: (label: string, newValue: string) => void | Promise<void>;
  onAddSourceValue?: (attributeCode: string, source: SourceKey, value: string) => void | Promise<void>;
  onDeleteSourceValue?: (attributeCode: string, sourceCode: string) => void;
  asOfDate?: string;
  knowledgeDate?: string;
  entityId?: string;
  calcRefreshKey?: string;
  presentation?: 'row' | 'card';
  spanRows?: number;
  /** The record type requires this attribute. */
  required?: boolean;
}

export function SourceAttributedFieldRow({ field, onDrilldown, onValueChange, onAddSourceValue, onDeleteSourceValue, asOfDate, knowledgeDate, entityId, calcRefreshKey, presentation = 'row', spanRows = 1, required = false }: SourceAttributedFieldRowProps) {
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
        className={`${presentation === 'card' ? 'sa-field-card' : 'sa-field-row'} attr-inspectable`}
        style={{ '--field-color': borderColor, '--span-rows': spanRows } as React.CSSProperties}
        title="Right-click to view sources"
        onClick={() => setExpanded((open) => !open)}
        onContextMenu={(event) => {
          // Right-click opens the same source detail a click does, here on the record.
          event.preventDefault();
          event.stopPropagation();
          setExpanded(true);
        }}
      >
        <div className="sa-field-label">
          {field.label}
          {required && (
            <span className={`sa-required-mark${hasValue ? '' : ' missing'}`} title={hasValue ? 'Required' : 'Required and blank'} aria-label="Required">*</span>
          )}
          {field.calculated && (
            <span className="std-icon" title={field.formula || 'Calculated value'}>ƒ</span>
          )}
          {field.standardized && <span className="std-icon" title="Standardized via list mapping">S</span>}
        </div>
        <div
          className="sa-field-value-cell"
          onClick={field.editable === false ? undefined : (event) => event.stopPropagation()}
        >
          <InlineFieldValue
            field={field}
            onSave={field.editable === false ? undefined : (onAddSourceValue
              ? (next) => onAddSourceValue(field.attributeCode || field.label, 'manual', next)
              : (onValueChange
                ? (next) => onValueChange(field.attributeCode || field.label, next)
                : undefined))}
          />
          {field.conflict && <span className="conflict-badge">CONFLICT</span>}
          {field.alt && field.alt > 0 && (
            <span className="alt-count" title={`${field.alt} alternative value(s) available`}>±{field.alt}</span>
          )}
        </div>
        <div className="sa-field-source-cell">
          {/* Each slot is always drawn so the pill, the receipt time and the button sit in the same place on every row. */}
          <span className="sa-source-slot">
            {hasSource && (
              <span
                className="src-pill"
                style={{ color: `color-mix(in srgb, ${src.hex} 70%, #000)`, background: `color-mix(in srgb, ${src.hex} 14%, #fff)` }}
                title={`${src.name}${field.precedenceRank !== undefined ? ` (P${field.precedenceRank})` : ''}. Golden source, derived from the source values.`}
              >
                <span className="src-pill-name">{src.name}</span>
                {field.precedenceRank !== undefined && (
                  <span className="src-pill-rank">P{field.precedenceRank}</span>
                )}
              </span>
            )}
          </span>
          <span
            className={`receipt-age${receiptStale ? ' stale' : ''}`}
            title={hasSource && field.receivedAt ? `Last received ${formatReceipt(field.receivedAt)}. A restatement of the same value still updates this time.` : undefined}
          >
            {hasSource && field.receivedAt && receiptAge != null
              ? (receiptStale ? `Stale ${receiptAge}d` : receiptAge === 0 ? 'Received today' : `Received ${receiptAge}d ago`)
              : ''}
          </span>
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
          knowledgeDate={knowledgeDate}
          calcRefreshKey={calcRefreshKey}
          onAddSourceValue={onAddSourceValue}
          onDeleteSourceValue={onDeleteSourceValue}
          availableSources={availableSources}
        />
      )}
    </>
  );
}

function InlineFieldValue({
  field,
  onSave,
}: {
  field: FieldData;
  onSave?: (value: string) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => inlineDraft(field.value));
  const [pending, setPending] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipCommit = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const options = useAttributeListOptions(field.attributeCode);
  const listReady = Boolean(options && options.length > 0);
  const numeric = isNumericAttribute(field.dataType);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const shown = pending ?? field.value;
  const meta = useAttributeDisplay(field.attributeCode);
  const target = referenceTarget({ dataType: field.dataType || meta?.dataType, referenceDomainCode: meta?.referenceDomainCode });
  const ref = useEntityRef(shown, Boolean(target));
  const display = target && ref ? ref.entityName : listDisplayLabel(shown, options) || formatAttributeValue(shown, field.dataType, {
    dataType: field.dataType || meta?.dataType,
    displayFormat: meta?.displayFormat,
    numericPrecision: meta?.numericPrecision,
    unitOfMeasure: meta?.unitOfMeasure,
    referenceDomainCode: meta?.referenceDomainCode,
  });
  const parent = useParentConflict(field.attributeCode, shown);
  const parentNote = parent.conflict ? (
    <span className="sa-field-error" title={`Pick again: this value is not under ${parent.parentLabel}.`}>
      Not under {parent.parentLabel}
    </span>
  ) : null;
  const refLink = target && ref ? (
    <Link
      href={entityRefHref(ref)}
      className="sa-ref-link"
      title={`Open ${ref.entityName}`}
      aria-label={`Open ${ref.entityName}`}
      onClick={(event) => event.stopPropagation()}
    >
      ↗
    </Link>
  ) : null;

  useEffect(() => {
    if (!editing) setDraft(inlineDraft(pending ?? field.value));
  }, [field.value, editing, pending]);

  useEffect(() => {
    if (pending == null) return;
    const arrived = inlineCommitValue(field.value, '', numeric) ?? '';
    if (arrived === pending) {
      pendingRef.current = null;
      setPending(null);
    }
  }, [field.value, pending, numeric]);

  if (!onSave) {
    return (
      <span className={`sa-field-value ${field.conflict ? 'conflict' : ''}`}>
        {target && ref ? <Link href={entityRefHref(ref)} className="crumb-link">{display}</Link> : display}
        {parentNote}
      </span>
    );
  }

  const persist = (raw: string) => {
    const next = inlineCommitValue(raw, pendingRef.current ?? field.value, numeric);
    setEditing(false);
    if (!next) return;
    pendingRef.current = next;
    setPending(next);
    setError(null);
    setSaving(true);
    void Promise.resolve(onSave(next))
      .catch((err: unknown) => {
        pendingRef.current = null;
        setPending(null);
        setError(err instanceof Error ? err.message : 'Could not save');
      })
      .finally(() => setSaving(false));
  };

  const commit = () => {
    if (skipCommit.current) {
      skipCommit.current = false;
      return;
    }
    persist(draftRef.current);
  };

  const editValue = (next: string) => {
    draftRef.current = next;
    setDraft(next);
  };

  return (
    <span className="sa-source-value-wrap" onClick={(event) => event.stopPropagation()}>
      {editing || listReady ? (
        <AttributeValueInput
          attributeCode={field.attributeCode}
          dataType={field.dataType}
          className="text-input sa-field-value-edit"
          style={{ fontSize: '13px', padding: '1px 6px', minWidth: '8rem' }}
          value={draft}
          autoFocus={editing && !listReady}
          ariaLabel={field.label}
          disabled={saving}
          onClick={(event) => event.stopPropagation()}
          onChange={editValue}
          onSelect={(next) => {
            editValue(next);
            persist(next);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              skipCommit.current = true;
              const reset = inlineDraft(shown);
              draftRef.current = reset;
              setDraft(reset);
              setEditing(false);
            }
          }}
          onBlur={commit}
        />
      ) : (
        <button
          type="button"
          className={`field-edit sa-field-value-edit sa-field-value ${field.conflict ? 'conflict' : ''}`}
          title="Edit the golden value. This saves a manual override."
          disabled={saving}
          onClick={(event) => {
            event.stopPropagation();
            setDraft(inlineDraft(shown));
            setEditing(true);
          }}
        >
          {display || '—'}
        </button>
      )}
      {!editing && refLink}
      {!editing && parentNote}
      {saving && (
        <svg className="sa-save-spin" viewBox="0 0 16 16" width="14" height="14" role="status" aria-label="Saving">
          <path
            fill="currentColor"
            d="M13.7 2.3A7 7 0 0 0 2.4 6.2l1.5.4a5.4 5.4 0 0 1 8.7-2.4L11 6h4V2l-1.3.3zM2.3 13.7A7 7 0 0 0 13.6 9.8l-1.5-.4a5.4 5.4 0 0 1-8.7 2.4L5 10H1v4l1.3-.3z"
          />
        </svg>
      )}
      {error && <span className="sa-field-error">{error}</span>}
    </span>
  );
}
