'use client';

import { useState, type CSSProperties } from 'react';
import { asGraph, type WorkflowGraph } from '@tapestrai/graphql/src/lib/workflow-graph';
import { graphqlQuery } from '@/lib/graphql';
import { diffGraphs, diffIsEmpty, exportWorkflow } from '@/lib/workflow-versions';

/**
 * Under the editor: compare the graph on screen with another version, and
 * download it as a file to import in another environment.
 */

const GRAPH_QUERY = `query WorkflowVersionGraph($id: ID!, $version: Int) { workflow(id: $id, version: $version) { graph } }`;

const list: CSSProperties = { margin: '4px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.6 };

interface Props {
  workflowId: string;
  code: string;
  name: string;
  description: string | null;
  /** The version on screen, or null for unsaved changes. */
  version: number | null;
  graph: WorkflowGraph;
  versions: number[];
  publishedVersion: number | null;
}

export function VersionTools({ workflowId, code, name, description, version, graph, versions, publishedVersion }: Props) {
  const [against, setAgainst] = useState<number | ''>('');
  const [other, setOther] = useState<WorkflowGraph | null>(null);
  const [message, setMessage] = useState('');

  const compare = async (target: number) => {
    setAgainst(target);
    setOther(null);
    setMessage('');
    const result = await graphqlQuery<{ workflow: { graph: unknown } | null }>(GRAPH_QUERY, { id: workflowId, version: target }, 'network-only');
    if (result.error || !result.data?.workflow) setMessage(result.error?.message || 'That version could not be read.');
    else setOther(asGraph(result.data.workflow.graph));
  };

  const download = () => {
    const file = exportWorkflow({ code, name, description, version, graph });
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${code.toLowerCase() || 'workflow'}${version ? `-v${version}` : ''}.workflow.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const diff = other ? diffGraphs(other, graph) : null;

  return (
    <section style={{ marginTop: 24, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Versions</span>
        <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'flex', gap: 6, alignItems: 'center' }}>
          Compare what is on screen with
          <select className="text-input" style={{ padding: '5px 8px', fontSize: 12 }} value={against} onChange={(event) => event.target.value && void compare(Number(event.target.value))}>
            <option value="">a version…</option>
            {versions.map((candidate) => (
              <option key={candidate} value={candidate}>
                Version {candidate}
                {candidate === publishedVersion ? ' (published)' : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-sm" onClick={download} title="A file to import in another environment. People named on review steps are left out; roles are kept.">
          Export
        </button>
      </div>
      {message && <div style={{ fontSize: 12, color: 'var(--red)' }}>{message}</div>}
      {diff && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, background: 'var(--surface)', fontSize: 13 }}>
          {diffIsEmpty(diff) ? (
            <span style={{ color: 'var(--ink-3)' }}>No difference from version {against}, apart from where steps sit.</span>
          ) : (
            <>
              <div style={{ fontWeight: 600 }}>Changes since version {against}</div>
              <ul style={list}>
                {diff.added.map((step) => (
                  <li key={`a-${step.id}`}>Added <strong>{step.label}</strong></li>
                ))}
                {diff.removed.map((step) => (
                  <li key={`r-${step.id}`}>Removed <strong>{step.label}</strong></li>
                ))}
                {diff.changed.map((step) => (
                  <li key={`c-${step.id}`}>
                    Changed <strong>{step.label}</strong>
                    {step.renamed ? ' (renamed)' : ''}
                    {step.settings.length > 0 ? `: ${step.settings.join(', ')}` : ''}
                  </li>
                ))}
                {diff.connectionsAdded.map((edge) => (
                  <li key={`ea-${edge}`}>Connected {edge}</li>
                ))}
                {diff.connectionsRemoved.map((edge) => (
                  <li key={`er-${edge}`}>Disconnected {edge}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
