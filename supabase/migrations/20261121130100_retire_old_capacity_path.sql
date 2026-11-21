-- Retire the capacity path that kept its own copy of the compliance rules.
--
-- 20261121130000 added compliance.deal_capacity_observations, which reads the
-- rule evaluator, and the app now calls it. Apply this only after the app built
-- from that change is deployed: the previous app calls
-- compliance.fund_security_capacities.

-- ============================================================
-- The old capacity path and its private interpreters
-- ============================================================

DROP FUNCTION IF EXISTS compliance.fund_security_capacities(UUID[], UUID[], DATE, TIMESTAMPTZ, VARCHAR);
DROP FUNCTION IF EXISTS compliance.composite_rule_capacity(UUID, UUID, compliance.rule_versions, NUMERIC, DATE, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS compliance.security_matches_filters(UUID, JSONB, DATE, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS compliance.proposed_security_matches(UUID, UUID, DATE, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS compliance.security_group_value(UUID, JSONB, CHARACTER VARYING, DATE, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS compliance.capacity_amount(NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT);

NOTIFY pgrst, 'reload schema';
