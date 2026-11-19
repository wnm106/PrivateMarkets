-- Covenant values on each borrower statement, for compliance.
--
-- Every STATEMENT_PERIOD gets a Covenant section: for each metric, the value
-- the deal's own definition gives for that quarter and the level in force on
-- that quarter end. Both are calculated attributes stored as golden values,
-- so any rule, report, or grid can read them like any other statement line.
--
-- The statement finds its covenant through the borrower:
--   statement -> issuer <- deal <- covenant (the one with the metric)
-- and the value is golden_master.covenant_evaluate on the statement's own
-- period end, so each quarter is tested under the definition in force then.
--
-- One compliance rule per metric is anchored on STATEMENT_PERIOD. It reads the
-- value as its numerator and the limit attribute as its hard limit, and tests
-- every quarter that has ended. These rules score every statement without
-- per-record enrollment rows: a rule whose metadata sets score_all_anchors
-- skips the fund-style enrollment check in compliance.evaluate_rule.

-- ============================================================
-- 1. The Covenant section and its attributes
-- ============================================================

INSERT INTO metadata_register.attribute_sections (domain_code, section_name, display_order, client_id)
SELECT 'STATEMENT_PERIOD', 'Covenant', 38, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM metadata_register.attribute_sections
    WHERE domain_code = 'STATEMENT_PERIOD' AND section_name = 'Covenant' AND client_id IS NULL
);

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension, metadata
)
SELECT v.code, v.name, v.dtype, v.descr, 'STATEMENT_PERIOD',
       FALSE, FALSE, 100,
       'Covenant', v.grp, FALSE, TRUE,
       FALSE, 'NONE',
       jsonb_build_object('covenantMetric', v.metric, 'covenantPart', v.part)
FROM (VALUES
    ('STATEMENT_COV_NET_LEVERAGE', 'Net Leverage (Agreement)', 'DECIMAL', 'Net leverage for this quarter under the deal''s own definition', 'NET_LEVERAGE', 'VALUE', 1),
    ('STATEMENT_COV_NET_LEVERAGE_LIMIT', 'Net Leverage Limit', 'DECIMAL', 'Maximum net leverage in force on this quarter end', 'NET_LEVERAGE', 'LIMIT', 2),
    ('STATEMENT_COV_TOTAL_LEVERAGE', 'Total Leverage (Agreement)', 'DECIMAL', 'Total leverage for this quarter under the deal''s own definition', 'TOTAL_LEVERAGE', 'VALUE', 3),
    ('STATEMENT_COV_TOTAL_LEVERAGE_LIMIT', 'Total Leverage Limit', 'DECIMAL', 'Maximum total leverage in force on this quarter end', 'TOTAL_LEVERAGE', 'LIMIT', 4),
    ('STATEMENT_COV_INTEREST_COVERAGE', 'Interest Coverage (Agreement)', 'DECIMAL', 'Interest coverage for this quarter under the deal''s own definition', 'INTEREST_COVERAGE', 'VALUE', 5),
    ('STATEMENT_COV_INTEREST_COVERAGE_LIMIT', 'Interest Coverage Minimum', 'DECIMAL', 'Minimum interest coverage in force on this quarter end', 'INTEREST_COVERAGE', 'LIMIT', 6),
    ('STATEMENT_COV_FIXED_CHARGE', 'Fixed Charge Coverage (Agreement)', 'DECIMAL', 'Fixed charge coverage for this quarter under the deal''s own definition', 'FIXED_CHARGE_COVERAGE', 'VALUE', 7),
    ('STATEMENT_COV_FIXED_CHARGE_LIMIT', 'Fixed Charge Coverage Minimum', 'DECIMAL', 'Minimum fixed charge coverage in force on this quarter end', 'FIXED_CHARGE_COVERAGE', 'LIMIT', 8),
    ('STATEMENT_COV_LIQUIDITY', 'Liquidity (Agreement)', 'CURRENCY', 'Liquidity at this quarter end under the deal''s own definition', 'LIQUIDITY', 'VALUE', 9),
    ('STATEMENT_COV_LIQUIDITY_LIMIT', 'Liquidity Minimum', 'CURRENCY', 'Minimum liquidity in force on this quarter end', 'LIQUIDITY', 'LIMIT', 10)
) AS v(code, name, dtype, descr, metric, part, grp)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    is_editable = EXCLUDED.is_editable,
    metadata = COALESCE(metadata_register.attribute_register.metadata, '{}'::jsonb) || EXCLUDED.metadata;

