-- The compliance engine runs as SECURITY DEFINER. A caller of one client must
-- not score, read capacities or contributors for, or file audit entries
-- against another client's fund or order; the owning client and server code
-- keep working.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('04_compliance');

SELECT tests.owner();
CREATE TEMP TABLE b_result ON COMMIT DROP AS
SELECT r.id FROM compliance.rule_evaluation_results r
WHERE r.anchor_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1'
LIMIT 1;
GRANT SELECT ON b_result TO authenticated;
SELECT tests.check('fixture has a B result to aim at', (SELECT count(*) FROM b_result) = 1);

-- ---------------------------------------------------------------- T4b-T4e A analyst against client B
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_denied('T4b A analyst gets no pro-forma snapshot of B-FUND-1',
    $$SELECT * FROM compliance.proforma_snapshot('bbbbbbbb-0000-0000-0000-0000000000f1', '[]'::jsonb, DATE '2026-09-30')$$);
SELECT tests.expect_denied('T4b A analyst gets no security test metrics anchored on B-FUND-1',
    $$SELECT * FROM compliance.security_test_metrics(NULL, DATE '2026-09-30', now(), NULL, NULL, 'bbbbbbbb-0000-0000-0000-0000000000f1', NULL)$$);
SELECT tests.expect_denied('T4b A analyst gets no capacities for B-FUND-1',
    $$SELECT * FROM compliance.fund_security_capacities(ARRAY['bbbbbbbb-0000-0000-0000-0000000000f1']::uuid[], ARRAY['bbbbbbbb-0000-0000-0000-0000000000a1']::uuid[], DATE '2026-09-30')$$);
