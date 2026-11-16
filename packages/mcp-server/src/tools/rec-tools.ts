import type { JSONSchema7 } from 'json-schema';
import { loadCashRec } from '@tapestrai/graphql/src/lib/cash-rec-store';
import { loadFundRec, loadFundRecBoard, summarize } from '@tapestrai/graphql/src/lib/fund-rec-store';
import { approveCashMatch, postCashAdjustment, recordRecDecision, saveRecNotes } from '@tapestrai/graphql/src/lib/rec-actions';
import { cashDigest, navDigest, positionDigest } from '@tapestrai/graphql/src/lib/rec-digest';
import { selectedIds } from '@tapestrai/graphql/src/lib/workflow-filters';
import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

/**
 * Fund reconciliation, for workflows: the NAV, position, and cash
 * reconciliation of one fund and one period, and the changes a reviewer can
 * make to it.
 *
 * The reading tools return the same reconciliation the pages draw, without the
 * per-figure sources. The changing tools write the same records the pages
 * write. None of them signs off or certifies a period: that stays with a person
 * on the reconciliation page.
 */

const period: Record<string, JSONSchema7> = {
  fundId: { type: 'string', description: 'The fund: its record id or its fund code.' },
  periodEnd: { type: 'string', description: 'Period end, YYYY-MM-DD. Leave out for the period now closing.' },
};

const paging: Record<string, JSONSchema7> = {
  offset: { type: 'number', description: 'Rows to skip. Use with the "NotShown" counts to read further.' },
  limit: { type: 'number', description: 'Rows to return in each list. Default 40.' },
};

function fund(args: Record<string, any>): string {
  const value = String(args.fundId || '').trim();
  if (!value) throw new Error('fundId is required: the fund record id or the fund code.');
  return value;
}

const periodEnd = (args: Record<string, any>): string | null => (args.periodEnd ? String(args.periodEnd) : null);

const listFundCloses: ToolDefinition = {
  name: 'list_fund_closes',
  description:
    'Funds with a close calendar and where each close stands: period, health, days to the certification target, breaks, open review items, and what is missing before it can be reconciled. entityIds limits it to those records; an empty list returns nothing, and a record that is not a fund with a close calendar is listed under notFunds. periodEnd reads that period for every fund instead of the one now closing.',
  category: 'reconciliation',
  inputSchema: {
    type: 'object',
    properties: {
      entityIds: { type: 'array', items: { type: 'string' }, description: 'Only these funds, by record id. Leave out for every fund.' },
      periodEnd: { type: 'string', description: 'Period end, YYYY-MM-DD. Leave out for the period each fund is now closing.' },
    },
  },
  execute: async (args, supabase) => {
    const ids = selectedIds(args.entityIds);
    const board = await loadFundRecBoard(supabase, null);
    const wanted = ids ? new Set(ids) : null;
    let rows = wanted ? board.funds.filter((row) => wanted.has(row.fundId)) : board.funds;
    const end = periodEnd(args);
    if (end) {
      rows = await Promise.all(rows.map(async (row) => {
        const rec = await loadFundRec(supabase, row.fundId, end, null, null);
        return summarize(rec, { fundCode: rec.fundCode, priorOpen: rec.priorOpen });
      }));
    }
    const onBoard = new Set(rows.map((row) => row.fundId));
    const notFunds = ids ? ids.filter((id) => !onBoard.has(id)) : [];
    return {
      asOfDate: board.asOfDate,
      // The board's totals cover every fund at its current period, so they are given only then.
      ...(wanted || end ? {} : { totals: board.totals }),
      count: rows.length,
      ...(notFunds.length > 0 ? { notFunds, note: `${notFunds.length} selected record${notFunds.length === 1 ? ' is' : 's are'} not a fund with a close calendar, and ${notFunds.length === 1 ? 'is' : 'are'} left out.` } : {}),
      funds: rows.map((row) => ({
        fundId: row.fundId,
        fundCode: row.fundCode,
        fundName: row.fundName,
        periodEnd: row.periodEnd,
        periodLabel: row.periodLabel,
        health: row.health,
        healthNote: row.healthNote,
        atRisk: row.atRisk,
        targetDate: row.targetDate,
        daysToTarget: row.daysToTarget,
        readyForRec: row.readyForRec,
        gaps: row.gaps,
        breaks: row.breaks,
        missing: row.missing,
        itemsOpen: row.itemsOpen,
        queries: row.queries,
        certified: row.certified,
        priorPeriodOpen: row.priorOpen,
        nextStep: row.nextStep,
      })),
    };
  },
};

const getNavReconciliation: ToolDefinition = {
  name: 'get_nav_reconciliation',
  description:
    'The NAV reconciliation of one fund for one period. Returns whether the administrator pack and our books are on file (readiness), every tie-out check with both figures and the difference, the statement lines where the administrator and the internal amount disagree or that moved sharply, the review items waiting for a decision (each with an itemId), the management and performance fee recalculation, unexplained drift since the prior period, the close steps, and any reconciliation notes already kept. Amounts are whole dollars.',
  category: 'reconciliation',
  inputSchema: { type: 'object', properties: { ...period }, required: ['fundId'] },
  execute: async (args, supabase) => navDigest(await loadFundRec(supabase, fund(args), periodEnd(args), null, null)),
};

const getPositionReconciliation: ToolDefinition = {
  name: 'get_position_reconciliation',
  description:
    'The position reconciliation of one fund for one period: the roll-forward of every position from opening to closing fair value, whether its totals tie to the administrator statements line by line, each position\'s administrator mark against the agent mark, and accrued interest against our own accrual. Amounts are whole dollars; marks are in points.',
  category: 'reconciliation',
  inputSchema: { type: 'object', properties: { ...period, ...paging }, required: ['fundId'] },
  execute: async (args, supabase) =>
    positionDigest(await loadFundRec(supabase, fund(args), periodEnd(args), null, null), { offset: Number(args.offset) || 0, limit: Number(args.limit) || undefined }),
};

