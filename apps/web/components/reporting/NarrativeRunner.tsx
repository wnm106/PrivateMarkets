'use client';

import { useCallback, useEffect, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import {
  NARRATIVE_RUNS_QUERY,
  defaultParams,
  runNarrative,
  type NarrativeRunRecord,
  type NarrativeTemplate,
  type ReportParameter,
} from '@/lib/reporting';
import { NarrativeBlocks } from './NarrativeBlocks';
import { ParameterBar } from './ParameterBar';

interface NarrativeRunnerProps {
  /** Saved narrative id (enables stored-run history). Omit when previewing an unsaved draft. */
  narrativeId?: string;
  /** Unsaved designer draft to run instead of the stored template. */
  draft?: Partial<NarrativeTemplate>;
  parameters: ReportParameter[];
  entityId?: string | null;
  asOfDate?: string;
  /** Run automatically when there is no stored run yet. */
  autoRunIfEmpty?: boolean;
}

export function NarrativeRunner({ narrativeId, draft, parameters, entityId, asOfDate, autoRunIfEmpty }: NarrativeRunnerProps) {
  const [values, setValues] = useState<Record<string, any>>(() => defaultParams(parameters));
  const [run, setRun] = useState<NarrativeRunRecord | null>(null);
  const [running, setRunning] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await runNarrative({
        narrativeId: draft ? undefined : narrativeId,
        entityId: entityId || undefined,
        params: { ...values, ...(asOfDate ? { asOfDate } : {}) },
        draft,
      });
      setRun(result);
    } catch (e: any) {
      setError(e.message || 'Run failed');
    } finally {
      setRunning(false);
    }
  }, [narrativeId, draft, entityId, values, asOfDate]);

  // Load the most recent stored run for this narrative + entity.
  useEffect(() => {
    if (!narrativeId || draft) return;
    let cancelled = false;
    (async () => {
      setLoadingLatest(true);
      setRun(null);
      try {
        const { data } = await graphqlQuery<{ narrativeRuns: NarrativeRunRecord[] }, any>(
          NARRATIVE_RUNS_QUERY,
          { narrativeId, entityId: entityId || null, first: 1 },
          'network-only'
        );
        if (cancelled) return;
        const latest = data?.narrativeRuns?.[0] || null;
        setRun(latest);
        if (!latest && autoRunIfEmpty) execute();
      } finally {
        if (!cancelled) setLoadingLatest(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrativeId, entityId]);

  return (
    <div>
      <ParameterBar parameters={parameters} values={values} onChange={(n, v) => setValues((p) => ({ ...p, [n]: v }))} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '10px 0 16px' }}>
        <button className="btn btn-primary btn-sm" onClick={execute} disabled={running}>
          {running ? 'Generating…' : run ? 'Re-run' : 'Generate'}
        </button>
        {run && (
          <span style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
            {run.id ? 'Last run' : 'Preview'} {new Date(run.createdAt).toLocaleString()}
            {run.model ? ` · ${run.model}` : ''}
          </span>
        )}
      </div>

      {error && <div style={{ padding: '10px 14px', background: '#fdecec', color: '#b91c1c', fontSize: '12px', marginBottom: '8px' }}>{error}</div>}
      {loadingLatest && !run && <div style={{ color: 'var(--ink-3)', fontSize: '12px' }}>Loading latest run…</div>}
      {run?.status === 'FAILED' && (
        <div style={{ padding: '10px 14px', background: '#fdecec', color: '#b91c1c', fontSize: '12px' }}>
          The last run failed: {run.errorMessage || 'unknown error'}
        </div>
      )}
      {run && run.status === 'COMPLETED' && <NarrativeBlocks blocks={run.blocks} />}
      {!run && !loadingLatest && !running && !error && (
        <div style={{ color: 'var(--ink-3)', fontSize: '13px' }}>No run yet. Click Generate to produce this narrative for the current entity.</div>
      )}
    </div>
  );
}
