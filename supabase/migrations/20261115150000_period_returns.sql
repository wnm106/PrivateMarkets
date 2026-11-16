-- Actual IRR and MOIC from position market values and cash flows, over any period.
--
-- The series engine could only solve an inception-to-date XIRR with a terminal
-- value read on the root entity. This adds:
--
--   1. A period. A return over [start, end] opens with the market value at the
--      start date (as money put in), takes the cash flows after the start date
--      up to and including the end date, and closes with the market value at
--      the end date. With no start date it is inception to date.
--   2. MOIC as a second series function beside XIRR.
--   3. A terminal value summed across related entities, so a deal or a tranche
--      reads the market value of its positions as of any date.
--   4. Relationship paths that change direction. A code prefixed with ~ walks
--      that hop the other way. Deal to cash flow is up to the position and
--      then down to its cash flows.
--   5. golden_master.period_returns, which answers any start and end date at
--      query time using the same function the stored values use.
--
-- Cash flows are read from CASHFLOW_INVESTOR_AMOUNT: cash only, signed from the
-- investor's side. Money out is negative. Money back is positive. Non-cash
-- lines (unrealised, PIK accrual) carry no investor amount.
--
-- XIRR returns a decimal rate, as it always has: 0.12 is 12 percent. It is
-- annualised, including for periods shorter than a year.

-- 1. Definition columns ------------------------------------------------------

DO $$
DECLARE
    v_name TEXT;
BEGIN
    SELECT conname INTO v_name
    FROM pg_constraint
    WHERE conrelid = 'metadata_register.calc_definitions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%series_fn%';
    IF v_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE metadata_register.calc_definitions DROP CONSTRAINT %I', v_name);
    END IF;
END $$;

ALTER TABLE metadata_register.calc_definitions
    ADD CONSTRAINT calc_definitions_series_fn_check
    CHECK (series_fn IS NULL OR series_fn IN ('XIRR', 'MOIC'));

ALTER TABLE metadata_register.calc_definitions
    ADD COLUMN IF NOT EXISTS series_window VARCHAR(20) NOT NULL DEFAULT 'ITD';

ALTER TABLE metadata_register.calc_definitions
    DROP CONSTRAINT IF EXISTS calc_definitions_series_window_check;
ALTER TABLE metadata_register.calc_definitions
    ADD CONSTRAINT calc_definitions_series_window_check
    CHECK (series_window IN ('ITD', 'YTD', 'QTD', 'MTD', 'TRAILING_12M'));

COMMENT ON COLUMN metadata_register.calc_definitions.series_window IS
    'Period a stored series calc covers. ITD has no opening value. The others open with the terminal value on the day before the period starts.';

-- 2. Paths that change direction ---------------------------------------------

