-- The Moody's diversity score as a compliance term.
--
-- CLO indentures hold the collateral to a minimum Moody's diversity score. The
-- rule library could not express it: the score is not a sum or an average of
-- one attribute. It groups performing par by obligor, counts each obligor as
-- min(1, its par / the average obligor par) units, sums the units by Moody's
-- industry, maps each industry's units through the Moody's diversity table,
-- and adds the industry scores up.
--
-- This adds:
--   1. compliance.clo_diversity_rows: the one interpreter of that score. It
--      returns one row per industry (and one with no industry for par whose
--      obligor has none), scored from the records a term selects.
--   2. A DIVERSITY term kind in compliance.eval_clo_term, which sums those rows.
--      A measure line of kind DIVERSITY reads:
--        path / where       the holdings (as for every other term)
--        weight_attribute   their par
--        value_path         hops from each holding to its obligor
--        attribute          the obligor's industry
--      and, from the term when given (else the defaults):
--        group_attribute    the obligor group key (OBLIGOR_GROUP_ID)
--        table_list         the reference list holding the table (MOODYS_DIVERSITY_TABLE);
--                           each value's metadata carries units and score
--      Holdings with the term's scenario code are counted, so pre-trade and
--      pro forma scores see a proposed buy.
--   3. compliance.clo_diversity_breakdown: the industry rows behind one rule's
--      score for one fund, for screens that show the breakdown beside the result.
--
-- eval_clo_term is patched in place, by inserting the new kind ahead of its
-- final "unknown kind" error, so whichever definition is live keeps every other
-- branch exactly as it is (the pattern of 20261112145804_fund_threshold_enrollment).
-- The rule itself is a record and is seeded (supabase/seed/clo_diversity_rule.sql).

-- ============================================================
-- 1. The interpreter
-- ============================================================

CREATE OR REPLACE FUNCTION compliance.clo_diversity_rows(
    p_anchor_id UUID,
    p_term JSONB,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ,
    p_source_scope VARCHAR,
    p_scenario_code VARCHAR,
    p_ids UUID[] DEFAULT NULL
) RETURNS TABLE (industry TEXT, obligors INTEGER, par NUMERIC, units NUMERIC, score NUMERIC)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_ids UUID[];
    v_weight_attr TEXT := COALESCE(NULLIF(p_term ->> 'weight_attribute', ''), 'FUNDED_PAR_AMOUNT');
    v_industry_attr TEXT := COALESCE(NULLIF(p_term ->> 'attribute', ''), 'MOODYS_INDUSTRY_CODE');
    v_group_attr TEXT := COALESCE(NULLIF(p_term ->> 'group_attribute', ''), 'OBLIGOR_GROUP_ID');
    v_table TEXT := COALESCE(NULLIF(p_term ->> 'table_list', ''), 'MOODYS_DIVERSITY_TABLE');
    v_rd RECORD;
BEGIN
    SELECT * INTO v_rd FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, p_source_scope, p_term -> 'dimension');
    v_ids := COALESCE(p_ids, compliance.clo_term_ids(p_anchor_id, p_term -> 'path', p_term -> 'where',
                                                     p_as_of_date, p_knowledge_date, p_source_scope, p_scenario_code));
    IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH holdings AS (
        SELECT g.entity_id AS holding, g.val AS par
        FROM compliance.get_numeric_values(v_ids, v_weight_attr, v_rd.o_as_of, v_rd.o_knowledge, v_rd.o_source) g
        WHERE g.val > 0
    ), placed AS (
        -- The obligor each holding is a claim on, and its group and industry.
        SELECT h.holding, h.par, o.obligor
        FROM holdings h
        LEFT JOIN LATERAL (
            SELECT CASE
                WHEN jsonb_typeof(p_term -> 'value_path') = 'array' AND jsonb_array_length(p_term -> 'value_path') > 0
                THEN (compliance.walk_path_flexible(ARRAY[h.holding], p_term -> 'value_path', p_as_of_date, p_knowledge_date))[1]
                ELSE h.holding
            END AS obligor
        ) o ON TRUE
    ), keyed AS (
        SELECT p.par,
               COALESCE(NULLIF(btrim(compliance.get_text_value(p.obligor, v_group_attr, v_rd.o_as_of, v_rd.o_knowledge, v_rd.o_source)), ''),
                        p.obligor::TEXT, p.holding::TEXT) AS obligor_key,
               NULLIF(btrim(compliance.get_text_value(p.obligor, v_industry_attr, v_rd.o_as_of, v_rd.o_knowledge, v_rd.o_source)), '') AS industry
        FROM placed p
    ), by_obligor AS (
        -- An obligor group in more than one industry is counted in the industry of most of its par.
        SELECT k.obligor_key, SUM(k.par) AS par,
               (array_agg(k.industry ORDER BY k.industry IS NULL, k.par DESC))[1] AS industry
        FROM keyed k
        GROUP BY k.obligor_key
    ), average AS (
        SELECT SUM(b.par) / NULLIF(COUNT(*), 0) AS par FROM by_obligor b
    ), by_industry AS (
        SELECT b.industry, COUNT(*)::INTEGER AS obligors, SUM(b.par) AS par,
               SUM(LEAST(1, b.par / NULLIF(a.par, 0))) AS units
        FROM by_obligor b CROSS JOIN average a
        GROUP BY b.industry
    ), diversity_table AS (
        SELECT (v.metadata ->> 'units')::NUMERIC AS u, (v.metadata ->> 'score')::NUMERIC AS s
        FROM metadata_register.reference_lists l
        JOIN metadata_register.reference_list_values v ON v.list_id = l.id
        WHERE l.list_code = v_table
          AND v.metadata ? 'units' AND v.metadata ? 'score'
    )
    SELECT i.industry, i.obligors, i.par, i.units,
           CASE
               WHEN i.industry IS NULL OR NOT EXISTS (SELECT 1 FROM diversity_table) THEN 0::NUMERIC
               -- Above the table's last row the last score holds.
               WHEN i.units >= (SELECT MAX(t.u) FROM diversity_table t)
                   THEN (SELECT t.s FROM diversity_table t ORDER BY t.u DESC LIMIT 1)
               ELSE (
                   -- Linear between the rows on either side.
                   SELECT lo.s + CASE WHEN hi.u = lo.u THEN 0 ELSE (i.units - lo.u) / (hi.u - lo.u) * (hi.s - lo.s) END
                   FROM (SELECT t.u, t.s FROM diversity_table t WHERE t.u <= i.units ORDER BY t.u DESC LIMIT 1) lo,
                        (SELECT t.u, t.s FROM diversity_table t WHERE t.u >= i.units ORDER BY t.u ASC LIMIT 1) hi
               )
           END
    FROM by_industry i;
