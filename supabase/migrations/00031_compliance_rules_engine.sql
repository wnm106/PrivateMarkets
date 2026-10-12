-- Migration: Compliance / Investment Limits Rules Engine
-- Description: Bi-temporal, entity-level-agnostic compliance rules engine.
--
-- This is distinct from data_quality.dq_rules (field-level data hygiene).
-- compliance.* rules express investment/regulatory limit tests such as
-- "no single issuer > 5% of fund NAV" or "industry concentration <= 20%",
-- with:
--   - single-record OR aggregate (rollup) evaluation
--   - conditional (AND/OR) eligibility criteria, reusing the
--     metadata_register.precedence_rule_conditions condition-group pattern
--   - numerator/denominator calculation with configurable aggregation
--   - hard limit + soft limit tracking
--   - evaluation against any as-of date (valid time), knowledge date
--     (system time), and golden-master OR a single named source
--   - bi-temporal rule *versions*, so if a rule's logic changes, evaluating
--     at an old knowledge_date reproduces the rule behavior as it was known
--     back then (mirrors golden_master.entity_attribute_values' valid_from/
--     valid_to + system_from/system_to convention)
--
-- Rollup model (see compliance.rule_versions):
--   anchor entity  -- the entity the rule is "about" (what gets scored/assigned
--                     to a rule; e.g. a FUND, or a PARENT_FUND)
--   base_rollup_path -- ordered relationship hops from the anchor down/around
--                     to the "base" entities whose attributes actually get
--                     aggregated (e.g. anchor FUND -> child POSITIONs, or
--                     anchor PARENT_FUND -> recursive child FUNDs)
--   group_by_path + group_by_attribute_code (optional) -- a further hop from
--                     each base entity to a related entity whose attribute
--                     value is used to sub-group the base entities (e.g. from
--                     each POSITION, hop to its SECURITY and read INDUSTRY).
--                     Aggregation values themselves are always read off the
--                     BASE entity, never off the group-by entity.

-- ============================================================
-- 0. Schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS compliance;
COMMENT ON SCHEMA compliance IS 'Bi-temporal investment/regulatory compliance rules engine: single-record and aggregate (rollup) rules with numerator/denominator calculations and hard/soft limits.';

-- ============================================================
-- 1. compliance.rules -- stable rule identity (does not change across versions)
-- ============================================================
CREATE TABLE compliance.rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_code VARCHAR(100) UNIQUE NOT NULL,
    rule_name VARCHAR(200) NOT NULL,
    rule_category VARCHAR(50) NOT NULL DEFAULT 'OTHER'
        CHECK (rule_category IN ('CONCENTRATION', 'EXPOSURE', 'DIVERSIFICATION', 'ELIGIBILITY', 'LEVERAGE', 'LIQUIDITY', 'OTHER')),

    -- The entity level this rule is "about" / can be assigned to. Any
    -- domain_code is valid here (FUND, ISSUER, SECURITY, ...) -- the engine
    -- is entity-level-agnostic.
    anchor_domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),

    -- Entity scoping: TRUE = applies to every active anchor_domain_code
    -- entity by default (see compliance.rule_scope_assignments for
    -- EXCLUDE carve-outs). FALSE = applies only to entities explicitly
    -- INCLUDEd via compliance.rule_scope_assignments.
    applies_to_all BOOLEAN NOT NULL DEFAULT TRUE,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    description TEXT,

    -- Tenant scoping (parity with entity_instances.master_entities.client_id).
    -- NULL = shared/global rule definition (like data_quality.dq_rules today).
    client_id UUID REFERENCES tenancy.clients(id),

    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

CREATE INDEX idx_compliance_rules_code ON compliance.rules(rule_code);
CREATE INDEX idx_compliance_rules_anchor_domain ON compliance.rules(anchor_domain_code);
CREATE INDEX idx_compliance_rules_active ON compliance.rules(is_active);
CREATE INDEX idx_compliance_rules_client ON compliance.rules(client_id);

COMMENT ON TABLE compliance.rules IS 'Stable identity for a compliance rule. Logic lives in compliance.rule_versions so it can change over time while preserving history.';
COMMENT ON COLUMN compliance.rules.applies_to_all IS 'TRUE = applies to all active anchor_domain_code entities by default (EXCLUDE rows in rule_scope_assignments can carve out exceptions). FALSE = applies only to entities explicitly INCLUDEd in rule_scope_assignments.';

