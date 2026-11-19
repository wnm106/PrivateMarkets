-- Named agents.
--
-- Until now a workflow's agent step was anonymous: its tools and its
-- instructions lived on the step, and nothing said what kind of work it did.
-- An agent is a standing definition a step can run as:
--
--   charter         who the agent is and how it should judge, added to the
--                   step's instructions;
--   activity_codes  the kinds of work it does (ops.activities). A review of
--                   its proposals goes to the people responsible for that
--                   activity when the agent has exactly one;
--   domain_codes    the domains it may propose changes in. Empty means any;
--   tool_names      the tools it may use, reading and proposing. Empty means
--                   whatever the step allows.
--
-- An agent narrows a step. It never widens one: a step still lists its own
-- tools, and the agent's list is applied on top. An agent still cannot change
-- data. It proposes, and a person decides.
--
-- A shared agent (no client) is offered to every client. A client's own agent
-- with the same code is used in its place for that client.
--
-- Every agent still runs as the client's workflow service account, so the
-- domain list is enforced on what the agent proposes, not on what it can read.
--
-- Safe to run again.

CREATE TABLE IF NOT EXISTS ops.agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    agent_code VARCHAR(60) NOT NULL,
    agent_name TEXT NOT NULL,
    description TEXT,
    charter TEXT NOT NULL DEFAULT '',
    activity_codes TEXT[] NOT NULL DEFAULT '{}',
    domain_codes TEXT[] NOT NULL DEFAULT '{}',
    tool_names TEXT[] NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agents_code CHECK (agent_code ~ '^[A-Z][A-Z0-9_]{1,59}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_unique
    ON ops.agents (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), agent_code);
ALTER TABLE ops.agents ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE ops.agents IS
    'A standing definition a workflow agent step can run as: charter, activities, domains, and tools. client_id NULL is shared by every client.';

INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('agent.manage', 'Create and change this client''s agents')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code = 'agent.manage'
WHERE r.role_code = 'CLIENT_ADMIN' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- A shared agent is changed by a tenant admin only.
CREATE OR REPLACE FUNCTION ops.agent_can_manage(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN TRUE
        WHEN tenancy.is_tenant_admin() THEN TRUE
        WHEN p_client_id IS NULL THEN FALSE
        ELSE tenancy.has_permission(p_client_id, 'agent.manage')
    END;
$$;

CREATE OR REPLACE FUNCTION ops.agent_view(p_row ops.agents)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT to_jsonb(p_row) || jsonb_build_object(
        'is_shared', p_row.client_id IS NULL,
        'can_manage', ops.agent_can_manage(p_row.client_id),
        'activity_names', COALESCE((
            SELECT jsonb_agg(a.activity_name ORDER BY a.sort_order, a.activity_name)
            FROM ops.activities AS a WHERE a.activity_code = ANY (p_row.activity_codes)
        ), '[]'::jsonb)
    );
$$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

-- The shared agents and the agents of the caller's clients (or of one client).
CREATE OR REPLACE FUNCTION public.agents_list(p_client_id UUID DEFAULT NULL)
RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT ops.agent_view(a)
    FROM ops.agents AS a
    WHERE (ops.is_service_role() OR auth.uid() IS NOT NULL)
      AND (
          a.client_id IS NULL
          OR (ops.can_see(a.client_id) AND (p_client_id IS NULL OR a.client_id = p_client_id))
      )
    ORDER BY a.agent_name, a.client_id NULLS FIRST;
$$;

-- The agent a step in this client runs as: the client's own, or else the
-- shared one. NULL when there is none. For the worker.
CREATE OR REPLACE FUNCTION public.workflow_worker_agent(p_client_id UUID, p_code TEXT)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, pg_temp
AS $$
    SELECT to_jsonb(a) || jsonb_build_object('is_shared', a.client_id IS NULL)
    FROM ops.agents AS a
    WHERE a.agent_code = upper(btrim(COALESCE(p_code, '')))
      AND (a.client_id IS NULL OR a.client_id = p_client_id)
    ORDER BY a.client_id NULLS LAST
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Creates an agent, or changes the one with p_id. p_client_id NULL makes a
-- shared agent, which needs a tenant admin. Tool names are not checked here:
-- the tool list lives with the worker, and a name it does not know is ignored.
CREATE OR REPLACE FUNCTION public.agent_save(
    p_id UUID,
    p_client_id UUID,
    p_code TEXT,
    p_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_charter TEXT DEFAULT '',
    p_activities TEXT[] DEFAULT '{}',
    p_domains TEXT[] DEFAULT '{}',
    p_tools TEXT[] DEFAULT '{}',
    p_is_active BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, metadata_register, pg_temp
AS $$
DECLARE
    v_code TEXT := upper(btrim(COALESCE(p_code, '')));
    v_name TEXT := btrim(COALESCE(p_name, ''));
    v_activities TEXT[] := ARRAY(SELECT DISTINCT upper(btrim(x)) FROM unnest(COALESCE(p_activities, '{}')) AS x WHERE btrim(COALESCE(x, '')) <> '' ORDER BY 1);
    v_tools TEXT[] := ARRAY(SELECT DISTINCT btrim(x) FROM unnest(COALESCE(p_tools, '{}')) AS x WHERE btrim(COALESCE(x, '')) <> '' ORDER BY 1);
    v_domains TEXT[];
    v_missing TEXT;
    v_row ops.agents;
BEGIN
    IF auth.uid() IS NULL AND NOT ops.is_service_role() THEN
        RAISE EXCEPTION 'Sign in to change an agent' USING ERRCODE = '42501';
    END IF;

    IF p_id IS NOT NULL THEN
        SELECT * INTO v_row FROM ops.agents WHERE id = p_id FOR UPDATE;
        IF NOT FOUND OR (v_row.client_id IS NOT NULL AND NOT ops.can_see(v_row.client_id)) THEN
            RAISE EXCEPTION 'That agent was not found' USING ERRCODE = 'P0002';
        END IF;
        -- An agent stays with the client it was made for.
        p_client_id := v_row.client_id;
    ELSIF p_client_id IS NOT NULL AND NOT ops.can_see(p_client_id) THEN
        RAISE EXCEPTION 'That client was not found' USING ERRCODE = 'P0002';
    END IF;

    IF NOT ops.agent_can_manage(p_client_id) THEN
        RAISE EXCEPTION '%', CASE WHEN p_client_id IS NULL
            THEN 'A shared agent is changed by a tenant admin. Make a copy for your client instead.'
            ELSE 'You cannot change this client''s agents' END USING ERRCODE = '42501';
    END IF;
    IF v_code !~ '^[A-Z][A-Z0-9_]{1,59}$' THEN
        RAISE EXCEPTION 'The code starts with a letter and uses letters, digits, and underscores' USING ERRCODE = '22023';
    END IF;
    IF v_name = '' THEN
        RAISE EXCEPTION 'Give the agent a name' USING ERRCODE = '22023';
    END IF;

    SELECT x INTO v_missing FROM unnest(v_activities) AS x
    WHERE NOT EXISTS (SELECT 1 FROM ops.activities AS a WHERE a.activity_code = x) LIMIT 1;
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'There is no activity called %', v_missing USING ERRCODE = '22023';
    END IF;

    -- Domains are stored as the register spells them.
    SELECT x INTO v_missing FROM unnest(COALESCE(p_domains, '{}')) AS x
    WHERE btrim(COALESCE(x, '')) <> ''
      AND NOT EXISTS (SELECT 1 FROM metadata_register.domain_types AS dt WHERE upper(dt.domain_code) = upper(btrim(x))) LIMIT 1;
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'There is no domain called %', v_missing USING ERRCODE = '22023';
    END IF;
    v_domains := ARRAY(
        SELECT DISTINCT dt.domain_code FROM metadata_register.domain_types AS dt
        WHERE upper(dt.domain_code) IN (SELECT upper(btrim(x)) FROM unnest(COALESCE(p_domains, '{}')) AS x)
        ORDER BY 1
    );

    BEGIN
        IF p_id IS NOT NULL THEN
            UPDATE ops.agents
               SET agent_code = v_code, agent_name = v_name, description = NULLIF(btrim(COALESCE(p_description, '')), ''),
                   charter = COALESCE(p_charter, ''), activity_codes = v_activities, domain_codes = v_domains,
                   tool_names = v_tools, is_active = COALESCE(p_is_active, TRUE), updated_at = NOW()
             WHERE id = p_id
            RETURNING * INTO v_row;
        ELSE
            INSERT INTO ops.agents (client_id, agent_code, agent_name, description, charter, activity_codes, domain_codes, tool_names, is_active, created_by)
            VALUES (p_client_id, v_code, v_name, NULLIF(btrim(COALESCE(p_description, '')), ''), COALESCE(p_charter, ''),
                    v_activities, v_domains, v_tools, COALESCE(p_is_active, TRUE), auth.uid())
            RETURNING * INTO v_row;
        END IF;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'There is already an agent with the code %', v_code USING ERRCODE = '23505';
    END;

    RETURN ops.agent_view(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.agent_delete(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_row ops.agents;
BEGIN
    SELECT * INTO v_row FROM ops.agents WHERE id = p_id;
    IF NOT FOUND OR (v_row.client_id IS NOT NULL AND NOT ops.can_see(v_row.client_id)) THEN
        RETURN FALSE;
    END IF;
    IF NOT ops.agent_can_manage(v_row.client_id) THEN
        RAISE EXCEPTION 'You cannot change this agent' USING ERRCODE = '42501';
    END IF;
    DELETE FROM ops.agents WHERE id = p_id;
    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- The four shared agents. A client copies one to change it.
-- ---------------------------------------------------------------------------

INSERT INTO ops.agents (client_id, agent_code, agent_name, description, charter, activity_codes, tool_names) VALUES
(NULL, 'STEWARD', 'Steward', 'Keeps golden records right: duplicates, source conflicts, missing and failing values.',
 'You are the data steward. You care that each record is right and that every value can be traced to a source. Prefer the newest signed or official source over market data and over anything typed by hand. Never overwrite a value a person entered deliberately without saying so and asking. When two records look like the same thing, say what makes you think so and what would prove it wrong.',
 ARRAY['DATA_QUALITY', 'DATA_STEWARDSHIP'],
 ARRAY['get_entity', 'list_entities', 'find_records', 'query_data', 'get_template_metadata', 'get_attribute_metadata', 'get_attribute_list_values',
       'get_field_lineage', 'get_temporal_history', 'compare_asof', 'get_data_quality_checks', 'get_dq_summary', 'list_dq_exceptions',
       'get_identifier_suggestions', 'get_relationship_types', 'search_attributes',
       'submit_manual_override', 'resolve_dq_exception', 'create_entity', 'create_entity_identifier', 'create_relationship', 'add_attribute_list_value']),
(NULL, 'RECONCILER', 'Reconciler', 'Works cash, position, and NAV breaks against the administrator.',
 'You are the reconciler. You explain breaks between our books and the administrator''s. For each break, find the cause before proposing anything: timing, a missing or duplicated entry, a price, an accrual, FX. Say how much of the break your explanation covers and what is left. Propose a match or an adjustment only when the amounts, dates, and counterparties agree; otherwise leave it for a person and say what you would check next.',
 ARRAY['RECONCILIATION'],
 ARRAY['get_cash_reconciliation', 'get_nav_reconciliation', 'get_position_reconciliation', 'list_fund_closes', 'get_entity', 'find_records',
       'query_data', 'get_field_lineage', 'get_temporal_history', 'compare_asof',
       'approve_cash_match', 'post_cash_adjustment', 'record_rec_decision', 'save_reconciliation_notes']),
(NULL, 'READER', 'Reader', 'Reads documents and proposes the values and records they support.',
 'You are the reader. You take values from documents: agreements, amendments, notices, statements. Quote the document''s own words for every value you propose and say where they sit. A later signed amendment outranks an earlier agreement. When a document disagrees with what is on the record, propose the change and say which is newer and why you trust it. Never infer a value the document does not state.',
 ARRAY['CAPITAL_ACTIVITY', 'DOCUMENTS'],
 ARRAY['list_documents', 'search_documents', 'get_document_section', 'get_entity', 'find_records', 'list_entities', 'get_template_metadata',
       'get_attribute_metadata', 'get_attribute_list_values', 'get_temporal_history', 'get_field_lineage',
       'submit_manual_override', 'create_entity', 'create_relationship']),
(NULL, 'ANALYST', 'Analyst', 'Answers questions and drafts reports from the data. Proposes no changes.',
 'You are the analyst. You answer questions and draft reports from the records as they stand. State the as-of date of every figure. When the data behind a figure is incomplete or fails a quality check, say so beside the figure rather than leaving it out. You do not change records: if something looks wrong, describe it so the steward or the reconciler can take it up.',
 ARRAY['COMPLIANCE', 'REPORTING'],
 ARRAY['query_data', 'get_data_query_spec', 'find_records', 'get_entity', 'list_entities', 'get_data_coverage', 'get_dq_summary',
       'list_compliance_rules', 'get_compliance_rule', 'list_compliance_breaches', 'list_narratives', 'get_narrative', 'list_report_templates',
       'get_nav_reconciliation', 'get_temporal_history'])
ON CONFLICT (COALESCE(client_id, '00000000-0000-0000-0000-000000000000'::uuid), agent_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.agent_can_manage(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.agent_view(ops.agents) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.agents_list(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agent_save(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT[], TEXT[], BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agent_delete(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workflow_worker_agent(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agents_list(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_save(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT[], TEXT[], BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_delete(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workflow_worker_agent(UUID, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
