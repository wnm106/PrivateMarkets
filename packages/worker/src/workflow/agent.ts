import { isReadTool, resolveTemplates } from '@tapestrai/graphql/src/lib/workflow-graph';
import { normalizeItems, type ListValue, type ProposalItem } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { checkListValues } from './list-check';
import { message, type AgentRequest, type AgentResult, type ToolRunner } from './engine';

/**
 * The agent step. A model works toward the step's goal by calling read-only
 * tools, and records every change it wants through propose_changes. It has no
 * tool that changes data: what it proposes goes to a person.
 *
 * The model sits behind AgentModel so the loop does not depend on one provider.
 * The conversation is kept in the provider's own message format and saved after
 * every round, so a step interrupted by a restart continues where it stopped.
 */

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelToolResult {
  call: ModelToolCall;
  content: string;
  isError: boolean;
}

export interface ModelTurn {
  /** The assistant's turn in the provider's own format, appended to the conversation unchanged. */
  message: unknown;
  text: string;
  calls: ModelToolCall[];
  stop: 'end' | 'tools' | 'limit' | 'pause' | 'refused';
  refusal?: string;
}

export interface AgentModel {
  provider: string;
  model: string;
  userMessage(text: string): unknown;
  resultMessage(results: ModelToolResult[]): unknown;
  turn(system: string, tools: ToolSpec[], messages: unknown[]): Promise<ModelTurn>;
}

interface AgentState {
  provider: string;
  messages: unknown[];
  items: ProposalItem[];
  rounds: number;
}

const DEFAULT_ROUNDS = 24;
const MAX_ROUNDS = 60;
const MAX_RESULT_CHARS = 24_000;
const MAX_CONTEXT_CHARS = 60_000;

export const PROPOSE_TOOL = 'propose_changes';

const PROPOSE_SPEC: ToolSpec = {
  name: PROPOSE_TOOL,
  description:
    'Record the changes you want made. This is the only way to change anything: each change is shown to a person, who approves, edits, or rejects it, and only approved changes run. ' +
    'Give one entry per tool call, so each can be decided on its own. Call this as you go or once at the end; entries add up across calls. ' +
    'Put only values you have established in args. Anything you could not establish goes in missing, with your best guess in suggested.',
  inputSchema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        description: 'The changes to propose.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A short name for this change, such as "add-sector". Needed only when another change depends on it.' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: 'The ids of changes that must be made before this one. Used when this change sets a list value that another change adds.' },
            fixes: { type: 'array', items: { type: 'string' }, description: 'The rule codes of the data quality checks this change is meant to clear, from get_data_quality_checks.' },
            action: { type: 'string', enum: ['CREATE', 'UPDATE', 'DELETE'], description: 'Whether this creates, edits, or deletes something.' },
            target: {
              type: 'object',
              description: 'What is changed.',
              properties: {
                kind: { type: 'string', description: 'What kind of thing, in plain words: "Fund", "Loan", "Data quality exception".' },
                label: { type: 'string', description: 'Its name or code, as a person would recognise it.' },
                entityId: { type: 'string', description: 'The record id, when the target is an existing record.' },
                domainCode: { type: 'string' },
                templateCode: { type: 'string' },
              },
              required: ['kind', 'label'],
            },
            summary: { type: 'string', description: 'One line saying exactly what changes, with the old and new value where there is one.' },
            tool: { type: 'string', description: 'The tool that makes the change. Must be one of the tools listed as proposable.' },
            args: { type: 'object', description: 'The exact settings for that tool call.' },
            confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'HIGH only when a second source or the record\'s history confirms the change.' },
            needsReview: { type: 'boolean', description: 'True when a person should look closely at this one before approving.' },
            rationale: { type: 'string', description: 'Why this change is right, in a sentence or two.' },
            evidence: { type: 'array', items: { type: 'string' }, description: 'The facts you relied on, each with where it came from.' },
            missing: {
              type: 'array',
              description: 'What the reviewer must supply before this change can run.',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string', description: 'Where the answer goes in args, as a dotted path: "value", "attributes.MATURITY_DATE".' },
                  label: { type: 'string' },
                  question: { type: 'string', description: 'The question to put to the reviewer.' },
                  required: { type: 'boolean' },
                  dataType: { type: 'string', description: 'STRING, NUMBER, DATE, or BOOLEAN.' },
                  options: { type: 'array', items: { type: 'string' }, description: 'The allowed answers, when there is a fixed list.' },
                  suggested: { type: 'string', description: 'Your best guess, if you have one.' },
                },
                required: ['key', 'label', 'question'],
              },
            },
          },
          required: ['action', 'target', 'summary', 'tool', 'args', 'confidence', 'rationale'],
        },
      },
    },
    required: ['changes'],
  },
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function systemPrompt(proposable: ToolSpec[]): string {
  const catalog = proposable.map((tool) => `### ${tool.name}\n${tool.description}\nSettings: ${JSON.stringify(tool.inputSchema)}`).join('\n\n');
  return [
    'You are one step in an automated workflow on a private markets data platform. The platform holds funds, deals, issuers, securities, and positions as records with attributes, and keeps every value\'s source and history.',
    'Your job in this step is described in the first message. Earlier steps have already run; their results are included there.',
    '## How you work',
    'You can read with the tools you have been given. You cannot change anything directly. To change data, record the change with propose_changes. A person reviews what you propose, and only what they approve is carried out, by a later step.',
    'Because a person decides on your word, be exact. Say what will be created, edited, or deleted, on which record, and from what value to what value. Do not put a value in a change unless you have established it from the data. If a change needs a value you could not establish, leave it out of args and list it under missing, with a clear question and your best guess as the suggestion.',
    'Before proposing to create a record, read what its type requires (get_template_metadata) and check the record does not already exist. Supply every required attribute you can establish and ask for the rest. Ask once, for everything that record needs, rather than leaving gaps to be found later.',
    'Rate each change honestly. HIGH means a second source or the record\'s own history confirms it. Set needsReview on anything a careful person would want to look at twice.',
    'No one is watching while you work, so do not ask questions in your text: put them in missing. When the work is done, end with a summary for the reviewer.',
    '## Values that come from a list\nMany attributes take their value from a list. Before you propose a value for an attribute, or suggest one, read its list (get_attribute_list_values) and use a code from it. What you found in the data is often worded differently from the list: when a list value clearly means the same thing, use that value and say in the rationale what you mapped from. When you are choosing between near fits, pick the closest, lower your confidence, and say what the alternatives were. When nothing on the list means the same thing, do one of two things. Ask the reviewer, with no suggestion. Or, if the value is a real, general one the list should have, propose adding it: one change using add_attribute_list_value, given an id, and the change that sets the value with dependsOn naming that id. A list is shared by everyone, so add to it sparingly and never to fit one odd record.',
    '## Data quality checks\nWhen you can run the data quality checks on a record (get_data_quality_checks), run them on each record you assess before deciding what it needs. They tell you what the record fails today, which required attributes it is missing, and which failures a person has already accepted. Use them three ways. A failing check is a reason to propose a change: name the checks a change clears in fixes, and quote the failure in the evidence. A value you propose must satisfy the rules for its attribute, so read the rule and do not propose a value that would fail it. And a failure a person has accepted is settled: do not propose to change it. If a record fails a check you have no sound fix for, say so in the summary rather than proposing a guess.',
    '## The summary\nThe reviewer reads your summary above a table that already lists every change you proposed, so do not list the changes again. Write for a busy person who knows the business and not the system: at most about 120 words, plain sentences, record names and codes but no record ids, tool names, template names, or field names in code formatting. Say what you looked at, what you found, and what needs their judgement and why. If you ran data quality checks, say how many each record fails and which of those your proposals would clear and which they would not. If something stopped you (a tool failed, data was missing), say so in one sentence. You may use a short bullet list. Do not use headings.',
    proposable.length > 0 ? `## Changes you can propose\nEach change names one of these tools and gives its settings.\n\n${catalog}` : '## Changes you can propose\nNone. This step only investigates and reports.',
  ].join('\n\n');
}

