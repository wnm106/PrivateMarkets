-- One date-function library for column expressions and compliance comparisons.
-- CURRENT_DATE in a column expression is the calculation as-of date.

INSERT INTO metadata_register.expression_functions (
    id, function_code, function_name, category, return_type, description, signature, example, callable, sort_order
) VALUES
    ('ROW:CURRENT_DATE', 'CURRENT_DATE', 'As-of date', 'ROW', 'VALUE',
     'The as-of date of the calculation, not the day the expression is saved.',
     'CURRENT_DATE', '{"ref":"CURRENT_DATE"}'::jsonb, TRUE, 182),
    ('ROW:PREVIOUS_DAY', 'PREVIOUS_DAY', 'Yesterday', 'ROW', 'VALUE',
     'The day before a date. PREVIOUS_DAY(CURRENT_DATE) is the day before the as-of date.',
     'PREVIOUS_DAY(date)', '{"fn":"PREVIOUS_DAY","args":[{"ref":"CURRENT_DATE"}]}'::jsonb, TRUE, 184),
    ('ROW:START_OF_MONTH', 'START_OF_MONTH', 'Start of month', 'ROW', 'VALUE',
     'The first day of the month containing a date.',
     'START_OF_MONTH(date)', '{"fn":"START_OF_MONTH","args":[{"ref":"CURRENT_DATE"}]}'::jsonb, TRUE, 186),
    ('ROW:END_OF_MONTH', 'END_OF_MONTH', 'End of month', 'ROW', 'VALUE',
     'The last day of the month containing a date.',
     'END_OF_MONTH(date)', '{"fn":"END_OF_MONTH","args":[{"ref":"CURRENT_DATE"}]}'::jsonb, TRUE, 188),
    ('ROW:START_OF_QUARTER', 'START_OF_QUARTER', 'Start of quarter', 'ROW', 'VALUE',
     'The first day of the calendar quarter containing a date.',
     'START_OF_QUARTER(date)', '{"fn":"START_OF_QUARTER","args":[{"ref":"CURRENT_DATE"}]}'::jsonb, TRUE, 190),
    ('ROW:END_OF_QUARTER', 'END_OF_QUARTER', 'End of quarter', 'ROW', 'VALUE',
     'The last day of the calendar quarter containing a date.',
     'END_OF_QUARTER(date)', '{"fn":"END_OF_QUARTER","args":[{"ref":"CURRENT_DATE"}]}'::jsonb, TRUE, 192),
    ('ROW:START_OF_YEAR', 'START_OF_YEAR', 'Start of year', 'ROW', 'VALUE',
     'The first day of the calendar year containing a date.',
     'START_OF_YEAR(date)', '{"fn":"START_OF_YEAR","args":[{"ref":"CURRENT_DATE"}]}'::jsonb, TRUE, 194),
    ('ROW:END_OF_YEAR', 'END_OF_YEAR', 'End of year', 'ROW', 'VALUE',
     'The last day of the calendar year containing a date.',
     'END_OF_YEAR(date)', '{"fn":"END_OF_YEAR","args":[{"ref":"CURRENT_DATE"}]}'::jsonb, TRUE, 196)
ON CONFLICT (id) DO UPDATE SET
    function_name = EXCLUDED.function_name,
    description = EXCLUDED.description,
    signature = EXCLUDED.signature,
    example = EXCLUDED.example,
    callable = EXCLUDED.callable,
    sort_order = EXCLUDED.sort_order;

