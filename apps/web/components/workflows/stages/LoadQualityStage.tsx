'use client';

import { useCallback, useEffect, useState } from 'react';
import { BatchChecks, countOf } from '@/components/feeds/BatchChecks';
import { ConfirmButton } from '@/components/feeds/ConfirmButton';
import { SourcePane, type SourceTarget } from '@/components/feeds/SourcePane';
import type { BatchDetail } from '@tapestrai/mcp-server/src/feeds/load-batches';
import type { StageScreenProps } from './index';
import { useReportProgress } from './useProgress';

async function json<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'That could not be done');
  return data as T;
}

/**
 * The quality stage of a guided run: the staged batch with its checks. The
 * person corrects what is wrong, then approves the batch, which the run goes on
 * to promote, or discards it. Nothing is promoted from this screen itself.
 */
export function LoadQualityStage({ stage, busy, onComplete, onProgress }: StageScreenProps) {
  const batchId = String(stage.args.batchId || '');
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState('');
  const [pointing, setPointing] = useState<SourceTarget | null>(null);
  const mayApprove = stage.allowedOutcomes.includes('approved');

  const load = useCallback(async () => {
    if (!batchId) {
      setError('This stage was not given a batch.');
      return;
    }
    try {
      setBatch((await json<{ batch: BatchDetail }>(`/api/feeds/batches/${batchId}`)).batch);
    } catch (err: any) {
      setError(err.message);
    }
  }, [batchId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function correct(valueId: string, value: string, reason: string) {
    setError(null);
    try {
      setBatch((await json<{ batch: BatchDetail }>(`/api/feeds/batches/${batchId}`, { action: 'edit', valueId, value, reason })).batch);
    } catch (err: any) {
      setError(err?.message || 'The correction could not be saved');
      throw err;
    }
  }

  const critical = batch?.quality?.summary.blocking || 0;
  useReportProgress(onProgress, batch ? {
    parts: [
      {
        label: 'Correct the values that fail a critical check',
        done: critical === 0 || Boolean(override.trim()),
        note: critical === 0 ? 'None fail' : override.trim() ? 'Approving anyway, with a reason' : `${countOf(critical, 'critical check')} fail`,
      },
      { label: 'Approve the batch to make it live, or discard it', done: false },
    ],
  } : null);

  if (error && !batch) return <div role="alert" style={{ color: 'var(--red)' }}>{error}</div>;
  if (!batch) return <div style={{ color: 'var(--ink-3)' }}>Reading the staged values…</div>;

  const blocking = batch.quality?.summary.blocking || 0;
  const gone = batch.status !== 'STAGED';

  return (
    <div className={batch.importInstanceId ? 'stage-split' : undefined}>
    <section className="load-section" aria-live="polite" style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <p className="load-sub" style={{ margin: 0 }}>
        <b>{batch.fileName}</b> is staged. Each record was checked as it would stand once these values are live. Nothing is live yet.
      </p>
      {error && <p className="load-sub" role="alert" style={{ color: '#b42318', margin: 0 }}>{error}</p>}
      {gone && <p className="load-sub" role="alert" style={{ color: '#b42318', margin: 0 }}>This batch is {batch.status.toLowerCase()}, so it can no longer be approved here.</p>}

      <div className="load-card" style={{ display: 'grid', gap: 8 }}>
        <BatchChecks
          batch={batch}
          busy={busy}
          onCorrect={correct}
          onShowSource={batch.importInstanceId ? (failure) => setPointing({
            row: failure.originRow ?? undefined,
            column: failure.originColumn ?? undefined,
            label: [failure.entityName, failure.attributeName || failure.attributeCode].filter(Boolean).join(' · '),
          }) : undefined}
        />
      </div>

      {blocking > 0 && mayApprove && (
        <label className="load-sub" style={{ display: 'grid', gap: 4, margin: 0 }}>
          <span>{countOf(blocking, 'critical check')} would fail. Correct the values above, or say why this should be made live anyway.</span>
          <input aria-label="Reason to approve anyway" value={override} onChange={(event) => setOverride(event.target.value)} placeholder="Reason to approve anyway" />
        </label>
      )}

      <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          className="load-btn"
          disabled={busy || gone || !mayApprove || (blocking > 0 && !override.trim())}
          onClick={() => onComplete('approved', override.trim() ? { overrideReason: override.trim() } : {})}
        >
          {busy ? 'Working…' : 'Approve and make live'}
        </button>
        <ConfirmButton className="load-btn sec" disabled={busy} confirmLabel="Yes, discard it" title="Nothing has been made live, so there is nothing to undo." onConfirm={() => void onComplete('discarded', {})}>
          Discard
        </ConfirmButton>
        {!mayApprove && <span className="load-sub">Approving needs the load.promote permission. Ask a client admin.</span>}
      </span>
    </section>
    {batch.importInstanceId && (
      <div className="stage-source">
        <SourcePane instanceId={batch.importInstanceId} fileName={batch.fileName} target={pointing} height="min(64vh, 560px)" />
        <p className="load-sub" style={{ margin: '6px 2px 0' }}>Show in file on a failing check marks the value where it was read.</p>
      </div>
    )}
    </div>
  );
}
