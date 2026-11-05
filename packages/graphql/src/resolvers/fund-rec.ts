import type { Context } from '../context';
import { loadFundRec, loadFundRecBoard } from '../lib/fund-rec-store';

export const fundRecResolvers = {
  Query: {
    fundRecBoard: async (_: unknown, args: { asOfDate?: string | null; knowledgeDate?: string | null }, context: Context) =>
      loadFundRecBoard(context.supabase, args.asOfDate, args.knowledgeDate),
    fundRec: async (
      _: unknown,
      args: { fundId: string; periodEnd?: string | null; asOfDate?: string | null; knowledgeDate?: string | null; driftThresholdPct?: number | null },
      context: Context,
    ) => loadFundRec(context.supabase, args.fundId, args.periodEnd, args.asOfDate, args.knowledgeDate, args.driftThresholdPct ?? 10),
  },
};
