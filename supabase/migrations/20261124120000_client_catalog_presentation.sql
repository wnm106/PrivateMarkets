-- What a client calls an entity type, and which shared fields it hides.
--
-- Entity types and attributes are one catalog. A client could add its own, and
-- a curated client could have whole entity types turned off, but it could not
-- call ISSUER "Borrower" or put away shared fields it does not use.
--
-- Two tables hold the difference as data, one row per client:
--   client_domain_settings     the client's name for an entity type
--   client_attribute_settings  a shared field the client hides
--
-- One place decides whose words a session reads, tenancy.presentation_client_id.
-- The public views public.domain_types and public.attribute_register apply it:
-- domain_name is the client's name where it has one, and is_visible is false
-- for a field the client hides. Every reader of those two columns follows with
-- no change. The catalog's own values stay readable as catalog_domain_name and
-- catalog_is_visible, and the catalog is still written in metadata_register.
--
-- Hiding is display only, like the catalog's own is_visible flag: values,
-- calculations, compliance and saved views keep working.

-- ============================================================
-- 1. Settings
-- ============================================================
CREATE TABLE IF NOT EXISTS metadata_register.client_domain_settings (
  client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
  domain_code VARCHAR(50) NOT NULL
    REFERENCES metadata_register.domain_types(domain_code) ON UPDATE CASCADE ON DELETE CASCADE,
  display_name VARCHAR(200) NOT NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, domain_code),
  CONSTRAINT client_domain_settings_name_not_blank CHECK (btrim(display_name) <> '')
);

-- A client does not give two entity types the same name.
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_domain_settings_name
  ON metadata_register.client_domain_settings (client_id, lower(btrim(display_name)));

COMMENT ON TABLE metadata_register.client_domain_settings IS
  'What one client calls an entity type. The code and the catalog name do not change.';

CREATE TABLE IF NOT EXISTS metadata_register.client_attribute_settings (
  client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
  attribute_id UUID NOT NULL REFERENCES metadata_register.attribute_register(id) ON DELETE CASCADE,
  is_hidden BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, attribute_id)
);

COMMENT ON TABLE metadata_register.client_attribute_settings IS
  'A field one client hides. Display only: the value is still stored, calculated and checked.';

ALTER TABLE metadata_register.client_domain_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.client_attribute_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_domain_settings_select ON metadata_register.client_domain_settings;
DROP POLICY IF EXISTS client_domain_settings_insert ON metadata_register.client_domain_settings;
DROP POLICY IF EXISTS client_domain_settings_update ON metadata_register.client_domain_settings;
DROP POLICY IF EXISTS client_domain_settings_delete ON metadata_register.client_domain_settings;
CREATE POLICY client_domain_settings_select ON metadata_register.client_domain_settings
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY client_domain_settings_insert ON metadata_register.client_domain_settings
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY client_domain_settings_update ON metadata_register.client_domain_settings
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY client_domain_settings_delete ON metadata_register.client_domain_settings
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(client_id));

DROP POLICY IF EXISTS client_attribute_settings_select ON metadata_register.client_attribute_settings;
DROP POLICY IF EXISTS client_attribute_settings_insert ON metadata_register.client_attribute_settings;
DROP POLICY IF EXISTS client_attribute_settings_update ON metadata_register.client_attribute_settings;
DROP POLICY IF EXISTS client_attribute_settings_delete ON metadata_register.client_attribute_settings;
CREATE POLICY client_attribute_settings_select ON metadata_register.client_attribute_settings
  FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
CREATE POLICY client_attribute_settings_insert ON metadata_register.client_attribute_settings
  FOR INSERT TO authenticated
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY client_attribute_settings_update ON metadata_register.client_attribute_settings
  FOR UPDATE TO authenticated
  USING (tenancy.can_write_schema_row(client_id))
  WITH CHECK (tenancy.can_write_schema_row(client_id));
CREATE POLICY client_attribute_settings_delete ON metadata_register.client_attribute_settings
  FOR DELETE TO authenticated
  USING (tenancy.can_write_schema_row(client_id));

