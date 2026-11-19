'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EntityResolutionStep } from '@/components/feeds/EntityResolutionStep';
import type { ColumnAssignment } from '@/lib/feeds/suggest';
import type { BatchDetail, BatchSummary, QualityFailure } from '@tapestrai/mcp-server/src/feeds/load-batches';
import type { EntityResolution, EntityResolutionDecision } from '@tapestrai/mcp-server/src/feeds/types';

export type StageState = 'none' | 'staged' | 'blocked' | 'promoted';

const SEVERITY_COLOR: Record<string, string> = { CRITICAL: '#b42318', HIGH: '#b54708', MEDIUM: '#475467', LOW: '#667085' };

function count(value: number, one: string, many = `${one}s`) {
  return `${value.toLocaleString()} ${value === 1 ? one : many}`;
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'That could not be done');
  return data as T;
}

/**
 * Stage, check, promote. Staging keeps what the load would do and runs the data
 * quality rules on each record as it would stand. A failing value can be
 * corrected here. Nothing is live until Promote, and a promoted batch can be
 * reverted.
 */
export function StagedBatch({
  fileId,
  assignments,
  asOfDate,
  ready,
  mappingKey,
  stageSignal,
  onState,
  onPromoted,
}: {
  fileId: string;
  assignments: ColumnAssignment[];
  asOfDate: string;
  /** The mapping is confirmed and reviewed, so the file can be staged. */
  ready: boolean;
  /** Changes whenever the mapping or date does. A batch staged under another key is out of date. */
  mappingKey: string;
  /** Raised by the bar at the foot of the page to start staging. */
  stageSignal: number;
  onState: (state: StageState) => void;
  onPromoted: () => void;
}) {
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [last, setLast] = useState<BatchSummary | null>(null);
  const [canPromote, setCanPromote] = useState(false);
  const [stagedKey, setStagedKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<EntityResolution[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState('');
  const seenSignal = useRef(stageSignal);

  const load = useCallback(async () => {
    try {
      const data = await call<{ batches: BatchSummary[]; canPromote: boolean }>(`/api/feeds/position-file/${fileId}/stage`);
      setCanPromote(data.canPromote);
      const staged = data.batches.find((item) => item.status === 'STAGED');
      setLast(data.batches.find((item) => item.status === 'PROMOTED' || item.status === 'FAILED' || item.status === 'REVERTED') || null);
      if (staged) {
        const detail = await call<{ batch: BatchDetail }>(`/api/feeds/batches/${staged.id}`);
        setBatch(detail.batch);
      } else {
        setBatch(null);
      }
    } catch (err: any) {
      setError(err?.message || 'The batches could not be read');
    }
  }, [fileId]);

  useEffect(() => {
    setBatch(null);
    setLast(null);
    setResolutions([]);
    setError(null);
    setStagedKey('');
    void load();
  }, [load]);

  const stale = Boolean(batch) && stagedKey !== '' && stagedKey !== mappingKey;
  const blocking = batch?.quality?.summary.blocking || 0;

  useEffect(() => {
    if (batch && !stale) onState(blocking > 0 ? 'blocked' : 'staged');
    else if (!batch && last?.status === 'PROMOTED') onState('promoted');
    else onState('none');
  }, [batch, last, stale, blocking, onState]);

  const stage = useCallback(async (decisions?: EntityResolutionDecision[]) => {
    setBusy('stage');
    setError(null);
    try {
      const outcome = await call<{ kind: 'staged' | 'needs_resolution'; batch?: BatchDetail; resolutions?: EntityResolution[]; canPromote: boolean }>(
        `/api/feeds/position-file/${fileId}/stage`,
        { columnMappings: assignments, asOfDate, resolutions: decisions },
      );
      setCanPromote(outcome.canPromote);
      if (outcome.kind === 'needs_resolution') {
        setResolutions(outcome.resolutions || []);
      } else {
        setResolutions([]);
        setBatch(outcome.batch || null);
        setStagedKey(mappingKey);
      }
    } catch (err: any) {
      setError(err?.message || 'The file could not be staged');
    } finally {
      setBusy(null);
    }
  }, [fileId, assignments, asOfDate, mappingKey]);

  useEffect(() => {
    if (stageSignal === seenSignal.current) return;
    seenSignal.current = stageSignal;
    if (ready) void stage();
  }, [stageSignal, ready, stage]);

  async function act(action: string, body: Record<string, unknown> = {}, target = batch?.id) {
    if (!target) return;
    setBusy(action);
    setError(null);
    try {
      const data = await call<{ batch: BatchDetail }>(`/api/feeds/batches/${target}`, { action, ...body });
      if (action === 'edit') {
        setBatch(data.batch);
        setEditing(null);
        setDraft('');
        setReason('');
      } else {
        setBatch(data.batch.status === 'STAGED' ? data.batch : null);
        setLast(data.batch.status === 'DISCARDED' ? last : data.batch);
        setOverride('');
        if (action === 'promote' || action === 'revert') onPromoted();
      }
    } catch (err: any) {
      setError(err?.message || 'That could not be done');
    } finally {
      setBusy(null);
    }
  }

  const quality = batch?.quality || null;
  const newFailures = quality?.failures.filter((item) => item.state === 'NEW') || [];
  const oldFailures = quality?.failures.filter((item) => item.state === 'EXISTING') || [];

  function failureRow(item: QualityFailure, index: number) {
    const key = `${item.recordId}-${item.ruleCode}-${index}`;
    const open = editing === key;
    return (
      <li key={key} style={{ marginBottom: 6 }}>
        <b style={{ color: SEVERITY_COLOR[item.severity] || undefined }}>{item.severity.toLowerCase()}</b>{' · '}
        <b>{item.entityName}</b>{item.recordAction === 'CREATE' ? ' (new)' : ''}{' · '}{item.ruleName}
        {item.attributeName ? ` · ${item.attributeName}` : ''}
        {item.actualValue ? `: ${item.actualValue}` : ''}
        {item.message ? ` · ${item.message}` : ''}
        {item.editable && item.valueId && !open && (
          <>{' '}<button type="button" className="btn" disabled={busy !== null} onClick={() => { setEditing(key); setDraft(item.stagedValue || ''); setReason(''); }}>Correct</button></>
        )}
        {open && item.valueId && (
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            <input aria-label={`Corrected value for ${item.attributeName || item.attributeCode}`} value={draft} onChange={(event) => setDraft(event.target.value)} />
            <input aria-label="Why the file is wrong" placeholder="Why the file is wrong" value={reason} onChange={(event) => setReason(event.target.value)} style={{ minWidth: 220 }} />
            <button type="button" className="btn" disabled={busy !== null || !draft.trim()} onClick={() => act('edit', { valueId: item.valueId, value: draft, reason })}>
              {busy === 'edit' ? 'Checking...' : 'Save and check again'}
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => setEditing(null)}>Cancel</button>
          </span>
        )}
      </li>
    );
  }

  return (
    <section className="load-section" aria-live="polite">
      <div className="load-sh">
        <span className="load-step-n">5</span>
        <div>
          <h2>Stage, check, promote</h2>
          <p className="load-sub">
            Staging keeps what the load would do and runs the data quality rules on each record as it would stand. Nothing is live until you promote.
          </p>
        </div>
      </div>

      {error && <p className="load-sub" style={{ color: '#b42318' }}>{error}</p>}

      {resolutions.length > 0 && (
        <EntityResolutionStep resolutions={resolutions} applying={busy === 'stage'} onApply={(decisions) => stage(decisions)} />
      )}

      {!batch && resolutions.length === 0 && (
        <p className="load-sub">
          <button type="button" className="btn" disabled={!ready || busy !== null} onClick={() => stage()}>
            {busy === 'stage' ? 'Staging...' : 'Stage and check'}
          </button>
          {!ready && ' Confirm the mapping and run the review first.'}
        </p>
      )}

      {batch && (
        <div className="load-card" style={{ display: 'grid', gap: 8 }}>
          {stale && (
            <p className="load-sub" style={{ color: '#b54708', margin: 0 }}>
              The mapping or date changed after this was staged.{' '}
              <button type="button" className="btn" disabled={!ready || busy !== null} onClick={() => stage()}>Stage again</button>
            </p>
          )}
          <p className="load-sub" style={{ margin: 0 }}>
            Staged as of {batch.asOfDate}: <b>{count(batch.records.created, 'new record')}</b>, {count(batch.records.matched, 'matched record')}.
            Values: <b>{batch.values.added.toLocaleString()}</b> to add, <b>{batch.values.changed.toLocaleString()}</b> to change, {batch.values.unchanged.toLocaleString()} already stored
            {batch.values.edited > 0 && <>, <b>{batch.values.edited.toLocaleString()}</b> corrected here</>}.
          </p>

          {quality && (
            <>
              <p className="load-sub" style={{ margin: 0 }}>
                {count(quality.ruleCount, 'rule')} run on {count(quality.recordCount, 'record')}:{' '}
                <b style={quality.summary.newFailures ? { color: '#b42318' } : undefined}>{count(quality.summary.newFailures, 'new failure')}</b>
                {blocking > 0 && <> ({blocking.toLocaleString()} critical)</>}, {quality.summary.existingFailures.toLocaleString()} already failing today,{' '}
                {quality.summary.cleared.toLocaleString()} cleared by this batch, {count(quality.summary.missingRequired, 'required value')} missing.
              </p>
              {newFailures.length > 0 && (
                <details open>
                  <summary>Failures this batch brings ({newFailures.length})</summary>
                  <ul style={{ margin: '4px 0 8px 18px' }}>{newFailures.slice(0, 50).map(failureRow)}</ul>
                  {newFailures.length > 50 && <p className="load-sub">and {newFailures.length - 50} more</p>}
                </details>
              )}
              {quality.missing.length > 0 && (
                <details>
                  <summary>Required values still missing ({quality.missing.length})</summary>
                  <ul style={{ margin: '4px 0 8px 18px' }}>
                    {quality.missing.slice(0, 50).map((item, index) => (
                      <li key={`${item.recordId}-${item.attributeCode}-${index}`}><b>{item.entityName}</b>{item.state === 'NEW' ? ' (new)' : ''} · {item.attributeName}</li>
                    ))}
                  </ul>
                </details>
              )}
              {oldFailures.length > 0 && (
                <details>
                  <summary>Already failing before this batch ({oldFailures.length})</summary>
                  <ul style={{ margin: '4px 0 8px 18px' }}>{oldFailures.slice(0, 50).map(failureRow)}</ul>
                </details>
              )}
              {quality.outranked.length > 0 && (
                <details>
                  <summary>Values a higher-ranked source will keep overriding ({quality.outranked.length})</summary>
                  <ul style={{ margin: '4px 0 8px 18px' }}>
                    {quality.outranked.slice(0, 50).map((item) => (
                      <li key={item.valueId}><b>{item.entityName}</b> · {item.attributeName}: file says {item.proposed ?? 'nothing'}, the record keeps {item.winning ?? 'nothing'}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}

          {blocking > 0 && canPromote && (
            <label className="load-sub" style={{ display: 'grid', gap: 4, margin: 0 }}>
              <span>{count(blocking, 'critical check')} would fail. Correct the values above, or say why this should be promoted anyway.</span>
              <input aria-label="Reason to promote anyway" value={override} onChange={(event) => setOverride(event.target.value)} placeholder="Reason to promote anyway" />
            </label>
          )}

          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              className="load-btn"
              disabled={!canPromote || stale || busy !== null || (blocking > 0 && !override.trim())}
              onClick={() => act('promote', { overrideReason: override })}
            >
              {busy === 'promote' ? 'Promoting...' : 'Promote to live records'}
            </button>
            <button type="button" className="load-btn sec" disabled={busy !== null} onClick={() => act('discard')}>Discard</button>
            {!canPromote && <span className="load-sub">Promoting needs the load.promote permission. Ask a client admin.</span>}
          </span>
        </div>
      )}

      {last && (
        <p className="load-sub" style={{ marginTop: 8 }}>
          {last.status === 'PROMOTED' && <>Last batch promoted {last.promotedAt ? new Date(last.promotedAt).toLocaleString() : ''}{last.origin === 'DIRECT' ? ' (loaded without staging)' : ''}.</>}
          {last.status === 'FAILED' && <span style={{ color: '#b42318' }}>The last batch stopped part way: {last.errorMessage}</span>}
          {last.status === 'REVERTED' && last.revertResult && (
            <>Last batch reverted: {count(last.revertResult.valuesRetired, 'value')} retired, {count(last.revertResult.changesRestored, 'change')} put back, {count(last.revertResult.recordsDeactivated, 'record')} made inactive
              {last.revertResult.valuesLeft + last.revertResult.changesLeft + last.revertResult.recordsLeft > 0 && (
                <>. Left alone because they changed since: {count(last.revertResult.valuesLeft, 'value')}, {count(last.revertResult.changesLeft, 'change')}, {count(last.revertResult.recordsLeft, 'record')}</>
              )}.
            </>
          )}
          {last.drift.length > 0 && <> What was written differs from what was staged: {last.drift.join('; ')}.</>}
          {(last.status === 'PROMOTED' || last.status === 'FAILED') && canPromote && (
            <>{' '}<button type="button" className="btn" disabled={busy !== null} onClick={() => { if (window.confirm('Take back what this batch wrote? Anything changed since is left alone.')) void act('revert', {}, last.id); }}>{busy === 'revert' ? 'Reverting...' : 'Revert this batch'}</button></>
          )}
        </p>
      )}
    </section>
  );
}