SELECT tests.expect_denied('T4c A analyst cannot score B-FUND-1',
    $$SELECT 1 FROM (SELECT compliance.evaluate_rule('FUND_FAMILY_NAV_CAP', DATE '2026-09-30', now(), NULL, auth.uid(), 'bbbbbbbb-0000-0000-0000-0000000000f1') AS run_id) s
      JOIN compliance.rule_evaluation_results r ON r.run_id = s.run_id
      WHERE r.anchor_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1'$$);
SELECT tests.expect_error('T4d A analyst cannot file an audit entry against a B order',
    $$SELECT compliance.record_order_audit('bbbbbbbb-0000-0000-0000-0000000000a1', NULL, 'CANCEL', '{"forged":true}'::jsonb,
        'b0000000-0000-0000-0000-00000000000c', 'PASS', now())$$);
SELECT tests.expect_denied('T4e A analyst reads no contributors of a B result',
    $$SELECT * FROM compliance.measure_line_contributors((SELECT id FROM b_result))$$);
SELECT tests.expect_error('T4 A analyst cannot run the anchor lookup directly',
    $$SELECT * FROM compliance.get_anchor_entities((SELECT id FROM compliance.rules WHERE rule_code = 'FUND_FAMILY_NAV_CAP'), DATE '2026-09-30', now())$$, '42501');

SELECT tests.owner();
SELECT tests.expect_rows('T4c no result for B-FUND-1 was written by client A',
    $$SELECT 1 FROM compliance.rule_evaluation_results r JOIN compliance.rule_evaluation_runs run ON run.id = r.run_id
      WHERE r.anchor_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1' AND run.triggered_by = 'a0000000-0000-0000-0000-00000000000a'$$, 0);
SELECT tests.expect_rows('T4d no audit entry was filed by client A',
    $$SELECT 1 FROM compliance.compliance_audit_log WHERE order_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000a1' AND action = 'CANCEL'$$, 0);

-- A run started by client A covers only client A's funds.
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_ok('A analyst scores the shared NAV rule for its own funds',
    $$SELECT compliance.evaluate_rule('FUND_FAMILY_NAV_CAP', DATE '2026-09-30', now(), NULL, auth.uid(), NULL)$$);
SELECT tests.owner();
SELECT tests.expect_rows('A run scored no fund outside client A',
    $$SELECT 1 FROM compliance.rule_evaluation_results r
      JOIN compliance.rule_evaluation_runs run ON run.id = r.run_id
      JOIN entity_instances.master_entities me ON me.id = r.anchor_entity_id
      WHERE run.triggered_by = 'a0000000-0000-0000-0000-00000000000a'
        AND me.client_id <> 'aaaaaaaa-0000-0000-0000-000000000001'$$, 0);

-- ---------------------------------------------------------------- client B on its own fund
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_ok('B analyst scores its own fund',
    $$SELECT compliance.evaluate_rule('FUND_FAMILY_NAV_CAP', CURRENT_DATE, now(), NULL, auth.uid(), 'bbbbbbbb-0000-0000-0000-0000000000f1')$$);
SELECT tests.expect_rows('B analyst reads the result of its own run',
    $$SELECT 1 FROM compliance.rule_evaluation_results r JOIN compliance.rule_evaluation_runs run ON run.id = r.run_id
      WHERE run.triggered_by = auth.uid() AND r.anchor_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1'$$, 1);
SELECT tests.expect_ok('B analyst gets a pro-forma snapshot of its fund',
    $$SELECT * FROM compliance.proforma_snapshot('bbbbbbbb-0000-0000-0000-0000000000f1', '[]'::jsonb, DATE '2026-09-30')$$);
SELECT tests.expect_ok('B analyst reads contributors of its own result',
    $$SELECT * FROM compliance.measure_line_contributors((SELECT id FROM b_result))$$);

-- ---------------------------------------------------------------- server code
SELECT tests.service();
SELECT tests.expect_ok('Service role scores B-FUND-1',
    $$SELECT compliance.evaluate_rule('FUND_FAMILY_NAV_CAP', DATE '2026-09-30', now(), NULL, NULL, 'bbbbbbbb-0000-0000-0000-0000000000f1')$$);
SELECT tests.expect_ok('Service role files an audit entry for a B order',
    $$SELECT compliance.record_order_audit('bbbbbbbb-0000-0000-0000-0000000000a1', NULL, 'MODIFY', '{}'::jsonb,
        'b0000000-0000-0000-0000-00000000000b', 'PASS', now())$$);

-- ---------------------------------------------------------------- rule versions (20261120130000, SECURITY INVOKER)
SELECT tests.owner();
CREATE TEMP TABLE b_rule ON COMMIT DROP AS
SELECT id FROM compliance.rules WHERE rule_code = 'B_PRIVATE_RULE';
GRANT SELECT ON b_rule TO authenticated;
SELECT tests.login('a0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_error('A admin cannot add a version to client B''s rule',
    $$SELECT compliance.create_rule_version((SELECT id FROM b_rule),
        '{"valid_from":"2026-01-01","rule_name":"pwned","base_domain_code":"FUND","numerator_attribute_code":"NAV","numerator_aggregation":"SUM"}'::jsonb)$$);
SELECT tests.anon();
SELECT tests.expect_error('anon cannot add a rule version',
    $$SELECT compliance.create_rule_version('00000000-0000-0000-0000-000000000000', '{}'::jsonb)$$, '42501');
SELECT tests.owner();
SELECT tests.expect_rows('Client B''s rule has no version written by client A',
    $$SELECT 1 FROM compliance.rule_versions WHERE rule_id = (SELECT id FROM b_rule)$$, 0);

-- ---------------------------------------------------------------- the audit log is append-only
SELECT tests.login('b0000000-0000-0000-0000-00000000000c');
SELECT tests.expect_denied('B admin cannot rewrite an audit entry',
    $$UPDATE compliance.compliance_audit_log SET snapshot = '{}'::jsonb WHERE order_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000a1' RETURNING 1$$);
SELECT tests.expect_denied('B admin cannot delete an audit entry',
    $$DELETE FROM compliance.compliance_audit_log WHERE order_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000a1' RETURNING 1$$);

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
