-- Persist the golden source on every attribute value write.
-- Order: template sequence when the entity has one, then the attribute
-- sequence, then the data-source sequence. Competing source rows stay current.

CREATE OR REPLACE FUNCTION golden_master.source_codes(chain jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg(value ORDER BY ord), ARRAY[]::text[])
  FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(chain) = 'array' THEN chain ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS listed(value, ord)
  WHERE value IS NOT NULL AND value <> '' AND value <> 'MANUAL';
$$;

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
BEGIN
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

CREATE OR REPLACE FUNCTION golden_master.resolve_current_preference(p_entity_id uuid, p_attribute_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, entity_instances, metadata_register, pg_temp
AS $$
DECLARE
  v_winner uuid;
  v_tier text;
BEGIN
  SELECT decision.winner, decision.tier
    INTO v_winner, v_tier
  FROM golden_master.preference_decision(p_entity_id, p_attribute_id, NULL, NULL, NULL, false) AS decision;

  PERFORM set_config('golden_master.resolving', '1', true);
  PERFORM set_config('golden_master.resolving_id', '', true);

  UPDATE golden_master.entity_attribute_values eav
  SET golden_source_id = v_winner,
      resolution_rule_applied = v_tier,
      resolved_at = now()
  WHERE eav.entity_id = p_entity_id
    AND eav.attribute_id = p_attribute_id
    AND eav.valid_to = DATE '9999-12-31'
    AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
    AND (
      eav.golden_source_id IS DISTINCT FROM v_winner
      OR eav.resolution_rule_applied IS DISTINCT FROM v_tier
    );

  PERFORM set_config('golden_master.resolving', '0', true);
  PERFORM set_config('golden_master.resolving_id', '', true);
EXCEPTION
  WHEN OTHERS THEN
    PERFORM set_config('golden_master.resolving', '0', true);
    PERFORM set_config('golden_master.resolving_id', '', true);
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION golden_master.preference_decision(uuid, uuid, uuid, uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION golden_master.resolve_current_preference(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION golden_master.resolve_current_preference(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION golden_master.assign_golden_preference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, entity_instances, metadata_register, pg_temp
AS $$
DECLARE
  v_winner uuid;
  v_tier text;
  v_open boolean;
BEGIN
  IF current_setting('golden_master.resolving', true) = '1' THEN
    RETURN NEW;
  END IF;

  v_open := NEW.valid_to = DATE '9999-12-31'
    AND NEW.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00';

  SELECT decision.winner, decision.tier
    INTO v_winner, v_tier
  FROM golden_master.preference_decision(
    NEW.entity_id, NEW.attribute_id, NEW.id, NEW.source_id, NEW.golden_value, v_open
  ) AS decision;

  PERFORM set_config('golden_master.resolving', '1', true);
  PERFORM set_config('golden_master.resolving_id', NEW.id::text, true);

  NEW.golden_source_id := v_winner;
  NEW.resolution_rule_applied := v_tier;
  NEW.resolved_at := now();
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    PERFORM set_config('golden_master.resolving', '0', true);
    PERFORM set_config('golden_master.resolving_id', '', true);
    RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION golden_master.stamp_sibling_preference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, entity_instances, metadata_register, pg_temp
AS $$
BEGIN
  IF current_setting('golden_master.resolving', true) = '1'
     AND current_setting('golden_master.resolving_id', true) IS DISTINCT FROM NEW.id::text THEN
    RETURN NEW;
  END IF;

  UPDATE golden_master.entity_attribute_values eav
  SET golden_source_id = NEW.golden_source_id,
      resolution_rule_applied = NEW.resolution_rule_applied,
      resolved_at = NEW.resolved_at
  WHERE eav.entity_id = NEW.entity_id
    AND eav.attribute_id = NEW.attribute_id
    AND eav.id <> NEW.id
    AND eav.valid_to = DATE '9999-12-31'
    AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
    AND (
      eav.golden_source_id IS DISTINCT FROM NEW.golden_source_id
      OR eav.resolution_rule_applied IS DISTINCT FROM NEW.resolution_rule_applied
    );

  IF TG_OP = 'UPDATE' AND (OLD.entity_id IS DISTINCT FROM NEW.entity_id OR OLD.attribute_id IS DISTINCT FROM NEW.attribute_id) THEN
    PERFORM golden_master.resolve_current_preference(OLD.entity_id, OLD.attribute_id);
  END IF;

  PERFORM set_config('golden_master.resolving', '0', true);
  PERFORM set_config('golden_master.resolving_id', '', true);
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    PERFORM set_config('golden_master.resolving', '0', true);
    PERFORM set_config('golden_master.resolving_id', '', true);
    RAISE;
END;
$$;

DROP TRIGGER IF EXISTS trg_persist_golden_preference ON golden_master.entity_attribute_values;
DROP TRIGGER IF EXISTS trg_assign_golden_preference ON golden_master.entity_attribute_values;
DROP TRIGGER IF EXISTS trg_stamp_sibling_preference ON golden_master.entity_attribute_values;

CREATE TRIGGER trg_assign_golden_preference
  BEFORE INSERT OR UPDATE ON golden_master.entity_attribute_values
  FOR EACH ROW
  EXECUTE FUNCTION golden_master.assign_golden_preference();

CREATE TRIGGER trg_stamp_sibling_preference
  AFTER INSERT OR UPDATE ON golden_master.entity_attribute_values
  FOR EACH ROW
  EXECUTE FUNCTION golden_master.stamp_sibling_preference();

CREATE OR REPLACE VIEW public.entity_attribute_values AS
SELECT id,
    entity_id,
    attribute_id,
    source_id,
    source_value_id,
    golden_value,
    golden_value_jsonb,
    golden_value_numeric,
    golden_value_date,
    golden_value_timestamp,
    golden_value_boolean,
    valid_from,
    valid_to,
    system_from,
    system_to,
    precedence_rank,
    confidence_score,
    is_manual_override,
    override_reason,
    competing_values,
    resolution_rule_applied,
    metadata,
    created_at,
    created_by,
    updated_by,
    golden_source_id,
    resolution_version,
    resolved_at
FROM golden_master.entity_attribute_values;

ALTER VIEW public.entity_attribute_values SET (security_invoker = on);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entity_attribute_values TO authenticated;

CREATE OR REPLACE VIEW read_projections.entity_master AS
SELECT me.id AS entity_id,
    me.entity_code,
    me.entity_name,
    me.domain_code,
    me.template_id,
    dt.domain_name,
    COALESCE(dtpl.template_name, 'Default'::character varying) AS template_name,
    me.description,
    me.is_active,
    COALESCE(jsonb_object_agg(ar.attribute_code, jsonb_build_object(
        'value', eav.golden_value,
        'value_numeric', eav.golden_value_numeric,
        'value_date', eav.golden_value_date,
        'value_timestamp', eav.golden_value_timestamp,
        'source_id', eav.source_id,
        'source_code', sr.source_code,
        'golden_source_id', eav.golden_source_id,
        'precedence_rank', eav.precedence_rank,
        'valid_from', eav.valid_from,
        'valid_to', eav.valid_to
    )) FILTER (WHERE ar.attribute_code IS NOT NULL), '{}'::jsonb) AS attributes,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object(
            'parent_entity_id', er.parent_entity_id,
            'parent_entity_code', parent_me.entity_code,
            'parent_entity_name', parent_me.entity_name,
            'parent_domain_code', parent_me.domain_code,
            'relationship_type', er.relationship_type,
            'relationship_code', er.relationship_code,
            'is_primary', er.is_primary))
           FROM entity_instances.entity_relationships er
             JOIN entity_instances.master_entities parent_me ON parent_me.id = er.parent_entity_id
          WHERE er.child_entity_id = me.id AND er.valid_to = '9999-12-31'::date AND er.system_to = '9999-12-31 23:59:59+00'::timestamp with time zone), '[]'::jsonb) AS parent_relationships,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object(
            'child_entity_id', er.child_entity_id,
            'child_entity_code', child_me.entity_code,
            'child_entity_name', child_me.entity_name,
            'child_domain_code', child_me.domain_code,
            'relationship_type', er.relationship_type,
            'relationship_code', er.relationship_code,
            'is_primary', er.is_primary))
           FROM entity_instances.entity_relationships er
             JOIN entity_instances.master_entities child_me ON child_me.id = er.child_entity_id
          WHERE er.parent_entity_id = me.id AND er.valid_to = '9999-12-31'::date AND er.system_to = '9999-12-31 23:59:59+00'::timestamp with time zone), '[]'::jsonb) AS child_relationships,
    me.metadata,
    me.created_at,
    me.updated_at
