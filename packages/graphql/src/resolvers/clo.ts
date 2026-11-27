import type { Context } from '../context';
import { loadCloBook, loadCloDrift, loadCloOpportunities } from '../lib/clo-book-store';

type Dates = { asOfDate?: string | null; knowledgeDate?: string | null };

export const cloResolvers = {
  Query: {
    cloBook: async (_: unknown, args: { fundIds: string[] } & Dates, context: Context) =>
      loadCloBook(context.supabase, args),
    cloDrift: async (_: unknown, args: { fundId: string; quarters?: number | null } & Dates, context: Context) =>
      loadCloDrift(context.supabase, args),
    cloOpportunities: async (_: unknown, args: { fundId: string; limit?: number | null } & Dates, context: Context) =>
      loadCloOpportunities(context.supabase, args),
  },
};
