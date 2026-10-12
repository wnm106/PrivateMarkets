import { ToolRegistry } from '../lib/tool-registry';
import { ToolDefinition } from '../lib/types';

// `compliance` lives in a non-public Postgres schema; every call must go
// through `.schema('compliance')` first.
function cx(supabase: any) {
  return supabase.schema('compliance');
}

const listComplianceRules: ToolDefinition = {
  name: 'list_compliance_rules',
  description: 'List compliance rules (concentration, exposure, diversification, eligibility, leverage, liquidity limits) with optional filtering.',
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      ruleCategory: { type: 'string', enum: ['CONCENTRATION', 'EXPOSURE', 'DIVERSIFICATION', 'ELIGIBILITY', 'LEVERAGE', 'LIQUIDITY', 'OTHER'], description: 'Filter by rule category' },
      anchorDomainCode: { type: 'string', description: 'Filter by the entity level the rule is assigned to (e.g. FUND, ISSUER)' },
      isActive: { type: 'boolean', description: 'Filter by active status' },
    },
  },
  execute: async (args, supabase) => {
    let query = cx(supabase).from('rules').select('*').order('created_at', { ascending: false });
    if (args.ruleCategory) query = query.eq('rule_category', args.ruleCategory);
    if (args.anchorDomainCode) query = query.eq('anchor_domain_code', args.anchorDomainCode);
    if (args.isActive !== undefined) query = query.eq('is_active', args.isActive);

    const { data, error } = await query;
    if (error) throw error;

    return {
      rules: (data || []).map((row: any) => ({
        id: row.id,
        ruleCode: row.rule_code,
        ruleName: row.rule_name,
        ruleCategory: row.rule_category,
        anchorDomainCode: row.anchor_domain_code,
        appliesToAll: row.applies_to_all,
        isActive: row.is_active,
        description: row.description,
      })),
    };
  },
};

const getComplianceRuleVersion: ToolDefinition = {
  name: 'get_compliance_rule_version',
  description: 'Resolve which rule_version of a compliance rule is bi-temporally in force for a given as-of date (valid time) and knowledge date (system time). Use this to inspect historical rule behavior.',
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      ruleCode: { type: 'string', description: 'The rule_code to resolve' },
      asOfDate: { type: 'string', description: 'Valid-time date (YYYY-MM-DD), e.g. the business date being evaluated' },
      knowledgeDate: { type: 'string', description: 'System/knowledge time (ISO timestamp). Defaults to now. Use a past timestamp to see what the rule looked like back then.' },
    },
    required: ['ruleCode', 'asOfDate'],
  },
  execute: async (args, supabase) => {
    const { data: rule, error: ruleError } = await cx(supabase).from('rules').select('id').eq('rule_code', args.ruleCode).single();
    if (ruleError) throw ruleError;

    const { data, error } = await cx(supabase).rpc('resolve_rule_version', {
      p_rule_id: rule.id,
      p_as_of_date: args.asOfDate,
      p_knowledge_date: args.knowledgeDate || new Date().toISOString(),
    });
    if (error) throw error;

    return { version: data };
  },
};

const evaluateComplianceRule: ToolDefinition = {
  name: 'evaluate_compliance_rule',
  description: 'Run a compliance rule for a given as-of date (valid time), knowledge date (system time), and source scope (golden master or a single named source). Rolls up base entities per the rule definition, applies conditions, computes numerator/denominator, and compares against hard/soft limits. Returns the run summary (result/breach counts).',
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      ruleCode: { type: 'string', description: 'The rule_code to evaluate' },
      asOfDate: { type: 'string', description: 'Valid-time date (YYYY-MM-DD) to evaluate' },
      knowledgeDate: { type: 'string', description: 'System/knowledge time (ISO timestamp). Defaults to now.' },
      sourceScope: { type: 'string', description: "'GOLDEN' (default) or a specific source_code (e.g. 'BLOOMBERG') for single-source evaluation" },
    },
    required: ['ruleCode', 'asOfDate'],
  },
  execute: async (args, supabase) => {
    const { data: runId, error } = await cx(supabase).rpc('evaluate_rule', {
      p_rule_code: args.ruleCode,
      p_as_of_date: args.asOfDate,
      p_knowledge_date: args.knowledgeDate || new Date().toISOString(),
      p_source_scope: args.sourceScope || null,
      p_triggered_by: null,
    });
    if (error) throw error;

    const { data: run, error: runError } = await cx(supabase).from('rule_evaluation_runs').select('*').eq('id', runId).single();
    if (runError) throw runError;

    return {
      runId: run.id,
      runStatus: run.run_status,
      asOfDate: run.as_of_date,
      knowledgeDate: run.knowledge_date,
      sourceScope: run.source_scope,
      resultCount: run.result_count,
      breachCount: run.breach_count,
      errorMessage: run.error_message,
    };
  },
};