-- ============================================================
-- 2. compliance.rule_versions -- bi-temporal rule logic
-- ============================================================
CREATE TABLE compliance.rule_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES compliance.rules(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,

    -- Bi-temporal dimensions (same convention as golden_master.entity_attribute_values):
    --   valid_from/valid_to   = VALID TIME: the business-effective window during
    --                           which this version's logic is the "official" rule
    --   system_from/system_to = SYSTEM/KNOWLEDGE TIME: when this version was
    --                           authored/recorded. Querying with an old
    --                           knowledge_date reproduces the logic as it was
    --                           known back then, even if it has since been
    --                           superseded or corrected.
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL DEFAULT '9999-12-31',
    system_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    system_to TIMESTAMPTZ NOT NULL DEFAULT '9999-12-31 23:59:59',

    -- Descriptive snapshot
    rule_name VARCHAR(200) NOT NULL,
    description TEXT,
    change_reason TEXT,

    -- What gets aggregated ("base" level). May equal rules.anchor_domain_code
    -- for single-record rules (base_rollup_path = '[]').
    base_domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),

    -- Ordered relationship traversal from the anchor entity to the set of
    -- base entities to aggregate. Each hop:
    --   { "relationship_code": "POSITION_FUND", "direction": "DOWN", "recursive": false }
    -- direction: 'DOWN' = anchor is parent, find children (child_entity_id);
    --            'UP'   = anchor is child, find parents (parent_entity_id).
    -- recursive: walk the same hop repeatedly (fixpoint) -- e.g. multi-level
    --            fund-of-funds via a self-referential FUND_PARENT relationship.
    -- Empty array ([]) = evaluate the anchor entity itself (single record).
    base_rollup_path JSONB NOT NULL DEFAULT '[]',

    -- Optional further traversal FROM each base entity, used only to resolve
    -- a grouping key (e.g. from a POSITION, hop to its SECURITY). Aggregation
    -- values are always read off the base entity, never off this entity.
    group_by_path JSONB NOT NULL DEFAULT '[]',
    -- Attribute to read for the group-by key: at the end of group_by_path if
    -- non-empty, otherwise directly on the base entity. NULL = no sub-grouping;
    -- all base entities under an anchor are aggregated together.
    group_by_attribute_code VARCHAR(100),

    -- Numerator
    numerator_attribute_code VARCHAR(100) NOT NULL,
    numerator_aggregation VARCHAR(20) NOT NULL DEFAULT 'SUM'
        CHECK (numerator_aggregation IN ('SUM', 'AVG', 'COUNT', 'MIN', 'MAX', 'VALUE')),

    -- Denominator (optional -- omit for a raw-value-vs-limit rule, e.g. a
    -- hard dollar exposure cap rather than a ratio).
    denominator_attribute_code VARCHAR(100),
    denominator_aggregation VARCHAR(20)
        CHECK (denominator_aggregation IS NULL OR denominator_aggregation IN ('SUM', 'AVG', 'COUNT', 'MIN', 'MAX', 'VALUE', 'CONSTANT')),
    -- SAME_GROUP   = aggregate over the same base-entity subset as the numerator's group
    -- ANCHOR_TOTAL = aggregate over ALL base entities under the anchor, ignoring group_by
    --                (this is what makes "% of fund" concentration ratios work)
    -- CONSTANT     = fixed denominator_constant_value
    denominator_scope VARCHAR(20) NOT NULL DEFAULT 'SAME_GROUP'
        CHECK (denominator_scope IN ('SAME_GROUP', 'ANCHOR_TOTAL', 'CONSTANT')),
    denominator_constant_value NUMERIC,

    result_unit VARCHAR(20) NOT NULL DEFAULT 'RATIO'
        CHECK (result_unit IN ('RATIO', 'PERCENTAGE', 'CURRENCY', 'COUNT')),

    -- Limits
    limit_direction VARCHAR(10) NOT NULL CHECK (limit_direction IN ('MAX', 'MIN')),
    soft_limit_value NUMERIC,
    hard_limit_value NUMERIC,

    -- Which source scope this version expects by default if a run doesn't
    -- override it ('GOLDEN' or a specific source_code, e.g. 'BLOOMBERG').
    default_source_scope VARCHAR(50) NOT NULL DEFAULT 'GOLDEN',

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id),

    UNIQUE (rule_id, version_number),
    CHECK (valid_from <= valid_to),
    CHECK (system_from <= system_to),
    CHECK (
        denominator_attribute_code IS NULL
        OR denominator_scope = 'CONSTANT'
        OR denominator_aggregation IS NOT NULL
    ),
    CHECK (denominator_scope != 'CONSTANT' OR denominator_constant_value IS NOT NULL)
);

CREATE INDEX idx_compliance_versions_rule ON compliance.rule_versions(rule_id);
CREATE INDEX idx_compliance_versions_valid_time ON compliance.rule_versions USING gist (valid_from, valid_to);
CREATE INDEX idx_compliance_versions_system_time ON compliance.rule_versions USING gist (system_from, system_to);
CREATE INDEX idx_compliance_versions_current ON compliance.rule_versions(rule_id)
    WHERE valid_to = '9999-12-31' AND system_to = '9999-12-31 23:59:59';

COMMENT ON TABLE compliance.rule_versions IS 'Bi-temporal rule logic. A rule_id can have many versions; resolve_rule_version() picks the one in force for a given (as_of_date, knowledge_date) pair, so historical re-evaluation reproduces period-correct behavior.';
COMMENT ON COLUMN compliance.rule_versions.base_rollup_path IS 'JSONB array of relationship hops [{relationship_code, direction, recursive}] from the anchor entity to the base-level entities being aggregated. Empty = single-record evaluation on the anchor itself.';
COMMENT ON COLUMN compliance.rule_versions.group_by_path IS 'JSONB array of relationship hops from each base entity to a related entity used only to resolve the group_by_attribute_code value (e.g. POSITION -> SECURITY to read INDUSTRY). Leave empty if group_by_attribute_code lives directly on the base entity, or if group_by_attribute_code is NULL (no sub-grouping).';

