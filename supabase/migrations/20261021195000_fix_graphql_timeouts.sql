-- The authenticated role cancels statements after 8 seconds. Count entities once,
-- and let display layout reads through the security-invoker views.

CREATE OR REPLACE FUNCTION public.domain_record_counts()
RETURNS TABLE(domain_code text, total_count integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = entity_instances, pg_catalog
AS $counts$
  SELECT me.domain_code, count(*)::integer
  FROM entity_instances.master_entities me
  WHERE me.is_active IS TRUE
  GROUP BY me.domain_code;
$counts$;

COMMENT ON FUNCTION public.domain_record_counts() IS
  'Active entity counts by domain. Runs as the caller so entity RLS still applies.';

REVOKE ALL ON FUNCTION public.domain_record_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.domain_record_counts() TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.entity_template_bindings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.display_layouts TO authenticated;

NOTIFY pgrst, 'reload schema';
