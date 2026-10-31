-- Compliance rules can read a denominator and a limit from the anchor entity.
--
--   denominator_source = 'ANCHOR'
--       The denominator is denominator_attribute_code read on the anchor itself
--       (a fund's NAV), not an aggregate of the base entities. An anchor with no
--       value, or zero, yields NO_DATA instead of an unscaled number.
--   hard_limit_attribute_code, soft_limit_factor
--       The hard limit is read from an attribute on the anchor, so each fund can
--       carry its own limit. The soft limit is the hard limit times the factor.
--       An anchor without the attribute falls back to the rule's constants.
--
-- Existing rules are unchanged: denominator_source defaults to 'BASE' and the
-- new limit columns are null.

ALTER TABLE compliance.rule_versions
    ADD COLUMN IF NOT EXISTS denominator_source VARCHAR(10) NOT NULL DEFAULT 'BASE',
    ADD COLUMN IF NOT EXISTS hard_limit_attribute_code VARCHAR(100),
    ADD COLUMN IF NOT EXISTS soft_limit_factor NUMERIC;

ALTER TABLE compliance.rule_versions DROP CONSTRAINT IF EXISTS rule_versions_denominator_source_check;
ALTER TABLE compliance.rule_versions
    ADD CONSTRAINT rule_versions_denominator_source_check CHECK (denominator_source IN ('BASE', 'ANCHOR'));
ALTER TABLE compliance.rule_versions DROP CONSTRAINT IF EXISTS rule_versions_soft_limit_factor_check;
ALTER TABLE compliance.rule_versions
    ADD CONSTRAINT rule_versions_soft_limit_factor_check CHECK (soft_limit_factor IS NULL OR (soft_limit_factor > 0 AND soft_limit_factor <= 1));

COMMENT ON COLUMN compliance.rule_versions.denominator_source IS 'BASE = aggregate the denominator attribute over the base entities (default). ANCHOR = read the denominator attribute on the anchor entity.';
COMMENT ON COLUMN compliance.rule_versions.hard_limit_attribute_code IS 'Attribute on the anchor that supplies the hard limit, in the rule''s result unit. Falls back to hard_limit_value when the anchor has no value.';
COMMENT ON COLUMN compliance.rule_versions.soft_limit_factor IS 'When the hard limit comes from the anchor, the soft limit is the hard limit times this factor (0 to 1).';

CREATE OR REPLACE FUNCTION compliance.evaluate_rule(p_rule_code character varying, p_as_of_date date, p_knowledge_date timestamp with time zone DEFAULT now(), p_source_scope character varying DEFAULT NULL::character varying, p_triggered_by uuid DEFAULT NULL::uuid)
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
    v_part RECORD;
    v_num_dim RECORD;
    v_den_dim RECORD;
    v_detail JSONB;
    v_hard NUMERIC;
    v_soft NUMERIC;
    v_lim NUMERIC;
    v_anc_den NUMERIC;
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

            -- Limits: the rule's constants, unless a limit attribute on the anchor supplies the hard limit.
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

            -- Denominator read from the anchor itself (for example a fund's NAV).
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
                    v_version.limit_direction, v_soft, v_hard,
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
                    v_version.limit_direction, v_soft, v_hard,
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

            FOR v_part IN
                SELECT *
                FROM compliance.grouped_ratio_parts(
                    v_group_map,
                    v_version.numerator_attribute_code,
                    v_version.numerator_aggregation,
                    v_version.numerator_dimension,
                    CASE WHEN v_version.denominator_source = 'ANCHOR' THEN NULL ELSE v_version.denominator_attribute_code END,
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
                v_key_ids := v_part.contributing_ids;
                v_numerator := v_part.numerator_value;
                v_denominator := v_part.denominator_value;
                IF v_version.denominator_source = 'ANCHOR' THEN
                    v_denominator := v_anc_den;
                END IF;

                IF v_version.denominator_source = 'ANCHOR' AND COALESCE(v_denominator, 0) = 0 THEN
                    v_computed := NULL; -- the anchor has no usable denominator
                ELSIF v_denominator IS NULL THEN
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
                ELSE -- MIN
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
                    v_version.limit_direction, v_soft, v_hard,
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
$function$;

-- The pro forma rules measure against each fund's NAV and its own limits.
UPDATE compliance.rule_versions rv
SET denominator_attribute_code = 'NAV',
    denominator_aggregation = 'VALUE',
    denominator_scope = 'SAME_GROUP',
    denominator_source = 'ANCHOR',
    hard_limit_attribute_code = v.limit_attr,
    soft_limit_factor = 0.8
FROM compliance.rules r
JOIN (VALUES
    ('PF_ISSUER_CONCENTRATION', 'FUND_SINGLE_ISSUER_LIMIT_PCT'),
    ('PF_SPONSOR_CONCENTRATION', 'FUND_SPONSOR_LIMIT_PCT'),
    ('PF_UNFUNDED_COMMITMENTS', 'FUND_UNFUNDED_LIMIT_PCT')
) AS v(code, limit_attr) ON v.code = r.rule_code
WHERE rv.rule_id = r.id AND rv.version_number = 1;

UPDATE compliance.rules
SET description = replace(replace(description, 'fund position market value', 'fund NAV'), 'a fund''s position market value', 'a fund''s NAV')
WHERE rule_code IN ('PF_ISSUER_CONCENTRATION', 'PF_SPONSOR_CONCENTRATION', 'PF_UNFUNDED_COMMITMENTS');

UPDATE compliance.rule_versions rv
SET description = replace(replace(rv.description, 'fund position market value', 'fund NAV'), 'a fund''s position market value', 'a fund''s NAV')
FROM compliance.rules r
WHERE rv.rule_id = r.id AND r.rule_code IN ('PF_ISSUER_CONCENTRATION', 'PF_SPONSOR_CONCENTRATION', 'PF_UNFUNDED_COMMITMENTS');

NOTIFY pgrst, 'reload schema';
