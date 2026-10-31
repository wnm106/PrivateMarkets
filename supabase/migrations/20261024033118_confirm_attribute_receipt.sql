-- A steward can confirm that a prevailing value was checked, which moves
-- last_received_at to now and leaves the value and its knowledge time alone.

CREATE OR REPLACE FUNCTION public.confirm_attribute_receipt(
  p_entity_id uuid,
  p_attribute_code text
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, entity_instances, metadata_register, golden_master, tenancy, pg_catalog
AS $confirm$
DECLARE
  v_attribute_id uuid;
  v_id uuid;
  v_received timestamptz := clock_timestamp();
BEGIN
  IF p_entity_id IS NULL OR NULLIF(btrim(COALESCE(p_attribute_code, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Entity and attribute are required' USING ERRCODE = '22023';
  END IF;

  IF NOT tenancy.has_entity_access(p_entity_id, 'WRITE') THEN
    RAISE EXCEPTION 'You cannot update this entity' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_attribute_id
  FROM metadata_register.attribute_register
  WHERE attribute_code = btrim(p_attribute_code);

  IF v_attribute_id IS NULL THEN
    RAISE EXCEPTION 'Unknown attribute %', p_attribute_code USING ERRCODE = '22023';
  END IF;

  SELECT eav.id INTO v_id
  FROM golden_master.entity_attribute_values eav
  WHERE eav.entity_id = p_entity_id
    AND eav.attribute_id = v_attribute_id
    AND eav.system_to = '9999-12-31 23:59:59'
    AND NULLIF(btrim(eav.golden_value), '') IS NOT NULL
  ORDER BY
    (eav.golden_source_id IS NOT NULL AND eav.source_id = eav.golden_source_id) DESC,
    eav.precedence_rank ASC,
    eav.valid_from DESC
  LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No current value to confirm' USING ERRCODE = '02000';
  END IF;

  UPDATE golden_master.entity_attribute_values
  SET last_received_at = v_received
  WHERE id = v_id;

  RETURN v_received;
END;
$confirm$;

COMMENT ON FUNCTION public.confirm_attribute_receipt(uuid, text) IS
  'Stamps the prevailing attribute value as received now. The stored value and system time stay as they are.';

GRANT EXECUTE ON FUNCTION public.confirm_attribute_receipt(uuid, text) TO authenticated;
