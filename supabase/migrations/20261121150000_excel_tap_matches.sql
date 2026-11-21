-- Exact matches for the Excel TAP function (docs/EXCEL_ADDIN.md).
--
-- A cell names a record by its code, its name, or another stored name, and an
-- attribute by its code, a stored alias, or its name. Case and the spaces around
-- the words do not matter. Nothing else is fuzzy: a spreadsheet cell must not
-- quietly land on a different record whose name merely contains the words.
--
-- Both functions run as the caller and read the same public views the API reads,
-- so a person can only match the records and attributes they can already see.

CREATE OR REPLACE FUNCTION public.tap_entity_matches(p_refs text[])
RETURNS TABLE (
  ref text,
  id uuid,
  entity_code text,
  entity_name text,
  domain_code text,
  match_kind text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH refs AS (
    SELECT DISTINCT r AS ref, lower(btrim(r)) AS needle
    FROM unnest(COALESCE(p_refs, '{}'::text[])) AS r
    WHERE btrim(COALESCE(r, '')) <> ''
  )
  SELECT refs.ref, me.id, me.entity_code::text, me.entity_name::text, me.domain_code::text, 'CODE'
  FROM refs
  JOIN public.master_entities me ON lower(btrim(me.entity_code)) = refs.needle
  WHERE me.is_active
  UNION ALL
  SELECT refs.ref, me.id, me.entity_code::text, me.entity_name::text, me.domain_code::text, 'NAME'
  FROM refs
  JOIN public.master_entities me ON lower(btrim(me.entity_name)) = refs.needle
  WHERE me.is_active
  UNION ALL
  SELECT refs.ref, me.id, me.entity_code::text, me.entity_name::text, me.domain_code::text, 'ALIAS'
  FROM refs
  JOIN public.entity_aliases ea ON lower(btrim(ea.alias_label)) = refs.needle AND ea.is_active
  JOIN public.master_entities me ON me.id = ea.entity_id
  WHERE me.is_active
$$;

REVOKE ALL ON FUNCTION public.tap_entity_matches(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tap_entity_matches(text[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.tap_entity_matches(text[]) IS
  'Active records whose code, name, or stored alias equals each reference, ignoring case and outer spaces. match_kind is CODE, NAME, or ALIAS. Runs as the caller.';

CREATE OR REPLACE FUNCTION public.tap_attribute_matches(p_refs text[])
RETURNS TABLE (
  ref text,
  attribute_id uuid,
  attribute_code text,
  attribute_name text,
  data_type text,
  domain_code text,
  match_kind text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH refs AS (
    SELECT DISTINCT r AS ref, lower(btrim(r)) AS needle
    FROM unnest(COALESCE(p_refs, '{}'::text[])) AS r
    WHERE btrim(COALESCE(r, '')) <> ''
  )
  SELECT refs.ref, ar.id, ar.attribute_code::text, ar.attribute_name::text, ar.data_type::text, ar.domain_code::text, 'CODE'
  FROM refs
  JOIN public.attribute_register ar ON lower(btrim(ar.attribute_code)) = refs.needle
  UNION ALL
  SELECT refs.ref, ar.id, ar.attribute_code::text, ar.attribute_name::text, ar.data_type::text,
         COALESCE(aa.domain_code, ar.domain_code)::text, 'ALIAS'
  FROM refs
  JOIN public.attribute_aliases aa
    ON aa.is_active
   AND (lower(btrim(aa.alias_label)) = refs.needle OR lower(btrim(aa.alias_code)) = refs.needle)
  JOIN public.attribute_register ar ON ar.id = aa.attribute_id
  UNION ALL
  SELECT refs.ref, ar.id, ar.attribute_code::text, ar.attribute_name::text, ar.data_type::text, ar.domain_code::text, 'NAME'
  FROM refs
  JOIN public.attribute_register ar ON lower(btrim(ar.attribute_name)) = refs.needle
$$;

REVOKE ALL ON FUNCTION public.tap_attribute_matches(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tap_attribute_matches(text[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.tap_attribute_matches(text[]) IS
  'Attributes whose code, active alias, or name equals each reference, ignoring case and outer spaces. match_kind is CODE, ALIAS, or NAME. domain_code is the alias''s entity type when the alias has one. Runs as the caller.';

NOTIFY pgrst, 'reload schema';
