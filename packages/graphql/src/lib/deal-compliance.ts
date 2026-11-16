// The deal surface scores these on demand. They stay inactive so a scheduled
// run of every active fund rule does not pick them up.
export const DEAL_SURFACE_RULE_CODES = [
  'PF_ISSUER_CONCENTRATION',
  'PF_SPONSOR_CONCENTRATION',
  'PF_UNFUNDED_COMMITMENTS',
] as const;

export function dealSurfaceRules<T extends { rule_code: string }>(rows: T[]): T[] {
  const wanted = new Set<string>(DEAL_SURFACE_RULE_CODES);
  return rows.filter((row) => wanted.has(row.rule_code));
}

export interface DealScoreRule {
  id: string;
  rule_code: string;
  is_active?: boolean | null;
}

export interface DealScoreThreshold {
  rule_id: string;
  entity_id?: string | null;
  group_value?: string | null;
  rank_from?: number | null;
  applies?: boolean | null;
  valid_from?: string | null;
  valid_to?: string | null;
}

export interface DealScorePlan<T extends DealScoreRule> {
  rule: T;
  anchorIds: string[];
  ignoreEnrollment: boolean;
}

function openOn(value: string | null | undefined, asOf: string, side: 'from' | 'to'): boolean {
  if (!value) return true;
  const day = value.slice(0, 10);
  return side === 'from' ? day <= asOf : day >= asOf;
}

/**
 * Score the pro forma rules for every fund on the deal (their limits live on
 * the fund, not in a threshold row) and any other active rule that has a
 * limit assigned to one of those funds.
 */
export function rulesToScore<T extends DealScoreRule>(
  rules: T[],
  thresholds: DealScoreThreshold[],
  fundIds: ReadonlySet<string>,
  asOf: string,
): Array<DealScorePlan<T>> {
  const surface = new Set<string>(DEAL_SURFACE_RULE_CODES);
  const anchors = [...fundIds];
  const plans: Array<DealScorePlan<T>> = [];
  for (const rule of rules) {
    if (surface.has(rule.rule_code)) {
      if (anchors.length) plans.push({ rule, anchorIds: anchors, ignoreEnrollment: true });
      continue;
    }
    if (rule.is_active === false) continue;
    const optedOut = new Set(thresholds.flatMap((item) => {
      if (item.rule_id !== rule.id || item.applies !== false || !item.entity_id) return [];
      if (item.group_value || item.rank_from != null) return [];
      if (!openOn(item.valid_from, asOf, 'from') || !openOn(item.valid_to, asOf, 'to')) return [];
      return [item.entity_id];
    }));
    // A rank band or a group limit is a limit assigned to the fund, even when
    // there is no separate "this test applies" row. An explicit opt-out wins.
    const enrolled = [...new Set(thresholds.flatMap((item) => {
      if (item.rule_id !== rule.id) return [];
      if (item.applies !== true || !item.entity_id || !fundIds.has(item.entity_id)) return [];
      if (optedOut.has(item.entity_id)) return [];
      if (!openOn(item.valid_from, asOf, 'from') || !openOn(item.valid_to, asOf, 'to')) return [];
      return [item.entity_id];
    }))];
    if (enrolled.length) plans.push({ rule, anchorIds: enrolled, ignoreEnrollment: true });
  }
  return plans;
}

/**
 * Keep scores for funds on this deal. For each rule, when the proposal
 * positions are among the contributors, show the groups they move. A rule
 * the deal does not land in still keeps its fund scores, so an assigned
 * limit is not dropped because a different rule was touched.
 */
export function dealSurfaceResults<T extends { ruleId: string; anchorEntityId: string; contributingEntityIds?: string[] | null }>(
  results: T[],
  fundIds: ReadonlySet<string>,
  proposalIds: ReadonlySet<string>,
): T[] {
  const onDeal = results.filter((result) => fundIds.has(result.anchorEntityId));
  if (proposalIds.size === 0) return onDeal;
  const byRule = new Map<string, T[]>();
  for (const result of onDeal) {
    const list = byRule.get(result.ruleId) || [];
    list.push(result);
    byRule.set(result.ruleId, list);
  }
  const kept: T[] = [];
  for (const group of byRule.values()) {
    const touched = group.filter((result) =>
      (result.contributingEntityIds || []).some((id) => proposalIds.has(id)),
    );
    kept.push(...(touched.length > 0 ? touched : group));
  }
  return kept;
}
