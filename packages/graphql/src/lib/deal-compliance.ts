/** One rule the deal is scored on and the funds it covers, from compliance.deal_score_plans. */
export interface DealScorePlan<T extends { id: string; rule_code: string } = { id: string; rule_code: string }> {
  rule: T;
  anchorIds: string[];
  /** What one group of the result is called (Issuer, Sector), from the rule. */
  groupLabel: string | null;
}

type ComplianceSchema = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from: (table: string) => any;
};

/** The service role sees every client's rules. This keeps the shared ones and the deal client's own. */
export function ownRulesFilter(clientId: string | null): string {
  return clientId ? `client_id.is.null,client_id.eq.${clientId}` : 'client_id.is.null';
}

/**
 * The version of each rule in force at the as-of date, as known at the
 * knowledge instant: compliance.resolve_rule_version, the same choice the
 * evaluator makes. Not the highest version number, which may not have been in
 * force, or known, then.
 */
export async function ruleVersionsAt(
  compliance: ComplianceSchema,
  ruleIds: Iterable<string>,
  asOf: string,
  knowledge: string,
): Promise<Map<string, any>> {
  const ids = [...new Set(ruleIds)];
  const found = await Promise.all(ids.map(async (ruleId) => {
    const { data, error } = await compliance.rpc('resolve_rule_version', { p_rule_id: ruleId, p_as_of_date: asOf, p_knowledge_date: knowledge });
    if (error) throw new Error(error.message);
    const version = Array.isArray(data) ? data[0] : data;
    return [ruleId, version && (version as any).id ? version : null] as const;
  }));
  return new Map(found.filter(([, version]) => version));
}

/**
 * A what-if is staged as rows written now, so it can only be scored against what
 * is known now. Refuses an earlier Knowledge date with a reason the user can act on.
 */
export function assertWhatIfKnowledge(knowledge: string, now = Date.now()): void {
  if (Date.parse(knowledge) < now - 60_000) {
    throw new Error('Unsaved changes are scored against what is known now. Set the Knowledge date to today to score them, or save them first.');
  }
}

/**
 * The rules a deal is scored on, for which funds. The database decides
 * (compliance.deal_score_plans): rules marked deal_surface cover every fund on
 * the deal, and any other active rule covers the funds with a limit assigned to
 * them. The pro forma panel, the hypo and capacity read the same plan.
 * There is no rule-wide limit: compliance.resolve_threshold skips a fund with
 * no threshold row of its own, so a deal_surface rule only limits the funds
 * that have their own limit for it.
 */
export async function loadDealScorePlans(
  compliance: ComplianceSchema,
  fundIds: Iterable<string>,
  asOf: string,
  /** The deal's client. When given, only shared rules and that client's own are kept: the service role sees every client's rules. */
  clientId?: string | null,
  /** The Knowledge date of the score: rules, fund limits and enrollment as known then. Omitted: as known now. */
  knowledgeDate?: string | null,
): Promise<Array<DealScorePlan<any>>> {
  const funds = [...new Set(fundIds)];
  if (!funds.length) return [];
  const { data, error } = await compliance.rpc('deal_score_plans', {
    p_fund_ids: funds,
    p_as_of_date: asOf,
    ...(knowledgeDate ? { p_knowledge_date: knowledgeDate } : {}),
  });
  if (error) throw new Error(error.message);
  const planRows = (data || []) as Array<{ rule_id: string; rule_code: string; anchor_ids: string[]; group_label: string | null }>;
  if (!planRows.length) return [];
  // Read through the service role where the caller has it, so a user policy
  // does not hide an inactive deal-surface rule.
  let ruleRead = compliance
    .from('rules')
    .select('*')
    .in('id', planRows.map((row) => row.rule_id));
  if (clientId !== undefined) ruleRead = ruleRead.or(ownRulesFilter(clientId));
  const { data: ruleRows, error: ruleError } = await ruleRead;
  if (ruleError) throw new Error(ruleError.message);
  const ruleById = new Map<string, any>(((ruleRows || []) as any[]).map((row) => [row.id, row]));
  return planRows
    .filter((row) => ruleById.has(row.rule_id))
    .map((row) => ({ rule: ruleById.get(row.rule_id), anchorIds: row.anchor_ids || [], groupLabel: row.group_label ?? null }));
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

/** One row of compliance.rule_evaluation_results, as the deal surfaces read it. */
export interface DealScoreResult {
  id: string;
  runId: string;
  ruleId: string;
  ruleVersionId: string;
  anchorEntityId: string;
  groupByValue: string | null;
  asOfDate: string;
  knowledgeDate: string;
  sourceScope: string | null;
  numeratorValue: number | null;
  denominatorValue: number | null;
  computedValue: number | null;
  limitDirection: string | null;
  softLimitValue: number | null;
  hardLimitValue: number | null;
  status: string;
  breachAmount: number | null;
  contributingEntityIds: string[] | null;
  contributingCount: number | null;
  rankPosition: number | null;
  detail: Record<string, unknown>;
  evaluatedAt: string;
}

/**
 * Scores every planned rule for its funds in one database call
 * (compliance.score_deal_funds). Rules run one after another inside it, so
 * they do not crowd each other out the way parallel calls did.
 */
export async function scoreDealFunds(
  compliance: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  plans: Array<{ rule: { rule_code: string }; anchorIds: string[] }>,
  asOf: string,
  scenarioCode: string,
  triggeredBy: string | null,
  /** The knowledge instant to score at. A staged what-if is readable at its own instant only. */
  knowledgeDate: string = new Date().toISOString(),
): Promise<DealScoreResult[]> {
  const { data, error } = await compliance.rpc('score_deal_funds', {
    p_plans: plans.map((plan) => ({ ruleCode: plan.rule.rule_code, anchors: plan.anchorIds })),
    p_as_of: asOf,
    p_knowledge: knowledgeDate,
    p_scenario: scenarioCode,
    p_triggered_by: triggeredBy,
  });
  if (error) throw new Error(error.message);
  return ((data || []) as any[]).map((row) => ({
    id: row.id,
    runId: row.run_id,
    ruleId: row.rule_id,
    ruleVersionId: row.rule_version_id,
    anchorEntityId: row.anchor_entity_id,
    groupByValue: row.group_by_value,
    asOfDate: row.as_of_date,
    knowledgeDate: row.knowledge_date,
    sourceScope: row.source_scope,
    numeratorValue: row.numerator_value,
    denominatorValue: row.denominator_value,
    computedValue: row.computed_value,
    limitDirection: row.limit_direction,
    softLimitValue: row.soft_limit_value,
    hardLimitValue: row.hard_limit_value,
    status: row.status,
    breachAmount: row.breach_amount,
    contributingEntityIds: row.contributing_entity_ids,
    contributingCount: row.contributing_count,
    rankPosition: row.rank_position ?? null,
    detail: row.detail || {},
    evaluatedAt: row.evaluated_at,
  }));
}
