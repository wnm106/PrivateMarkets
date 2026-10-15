'use client';

import { useEffect, useRef, useState } from 'react';
import { sources, type SourceKey, type FieldDrilldown } from '@/lib/data';
import { graphqlQuery } from '@/lib/graphql';

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
  source: SourceKey;
  conflict?: boolean;
  alt?: number;
  standardized?: boolean;
  /** Precedence rank for the current golden source (lower = higher priority) */
  precedenceRank?: number;
  /** All competing source values with their precedence ranks */
  competingValues?: Array<{
    source: SourceKey;
    sourceName: string;
    value: string;
    precedenceRank: number;
    validFrom: string;
    validTo: string;
    confidenceScore: number | null;
  }>;
  /** The resolution rule that determined the golden value */
  resolutionRule?: string;
}

interface SourceAttributedFieldRowProps {
  field: FieldData;
  onDrilldown?: (label: string) => void;
  onSourceChange?: (label: string, newSource: SourceKey) => void;
  onValueChange?: (label: string, newValue: string) => void;
  onAddSourceValue?: (attributeCode: string, source: SourceKey, value: string) => void;
  onDeleteSourceValue?: (attributeCode: string, sourceCode: string) => void;
  asOfDate?: string;
}

export function SourceAttributedFieldRow({ field, onDrilldown, onAddSourceValue, onDeleteSourceValue, asOfDate }: SourceAttributedFieldRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSource, setNewSource] = useState<SourceKey>('manual');
  const [newSourceValue, setNewSourceValue] = useState('');
  const [availableSources, setAvailableSources] = useState<Array<{ key: SourceKey; name: string; hex: string }>>([]);

  // Fetch available sources from database on mount
  useEffect(() => {
    const fetchSources = async () => {
      try {
        const result = await graphqlQuery<{ dataSources: Array<{ sourceCode: string; sourceName: string; metadata: any }> }>(
          `query { dataSources { sourceCode sourceName metadata } }`,
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
              hex: metadata.color || sources[key]?.hex || '#475569'
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
  const src = sources[normalizedFieldSource] ?? { name: field.source, color: '#475569', hex: '#475569' };
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
            reliability: cv.confidenceScore,
            status: isWinner ? 'winner' as const : hasData ? 'eligible' as const : 'no-data' as const,
            divergent: !isWinner && hasData && cv.value !== field.value ? true : undefined,
            muted: !hasData ? true : undefined,
          };
        }),
      }
    : {
        rule: 'No other source values are stored for this attribute.',
        candidates: [
          {
            src: field.source,
            value: field.value,
            updated: '—',
            synced: '—',
            reliability: null,
            status: 'winner' as const,
          },
        ],
      };

  const borderColor = src.hex;

  return (
    <>
      <div
        className="sa-field-row"
        style={{ '--field-color': borderColor } as React.CSSProperties}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="sa-field-label">
          {field.label}
          {field.standardized && <span className="std-icon" title="Standardized via list mapping">S</span>}
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
          <button
            className="sa-edit-btn"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((open) => !open);
              onDrilldown?.(field.label);
            }}
            title="Show source values"
          >
            ⌄
          </button>
        </div>
      </div>

      {expanded && (
        <div className="sa-drilldown" style={{ '--field-color': borderColor } as React.CSSProperties}>
          <div className="sa-drill-head">
            <div className="sa-drill-title">
              <span>{field.label}</span>
              <span className="sa-drill-rule">{drilldown.rule}</span>
            </div>
            <button
              className="sa-drill-close"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(false);
              }}
            >
              ✕
            </button>
          </div>
          <div className="sa-drill-table">
            <div className="sa-drill-thead">
              <div className="sa-drill-th"></div>
              <div className="sa-drill-th">Source</div>
              <div className="sa-drill-th">Value</div>
              <div className="sa-drill-th">Source Updated</div>
              <div className="sa-drill-th">Reliability</div>
              <div className="sa-drill-th">Status</div>
            </div>
            {drilldown.candidates.map((c, i) => {
              // Normalize source code to lowercase for lookup
              const normalizedSrc = (c.src || '').toLowerCase();
              const cSrc = sources[normalizedSrc as SourceKey] ?? { name: c.src, hex: '#475569' };
              const relPct = c.reliability ?? 0;
              const relBarColor = relPct >= 90 ? 'var(--green)' : relPct >= 70 ? 'var(--accent-2)' : 'var(--red)';
              const daysAgo = c.updated && c.updated !== '—'
                ? Math.max(1, Math.floor((Date.now() - new Date(c.updated).getTime()) / 86400000))
                : null;

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
                        onSave={onAddSourceValue && field.attributeCode
                          ? (next) => onAddSourceValue(field.attributeCode || field.label, c.src, next)
                          : undefined}
                      />
                    )}
                  </div>
                  <div className="sa-drill-td sa-drill-updated">
                    {c.updated && c.updated !== '—' ? (
                      <>
                        <div>{c.updated}</div>
                        {daysAgo && <div className="sa-drill-rel-time">{daysAgo}d ago</div>}
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
                        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: '6px', marginLeft: '8px', alignItems: 'center' }}>
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
                          style={{ marginLeft: '8px' }}
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
                <input
                  className="text-input"
                  style={{ flex: 1, fontSize: '12px', padding: '6px 8px' }}
                  placeholder="Enter value..."
                  value={newSourceValue}
                  onChange={(e) => setNewSourceValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newSourceValue.trim()) {
                      // Validate source exists before calling parent
                      const sourceExists = availableSources.find(s => s.key === newSource);
                      if (sourceExists) {
                        onAddSourceValue?.(field.attributeCode || field.label, newSource, newSourceValue.trim());
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
                        onAddSourceValue?.(field.attributeCode || field.label, newSource, newSourceValue.trim());
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
        </div>
      )}
    </>
  );
}

function SourceValueEditor({
  value,
  dataType,
  onSave,
}: {
  value: string;
  dataType?: string;
  onSave?: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const skipCommit = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const display = formatAttributeValue(value, dataType);
  if (!onSave) return <>{display}</>;

  const commit = () => {
    if (skipCommit.current) {
      skipCommit.current = false;
      return;
    }
    const numeric = Boolean(dataType && NUMERIC_TYPES.has(dataType.toUpperCase()));
    const next = (numeric ? draft.replace(/,/g, '') : draft).trim();
    const current = (numeric ? value.replace(/,/g, '') : value).trim();
    setEditing(false);
    if (next && next !== current) onSave(next);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="sa-source-value"
        title="Edit this source value"
        onClick={(event) => {
          event.stopPropagation();
          setDraft(value);
          setEditing(true);
        }}
      >
        {display}
      </button>
    );
  }

  return (
    <input
      className="text-input"
      style={{ fontSize: '12px', padding: '4px 6px', minWidth: '120px' }}
      value={draft}
      autoFocus
      aria-label="Source value"
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
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
