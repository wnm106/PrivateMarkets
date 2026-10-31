-- Calculated attributes: typed definitions, invalidation queue, and DERIVED writes.
--
-- A calc is a node in a dependency graph. ON_READ expressions stay virtual.
-- MATERIALIZED calcs are stored as golden rows on the DERIVED source.
-- Invalidation walks each input in reverse: a DOWN read dirties parents,
-- an UP read dirties children. The write path only enqueues.

-- ---------------------------------------------------------------------------
-- Definitions
-- ---------------------------------------------------------------------------

CREATE TABLE metadata_register.calc_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attribute_id UUID NOT NULL UNIQUE REFERENCES metadata_register.attribute_register(id) ON DELETE CASCADE,
    domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),
    calc_kind VARCHAR(20) NOT NULL CHECK (calc_kind IN ('EXPRESSION', 'AGGREGATE', 'SERIES')),
    evaluation_mode VARCHAR(20) NOT NULL CHECK (evaluation_mode IN ('ON_READ', 'MATERIALIZED')),
    time_impact VARCHAR(20) NOT NULL CHECK (time_impact IN ('SLICE', 'FORWARD')),
    output_grain VARCHAR(20) NOT NULL CHECK (output_grain IN ('ON_INPUT_CHANGE', 'MONTH_END', 'QUARTER_END', 'YEAR_END')),
    expression JSONB,
    aggregate_fn VARCHAR(20) CHECK (aggregate_fn IS NULL OR aggregate_fn IN ('SUM', 'WAVG', 'MIN', 'MAX')),
    series_fn VARCHAR(20) CHECK (series_fn IS NULL OR series_fn IN ('XIRR')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_calc_definitions_domain ON metadata_register.calc_definitions(domain_code);
CREATE INDEX idx_calc_definitions_materialized ON metadata_register.calc_definitions(attribute_id)
    WHERE evaluation_mode = 'MATERIALIZED';

COMMENT ON TABLE metadata_register.calc_definitions IS
    'Typed calculated attributes. derivation_dependencies on attribute_register is generated from the inputs.';

CREATE TABLE metadata_register.calc_inputs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    calc_definition_id UUID NOT NULL REFERENCES metadata_register.calc_definitions(id) ON DELETE CASCADE,
    input_role VARCHAR(20) NOT NULL CHECK (input_role IN ('OPERAND', 'MEASURE', 'WEIGHT', 'AMOUNT', 'FLOW_DATE', 'TERMINAL')),
    attribute_code VARCHAR(100) NOT NULL REFERENCES metadata_register.attribute_register(attribute_code) ON UPDATE CASCADE,
    traversal VARCHAR(10) NOT NULL CHECK (traversal IN ('SELF', 'UP', 'DOWN')),
    relationship_codes TEXT[] NOT NULL DEFAULT '{}',
    ordinal INTEGER NOT NULL DEFAULT 0,
    UNIQUE (calc_definition_id, input_role, attribute_code)
);

CREATE INDEX idx_calc_inputs_attribute ON metadata_register.calc_inputs(attribute_code);
CREATE INDEX idx_calc_inputs_definition ON metadata_register.calc_inputs(calc_definition_id);

COMMENT ON COLUMN metadata_register.calc_inputs.relationship_codes IS
    'Ordered path from the calc entity toward the input entity. DOWN walks parent to child. UP walks child to parent.';

-- ---------------------------------------------------------------------------
-- Invalidation queue
-- ---------------------------------------------------------------------------

