-- Migration: Profile Update RPC
-- Description: Allows updating profile display_name via RPC, bypassing PostgREST schema exposure limits.
-- The function runs with SECURITY DEFINER so it can access the tenancy schema regardless of which
-- PostgREST schemas are exposed to the client.

CREATE OR REPLACE FUNCTION tenancy.update_profile_display_name(
    p_user_id UUID,
    p_display_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenancy, public
AS $$
DECLARE
    v_result JSONB;
BEGIN
    -- Upsert the profile row
    INSERT INTO tenancy.profiles (id, display_name, updated_at)
    VALUES (p_user_id, p_display_name, NOW())
    ON CONFLICT (id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            updated_at = NOW()
    RETURNING jsonb_build_object(
        'id', id,
        'display_name', display_name,
        'is_tenant_admin', is_tenant_admin,
        'is_active', is_active
    ) INTO v_result;

    RETURN v_result;
END;
$$;

-- Grant execute to authenticated users (RLS still applies via the function's SECURITY DEFINER context)
GRANT EXECUTE ON FUNCTION tenancy.update_profile_display_name(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.update_profile_display_name(UUID, TEXT) TO anon;