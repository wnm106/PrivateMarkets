import { Context } from "../context";
import { evaluatePrecedence } from "../lib/rule-engine";

/**
 * Golden Source Resolver
 * Handles: resolving/persisting golden source, O(1) reads, batch re-resolution,
 *          template qualification, and template-scoped chain management.
 */

export const goldenSourceResolvers = {
  Query: {
    goldenSource: async (_: any, args: { entityId: string; attributeCode: string }, context: Context) => {
      const { data: attr } = await context.supabase
        .from("attribute_register").select("id, attribute_code, attribute_name")
        .eq("attribute_code", args.attributeCode).single();
      if (!attr) return null;

      const { data, error } = await context.supabase
        .from("entity_attribute_values")
        .select("*, source_registry:golden_source_id(source_code, source_name), attribute_register:attribute_id(attribute_code, attribute_name)")
        .eq("entity_id", args.entityId).eq("attribute_id", attr.id)
        .eq("valid_to", "9999-12-31").eq("system_to", "9999-12-31 23:59:59")
        .maybeSingle();
      if (error || !data) return null;

      return {
        entityId: data.entity_id, attributeCode: args.attributeCode,
        goldenValue: data.golden_value,
        goldenSourceCode: data.source_registry?.source_code || null,
        goldenSourceName: data.source_registry?.source_name || null,
        goldenSourceId: data.golden_source_id,
        precedenceRank: data.precedence_rank,
        isManualOverride: data.is_manual_override,
        resolutionRuleApplied: data.resolution_rule_applied,
        resolutionVersion: data.resolution_version,
        resolvedAt: data.resolved_at,
        competingValues: data.competing_values || [],
        isStale: false,
      };
    },

    goldenSourcesForEntity: async (_: any, args: { entityId: string }, context: Context) => {
      const { data, error } = await context.supabase
        .from("entity_attribute_values")
        .select("*, source_registry:golden_source_id(source_code, source_name), attribute_register:attribute_id(attribute_code, attribute_name)")
        .eq("entity_id", args.entityId).eq("valid_to", "9999-12-31").eq("system_to", "9999-12-31 23:59:59");
      if (error || !data) return [];
      return data.map((row: any) => ({
        entityId: row.entity_id,
        attributeCode: row.attribute_register?.attribute_code || null,
        attributeName: row.attribute_register?.attribute_name || null,
        goldenValue: row.golden_value,
        goldenSourceCode: row.source_registry?.source_code || null,
        goldenSourceName: row.source_registry?.source_name || null,
        goldenSourceId: row.golden_source_id,
        precedenceRank: row.precedence_rank,
        isManualOverride: row.is_manual_override,
        resolutionRuleApplied: row.resolution_rule_applied,
        resolutionVersion: row.resolution_version,
        resolvedAt: row.resolved_at,
        competingValues: row.competing_values || [],
        isStale: false,
      }));
    },

    templatePrecedenceChain: async (_: any, args: { templateId: string; attributeCode: string }, context: Context) => {
      const { data: attr } = await context.supabase
        .from("attribute_register").select("id").eq("attribute_code", args.attributeCode).single();
      if (!attr) return null;
      const { data } = await context.supabase
        .from("template_attribute_assignments").select("default_precedence_chain, chain_version")
        .eq("template_id", args.templateId).eq("attribute_id", attr.id).maybeSingle();
      const sources = Array.isArray(data?.default_precedence_chain)
        ? (data.default_precedence_chain as string[]).filter((code) => code && code !== "MANUAL")
        : [];
      if (sources.length === 0 || !data) return null;
      return { templateId: args.templateId, attributeCode: args.attributeCode, chain: ["MANUAL", ...sources], chainVersion: data.chain_version || 1 };
    },

    qualifyEntityTemplate: async (_: any, args: { entityId: string; domainCode: string }, context: Context) => {
      return qualifyTemplate(context, args.entityId, args.domainCode);
    },

    evaluateGoldenSource: async (_: any, args: { entityId: string; attributeCode: string; domainCode: string; templateId: string }, context: Context) => {
      const result = await evaluatePrecedence(context.supabase, args.entityId, args.attributeCode, args.domainCode, args.templateId || null);
      return {
        winningSource: result.winningSource, winningSourceId: result.winningSourceId,
        tierUsed: result.tierUsed, isDefault: result.isDefault, resolutionVersion: result.resolutionVersion,
        appliedRuleCode: result.appliedRule?.ruleCode || null, appliedRuleName: result.appliedRule?.ruleName || null,
        allCandidates: result.allCandidates,
      };
    },
  },

  Mutation: {
    resolveGoldenSource: async (_: any, args: { entityId: string; attributeCode: string; domainCode: string; templateId?: string; validFrom?: string }, context: Context) => {
      try {
        const result = await resolveAndPersistGolden(context, args.entityId, args.attributeCode, args.domainCode, args.templateId || null, args.validFrom || new Date().toISOString().split("T")[0]);
        return { success: true, ...result, errors: [] };
      } catch (error: any) {
        return { success: false, winningSource: null, goldenValueId: null, errors: [{ field: "general", message: error.message, code: "RESOLVE_FAILED" }] };
      }
    },

    batchResolveGoldenSources: async (_: any, args: { domainCode: string; attributeCode: string; templateCode?: string }, context: Context) => {
      try {
        const count = await batchReresolve(context, args.domainCode, args.attributeCode, args.templateCode);
        return { success: true, entitiesResolved: count, errors: [] };
      } catch (error: any) {
        return { success: false, entitiesResolved: 0, errors: [{ field: "general", message: error.message, code: "BATCH_FAILED" }] };
      }
    },

    updateTemplatePrecedenceChain: async (_: any, args: { templateId: string; attributeCode: string; chain: string[] }, context: Context) => {
      try {
        const { templateId, attributeCode, chain } = args;
        const { data: attr } = await context.supabase.from("attribute_register").select("id").eq("attribute_code", attributeCode).single();
        if (!attr) return { success: false, chainVersion: 0, entitiesResolved: 0, errors: [{ field: "attributeCode", message: "Attribute not found", code: "NOT_FOUND" }] };

        // Check if assignment exists; if not, create it
        const { data: assignment } = await context.supabase
          .from("template_attribute_assignments")
          .select("id, chain_version")
          .eq("template_id", templateId)
          .eq("attribute_id", attr.id)
          .maybeSingle();

        const sources = (chain || []).filter((code) => code && code !== "MANUAL");
        const storedChain = sources.length > 0 ? sources : null;
        let chainVersion = 0;
        if (assignment) {
          const { error: updateError } = await context.supabase
            .from("template_attribute_assignments")
            .update({ default_precedence_chain: storedChain })
            .eq("id", assignment.id);
          if (updateError) throw updateError;
          chainVersion = (assignment.chain_version || 0) + 1;
        } else if (storedChain) {
          const { data: newAssignment, error: insertError } = await context.supabase
            .from("template_attribute_assignments")
            .insert({
              template_id: templateId,
              attribute_id: attr.id,
              default_precedence_chain: storedChain,
              is_required: false,
              display_order: 999,
            })
            .select("id, chain_version")
            .single();
          if (insertError) throw insertError;
          chainVersion = newAssignment?.chain_version || 1;
        }

        const { data: template } = await context.supabase.from("domain_templates").select("domain_code, template_code").eq("id", templateId).single();
        let resolved = 0;
        if (template) resolved = await batchReresolve(context, template.domain_code, attributeCode, template.template_code);

        return { success: true, chainVersion, entitiesResolved: resolved, errors: [] };
      } catch (error: any) {
        return { success: false, chainVersion: 0, entitiesResolved: 0, errors: [{ field: "general", message: error.message, code: "UPDATE_FAILED" }] };
      }
    },
  },
};

