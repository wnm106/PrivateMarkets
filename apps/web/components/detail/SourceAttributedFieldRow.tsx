'use client';

import { useEffect, useRef, useState } from 'react';
import { sources, type SourceKey, type FieldDrilldown } from '@/lib/data';
import { formatReceipt, isStaleReceipt, receiptAgeDays } from '@/lib/receipt-freshness';
import { graphqlQuery } from '@/lib/graphql';
import { AttributeValueInput, useAttributeListOptions, type ListOption } from '@/components/forms/AttributeValueInput';
import { CalcBreakdownPanel } from './CalcBreakdownPanel';
import { AttributeTimeline } from './AttributeTimeline';

const NUMERIC_TYPES = new Set(['NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL', 'FLOAT', 'NUMERIC']);

export function formatAttributeValue(value: string, dataType?: string): string {
  if (!value || value === '—') return value || '—';
  if (!dataType || !NUMERIC_TYPES.has(dataType.toUpperCase())) return value;
  const parsed = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export interface FieldData {
  label: string;
  attributeCode?: string;
  dataType?: string;
  value: string;
  source: string;
  conflict?: boolean;
  alt?: number;
  standardized?: boolean;
  /** Precedence rank for the current golden source (lower = higher priority) */
  precedenceRank?: number;
  /** All competing source values with their precedence ranks */
  competingValues?: Array<{
    source: string;
    sourceName: string;
    value: string;
    precedenceRank: number;
    validFrom: string;
    validTo: string;
    confidenceScore: number | null;
    receivedAt?: string | null;
  }>;
  /** When the prevailing source last delivered this value. */
  receivedAt?: string | null;
  /** The resolution rule that determined the golden value */
  resolutionRule?: string;
  /** True when the attribute is produced by a calculation rather than a feed. */
  calculated?: boolean;
  formula?: string;
  /** Source that supplied the number currently shown, when it is not the formula result. */
  storedSourceName?: string;
}

interface SourceAttributedFieldRowProps {
  field: FieldData;
  onDrilldown?: (label: string) => void;
  onSourceChange?: (label: string, newSource: SourceKey) => void;
  onValueChange?: (label: string, newValue: string) => void;
  onAddSourceValue?: (attributeCode: string, source: SourceKey, value: string) => void | Promise<void>;
  onDeleteSourceValue?: (attributeCode: string, sourceCode: string) => void;
  asOfDate?: string;
  entityId?: string;
}

export function SourceAttributedFieldRow({ field, onDrilldown, onAddSourceValue, onDeleteSourceValue, asOfDate, entityId }: SourceAttributedFieldRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [drillTab, setDrillTab] = useState<'sources' | 'timeline'>('sources');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSource, setNewSource] = useState<SourceKey>('manual');
  const [newSourceValue, setNewSourceValue] = useState('');
  const [availableSources, setAvailableSources] = useState<Array<{ key: SourceKey; name: string; hex: string }>>([]);

  // Fetch available sources from database on mount
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
          
          // Set default to first available source
          if (dbSources.length > 0 && !dbSources.find(s => s.key === 'manual')) {
            setNewSource(dbSources[0].key);
          }
        }
      } catch (err) {
        console.error('Failed to fetch sources:', err);
        // Fallback to hardcoded sources
        setAvailableSources(Object.entries(sources).map(([key, src]) => ({
          key: key as SourceKey,
          name: src.name,
          hex: src.hex
        })));
      }
    };
    
    fetchSources();
  }, []);

  // Normalize source to lowercase for lookup
  const normalizedFieldSource = (field.source || '').toLowerCase() as SourceKey;
  const dbSource = availableSources.find((source) => source.key === normalizedFieldSource);
  const src = dbSource
    ? { name: dbSource.name, color: dbSource.hex, hex: dbSource.hex }
    : (sources[normalizedFieldSource] ?? { name: field.source, color: '#475569', hex: '#475569' });
  const drilldown: FieldDrilldown = field.competingValues
    ? {
        rule: field.resolutionRule || 'Domain default precedence rule applies',
        candidates: field.competingValues.map((cv) => {
          // Normalize sources for comparison
          const normalizedCvSource = (cv.source || '').toLowerCase();
          const normalizedFieldSource = (field.source || '').toLowerCase();
          const isWinner = normalizedCvSource === normalizedFieldSource && cv.value === field.value;
          const hasData = cv.value && cv.value !== '—' && cv.value !== '';
          return {
            src: cv.source,
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
            src: field.source,
            value: field.value,
            updated: '—',
            synced: '—',
            receivedAt: field.receivedAt,
            reliability: null,
            status: 'winner' as const,
          },
        ],
      };

  const borderColor = src.hex;
  const receiptAge = receiptAgeDays(field.receivedAt);
  const receiptStale = isStaleReceipt(field.receivedAt, field.source);

  return (
    <>
      <div
        className="sa-field-row"
        style={{ '--field-color': borderColor } as React.CSSProperties}
        onClick={() => {
          setExpanded((open) => {
            if (open) setDrillTab('sources');
            return !open;
          });
        }}
      >
        <div className="sa-field-label">
          {field.label}
          {field.calculated && (
            <span className="std-icon" title={field.formula || 'Calculated value'}>ƒ</span>
          )}
          {field.standardized && <span className="std-icon" title="Standardized via list mapping">S</span>}
          {field.formula && (
            <div style={{ fontSize: '11px', color: 'var(--ink-3)', fontWeight: 400, marginTop: '2px' }}>{field.formula}</div>
          )}
        </div>
        <div className="sa-field-value-cell">
          <span className={`sa-field-value ${field.conflict ? 'conflict' : ''}`}>
            {formatAttributeValue(field.value, field.dataType)}
          </span>
          {field.conflict && <span className="conflict-badge">CONFLICT</span>}
          {field.alt && field.alt > 0 && (
            <span className="alt-count" title={`${field.alt} alternative value(s) available`}>±{field.alt}</span>
          )}
        </div>
        <div className="sa-field-source-cell">
          <span
            className="src-pill"
            style={{ color: '#fff', background: src.hex }}
            title="Golden source, derived from the source values"
          >
            {src.name}
            {field.precedenceRank !== undefined && (
              <span style={{ marginLeft: '4px', fontSize: '9px', opacity: 0.8 }}>
                (P{field.precedenceRank})
              </span>
            )}
          </span>
          {field.receivedAt && receiptAge != null && (
            <span
              className={`receipt-age${receiptStale ? ' stale' : ''}`}
              title={`Last received ${formatReceipt(field.receivedAt)}. A restatement of the same value still updates this time.`}
            >
              {receiptStale ? `Stale ${receiptAge}d` : receiptAge === 0 ? 'Received today' : `Received ${receiptAge}d ago`}
            </span>
          )}
          <button
            className="sa-edit-btn"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((open) => {
                if (!open) setDrillTab('sources');
                return !open;
              });
              onDrilldown?.(field.label);
            }}
            title={field.calculated ? 'Show how this was calculated' : 'Show source values'}
          >
            ⌄
          </button>
        </div>
      </div>

      {expanded && (
        <div className="sa-drilldown" style={{ '--field-color': borderColor } as React.CSSProperties}>
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
              <div className="sa-drill-th">Last received</div>
              <div className="sa-drill-th">Reliability</div>
              <div className="sa-drill-th">Status</div>
            </div>
            {drilldown.candidates.map((c, i) => {
              // Normalize source code to lowercase for lookup
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
                        <div>{formatReceipt(c.receivedAt)}</div>
                        {receivedAge != null && (
                          <div className={`sa-drill-rel-time${receivedStale ? ' stale' : ''}`}>
                            {receivedStale ? `Stale · ${receivedAge}d` : receivedAge === 0 ? 'Today' : `${receivedAge}d ago`}
                          </div>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </div>
                  <div className="sa-drill-td sa-drill-reliability">
                    <div className="sa-drill-rel-pct" style={{ fontWeight: 600 }}>{relPct}%</div>
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
              <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '10px', color: 'var(--ink-2)' }}>
                Add Competing Source Value
              </div>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
                <select
                  className="select"
                  style={{ flex: 1, fontSize: '12px', padding: '6px 8px' }}
                  value={newSource}
                  onChange={(e) => setNewSource(e.target.value as SourceKey)}
                  onClick={(e) => e.stopPropagation()}
                >
                  {availableSources.length === 0 ? (
                    <option value="">Loading sources...</option>
                  ) : (
                    availableSources.map((src) => (
                      <option key={src.key} value={src.key}>{src.name}</option>
                    ))
                  )}
                </select>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <AttributeValueInput
                  attributeCode={field.attributeCode}
                  dataType={field.dataType}
                  className="text-input"
                  style={{ flex: 1, fontSize: '12px', padding: '6px 8px' }}
                  placeholder="Enter value..."
                  value={newSourceValue}
                  onChange={setNewSourceValue}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newSourceValue.trim()) {
                      // Validate source exists before calling parent
                      const sourceExists = availableSources.find(s => s.key === newSource);
                      if (sourceExists) {
                        void Promise.resolve(onAddSourceValue?.(field.attributeCode || field.label, newSource, newSourceValue.trim())).catch(() => undefined);
                        setNewSourceValue('');
                        setShowAddSource(false);
                      } else {
                        console.error('Selected source is not available');
                      }
                    }
                  }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (newSourceValue.trim()) {
                      // Validate source exists before calling parent
                      const sourceExists = availableSources.find(s => s.key === newSource);
                      if (sourceExists) {
                        void Promise.resolve(onAddSourceValue?.(field.attributeCode || field.label, newSource, newSourceValue.trim())).catch(() => undefined);
                        setNewSourceValue('');
                        setShowAddSource(false);
                      } else {
                        console.error('Selected source is not available');
                      }
                    }
                  }}
                >
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
      )}
    </>
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
  /** The value the user just chose, shown until the saved record arrives. */
  const [pending, setPending] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const skipCommit = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const options = useAttributeListOptions(attributeCode);
  const numeric = Boolean(dataType && NUMERIC_TYPES.has(dataType.toUpperCase()));

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
      style={{ fontSize: '12px', padding: '4px 6px', minWidth: '120px' }}
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
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
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
