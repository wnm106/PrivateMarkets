-- The fund page's share-of-book bars find their rules by metadata, not by
-- rule code (docs/GUARDRAILS.md rule 1). Tag the three rules it reads.
-- exposure_dimension: strategy, sector or issuer.

UPDATE compliance.rules r
SET metadata = COALESCE(r.metadata, '{}'::JSONB) || jsonb_build_object('exposure_dimension', v.dimension)
FROM (VALUES
    ('FUND_STRATEGY_BOOK_PCT', 'strategy'),
    ('FUND_SECTOR_BOOK_PCT', 'sector'),
    ('FUND_ISSUER_BOOK_PCT', 'issuer')
) AS v(code, dimension)
WHERE r.rule_code = v.code
  AND NOT (COALESCE(r.metadata, '{}'::JSONB) ? 'exposure_dimension');

COMMENT ON COLUMN compliance.rules.metadata IS
    'Rule settings. deal_surface (boolean): the deal surface scores this rule for every fund on a deal; a fund still needs its own threshold for the rule to apply. group_label (text): what one group of the result is called, such as Issuer. exposure_dimension (text: strategy, sector, issuer): the fund page shows this rule''s limits on that share-of-book bar.';
