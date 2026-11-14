-- LATEST follows both clocks on the record.
-- A null knowledge time keeps the currently open row.
-- A knowledge instant keeps the row that was open then:
-- system_from <= knowledge AND system_to > knowledge.
-- That is the same window the record screen uses for stored history.

CREATE OR REPLACE FUNCTION golden_master.row_known(
    p_system_from TIMESTAMPTZ,
    p_system_to TIMESTAMPTZ,
    p_knowledge TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = golden_master, pg_temp
AS $$
    SELECT CASE
        WHEN p_knowledge IS NULL THEN p_system_to = golden_master.open_system_to()
        ELSE p_system_from <= p_knowledge AND p_system_to > p_knowledge
    END;
$$;

DROP FUNCTION IF EXISTS golden_master.related_ids(uuid, text, text[], date);
DROP FUNCTION IF EXISTS golden_master.related_one(uuid, text, text[], date);
DROP FUNCTION IF EXISTS golden_master.attribute_text(uuid, character varying, date);
DROP FUNCTION IF EXISTS golden_master.shown_date(uuid, character varying, date);
DROP FUNCTION IF EXISTS golden_master.related_latest(uuid, text, text[], date, text, text);
DROP FUNCTION IF EXISTS golden_master.operand_entity(uuid, uuid, text, text, text[], date, jsonb);
DROP FUNCTION IF EXISTS golden_master.rewrite_latest(jsonb, uuid, uuid, date, integer);
DROP FUNCTION IF EXISTS golden_master.rewrite_as_of(jsonb, uuid, uuid, date, integer, jsonb);
DROP FUNCTION IF EXISTS golden_master.eval_expression_result(uuid, uuid, date, integer);
DROP FUNCTION IF EXISTS golden_master.golden_literal(uuid, character varying, date, integer);
DROP FUNCTION IF EXISTS golden_master.describe_calc_component(text, uuid, character varying, text, text, text[], date, integer, text);
DROP FUNCTION IF EXISTS public.on_read_attribute_values(uuid, date);
DROP FUNCTION IF EXISTS public.explain_calc(uuid, text, date);

CREATE FUNCTION golden_master.related_ids(
    p_root UUID,
    p_traversal TEXT,
    p_codes TEXT[],
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID[]
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, entity_instances, pg_temp
AS $$
DECLARE
    v_current UUID[] := ARRAY[p_root];
    v_next UUID[];
    v_code TEXT;
BEGIN
    IF p_traversal = 'SELF' OR COALESCE(cardinality(p_codes), 0) = 0 THEN
        RETURN v_current;
    END IF;

    FOREACH v_code IN ARRAY p_codes LOOP
        IF p_traversal = 'DOWN' THEN
            SELECT COALESCE(array_agg(DISTINCT er.child_entity_id), '{}')
              INTO v_next
            FROM entity_instances.entity_relationships er
            WHERE er.parent_entity_id = ANY (v_current)
              AND er.relationship_code = v_code
              AND er.valid_from <= p_as_of
              AND er.valid_to >= p_as_of
              AND golden_master.row_known(er.system_from, er.system_to, p_knowledge);
        ELSE
            SELECT COALESCE(array_agg(DISTINCT er.parent_entity_id), '{}')
              INTO v_next
            FROM entity_instances.entity_relationships er
            WHERE er.child_entity_id = ANY (v_current)
              AND er.relationship_code = v_code
              AND er.valid_from <= p_as_of
              AND er.valid_to >= p_as_of
              AND golden_master.row_known(er.system_from, er.system_to, p_knowledge);
        END IF;
        v_current := v_next;
        EXIT WHEN cardinality(v_current) = 0;
    END LOOP;

    RETURN v_current;
END;
$$;

CREATE FUNCTION golden_master.related_one(
    p_root UUID,
    p_traversal TEXT,
    p_codes TEXT[],
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, entity_instances, pg_temp
AS $$
DECLARE
    v_ids UUID[];
    v_code TEXT;
    v_picked UUID;
BEGIN
    v_ids := golden_master.related_ids(p_root, p_traversal, p_codes, p_as_of, p_knowledge);
    IF COALESCE(cardinality(v_ids), 0) = 0 THEN
        RETURN NULL;
    END IF;
    IF cardinality(v_ids) = 1 OR p_traversal = 'SELF' THEN
        RETURN v_ids[1];
    END IF;

    v_code := p_codes[cardinality(p_codes)];
    IF p_traversal = 'UP' THEN
        SELECT er.parent_entity_id INTO v_picked
        FROM entity_instances.entity_relationships er
        WHERE er.child_entity_id = ANY (golden_master.related_ids(p_root, p_traversal, p_codes[1:cardinality(p_codes) - 1], p_as_of, p_knowledge))
          AND er.parent_entity_id = ANY (v_ids)
          AND er.relationship_code = v_code
          AND er.valid_from <= p_as_of
          AND er.valid_to >= p_as_of
          AND golden_master.row_known(er.system_from, er.system_to, p_knowledge)
        ORDER BY er.is_primary DESC, er.valid_from DESC
        LIMIT 1;
    ELSE
        SELECT er.child_entity_id INTO v_picked
        FROM entity_instances.entity_relationships er
        WHERE er.parent_entity_id = ANY (golden_master.related_ids(p_root, p_traversal, p_codes[1:cardinality(p_codes) - 1], p_as_of, p_knowledge))
          AND er.child_entity_id = ANY (v_ids)
          AND er.relationship_code = v_code
          AND er.valid_from <= p_as_of
          AND er.valid_to >= p_as_of
          AND golden_master.row_known(er.system_from, er.system_to, p_knowledge)
        ORDER BY er.is_primary DESC, er.valid_from DESC
        LIMIT 1;
    END IF;
    RETURN COALESCE(v_picked, v_ids[1]);
END;
$$;

CREATE FUNCTION golden_master.attribute_text(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $$
DECLARE
    v_text TEXT;
BEGIN
    SELECT eav.golden_value
      INTO v_text
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

CREATE FUNCTION golden_master.shown_date(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS DATE
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $$
DECLARE
    v_date DATE;
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
      AND golden_master.row_known(eav.system_from, eav.system_to, p_knowledge)
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

CREATE FUNCTION golden_master.related_latest(
    p_root UUID,
    p_traversal TEXT,
    p_codes TEXT[],
    p_as_of DATE,
    p_match_code TEXT DEFAULT NULL,
    p_match_value TEXT DEFAULT NULL,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
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
            v_text := golden_master.attribute_text(p_root, p_match_code, p_as_of, p_knowledge);
            IF v_text IS NULL OR lower(btrim(v_text)) IS DISTINCT FROM lower(btrim(COALESCE(p_match_value, ''))) THEN
                RETURN NULL;
            END IF;
        END IF;
        RETURN p_root;
    END IF;

    v_ids := golden_master.related_ids(p_root, p_traversal, p_codes, p_as_of, p_knowledge);
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
        v_anchor := golden_master.related_ids(p_root, p_traversal, p_codes[1:cardinality(p_codes) - 1], p_as_of, p_knowledge);
    END IF;

    FOREACH v_entity IN ARRAY v_ids LOOP
        IF p_match_code IS NOT NULL THEN
            v_text := golden_master.attribute_text(v_entity, p_match_code, p_as_of, p_knowledge);
            IF v_text IS NULL OR lower(btrim(v_text)) IS DISTINCT FROM lower(btrim(COALESCE(p_match_value, ''))) THEN
                CONTINUE;
            END IF;
        END IF;
        IF v_date_code IS NOT NULL THEN
            v_date := golden_master.shown_date(v_entity, v_date_code, p_as_of, p_knowledge);
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
          AND golden_master.row_known(er.system_from, er.system_to, p_knowledge)
          AND (
              (p_traversal = 'UP' AND er.parent_entity_id = picked.id AND er.child_entity_id = ANY (v_anchor))
              OR (p_traversal = 'DOWN' AND er.child_entity_id = picked.id AND er.parent_entity_id = ANY (v_anchor))
          )
        ORDER BY er.valid_from DESC, er.is_primary DESC, er.system_from DESC
        LIMIT 1
    ) edge ON TRUE
    JOIN entity_instances.master_entities me ON me.id = picked.id
    ORDER BY
        CASE WHEN v_date_code IS NULL THEN NULL ELSE golden_master.shown_date(picked.id, v_date_code, p_as_of, p_knowledge) END DESC NULLS LAST,
        edge.valid_from DESC NULLS LAST,
        edge.is_primary DESC NULLS LAST,
        edge.system_from DESC NULLS LAST,
        me.created_at DESC
    LIMIT 1;

    RETURN v_best;
END;
$$;

CREATE FUNCTION golden_master.operand_entity(
    p_calc_id UUID,
    p_entity_id UUID,
    p_attribute TEXT,
    p_traversal TEXT,
    p_codes TEXT[],
    p_as_of DATE,
    p_expr JSONB,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, pg_temp
AS $$
DECLARE
    v_spec RECORD;
BEGIN
    SELECT * INTO v_spec FROM golden_master.latest_spec(p_expr, p_attribute);
    IF COALESCE(v_spec.is_match, FALSE) THEN
        RETURN golden_master.related_latest(
            p_entity_id, p_traversal, p_codes, p_as_of, v_spec.match_code, v_spec.match_value, p_knowledge
        );
    END IF;
    IF p_traversal = 'SELF' OR COALESCE(cardinality(p_codes), 0) = 0 THEN
        RETURN p_entity_id;
    END IF;
    RETURN golden_master.related_one(p_entity_id, p_traversal, p_codes, p_as_of, p_knowledge);
END;
$$;

CREATE FUNCTION golden_master.golden_literal(
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
    IF p_depth > 8 OR p_entity_id IS NULL THEN
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
      AND eav.source_id = eav.golden_source_id
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND golden_master.row_known(eav.system_from, eav.system_to, p_knowledge)
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

CREATE FUNCTION golden_master.rewrite_latest(
    p_expr JSONB,
    p_entity_id UUID,
    p_calc_id UUID,
    p_as_of DATE,
    p_depth INTEGER,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
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
                v_match_text := golden_master.attribute_text(v_entity, v_match_code, p_as_of, p_knowledge);
                IF v_match_text IS NULL
                   OR lower(btrim(v_match_text)) IS DISTINCT FROM lower(btrim(COALESCE(v_match_value, ''))) THEN
                    v_entity := NULL;
                END IF;
            END IF;
        ELSE
            v_entity := golden_master.related_latest(
                p_entity_id, v_input.traversal, v_input.relationship_codes, p_as_of, v_match_code, v_match_value, p_knowledge
            );
        END IF;

        IF v_entity IS NULL THEN
            RETURN jsonb_build_object('const', NULL);
        END IF;
        v_literal := golden_master.golden_literal(v_entity, v_code, p_as_of, p_depth + 1, p_knowledge);
        IF v_literal IS NULL OR jsonb_typeof(v_literal) = 'null' THEN
            v_match_text := golden_master.attribute_text(v_entity, v_code, p_as_of, p_knowledge);
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
                golden_master.rewrite_latest(p_expr->'args'->v_index, p_entity_id, p_calc_id, p_as_of, p_depth, p_knowledge)
            );
        END LOOP;
        p_expr := p_expr || jsonb_build_object('args', v_args);
    END IF;

    IF p_expr ? 'asOf' THEN
        p_expr := p_expr || jsonb_build_object(
            'asOf',
            golden_master.rewrite_latest(p_expr->'asOf', p_entity_id, p_calc_id, p_as_of, p_depth, p_knowledge)
        );
    END IF;

    RETURN p_expr;
END;
$$;

CREATE FUNCTION golden_master.rewrite_as_of(
    p_expr JSONB,
    p_entity_id UUID,
    p_calc_id UUID,
    p_as_of DATE,
    p_depth INTEGER,
    p_vars JSONB,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
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
        v_step := golden_master.rewrite_as_of(p_expr->'asOf', p_entity_id, p_calc_id, p_as_of, p_depth, v_vars, p_knowledge);
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
            v_entity := golden_master.related_one(p_entity_id, v_input.traversal, v_input.relationship_codes, p_as_of, p_knowledge);
        END IF;
        IF v_entity IS NULL OR v_date IS NULL THEN
            v_literal := 'null'::JSONB;
            v_key := v_code || '@';
        ELSE
            v_literal := golden_master.golden_literal(v_entity, v_code, v_date, p_depth + 1, p_knowledge);
            v_key := v_code || '@' || v_date::TEXT;
        END IF;
        v_vars := v_vars || jsonb_build_object(v_key, COALESCE(v_literal, 'null'::JSONB));
        RETURN jsonb_build_object('expr', jsonb_build_object('ref', v_key), 'vars', v_vars);
    END IF;

    IF p_expr ? 'args' AND jsonb_typeof(p_expr->'args') = 'array' THEN
        FOR v_index IN 0..jsonb_array_length(p_expr->'args') - 1 LOOP
            v_step := golden_master.rewrite_as_of(p_expr->'args'->v_index, p_entity_id, p_calc_id, p_as_of, p_depth, v_vars, p_knowledge);
            v_vars := v_step->'vars';
            v_args := v_args || jsonb_build_array(v_step->'expr');
        END LOOP;
        RETURN jsonb_build_object('expr', p_expr || jsonb_build_object('args', v_args), 'vars', v_vars);
    END IF;

    RETURN jsonb_build_object('expr', p_expr, 'vars', v_vars);
END;
$$;

CREATE FUNCTION golden_master.eval_expression_result(
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
    v_bound := golden_master.rewrite_as_of(v_expr, p_entity_id, p_calc_id, p_as_of, p_depth, v_vars, p_knowledge);
    RETURN metadata_register.eval_expr(v_bound->'expr', v_bound->'vars');
END;
$$;

CREATE FUNCTION golden_master.describe_calc_component(
    p_root_domain TEXT,
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_role TEXT,
    p_traversal TEXT,
    p_codes TEXT[],
    p_as_of DATE,
    p_depth INTEGER,
    p_detail TEXT,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_name TEXT;
    v_home TEXT;
    v_home_name TEXT;
    v_domain TEXT := p_root_domain;
    v_domain_name TEXT;
    v_code TEXT;
    v_parent TEXT;
    v_child TEXT;
    v_entity_code TEXT;
    v_entity_name TEXT;
    v_entity_domain TEXT;
    v_literal JSONB;
    v_value TEXT;
    v_names JSONB := '[]'::jsonb;
    v_calculated BOOLEAN;
BEGIN
    SELECT ar.attribute_name, ar.domain_code, dt.domain_name
      INTO v_name, v_home, v_home_name
    FROM metadata_register.attribute_register ar
    LEFT JOIN metadata_register.domain_types dt ON dt.domain_code = ar.domain_code
    WHERE ar.attribute_code = p_attribute_code;

    IF p_traversal <> 'SELF' AND COALESCE(cardinality(p_codes), 0) > 0 THEN
        FOREACH v_code IN ARRAY p_codes LOOP
            SELECT parent_domain_code, child_domain_code
              INTO v_parent, v_child
            FROM metadata_register.relationship_types
            WHERE relationship_code = v_code;
            IF p_traversal = 'DOWN' AND v_parent = v_domain THEN
                v_domain := v_child;
            ELSIF p_traversal = 'UP' AND v_child = v_domain THEN
                v_domain := v_parent;
            END IF;
        END LOOP;
    END IF;

    IF p_entity_id IS NOT NULL THEN
        SELECT entity_code, entity_name, domain_code
          INTO v_entity_code, v_entity_name, v_entity_domain
        FROM entity_instances.master_entities
        WHERE id = p_entity_id;
        IF v_entity_domain IS NOT NULL THEN
            v_domain := v_entity_domain;
        END IF;
        v_literal := golden_master.golden_literal(p_entity_id, p_attribute_code, p_as_of, p_depth, p_knowledge);
        IF v_literal IS NULL OR jsonb_typeof(v_literal) = 'null' THEN
            v_value := NULL;
        ELSE
            v_value := v_literal #>> '{}';
        END IF;
        IF v_value IS NULL THEN
            SELECT COALESCE(eav.golden_value_numeric::TEXT, eav.golden_value)
              INTO v_value
            FROM golden_master.entity_attribute_values eav
            JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
            WHERE eav.entity_id = p_entity_id
              AND ar.attribute_code = p_attribute_code
              AND eav.valid_from <= p_as_of
              AND eav.valid_to >= p_as_of
              AND golden_master.row_known(eav.system_from, eav.system_to, p_knowledge)
              AND COALESCE(eav.golden_value, '') <> ''
            ORDER BY
                CASE WHEN eav.source_id IS NOT DISTINCT FROM eav.golden_source_id THEN 0 ELSE 1 END,
                eav.precedence_rank NULLS LAST
            LIMIT 1;
        END IF;
    END IF;

    SELECT domain_name INTO v_domain_name
    FROM metadata_register.domain_types
    WHERE domain_code = v_domain;

    SELECT COALESCE(jsonb_agg(COALESCE(rt.relationship_name, ord.code) ORDER BY ord.ordinality), '[]'::jsonb)
      INTO v_names
    FROM unnest(COALESCE(p_codes, '{}'::text[])) WITH ORDINALITY AS ord(code, ordinality)
    LEFT JOIN metadata_register.relationship_types rt ON rt.relationship_code = ord.code;

    SELECT EXISTS (
        SELECT 1
        FROM metadata_register.calc_definitions cd
        JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
        WHERE ar.attribute_code = p_attribute_code
    ) INTO v_calculated;

    RETURN jsonb_build_object(
        'attributeCode', p_attribute_code,
        'attributeName', COALESCE(v_name, p_attribute_code),
        'role', p_role,
        'traversal', p_traversal,
        'relationshipCodes', to_jsonb(COALESCE(p_codes, '{}'::text[])),
        'relationshipNames', v_names,
        'domainCode', v_domain,
        'domainName', COALESCE(v_domain_name, v_domain),
        'homeDomainCode', v_home,
        'homeDomainName', v_home_name,
        'entityId', p_entity_id,
        'entityCode', v_entity_code,
        'entityName', v_entity_name,
        'value', v_value,
        'detail', p_detail,
        'calculated', COALESCE(v_calculated, FALSE)
    );
END;
$$;

CREATE FUNCTION public.explain_calc(
    p_entity_id UUID,
    p_attribute_code TEXT,
    p_as_of DATE DEFAULT NULL,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
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
                v_input.relationship_codes, v_as_of, v_def.expression, p_knowledge
            );
            v_components := v_components || jsonb_build_array(golden_master.describe_calc_component(
                v_def.domain_code, v_entity, v_input.attribute_code, v_input.input_role,
                v_input.traversal, v_input.relationship_codes, v_as_of, 1, NULL, p_knowledge
            ));
        END LOOP;
        v_result := golden_master.eval_expression_result(v_def.id, p_entity_id, v_as_of, 0, p_knowledge);
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

CREATE FUNCTION public.on_read_attribute_values(
    p_entity_id UUID,
    p_as_of DATE DEFAULT NULL,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
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
        v_value := golden_master.eval_expression_result(v_row.calc_id, p_entity_id, v_as_of, 0, p_knowledge);
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

REVOKE ALL ON FUNCTION golden_master.row_known(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.related_ids(UUID, TEXT, TEXT[], DATE, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.related_one(UUID, TEXT, TEXT[], DATE, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.attribute_text(UUID, VARCHAR, DATE, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.shown_date(UUID, VARCHAR, DATE, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.related_latest(UUID, TEXT, TEXT[], DATE, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.operand_entity(UUID, UUID, TEXT, TEXT, TEXT[], DATE, JSONB, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.golden_literal(UUID, VARCHAR, DATE, INTEGER, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.rewrite_latest(JSONB, UUID, UUID, DATE, INTEGER, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.rewrite_as_of(JSONB, UUID, UUID, DATE, INTEGER, JSONB, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.eval_expression_result(UUID, UUID, DATE, INTEGER, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.describe_calc_component(TEXT, UUID, VARCHAR, TEXT, TEXT, TEXT[], DATE, INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.on_read_attribute_values(UUID, DATE, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.explain_calc(UUID, TEXT, DATE, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.on_read_attribute_values(UUID, DATE, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.explain_calc(UUID, TEXT, DATE, TIMESTAMPTZ) TO authenticated, service_role;

UPDATE metadata_register.expression_functions
SET description = 'Reads an attribute on the latest related record. The record is the one whose period date is the latest on or before the as-of date, using the version known at the knowledge date. LATEST(PERIOD_EBITDA, PERIOD_LABEL, "LTM") keeps only records whose label is LTM, then takes the latest. The field''s relationship path says which records are tied to this one.'
WHERE id = 'ROW:LATEST';

NOTIFY pgrst, 'reload schema';