REVOKE ALL ON metadata_register.client_domain_settings FROM PUBLIC, anon;
REVOKE ALL ON metadata_register.client_attribute_settings FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.client_domain_settings TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.client_attribute_settings TO authenticated, service_role;

-- A client names only an entity type it can see: a global one or its own.
CREATE OR REPLACE FUNCTION metadata_register.guard_client_domain_setting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata_register, pg_temp
AS $$
BEGIN
  PERFORM metadata_register.assert_domain_visible_to_client(NEW.domain_code, NEW.client_id);
  NEW.display_name := btrim(NEW.display_name);
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- A client hides only a field it can see, and never one every record must have:
-- a required field nobody can see cannot be filled in.
CREATE OR REPLACE FUNCTION metadata_register.guard_client_attribute_setting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
  v_attribute_client UUID;
  v_required BOOLEAN;
  v_name TEXT;
BEGIN
  SELECT client_id, COALESCE(is_required, FALSE), attribute_name
    INTO v_attribute_client, v_required, v_name
  FROM metadata_register.attribute_register
  WHERE id = NEW.attribute_id;

  IF v_attribute_client IS NOT NULL AND v_attribute_client IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'Attribute belongs to a different client' USING ERRCODE = '42501';
  END IF;
  IF NEW.is_hidden AND v_required THEN
    RAISE EXCEPTION '% is required on every record, so it cannot be hidden', v_name USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION metadata_register.guard_client_domain_setting() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION metadata_register.guard_client_attribute_setting() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_client_domain_setting ON metadata_register.client_domain_settings;
CREATE TRIGGER guard_client_domain_setting
  BEFORE INSERT OR UPDATE ON metadata_register.client_domain_settings
  FOR EACH ROW EXECUTE FUNCTION metadata_register.guard_client_domain_setting();

DROP TRIGGER IF EXISTS guard_client_attribute_setting ON metadata_register.client_attribute_settings;
CREATE TRIGGER guard_client_attribute_setting
  BEFORE INSERT OR UPDATE ON metadata_register.client_attribute_settings
  FOR EACH ROW EXECUTE FUNCTION metadata_register.guard_client_attribute_setting();

-- ============================================================
-- 2. Whose words a session reads
-- ============================================================
-- The one client a session is working in: the client staff are simulating, the
-- client the sign-in chose, or the person's only client. NULL for staff who are
-- not simulating a client and for a session that spans several clients; those
-- read the catalog's own names and every field.
CREATE OR REPLACE FUNCTION tenancy.presentation_client_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
  v_ids UUID[];
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;
  IF tenancy.is_tenant_admin() AND tenancy.active_impersonation_client_id() IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT array_agg(c) INTO v_ids FROM tenancy.current_client_ids() AS c;
  IF COALESCE(cardinality(v_ids), 0) = 1 THEN
    RETURN v_ids[1];
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION tenancy.presentation_client_id() IS
  'The one client this session is working in, whose names and hidden fields it reads. NULL for staff not simulating a client and for a session in several clients.';

REVOKE ALL ON FUNCTION tenancy.presentation_client_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenancy.presentation_client_id() TO authenticated, service_role;

