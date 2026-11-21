-- A fund limit is the only limit. Retire the rule-wide limit.
--
-- Before: a fund with no threshold row for a rule still got the rule's own
-- limit (a rule-wide threshold row, else the rule version's numbers). The deal
-- allocation panel and the allocation engine tested those, while the fund
-- thresholds page said the rule was not used.
--
-- After:
--   1. Every allocation-eligible fund gets its own threshold row for each fund
--      rule that covers it and has a limit, copied from what it resolved to
--      before. Nothing the allocation panel tested is lost.
--   2. Rule-wide rows (entity_id IS NULL) are copied to those funds, then
--      closed. New rule-wide rows are refused.
--   3. compliance.resolve_threshold reads only the fund's own rows for a fund
--      rule. No row: the rule does not apply to that fund. A fund row with no
--      numbers uses the fund's own limit attribute when the rule has one (for
--      example FUND_SINGLE_ISSUER_LIMIT_PCT or NAV), else it has no limit.
--      The rule version's numbers are a template only, used by the rule
--      builder's test run (compliance.rule_preview) and to fill a new fund row.
-- Rules on records that are not funds (statement covenants) are unchanged.
--
-- guard: data-migration Retiring the rule-wide limit would silently drop limits the allocation already enforces, so each fund's current limit is written onto its own row first.

-- 1. Copy each rule's limit onto the allocation-eligible funds it covers.
WITH eligible AS (
    SELECT DISTINCT eav.entity_id
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    JOIN entity_instances.master_entities me ON me.id = eav.entity_id
    WHERE ar.attribute_code = 'FUND_IS_ALLOCATION_ELIGIBLE'
      AND eav.golden_value_boolean
      AND eav.valid_from <= CURRENT_DATE AND eav.valid_to >= CURRENT_DATE
      AND eav.system_to >= NOW()
      AND me.domain_code = 'FUND'
      AND me.is_active
),
fund_rule AS (
    SELECT r.id AS rule_id, v.soft_limit_value, v.hard_limit_value, v.hard_limit_attribute_code,
           COALESCE(v.limit_direction, 'MAX') AS limit_direction, a.entity_id
    FROM compliance.rules r
    CROSS JOIN LATERAL compliance.resolve_rule_version(r.id, CURRENT_DATE, NOW()) v
    CROSS JOIN LATERAL compliance.get_anchor_entities(r.id, CURRENT_DATE, NOW()) a
    WHERE r.anchor_domain_code = 'FUND'
      AND v.id IS NOT NULL
      AND (v.hard_limit_value IS NOT NULL OR v.soft_limit_value IS NOT NULL OR v.hard_limit_attribute_code IS NOT NULL)
      AND a.entity_id IN (SELECT entity_id FROM eligible)
),
picked AS (
    SELECT fr.*,
           rule_row.soft_limit_value AS rule_soft, rule_row.hard_limit_value AS rule_hard,
           rule_row.limit_direction AS rule_direction, rule_row.found AS has_rule_row,
           (fr.hard_limit_attribute_code IS NOT NULL AND EXISTS (
               SELECT 1 FROM compliance.get_numeric_values(ARRAY[fr.entity_id], fr.hard_limit_attribute_code, CURRENT_DATE, NOW(), NULL) g
               WHERE g.val IS NOT NULL
           )) AS has_attribute
    FROM fund_rule fr
    LEFT JOIN LATERAL (
        SELECT t.soft_limit_value, t.hard_limit_value, t.limit_direction, TRUE AS found
        FROM compliance.rule_thresholds t
        WHERE t.rule_id = fr.rule_id AND t.entity_id IS NULL
          AND t.group_value IS NULL AND t.rank_from IS NULL AND t.rank_to IS NULL
          AND t.valid_from <= CURRENT_DATE AND t.valid_to >= CURRENT_DATE
        LIMIT 1
    ) rule_row ON TRUE
    WHERE NOT EXISTS (
        SELECT 1 FROM compliance.rule_thresholds t
        WHERE t.rule_id = fr.rule_id AND t.entity_id = fr.entity_id
          AND t.group_value IS NULL AND t.rank_from IS NULL AND t.rank_to IS NULL
          AND t.valid_to = DATE '9999-12-31'
    )
)
INSERT INTO compliance.rule_thresholds (
    rule_id, entity_id, soft_limit_value, hard_limit_value, applies, limit_direction, notes
)
SELECT p.rule_id, p.entity_id,
       CASE WHEN p.has_rule_row THEN p.rule_soft
            WHEN p.has_attribute THEN NULL
            ELSE p.soft_limit_value END,
       CASE WHEN p.has_rule_row THEN p.rule_hard
            WHEN p.has_attribute THEN NULL
            ELSE p.hard_limit_value END,
       TRUE,
       COALESCE(CASE WHEN p.has_rule_row THEN p.rule_direction END, p.limit_direction),
       CASE WHEN p.has_rule_row THEN 'Copied from the rule-wide limit when fund limits became the only limits.'
            WHEN p.has_attribute THEN 'Uses this fund''s ' || p.hard_limit_attribute_code || ' value. Set when fund limits became the only limits.'
            ELSE 'Copied from the rule''s default limit when fund limits became the only limits.' END
