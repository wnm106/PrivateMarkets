-- Migration: Golden Source Preference Persistence & Performance
-- Description: Adds columns for persisting resolved golden source, resolution versioning,
--              template qualification priority, and template-scoped chain versioning.
--              This enables "resolve at write, serve from cache" architecture.

-- 1. Golden record persistence columns
ALTER TABLE golden_master.entity_attribute_values
  ADD COLUMN IF NOT EXISTS golden_source_id UUID REFERENCES entity_instances.source_registry(id),
  ADD COLUMN IF NOT EXISTS resolution_version INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_eav_golden_source
  ON golden_master.entity_attribute_values(golden_source_id);
CREATE INDEX IF NOT EXISTS idx_eav_resolution_stale
  ON golden_master.entity_attribute_values(attribute_id, resolution_version)
  WHERE system_to = '9999-12-31 23:59:59';
CREATE INDEX IF NOT EXISTS idx_eav_current_golden_with_source
  ON golden_master.entity_attribute_values(entity_id, attribute_id, golden_source_id)
  WHERE valid_to = '9999-12-31' AND system_to = '9999-12-31 23:59:59';

COMMENT ON COLUMN golden_master.entity_attribute_values.golden_source_id IS
  'The source_registry.id that won the precedence waterfall for O(1) reads.';
COMMENT ON COLUMN golden_master.entity_attribute_values.resolution_version IS
  'Version stamp of the rule/chain that produced this golden record.';
COMMENT ON COLUMN golden_master.entity_attribute_values.resolved_at IS
  'Timestamp when the golden source was last resolved.';

-- 2. Resolution versioning on precedence rules
ALTER TABLE metadata_register.precedence_rules
  ADD COLUMN IF NOT EXISTS resolution_version INTEGER DEFAULT 1;
COMMENT ON COLUMN metadata_register.precedence_rules.resolution_version IS
  'Incremented on every rule update to detect stale golden records.';

CREATE OR REPLACE FUNCTION metadata_register.bump_precedence_rule_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.resolution_version := COALESCE(OLD.resolution_version, 1) + 1;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_bump_precedence_rule_version ON metadata_register.precedence_rules;
CREATE TRIGGER trg_bump_precedence_rule_version
  BEFORE UPDATE ON metadata_register.precedence_rules
  FOR EACH ROW EXECUTE FUNCTION metadata_register.bump_precedence_rule_version();

-- 3. Chain versioning on template attribute assignments
ALTER TABLE metadata_register.template_attribute_assignments
  ADD COLUMN IF NOT EXISTS chain_version INTEGER DEFAULT 1;
COMMENT ON COLUMN metadata_register.template_attribute_assignments.chain_version IS
  'Incremented when default_precedence_chain changes.';

CREATE OR REPLACE FUNCTION metadata_register.bump_chain_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.default_precedence_chain IS DISTINCT FROM NEW.default_precedence_chain THEN
    NEW.chain_version := COALESCE(OLD.chain_version, 1) + 1;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_bump_chain_version ON metadata_register.template_attribute_assignments;
CREATE TRIGGER trg_bump_chain_version
  BEFORE UPDATE ON metadata_register.template_attribute_assignments
  FOR EACH ROW EXECUTE FUNCTION metadata_register.bump_chain_version();

-- 4. Template qualification priority
ALTER TABLE metadata_register.domain_templates
  ADD COLUMN IF NOT EXISTS qualification_priority INTEGER DEFAULT 100;
COMMENT ON COLUMN metadata_register.domain_templates.qualification_priority IS
  'Lower = evaluated first during template qualification.';

-- 5. Backfill existing records
UPDATE golden_master.entity_attribute_values eav
SET golden_source_id = eav.source_id, resolved_at = NOW(), resolution_version = 1
WHERE eav.system_to = '9999-12-31 23:59:59'
  AND eav.valid_to = '9999-12-31' AND eav.golden_source_id IS NULL;

-- 6. Helper: get effective resolution version for staleness detection
CREATE OR REPLACE FUNCTION metadata_register.get_effective_resolution_version(
  p_domain_code TEXT, p_attribute_code TEXT, p_template_id UUID DEFAULT NULL
) RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_rule_version INTEGER := 0;
  v_chain_version INTEGER := 0;
BEGIN
  IF p_template_id IS NOT NULL THEN
    SELECT COALESCE(MAX(pr.resolution_version), 0) INTO v_rule_version
    FROM metadata_register.precedence_rules pr
    JOIN metadata_register.domain_templates dt ON dt.template_code = pr.template_code
    WHERE pr.domain_code = p_domain_code AND pr.attribute_code = p_attribute_code
      AND pr.is_active = true AND dt.id = p_template_id;
  END IF;
  IF v_rule_version = 0 THEN
    SELECT COALESCE(MAX(resolution_version), 0) INTO v_rule_version
    FROM metadata_register.precedence_rules
    WHERE domain_code = p_domain_code AND attribute_code = p_attribute_code
      AND template_code IS NULL AND is_active = true;
  END IF;
  IF p_template_id IS NOT NULL THEN
    SELECT COALESCE(MAX(taa.chain_version), 0) INTO v_chain_version
    FROM metadata_register.template_attribute_assignments taa
    WHERE taa.template_id = p_template_id AND taa.attribute_id IN (
      SELECT ar.id FROM metadata_register.attribute_register ar WHERE ar.attribute_code = p_attribute_code);
  END IF;
  RETURN (v_rule_version * 1000) + v_chain_version;
END;
$$;
COMMENT ON FUNCTION metadata_register.get_effective_resolution_version IS
  'Returns combined resolution version for staleness detection.';
