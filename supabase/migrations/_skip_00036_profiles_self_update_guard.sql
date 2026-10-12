-- Security fix: the "Profiles updatable by self" RLS policy would otherwise let any
-- user set is_tenant_admin = TRUE (or re-activate themselves) on their own row.
-- Only existing tenant admins (or the service role / migrations) may change those columns.

CREATE OR REPLACE FUNCTION tenancy.guard_profile_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenancy, public
AS $$
BEGIN
    IF (NEW.is_tenant_admin IS DISTINCT FROM OLD.is_tenant_admin
        OR NEW.is_active IS DISTINCT FROM OLD.is_active)
       AND auth.uid() IS NOT NULL            -- NULL = service role / direct DB access
       AND NOT tenancy.is_tenant_admin() THEN
        RAISE EXCEPTION 'Only tenant admins may change is_tenant_admin or is_active';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_guard_privileged ON tenancy.profiles;
CREATE TRIGGER trg_profiles_guard_privileged
    BEFORE UPDATE ON tenancy.profiles
    FOR EACH ROW EXECUTE FUNCTION tenancy.guard_profile_privileged_columns();
