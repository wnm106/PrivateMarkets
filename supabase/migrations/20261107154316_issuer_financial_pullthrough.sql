-- Pull a field through from the latest related record.
--
-- LATEST(attribute) reads that attribute on the latest record reached by the
-- operand's relationship path. LATEST(attribute, match, "value") keeps only
-- records whose match attribute equals that text, then takes the latest.
-- The latest record is the one whose period date (the date attribute on that
-- type) is the greatest date on or before the as-of date. A record with no
-- period date stays eligible and is ordered by the relationship.

CREATE OR REPLACE FUNCTION golden_master.attribute_text(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of DATE
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $$
DECLARE
    v_text TEXT;
    v_open TIMESTAMPTZ := golden_master.open_system_to();
BEGIN
    SELECT eav.golden_value
      INTO v_text
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    WHERE eav.entity_id = p_entity_id
      AND ar.attribute_code = p_attribute_code
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND eav.system_to = v_open
    ORDER BY
        CASE
            WHEN eav.golden_source_id IS NOT NULL
             AND eav.source_id = eav.golden_source_id
             AND eav.golden_value IS NOT NULL
             AND btrim(eav.golden_value) <> '' THEN 0
            WHEN eav.golden_value IS NOT NULL AND btrim(eav.golden_value) <> '' THEN 1
            ELSE 2
        END,
        eav.precedence_rank
    LIMIT 1;
    RETURN v_text;
END;
$$;

-- Period dates on seeded records are visible on the record even when the
-- preference winner has not been stamped. Ordering uses that same value.
CREATE OR REPLACE FUNCTION golden_master.shown_date(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of DATE
) RETURNS DATE
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $$
DECLARE
    v_date DATE;
    v_open TIMESTAMPTZ := golden_master.open_system_to();
BEGIN
    SELECT COALESCE(
        eav.golden_value_date,
        CASE
            WHEN eav.golden_value ~ '^\d{4}-\d{2}-\d{2}' THEN left(eav.golden_value, 10)::DATE
            ELSE NULL
        END
    )
      INTO v_date
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    WHERE eav.entity_id = p_entity_id
      AND ar.attribute_code = p_attribute_code
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND eav.system_to = v_open
    ORDER BY
        CASE
            WHEN eav.golden_source_id IS NOT NULL
             AND eav.source_id = eav.golden_source_id
             AND eav.golden_value IS NOT NULL
             AND btrim(eav.golden_value) <> '' THEN 0
            WHEN eav.golden_value IS NOT NULL AND btrim(eav.golden_value) <> '' THEN 1
            ELSE 2
        END,
        eav.precedence_rank
    LIMIT 1;
    RETURN v_date;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.related_latest(
    p_root UUID,
    p_traversal TEXT,
    p_codes TEXT[],
    p_as_of DATE,
    p_match_code TEXT DEFAULT NULL,
    p_match_value TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, pg_temp
AS $$
DECLARE
    v_ids UUID[];
    v_matched UUID[] := '{}';
    v_anchor UUID[];
    v_domain TEXT;
    v_date_code TEXT;
    v_code TEXT;
    v_entity UUID;
    v_text TEXT;
    v_date DATE;
    v_best UUID;
BEGIN
    IF p_root IS NULL THEN
        RETURN NULL;
    END IF;

    IF p_traversal = 'SELF' OR COALESCE(cardinality(p_codes), 0) = 0 THEN
        IF p_match_code IS NOT NULL THEN
            v_text := golden_master.attribute_text(p_root, p_match_code, p_as_of);
            IF v_text IS NULL OR lower(btrim(v_text)) IS DISTINCT FROM lower(btrim(COALESCE(p_match_value, ''))) THEN
                RETURN NULL;
            END IF;
        END IF;
        RETURN p_root;
    END IF;

    v_ids := golden_master.related_ids(p_root, p_traversal, p_codes, p_as_of);
    IF COALESCE(cardinality(v_ids), 0) = 0 THEN
        RETURN NULL;
    END IF;

    SELECT domain_code INTO v_domain
    FROM entity_instances.master_entities
    WHERE id = v_ids[1];

    SELECT attribute_code INTO v_date_code
    FROM metadata_register.attribute_register
    WHERE domain_code = v_domain
      AND data_type = 'DATE'
    ORDER BY display_group NULLS LAST, attribute_code
    LIMIT 1;

    v_code := p_codes[cardinality(p_codes)];
    IF cardinality(p_codes) = 1 THEN
        v_anchor := ARRAY[p_root];
    ELSE
        v_anchor := golden_master.related_ids(p_root, p_traversal, p_codes[1:cardinality(p_codes) - 1], p_as_of);
    END IF;

    FOREACH v_entity IN ARRAY v_ids LOOP
        IF p_match_code IS NOT NULL THEN
            v_text := golden_master.attribute_text(v_entity, p_match_code, p_as_of);
            IF v_text IS NULL OR lower(btrim(v_text)) IS DISTINCT FROM lower(btrim(COALESCE(p_match_value, ''))) THEN
                CONTINUE;
            END IF;
        END IF;
        IF v_date_code IS NOT NULL THEN
            v_date := golden_master.shown_date(v_entity, v_date_code, p_as_of);
            IF v_date IS NOT NULL AND v_date > p_as_of THEN
                CONTINUE;
            END IF;
        END IF;
        v_matched := v_matched || v_entity;
    END LOOP;

    IF COALESCE(cardinality(v_matched), 0) = 0 THEN
        RETURN NULL;
    END IF;

    SELECT picked.id
      INTO v_best
    FROM unnest(v_matched) AS picked(id)
    LEFT JOIN LATERAL (
        SELECT er.valid_from, er.is_primary, er.system_from
        FROM entity_instances.entity_relationships er
        WHERE er.relationship_code = v_code
          AND er.valid_from <= p_as_of
          AND er.valid_to >= p_as_of
          AND er.system_to = golden_master.open_system_to()
          AND (
              (p_traversal = 'UP' AND er.parent_entity_id = picked.id AND er.child_entity_id = ANY (v_anchor))
              OR (p_traversal = 'DOWN' AND er.child_entity_id = picked.id AND er.parent_entity_id = ANY (v_anchor))
          )
        ORDER BY er.valid_from DESC, er.is_primary DESC, er.system_from DESC
        LIMIT 1
    ) edge ON TRUE
    JOIN entity_instances.master_entities me ON me.id = picked.id
    ORDER BY
        CASE WHEN v_date_code IS NULL THEN NULL ELSE golden_master.shown_date(picked.id, v_date_code, p_as_of) END DESC NULLS LAST,
        edge.valid_from DESC NULLS LAST,
        edge.is_primary DESC NULLS LAST,
        edge.system_from DESC NULLS LAST,
        me.created_at DESC
    LIMIT 1;

    RETURN v_best;
END;
$$;

-- The LATEST call that mentions an attribute, and the match it applies.
CREATE OR REPLACE FUNCTION golden_master.latest_spec(
    p_expr JSONB,
    p_attribute TEXT,
    OUT match_code TEXT,
    OUT match_value TEXT,
    OUT is_match BOOLEAN -- not named found: that name is reserved in PL/pgSQL and comes back null
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_temp
AS $$
DECLARE
    v_child JSONB;
    v_nested RECORD;
BEGIN
    is_match := FALSE;
    IF p_expr IS NULL OR jsonb_typeof(p_expr) <> 'object' THEN
        RETURN;
    END IF;

    IF upper(COALESCE(p_expr->>'fn', '')) = 'LATEST'
       AND jsonb_typeof(p_expr->'args') = 'array'
       AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(p_expr->'args') AS arg
           WHERE arg->>'ref' = p_attribute
       ) THEN
        is_match := TRUE;
        IF COALESCE(jsonb_array_length(p_expr->'args'), 0) >= 3
           AND (p_expr->'args'->1) ? 'ref'
           AND (p_expr->'args'->2) ? 'const' THEN
            match_code := p_expr->'args'->1->>'ref';
            match_value := p_expr->'args'->2->>'const';
        END IF;
        RETURN;
    END IF;

    IF p_expr ? 'args' AND jsonb_typeof(p_expr->'args') = 'array' THEN
        FOR v_child IN SELECT value FROM jsonb_array_elements(p_expr->'args') LOOP
            SELECT * INTO v_nested FROM golden_master.latest_spec(v_child, p_attribute);
            IF v_nested.is_match THEN
                match_code := v_nested.match_code;
                match_value := v_nested.match_value;
                is_match := TRUE;
                RETURN;
            END IF;
        END LOOP;
    END IF;

    IF p_expr ? 'asOf' THEN
        SELECT * INTO v_nested FROM golden_master.latest_spec(p_expr->'asOf', p_attribute);
        IF v_nested.is_match THEN
            match_code := v_nested.match_code;
            match_value := v_nested.match_value;
            is_match := TRUE;
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.operand_entity(
    p_calc_id UUID,
    p_entity_id UUID,
    p_attribute TEXT,
    p_traversal TEXT,
    p_codes TEXT[],
    p_as_of DATE,
    p_expr JSONB
) RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, pg_temp
AS $$
DECLARE
    v_spec RECORD;
BEGIN
    SELECT * INTO v_spec FROM golden_master.latest_spec(p_expr, p_attribute);
    IF v_spec.is_match THEN
        RETURN golden_master.related_latest(
            p_entity_id, p_traversal, p_codes, p_as_of, v_spec.match_code, v_spec.match_value
        );
    END IF;
    IF p_traversal = 'SELF' OR COALESCE(cardinality(p_codes), 0) = 0 THEN
        RETURN p_entity_id;
    END IF;
    RETURN golden_master.related_one(p_entity_id, p_traversal, p_codes, p_as_of);
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.rewrite_latest(
    p_expr JSONB,
    p_entity_id UUID,
    p_calc_id UUID,
    p_as_of DATE,
    p_depth INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $$
DECLARE
    v_args JSONB := '[]'::jsonb;
    v_index INTEGER;
    v_count INTEGER;
    v_code TEXT;
    v_match_code TEXT;
    v_match_value TEXT;
    v_match_text TEXT;
    v_input metadata_register.calc_inputs%ROWTYPE;
    v_entity UUID;
    v_literal JSONB;
BEGIN
    IF p_expr IS NULL OR jsonb_typeof(p_expr) <> 'object' THEN
        RETURN p_expr;
    END IF;

    IF upper(COALESCE(p_expr->>'fn', '')) = 'LATEST' THEN
        v_count := COALESCE(jsonb_array_length(p_expr->'args'), 0);
        v_code := p_expr->'args'->0->>'ref';
        IF v_code IS NULL OR (v_count <> 1 AND v_count <> 3) THEN
            RETURN jsonb_build_object('const', NULL);
        END IF;
        IF v_count = 3 THEN
            v_match_code := p_expr->'args'->1->>'ref';
            IF v_match_code IS NULL OR NOT ((p_expr->'args'->2) ? 'const') THEN
                RETURN jsonb_build_object('const', NULL);
            END IF;
            v_match_value := p_expr->'args'->2->>'const';
        END IF;

        SELECT * INTO v_input
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = p_calc_id
          AND input_role = 'OPERAND'
          AND attribute_code = v_code
        ORDER BY ordinal
        LIMIT 1;

        IF NOT FOUND OR v_input.traversal = 'SELF' OR COALESCE(cardinality(v_input.relationship_codes), 0) = 0 THEN
            v_entity := p_entity_id;
            IF v_match_code IS NOT NULL THEN
                v_match_text := golden_master.attribute_text(v_entity, v_match_code, p_as_of);
                IF v_match_text IS NULL
                   OR lower(btrim(v_match_text)) IS DISTINCT FROM lower(btrim(COALESCE(v_match_value, ''))) THEN
                    v_entity := NULL;
                END IF;
            END IF;
        ELSE
            v_entity := golden_master.related_latest(
                p_entity_id, v_input.traversal, v_input.relationship_codes, p_as_of, v_match_code, v_match_value
            );
        END IF;

        IF v_entity IS NULL THEN
            RETURN jsonb_build_object('const', NULL);
        END IF;
        v_literal := golden_master.golden_literal(v_entity, v_code, p_as_of, p_depth + 1);
        IF v_literal IS NULL OR jsonb_typeof(v_literal) = 'null' THEN
            v_match_text := golden_master.attribute_text(v_entity, v_code, p_as_of);
            IF v_match_text IS NULL OR btrim(v_match_text) = '' THEN
                RETURN jsonb_build_object('const', NULL);
            END IF;
            IF v_match_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
                v_literal := to_jsonb(v_match_text::NUMERIC);
            ELSE
                v_literal := to_jsonb(v_match_text);
            END IF;
        END IF;
        RETURN jsonb_set('{"const":null}'::jsonb, '{const}', v_literal);
    END IF;

    IF p_expr ? 'args' AND jsonb_typeof(p_expr->'args') = 'array' THEN
        FOR v_index IN 0..jsonb_array_length(p_expr->'args') - 1 LOOP
            v_args := v_args || jsonb_build_array(
                golden_master.rewrite_latest(p_expr->'args'->v_index, p_entity_id, p_calc_id, p_as_of, p_depth)
            );
        END LOOP;
        p_expr := p_expr || jsonb_build_object('args', v_args);
    END IF;

    IF p_expr ? 'asOf' THEN
        p_expr := p_expr || jsonb_build_object(
            'asOf',
            golden_master.rewrite_latest(p_expr->'asOf', p_entity_id, p_calc_id, p_as_of, p_depth)
        );
    END IF;

    RETURN p_expr;
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
    v_expr JSONB;
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
        v_entity := golden_master.operand_entity(
            p_calc_id, p_entity_id, v_input.attribute_code, v_input.traversal,
            v_input.relationship_codes, p_as_of, v_def.expression
        );
        IF v_entity IS NULL THEN
            v_literal := 'null'::JSONB;
        ELSE
            v_literal := golden_master.golden_literal(v_entity, v_input.attribute_code, p_as_of, p_depth + 1);
        END IF;
        v_vars := v_vars || jsonb_build_object(v_input.attribute_code, v_literal);
    END LOOP;

    v_vars := v_vars || jsonb_build_object('CURRENT_DATE', to_jsonb(p_as_of::TEXT));
    v_expr := golden_master.rewrite_latest(v_def.expression, p_entity_id, p_calc_id, p_as_of, p_depth);
    v_bound := golden_master.rewrite_as_of(v_expr, p_entity_id, p_calc_id, p_as_of, p_depth, v_vars);
    RETURN metadata_register.eval_expr(v_bound->'expr', v_bound->'vars');
END;
$$;

CREATE OR REPLACE FUNCTION metadata_register.assert_calc_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
    v_def metadata_register.calc_definitions%ROWTYPE;
    v_refs TEXT[];
    v_missing TEXT;
BEGIN
    SELECT * INTO v_def FROM metadata_register.calc_definitions WHERE id = NEW.id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF v_def.calc_kind = 'AGGREGATE' OR v_def.calc_kind = 'SERIES' THEN
        IF v_def.evaluation_mode <> 'MATERIALIZED' THEN
            RAISE EXCEPTION '% calcs are materialized', v_def.calc_kind;
        END IF;
    END IF;

    IF v_def.evaluation_mode = 'ON_READ' AND v_def.calc_kind <> 'EXPRESSION' THEN
        RAISE EXCEPTION 'On-read calcs must be expressions';
    END IF;

    IF EXISTS (
        SELECT 1 FROM metadata_register.calc_inputs ci
        WHERE ci.calc_definition_id = v_def.id
          AND (
              (ci.traversal = 'SELF' AND cardinality(ci.relationship_codes) > 0)
              OR (ci.traversal <> 'SELF' AND cardinality(ci.relationship_codes) = 0)
          )
    ) THEN
        RAISE EXCEPTION 'SELF inputs have no relationship path; UP and DOWN inputs require one';
    END IF;

    IF v_def.calc_kind = 'EXPRESSION' THEN
        IF v_def.expression IS NULL THEN
            RAISE EXCEPTION 'Expression calcs require an expression';
        END IF;
        v_refs := metadata_register.expr_refs(v_def.expression);
        SELECT ref INTO v_missing
        FROM unnest(v_refs) AS ref
        WHERE upper(ref) <> 'CURRENT_DATE'
          AND NOT EXISTS (
            SELECT 1 FROM metadata_register.calc_inputs ci
            WHERE ci.calc_definition_id = v_def.id
              AND ci.input_role = 'OPERAND'
              AND ci.attribute_code = ref
        )
        LIMIT 1;
        IF v_missing IS NOT NULL THEN
            RAISE EXCEPTION 'Expression ref % has no OPERAND input', v_missing;
        END IF;
    ELSIF v_def.calc_kind = 'AGGREGATE' THEN
        IF v_def.aggregate_fn IS NULL THEN
            RAISE EXCEPTION 'Aggregate calcs require an aggregate function';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM metadata_register.calc_inputs ci
            WHERE ci.calc_definition_id = v_def.id AND ci.input_role = 'MEASURE'
        ) THEN
            RAISE EXCEPTION 'Aggregate calcs require a MEASURE input';
        END IF;
        IF v_def.aggregate_fn = 'WAVG' AND NOT EXISTS (
            SELECT 1 FROM metadata_register.calc_inputs ci
            WHERE ci.calc_definition_id = v_def.id AND ci.input_role = 'WEIGHT'
        ) THEN
            RAISE EXCEPTION 'Weighted average calcs require a WEIGHT input';
        END IF;
    ELSIF v_def.calc_kind = 'SERIES' THEN
        IF v_def.series_fn IS NULL THEN
            RAISE EXCEPTION 'Series calcs require a series function';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM metadata_register.calc_inputs
            WHERE calc_definition_id = v_def.id AND input_role = 'AMOUNT'
        ) OR NOT EXISTS (
            SELECT 1 FROM metadata_register.calc_inputs
            WHERE calc_definition_id = v_def.id AND input_role = 'FLOW_DATE'
        ) OR NOT EXISTS (
            SELECT 1 FROM metadata_register.calc_inputs
            WHERE calc_definition_id = v_def.id AND input_role = 'TERMINAL'
        ) THEN
            RAISE EXCEPTION 'Series calcs require AMOUNT, FLOW_DATE, and TERMINAL inputs';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- explain_calc shows the record LATEST actually read.
CREATE OR REPLACE FUNCTION public.explain_calc(
    p_entity_id UUID,
    p_attribute_code TEXT,
    p_as_of DATE DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_as_of DATE := COALESCE(p_as_of, CURRENT_DATE);
    v_def metadata_register.calc_definitions%ROWTYPE;
    v_code TEXT;
    v_input metadata_register.calc_inputs%ROWTYPE;
    v_amount metadata_register.calc_inputs%ROWTYPE;
    v_date metadata_register.calc_inputs%ROWTYPE;
    v_terminal metadata_register.calc_inputs%ROWTYPE;
    v_weight_code TEXT;
    v_components JSONB := '[]'::jsonb;
    v_count INTEGER := 0;
    v_truncated BOOLEAN := FALSE;
    v_limit INTEGER := 40;
    v_entity UUID;
    v_ids UUID[];
    v_result JSONB;
    v_numeric NUMERIC;
    v_text TEXT;
    v_flow_date DATE;
    v_amount_value NUMERIC;
BEGIN
    SELECT cd.* INTO v_def
    FROM metadata_register.calc_definitions cd
    JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
    WHERE ar.attribute_code = p_attribute_code;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT ar.attribute_code INTO v_code
    FROM metadata_register.attribute_register ar
    WHERE ar.id = v_def.attribute_id;

    IF v_def.calc_kind = 'EXPRESSION' THEN
        FOR v_input IN
            SELECT * FROM metadata_register.calc_inputs
            WHERE calc_definition_id = v_def.id AND input_role = 'OPERAND'
            ORDER BY ordinal, attribute_code
        LOOP
            v_entity := golden_master.operand_entity(
                v_def.id, p_entity_id, v_input.attribute_code, v_input.traversal,
                v_input.relationship_codes, v_as_of, v_def.expression
            );
            v_components := v_components || jsonb_build_array(golden_master.describe_calc_component(
                v_def.domain_code, v_entity, v_input.attribute_code, v_input.input_role,
                v_input.traversal, v_input.relationship_codes, v_as_of, 1, NULL
            ));
        END LOOP;
        v_result := golden_master.eval_expression_result(v_def.id, p_entity_id, v_as_of, 0);
        IF v_result IS NOT NULL AND jsonb_typeof(v_result) <> 'null' THEN
            v_text := v_result #>> '{}';
        END IF;
    ELSIF v_def.calc_kind = 'AGGREGATE' THEN
        SELECT * INTO v_input
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'MEASURE'
        LIMIT 1;

        SELECT attribute_code INTO v_weight_code
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'WEIGHT'
        LIMIT 1;

        IF v_input.attribute_code IS NOT NULL THEN
        v_ids := golden_master.related_ids(p_entity_id, v_input.traversal, v_input.relationship_codes, v_as_of);
        IF v_ids IS NOT NULL THEN
            FOREACH v_entity IN ARRAY v_ids LOOP
                v_count := v_count + 1;
                IF v_count > v_limit THEN
                    v_truncated := TRUE;
                    EXIT;
                END IF;
                v_components := v_components || jsonb_build_array(golden_master.describe_calc_component(
                    v_def.domain_code, v_entity, v_input.attribute_code, 'MEASURE',
                    v_input.traversal, v_input.relationship_codes, v_as_of, 1, NULL
                ));
                IF v_weight_code IS NOT NULL THEN
                    v_components := v_components || jsonb_build_array(golden_master.describe_calc_component(
                        v_def.domain_code, v_entity, v_weight_code, 'WEIGHT',
                        v_input.traversal, v_input.relationship_codes, v_as_of, 1, NULL
                    ));
                END IF;
            END LOOP;
        END IF;
        END IF;
        v_numeric := golden_master.eval_calc(v_def.id, p_entity_id, v_as_of, 0);
        IF v_numeric IS NOT NULL THEN
            v_text := v_numeric::TEXT;
        END IF;
    ELSE
        SELECT * INTO v_amount
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'AMOUNT'
        LIMIT 1;
        SELECT * INTO v_date
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'FLOW_DATE'
        LIMIT 1;
        SELECT * INTO v_terminal
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = v_def.id AND input_role = 'TERMINAL'
        LIMIT 1;

        IF v_amount.attribute_code IS NOT NULL THEN
        v_ids := golden_master.related_ids(p_entity_id, v_amount.traversal, v_amount.relationship_codes, v_as_of);
        IF v_ids IS NOT NULL THEN
            FOREACH v_entity IN ARRAY v_ids LOOP
                v_amount_value := golden_master.golden_numeric(v_entity, v_amount.attribute_code, v_as_of, 1);
                v_flow_date := golden_master.golden_date(v_entity, v_date.attribute_code, v_as_of);
                IF v_amount_value IS NULL OR v_flow_date IS NULL OR v_flow_date > v_as_of THEN
                    CONTINUE;
                END IF;
                v_count := v_count + 1;
                IF v_count > v_limit THEN
                    v_truncated := TRUE;
                    EXIT;
                END IF;
                v_components := v_components || jsonb_build_array(golden_master.describe_calc_component(
                    v_def.domain_code, v_entity, v_amount.attribute_code, 'AMOUNT',
                    v_amount.traversal, v_amount.relationship_codes, v_as_of, 1, v_flow_date::TEXT
                ));
            END LOOP;
        END IF;
        END IF;

        IF v_terminal.attribute_code IS NOT NULL THEN
            v_components := v_components || jsonb_build_array(golden_master.describe_calc_component(
                v_def.domain_code, p_entity_id, v_terminal.attribute_code, 'TERMINAL',
                'SELF', '{}'::text[], v_as_of, 1, 'Terminal value'
            ));
        END IF;
        v_numeric := golden_master.eval_calc(v_def.id, p_entity_id, v_as_of, 0);
        IF v_numeric IS NOT NULL THEN
            v_text := v_numeric::TEXT;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'attributeCode', v_code,
        'calcKind', v_def.calc_kind,
        'domainCode', v_def.domain_code,
        'expression', v_def.expression,
        'value', v_text,
        'truncated', v_truncated,
        'components', v_components
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.on_read_attribute_values(
    p_entity_id UUID,
    p_as_of DATE DEFAULT NULL
) RETURNS TABLE(attribute_code VARCHAR, attribute_name TEXT, value_text TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_as_of DATE := COALESCE(p_as_of, CURRENT_DATE);
    v_row RECORD;
    v_value JSONB;
    v_text TEXT;
BEGIN
    FOR v_row IN
        SELECT ar.attribute_code, ar.attribute_name, cd.id AS calc_id
        FROM metadata_register.calc_definitions cd
        JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
        JOIN entity_instances.master_entities me ON me.id = p_entity_id
        WHERE cd.evaluation_mode = 'ON_READ'
          AND cd.calc_kind = 'EXPRESSION'
          AND cd.domain_code = me.domain_code
    LOOP
        v_value := golden_master.eval_expression_result(v_row.calc_id, p_entity_id, v_as_of, 0);
        IF v_value IS NULL OR jsonb_typeof(v_value) = 'null' THEN
            CONTINUE;
        END IF;
        v_text := v_value #>> '{}';
        IF v_text IS NULL OR btrim(v_text) = '' THEN
            CONTINUE;
        END IF;
        attribute_code := v_row.attribute_code;
        attribute_name := v_row.attribute_name;
        value_text := v_text;
        RETURN NEXT;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION golden_master.attribute_text(UUID, VARCHAR, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.shown_date(UUID, VARCHAR, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.related_latest(UUID, TEXT, TEXT[], DATE, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.latest_spec(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.operand_entity(UUID, UUID, TEXT, TEXT, TEXT[], DATE, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.rewrite_latest(JSONB, UUID, UUID, DATE, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.on_read_attribute_values(UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.on_read_attribute_values(UUID, DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.explain_calc(UUID, TEXT, DATE) TO authenticated, service_role;

INSERT INTO metadata_register.expression_functions (
    id, function_code, function_name, category, return_type, description, signature, example, callable, sort_order
) VALUES (
    'ROW:LATEST', 'LATEST', 'Latest related value', 'ROW', 'VALUE',
    'Reads an attribute on the latest related record. The record is the one whose period date is the latest on or before the as-of date. LATEST(PERIOD_EBITDA, PERIOD_LABEL, "LTM") keeps only records whose label is LTM, then takes the latest. The field''s relationship path says which records are tied to this one.',
    'LATEST(attribute)',
    '{"fn":"LATEST","args":[{"ref":"PERIOD_EBITDA"},{"ref":"PERIOD_LABEL"},{"const":"LTM"}]}'::jsonb,
    TRUE, 181
)
ON CONFLICT (id) DO UPDATE SET
    function_name = EXCLUDED.function_name,
    description = EXCLUDED.description,
    signature = EXCLUDED.signature,
    example = EXCLUDED.example,
    callable = EXCLUDED.callable,
    sort_order = EXCLUDED.sort_order;

-- Issuer financials follow the financial records tied to the issuer.
-- LTM EBITDA, LTM revenue, and total funded debt come from the latest financial
-- period whose label is LTM. Cash comes from the latest statement period.

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, expression
)
SELECT ar.id, 'ISSUER', 'EXPRESSION', 'ON_READ', 'FORWARD', 'ON_INPUT_CHANGE', v.expression::jsonb
FROM (VALUES
    ('EBITDA_LTM', '{"fn":"LATEST","args":[{"ref":"PERIOD_EBITDA"},{"ref":"PERIOD_LABEL"},{"const":"LTM"}]}'),
    ('REVENUE_LTM', '{"fn":"LATEST","args":[{"ref":"PERIOD_REVENUE"},{"ref":"PERIOD_LABEL"},{"const":"LTM"}]}'),
    ('TOTAL_DEBT_AMOUNT', '{"op":"mul","args":[{"fn":"LATEST","args":[{"ref":"PERIOD_FUNDED_DEBT_TO_EBITDA"},{"ref":"PERIOD_LABEL"},{"const":"LTM"}]},{"fn":"LATEST","args":[{"ref":"PERIOD_EBITDA"},{"ref":"PERIOD_LABEL"},{"const":"LTM"}]}]}'),
    ('CASH_AND_EQUIVALENTS_AMOUNT', '{"fn":"LATEST","args":[{"ref":"STATEMENT_CASH"}]}')
) AS v(code, expression)
JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.code
ON CONFLICT (attribute_id) DO UPDATE
SET expression = EXCLUDED.expression,
    calc_kind = EXCLUDED.calc_kind,
    evaluation_mode = EXCLUDED.evaluation_mode,
    domain_code = EXCLUDED.domain_code,
    updated_at = NOW();

INSERT INTO metadata_register.calc_inputs (
    calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal
)
SELECT cd.id, 'OPERAND', v.code, 'UP', ARRAY[v.rel], v.ord
FROM (VALUES
    ('EBITDA_LTM', 'PERIOD_EBITDA', 'PERIOD_ISSUER', 1),
    ('EBITDA_LTM', 'PERIOD_LABEL', 'PERIOD_ISSUER', 2),
    ('REVENUE_LTM', 'PERIOD_REVENUE', 'PERIOD_ISSUER', 1),
    ('REVENUE_LTM', 'PERIOD_LABEL', 'PERIOD_ISSUER', 2),
    ('TOTAL_DEBT_AMOUNT', 'PERIOD_FUNDED_DEBT_TO_EBITDA', 'PERIOD_ISSUER', 1),
    ('TOTAL_DEBT_AMOUNT', 'PERIOD_EBITDA', 'PERIOD_ISSUER', 2),
    ('TOTAL_DEBT_AMOUNT', 'PERIOD_LABEL', 'PERIOD_ISSUER', 3),
    ('CASH_AND_EQUIVALENTS_AMOUNT', 'STATEMENT_CASH', 'STATEMENT_ISSUER', 1)
) AS v(calc, code, rel, ord)
JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.calc
JOIN metadata_register.calc_definitions cd ON cd.attribute_id = ar.id
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO UPDATE
SET traversal = EXCLUDED.traversal,
    relationship_codes = EXCLUDED.relationship_codes,
    ordinal = EXCLUDED.ordinal;

UPDATE metadata_register.attribute_register
SET is_editable = FALSE,
    description = CASE attribute_code
        WHEN 'EBITDA_LTM' THEN 'LTM EBITDA from the latest LTM financial period of this issuer.'
        WHEN 'REVENUE_LTM' THEN 'LTM revenue from the latest LTM financial period of this issuer.'
        WHEN 'TOTAL_DEBT_AMOUNT' THEN 'Funded debt on the latest LTM financial period: funded debt to EBITDA, times LTM EBITDA.'
        WHEN 'CASH_AND_EQUIVALENTS_AMOUNT' THEN 'Cash and equivalents on the latest statement period of this issuer.'
        ELSE description
    END,
    updated_at = NOW()
WHERE attribute_code IN ('EBITDA_LTM', 'REVENUE_LTM', 'TOTAL_DEBT_AMOUNT', 'CASH_AND_EQUIVALENTS_AMOUNT');

NOTIFY pgrst, 'reload schema';
