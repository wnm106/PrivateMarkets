-- Migration: Multi-tenant Row Level Security
-- Description: Replaces the simplistic role-only policies from 00008 with
-- tenant- and entity-ACL-aware policies, enables RLS on tables created after
-- 00008 that never had it, enables RLS on the new tenancy.* tables, and sets
-- security_invoker on all views so RLS is enforced even when the app queries
-- through a read_projections/public view instead of the base table.
--
-- IMPORTANT: this migration only takes effect for callers whose Postgres role
-- is driven by their own JWT (auth.uid() resolves). See the companion change
-- to apps/web and apps/api that stops using the service-role key for normal
-- request handling -- previously ALL RLS here (and in 00008) was silently
-- bypassed because every request ran as the service role.

-- ============================================================
-- 1. security_invoker on every view, so RLS on base tables is honored
--    even when queried via a view (Postgres defaults views to the owner's
--    privileges, which bypasses RLS unless security_invoker is set).
-- ============================================================
DO $$
DECLARE
    v_view RECORD;
BEGIN
    FOR v_view IN
        SELECT schemaname, viewname
        FROM pg_views
        WHERE schemaname IN ('public', 'read_projections', 'golden_master', 'metadata_register', 'entity_instances', 'position_master')
    LOOP
        EXECUTE format('ALTER VIEW %I.%I SET (security_invoker = on)', v_view.schemaname, v_view.viewname);
    END LOOP;
END;
$$;

-- ============================================================
-- 2. tenancy.* RLS
-- ============================================================
ALTER TABLE tenancy.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.client_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.entity_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.client_identity_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.impersonation_sessions ENABLE ROW LEVEL SECURITY;

-- Clients: visible if you belong to it (or are impersonating it); tenant admins see all.
CREATE POLICY "Clients visible to members or tenant admins" ON tenancy.clients
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin() OR id IN (SELECT * FROM tenancy.current_client_ids()));

CREATE POLICY "Clients writable by tenant admins" ON tenancy.clients
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

-- Profiles: everyone can see their own; client admins see profiles of co-members; tenant admins see all.
CREATE POLICY "Profiles visible to self, co-members, or tenant admins" ON tenancy.profiles
    FOR SELECT TO authenticated
    USING (
        id = auth.uid()
        OR tenancy.is_tenant_admin()
        OR EXISTS (
            SELECT 1 FROM tenancy.client_users mine
            JOIN tenancy.client_users theirs ON theirs.client_id = mine.client_id
            WHERE mine.user_id = auth.uid() AND theirs.user_id = tenancy.profiles.id
        )
    );

CREATE POLICY "Profiles updatable by self or tenant admins" ON tenancy.profiles
    FOR UPDATE TO authenticated
    USING (id = auth.uid() OR tenancy.is_tenant_admin())
    WITH CHECK (id = auth.uid() OR tenancy.is_tenant_admin());

-- Client membership: visible to co-members of the same client, writable by user.manage holders / tenant admins.
CREATE POLICY "Client users visible to co-members" ON tenancy.client_users
    FOR SELECT TO authenticated
    USING (
        tenancy.is_tenant_admin()
        OR client_id IN (SELECT * FROM tenancy.current_client_ids())
    );

CREATE POLICY "Client users writable by user managers" ON tenancy.client_users
    FOR ALL TO authenticated
    USING (tenancy.has_permission(client_id, 'user.manage') OR tenancy.is_tenant_admin())
    WITH CHECK (tenancy.has_permission(client_id, 'user.manage') OR tenancy.is_tenant_admin());

-- Roles: global templates readable by all; client-owned roles readable by members of that client.
CREATE POLICY "Roles readable by authenticated" ON tenancy.roles
    FOR SELECT TO authenticated
    USING (
        client_id IS NULL
        OR tenancy.is_tenant_admin()
        OR client_id IN (SELECT * FROM tenancy.current_client_ids())
    );

CREATE POLICY "Custom roles writable by role managers" ON tenancy.roles
    FOR ALL TO authenticated
    USING (
        tenancy.is_tenant_admin()
        OR (client_id IS NOT NULL AND tenancy.has_permission(client_id, 'role.manage'))
    )
    WITH CHECK (
        tenancy.is_tenant_admin()
        OR (client_id IS NOT NULL AND tenancy.has_permission(client_id, 'role.manage'))
    );

