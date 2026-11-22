-- Brings the 2026-11-20 security migrations and master's later work together.
--
-- The security migrations (20261120100000 to 20261120130000) were written on a
-- branch cut before master's later migrations. Two things follow:
--
--   1. compliance.fund_security_capacities: the security migration added a
--      readable-ids check to the body it knew. Master has since replaced that
--      function (20261120213000) and then retired it (20261121130100), so it is
--      dropped here.
--
--   2. Grants: since 20261120101000_function_lockdown a new function outside
--      public is callable by nobody until a migration grants it. On the hosted
--      project master's functions already existed when the lockdown ran, and it
--      kept what signed-in users could do. A database built from scratch runs
--      master's later migrations after the lockdown, so their functions are
--      granted here, to match. score_deal_funds writes results for any funds it
--      is given, so only server code may call it.
--
-- Safe to run more than once.

-- 1. Master retires this function in 20261121130100_retire_old_capacity_path; the
--    app no longer calls it. It is dropped here as well, so the body before the
--    security migrations' readable-ids check is never left callable in between.
DROP FUNCTION IF EXISTS compliance.fund_security_capacities(UUID[], UUID[], DATE, TIMESTAMPTZ, VARCHAR);

-- ============================================================
-- Grants for master's functions created after the lockdown
-- ============================================================
DO $$
DECLARE
    f RECORD;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS signature,
               n.nspname || '.' || p.proname AS name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname || '.' || p.proname IN (
            -- Signed-in callers and server code.
            'compliance.evaluate_rule',
            'compliance.fund_security_capacities',
            'compliance.group_membership',
            'compliance.include_in_scenario',
            'compliance.text_values',
            'compliance.without_allocation_locks',
            'data_quality.compile_rule_clause',
            'golden_master.winning_attribute_values',
            'metadata_register.check_list_value_parent',
            'metadata_register.list_value_is_under',
            'tenancy.catalog_restricted',
            'tenancy.client_workflow_allowed',
            'tenancy.domain_in_scope',
            'tenancy.enabled_grant_codes',
            'tenancy.module_scope',
            'tenancy.set_client_modules',
            'tenancy.shared_workflow_visible',
            'public.get_attributes_with_aggregation',
            -- Server code only.
            'compliance.score_deal_funds'
        )
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.signature);
        IF f.name <> 'compliance.score_deal_funds' THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.signature);
        END IF;
    END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
