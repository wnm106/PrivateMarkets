-- Best-practice expression library for calculated attributes.
-- Row functions execute inside an expression. Group, domain, and display rows
-- are guidance: adding a catalog row does not create a new runtime function.

CREATE TABLE metadata_register.expression_functions (
    id TEXT PRIMARY KEY,
    function_code TEXT NOT NULL,
    function_name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('ROW', 'GROUP', 'DOMAIN', 'DISPLAY')),
    return_type TEXT NOT NULL CHECK (return_type IN ('NUMBER', 'TEXT', 'VALUE', 'DISPLAY')),
    description TEXT NOT NULL,
    signature TEXT NOT NULL,
    example JSONB NOT NULL,
    callable BOOLEAN NOT NULL,
    sort_order INTEGER NOT NULL,
    UNIQUE (category, function_code)
);

COMMENT ON TABLE metadata_register.expression_functions IS
    'Curated expression functions and patterns. Only callable row codes are implemented by metadata_register.eval_expr.';

INSERT INTO metadata_register.expression_functions (
    id, function_code, function_name, category, return_type, description, signature, example, callable, sort_order
) VALUES
    ('ROW:ABS', 'ABS', 'Absolute value', 'ROW', 'NUMBER',
     'Distance from zero. A blank input stays blank.',
     'ABS(number)', '{"fn":"ABS","args":[{"const":-4}]}'::jsonb, TRUE, 10),
    ('ROW:ROUND', 'ROUND', 'Round', 'ROW', 'NUMBER',
     'Rounds half away from zero. Omit places to round to a whole number. Use this when the stored value should change precision. Display rounding belongs on the attribute.',
     'ROUND(number, places)', '{"fn":"ROUND","args":[{"const":1.26},{"const":1}]}'::jsonb, TRUE, 20),
    ('ROW:FLOOR', 'FLOOR', 'Floor', 'ROW', 'NUMBER',
     'Greatest whole number that is not larger than the input.',
     'FLOOR(number)', '{"fn":"FLOOR","args":[{"const":1.9}]}'::jsonb, TRUE, 30),
    ('ROW:CEIL', 'CEIL', 'Ceiling', 'ROW', 'NUMBER',
     'Smallest whole number that is not smaller than the input.',
     'CEIL(number)', '{"fn":"CEIL","args":[{"const":1.1}]}'::jsonb, TRUE, 40),
    ('ROW:MIN', 'MIN', 'Minimum', 'ROW', 'NUMBER',
     'Smallest of the arguments on one entity. Blank arguments are skipped. To take the minimum across related entities, use the group function MIN instead.',
     'MIN(number, ...)', '{"fn":"MIN","args":[{"ref":"PRICE"},{"ref":"PRIOR_PRICE"}]}'::jsonb, TRUE, 50),
    ('ROW:MAX', 'MAX', 'Maximum', 'ROW', 'NUMBER',
     'Largest of the arguments on one entity. Blank arguments are skipped. To take the maximum across related entities, use the group function MAX instead.',
     'MAX(number, ...)', '{"fn":"MAX","args":[{"ref":"PRICE"},{"ref":"PRIOR_PRICE"}]}'::jsonb, TRUE, 60),
    ('ROW:COALESCE', 'COALESCE', 'First value', 'ROW', 'VALUE',
     'First argument that is not blank, keeping it as text or a number.',
     'COALESCE(value, ...)', '{"fn":"COALESCE","args":[{"ref":"SHORT_NAME"},{"ref":"LEGAL_NAME"}]}'::jsonb, TRUE, 70),
    ('ROW:CONCAT', 'CONCAT', 'Concatenate', 'ROW', 'TEXT',
     'Joins text. A blank argument is skipped, so a missing middle piece does not blank the whole result. Numbers are written as plain decimals.',
     'CONCAT(value, ...)', '{"fn":"CONCAT","args":[{"ref":"SECURITY_NAME"},{"const":" "},{"ref":"CURRENCY"}]}'::jsonb, TRUE, 80),
    ('ROW:UPPER', 'UPPER', 'Upper case', 'ROW', 'TEXT',
     'Converts text to upper case.',
     'UPPER(text)', '{"fn":"UPPER","args":[{"ref":"TICKER"}]}'::jsonb, TRUE, 90),
    ('ROW:LOWER', 'LOWER', 'Lower case', 'ROW', 'TEXT',
     'Converts text to lower case.',
     'LOWER(text)', '{"fn":"LOWER","args":[{"ref":"TICKER"}]}'::jsonb, TRUE, 100),
    ('ROW:TRIM', 'TRIM', 'Trim', 'ROW', 'TEXT',
     'Removes leading and trailing spaces.',
     'TRIM(text)', '{"fn":"TRIM","args":[{"ref":"SECURITY_NAME"}]}'::jsonb, TRUE, 110),
    ('ROW:LEFT', 'LEFT', 'Left', 'ROW', 'TEXT',
     'First characters of a text value. The count is zero or more.',
     'LEFT(text, count)', '{"fn":"LEFT","args":[{"ref":"CUSIP"},{"const":8}]}'::jsonb, TRUE, 120),
    ('ROW:LENGTH', 'LENGTH', 'Length', 'ROW', 'NUMBER',
     'Number of characters.',
     'LENGTH(text)', '{"fn":"LENGTH","args":[{"ref":"CUSIP"}]}'::jsonb, TRUE, 130),
    ('ROW:ADD', 'ADD', 'Add', 'ROW', 'NUMBER',
     'Adds two numbers. The op form {"op":"add","args":[...]} is the same function. A blank input makes the result blank.',
     'ADD(number, number)', '{"fn":"ADD","args":[{"ref":"COST"},{"ref":"FEE"}]}'::jsonb, TRUE, 140),
    ('ROW:SUB', 'SUB', 'Subtract', 'ROW', 'NUMBER',
     'Subtracts the second number from the first. A blank input makes the result blank.',
     'SUB(number, number)', '{"op":"sub","args":[{"ref":"MARKET_VALUE"},{"ref":"COST"}]}'::jsonb, TRUE, 150),
    ('ROW:MUL', 'MUL', 'Multiply', 'ROW', 'NUMBER',
     'Multiplies two numbers. Market value is quantity times price. A blank input makes the result blank.',
     'MUL(number, number)', '{"op":"mul","args":[{"ref":"QUANTITY"},{"ref":"PRICE"}]}'::jsonb, TRUE, 160),
    ('ROW:DIV', 'DIV', 'Divide', 'ROW', 'NUMBER',
     'Divides the first number by the second. A blank input or a zero divisor makes the result blank.',
     'DIV(number, number)', '{"op":"div","args":[{"ref":"INCOME"},{"ref":"PRICE"}]}'::jsonb, TRUE, 170),
    ('ROW:NEG', 'NEG', 'Negate', 'ROW', 'NUMBER',
     'Changes the sign. A blank input stays blank.',
     'NEG(number)', '{"op":"neg","args":[{"ref":"AMOUNT"}]}'::jsonb, TRUE, 180),
    ('GROUP:SUM', 'SUM', 'Sum', 'GROUP', 'NUMBER',
     'Adds a measure across related entities. Set the calc kind to AGGREGATE and aggregate_fn to SUM. Gross asset value is the sum of position market value.',
     'aggregate_fn SUM', '{"aggregateFn":"SUM","inputRole":"MEASURE","attributeCode":"MARKET_VALUE"}'::jsonb, FALSE, 200),
    ('GROUP:WAVG', 'WAVG', 'Weighted average', 'GROUP', 'NUMBER',
     'Average of a measure weighted by a second attribute. Declare a MEASURE and a WEIGHT. A zero total weight stays blank.',
     'aggregate_fn WAVG', '{"aggregateFn":"WAVG","measure":"COUPON","weight":"PAR"}'::jsonb, FALSE, 210),
    ('GROUP:MIN', 'MIN', 'Group minimum', 'GROUP', 'NUMBER',
     'Smallest measure across the related entities. Set aggregate_fn to MIN. This is separate from the row function MIN, which compares arguments inside one expression.',
     'aggregate_fn MIN', '{"aggregateFn":"MIN","inputRole":"MEASURE","attributeCode":"PRICE"}'::jsonb, FALSE, 220),
    ('GROUP:MAX', 'MAX', 'Group maximum', 'GROUP', 'NUMBER',
     'Largest measure across the related entities. Set aggregate_fn to MAX. This is separate from the row function MAX.',
     'aggregate_fn MAX', '{"aggregateFn":"MAX","inputRole":"MEASURE","attributeCode":"PRICE"}'::jsonb, FALSE, 230),
    ('DOMAIN:XIRR', 'XIRR', 'Internal rate of return', 'DOMAIN', 'NUMBER',
     'Annualized rate from dated cash flows plus a terminal value. Set the calc kind to SERIES and series_fn to XIRR, with AMOUNT, FLOW_DATE, and TERMINAL inputs. A filtered or quarter-only IRR calls this same function at query time with a population and a horizon. It is not a different formula.',
     'series_fn XIRR', '{"seriesFn":"XIRR","inputs":["AMOUNT","FLOW_DATE","TERMINAL"]}'::jsonb, FALSE, 300),
    ('DOMAIN:CURRENT_YIELD', 'CURRENT_YIELD', 'Current yield', 'DOMAIN', 'NUMBER',
     'Income divided by price. Copy the example into the expression and declare INCOME and PRICE as operands. This is not a bond-yield solver.',
     'INCOME / PRICE', '{"op":"div","args":[{"ref":"INCOME"},{"ref":"PRICE"}]}'::jsonb, FALSE, 310),
    ('DOMAIN:UNREALIZED_PNL', 'UNREALIZED_PNL', 'Unrealized P&L', 'DOMAIN', 'NUMBER',
     'Market value minus cost on the same entity. Copy the example and declare both operands.',
     'MARKET_VALUE - COST', '{"op":"sub","args":[{"ref":"MARKET_VALUE"},{"ref":"COST"}]}'::jsonb, FALSE, 320),
    ('DOMAIN:NET_MULTIPLE', 'NET_MULTIPLE', 'Net multiple', 'DOMAIN', 'NUMBER',
     'Distributions divided by contributions. Sum each amount across the group first, then divide once. Do not average entity-level multiples.',
     'SUM(DISTRIBUTIONS) / SUM(CONTRIBUTIONS)',
     '{"pattern":"expression of totals","expression":{"op":"div","args":[{"ref":"DISTRIBUTIONS"},{"ref":"CONTRIBUTIONS"}]}}'::jsonb,
     FALSE, 330),
    ('DISPLAY:FORMAT', 'FORMAT', 'Format', 'DISPLAY', 'DISPLAY',
     'Format is the attribute displayFormat, not a formula. The formula returns the value and the screen formats it. Use ROUND only when the stored number itself should change precision.',
     'attribute.displayFormat', '{"displayFormat":"#,##0.00"}'::jsonb, FALSE, 400)
