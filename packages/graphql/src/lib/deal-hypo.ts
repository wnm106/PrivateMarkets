/**
 * A Hypo run tests a what-if allocation for one deal against the compliance
 * rules on the deal's funds, without touching the deal's saved allocation.
 *
 * The allocation in the request is written as positions tagged
 * '<deal code>#HYPO'. Each rule is scored on that scenario (after) and, when
 * asked, on '<deal code>#BEFORE' (the book without this deal). The scenario
 * rule in compliance.include_in_scenario keeps the two apart: Hypo positions
 * count only in the Hypo scenario, and both variants leave out the deal's
 * saved proposals.
 */

import type { Context } from '../context';
import { commitAllocation, loadAllocationDraft, type AllocationHold } from './allocation-store';
import type { AllocationAdjustment } from './allocation-engine';
import { dealSurfaceResults, loadDealScorePlans, scoreDealFunds } from './deal-compliance';

export interface DealScoreArgs {
  dealId: string;
  asOfDate?: string | null;
  holds?: any[] | null;
  adjustments?: any[] | null;
}

export function hypoScenarioCode(dealCode: string): string {
  return `${dealCode}#HYPO`;
}

export function beforeScenarioCode(dealCode: string): string {
  return `${dealCode}#BEFORE`;
}

function parseHolds(input: any[] | null | undefined): AllocationHold[] | null {
  if (!input) return null;
  return input.map((item) => ({ trancheId: item.trancheId, holdPct: Number(item.holdPct) }));
}

function parseAdjustments(input: any[] | null | undefined): AllocationAdjustment[] | null {
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

export async function runDealHypo(context: Context, args: DealScoreArgs, withBefore: boolean) {
  // Hypo positions are engine rows, not a user edit. The caller's JWT cannot
  // insert them under the entity RLS policies, so the write uses the service
  // role. The rules themselves still run as the compliance functions.
  const writer = context.supabaseAdmin || context.supabase;
  const draft = await loadAllocationDraft(writer, args.dealId, args.asOfDate, parseHolds(args.holds), parseAdjustments(args.adjustments));
  const scenarioCode = hypoScenarioCode(draft.dealCode);
  const preview = await commitAllocation(writer, draft, context.user?.id ?? null, { scenarioCode });
  const fundIds = new Set(preview.rows.map((row) => row.fundId));

  // Which rules this deal is scored on, for which funds, is one database
  // function shared with the deal score and capacity.
  const compliance = writer.schema('compliance');
  const plans = await loadDealScorePlans(compliance, fundIds, draft.asOf);
  if (!plans.length) throw new Error('No compliance rules with limits are assigned to the funds on this deal.');
  const { data: versionRows, error: versionError } = await compliance
    .from('rule_versions')
    .select('*')
    .in('rule_id', plans.map((plan) => plan.rule.id))
    .eq('is_active', true);
  if (versionError) throw new Error(versionError.message);
  const versionByRule = new Map<string, any>();
  for (const version of versionRows || []) {
    const current = versionByRule.get(version.rule_id);
    if (!current || version.version_number > current.version_number) versionByRule.set(version.rule_id, version);
  }

  const failures: string[] = [];
  // Every rule for one scenario is one database call, the same path the deal
  // score uses. A failed scenario is reported, and the other still shows.
  const score = async (code: string) => {
    try {
      const results = await scoreDealFunds(compliance, plans, draft.asOf, code, context.user?.id ?? null);
      return results.filter((result) => fundIds.has(result.anchorEntityId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!failures.includes(message)) failures.push(message);
      return [];
    }
  };
  // Before and after run one after the other: run together, the rules compete
  // for the database and the slowest one can hit the statement timeout.
  const hypoIdsRead = scenarioPositionIds(writer, scenarioCode);
  const after = await score(scenarioCode);
  const before = withBefore ? await score(beforeScenarioCode(draft.dealCode)) : [];
  const hypoIds = await hypoIdsRead;
  if (!after.length && failures.length) throw new Error(failures[0]);

  return {
    scenarioCode,
    asOfDate: draft.asOf,
    rules: plans.map(({ rule: row, groupLabel }) => {
      const version = versionByRule.get(row.id);
      return {
        groupLabel,
        id: row.id,
        ruleCode: row.rule_code,
        ruleName: row.rule_name,
        ruleCategory: row.rule_category,
        resultUnit: version?.result_unit || null,
        limitDirection: version?.limit_direction || null,
        groupByAttributeCode: version?.group_by_attribute_code || null,
        consolidateDescendants: Boolean(version?.consolidate_descendants),
        isActive: row.is_active,
      };
    }),
    before,
    after,
    surfaceResults: dealSurfaceResults(after, fundIds, hypoIds),
    allocations: preview.rows.map((row) => ({
      fundId: row.fundId,
      fundName: row.fundName,
      parentFundId: row.parentFundId,
      level: row.level,
      amount: row.total,
    })),
    errors: failures.map((message) => ({ field: 'general', message, code: 'EVALUATE_FAILED' })),
  };
}

async function scenarioPositionIds(writer: any, code: string): Promise<Set<string>> {
  const { data: scenarioAttribute } = await writer
    .from('attribute_register')
    .select('id')
    .eq('attribute_code', 'POSITION_SCENARIO_CODE')
    .maybeSingle();
  if (!scenarioAttribute) return new Set();
  const { data: scenarioRows } = await writer
    .from('entity_attribute_values')
    .select('entity_id')
    .eq('attribute_id', scenarioAttribute.id)
    .eq('golden_value', code)
    .gte('system_to', new Date().toISOString());
  return new Set((scenarioRows || []).map((row: any) => row.entity_id));
}