function taskMessage(request: AgentRequest): string {
  const instructions = String(resolveTemplates(request.node.config.instructions || '', request.scope) || '');
  const context = clip(JSON.stringify({ input: request.scope.input, steps: request.scope.steps }, null, 1), MAX_CONTEXT_CHARS);
  // The model does not know the date, and a change needs one.
  const today = (request.now?.() ?? new Date()).toISOString().slice(0, 10);
  return `${instructions}\n\nToday is ${today}.\n\n## What this run was started with, and what earlier steps returned\n${context}`;
}

function restore(state: unknown, provider: string): AgentState | null {
  if (!state || typeof state !== 'object') return null;
  const raw = state as Partial<AgentState>;
  if (raw.provider !== provider || !Array.isArray(raw.messages) || raw.messages.length === 0) return null;
  return { provider, messages: raw.messages, items: Array.isArray(raw.items) ? raw.items : [], rounds: Number(raw.rounds) || 0 };
}

export interface AgentDeps {
  tools: ToolRunner & {
    specs(): ToolSpec[];
    /** The values an attribute accepts, or null when it takes any value. Without this, proposed values are not checked against lists. */
    listValues?(attributeCode: string, actor: AgentRequest['actor']): Promise<ListValue[] | null>;
  };
  model(provider: string): AgentModel;
}

