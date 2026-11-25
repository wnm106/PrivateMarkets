-- License switches turn one item on or off for one client, over its modules.
-- Run by scripts/db-tests/license-switches.ts against a database built from
-- supabase/migrations. Everything is rolled back; any failed check raises.
-- See supabase/migrations/20261125100000_client_license_switches.sql.
BEGIN;
DO $$
DECLARE
    v_full UUID := gen_random_uuid();
    v_curated UUID := gen_random_uuid();
    v_staff UUID := gen_random_uuid();
    v_full_user UUID := gen_random_uuid();
    v_curated_user UUID := gen_random_uuid();
    v_shared UUID;
    v_owned UUID;
    v_scope JSONB;
    v_state RECORD;
    v_refused BOOLEAN;
BEGIN
    INSERT INTO tenancy.clients (id, client_code, client_name, curated_modules) VALUES
        (v_full, 'LICENSE_FULL', 'License full catalog', FALSE),
        (v_curated, 'LICENSE_CURATED', 'License curated', TRUE);
    INSERT INTO auth.users (id, email) VALUES
        (v_staff, 'license-staff@example.test'),
        (v_full_user, 'license-full@example.test'),
        (v_curated_user, 'license-curated@example.test');
    INSERT INTO tenancy.profiles (id, display_name, is_active, is_tenant_admin) VALUES
        (v_staff, 'Staff', TRUE, TRUE),
        (v_full_user, 'Full user', TRUE, FALSE),
        (v_curated_user, 'Curated user', TRUE, FALSE)
        ON CONFLICT (id) DO UPDATE SET is_active = TRUE, is_tenant_admin = EXCLUDED.is_tenant_admin;
    INSERT INTO tenancy.client_users (client_id, user_id, is_active) VALUES
        (v_full, v_full_user, TRUE),
        (v_curated, v_curated_user, TRUE);
    -- The curated client's saved modules granted one surface, one page and one workflow.
    INSERT INTO tenancy.client_module_grants (client_id, kind, code) VALUES
        (v_curated, 'surface', 'lic-granted'),
        (v_curated, 'tool', '/lic-granted'),
        (v_curated, 'workflow', 'LIC_GRANTED');

    INSERT INTO ops.workflows (client_id, workflow_code, workflow_name) VALUES (NULL, 'LIC_SHARED', 'License shared') RETURNING id INTO v_shared;
    INSERT INTO ops.workflows (client_id, workflow_code, workflow_name) VALUES (v_full, 'LIC_OWNED', 'License owned') RETURNING id INTO v_owned;

    -- ---------------------------------------------------------------
    -- No switches: the modules decide, as before.
    -- ---------------------------------------------------------------
    IF NOT tenancy.client_item_enabled(v_full, 'surface', 'lic-anything') THEN RAISE EXCEPTION 'a full-catalog client lost a surface with no switch'; END IF;
    IF NOT tenancy.client_item_enabled(v_curated, 'surface', 'lic-granted') THEN RAISE EXCEPTION 'a curated client lost a granted surface'; END IF;
    IF tenancy.client_item_enabled(v_curated, 'surface', 'lic-other') THEN RAISE EXCEPTION 'a curated client got a surface its modules do not hold'; END IF;
    IF NOT tenancy.client_item_enabled(v_curated, 'assistant_tool', 'reconciliation') THEN RAISE EXCEPTION 'an assistant tool group is off with no switch'; END IF;
    RAISE NOTICE 'ok: with no switch, an item follows the client''s modules, and assistant tool groups are on';

    -- ---------------------------------------------------------------
    -- Only a tenant admin sets a switch.
    -- ---------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_full_user::TEXT, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_full_user, 'role', 'authenticated', 'aal', 'aal2')::TEXT, TRUE);
    v_refused := FALSE;
    BEGIN
        PERFORM tenancy.set_client_license_switch(v_full, 'surface', 'lic-anything', FALSE);
    EXCEPTION WHEN insufficient_privilege THEN v_refused := TRUE;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'a client user changed their own license'; END IF;
    v_refused := FALSE;
    BEGIN
        PERFORM * FROM tenancy.client_license_state(v_full, '[]'::jsonb);
    EXCEPTION WHEN insufficient_privilege THEN v_refused := TRUE;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'a client user read the license screen'; END IF;
    RAISE NOTICE 'ok: a client user can neither change nor read the license screen';

    PERFORM set_config('request.jwt.claim.sub', v_staff::TEXT, TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_staff, 'role', 'authenticated', 'aal', 'aal2')::TEXT, TRUE);
    IF NOT tenancy.is_tenant_admin() THEN RAISE EXCEPTION 'setup: the caller is not staff'; END IF;
    v_refused := FALSE;
    BEGIN
        PERFORM tenancy.set_client_license_switch(v_full, 'nonsense', 'x', TRUE);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := TRUE;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'a switch of an unknown kind was saved'; END IF;

    PERFORM tenancy.set_client_license_switch(v_full, 'surface', 'lic-anything', FALSE, 'Not on their plan');
    PERFORM tenancy.set_client_license_switch(v_full, 'tool', '/lic-page', FALSE);
    PERFORM tenancy.set_client_license_switch(v_full, 'workflow', 'LIC_SHARED', FALSE);
    PERFORM tenancy.set_client_license_switch(v_full, 'workflow', 'LIC_OWNED', FALSE);
    PERFORM tenancy.set_client_license_switch(v_full, 'assistant_tool', 'reconciliation', FALSE);
    PERFORM tenancy.set_client_license_switch(v_curated, 'surface', 'lic-other', TRUE);
    PERFORM tenancy.set_client_license_switch(v_curated, 'surface', 'lic-granted', FALSE);
    IF (SELECT updated_by FROM tenancy.client_license_switches WHERE client_id = v_full AND kind = 'surface') IS DISTINCT FROM v_staff THEN
        RAISE EXCEPTION 'a switch does not record who set it';
    END IF;

    -- A tenant admin outside support mode still sees the whole product.
    IF NOT tenancy.item_enabled('surface', 'lic-anything') THEN RAISE EXCEPTION 'staff outside support mode lost a surface'; END IF;

    SELECT * INTO v_state FROM tenancy.client_license_state(v_full, '[{"kind":"surface","code":"lic-anything"},{"kind":"surface","code":"lic-free"}]'::jsonb) AS s
        WHERE s.code = 'lic-anything';
    IF v_state.plan_enabled IS DISTINCT FROM TRUE OR v_state.switch_enabled IS DISTINCT FROM FALSE OR v_state.enabled IS DISTINCT FROM FALSE
       OR v_state.note IS DISTINCT FROM 'Not on their plan' THEN
        RAISE EXCEPTION 'the license screen read % for a switched-off surface', row_to_json(v_state);
    END IF;
    IF (SELECT count(*) FROM tenancy.client_license_state(v_full, '[]'::jsonb)) <> 5 THEN
        RAISE EXCEPTION 'the license screen does not list every switch the client has';
    END IF;
    RAISE NOTICE 'ok: a tenant admin sets switches and reads plan, switch and result for each item';

    -- ---------------------------------------------------------------
    -- A full-catalog client loses what is switched off, and only that.
    -- ---------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_full_user::TEXT, TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_full_user, 'role', 'authenticated', 'aal', 'aal2')::TEXT, TRUE);
    IF tenancy.item_enabled('surface', 'lic-anything') THEN RAISE EXCEPTION 'a switched-off surface is still on'; END IF;
    IF NOT tenancy.item_enabled('surface', 'lic-free') THEN RAISE EXCEPTION 'a surface with no switch went off'; END IF;
    IF tenancy.item_enabled('assistant_tool', 'reconciliation') THEN RAISE EXCEPTION 'a switched-off tool group is still on'; END IF;
    v_scope := tenancy.module_scope();
    IF (v_scope ->> 'restricted')::boolean THEN RAISE EXCEPTION 'a full-catalog client became restricted'; END IF;
    IF NOT (v_scope -> 'blocked' -> 'surface') ? 'lic-anything'
       OR NOT (v_scope -> 'blocked' -> 'tool') ? '/lic-page'
       OR NOT (v_scope -> 'blocked' -> 'assistant_tool') ? 'reconciliation' THEN
        RAISE EXCEPTION 'module_scope does not list what is switched off: %', v_scope;
    END IF;
    RAISE NOTICE 'ok: a full-catalog client loses exactly what is switched off';

    -- Workflows: a switched-off shared workflow is hidden and cannot start. The client's own workflow is not licensed.
    IF tenancy.shared_workflow_visible(NULL, 'LIC_SHARED') THEN RAISE EXCEPTION 'a switched-off shared workflow is visible'; END IF;
    IF tenancy.client_workflow_allowed(v_full, 'LIC_SHARED', NULL) THEN RAISE EXCEPTION 'a switched-off shared workflow may start'; END IF;
    IF NOT tenancy.client_workflow_allowed(v_full, 'LIC_OWNED', v_full) THEN RAISE EXCEPTION 'a switch reached the client''s own workflow'; END IF;
    IF EXISTS (SELECT 1 FROM public.workflow_list() AS w WHERE (w ->> 'id')::uuid = v_shared) THEN RAISE EXCEPTION 'workflow_list shows a switched-off workflow'; END IF;
    v_refused := FALSE;
    BEGIN
        PERFORM public.workflow_run_start(v_shared, v_full, '{}'::jsonb);
    EXCEPTION WHEN insufficient_privilege THEN v_refused := SQLERRM LIKE '%not enabled for this client%';
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'a run of a switched-off workflow was started'; END IF;
    RAISE NOTICE 'ok: a switched-off shared workflow is hidden and refuses new runs; the client''s own workflow is untouched';

    -- ---------------------------------------------------------------
    -- A curated client: a switch adds or removes one item over its modules.
    -- ---------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_curated_user::TEXT, TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_curated_user, 'role', 'authenticated', 'aal', 'aal2')::TEXT, TRUE);
    v_scope := tenancy.module_scope();
    IF NOT (v_scope ->> 'restricted')::boolean THEN RAISE EXCEPTION 'a curated client is not restricted'; END IF;
    IF NOT (v_scope -> 'surfaces') ? 'lic-other' THEN RAISE EXCEPTION 'a switched-on surface is missing for a curated client: %', v_scope; END IF;
    IF (v_scope -> 'surfaces') ? 'lic-granted' THEN RAISE EXCEPTION 'a switched-off granted surface is still listed: %', v_scope; END IF;
    IF NOT (v_scope -> 'tools') ? '/lic-granted' THEN RAISE EXCEPTION 'a granted page went missing: %', v_scope; END IF;
    IF NOT tenancy.shared_workflow_visible(NULL, 'LIC_GRANTED') THEN RAISE EXCEPTION 'a granted workflow went missing'; END IF;
    IF tenancy.shared_workflow_visible(NULL, 'LIC_SHARED') THEN RAISE EXCEPTION 'a curated client sees a workflow its modules do not hold'; END IF;
    RAISE NOTICE 'ok: on a curated client a switch turns one item on or off over its modules';

    -- ---------------------------------------------------------------
    -- Support mode follows the supported client; clearing a switch restores the plan.
    -- ---------------------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_staff::TEXT, TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_staff, 'role', 'authenticated', 'aal', 'aal2')::TEXT, TRUE);
    INSERT INTO tenancy.impersonation_sessions (admin_user_id, client_id, expires_at) VALUES (v_staff, v_full, NOW() + INTERVAL '1 hour');
    IF tenancy.item_enabled('surface', 'lic-anything') THEN RAISE EXCEPTION 'staff in support mode see a surface the client is not licensed for'; END IF;
    PERFORM tenancy.set_client_license_switch(v_full, 'surface', 'lic-anything', NULL);
    IF NOT tenancy.item_enabled('surface', 'lic-anything') THEN RAISE EXCEPTION 'clearing a switch did not restore the plan'; END IF;
    IF EXISTS (SELECT 1 FROM tenancy.client_license_switches WHERE client_id = v_full AND kind = 'surface' AND code = 'lic-anything') THEN
        RAISE EXCEPTION 'clearing a switch left its row';
    END IF;
    RAISE NOTICE 'ok: support mode sees the client''s license, and Follow plan removes the switch';
END;
$$;
ROLLBACK;
