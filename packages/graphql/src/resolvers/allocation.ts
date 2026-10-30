import type { Context } from '../context';
import {
  commitAllocation,
  loadAllocationDraft,
  previewFromDraft,
  type AllocationHold,
  type AllocationPreview,
} from '../lib/allocation-store';
import type { AllocationAdjustment } from '../lib/allocation-engine';

function adjustments(input: any[] | null | undefined): AllocationAdjustment[] | null {
  if (!input) return null;
  return input.map((item) => ({
    fundId: item.fundId,
    trancheId: item.trancheId,
    type: item.type === 'exclude' ? 'exclude' : 'override',
    amount: item.amount == null ? undefined : Number(item.amount),
    reason: item.reasonCode || undefined,
    note: item.note || undefined,
  }));
}

function holds(input: any[] | null | undefined): AllocationHold[] | null {
  if (!input) return null;
  return input.map((item) => ({ trancheId: item.trancheId, holdPct: Number(item.holdPct) }));
}

async function build(
  context: Context,
  dealId: string,
  asOfDate: string | null | undefined,
  holdInput: any[] | null | undefined,
  adjustmentInput: any[] | null | undefined,
): Promise<AllocationPreview> {
  const draft = await loadAllocationDraft(context.supabase, dealId, asOfDate, holds(holdInput), adjustments(adjustmentInput));
  return previewFromDraft(draft);
}

export const allocationResolvers = {
  Query: {
    previewAllocation: async (
      _: unknown,
      args: { dealId: string; asOfDate?: string | null; holds?: any[] | null; adjustments?: any[] | null },
      context: Context,
    ) => {
      try {
        return { ...(await build(context, args.dealId, args.asOfDate, args.holds, args.adjustments)), errors: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not preview the allocation';
        return emptyPreview(args.dealId, message);
      }
    },
  },
  Mutation: {
    commitAllocation: async (
      _: unknown,
      args: { dealId: string; asOfDate?: string | null; holds?: any[] | null; adjustments?: any[] | null },
      context: Context,
    ) => {
      try {
        const draft = await loadAllocationDraft(
          context.supabase,
          args.dealId,
          args.asOfDate,
          holds(args.holds),
          adjustments(args.adjustments) ?? [],
        );
        return { ...(await commitAllocation(context.supabase, draft, context.user?.id ?? null)), errors: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not commit the allocation';
        return emptyPreview(args.dealId, message);
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
    errors: [{ field: '', message, code: 'ALLOCATION' }],
  };
}
