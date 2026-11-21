'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ReviewPanel } from '@/components/workflows/ReviewPanel';
import { FORMS_QUERY, FormCard, type FormView } from '@/components/workflows/RunForms';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { checkRecords, checklistSummary, progressText, runChecklist, type CheckProgress, type CheckState, type Checklist, type ChecklistItem } from '@/lib/workflow-checklist';
import type { RunDecisionsView } from '@/lib/workflow-run-view';
import { refreshTasks } from '@/lib/tasks';
import { COMPLETE_STAGE, RUN_STAGES_QUERY, type StageView } from '@/lib/workflow-stages';
import { assigneeText, dueText, when, type RunDetail } from '@/lib/workflows';
import { STAGE_COMPONENTS } from './stages';

/**
 * A run worked through as a checklist: every decision it needs from a person,
 * numbered in the order the run reaches it and ticked off as it is done, with
 * the screen for the open one beneath. A review, a form and a stage are all
 * decisions on the same list; the system's own steps run between them.
 */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export interface RunDecisions extends RunDecisionsView {
  stages: StageView[];
  forms: FormView[];
  /** The forms and stages have loaded, so the checklist is whole. */
  loaded: boolean;
  /** Records what an open screen says is left to do on it. */
  report(recordId: string, progress: CheckProgress): void;
  reload(): Promise<void>;
}

/** The run's forms and stages, read beside the run, and the checklist they make. */
export function useRunDecisions(run: RunDetail | null, onChanged: () => void): RunDecisions {
  const runId = run?.id || null;
  const [stages, setStages] = useState<StageView[] | null>(null);
  const [forms, setForms] = useState<FormView[] | null>(null);
  const [progress, setProgress] = useState<Record<string, CheckProgress>>({});

  const reload = useCallback(async () => {
    if (!runId) return;
    const [stageResult, formResult] = await Promise.all([
      graphqlQuery<{ workflowStages: StageView[] }>(RUN_STAGES_QUERY, { runId }, 'network-only'),
      graphqlQuery<{ workflowForms: FormView[] }>(FORMS_QUERY, { status: null, runId }, 'network-only'),
    ]);
    if (!stageResult.aborted) setStages(stageResult.data?.workflowStages || []);
    if (!formResult.aborted) setForms(formResult.data?.workflowForms || []);
  }, [runId]);

  // Forms and stages open and close as the run moves.
  const stepKey = (run?.steps || []).map((step) => `${step.nodeId}:${step.status}`).join('|');
  useEffect(() => {
    void reload();
  }, [reload, run?.status, run?.currentNode, stepKey]);

  const report = useCallback((recordId: string, next: CheckProgress) => {
    setProgress((current) => (JSON.stringify(current[recordId]) === JSON.stringify(next) ? current : { ...current, [recordId]: next }));
  }, []);

  const checklist = useMemo<Checklist>(
    () =>
      runChecklist({
        graph: run?.graph || null,
        status: run?.status || 'QUEUED',
        currentNode: run?.currentNode || null,
        steps: run?.steps || [],
        records: checkRecords({ reviews: run?.reviews, forms: forms || [], stages: stages || [] }),
        progress,
      }),
    [run, forms, stages, progress],
  );

  // Between a person finishing a decision and the worker taking the run up, the run still says it is
  // waiting but nothing is open. Follow it until the next step shows.
  const loaded = stages !== null && forms !== null;
  const nothingOpen = loaded && !stages.some((stage) => stage.status === 'OPEN') && !forms.some((form) => form.status === 'OPEN') && (run?.reviews || []).every((review) => review.status !== 'OPEN');
  const handingOn = run?.status === 'WAITING' && nothingOpen;
  useEffect(() => {
    if (!handingOn) return;
    const timer = setInterval(() => {
      onChanged();
      void reload();
    }, 2000);
    return () => clearInterval(timer);
  }, [handingOn, onChanged, reload]);

  return { checklist, stages: stages || [], forms: forms || [], loaded, report, reload };
}

