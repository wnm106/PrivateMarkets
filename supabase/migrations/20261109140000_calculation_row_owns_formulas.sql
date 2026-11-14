-- Every calculated attribute is a calculation row.
--
-- Statement lines stored their formula only on the attribute, so the
-- calculation editor had nothing to show. Those formulas move into
-- calc_definitions. PRIOR, TRAIL, CUMSUM, and WHEN_PRIOR read the period
-- series of the same issuer. The statement page evaluates the same expression.

INSERT INTO metadata_register.expression_functions (
    id, function_code, function_name, category, return_type, description, signature, example, callable, sort_order
) VALUES
    ('ROW:PRIOR', 'PRIOR', 'Prior period', 'ROW', 'NUMBER',
     'The attribute on the previous period of this record. The first period stays blank. PRIOR(STATEMENT_CASH) is last quarter''s cash.',
     'PRIOR(attribute)',
     '{"fn":"PRIOR","args":[{"ref":"STATEMENT_CASH"}]}'::jsonb, TRUE, 172),
    ('ROW:TRAIL', 'TRAIL', 'Trailing sum', 'ROW', 'NUMBER',
     'Sums the attribute over this period and the periods before it. The result stays blank until that many periods exist. TRAIL(STATEMENT_REVENUE, 4) is four quarters of revenue.',
     'TRAIL(attribute, periods)',
     '{"fn":"TRAIL","args":[{"ref":"STATEMENT_REVENUE"},{"const":4}]}'::jsonb, TRUE, 174),
    ('ROW:CUMSUM', 'CUMSUM', 'Cumulative sum', 'ROW', 'NUMBER',
     'Sums the attribute from the first period through this one. A blank period is skipped. CUMSUM(STATEMENT_NET_INCOME) is retained earnings.',
     'CUMSUM(attribute)',
     '{"fn":"CUMSUM","args":[{"ref":"STATEMENT_NET_INCOME"}]}'::jsonb, TRUE, 176),
    ('ROW:WHEN_PRIOR', 'WHEN_PRIOR', 'When a prior period exists', 'ROW', 'NUMBER',
     'The attribute on this period once a prior period exists. The first period stays blank. WHEN_PRIOR(STATEMENT_DA) keeps depreciation off the opening cash-flow column.',
     'WHEN_PRIOR(attribute)',
     '{"fn":"WHEN_PRIOR","args":[{"ref":"STATEMENT_DA"}]}'::jsonb, TRUE, 178)
ON CONFLICT (id) DO UPDATE SET
    function_name = EXCLUDED.function_name,
    description = EXCLUDED.description,
    signature = EXCLUDED.signature,
    example = EXCLUDED.example,
    callable = EXCLUDED.callable,
    sort_order = EXCLUDED.sort_order;

