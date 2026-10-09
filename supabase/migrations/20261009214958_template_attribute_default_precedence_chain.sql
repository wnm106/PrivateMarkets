-- Source preference on a template attribute is an ordered list of source codes.
-- Saving it writes template_attribute_assignments.default_precedence_chain.
-- PostgREST rejects that write with:
--   Could not find the 'default_precedence_chain' column of
--   'template_attribute_assignments' in the schema cache
-- until the column exists and the API schema cache is reloaded.
--
-- The repo table lives in metadata_register. The hosted API exposes the same
-- relation in public (as a table, or as a view over the metadata table).
-- Add the column on whichever of those is present.

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
      ADD COLUMN IF NOT EXISTS default_precedence_chain JSONB DEFAULT '[]'::jsonb;

    COMMENT ON COLUMN metadata_register.template_attribute_assignments.default_precedence_chain
      IS 'Ordered source codes for this template attribute. Earlier entries are preferred when resolving a golden value.';
  END IF;

  SELECT c.relkind INTO public_kind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'template_attribute_assignments';

  IF public_kind = 'r' THEN
    ALTER TABLE public.template_attribute_assignments
      ADD COLUMN IF NOT EXISTS default_precedence_chain JSONB DEFAULT '[]'::jsonb;

    COMMENT ON COLUMN public.template_attribute_assignments.default_precedence_chain
      IS 'Ordered source codes for this template attribute. Earlier entries are preferred when resolving a golden value.';
  ELSIF public_kind = 'v' THEN
    view_sql := pg_get_viewdef('public.template_attribute_assignments'::regclass, true);

    IF view_sql ILIKE '%metadata_register.template_attribute_assignments%'
       AND view_sql NOT ILIKE '%join%'
       AND NOT EXISTS (
         SELECT 1
         FROM pg_attribute a
         WHERE a.attrelid = 'public.template_attribute_assignments'::regclass
           AND a.attname = 'default_precedence_chain'
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
        'CREATE OR REPLACE VIEW public.template_attribute_assignments AS SELECT %s, default_precedence_chain FROM metadata_register.template_attribute_assignments',
        base_cols
      );
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
