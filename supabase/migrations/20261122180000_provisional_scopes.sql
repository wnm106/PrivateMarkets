-- Provisional scopes: where a load keeps the rows it is not sure about.
--
-- Step 1 of docs/PROVISIONAL_RECORDS.md. A row the loader cannot place with
-- confidence is held in a staged batch under a scope, with the record it is
-- assumed to be (or that it is assumed to be new). Only the run or load that
-- owns the scope may read it, and only through the shared readers, which ask
-- entity_instances.scope_for_caller first. No default read touches these rows:
-- they stay in the batch tables, which only the service role reads.
--
-- Nothing writes or reads with a scope yet. The loader holds rows in a scope
-- in step 2, and the shared readers take a scope in step 3.
--
-- Safe to run again.

-- ---------------------------------------------------------------------------
-- Scopes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entity_instances.provisional_scopes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('LOAD_BATCH', 'WORKFLOW_RUN')),
    workflow_run_id UUID REFERENCES ops.workflow_runs(id) ON DELETE CASCADE,
    status VARCHAR(12) NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'RESOLVED', 'DISCARDED', 'EXPIRED')),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_by UUID,
    resolved_at TIMESTAMPTZ,
    CONSTRAINT provisional_scopes_run_matches_kind
        CHECK ((kind = 'WORKFLOW_RUN') = (workflow_run_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS provisional_scopes_one_per_run
    ON entity_instances.provisional_scopes (workflow_run_id) WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS provisional_scopes_open
    ON entity_instances.provisional_scopes (client_id, expires_at) WHERE status = 'OPEN';
COMMENT ON TABLE entity_instances.provisional_scopes IS
    'Who may see a set of provisional rows: one workflow run (its loads share it) or one staged load. Read only through entity_instances.scope_for_caller.';

ALTER TABLE entity_instances.provisional_scopes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.provisional_scopes TO service_role;

ALTER TABLE entity_instances.load_batches
    ADD COLUMN IF NOT EXISTS scope_id UUID REFERENCES entity_instances.provisional_scopes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_load_batches_scope
    ON entity_instances.load_batches (scope_id) WHERE scope_id IS NOT NULL;
COMMENT ON COLUMN entity_instances.load_batches.scope_id IS
    'The scope this batch holds provisional rows under. Null for a batch with none.';

-- ---------------------------------------------------------------------------
-- Provisional records in a batch
-- ---------------------------------------------------------------------------

ALTER TABLE entity_instances.load_batch_records
    ADD COLUMN IF NOT EXISTS provisional_entity_id UUID,
    ADD COLUMN IF NOT EXISTS candidates JSONB,
    ADD COLUMN IF NOT EXISTS assumed_action VARCHAR(10),
    ADD COLUMN IF NOT EXISTS assumed_entity_id UUID,
    ADD COLUMN IF NOT EXISTS decided_action VARCHAR(10),
    ADD COLUMN IF NOT EXISTS decided_entity_id UUID,
    ADD COLUMN IF NOT EXISTS decided_by UUID,
    ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

ALTER TABLE entity_instances.load_batch_records DROP CONSTRAINT IF EXISTS load_batch_records_action_check;
ALTER TABLE entity_instances.load_batch_records ALTER COLUMN action TYPE VARCHAR(12);
ALTER TABLE entity_instances.load_batch_records
    ADD CONSTRAINT load_batch_records_action_check CHECK (action IN ('CREATE', 'MATCH', 'PROVISIONAL'));

ALTER TABLE entity_instances.load_batch_records DROP CONSTRAINT IF EXISTS load_batch_records_provisional_shape;
ALTER TABLE entity_instances.load_batch_records
    ADD CONSTRAINT load_batch_records_provisional_shape CHECK (
        CASE WHEN action = 'PROVISIONAL' THEN
            provisional_entity_id IS NOT NULL
            AND assumed_action IN ('map', 'create')
            AND (assumed_action = 'map') = (assumed_entity_id IS NOT NULL)
            AND (decided_action IS NULL OR decided_action IN ('map', 'create', 'ignore'))
            AND (decided_action IS NOT DISTINCT FROM 'map') = (decided_entity_id IS NOT NULL)
        ELSE
            provisional_entity_id IS NULL
            AND assumed_action IS NULL AND assumed_entity_id IS NULL
            AND decided_action IS NULL AND decided_entity_id IS NULL
        END
    );

CREATE UNIQUE INDEX IF NOT EXISTS load_batch_records_provisional_entity
    ON entity_instances.load_batch_records (provisional_entity_id) WHERE provisional_entity_id IS NOT NULL;

COMMENT ON COLUMN entity_instances.load_batch_records.provisional_entity_id IS
    'The id a held record goes by while it is provisional. A create decision keeps it as the live record''s id.';
COMMENT ON COLUMN entity_instances.load_batch_records.candidates IS
    'Stored records this row may be: [{id, code, name, score, reasons}], best first.';
COMMENT ON COLUMN entity_instances.load_batch_records.assumed_action IS
    'What a run assumes until a person decides: map (to assumed_entity_id) or create.';
COMMENT ON COLUMN entity_instances.load_batch_records.decided_action IS
    'What a person decided: map (to decided_entity_id), create or ignore. Null until then.';

-- ---------------------------------------------------------------------------
-- Links a held row would make
-- ---------------------------------------------------------------------------
--
-- A link that touches a provisional record is provisional too. record_id is
-- the held record that makes it so. A parent or child is a live record id or
-- a provisional_entity_id.

CREATE TABLE IF NOT EXISTS entity_instances.load_batch_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES entity_instances.load_batches(id) ON DELETE CASCADE,
    record_id UUID NOT NULL REFERENCES entity_instances.load_batch_records(id) ON DELETE CASCADE,
    relationship_code VARCHAR(100) NOT NULL,
    parent_entity_id UUID NOT NULL,
    child_entity_id UUID NOT NULL,
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL DEFAULT '9999-12-31',
    origin_row INTEGER,
    CHECK (valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS idx_load_batch_links_batch ON entity_instances.load_batch_links (batch_id);
CREATE INDEX IF NOT EXISTS idx_load_batch_links_parent ON entity_instances.load_batch_links (parent_entity_id, relationship_code);
CREATE INDEX IF NOT EXISTS idx_load_batch_links_child ON entity_instances.load_batch_links (child_entity_id, relationship_code);
COMMENT ON TABLE entity_instances.load_batch_links IS
    'A link a held row would make. Read only through the shared readers with a scope.';

ALTER TABLE entity_instances.load_batch_links ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.load_batch_links TO service_role;

-- ---------------------------------------------------------------------------
-- Who may read a scope
-- ---------------------------------------------------------------------------
--
-- Every shared reader passes its p_scope through this first and uses what it
-- returns. Null means "live data only": the scope is not open, has expired,
-- or the caller may not use it. A reader never tells the caller which.
--
--   service role       the loader and batch screens, which filter by client
--                      themselves, as they do for every batch table
--   WORKFLOW_RUN       the client's workflow service account, or a person
--                      with workflow.review in that client
--   LOAD_BATCH         who staged a batch in the scope, or a person with
--                      load.promote in that client
--
-- Everyone but the service role must also hold entity.read in the client.

CREATE OR REPLACE FUNCTION entity_instances.scope_for_caller(p_scope UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = entity_instances, tenancy, ops, pg_temp
AS $$
DECLARE
    v_scope entity_instances.provisional_scopes%ROWTYPE;
BEGIN
    IF p_scope IS NULL THEN
        RETURN NULL;
    END IF;
    SELECT * INTO v_scope
    FROM entity_instances.provisional_scopes
    WHERE id = p_scope AND status = 'OPEN' AND expires_at > NOW();
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF ops.is_service_role() THEN
        RETURN v_scope.id;
    END IF;
    IF auth.uid() IS NULL OR NOT tenancy.has_permission(v_scope.client_id, 'entity.read') THEN
        RETURN NULL;
    END IF;

    IF v_scope.kind = 'WORKFLOW_RUN' THEN
        IF EXISTS (
            SELECT 1 FROM ops.workflow_service_accounts sa
            WHERE sa.client_id = v_scope.client_id AND sa.user_id = auth.uid()
        ) OR tenancy.has_permission(v_scope.client_id, 'workflow.review') THEN
            RETURN v_scope.id;
        END IF;
        RETURN NULL;
    END IF;

    IF EXISTS (
        SELECT 1 FROM entity_instances.load_batches b
        WHERE b.scope_id = v_scope.id AND b.client_id = v_scope.client_id AND b.staged_by = auth.uid()
    ) OR tenancy.has_permission(v_scope.client_id, 'load.promote') THEN
        RETURN v_scope.id;
    END IF;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION entity_instances.scope_for_caller(UUID) IS
    'The scope a shared reader may lay over live data for this caller, or null for live data only. See docs/PROVISIONAL_RECORDS.md.';

REVOKE ALL ON FUNCTION entity_instances.scope_for_caller(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION entity_instances.scope_for_caller(UUID) TO authenticated, service_role;
