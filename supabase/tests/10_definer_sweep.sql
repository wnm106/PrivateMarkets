-- Every SECURITY DEFINER function a signed-in user can call, called by the
-- client A analyst with client B's ids: B's client, its analyst, B-FUND-1.
-- Whatever comes back must hold nothing of client B's that A was not given:
-- no B record name, no B value, no other B id, no B user, no B secret.
--
-- Each call runs in a subtransaction that is always rolled back, so one call
-- cannot change what the next one sees. Functions with polymorphic arguments
-- are skipped (no value can be built for them), and counted.
\set ON_ERROR_STOP on
BEGIN;
SELECT tests.begin('10_definer_sweep');
SET LOCAL statement_timeout = '10min';
SELECT tests.login('a0000000-0000-0000-0000-00000000000a');

DO $sweep$
DECLARE
    f record;
    v_args text;
    v_sql text;
    v_out text;
    v_state text;
    v_msg text;
    v_marker text;
    v_called int := 0;
    v_refused int := 0;
    v_skipped int := 0;
    v_leaks int := 0;
    -- B ids never passed as arguments, B names, values, users and secret.
    v_markers text[] := ARRAY[
        'Bravo ', '987654', 'CLIENT_B', 'Client B', '@b.test', 's3cr3t',
        'bbbbbbbb-0000-0000-0000-0000000000f2', 'bbbbbbbb-0000-0000-0000-0000000000a1',
        'bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-0000000000c',
        'bbbbbbbb-0000-0000-0000-0000000000d1', 'bbbbbbbb-0000-0000-0000-0000000000e1',
        'b0000000-0000-0000-0000-00000000000b', 'b0000000-0000-0000-0000-00000000000c'];