const getCashReconciliation: ToolDefinition = {
  name: 'get_cash_reconciliation',
  description:
    'The cash reconciliation of one fund for one period: positional cash flows against bank transactions. Returns the tie-out and residual, the pairs the matching rules propose (each with the bankTxnId and flowIds an approval needs, the rule, its confidence, and the variance), the cash flows and bank transactions still unmatched, adjustments already posted, and the single entry that would clear the residual.',
  category: 'reconciliation',
  inputSchema: { type: 'object', properties: { ...period, ...paging }, required: ['fundId'] },
  execute: async (args, supabase) =>
    cashDigest(await loadCashRec(supabase, fund(args), periodEnd(args), null, null), { offset: Number(args.offset) || 0, limit: Number(args.limit) || undefined }),
};

const recordDecision: ToolDefinition = {
  name: 'record_rec_decision',
  description:
    'Record the decision on one review item of a fund close. ACCEPT takes the administrator\'s figure. ADJUST proposes our figure instead, which changes the proposed NAV by the item\'s NAV effect. QUERY sends the item back to the administrator and holds the close open. itemId comes from get_nav_reconciliation. A note is required for ADJUST and QUERY, and is kept on the file. Replaces an earlier decision on the same item. Refused on a certified period.',
  category: 'reconciliation',
  inputSchema: {
    type: 'object',
    properties: {
      ...period,
      itemId: { type: 'string', description: 'The review item, from get_nav_reconciliation: "fee", "perf", "int", "pos:<position id>", or a drift id.' },
      decision: { type: 'string', enum: ['ACCEPT', 'ADJUST', 'QUERY'] },
      note: { type: 'string', description: 'Why, for the file. For QUERY, the question to put to the administrator.' },
    },
    required: ['fundId', 'itemId', 'decision'],
  },
  execute: async (args, supabase) =>
    recordRecDecision(supabase, { fundId: fund(args), periodEnd: periodEnd(args), itemId: String(args.itemId || ''), decision: String(args.decision || '').toUpperCase() as never, note: args.note ? String(args.note) : '' }),
};

const approveMatch: ToolDefinition = {
  name: 'approve_cash_match',
  description:
    'Pair one bank transaction with the positional cash flows it settled, and lock the pair. bankTxnId and flowIds come from get_cash_reconciliation. A pair the matching rules already propose keeps that rule and its confidence; any other pair is recorded as a manual match with the variance between the two sides. Refused when either side is already paired.',
  category: 'reconciliation',
  inputSchema: {
    type: 'object',
    properties: {
      ...period,
      bankTxnId: { type: 'string', description: 'The bank transaction record id.' },
      flowIds: { type: 'array', items: { type: 'string' }, description: 'The cash flow record ids paired to it.' },
    },
    required: ['fundId', 'bankTxnId', 'flowIds'],
  },
  execute: async (args, supabase) =>
    approveCashMatch(supabase, { fundId: fund(args), periodEnd: periodEnd(args), bankTxnId: String(args.bankTxnId || ''), flowIds: Array.isArray(args.flowIds) ? args.flowIds.map(String) : [] }),
};

const postAdjustment: ToolDefinition = {
  name: 'post_cash_adjustment',
  description:
    'Post a reconciling entry to one side of the cash reconciliation, for a difference that is understood and will not be matched: a bank fee not yet booked, a timing item. side is POSITION (our books) or BANK. amount is signed dollars. A reason is required. An adjustment does not explain a difference, it records one, so post it only for a difference whose cause is established.',
  category: 'reconciliation',
  inputSchema: {
    type: 'object',
    properties: {
      ...period,
      amount: { type: 'number', description: 'Signed dollars. Money leaving the fund is negative.' },
      side: { type: 'string', enum: ['POSITION', 'BANK'] },
      reason: { type: 'string', description: 'What the difference is and why it is adjusted rather than matched.' },
    },
    required: ['fundId', 'amount', 'side', 'reason'],
  },
  execute: async (args, supabase) =>
    postCashAdjustment(supabase, { fundId: fund(args), periodEnd: periodEnd(args), amount: Number(args.amount), side: String(args.side || '').toUpperCase() as never, reason: String(args.reason || '') }),
};

const saveNotes: ToolDefinition = {
  name: 'save_reconciliation_notes',
  description:
    'Keep the reconciliation notes for one fund and one period on its close record, where the reconciliation page shows them. notes is the full write-up in Markdown. Replaces notes saved earlier for the same period; earlier versions stay in the record\'s history. Beside the notes the platform stores a one-line outcome that it reads from the reconciliation itself at the moment of saving, so make this the last change applied.',
  category: 'reconciliation',
  inputSchema: {
    type: 'object',
    properties: {
      ...period,
      notes: { type: 'string', description: 'The notes, in Markdown.' },
    },
    required: ['fundId', 'notes'],
  },
  execute: async (args, supabase) => saveRecNotes(supabase, { fundId: fund(args), periodEnd: periodEnd(args), notes: String(args.notes || '') }),
};

export function registerRecTools(registry: ToolRegistry) {
  registry.registerTool(listFundCloses);
  registry.registerTool(getNavReconciliation);
  registry.registerTool(getPositionReconciliation);
  registry.registerTool(getCashReconciliation);
  registry.registerTool(recordDecision);
  registry.registerTool(approveMatch);
  registry.registerTool(postAdjustment);
  registry.registerTool(saveNotes);
}
