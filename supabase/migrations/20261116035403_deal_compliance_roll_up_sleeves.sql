-- A proposed allocation is written on the sleeves. The portfolio row on the
-- deal surface is the parent, and it has no positions of its own. Roll the
-- sleeves into that parent so the portfolio the user selects has a score.
UPDATE compliance.rule_versions rv
SET consolidate_descendants = TRUE
FROM compliance.rules r
WHERE rv.rule_id = r.id
  AND r.rule_code IN (
    'PF_ISSUER_CONCENTRATION',
    'PF_SPONSOR_CONCENTRATION',
    'PF_UNFUNDED_COMMITMENTS'
  );