const listComplianceBreaches: ToolDefinition = {
  name: 'list_compliance_breaches',
  description: 'List compliance evaluation results that are in SOFT_BREACH or HARD_BREACH status, optionally scoped to a specific rule or run.',
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      ruleId: { type: 'string', description: 'Filter by rule id' },
      runId: { type: 'string', description: 'Filter by a specific evaluation run id' },
      status: { type: 'string', enum: ['SOFT_BREACH', 'HARD_BREACH'], description: 'Filter by breach severity; omit to return both' },
      first: { type: 'number', description: 'Max number of results to return', default: 50 },
    },
  },
  execute: async (args, supabase) => {
    let query = cx(supabase).from('rule_evaluation_results').select('*').order('evaluated_at', { ascending: false });

    if (args.ruleId) query = query.eq('rule_id', args.ruleId);
    if (args.runId) query = query.eq('run_id', args.runId);
    if (args.status) {
      query = query.eq('status', args.status);
    } else {
      query = query.in('status', ['SOFT_BREACH', 'HARD_BREACH']);
    }
    query = query.limit(args.first || 50);

    const { data, error } = await query;
    if (error) throw error;

    return {
      breaches: (data || []).map((row: any) => ({
        id: row.id,
        runId: row.run_id,
        ruleId: row.rule_id,
        anchorEntityId: row.anchor_entity_id,
        groupByValue: row.group_by_value,
        asOfDate: row.as_of_date,
        numeratorValue: row.numerator_value,
        denominatorValue: row.denominator_value,
        computedValue: row.computed_value,
        limitDirection: row.limit_direction,
        softLimitValue: row.soft_limit_value,
        hardLimitValue: row.hard_limit_value,
        status: row.status,
        breachAmount: row.breach_amount,
        contributingCount: row.contributing_count,
      })),
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Write tools – allow agents to create and manage compliance rules
// ────────────────────────────────────────────────────────────────────────────

const getComplianceRule: ToolDefinition = {
  name: 'get_compliance_rule',
  description: 'Get full details of a compliance rule including all versions, conditions, and scope assignments. Use this to inspect a rule before modifying it.',
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      ruleCode: { type: 'string', description: 'The rule_code to look up' },
      id: { type: 'string', description: 'The rule UUID (alternative to ruleCode)' },
    },
  },
  execute: async (args, supabase) => {
    let query = cx(supabase).from('rules').select('*');
    if (args.id) query = query.eq('id', args.id);
    else if (args.ruleCode) query = query.eq('rule_code', args.ruleCode);
    else throw new Error('Must provide id or ruleCode');

    const { data: rule, error: ruleError } = await query.maybeSingle();
    if (ruleError) throw ruleError;
    if (!rule) return { rule: null };

    const { data: versions } = await cx(supabase)
      .from('rule_versions')
      .select('*, conditions:rule_conditions(*)')
      .eq('rule_id', rule.id)
      .order('version_number', { ascending: false });

    const { data: scopeAssignments } = await cx(supabase)
      .from('scope_assignments')
      .select('*')
      .eq('rule_id', rule.id);

    return {
      rule: {
        id: rule.id, ruleCode: rule.rule_code, ruleName: rule.rule_name,
        ruleCategory: rule.rule_category, anchorDomainCode: rule.anchor_domain_code,
        appliesToAll: rule.applies_to_all, isActive: rule.is_active,
        description: rule.description, metadata: rule.metadata,
        createdAt: rule.created_at, createdBy: rule.created_by,
        versions: (versions || []).map((v: any) => mapVersionRow(v)),
        scopeAssignments: (scopeAssignments || []).map((s: any) => ({
          id: s.id, scopeType: s.scope_type, entityId: s.entity_id,
          includeChildren: s.include_children, notes: s.notes,
          createdAt: s.created_at, createdBy: s.created_by,
        })),
      },
    };
  },
};