CREATE OR REPLACE FUNCTION golden_master.related_ids(p_root uuid, p_traversal text, p_codes text[], p_as_of date, p_knowledge timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'golden_master', 'entity_instances', 'pg_temp'
AS $function$
DECLARE
    v_current UUID[] := ARRAY[p_root];
    v_next UUID[];
    v_code TEXT;
    v_rel TEXT;
    v_down BOOLEAN;
BEGIN
    IF p_traversal = 'SELF' OR COALESCE(cardinality(p_codes), 0) = 0 THEN
        RETURN v_current;
    END IF;

    FOREACH v_code IN ARRAY p_codes LOOP
        -- A ~ prefix walks this hop against the input's traversal.
        v_rel := ltrim(v_code, '~');
        v_down := (p_traversal = 'DOWN') <> (left(v_code, 1) = '~');
        IF v_down THEN
            SELECT COALESCE(array_agg(DISTINCT er.child_entity_id), '{}')
              INTO v_next
            FROM entity_instances.entity_relationships er
            WHERE er.parent_entity_id = ANY (v_current)
              AND er.relationship_code = v_rel
              AND er.valid_from <= p_as_of
              AND er.valid_to >= p_as_of
              AND golden_master.row_known(er.system_from, er.system_to, p_knowledge);
        ELSE
            SELECT COALESCE(array_agg(DISTINCT er.parent_entity_id), '{}')
              INTO v_next
            FROM entity_instances.entity_relationships er
            WHERE er.child_entity_id = ANY (v_current)
              AND er.relationship_code = v_rel
              AND er.valid_from <= p_as_of
              AND er.valid_to >= p_as_of
              AND golden_master.row_known(er.system_from, er.system_to, p_knowledge);
        END IF;
        v_current := v_next;
        EXIT WHEN cardinality(v_current) = 0;
    END LOOP;

    RETURN v_current;
END;
$function$;

CREATE OR REPLACE FUNCTION golden_master.calc_target_entities(p_input_entity uuid, p_traversal text, p_codes text[], p_window_start date, p_window_end date)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_current UUID[] := ARRAY[p_input_entity];
    v_next UUID[];
    v_rev TEXT[];
    v_code TEXT;
    v_rel TEXT;
    v_down BOOLEAN;
    v_open TIMESTAMPTZ := golden_master.open_system_to();
BEGIN
    IF p_traversal = 'SELF' OR COALESCE(cardinality(p_codes), 0) = 0 THEN
        RETURN NEXT p_input_entity;
        RETURN;
    END IF;

    SELECT COALESCE(array_agg(code ORDER BY ordinal DESC), '{}')
      INTO v_rev
    FROM unnest(p_codes) WITH ORDINALITY AS hop(code, ordinal);

    FOREACH v_code IN ARRAY v_rev LOOP
        -- v_down is the direction the calc walks this hop. This function walks it back.
        v_rel := ltrim(v_code, '~');
        v_down := (p_traversal = 'DOWN') <> (left(v_code, 1) = '~');
        IF v_down THEN
            SELECT COALESCE(array_agg(DISTINCT er.parent_entity_id), '{}')
              INTO v_next
            FROM entity_instances.entity_relationships er
            WHERE er.child_entity_id = ANY (v_current)
              AND er.relationship_code = v_rel
              AND er.system_to = v_open
              AND er.valid_to >= p_window_start
              AND er.valid_from <= p_window_end;
        ELSE
            SELECT COALESCE(array_agg(DISTINCT er.child_entity_id), '{}')
              INTO v_next
            FROM entity_instances.entity_relationships er
            WHERE er.parent_entity_id = ANY (v_current)
              AND er.relationship_code = v_rel
              AND er.system_to = v_open
              AND er.valid_to >= p_window_start
              AND er.valid_from <= p_window_end;
        END IF;
        v_current := v_next;
        EXIT WHEN cardinality(v_current) IS NULL OR cardinality(v_current) = 0;
    END LOOP;

    RETURN QUERY SELECT DISTINCT unnest(v_current);
END;
$function$;

-- 3. The period a stored calc covers -----------------------------------------

-- The opening valuation date for a window ending at p_as_of. NULL is inception.
CREATE OR REPLACE FUNCTION golden_master.series_window_start(p_window text, p_as_of date)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
AS $function$
    SELECT CASE p_window
        WHEN 'YTD' THEN (date_trunc('year', p_as_of::timestamp) - INTERVAL '1 day')::DATE
        WHEN 'QTD' THEN (date_trunc('quarter', p_as_of::timestamp) - INTERVAL '1 day')::DATE
        WHEN 'MTD' THEN (date_trunc('month', p_as_of::timestamp) - INTERVAL '1 day')::DATE
        WHEN 'TRAILING_12M' THEN (p_as_of::timestamp - INTERVAL '1 year')::DATE
        ELSE NULL
    END;
$function$;

-- 4. The return over a period ------------------------------------------------

-- The terminal input as of a date. A SELF input reads the root. A related input sums across the related entities.
CREATE OR REPLACE FUNCTION golden_master.series_terminal(p_calc_id uuid, p_entity_id uuid, p_as_of date, p_depth integer DEFAULT 0)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'golden_master', 'metadata_register', 'entity_instances', 'public', 'pg_temp'
AS $function$
DECLARE
    v_input metadata_register.calc_inputs%ROWTYPE;
    v_entity UUID;
    v_value NUMERIC;
    v_sum NUMERIC := 0;
    v_found BOOLEAN := FALSE;
BEGIN
    SELECT * INTO v_input
    FROM metadata_register.calc_inputs
    WHERE calc_definition_id = p_calc_id AND input_role = 'TERMINAL'
    LIMIT 1;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    FOREACH v_entity IN ARRAY golden_master.related_ids(p_entity_id, v_input.traversal, v_input.relationship_codes, p_as_of) LOOP
        v_value := golden_master.golden_numeric(v_entity, v_input.attribute_code, p_as_of, p_depth + 1);
        IF v_value IS NOT NULL THEN
            v_sum := v_sum + v_value;
            v_found := TRUE;
        END IF;
    END LOOP;

    RETURN CASE WHEN v_found THEN v_sum ELSE NULL END;
END;
$function$;

-- XIRR or MOIC for one entity over (p_start, p_end]. p_start NULL is inception to date.
--
-- Opening: the terminal value at p_start, counted as money put in on that date.
-- Flows:   investor cash flows dated after p_start, up to and including p_end.
-- Closing: the terminal value at p_end, counted as money back on that date.
-- MOIC:    (cash back + closing value) / (cash in + opening value).
CREATE OR REPLACE FUNCTION golden_master.series_value(
    p_calc_id uuid, p_entity_id uuid, p_start date, p_end date, p_fn text DEFAULT NULL, p_depth integer DEFAULT 0
)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'golden_master', 'metadata_register', 'entity_instances', 'public', 'pg_temp'
AS $function$
DECLARE
    v_fn TEXT;
    v_amount_code VARCHAR(100);
    v_traversal TEXT;
    v_path TEXT[];
    v_date_code VARCHAR(100);
    v_entity UUID;
    v_amount NUMERIC;
    v_flow_date DATE;
    v_dates DATE[] := '{}';
    v_amounts NUMERIC[] := '{}';
    v_opening NUMERIC;
    v_closing NUMERIC;
    v_in NUMERIC := 0;
    v_back NUMERIC := 0;
BEGIN
    IF p_depth > 8 OR p_end IS NULL OR (p_start IS NOT NULL AND p_start >= p_end) THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(p_fn, series_fn) INTO v_fn FROM metadata_register.calc_definitions WHERE id = p_calc_id;

    SELECT attribute_code, traversal, relationship_codes
      INTO v_amount_code, v_traversal, v_path
    FROM metadata_register.calc_inputs
    WHERE calc_definition_id = p_calc_id AND input_role = 'AMOUNT'
    LIMIT 1;

    SELECT attribute_code INTO v_date_code
    FROM metadata_register.calc_inputs
    WHERE calc_definition_id = p_calc_id AND input_role = 'FLOW_DATE'
    LIMIT 1;

    IF v_amount_code IS NULL OR v_date_code IS NULL THEN
        RETURN NULL;
    END IF;

    IF p_start IS NOT NULL THEN
        v_opening := golden_master.series_terminal(p_calc_id, p_entity_id, p_start, p_depth);
        IF v_opening IS NOT NULL AND v_opening <> 0 THEN
            v_dates := v_dates || p_start;
            v_amounts := v_amounts || (-v_opening);
            v_in := v_in + v_opening;
        END IF;
    END IF;

    FOREACH v_entity IN ARRAY golden_master.related_ids(p_entity_id, v_traversal, v_path, p_end) LOOP
        v_amount := golden_master.golden_numeric(v_entity, v_amount_code, p_end, p_depth + 1);
        v_flow_date := golden_master.golden_date(v_entity, v_date_code, p_end);
        IF v_amount IS NOT NULL AND v_amount <> 0 AND v_flow_date IS NOT NULL
           AND v_flow_date <= p_end AND (p_start IS NULL OR v_flow_date > p_start) THEN
            v_dates := v_dates || v_flow_date;
            v_amounts := v_amounts || v_amount;
            IF v_amount < 0 THEN
                v_in := v_in - v_amount;
            ELSE
                v_back := v_back + v_amount;
            END IF;
        END IF;
    END LOOP;

    v_closing := golden_master.series_terminal(p_calc_id, p_entity_id, p_end, p_depth);
    IF v_closing IS NOT NULL AND v_closing <> 0 THEN
        v_dates := v_dates || p_end;
        v_amounts := v_amounts || v_closing;
        v_back := v_back + v_closing;
    END IF;

    IF v_fn = 'MOIC' THEN
        IF v_in <= 0 THEN
            RETURN NULL;
        END IF;
        RETURN v_back / v_in;
    END IF;

    -- The solver wants the flows in date order.
    RETURN (
        SELECT golden_master.xirr(array_agg(f.d ORDER BY f.d, f.ord), array_agg(f.a ORDER BY f.d, f.ord))
        FROM unnest(v_dates, v_amounts) WITH ORDINALITY AS f(d, a, ord)
    );
END;
$function$;

-- 5. Any start and end date at query time ------------------------------------

-- One row per entity and series attribute that applies to it. p_start NULL is inception to date.
CREATE OR REPLACE FUNCTION golden_master.period_returns(
    p_entity_ids uuid[], p_attribute_codes text[], p_start date, p_end date
)
 RETURNS TABLE(entity_id uuid, attribute_code text, value numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'golden_master', 'metadata_register', 'entity_instances', 'public', 'pg_temp'
AS $function$
    SELECT me.id,
           ar.attribute_code::TEXT,
           golden_master.series_value(cd.id, me.id, p_start, COALESCE(p_end, CURRENT_DATE), cd.series_fn, 0)
    FROM entity_instances.master_entities me
    JOIN metadata_register.calc_definitions cd ON cd.domain_code = me.domain_code AND cd.calc_kind = 'SERIES'
    JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
    WHERE me.id = ANY (p_entity_ids)
      AND ar.attribute_code = ANY (p_attribute_codes);
$function$;

-- The service role reads calc definitions when it answers a period return on the server.
GRANT SELECT ON metadata_register.calc_definitions, metadata_register.calc_inputs TO service_role;

-- Read-only helpers the period return walks through. They run with the caller's rights, so row security still applies.
GRANT EXECUTE ON FUNCTION golden_master.related_ids(uuid, text, text[], date, timestamp with time zone) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION golden_master.row_known(timestamp with time zone, timestamp with time zone, timestamp with time zone) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION golden_master.period_returns(uuid[], text[], date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION golden_master.series_value(uuid, uuid, date, date, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION golden_master.series_terminal(uuid, uuid, date, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION golden_master.series_window_start(text, date) TO authenticated, service_role;

-- 6. The set-based path only knows the original shape ------------------------

-- Anything else goes through eval_calc one output date at a time.
CREATE OR REPLACE FUNCTION golden_master.series_batch_capable(p_calc_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM metadata_register.calc_definitions cd
        WHERE cd.id = p_calc_id AND cd.evaluation_mode = 'MATERIALIZED' AND cd.calc_kind = 'SERIES'
          AND cd.series_fn = 'XIRR' AND cd.series_window = 'ITD'
          AND cd.output_grain IN ('MONTH_END', 'QUARTER_END', 'YEAR_END')
    )
    AND (SELECT COUNT(*) FROM metadata_register.calc_inputs ci WHERE ci.calc_definition_id = p_calc_id AND ci.input_role = 'AMOUNT') = 1
    AND (SELECT COUNT(*) FROM metadata_register.calc_inputs ci WHERE ci.calc_definition_id = p_calc_id AND ci.input_role = 'FLOW_DATE') = 1
    AND (SELECT COUNT(*) FROM metadata_register.calc_inputs ci WHERE ci.calc_definition_id = p_calc_id AND ci.input_role = 'TERMINAL' AND ci.traversal = 'SELF') = 1
    AND NOT EXISTS (
        SELECT 1 FROM metadata_register.calc_inputs ci, unnest(ci.relationship_codes) AS hop(code)
        WHERE ci.calc_definition_id = p_calc_id AND left(hop.code, 1) = '~'
    );
$function$;

-- 7. Signed investor cash on a cash flow -------------------------------------

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    is_required, default_precedence_rank, display_section, display_group,
    is_editable, is_visible, is_time_varying, time_dimension, is_derived
) VALUES
    ('CASHFLOW_INVESTOR_AMOUNT', 'Investor Cash Amount', 'CURRENCY',
     'Cash only, signed from the investor side. Money out is negative, money back is positive. Blank on non-cash lines. Returns are solved from this.', 'CASH_FLOW',
     FALSE, 100, 'General', 5, TRUE, TRUE, FALSE, 'NONE', FALSE),
    ('POSITION_IRR_ITD', 'IRR, Inception to Date', 'PERCENTAGE',
     'Annualised return from the position cash flows and its market value. A decimal rate: 0.12 is 12 percent.', 'POSITION',
     FALSE, 100, 'Returns', 1, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('POSITION_MOIC_ITD', 'MOIC, Inception to Date', 'NUMBER',
     'Cash back plus market value, over cash in', 'POSITION',
     FALSE, 100, 'Returns', 2, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('TRANCHE_IRR_ITD', 'IRR, Inception to Date', 'PERCENTAGE',
     'Annualised return from the cash flows and market value of every position in the tranche. A decimal rate: 0.12 is 12 percent.', 'DEAL_TRANCHE',
     FALSE, 100, 'Returns', 1, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('TRANCHE_MOIC_ITD', 'MOIC, Inception to Date', 'NUMBER',
     'Cash back plus market value, over cash in, across every position in the tranche', 'DEAL_TRANCHE',
     FALSE, 100, 'Returns', 2, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_IRR_ITD', 'IRR, Inception to Date', 'PERCENTAGE',
     'Annualised return from the cash flows and market value of every position in the deal. A decimal rate: 0.12 is 12 percent.', 'DEAL',
     FALSE, 100, 'Returns', 1, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE),
    ('DEAL_MOIC_ITD', 'MOIC, Inception to Date', 'NUMBER',
     'Cash back plus market value, over cash in, across every position in the deal', 'DEAL',
     FALSE, 100, 'Returns', 2, FALSE, TRUE, TRUE, 'VALID_TIME', FALSE)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    data_type = EXCLUDED.data_type,
    domain_code = EXCLUDED.domain_code,
    is_editable = EXCLUDED.is_editable,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, precedence_rank, display_order)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = a.domain_code || '_STANDARD'
WHERE a.attribute_code IN (
    'CASHFLOW_INVESTOR_AMOUNT', 'POSITION_IRR_ITD', 'POSITION_MOIC_ITD',
    'TRANCHE_IRR_ITD', 'TRANCHE_MOIC_ITD', 'DEAL_IRR_ITD', 'DEAL_MOIC_ITD'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- 8. The stored inception-to-date returns ------------------------------------

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, series_fn, series_window
)
SELECT ar.id, v.domain_code, 'SERIES', 'MATERIALIZED', 'FORWARD', 'MONTH_END', v.fn, 'ITD'
FROM (VALUES
    ('POSITION_IRR_ITD', 'POSITION', 'XIRR'),
    ('POSITION_MOIC_ITD', 'POSITION', 'MOIC'),
    ('TRANCHE_IRR_ITD', 'DEAL_TRANCHE', 'XIRR'),
    ('TRANCHE_MOIC_ITD', 'DEAL_TRANCHE', 'MOIC'),
    ('DEAL_IRR_ITD', 'DEAL', 'XIRR'),
    ('DEAL_MOIC_ITD', 'DEAL', 'MOIC')
) AS v(code, domain_code, fn)
JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.code
ON CONFLICT (attribute_id) DO UPDATE
SET calc_kind = EXCLUDED.calc_kind, evaluation_mode = EXCLUDED.evaluation_mode, output_grain = EXCLUDED.output_grain,
    series_fn = EXCLUDED.series_fn, series_window = EXCLUDED.series_window;

-- Position: its own cash flows, its own market value.
-- Tranche:  up to its positions, then down to their cash flows; market value summed across the positions.
-- Deal:     up to its tranches and their positions, then down to the cash flows.
INSERT INTO metadata_register.calc_inputs (calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal)
SELECT cd.id, v.role, v.attribute_code, v.traversal, v.codes, v.ord
FROM (VALUES
    ('POSITION', 'AMOUNT', 'CASHFLOW_INVESTOR_AMOUNT', 'DOWN', ARRAY['POSITION_CASHFLOW'], 1),
    ('POSITION', 'FLOW_DATE', 'CASHFLOW_DATE', 'DOWN', ARRAY['POSITION_CASHFLOW'], 2),
    ('POSITION', 'TERMINAL', 'MARKET_VALUE', 'SELF', ARRAY[]::TEXT[], 3),
    ('DEAL_TRANCHE', 'AMOUNT', 'CASHFLOW_INVESTOR_AMOUNT', 'UP', ARRAY['POSITION_TRANCHE', '~POSITION_CASHFLOW'], 1),
    ('DEAL_TRANCHE', 'FLOW_DATE', 'CASHFLOW_DATE', 'UP', ARRAY['POSITION_TRANCHE', '~POSITION_CASHFLOW'], 2),
    ('DEAL_TRANCHE', 'TERMINAL', 'MARKET_VALUE', 'UP', ARRAY['POSITION_TRANCHE'], 3),
    ('DEAL', 'AMOUNT', 'CASHFLOW_INVESTOR_AMOUNT', 'UP', ARRAY['TRANCHE_DEAL', 'POSITION_TRANCHE', '~POSITION_CASHFLOW'], 1),
    ('DEAL', 'FLOW_DATE', 'CASHFLOW_DATE', 'UP', ARRAY['TRANCHE_DEAL', 'POSITION_TRANCHE', '~POSITION_CASHFLOW'], 2),
    ('DEAL', 'TERMINAL', 'MARKET_VALUE', 'UP', ARRAY['TRANCHE_DEAL', 'POSITION_TRANCHE'], 3)
) AS v(domain_code, role, attribute_code, traversal, codes, ord)
JOIN metadata_register.calc_definitions cd ON cd.domain_code = v.domain_code AND cd.calc_kind = 'SERIES'
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
    AND ar.attribute_code IN ('POSITION_IRR_ITD', 'POSITION_MOIC_ITD', 'TRANCHE_IRR_ITD', 'TRANCHE_MOIC_ITD', 'DEAL_IRR_ITD', 'DEAL_MOIC_ITD')
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO UPDATE
SET traversal = EXCLUDED.traversal, relationship_codes = EXCLUDED.relationship_codes, ordinal = EXCLUDED.ordinal;

INSERT INTO metadata_register.expression_functions (
    id, function_code, function_name, category, return_type, description, signature, example, callable, sort_order
) VALUES (
    'DOMAIN:MOIC', 'MOIC', 'Multiple on invested capital', 'DOMAIN', 'NUMBER',
    'Cash back plus the closing value, over cash in plus the opening value. Set the calc kind to SERIES and series_fn to MOIC, with AMOUNT, FLOW_DATE, and TERMINAL inputs. Amounts are signed from the investor side.',
    'series_fn MOIC', '{"inputs":["AMOUNT","FLOW_DATE","TERMINAL"],"seriesFn":"MOIC"}'::jsonb, FALSE, 305
)
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description, example = EXCLUDED.example;

-- 9. eval_calc hands a series calc to series_value ----------------------------

CREATE OR REPLACE FUNCTION golden_master.eval_calc(p_calc_id uuid, p_entity_id uuid, p_as_of date, p_depth integer DEFAULT 0)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'golden_master', 'metadata_register', 'entity_instances', 'public', 'pg_temp'
AS $function$
DECLARE
    v_def metadata_register.calc_definitions%ROWTYPE;
    v_input metadata_register.calc_inputs%ROWTYPE;
    v_result JSONB;
    v_ids UUID[];
    v_entity UUID;
    v_value NUMERIC;
    v_weight NUMERIC;
    v_weighted NUMERIC := 0;
    v_weight_sum NUMERIC := 0;
    v_sum NUMERIC := 0;
    v_min NUMERIC;
    v_max NUMERIC;
    v_count INTEGER := 0;
    v_dates DATE[] := '{}';
    v_amounts NUMERIC[] := '{}';
    v_amount_code VARCHAR(100);
    v_date_code VARCHAR(100);
    v_terminal_code VARCHAR(100);
    v_path TEXT[];
    v_traversal TEXT;
    v_flow_date DATE;
    v_amount NUMERIC;
    v_terminal NUMERIC;
    v_weight_code VARCHAR(100);
BEGIN
    IF p_depth > 8 THEN
        RETURN NULL;
    END IF;

    SELECT * INTO v_def FROM metadata_register.calc_definitions WHERE id = p_calc_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_def.calc_kind = 'EXPRESSION' THEN
        v_result := golden_master.eval_expression_result(p_calc_id, p_entity_id, p_as_of, p_depth);
        IF v_result IS NULL OR jsonb_typeof(v_result) = 'null' THEN
            RETURN NULL;
        END IF;
        IF jsonb_typeof(v_result) = 'number'
           OR (jsonb_typeof(v_result) = 'string' AND (v_result #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$') THEN
            RETURN (v_result #>> '{}')::NUMERIC;
        END IF;
        RETURN NULL;
    END IF;

    IF v_def.calc_kind = 'AGGREGATE' THEN
        SELECT * INTO v_input
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = p_calc_id AND input_role = 'MEASURE'
        LIMIT 1;
        v_ids := golden_master.related_ids(p_entity_id, v_input.traversal, v_input.relationship_codes, p_as_of);

        SELECT attribute_code INTO v_weight_code
        FROM metadata_register.calc_inputs
        WHERE calc_definition_id = p_calc_id AND input_role = 'WEIGHT'
        LIMIT 1;

        FOREACH v_entity IN ARRAY v_ids LOOP
            v_value := golden_master.golden_numeric(v_entity, v_input.attribute_code, p_as_of, p_depth + 1);
            IF v_value IS NULL THEN
                CONTINUE;
            END IF;
            v_count := v_count + 1;
            v_sum := v_sum + v_value;
            v_min := LEAST(COALESCE(v_min, v_value), v_value);
            v_max := GREATEST(COALESCE(v_max, v_value), v_value);
            IF v_def.aggregate_fn = 'WAVG' THEN
                v_weight := golden_master.golden_numeric(v_entity, v_weight_code, p_as_of, p_depth + 1);
                IF v_weight IS NOT NULL THEN
                    v_weighted := v_weighted + (v_value * v_weight);
                    v_weight_sum := v_weight_sum + v_weight;
                END IF;
            END IF;
        END LOOP;

        IF v_count = 0 THEN
            RETURN NULL;
        END IF;
        IF v_def.aggregate_fn = 'SUM' THEN
            RETURN v_sum;
        ELSIF v_def.aggregate_fn = 'MIN' THEN
            RETURN v_min;
        ELSIF v_def.aggregate_fn = 'MAX' THEN
            RETURN v_max;
        ELSIF v_def.aggregate_fn = 'WAVG' THEN
            IF v_weight_sum = 0 THEN
                RETURN NULL;
            END IF;
            RETURN v_weighted / v_weight_sum;
        END IF;
        RETURN NULL;
    END IF;

    -- SERIES: the same function answers a stored window and a query-time period.
    RETURN golden_master.series_value(
        p_calc_id, p_entity_id,
        golden_master.series_window_start(v_def.series_window, p_as_of), p_as_of,
        v_def.series_fn, p_depth
    );
END;
$function$;
