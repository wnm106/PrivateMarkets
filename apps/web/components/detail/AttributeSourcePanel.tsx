'use client';

import { useEffect, useRef, useState } from 'react';
import { sources, type FieldDrilldown, type SourceKey } from '@/lib/data';
import { formatReceipt, isStaleReceipt, receiptAgeDays } from '@/lib/receipt-freshness';
import { graphqlQuery } from '@/lib/graphql';
import { AttributeValueInput, useAttributeListOptions, type ListOption } from '@/components/forms/AttributeValueInput';
import { CalcBreakdownPanel } from './CalcBreakdownPanel';
import { AttributeTimeline } from './AttributeTimeline';
import { formatAttributeValue, isNumericAttribute, type FieldData } from './attribute-source';

export interface SourceOption {
  key: SourceKey;
  name: string;
  hex: string;
}

interface AttributeSourcePanelProps {
  field: FieldData;
  entityId?: string;
  asOfDate?: string;
  calcRefreshKey?: string;
  onAddSourceValue?: (attributeCode: string, source: SourceKey, value: string) => void | Promise<void>;
  onDeleteSourceValue?: (attributeCode: string, sourceCode: string) => void;
  availableSources?: SourceOption[];
  /** Drops the inline left border when the panel is the body of a dialog. */
  standalone?: boolean;
}

