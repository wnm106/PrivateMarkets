import { Context } from '../context';
import { getComplianceEngine } from '../lib/compliance-engine';
import {
  matchPopulationEntity,
  targetsAlongPath,
  textOfAttribute,
  type PopulationCondition,
  type RelationshipHopRef,
} from '../lib/compliance-population';

// `compliance` lives in a non-public Postgres schema; every call must go
// through `.schema('compliance')` first (same convention as tenancy.ts /
// source.ts -- supabase-js only supports schema switching via
// `.schema(name).from(table)` / `.schema(name).rpc(fn)`).
function cx(context: Context) {
  return context.supabase.schema('compliance');
}

export const complianceResolvers = {
  Query: {
    complianceRules: async (_: any, args: { filter?: any }, context: Context) => {
      let query = cx(context).from('rules').select('*').order('created_at', { ascending: false });

      if (args.filter?.ruleCode?.equals) query = query.eq('rule_code', args.filter.ruleCode.equals);
      if (args.filter?.ruleCode?.contains) query = query.ilike('rule_code', `%${args.filter.ruleCode.contains}%`);
      if (args.filter?.ruleCategory) query = query.eq('rule_category', args.filter.ruleCategory);
      if (args.filter?.anchorDomainCode) query = query.eq('anchor_domain_code', args.filter.anchorDomainCode);
      if (args.filter?.isActive !== undefined) query = query.eq('is_active', args.filter.isActive);

      const { data, error } = await query;
      if (error) {
        console.error('Error fetching compliance rules:', error);
        throw new Error('Failed to fetch compliance rules');
      }
      return (data || []).map(mapRule);
    },

    complianceRule: async (_: any, args: { id?: string; ruleCode?: string }, context: Context) => {
      let query = cx(context).from('rules').select('*');
      if (args.id) query = query.eq('id', args.id);
      else if (args.ruleCode) query = query.eq('rule_code', args.ruleCode);
      else throw new Error('Must provide id or ruleCode');

      const { data, error } = await query.maybeSingle();
      if (error) {
        console.error('Error fetching compliance rule:', error);
        throw new Error('Failed to fetch compliance rule');
      }
      return data ? mapRule(data) : null;
    },

    complianceEvaluationRuns: async (_: any, args: { ruleId?: string; first?: number }, context: Context) => {
      let query = cx(context).from('rule_evaluation_runs').select('*').order('started_at', { ascending: false });
      if (args.ruleId) query = query.eq('rule_id', args.ruleId);
      query = query.limit(args.first || 20);

      const { data, error } = await query;
      if (error) {
        console.error('Error fetching compliance evaluation runs:', error);
        throw new Error('Failed to fetch compliance evaluation runs');
      }
      return (data || []).map(mapRun);
    },

    complianceEvaluationRun: async (_: any, args: { id: string }, context: Context) => {
      const { data, error } = await cx(context).from('rule_evaluation_runs').select('*').eq('id', args.id).maybeSingle();
      if (error) {
        console.error('Error fetching compliance evaluation run:', error);
        throw new Error('Failed to fetch compliance evaluation run');
      }
      return data ? mapRun(data) : null;
    },

    complianceResults: async (_: any, args: { filter?: any; pagination?: any }, context: Context) => {
      let query = cx(context).from('rule_evaluation_results').select('*', { count: 'exact' }).order('evaluated_at', { ascending: false });

      if (args.filter?.ruleId?.equals) query = query.eq('rule_id', args.filter.ruleId.equals);
      if (args.filter?.anchorEntityId?.equals) query = query.eq('anchor_entity_id', args.filter.anchorEntityId.equals);
      if (args.filter?.status) query = query.eq('status', args.filter.status);
      if (args.filter?.runId?.equals) query = query.eq('run_id', args.filter.runId.equals);

      const first = args.pagination?.first || 50;
      query = query.limit(first);

      const { data, error, count } = await query;
      if (error) {
        console.error('Error fetching compliance results:', error);
        throw new Error('Failed to fetch compliance results');
      }

      const edges = (data || []).map((row: any) => ({ node: mapResult(row), cursor: row.id }));
      return {
        edges,
        pageInfo: {
          hasNextPage: (count || 0) > edges.length,
          hasPreviousPage: false,
          startCursor: edges[0]?.cursor ?? null,
          endCursor: edges[edges.length - 1]?.cursor ?? null,
        },
        totalCount: count || 0,
      };
    },

    compliancePopulationPreview: async (_: any, args: { input: any }, context: Context) => {
      return previewPopulation(context, args.input);
    },
  },

  Mutation: {
    createComplianceRule: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;
        const { data, error } = await cx(context)
          .from('rules')
          .insert({
            rule_code: input.ruleCode,
            rule_name: input.ruleName,
            rule_category: input.ruleCategory,
            anchor_domain_code: input.anchorDomainCode,
            applies_to_all: input.appliesToAll ?? true,
            description: input.description,
            metadata: input.metadata || {},
            created_by: context.user?.id,
          })
          .select()
          .single();

        if (error) throw error;
        return { rule: mapRule(data), errors: [] };
      } catch (error: any) {
        console.error('Error creating compliance rule:', error);
        return { rule: null, errors: [{ field: 'general', message: error.message, code: 'CREATE_FAILED' }] };
      }
    },

    updateComplianceRule: async (_: any, args: { id: string; input: any }, context: Context) => {
      try {
        const { id, input } = args;
        const updateData: any = { updated_at: new Date().toISOString() };
        if (input.ruleName !== undefined) updateData.rule_name = input.ruleName;
        if (input.ruleCategory !== undefined) updateData.rule_category = input.ruleCategory;
        if (input.appliesToAll !== undefined) updateData.applies_to_all = input.appliesToAll;
        if (input.isActive !== undefined) updateData.is_active = input.isActive;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.metadata !== undefined) updateData.metadata = input.metadata;

        const { data, error } = await cx(context).from('rules').update(updateData).eq('id', id).select().single();
        if (error) throw error;
        return { rule: mapRule(data), errors: [] };
      } catch (error: any) {
        console.error('Error updating compliance rule:', error);
        return { rule: null, errors: [{ field: 'general', message: error.message, code: 'UPDATE_FAILED' }] };
      }
    },

    deleteComplianceRule: async (_: any, args: { id: string }, context: Context) => {
      try {
        const { error } = await cx(context).from('rules').delete().eq('id', args.id);
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        console.error('Error deleting compliance rule:', error);
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'DELETE_FAILED' }] };
      }
    },

    createComplianceRuleVersion: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;

        // Close out the currently-open version (if any) at the moment the
        // new version becomes known, preserving bi-temporal history rather
        // than overwriting it.
        const { data: existingVersions } = await cx(context)
          .from('rule_versions')
          .select('id, version_number')
          .eq('rule_id', input.ruleId)
          .order('version_number', { ascending: false })
          .limit(1);

        const nextVersionNumber = (existingVersions?.[0]?.version_number || 0) + 1;

        if (existingVersions?.[0]?.id) {
          await cx(context)
            .from('rule_versions')
            .update({ system_to: new Date().toISOString() })
            .eq('id', existingVersions[0].id)
            .eq('system_to', '9999-12-31 23:59:59');
        }

        const { data, error } = await cx(context)
          .from('rule_versions')
          .insert({
            rule_id: input.ruleId,
            version_number: nextVersionNumber,
            valid_from: input.validFrom,
            valid_to: input.validTo || '9999-12-31',
            rule_name: input.ruleName,
            description: input.description,
            change_reason: input.changeReason,
            base_domain_code: input.baseDomainCode,
            base_rollup_path: toSnakeHops(input.baseRollupPath),
            group_by_path: toSnakeHops(input.groupByPath),
            group_by_attribute_code: input.groupByAttributeCode,
            numerator_attribute_code: input.numeratorAttributeCode,
            numerator_aggregation: input.numeratorAggregation,
            numerator_dimension: toSnakeDim(input.numeratorDimension),
            denominator_dimension: toSnakeDim(input.denominatorDimension),
            group_by_dimension: toSnakeDim(input.groupByDimension),
            result_transform: input.resultTransform || 'NONE',
            denominator_attribute_code: input.denominatorAttributeCode,
            denominator_aggregation: input.denominatorAggregation,
            denominator_scope: input.denominatorScope || 'SAME_GROUP',
            denominator_constant_value: input.denominatorConstantValue,
            result_unit: input.resultUnit || 'RATIO',
            limit_direction: input.limitDirection,
            soft_limit_value: input.softLimitValue,
            hard_limit_value: input.hardLimitValue,
            default_source_scope: input.defaultSourceScope || 'GOLDEN',
            metadata: input.metadata || {},
            created_by: context.user?.id,
          })
          .select()
          .single();

        if (error) throw error;

        if (input.conditions?.length) {
          const conditionsToInsert = input.conditions.map((cond: any, idx: number) => ({
            rule_version_id: data.id,
            applies_to: cond.appliesTo,
            condition_group: cond.conditionGroup ?? 1,
            condition_order: cond.conditionOrder ?? idx + 1,
            attribute_code: cond.attributeCode,
            attribute_dimension: toSnakeDim(cond.attributeDimension),
            compare_attribute_code: cond.compareAttributeCode,
            compare_dimension: toSnakeDim(cond.compareDimension),
            operator: cond.operator,
            value: cond.value,
            logic_operator: cond.logicOperator ?? 'AND',
          }));

          const { error: condError } = await cx(context).from('rule_conditions').insert(conditionsToInsert);
          if (condError) throw condError;
        }

        return { version: mapVersion(data, []), errors: [] };
      } catch (error: any) {
        console.error('Error creating compliance rule version:', error);
        return { version: null, errors: [{ field: 'general', message: error.message, code: 'CREATE_FAILED' }] };
      }
    },

    createComplianceScopeAssignment: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;
        const { data, error } = await cx(context)
          .from('rule_scope_assignments')
          .insert({
            rule_id: input.ruleId,
            scope_type: input.scopeType,
            entity_id: input.entityId,
            include_children: input.includeChildren ?? false,
            notes: input.notes,
            created_by: context.user?.id,
          })
          .select()
          .single();

        if (error) throw error;
        return { scopeAssignment: mapScopeAssignment(data), errors: [] };
      } catch (error: any) {
        console.error('Error creating compliance scope assignment:', error);
        return { scopeAssignment: null, errors: [{ field: 'general', message: error.message, code: 'CREATE_FAILED' }] };
      }
    },

    deleteComplianceScopeAssignment: async (_: any, args: { id: string }, context: Context) => {
      try {
        const { error } = await cx(context).from('rule_scope_assignments').delete().eq('id', args.id);
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        console.error('Error deleting compliance scope assignment:', error);
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'DELETE_FAILED' }] };
      }
    },

    evaluateComplianceRule: async (_: any, args: { input: any }, context: Context) => {
      try {
        const engine = getComplianceEngine(context.supabase);
        const { run } = await engine.evaluateRule({
          ruleCode: args.input.ruleCode,
          asOfDate: args.input.asOfDate,
          knowledgeDate: args.input.knowledgeDate,
          sourceScope: args.input.sourceScope,
          triggeredBy: context.user?.id,
        });

        const { data: ruleRow } = await cx(context).from('rules').select('*').eq('id', run.ruleId).maybeSingle();

        return {
          run: {
            id: run.id,
            ruleId: run.ruleId,
            rule: ruleRow ? mapRule(ruleRow) : null,
            ruleVersionId: run.ruleVersionId,
            asOfDate: run.asOfDate,
            knowledgeDate: run.knowledgeDate,
            sourceScope: run.sourceScope,
            runStatus: run.runStatus,
            errorMessage: run.errorMessage,
            resultCount: run.resultCount,
            breachCount: run.breachCount,
            triggeredBy: run.triggeredBy,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
          },
          errors: [],
        };
      } catch (error: any) {
        console.error('Error evaluating compliance rule:', error);
        return { run: null, errors: [{ field: 'general', message: error.message, code: 'EVALUATE_FAILED' }] };
      }
    },
  },

  ComplianceRule: {
    versions: async (parent: any, _: any, context: Context) => {
      const { data } = await cx(context)
        .from('rule_versions')
        .select('*, conditions:rule_conditions(*)')
        .eq('rule_id', parent.id)
        .order('version_number', { ascending: false });
      return (data || []).map((row: any) => mapVersion(row, row.conditions || []));
    },

    currentVersion: async (parent: any, args: { asOfDate?: string; knowledgeDate?: string }, context: Context) => {
      const asOfDate = args.asOfDate || new Date().toISOString().slice(0, 10);
      const knowledgeDate = args.knowledgeDate || new Date().toISOString();
      const { data } = await cx(context).rpc('resolve_rule_version', {
        p_rule_id: parent.id,
        p_as_of_date: asOfDate,
        p_knowledge_date: knowledgeDate,
      });
      if (!data || !data.id) return null;

      const { data: conditions } = await cx(context).from('rule_conditions').select('*').eq('rule_version_id', data.id);
      return mapVersion(data, conditions || []);
    },

    scopeAssignments: async (parent: any, _: any, context: Context) => {
      const { data } = await cx(context).from('rule_scope_assignments').select('*').eq('rule_id', parent.id);
      return (data || []).map(mapScopeAssignment);
    },
  },

  ComplianceEvaluationRun: {
    rule: async (parent: any, _: any, context: Context) => {
      const { data } = await cx(context).from('rules').select('*').eq('id', parent.ruleId).maybeSingle();
      return data ? mapRule(data) : null;
    },
    results: async (parent: any, _: any, context: Context) => {
      const { data } = await cx(context).from('rule_evaluation_results').select('*').eq('run_id', parent.id);
      return (data || []).map(mapResult);
    },
  },
};

