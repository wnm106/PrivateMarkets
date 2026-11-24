'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { SourcePane } from '@/components/feeds/SourcePane';
import { ReviewPanel } from '@/components/workflows/ReviewPanel';
import { FORMS_QUERY, FormCard, type FormView } from '@/components/workflows/RunForms';
import { StepPane } from '@/components/workflows/StepPane';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { checkRecords, checklistSummary, progressText, runChecklist, type CheckProgress, type CheckState, type Checklist, type ChecklistItem } from '@/lib/workflow-checklist';
import { durationText, storySummary, type FactTone, type OpenItem, type RunStory, type StoryStep } from '@/lib/workflow-story';
import { resultView, stepDetail } from '@/lib/workflow-step-detail';
import { runStoryOf, type RunDecisionsView } from '@/lib/workflow-run-view';
import { refreshTasks } from '@/lib/tasks';
import { COMPLETE_STAGE, RUN_STAGES_QUERY, type StageView } from '@/lib/workflow-stages';
import { assigneeText, dueText, when, type RunDetail } from '@/lib/workflows';
import { STAGE_COMPONENTS } from './stages';

/**
 * A run worked through step by step. Every step on the run's path is listed in
 * order with what it did: the system's and the agent's steps in a line and a
 * few figures, and each decision a person makes numbered and ticked off as it
 * is done. Every step opens in place, under its own line: a decision opens its
 * screen there, and any other step shows what it was asked and what it returned.
 * The decision the run waits on is open to start with, and the steps done before
 * it are folded into one line so it sits near the top of the page.
 */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export interface RunDecisions extends RunDecisionsView {
  stages: StageView[];
  forms: FormView[];
  /** The forms and stages have loaded, so the checklist is whole. */
  loaded: boolean;
  /** Every step on the run's path with what it did, and what the run leaves open. */
  story: RunStory;
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

  const story = useMemo(() => runStoryOf(run, checklist), [run, checklist]);

  return { checklist, story, stages: stages || [], forms: forms || [], loaded, report, reload };
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
    // The step that makes approved changes says how many it made.
    if (typeof result.applied === 'number' && Array.isArray(result.results)) {
      const failed = Number(result.failed) || 0;
      if (result.applied + failed === 0) return null;
      return `${result.applied === 1 ? 'The 1 approved change was' : `The ${result.applied.toLocaleString()} approved changes were`} made${failed > 0 ? `, and ${failed.toLocaleString()} could not be. The step list says which` : ''}.`;
    }
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

const TONE_FG: Record<FactTone, string> = { good: '#166534', warn: '#b45309', bad: '#b91c1c' };

const STEP_MARK: Record<StoryStep['state'], { glyph: string; fg: string; line: string }> = {
  done: { glyph: '✓', fg: '#16a34a', line: '#86efac' },
  skipped: { glyph: '–', fg: '#64748b', line: '#cbd5e1' },
  running: { glyph: '…', fg: '#0e7490', line: '#67e8f9' },
  waiting: { glyph: '…', fg: '#64748b', line: '#cbd5e1' },
  failed: { glyph: '!', fg: '#dc2626', line: '#fca5a5' },
  ahead: { glyph: '', fg: 'var(--ink-4)', line: 'var(--line-strong)' },
};

const rowStyle = (open: boolean, accent: string): CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: '26px minmax(0, 1fr) auto',
  gap: 12,
  alignItems: 'center',
  width: '100%',
  boxSizing: 'border-box',
  textAlign: 'left',
  padding: '8px 14px',
  border: 'none',
  background: open ? 'var(--bg-alt, #f8fafc)' : 'transparent',
  boxShadow: open ? `inset 3px 0 0 ${accent}` : undefined,
  cursor: 'pointer',
  font: 'inherit',
  color: 'inherit',
});

