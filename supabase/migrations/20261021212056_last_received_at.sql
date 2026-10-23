-- Receipt time for a source value. Distinct from system_from, which stays at the
-- last time the value itself changed. A restatement of the same value moves
-- last_received_at and leaves the golden value and its knowledge time alone.
-- The stamp is operational and is not versioned: the open row shows the latest receipt.

ALTER TABLE golden_master.entity_attribute_values
  ADD COLUMN last_received_at TIMESTAMPTZ;

UPDATE golden_master.entity_attribute_values
SET last_received_at = system_from
WHERE last_received_at IS NULL;

ALTER TABLE golden_master.entity_attribute_values
  ALTER COLUMN last_received_at SET DEFAULT NOW(),
  ALTER COLUMN last_received_at SET NOT NULL;

COMMENT ON COLUMN golden_master.entity_attribute_values.last_received_at IS
  'When this source last delivered the value, including a restatement that did not change it. system_from remains the knowledge time of the last value change.';

CREATE INDEX idx_eav_last_received
  ON golden_master.entity_attribute_values (last_received_at)
  WHERE system_to = '9999-12-31 23:59:59';

CREATE OR REPLACE VIEW public.entity_attribute_values AS
SELECT
  id, entity_id, attribute_id, source_id, source_value_id, golden_value,
  golden_value_jsonb, golden_value_numeric, golden_value_date, golden_value_timestamp,
  golden_value_boolean, valid_from, valid_to, system_from, system_to, precedence_rank,
  confidence_score, is_manual_override, override_reason, competing_values,
  resolution_rule_applied, metadata, created_at, created_by, updated_by,
  golden_source_id, resolution_version, resolved_at, period_grain, statement_basis,
  last_received_at
FROM golden_master.entity_attribute_values;

ALTER VIEW public.entity_attribute_values SET (security_invoker = on);

CREATE OR REPLACE FUNCTION public.stale_attributes(
  p_domain_code text DEFAULT NULL,
  p_older_than_days integer DEFAULT 30,
  p_as_of_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '30s'
SET search_path = public, entity_instances, metadata_register, golden_master, tenancy, pg_catalog
AS $stale$
DECLARE
  v_domain text := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
  v_days integer := LEAST(GREATEST(COALESCE(p_older_than_days, 30), 1), 3650);
  v_as_of date := COALESCE(p_as_of_date, CURRENT_DATE);
  v_cutoff timestamptz := NOW() - make_interval(days => v_days);
  v_result jsonb;
BEGIN
  PERFORM set_config('statement_timeout', '45000', true);

  WITH scoped AS MATERIALIZED (
    SELECT me.id, me.entity_code, me.entity_name, me.domain_code
    FROM entity_instances.master_entities me
    WHERE me.is_active IS TRUE
      AND me.client_id IN (
        SELECT cid
        FROM tenancy.current_client_ids() AS cid
        WHERE tenancy.has_permission(cid, 'entity.read')
      )
      AND CASE
        WHEN EXISTS (SELECT 1 FROM tenancy.entity_grants)
          THEN tenancy.has_entity_access(me.id, 'READ')
        ELSE TRUE
      END
      AND (v_domain IS NULL OR me.domain_code = v_domain)
  ),
  winners AS MATERIALIZED (
    SELECT DISTINCT ON (eav.entity_id, eav.attribute_id)
      eav.entity_id,
      eav.attribute_id,
      eav.source_id,
      NULLIF(btrim(eav.golden_value), '') AS golden_value,
      COALESCE(eav.last_received_at, eav.system_from) AS received_at
    FROM golden_master.entity_attribute_values eav
    JOIN scoped s ON s.id = eav.entity_id
    WHERE eav.system_to = '9999-12-31 23:59:59'
      AND eav.valid_from <= v_as_of
      AND eav.valid_to >= v_as_of
      AND NULLIF(btrim(eav.golden_value), '') IS NOT NULL
    ORDER BY eav.entity_id, eav.attribute_id,
      (eav.golden_source_id IS NOT NULL AND eav.source_id = eav.golden_source_id) DESC,
      eav.precedence_rank ASC,
      eav.valid_from DESC
  ),
  stale AS MATERIALIZED (
    SELECT
      s.id AS entity_id,
      s.entity_code,
      s.entity_name,
      s.domain_code,
      ar.attribute_code,
      ar.attribute_name,
      sr.source_code,
      sr.source_name,
      w.golden_value,
      w.received_at,
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - w.received_at)) / 86400))::int AS age_days
    FROM winners w
    JOIN scoped s ON s.id = w.entity_id
    JOIN metadata_register.attribute_register ar ON ar.id = w.attribute_id
    JOIN entity_instances.source_registry sr ON sr.id = w.source_id
    WHERE w.received_at < v_cutoff
      AND sr.source_code NOT IN ('DERIVED', 'CALCULATED')
  )
  SELECT jsonb_build_object(
    'olderThanDays', v_days,
    'asOfDate', v_as_of,
    'count', (SELECT count(*)::int FROM stale),
    'attributes', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'entityId', row.entity_id,
          'entityCode', row.entity_code,
          'entityName', row.entity_name,
          'domainCode', row.domain_code,
          'attributeCode', row.attribute_code,
          'attributeName', row.attribute_name,
          'sourceCode', row.source_code,
          'sourceName', row.source_name,
          'value', row.golden_value,
          'receivedAt', row.received_at,
          'ageDays', row.age_days
        )
        ORDER BY row.received_at ASC, row.entity_name, row.attribute_name
      )
      FROM (
        SELECT * FROM stale
        ORDER BY received_at ASC, entity_name, attribute_name
        LIMIT 200
      ) row
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$stale$;

COMMENT ON FUNCTION public.stale_attributes(text, integer, date) IS
  'Prevailing source values whose last receipt is older than the given number of days. Calculated and derived values are omitted. Count is complete; attributes lists the 200 oldest.';

REVOKE ALL ON FUNCTION public.stale_attributes(text, integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.stale_attributes(text, integer, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