CREATE OR REPLACE FUNCTION metadata_register.eval_expr(p_expr JSONB, p_vars JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
    v_fn TEXT;
    v_args JSONB;
    v_count INTEGER;
    v_index INTEGER;
    v_child JSONB;
    v_num NUMERIC;
    v_left NUMERIC;
    v_right NUMERIC;
    v_places INTEGER;
    v_text TEXT;
    v_best NUMERIC;
    v_seen BOOLEAN;
BEGIN
    IF p_expr IS NULL OR jsonb_typeof(p_expr) = 'null' THEN
        RETURN 'null'::jsonb;
    END IF;

    IF p_expr ? 'const' THEN
        RETURN p_expr->'const';
    END IF;

    IF p_expr ? 'ref' THEN
        IF p_vars IS NOT NULL AND p_vars ? (p_expr->>'ref') THEN
            RETURN COALESCE(p_vars->(p_expr->>'ref'), 'null'::jsonb);
        END IF;
        RETURN 'null'::jsonb;
    END IF;

    IF p_expr ? 'op' THEN
        v_fn := lower(p_expr->>'op');
        v_args := COALESCE(p_expr->'args', '[]'::jsonb);
        IF v_fn = 'neg' THEN
            v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), 'NEG');
            IF v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            RETURN to_jsonb(-v_num);
        END IF;
        v_left := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), upper(v_fn));
        v_right := metadata_register.expr_number(metadata_register.eval_expr(v_args->1, p_vars), upper(v_fn));
        v_num := metadata_register.expr_apply_op(v_fn, v_left, v_right);
        IF v_num IS NULL THEN
            RETURN 'null'::jsonb;
        END IF;
        RETURN to_jsonb(v_num);
    END IF;

    IF p_expr ? 'fn' THEN
        v_fn := upper(p_expr->>'fn');
        v_args := COALESCE(p_expr->'args', '[]'::jsonb);
        v_count := jsonb_array_length(v_args);

        IF v_fn IN ('ABS', 'FLOOR', 'CEIL') THEN
            IF v_count <> 1 THEN
                RAISE EXCEPTION '% expects 1 argument', v_fn;
            END IF;
            v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), v_fn);
            IF v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            IF v_fn = 'ABS' THEN
                RETURN to_jsonb(abs(v_num));
            ELSIF v_fn = 'FLOOR' THEN
                RETURN to_jsonb(floor(v_num));
            END IF;
            RETURN to_jsonb(ceil(v_num));
        END IF;

        IF v_fn = 'ROUND' THEN
            IF v_count < 1 OR v_count > 2 THEN
                RAISE EXCEPTION 'ROUND expects 1 or 2 arguments';
            END IF;
            v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), v_fn);
            IF v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            IF v_count = 1 THEN
                v_places := 0;
            ELSE
                v_right := metadata_register.expr_number(metadata_register.eval_expr(v_args->1, p_vars), v_fn);
                IF v_right IS NULL THEN
                    RETURN 'null'::jsonb;
                END IF;
                v_places := trunc(v_right)::INTEGER;
            END IF;
            RETURN to_jsonb(round(v_num, v_places));
        END IF;

        IF v_fn IN ('MIN', 'MAX') THEN
            IF v_count < 1 THEN
                RAISE EXCEPTION '% expects 1 or more arguments', v_fn;
            END IF;
            v_best := NULL;
            v_seen := FALSE;
            FOR v_index IN 0..(v_count - 1) LOOP
                v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->v_index, p_vars), v_fn);
                IF v_num IS NULL THEN
                    CONTINUE;
                END IF;
                IF NOT v_seen THEN
                    v_best := v_num;
                    v_seen := TRUE;
                ELSIF v_fn = 'MIN' THEN
                    v_best := LEAST(v_best, v_num);
                ELSE
                    v_best := GREATEST(v_best, v_num);
                END IF;
            END LOOP;
            IF NOT v_seen THEN
                RETURN 'null'::jsonb;
            END IF;
            RETURN to_jsonb(v_best);
        END IF;

        IF v_fn = 'COALESCE' THEN
            IF v_count < 1 THEN
                RAISE EXCEPTION 'COALESCE expects 1 or more arguments';
            END IF;
            FOR v_index IN 0..(v_count - 1) LOOP
                v_child := metadata_register.eval_expr(v_args->v_index, p_vars);
                IF v_child IS NOT NULL AND jsonb_typeof(v_child) <> 'null' THEN
                    RETURN v_child;
                END IF;
            END LOOP;
            RETURN 'null'::jsonb;
        END IF;

        IF v_fn = 'CONCAT' THEN
            IF v_count < 1 THEN
                RAISE EXCEPTION 'CONCAT expects 1 or more arguments';
            END IF;
            v_text := '';
            FOR v_index IN 0..(v_count - 1) LOOP
                v_child := metadata_register.eval_expr(v_args->v_index, p_vars);
                IF v_child IS NULL OR jsonb_typeof(v_child) = 'null' THEN
                    CONTINUE;
                END IF;
                v_text := v_text || (v_child #>> '{}');
            END LOOP;
            RETURN to_jsonb(v_text);
        END IF;

        IF v_fn IN ('UPPER', 'LOWER', 'TRIM', 'LENGTH') THEN
            IF v_count <> 1 THEN
                RAISE EXCEPTION '% expects 1 argument', v_fn;
            END IF;
            v_child := metadata_register.eval_expr(v_args->0, p_vars);
            IF v_child IS NULL OR jsonb_typeof(v_child) = 'null' THEN
                RETURN 'null'::jsonb;
            END IF;
            v_text := v_child #>> '{}';
            IF v_fn = 'UPPER' THEN
                RETURN to_jsonb(upper(v_text));
            ELSIF v_fn = 'LOWER' THEN
                RETURN to_jsonb(lower(v_text));
            ELSIF v_fn = 'TRIM' THEN
                RETURN to_jsonb(btrim(v_text));
            END IF;
            RETURN to_jsonb(length(v_text));
        END IF;

        IF v_fn = 'LEFT' THEN
            IF v_count <> 2 THEN
                RAISE EXCEPTION 'LEFT expects 2 arguments';
            END IF;
            v_child := metadata_register.eval_expr(v_args->0, p_vars);
            v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->1, p_vars), v_fn);
            IF v_child IS NULL OR jsonb_typeof(v_child) = 'null' OR v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            v_places := trunc(v_num)::INTEGER;
            IF v_places < 0 THEN
                RAISE EXCEPTION 'LEFT expects a count of zero or more';
            END IF;
            RETURN to_jsonb(left(v_child #>> '{}', v_places));
        END IF;

        IF v_fn = 'NEG' THEN
            IF v_count <> 1 THEN
                RAISE EXCEPTION 'NEG expects 1 argument';
            END IF;
            v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), v_fn);
            IF v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            RETURN to_jsonb(-v_num);
        END IF;

        IF v_fn IN ('ADD', 'SUB', 'MUL', 'DIV') THEN
            IF v_count <> 2 THEN
                RAISE EXCEPTION '% expects 2 arguments', v_fn;
            END IF;
            v_left := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), v_fn);
            v_right := metadata_register.expr_number(metadata_register.eval_expr(v_args->1, p_vars), v_fn);
            v_num := metadata_register.expr_apply_op(lower(v_fn), v_left, v_right);
            IF v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            RETURN to_jsonb(v_num);
        END IF;

        IF v_fn IN ('PREVIOUS_DAY', 'START_OF_MONTH', 'END_OF_MONTH', 'START_OF_QUARTER', 'END_OF_QUARTER', 'START_OF_YEAR', 'END_OF_YEAR') THEN
            IF v_count <> 1 THEN
                RAISE EXCEPTION '% expects 1 date', v_fn;
            END IF;
            v_child := metadata_register.eval_expr(v_args->0, p_vars);
            IF v_child IS NULL OR jsonb_typeof(v_child) = 'null' THEN
                RETURN 'null'::jsonb;
            END IF;
            v_text := v_child #>> '{}';
            BEGIN
                RETURN to_jsonb(data_quality.apply_date_fn(lower(v_fn), v_text::date)::text);
            EXCEPTION WHEN OTHERS THEN
                RAISE EXCEPTION '% expects a date', v_fn;
            END;
        END IF;

        RAISE EXCEPTION 'Unknown expression function: %', v_fn;
    END IF;

    RAISE EXCEPTION 'Unsupported calc expression';
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
    v_vars JSONB := '{}'::jsonb;
    v_entity UUID;
    v_literal JSONB;
