-- Fix: RETURNS TABLE (entity_id ...) makes 'entity_id' a PL/pgSQL variable, which clashes with
-- same-named table columns (ERROR 42702). Prefer columns on conflict.

CREATE OR REPLACE FUNCTION compliance.walk_relationship(
    p_start_ids UUID[],
    p_relationship_code VARCHAR,
    p_direction VARCHAR,     -- 'UP' (start is child, find parents) | 'DOWN' (start is parent, find children)
    p_recursive BOOLEAN,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS TABLE (entity_id UUID) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
    IF p_start_ids IS NULL OR array_length(p_start_ids, 1) IS NULL THEN
        RETURN;
    END IF;

    IF p_direction = 'UP' THEN
        IF p_recursive THEN
            RETURN QUERY
            WITH RECURSIVE walk(entity_id) AS (
                SELECT er.parent_entity_id
                FROM entity_instances.entity_relationships er
                WHERE er.child_entity_id = ANY (p_start_ids)
                  AND er.relationship_code = p_relationship_code
                  AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
                  AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
                UNION
                SELECT er.parent_entity_id
                FROM entity_instances.entity_relationships er
                JOIN walk w ON er.child_entity_id = w.entity_id
                WHERE er.relationship_code = p_relationship_code
                  AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
                  AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
            )
            SELECT DISTINCT walk.entity_id FROM walk;
        ELSE
            RETURN QUERY
            SELECT DISTINCT er.parent_entity_id
            FROM entity_instances.entity_relationships er
            WHERE er.child_entity_id = ANY (p_start_ids)
              AND er.relationship_code = p_relationship_code
              AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
              AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date;
        END IF;
    ELSE -- 'DOWN'
        IF p_recursive THEN
            RETURN QUERY
            WITH RECURSIVE walk(entity_id) AS (
                SELECT er.child_entity_id
                FROM entity_instances.entity_relationships er
                WHERE er.parent_entity_id = ANY (p_start_ids)
                  AND er.relationship_code = p_relationship_code
                  AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
                  AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
                UNION
                SELECT er.child_entity_id
                FROM entity_instances.entity_relationships er
                JOIN walk w ON er.parent_entity_id = w.entity_id
                WHERE er.relationship_code = p_relationship_code
                  AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
                  AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
            )
            SELECT DISTINCT walk.entity_id FROM walk;
        ELSE
            RETURN QUERY
            SELECT DISTINCT er.child_entity_id
            FROM entity_instances.entity_relationships er
            WHERE er.parent_entity_id = ANY (p_start_ids)
              AND er.relationship_code = p_relationship_code
              AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
              AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date;
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION compliance.descendants_of(
    p_entity_id UUID,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS TABLE (entity_id UUID) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
    RETURN QUERY
    WITH RECURSIVE descend(entity_id) AS (
        SELECT er.child_entity_id
        FROM entity_instances.entity_relationships er
        WHERE er.parent_entity_id = p_entity_id
          AND er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
          AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
        UNION
        SELECT er.child_entity_id
        FROM entity_instances.entity_relationships er
        JOIN descend d ON er.parent_entity_id = d.entity_id
        WHERE er.valid_from <= p_as_of_date AND er.valid_to >= p_as_of_date
          AND er.system_from <= p_knowledge_date AND er.system_to >= p_knowledge_date
    )
    SELECT DISTINCT descend.entity_id FROM descend;
END;
$$;

CREATE OR REPLACE FUNCTION compliance.get_anchor_entities(
    p_rule_id UUID,
    p_as_of_date DATE,
    p_knowledge_date TIMESTAMPTZ
) RETURNS TABLE (entity_id UUID) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = compliance, entity_instances, tenancy, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_rule compliance.rules;
BEGIN
    SELECT * INTO v_rule FROM compliance.rules WHERE id = p_rule_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH include_direct AS (
        SELECT sa.entity_id
        FROM compliance.rule_scope_assignments sa
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'INCLUDE'
    ),
    include_cascaded AS (
        SELECT d.entity_id
        FROM compliance.rule_scope_assignments sa
        CROSS JOIN LATERAL compliance.descendants_of(sa.entity_id, p_as_of_date, p_knowledge_date) d
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'INCLUDE' AND sa.include_children = TRUE
    ),
    exclude_direct AS (
        SELECT sa.entity_id
        FROM compliance.rule_scope_assignments sa
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'EXCLUDE'
    ),
    exclude_cascaded AS (
        SELECT d.entity_id
        FROM compliance.rule_scope_assignments sa
        CROSS JOIN LATERAL compliance.descendants_of(sa.entity_id, p_as_of_date, p_knowledge_date) d
        WHERE sa.rule_id = p_rule_id AND sa.scope_type = 'EXCLUDE' AND sa.include_children = TRUE
    ),
    candidate AS (
        SELECT me.id AS entity_id
        FROM entity_instances.master_entities me
        WHERE me.domain_code = v_rule.anchor_domain_code
          AND me.is_active = TRUE
          AND (
                v_rule.applies_to_all = TRUE
                OR me.id IN (SELECT entity_id FROM include_direct)
                OR me.id IN (SELECT entity_id FROM include_cascaded)
          )
    )
    SELECT c.entity_id
    FROM candidate c
    WHERE c.entity_id NOT IN (SELECT entity_id FROM exclude_direct)
      AND c.entity_id NOT IN (SELECT entity_id FROM exclude_cascaded);
END;
$$;

CREATE OR REPLACE FUNCTION compliance.get_numeric_values(
    p_entity_ids UUID[],
    p_attribute_code VARCHAR,
    p_as_of DATE,
    p_knowledge TIMESTAMPTZ,
    p_source_scope VARCHAR
) RETURNS TABLE (entity_id UUID, val NUMERIC) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
    IF p_source_scope IS NULL OR p_source_scope = 'GOLDEN' THEN
        RETURN QUERY
        SELECT DISTINCT ON (eav.entity_id) eav.entity_id, eav.golden_value_numeric
        FROM golden_master.entity_attribute_values eav
        WHERE eav.attribute_id IN (SELECT ar.id FROM metadata_register.attribute_register ar WHERE ar.attribute_code = p_attribute_code)
          AND eav.entity_id = ANY (p_entity_ids)
          AND eav.valid_from <= p_as_of AND eav.valid_to >= p_as_of
          AND eav.system_from <= p_knowledge AND eav.system_to >= p_knowledge
        ORDER BY eav.entity_id, eav.precedence_rank ASC;
    ELSE
        RETURN QUERY
        SELECT DISTINCT ON (sav.entity_id) sav.entity_id, sav.value_as_numeric
        FROM entity_instances.source_attribute_values sav
        WHERE sav.attribute_id IN (SELECT ar.id FROM metadata_register.attribute_register ar WHERE ar.attribute_code = p_attribute_code)
          AND sav.source_id IN (SELECT sr.id FROM entity_instances.source_registry sr WHERE sr.source_code = p_source_scope)
          AND sav.entity_id = ANY (p_entity_ids)
          AND sav.valid_from <= p_as_of AND sav.valid_to >= p_as_of
          AND sav.system_from <= p_knowledge AND sav.system_to >= p_knowledge
        ORDER BY sav.entity_id, sav.created_at DESC;
    END IF;
END;
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA compliance TO authenticated, service_role;