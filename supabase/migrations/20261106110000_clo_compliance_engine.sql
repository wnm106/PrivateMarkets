-- CLO 2.0 compliance engine additions.
--
-- The compliance engine already runs concentration, grouped, ranked, and
-- coverage rules for the 1940 Act. CLO indentures need four things it could
-- not express, all added here without a new table:
--
--   1. COVERAGE and COLLATERAL_QUALITY rule categories.
--   2. Composite ratio rules (metadata logic = 'composite_ratio'). A result is
--      the sum of numerator terms over the sum of denominator terms, where each
--      term reads its own set of entities from the anchor. This is what the OC
--      and IC tests are: adjusted collateral (positions, haircuts, cash) over
--      note par or interest due, across three different entity types.
--      A term can also be a par-weighted average (WARF, WAS, WAL, WARR) or an
--      excess over a percentage cap (the CCC haircut).
--   3. excess_amount on every ratio result that breaches a MAX limit, so a
--      bucket cap reports how much par sits above the cap.
--   4. Pre-trade maintain-or-improve: evaluate_pre_trade runs the rules with
--      and without a scenario and compares them test by test.
--
-- Rule metadata (compliance.rule_versions.metadata):
--   logic            'composite_ratio' switches the composite path on
--   numerator_terms  [term, ...] summed, each times its sign (default 1)
--   denominator_terms [term, ...] summed. Omit for a rule with no denominator.
--   limit_term       a term that reads the limit from the data, for example a
--                    note class OC trigger or a CLO_TRANSACTION cap. A value
--                    found there replaces hard_limit_value for the anchor.
--   scenario_mode    'strict' keeps hypothetical positions out unless they
--                    carry the scenario code being evaluated
--   pre_trade        true includes the rule in evaluate_pre_trade by default
--
-- A term is JSON:
--   label       text shown in the result detail
--   kind        SUM (default) | COUNT | MIN | MAX | AVG | VALUE | WAVG | EXCESS_OVER_PCT
--   path        hops from the anchor to the entities read. [] is the anchor.
--   where       filters on those entities (see clo_filters_match). A filter may
--               compare to an anchor attribute with value_attribute and value_path.
--   attribute   the attribute read off each entity (the value, for WAVG)
--   sign        1 or -1, applied when the term joins a sum
--   required    true makes the rule NO_DATA when the term has no value
--   WAVG:  weight_attribute, value_path (hops from each weighted entity to the
--          entity holding the value), transform YEARS_TO_DATE for date values
--   EXCESS_OVER_PCT: total_path / total_where (default: same set, no filter),
--          pct (number) or pct_term (a term), price_attribute (haircut the
--          excess by one minus the par-weighted average price)

-- ============================================================
-- 1. Rule categories
-- ============================================================

DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'compliance'
          AND rel.relname = 'rules'
          AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) ILIKE '%rule_category%'
    LOOP
        EXECUTE format('ALTER TABLE compliance.rules DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE compliance.rules
    ADD CONSTRAINT rules_rule_category_check
    CHECK (rule_category IN (
        'CONCENTRATION', 'EXPOSURE', 'DIVERSIFICATION', 'ELIGIBILITY',
        'LEVERAGE', 'LIQUIDITY', 'FORTY_ACT', 'COVERAGE', 'COLLATERAL_QUALITY', 'OTHER'
    ));

-- ============================================================
-- 2. Helpers
-- ============================================================

-- Walk relationship hops from a set of entities. Where the declared direction
-- reaches nobody the opposite direction is tried, because relationship rows
-- are not always stored the way the relationship type declares them.
CREATE OR REPLACE FUNCTION compliance.walk_path_flexible(
    p_start_ids UUID[],
    p_path JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS UUID[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_current UUID[] := COALESCE(p_start_ids, '{}'::UUID[]);
    v_hop JSONB;
    v_next UUID[];
    v_direction VARCHAR;
BEGIN
    IF p_path IS NULL OR jsonb_typeof(p_path) IS DISTINCT FROM 'array' OR jsonb_array_length(p_path) = 0 THEN
        RETURN v_current;
    END IF;

    FOR v_hop IN SELECT * FROM jsonb_array_elements(p_path) LOOP
        IF array_length(v_current, 1) IS NULL THEN
            RETURN '{}'::UUID[];
        END IF;
        v_direction := COALESCE(v_hop ->> 'direction', 'UP');

        SELECT array_agg(DISTINCT w.entity_id) INTO v_next
        FROM compliance.walk_relationship(
            v_current, v_hop ->> 'relationship_code', v_direction,
            COALESCE((v_hop ->> 'recursive')::BOOLEAN, FALSE),
            p_as_of_date, p_knowledge_date
        ) w;

        IF v_next IS NULL OR array_length(v_next, 1) IS NULL THEN
            SELECT array_agg(DISTINCT w.entity_id) INTO v_next
            FROM compliance.walk_relationship(
                v_current, v_hop ->> 'relationship_code',
                CASE WHEN v_direction = 'UP' THEN 'DOWN' ELSE 'UP' END,
                COALESCE((v_hop ->> 'recursive')::BOOLEAN, FALSE),
                p_as_of_date, p_knowledge_date
            ) w;
        END IF;

        v_current := COALESCE(v_next, '{}'::UUID[]);
    END LOOP;

    RETURN v_current;
END;
$$;

COMMENT ON FUNCTION compliance.walk_path_flexible IS
    'Like walk_path, but a hop whose declared direction reaches nobody is retried in the other direction.';

-- Filters on one entity. Each filter is {attribute, op, value, path?, default?}.
-- op: equals, not_equals, in, not_in, lt, lte, gt, gte, is_null, is_not_null.
-- Text comparisons ignore case. A path reads the attribute off the first
-- related entity. default stands in when the attribute has no value.
-- All filters must match.
CREATE OR REPLACE FUNCTION compliance.clo_filters_match(
    p_entity_id UUID,
    p_filters JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR,
    p_anchor_id UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_filter JSONB;
    v_cmp UUID[];
    v_da DATE;
    v_db DATE;
    v_subjects UUID[];
    v_actual TEXT;
    v_op TEXT;
    v_expected TEXT;
    v_ok BOOLEAN;
    v_a NUMERIC;
    v_b NUMERIC;
BEGIN
    IF p_filters IS NULL OR jsonb_typeof(p_filters) IS DISTINCT FROM 'array' THEN
        RETURN TRUE;
    END IF;

    FOR v_filter IN SELECT * FROM jsonb_array_elements(p_filters) LOOP
        IF v_filter ? 'path' AND jsonb_array_length(v_filter -> 'path') > 0 THEN
            v_subjects := compliance.walk_path_flexible(ARRAY[p_entity_id], v_filter -> 'path', p_as_of_date, p_knowledge_date);
        ELSE
            v_subjects := ARRAY[p_entity_id];
        END IF;

        v_actual := NULL;
        IF v_subjects IS NOT NULL AND array_length(v_subjects, 1) IS NOT NULL THEN
            v_actual := compliance.get_text_value(v_subjects[1], v_filter ->> 'attribute', p_as_of_date, p_knowledge_date, p_source_scope);
        END IF;
        IF v_actual IS NULL AND v_filter ? 'default' THEN
            v_actual := v_filter ->> 'default';
        END IF;

        v_op := lower(COALESCE(v_filter ->> 'op', 'equals'));
        v_expected := v_filter ->> 'value';
        -- value_attribute compares against an attribute of the anchor (for
        -- example an asset maturity against the CLO stated maturity).
        IF v_filter ? 'value_attribute' THEN
            v_expected := NULL;
            IF p_anchor_id IS NOT NULL THEN
                v_cmp := compliance.walk_path_flexible(
                    ARRAY[p_anchor_id], COALESCE(v_filter -> 'value_path', '[]'::JSONB),
                    p_as_of_date, p_knowledge_date);
                IF v_cmp IS NOT NULL AND array_length(v_cmp, 1) IS NOT NULL THEN
                    v_expected := compliance.get_text_value(v_cmp[1], v_filter ->> 'value_attribute',
                                                            p_as_of_date, p_knowledge_date, p_source_scope);
                END IF;
            END IF;
        END IF;
        v_ok := FALSE;

        IF v_op = 'equals' THEN
            v_ok := v_actual IS NOT NULL AND lower(v_actual) = lower(v_expected);
        ELSIF v_op = 'not_equals' THEN
            v_ok := v_actual IS NULL OR lower(v_actual) <> lower(v_expected);
        ELSIF v_op = 'in' THEN
            v_ok := v_actual IS NOT NULL AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(v_filter -> 'value') x WHERE lower(x) = lower(v_actual)
            );
        ELSIF v_op = 'not_in' THEN
            v_ok := v_actual IS NULL OR NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(v_filter -> 'value') x WHERE lower(x) = lower(v_actual)
            );
        ELSIF v_op = 'is_null' THEN
            v_ok := v_actual IS NULL;
        ELSIF v_op = 'is_not_null' THEN
            v_ok := v_actual IS NOT NULL;
        ELSIF v_op IN ('lt', 'lte', 'gt', 'gte') THEN
            BEGIN
                v_a := v_actual::NUMERIC;
                v_b := v_expected::NUMERIC;
                v_ok := CASE v_op
                    WHEN 'lt' THEN v_a < v_b
                    WHEN 'lte' THEN v_a <= v_b
                    WHEN 'gt' THEN v_a > v_b
                    ELSE v_a >= v_b
                END;
            EXCEPTION WHEN OTHERS THEN
                BEGIN
                    v_da := v_actual::DATE;
                    v_db := v_expected::DATE;
                    v_ok := CASE v_op
                        WHEN 'lt' THEN v_da < v_db
                        WHEN 'lte' THEN v_da <= v_db
                        WHEN 'gt' THEN v_da > v_db
                        ELSE v_da >= v_db
                    END;
                EXCEPTION WHEN OTHERS THEN
                    v_ok := FALSE;
                END;
            END;
        END IF;

        IF NOT COALESCE(v_ok, FALSE) THEN
            RETURN FALSE;
        END IF;
    END LOOP;

    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION compliance.clo_filters_match IS
    'True when an entity passes every filter in a composite-rule term. See the header of the CLO engine migration for the filter shape.';

-- A hypothetical position (POSITION_IS_HYPOTHETICAL) counts only inside the
-- scenario whose code it carries. Everything else always counts.
CREATE OR REPLACE FUNCTION compliance.scenario_strict_include(
    p_entity_id UUID,
    p_scenario_code VARCHAR,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_hypo TEXT;
BEGIN
    v_hypo := compliance.get_text_value(p_entity_id, 'POSITION_IS_HYPOTHETICAL', p_as_of_date, p_knowledge_date, p_source_scope);
    IF v_hypo IS NULL OR lower(v_hypo) <> 'true' THEN
        RETURN TRUE;
    END IF;
    RETURN p_scenario_code IS NOT NULL
       AND compliance.get_text_value(p_entity_id, 'POSITION_SCENARIO_CODE', p_as_of_date, p_knowledge_date, p_source_scope)
           IS NOT DISTINCT FROM p_scenario_code;
END;
$$;

COMMENT ON FUNCTION compliance.scenario_strict_include IS
    'Strict scenario membership for CLO rules: a hypothetical position is in only when its scenario code matches the one being evaluated.';

GRANT EXECUTE ON FUNCTION compliance.walk_path_flexible(UUID[], JSONB, DATE, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.clo_filters_match(UUID, JSONB, DATE, TIMESTAMPTZ, VARCHAR, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.scenario_strict_include(UUID, VARCHAR, DATE, TIMESTAMPTZ, VARCHAR) TO authenticated, service_role;

-- The entities a term reads: walk the path from the anchor, then keep those
-- that pass the filters and belong in the scenario.
CREATE OR REPLACE FUNCTION compliance.clo_term_ids(
    p_anchor_id UUID,
    p_path JSONB,
    p_where JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR,
    p_scenario_code VARCHAR
) RETURNS UUID[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_ids UUID[];
    v_kept UUID[];
BEGIN
    IF p_path IS NULL OR jsonb_typeof(p_path) IS DISTINCT FROM 'array' OR jsonb_array_length(p_path) = 0 THEN
        v_ids := ARRAY[p_anchor_id];
    ELSE
        v_ids := compliance.walk_path_flexible(ARRAY[p_anchor_id], p_path, p_as_of_date, p_knowledge_date);
    END IF;

    IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
        RETURN '{}'::UUID[];
    END IF;

    SELECT COALESCE(array_agg(e), '{}'::UUID[]) INTO v_kept
    FROM unnest(v_ids) AS e
    WHERE compliance.clo_filters_match(e, p_where, p_as_of_date, p_knowledge_date, p_source_scope, p_anchor_id)
      AND compliance.scenario_strict_include(e, p_scenario_code, p_as_of_date, p_knowledge_date, p_source_scope);

    RETURN v_kept;
END;
$$;

-- One term of a composite rule, evaluated for one anchor. Returns NULL when
-- the term has nothing to read, except SUM and COUNT, which return 0.
CREATE OR REPLACE FUNCTION compliance.eval_clo_term(
    p_anchor_id UUID,
    p_term JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR,
    p_scenario_code VARCHAR
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_kind TEXT := upper(COALESCE(p_term ->> 'kind', 'SUM'));
    v_attr TEXT := p_term ->> 'attribute';
    v_ids UUID[];
    v_total_ids UUID[];
    v_values NUMERIC[];
    v_sum_where NUMERIC;
    v_sum_total NUMERIC;
    v_pct NUMERIC;
    v_excess NUMERIC;
    v_avg_price NUMERIC;
    v_weights JSONB;
    v_subject_of JSONB := '{}'::JSONB;
    v_subject_vals JSONB;
    v_base UUID;
    v_walked UUID[];
    v_subject UUID;
    v_w NUMERIC;
    v_v NUMERIC;
    v_text TEXT;
    v_w_sum NUMERIC := 0;
    v_wv_sum NUMERIC := 0;
    v_subjects UUID[];
BEGIN
    v_ids := compliance.clo_term_ids(p_anchor_id, p_term -> 'path', p_term -> 'where',
                                     p_as_of_date, p_knowledge_date, p_source_scope, p_scenario_code);

    IF v_kind IN ('SUM', 'COUNT', 'MIN', 'MAX', 'AVG', 'VALUE') THEN
        IF array_length(v_ids, 1) IS NULL THEN
            RETURN CASE WHEN v_kind IN ('SUM', 'COUNT') THEN 0 ELSE NULL END;
        END IF;
        SELECT array_agg(g.val) INTO v_values
        FROM compliance.get_numeric_values(v_ids, v_attr, p_as_of_date, p_knowledge_date, p_source_scope) g
        WHERE g.val IS NOT NULL;
        IF v_values IS NULL OR array_length(v_values, 1) IS NULL THEN
            RETURN CASE WHEN v_kind IN ('SUM', 'COUNT') THEN 0 ELSE NULL END;
        END IF;
        RETURN compliance.apply_aggregation(v_kind, v_values);

    ELSIF v_kind = 'EXCESS_OVER_PCT' THEN
        IF p_term ? 'pct' THEN
            v_pct := (p_term ->> 'pct')::NUMERIC;
        ELSE
            v_pct := compliance.eval_clo_term(p_anchor_id, p_term -> 'pct_term',
                                              p_as_of_date, p_knowledge_date, p_source_scope, p_scenario_code);
        END IF;
        IF v_pct IS NULL THEN
            RETURN NULL;
        END IF;

        v_total_ids := compliance.clo_term_ids(
            p_anchor_id,
            COALESCE(p_term -> 'total_path', p_term -> 'path'),
            p_term -> 'total_where',
            p_as_of_date, p_knowledge_date, p_source_scope, p_scenario_code
        );

        SELECT COALESCE(SUM(g.val), 0) INTO v_sum_where
        FROM compliance.get_numeric_values(v_ids, v_attr, p_as_of_date, p_knowledge_date, p_source_scope) g;
        SELECT COALESCE(SUM(g.val), 0) INTO v_sum_total
        FROM compliance.get_numeric_values(v_total_ids, v_attr, p_as_of_date, p_knowledge_date, p_source_scope) g;

        v_excess := GREATEST(v_sum_where - (v_pct / 100.0) * v_sum_total, 0);

        IF v_excess > 0 AND p_term ? 'price_attribute' AND v_sum_where > 0 THEN
            SELECT SUM(w.val * p.val) / NULLIF(SUM(w.val), 0) INTO v_avg_price
            FROM compliance.get_numeric_values(v_ids, v_attr, p_as_of_date, p_knowledge_date, p_source_scope) w
            JOIN compliance.get_numeric_values(v_ids, p_term ->> 'price_attribute', p_as_of_date, p_knowledge_date, p_source_scope) p
              ON p.entity_id = w.entity_id;
            IF v_avg_price IS NOT NULL THEN
                v_excess := v_excess * GREATEST(1 - v_avg_price / 100.0, 0);
            END IF;
        END IF;
        RETURN v_excess;

    ELSIF v_kind = 'WAVG' THEN
        IF array_length(v_ids, 1) IS NULL THEN
            RETURN NULL;
        END IF;

        SELECT COALESCE(jsonb_object_agg(g.entity_id::TEXT, g.val), '{}'::JSONB) INTO v_weights
        FROM compliance.get_numeric_values(v_ids, p_term ->> 'weight_attribute', p_as_of_date, p_knowledge_date, p_source_scope) g
        WHERE g.val IS NOT NULL;

        -- Which entity holds the value for each weighted entity.
        FOR v_base IN SELECT unnest(v_ids) LOOP
            IF p_term ? 'value_path' AND jsonb_array_length(p_term -> 'value_path') > 0 THEN
                v_walked := compliance.walk_path_flexible(ARRAY[v_base], p_term -> 'value_path', p_as_of_date, p_knowledge_date);
                v_subject := CASE WHEN array_length(v_walked, 1) IS NULL THEN NULL ELSE v_walked[1] END;
            ELSE
                v_subject := v_base;
            END IF;
            IF v_subject IS NOT NULL THEN
                v_subject_of := v_subject_of || jsonb_build_object(v_base::TEXT, v_subject::TEXT);
            END IF;
        END LOOP;

        IF upper(COALESCE(p_term ->> 'transform', '')) <> 'YEARS_TO_DATE' THEN
            SELECT array_agg(DISTINCT x::UUID) INTO v_subjects
            FROM jsonb_each_text(v_subject_of) AS t(k, x);
            SELECT COALESCE(jsonb_object_agg(g.entity_id::TEXT, g.val), '{}'::JSONB) INTO v_subject_vals
            FROM compliance.get_numeric_values(COALESCE(v_subjects, '{}'::UUID[]), v_attr, p_as_of_date, p_knowledge_date, p_source_scope) g
            WHERE g.val IS NOT NULL;
        END IF;

        FOR v_base IN SELECT unnest(v_ids) LOOP
            v_w := NULLIF(v_weights ->> v_base::TEXT, '')::NUMERIC;
            v_subject := NULLIF(v_subject_of ->> v_base::TEXT, '')::UUID;
            IF v_w IS NULL OR v_subject IS NULL THEN
                CONTINUE;
            END IF;

            v_v := NULL;
            IF upper(COALESCE(p_term ->> 'transform', '')) = 'YEARS_TO_DATE' THEN
                v_text := compliance.get_text_value(v_subject, v_attr, p_as_of_date, p_knowledge_date, p_source_scope);
                IF v_text IS NOT NULL THEN
                    BEGIN
                        v_v := GREATEST((v_text::DATE - p_as_of_date)::NUMERIC / 365.25, 0);
                    EXCEPTION WHEN OTHERS THEN
                        v_v := NULL;
                    END;
                END IF;
            ELSE
                v_v := NULLIF(v_subject_vals ->> v_subject::TEXT, '')::NUMERIC;
            END IF;

            IF v_v IS NULL THEN
                CONTINUE;
            END IF;
            v_w_sum := v_w_sum + v_w;
            v_wv_sum := v_wv_sum + v_w * v_v;
        END LOOP;

        IF v_w_sum = 0 THEN
            RETURN NULL;
        END IF;
        RETURN v_wv_sum / v_w_sum;
    END IF;

    RAISE EXCEPTION 'Unknown composite term kind: %', v_kind;
END;
$$;

COMMENT ON FUNCTION compliance.eval_clo_term IS
    'Evaluates one term of a composite compliance rule for one anchor: a sum or other aggregate, a par-weighted average, or an excess over a percentage cap.';

GRANT EXECUTE ON FUNCTION compliance.clo_term_ids(UUID, JSONB, JSONB, DATE, TIMESTAMPTZ, VARCHAR, VARCHAR) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.eval_clo_term(UUID, JSONB, DATE, TIMESTAMPTZ, VARCHAR, VARCHAR) TO authenticated, service_role;

-- ============================================================
-- 3. evaluate_rule: composite ratios, strict scenarios, excess_amount
--    (the 1940 Act version with three additions; every other path is unchanged)
-- ============================================================

CREATE OR REPLACE FUNCTION compliance.evaluate_rule(
    p_rule_code character varying,
    p_as_of_date date,
    p_knowledge_date timestamp with time zone DEFAULT now(),
    p_source_scope character varying DEFAULT NULL,
    p_triggered_by uuid DEFAULT NULL,
    p_anchor_entity_id uuid DEFAULT NULL,
    p_scenario_code character varying DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $function$
DECLARE
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_run_id UUID;
    v_source_scope VARCHAR;
    v_anchor RECORD;
    v_base_ids UUID[];
    v_more UUID[];
    v_child_funds UUID[];
    v_eligible_base_ids UUID[];
    v_numerator NUMERIC;
    v_denominator NUMERIC;
    v_computed NUMERIC;
    v_status VARCHAR;
    v_breach NUMERIC;
    v_result_count INTEGER := 0;
    v_breach_count INTEGER := 0;
    v_base_eid UUID;
    v_key TEXT;
    v_group_map JSONB;
    v_part RECORD;
    v_row RECORD;
    v_num_dim RECORD;
    v_den_dim RECORD;
    v_detail JSONB;
    v_hard NUMERIC;
    v_soft NUMERIC;
    v_lim NUMERIC;
    v_anc_den NUMERIC;
    v_opt_out BOOLEAN;
    v_limit RECORD;
    v_group_label TEXT;
    v_meta JSONB;
    v_walked UUID[];
    v_subject UUID;
    v_group_entities JSONB;
    v_addend NUMERIC;
    v_assets NUMERIC;
    v_debt NUMERIC;
    v_excess NUMERIC;
    v_basket_group NUMERIC;
    v_basket_cap NUMERIC;
    v_is_coverage BOOLEAN;
    v_pass_empty BOOLEAN;
    v_is_composite BOOLEAN;
    v_strict BOOLEAN;
    v_term JSONB;
    v_tval NUMERIC;
    v_num_sum NUMERIC;
    v_den_sum NUMERIC;
    v_has_den BOOLEAN;
    v_missing BOOLEAN;
    v_term_detail JSONB;
    v_limit_val NUMERIC;
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
    v_meta := COALESCE(v_version.metadata, '{}'::jsonb);
    v_pass_empty := COALESCE((v_meta->>'pass_if_empty')::BOOLEAN, FALSE);
    v_is_coverage := COALESCE(v_meta->>'logic', '') = 'asset_coverage';
    v_is_composite := COALESCE(v_meta->>'logic', '') = 'composite_ratio';
    v_strict := COALESCE(v_meta->>'scenario_mode', '') = 'strict';
    v_basket_group := NULLIF(v_meta #>> '{exception_basket,per_group_limit}', '')::NUMERIC;
    v_basket_cap := NULLIF(v_meta #>> '{exception_basket,basket_limit}', '')::NUMERIC;

    SELECT * INTO v_num_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.numerator_dimension);
    SELECT * INTO v_den_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.denominator_dimension);

    v_detail := jsonb_build_object(
        'numerator', jsonb_build_object('as_of', v_num_dim.o_as_of, 'knowledge', v_num_dim.o_knowledge, 'source', v_num_dim.o_source),
        'denominator', jsonb_build_object('as_of', v_den_dim.o_as_of, 'knowledge', v_den_dim.o_knowledge, 'source', v_den_dim.o_source),
        'result_transform', v_version.result_transform,
        'consolidate_descendants', COALESCE(v_version.consolidate_descendants, FALSE),
        'logic', NULLIF(v_meta->>'logic', '')
    );

    INSERT INTO compliance.rule_evaluation_runs (rule_id, rule_version_id, as_of_date, knowledge_date, source_scope, triggered_by, metadata)
    VALUES (v_rule.id, v_version.id, p_as_of_date, p_knowledge_date, v_source_scope, p_triggered_by,
            CASE WHEN p_scenario_code IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('scenario_code', p_scenario_code) END)
    RETURNING id INTO v_run_id;

    CREATE TEMP TABLE IF NOT EXISTS compliance_eval_parts (
        group_key TEXT,
        numerator NUMERIC,
        denominator NUMERIC,
        computed NUMERIC,
        contributing_ids UUID[]
    ) ON COMMIT DROP;

    BEGIN
        FOR v_anchor IN
            SELECT a.entity_id
            FROM compliance.get_anchor_entities(v_rule.id, p_as_of_date, p_knowledge_date) a
        LOOP
            IF p_anchor_entity_id IS NOT NULL AND v_anchor.entity_id <> p_anchor_entity_id THEN
                CONTINUE;
            END IF;

            IF NOT compliance.entity_matches_conditions(v_anchor.entity_id, v_version.id, 'ANCHOR', p_as_of_date, p_knowledge_date, v_source_scope) THEN
                CONTINUE;
            END IF;

            SELECT EXISTS (
                SELECT 1
                FROM compliance.rule_thresholds t
                WHERE t.rule_id = v_rule.id
                  AND t.entity_id = v_anchor.entity_id
                  AND t.group_value IS NULL
                  AND t.rank_from IS NULL
                  AND t.rank_to IS NULL
                  AND t.applies = FALSE
                  AND t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
            ) INTO v_opt_out;
            IF v_opt_out THEN
                CONTINUE;
            END IF;

            v_hard := v_version.hard_limit_value;
            v_soft := v_version.soft_limit_value;
            IF v_version.hard_limit_attribute_code IS NOT NULL THEN
                v_lim := NULL;
                SELECT g.val INTO v_lim
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], v_version.hard_limit_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;
                IF v_lim IS NOT NULL THEN
                    v_hard := v_lim;
                    v_soft := CASE WHEN v_version.soft_limit_factor IS NOT NULL THEN v_lim * v_version.soft_limit_factor END;
                END IF;
            END IF;

            IF v_meta ? 'limit_term' THEN
                v_limit_val := compliance.eval_clo_term(
                    v_anchor.entity_id, v_meta->'limit_term',
                    p_as_of_date, p_knowledge_date, v_source_scope, p_scenario_code
                );
                IF v_limit_val IS NOT NULL THEN
                    v_hard := v_limit_val;
                    v_soft := CASE WHEN v_version.soft_limit_factor IS NOT NULL THEN v_limit_val * v_version.soft_limit_factor END;
                END IF;
            END IF;

            IF v_is_composite THEN
                v_num_sum := 0;
                v_den_sum := 0;
                v_missing := FALSE;
                v_term_detail := '[]'::jsonb;
                v_has_den := jsonb_array_length(COALESCE(v_meta->'denominator_terms', '[]'::jsonb)) > 0;

                FOR v_term IN SELECT * FROM jsonb_array_elements(COALESCE(v_meta->'numerator_terms', '[]'::jsonb)) LOOP
                    v_tval := compliance.eval_clo_term(v_anchor.entity_id, v_term, p_as_of_date, p_knowledge_date, v_source_scope, p_scenario_code);
                    IF v_tval IS NULL AND COALESCE((v_term->>'required')::BOOLEAN, FALSE) THEN
                        v_missing := TRUE;
                    END IF;
                    v_num_sum := v_num_sum + COALESCE(v_tval, 0) * COALESCE((v_term->>'sign')::NUMERIC, 1);
                    v_term_detail := v_term_detail || jsonb_build_array(jsonb_build_object(
                        'side', 'numerator', 'label', v_term->>'label', 'value', v_tval,
                        'sign', COALESCE((v_term->>'sign')::NUMERIC, 1)));
                END LOOP;

                FOR v_term IN SELECT * FROM jsonb_array_elements(COALESCE(v_meta->'denominator_terms', '[]'::jsonb)) LOOP
                    v_tval := compliance.eval_clo_term(v_anchor.entity_id, v_term, p_as_of_date, p_knowledge_date, v_source_scope, p_scenario_code);
                    IF v_tval IS NULL AND COALESCE((v_term->>'required')::BOOLEAN, FALSE) THEN
                        v_missing := TRUE;
                    END IF;
                    v_den_sum := v_den_sum + COALESCE(v_tval, 0) * COALESCE((v_term->>'sign')::NUMERIC, 1);
                    v_term_detail := v_term_detail || jsonb_build_array(jsonb_build_object(
                        'side', 'denominator', 'label', v_term->>'label', 'value', v_tval,
                        'sign', COALESCE((v_term->>'sign')::NUMERIC, 1)));
                END LOOP;

                -- A fund row in rule_thresholds overrides the limit.
                SELECT * INTO v_limit
                FROM compliance.resolve_threshold(v_rule.id, v_anchor.entity_id, NULL, NULL::BIGINT, p_as_of_date, v_soft, v_hard);
                IF NOT COALESCE(v_limit.applies, TRUE) THEN
                    CONTINUE;
                END IF;

                IF v_missing OR (v_has_den AND COALESCE(v_den_sum, 0) = 0) THEN
                    v_computed := NULL;
                ELSIF v_has_den THEN
                    v_computed := v_num_sum / v_den_sum;
                    IF v_version.result_unit = 'PERCENTAGE' THEN
                        v_computed := v_computed * 100;
                    END IF;
                ELSE
                    v_computed := v_num_sum;
                END IF;

                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_limit.hard_limit IS NULL AND v_limit.soft_limit IS NULL THEN
                    -- Nothing says what the limit is, so there is nothing to pass.
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_version.limit_direction = 'MAX' THEN
                    IF v_limit.hard_limit IS NOT NULL AND v_computed > v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_limit.hard_limit;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed > v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_computed - v_limit.soft_limit;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                ELSE
                    IF v_limit.hard_limit IS NOT NULL AND v_computed < v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_limit.hard_limit - v_computed;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed < v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_limit.soft_limit - v_computed;
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
                    status, breach_amount, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_num_sum, CASE WHEN v_has_den THEN v_den_sum END, v_computed,
                    v_version.limit_direction, v_limit.soft_limit, v_limit.hard_limit,
                    v_status, v_breach, 0,
                    v_detail || jsonb_build_object('terms', v_term_detail, 'limit_source', v_limit.source)
                    || CASE
                        WHEN v_has_den AND v_version.limit_direction = 'MAX' AND v_limit.hard_limit IS NOT NULL
                             AND v_version.result_unit IN ('PERCENTAGE', 'RATIO')
                        THEN jsonb_build_object('excess_amount', GREATEST(
                            v_num_sum - (v_limit.hard_limit / CASE WHEN v_version.result_unit = 'PERCENTAGE' THEN 100.0 ELSE 1.0 END) * v_den_sum, 0))
                        ELSE '{}'::jsonb
                       END
                );
                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
                CONTINUE;
            END IF;

            v_anc_den := NULL;
            IF v_version.denominator_source = 'ANCHOR' AND v_version.denominator_attribute_code IS NOT NULL THEN
                SELECT g.val INTO v_anc_den
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], v_version.denominator_attribute_code, v_den_dim.o_as_of, v_den_dim.o_knowledge, v_den_dim.o_source) AS g
                LIMIT 1;
            END IF;

            IF v_version.base_rollup_path IS NULL OR jsonb_array_length(v_version.base_rollup_path) = 0 THEN
                v_base_ids := ARRAY[v_anchor.entity_id];
            ELSE
                v_base_ids := compliance.walk_path(ARRAY[v_anchor.entity_id], v_version.base_rollup_path, p_as_of_date, p_knowledge_date);
            END IF;

            IF COALESCE(v_version.consolidate_descendants, FALSE) THEN
                v_child_funds := compliance.walk_path(
                    ARRAY[v_anchor.entity_id],
                    '[{"relationship_code":"FUND_PARENT","direction":"DOWN","recursive":true}]'::jsonb,
                    p_as_of_date,
                    p_knowledge_date
                );
                IF v_child_funds IS NOT NULL AND array_length(v_child_funds, 1) IS NOT NULL THEN
                    IF v_version.base_rollup_path IS NULL OR jsonb_array_length(v_version.base_rollup_path) = 0 THEN
                        v_more := v_child_funds;
                    ELSE
                        v_more := compliance.walk_path(v_child_funds, v_version.base_rollup_path, p_as_of_date, p_knowledge_date);
                    END IF;
                    SELECT array_agg(DISTINCT x) INTO v_base_ids
                    FROM unnest(COALESCE(v_base_ids, '{}'::UUID[]) || COALESCE(v_more, '{}'::UUID[])) AS x
                    WHERE x IS NOT NULL;
                END IF;
            END IF;

            IF (v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL) AND NOT v_is_coverage THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    NULL,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    v_version.limit_direction, v_soft, v_hard,
                    CASE WHEN v_pass_empty THEN 'PASS' ELSE 'NO_DATA' END,
                    0, v_detail || jsonb_build_object('empty', TRUE)
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            IF v_is_coverage AND (v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL) THEN
                v_eligible_base_ids := ARRAY[]::UUID[];
            ELSE
                SELECT array_agg(eid) INTO v_eligible_base_ids
                FROM unnest(v_base_ids) AS eid
                WHERE compliance.entity_matches_conditions(eid, v_version.id, 'BASE', p_as_of_date, p_knowledge_date, v_source_scope)
                  AND compliance.include_in_scenario(eid, p_scenario_code, p_as_of_date, p_knowledge_date, v_source_scope)
                  AND (NOT v_strict OR compliance.scenario_strict_include(eid, p_scenario_code, p_as_of_date, p_knowledge_date, v_source_scope));
            END IF;

            IF v_is_coverage THEN
                v_addend := 0;
                IF v_eligible_base_ids IS NOT NULL AND array_length(v_eligible_base_ids, 1) IS NOT NULL THEN
                    SELECT COALESCE(SUM(g.val), 0) INTO v_addend
                    FROM compliance.get_numeric_values(
                        v_eligible_base_ids,
                        COALESCE(v_meta->>'addend_attribute', 'ESTIMATED_VALUE'),
                        p_as_of_date, p_knowledge_date, v_source_scope
                    ) AS g;
                END IF;
                v_assets := NULL;
                v_debt := NULL;
                SELECT g.val INTO v_assets
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], COALESCE(v_meta->>'assets_attribute', 'TOTAL_AUM'), p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;
                SELECT g.val INTO v_debt
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], COALESCE(v_meta->>'debt_attribute', 'TOTAL_DEBT'), p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;

                IF v_assets IS NULL OR v_debt IS NULL THEN
                    v_numerator := NULL;
                    v_denominator := NULL;
                    v_computed := NULL;
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSE
                    v_numerator := v_assets + COALESCE(v_addend, 0);
                    v_denominator := v_debt + COALESCE(v_addend, 0);
                    IF v_denominator = 0 THEN
                        v_computed := NULL;
                        v_status := 'NO_DATA';
                        v_breach := NULL;
                    ELSE
                        v_computed := v_numerator / v_denominator;
                        IF v_version.limit_direction = 'MAX' THEN
                            IF v_hard IS NOT NULL AND v_computed > v_hard THEN
                                v_status := 'HARD_BREACH';
                                v_breach := v_computed - v_hard;
                            ELSIF v_soft IS NOT NULL AND v_computed > v_soft THEN
                                v_status := 'SOFT_BREACH';
                                v_breach := v_computed - v_soft;
                            ELSE
                                v_status := 'PASS';
                                v_breach := NULL;
                            END IF;
                        ELSE
                            IF v_hard IS NOT NULL AND v_computed < v_hard THEN
                                v_status := 'HARD_BREACH';
                                v_breach := v_hard - v_computed;
                            ELSIF v_soft IS NOT NULL AND v_computed < v_soft THEN
                                v_status := 'SOFT_BREACH';
                                v_breach := v_soft - v_computed;
                            ELSE
                                v_status := 'PASS';
                                v_breach := NULL;
                            END IF;
                        END IF;
                    END IF;
                END IF;

                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_entity_ids, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_numerator, v_denominator, v_computed,
                    v_version.limit_direction, v_soft, v_hard,
                    v_status, v_breach, v_eligible_base_ids, COALESCE(array_length(v_eligible_base_ids, 1), 0),
                    v_detail || jsonb_build_object(
                        'assets', v_assets,
                        'debt', v_debt,
                        'addend', v_addend,
                        'book_coverage', CASE WHEN v_debt IS NULL OR v_debt = 0 THEN NULL ELSE v_assets / v_debt END,
                        'projected_coverage', v_computed
                    )
                );
                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
                CONTINUE;
            END IF;

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
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    NULL,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    v_version.limit_direction, v_soft, v_hard,
                    CASE WHEN v_pass_empty THEN 'PASS' ELSE 'NO_DATA' END,
                    0, v_detail || jsonb_build_object('empty', TRUE)
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            v_group_map := '{}'::JSONB;
            v_group_entities := '{}'::JSONB;

            IF v_version.group_by_attribute_code IS NULL THEN
                v_group_map := jsonb_build_object('__ALL__', to_jsonb(v_eligible_base_ids));
            ELSE
                FOR v_base_eid IN SELECT unnest(v_eligible_base_ids) LOOP
                    v_subject := NULL;
                    IF v_version.group_by_path IS NULL OR jsonb_array_length(v_version.group_by_path) = 0 THEN
                        v_subject := v_base_eid;
                        v_key := compliance.get_text_value_dim(v_base_eid, v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension);
                    ELSE
                        v_walked := compliance.walk_path(ARRAY[v_base_eid], v_version.group_by_path, p_as_of_date, p_knowledge_date);
                        IF v_walked IS NULL OR array_length(v_walked, 1) IS NULL THEN
                            v_subject := NULL;
                            v_key := NULL;
                        ELSE
                            v_subject := v_walked[1];
                            v_key := compliance.get_text_value_dim(v_subject, v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension);
                        END IF;
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

                    IF v_subject IS NOT NULL THEN
                        IF v_group_entities ? v_key THEN
                            v_group_entities := jsonb_set(
                                v_group_entities, ARRAY[v_key],
                                (v_group_entities -> v_key) || jsonb_build_array(v_subject::text)
                            );
                        ELSE
                            v_group_entities := jsonb_set(v_group_entities, ARRAY[v_key], jsonb_build_array(v_subject::text), TRUE);
                        END IF;
                    END IF;
                END LOOP;
            END IF;

            DELETE FROM compliance_eval_parts WHERE TRUE;

            FOR v_part IN
                SELECT *
                FROM compliance.grouped_ratio_parts(
                    v_group_map,
                    v_version.numerator_attribute_code,
                    v_version.numerator_aggregation,
                    v_version.numerator_dimension,
                    CASE WHEN v_version.denominator_source IN ('ANCHOR', 'GROUP') THEN NULL ELSE v_version.denominator_attribute_code END,
                    v_version.denominator_aggregation,
                    v_version.denominator_scope,
                    v_version.denominator_dimension,
                    v_version.denominator_constant_value,
                    p_as_of_date,
                    p_knowledge_date,
                    v_source_scope
                )
            LOOP
                v_key := v_part.group_key;
                v_numerator := v_part.numerator_value;
                v_denominator := v_part.denominator_value;
                IF v_version.denominator_source = 'ANCHOR' THEN
                    v_denominator := v_anc_den;
                END IF;
                IF v_version.denominator_source = 'GROUP' THEN
                    v_denominator := NULL;
                    IF v_group_entities ? v_key AND jsonb_array_length(v_group_entities -> v_key) > 0 THEN
                        SELECT MAX(g.val) INTO v_denominator
                        FROM compliance.get_numeric_values(
                            ARRAY(SELECT DISTINCT t.elem::UUID FROM jsonb_array_elements_text(v_group_entities -> v_key) AS t(elem)),
                            v_version.denominator_attribute_code,
                            v_den_dim.o_as_of, v_den_dim.o_knowledge, v_den_dim.o_source
                        ) AS g;
                    END IF;
                END IF;

                IF v_version.denominator_source IN ('ANCHOR', 'GROUP') AND COALESCE(v_denominator, 0) = 0 THEN
                    v_computed := NULL;
                ELSIF v_denominator IS NULL THEN
                    v_computed := v_numerator;
                ELSIF v_version.result_transform = 'DIFFERENCE' THEN
                    v_computed := v_numerator - v_denominator;
                ELSIF v_version.result_transform = 'ABS_DIFFERENCE' THEN
                    v_computed := abs(v_numerator - v_denominator);
                ELSIF v_denominator = 0 THEN
                    v_computed := NULL;
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

                INSERT INTO compliance_eval_parts (group_key, numerator, denominator, computed, contributing_ids)
                VALUES (v_key, v_numerator, v_denominator, v_computed, v_part.contributing_ids);
            END LOOP;

            v_excess := NULL;
            IF v_basket_group IS NOT NULL THEN
                SELECT COALESCE(SUM(GREATEST(p.computed - v_basket_group, 0)), 0)
                INTO v_excess
                FROM compliance_eval_parts p
                WHERE p.computed IS NOT NULL;
            END IF;

            FOR v_row IN
                SELECT p.*,
                       CASE
                           WHEN p.computed IS NULL THEN NULL
                           ELSE row_number() OVER (
                               ORDER BY
                                   CASE WHEN v_version.limit_direction = 'MIN' THEN p.computed END ASC NULLS LAST,
                                   CASE WHEN COALESCE(v_version.limit_direction, 'MAX') <> 'MIN' THEN p.computed END DESC NULLS LAST,
                                   p.group_key
                           )
                       END AS rank_pos
                FROM compliance_eval_parts p
            LOOP
                v_group_label := CASE WHEN v_row.group_key IN ('__ALL__', '__UNASSIGNED__') THEN NULL ELSE v_row.group_key END;
                SELECT * INTO v_limit
                FROM compliance.resolve_threshold(
                    v_rule.id, v_anchor.entity_id, v_group_label, v_row.rank_pos, p_as_of_date, v_soft, v_hard
                );

                IF NOT COALESCE(v_limit.applies, TRUE) THEN
                    CONTINUE;
                END IF;

                v_computed := v_row.computed;
                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_basket_group IS NOT NULL AND v_computed > v_basket_group THEN
                    IF v_basket_cap IS NOT NULL AND v_excess > v_basket_cap THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_basket_group;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                ELSIF v_version.limit_direction = 'MAX' THEN
                    IF v_limit.hard_limit IS NOT NULL AND v_computed > v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_limit.hard_limit;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed > v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_computed - v_limit.soft_limit;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                ELSE
                    IF v_limit.hard_limit IS NOT NULL AND v_computed < v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_limit.hard_limit - v_computed;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed < v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_limit.soft_limit - v_computed;
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
                    status, breach_amount, contributing_entity_ids, contributing_count,
                    rank_position, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, v_group_label,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_row.numerator, v_row.denominator, v_computed,
                    v_version.limit_direction, v_limit.soft_limit, v_limit.hard_limit,
                    v_status, v_breach, v_row.contributing_ids, array_length(v_row.contributing_ids, 1),
                    v_row.rank_pos,
                    v_detail || jsonb_build_object('rank', v_row.rank_pos, 'threshold_source', v_limit.source)
                    || CASE
                        WHEN v_version.limit_direction = 'MAX'
                         AND v_limit.hard_limit IS NOT NULL
                         AND v_row.denominator IS NOT NULL AND v_row.denominator <> 0
                         AND v_version.result_transform = 'NONE'
                         AND v_version.result_unit IN ('PERCENTAGE', 'RATIO')
                        THEN jsonb_build_object('excess_amount', GREATEST(
                            v_row.numerator - (v_limit.hard_limit / CASE WHEN v_version.result_unit = 'PERCENTAGE' THEN 100.0 ELSE 1.0 END) * v_row.denominator, 0))
                        ELSE '{}'::jsonb
                       END
                    || CASE
                        WHEN v_basket_group IS NULL THEN '{}'::jsonb
                        ELSE jsonb_build_object(
                            'basket_excess', v_excess,
                            'basket_limit', v_basket_cap,
                            'allowed_exception',
                            v_computed > v_basket_group AND NOT (v_basket_cap IS NOT NULL AND v_excess > v_basket_cap)
                        )
                       END
                );

                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
            END LOOP;

            IF v_basket_group IS NOT NULL THEN
                v_computed := v_excess;
                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_basket_cap IS NOT NULL AND v_computed > v_basket_cap THEN
                    v_status := 'HARD_BREACH';
                    v_breach := v_computed - v_basket_cap;
                ELSE
                    v_status := 'PASS';
                    v_breach := NULL;
                END IF;
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, 'Exception basket',
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_excess, NULL, v_computed,
                    'MAX', NULL, v_basket_cap,
                    v_status, v_breach, NULL,
                    v_detail || jsonb_build_object(
                        'basket_excess', v_excess,
                        'basket_limit', v_basket_cap,
                        'per_group_limit', v_basket_group
                    )
                );
                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
            END IF;
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
$function$;

