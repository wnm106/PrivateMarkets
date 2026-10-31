-- Each field reference can name the date it is read on.
-- QUANTITY AS OF PRIOR_MONTH_END reads quantity on the last day of the month
-- before the expression's as-of date. Another reference in the same expression
-- stays on the as-of date unless it names its own period.

CREATE OR REPLACE FUNCTION metadata_register.eval_as_of_date(p_expr JSONB, p_as_of DATE, p_vars JSONB)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
    v_fn TEXT;
    v_child JSONB;
    v_text TEXT;
BEGIN
    IF p_expr IS NULL OR jsonb_typeof(p_expr) = 'null' THEN
        RETURN NULL;
    END IF;
    IF p_expr ? 'fn' THEN
        v_fn := upper(p_expr->>'fn');
        IF COALESCE(jsonb_array_length(p_expr->'args'), 0) = 0 THEN
            IF v_fn = 'PRIOR_MONTH_END' THEN
                RETURN (date_trunc('month', p_as_of) - INTERVAL '1 day')::DATE;
            ELSIF v_fn = 'PRIOR_QUARTER_END' THEN
                RETURN (date_trunc('quarter', p_as_of) - INTERVAL '1 day')::DATE;
            ELSIF v_fn = 'PRIOR_YEAR_END' THEN
                RETURN (date_trunc('year', p_as_of) - INTERVAL '1 day')::DATE;
            ELSIF v_fn = 'MONTH_END' THEN
                RETURN (date_trunc('month', p_as_of) + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
            ELSIF v_fn = 'QUARTER_END' THEN
                RETURN (date_trunc('quarter', p_as_of) + INTERVAL '3 months' - INTERVAL '1 day')::DATE;
            ELSIF v_fn = 'YEAR_END' THEN
                RETURN (date_trunc('year', p_as_of) + INTERVAL '1 year' - INTERVAL '1 day')::DATE;
            END IF;
        END IF;
    END IF;
    v_child := metadata_register.eval_expr(
        p_expr,
        COALESCE(p_vars, '{}'::JSONB) || jsonb_build_object('CURRENT_DATE', to_jsonb(p_as_of::TEXT))
    );
    IF v_child IS NULL OR jsonb_typeof(v_child) = 'null' THEN
        RETURN NULL;
    END IF;
    v_text := v_child #>> '{}';
    RETURN v_text::DATE;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION metadata_register.as_of_expr(p_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_text TEXT := upper(btrim(COALESCE(p_text, '')));
    v_match TEXT[];
BEGIN
    IF v_text IN ('PRIOR_MONTH_END', 'PRIOR_QUARTER_END', 'PRIOR_YEAR_END', 'MONTH_END', 'QUARTER_END', 'YEAR_END') THEN
        RETURN jsonb_build_object('fn', v_text, 'args', '[]'::JSONB);
    END IF;
    v_match := regexp_match(
        v_text,
        '^(PREVIOUS_DAY|START_OF_MONTH|END_OF_MONTH|START_OF_QUARTER|END_OF_QUARTER|START_OF_YEAR|END_OF_YEAR)[[:space:]]*\([[:space:]]*(CURRENT_DATE|[A-Z_][A-Z0-9_]*)[[:space:]]*\)$'
    );
    IF v_match IS NOT NULL THEN
        RETURN jsonb_build_object('fn', v_match[1], 'args', jsonb_build_array(jsonb_build_object('ref', v_match[2])));
    END IF;
    IF v_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN jsonb_build_object('const', v_text);
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.rewrite_as_of(
    p_expr JSONB,
    p_entity_id UUID,
    p_calc_id UUID,
    p_as_of DATE,
    p_depth INTEGER,
    p_vars JSONB
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $$
DECLARE
    v_vars JSONB := COALESCE(p_vars, '{}'::JSONB);
    v_args JSONB := '[]'::JSONB;
    v_index INTEGER;
    v_step JSONB;
    v_date DATE;
    v_code TEXT;
    v_key TEXT;
    v_entity UUID;
    v_input metadata_register.calc_inputs%ROWTYPE;
    v_literal JSONB;
BEGIN
    IF p_expr IS NULL OR jsonb_typeof(p_expr) <> 'object' THEN
        RETURN jsonb_build_object('expr', p_expr, 'vars', v_vars);
    END IF;

    IF p_expr ? 'ref' AND p_expr ? 'asOf' THEN
        v_step := golden_master.rewrite_as_of(p_expr->'asOf', p_entity_id, p_calc_id, p_as_of, p_depth, v_vars);
        v_vars := v_step->'vars';
        v_date := metadata_register.eval_as_of_date(v_step->'expr', p_as_of, v_vars);
        v_code := p_expr->>'ref';
        v_entity := p_entity_id;
        SELECT * INTO v_input
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = p_calc_id
          AND input_role = 'OPERAND'
          AND attribute_code = v_code
        ORDER BY ordinal
        LIMIT 1;
        IF FOUND AND v_input.traversal IS DISTINCT FROM 'SELF' THEN
            v_entity := golden_master.related_one(p_entity_id, v_input.traversal, v_input.relationship_codes, p_as_of);
        END IF;
        IF v_entity IS NULL OR v_date IS NULL THEN
            v_literal := 'null'::JSONB;
            v_key := v_code || '@';
        ELSE
            v_literal := golden_master.golden_literal(v_entity, v_code, v_date, p_depth + 1);
            v_key := v_code || '@' || v_date::TEXT;
        END IF;
        v_vars := v_vars || jsonb_build_object(v_key, COALESCE(v_literal, 'null'::JSONB));
        RETURN jsonb_build_object('expr', jsonb_build_object('ref', v_key), 'vars', v_vars);
    END IF;

    IF p_expr ? 'args' AND jsonb_typeof(p_expr->'args') = 'array' THEN
        FOR v_index IN 0..jsonb_array_length(p_expr->'args') - 1 LOOP
            v_step := golden_master.rewrite_as_of(p_expr->'args'->v_index, p_entity_id, p_calc_id, p_as_of, p_depth, v_vars);
            v_vars := v_step->'vars';
            v_args := v_args || jsonb_build_array(v_step->'expr');
        END LOOP;
        RETURN jsonb_build_object('expr', p_expr || jsonb_build_object('args', v_args), 'vars', v_vars);
    END IF;

    RETURN jsonb_build_object('expr', p_expr, 'vars', v_vars);
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.eval_expression_result(
    p_calc_id UUID,
    p_entity_id UUID,
    p_as_of DATE,
    p_depth INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_def metadata_register.calc_definitions%ROWTYPE;
    v_input metadata_register.calc_inputs%ROWTYPE;
    v_vars JSONB := '{}'::JSONB;
    v_entity UUID;
    v_literal JSONB;
    v_bound JSONB;
BEGIN
    IF p_depth > 8 THEN
        RETURN 'null'::JSONB;
    END IF;

    SELECT * INTO v_def FROM metadata_register.calc_definitions WHERE id = p_calc_id;
    IF NOT FOUND OR v_def.calc_kind <> 'EXPRESSION' THEN
        RETURN 'null'::JSONB;
    END IF;

    FOR v_input IN
        SELECT * FROM metadata_register.calc_inputs
        WHERE calc_definition_id = p_calc_id AND input_role = 'OPERAND'
        ORDER BY ordinal
    LOOP
        IF v_input.traversal = 'SELF' THEN
            v_entity := p_entity_id;
        ELSE
            v_entity := golden_master.related_one(p_entity_id, v_input.traversal, v_input.relationship_codes, p_as_of);
        END IF;
        IF v_entity IS NULL THEN
            v_literal := 'null'::JSONB;
        ELSE
            v_literal := golden_master.golden_literal(v_entity, v_input.attribute_code, p_as_of, p_depth + 1);
        END IF;
        v_vars := v_vars || jsonb_build_object(v_input.attribute_code, v_literal);
    END LOOP;

    v_vars := v_vars || jsonb_build_object('CURRENT_DATE', to_jsonb(p_as_of::TEXT));
    v_bound := golden_master.rewrite_as_of(v_def.expression, p_entity_id, p_calc_id, p_as_of, p_depth, v_vars);
    RETURN metadata_register.eval_expr(v_bound->'expr', v_bound->'vars');
END;
$$;

CREATE OR REPLACE FUNCTION compliance.compared_value(
    p_expression TEXT,
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ,
    p_source VARCHAR,
    p_dimension JSONB
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = compliance, metadata_register, pg_temp
AS $$
DECLARE
    v_expr JSONB;
    v_date DATE;
    r RECORD;
    v_text TEXT;
BEGIN
    IF p_expression ~* '^[[:space:]]*AS OF[[:space:]]+' THEN
        v_expr := metadata_register.as_of_expr(substring(btrim(p_expression) FROM 6));
        v_date := metadata_register.eval_as_of_date(
            v_expr, p_as_of, jsonb_build_object('CURRENT_DATE', to_jsonb(p_as_of::TEXT))
        );
        SELECT * INTO r FROM compliance.resolve_dimension(p_as_of, p_knowledge, p_source, p_dimension);
        RETURN compliance.get_text_value(
            p_entity_id, p_attribute_code, COALESCE(v_date, r.o_as_of), r.o_knowledge, r.o_source
        );
    END IF;
    v_text := compliance.get_text_value_dim(
        p_entity_id, p_attribute_code, p_as_of, p_knowledge, p_source, p_dimension
    );
    RETURN compliance.resolve_rhs(p_expression, v_text, p_as_of);
END;
$$;

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
    v_attr_path JSONB;
    v_cmp_path JSONB;
    v_subjects UUID[];
    v_cmp_ids UUID[];
    v_subject UUID;
    v_cmp_id UUID;
BEGIN
    FOR v_group_rec IN
        SELECT DISTINCT condition_group FROM compliance.rule_conditions
        WHERE rule_version_id = p_rule_version_id AND applies_to = p_applies_to
    LOOP
        v_has_conditions := TRUE;
        v_group_match := NULL;
        FOR v_cond IN
            SELECT * FROM compliance.rule_conditions
            WHERE rule_version_id = p_rule_version_id AND applies_to = p_applies_to
              AND condition_group = v_group_rec.condition_group
            ORDER BY condition_order
        LOOP
            v_attr_path := COALESCE(v_cond.attribute_dimension->'relationship_path', '[]'::jsonb);
            v_cmp_path := COALESCE(v_cond.compare_dimension->'relationship_path', '[]'::jsonb);
            v_subjects := compliance.condition_subject_ids(p_entity_id, v_attr_path, p_as_of_date, p_knowledge_date);
            v_cond_result := FALSE;
            IF v_subjects IS NULL OR array_length(v_subjects, 1) IS NULL THEN
                v_cond_result := compliance.condition_null_subject_matches(p_entity_id, v_cond::compliance.rule_conditions, v_attr_path, v_cmp_path, p_as_of_date, p_knowledge_date, p_source_scope);
            ELSE
                FOREACH v_subject IN ARRAY v_subjects LOOP
                    v_actual := compliance.get_text_value_dim(v_subject, v_cond.attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.attribute_dimension);
                    IF v_cond.compare_attribute_code IS NULL THEN
                        v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, compliance.resolve_rhs(v_cond.value, NULL, p_as_of_date));
                    ELSIF jsonb_typeof(v_cmp_path) IS DISTINCT FROM 'array' OR jsonb_array_length(v_cmp_path) = 0 OR v_cmp_path = v_attr_path THEN
                        v_expected := compliance.compared_value(v_cond.value, v_subject, v_cond.compare_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.compare_dimension);
                        v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, v_expected);
                    ELSE
                        v_cmp_ids := compliance.condition_subject_ids(p_entity_id, v_cmp_path, p_as_of_date, p_knowledge_date);
                        IF v_cmp_ids IS NULL OR array_length(v_cmp_ids, 1) IS NULL THEN
                            v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, NULL);
                        ELSE
                            FOREACH v_cmp_id IN ARRAY v_cmp_ids LOOP
                                v_expected := compliance.compared_value(v_cond.value, v_cmp_id, v_cond.compare_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.compare_dimension);
                                IF compliance.evaluate_operator(v_actual, v_cond.operator, v_expected) THEN
                                    v_cond_result := TRUE;
                                    EXIT;
                                END IF;
                            END LOOP;
                        END IF;
                    END IF;
                    IF v_cond_result THEN EXIT; END IF;
                END LOOP;
            END IF;
            IF v_group_match IS NULL THEN v_group_match := v_cond_result;
            ELSIF v_cond.logic_operator = 'OR' THEN v_group_match := v_group_match OR v_cond_result;
            ELSE v_group_match := v_group_match AND v_cond_result;
            END IF;
        END LOOP;
        IF v_group_match THEN v_any_group_match := TRUE; END IF;
    END LOOP;
    IF NOT v_has_conditions THEN RETURN TRUE; END IF;
    RETURN v_any_group_match;
END;
$$;