function mapVersionRow(v: any) {
  return {
    id: v.id, versionNumber: v.version_number,
    validFrom: v.valid_from, validTo: v.valid_to,
    systemFrom: v.system_from, systemTo: v.system_to,
    changeReason: v.change_reason,
    baseDomainCode: v.base_domain_code,
    baseRollupPath: v.base_rollup_path, groupByPath: v.group_by_path,
    groupByAttributeCode: v.group_by_attribute_code,
    numeratorAttributeCode: v.numerator_attribute_code,
    numeratorAggregation: v.numerator_aggregation,
    numeratorDimension: v.numerator_dimension,
    denominatorAttributeCode: v.denominator_attribute_code,
    denominatorAggregation: v.denominator_aggregation,
    denominatorDimension: v.denominator_dimension,
    denominatorScope: v.denominator_scope,
    denominatorConstantValue: v.denominator_constant_value,
    groupByDimension: v.group_by_dimension,
    resultTransform: v.result_transform, resultUnit: v.result_unit,
    limitDirection: v.limit_direction,
    softLimitValue: v.soft_limit_value, hardLimitValue: v.hard_limit_value,
    defaultSourceScope: v.default_source_scope, isActive: v.is_active,
    conditions: (v.conditions || []).map((c: any) => ({
      id: c.id, appliesTo: c.applies_to, conditionGroup: c.condition_group,
      conditionOrder: c.condition_order, attributeCode: c.attribute_code,
      attributeDimension: c.attribute_dimension, operator: c.operator,
      value: c.value, compareAttributeCode: c.compare_attribute_code,
      compareDimension: c.compare_dimension, logicOperator: c.logic_operator,
    })),
    metadata: v.metadata, createdAt: v.created_at, createdBy: v.created_by,
  };
}

const createComplianceRule: ToolDefinition = {
  name: 'create_compliance_rule',
  description: 'Create a new compliance rule identity. After creating the rule, use create_compliance_rule_version to add the first version with rollup logic, conditions, and limits. Use create_compliance_scope_assignment to assign specific entities if applies_to_all is false.',
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      ruleCode: { type: 'string', description: 'Unique code for the rule (e.g. "FUND_CONC_5PCT")' },
      ruleName: { type: 'string', description: 'Human-readable name (e.g. "Fund Concentration 5% Limit")' },
      ruleCategory: { type: 'string', enum: ['CONCENTRATION', 'EXPOSURE', 'DIVERSIFICATION', 'ELIGIBILITY', 'LEVERAGE', 'LIQUIDITY', 'OTHER'], description: 'Category of the rule' },
      anchorDomainCode: { type: 'string', description: 'The domain code this rule anchors to (e.g. "FUND", "ISSUER"). Must be a valid domain_type.' },
      appliesToAll: { type: 'boolean', description: 'If true, applies to all entities of anchor domain by default. If false, only explicitly assigned entities. Default: true.' },
      isActive: { type: 'boolean', description: 'Whether the rule is active. Default: true.' },
      description: { type: 'string', description: 'Description of the rule purpose' },
      metadata: { type: 'object', description: 'Optional JSON metadata' },
    },
    required: ['ruleCode', 'ruleName', 'ruleCategory', 'anchorDomainCode'],
  },
  execute: async (args, supabase) => {
    const { data, error } = await cx(supabase)
      .from('rules')
      .insert({
        rule_code: args.ruleCode,
        rule_name: args.ruleName,
        rule_category: args.ruleCategory,
        anchor_domain_code: args.anchorDomainCode,
        applies_to_all: args.appliesToAll !== undefined ? args.appliesToAll : true,
        is_active: args.isActive !== undefined ? args.isActive : true,
        description: args.description || null,
        metadata: args.metadata || null,
      })
      .select()
      .single();
    if (error) throw error;

    return {
      rule: {
        id: data.id, ruleCode: data.rule_code, ruleName: data.rule_name,
        ruleCategory: data.rule_category, anchorDomainCode: data.anchor_domain_code,
        appliesToAll: data.applies_to_all, isActive: data.is_active,
        description: data.description, createdAt: data.created_at,
      },
    };
  },
};

