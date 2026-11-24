import type { Context } from '../context';
import { loadBorrowerFinancials } from '../lib/borrower-financials-store';
import { mapCovenantChoice, mapCovenantTest } from '../lib/covenant-test';

/**
 * Covenant tests and definitions. Every read and write goes through the
 * public covenant_* functions, which check the caller can see (or change)
 * the covenant before touching it.
 */

type Row = Record<string, unknown>;

function failure(error: { message?: string } | null, fallback: string): Error {
  return new Error(error?.message || fallback);
}

async function readTest(context: Context, covenantId: string, asOfDate?: string | null, history?: number | null) {
  const { data, error } = await context.supabase.rpc('covenant_test', {
    p_covenant_id: covenantId,
    p_as_of: asOfDate || null,
    p_history: history ?? 8,
  });
  if (error) throw failure(error, 'The covenant could not be read.');
  return data ? mapCovenantTest(data as Row) : null;
}

export const covenantResolvers = {
  Query: {
    covenantTest: async (_: unknown, args: { covenantId: string; asOfDate?: string | null; history?: number | null }, context: Context) =>
      readTest(context, args.covenantId, args.asOfDate, args.history),

    dealCovenantTests: async (_: unknown, args: { dealId: string; asOfDate?: string | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('deal_covenant_tests', {
        p_deal_id: args.dealId,
        p_as_of: args.asOfDate || null,
      });
      if (error) throw failure(error, 'The deal\'s covenants could not be read.');
      return (Array.isArray(data) ? data : []).filter(Boolean).map((row) => mapCovenantTest(row as Row));
    },

    borrowerFinancials: async (
      _: unknown,
      args: { borrowerId: string; periodEnd?: string | null; asOfDate?: string | null; knowledgeDate?: string | null },
      context: Context,
    ) => (await loadBorrowerFinancials(context.supabase, args.borrowerId, args.periodEnd, args.asOfDate, args.knowledgeDate)).financials,

    covenantLibrary: async (_: unknown, args: { asOfDate?: string | null }, context: Context) => {
      const { data, error } = await context.supabase.rpc('covenant_library', { p_as_of: args.asOfDate || null });
      if (error) throw failure(error, 'The definition library could not be read.');
      return (Array.isArray(data) ? data : []).map((row) => mapCovenantChoice(row as Row));
    },
  },

  Mutation: {
    copyCovenantDefinition: async (
      _: unknown,
      args: { covenantId: string; fromCovenantId: string; effectiveFrom: string },
      context: Context,
    ) => {
      const { error } = await context.supabase.rpc('copy_covenant_definition', {
        p_covenant_id: args.covenantId,
        p_from_covenant_id: args.fromCovenantId,
        p_effective_from: args.effectiveFrom,
      });
      if (error) throw failure(error, 'The definition could not be copied.');
      const test = await readTest(context, args.covenantId);
      if (!test) throw new Error('Covenant not found');
      return test;
    },

    recalculateCovenant: async (_: unknown, args: { covenantId: string }, context: Context) => {
      const { error } = await context.supabase.rpc('recalculate_covenant', { p_covenant_id: args.covenantId });
      if (error) throw failure(error, 'The covenant could not be recalculated.');
      const test = await readTest(context, args.covenantId);
      if (!test) throw new Error('Covenant not found');
      return test;
    },
  },
};