-- A covenant level can step down over time. Each quarter is tested against
-- the level in force on its quarter end.
UPDATE metadata_register.attribute_register
SET is_time_varying = TRUE,
    time_dimension = 'VALID_TIME',
    description = 'The covenant level. Enter a step-down as a new value from the date it takes effect.',
    updated_at = NOW()
WHERE attribute_code = 'COVENANT_LEVEL';

UPDATE metadata_register.attribute_register
SET description = 'Quarter end of the first test. Earlier quarters are shown for monitoring and are not scored.',
    updated_at = NOW()
WHERE attribute_code = 'COVENANT_FIRST_TEST';

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = 'STATEMENT_PERIOD_STANDARD'
WHERE a.attribute_code LIKE 'STATEMENT_COV_%'
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 2. Reading a statement's covenant
-- ============================================================

-- A number on a covenant on a date. Dated slices, such as a step-down, are
-- not stamped with the winning source, so this reads through golden_literal,
-- which falls back to the row valid on the date.
CREATE OR REPLACE FUNCTION golden_master.covenant_number(p_entity uuid, p_code text, p_as_of date)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
    SELECT CASE WHEN (v #>> '{}') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (v #>> '{}')::numeric END
    FROM (SELECT golden_master.golden_literal(p_entity, p_code::varchar, p_as_of) AS v) x;
$$;

-- The deal covenant with this metric on the statement's borrower.
CREATE OR REPLACE FUNCTION golden_master.statement_covenant(p_statement uuid, p_metric text, p_as_of date)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
    SELECT c.id
    FROM unnest(golden_master.related_ids(
        p_statement, 'DOWN', ARRAY['STATEMENT_ISSUER', '~DEAL_ISSUER', '~COVENANT_DEAL'], p_as_of
    )) AS r(id)
    JOIN entity_instances.master_entities c ON c.id = r.id AND c.is_active AND c.domain_code = 'DEAL_COVENANT'
    WHERE golden_master.covenant_text(c.id, 'COVENANT_METRIC', p_as_of) = p_metric
    ORDER BY c.entity_code
    LIMIT 1;
$$;

-- The value or the limit for one Covenant attribute on one statement. The
-- statement's own period end is the test date, whatever date the calc asks.
CREATE OR REPLACE FUNCTION golden_master.statement_covenant_value(p_attribute_id uuid, p_statement uuid, p_depth integer DEFAULT 0)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_meta jsonb;
    v_end date;
    v_covenant uuid;
BEGIN
    SELECT metadata INTO v_meta FROM metadata_register.attribute_register WHERE id = p_attribute_id;
    IF v_meta IS NULL OR NOT (v_meta ? 'covenantMetric') THEN
        RETURN NULL;
    END IF;

    v_end := golden_master.golden_date(p_statement, 'STATEMENT_END'::varchar, CURRENT_DATE);
    IF v_end IS NULL THEN
        RETURN NULL;
    END IF;

    v_covenant := golden_master.statement_covenant(p_statement, v_meta->>'covenantMetric', v_end);
    IF v_covenant IS NULL THEN
        RETURN NULL;
    END IF;

    -- Quarters before the first test have a value to monitor but no limit,
    -- so compliance does not score them.
    IF v_meta->>'covenantPart' = 'LIMIT' THEN
        IF golden_master.golden_date(v_covenant, 'COVENANT_FIRST_TEST'::varchar, v_end) > v_end THEN
            RETURN NULL;
        END IF;
        RETURN golden_master.covenant_number(v_covenant, 'COVENANT_LEVEL', v_end);
    END IF;
    RETURN (golden_master.covenant_evaluate(v_covenant, v_covenant, v_end, p_depth + 1)->>'value')::numeric;
END;
$$;

-- eval_calc: a DEFINITION calc on a statement reads its covenant section.
CREATE OR REPLACE FUNCTION golden_master.eval_calc(p_calc_id uuid, p_entity_id uuid, p_as_of date, p_depth integer DEFAULT 0)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'golden_master', 'metadata_register', 'entity_instances', 'public', 'pg_temp'
AS $function$
DECLARE
    v_def metadata_register.calc_definitions%ROWTYPE;
    v_input metadata_register.calc_inputs%ROWTYPE;
    v_result JSONB;
    v_ids UUID[];
    v_entity UUID;
    v_value NUMERIC;
    v_weight NUMERIC;
    v_weighted NUMERIC := 0;
    v_weight_sum NUMERIC := 0;
    v_sum NUMERIC := 0;
    v_min NUMERIC;
    v_max NUMERIC;
    v_count INTEGER := 0;
    v_dates DATE[] := '{}';
    v_amounts NUMERIC[] := '{}';
    v_amount_code VARCHAR(100);
    v_date_code VARCHAR(100);
    v_terminal_code VARCHAR(100);
    v_path TEXT[];
    v_traversal TEXT;
    v_flow_date DATE;
    v_amount NUMERIC;
    v_terminal NUMERIC;
    v_weight_code VARCHAR(100);
BEGIN
    IF p_depth > 8 THEN
        RETURN NULL;
    END IF;

    SELECT * INTO v_def FROM metadata_register.calc_definitions WHERE id = p_calc_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- DEFINITION: the entity's own component records are the formula.
    IF v_def.calc_kind = 'DEFINITION' THEN
        IF v_def.domain_code = 'STATEMENT_PERIOD' THEN
            RETURN golden_master.statement_covenant_value(v_def.attribute_id, p_entity_id, p_depth + 1);
        END IF;
        RETURN (golden_master.covenant_evaluate(p_entity_id, p_entity_id, p_as_of, p_depth + 1)->>'value')::NUMERIC;
    END IF;

    IF v_def.calc_kind = 'EXPRESSION' THEN
        v_result := golden_master.eval_expression_result(p_calc_id, p_entity_id, p_as_of, p_depth);
        IF v_result IS NULL OR jsonb_typeof(v_result) = 'null' THEN
            RETURN NULL;
        END IF;
        IF jsonb_typeof(v_result) = 'number'
           OR (jsonb_typeof(v_result) = 'string' AND (v_result #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$') THEN
            RETURN (v_result #>> '{}')::NUMERIC;
        END IF;
        RETURN NULL;
    END IF;

    IF v_def.calc_kind = 'AGGREGATE' THEN
        SELECT * INTO v_input
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = p_calc_id AND input_role = 'MEASURE'
        LIMIT 1;
        v_ids := golden_master.related_ids(p_entity_id, v_input.traversal, v_input.relationship_codes, p_as_of);

        SELECT attribute_code INTO v_weight_code
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = p_calc_id AND input_role = 'WEIGHT'
        LIMIT 1;

        FOREACH v_entity IN ARRAY v_ids LOOP
            v_value := golden_master.golden_numeric(v_entity, v_input.attribute_code, p_as_of, p_depth + 1);
            IF v_value IS NULL THEN
                CONTINUE;
            END IF;
            v_count := v_count + 1;
            v_sum := v_sum + v_value;
            v_min := LEAST(COALESCE(v_min, v_value), v_value);
            v_max := GREATEST(COALESCE(v_max, v_value), v_value);
            IF v_def.aggregate_fn = 'WAVG' THEN
                v_weight := golden_master.golden_numeric(v_entity, v_weight_code, p_as_of, p_depth + 1);
                IF v_weight IS NOT NULL THEN
                    v_weighted := v_weighted + (v_value * v_weight);
                    v_weight_sum := v_weight_sum + v_weight;
                END IF;
            END IF;
        END LOOP;

        IF v_count = 0 THEN
            RETURN NULL;
        END IF;
        IF v_def.aggregate_fn = 'SUM' THEN
            RETURN v_sum;
        ELSIF v_def.aggregate_fn = 'MIN' THEN
            RETURN v_min;
        ELSIF v_def.aggregate_fn = 'MAX' THEN
            RETURN v_max;
        ELSIF v_def.aggregate_fn = 'WAVG' THEN
            IF v_weight_sum = 0 THEN
                RETURN NULL;
            END IF;
            RETURN v_weighted / v_weight_sum;
        END IF;
        RETURN NULL;
    END IF;

    -- SERIES: the same function answers a stored window and a query-time period.
    RETURN golden_master.series_value(
        p_calc_id, p_entity_id,
        golden_master.series_window_start(v_def.series_window, p_as_of), p_as_of,
        v_def.series_fn, p_depth
    );
END;
$function$;

-- ============================================================
-- 3. The calcs
-- ============================================================

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain
)
-- The value does not depend on the date the calc asks about, so a year-end
-- grain keeps queued refreshes cheap. ON_INPUT_CHANGE would scan every input
-- on every related record to find change dates.
SELECT a.id, 'STATEMENT_PERIOD', 'DEFINITION', 'MATERIALIZED', 'FORWARD', 'YEAR_END'
FROM metadata_register.attribute_register a
WHERE a.attribute_code LIKE 'STATEMENT_COV_%'
ON CONFLICT (attribute_id) DO UPDATE
SET calc_kind = EXCLUDED.calc_kind,
    evaluation_mode = EXCLUDED.evaluation_mode,
    time_impact = EXCLUDED.time_impact,
    output_grain = EXCLUDED.output_grain,
    expression = NULL,
    updated_at = NOW();

-- Inputs drive invalidation: the borrower's other quarters, the covenant's
-- level and metric, and its definition lines.
INSERT INTO metadata_register.calc_inputs (calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal)
SELECT cd.id, 'OPERAND', v.code, 'DOWN', v.codes, v.ord
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register a ON a.id = cd.attribute_id AND a.attribute_code LIKE 'STATEMENT_COV_%'
CROSS JOIN (VALUES
    ('COVENANT_LEVEL', ARRAY['STATEMENT_ISSUER', '~DEAL_ISSUER', '~COVENANT_DEAL'], 1),
    ('COVENANT_METRIC', ARRAY['STATEMENT_ISSUER', '~DEAL_ISSUER', '~COVENANT_DEAL'], 2),
    ('COMPONENT_SIDE', ARRAY['STATEMENT_ISSUER', '~DEAL_ISSUER', '~COVENANT_DEAL', '~COMPONENT_COVENANT'], 3),
    ('COMPONENT_LINE', ARRAY['STATEMENT_ISSUER', '~DEAL_ISSUER', '~COVENANT_DEAL', '~COMPONENT_COVENANT'], 4),
    ('COMPONENT_SIGN', ARRAY['STATEMENT_ISSUER', '~DEAL_ISSUER', '~COVENANT_DEAL', '~COMPONENT_COVENANT'], 5),
    ('COMPONENT_MEASURE', ARRAY['STATEMENT_ISSUER', '~DEAL_ISSUER', '~COVENANT_DEAL', '~COMPONENT_COVENANT'], 6),
    ('COMPONENT_CAP_TYPE', ARRAY['STATEMENT_ISSUER', '~DEAL_ISSUER', '~COVENANT_DEAL', '~COMPONENT_COVENANT'], 7),
    ('COMPONENT_CAP_VALUE', ARRAY['STATEMENT_ISSUER', '~DEAL_ISSUER', '~COVENANT_DEAL', '~COMPONENT_COVENANT'], 8),
    ('COMPONENT_EFFECTIVE_FROM', ARRAY['STATEMENT_ISSUER', '~DEAL_ISSUER', '~COVENANT_DEAL', '~COMPONENT_COVENANT'], 9),
    ('COMPONENT_EFFECTIVE_TO', ARRAY['STATEMENT_ISSUER', '~DEAL_ISSUER', '~COVENANT_DEAL', '~COMPONENT_COVENANT'], 10),
    ('STATEMENT_END', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 20),
    ('STATEMENT_REVENUE', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 21),
    ('STATEMENT_COGS', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 22),
    ('STATEMENT_SM', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 23),
    ('STATEMENT_RD', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 24),
    ('STATEMENT_GA', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 25),
    ('STATEMENT_DA', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 26),
    ('STATEMENT_INTEREST', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 27),
    ('STATEMENT_TAX', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 28),
    ('STATEMENT_CASH', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 29),
    ('STATEMENT_DEBT', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 30),
    ('STATEMENT_PPE', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 31),
    ('STATEMENT_RESTRICTED_CASH', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 32),
    ('STATEMENT_LC_OUTSTANDING', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 33),
    ('STATEMENT_RESTRUCTURING', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 34),
    ('STATEMENT_TRANSACTION_COSTS', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 35),
    ('STATEMENT_STOCK_COMP', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 36),
    ('STATEMENT_PF_SYNERGIES', ARRAY['STATEMENT_ISSUER', '~STATEMENT_ISSUER'], 37)
) AS v(code, codes, ord)
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO UPDATE
SET traversal = EXCLUDED.traversal,
    relationship_codes = EXCLUDED.relationship_codes,
    ordinal = EXCLUDED.ordinal;

-- ============================================================
-- 4. Recalculating a covenant also refreshes its borrower's statements
-- ============================================================

-- Writes the whole Covenant section of one statement as a single slice and
-- closes any queued jobs for it. The value is the same on every date, so one
-- slice from 2020 is the full history.
CREATE OR REPLACE FUNCTION golden_master.refresh_statement_covenants(p_statement uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_calc RECORD;
    v_value numeric;
    v_written integer := 0;
BEGIN
    FOR v_calc IN
        SELECT cd.attribute_id
        FROM metadata_register.calc_definitions cd
        JOIN metadata_register.attribute_register a ON a.id = cd.attribute_id
        WHERE a.attribute_code LIKE 'STATEMENT_COV_%'
    LOOP
        v_value := golden_master.statement_covenant_value(v_calc.attribute_id, p_statement, 0);
        IF v_value IS NOT NULL OR EXISTS (
            SELECT 1 FROM golden_master.entity_attribute_values eav
            WHERE eav.entity_id = p_statement AND eav.attribute_id = v_calc.attribute_id
              AND eav.system_to = golden_master.open_system_to()
        ) THEN
            PERFORM golden_master.write_derived_slices(p_statement, v_calc.attribute_id, jsonb_build_array(jsonb_build_object(
                'valid_from', DATE '2020-01-01', 'valid_to', DATE '9999-12-31', 'value', v_value
            )));
            v_written := v_written + 1;
        END IF;
        UPDATE golden_master.calc_invalidations
        SET status = 'DONE', finished_at = clock_timestamp()
        WHERE entity_id = p_statement
          AND calc_attribute_id = v_calc.attribute_id
          AND status = 'PENDING';
    END LOOP;
    RETURN v_written;
END;
$$;

CREATE OR REPLACE FUNCTION public.recalculate_covenant(p_covenant_id uuid, p_from date DEFAULT DATE '2024-01-01')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_attr uuid;
    v_result jsonb;
    v_statement uuid;
    v_refreshed integer := 0;
BEGIN
    IF NOT tenancy.has_entity_access(p_covenant_id, 'WRITE') THEN
        RAISE EXCEPTION 'You cannot change this covenant';
    END IF;
    SELECT id INTO v_attr FROM metadata_register.attribute_register WHERE attribute_code = 'COVENANT_CURRENT';
    PERFORM golden_master.enqueue_calc(v_attr, p_covenant_id, COALESCE(p_from, DATE '2024-01-01'), DATE '9999-12-31', NULL, NULL, NULL);
    v_result := golden_master.process_calc_invalidations(200, p_covenant_id);

    FOR v_statement IN
        SELECT unnest(golden_master.related_ids(
            p_covenant_id, 'DOWN', ARRAY['COVENANT_DEAL', 'DEAL_ISSUER', '~STATEMENT_ISSUER'], CURRENT_DATE
        ))
    LOOP
        PERFORM golden_master.refresh_statement_covenants(v_statement);
        v_refreshed := v_refreshed + 1;
    END LOOP;

    RETURN COALESCE(v_result, '{}'::jsonb) || jsonb_build_object('statementsRefreshed', v_refreshed);
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_covenant(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recalculate_covenant(uuid, date) TO authenticated, service_role;

-- ============================================================
-- 5. Rules that score every anchor
-- ============================================================

-- evaluate_rule is unchanged except for the score_all_anchors check.
CREATE OR REPLACE FUNCTION compliance.evaluate_rule(p_rule_code character varying, p_as_of_date date, p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying, p_triggered_by uuid DEFAULT NULL::uuid, p_anchor_entity_id uuid DEFAULT NULL::uuid, p_scenario_code character varying DEFAULT NULL::character varying)
 RETURNS uuid
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
    v_meta := compliance.overlay_measure_lines(v_version.id, COALESCE(v_version.metadata, '{}'::jsonb));
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

            -- fund_threshold_enrollment: the test can cover every fund, but it
            -- runs only for a fund with its own applies threshold.
            SELECT NOT EXISTS (
                SELECT 1
                FROM compliance.rule_thresholds t
                WHERE t.rule_id = v_rule.id
                  AND t.entity_id = v_anchor.entity_id
                  AND t.group_value IS NULL
                  AND t.rank_from IS NULL
                  AND t.rank_to IS NULL
                  AND t.applies = TRUE
                  AND t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
            ) INTO v_opt_out;
            -- test_all_funds: a test run covers funds that have no threshold yet.
            -- score_all_anchors: a rule on records that are not funds, such as
            -- statement periods, scores every anchor without enrollment rows.
            IF v_opt_out AND COALESCE(current_setting('compliance.test_all_funds', TRUE), '') <> 'on'
               AND NOT COALESCE((v_meta->>'score_all_anchors')::BOOLEAN, FALSE) THEN
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

-- ============================================================
-- 6. Compliance rules on the statement's Covenant section
-- ============================================================

INSERT INTO compliance.rules (rule_code, rule_name, rule_category, anchor_domain_code, applies_to_all, is_active, description)
VALUES
    ('COV_NET_LEVERAGE', 'Covenant: Net Leverage', 'LEVERAGE', 'STATEMENT_PERIOD', TRUE, TRUE,
     'Each borrower quarter''s net leverage under its deal''s definition, against the maximum in force that quarter. Watch within 10% of the limit.'),
    ('COV_TOTAL_LEVERAGE', 'Covenant: Total Leverage', 'LEVERAGE', 'STATEMENT_PERIOD', TRUE, TRUE,
     'Each borrower quarter''s total leverage under its deal''s definition, against the maximum in force that quarter. Watch within 10% of the limit.'),
    ('COV_INTEREST_COVERAGE', 'Covenant: Interest Coverage', 'OTHER', 'STATEMENT_PERIOD', TRUE, TRUE,
     'Each borrower quarter''s interest coverage under its deal''s definition, against the minimum in force that quarter.'),
    ('COV_FIXED_CHARGE', 'Covenant: Fixed Charge Coverage', 'OTHER', 'STATEMENT_PERIOD', TRUE, TRUE,
     'Each borrower quarter''s fixed charge coverage under its deal''s definition, against the minimum in force that quarter.'),
    ('COV_LIQUIDITY', 'Covenant: Minimum Liquidity', 'LIQUIDITY', 'STATEMENT_PERIOD', TRUE, TRUE,
     'Each borrower quarter''s liquidity under its deal''s definition, against the minimum in force that quarter.')
ON CONFLICT (rule_code) DO UPDATE
SET rule_name = EXCLUDED.rule_name,
    rule_category = EXCLUDED.rule_category,
    anchor_domain_code = EXCLUDED.anchor_domain_code,
    description = EXCLUDED.description;

INSERT INTO compliance.rule_versions (
    rule_id, version_number, valid_from, rule_name, description, base_domain_code,
    base_rollup_path, group_by_path, group_by_attribute_code,
    numerator_attribute_code, numerator_aggregation,
    denominator_attribute_code, denominator_aggregation, denominator_scope,
    limit_direction, soft_limit_value, hard_limit_value, result_unit,
    hard_limit_attribute_code, soft_limit_factor, metadata, change_reason
)
SELECT r.id, 1, DATE '2020-01-01', r.rule_name, r.description, 'STATEMENT_PERIOD',
       '[]'::jsonb, '[]'::jsonb, NULL,
       v.num_attr, 'VALUE',
       NULL, NULL, 'SAME_GROUP',
       v.direction, NULL, NULL, v.unit,
       v.limit_attr, v.soft_factor, '{"score_all_anchors": true}'::jsonb,
       'Statement covenant section'
FROM compliance.rules r
JOIN (VALUES
    ('COV_NET_LEVERAGE', 'STATEMENT_COV_NET_LEVERAGE', 'STATEMENT_COV_NET_LEVERAGE_LIMIT', 'MAX', 'RATIO', 0.9::numeric),
    ('COV_TOTAL_LEVERAGE', 'STATEMENT_COV_TOTAL_LEVERAGE', 'STATEMENT_COV_TOTAL_LEVERAGE_LIMIT', 'MAX', 'RATIO', 0.9::numeric),
    ('COV_INTEREST_COVERAGE', 'STATEMENT_COV_INTEREST_COVERAGE', 'STATEMENT_COV_INTEREST_COVERAGE_LIMIT', 'MIN', 'RATIO', NULL::numeric),
    ('COV_FIXED_CHARGE', 'STATEMENT_COV_FIXED_CHARGE', 'STATEMENT_COV_FIXED_CHARGE_LIMIT', 'MIN', 'RATIO', NULL::numeric),
    ('COV_LIQUIDITY', 'STATEMENT_COV_LIQUIDITY', 'STATEMENT_COV_LIQUIDITY_LIMIT', 'MIN', 'CURRENCY', NULL::numeric)
) AS v(code, num_attr, limit_attr, direction, unit, soft_factor) ON v.code = r.rule_code
WHERE NOT EXISTS (SELECT 1 FROM compliance.rule_versions rv WHERE rv.rule_id = r.id);

-- Score quarters that have ended, that have a covenant of this metric, and
-- that are on or after the covenant's first test (the limit is blank before).
INSERT INTO compliance.rule_conditions (rule_version_id, applies_to, condition_group, condition_order, attribute_code, operator, value, logic_operator)
SELECT rv.id, 'ANCHOR', 1, c.ord, c.attr, c.op, c.val, 'AND'
FROM compliance.rules r
JOIN compliance.rule_versions rv ON rv.rule_id = r.id AND rv.version_number = 1
CROSS JOIN LATERAL (VALUES
    (1, rv.numerator_attribute_code, 'is_not_null', NULL::text),
    (2, rv.hard_limit_attribute_code, 'is_not_null', NULL::text),
    (3, 'STATEMENT_END', 'lte', 'CURRENT_DATE')
) AS c(ord, attr, op, val)
WHERE r.rule_code IN ('COV_NET_LEVERAGE', 'COV_TOTAL_LEVERAGE', 'COV_INTEREST_COVERAGE', 'COV_FIXED_CHARGE', 'COV_LIQUIDITY')
  AND NOT EXISTS (SELECT 1 FROM compliance.rule_conditions x WHERE x.rule_version_id = rv.id);

-- ============================================================
-- 7. History shows the level in force each quarter
-- ============================================================

CREATE OR REPLACE FUNCTION golden_master.covenant_summary(p_covenant uuid, p_as_of date, p_history integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_entity entity_instances.master_entities%ROWTYPE;
    v_own jsonb;
    v_house uuid;
    v_house_result jsonb;
    v_history jsonb := '[]'::jsonb;
    v_reported jsonb;
    v_deal RECORD;
    v_quarter date;
    v_k integer;
BEGIN
    SELECT * INTO v_entity FROM entity_instances.master_entities WHERE id = p_covenant AND domain_code = 'DEAL_COVENANT';
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_own := golden_master.covenant_evaluate(p_covenant, p_covenant, p_as_of, 0);
    v_house := golden_master.covenant_house(p_covenant, p_as_of);
    IF v_house IS NOT NULL AND v_house <> p_covenant THEN
        v_house_result := golden_master.covenant_evaluate(v_house, p_covenant, p_as_of, 0);
    END IF;

    SELECT d.id, d.entity_name INTO v_deal
    FROM unnest(golden_master.related_ids(p_covenant, 'DOWN', ARRAY['COVENANT_DEAL'], p_as_of)) AS r(id)
    JOIN entity_instances.master_entities d ON d.id = r.id
    LIMIT 1;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'sourceCode', sr.source_code,
               'sourceName', sr.source_name,
               'value', eav.golden_value_numeric,
               'validFrom', eav.valid_from
           ) ORDER BY sr.precedence_rank, sr.source_code), '[]'::jsonb)
      INTO v_reported
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id AND ar.attribute_code = 'COVENANT_CURRENT'
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE eav.entity_id = p_covenant
      AND sr.source_code NOT IN ('DERIVED', 'CALCULATED')
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND eav.system_to = golden_master.open_system_to();

    FOR v_k IN 0..GREATEST(COALESCE(p_history, 0), 0) - 1 LOOP
        v_quarter := (date_trunc('quarter', p_as_of + 1) - make_interval(months => 3 * v_k) - INTERVAL '1 day')::date;
        v_history := jsonb_build_array(jsonb_build_object(
            'testDate', v_quarter,
            'value', golden_master.covenant_evaluate(p_covenant, p_covenant, v_quarter, 0)->'value',
            'house', CASE WHEN v_house IS NOT NULL AND v_house <> p_covenant
                          THEN golden_master.covenant_evaluate(v_house, p_covenant, v_quarter, 0)->'value' END,
            'level', golden_master.covenant_number(p_covenant, 'COVENANT_LEVEL', v_quarter),
            'tested', COALESCE(golden_master.golden_date(p_covenant, 'COVENANT_FIRST_TEST'::varchar, v_quarter) <= v_quarter, TRUE)
        )) || v_history;
    END LOOP;

    RETURN v_own || jsonb_build_object(
        'covenantId', v_entity.id,
        'code', v_entity.entity_code,
        'name', v_entity.entity_name,
        'dealId', v_deal.id,
        'dealName', v_deal.entity_name,
        'metric', golden_master.covenant_text(p_covenant, 'COVENANT_METRIC', p_as_of),
        'direction', golden_master.covenant_text(p_covenant, 'COVENANT_DIRECTION', p_as_of),
        'unit', golden_master.covenant_text(p_covenant, 'COVENANT_UNIT', p_as_of),
        'level', golden_master.covenant_number(p_covenant, 'COVENANT_LEVEL', p_as_of),
        'firstTest', golden_master.golden_date(p_covenant, 'COVENANT_FIRST_TEST'::varchar, p_as_of),
        'isLibrary', lower(COALESCE(golden_master.covenant_text(p_covenant, 'COVENANT_IS_LIBRARY', p_as_of), 'false')) = 'true',
        'isHouse', lower(COALESCE(golden_master.covenant_text(p_covenant, 'COVENANT_IS_HOUSE', p_as_of), 'false')) = 'true',
        'stored', golden_master.golden_numeric(p_covenant, 'COVENANT_CURRENT'::varchar, p_as_of, 0),
        'houseId', v_house,
        'houseName', (SELECT entity_name FROM entity_instances.master_entities WHERE id = v_house),
        'house', v_house_result->'value',
        'reported', v_reported,
        'history', v_history
    );
END;
$$;

NOTIFY pgrst, 'reload schema';
