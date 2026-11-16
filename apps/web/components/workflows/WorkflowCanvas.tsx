'use client';

import { useCallback, useEffect, useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeTypeDef, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from '@tapestrai/graphql/src/lib/workflow-graph';
import { KIND_STYLE, kindOf, statusOf } from '@/lib/workflows';

/**
 * The workflow drawn as a graph. The same canvas edits a workflow and shows a
 * run: in a run each step carries its status and the path taken is highlighted.
 */

export type CanvasSelection = { kind: 'node' | 'edge'; id: string } | null;

interface StepMark {
  status: string;
  outcome: string | null;
}

interface StepData extends Record<string, unknown> {
  node: WorkflowNode;
  mark: StepMark | null;
  current: boolean;
  problem: boolean;
  /** True in a run: steps the run has not reached are faded. */
  dim: boolean;
}

function StepNode({ data, selected }: NodeProps<Node<StepData>>) {
  const { node, mark, current, problem } = data;
  const kind = kindOf(node);
  const status = mark ? statusOf(mark.status) : null;
  const def = nodeTypeDef(node.type);
  const terminal = node.type === 'start' || node.type === 'end';
  return (
    <div
      style={{
        minWidth: terminal ? 96 : 190,
        maxWidth: 230,
        background: '#fff',
        border: `1.5px solid ${selected ? kind.color : problem ? '#b91c1c' : '#cbd5e1'}`,
        borderLeft: `5px solid ${kind.color}`,
        borderRadius: 8,
        boxShadow: selected ? `0 0 0 3px ${kind.tint}` : current ? '0 0 0 3px rgba(14,116,144,0.25)' : '0 1px 2px rgba(15,23,42,0.08)',
        opacity: data.dim && !mark ? 0.55 : 1,
        padding: '8px 10px',
        fontSize: 12,
      }}
    >
      {node.type !== 'start' && <Handle type="target" position={Position.Left} style={{ background: '#64748b', width: 8, height: 8 }} />}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: kind.color, background: kind.tint, padding: '1px 6px', borderRadius: 999, letterSpacing: 0.2 }}>
          {terminal ? def?.label : kind.label}
        </span>
        {status && (
          <span style={{ fontSize: 10, fontWeight: 600, color: status.color, background: status.tint, padding: '1px 6px', borderRadius: 999 }}>
            {mark?.status === 'WAITING' ? 'Waiting' : status.label}
          </span>
        )}
        {problem && !status && <span title="This step has a problem" style={{ color: '#b91c1c', fontWeight: 700 }}>!</span>}
      </div>
      {!terminal && (
        <>
          <div style={{ fontWeight: 600, color: '#0f172a', marginTop: 5, lineHeight: 1.25 }}>{node.label || 'Unnamed step'}</div>
          <div style={{ color: '#64748b', marginTop: 2, fontSize: 11 }}>
            {node.type === 'tool' ? String(node.config.tool || 'No tool chosen') : def?.label}
            {mark?.outcome ? ` · ${mark.outcome}` : ''}
          </div>
        </>
      )}
      {node.type !== 'end' && <Handle type="source" position={Position.Right} style={{ background: '#64748b', width: 8, height: 8 }} />}
    </div>
  );
}

const NODE_TYPES = { step: StepNode };

interface Props {
  graph: WorkflowGraph;
  selection: CanvasSelection;
  onSelect(selection: CanvasSelection): void;
  /** Omit for a read-only canvas. */
  onChange?(graph: WorkflowGraph): void;
  steps?: Record<string, StepMark>;
  currentNode?: string | null;
  problemNodes?: ReadonlySet<string>;
  height?: number | string;
}

