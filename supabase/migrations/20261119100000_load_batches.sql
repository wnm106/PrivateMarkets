-- Load batches: stage a file's values, check them, promote them, take them back.
--
-- Until now a load wrote straight to live records. A batch holds what a load
-- would write, so it can be checked against the data quality rules and
-- corrected before anything is live:
--
--   STAGED     the plan is stored. Nothing live has changed.
--   PROMOTING  the loader is writing it.
--   PROMOTED   written. Every value, link and record it made carries the
--              batch id, and every row it changed in place is in the journal.
--   REVERTED   taken back.
--   DISCARDED  dropped before it was promoted.
--   FAILED     the promote stopped. What it wrote can still be reverted.
--
-- A load that is not staged (a feed, a workflow step, Load now) still gets a
-- batch, with origin DIRECT, so it can be reverted too.
--
-- The tables are read and written by the service role with an explicit client
-- filter, like import_instances. The two functions here take the client and
-- are granted to the service role only.
--
-- Safe to run again.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entity_instances.load_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    import_instance_id UUID REFERENCES entity_instances.import_instances(id) ON DELETE SET NULL,
    file_name TEXT NOT NULL,
    map_code VARCHAR(100),
    source_code VARCHAR(100),
    as_of_date DATE NOT NULL,
    origin VARCHAR(10) NOT NULL DEFAULT 'STAGED' CHECK (origin IN ('STAGED', 'DIRECT')),
    status VARCHAR(12) NOT NULL DEFAULT 'STAGED'
        CHECK (status IN ('STAGED', 'PROMOTING', 'PROMOTED', 'REVERTED', 'DISCARDED', 'FAILED')),
    column_mappings JSONB,
    decisions JSONB,
    plan JSONB,
    result JSONB,
    drift JSONB,
    override_reason TEXT,
    error_message TEXT,
    staged_by UUID,
    staged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    promoted_by UUID,
    promoted_at TIMESTAMPTZ,
    reverted_by UUID,
    reverted_at TIMESTAMPTZ,
    revert_result JSONB
);
CREATE INDEX IF NOT EXISTS idx_load_batches_client ON entity_instances.load_batches (client_id, staged_at DESC);
CREATE INDEX IF NOT EXISTS idx_load_batches_instance ON entity_instances.load_batches (import_instance_id, staged_at DESC);
COMMENT ON TABLE entity_instances.load_batches IS
    'One load of one file: staged for checking, promoted to live records, or reverted. origin DIRECT is a load that was not staged.';

CREATE TABLE IF NOT EXISTS entity_instances.load_batch_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES entity_instances.load_batches(id) ON DELETE CASCADE,
    domain_code VARCHAR(50) NOT NULL,
    file_code TEXT NOT NULL,
    entity_name TEXT,
    action VARCHAR(10) NOT NULL CHECK (action IN ('CREATE', 'MATCH')),
    entity_id UUID,
    template_id UUID,
    matched_via VARCHAR(20),
    UNIQUE (batch_id, domain_code, file_code)
);
COMMENT ON TABLE entity_instances.load_batch_records IS
    'A record a staged batch would create or match. entity_id is set for a match.';

CREATE TABLE IF NOT EXISTS entity_instances.load_batch_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES entity_instances.load_batches(id) ON DELETE CASCADE,
    record_id UUID NOT NULL REFERENCES entity_instances.load_batch_records(id) ON DELETE CASCADE,
    attribute_id UUID NOT NULL,
    attribute_code VARCHAR(100) NOT NULL,
    source_id UUID,
    precedence_rank INTEGER NOT NULL DEFAULT 100,
    valid_from DATE NOT NULL,
    action VARCHAR(10) NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'UNCHANGED')),
    raw_value TEXT,
    proposed_value TEXT,
    current_value TEXT,
    origin_row INTEGER,
    origin_column TEXT,
    edited_raw TEXT,
    edited_value TEXT,
    edit_reason TEXT,
    edited_by UUID,
    edited_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_load_batch_values_batch ON entity_instances.load_batch_values (batch_id, record_id);
COMMENT ON TABLE entity_instances.load_batch_values IS
    'A value a staged batch would write. edited_value replaces proposed_value when a person corrected it before promoting.';

