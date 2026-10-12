-- Migration: Client Setup Check Function
-- Description: Adds a helper function to check client setup status for debugging

CREATE OR REPLACE FUNCTION public.check_client_setup()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_result JSONB;
    v_client_count INT;
    v_entity_count INT;
    v_user_count INT;
BEGIN
    SELECT COUNT(*) INTO v_client_count FROM tenancy.clients;
    SELECT COUNT(*) INTO v_entity_count FROM entity_instances.master_entities;
    SELECT COUNT(*) INTO v_user_count FROM tenancy.client_users;
    
    v_result := jsonb_build_object(
        'client_count', v_client_count,
        'entity_count', v_entity_count,
        'user_count', v_user_count,
        'clients', (SELECT jsonb_agg(jsonb_build_object('id', id, 'client_code', client_code, 'client_name', client_name)) FROM tenancy.clients),
        'client_users', (SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'client_id', client_id)) FROM tenancy.client_users),
        'entities', (SELECT jsonb_agg(jsonb_build_object('id', id, 'entity_code', entity_code, 'client_id', client_id)) FROM entity_instances.master_entities LIMIT 10)
    );
    
    RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_client_setup() TO authenticated;

