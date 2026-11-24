-- Client-owned reference lists.
--
-- Entity types, attributes, templates and relationship types already carry a
-- nullable client_id (20261013145919_client_schema_scope). Reference lists did
-- not, so a client's own taxonomy (for example a strategy tree its attributes
-- draw from) had to be a global list every client could see.
--
-- reference_lists gains the same nullable client_id. NULL stays a global list.
-- A list's values follow their list. Visibility and writes use the checks the
-- other schema tables use: tenancy.schema_row_visible and
-- tenancy.can_write_schema_row. List codes stay globally unique, as entity type
-- and attribute codes do.

ALTER TABLE metadata_register.reference_lists
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id);

COMMENT ON COLUMN metadata_register.reference_lists.client_id IS
  'Owning client. NULL is a global list visible to every client.';

CREATE INDEX IF NOT EXISTS idx_reference_lists_client
  ON metadata_register.reference_lists(client_id);

-- Whether the caller may see or change a list's values: the list decides.
CREATE OR REPLACE FUNCTION metadata_register.reference_list_client(p_list_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = metadata_register, pg_temp
AS $$
  SELECT client_id FROM metadata_register.reference_lists WHERE id = p_list_id;
$$;

COMMENT ON FUNCTION metadata_register.reference_list_client(UUID) IS
  'Owning client of a reference list, NULL for a global list. Used by the value policies.';

REVOKE ALL ON FUNCTION metadata_register.reference_list_client(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION metadata_register.reference_list_client(UUID) TO authenticated;

DROP POLICY IF EXISTS "Reference lists readable by authenticated" ON metadata_register.reference_lists;
DROP POLICY IF EXISTS reference_lists_write_tenant_admin ON metadata_register.reference_lists;
DROP POLICY IF EXISTS reference_lists_select_scoped ON metadata_register.reference_lists;
DROP POLICY IF EXISTS reference_lists_insert_scoped ON metadata_register.reference_lists;
DROP POLICY IF EXISTS reference_lists_update_scoped ON metadata_register.reference_lists;
DROP POLICY IF EXISTS reference_lists_delete_scoped ON metadata_register.reference_lists;

CREATE POLICY reference_lists_select_scoped ON metadata_register.reference_lists
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY reference_lists_insert_scoped ON metadata_register.reference_lists
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY reference_lists_update_scoped ON metadata_register.reference_lists
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY reference_lists_delete_scoped ON metadata_register.reference_lists
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(client_id));

DROP POLICY IF EXISTS "Reference values readable by authenticated" ON metadata_register.reference_list_values;
DROP POLICY IF EXISTS reference_list_values_write_tenant_admin ON metadata_register.reference_list_values;
DROP POLICY IF EXISTS reference_list_values_select_scoped ON metadata_register.reference_list_values;
DROP POLICY IF EXISTS reference_list_values_insert_scoped ON metadata_register.reference_list_values;
DROP POLICY IF EXISTS reference_list_values_update_scoped ON metadata_register.reference_list_values;
DROP POLICY IF EXISTS reference_list_values_delete_scoped ON metadata_register.reference_list_values;

CREATE POLICY reference_list_values_select_scoped ON metadata_register.reference_list_values
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(metadata_register.reference_list_client(list_id)));
CREATE POLICY reference_list_values_insert_scoped ON metadata_register.reference_list_values
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(metadata_register.reference_list_client(list_id)));
CREATE POLICY reference_list_values_update_scoped ON metadata_register.reference_list_values
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(metadata_register.reference_list_client(list_id)))
  WITH CHECK (tenancy.can_write_schema_row(metadata_register.reference_list_client(list_id)));
CREATE POLICY reference_list_values_delete_scoped ON metadata_register.reference_list_values
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(metadata_register.reference_list_client(list_id)));

-- An attribute may draw only from a global list or its own client's list.
CREATE OR REPLACE FUNCTION metadata_register.guard_attribute_reference_list()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
  v_list_client UUID;
BEGIN
  IF NEW.reference_list_code IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT client_id INTO v_list_client
  FROM metadata_register.reference_lists
  WHERE list_code = NEW.reference_list_code;
  IF v_list_client IS NOT NULL AND v_list_client IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'Reference list % belongs to another client', NEW.reference_list_code USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION metadata_register.guard_attribute_reference_list() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_attribute_reference_list ON metadata_register.attribute_register;
CREATE TRIGGER guard_attribute_reference_list
  BEFORE INSERT OR UPDATE OF reference_list_code, client_id ON metadata_register.attribute_register
  FOR EACH ROW EXECUTE FUNCTION metadata_register.guard_attribute_reference_list();

-- The public views run as the caller, so the policies above apply through them.
-- Recreate reference_lists with the new column at the end.
CREATE OR REPLACE VIEW public.reference_lists WITH (security_invoker = on) AS
  SELECT id, list_code, list_name, domain_code, description, is_active, created_at, updated_at, client_id
  FROM metadata_register.reference_lists;
