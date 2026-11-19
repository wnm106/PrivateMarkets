'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BatchChecks, countOf as count } from '@/components/feeds/BatchChecks';
import { EntityResolutionStep } from '@/components/feeds/EntityResolutionStep';
import type { ColumnAssignment } from '@/lib/feeds/suggest';
import type { BatchDetail, BatchSummary } from '@tapestrai/mcp-server/src/feeds/load-batches';
import type { EntityResolution, EntityResolutionDecision } from '@tapestrai/mcp-server/src/feeds/types';

export type StageState = 'none' | 'staged' | 'blocked' | 'promoted';

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
      setBatch(data.batch.status === 'STAGED' ? data.batch : null);
      setLast(data.batch.status === 'DISCARDED' ? last : data.batch);
      setOverride('');
      if (action === 'promote' || action === 'revert') onPromoted();
    } catch (err: any) {
      setError(err?.message || 'That could not be done');
    } finally {
      setBusy(null);
    }
  }

  async function correct(valueId: string, value: string, reason: string) {
    if (!batch) return;
    setError(null);
    try {
      const data = await call<{ batch: BatchDetail }>(`/api/feeds/batches/${batch.id}`, { action: 'edit', valueId, value, reason });
      setBatch(data.batch);
    } catch (err: any) {
      setError(err?.message || 'The correction could not be saved');
      throw err;
    }
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
          <BatchChecks batch={batch} busy={busy !== null} onCorrect={correct} />

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
