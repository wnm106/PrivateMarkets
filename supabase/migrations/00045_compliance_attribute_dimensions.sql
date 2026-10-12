-- Migration: Compliance attribute dimensions + set-based value resolution
-- Description:
--   1. Every attribute reference in a rule (numerator, denominator, group-by key,
--      condition operand) can carry a "dimension": source + time offset
--      (+ optional period snap + knowledge-time mode). Default = run's source
--      scope (GOLDEN) at the run's as-of date, i.e. "golden / today".
--   2. Conditions can compare an attribute to ANOTHER attribute reference
--      (e.g. golden PRICE vs BLOOMBERG PRICE, or PRICE today vs PRICE 1 month ago).
--   3. result_transform lets numerator vs denominator be compared as
--      difference / % change instead of a plain ratio (current vs prior period,
--      source A vs source B).
--   4. Aggregation is now set-based (one query per aggregate rather than one
--      function call per entity) and backed by covering indexes.
--
-- Dimension JSON shape (all keys optional; {} = run defaults):
--   {
--     "source_scope":   "GOLDEN" | "<source_code>",          -- default: run source scope
--     "offset_unit":    "DAY" | "WEEK" | "MONTH" | "QUARTER" | "YEAR",
--     "offset_amount":  -1,                                  -- negative = past
--     "snap_to":        "MONTH_END" | "QUARTER_END" | "YEAR_END",  -- applied after offset
--     "knowledge_mode": "RUN" | "AT_OFFSET_DATE"
--         RUN            = value as currently known (run's knowledge_date)  [default]
--         AT_OFFSET_DATE = value as it was KNOWN at the end of the offset as-of
--                          date (what was reported then, pre-restatement)
--   }
-- NOTE: base-entity membership (rollup/relationship walk) is always resolved at
-- the run's as-of date; dimensions change only which attribute values are read.

-- ============================================================
-- 1. Schema changes
-- ============================================================
ALTER TABLE compliance.rule_versions
    ADD COLUMN IF NOT EXISTS numerator_dimension JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS denominator_dimension JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS group_by_dimension JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS result_transform VARCHAR(20) NOT NULL DEFAULT 'NONE'
        CHECK (result_transform IN ('NONE', 'DIFFERENCE', 'ABS_DIFFERENCE', 'PCT_CHANGE', 'ABS_PCT_CHANGE'));

COMMENT ON COLUMN compliance.rule_versions.result_transform IS 'NONE = numerator/denominator ratio. DIFFERENCE = num - den. ABS_DIFFERENCE = |num - den|. PCT_CHANGE = (num - den)/den. ABS_PCT_CHANGE = |(num - den)/den|. Percent variants are scaled x100 when result_unit = PERCENTAGE. Combine with numerator/denominator dimensions for current-vs-prior or source-vs-source comparisons.';

ALTER TABLE compliance.rule_conditions
    ADD COLUMN IF NOT EXISTS attribute_dimension JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS compare_attribute_code VARCHAR(100),
    ADD COLUMN IF NOT EXISTS compare_dimension JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN compliance.rule_conditions.compare_attribute_code IS 'When set, the right-hand operand is this attribute (read via compare_dimension) on the same entity instead of the literal value.';

-- ============================================================
-- 2. Dimension resolution
-- ============================================================
CREATE OR REPLACE FUNCTION compliance.resolve_dimension(
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ,
    p_run_source VARCHAR,
    p_dim JSONB,
    OUT o_as_of DATE,
    OUT o_knowledge TIMESTAMPTZ,
    OUT o_source VARCHAR
) LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_dim JSONB := COALESCE(p_dim, '{}'::JSONB);
    v_unit TEXT := upper(COALESCE(NULLIF(v_dim->>'offset_unit', ''), 'DAY'));
    v_amount INTEGER := COALESCE((v_dim->>'offset_amount')::INTEGER, 0);
    v_snap TEXT := upper(NULLIF(v_dim->>'snap_to', ''));
    v_mode TEXT := upper(COALESCE(NULLIF(v_dim->>'knowledge_mode', ''), 'RUN'));
    v_date DATE;
BEGIN
    v_date := (CASE v_unit
        WHEN 'DAY'     THEN p_as_of + make_interval(days   => v_amount)
        WHEN 'WEEK'    THEN p_as_of + make_interval(weeks  => v_amount)
        WHEN 'MONTH'   THEN p_as_of + make_interval(months => v_amount)
        WHEN 'QUARTER' THEN p_as_of + make_interval(months => v_amount * 3)
        WHEN 'YEAR'    THEN p_as_of + make_interval(years  => v_amount)
        ELSE NULL
    END)::DATE;

    IF v_date IS NULL THEN
        RAISE EXCEPTION 'Unknown dimension offset_unit: %', v_unit;
    END IF;

    IF v_snap = 'MONTH_END' THEN
        v_date := (date_trunc('month', v_date) + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    ELSIF v_snap = 'QUARTER_END' THEN
        v_date := (date_trunc('quarter', v_date) + INTERVAL '3 months' - INTERVAL '1 day')::DATE;
    ELSIF v_snap = 'YEAR_END' THEN
        v_date := (date_trunc('year', v_date) + INTERVAL '1 year' - INTERVAL '1 day')::DATE;
    ELSIF v_snap IS NOT NULL THEN
        RAISE EXCEPTION 'Unknown dimension snap_to: %', v_snap;
    END IF;

    o_as_of := v_date;

    IF v_mode = 'AT_OFFSET_DATE' AND v_date <> p_as_of THEN
        o_knowledge := LEAST(p_knowledge, ((v_date + 1)::TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 microsecond');
    ELSIF v_mode IN ('RUN', 'AT_OFFSET_DATE') THEN
        o_knowledge := p_knowledge;
    ELSE
        RAISE EXCEPTION 'Unknown dimension knowledge_mode: %', v_mode;
    END IF;

    o_source := COALESCE(NULLIF(v_dim->>'source_scope', ''), p_run_source, 'GOLDEN');
END;
$$;

COMMENT ON FUNCTION compliance.resolve_dimension IS 'Turns a run (as_of, knowledge, source) plus an attribute dimension spec into the concrete (as_of, knowledge, source) triple used to read an attribute value.';

CREATE OR REPLACE FUNCTION compliance.get_text_value_dim(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ,
    p_run_source VARCHAR,
    p_dim JSONB DEFAULT '{}'
) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
    r RECORD;
BEGIN
    SELECT * INTO r FROM compliance.resolve_dimension(p_as_of, p_knowledge, p_run_source, p_dim);
    RETURN compliance.get_text_value(p_entity_id, p_attribute_code, r.o_as_of, r.o_knowledge, r.o_source);
END;
$$;

-- ============================================================
-- 3. Set-based numeric value resolution + aggregation
-- ============================================================
CREATE OR REPLACE FUNCTION compliance.get_numeric_values(
    p_entity_ids UUID[],
    p_attribute_code VARCHAR,
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ,
    p_source_scope VARCHAR
) RETURNS TABLE (entity_id UUID, val NUMERIC) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
    IF p_source_scope IS NULL OR p_source_scope = 'GOLDEN' THEN
        RETURN QUERY
        SELECT DISTINCT ON (eav.entity_id) eav.entity_id, eav.golden_value_numeric
        FROM golden_master.entity_attribute_values eav
        WHERE eav.attribute_id IN (SELECT ar.id FROM metadata_register.attribute_register ar WHERE ar.attribute_code = p_attribute_code)
          AND eav.entity_id = ANY (p_entity_ids)
          AND eav.valid_from <= p_as_of AND eav.valid_to >= p_as_of
          AND eav.system_from <= p_knowledge AND eav.system_to >= p_knowledge
        ORDER BY eav.entity_id, eav.precedence_rank ASC;
    ELSE
        RETURN QUERY
        SELECT DISTINCT ON (sav.entity_id) sav.entity_id, sav.value_as_numeric
        FROM entity_instances.source_attribute_values sav
        WHERE sav.attribute_id IN (SELECT ar.id FROM metadata_register.attribute_register ar WHERE ar.attribute_code = p_attribute_code)
          AND sav.source_id IN (SELECT sr.id FROM entity_instances.source_registry sr WHERE sr.source_code = p_source_scope)
          AND sav.entity_id = ANY (p_entity_ids)
          AND sav.valid_from <= p_as_of AND sav.valid_to >= p_as_of
          AND sav.system_from <= p_knowledge AND sav.system_to >= p_knowledge
        ORDER BY sav.entity_id, sav.created_at DESC;
    END IF;
END;
$$;

COMMENT ON FUNCTION compliance.get_numeric_values IS 'Set-based version of get_numeric_value: resolves one numeric attribute for many entities in a single index-friendly query.';

DROP FUNCTION IF EXISTS compliance.aggregate_numeric(UUID[], VARCHAR, VARCHAR, DATE, TIMESTAMPTZ, VARCHAR);

CREATE OR REPLACE FUNCTION compliance.aggregate_numeric(
    p_entity_ids UUID[],
    p_attribute_code VARCHAR,
    p_aggregation VARCHAR,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_run_source VARCHAR DEFAULT 'GOLDEN',
    p_dimension JSONB DEFAULT '{}'
) RETURNS NUMERIC LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_result NUMERIC;
    r RECORD;
BEGIN
    IF p_entity_ids IS NULL OR array_length(p_entity_ids, 1) IS NULL OR p_attribute_code IS NULL THEN
        RETURN 0;
    END IF;

    SELECT * INTO r FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, p_run_source, p_dimension);

    SELECT
        CASE p_aggregation
            WHEN 'SUM' THEN SUM(v.val)
            WHEN 'AVG' THEN AVG(v.val)
            WHEN 'MIN' THEN MIN(v.val)
            WHEN 'MAX' THEN MAX(v.val)
            WHEN 'COUNT' THEN COUNT(v.val)
            WHEN 'VALUE' THEN MAX(v.val)
            ELSE SUM(v.val)
        END
    INTO v_result
    FROM compliance.get_numeric_values(p_entity_ids, p_attribute_code, r.o_as_of, r.o_knowledge, r.o_source) v;

    RETURN COALESCE(v_result, 0);
END;
$$;

COMMENT ON FUNCTION compliance.aggregate_numeric IS 'Aggregates (SUM/AVG/MIN/MAX/COUNT/VALUE) a numeric attribute across a set of base entities, reading values at the attribute dimension (source / time offset) given by p_dimension.';

-- ============================================================
-- 4. Conditions: dimension-aware operands + attribute-vs-attribute compare
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
    v_expected TEXT;
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
            v_actual := compliance.get_text_value_dim(p_entity_id, v_cond.attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.attribute_dimension);

            IF v_cond.compare_attribute_code IS NOT NULL THEN
                v_expected := compliance.get_text_value_dim(p_entity_id, v_cond.compare_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.compare_dimension);
            ELSE
                v_expected := v_cond.value;
            END IF;

            v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, v_expected);

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
        RETURN TRUE;
    END IF;

    RETURN v_any_group_match;
END;
$$;

-- ============================================================
-- 5. evaluate_rule: dimension-aware numerator/denominator/group key + transform
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
    v_num_dim RECORD;
    v_den_dim RECORD;
    v_detail JSONB;
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

    -- Resolve numerator/denominator dimensions once per run (run-level constants)
    SELECT * INTO v_num_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.numerator_dimension);
    SELECT * INTO v_den_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.denominator_dimension);

    v_detail := jsonb_build_object(
        'numerator',   jsonb_build_object('as_of', v_num_dim.o_as_of, 'knowledge', v_num_dim.o_knowledge, 'source', v_num_dim.o_source),
        'denominator', jsonb_build_object('as_of', v_den_dim.o_as_of, 'knowledge', v_den_dim.o_knowledge, 'source', v_den_dim.o_source),
        'result_transform', v_version.result_transform
    );

    INSERT INTO compliance.rule_evaluation_runs (rule_id, rule_version_id, as_of_date, knowledge_date, source_scope, triggered_by)
    VALUES (v_rule.id, v_version.id, p_as_of_date, p_knowledge_date, v_source_scope, p_triggered_by)
    RETURNING id INTO v_run_id;

    BEGIN
        FOR v_anchor IN
            SELECT a.entity_id
            FROM compliance.get_anchor_entities(v_rule.id, p_as_of_date, p_knowledge_date) a
        LOOP
            IF NOT compliance.entity_matches_conditions(v_anchor.entity_id, v_version.id, 'ANCHOR', p_as_of_date, p_knowledge_date, v_source_scope) THEN
                CONTINUE;
            END IF;

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
                    status, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    NULL, NULL, NULL,
                    v_version.limit_direction, v_version.soft_limit_value, v_version.hard_limit_value,
                    'NO_DATA', 0, v_detail
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            SELECT array_agg(eid) INTO v_eligible_base_ids
            FROM unnest(v_base_ids) AS eid
            WHERE compliance.entity_matches_conditions(eid, v_version.id, 'BASE', p_as_of_date, p_knowledge_date, v_source_scope);

            IF v_eligible_base_ids IS NULL OR array_length(v_eligible_base_ids, 1) IS NULL THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    NULL, NULL, NULL,
                    v_version.limit_direction, v_version.soft_limit_value, v_version.hard_limit_value,
                    'NO_DATA', 0, v_detail
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            v_group_map := '{}'::JSONB;

            IF v_version.group_by_attribute_code IS NULL THEN
                v_group_map := jsonb_build_object('__ALL__', to_jsonb(v_eligible_base_ids));
            ELSE
                FOR v_base_eid IN SELECT unnest(v_eligible_base_ids) LOOP
                    IF v_version.group_by_path IS NULL OR jsonb_array_length(v_version.group_by_path) = 0 THEN
                        v_key := compliance.get_text_value_dim(v_base_eid, v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension);
                    ELSE
                        SELECT compliance.get_text_value_dim(w[1], v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension)
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

            FOR v_key, v_group_rec IN SELECT * FROM jsonb_each(v_group_map) LOOP
                SELECT array_agg(x::UUID) INTO v_key_ids FROM jsonb_array_elements_text(v_group_rec) x;

                v_numerator := compliance.aggregate_numeric(
                    v_key_ids, v_version.numerator_attribute_code, v_version.numerator_aggregation,
                    p_as_of_date, p_knowledge_date, v_source_scope, v_version.numerator_dimension);

                IF v_version.denominator_attribute_code IS NULL AND v_version.denominator_scope != 'CONSTANT' THEN
                    v_denominator := NULL;
                ELSIF v_version.denominator_scope = 'CONSTANT' THEN
                    v_denominator := v_version.denominator_constant_value;
                ELSIF v_version.denominator_scope = 'ANCHOR_TOTAL' THEN
                    v_denominator := compliance.aggregate_numeric(
                        v_eligible_base_ids, v_version.denominator_attribute_code, v_version.denominator_aggregation,
                        p_as_of_date, p_knowledge_date, v_source_scope, v_version.denominator_dimension);
                ELSE -- SAME_GROUP
                    v_denominator := compliance.aggregate_numeric(
                        v_key_ids, v_version.denominator_attribute_code, v_version.denominator_aggregation,
                        p_as_of_date, p_knowledge_date, v_source_scope, v_version.denominator_dimension);
                END IF;

                IF v_denominator IS NULL THEN
                    v_computed := v_numerator;
                ELSIF v_version.result_transform = 'DIFFERENCE' THEN
                    v_computed := v_numerator - v_denominator;
                ELSIF v_version.result_transform = 'ABS_DIFFERENCE' THEN
                    v_computed := abs(v_numerator - v_denominator);
                ELSIF v_denominator = 0 THEN
                    v_computed := NULL; -- undefined ratio / % change
                ELSIF v_version.result_transform IN ('PCT_CHANGE', 'ABS_PCT_CHANGE') THEN
                    v_computed := (v_numerator - v_denominator) / v_denominator;
                    IF v_version.result_transform = 'ABS_PCT_CHANGE' THEN
                        v_computed := abs(v_computed);
                    END IF;
                    IF v_version.result_unit = 'PERCENTAGE' THEN
                        v_computed := v_computed * 100;
                    END IF;
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
                    status, breach_amount, contributing_entity_ids, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id,
                    CASE WHEN v_key = '__ALL__' OR v_key = '__UNASSIGNED__' THEN NULL ELSE v_key END,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_numerator, v_denominator, v_computed,
                    v_version.limit_direction, v_version.soft_limit_value, v_version.hard_limit_value,
                    v_status, v_breach, v_key_ids, array_length(v_key_ids, 1), v_detail
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