function toSnakeHops(hops?: Array<{ relationshipCode: string; direction: string; recursive?: boolean }>) {
  return (hops || []).map((h) => ({
    relationship_code: h.relationshipCode,
    direction: h.direction,
    recursive: h.recursive ?? false,
  }));
}

function toSnakeDim(dim?: {
  sourceScope?: string;
  offsetUnit?: string;
  offsetAmount?: number;
  snapTo?: string;
  knowledgeMode?: string;
  relationshipPath?: Array<{ relationshipCode: string; direction: string; recursive?: boolean }>;
} | null) {
  if (!dim) return {};
  const out: Record<string, any> = {};
  if (dim.sourceScope) out.source_scope = dim.sourceScope;
  if (dim.offsetUnit) out.offset_unit = dim.offsetUnit;
  if (dim.offsetAmount !== undefined && dim.offsetAmount !== null) out.offset_amount = dim.offsetAmount;
  if (dim.snapTo) out.snap_to = dim.snapTo;
  if (dim.knowledgeMode) out.knowledge_mode = dim.knowledgeMode;
  const path = (dim.relationshipPath || []).filter((h) => h?.relationshipCode);
  if (path.length) {
    out.relationship_path = path.map((h) => ({
      relationship_code: h.relationshipCode,
      direction: h.direction,
      recursive: !!h.recursive,
    }));
  }
  return out;
}