ON CONFLICT (id) DO UPDATE SET
    function_name = EXCLUDED.function_name,
    description = EXCLUDED.description,
    signature = EXCLUDED.signature,
    example = EXCLUDED.example,
    callable = EXCLUDED.callable,
    sort_order = EXCLUDED.sort_order;

ALTER TABLE metadata_register.expression_functions ENABLE ROW LEVEL SECURITY;

CREATE POLICY expression_functions_read ON metadata_register.expression_functions
    FOR SELECT TO authenticated USING (TRUE);

GRANT SELECT ON metadata_register.expression_functions TO authenticated, service_role;

CREATE OR REPLACE VIEW public.expression_functions
WITH (security_invoker = true) AS
SELECT
    id,
    function_code,
    function_name,
    category,
    return_type,
    description,
    signature,
    example,
    callable,
    sort_order
FROM metadata_register.expression_functions;

COMMENT ON VIEW public.expression_functions IS
    'Expression function library. Row functions are callable from a calc expression. Format is display metadata.';

GRANT SELECT ON public.expression_functions TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Evaluator. Results are JSON null, a JSON number, or a JSON string.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION metadata_register.expr_number(p_value JSONB, p_fn TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
    v_text TEXT;
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_value) = 'number' THEN
        RETURN (p_value #>> '{}')::NUMERIC;
    END IF;
    IF jsonb_typeof(p_value) = 'string' THEN
        v_text := p_value #>> '{}';
        IF v_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
            RETURN v_text::NUMERIC;
        END IF;
    END IF;
    RAISE EXCEPTION '% expects a number', p_fn;
END;
$$;

CREATE OR REPLACE FUNCTION metadata_register.expr_apply_op(p_op TEXT, p_left NUMERIC, p_right NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
SET search_path = metadata_register, pg_temp
AS $$
BEGIN
    IF p_left IS NULL OR p_right IS NULL THEN
        RETURN NULL;
    END IF;
    IF p_op = 'add' THEN
        RETURN p_left + p_right;
    ELSIF p_op = 'sub' THEN
        RETURN p_left - p_right;
    ELSIF p_op = 'mul' THEN
        RETURN p_left * p_right;
    ELSIF p_op = 'div' THEN
        IF p_right = 0 THEN
            RETURN NULL;
        END IF;
        RETURN p_left / p_right;
    END IF;
    RAISE EXCEPTION 'Unsupported calc expression op: %', p_op;
END;
$$;

CREATE OR REPLACE FUNCTION metadata_register.eval_expr(p_expr JSONB, p_vars JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
    v_fn TEXT;
    v_args JSONB;
    v_count INTEGER;
    v_index INTEGER;
    v_child JSONB;
    v_num NUMERIC;
    v_left NUMERIC;
    v_right NUMERIC;
    v_places INTEGER;
    v_text TEXT;
    v_best NUMERIC;
    v_seen BOOLEAN;
BEGIN
    IF p_expr IS NULL OR jsonb_typeof(p_expr) = 'null' THEN
        RETURN 'null'::jsonb;
    END IF;

    IF p_expr ? 'const' THEN
        RETURN p_expr->'const';
    END IF;

    IF p_expr ? 'ref' THEN
        IF p_vars IS NOT NULL AND p_vars ? (p_expr->>'ref') THEN
            RETURN COALESCE(p_vars->(p_expr->>'ref'), 'null'::jsonb);
        END IF;
        RETURN 'null'::jsonb;
    END IF;

    IF p_expr ? 'op' THEN
        v_fn := lower(p_expr->>'op');
        v_args := COALESCE(p_expr->'args', '[]'::jsonb);
        IF v_fn = 'neg' THEN
            v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), 'NEG');
            IF v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            RETURN to_jsonb(-v_num);
        END IF;
        v_left := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), upper(v_fn));
        v_right := metadata_register.expr_number(metadata_register.eval_expr(v_args->1, p_vars), upper(v_fn));
        v_num := metadata_register.expr_apply_op(v_fn, v_left, v_right);
        IF v_num IS NULL THEN
            RETURN 'null'::jsonb;
        END IF;
        RETURN to_jsonb(v_num);
    END IF;

    IF p_expr ? 'fn' THEN
        v_fn := upper(p_expr->>'fn');
        v_args := COALESCE(p_expr->'args', '[]'::jsonb);
        v_count := jsonb_array_length(v_args);

        IF v_fn IN ('ABS', 'FLOOR', 'CEIL') THEN
            IF v_count <> 1 THEN
                RAISE EXCEPTION '% expects 1 argument', v_fn;
            END IF;
            v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), v_fn);
            IF v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            IF v_fn = 'ABS' THEN
                RETURN to_jsonb(abs(v_num));
            ELSIF v_fn = 'FLOOR' THEN
                RETURN to_jsonb(floor(v_num));
            END IF;
            RETURN to_jsonb(ceil(v_num));
        END IF;

        IF v_fn = 'ROUND' THEN
            IF v_count < 1 OR v_count > 2 THEN
                RAISE EXCEPTION 'ROUND expects 1 or 2 arguments';
            END IF;
            v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), v_fn);
            IF v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            IF v_count = 1 THEN
                v_places := 0;
            ELSE
                v_right := metadata_register.expr_number(metadata_register.eval_expr(v_args->1, p_vars), v_fn);
                IF v_right IS NULL THEN
                    RETURN 'null'::jsonb;
                END IF;
                v_places := trunc(v_right)::INTEGER;
            END IF;
            RETURN to_jsonb(round(v_num, v_places));
        END IF;

        IF v_fn IN ('MIN', 'MAX') THEN
            IF v_count < 1 THEN
                RAISE EXCEPTION '% expects 1 or more arguments', v_fn;
            END IF;
            v_best := NULL;
            v_seen := FALSE;
            FOR v_index IN 0..(v_count - 1) LOOP
                v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->v_index, p_vars), v_fn);
                IF v_num IS NULL THEN
                    CONTINUE;
                END IF;
                IF NOT v_seen THEN
                    v_best := v_num;
                    v_seen := TRUE;
                ELSIF v_fn = 'MIN' THEN
                    v_best := LEAST(v_best, v_num);
                ELSE
                    v_best := GREATEST(v_best, v_num);
                END IF;
            END LOOP;
            IF NOT v_seen THEN
                RETURN 'null'::jsonb;
            END IF;
            RETURN to_jsonb(v_best);
        END IF;

        IF v_fn = 'COALESCE' THEN
            IF v_count < 1 THEN
                RAISE EXCEPTION 'COALESCE expects 1 or more arguments';
            END IF;
            FOR v_index IN 0..(v_count - 1) LOOP
                v_child := metadata_register.eval_expr(v_args->v_index, p_vars);
                IF v_child IS NOT NULL AND jsonb_typeof(v_child) <> 'null' THEN
                    RETURN v_child;
                END IF;
            END LOOP;
            RETURN 'null'::jsonb;
        END IF;

        IF v_fn = 'CONCAT' THEN
            IF v_count < 1 THEN
                RAISE EXCEPTION 'CONCAT expects 1 or more arguments';
            END IF;
            v_text := '';
            FOR v_index IN 0..(v_count - 1) LOOP
                v_child := metadata_register.eval_expr(v_args->v_index, p_vars);
                IF v_child IS NULL OR jsonb_typeof(v_child) = 'null' THEN
                    CONTINUE;
                END IF;
                v_text := v_text || (v_child #>> '{}');
            END LOOP;
            RETURN to_jsonb(v_text);
        END IF;

        IF v_fn IN ('UPPER', 'LOWER', 'TRIM', 'LENGTH') THEN
            IF v_count <> 1 THEN
                RAISE EXCEPTION '% expects 1 argument', v_fn;
            END IF;
            v_child := metadata_register.eval_expr(v_args->0, p_vars);
            IF v_child IS NULL OR jsonb_typeof(v_child) = 'null' THEN
                RETURN 'null'::jsonb;
            END IF;
            v_text := v_child #>> '{}';
            IF v_fn = 'UPPER' THEN
                RETURN to_jsonb(upper(v_text));
            ELSIF v_fn = 'LOWER' THEN
                RETURN to_jsonb(lower(v_text));
            ELSIF v_fn = 'TRIM' THEN
                RETURN to_jsonb(btrim(v_text));
            END IF;
            RETURN to_jsonb(length(v_text));
        END IF;

        IF v_fn = 'LEFT' THEN
            IF v_count <> 2 THEN
                RAISE EXCEPTION 'LEFT expects 2 arguments';
            END IF;
            v_child := metadata_register.eval_expr(v_args->0, p_vars);
            v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->1, p_vars), v_fn);
            IF v_child IS NULL OR jsonb_typeof(v_child) = 'null' OR v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            v_places := trunc(v_num)::INTEGER;
            IF v_places < 0 THEN
                RAISE EXCEPTION 'LEFT expects a count of zero or more';
            END IF;
            RETURN to_jsonb(left(v_child #>> '{}', v_places));
        END IF;

        IF v_fn = 'NEG' THEN
            IF v_count <> 1 THEN
                RAISE EXCEPTION 'NEG expects 1 argument';
            END IF;
            v_num := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), v_fn);
            IF v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            RETURN to_jsonb(-v_num);
        END IF;

        IF v_fn IN ('ADD', 'SUB', 'MUL', 'DIV') THEN
            IF v_count <> 2 THEN
                RAISE EXCEPTION '% expects 2 arguments', v_fn;
            END IF;
            v_left := metadata_register.expr_number(metadata_register.eval_expr(v_args->0, p_vars), v_fn);
            v_right := metadata_register.expr_number(metadata_register.eval_expr(v_args->1, p_vars), v_fn);
            v_num := metadata_register.expr_apply_op(lower(v_fn), v_left, v_right);
            IF v_num IS NULL THEN
                RETURN 'null'::jsonb;
            END IF;
            RETURN to_jsonb(v_num);
        END IF;

        RAISE EXCEPTION 'Unknown expression function: %', v_fn;
    END IF;

    RAISE EXCEPTION 'Unsupported calc expression';
