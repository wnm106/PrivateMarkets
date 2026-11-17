'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { parseRunSetup } from '@tapestrai/graphql/src/lib/workflow-filters';
import { graphqlQuery } from '@/lib/graphql';
import { RUNNABLE_WORKFLOWS_QUERY, type RecordChoice, type WorkflowSummary } from '@/lib/workflows';
import { StartRunDialog } from './StartRunDialog';

/**
 * "Run workflow" on a record. Lists the published workflows that work on this
 * type of record, or on any type, and starts the chosen one with this record
 * already selected.
 */
export function RunWorkflowButton({ record }: { record: RecordChoice }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [problem, setProblem] = useState('');
  const [starting, setStarting] = useState<WorkflowSummary | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const toggle = async () => {
    setOpen(!open);
    if (open || workflows) return;
    const { data, error } = await graphqlQuery<{ workflows: WorkflowSummary[] }>(RUNNABLE_WORKFLOWS_QUERY, {}, 'network-only');
    if (error) setProblem(error.message);
    setWorkflows(
      (data?.workflows || []).filter((workflow) => {
        if (!workflow.publishedVersion) return false;
        const appliesTo = parseRunSetup(workflow.runSetup).appliesTo;
        return !appliesTo || appliesTo === record.domainCode;
      }),
    );
  };

  return (
    <div ref={box} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>Run workflow</button>
      {open && (
        <div role="menu" style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 340, maxHeight: 360, overflow: 'auto', background: 'var(--surface, #fff)', border: '1px solid var(--line-strong)', borderRadius: 8, boxShadow: '0 12px 30px rgba(15, 23, 42, 0.18)', zIndex: 50 }}>
          {problem && <div role="alert" style={{ padding: 12, fontSize: 13, color: 'var(--red)' }}>{problem}</div>}
          {!problem && workflows === null && <div style={{ padding: 12, fontSize: 13, color: 'var(--ink-4)' }}>Loading…</div>}
          {!problem && workflows?.length === 0 && <div style={{ padding: 12, fontSize: 13, color: 'var(--ink-4)' }}>No published workflow runs on this type of record.</div>}
          {workflows?.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setStarting(workflow);
              }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 0, borderBottom: '1px solid var(--line)', background: 'none', cursor: 'pointer' }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>{workflow.name}</div>
              {workflow.description && <div style={{ fontSize: 12, color: 'var(--ink-3)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{workflow.description}</div>}
            </button>
          ))}
        </div>
      )}
      {starting && (
        <StartRunDialog
          workflow={starting}
          records={[record]}
          onClose={() => setStarting(null)}
          onStarted={(runId) => router.push(`/workflows/runs/${runId}`)}
        />
      )}
    </div>
  );
}