-- ============================================================
-- 3. compliance.rule_conditions -- AND/OR eligibility criteria
--    (mirrors metadata_register.precedence_rule_conditions)
-- ============================================================
CREATE TABLE compliance.rule_conditions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_version_id UUID NOT NULL REFERENCES compliance.rule_versions(id) ON DELETE CASCADE,

    -- BASE    = filters which base-level entities are included before aggregation
    --           (e.g. only POSITIONs where ASSET_CLASS = 'BOND')
    -- ANCHOR  = filters which anchor entities the rule runs against at all
    --           (in addition to rule_scope_assignments)
    applies_to VARCHAR(10) NOT NULL DEFAULT 'BASE' CHECK (applies_to IN ('BASE', 'ANCHOR')),

    condition_group INTEGER NOT NULL DEFAULT 1,
    condition_order INTEGER NOT NULL DEFAULT 1,
    attribute_code VARCHAR(100) NOT NULL,
    operator VARCHAR(50) NOT NULL,
    value TEXT,
    logic_operator VARCHAR(10) NOT NULL DEFAULT 'AND' CHECK (logic_operator IN ('AND', 'OR')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_compliance_conditions_version ON compliance.rule_conditions(rule_version_id);
CREATE INDEX idx_compliance_conditions_group ON compliance.rule_conditions(rule_version_id, applies_to, condition_group);

COMMENT ON TABLE compliance.rule_conditions IS 'AND/OR eligibility conditions. Within a condition_group, logic_operator folds consecutively; condition groups themselves are OR''d together (same semantics as metadata_register.precedence_rule_conditions / packages/graphql/src/lib/rule-engine.ts evaluateCondition).';

-- ============================================================
-- 4. compliance.rule_scope_assignments -- entity scoping (all vs specific)
--    (mirrors tenancy.entity_grants' include_children cascade pattern)
-- ============================================================
CREATE TABLE compliance.rule_scope_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES compliance.rules(id) ON DELETE CASCADE,
    scope_type VARCHAR(10) NOT NULL CHECK (scope_type IN ('INCLUDE', 'EXCLUDE')),
    entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    include_children BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (rule_id, scope_type, entity_id)
);

CREATE INDEX idx_compliance_scope_rule ON compliance.rule_scope_assignments(rule_id);
CREATE INDEX idx_compliance_scope_entity ON compliance.rule_scope_assignments(entity_id);

COMMENT ON TABLE compliance.rule_scope_assignments IS 'Explicit entity assignment rows. When rules.applies_to_all = TRUE, only EXCLUDE rows matter (carve-outs). When FALSE, only INCLUDE rows matter (allow-list), further reduced by any EXCLUDE rows. include_children cascades down entity_instances.entity_relationships (any relationship_code), matching tenancy.entity_grants.';

-- ============================================================
-- 5. compliance.rule_evaluation_runs -- a batch execution header
-- ============================================================
CREATE TABLE compliance.rule_evaluation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES compliance.rules(id),
    rule_version_id UUID NOT NULL REFERENCES compliance.rule_versions(id),

    -- Valid time being evaluated (e.g. a month-end date) and knowledge time
    -- used both to resolve which rule_version applies AND which bi-temporal
    -- attribute values to read.
    as_of_date DATE NOT NULL,
    knowledge_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 'GOLDEN' or a specific source_registry.source_code (single-source run)
    source_scope VARCHAR(50) NOT NULL DEFAULT 'GOLDEN',

    run_status VARCHAR(20) NOT NULL DEFAULT 'RUNNING' CHECK (run_status IN ('RUNNING', 'COMPLETED', 'FAILED')),
    error_message TEXT,
    result_count INTEGER,
    breach_count INTEGER,

    triggered_by UUID REFERENCES auth.users(id),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_compliance_runs_rule ON compliance.rule_evaluation_runs(rule_id);
CREATE INDEX idx_compliance_runs_version ON compliance.rule_evaluation_runs(rule_version_id);
CREATE INDEX idx_compliance_runs_as_of ON compliance.rule_evaluation_runs(as_of_date);
CREATE INDEX idx_compliance_runs_knowledge ON compliance.rule_evaluation_runs(knowledge_date);
CREATE INDEX idx_compliance_runs_status ON compliance.rule_evaluation_runs(run_status);

COMMENT ON TABLE compliance.rule_evaluation_runs IS 'One row per rule evaluation batch: pins the as_of_date (valid time), knowledge_date (system time), the resolved rule_version, and source scope (golden master or a single named source) used for that run.';

-- ============================================================
-- 6. compliance.rule_evaluation_results -- per anchor (+ group) result
-- ============================================================
CREATE TABLE compliance.rule_evaluation_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES compliance.rule_evaluation_runs(id) ON DELETE CASCADE,
    rule_id UUID NOT NULL REFERENCES compliance.rules(id),
    rule_version_id UUID NOT NULL REFERENCES compliance.rule_versions(id),

    anchor_entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id),
    -- NULL when the rule has no group_by_attribute_code (one result per anchor)
    group_by_value TEXT,

    as_of_date DATE NOT NULL,
    knowledge_date TIMESTAMPTZ NOT NULL,
    source_scope VARCHAR(50) NOT NULL DEFAULT 'GOLDEN',

    numerator_value NUMERIC,
    denominator_value NUMERIC,
    computed_value NUMERIC,

    -- Snapshot of the limits in force at evaluation time (audit trail: the
    -- rule_version may change later, but this row preserves what was tested).
    limit_direction VARCHAR(10),
    soft_limit_value NUMERIC,
    hard_limit_value NUMERIC,

    status VARCHAR(20) NOT NULL CHECK (status IN ('PASS', 'SOFT_BREACH', 'HARD_BREACH', 'NO_DATA', 'ERROR')),
    breach_amount NUMERIC,

    contributing_entity_ids UUID[],
    contributing_count INTEGER,
    detail JSONB DEFAULT '{}',

    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_compliance_results_run ON compliance.rule_evaluation_results(run_id);
CREATE INDEX idx_compliance_results_rule ON compliance.rule_evaluation_results(rule_id);
CREATE INDEX idx_compliance_results_anchor ON compliance.rule_evaluation_results(anchor_entity_id);
CREATE INDEX idx_compliance_results_status ON compliance.rule_evaluation_results(status);
CREATE INDEX idx_compliance_results_as_of ON compliance.rule_evaluation_results(as_of_date);

COMMENT ON TABLE compliance.rule_evaluation_results IS 'Append-only evaluation results, one row per (anchor_entity, group_by_value) per run. limit_direction/soft_limit_value/hard_limit_value are snapshotted from the rule_version for audit purposes even if the rule changes later.';

