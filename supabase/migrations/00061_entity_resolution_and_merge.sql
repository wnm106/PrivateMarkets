-- Entity resolution, cross-entity merge, and relationship-graph support.
-- Match rules score exact keys and fuzzy names across entity types.
-- merge_entities retires one record and moves its relationship edges onto the survivor.
-- Edges stay edges: ownership, counterparty, and facility links are not copied onto attributes.

ALTER TABLE entity_instances.master_entities
    ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES entity_instances.master_entities(id),
    ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_master_entities_merged_into
    ON entity_instances.master_entities(merged_into_id);

COMMENT ON COLUMN entity_instances.master_entities.merged_into_id IS
    'Survivor of an entity merge. The retired row stays for audit and is no longer active.';

CREATE TABLE IF NOT EXISTS entity_instances.entity_merges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id),
    survivor_entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id),
    retired_entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id),
    cross_domain BOOLEAN NOT NULL,
    survivor_domain_code VARCHAR(50) NOT NULL,
    retired_domain_code VARCHAR(50) NOT NULL,
    match_score NUMERIC,
    match_reasons JSONB NOT NULL DEFAULT '[]',
    field_choices JSONB NOT NULL DEFAULT '[]',
    attributes_copied INTEGER NOT NULL DEFAULT 0,
    relationships_moved INTEGER NOT NULL DEFAULT 0,
    intersections_moved INTEGER NOT NULL DEFAULT 0,
    positions_moved INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id),
    UNIQUE (retired_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_merges_survivor ON entity_instances.entity_merges(survivor_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_merges_client ON entity_instances.entity_merges(client_id);

COMMENT ON TABLE entity_instances.entity_merges IS
    'Audit of entity merges. The retired entity is kept and its graph edges are re-pointed at the survivor.';

ALTER TABLE entity_instances.entity_merges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_merges_select ON entity_instances.entity_merges;
CREATE POLICY entity_merges_select ON entity_instances.entity_merges
    FOR SELECT TO authenticated
    USING (
        tenancy.has_entity_access(survivor_entity_id, 'READ')
        OR tenancy.has_entity_access(retired_entity_id, 'READ')
    );

GRANT SELECT ON entity_instances.entity_merges TO authenticated;

-- ------------------------------------------------------------
-- Match rules. Readable by every signed-in user. Tenant admins edit them.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metadata_register.match_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_code VARCHAR(100) UNIQUE NOT NULL,
    rule_name VARCHAR(200) NOT NULL,
    description TEXT,
    min_score NUMERIC NOT NULL DEFAULT 72,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metadata_register.match_rule_clauses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES metadata_register.match_rules(id) ON DELETE CASCADE,
    clause_code VARCHAR(100) NOT NULL,
    attribute_codes TEXT[] NOT NULL DEFAULT '{}',
    use_entity_name BOOLEAN NOT NULL DEFAULT FALSE,
    algorithm VARCHAR(30) NOT NULL CHECK (algorithm IN ('exact', 'jaro_winkler', 'levenshtein', 'jaccard')),
    threshold NUMERIC NOT NULL,
    weight NUMERIC NOT NULL,
    deterministic BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (rule_id, clause_code)
);

CREATE INDEX IF NOT EXISTS idx_match_rule_clauses_rule ON metadata_register.match_rule_clauses(rule_id);

ALTER TABLE metadata_register.match_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_register.match_rule_clauses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS match_rules_select_authenticated ON metadata_register.match_rules;
CREATE POLICY match_rules_select_authenticated ON metadata_register.match_rules
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS match_rules_write_tenant_admin ON metadata_register.match_rules;
CREATE POLICY match_rules_write_tenant_admin ON metadata_register.match_rules
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS match_clauses_select_authenticated ON metadata_register.match_rule_clauses;
CREATE POLICY match_clauses_select_authenticated ON metadata_register.match_rule_clauses
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS match_clauses_write_tenant_admin ON metadata_register.match_rule_clauses;
CREATE POLICY match_clauses_write_tenant_admin ON metadata_register.match_rule_clauses
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

INSERT INTO metadata_register.match_rules (rule_code, rule_name, description, min_score)
VALUES (
    'LEGAL_ENTITY',
    'Legal entity across types',
    'Exact legal and instrument keys, plus Jaro-Winkler, Levenshtein, and Jaccard on names. A conflicting exact key rejects the pair. Matching is not limited to one entity type.',
    72
)
ON CONFLICT (rule_code) DO NOTHING;

INSERT INTO metadata_register.match_rule_clauses
    (rule_id, clause_code, attribute_codes, use_entity_name, algorithm, threshold, weight, deterministic)
SELECT r.id, v.clause_code, v.attribute_codes, v.use_entity_name, v.algorithm, v.threshold, v.weight, v.deterministic
FROM metadata_register.match_rules r
JOIN (VALUES
    ('EXACT_LEGAL_KEYS', ARRAY['LEI','TAX_ID','EIN','CIK','VAT','VAT_NUMBER','DUNS','INTERNAL_ID','COMPANY_NUMBER']::text[], FALSE, 'exact', 1::numeric, 60::numeric, TRUE),
    ('EXACT_INSTRUMENT_KEYS', ARRAY['ISIN','CUSIP','SEDOL','FIGI','TICKER','FUND_CODE']::text[], FALSE, 'exact', 1::numeric, 55::numeric, TRUE),
    ('NAME_JARO', ARRAY['LEGAL_NAME','NAME','ISSUER_NAME','FUND_NAME','SECURITY_NAME']::text[], TRUE, 'jaro_winkler', 0.88::numeric, 30::numeric, FALSE),
    ('NAME_JACCARD', ARRAY['LEGAL_NAME','NAME','ISSUER_NAME','FUND_NAME','SECURITY_NAME']::text[], TRUE, 'jaccard', 0.55::numeric, 20::numeric, FALSE),
    ('NAME_LEVENSHTEIN', ARRAY['LEGAL_NAME','NAME','ISSUER_NAME','FUND_NAME','SECURITY_NAME']::text[], TRUE, 'levenshtein', 0.82::numeric, 15::numeric, FALSE)
) AS v(clause_code, attribute_codes, use_entity_name, algorithm, threshold, weight, deterministic) ON TRUE
WHERE r.rule_code = 'LEGAL_ENTITY'
ON CONFLICT (rule_id, clause_code) DO NOTHING;

-- Cross-entity relationship types. Null domains mean the edge can connect any entity type.
INSERT INTO metadata_register.relationship_types
    (relationship_code, relationship_name, parent_domain_code, child_domain_code, description, cardinality, is_required)
VALUES
    ('BENEFICIAL_OWNER', 'Beneficial owner of', NULL, NULL,
     'Parent owns the child. Walk the ownership graph; do not copy the interest onto the child record.', 'ONE_TO_MANY', FALSE),
    ('COUNTERPARTY', 'Counterparty of', NULL, NULL,
     'Cross-entity counterparty link. The edge is the relationship, not a flattened attribute.', 'MANY_TO_ONE', FALSE),
    ('ENTITY_FACILITY', 'Facility of entity', NULL, NULL,
     'Parent entity to a child facility. Kept as a graph edge across entity types.', 'ONE_TO_MANY', FALSE),
    ('PARENT_ENTITY', 'Parent entity', NULL, NULL,
     'Generic parent-child link that can connect any two entity types.', 'ONE_TO_MANY', FALSE)
ON CONFLICT (relationship_code) DO NOTHING;

-- ------------------------------------------------------------
-- Public views. PostgREST queries public, and schema switching drops the caller JWT.
-- ------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('public.entity_relationships') IS NULL THEN
        EXECUTE 'CREATE VIEW public.entity_relationships AS SELECT * FROM entity_instances.entity_relationships';
    END IF;
END $$;

CREATE OR REPLACE VIEW public.match_rules AS
SELECT * FROM metadata_register.match_rules;

CREATE OR REPLACE VIEW public.match_rule_clauses AS
SELECT * FROM metadata_register.match_rule_clauses;

ALTER VIEW public.match_rules SET (security_invoker = on);
ALTER VIEW public.match_rule_clauses SET (security_invoker = on);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.entity_relationships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.match_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.match_rule_clauses TO authenticated;
GRANT SELECT ON metadata_register.match_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.match_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON metadata_register.match_rule_clauses TO authenticated;

-- Active entities the caller can read, with current golden values, for match scoring.
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
    SELECT
        me.id,
        me.entity_code,
        me.entity_name,
        me.domain_code,
        me.client_id,
        COALESCE((
            SELECT jsonb_object_agg(sub.attribute_code, sub.golden_value)
            FROM (
                SELECT DISTINCT ON (ar.attribute_code)
                    ar.attribute_code,
                    eav.golden_value
                FROM golden_master.entity_attribute_values eav
                JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
                WHERE eav.entity_id = me.id
                    AND eav.system_to = TIMESTAMP '9999-12-31 23:59:59'
                    AND eav.valid_to = DATE '9999-12-31'
                    AND eav.golden_value IS NOT NULL
                    AND btrim(eav.golden_value) <> ''
                ORDER BY ar.attribute_code, eav.precedence_rank ASC
            ) sub
        ), '{}'::jsonb) AS attributes
    FROM entity_instances.master_entities me
    WHERE me.is_active IS TRUE
        AND me.merged_into_id IS NULL
    ORDER BY me.entity_name
    LIMIT 8000;
$pop$;

COMMENT ON FUNCTION public.entity_resolution_population() IS
    'Active entities and current attribute values for cross-entity matching. RLS on master_entities applies.';

REVOKE ALL ON FUNCTION public.entity_resolution_population() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.entity_resolution_population() TO authenticated, service_role;

-- Merge two entities. Relationship edges move onto the survivor; they are not flattened.
CREATE OR REPLACE FUNCTION public.merge_entities(
    p_survivor_id UUID,
    p_retired_id UUID,
    p_field_choices JSONB DEFAULT '[]'::jsonb,
    p_match_score NUMERIC DEFAULT NULL,
    p_match_reasons JSONB DEFAULT '[]'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = entity_instances, golden_master, metadata_register, position_master, tenancy, pg_temp
AS $merge$
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
    IF NOT tenancy.has_entity_access(p_survivor_id, 'WRITE')
        OR NOT tenancy.has_entity_access(p_retired_id, 'WRITE') THEN
        RAISE EXCEPTION 'You need write access to both entities';
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

    UPDATE position_master.dimensional_intersections
    SET fund_entity_id = p_survivor_id, updated_at = NOW()
    WHERE fund_entity_id = p_retired_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_positions := v_positions + v_n;

    UPDATE position_master.dimensional_intersections
    SET issuer_entity_id = p_survivor_id, updated_at = NOW()
    WHERE issuer_entity_id = p_retired_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_positions := v_positions + v_n;

    UPDATE position_master.dimensional_intersections
    SET deal_entity_id = p_survivor_id, updated_at = NOW()
    WHERE deal_entity_id = p_retired_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_positions := v_positions + v_n;

    UPDATE position_master.dimensional_intersections
    SET security_entity_id = p_survivor_id, updated_at = NOW()
    WHERE security_entity_id = p_retired_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_positions := v_positions + v_n;

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
$merge$;

COMMENT ON FUNCTION public.merge_entities(UUID, UUID, JSONB, NUMERIC, JSONB) IS
    'Retire one entity into another. Graph edges, intersection members, and position links move to the survivor.';

REVOKE ALL ON FUNCTION public.merge_entities(UUID, UUID, JSONB, NUMERIC, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_entities(UUID, UUID, JSONB, NUMERIC, JSONB) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