/** A sentence for what a finished run made live, read from its last steps. */
function outcomeLine(run: RunDetail): string | null {
  for (const step of [...run.steps].reverse()) {
    const result = record(step.output);
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
  return null;
}

const MARK: Record<CheckState, { fg: string; bg: string; line: string }> = {
  done: { fg: '#fff', bg: '#16a34a', line: '#16a34a' },
  skipped: { fg: '#475569', bg: '#e2e8f0', line: '#cbd5e1' },
  current: { fg: '#fff', bg: '#c2410c', line: '#c2410c' },
  waiting: { fg: '#334155', bg: '#f1f5f9', line: '#94a3b8' },
  attention: { fg: '#fff', bg: '#dc2626', line: '#dc2626' },
  ahead: { fg: 'var(--ink-3)', bg: 'transparent', line: 'var(--line-strong)' },
};

const KIND_WORD: Record<ChecklistItem['kind'], string> = { review: 'Review', form: 'Form', stage: 'Screen' };

function Marker({ item }: { item: ChecklistItem }) {
  const mark = MARK[item.state];
  const glyph = item.state === 'done' ? '✓' : item.state === 'skipped' ? '–' : item.state === 'attention' ? '!' : item.number ?? '?';
  return (
    <span
      aria-hidden
      style={{
        width: 26,
        height: 26,
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12.5,
        fontWeight: 700,
        color: mark.fg,
        background: mark.bg,
        border: `2px ${item.number === null ? 'dashed' : 'solid'} ${mark.line}`,
        flex: '0 0 auto',
      }}
    >
      {glyph}
    </span>
  );
}

function Parts({ progress }: { progress: CheckProgress }) {
  if (!progress.parts || progress.parts.length === 0) return null;
  const next = progress.parts.findIndex((part) => !part.done);
  return (
    <ol style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'grid', gap: 3 }}>
      {progress.parts.map((part, index) => (
        <li key={part.label} aria-label={`${part.label}${part.note ? `, ${part.note}` : ''}: ${part.done ? 'done' : index === next ? 'next' : 'to do'}`} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, color: part.done ? 'var(--ink-3)' : index === next ? 'var(--ink)' : 'var(--ink-2)', fontWeight: index === next ? 600 : 400 }}>
          <span aria-hidden style={{ width: 14, flex: '0 0 auto', color: part.done ? '#16a34a' : index === next ? '#c2410c' : 'var(--ink-4)' }}>{part.done ? '✓' : index === next ? '›' : '○'}</span>
          <span>{part.label}</span>
          {part.note && <span style={{ fontWeight: 400, color: 'var(--ink-3)' }}>· {part.note}</span>}
        </li>
      ))}
    </ol>
  );
}

const row = (selected: boolean, clickable: boolean): CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: '26px minmax(0, 1fr) auto',
  gap: 12,
  alignItems: 'start',
  width: '100%',
  boxSizing: 'border-box',
  textAlign: 'left',
  padding: '10px 14px',
  border: 'none',
  borderTop: '1px solid var(--line)',
  background: selected ? 'var(--bg-alt, #f8fafc)' : 'transparent',
  boxShadow: selected ? 'inset 3px 0 0 #c2410c' : undefined,
  cursor: clickable ? 'pointer' : 'default',
  font: 'inherit',
  color: 'inherit',
});

interface Props {
  run: RunDetail;
  decisions: RunDecisions;
  onChanged: () => void;
}