-- Permissions catalog: global, readable by all authenticated, writable only by tenant admins.
CREATE POLICY "Permissions readable by authenticated" ON tenancy.permissions
    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "Permissions writable by tenant admins" ON tenancy.permissions
    FOR ALL TO authenticated USING (tenancy.is_tenant_admin()) WITH CHECK (tenancy.is_tenant_admin());

-- Role -> permission mappings: readable alongside the role; writable by role managers.
CREATE POLICY "Role permissions readable by authenticated" ON tenancy.role_permissions
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM tenancy.roles r
            WHERE r.id = role_id
              AND (r.client_id IS NULL OR tenancy.is_tenant_admin() OR r.client_id IN (SELECT * FROM tenancy.current_client_ids()))
        )
    );
CREATE POLICY "Role permissions writable by role managers" ON tenancy.role_permissions
    FOR ALL TO authenticated
    USING (
        tenancy.is_tenant_admin()
        OR EXISTS (SELECT 1 FROM tenancy.roles r WHERE r.id = role_id AND r.client_id IS NOT NULL AND tenancy.has_permission(r.client_id, 'role.manage'))
    )
    WITH CHECK (
        tenancy.is_tenant_admin()
        OR EXISTS (SELECT 1 FROM tenancy.roles r WHERE r.id = role_id AND r.client_id IS NOT NULL AND tenancy.has_permission(r.client_id, 'role.manage'))
    );

-- User role assignments: visible to co-members; writable by role managers.
CREATE POLICY "User roles visible to co-members" ON tenancy.user_roles
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin() OR client_id IN (SELECT * FROM tenancy.current_client_ids()));

CREATE POLICY "User roles writable by role managers" ON tenancy.user_roles
    FOR ALL TO authenticated
    USING (tenancy.has_permission(client_id, 'role.manage') OR tenancy.is_tenant_admin())
    WITH CHECK (tenancy.has_permission(client_id, 'role.manage') OR tenancy.is_tenant_admin());

-- Entity grants (ACLs): visible to co-members of the client; writable by entity_access.manage holders.
CREATE POLICY "Entity grants visible to co-members" ON tenancy.entity_grants
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin() OR client_id IN (SELECT * FROM tenancy.current_client_ids()));

CREATE POLICY "Entity grants writable by access managers" ON tenancy.entity_grants
    FOR ALL TO authenticated
    USING (tenancy.has_permission(client_id, 'entity_access.manage') OR tenancy.is_tenant_admin())
    WITH CHECK (tenancy.has_permission(client_id, 'entity_access.manage') OR tenancy.is_tenant_admin());

-- SSO identity provider mappings: tenant-admin-managed only (controls auto-provisioning).
CREATE POLICY "Identity providers visible to co-members or tenant admins" ON tenancy.client_identity_providers
    FOR SELECT TO authenticated
    USING (tenancy.is_tenant_admin() OR client_id IN (SELECT * FROM tenancy.current_client_ids()));

CREATE POLICY "Identity providers writable by tenant admins" ON tenancy.client_identity_providers
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

-- Impersonation sessions: an admin sees/manages only their own sessions.
CREATE POLICY "Impersonation sessions visible to the admin" ON tenancy.impersonation_sessions
    FOR SELECT TO authenticated
    USING (admin_user_id = auth.uid());

-- Inserts/updates/stop go through SECURITY DEFINER RPCs (start_impersonation /
-- stop_impersonation), so no direct INSERT/UPDATE policy is granted here.