END;
$$;

CREATE OR REPLACE FUNCTION metadata_register.eval_numeric_expr(p_expr JSONB, p_vars JSONB)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
    v_value JSONB;
    v_text TEXT;
BEGIN
    v_value := metadata_register.eval_expr(p_expr, p_vars);
    IF v_value IS NULL OR jsonb_typeof(v_value) = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(v_value) = 'number' THEN
        RETURN (v_value #>> '{}')::NUMERIC;
    END IF;
    IF jsonb_typeof(v_value) = 'string' THEN
        v_text := v_value #>> '{}';
        IF v_text ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
            RETURN v_text::NUMERIC;
        END IF;
    END IF;
    RAISE EXCEPTION 'Expression returned text, not a number';
END;
$$;

-- ---------------------------------------------------------------------------
-- Expression inputs keep text. Numeric attributes still arrive as numbers.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION golden_master.golden_literal(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of DATE,
    p_depth INTEGER DEFAULT 0
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
    v_open TIMESTAMPTZ := golden_master.open_system_to();
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
        RETURN golden_master.eval_expression_result(v_calc_id, p_entity_id, p_as_of, p_depth + 1);
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
      AND eav.system_to = v_open
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
    v_vars JSONB := '{}'::jsonb;
    v_entity UUID;
    v_literal JSONB;
BEGIN
    IF p_depth > 8 THEN
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
        IF v_input.traversal = 'SELF' THEN
            v_entity := p_entity_id;
        ELSE
            v_entity := golden_master.related_one(p_entity_id, v_input.traversal, v_input.relationship_codes, p_as_of);
        END IF;
        IF v_entity IS NULL THEN
            v_literal := 'null'::jsonb;
        ELSE
            v_literal := golden_master.golden_literal(v_entity, v_input.attribute_code, p_as_of, p_depth + 1);
        END IF;
        v_vars := v_vars || jsonb_build_object(v_input.attribute_code, v_literal);
    END LOOP;

    RETURN metadata_register.eval_expr(v_def.expression, v_vars);
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.eval_calc(
    p_calc_id UUID,
    p_entity_id UUID,
    p_as_of DATE,
    p_depth INTEGER DEFAULT 0
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
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

    SELECT attribute_code, traversal, relationship_codes
      INTO v_amount_code, v_traversal, v_path
    FROM metadata_register.calc_inputs
    WHERE calc_definition_id = p_calc_id AND input_role = 'AMOUNT'
    LIMIT 1;

    SELECT attribute_code INTO v_date_code
    FROM metadata_register.calc_inputs
    WHERE calc_definition_id = p_calc_id AND input_role = 'FLOW_DATE'
    LIMIT 1;

    SELECT attribute_code INTO v_terminal_code
    FROM metadata_register.calc_inputs
    WHERE calc_definition_id = p_calc_id AND input_role = 'TERMINAL'
    LIMIT 1;

    v_ids := golden_master.related_ids(p_entity_id, v_traversal, v_path, p_as_of);
    FOREACH v_entity IN ARRAY v_ids LOOP
        v_amount := golden_master.golden_numeric(v_entity, v_amount_code, p_as_of, p_depth + 1);
        v_flow_date := golden_master.golden_date(v_entity, v_date_code, p_as_of);
        IF v_amount IS NOT NULL AND v_flow_date IS NOT NULL AND v_flow_date <= p_as_of THEN
            v_dates := v_dates || v_flow_date;
            v_amounts := v_amounts || v_amount;
        END IF;
    END LOOP;

    v_terminal := golden_master.golden_numeric(p_entity_id, v_terminal_code, p_as_of, p_depth + 1);
    IF v_terminal IS NOT NULL THEN
        v_dates := v_dates || p_as_of;
        v_amounts := v_amounts || v_terminal;
    END IF;

    RETURN golden_master.xirr(v_dates, v_amounts);
END;
$$;

-- Text slices use a text field. Numeric slices stay on value.
CREATE OR REPLACE FUNCTION golden_master.write_derived_slices(
    p_entity_id UUID,
    p_attribute_id UUID,
    p_slices JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_source UUID;
    v_rank INTEGER;
    v_open TIMESTAMPTZ := golden_master.open_system_to();
    v_ts TIMESTAMPTZ := clock_timestamp();
    v_start DATE;
    v_end DATE;
    v_before JSONB;
    v_desired JSONB := '[]'::jsonb;
    v_old RECORD;
    v_slice JSONB;
    v_value NUMERIC;
    v_text TEXT;
BEGIN
    SELECT id, precedence_rank INTO v_source, v_rank
    FROM entity_instances.source_registry
    WHERE source_code = 'DERIVED';

    IF v_source IS NULL THEN
        RAISE EXCEPTION 'DERIVED source is not registered';
    END IF;

    SELECT MIN((slice->>'valid_from')::DATE), MAX((slice->>'valid_to')::DATE)
      INTO v_start, v_end
    FROM jsonb_array_elements(COALESCE(p_slices, '[]'::jsonb)) AS slice;

    IF v_start IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT COALESCE(jsonb_agg(
               CASE
                   WHEN eav.golden_value_numeric IS NULL AND eav.golden_value IS NOT NULL THEN
                       jsonb_build_object('valid_from', eav.valid_from, 'valid_to', eav.valid_to, 'text', eav.golden_value)
                   ELSE
                       jsonb_build_object('valid_from', eav.valid_from, 'valid_to', eav.valid_to, 'value', eav.golden_value_numeric)
               END
               ORDER BY eav.valid_from, eav.valid_to
           ), '[]'::jsonb)
      INTO v_before
    FROM golden_master.entity_attribute_values eav
    WHERE eav.entity_id = p_entity_id
      AND eav.attribute_id = p_attribute_id
      AND eav.source_id = v_source
      AND eav.system_to = v_open
      AND eav.valid_to >= v_start
      AND eav.valid_from <= v_end;

    FOR v_old IN
        SELECT valid_from, valid_to, golden_value, golden_value_numeric
        FROM golden_master.entity_attribute_values
        WHERE entity_id = p_entity_id
          AND attribute_id = p_attribute_id
          AND source_id = v_source
          AND system_to = v_open
          AND valid_to >= v_start
          AND valid_from <= v_end
    LOOP
        IF v_old.valid_from < v_start AND (v_start - 1) >= v_old.valid_from THEN
            IF v_old.golden_value_numeric IS NULL AND v_old.golden_value IS NOT NULL THEN
                v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                    'valid_from', v_old.valid_from, 'valid_to', v_start - 1, 'text', v_old.golden_value
                ));
            ELSE
                v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                    'valid_from', v_old.valid_from, 'valid_to', v_start - 1, 'value', v_old.golden_value_numeric
                ));
            END IF;
        END IF;
        IF v_old.valid_to > v_end AND (v_end + 1) <= v_old.valid_to THEN
            IF v_old.golden_value_numeric IS NULL AND v_old.golden_value IS NOT NULL THEN
                v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                    'valid_from', v_end + 1, 'valid_to', v_old.valid_to, 'text', v_old.golden_value
                ));
            ELSE
                v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                    'valid_from', v_end + 1, 'valid_to', v_old.valid_to, 'value', v_old.golden_value_numeric
                ));
            END IF;
        END IF;
    END LOOP;

    FOR v_slice IN SELECT value FROM jsonb_array_elements(p_slices) LOOP
        IF jsonb_typeof(v_slice->'text') = 'string' THEN
            v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                'valid_from', (v_slice->>'valid_from')::DATE,
                'valid_to', (v_slice->>'valid_to')::DATE,
                'text', v_slice->>'text'
            ));
        ELSIF jsonb_typeof(v_slice->'value') = 'number' THEN
            v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                'valid_from', (v_slice->>'valid_from')::DATE,
                'valid_to', (v_slice->>'valid_to')::DATE,
                'value', (v_slice->>'value')::NUMERIC
            ));
        END IF;
    END LOOP;

    SELECT COALESCE(jsonb_agg(item ORDER BY item->>'valid_from', item->>'valid_to'), '[]'::jsonb)
      INTO v_desired
    FROM jsonb_array_elements(v_desired) AS item;

    IF v_before = v_desired THEN
        RETURN FALSE;
    END IF;

    FOR v_old IN
        SELECT *
        FROM golden_master.entity_attribute_values
        WHERE entity_id = p_entity_id
          AND attribute_id = p_attribute_id
          AND source_id = v_source
          AND system_to = v_open
          AND valid_to >= v_start
          AND valid_from <= v_end
    LOOP
        UPDATE golden_master.entity_attribute_values
        SET system_to = v_ts
        WHERE id = v_old.id;

        IF v_old.valid_from < v_start AND (v_start - 1) >= v_old.valid_from THEN
            INSERT INTO golden_master.entity_attribute_values (
                entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
                valid_from, valid_to, system_from, system_to, precedence_rank, is_manual_override
            ) VALUES (
                p_entity_id, p_attribute_id, v_source, v_old.golden_value, v_old.golden_value_numeric,
                v_old.valid_from, v_start - 1, v_ts, v_open, COALESCE(v_old.precedence_rank, v_rank), FALSE
            );
        END IF;

        IF v_old.valid_to > v_end AND (v_end + 1) <= v_old.valid_to THEN
            INSERT INTO golden_master.entity_attribute_values (
                entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
                valid_from, valid_to, system_from, system_to, precedence_rank, is_manual_override
            ) VALUES (
                p_entity_id, p_attribute_id, v_source, v_old.golden_value, v_old.golden_value_numeric,
                v_end + 1, v_old.valid_to, v_ts, v_open, COALESCE(v_old.precedence_rank, v_rank), FALSE
            );
        END IF;
    END LOOP;

    FOR v_slice IN SELECT value FROM jsonb_array_elements(p_slices) LOOP
        IF jsonb_typeof(v_slice->'text') = 'string' THEN
            v_text := v_slice->>'text';
            v_value := NULL;
        ELSIF jsonb_typeof(v_slice->'value') = 'number' THEN
            v_value := (v_slice->>'value')::NUMERIC;
            v_text := v_value::TEXT;
        ELSE
            CONTINUE;
        END IF;
        INSERT INTO golden_master.entity_attribute_values (
            entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
            valid_from, valid_to, system_from, system_to, precedence_rank, is_manual_override
        ) VALUES (
            p_entity_id, p_attribute_id, v_source, v_text, v_value,
            (v_slice->>'valid_from')::DATE, (v_slice->>'valid_to')::DATE,
            v_ts, v_open, v_rank, FALSE
        );
    END LOOP;

    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.process_calc_invalidations(p_limit INTEGER DEFAULT 500)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
    v_processed INTEGER := 0;
    v_failed INTEGER := 0;
    v_pending INTEGER;
    v_job golden_master.calc_invalidations%ROWTYPE;
    v_calc_id UUID;
    v_kind TEXT;
    v_slices JSONB;
    v_row RECORD;
    v_value NUMERIC;
    v_result JSONB;
    v_changed BOOLEAN;
    v_next DATE;
