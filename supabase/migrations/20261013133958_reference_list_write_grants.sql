-- Let tenant admins manage standardized value lists through the public
-- views PostgREST exposes. These views were created after the tenancy
-- migration that turned security_invoker on for existing views, so writes
-- were rejected and row security did not apply to them.

ALTER VIEW public.reference_lists SET (security_invoker = on);
ALTER VIEW public.reference_list_values SET (security_invoker = on);
ALTER VIEW public.reference_list_summary SET (security_invoker = on);
ALTER VIEW metadata_register.reference_list_summary SET (security_invoker = on);

GRANT INSERT, UPDATE, DELETE ON public.reference_lists TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.reference_list_values TO authenticated;

NOTIFY pgrst, 'reload schema';
