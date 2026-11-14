-- Read functions: SOURCE(field, 'CODE'), AS_OF(field, -1, 'MONTH'[, 'MONTH_END']) and
-- KNOWN_AT(field[, -1, 'MONTH']) wrap a field to say where and when it is read.
-- They replace the per-field "where values are read" settings.
--   * Condition expressions: eval_operand lifts each wrapper into a tagged ref.
--   * Measure lines: each line carries a dimension that eval_clo_term reads through.

ALTER TABLE compliance.rule_measure_lines
    ADD COLUMN IF NOT EXISTS dimension JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS expression JSONB;

COMMENT ON COLUMN compliance.rule_measure_lines.expression IS
    'When set, the amount is this formula evaluated on each record ({const} | {ref} | {op, args} | {fn, args}, refs are attribute codes on the record). The line kind then aggregates the results.';

COMMENT ON COLUMN compliance.rule_measure_lines.dimension IS
    'Where and when the line reads its attribute: {source_scope, offset_amount, offset_unit, snap_to, knowledge_mode}. Empty reads the run source at the as-of date.';

CREATE OR REPLACE FUNCTION compliance.read_function_dimension(p_fn TEXT, p_args JSONB, p_dim JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_dim JSONB := COALESCE(p_dim, '{}'::jsonb);
    v_n INTEGER := COALESCE(jsonb_array_length(p_args), 0);
    v_amount TEXT;
BEGIN
    IF upper(p_fn) = 'SOURCE' THEN
        RETURN v_dim || jsonb_build_object('source_scope', upper(COALESCE(p_args -> 1 ->> 'const', '')));
    END IF;
    IF upper(p_fn) = 'AS_OF' THEN
        v_amount := p_args -> 1 ->> 'const';
        IF v_amount IS NULL THEN
            RAISE EXCEPTION 'AS_OF needs a number of periods, like AS_OF(field, -1, ''MONTH'')';
        END IF;
        v_dim := v_dim || jsonb_build_object('offset_amount', v_amount::INTEGER, 'offset_unit', upper(COALESCE(NULLIF(p_args -> 2 ->> 'const', ''), 'DAY')));
        IF v_n >= 4 AND COALESCE(p_args -> 3 ->> 'const', '') <> '' THEN
            v_dim := v_dim || jsonb_build_object('snap_to', upper(p_args -> 3 ->> 'const'));
        END IF;
        RETURN v_dim;
    END IF;
    IF upper(p_fn) = 'KNOWN_AT' THEN
        v_dim := v_dim || jsonb_build_object('knowledge_mode', 'AT_OFFSET_DATE');
        IF v_n >= 2 AND p_args -> 1 ->> 'const' IS NOT NULL THEN
            v_dim := v_dim || jsonb_build_object('offset_amount', (p_args -> 1 ->> 'const')::INTEGER, 'offset_unit', upper(COALESCE(NULLIF(p_args -> 2 ->> 'const', ''), 'DAY')));
        END IF;
        RETURN v_dim;
    END IF;
    RETURN v_dim;
END;
$$;

-- Replaces every SOURCE/AS_OF/KNOWN_AT call with its field, tagged with the
-- read settings the wrappers add up to. The tag rides in the ref name, so each
-- distinct (field, settings) pair is read once.
CREATE OR REPLACE FUNCTION compliance.lift_read_functions(p_expr JSONB, p_dim JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_fn TEXT;
    v_arg JSONB;
    v_args JSONB := '[]'::jsonb;
BEGIN
    IF p_expr IS NULL OR jsonb_typeof(p_expr) <> 'object' THEN
        RETURN p_expr;
    END IF;
    v_fn := upper(COALESCE(p_expr ->> 'fn', ''));
    IF v_fn IN ('SOURCE', 'AS_OF', 'KNOWN_AT') THEN
        IF jsonb_array_length(COALESCE(p_expr -> 'args', '[]'::jsonb)) < 1 THEN
            RAISE EXCEPTION '% needs a field to read', v_fn;
        END IF;
        RETURN compliance.lift_read_functions(
            p_expr -> 'args' -> 0,
            compliance.read_function_dimension(v_fn, p_expr -> 'args', p_dim)
        );
    END IF;
    IF p_expr ? 'ref' THEN
        IF p_dim = '{}'::jsonb OR p_expr ->> 'ref' = 'CURRENT_DATE' THEN
            RETURN p_expr;
        END IF;
        RETURN jsonb_build_object('ref', (p_expr ->> 'ref') || E'\u001e' || p_dim::text);
    END IF;
    IF jsonb_typeof(p_expr -> 'args') = 'array' THEN
        FOR v_arg IN SELECT * FROM jsonb_array_elements(p_expr -> 'args') LOOP
            v_args := v_args || jsonb_build_array(compliance.lift_read_functions(v_arg, p_dim));
        END LOOP;
        RETURN jsonb_set(p_expr, '{args}', v_args);
    END IF;
    RETURN p_expr;
END;
$$;

CREATE OR REPLACE FUNCTION compliance.eval_operand(
    p_entity_id UUID,
    p_expr JSONB,
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ,
    p_source VARCHAR,
    p_dim JSONB DEFAULT '{}'
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_vars JSONB := jsonb_build_object('CURRENT_DATE', to_jsonb(p_as_of::TEXT));
    v_expr JSONB;
    v_ref TEXT;
    v_tagged TEXT;
    v_tag JSONB;
    v_path TEXT;
    v_code TEXT;
    v_ids UUID[];
    v_text TEXT;
    v_result JSONB;
BEGIN
    IF p_expr IS NULL OR jsonb_typeof(p_expr) = 'null' THEN
        RETURN NULL;
    END IF;

    v_expr := compliance.lift_read_functions(p_expr);

    FOR v_tagged IN
        SELECT DISTINCT r #>> '{}' FROM jsonb_path_query(v_expr, 'lax $.**.ref') AS r
    LOOP
        IF v_tagged IS NULL OR v_tagged = 'CURRENT_DATE' THEN
            CONTINUE;
        END IF;
        IF position(E'\u001e' IN v_tagged) > 0 THEN
            v_ref := split_part(v_tagged, E'\u001e', 1);
            v_tag := split_part(v_tagged, E'\u001e', 2)::jsonb;
        ELSE
            v_ref := v_tagged;
            v_tag := '{}'::jsonb;
        END IF;
        IF position(E'\u001f' IN v_ref) > 0 THEN
            v_path := split_part(v_ref, E'\u001f', 1);
            v_code := split_part(v_ref, E'\u001f', 2);
        ELSE
            v_path := '';
            v_code := v_ref;
        END IF;

        v_ids := compliance.condition_subject_ids(p_entity_id, compliance.path_text_to_hops(v_path), p_as_of, p_knowledge);
        IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
            v_text := NULL;
        ELSE
            v_text := compliance.get_text_value_dim(v_ids[1], v_code, p_as_of, p_knowledge, p_source, COALESCE(p_dim, '{}'::jsonb) || v_tag);
        END IF;

        v_vars := v_vars || jsonb_build_object(
            v_tagged,
            CASE
                WHEN v_text IS NULL OR btrim(v_text) = '' THEN 'null'::jsonb
                WHEN btrim(v_text) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN to_jsonb(btrim(v_text)::numeric)
                ELSE to_jsonb(v_text)
            END
        );
    END LOOP;

    v_result := metadata_register.eval_expr(v_expr, v_vars);
    IF v_result IS NULL OR jsonb_typeof(v_result) = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(v_result) = 'number' THEN
        RETURN trim_scale((v_result #>> '{}')::numeric)::TEXT;
    END IF;
    RETURN v_result #>> '{}';
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION compliance.read_function_dimension(TEXT, JSONB, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.lift_read_functions(JSONB, JSONB) TO authenticated, service_role;

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
    v_rd RECORD;
BEGIN
    SELECT * INTO v_rd FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, p_source_scope, p_term -> 'dimension');
    v_ids := compliance.clo_term_ids(p_anchor_id, p_term -> 'path', p_term -> 'where',
                                     p_as_of_date, p_knowledge_date, p_source_scope, p_scenario_code);

    IF v_kind IN ('SUM', 'COUNT', 'MIN', 'MAX', 'AVG', 'VALUE') THEN
        IF array_length(v_ids, 1) IS NULL THEN
            RETURN CASE WHEN v_kind IN ('SUM', 'COUNT') THEN 0 ELSE NULL END;
        END IF;
        IF jsonb_typeof(p_term -> 'expression') = 'object' THEN
            -- A formula amount: evaluate it on each record, then aggregate the results.
            SELECT array_agg(x.val) INTO v_values
            FROM (
                SELECT CASE WHEN r.t ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$' THEN r.t::NUMERIC END AS val
                FROM unnest(v_ids) AS e
                CROSS JOIN LATERAL (
                    SELECT compliance.eval_operand(e, p_term -> 'expression', p_as_of_date, p_knowledge_date, p_source_scope, '{}'::JSONB) AS t
                ) AS r
            ) x
            WHERE x.val IS NOT NULL;
        ELSE
            SELECT array_agg(g.val) INTO v_values
            FROM compliance.get_numeric_values(v_ids, v_attr, v_rd.o_as_of, v_rd.o_knowledge, v_rd.o_source) g
            WHERE g.val IS NOT NULL;
        END IF;
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
        FROM compliance.get_numeric_values(v_ids, v_attr, v_rd.o_as_of, v_rd.o_knowledge, v_rd.o_source) g;
        SELECT COALESCE(SUM(g.val), 0) INTO v_sum_total
        FROM compliance.get_numeric_values(v_total_ids, v_attr, v_rd.o_as_of, v_rd.o_knowledge, v_rd.o_source) g;

        v_excess := GREATEST(v_sum_where - (v_pct / 100.0) * v_sum_total, 0);

        IF v_excess > 0 AND p_term ? 'price_attribute' AND v_sum_where > 0 THEN
            SELECT SUM(w.val * p.val) / NULLIF(SUM(w.val), 0) INTO v_avg_price
            FROM compliance.get_numeric_values(v_ids, v_attr, v_rd.o_as_of, v_rd.o_knowledge, v_rd.o_source) w
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
            FROM compliance.get_numeric_values(COALESCE(v_subjects, '{}'::UUID[]), v_attr, v_rd.o_as_of, v_rd.o_knowledge, v_rd.o_source) g
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
                v_text := compliance.get_text_value(v_subject, v_attr, v_rd.o_as_of, v_rd.o_knowledge, v_rd.o_source);
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
    'Evaluates one term of a composite compliance rule for one anchor: a sum or other aggregate, a par-weighted average, or an excess over a percentage cap. The term dimension sets where and when its attribute is read.';

CREATE OR REPLACE FUNCTION compliance.measure_line_terms(p_version_id uuid, p_side text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT COALESCE(jsonb_agg(built.term ORDER BY built.line_order), '[]'::jsonb)
    FROM (
        SELECT
            l.line_order,
            jsonb_strip_nulls(jsonb_build_object(
                'label', NULLIF(l.label, ''),
                'expression', CASE WHEN jsonb_typeof(l.expression) = 'object' THEN l.expression END,
                'dimension', CASE WHEN l.dimension IS NOT NULL AND l.dimension <> '{}'::jsonb THEN l.dimension END,
                'kind', l.kind,
                'attribute', NULLIF(l.attribute_code, ''),
                'path', COALESCE(l.path, '[]'::jsonb),
                'sign', CASE WHEN l.sign = -1 THEN -1 END,
                'required', CASE WHEN l.required THEN TRUE END,
                'where', CASE
                    WHEN jsonb_array_length(filters.where_filters) > 0 THEN filters.where_filters
                END,
                'weight_attribute', NULLIF(l.weight_attribute_code, ''),
                'value_path', CASE
                    WHEN jsonb_typeof(l.value_path) = 'array' AND jsonb_array_length(l.value_path) > 0 THEN l.value_path
                END,
                'transform', NULLIF(l.transform, ''),
                'price_attribute', NULLIF(l.price_attribute_code, ''),
                'pct', l.pct,
                'total_path', CASE
                    WHEN jsonb_typeof(l.total_path) = 'array' THEN l.total_path
                END,
                'total_where', CASE
                    WHEN jsonb_array_length(filters.total_filters) > 0 THEN filters.total_filters
                END,
                'pct_term', CASE
                    WHEN COALESCE(l.pct_attribute_code, '') <> '' THEN jsonb_build_object(
                        'kind', 'MAX',
                        'attribute', l.pct_attribute_code,
                        'path', COALESCE(l.pct_path, '[]'::jsonb)
                    )
                END
            )) AS term
        FROM compliance.rule_measure_lines AS l
        CROSS JOIN LATERAL (
            SELECT
                compliance.measure_line_filters(l.id, 'WHERE') AS where_filters,
                compliance.measure_line_filters(l.id, 'TOTAL') AS total_filters
        ) AS filters
        WHERE l.rule_version_id = p_version_id
          AND l.side = p_side
    ) AS built;
$$;

