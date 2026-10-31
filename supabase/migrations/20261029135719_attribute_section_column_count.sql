-- Each display section chooses how many columns it uses, from 1 to 4.

ALTER TABLE metadata_register.attribute_sections
  ADD COLUMN IF NOT EXISTS column_count SMALLINT NOT NULL DEFAULT 4
    CHECK (column_count BETWEEN 1 AND 4);

COMMENT ON COLUMN metadata_register.attribute_sections.column_count IS
  'How many columns this section uses on the attribute display. 4 is the full row.';

CREATE OR REPLACE VIEW public.attribute_sections
WITH (security_invoker = true) AS
SELECT id, domain_code, section_name, display_order, client_id, created_at, updated_at, column_count
FROM metadata_register.attribute_sections;

NOTIFY pgrst, 'reload schema';