BEGIN
    IF p_depth > 8 THEN
        RETURN 'null'::jsonb;
    END IF;

    SELECT * INTO v_def FROM metadata_register.calc_definitions WHERE id = p_calc_id;
    IF NOT FOUND OR v_def.calc_kind <> 'EXPRESSION' THEN
        RETURN 'null'::jsonb;
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
            v_literal := 'null'::jsonb;
        ELSE
            v_literal := golden_master.golden_literal(v_entity, v_input.attribute_code, p_as_of, p_depth + 1);
        END IF;
        v_vars := v_vars || jsonb_build_object(v_input.attribute_code, v_literal);
    END LOOP;

    v_vars := v_vars || jsonb_build_object('CURRENT_DATE', to_jsonb(p_as_of::text));
    RETURN metadata_register.eval_expr(v_def.expression, v_vars);
END;
$$;



CREATE OR REPLACE FUNCTION compliance.resolve_rhs(
    p_expression text,
    p_attribute_text text,
    p_as_of date
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_expr text := btrim(COALESCE(p_expression, ''));
    v_fn text;
    v_arg text;
    v_base date;
    v_m text[];
BEGIN
    IF v_expr = '' THEN
        RETURN p_attribute_text;
    END IF;
    IF upper(v_expr) = 'CURRENT_DATE' THEN
        RETURN p_as_of::text;
    END IF;
    IF upper(v_expr) IN ('YESTERDAY', 'PREVIOUS_DAY', 'START_OF_MONTH', 'END_OF_MONTH', 'START_OF_QUARTER', 'END_OF_QUARTER', 'START_OF_YEAR', 'END_OF_YEAR') THEN
        v_fn := CASE WHEN upper(v_expr) = 'YESTERDAY' THEN 'previous_day' ELSE lower(v_expr) END;
        RETURN data_quality.apply_date_fn(v_fn, p_as_of)::text;
    END IF;
    v_m := regexp_match(
        v_expr,
        '^(PREVIOUS_DAY|START_OF_MONTH|END_OF_MONTH|START_OF_QUARTER|END_OF_QUARTER|START_OF_YEAR|END_OF_YEAR)[[:space:]]*\([[:space:]]*(CURRENT_DATE|[A-Za-z_][A-Za-z0-9_]*)[[:space:]]*\)$',
        'i'
    );
    IF v_m IS NOT NULL THEN
        v_fn := lower(v_m[1]);
        v_arg := v_m[2];
        IF upper(v_arg) = 'CURRENT_DATE' THEN
            v_base := p_as_of;
        ELSE
            IF p_attribute_text IS NULL OR btrim(p_attribute_text) = '' THEN
                RETURN NULL;
            END IF;
            v_base := btrim(p_attribute_text)::date;
        END IF;
        RETURN data_quality.apply_date_fn(v_fn, v_base)::text;
    END IF;
    IF p_attribute_text IS NOT NULL THEN
        RETURN p_attribute_text;
    END IF;
    RETURN p_expression;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION compliance.resolve_rhs(text, text, date) IS
    'Right-hand side of a compliance comparison: a literal, or a date function of the as-of date or another attribute.';

REVOKE ALL ON FUNCTION compliance.resolve_rhs(text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION compliance.resolve_rhs(text, text, date) TO authenticated, service_role;

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
            v_attr_path := COALESCE(v_cond.attribute_dimension->'relationship_path', '[]'::jsonb);
            v_cmp_path := COALESCE(v_cond.compare_dimension->'relationship_path', '[]'::jsonb);
            v_subjects := compliance.condition_subject_ids(p_entity_id, v_attr_path, p_as_of_date, p_knowledge_date);
            v_cond_result := FALSE;

            IF v_subjects IS NULL OR array_length(v_subjects, 1) IS NULL THEN
                v_cond_result := compliance.condition_null_subject_matches(
                    p_entity_id, v_cond::compliance.rule_conditions, v_attr_path, v_cmp_path, p_as_of_date, p_knowledge_date, p_source_scope
                );
            ELSE
                FOREACH v_subject IN ARRAY v_subjects LOOP
                    v_actual := compliance.get_text_value_dim(
                        v_subject, v_cond.attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.attribute_dimension
                    );

                    IF v_cond.compare_attribute_code IS NULL THEN
                        v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, compliance.resolve_rhs(v_cond.value, NULL, p_as_of_date));
                    ELSIF jsonb_typeof(v_cmp_path) IS DISTINCT FROM 'array'
                       OR jsonb_array_length(v_cmp_path) = 0
                       OR v_cmp_path = v_attr_path THEN
                        v_expected := compliance.get_text_value_dim(
                            v_subject, v_cond.compare_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.compare_dimension
                        );
                        v_expected := compliance.resolve_rhs(v_cond.value, v_expected, p_as_of_date);
                        v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, v_expected);
                    ELSE
                        v_cmp_ids := compliance.condition_subject_ids(p_entity_id, v_cmp_path, p_as_of_date, p_knowledge_date);
                        IF v_cmp_ids IS NULL OR array_length(v_cmp_ids, 1) IS NULL THEN
                            v_cond_result := compliance.evaluate_operator(v_actual, v_cond.operator, NULL);
                        ELSE
                            FOREACH v_cmp_id IN ARRAY v_cmp_ids LOOP
                                v_expected := compliance.get_text_value_dim(
                                    v_cmp_id, v_cond.compare_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, v_cond.compare_dimension
                                );
                                v_expected := compliance.resolve_rhs(v_cond.value, v_expected, p_as_of_date);
                                IF compliance.evaluate_operator(v_actual, v_cond.operator, v_expected) THEN
                                    v_cond_result := TRUE;
                                    EXIT;
                                END IF;
                            END LOOP;
                        END IF;
                    END IF;

                    IF v_cond_result THEN
                        EXIT;
                    END IF;
                END LOOP;
            END IF;

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


