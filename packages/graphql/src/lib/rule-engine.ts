import { SupabaseClient } from "@supabase/supabase-js";
import { PrecedenceRule, PrecedenceEvaluationResult } from "../schema/types";

/**
 * Golden Source Resolution Engine
 *
 * Implements a strict 4-tier waterfall to determine which source wins:
 *   TIER 1: MANUAL OVERRIDE (always wins if it exists)
 *   TIER 2: TEMPLATE-SCOPED CONDITIONAL RULE (precedence_rules with conditions)
 *   TIER 3: TEMPLATE DEFAULT CHAIN (template_attribute_assignments.default_precedence_chain)
 *   TIER 4: GLOBAL SOURCE REGISTRY FALLBACK (source_registry.precedence_rank)
 *
 * MANUAL is always injected at position 0 of every chain regardless of configuration.
 */

export async function evaluatePrecedence(
  supabase: SupabaseClient,
  entityId: string,
  attributeCode: string,
  domainCode: string,
  templateId?: string | null
): Promise<PrecedenceEvaluationResult> {
  // Parallel fetch: source values + entity attributes + rules + sources
  const [valuesResult, entityAttrsResult, rulesResult, sourcesResult] = await Promise.all([
    supabase
      .from("source_attribute_values")
      .select("*, source_registry:source_id(id, source_code, source_name)")
      .eq("entity_id", entityId)
      .eq("attribute_code", attributeCode),
    supabase
      .from("source_attribute_values")
      .select("*")
      .eq("entity_id", entityId),
    supabase
      .from("precedence_rules")
      .select("*, conditions:precedence_rule_conditions(*), chain:precedence_rule_chain(*)")
      .eq("domain_code", domainCode)
      .eq("attribute_code", attributeCode)
      .eq("is_active", true)
      .order("priority_tier", { ascending: true }),
    supabase
      .from("source_registry")
      .select("id, source_code, precedence_rank")
      .eq("is_active", true)
      .order("precedence_rank", { ascending: true }),
  ]);

  const attributeValues = valuesResult.data || [];
  const entityAttributes = entityAttrsResult.data || [];
  const rules = rulesResult.data || [];
  const allSources = sourcesResult.data || [];

  // Build source_code -> source_id map
  const sourceIdMap: Record<string, string> = {};
  allSources.forEach((s: any) => {
    sourceIdMap[s.source_code] = s.id;
  });

  // Group entity attributes by code for condition evaluation
  const attributesByCode: Record<string, any[]> = {};
  entityAttributes.forEach((attr: any) => {
    if (!attributesByCode[attr.attribute_code]) attributesByCode[attr.attribute_code] = [];
    attributesByCode[attr.attribute_code].push(attr);
  });

  // Helper: build candidates list from a chain
  const buildCandidates = (chain: string[]) => {
    const candidates: Array<{ source: string; sourceId?: string; value: string; rank: number }> = [];
    let rank = 1;
    for (const srcCode of chain) {
      const srcVals = attributeValues.filter(
        (av: any) => av.source_registry?.source_code === srcCode
      );
      if (srcVals.length > 0) {
        const latest = srcVals.sort(
          (a: any, b: any) =>
            new Date(b.updated_at || b.valid_from).getTime() -
            new Date(a.updated_at || a.valid_from).getTime()
        )[0];
        candidates.push({
          source: srcCode,
          sourceId: sourceIdMap[srcCode],
          value: latest.attribute_value || "",
          rank: rank++,
        });
      }
    }
    return candidates;
  };

  // Helper: find first source in chain that has a value
  const findWinner = (chain: string[]): { source: string; sourceId?: string; value: string } | null => {
    for (const srcCode of chain) {
      const srcVals = attributeValues.filter(
        (av: any) => av.source_registry?.source_code === srcCode
      );
      if (srcVals.length > 0) {
        const latest = srcVals.sort(
          (a: any, b: any) =>
            new Date(b.updated_at || b.valid_from).getTime() -
            new Date(a.updated_at || a.valid_from).getTime()
        )[0];
        return { source: srcCode, sourceId: sourceIdMap[srcCode], value: latest.attribute_value || "" };
      }
    }
    return null;
  };

  // TIER 1: MANUAL OVERRIDE - always wins if it exists
  const manualOverride = attributeValues.find((av: any) => av.is_manual_override === true);
  if (manualOverride) {
    return {
      winningSource: "MANUAL",
      winningSourceId: sourceIdMap["MANUAL"],
      appliedRule: null,
      isDefault: false,
      tierUsed: 1,
      resolutionVersion: 0,
      allCandidates: buildCandidates(["MANUAL"]),
    };
  }

  // TIER 2: TEMPLATE-SCOPED CONDITIONAL RULES
  const templateRules = rules.filter((r: any) => templateId && r.template_code !== null);
  const domainRules = rules.filter((r: any) => !r.template_code);

  for (const rule of [...templateRules, ...domainRules]) {
    const conditions = rule.conditions || [];
    const chain = rule.chain || [];

    if (conditions.length === 0 || evaluateRuleConditions(conditions, attributesByCode)) {
      const mappedRule = mapPrecedenceRule(rule);
      const chainCodes = chain
        .sort((a: any, b: any) => a.chain_order - b.chain_order)
        .map((c: any) => c.source_code);

      const fullChain = ["MANUAL", ...chainCodes.filter((c: string) => c !== "MANUAL")];
      const winner = findWinner(fullChain);
      const version = rule.resolution_version || 1;

      return {
        winningSource: winner?.source || fullChain[0],
        winningSourceId: winner?.sourceId || sourceIdMap[fullChain[0]],
        appliedRule: mappedRule,
        isDefault: false,
        tierUsed: 2,
        resolutionVersion: version,
        allCandidates: buildCandidates(fullChain),
      };
    }
  }

  // TIER 3: TEMPLATE DEFAULT PRECEDENCE CHAIN
  if (templateId) {
    const { data: assignment } = await supabase
      .from("template_attribute_assignments")
      .select("default_precedence_chain, chain_version")
      .eq("template_id", templateId)
      .limit(1)
      .maybeSingle();

    if (assignment?.default_precedence_chain && Array.isArray(assignment.default_precedence_chain)) {
      const chainCodes = assignment.default_precedence_chain as string[];
      const fullChain = ["MANUAL", ...chainCodes.filter((c: string) => c !== "MANUAL")];
      const winner = findWinner(fullChain);
      const version = assignment.chain_version || 1;

      return {
        winningSource: winner?.source || fullChain[0],
        winningSourceId: winner?.sourceId || sourceIdMap[fullChain[0]],
        appliedRule: null,
        isDefault: true,
        tierUsed: 3,
        resolutionVersion: version,
        allCandidates: buildCandidates(fullChain),
      };
    }
  }

  // TIER 4: GLOBAL SOURCE REGISTRY FALLBACK
  const globalChain = [
    "MANUAL",
    ...allSources.map((s: any) => s.source_code).filter((c: string) => c !== "MANUAL"),
  ];
  const winner = findWinner(globalChain);

  return {
    winningSource: winner?.source || globalChain[0],
    winningSourceId: winner?.sourceId || sourceIdMap[globalChain[0]],
    appliedRule: null,
    isDefault: true,
    tierUsed: 4,
    resolutionVersion: 0,
    allCandidates: buildCandidates(globalChain),
  };
}