FROM picked p
WHERE p.has_rule_row
   OR p.has_attribute
   OR p.hard_limit_value IS NOT NULL
   OR p.soft_limit_value IS NOT NULL;

-- 1b. A blank fund row used to take the rule's own numbers. Write those numbers
--     onto it, unless the rule reads a fund attribute (a blank row keeps that).
UPDATE compliance.rule_thresholds t
SET soft_limit_value = COALESCE(rule_row.soft_limit_value, v.soft_limit_value),
    hard_limit_value = COALESCE(rule_row.hard_limit_value, v.hard_limit_value),
    notes = CONCAT_WS(' ', NULLIF(t.notes, ''), 'Limit copied from the rule when fund limits became the only limits.'),
    updated_at = NOW()
FROM compliance.rules r
CROSS JOIN LATERAL compliance.resolve_rule_version(r.id, CURRENT_DATE, NOW()) v
LEFT JOIN LATERAL (
    SELECT g.soft_limit_value, g.hard_limit_value
    FROM compliance.rule_thresholds g
    WHERE g.rule_id = r.id AND g.entity_id IS NULL
      AND g.group_value IS NULL AND g.rank_from IS NULL AND g.rank_to IS NULL
      AND g.valid_from <= CURRENT_DATE AND g.valid_to >= CURRENT_DATE
    LIMIT 1
) rule_row ON TRUE
WHERE t.rule_id = r.id
  AND r.anchor_domain_code = 'FUND'
  AND v.id IS NOT NULL
  AND v.hard_limit_attribute_code IS NULL
  AND t.entity_id IS NOT NULL
  AND t.applies
  AND t.soft_limit_value IS NULL AND t.hard_limit_value IS NULL
  AND t.valid_to >= CURRENT_DATE
  AND COALESCE(rule_row.hard_limit_value, rule_row.soft_limit_value, v.hard_limit_value, v.soft_limit_value) IS NOT NULL;

-- 2. Copy rule-wide group and rank rows to the funds that now use the rule,
--    then close every rule-wide row.
INSERT INTO compliance.rule_thresholds (
    rule_id, entity_id, group_value, rank_from, rank_to, soft_limit_value, hard_limit_value,
    applies, limit_direction, notes, valid_from, valid_to
)
SELECT g.rule_id, f.entity_id, g.group_value, g.rank_from, g.rank_to, g.soft_limit_value, g.hard_limit_value,
       g.applies, g.limit_direction, 'Copied from the rule-wide limit when fund limits became the only limits.',
       g.valid_from, g.valid_to
FROM compliance.rule_thresholds g
JOIN compliance.rule_thresholds f
  ON f.rule_id = g.rule_id
 AND f.entity_id IS NOT NULL
 AND f.group_value IS NULL AND f.rank_from IS NULL AND f.rank_to IS NULL
 AND f.applies
 AND f.valid_to = DATE '9999-12-31'
WHERE g.entity_id IS NULL
  AND (g.group_value IS NOT NULL OR g.rank_from IS NOT NULL)
  AND g.valid_to = DATE '9999-12-31'
  AND NOT EXISTS (
      SELECT 1 FROM compliance.rule_thresholds x
      WHERE x.rule_id = g.rule_id AND x.entity_id = f.entity_id
        AND COALESCE(x.group_value, '') = COALESCE(g.group_value, '')
        AND COALESCE(x.rank_from, 0) = COALESCE(g.rank_from, 0)
        AND COALESCE(x.rank_to, 0) = COALESCE(g.rank_to, 0)
        AND x.valid_to = DATE '9999-12-31'
  );

UPDATE compliance.rule_thresholds
SET valid_to = GREATEST(valid_from, CURRENT_DATE - 1),
    notes = CONCAT_WS(' ', NULLIF(notes, ''), 'Retired: fund limits are the only limits.'),
    updated_at = NOW()
WHERE entity_id IS NULL
  AND valid_to >= CURRENT_DATE;

-- Retired rows stay for history; a new or changed row must name a fund.
ALTER TABLE compliance.rule_thresholds
    DROP CONSTRAINT IF EXISTS rule_thresholds_fund_only;
ALTER TABLE compliance.rule_thresholds
    ADD CONSTRAINT rule_thresholds_fund_only CHECK (entity_id IS NOT NULL) NOT VALID;