export function RunChecklist({ run, decisions, onChanged }: Props) {
  const { checklist, stages, forms, loaded, report } = decisions;
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState<string | null>(null);

  // A task opened from the inbox or a notice names its decision in the link.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('decision');
    if (wanted) setPicked(wanted);
  }, []);

  // When the open decision moves on, so does the list. Not when it first loads, so a decision named in the link stays open.
  const currentId = checklist.current?.nodeId || null;
  const lastCurrent = useRef<string | null>(null);
  useEffect(() => {
    if (lastCurrent.current !== null && lastCurrent.current !== currentId) setPicked(null);
    lastCurrent.current = currentId;
  }, [currentId]);

  // Finishing a decision changes the person's task count everywhere at once.
  const changed = () => {
    refreshTasks();
    onChanged();
  };

  const reachable = (item: ChecklistItem) => Boolean(item.recordId);
  const selected =
    checklist.items.find((item) => item.nodeId === picked && reachable(item)) ||
    checklist.current ||
    checklist.items.find((item) => item.state === 'waiting' && reachable(item)) ||
    null;

  async function complete(stage: StageView, outcome: string, result: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const { data, error: failed } = await graphqlMutation<{ completeWorkflowStage: { stage: StageView | null; errors: Array<{ message: string }> } }>(COMPLETE_STAGE, { id: stage.id, outcome, result });
      const problem = failed?.message || data?.completeWorkflowStage.errors[0]?.message;
      if (problem) throw new Error(problem);
      await decisions.reload();
      changed();
    } catch (err: any) {
      setError(err?.message || 'The stage could not be finished');
      throw err;
    } finally {
      setBusy(false);
    }
  }

  const moving = run.status === 'QUEUED' || run.status === 'RUNNING';
  const finished = ['SUCCEEDED', 'CANCELLED', 'FAILED'].includes(run.status);
  const outcome = run.status === 'SUCCEEDED' ? outcomeLine(run) : null;
  const none = checklist.total === 0 && checklist.possible === 0;
  const percent = checklist.total === 0 ? (run.status === 'SUCCEEDED' ? 100 : 0) : Math.round((checklist.done / checklist.total) * 100);

  function pane(item: ChecklistItem) {
    const heading = (
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: item.state === 'current' ? '#c2410c' : 'var(--ink-3)' }}>
          {item.number !== null ? `Decision ${item.number}${checklist.total > 1 ? ` of ${checklist.total}` : ''}` : 'Decision'} · {KIND_WORD[item.kind]}
        </span>
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{item.note}</span>
      </div>
    );

    if (item.kind === 'review') {
      const review = run.reviews.find((entry) => entry.id === item.recordId);
      if (!review) return null;
      return (
        <>
          {heading}
          <ReviewPanel key={review.id} review={review} canManage={run.canManage === true} onDecided={changed} onProgress={(next) => report(review.id, next)} />
        </>
      );
    }

    if (item.kind === 'form') {
      const form = forms.find((entry) => entry.id === item.recordId);
      if (!form) return null;
      return (
        <>
          {heading}
          <FormCard
            form={form}
            inRun
            expanded={formOpen === form.id || (form.status === 'OPEN' && form.canAnswer)}
            onExpand={() => setFormOpen(form.id)}
            onAnswered={() => {
              setFormOpen(null);
              void decisions.reload();
              changed();
            }}
          />
        </>
      );
    }

    const stage = stages.find((entry) => entry.id === item.recordId);
    if (!stage) return null;
    const Screen = STAGE_COMPONENTS[stage.screen];
    return (
      <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 16, background: 'var(--surface)' }}>
        {heading}
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>{stage.title}</h2>
          {stage.status === 'OPEN' && dueText(stage.dueAt) && <span style={{ fontSize: 12, fontWeight: 600 }}>{dueText(stage.dueAt)}</span>}
        </div>
        {stage.instructions && <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '4px 0 12px' }}>{stage.instructions}</p>}
        {stage.status !== 'OPEN' ? (
          <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
            {item.note}
            {stage.completedAt ? ` ${when(stage.completedAt)}` : ''}.
          </div>
        ) : !stage.canAct ? (
          <div style={{ fontSize: 13 }}>
            Waiting on {assigneeText(stage.assignees as never)}. {stage.blocker}
          </div>
        ) : (
          <>
            {stage.returnedReason && (
              <div role="alert" style={{ border: '1px solid #fedf89', background: '#fffaeb', color: '#93370d', borderRadius: 8, padding: '8px 12px', fontSize: 13, margin: '8px 0 12px' }}>
                This came back to you. {stage.returnedReason}
              </div>
            )}
            {Screen ? (
              <Screen key={stage.id} stage={stage} busy={busy} onComplete={(next, result) => complete(stage, next, result)} onProgress={(next) => report(stage.id, next)} />
            ) : (
              <div role="alert" style={{ color: 'var(--red)' }}>This app has no screen called “{stage.screen}”.</div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <section style={{ margin: '4px 0 20px', display: 'grid', gap: 14 }}>
      <div style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface)', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Checklist</span>
            <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
              {!loaded ? 'Reading what this run needs…' : none ? (finished ? 'This run needed no decisions.' : 'This run needs no decisions. It runs on its own and reports when it is done.') : checklistSummary(checklist)}
            </span>
          </div>
          {loaded && !none && (
            <div role="progressbar" aria-label="Decisions done" aria-valuemin={0} aria-valuemax={checklist.total} aria-valuenow={checklist.done} style={{ height: 6, borderRadius: 999, background: 'var(--line)', overflow: 'hidden' }}>
              <div style={{ width: `${percent}%`, height: '100%', background: '#16a34a', transition: 'width .3s' }} />
            </div>
          )}
        </div>

        {loaded && checklist.items.length > 0 && (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {checklist.items.map((item) => {
              const clickable = reachable(item);
              const isSelected = selected?.nodeId === item.nodeId;
              const counted = progressText(item.progress);
              const body = (
                <>
                  <Marker item={item} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: item.state === 'current' ? 600 : 500, color: item.state === 'ahead' ? 'var(--ink-2)' : 'var(--ink)' }}>{item.label}</span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-3)', marginTop: 1 }}>
                      {KIND_WORD[item.kind]} · {item.detail}
                      {counted && item.state === 'current' ? ` · ${counted}` : ''}
                    </span>
                    {item.state === 'current' && item.progress && <Parts progress={item.progress} />}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: item.state === 'current' ? '#c2410c' : item.state === 'attention' ? '#b91c1c' : item.state === 'done' ? '#166534' : 'var(--ink-3)', textAlign: 'right', maxWidth: 260 }}>
                    {item.state === 'current' ? 'Your move' : item.note}
                  </span>
                </>
              );
              return (
                <li key={item.nodeId} aria-current={item.state === 'current' ? 'step' : undefined}>
                  {clickable ? (
                    <button type="button" style={row(isSelected, true)} onClick={() => setPicked(item.nodeId)} aria-pressed={isSelected}>
                      {body}
                    </button>
                  ) : (
                    <div style={row(false, false)}>{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {error && <div role="alert" style={{ color: 'var(--red)' }}>{error}</div>}

      {moving && (
        <div aria-live="polite" style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 14, fontSize: 13, color: 'var(--ink-3)' }}>
          {run.status === 'QUEUED' ? 'Waiting for a worker to pick this up…' : checklist.working ? `The system is working: ${checklist.working}…` : 'Working…'}
          {!none && checklist.items.some((item) => item.state === 'ahead') ? ' The next decision opens here when the run reaches it.' : ''}
        </div>
      )}

      {selected && pane(selected)}

      {outcome && (
        <div aria-live="polite" style={{ border: '1px solid #abefc6', background: '#ecfdf3', color: '#05603a', borderRadius: 10, padding: 16, fontSize: 14 }}>
          {outcome}
        </div>
      )}
    </section>
  );
}
