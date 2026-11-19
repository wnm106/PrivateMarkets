'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isReadTool } from '@tapestrai/graphql/src/lib/workflow-graph';
import { usePublishViewContext } from '@/lib/view-context';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { authHeaders } from '@/lib/reporting';
import type { ToolOption } from '@/lib/workflows';
import {
  AGENTS_ADMIN_QUERY,
  DELETE_AGENT,
  SAVE_AGENT,
  agentCodeFromName,
  agentDraftInput,
  agentDraftProblem,
  agentScopeLabel,
  draftFromAgent,
  emptyAgentDraft,
  type Agent,
  type AgentDraft,
} from '@/lib/agents';

/**
 * Named agents: what a workflow agent step can run as. An agent narrows a
 * step's tools and the domains it may propose changes in. It still only
 * proposes; a person decides.
 */

interface ActivityOption {
  code: string;
  name: string;
  description?: string | null;
}

interface DomainOption {
  domainCode: string;
  domainName: string;
  isActive: boolean;
}

interface MutationError {
  field: string | null;
  message: string;
  code: string;
}

interface AdminData {
  agents: Agent[];
  responsibilityChoices: { clientId: string | null; activities: ActivityOption[] };
  domainTypes: DomainOption[];
}

function toggle(list: string[], value: string, on: boolean): string[] {
  return on ? (list.includes(value) ? list : [...list, value]) : list.filter((item) => item !== value);
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activities, setActivities] = useState<ActivityOption[]>([]);
  const [domains, setDomains] = useState<DomainOption[]>([]);
  const [clientId, setClientId] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [codeTouched, setCodeTouched] = useState(false);
  const [toolFilter, setToolFilter] = useState('');
  const [saving, setSaving] = useState(false);

  usePublishViewContext({ activity: 'viewing', kind: 'agents', label: 'Agents', summary: 'The named agents workflow steps can run as' });

  const load = useCallback(async () => {
    const result = await graphqlQuery<AdminData>(AGENTS_ADMIN_QUERY, undefined, 'network-only');
    if (result.error) setMessage(result.error.message || 'Agents could not be loaded.');
    else if (result.data) {
      setAgents(result.data.agents);
      setActivities(result.data.responsibilityChoices.activities || []);
      setClientId(result.data.responsibilityChoices.clientId);
      setDomains(result.data.domainTypes.filter((domain) => domain.isActive).sort((a, b) => a.domainName.localeCompare(b.domainName)));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetch('/api/workflows/tools', { headers: authHeaders() })
      .then((response) => (response.ok ? response.json() : { tools: [] }))
      .then((data: { tools?: ToolOption[] }) => setTools(data.tools || []))
      .catch(() => setTools([]));
  }, []);

  const problem = draft ? agentDraftProblem(draft) : null;
  const shownTools = useMemo(() => {
    const text = toolFilter.trim().toLowerCase();
    return tools.filter((tool) => !text || tool.name.includes(text) || tool.description.toLowerCase().includes(text));
  }, [tools, toolFilter]);
  // A client's own agent takes the place of the shared one with the same code.
  const replaced = useMemo(() => new Set(agents.filter((agent) => !agent.isShared).map((agent) => `${agent.clientId}:${agent.code}`)), [agents]);
  const canCreate = Boolean(clientId) || agents.some((agent) => agent.isShared && agent.canManage);

  function start(next: AgentDraft, touched: boolean) {
    setMessage('');
    setToolFilter('');
    setCodeTouched(touched);
    setDraft(next);
  }

  function patch(change: Partial<AgentDraft>) {
    setDraft((current) => (current ? { ...current, ...change } : current));
  }

  async function save() {
    if (!draft || problem) return;
    setSaving(true);
    setMessage('');
    const result = await graphqlMutation<{ saveAgent: { agent: Agent | null; errors: MutationError[] } }>(SAVE_AGENT, { input: agentDraftInput(draft) });
    setSaving(false);
    const errors = result.data?.saveAgent.errors || [];
    if (result.error || errors.length > 0) {
      setMessage(errors[0]?.message || result.error?.message || 'The agent could not be saved.');
      return;
    }
    setDraft(null);
    await load();
  }

  async function remove(agent: Agent) {
    const after = agent.isShared
      ? 'Steps that run as it will fail until they name another agent.'
      : 'Steps that run as it will use the shared agent with the same code, or fail if there is none.';
    if (!window.confirm(`Delete the agent "${agent.name}"? ${after}`)) return;
    setMessage('');
    const result = await graphqlMutation<{ deleteAgent: { success: boolean; errors: MutationError[] } }>(DELETE_AGENT, { id: agent.id });
    const errors = result.data?.deleteAgent.errors || [];
    if (result.error || errors.length > 0) setMessage(errors[0]?.message || result.error?.message || 'The agent could not be deleted.');
    await load();
  }

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Agents</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: 'var(--accent)' }}></div>
          <div>
            <div className="page-title">Agents</div>
            <div className="page-meta">
              What a workflow&rsquo;s agent step can run as. An agent has a charter, the kinds of work it does, the domains it may propose changes in, and
              the tools it may use. It narrows a step and never widens it, and it still only proposes: a person approves every change.
            </div>
          </div>
        </div>
        {canCreate && (
          <button type="button" className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => start(emptyAgentDraft(clientId), false)}>
            New agent
          </button>
        )}
      </div>

      {message && <div role="alert" style={{ color: 'var(--danger, #9b2c2c)', margin: '12px 0' }}>{message}</div>}

      {draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          style={{ margin: '16px 0', padding: 16, border: '1px solid var(--line, #e5e5e5)', borderRadius: 8, display: 'grid', gap: 12, maxWidth: 860 }}
        >
          <div style={{ fontWeight: 600 }}>
            {draft.id ? 'Edit agent' : 'New agent'}
            <span style={{ ...hint, fontWeight: 400 }}> · {draft.clientId ? 'for this client' : 'shared by every client'}</span>
          </div>

          <div style={formRow}>
            <label style={field}>
              <span style={fieldLabel}>Name</span>
              <input
                className="text-input"
                value={draft.name}
                onChange={(event) => patch(codeTouched || draft.id ? { name: event.target.value } : { name: event.target.value, code: agentCodeFromName(event.target.value) })}
              />
            </label>
            <label style={field}>
              <span style={fieldLabel}>Code</span>
              <input
                className="text-input"
                value={draft.code}
                onChange={(event) => {
                  setCodeTouched(true);
                  patch({ code: event.target.value.toUpperCase() });
                }}
              />
              <span style={hint}>Steps name the agent by this. Use a shared agent&rsquo;s code to take its place for this client.</span>
            </label>
          </div>

          <label style={field}>
            <span style={fieldLabel}>What it does</span>
            <input className="text-input" value={draft.description} onChange={(event) => patch({ description: event.target.value })} />
          </label>

          <label style={field}>
            <span style={fieldLabel}>Charter</span>
            <textarea className="text-input" rows={6} style={{ fontSize: 13, lineHeight: 1.45 }} value={draft.charter} onChange={(event) => patch({ charter: event.target.value })} />
            <span style={hint}>Who the agent is and how it should judge. Added to every step it runs, ahead of the step&rsquo;s own instructions.</span>
          </label>

          <div style={field}>
            <span style={fieldLabel}>Kinds of work</span>
            <div style={chips}>
              {activities.map((activity) => (
                <label key={activity.code} style={check} title={activity.description || ''}>
                  <input type="checkbox" checked={draft.activityCodes.includes(activity.code)} onChange={(event) => patch({ activityCodes: toggle(draft.activityCodes, activity.code, event.target.checked) })} />
                  <span>{activity.name}</span>
                </label>
              ))}
            </div>
            <span style={hint}>With exactly one ticked, a review of this agent&rsquo;s proposals goes to the people responsible for that activity.</span>
          </div>

          <div style={field}>
            <span style={fieldLabel}>Domains it may propose changes in</span>
            <div style={{ ...chips, maxHeight: 130, overflowY: 'auto' }}>
              {domains.map((domain) => (
                <label key={domain.domainCode} style={check}>
                  <input type="checkbox" checked={draft.domainCodes.includes(domain.domainCode)} onChange={(event) => patch({ domainCodes: toggle(draft.domainCodes, domain.domainCode, event.target.checked) })} />
                  <span>{domain.domainName}</span>
                </label>
              ))}
            </div>
            <span style={hint}>Tick none for any domain. This limits what it proposes, not what it can read.</span>
          </div>

          <div style={field}>
            <span style={fieldLabel}>Tools</span>
            <div style={{ border: '1px solid var(--line, #e5e5e5)', borderRadius: 6 }}>
              <input
                className="text-input"
                placeholder="Filter tools"
                value={toolFilter}
                onChange={(event) => setToolFilter(event.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: '1px solid var(--line, #e5e5e5)', padding: '6px 8px', fontSize: 12 }}
              />
              <div style={{ maxHeight: 220, overflowY: 'auto', padding: '4px 8px' }}>
                {shownTools.length === 0 && <div style={hint}>{tools.length === 0 ? 'The tool list could not be loaded.' : 'No tool matches.'}</div>}
                {shownTools.map((tool) => (
                  <label key={tool.name} title={tool.description} style={{ ...check, fontSize: 12, padding: '2px 0' }}>
                    <input type="checkbox" checked={draft.toolNames.includes(tool.name)} onChange={(event) => patch({ toolNames: toggle(draft.toolNames, tool.name, event.target.checked) })} />
                    <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{tool.name}</span>
                    <span style={hint}>{tool.readOnly ? 'reads' : 'proposes a change'}</span>
                  </label>
                ))}
              </div>
              <div style={{ ...hint, padding: '4px 8px', borderTop: '1px solid var(--line, #e5e5e5)' }}>
                {draft.toolNames.length === 0 ? 'None ticked: the agent may use whatever a step allows.' : `${draft.toolNames.length} ticked. The agent may use only these.`}
              </div>
            </div>
          </div>

          <label style={check}>
            <input type="checkbox" checked={draft.isActive} onChange={(event) => patch({ isActive: event.target.checked })} />
            <span>Switched on. A step that runs as a switched-off agent fails and says so.</span>
          </label>

          {problem && <div style={hint}>{problem}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={saving || Boolean(problem)}>{saving ? 'Saving…' : 'Save agent'}</button>
            <button type="button" className="btn" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
          </div>
        </form>
      )}

      {loading && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Loading agents…</div>}
      {!loading && agents.length === 0 && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>There are no agents yet.</div>}

      {agents.length > 0 && (
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell}>Agent</th>
              <th style={cell}>Kinds of work</th>
              <th style={cell}>Limited to</th>
              <th style={cell} />
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const hidden = agent.isShared && Boolean(clientId) && replaced.has(`${clientId}:${agent.code}`);
              return (
                <tr key={agent.id} style={{ ...bodyRow, opacity: agent.isActive && !hidden ? 1 : 0.6 }}>
                  <td style={cell}>
                    <div style={{ fontWeight: 500 }}>{agent.name}</div>
                    <div style={hint}>
                      {agent.code} · {agent.isShared ? 'shared' : 'this client'}
                      {!agent.isActive && ' · switched off'}
                      {hidden && ' · replaced by this client’s own'}
                    </div>
                    {agent.description && <div style={{ marginTop: 4, color: 'var(--ink-2)' }}>{agent.description}</div>}
                  </td>
                  <td style={cell}>{agent.activityNames.length > 0 ? agent.activityNames.join(', ') : <span style={hint}>None named</span>}</td>
                  <td style={cell}>{agentScopeLabel(agent, isReadTool)}</td>
                  <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {agent.canManage && <button type="button" className="btn" onClick={() => start(draftFromAgent(agent), true)}>Edit</button>}{' '}
                    {agent.isShared && clientId && !hidden && (
                      <button type="button" className="btn" onClick={() => start(draftFromAgent(agent, clientId), true)}>Copy for this client</button>
                    )}{' '}
                    {agent.canManage && <button type="button" className="btn" onClick={() => remove(agent)}>Delete</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const cell: React.CSSProperties = { padding: '8px 8px', verticalAlign: 'top' };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const headRow: React.CSSProperties = { textAlign: 'left', color: 'var(--ink-3)', fontSize: 11, textTransform: 'uppercase' };
const bodyRow: React.CSSProperties = { borderTop: '1px solid var(--line, #e5e5e5)' };
const hint: React.CSSProperties = { color: 'var(--ink-3)', fontSize: 12 };
const formRow: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 };
const field: React.CSSProperties = { display: 'grid', gap: 4 };
const fieldLabel: React.CSSProperties = { fontSize: 12, color: 'var(--ink-2)' };
const check: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 };
const chips: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '6px 16px' };
