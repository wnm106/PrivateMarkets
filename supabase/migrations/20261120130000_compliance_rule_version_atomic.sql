-- Save a compliance rule version, its conditions and its measure lines in one
-- transaction.
--
-- The GraphQL mutation used to end the live version's system time first, with
-- the error unchecked, and then insert the new version. A version dated in the
-- future left nothing in effect until that date, because the old row was no
-- longer known at any later knowledge date. A failed insert left the rule with
-- no version at all.
--
-- compliance.resolve_rule_version picks, among active versions whose valid and
-- system periods bracket the request, the highest version_number. So the live
-- version is not touched here. The new, higher version wins from its own
-- valid_from, the old one stays in effect before that date, and an evaluation
-- at an earlier knowledge date still finds the rule as it was known then.
--
-- SECURITY INVOKER: the caller's row level security applies to every insert,
-- exactly as it did when the rows were written one by one through PostgREST.
-- Rows are written with only the columns the caller supplied, as PostgREST
-- does, so column defaults still apply.

CREATE OR REPLACE FUNCTION compliance.create_rule_version(
    p_rule_id UUID,
    p_version JSONB,
    p_conditions JSONB DEFAULT '[]'::JSONB,
    p_measure_lines JSONB DEFAULT '[]'::JSONB
) RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = compliance, pg_temp
AS $$
DECLARE
    v_next INTEGER;
    v_version_id UUID;
    v_line_id UUID;
    v_line JSONB;
    v_condition JSONB;
    v_row JSONB;
    v_columns TEXT;
BEGIN
    IF p_rule_id IS NULL THEN
        RAISE EXCEPTION 'A rule version needs a rule' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_version) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'A rule version needs its fields as an object' USING ERRCODE = '22023';
    END IF;

    -- Two saves of the same rule take their version numbers one after the other.
    PERFORM pg_advisory_xact_lock(hashtextextended('compliance.rule_version:' || p_rule_id::TEXT, 0));

    SELECT COALESCE(max(rv.version_number), 0) + 1
      INTO v_next
      FROM compliance.rule_versions AS rv
     WHERE rv.rule_id = p_rule_id;

    v_row := (p_version - ARRAY['id', 'rule_id', 'version_number', 'system_from', 'system_to', 'created_at', 'created_by'])
        || jsonb_build_object('rule_id', p_rule_id, 'version_number', v_next, 'created_by', auth.uid());
    SELECT string_agg(quote_ident(k), ', ') INTO v_columns FROM jsonb_object_keys(v_row) AS k;
    EXECUTE format(
        'INSERT INTO compliance.rule_versions (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::compliance.rule_versions, $1) RETURNING id',
        v_columns
    ) INTO v_version_id USING v_row;

    FOR v_condition IN
        SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_conditions) = 'array' THEN p_conditions ELSE '[]'::JSONB END)
    LOOP
        v_row := (v_condition - ARRAY['id', 'rule_version_id', 'measure_line_id'])
            || jsonb_build_object('rule_version_id', v_version_id);
        SELECT string_agg(quote_ident(k), ', ') INTO v_columns FROM jsonb_object_keys(v_row) AS k;
        EXECUTE format(
            'INSERT INTO compliance.rule_conditions (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::compliance.rule_conditions, $1)',
            v_columns
        ) USING v_row;
    END LOOP;

    FOR v_line IN
        SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_measure_lines) = 'array' THEN p_measure_lines ELSE '[]'::JSONB END)
    LOOP
        v_row := (v_line - ARRAY['id', 'rule_version_id', 'conditions'])
            || jsonb_build_object('rule_version_id', v_version_id);
        SELECT string_agg(quote_ident(k), ', ') INTO v_columns FROM jsonb_object_keys(v_row) AS k;
        EXECUTE format(
            'INSERT INTO compliance.rule_measure_lines (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::compliance.rule_measure_lines, $1) RETURNING id',
            v_columns
        ) INTO v_line_id USING v_row;

        FOR v_condition IN
            SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_line -> 'conditions') = 'array' THEN v_line -> 'conditions' ELSE '[]'::JSONB END)
        LOOP
            v_row := (v_condition - ARRAY['id', 'rule_version_id', 'measure_line_id'])
                || jsonb_build_object('rule_version_id', v_version_id, 'measure_line_id', v_line_id);
            SELECT string_agg(quote_ident(k), ', ') INTO v_columns FROM jsonb_object_keys(v_row) AS k;
            EXECUTE format(
                'INSERT INTO compliance.rule_conditions (%1$s) SELECT %1$s FROM jsonb_populate_record(NULL::compliance.rule_conditions, $1)',
                v_columns
            ) USING v_row;
        END LOOP;
    END LOOP;

    RETURN v_version_id;
END;
$$;

COMMENT ON FUNCTION compliance.create_rule_version(UUID, JSONB, JSONB, JSONB) IS
    'Adds the next version of a rule with its conditions and measure lines, all or nothing. The live version is left as it is: resolve_rule_version prefers the higher version from its valid_from, so the old one stays in effect before that date.';

REVOKE ALL ON FUNCTION compliance.create_rule_version(UUID, JSONB, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION compliance.create_rule_version(UUID, JSONB, JSONB, JSONB) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
