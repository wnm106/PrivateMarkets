-- Migration: Check Entity Master View
-- Description: Function to check if entity_master view exists and is accessible

CREATE OR REPLACE FUNCTION public.check_entity_master_view()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = read_projections, pg_temp
AS $$
DECLARE
    v_exists BOOLEAN;
    v_count INT;
    v_sample JSONB;
BEGIN
    -- Check if view exists
    SELECT EXISTS (
        SELECT 1 FROM information_schema.views 
        WHERE table_schema = 'read_projections' 
        AND table_name = 'entity_master'
    ) INTO v_exists;
    
    IF NOT v_exists THEN
        RETURN jsonb_build_object('error', 'View does not exist', 'exists', false);
    END IF;
    
    -- Count entities
    SELECT COUNT(*) INTO v_count FROM read_projections.entity_master;
    
    -- Get sample
    SELECT jsonb_agg(row_to_json(t)) INTO v_sample
    FROM (SELECT * FROM read_projections.entity_master LIMIT 3) t;
    
    RETURN jsonb_build_object(
        'exists', v_exists,
        'count', v_count,
        'sample', v_sample
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_entity_master_view() TO authenticated;
