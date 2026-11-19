/**
 * Named agents: the standing definitions a workflow agent step can run as.
 * The queries, and the pure helpers the Agents page and the step editor use.
 */

export interface Agent {
  id: string;
  clientId: string | null;
  code: string;
  name: string;
  description: string | null;
  charter: string;
  activityCodes: string[];
  activityNames: string[];
  domainCodes: string[];
  toolNames: string[];
  isActive: boolean;
  isShared: boolean;
  canManage: boolean;
  updatedAt: string | null;
}

export const AGENT_FIELDS = `id clientId code name description charter activityCodes activityNames domainCodes toolNames isActive isShared canManage updatedAt`;

export const AGENTS_QUERY = `query Agents($clientId: ID) { agents(clientId: $clientId) { ${AGENT_FIELDS} } }`;

export const AGENTS_ADMIN_QUERY = `
  query AgentsAdmin {
    agents { ${AGENT_FIELDS} }
    responsibilityChoices { clientId activities }
    domainTypes { domainCode domainName isActive }
  }
`;

export const SAVE_AGENT = `
  mutation SaveAgent($input: SaveAgentInput!) {
    saveAgent(input: $input) { agent { ${AGENT_FIELDS} } errors { field message code } }
  }
`;

export const DELETE_AGENT = `mutation DeleteAgent($id: ID!) { deleteAgent(id: $id) { success errors { field message code } } }`;

export interface AgentDraft {
  id: string | null;
  clientId: string | null;
  code: string;
  name: string;
  description: string;
  charter: string;
  activityCodes: string[];
  domainCodes: string[];
  toolNames: string[];
  isActive: boolean;
}

export function emptyAgentDraft(clientId: string | null): AgentDraft {
  return { id: null, clientId, code: '', name: '', description: '', charter: '', activityCodes: [], domainCodes: [], toolNames: [], isActive: true };
}

/** A draft that edits an agent, or copies a shared one for a client (same code, so it takes the shared one's place there). */
export function draftFromAgent(agent: Agent, copyToClient?: string | null): AgentDraft {
  const copy = copyToClient !== undefined;
  return {
    id: copy ? null : agent.id,
    clientId: copy ? copyToClient : agent.clientId,
    code: agent.code,
    name: agent.name,
    description: agent.description || '',
    charter: agent.charter,
    activityCodes: [...agent.activityCodes],
    domainCodes: [...agent.domainCodes],
    toolNames: [...agent.toolNames],
    isActive: agent.isActive,
  };
}

/** A code from a name: "Cash matcher" becomes CASH_MATCHER. */
export function agentCodeFromName(name: string): string {
  const code = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return /^[A-Z]/.test(code) ? code : code ? `A_${code}`.slice(0, 60) : '';
}

/** Why a draft cannot be saved yet, or null when it can. */
export function agentDraftProblem(draft: AgentDraft): string | null {
  if (!draft.name.trim()) return 'Give the agent a name.';
  if (!/^[A-Z][A-Z0-9_]{1,59}$/.test(draft.code.trim().toUpperCase())) return 'The code starts with a letter and uses letters, digits, and underscores.';
  return null;
}

export function agentDraftInput(draft: AgentDraft) {
  return {
    id: draft.id,
    clientId: draft.clientId,
    code: draft.code.trim().toUpperCase(),
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    charter: draft.charter.trim(),
    activityCodes: draft.activityCodes,
    domainCodes: draft.domainCodes,
    toolNames: draft.toolNames,
    isActive: draft.isActive,
  };
}

/**
 * The agents a step in this client can run as. A client's own agent takes the
 * place of the shared one with the same code. Switched-off agents are left out
 * unless one is the step's current choice.
 */
export function agentChoices(agents: readonly Agent[], clientId: string | null, current = ''): Agent[] {
  const byCode = new Map<string, Agent>();
  for (const agent of agents) {
    if (!agent.isShared && agent.clientId !== clientId) continue;
    const seen = byCode.get(agent.code);
    if (!seen || (seen.isShared && !agent.isShared)) byCode.set(agent.code, agent);
  }
  return [...byCode.values()].filter((agent) => agent.isActive || agent.code === current).sort((a, b) => a.name.localeCompare(b.name));
}

/** What an agent is limited to, in a few words. */
export function agentScopeLabel(agent: Pick<Agent, 'domainCodes' | 'toolNames'>, isReadTool: (name: string) => boolean): string {
  const reads = agent.toolNames.filter(isReadTool).length;
  const proposes = agent.toolNames.length - reads;
  const tools = agent.toolNames.length === 0 ? 'any tool the step allows' : `${reads} read tool${reads === 1 ? '' : 's'}, ${proposes === 0 ? 'proposes nothing' : `${proposes} kind${proposes === 1 ? '' : 's'} of change`}`;
  const domains = agent.domainCodes.length === 0 ? 'any domain' : agent.domainCodes.join(', ');
  return `${tools} · ${domains}`;
}
