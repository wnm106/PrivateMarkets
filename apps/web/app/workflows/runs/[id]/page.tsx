'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { GuidedRun } from '@/components/workflows/GuidedRun';
import { ReviewPanel } from '@/components/workflows/ReviewPanel';
import { RunChildren, RunForms } from '@/components/workflows/RunForms';
import { WorkflowCanvas, type CanvasSelection } from '@/components/workflows/WorkflowCanvas';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { usePublishTabs, usePublishViewContext } from '@/lib/view-context';
import { newestFirst, runNextStep, runTabs, type Tone } from '@/lib/workflow-run-view';
import { isGuided } from '@/lib/workflow-stages';
import { CANCEL_RUN, RETRY_RUN, WORKFLOW_RUN_QUERY, clock, kindOf, statusOf, when, type EventView, type MutationErrors, type RunDetail } from '@/lib/workflows';

const ACTOR: Record<EventView['actorType'], { label: string; color: string; tint: string }> = {
  SYSTEM: { label: 'System', color: '#334155', tint: '#f1f5f9' },
  AGENT: { label: 'Agent', color: '#6d28d9', tint: '#f3e8ff' },
  USER: { label: 'Person', color: '#b45309', tint: '#fef3c7' },
};

/** The banner that says what happens next, coloured by whose move it is. */
const TONE: Record<Tone, { label: string; fg: string; bg: string; line: string }> = {
  act: { label: 'Your move', fg: '#7c2d12', bg: '#fff7ed', line: '#fdba74' },
  wait: { label: 'Waiting', fg: '#334155', bg: '#f8fafc', line: '#cbd5e1' },
  working: { label: 'Working', fg: '#155e75', bg: '#ecfeff', line: '#a5f3fc' },
  done: { label: 'Done', fg: '#166534', bg: '#f0fdf4', line: '#bbf7d0' },
  failed: { label: 'Stopped', fg: '#991b1b', bg: '#fef2f2', line: '#fecaca' },
};

type TabKey = 'overview' | 'details';

const pre: CSSProperties = { margin: 0, padding: 10, background: '#0f172a', color: '#e2e8f0', borderRadius: 6, fontSize: 11, lineHeight: 1.5, overflow: 'auto', maxHeight: 320, whiteSpace: 'pre-wrap', wordBreak: 'break-word' };
const sectionTitle: CSSProperties = { fontSize: 14, fontWeight: 600, margin: '20px 0 8px' };

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

