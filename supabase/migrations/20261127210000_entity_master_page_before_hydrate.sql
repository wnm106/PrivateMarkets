-- read_projections.entity_master: the same rows, computed only for the rows asked for.
--
-- Why: the view aggregated every attribute of every record with an outer GROUP BY,
-- so "WHERE domain_code = X ORDER BY entity_name LIMIT 20" and its count both built
-- the attribute object for the whole domain first (live: 2,278 list calls at 1.5s
-- mean; replica at live scale: 5.2s for a 20-row page, 1.45s for the count).
--
-- What changes: the attribute object is a scalar subquery per record instead of an
-- outer aggregate. The outer GROUP BY only ever grouped one record's attribute rows:
-- domain_types joins on its unique domain_code and domain_templates on its primary
-- key, so each record met at most one row of each. Without the aggregate the planner
-- can filter, sort and limit the records first and build attributes for those alone,
-- and a count reads no attributes at all. Columns, names, types, order and values are
-- unchanged; security_invoker is kept, so row security applies as before.

CREATE OR REPLACE VIEW read_projections.entity_master WITH (security_invoker = on) AS
SELECT me.id AS entity_id,
    me.entity_code,
    me.entity_name,
    me.domain_code,
    me.template_id,
    dt.domain_name,
    COALESCE(dtpl.template_name, 'Default'::character varying) AS template_name,
    me.description,
    me.is_active,
    (
      SELECT COALESCE(
               jsonb_object_agg(ar.attribute_code, jsonb_build_object(
                 'value', eav.golden_value,
                 'value_numeric', eav.golden_value_numeric,
                 'value_date', eav.golden_value_date,
                 'value_timestamp', eav.golden_value_timestamp,
                 'source_id', eav.source_id,
                 'source_code', sr.source_code,
                 'golden_source_id', eav.golden_source_id,
                 'precedence_rank', eav.precedence_rank,
                 'valid_from', eav.valid_from,
                 'valid_to', eav.valid_to
               )) FILTER (WHERE ar.attribute_code IS NOT NULL),
               '{}'::jsonb)
      FROM (
        SELECT DISTINCT ON (eav_1.attribute_id)
               eav_1.attribute_id,
               eav_1.golden_value,
               eav_1.golden_value_numeric,
               eav_1.golden_value_date,
               eav_1.golden_value_timestamp,
               eav_1.source_id,
               eav_1.golden_source_id,
               eav_1.precedence_rank,
               eav_1.valid_from,
               eav_1.valid_to
        FROM golden_master.entity_attribute_values eav_1
        WHERE eav_1.entity_id = me.id
          AND eav_1.valid_to = '9999-12-31'::date
          AND eav_1.system_to = '9999-12-31 23:59:59+00'::timestamp with time zone
        ORDER BY eav_1.attribute_id,
          CASE
            WHEN eav_1.golden_source_id IS NOT NULL AND eav_1.source_id = eav_1.golden_source_id
                 AND eav_1.golden_value IS NOT NULL AND btrim(eav_1.golden_value) <> ''::text THEN 0
            WHEN eav_1.golden_value IS NOT NULL AND btrim(eav_1.golden_value) <> ''::text THEN 1
            ELSE 2
          END,
          eav_1.precedence_rank
      ) eav
      LEFT JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
      LEFT JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    ) AS attributes,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'parent_entity_id', er.parent_entity_id,
               'parent_entity_code', parent_me.entity_code,
               'parent_entity_name', parent_me.entity_name,
               'parent_domain_code', parent_me.domain_code,
               'relationship_type', er.relationship_type,
               'relationship_code', er.relationship_code,
               'is_primary', er.is_primary))
      FROM entity_instances.entity_relationships er
      JOIN entity_instances.master_entities parent_me ON parent_me.id = er.parent_entity_id
      WHERE er.child_entity_id = me.id
        AND er.valid_to = '9999-12-31'::date
        AND er.system_to = '9999-12-31 23:59:59+00'::timestamp with time zone
    ), '[]'::jsonb) AS parent_relationships,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'child_entity_id', er.child_entity_id,
               'child_entity_code', child_me.entity_code,
               'child_entity_name', child_me.entity_name,
               'child_domain_code', child_me.domain_code,
               'relationship_type', er.relationship_type,
               'relationship_code', er.relationship_code,
               'is_primary', er.is_primary))
      FROM entity_instances.entity_relationships er
      JOIN entity_instances.master_entities child_me ON child_me.id = er.child_entity_id
      WHERE er.parent_entity_id = me.id
        AND er.valid_to = '9999-12-31'::date
        AND er.system_to = '9999-12-31 23:59:59+00'::timestamp with time zone
    ), '[]'::jsonb) AS child_relationships,
    me.metadata,
    me.created_at,
    me.updated_at
FROM entity_instances.master_entities me
LEFT JOIN metadata_register.domain_types dt ON dt.domain_code::text = me.domain_code::text
LEFT JOIN metadata_register.domain_templates dtpl ON dtpl.id = me.template_id
WHERE me.is_active = true;

-- The list reads a domain's active records in name order.
CREATE INDEX IF NOT EXISTS idx_master_entities_active_domain_name
  ON entity_instances.master_entities (domain_code, entity_name)
  WHERE is_active;
