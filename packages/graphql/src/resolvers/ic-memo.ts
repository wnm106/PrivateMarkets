import type { Context } from '../context';
import { emptyIcMemo, loadIcMemo } from '../lib/ic-memo';

export const icMemoResolvers = {
  Query: {
    icMemo: async (
      _: unknown,
      args: { dealId: string; asOfDate?: string | null },
      context: Context,
    ) => {
      try {
        return { ...(await loadIcMemo(context.supabase, args.dealId, args.asOfDate)), errors: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load the investment committee memo';
        return { ...emptyIcMemo(args.dealId), errors: [{ field: '', message, code: 'IC_MEMO' }] };
      }
    },
  },
};
