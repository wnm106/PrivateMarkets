-- DQ rule expressions select the records that FAIL.
--
-- Previously rule_expression described a passing record (for example
-- "nav IS NOT NULL" or "price >= 0"). Evaluation now treats the expression
-- as a SQL boolean predicate that is true for violations, the same rows a
-- WHERE clause would return. NULL does not match, so a predicate has to
-- mention IS NULL when a missing value is itself a failure.
--
-- The predicates below are the complement of the original pass predicates:
-- a row fails exactly when the old expression was not true.

COMMENT ON COLUMN data_quality.dq_rules.rule_expression IS
    'SQL boolean predicate that is true for records that fail the rule. Evaluated against current golden attributes, with attribute codes as lowercase columns. Only TRUE is a violation; NULL does not match.';

UPDATE data_quality.dq_rules AS r
SET
    rule_expression = v.rule_expression,
    attribute_id = COALESCE(r.attribute_id, ar.id),
    updated_at = NOW()
FROM (
    VALUES
        ('FUND_NAV_NOT_NULL', $dq$nav IS NULL$dq$, 'NAV'),
        ('SECURITY_ISIN_FORMAT', $dq$isin IS NULL OR isin !~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'$dq$, 'ISIN'),
        ('DEAL_DATE_NOT_FUTURE', $dq$deal_date IS NULL OR deal_date > CURRENT_DATE$dq$, 'DEAL_DATE'),
        ('PRICE_NOT_NEGATIVE', $dq$price IS NULL OR price < 0$dq$, 'PRICE')
) AS v(rule_code, rule_expression, attribute_code)
LEFT JOIN metadata_register.attribute_register AS ar
    ON ar.attribute_code = v.attribute_code
WHERE r.rule_code = v.rule_code;

-- One projected row of the entity's current golden attributes.
-- Column names are lower(attribute_code). Typed columns use the attribute
-- data type so comparisons such as "price < 0" and "deal_date > CURRENT_DATE"
-- see numeric and date values. p_extra_attribute_id is always projected, even
-- when that attribute belongs to another domain and has no value yet.
CREATE OR REPLACE FUNCTION data_quality.entity_attribute_snapshot(
    p_entity_id UUID,
    p_extra_attribute_id UUID,
    OUT select_list TEXT,
    OUT actual_value TEXT
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $function$
DECLARE
    r RECORD;
    v_parts TEXT[] := ARRAY[]::TEXT[];
    v_actual_parts TEXT[] := ARRAY[]::TEXT[];
    v_sql_type TEXT;
    v_raw TEXT;
    v_literal TEXT;
    v_discard TEXT;
BEGIN
    FOR r IN
        SELECT
            ar.id,
            ar.attribute_code,
            ar.data_type,
            win.golden_value,
            win.golden_value_numeric,
            win.golden_value_date,
            win.golden_value_timestamp,
            win.golden_value_boolean,
            win.golden_value_jsonb
        FROM metadata_register.attribute_register AS ar
        JOIN entity_instances.master_entities AS me
            ON me.id = p_entity_id
        LEFT JOIN LATERAL (
            SELECT
                eav.golden_value,
                eav.golden_value_numeric,
                eav.golden_value_date,
                eav.golden_value_timestamp,
                eav.golden_value_boolean,
                eav.golden_value_jsonb
            FROM golden_master.entity_attribute_values AS eav
            WHERE eav.entity_id = p_entity_id
                AND eav.attribute_id = ar.id
                AND eav.valid_to = '9999-12-31'
                AND eav.system_to = '9999-12-31 23:59:59'
            ORDER BY
                (
                    NULLIF(btrim(eav.golden_value), '') IS NULL
                    AND eav.golden_value_numeric IS NULL
                    AND eav.golden_value_date IS NULL
                    AND eav.golden_value_timestamp IS NULL
                    AND eav.golden_value_boolean IS NULL
                    AND eav.golden_value_jsonb IS NULL
                ),
                eav.precedence_rank
            LIMIT 1
        ) AS win ON TRUE
        WHERE ar.domain_code = me.domain_code
            OR ar.domain_code IS NULL
            OR ar.id = p_extra_attribute_id
            OR NULLIF(btrim(win.golden_value), '') IS NOT NULL
            OR win.golden_value_numeric IS NOT NULL
            OR win.golden_value_date IS NOT NULL
            OR win.golden_value_timestamp IS NOT NULL
            OR win.golden_value_boolean IS NOT NULL
            OR win.golden_value_jsonb IS NOT NULL
        ORDER BY lower(ar.attribute_code)
    LOOP
        v_sql_type := CASE r.data_type
            WHEN 'NUMBER' THEN 'numeric'
            WHEN 'DATE' THEN 'date'
            WHEN 'TIMESTAMP' THEN 'timestamptz'
            WHEN 'BOOLEAN' THEN 'boolean'
            WHEN 'JSON' THEN 'jsonb'
            ELSE 'text'
        END;

        v_raw := CASE r.data_type
            WHEN 'NUMBER' THEN COALESCE(r.golden_value_numeric::text, r.golden_value)
            WHEN 'DATE' THEN COALESCE(r.golden_value_date::text, r.golden_value)
            WHEN 'TIMESTAMP' THEN COALESCE(r.golden_value_timestamp::text, r.golden_value)
            WHEN 'BOOLEAN' THEN COALESCE(
                CASE WHEN r.golden_value_boolean IS NULL THEN NULL ELSE r.golden_value_boolean::text END,
                r.golden_value
            )
            WHEN 'JSON' THEN COALESCE(r.golden_value_jsonb::text, r.golden_value)
            ELSE r.golden_value
        END;

        IF v_raw IS NULL OR (v_sql_type <> 'text' AND btrim(v_raw) = '') THEN
            v_literal := format('NULL::%s', v_sql_type);
            v_raw := NULL;
        ELSIF v_sql_type = 'text' THEN
            v_literal := format('CAST(%L AS text)', v_raw);
        ELSE
            BEGIN
                EXECUTE format('SELECT CAST(CAST(%L AS %s) AS text)', v_raw, v_sql_type) INTO v_discard;
                v_literal := format('CAST(%L AS %s)', v_raw, v_sql_type);
            EXCEPTION
                WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
                    v_literal := format('NULL::%s', v_sql_type);
                    v_raw := NULL;
            END;
        END IF;

        v_parts := array_append(v_parts, format('%s AS %I', v_literal, lower(r.attribute_code)));

        IF v_raw IS NOT NULL OR r.id = p_extra_attribute_id THEN
            v_actual_parts := array_append(
                v_actual_parts,
                format('%s=%s', lower(r.attribute_code), COALESCE(v_raw, 'NULL'))
            );
        END IF;
    END LOOP;

    IF cardinality(v_parts) = 0 THEN
        select_list := 'NULL::text AS _no_attributes';
    ELSE
        select_list := array_to_string(v_parts, ', ');
    END IF;

    actual_value := left(array_to_string(v_actual_parts, ', '), 1000);
END;
$function$;

COMMENT ON FUNCTION data_quality.entity_attribute_snapshot(UUID, UUID) IS
    'Projects an entity''s current golden attributes as a one-row SELECT list for DQ failure predicates.';

-- True when the failure predicate matches the entity. NULL does not match.
CREATE OR REPLACE FUNCTION data_quality.failure_predicate_matches(
    p_expression TEXT,
    p_entity_id UUID,
    p_extra_attribute_id UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $function$
DECLARE
    v_select_list TEXT;
    v_sql TEXT;
    v_match BOOLEAN;
BEGIN
    IF p_expression IS NULL OR btrim(p_expression) = '' THEN
        RAISE EXCEPTION 'DQ failure predicate is empty';
    END IF;

    SELECT snapshot.select_list
    INTO v_select_list
    FROM data_quality.entity_attribute_snapshot(p_entity_id, p_extra_attribute_id) AS snapshot;

    -- Concatenate rather than format() so a LIKE pattern's % is not a placeholder.
    v_sql := 'SELECT (' || p_expression || ') FROM (SELECT ' || v_select_list || ') AS dq_record';
    EXECUTE v_sql INTO v_match;
    RETURN COALESCE(v_match, FALSE);
END;
$function$;

COMMENT ON FUNCTION data_quality.failure_predicate_matches(TEXT, UUID, UUID) IS
    'Returns true when a DQ failure predicate matches the entity''s current golden attributes.';

CREATE OR REPLACE FUNCTION data_quality.evaluate_dq_rule(
    p_rule_id UUID,
    p_entity_id UUID
) RETURNS TABLE (
    passed BOOLEAN,
    exception_message TEXT,
    expected_value TEXT,
    actual_value TEXT
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $function$
DECLARE
    v_rule RECORD;
    v_entity_domain VARCHAR(50);
    v_actual TEXT;
    v_failed BOOLEAN;
    v_sqlerrm TEXT;
BEGIN
    SELECT * INTO v_rule
    FROM data_quality.dq_rules
    WHERE id = p_rule_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rule not found: %', p_rule_id;
    END IF;

    SELECT me.domain_code INTO v_entity_domain
    FROM entity_instances.master_entities AS me
    WHERE me.id = p_entity_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Entity not found: %', p_entity_id;
    END IF;

    IF v_rule.domain_code IS NOT NULL AND v_rule.domain_code IS DISTINCT FROM v_entity_domain THEN
        RETURN QUERY
        SELECT
            TRUE,
            'Rule does not apply to entity domain'::TEXT,
            NULL::TEXT,
            NULL::TEXT;
        RETURN;
    END IF;

    SELECT snapshot.actual_value
    INTO v_actual
    FROM data_quality.entity_attribute_snapshot(p_entity_id, v_rule.attribute_id) AS snapshot;

    BEGIN
        v_failed := data_quality.failure_predicate_matches(
            v_rule.rule_expression,
            p_entity_id,
            v_rule.attribute_id
        );
    EXCEPTION
        WHEN undefined_column THEN
            GET STACKED DIAGNOSTICS v_sqlerrm = MESSAGE_TEXT;
            RAISE EXCEPTION 'DQ rule % failure predicate references a column that is not an attribute of entity %: %',
                v_rule.rule_code, p_entity_id, v_sqlerrm;
    END;

    RETURN QUERY
    SELECT
        NOT v_failed,
        CASE
            WHEN v_failed THEN format('Rule failed: %s', COALESCE(v_rule.rule_description, v_rule.rule_expression))
            ELSE 'Rule passed'
        END,
        'Failure predicate is false'::TEXT,
        v_actual;
END;
$function$;

COMMENT ON FUNCTION data_quality.evaluate_dq_rule(UUID, UUID) IS
    'Evaluates a DQ failure predicate against one entity. passed is false when the expression is true.';

-- Every active entity in the rule domain for which the failure predicate is true.
CREATE OR REPLACE FUNCTION data_quality.entities_failing_rule(p_rule_id UUID)
RETURNS TABLE (
    entity_id UUID,
    exception_message TEXT,
    expected_value TEXT,
    actual_value TEXT
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $function$
DECLARE
    v_domain VARCHAR(50);
BEGIN
    SELECT r.domain_code INTO v_domain
    FROM data_quality.dq_rules AS r
    WHERE r.id = p_rule_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rule not found: %', p_rule_id;
    END IF;

    RETURN QUERY
    SELECT
        me.id,
        ev.exception_message,
        ev.expected_value,
        ev.actual_value
    FROM entity_instances.master_entities AS me
    CROSS JOIN LATERAL data_quality.evaluate_dq_rule(p_rule_id, me.id) AS ev
    WHERE COALESCE(me.is_active, TRUE)
        AND (v_domain IS NULL OR me.domain_code = v_domain)
        AND ev.passed = FALSE;
END;
$function$;

COMMENT ON FUNCTION data_quality.entities_failing_rule(UUID) IS
    'Returns active entities whose current golden attributes match the rule failure predicate.';

GRANT EXECUTE ON FUNCTION data_quality.entity_attribute_snapshot(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.failure_predicate_matches(TEXT, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.evaluate_dq_rule(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.entities_failing_rule(UUID) TO authenticated;
