-- Scope the CLO rules to CLO funds without depending on FUND_STRUCTURE.
--
-- 20261106120000 limited the rules to funds whose FUND_STRUCTURE is 'CLO'.
-- That attribute is defined by an earlier surface migration that the cloud
-- database does not have, so no fund could ever match. A fund is a CLO when it
-- has a CLO transaction with a closing date. That uses only the CLO model.

DELETE FROM compliance.rule_conditions c
USING compliance.rule_versions rv
JOIN compliance.rules r ON r.id = rv.rule_id
WHERE c.rule_version_id = rv.id
  AND r.rule_code LIKE 'CLO\_%'
  AND rv.version_number = 1
  AND c.applies_to = 'ANCHOR';

INSERT INTO compliance.rule_conditions (
    rule_version_id, applies_to, condition_group, condition_order, attribute_code, operator, value, logic_operator, attribute_dimension
)
SELECT rv.id, 'ANCHOR', 1, 1, 'CLO_CLOSING_DATE', 'is_not_null', NULL, 'AND',
       '{"relationship_path":[{"relationship_code":"FUND_CLO_TRANSACTION","direction":"DOWN","recursive":false}]}'::jsonb
FROM compliance.rule_versions rv
JOIN compliance.rules r ON r.id = rv.rule_id AND rv.version_number = 1
WHERE r.rule_code LIKE 'CLO\_%';

NOTIFY pgrst, 'reload schema';
