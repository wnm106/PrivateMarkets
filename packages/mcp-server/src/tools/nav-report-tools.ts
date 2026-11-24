import type { JSONSchema7 } from 'json-schema';
import { loadFundRec } from '@tapestrai/graphql/src/lib/fund-rec-store';
import { summarizeBreaks } from '@tapestrai/graphql/src/lib/nav-breaks';
import { saveRecNotes } from '@tapestrai/graphql/src/lib/rec-actions';
import { userIdOf } from '../agent/harness';
import { indexImportFile } from '../feeds/import-document';
import { loadNavReport, readNavReport } from '../feeds/nav-report';
import { sessionClientId } from '../feeds/session-client';
import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

/**
 * A NAV reconciliation from a filed report, for workflows and the assistant:
 * read what a stored 10-Q or annual report holds and how it maps onto the
 * fund's NAV statement, load it, summarize the breaks of the reconciliation
 * that follows, and keep that summary as the close's notes. The summary reads
 * the same reconciliation the fund's reconciliation page draws.
 */

const selection: JSONSchema7 = { type: 'array', items: { type: 'string' }, description: 'The Select records step\'s records. The first fund among them is the fund.' };

const fundProperty: JSONSchema7 = {
  description: 'The fund: its record id or fund code. Leave out to use the selection, or, for a report, the fund whose name or alias is the reporting entity\'s.',
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

function given(args: Record<string, any>): string | null {
  const raw = args.fundId;
  const value = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
  return value.trim() || null;
}

function selected(args: Record<string, any>): string[] {
  return Array.isArray(args.entityIds) ? args.entityIds.map(String).filter(Boolean) : [];
}

/** The fund a reconciliation tool reads: the one given, else the first selected. */
function fund(args: Record<string, any>): string {
  const value = given(args) || selected(args)[0] || '';
  if (!value) throw new Error('fundId is required: the fund, or the Select records step\'s records.');
  return value;
}

const readNavReportTool: ToolDefinition = {
  name: 'get_nav_report',
  description:
    'What a stored financial report (a 10-Q, a 10-K, an annual report) holds and what loading it would write: the fund it is for (given, selected, or the fund named as the reporting entity), the period end and the date it compares with, each statement\'s lines on the NAV chart with both figures and the report lines behind them, the lines left out and why, the schedule of investments by asset class, the report\'s own checks, and a trial load that writes nothing. holds lists what a person has to look at before it loads; autoLoad is true when there is nothing. Amounts are whole dollars.',
  category: 'reconciliation',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'The stored file, from list_position_file_imports.' },
      fundId: fundProperty,
      entityIds: selection,
      periodEnd: { type: 'string', description: 'YYYY-MM-DD. Leave out for the report\'s latest balance sheet date.' },
      trial: { type: 'boolean', description: 'Run the load without writing and report its counts. Default true.' },
    },
    required: ['instanceId'],
  },
  execute: async (args, supabase) => readNavReport(String(args.instanceId), await sessionClientId(supabase), {
    fundId: given(args),
    entityIds: selected(args),
    periodEnd: text(args.periodEnd),
    trial: args.trial !== false,
  }),
};

