-- SECURITY DEFINER functions that took a record or client id on trust, the
-- formula functions that ran caller SQL as the owner, and the debug functions
-- open to anon. Each must refuse a caller from another client (or no login),
-- and still work for the owning client and for server code.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('03_functions');

-- ---------------------------------------------------------------- T2 formula functions
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_error('T2 A analyst cannot run SQL through evaluate_custom_formula',
    $$SELECT metadata_register.evaluate_custom_formula(gen_random_uuid(),
        'SELECT jsonb_build_object(''n'', (SELECT count(*) FROM entity_instances.master_entities), ''emails'', (SELECT jsonb_agg(email) FROM auth.users))',
        CURRENT_DATE)$$, '42501');
SELECT tests.expect_error('T2 A analyst cannot run SQL through evaluate_simple_formula',
    $$SELECT metadata_register.evaluate_simple_formula(gen_random_uuid(), 'SELECT count(*) FROM golden_master.entity_attribute_values', CURRENT_DATE)$$, '42501');
SELECT tests.expect_error('T2 A analyst cannot run SQL through evaluate_aggregate_formula',
    $$SELECT metadata_register.evaluate_aggregate_formula(gen_random_uuid(), 'SELECT 1', CURRENT_DATE)$$, '42501');
SELECT tests.expect_error('T2 A analyst cannot run SQL through evaluate_lookup_formula',
    $$SELECT metadata_register.evaluate_lookup_formula(gen_random_uuid(), 'SELECT 1', CURRENT_DATE)$$, '42501');
-- T14: the same primitive was a way to read another client's feed credentials.
SELECT tests.expect_error('T14 A analyst cannot read vault secrets through a formula',
    $$SELECT metadata_register.evaluate_custom_formula(gen_random_uuid(),
        'SELECT jsonb_agg(s.decrypted_secret) FROM ops.connections c JOIN vault.decrypted_secrets s ON s.id = c.secret_id', CURRENT_DATE)$$);
SELECT tests.owner();
SELECT tests.expect_value('T2/T14 the formula functions run as the caller now',
    $$SELECT bool_or(p.prosecdef)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'metadata_register'
        AND p.proname IN ('evaluate_simple_formula', 'evaluate_custom_formula', 'evaluate_aggregate_formula', 'evaluate_lookup_formula')$$, 'false');

-- ---------------------------------------------------------------- T3 debug functions are gone
SELECT tests.check('T3a public.check_client_setup() is dropped', to_regprocedure('public.check_client_setup()') IS NULL);
SELECT tests.check('T3b public.check_entity_master_view() is dropped', to_regprocedure('public.check_entity_master_view()') IS NULL);
SELECT tests.check('T3f public.get_current_user_role() is dropped', to_regprocedure('public.get_current_user_role()') IS NULL);
SELECT tests.check('T3f public.check_user_role(text) is dropped', to_regprocedure('public.check_user_role(text)') IS NULL);

-- ---------------------------------------------------------------- T3 anon on record functions
SELECT tests.anon();
SELECT tests.expect_error('T3c anon cannot read B-FUND-1 values (on_read_attribute_values)',
    $$SELECT * FROM public.on_read_attribute_values('bbbbbbbb-0000-0000-0000-0000000000f1', DATE '2026-09-30')$$, '42501');
SELECT tests.expect_error('T3c anon cannot explain a B calculation',
    $$SELECT public.explain_calc('bbbbbbbb-0000-0000-0000-0000000000f1', 'NAV', DATE '2026-09-30')$$, '42501');
SELECT tests.expect_error('T3c anon cannot list B calculation states',
    $$SELECT * FROM public.calculated_attribute_states('bbbbbbbb-0000-0000-0000-0000000000f1')$$, '42501');
SELECT tests.expect_error('T3d anon cannot change the NAV attribute aggregation',
    $$SELECT public.update_attribute_aggregation((SELECT id FROM tests.ids WHERE name = 'NAV'), 'MAX', NULL, 0)$$, '42501');
SELECT tests.expect_error('T3e anon cannot close narrative runs',
    $$SELECT public.close_stale_narrative_runs(0)$$, '42501');
SELECT tests.expect_error('T13 anon cannot read B load batch quality',
    $$SELECT public.load_batch_quality('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001')$$, '42501');
SELECT tests.expect_error('T13 anon cannot revert a B load batch',
    $$SELECT public.load_batch_revert('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', NULL)$$, '42501');
