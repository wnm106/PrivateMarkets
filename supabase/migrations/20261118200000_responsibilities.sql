-- Who is responsible for what.
--
-- Three things are kept apart:
--   tenancy.entity_grants     who CAN see a record (an allow-list);
--   ops.assistant_follows     who WANTS to hear about a record;
--   ops.responsibilities      who MUST act on a record. This migration.
--
-- A responsibility names a person or a role, for one record or for a whole
-- domain, optionally for one activity (reconciliation, data quality, ...).
-- A record's responsibility covers the records under it unless it says
-- otherwise, so the person responsible for a fund is responsible for its
-- positions.
--
-- The nearest assignment wins. Someone named on the record itself comes before
-- someone named on its parent, who comes before someone named on the domain.
-- A backup is used only when nobody at that level can act.
--
-- Being responsible grants nothing. It does not let a person read a record or
-- decide a review they could not before. Each use checks what it needs: review
-- routing keeps only people who hold workflow.review, and leaves the rest off.
--
-- The first use is workflow reviews. A review step that names no people and no
-- roles is given to the people responsible for the records its proposal
-- changes. With no responsibilities set, nothing changes: the review is open to
-- anyone who can review, as before.
--
-- Safe to run again.

-- ---------------------------------------------------------------------------
-- Activities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops.activities (
    activity_code VARCHAR(40) PRIMARY KEY,
    activity_name TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 100
);
ALTER TABLE ops.activities ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE ops.activities IS
    'The kinds of work a person or an agent can be responsible for. Shared by every client.';

INSERT INTO ops.activities (activity_code, activity_name, description, sort_order) VALUES
    ('DATA_STEWARDSHIP', 'Data stewardship', 'Golden records: merges, source conflicts, and overrides.', 10),
    ('DATA_QUALITY', 'Data quality', 'Rule failures and missing values.', 20),
    ('RECONCILIATION', 'Reconciliation', 'Cash, position, and NAV breaks against the administrator.', 30),
    ('CAPITAL_ACTIVITY', 'Capital activity', 'Capital calls, distributions, and investor allocations.', 40),
    ('COMPLIANCE', 'Compliance', 'Limits, breaches, and guideline tests.', 50),
    ('REPORTING', 'Reporting', 'Investor and board reports.', 60),
    ('DOCUMENTS', 'Documents', 'Documents read and the values taken from them.', 70)
ON CONFLICT (activity_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Responsibilities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops.responsibilities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    subject_type VARCHAR(20) NOT NULL,
    entity_id UUID REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    domain_code VARCHAR(50),
    include_children BOOLEAN NOT NULL DEFAULT TRUE,
    activity_code VARCHAR(40) REFERENCES ops.activities(activity_code) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    role_code VARCHAR(100),
    is_backup BOOLEAN NOT NULL DEFAULT FALSE,
    note TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT responsibilities_subject CHECK (
        (subject_type = 'ENTITY' AND entity_id IS NOT NULL AND domain_code IS NULL)
        OR (subject_type = 'DOMAIN' AND entity_id IS NULL AND domain_code IS NOT NULL)
    ),
    CONSTRAINT responsibilities_holder CHECK ((user_id IS NULL) <> (role_code IS NULL))
);

