import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

/**
 * Running the data quality checks on one record.
 *
 * This is for workflows. list_dq_exceptions reads exceptions that were stored
 * earlier; this evaluates every active rule against the record as it is now,
 * the same way the data quality page does. Nothing is written.
 */

type Row = Record<string, any>;

function forEntity(rows: unknown, entityId: string): Row | null {
  return (Array.isArray(rows) ? (rows as Row[]) : []).find((row) => row?.id === entityId) || null;
}

const getDataQualityChecks: ToolDefinition = {
  name: 'get_data_quality_checks',
  description:
    'Run every active data quality rule against one record, as it is right now, and list the required attributes it is missing. Returns the checks it fails (with the rule, the value that failed, and why), the checks it passes, failures a person has accepted, and missing required attributes. Nothing is stored. Use it before deciding what a record needs, and to see which rule a proposed value has to satisfy.',
  category: 'dq',
  inputSchema: {
    type: 'object',
    properties: {
      entityId: { type: 'string', description: 'The record id' },
    },
    required: ['entityId'],
  },
  execute: async (args, supabase) => {
    const entityId = String(args.entityId || '');
    if (!entityId) throw new Error('entityId is required');
    const { data, error } = await supabase.rpc('data_quality_dashboard', {
      p_domain_code: null,
      p_from_date: null,
      p_to_date: null,
      p_knowledge_date: null,
      p_entity_id: entityId,
    });
    if (error) throw error;
    const report = (data || {}) as Row;
    const summary = (report.summary || {}) as Row;
    const entity = forEntity(report.entities, entityId);

    const failing: Row[] = [];
    const passing: Row[] = [];
    const accepted: Row[] = [];
    const notEvaluated: Row[] = [];
    for (const rule of (Array.isArray(report.quality) ? report.quality : []) as Row[]) {
      const base = {
        ruleCode: rule.ruleCode,
        ruleName: rule.ruleName,
        severity: rule.severity,
        attributeCode: rule.attributeCode || null,
        attributeName: rule.attributeName || null,
      };
      const failed = forEntity(rule.failingEntities, entityId);
      const waived = forEntity(rule.acceptedEntities, entityId);
      if (failed) {
        failing.push({ ...base, message: failed.message || null, actualValue: failed.actualValue ?? null, rule: rule.ruleExpression, description: rule.ruleDescription || null });
      } else if (waived) {
        accepted.push({ ...base, message: waived.message || null });
      } else if (Number(rule.passingCount) > 0) {
        // The rule is included so a proposed value can be held to it.
        passing.push({ ...base, rule: rule.ruleExpression });
      } else if (rule.evaluated === false && rule.evaluationMessage && rule.domainCode === entity?.domainCode) {
        notEvaluated.push({ ...base, reason: rule.evaluationMessage });
      }
    }

    const missingRequired = ((Array.isArray(report.availability) ? report.availability : []) as Row[])
      .filter((slot) => forEntity(slot.missingEntities, entityId))
      .map((slot) => ({ attributeCode: slot.attributeCode, attributeName: slot.attributeName }));

    return {
      entity: entity ? { id: entityId, code: entity.entityCode, name: entity.entityName, domainCode: entity.domainCode } : { id: entityId },
      asOf: report.toDate || null,
      summary: {
        checksFailing: failing.length,
        checksPassing: passing.length,
        failuresAccepted: accepted.length,
        requiredAttributes: Number(summary.requiredSlots) || 0,
        requiredMissing: missingRequired.length,
      },
      failing,
      missingRequired,
      accepted,
      passing,
      ...(notEvaluated.length > 0 ? { notEvaluated } : {}),
    };
  },
};

export function registerDqCheckTools(registry: ToolRegistry) {
  registry.registerTool(getDataQualityChecks);
}