export function AttributeSourcePanel({
  field,
  entityId,
  asOfDate,
  calcRefreshKey,
  onAddSourceValue,
  onDeleteSourceValue,
  availableSources: availableSourcesProp,
  standalone = false,
}: AttributeSourcePanelProps) {
  const [drillTab, setDrillTab] = useState<'sources' | 'timeline'>('sources');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSource, setNewSource] = useState<SourceKey>('manual');
  const [newSourceValue, setNewSourceValue] = useState('');
  const [fetchedSources, setFetchedSources] = useState<SourceOption[]>([]);

  useEffect(() => {
    if (availableSourcesProp) return;
    let cancelled = false;
    graphqlQuery<{ dataSources: Array<{ sourceCode: string; sourceName: string; color: string | null; metadata: any }> }>(
      `query { dataSources { sourceCode sourceName color metadata } }`,
      {},
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      const rows = result.data?.dataSources;
      const next = rows?.length
        ? rows.map((ds) => {
            const key = ds.sourceCode.toLowerCase() as SourceKey;
            const metadata = ds.metadata || {};
            return {
              key,
              name: ds.sourceName,
              hex: ds.color || metadata.color || sources[key]?.hex || '#475569',
            };
          })
        : Object.entries(sources).map(([key, src]) => ({
            key: key as SourceKey,
            name: src.name,
            hex: src.hex,
          }));
      setFetchedSources(next);
      if (next.length > 0 && !next.find((source) => source.key === 'manual')) setNewSource(next[0].key);
    }).catch(() => {
      if (cancelled) return;
      const next = Object.entries(sources).map(([key, src]) => ({
        key: key as SourceKey,
        name: src.name,
        hex: src.hex,
      }));
      setFetchedSources(next);
    });
    return () => { cancelled = true; };
  }, [availableSourcesProp]);

  const availableSources = availableSourcesProp ?? fetchedSources;
  const normalizedFieldSource = (field.source || '').toLowerCase() as SourceKey;
  const dbSource = availableSources.find((source) => source.key === normalizedFieldSource);
  const src = dbSource
    ? { name: dbSource.name, hex: dbSource.hex }
    : (sources[normalizedFieldSource] ?? { name: field.source, hex: '#475569' });

  const drilldown: FieldDrilldown = field.competingValues
    ? {
        rule: field.resolutionRule || 'Domain default precedence rule applies',
        candidates: field.competingValues.map((cv) => {
          const normalizedCvSource = (cv.source || '').toLowerCase();
          const isWinner = normalizedCvSource === normalizedFieldSource && cv.value === field.value;
          const hasData = Boolean(cv.value && cv.value !== '—' && cv.value !== '');
          return {
            src: cv.source as SourceKey,
            value: cv.value,
            updated: cv.validFrom !== '9999-12-31' ? cv.validFrom : '—',
            synced: '—',
            receivedAt: cv.receivedAt,
            reliability: cv.confidenceScore,
            status: isWinner ? 'winner' as const : hasData ? 'eligible' as const : 'no-data' as const,
            divergent: !isWinner && hasData && cv.value !== field.value ? true : undefined,
            muted: !hasData ? true : undefined,
          };
        }),
      }
    : {
        rule: field.formula || field.resolutionRule || 'No other source values are stored for this attribute.',
        candidates: [
          {
            src: field.source as SourceKey,
            value: field.value,
            updated: '—',
            synced: '—',
            receivedAt: field.receivedAt,
            reliability: null,
            status: 'winner' as const,
          },
        ],
      };

  const saveNewValue = () => {
    const trimmed = newSourceValue.trim();
    if (!trimmed) return;
    const sourceExists = availableSources.find((source) => source.key === newSource);
    if (!sourceExists) return;
    void Promise.resolve(onAddSourceValue?.(field.attributeCode || field.label, newSource, trimmed)).catch(() => undefined);
    setNewSourceValue('');
    setShowAddSource(false);
  };

  return (
    <div
      className={`sa-drilldown${standalone ? ' sa-drilldown-standalone' : ''}`}
      style={{ '--field-color': src.hex } as React.CSSProperties}
    >
      <div className="sa-drill-tabs" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className={`sa-drill-tab${drillTab === 'sources' ? ' active' : ''}`}
          onClick={() => setDrillTab('sources')}
        >
          {field.calculated ? 'Calculation' : 'Data Source Sequence'}
        </button>
        <button
          type="button"
          className={`sa-drill-tab${drillTab === 'timeline' ? ' active' : ''}`}
          onClick={() => setDrillTab('timeline')}
        >
          Timeline
        </button>
      </div>
      {drillTab === 'timeline' && entityId && field.attributeCode ? (
        <AttributeTimeline
          embedded
          entityId={entityId}
          attributes={[{ code: field.attributeCode, name: field.label }]}
        />
      ) : field.calculated && entityId && field.attributeCode ? (
        <CalcBreakdownPanel
          entityId={entityId}
          attributeCode={field.attributeCode}
          asOfDate={asOfDate}
          refreshKey={calcRefreshKey}
          formula={field.formula}
          displayedValue={field.value}
          displayedSourceName={src.name}
        />
      ) : (
        <>
          <div className="sa-drill-table sa-source-seq">
            <div className="sa-drill-thead">
              <div className="sa-drill-th"></div>
              <div className="sa-drill-th">Source</div>
              <div className="sa-drill-th">Value</div>
              <div className="sa-drill-th sa-drill-received">Last received</div>
              <div className="sa-drill-th">Reliability</div>
              <div className="sa-drill-th">Status</div>
            </div>
            {drilldown.candidates.map((c, i) => {
              const normalizedSrc = (c.src || '').toLowerCase();
              const dbCandidate = availableSources.find((source) => source.key === normalizedSrc);
              const cSrc = dbCandidate
                ? { name: dbCandidate.name, hex: dbCandidate.hex }
                : (sources[normalizedSrc as SourceKey] ?? { name: c.src, hex: '#475569' });
              const relPct = c.reliability ?? 0;
              const relBarColor = relPct >= 90 ? 'var(--green)' : relPct >= 70 ? 'var(--accent-2)' : 'var(--red)';
              const receivedAge = receiptAgeDays(c.receivedAt);
              const receivedStale = isStaleReceipt(c.receivedAt, c.src);

              return (
                <div key={i} className={`sa-drill-trow ${c.status}`} style={{ '--row-color': cSrc.hex } as React.CSSProperties}>
                  <div className="sa-drill-td sa-drill-row-num">{i + 1}</div>
                  <div className="sa-drill-td">
                    <span
                      className="src-pill-sm"
                      style={{
                        color: c.muted ? 'var(--ink-4)' : '#fff',
                        background: c.muted ? 'var(--bg-alt)' : cSrc.hex,
                      }}
                    >
                      {cSrc.name}
                    </span>
                  </div>
                  <div className={`sa-drill-td sa-drill-value ${c.muted ? 'muted' : ''} ${c.divergent ? 'divergent' : ''}`}>
                    {c.muted || !c.value || c.value === '—' ? (
                      '— Not covered'
                    ) : (
                      <SourceValueEditor
                        value={c.value}
                        dataType={field.dataType}
                        attributeCode={field.attributeCode}
                        onSave={onAddSourceValue && field.attributeCode
                          ? (next) => onAddSourceValue(field.attributeCode || field.label, c.src, next)
                          : undefined}
                      />
                    )}
                  </div>
                  <div className="sa-drill-td sa-drill-updated">
                    {c.receivedAt ? (
                      <>
                        <span>{formatReceipt(c.receivedAt)}</span>
                        {receivedAge != null && (
                          <span className={`sa-drill-rel-time${receivedStale ? ' stale' : ''}`}>
                            {receivedStale ? `Stale ${receivedAge}d` : receivedAge === 0 ? 'Today' : `${receivedAge}d ago`}
                          </span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </div>
                  <div className="sa-drill-td sa-drill-reliability">
                    <div className="sa-drill-rel-pct">{relPct}%</div>
                    <div className="sa-drill-rel-bar">
                      <div style={{ width: `${relPct}%`, background: relBarColor }} />
                    </div>
                  </div>
                  <div className="sa-drill-td sa-drill-status">
                    {c.status === 'winner' && <span className="sa-status-badge winner">WINNER</span>}
                    {c.status === 'eligible' && <span className="sa-status-badge eligible">ELIGIBLE</span>}
                    {c.status === 'no-data' && <span className="sa-status-badge no-data">NO DATA</span>}
                    {c.status === 'skipped' && <span className="sa-status-badge skipped">SKIPPED</span>}
                    {c.status === 'applied' && <span className="sa-status-badge applied">APPLIED</span>}
                    {onDeleteSourceValue && c.value && c.value !== '—' && (
                      pendingDelete === String(c.src) ? (
                        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                          <button
                            className="btn btn-sm"
                            onClick={() => onDeleteSourceValue(field.attributeCode || field.label, String(c.src))}
                          >
                            End as of {asOfDate || 'today'}
                          </button>
                          <button className="btn btn-sm" onClick={() => setPendingDelete(null)}>Cancel</button>
                        </span>
                      ) : (
                        <button
                          className="btn btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDelete(String(c.src));
                          }}
                        >
                          Delete
                        </button>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {!showAddSource ? (
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)' }}>
              <button
                className="btn btn-sm"
                style={{ width: '100%', textAlign: 'center' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAddSource(true);
                }}
              >
                + Add Source Value
              </button>
            </div>
          ) : (
            <div style={{ padding: '16px 20px', borderTop: '1px solid var(--line)', background: 'var(--bg)' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '10px', color: 'var(--ink-2)' }}>
                Add Competing Source Value
              </div>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
                <select
                  className="select"
                  style={{ flex: 1, fontSize: '13px', padding: '6px 8px' }}
                  value={newSource}
                  onChange={(e) => setNewSource(e.target.value as SourceKey)}
                  onClick={(e) => e.stopPropagation()}
                >
                  {availableSources.length === 0 ? (
                    <option value="">Loading sources...</option>
                  ) : (
                    availableSources.map((option) => (
                      <option key={option.key} value={option.key}>{option.name}</option>
                    ))
                  )}
                </select>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <AttributeValueInput
                  attributeCode={field.attributeCode}
                  dataType={field.dataType}
                  className="text-input"
                  style={{ flex: 1, fontSize: '13px', padding: '6px 8px' }}
                  placeholder="Enter value..."
                  value={newSourceValue}
                  onChange={setNewSourceValue}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveNewValue();
                  }}
                />
                <button className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); saveNewValue(); }}>
                  Add
                </button>
                <button
                  className="btn btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowAddSource(false);
                    setNewSourceValue('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function choiceLabel(value: string, options: ListOption[] | null): string | null {
  if (!value || !options?.length) return null;
  const match = options.find((option) => option.value === value || option.displayLabel === value || option.label === value);
  return match?.label || null;
}

function SourceValueEditor({
  value,
  dataType,
  attributeCode,
  onSave,
}: {
  value: string;
  dataType?: string;
  attributeCode?: string;
  onSave?: (value: string) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const skipCommit = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const options = useAttributeListOptions(attributeCode);
  const numeric = isNumericAttribute(dataType);

  const normalize = (raw: string) => (numeric ? raw.replace(/,/g, '') : raw).trim();

  useEffect(() => {
    if (!editing) setDraft(pending ?? value);
  }, [value, editing, pending]);

  useEffect(() => {
    if (pending == null) return;
    if (normalize(value) === pending) {
      pendingRef.current = null;
      setPending(null);
    }
  }, [value, pending, numeric]);

  const shown = pending ?? value;
  const display = choiceLabel(shown, options) || formatAttributeValue(shown, dataType);
  if (!onSave) return <>{display}</>;

  const persist = (raw: string) => {
    const next = normalize(raw);
    const current = normalize(pendingRef.current ?? value);
    setEditing(false);
    if (!next || next === current) return;
    pendingRef.current = next;
    setPending(next);
    setSaving(true);
    void Promise.resolve(onSave(next))
      .catch(() => {
        pendingRef.current = null;
        setPending(null);
      })
      .finally(() => setSaving(false));
  };

  const commit = () => {
    if (skipCommit.current) {
      skipCommit.current = false;
      return;
    }
    persist(draft);
  };

  if (!editing) {
    return (
      <span className="sa-source-value-wrap">
        <button
          type="button"
          className="sa-source-value"
          title="Edit this source value"
          disabled={saving}
          onClick={(event) => {
            event.stopPropagation();
            setDraft(shown);
            setEditing(true);
          }}
        >
          {display}
        </button>
        {saving && (
          <svg className="sa-save-spin" viewBox="0 0 16 16" width="14" height="14" role="status" aria-label="Saving">
            <path
              fill="currentColor"
              d="M13.7 2.3A7 7 0 0 0 2.4 6.2l1.5.4a5.4 5.4 0 0 1 8.7-2.4L11 6h4V2l-1.3.3zM2.3 13.7A7 7 0 0 0 13.6 9.8l-1.5-.4a5.4 5.4 0 0 1-8.7 2.4L5 10H1v4l1.3-.3z"
            />
          </svg>
        )}
      </span>
    );
  }

  return (
    <AttributeValueInput
      attributeCode={attributeCode}
      dataType={dataType}
      className="text-input"
      style={{ fontSize: '13px', padding: '4px 6px', minWidth: '120px' }}
      value={draft}
      autoFocus
      ariaLabel="Source value"
      onClick={(event) => event.stopPropagation()}
      onChange={setDraft}
      onSelect={(next) => {
        setDraft(next);
        persist(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          skipCommit.current = true;
          setDraft(value);
          setEditing(false);
        }
      }}
      onBlur={commit}
    />
  );
}