GRANT EXECUTE ON FUNCTION compliance.evaluate_rule(VARCHAR, DATE, TIMESTAMPTZ, VARCHAR, UUID) TO authenticated;

-- ============================================================
-- 6. Covering indexes for the (attribute, entity, as-of) lookup pattern.
--    Existing indexes are single-column / GiST; the engine's access path is
--    "this attribute, these entities, valid and system time containing X".
--    Text columns are intentionally not INCLUDEd (btree row-size limit).
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_eav_attr_entity_valid
    ON golden_master.entity_attribute_values (attribute_id, entity_id, valid_from DESC)
    INCLUDE (valid_to, system_from, system_to, precedence_rank, golden_value_numeric);

CREATE INDEX IF NOT EXISTS idx_sav_attr_source_entity_valid
    ON entity_instances.source_attribute_values (attribute_id, source_id, entity_id, valid_from DESC)
    INCLUDE (valid_to, system_from, system_to, created_at, value_as_numeric);

-- ============================================================
-- 7. PostgREST access to the compliance schema (the earlier migration
--    created the schema/tables but never granted API roles access; same
--    pattern as 00041/00044 for other schemas). RLS policies still apply.
-- ============================================================
GRANT USAGE ON SCHEMA compliance TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA compliance TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA compliance TO authenticated, service_role;