/**
 * Evaluate rule conditions (groups are OR'd, within group AND/OR based on logic_operator)
 */
function evaluateRuleConditions(
  conditions: any[],
  attributesByCode: Record<string, any[]>
): boolean {
  const groups: Record<number, any[]> = {};
  conditions.forEach((cond: any) => {
    if (!groups[cond.condition_group]) groups[cond.condition_group] = [];
    groups[cond.condition_group].push(cond);
  });

  for (const groupNum in groups) {
    const groupConditions = groups[groupNum];
    const logicOp = groupConditions[0]?.logic_operator || "AND";
    let groupMatches = false;

    if (logicOp === "AND") {
      groupMatches = groupConditions.every((cond: any) => evaluateCondition(cond, attributesByCode));
    } else {
      groupMatches = groupConditions.some((cond: any) => evaluateCondition(cond, attributesByCode));
    }

    if (groupMatches) return true;
  }
  return false;
}

/**
 * Evaluate a single condition against entity attributes
 */
function evaluateCondition(condition: any, attributesByCode: Record<string, any[]>): boolean {
  const { attribute_code, operator, value } = condition;
  const attrValues = attributesByCode[attribute_code] || [];

  const latestValue = attrValues.sort(
    (a: any, b: any) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  )[0];

  const actualValue = latestValue?.attribute_value;

  switch (operator) {
    case "equals":
      return actualValue === value;
    case "not_equals":
      return actualValue !== value;
    case "in":
      try {
        const valueArray = JSON.parse(value || "[]");
        return valueArray.includes(actualValue);
      } catch {
        return false;
      }
    case "not_in":
      try {
        const valueArray = JSON.parse(value || "[]");
        return !valueArray.includes(actualValue);
      } catch {
        return true;
      }
    case "is_null":
      return actualValue === null || actualValue === undefined || actualValue === "";
    case "is_not_null":
      return actualValue !== null && actualValue !== undefined && actualValue !== "";
    default:
      console.warn(`Unknown operator: ${operator}`);
      return false;
  }
}

/**
 * Map database row to PrecedenceRule type
 */
function mapPrecedenceRule(row: any): PrecedenceRule {
  return {
    id: row.id,
    ruleCode: row.rule_code,
    ruleName: row.rule_name,
    domainCode: row.domain_code,
    templateCode: row.template_code,
    attributeCode: row.attribute_code,
    priorityTier: row.priority_tier,
    isActive: row.is_active,
    conditions: (row.conditions || []).map((c: any) => ({
      id: c.id,
      ruleId: c.rule_id,
      conditionGroup: c.condition_group,
      conditionOrder: c.condition_order,
      attributeCode: c.attribute_code,
      operator: c.operator,
      value: c.value,
      logicOperator: c.logic_operator,
      createdAt: c.created_at,
    })),
    chain: (row.chain || [])
      .map((c: any) => ({
        id: c.id,
        ruleId: c.rule_id,
        chainOrder: c.chain_order,
        sourceCode: c.source_code,
        conditionType: c.condition_type,
        createdAt: c.created_at,
      }))
      .sort((a: any, b: any) => a.chainOrder - b.chainOrder),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    metadata: row.metadata,
  };
}