export function WorkflowCanvas({ graph, selection, onSelect, onChange, steps, currentNode, problemNodes, height = 520 }: Props) {
  const editable = Boolean(onChange);
  const inRun = Boolean(steps);

  const flowNodes = useMemo<Node<StepData>[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: 'step',
        position: node.position,
        selected: selection?.kind === 'node' && selection.id === node.id,
        deletable: editable && node.type !== 'start',
        data: { node, mark: steps?.[node.id] || null, current: currentNode === node.id, problem: Boolean(problemNodes?.has(node.id)), dim: inRun },
      })),
    [graph.nodes, selection, steps, currentNode, problemNodes, editable, inRun],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        // In a run, an edge was taken when its source finished with this edge's outcome and its target was reached.
        const from = steps?.[edge.from];
        const taken = Boolean(from && steps?.[edge.to] && (!edge.when || from.outcome === edge.when));
        const selected = selection?.kind === 'edge' && selection.id === edge.id;
        const color = selected ? '#0e7490' : taken ? '#0e7490' : '#94a3b8';
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          label: edge.when,
          selected,
          animated: inRun && taken && steps?.[edge.to]?.status === 'RUNNING',
          markerEnd: { type: MarkerType.ArrowClosed, color },
          style: { stroke: color, strokeWidth: taken || selected ? 2 : 1.5, opacity: inRun && !taken ? 0.45 : 1 },
          labelStyle: { fontSize: 11, fontWeight: 600, fill: '#334155' },
          labelBgStyle: { fill: '#fff' },
          labelBgPadding: [4, 2] as [number, number],
        };
      }),
    [graph.edges, selection, steps, inRun],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);
  useEffect(() => setNodes(flowNodes), [flowNodes, setNodes]);
  useEffect(() => setEdges(flowEdges), [flowEdges, setEdges]);

  const connect = useCallback(
    (connection: Connection) => {
      if (!onChange || !connection.source || !connection.target || connection.source === connection.target) return;
      if (graph.edges.some((edge) => edge.from === connection.source && edge.to === connection.target)) return;
      const source = graph.nodes.find((node) => node.id === connection.source);
      // A step with named outcomes gets the first outcome that has no path yet.
      const outcomes = source ? nodeTypeDef(source.type)?.outcomes || [] : [];
      const used = new Set(graph.edges.filter((edge) => edge.from === connection.source).map((edge) => edge.when));
      const whenValue = outcomes.find((outcome) => !used.has(outcome));
      const ids = new Set(graph.edges.map((edge) => edge.id));
      let id = `e${graph.edges.length + 1}`;
      for (let index = graph.edges.length + 2; ids.has(id); index += 1) id = `e${index}`;
      const edge: WorkflowEdge = { id, from: connection.source, to: connection.target, ...(whenValue ? { when: whenValue } : {}) };
      onChange({ ...graph, edges: [...graph.edges, edge] });
      onSelect({ kind: 'edge', id });
    },
    [graph, onChange, onSelect],
  );

  return (
    <div style={{ height, border: '1px solid var(--line)', borderRadius: 8, background: '#f8fafc', position: 'relative', overflow: 'hidden' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        onNodeClick={(_, node) => onSelect({ kind: 'node', id: node.id })}
        onEdgeClick={(_, edge) => onSelect({ kind: 'edge', id: edge.id })}
        onPaneClick={() => onSelect(null)}
        onNodeDragStop={(_, moved) => {
          if (!onChange) return;
          onChange({ ...graph, nodes: graph.nodes.map((node) => (node.id === moved.id ? { ...node, position: { x: Math.round(moved.position.x), y: Math.round(moved.position.y) } } : node)) });
        }}
        onNodesDelete={(removed) => {
          if (!onChange) return;
          const gone = new Set(removed.map((node) => node.id));
          onChange({ nodes: graph.nodes.filter((node) => !gone.has(node.id)), edges: graph.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to)) });
          onSelect(null);
        }}
        onEdgesDelete={(removed) => {
          if (!onChange) return;
          const gone = new Set(removed.map((edge) => edge.id));
          onChange({ ...graph, edges: graph.edges.filter((edge) => !gone.has(edge.id)) });
          onSelect(null);
        }}
        nodesDraggable={editable}
        nodesConnectable={editable}
        edgesFocusable={editable}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.3}
        zoomOnScroll={false}
        preventScrolling={false}
      >
        <Background gap={20} color="#e2e8f0" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 6, background: 'rgba(255,255,255,0.92)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 8px', fontSize: 11 }}>
        {(['fixed', 'agent', 'human'] as const).map((kind) => (
          <span key={kind} title={KIND_STYLE[kind].hint} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#334155' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: KIND_STYLE[kind].color }} />
            {KIND_STYLE[kind].label}
          </span>
        ))}
      </div>
    </div>
  );
}