-- ============================================================
-- 3. entity_instances / golden_master / position_master / data_quality
--    (replace 00008's role-only policies with tenant + entity-ACL aware ones)
-- ============================================================

-- -- master_entities --
DROP POLICY IF EXISTS "Master entities readable by authenticated" ON entity_instances.master_entities;
DROP POLICY IF EXISTS "Master entities writable by admins" ON entity_instances.master_entities;

CREATE POLICY "Master entities readable per tenant/ACL" ON entity_instances.master_entities
    FOR SELECT TO authenticated
    USING (tenancy.has_entity_access(id, 'READ'));

CREATE POLICY "Master entities insertable within own client" ON entity_instances.master_entities
    FOR INSERT TO authenticated
    WITH CHECK (
        client_id IN (SELECT * FROM tenancy.current_client_ids())
        AND tenancy.has_permission(client_id, 'entity.write')
    );

CREATE POLICY "Master entities updatable per tenant/ACL" ON entity_instances.master_entities
    FOR UPDATE TO authenticated
    USING (tenancy.has_entity_access(id, 'WRITE'))
    WITH CHECK (
        client_id IN (SELECT * FROM tenancy.current_client_ids())
        AND tenancy.has_permission(client_id, 'entity.write')
    );

CREATE POLICY "Master entities deletable per permission" ON entity_instances.master_entities
    FOR DELETE TO authenticated
    USING (tenancy.has_entity_access(id, 'WRITE') AND tenancy.has_permission(client_id, 'entity.delete'));

-- -- source_attribute_values (staging values per entity) --
DROP POLICY IF EXISTS "Source attribute values readable by authenticated" ON entity_instances.source_attribute_values;

CREATE POLICY "Source attribute values readable per entity access" ON entity_instances.source_attribute_values
    FOR SELECT TO authenticated
    USING (tenancy.has_entity_access(entity_id, 'READ'));

CREATE POLICY "Source attribute values writable per entity access" ON entity_instances.source_attribute_values
    FOR ALL TO authenticated
    USING (tenancy.has_entity_access(entity_id, 'WRITE'))
    WITH CHECK (tenancy.has_entity_access(entity_id, 'WRITE'));

-- -- golden_master.entity_attribute_values --
DROP POLICY IF EXISTS "Golden master readable by authenticated" ON golden_master.entity_attribute_values;
DROP POLICY IF EXISTS "Golden master writable by authorized" ON golden_master.entity_attribute_values;

CREATE POLICY "Golden master readable per entity access" ON golden_master.entity_attribute_values
    FOR SELECT TO authenticated
    USING (tenancy.has_entity_access(entity_id, 'READ'));

CREATE POLICY "Golden master writable per entity access" ON golden_master.entity_attribute_values
    FOR ALL TO authenticated
    USING (tenancy.has_entity_access(entity_id, 'WRITE'))
    WITH CHECK (tenancy.has_entity_access(entity_id, 'WRITE'));

-- -- entity_instances.intersection_instances / intersection_members / golden_master.intersection_attribute_values --
-- (never had RLS enabled before this migration)
ALTER TABLE entity_instances.intersection_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_instances.intersection_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE golden_master.intersection_attribute_values ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Intersections readable if all members accessible" ON entity_instances.intersection_instances
    FOR SELECT TO authenticated
    USING (
        NOT EXISTS (
            SELECT 1 FROM entity_instances.intersection_members im
            WHERE im.intersection_id = entity_instances.intersection_instances.id
              AND im.valid_to = '9999-12-31' AND im.system_to = '9999-12-31 23:59:59'
              AND NOT tenancy.has_entity_access(im.entity_id, 'READ')
        )
    );

CREATE POLICY "Intersections insertable within own client" ON entity_instances.intersection_instances
    FOR INSERT TO authenticated
    WITH CHECK (
        client_id IN (SELECT * FROM tenancy.current_client_ids())
        AND tenancy.has_permission(client_id, 'entity.write')
    );

CREATE POLICY "Intersections updatable if all members accessible" ON entity_instances.intersection_instances
    FOR UPDATE TO authenticated
    USING (
        NOT EXISTS (
            SELECT 1 FROM entity_instances.intersection_members im
            WHERE im.intersection_id = entity_instances.intersection_instances.id
              AND im.valid_to = '9999-12-31' AND im.system_to = '9999-12-31 23:59:59'
              AND NOT tenancy.has_entity_access(im.entity_id, 'WRITE')
        )
    )
    WITH CHECK (client_id IN (SELECT * FROM tenancy.current_client_ids()) AND tenancy.has_permission(client_id, 'entity.write'));

CREATE POLICY "Intersections deletable per permission" ON entity_instances.intersection_instances
    FOR DELETE TO authenticated
    USING (client_id IN (SELECT * FROM tenancy.current_client_ids()) AND tenancy.has_permission(client_id, 'entity.delete'));

CREATE POLICY "Intersection members readable per entity access" ON entity_instances.intersection_members
    FOR SELECT TO authenticated
    USING (tenancy.has_entity_access(entity_id, 'READ'));

CREATE POLICY "Intersection members writable per entity access" ON entity_instances.intersection_members
    FOR ALL TO authenticated
    USING (tenancy.has_entity_access(entity_id, 'WRITE'))
    WITH CHECK (tenancy.has_entity_access(entity_id, 'WRITE'));

CREATE POLICY "Intersection attribute values readable per member access" ON golden_master.intersection_attribute_values
    FOR SELECT TO authenticated
    USING (
        NOT EXISTS (
            SELECT 1 FROM entity_instances.intersection_members im
            WHERE im.intersection_id = golden_master.intersection_attribute_values.intersection_id
              AND im.valid_to = '9999-12-31' AND im.system_to = '9999-12-31 23:59:59'
              AND NOT tenancy.has_entity_access(im.entity_id, 'READ')
        )
    );

CREATE POLICY "Intersection attribute values writable per member access" ON golden_master.intersection_attribute_values
    FOR ALL TO authenticated
    USING (
        NOT EXISTS (
            SELECT 1 FROM entity_instances.intersection_members im
            WHERE im.intersection_id = golden_master.intersection_attribute_values.intersection_id
              AND im.valid_to = '9999-12-31' AND im.system_to = '9999-12-31 23:59:59'
              AND NOT tenancy.has_entity_access(im.entity_id, 'WRITE')
        )
    )
    WITH CHECK (
        NOT EXISTS (
            SELECT 1 FROM entity_instances.intersection_members im
            WHERE im.intersection_id = golden_master.intersection_attribute_values.intersection_id
              AND im.valid_to = '9999-12-31' AND im.system_to = '9999-12-31 23:59:59'
              AND NOT tenancy.has_entity_access(im.entity_id, 'WRITE')
        )
    );

-- -- position_master (legacy fixed-shape intersections) --
DROP POLICY IF EXISTS "Position intersections readable by authenticated" ON position_master.dimensional_intersections;
DROP POLICY IF EXISTS "Position metrics readable by authenticated" ON position_master.position_metrics;

CREATE POLICY "Dimensional intersections readable per member access" ON position_master.dimensional_intersections
    FOR SELECT TO authenticated
    USING (
        (fund_entity_id IS NULL OR tenancy.has_entity_access(fund_entity_id, 'READ'))
        AND (issuer_entity_id IS NULL OR tenancy.has_entity_access(issuer_entity_id, 'READ'))
        AND (deal_entity_id IS NULL OR tenancy.has_entity_access(deal_entity_id, 'READ'))
        AND (security_entity_id IS NULL OR tenancy.has_entity_access(security_entity_id, 'READ'))
    );

CREATE POLICY "Dimensional intersections writable per member access" ON position_master.dimensional_intersections
    FOR ALL TO authenticated
    USING (
        (fund_entity_id IS NULL OR tenancy.has_entity_access(fund_entity_id, 'WRITE'))
        AND (issuer_entity_id IS NULL OR tenancy.has_entity_access(issuer_entity_id, 'WRITE'))
        AND (deal_entity_id IS NULL OR tenancy.has_entity_access(deal_entity_id, 'WRITE'))
        AND (security_entity_id IS NULL OR tenancy.has_entity_access(security_entity_id, 'WRITE'))
    )
    WITH CHECK (
        (fund_entity_id IS NULL OR tenancy.has_entity_access(fund_entity_id, 'WRITE'))
        AND (issuer_entity_id IS NULL OR tenancy.has_entity_access(issuer_entity_id, 'WRITE'))
        AND (deal_entity_id IS NULL OR tenancy.has_entity_access(deal_entity_id, 'WRITE'))
        AND (security_entity_id IS NULL OR tenancy.has_entity_access(security_entity_id, 'WRITE'))
    );

CREATE POLICY "Position metrics readable per intersection access" ON position_master.position_metrics
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM position_master.dimensional_intersections di
            WHERE di.id = position_master.position_metrics.intersection_id
              AND (di.fund_entity_id IS NULL OR tenancy.has_entity_access(di.fund_entity_id, 'READ'))
              AND (di.issuer_entity_id IS NULL OR tenancy.has_entity_access(di.issuer_entity_id, 'READ'))
              AND (di.deal_entity_id IS NULL OR tenancy.has_entity_access(di.deal_entity_id, 'READ'))
              AND (di.security_entity_id IS NULL OR tenancy.has_entity_access(di.security_entity_id, 'READ'))
        )
    );

