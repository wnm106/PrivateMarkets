-- A client's own words for an entity type, a record's name and a field.
--
-- The three alias lists (docs/ALIASES.md) were shared by every client, and an
-- alias code could belong to one entity type only. So one client could not say
-- "Portfolio" for an account while everyone else means a fund, and the name a
-- client gives an entity type (20261124120000) showed on screen but was not a
-- word import mapping or chat search matched on.
--
-- Each list gains a nullable client_id. NULL stays a shared alias. A client's
-- alias is read by that client only, and wins over a shared alias that uses the
-- same words. metadata_register.alias_words is the one place that puts the
-- lists together for a client: its own aliases, the names it gives entity
-- types, and the shared aliases those do not replace. Import mapping, chat
-- search and the Excel formula builder all read it.

-- ============================================================
-- 1. A client on each alias
-- ============================================================
ALTER TABLE metadata_register.domain_aliases
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id) ON DELETE CASCADE;
ALTER TABLE metadata_register.entity_name_aliases
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id) ON DELETE CASCADE;
ALTER TABLE metadata_register.attribute_aliases
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES tenancy.clients(id) ON DELETE CASCADE;

COMMENT ON COLUMN metadata_register.domain_aliases.client_id IS
  'Owning client. NULL is a shared alias every client reads. A client''s alias wins over a shared one with the same words.';
COMMENT ON COLUMN metadata_register.entity_name_aliases.client_id IS
  'Owning client. NULL is a shared alias every client reads.';
COMMENT ON COLUMN metadata_register.attribute_aliases.client_id IS
  'Owning client. NULL is a shared alias every client reads.';

-- A code is unique among the shared aliases, and again inside each client.
DROP INDEX IF EXISTS metadata_register.uq_domain_alias_code;
CREATE UNIQUE INDEX IF NOT EXISTS uq_domain_alias_code
  ON metadata_register.domain_aliases (alias_code)
  WHERE client_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_domain_alias_client_code
  ON metadata_register.domain_aliases (client_id, alias_code)
  WHERE client_id IS NOT NULL;

DROP INDEX IF EXISTS metadata_register.uq_entity_name_alias;
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_name_alias
  ON metadata_register.entity_name_aliases (domain_code, alias_code)
  WHERE client_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_name_alias_client
  ON metadata_register.entity_name_aliases (client_id, domain_code, alias_code)
  WHERE client_id IS NOT NULL;