CREATE TABLE IF NOT EXISTS entity_instances.load_batch_journal (
    id BIGSERIAL PRIMARY KEY,
    batch_id UUID NOT NULL REFERENCES entity_instances.load_batches(id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('VALUE_UPDATE', 'VALUE_CLOSE', 'LINK_CLOSE', 'RECORD_RENAME')),
    target_id UUID NOT NULL,
    before JSONB NOT NULL,
    after JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_load_batch_journal_batch ON entity_instances.load_batch_journal (batch_id, id);
CREATE INDEX IF NOT EXISTS idx_load_batch_journal_target ON entity_instances.load_batch_journal (target_id);
COMMENT ON TABLE entity_instances.load_batch_journal IS
    'Each live row a promoted batch changed in place, as it was before and after, so the batch can be reverted.';

ALTER TABLE entity_instances.load_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_instances.load_batch_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_instances.load_batch_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_instances.load_batch_journal ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.load_batches TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.load_batch_records TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.load_batch_values TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.load_batch_journal TO service_role;
GRANT USAGE, SELECT ON SEQUENCE entity_instances.load_batch_journal_id_seq TO service_role;

-- What a promoted batch wrote.
ALTER TABLE golden_master.entity_attribute_values ADD COLUMN IF NOT EXISTS load_batch_id UUID;
ALTER TABLE entity_instances.entity_relationships ADD COLUMN IF NOT EXISTS load_batch_id UUID;
ALTER TABLE entity_instances.master_entities ADD COLUMN IF NOT EXISTS load_batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_eav_load_batch
    ON golden_master.entity_attribute_values (load_batch_id) WHERE load_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_relationships_load_batch
    ON entity_instances.entity_relationships (load_batch_id) WHERE load_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_entities_load_batch
    ON entity_instances.master_entities (load_batch_id) WHERE load_batch_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------

INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('load.promote', 'Promote a staged load to live records, and revert a promoted one')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code = 'load.promote'
WHERE r.role_code = 'CLIENT_ADMIN' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Data quality on a staged batch
-- ---------------------------------------------------------------------------
--
-- Each staged record is checked as it would stand once the batch is promoted:
-- its live values on the batch date, with the staged values laid over them by
-- the same precedence the live data uses. A matched record is also checked as
-- it stands now, so a failure the batch brings is told apart from one that was
-- already there. Rules are the compiled ones the data quality page runs.
--
-- Values the platform calculates are not recalculated here: a rule on a
-- calculated attribute sees the value live today.

CREATE OR REPLACE FUNCTION public.load_batch_quality(p_batch_id UUID, p_client_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, data_quality, entity_instances, metadata_register, golden_master, pg_catalog
AS $function$
DECLARE
  v_batch entity_instances.load_batches%ROWTYPE;
  v_as_of DATE;
  v_result JSONB;
BEGIN
  SELECT * INTO v_batch FROM entity_instances.load_batches WHERE id = p_batch_id AND client_id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  SELECT GREATEST(v_batch.as_of_date, COALESCE(max(valid_from), v_batch.as_of_date))
    INTO v_as_of
  FROM entity_instances.load_batch_values WHERE batch_id = p_batch_id;

  WITH recs AS MATERIALIZED (
    SELECT r.id, r.domain_code, r.file_code, r.action, r.entity_id,
           COALESCE(me.entity_name, r.entity_name, r.file_code) AS entity_name,
           COALESCE(me.template_id, r.template_id) AS template_id
    FROM entity_instances.load_batch_records r
    LEFT JOIN entity_instances.master_entities me ON me.id = r.entity_id
    WHERE r.batch_id = p_batch_id
  ),
  live AS MATERIALIZED (
    SELECT DISTINCT ON (r.id, eav.attribute_id)
           r.id AS record_id, eav.attribute_id,
           NULLIF(btrim(eav.golden_value), '') AS value,
           eav.precedence_rank, eav.valid_from
    FROM recs r
    JOIN golden_master.entity_attribute_values eav ON eav.entity_id = r.entity_id
    WHERE eav.system_to = '9999-12-31 23:59:59'
      AND eav.valid_from <= v_as_of
      AND eav.valid_to >= v_as_of
    ORDER BY r.id, eav.attribute_id, eav.precedence_rank ASC, eav.valid_from DESC
  ),
  staged AS MATERIALIZED (
    SELECT DISTINCT ON (v.record_id, v.attribute_id)
           v.id AS value_id, v.record_id, v.attribute_id,
           NULLIF(btrim(COALESCE(v.edited_value, v.proposed_value)), '') AS value,
           v.precedence_rank, v.valid_from,
           (v.origin_row IS NOT NULL AND v.origin_column IS NOT NULL) AS editable
    FROM entity_instances.load_batch_values v
    WHERE v.batch_id = p_batch_id
      AND v.valid_from <= v_as_of
    ORDER BY v.record_id, v.attribute_id, v.valid_from DESC
  ),
  merged AS MATERIALIZED (
    SELECT DISTINCT ON (u.record_id, u.attribute_id)
           u.record_id, u.attribute_id, u.value, u.from_batch
    FROM (
      SELECT record_id, attribute_id, value, precedence_rank, valid_from, TRUE AS from_batch FROM staged
      UNION ALL
      SELECT record_id, attribute_id, value, precedence_rank, valid_from, FALSE FROM live
    ) u
    ORDER BY u.record_id, u.attribute_id, u.precedence_rank ASC, u.valid_from DESC, u.from_batch DESC
  ),
  after_map AS MATERIALIZED (
    SELECT m.record_id, jsonb_object_agg(lower(ar.attribute_code), m.value) AS vals
    FROM merged m
    JOIN metadata_register.attribute_register ar ON ar.id = m.attribute_id
    WHERE m.value IS NOT NULL
    GROUP BY m.record_id
  ),
  before_map AS MATERIALIZED (
    SELECT l.record_id, jsonb_object_agg(lower(ar.attribute_code), l.value) AS vals
    FROM live l
    JOIN metadata_register.attribute_register ar ON ar.id = l.attribute_id
    WHERE l.value IS NOT NULL
    GROUP BY l.record_id
  ),
  outranked AS (
    SELECT s.value_id, s.record_id, s.attribute_id, s.value AS proposed, m.value AS winning
    FROM staged s
    JOIN merged m ON m.record_id = s.record_id AND m.attribute_id = s.attribute_id
    WHERE m.from_batch IS FALSE
      AND s.value IS DISTINCT FROM m.value
  ),
  active_rules AS (
    SELECT r.id, r.rule_code, r.rule_name, r.domain_code, r.rule_severity,
           ar.id AS attribute_id, ar.attribute_code, ar.attribute_name,
           (ar.attribute_code IS NOT NULL AND r.rule_expression ~* ('^' || ar.attribute_code || '[[:space:]]+IS[[:space:]]+NULL[[:space:]]+OR[[:space:]]')) AS passes_when_blank,
           data_quality.apply_compiled_rule(r.id, '{}'::jsonb, v_as_of) AS probe
    FROM data_quality.dq_rules r
    LEFT JOIN metadata_register.attribute_register ar ON ar.id = r.attribute_id
    WHERE r.is_active IS TRUE
      AND (r.domain_code IS NULL OR r.domain_code IN (SELECT domain_code FROM recs))
  ),
  scope AS MATERIALIZED (
    SELECT aru.*, r.id AS record_id, r.entity_id
    FROM active_rules aru
    JOIN recs r ON aru.domain_code IS NULL OR aru.domain_code = r.domain_code
    WHERE COALESCE((aru.probe->>'evaluated')::boolean, false)
  ),
  accepted AS (
    SELECT DISTINCT ex.rule_id, ex.entity_id
    FROM data_quality.dq_exceptions ex
    WHERE ex.status IN ('WAIVED', 'FALSE_POSITIVE')
      AND ex.valid_from <= v_as_of
      AND ex.valid_to >= v_as_of
      AND ex.entity_id IN (SELECT entity_id FROM recs WHERE entity_id IS NOT NULL)
  ),
  checks AS MATERIALIZED (
    SELECT c.record_id, c.entity_id, c.id AS rule_id, c.rule_code, c.rule_name, c.rule_severity,
           c.attribute_id, c.attribute_code, c.attribute_name,
           COALESCE((c.after_result->>'passed')::boolean, false) AS after_passed,
           c.after_result->>'message' AS message,
           c.after_result->>'actualValue' AS actual_value,
           CASE WHEN c.before_result IS NULL THEN NULL
                ELSE COALESCE((c.before_result->>'passed')::boolean, false) END AS before_passed
    FROM (
      SELECT s.*,
             CASE
               WHEN s.attribute_code IS NOT NULL AND s.passes_when_blank
                AND NOT jsonb_exists(COALESCE(am.vals, '{}'::jsonb), lower(s.attribute_code))
               THEN jsonb_build_object('passed', true)
               ELSE data_quality.apply_compiled_rule(s.id, COALESCE(am.vals, '{}'::jsonb), v_as_of)
             END AS after_result,
             CASE
               WHEN s.entity_id IS NULL THEN NULL
               WHEN s.attribute_code IS NOT NULL AND s.passes_when_blank
                AND NOT jsonb_exists(COALESCE(bm.vals, '{}'::jsonb), lower(s.attribute_code))
               THEN jsonb_build_object('passed', true)
               ELSE data_quality.apply_compiled_rule(s.id, COALESCE(bm.vals, '{}'::jsonb), v_as_of)
             END AS before_result
      FROM scope s
      LEFT JOIN after_map am ON am.record_id = s.record_id
      LEFT JOIN before_map bm ON bm.record_id = s.record_id
      WHERE NOT EXISTS (
        SELECT 1 FROM accepted ax WHERE ax.rule_id = s.id AND ax.entity_id = s.entity_id
      )
      OFFSET 0
    ) c
  ),
  failures AS (
    SELECT c.*, r.domain_code, r.file_code, r.entity_name, r.action,
           CASE WHEN c.before_passed IS FALSE THEN 'EXISTING' ELSE 'NEW' END AS state,
           st.value_id, COALESCE(st.editable, false) AS editable, st.value AS staged_value
    FROM checks c
    JOIN recs r ON r.id = c.record_id
    LEFT JOIN staged st ON st.record_id = c.record_id AND st.attribute_id = c.attribute_id
    WHERE NOT c.after_passed
  ),
  cleared AS (
    SELECT c.*, r.domain_code, r.file_code, r.entity_name
    FROM checks c
    JOIN recs r ON r.id = c.record_id
    WHERE c.after_passed AND c.before_passed IS FALSE
  ),
  required_attr AS (
    SELECT r.id AS record_id, ar.id AS attribute_id, ar.attribute_code, ar.attribute_name
    FROM recs r
    JOIN metadata_register.template_attribute_assignments taa
      ON taa.template_id = r.template_id AND taa.is_required IS TRUE
    JOIN metadata_register.attribute_register ar ON ar.id = taa.attribute_id
    WHERE r.template_id IS NOT NULL
    UNION
    SELECT r.id, ar.id, ar.attribute_code, ar.attribute_name
    FROM recs r
    JOIN metadata_register.attribute_register ar
      ON ar.domain_code = r.domain_code AND ar.is_required IS TRUE
    WHERE r.template_id IS NULL
  ),
  missing AS (
    SELECT ra.*, r.domain_code, r.file_code, r.entity_name, r.action,
           CASE WHEN r.entity_id IS NULL THEN 'NEW' ELSE 'EXISTING' END AS state
    FROM required_attr ra
    JOIN recs r ON r.id = ra.record_id
    LEFT JOIN merged m
      ON m.record_id = ra.record_id AND m.attribute_id = ra.attribute_id AND m.value IS NOT NULL
    WHERE m.record_id IS NULL
  )
  SELECT jsonb_build_object(
    'batchId', p_batch_id,
    'asOf', v_as_of,
    'recordCount', (SELECT count(*) FROM recs),
    'ruleCount', (SELECT count(*) FROM active_rules WHERE COALESCE((probe->>'evaluated')::boolean, false)),
    'summary', jsonb_build_object(
      'newFailures', (SELECT count(*) FROM failures WHERE state = 'NEW'),
      'existingFailures', (SELECT count(*) FROM failures WHERE state = 'EXISTING'),
      'cleared', (SELECT count(*) FROM cleared),
      'missingRequired', (SELECT count(*) FROM missing),
      'blocking', (SELECT count(*) FROM failures WHERE state = 'NEW' AND rule_severity = 'CRITICAL'),
      'outranked', (SELECT count(*) FROM outranked)
    ),
    'failures', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'recordId', f.record_id, 'entityId', f.entity_id, 'domainCode', f.domain_code,
        'fileCode', f.file_code, 'entityName', f.entity_name, 'recordAction', f.action,
        'ruleCode', f.rule_code, 'ruleName', f.rule_name, 'severity', f.rule_severity,
        'attributeCode', f.attribute_code, 'attributeName', f.attribute_name,
        'message', f.message, 'actualValue', f.actual_value, 'state', f.state,
        'valueId', f.value_id, 'editable', f.editable, 'stagedValue', f.staged_value
      ) ORDER BY (f.state = 'NEW') DESC,
                 array_position(ARRAY['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']::text[], f.rule_severity::text),
                 f.entity_name, f.rule_code)
      FROM (SELECT * FROM failures ORDER BY (state = 'NEW') DESC, entity_name LIMIT 500) f
    ), '[]'::jsonb),
    'cleared', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'recordId', c.record_id, 'domainCode', c.domain_code, 'fileCode', c.file_code,
        'entityName', c.entity_name, 'ruleCode', c.rule_code, 'ruleName', c.rule_name,
        'attributeCode', c.attribute_code
      ) ORDER BY c.entity_name, c.rule_code)
      FROM (SELECT * FROM cleared ORDER BY entity_name LIMIT 200) c
    ), '[]'::jsonb),
    'missing', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'recordId', m.record_id, 'domainCode', m.domain_code, 'fileCode', m.file_code,
        'entityName', m.entity_name, 'recordAction', m.action,
        'attributeCode', m.attribute_code, 'attributeName', m.attribute_name, 'state', m.state
      ) ORDER BY m.entity_name, m.attribute_code)
      FROM (SELECT * FROM missing ORDER BY entity_name LIMIT 500) m
    ), '[]'::jsonb),
    'outranked', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'valueId', o.value_id, 'recordId', o.record_id, 'fileCode', r.file_code,
        'entityName', r.entity_name, 'attributeCode', ar.attribute_code,
        'attributeName', ar.attribute_name, 'proposed', o.proposed, 'winning', o.winning
      ) ORDER BY r.entity_name, ar.attribute_code)
      FROM (SELECT * FROM outranked LIMIT 200) o
      JOIN recs r ON r.id = o.record_id
      JOIN metadata_register.attribute_register ar ON ar.id = o.attribute_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.load_batch_quality(UUID, UUID) IS
    'Runs the active data quality rules on each record of a staged batch as it would stand once promoted. Says which failures the batch brings and which were already there. Writes nothing.';
