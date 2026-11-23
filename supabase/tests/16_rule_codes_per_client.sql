-- Compliance rule codes are unique within a client, and a code is always read
-- in one client: shared rules, plus that client's own.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('16_rule_codes_per_client');

SELECT tests.owner();
INSERT INTO compliance.rules (id, rule_code, rule_name, anchor_domain_code, client_id) VALUES
    ('cccccccc-0000-0000-0000-0000000000a1', 'TEST_LEVERAGE', 'Alpha leverage', 'FUND', 'aaaaaaaa-0000-0000-0000-000000000001'),
    ('cccccccc-0000-0000-0000-0000000000b1', 'TEST_LEVERAGE', 'Bravo leverage', 'FUND', 'bbbbbbbb-0000-0000-0000-000000000001'),
    ('cccccccc-0000-0000-0000-0000000000c1', 'TEST_SHARED_CAP', 'Shared cap', 'FUND', NULL);

SELECT tests.check('Two clients can each have a rule with one code',
    (SELECT count(*) FROM compliance.rules WHERE rule_code = 'TEST_LEVERAGE') = 2);
SELECT tests.expect_error('One client cannot use a code twice',
    $$INSERT INTO compliance.rules (rule_code, rule_name, anchor_domain_code, client_id)
      VALUES ('TEST_LEVERAGE', 'again', 'FUND', 'aaaaaaaa-0000-0000-0000-000000000001')$$, '23505');
SELECT tests.expect_error('A client rule cannot take a shared rule''s code',
    $$INSERT INTO compliance.rules (rule_code, rule_name, anchor_domain_code, client_id)
      VALUES ('TEST_SHARED_CAP', 'shadow', 'FUND', 'aaaaaaaa-0000-0000-0000-000000000001')$$, '23505');
SELECT tests.expect_error('A shared rule cannot take a code a client uses',
    $$INSERT INTO compliance.rules (rule_code, rule_name, anchor_domain_code, client_id)
      VALUES ('TEST_LEVERAGE', 'shared shadow', 'FUND', NULL)$$, '23505');

SELECT tests.expect_value('A code read for a client A fund names client A''s rule',
    $$SELECT compliance.rule_id_for_code('TEST_LEVERAGE', 'aaaaaaaa-0000-0000-0000-000000000001')::text$$, 'cccccccc-0000-0000-0000-0000000000a1');
SELECT tests.expect_value('A shared rule is found from any client',
    $$SELECT compliance.rule_id_for_code('TEST_SHARED_CAP', 'bbbbbbbb-0000-0000-0000-000000000001')::text$$, 'cccccccc-0000-0000-0000-0000000000c1');
SELECT tests.service();
SELECT tests.expect_error('Server code naming no client is refused for a code two clients use',
    $$SELECT compliance.rule_id_for_code('TEST_LEVERAGE', NULL)$$, '21000');

SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('A client B analyst reading the code gets client B''s rule',
    $$SELECT compliance.rule_id_for_code('TEST_LEVERAGE', NULL)::text$$, 'cccccccc-0000-0000-0000-0000000000b1');

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