DROP INDEX IF EXISTS metadata_register.uq_attribute_alias_scope;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attribute_alias_scope
  ON metadata_register.attribute_aliases (
    alias_code,
    COALESCE(domain_code, ''),
    COALESCE(template_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE client_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_attribute_alias_client_scope
  ON metadata_register.attribute_aliases (
    client_id,
    alias_code,
    COALESCE(domain_code, ''),
    COALESCE(template_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_domain_aliases_client ON metadata_register.domain_aliases (client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_name_aliases_client ON metadata_register.entity_name_aliases (client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attribute_aliases_client ON metadata_register.attribute_aliases (client_id) WHERE client_id IS NOT NULL;

-- A client's alias names only an entity type and a field that client can see.
CREATE OR REPLACE FUNCTION metadata_register.guard_client_alias()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = metadata_register, pg_temp
AS $$
DECLARE
  v_row JSONB := to_jsonb(NEW);
  v_attribute_client UUID;
BEGIN
  IF NEW.client_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM metadata_register.assert_domain_visible_to_client(v_row ->> 'domain_code', NEW.client_id);
  IF v_row ? 'attribute_id' THEN
    SELECT client_id INTO v_attribute_client
    FROM metadata_register.attribute_register
    WHERE id = (v_row ->> 'attribute_id')::uuid;
    IF v_attribute_client IS NOT NULL AND v_attribute_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'Attribute belongs to a different client' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION metadata_register.guard_client_alias() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_client_alias ON metadata_register.domain_aliases;
CREATE TRIGGER guard_client_alias
  BEFORE INSERT OR UPDATE ON metadata_register.domain_aliases
  FOR EACH ROW EXECUTE FUNCTION metadata_register.guard_client_alias();
DROP TRIGGER IF EXISTS guard_client_alias ON metadata_register.entity_name_aliases;
CREATE TRIGGER guard_client_alias
  BEFORE INSERT OR UPDATE ON metadata_register.entity_name_aliases
  FOR EACH ROW EXECUTE FUNCTION metadata_register.guard_client_alias();
DROP TRIGGER IF EXISTS guard_client_alias ON metadata_register.attribute_aliases;
CREATE TRIGGER guard_client_alias
  BEFORE INSERT OR UPDATE ON metadata_register.attribute_aliases
  FOR EACH ROW EXECUTE FUNCTION metadata_register.guard_client_alias();

-- ============================================================
-- 2. Who reads and writes a client's aliases
-- ============================================================
-- The existing policies stay. A restrictive policy keeps one client's aliases
-- from another client, and a client's own rows gain write policies.
DROP POLICY IF EXISTS domain_aliases_client_scope ON metadata_register.domain_aliases;
CREATE POLICY domain_aliases_client_scope ON metadata_register.domain_aliases
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
DROP POLICY IF EXISTS entity_name_aliases_client_scope ON metadata_register.entity_name_aliases;
CREATE POLICY entity_name_aliases_client_scope ON metadata_register.entity_name_aliases
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));
DROP POLICY IF EXISTS attribute_aliases_client_scope ON metadata_register.attribute_aliases;
CREATE POLICY attribute_aliases_client_scope ON metadata_register.attribute_aliases
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (tenancy.schema_row_visible(client_id));

DROP POLICY IF EXISTS domain_aliases_client_insert ON metadata_register.domain_aliases;
DROP POLICY IF EXISTS domain_aliases_client_update ON metadata_register.domain_aliases;
DROP POLICY IF EXISTS domain_aliases_client_delete ON metadata_register.domain_aliases;
CREATE POLICY domain_aliases_client_insert ON metadata_register.domain_aliases
  FOR INSERT TO authenticated
  WITH CHECK (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id));
CREATE POLICY domain_aliases_client_update ON metadata_register.domain_aliases
  FOR UPDATE TO authenticated
  USING (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id))
  WITH CHECK (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id));
CREATE POLICY domain_aliases_client_delete ON metadata_register.domain_aliases
  FOR DELETE TO authenticated
  USING (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id));

DROP POLICY IF EXISTS entity_name_aliases_client_insert ON metadata_register.entity_name_aliases;
DROP POLICY IF EXISTS entity_name_aliases_client_update ON metadata_register.entity_name_aliases;
DROP POLICY IF EXISTS entity_name_aliases_client_delete ON metadata_register.entity_name_aliases;
CREATE POLICY entity_name_aliases_client_insert ON metadata_register.entity_name_aliases
  FOR INSERT TO authenticated
  WITH CHECK (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id));
CREATE POLICY entity_name_aliases_client_update ON metadata_register.entity_name_aliases
  FOR UPDATE TO authenticated
  USING (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id))
  WITH CHECK (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id));
CREATE POLICY entity_name_aliases_client_delete ON metadata_register.entity_name_aliases
  FOR DELETE TO authenticated
  USING (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id));

DROP POLICY IF EXISTS attribute_aliases_client_insert ON metadata_register.attribute_aliases;
DROP POLICY IF EXISTS attribute_aliases_client_update ON metadata_register.attribute_aliases;
DROP POLICY IF EXISTS attribute_aliases_client_delete ON metadata_register.attribute_aliases;
CREATE POLICY attribute_aliases_client_insert ON metadata_register.attribute_aliases
  FOR INSERT TO authenticated
  WITH CHECK (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id));
CREATE POLICY attribute_aliases_client_update ON metadata_register.attribute_aliases
  FOR UPDATE TO authenticated
  USING (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id))
  WITH CHECK (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id));
CREATE POLICY attribute_aliases_client_delete ON metadata_register.attribute_aliases
  FOR DELETE TO authenticated
  USING (client_id IS NOT NULL AND tenancy.can_write_schema_row(client_id));

-- The public views were taken from SELECT * before client_id existed. Each keeps
-- its columns in place and gains client_id at the end.
DO $views$
DECLARE
  v_name TEXT;
  v_columns TEXT;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['domain_aliases', 'entity_name_aliases', 'attribute_aliases'] LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_columns
    FROM pg_attribute AS a
    WHERE a.attrelid = format('public.%I', v_name)::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attname <> 'client_id';
    EXECUTE format(
      'CREATE OR REPLACE VIEW public.%I WITH (security_invoker = true) AS SELECT %s, client_id FROM metadata_register.%I',
      v_name, v_columns, v_name);
  END LOOP;
