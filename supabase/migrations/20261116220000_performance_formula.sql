-- XIRR and MOIC as attribute formulas.
--
-- The formula names every field. Each field is aggregated onto the entity the
-- formula sits on, along the path chosen for that field.
--
--   XIRR(
--     OPEN(MARKET_VALUE, QTD),
--     FLOWS(CASHFLOW_INVESTOR_AMOUNT, CASHFLOW_DATE),
--     FLOWS(FEE_AMOUNT, FEE_DATE),
--     CLOSE(MARKET_VALUE)
--   )
--
-- OPEN and CLOSE add the value across the related records. FLOWS keeps every
-- related record's amount and date. A second FLOWS call is another set of
-- transactions, such as fees beside capital activity.
--
-- QTD is the last day of the prior quarter. The opening value is read that
-- day. Cash flows on that day are left out. Cash flows after it, through the
-- closing date, are kept. YTD, MTD, and LTM work the same way. ITD, or an
-- omitted offset, has no opening value. A date field on this entity, or a
-- date function such as START_OF_QUARTER(CURRENT_DATE), is also an offset.
-- Amounts stay signed as stored. Money out is negative.

CREATE OR REPLACE FUNCTION golden_master.performance_window_start(p_window text, p_as_of date)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $function$
    SELECT CASE upper(COALESCE(p_window, ''))
        WHEN 'YTD' THEN (date_trunc('year', p_as_of::timestamp) - INTERVAL '1 day')::date
        WHEN 'QTD' THEN (date_trunc('quarter', p_as_of::timestamp) - INTERVAL '1 day')::date
        WHEN 'MTD' THEN (date_trunc('month', p_as_of::timestamp) - INTERVAL '1 day')::date
        WHEN 'LTM' THEN (p_as_of::timestamp - INTERVAL '1 year')::date
        ELSE NULL
    END;
$function$;

CREATE OR REPLACE FUNCTION golden_master.performance_offset_date(
    p_node jsonb,
    p_entity_id uuid,
    p_as_of date
) RETURNS date
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $function$
DECLARE
    v_fn text;
    v_text text;
    v_value jsonb;
BEGIN
    IF p_node IS NULL OR jsonb_typeof(p_node) = 'null' THEN
        RETURN NULL;
    END IF;

    v_fn := upper(COALESCE(p_node->>'fn', ''));
    IF v_fn = 'ITD' THEN
        RETURN NULL;
    END IF;
    IF v_fn IN ('YTD', 'QTD', 'MTD', 'LTM') THEN
        RETURN golden_master.performance_window_start(v_fn, p_as_of);
    END IF;

    IF p_node ? 'ref' THEN
        RETURN golden_master.golden_date(p_entity_id, p_node->>'ref', p_as_of);
    END IF;

    v_value := metadata_register.eval_expr(p_node, jsonb_build_object('CURRENT_DATE', to_jsonb(p_as_of::text)));
    IF v_value IS NULL OR jsonb_typeof(v_value) = 'null' THEN
        RETURN NULL;
    END IF;
    v_text := v_value #>> '{}';
    IF v_text ~ '^\d{4}-\d{2}-\d{2}' THEN
        RETURN left(v_text, 10)::date;
    END IF;
    RETURN NULL;
END;
$function$;

-- The records a formula field rolls up. A field with no path is this entity.
CREATE OR REPLACE FUNCTION golden_master.performance_entities(
    p_calc_id uuid,
    p_entity_id uuid,
    p_code text,
    p_as_of date,
    p_knowledge timestamptz
) RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $function$
DECLARE
    v_traversal text;
    v_codes text[];
BEGIN
    SELECT ci.traversal, ci.relationship_codes
      INTO v_traversal, v_codes
    FROM metadata_register.calc_inputs ci
    WHERE ci.calc_definition_id = p_calc_id
      AND ci.input_role = 'OPERAND'
      AND ci.attribute_code = p_code
    LIMIT 1;

    IF NOT FOUND OR v_traversal IS NULL OR v_traversal = 'SELF' OR COALESCE(cardinality(v_codes), 0) = 0 THEN
        RETURN ARRAY[p_entity_id];
    END IF;
    RETURN golden_master.related_ids(p_entity_id, v_traversal, v_codes, p_as_of, p_knowledge);
