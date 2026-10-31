-- Explain a calculated attribute for one record: each input's entity and value.
-- The screen uses this to show where QUANTITY and PRICE came from, and the
-- numbers that produced the result.

CREATE OR REPLACE FUNCTION golden_master.describe_calc_component(
    p_root_domain TEXT,
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_role TEXT,
    p_traversal TEXT,
    p_codes TEXT[],
    p_as_of DATE,
    p_depth INTEGER,
    p_detail TEXT
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
        v_literal := golden_master.golden_literal(p_entity_id, p_attribute_code, p_as_of, p_depth);
        IF v_literal IS NULL OR jsonb_typeof(v_literal) = 'null' THEN
            v_value := NULL;
        ELSE
            v_value := v_literal #>> '{}';
        END IF;
        -- A stored value can exist before it is marked the golden source. Show that
        -- value so the breakdown matches what the record screen already displays.
        IF v_value IS NULL THEN
            SELECT COALESCE(eav.golden_value_numeric::TEXT, eav.golden_value)
              INTO v_value
            FROM golden_master.entity_attribute_values eav
            JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
            WHERE eav.entity_id = p_entity_id
              AND ar.attribute_code = p_attribute_code
              AND eav.valid_from <= p_as_of
              AND eav.valid_to >= p_as_of
              AND eav.system_to = golden_master.open_system_to()
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
            IF v_input.traversal = 'SELF' THEN
                v_entity := p_entity_id;
            ELSE
                v_entity := golden_master.related_one(p_entity_id, v_input.traversal, v_input.relationship_codes, v_as_of);
            END IF;
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

REVOKE ALL ON FUNCTION golden_master.describe_calc_component(TEXT, UUID, VARCHAR, TEXT, TEXT, TEXT[], DATE, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.explain_calc(UUID, TEXT, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.explain_calc(UUID, TEXT, DATE) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