function toCamelDim(dim: any) {
  if (!dim || Object.keys(dim).length === 0) return null;
  const relationshipPath = Array.isArray(dim.relationship_path)
    ? dim.relationship_path.map((h: any) => ({
        relationshipCode: h.relationship_code,
        direction: h.direction,
        recursive: h.recursive ?? false,
      }))
    : [];
  return {
    sourceScope: dim.source_scope ?? null,
    offsetUnit: dim.offset_unit ?? null,
    offsetAmount: dim.offset_amount ?? null,
    snapTo: dim.snap_to ?? null,
    knowledgeMode: dim.knowledge_mode ?? null,
    relationshipPath,
  };
}

function toCamelHops(hops: any): Array<{ relationshipCode: string; direction: string; recursive: boolean }> {
  return (hops || []).map((h: any) => ({
    relationshipCode: h.relationship_code,
    direction: h.direction,
    recursive: h.recursive ?? false,
  }));
}

function mapRule(row: any) {
  return {
    id: row.id,
    ruleCode: row.rule_code,
    ruleName: row.rule_name,
    ruleCategory: row.rule_category,
    anchorDomainCode: row.anchor_domain_code,
    appliesToAll: row.applies_to_all,
    isActive: row.is_active,
    description: row.description,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function mapVersion(row: any, conditions: any[]) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    versionNumber: row.version_number,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    systemFrom: row.system_from,
    systemTo: row.system_to,
    ruleName: row.rule_name,
    description: row.description,
    changeReason: row.change_reason,
    baseDomainCode: row.base_domain_code,
    baseRollupPath: toCamelHops(row.base_rollup_path),
    groupByPath: toCamelHops(row.group_by_path),
    groupByAttributeCode: row.group_by_attribute_code,
    numeratorAttributeCode: row.numerator_attribute_code,
    numeratorAggregation: row.numerator_aggregation,
    numeratorDimension: toCamelDim(row.numerator_dimension),
    denominatorDimension: toCamelDim(row.denominator_dimension),
    groupByDimension: toCamelDim(row.group_by_dimension),
    resultTransform: row.result_transform || 'NONE',
    denominatorAttributeCode: row.denominator_attribute_code,
    denominatorAggregation: row.denominator_aggregation,
    denominatorScope: row.denominator_scope,
    denominatorConstantValue: row.denominator_constant_value,
    resultUnit: row.result_unit,
    limitDirection: row.limit_direction,
    softLimitValue: row.soft_limit_value,
    hardLimitValue: row.hard_limit_value,
    defaultSourceScope: row.default_source_scope,
    isActive: row.is_active,
    conditions: conditions.map(mapCondition),
    metadata: row.metadata,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function mapCondition(row: any) {
  return {
    id: row.id,
    ruleVersionId: row.rule_version_id,
    appliesTo: row.applies_to,
    conditionGroup: row.condition_group,
    conditionOrder: row.condition_order,
    attributeCode: row.attribute_code,
    attributeDimension: toCamelDim(row.attribute_dimension),
    operator: row.operator,
    value: row.value,
    compareAttributeCode: row.compare_attribute_code,
    compareDimension: toCamelDim(row.compare_dimension),
    logicOperator: row.logic_operator,
    createdAt: row.created_at,
  };
}

function mapScopeAssignment(row: any) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    scopeType: row.scope_type,
    entityId: row.entity_id,
    includeChildren: row.include_children,
    notes: row.notes,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function mapRun(row: any) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleVersionId: row.rule_version_id,
    asOfDate: row.as_of_date,
    knowledgeDate: row.knowledge_date,
    sourceScope: row.source_scope,
    runStatus: row.run_status,
    errorMessage: row.error_message,
    resultCount: row.result_count,
    breachCount: row.breach_count,
    triggeredBy: row.triggered_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapResult(row: any) {
  return {
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
    detail: row.detail,
    evaluatedAt: row.evaluated_at,
  };
}

const POPULATION_CAP = 20000;

function hopsFromDimension(dim: any): RelationshipHopRef[] {
  const raw = dim?.relationshipPath || [];
  return raw
    .map((h: any) => ({
      relationshipCode: h.relationshipCode,
      direction: (h.direction || 'UP').toUpperCase(),
      recursive: !!h.recursive,
    }))
    .filter((h: RelationshipHopRef) => h.relationshipCode);
}

async function previewPopulation(context: Context, input: any) {
  const domainCode = input?.domainCode;
  if (!domainCode) throw new Error('domainCode is required');
  const limit = Math.min(Math.max(Number(input.limit ?? 25) || 25, 1), 100);
  const offset = Math.max(Number(input.offset ?? 0) || 0, 0);
  const asOf = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const conditions: PopulationCondition[] = (input.conditions || [])
    .filter((c: any) => c?.attributeCode)
    .map((c: any) => ({
      conditionGroup: c.conditionGroup,
      conditionOrder: c.conditionOrder,
      attributeCode: c.attributeCode,
      operator: c.operator || 'equals',
      value: c.value ?? null,
      compareAttributeCode: c.compareAttributeCode || null,
      attributePath: hopsFromDimension(c.attributeDimension),
      comparePath: hopsFromDimension(c.compareDimension),
      logicOperator: c.logicOperator || 'AND',
    }));

  const { rows, truncated } = await fetchDomainEntities(context.supabase, domainCode);
  const hopMaps = await loadRelationshipMaps(context.supabase, conditions, asOf, now);

  const attributes = new Map<string, any>();
  const needed = new Set<string>();
  for (const row of rows) {
    for (const cond of conditions) {
      const attributeHops = cond.attributePath || [];
      const compareHops = cond.comparePath || [];
      const attributeIds = attributeHops.length ? targetsAlongPath(row.entity_id, attributeHops, hopMaps) : [row.entity_id];
      const compareIds = cond.compareAttributeCode
        ? (compareHops.length ? targetsAlongPath(row.entity_id, compareHops, hopMaps) : [row.entity_id])
        : [];
      for (const id of [...attributeIds, ...compareIds]) needed.add(id);
    }
  }
  const attributeCodes = [...new Set(conditions.flatMap((cond) => [cond.attributeCode, cond.compareAttributeCode].filter((code): code is string => !!code)))];
  await fetchAttributeValues(context.supabase, [...needed], attributeCodes, attributes, asOf, now);

  const matches: Array<{ entityId: string; entityCode: string; entityName: string | null; values: Record<string, string | null> }> = [];
  for (const row of rows) {
    const result = matchPopulationEntity(
      row.entity_id,
      conditions,
      (id, path) => targetsAlongPath(id, path, hopMaps),
      (id, code) => textOfAttribute(attributes.get(id), code),
    );
    if (result.match) {
      matches.push({
        entityId: row.entity_id,
        entityCode: row.entity_code,
        entityName: row.entity_name,
        values: result.values,
      });
    }
  }

  return {
    total: matches.length,
    scanned: rows.length,
    truncated,
    rows: matches.slice(offset, offset + limit),
  };
}

async function fetchDomainEntities(supabase: Context['supabase'], domainCode: string) {
  const pageSize = 1000;
  const rows: Array<{ entity_id: string; entity_code: string; entity_name: string | null }> = [];
  for (let from = 0; rows.length < POPULATION_CAP; from += pageSize) {
    const { data, error } = await supabase
      .schema('entity_instances')
      .from('master_entities')
      .select('id, entity_code, entity_name')
      .eq('domain_code', domainCode)
      .order('entity_code', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Failed to load ${domainCode} records: ${error.message}`);
    rows.push(...(data || []).map((row: any) => ({ entity_id: row.id, entity_code: row.entity_code, entity_name: row.entity_name })));
    if (!data || data.length < pageSize) return { rows, truncated: false };
  }
  return { rows: rows.slice(0, POPULATION_CAP), truncated: true };
}

async function loadRelationshipMaps(
  supabase: Context['supabase'],
  conditions: PopulationCondition[],
  asOf: string,
  now: string,
) {
  const hops = new Map<string, RelationshipHopRef>();
  for (const cond of conditions) {
    for (const hop of [...(cond.attributePath || []), ...(cond.comparePath || [])]) {
      hops.set(`${hop.direction}:${hop.relationshipCode}`, hop);
    }
  }
  const maps = new Map<string, Map<string, string[]>>();
  const seenCodes = new Set<string>();
  for (const hop of hops.values()) {
    if (seenCodes.has(hop.relationshipCode)) continue;
    seenCodes.add(hop.relationshipCode);
    const { up, down } = await loadBothDirections(supabase, hop.relationshipCode, asOf, now);
    maps.set(`UP:${hop.relationshipCode}`, up);
    maps.set(`DOWN:${hop.relationshipCode}`, down);
  }
  return maps;
}

async function loadBothDirections(supabase: Context['supabase'], relationshipCode: string, asOf: string, now: string) {
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  const pageSize = 1000;
  for (let from = 0; from < 200000; from += pageSize) {
    // public.entity_relationships keeps the caller's JWT. Switching schema with
    // supabase-js drops that header and RLS then hides every row.
    const { data, error } = await supabase
      .from('entity_relationships')
      .select('parent_entity_id, child_entity_id')
      .eq('relationship_code', relationshipCode)
      .lte('valid_from', asOf)
      .gte('valid_to', asOf)
      .lte('system_from', now)
      .gte('system_to', now)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Failed to walk ${relationshipCode}: ${error.message}`);
    for (const row of data || []) {
      const parents = up.get(row.child_entity_id) || [];
      parents.push(row.parent_entity_id);
      up.set(row.child_entity_id, parents);
      const children = down.get(row.parent_entity_id) || [];
      children.push(row.child_entity_id);
      down.set(row.parent_entity_id, children);
    }
    if (!data || data.length < pageSize) break;
  }
  return { up, down };
}

async function fetchAttributeValues(
  supabase: Context['supabase'],
  ids: string[],
  codes: string[],
  into: Map<string, any>,
  asOf: string,
  now: string,
) {
  if (!ids.length || !codes.length) return;
  const { data: definitions, error: defError } = await supabase
    .schema('metadata_register')
    .from('attribute_register')
    .select('id, attribute_code')
    .in('attribute_code', codes);
  if (defError) throw new Error(`Failed to resolve attributes: ${defError.message}`);
  const codeById = new Map((definitions || []).map((row: any) => [row.id, row.attribute_code]));
  const attributeIds = [...codeById.keys()];
  if (!attributeIds.length) return;

  const chunk = 200;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const { data, error } = await supabase
      .schema('golden_master')
      .from('entity_attribute_values')
      .select('entity_id, attribute_id, golden_value, precedence_rank')
      .in('entity_id', slice)
      .in('attribute_id', attributeIds)
      .lte('valid_from', asOf)
      .gte('valid_to', asOf)
      .lte('system_from', now)
      .gte('system_to', now);
    if (error) throw new Error(`Failed to load attribute values: ${error.message}`);
    for (const row of data || []) {
      const code = codeById.get(row.attribute_id);
      if (!code) continue;
      const bag = into.get(row.entity_id) || {};
      const current = bag[code];
      if (!current || row.precedence_rank < current.rank) {
        bag[code] = { value: row.golden_value, rank: row.precedence_rank };
      }
      into.set(row.entity_id, bag);
    }
  }
}