-- ============================================================
-- 7. Helper: generic operator evaluation (shared with precedence engine's
--    semantics; duplicated in SQL so condition evaluation stays in-database)
-- ============================================================
CREATE OR REPLACE FUNCTION compliance.evaluate_operator(
    p_actual TEXT,
    p_operator VARCHAR,
    p_value TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_actual_num NUMERIC;
    v_value_num NUMERIC;
BEGIN
    CASE p_operator
        WHEN 'equals' THEN RETURN p_actual = p_value;
        WHEN 'not_equals' THEN RETURN p_actual IS DISTINCT FROM p_value;
        WHEN 'is_null' THEN RETURN p_actual IS NULL OR p_actual = '';
        WHEN 'is_not_null' THEN RETURN p_actual IS NOT NULL AND p_actual != '';
        WHEN 'in' THEN
            BEGIN
                RETURN p_actual = ANY (SELECT jsonb_array_elements_text(p_value::jsonb));
            EXCEPTION WHEN OTHERS THEN RETURN FALSE;
            END;
        WHEN 'not_in' THEN
            BEGIN
                RETURN NOT (p_actual = ANY (SELECT jsonb_array_elements_text(p_value::jsonb)));
            EXCEPTION WHEN OTHERS THEN RETURN TRUE;
            END;
        WHEN 'gt', 'gte', 'lt', 'lte' THEN
            BEGIN
                v_actual_num := p_actual::NUMERIC;
                v_value_num := p_value::NUMERIC;
            EXCEPTION WHEN OTHERS THEN RETURN FALSE;
            END;
            RETURN CASE p_operator
                WHEN 'gt' THEN v_actual_num > v_value_num
                WHEN 'gte' THEN v_actual_num >= v_value_num
                WHEN 'lt' THEN v_actual_num < v_value_num
                WHEN 'lte' THEN v_actual_num <= v_value_num
            END;
        ELSE
            RAISE WARNING 'Unknown compliance condition operator: %', p_operator;
            RETURN FALSE;
    END CASE;
END;
$$;

COMMENT ON FUNCTION compliance.evaluate_operator IS 'Evaluates a single condition operator (equals, not_equals, in, not_in, is_null, is_not_null, gt, gte, lt, lte) as text/numeric comparison.';

-- ============================================================
-- 8. Helper: resolve attribute values (golden master OR single source)
-- ============================================================
CREATE OR REPLACE FUNCTION compliance.get_numeric_value(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR DEFAULT 'GOLDEN'
) RETURNS NUMERIC LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_value NUMERIC;
BEGIN
    IF p_source_scope IS NULL OR p_source_scope = 'GOLDEN' THEN
        SELECT eav.golden_value_numeric INTO v_value
        FROM golden_master.entity_attribute_values eav
        JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
        WHERE eav.entity_id = p_entity_id
          AND ar.attribute_code = p_attribute_code
          AND eav.valid_from <= p_as_of_date AND eav.valid_to >= p_as_of_date
          AND eav.system_from <= p_knowledge_date AND eav.system_to >= p_knowledge_date
        ORDER BY eav.precedence_rank ASC
        LIMIT 1;
    ELSE
        SELECT sav.value_as_numeric INTO v_value
        FROM entity_instances.source_attribute_values sav
        JOIN metadata_register.attribute_register ar ON ar.id = sav.attribute_id
        JOIN entity_instances.source_registry sr ON sr.id = sav.source_id
        WHERE sav.entity_id = p_entity_id
          AND ar.attribute_code = p_attribute_code
          AND sr.source_code = p_source_scope
          AND sav.valid_from <= p_as_of_date AND sav.valid_to >= p_as_of_date
          AND sav.system_from <= p_knowledge_date AND sav.system_to >= p_knowledge_date
        ORDER BY sav.created_at DESC
        LIMIT 1;
    END IF;
    RETURN v_value;
END;
$$;

COMMENT ON FUNCTION compliance.get_numeric_value IS 'Resolves a numeric attribute value for an entity as of a given valid date and knowledge date, from either the golden master (precedence-resolved) or a single named source.';

CREATE OR REPLACE FUNCTION compliance.get_text_value(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR DEFAULT 'GOLDEN'
) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_value TEXT;
BEGIN
    IF p_source_scope IS NULL OR p_source_scope = 'GOLDEN' THEN
        SELECT eav.golden_value INTO v_value
        FROM golden_master.entity_attribute_values eav
        JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
        WHERE eav.entity_id = p_entity_id
          AND ar.attribute_code = p_attribute_code
          AND eav.valid_from <= p_as_of_date AND eav.valid_to >= p_as_of_date
          AND eav.system_from <= p_knowledge_date AND eav.system_to >= p_knowledge_date
        ORDER BY eav.precedence_rank ASC
        LIMIT 1;
    ELSE
        SELECT sav.attribute_value INTO v_value
        FROM entity_instances.source_attribute_values sav
        JOIN metadata_register.attribute_register ar ON ar.id = sav.attribute_id
        JOIN entity_instances.source_registry sr ON sr.id = sav.source_id
        WHERE sav.entity_id = p_entity_id
          AND ar.attribute_code = p_attribute_code
          AND sr.source_code = p_source_scope
          AND sav.valid_from <= p_as_of_date AND sav.valid_to >= p_as_of_date
          AND sav.system_from <= p_knowledge_date AND sav.system_to >= p_knowledge_date
        ORDER BY sav.created_at DESC
        LIMIT 1;
    END IF;
    RETURN v_value;
END;
$$;

COMMENT ON FUNCTION compliance.get_text_value IS 'Resolves a text attribute value for an entity as of a given valid date and knowledge date, from either the golden master or a single named source. Used for condition evaluation and group-by key resolution.';

-- ============================================================
-- 9. Helper: relationship traversal (hierarchy rollups + related-attribute
--    rollups both use this)
-- ============================================================
CREATE OR REPLACE FUNCTION compliance.walk_relationship(
    p_start_ids UUID[],
    p_relationship_code VARCHAR,
    p_direction VARCHAR,     -- 'UP' (start is child, find parents) | 'DOWN' (start is parent, find children)
    p_recursive BOOLEAN,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS TABLE (entity_id UUID) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
    IF p_start_ids IS NULL OR array_length(p_start_ids, 1) IS NULL THEN
        RETURN;
    END IF;

    IF p_direction = 'UP' THEN
        IF p_recursive THEN
            RETURN QUERY
            WITH RECURSIVE walk(entity_id) AS (
                SELECT er.parent_entity_id
                FROM entity_instances.entity_relationships er
                WHERE er.child_entity_id = ANY (p_start_ids)
                  AND er.relationship_code = p_relationship_code
                  AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
                  AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
                UNION
                SELECT er.parent_entity_id
                FROM entity_instances.entity_relationships er
                JOIN walk w ON er.child_entity_id = w.entity_id
                WHERE er.relationship_code = p_relationship_code
                  AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
                  AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
            )
            SELECT DISTINCT walk.entity_id FROM walk;
        ELSE
            RETURN QUERY
            SELECT DISTINCT er.parent_entity_id
            FROM entity_instances.entity_relationships er
            WHERE er.child_entity_id = ANY (p_start_ids)
              AND er.relationship_code = p_relationship_code
              AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
              AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date;
        END IF;
    ELSE -- 'DOWN'
        IF p_recursive THEN
            RETURN QUERY
            WITH RECURSIVE walk(entity_id) AS (
                SELECT er.child_entity_id
                FROM entity_instances.entity_relationships er
                WHERE er.parent_entity_id = ANY (p_start_ids)
                  AND er.relationship_code = p_relationship_code
                  AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
                  AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
                UNION
                SELECT er.child_entity_id
                FROM entity_instances.entity_relationships er
                JOIN walk w ON er.parent_entity_id = w.entity_id
                WHERE er.relationship_code = p_relationship_code
                  AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
                  AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
            )
            SELECT DISTINCT walk.entity_id FROM walk;
        ELSE
            RETURN QUERY
            SELECT DISTINCT er.child_entity_id
            FROM entity_instances.entity_relationships er
            WHERE er.parent_entity_id = ANY (p_start_ids)
              AND er.relationship_code = p_relationship_code
              AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
              AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date;
        END IF;
    END IF;
END;
$$;

COMMENT ON FUNCTION compliance.walk_relationship IS 'One relationship hop from a set of start entities, optionally recursive (fixpoint), bi-temporally filtered on entity_relationships valid/system time.';

CREATE OR REPLACE FUNCTION compliance.walk_path(
    p_start_ids UUID[],
    p_path JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS UUID[] LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_current UUID[] := p_start_ids;
    v_hop JSONB;
    v_next UUID[];
BEGIN
    IF p_path IS NULL OR jsonb_array_length(p_path) = 0 THEN
        RETURN v_current;
    END IF;

    FOR v_hop IN SELECT * FROM jsonb_array_elements(p_path) LOOP
        SELECT array_agg(DISTINCT w.entity_id) INTO v_next
        FROM compliance.walk_relationship(
            v_current,
            v_hop ->> 'relationship_code',
            COALESCE(v_hop ->> 'direction', 'UP'),
            COALESCE((v_hop ->> 'recursive')::BOOLEAN, FALSE),
            p_as_of_date,
            p_knowledge_date
        ) w;

        v_current := COALESCE(v_next, '{}'::UUID[]);
        IF array_length(v_current, 1) IS NULL THEN
            RETURN '{}'::UUID[];
        END IF;
    END LOOP;

    RETURN v_current;
END;
$$;

COMMENT ON FUNCTION compliance.walk_path IS 'Chains multiple relationship hops (base_rollup_path or group_by_path) starting from a set of entities, returning the final entity id set.';

-- Generic descendant walker (ANY relationship_code), used for
-- rule_scope_assignments.include_children cascade -- mirrors
-- tenancy.entity_grants' include_children semantics.
CREATE OR REPLACE FUNCTION compliance.descendants_of(
    p_entity_id UUID,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS TABLE (entity_id UUID) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
    RETURN QUERY
    WITH RECURSIVE descend(entity_id) AS (
        SELECT er.child_entity_id
        FROM entity_instances.entity_relationships er
        WHERE er.parent_entity_id = p_entity_id
          AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
          AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
        UNION
        SELECT er.child_entity_id
        FROM entity_instances.entity_relationships er
        JOIN descend d ON er.parent_entity_id = d.entity_id
        WHERE er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
          AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
    )
    SELECT DISTINCT descend.entity_id FROM descend;
END;
$$;

COMMENT ON FUNCTION compliance.descendants_of IS 'All descendant entities of p_entity_id via any relationship_code, bi-temporally filtered. Used to cascade rule_scope_assignments.include_children.';

-- ============================================================
-- 10. Helper: condition evaluation (AND within group, OR across groups)
-- ============================================================
CREATE OR REPLACE FUNCTION compliance.entity_matches_conditions(
    p_entity_id UUID,
    p_rule_version_id UUID,
    p_applies_to VARCHAR,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR DEFAULT 'GOLDEN'
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_group_rec RECORD;
    v_cond RECORD;
    v_group_match BOOLEAN;
    v_any_group_match BOOLEAN := FALSE;
    v_has_conditions BOOLEAN := FALSE;
    v_actual TEXT;
    v_cond_result BOOLEAN;
BEGIN
    FOR v_group_rec IN
        SELECT DISTINCT condition_group
        FROM compliance.rule_conditions
        WHERE rule_version_id = p_rule_version_id AND applies_to = p_applies_to
    LOOP
        v_has_conditions := TRUE;
        v_group_match := NULL;

        FOR v_cond IN
            SELECT *
            FROM compliance.rule_conditions
            WHERE rule_version_id = p_rule_version_id
              AND applies_to = p_applies_to
              AND condition_group = v_group_rec.condition_group
            ORDER BY condition_order
        LOOP
            v_actual := compliance.get_text_value(p_entity_id, v_cond.attribute_code, p_as_of_date, p_knowledge_date, p_source_scope);
            v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, v_cond.value);

            IF v_group_match IS NULL THEN
                v_group_match := v_cond_result;
            ELSIF v_cond.logic_operator = 'OR' THEN
                v_group_match := v_group_match OR v_cond_result;
            ELSE
                v_group_match := v_group_match AND v_cond_result;
            END IF;
        END LOOP;

        IF v_group_match THEN
            v_any_group_match := TRUE;
        END IF;
    END LOOP;

    IF NOT v_has_conditions THEN
        RETURN TRUE; -- no conditions defined = always eligible
    END IF;

    RETURN v_any_group_match;
END;
$$;

COMMENT ON FUNCTION compliance.entity_matches_conditions IS 'Evaluates all condition groups (AND within a group, OR across groups) for a given entity against a rule version''s BASE or ANCHOR conditions.';

-- ============================================================
-- 11. Helper: aggregate a numeric attribute across a set of entities
-- ============================================================
CREATE OR REPLACE FUNCTION compliance.aggregate_numeric(
    p_entity_ids UUID[],
    p_attribute_code VARCHAR,
    p_aggregation VARCHAR,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR DEFAULT 'GOLDEN'
) RETURNS NUMERIC LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_result NUMERIC;
BEGIN
    IF p_entity_ids IS NULL OR array_length(p_entity_ids, 1) IS NULL OR p_attribute_code IS NULL THEN
        RETURN 0;
    END IF;

    SELECT
        CASE p_aggregation
            WHEN 'SUM' THEN SUM(v.val)
            WHEN 'AVG' THEN AVG(v.val)
            WHEN 'MIN' THEN MIN(v.val)
            WHEN 'MAX' THEN MAX(v.val)
            WHEN 'COUNT' THEN COUNT(v.val)
            WHEN 'VALUE' THEN MAX(v.val) -- single-record expected; defensive fallback
            ELSE SUM(v.val)
        END
    INTO v_result
    FROM (
        SELECT compliance.get_numeric_value(eid, p_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope) AS val
        FROM unnest(p_entity_ids) AS eid
    ) v;

    RETURN COALESCE(v_result, 0);
END;
$$;

COMMENT ON FUNCTION compliance.aggregate_numeric IS 'Aggregates (SUM/AVG/MIN/MAX/COUNT/VALUE) a numeric attribute across a set of base entities.';

-- ============================================================
-- 12. Core: resolve which rule_version is in force for (as_of_date, knowledge_date)
-- ============================================================
CREATE OR REPLACE FUNCTION compliance.resolve_rule_version(
    p_rule_id UUID,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ DEFAULT NOW()
) RETURNS compliance.rule_versions LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = compliance, pg_temp
AS $$
DECLARE
    v_version compliance.rule_versions;
BEGIN
    SELECT * INTO v_version
    FROM compliance.rule_versions
    WHERE rule_id = p_rule_id
      AND is_active = TRUE
      AND valid_from <= p_as_of_date AND valid_to >= p_as_of_date
      AND system_from <= p_knowledge_date AND system_to >= p_knowledge_date
    ORDER BY version_number DESC
    LIMIT 1;

    RETURN v_version;
END;
$$;

COMMENT ON FUNCTION compliance.resolve_rule_version IS 'Bi-temporal resolution: picks the rule_versions row whose valid_from/valid_to brackets as_of_date AND whose system_from/system_to brackets knowledge_date. Evaluating with an old knowledge_date reproduces the rule logic as it was known back then, even if later corrected or superseded.';

-- ============================================================
-- 13. Core: resolve applicable anchor entities for a rule
-- ============================================================
CREATE OR REPLACE FUNCTION compliance.get_anchor_entities(
    p_rule_id UUID,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS TABLE (entity_id UUID) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = compliance, entity_instances, tenancy, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_rule compliance.rules;
BEGIN
    SELECT * INTO v_rule FROM compliance.rules WHERE id = p_rule_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH include_direct AS (
        SELECT sa.entity_id
        FROM compliance.rule_scope_assignments sa
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'INCLUDE'
    ),
    include_cascaded AS (
        SELECT d.entity_id
        FROM compliance.rule_scope_assignments sa
        CROSS JOIN LATERAL compliance.descendants_of(sa.entity_id, p_as_of_date, p_knowledge_date) d
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'INCLUDE' AND sa.include_children = TRUE
    ),
    exclude_direct AS (
        SELECT sa.entity_id
        FROM compliance.rule_scope_assignments sa
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'EXCLUDE'
    ),
    exclude_cascaded AS (
        SELECT d.entity_id
        FROM compliance.rule_scope_assignments sa
        CROSS JOIN LATERAL compliance.descendants_of(sa.entity_id, p_as_of_date, p_knowledge_date) d
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'EXCLUDE' AND sa.include_children = TRUE
    ),
    candidate AS (
        SELECT me.id AS entity_id
        FROM entity_instances.master_entities me
        WHERE me.domain_code = v_rule.anchor_domain_code
          AND me.is_active = TRUE
          AND (
                v_rule.applies_to_all = TRUE
                OR me.id IN (SELECT entity_id FROM include_direct)
                OR me.id IN (SELECT entity_id FROM include_cascaded)
          )
    )
    SELECT c.entity_id
    FROM candidate c
    WHERE c.entity_id NOT IN (SELECT entity_id FROM exclude_direct)
      AND c.entity_id NOT IN (SELECT entity_id FROM exclude_cascaded);
END;
$$;

COMMENT ON FUNCTION compliance.get_anchor_entities IS 'Resolves the set of anchor-level entities a rule applies to: all active anchor_domain_code entities if applies_to_all, else the INCLUDE allow-list (with include_children cascade), minus any EXCLUDE carve-outs (also cascading).';

-- ============================================================
-- 14. Core: evaluate one rule for one (as_of_date, knowledge_date, source_scope)
-- ============================================================
CREATE OR REPLACE FUNCTION compliance.evaluate_rule(
    p_rule_code VARCHAR,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ DEFAULT NOW(),
    p_source_scope VARCHAR DEFAULT NULL,
    p_triggered_by UUID DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = compliance, entity_instances, metadata_register, golden_master, tenancy, pg_temp
AS $$
DECLARE
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_run_id UUID;
    v_source_scope VARCHAR;
    v_anchor RECORD;
    v_base_ids UUID[];
    v_eligible_base_ids UUID[];
    v_group_key UUID[];
    v_groups JSONB := '[]'::JSONB; -- [{ "key": text|null, "entity_ids": [uuid,...] }]
    v_group_rec JSONB;
    v_numerator NUMERIC;
    v_denominator NUMERIC;
    v_computed NUMERIC;
    v_status VARCHAR;
    v_breach NUMERIC;
    v_result_count INTEGER := 0;
    v_breach_count INTEGER := 0;
    v_base_eid UUID;
    v_key TEXT;
    v_key_ids UUID[];
    v_group_map JSONB;
BEGIN
    SELECT * INTO v_rule FROM compliance.rules WHERE rule_code = p_rule_code;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown compliance rule: %', p_rule_code;
    END IF;

    v_version := compliance.resolve_rule_version(v_rule.id, p_as_of_date, p_knowledge_date);
    IF v_version.id IS NULL THEN
        RAISE EXCEPTION 'No rule_version of % is in force for as_of_date=% / knowledge_date=%', p_rule_code, p_as_of_date, p_knowledge_date;
    END IF;

    v_source_scope := COALESCE(p_source_scope, v_version.default_source_scope, 'GOLDEN');

    INSERT INTO compliance.rule_evaluation_runs (rule_id, rule_version_id, as_of_date, knowledge_date, source_scope, triggered_by)
    VALUES (v_rule.id, v_version.id, p_as_of_date, p_knowledge_date, v_source_scope, p_triggered_by)
    RETURNING id INTO v_run_id;

    BEGIN
        FOR v_anchor IN
            SELECT a.entity_id
            FROM compliance.get_anchor_entities(v_rule.id, p_as_of_date, p_knowledge_date) a
        LOOP
            -- Anchor-level eligibility conditions
            IF NOT compliance.entity_matches_conditions(v_anchor.entity_id, v_version.id, 'ANCHOR', p_as_of_date, p_knowledge_date, v_source_scope) THEN
                CONTINUE;
            END IF;

            -- Base rollup: anchor itself if base_rollup_path is empty (single record)
            IF v_version.base_rollup_path IS NULL OR jsonb_array_length(v_version.base_rollup_path) = 0 THEN
                v_base_ids := ARRAY[v_anchor.entity_id];
            ELSE
                v_base_ids := compliance.walk_path(ARRAY[v_anchor.entity_id], v_version.base_rollup_path, p_as_of_date, p_knowledge_date);
            END IF;

            IF v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    NULL, NULL, NULL,
                    v_version.limit_direction, v_version.soft_limit_value, v_version.hard_limit_value,
                    'NO_DATA', 0
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            -- BASE-level eligibility conditions filter the rollup set
            SELECT array_agg(eid) INTO v_eligible_base_ids
            FROM unnest(v_base_ids) AS eid
            WHERE compliance.entity_matches_conditions(eid, v_version.id, 'BASE', p_as_of_date, p_knowledge_date, v_source_scope);

            IF v_eligible_base_ids IS NULL OR array_length(v_eligible_base_ids, 1) IS NULL THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    NULL, NULL, NULL,
                    v_version.limit_direction, v_version.soft_limit_value, v_version.hard_limit_value,
                    'NO_DATA', 0
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            -- Build groups: map of group_key -> entity_ids
            v_group_map := '{}'::JSONB;

            IF v_version.group_by_attribute_code IS NULL THEN
                v_group_map := jsonb_build_object('__ALL__', to_jsonb(v_eligible_base_ids));
            ELSE
                FOR v_base_eid IN SELECT unnest(v_eligible_base_ids) LOOP
                    IF v_version.group_by_path IS NULL OR jsonb_array_length(v_version.group_by_path) = 0 THEN
                        v_key := compliance.get_text_value(v_base_eid, v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope);
                    ELSE
                        SELECT compliance.get_text_value(w[1], v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope)
                        INTO v_key
                        FROM (SELECT compliance.walk_path(ARRAY[v_base_eid], v_version.group_by_path, p_as_of_date, p_knowledge_date) AS w) wx;
                    END IF;

                    v_key := COALESCE(v_key, '__UNASSIGNED__');

                    IF v_group_map ? v_key THEN
                        v_group_map := jsonb_set(
                            v_group_map, ARRAY[v_key],
                            to_jsonb((SELECT array_agg(x) FROM (
                                SELECT jsonb_array_elements_text(v_group_map -> v_key)::UUID AS x
                                UNION ALL SELECT v_base_eid
                            ) u))
                        );
                    ELSE
                        v_group_map := jsonb_set(v_group_map, ARRAY[v_key], jsonb_build_array(v_base_eid), TRUE);
                    END IF;
                END LOOP;
            END IF;

            -- Evaluate each group
            FOR v_key, v_group_rec IN SELECT * FROM jsonb_each(v_group_map) LOOP
                SELECT array_agg(x::UUID) INTO v_key_ids FROM jsonb_array_elements_text(v_group_rec) x;

                v_numerator := compliance.aggregate_numeric(v_key_ids, v_version.numerator_attribute_code, v_version.numerator_aggregation, p_as_of_date, p_knowledge_date, v_source_scope);

                IF v_version.denominator_attribute_code IS NULL AND v_version.denominator_scope != 'CONSTANT' THEN
                    v_denominator := NULL;
                ELSIF v_version.denominator_scope = 'CONSTANT' THEN
                    v_denominator := v_version.denominator_constant_value;
                ELSIF v_version.denominator_scope = 'ANCHOR_TOTAL' THEN
                    v_denominator := compliance.aggregate_numeric(v_eligible_base_ids, v_version.denominator_attribute_code, v_version.denominator_aggregation, p_as_of_date, p_knowledge_date, v_source_scope);
                ELSE -- SAME_GROUP
                    v_denominator := compliance.aggregate_numeric(v_key_ids, v_version.denominator_attribute_code, v_version.denominator_aggregation, p_as_of_date, p_knowledge_date, v_source_scope);
                END IF;

                IF v_denominator IS NULL THEN
                    v_computed := v_numerator;
                ELSIF v_denominator = 0 THEN
                    v_computed := NULL; -- undefined ratio
                ELSE
                    v_computed := v_numerator / v_denominator;
                    IF v_version.result_unit = 'PERCENTAGE' THEN
                        v_computed := v_computed * 100;
                    END IF;
                END IF;

                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_version.limit_direction = 'MAX' THEN
                    IF v_version.hard_limit_value IS NOT NULL AND v_computed > v_version.hard_limit_value THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_version.hard_limit_value;
                    ELSIF v_version.soft_limit_value IS NOT NULL AND v_computed > v_version.soft_limit_value THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_computed - v_version.soft_limit_value;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                ELSE -- MIN
                    IF v_version.hard_limit_value IS NOT NULL AND v_computed < v_version.hard_limit_value THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_version.hard_limit_value - v_computed;
                    ELSIF v_version.soft_limit_value IS NOT NULL AND v_computed < v_version.soft_limit_value THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_version.soft_limit_value - v_computed;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                END IF;

                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_entity_ids, contributing_count
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id,
                    CASE WHEN v_key = '__ALL__' OR v_key = '__UNASSIGNED__' THEN NULL ELSE v_key END,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_numerator, v_denominator, v_computed,
                    v_version.limit_direction, v_version.soft_limit_value, v_version.hard_limit_value,
                    v_status, v_breach, v_key_ids, array_length(v_key_ids, 1)
                );

                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
            END LOOP;
        END LOOP;

        UPDATE compliance.rule_evaluation_runs
        SET run_status = 'COMPLETED', completed_at = NOW(), result_count = v_result_count, breach_count = v_breach_count
        WHERE id = v_run_id;

    EXCEPTION WHEN OTHERS THEN
        UPDATE compliance.rule_evaluation_runs
        SET run_status = 'FAILED', completed_at = NOW(), error_message = SQLERRM
        WHERE id = v_run_id;
        RAISE;
    END;

    RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION compliance.evaluate_rule IS 'Main orchestrator: resolves the in-force rule_version for (as_of_date, knowledge_date), resolves applicable anchor entities, rolls up to base entities (single record if base_rollup_path is empty), applies BASE/ANCHOR eligibility conditions, groups by group_by_attribute_code if set, computes numerator/denominator, compares against hard/soft limits, and persists one rule_evaluation_runs row plus one rule_evaluation_results row per (anchor, group).';

GRANT EXECUTE ON FUNCTION compliance.evaluate_rule(VARCHAR, DATE, TIMESTAMPTZ, VARCHAR, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION compliance.resolve_rule_version(UUID, DATE, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION compliance.get_anchor_entities(UUID, DATE, TIMESTAMPTZ) TO authenticated;

-- ============================================================
-- 15. Seed: a new self-referential FUND hierarchy relationship, needed for
--     parent-fund / child-fund rollups (fund-of-funds).
-- ============================================================
INSERT INTO metadata_register.relationship_types (relationship_code, relationship_name, parent_domain_code, child_domain_code, description, cardinality, is_required)
VALUES ('FUND_PARENT', 'Fund to Parent Fund', 'FUND', 'FUND', 'Self-referential fund-of-funds hierarchy: child FUND rolls up to a parent FUND', 'MANY_TO_ONE', FALSE)
ON CONFLICT (relationship_code) DO NOTHING;

-- ============================================================
-- 16. Seed: example rule definitions (illustrative; inactive by default so
--     they don't fire until real entity/relationship data exists)
-- ============================================================

-- Example 1: Single-record rule -- issuer-level market cap floor (MIN, no denominator)
INSERT INTO compliance.rules (rule_code, rule_name, rule_category, anchor_domain_code, applies_to_all, is_active, description)
VALUES ('ISSUER_MIN_MARKET_CAP', 'Issuer Minimum Market Capitalization', 'ELIGIBILITY', 'ISSUER', TRUE, FALSE,
        'Each issuer must have a market cap of at least the soft/hard floor. Single-record rule: no rollup.')
ON CONFLICT (rule_code) DO NOTHING;

INSERT INTO compliance.rule_versions (
    rule_id, version_number, valid_from, rule_name, base_domain_code,
    base_rollup_path, numerator_attribute_code, numerator_aggregation,
    limit_direction, soft_limit_value, hard_limit_value, result_unit
)
SELECT r.id, 1, '2020-01-01', r.rule_name, 'ISSUER',
       '[]'::jsonb, 'MARKET_CAP', 'VALUE',
       'MIN', 100000000, 50000000, 'CURRENCY'
FROM compliance.rules r WHERE r.rule_code = 'ISSUER_MIN_MARKET_CAP'
ON CONFLICT (rule_id, version_number) DO NOTHING;

-- Example 2: Parent-fund rollup -- child FUNDs' NAV summed under a PARENT_FUND
-- anchor, compared against a hard dollar exposure cap (no denominator).
INSERT INTO compliance.rules (rule_code, rule_name, rule_category, anchor_domain_code, applies_to_all, is_active, description)
VALUES ('FUND_FAMILY_NAV_CAP', 'Fund-of-Funds Aggregate NAV Cap', 'EXPOSURE', 'FUND', TRUE, FALSE,
        'Sums NAV across all child funds under a parent fund (recursive, multi-level fund-of-funds) and checks against a hard dollar cap.')
ON CONFLICT (rule_code) DO NOTHING;

INSERT INTO compliance.rule_versions (
    rule_id, version_number, valid_from, rule_name, base_domain_code,
    base_rollup_path, numerator_attribute_code, numerator_aggregation,
    limit_direction, soft_limit_value, hard_limit_value, result_unit
)
SELECT r.id, 1, '2020-01-01', r.rule_name, 'FUND',
       '[{"relationship_code": "FUND_PARENT", "direction": "DOWN", "recursive": true}]'::jsonb,
       'NAV', 'SUM',
       'MAX', 450000000, 500000000, 'CURRENCY'
FROM compliance.rules r WHERE r.rule_code = 'FUND_FAMILY_NAV_CAP'
ON CONFLICT (rule_id, version_number) DO NOTHING;

-- Example 3: Related-attribute rollup -- per-fund industry concentration.
-- Base entities are POSITIONs (starts at the local/base entity level), but
-- the grouping key (INDUSTRY) is read off each position's related SECURITY.
-- Numerator = sum of MARKET_VALUE for positions in that industry group;
-- denominator = sum of MARKET_VALUE for ALL positions in the fund
-- (ANCHOR_TOTAL), producing a concentration percentage.
INSERT INTO compliance.rules (rule_code, rule_name, rule_category, anchor_domain_code, applies_to_all, is_active, description)
VALUES ('FUND_INDUSTRY_CONCENTRATION', 'Fund Industry Concentration Limit', 'CONCENTRATION', 'FUND', TRUE, FALSE,
        'For each fund, groups its positions by the INDUSTRY attribute on each position''s related security, and limits any single industry''s share of fund market value.')
ON CONFLICT (rule_code) DO NOTHING;

INSERT INTO compliance.rule_versions (
    rule_id, version_number, valid_from, rule_name, base_domain_code,
    base_rollup_path, group_by_path, group_by_attribute_code,
    numerator_attribute_code, numerator_aggregation,
    denominator_attribute_code, denominator_aggregation, denominator_scope,
    limit_direction, soft_limit_value, hard_limit_value, result_unit
)
SELECT r.id, 1, '2020-01-01', r.rule_name, 'POSITION',
       '[{"relationship_code": "POSITION_FUND", "direction": "DOWN", "recursive": false}]'::jsonb,
       '[{"relationship_code": "POSITION_SECURITY", "direction": "UP", "recursive": false}]'::jsonb,
       'INDUSTRY',
       'MARKET_VALUE', 'SUM',
       'MARKET_VALUE', 'SUM', 'ANCHOR_TOTAL',
       'MAX', 18, 20, 'PERCENTAGE'
FROM compliance.rules r WHERE r.rule_code = 'FUND_INDUSTRY_CONCENTRATION'
ON CONFLICT (rule_id, version_number) DO NOTHING;

-- ============================================================
-- 17. Tenancy: permission + RLS (shared catalog pattern, mirrors
--     data_quality.dq_rules; results are entity-scoped like dq_exceptions)
-- ============================================================
INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('compliance.manage', 'Manage compliance rules, scope assignments, and trigger evaluation runs')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code = 'compliance.manage'
WHERE r.role_code IN ('CLIENT_ADMIN', 'DATA_STEWARD') AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

ALTER TABLE compliance.rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.rule_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.rule_scope_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.rule_evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.rule_evaluation_results ENABLE ROW LEVEL SECURITY;

-- Shared catalog tables: readable by all authenticated, writable only by
-- tenant admins. This mirrors the exact pattern 00029 applies to
-- data_quality.dq_rules and the other cross-client taxonomy/config tables
-- (metadata_register.*, entity_instances.source_registry, etc.) rather than
-- introducing a new per-client permission check for what is, today, a
-- shared/global rule catalog (compliance.rules.client_id is NULL for shared
-- rules). If per-client-authored compliance rules are needed later, revisit
-- this alongside a dedicated 'compliance.manage' permission check.
CREATE POLICY "Compliance rules readable by authenticated" ON compliance.rules
    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "Compliance rules writable by tenant admins" ON compliance.rules
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

CREATE POLICY "Compliance rule versions readable by authenticated" ON compliance.rule_versions
    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "Compliance rule versions writable by tenant admins" ON compliance.rule_versions
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

CREATE POLICY "Compliance rule conditions readable by authenticated" ON compliance.rule_conditions
    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "Compliance rule conditions writable by tenant admins" ON compliance.rule_conditions
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

CREATE POLICY "Compliance scope assignments readable by authenticated" ON compliance.rule_scope_assignments
    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "Compliance scope assignments writable by tenant admins" ON compliance.rule_scope_assignments
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

-- Evaluation runs: shared catalog-level visibility (a run spans many anchor
-- entities, potentially across clients). The direct table-write policy below
-- is intentionally tenant-admin-only; ordinary authenticated users trigger
-- evaluations via compliance.evaluate_rule(), which is SECURITY DEFINER (see
-- above) and therefore performs its own inserts/updates as the function
-- owner, bypassing this policy -- exactly like tenancy.start_impersonation
-- writing to tenancy.impersonation_sessions. What a caller can see afterward
-- is still governed entirely by the SELECT policies below / on results.
CREATE POLICY "Compliance runs readable by authenticated" ON compliance.rule_evaluation_runs
    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "Compliance runs writable by tenant admins" ON compliance.rule_evaluation_runs
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

-- Results: entity-scoped like data_quality.dq_exceptions, since each result
-- row is "about" a specific anchor_entity_id which belongs to a client.
CREATE POLICY "Compliance results readable per entity access" ON compliance.rule_evaluation_results
    FOR SELECT TO authenticated
    USING (tenancy.has_entity_access(anchor_entity_id, 'READ'));
CREATE POLICY "Compliance results writable by entity access or tenant admins" ON compliance.rule_evaluation_results
    FOR ALL TO authenticated
    USING (tenancy.has_entity_access(anchor_entity_id, 'WRITE') OR tenancy.is_tenant_admin())
    WITH CHECK (tenancy.has_entity_access(anchor_entity_id, 'WRITE') OR tenancy.is_tenant_admin());