// ─── Internal helpers ────────────────────────────────────────────────

async function resolveAndPersistGolden(
  context: Context, entityId: string, attributeCode: string,
  _domainCode: string, _templateId: string | null, _validFrom: string
): Promise<{ winningSource: string | null; goldenValueId: string | null; goldenValue: string | null }> {
  const { data: attr } = await context.supabase.from("attribute_register").select("id").eq("attribute_code", attributeCode).single();
  if (!attr) throw new Error(`Attribute not found: ${attributeCode}`);

  const current = () => context.supabase.from("entity_attribute_values")
    .eq("entity_id", entityId).eq("attribute_id", attr.id)
    .eq("valid_to", "9999-12-31").eq("system_to", "9999-12-31 23:59:59");

  const { data: sample, error: sampleError } = await current().select("id").limit(1).maybeSingle();
  if (sampleError) throw sampleError;
  if (!sample?.id) return { winningSource: null, goldenValueId: null, goldenValue: null };

  const { error: touchError } = await context.supabase.from("entity_attribute_values")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", sample.id);
  if (touchError) throw touchError;

  const { data: rows, error } = await current().select("id, source_id, golden_source_id, golden_value");
  if (error) throw error;
  const winner = (rows || []).find((row) => row.golden_source_id && row.source_id === row.golden_source_id);
  let winningSource: string | null = null;
  if (winner?.source_id) {
    const { data: source } = await context.supabase.schema("entity_instances").from("source_registry")
      .select("source_code").eq("id", winner.source_id).maybeSingle();
    winningSource = source?.source_code ?? null;
  }
  return { winningSource, goldenValueId: winner?.id || null, goldenValue: winner?.golden_value || null };
}

