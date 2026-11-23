import type { Context } from '../context';
import {
  commitAllocation,
  loadAllocationDraft,
  previewFromDraft,
  type AllocationHold,
  type AllocationPreview,
} from '../lib/allocation-store';
import type { AllocationAdjustment } from '../lib/allocation-engine';
import { storeDealPerformance } from '../lib/deal-performance-store';
import { activeCertification } from '../lib/certification-store';

/** The certification process a deal's allocation is certified under (golden_master.certification_processes). */
export const ALLOCATION_PROCESS = 'DEAL_ALLOCATION';

/** GraphQL adjustment inputs as engine adjustments. `saved` is kept so a saved amount is not read as an override. */
export function adjustments(input: any[] | null | undefined): AllocationAdjustment[] | null {
  if (!input) return null;
  return input.map((item) => ({
    fundId: item.fundId,
    trancheId: item.trancheId,
    type: item.type === 'exclude' ? 'exclude' : 'override',
    amount: item.amount == null ? undefined : Number(item.amount),
    reason: item.reasonCode || undefined,
    note: item.note || undefined,
    saved: item.saved === true ? true : undefined,
  }));
}

export function holds(input: any[] | null | undefined): AllocationHold[] | null {
  if (!input) return null;
  return input.map((item) => ({ trancheId: item.trancheId, holdPct: Number(item.holdPct) }));
}

async function build(
  context: Context,
  dealId: string,
  asOfDate: string | null | undefined,
  holdInput: any[] | null | undefined,
  adjustmentInput: any[] | null | undefined,
  knowledgeDate?: string | null,
): Promise<AllocationPreview> {
  // Always read the compliance capacities. Without them the engine falls back
  // to the fund's own issuer, sponsor and unfunded limits, and the first view
  // of the saved book shows allocations no compliance rule capped.
  const draft = await loadAllocationDraft(context.supabase, dealId, asOfDate, holds(holdInput), adjustments(adjustmentInput), knowledgeDate);
  return previewFromDraft(draft);
}

export const allocationResolvers = {
  Query: {
    previewAllocation: async (
      _: unknown,
      args: { dealId: string; asOfDate?: string | null; knowledgeDate?: string | null; holds?: any[] | null; adjustments?: any[] | null },
      context: Context,
    ) => {
      try {
        return { ...(await build(context, args.dealId, args.asOfDate, args.holds, args.adjustments, args.knowledgeDate)), errors: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not preview the allocation';
        return emptyPreview(args.dealId, message);
      }
    },
    periodReturns: async (
      _: unknown,
      args: { entityIds: string[]; attributeCodes: string[]; startDate?: string | null; endDate?: string | null },
      context: Context,
    ) => {
      const day = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? String(value).slice(0, 10) : null);
      const end = day(args.endDate) || new Date().toISOString().slice(0, 10);
      const start = day(args.startDate);
      if (!args.entityIds.length || !args.attributeCodes.length) return [];
      const { data, error } = await context.supabase.schema('golden_master').rpc('period_returns', {
        p_entity_ids: args.entityIds,
        p_attribute_codes: args.attributeCodes,
        p_start: start,
        p_end: end,
      });
      if (error) throw new Error(error.message);
      return ((data || []) as Array<{ entity_id: string; attribute_code: string; value: number | string | null }>).map((row) => ({
        entityId: row.entity_id,
        attributeCode: row.attribute_code,
        startDate: start,
        endDate: end,
        value: row.value == null ? null : Number(row.value),
      }));
    },
  },
  Mutation: {
    commitAllocation: async (
      _: unknown,
      args: { dealId: string; asOfDate?: string | null; holds?: any[] | null; adjustments?: any[] | null },
      context: Context,
    ) => {
      try {
        // A certified allocation is pinned to what was known when it was certified. Reopen it first.
        if (await activeCertification(context.supabase, ALLOCATION_PROCESS, args.dealId)) {
          return emptyPreview(args.dealId, 'This allocation is certified. Reopen it before changing it.');
        }
        const draft = await loadAllocationDraft(
          context.supabase,
          args.dealId,
          args.asOfDate,
          holds(args.holds),
          adjustments(args.adjustments) ?? [],
        );
        const committed = await commitAllocation(context.supabase, draft, context.user?.id ?? null);
        // The stored performance figures follow the committed allocation. A failure here does not undo the commit.
        try {
          await storeDealPerformance(context.supabase, args.dealId, args.asOfDate, context.user?.id ?? null);
        } catch (error) {
          console.error('Deal performance was not refreshed after commit', error);
        }
        return { ...committed, errors: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not commit the allocation';
        return emptyPreview(args.dealId, message);
      }
    },
    refreshDealPerformance: async (
      _: unknown,
      args: { dealId: string; asOfDate?: string | null },
      context: Context,
    ) => {
      try {
        const result = await storeDealPerformance(context.supabase, args.dealId, args.asOfDate, context.user?.id ?? null);
        return { dealId: args.dealId, asOfDate: result.asOf, written: result.written, closed: result.closed, unchanged: result.unchanged, errors: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not refresh deal performance';
        return { dealId: args.dealId, asOfDate: null, written: 0, closed: 0, unchanged: 0, errors: [{ field: 'dealId', message, code: 'PERFORMANCE_REFRESH_FAILED' }] };
      }
    },
  },
};

function emptyPreview(dealId: string, message: string): AllocationPreview & { errors: Array<{ field: string; message: string; code: string }> } {
  return {
    dealId,
    dealCode: '',
    dealName: '',
    description: '',
    stage: '',
    strategy: '',
    borrower: '',
    sponsor: '',
    pricing: '',
    oid: '',
    leverage: '',
    maturity: '',
    closeDate: '',
    facts: { description: '', stage: '', strategy: '', borrower: '', borrowerId: '', sponsor: '', sponsorId: '', pricing: '', oid: '', leverage: '', maturity: '', closeDate: '' },
    facilitySize: 0,
    targetHold: 0,
    allocated: 0,
    unallocated: 0,
    tranches: [],
    rows: [],
    adjustments: [],
    capacities: [],
    errors: [{ field: '', message, code: 'ALLOCATION' }],
  } as AllocationPreview & { errors: Array<{ field: string; message: string; code: string }> };
}
