-- The resolution page loaded every current attribute for every active entity,
-- one correlated lookup at a time, and the statement timed out.
-- Match scoring only needs the attributes named on active match rules.

CREATE OR REPLACE FUNCTION public.entity_resolution_population()
RETURNS TABLE (
    id UUID,
    entity_code VARCHAR,
    entity_name VARCHAR,
    domain_code VARCHAR,
    client_id UUID,
    attributes JSONB
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = entity_instances, golden_master, metadata_register, pg_temp
AS $pop$
    WITH readable AS (
        SELECT me.id, me.entity_code, me.entity_name, me.domain_code, me.client_id
        FROM entity_instances.master_entities me
        WHERE me.is_active IS TRUE
            AND me.merged_into_id IS NULL
        ORDER BY me.entity_name
        LIMIT 8000
    ),
    wanted AS (
        SELECT DISTINCT upper(btrim(code)) AS attribute_code
        FROM metadata_register.match_rule_clauses clause
        CROSS JOIN LATERAL unnest(clause.attribute_codes) AS code
        WHERE clause.is_active IS TRUE
            AND btrim(code) <> ''
    ),
    current_values AS (
        SELECT DISTINCT ON (eav.entity_id, ar.attribute_code)
            eav.entity_id,
            ar.attribute_code,
            eav.golden_value
        FROM golden_master.entity_attribute_values eav
        JOIN readable r ON r.id = eav.entity_id
        JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
        JOIN wanted w ON w.attribute_code = upper(ar.attribute_code)
        WHERE eav.system_to = TIMESTAMP '9999-12-31 23:59:59'
            AND eav.valid_to = DATE '9999-12-31'
            AND eav.golden_value IS NOT NULL
            AND btrim(eav.golden_value) <> ''
        ORDER BY eav.entity_id, ar.attribute_code, eav.precedence_rank ASC
    )
    SELECT
        r.id,
        r.entity_code,
        r.entity_name,
        r.domain_code,
        r.client_id,
        COALESCE(
            jsonb_object_agg(cv.attribute_code, cv.golden_value) FILTER (WHERE cv.attribute_code IS NOT NULL),
            '{}'::jsonb
        ) AS attributes
    FROM readable r
    LEFT JOIN current_values cv ON cv.entity_id = r.id
    GROUP BY r.id, r.entity_code, r.entity_name, r.domain_code, r.client_id
    ORDER BY r.entity_name;
$pop$;

COMMENT ON FUNCTION public.entity_resolution_population() IS
    'Active entities and the current values of match-rule attributes. RLS on master_entities and entity_attribute_values applies.';
