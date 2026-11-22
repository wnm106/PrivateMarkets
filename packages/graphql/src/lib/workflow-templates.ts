import type { RunInputField } from './workflow-filters';
import type { WorkflowGraph, WorkflowNode } from './workflow-graph';

/**
 * Starting points for a new workflow. Choosing one in the editor copies its
 * graph into a draft; nothing is saved until the author saves it.
 *
 * A template says what is done, never to which records. Every one starts with
 * the same "Select records" step, which reads `filters` from the run's input
 * (see workflow-filters.ts), and its later steps work on what that returns. So
 * the same workflow runs for one record, for several, or for all of them.
 */

export interface WorkflowTemplate {
  code: string;
  name: string;
  description: string;
  /** Shown in the Start run form as the starting input. */
  inputExample: Record<string, unknown>;
  graph: WorkflowGraph;
}

/** The filters a run can be started with. The same for every workflow. Blank means no restriction. */
export const FILTERS_EXAMPLE = { domainCode: '', entityCodes: [] as string[], nameContains: '' };

const PERIOD_END: RunInputField = { key: 'periodEnd', label: 'Period end', type: 'date', help: 'Leave blank for the period each fund is now closing.' };
const AS_OF: RunInputField = { key: 'asOfDate', label: 'As of', type: 'date', help: 'Leave blank for today.' };
const LIMIT: RunInputField = { key: 'limit', label: 'Most exceptions to read', type: 'number', help: 'Leave blank for 20.' };

/**
 * Where a run begins. Its settings say what the workflow is about, never which
 * records: the type of record it works on, whether it needs records chosen,
 * and what else a run is asked for.
 */
function startStep(setup: { appliesTo?: string; requiresRecords?: boolean; inputs?: RunInputField[] } = {}): WorkflowNode {
  return {
    id: 'start',
    type: 'start',
    label: 'Start',
    position: { x: 0, y: 160 },
    config: { appliesTo: setup.appliesTo || '', requiresRecords: setup.requiresRecords === true, inputs: setup.inputs || [] },
  };
}

/** The step every template starts with: the run's filters, turned into the records it works on. */
function selectRecords(x: number, y: number): WorkflowNode {
  return {
    id: 'select',
    type: 'tool',
    label: 'Select records',
    position: { x, y },
    config: {
      tool: 'find_records',
      args: {
        domainCode: '{{input.filters.domainCode}}',
        entityCodes: '{{input.filters.entityCodes}}',
        entityIds: '{{input.filters.entityIds}}',
        nameContains: '{{input.filters.nameContains}}',
        limit: '{{input.filters.limit}}',
      },
      allowWrite: false,
    },
  };
}

/** Told to every agent, so it stays inside the run's records. */
const SELECTION_RULE = `The "Select records" step says which records this run covers. If it lists records, work on those and no others, and do not propose a change to any other record. If it says the run is not filtered, it covers every record the steps before you returned.`;