CREATE POLICY "Position metrics writable per intersection access" ON position_master.position_metrics
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM position_master.dimensional_intersections di
            WHERE di.id = position_master.position_metrics.intersection_id
              AND (di.fund_entity_id IS NULL OR tenancy.has_entity_access(di.fund_entity_id, 'WRITE'))
              AND (di.issuer_entity_id IS NULL OR tenancy.has_entity_access(di.issuer_entity_id, 'WRITE'))
              AND (di.deal_entity_id IS NULL OR tenancy.has_entity_access(di.deal_entity_id, 'WRITE'))
              AND (di.security_entity_id IS NULL OR tenancy.has_entity_access(di.security_entity_id, 'WRITE'))
        )
    );

-- -- data_quality.dq_exceptions --
DROP POLICY IF EXISTS "DQ exceptions readable by authenticated" ON data_quality.dq_exceptions;
DROP POLICY IF EXISTS "DQ exceptions writable by ops" ON data_quality.dq_exceptions;

CREATE POLICY "DQ exceptions readable per entity access" ON data_quality.dq_exceptions
    FOR SELECT TO authenticated
    USING (tenancy.has_entity_access(entity_id, 'READ'));

CREATE POLICY "DQ exceptions writable per entity access" ON data_quality.dq_exceptions
    FOR ALL TO authenticated
    USING (tenancy.has_entity_access(entity_id, 'WRITE'))
    WITH CHECK (tenancy.has_entity_access(entity_id, 'WRITE'));