BEGIN
    LOOP
        EXIT WHEN v_processed + v_failed >= v_limit;

        SELECT i.* INTO v_job
        FROM golden_master.calc_invalidations i
        WHERE i.status = 'PENDING'
          AND (i.not_before IS NULL OR i.not_before <= CURRENT_DATE)
        ORDER BY golden_master.calc_depth(i.calc_attribute_id), i.window_start, i.enqueued_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED;

        EXIT WHEN NOT FOUND;

        UPDATE golden_master.calc_invalidations
        SET status = 'RUNNING', started_at = clock_timestamp(), last_error = NULL
        WHERE id = v_job.id;

        BEGIN
            SELECT id, calc_kind INTO v_calc_id, v_kind
            FROM metadata_register.calc_definitions
            WHERE attribute_id = v_job.calc_attribute_id
              AND evaluation_mode = 'MATERIALIZED';

            IF v_calc_id IS NULL THEN
                UPDATE golden_master.calc_invalidations
                SET status = 'DONE', finished_at = clock_timestamp()
                WHERE id = v_job.id;
                v_processed := v_processed + 1;
                CONTINUE;
            END IF;

            v_slices := '[]'::jsonb;
            FOR v_row IN
                SELECT * FROM golden_master.calc_output_dates(
                    v_calc_id, v_job.entity_id, v_job.window_start, v_job.window_end
                )
            LOOP
                IF v_kind = 'EXPRESSION' THEN
                    v_result := golden_master.eval_expression_result(v_calc_id, v_job.entity_id, v_row.as_of, 0);
                    IF jsonb_typeof(v_result) = 'string' THEN
                        v_slices := v_slices || jsonb_build_array(jsonb_build_object(
                            'valid_from', v_row.as_of,
                            'valid_to', v_row.valid_to,
                            'text', v_result #>> '{}'
                        ));
                    ELSIF jsonb_typeof(v_result) = 'number' THEN
                        v_slices := v_slices || jsonb_build_array(jsonb_build_object(
                            'valid_from', v_row.as_of,
                            'valid_to', v_row.valid_to,
                            'value', (v_result #>> '{}')::NUMERIC
                        ));
                    ELSE
                        v_slices := v_slices || jsonb_build_array(jsonb_build_object(
                            'valid_from', v_row.as_of,
                            'valid_to', v_row.valid_to
                        ));
                    END IF;
                ELSE
                    v_value := golden_master.eval_calc(v_calc_id, v_job.entity_id, v_row.as_of, 0);
                    v_slices := v_slices || jsonb_build_array(jsonb_build_object(
                        'valid_from', v_row.as_of,
                        'valid_to', v_row.valid_to,
                        'value', v_value
                    ));
                END IF;
            END LOOP;

            IF jsonb_array_length(v_slices) = 0 THEN
                v_next := golden_master.next_calc_date(v_calc_id, v_job.window_start);
                IF v_next IS NOT NULL AND v_next > CURRENT_DATE AND v_job.window_end >= v_next THEN
                    UPDATE golden_master.calc_invalidations
                    SET status = 'PENDING', not_before = v_next, started_at = NULL
                    WHERE id = v_job.id;
                    CONTINUE;
                END IF;
                UPDATE golden_master.calc_invalidations
                SET status = 'DONE', finished_at = clock_timestamp()
                WHERE id = v_job.id;
                v_processed := v_processed + 1;
                CONTINUE;
            END IF;

            PERFORM set_config('golden_master.suppress_calc_enqueue', '1', true);
            v_changed := golden_master.write_derived_slices(v_job.entity_id, v_job.calc_attribute_id, v_slices);
            PERFORM set_config('golden_master.suppress_calc_enqueue', '0', true);

            IF v_changed THEN
                PERFORM golden_master.enqueue_for_attribute_change(
                    v_job.entity_id, v_job.calc_attribute_id, v_job.window_start, v_job.window_end
                );
            END IF;

            UPDATE golden_master.calc_invalidations
            SET status = 'DONE', finished_at = clock_timestamp()
            WHERE id = v_job.id;
            v_processed := v_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                PERFORM set_config('golden_master.suppress_calc_enqueue', '0', true);
                UPDATE golden_master.calc_invalidations
                SET status = 'FAILED', last_error = SQLERRM, finished_at = clock_timestamp()
                WHERE id = v_job.id;
                v_failed := v_failed + 1;
        END;
    END LOOP;

    SELECT COUNT(*) INTO v_pending
    FROM golden_master.calc_invalidations
    WHERE status IN ('PENDING', 'RUNNING');

    RETURN jsonb_build_object(
        'processed', v_processed,
        'failed', v_failed,
        'pending', v_pending
    );
END;
$$;

REVOKE ALL ON FUNCTION metadata_register.expr_number(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION metadata_register.expr_apply_op(TEXT, NUMERIC, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION metadata_register.eval_expr(JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.golden_literal(UUID, VARCHAR, DATE, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.eval_expression_result(UUID, UUID, DATE, INTEGER) FROM PUBLIC;
