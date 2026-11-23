-- Certifications: a close date for knowledge.
--
-- When a person certifies a process (a fund's NAV close, a deal's allocation)
-- the platform records the exact instant they certified it. The ledger is
-- bi-temporal, so reading at that instant ("as known then") returns the same
-- answer forever: later loads, corrections and restatements are kept, but
-- they carry a later system_from and a certified page does not see them.
--
-- A certification holds:
--   process_code       what was certified, from certification_processes
--   subject_entity_id  the record it was certified on (a close, a deal)
--   period_end         which period, when the process has one
--   as_of_date         the valid date the page was read at
--   knowledge_at       the knowledge instant the page was read at, stamped by
--                      the database when the certification is made
--   figures            the key figures the person saw, { key: {label, value} },
--                      so a later read can be checked against them
--   fingerprint        md5 of figures, for a quick equality check
--   version            1 for the first certification of a subject and period,
--                      then 2, 3, ... for each re-certification
--   supersedes_id      the reopened certification a re-certification replaces
--   depends_on         certifications this one was read against, such as the
--                      prior period's close. When one of them is reopened
--                      later, this one was certified against a version that
--                      has since been replaced.
--
-- Re-certifying rolls knowledge forward and keeps the As Of date: a
-- re-certification of a subject and period must use the As Of date of the
-- certification it replaces, so a correction to a prior month end is picked up
-- by reading the same date with later knowledge.
--
-- Any surface can pin its reads to a certification: read the active one for
-- its subject and use as_of_date and knowledge_at as its As Of and Knowledge
-- dates. docs/CERTIFICATION.md describes the pattern.
--
-- Certifications are append-only. A reopen revokes the active one (who, when,
-- why) and never deletes it, so the history of what was certified and when
-- stays readable. Access follows the subject record's own access.
--
-- Safe to run again.