async function batchReresolve(
  context: Context, domainCode: string, attributeCode: string, templateCode?: string
): Promise<number> {
  let query = context.supabase.from("entity_master").select("entity_id, template_id, domain_code").eq("domain_code", domainCode);
  if (templateCode) {
    const { data: tmpl } = await context.supabase.from("domain_templates").select("id").eq("template_code", templateCode).single();
    if (tmpl) query = query.eq("template_id", tmpl.id);
  }
  const { data: entities } = await query;
  if (!entities || entities.length === 0) return 0;

  let resolved = 0;
  const validFrom = new Date().toISOString().split("T")[0];
  const batchSize = 50;
  for (let i = 0; i < entities.length; i += batchSize) {
    const batch = entities.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (entity: any) => {
      try { await resolveAndPersistGolden(context, entity.entity_id, attributeCode, domainCode, entity.template_id, validFrom); return true; }
      catch (err) { console.error(`Failed to re-resolve for entity ${entity.entity_id}:`, err); return false; }
    }));
    resolved += results.filter(Boolean).length;
  }
  return resolved;
}

async function qualifyTemplate(
  context: Context, entityId: string, domainCode: string
): Promise<{ templateId: string | null; templateCode: string | null; matched: boolean }> {
  const { data: templates } = await context.supabase
    .from("domain_templates").select("*").eq("domain_code", domainCode).eq("is_active", true)
    .order("qualification_priority", { ascending: true });
  if (!templates || templates.length === 0) return { templateId: null, templateCode: null, matched: false };

  const { data: entityAttrs } = await context.supabase.from("source_attribute_values").select("*").eq("entity_id", entityId);
  const attributesByCode: Record<string, any> = {};
  (entityAttrs || []).forEach((attr: any) => { if (!attributesByCode[attr.attribute_code]) attributesByCode[attr.attribute_code] = attr.attribute_value; });

  for (const template of templates) {
    const rules = template.applicability_rules;
    if (!rules || !rules.conditions || rules.conditions.length === 0) continue;
    const logic = rules.logic || "AND";
    const conditions = rules.conditions;
    let matches = false;
    if (logic === "AND") matches = conditions.every((cond: any) => evaluateApplicabilityCondition(cond, attributesByCode));
    else matches = conditions.some((cond: any) => evaluateApplicabilityCondition(cond, attributesByCode));
    if (matches) {
      await context.supabase.from("master_entities").update({ template_id: template.id }).eq("id", entityId);
      return { templateId: template.id, templateCode: template.template_code, matched: true };
    }
  }
  return { templateId: null, templateCode: null, matched: false };
}

function evaluateApplicabilityCondition(cond: any, attributesByCode: Record<string, any>): boolean {
  const actualValue = attributesByCode[cond.attributeCode];
  switch (cond.operator) {
    case "equals": return actualValue === cond.value;
    case "not_equals": return actualValue !== cond.value;
    case "in": return Array.isArray(cond.value) && cond.value.includes(actualValue);
    case "not_in": return Array.isArray(cond.value) && !cond.value.includes(actualValue);
    case "is_null": return !actualValue;
    case "is_not_null": return !!actualValue;
    default: return false;
  }
}
