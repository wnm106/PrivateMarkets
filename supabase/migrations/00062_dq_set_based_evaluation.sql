-- Evaluate a data quality rule in one statement.
--
-- entities_failing_rule used to call evaluate_dq_rule once per entity. Each
-- call built an attribute row in PL/pgSQL and EXECUTE'd a fresh statement.
-- The predicate is unchanged: it is still true for records that fail. The
-- scan now pivots the domain's current golden attributes once and applies
-- that predicate in a single WHERE-style projection.

CREATE OR REPLACE FUNCTION data_quality.try_numeric(p_text TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
BEGIN
    IF p_text IS NULL OR btrim(p_text) = '' THEN
        RETURN NULL;
    END IF;
    RETURN btrim(p_text)::NUMERIC;
EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION data_quality.try_date(p_text TEXT)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
BEGIN
    IF p_text IS NULL OR btrim(p_text) = '' THEN
        RETURN NULL;
    END IF;
    RETURN btrim(p_text)::DATE;
EXCEPTION
    WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
        RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION data_quality.try_timestamptz(p_text TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
BEGIN
    IF p_text IS NULL OR btrim(p_text) = '' THEN
        RETURN NULL;
    END IF;
    RETURN btrim(p_text)::TIMESTAMPTZ;
EXCEPTION
    WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
        RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION data_quality.try_boolean(p_text TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
BEGIN
    IF p_text IS NULL OR btrim(p_text) = '' THEN
        RETURN NULL;
    END IF;
    RETURN btrim(p_text)::BOOLEAN;
EXCEPTION
    WHEN invalid_text_representation THEN
        RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION data_quality.try_jsonb(p_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
BEGIN
    IF p_text IS NULL OR btrim(p_text) = '' THEN
        RETURN NULL;
    END IF;
    RETURN btrim(p_text)::JSONB;
EXCEPTION
    WHEN invalid_text_representation THEN
        RETURN NULL;
END;
$function$;

-- Subquery projecting one row per entity. Attribute codes are lowercase columns.
-- p_domain_code NULL means every domain. p_entity_id NULL means every entity
-- in that domain. p_active_only limits the population to active entities.
CREATE OR REPLACE FUNCTION data_quality.pivot_sql(
    p_domain_code VARCHAR,
    p_entity_id UUID,
    p_extra_attribute_id UUID,
    p_active_only BOOLEAN
) RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = data_quality, pg_catalog
AS $function$
DECLARE
    r RECORD;
    v_cols TEXT[] := ARRAY[]::TEXT[];
    v_attrs TEXT[] := ARRAY[]::TEXT[];
    v_seen TEXT[] := ARRAY[]::TEXT[];
    v_col_name TEXT;
    v_value_expr TEXT;
    v_domain_filter TEXT;
    v_entity_filter TEXT;
    v_active_filter TEXT;
    v_extra_filter TEXT;
    v_display TEXT;
BEGIN
    v_domain_filter := CASE
        WHEN p_domain_code IS NULL THEN 'TRUE'
        ELSE format('me.domain_code = %L', p_domain_code)
    END;
    v_entity_filter := CASE
        WHEN p_entity_id IS NULL THEN 'TRUE'
        ELSE format('me.id = %L::uuid', p_entity_id)
    END;
    v_active_filter := CASE
        WHEN p_active_only THEN 'COALESCE(me.is_active, TRUE)'
        ELSE 'TRUE'
    END;
    v_extra_filter := CASE
        WHEN p_extra_attribute_id IS NULL THEN 'FALSE'
        ELSE format('pa.attribute_id = %L::uuid', p_extra_attribute_id)
    END;

    FOR r IN
        SELECT ar.id, ar.attribute_code, ar.data_type
        FROM metadata_register.attribute_register AS ar
        WHERE p_domain_code IS NULL
            OR ar.id = p_extra_attribute_id
            OR ar.domain_code IS NULL
            OR ar.domain_code = p_domain_code
            OR EXISTS (
                SELECT 1
                FROM golden_master.entity_attribute_values AS eav
                JOIN entity_instances.master_entities AS me ON me.id = eav.entity_id
                WHERE eav.attribute_id = ar.id
                    AND eav.valid_to = DATE '9999-12-31'
                    AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59'
                    AND (p_domain_code IS NULL OR me.domain_code = p_domain_code)
                    AND (p_entity_id IS NULL OR me.id = p_entity_id)
                    AND (NOT p_active_only OR COALESCE(me.is_active, TRUE))
                    AND (
                        NULLIF(btrim(eav.golden_value), '') IS NOT NULL
                        OR eav.golden_value_numeric IS NOT NULL
                        OR eav.golden_value_date IS NOT NULL
                        OR eav.golden_value_timestamp IS NOT NULL
                        OR eav.golden_value_boolean IS NOT NULL
                        OR eav.golden_value_jsonb IS NOT NULL
                    )
            )
        ORDER BY lower(ar.attribute_code), ar.attribute_code
    LOOP
        v_col_name := lower(r.attribute_code);
        IF v_col_name = ANY (v_seen) THEN
            CONTINUE;
        END IF;
        v_seen := v_seen || v_col_name;

        v_value_expr := CASE r.data_type
            WHEN 'NUMBER' THEN 'COALESCE(w.golden_value_numeric, data_quality.try_numeric(w.golden_value))'
            WHEN 'DATE' THEN 'COALESCE(w.golden_value_date, data_quality.try_date(w.golden_value))'
            WHEN 'TIMESTAMP' THEN 'COALESCE(w.golden_value_timestamp, data_quality.try_timestamptz(w.golden_value))'
            WHEN 'BOOLEAN' THEN 'COALESCE(w.golden_value_boolean, data_quality.try_boolean(w.golden_value))'
            WHEN 'JSON' THEN 'COALESCE(w.golden_value_jsonb, data_quality.try_jsonb(w.golden_value))'
            ELSE 'w.golden_value'
        END;

        v_cols := v_cols || format(
            'MAX(%s) FILTER (WHERE pa.attribute_id = %L::uuid) AS %I',
            v_value_expr, r.id, v_col_name
        );
        v_attrs := v_attrs || format('(%L::uuid, %L, %L)', r.id, r.attribute_code, r.data_type);
    END LOOP;

    IF cardinality(v_cols) = 0 THEN
        RETURN format(
            'SELECT me.id AS entity_id, NULL::text AS _no_attributes, ''''::text AS actual_value
             FROM entity_instances.master_entities AS me
             WHERE %s AND %s AND %s',
            v_domain_filter, v_entity_filter, v_active_filter
        );
    END IF;

    v_display := $display$
        CASE pa.data_type
            WHEN 'NUMBER' THEN COALESCE(w.golden_value_numeric, data_quality.try_numeric(w.golden_value))::text
            WHEN 'DATE' THEN COALESCE(w.golden_value_date, data_quality.try_date(w.golden_value))::text
            WHEN 'TIMESTAMP' THEN COALESCE(w.golden_value_timestamp, data_quality.try_timestamptz(w.golden_value))::text
            WHEN 'BOOLEAN' THEN COALESCE(w.golden_value_boolean, data_quality.try_boolean(w.golden_value))::text
            WHEN 'JSON' THEN COALESCE(w.golden_value_jsonb, data_quality.try_jsonb(w.golden_value))::text
            ELSE w.golden_value
        END
    $display$;

    RETURN format(
        'SELECT me.id AS entity_id, %s,
                COALESCE(left(string_agg(
                    CASE
                        WHEN %s IS NOT NULL OR %s THEN format(''%%s=%%s'', lower(pa.attribute_code), COALESCE(%s, ''NULL''))
                    END,
                    '', '' ORDER BY lower(pa.attribute_code)
                ), 1000), '''') AS actual_value
         FROM entity_instances.master_entities AS me
         CROSS JOIN (VALUES %s) AS pa(attribute_id, attribute_code, data_type)
         LEFT JOIN (
             SELECT DISTINCT ON (eav.entity_id, eav.attribute_id)
                 eav.entity_id, eav.attribute_id,
                 eav.golden_value, eav.golden_value_numeric, eav.golden_value_date,
                 eav.golden_value_timestamp, eav.golden_value_boolean, eav.golden_value_jsonb
             FROM golden_master.entity_attribute_values AS eav
             JOIN entity_instances.master_entities AS me ON me.id = eav.entity_id
             WHERE eav.valid_to = DATE ''9999-12-31''
               AND eav.system_to = TIMESTAMPTZ ''9999-12-31 23:59:59''
               AND %s AND %s AND %s
             ORDER BY eav.entity_id, eav.attribute_id,
                 (
                     NULLIF(btrim(eav.golden_value), '''') IS NULL
                     AND eav.golden_value_numeric IS NULL
                     AND eav.golden_value_date IS NULL
                     AND eav.golden_value_timestamp IS NULL
                     AND eav.golden_value_boolean IS NULL
                     AND eav.golden_value_jsonb IS NULL
                 ),
                 eav.precedence_rank
         ) AS w ON w.entity_id = me.id AND w.attribute_id = pa.attribute_id
         WHERE %s AND %s AND %s
         GROUP BY me.id',
        array_to_string(v_cols, ', '),
        v_display, v_extra_filter, v_display,
        array_to_string(v_attrs, ', '),
        v_domain_filter, v_entity_filter, v_active_filter,
        v_domain_filter, v_entity_filter, v_active_filter
    );
END;
$function$;

COMMENT ON FUNCTION data_quality.pivot_sql(VARCHAR, UUID, UUID, BOOLEAN) IS
    'SQL text for one row per entity, with current golden attributes as typed columns for a DQ failure predicate.';

CREATE OR REPLACE FUNCTION data_quality.scan_rule(
    p_rule_id UUID,
    p_entity_id UUID DEFAULT NULL,
    p_active_only BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
    entity_id UUID,
    failed BOOLEAN,
    actual_value TEXT
)
LANGUAGE plpgsql
STABLE
SET search_path = data_quality, pg_catalog
AS $function$
DECLARE
    v_rule data_quality.dq_rules;
    v_pivot TEXT;
    v_sql TEXT;
    v_sqlerrm TEXT;
BEGIN
    SELECT * INTO v_rule
    FROM data_quality.dq_rules
    WHERE id = p_rule_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rule not found: %', p_rule_id;
    END IF;

    IF v_rule.rule_expression IS NULL OR btrim(v_rule.rule_expression) = '' THEN
        RAISE EXCEPTION 'DQ failure predicate is empty';
    END IF;

    v_pivot := data_quality.pivot_sql(v_rule.domain_code, p_entity_id, v_rule.attribute_id, p_active_only);
    -- Concatenate so a LIKE pattern's % is not a format() placeholder.
    v_sql := 'SELECT entity_id, COALESCE((' || v_rule.rule_expression || '), FALSE) AS failed, actual_value FROM ('
        || v_pivot || ') AS dq_record';

    BEGIN
        RETURN QUERY EXECUTE v_sql;
    EXCEPTION
        WHEN undefined_column THEN
            GET STACKED DIAGNOSTICS v_sqlerrm = MESSAGE_TEXT;
            RAISE EXCEPTION 'DQ rule % failure predicate references a column that is not an attribute of this population: %',
                v_rule.rule_code, v_sqlerrm;
    END;
END;
$function$;

COMMENT ON FUNCTION data_quality.scan_rule(UUID, UUID, BOOLEAN) IS
    'Applies one DQ failure predicate to a domain, or to a single entity, in one SQL statement.';

CREATE OR REPLACE FUNCTION data_quality.failure_predicate_matches(
    p_expression TEXT,
    p_entity_id UUID,
    p_extra_attribute_id UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = data_quality, pg_catalog
AS $function$
DECLARE
    v_domain VARCHAR(50);
    v_pivot TEXT;
    v_sql TEXT;
    v_match BOOLEAN;
BEGIN
    IF p_expression IS NULL OR btrim(p_expression) = '' THEN
        RAISE EXCEPTION 'DQ failure predicate is empty';
    END IF;

    SELECT me.domain_code INTO v_domain
    FROM entity_instances.master_entities AS me
    WHERE me.id = p_entity_id;

    v_pivot := data_quality.pivot_sql(v_domain, p_entity_id, p_extra_attribute_id, FALSE);
    v_sql := 'SELECT COALESCE((' || p_expression || '), FALSE) FROM (' || v_pivot || ') AS dq_record';
    EXECUTE v_sql INTO v_match;
    RETURN COALESCE(v_match, FALSE);
END;
$function$;

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
SET search_path = data_quality, pg_catalog
AS $function$
DECLARE
    v_rule data_quality.dq_rules;
    v_entity_domain VARCHAR(50);
    v_failed BOOLEAN;
    v_actual TEXT;
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
        SELECT TRUE, 'Rule does not apply to entity domain'::TEXT, NULL::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    SELECT s.failed, s.actual_value
    INTO v_failed, v_actual
    FROM data_quality.scan_rule(p_rule_id, p_entity_id, FALSE) AS s;

    v_failed := COALESCE(v_failed, FALSE);

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

CREATE OR REPLACE FUNCTION data_quality.entities_failing_rule(p_rule_id UUID)
RETURNS TABLE (
    entity_id UUID,
    exception_message TEXT,
    expected_value TEXT,
    actual_value TEXT
)
LANGUAGE plpgsql
STABLE
SET search_path = data_quality, pg_catalog
AS $function$
DECLARE
    v_rule data_quality.dq_rules;
BEGIN
    SELECT * INTO v_rule
    FROM data_quality.dq_rules
    WHERE id = p_rule_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rule not found: %', p_rule_id;
    END IF;

    RETURN QUERY
    SELECT
        s.entity_id,
        format('Rule failed: %s', COALESCE(v_rule.rule_description, v_rule.rule_expression)),
        'Failure predicate is false'::TEXT,
        s.actual_value
    FROM data_quality.scan_rule(p_rule_id, NULL, TRUE) AS s
    WHERE s.failed;
END;
$function$;

GRANT EXECUTE ON FUNCTION data_quality.try_numeric(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.try_date(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.try_timestamptz(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.try_boolean(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.try_jsonb(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.pivot_sql(VARCHAR, UUID, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.scan_rule(UUID, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.failure_predicate_matches(TEXT, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.evaluate_dq_rule(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION data_quality.entities_failing_rule(UUID) TO authenticated;
