-- Hypo runs score a deal before and after a what-if allocation without
-- touching the deal's saved allocation.
--
-- A Hypo run writes its own positions tagged '<deal code>#HYPO'. It scores the
-- book twice:
--   '<deal code>#BEFORE'  the book without this deal
--   '<deal code>#HYPO'    the book with the Hypo allocation in place of this deal
--
-- A scenario code with '#' in it is a variant of the deal named before the '#'.
-- include_in_scenario now:
--   * leaves out a variant's positions from every run but that variant's own,
--     so a Hypo allocation never counts in a scheduled run or in another deal;
--   * leaves out the deal's saved proposals from a run of one of its variants,
--     so the before and after figures count the deal once at most.
-- Runs with no scenario or a plain deal code behave as before, except that
-- they no longer see Hypo positions.

CREATE OR REPLACE FUNCTION compliance.include_in_scenario(
    p_entity_id uuid,
    p_scenario_code character varying,
    p_as_of_date date,
    p_knowledge_date timestamp with time zone,
    p_source_scope character varying
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_role text;
    v_code text;
BEGIN
    -- A portfolio lock repeats its sleeves. Every other position stays in:
    -- the booked book, proposals already on the fund, and this deal.
    v_role := compliance.get_text_value(p_entity_id, 'POSITION_ALLOCATION_ROLE', p_as_of_date, p_knowledge_date, p_source_scope);
    IF upper(COALESCE(v_role, '')) = 'LOCK' THEN
        RETURN FALSE;
    END IF;

    v_code := compliance.get_text_value(p_entity_id, 'POSITION_SCENARIO_CODE', p_as_of_date, p_knowledge_date, p_source_scope);
    IF v_code IS NULL OR v_code = '' THEN
        RETURN TRUE;
    END IF;

    -- A variant's positions count only in that variant.
    IF position('#' IN v_code) > 0 THEN
        RETURN v_code IS NOT DISTINCT FROM p_scenario_code;
    END IF;

    -- A variant of this deal replaces the deal's saved proposals.
    IF p_scenario_code IS NOT NULL
       AND position('#' IN p_scenario_code) > 0
       AND split_part(p_scenario_code, '#', 1) = v_code THEN
        RETURN FALSE;
    END IF;

    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION compliance.include_in_scenario IS
    'Whether a position counts in a compliance run. Portfolio locks never count. A position tagged with a deal variant (a code with #, such as a Hypo run) counts only in that variant, and a variant of a deal leaves out that deal''s saved proposals.';

GRANT EXECUTE ON FUNCTION compliance.include_in_scenario(uuid, character varying, date, timestamp with time zone, character varying) TO authenticated, service_role;
