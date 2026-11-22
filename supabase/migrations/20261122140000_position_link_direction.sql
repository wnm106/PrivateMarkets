-- A position is the parent of its fund and its security links.
--
-- 00009_entity_relationships defines POSITION_FUND and POSITION_SECURITY with
-- the position as the parent, and every reader follows that: the fund and cash
-- reconciliations, the fund page, allocations, and the query tools (direction
-- UP from a position). A database whose rows had them the other way round
-- (fund or security as parent, one to many) made the loader write new links
-- reversed, so the readers did not see those positions: a fund loaded from a
-- filed report had no schedule of investments in its reconciliation.
--
-- This sets both rows to the definition the migrations give. On a database
-- built from them it changes nothing. Links already stored are not changed.

UPDATE metadata_register.relationship_types
SET parent_domain_code = 'POSITION', child_domain_code = 'FUND', cardinality = 'ONE_TO_ONE'
WHERE relationship_code = 'POSITION_FUND'
  AND (parent_domain_code, child_domain_code, cardinality) IS DISTINCT FROM ('POSITION', 'FUND', 'ONE_TO_ONE');

UPDATE metadata_register.relationship_types
SET parent_domain_code = 'POSITION', child_domain_code = 'SECURITY', cardinality = 'ONE_TO_ONE'
WHERE relationship_code = 'POSITION_SECURITY'
  AND (parent_domain_code, child_domain_code, cardinality) IS DISTINCT FROM ('POSITION', 'SECURITY', 'ONE_TO_ONE');
