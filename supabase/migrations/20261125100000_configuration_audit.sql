-- Who changed the configuration, and when.
--
-- tenancy.audit_log already records every change to access: membership, roles,
-- grants, sign-in rules, support mode. This extends the same append-only log to
-- the tables clients configure the platform with: entity types, attributes,
-- templates, reference lists, precedence and match rules, calculations, data
-- quality and compliance rules, import and feed maps, feeds, connections,
-- schedules, workflows, agents, surfaces and document templates.
--
-- One trigger function serves every table. What differs between tables is in
-- the trigger's arguments, not in the function:
--   'parent=<column>:<schema.table>'  where to find the client for a row that
--                                    has no client_id of its own. Repeat for
--                                    each hop, in order.
--   'ignore=<column>,<column>'       columns whose change alone is not worth an
--                                    entry (a cursor a job moves forward).
-- updated_at, updated_by and any column starting last_ or next_ are always
-- bookkeeping: an update that changes only those is not recorded.
--
-- Secrets never reach the log. Vault holds credentials; the columns that point
-- at them or carry headers and tokens are removed from the stored rows. Their
-- names still appear in changed_fields, so a rotated token shows as a change.
--
-- The log gains schema_name and changed_fields. Rows already written keep
-- schema_name 'tenancy' (every table logged until now is in tenancy) and have
-- no changed_fields; the reader works it out from old_row and new_row.
--
-- public.audit_log_entries reads the log for the admin screen. Staff in support
-- mode see that client. Otherwise staff see shared configuration and their own
-- clients; a client's user or role managers see their client's entries.

