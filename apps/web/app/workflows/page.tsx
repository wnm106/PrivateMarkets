'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { StartRunDialog } from '@/components/workflows/StartRunDialog';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { usePublishViewContext } from '@/lib/view-context';
import {
  SAVE_WORKFLOW,
  WORKFLOW_HUB_QUERY,
  assigneeText,
  dueText,
  statusOf,
  when,
  type MutationErrors,
  type ReviewView,
  type RunSummary,
  type WorkflowSummary,
  type WorkflowTemplateOption,
} from '@/lib/workflows';

const cell: CSSProperties = { padding: '9px 10px', borderBottom: '1px solid var(--line)', fontSize: 13, textAlign: 'left', verticalAlign: 'middle' };
const head: CSSProperties = { ...cell, fontSize: 11, fontWeight: 600, color: 'var(--ink-3)', background: 'var(--bg-alt)' };
const sectionTitle: CSSProperties = { fontSize: 14, fontWeight: 600, margin: '24px 0 8px' };
const empty: CSSProperties = { padding: 16, border: '1px dashed var(--line-strong)', borderRadius: 8, color: 'var(--ink-3)', fontSize: 13 };

interface Hub {
  workflows: WorkflowSummary[];
  workflowRuns: RunSummary[];
  workflowReviews: ReviewView[];
  workflowTemplates: WorkflowTemplateOption[];
}

