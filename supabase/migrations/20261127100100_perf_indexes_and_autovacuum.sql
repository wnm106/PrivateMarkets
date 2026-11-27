-- Performance: indexes that earn their keep, autovacuum for tables with heavy
-- churn, and a set form of resolve_rule_version.
--
-- No result changes. Dropping an index never changes a result; the two dropped
-- here had no scans in the observed window, or are a strict prefix of another.

-- ---------------------------------------------------------------------------
-- 1. Redundant EAV indexes (every update of an EAV row rewrites every index).
-- ---------------------------------------------------------------------------
-- (entity_id, attribute_id) WHERE the current row. idx_eav_current_golden_with_source
-- has the same predicate and the same leading columns, plus golden_source_id.
DROP INDEX IF EXISTS golden_master.idx_eav_current_valid;
-- (entity_id, attribute_id, precedence_rank): no scans observed. The same leading
-- columns lead idx_eav_entity_attr_source_asof, idx_eav_period_basis and, for the
-- current-knowledge precedence read, idx_eav_open_system_resolution.
DROP INDEX IF EXISTS golden_master.idx_eav_entity_attr_prec;

-- ---------------------------------------------------------------------------
-- 2. Relationship reads that start from a relationship code.
-- ---------------------------------------------------------------------------
-- relationship_code = X AND parent_entity_id = ANY(..) was a scan of the whole
-- table; the existing indexes lead on the entity alone.
CREATE INDEX IF NOT EXISTS idx_entity_relationships_code_parent
  ON entity_instances.entity_relationships (relationship_code, parent_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relationships_code_child
  ON entity_instances.entity_relationships (relationship_code, child_entity_id);

-- ---------------------------------------------------------------------------
-- 3. Autovacuum: tables where hypothetical rows and recalculations are written
--    and deleted on every call. The default 20% scale factor lets a 69k-row
--    table carry 14k dead rows before it is cleaned.
-- ---------------------------------------------------------------------------
ALTER TABLE golden_master.entity_attribute_values       SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE entity_instances.entity_relationships       SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE entity_instances.master_entities            SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE compliance.rule_evaluation_results          SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE compliance.rule_evaluation_runs             SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE golden_master.calc_invalidations            SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 50, autovacuum_analyze_scale_factor = 0.02);
-- Batch staging tables hold a few rows at a time but are written and cleared in
-- bulk; guarded because not every environment has them.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['entity_instances.load_batch_values', 'entity_instances.import_rows'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s SET (autovacuum_vacuum_scale_factor = 0.02)', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. resolve_rule_version for many rules in one call. It calls the one-rule
--    function, so the choice of version stays in one place. The caller used to
--    make one request per rule.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compliance.resolve_rule_versions(
    p_rule_ids uuid[],
    p_as_of_date date,
    p_knowledge_date timestamp with time zone DEFAULT now()
)
RETURNS SETOF compliance.rule_versions
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'compliance', 'pg_temp'
AS $$
    SELECT v.*
    FROM unnest(p_rule_ids) AS ids(rule_id)
    CROSS JOIN LATERAL compliance.resolve_rule_version(ids.rule_id, p_as_of_date, p_knowledge_date) AS v
    WHERE v.id IS NOT NULL
$$;

REVOKE ALL ON FUNCTION compliance.resolve_rule_versions(uuid[], date, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION compliance.resolve_rule_versions(uuid[], date, timestamptz) TO authenticated, service_role;
