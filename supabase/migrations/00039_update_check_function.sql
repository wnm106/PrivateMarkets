-- Migration: Update Client Setup Check Function
-- Description: Updates the check function to include entity client_ids and user roles for debugging

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
        'user_roles', (SELECT jsonb_agg(jsonb_build_object('user_id', ur.user_id, 'client_id', ur.client_id, 'role_code', r.role_code)) 
                       FROM tenancy.user_roles ur 
                       JOIN tenancy.roles r ON r.id = ur.role_id),
        'role_permissions', (SELECT jsonb_agg(jsonb_build_object('role_code', r.role_code, 'permission_code', p.permission_code))
                            FROM tenancy.role_permissions rp
                            JOIN tenancy.roles r ON r.id = rp.role_id
                            JOIN tenancy.permissions p ON p.id = rp.permission_id
                            WHERE r.client_id IS NULL),
        'entities', (SELECT jsonb_agg(jsonb_build_object('id', id, 'entity_code', entity_code, 'client_id', client_id)) FROM entity_instances.master_entities LIMIT 10)
    );
    
    RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_client_setup() TO authenticated;

