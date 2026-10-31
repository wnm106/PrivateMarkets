import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Compliance Rules Engine (thin client wrapper)
 *
 * The heavy lifting (bi-temporal rule-version resolution, relationship
 * rollups, condition evaluation, numerator/denominator aggregation, and
 * hard/soft limit comparison) lives in Postgres functions defined in
 * supabase/migrations/00031_compliance_rules_engine.sql, under the
 * `compliance` schema. This mirrors the existing convention in this repo
 * (see formula-engine.ts calling metadata_register.evaluate_*_formula, and
 * golden_master.resolve_golden_record) rather than re-implementing bi-temporal
 * SQL logic in TypeScript.
 *
 * `compliance` lives in a non-public Postgres schema, so every call goes
 * through `.schema('compliance')` first -- supabase-js only supports schema
 * switching via `.schema(name).from(table)` / `.schema(name).rpc(fn)`, NOT a
 * second `{ schema }` argument to `.from()` (same convention as
 * packages/graphql/src/resolvers/tenancy.ts and source.ts).
 *
 * This wrapper exists to:
 *   - provide a typed, test-friendly surface for the GraphQL resolvers and
 *     MCP tools
 *   - fetch the resulting run + results in one call for convenience
 */

export interface EvaluateRuleOptions {
    ruleCode: string;
    /** Valid-time date being evaluated, e.g. a month-end date (YYYY-MM-DD). */
    asOfDate: string;
    /** System/knowledge time used to resolve the in-force rule_version AND
     * which bi-temporal attribute values to read. Defaults to now(). */
    knowledgeDate?: string;
    /** 'GOLDEN' (default) or a specific source_registry.source_code. */
    sourceScope?: string;
    triggeredBy?: string;
    /** When set, only this fund (or other anchor) is scored. Child positions still roll into it. */
    anchorEntityId?: string;
    /** When set, the book plus hypothetical positions for this deal code. A blank scenario is the booked book only. */
    scenarioCode?: string | null;
}

export interface ComplianceEvaluationRun {
    id: string;
    ruleId: string;
    ruleVersionId: string;
    asOfDate: string;
    knowledgeDate: string;
    sourceScope: string;
    runStatus: 'RUNNING' | 'COMPLETED' | 'FAILED';
    errorMessage: string | null;
    resultCount: number | null;
    breachCount: number | null;
    triggeredBy: string | null;
    startedAt: string;
    completedAt: string | null;
}

export interface ComplianceEvaluationResult {
    id: string;
    runId: string;
    ruleId: string;
    ruleVersionId: string;
    anchorEntityId: string;
    groupByValue: string | null;
    asOfDate: string;
    knowledgeDate: string;
    sourceScope: string;
    numeratorValue: number | null;
    denominatorValue: number | null;
    computedValue: number | null;
    limitDirection: 'MAX' | 'MIN' | null;
    softLimitValue: number | null;
    hardLimitValue: number | null;
    status: 'PASS' | 'SOFT_BREACH' | 'HARD_BREACH' | 'NO_DATA' | 'ERROR';
    breachAmount: number | null;
    contributingEntityIds: string[] | null;
    contributingCount: number | null;
    rankPosition: number | null;
    detail: Record<string, unknown>;
    evaluatedAt: string;
}

export class ComplianceEngine {
    constructor(private supabase: SupabaseClient) {}

    private cx() {
        return this.supabase.schema('compliance');
    }

    /**
     * Runs a compliance rule for a given as-of date / knowledge date /
     * source scope. Delegates entirely to compliance.evaluate_rule(), which
     * resolves the bi-temporally-correct rule_version, rolls up base
     * entities, applies conditions, computes numerator/denominator, compares
     * against hard/soft limits, and persists a run + per-(anchor, group)
     * result rows. Returns the run with its results attached.
     */
    async evaluateRule(options: EvaluateRuleOptions): Promise<{
        run: ComplianceEvaluationRun;
        results: ComplianceEvaluationResult[];
    }> {
        const { data: runId, error } = await this.cx().rpc('evaluate_rule', {
            p_rule_code: options.ruleCode,
            p_as_of_date: options.asOfDate,
            p_knowledge_date: options.knowledgeDate ?? new Date().toISOString(),
            p_source_scope: options.sourceScope ?? null,
            p_triggered_by: options.triggeredBy ?? null,
            p_anchor_entity_id: options.anchorEntityId ?? null,
            p_scenario_code: options.scenarioCode ?? null,
        });

        if (error) {
            console.error('Error evaluating compliance rule:', error);
            throw new Error(`Compliance rule evaluation failed: ${error.message}`);
        }

        return this.getRun(runId as string);
    }

    async getRun(runId: string): Promise<{
        run: ComplianceEvaluationRun;
        results: ComplianceEvaluationResult[];
    }> {
        const { data: runRow, error: runError } = await this.cx()
            .from('rule_evaluation_runs')
            .select('*')
            .eq('id', runId)
            .single();

        if (runError) {
            throw new Error(`Failed to fetch compliance evaluation run: ${runError.message}`);
        }

        const { data: resultRows, error: resultsError } = await this.cx()
            .from('rule_evaluation_results')
            .select('*')
            .eq('run_id', runId)
            .order('status', { ascending: false }) // breaches first
            .order('evaluated_at', { ascending: true });

        if (resultsError) {
            throw new Error(`Failed to fetch compliance evaluation results: ${resultsError.message}`);
        }

        return {
            run: mapRun(runRow),
            results: (resultRows || []).map(mapResult),
        };
    }

    /**
     * Resolves which rule_versions row is in force for the given rule at a
     * particular (as_of_date, knowledge_date) pair. Useful for "what would
     * this rule have looked like back then" inspection without running a
     * full evaluation.
     */
    async resolveRuleVersion(ruleId: string, asOfDate: string, knowledgeDate?: string) {
        const { data, error } = await this.cx().rpc('resolve_rule_version', {
            p_rule_id: ruleId,
            p_as_of_date: asOfDate,
            p_knowledge_date: knowledgeDate ?? new Date().toISOString(),
        });

        if (error) {
            throw new Error(`Failed to resolve rule version: ${error.message}`);
        }

        return data;
    }

    async listBreaches(filters: {
        ruleId?: string;
        status?: 'SOFT_BREACH' | 'HARD_BREACH';
        runId?: string;
        first?: number;
    } = {    }): Promise<ComplianceEvaluationResult[]> {
        let query = this.cx()
            .from('rule_evaluation_results')
            .select('*')
            .order('evaluated_at', { ascending: false });

        if (filters.ruleId) query = query.eq('rule_id', filters.ruleId);
        if (filters.runId) query = query.eq('run_id', filters.runId);
        if (filters.status) {
            query = query.eq('status', filters.status);
        } else {
            query = query.in('status', ['SOFT_BREACH', 'HARD_BREACH']);
        }

        query = query.limit(filters.first ?? 50);

        const { data, error } = await query;
        if (error) {
            throw new Error(`Failed to list compliance breaches: ${error.message}`);
        }

        return (data || []).map(mapResult);
    }
}

function mapRun(row: any): ComplianceEvaluationRun {
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

function mapResult(row: any): ComplianceEvaluationResult {
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
        rankPosition: row.rank_position ?? null,
        detail: row.detail || {},
        evaluatedAt: row.evaluated_at,
    };
}

let complianceEngineInstance: ComplianceEngine | null = null;

export function getComplianceEngine(supabase: SupabaseClient): ComplianceEngine {
    if (!complianceEngineInstance) {
        complianceEngineInstance = new ComplianceEngine(supabase);
    }
    return complianceEngineInstance;
}
