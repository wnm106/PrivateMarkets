import type { Context } from '../context';
import type { CashRec } from '../lib/cash-rec';
import { loadCashRec } from '../lib/cash-rec-store';
import { loadFundRec, loadFundRecBoard } from '../lib/fund-rec-store';

type RecArgs = { fundId: string; periodEnd?: string | null; asOfDate?: string | null; knowledgeDate?: string | null };

/**
 * The page asks for a close and its cash reconciliation in one request, and the
 * close holds on the cash reconciliation. Both read it once.
 */
const cashReads = new WeakMap<Context, Map<string, Promise<CashRec>>>();

function cashRecOnce(context: Context, args: RecArgs): Promise<CashRec> {
  const reads = cashReads.get(context) ?? new Map<string, Promise<CashRec>>();
  cashReads.set(context, reads);
  const key = [args.fundId, args.periodEnd ?? '', args.asOfDate ?? '', args.knowledgeDate ?? ''].join('|');
  let read = reads.get(key);
  if (!read) {
    read = loadCashRec(context.supabase, args.fundId, args.periodEnd, args.asOfDate, args.knowledgeDate);
    reads.set(key, read);
  }
  return read;
}

export const fundRecResolvers = {
  Query: {
    fundRecBoard: async (_: unknown, args: { asOfDate?: string | null; knowledgeDate?: string | null }, context: Context) =>
      loadFundRecBoard(context.supabase, args.asOfDate, args.knowledgeDate),
    fundRec: async (_: unknown, args: RecArgs & { driftThresholdPct?: number | null }, context: Context) =>
      loadFundRec(context.supabase, args.fundId, args.periodEnd, args.asOfDate, args.knowledgeDate, args.driftThresholdPct ?? null, {
        cashRec: cashRecOnce(context, args),
      }),
    cashRec: async (_: unknown, args: RecArgs, context: Context) => cashRecOnce(context, args),
  },
};
