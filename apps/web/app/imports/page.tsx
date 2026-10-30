'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { dependencyLoadWaves } from '@/lib/feeds/load-order';
import {
  TRANSFORM_OPTIONS,
  applyTarget,
  feedMapFromAssignments,
  previewTransform,
  targetKey,
  type ColumnAssignment,
  type MappingTarget,
} from '@/lib/feeds/suggest';

interface InstanceSummary {
  id: string;
  fileName: string;
  rowCount: number;
  status: string;
  receivedAt: string;
  completedAt: string | null;
  asOfDate: string | null;
  errorMessage: string | null;
  runs: { startedAt: string; completedAt: string; asOfDate: string; status: string; created: number; matched: number; failed: number }[];
  resultSummary: {
    created: number;
    matched: number;
    failed: number;
    attributesCreated: number;
    attributesUpdated: number;
    attributesUnchanged: number;
    relationshipsMatched: number;
  } | null;
}

interface InstanceDetail extends InstanceSummary {
  columnMappings: ColumnAssignment[];
  loadWaves: string[][];
}

interface QueueResponse {
  sourceCode: string;
  name: string;
  description: string;
  targets: MappingTarget[];
  instances: InstanceSummary[];
}

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function formatWhen(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function resultText(instance: InstanceSummary) {
  if (!instance.resultSummary) return instance.status === 'READY' ? 'Stored, not processed' : instance.status;
  const summary = instance.resultSummary;
  const entities = summary.created === 0 && summary.failed === 0
    ? `${summary.matched} matched`
    : `${summary.created} created · ${summary.matched} matched${summary.failed ? ` · ${summary.failed} failed` : ''}`;
  const attributes = summary.attributesUpdated
    ? `attributes updated ${summary.attributesUpdated}`
    : summary.attributesCreated
      ? `attributes created ${summary.attributesCreated}`
      : `attributes unchanged ${summary.attributesUnchanged}`;
  return `${entities} · ${attributes}`;
}

const GRID = '180px 1.1fr 1.4fr 180px 1fr';

export default function PositionFilePage() {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [asOfMode, setAsOfMode] = useState<'today' | 'specific'>('specific');
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadWaves = useMemo(() => {
    if (!detail) return [];
    try {
      const map = feedMapFromAssignments(detail.columnMappings);
      return map.domains.length > 0 ? dependencyLoadWaves(map.domains) : [];
    } catch {
      return [];
    }
  }, [detail]);

  const targetsByGroup = useMemo(() => {
    const groups = new Map<string, MappingTarget[]>();
    for (const target of queue?.targets || []) {
      const list = groups.get(target.group) || [];
      list.push(target);
      groups.set(target.group, list);
    }
    return [...groups.entries()];
  }, [queue]);

  async function refreshQueue() {
    const response = await fetch('/api/feeds/position-file');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'The import queue is unavailable');
    setQueue(body);
    return body as QueueResponse;
  }

  useEffect(() => {
    refreshQueue().catch((err) => setError(err.message));
  }, []);

  function openDetail(instance: InstanceDetail) {
    setDetail(instance);
    setError(null);
    if (instance.asOfDate) {
      setAsOfDate(instance.asOfDate);
      setAsOfMode('specific');
    }
  }

  async function selectInstance(id: string) {
    setBusy('open');
    setError(null);
    try {
      const response = await fetch(`/api/feeds/position-file/${id}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The instance could not be opened');
      openDetail(body);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  function chosenDate() {
    return asOfMode === 'today' ? todayIso() : asOfDate;
  }

  function updateAssignment(index: number, next: ColumnAssignment) {
    setDetail((current) => {
      if (!current) return current;
      const columnMappings = current.columnMappings.slice();
      columnMappings[index] = next;
      return { ...current, columnMappings };
    });
  }

  async function processInstance(instanceId: string, mappings?: ColumnAssignment[]) {
    setBusy(instanceId);
    setError(null);
    try {
      const response = await fetch(`/api/feeds/position-file/${instanceId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columnMappings: mappings,
          asOfDate: mappings ? chosenDate() : undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Process failed');
      openDetail(body);
      await refreshQueue();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Position File</span>
      </div>

      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#1b3a4b' }} />
          <div>
            <div className="page-title">Position file load</div>
            <div className="page-meta">{queue ? `${queue.name} · source ${queue.sourceCode}` : 'Import source'}</div>
          </div>
        </div>
        <label className="btn btn-primary">
          {busy === 'upload' ? 'Storing file…' : 'Upload file'}
          <input
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            style={{ display: 'none' }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setBusy('upload');
              setError(null);
              const form = new FormData();
              form.set('file', file);
              try {
                const response = await fetch('/api/feeds/position-file', { method: 'POST', body: form });
                const body = await response.json();
                if (!response.ok) throw new Error(body.error || 'The file could not be stored');
                openDetail(body);
                await refreshQueue();
              } catch (err: any) {
                setError(err.message);
              } finally {
                setBusy(null);
              }
            }}
          />
        </label>
      </div>

      <p className="hero-sub" style={{ maxWidth: 820, marginTop: 0 }}>
        Each upload is an instance on the {queue?.sourceCode || 'POSITION_FILE'} source. The original file is kept, so you can change the column mapping and reprocess without losing the source values.
        {' '}For any other file, use the <Link href="/load">data specialist</Link>.
      </p>
      {error && <div className="filter-bar" style={{ color: '#b42318' }}>{error}</div>}

      <div className="section-title">
        <h2>Instance queue</h2>
        <span className="hint">Load time, result, and reprocess</span>
      </div>
      <div className="data-table" style={{ marginBottom: 22 }}>
        <div className="tbl-head" style={{ gridTemplateColumns: '190px 1.3fr 70px 110px 1.2fr 120px' }}>
          <div>Received</div>
          <div>File</div>
          <div>Rows</div>
          <div>Status</div>
          <div>Result</div>
          <div></div>
        </div>
        {(queue?.instances || []).length === 0 ? (
          <div className="tbl-row" style={{ gridTemplateColumns: '1fr' }}><div>No files stored yet. Upload a CSV or Excel file to add an instance.</div></div>
        ) : (
          queue?.instances.map((instance) => (
            <div key={instance.id} className="tbl-row" style={{ gridTemplateColumns: '190px 1.3fr 70px 110px 1.2fr 120px' }}>
              <div>{formatWhen(instance.receivedAt)}</div>
              <button onClick={() => selectInstance(instance.id)} style={{ textAlign: 'left', background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }}>{instance.fileName}</button>
              <div>{instance.rowCount}</div>
              <div>{instance.status}</div>
              <div>{resultText(instance)}</div>
              <button
                className="btn"
                disabled={busy !== null || instance.status === 'PROCESSING'}
                onClick={() => processInstance(instance.id, detail?.id === instance.id ? detail.columnMappings : undefined)}
              >
                {busy === instance.id ? 'Working…' : 'Reprocess'}
              </button>
            </div>
          ))
        )}
      </div>

      {detail && (
        <>
          <div className="section-title">
            <h2>{detail.fileName}</h2>
            <span className="hint">{detail.rowCount} stored rows · {detail.columnMappings.length} source columns</span>
          </div>
          <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 12 }}>
            <label className="filter-pill">
              <input type="radio" name="asof" checked={asOfMode === 'today'} onChange={() => setAsOfMode('today')} /> Today ({todayIso()})
            </label>
            <label className="filter-pill">
              <input type="radio" name="asof" checked={asOfMode === 'specific'} onChange={() => setAsOfMode('specific')} /> Specific date
            </label>
            {asOfMode === 'specific' && (
              <input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} style={{ border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', padding: '6px 8px' }} />
            )}
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => processInstance(detail.id, detail.columnMappings)}>
              {busy === detail.id ? 'Processing…' : `Process as of ${chosenDate()}`}
            </button>
            {loadWaves.length > 0 && (
              <span className="nav-desc">Load order {loadWaves.map((wave) => wave.join(' + ')).join(' → ')}</span>
            )}
          </div>
          {detail.resultSummary && (
            <div className="page-meta" style={{ margin: '8px 0 14px' }}>
              Last result {formatWhen(detail.completedAt)}: {resultText(detail)}.
              {detail.runs.length > 1 && ` ${detail.runs.length} attempts stored.`}
              {detail.errorMessage ? ` ${detail.errorMessage}` : ''}
            </div>
          )}

          <div className="data-table" style={{ overflowX: 'auto' }}>
            <div className="tbl-head" style={{ gridTemplateColumns: GRID, position: 'sticky', top: 0, zIndex: 1, minWidth: 980 }}>
              <div>Source column</div>
              <div>Source values</div>
              <div>Entity attribute</div>
              <div>Transform</div>
              <div>Suggestion</div>
            </div>
            {detail.columnMappings.map((assignment, index) => {
              const sample = assignment.samples[0] || '';
              const transformed = sample ? previewTransform(sample, assignment.transform) : '';
              const selectedKey = targetKey(assignment);
              const selectedKnown = (queue?.targets || []).some((target) => target.key === selectedKey);
              return (
                <div key={assignment.sourceColumn} className="tbl-row" style={{ gridTemplateColumns: GRID, alignItems: 'start', cursor: 'default', minWidth: 980 }}>
                  <div className="row-id">{assignment.sourceColumn}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                    {assignment.samples.join(' · ') || '—'}
                    {sample && transformed !== sample && <div>→ {transformed}</div>}
                  </div>
                  <div>
                    <select
                      value={selectedKey}
                      onChange={(event) => {
                        const target = queue?.targets.find((item) => item.key === event.target.value);
                        if (target) updateAssignment(index, applyTarget(assignment, target));
                      }}
                      style={{ width: '100%', border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', padding: '6px 8px' }}
                    >
                      {!selectedKnown && <option value={selectedKey}>{assignment.domainCode || 'File'} · {assignment.attributeCode || assignment.role}</option>}
                      {targetsByGroup.map(([group, targets]) => (
                        <optgroup key={group} label={group}>
                          {targets.map((target) => (
                            <option key={target.key} value={target.key}>{target.label}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    {assignment.role === 'filter' && (
                      <input
                        value={assignment.filterEquals || ''}
                        placeholder="Keep rows equal to"
                        onChange={(event) => updateAssignment(index, { ...assignment, filterEquals: event.target.value })}
                        style={{ width: '100%', marginTop: 4, border: '1px solid var(--line)', padding: '4px 6px' }}
                      />
                    )}
                  </div>
                  <div>
                    <select
                      value={assignment.transform.kind}
                      onChange={(event) => updateAssignment(index, {
                        ...assignment,
                        transform: { ...assignment.transform, kind: event.target.value as ColumnAssignment['transform']['kind'] },
                      })}
                      style={{ width: '100%', border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', padding: '6px 8px' }}
                    >
                      {TRANSFORM_OPTIONS.map((option) => (
                        <option key={option.kind} value={option.kind}>{option.label}</option>
                      ))}
                    </select>
                    {assignment.transform.kind === 'replace' && (
                      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                        <input
                          value={assignment.transform.find || ''}
                          placeholder="Find"
                          onChange={(event) => updateAssignment(index, { ...assignment, transform: { ...assignment.transform, find: event.target.value } })}
                          style={{ width: '50%', border: '1px solid var(--line)', padding: '4px 6px' }}
                        />
                        <input
                          value={assignment.transform.replaceWith || ''}
                          placeholder="Replace"
                          onChange={(event) => updateAssignment(index, { ...assignment, transform: { ...assignment.transform, replaceWith: event.target.value } })}
                          style={{ width: '50%', border: '1px solid var(--line)', padding: '4px 6px' }}
                        />
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                    {assignment.suggestion.method === 'manual' ? 'Manual' : assignment.suggestion.method === 'ai' ? 'AI review' : assignment.suggestion.method === 'source_map' ? 'Source map' : 'Determined'}
                    {' · '}
                    {assignment.suggestion.reason}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