FROM entity_instances.master_entities me
LEFT JOIN metadata_register.domain_types dt ON dt.domain_code::text = me.domain_code::text
LEFT JOIN metadata_register.domain_templates dtpl ON dtpl.id = me.template_id
LEFT JOIN LATERAL (
    SELECT DISTINCT ON (eav.attribute_id)
        eav.attribute_id,
        eav.golden_value,
        eav.golden_value_numeric,
        eav.golden_value_date,
        eav.golden_value_timestamp,
        eav.source_id,
        eav.golden_source_id,
        eav.precedence_rank,
        eav.valid_from,
        eav.valid_to
    FROM golden_master.entity_attribute_values eav
    WHERE eav.entity_id = me.id
      AND eav.valid_to = DATE '9999-12-31'
      AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
    ORDER BY eav.attribute_id,
      CASE
        WHEN eav.golden_source_id IS NOT NULL
          AND eav.source_id = eav.golden_source_id
          AND eav.golden_value IS NOT NULL
          AND btrim(eav.golden_value) <> '' THEN 0
        WHEN eav.golden_value IS NOT NULL AND btrim(eav.golden_value) <> '' THEN 1
        ELSE 2
      END,
      eav.precedence_rank
) eav ON true
LEFT JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
LEFT JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
WHERE me.is_active = true
GROUP BY me.id, me.entity_code, me.entity_name, me.domain_code, me.template_id, dt.domain_name, dtpl.template_name, me.description, me.is_active, me.metadata, me.created_at, me.updated_at;

ALTER VIEW read_projections.entity_master SET (security_invoker = on);
ALTER VIEW public.entity_master SET (security_invoker = on);

NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  pair record;
BEGIN
  FOR pair IN
    SELECT DISTINCT entity_id, attribute_id
    FROM golden_master.entity_attribute_values
    WHERE valid_to = DATE '9999-12-31'
      AND system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
  LOOP
    PERFORM golden_master.resolve_current_preference(pair.entity_id, pair.attribute_id);
  END LOOP;
END $$;
