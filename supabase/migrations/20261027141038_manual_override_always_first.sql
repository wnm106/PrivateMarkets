-- The attribute editor pins Manual override at position 1 for every field.
-- Resolution was only doing that for calculated attributes, and it strips
-- MANUAL out of every saved sequence. A manual value now wins whenever one
-- is open, then a calculated result, then the template, attribute, or
-- data-source sequence.

CREATE OR REPLACE FUNCTION golden_master.preference_decision(
  p_entity_id uuid,
  p_attribute_id uuid,
  p_exclude_id uuid,
  p_extra_source_id uuid,
  p_extra_value text,
  p_extra_open boolean,
  OUT winner uuid,
  OUT tier text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = golden_master, entity_instances, metadata_register, pg_temp
AS $$
DECLARE
  v_template_id uuid;
  v_template_chain jsonb;
  v_column_chain jsonb;
  v_metadata jsonb;
  v_attribute_chain jsonb;
  v_chain text[];
  v_calculated boolean;
BEGIN
  SELECT eav.source_id INTO winner
  FROM golden_master.entity_attribute_values eav
  JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
  WHERE eav.entity_id = p_entity_id
    AND eav.attribute_id = p_attribute_id
    AND eav.id IS DISTINCT FROM p_exclude_id
    AND eav.valid_to = DATE '9999-12-31'
    AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
    AND sr.source_code = 'MANUAL'
    AND eav.golden_value IS NOT NULL
    AND btrim(eav.golden_value) <> '';

  IF winner IS NULL AND p_extra_open AND p_extra_value IS NOT NULL AND btrim(p_extra_value) <> '' THEN
    SELECT sr.id INTO winner
    FROM entity_instances.source_registry sr
    WHERE sr.id = p_extra_source_id
      AND sr.source_code = 'MANUAL';
  END IF;

  IF winner IS NOT NULL THEN
    tier := 'MANUAL_OVERRIDE';
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM metadata_register.calc_definitions cd
    WHERE cd.attribute_id = p_attribute_id
  ) INTO v_calculated;

  IF v_calculated THEN
    winner := NULL;
    SELECT eav.source_id INTO winner
    FROM golden_master.entity_attribute_values eav
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE eav.entity_id = p_entity_id
      AND eav.attribute_id = p_attribute_id
      AND eav.id IS DISTINCT FROM p_exclude_id
      AND eav.valid_to = DATE '9999-12-31'
      AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
      AND sr.source_code = 'DERIVED'
      AND eav.golden_value IS NOT NULL
      AND btrim(eav.golden_value) <> '';

    IF winner IS NULL AND p_extra_open AND p_extra_value IS NOT NULL AND btrim(p_extra_value) <> '' THEN
      SELECT sr.id INTO winner
      FROM entity_instances.source_registry sr
      WHERE sr.id = p_extra_source_id
        AND sr.source_code = 'DERIVED';
    END IF;

    IF winner IS NOT NULL THEN
      tier := 'CALCULATED';
      RETURN;
    END IF;
  END IF;

  SELECT me.template_id INTO v_template_id
  FROM entity_instances.master_entities me
  WHERE me.id = p_entity_id;

  IF v_template_id IS NOT NULL THEN
    SELECT taa.default_precedence_chain INTO v_template_chain
    FROM metadata_register.template_attribute_assignments taa
    WHERE taa.template_id = v_template_id
      AND taa.attribute_id = p_attribute_id;
  END IF;

  v_chain := golden_master.source_codes(v_template_chain);
  IF COALESCE(array_length(v_chain, 1), 0) > 0 THEN
    tier := 'TEMPLATE_SEQUENCE';
  ELSE
    SELECT ar.default_precedence_chain, ar.metadata
      INTO v_column_chain, v_metadata
    FROM metadata_register.attribute_register ar
    WHERE ar.id = p_attribute_id;

    v_attribute_chain := CASE
      WHEN jsonb_typeof(v_column_chain) = 'array' AND jsonb_array_length(v_column_chain) > 0 THEN v_column_chain
      WHEN jsonb_typeof(v_metadata -> 'defaultPrecedenceChain') = 'array' THEN v_metadata -> 'defaultPrecedenceChain'
      ELSE '[]'::jsonb
    END;
    v_chain := golden_master.source_codes(v_attribute_chain);
    IF COALESCE(array_length(v_chain, 1), 0) > 0 THEN
      tier := 'ATTRIBUTE_SEQUENCE';
    ELSE
      SELECT COALESCE(array_agg(sr.source_code ORDER BY sr.precedence_rank, sr.source_code), ARRAY[]::text[])
        INTO v_chain
      FROM entity_instances.source_registry sr
      WHERE sr.is_active = true
        AND sr.source_code <> 'MANUAL';
      tier := 'DATA_SOURCE_SEQUENCE';
    END IF;
  END IF;

  SELECT picked.source_id INTO winner
  FROM (
    SELECT eav.source_id,
      COALESCE(array_position(v_chain, sr.source_code::text), 1000000 + COALESCE(sr.precedence_rank, 9999)) AS sort_key
    FROM golden_master.entity_attribute_values eav
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE eav.entity_id = p_entity_id
      AND eav.attribute_id = p_attribute_id
      AND eav.id IS DISTINCT FROM p_exclude_id
      AND eav.valid_to = DATE '9999-12-31'
      AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
      AND eav.golden_value IS NOT NULL
      AND btrim(eav.golden_value) <> ''
    UNION ALL
    SELECT sr.id,
      COALESCE(array_position(v_chain, sr.source_code::text), 1000000 + COALESCE(sr.precedence_rank, 9999))
    FROM entity_instances.source_registry sr
    WHERE p_extra_open
      AND sr.id = p_extra_source_id
      AND p_extra_value IS NOT NULL
      AND btrim(p_extra_value) <> ''
  ) picked
  ORDER BY picked.sort_key, picked.source_id
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION golden_master.preference_decision(uuid, uuid, uuid, uuid, text, boolean) IS
  'Winning source for the open value. Manual Entry wins when it has a value. A calculated result wins next. Otherwise the template sequence, the attribute sequence, then the data-source sequence.';

-- Restamp open values where a manual entry is present and is not already the winner.
DO $backfill$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT eav.entity_id, eav.attribute_id
    FROM golden_master.entity_attribute_values eav
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE eav.valid_to = DATE '9999-12-31'
      AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
      AND sr.source_code = 'MANUAL'
      AND eav.golden_value IS NOT NULL
      AND btrim(eav.golden_value) <> ''
      AND eav.golden_source_id IS DISTINCT FROM sr.id
  LOOP
    PERFORM golden_master.resolve_current_preference(r.entity_id, r.attribute_id);
  END LOOP;
END;
$backfill$;
