import { Context } from '../context';
import { ComplianceEngine, getComplianceEngine } from '../lib/compliance-engine';
import { commitAllocation, loadAllocationDraft, type AllocationHold } from '../lib/allocation-store';
import type { AllocationAdjustment } from '../lib/allocation-engine';
import {
  matchPopulationEntity,
  targetsAlongPath,
  textOfAttribute,
  type PopulationCondition,
  type RelationshipHopRef,
  conditionExpressionReads,
} from '../lib/compliance-population';
import { parseFundBoardResultPayload, selectLatestFundResults } from '../lib/fund-board-results';
import { DEAL_SURFACE_RULE_CODES, dealSurfaceResults, rulesToScore } from '../lib/deal-compliance';

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

    complianceResultContributors: async (_: any, args: { resultId: string }, context: Context) => {
      return loadResultContributors(context, args.resultId);
    },

    compliancePopulationPreview: async (_: any, args: { input: any }, context: Context) => {
      return previewPopulation(context, args.input);
    },

    complianceFundBoard: async (_: any, __: any, context: Context) => {
      return loadFundBoard(context);
    },

    evaluateComplianceProforma: async (_: any, args: {
      anchorEntityId: string;
      legs: Array<{ securityId?: string | null; securityCode?: string | null; par: number; attributes?: Record<string, unknown> | null }>;
      asOfDate: string;
      knowledgeDate?: string | null;
      sourceScope?: string | null;
      ruleCodes?: string[] | null;
    }, context: Context) => {
      try {
        const engine = new ComplianceEngine(context.supabase);
        const score = await engine.evaluateProforma({
          anchorEntityId: args.anchorEntityId,
          legs: args.legs,
          asOfDate: args.asOfDate,
          knowledgeDate: args.knowledgeDate || undefined,
          sourceScope: args.sourceScope,
          ruleCodes: args.ruleCodes,
        });
        return { ...score, errors: [] };
      } catch (error: any) {
        console.error('Error evaluating compliance proforma:', error);
        return { approved: false, lines: [], errors: [{ field: 'general', message: error.message, code: 'EVALUATE_FAILED' }] };
      }
    },

    investmentCapacity: async (_: any, args: {
      anchorEntityId: string;
      securityId?: string | null;
      securityCode?: string | null;
      asOfDate: string;
      knowledgeDate?: string | null;
      sourceScope?: string | null;
      ruleCodes?: string[] | null;
      limitKind?: string | null;
      legs?: Array<{ securityId?: string | null; securityCode?: string | null; par: number; attributes?: Record<string, unknown> | null }> | null;
    }, context: Context) => {
      try {
        const requested = args.limitKind ? args.limitKind.toUpperCase() : 'HARD';
        if (requested !== 'HARD' && requested !== 'SOFT') {
          throw new Error('limitKind is HARD or SOFT');
        }
        const engine = new ComplianceEngine(context.supabase);
        const quote = await engine.investmentCapacity({
          anchorEntityId: args.anchorEntityId,
          securityId: args.securityId,
          securityCode: args.securityCode,
          asOfDate: args.asOfDate,
          knowledgeDate: args.knowledgeDate || undefined,
          sourceScope: args.sourceScope,
          ruleCodes: args.ruleCodes,
          limitKind: requested,
          legs: args.legs,
        });
        return { ...quote, errors: [] };
      } catch (error: any) {
        console.error('Error calculating investment capacity:', error);
        return {
          capacityPar: null,
          bindingRuleCode: null,
          bindingGroup: null,
          lines: [],
          errors: [{ field: 'general', message: error.message, code: 'EVALUATE_FAILED' }],
        };
      }
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

        // Direction is set on the fund limit. Keep the previous version's value only
        // so a test that has not been given a fund limit yet still breaches the same way.
        let limitDirection = input.limitDirection || null;
        // The editor does not show fund consolidation, so a new version keeps the previous setting.
        let consolidateDescendants: boolean | null = typeof input.consolidateDescendants === 'boolean' ? input.consolidateDescendants : null;
        if ((!limitDirection || consolidateDescendants === null) && existingVersions?.[0]?.id) {
          const { data: previous } = await cx(context)
            .from('rule_versions')
            .select('limit_direction, consolidate_descendants')
            .eq('id', existingVersions[0].id)
            .maybeSingle();
          limitDirection = limitDirection || previous?.limit_direction || null;
          if (consolidateDescendants === null) consolidateDescendants = Boolean(previous?.consolidate_descendants);
        }

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
            denominator_source: input.denominatorSource || 'BASE',
            denominator_constant_value: input.denominatorConstantValue,
            result_unit: input.resultUnit || 'RATIO',
            limit_direction: limitDirection,
            soft_limit_value: input.softLimitValue,
            hard_limit_value: input.hardLimitValue,
            hard_limit_attribute_code: input.hardLimitAttributeCode,
            soft_limit_factor: input.softLimitFactor,
            consolidate_descendants: consolidateDescendants ?? false,
            default_source_scope: input.defaultSourceScope || 'GOLDEN',
            metadata: input.metadata || {},
            created_by: context.user?.id,
          })
          .select()
          .single();

        if (error) throw error;

        let storedConditions: any[] = [];
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
            // These columns arrive with migration 20261103090000; only send them when used.
            ...(cond.leftExpression ? { left_expression: cond.leftExpression } : {}),
            ...(cond.rightExpression ? { right_expression: cond.rightExpression } : {}),
          }));

          const { data: condRows, error: condError } = await cx(context).from('rule_conditions').insert(conditionsToInsert).select('*');
          if (condError) throw condError;
          storedConditions = condRows || [];
        }

        const storedLines = await insertMeasureLines(context, data.id, input.measureLines || []);
        return { version: mapVersion(data, storedConditions, storedLines), errors: [] };
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

    upsertComplianceThreshold: async (_: any, args: { input: any }, context: Context) => {
      try {
        const input = args.input;
        const row: Record<string, unknown> = {
          rule_id: input.ruleId,
          entity_id: input.entityId || null,
          group_value: input.groupValue ? String(input.groupValue).trim() : null,
          rank_from: input.rankFrom ?? null,
          rank_to: input.rankTo ?? null,
          soft_limit_value: input.softLimitValue ?? null,
          hard_limit_value: input.hardLimitValue ?? null,
          applies: input.applies !== false,
          notes: input.notes || null,
          updated_at: new Date().toISOString(),
        };
        if (input.limitDirection === 'MIN' || input.limitDirection === 'MAX') {
          row.limit_direction = input.limitDirection;
        } else if (!input.id) {
          row.limit_direction = 'MAX';
        }
        const query = input.id
          ? cx(context).from('rule_thresholds').update(row).eq('id', input.id)
          : cx(context).from('rule_thresholds').insert(row);
        const { data, error } = await query.select().single();
        if (error) throw error;
        return { threshold: mapThreshold(data), errors: [] };
      } catch (error: any) {
        console.error('Error saving compliance threshold:', error);
        return { threshold: null, errors: [{ field: 'general', message: error.message, code: 'SAVE_FAILED' }] };
      }
    },

    deleteComplianceThreshold: async (_: any, args: { id: string }, context: Context) => {
      try {
        const { error } = await cx(context).from('rule_thresholds').delete().eq('id', args.id);
        if (error) throw error;
        return { success: true, errors: [] };
      } catch (error: any) {
        console.error('Error deleting compliance threshold:', error);
        return { success: false, errors: [{ field: 'general', message: error.message, code: 'DELETE_FAILED' }] };
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
          anchorEntityId: args.input.entityId || undefined,
          scenarioCode: args.input.scenarioCode || undefined,
          allFunds: Boolean(args.input.allFunds),
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

    scoreDealCompliance: async (_: any, args: { dealId: string; asOfDate?: string | null; holds?: any[] | null; adjustments?: any[] | null }, context: Context) => {
      try {
        const holds: AllocationHold[] | null = args.holds
          ? args.holds.map((item) => ({ trancheId: item.trancheId, holdPct: Number(item.holdPct) }))
          : null;
        const adjustments: AllocationAdjustment[] | null = args.adjustments
          ? args.adjustments.map((item) => ({
            fundId: item.fundId,
            trancheId: item.trancheId,
            type: item.type === 'exclude' ? 'exclude' : 'override',
            amount: item.amount == null ? undefined : Number(item.amount),
            reason: item.reasonCode || undefined,
            note: item.note || undefined,
          }))
          : null;
        // Proposed positions are engine rows, not a user edit. The caller's JWT
        // cannot insert them under the entity RLS policies, so the sync uses the
        // service role. The rule itself still runs as the compliance function.
        const writer = context.supabaseAdmin || context.supabase;
        const draft = await loadAllocationDraft(writer, args.dealId, args.asOfDate, holds, adjustments);
        const preview = await commitAllocation(writer, draft, context.user?.id ?? null, { proposalsOnly: true });
        const fundIds = new Set(preview.rows.map((row) => row.fundId));

        // Pro forma rules are inactive on purpose, so a platform-wide job skips
        // them. Enrolled rules are the ones with a limit assigned to a fund on
        // this deal. Reading through the service role keeps a user policy from
        // hiding an inactive rule.
        const compliance = writer.schema('compliance');
        const fundList = [...fundIds];
        const { data: thresholdRows, error: thresholdError } = fundList.length
          ? await compliance
            .from('rule_thresholds')
            .select('rule_id, entity_id, group_value, rank_from, applies, valid_from, valid_to')
            .in('entity_id', fundList)
          : { data: [], error: null };
        if (thresholdError) throw new Error(thresholdError.message);
        const enrolledIds = [...new Set((thresholdRows || []).map((row) => row.rule_id))];
        const { data: surfaceRows, error: surfaceError } = await compliance
          .from('rules')
          .select('*')
          .in('rule_code', [...DEAL_SURFACE_RULE_CODES]);
        if (surfaceError) throw new Error(surfaceError.message);
        const { data: enrolledRows, error: enrolledError } = enrolledIds.length
          ? await compliance.from('rules').select('*').in('id', enrolledIds)
          : { data: [], error: null };
        if (enrolledError) throw new Error(enrolledError.message);
        const ruleById = new Map<string, any>();
        for (const row of [...(surfaceRows || []), ...(enrolledRows || [])]) ruleById.set(row.id, row);
        const plans = rulesToScore([...ruleById.values()], thresholdRows || [], fundIds, draft.asOf);
        if (!plans.length) throw new Error('No compliance rules with limits are assigned to the funds on this deal.');
        const ruleIds = plans.map((plan) => plan.rule.id);
        const { data: versionRows, error: versionError } = await compliance
          .from('rule_versions')
          .select('*')
          .in('rule_id', ruleIds)
          .eq('is_active', true);
        if (versionError) throw new Error(versionError.message);
        const versionByRule = new Map<string, any>();
        for (const version of versionRows || []) {
          const current = versionByRule.get(version.rule_id);
          if (!current || version.version_number > current.version_number) versionByRule.set(version.rule_id, version);
        }

        const engine = getComplianceEngine(writer);
        const results: any[] = [];
        const failures: string[] = [];
        const settled = await Promise.allSettled(plans.map(async (plan) => {
          const scored = await engine.evaluateRulesForFunds({
            ruleCode: plan.rule.rule_code,
            asOfDate: draft.asOf,
            scenarioCode: draft.dealCode,
            triggeredBy: context.user?.id,
            anchorEntityIds: plan.anchorIds,
            // The anchor list is already the set of funds with a limit. Pro
            // forma rules have no enrollment row, and a rank band has no
            // separate "this test applies" row, so the enrollment skip is off.
            ignoreEnrollment: plan.ignoreEnrollment,
          });
          return scored;
        }));
        settled.forEach((outcome, index) => {
          if (outcome.status === 'fulfilled') {
            results.push(...outcome.value);
            return;
          }
          const reason = outcome.reason;
          const message = reason instanceof Error ? reason.message : String(reason);
          failures.push(`${plans[index].rule.rule_name}: ${message}`);
        });
        if (!results.length && failures.length) throw new Error(failures[0]);

        const { data: scenarioAttribute } = await writer
          .from('attribute_register')
          .select('id')
          .eq('attribute_code', 'POSITION_SCENARIO_CODE')
          .maybeSingle();
        const { data: scenarioRows } = scenarioAttribute
          ? await writer
            .from('entity_attribute_values')
            .select('entity_id')
            .eq('attribute_id', scenarioAttribute.id)
            .eq('golden_value', draft.dealCode)
            .gte('system_to', new Date().toISOString())
          : { data: [] };
        const proposalIds = new Set((scenarioRows || []).map((row) => row.entity_id));
        const impacted = dealSurfaceResults(results, fundIds, proposalIds);

        return {
          rules: plans.map(({ rule: row }) => {
            const version = versionByRule.get(row.id);
            return {
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
          results: impacted,
          errors: failures.map((message) => ({ field: 'general', message, code: 'EVALUATE_FAILED' })),
        };
      } catch (error: any) {
        console.error('Error scoring deal compliance:', error);
        return { rules: [], results: [], errors: [{ field: 'general', message: error.message, code: 'EVALUATE_FAILED' }] };
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
      return withMeasureLines(context, data || []);
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
      const [version] = await withMeasureLines(context, [{ ...data, conditions: conditions || [] }]);
      return version;
    },

    scopeAssignments: async (parent: any, _: any, context: Context) => {
      const { data } = await cx(context).from('rule_scope_assignments').select('*').eq('rule_id', parent.id);
      const rows = data || [];
      const labels = await entityLabels(context, rows.map((row: any) => row.entity_id));
      return rows.map((row: any) => {
        const label = labels.get(row.entity_id);
        return {
          ...mapScopeAssignment(row),
          entityCode: label?.entity_code || null,
          entityName: label?.entity_name || null,
        };
      });
    },
  },

  ComplianceEvaluationRun: {
    rule: async (parent: any, _: any, context: Context) => {
      const { data } = await cx(context).from('rules').select('*').eq('id', parent.ruleId).maybeSingle();
      return data ? mapRule(data) : null;
    },
    results: async (parent: any, _: any, context: Context) => {
      const { data } = await cx(context).from('rule_evaluation_results').select('*').eq('run_id', parent.id);
      const rows = data || [];
      const labels = await entityLabels(context, rows.map((row: any) => row.anchor_entity_id));
      return rows.map((row: any) => {
        const label = labels.get(row.anchor_entity_id);
        return {
          ...mapResult(row),
          anchorEntityCode: label?.entity_code || null,
          anchorEntityName: label?.entity_name || null,
        };
      });
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

function conditionRow(versionId: string, cond: any, extra: Record<string, unknown> = {}) {
  return {
    rule_version_id: versionId,
    applies_to: cond.appliesTo,
    condition_group: cond.conditionGroup ?? 1,
    condition_order: cond.conditionOrder ?? 1,
    attribute_code: cond.attributeCode,
    attribute_dimension: toSnakeDim(cond.attributeDimension),
    compare_attribute_code: cond.compareAttributeCode || null,
    compare_dimension: toSnakeDim(cond.compareDimension),
    operator: cond.operator,
    value: cond.value ?? null,
    logic_operator: cond.logicOperator ?? 'AND',
    ...(cond.leftExpression ? { left_expression: cond.leftExpression } : {}),
    ...(cond.rightExpression ? { right_expression: cond.rightExpression } : {}),
    ...extra,
  };
}

async function insertMeasureLines(context: Context, versionId: string, lines: any[]) {
  const stored: any[] = [];
  for (const side of ['NUMERATOR', 'DENOMINATOR', 'LIMIT']) {
    const sideLines = (lines || []).filter((line) => line.side === side);
    for (let index = 0; index < sideLines.length; index += 1) {
      const line = sideLines[index];
      const { data, error } = await cx(context)
        .from('rule_measure_lines')
        .insert({
          rule_version_id: versionId,
          side,
          line_order: index + 1,
          label: line.label || null,
          kind: line.kind,
          sign: line.sign === -1 ? -1 : 1,
          attribute_code: line.attributeCode || null,
          dimension: toSnakeDim(line.dimension),
          expression: line.expression ?? null,
          path: toSnakeHops(line.path),
          weight_attribute_code: line.weightAttributeCode || null,
          value_path: toSnakeHops(line.valuePath),
          transform: line.transform || null,
          price_attribute_code: line.priceAttributeCode || null,
          pct: line.pct ?? null,
          pct_attribute_code: line.pctAttributeCode || null,
          pct_path: toSnakeHops(line.pctPath),
          total_path: line.totalPath?.length ? toSnakeHops(line.totalPath) : null,
          required: Boolean(line.required),
        })
        .select('*')
        .single();
      if (error) throw error;

      const filters = [
        ...(line.conditions || []).filter((cond: any) => cond.attributeCode).map((cond: any) => ({ ...cond, filterRole: 'WHERE' })),
        ...(line.totalConditions || []).filter((cond: any) => cond.attributeCode).map((cond: any) => ({ ...cond, filterRole: 'TOTAL' })),
      ];
      let storedConditions: any[] = [];
      if (filters.length) {
        const rows = filters.map((cond, order) => conditionRow(versionId, cond, {
          measure_line_id: data.id,
          applies_to: 'LINE',
          filter_role: cond.filterRole,
          condition_group: 1,
          condition_order: order + 1,
        }));
        const { data: condRows, error: condError } = await cx(context).from('rule_conditions').insert(rows).select('*');
        if (condError) throw condError;
        storedConditions = condRows || [];
      }
      stored.push({ ...data, conditions: storedConditions });
    }
  }
  return stored;
}

async function withMeasureLines(context: Context, rows: any[]) {
  const ids = rows.map((row) => row.id).filter(Boolean);
  if (!ids.length) return rows.map((row) => mapVersion(row, row.conditions || [], []));

  const { data: lineRows, error } = await cx(context)
    .from('rule_measure_lines')
    .select('*')
    .in('rule_version_id', ids)
    .order('line_order', { ascending: true });
  if (error) throw error;
  const lines = lineRows || [];
  const lineIds = lines.map((line: any) => line.id);
  let conditions: any[] = [];
  if (lineIds.length) {
    const { data: condRows, error: condError } = await cx(context)
      .from('rule_conditions')
      .select('*')
      .in('measure_line_id', lineIds);
    if (condError) throw condError;
    conditions = condRows || [];
  }
  return rows.map((row) => mapVersion(
    row,
    row.conditions || [],
    lines
      .filter((line: any) => line.rule_version_id === row.id)
      .map((line: any) => ({
        ...line,
        conditions: conditions.filter((cond) => cond.measure_line_id === line.id),
      })),
  ));
}

function mapMeasureLine(row: any) {
  const conditions = row.conditions || [];
  return {
    id: row.id,
    side: row.side,
    lineOrder: row.line_order,
    label: row.label,
    kind: row.kind,
    sign: row.sign,
    attributeCode: row.attribute_code,
    dimension: toCamelDim(row.dimension),
    expression: row.expression ?? null,
    path: toCamelHops(row.path),
    weightAttributeCode: row.weight_attribute_code,
    valuePath: toCamelHops(row.value_path),
    transform: row.transform,
    priceAttributeCode: row.price_attribute_code,
    pct: row.pct == null ? null : Number(row.pct),
    pctAttributeCode: row.pct_attribute_code,
    pctPath: toCamelHops(row.pct_path),
    totalPath: toCamelHops(row.total_path),
    required: Boolean(row.required),
    conditions: conditions.filter((cond: any) => cond.filter_role !== 'TOTAL').map(mapCondition),
    totalConditions: conditions.filter((cond: any) => cond.filter_role === 'TOTAL').map(mapCondition),
  };
}

function mapVersion(row: any, conditions: any[], lines: any[] = []) {
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
    denominatorSource: row.denominator_source || 'BASE',
    denominatorConstantValue: row.denominator_constant_value,
    resultUnit: row.result_unit,
    limitDirection: row.limit_direction,
    softLimitValue: row.soft_limit_value,
    hardLimitValue: row.hard_limit_value,
    hardLimitAttributeCode: row.hard_limit_attribute_code,
    softLimitFactor: row.soft_limit_factor,
    defaultSourceScope: row.default_source_scope,
    consolidateDescendants: Boolean(row.consolidate_descendants),
    isActive: row.is_active,
    conditions: conditions.filter((condition) => !condition.measure_line_id).map(mapCondition),
    measureLines: lines.map(mapMeasureLine),
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
    leftExpression: row.left_expression ?? null,
    rightExpression: row.right_expression ?? null,
    logicOperator: row.logic_operator,
    createdAt: row.created_at,
  };
}

async function entityLabels(context: Context, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  const labels = new Map<string, { entity_code: string; entity_name: string }>();
  if (unique.length === 0) return labels;
  const { data, error } = await context.supabase
    .schema('entity_instances')
    .from('master_entities')
    .select('id, entity_code, entity_name')
    .in('id', unique);
  if (error) throw new Error(error.message);
  for (const row of data || []) labels.set(row.id, row);
  return labels;
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

function mapThreshold(row: any, rule?: { rule_code?: string; rule_name?: string }, entity?: { entity_code?: string; entity_name?: string }) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleCode: rule?.rule_code || null,
    ruleName: rule?.rule_name || null,
    entityId: row.entity_id,
    entityCode: entity?.entity_code || null,
    entityName: entity?.entity_name || null,
    groupValue: row.group_value,
    rankFrom: row.rank_from,
    rankTo: row.rank_to,
    limitDirection: row.limit_direction || null,
    softLimitValue: row.soft_limit_value,
    hardLimitValue: row.hard_limit_value,
    applies: row.applies !== false,
    notes: row.notes,
  };
}

async function loadFundBoard(context: Context) {
  const [fundResult, ruleResult] = await Promise.all([
    context.supabase
      .schema('entity_instances')
      .from('master_entities')
      .select('id, entity_code, entity_name')
      .eq('domain_code', 'FUND')
      .eq('is_active', true)
      .order('entity_code'),
    cx(context)
      .from('rules')
      .select('id, rule_code, rule_name, rule_category, is_active')
      .eq('anchor_domain_code', 'FUND')
      .eq('is_active', true)
      .order('rule_name'),
  ]);
  if (fundResult.error) throw new Error(fundResult.error.message);
  if (ruleResult.error) throw new Error(ruleResult.error.message);
  const funds = (fundResult.data || []).filter((row) => !String(row.entity_code).startsWith('BENCH-'));
  const fundIds = funds.map((row) => row.id);
  const rules = ruleResult.data || [];
  const ruleIds = rules.map((row) => row.id);

  const [parentResult, versionResult, thresholdResult, latestResult] = await Promise.all([
    fundIds.length
      ? context.supabase
        .schema('entity_instances')
        .from('entity_relationships')
        .select('parent_entity_id, child_entity_id')
        .eq('relationship_code', 'FUND_PARENT')
        .in('child_entity_id', fundIds)
      : Promise.resolve({ data: [] as Array<{ parent_entity_id: string; child_entity_id: string }>, error: null }),
    ruleIds.length
      ? cx(context)
        .from('rule_versions')
        .select('rule_id, version_number, result_unit, limit_direction, group_by_attribute_code, consolidate_descendants')
        .in('rule_id', ruleIds)
        .eq('is_active', true)
      : Promise.resolve({ data: [] as any[], error: null }),
    ruleIds.length
      ? cx(context)
        .from('rule_thresholds')
        .select('*')
        .in('rule_id', ruleIds)
        .eq('valid_to', '9999-12-31')
      : Promise.resolve({ data: [] as any[], error: null }),
    ruleIds.length
      ? cx(context).rpc('latest_fund_board_results', { p_rule_ids: ruleIds })
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);
  if (parentResult.error) throw new Error(parentResult.error.message);
  if (versionResult.error) throw new Error(versionResult.error.message);
  if (thresholdResult.error) throw new Error(thresholdResult.error.message);
  if (latestResult.error) throw new Error(latestResult.error.message);

  const parentOf = new Map((parentResult.data || []).map((row) => [row.child_entity_id, row.parent_entity_id]));
  const versionByRule = new Map<string, any>();
  for (const version of versionResult.data || []) {
    const current = versionByRule.get(version.rule_id);
    if (!current || version.version_number > current.version_number) versionByRule.set(version.rule_id, version);
  }
  const thresholdRows = thresholdResult.data;
  const resultRows = selectLatestFundResults(parseFundBoardResultPayload(latestResult.data));

  const fundById = new Map(funds.map((row) => [row.id, row]));
  const ruleById = new Map(rules.map((row) => [row.id, row]));

  return {
    funds: funds.map((row) => ({
      entityId: row.id,
      entityCode: row.entity_code,
      entityName: row.entity_name,
      parentEntityId: parentOf.get(row.id) || null,
    })),
    rules: rules.map((row) => {
      const version = versionByRule.get(row.id);
      return {
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
    thresholds: (thresholdRows || []).map((row) => mapThreshold(row, ruleById.get(row.rule_id), row.entity_id ? fundById.get(row.entity_id) : undefined)),
    results: (resultRows || [])
      .filter((row) => fundById.has(row.anchor_entity_id))
      .map(mapResult),
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
    rankPosition: row.rank_position,
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
      leftExpression: c.leftExpression ?? null,
      rightExpression: c.rightExpression ?? null,
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
      const attributeIds = cond.leftExpression
        ? []
        : attributeHops.length ? targetsAlongPath(row.entity_id, attributeHops, hopMaps) : [row.entity_id];
      const compareIds = cond.compareAttributeCode
        ? (compareHops.length ? targetsAlongPath(row.entity_id, compareHops, hopMaps) : [row.entity_id])
        : [];
      const exprIds = conditionExpressionReads(cond).flatMap((read) =>
        read.path.length ? targetsAlongPath(row.entity_id, read.path, hopMaps) : [row.entity_id],
      );
      for (const id of [...attributeIds, ...compareIds, ...exprIds, row.entity_id]) needed.add(id);
    }
  }
  const attributeCodes = [...new Set(conditions.flatMap((cond) => [
    cond.leftExpression ? '' : cond.attributeCode,
    cond.compareAttributeCode,
    ...conditionExpressionReads(cond).map((read) => read.code),
  ].filter((code): code is string => !!code)))];
  await fetchAttributeValues(context.supabase, [...needed], attributeCodes, attributes, asOf, now);

  const matches: Array<{ entityId: string; entityCode: string; entityName: string | null; values: Record<string, string | null> }> = [];
  for (const row of rows) {
    const result = matchPopulationEntity(
      row.entity_id,
      conditions,
      (id, path) => targetsAlongPath(id, path, hopMaps),
      (id, code) => textOfAttribute(attributes.get(id), code),
      asOf,
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

  const page = matches.slice(offset, offset + limit);
  return {
    total: matches.length,
    scanned: rows.length,
    truncated,
    rows: await withParentRecords(context, domainCode, page),
  };
}

// The records each match belongs to, so a list of positions shows its funds and securities.
// A composite (an intersection type such as a position) is the combination of its member records.
async function withParentRecords<T extends { entityId: string }>(context: Context, domainCode: string, rows: T[]) {
  if (!rows.length) return rows.map((row) => ({ ...row, parents: [] as any[] }));
  const [{ data: related, error }, { data: types }] = await Promise.all([
    context.supabase
      .from('entity_master')
      .select('entity_id, parent_relationships, child_relationships')
      .in('entity_id', rows.map((row) => row.entityId)),
    context.supabase
      .from('intersection_types')
      .select('intersection_code, intersection_type_members(domain_code)')
      .eq('is_active', true),
  ]);
  if (error) throw new Error(`Failed to load parent records: ${error.message}`);
  const members = new Set<string>();
  for (const type of types || []) {
    if (String(type.intersection_code).toUpperCase() !== String(domainCode).toUpperCase()) continue;
    for (const member of (type as any).intersection_type_members || []) members.add(String(member.domain_code).toUpperCase());
  }
  const byEntity = new Map<string, any>((related || []).map((row: any) => [row.entity_id, row]));
  return rows.map((row) => {
    const source = byEntity.get(row.entityId);
    const seen = new Set<string>();
    const parents: any[] = [];
    const add = (rel: any, side: 'parent' | 'child') => {
      const id = rel?.[`${side}_entity_id`];
      const domain = String(rel?.[`${side}_domain_code`] || '').toUpperCase();
      if (!id || id === row.entityId || seen.has(id)) return;
      const isCompositeMember = members.has(domain);
      // Up the tree is always a parent. Down the tree counts only when it is a member of this composite.
      if (side === 'child' && !isCompositeMember) return;
      seen.add(id);
      parents.push({
        domainCode: domain,
        entityId: id,
        entityCode: rel[`${side}_entity_code`] ?? null,
        entityName: rel[`${side}_entity_name`] ?? null,
        relationshipCode: rel.relationship_code ?? null,
        isCompositeMember,
      });
    };
    for (const rel of source?.parent_relationships || []) add(rel, 'parent');
    for (const rel of source?.child_relationships || []) add(rel, 'child');
    return { ...row, parents };
  });
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
    for (const hop of [...(cond.attributePath || []), ...(cond.comparePath || []), ...conditionExpressionReads(cond).flatMap((read) => read.path)]) {
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

  // winning_attribute_values seeks idx_eav_entity_attr_source_asof once per
  // (entity, attribute, source) instead of scanning every historical slice.
  const chunk = 200;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const { data, error } = await supabase
      .schema('golden_master')
      .rpc('winning_attribute_values', {
        p_entity_ids: slice,
        p_attribute_ids: attributeIds,
        p_as_of: asOf,
        p_knowledge: now,
        p_require_text: false,
      });
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

async function loadResultContributors(context: Context, resultId: string) {
  const { data: result, error } = await cx(context).from('rule_evaluation_results').select('*').eq('id', resultId).maybeSingle();
  if (error || !result) throw new Error('Result not found');
  const { data: version, error: versionError } = await cx(context).from('rule_versions').select('*').eq('id', result.rule_version_id).maybeSingle();
  if (versionError || !version) throw new Error('Rule version not found');

  // A rule built from amounts stores no contributor list. Rebuild it per amount.
  const { count: amountCount } = await cx(context).from('rule_measure_lines').select('id', { count: 'exact', head: true }).eq('rule_version_id', result.rule_version_id);
  if ((amountCount || 0) > 0) {
    const { data: contributed, error: contributedError } = await cx(context).rpc('measure_line_contributors', { p_result_id: resultId });
    if (contributedError) throw new Error(`Could not load the records: ${contributedError.message}`);
    const rowsIn: any[] = contributed || [];
    const entityIds = [...new Set(rowsIn.map((row) => row.entity_id as string))];
    const info = new Map<string, { code: string; name: string | null }>();
    for (let i = 0; i < entityIds.length; i += 200) {
      const { data } = await context.supabase.schema('entity_instances').from('master_entities').select('id, entity_code, entity_name').in('id', entityIds.slice(i, i + 200));
      for (const row of data || []) info.set(row.id, { code: row.entity_code, name: row.entity_name });
    }
    const totals = new Map<string, number>();
    const amountKey = (row: any) => `${row.amount_side}:${row.amount_order}`;
    const contribution = (row: any) => (row.amount_kind === 'COUNT' ? 1 : row.amount_value == null ? null : Number(row.amount_value) * (row.amount_sign === -1 ? -1 : 1));
    for (const row of rowsIn) totals.set(amountKey(row), (totals.get(amountKey(row)) || 0) + (contribution(row) ?? 0));
    const rows = rowsIn.map((row) => {
      const value = contribution(row);
      const total = totals.get(amountKey(row)) || 0;
      const known = info.get(row.entity_id);
      return {
        entityId: row.entity_id,
        entityCode: known?.code || row.entity_id,
        entityName: known?.name ?? null,
        numeratorValue: value,
        sharePercent: total && value != null ? (value / total) * 100 : null,
        values: {},
        amountLabel: row.amount_label || (row.amount_side === 'DENOMINATOR' ? 'Denominator' : 'Amount'),
        amountSide: row.amount_side,
        order: `${row.amount_side === 'NUMERATOR' ? 0 : 1}:${String(row.amount_order).padStart(3, '0')}`,
      };
    });
    rows.sort((a, b) => a.order.localeCompare(b.order) || (b.numeratorValue ?? -Infinity) - (a.numeratorValue ?? -Infinity));
    return { resultId, baseDomainCode: null, numeratorAggregation: null, columns: [], rows, total: rows.length };
  }

  const ids: string[] = result.contributing_entity_ids || [];
  const asOf = String(result.as_of_date).slice(0, 10);
  const now = result.knowledge_date || new Date().toISOString();
  const aggregation = version.numerator_aggregation || null;
  const counting = aggregation === 'COUNT' || aggregation === 'COUNT_DISTINCT';

  const numeratorPath = hopsFromDimension(toCamelDim(version.numerator_dimension));
  const reads = [
    { code: version.numerator_attribute_code as string | null, role: 'NUMERATOR', path: numeratorPath },
    { code: version.denominator_attribute_code as string | null, role: 'DENOMINATOR', path: hopsFromDimension(toCamelDim(version.denominator_dimension)) },
    { code: version.group_by_attribute_code as string | null, role: 'GROUP', path: hopsFromDimension(toCamelDim(version.group_by_dimension)) },
  ].filter((read) => !!read.code);

  const conditions: PopulationCondition[] = reads
    .filter((read) => read.path.length)
    .map((read) => ({ attributeCode: read.code as string, operator: 'equals', value: null, attributePath: read.path }) as PopulationCondition);
  const hopMaps = await loadRelationshipMaps(context.supabase, conditions, asOf, now);
  const targetsFor = (id: string, path: RelationshipHopRef[]) => (path.length ? targetsAlongPath(id, path, hopMaps) : [id]);

  const needed = new Set<string>(ids);
  for (const id of ids) for (const read of reads) for (const target of targetsFor(id, read.path)) needed.add(target);
  const attributes = new Map<string, any>();
  await fetchAttributeValues(context.supabase, [...needed], [...new Set(reads.map((r) => r.code as string))], attributes, asOf, now);

  const entityInfo = new Map<string, { code: string; name: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await context.supabase.schema('entity_instances').from('master_entities').select('id, entity_code, entity_name').in('id', ids.slice(i, i + 200));
    for (const row of data || []) entityInfo.set(row.id, { code: row.entity_code, name: row.entity_name });
  }

  const readValues = (id: string, read: { code: string | null; path: RelationshipHopRef[] }) => {
    const texts = targetsFor(id, read.path).map((target) => textOfAttribute(attributes.get(target), read.code as string)).filter((t): t is string => t != null);
    return texts.length ? texts.join(', ') : null;
  };
  const numeric = (text: string | null) => {
    if (text == null) return null;
    const parts = text.split(', ').map((part) => Number(part.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  };

  const numeratorRead = reads.find((read) => read.role === 'NUMERATOR');
  const rows = ids.map((id) => {
    const values: Record<string, string | null> = {};
    for (const read of reads) values[read.code as string] = readValues(id, read);
    const info = entityInfo.get(id);
    const contribution = counting ? 1 : numeratorRead ? numeric(values[numeratorRead.code as string]) : null;
    return { entityId: id, entityCode: info?.code || id, entityName: info?.name ?? null, numeratorValue: contribution, sharePercent: null as number | null, values };
  });
  const total = rows.reduce((sum, row) => sum + (row.numeratorValue ?? 0), 0);
  for (const row of rows) row.sharePercent = total && row.numeratorValue != null ? (row.numeratorValue / total) * 100 : null;
  rows.sort((a, b) => (b.numeratorValue ?? -Infinity) - (a.numeratorValue ?? -Infinity));

  return {
    resultId,
    baseDomainCode: version.base_domain_code ?? null,
    numeratorAggregation: aggregation,
    columns: [...new Map(reads.map((read) => [read.code as string, { code: read.code as string, label: read.code as string, role: read.role }])).values()],
    rows,
    total: ids.length,
  };
}
