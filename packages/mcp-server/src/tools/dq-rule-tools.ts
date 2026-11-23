import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

/**
 * Creating a data quality rule from the chat. The guided skill asks for the details,
 * checks the expression against real records, and calls create_dq_rule only once the
 * person has confirmed. A rule expression is a SQL predicate that is TRUE for the
 * records that FAIL the rule.
 */

const RULE_TYPES = ['COMPLETENESS', 'VALIDITY', 'CONSISTENCY', 'TIMELINESS', 'UNIQUENESS'];
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

const listDQRules: ToolDefinition = {
  name: 'list_dq_rules',
  description: 'The data quality rules already defined, so a new one does not duplicate them. domainCode limits it to one entity type from list_domain_types. Returns each rule\'s code, name, type, severity, the expression that marks a failing record, and whether it is active.',
  category: 'dq',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: { type: 'string', description: 'Entity type code from list_domain_types' },
      first: { type: 'number', description: 'How many to return. Default 60.' },
    },
  },
  execute: async (args, supabase) => {
    let query = supabase.schema('data_quality').from('dq_rules')
      .select('rule_code, rule_name, domain_code, rule_type, rule_severity, rule_expression, rule_description, is_active');
    if (args.domainCode) query = query.eq('domain_code', args.domainCode);
    const { data, error } = await query.order('rule_code').limit(Math.min(Number(args.first) || 60, 200));
    if (error) throw error;
    return {
      rules: (data || []).map((row: any) => ({
        ruleCode: row.rule_code, ruleName: row.rule_name, domainCode: row.domain_code, ruleType: row.rule_type,
        severity: row.rule_severity, failsWhen: row.rule_expression, description: row.rule_description, isActive: row.is_active,
      })),
    };
  },
};

const previewDQRule: ToolDefinition = {
  name: 'preview_dq_rule',
  description: 'Try a data quality rule expression on real records before creating it. The expression is a SQL predicate that is TRUE for a record that FAILS the rule, written against lowercase attribute codes, for example "price < 0" or "maturity_date IS NULL". It is run on up to 25 records of domainCode. Returns how many of them would fail and a few examples, or the database error when the expression is not valid. attributeCode comes from search_attributes. Nothing is saved.',
  category: 'dq',
  inputSchema: {
    type: 'object',
    properties: {
      domainCode: { type: 'string', description: 'Entity type code from list_domain_types' },
      ruleExpression: { type: 'string', description: 'Conditions that raise the exception, for example MARKET_CAP < 0. A record fails when it meets every AND condition of any OR group. A blank value meets no condition about its value; test a blank only with ATTRIBUTE IS NULL.' },
      attributeCode: { type: 'string', description: 'The attribute the rule is about, when it has one' },
    },
    required: ['domainCode', 'ruleExpression'],
  },
  execute: async (args, supabase) => {
    let attributeId: string | null = null;
    if (args.attributeCode) {
      const { data: attribute, error } = await supabase.schema('metadata_register').from('attribute_register')
        .select('id').eq('attribute_code', args.attributeCode).maybeSingle();
      if (error) throw error;
      if (!attribute) throw new Error(`Unknown attribute ${args.attributeCode}. Find it with search_attributes.`);
      attributeId = attribute.id;
    }
    const { data: records, error: recordError } = await supabase.schema('entity_instances').from('master_entities')
      .select('id, entity_code, entity_name').eq('domain_code', args.domainCode).eq('is_active', true).order('entity_name').limit(25);
    if (recordError) throw recordError;
    if (!records?.length) return { sampled: 0, wouldFail: 0, note: `There are no active ${args.domainCode} records to try it on.` };

    const failing: Array<{ code: string; name: string }> = [];
    for (const record of records) {
      const { data, error } = await supabase.schema('data_quality').rpc('failure_predicate_matches', {
        p_expression: args.ruleExpression,
        p_entity_id: record.id,
        p_extra_attribute_id: attributeId,
      });
      if (error) return { valid: false, error: error.message, hint: 'Write the expression against lowercase attribute codes, and make it true for the records that fail.' };
      if (data === true) failing.push({ code: record.entity_code, name: record.entity_name });
    }
    return {
      valid: true,
      sampled: records.length,
      wouldFail: failing.length,
      examples: failing.slice(0, 5),
      note: failing.length === records.length
        ? 'Every sampled record fails. The expression may be the wrong way round: it must be true for records that FAIL.'
        : undefined,
    };
  },
};

const createDQRule: ToolDefinition = {
  name: 'create_dq_rule',
  description: `Create a data quality rule. Call list_dq_rules first so you do not duplicate one, and preview_dq_rule so the expression is known to run. ruleType is ${RULE_TYPES.join(', ')}. severity is ${SEVERITIES.join(', ')}. ruleExpression describes the exception: TRUE for records that FAIL. A blank value meets no condition about its value, so write MARKET_CAP < 0, not MARKET_CAP IS NULL OR MARKET_CAP < 0; whether a field must be present is the attribute's required flag. domainCode comes from list_domain_types and attributeCode from search_attributes.`,
  category: 'dq-admin',
  inputSchema: {
    type: 'object',
    properties: {
      ruleCode: { type: 'string', description: 'Unique UPPER_SNAKE code' },
      ruleName: { type: 'string' },
      domainCode: { type: 'string' },
      attributeCode: { type: 'string' },
      ruleType: { type: 'string', enum: RULE_TYPES },
      severity: { type: 'string', enum: SEVERITIES },
      ruleExpression: { type: 'string', description: 'Conditions that raise the exception, for example MARKET_CAP < 0. A record fails when it meets every AND condition of any OR group. A blank value meets no condition about its value; test a blank only with ATTRIBUTE IS NULL.' },
      ruleDescription: { type: 'string' },
      thresholdValue: { type: 'number' },
      autoRemediate: { type: 'boolean' },
    },
    required: ['ruleCode', 'ruleName', 'domainCode', 'ruleType', 'severity', 'ruleExpression'],
  },
  execute: async (args, supabase) => {
    if (!RULE_TYPES.includes(args.ruleType)) throw new Error(`ruleType must be one of ${RULE_TYPES.join(', ')}`);
    if (!SEVERITIES.includes(args.severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
    let attributeId: string | null = null;
    if (args.attributeCode) {
      const { data: attribute, error } = await supabase.schema('metadata_register').from('attribute_register')
        .select('id').eq('attribute_code', args.attributeCode).maybeSingle();
      if (error) throw error;
      if (!attribute) throw new Error(`Unknown attribute ${args.attributeCode}`);
      attributeId = attribute.id;
    }
    const { data, error } = await supabase.schema('data_quality').from('dq_rules').insert({
      rule_code: String(args.ruleCode).trim(),
      rule_name: String(args.ruleName).trim(),
      domain_code: args.domainCode,
      attribute_id: attributeId,
      rule_type: args.ruleType,
      rule_severity: args.severity,
      rule_expression: String(args.ruleExpression).trim(),
      rule_description: args.ruleDescription || null,
      threshold_value: args.thresholdValue ?? null,
      auto_remediate: args.autoRemediate || false,
    }).select().single();
    if (error) throw error;
    return { rule: { id: data.id, ruleCode: data.rule_code, ruleName: data.rule_name, domainCode: data.domain_code, ruleType: data.rule_type, severity: data.rule_severity, failsWhen: data.rule_expression, isActive: data.is_active } };
  },
};

export function registerDQRuleTools(registry: ToolRegistry): void {
  registry.registerTool(listDQRules);
  registry.registerTool(previewDQRule);
  registry.registerTool(createDQRule);
}
