-- Migration: Generic Read Projection
-- Description: Replace hardcoded per-domain views with a single generic entity view

-- Generic Entity Projection: Works for any domain
CREATE OR REPLACE VIEW read_projections.entity_master AS
SELECT 
    me.id AS entity_id,
    me.entity_code,
    me.entity_name,
    me.domain_code,
    me.template_id,
    dt.domain_name,
    COALESCE(dtpl.template_name, 'Default') AS template_name,
    me.description,
    me.is_active,
    
    -- Aggregate attributes as JSONB (only winning values with non-null golden_value)
    COALESCE(
        jsonb_object_agg(
            winning.attribute_code,
            jsonb_build_object(
                'value', winning.golden_value,
                'value_numeric', winning.golden_value_numeric,
                'value_date', winning.golden_value_date,
                'value_timestamp', winning.golden_value_timestamp,
                'source_id', winning.source_id,
                'source_code', winning.source_code,
                'precedence_rank', winning.precedence_rank,
                'valid_from', winning.valid_from,
                'valid_to', winning.valid_to
            )
        ) FILTER (WHERE winning.attribute_code IS NOT NULL),
        '{}'::jsonb
    ) AS attributes,
    
    -- Parent relationships as JSONB array
    COALESCE(
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'parent_entity_id', er.parent_entity_id,
                    'parent_entity_code', parent_me.entity_code,
                    'parent_entity_name', parent_me.entity_name,
                    'parent_domain_code', parent_me.domain_code,
                    'relationship_type', er.relationship_type,
                    'relationship_code', er.relationship_code,
                    'is_primary', er.is_primary
                )
            )
            FROM entity_instances.entity_relationships er
            JOIN entity_instances.master_entities parent_me ON parent_me.id = er.parent_entity_id
            WHERE er.child_entity_id = me.id
                AND er.valid_to = '9999-12-31'
                AND er.system_to = '9999-12-31 23:59:59'
        ),
        '[]'::jsonb
    ) AS parent_relationships,
    
    -- Child relationships as JSONB array
    COALESCE(
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'child_entity_id', er.child_entity_id,
                    'child_entity_code', child_me.entity_code,
                    'child_entity_name', child_me.entity_name,
                    'child_domain_code', child_me.domain_code,
                    'relationship_type', er.relationship_type,
                    'relationship_code', er.relationship_code,
                    'is_primary', er.is_primary
                )
            )
            FROM entity_instances.entity_relationships er
            JOIN entity_instances.master_entities child_me ON child_me.id = er.child_entity_id
            WHERE er.parent_entity_id = me.id
                AND er.valid_to = '9999-12-31'
                AND er.system_to = '9999-12-31 23:59:59'
        ),
        '[]'::jsonb
    ) AS child_relationships,
    
    me.metadata,
    me.created_at,
    me.updated_at
FROM entity_instances.master_entities me
LEFT JOIN metadata_register.domain_types dt ON dt.domain_code = me.domain_code
LEFT JOIN metadata_register.domain_templates dtpl ON dtpl.id = me.template_id
-- Use DISTINCT ON to pick the winning value for each attribute (lowest precedence_rank with non-null value)
LEFT JOIN (
    SELECT DISTINCT ON (eav.entity_id, ar.attribute_code)
        eav.entity_id,
        ar.attribute_code,
        eav.golden_value,
        eav.golden_value_numeric,
        eav.golden_value_date,
        eav.golden_value_timestamp,
        eav.source_id,
        sr.source_code,
        eav.precedence_rank,
        eav.valid_from,
        eav.valid_to
    FROM golden_master.entity_attribute_values eav
    JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
    LEFT JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE eav.valid_to = '9999-12-31'
        AND eav.system_to = '9999-12-31 23:59:59'
        AND eav.golden_value IS NOT NULL
        AND eav.golden_value != ''
    ORDER BY eav.entity_id, ar.attribute_code, eav.precedence_rank ASC
) winning ON winning.entity_id = me.id
WHERE me.is_active = TRUE
GROUP BY me.id, me.entity_code, me.entity_name, me.domain_code, me.template_id, 
         dt.domain_name, dtpl.template_name, me.description, me.is_active, 
         me.metadata, me.created_at, me.updated_at;

COMMENT ON VIEW read_projections.entity_master IS 'Generic entity projection with attributes and relationships as JSONB';