END;
$$;

COMMENT ON FUNCTION compliance.clo_diversity_rows(UUID, JSONB, DATE, TIMESTAMPTZ, VARCHAR, VARCHAR, UUID[]) IS
    'Moody''s diversity score by industry for the holdings a term selects: par by obligor group, units of min(1, par / average obligor par), each industry''s units through the diversity table. The score is the sum of the rows. The one interpreter of the score: the DIVERSITY term kind and the breakdown both read it.';

GRANT EXECUTE ON FUNCTION compliance.clo_diversity_rows(UUID, JSONB, DATE, TIMESTAMPTZ, VARCHAR, VARCHAR, UUID[]) TO authenticated, service_role;

-- ============================================================
-- 2. The DIVERSITY term kind
-- ============================================================

DO $$
DECLARE
    v_def TEXT;
    v_old TEXT := $old$    RAISE EXCEPTION 'Unknown composite term kind: %', v_kind;$old$;
    v_new TEXT := $new$    -- clo_diversity_term: the Moody's diversity score of the selected holdings.
    IF v_kind = 'DIVERSITY' THEN
        RETURN (
            SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE SUM(d.score) END
            FROM compliance.clo_diversity_rows(p_anchor_id, p_term, p_as_of_date, p_knowledge_date,
                                               p_source_scope, p_scenario_code, v_ids) AS d
        );
    END IF;

    RAISE EXCEPTION 'Unknown composite term kind: %', v_kind;$new$;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'compliance' AND p.proname = 'eval_clo_term'
    ORDER BY p.oid DESC
    LIMIT 1;

    IF v_def IS NULL THEN
        RAISE EXCEPTION 'compliance.eval_clo_term was not found';
    END IF;
    IF strpos(v_def, 'clo_diversity_term') > 0 THEN
        RETURN;
    END IF;
    IF strpos(v_def, v_old) = 0 THEN
        RAISE EXCEPTION 'eval_clo_term does not end with the unknown-kind error this migration extends';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
END $$;

-- A measure line may be of the new kind.
ALTER TABLE compliance.rule_measure_lines DROP CONSTRAINT IF EXISTS rule_measure_lines_kind_check;
ALTER TABLE compliance.rule_measure_lines ADD CONSTRAINT rule_measure_lines_kind_check
    CHECK (kind IN ('SUM', 'COUNT', 'MIN', 'MAX', 'AVG', 'VALUE', 'WAVG', 'EXCESS_OVER_PCT', 'DIVERSITY'));

-- ============================================================
-- 3. The breakdown behind one rule's score
-- ============================================================

CREATE OR REPLACE FUNCTION compliance.clo_diversity_breakdown(
    p_rule_code TEXT,
    p_anchor_id UUID,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ DEFAULT now()
) RETURNS TABLE (industry TEXT, obligors INTEGER, par NUMERIC, units NUMERIC, score NUMERIC)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
    v_rule UUID;
    v_version compliance.rule_versions;
    v_term JSONB;
BEGIN
    PERFORM tenancy.assert_entity_access(p_anchor_id, 'READ');
    -- The shared rule, or the caller's own client's rule with that code.
    v_rule := compliance.rule_id_for_code(p_rule_code, NULL);
    IF v_rule IS NULL THEN
        RETURN;
    END IF;
    v_version := compliance.resolve_rule_version(v_rule, p_as_of_date, p_knowledge_date);
    IF v_version.id IS NULL THEN
        RETURN;
    END IF;
    SELECT t INTO v_term
    FROM jsonb_array_elements(compliance.measure_line_terms(v_version.id, 'NUMERATOR')) AS t
    WHERE upper(t ->> 'kind') = 'DIVERSITY'
    LIMIT 1;
    IF v_term IS NULL THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT * FROM compliance.clo_diversity_rows(p_anchor_id, v_term, p_as_of_date, p_knowledge_date,
                                                COALESCE(v_version.default_source_scope, 'GOLDEN'), NULL);
END;
$$;

COMMENT ON FUNCTION compliance.clo_diversity_breakdown(TEXT, UUID, DATE, TIMESTAMPTZ) IS
    'The industry rows behind a diversity rule''s score for one fund, read through the rule''s own DIVERSITY line. The booked book only: no scenario.';

GRANT EXECUTE ON FUNCTION compliance.clo_diversity_breakdown(TEXT, UUID, DATE, TIMESTAMPTZ) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
