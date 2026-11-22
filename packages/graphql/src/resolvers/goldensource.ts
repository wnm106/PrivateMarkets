import { Context } from "../context";
import { ok } from '../lib/db-result';

/** The tiers of golden_master.preference_decision, in the order it tries them. */
const DECISION_TIERS = ["MANUAL_OVERRIDE", "CALCULATED", "TEMPLATE_SEQUENCE", "ATTRIBUTE_SEQUENCE", "DATA_SOURCE_SEQUENCE"];
const DECISION_TIER_NAMES: Record<string, string> = {
  MANUAL_OVERRIDE: "Manual override",
  CALCULATED: "Calculated value",
  TEMPLATE_SEQUENCE: "Template source order",
  ATTRIBUTE_SEQUENCE: "Attribute source order",
  DATA_SOURCE_SEQUENCE: "Source registry rank",
};

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function receiptIsStale(receivedAt: string | null | undefined, sourceCode: string | null | undefined): boolean {
  const code = (sourceCode || '').toUpperCase();
  if (code === 'DERIVED' || code === 'CALCULATED') return false;
  if (!receivedAt) return false;
  const time = new Date(receivedAt).getTime();
  if (Number.isNaN(time)) return false;
  return Date.now() - time > STALE_AFTER_MS;
}

/**
 * Golden Source Resolver
 * Handles: resolving/persisting golden source, O(1) reads, batch re-resolution,
 *          template qualification, and template-scoped chain management.
 */