-- One row per subject, activity, and holder.
CREATE UNIQUE INDEX IF NOT EXISTS responsibilities_unique ON ops.responsibilities (
    client_id,
    subject_type,
    COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(domain_code, ''),
    COALESCE(activity_code, ''),
    COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(role_code, '')
);
CREATE INDEX IF NOT EXISTS responsibilities_entity ON ops.responsibilities (entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS responsibilities_domain ON ops.responsibilities (client_id, domain_code) WHERE domain_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS responsibilities_user ON ops.responsibilities (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE ops.responsibilities ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE ops.responsibilities IS
    'Who must act on a record or a domain. Grants no access. Reached only through the responsibility_* functions.';
COMMENT ON COLUMN ops.responsibilities.activity_code IS 'The activity this covers. NULL covers every activity.';
COMMENT ON COLUMN ops.responsibilities.include_children IS 'For a record: also covers the records under it.';
COMMENT ON COLUMN ops.responsibilities.is_backup IS 'Used only when nobody else named at the same level can act.';

-- How a review came to be assigned: STEP when the workflow step named people
-- or roles, RESPONSIBILITY when it was routed to the people responsible.
ALTER TABLE ops.workflow_reviews ADD COLUMN IF NOT EXISTS assignment_source VARCHAR(20);

INSERT INTO tenancy.permissions (permission_code, description) VALUES
    ('responsibility.manage', 'Say who is responsible for a record or a domain')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO tenancy.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM tenancy.roles r
JOIN tenancy.permissions p ON p.permission_code = 'responsibility.manage'
WHERE r.role_code = 'CLIENT_ADMIN' AND r.client_id IS NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Helpers. None is callable by API roles.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ops.responsibility_can_manage(p_client_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT CASE
        WHEN ops.is_service_role() THEN TRUE
        WHEN p_client_id IS NULL THEN FALSE
        WHEN tenancy.is_tenant_admin() THEN TRUE
        ELSE tenancy.has_permission(p_client_id, 'responsibility.manage')
    END;
$$;

-- A record and the records above it, nearest first. Cycles are cut.
CREATE OR REPLACE FUNCTION ops.responsibility_lineage(p_entity_id UUID)
RETURNS TABLE (entity_id UUID, depth INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = entity_instances, pg_temp
AS $$
    WITH RECURSIVE ancestry AS (
        SELECT p_entity_id AS entity_id, 0 AS depth, ARRAY[p_entity_id] AS path
        UNION ALL
        SELECT er.parent_entity_id, a.depth + 1, a.path || er.parent_entity_id
        FROM entity_instances.entity_relationships er
        JOIN ancestry a ON er.child_entity_id = a.entity_id
        WHERE er.valid_to = '9999-12-31'
          AND er.system_to = '9999-12-31 23:59:59'
          AND a.depth < 32
          AND NOT (er.parent_entity_id = ANY (a.path))
    )
    SELECT ancestry.entity_id, MIN(ancestry.depth)::integer FROM ancestry GROUP BY ancestry.entity_id;
$$;

-- The people a responsibility row names: the person, or everyone who holds the role in the client.
CREATE OR REPLACE FUNCTION ops.responsibility_holders(p_client_id UUID, p_user_id UUID, p_role_code TEXT)
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
    SELECT cu.user_id
    FROM tenancy.client_users AS cu
    JOIN tenancy.profiles AS pr ON pr.id = cu.user_id
    WHERE cu.client_id = p_client_id AND cu.is_active AND pr.is_active
      AND (
          cu.user_id = p_user_id
          OR (p_role_code IS NOT NULL AND EXISTS (
              SELECT 1
              FROM tenancy.user_roles AS ur
              JOIN tenancy.roles AS ro ON ro.id = ur.role_id
              WHERE ur.client_id = p_client_id AND ur.user_id = cu.user_id AND ro.role_code = p_role_code
          ))
      );
$$;

-- Who is responsible for a set of records and domains, for one activity.
--
-- Each record is settled on its own: the assignments on the record itself, or
-- else on its nearest parent that has any, or else on its domain. A domain
-- code passed directly is settled by the assignments on that domain. An
-- assignment with no activity covers every activity, and a NULL p_activity
-- asks for everyone whatever their activity.
--
-- Returns one row per person. is_backup is true only when every assignment
-- that names them is a backup.
CREATE OR REPLACE FUNCTION ops.responsible_people(
    p_client_id UUID,
    p_entity_ids UUID[],
    p_domain_codes TEXT[] DEFAULT '{}',
    p_activity TEXT DEFAULT NULL
) RETURNS TABLE (user_id UUID, is_backup BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, entity_instances, pg_temp
AS $$
    WITH subjects AS (
        SELECT me.id AS entity_id, me.domain_code
        FROM entity_instances.master_entities AS me
        WHERE me.id = ANY (COALESCE(p_entity_ids, '{}')) AND me.client_id = p_client_id
    ),
    candidates AS (
        -- On the record or a record above it.
        SELECT s.entity_id::text AS subject, l.depth AS distance, r.user_id, r.role_code, r.is_backup
        FROM subjects AS s
        CROSS JOIN LATERAL ops.responsibility_lineage(s.entity_id) AS l
        JOIN ops.responsibilities AS r
          ON r.client_id = p_client_id AND r.subject_type = 'ENTITY' AND r.entity_id = l.entity_id
         AND (l.depth = 0 OR r.include_children)
        WHERE p_activity IS NULL OR r.activity_code IS NULL OR r.activity_code = p_activity
        UNION ALL
        -- On the record's domain.
        SELECT s.entity_id::text, 1000, r.user_id, r.role_code, r.is_backup
        FROM subjects AS s
        JOIN ops.responsibilities AS r
          ON r.client_id = p_client_id AND r.subject_type = 'DOMAIN' AND r.domain_code = s.domain_code
        WHERE p_activity IS NULL OR r.activity_code IS NULL OR r.activity_code = p_activity
        UNION ALL
        -- On a domain named directly.
        SELECT 'domain:' || d.code, 1000, r.user_id, r.role_code, r.is_backup
        FROM (SELECT DISTINCT upper(btrim(x)) AS code FROM unnest(COALESCE(p_domain_codes, '{}')) AS x WHERE btrim(COALESCE(x, '')) <> '') AS d
        JOIN ops.responsibilities AS r
          ON r.client_id = p_client_id AND r.subject_type = 'DOMAIN' AND upper(r.domain_code) = d.code
        WHERE p_activity IS NULL OR r.activity_code IS NULL OR r.activity_code = p_activity
    ),
    nearest AS (
        SELECT c.*
        FROM candidates AS c
        JOIN (SELECT subject, MIN(distance) AS distance FROM candidates GROUP BY subject) AS m
          ON m.subject = c.subject AND m.distance = c.distance
    )
    SELECT h.user_id, bool_and(n.is_backup)
    FROM nearest AS n
    CROSS JOIN LATERAL ops.responsibility_holders(p_client_id, n.user_id, n.role_code) AS h(user_id)
    WHERE NOT EXISTS (SELECT 1 FROM ops.workflow_service_accounts AS sa WHERE sa.user_id = h.user_id)
    GROUP BY h.user_id;
$$;

-- A responsibility as every read returns it.
CREATE OR REPLACE FUNCTION ops.responsibility_view(p_row ops.responsibilities)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, entity_instances, metadata_register, pg_temp
AS $$
    SELECT to_jsonb(p_row) || jsonb_build_object(
        'entity_name', (SELECT me.entity_name FROM entity_instances.master_entities AS me WHERE me.id = p_row.entity_id),
        'entity_domain_code', (SELECT me.domain_code FROM entity_instances.master_entities AS me WHERE me.id = p_row.entity_id),
        'activity_name', (SELECT a.activity_name FROM ops.activities AS a WHERE a.activity_code = p_row.activity_code),
        'user_name', (SELECT COALESCE(pr.display_name, 'Unnamed person') FROM tenancy.profiles AS pr WHERE pr.id = p_row.user_id),
        'role_name', (
            SELECT ro.role_name FROM tenancy.roles AS ro
            WHERE ro.role_code = p_row.role_code AND (ro.client_id = p_row.client_id OR ro.client_id IS NULL)
            ORDER BY ro.client_id NULLS LAST LIMIT 1
        ),
        'is_mine', auth.uid() IS NOT NULL AND EXISTS (
            SELECT 1 FROM ops.responsibility_holders(p_row.client_id, p_row.user_id, p_row.role_code) AS h(user_id)
            WHERE h.user_id = auth.uid()
        ),
        'can_manage', ops.responsibility_can_manage(p_row.client_id)
    );
$$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

-- Responsibilities in the clients the caller belongs to. Filter by record, by
-- domain, or to the caller's own. A record the caller cannot read is left out.
CREATE OR REPLACE FUNCTION public.responsibilities_list(
    p_entity_id UUID DEFAULT NULL,
    p_domain_code TEXT DEFAULT NULL,
    p_mine BOOLEAN DEFAULT FALSE
) RETURNS SETOF JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, entity_instances, pg_temp
AS $$
    SELECT v.view
    FROM (
        SELECT ops.responsibility_view(r) AS view, r.subject_type, r.domain_code, r.is_backup, r.created_at
        FROM ops.responsibilities AS r
        WHERE ops.can_see(r.client_id)
          AND (p_entity_id IS NULL OR r.entity_id = p_entity_id)
          AND (p_domain_code IS NULL OR upper(r.domain_code) = upper(btrim(p_domain_code)))
          AND (r.entity_id IS NULL OR ops.is_service_role() OR r.entity_id IN (SELECT tenancy.readable_entity_ids()))
    ) AS v
    WHERE NOT COALESCE(p_mine, FALSE) OR (v.view ->> 'is_mine')::boolean
    ORDER BY v.subject_type, COALESCE(v.domain_code, v.view ->> 'entity_name'), v.is_backup, v.created_at;
$$;

-- Who is responsible for one record right now, after the nearest-wins rule:
-- [{ userId, name, isBackup }]. For a record page.
CREATE OR REPLACE FUNCTION public.responsibility_for_entity(p_entity_id UUID, p_activity TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, entity_instances, pg_temp
AS $$
    SELECT COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'userId', p.user_id,
                   'name', COALESCE(pr.display_name, 'Unnamed person'),
                   'isBackup', p.is_backup
               ) ORDER BY p.is_backup, pr.display_name)
        FROM entity_instances.master_entities AS me
        CROSS JOIN LATERAL ops.responsible_people(me.client_id, ARRAY[me.id], '{}', NULLIF(upper(btrim(COALESCE(p_activity, ''))), '')) AS p
        LEFT JOIN tenancy.profiles AS pr ON pr.id = p.user_id
        WHERE me.id = p_entity_id
          AND (ops.is_service_role() OR me.id IN (SELECT tenancy.readable_entity_ids()))
    ), '[]'::jsonb);
$$;

-- What a responsibility can be set to in a client: its people, its roles, and the activities.
CREATE OR REPLACE FUNCTION public.responsibility_choices(p_client_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_client UUID := p_client_id;
    v_clients UUID[];
BEGIN
    IF v_client IS NULL THEN
        SELECT array_agg(cid) INTO v_clients FROM tenancy.current_client_ids() AS cid;
        IF v_clients IS NOT NULL AND cardinality(v_clients) = 1 THEN
            v_client := v_clients[1];
        END IF;
    END IF;
    IF v_client IS NOT NULL AND NOT ops.can_see(v_client) THEN
        v_client := NULL;
    END IF;
    RETURN jsonb_build_object(
        'client_id', v_client,
        'can_manage', ops.responsibility_can_manage(v_client),
        'people', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id', cu.user_id, 'name', COALESCE(pr.display_name, 'Unnamed person')) ORDER BY pr.display_name)
            FROM tenancy.client_users AS cu
            JOIN tenancy.profiles AS pr ON pr.id = cu.user_id
            WHERE cu.client_id = v_client AND cu.is_active AND pr.is_active
              AND NOT EXISTS (SELECT 1 FROM ops.workflow_service_accounts AS sa WHERE sa.user_id = cu.user_id)
        ), '[]'::jsonb),
        'roles', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('code', x.role_code, 'name', x.role_name) ORDER BY x.role_name)
            FROM (
                SELECT DISTINCT ON (ro.role_code) ro.role_code, ro.role_name
                FROM tenancy.roles AS ro
                WHERE v_client IS NOT NULL AND (ro.client_id IS NULL OR ro.client_id = v_client)
                  AND ro.role_code <> 'WORKFLOW_SERVICE'
                ORDER BY ro.role_code, ro.client_id NULLS LAST
            ) AS x
        ), '[]'::jsonb),
        'activities', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('code', a.activity_code, 'name', a.activity_name, 'description', a.description) ORDER BY a.sort_order, a.activity_name)
            FROM ops.activities AS a
        ), '[]'::jsonb)
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Names a person or a role as responsible for a record or a domain. For a
-- record, the client is the record's. For a domain, pass the client, or leave
-- it out when the session belongs to one client. Saving the same subject,
-- activity, and holder again updates the backup flag, the children flag, and
-- the note.
CREATE OR REPLACE FUNCTION public.responsibility_save(
    p_subject_type TEXT,
    p_entity_id UUID DEFAULT NULL,
    p_domain_code TEXT DEFAULT NULL,
    p_activity TEXT DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_role_code TEXT DEFAULT NULL,
    p_is_backup BOOLEAN DEFAULT FALSE,
    p_include_children BOOLEAN DEFAULT TRUE,
    p_note TEXT DEFAULT NULL,
    p_client_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, entity_instances, metadata_register, pg_temp
AS $$
DECLARE
    v_type TEXT := upper(btrim(COALESCE(p_subject_type, '')));
    v_activity TEXT := NULLIF(upper(btrim(COALESCE(p_activity, ''))), '');
    v_role TEXT := NULLIF(upper(btrim(COALESCE(p_role_code, ''))), '');
    v_domain TEXT := NULLIF(btrim(COALESCE(p_domain_code, '')), '');
    v_client UUID := p_client_id;
    v_clients UUID[];
    v_row ops.responsibilities;
BEGIN
    IF auth.uid() IS NULL AND NOT ops.is_service_role() THEN
        RAISE EXCEPTION 'Sign in to set a responsibility' USING ERRCODE = '42501';
    END IF;
    IF (p_user_id IS NULL) = (v_role IS NULL) THEN
        RAISE EXCEPTION 'Name one person or one role' USING ERRCODE = '22023';
    END IF;

    IF v_type = 'ENTITY' THEN
        SELECT me.client_id INTO v_client
        FROM entity_instances.master_entities AS me
        WHERE me.id = p_entity_id
          AND (ops.is_service_role() OR me.id IN (SELECT tenancy.readable_entity_ids()));
        IF v_client IS NULL THEN
            RAISE EXCEPTION 'That record was not found, or you cannot read it' USING ERRCODE = '42501';
        END IF;
        v_domain := NULL;
    ELSIF v_type = 'DOMAIN' THEN
        SELECT dt.domain_code INTO v_domain
        FROM metadata_register.domain_types AS dt
        WHERE upper(dt.domain_code) = upper(v_domain);
        IF v_domain IS NULL THEN
            RAISE EXCEPTION 'That domain was not found' USING ERRCODE = 'P0002';
        END IF;
        IF v_client IS NULL THEN
            SELECT array_agg(cid) INTO v_clients FROM tenancy.current_client_ids() AS cid;
            IF v_clients IS NULL OR cardinality(v_clients) <> 1 THEN
                RAISE EXCEPTION 'Choose the client this responsibility is for' USING ERRCODE = '22023';
            END IF;
            v_client := v_clients[1];
        END IF;
        p_entity_id := NULL;
    ELSE
        RAISE EXCEPTION 'A responsibility is for a record or a domain' USING ERRCODE = '22023';
    END IF;

    IF NOT ops.responsibility_can_manage(v_client) THEN
        RAISE EXCEPTION 'You cannot change who is responsible for this client''s records' USING ERRCODE = '42501';
    END IF;
    IF v_activity IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ops.activities AS a WHERE a.activity_code = v_activity) THEN
        RAISE EXCEPTION 'That activity was not found' USING ERRCODE = 'P0002';
    END IF;

    IF p_user_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM ops.workflow_service_accounts AS sa WHERE sa.user_id = p_user_id)
           OR NOT EXISTS (
               SELECT 1 FROM tenancy.client_users AS cu
               JOIN tenancy.profiles AS pr ON pr.id = cu.user_id
               WHERE cu.client_id = v_client AND cu.user_id = p_user_id AND cu.is_active AND pr.is_active
           ) THEN
            RAISE EXCEPTION 'That person is not an active member of this client' USING ERRCODE = '22023';
        END IF;
    ELSIF v_role = 'WORKFLOW_SERVICE' OR NOT EXISTS (
        SELECT 1 FROM tenancy.roles AS ro
        WHERE ro.role_code = v_role AND (ro.client_id IS NULL OR ro.client_id = v_client)
    ) THEN
        RAISE EXCEPTION 'That role was not found' USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_row
    FROM ops.responsibilities AS r
    WHERE r.client_id = v_client AND r.subject_type = v_type
      AND r.entity_id IS NOT DISTINCT FROM p_entity_id
      AND r.domain_code IS NOT DISTINCT FROM v_domain
      AND r.activity_code IS NOT DISTINCT FROM v_activity
      AND r.user_id IS NOT DISTINCT FROM p_user_id
      AND r.role_code IS NOT DISTINCT FROM v_role
    FOR UPDATE;

    IF FOUND THEN
        UPDATE ops.responsibilities
           SET is_backup = COALESCE(p_is_backup, FALSE),
               include_children = COALESCE(p_include_children, TRUE),
               note = NULLIF(btrim(COALESCE(p_note, '')), '')
         WHERE id = v_row.id
        RETURNING * INTO v_row;
    ELSE
        INSERT INTO ops.responsibilities (client_id, subject_type, entity_id, domain_code, include_children, activity_code,
                                          user_id, role_code, is_backup, note, created_by)
        VALUES (v_client, v_type, p_entity_id, v_domain, COALESCE(p_include_children, TRUE), v_activity,
                p_user_id, v_role, COALESCE(p_is_backup, FALSE), NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid())
        RETURNING * INTO v_row;
    END IF;

    RETURN ops.responsibility_view(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.responsibility_delete(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_client UUID;
BEGIN
    SELECT r.client_id INTO v_client FROM ops.responsibilities AS r WHERE r.id = p_id;
    IF v_client IS NULL OR NOT ops.can_see(v_client) THEN
        RETURN FALSE;
    END IF;
    IF NOT ops.responsibility_can_manage(v_client) THEN
        RAISE EXCEPTION 'You cannot change who is responsible for this client''s records' USING ERRCODE = '42501';
    END IF;
    DELETE FROM ops.responsibilities WHERE id = p_id;
    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- Review routing
-- ---------------------------------------------------------------------------

-- Opens a review. As before, with one addition: when the step names no people
-- and no roles, the review goes to the people responsible for the records and
-- domains its proposal changes (p_routing.activity narrows this to one
-- activity; p_routing.routeToOwners = false turns it off). Only people who can
-- review for the client are kept, and the person who started the run is left
-- off when the step keeps them apart. Backups are used only when no one else
-- is left. If nobody is responsible, the review is open to anyone who can
-- review.
CREATE OR REPLACE FUNCTION public.workflow_worker_review(
    p_run_id UUID,
    p_node_id TEXT,
    p_title TEXT,
    p_instructions TEXT,
    p_summary TEXT,
    p_proposal JSONB,
    p_routing JSONB DEFAULT '{}'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ops, tenancy, pg_temp
AS $$
DECLARE
    v_run ops.workflow_runs;
    v_review ops.workflow_reviews;
    v_routing JSONB := CASE WHEN jsonb_typeof(p_routing) = 'object' THEN p_routing ELSE '{}'::jsonb END;
    v_separate BOOLEAN := COALESCE((v_routing ->> 'separateReviewer')::boolean, TRUE);
    v_reassign BOOLEAN := COALESCE((v_routing ->> 'reassignWhenOverdue')::boolean, FALSE);
    v_to_owners BOOLEAN := COALESCE((v_routing ->> 'routeToOwners')::boolean, TRUE);
    v_activity TEXT := NULLIF(upper(btrim(COALESCE(v_routing ->> 'activity', ''))), '');
    v_needed INTEGER;
    v_hours NUMERIC;
    v_users UUID[] := '{}';
    v_roles TEXT[] := '{}';
    v_escalate TEXT[] := '{}';
    v_unassignable JSONB := '[]'::jsonb;
    v_entry TEXT;
    v_user UUID;
    v_new UUID;
    v_told INTEGER := 0;
    v_source TEXT;
    v_entities UUID[] := '{}';
    v_domains TEXT[] := '{}';
    v_owners UUID[] := '{}';
    v_backups UUID[] := '{}';
BEGIN
    SELECT * INTO v_run FROM ops.workflow_runs WHERE id = p_run_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT * INTO v_review FROM ops.workflow_reviews WHERE run_id = p_run_id AND node_id = p_node_id;
    IF FOUND THEN
        RETURN to_jsonb(v_review) || jsonb_build_object('unassignable', '[]'::jsonb);
    END IF;

    IF jsonb_typeof(v_routing -> 'people') = 'array' THEN
        FOR v_entry IN SELECT DISTINCT btrim(x) FROM jsonb_array_elements_text(v_routing -> 'people') AS x LOOP
            IF v_entry !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                IF v_entry <> '' THEN
                    v_unassignable := v_unassignable || jsonb_build_object('person', v_entry, 'reason', 'is not a person');
                END IF;
                CONTINUE;
            END IF;
            v_user := v_entry::uuid;
            IF v_separate AND v_user = v_run.started_by THEN
                v_unassignable := v_unassignable || jsonb_build_object('person', v_user, 'reason', 'started the run');
            ELSIF NOT ops.workflow_user_can_review(v_run.client_id, v_user) THEN
                v_unassignable := v_unassignable || jsonb_build_object('person', v_user, 'reason', 'cannot review for this client');
            ELSE
                v_users := v_users || v_user;
            END IF;
        END LOOP;
    END IF;

    IF jsonb_typeof(v_routing -> 'roles') = 'array' THEN
        SELECT COALESCE(array_agg(DISTINCT btrim(x)), '{}') INTO v_roles
        FROM jsonb_array_elements_text(v_routing -> 'roles') AS x
        WHERE btrim(x) <> '';
    END IF;

    IF cardinality(v_users) > 0 OR cardinality(v_roles) > 0 THEN
        v_source := 'STEP';
    ELSIF v_to_owners AND v_run.client_id IS NOT NULL
          AND jsonb_typeof(v_unassignable) = 'array' AND jsonb_array_length(v_unassignable) = 0
          AND jsonb_typeof(p_proposal -> 'items') = 'array' THEN
        -- The step named nobody. Give the review to whoever is responsible for what it changes.
        SELECT COALESCE(array_agg(DISTINCT (i -> 'target' ->> 'entityId')::uuid), '{}') INTO v_entities
        FROM jsonb_array_elements(p_proposal -> 'items') AS i
        WHERE (i -> 'target' ->> 'entityId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
        -- A change with no record yet (a new one) is settled by its domain.
        SELECT COALESCE(array_agg(DISTINCT i -> 'target' ->> 'domainCode'), '{}') INTO v_domains
        FROM jsonb_array_elements(p_proposal -> 'items') AS i
        WHERE btrim(COALESCE(i -> 'target' ->> 'domainCode', '')) <> ''
          AND COALESCE(i -> 'target' ->> 'entityId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

        IF cardinality(v_entities) > 0 OR cardinality(v_domains) > 0 THEN
            SELECT COALESCE(array_agg(p.user_id) FILTER (WHERE NOT p.is_backup), '{}'),
                   COALESCE(array_agg(p.user_id) FILTER (WHERE p.is_backup), '{}')
              INTO v_owners, v_backups
            FROM ops.responsible_people(v_run.client_id, v_entities, v_domains, v_activity) AS p
            WHERE ops.workflow_user_can_review(v_run.client_id, p.user_id)
              AND NOT (v_separate AND p.user_id IS NOT DISTINCT FROM v_run.started_by);
            v_users := CASE WHEN cardinality(v_owners) > 0 THEN v_owners ELSE v_backups END;
            IF cardinality(v_users) > 0 THEN
                v_source := 'RESPONSIBILITY';
            END IF;
        END IF;
    END IF;

    IF jsonb_typeof(v_routing -> 'escalateRoles') = 'array' THEN
        SELECT COALESCE(array_agg(DISTINCT btrim(x)), '{}') INTO v_escalate
        FROM jsonb_array_elements_text(v_routing -> 'escalateRoles') AS x
        WHERE btrim(x) <> '';
    END IF;

    BEGIN
        v_hours := NULLIF(v_routing ->> 'dueInHours', '')::numeric;
    EXCEPTION WHEN others THEN
        v_hours := NULL;
    END;
    BEGIN
        v_needed := LEAST(GREATEST(COALESCE(NULLIF(v_routing ->> 'approvals', '')::numeric::int, 1), 1), 5);
    EXCEPTION WHEN others THEN
        v_needed := 1;
    END;

    INSERT INTO ops.workflow_reviews (run_id, client_id, node_id, title, instructions, summary, proposal, assigned_users, assigned_roles,
                                      separate_reviewer, due_at, assigned_at, escalate_roles, approvals_required, reassign_when_overdue,
                                      assignment_source)
    VALUES (
        v_run.id, v_run.client_id, p_node_id, COALESCE(NULLIF(btrim(p_title), ''), 'Review'), p_instructions, p_summary,
        COALESCE(p_proposal, '{"items": []}'::jsonb), v_users, v_roles, v_separate,
        CASE WHEN v_hours > 0 THEN NOW() + make_interval(secs => (v_hours * 3600)::double precision) END,
        CASE WHEN cardinality(v_users) > 0 OR cardinality(v_roles) > 0 THEN NOW() END,
        v_escalate, v_needed, v_reassign, v_source
    )
    ON CONFLICT (run_id, node_id) DO NOTHING
    RETURNING id INTO v_new;

    IF v_new IS NOT NULL THEN
        v_told := ops.workflow_review_notice(v_new, 'REVIEW_ASSIGNED', NULL);
    END IF;

    SELECT * INTO v_review FROM ops.workflow_reviews WHERE run_id = p_run_id AND node_id = p_node_id;
    RETURN to_jsonb(v_review)
        || jsonb_build_object('assignees', ops.workflow_review_assignees(v_review.client_id, v_review.assigned_users, v_review.assigned_roles))
        || jsonb_build_object('unassignable', v_unassignable)
        || jsonb_build_object('notified', v_told);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION ops.responsibility_can_manage(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.responsibility_lineage(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.responsibility_holders(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.responsible_people(UUID, UUID[], TEXT[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.responsibility_view(ops.responsibilities) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.responsibilities_list(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.responsibility_for_entity(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.responsibility_choices(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.responsibility_save(TEXT, UUID, TEXT, TEXT, UUID, TEXT, BOOLEAN, BOOLEAN, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.responsibility_delete(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.responsibilities_list(UUID, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.responsibility_for_entity(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.responsibility_choices(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.responsibility_save(TEXT, UUID, TEXT, TEXT, UUID, TEXT, BOOLEAN, BOOLEAN, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.responsibility_delete(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.workflow_worker_review(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_worker_review(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO service_role;

COMMENT ON FUNCTION ops.responsible_people(UUID, UUID[], TEXT[], TEXT) IS
    'The people responsible for a set of records and domains. Nearest assignment wins. Grants nothing: each caller checks what it needs.';

NOTIFY pgrst, 'reload schema';
