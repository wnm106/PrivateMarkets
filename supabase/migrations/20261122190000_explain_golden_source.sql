-- Which source wins a record's attribute, explained by the decision itself.
--
-- The API's evaluateGoldenSource previewed the winner with its own copy of the
-- precedence waterfall in TypeScript (packages/graphql/src/lib/rule-engine.ts).
-- That copy had a "conditional rule" tier the database never applies, so the
-- preview could name a winner the stored golden record never used. The winner
-- is decided in one place, golden_master.preference_decision, which the value
-- triggers call. This reads that decision for a caller, with the competing
-- current values, so the API has nothing to interpret.

CREATE OR REPLACE FUNCTION golden_master.explain_golden_source(p_entity_id UUID, p_attribute_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = golden_master, entity_instances, metadata_register, tenancy, pg_temp
AS $$
DECLARE
    v_attribute_id UUID;
    v_template_id UUID;
    v_decision RECORD;
    v_chain_version INTEGER;
    v_candidates JSONB;
BEGIN
    -- preference_decision reads every row of the record, so the caller must be able to read the record.
    IF NOT tenancy.is_backend_caller() THEN
        PERFORM tenancy.assert_entity_access(p_entity_id, 'READ');
    END IF;

    SELECT ar.id INTO v_attribute_id
    FROM metadata_register.attribute_register ar
    WHERE ar.attribute_code = p_attribute_code;
    IF v_attribute_id IS NULL THEN
        RAISE EXCEPTION 'Unknown attribute %', p_attribute_code USING ERRCODE = 'P0002';
    END IF;

    SELECT d.winner, d.tier INTO v_decision
    FROM golden_master.preference_decision(p_entity_id, v_attribute_id, NULL, NULL, NULL, FALSE) AS d;

    SELECT me.template_id INTO v_template_id FROM entity_instances.master_entities me WHERE me.id = p_entity_id;
    IF v_decision.tier = 'TEMPLATE_SEQUENCE' AND v_template_id IS NOT NULL THEN
        SELECT taa.chain_version INTO v_chain_version
        FROM metadata_register.template_attribute_assignments taa
        WHERE taa.template_id = v_template_id AND taa.attribute_id = v_attribute_id;
    END IF;

    -- The current values that competed: the winner first, then by rank.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'source', sr.source_code,
               'sourceId', sr.id,
               'value', eav.golden_value,
               'rank', eav.precedence_rank,
               'wins', sr.id = v_decision.winner
           ) ORDER BY (sr.id = v_decision.winner) DESC, eav.precedence_rank, sr.source_code), '[]'::jsonb)
      INTO v_candidates
    FROM golden_master.entity_attribute_values eav
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE eav.entity_id = p_entity_id
      AND eav.attribute_id = v_attribute_id
      AND eav.valid_to = DATE '9999-12-31'
      AND eav.system_to = TIMESTAMPTZ '9999-12-31 23:59:59+00'
      AND NULLIF(btrim(eav.golden_value), '') IS NOT NULL;

    RETURN jsonb_build_object(
        'winningSourceId', v_decision.winner,
        'winningSource', (SELECT sr.source_code FROM entity_instances.source_registry sr WHERE sr.id = v_decision.winner),
        'tier', v_decision.tier,
        'chainVersion', COALESCE(v_chain_version, 0),
        'candidates', v_candidates
    );
END;
$$;
COMMENT ON FUNCTION golden_master.explain_golden_source(UUID, TEXT) IS
    'The source golden_master.preference_decision picks for a record''s attribute, with the tier that decided it and the competing current values.';

REVOKE ALL ON FUNCTION golden_master.explain_golden_source(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION golden_master.explain_golden_source(UUID, TEXT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