CREATE TABLE golden_master.calc_invalidations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    calc_attribute_id UUID NOT NULL REFERENCES metadata_register.attribute_register(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    window_start DATE NOT NULL,
    window_end DATE NOT NULL DEFAULT DATE '9999-12-31',
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
    not_before DATE,
    cause_entity_id UUID,
    cause_attribute_code VARCHAR(100),
    cause_valid_from DATE,
    last_error TEXT,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

CREATE INDEX idx_calc_invalidations_pending
    ON golden_master.calc_invalidations (calc_attribute_id, entity_id)
    WHERE status = 'PENDING';

CREATE INDEX idx_calc_invalidations_entity_status
    ON golden_master.calc_invalidations (entity_id, status);

COMMENT ON TABLE golden_master.calc_invalidations IS
    'Coalesced dirty windows. One pending row per calc attribute and entity; overlapping windows expand to the union.';

-- ---------------------------------------------------------------------------
-- Pure helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION metadata_register.eval_numeric_expr(p_expr JSONB, p_vars JSONB)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_op TEXT;
    v_args JSONB;
    v_left NUMERIC;
    v_right NUMERIC;
    v_ref TEXT;
BEGIN
    IF p_expr IS NULL OR p_expr = 'null'::jsonb THEN
        RETURN NULL;
    END IF;

    IF p_expr ? 'const' THEN
        RETURN (p_expr->>'const')::NUMERIC;
    END IF;

    IF p_expr ? 'ref' THEN
        v_ref := p_expr->>'ref';
        IF p_vars IS NULL OR NOT (p_vars ? v_ref) OR p_vars->>v_ref IS NULL THEN
            RETURN NULL;
        END IF;
        RETURN (p_vars->>v_ref)::NUMERIC;
    END IF;

    v_op := p_expr->>'op';
    v_args := COALESCE(p_expr->'args', '[]'::jsonb);

    IF v_op = 'neg' THEN
        v_left := metadata_register.eval_numeric_expr(v_args->0, p_vars);
        IF v_left IS NULL THEN
            RETURN NULL;
        END IF;
        RETURN -v_left;
    END IF;

    v_left := metadata_register.eval_numeric_expr(v_args->0, p_vars);
    v_right := metadata_register.eval_numeric_expr(v_args->1, p_vars);
    IF v_left IS NULL OR v_right IS NULL THEN
        RETURN NULL;
    END IF;

    IF v_op = 'add' THEN
        RETURN v_left + v_right;
    ELSIF v_op = 'sub' THEN
        RETURN v_left - v_right;
    ELSIF v_op = 'mul' THEN
        RETURN v_left * v_right;
    ELSIF v_op = 'div' THEN
        IF v_right = 0 THEN
            RETURN NULL;
        END IF;
        RETURN v_left / v_right;
    END IF;

    RAISE EXCEPTION 'Unsupported calc expression op: %', v_op;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.xirr_npv(p_dates DATE[], p_amounts NUMERIC[], p_rate NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_origin DATE;
    v_npv NUMERIC := 0;
    v_i INTEGER;
    v_t NUMERIC;
BEGIN
    IF p_rate IS NULL OR p_rate <= -1 THEN
        RETURN NULL;
    END IF;
    SELECT MIN(d) INTO v_origin FROM unnest(p_dates) AS d;
    IF v_origin IS NULL THEN
        RETURN NULL;
    END IF;
    FOR v_i IN 1..cardinality(p_dates) LOOP
        v_t := (p_dates[v_i] - v_origin)::NUMERIC / 365.0;
        v_npv := v_npv + p_amounts[v_i] / exp(v_t * ln(1 + p_rate));
    END LOOP;
    RETURN v_npv;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.xirr(p_dates DATE[], p_amounts NUMERIC[])
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_n INTEGER;
    v_rate NUMERIC := 0.1;
    v_next NUMERIC;
    v_npv NUMERIC;
    v_deriv NUMERIC;
    v_origin DATE;
    v_t NUMERIC;
    v_disc NUMERIC;
    v_i INTEGER;
    v_j INTEGER;
    v_lo NUMERIC := -0.9;
    v_hi NUMERIC := 10;
    v_mid NUMERIC;
    v_npv_lo NUMERIC;
    v_npv_mid NUMERIC;
BEGIN
    v_n := COALESCE(cardinality(p_dates), 0);
    IF v_n < 2 OR v_n IS DISTINCT FROM COALESCE(cardinality(p_amounts), 0) THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(p_amounts) AS amount WHERE amount > 0)
       OR NOT EXISTS (SELECT 1 FROM unnest(p_amounts) AS amount WHERE amount < 0) THEN
        RETURN NULL;
    END IF;

    SELECT MIN(d) INTO v_origin FROM unnest(p_dates) AS d;

    FOR v_i IN 1..40 LOOP
        v_npv := 0;
        v_deriv := 0;
        IF v_rate <= -0.999999 THEN
            EXIT;
        END IF;
        FOR v_j IN 1..v_n LOOP
            v_t := (p_dates[v_j] - v_origin)::NUMERIC / 365.0;
            v_disc := exp(v_t * ln(1 + v_rate));
            v_npv := v_npv + p_amounts[v_j] / v_disc;
            v_deriv := v_deriv - (v_t * p_amounts[v_j]) / (v_disc * (1 + v_rate));
        END LOOP;
        EXIT WHEN v_deriv = 0;
        v_next := v_rate - (v_npv / v_deriv);
        IF abs(v_npv) < 0.0000001 AND abs(v_next - v_rate) < 0.0000001 THEN
            RETURN round(v_next, 10);
        END IF;
        IF v_next <= -0.999999 OR v_next > 100 THEN
            EXIT;
        END IF;
        v_rate := v_next;
    END LOOP;

    v_npv_lo := golden_master.xirr_npv(p_dates, p_amounts, v_lo);
    IF v_npv_lo IS NULL OR golden_master.xirr_npv(p_dates, p_amounts, v_hi) IS NULL THEN
        RETURN NULL;
    END IF;
    IF v_npv_lo * golden_master.xirr_npv(p_dates, p_amounts, v_hi) > 0 THEN
        RETURN NULL;
    END IF;

    FOR v_i IN 1..80 LOOP
        v_mid := (v_lo + v_hi) / 2;
        v_npv_mid := golden_master.xirr_npv(p_dates, p_amounts, v_mid);
        IF v_npv_mid IS NULL THEN
            RETURN NULL;
        END IF;
        IF abs(v_npv_mid) < 0.0000001 OR (v_hi - v_lo) < 0.0000001 THEN
            RETURN round(v_mid, 10);
        END IF;
        IF v_npv_lo * v_npv_mid < 0 THEN
            v_hi := v_mid;
        ELSE
            v_lo := v_mid;
            v_npv_lo := v_npv_mid;
        END IF;
    END LOOP;

    RETURN round(v_mid, 10);
END;
$$;

-- ---------------------------------------------------------------------------
-- Dependency cache and cycle rejection
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION metadata_register.expr_refs(p_expr JSONB)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_refs TEXT[] := '{}';
    v_child JSONB;
BEGIN
    IF p_expr IS NULL THEN
        RETURN v_refs;
    END IF;
    IF p_expr ? 'ref' THEN
        RETURN ARRAY[p_expr->>'ref'];
    END IF;
    IF p_expr ? 'args' THEN
        FOR v_child IN SELECT value FROM jsonb_array_elements(p_expr->'args') LOOP
            v_refs := v_refs || metadata_register.expr_refs(v_child);
        END LOOP;
    END IF;
    RETURN v_refs;
END;
$$;

CREATE OR REPLACE FUNCTION metadata_register.assert_calc_acyclic()
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_cycle TEXT;
BEGIN
    WITH RECURSIVE walk AS (
        SELECT ar.attribute_code AS origin,
               ci.attribute_code AS node,
               ARRAY[ar.attribute_code]::TEXT[] AS path
        FROM metadata_register.calc_definitions cd
        JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
        JOIN metadata_register.calc_inputs ci ON ci.calc_definition_id = cd.id
        UNION ALL
        SELECT w.origin,
               ci.attribute_code,
               w.path || w.node
        FROM walk w
        JOIN metadata_register.attribute_register dep ON dep.attribute_code = w.node
        JOIN metadata_register.calc_definitions cd ON cd.attribute_id = dep.id
        JOIN metadata_register.calc_inputs ci ON ci.calc_definition_id = cd.id
        WHERE NOT (w.node = ANY (w.path))
          AND cardinality(w.path) < 20
    )
    SELECT origin || ' -> ' || node INTO v_cycle
    FROM walk
    WHERE node = origin
    LIMIT 1;

    IF v_cycle IS NOT NULL THEN
        RAISE EXCEPTION 'Calculated attribute cycle: %', v_cycle;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION metadata_register.sync_calc_definition(p_definition_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_def metadata_register.calc_definitions%ROWTYPE;
    v_deps JSONB;
    v_formula TEXT;
    v_type TEXT;
BEGIN
    SELECT * INTO v_def
    FROM metadata_register.calc_definitions
    WHERE id = p_definition_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    PERFORM metadata_register.assert_calc_acyclic();

    SELECT COALESCE(jsonb_agg(DISTINCT ci.attribute_code ORDER BY ci.attribute_code), '[]'::jsonb)
      INTO v_deps
    FROM metadata_register.calc_inputs ci
    WHERE ci.calc_definition_id = p_definition_id;

    v_formula := CASE
        WHEN v_def.expression IS NOT NULL THEN v_def.expression::TEXT
        WHEN v_def.aggregate_fn IS NOT NULL THEN 'CALC_SPEC:' || v_def.aggregate_fn
        WHEN v_def.series_fn IS NOT NULL THEN 'CALC_SPEC:' || v_def.series_fn
        ELSE 'CALC_SPEC'
    END;

    v_type := CASE v_def.calc_kind
        WHEN 'EXPRESSION' THEN 'SIMPLE'
        WHEN 'AGGREGATE' THEN 'AGGREGATE'
        ELSE 'CUSTOM'
    END;

    UPDATE metadata_register.attribute_register
    SET is_derived = TRUE,
        derivation_type = v_type,
        derivation_formula = v_formula,
        derivation_dependencies = v_deps,
        formula_language = 'CALC_SPEC',
        updated_at = NOW()
    WHERE id = v_def.attribute_id;
END;
$$;

CREATE OR REPLACE FUNCTION metadata_register.sync_calc_definition_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'calc_definitions' THEN
        IF TG_OP = 'DELETE' THEN
            UPDATE metadata_register.attribute_register
            SET is_derived = FALSE,
                derivation_type = NULL,
                derivation_formula = NULL,
                derivation_dependencies = '[]'::jsonb,
                formula_language = 'SQL',
                updated_at = NOW()
            WHERE id = OLD.attribute_id
              AND NOT EXISTS (
                  SELECT 1 FROM metadata_register.calc_definitions cd WHERE cd.attribute_id = OLD.attribute_id
              );
            RETURN OLD;
        END IF;
        v_id := NEW.id;
    ELSE
        v_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.calc_definition_id ELSE NEW.calc_definition_id END;
    END IF;

    IF v_id IS NOT NULL AND EXISTS (SELECT 1 FROM metadata_register.calc_definitions WHERE id = v_id) THEN
        PERFORM metadata_register.sync_calc_definition(v_id);
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_sync_calc_definition
    AFTER INSERT OR UPDATE OR DELETE ON metadata_register.calc_definitions
    FOR EACH ROW
    EXECUTE FUNCTION metadata_register.sync_calc_definition_trigger();

CREATE TRIGGER trg_sync_calc_inputs
    AFTER INSERT OR UPDATE OR DELETE ON metadata_register.calc_inputs
    FOR EACH ROW
    EXECUTE FUNCTION metadata_register.sync_calc_definition_trigger();

CREATE OR REPLACE FUNCTION metadata_register.assert_calc_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
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

    IF v_def.evaluation_mode = 'ON_READ' AND EXISTS (
        SELECT 1 FROM metadata_register.calc_inputs ci
        WHERE ci.calc_definition_id = v_def.id AND ci.traversal <> 'SELF'
    ) THEN
        RAISE EXCEPTION 'On-read calcs can only read SELF inputs';
    END IF;

    IF v_def.calc_kind = 'EXPRESSION' THEN
        IF v_def.expression IS NULL THEN
            RAISE EXCEPTION 'Expression calcs require an expression';
        END IF;
        v_refs := metadata_register.expr_refs(v_def.expression);
        SELECT ref INTO v_missing
        FROM unnest(v_refs) AS ref
        WHERE NOT EXISTS (
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

CREATE CONSTRAINT TRIGGER trg_calc_definition_complete
    AFTER INSERT OR UPDATE ON metadata_register.calc_definitions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION metadata_register.assert_calc_complete();

-- Touching the definition re-queues the deferred completeness check after inputs change.
CREATE OR REPLACE FUNCTION metadata_register.assert_calc_inputs_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_definition_id UUID;
BEGIN
    v_definition_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.calc_definition_id ELSE NEW.calc_definition_id END;
    UPDATE metadata_register.calc_definitions
    SET updated_at = NOW()
    WHERE id = v_definition_id;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE CONSTRAINT TRIGGER trg_calc_inputs_complete
    AFTER INSERT OR UPDATE OR DELETE ON metadata_register.calc_inputs
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION metadata_register.assert_calc_inputs_complete();

-- Multi-node cycles, not only a self-reference.
CREATE OR REPLACE FUNCTION metadata_register.validate_derived_attribute_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_cycle TEXT;
BEGIN
    IF NEW.is_derived IS DISTINCT FROM TRUE THEN
        RETURN NEW;
    END IF;

    IF NEW.derivation_type IS NULL THEN
        RAISE EXCEPTION 'derivation_type is required for derived attributes';
    END IF;

    IF NEW.derivation_type NOT IN ('SIMPLE', 'AGGREGATE', 'LOOKUP', 'CUSTOM') THEN
        RAISE EXCEPTION 'derivation_type must be one of: SIMPLE, AGGREGATE, LOOKUP, CUSTOM';
    END IF;

    IF NEW.derivation_formula IS NULL OR trim(NEW.derivation_formula) = '' THEN
        RAISE EXCEPTION 'derivation_formula is required for derived attributes';
    END IF;

    IF NEW.derivation_dependencies IS NOT NULL
       AND jsonb_typeof(NEW.derivation_dependencies) = 'array'
       AND jsonb_array_length(NEW.derivation_dependencies) > 0 THEN
        IF NOT metadata_register.validate_derivation_dependencies(
            NEW.attribute_code, NEW.derivation_dependencies
        ) THEN
            RAISE EXCEPTION 'Invalid derivation dependencies for attribute: %', NEW.attribute_code;
        END IF;
    END IF;

    WITH RECURSIVE walk AS (
        SELECT dep AS node, ARRAY[NEW.attribute_code]::TEXT[] AS path
        FROM jsonb_array_elements_text(COALESCE(NEW.derivation_dependencies, '[]'::jsonb)) AS dep
        UNION ALL
        SELECT nxt, w.path || w.node
        FROM walk w
        JOIN metadata_register.attribute_register ar ON ar.attribute_code = w.node
        CROSS JOIN LATERAL jsonb_array_elements_text(
            COALESCE(
                CASE
                    WHEN ar.attribute_code = NEW.attribute_code THEN NEW.derivation_dependencies
                    ELSE ar.derivation_dependencies
                END,
                '[]'::jsonb
            )
        ) AS nxt
        WHERE NOT (w.node = ANY (w.path))
          AND cardinality(w.path) < 20
    )
    SELECT node INTO v_cycle
    FROM walk
    WHERE node = NEW.attribute_code
    LIMIT 1;

    IF v_cycle IS NOT NULL THEN
        RAISE EXCEPTION 'Calculated attribute cycle involving %', NEW.attribute_code;
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION golden_master.open_system_to()
RETURNS TIMESTAMPTZ
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT TIMESTAMPTZ '9999-12-31 23:59:59+00';
$$;

CREATE OR REPLACE FUNCTION golden_master.related_ids(
    p_root UUID,
    p_traversal TEXT,
    p_codes TEXT[],
    p_as_of DATE
) RETURNS UUID[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_current UUID[] := ARRAY[p_root];
    v_next UUID[];
    v_code TEXT;
    v_open TIMESTAMPTZ := golden_master.open_system_to();
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
              AND er.system_to = v_open;
        ELSE
            SELECT COALESCE(array_agg(DISTINCT er.parent_entity_id), '{}')
              INTO v_next
            FROM entity_instances.entity_relationships er
            WHERE er.child_entity_id = ANY (v_current)
              AND er.relationship_code = v_code
              AND er.valid_from <= p_as_of
              AND er.valid_to >= p_as_of
              AND er.system_to = v_open;
        END IF;
        v_current := v_next;
        EXIT WHEN cardinality(v_current) = 0;
    END LOOP;

    RETURN v_current;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.related_one(
    p_root UUID,
    p_traversal TEXT,
    p_codes TEXT[],
    p_as_of DATE
) RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_ids UUID[];
    v_open TIMESTAMPTZ := golden_master.open_system_to();
    v_code TEXT;
    v_picked UUID;
BEGIN
    v_ids := golden_master.related_ids(p_root, p_traversal, p_codes, p_as_of);
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
        WHERE er.child_entity_id = ANY (golden_master.related_ids(p_root, p_traversal, p_codes[1:cardinality(p_codes) - 1], p_as_of))
          AND er.parent_entity_id = ANY (v_ids)
          AND er.relationship_code = v_code
          AND er.valid_from <= p_as_of
          AND er.valid_to >= p_as_of
          AND er.system_to = v_open
        ORDER BY er.is_primary DESC, er.valid_from DESC
        LIMIT 1;
    ELSE
        SELECT er.child_entity_id INTO v_picked
        FROM entity_instances.entity_relationships er
        WHERE er.parent_entity_id = ANY (golden_master.related_ids(p_root, p_traversal, p_codes[1:cardinality(p_codes) - 1], p_as_of))
          AND er.child_entity_id = ANY (v_ids)
          AND er.relationship_code = v_code
          AND er.valid_from <= p_as_of
          AND er.valid_to >= p_as_of
          AND er.system_to = v_open
        ORDER BY er.is_primary DESC, er.valid_from DESC
        LIMIT 1;
    END IF;
    RETURN COALESCE(v_picked, v_ids[1]);
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.golden_numeric(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of DATE,
    p_depth INTEGER DEFAULT 0
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_calc_id UUID;
    v_mode TEXT;
    v_value NUMERIC;
    v_open TIMESTAMPTZ := golden_master.open_system_to();
BEGIN
    IF p_depth > 8 THEN
        RETURN NULL;
    END IF;

    SELECT cd.id, cd.evaluation_mode
      INTO v_calc_id, v_mode
    FROM metadata_register.calc_definitions cd
    JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
    WHERE ar.attribute_code = p_attribute_code;

    IF v_mode = 'ON_READ' THEN
        RETURN golden_master.eval_calc(v_calc_id, p_entity_id, p_as_of, p_depth + 1);
    END IF;

    SELECT COALESCE(
        eav.golden_value_numeric,
        CASE
            WHEN eav.golden_value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN eav.golden_value::NUMERIC
            ELSE NULL
        END
    )
      INTO v_value
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    WHERE eav.entity_id = p_entity_id
      AND ar.attribute_code = p_attribute_code
      AND eav.source_id = eav.golden_source_id
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND eav.system_to = v_open
    LIMIT 1;

    RETURN v_value;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.golden_date(
    p_entity_id UUID,
    p_attribute_code VARCHAR,
    p_as_of DATE
) RETURNS DATE
LANGUAGE plpgsql
STABLE
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
      AND eav.source_id = eav.golden_source_id
      AND eav.valid_from <= p_as_of
      AND eav.valid_to >= p_as_of
      AND eav.system_to = v_open
    LIMIT 1;

    RETURN v_date;
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
AS $$
DECLARE
    v_def metadata_register.calc_definitions%ROWTYPE;
    v_input metadata_register.calc_inputs%ROWTYPE;
    v_vars JSONB := '{}'::jsonb;
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
        FOR v_input IN
            SELECT * FROM metadata_register.calc_inputs
            WHERE calc_definition_id = p_calc_id AND input_role = 'OPERAND'
        LOOP
            IF v_input.traversal = 'SELF' THEN
                v_entity := p_entity_id;
            ELSE
                v_entity := golden_master.related_one(p_entity_id, v_input.traversal, v_input.relationship_codes, p_as_of);
            END IF;
            v_value := CASE
                WHEN v_entity IS NULL THEN NULL
                ELSE golden_master.golden_numeric(v_entity, v_input.attribute_code, p_as_of, p_depth + 1)
            END;
            v_vars := v_vars || jsonb_build_object(v_input.attribute_code, v_value);
        END LOOP;
        RETURN metadata_register.eval_numeric_expr(v_def.expression, v_vars);
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

-- ---------------------------------------------------------------------------
-- Output dates
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION golden_master.calc_output_dates(
    p_calc_id UUID,
    p_entity_id UUID,
    p_window_start DATE,
    p_window_end DATE
) RETURNS TABLE(as_of DATE, valid_to DATE)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_def metadata_register.calc_definitions%ROWTYPE;
    v_grain TEXT;
    v_grain_trunc TEXT;
    v_cap DATE;
    v_step INTERVAL;
    v_anchor TIMESTAMP;
BEGIN
    SELECT * INTO v_def FROM metadata_register.calc_definitions WHERE id = p_calc_id;
    v_grain := v_def.output_grain;
    v_cap := LEAST(p_window_end, CURRENT_DATE);
    IF p_window_start > v_cap THEN
        RETURN;
    END IF;

    IF v_grain = 'ON_INPUT_CHANGE' THEN
        RETURN QUERY
        WITH boundaries AS (
            SELECT p_window_start AS boundary
            UNION
            SELECT eav.valid_from
            FROM metadata_register.calc_inputs ci
            JOIN metadata_register.attribute_register ar ON ar.attribute_code = ci.attribute_code
            JOIN golden_master.entity_attribute_values eav
              ON eav.attribute_id = ar.id
             AND eav.source_id = eav.golden_source_id
             AND eav.system_to = golden_master.open_system_to()
            WHERE ci.calc_definition_id = p_calc_id
              AND ci.traversal = 'SELF'
              AND eav.entity_id = p_entity_id
              AND eav.valid_from > p_window_start
              AND eav.valid_from <= v_cap
            UNION
            SELECT eav.valid_from
            FROM metadata_register.calc_inputs ci
            JOIN metadata_register.attribute_register ar ON ar.attribute_code = ci.attribute_code
            JOIN LATERAL unnest(golden_master.related_ids(p_entity_id, ci.traversal, ci.relationship_codes, v_cap)) AS related(entity_id) ON TRUE
            JOIN golden_master.entity_attribute_values eav
              ON eav.entity_id = related.entity_id
             AND eav.attribute_id = ar.id
             AND eav.source_id = eav.golden_source_id
             AND eav.system_to = golden_master.open_system_to()
            WHERE ci.calc_definition_id = p_calc_id
              AND ci.traversal <> 'SELF'
              AND eav.valid_from > p_window_start
              AND eav.valid_from <= v_cap
        ),
        ordered AS (
            SELECT DISTINCT boundary
            FROM boundaries
            WHERE boundary >= p_window_start AND boundary <= v_cap
            ORDER BY boundary
        )
        SELECT boundary,
               COALESCE(
                   (LEAD(boundary) OVER (ORDER BY boundary) - 1),
                   CASE WHEN p_window_end >= DATE '9999-12-31' THEN DATE '9999-12-31' ELSE p_window_end END
               )
        FROM ordered;
        RETURN;
    END IF;

    v_step := CASE v_grain
        WHEN 'MONTH_END' THEN INTERVAL '1 month'
        WHEN 'YEAR_END' THEN INTERVAL '1 year'
        ELSE INTERVAL '3 months'
    END;
    v_grain_trunc := CASE v_grain
        WHEN 'MONTH_END' THEN 'month'
        WHEN 'YEAR_END' THEN 'year'
        ELSE 'quarter'
    END;
    v_anchor := date_trunc(v_grain_trunc, p_window_start::TIMESTAMP);

    RETURN QUERY
    WITH ends AS (
        SELECT (date_trunc(v_grain_trunc, gs) + v_step - INTERVAL '1 day')::DATE AS boundary
        FROM generate_series(
            v_anchor,
            date_trunc(v_grain_trunc, v_cap::TIMESTAMP),
            v_step
        ) AS gs
    )
    SELECT boundary,
           COALESCE(
               (LEAD(boundary) OVER (ORDER BY boundary) - 1),
               CASE WHEN p_window_end >= DATE '9999-12-31' THEN DATE '9999-12-31' ELSE p_window_end END
           )
    FROM ends
    WHERE boundary >= p_window_start
      AND boundary <= v_cap;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.next_calc_date(
    p_calc_id UUID,
    p_window_start DATE
) RETURNS DATE
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_grain TEXT;
    v_anchor TIMESTAMP;
    v_step INTERVAL;
    v_first DATE;
BEGIN
    SELECT output_grain INTO v_grain FROM metadata_register.calc_definitions WHERE id = p_calc_id;
    IF v_grain = 'ON_INPUT_CHANGE' THEN
        RETURN p_window_start;
    END IF;
    v_step := CASE v_grain
        WHEN 'MONTH_END' THEN INTERVAL '1 month'
        WHEN 'YEAR_END' THEN INTERVAL '1 year'
        ELSE INTERVAL '3 months'
    END;
    v_anchor := CASE v_grain
        WHEN 'MONTH_END' THEN date_trunc('month', p_window_start::TIMESTAMP)
        WHEN 'YEAR_END' THEN date_trunc('year', p_window_start::TIMESTAMP)
        ELSE date_trunc('quarter', p_window_start::TIMESTAMP)
    END;
    v_first := (v_anchor + v_step - INTERVAL '1 day')::DATE;
    IF v_first < p_window_start THEN
        v_first := (v_anchor + v_step + v_step - INTERVAL '1 day')::DATE;
    END IF;
    RETURN v_first;
END;
$$;

-- ---------------------------------------------------------------------------
-- DERIVED writes. Manual and vendor rows are left in place.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION golden_master.write_derived_slices(
    p_entity_id UUID,
    p_attribute_id UUID,
    p_slices JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
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

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'valid_from', eav.valid_from,
               'valid_to', eav.valid_to,
               'value', eav.golden_value_numeric
           ) ORDER BY eav.valid_from, eav.valid_to), '[]'::jsonb)
      INTO v_before
    FROM golden_master.entity_attribute_values eav
    WHERE eav.entity_id = p_entity_id
      AND eav.attribute_id = p_attribute_id
      AND eav.source_id = v_source
      AND eav.system_to = v_open
      AND eav.valid_to >= v_start
      AND eav.valid_from <= v_end;

    FOR v_old IN
        SELECT valid_from, valid_to, golden_value_numeric
        FROM golden_master.entity_attribute_values
        WHERE entity_id = p_entity_id
          AND attribute_id = p_attribute_id
          AND source_id = v_source
          AND system_to = v_open
          AND valid_to >= v_start
          AND valid_from <= v_end
    LOOP
        IF v_old.valid_from < v_start AND (v_start - 1) >= v_old.valid_from THEN
            v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                'valid_from', v_old.valid_from,
                'valid_to', v_start - 1,
                'value', v_old.golden_value_numeric
            ));
        END IF;
        IF v_old.valid_to > v_end AND (v_end + 1) <= v_old.valid_to THEN
            v_desired := v_desired || jsonb_build_array(jsonb_build_object(
                'valid_from', v_end + 1,
                'valid_to', v_old.valid_to,
                'value', v_old.golden_value_numeric
            ));
        END IF;
    END LOOP;

    FOR v_slice IN SELECT value FROM jsonb_array_elements(p_slices) LOOP
        IF v_slice->>'value' IS NOT NULL AND v_slice->>'value' <> 'null' THEN
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
        IF v_slice->>'value' IS NULL OR v_slice->>'value' = 'null' THEN
            CONTINUE;
        END IF;
        v_value := (v_slice->>'value')::NUMERIC;
        v_text := v_value::TEXT;
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

-- ---------------------------------------------------------------------------
-- Enqueue
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION golden_master.enqueue_calc(
    p_calc_attribute_id UUID,
    p_entity_id UUID,
    p_window_start DATE,
    p_window_end DATE,
    p_cause_entity_id UUID,
    p_cause_attribute_code VARCHAR,
    p_cause_valid_from DATE
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_id UUID;
    v_start DATE;
    v_end DATE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(p_calc_attribute_id::TEXT), hashtext(p_entity_id::TEXT));

    SELECT id, window_start, window_end
      INTO v_id, v_start, v_end
    FROM golden_master.calc_invalidations
    WHERE calc_attribute_id = p_calc_attribute_id
      AND entity_id = p_entity_id
      AND status = 'PENDING'
    ORDER BY window_start
    LIMIT 1
    FOR UPDATE;

    IF v_id IS NULL THEN
        INSERT INTO golden_master.calc_invalidations (
            calc_attribute_id, entity_id, window_start, window_end,
            cause_entity_id, cause_attribute_code, cause_valid_from
        ) VALUES (
            p_calc_attribute_id, p_entity_id, p_window_start, p_window_end,
            p_cause_entity_id, p_cause_attribute_code, p_cause_valid_from
        );
        RETURN;
    END IF;

    UPDATE golden_master.calc_invalidations
    SET window_start = LEAST(v_start, p_window_start),
        window_end = GREATEST(v_end, p_window_end),
        not_before = NULL,
        cause_entity_id = p_cause_entity_id,
        cause_attribute_code = p_cause_attribute_code,
        cause_valid_from = p_cause_valid_from
    WHERE id = v_id;

    DELETE FROM golden_master.calc_invalidations
    WHERE calc_attribute_id = p_calc_attribute_id
      AND entity_id = p_entity_id
      AND status = 'PENDING'
      AND id <> v_id;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.calc_target_entities(
    p_input_entity UUID,
    p_traversal TEXT,
    p_codes TEXT[],
    p_window_start DATE,
    p_window_end DATE
) RETURNS SETOF UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_current UUID[] := ARRAY[p_input_entity];
    v_next UUID[];
    v_rev TEXT[];
    v_code TEXT;
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
        IF p_traversal = 'DOWN' THEN
            SELECT COALESCE(array_agg(DISTINCT er.parent_entity_id), '{}')
              INTO v_next
            FROM entity_instances.entity_relationships er
            WHERE er.child_entity_id = ANY (v_current)
              AND er.relationship_code = v_code
              AND er.system_to = v_open
              AND er.valid_to >= p_window_start
              AND er.valid_from <= p_window_end;
        ELSE
            SELECT COALESCE(array_agg(DISTINCT er.child_entity_id), '{}')
              INTO v_next
            FROM entity_instances.entity_relationships er
            WHERE er.parent_entity_id = ANY (v_current)
              AND er.relationship_code = v_code
              AND er.system_to = v_open
              AND er.valid_to >= p_window_start
              AND er.valid_from <= p_window_end;
        END IF;
        v_current := v_next;
        EXIT WHEN cardinality(v_current) IS NULL OR cardinality(v_current) = 0;
    END LOOP;

    RETURN QUERY SELECT DISTINCT unnest(v_current);
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.enqueue_for_attribute_change(
    p_entity_id UUID,
    p_attribute_id UUID,
    p_window_start DATE,
    p_window_end DATE
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_code VARCHAR(100);
    v_input RECORD;
    v_target UUID;
    v_domain VARCHAR(50);
    v_end DATE;
    v_prefix TEXT[];
BEGIN
    SELECT attribute_code INTO v_code
    FROM metadata_register.attribute_register
    WHERE id = p_attribute_id;

    IF v_code IS NULL THEN
        RETURN;
    END IF;

    FOR v_input IN
        SELECT ci.traversal,
               ci.relationship_codes,
               cd.attribute_id AS calc_attribute_id,
               cd.domain_code,
               cd.time_impact
        FROM metadata_register.calc_inputs ci
        JOIN metadata_register.calc_definitions cd ON cd.id = ci.calc_definition_id
        WHERE ci.attribute_code = v_code
          AND cd.evaluation_mode = 'MATERIALIZED'
    LOOP
        v_end := CASE WHEN v_input.time_impact = 'FORWARD' THEN DATE '9999-12-31' ELSE p_window_end END;
        IF v_input.traversal = 'SELF' THEN
            v_prefix := '{}';
        ELSE
            v_prefix := v_input.relationship_codes;
        END IF;

        FOR v_target IN
            SELECT golden_master.calc_target_entities(
                p_entity_id, v_input.traversal, v_prefix, p_window_start, v_end
            )
        LOOP
            SELECT domain_code INTO v_domain
            FROM entity_instances.master_entities
            WHERE id = v_target;

            IF v_domain IS NOT DISTINCT FROM v_input.domain_code THEN
                PERFORM golden_master.enqueue_calc(
                    v_input.calc_attribute_id, v_target, p_window_start, v_end,
                    p_entity_id, v_code, p_window_start
                );
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.enqueue_relationship_edge(
    p_parent UUID,
    p_child UUID,
    p_code TEXT,
    p_valid_from DATE,
    p_valid_to DATE
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_input RECORD;
    v_index INTEGER;
    v_prefix TEXT[];
    v_anchor UUID;
    v_traversal TEXT;
    v_target UUID;
    v_domain VARCHAR(50);
    v_end DATE;
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
          AND p_code = ANY (ci.relationship_codes)
    LOOP
        v_end := CASE WHEN v_input.time_impact = 'FORWARD' THEN DATE '9999-12-31' ELSE p_valid_to END;
        FOR v_index IN 1..cardinality(v_input.relationship_codes) LOOP
            CONTINUE WHEN v_input.relationship_codes[v_index] IS DISTINCT FROM p_code;
            IF v_index = 1 THEN
                v_prefix := '{}';
            ELSE
                v_prefix := v_input.relationship_codes[1:v_index - 1];
            END IF;
            IF v_input.traversal = 'DOWN' THEN
                v_anchor := p_parent;
                v_traversal := 'DOWN';
            ELSE
                v_anchor := p_child;
                v_traversal := 'UP';
            END IF;

            FOR v_target IN
                SELECT golden_master.calc_target_entities(
                    v_anchor, v_traversal, v_prefix, p_valid_from, v_end
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
$$;

CREATE OR REPLACE FUNCTION golden_master.enqueue_from_attribute_value()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
DECLARE
    v_start DATE;
    v_end DATE;
    v_open TIMESTAMPTZ := golden_master.open_system_to();
BEGIN
    IF current_setting('golden_master.suppress_calc_enqueue', true) = '1' THEN
        RETURN NEW;
    END IF;

    IF NEW.system_to IS DISTINCT FROM v_open THEN
        RETURN NEW;
    END IF;

    IF NEW.source_id IS DISTINCT FROM NEW.golden_source_id THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.golden_value IS NOT DISTINCT FROM OLD.golden_value
       AND NEW.golden_value_numeric IS NOT DISTINCT FROM OLD.golden_value_numeric
       AND NEW.golden_value_date IS NOT DISTINCT FROM OLD.golden_value_date
       AND NEW.golden_source_id IS NOT DISTINCT FROM OLD.golden_source_id
       AND NEW.valid_from IS NOT DISTINCT FROM OLD.valid_from
       AND NEW.valid_to IS NOT DISTINCT FROM OLD.valid_to
       AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id THEN
        RETURN NEW;
    END IF;

    v_start := NEW.valid_from;
    v_end := NEW.valid_to;
    IF TG_OP = 'UPDATE' THEN
        v_start := LEAST(OLD.valid_from, NEW.valid_from);
        v_end := GREATEST(OLD.valid_to, NEW.valid_to);
    END IF;

    PERFORM golden_master.enqueue_for_attribute_change(NEW.entity_id, NEW.attribute_id, v_start, v_end);
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enqueue_calc_from_value
    AFTER INSERT OR UPDATE ON golden_master.entity_attribute_values
    FOR EACH ROW
    EXECUTE FUNCTION golden_master.enqueue_from_attribute_value();

CREATE OR REPLACE FUNCTION golden_master.enqueue_from_relationship()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
BEGIN
    IF current_setting('golden_master.suppress_calc_enqueue', true) = '1' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'DELETE' THEN
        PERFORM golden_master.enqueue_relationship_edge(
            OLD.parent_entity_id, OLD.child_entity_id, OLD.relationship_code, OLD.valid_from, OLD.valid_to
        );
        RETURN OLD;
    END IF;

    PERFORM golden_master.enqueue_relationship_edge(
        NEW.parent_entity_id, NEW.child_entity_id, NEW.relationship_code, NEW.valid_from, NEW.valid_to
    );

    IF TG_OP = 'UPDATE' AND (
        OLD.parent_entity_id IS DISTINCT FROM NEW.parent_entity_id
        OR OLD.child_entity_id IS DISTINCT FROM NEW.child_entity_id
        OR OLD.relationship_code IS DISTINCT FROM NEW.relationship_code
        OR OLD.valid_from IS DISTINCT FROM NEW.valid_from
    ) THEN
        PERFORM golden_master.enqueue_relationship_edge(
            OLD.parent_entity_id, OLD.child_entity_id, OLD.relationship_code,
            LEAST(OLD.valid_from, NEW.valid_from), GREATEST(OLD.valid_to, NEW.valid_to)
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enqueue_calc_from_relationship
    AFTER INSERT OR UPDATE OR DELETE ON entity_instances.entity_relationships
    FOR EACH ROW
    EXECUTE FUNCTION golden_master.enqueue_from_relationship();

-- ---------------------------------------------------------------------------
-- Worker
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION golden_master.calc_depth(p_attribute_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
    WITH RECURSIVE depths AS (
        SELECT cd.attribute_id, 0 AS depth
        FROM metadata_register.calc_definitions cd
        WHERE cd.evaluation_mode = 'MATERIALIZED'
          AND NOT EXISTS (
              SELECT 1
              FROM metadata_register.calc_inputs ci
              JOIN metadata_register.attribute_register dep ON dep.attribute_code = ci.attribute_code
              JOIN metadata_register.calc_definitions dep_cd
                ON dep_cd.attribute_id = dep.id
               AND dep_cd.evaluation_mode = 'MATERIALIZED'
              WHERE ci.calc_definition_id = cd.id
          )
        UNION
        SELECT cd.attribute_id, d.depth + 1
        FROM metadata_register.calc_definitions cd
        JOIN metadata_register.calc_inputs ci ON ci.calc_definition_id = cd.id
        JOIN metadata_register.attribute_register dep ON dep.attribute_code = ci.attribute_code
        JOIN depths d ON d.attribute_id = dep.id
        WHERE cd.evaluation_mode = 'MATERIALIZED'
          AND d.depth < 20
    )
    SELECT COALESCE(MAX(depth), 0)
    FROM depths
    WHERE attribute_id = p_attribute_id;
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
    v_slices JSONB;
    v_row RECORD;
    v_value NUMERIC;
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
            SELECT id INTO v_calc_id
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
                v_value := golden_master.eval_calc(v_calc_id, v_job.entity_id, v_row.as_of, 0);
                v_slices := v_slices || jsonb_build_array(jsonb_build_object(
                    'valid_from', v_row.as_of,
                    'valid_to', v_row.valid_to,
                    'value', v_value
                ));
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

-- ---------------------------------------------------------------------------
-- Public read model
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.calc_definitions
WITH (security_invoker = true) AS
SELECT
    cd.id,
    ar.attribute_code,
    cd.domain_code,
    cd.calc_kind,
    cd.evaluation_mode,
    cd.time_impact,
    cd.output_grain,
    cd.expression,
    cd.aggregate_fn,
    cd.series_fn,
    ar.derivation_dependencies,
    COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'inputRole', ci.input_role,
            'attributeCode', ci.attribute_code,
            'traversal', ci.traversal,
            'relationshipCodes', to_jsonb(ci.relationship_codes)
        ) ORDER BY ci.ordinal, ci.input_role)
        FROM metadata_register.calc_inputs ci
        WHERE ci.calc_definition_id = cd.id
    ), '[]'::jsonb) AS inputs
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id;

CREATE OR REPLACE VIEW public.calc_invalidations
WITH (security_invoker = true) AS
SELECT
    i.id,
    i.entity_id,
    ar.attribute_code,
    i.window_start,
    i.window_end,
    i.status,
    i.not_before,
    i.cause_attribute_code,
    i.last_error,
    i.enqueued_at,
    i.finished_at
FROM golden_master.calc_invalidations i
JOIN metadata_register.attribute_register ar ON ar.id = i.calc_attribute_id;

CREATE OR REPLACE FUNCTION public.calculated_attribute_states(p_entity_id UUID)
RETURNS TABLE (
    entity_id UUID,
    attribute_code VARCHAR,
    dirty BOOLEAN,
    status TEXT,
    window_start DATE,
    window_end DATE
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
    SELECT
        me.id,
        ar.attribute_code,
        COALESCE(bool_or(i.status IN ('PENDING', 'RUNNING')), FALSE) AS dirty,
        CASE
            WHEN bool_or(i.status = 'RUNNING') THEN 'RUNNING'
            WHEN bool_or(i.status = 'PENDING') THEN 'PENDING'
            ELSE NULL
        END AS status,
        MIN(i.window_start) FILTER (WHERE i.status IN ('PENDING', 'RUNNING')) AS window_start,
        MAX(i.window_end) FILTER (WHERE i.status IN ('PENDING', 'RUNNING')) AS window_end
    FROM entity_instances.master_entities me
    JOIN metadata_register.calc_definitions cd
      ON cd.domain_code = me.domain_code
     AND cd.evaluation_mode = 'MATERIALIZED'
    JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
    LEFT JOIN golden_master.calc_invalidations i
      ON i.calc_attribute_id = cd.attribute_id
     AND i.entity_id = me.id
     AND i.status IN ('PENDING', 'RUNNING')
    WHERE me.id = p_entity_id
    GROUP BY me.id, ar.attribute_code;
$$;

CREATE OR REPLACE FUNCTION public.process_calculated_attributes(p_limit INTEGER DEFAULT 500)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = golden_master, metadata_register, entity_instances, public, pg_temp
AS $$
    SELECT golden_master.process_calc_invalidations(p_limit);
$$;

ALTER TABLE metadata_register.calc_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.calc_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE golden_master.calc_invalidations ENABLE ROW LEVEL SECURITY;

CREATE POLICY calc_definitions_read ON metadata_register.calc_definitions
    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY calc_inputs_read ON metadata_register.calc_inputs
    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY calc_invalidations_read ON golden_master.calc_invalidations
    FOR SELECT TO authenticated USING (TRUE);

GRANT SELECT ON metadata_register.calc_definitions TO authenticated;
GRANT SELECT ON metadata_register.calc_inputs TO authenticated;
GRANT SELECT ON golden_master.calc_invalidations TO authenticated;
GRANT SELECT ON public.calc_definitions TO authenticated, service_role;
GRANT SELECT ON public.calc_invalidations TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calculated_attribute_states(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.process_calculated_attributes(INTEGER) TO authenticated, service_role;

REVOKE ALL ON FUNCTION golden_master.process_calc_invalidations(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.write_derived_slices(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.enqueue_calc(UUID, UUID, DATE, DATE, UUID, VARCHAR, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION metadata_register.sync_calc_definition(UUID) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Position market value, fund gross asset value, and fund IRR
-- ---------------------------------------------------------------------------

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code, is_required, default_precedence_rank
) VALUES
    ('PRICE', 'Price', 'NUMBER', 'Current price', 'SECURITY', FALSE, 100),
    ('MARKET_VALUE', 'Market Value', 'NUMBER', 'Position market value', 'POSITION', FALSE, 100)
ON CONFLICT (attribute_code) DO NOTHING;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    is_time_varying, time_dimension, is_derived
) VALUES
    ('GROSS_ASSET_VALUE', 'Gross Asset Value', 'CURRENCY',
     'Sum of market value across positions held by the fund', 'FUND', TRUE, 'VALID_TIME', FALSE),
    ('IRR', 'Internal Rate of Return', 'PERCENTAGE',
     'Annualized rate from related cash flows and gross asset value', 'FUND', TRUE, 'VALID_TIME', FALSE)
ON CONFLICT (attribute_code) DO NOTHING;

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, expression
)
SELECT id, 'POSITION', 'EXPRESSION', 'MATERIALIZED', 'FORWARD', 'ON_INPUT_CHANGE',
       '{"op":"mul","args":[{"ref":"QUANTITY"},{"ref":"PRICE"}]}'::jsonb
FROM metadata_register.attribute_register
WHERE attribute_code = 'MARKET_VALUE'
ON CONFLICT (attribute_id) DO NOTHING;

INSERT INTO metadata_register.calc_inputs (
    calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal
)
SELECT cd.id, 'OPERAND', 'QUANTITY', 'SELF', '{}', 1
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
WHERE ar.attribute_code = 'MARKET_VALUE'
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

INSERT INTO metadata_register.calc_inputs (
    calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal
)
SELECT cd.id, 'OPERAND', 'PRICE', 'UP', ARRAY['POSITION_SECURITY'], 2
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
WHERE ar.attribute_code = 'MARKET_VALUE'
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, aggregate_fn
)
SELECT id, 'FUND', 'AGGREGATE', 'MATERIALIZED', 'FORWARD', 'QUARTER_END', 'SUM'
FROM metadata_register.attribute_register
WHERE attribute_code = 'GROSS_ASSET_VALUE'
ON CONFLICT (attribute_id) DO NOTHING;

INSERT INTO metadata_register.calc_inputs (
    calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal
)
SELECT cd.id, 'MEASURE', 'MARKET_VALUE', 'DOWN', ARRAY['POSITION_FUND'], 1
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
WHERE ar.attribute_code = 'GROSS_ASSET_VALUE'
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, series_fn
)
SELECT id, 'FUND', 'SERIES', 'MATERIALIZED', 'FORWARD', 'QUARTER_END', 'XIRR'
FROM metadata_register.attribute_register
WHERE attribute_code = 'IRR'
ON CONFLICT (attribute_id) DO NOTHING;

INSERT INTO metadata_register.calc_inputs (
    calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal
)
SELECT cd.id, 'AMOUNT', 'AMOUNT', 'DOWN', ARRAY['POSITION_FUND', 'POSITION_CASHFLOW'], 1
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
WHERE ar.attribute_code = 'IRR'
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

INSERT INTO metadata_register.calc_inputs (
    calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal
)
SELECT cd.id, 'FLOW_DATE', 'CASHFLOW_DATE', 'DOWN', ARRAY['POSITION_FUND', 'POSITION_CASHFLOW'], 2
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
WHERE ar.attribute_code = 'IRR'
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

INSERT INTO metadata_register.calc_inputs (
    calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal
)
SELECT cd.id, 'TERMINAL', 'GROSS_ASSET_VALUE', 'SELF', '{}', 3
FROM metadata_register.calc_definitions cd
JOIN metadata_register.attribute_register ar ON ar.id = cd.attribute_id
WHERE ar.attribute_code = 'IRR'
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

-- Prime the queue from winning inputs already on the books. Processing stays explicit.
DO $$
DECLARE
    v_row RECORD;
BEGIN
    FOR v_row IN
        SELECT DISTINCT eav.entity_id, eav.attribute_id, eav.valid_from, eav.valid_to
        FROM golden_master.entity_attribute_values eav
        JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
        JOIN metadata_register.calc_inputs ci ON ci.attribute_code = ar.attribute_code
        WHERE eav.system_to = golden_master.open_system_to()
          AND eav.source_id = eav.golden_source_id
          AND eav.valid_to = DATE '9999-12-31'
    LOOP
        PERFORM golden_master.enqueue_for_attribute_change(
            v_row.entity_id, v_row.attribute_id, v_row.valid_from, v_row.valid_to
        );
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