SELECT tests.owner();
SELECT tests.expect_rows('T3e/T13 nothing of client B changed',
    $$SELECT 1 FROM public.narrative_runs WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000c3' AND status = 'RUNNING'
      UNION ALL
      SELECT 1 FROM entity_instances.load_batches WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000b1' AND status = 'PROMOTED'$$, 2);

-- ---------------------------------------------------------------- A analyst against B records
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_denied('A analyst reads no B values (on_read_attribute_values)',
    $$SELECT * FROM public.on_read_attribute_values('bbbbbbbb-0000-0000-0000-0000000000f1')$$);
SELECT tests.expect_denied('A analyst cannot explain a B calculation',
    $$SELECT public.explain_calc('bbbbbbbb-0000-0000-0000-0000000000f1', 'NAV') WHERE public.explain_calc('bbbbbbbb-0000-0000-0000-0000000000f1', 'NAV') IS NOT NULL$$);
SELECT tests.expect_denied('A analyst lists no B calculation state',
    $$SELECT * FROM public.calculated_attribute_states('bbbbbbbb-0000-0000-0000-0000000000f1')$$);
SELECT tests.expect_error('A analyst cannot process B calculations',
    $$SELECT public.process_entity_calculated_attributes('bbbbbbbb-0000-0000-0000-0000000000f1', 5)$$, '42501');
SELECT tests.expect_error('A analyst cannot process the whole calculation queue',
    $$SELECT public.process_calculated_attributes(5)$$, '42501');
SELECT tests.expect_error('A analyst cannot revert a B load batch',
    $$SELECT public.load_batch_revert('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', NULL)$$);
SELECT tests.expect_error('A analyst cannot read B load batch quality',
    $$SELECT public.load_batch_quality('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001')$$);
SELECT tests.expect_error('A analyst cannot walk the ancestors of a B record',
    $$SELECT * FROM tenancy.entity_ancestors('bbbbbbbb-0000-0000-0000-0000000000f1')$$, '42501');
SELECT tests.expect_denied('A analyst cannot change the shared NAV attribute precision',
    $$SELECT 1 FROM (SELECT public.update_attribute_aggregation((SELECT id FROM tests.ids WHERE name = 'NAV'), 'SUM', NULL, 9) AS r) s
      WHERE (SELECT numeric_precision FROM metadata_register.attribute_register WHERE attribute_code = 'NAV') IS NOT DISTINCT FROM 9$$);
SELECT tests.owner();
UPDATE public.narrative_runs SET updated_at = now() - interval '1 hour' WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000c3';
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('T3e A analyst closes no B narrative run, even one stale for an hour',
    $$SELECT public.close_stale_narrative_runs(30)$$, '0');
SELECT tests.owner();
SELECT tests.expect_value('B narrative run is still RUNNING',
    $$SELECT status FROM public.narrative_runs WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000c3'$$, 'RUNNING');
SELECT tests.expect_value('NAV precision is unchanged',
    $$SELECT (numeric_precision IS DISTINCT FROM 9)::text FROM metadata_register.attribute_register WHERE attribute_code = 'NAV'$$, 'true');
SELECT tests.expect_rows('B load batch values were not retired',
    $$SELECT 1 FROM golden_master.entity_attribute_values
      WHERE load_batch_id = 'bbbbbbbb-0000-0000-0000-0000000000b1' AND system_to < '9999-12-31'$$, 0);

-- ---------------------------------------------------------------- B analyst on its own records
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_ok('B analyst reads B-FUND-1 values',
    $$SELECT * FROM public.on_read_attribute_values('bbbbbbbb-0000-0000-0000-0000000000f1')$$);
SELECT tests.expect_ok('B analyst lists B-FUND-1 calculation states',
    $$SELECT * FROM public.calculated_attribute_states('bbbbbbbb-0000-0000-0000-0000000000f1')$$);
SELECT tests.expect_ok('B analyst processes B-FUND-1 calculations',
    $$SELECT public.process_entity_calculated_attributes('bbbbbbbb-0000-0000-0000-0000000000f1', 5)$$);
SELECT tests.expect_ok('B analyst explains a B-FUND-1 value',
    $$SELECT public.explain_calc('bbbbbbbb-0000-0000-0000-0000000000f1', 'NAV')$$);
SELECT tests.owner();
UPDATE public.narrative_runs SET updated_at = now() - interval '5 minutes' WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000c3';
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('B analyst cannot fail a run that moved 5 minutes ago (window is at least 15)',
    $$SELECT public.close_stale_narrative_runs(0)$$, '0');
SELECT tests.owner();
UPDATE public.narrative_runs SET updated_at = now() - interval '1 hour' WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000c3';
SELECT tests.login('b0000000-0000-0000-0000-00000000000a');
SELECT tests.expect_value('B analyst closes its own run that has been stale for an hour',
    $$SELECT public.close_stale_narrative_runs(30)$$, '1');

-- ---------------------------------------------------------------- server code
SELECT tests.service();
SELECT tests.expect_ok('Service role processes the calculation queue',
    $$SELECT public.process_calculated_attributes(5)$$);
SELECT tests.expect_ok('Service role reads B-FUND-1 values',
    $$SELECT * FROM public.on_read_attribute_values('bbbbbbbb-0000-0000-0000-0000000000f1')$$);
SELECT tests.expect_ok('Service role reads B load batch quality',
    $$SELECT public.load_batch_quality('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001')$$);

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
