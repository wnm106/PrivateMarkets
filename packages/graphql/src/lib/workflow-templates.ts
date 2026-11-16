import type { WorkflowGraph, WorkflowNode } from './workflow-graph';

/**
 * Starting points for a new workflow. Choosing one in the editor copies its
 * graph into a draft; nothing is saved until the author saves it.
 */

export interface WorkflowTemplate {
  code: string;
  name: string;
  description: string;
  /** Shown in the Start run form as the starting input. */
  inputExample: Record<string, unknown>;
  graph: WorkflowGraph;
}

const READ_TOOLS = [
  'list_dq_exceptions',
  'get_dq_summary',
  'get_entity',
  'list_entities',
  'get_field_lineage',
  'get_temporal_history',
  'get_template_metadata',
  'get_attribute_metadata',
  'search_attributes',
  'query_data',
  'get_model_map',
];

const COMPLIANCE_READ = [
  ...READ_TOOLS,
  'list_compliance_rules',
  'get_compliance_rule',
  'get_compliance_rule_version',
  'list_compliance_breaches',
];

/**
 * An empty proposable list means every write tool. A name that is not a tool
 * means this step only reports, which is what a brief should do.
 */
const REPORT_ONLY = ['report-only'];

type Step = Omit<WorkflowNode, 'position'>;

/** A straight line of steps. A brief has one path and no review. */
function sequence(steps: Step[]): WorkflowGraph {
  return {
    nodes: steps.map((step, index) => ({ ...step, position: { x: index * 280, y: 120 } })),
    edges: steps.slice(0, -1).map((step, index) => ({
      id: `e${index + 1}`,
      from: step.id,
      to: steps[index + 1].id,
    })),
  };
}

function report(id: string, label: string, instructions: string, tools: string[]): Step {
  return {
    id,
    type: 'agent',
    label,
    config: { instructions, tools, proposable: REPORT_ONLY, maxRounds: 16, provider: 'gemini' },
  };
}

const CLEANUP_INSTRUCTIONS = `Work through the open data quality exceptions listed in the "Find open exceptions" step.

For each exception:
1. Read the record and the failing field. Use lineage and history to see where the current value came from and what it was before.
2. Decide what would fix it. Usually one of:
   - The value is wrong or missing and you can establish the right one from another source or from history: propose submit_manual_override with that value, then propose resolve_dq_exception with status RESOLVED.
   - The value is right and the rule does not apply to this record: propose resolve_dq_exception with status FALSE_POSITIVE and say why in resolutionNotes.
   - You cannot establish the right value: propose the override with the value left out, and ask for it as a missing field. Offer your best guess as the suggestion if you have one.
3. Never guess a value into the change itself. A value you are not sure of goes in "suggested", not in args.

Group nothing: one proposed change per tool call, so a reviewer can accept one and reject another.
Mark a change HIGH confidence only when a second source or the record's own history confirms it.
When you have covered every exception, finish with a short summary: how many you looked at, how many fixes you proposed, and which ones need a person's judgement and why.`;

const AS_OF = '2026-09-30';

/**
 * Briefs for Bill McMahon's book. Each one reads, then writes a short note.
 * None of them propose a change. scripts/publish-bill-demo-workflows.mts
 * publishes them on his client and starts a run.
 */