REVOKE ALL ON FUNCTION public.load_batch_quality(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_batch_quality(UUID, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- Revert
-- ---------------------------------------------------------------------------
--
-- Takes back what a promoted batch wrote, where it still stands:
--   * a value the batch added is retired (its system time is closed, so
--     history keeps it), unless a later load has since rewritten it;
--   * a row the batch changed in place is put back as it was, unless it has
--     changed again since;
--   * a link the batch added is removed, and one it closed is reopened;
--   * a record the batch created is made inactive when nothing else has been
--     added to it.
-- Whatever it leaves alone is counted in the result.

CREATE OR REPLACE FUNCTION public.load_batch_revert(p_batch_id UUID, p_client_id UUID, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, entity_instances, golden_master, pg_catalog
AS $function$
DECLARE
  v_batch entity_instances.load_batches%ROWTYPE;
  v_open CONSTANT TIMESTAMPTZ := '9999-12-31 23:59:59';
  v_now TIMESTAMPTZ := clock_timestamp();
  v_entry RECORD;
  v_rows INTEGER;
  v_values_retired INTEGER := 0;
  v_values_kept INTEGER := 0;
  v_restored INTEGER := 0;
  v_not_restored INTEGER := 0;
  v_links_removed INTEGER := 0;
  v_records_deactivated INTEGER := 0;
  v_records_kept INTEGER := 0;
  v_result JSONB;
BEGIN
  SELECT * INTO v_batch
  FROM entity_instances.load_batches
  WHERE id = p_batch_id AND client_id = p_client_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found';
  END IF;
  IF v_batch.status NOT IN ('PROMOTED', 'FAILED') THEN
    RAISE EXCEPTION 'Only a promoted batch can be reverted. This one is %.', lower(v_batch.status);
  END IF;

  -- Values a later load rewrote in place are no longer this batch's to retire.
  SELECT count(*) INTO v_values_kept
  FROM golden_master.entity_attribute_values eav
  WHERE eav.load_batch_id = p_batch_id
    AND eav.system_to = v_open
    AND EXISTS (
      SELECT 1 FROM entity_instances.load_batch_journal j
      WHERE j.target_id = eav.id AND j.batch_id <> p_batch_id AND j.kind = 'VALUE_UPDATE'
    );

  UPDATE golden_master.entity_attribute_values eav
     SET system_to = v_now
   WHERE eav.load_batch_id = p_batch_id
     AND eav.system_to = v_open
     AND NOT EXISTS (
       SELECT 1 FROM entity_instances.load_batch_journal j
       WHERE j.target_id = eav.id AND j.batch_id <> p_batch_id AND j.kind = 'VALUE_UPDATE'
     );
  GET DIAGNOSTICS v_values_retired = ROW_COUNT;

  -- Put back what was changed in place, newest change first.
  FOR v_entry IN
    SELECT * FROM entity_instances.load_batch_journal WHERE batch_id = p_batch_id ORDER BY id DESC
  LOOP
    v_rows := 0;
    IF v_entry.kind = 'VALUE_CLOSE' THEN
      UPDATE golden_master.entity_attribute_values
         SET valid_to = (v_entry.before->>'valid_to')::date
       WHERE id = v_entry.target_id
         AND system_to = v_open
         AND valid_to = (v_entry.after->>'valid_to')::date;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    ELSIF v_entry.kind = 'VALUE_UPDATE' THEN
      UPDATE golden_master.entity_attribute_values
         SET golden_value = v_entry.before->>'golden_value',
             golden_value_numeric = (v_entry.before->>'golden_value_numeric')::numeric,
             golden_value_date = (v_entry.before->>'golden_value_date')::date
       WHERE id = v_entry.target_id
         AND system_to = v_open
         AND golden_value IS NOT DISTINCT FROM (v_entry.after->>'golden_value');
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    ELSIF v_entry.kind = 'LINK_CLOSE' THEN
      UPDATE entity_instances.entity_relationships
         SET valid_to = (v_entry.before->>'valid_to')::date
       WHERE id = v_entry.target_id
         AND valid_to = (v_entry.after->>'valid_to')::date;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    ELSIF v_entry.kind = 'RECORD_RENAME' THEN
      UPDATE entity_instances.master_entities
         SET entity_name = v_entry.before->>'entity_name', updated_at = v_now
       WHERE id = v_entry.target_id
         AND entity_name = (v_entry.after->>'entity_name');
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    END IF;
    IF v_rows > 0 THEN
      v_restored := v_restored + 1;
    ELSE
      v_not_restored := v_not_restored + 1;
    END IF;
  END LOOP;

  DELETE FROM entity_instances.entity_relationships WHERE load_batch_id = p_batch_id;
  GET DIAGNOSTICS v_links_removed = ROW_COUNT;

  UPDATE entity_instances.master_entities me
     SET is_active = FALSE, updated_at = v_now
   WHERE me.load_batch_id = p_batch_id
     AND me.is_active IS TRUE
     AND NOT EXISTS (
       SELECT 1 FROM golden_master.entity_attribute_values eav
       WHERE eav.entity_id = me.id AND eav.system_to = v_open
     )
     AND NOT EXISTS (
       SELECT 1 FROM entity_instances.entity_relationships er
       WHERE (er.parent_entity_id = me.id OR er.child_entity_id = me.id) AND er.system_to = v_open
     );
  GET DIAGNOSTICS v_records_deactivated = ROW_COUNT;

  SELECT count(*) INTO v_records_kept
  FROM entity_instances.master_entities me
  WHERE me.load_batch_id = p_batch_id AND me.is_active IS TRUE;

  v_result := jsonb_build_object(
    'valuesRetired', v_values_retired,
    'valuesLeft', v_values_kept,
    'changesRestored', v_restored,
    'changesLeft', v_not_restored,
    'linksRemoved', v_links_removed,
    'recordsDeactivated', v_records_deactivated,
    'recordsLeft', v_records_kept
  );

  UPDATE entity_instances.load_batches
     SET status = 'REVERTED', reverted_by = p_user_id, reverted_at = v_now, revert_result = v_result
   WHERE id = p_batch_id;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.load_batch_revert(UUID, UUID, UUID) IS
    'Takes back what a promoted batch wrote, where it still stands, and reports what it left alone because it has changed since.';
REVOKE ALL ON FUNCTION public.load_batch_revert(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_batch_revert(UUID, UUID, UUID) TO service_role;
