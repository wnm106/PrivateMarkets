-- Two-tenant fixture for the database tests.
--
-- Runs once, after the migrations and supabase/seed/001_seed_data.sql, as the
-- database owner (postgres). It commits: the tests themselves each run in a
-- transaction that rolls back, so they all start from this state.
--
-- Clients (the seed's sample records belong to a third client, MERIDIAN_INTERNAL):
--   A  aaaaaaaa-0000-0000-0000-000000000001  CLIENT_A
--   B  bbbbbbbb-0000-0000-0000-000000000001  CLIENT_B
--
-- Users (u = a/b for the client; the last two digits give the role):
--   a0000000-...-0a  a.analyst   ANALYST       (entity.read only)
--   a0000000-...-0b  a.steward   DATA_STEWARD  (entity.write)
--   a0000000-...-0c  a.admin     CLIENT_ADMIN
--   b0000000-...-0a / 0b / 0c    the same three roles in client B
--   c0000000-...-0c  staff       platform staff (profiles.is_tenant_admin), no client
--   c0000000-...-0d  nobody      signed in, no client
--
-- Records (B's names all start with "Bravo", so a leak is easy to spot):
--   aaaaaaaa-0000-0000-0000-0000000000f1  A-FUND-1   Alpha Fund One   NAV 111
--   aaaaaaaa-0000-0000-0000-0000000000f2  A-FUND-2   Alpha Fund Two
--   bbbbbbbb-0000-0000-0000-0000000000f1  B-FUND-1   Bravo Fund One   NAV 987654.321
--   bbbbbbbb-0000-0000-0000-0000000000f2  B-FUND-2   Bravo Fund Two   NAV 5
--   bbbbbbbb-0000-0000-0000-0000000000a1  B-ORD-1    Bravo Order One  (ORDER)
--
-- Plus, for client B: a custom role, a promoted load batch, a feed connection
-- with a vault secret, a narrative template and a stale RUNNING run, a dashboard
-- template, a client-owned compliance rule, a NAV limit on B-FUND-1 with one
-- evaluation run, an order audit entry, a private statement template with a
-- source and a section, an intersection, and a stored document.

\set ON_ERROR_STOP on

BEGIN;

-- ----------------------------------------------------------------- helpers
CREATE SCHEMA IF NOT EXISTS tests;
GRANT USAGE ON SCHEMA tests TO anon, authenticated, service_role;

-- Each test file counts its own results in two transaction-local settings.
CREATE OR REPLACE FUNCTION tests.begin(p_name text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('tests.name', p_name, true);
    PERFORM set_config('tests.passed', '0', true);
    PERFORM set_config('tests.failed', '', true);
END $$;

CREATE OR REPLACE FUNCTION tests.pass(p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('tests.passed', (COALESCE(NULLIF(current_setting('tests.passed', true), ''), '0')::int + 1)::text, true);
    RAISE NOTICE 'PASS %', p_label;
END $$;

CREATE OR REPLACE FUNCTION tests.fail(p_label text, p_detail text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('tests.failed', COALESCE(current_setting('tests.failed', true), '') || p_label || E'\n', true);
    RAISE WARNING 'FAIL %: %', p_label, p_detail;
END $$;

-- Ends a test file: raises when any check failed, so psql exits non-zero.
CREATE OR REPLACE FUNCTION tests.done() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_failed text := COALESCE(current_setting('tests.failed', true), '');
BEGIN
    IF v_failed <> '' THEN
        RAISE EXCEPTION 'FAILED in %: %', current_setting('tests.name', true), v_failed;
    END IF;
    RAISE NOTICE 'DONE % (% passed)', current_setting('tests.name', true), current_setting('tests.passed', true);
END $$;

-- Act as a caller for the rest of the transaction, the way PostgREST does:
-- switch to the API role and set the JWT claims auth.uid() and auth.jwt() read.
CREATE OR REPLACE FUNCTION tests.login(p_user uuid, p_aal text DEFAULT 'aal1', p_extra jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('role', 'none', true);
    PERFORM set_config('request.jwt.claims',
        (jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal) || p_extra)::text, true);
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('role', 'authenticated', true);
END $$;

CREATE OR REPLACE FUNCTION tests.anon() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('role', 'none', true);
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('role', 'anon', true);
END $$;

-- The worker and other server code: the service role, which bypasses RLS.
CREATE OR REPLACE FUNCTION tests.service() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('role', 'none', true);
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('role', 'service_role', true);
END $$;

-- Back to the database owner, with no request (migrations, psql).
CREATE OR REPLACE FUNCTION tests.owner() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('role', 'none', true);
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
END $$;

-- p_sql must fail; with p_sqlstate, with that code (or class, when two characters).
CREATE OR REPLACE FUNCTION tests.expect_error(p_label text, p_sql text, p_sqlstate text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_state text;
    v_msg text;
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS NULL THEN
        PERFORM tests.fail(p_label, 'expected an error, the statement succeeded');
    ELSIF p_sqlstate IS NOT NULL AND v_state <> p_sqlstate AND left(v_state, 2) <> p_sqlstate THEN
        PERFORM tests.fail(p_label, format('expected SQLSTATE %s, got %s: %s', p_sqlstate, v_state, v_msg));
    ELSE
        PERFORM tests.pass(p_label || ' [' || v_state || ': ' || left(v_msg, 80) || ']');
    END IF;
END $$;

-- p_sql (a query, or INSERT/UPDATE/DELETE ... RETURNING) must yield p_expected rows.
CREATE OR REPLACE FUNCTION tests.expect_rows(p_label text, p_sql text, p_expected bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_count bigint;
    v_state text;
    v_msg text;
BEGIN
    BEGIN
        EXECUTE format('WITH q AS (%s) SELECT count(*) FROM q', p_sql) INTO v_count;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS NOT NULL THEN
        PERFORM tests.fail(p_label, format('expected %s rows, got error %s: %s', p_expected, v_state, v_msg));
    ELSIF v_count IS DISTINCT FROM p_expected THEN
        PERFORM tests.fail(p_label, format('expected %s rows, got %s', p_expected, v_count));
    ELSE
        PERFORM tests.pass(p_label);
    END IF;
END $$;

-- An attack: p_sql must either fail or yield no rows.
CREATE OR REPLACE FUNCTION tests.expect_denied(p_label text, p_sql text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_count bigint;
    v_state text;
    v_msg text;
BEGIN
    BEGIN
        EXECUTE format('WITH q AS (%s) SELECT count(*) FROM q', p_sql) INTO v_count;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS NOT NULL THEN
        PERFORM tests.pass(p_label || ' [' || v_state || ': ' || left(v_msg, 80) || ']');
    ELSIF v_count = 0 THEN
        PERFORM tests.pass(p_label || ' [no rows]');
    ELSE
        PERFORM tests.fail(p_label, format('expected an error or no rows, got %s rows', v_count));
    END IF;
END $$;

-- The first column of the first row of p_sql (a query, or a write with
-- RETURNING), as text, must equal p_expected (NULL matches NULL).
CREATE OR REPLACE FUNCTION tests.expect_value(p_label text, p_sql text, p_expected text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_value text;
    v_state text;
    v_msg text;
BEGIN
    BEGIN
        EXECUTE format('WITH q(c) AS (%s) SELECT q.c::text FROM q LIMIT 1', p_sql) INTO v_value;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS NOT NULL THEN
        PERFORM tests.fail(p_label, format('expected %s, got error %s: %s', COALESCE(p_expected, 'NULL'), v_state, v_msg));
    ELSIF v_value IS DISTINCT FROM p_expected THEN
        PERFORM tests.fail(p_label, format('expected %s, got %s', COALESCE(p_expected, 'NULL'), COALESCE(v_value, 'NULL')));
    ELSE
        PERFORM tests.pass(p_label);
    END IF;
END $$;

-- p_sql must run without an error.
CREATE OR REPLACE FUNCTION tests.expect_ok(p_label text, p_sql text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_state text;
    v_msg text;
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS NOT NULL THEN
        PERFORM tests.fail(p_label, format('expected success, got %s: %s', v_state, v_msg));
    ELSE
        PERFORM tests.pass(p_label);
    END IF;
END $$;

CREATE OR REPLACE FUNCTION tests.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF p_ok IS TRUE THEN
        PERFORM tests.pass(p_label);
    ELSE
        PERFORM tests.fail(p_label, COALESCE(p_detail, 'condition was ' || COALESCE(p_ok::text, 'NULL')));
    END IF;
END $$;

-- New functions are not executable by PUBLIC (20261120101000), so the API
-- roles the tests switch to are granted these by name.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tests TO anon, authenticated, service_role;

-- Ids a test needs while acting as a role that cannot look them up itself.
CREATE TABLE IF NOT EXISTS tests.ids (name text PRIMARY KEY, id uuid NOT NULL);
GRANT SELECT ON tests.ids TO anon, authenticated, service_role;

-- ----------------------------------------------------------------- clients and people
INSERT INTO tenancy.clients (id, client_code, client_name) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'CLIENT_A', 'Client A'),
    ('bbbbbbbb-0000-0000-0000-000000000001', 'CLIENT_B', 'Client B');

-- The sign-up trigger (tenancy.handle_new_auth_user) creates each profile.
INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data, email_confirmed_at) VALUES
    ('a0000000-0000-0000-0000-00000000000a', 'a.analyst@a.test', 'authenticated', 'authenticated', '{}', '{"provider":"email"}', now()),
    ('a0000000-0000-0000-0000-00000000000b', 'a.steward@a.test', 'authenticated', 'authenticated', '{}', '{"provider":"email"}', now()),
    ('a0000000-0000-0000-0000-00000000000c', 'a.admin@a.test',   'authenticated', 'authenticated', '{}', '{"provider":"email"}', now()),
    ('b0000000-0000-0000-0000-00000000000a', 'b.analyst@b.test', 'authenticated', 'authenticated', '{}', '{"provider":"email"}', now()),
    ('b0000000-0000-0000-0000-00000000000b', 'b.steward@b.test', 'authenticated', 'authenticated', '{}', '{"provider":"email"}', now()),
    ('b0000000-0000-0000-0000-00000000000c', 'b.admin@b.test',   'authenticated', 'authenticated', '{}', '{"provider":"email"}', now()),
    ('c0000000-0000-0000-0000-00000000000c', 'staff@platform.test', 'authenticated', 'authenticated', '{}', '{"provider":"email"}', now()),
    ('c0000000-0000-0000-0000-00000000000d', 'nobody@x.test',    'authenticated', 'authenticated', '{}', '{"provider":"email"}', now());

INSERT INTO tenancy.profiles (id, display_name)
SELECT u.id, u.email FROM auth.users u
WHERE u.email LIKE '%.test'
ON CONFLICT (id) DO NOTHING;

UPDATE tenancy.profiles SET is_tenant_admin = TRUE WHERE id = 'c0000000-0000-0000-0000-00000000000c';

INSERT INTO tenancy.client_users (client_id, user_id) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a'),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000b'),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000c'),
    ('bbbbbbbb-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000a'),
    ('bbbbbbbb-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b'),
    ('bbbbbbbb-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000c');

INSERT INTO tenancy.user_roles (client_id, user_id, role_id)
SELECT v.c::uuid, v.u::uuid, r.id
FROM (VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'ANALYST'),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000b', 'DATA_STEWARD'),
    ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000c', 'CLIENT_ADMIN'),
    ('bbbbbbbb-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000a', 'ANALYST'),
    ('bbbbbbbb-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000b', 'DATA_STEWARD'),
    ('bbbbbbbb-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000000c', 'CLIENT_ADMIN')
) AS v(c, u, code)
JOIN tenancy.roles r ON r.role_code = v.code AND r.client_id IS NULL;

-- A client-B custom role, used to try binding it inside client A.
INSERT INTO tenancy.roles (id, client_id, role_code, role_name) VALUES
    ('bbbbbbbb-0000-0000-0000-0000000000e1', 'bbbbbbbb-0000-0000-0000-000000000001', 'B_CUSTOM', 'B custom role');

-- ----------------------------------------------------------------- records
INSERT INTO entity_instances.master_entities (id, entity_code, domain_code, template_id, entity_name, client_id)
SELECT v.id::uuid, v.code, v.domain, t.id, v.name, v.client::uuid
FROM (VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000f1', 'A-FUND-1', 'FUND',  'FUND_STANDARD', 'Alpha Fund One',  'aaaaaaaa-0000-0000-0000-000000000001'),
    ('aaaaaaaa-0000-0000-0000-0000000000f2', 'A-FUND-2', 'FUND',  'FUND_STANDARD', 'Alpha Fund Two',  'aaaaaaaa-0000-0000-0000-000000000001'),
    ('bbbbbbbb-0000-0000-0000-0000000000f1', 'B-FUND-1', 'FUND',  'FUND_STANDARD', 'Bravo Fund One',  'bbbbbbbb-0000-0000-0000-000000000001'),
    ('bbbbbbbb-0000-0000-0000-0000000000f2', 'B-FUND-2', 'FUND',  'FUND_STANDARD', 'Bravo Fund Two',  'bbbbbbbb-0000-0000-0000-000000000001'),
    ('bbbbbbbb-0000-0000-0000-0000000000a1', 'B-ORD-1',  'ORDER', NULL,            'Bravo Order One', 'bbbbbbbb-0000-0000-0000-000000000001')
) AS v(id, code, domain, template, name, client)
LEFT JOIN metadata_register.domain_templates t ON t.template_code = v.template;

INSERT INTO golden_master.entity_attribute_values
    (entity_id, attribute_id, source_id, golden_value, golden_value_numeric, valid_from, valid_to, precedence_rank)
SELECT v.entity::uuid, ar.id, s.id, v.val, v.val::numeric, DATE '2020-01-01', DATE '9999-12-31', 100
FROM (VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000f1', '111'),
    ('bbbbbbbb-0000-0000-0000-0000000000f1', '987654.321'),
    ('bbbbbbbb-0000-0000-0000-0000000000f2', '5')
) AS v(entity, val)
CROSS JOIN metadata_register.attribute_register ar
CROSS JOIN entity_instances.source_registry s
WHERE ar.attribute_code = 'NAV' AND s.source_code = 'MANUAL';

INSERT INTO tests.ids (name, id)
SELECT 'NAV', id FROM metadata_register.attribute_register WHERE attribute_code = 'NAV'
UNION ALL
SELECT 'MANUAL', id FROM entity_instances.source_registry WHERE source_code = 'MANUAL'
UNION ALL
SELECT 'INTERNAL', id FROM entity_instances.source_registry WHERE source_code = 'INTERNAL';

-- ----------------------------------------------------------------- client B's other data
INSERT INTO entity_instances.load_batches (id, client_id, file_name, as_of_date, status) VALUES
    ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bravo.csv', DATE '2026-09-30', 'PROMOTED');
UPDATE golden_master.entity_attribute_values
SET load_batch_id = 'bbbbbbbb-0000-0000-0000-0000000000b1'
WHERE entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1';

INSERT INTO ops.connections (id, client_id, connection_code, connection_name, kind, secret_id)
VALUES ('bbbbbbbb-0000-0000-0000-0000000000d1', 'bbbbbbbb-0000-0000-0000-000000000001', 'B_SFTP', 'Bravo SFTP', 'SFTP',
        vault.create_secret('bravo-sftp-password-s3cr3t', 'feed-connection-bravo-test', 'Feed connection credential'));

INSERT INTO public.narrative_templates (id, narrative_code, narrative_name, domain_code, instructions, client_id) VALUES
    ('bbbbbbbb-0000-0000-0000-0000000000c2', 'B_IC_MEMO', 'Bravo IC memo', 'FUND', 'Bravo confidential prompt', 'bbbbbbbb-0000-0000-0000-000000000001');
INSERT INTO public.narrative_runs (id, narrative_id, created_by, status, updated_at, entity_id) VALUES
    ('bbbbbbbb-0000-0000-0000-0000000000c3', 'bbbbbbbb-0000-0000-0000-0000000000c2', 'b0000000-0000-0000-0000-00000000000a',
     'RUNNING', now() - interval '5 minutes', 'bbbbbbbb-0000-0000-0000-0000000000f1');
INSERT INTO public.dashboard_templates (dashboard_code, dashboard_name, domain_code, data_queries, client_id) VALUES
    ('B_DASH', 'Bravo dashboard', 'FUND', '{"q":"Bravo private"}', 'bbbbbbbb-0000-0000-0000-000000000001');

INSERT INTO metadata_register.domain_templates (id, template_code, domain_code, template_name, client_id) VALUES
    ('bbbbbbbb-0000-0000-0000-0000000000c7', 'B_PRIVATE_STMT', 'STATEMENT_PERIOD', 'Bravo private statement', 'bbbbbbbb-0000-0000-0000-000000000001');
INSERT INTO metadata_register.template_sources (template_id, source_kind, source_name, excerpt) VALUES
    ('bbbbbbbb-0000-0000-0000-0000000000c7', 'paste', 'Bravo Q3 investor statement.xlsx', 'Commitment 25,000,000 | NAV 31,442,118 | LP: Bravo Pension');
INSERT INTO metadata_register.template_sections (template_id, section_code, section_name) VALUES
    ('bbbbbbbb-0000-0000-0000-0000000000c7', 'B_SEC', 'Bravo confidential section');

INSERT INTO entity_instances.intersection_instances (id, intersection_type_id, intersection_code, valid_from, client_id)
SELECT 'bbbbbbbb-0000-0000-0000-0000000000c1', t.id, 'B-INT-1', DATE '2020-01-01', 'bbbbbbbb-0000-0000-0000-000000000001'
FROM metadata_register.intersection_types t
ORDER BY t.intersection_code
LIMIT 1;
INSERT INTO entity_instances.intersection_members (intersection_id, entity_id, member_role, valid_from) VALUES
    ('bbbbbbbb-0000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-0000000000f1', 'FUND', DATE '2020-01-01');

INSERT INTO storage.objects (bucket_id, name, owner) VALUES
    ('documents', 'bbbbbbbb-0000-0000-0000-000000000001/bravo-statement.pdf', 'b0000000-0000-0000-0000-00000000000c');

-- ----------------------------------------------------------------- client B's compliance data
INSERT INTO compliance.rules (rule_code, rule_name, anchor_domain_code, client_id) VALUES
    ('B_PRIVATE_RULE', 'Bravo private limit', 'FUND', 'bbbbbbbb-0000-0000-0000-000000000001');

-- A tighter NAV limit for B-FUND-1 on a shared rule.
INSERT INTO compliance.rule_thresholds (rule_id, entity_id, hard_limit_value, notes)
SELECT r.id, 'bbbbbbbb-0000-0000-0000-0000000000f1', 1000, 'Bravo limit'
FROM compliance.rules r WHERE r.rule_code = 'FUND_FAMILY_NAV_CAP';

-- One evaluation run over B-FUND-1, and one order audit entry, written by server code.
SELECT compliance.evaluate_rule('FUND_FAMILY_NAV_CAP', DATE '2026-09-30', now(), NULL, NULL, 'bbbbbbbb-0000-0000-0000-0000000000f1', NULL);
SELECT compliance.record_order_audit('bbbbbbbb-0000-0000-0000-0000000000a1', NULL, 'CREATE', '{"note":"Bravo order"}'::jsonb,
                                     'b0000000-0000-0000-0000-00000000000b', 'PASS', now());

COMMIT;

-- The fixture must have produced what the tests read.
DO $$
BEGIN
    IF (SELECT count(*) FROM tenancy.profiles WHERE id IN (
            'a0000000-0000-0000-0000-00000000000a', 'b0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000c')) <> 3 THEN
        RAISE EXCEPTION 'fixture: profiles were not created';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM compliance.rule_evaluation_results r JOIN compliance.rules ru ON ru.id = r.rule_id
                   WHERE ru.rule_code = 'FUND_FAMILY_NAV_CAP' AND r.anchor_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000f1') THEN
        RAISE EXCEPTION 'fixture: no evaluation run for B-FUND-1';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM compliance.compliance_audit_log WHERE order_entity_id = 'bbbbbbbb-0000-0000-0000-0000000000a1') THEN
        RAISE EXCEPTION 'fixture: no audit entry for B-ORD-1';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM entity_instances.intersection_instances WHERE id = 'bbbbbbbb-0000-0000-0000-0000000000c1') THEN
        RAISE EXCEPTION 'fixture: no intersection type to build B-INT-1 on';
    END IF;
    IF (SELECT count(*) FROM tests.ids) <> 3 THEN
        RAISE EXCEPTION 'fixture: NAV attribute or MANUAL/INTERNAL source missing';
    END IF;
END $$;
