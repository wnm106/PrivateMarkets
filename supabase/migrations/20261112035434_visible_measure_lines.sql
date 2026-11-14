-- Composite tests (CCC, OC, IC, weighted averages, excess haircuts) kept their
-- real formula in rule_versions.metadata. The editor showed an empty
-- denominator and a single numerator. Each amount is now a measure line, with
-- its own filters, and evaluate_rule rebuilds the composite formula from those
-- lines. The metadata keys are removed so there is one copy of the formula.

CREATE TABLE IF NOT EXISTS compliance.rule_measure_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_version_id UUID NOT NULL REFERENCES compliance.rule_versions(id) ON DELETE CASCADE,
    side VARCHAR(12) NOT NULL CHECK (side IN ('NUMERATOR', 'DENOMINATOR', 'LIMIT')),
    line_order INTEGER NOT NULL,
    label TEXT,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('SUM', 'COUNT', 'MIN', 'MAX', 'AVG', 'VALUE', 'WAVG', 'EXCESS_OVER_PCT')),
    sign INTEGER NOT NULL DEFAULT 1 CHECK (sign IN (-1, 1)),
    attribute_code VARCHAR(100),
    path JSONB NOT NULL DEFAULT '[]'::jsonb,
    weight_attribute_code VARCHAR(100),
    value_path JSONB NOT NULL DEFAULT '[]'::jsonb,
    transform VARCHAR(40),
    price_attribute_code VARCHAR(100),
    pct NUMERIC,
    pct_attribute_code VARCHAR(100),
    pct_path JSONB NOT NULL DEFAULT '[]'::jsonb,
    total_path JSONB,
    required BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (rule_version_id, side, line_order)
);

CREATE INDEX IF NOT EXISTS idx_compliance_measure_lines_version
    ON compliance.rule_measure_lines (rule_version_id, side, line_order);

COMMENT ON TABLE compliance.rule_measure_lines IS
    'One amount in a compliance formula. The numerator, denominator, and a limit read from a related record are lists of these lines. evaluate_rule turns them back into the composite term it already knows how to score.';

ALTER TABLE compliance.rule_measure_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Compliance measure lines readable by authenticated" ON compliance.rule_measure_lines;
CREATE POLICY "Compliance measure lines readable by authenticated"
    ON compliance.rule_measure_lines
    FOR SELECT TO authenticated
    USING (TRUE);

DROP POLICY IF EXISTS "Compliance measure lines writable by tenant admins" ON compliance.rule_measure_lines;
CREATE POLICY "Compliance measure lines writable by tenant admins"
    ON compliance.rule_measure_lines
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON compliance.rule_measure_lines TO authenticated, service_role;

