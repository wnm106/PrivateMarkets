'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NODE_TYPES, validateGraph, type NodeType, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from '@tapestrai/graphql/src/lib/workflow-graph';
import { EdgeInspector, NodeInspector } from '@/components/workflows/NodeInspector';
import { StartRunDialog } from '@/components/workflows/StartRunDialog';
import { WorkflowTriggers } from '@/components/workflows/WorkflowTriggers';
import { WorkflowCanvas, type CanvasSelection } from '@/components/workflows/WorkflowCanvas';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { authHeaders } from '@/lib/reporting';
import { usePublishViewContext } from '@/lib/view-context';
import {
  ARCHIVE_WORKFLOW,
  KIND_STYLE,
  PUBLISH_WORKFLOW,
  SAVE_WORKFLOW,
  WORKFLOW_QUERY,
  nodeIdFor,
  statusOf,
  when,
  type MutationErrors,
  type RunSummary,
  type ToolOption,
  type WorkflowDetail,
} from '@/lib/workflows';

const ADDABLE = NODE_TYPES.filter((def) => def.type !== 'start');

export default function WorkflowEditorPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);

  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [graph, setGraph] = useState<WorkflowGraph>({ nodes: [], edges: [] });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const [tools, setTools] = useState<ToolOption[]>([]);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  /** The saved version a trial run is about to start on, while its records are being chosen. */
  const [trying, setTrying] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  usePublishViewContext({ activity: 'editing', kind: 'workflow', label: workflow?.name || 'Workflow', id, summary: 'Workflow editor' });

  const load = useCallback(
    async (version?: number) => {
      const result = await graphqlQuery<{ workflow: WorkflowDetail | null; workflowRuns: RunSummary[] }>(WORKFLOW_QUERY, { id, version: version ?? null }, 'network-only');
      if (result.aborted) return;
      setLoading(false);
      if (result.error || !result.data?.workflow) {
        setMessage(result.error?.message || 'This workflow was not found.');
        return;
      }
      const found = result.data.workflow;
      setWorkflow(found);
      setRuns(result.data.workflowRuns);
      setGraph(found.graph || { nodes: [], edges: [] });
      setName(found.name);
      setDescription(found.description || '');
      setDirty(false);
      setSelection(null);
      setMessage('');
    },
    [id],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch('/api/workflows/tools', { headers: authHeaders() })
      .then((response) => (response.ok ? response.json() : { tools: [] }))
      .then((data: { tools?: ToolOption[] }) => setTools(data.tools || []))
      .catch(() => setTools([]));
  }, []);

  // Leaving with unsaved steps asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const canManage = workflow?.canManage === true;
  const toolNames = useMemo(() => (tools.length > 0 ? new Set(tools.map((tool) => tool.name)) : undefined), [tools]);
  const problems = useMemo(() => validateGraph(graph, toolNames), [graph, toolNames]);
  const problemNodes = useMemo(() => new Set(problems.map((problem) => problem.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId))), [problems]);
  const viewingOld = Boolean(workflow && workflow.version !== null && workflow.version !== workflow.latestVersion);

  const change = (next: WorkflowGraph) => {
    setGraph(next);
    setDirty(true);
    setNotice('');
  };

  const addNode = (type: NodeType) => {
    const def = NODE_TYPES.find((candidate) => candidate.type === type);
    if (!def) return;
    const taken = new Set(graph.nodes.map((node) => node.id));
    const nodeId = nodeIdFor(def.label, taken);
    // Dropped to the right of the selected step, or of the rightmost one.
    const anchor = (selection?.kind === 'node' && graph.nodes.find((node) => node.id === selection.id)) || [...graph.nodes].sort((a, b) => b.position.x - a.position.x)[0];
    const node: WorkflowNode = {
      id: nodeId,
      type,
      label: def.label,
      position: { x: (anchor?.position.x ?? 0) + 250, y: (anchor?.position.y ?? 100) + (anchor ? 90 : 0) },
      config: JSON.parse(JSON.stringify(def.defaultConfig)),
    };
    change({ ...graph, nodes: [...graph.nodes, node] });
    setSelection({ kind: 'node', id: nodeId });
  };

  const save = async (): Promise<number | null> => {
    setBusy(true);
    setMessage('');
    const { data, error } = await graphqlMutation<{ saveWorkflow: { workflow: { version: number } | null; errors: MutationErrors } }>(SAVE_WORKFLOW, {
      input: { id, name, description, graph, changeNote: note || null },
    });
    setBusy(false);
    const problem = error?.message || data?.saveWorkflow.errors[0]?.message;
    if (problem || !data?.saveWorkflow.workflow) {
      setMessage(problem || 'The workflow could not be saved.');
      return null;
    }
    setNote('');
    await load();
    setNotice(`Saved as version ${data.saveWorkflow.workflow.version}. It is not published yet.`);
    return data.saveWorkflow.workflow.version;
  };

  const publish = async () => {
    if (!workflow) return;
    let version = workflow.version ?? workflow.latestVersion;
    if (dirty) {
      const saved = await save();
      if (saved === null) return;
      version = saved;
    }
    setBusy(true);
    const { data, error } = await graphqlMutation<{ publishWorkflow: { errors: MutationErrors } }>(PUBLISH_WORKFLOW, { id, version });
    setBusy(false);
    const failed = error?.message || data?.publishWorkflow.errors.map((entry) => entry.message).join(' ');
    if (failed) {
      setMessage(failed);
      return;
    }
    await load(version);
    setNotice(`Version ${version} is published. New runs use it.`);
  };

  const tryRun = async () => {
    if (!workflow) return;
    let version = workflow.version ?? workflow.latestVersion;
    if (dirty) {
      const saved = await save();
      if (saved === null) return;
      version = saved;
    }
    // A trial run asks for its records like any other. It never starts on everything by default.
    setTrying(version);
  };

  const archive = async () => {
    if (!window.confirm(`Archive "${name}"? It leaves the list. Its runs and their history stay.`)) return;
    const { data, error } = await graphqlMutation<{ archiveWorkflow: { success: boolean; errors: MutationErrors } }>(ARCHIVE_WORKFLOW, { id });
    const failed = error?.message || data?.archiveWorkflow.errors[0]?.message;
    if (failed) setMessage(failed);
    else router.push('/workflows');
  };

  const selectedNode = selection?.kind === 'node' ? graph.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === 'edge' ? graph.edges.find((edge) => edge.id === selection.id) : undefined;
  const readOnly = !canManage || viewingOld;

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <Link href="/workflows" className="crumb-link">Workflows</Link>
        <span className="sep">›</span>
        <span className="crumb-current">{workflow?.name || 'Workflow'}</span>
      </div>

      {loading && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Loading the workflow…</div>}
      {message && <div role="alert" style={{ color: 'var(--red)', margin: '12px 0', whiteSpace: 'pre-wrap' }}>{message}</div>}

      {workflow && (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', margin: '12px 0', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 280, display: 'grid', gap: 6 }}>
              <input
                className="text-input"
                aria-label="Workflow name"
                value={name}
                disabled={readOnly}
                onChange={(event) => {
                  setName(event.target.value);
                  setDirty(true);
                }}
                style={{ fontSize: 18, fontWeight: 600 }}
              />
              <input
                className="text-input"
                aria-label="Description"
                placeholder="What this workflow is for"
                value={description}
                disabled={readOnly}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setDirty(true);
                }}
                style={{ fontSize: 13 }}
              />
            </div>
            <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select
                  className="text-input"
                  aria-label="Version"
                  value={workflow.version ?? workflow.latestVersion}
                  onChange={(event) => {
                    if (dirty && !window.confirm('Leave your unsaved changes?')) return;
                    load(Number(event.target.value));
                  }}
                  style={{ padding: '7px 8px', fontSize: 12 }}
                >
                  {workflow.versions.map((version) => (
                    <option key={version.version} value={version.version}>
                      Version {version.version}
                      {version.version === workflow.publishedVersion ? ' (published)' : ''} · {when(version.createdAt)}
                      {version.changeNote ? ` · ${version.changeNote}` : ''}
                    </option>
                  ))}
                </select>
                {canManage && !viewingOld && (
                  <>
                    <button type="button" className="btn" disabled={busy || !dirty} onClick={() => save()}>{dirty ? 'Save draft' : 'Saved'}</button>
                    <button type="button" className="btn" disabled={busy || problems.length > 0} onClick={tryRun} title="Runs this version without publishing it. You choose the records first.">Try it</button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy || problems.length > 0 || (!dirty && workflow.version === workflow.publishedVersion)}
                      onClick={publish}
                      title={problems.length > 0 ? 'Fix the problems first' : undefined}
                    >
                      {dirty ? 'Save and publish' : 'Publish'}
                    </button>
                  </>
                )}
                {canManage && viewingOld && (
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={publish}>Publish this version</button>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                {workflow.publishedVersion ? `New runs use version ${workflow.publishedVersion}.` : 'Not published. It cannot be run from the list or a schedule yet.'}
                {viewingOld && ' You are looking at an older version; it cannot be edited.'}
              </div>
            </div>
          </div>

          {notice && <div style={{ color: '#166534', background: '#dcfce7', padding: '8px 12px', borderRadius: 6, fontSize: 13, margin: '8px 0' }}>{notice}</div>}
          {dirty && canManage && !viewingOld && (
            <input className="text-input" placeholder="What changed in this version (optional, kept in the history)" value={note} onChange={(event) => setNote(event.target.value)} style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, margin: '4px 0 8px' }} />
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 12, alignItems: 'start' }}>
            <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
              {!readOnly && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-3)' }}>Add a step</span>
                  {ADDABLE.map((def) => (
                    <button
                      key={def.type}
                      type="button"
                      className="btn btn-sm"
                      title={def.description}
                      onClick={() => addNode(def.type)}
                      style={{ borderLeft: `4px solid ${KIND_STYLE[def.kind].color}` }}
                    >
                      {def.label}
                    </button>
                  ))}
                  <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>Drag from a step&apos;s right edge to connect it. Select and press Delete to remove.</span>
                </div>
              )}
              <WorkflowCanvas graph={graph} selection={selection} onSelect={setSelection} onChange={readOnly ? undefined : change} problemNodes={problemNodes} height={560} />

              {problems.length > 0 ? (
                <div style={{ border: '1px solid #fecaca', background: '#fef2f2', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#b91c1c' }}>
                    {problems.length} {problems.length === 1 ? 'thing' : 'things'} to fix before this can be published
                  </div>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
                    {problems.map((problem, index) => {
                      const node = problem.nodeId ? graph.nodes.find((candidate) => candidate.id === problem.nodeId) : null;
                      return (
                        <li key={`${problem.nodeId}-${index}`}>
                          {node ? (
                            <button type="button" onClick={() => setSelection({ kind: 'node', id: node.id })} style={{ border: 'none', background: 'none', padding: 0, color: 'var(--entity-link)', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                              {node.label || node.id}
                            </button>
                          ) : (
                            <strong>Workflow</strong>
                          )}
                          : {problem.message}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#166534' }}>This graph is sound and can be published.</div>
              )}
            </div>

            <aside style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 14, background: 'var(--surface)', minWidth: 0 }}>
              {selectedNode ? (
                <NodeInspector
                  graph={graph}
                  node={selectedNode}
                  tools={tools}
                  problems={problems.filter((problem) => problem.nodeId === selectedNode.id)}
                  readOnly={readOnly}
                  clientId={workflow?.clientId ?? null}
                  onChange={(next) => change({ ...graph, nodes: graph.nodes.map((node) => (node.id === next.id ? next : node)) })}
                  onDelete={() => {
                    change({ nodes: graph.nodes.filter((node) => node.id !== selectedNode.id), edges: graph.edges.filter((edge) => edge.from !== selectedNode.id && edge.to !== selectedNode.id) });
                    setSelection(null);
                  }}
                />
              ) : selectedEdge ? (
                <EdgeInspector
                  graph={graph}
                  edge={selectedEdge}
                  readOnly={readOnly}
                  onChange={(next: WorkflowEdge) => change({ ...graph, edges: graph.edges.map((edge) => (edge.id === next.id ? next : edge)) })}
                  onDelete={() => {
                    change({ ...graph, edges: graph.edges.filter((edge) => edge.id !== selectedEdge.id) });
                    setSelection(null);
                  }}
                />
              ) : (
                <div style={{ display: 'grid', gap: 12, fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 13 }}>Select a step to see its settings</div>
                  {(['fixed', 'agent', 'human'] as const).map((kind) => (
                    <div key={kind} style={{ display: 'flex', gap: 8 }}>
                      <span style={{ width: 4, borderRadius: 2, background: KIND_STYLE[kind].color, flexShrink: 0 }} />
                      <div>
                        <strong style={{ color: KIND_STYLE[kind].color }}>{KIND_STYLE[kind].label}</strong>
                        <div>
                          {kind === 'fixed' && 'Runs a tool, tests a condition, or applies approved changes. The same every run.'}
                          {kind === 'agent' && 'A model reads with the tools you give it and proposes changes. It cannot change data.'}
                          {kind === 'human' && 'The run stops until a person approves or rejects what was proposed.'}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div>Every save is a new version. A run keeps the version it started on, so its history always shows the graph it actually ran.</div>
                </div>
              )}
            </aside>
          </div>

          <div style={{ fontSize: 14, fontWeight: 600, margin: '24px 0 8px' }}>Recent runs of this workflow</div>
          {runs.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>No runs yet.</div>
          ) : (
            <div className="wf-run-grid" role="table" aria-label="Recent runs of this workflow">
              <div className="wf-run-head" role="row">
                <span role="columnheader">Status</span>
                <span role="columnheader">Version</span>
                <span role="columnheader">Started</span>
                <span role="columnheader">Result</span>
              </div>
              {runs.map((run) => {
                const status = statusOf(run.status);
                return (
                  <Link key={run.id} href={`/workflows/runs/${run.id}`} role="row">
                    <span role="cell"><span className="wf-run-status" style={{ color: status.color, background: status.tint }}>{status.label}</span></span>
                    <span role="cell">Version {run.version}</span>
                    <span className="wf-run-when" role="cell">{when(run.startedAt || run.createdAt)}</span>
                    <span className="wf-run-error" role="cell" title={run.errorMessage || undefined}>{run.errorMessage || ''}</span>
                  </Link>
                );
              })}
            </div>
          )}

          <WorkflowTriggers workflowId={id} published={workflow?.publishedVersion != null} canManage={canManage} />

          {canManage && (
            <div style={{ marginTop: 24 }}>
              <button type="button" className="btn btn-sm" style={{ color: 'var(--red)' }} onClick={archive}>Archive this workflow</button>
            </div>
          )}
        </>
      )}
    {trying !== null && (
        <StartRunDialog
          workflow={{ id, name, runSetup: graph.nodes.find((node) => node.type === 'start')?.config }}
          version={trying}
          onClose={() => setTrying(null)}
          onStarted={(runId) => router.push(`/workflows/runs/${runId}`)}
        />
      )}
    </div>
  );
}
