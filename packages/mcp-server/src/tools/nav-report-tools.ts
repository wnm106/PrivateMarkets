import type { JSONSchema7 } from 'json-schema';
import { loadFundRec } from '@tapestrai/graphql/src/lib/fund-rec-store';
import { summarizeBreaks } from '@tapestrai/graphql/src/lib/nav-breaks';
import { userIdOf } from '../agent/harness';
import { loadNavReport, readNavReport } from '../feeds/nav-report';
import { sessionClientId } from '../feeds/session-client';
import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

/**
 * A NAV reconciliation from a filed report, for workflows and the assistant:
 * read what a stored 10-Q or annual report holds and how it maps onto the
 * fund's NAV statement, load it, and summarize the breaks of the
 * reconciliation that follows. The summary reads the same reconciliation the
 * fund's reconciliation page draws.
 */

const selection: JSONSchema7 = { type: 'array', items: { type: 'string' }, description: 'The Select records step\'s records. The first is the fund. Give this or fundId.' };

const fundProperty: JSONSchema7 = {
  description: 'The fund the report is for: its record id or fund code. A list of ids takes the first, so the Select records step can be passed as it is.',
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
};

function fund(args: Record<string, any>): string {
  const raw = args.fundId ?? args.entityIds;
  const value = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
  if (!value.trim()) throw new Error('fundId is required: the fund the report is for.');
  return value.trim();
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const readNavReportTool: ToolDefinition = {
  name: 'get_nav_report',
  description:
    'What a stored financial report (a 10-Q, a 10-K, an annual report) holds and what loading it onto a fund would write: the period end and the date it compares with, each statement\'s lines on the NAV chart with both figures and the report lines behind them, the lines left out and why, the schedule of investments by asset class, the report\'s own checks of its subtotals and share-class NAV, and a trial load that writes nothing. Amounts are whole dollars.',
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
    fundId: fund(args),
    periodEnd: text(args.periodEnd),
    trial: args.trial !== false,
  }),
};

const loadNavReportTool: ToolDefinition = {
  name: 'load_nav_report',
  description:
    'Load a stored financial report onto a fund as the administrator\'s figures: the NAV statement at the period end and at the date it compares with, the flows for the months between, the report\'s own checks, and one position per investment in the schedule of investments at the period end. One batch, which Load data can revert. Loading the same report again changes nothing already on file.',
  category: 'reconciliation',
  inputSchema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'The stored file, from list_position_file_imports.' },
      fundId: fundProperty,
      entityIds: selection,
      periodEnd: { type: 'string', description: 'YYYY-MM-DD. Leave out for the report\'s latest balance sheet date.' },
      receivedDate: { type: 'string', description: 'YYYY-MM-DD the report arrived. Leave out for today.' },
    },
    required: ['instanceId'],
  },
  execute: async (args, supabase) => loadNavReport(String(args.instanceId), await sessionClientId(supabase), {
    fundId: fund(args),
    periodEnd: text(args.periodEnd),
    receivedDate: text(args.receivedDate),
    userId: await userIdOf(supabase),
  }),
};

const summarizeBreaksTool: ToolDefinition = {
  name: 'get_nav_breaks',
  description:
    'The breaks of one fund\'s NAV reconciliation for one period, summarized for the person who signs it: each tie-out check that breaks, each check that cannot be made because a figure is missing, each review item still open, and each input not on file. Each comes with both figures, the difference, what usually causes it, what settles it and who does that, and the whole as markdown. Reads the same reconciliation as get_nav_reconciliation. Amounts are whole dollars.',
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
    return { ...summary, hasBreaks: summary.counts.breaks > 0 || summary.counts.items > 0 };
  },
};

export function registerNavReportTools(registry: ToolRegistry): void {
  registry.registerTool(readNavReportTool);
  registry.registerTool(loadNavReportTool);
  registry.registerTool(summarizeBreaksTool);
}
