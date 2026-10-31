-- Client-owned schema additions beside the shared catalog.
--
-- domain_types, attribute_register, domain_templates, and relationship_types
-- gain a nullable client_id. NULL remains a global definition, visible to every
-- client. A non-null value is a definition owned by that client.
--
-- Codes stay globally unique. Existing foreign keys and lookups use those codes,
-- and a partial unique index cannot be the target of a foreign key. Two clients
-- therefore cannot both define the same code; a client addition uses a new code.

ALTER TABLE metadata_register.domain_types
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);

ALTER TABLE metadata_register.attribute_register
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);

ALTER TABLE metadata_register.domain_templates
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);

ALTER TABLE metadata_register.relationship_types
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);

COMMENT ON COLUMN metadata_register.domain_types.client_id IS
  'Owning client. NULL is a global entity type visible to every client.';
COMMENT ON COLUMN metadata_register.attribute_register.client_id IS
  'Owning client. NULL is a global attribute visible to every client.';
COMMENT ON COLUMN metadata_register.domain_templates.client_id IS
  'Owning client. NULL is a global template visible to every client.';
COMMENT ON COLUMN metadata_register.relationship_types.client_id IS
  'Owning client. NULL is a global relationship type visible to every client.';

CREATE INDEX IF NOT EXISTS idx_domain_types_client
  ON metadata_register.domain_types(client_id);
CREATE INDEX IF NOT EXISTS idx_attribute_register_client
  ON metadata_register.attribute_register(client_id);
CREATE INDEX IF NOT EXISTS idx_domain_templates_client
  ON metadata_register.domain_templates(client_id);
CREATE INDEX IF NOT EXISTS idx_relationship_types_client
  ON metadata_register.relationship_types(client_id);

-- Visibility and write checks used by the policies below.
CREATE OR REPLACE FUNCTION tenancy.schema_row_visible(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT p_client_id IS NULL
    OR p_client_id IN (SELECT tenancy.current_client_ids())
    OR (
      tenancy.is_tenant_admin()
      AND tenancy.active_impersonation_client_id() IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION tenancy.can_write_schema_row(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
  SELECT CASE
    WHEN tenancy.is_tenant_admin()
      AND tenancy.active_impersonation_client_id() IS NULL THEN TRUE
    WHEN p_client_id IS NULL THEN FALSE
    ELSE tenancy.has_permission(p_client_id, 'entity.write')
      AND p_client_id IN (SELECT tenancy.current_client_ids())
  END;
$$;

COMMENT ON FUNCTION tenancy.schema_row_visible(UUID) IS
  'TRUE for global rows, the caller''s current clients, and a tenant admin who is not impersonating.';
COMMENT ON FUNCTION tenancy.can_write_schema_row(UUID) IS
  'A tenant admin who is not impersonating can write any row, including global. Everyone else can write only a current client row they have entity.write on.';

GRANT EXECUTE ON FUNCTION tenancy.schema_row_visible(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION tenancy.can_write_schema_row(UUID) TO authenticated;

-- Replace the open SELECT and tenant-admin-sees-everything policies.
-- A new restrictive policy would not hide rows while USING (true) still exists,
-- and a FOR ALL tenant-admin policy also grants SELECT of every row while impersonating.

DROP POLICY IF EXISTS "Metadata register readable by authenticated" ON metadata_register.domain_types;
DROP POLICY IF EXISTS domain_types_write_tenant_admin ON metadata_register.domain_types;
DROP POLICY IF EXISTS domain_types_select_scoped ON metadata_register.domain_types;
DROP POLICY IF EXISTS domain_types_insert_scoped ON metadata_register.domain_types;
DROP POLICY IF EXISTS domain_types_update_scoped ON metadata_register.domain_types;
DROP POLICY IF EXISTS domain_types_delete_scoped ON metadata_register.domain_types;
DROP POLICY IF EXISTS "Attribute register readable by authenticated" ON metadata_register.attribute_register;
DROP POLICY IF EXISTS attribute_register_write_tenant_admin ON metadata_register.attribute_register;
DROP POLICY IF EXISTS attribute_register_select_scoped ON metadata_register.attribute_register;
DROP POLICY IF EXISTS attribute_register_insert_scoped ON metadata_register.attribute_register;
DROP POLICY IF EXISTS attribute_register_update_scoped ON metadata_register.attribute_register;
DROP POLICY IF EXISTS attribute_register_delete_scoped ON metadata_register.attribute_register;
DROP POLICY IF EXISTS "Domain templates readable by authenticated" ON metadata_register.domain_templates;
DROP POLICY IF EXISTS domain_templates_write_tenant_admin ON metadata_register.domain_templates;
DROP POLICY IF EXISTS domain_templates_select_scoped ON metadata_register.domain_templates;
DROP POLICY IF EXISTS domain_templates_insert_scoped ON metadata_register.domain_templates;
DROP POLICY IF EXISTS domain_templates_update_scoped ON metadata_register.domain_templates;
DROP POLICY IF EXISTS domain_templates_delete_scoped ON metadata_register.domain_templates;
DROP POLICY IF EXISTS relationship_types_select_authenticated ON metadata_register.relationship_types;
DROP POLICY IF EXISTS relationship_types_write_tenant_admin ON metadata_register.relationship_types;
DROP POLICY IF EXISTS relationship_types_select_scoped ON metadata_register.relationship_types;
DROP POLICY IF EXISTS relationship_types_insert_scoped ON metadata_register.relationship_types;
DROP POLICY IF EXISTS relationship_types_update_scoped ON metadata_register.relationship_types;
DROP POLICY IF EXISTS relationship_types_delete_scoped ON metadata_register.relationship_types;

CREATE POLICY domain_types_select_scoped ON metadata_register.domain_types
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY domain_types_insert_scoped ON metadata_register.domain_types
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY domain_types_update_scoped ON metadata_register.domain_types
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY domain_types_delete_scoped ON metadata_register.domain_types
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(client_id));

CREATE POLICY attribute_register_select_scoped ON metadata_register.attribute_register
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY attribute_register_insert_scoped ON metadata_register.attribute_register
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY attribute_register_update_scoped ON metadata_register.attribute_register
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY attribute_register_delete_scoped ON metadata_register.attribute_register
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(client_id));

CREATE POLICY domain_templates_select_scoped ON metadata_register.domain_templates
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY domain_templates_insert_scoped ON metadata_register.domain_templates
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY domain_templates_update_scoped ON metadata_register.domain_templates
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY domain_templates_delete_scoped ON metadata_register.domain_templates
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(client_id));

CREATE POLICY relationship_types_select_scoped ON metadata_register.relationship_types
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY relationship_types_insert_scoped ON metadata_register.relationship_types
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY relationship_types_update_scoped ON metadata_register.relationship_types
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY relationship_types_delete_scoped ON metadata_register.relationship_types
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(client_id));