CREATE OR REPLACE FUNCTION golden_master.statement_series(
    p_entity_id UUID,
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID[]
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, pg_temp
AS $$
DECLARE
    v_issuer UUID;
    v_date_code TEXT;
    v_series UUID[];
BEGIN
    IF p_entity_id IS NULL THEN
        RETURN '{}';
    END IF;

    SELECT attribute_code INTO v_date_code
    FROM metadata_register.attribute_register ar
    JOIN entity_instances.master_entities me ON me.domain_code = ar.domain_code
    WHERE me.id = p_entity_id
      AND ar.data_type = 'DATE'
    ORDER BY ar.display_group NULLS LAST, ar.attribute_code
    LIMIT 1;

    SELECT er.child_entity_id INTO v_issuer
    FROM entity_instances.entity_relationships er
    WHERE er.parent_entity_id = p_entity_id
      AND er.relationship_code = 'STATEMENT_ISSUER'
      AND er.valid_to = DATE '9999-12-31'
      AND golden_master.row_known(er.system_from, er.system_to, p_knowledge)
    ORDER BY er.is_primary DESC, er.valid_from DESC
    LIMIT 1;

    IF v_issuer IS NULL OR v_date_code IS NULL THEN
        RETURN ARRAY[p_entity_id];
    END IF;

    SELECT COALESCE(array_agg(picked.id ORDER BY picked.period_end, picked.id), '{}')
      INTO v_series
    FROM (
        SELECT me.id, golden_master.shown_date(me.id, v_date_code, p_as_of, p_knowledge) AS period_end
        FROM entity_instances.entity_relationships er
        JOIN entity_instances.master_entities me ON me.id = er.parent_entity_id
        WHERE er.child_entity_id = v_issuer
          AND er.relationship_code = 'STATEMENT_ISSUER'
          AND er.valid_to = DATE '9999-12-31'
          AND golden_master.row_known(er.system_from, er.system_to, p_knowledge)
          AND me.is_active
    ) picked
    WHERE picked.period_end IS NOT NULL;

    IF v_series IS NULL OR NOT (p_entity_id = ANY (v_series)) THEN
        RETURN ARRAY[p_entity_id];
    END IF;
    RETURN v_series;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.rewrite_series(
    p_expr JSONB,
    p_entity_id UUID,
    p_as_of DATE,
    p_depth INTEGER,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $$
DECLARE
    v_fn TEXT;
    v_op TEXT;
    v_args JSONB;
    v_ref TEXT;
    v_periods INTEGER;
    v_series UUID[];
    v_pos INTEGER;
    v_index INTEGER;
    v_sum NUMERIC;
    v_value NUMERIC;
    v_literal JSONB;
    v_rewritten JSONB := '[]'::JSONB;
BEGIN
    IF p_expr IS NULL OR jsonb_typeof(p_expr) <> 'object' THEN
        RETURN p_expr;
    END IF;

    v_fn := upper(COALESCE(p_expr->>'fn', ''));
    v_op := lower(COALESCE(p_expr->>'op', ''));
    IF v_fn IN ('PRIOR', 'CUMSUM', 'WHEN_PRIOR', 'TRAIL') OR v_op IN ('prior', 'cumsum', 'when_prior', 'trail') THEN
        v_args := COALESCE(p_expr->'args', '[]'::JSONB);
        v_ref := v_args->0->>'ref';
        IF v_ref IS NULL THEN
            RETURN jsonb_build_object('const', NULL);
        END IF;

        v_series := golden_master.statement_series(p_entity_id, p_as_of, p_knowledge);
        SELECT (ordinality - 1)::INTEGER INTO v_pos
        FROM unnest(v_series) WITH ORDINALITY AS picked(id, ordinality)
        WHERE picked.id = p_entity_id
        LIMIT 1;
        IF v_pos IS NULL THEN
            RETURN jsonb_build_object('const', NULL);
        END IF;

        IF v_fn = 'PRIOR' OR v_op = 'prior' THEN
            IF v_pos = 0 THEN
                RETURN jsonb_build_object('const', NULL);
            END IF;
            v_literal := golden_master.golden_literal(v_series[v_pos], v_ref, p_as_of, p_depth + 1, p_knowledge);
            RETURN golden_master.series_const(v_literal);
        END IF;

        IF v_fn = 'WHEN_PRIOR' OR v_op = 'when_prior' THEN
            IF v_pos = 0 THEN
                RETURN jsonb_build_object('const', NULL);
            END IF;
            v_literal := golden_master.golden_literal(p_entity_id, v_ref, p_as_of, p_depth + 1, p_knowledge);
            RETURN golden_master.series_const(v_literal);
        END IF;

        IF v_fn = 'CUMSUM' OR v_op = 'cumsum' THEN
            v_sum := NULL;
            FOR v_index IN 1..(v_pos + 1) LOOP
                v_value := golden_master.series_number(
                    golden_master.golden_literal(v_series[v_index], v_ref, p_as_of, p_depth + 1, p_knowledge)
                );
                IF v_value IS NOT NULL THEN
                    v_sum := COALESCE(v_sum, 0) + v_value;
                END IF;
            END LOOP;
            IF v_sum IS NULL THEN
                RETURN jsonb_build_object('const', NULL);
            END IF;
            RETURN jsonb_build_object('const', v_sum);
        END IF;

        v_periods := 4;
        IF v_fn = 'TRAIL' AND jsonb_typeof(v_args->1->'const') = 'number' THEN
            v_periods := trunc((v_args->1->>'const')::NUMERIC)::INTEGER;
        ELSIF p_expr ? 'periods' AND (p_expr->>'periods') ~ '^[0-9]+$' THEN
            v_periods := (p_expr->>'periods')::INTEGER;
        END IF;
        IF v_periods < 1 OR v_pos + 1 < v_periods THEN
            RETURN jsonb_build_object('const', NULL);
        END IF;
        v_sum := 0;
        FOR v_index IN (v_pos - v_periods + 2)..(v_pos + 1) LOOP
            v_value := golden_master.series_number(
                golden_master.golden_literal(v_series[v_index], v_ref, p_as_of, p_depth + 1, p_knowledge)
            );
            IF v_value IS NULL THEN
                RETURN jsonb_build_object('const', NULL);
            END IF;
            v_sum := v_sum + v_value;
        END LOOP;
        RETURN jsonb_build_object('const', v_sum);
    END IF;

    IF p_expr ? 'args' AND jsonb_typeof(p_expr->'args') = 'array' THEN
        FOR v_index IN 0..jsonb_array_length(p_expr->'args') - 1 LOOP
            v_rewritten := v_rewritten || jsonb_build_array(
                golden_master.rewrite_series(p_expr->'args'->v_index, p_entity_id, p_as_of, p_depth, p_knowledge)
            );
        END LOOP;
        p_expr := p_expr || jsonb_build_object('args', v_rewritten);
    END IF;

    IF p_expr ? 'asOf' THEN
        p_expr := p_expr || jsonb_build_object(
            'asOf',
            golden_master.rewrite_series(p_expr->'asOf', p_entity_id, p_as_of, p_depth, p_knowledge)
        );
    END IF;
    RETURN p_expr;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.series_number(p_literal JSONB)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_text TEXT;
BEGIN
    IF p_literal IS NULL OR jsonb_typeof(p_literal) = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_literal) = 'number' THEN
        RETURN (p_literal #>> '{}')::NUMERIC;
    END IF;
    IF jsonb_typeof(p_literal) = 'string' THEN
        v_text := p_literal #>> '{}';
        IF v_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
            RETURN v_text::NUMERIC;
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.series_const(p_literal JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_number NUMERIC;
BEGIN
    v_number := golden_master.series_number(p_literal);
    IF v_number IS NULL THEN
        RETURN jsonb_build_object('const', NULL);
    END IF;
    RETURN jsonb_build_object('const', v_number);
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.eval_expression_result(
    p_calc_id UUID,
    p_entity_id UUID,
    p_as_of DATE,
    p_depth INTEGER DEFAULT 0,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
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
    v_expr JSONB;
BEGIN
    IF p_depth > 16 THEN
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
        v_entity := golden_master.operand_entity(
            p_calc_id, p_entity_id, v_input.attribute_code, v_input.traversal,
            v_input.relationship_codes, p_as_of, v_def.expression, p_knowledge
        );
        IF v_entity IS NULL THEN
            v_literal := 'null'::JSONB;
        ELSE
            v_literal := golden_master.golden_literal(v_entity, v_input.attribute_code, p_as_of, p_depth + 1, p_knowledge);
        END IF;
        v_vars := v_vars || jsonb_build_object(v_input.attribute_code, v_literal);
    END LOOP;

    v_vars := v_vars || jsonb_build_object('CURRENT_DATE', to_jsonb(p_as_of::TEXT));
    v_expr := golden_master.rewrite_latest(v_def.expression, p_entity_id, p_calc_id, p_as_of, p_depth, p_knowledge);
    v_expr := golden_master.rewrite_series(v_expr, p_entity_id, p_as_of, p_depth, p_knowledge);
    v_bound := golden_master.rewrite_as_of(v_expr, p_entity_id, p_calc_id, p_as_of, p_depth, v_vars, p_knowledge);
    RETURN metadata_register.eval_expr(v_bound->'expr', v_bound->'vars');
END;
$$;

-- A formula that was written straight onto the attribute becomes a calculation.
-- The sync trigger copies the expression back onto the attribute.
INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, expression
)
SELECT ar.id, ar.domain_code, 'EXPRESSION', 'ON_READ', 'FORWARD', 'ON_INPUT_CHANGE', ar.derivation_formula::jsonb
FROM metadata_register.attribute_register ar
WHERE ar.is_derived = TRUE
  AND ar.formula_language = 'CALC_SPEC'
  AND ar.derivation_formula IS NOT NULL
  AND left(btrim(ar.derivation_formula), 1) = '{'
  AND NOT EXISTS (
      SELECT 1 FROM metadata_register.calc_definitions cd WHERE cd.attribute_id = ar.id
  );

INSERT INTO metadata_register.calc_inputs (
    calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal
)
SELECT cd.id, 'OPERAND', refs.attribute_code, 'SELF', '{}', refs.ordinal
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register owner ON owner.id = cd.attribute_id
JOIN LATERAL (
    SELECT ref AS attribute_code, (row_number() OVER (ORDER BY ref))::INTEGER AS ordinal
    FROM unnest(metadata_register.expr_refs(cd.expression)) AS ref
    WHERE upper(ref) <> 'CURRENT_DATE'
    GROUP BY ref
) refs ON TRUE
WHERE owner.is_derived = TRUE
  AND cd.evaluation_mode = 'ON_READ'
  AND cd.calc_kind = 'EXPRESSION'
  AND NOT EXISTS (
      SELECT 1 FROM metadata_register.calc_inputs existing
      WHERE existing.calc_definition_id = cd.id
  );

-- A stored input is readable when it has a golden value, even if no source won the row.
-- The calculation then sees the same number the statement page shows.
CREATE OR REPLACE FUNCTION golden_master.golden_literal(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of DATE,
    p_depth INTEGER DEFAULT 0,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_calc_id UUID;
    v_mode TEXT;
    v_kind TEXT;
    v_data_type TEXT;
    v_numeric NUMERIC;
    v_text TEXT;
BEGIN
    IF p_depth > 16 OR p_entity_id IS NULL THEN
        RETURN 'null'::jsonb;
    END IF;

    SELECT cd.id, cd.evaluation_mode, cd.calc_kind, ar.data_type
      INTO v_calc_id, v_mode, v_kind, v_data_type
    FROM metadata_register.attribute_register ar
    LEFT JOIN metadata_register.calc_definitions cd ON cd.attribute_id = ar.id
    WHERE ar.attribute_code = p_attribute_code;

    IF v_mode = 'ON_READ' AND v_kind = 'EXPRESSION' THEN
        RETURN golden_master.eval_expression_result(v_calc_id, p_entity_id, p_as_of, p_depth + 1, p_knowledge);
    END IF;

    IF v_mode = 'ON_READ' THEN
        v_numeric := golden_master.eval_calc(v_calc_id, p_entity_id, p_as_of, p_depth + 1);
        IF v_numeric IS NULL THEN
            RETURN 'null'::jsonb;
        END IF;
        RETURN to_jsonb(v_numeric);
    END IF;

    SELECT eav.golden_value_numeric, eav.golden_value
      INTO v_numeric, v_text
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    WHERE eav.entity_id = p_entity_id
      AND ar.attribute_code = p_attribute_code
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND golden_master.row_known(eav.system_from, eav.system_to, p_knowledge)
    ORDER BY
        CASE
            WHEN eav.golden_source_id IS NOT NULL
             AND eav.source_id = eav.golden_source_id
             AND COALESCE(eav.golden_value_numeric::TEXT, eav.golden_value) IS NOT NULL
             AND btrim(COALESCE(eav.golden_value, '')) <> '' THEN 0
            WHEN eav.golden_value_numeric IS NOT NULL
              OR (eav.golden_value IS NOT NULL AND btrim(eav.golden_value) <> '') THEN 1
            ELSE 2
        END,
        eav.precedence_rank
    LIMIT 1;

    IF v_numeric IS NOT NULL THEN
        RETURN to_jsonb(v_numeric);
    END IF;
    IF v_text IS NULL THEN
        RETURN 'null'::jsonb;
    END IF;
    IF upper(COALESCE(v_data_type, '')) IN ('NUMBER', 'INTEGER', 'DECIMAL', 'CURRENCY', 'PERCENTAGE')
       AND v_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        RETURN to_jsonb(v_text::NUMERIC);
    END IF;
    RETURN to_jsonb(v_text);
END;
$$;

REVOKE ALL ON FUNCTION golden_master.statement_series(UUID, DATE, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.rewrite_series(JSONB, UUID, DATE, INTEGER, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.series_number(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.series_const(JSONB) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