const loadNavReportTool: ToolDefinition = {
  name: 'load_nav_report',
  description:
    'Load a stored financial report onto its fund as the administrator\'s figures: the NAV statement at the period end and at the date it compares with, the flows for the months between, the report\'s own checks, and one position per investment in the schedule of investments at the period end. One batch, which Load data can revert. A report with holds (see get_nav_report) is refused unless confirmed is true, which only a person\'s confirmation should set. Loading the same report again changes nothing already on file. The report is also kept as a searchable document if it is not one already, every page of it, so its notes and footnotes can be read and searched.',
  category: 'reconciliation',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'The stored file, from list_position_file_imports.' },
      fundId: fundProperty,
      entityIds: selection,
      periodEnd: { type: 'string', description: 'YYYY-MM-DD. Leave out for the report\'s latest balance sheet date.' },
      receivedDate: { type: 'string', description: 'YYYY-MM-DD the report arrived. Leave out for today.' },
      confirmed: { type: 'boolean', description: 'A person checked the report and confirmed it should load despite its holds.' },
    },
    required: ['instanceId'],
  },
  execute: async (args, supabase) => {
    const clientId = await sessionClientId(supabase);
    const loaded = await loadNavReport(String(args.instanceId), clientId, {
      fundId: given(args),
      entityIds: selected(args),
      periodEnd: text(args.periodEnd),
      receivedDate: text(args.receivedDate),
      confirmed: args.confirmed === true || args.confirmed === 'true',
      userId: await userIdOf(supabase),
    });
    // Never fails the load: a report that cannot be indexed still loaded, and the note says why it was not.
    const document = await indexImportFile(String(args.instanceId), clientId).catch(() => null);
    return document ? { ...loaded, document: { indexed: document.indexed, documentId: document.documentId, note: document.note } } : loaded;
  },
};

const summarizeBreaksTool: ToolDefinition = {
  name: 'get_nav_breaks',
  description:
    'The breaks of one fund\'s NAV reconciliation for one period, summarized for the person who signs it: each tie-out check that breaks, each check that cannot be made because a figure is missing, each review item still open, and each input not on file. Each comes with both figures, the difference, what usually causes it, what settles it and who does that, and the whole as markdown. pack lists the ten parts of the NAV pack (NAV bridge, trial balance, financial statements, capital accounts, management fee, carry and waterfall, valuation support, calls and distributions, commitments, FX) with whether each is on file and ties, and the entry of a pack check names its component. needsDecision is true when something breaks or a review item is open. Reads the same reconciliation as get_nav_reconciliation. Amounts are whole dollars.',
  category: 'reconciliation',
  inputSchema: {
    type: 'object',
    properties: {
      fundId: fundProperty,
      entityIds: selection,
      periodEnd: { type: 'string', description: 'Period end, YYYY-MM-DD. Leave out for the period now closing.' },
    },
    required: [],
  },
  execute: async (args, supabase) => {
    const review = await loadFundRec(supabase, fund(args), text(args.periodEnd), null, null);
    const summary = summarizeBreaks(review);
    const needsDecision = summary.counts.breaks > 0 || summary.counts.items > 0;
    return { ...summary, needsDecision, hasBreaks: needsDecision };
  },
};

const saveNavNotesTool: ToolDefinition = {
  name: 'save_nav_notes',
  description:
    'Keep the break summary of one fund\'s NAV reconciliation as the reconciliation notes on the period\'s close, with the outcome line the platform reads from the reconciliation itself. Written from the reconciliation, not by a model, so a run that needs no decision ends with its notes kept. Saving again replaces the notes; earlier versions stay in the close\'s history. Refused on a certified period.',
  category: 'reconciliation',
  inputSchema: {
    type: 'object',
    properties: {
      fundId: fundProperty,
      entityIds: selection,
      periodEnd: { type: 'string', description: 'Period end, YYYY-MM-DD.' },
    },
    required: [],
  },
  execute: async (args, supabase) => {
    const review = await loadFundRec(supabase, fund(args), text(args.periodEnd), null, null);
    if (review.certified) throw new Error(`${review.fundName} ${review.periodLabel} is certified. Its notes are not changed.`);
    const summary = summarizeBreaks(review);
    const saved = await saveRecNotes(supabase, { fundId: review.fundId, periodEnd: review.periodEnd, notes: summary.markdown });
    return { ...saved, headline: summary.headline, counts: summary.counts };
  },
};

export function registerNavReportTools(registry: ToolRegistry): void {
  registry.registerTool(readNavReportTool);
  registry.registerTool(loadNavReportTool);
  registry.registerTool(summarizeBreaksTool);
  registry.registerTool(saveNavNotesTool);
}
