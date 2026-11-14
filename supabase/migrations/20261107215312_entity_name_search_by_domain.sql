-- Name search used one alphabetical limit across every root domain. "Bench"
-- matches 20 funds and thousands of issuers, securities, and positions, and
-- the funds sort first, so the other types never reached the result list.
-- Take the first names from each domain instead. The trigram index serves the
-- contains predicate.

CREATE OR REPLACE FUNCTION public.search_entity_names(
  p_query text,
  p_per_domain integer DEFAULT 8
)
RETURNS TABLE (
  id uuid,
  entity_code text,
  entity_name text,
  domain_code text,
  is_active boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = entity_instances, public, pg_temp
AS $$
  WITH needle AS (
    SELECT btrim(COALESCE(p_query, '')) AS q
  ),
  pattern AS (
    SELECT CASE
      WHEN char_length(q) < 2 THEN NULL
      ELSE '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    END AS like_pattern
    FROM needle
  )
  SELECT ranked.id, ranked.entity_code, ranked.entity_name, ranked.domain_code, ranked.is_active
  FROM (
    SELECT
      me.id,
      me.entity_code::text AS entity_code,
      me.entity_name::text AS entity_name,
      me.domain_code::text AS domain_code,
      me.is_active,
      row_number() OVER (PARTITION BY me.domain_code ORDER BY me.entity_name, me.entity_code) AS rn
    FROM entity_instances.master_entities me
    CROSS JOIN pattern
    WHERE pattern.like_pattern IS NOT NULL
      AND me.is_active
      AND me.entity_name ILIKE pattern.like_pattern ESCAPE '\'
  ) ranked
  WHERE ranked.rn <= GREATEST(1, LEAST(COALESCE(p_per_domain, 8), 30));
$$;

REVOKE ALL ON FUNCTION public.search_entity_names(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_entity_names(text, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.search_entity_names(text, integer) IS
  'Active entity name matches, capped per domain so one entity type cannot fill global search.';

NOTIFY pgrst, 'reload schema';