const READ_TOOLS = [
  'list_dq_exceptions',
  'get_dq_summary',
  'get_attribute_list_values',
  'get_data_quality_checks',
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

${SELECTION_RULE}

For each exception:
1. Read the record and the failing field, and run the data quality checks on the record to see everything it fails today, not only this exception. Use lineage and history to see where the current value came from and what it was before.
2. Decide what would fix it. Usually one of:
   - The value is wrong or missing and you can establish the right one from another source or from history: propose submit_manual_override with that value, then propose resolve_dq_exception with status RESOLVED.
   - The value is right and the rule does not apply to this record: propose resolve_dq_exception with status FALSE_POSITIVE and say why in resolutionNotes.
   - You cannot establish the right value: propose the override with the value left out, and ask for it as a missing field. Offer your best guess as the suggestion if you have one.
3. Never guess a value into the change itself. A value you are not sure of goes in "suggested", not in args.

Group nothing: one proposed change per tool call, so a reviewer can accept one and reject another.
Mark a change HIGH confidence only when a second source or the record's own history confirms it.
When you have covered every exception, finish with a short summary: how many you looked at, how many fixes you proposed, and which ones need a person's judgement and why.`;

const PACK_READ_TOOLS = [
  'list_position_file_imports',
  'get_position_file_import',
  'get_position_file_tables',
  'list_position_file_mapping_targets',
  'preview_position_file_load',
  'get_nav_reconciliation',
  'get_entity',
  'list_entities',
  'get_template_metadata',
  'get_attribute_metadata',
  'get_attribute_list_values',
  'search_attributes',
  'query_data',
  'get_model_map',
];

const REC_READ_TOOLS = [
  'get_nav_reconciliation',
  'get_position_reconciliation',
  'get_cash_reconciliation',
  'get_entity',
  'list_entities',
  'get_field_lineage',
  'get_temporal_history',
  'get_data_quality_checks',
  'list_position_file_imports',
  'get_position_file_import',
  'query_data',
  'get_model_map',
];

const PACK_INSTRUCTIONS = `Get the administrator pack of each fund in this run mapped and ready to load.
Period end: "{{input.periodEnd}}" (blank means the period each fund is now closing).

${SELECTION_RULE} The "Funds in this run" step lists those funds, the period each is closing, and what each is still missing.

1. Find each fund's pack. The "Files received" step lists stored files, newest first. A fund's pack is every file not yet loaded (status READY or FAILED) that belongs to that fund and its period: judge by the file name, its as-of date, and what is in it. Bank statements and our own position or cash extracts for the period belong too. Leave files for other funds or periods alone. A file already loaded (SUCCEEDED) is done unless "Funds in this run" still shows what it should have supplied as missing. A fund with no file to load needs nothing here: say so and move on.
2. Read each file's tables (get_position_file_tables). A pack is often a workbook: a balance sheet, a statement of operations, a schedule of investments, a cash ledger. Decide what each table is and whether the reconciliation needs it. Cover sheets, notes, and tables that repeat another are not loaded: say so in the summary.
3. Map each table you will load. Start from the mapping Load data suggests for the selected table (get_position_file_import) and from the allowed targets (list_position_file_mapping_targets, narrowed by record type). Read the model map if you are unsure which record type holds what. Every table needs one column mapped to a record type's code. Map a column only to a target that exists. A column with nowhere to go is left out and named in the summary; do not force it onto a near miss.
4. Set the as-of date to the fund's period end, and the source: FUND_ADMIN for anything the administrator produced, INTERNAL for our own books, and the bank's own source for a bank statement if one is listed.
5. Try every mapping with preview_position_file_load, and fix it until nothing is refused or what is refused is understood. Records the preview would create that you expected to match are a warning: the pack may spell a position or security differently from our records. Check before proposing, and say what you found.
6. Propose one load_position_file_table change per table, with the exact mapping you previewed. In the summary line say which fund, what the table is, and what the preview counted (records matched and created, values changed). Put the preview's counts and anything refused in the evidence. HIGH confidence only when the preview matched every record and refused nothing.

If a table would create records you cannot account for, or the preview refuses rows you cannot explain, still propose the load but mark it for review and say exactly what the reviewer should check. If nothing needs loading, propose nothing and say why.

Finish with a short summary, fund by fund: which files and tables you found, which you propose to load and which you left out, and anything in the pack that looks wrong before a single figure is reconciled (a missing statement, a period that does not match, totals that do not add up).`;

const REC_INSTRUCTIONS = `Reconcile each fund in this run: the NAV, the positions, and cash. Then write each fund's reconciliation notes.
Period end: "{{input.periodEnd}}" (blank means the period each fund is now closing).

${SELECTION_RULE} The "Closes after loading" step lists those funds with the period each is closing. Take the funds one at a time and finish one before starting the next. Pass the period end above to every reconciliation tool when one is given.

For each fund, start by reading its NAV reconciliation yourself (get_nav_reconciliation), so you have all of it as it stands after the load. What the earlier steps returned is below, and may be cut short. The "Load the packs" step says which tables loaded and which did not: a table that failed to load is a gap in everything that follows for its fund, so name it. A fund that is not ready to reconcile gets no decisions: its notes say what is missing and who supplies it.

Work in this order. Each part can explain a break in the one before it.

Cash (get_cash_reconciliation)
- Approve the pairs the matching rules propose when the amounts agree and the dates and descriptions make sense: one approve_cash_match per pair. A pair with a variance, or one the rule matched on amount alone, is MEDIUM at best; say what the variance is.
- For what is left unmatched, look for the pair the rules missed: one bank transaction settling several cash flows, a date outside the rule's window, a net amount. Propose it as a match only if the amounts account for each other.
- Propose post_cash_adjustment only for a difference whose cause you have established (a bank charge, a known timing item), never just to clear the residual. An unexplained residual stays open and goes in the notes.

Positions (get_position_reconciliation)
- Where the roll-forward does not tie to a statement line, find the position or the activity that explains it. Read the position, its history, and where its values came from. A break that follows from an unmatched cash item above is the same break: say so once.
- For each flagged mark, compare the administrator's mark with the agent mark and the position's own history.

NAV (get_nav_reconciliation)
- For every tie-out check that breaks or has a figure missing, establish why, using what you found in cash and positions. A missing figure is a data gap, not a break.
- Recalculate nothing by hand. The fee recalculation and drift are already in the reconciliation; your job is to explain the difference from the terms and the inputs.
- Decide every undecided review item with record_rec_decision:
  - ACCEPT when the administrator's figure is right or the difference is immaterial and explained. Say why in the note.
  - ADJUST when our figure is right and you can show it. The note says what is adjusted, by how much, and on what evidence.
  - QUERY when the administrator has to explain or correct it. The note is the question, worded so it can be sent as it is: the line, both figures, the difference, and what you need back.
  Leave a decision a person has already made alone unless the figures have changed since.
- Do not propose anything on a certified period. Never sign off or certify: that is a person's decision.

Show your evidence (show_reviewer)
For each fund, show the reviewer its cash reconciliation (rec.cash) with focus on the bank transactions and cash flows you paired, adjusted for, or left open, and its NAV reconciliation (rec.nav) with focus on the items you decided. Say in why what they should check.

Notes (save_reconciliation_notes)
Propose one change per fund that saves its notes, with dependsOn naming every other change you proposed for that fund so it is applied after them. Write them for the person who will sign off and for whoever picks the file up next quarter. Markdown, in this order:
## Outcome
Two or three sentences: does the NAV tie, what is the proposed NAV against the reported one, and what stands between here and certification. Write it as it will stand once your proposed changes are applied, and say so.
## What was received
The files and tables loaded, their as-of date, and anything missing from the pack.
## NAV
Each break or missing figure: the two figures, the difference, the cause, and what settles it. Then the fee and drift findings.
## Positions
Roll-forward breaks and mark differences, by position, with the cause.
## Cash
Matched, adjusted, and still open, with amounts. The residual and what it is made of.
## Actions
A numbered list. Each action says what is to be done, who does it (fund accountant, valuation analyst, the administrator, senior reviewer), and what it unblocks. Put what blocks certification first.
## Queries for the administrator
Each query in full, ready to send.
Use figures from the reconciliation only, with record names and codes, never record ids. Say plainly what you could not establish.

One proposed change per decision, pair, or adjustment, so each can be approved on its own. HIGH confidence only when a second source confirms it. Start each change's summary line with the fund's code, so a reviewer can take the funds one at a time. Finish with a short summary for the reviewer, fund by fund: what ties, what does not and why, and which of your proposals need their judgement.`;

const REPORT_FILE: RunInputField = { key: 'importInstanceId', label: 'Stored report', type: 'text', help: 'The id of the 10-Q, 10-K or financial statements in Load data.' };
const REPORT_PERIOD: RunInputField = { key: 'periodEnd', label: 'Period end', type: 'date', help: 'Leave blank for the report\'s latest balance sheet date.' };

const NAV_BREAKS_INSTRUCTIONS = `Explain what breaks or is open in this fund's NAV reconciliation, and propose the decisions.

The run covers one fund and one filed report. The "Load the report" step says which fund (its fund.id and fund.code) and which period end; use those with every tool, and propose nothing on any other fund. The "Review the NAV" step summarized the reconciliation after the load: every check that breaks, every check with a figure missing, every review item still open, and every input not on file, each with both figures. The "Write the notes" step already kept that summary as the close's notes.

Start by reading the summary yourself (get_nav_breaks with that fund and period end), then the reconciliation (get_nav_reconciliation) when you need the detail of a figure. What the report says about itself is in get_nav_report. Recalculate nothing by hand: the reconciliation already has every figure, and your job is to explain the difference from the statements, the fund's terms, and the report.

For each break:
- Say what the two figures are, where each comes from, and the difference.
- Establish the cause from what is on file: a statement line that did not load or landed on the wrong chart line (compare get_nav_report's mapping), a subtotal in the report that does not add up, a comparative that was restated, currency translation on non-dollar positions, a restructuring or write-off. Say plainly when you cannot establish it.
- A check with a figure missing is a gap in what is on file, not a break. Name what supplies it.

The summary also goes through the NAV pack part by part (pack: the NAV bridge, trial balance, financial statements and notes, investors' capital accounts, management fee, carry and waterfall, valuation support, calls and distributions, commitments and unfunded, FX). A pack check that breaks is a break like any other; its component says which part. Use the part's figures from get_nav_reconciliation (pack): the bridge steps, each investor's roll and fee, the waterfall tiers, the positions without valuation support, the rates applied against the market. For each part that is Not on file, say who supplies it and whether the fund requires it (a required part blocks certification). Ask the administrator for missing parts in one QUERY on the item it affects, or in the notes when no item does.

For each open review item, propose one record_rec_decision:
- ACCEPT when the figure in the statements is right or the difference is immaterial and explained. Say why in the note.
- QUERY when the administrator, or the filer, has to explain or correct it. The note is the question, worded so it can be sent as it is: the line, both figures, the difference, and what you need back.
- ADJUST only when our figure is right and you can show it from what is on file.
Leave a decision a person has already made alone unless the figures have changed since. Do not propose anything on a certified period. Never sign off or certify.

Show the reviewer the NAV reconciliation (show_reviewer, rec.nav) with focus on the items you decided, and say what they should check.

Then propose one save_reconciliation_notes change, with dependsOn naming every other change you proposed, so it is applied after them and replaces the summary the run kept. Markdown, in this order:
## Outcome
Two or three sentences: does the NAV tie, how many breaks and open items, and what stands between here and certification, as it will stand once your proposed changes are applied.
## What was received
The report, its period end, the date it compares with, and what loaded: the statements, the positions, and the report's own checks.
## Breaks
Each break: the two figures, the difference, the cause, and what settles it.
## Review items
Each item: the decision you propose and why.
## The NAV pack
Each part of the pack: on file or not, ties or not, in one line each. Parts the fund does not need, in one line.
## Not on file
What could not be checked and who supplies it.
## Queries
Each query in full, ready to send.
Use figures from the tools only, with record names and codes, never record ids.

One proposed change per decision, so each can be approved on its own. HIGH confidence only when a second source confirms it. Finish with a short summary for the reviewer: what ties, what does not and why, and which of your proposals need their judgement.`;

/**
 * For a step that only reports. An agent step with nothing listed may propose
 * any change, so a reporting step lists this one name, which is no tool's.
 */
export const REPORT_ONLY = ['report-only'];

const BRIEF_TOOLS = [
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

const COMPLIANCE_TOOLS = [...BRIEF_TOOLS, 'list_compliance_rules', 'get_compliance_rule', 'get_compliance_rule_version', 'list_compliance_breaches'];

const QUALITY_BRIEF_INSTRUCTIONS = `The "Open exceptions" step listed stored data quality exceptions.

${SELECTION_RULE}

Write a brief.
- Lead with which records the run covered and how many exceptions are open. Say how many are high or critical when the list gives a severity.
- Name the records and what is wrong, using the exception message. Do not add a record or a count that is not in the list.
- If the list is empty, say the register is clear for the records covered.
- Name the two or three records to open first, and why.
- Do not propose a change.`;

const NAV_REVIEW_INSTRUCTIONS = `Review the NAV of each fund in this run before anyone signs it.
Period end: "{{input.periodEnd}}" (blank means the period each fund is now closing).

${SELECTION_RULE} The "Funds in this run" step lists those funds and where each close stands.

For each fund, read its NAV reconciliation (get_nav_reconciliation, with the period end above when one is given). Then say:
- whether the administrator pack and our books are on file, and what is missing if not
- each tie-out check that breaks or has a figure missing, with both figures and the difference
- the statement lines where the administrator and the internal amount differ, and by how much
- whether the NAV looks ready to certify, or what a person still has to check

Use only figures the tools returned. If an amount is not on file, say what is missing. Write one short section per fund, under the fund's name. Do not propose a change.`;

const CASH_TIE_OUT_INSTRUCTIONS = `Write the cash tie-out of each fund in this run.
Period end: "{{input.periodEnd}}" (blank means the period each fund is now closing).

${SELECTION_RULE} The "Funds in this run" step lists those funds.

For each fund, read its cash reconciliation (get_cash_reconciliation, with the period end above when one is given). Then say:
- whether cash ties to the bank, and the residual if it does not
- how many bank transactions and cash flows are paired, how many pairs the rules propose, and how many are still open on each side
- the open bank transactions and cash flows, named the way a person would, with their amounts
- adjustments already posted

Do not invent a match. Use only figures the tools returned. Write one short section per fund, under the fund's name. Do not propose a change.`;

const CLOSING_READINESS_INSTRUCTIONS = `Say whether each deal in this run can close.

${SELECTION_RULE} If the run is not filtered, read the deals with list_entities and say how many you covered.

For each deal:
1. Find its closing checklist and the items still open. Call get_model_map with domainCode DEAL and toDomain CLOSING_CONDITION, then again with toDomain DEAL_OPEN_ITEM. Copy the path it returns into query_data. Do not invent a relationship code.
2. Keep the rows for that deal. A closing condition is still in the way unless its status is complete or waived. An open item is still in the way when its status is open.
3. Write its brief: ready or not ready, then each item still open with its owner and workstream, then what is already done. If the checklist cannot be found, say that instead of guessing.

A record that is not a deal is named and left out. Write one short section per deal, under the deal's name. Do not propose a change.`;

function complianceInstructions(rule: string): string {
  return `The "Score the rule" step ran the ${rule} rule for every record it applies to. Its result has runId, breachCount, and resultCount.

${SELECTION_RULE}

1. Call list_compliance_breaches with the runId from the score step. If Select records lists records, pass their ids as entityIds so only their breaches come back.
2. If Select records lists records, write a section for each: inside its limit or not. For each breach name what breached, the value, and the limit, using the figures the tools returned. Call get_entity for a record only when you need its name or a breach names it.
3. If the run is not filtered, name every record that breached with the same figures, and give the rest as a count.
4. A run with no results did not pass: say there was no data. Do not treat a missing run as zero breaches.
5. Do not propose a change.`;
}

const REQUIRED_VALUES_INSTRUCTIONS = `Find what each record in this run is missing, and propose the values.

${SELECTION_RULE}

For each record:
1. Read the record (get_entity), what its template requires (get_template_metadata), and run the data quality checks on it (get_data_quality_checks).
2. Find required attributes that have no value, and checks the record fails.
3. For each gap, propose one change with submit_manual_override. If the record's own history or lineage establishes the value, put it in args and say where it came from. Otherwise leave "value" out of args and ask for it as a missing field, with your best guess as the suggestion if you have one.

For SECTOR, work from the record's Moody's industry. Use the sector list's value when one means the same thing. If the list has no value that fits, propose adding the right one and setting it.

Use validFrom of today and an overrideReason that says what was missing.
Finish with a short summary: which records you looked at, what you found, and what you propose.`;

/** Start, Select records, the steps between, End: one path, with the positions filled in. */
function line(setup: Parameters<typeof startStep>[0], steps: Array<Omit<WorkflowNode, 'position'>>): WorkflowGraph {
  const nodes: WorkflowNode[] = [
    startStep(setup),
    selectRecords(220, 160),
    ...steps.map((step, index) => ({ ...step, position: { x: 460 + index * 240, y: 160 } })),
    { id: 'end', type: 'end', label: 'End', position: { x: 460 + steps.length * 240, y: 160 }, config: {} },
  ];
  const edges: WorkflowGraph['edges'] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const from = nodes[index];
    const to = nodes[index + 1];
    if (from.type === 'branch') {
      edges.push({ id: `e${edges.length}`, from: from.id, to: to.id, when: 'true' }, { id: `e${edges.length + 1}`, from: from.id, to: 'end', when: 'false' });
    } else if (from.type === 'review') {
      edges.push({ id: `e${edges.length}`, from: from.id, to: to.id, when: 'approved' }, { id: `e${edges.length + 1}`, from: from.id, to: 'end', when: 'rejected' });
    } else {
      edges.push({ id: `e${edges.length}`, from: from.id, to: to.id });
    }
  }
  return { nodes, edges };
}

const brief = (label: string, instructions: string, tools: string[]): Omit<WorkflowNode, 'position'> => ({
  id: 'brief',
  type: 'agent',
  label,
  config: { instructions, tools, proposable: REPORT_ONLY, maxRounds: 24, provider: 'claude' },
});

const fundsInRun: Omit<WorkflowNode, 'position'> = {
  id: 'closes',
  type: 'tool',
  label: 'Funds in this run',
  config: { tool: 'list_fund_closes', args: { entityIds: '{{steps.select.entityIds}}', periodEnd: '{{input.periodEnd}}' }, allowWrite: false },
};

const anyFund: Omit<WorkflowNode, 'position'> = {
  id: 'any',
  type: 'branch',
  label: 'Any fund in the run?',
  config: { path: 'steps.closes.funds', op: 'truthy', value: null },
};

function complianceCheck(code: string, name: string, ruleCode: string, rule: string, appliesTo: string, description: string): WorkflowTemplate {
  return {
    code,
    name,
    description,
    inputExample: { filters: FILTERS_EXAMPLE, asOfDate: '' },
    graph: line({ appliesTo, inputs: [AS_OF] }, [
      { id: 'score', type: 'tool', label: 'Score the rule', config: { tool: 'evaluate_compliance_rule', args: { ruleCode, asOfDate: '{{input.asOfDate}}' }, allowWrite: true } },
      brief('Explain the result', complianceInstructions(rule), COMPLIANCE_TOOLS),
    ]),
  };
}

const DEMO_AS_OF = '2026-09-30';

/**
 * Briefs for Bill McMahon's book. Each one reads, then writes a short note.
 * None of them propose a change. scripts/publish-bill-demo-workflows.mts
 * publishes them on his client and starts a run.
 */
// Not in WORKFLOW_TEMPLATES: they name one client's records, and every template there is generic.
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
    inputExample: { asOfDate: DEMO_AS_OF },
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
    inputExample: { asOfDate: DEMO_AS_OF },
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
      'For the records a run is started with, or for all of them: finds open data quality exceptions, has an agent investigate each one and propose a fix, waits for a person to review the proposals, applies the approved ones, and reports what is left.',
    inputExample: { filters: FILTERS_EXAMPLE, limit: 20 },
    graph: {
      nodes: [
        startStep({ inputs: [LIMIT] }),
        selectRecords(220, 160),
        {
          id: 'scan',
          type: 'tool',
          label: 'Find open exceptions',
          position: { x: 460, y: 160 },
          config: {
            tool: 'list_dq_exceptions',
            args: { status: 'OPEN', entityIds: '{{steps.select.entityIds}}', first: '{{input.limit}}' },
            allowWrite: false,
          },
        },
        { id: 'any', type: 'branch', label: 'Anything to fix?', position: { x: 720, y: 160 }, config: { path: 'steps.scan.exceptions', op: 'truthy', value: null } },
        {
          id: 'investigate',
          type: 'agent',
          label: 'Investigate and propose fixes',
          position: { x: 980, y: 60 },
          config: { instructions: CLEANUP_INSTRUCTIONS, tools: READ_TOOLS, proposable: ['submit_manual_override', 'resolve_dq_exception', 'add_attribute_list_value'], maxRounds: 30, provider: 'claude' },
        },
        {
          id: 'review',
          type: 'review',
          label: 'Review proposed fixes',
          position: { x: 1260, y: 60 },
          config: {
            source: 'investigate',
            title: 'Review proposed data fixes',
            instructions: 'Approve the fixes you agree with. Answer the questions on any fix that needs a value from you. Reject what should not change.',
            skipWhenEmpty: true,
          },
        },
        { id: 'apply', type: 'apply', label: 'Apply approved fixes', position: { x: 1520, y: 0 }, config: { review: 'review' } },
        {
          id: 'recount',
          type: 'tool',
          label: 'Find what is left',
          position: { x: 1760, y: 0 },
          config: { tool: 'list_dq_exceptions', args: { status: 'OPEN', entityIds: '{{steps.select.entityIds}}', first: '{{input.limit}}' }, allowWrite: false },
        },
        { id: 'end', type: 'end', label: 'End', position: { x: 2000, y: 160 }, config: {} },
      ],
      edges: [
        { id: 'e0', from: 'start', to: 'select' },
        { id: 'e1', from: 'select', to: 'scan' },
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
    code: 'FUND_RECONCILIATION',
    name: 'Fund reconciliation',
    description:
      'For the funds a run is started with, or for all of them: takes each administrator pack from received file to reconciliation notes. An agent maps the packs and a person approves the loads. A second agent reconciles the NAV, the positions, and cash, decides each open item, and writes the notes with the actions that follow; a person approves those, and the run ends with where each close stands.',
    inputExample: { filters: FILTERS_EXAMPLE, periodEnd: '' },
    graph: {
      nodes: [
        startStep({ appliesTo: 'FUND', inputs: [PERIOD_END] }),
        selectRecords(220, 160),
        {
          id: 'closes',
          type: 'tool',
          label: 'Funds in this run',
          position: { x: 460, y: 160 },
          config: { tool: 'list_fund_closes', args: { entityIds: '{{steps.select.entityIds}}', periodEnd: '{{input.periodEnd}}' }, allowWrite: false },
        },
        { id: 'any', type: 'branch', label: 'Any fund to reconcile?', position: { x: 700, y: 160 }, config: { path: 'steps.closes.funds', op: 'truthy', value: null } },
        {
          id: 'files',
          type: 'tool',
          label: 'Files received',
          position: { x: 940, y: 60 },
          config: { tool: 'list_position_file_imports', args: { limit: 25 }, allowWrite: false },
        },
        {
          id: 'map',
          type: 'agent',
          label: 'Map the packs',
          position: { x: 1180, y: 60 },
          config: { instructions: PACK_INSTRUCTIONS, tools: PACK_READ_TOOLS, proposable: ['load_position_file_table'], maxRounds: 40, provider: 'claude' },
        },
        {
          id: 'reviewLoad',
          type: 'review',
          label: 'Review the mapping',
          position: { x: 1420, y: 60 },
          config: {
            source: 'map',
            title: 'Review the pack mapping before it loads',
            instructions: 'Each change loads one table of a pack. Check which fund it is for, what the table is, where each column goes, and what the preview counted. Reject a table that should not load. Rejecting every table ends the run without reconciling.',
            skipWhenEmpty: true,
          },
        },
        { id: 'load', type: 'apply', label: 'Load the packs', position: { x: 1660, y: 0 }, config: { review: 'reviewLoad' } },
        {
          id: 'loaded',
          type: 'tool',
          label: 'Closes after loading',
          position: { x: 1900, y: 0 },
          config: { tool: 'list_fund_closes', args: { entityIds: '{{steps.select.entityIds}}', periodEnd: '{{input.periodEnd}}' }, allowWrite: false },
        },
        {
          id: 'reconcile',
          type: 'agent',
          label: 'Reconcile and write notes',
          position: { x: 2140, y: 0 },
          config: {
            instructions: REC_INSTRUCTIONS,
            tools: REC_READ_TOOLS,
            proposable: ['record_rec_decision', 'approve_cash_match', 'post_cash_adjustment', 'save_reconciliation_notes'],
            showable: ['rec.cash', 'rec.nav'],
            maxRounds: 60,
            provider: 'claude',
          },
        },
        {
          id: 'reviewRec',
          type: 'review',
          label: 'Review the reconciliation',
          position: { x: 2380, y: 0 },
          config: {
            source: 'reconcile',
            title: 'Review the reconciliation',
            instructions: 'Approve the decisions, cash pairs, and adjustments you agree with, and edit a note or a query before it is kept. Read each fund\'s notes last: they describe the reconciliation as it will stand if everything for that fund is approved, so edit them if you reject something. Sign-off and certification stay on the reconciliation page.',
            skipWhenEmpty: true,
          },
        },
        { id: 'record', type: 'apply', label: 'Record the outcome', position: { x: 2620, y: -60 }, config: { review: 'reviewRec' } },
        {
          id: 'after',
          type: 'tool',
          label: 'Where the closes stand now',
          position: { x: 2860, y: -60 },
          config: { tool: 'list_fund_closes', args: { entityIds: '{{steps.select.entityIds}}', periodEnd: '{{input.periodEnd}}' }, allowWrite: false },
        },
        { id: 'end', type: 'end', label: 'End', position: { x: 3100, y: 160 }, config: {} },
      ],
      edges: [
        { id: 'e0', from: 'start', to: 'select' },
        { id: 'e1', from: 'select', to: 'closes' },
        { id: 'e2', from: 'closes', to: 'any' },
        { id: 'e3', from: 'any', to: 'files', when: 'true' },
        { id: 'e4', from: 'any', to: 'end', when: 'false' },
        { id: 'e5', from: 'files', to: 'map' },
        { id: 'e6', from: 'map', to: 'reviewLoad' },
        { id: 'e7', from: 'reviewLoad', to: 'load', when: 'approved' },
        { id: 'e8', from: 'reviewLoad', to: 'end', when: 'rejected' },
        { id: 'e9', from: 'load', to: 'loaded' },
        { id: 'e10', from: 'loaded', to: 'reconcile' },
        { id: 'e11', from: 'reconcile', to: 'reviewRec' },
        { id: 'e12', from: 'reviewRec', to: 'record', when: 'approved' },
        { id: 'e13', from: 'reviewRec', to: 'end', when: 'rejected' },
        { id: 'e14', from: 'record', to: 'after' },
        { id: 'e15', from: 'after', to: 'end' },
      ],
    },
  },
  {
    code: 'NAV_RECONCILIATION',
    name: 'NAV reconciliation',
    description:
      'Runs a fund\'s NAV reconciliation from its filed report (a 10-Q, a 10-K, an administrator\'s financial statements) with a person only where one is needed. It starts on its own when a report arrives (set up a trigger on filed reports), finds the fund the report names, and loads it when nothing needs a person: a person checks the report only when the fund is not found, the report does not add up, a line has nowhere to go, the trial load refuses records, or the report restates figures on file. The reconciliation runs, the break summary is kept as the close\'s notes, and the run ends there when nothing breaks and nothing is open. When something does, an agent explains it and proposes the decisions, and a person approves them. Certification stays with a person.',
    inputExample: { filters: FILTERS_EXAMPLE, importInstanceId: '', periodEnd: '' },
    graph: {
      nodes: [
        startStep({ appliesTo: 'FUND', inputs: [REPORT_FILE, REPORT_PERIOD] }),
        selectRecords(220, 160),
        {
          id: 'read',
          type: 'tool',
          label: 'Read the report',
          position: { x: 440, y: 160 },
          config: { tool: 'get_nav_report', args: { instanceId: '{{input.importInstanceId}}', entityIds: '{{steps.select.entityIds}}', periodEnd: '{{input.periodEnd}}' }, allowWrite: false },
        },
        { id: 'auto', type: 'branch', label: 'Can it load on its own?', position: { x: 660, y: 160 }, config: { path: 'steps.read.autoLoad', op: 'truthy', value: null } },
        {
          id: 'check',
          type: 'stage',
          label: 'Check the report',
          position: { x: 880, y: 300 },
          config: {
            screen: 'nav.report',
            title: 'This report needs you before it loads',
            instructions: 'The run stopped here for the reasons listed at the top. Choose the fund if it was not found, check what is held, and load the report or stop the run.',
            args: { importInstanceId: '{{input.importInstanceId}}', entityIds: '{{steps.select.entityIds}}', periodEnd: '{{input.periodEnd}}' },
            people: [],
            roles: [],
            dueInHours: 24,
          },
        },
        { id: 'ready', type: 'join', label: 'Ready to load', position: { x: 1100, y: 160 }, config: {} },
        {
          id: 'load',
          type: 'tool',
          label: 'Load the report',
          position: { x: 1320, y: 160 },
          config: {
            tool: 'load_nav_report',
            args: {
              instanceId: '{{input.importInstanceId}}',
              entityIds: '{{steps.select.entityIds}}',
              fundId: '{{steps.check.result.fundId}}',
              confirmed: '{{steps.check.result.confirmed}}',
              periodEnd: '{{steps.read.report.periodEnd}}',
            },
            allowWrite: true,
          },
        },
        {
          id: 'review',
          type: 'tool',
          label: 'Review the NAV',
          position: { x: 1540, y: 160 },
          config: { tool: 'get_nav_breaks', args: { fundId: '{{steps.load.fund.id}}', periodEnd: '{{steps.load.periodEnd}}' }, allowWrite: false },
        },
        {
          id: 'notes',
          type: 'tool',
          label: 'Write the notes',
          position: { x: 1760, y: 160 },
          config: { tool: 'save_nav_notes', args: { fundId: '{{steps.load.fund.id}}', periodEnd: '{{steps.load.periodEnd}}' }, allowWrite: true },
        },
        { id: 'open', type: 'branch', label: 'Anything to decide?', position: { x: 1980, y: 160 }, config: { path: 'steps.review.needsDecision', op: 'truthy', value: null } },
        {
          id: 'explain',
          type: 'agent',
          label: 'Explain the breaks',
          position: { x: 2200, y: 60 },
          config: {
            instructions: NAV_BREAKS_INSTRUCTIONS,
            tools: ['get_nav_breaks', 'get_nav_reconciliation', 'get_position_reconciliation', 'get_nav_report', 'get_entity', 'get_field_lineage', 'get_temporal_history', 'query_data', 'get_model_map'],
            proposable: ['record_rec_decision', 'save_reconciliation_notes'],
            showable: ['rec.nav'],
            maxRounds: 30,
            provider: 'claude',
          },
        },
        {
          id: 'reviewRec',
          type: 'review',
          label: 'Decide the breaks',
          position: { x: 2420, y: 60 },
          config: {
            source: 'explain',
            title: 'Decide what breaks or is open',
            instructions: 'Each change decides one item: accept the figure, query the administrator, or adjust. Approve what you agree with and edit a query before it is kept. The notes describe the reconciliation as it will stand if everything is approved. Sign-off and certification stay on the reconciliation page.',
            skipWhenEmpty: true,
          },
        },
        { id: 'record', type: 'apply', label: 'Record the decisions', position: { x: 2640, y: 0 }, config: { review: 'reviewRec' } },
        {
          id: 'after',
          type: 'tool',
          label: 'Where the NAV stands now',
          position: { x: 2860, y: 0 },
          config: { tool: 'get_nav_breaks', args: { fundId: '{{steps.load.fund.id}}', periodEnd: '{{steps.load.periodEnd}}' }, allowWrite: false },
        },
        { id: 'end', type: 'end', label: 'End', position: { x: 3080, y: 160 }, config: {} },
      ],
      edges: [
        { id: 'e0', from: 'start', to: 'select' },
        { id: 'e1', from: 'select', to: 'read' },
        { id: 'e2', from: 'read', to: 'auto' },
        { id: 'e3', from: 'auto', to: 'ready', when: 'true' },
        { id: 'e4', from: 'auto', to: 'check', when: 'false' },
        { id: 'e5', from: 'check', to: 'ready', when: 'confirmed' },
        { id: 'e6', from: 'check', to: 'end', when: 'abandoned' },
        { id: 'e7', from: 'ready', to: 'load' },
        { id: 'e8', from: 'load', to: 'review' },
        { id: 'e9', from: 'review', to: 'notes' },
        { id: 'e10', from: 'notes', to: 'open' },
        { id: 'e11', from: 'open', to: 'explain', when: 'true' },
        { id: 'e12', from: 'open', to: 'end', when: 'false' },
        { id: 'e13', from: 'explain', to: 'reviewRec' },
        { id: 'e14', from: 'reviewRec', to: 'record', when: 'approved' },
        { id: 'e15', from: 'reviewRec', to: 'end', when: 'rejected' },
        { id: 'e16', from: 'record', to: 'after' },
        { id: 'e17', from: 'after', to: 'end' },
      ],
    },
  },
  {
    code: 'DATA_QUALITY_BRIEF',
    name: 'Data quality brief',
    description:
      'For the records a run is started with, or for all of them: lists open data quality exceptions and writes a short brief of what is wrong, on which records, and what to open first. It does not change a record.',
    inputExample: { filters: FILTERS_EXAMPLE, limit: 20 },
    graph: line({ inputs: [LIMIT] }, [
      { id: 'scan', type: 'tool', label: 'Open exceptions', config: { tool: 'list_dq_exceptions', args: { status: 'OPEN', entityIds: '{{steps.select.entityIds}}', first: '{{input.limit}}' }, allowWrite: false } },
      brief('Write the brief', QUALITY_BRIEF_INSTRUCTIONS, BRIEF_TOOLS),
    ]),
  },
  {
    code: 'NAV_REVIEW',
    name: 'NAV review',
    description:
      'For the funds a run is started with, or for all of them: reads each NAV reconciliation and names the checks and lines to look at before anyone signs it. It does not change a record.',
    inputExample: { filters: FILTERS_EXAMPLE, periodEnd: '' },
    graph: line({ appliesTo: 'FUND', inputs: [PERIOD_END] }, [
      fundsInRun,
      anyFund,
      brief('Review the NAV', NAV_REVIEW_INSTRUCTIONS, ['get_nav_reconciliation', 'get_position_reconciliation', 'get_entity', 'get_field_lineage', 'get_temporal_history', 'query_data', 'get_model_map']),
    ]),
  },
  {
    code: 'CASH_TIE_OUT',
    name: 'Cash tie-out',
    description:
      'For the funds a run is started with, or for all of them: reads each cash reconciliation and says what ties to the bank and what still does not. It does not match or change anything.',
    inputExample: { filters: FILTERS_EXAMPLE, periodEnd: '' },
    graph: line({ appliesTo: 'FUND', inputs: [PERIOD_END] }, [
      fundsInRun,
      anyFund,
      brief('Write the tie-out', CASH_TIE_OUT_INSTRUCTIONS, ['get_cash_reconciliation', 'get_entity', 'get_field_lineage', 'get_temporal_history', 'query_data', 'get_model_map']),
    ]),
  },
  {
    code: 'CLOSING_READINESS',
    name: 'Closing readiness',
    description:
      'For the deals a run is started with: says whether each can close, which checklist items are still open, who owns them, and what is already done. It does not change a record.',
    inputExample: { filters: FILTERS_EXAMPLE },
    graph: line({ appliesTo: 'DEAL' }, [brief('Write the close brief', CLOSING_READINESS_INSTRUCTIONS, BRIEF_TOOLS)]),
  },
  complianceCheck(
    'OVERCOLLATERALIZATION_TEST',
    'Overcollateralization test',
    'CLO_OC_AB',
    'Class A/B overcollateralization',
    'FUND',
    'Scores the Class A/B overcollateralization test and explains the result for the records a run is started with, or for every record the test applies to. It does not change a holding.',
  ),
  complianceCheck(
    'SINGLE_NAME_CHECK',
    'Single-name check',
    'FUND_ISSUER_NAV_PCT',
    'single-issuer share of NAV',
    'FUND',
    'Scores the single-issuer share of NAV and explains the result for the funds a run is started with, or for every fund the rule applies to. It does not change a record.',
  ),
  {
    code: 'REQUIRED_VALUES_CHECK',
    name: 'Required values check',
    description:
      'For the records a run is started with: has an agent find missing required values and failing checks on each, propose the values, and wait for a person to review them. It reads records one at a time, so it needs filters: a run with none ends without doing anything.',
    inputExample: { filters: FILTERS_EXAMPLE },
    graph: line({ requiresRecords: true }, [
      { id: 'any', type: 'branch', label: 'Any records selected?', config: { path: 'steps.select.entityIds', op: 'truthy', value: null } },
      {
        id: 'check',
        type: 'agent',
        label: 'Check for missing required values',
        config: {
          instructions: REQUIRED_VALUES_INSTRUCTIONS,
          tools: ['get_data_quality_checks', 'get_attribute_list_values', 'get_entity', 'get_template_metadata', 'get_attribute_metadata', 'get_field_lineage', 'get_temporal_history', 'search_attributes', 'list_entities'],
          proposable: ['submit_manual_override', 'add_attribute_list_value'],
          maxRounds: 30,
          provider: 'claude',
        },
      },
      { id: 'review', type: 'review', label: 'Review proposed values', config: { source: 'check', title: 'Review proposed values', instructions: 'Approve only what you want written to the record. Reject the rest.', skipWhenEmpty: true } },
      { id: 'apply', type: 'apply', label: 'Apply approved values', config: { review: 'review' } },
    ]),
  },
  {
    code: 'FILE_INTAKE',
    name: 'File intake',
    description:
      'Takes one stored file to live records as a guided run: the file is indexed for search, a person confirms what it is and where each column goes, the values are staged and checked against the data quality rules, the person corrects what is wrong and approves, and the batch is promoted. Nothing is live until the batch is approved. Start it with the stored file.',
    inputExample: { importInstanceId: '' },
    graph: {
      nodes: [
        { ...startStep({ inputs: [{ key: 'importInstanceId', label: 'Stored file', type: 'text', help: 'The id of a file in Load data.' }] }), position: { x: 0, y: 160 } },
        {
          id: 'receive',
          type: 'tool',
          label: 'Index for search',
          position: { x: 220, y: 160 },
          config: { tool: 'index_position_file_import', args: { instanceId: '{{input.importInstanceId}}' }, allowWrite: true },
        },
        {
          id: 'understand',
          type: 'stage',
          label: 'Understand the file',
          position: { x: 440, y: 160 },
          config: {
            screen: 'intake.understand',
            title: 'Confirm what this file is',
            instructions: 'Check what was read from the file, the kind of document it is, and the record it is about, before mapping its columns.',
            args: { importInstanceId: '{{input.importInstanceId}}' },
            people: [],
            roles: [],
            dueInHours: null,
          },
        },
        {
          id: 'map',
          type: 'stage',
          label: 'Map the file',
          position: { x: 660, y: 160 },
          config: {
            screen: 'load.map',
            title: 'Confirm where each column goes',
            instructions: 'Check what was found in the file, decide any column the reading was unsure of, and set the date the values are as of.',
            args: { importInstanceId: '{{input.importInstanceId}}' },
            people: [],
            roles: [],
            dueInHours: null,
          },
        },
        {
          id: 'stage',
          type: 'tool',
          label: 'Stage the values',
          position: { x: 880, y: 160 },
          config: {
            tool: 'stage_position_file_import',
            args: { instanceId: '{{input.importInstanceId}}', resolutions: '{{steps.map.result.resolutions}}' },
            allowWrite: true,
          },
        },
        { id: 'staged', type: 'branch', label: 'Was it staged?', position: { x: 1100, y: 160 }, config: { path: 'steps.stage.kind', op: 'eq', value: 'staged' } },
        {
          id: 'quality',
          type: 'stage',
          label: 'Check the values',
          position: { x: 1320, y: 160 },
          config: {
            screen: 'load.quality',
            title: 'Check the staged values',
            instructions: 'Correct any value that fails a check, then approve the batch to make it live, or discard it.',
            args: { batchId: '{{steps.stage.batch.id}}' },
            people: [],
            roles: [],
            dueInHours: null,
          },
        },
        {
          id: 'promote',
          type: 'tool',
          label: 'Promote to live records',
          position: { x: 1540, y: 80 },
          config: {
            tool: 'promote_load_batch',
            args: { batchId: '{{steps.stage.batch.id}}', overrideReason: '{{steps.quality.result.overrideReason}}' },
            allowWrite: true,
          },
        },
        {
          id: 'discard',
          type: 'tool',
          label: 'Discard the batch',
          position: { x: 1540, y: 260 },
          config: { tool: 'discard_load_batch', args: { batchId: '{{steps.stage.batch.id}}' }, allowWrite: true },
        },
        { id: 'end', type: 'end', label: 'End', position: { x: 1760, y: 160 }, config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'receive' },
        { id: 'e11', from: 'receive', to: 'understand' },
        { id: 'e12', from: 'understand', to: 'map', when: 'confirmed' },
        { id: 'e13', from: 'understand', to: 'end', when: 'abandoned' },
        { id: 'e2', from: 'map', to: 'stage', when: 'confirmed' },
        { id: 'e3', from: 'map', to: 'end', when: 'abandoned' },
        { id: 'e4', from: 'stage', to: 'staged' },
        { id: 'e5', from: 'staged', to: 'quality', when: 'true' },
        { id: 'e6', from: 'staged', to: 'end', when: 'false' },
        { id: 'e7', from: 'quality', to: 'promote', when: 'approved' },
        { id: 'e8', from: 'quality', to: 'discard', when: 'discarded' },
        { id: 'e9', from: 'promote', to: 'end' },
        { id: 'e10', from: 'discard', to: 'end' },
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
        { ...startStep(), position: { x: 0, y: 120 } },
        { id: 'end', type: 'end', label: 'End', position: { x: 320, y: 120 }, config: {} },
      ],
      edges: [{ id: 'e1', from: 'start', to: 'end' }],
    },
  },
];