-- ============================================================
-- 4. Shared platform catalog tables: keep "readable by all authenticated",
--    add tenant-admin-only write policies (these are cross-client taxonomy/
--    config, not per-client data), and enable RLS on tables added after 00008
--    that never had it.
--
-- Defensive by design: this project's migration history has some drift from
-- what's actually on disk (several of these tables/relations may not exist on
-- a given database depending on which migrations actually ran), so each table
-- is existence-checked via to_regclass() and skipped with a NOTICE rather than
-- failing the whole migration. Policy names are also kept short and
-- table-scoped (not schema-qualified) to stay under Postgres's 63-byte
-- identifier limit -- policy names only need to be unique per-table, not
-- globally.
-- ============================================================
DO $$
DECLARE
    v_table TEXT;
    v_short_name TEXT;
    v_catalog_tables TEXT[] := ARRAY[
        'metadata_register.domain_types',
        'metadata_register.attribute_register',
        'metadata_register.domain_templates',
        'metadata_register.template_attribute_assignments',
        'metadata_register.reference_lists',
        'metadata_register.reference_list_values',
        'metadata_register.relationship_types',
        'metadata_register.intersection_types',
        'metadata_register.intersection_type_members',
        'metadata_register.entity_identifier_definitions',
        'metadata_register.precedence_rules',
        'metadata_register.precedence_rule_conditions',
        'metadata_register.precedence_rule_chain',
        'entity_instances.source_registry',
        'entity_instances.feed_lineage',
        'entity_instances.import_maps',
        'entity_instances.import_executions',
        'entity_instances.data_connections',
        'entity_instances.data_loaders',
        'data_quality.dq_rules'
    ];
BEGIN
    FOREACH v_table IN ARRAY v_catalog_tables LOOP
        IF to_regclass(v_table) IS NULL THEN
            RAISE NOTICE 'Skipping tenancy catalog RLS for %: relation does not exist on this database', v_table;
            CONTINUE;
        END IF;

        v_short_name := split_part(v_table, '.', 2);

        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_table);

        -- Read policy for anyone authenticated, if one doesn't already exist from 00008.
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname || '.' || tablename = v_table AND cmd = 'SELECT'
        ) THEN
            EXECUTE format(
                'CREATE POLICY %I ON %s FOR SELECT TO authenticated USING (TRUE)',
                v_short_name || '_select_authenticated', v_table
            );
        END IF;

        -- Platform-admin write policy (tenant admins manage shared catalog/config).
        EXECUTE format(
            'CREATE POLICY %I ON %s FOR ALL TO authenticated USING (tenancy.is_tenant_admin()) WITH CHECK (tenancy.is_tenant_admin())',
            v_short_name || '_write_tenant_admin', v_table
        );
    END LOOP;
END;
$$;