const updateComplianceRule: ToolDefinition = {
  name: 'update_compliance_rule',
  description: "Update a compliance rule's metadata (name, category, active status, description). Does NOT change rule logic — use create_compliance_rule_version for that.",
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The rule UUID to update' },
      ruleCode: { type: 'string', description: 'The rule_code to look up (alternative to id)' },
      ruleName: { type: 'string', description: 'New rule name' },
      ruleCategory: { type: 'string', enum: ['CONCENTRATION', 'EXPOSURE', 'DIVERSIFICATION', 'ELIGIBILITY', 'LEVERAGE', 'LIQUIDITY', 'OTHER'] },
      appliesToAll: { type: 'boolean' },
      isActive: { type: 'boolean' },
      description: { type: 'string' },
    },
  },
  execute: async (args, supabase) => {
    let ruleId = args.id;
    if (!ruleId && args.ruleCode) {
      const { data: rule, error: lookupError } = await cx(supabase)
        .from('rules').select('id').eq('rule_code', args.ruleCode).single();
      if (lookupError) throw lookupError;
      ruleId = rule.id;
    }
    if (!ruleId) throw new Error('Must provide id or ruleCode');

    const updatePayload: Record<string, any> = {};
    if (args.ruleName !== undefined) updatePayload.rule_name = args.ruleName;
    if (args.ruleCategory !== undefined) updatePayload.rule_category = args.ruleCategory;
    if (args.appliesToAll !== undefined) updatePayload.applies_to_all = args.appliesToAll;
    if (args.isActive !== undefined) updatePayload.is_active = args.isActive;
    if (args.description !== undefined) updatePayload.description = args.description;

    if (Object.keys(updatePayload).length === 0) return { message: 'No fields to update' };

    const { data, error } = await cx(supabase)
      .from('rules').update(updatePayload).eq('id', ruleId).select().single();
    if (error) throw error;

    return {
      rule: {
        id: data.id, ruleCode: data.rule_code, ruleName: data.rule_name,
        ruleCategory: data.rule_category, anchorDomainCode: data.anchor_domain_code,
        appliesToAll: data.applies_to_all, isActive: data.is_active,
        description: data.description,
      },
    };
  },
};

const deleteComplianceRule: ToolDefinition = {
  name: 'delete_compliance_rule',
  description: 'Delete a compliance rule and all its versions, conditions, scope assignments, and evaluation history. Use with caution. Alternatively, use update_compliance_rule to set isActive=false.',
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The rule UUID to delete' },
      ruleCode: { type: 'string', description: 'The rule_code to look up (alternative to id)' },
    },
  },
  execute: async (args, supabase) => {
    let ruleId = args.id;
    if (!ruleId && args.ruleCode) {
      const { data: rule, error: lookupError } = await cx(supabase)
        .from('rules').select('id').eq('rule_code', args.ruleCode).single();
      if (lookupError) throw lookupError;
      ruleId = rule.id;
    }
    if (!ruleId) throw new Error('Must provide id or ruleCode');

    // Delete in dependency order
    const { data: runs } = await cx(supabase)
      .from('rule_evaluation_runs').select('id').eq('rule_id', ruleId);
    if (runs && runs.length > 0) {
      const runIds = runs.map((r: any) => r.id);
      await cx(supabase).from('rule_evaluation_results').delete().in('run_id', runIds);
    }
    await cx(supabase).from('rule_evaluation_runs').delete().eq('rule_id', ruleId);

    const { data: versions } = await cx(supabase)
      .from('rule_versions').select('id').eq('rule_id', ruleId);
    if (versions && versions.length > 0) {
      const versionIds = versions.map((v: any) => v.id);
      await cx(supabase).from('rule_conditions').delete().in('rule_version_id', versionIds);
    }
    await cx(supabase).from('rule_versions').delete().eq('rule_id', ruleId);

    await cx(supabase).from('scope_assignments').delete().eq('rule_id', ruleId);

    const { error } = await cx(supabase).from('rules').delete().eq('id', ruleId);
    if (error) throw error;

    return { success: true, deletedRuleId: ruleId };
  },
};

