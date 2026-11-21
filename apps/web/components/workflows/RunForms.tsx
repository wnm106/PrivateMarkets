'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { FormFields } from '@/components/workflows/FormFields';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { asFields } from '@/lib/workflow-forms';
import { assigneeText, dueText, statusOf, when, type Assignee, type MutationErrors } from '@/lib/workflows';

/**
 * Forms workflow steps are waiting on: the open ones for the hub, or every
 * form of one run for its page. A form for someone outside the firm shows who
 * it went to; someone who manages workflows can answer it for them.
 */

export interface FormView {
  nodeId: string;
  id: string;
  runId: string;
  workflowName: string | null;
  title: string;
  instructions: string | null;
  fields: unknown;
  status: string;
  answers: Record<string, unknown> | null;
  note: string | null;
  externalEmail: string | null;
  linkActive: boolean;
  assignees: Assignee[];
  canAnswer: boolean;
  blocker: string | null;
  submittedByName: string | null;
  submittedAt: string | null;
  dueAt: string | null;
  createdAt: string;
}

const FIELDS = 'id runId nodeId workflowName title instructions fields status answers note externalEmail linkActive assignees canAnswer blocker submittedByName submittedAt dueAt createdAt';
export const FORMS_QUERY = `query WorkflowForms($status: String, $runId: ID) { workflowForms(status: $status, runId: $runId) { ${FIELDS} } }`;
const SUBMIT = `mutation SubmitWorkflowForm($id: ID!, $outcome: String!, $answers: JSON, $note: String) {
  submitWorkflowForm(id: $id, outcome: $outcome, answers: $answers, note: $note) { form { id } errors { message } }
}`;
const CHILDREN = `query WorkflowRunChildren($runId: ID!) { workflowRunChildren(runId: $runId) }`;

const card: CSSProperties = { border: '1px solid var(--line-strong)', borderRadius: 8, background: 'var(--surface)', padding: 14, display: 'grid', gap: 8 };

interface Props {
  /** One run's forms, any status. Left out, the open forms the caller can see. */
  runId?: string;
  onAnswered?(): void;
}

export function RunForms({ runId, onAnswered }: Props) {
  const [forms, setForms] = useState<FormView[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await graphqlQuery<{ workflowForms: FormView[] }>(FORMS_QUERY, runId ? { status: null, runId } : { status: 'OPEN' }, 'network-only');
    if (!result.aborted) setForms(result.data?.workflowForms || []);
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!forms || forms.length === 0) return null;

  return (
    <section style={{ display: 'grid', gap: 8, margin: '16px 0' }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{runId ? 'Forms' : `Forms waiting (${forms.length})`}</div>
      {forms.map((form) => (
        <FormCard
          key={form.id}
          form={form}
          inRun={Boolean(runId)}
          expanded={openId === form.id || (Boolean(runId) && form.status === 'OPEN' && form.canAnswer && forms.length === 1)}
          onExpand={() => setOpenId(form.id)}
          onAnswered={() => {
            setOpenId(null);
            void load();
            onAnswered?.();
          }}
        />
      ))}
    </section>
  );
}

interface CardProps {
  form: FormView;
  /** Shown on its run's page, so the run is not linked. */
  inRun: boolean;
  expanded: boolean;
  onExpand(): void;
  onAnswered(): void;
}

/** One form: who it is for, and its fields when it is open and yours, or its answers once given. */
export function FormCard({ form, inRun, expanded, onExpand, onAnswered }: CardProps) {
  const due = form.status === 'OPEN' ? dueText(form.dueAt) : null;
  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{form.title}</strong>
        {!inRun && form.workflowName && <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{form.workflowName}</span>}
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          {form.externalEmail ? `Sent to ${form.externalEmail}${form.status === 'OPEN' ? (form.linkActive ? ' · link works' : ' · link expired') : ''}` : `For ${assigneeText(form.assignees)}`}
        </span>
        {due && <span style={{ fontSize: 12, fontWeight: 600 }}>{due}</span>}
        {form.status !== 'OPEN' && (
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            {form.status === 'SUBMITTED' ? 'Answered' : form.status === 'DECLINED' ? 'Declined' : 'Cancelled'}
            {form.submittedByName ? ` by ${form.submittedByName}` : ''} {when(form.submittedAt)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!inRun && <Link href={`/workflows/runs/${form.runId}`} style={{ fontSize: 12 }}>Run</Link>}
        {form.status === 'OPEN' && form.canAnswer && !expanded && (
          <button type="button" className="btn btn-sm btn-primary" onClick={onExpand}>
            {form.externalEmail ? 'Answer for them' : 'Fill in'}
          </button>
        )}
      </div>
      {form.instructions && <div style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'pre-wrap' }}>{form.instructions}</div>}
      {form.status === 'OPEN' && !form.canAnswer && form.blocker && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{form.blocker}</div>}
      {form.status === 'SUBMITTED' && form.answers && (
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0, fontSize: 13 }}>
          {asFields(form.fields).map((field) => (
            <div key={field.key} style={{ display: 'contents' }}>
              <dt style={{ color: 'var(--ink-3)' }}>{field.label}</dt>
              <dd style={{ margin: 0 }}>{form.answers?.[field.key] === undefined ? '—' : String(form.answers[field.key])}</dd>
            </div>
          ))}
        </dl>
      )}
      {form.note && form.status !== 'OPEN' && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Note: {form.note}</div>}
      {form.status === 'OPEN' && form.canAnswer && expanded && (
        <FormFields
          fields={asFields(form.fields)}
          onSubmit={async (outcome, answers, note) => {
            const { data, error } = await graphqlMutation<{ submitWorkflowForm: { errors: MutationErrors } }>(SUBMIT, { id: form.id, outcome, answers, note });
            const problem = error?.message || data?.submitWorkflowForm.errors[0]?.message;
            if (problem) return problem;
            onAnswered();
            return null;
          }}
        />
      )}
    </div>
  );
}

interface ChildRun {
  id: string;
  status: string;
  input: { filters?: { entityIds?: string[] } };
  openReviews: number;
}

/** The runs a run was split into, one per record. */
export function RunChildren({ runId }: { runId: string }) {
  const [children, setChildren] = useState<ChildRun[]>([]);
  useEffect(() => {
    let live = true;
    void graphqlQuery<{ workflowRunChildren: ChildRun[] }>(CHILDREN, { runId }, 'network-only').then((result) => {
      if (live && !result.aborted) setChildren(result.data?.workflowRunChildren || []);
    });
    return () => {
      live = false;
    };
  }, [runId]);
  if (children.length === 0) return null;
  const counts = children.reduce<Record<string, number>>((acc, child) => ({ ...acc, [child.status]: (acc[child.status] || 0) + 1 }), {});
  return (
    <section style={{ margin: '16px 0', display: 'grid', gap: 6 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>
        Split into {children.length} run{children.length === 1 ? '' : 's'}, one per record
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-3)' }}>
          {' '}· {Object.entries(counts).map(([status, count]) => `${count} ${statusOf(status).label.toLowerCase()}`).join(', ')}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {children.slice(0, 100).map((child, index) => {
          const status = statusOf(child.status);
          return (
            <Link key={child.id} href={`/workflows/runs/${child.id}`} className="wf-run-status" style={{ color: status.color, background: status.tint, textDecoration: 'none' }} title={child.openReviews > 0 ? 'Waiting for a review' : status.label}>
              Run {index + 1}
            </Link>
          );
        })}
        {children.length > 100 && <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>and {children.length - 100} more</span>}
      </div>
    </section>
  );
}