BEGIN
    FOR f IN
        SELECT p.oid, n.nspname, p.proname, p.oid::regprocedure::text AS signature, p.proretset,
               p.prorettype, p.pronargs, p.pronargdefaults, p.proargnames,
               p.proargtypes::oid[] AS argtypes, p.proallargtypes, p.proargmodes
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosecdef AND p.prokind = 'f'
          AND n.nspname IN ('public', 'metadata_register', 'entity_instances', 'golden_master',
                            'data_quality', 'compliance', 'read_projections', 'tenancy')
          AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
        ORDER BY 4
    LOOP
        IF EXISTS (SELECT 1 FROM unnest(f.argtypes::oid[]) t
                   WHERE t IN ('anyelement'::regtype, 'anyarray'::regtype, 'anynonarray'::regtype,
                               'anyenum'::regtype, 'anyrange'::regtype, 'anycompatible'::regtype,
                               'anycompatiblearray'::regtype, 'internal'::regtype)) THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;

        -- Required arguments positionally; uuid arguments with a default are
        -- passed by name too, since "which client / which record" is the attack.
        SELECT string_agg(
                 CASE WHEN a.i > f.pronargs - f.pronargdefaults THEN quote_ident(a.name) || ' => ' ELSE '' END ||
                 CASE
                   WHEN a.t = 'uuid'::regtype AND a.name ~* 'client' THEN '''bbbbbbbb-0000-0000-0000-000000000001''::uuid'
                   WHEN a.t = 'uuid'::regtype AND a.name ~* 'user|person|owner|member|_by$' THEN '''b0000000-0000-0000-0000-00000000000a''::uuid'
                   WHEN a.t = 'uuid'::regtype THEN '''bbbbbbbb-0000-0000-0000-0000000000f1''::uuid'
                   WHEN a.t = 'uuid[]'::regtype AND a.name ~* 'client' THEN 'ARRAY[''bbbbbbbb-0000-0000-0000-000000000001'']::uuid[]'
                   WHEN a.t = 'uuid[]'::regtype THEN 'ARRAY[''bbbbbbbb-0000-0000-0000-0000000000f1'']::uuid[]'
                   WHEN a.t = 'date'::regtype THEN 'DATE ''2026-09-30'''
                   WHEN a.t IN ('timestamptz'::regtype, 'timestamp'::regtype) THEN 'now()'
                   WHEN a.t IN ('int2'::regtype, 'int4'::regtype, 'int8'::regtype) THEN '10'
                   WHEN a.t = 'numeric'::regtype THEN '1'
                   WHEN a.t = 'bool'::regtype THEN 'false'
                   WHEN a.t = 'jsonb'::regtype THEN '''{}''::jsonb'
                   WHEN a.t = 'json'::regtype THEN '''{}''::json'
                   WHEN a.t IN ('text'::regtype, 'varchar'::regtype) AND a.name ~* 'domain' THEN '''FUND'''
                   WHEN a.t IN ('text'::regtype, 'varchar'::regtype) AND a.name ~* 'rule_code' THEN '''FUND_FAMILY_NAV_CAP'''
                   WHEN a.t = 'text[]'::regtype AND a.name ~* 'rule_code' THEN 'ARRAY[''FUND_FAMILY_NAV_CAP'']'
                   WHEN a.t IN ('text'::regtype, 'varchar'::regtype) AND a.name ~* 'code' THEN '''B-FUND-1'''
                   WHEN a.t IN ('text'::regtype, 'varchar'::regtype) AND a.name ~* 'search|query|term|name|text|q$' THEN '''Brav'''
                   ELSE 'NULL::' || format_type(a.t, NULL)
                 END,
                 ', ' ORDER BY a.i)
        INTO v_args
        FROM (
            -- The input arguments in order. proargtypes (input types only) is
            -- zero-based; proargnames and proargmodes also list OUT arguments.
            SELECT row_number() OVER (ORDER BY x.ord) AS i, x.name, x.t
            FROM (
                SELECT ord,
                       COALESCE(f.proargmodes[ord], 'i') AS mode,
                       f.proargnames[ord] AS name,
                       CASE WHEN f.proallargtypes IS NULL THEN f.argtypes[ord - 1] ELSE f.proallargtypes[ord] END AS t
                FROM generate_series(1, COALESCE(array_length(f.proallargtypes, 1), f.pronargs)) AS ord
            ) x
            WHERE x.mode IN ('i', 'b', 'v')
        ) a
        WHERE a.i <= f.pronargs - f.pronargdefaults
           OR (a.name IS NOT NULL AND a.name <> '' AND a.t IN ('uuid'::regtype, 'uuid[]'::regtype));

        IF f.proretset THEN
            v_sql := format('SELECT string_agg(x::text, E''\n'') FROM (SELECT * FROM %I.%I(%s) LIMIT 50) x',
                            f.nspname, f.proname, COALESCE(v_args, ''));
        ELSIF f.prorettype = 'void'::regtype THEN
            v_sql := format('SELECT %I.%I(%s)::text', f.nspname, f.proname, COALESCE(v_args, ''));
        ELSE
            v_sql := format('SELECT (%I.%I(%s))::text', f.nspname, f.proname, COALESCE(v_args, ''));
        END IF;

        v_out := NULL;
        v_state := NULL;
        BEGIN
            EXECUTE v_sql INTO v_out;
            -- Undo whatever the call wrote.
            RAISE EXCEPTION USING ERRCODE = 'TSWEP';
        EXCEPTION
            WHEN SQLSTATE 'TSWEP' THEN NULL;
            WHEN OTHERS THEN
                GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        END;

        IF v_state IS NOT NULL THEN
            v_refused := v_refused + 1;
            -- An error message can leak too ("Bravo Fund One is locked").
            v_out := v_msg;
        ELSE
            v_called := v_called + 1;
        END IF;

        FOREACH v_marker IN ARRAY v_markers LOOP
            IF v_out ILIKE '%' || v_marker || '%' THEN
                v_leaks := v_leaks + 1;
                PERFORM tests.fail('client B data from ' || f.signature,
                    format('found "%s" in %s', v_marker, left(v_out, 300)));
                EXIT;
            END IF;
        END LOOP;
    END LOOP;

    PERFORM tests.check(format('Definer sweep: %s functions returned, %s refused, %s skipped (polymorphic)',
                               v_called, v_refused, v_skipped),
                        v_called + v_refused > 100);
    IF v_leaks = 0 THEN
        PERFORM tests.pass('No SECURITY DEFINER function returned client B data to the client A analyst');
    END IF;
END
$sweep$;

SELECT tests.owner();
SELECT tests.done();
ROLLBACK;