-- Public views were frozen before client_id existed. Append the column.
-- security_invoker makes those views honor the policies above.

CREATE OR REPLACE VIEW public.domain_types AS
SELECT
  id,
  domain_code,
  domain_name,
  description,
  is_active,
  created_at,
  updated_at,
  temporal_model,
  as_of_date_granularity,
  as_of_date_label,
  client_id
FROM metadata_register.domain_types;

CREATE OR REPLACE VIEW public.domain_templates AS
SELECT
  id,
  template_code,
  domain_code,
  template_name,
  description,
  is_active,
  precedence_rules,
  metadata,
  created_at,
  updated_at,
  applicability_rules,
  client_id
FROM metadata_register.domain_templates;

CREATE OR REPLACE VIEW public.relationship_types AS
SELECT
  id,
  relationship_code,
  relationship_name,
  parent_domain_code,
  child_domain_code,
  description,
  is_active,
  created_at,
  is_required,
  cardinality,
  composite_key,
  client_id
FROM metadata_register.relationship_types;

CREATE OR REPLACE VIEW public.attribute_register AS
SELECT
  id,
  attribute_code,
  attribute_name,
  data_type,
  description,
  unit_of_measure,
  validation_regex,
  is_required,
  is_multi_valued,
  reference_domain_code,
  default_precedence_rank,
  metadata,
  created_at,
  updated_at,
  is_derived,
  display_format,
  list_values,
  validation_rules,
  default_value,
  display_section,
  display_group,
  is_editable,
  is_visible,
  derivation_formula,
  derivation_dependencies,
  derivation_type,
  formula_language,
  aggregation_type,
  weight_attribute_code,
  numeric_precision,
  domain_code,
  reference_list_code,
  is_time_varying,
  time_dimension,
  client_id
FROM metadata_register.attribute_register;