const createComplianceRuleVersion: ToolDefinition = {
  name: 'create_compliance_rule_version',
  description: 'Create a new version of a compliance rule with rollup logic, numerator/denominator configuration, limits, and optional conditions. This is the main tool for defining rule logic. The version auto-increments and becomes the current version for the given valid_from date.',
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      ruleId: { type: 'string', description: 'The rule UUID to create a version for' },
      ruleCode: { type: 'string', description: 'The rule_code (alternative to ruleId)' },
      changeReason: { type: 'string', description: 'Why this version was created' },
      validFrom: { type: 'string', description: 'Valid-time start date (YYYY-MM-DD). Defaults to today.' },
      validTo: { type: 'string', description: 'Valid-time end date (YYYY-MM-DD). NULL = open-ended.' },
      baseDomainCode: { type: 'string', description: 'Domain code of base entities to aggregate' },
      baseRollupPath: { type: 'array', items: { type: 'object', properties: { relationshipCode: { type: 'string' }, direction: { type: 'string', enum: ['UP', 'DOWN'] }, maxHops: { type: 'number' }, includeEndpoints: { type: 'boolean' } } }, description: 'Hops from anchor to base. Empty = single-record.' },
      groupByPath: { type: 'array', items: { type: 'object', properties: { relationshipCode: { type: 'string' }, direction: { type: 'string', enum: ['UP', 'DOWN'] }, maxHops: { type: 'number' }, includeEndpoints: { type: 'boolean' } } }, description: 'Hops from base to group-by entity.' },
      groupByAttributeCode: { type: 'string', description: 'Attribute to group by (e.g. "INDUSTRY")' },
      numeratorAttributeCode: { type: 'string', description: 'Attribute for numerator (e.g. "MARKET_VALUE")' },
      numeratorAggregation: { type: 'string', enum: ['SUM', 'COUNT', 'AVG', 'MAX', 'MIN'] },
      numeratorDimension: { type: 'object', description: 'Optional bi-temporal dimension override' },
      denominatorAttributeCode: { type: 'string', description: 'Attribute for denominator (omit if using constant)' },
      denominatorAggregation: { type: 'string', enum: ['SUM', 'COUNT', 'AVG', 'MAX', 'MIN'] },
      denominatorDimension: { type: 'object' },
      denominatorScope: { type: 'string', enum: ['ROLLUP', 'ANCHOR', 'UNIVERSE'], description: 'Default: ROLLUP' },
      denominatorConstantValue: { type: 'number', description: 'Fixed denominator value' },
      groupByDimension: { type: 'object' },
      resultTransform: { type: 'string', enum: ['NONE', 'COMPLEMENT_TO_100', 'INVERT'], description: 'Default: NONE' },
      resultUnit: { type: 'string', enum: ['PERCENT', 'RATIO', 'CURRENCY', 'COUNT'] },
      limitDirection: { type: 'string', enum: ['LEQ', 'GEQ'], description: 'LEQ=upper, GEQ=lower. Default: LEQ' },
      softLimitValue: { type: 'number', description: 'Soft limit (warning)' },
      hardLimitValue: { type: 'number', description: 'Hard limit (breach)' },
      defaultSourceScope: { type: 'string', description: '"GOLDEN" or source_code. Default: GOLDEN' },
      conditions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            appliesTo: { type: 'string', enum: ['ANCHOR', 'BASE'] },
            conditionGroup: { type: 'number', description: 'Same group=ANDed, different groups=ORed' },
            conditionOrder: { type: 'number' },
            attributeCode: { type: 'string' },
            attributeDimension: { type: 'object' },
            operator: { type: 'string', enum: ['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IN', 'NOT_IN', 'IS_NULL', 'IS_NOT_NULL', 'LIKE', 'BETWEEN'] },
            value: { description: 'Value to compare against' },
            compareAttributeCode: { type: 'string', description: 'Compare vs another attribute' },
            compareDimension: { type: 'object' },
            logicOperator: { type: 'string', enum: ['AND', 'OR'], description: 'Default: AND' },
          },
          required: ['appliesTo', 'conditionGroup', 'attributeCode', 'operator'],
        },
        description: 'Eligibility conditions filtering entities',
      },
    },
    required: ['baseDomainCode', 'numeratorAttributeCode', 'numeratorAggregation', 'limitDirection'],
  },
  execute: async (args, supabase) => {
    let ruleId = args.ruleId;
    if (!ruleId && args.ruleCode) {
      const { data: rule, error: lookupError } = await cx(supabase)
        .from('rules').select('id').eq('rule_code', args.ruleCode).single();
      if (lookupError) throw lookupError;
      ruleId = rule.id;
    }
    if (!ruleId) throw new Error('Must provide ruleId or ruleCode');

    const { data: maxVersion } = await cx(supabase)
      .from('rule_versions').select('version_number')
      .eq('rule_id', ruleId).order('version_number', { ascending: false }).limit(1).maybeSingle();
    const nextVersion = (maxVersion?.version_number || 0) + 1;

    const versionPayload: Record<string, any> = {
      rule_id: ruleId, version_number: nextVersion,
      change_reason: args.changeReason || null,
      valid_from: args.validFrom || new Date().toISOString().slice(0, 10),
      valid_to: args.validTo || null,
      base_domain_code: args.baseDomainCode,
      base_rollup_path: args.baseRollupPath ? JSON.stringify(args.baseRollupPath) : '[]',
      group_by_path: args.groupByPath ? JSON.stringify(args.groupByPath) : '[]',
      group_by_attribute_code: args.groupByAttributeCode || null,
      numerator_attribute_code: args.numeratorAttributeCode,
      numerator_aggregation: args.numeratorAggregation,
      numerator_dimension: args.numeratorDimension || null,
      denominator_attribute_code: args.denominatorAttributeCode || null,
      denominator_aggregation: args.denominatorAggregation || null,
      denominator_dimension: args.denominatorDimension || null,
      denominator_scope: args.denominatorScope || 'ROLLUP',
      denominator_constant_value: args.denominatorConstantValue ?? null,
      group_by_dimension: args.groupByDimension || null,
      result_transform: args.resultTransform || 'NONE',
      result_unit: args.resultUnit || 'PERCENT',
      limit_direction: args.limitDirection,
      soft_limit_value: args.softLimitValue ?? null,
      hard_limit_value: args.hardLimitValue ?? null,
      default_source_scope: args.defaultSourceScope || 'GOLDEN',
      is_active: true,
    };

    const { data: version, error: versionError } = await cx(supabase)
      .from('rule_versions').insert(versionPayload).select().single();
    if (versionError) throw versionError;

    const createdConditions: any[] = [];
    if (args.conditions && args.conditions.length > 0) {
      const conditionRows = args.conditions.map((c: any) => ({
        rule_version_id: version.id, applies_to: c.appliesTo,
        condition_group: c.conditionGroup, condition_order: c.conditionOrder || 0,
        attribute_code: c.attributeCode, attribute_dimension: c.attributeDimension || null,
        operator: c.operator,
        value: c.value !== undefined ? (typeof c.value === 'object' ? JSON.stringify(c.value) : c.value) : null,
        compare_attribute_code: c.compareAttributeCode || null,
        compare_dimension: c.compareDimension || null,
        logic_operator: c.logicOperator || 'AND',
      }));
      const { data: conditions, error: condError } = await cx(supabase)
        .from('rule_conditions').insert(conditionRows).select();
      if (condError) throw condError;
      createdConditions.push(...(conditions || []));
    }

    return {
      version: {
        id: version.id, ruleId: version.rule_id, versionNumber: version.version_number,
        validFrom: version.valid_from, validTo: version.valid_to,
        changeReason: version.change_reason, baseDomainCode: version.base_domain_code,
        baseRollupPath: version.base_rollup_path, groupByPath: version.group_by_path,
        groupByAttributeCode: version.group_by_attribute_code,
        numeratorAttributeCode: version.numerator_attribute_code,
        numeratorAggregation: version.numerator_aggregation,
        numeratorDimension: version.numerator_dimension,
        denominatorAttributeCode: version.denominator_attribute_code,
        denominatorAggregation: version.denominator_aggregation,
        denominatorDimension: version.denominator_dimension,
        denominatorScope: version.denominator_scope,
        denominatorConstantValue: version.denominator_constant_value,
        groupByDimension: version.group_by_dimension,
        resultTransform: version.result_transform, resultUnit: version.result_unit,
        limitDirection: version.limit_direction,
        softLimitValue: version.soft_limit_value, hardLimitValue: version.hard_limit_value,
        defaultSourceScope: version.default_source_scope, isActive: version.is_active,
        conditions: createdConditions.map((c: any) => ({
          id: c.id, appliesTo: c.applies_to, conditionGroup: c.condition_group,
          conditionOrder: c.condition_order, attributeCode: c.attribute_code,
          operator: c.operator, value: c.value,
          compareAttributeCode: c.compare_attribute_code, logicOperator: c.logic_operator,
        })),
        createdAt: version.created_at,
      },
    };
  },
};