export default function WorkflowsPage() {
  const router = useRouter();
  const [hub, setHub] = useState<Hub | null>(null);
  const [message, setMessage] = useState('');
  const [picking, setPicking] = useState(false);
  const [starting, setStarting] = useState<WorkflowSummary | null>(null);
  const [busy, setBusy] = useState(false);

  usePublishViewContext({ activity: 'viewing', kind: 'workflows', label: 'Workflows', summary: 'Automations with fixed, agent, and human review steps' });

  const load = useCallback(async () => {
    const result = await graphqlQuery<Hub>(WORKFLOW_HUB_QUERY, {}, 'network-only');
    if (result.aborted) return;
    if (result.error) setMessage(result.error.message);
    else if (result.data) {
      setHub(result.data);
      setMessage('');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the lists moving while a run is in flight.
  const active = Boolean(hub?.workflowRuns.some((run) => run.status === 'QUEUED' || run.status === 'RUNNING'));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [active, load]);

  const createFrom = async (template: WorkflowTemplateOption) => {
    setBusy(true);
    const name = template.code === 'BLANK' ? 'New workflow' : template.name;
    const taken = new Set((hub?.workflows || []).map((workflow) => workflow.code));
    let code = template.code === 'BLANK' ? 'NEW_WORKFLOW' : template.code;
    for (let index = 2; taken.has(code); index += 1) code = `${template.code === 'BLANK' ? 'NEW_WORKFLOW' : template.code}_${index}`;
    const { data, error } = await graphqlMutation<{ saveWorkflow: { workflow: { id: string } | null; errors: MutationErrors } }>(SAVE_WORKFLOW, {
      input: { name, code, description: template.code === 'BLANK' ? null : template.description, graph: template.graph, changeNote: `Started from the ${template.name} template` },
    });
    setBusy(false);
    const problem = error?.message || data?.saveWorkflow.errors[0]?.message;
    if (problem || !data?.saveWorkflow.workflow) {
      setMessage(problem || 'The workflow could not be created.');
      return;
    }
    router.push(`/workflows/${data.saveWorkflow.workflow.id}`);
  };

  const reviews = hub?.workflowReviews || [];
  // Yours to decide come first; the server already orders by due date within each group.
  const yours = reviews.filter((review) => review.canReview);
  const others = reviews.filter((review) => !review.canReview);
  const [showOthers, setShowOthers] = useState(false);

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Workflows</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div className="page-title">Workflows</div>
            <div className="page-meta">
              Automations that run step by step. Fixed steps do the same thing every time, agent steps investigate and propose changes, and nothing an agent proposes is applied until a person approves it.
            </div>
          </div>
        </div>
        <button type="button" className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => setPicking(!picking)} disabled={!hub}>
          New workflow
        </button>
      </div>

      {message && <div role="alert" style={{ color: 'var(--red)', margin: '12px 0' }}>{message}</div>}
      {!hub && !message && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Loading workflows…</div>}

      {picking && hub && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, margin: '16px 0' }}>
          {hub.workflowTemplates.map((template) => (
            <button
              key={template.code}
              type="button"
              disabled={busy}
              onClick={() => createFrom(template)}
              style={{ textAlign: 'left', padding: 14, border: '1px solid var(--line-strong)', borderRadius: 8, background: 'var(--surface)', cursor: 'pointer' }}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>{template.name}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4, lineHeight: 1.45 }}>{template.description}</div>
              <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 8 }}>{template.graph.nodes.length} steps</div>
            </button>
          ))}
        </div>
      )}

      {hub && (
        <>
          <div style={sectionTitle}>Waiting for you{yours.length > 0 ? ` (${yours.length})` : ''}</div>
          {yours.length === 0 ? (
            <div style={empty}>Nothing is waiting for you to review.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {yours.map((review) => (
                <ReviewRow key={review.id} review={review} />
              ))}
            </div>
          )}
          {others.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => setShowOthers(!showOthers)} style={{ border: 'none', background: 'none', padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--entity-link)', cursor: 'pointer' }}>
                {showOthers ? 'Hide' : 'Show'} {others.length} waiting for someone else
              </button>
              {showOthers && (
                <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                  {others.map((review) => (
                    <ReviewRow key={review.id} review={review} />
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={sectionTitle}>Workflows</div>
          {hub.workflows.length === 0 ? (
            <div style={empty}>No workflows yet. Choose New workflow to start from a template.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--line)' }}>
              <thead>
                <tr>
                  <th style={head}>Name</th>
                  <th style={head}>Published</th>
                  <th style={head}>Runs</th>
                  <th style={head}>Last run</th>
                  <th style={{ ...head, width: 200 }}></th>
                </tr>
              </thead>
              <tbody>
                {hub.workflows.map((workflow) => (
                  <tr key={workflow.id}>
                    <td style={cell}>
                      <Link href={`/workflows/${workflow.id}`} style={{ fontWeight: 600, color: 'var(--entity-link)', textDecoration: 'none' }}>{workflow.name}</Link>
                      {!workflow.clientId && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--ink-4)' }}>Shared</span>}
                      {workflow.description && <div style={{ fontSize: 12, color: 'var(--ink-3)', maxWidth: 620 }}>{workflow.description}</div>}
                    </td>
                    <td style={cell}>
                      {workflow.publishedVersion ? `Version ${workflow.publishedVersion}` : <span style={{ color: 'var(--ink-4)' }}>Draft</span>}
                      {workflow.publishedVersion && workflow.latestVersion > workflow.publishedVersion && <div style={{ fontSize: 11, color: '#b45309' }}>Version {workflow.latestVersion} not published</div>}
                    </td>
                    <td style={cell}>{workflow.runCount}</td>
                    <td style={cell}>{when(workflow.lastRunAt) || '—'}</td>
                    <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <Link href={`/workflows/${workflow.id}`} className="btn btn-sm" style={{ marginRight: 6 }}>{workflow.canManage ? 'Edit' : 'View'}</Link>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={!workflow.publishedVersion}
                        title={workflow.publishedVersion ? undefined : 'Publish a version first'}
                        onClick={() => setStarting(workflow)}
                      >
                        Start run
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {starting && (
            <StartRunDialog workflow={starting} onClose={() => setStarting(null)} onStarted={(runId) => router.push(`/workflows/runs/${runId}`)} />
          )}

          <div style={sectionTitle}>Recent runs</div>
          {hub.workflowRuns.length === 0 ? (
            <div style={empty}>No runs yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--line)' }}>
              <thead>
                <tr>
                  <th style={head}>Workflow</th>
                  <th style={head}>Status</th>
                  <th style={head}>Started</th>
                  <th style={head}>Finished</th>
                  <th style={head}></th>
                </tr>
              </thead>
              <tbody>
                {hub.workflowRuns.map((run) => {
                  const status = statusOf(run.status);
                  return (
                    <tr key={run.id}>
                      <td style={cell}>
                        <Link href={`/workflows/runs/${run.id}`} style={{ fontWeight: 600, color: 'var(--entity-link)', textDecoration: 'none' }}>{run.workflowName}</Link>
                        <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--ink-4)' }}>v{run.version}</span>
                      </td>
                      <td style={cell}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: status.color, background: status.tint, padding: '2px 8px', borderRadius: 999 }}>{status.label}</span>
                        {run.errorMessage && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4, maxWidth: 420 }}>{run.errorMessage}</div>}
                      </td>
                      <td style={cell}>{when(run.startedAt || run.createdAt)}</td>
                      <td style={cell}>{when(run.finishedAt) || '—'}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>
                        <Link href={`/workflows/runs/${run.id}`} className="btn btn-sm">Open</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function ReviewRow({ review }: { review: ReviewView }) {
  const due = dueText(review.dueAt);
  const mine = review.canReview;
  return (
    <Link
      href={`/workflows/runs/${review.runId}`}
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        padding: '12px 14px',
        border: `1px solid ${mine ? '#fde8c0' : 'var(--line)'}`,
        borderLeft: `5px solid ${review.overdue ? '#b91c1c' : mine ? '#b45309' : 'var(--line-strong)'}`,
        borderRadius: 8,
        background: mine ? '#fffbeb' : 'var(--surface)',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{review.title}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          {review.workflowName} · {review.itemCount} proposed {review.itemCount === 1 ? 'change' : 'changes'} · asked {when(review.createdAt)} · for {review.assignedToMe ? 'you' : assigneeText(review.assignees)}
          {due && <span style={{ fontWeight: 600, color: review.overdue ? '#b91c1c' : 'inherit' }}> · {due}</span>}
        </div>
        {!mine && review.blocker && <div style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: 2 }}>{review.blocker}</div>}
      </div>
      <span className={`btn btn-sm${mine ? ' btn-primary' : ''}`}>{mine ? 'Review' : 'View'}</span>
    </Link>
  );
}