export default function WorkflowRunPage() {
  const params = useParams();
  const id = String(params.id);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<TabKey>('overview');
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const [actorFilter, setActorFilter] = useState<'ALL' | EventView['actorType']>('ALL');
  const [openEvent, setOpenEvent] = useState<string | null>(null);

  usePublishViewContext({ activity: 'viewing', kind: 'workflow-run', label: run?.workflowName ? `${run.workflowName} run` : 'Workflow run', id, summary: run ? statusOf(run.status).label : undefined });
  usePublishTabs(runTabs(run));

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ workflowRun: RunDetail | null }>(WORKFLOW_RUN_QUERY, { id }, 'network-only');
    if (result.aborted) return;
    if (result.error || !result.data?.workflowRun) setMessage(result.error?.message || 'This run was not found.');
    else {
      setRun(result.data.workflowRun);
      setMessage('');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Follow the run while the worker is moving it.
  const moving = run?.status === 'QUEUED' || run?.status === 'RUNNING';
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [moving, load]);

  const act = async (mutation: string, field: string) => {
    const { data, error } = await graphqlMutation<Record<string, { errors: MutationErrors }>>(mutation, { id });
    setMessage(error?.message || data?.[field]?.errors[0]?.message || '');
    load();
  };

  const marks = useMemo(() => Object.fromEntries((run?.steps || []).map((step) => [step.nodeId, { status: step.status, outcome: step.outcome }])), [run?.steps]);
  const selectedNodeId = selection?.kind === 'node' ? selection.id : null;
  const selectedNode = selectedNodeId ? run?.graph?.nodes.find((node) => node.id === selectedNodeId) : undefined;
  const selectedStep = selectedNodeId ? run?.steps.find((step) => step.nodeId === selectedNodeId) : undefined;
  const events = newestFirst(run?.events || []).filter((event) => (actorFilter === 'ALL' || event.actorType === actorFilter) && (!selectedNodeId || event.nodeId === selectedNodeId));
  // With a Split, several paths can each be waiting for a review at once.
  const openReviews = (run?.reviews || []).filter((review) => review.status === 'OPEN');
  const pastReviews = (run?.reviews || []).filter((review) => review.status !== 'OPEN');
  const status = run ? statusOf(run.status) : null;
  const next = run ? runNextStep(run) : null;
  const tone = next ? TONE[next.tone] : null;
  // A workflow with stages is worked through one screen at a time.
  const guided = isGuided(run?.graph);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/workflows" className="crumb-link">Workflows</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Run</span>
      </div>

      {message && <div role="alert" style={{ color: 'var(--red)', margin: '12px 0' }}>{message}</div>}
      {!run && !message && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Loading the run…</div>}

      {run && status && next && tone && (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 18, fontWeight: 600 }}>{run.workflowName}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: status.color, background: status.tint, padding: '3px 10px', borderRadius: 999 }}>{status.label}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>
                <Link href={`/workflows/${run.workflowId}`} style={{ color: 'var(--entity-link)' }}>Version {run.version}</Link> · started {when(run.startedAt || run.createdAt)}
                {run.finishedAt ? ` · finished ${when(run.finishedAt)}` : ''}
              </div>
            </div>
            {run.canRun && ['QUEUED', 'RUNNING', 'WAITING'].includes(run.status) && (
              <button type="button" className="btn" onClick={() => window.confirm('Cancel this run? Changes already applied stay. Nothing further will run.') && act(CANCEL_RUN, 'cancelWorkflowRun')}>
                Cancel run
              </button>
            )}
          </div>

          <div role="status" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', border: `1px solid ${tone.line}`, borderLeft: `4px solid ${tone.fg}`, background: tone.bg, borderRadius: 8, padding: '10px 14px', marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: tone.fg }}>{tone.label}</span>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: tone.fg }}>{next.headline}</div>
              {next.detail && <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 2 }}>{next.detail}</div>}
            </div>
            {run.canRun && run.status === 'FAILED' && <button type="button" className="btn btn-primary" onClick={() => act(RETRY_RUN, 'retryWorkflowRun')}>Retry from the failed step</button>}
          </div>

          <div className="da-tabs" role="tablist" style={{ margin: '8px 0 16px' }}>
            {([
              ['overview', 'Overview'],
              ['details', `Details · ${run.events.length} in history`],
            ] as const).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>

          {/* Kept mounted while hidden, so decisions not yet applied survive a look at Details. */}
          <div hidden={tab !== 'overview'}>
            {typeof run.input.parentRunId === 'string' && (
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>
                One of the runs <Link href={`/workflows/runs/${run.input.parentRunId}`}>a run split by record</Link> started.
              </div>
            )}
            {openReviews.map((openReview) => (
              <div key={openReview.id} style={{ marginBottom: 16 }}>
                <ReviewPanel review={openReview} canManage={run.canManage === true} onDecided={load} />
              </div>
            ))}
            <RunForms runId={run.id} onAnswered={load} />
            <RunChildren runId={run.id} />
            {guided && <GuidedRun run={run} onChanged={load} />}
            {openReviews.length === 0 && !guided && (
              <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                {pastReviews.length > 0 ? `${pastReviews.length === 1 ? 'One review was' : `${pastReviews.length} reviews were`} decided in this run. ` : ''}
                The steps, earlier decisions and full history are on{' '}
                <button type="button" onClick={() => setTab('details')} style={{ border: 'none', background: 'none', padding: 0, color: 'var(--entity-link)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  Details
                </button>
                .
              </div>
            )}
          </div>

          {tab === 'details' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 360px', gap: 12, alignItems: 'start' }}>
              <div style={{ minWidth: 0 }}>
                {run.graph && <WorkflowCanvas graph={run.graph} selection={selection} onSelect={setSelection} steps={marks} currentNode={moving || run.status === 'WAITING' ? run.currentNode : null} height={420} />}

                {selectedNode && (
                  <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 14, marginTop: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: kindOf(selectedNode).color, background: kindOf(selectedNode).tint, padding: '1px 6px', borderRadius: 999 }}>{kindOf(selectedNode).label}</span>
                      <strong>{selectedNode.label}</strong>
                      {selectedStep && <span style={{ fontSize: 11, fontWeight: 600, color: statusOf(selectedStep.status).color }}>{statusOf(selectedStep.status).label}{selectedStep.outcome ? ` · ${selectedStep.outcome}` : ''}</span>}
                      <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setSelection(null)}>Close</button>
                    </div>
                    {!selectedStep ? (
                      <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 8 }}>The run did not reach this step.</div>
                    ) : (
                      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
                        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                          Started {when(selectedStep.startedAt)}
                          {selectedStep.finishedAt ? ` · finished ${when(selectedStep.finishedAt)}` : ''}
                          {selectedStep.attempts > 1 ? ` · ${selectedStep.attempts} attempts` : ''}
                        </div>
                        {selectedStep.errorMessage && <div style={{ color: 'var(--red)', fontSize: 13 }}>{selectedStep.errorMessage}</div>}
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-3)', marginBottom: 4 }}>Settings</div>
                          <pre style={pre}>{pretty(selectedNode.config)}</pre>
                        </div>
                        {selectedStep.output !== null && selectedStep.output !== undefined && (
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-3)', marginBottom: 4 }}>Result</div>
                            <pre style={pre}>{pretty(selectedStep.output)}</pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {pastReviews.length > 0 && <div style={sectionTitle}>Earlier decisions</div>}
                {pastReviews.map((review) => (
                  <div key={review.id} style={{ marginTop: 12 }}>
                    <ReviewPanel review={review} canManage={run.canManage === true} onDecided={load} />
                  </div>
                ))}

                <div style={sectionTitle}>Input</div>
                <pre style={pre}>{pretty(run.input)}</pre>
              </div>

              <aside style={{ border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', minWidth: 0 }}>
                <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>History{selectedNode ? `: ${selectedNode.label}` : ''}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>Everything the system, the agent, and people did in this run, newest first. Entries are never changed.</div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
                    {(['ALL', 'SYSTEM', 'AGENT', 'USER'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        aria-pressed={actorFilter === option}
                        onClick={() => setActorFilter(option)}
                        style={{
                          border: '1px solid var(--line-strong)',
                          borderRadius: 999,
                          padding: '2px 10px',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: 'pointer',
                          background: actorFilter === option ? 'var(--accent)' : '#fff',
                          color: actorFilter === option ? '#fff' : 'var(--ink-2)',
                        }}
                      >
                        {option === 'ALL' ? 'All' : ACTOR[option].label}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ maxHeight: 640, overflowY: 'auto' }}>
                  {events.length === 0 && <div style={{ padding: 12, fontSize: 12, color: 'var(--ink-3)' }}>Nothing recorded yet.</div>}
                  {events.map((event) => {
                    const actor = ACTOR[event.actorType] || ACTOR.SYSTEM;
                    const node = event.nodeId ? run.graph?.nodes.find((candidate) => candidate.id === event.nodeId) : null;
                    const expanded = openEvent === event.id;
                    const hasDetail = event.detail !== null && event.detail !== undefined;
                    return (
                      <div key={event.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', borderLeft: `3px solid ${actor.color}` }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--ink-4)' }}>
                          <span style={{ fontWeight: 700, color: actor.color, background: actor.tint, padding: '0 6px', borderRadius: 999 }}>{event.actorType === 'USER' && event.actorName ? event.actorName : actor.label}</span>
                          <span title={when(event.createdAt)}>{clock(event.createdAt)}</span>
                          {node && !selectedNode && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {node.label}</span>}
                        </div>
                        <div style={{ fontSize: 12.5, marginTop: 3, lineHeight: 1.4, color: event.type.endsWith('failed') ? 'var(--red)' : 'var(--ink)' }}>{event.summary}</div>
                        {hasDetail && (
                          <button type="button" onClick={() => setOpenEvent(expanded ? null : event.id)} style={{ border: 'none', background: 'none', padding: 0, marginTop: 3, fontSize: 11, color: 'var(--entity-link)', cursor: 'pointer' }}>
                            {expanded ? 'Hide detail' : 'Show detail'}
                          </button>
                        )}
                        {expanded && <pre style={{ ...pre, marginTop: 6, maxHeight: 240 }}>{pretty(event.detail)}</pre>}
                      </div>
                    );
                  })}
                </div>
              </aside>
            </div>
          )}
        </>
      )}
    </div>
  );
}
