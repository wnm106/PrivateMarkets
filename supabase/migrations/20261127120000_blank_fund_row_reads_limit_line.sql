-- A blank fund row reads the fund's limit from the rule's limit line.
--
-- A fund rule runs for a fund only when the fund has its own rule_thresholds row
-- (fund_threshold_enrollment). A row with no numbers is meant to enroll the fund
-- at its own limit: resolve_threshold then returns the caller's fallback, which
-- the evaluator has already read from the fund's data. It did that only for a
-- version with hard_limit_attribute_code. A version whose limit comes from a
-- LIMIT measure line (the CLO rules read each deal's indenture caps and note
-- class triggers that way) got blank numbers back instead, so the fund was
-- scored with no limit and every test came back NO_DATA.
--
-- The check now counts a LIMIT measure line, or a limit_term in the version's
-- metadata (the single-obligor cap reads it), as the fund's limit attribute.
-- A row with numbers still overrides the fund's data, and a rule with neither
-- keeps the row's numbers, as before. No enrolled row on the hosted project
-- changes result: none is blank on a rule with a limit line.

CREATE OR REPLACE FUNCTION compliance.resolve_threshold(
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
               ) OR EXISTS (
                   SELECT 1 FROM compliance.rule_versions v
                   WHERE v.rule_id = p_rule_id AND v.is_active
                     AND (v.metadata ? 'limit_term'
                          OR EXISTS (SELECT 1 FROM compliance.rule_measure_lines ml
                                     WHERE ml.rule_version_id = v.id AND ml.side = 'LIMIT'))
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
    'The limit for one rule, fund, group and rank. A fund rule reads only the fund''s own rows: with none, it does not apply. A blank fund row uses the fund''s limit attribute or limit line when the rule has one. Rules on other records fall back to the rule version.';

GRANT EXECUTE ON FUNCTION compliance.resolve_threshold(UUID, UUID, TEXT, BIGINT, DATE, NUMERIC, NUMERIC) TO authenticated, service_role;