-- One client's settings, for server code that already knows which client a job is for.
CREATE OR REPLACE FUNCTION metadata_register.client_domain_labels(p_client_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = metadata_register, pg_temp
AS $$
  SELECT COALESCE(jsonb_object_agg(s.domain_code, s.display_name), '{}'::jsonb)
  FROM metadata_register.client_domain_settings AS s
  WHERE s.client_id = p_client_id;
$$;

CREATE OR REPLACE FUNCTION metadata_register.client_hidden_attribute_ids(p_client_id UUID)
RETURNS UUID[]
LANGUAGE sql
STABLE
SET search_path = metadata_register, pg_temp
AS $$
  SELECT COALESCE(array_agg(s.attribute_id), '{}'::uuid[])
  FROM metadata_register.client_attribute_settings AS s
  WHERE s.client_id = p_client_id AND s.is_hidden;
$$;

COMMENT ON FUNCTION metadata_register.client_domain_labels(UUID) IS
  'Entity type code to the name this client gives it. Server code only; a session reads session_domain_labels.';
COMMENT ON FUNCTION metadata_register.client_hidden_attribute_ids(UUID) IS
  'The fields this client hides. Server code only; a session reads session_hidden_attribute_ids.';

REVOKE ALL ON FUNCTION metadata_register.client_domain_labels(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION metadata_register.client_hidden_attribute_ids(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION metadata_register.client_domain_labels(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION metadata_register.client_hidden_attribute_ids(UUID) TO service_role;

-- The same two answers for the session's own client. They run as their owner so
-- a read of the catalog does not check row security once per setting; the client
-- comes from the session, never from the caller.
CREATE OR REPLACE FUNCTION metadata_register.session_domain_labels()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = metadata_register, tenancy, pg_temp
AS $$
  SELECT metadata_register.client_domain_labels(tenancy.presentation_client_id());
$$;

CREATE OR REPLACE FUNCTION metadata_register.session_hidden_attribute_ids()
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = metadata_register, tenancy, pg_temp
AS $$
  SELECT metadata_register.client_hidden_attribute_ids(tenancy.presentation_client_id());
$$;

COMMENT ON FUNCTION metadata_register.session_domain_labels() IS
  'Entity type code to name, for the client this session is working in. Empty when it is working in none or several.';
COMMENT ON FUNCTION metadata_register.session_hidden_attribute_ids() IS
  'The fields hidden for the client this session is working in. Empty when it is working in none or several.';

REVOKE ALL ON FUNCTION metadata_register.session_domain_labels() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION metadata_register.session_hidden_attribute_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION metadata_register.session_domain_labels() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION metadata_register.session_hidden_attribute_ids() TO authenticated, service_role;

-- ============================================================
-- 3. The public views apply them
-- ============================================================
-- Existing columns keep their place and type so replace succeeds. Each lookup is
-- an uncorrelated subquery, so it runs once per statement, and only when the
-- statement reads that column. The catalog's own value is appended.
CREATE OR REPLACE VIEW public.domain_types WITH (security_invoker = on) AS
SELECT
  dt.id,
  dt.domain_code,
  COALESCE(
    (SELECT metadata_register.session_domain_labels()) ->> dt.domain_code,
    dt.domain_name
  )::VARCHAR(200) AS domain_name,
  dt.description,
  dt.is_active,
  dt.created_at,
  dt.updated_at,
  dt.temporal_model,
  dt.as_of_date_granularity,
  dt.as_of_date_label,
  dt.client_id,
  dt.group_id,
  dt.parent_domain_code,
  dt.is_core,
  dt.display_order,
  dt.enabled_for_search,
  dt.domain_name AS catalog_domain_name
FROM metadata_register.domain_types AS dt;

COMMENT ON VIEW public.domain_types IS
  'Entity types as this session reads them. domain_name is the session client''s name for the type where it has one; catalog_domain_name is the catalog''s. Write the catalog in metadata_register.domain_types.';

CREATE OR REPLACE VIEW public.attribute_register WITH (security_invoker = on) AS
SELECT
  ar.id, ar.attribute_code, ar.attribute_name, ar.data_type, ar.description, ar.unit_of_measure,
  ar.validation_regex, ar.is_required, ar.is_multi_valued, ar.reference_domain_code,
  ar.default_precedence_rank, ar.metadata, ar.created_at, ar.updated_at, ar.is_derived,
  ar.display_format, ar.list_values, ar.validation_rules, ar.default_value, ar.display_section,
  ar.display_group, ar.is_editable,
  (ar.is_visible AND NOT (ar.id = ANY ((SELECT metadata_register.session_hidden_attribute_ids())::UUID[]))) AS is_visible,
  ar.derivation_formula, ar.derivation_dependencies,
  ar.derivation_type, ar.formula_language, ar.aggregation_type, ar.weight_attribute_code,
  ar.numeric_precision, ar.domain_code, ar.reference_list_code, ar.is_time_varying, ar.time_dimension,
  ar.client_id, ar.reporting_grain, ar.period_alignment, ar.period_rollup,
  ar.display_span_columns, ar.display_span_rows,
  ar.reference_list_level, ar.controlling_attribute_code,
  ar.is_visible AS catalog_is_visible,
  (ar.id = ANY ((SELECT metadata_register.session_hidden_attribute_ids())::UUID[])) AS hidden_for_client
FROM metadata_register.attribute_register AS ar;

COMMENT ON VIEW public.attribute_register IS
  'Attributes as this session reads them. is_visible is false for a field the session''s client hides; catalog_is_visible is the catalog''s own flag. Write the catalog in metadata_register.attribute_register.';

-- The catalog RPC read the table, so it would have shown a hidden field. It now
-- reads the view. Same rows, same keys, plus the two appended ones.
CREATE OR REPLACE FUNCTION public.get_attributes_with_aggregation(p_domain_code character varying DEFAULT NULL::character varying)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'metadata_register', 'pg_temp'
AS $function$
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
          'reference_list_level', reference_list_level,
          'controlling_attribute_code', controlling_attribute_code,
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
          'display_span_columns', display_span_columns,
          'display_span_rows', display_span_rows,
          'is_editable', is_editable,
          'is_visible', is_visible,
          'aggregation_type', COALESCE(aggregation_type, 'NONE'),
          'weight_attribute_code', weight_attribute_code,
          'numeric_precision', numeric_precision
        ) || jsonb_build_object(
          'catalog_is_visible', catalog_is_visible,
          'hidden_for_client', hidden_for_client
        ) AS attr_obj
        FROM public.attribute_register
        WHERE (p_domain_code IS NULL OR domain_code = p_domain_code)
        ORDER BY attribute_code
      ) sub
    ),
    '[]'::jsonb
  )
  INTO v_result;
  RETURN v_result;
