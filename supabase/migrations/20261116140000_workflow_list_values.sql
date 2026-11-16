-- Adding a value to an attribute's list from a workflow.
--
-- A workflow may find that nothing on an attribute's list fits a record. It can
-- then propose two linked changes: add the value to the list, then set it.
--
-- Lists are shared by every client and only a tenant admin may change one. That
-- rule is kept: the worker makes the change with its own key, and only after it
-- has checked that the person who approved it is a tenant admin. The client's
-- workflow service account is not a tenant admin and cannot do this itself.

-- Adds a value to the list behind an attribute. Returns what is on the list for
-- that code afterwards, and whether this call added it.
CREATE OR REPLACE FUNCTION public.workflow_list_value_add(
    p_attribute_code TEXT,
    p_value_code TEXT,
    p_value_label TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
    v_code TEXT := NULLIF(btrim(COALESCE(p_value_code, '')), '');
    v_label TEXT := COALESCE(NULLIF(btrim(COALESCE(p_value_label, '')), ''), NULLIF(btrim(COALESCE(p_value_code, '')), ''));
    v_list_code TEXT;
    v_inline JSONB;
    v_attribute_id UUID;
    v_list_id UUID;
    v_existing metadata_register.reference_list_values;
BEGIN
    IF v_code IS NULL THEN
        RAISE EXCEPTION 'A list value needs a code' USING ERRCODE = '22023';
    END IF;

    SELECT id, reference_list_code, to_jsonb(list_values) INTO v_attribute_id, v_list_code, v_inline
    FROM metadata_register.attribute_register
    WHERE attribute_code = p_attribute_code
    ORDER BY client_id NULLS FIRST
    LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Attribute % was not found', p_attribute_code USING ERRCODE = 'P0002';
    END IF;

    IF v_list_code IS NOT NULL THEN
        SELECT id INTO v_list_id FROM metadata_register.reference_lists WHERE list_code = v_list_code;
    END IF;

    IF v_list_id IS NOT NULL THEN
        SELECT * INTO v_existing FROM metadata_register.reference_list_values
         WHERE list_id = v_list_id AND lower(value_code) = lower(v_code);
        IF FOUND THEN
            IF NOT v_existing.is_active THEN
                UPDATE metadata_register.reference_list_values SET is_active = TRUE WHERE id = v_existing.id;
            END IF;
            RETURN jsonb_build_object('added', NOT v_existing.is_active, 'listCode', v_list_code, 'valueCode', v_existing.value_code, 'valueLabel', v_existing.value_label);
        END IF;
        INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order)
        VALUES (v_list_id, v_code, v_label, COALESCE((SELECT max(display_order) + 1 FROM metadata_register.reference_list_values WHERE list_id = v_list_id), 0));
        RETURN jsonb_build_object('added', TRUE, 'listCode', v_list_code, 'valueCode', v_code, 'valueLabel', v_label);
    END IF;

    -- No reference list: the attribute keeps its values on its own row.
    IF v_inline IS NULL OR jsonb_typeof(v_inline) <> 'array' OR jsonb_array_length(v_inline) = 0 THEN
        RAISE EXCEPTION 'Attribute % does not take its value from a list', p_attribute_code USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_inline) AS existing(value) WHERE lower(existing.value) = lower(v_code)) THEN
        RETURN jsonb_build_object('added', FALSE, 'listCode', NULL, 'valueCode', v_code, 'valueLabel', v_code);
    END IF;
    UPDATE metadata_register.attribute_register
       SET list_values = COALESCE(list_values, '[]'::jsonb) || to_jsonb(v_code), updated_at = NOW()
     WHERE id = v_attribute_id;
    RETURN jsonb_build_object('added', TRUE, 'listCode', NULL, 'valueCode', v_code, 'valueLabel', v_code);
END;
$$;

-- The person check now also says whether the person is a tenant admin, which
-- a change to a shared list requires of its approver.
CREATE OR REPLACE FUNCTION public.workflow_worker_person(p_user_id UUID, p_client_id UUID, p_permissions TEXT[])
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_name TEXT;
    v_permission TEXT;
    v_admin BOOLEAN;
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('problem', 'This step has no person behind it. Start the run from the app, or from a schedule someone owns.');
    END IF;
    PERFORM set_config('request.jwt.claim.sub', p_user_id::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id, 'role', 'authenticated')::text, TRUE);

    SELECT display_name INTO v_name FROM tenancy.profiles WHERE id = p_user_id AND is_active;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('problem', 'The person behind this step is no longer an active user.');
    END IF;

    v_admin := tenancy.is_tenant_admin();
    IF NOT v_admin THEN
        IF NOT (p_client_id IN (SELECT tenancy.current_client_ids())) THEN
            RETURN jsonb_build_object('problem', 'The person behind this step no longer belongs to this client.');
        END IF;
        FOREACH v_permission IN ARRAY COALESCE(p_permissions, ARRAY[]::TEXT[]) LOOP
            IF NOT tenancy.has_permission(p_client_id, v_permission) THEN
                RETURN jsonb_build_object('problem', 'The person behind this step does not hold ' || v_permission || ' for this client.');
            END IF;
        END LOOP;
    END IF;
    RETURN jsonb_build_object('name', v_name, 'tenantAdmin', v_admin);
END;
$$;

REVOKE ALL ON FUNCTION public.workflow_list_value_add(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_list_value_add(TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.workflow_worker_person(UUID, UUID, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_worker_person(UUID, UUID, TEXT[]) TO service_role;

NOTIFY pgrst, 'reload schema';
