'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormFields } from '@/components/workflows/FormFields';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { asFields, type FormField } from '@/lib/workflow-forms';
import type { MutationErrors } from '@/lib/workflows';

/**
 * A form sent to someone outside the firm, opened by its private link. No
 * sign-in: the link is the key. It shows only the form, works once, and
 * expires. See docs/WORKFLOWS.md.
 */

interface PortalForm {
  title: string;
  instructions: string | null;
  fields: unknown;
  dueAt: string | null;
  from: string | null;
}

const QUERY = `query WorkflowPortalForm($token: String!) { workflowPortalForm(token: $token) }`;
const SUBMIT = `mutation SubmitWorkflowPortalForm($token: String!, $outcome: String!, $answers: JSON, $note: String) {
  submitWorkflowPortalForm(token: $token, outcome: $outcome, answers: $answers, note: $note) { success errors { message } }
}`;

export default function PortalFormPage() {
  const params = useParams<{ token: string }>();
  const token = String(params?.token || '');
  const [form, setForm] = useState<PortalForm | null>(null);
  const [fields, setFields] = useState<FormField[]>([]);
  const [state, setState] = useState<'loading' | 'missing' | 'open' | 'done' | 'declined'>('loading');

  useEffect(() => {
    let live = true;
    void graphqlQuery<{ workflowPortalForm: PortalForm | null }>(QUERY, { token }, 'network-only').then((result) => {
      if (!live || result.aborted) return;
      const found = result.data?.workflowPortalForm || null;
      setForm(found);
      setFields(asFields(found?.fields));
      setState(found ? 'open' : 'missing');
    });
    return () => {
      live = false;
    };
  }, [token]);

  return (
    <main style={{ minHeight: '100vh', background: 'var(--bg-alt, #f6f7f9)', padding: '48px 16px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', background: 'var(--surface, #fff)', border: '1px solid var(--line, #e5e7eb)', borderRadius: 10, padding: 24 }}>
        {state === 'loading' && <p style={{ color: 'var(--ink-3)' }}>Opening the form…</p>}
        {state === 'missing' && (
          <>
            <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>This link does not work</h1>
            <p style={{ color: 'var(--ink-3)', fontSize: 14, lineHeight: 1.5 }}>It may have been used already, or it has expired. Ask the person who sent it for a new one.</p>
          </>
        )}
        {(state === 'done' || state === 'declined') && (
          <>
            <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>{state === 'done' ? 'Thank you' : 'Declined'}</h1>
            <p style={{ color: 'var(--ink-3)', fontSize: 14, lineHeight: 1.5 }}>
              {state === 'done' ? 'Your answers were sent.' : 'The firm has been told you declined.'} You can close this page. The link no longer works.
            </p>
          </>
        )}
        {state === 'open' && form && (
          <>
            {form.from && <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 4 }}>From {form.from}</div>}
            <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>{form.title}</h1>
            {form.instructions && <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{form.instructions}</p>}
            {form.dueAt && <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>Please answer by {form.dueAt.slice(0, 16).replace('T', ' ')} UTC.</p>}
            <div style={{ marginTop: 16 }}>
              <FormFields
                fields={fields}
                onSubmit={async (outcome, answers, note) => {
                  const { data, error } = await graphqlMutation<{ submitWorkflowPortalForm: { success: boolean; errors: MutationErrors } }>(SUBMIT, { token, outcome, answers, note });
                  const problem = error?.message || data?.submitWorkflowPortalForm.errors[0]?.message;
                  if (problem || !data?.submitWorkflowPortalForm.success) return problem || 'The answers could not be sent.';
                  setState(outcome === 'SUBMITTED' ? 'done' : 'declined');
                  return null;
                }}
              />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
