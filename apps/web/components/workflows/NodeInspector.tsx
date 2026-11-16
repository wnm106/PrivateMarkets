'use client';

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { CONDITION_OPS, nodeTypeDef, upstreamOf, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from '@tapestrai/graphql/src/lib/workflow-graph';
import { kindOf, parseObject, type ToolOption, type WorkflowProblem } from '@/lib/workflows';

/** The settings for the step or connection selected on the canvas. */

const label: CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--ink-3)' };
const hint: CSSProperties = { fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.4 };
const full: CSSProperties = { width: '100%', boxSizing: 'border-box' };

function Field({ name, help, children }: { name: string; help?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={label}>{name}</span>
      {children}
      {help && <span style={hint}>{help}</span>}
    </label>
  );
}

const OP_LABEL: Record<string, string> = {
  truthy: 'has a value',
  empty: 'is empty',
  eq: 'equals',
  ne: 'does not equal',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
};

/** A JSON box that keeps what was typed until it parses, so a half-typed object is not thrown away. */
function JsonField({ value, onChange, rows = 5 }: { value: unknown; onChange(value: Record<string, unknown>): void; rows?: number }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState('');
  const serialized = JSON.stringify(value ?? {});
  useEffect(() => {
    const parsed = parseObject(text, 'This');
    if (!parsed.ok || JSON.stringify(parsed.value) !== serialized) setText(JSON.stringify(JSON.parse(serialized), null, 2));
    // Only an outside change to the value resets the box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);
  return (
    <>
      <textarea
        className="text-input"
        rows={rows}
        value={text}
        spellCheck={false}
        style={{ ...full, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
        onChange={(event) => {
          setText(event.target.value);
          const parsed = parseObject(event.target.value, 'The settings');
          setError(parsed.ok ? '' : parsed.message);
          if (parsed.ok) onChange(parsed.value);
        }}
      />
      {error && <span style={{ ...hint, color: 'var(--red)' }}>{error}</span>}
    </>
  );
}

function ToolChecklist({ options, chosen, onChange, empty }: { options: ToolOption[]; chosen: string[]; onChange(next: string[]): void; empty: string }) {
  const [filter, setFilter] = useState('');
  const shown = options.filter((tool) => !filter || tool.name.includes(filter.toLowerCase()) || tool.description.toLowerCase().includes(filter.toLowerCase()));
  const set = new Set(chosen);
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 6 }}>
      <input className="text-input" placeholder="Filter tools" value={filter} onChange={(event) => setFilter(event.target.value)} style={{ ...full, border: 'none', borderBottom: '1px solid var(--line)', padding: '6px 8px', fontSize: 12 }} />
      <div style={{ maxHeight: 170, overflowY: 'auto', padding: '4px 8px' }}>
        {shown.length === 0 && <div style={hint}>{options.length === 0 ? empty : 'No tool matches.'}</div>}
        {shown.map((tool) => (
          <label key={tool.name} title={tool.description} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, padding: '2px 0', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={set.has(tool.name)}
              onChange={(event) => onChange(event.target.checked ? [...chosen, tool.name] : chosen.filter((name) => name !== tool.name))}
            />
            <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{tool.name}</span>
          </label>
        ))}
      </div>
      <div style={{ ...hint, padding: '4px 8px', borderTop: '1px solid var(--line)' }}>{chosen.length} chosen</div>
    </div>
  );
}

interface NodeProps {
  graph: WorkflowGraph;
  node: WorkflowNode;
  tools: ToolOption[];
  problems: WorkflowProblem[];
  readOnly: boolean;
  onChange(node: WorkflowNode): void;
  onDelete(): void;
}

export function NodeInspector({ graph, node, tools, problems, readOnly, onChange, onDelete }: NodeProps) {
  const def = nodeTypeDef(node.type);
  const kind = kindOf(node);
  const config = node.config;
  const set = (patch: Record<string, unknown>) => onChange({ ...node, config: { ...config, ...patch } });
  const upstream = useMemo(() => upstreamOf(graph, node.id), [graph, node.id]);
  const before = graph.nodes.filter((candidate) => upstream.has(candidate.id));
  const tool = tools.find((candidate) => candidate.name === config.tool);
  const readTools = tools.filter((candidate) => candidate.readOnly);
  const writeTools = tools.filter((candidate) => !candidate.readOnly);
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

  return (
    <fieldset disabled={readOnly} style={{ border: 'none', padding: 0, margin: 0, display: 'grid', gap: 12, minWidth: 0 }}>
      <div>
        <span style={{ fontSize: 10, fontWeight: 700, color: kind.color, background: kind.tint, padding: '1px 6px', borderRadius: 999 }}>{kind.label} step</span>
        <div style={{ fontWeight: 600, marginTop: 6 }}>{def?.label}</div>
        <div style={hint}>{def?.description}</div>
      </div>

      {problems.length > 0 && (
        <div role="alert" style={{ background: 'var(--badge-bad-bg)', color: 'var(--badge-bad-fg)', borderRadius: 6, padding: '6px 8px', fontSize: 12, display: 'grid', gap: 2 }}>
          {problems.map((problem) => (
            <div key={problem.message}>{problem.message}</div>
          ))}
        </div>
      )}

      <Field name="Name">
        <input className="text-input" style={full} value={node.label} onChange={(event) => onChange({ ...node, label: event.target.value })} />
      </Field>
      {node.type !== 'start' && node.type !== 'end' && (
        <div style={hint}>
          Later steps read this step&apos;s result as <code>{`{{steps.${node.id}.…}}`}</code>
        </div>
      )}

      {node.type === 'start' && <div style={hint}>The run&apos;s input is available to every step as <code>{'{{input.…}}'}</code>.</div>}

      {node.type === 'tool' && (
        <>
          <Field name="Tool" help={tool?.description}>
            <select className="text-input" style={full} value={String(config.tool || '')} onChange={(event) => set({ tool: event.target.value })}>
              <option value="">Choose a tool</option>
              <optgroup label="Reads">
                {readTools.map((option) => (
                  <option key={option.name} value={option.name}>{option.name}</option>
                ))}
              </optgroup>
              <optgroup label="Changes data">
                {writeTools.map((option) => (
                  <option key={option.name} value={option.name}>{option.name}</option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field name="Settings" help={tool && tool.args.length > 0 ? `Accepts: ${tool.args.map((arg) => `${arg.name}${arg.required ? '*' : ''}`).join(', ')}. Use {{input.name}} or {{steps.id.field}} for values from the run.` : undefined}>
            <JsonField value={config.args} onChange={(args) => set({ args })} />
          </Field>
          {tool && !tool.readOnly && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, background: 'var(--badge-warn-bg)', color: 'var(--badge-warn-fg)', padding: 8, borderRadius: 6 }}>
              <input type="checkbox" checked={config.allowWrite === true} onChange={(event) => set({ allowWrite: event.target.checked })} />
              <span>This step may change data. It runs without a review. The person who starts the run must be allowed to edit records.</span>
            </label>
          )}
        </>
      )}

      {node.type === 'agent' && (
        <>
          <Field name="Instructions" help="What the agent should achieve and how to judge it. It sees the run's input and every earlier step's result.">
            <textarea className="text-input" rows={9} style={{ ...full, fontSize: 12, lineHeight: 1.45 }} value={String(config.instructions || '')} onChange={(event) => set({ instructions: event.target.value })} />
          </Field>
          <Field name="Tools it can read with">
            <ToolChecklist options={readTools} chosen={list(config.tools)} onChange={(next) => set({ tools: next })} empty="The tool list could not be loaded." />
          </Field>
          <Field name="Changes it can propose" help="The agent never makes these itself. Each one it proposes goes to a review step. Leave all unticked to allow any.">
            <ToolChecklist options={writeTools} chosen={list(config.proposable)} onChange={(next) => set({ proposable: next })} empty="The tool list could not be loaded." />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field name="Model">
              <select className="text-input" style={full} value={String(config.provider || 'claude')} onChange={(event) => set({ provider: event.target.value })}>
                <option value="claude">Claude</option>
                <option value="gemini">Gemini</option>
              </select>
            </Field>
            <Field name="Most tool rounds">
              <input className="text-input" type="number" min={1} max={60} style={full} value={Number(config.maxRounds) || 24} onChange={(event) => set({ maxRounds: Number(event.target.value) })} />
            </Field>
          </div>
        </>
      )}

      {node.type === 'review' && (
        <>
          <Field name="Reviews the proposal from" help="An agent step that runs before this one.">
            <select className="text-input" style={full} value={String(config.source || '')} onChange={(event) => set({ source: event.target.value })}>
              <option value="">Choose an agent step</option>
              {before.filter((candidate) => candidate.type === 'agent').map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
              ))}
            </select>
          </Field>
          <Field name="Title shown to the reviewer">
            <input className="text-input" style={full} value={String(config.title || '')} onChange={(event) => set({ title: event.target.value })} />
          </Field>
          <Field name="Guidance for the reviewer">
            <textarea className="text-input" rows={3} style={{ ...full, fontSize: 12 }} value={String(config.instructions || '')} onChange={(event) => set({ instructions: event.target.value })} />
          </Field>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={config.skipWhenEmpty !== false} onChange={(event) => set({ skipWhenEmpty: event.target.checked })} />
            Skip the review when nothing was proposed
          </label>
        </>
      )}

      {node.type === 'apply' && (
        <Field name="Applies what was approved in" help="Each approved change is made by the workflow service account and signed with the approver's name. The approver must be allowed to edit records.">
          <select className="text-input" style={full} value={String(config.review || '')} onChange={(event) => set({ review: event.target.value })}>
            <option value="">Choose a review step</option>
            {before.filter((candidate) => candidate.type === 'review').map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
            ))}
          </select>
        </Field>
      )}

      {node.type === 'branch' && (
        <>
          <Field name="Value to test" help="For example steps.scan.totalCount or input.domainCode.">
            <input className="text-input" style={{ ...full, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }} value={String(config.path || '')} onChange={(event) => set({ path: event.target.value })} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field name="Test">
              <select className="text-input" style={full} value={String(config.op || 'truthy')} onChange={(event) => set({ op: event.target.value })}>
                {CONDITION_OPS.map((op) => (
                  <option key={op} value={op}>{OP_LABEL[op]}</option>
                ))}
              </select>
            </Field>
            {config.op !== 'truthy' && config.op !== 'empty' && (
              <Field name="Against">
                <input className="text-input" style={full} value={config.value == null ? '' : String(config.value)} onChange={(event) => set({ value: event.target.value })} />
              </Field>
            )}
          </div>
        </>
      )}

      {!readOnly && node.type !== 'start' && (
        <button type="button" className="btn btn-sm" style={{ justifySelf: 'start', color: 'var(--red)' }} onClick={onDelete}>
          Delete step
        </button>
      )}
    </fieldset>
  );
}

