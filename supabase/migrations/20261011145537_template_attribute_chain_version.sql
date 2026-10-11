-- Saving a template source preference reads chain_version back from
-- template_attribute_assignments. Postgres rejects that read with:
--   column template_attribute_assignments.chain_version does not exist
-- until the column is present.
--
-- chain_version starts at 1 and increments when default_precedence_chain changes.
-- The repo table is in metadata_register. The hosted API exposes public
-- (a table, or a view over the metadata table). Add the column on both.

CREATE OR REPLACE FUNCTION metadata_register.bump_template_attribute_chain_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.chain_version IS NULL THEN
      NEW.chain_version := 1;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.default_precedence_chain IS DISTINCT FROM OLD.default_precedence_chain
     AND (NEW.chain_version IS NOT DISTINCT FROM OLD.chain_version OR NEW.chain_version IS NULL)
  THEN
    NEW.chain_version := COALESCE(OLD.chain_version, 0) + 1;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION metadata_register.bump_template_attribute_chain_version() FROM PUBLIC;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION metadata_register.bump_template_attribute_chain_version() FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  public_kind "char";
  view_sql text;
  base_cols text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'metadata_register'
      AND c.relname = 'template_attribute_assignments'
      AND c.relkind = 'r'
  ) THEN
    ALTER TABLE metadata_register.template_attribute_assignments
      ADD COLUMN IF NOT EXISTS chain_version INTEGER NOT NULL DEFAULT 1;

    COMMENT ON COLUMN metadata_register.template_attribute_assignments.chain_version
      IS 'Increments when default_precedence_chain changes.';

    DROP TRIGGER IF EXISTS trg_bump_template_attribute_chain_version
      ON metadata_register.template_attribute_assignments;
    CREATE TRIGGER trg_bump_template_attribute_chain_version
      BEFORE INSERT OR UPDATE OF default_precedence_chain, chain_version
      ON metadata_register.template_attribute_assignments
      FOR EACH ROW
      EXECUTE FUNCTION metadata_register.bump_template_attribute_chain_version();
  END IF;

  SELECT c.relkind INTO public_kind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'template_attribute_assignments';

  IF public_kind = 'r' THEN
    ALTER TABLE public.template_attribute_assignments
      ADD COLUMN IF NOT EXISTS chain_version INTEGER NOT NULL DEFAULT 1;

    COMMENT ON COLUMN public.template_attribute_assignments.chain_version
      IS 'Increments when default_precedence_chain changes.';

    DROP TRIGGER IF EXISTS trg_bump_template_attribute_chain_version
      ON public.template_attribute_assignments;
    CREATE TRIGGER trg_bump_template_attribute_chain_version
      BEFORE INSERT OR UPDATE OF default_precedence_chain, chain_version
      ON public.template_attribute_assignments
      FOR EACH ROW
      EXECUTE FUNCTION metadata_register.bump_template_attribute_chain_version();
  ELSIF public_kind = 'v' THEN
    view_sql := pg_get_viewdef('public.template_attribute_assignments'::regclass, true);

    IF view_sql ILIKE '%metadata_register.template_attribute_assignments%'
       AND view_sql NOT ILIKE '%join%'
       AND NOT EXISTS (
         SELECT 1
         FROM pg_attribute a
         WHERE a.attrelid = 'public.template_attribute_assignments'::regclass
           AND a.attname = 'chain_version'
           AND NOT a.attisdropped
       )
    THEN
      SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
        INTO base_cols
      FROM pg_attribute a
      WHERE a.attrelid = 'public.template_attribute_assignments'::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped;

      EXECUTE format(
        'CREATE OR REPLACE VIEW public.template_attribute_assignments AS SELECT %s, chain_version FROM metadata_register.template_attribute_assignments',
        base_cols
      );
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
