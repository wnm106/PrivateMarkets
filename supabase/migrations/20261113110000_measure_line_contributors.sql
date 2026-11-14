-- The records behind a result that is built from measure lines. A composite result
-- stores no contributor list, so the rule tester had nothing to show. This rebuilds
-- it: for each numerator and denominator amount, the records that amount counted and
-- the value each one added, read the same way the evaluation read them.

CREATE OR REPLACE FUNCTION compliance.measure_line_contributors(p_result_id uuid)
RETURNS TABLE (
    amount_side text,
    amount_order integer,
    amount_label text,
    amount_kind text,
    amount_sign integer,
    entity_id uuid,
    amount_value numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
    r compliance.rule_evaluation_results;
    v_side text;
    v_term jsonb;
    v_ord integer;
    v_ids uuid[];
    v_rd record;
BEGIN
    SELECT * INTO r FROM compliance.rule_evaluation_results WHERE id = p_result_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    FOREACH v_side IN ARRAY ARRAY['NUMERATOR', 'DENOMINATOR'] LOOP
        FOR v_term, v_ord IN
            SELECT e.term, e.ord::integer
            FROM jsonb_array_elements(compliance.measure_line_terms(r.rule_version_id, v_side)) WITH ORDINALITY AS e(term, ord)
        LOOP
            v_ids := compliance.clo_term_ids(
                r.anchor_entity_id, v_term -> 'path', v_term -> 'where',
                r.as_of_date, r.knowledge_date, r.source_scope, NULL
            );
            IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
                CONTINUE;
            END IF;

            SELECT * INTO v_rd FROM compliance.resolve_dimension(r.as_of_date, r.knowledge_date, r.source_scope, v_term -> 'dimension');

            IF jsonb_typeof(v_term -> 'expression') = 'object' THEN
                RETURN QUERY
                SELECT v_side, v_ord, v_term ->> 'label', upper(COALESCE(v_term ->> 'kind', 'SUM')),
                       COALESCE((v_term ->> 'sign')::integer, 1), ids.id,
                       CASE WHEN q.txt ~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$' THEN q.txt::numeric END
                FROM unnest(v_ids) AS ids(id)
                CROSS JOIN LATERAL (
                    SELECT compliance.eval_operand(ids.id, v_term -> 'expression', r.as_of_date, r.knowledge_date, r.source_scope, '{}'::jsonb) AS txt
                ) AS q;
            ELSE
                RETURN QUERY
                SELECT v_side, v_ord, v_term ->> 'label', upper(COALESCE(v_term ->> 'kind', 'SUM')),
                       COALESCE((v_term ->> 'sign')::integer, 1), g.entity_id, g.val
                FROM compliance.get_numeric_values(v_ids, v_term ->> 'attribute', v_rd.o_as_of, v_rd.o_knowledge, v_rd.o_source) AS g;
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION compliance.measure_line_contributors IS
    'Records and values behind each numerator and denominator amount of a measure-line result.';

GRANT EXECUTE ON FUNCTION compliance.measure_line_contributors(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
