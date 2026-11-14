import { SupabaseClient } from '@supabase/supabase-js';
import {
    applyVerifiedCapacity,
    asNumber,
    buildCapacityQuote,
    newBreachKeys,
    normalizeProformaLegs,
    searchFeasiblePar,
    type CapacityQuote,
    type LimitKind,
    type NormalizedProformaLeg,
    type ProformaLegInput,
    type SnapshotRow,
} from './compliance-capacity';

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
 *   - quote investment capacity from proforma snapshots. The par algebra lives
 *     in compliance-capacity.ts. The snapshots themselves are Postgres.
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

    /**
     * Booked book plus any number of buys and sells. Positive par buys a
     * security and negative par sells it. An empty leg list is the booked book.
     * The database removes the ephemeral positions before it returns.
     */
    async proformaSnapshot(options: ProformaSnapshotOptions): Promise<SnapshotRow[]> {
        const { data, error } = await this.cx().rpc('proforma_snapshot', {
            p_anchor_entity_id: options.anchorEntityId,
            p_legs: options.legs,
            p_as_of_date: options.asOfDate,
            p_knowledge_date: options.knowledgeDate ?? new Date().toISOString(),
            p_source_scope: options.sourceScope ?? null,
            p_rule_codes: options.ruleCodes ?? null,
        });
        if (error) {
            throw new Error(`Proforma snapshot failed: ${error.message}`);
        }
        const rows = ((data || []) as RawSnapshot[]).map(mapSnapshot);
        const failures = rows.filter((row) => row.status === 'ERROR');
        if (failures.length) {
            throw new Error(failures.map((row) => `${row.ruleCode}: ${row.errorMessage || 'evaluation failed'}`).join('; '));
        }
        return rows;
    }

    /**
     * Whether this package of buys and sells would breach. Every leg is applied
     * together. Approved is false when any hard test is new or worse.
     */
    async evaluateProforma(options: EvaluateProformaOptions): Promise<ProformaScore> {
        const legs = normalizeProformaLegs(options.legs);
        const { data, error } = await this.cx().rpc('evaluate_proforma', {
            p_anchor_entity_id: options.anchorEntityId,
            p_legs: legs,
            p_as_of_date: options.asOfDate,
            p_knowledge_date: options.knowledgeDate ?? new Date().toISOString(),
            p_source_scope: options.sourceScope ?? null,
            p_rule_codes: options.ruleCodes ?? null,
        });
        if (error) {
            throw new Error(`Proforma evaluation failed: ${error.message}`);
        }
        const lines = ((data || []) as RawProforma[]).map(mapProforma);
        return {
            approved: lines.every((line) => line.approved),
            lines,
        };
    }

    /**
     * Largest additional par of one security that does not worsen a rule through
     * its limit. `legs` are buys and sells already in the package, so a swap
     * can ask how much of the bought name still fits after the sale.
     * Null capacity means no rule caps the buy. Zero means a rule blocks it.
     */
    async investmentCapacity(options: InvestmentCapacityOptions): Promise<CapacityQuote> {
        if (!options.securityId && !options.securityCode) {
            throw new Error('Capacity needs a security');
        }
        const limitKind: LimitKind = String(options.limitKind || 'HARD').toUpperCase() === 'SOFT' ? 'SOFT' : 'HARD';
        const knowledgeDate = options.knowledgeDate ?? new Date().toISOString();
        const probePar = options.probePar && options.probePar > 0 ? options.probePar : 1_000_000;
        const fixed = options.legs?.length ? normalizeProformaLegs(options.legs) : [];
        const probe = (par: number): NormalizedProformaLeg => ({
            security_id: options.securityId ?? null,
            security_code: options.securityCode ?? null,
            par,
            attributes: null,
        });
        const shared = {
            anchorEntityId: options.anchorEntityId,
            asOfDate: options.asOfDate,
            knowledgeDate,
            sourceScope: options.sourceScope,
            ruleCodes: options.ruleCodes,
        };

        const { data: metricRows, error: metricError } = await this.cx().rpc('security_test_metrics', {
            p_security_id: options.securityId ?? null,
            p_security_code: options.securityCode ?? null,
            p_as_of_date: options.asOfDate,
            p_knowledge_date: knowledgeDate,
            p_source_scope: options.sourceScope ?? null,
            p_rule_codes: options.ruleCodes ?? null,
            p_anchor_entity_id: options.anchorEntityId,
        });
        if (metricError) {
            throw new Error(`Capacity metrics failed: ${metricError.message}`);
        }
        const weightedMetrics = new Map<string, number | null>();
        for (const row of (metricRows || []) as Array<{ rule_code: string; metric: unknown }>) {
            weightedMetrics.set(row.rule_code, asNumber(row.metric));
        }

        const baseline = await this.proformaSnapshot({ ...shared, legs: fixed });
        const probed = await this.proformaSnapshot({ ...shared, legs: [...fixed, probe(probePar)] });
        const probedAgain = await this.proformaSnapshot({ ...shared, legs: [...fixed, probe(probePar * 2)] });
        const quote = buildCapacityQuote({
            baseline,
            probe: probed,
            probeAgain: probedAgain,
            probePar,
            limitKind,
            weightedMetrics,
        });
        if (quote.capacityPar == null || quote.capacityPar <= 0) return quote;

        const at = (par: number) => this.proformaSnapshot({ ...shared, legs: [...fixed, probe(par)] });
        const closedRows = await at(quote.capacityPar);
        const breaches = newBreachKeys(baseline, closedRows, limitKind);
        if (breaches.length === 0) return quote;
        const verified = await searchFeasiblePar(quote.capacityPar, async (par) => {
            const rows = await at(par);
            return newBreachKeys(baseline, rows, limitKind).length === 0;
        });
        return applyVerifiedCapacity(quote, verified, breaches, closedRows);
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

export interface ProformaSnapshotOptions {
    anchorEntityId: string;
    legs: NormalizedProformaLeg[];
    asOfDate: string;
    knowledgeDate?: string;
    sourceScope?: string | null;
    ruleCodes?: string[] | null;
}

export interface EvaluateProformaOptions {
    anchorEntityId: string;
    legs: ProformaLegInput[];
    asOfDate: string;
    knowledgeDate?: string;
    sourceScope?: string | null;
    ruleCodes?: string[] | null;
}

export interface InvestmentCapacityOptions {
    anchorEntityId: string;
    securityId?: string | null;
    securityCode?: string | null;
    asOfDate: string;
    knowledgeDate?: string;
    sourceScope?: string | null;
    ruleCodes?: string[] | null;
    limitKind?: LimitKind | null;
    /** Buys and sells already in the package. Capacity is additional par of the security on top of these. */
    legs?: ProformaLegInput[] | null;
    probePar?: number | null;
}

export interface ProformaLine {
    ruleCode: string;
    ruleName: string;
    groupByValue: string | null;
    limitDirection: 'MAX' | 'MIN' | null;
    baselineValue: number | null;
    scenarioValue: number | null;
    baselineStatus: string | null;
    scenarioStatus: string | null;
    hardLimitValue: number | null;
    softLimitValue: number | null;
    baselineNumerator: number | null;
    scenarioNumerator: number | null;
    baselineDenominator: number | null;
    scenarioDenominator: number | null;
    verdict: string;
    approved: boolean;
}

export interface ProformaScore {
    approved: boolean;
    lines: ProformaLine[];
}

interface RawSnapshot {
    rule_code: string;
    rule_name: string;
    group_by_value: string | null;
    limit_direction: string | null;
    numerator_value: unknown;
    denominator_value: unknown;
    computed_value: unknown;
    soft_limit_value: unknown;
    hard_limit_value: unknown;
    status: string | null;
    result_unit: string | null;
    error_message: string | null;
}

interface RawProforma {
    rule_code: string;
    rule_name: string;
    group_by_value: string | null;
    limit_direction: string | null;
    baseline_value: unknown;
    scenario_value: unknown;
    baseline_status: string | null;
    scenario_status: string | null;
    hard_limit_value: unknown;
    soft_limit_value: unknown;
    baseline_numerator: unknown;
    scenario_numerator: unknown;
    baseline_denominator: unknown;
    scenario_denominator: unknown;
    verdict: string;
    approved: boolean;
}

function directionOf(value: string | null): 'MAX' | 'MIN' | null {
    if (value === 'MIN') return 'MIN';
    if (value === 'MAX') return 'MAX';
    return null;
}

function mapSnapshot(row: RawSnapshot): SnapshotRow {
    return {
        ruleCode: row.rule_code,
        ruleName: row.rule_name,
        groupByValue: row.group_by_value,
        limitDirection: directionOf(row.limit_direction),
        numeratorValue: asNumber(row.numerator_value),
        denominatorValue: asNumber(row.denominator_value),
        computedValue: asNumber(row.computed_value),
        softLimitValue: asNumber(row.soft_limit_value),
        hardLimitValue: asNumber(row.hard_limit_value),
        status: row.status,
        resultUnit: row.result_unit,
        errorMessage: row.error_message,
    };
}

function mapProforma(row: RawProforma): ProformaLine {
    return {
        ruleCode: row.rule_code,
        ruleName: row.rule_name,
        groupByValue: row.group_by_value,
        limitDirection: directionOf(row.limit_direction),
        baselineValue: asNumber(row.baseline_value),
        scenarioValue: asNumber(row.scenario_value),
        baselineStatus: row.baseline_status,
        scenarioStatus: row.scenario_status,
        hardLimitValue: asNumber(row.hard_limit_value),
        softLimitValue: asNumber(row.soft_limit_value),
        baselineNumerator: asNumber(row.baseline_numerator),
        scenarioNumerator: asNumber(row.scenario_numerator),
        baselineDenominator: asNumber(row.baseline_denominator),
        scenarioDenominator: asNumber(row.scenario_denominator),
        verdict: row.verdict,
        approved: row.approved,
    };
}
