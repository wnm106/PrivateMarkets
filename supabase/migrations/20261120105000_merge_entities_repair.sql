-- Merging two records failed every time.
--
-- public.merge_entities still updated position_master.dimensional_intersections.
-- That table, and its schema, were dropped by 20261031140000 when positions
-- became ordinary records. PL/pgSQL looks a table up when the statement runs,
-- so the function was created without complaint and then raised "relation does
-- not exist" on every merge.
--
-- Positions are records now. Their links to the retired record are
-- relationships and intersection memberships, which this function already
-- moves. The four dead updates are removed; positions_moved stays zero.
--
-- The write-access check also moves ahead of the lookups, so the function no
-- longer says whether a record id from another client exists. The body is
-- otherwise the one already in the database.

CREATE OR REPLACE FUNCTION public.merge_entities(p_survivor_id uuid, p_retired_id uuid, p_field_choices jsonb DEFAULT '[]'::jsonb, p_match_score numeric DEFAULT NULL::numeric, p_match_reasons jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'entity_instances', 'golden_master', 'metadata_register', 'tenancy', 'pg_temp'
AS $$
DECLARE
    v_survivor entity_instances.master_entities%ROWTYPE;
    v_retired entity_instances.master_entities%ROWTYPE;
    v_rel entity_instances.entity_relationships%ROWTYPE;
    v_attr RECORD;
    v_survivor_value TEXT;
    v_take TEXT;
    v_new_parent UUID;
    v_new_child UUID;
    v_copied INTEGER := 0;
    v_moved INTEGER := 0;
    v_intersections INTEGER := 0;
    v_positions INTEGER := 0;
    v_n INTEGER := 0;
    v_sentinel_ts TIMESTAMPTZ := TIMESTAMP '9999-12-31 23:59:59';
    v_sentinel_date DATE := DATE '9999-12-31';
    v_name_choice TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Sign in to merge entities';
    END IF;
    IF p_survivor_id IS NULL OR p_retired_id IS NULL OR p_survivor_id = p_retired_id THEN
        RAISE EXCEPTION 'Choose two different entities';
    END IF;

    IF NOT tenancy.has_entity_access(p_survivor_id, 'WRITE')
        OR NOT tenancy.has_entity_access(p_retired_id, 'WRITE') THEN
        RAISE EXCEPTION 'You need write access to both entities';
    END IF;

    SELECT * INTO v_survivor FROM entity_instances.master_entities WHERE id = p_survivor_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Surviving entity was not found';
    END IF;
    SELECT * INTO v_retired FROM entity_instances.master_entities WHERE id = p_retired_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Entity to retire was not found';
    END IF;

    IF v_survivor.client_id IS DISTINCT FROM v_retired.client_id THEN
        RAISE EXCEPTION 'Those entities belong to different clients';
    END IF;
    IF v_survivor.is_active IS NOT TRUE OR v_survivor.merged_into_id IS NOT NULL THEN
        RAISE EXCEPTION 'The surviving entity is not active';
    END IF;
    IF v_retired.is_active IS NOT TRUE OR v_retired.merged_into_id IS NOT NULL THEN
        RAISE EXCEPTION 'The entity being retired is already merged or inactive';
    END IF;

    v_name_choice := COALESCE((
        SELECT lower(elem->>'takeFrom')
        FROM jsonb_array_elements(COALESCE(p_field_choices, '[]'::jsonb)) elem
        WHERE lower(elem->>'attributeCode') = 'entity_name'
        LIMIT 1
    ), 'survivor');
    IF v_name_choice = 'retired' THEN
        UPDATE entity_instances.master_entities
        SET entity_name = v_retired.entity_name, updated_at = NOW(), updated_by = auth.uid()
        WHERE id = p_survivor_id;
    END IF;

    FOR v_attr IN
        SELECT DISTINCT ON (ar.attribute_code)
            ar.attribute_code,
            eav.attribute_id,
            eav.source_id,
            eav.golden_value,
            eav.golden_value_jsonb,
            eav.golden_value_numeric,
            eav.golden_value_date,
            eav.golden_value_timestamp,
            eav.golden_value_boolean,
            eav.precedence_rank,
            eav.confidence_score
        FROM golden_master.entity_attribute_values eav
        JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
        WHERE eav.entity_id = p_retired_id
            AND eav.system_to = v_sentinel_ts
            AND eav.valid_to = v_sentinel_date
            AND eav.golden_value IS NOT NULL
            AND btrim(eav.golden_value) <> ''
        ORDER BY ar.attribute_code, eav.precedence_rank ASC
    LOOP
        SELECT eav.golden_value INTO v_survivor_value
        FROM golden_master.entity_attribute_values eav
        WHERE eav.entity_id = p_survivor_id
            AND eav.attribute_id = v_attr.attribute_id
            AND eav.system_to = v_sentinel_ts
            AND eav.valid_to = v_sentinel_date
            AND eav.golden_value IS NOT NULL
            AND btrim(eav.golden_value) <> ''
        ORDER BY eav.precedence_rank ASC
        LIMIT 1;

        v_take := COALESCE((
            SELECT lower(elem->>'takeFrom')
            FROM jsonb_array_elements(COALESCE(p_field_choices, '[]'::jsonb)) elem
            WHERE lower(elem->>'attributeCode') = lower(v_attr.attribute_code)
            LIMIT 1
        ), 'survivor');

        IF v_survivor_value IS NOT NULL AND btrim(v_survivor_value) = btrim(v_attr.golden_value) THEN
            CONTINUE;
        END IF;
        IF v_survivor_value IS NOT NULL AND v_take <> 'retired' THEN
            CONTINUE;
        END IF;

        IF v_survivor_value IS NOT NULL AND v_take = 'retired' THEN
            UPDATE golden_master.entity_attribute_values
            SET system_to = NOW(), updated_by = auth.uid()
            WHERE entity_id = p_survivor_id
                AND attribute_id = v_attr.attribute_id
                AND system_to = v_sentinel_ts;
        END IF;

        INSERT INTO golden_master.entity_attribute_values (
            entity_id, attribute_id, source_id,
            golden_value, golden_value_jsonb, golden_value_numeric,
            golden_value_date, golden_value_timestamp, golden_value_boolean,
            valid_from, valid_to, precedence_rank, confidence_score,
            is_manual_override, override_reason, resolution_rule_applied, metadata, created_by
        ) VALUES (
            p_survivor_id, v_attr.attribute_id, v_attr.source_id,
            v_attr.golden_value, v_attr.golden_value_jsonb, v_attr.golden_value_numeric,
            v_attr.golden_value_date, v_attr.golden_value_timestamp, v_attr.golden_value_boolean,
            CURRENT_DATE, v_sentinel_date, COALESCE(v_attr.precedence_rank, 100), v_attr.confidence_score,
            TRUE,
            'Merged from ' || v_retired.entity_code,
            'ENTITY_MERGE',
            jsonb_build_object(
                'merged_from_entity_id', p_retired_id,
                'merged_from_entity_code', v_retired.entity_code,
                'merged_from_domain_code', v_retired.domain_code
            ),
            auth.uid()
        );
        v_copied := v_copied + 1;
    END LOOP;

    FOR v_rel IN
        SELECT *
        FROM entity_instances.entity_relationships
        WHERE system_to = v_sentinel_ts
            AND valid_to = v_sentinel_date
            AND (parent_entity_id = p_retired_id OR child_entity_id = p_retired_id)
    LOOP
        v_new_parent := CASE WHEN v_rel.parent_entity_id = p_retired_id THEN p_survivor_id ELSE v_rel.parent_entity_id END;
        v_new_child := CASE WHEN v_rel.child_entity_id = p_retired_id THEN p_survivor_id ELSE v_rel.child_entity_id END;

        UPDATE entity_instances.entity_relationships
        SET system_to = NOW()
        WHERE id = v_rel.id;

        IF v_new_parent = v_new_child THEN
            CONTINUE;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM entity_instances.entity_relationships existing
            WHERE existing.parent_entity_id = v_new_parent
                AND existing.child_entity_id = v_new_child
                AND existing.relationship_code = v_rel.relationship_code
                AND existing.system_to = v_sentinel_ts
                AND existing.valid_to = v_sentinel_date
        ) THEN
            CONTINUE;
        END IF;

        BEGIN
            INSERT INTO entity_instances.entity_relationships (
                parent_entity_id, child_entity_id, relationship_type, relationship_code,
                is_primary, valid_from, valid_to, metadata
            ) VALUES (
                v_new_parent, v_new_child, v_rel.relationship_type, v_rel.relationship_code,
                COALESCE(v_rel.is_primary, FALSE), v_rel.valid_from, v_rel.valid_to,
                COALESCE(v_rel.metadata, '{}'::jsonb) || jsonb_build_object('merged_from_entity_id', p_retired_id)
            );
            v_moved := v_moved + 1;
        EXCEPTION WHEN unique_violation THEN
            NULL;
        END;
    END LOOP;

    UPDATE entity_instances.intersection_members
    SET entity_id = p_survivor_id,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('merged_from_entity_id', p_retired_id)
    WHERE entity_id = p_retired_id
        AND system_to = v_sentinel_ts
        AND valid_to = v_sentinel_date;
    GET DIAGNOSTICS v_intersections = ROW_COUNT;

    UPDATE entity_instances.master_entities
    SET is_active = FALSE,
        merged_into_id = p_survivor_id,
        merged_at = NOW(),
        updated_at = NOW(),
        updated_by = auth.uid(),
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'merged_into_id', p_survivor_id,
            'merged_at', NOW()
        )
    WHERE id = p_retired_id;

    UPDATE entity_instances.master_entities
    SET updated_at = NOW(),
        updated_by = auth.uid(),
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'merged_from',
            COALESCE(metadata->'merged_from', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                'entity_id', p_retired_id,
                'entity_code', v_retired.entity_code,
                'entity_name', v_retired.entity_name,
                'domain_code', v_retired.domain_code
            ))
        )
    WHERE id = p_survivor_id;

    INSERT INTO entity_instances.entity_merges (
        client_id, survivor_entity_id, retired_entity_id, cross_domain,
        survivor_domain_code, retired_domain_code, match_score, match_reasons, field_choices,
        attributes_copied, relationships_moved, intersections_moved, positions_moved, created_by
    ) VALUES (
        v_survivor.client_id, p_survivor_id, p_retired_id,
        v_survivor.domain_code IS DISTINCT FROM v_retired.domain_code,
        v_survivor.domain_code, v_retired.domain_code, p_match_score,
        COALESCE(p_match_reasons, '[]'::jsonb), COALESCE(p_field_choices, '[]'::jsonb),
        v_copied, v_moved, v_intersections, v_positions, auth.uid()
    );

    RETURN jsonb_build_object(
        'survivorId', p_survivor_id,
        'retiredId', p_retired_id,
        'attributesCopied', v_copied,
        'relationshipsMoved', v_moved,
        'intersectionsMoved', v_intersections,
        'positionsMoved', v_positions
    );
END;
$$;

NOTIFY pgrst, 'reload schema';