GRANT EXECUTE ON FUNCTION compliance.evaluate_rule(character varying, date, timestamp with time zone, character varying, uuid, uuid, character varying) TO authenticated, service_role;

-- ============================================================
-- 4. Pre-trade maintain-or-improve
-- ============================================================
--
-- Runs each rule twice for one anchor: once on the booked portfolio and once
-- with the scenario (hypothetical positions tagged with p_scenario_code).
-- A buy is a hypothetical position with positive par. A sale is a hypothetical
-- position on the same security with negative par.
--
-- Verdicts (only a HARD_BREACH counts as a failed test):
--   PASS          passes before and after
--   NEW_BREACH    passed before, fails after          not approved
--   DETERIORATES  already failing and gets worse      not approved
--   MAINTAINS     already failing and unchanged       approved
--   IMPROVES      already failing and gets better     approved
--   CURED         failed before, passes after         approved
--   NO_DATA       the scenario could not be computed  not approved when the booked run had data
--   NO_CHANGE     the group left the portfolio        approved
-- "Worse" follows the limit direction: higher is worse for a MAX limit, lower
-- is worse for a MIN limit.

CREATE OR REPLACE FUNCTION compliance.evaluate_pre_trade(
    p_anchor_entity_id UUID,
    p_scenario_code VARCHAR,
    p_as_of_date DATE,
    p_rule_codes TEXT[] DEFAULT NULL,
    p_knowledge_date TIMESTAMPTZ DEFAULT now(),
    p_source_scope VARCHAR DEFAULT NULL
) RETURNS TABLE (
    rule_code VARCHAR,
    rule_name VARCHAR,
    group_by_value TEXT,
    limit_direction VARCHAR,
    baseline_value NUMERIC,
    scenario_value NUMERIC,
    baseline_status VARCHAR,
    scenario_status VARCHAR,
    verdict TEXT,
    approved BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_base_run UUID;
    v_scen_run UUID;
    v_row RECORD;
    v_bfail BOOLEAN;
    v_sfail BOOLEAN;
    v_verdict TEXT;
    v_ok BOOLEAN;
BEGIN
    IF p_scenario_code IS NULL OR btrim(p_scenario_code) = '' THEN
        RAISE EXCEPTION 'A pre-trade check needs a scenario code';
    END IF;

    FOR v_rule IN
        SELECT r.*
        FROM compliance.rules r
        WHERE r.is_active
          AND (p_rule_codes IS NULL OR r.rule_code = ANY(p_rule_codes))
        ORDER BY r.rule_code
    LOOP
        v_version := compliance.resolve_rule_version(v_rule.id, p_as_of_date, p_knowledge_date);
        IF v_version.id IS NULL THEN
            CONTINUE;
        END IF;
        IF p_rule_codes IS NULL AND COALESCE(v_version.metadata ->> 'pre_trade', '') <> 'true' THEN
            CONTINUE;
        END IF;

        v_base_run := compliance.evaluate_rule(v_rule.rule_code, p_as_of_date, p_knowledge_date, p_source_scope, NULL, p_anchor_entity_id, NULL);
        v_scen_run := compliance.evaluate_rule(v_rule.rule_code, p_as_of_date, p_knowledge_date, p_source_scope, NULL, p_anchor_entity_id, p_scenario_code);

        FOR v_row IN
            SELECT COALESCE(b.group_by_value, s.group_by_value) AS grp,
                   COALESCE(s.limit_direction, b.limit_direction) AS dir,
                   b.computed_value AS bv, s.computed_value AS sv,
                   b.status AS bs, s.status AS ss
            FROM (SELECT * FROM compliance.rule_evaluation_results
                  WHERE run_id = v_base_run AND anchor_entity_id = p_anchor_entity_id) b
            FULL JOIN (SELECT * FROM compliance.rule_evaluation_results
                       WHERE run_id = v_scen_run AND anchor_entity_id = p_anchor_entity_id) s
              ON COALESCE(b.group_by_value, '') = COALESCE(s.group_by_value, '')
        LOOP
            v_bfail := COALESCE(v_row.bs, '') = 'HARD_BREACH';
            v_sfail := COALESCE(v_row.ss, '') = 'HARD_BREACH';

            IF v_row.ss IS NULL THEN
                v_verdict := 'NO_CHANGE';
                v_ok := TRUE;
            ELSIF v_row.ss = 'NO_DATA' THEN
                v_verdict := 'NO_DATA';
                v_ok := COALESCE(v_row.bs, 'NO_DATA') = 'NO_DATA';
            ELSIF NOT v_sfail AND NOT v_bfail THEN
                v_verdict := 'PASS';
                v_ok := TRUE;
            ELSIF v_sfail AND NOT v_bfail THEN
                v_verdict := 'NEW_BREACH';
                v_ok := FALSE;
            ELSIF NOT v_sfail AND v_bfail THEN
                v_verdict := 'CURED';
                v_ok := TRUE;
            ELSIF v_row.bv IS NULL OR v_row.sv IS NULL OR v_row.sv = v_row.bv THEN
                v_verdict := 'MAINTAINS';
                v_ok := TRUE;
            ELSIF (v_row.dir = 'MAX' AND v_row.sv > v_row.bv) OR (v_row.dir = 'MIN' AND v_row.sv < v_row.bv) THEN
                v_verdict := 'DETERIORATES';
                v_ok := FALSE;
            ELSE
                v_verdict := 'IMPROVES';
                v_ok := TRUE;
            END IF;

            RETURN QUERY SELECT v_rule.rule_code::VARCHAR, v_version.rule_name::VARCHAR, v_row.grp::TEXT,
                                v_row.dir::VARCHAR, v_row.bv, v_row.sv,
                                v_row.bs::VARCHAR, v_row.ss::VARCHAR, v_verdict, v_ok;
        END LOOP;
    END LOOP;
END;
$function$;

COMMENT ON FUNCTION compliance.evaluate_pre_trade IS
    'Maintain-or-improve pre-trade check. Evaluates the pre_trade rules for one anchor with and without a scenario and reports a verdict per test and group.';

GRANT EXECUTE ON FUNCTION compliance.evaluate_pre_trade(UUID, VARCHAR, DATE, TEXT[], TIMESTAMPTZ, VARCHAR) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