CREATE OR REPLACE VIEW public.master_entities AS
SELECT
  id,
  entity_code,
  domain_code,
  template_id,
  entity_name,
  description,
  is_active,
  is_archived,
  metadata,
  created_at,
  updated_at,
  created_by,
  updated_by,
  client_id
FROM entity_instances.master_entities;

ALTER VIEW public.domain_types SET (security_invoker = on);
ALTER VIEW public.domain_templates SET (security_invoker = on);
ALTER VIEW public.relationship_types SET (security_invoker = on);
ALTER VIEW public.attribute_register SET (security_invoker = on);
ALTER VIEW public.master_entities SET (security_invoker = on);

-- The attribute catalog RPC previously ran as its owner and skipped row security.
CREATE OR REPLACE FUNCTION public.get_attributes_with_aggregation(p_domain_code character varying DEFAULT NULL::character varying)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT COALESCE(
    (
      SELECT jsonb_agg(attr_obj)
      FROM (
        SELECT jsonb_build_object(
          'id', id,
          'attribute_code', attribute_code,
          'attribute_name', attribute_name,
          'data_type', data_type,
          'description', description,
          'unit_of_measure', unit_of_measure,
          'is_required', is_required,
          'is_multi_valued', is_multi_valued,
          'reference_domain_code', reference_domain_code,
          'reference_list_code', reference_list_code,
          'domain_code', domain_code,
          'client_id', client_id,
          'default_precedence_rank', default_precedence_rank,
          'is_derived', is_derived,
          'derivation_type', derivation_type,
          'derivation_formula', derivation_formula,
          'derivation_dependencies', derivation_dependencies,
          'display_format', display_format,
          'list_values', list_values,
          'validation_rules', validation_rules,
          'default_value', default_value,
          'display_section', display_section,
          'display_group', display_group,
          'is_editable', is_editable,
          'is_visible', is_visible,
          'aggregation_type', COALESCE(aggregation_type, 'NONE'),
          'weight_attribute_code', weight_attribute_code,
          'numeric_precision', numeric_precision
        ) AS attr_obj
        FROM metadata_register.attribute_register
        WHERE (p_domain_code IS NULL OR domain_code = p_domain_code OR domain_code IS NULL)
          AND (is_derived = false OR is_derived IS NULL)
        ORDER BY attribute_code
      ) sub
    ),
    '[]'::jsonb
  )
  INTO v_result;
  RETURN v_result;
END;
$$;