END;
$views$;

-- ============================================================
-- 3. One reader for the words a client uses
-- ============================================================
-- Words compare as lower-case letters and digits, so "Project Name" and
-- "project_name" are the same. The same rule as aliasPhrase in the app.
CREATE OR REPLACE FUNCTION metadata_register.alias_phrase(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(regexp_replace(lower(COALESCE(p_text, '')), '[^a-z0-9]+', ' ', 'g'));
$$;

-- The code stored for a word: upper-case letters, digits and underscores.
CREATE OR REPLACE FUNCTION metadata_register.alias_code_for(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT left(btrim(regexp_replace(upper(COALESCE(p_text, '')), '[^A-Z0-9]+', '_', 'g'), '_'), 100);
$$;

REVOKE ALL ON FUNCTION metadata_register.alias_phrase(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION metadata_register.alias_code_for(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION metadata_register.alias_phrase(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION metadata_register.alias_code_for(TEXT) TO authenticated, service_role;

-- The words one client uses, in the order they win:
--   1. the client's own aliases, and the name it gives an entity type;
--   2. the catalog name of a type the client renamed, unless the client uses
--      that word for something else;
--   3. the shared aliases, except one whose words the client uses itself.
-- "<name> name" is the record name of a type, for each name and alias the
-- client gives it. With no client it is the shared lists as they are.
-- Runs as the caller: a signed-in person gets only rows they may read, and
-- server code, which reads everything, names the client it is working for.
CREATE OR REPLACE FUNCTION metadata_register.alias_words(p_client_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = metadata_register, pg_temp
AS $$
  WITH labels AS (
    SELECT s.domain_code, s.display_name, dt.domain_name AS catalog_name
    FROM metadata_register.client_domain_settings AS s
    JOIN metadata_register.domain_types AS dt ON dt.domain_code = s.domain_code
    WHERE s.client_id = p_client_id
  ),
  client_types AS (
    SELECT a.domain_code, a.alias_label::text AS alias_label, a.alias_code::text AS alias_code
    FROM metadata_register.domain_aliases AS a
    WHERE a.is_active AND a.client_id = p_client_id
    UNION ALL
    SELECT l.domain_code, l.display_name::text, metadata_register.alias_code_for(l.display_name)
    FROM labels AS l
  ),
  kept_catalog AS (
    SELECT l.domain_code, l.catalog_name::text AS alias_label, metadata_register.alias_code_for(l.catalog_name) AS alias_code
    FROM labels AS l
    WHERE NOT EXISTS (
      SELECT 1 FROM client_types AS c
      WHERE metadata_register.alias_phrase(c.alias_label) = metadata_register.alias_phrase(l.catalog_name)
    )
  ),
  shared_types AS (
    SELECT a.domain_code, a.alias_label::text AS alias_label, a.alias_code::text AS alias_code
    FROM metadata_register.domain_aliases AS a
    WHERE a.is_active AND a.client_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM client_types AS c
        WHERE metadata_register.alias_phrase(c.alias_label) = metadata_register.alias_phrase(a.alias_label)
      )
  ),
  types AS (
    SELECT domain_code, alias_label, alias_code, TRUE AS client FROM client_types
    UNION ALL
    SELECT domain_code, alias_label, alias_code, TRUE FROM kept_catalog
    UNION ALL
    SELECT domain_code, alias_label, alias_code, FALSE FROM shared_types
  ),
  client_names AS (
    SELECT n.domain_code, n.alias_label::text AS alias_label, n.alias_code::text AS alias_code
    FROM metadata_register.entity_name_aliases AS n
    WHERE n.is_active AND n.client_id = p_client_id
    UNION ALL
    SELECT c.domain_code, c.alias_label || ' name', left(c.alias_code, 95) || '_NAME'
    FROM client_types AS c
  ),
  shared_names AS (
    SELECT n.domain_code, n.alias_label::text AS alias_label, n.alias_code::text AS alias_code
    FROM metadata_register.entity_name_aliases AS n
    WHERE n.is_active AND n.client_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM client_names AS c
        WHERE metadata_register.alias_phrase(c.alias_label) = metadata_register.alias_phrase(n.alias_label)
      )
  ),
  names AS (
    SELECT domain_code, alias_label, alias_code, TRUE AS client FROM client_names
    UNION ALL
    SELECT domain_code, alias_label, alias_code, FALSE FROM shared_names
  ),
  client_attributes AS (
    SELECT aa.attribute_id, aa.alias_label::text AS alias_label, aa.alias_code::text AS alias_code, aa.domain_code
    FROM metadata_register.attribute_aliases AS aa
    WHERE aa.is_active AND aa.client_id = p_client_id
  ),
  shared_attributes AS (
    SELECT aa.attribute_id, aa.alias_label::text AS alias_label, aa.alias_code::text AS alias_code, aa.domain_code
    FROM metadata_register.attribute_aliases AS aa
    JOIN metadata_register.attribute_register AS ar ON ar.id = aa.attribute_id
    WHERE aa.is_active AND aa.client_id IS NULL
      AND (p_client_id IS NULL OR ar.client_id IS NULL OR ar.client_id = p_client_id)
      AND NOT EXISTS (
        SELECT 1 FROM client_attributes AS c
        WHERE metadata_register.alias_phrase(c.alias_label) = metadata_register.alias_phrase(aa.alias_label)
          AND COALESCE(c.domain_code, '') = COALESCE(aa.domain_code, '')
      )
  ),
  attributes AS (
    SELECT attribute_id, alias_label, alias_code, domain_code, TRUE AS client FROM client_attributes
    UNION ALL
    SELECT attribute_id, alias_label, alias_code, domain_code, FALSE FROM shared_attributes
  )
  SELECT jsonb_build_object(
    'client_id', p_client_id,
    'labels', COALESCE((SELECT jsonb_object_agg(l.domain_code, l.display_name) FROM labels AS l), '{}'::jsonb),
    'types', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'domain_code', t.domain_code, 'alias_label', t.alias_label, 'alias_code', t.alias_code, 'client', t.client)
        ORDER BY t.client DESC, t.domain_code, t.alias_label)
      FROM types AS t), '[]'::jsonb),
    'names', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'domain_code', n.domain_code, 'alias_label', n.alias_label, 'alias_code', n.alias_code, 'client', n.client)
        ORDER BY n.client DESC, n.domain_code, n.alias_label)
      FROM names AS n), '[]'::jsonb),
    'attributes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'attribute_id', a.attribute_id, 'alias_label', a.alias_label, 'alias_code', a.alias_code,
        'domain_code', a.domain_code, 'client', a.client)
        ORDER BY a.client DESC, a.alias_label)
      FROM attributes AS a), '[]'::jsonb),
    'hidden_attribute_ids', COALESCE((
      SELECT jsonb_agg(s.attribute_id)
      FROM metadata_register.client_attribute_settings AS s
      WHERE s.client_id = p_client_id AND s.is_hidden), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION metadata_register.alias_words(UUID) IS
  'The words one client uses for entity types, record names and fields, with the names it gives entity types and the fields it hides. A client''s word wins over a shared alias. Runs as the caller.';

REVOKE ALL ON FUNCTION metadata_register.alias_words(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION metadata_register.alias_words(UUID) TO authenticated, service_role;

-- The same answer for the client this session is working in.
CREATE OR REPLACE FUNCTION public.session_alias_words()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = metadata_register, tenancy, pg_temp
AS $$
  SELECT metadata_register.alias_words(tenancy.presentation_client_id());
$$;

COMMENT ON FUNCTION public.session_alias_words() IS
  'The words the client this session is working in uses. The shared lists when it is working in none or several.';

REVOKE ALL ON FUNCTION public.session_alias_words() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_alias_words() TO authenticated, service_role;

-- ============================================================
-- 4. The session client's own words for an entity type
-- ============================================================
-- Same answer as before, with the type's aliases: the shared ones and this client's.
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
    ), '[]'::jsonb),
    'aliases', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'label', a.alias_label, 'code', a.alias_code, 'client', a.client_id IS NOT NULL)
        ORDER BY (a.client_id IS NOT NULL) DESC, a.alias_label)
      FROM metadata_register.domain_aliases AS a
      WHERE a.domain_code = p_domain_code
        AND a.is_active
        AND (a.client_id IS NULL OR a.client_id = v_client)
    ), '[]'::jsonb)
  );
