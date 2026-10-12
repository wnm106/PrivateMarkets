-- Migration: Create Bill McMahon's client and assign all entities
-- Description: Creates a client for Bill McMahon, makes him a CLIENT_ADMIN, and assigns all existing entities to this client

-- Step 1: Create the client
INSERT INTO tenancy.clients (client_code, client_name, is_active, is_internal, settings)
VALUES ('BILL_MCMahON', 'Bill McMahon', TRUE, FALSE, '{}')
ON CONFLICT (client_code) DO NOTHING;

-- Step 2: Get Bill's user ID and the new client ID, then create membership
DO $$
DECLARE
    v_user_id UUID := 'd90bbd56-a5bb-4dfc-ae50-b6e1171585a4';
    v_client_id UUID;
    v_client_admin_role_id UUID;
BEGIN
    -- Get the client ID
    SELECT id INTO v_client_id FROM tenancy.clients WHERE client_code = 'BILL_MCMahON';
    
    -- Get the CLIENT_ADMIN role ID (global role)
    SELECT id INTO v_client_admin_role_id FROM tenancy.roles WHERE role_code = 'CLIENT_ADMIN' AND client_id IS NULL;
    
    -- Add Bill to the client
    INSERT INTO tenancy.client_users (client_id, user_id, invited_by, is_active)
    VALUES (v_client_id, v_user_id, v_user_id, TRUE)
    ON CONFLICT (client_id, user_id) DO NOTHING;
    
    -- Assign CLIENT_ADMIN role to Bill for this client
    INSERT INTO tenancy.user_roles (client_id, user_id, role_id, granted_by)
    VALUES (v_client_id, v_user_id, v_client_admin_role_id, v_user_id)
    ON CONFLICT (client_id, user_id, role_id) DO NOTHING;
    
    -- Step 3: Assign all existing entities to this client
    UPDATE entity_instances.master_entities
    SET client_id = v_client_id
    WHERE client_id = (SELECT id FROM tenancy.clients WHERE client_code = 'MERIDIAN_INTERNAL');
    
    -- Step 4: Also update intersection_instances to match
    UPDATE entity_instances.intersection_instances
    SET client_id = v_client_id
    WHERE client_id = (SELECT id FROM tenancy.clients WHERE client_code = 'MERIDIAN_INTERNAL');
    
    RAISE NOTICE 'Created client %, assigned user %, and migrated all entities', v_client_id, v_user_id;
END $$;