-- 3. Fund rules read only the fund's own rows.
-- Dropped first: a database built from every migration has a fifth column
-- (limit_direction) that no current caller reads and the hosted one lacks.
DROP FUNCTION IF EXISTS compliance.resolve_threshold(UUID, UUID, TEXT, BIGINT, DATE, NUMERIC, NUMERIC);
CREATE FUNCTION compliance.resolve_threshold(
    p_rule_id UUID,
    p_entity_id UUID,
    p_group TEXT,
    p_rank BIGINT,
    p_as_of DATE,
    p_fallback_soft NUMERIC,
    p_fallback_hard NUMERIC
) RETURNS TABLE (soft_limit NUMERIC, hard_limit NUMERIC, applies BOOLEAN, source TEXT)
LANGUAGE sql STABLE
AS $function$
    WITH rule AS (
        SELECT COALESCE(r.anchor_domain_code = 'FUND', FALSE) AS fund_rule,
               EXISTS (
                   SELECT 1 FROM compliance.rule_versions v
                   WHERE v.rule_id = p_rule_id AND v.is_active AND v.hard_limit_attribute_code IS NOT NULL
               ) AS fund_attribute
        FROM compliance.rules r
        WHERE r.id = p_rule_id
    ),
    candidate AS (
        SELECT t.soft_limit_value, t.hard_limit_value, t.applies, t.entity_id,
               t.group_value, t.rank_from
        FROM compliance.rule_thresholds t, rule
        WHERE t.rule_id = p_rule_id
          AND t.valid_from <= p_as_of AND t.valid_to >= p_as_of
          AND (t.entity_id = p_entity_id OR (t.entity_id IS NULL AND NOT rule.fund_rule))
          AND (t.group_value IS NULL OR t.group_value = p_group)
          AND (
                (t.rank_from IS NULL AND t.rank_to IS NULL)
                OR (
                    p_rank IS NOT NULL
                    AND t.rank_from IS NOT NULL
                    AND t.rank_from <= p_rank
                    AND (t.rank_to IS NULL OR p_rank <= t.rank_to)
                )
          )
    ),
    picked AS (
        SELECT c.*
        FROM candidate c
        ORDER BY
            CASE WHEN c.entity_id = p_entity_id THEN 0 ELSE 1 END,
            CASE WHEN c.group_value IS NOT NULL THEN 0 ELSE 1 END,
            CASE WHEN c.rank_from IS NOT NULL THEN 0 ELSE 1 END
        LIMIT 1
    )
    -- A row: its numbers. A blank fund row on a rule that reads a fund
    -- attribute uses that attribute (the caller's fallback).
    SELECT
        CASE WHEN rule.fund_rule AND rule.fund_attribute AND p.soft_limit_value IS NULL AND p.hard_limit_value IS NULL
             THEN p_fallback_soft ELSE p.soft_limit_value END,
        CASE WHEN rule.fund_rule AND rule.fund_attribute AND p.soft_limit_value IS NULL AND p.hard_limit_value IS NULL
             THEN p_fallback_hard ELSE p.hard_limit_value END,
        p.applies,
        CASE WHEN p.entity_id IS NULL THEN 'RULE' ELSE 'FUND' END
    FROM picked p, rule
    UNION ALL
    -- No row. A fund rule does not apply, except in a rule builder preview.
    -- Other rules keep the rule version's numbers.
    SELECT p_fallback_soft, p_fallback_hard,
           NOT rule.fund_rule OR COALESCE(current_setting('compliance.rule_preview', TRUE), '') = 'on',
           CASE WHEN rule.fund_rule THEN 'PREVIEW' ELSE 'VERSION' END
    FROM rule
    WHERE NOT EXISTS (SELECT 1 FROM picked);
$function$;

COMMENT ON FUNCTION compliance.resolve_threshold(UUID, UUID, TEXT, BIGINT, DATE, NUMERIC, NUMERIC) IS
    'The limit for one rule, fund, group and rank. A fund rule reads only the fund''s own rows: with none, it does not apply. A blank fund row uses the fund''s limit attribute when the rule has one. Rules on other records fall back to the rule version.';

GRANT EXECUTE ON FUNCTION compliance.resolve_threshold(UUID, UUID, TEXT, BIGINT, DATE, NUMERIC, NUMERIC) TO authenticated, service_role;

-- The rule builder's test run previews the rule's default limit on every fund.
CREATE OR REPLACE FUNCTION compliance.evaluate_rule_all_funds(
    p_rule_code character varying,
    p_as_of_date date,
    p_knowledge_date timestamp with time zone DEFAULT now(),
    p_source_scope character varying DEFAULT NULL,
    p_triggered_by uuid DEFAULT NULL,
    p_anchor_entity_id uuid DEFAULT NULL,
    p_scenario_code character varying DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'compliance', 'pg_temp'
AS $$
BEGIN
    PERFORM set_config('compliance.test_all_funds', 'on', TRUE);
    PERFORM set_config('compliance.rule_preview', 'on', TRUE);
    RETURN compliance.evaluate_rule(
        p_rule_code, p_as_of_date, p_knowledge_date, p_source_scope,
        p_triggered_by, p_anchor_entity_id, p_scenario_code
    );
END;
$$;

COMMENT ON FUNCTION compliance.evaluate_rule_all_funds IS
    'Runs evaluate_rule for every fund, including funds with no threshold, using the rule''s default limit. Used by the rule builder test button only.';

NOTIFY pgrst, 'reload schema';