ALTER TABLE tenancy.audit_log ADD COLUMN IF NOT EXISTS schema_name TEXT NOT NULL DEFAULT 'tenancy';
ALTER TABLE tenancy.audit_log ALTER COLUMN schema_name DROP DEFAULT;
ALTER TABLE tenancy.audit_log ADD COLUMN IF NOT EXISTS changed_fields TEXT[];
CREATE INDEX IF NOT EXISTS idx_tenancy_audit_table_time ON tenancy.audit_log (schema_name, table_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenancy_audit_time ON tenancy.audit_log (occurred_at DESC, id DESC);
COMMENT ON TABLE tenancy.audit_log IS
    'Who changed access (membership, roles, permissions, grants, sign-in rules, staff status, support mode) or configuration (entity types, attributes, templates, rules, maps, feeds, workflows, surfaces), and when. Written only by triggers; rows are never changed or removed.';
COMMENT ON COLUMN tenancy.audit_log.schema_name IS 'Schema of the changed table.';
COMMENT ON COLUMN tenancy.audit_log.changed_fields IS 'Columns an UPDATE changed, secrets included by name. NULL for inserts, deletes and entries written before 2026-11-25.';

CREATE OR REPLACE FUNCTION tenancy.audit_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_old JSONB := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
    v_new JSONB := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
    v_row JSONB := COALESCE(v_new, v_old);
    v_client UUID;
    v_changed TEXT[];
    v_ignore TEXT[] := ARRAY['updated_at', 'updated_by'];
    v_secrets CONSTANT TEXT[] := ARRAY[
        'client_secret', 'secret', 'metadata_xml', 'inbound_token', 'token_hash',
        'auth_config', 'endpoint_headers'
    ];
    v_arg TEXT;
    v_hops TEXT[] := ARRAY[]::TEXT[];
    v_hop TEXT;
    v_fk TEXT;
    v_parent REGCLASS;
    v_id_type TEXT;
    v_cur JSONB;
    v_pk TEXT[];
    v_row_id TEXT;
BEGIN
    FOREACH v_arg IN ARRAY COALESCE(TG_ARGV, ARRAY[]::TEXT[]) LOOP
        IF v_arg LIKE 'parent=%' THEN
            v_hops := v_hops || substr(v_arg, 8);
        ELSIF v_arg LIKE 'ignore=%' THEN
            v_ignore := v_ignore || string_to_array(substr(v_arg, 8), ',');
        END IF;
    END LOOP;

    -- Profiles: only staff status and active status matter here.
    IF TG_TABLE_SCHEMA = 'tenancy' AND TG_TABLE_NAME = 'profiles' AND TG_OP = 'UPDATE'
       AND (v_old -> 'is_tenant_admin') IS NOT DISTINCT FROM (v_new -> 'is_tenant_admin')
       AND (v_old -> 'is_active') IS NOT DISTINCT FROM (v_new -> 'is_active') THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        SELECT array_agg(k ORDER BY k) INTO v_changed
        FROM (
            SELECT jsonb_object_keys(v_old) AS k
            UNION
            SELECT jsonb_object_keys(v_new)
        ) keys
        WHERE (v_old -> k) IS DISTINCT FROM (v_new -> k);
        -- Nothing but bookkeeping moved: not a change anyone made.
        IF NOT EXISTS (
            SELECT 1 FROM unnest(COALESCE(v_changed, ARRAY[]::TEXT[])) AS c(k)
            WHERE k <> ALL (v_ignore) AND k !~ '^(last|next)_'
        ) THEN
            RETURN NULL;
        END IF;
    END IF;

    -- The client the row belongs to: its own client_id, the client itself, or
    -- the client of the parent the trigger arguments lead to.
    IF TG_TABLE_SCHEMA = 'tenancy' AND TG_TABLE_NAME = 'clients' THEN
        v_client := (v_row ->> 'id')::UUID;
    ELSE
        v_cur := v_row;
        FOREACH v_hop IN ARRAY v_hops LOOP
            EXIT WHEN v_cur IS NULL OR v_cur ? 'client_id';
            v_fk := split_part(v_hop, ':', 1);
            v_parent := split_part(v_hop, ':', 2)::REGCLASS;
            IF v_cur ->> v_fk IS NULL THEN
                v_cur := NULL;
                EXIT;
            END IF;
            SELECT format_type(a.atttypid, a.atttypmod) INTO v_id_type
            FROM pg_attribute a WHERE a.attrelid = v_parent AND a.attname = 'id';
            EXECUTE format('SELECT to_jsonb(p) FROM %s p WHERE p.id = CAST($1 AS %s)', v_parent, v_id_type)
                INTO v_cur USING v_cur ->> v_fk;
        END LOOP;
        v_client := NULLIF(v_cur ->> 'client_id', '')::UUID;
    END IF;

    -- A row without an id is named by its primary key.
    v_row_id := v_row ->> 'id';
    IF v_row_id IS NULL THEN
        SELECT array_agg(a.attname::TEXT ORDER BY k.ord) INTO v_pk
        FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE i.indrelid = TG_RELID AND i.indisprimary;
        SELECT string_agg(v_row ->> c, ':' ORDER BY o) INTO v_row_id
        FROM unnest(v_pk) WITH ORDINALITY AS p(c, o);
    END IF;

    -- Secrets never go into the log.
    v_old := v_old - v_secrets;
    v_new := v_new - v_secrets;

    INSERT INTO tenancy.audit_log (
        actor_user_id, actor_role, impersonated_client_id, client_id,
        schema_name, table_name, operation, row_id, old_row, new_row, changed_fields
    ) VALUES (
        auth.uid(),
        COALESCE(NULLIF(current_setting('request.jwt.claims', TRUE), '')::jsonb ->> 'role', current_user),
        tenancy.active_impersonation_client_id(),
        v_client,
        TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP,
        v_row_id,
        v_old, v_new, v_changed
    );
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION tenancy.audit_change() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION tenancy.audit_change() IS
    'Writes one tenancy.audit_log entry per changed row. Trigger arguments: parent=<column>:<schema.table> (repeatable) finds the client of a row with no client_id; ignore=<columns> lists bookkeeping columns.';

-- Every audited table and what its trigger needs to know. Tables are skipped
-- when they do not exist, so a database that lacks a module still applies this.
DO $$
DECLARE
    v_spec RECORD;
    v_args TEXT;
BEGIN
    FOR v_spec IN
        SELECT * FROM (VALUES
            -- Access (already audited; client_modules and grants are new)
            ('tenancy.clients', ARRAY[]::TEXT[]),
            ('tenancy.profiles', ARRAY[]::TEXT[]),
            ('tenancy.client_users', ARRAY[]::TEXT[]),
            ('tenancy.roles', ARRAY[]::TEXT[]),
            ('tenancy.role_permissions', ARRAY['parent=role_id:tenancy.roles']),
            ('tenancy.user_roles', ARRAY[]::TEXT[]),
            ('tenancy.entity_grants', ARRAY[]::TEXT[]),
            ('tenancy.client_identity_providers', ARRAY[]::TEXT[]),
            ('tenancy.client_auth_requirements', ARRAY[]::TEXT[]),
            ('tenancy.impersonation_sessions', ARRAY[]::TEXT[]),
            ('tenancy.client_modules', ARRAY[]::TEXT[]),
            ('tenancy.client_module_grants', ARRAY[]::TEXT[]),
            -- The catalog: entity types, attributes, templates, lists
            ('metadata_register.domain_types', ARRAY[]::TEXT[]),
            ('metadata_register.domain_groups', ARRAY[]::TEXT[]),
            ('metadata_register.attribute_register', ARRAY[]::TEXT[]),
            ('metadata_register.attribute_sections', ARRAY[]::TEXT[]),
            ('metadata_register.client_attribute_settings', ARRAY[]::TEXT[]),
            ('metadata_register.client_domain_settings', ARRAY[]::TEXT[]),
            ('metadata_register.domain_aliases', ARRAY[]::TEXT[]),
            ('metadata_register.attribute_aliases', ARRAY[]::TEXT[]),
            ('metadata_register.entity_name_aliases', ARRAY[]::TEXT[]),
            ('metadata_register.domain_templates', ARRAY[]::TEXT[]),
            ('metadata_register.template_sections', ARRAY['parent=template_id:metadata_register.domain_templates']),
            ('metadata_register.template_sources', ARRAY['parent=template_id:metadata_register.domain_templates']),
            ('metadata_register.template_attribute_assignments', ARRAY['parent=template_id:metadata_register.domain_templates']),
            ('metadata_register.reference_lists', ARRAY[]::TEXT[]),
            ('metadata_register.reference_list_values', ARRAY['parent=list_id:metadata_register.reference_lists']),
            ('metadata_register.relationship_types', ARRAY[]::TEXT[]),
            ('metadata_register.intersection_types', ARRAY[]::TEXT[]),
            ('metadata_register.intersection_type_members', ARRAY[]::TEXT[]),
            ('metadata_register.entity_identifier_definitions', ARRAY[]::TEXT[]),
            ('metadata_register.reconciliation_definitions', ARRAY[]::TEXT[]),
            -- How golden values are chosen and worked out
            ('metadata_register.precedence_rules', ARRAY[]::TEXT[]),
            ('metadata_register.precedence_rule_chain', ARRAY[]::TEXT[]),
            ('metadata_register.precedence_rule_conditions', ARRAY[]::TEXT[]),
            ('metadata_register.match_rules', ARRAY[]::TEXT[]),
            ('metadata_register.match_rule_clauses', ARRAY[]::TEXT[]),
            ('metadata_register.calc_definitions', ARRAY['parent=attribute_id:metadata_register.attribute_register']),
            ('metadata_register.calc_inputs', ARRAY['parent=calc_definition_id:metadata_register.calc_definitions', 'parent=attribute_id:metadata_register.attribute_register']),
            ('metadata_register.expression_functions', ARRAY[]::TEXT[]),
            -- Rules
            ('data_quality.dq_rules', ARRAY['parent=attribute_id:metadata_register.attribute_register']),
            ('compliance.rules', ARRAY[]::TEXT[]),
            ('compliance.rule_versions', ARRAY['parent=rule_id:compliance.rules']),
            ('compliance.rule_measure_lines', ARRAY['parent=rule_version_id:compliance.rule_versions', 'parent=rule_id:compliance.rules']),
            ('compliance.rule_conditions', ARRAY['parent=rule_version_id:compliance.rule_versions', 'parent=rule_id:compliance.rules']),
            ('compliance.rule_thresholds', ARRAY['parent=rule_id:compliance.rules']),
            ('compliance.rule_scope_assignments', ARRAY['parent=rule_id:compliance.rules']),
            -- Getting data in
            ('entity_instances.source_registry', ARRAY[]::TEXT[]),
            ('entity_instances.import_maps', ARRAY[]::TEXT[]),
            ('entity_instances.feed_maps', ARRAY[]::TEXT[]),
            ('entity_instances.data_connections', ARRAY['ignore=connection_status']),
            ('entity_instances.data_loaders', ARRAY['ignore=loader_status']),
            ('ops.connections', ARRAY[]::TEXT[]),
            ('ops.feeds', ARRAY[]::TEXT[]),
            ('ops.job_schedules', ARRAY[]::TEXT[]),
            -- Workflows, the assistant and agents
            ('ops.workflows', ARRAY[]::TEXT[]),
            ('ops.workflow_versions', ARRAY['parent=workflow_id:ops.workflows']),
            ('ops.workflow_triggers', ARRAY['ignore=cursor_at,cursor_id']),
            ('ops.workflow_service_accounts', ARRAY[]::TEXT[]),
            ('ops.notification_settings', ARRAY[]::TEXT[]),
            ('ops.responsibilities', ARRAY[]::TEXT[]),
            ('ops.agents', ARRAY[]::TEXT[]),
            ('ops.assistant_settings', ARRAY[]::TEXT[]),
            ('ops.assistant_mcp_servers', ARRAY[]::TEXT[]),
            -- What people see
            ('public.surface_definitions', ARRAY[]::TEXT[]),
            ('public.surface_blueprints', ARRAY[]::TEXT[]),
            ('public.narrative_templates', ARRAY[]::TEXT[]),
            ('public.dashboard_templates', ARRAY[]::TEXT[]),
            ('docs.templates', ARRAY[]::TEXT[]),
            ('docs.document_types', ARRAY[]::TEXT[])
        ) AS s(tbl, args)
    LOOP
        CONTINUE WHEN to_regclass(v_spec.tbl) IS NULL;
        SELECT COALESCE(string_agg(quote_literal(a), ', '), '') INTO v_args FROM unnest(v_spec.args) AS a;
        EXECUTE format('DROP TRIGGER IF EXISTS zz_audit_change ON %s', v_spec.tbl);
        EXECUTE format(
            'CREATE TRIGGER zz_audit_change AFTER INSERT OR UPDATE OR DELETE ON %s '
            'FOR EACH ROW EXECUTE FUNCTION tenancy.audit_change(%s)', v_spec.tbl, v_args);
    END LOOP;
END;
$$;

-- The entries this session may read, newest first.
--   p_kind 'access' (tenancy tables), 'configuration' (every other), or NULL.
--   p_before_id pages: pass the last id of the previous page.
CREATE OR REPLACE FUNCTION public.audit_log_entries(
    p_kind TEXT DEFAULT NULL,
    p_from TIMESTAMPTZ DEFAULT NULL,
    p_to TIMESTAMPTZ DEFAULT NULL,
    p_table TEXT DEFAULT NULL,
    p_actor_user_id UUID DEFAULT NULL,
    p_row_id TEXT DEFAULT NULL,
    p_search TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 100,
    p_before_id BIGINT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
    v_support UUID := tenancy.active_impersonation_client_id();
    v_staff BOOLEAN := tenancy.is_tenant_admin();
    v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
    v_kind TEXT := NULLIF(lower(btrim(COALESCE(p_kind, ''))), '');
    v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
    v_clients UUID[];
    v_result JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Sign in to read the audit log' USING ERRCODE = '42501';
    END IF;
    IF v_kind IS NOT NULL AND v_kind NOT IN ('access', 'configuration') THEN
        RAISE EXCEPTION 'Kind is access or configuration';
    END IF;

    -- The clients whose entries this caller reads.
    IF v_support IS NOT NULL THEN
        v_clients := ARRAY[v_support];
    ELSE
        SELECT COALESCE(array_agg(c), ARRAY[]::UUID[]) INTO v_clients
        FROM tenancy.current_client_ids() AS c
        WHERE v_staff
           OR tenancy.has_permission(c, 'user.manage')
           OR tenancy.has_permission(c, 'role.manage');
    END IF;
    IF NOT v_staff AND cardinality(v_clients) = 0 THEN
        RAISE EXCEPTION 'Reading the audit log needs user or role management in this client' USING ERRCODE = '42501';
    END IF;

    WITH visible AS (
        SELECT l.*
        FROM tenancy.audit_log l
        WHERE (l.client_id = ANY (v_clients)
               -- Shared configuration and platform access: staff outside support mode.
               OR (l.client_id IS NULL AND v_staff AND v_support IS NULL))
          AND (v_kind IS NULL
               OR (v_kind = 'access' AND l.schema_name = 'tenancy')
               OR (v_kind = 'configuration' AND l.schema_name <> 'tenancy'))
          AND (p_from IS NULL OR l.occurred_at >= p_from)
          AND (p_to IS NULL OR l.occurred_at < p_to)
          AND (p_table IS NULL OR l.schema_name || '.' || l.table_name = p_table OR l.table_name = p_table)
          AND (p_actor_user_id IS NULL OR l.actor_user_id = p_actor_user_id)
          AND (p_row_id IS NULL OR l.row_id = p_row_id)
          AND (p_before_id IS NULL OR l.id < p_before_id)
          AND (v_search IS NULL
               OR l.row_id ILIKE '%' || v_search || '%'
               OR COALESCE(l.new_row, l.old_row)::TEXT ILIKE '%' || v_search || '%')
        ORDER BY l.id DESC
        LIMIT v_limit + 1
    )
    SELECT jsonb_build_object(
        'entries', COALESCE(jsonb_agg(e ORDER BY (e ->> 'id')::BIGINT DESC) FILTER (WHERE rn <= v_limit), '[]'::jsonb),
        'hasMore', COALESCE(bool_or(rn > v_limit), FALSE)
    ) INTO v_result
    FROM (
        SELECT row_number() OVER (ORDER BY v.id DESC) AS rn,
               jsonb_build_object(
                   'id', v.id,
                   'occurredAt', v.occurred_at,
                   'actorUserId', v.actor_user_id,
                   'actorLabel', CASE
                       WHEN v.actor_user_id IS NULL THEN
                           CASE WHEN v.actor_role = 'service_role' THEN 'Platform service' ELSE 'Database (' || COALESCE(v.actor_role, 'unknown') || ')' END
                       ELSE COALESCE(pr.display_name, u.email, 'Unknown user')
                   END,
                   'actorEmail', u.email,
                   'actorRole', v.actor_role,
                   'supportMode', v.impersonated_client_id IS NOT NULL,
                   'clientId', v.client_id,
                   'clientName', cl.client_name,
                   'kind', CASE WHEN v.schema_name = 'tenancy' THEN 'access' ELSE 'configuration' END,
                   'schemaName', v.schema_name,
                   'tableName', v.table_name,
                   'operation', v.operation,
                   'rowId', v.row_id,
                   'changedFields', to_jsonb(v.changed_fields),
                   'oldRow', v.old_row,
                   'newRow', v.new_row
               ) AS e
        FROM visible v
        LEFT JOIN tenancy.profiles pr ON pr.id = v.actor_user_id
        LEFT JOIN auth.users u ON u.id = v.actor_user_id
        LEFT JOIN tenancy.clients cl ON cl.id = v.client_id
    ) rows;

    RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.audit_log_entries(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT, INTEGER, BIGINT) IS
    'Audit log entries the caller may read, newest first, as {entries, hasMore}. Staff in support mode read that client; other staff read their clients and shared entries; members with user.manage or role.manage read their client.';
REVOKE ALL ON FUNCTION public.audit_log_entries(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT, INTEGER, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_log_entries(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID, TEXT, TEXT, INTEGER, BIGINT) TO authenticated;

NOTIFY pgrst, 'reload schema';