export const DEMO_WORKFLOWS: readonly WorkflowTemplate[] = [
  {
    code: 'DEMO_MORNING_QUALITY',
    name: 'Morning quality brief',
    description: 'Lists open data-quality exceptions and writes a short brief: what is wrong, on which records, and what to open first. It does not change a record.',
    inputExample: { limit: 15 },
    graph: sequence([
      { id: 'start', type: 'start', label: 'Start', config: {} },
      {
        id: 'scan',
        type: 'tool',
        label: 'Open exceptions',
        config: { tool: 'list_dq_exceptions', args: { status: 'OPEN', first: '{{input.limit}}' }, allowWrite: false },
      },
      report(
        'brief',
        'Write the brief',
        `The "Open exceptions" step listed stored data-quality exceptions.

Write a morning brief.
- Lead with how many are open. Say how many are high or critical when the list gives a severity.
- Name the records and what is wrong, using the exception message. Do not add a record or a count that is not in the list.
- If the list is empty, say the register is clear.
- Name the two or three records to open first, and why.
- Do not propose a change.`,
        READ_TOOLS,
      ),
      { id: 'end', type: 'end', label: 'End', config: {} },
    ]),
  },
  {
    code: 'DEMO_HSCF2_CONCENTRATION',
    name: 'Halyard single-name check',
    description: 'Scores the single-issuer share of NAV and explains the result for Halyard Senior Credit Fund II. It does not change a record.',
    inputExample: { asOfDate: AS_OF },
    graph: sequence([
      { id: 'start', type: 'start', label: 'Start', config: {} },
      {
        id: 'score',
        type: 'tool',
        label: 'Score single-issuer share of NAV',
        config: {
          tool: 'evaluate_compliance_rule',
          args: { ruleCode: 'FUND_ISSUER_NAV_PCT', asOfDate: '{{input.asOfDate}}' },
          allowWrite: true,
        },
      },
      report(
        'brief',
        'Explain the result',
        `The score step ran the single-issuer share of NAV rule. Its result has runId, breachCount, and resultCount.

Write a brief about Halyard Senior Credit Fund II (entity code HSCF2-FUND).
1. Call list_compliance_breaches with the runId from the score step.
2. Call get_entity for HSCF2-FUND, and for an issuer only when a breach names it.
3. Say whether Halyard is inside its limit. For each of its breaches, name the issuer, the share, and the limit, using the figures the tools returned.
4. If Halyard has no breach, say so. Mention other funds only as a count.
5. Do not propose a change. Do not treat a missing run as zero breaches.`,
        COMPLIANCE_READ,
      ),
      { id: 'end', type: 'end', label: 'End', config: {} },
    ]),
  },
  {
    code: 'DEMO_BRIGHTWATER_CLOSE',
    name: 'Brightwater closing readiness',
    description: 'Reads Project Brightwater and says whether it can close: which checklist items are still open, who owns them, and what is already done.',
    inputExample: {},
    graph: sequence([
      { id: 'start', type: 'start', label: 'Start', config: {} },
      {
        id: 'deal',
        type: 'tool',
        label: 'Read Project Brightwater',
        config: { tool: 'get_entity', args: { entityCode: 'HALY-DEAL-BRIGHTWATER' }, allowWrite: false },
      },
      report(
        'brief',
        'Write the close brief',
        `The deal step loaded Project Brightwater (HALY-DEAL-BRIGHTWATER).

Find its closing checklist and the items still open.
1. Call get_model_map with domainCode DEAL and toDomain CLOSING_CONDITION, then again with toDomain DEAL_OPEN_ITEM. Copy the path it returns into query_data. Do not invent a relationship code.
2. Keep the rows for this deal. A closing condition is still in the way unless its status is complete or waived. An open item is still in the way when its status is open.
3. Write the brief: ready or not ready, then each item still open with its owner and workstream, then what is already done. If the checklist cannot be found, say that instead of guessing.
4. Do not propose a change.`,
        READ_TOOLS,
      ),
      { id: 'end', type: 'end', label: 'End', config: {} },
    ]),
  },
  {
    code: 'DEMO_HARBOR_NAV',
    name: 'Harbor NAV review',
    description: 'Reads the Harbor Senior Income NAV statement and names the lines to look at before anyone signs it. It does not change a record.',
    inputExample: {},
    graph: sequence([
      { id: 'start', type: 'start', label: 'Start', config: {} },
      {
        id: 'statement',
        type: 'tool',
        label: 'Read the Harbor NAV statement',
        config: { tool: 'get_entity', args: { entityCode: 'HALY-FUND-HSI-STMT' }, allowWrite: false },
      },
      report(
        'brief',
        'Review the statement',
        `The statement step loaded the Harbor Senior Income NAV statement (HALY-FUND-HSI-STMT).

Read it. Where a line has both an administrator amount and an internal amount, name the lines where they differ and the size of the difference. Say whether the statement looks ready to certify, or what a person still has to check. Use only figures on the record. If the amounts are not on the record, say what is missing.
You may call get_entity on Harbor Senior Income (HALY-FUND-HSI) when the statement points at that fund.
Do not propose a change.`,
        READ_TOOLS,
      ),
      { id: 'end', type: 'end', label: 'End', config: {} },
    ]),
  },
  {
    code: 'DEMO_CLO_COVERAGE',
    name: 'CLO coverage tests',
    description: 'Scores the Class A/B overcollateralization test and explains the result for Sample CLO 2026-1. It does not change a holding.',
    inputExample: { asOfDate: AS_OF },
    graph: sequence([
      { id: 'start', type: 'start', label: 'Start', config: {} },
      {
        id: 'score',
        type: 'tool',
        label: 'Score Class A/B overcollateralization',
        config: {
          tool: 'evaluate_compliance_rule',
          args: { ruleCode: 'CLO_OC_AB', asOfDate: '{{input.asOfDate}}' },
          allowWrite: true,
        },
      },
      report(
        'brief',
        'Explain coverage',
        `The score step ran the Class A/B overcollateralization test. Its result has runId, breachCount, and resultCount.

Write a brief about Sample CLO 2026-1 (entity code CLOS-FUND).
1. Call list_compliance_breaches with the runId from the score step.
2. Call get_entity for CLOS-FUND.
3. Say whether the test passed, failed, or had no data. A missing result is not a pass. Name the coverage and the trigger when the tools returned them.
4. Do not propose a change.`,
        COMPLIANCE_READ,
      ),
      { id: 'end', type: 'end', label: 'End', config: {} },
    ]),
  },
  {
    code: 'DEMO_HSCF2_CASH',
    name: 'Halyard cash tie-out',
    description: 'Lists bank transactions and cash matches for Halyard Senior Credit Fund II and says what still does not tie. It does not match or change anything.',
    inputExample: {},
    graph: sequence([
      { id: 'start', type: 'start', label: 'Start', config: {} },
      {
        id: 'banks',
        type: 'tool',
        label: 'List bank transactions',
        config: { tool: 'list_entities', args: { domainCode: 'BANK_TRANSACTION', first: 25 }, allowWrite: false },
      },
      {
        id: 'matches',
        type: 'tool',
        label: 'List cash matches',
        config: { tool: 'list_entities', args: { domainCode: 'CASH_MATCH', first: 25 }, allowWrite: false },
      },
      report(
        'brief',
        'Write the tie-out',
        `Two steps ran: bank transactions, and cash matches.

Write the cash tie-out for Halyard Senior Credit Fund II. The custodian balance for September 30, 2026 is the record HSCF2-EVD-BANK-20260930. Call get_entity on that code when you need the balance.

Say how many bank transactions you saw, how many matches, and which transactions are not in the match list. Name them the way a person would. Do not invent a match. Do not propose a change.`,
        READ_TOOLS,
      ),
      { id: 'end', type: 'end', label: 'End', config: {} },
    ]),
  },
];

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    code: 'DATA_CLEANUP',
    name: 'Data cleanup',
    description:
      'Finds open data quality exceptions, has an agent investigate each one and propose a fix, waits for a person to review the proposals, applies the approved ones, and reports what is left.',
    inputExample: { domainCode: '', severity: '', limit: 20 },
    graph: {
      nodes: [
        { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 160 }, config: {} },
        {
          id: 'scan',
          type: 'tool',
          label: 'Find open exceptions',
          position: { x: 220, y: 160 },
          config: {
            tool: 'list_dq_exceptions',
            args: { status: 'OPEN', domainCode: '{{input.domainCode}}', severity: '{{input.severity}}', first: '{{input.limit}}' },
            allowWrite: false,
          },
        },
        { id: 'any', type: 'branch', label: 'Anything to fix?', position: { x: 480, y: 160 }, config: { path: 'steps.scan.exceptions', op: 'truthy', value: null } },
        {
          id: 'investigate',
          type: 'agent',
          label: 'Investigate and propose fixes',
          position: { x: 740, y: 60 },
          config: { instructions: CLEANUP_INSTRUCTIONS, tools: READ_TOOLS, proposable: ['submit_manual_override', 'resolve_dq_exception'], maxRounds: 30, provider: 'claude' },
        },
        {
          id: 'review',
          type: 'review',
          label: 'Review proposed fixes',
          position: { x: 1020, y: 60 },
          config: {
            source: 'investigate',
            title: 'Review proposed data fixes',
            instructions: 'Approve the fixes you agree with. Answer the questions on any fix that needs a value from you. Reject what should not change.',
            skipWhenEmpty: true,
          },
        },
        { id: 'apply', type: 'apply', label: 'Apply approved fixes', position: { x: 1280, y: 0 }, config: { review: 'review' } },
        { id: 'recount', type: 'tool', label: 'Count what is left', position: { x: 1520, y: 0 }, config: { tool: 'get_dq_summary', args: {}, allowWrite: false } },
        { id: 'end', type: 'end', label: 'End', position: { x: 1760, y: 160 }, config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'scan' },
        { id: 'e2', from: 'scan', to: 'any' },
        { id: 'e3', from: 'any', to: 'investigate', when: 'true' },
        { id: 'e4', from: 'any', to: 'end', when: 'false' },
        { id: 'e5', from: 'investigate', to: 'review' },
        { id: 'e6', from: 'review', to: 'apply', when: 'approved' },
        { id: 'e7', from: 'review', to: 'end', when: 'rejected' },
        { id: 'e8', from: 'apply', to: 'recount' },
        { id: 'e9', from: 'recount', to: 'end' },
      ],
    },
  },
  ...DEMO_WORKFLOWS,
  {
    code: 'BLANK',
    name: 'Blank workflow',
    description: 'A Start and an End. Add the steps between them.',
    inputExample: {},
    graph: {
      nodes: [
        { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 120 }, config: {} },
        { id: 'end', type: 'end', label: 'End', position: { x: 320, y: 120 }, config: {} },
      ],
      edges: [{ id: 'e1', from: 'start', to: 'end' }],
    },
  },
];