export async function runAgentStep(request: AgentRequest, deps: AgentDeps): Promise<AgentResult> {
  const config = request.node.config;
  const model = deps.model(String(config.provider || 'claude'));
  const maxRounds = Math.min(MAX_ROUNDS, Math.max(1, Math.trunc(Number(config.maxRounds)) || DEFAULT_ROUNDS));

  const all = deps.tools.specs();
  const allowed = new Set(strings(config.tools).filter(isReadTool));
  const readSpecs = all.filter((tool) => allowed.has(tool.name));
  const proposableNames = strings(config.proposable);
  const proposable = all.filter((tool) => !isReadTool(tool.name) && (proposableNames.length === 0 || proposableNames.includes(tool.name)));
  const canPropose = new Set(proposable.map((tool) => tool.name));
  const system = systemPrompt(proposable);
  const tools = proposable.length > 0 ? [...readSpecs, PROPOSE_SPEC] : readSpecs;

  const state: AgentState = restore(request.state, model.provider) || {
    provider: model.provider,
    messages: [model.userMessage(taskMessage(request))],
    items: [],
    rounds: 0,
  };
  if (state.rounds > 0) await request.event('agent.resumed', `Continued from round ${state.rounds} after a restart`);

  // Each attribute's list is read once per step.
  const listCache = new Map<string, Promise<ListValue[] | null>>();
  const lists = (attributeCode: string): Promise<ListValue[] | null> => {
    let found = listCache.get(attributeCode);
    if (!found) {
      // A list that cannot be read is not checked: the change still goes to a person.
      found = deps.tools.listValues ? deps.tools.listValues(attributeCode, request.actor).catch(() => null) : Promise.resolve(null);
      listCache.set(attributeCode, found);
    }
    return found;
  };

  const propose = async (input: Record<string, unknown>): Promise<{ content: string; isError: boolean }> => {
    const added = normalizeItems(input.changes, state.items);
    const refused: string[] = [];
    const notes: string[] = [];
    const allowedHere = added.filter((item) => {
      if (canPropose.has(item.tool)) return true;
      refused.push(`"${item.summary}" names ${item.tool}, which this step cannot propose. Proposable tools: ${[...canPropose].join(', ') || 'none'}.`);
      return false;
    });
    // Values that come from a list are held to the list before anything is recorded.
    const pool = [...state.items, ...allowedHere];
    const kept: ProposalItem[] = [];
    for (const item of allowedHere) {
      const check = await checkListValues(item, pool, lists);
      if ('refusal' in check) refused.push(check.refusal);
      else {
        kept.push(check.item);
        notes.push(...check.notes);
      }
    }
    // A change that depended on one that was not recorded no longer depends on it.
    const recorded = new Set([...state.items, ...kept].map((item) => item.id));
    state.items.push(...kept.map((item) => (item.dependsOn ? { ...item, dependsOn: item.dependsOn.filter((id) => recorded.has(id)) } : item)));
    const lines = [`Recorded ${kept.length} change${kept.length === 1 ? '' : 's'} for review (${state.items.length} in total)${kept.length > 0 ? `: ${kept.map((item) => item.id).join(', ')}` : ''}.`];
    if (notes.length > 0) lines.push(notes.join(' '));
    if (refused.length > 0) lines.push(`Not recorded, fix and propose again: ${refused.join(' ')}`);
    return { content: lines.join(' '), isError: kept.length === 0 && refused.length > 0 };
  };

  while (state.rounds < maxRounds) {
    const turn = await model.turn(system, tools, state.messages);
    if (turn.stop === 'refused') throw new Error(`The model declined this step${turn.refusal ? `: ${turn.refusal}` : '.'}`);
    state.messages.push(turn.message);
    if (turn.stop === 'pause') {
      state.rounds += 1;
      continue;
    }
    if (turn.calls.length === 0) {
      if (turn.stop === 'limit') throw new Error('The model ran out of room before it finished. Narrow the step, or give it fewer records at a time.');
      return { summary: turn.text, items: state.items };
    }
    if (turn.text) await request.event('agent.note', clip(turn.text, 600));

    const results = await Promise.all(
      turn.calls.map(async (call) => {
        if (call.name === PROPOSE_TOOL) {
          const outcome = await propose(call.input);
          return { call, ...outcome };
        }
        if (!allowed.has(call.name)) {
          return { call, content: `${call.name} is not available in this step. To change data, use ${PROPOSE_TOOL}.`, isError: true };
        }
        try {
          const value = await deps.tools.run(call.name, call.input, request.actor, 'read');
          return { call, content: clip(JSON.stringify(value ?? null), MAX_RESULT_CHARS), isError: false };
        } catch (error) {
          return { call, content: `${message(error)}. Do not repeat this call unchanged.`, isError: true };
        }
      }),
    );
    for (const result of results) {
      await request.event(
        result.call.name === PROPOSE_TOOL ? 'agent.proposal' : 'agent.tool',
        result.call.name === PROPOSE_TOOL ? result.content : `${result.isError ? 'Tried' : 'Read with'} ${result.call.name}`,
        { tool: result.call.name, args: result.call.input, ok: !result.isError, ...(result.isError ? { error: result.content } : {}) },
      );
    }

    state.messages.push(model.resultMessage(results));
    state.rounds += 1;
    await request.checkpoint(state);
  }

  // Out of rounds: one last turn with no tools, so the reviewer still gets a summary.
  state.messages.push(model.userMessage('You have used every tool round this step allows. Do not call any more tools. Write your summary for the reviewer now, and say plainly what you did not get to.'));
  const last = await model.turn(system, [], state.messages);
  await request.event('agent.note', `Stopped at the limit of ${maxRounds} rounds`);
  return { summary: last.text || `The agent used all ${maxRounds} rounds without writing a summary.`, items: state.items };
}