const createComplianceScopeAssignment: ToolDefinition = {
  name: 'create_compliance_scope_assignment',
  description: "Assign an entity to a compliance rule's scope. Use scopeType INCLUDE to add entities when applies_to_all is false, or EXCLUDE to carve out exceptions when applies_to_all is true.",
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      ruleId: { type: 'string', description: 'The rule UUID' },
      ruleCode: { type: 'string', description: 'The rule_code (alternative to ruleId)' },
      scopeType: { type: 'string', enum: ['INCLUDE', 'EXCLUDE'], description: 'INCLUDE to add, EXCLUDE to carve out' },
      entityId: { type: 'string', description: 'UUID of the entity' },
      entityCode: { type: 'string', description: 'Entity code (alternative to entityId)' },
      includeChildren: { type: 'boolean', description: 'Include child entities. Default: false.' },
      notes: { type: 'string', description: 'Optional notes' },
    },
    required: ['scopeType'],
  },
  execute: async (args, supabase) => {
    let ruleId = args.ruleId;
    if (!ruleId && args.ruleCode) {
      const { data: rule, error: lookupError } = await cx(supabase)
        .from('rules').select('id').eq('rule_code', args.ruleCode).single();
      if (lookupError) throw lookupError;
      ruleId = rule.id;
    }
    if (!ruleId) throw new Error('Must provide ruleId or ruleCode');

    let entityId = args.entityId;
    if (!entityId && args.entityCode) {
      const { data: entity, error: entityError } = await supabase
        .from('entity_instances').select('id').eq('entity_code', args.entityCode).single();
      if (entityError) throw entityError;
      entityId = entity.id;
    }
    if (!entityId) throw new Error('Must provide entityId or entityCode');

    const { data, error } = await cx(supabase)
      .from('scope_assignments')
      .insert({
        rule_id: ruleId, scope_type: args.scopeType, entity_id: entityId,
        include_children: args.includeChildren || false, notes: args.notes || null,
      })
      .select().single();
    if (error) throw error;

    return {
      scopeAssignment: {
        id: data.id, ruleId: data.rule_id, scopeType: data.scope_type,
        entityId: data.entity_id, includeChildren: data.include_children,
        notes: data.notes, createdAt: data.created_at,
      },
    };
  },
};

const deleteComplianceScopeAssignment: ToolDefinition = {
  name: 'delete_compliance_scope_assignment',
  description: 'Remove a scope assignment from a compliance rule.',
  category: 'compliance',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The scope assignment UUID to delete' },
    },
    required: ['id'],
  },
  execute: async (args, supabase) => {
    const { error } = await cx(supabase)
      .from('scope_assignments').delete().eq('id', args.id);
    if (error) throw error;
    return { success: true, deletedId: args.id };
  },
};

export function registerComplianceTools(registry: ToolRegistry): void {
  // Read tools
  registry.registerTool(listComplianceRules);
  registry.registerTool(getComplianceRule);
  registry.registerTool(getComplianceRuleVersion);
  registry.registerTool(evaluateComplianceRule);
  registry.registerTool(listComplianceBreaches);

  // Write tools
  registry.registerTool(createComplianceRule);
  registry.registerTool(updateComplianceRule);
  registry.registerTool(deleteComplianceRule);
  registry.registerTool(createComplianceRuleVersion);
  registry.registerTool(createComplianceScopeAssignment);
  registry.registerTool(deleteComplianceScopeAssignment);
}
