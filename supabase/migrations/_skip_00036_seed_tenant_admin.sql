-- Migration: Seed Tenant Admin Helper
-- Description: Adds a helper function to create tenant admin profiles for seeding/testing

CREATE OR REPLACE FUNCTION public.create_tenant_admin(
    p_user_id UUID,
    p_display_name TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
BEGIN
    INSERT INTO tenancy.profiles (id, display_name, is_tenant_admin, is_active)
    VALUES (p_user_id, p_display_name, TRUE, TRUE)
    ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        is_tenant_admin = TRUE,
        is_active = TRUE;
END;
$$;

COMMENT ON FUNCTION public.create_tenant_admin IS 'Helper function to create tenant admin profiles for seeding/testing. Uses SECURITY DEFINER to bypass RLS.';

GRANT EXECUTE ON FUNCTION public.create_tenant_admin TO service_role;

