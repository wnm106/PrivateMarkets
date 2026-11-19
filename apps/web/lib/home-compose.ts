/**
 * The home page composer: one box that either asks the assistant now or hands
 * the request to a workflow that runs in the background. Everything here is pure.
 */

import { parseRunSetup } from '@tapestrai/graphql/src/lib/workflow-filters';
import type { HomeSummary } from './home';

export interface ComposeWorkflow {
  id: string;
  name: string;
  description?: string | null;
  publishedVersion: number | null;
  runSetup?: unknown;
}

export const COMPOSE_WORKFLOWS_QUERY = `query HomeComposeWorkflows { workflows { id name description publishedVersion runSetup } }`;

/** Where a request goes. */
export interface ComposeTarget {
  /** 'assistant', or 'workflow:<id>'. */
  key: string;
  label: string;
  hint: string;
}

export const ASSISTANT_TARGET: ComposeTarget = {
  key: 'assistant',
  label: 'Assistant',
  hint: 'Answers now, in the assistant panel.',
};

/**
 * The workflows a typed request can be handed to: published, and able to start
 * without records being chosen first. The request reaches the workflow as its
 * `request` input, which every agent step is shown. The rest are started from
 * the Workflows page, where their records are picked.
 */
export function composeTargets(workflows: readonly ComposeWorkflow[]): ComposeTarget[] {
  const handoff = workflows
    .filter((workflow) => workflow.publishedVersion != null && !parseRunSetup(workflow.runSetup).requiresRecords)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((workflow) => ({
      key: `workflow:${workflow.id}`,
      label: workflow.name,
      hint: 'Runs in the background. Its answer appears under Agents at work, and any changes it proposes come back for your decision.',
    }));
  return [ASSISTANT_TARGET, ...handoff];
}

/** The workflow id of a target, or null for the assistant. */
export function targetWorkflowId(key: string): string | null {
  return key.startsWith('workflow:') ? key.slice('workflow:'.length) || null : null;
}

/** What a run handed off from the composer starts with. */
export function handoffInput(text: string): { request: string } {
  return { request: text.trim() };
}

/** Why the box cannot be sent yet, or null when it can. */
export function composeProblem(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return 'Type a question or a task.';
  if (trimmed.length > 4000) return 'Keep it under 4,000 characters.';
  return null;
}

/** A few things to ask, chosen from what is waiting. Each is sent to the assistant as typed. */
export function suggestions(summary: HomeSummary | null): string[] {
  const out: string[] = [];
  if (summary?.reviews) out.push('What is waiting on my decision, and which should I look at first?');
  if (summary?.failures) out.push('What failed recently, and what would fix it?');
  if (summary?.urgentExceptions) out.push('Which records have the most urgent data quality exceptions?');
  for (const fallback of ['Which records changed most this week?', 'Where is data quality weakest right now?', 'What can you help me with here?']) {
    if (out.length >= 3) break;
    out.push(fallback);
  }
  return out.slice(0, 3);
}
