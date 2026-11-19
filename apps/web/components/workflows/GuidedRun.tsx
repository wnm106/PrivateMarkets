'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoadStepper } from '@/components/feeds/LoadPreview';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { COMPLETE_STAGE, RUN_STAGES_QUERY, guidedSteps, type StageView } from '@/lib/workflow-stages';
import { assigneeText, dueText, type RunDetail } from '@/lib/workflows';
import { STAGE_COMPONENTS } from './stages';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A sentence for what a finished run did, read from its last steps. */
function outcomeLine(run: RunDetail): string {
  const output = (nodeId: string) => record(run.steps.find((step) => step.nodeId === nodeId && step.status === 'SUCCEEDED')?.output);
  for (const step of [...run.steps].reverse()) {
    const result = record(step.output);
    // A promoted batch says what was written.
    const written = record(result.result);
    if (result.status === 'PROMOTED' && Array.isArray(written.domains)) {
      const domains = written.domains as Array<Record<string, unknown>>;
      const created = domains.reduce((sum, domain) => sum + (Number(domain.created) || 0), 0);
      const matched = domains.reduce((sum, domain) => sum + (Number(domain.matched) || 0), 0);
      const attributes = record(written.attributes);
      const drift = Array.isArray(result.drift) && result.drift.length > 0 ? ` What was written differs from what was staged: ${(result.drift as string[]).join('; ')}.` : '';
      return `The values are live: ${created.toLocaleString()} new and ${matched.toLocaleString()} matched records, ${(Number(attributes.created) || 0).toLocaleString()} values added and ${(Number(attributes.updated) || 0).toLocaleString()} changed.${drift}`;
    }
    if (result.status === 'DISCARDED') return 'The batch was discarded. Nothing was made live.';
    if (result.status === 'FAILED' && typeof result.errorMessage === 'string') return `The batch stopped part way: ${result.errorMessage}`;
  }
  if (output('map').outcome === 'abandoned') return 'The run was stopped at the mapping. Nothing was staged or loaded.';
  return 'The run finished.';
}

/**
 * A run worked through as guided stages: a ribbon of its steps, and the one
 * screen that is waiting on a person. The system's own steps run between the
 * screens, and the page follows them.
 */
export function GuidedRun({ run, onChanged }: { run: RunDetail; onChanged: () => void }) {
  const [stages, setStages] = useState<StageView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ workflowStages: StageView[] }>(RUN_STAGES_QUERY, { runId: run.id }, 'network-only');
    if (result.aborted) return;
    if (result.error) setError(result.error.message);
    else setStages(result.data?.workflowStages || []);
  }, [run.id]);

  // The stages change whenever the run does: one opens, or is handed back.
  const stepKey = run.steps.map((step) => `${step.nodeId}:${step.status}`).join('|');
  useEffect(() => {
    void load();
  }, [load, run.status, run.currentNode, stepKey]);

  const ribbon = useMemo(
    () => (run.graph ? guidedSteps(run.graph, run.steps, run.status, run.currentNode) : []),
    [run.graph, run.steps, run.status, run.currentNode],
  );
  const open = (stages || []).filter((stage) => stage.status === 'OPEN');
  const mine = open.find((stage) => stage.canAct) || null;
  // Between a person leaving a stage and the worker taking the run up, the run still says it is waiting
  // but nothing is waiting on anyone. The page follows it until the next step shows.
  const handingOn = run.status === 'WAITING' && stages !== null && open.length === 0 && run.openReviews === 0;
  const moving = run.status === 'QUEUED' || run.status === 'RUNNING' || handingOn;
  useEffect(() => {
    if (!handingOn) return;
    const timer = setInterval(() => {
      onChanged();
      void load();
    }, 2000);
    return () => clearInterval(timer);
  }, [handingOn, onChanged, load]);
  const working = ribbon.find((step) => step.state === 'current' && !step.human);

  async function complete(stage: StageView, outcome: string, result: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const { data, error: failed } = await graphqlMutation<{ completeWorkflowStage: { stage: StageView | null; errors: Array<{ message: string }> } }>(COMPLETE_STAGE, { id: stage.id, outcome, result });
      const problem = failed?.message || data?.completeWorkflowStage.errors[0]?.message;
      if (problem) throw new Error(problem);
      await load();
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'The stage could not be finished');
      throw err;
    } finally {
      setBusy(false);
    }
  }

  const Screen = mine ? STAGE_COMPONENTS[mine.screen] : null;

  return (
    <section style={{ margin: '4px 0 20px' }}>
      <LoadStepper steps={ribbon.map((step) => ({ label: step.label, state: step.state, note: step.note }))} />
      {error && <div role="alert" style={{ color: 'var(--red)', margin: '8px 0' }}>{error}</div>}

      {mine && !moving && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 16, background: 'var(--surface)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>{mine.title}</h2>
            {dueText(mine.dueAt) && <span style={{ fontSize: 12, fontWeight: 600 }}>{dueText(mine.dueAt)}</span>}
          </div>
          {mine.instructions && <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '4px 0 12px' }}>{mine.instructions}</p>}
          {mine.returnedReason && (
            <div role="alert" style={{ border: '1px solid #fedf89', background: '#fffaeb', color: '#93370d', borderRadius: 8, padding: '8px 12px', fontSize: 13, margin: '8px 0 12px' }}>
              This came back to you. {mine.returnedReason}
            </div>
          )}
          {Screen ? (
            <Screen key={mine.id} stage={mine} busy={busy} onComplete={(outcome, result) => complete(mine, outcome, result)} />
          ) : (
            <div role="alert" style={{ color: 'var(--red)' }}>This app has no screen called “{mine.screen}”.</div>
          )}
        </div>
      )}

      {!mine && open.length > 0 && !moving && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 16, fontSize: 13 }}>
          {open.map((stage) => (
            <div key={stage.id}>
              <b>{stage.title}</b> is waiting on {assigneeText(stage.assignees as never)}. {stage.blocker}
            </div>
          ))}
        </div>
      )}

      {moving && (
        <div aria-live="polite" style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 16, fontSize: 13, color: 'var(--ink-3)' }}>
          {run.status === 'QUEUED' ? 'Waiting for a worker to pick this up…' : working ? `${working.label}…` : handingOn ? 'Going on to the next step…' : 'Working…'}
        </div>
      )}

      {run.status === 'SUCCEEDED' && (
        <div aria-live="polite" style={{ border: '1px solid #abefc6', background: '#ecfdf3', color: '#05603a', borderRadius: 10, padding: 16, fontSize: 14 }}>
          {outcomeLine(run)}
        </div>
      )}
    </section>
  );
}