CREATE OR REPLACE FUNCTION compliance.condition_null_subject_matches(
    p_entity_id UUID,
    p_cond compliance.rule_conditions,
    p_attr_path JSONB,
    p_cmp_path JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_cmp_ids UUID[];
    v_cmp_id UUID;
    v_expected TEXT;
BEGIN
    IF p_cond.compare_attribute_code IS NULL THEN
        RETURN compliance.evaluate_operator(NULL, p_cond.operator, compliance.resolve_rhs(p_cond.value, NULL, p_as_of_date));
    END IF;

    IF jsonb_typeof(p_cmp_path) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_cmp_path) = 0
       OR p_cmp_path = p_attr_path THEN
        RETURN compliance.evaluate_operator(NULL, p_cond.operator, NULL);
    END IF;

    v_cmp_ids := compliance.condition_subject_ids(p_entity_id, p_cmp_path, p_as_of_date, p_knowledge_date);
    IF v_cmp_ids IS NULL OR array_length(v_cmp_ids, 1) IS NULL THEN
        RETURN compliance.evaluate_operator(NULL, p_cond.operator, NULL);
    END IF;

    FOREACH v_cmp_id IN ARRAY v_cmp_ids LOOP
        v_expected := compliance.get_text_value_dim(
            v_cmp_id, p_cond.compare_attribute_code, p_as_of_date, p_knowledge_date, p_source_scope, p_cond.compare_dimension
        );
        v_expected := compliance.resolve_rhs(p_cond.value, v_expected, p_as_of_date);
        IF compliance.evaluate_operator(NULL, p_cond.operator, v_expected) THEN
            RETURN TRUE;
        END IF;
    END LOOP;
    RETURN FALSE;
END;
$$;



CREATE OR REPLACE FUNCTION compliance.evaluate_operator(
    p_actual TEXT,
    p_operator VARCHAR,
    p_value TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_actual_num NUMERIC;
    v_value_num NUMERIC;
    v_actual_date DATE;
    v_value_date DATE;
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
            IF p_actual ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' AND p_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
                BEGIN
                    v_actual_date := p_actual::date;
                    v_value_date := p_value::date;
                EXCEPTION WHEN OTHERS THEN
                    RETURN FALSE;
                END;
                RETURN CASE p_operator
                    WHEN 'gt' THEN v_actual_date > v_value_date
                    WHEN 'gte' THEN v_actual_date >= v_value_date
                    WHEN 'lt' THEN v_actual_date < v_value_date
                    WHEN 'lte' THEN v_actual_date <= v_value_date
                END;
            END IF;
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