export const goldenSourceResolvers = {
  Query: {
    goldenSource: async (_: any, args: { entityId: string; attributeCode: string }, context: Context) => {
      const { data: attr } = ok(await context.supabase
        .from("attribute_register").select("id, attribute_code, attribute_name")
        .eq("attribute_code", args.attributeCode).single());
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
        isStale: receiptIsStale(data.last_received_at || data.system_from, data.source_registry?.source_code),
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
        isStale: receiptIsStale(row.last_received_at || row.system_from, row.source_registry?.source_code),
      }));
    },

    templatePrecedenceChain: async (_: any, args: { templateId: string; attributeCode: string }, context: Context) => {
      const { data: attr } = ok(await context.supabase
        .from("attribute_register").select("id").eq("attribute_code", args.attributeCode).single());
      if (!attr) return null;
      const { data } = ok(await context.supabase
        .from("template_attribute_assignments").select("default_precedence_chain, chain_version")
        .eq("template_id", args.templateId).eq("attribute_id", attr.id).maybeSingle());
      const sources = Array.isArray(data?.default_precedence_chain)
        ? (data.default_precedence_chain as string[]).filter((code) => code && code !== "MANUAL")
        : [];
      if (sources.length === 0 || !data) return null;
      return { templateId: args.templateId, attributeCode: args.attributeCode, chain: ["MANUAL", ...sources], chainVersion: data.chain_version || 1 };
    },

    qualifyEntityTemplate: async (_: any, args: { entityId: string; domainCode: string }, context: Context) => {
      return qualifyTemplate(context, args.entityId, args.domainCode);
    },

    // The winner as golden_master.preference_decision decides it, the same decision the
    // value triggers store. Nothing is interpreted here. domainCode and templateId are
    // read from the record itself.
    evaluateGoldenSource: async (_: any, args: { entityId: string; attributeCode: string }, context: Context) => {
      const { data, error } = await context.supabase
        .schema("golden_master")
        .rpc("explain_golden_source", { p_entity_id: args.entityId, p_attribute_code: args.attributeCode });
      if (error) throw new Error(error.message);
      const explained = (data || {}) as { winningSource?: string | null; winningSourceId?: string | null; tier?: string | null; chainVersion?: number; candidates?: unknown[] };
      const tier = explained.tier || null;
      return {
        winningSource: explained.winningSource || "NONE",
        winningSourceId: explained.winningSourceId || null,
        tier,
        tierUsed: tier ? DECISION_TIERS.indexOf(tier) + 1 : 0,
        isDefault: tier === "ATTRIBUTE_SEQUENCE" || tier === "DATA_SOURCE_SEQUENCE",
        resolutionVersion: explained.chainVersion ?? 0,
        appliedRuleCode: tier,
        appliedRuleName: tier ? DECISION_TIER_NAMES[tier] || tier : null,
        allCandidates: explained.candidates || [],
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
        const { data: attr } = ok(await context.supabase.from("attribute_register").select("id").eq("attribute_code", attributeCode).single());
        if (!attr) return { success: false, chainVersion: 0, entitiesResolved: 0, errors: [{ field: "attributeCode", message: "Attribute not found", code: "NOT_FOUND" }] };

        // Check if assignment exists; if not, create it
        const { data: assignment } = ok(await context.supabase
          .from("template_attribute_assignments")
          .select("id, chain_version")
          .eq("template_id", templateId)
          .eq("attribute_id", attr.id)
          .maybeSingle());

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

        const { data: template } = ok(await context.supabase.from("domain_templates").select("domain_code, template_code").eq("id", templateId).single());
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

/** Re-decides one record's golden source with golden_master.reresolve_golden_sources and returns the winner. */
async function resolveAndPersistGolden(
  context: Context, entityId: string, attributeCode: string,
  _domainCode: string, _templateId: string | null, _validFrom: string
): Promise<{ winningSource: string | null; goldenValueId: string | null; goldenValue: string | null }> {
  const { data } = ok(await context.supabase
    .schema("golden_master")
    .rpc("reresolve_golden_sources", { p_entity_ids: [entityId], p_attribute_code: attributeCode }));
  const winner = ((data || []) as Array<{ golden_value_id: string; winning_source: string | null; golden_value: string | null }>)[0];
  return { winningSource: winner?.winning_source ?? null, goldenValueId: winner?.golden_value_id ?? null, goldenValue: winner?.golden_value ?? null };
}

/** Re-decides an attribute's golden source for every record of a domain (or template), a page of records a call. */
async function batchReresolve(
  context: Context, domainCode: string, attributeCode: string, templateCode?: string
): Promise<number> {
  let templateId: string | null = null;
  if (templateCode) {
    const { data: tmpl, error: templateError } = await context.supabase.from("domain_templates").select("id").eq("template_code", templateCode).maybeSingle();
    if (templateError) throw templateError;
    // Without this the whole domain would be re-resolved instead of one template.
    if (!tmpl) throw new Error(`Template ${templateCode} was not found.`);
    templateId = tmpl.id;
  }

  let resolved = 0;
  // PostgREST returns at most max_rows (1,000) rows per request, so the entities are read page by page.
  const pageSize = 1000;
  const callSize = 500;
  for (let from = 0; ; ) {
    let query = context.supabase.from("entity_master").select("entity_id").eq("domain_code", domainCode);
    if (templateId) query = query.eq("template_id", templateId);
    const { data: entities, error } = await query.order("entity_id", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (entities || []).map((entity: any) => entity.entity_id as string);
    if (page.length === 0) break;
    for (let i = 0; i < page.length; i += callSize) {
      const ids = page.slice(i, i + callSize);
      ok(await context.supabase
        .schema("golden_master")
        .rpc("reresolve_golden_sources", { p_entity_ids: ids, p_attribute_code: attributeCode }));
      resolved += ids.length;
    }
    // Advance by what came back, so a lower row cap than pageSize skips nothing.
    from += page.length;
  }
  return resolved;
}

async function qualifyTemplate(
  context: Context, entityId: string, domainCode: string
): Promise<{ templateId: string | null; templateCode: string | null; matched: boolean }> {
  const { data: templates } = ok(await context.supabase
    .from("domain_templates").select("*").eq("domain_code", domainCode).eq("is_active", true)
    .order("qualification_priority", { ascending: true }));
  if (!templates || templates.length === 0) return { templateId: null, templateCode: null, matched: false };

  const { data: entityAttrs } = ok(await context.supabase.from("source_attribute_values").select("*").eq("entity_id", entityId));
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
      const { data: updated, error: updateError } = await context.supabase
        .from("master_entities").update({ template_id: template.id }).eq("id", entityId).select("id");
      if (updateError) throw updateError;
      // Row level security hides a record the caller may not change, so nothing is updated and no error comes back.
      if (!updated?.length) throw new Error("The record's template was not changed. You may not edit this record.");
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