ALTER TABLE compliance.rule_conditions
    ADD COLUMN IF NOT EXISTS measure_line_id UUID REFERENCES compliance.rule_measure_lines(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS filter_role VARCHAR(10) NOT NULL DEFAULT 'WHERE';

DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'compliance'
          AND rel.relname = 'rule_conditions'
          AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) ILIKE '%applies_to%'
    LOOP
        EXECUTE format('ALTER TABLE compliance.rule_conditions DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE compliance.rule_conditions
    DROP CONSTRAINT IF EXISTS rule_conditions_applies_to_check;

ALTER TABLE compliance.rule_conditions
    ADD CONSTRAINT rule_conditions_applies_to_check
    CHECK (applies_to IN ('BASE', 'ANCHOR', 'LINE'));

ALTER TABLE compliance.rule_conditions
    DROP CONSTRAINT IF EXISTS rule_conditions_filter_role_check;

ALTER TABLE compliance.rule_conditions
    ADD CONSTRAINT rule_conditions_filter_role_check
    CHECK (filter_role IN ('WHERE', 'TOTAL'));

CREATE INDEX IF NOT EXISTS idx_compliance_conditions_measure_line
    ON compliance.rule_conditions (measure_line_id);

COMMENT ON COLUMN compliance.rule_conditions.measure_line_id IS
    'Set when the condition filters one measure line. Those rows use applies_to LINE and are not population filters.';
COMMENT ON COLUMN compliance.rule_conditions.filter_role IS
    'WHERE filters the line. TOTAL filters the population an excess-over-percent line is a percent of.';

-- A line's conditions, in the shape eval_clo_term already matches.
CREATE OR REPLACE FUNCTION compliance.measure_line_filters(p_line_id uuid, p_role text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT COALESCE(jsonb_agg(built.filter ORDER BY built.condition_order), '[]'::jsonb)
    FROM (
        SELECT
            c.condition_order,
            jsonb_strip_nulls(jsonb_build_object(
                'attribute', c.attribute_code,
                'op', c.operator
            ))
            || CASE
                WHEN c.value IS NULL THEN '{}'::jsonb
                WHEN c.operator IN ('in', 'not_in') THEN jsonb_build_object('value', c.value::jsonb)
                ELSE jsonb_build_object('value', to_jsonb(c.value))
            END
            || CASE
                WHEN jsonb_typeof(c.attribute_dimension -> 'relationship_path') = 'array'
                 AND jsonb_array_length(c.attribute_dimension -> 'relationship_path') > 0
                THEN jsonb_build_object('path', c.attribute_dimension -> 'relationship_path')
                ELSE '{}'::jsonb
            END
            || CASE
                WHEN COALESCE(c.compare_attribute_code, '') <> ''
                THEN jsonb_build_object('value_attribute', c.compare_attribute_code)
                ELSE '{}'::jsonb
            END
            || CASE
                WHEN jsonb_typeof(c.compare_dimension -> 'relationship_path') = 'array'
                 AND jsonb_array_length(c.compare_dimension -> 'relationship_path') > 0
                THEN jsonb_build_object('value_path', c.compare_dimension -> 'relationship_path')
                ELSE '{}'::jsonb
            END AS filter
        FROM compliance.rule_conditions AS c
        WHERE c.measure_line_id = p_line_id
          AND c.filter_role = p_role
    ) AS built;
$$;

CREATE OR REPLACE FUNCTION compliance.measure_line_terms(p_version_id uuid, p_side text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT COALESCE(jsonb_agg(built.term ORDER BY built.line_order), '[]'::jsonb)
    FROM (
        SELECT
            l.line_order,
            jsonb_strip_nulls(jsonb_build_object(
                'label', NULLIF(l.label, ''),
                'kind', l.kind,
                'attribute', NULLIF(l.attribute_code, ''),
                'path', COALESCE(l.path, '[]'::jsonb),
                'sign', CASE WHEN l.sign = -1 THEN -1 END,
                'required', CASE WHEN l.required THEN TRUE END,
                'where', CASE
                    WHEN jsonb_array_length(filters.where_filters) > 0 THEN filters.where_filters
                END,
                'weight_attribute', NULLIF(l.weight_attribute_code, ''),
                'value_path', CASE
                    WHEN jsonb_typeof(l.value_path) = 'array' AND jsonb_array_length(l.value_path) > 0 THEN l.value_path
                END,
                'transform', NULLIF(l.transform, ''),
                'price_attribute', NULLIF(l.price_attribute_code, ''),
                'pct', l.pct,
                'total_path', CASE
                    WHEN jsonb_typeof(l.total_path) = 'array' THEN l.total_path
                END,
                'total_where', CASE
                    WHEN jsonb_array_length(filters.total_filters) > 0 THEN filters.total_filters
                END,
                'pct_term', CASE
                    WHEN COALESCE(l.pct_attribute_code, '') <> '' THEN jsonb_build_object(
                        'kind', 'MAX',
                        'attribute', l.pct_attribute_code,
                        'path', COALESCE(l.pct_path, '[]'::jsonb)
                    )
                END
            )) AS term
        FROM compliance.rule_measure_lines AS l
        CROSS JOIN LATERAL (
            SELECT
                compliance.measure_line_filters(l.id, 'WHERE') AS where_filters,
                compliance.measure_line_filters(l.id, 'TOTAL') AS total_filters
        ) AS filters
        WHERE l.rule_version_id = p_version_id
          AND l.side = p_side
    ) AS built;
$$;

-- Lines win. A version with no numerator lines keeps whatever metadata it has,
-- so a rule that has not been moved yet still scores.
CREATE OR REPLACE FUNCTION compliance.overlay_measure_lines(p_version_id uuid, p_meta jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_num jsonb;
    v_den jsonb;
    v_lim jsonb;
    v_out jsonb;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM compliance.rule_measure_lines AS line
        WHERE line.rule_version_id = p_version_id
          AND line.side = 'NUMERATOR'
    ) THEN
        RETURN COALESCE(p_meta, '{}'::jsonb);
    END IF;

    v_num := compliance.measure_line_terms(p_version_id, 'NUMERATOR');
    v_den := compliance.measure_line_terms(p_version_id, 'DENOMINATOR');
    v_lim := compliance.measure_line_terms(p_version_id, 'LIMIT');
    v_out := (COALESCE(p_meta, '{}'::jsonb) - 'logic' - 'numerator_terms' - 'denominator_terms' - 'limit_term')
        || jsonb_build_object('logic', 'composite_ratio', 'numerator_terms', v_num);
    IF jsonb_array_length(v_den) > 0 THEN
        v_out := v_out || jsonb_build_object('denominator_terms', v_den);
    END IF;
    IF jsonb_array_length(v_lim) > 0 THEN
        v_out := v_out || jsonb_build_object('limit_term', v_lim -> 0);
    END IF;
    RETURN v_out;
END;
$$;

COMMENT ON FUNCTION compliance.measure_line_filters(uuid, text) IS
    'Filters on one measure line, as the composite term matcher expects them.';
COMMENT ON FUNCTION compliance.measure_line_terms(uuid, text) IS
    'Measure lines on one side of a rule version, as composite terms.';
COMMENT ON FUNCTION compliance.overlay_measure_lines(uuid, jsonb) IS
    'Replaces hidden composite metadata with the measure lines stored for the version. Returns the metadata unchanged when the version has no numerator lines.';

REVOKE ALL ON FUNCTION compliance.measure_line_filters(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.measure_line_terms(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.overlay_measure_lines(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.measure_line_filters(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION compliance.measure_line_terms(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION compliance.overlay_measure_lines(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION compliance.measure_line_filters(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.measure_line_terms(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.overlay_measure_lines(uuid, jsonb) TO authenticated, service_role;

-- Copy the hidden formula onto lines before it is deleted. Re-running after
-- the keys are gone inserts nothing.
INSERT INTO compliance.rule_measure_lines (
    rule_version_id, side, line_order, label, kind, sign, attribute_code, path,
    weight_attribute_code, value_path, transform, price_attribute_code, pct,
    pct_attribute_code, pct_path, total_path, required
)
SELECT
    v.id,
    src.side,
    src.ordinality::integer,
    NULLIF(src.term ->> 'label', ''),
    COALESCE(src.term ->> 'kind', 'SUM'),
    CASE WHEN src.term ->> 'sign' = '-1' THEN -1 ELSE 1 END,
    NULLIF(src.term ->> 'attribute', ''),
    COALESCE(src.term -> 'path', '[]'::jsonb),
    NULLIF(src.term ->> 'weight_attribute', ''),
    COALESCE(src.term -> 'value_path', '[]'::jsonb),
    NULLIF(src.term ->> 'transform', ''),
    NULLIF(src.term ->> 'price_attribute', ''),
    CASE WHEN src.term ? 'pct' THEN (src.term ->> 'pct')::numeric END,
    NULLIF(src.term -> 'pct_term' ->> 'attribute', ''),
    COALESCE(src.term -> 'pct_term' -> 'path', '[]'::jsonb),
    CASE WHEN jsonb_typeof(src.term -> 'total_path') = 'array' THEN src.term -> 'total_path' END,
    COALESCE((src.term ->> 'required')::boolean, FALSE)
FROM compliance.rule_versions AS v
CROSS JOIN LATERAL (
    SELECT 'NUMERATOR' AS side, term, ordinality
    FROM jsonb_array_elements(COALESCE(v.metadata -> 'numerator_terms', '[]'::jsonb)) WITH ORDINALITY AS e(term, ordinality)
    UNION ALL
    SELECT 'DENOMINATOR', term, ordinality
    FROM jsonb_array_elements(COALESCE(v.metadata -> 'denominator_terms', '[]'::jsonb)) WITH ORDINALITY AS e(term, ordinality)
    UNION ALL
    SELECT 'LIMIT', v.metadata -> 'limit_term', 1
    WHERE jsonb_typeof(v.metadata -> 'limit_term') = 'object'
) AS src
WHERE v.metadata ->> 'logic' = 'composite_ratio'
  AND NOT EXISTS (
      SELECT 1 FROM compliance.rule_measure_lines AS existing
      WHERE existing.rule_version_id = v.id
  );

INSERT INTO compliance.rule_conditions (
    rule_version_id, measure_line_id, applies_to, filter_role, condition_group, condition_order,
    attribute_code, operator, value, logic_operator, attribute_dimension, compare_attribute_code, compare_dimension
)
SELECT
    l.rule_version_id,
    l.id,
    'LINE',
    src.role,
    1,
    src.ordinality::integer,
    src.elem ->> 'attribute',
    COALESCE(src.elem ->> 'op', 'equals'),
    CASE
        WHEN src.elem -> 'value' IS NULL OR jsonb_typeof(src.elem -> 'value') = 'null' THEN NULL
        WHEN jsonb_typeof(src.elem -> 'value') = 'array' THEN (src.elem -> 'value')::text
        WHEN jsonb_typeof(src.elem -> 'value') = 'string' THEN src.elem ->> 'value'
        ELSE (src.elem -> 'value')::text
    END,
    'AND',
    CASE
        WHEN jsonb_typeof(src.elem -> 'path') = 'array' AND jsonb_array_length(src.elem -> 'path') > 0
        THEN jsonb_build_object('relationship_path', src.elem -> 'path')
        ELSE '{}'::jsonb
    END,
    NULLIF(src.elem ->> 'value_attribute', ''),
    CASE
        WHEN jsonb_typeof(src.elem -> 'value_path') = 'array' AND jsonb_array_length(src.elem -> 'value_path') > 0
        THEN jsonb_build_object('relationship_path', src.elem -> 'value_path')
        ELSE '{}'::jsonb
    END
FROM compliance.rule_measure_lines AS l
JOIN compliance.rule_versions AS v ON v.id = l.rule_version_id
JOIN LATERAL (
    SELECT 'WHERE'::text AS role, f.elem, f.ordinality
    FROM jsonb_array_elements(COALESCE(
        CASE l.side
            WHEN 'NUMERATOR' THEN (v.metadata -> 'numerator_terms' -> (l.line_order - 1)) -> 'where'
            WHEN 'DENOMINATOR' THEN (v.metadata -> 'denominator_terms' -> (l.line_order - 1)) -> 'where'
            WHEN 'LIMIT' THEN (v.metadata -> 'limit_term') -> 'where'
        END,
        '[]'::jsonb
    )) WITH ORDINALITY AS f(elem, ordinality)
    UNION ALL
    SELECT 'TOTAL'::text, f.elem, f.ordinality
    FROM jsonb_array_elements(COALESCE(
        CASE l.side
            WHEN 'NUMERATOR' THEN (v.metadata -> 'numerator_terms' -> (l.line_order - 1)) -> 'total_where'
            WHEN 'DENOMINATOR' THEN (v.metadata -> 'denominator_terms' -> (l.line_order - 1)) -> 'total_where'
            ELSE '[]'::jsonb
        END,
        '[]'::jsonb
    )) WITH ORDINALITY AS f(elem, ordinality)
) AS src ON TRUE
WHERE v.metadata ->> 'logic' = 'composite_ratio'
  AND COALESCE(src.elem ->> 'attribute', '') <> ''
  AND NOT EXISTS (
      SELECT 1 FROM compliance.rule_conditions AS existing
      WHERE existing.measure_line_id = l.id
  );

DO $$
DECLARE
    r record;
BEGIN
    SELECT
        v.id,
        compliance.measure_line_terms(v.id, 'NUMERATOR') AS got_num,
        COALESCE(v.metadata -> 'numerator_terms', '[]'::jsonb) AS exp_num,
        compliance.measure_line_terms(v.id, 'DENOMINATOR') AS got_den,
        COALESCE(v.metadata -> 'denominator_terms', '[]'::jsonb) AS exp_den,
        compliance.measure_line_terms(v.id, 'LIMIT') -> 0 AS got_lim,
        v.metadata -> 'limit_term' AS exp_lim
    INTO r
    FROM compliance.rule_versions AS v
    WHERE v.metadata ->> 'logic' = 'composite_ratio'
      AND (
          compliance.measure_line_terms(v.id, 'NUMERATOR')
              IS DISTINCT FROM COALESCE(v.metadata -> 'numerator_terms', '[]'::jsonb)
          OR compliance.measure_line_terms(v.id, 'DENOMINATOR')
              IS DISTINCT FROM COALESCE(v.metadata -> 'denominator_terms', '[]'::jsonb)
          OR (compliance.measure_line_terms(v.id, 'LIMIT') -> 0)
              IS DISTINCT FROM v.metadata -> 'limit_term'
      )
    LIMIT 1;

    IF r.id IS NOT NULL THEN
        RAISE EXCEPTION
            'measure line round-trip failed for version % numerator got % expected % denominator got % expected % limit got % expected %',
            r.id, r.got_num, r.exp_num, r.got_den, r.exp_den, r.got_lim, r.exp_lim;
    END IF;
END $$;

-- The lines are the formula. Drop the second copy.
UPDATE compliance.rule_versions
SET metadata = metadata - 'logic' - 'numerator_terms' - 'denominator_terms' - 'limit_term'
WHERE metadata ->> 'logic' = 'composite_ratio';

-- Teach the live evaluator to read the lines. The rest of the function stays
-- as it is: the overlay feeds the composite path it already runs.
DO $$
DECLARE
    v_def text;
    v_old text := 'v_meta := COALESCE(v_version.metadata, ''{}''::jsonb);';
    v_new text := 'v_meta := compliance.overlay_measure_lines(v_version.id, COALESCE(v_version.metadata, ''{}''::jsonb));';
BEGIN
    SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'compliance'
      AND p.proname = 'evaluate_rule'
    ORDER BY p.oid DESC
    LIMIT 1;

    IF v_def IS NULL THEN
        RAISE EXCEPTION 'compliance.evaluate_rule was not found';
    END IF;
    IF strpos(v_def, 'overlay_measure_lines') > 0 THEN
        RETURN;
    END IF;
    IF strpos(v_def, v_old) = 0 THEN
        RAISE EXCEPTION 'evaluate_rule does not contain the metadata assignment this migration replaces';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
END $$;

NOTIFY pgrst, 'reload schema';