-- ---------------------------------------------------------------------------
-- What can be certified
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS golden_master.certification_processes (
    code VARCHAR(40) PRIMARY KEY,
    label VARCHAR(120) NOT NULL,
    description TEXT,
    has_period BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE golden_master.certification_processes IS
    'Processes a person can certify. A new surface that certifies adds a row here; no code lists them.';
COMMENT ON COLUMN golden_master.certification_processes.has_period IS
    'Whether each certification names a period end. One certification per subject and period is active at a time.';

ALTER TABLE golden_master.certification_processes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON golden_master.certification_processes FROM PUBLIC, anon;
GRANT SELECT ON golden_master.certification_processes TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON golden_master.certification_processes TO service_role;
DROP POLICY IF EXISTS certification_processes_read ON golden_master.certification_processes;
CREATE POLICY certification_processes_read ON golden_master.certification_processes
    FOR SELECT TO authenticated USING (TRUE);

INSERT INTO golden_master.certification_processes (code, label, description, has_period) VALUES
    ('FUND_CLOSE', 'NAV close', 'A fund''s NAV certified for one close period. Pinned on the fund close record.', TRUE),
    ('DEAL_ALLOCATION', 'Deal allocation', 'A deal''s committed allocation across funds and tranches. Pinned on the deal.', FALSE)
ON CONFLICT (code) DO UPDATE
    SET label = EXCLUDED.label, description = EXCLUDED.description, has_period = EXCLUDED.has_period;

-- ---------------------------------------------------------------------------
-- Certifications
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS golden_master.certifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    process_code VARCHAR(40) NOT NULL REFERENCES golden_master.certification_processes(code),
    subject_entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE RESTRICT,
    period_end DATE,
    as_of_date DATE NOT NULL,
    knowledge_at TIMESTAMPTZ NOT NULL,
    figures JSONB NOT NULL DEFAULT '{}'::jsonb,
    fingerprint TEXT NOT NULL,
    note TEXT,
    certified_by UUID,
    certified_by_name TEXT,
    certified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    supersedes_id UUID REFERENCES golden_master.certifications(id),
    depends_on UUID[] NOT NULL DEFAULT '{}',
    revoked_at TIMESTAMPTZ,
    revoked_by UUID,
    revoked_by_name TEXT,
    revoke_reason TEXT,
    CONSTRAINT certifications_version_link CHECK ((version = 1) = (supersedes_id IS NULL)),
    CONSTRAINT certifications_figures_object CHECK (jsonb_typeof(figures) = 'object'),
    CONSTRAINT certifications_revoke_shape CHECK (
        revoked_at IS NOT NULL OR (revoked_by IS NULL AND revoked_by_name IS NULL AND revoke_reason IS NULL)
    ),
    CONSTRAINT certifications_revoked_after CHECK (revoked_at IS NULL OR revoked_at >= certified_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS certifications_one_active
    ON golden_master.certifications (process_code, subject_entity_id, COALESCE(period_end, DATE '0001-01-01'))
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS certifications_subject
    ON golden_master.certifications (subject_entity_id, process_code, certified_at DESC);
-- A certification is replaced at most once.
CREATE UNIQUE INDEX IF NOT EXISTS certifications_superseded_once
    ON golden_master.certifications (supersedes_id) WHERE supersedes_id IS NOT NULL;

COMMENT ON TABLE golden_master.certifications IS
    'What a person certified, and the As Of date and knowledge instant it was read at. Append-only: a reopen revokes, never deletes. See docs/CERTIFICATION.md.';
COMMENT ON COLUMN golden_master.certifications.knowledge_at IS
    'The knowledge instant a certified page reads at. Stamped by golden_master.certify, never by the caller.';
COMMENT ON COLUMN golden_master.certifications.figures IS
    'The key figures the person saw when certifying: { key: { label, value } }. A later read of the same page is compared against these.';

ALTER TABLE golden_master.certifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON golden_master.certifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON golden_master.certifications TO authenticated;
GRANT SELECT, INSERT, UPDATE ON golden_master.certifications TO service_role;

DROP POLICY IF EXISTS certifications_read ON golden_master.certifications;
CREATE POLICY certifications_read ON golden_master.certifications
    FOR SELECT TO authenticated
    USING (tenancy.has_entity_access(subject_entity_id, 'READ'));

-- Rows never change once written, except to record a revoke once. Nobody
-- deletes them, the service role included.
CREATE OR REPLACE FUNCTION golden_master.guard_certification_rows()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = golden_master, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Certifications are kept. Revoke one instead of deleting it.' USING ERRCODE = '42501';
    END IF;
    IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'This certification was already revoked.' USING ERRCODE = '42501';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.process_code IS DISTINCT FROM OLD.process_code
        OR NEW.subject_entity_id IS DISTINCT FROM OLD.subject_entity_id
        OR NEW.period_end IS DISTINCT FROM OLD.period_end
        OR NEW.as_of_date IS DISTINCT FROM OLD.as_of_date
        OR NEW.knowledge_at IS DISTINCT FROM OLD.knowledge_at
        OR NEW.figures IS DISTINCT FROM OLD.figures
        OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
        OR NEW.note IS DISTINCT FROM OLD.note
        OR NEW.certified_by IS DISTINCT FROM OLD.certified_by
        OR NEW.certified_by_name IS DISTINCT FROM OLD.certified_by_name
        OR NEW.certified_at IS DISTINCT FROM OLD.certified_at
        OR NEW.version IS DISTINCT FROM OLD.version
        OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
        OR NEW.depends_on IS DISTINCT FROM OLD.depends_on THEN
        RAISE EXCEPTION 'A certification cannot be changed. Revoke it and certify again.' USING ERRCODE = '42501';
    END IF;
    IF NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'The only change a certification takes is a revoke.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION golden_master.guard_certification_rows() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS aa_guard_certification_rows ON golden_master.certifications;
CREATE TRIGGER aa_guard_certification_rows
    BEFORE UPDATE OR DELETE ON golden_master.certifications
    FOR EACH ROW EXECUTE FUNCTION golden_master.guard_certification_rows();
REVOKE TRUNCATE ON golden_master.certifications FROM service_role;

-- ---------------------------------------------------------------------------
-- Certify
-- ---------------------------------------------------------------------------
--
-- Records that the caller certifies p_process on p_subject (for p_period_end
-- when the process has periods), read at p_as_of. The knowledge instant is
-- this transaction's start: every write the caller saw before certifying
-- committed earlier, so it is known at that instant, and every later write is
-- not. Fails when one is already active for the same subject and period.
--
-- When the latest certification of the subject and period was reopened, this
-- is a re-certification: it replaces that one (supersedes_id, version + 1)
-- and keeps its As Of date. p_as_of may be left null to take it.
--
-- p_depends_on names the certifications the page was read against, such as
-- the prior period's close; each must exist.

CREATE OR REPLACE FUNCTION golden_master.certify(
    p_process TEXT,
    p_subject UUID,
    p_as_of DATE,
    p_period_end DATE DEFAULT NULL,
    p_figures JSONB DEFAULT '{}'::jsonb,
    p_note TEXT DEFAULT NULL,
    p_depends_on UUID[] DEFAULT '{}'
) RETURNS golden_master.certifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, tenancy, pg_temp
AS $$
DECLARE
    v_process golden_master.certification_processes;
    v_figures JSONB := COALESCE(p_figures, '{}'::jsonb);
    v_depends UUID[] := COALESCE((SELECT array_agg(DISTINCT d) FROM unnest(COALESCE(p_depends_on, '{}'::uuid[])) d WHERE d IS NOT NULL), '{}'::uuid[]);
    v_prev golden_master.certifications;
    v_as_of DATE := p_as_of;
    v_name TEXT;
    v_row golden_master.certifications;
BEGIN
    IF auth.uid() IS NULL AND NOT ops.is_service_role() THEN
        RAISE EXCEPTION 'Sign in to certify.' USING ERRCODE = '42501';
    END IF;
    IF p_subject IS NULL THEN
        RAISE EXCEPTION 'A certification needs a record.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_process FROM golden_master.certification_processes WHERE code = p_process;
    IF NOT FOUND THEN
        RAISE EXCEPTION '% is not a process that can be certified.', p_process USING ERRCODE = '22023';
    END IF;
    IF v_process.has_period AND p_period_end IS NULL THEN
        RAISE EXCEPTION '% is certified for a period. Name the period end.', v_process.label USING ERRCODE = '22023';
    END IF;
    IF NOT v_process.has_period AND p_period_end IS NOT NULL THEN
        RAISE EXCEPTION '% has no periods. Leave the period end out.', v_process.label USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_figures) <> 'object' THEN
        RAISE EXCEPTION 'Figures must be an object of { key: { label, value } }.' USING ERRCODE = '22023';
    END IF;
    IF NOT ops.is_service_role() AND NOT tenancy.has_entity_access(p_subject, 'WRITE') THEN
        RAISE EXCEPTION 'You cannot certify this record.' USING ERRCODE = '42501';
    END IF;

    -- The latest certification of this subject and period, locked so two
    -- re-certifications cannot both replace it.
    SELECT * INTO v_prev
    FROM golden_master.certifications c
    WHERE c.process_code = p_process AND c.subject_entity_id = p_subject
      AND c.period_end IS NOT DISTINCT FROM p_period_end
    ORDER BY c.version DESC
    LIMIT 1
    FOR UPDATE;
    IF FOUND AND v_prev.revoked_at IS NULL THEN
        RAISE EXCEPTION 'This is already certified. Reopen it before certifying again.' USING ERRCODE = '23505';
    END IF;
    IF FOUND THEN
        -- A re-certification reads the same date with later knowledge.
        IF v_as_of IS NULL THEN
            v_as_of := v_prev.as_of_date;
        ELSIF v_as_of <> v_prev.as_of_date THEN
            RAISE EXCEPTION 'A re-certification keeps the As Of date of version % (%). It rolls knowledge forward, not the As Of date.', v_prev.version, v_prev.as_of_date USING ERRCODE = '22023';
        END IF;
    END IF;
    IF v_as_of IS NULL THEN
        RAISE EXCEPTION 'A certification needs an as-of date.' USING ERRCODE = '22023';
    END IF;

    IF cardinality(v_depends) > 0 AND (
        SELECT count(*) FROM golden_master.certifications c WHERE c.id = ANY (v_depends)
    ) <> cardinality(v_depends) THEN
        RAISE EXCEPTION 'A certification this one depends on was not found.' USING ERRCODE = '22023';
    END IF;

    SELECT p.display_name INTO v_name FROM tenancy.profiles p WHERE p.id = auth.uid();

    INSERT INTO golden_master.certifications (
        process_code, subject_entity_id, period_end, as_of_date, knowledge_at,
        figures, fingerprint, note, certified_by, certified_by_name, certified_at,
        version, supersedes_id, depends_on
    ) VALUES (
        p_process, p_subject, p_period_end, v_as_of, now(),
        v_figures, md5(v_figures::text), NULLIF(btrim(COALESCE(p_note, '')), ''),
        auth.uid(), v_name, now(),
        COALESCE(v_prev.version, 0) + 1, v_prev.id, v_depends
    )
    RETURNING * INTO v_row;
    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION golden_master.certify(TEXT, UUID, DATE, DATE, JSONB, TEXT, UUID[]) IS
    'Certify a process on a record. Stamps the knowledge instant a certified page reads at. See docs/CERTIFICATION.md.';
REVOKE ALL ON FUNCTION golden_master.certify(TEXT, UUID, DATE, DATE, JSONB, TEXT, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION golden_master.certify(TEXT, UUID, DATE, DATE, JSONB, TEXT, UUID[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Revoke (reopen)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION golden_master.revoke_certification(
    p_id UUID,
    p_reason TEXT DEFAULT NULL
) RETURNS golden_master.certifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = golden_master, tenancy, pg_temp
AS $$
DECLARE
    v_row golden_master.certifications;
    v_name TEXT;
BEGIN
    IF auth.uid() IS NULL AND NOT ops.is_service_role() THEN
        RAISE EXCEPTION 'Sign in to reopen.' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_row FROM golden_master.certifications WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That certification was not found.' USING ERRCODE = '22023';
    END IF;
    IF NOT ops.is_service_role() AND NOT tenancy.has_entity_access(v_row.subject_entity_id, 'WRITE') THEN
        RAISE EXCEPTION 'You cannot reopen this record.' USING ERRCODE = '42501';
    END IF;
    IF v_row.revoked_at IS NOT NULL THEN
        RETURN v_row;
    END IF;
    IF btrim(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'Say why this is being reopened.' USING ERRCODE = '22023';
    END IF;

    SELECT p.display_name INTO v_name FROM tenancy.profiles p WHERE p.id = auth.uid();

    UPDATE golden_master.certifications
    SET revoked_at = now(),
        revoked_by = auth.uid(),
        revoked_by_name = COALESCE(v_name, ''),
        revoke_reason = btrim(p_reason)
    WHERE id = p_id
    RETURNING * INTO v_row;
    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION golden_master.revoke_certification(UUID, TEXT) IS
    'Reopen: the certification stops pinning its page. It is kept, with who reopened it, when and why. A reason is required.';
REVOKE ALL ON FUNCTION golden_master.revoke_certification(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION golden_master.revoke_certification(UUID, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The certification in force at a knowledge instant
-- ---------------------------------------------------------------------------
--
-- Certifications are themselves bi-temporal: one is in force from
-- certified_at until it is revoked. A page pinned at an instant reads the
-- certifications in force then, so a later re-certification of a prior period
-- does not change what an already certified page compared against.
-- p_knowledge null means now. Runs as the caller, so row security applies.

CREATE OR REPLACE FUNCTION golden_master.certification_at(
    p_process TEXT,
    p_subject UUID,
    p_period_end DATE DEFAULT NULL,
    p_knowledge TIMESTAMPTZ DEFAULT NULL
) RETURNS SETOF golden_master.certifications
LANGUAGE sql
STABLE
SET search_path = golden_master, pg_temp
AS $$
    SELECT c.*
    FROM golden_master.certifications c
    WHERE c.process_code = p_process
      AND c.subject_entity_id = p_subject
      AND c.period_end IS NOT DISTINCT FROM p_period_end
      AND c.certified_at <= COALESCE(p_knowledge, now())
      AND (c.revoked_at IS NULL OR c.revoked_at > COALESCE(p_knowledge, now()))
    ORDER BY c.version DESC
    LIMIT 1;
$$;

COMMENT ON FUNCTION golden_master.certification_at(TEXT, UUID, DATE, TIMESTAMPTZ) IS
    'The certification of a subject and period in force at a knowledge instant (now when null).';
REVOKE ALL ON FUNCTION golden_master.certification_at(TEXT, UUID, DATE, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION golden_master.certification_at(TEXT, UUID, DATE, TIMESTAMPTZ) TO authenticated, service_role;
