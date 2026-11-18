-- Templates chosen on one record for the records linked to it.
--
-- An issuer picks the statement template once and every statement period of
-- that issuer uses it. Two pieces make that work:
--
--   1. relationship_types.template_from_side says which stored side of a
--      relationship supplies the template. STATEMENT_ISSUER keeps the statement
--      period in the parent column and the issuer in the child column, so the
--      issuer supplies it: 'CHILD'.
--   2. entity_template_choices holds the choice, dated, on the supplying
--      record. A row with no relationship code is a record's own override.
--
-- A record's template is then read in this order: its own override, the choice
-- on the linked record for the record's date, the template stamped on the
-- record itself.

ALTER TABLE metadata_register.relationship_types
  ADD COLUMN IF NOT EXISTS template_from_side VARCHAR(10);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'relationship_types_template_from_side_check'
  ) THEN
    ALTER TABLE metadata_register.relationship_types
      ADD CONSTRAINT relationship_types_template_from_side_check
      CHECK (template_from_side IS NULL OR template_from_side IN ('PARENT', 'CHILD'));
  END IF;
END $$;

COMMENT ON COLUMN metadata_register.relationship_types.template_from_side IS
  'Stored side whose record chooses the template for the records on the other side. NULL means no inheritance.';

-- The public view lists its columns, so the new one is appended.
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
  client_id,
  template_from_side
FROM metadata_register.relationship_types;

ALTER VIEW public.relationship_types SET (security_invoker = on);

UPDATE metadata_register.relationship_types
SET template_from_side = 'CHILD'
WHERE relationship_code = 'STATEMENT_ISSUER'
  AND template_from_side IS NULL;

CREATE TABLE IF NOT EXISTS entity_instances.entity_template_choices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
  relationship_code VARCHAR(100),
  template_id UUID NOT NULL REFERENCES metadata_register.domain_templates(id) ON DELETE CASCADE,
  valid_from DATE NOT NULL DEFAULT DATE '0001-01-01',
  valid_to DATE NOT NULL DEFAULT DATE '9999-12-31',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID DEFAULT auth.uid(),
  CHECK (valid_to >= valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_template_choices_start
  ON entity_instances.entity_template_choices (entity_id, COALESCE(relationship_code, ''), valid_from);

CREATE INDEX IF NOT EXISTS idx_entity_template_choices_template
  ON entity_instances.entity_template_choices (template_id);

COMMENT ON TABLE entity_instances.entity_template_choices IS
  'Template a record chooses for the records linked to it through one relationship, by date. A row with no relationship code overrides the template of the record itself.';
COMMENT ON COLUMN entity_instances.entity_template_choices.relationship_code IS
  'Relationship the choice travels along. NULL means the choice applies to this record only.';

ALTER TABLE entity_instances.entity_template_choices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_template_choices_select ON entity_instances.entity_template_choices;
CREATE POLICY entity_template_choices_select ON entity_instances.entity_template_choices
  FOR SELECT TO authenticated
  USING (tenancy.has_entity_access(entity_id, 'READ'));

DROP POLICY IF EXISTS entity_template_choices_write ON entity_instances.entity_template_choices;
CREATE POLICY entity_template_choices_write ON entity_instances.entity_template_choices
  FOR ALL TO authenticated
  USING (tenancy.has_entity_access(entity_id, 'WRITE'))
  WITH CHECK (tenancy.has_entity_access(entity_id, 'WRITE'));

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.entity_template_choices TO authenticated;
GRANT ALL ON entity_instances.entity_template_choices TO service_role;

CREATE OR REPLACE VIEW public.entity_template_choices
  WITH (security_invoker = true) AS
  SELECT * FROM entity_instances.entity_template_choices;

REVOKE ALL ON public.entity_template_choices FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entity_template_choices TO authenticated;
GRANT ALL ON public.entity_template_choices TO service_role;

-- One call replaces the choice so a reader never sees a gap or an overlap.
--   p_template_id NULL            clears every choice for that relationship.
--   p_effective_from NULL         the template applies to every date.
--   p_effective_from set          earlier dates keep what they had.
CREATE OR REPLACE FUNCTION public.set_entity_template_choice(
  p_entity_id UUID,
  p_relationship_code TEXT,
  p_template_id UUID,
  p_effective_from DATE DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = entity_instances, pg_temp
AS $$
DECLARE
  v_code TEXT := NULLIF(btrim(COALESCE(p_relationship_code, '')), '');
BEGIN
  IF p_entity_id IS NULL THEN
    RAISE EXCEPTION 'A record is required.';
  END IF;

  IF p_template_id IS NULL OR p_effective_from IS NULL THEN
    DELETE FROM entity_instances.entity_template_choices
    WHERE entity_id = p_entity_id
      AND COALESCE(relationship_code, '') = COALESCE(v_code, '');
  ELSE
    DELETE FROM entity_instances.entity_template_choices
    WHERE entity_id = p_entity_id
      AND COALESCE(relationship_code, '') = COALESCE(v_code, '')
      AND valid_from >= p_effective_from;

    UPDATE entity_instances.entity_template_choices
    SET valid_to = p_effective_from - 1,
        updated_at = NOW()
    WHERE entity_id = p_entity_id
      AND COALESCE(relationship_code, '') = COALESCE(v_code, '')
      AND valid_to >= p_effective_from;
  END IF;

  IF p_template_id IS NOT NULL THEN
    INSERT INTO entity_instances.entity_template_choices (
      entity_id, relationship_code, template_id, valid_from
    ) VALUES (
      p_entity_id, v_code, p_template_id, COALESCE(p_effective_from, DATE '0001-01-01')
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_entity_template_choice(UUID, TEXT, UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_entity_template_choice(UUID, TEXT, UUID, DATE) TO authenticated, service_role;

-- The Financials tab now lists the lines its template assigns. Statement lines
-- added after the standard template was filled are assigned here, so the
-- standard statement keeps showing every line it shows today.
INSERT INTO metadata_register.template_attribute_assignments (
  template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = 'STATEMENT_PERIOD_STANDARD'
WHERE a.domain_code = 'STATEMENT_PERIOD'
  AND a.validation_rules ? 'statementLine'
ON CONFLICT (template_id, attribute_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