/** The arrow at the end of a row: it points down when the step is open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <span aria-hidden className="run-step-open" style={{ fontWeight: 700, display: 'inline-block', transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }}>
      ›
    </span>
  );
}

/** The line of a step the system or the agent does on its own: its name, what it did, how long it took. It opens in place to show the rest. */
function OwnStepRow({ step, open, onToggle }: { step: StoryStep; open: boolean; onToggle(): void }) {
  const mark = STEP_MARK[step.state];
  const ahead = step.state === 'ahead';
  const took = durationText(step.seconds);
  return (
    <button
      type="button"
      className="run-step"
      aria-expanded={open}
      aria-label={`${step.label}: ${step.state === 'done' ? 'done' : ahead ? 'still to run' : step.state}. ${open ? 'Close it.' : ahead ? 'Open to see what it will do.' : 'Open to see what it did.'}`}
      onClick={onToggle}
      style={rowStyle(open, 'var(--accent)')}
    >
      <span aria-hidden style={{ width: 18, height: 18, margin: '0 4px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: mark.fg, border: `1.5px ${ahead ? 'dashed' : 'solid'} ${mark.line}`, boxSizing: 'border-box' }}>
        {mark.glyph}
      </span>
      <span style={{ minWidth: 0, display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', color: ahead ? 'var(--ink-3)' : 'var(--ink)' }}>{step.label}</span>
        {step.kind === 'agent' && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#6d28d9', background: '#f3e8ff', padding: '0 6px', borderRadius: 999 }}>Agent</span>}
        {/* One line, cut short. The whole of it, its figures and its trouble are in the step once it is open. */}
        {step.did && !open && <span style={{ minWidth: 0, flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: step.state === 'failed' ? '#b91c1c' : 'var(--ink-3)' }}>{step.did}</span>}
        {step.trouble && !open && <span title={step.trouble} style={{ fontSize: 11.5, fontWeight: 700, color: '#b45309', whiteSpace: 'nowrap' }}>Retried</span>}
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--ink-4)', whiteSpace: 'nowrap', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        {ahead ? (step.certain ? 'Still to run' : 'Only on some choices') : took}
        <Chevron open={open} />
      </span>
    </button>
  );
}

/** What the run found open and does not settle itself, with who each item sits with. It is shown in the step that found it, and when the run is over. */
function OpenItems({ items, from, finished, inStep = false }: { items: OpenItem[]; from: string | null; finished: boolean; inStep?: boolean }) {
  if (items.length === 0) return null;
  const th: CSSProperties = { padding: '6px 10px', fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4, textAlign: 'left', borderBottom: '1px solid var(--line)', background: 'var(--bg-alt)' };
  const td: CSSProperties = { padding: '8px 10px', fontSize: 12.5, verticalAlign: 'top', borderBottom: '1px solid var(--line)' };
  const others = items.filter((item) => !item.decidedHere).length;
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface)', overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px 8px' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{finished ? 'What this run left open' : inStep ? 'What this step found open, and who has it' : 'What this run found open, and who has it'}</div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 2 }}>
          {from && !inStep ? `As the step “${from}” of this run found it. ` : ''}
          {others === 0 ? 'Everything open is decided in this run.' : `${others} of ${items.length} ${others === 1 ? 'is' : 'are'} not settled by this run, and ${others === 1 ? 'needs' : 'need'} the person named.`}
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Open item</th>
              <th style={th}>Next step</th>
              <th style={{ ...th, width: 150 }}>Who</th>
              <th style={{ ...th, width: 170 }}>Where it stands</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{item.title}</div>
                  {item.why && <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 1 }}>{item.why}</div>}
                </td>
                <td style={td}>{item.action}</td>
                <td style={td}>{item.owner || '—'}</td>
                <td style={{ ...td, fontWeight: 600, fontSize: 12, color: item.decidedHere ? '#c2410c' : item.blocking ? '#b91c1c' : 'var(--ink-3)' }}>
                  {item.decidedHere ? 'Decided in this run' : item.blocking ? 'Open, and holds up the close' : 'Open'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Fewer steps than this before the open decision are simply listed. More are folded into one line, so the decision stays near the top. */
const FOLD_FROM = 3;

interface Props {
  run: RunDetail;
  decisions: RunDecisions;
  onChanged: () => void;
}

export function RunChecklist({ run, decisions, onChanged }: Props) {
  const { checklist, story, stages, forms, loaded, report } = decisions;
  const [picked, setPicked] = useState<string | null>(null);
  /** Steps the person opened or closed themself. Any other step is open only when it is the decision the run waits on. */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<'all' | 'decisions'>('all');
  /** The steps done before the open decision are shown, not folded into one line. */
  const [unfolded, setUnfolded] = useState(false);
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
    if (lastCurrent.current !== null && lastCurrent.current !== currentId) {
      setPicked(null);
      setToggled({});
    }
    lastCurrent.current = currentId;
  }, [currentId]);

  // Finishing a decision changes the person's task count everywhere at once.
  const changed = () => {
    refreshTasks();
    onChanged();
  };

  const reachable = (item: ChecklistItem) => Boolean(item.recordId);
  /** The decision that is open without being asked for: the one named in the link, the one that is yours, or the one the run waits on. */
  const selected =
    checklist.items.find((item) => item.nodeId === picked && reachable(item)) ||
    checklist.current ||
    checklist.items.find((item) => item.state === 'waiting' && reachable(item)) ||
    null;
  const isOpen = (nodeId: string) => toggled[nodeId] ?? selected?.nodeId === nodeId;
  const toggle = (nodeId: string) => setToggled((current) => ({ ...current, [nodeId]: !(current[nodeId] ?? selected?.nodeId === nodeId) }));

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
  // What the run found open is shown where it belongs: under the changes that decide it, in the step that found it, and at the end.
  const openDecidedHere = story.open.some((item) => item.decidedHere);
  const openFromId = story.openFrom ? [...story.steps].reverse().find((step) => step.kind !== 'human' && step.label === story.openFrom)?.nodeId || null : null;

  /** The screen of a decision the run has reached: the review, the form, or the stage's own screen. */
  function pane(item: ChecklistItem) {
    if (item.kind === 'review') {
      const review = run.reviews.find((entry) => entry.id === item.recordId);
      if (!review) return null;
      return (
        <div style={{ display: 'grid', gap: 12 }}>
          <ReviewPanel key={review.id} review={review} canManage={run.canManage === true} onDecided={changed} onProgress={(next) => report(review.id, next)} />
          {review.status === 'OPEN' && openDecidedHere && <OpenItems items={story.open} from={story.openFrom} finished={false} />}
        </div>
      );
    }

    if (item.kind === 'form') {
      const form = forms.find((entry) => entry.id === item.recordId);
      if (!form) return null;
      return (
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
      );
    }

    const stage = stages.find((entry) => entry.id === item.recordId);
    if (!stage) return null;
    const Screen = STAGE_COMPONENTS[stage.screen];
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        {(stage.instructions || (stage.status === 'OPEN' && dueText(stage.dueAt))) && (
          <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
            {stage.instructions}
            {stage.status === 'OPEN' && dueText(stage.dueAt) ? <b style={{ marginLeft: 8, color: 'var(--ink-2)' }}>{dueText(stage.dueAt)}</b> : null}
          </p>
        )}
        {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}
        {stage.status !== 'OPEN' ? (
          <div style={{ fontSize: 13, color: 'var(--ink-2)', display: 'grid', gap: 8 }}>
            <span>
              {item.note}
              {stage.completedAt ? ` ${when(stage.completedAt)}` : ''}.
            </span>
            {/* What the person left the screen with: the file they handed over, the reason they gave. */}
            {(resultView(stage.result)?.fields || []).length > 0 && (
              <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 200px) minmax(0, 1fr)', gap: '3px 12px', margin: 0 }}>
                {resultView(stage.result)!.fields.map((field) => (
                  <div key={field.label} style={{ display: 'contents' }}>
                    <dt style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{field.label}</dt>
                    <dd style={{ fontSize: 12.5, fontWeight: 600, margin: 0, wordBreak: 'break-word' }}>{field.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {/* A stage that was left with a file shows the file, so it can be looked at from the run at any time. */}
            {typeof stage.result?.importInstanceId === 'string' && stage.result.importInstanceId && (
              <SourcePane instanceId={stage.result.importInstanceId} fileName={typeof stage.result.fileName === 'string' ? stage.result.fileName : 'The file'} target={null} height="min(60vh, 520px)" />
            )}
          </div>
        ) : !stage.canAct ? (
          <div style={{ fontSize: 13 }}>
            Waiting on {assigneeText(stage.assignees as never)}. {stage.blocker}
          </div>
        ) : (
          <>
            {stage.returnedReason && (
              <div role="alert" style={{ border: '1px solid #fedf89', background: '#fffaeb', color: '#93370d', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                This came back to you. {stage.returnedReason}
              </div>
            )}
            {Screen ? (
              <Screen key={stage.id} stage={stage} busy={busy} onComplete={(next, result) => complete(stage, next, result)} onProgress={(next) => report(stage.id, next)} />
            ) : (
              <div role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>
                This page does not have the screen “{stage.screen}” yet. Reload the page; if it still says so, the app needs restarting to pick the screen up.
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const showAll = filter === 'all';
  const byNode = new Map(checklist.items.map((item) => [item.nodeId, item]));
  const ownSteps = story.steps.filter((step) => step.kind !== 'human');
  // Decisions the run may never reach are on the checklist but not on the path the story walks.
  const offPath = checklist.items.filter((item) => !story.steps.some((step) => step.nodeId === item.nodeId));
  const told = storySummary(story);

  // The steps already done before the open decision are folded into one line, so the decision is near the top of the page.
  const selectedAt = selected ? story.steps.findIndex((step) => step.nodeId === selected.nodeId) : -1;
  const earlier = selectedAt > 0 ? story.steps.slice(0, selectedAt).filter((step) => step.kind !== 'human' && step.state === 'done') : [];
  const folds = showAll && earlier.length >= FOLD_FROM;
  const folded = new Set(folds && !unfolded ? earlier.filter((step) => !isOpen(step.nodeId)).map((step) => step.nodeId) : []);

  // What an opened step shows, for each step that is open and has no screen of its own.
  const openKey = [...story.steps.map((step) => step.nodeId), ...offPath.map((item) => item.nodeId)].filter((nodeId) => isOpen(nodeId) && !(byNode.get(nodeId) && reachable(byNode.get(nodeId)!))).join('|');
  const details = useMemo(
    () => new Map(openKey.split('|').filter(Boolean).map((nodeId) => [nodeId, stepDetail({ graph: run.graph, status: run.status, currentNode: run.currentNode, steps: run.steps, events: run.events, checklist }, nodeId)] as const)),
    [openKey, run, checklist],
  );

  const body: CSSProperties = { padding: '6px 14px 16px', borderTop: '1px dashed var(--line)', background: 'var(--surface)' };

  /** A step opened in place, for a step with no screen of its own: what it was asked, what it returned, its history. */
  function opened(nodeId: string) {
    const detail = details.get(nodeId);
    if (!detail) return null;
    return (
      <div style={{ ...body, display: 'grid', gap: 12 }}>
        <StepPane step={detail} backLabel="Close" onBack={() => toggle(nodeId)} />
        {nodeId === openFromId && !finished && <OpenItems items={story.open} from={story.openFrom} finished={false} inStep />}
      </div>
    );
  }

  function decisionRow(item: ChecklistItem) {
    const hasScreen = reachable(item);
    const open = isOpen(item.nodeId);
    const counted = progressText(item.progress);
    const accent = item.state === 'current' ? '#c2410c' : 'var(--accent)';
    const facts = story.steps.find((step) => step.nodeId === item.nodeId)?.facts || [];
    const standing = item.state === 'current' ? 'Your move' : item.state === 'waiting' ? item.note.split('. ')[0] : item.note;
    return (
      <li key={item.nodeId} aria-current={item.state === 'current' ? 'step' : undefined} style={{ borderTop: '1px solid var(--line)', boxShadow: open ? `inset 3px 0 0 ${accent}` : undefined }}>
        <button type="button" className="run-step" style={{ ...rowStyle(open, accent), padding: '10px 14px' }} onClick={() => toggle(item.nodeId)} aria-expanded={open}>
          <Marker item={item} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 13.5, fontWeight: item.state === 'current' ? 600 : 500, color: item.state === 'ahead' ? 'var(--ink-2)' : 'var(--ink)' }}>{item.label}</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-3)', marginTop: 1 }}>
              {item.number !== null ? `Decision ${item.number}${checklist.total > 1 ? ` of ${checklist.total}` : ''}` : 'Decision'} · {item.detail}
              {counted && item.state === 'current' ? ` · ${counted}` : ''}
              {facts.map((fact) => (
                <span key={fact.label} style={{ wordBreak: 'break-word' }}>
                  {' '}· {fact.label}: <span style={{ fontWeight: 600, color: fact.tone ? TONE_FG[fact.tone] : 'var(--ink-2)' }}>{fact.value}</span>
                </span>
              ))}
            </span>
          </span>
          <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-flex', gap: 8, alignItems: 'center', color: item.state === 'current' ? '#c2410c' : item.state === 'attention' ? '#b91c1c' : item.state === 'done' ? '#166534' : 'var(--ink-3)' }}>
            {standing}
            <Chevron open={open} />
          </span>
        </button>
        {/* A decision the run has reached opens its own screen, here, under its line. An open one stays in place when its line is closed, so choices made on it and not yet applied are kept. */}
        {hasScreen && (open || item.state === 'current') && (
          <div hidden={!open} style={{ ...body, paddingTop: 12 }}>
            {item.state === 'current' && item.progress && (
              <div style={{ marginBottom: 10 }}>
                <Parts progress={item.progress} />
              </div>
            )}
            {pane(item)}
          </div>
        )}
        {/* One the run has not reached opens as a step, to say what it will ask and of whom. */}
        {!hasScreen && open && opened(item.nodeId)}
      </li>
    );
  }

  return (
    <section className="run-work">
      <div className="run-steps" style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface)', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Step by step</span>
            <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
              {!loaded ? 'Reading what this run needs…' : none ? (finished ? 'This run needed no decisions.' : 'This run needs no decisions. It runs on its own and reports when it is done.') : checklistSummary(checklist)}
            </span>
          </div>
          {loaded && !none && (
            <div role="progressbar" aria-label="Decisions done" aria-valuemin={0} aria-valuemax={checklist.total} aria-valuenow={checklist.done} style={{ height: 6, borderRadius: 999, background: 'var(--line)', overflow: 'hidden' }}>
              <div style={{ width: `${percent}%`, height: '100%', background: '#16a34a', transition: 'width .3s' }} />
            </div>
          )}
          {loaded && ownSteps.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: 'var(--ink-3)' }}>
              <span style={{ flex: 1, minWidth: 160 }}>{told}. Open any step to see what it did.</span>
              {checklist.items.length > 0 && (
                <span role="group" aria-label="Which steps to list" style={{ display: 'inline-flex', border: '1px solid var(--line-strong)', borderRadius: 6, overflow: 'hidden' }}>
                  {([
                    ['all', 'Every step'],
                    ['decisions', 'Decisions only'],
                  ] as const).map(([key, label]) => (
                    <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} style={{ border: 'none', padding: '3px 9px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', background: filter === key ? 'var(--accent)' : '#fff', color: filter === key ? '#fff' : 'var(--ink-2)' }}>
                      {label}
                    </button>
                  ))}
                </span>
              )}
            </div>
          )}
          {moving && (
            <div aria-live="polite" style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
              {run.status === 'QUEUED' ? 'Waiting for a worker to pick this up…' : checklist.working ? `The system is working: ${checklist.working}…` : 'Working…'}
              {!none && checklist.items.some((item) => item.state === 'ahead') ? ' The next decision opens in the list when the run reaches it.' : ''}
            </div>
          )}
          {outcome && (
            <div aria-live="polite" style={{ border: '1px solid #abefc6', background: '#ecfdf3', color: '#05603a', borderRadius: 8, padding: '10px 12px', fontSize: 13.5 }}>
              {outcome}
            </div>
          )}
          {/* A stage's own error is shown on the stage. Anything else that went wrong is said here. */}
          {error && selected?.kind !== 'stage' && <div role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}
        </div>

        {loaded && (story.steps.length > 0 || offPath.length > 0) && (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {story.steps.map((step) => {
              const item = byNode.get(step.nodeId);
              if (item) return decisionRow(item);
              if (!showAll) return null;
              const fold = folds && earlier[0]?.nodeId === step.nodeId && (
                <li key="earlier" style={{ borderTop: '1px solid var(--line)' }}>
                  <button type="button" className="run-step" aria-expanded={unfolded} onClick={() => setUnfolded((current) => !current)} style={rowStyle(false, 'var(--accent)')}>
                    <span aria-hidden style={{ width: 18, height: 18, margin: '0 4px', borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: STEP_MARK.done.fg, border: `1.5px solid ${STEP_MARK.done.line}`, boxSizing: 'border-box' }}>✓</span>
                    <span style={{ minWidth: 0, fontSize: 12.5, color: 'var(--ink-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ fontWeight: 600, color: 'var(--ink-2)' }}>{earlier.length} steps done before this decision</span>
                      {unfolded ? '' : `: ${earlier.map((entry) => entry.label).join(', ')}`}
                    </span>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--entity-link)', whiteSpace: 'nowrap', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {unfolded ? 'Fold them away' : 'Show them'}
                      <Chevron open={unfolded} />
                    </span>
                  </button>
                </li>
              );
              if (folded.has(step.nodeId)) return fold || null;
              const open = isOpen(step.nodeId);
              const line = (
                <li key={step.nodeId} style={{ borderTop: '1px solid var(--line)', boxShadow: open ? 'inset 3px 0 0 var(--accent)' : undefined }}>
                  <OwnStepRow step={step} open={open} onToggle={() => toggle(step.nodeId)} />
                  {open && opened(step.nodeId)}
                </li>
              );
              return fold ? [fold, line] : line;
            })}
            {offPath.map(decisionRow)}
          </ol>
        )}
      </div>

      {loaded && finished && <OpenItems items={story.open} from={story.openFrom} finished />}
    </section>
  );
}