interface EdgeProps {
  graph: WorkflowGraph;
  edge: WorkflowEdge;
  readOnly: boolean;
  onChange(edge: WorkflowEdge): void;
  onDelete(): void;
}

export function EdgeInspector({ graph, edge, readOnly, onChange, onDelete }: EdgeProps) {
  const from = graph.nodes.find((node) => node.id === edge.from);
  const to = graph.nodes.find((node) => node.id === edge.to);
  const outcomes = from ? nodeTypeDef(from.type)?.outcomes || [] : [];
  return (
    <fieldset disabled={readOnly} style={{ border: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
      <div>
        <div style={{ fontWeight: 600 }}>Connection</div>
        <div style={hint}>
          From “{from?.label}” to “{to?.label}”.
        </div>
      </div>
      {outcomes.length > 0 ? (
        <Field name="Followed when the outcome is">
          <select
            className="text-input"
            style={full}
            value={edge.when || ''}
            onChange={(event) => {
              const { when: _dropped, ...rest } = edge;
              onChange(event.target.value ? { ...rest, when: event.target.value } : rest);
            }}
          >
            <option value="">anything</option>
            {outcomes.map((outcome) => (
              <option key={outcome} value={outcome}>{outcome}</option>
            ))}
          </select>
        </Field>
      ) : (
        <div style={hint}>This step has one outcome, so this connection is always followed.</div>
      )}
      {!readOnly && (
        <button type="button" className="btn btn-sm" style={{ justifySelf: 'start', color: 'var(--red)' }} onClick={onDelete}>
          Delete connection
        </button>
      )}
    </fieldset>
  );
}