END;
$function$;

CREATE OR REPLACE FUNCTION golden_master.performance_sum(
    p_calc_id uuid,
    p_entity_id uuid,
    p_code text,
    p_on date,
    p_depth integer,
    p_knowledge timestamptz
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $function$
DECLARE
    v_entity uuid;
    v_value numeric;
    v_sum numeric := 0;
    v_found boolean := FALSE;
BEGIN
    FOREACH v_entity IN ARRAY golden_master.performance_entities(p_calc_id, p_entity_id, p_code, p_on, p_knowledge) LOOP
        v_value := golden_master.golden_numeric(v_entity, p_code, p_on, p_depth + 1);
        IF v_value IS NOT NULL THEN
            v_sum := v_sum + v_value;
            v_found := TRUE;
        END IF;
    END LOOP;
    RETURN CASE WHEN v_found THEN v_sum ELSE NULL END;
END;
$function$;

-- XIRR or MOIC for one formula call. Returns a decimal rate, or a multiple.
CREATE OR REPLACE FUNCTION golden_master.performance_formula(
    p_calc_id uuid,
    p_entity_id uuid,
    p_expr jsonb,
    p_as_of date,
    p_depth integer,
    p_knowledge timestamptz,
    p_window_start date DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $function$
DECLARE
    v_kind text;
    v_args jsonb;
    v_arg jsonb;
    v_fn text;
    v_index integer;
    v_open_code text;
    v_open_offset jsonb;
    v_close_code text;
    v_close_offset jsonb;
    v_flow_amounts text[] := '{}';
    v_flow_dates text[] := '{}';
    v_amount_code text;
    v_date_code text;
    v_start date;
    v_end date;
    v_opening numeric;
    v_closing numeric;
    v_entity uuid;
    v_amount numeric;
    v_flow_date date;
    v_dates date[] := '{}';
    v_amounts numeric[] := '{}';
    v_sorted_dates date[];
    v_sorted_amounts numeric[];
    v_open_read text;
    v_in numeric := 0;
    v_back numeric := 0;
BEGIN
    IF p_depth > 8 OR p_as_of IS NULL THEN
        RETURN NULL;
    END IF;

    v_kind := upper(COALESCE(p_expr->>'fn', ''));
    v_args := COALESCE(p_expr->'args', '[]'::jsonb);
    IF jsonb_typeof(v_args) = 'array' AND jsonb_array_length(v_args) > 0 THEN
        FOR v_index IN 0..jsonb_array_length(v_args) - 1 LOOP
            v_arg := v_args->v_index;
            v_fn := upper(COALESCE(v_arg->>'fn', ''));
            IF v_fn = 'OPEN' THEN
                IF v_open_code IS NOT NULL THEN
                    RAISE EXCEPTION '% takes one OPEN', v_kind;
                END IF;
                v_open_code := v_arg->'args'->0->>'ref';
                v_open_offset := v_arg->'args'->1;
                IF v_open_offset IS NULL OR jsonb_typeof(v_open_offset) = 'null' THEN
                    v_open_offset := v_arg->'args'->0->'asOf';
                END IF;
                IF v_open_code IS NULL THEN
                    RAISE EXCEPTION 'OPEN expects the value field';
                END IF;
            ELSIF v_fn = 'CLOSE' THEN
                IF v_close_code IS NOT NULL THEN
                    RAISE EXCEPTION '% takes one CLOSE', v_kind;
                END IF;
                v_close_code := v_arg->'args'->0->>'ref';
                v_close_offset := v_arg->'args'->1;
                IF v_close_offset IS NULL OR jsonb_typeof(v_close_offset) = 'null' THEN
                    v_close_offset := v_arg->'args'->0->'asOf';
                END IF;
                IF v_close_code IS NULL THEN
                    RAISE EXCEPTION 'CLOSE expects the value field';
                END IF;
            ELSIF v_fn = 'FLOWS' THEN
                v_amount_code := v_arg->'args'->0->>'ref';
                v_date_code := v_arg->'args'->1->>'ref';
                IF v_amount_code IS NULL OR v_date_code IS NULL THEN
                    RAISE EXCEPTION 'FLOWS expects an amount field and a date field';
                END IF;
                v_flow_amounts := v_flow_amounts || v_amount_code;
                v_flow_dates := v_flow_dates || v_date_code;
            ELSE
                RAISE EXCEPTION '% arguments are OPEN, FLOWS, and CLOSE', v_kind;
            END IF;
        END LOOP;
    END IF;

    IF v_close_code IS NULL OR cardinality(v_flow_amounts) = 0 THEN
        RAISE EXCEPTION '% expects CLOSE and at least one FLOWS', v_kind;
    END IF;

    v_end := COALESCE(golden_master.performance_offset_date(v_close_offset, p_entity_id, p_as_of), p_as_of);
    -- A caller-supplied window, such as quarter to date, replaces the formula's own offset.
    -- The opening value is the OPEN field, or the CLOSE field when the formula is inception to date.
    IF p_window_start IS NOT NULL THEN
        v_start := p_window_start;
    ELSE
        v_start := golden_master.performance_offset_date(v_open_offset, p_entity_id, p_as_of);
    END IF;
    IF v_start IS NOT NULL AND v_start >= v_end THEN
        RETURN NULL;
    END IF;

    v_open_read := COALESCE(v_open_code, CASE WHEN p_window_start IS NOT NULL THEN v_close_code ELSE NULL END);
    IF v_open_read IS NOT NULL AND v_start IS NOT NULL THEN
        v_opening := golden_master.performance_sum(p_calc_id, p_entity_id, v_open_read, v_start, p_depth, p_knowledge);
        IF v_opening IS NOT NULL AND v_opening <> 0 THEN
            v_dates := v_dates || v_start;
            v_amounts := v_amounts || (-v_opening);
            v_in := v_in + v_opening;
        END IF;
    END IF;

    FOR v_index IN 1..cardinality(v_flow_amounts) LOOP
        v_amount_code := v_flow_amounts[v_index];
        v_date_code := v_flow_dates[v_index];
        FOREACH v_entity IN ARRAY golden_master.performance_entities(p_calc_id, p_entity_id, v_amount_code, v_end, p_knowledge) LOOP
            v_amount := golden_master.golden_numeric(v_entity, v_amount_code, v_end, p_depth + 1);
            v_flow_date := golden_master.golden_date(v_entity, v_date_code, v_end);
            IF v_amount IS NOT NULL AND v_amount <> 0 AND v_flow_date IS NOT NULL
               AND v_flow_date <= v_end AND (v_start IS NULL OR v_flow_date > v_start) THEN
                v_dates := v_dates || v_flow_date;
                v_amounts := v_amounts || v_amount;
                IF v_amount < 0 THEN
                    v_in := v_in - v_amount;
                ELSE
                    v_back := v_back + v_amount;
                END IF;
            END IF;
        END LOOP;
    END LOOP;

    v_closing := golden_master.performance_sum(p_calc_id, p_entity_id, v_close_code, v_end, p_depth, p_knowledge);
    IF v_closing IS NOT NULL AND v_closing <> 0 THEN
        v_dates := v_dates || v_end;
        v_amounts := v_amounts || v_closing;
        v_back := v_back + v_closing;
    END IF;

    IF cardinality(v_dates) = 0 THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(array_agg(f.d ORDER BY f.d, f.ord), '{}'),
           COALESCE(array_agg(f.a ORDER BY f.d, f.ord), '{}')
      INTO v_sorted_dates, v_sorted_amounts
    FROM unnest(v_dates, v_amounts) WITH ORDINALITY AS f(d, a, ord);

    IF v_kind = 'MOIC' THEN
        IF v_in <= 0 THEN
            RETURN NULL;
        END IF;
        RETURN v_back / v_in;
    END IF;

    RETURN golden_master.xirr(v_sorted_dates, v_sorted_amounts);
END;
$function$;

CREATE OR REPLACE FUNCTION golden_master.rewrite_performance(
    p_expr jsonb,
    p_calc_id uuid,
    p_entity_id uuid,
    p_as_of date,
    p_depth integer,
    p_knowledge timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, pg_temp
AS $function$
DECLARE
    v_fn text;
    v_value numeric;
    v_index integer;
    v_rewritten jsonb := '[]'::jsonb;
BEGIN
    IF p_expr IS NULL OR jsonb_typeof(p_expr) <> 'object' THEN
        RETURN p_expr;
    END IF;

    v_fn := upper(COALESCE(p_expr->>'fn', ''));
    IF v_fn IN ('XIRR', 'MOIC') THEN
        v_value := golden_master.performance_formula(p_calc_id, p_entity_id, p_expr, p_as_of, p_depth, p_knowledge);
        IF v_value IS NULL THEN
            RETURN jsonb_build_object('const', NULL);
        END IF;
        RETURN jsonb_build_object('const', v_value);
    END IF;

    IF p_expr ? 'args' AND jsonb_typeof(p_expr->'args') = 'array' THEN
        FOR v_index IN 0..jsonb_array_length(p_expr->'args') - 1 LOOP
            v_rewritten := v_rewritten || jsonb_build_array(
                golden_master.rewrite_performance(p_expr->'args'->v_index, p_calc_id, p_entity_id, p_as_of, p_depth, p_knowledge)
            );
        END LOOP;
        p_expr := p_expr || jsonb_build_object('args', v_rewritten);
    END IF;

    IF p_expr ? 'asOf' THEN
        p_expr := p_expr || jsonb_build_object(
            'asOf',
            golden_master.rewrite_performance(p_expr->'asOf', p_calc_id, p_entity_id, p_as_of, p_depth, p_knowledge)
        );
    END IF;
    RETURN p_expr;
END;
$function$;

CREATE OR REPLACE FUNCTION golden_master.eval_expression_result(
    p_calc_id uuid,
    p_entity_id uuid,
    p_as_of date,
    p_depth integer DEFAULT 0,
    p_knowledge timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $function$
DECLARE
    v_def metadata_register.calc_definitions%ROWTYPE;
    v_input metadata_register.calc_inputs%ROWTYPE;
    v_vars jsonb := '{}'::jsonb;
    v_entity uuid;
    v_literal jsonb;
    v_bound jsonb;
    v_expr jsonb;
BEGIN
    IF p_depth > 16 THEN
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
        v_entity := golden_master.operand_entity(
            p_calc_id, p_entity_id, v_input.attribute_code, v_input.traversal,
            v_input.relationship_codes, p_as_of, v_def.expression, p_knowledge
        );
        IF v_entity IS NULL THEN
            v_literal := 'null'::jsonb;
        ELSE
            v_literal := golden_master.golden_literal(v_entity, v_input.attribute_code, p_as_of, p_depth + 1, p_knowledge);
        END IF;
        v_vars := v_vars || jsonb_build_object(v_input.attribute_code, v_literal);
    END LOOP;

    v_vars := v_vars || jsonb_build_object('CURRENT_DATE', to_jsonb(p_as_of::text));
    v_expr := golden_master.rewrite_latest(v_def.expression, p_entity_id, p_calc_id, p_as_of, p_depth, p_knowledge);
    v_expr := golden_master.rewrite_series(v_expr, p_entity_id, p_as_of, p_depth, p_knowledge);
    v_expr := golden_master.rewrite_performance(v_expr, p_calc_id, p_entity_id, p_as_of, p_depth, p_knowledge);
    v_bound := golden_master.rewrite_as_of(v_expr, p_entity_id, p_calc_id, p_as_of, p_depth, v_vars, p_knowledge);
    RETURN metadata_register.eval_expr(v_bound->'expr', v_bound->'vars');
END;
$function$;

-- A reversed hop is stored as ~CODE. Match the relationship without the mark,
-- and start the walk back from the side the formula came from.
CREATE OR REPLACE FUNCTION golden_master.enqueue_relationship_edge(
    p_parent uuid,
    p_child uuid,
    p_code text,
    p_valid_from date,
    p_valid_to date
) RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
    v_input record;
    v_index integer;
    v_hop text;
    v_prefix text[];
    v_anchor uuid;
    v_target uuid;
    v_domain varchar(50);
    v_end date;
    v_walks_down boolean;
BEGIN
    FOR v_input IN
        SELECT ci.traversal,
               ci.relationship_codes,
               cd.attribute_id AS calc_attribute_id,
               cd.domain_code,
               cd.time_impact,
               ar.attribute_code AS cause_code
        FROM metadata_register.calc_inputs ci
        JOIN metadata_register.calc_definitions cd ON cd.id = ci.calc_definition_id
        JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
        WHERE cd.evaluation_mode = 'MATERIALIZED'
          AND EXISTS (
              SELECT 1 FROM unnest(ci.relationship_codes) AS hop(code)
              WHERE ltrim(hop.code, '~') = p_code
          )
    LOOP
        v_end := CASE WHEN v_input.time_impact = 'FORWARD' THEN DATE '9999-12-31' ELSE p_valid_to END;
        FOR v_index IN 1..cardinality(v_input.relationship_codes) LOOP
            v_hop := v_input.relationship_codes[v_index];
            CONTINUE WHEN ltrim(v_hop, '~') IS DISTINCT FROM p_code;
            IF v_index = 1 THEN
                v_prefix := '{}';
            ELSE
                v_prefix := v_input.relationship_codes[1:v_index - 1];
            END IF;
            v_walks_down := (v_input.traversal = 'DOWN') <> (left(v_hop, 1) = '~');
            v_anchor := CASE WHEN v_walks_down THEN p_parent ELSE p_child END;

            FOR v_target IN
                SELECT golden_master.calc_target_entities(
                    v_anchor, v_input.traversal, v_prefix, p_valid_from, v_end
                )
            LOOP
                SELECT domain_code INTO v_domain
                FROM entity_instances.master_entities
                WHERE id = v_target;
                IF v_domain IS NOT DISTINCT FROM v_input.domain_code THEN
                    PERFORM golden_master.enqueue_calc(
                        v_input.calc_attribute_id, v_target, p_valid_from, v_end,
                        COALESCE(p_child, p_parent), v_input.cause_code, p_valid_from
                    );
                END IF;
            END LOOP;
        END LOOP;
    END LOOP;
END;
$function$;

UPDATE metadata_register.expression_functions
SET function_name = 'Internal rate of return',
    description = 'Annualised return from an opening value, one or more sets of cash flows, and a closing value. Each field is read across the related records chosen for that field and combined on this entity. OPEN(value, QTD) reads the opening value on the last day of the prior quarter and keeps cash flows after that date. Add a FLOWS call for each set of transactions, such as capital activity and fees. Amounts stay signed as stored: money out is negative.',
    signature = 'XIRR(OPEN(value, offset), FLOWS(amount, date), CLOSE(value))',
    example = '{"fn":"XIRR","args":[{"fn":"OPEN","args":[{"ref":"MARKET_VALUE"},{"fn":"QTD","args":[]}]},{"fn":"FLOWS","args":[{"ref":"CASHFLOW_INVESTOR_AMOUNT"},{"ref":"CASHFLOW_DATE"}]},{"fn":"CLOSE","args":[{"ref":"MARKET_VALUE"}]}]}'::jsonb,
    callable = TRUE,
    sort_order = 300
WHERE id = 'DOMAIN:XIRR';

UPDATE metadata_register.expression_functions
SET function_name = 'Multiple on invested capital',
    description = 'Cash back plus the closing value, over cash in plus the opening value. The arguments are the same as XIRR. Each field is combined on this entity across the related records chosen for that field.',
    signature = 'MOIC(OPEN(value, offset), FLOWS(amount, date), CLOSE(value))',
    example = '{"fn":"MOIC","args":[{"fn":"OPEN","args":[{"ref":"FUND_NAV"},{"fn":"YTD","args":[]}]},{"fn":"FLOWS","args":[{"ref":"CAPITAL_AMOUNT"},{"ref":"CAPITAL_DATE"}]},{"fn":"FLOWS","args":[{"ref":"FEE_AMOUNT"},{"ref":"FEE_DATE"}]},{"fn":"CLOSE","args":[{"ref":"FUND_NAV"}]}]}'::jsonb,
    callable = TRUE,
    sort_order = 305
WHERE id = 'DOMAIN:MOIC';

INSERT INTO metadata_register.expression_functions (
    id, function_code, function_name, category, return_type, description, signature, example, callable, sort_order
) VALUES
    ('ROW:OPEN', 'OPEN', 'Opening value', 'ROW', 'NUMBER',
     'Starting value inside XIRR or MOIC. The field is added across the related records it is bound to. The offset is ITD, YTD, QTD, MTD, LTM, a date field on this entity, or a date function such as START_OF_QUARTER(CURRENT_DATE). QTD is the last day of the prior quarter. Omit the offset for inception to date, which has no opening value.',
     'OPEN(value, offset)',
     '{"fn":"OPEN","args":[{"ref":"FUND_NAV"},{"fn":"YTD","args":[]}]}'::jsonb, TRUE, 301),
    ('ROW:FLOWS', 'FLOWS', 'Cash flows', 'ROW', 'NUMBER',
     'One set of transactions inside XIRR or MOIC. Each related record contributes its amount and its date. Call FLOWS again for a second set that lives on another entity, such as fees beside capital activity. Flows on the opening date are left out, because that date carries the opening value. Flows after it, through the closing date, are kept.',
     'FLOWS(amount, date)',
     '{"fn":"FLOWS","args":[{"ref":"CASHFLOW_INVESTOR_AMOUNT"},{"ref":"CASHFLOW_DATE"}]}'::jsonb, TRUE, 302),
    ('ROW:CLOSE', 'CLOSE', 'Closing value', 'ROW', 'NUMBER',
     'Ending value inside XIRR or MOIC. The field is added across the related records it is bound to and dated on the as-of date. Pass an offset to close on another date.',
     'CLOSE(value)',
     '{"fn":"CLOSE","args":[{"ref":"FUND_NAV"}]}'::jsonb, TRUE, 303),
    ('ROW:ITD', 'ITD', 'Inception to date', 'ROW', 'VALUE',
     'No opening date. Every cash flow through the closing date is included.',
     'ITD', '{"fn":"ITD","args":[]}'::jsonb, TRUE, 336),
    ('ROW:YTD', 'YTD', 'Year to date', 'ROW', 'VALUE',
     'The last day of the prior year. The opening value is read that day, and cash flows after it are included.',
     'YTD', '{"fn":"YTD","args":[]}'::jsonb, TRUE, 337),
    ('ROW:QTD', 'QTD', 'Quarter to date', 'ROW', 'VALUE',
     'The last day of the prior quarter. The opening value is read that day, and cash flows after it are included.',
     'QTD', '{"fn":"QTD","args":[]}'::jsonb, TRUE, 338),
    ('ROW:MTD', 'MTD', 'Month to date', 'ROW', 'VALUE',
     'The last day of the prior month. The opening value is read that day, and cash flows after it are included.',
     'MTD', '{"fn":"MTD","args":[]}'::jsonb, TRUE, 339),
    ('ROW:LTM', 'LTM', 'Last twelve months', 'ROW', 'VALUE',
     'The same calendar day one year earlier. The opening value is read that day, and cash flows after it are included.',
     'LTM', '{"fn":"LTM","args":[]}'::jsonb, TRUE, 340)
ON CONFLICT (id) DO UPDATE SET
    function_name = EXCLUDED.function_name,
    description = EXCLUDED.description,
    signature = EXCLUDED.signature,
    example = EXCLUDED.example,
    callable = EXCLUDED.callable,
    sort_order = EXCLUDED.sort_order;

REVOKE ALL ON FUNCTION golden_master.performance_window_start(text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.performance_offset_date(jsonb, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.performance_entities(uuid, uuid, text, date, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.performance_sum(uuid, uuid, text, date, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.performance_formula(uuid, uuid, jsonb, date, integer, timestamptz, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.rewrite_performance(jsonb, uuid, uuid, date, integer, timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION golden_master.performance_window_start(text, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION golden_master.performance_offset_date(jsonb, uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION golden_master.performance_entities(uuid, uuid, text, date, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION golden_master.performance_sum(uuid, uuid, text, date, integer, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION golden_master.performance_formula(uuid, uuid, jsonb, date, integer, timestamptz, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION golden_master.rewrite_performance(jsonb, uuid, uuid, date, integer, timestamptz) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
