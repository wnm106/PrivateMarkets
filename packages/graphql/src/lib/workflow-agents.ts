/**
 * Named agents: what a workflow agent step runs as.
 *
 * An agent narrows a step. The step still lists its own tools and what it may
 * propose; the agent's tool list is applied on top, and its domain list limits
 * what it may propose changes to. An agent with an empty list places no limit
 * of that kind. Everything here is pure.
 */

import { isReadTool } from './workflow-graph';

export interface AgentDef {
  code: string;
  name: string;
  description: string;
  /** Who the agent is and how it should judge. Added to the step's system prompt. */
  charter: string;
  /** The kinds of work it does, as activity codes. */
  activityCodes: string[];
  /** The domains it may propose changes in. Empty means any. */
  domainCodes: string[];
  /** The tools it may use, reading and proposing. Empty means whatever the step allows. */
  toolNames: string[];
  isActive: boolean;
  /** Offered to every client, rather than made for this one. */
  shared: boolean;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item ?? '').trim()).filter(Boolean) : [];
}

/** An agent from its database row, or null when the row is not one. */
export function toAgentDef(row: unknown): AgentDef | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const raw = row as Record<string, unknown>;
  const code = String(raw.agent_code ?? '').trim();
  if (!code) return null;
  return {
    code,
    name: String(raw.agent_name ?? '').trim() || code,
    description: String(raw.description ?? '').trim(),
    charter: String(raw.charter ?? '').trim(),
    activityCodes: texts(raw.activity_codes).map((item) => item.toUpperCase()),
    domainCodes: texts(raw.domain_codes),
    toolNames: texts(raw.tool_names),
    isActive: raw.is_active !== false,
    shared: raw.is_shared === true || raw.client_id === null,
  };
}

/** The agent code a step names, or '' when it runs as no agent. */
export function agentCodeOf(config: Record<string, unknown>): string {
  return typeof config.agent === 'string' ? config.agent.trim().toUpperCase() : '';
}

/**
 * The tools the step may read with. A step that ticks none takes the agent's
 * read tools; a step that ticks some keeps only those the agent also has.
 */
export function agentReadTools(agent: AgentDef | null | undefined, stepTools: readonly string[]): string[] {
  const step = stepTools.filter(isReadTool);
  if (!agent || agent.toolNames.length === 0) return step;
  const own = agent.toolNames.filter(isReadTool);
  if (step.length === 0) return own;
  const allowed = new Set(own);
  return step.filter((name) => allowed.has(name));
}

/**
 * The tools the step may propose changes with, out of every tool that changes
 * data. A step that ticks none allows any; the agent's list then narrows it.
 * An agent whose list holds only read tools proposes nothing.
 */
export function agentProposable(agent: AgentDef | null | undefined, stepProposable: readonly string[], writeTools: readonly string[]): string[] {
  const step = stepProposable.length === 0 ? [...writeTools] : writeTools.filter((name) => stepProposable.includes(name));
  if (!agent || agent.toolNames.length === 0) return step;
  const allowed = new Set(agent.toolNames);
  return step.filter((name) => allowed.has(name));
}

/** The part of the system prompt that says who the agent is. Empty for no agent. */
export function agentCharter(agent: AgentDef | null | undefined): string {
  if (!agent) return '';
  const lines = [`## Who you are\nYou are ${agent.name}${agent.description ? `. ${agent.description}` : '.'}`];
  if (agent.charter) lines.push(agent.charter);
  if (agent.domainCodes.length > 0) {
    lines.push(`You work on these kinds of record only: ${agent.domainCodes.join(', ')}. A change to any other kind will be refused, so describe it in your summary for someone else to take up.`);
  }
  return lines.join('\n\n');
}

/**
 * Why the agent may not propose this change, or null when it may. Only a
 * change that says which domain it touches can be checked: a change to an
 * existing record that names no domain is let through to the reviewer.
 */
export function outsideAgentDomains(
  agent: AgentDef | null | undefined,
  item: { summary: string; target: { domainCode?: string }; args: Record<string, unknown> },
): string | null {
  if (!agent || agent.domainCodes.length === 0) return null;
  const named = item.target.domainCode || (typeof item.args.domainCode === 'string' ? item.args.domainCode : '');
  const domain = named.trim();
  if (!domain) return null;
  if (agent.domainCodes.some((code) => code.toUpperCase() === domain.toUpperCase())) return null;
  return `"${item.summary}" changes a ${domain} record. ${agent.name} works on ${agent.domainCodes.join(', ')} only. Leave it out and mention it in your summary.`;
}

/**
 * The activity a review of this agent's proposals is routed by, when the
 * review step names none. Only an agent with one activity has a clear answer;
 * otherwise whoever is responsible for the records is asked, whatever for.
 */
export function agentReviewActivity(agent: Pick<AgentDef, 'activityCodes'> | null | undefined): string | null {
  return agent && agent.activityCodes.length === 1 ? agent.activityCodes[0] : null;
}
