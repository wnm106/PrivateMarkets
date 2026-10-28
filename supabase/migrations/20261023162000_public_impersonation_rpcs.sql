-- Support mode must run as the signed-in tenant admin.
-- Calling tenancy.start_impersonation through the service role, or through a
-- PostgREST schema switch, leaves auth.uid() empty. The function then rejects
-- the call ("Only tenant admins may impersonate a client"), no session is
-- stored, and entity lists stay on every client the admin can already see.

CREATE OR REPLACE FUNCTION public.start_impersonation(p_client_id uuid, p_reason text DEFAULT NULL)
RETURNS uuid
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = tenancy, pg_temp
AS $$
  SELECT tenancy.start_impersonation(p_client_id, p_reason);
$$;

CREATE OR REPLACE FUNCTION public.stop_impersonation()
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = tenancy, pg_temp
AS $$
  SELECT tenancy.stop_impersonation();
$$;

REVOKE ALL ON FUNCTION public.start_impersonation(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stop_impersonation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_impersonation(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stop_impersonation() TO authenticated;

COMMENT ON FUNCTION public.start_impersonation(uuid, text) IS
  'User-JWT entry point for tenancy.start_impersonation. Keeps auth.uid() so support mode scopes entity visibility to one client.';
COMMENT ON FUNCTION public.stop_impersonation() IS
  'User-JWT entry point for tenancy.stop_impersonation.';

NOTIFY pgrst, 'reload schema';
