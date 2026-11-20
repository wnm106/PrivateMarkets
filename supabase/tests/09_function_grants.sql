-- Function grants, checked over the whole catalog.
--
-- PostgREST exposes every function in the API schemas, so the grants are the
-- first wall. Since 20261120101000_function_lockdown.sql:
--   * no SECURITY DEFINER function in these schemas is executable by anon,
--     except the two workflow portal functions (the portal token is the check);
--   * no function this project owns in these schemas is executable by PUBLIC
--     (Postgres' default for a new function);
--   * every SECURITY DEFINER function pins its search_path.
-- See docs/MIGRATIONS.md, "Function grants".
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('09_function_grants');
SELECT tests.owner();

CREATE TEMP VIEW project_functions AS
SELECT p.oid,
       p.oid::regprocedure::text AS signature,
       n.nspname,
       p.prosecdef,
       p.proconfig,
       (p.proacl IS NULL OR EXISTS (
            SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       )) AS public_can_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN (
        -- the schemas supabase/config.toml exposes through the API ...
        'public', 'metadata_register', 'entity_instances', 'golden_master',
        'data_quality', 'compliance', 'read_projections', 'tenancy',
        -- ... and the project's own schemas that 20261120101000 also locked down
        'ops', 'docs', 'reporting')
  AND p.prokind IN ('f', 'p')
  -- functions that belong to an extension are the extension's business
  AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');

SELECT tests.check('The sweep sees the project''s functions',
    (SELECT count(*) FROM project_functions WHERE prosecdef) > 100,
    (SELECT count(*) FROM project_functions WHERE prosecdef)::text || ' SECURITY DEFINER functions found');

DO $$
DECLARE
    r record;
    n int := 0;
BEGIN
    FOR r IN
        SELECT signature FROM project_functions
        WHERE prosecdef AND anon_can_execute
          AND signature NOT IN ('workflow_portal_get(text)', 'workflow_portal_submit(text,text,jsonb,text)')
        ORDER BY signature
    LOOP
        n := n + 1;
        PERFORM tests.fail('SECURITY DEFINER function executable by anon: ' || r.signature, 'revoke it from anon (and PUBLIC)');
    END LOOP;
    IF n = 0 THEN
        PERFORM tests.pass('No SECURITY DEFINER function is executable by anon except workflow_portal_get/submit');
    END IF;

    n := 0;
    FOR r IN SELECT signature FROM project_functions WHERE public_can_execute ORDER BY signature LOOP
        n := n + 1;
        PERFORM tests.fail('Function executable by PUBLIC: ' || r.signature, 'REVOKE EXECUTE ... FROM PUBLIC, anon');
    END LOOP;
    IF n = 0 THEN
        PERFORM tests.pass('No project function is executable by PUBLIC');
    END IF;

    n := 0;
    FOR r IN
        SELECT signature FROM project_functions
        WHERE anon_can_execute AND NOT prosecdef
        ORDER BY signature
    LOOP
        n := n + 1;
        PERFORM tests.fail('Function executable by anon: ' || r.signature, 'only the workflow portal functions are meant for anon');
    END LOOP;
    IF n = 0 THEN
        PERFORM tests.pass('No other function is executable by anon either');
    END IF;

    n := 0;
    FOR r IN
        SELECT signature FROM project_functions
        WHERE prosecdef
          AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(proconfig, '{}')) c WHERE c LIKE 'search_path=%')
        ORDER BY signature
    LOOP
        n := n + 1;
        PERFORM tests.fail('SECURITY DEFINER function without a fixed search_path: ' || r.signature, 'add SET search_path');
    END LOOP;
    IF n = 0 THEN
        PERFORM tests.pass('Every SECURITY DEFINER function fixes its search_path');
    END IF;
END $$;

SELECT tests.check('The workflow portal functions are still open to anon',
    has_function_privilege('anon', 'public.workflow_portal_get(text)', 'EXECUTE')
    AND has_function_privilege('anon', 'public.workflow_portal_submit(text,text,jsonb,text)', 'EXECUTE'));

-- New functions start closed: a function created now gets no PUBLIC or anon grant.
CREATE FUNCTION public.zz_grant_probe() RETURNS int LANGUAGE sql AS 'SELECT 1';
CREATE FUNCTION ops.zz_grant_probe() RETURNS int LANGUAGE sql AS 'SELECT 1';
SELECT tests.check('A new function in public is not executable by anon',
    NOT has_function_privilege('anon', 'public.zz_grant_probe()', 'EXECUTE'));
SELECT tests.check('A new function in public is not executable by PUBLIC',
    NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = 'public.zz_grant_probe()'::regprocedure AND a.grantee = 0));
SELECT tests.check('A new function outside public is executable by no API role until granted',
    NOT has_function_privilege('authenticated', 'ops.zz_grant_probe()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'ops.zz_grant_probe()', 'EXECUTE'));

SELECT tests.done();
ROLLBACK;