END;
$$;

-- Add one of the session client's own words for an entity type.
CREATE OR REPLACE FUNCTION public.add_client_domain_alias(p_domain_code TEXT, p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = metadata_register, tenancy, pg_temp
AS $$
DECLARE
  v_client UUID := tenancy.presentation_client_id();
  v_label TEXT := btrim(COALESCE(p_label, ''));
  v_phrase TEXT := metadata_register.alias_phrase(p_label);
  v_code TEXT := metadata_register.alias_code_for(p_label);
  v_taken TEXT;
BEGIN
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'Open one client to add its words for an entity type' USING ERRCODE = '42501';
  END IF;
  IF NOT tenancy.can_write_schema_row(v_client) THEN
    RAISE EXCEPTION 'You cannot change this client''s words' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM metadata_register.domain_types AS dt WHERE dt.domain_code = p_domain_code) THEN
    RAISE EXCEPTION 'Unknown entity type %', p_domain_code USING ERRCODE = 'P0002';
  END IF;
  IF v_phrase = '' OR v_code = '' THEN
    RAISE EXCEPTION 'A word needs at least one letter or digit' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_label) > 200 THEN
    RAISE EXCEPTION 'A word can be at most 200 characters' USING ERRCODE = '22001';
  END IF;

  -- The word must not already be what this client calls another entity type:
  -- that type's name as the client reads it, or another of the client's aliases.
  SELECT dt.domain_code INTO v_taken
  FROM metadata_register.domain_types AS dt
  LEFT JOIN metadata_register.client_domain_settings AS s
    ON s.client_id = v_client AND s.domain_code = dt.domain_code
  WHERE dt.domain_code <> p_domain_code
    AND metadata_register.alias_phrase(COALESCE(s.display_name, dt.domain_name)) = v_phrase
  LIMIT 1;
  IF v_taken IS NULL THEN
    SELECT a.domain_code INTO v_taken
    FROM metadata_register.domain_aliases AS a
    WHERE a.client_id = v_client
      AND a.domain_code <> p_domain_code
      AND (a.alias_code = v_code OR metadata_register.alias_phrase(a.alias_label) = v_phrase)
    LIMIT 1;
  END IF;
  IF v_taken IS NOT NULL THEN
    RAISE EXCEPTION '% is already a word this client uses for %', v_label, v_taken USING ERRCODE = '23505';
  END IF;

  INSERT INTO metadata_register.domain_aliases (domain_code, alias_label, alias_code, client_id)
  VALUES (p_domain_code, v_label, v_code, v_client)
  ON CONFLICT (client_id, alias_code) WHERE client_id IS NOT NULL
  DO UPDATE SET alias_label = EXCLUDED.alias_label, is_active = TRUE, updated_at = NOW();

  RETURN public.client_catalog_settings(p_domain_code);
END;
$$;

COMMENT ON FUNCTION public.add_client_domain_alias(TEXT, TEXT) IS
  'Adds a word the session''s client uses for an entity type. It wins over a shared alias with the same words, and cannot be what the client already calls another type.';

-- Remove one of the session client's own words. A shared alias is not touched.
CREATE OR REPLACE FUNCTION public.remove_client_domain_alias(p_alias_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = metadata_register, tenancy, pg_temp
AS $$
DECLARE
  v_client UUID := tenancy.presentation_client_id();
  v_count INTEGER;
BEGIN
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'Open one client to remove its words for an entity type' USING ERRCODE = '42501';
  END IF;
  IF NOT tenancy.can_write_schema_row(v_client) THEN
    RAISE EXCEPTION 'You cannot change this client''s words' USING ERRCODE = '42501';
  END IF;
  DELETE FROM metadata_register.domain_aliases
  WHERE id = p_alias_id AND client_id = v_client;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.remove_client_domain_alias(UUID) IS
  'Removes one of the session client''s own words for an entity type. Returns how many were removed.';

REVOKE ALL ON FUNCTION public.add_client_domain_alias(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_client_domain_alias(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_client_domain_alias(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.remove_client_domain_alias(UUID) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
