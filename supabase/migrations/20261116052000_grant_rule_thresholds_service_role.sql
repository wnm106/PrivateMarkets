-- The deal score reads thresholds with the service role. This table was
-- granted to authenticated only, so that read failed.

GRANT SELECT, INSERT, UPDATE, DELETE ON compliance.rule_thresholds TO service_role;