END;
$function$;

-- ============================================================
-- 4. Reading and changing the session client's settings
-- ============================================================
CREATE OR REPLACE FUNCTION public.client_catalog_settings(p_domain_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = metadata_register, tenancy, pg_temp
AS $$
DECLARE
  v_client UUID := tenancy.presentation_client_id();
  v_catalog_name TEXT;
BEGIN
  SELECT dt.domain_name INTO v_catalog_name
  FROM metadata_register.domain_types AS dt
  WHERE dt.domain_code = p_domain_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown entity type %', p_domain_code USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'client_id', v_client,
    'can_edit', v_client IS NOT NULL AND tenancy.can_write_schema_row(v_client),
    'domain_code', p_domain_code,
    'catalog_name', v_catalog_name,
    'display_name', (
      SELECT s.display_name
      FROM metadata_register.client_domain_settings AS s
      WHERE s.client_id = v_client AND s.domain_code = p_domain_code
    ),
    'hidden_attribute_ids', COALESCE((
      SELECT jsonb_agg(s.attribute_id)
      FROM metadata_register.client_attribute_settings AS s
      WHERE s.client_id = v_client AND s.is_hidden
    ), '[]'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.client_catalog_settings(TEXT) IS
  'For the client this session is working in: what it calls one entity type, the fields it hides, and whether the caller may change them. client_id is null when the session is working in no single client.';

-- Set, or with a blank name clear, what the session's client calls an entity type.
CREATE OR REPLACE FUNCTION public.set_client_domain_label(p_domain_code TEXT, p_display_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = metadata_register, tenancy, pg_temp
AS $$
DECLARE
  v_client UUID := tenancy.presentation_client_id();
  v_name TEXT := NULLIF(btrim(COALESCE(p_display_name, '')), '');
  v_catalog_name TEXT;
  v_taken TEXT;
BEGIN
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'Open one client to set what it calls an entity type' USING ERRCODE = '42501';
  END IF;
  IF NOT tenancy.can_write_schema_row(v_client) THEN
    RAISE EXCEPTION 'You cannot change this client''s names' USING ERRCODE = '42501';
  END IF;

  SELECT dt.domain_name INTO v_catalog_name
  FROM metadata_register.domain_types AS dt
  WHERE dt.domain_code = p_domain_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown entity type %', p_domain_code USING ERRCODE = 'P0002';
  END IF;

  IF v_name IS NULL OR lower(v_name) = lower(btrim(v_catalog_name)) THEN
    DELETE FROM metadata_register.client_domain_settings
    WHERE client_id = v_client AND domain_code = p_domain_code;
    RETURN public.client_catalog_settings(p_domain_code);
  END IF;
  IF char_length(v_name) > 200 THEN
    RAISE EXCEPTION 'A name can be at most 200 characters' USING ERRCODE = '22001';
  END IF;

  -- The name must not already mean another entity type this client sees.
  SELECT dt.domain_code INTO v_taken
  FROM metadata_register.domain_types AS dt
  LEFT JOIN metadata_register.client_domain_settings AS s
    ON s.client_id = v_client AND s.domain_code = dt.domain_code
  WHERE dt.domain_code <> p_domain_code
    AND lower(btrim(COALESCE(s.display_name, dt.domain_name))) = lower(v_name)
  LIMIT 1;
  IF v_taken IS NOT NULL THEN
    RAISE EXCEPTION 'Another entity type is already called %', v_name USING ERRCODE = '23505';
  END IF;

  INSERT INTO metadata_register.client_domain_settings (client_id, domain_code, display_name, updated_by)
  VALUES (v_client, p_domain_code, v_name, auth.uid())
  ON CONFLICT (client_id, domain_code)
  DO UPDATE SET display_name = EXCLUDED.display_name, updated_by = EXCLUDED.updated_by;

  RETURN public.client_catalog_settings(p_domain_code);
END;
$$;

COMMENT ON FUNCTION public.set_client_domain_label(TEXT, TEXT) IS
  'Sets what the session''s client calls an entity type. A blank name, or the catalog''s own, clears it.';

-- Hide or show fields for the session's client.
CREATE OR REPLACE FUNCTION public.set_client_attributes_hidden(p_attribute_ids UUID[], p_hidden BOOLEAN)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = metadata_register, tenancy, pg_temp
AS $$
DECLARE
  v_client UUID := tenancy.presentation_client_id();
  v_count INTEGER;
BEGIN
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'Open one client to choose the fields it hides' USING ERRCODE = '42501';
  END IF;
  IF NOT tenancy.can_write_schema_row(v_client) THEN
    RAISE EXCEPTION 'You cannot change this client''s fields' USING ERRCODE = '42501';
  END IF;

  IF COALESCE(p_hidden, FALSE) THEN
    INSERT INTO metadata_register.client_attribute_settings (client_id, attribute_id, is_hidden, updated_by)
    SELECT v_client, ar.id, TRUE, auth.uid()
    FROM metadata_register.attribute_register AS ar
    WHERE ar.id = ANY (COALESCE(p_attribute_ids, '{}'::uuid[]))
    ON CONFLICT (client_id, attribute_id)
    DO UPDATE SET is_hidden = TRUE, updated_by = EXCLUDED.updated_by;
  ELSE
    DELETE FROM metadata_register.client_attribute_settings
    WHERE client_id = v_client
      AND attribute_id = ANY (COALESCE(p_attribute_ids, '{}'::uuid[]));
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.set_client_attributes_hidden(UUID[], BOOLEAN) IS
  'Hides or shows fields for the session''s client. Returns how many settings changed. A required field cannot be hidden.';

REVOKE ALL ON FUNCTION public.client_catalog_settings(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_client_domain_label(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_client_attributes_hidden(UUID[], BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_catalog_settings(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_client_domain_label(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_client_attributes_hidden(UUID[], BOOLEAN) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
