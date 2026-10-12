-- Migration 00024: Create public wrapper for get_intersection_full RPC function
-- Description: PostgREST doesn't support schema.table notation in .rpc(),
--              so we create a wrapper function in public schema

CREATE OR REPLACE FUNCTION public.get_intersection_full(
    p_intersection_code VARCHAR,
    p_as_of_date DATE DEFAULT CURRENT_DATE
) RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN entity_instances.get_intersection_full(p_intersection_code, p_as_of_date);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_intersection_full TO authenticated, anon;
