import type { WorkflowGraph } from './workflow-graph';

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