-- A client definition may use a global entity type or one owned by the same client.
-- A global definition may use only global entity types.
CREATE OR REPLACE FUNCTION metadata_register.assert_domain_visible_to_client(
  p_domain_code TEXT,
  p_client_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
  v_domain_client UUID;
BEGIN
  IF p_domain_code IS NULL THEN
    RETURN;
  END IF;

  SELECT client_id INTO v_domain_client
  FROM metadata_register.domain_types
  WHERE domain_code = p_domain_code;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown entity type %', p_domain_code
      USING ERRCODE = '23503';
  END IF;

  IF p_client_id IS NULL AND v_domain_client IS NOT NULL THEN
    RAISE EXCEPTION 'A global definition cannot use client-specific entity type %', p_domain_code
      USING ERRCODE = '42501';
  END IF;

  IF v_domain_client IS NOT NULL AND v_domain_client IS DISTINCT FROM p_client_id THEN
    RAISE EXCEPTION 'Entity type % belongs to a different client', p_domain_code
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION metadata_register.enforce_attribute_schema_client()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata_register, pg_temp
AS $$
BEGIN
  PERFORM metadata_register.assert_domain_visible_to_client(NEW.domain_code, NEW.client_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION metadata_register.enforce_template_schema_client()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata_register, pg_temp
AS $$
BEGIN
  PERFORM metadata_register.assert_domain_visible_to_client(NEW.domain_code, NEW.client_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION metadata_register.enforce_relationship_type_schema_client()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata_register, pg_temp
AS $$
BEGIN
  PERFORM metadata_register.assert_domain_visible_to_client(NEW.parent_domain_code, NEW.client_id);
  PERFORM metadata_register.assert_domain_visible_to_client(NEW.child_domain_code, NEW.client_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attribute_register_schema_client ON metadata_register.attribute_register;
CREATE TRIGGER attribute_register_schema_client
  BEFORE INSERT OR UPDATE ON metadata_register.attribute_register
  FOR EACH ROW
  EXECUTE FUNCTION metadata_register.enforce_attribute_schema_client();

DROP TRIGGER IF EXISTS domain_templates_schema_client ON metadata_register.domain_templates;
CREATE TRIGGER domain_templates_schema_client
  BEFORE INSERT OR UPDATE ON metadata_register.domain_templates
  FOR EACH ROW
  EXECUTE FUNCTION metadata_register.enforce_template_schema_client();

DROP TRIGGER IF EXISTS relationship_types_schema_client ON metadata_register.relationship_types;
CREATE TRIGGER relationship_types_schema_client
  BEFORE INSERT OR UPDATE ON metadata_register.relationship_types
  FOR EACH ROW
  EXECUTE FUNCTION metadata_register.enforce_relationship_type_schema_client();

-- Entity records may use a global entity type or one owned by the same client.
CREATE OR REPLACE FUNCTION entity_instances.enforce_entity_domain_client()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = entity_instances, metadata_register, pg_temp
AS $$
BEGIN
  PERFORM metadata_register.assert_domain_visible_to_client(NEW.domain_code, NEW.client_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS master_entities_domain_client ON entity_instances.master_entities;
CREATE TRIGGER master_entities_domain_client
  BEFORE INSERT OR UPDATE OF domain_code, client_id ON entity_instances.master_entities
  FOR EACH ROW
  EXECUTE FUNCTION entity_instances.enforce_entity_domain_client();

-- A relationship connects two records of the same client, using a global
-- relationship type or one owned by that client.
CREATE OR REPLACE FUNCTION entity_instances.enforce_relationship_client()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = entity_instances, metadata_register, pg_temp
AS $$
DECLARE
  v_parent_client UUID;
  v_child_client UUID;
  v_type_client UUID;
BEGIN
  SELECT client_id INTO v_parent_client
  FROM entity_instances.master_entities
  WHERE id = NEW.parent_entity_id;

  SELECT client_id INTO v_child_client
  FROM entity_instances.master_entities
  WHERE id = NEW.child_entity_id;

  IF v_parent_client IS DISTINCT FROM v_child_client THEN
    RAISE EXCEPTION 'Relationships must connect entities of the same client'
      USING ERRCODE = '42501';
  END IF;

  SELECT client_id INTO v_type_client
  FROM metadata_register.relationship_types
  WHERE relationship_code IN (NEW.relationship_type, NEW.relationship_code)
  LIMIT 1;

  IF FOUND AND v_type_client IS NOT NULL AND v_type_client IS DISTINCT FROM v_parent_client THEN
    RAISE EXCEPTION 'Relationship type belongs to a different client'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_relationships_client ON entity_instances.entity_relationships;
CREATE TRIGGER entity_relationships_client
  BEFORE INSERT OR UPDATE ON entity_instances.entity_relationships
  FOR EACH ROW
  EXECUTE FUNCTION entity_instances.enforce_relationship_client();

-- Attribute values may use a global attribute or one owned by the entity's client.
CREATE OR REPLACE FUNCTION entity_instances.enforce_attribute_value_client()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = entity_instances, metadata_register, pg_temp
AS $$
DECLARE
  v_entity_client UUID;
  v_attribute_client UUID;
BEGIN
  SELECT client_id INTO v_entity_client
  FROM entity_instances.master_entities
  WHERE id = NEW.entity_id;

  SELECT client_id INTO v_attribute_client
  FROM metadata_register.attribute_register
  WHERE id = NEW.attribute_id;

  IF v_attribute_client IS NOT NULL AND v_attribute_client IS DISTINCT FROM v_entity_client THEN
    RAISE EXCEPTION 'Attribute belongs to a different client'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_attribute_values_client ON golden_master.entity_attribute_values;
CREATE TRIGGER entity_attribute_values_client
  BEFORE INSERT OR UPDATE ON golden_master.entity_attribute_values
  FOR EACH ROW
  EXECUTE FUNCTION entity_instances.enforce_attribute_value_client();

DROP TRIGGER IF EXISTS source_attribute_values_client ON entity_instances.source_attribute_values;
CREATE TRIGGER source_attribute_values_client
  BEFORE INSERT OR UPDATE ON entity_instances.source_attribute_values
  FOR EACH ROW
  EXECUTE FUNCTION entity_instances.enforce_attribute_value_client();

NOTIFY pgrst, 'reload schema';
