-- Migration: Share narrative runs
-- Description: A run costs minutes and model spend, so a finished run is meant to be reused.
--
--   * Each run records who made it (created_by_label), set from the caller's session.
--   * Anyone who can read the record may publish a finished run, which marks it as the one
--     readers see by default. One run per narrative and record is published at a time.
--   * A run that stops reporting progress is closed instead of staying RUNNING for ever.
--
-- Visibility is unchanged: a run is readable by its creator, tenant admins, and anyone who can
-- read the record it is about (see 00050_dashboards_and_narratives.sql).

-- ============================================================
-- 1. Columns
-- ============================================================
ALTER TABLE public.narrative_runs
    ADD COLUMN IF NOT EXISTS created_by_label TEXT,
    ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES auth.users(id),
    ADD COLUMN IF NOT EXISTS published_by_label TEXT,
    ADD COLUMN IF NOT EXISTS published_label TEXT;

CREATE INDEX IF NOT EXISTS idx_narrative_runs_published
    ON public.narrative_runs (narrative_id, entity_id)
    WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_narrative_runs_view
    ON public.narrative_runs (narrative_id, entity_id, as_of_date, created_at DESC);

COMMENT ON COLUMN public.narrative_runs.created_by_label IS 'Display name of the person (or assistant session) that started the run.';
COMMENT ON COLUMN public.narrative_runs.published_at IS 'Set when someone marks this run as the one to show. At most one published run per narrative and record.';

-- ============================================================
-- 2. Who made the run
-- ============================================================
CREATE OR REPLACE FUNCTION public.narrative_caller_label()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        NULLIF(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
        NULLIF(auth.jwt() -> 'user_metadata' ->> 'name', ''),
        NULLIF(auth.jwt() ->> 'email', ''),
        'Unknown'
    );
$$;

CREATE OR REPLACE FUNCTION public.narrative_run_set_label()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.created_by_label IS NULL THEN
        NEW.created_by_label := public.narrative_caller_label();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_narrative_run_label ON public.narrative_runs;
CREATE TRIGGER trg_narrative_run_label
    BEFORE INSERT ON public.narrative_runs
    FOR EACH ROW EXECUTE FUNCTION public.narrative_run_set_label();

-- ============================================================
-- 3. Publish and unpublish
-- ============================================================
-- Runs are updatable only by their creator, so publishing someone else's run goes through a
-- function that checks the caller may read the record and then changes only the publish fields.
CREATE OR REPLACE FUNCTION public.publish_narrative_run(p_run_id UUID, p_label TEXT DEFAULT NULL)
RETURNS public.narrative_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, tenancy, pg_temp
AS $$
DECLARE
    r public.narrative_runs;
BEGIN
    SELECT * INTO r FROM public.narrative_runs WHERE id = p_run_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Run not found';
    END IF;
    IF NOT (
        r.created_by = auth.uid()
        OR tenancy.is_tenant_admin()
        OR (r.entity_id IS NOT NULL AND tenancy.has_entity_access(r.entity_id, 'READ'))
    ) THEN
        RAISE EXCEPTION 'You cannot publish a run for a record you cannot read';
    END IF;
    IF r.status NOT IN ('COMPLETED', 'PARTIAL') THEN
        RAISE EXCEPTION 'Only a finished run can be published';
    END IF;

    UPDATE public.narrative_runs
       SET published_at = NULL, published_by = NULL, published_by_label = NULL, published_label = NULL
     WHERE narrative_id = r.narrative_id
       AND entity_id IS NOT DISTINCT FROM r.entity_id
       AND published_at IS NOT NULL
       AND id <> r.id;

    UPDATE public.narrative_runs
       SET published_at = now(),
           published_by = auth.uid(),
           published_by_label = public.narrative_caller_label(),
           published_label = NULLIF(btrim(COALESCE(p_label, '')), '')
     WHERE id = r.id
    RETURNING * INTO r;

    RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION public.unpublish_narrative_run(p_run_id UUID)
RETURNS public.narrative_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, tenancy, pg_temp
AS $$
DECLARE
    r public.narrative_runs;
BEGIN
    SELECT * INTO r FROM public.narrative_runs WHERE id = p_run_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Run not found';
    END IF;
    IF NOT (
        r.created_by = auth.uid()
        OR tenancy.is_tenant_admin()
        OR (r.entity_id IS NOT NULL AND tenancy.has_entity_access(r.entity_id, 'READ'))
    ) THEN
        RAISE EXCEPTION 'You cannot change a run for a record you cannot read';
    END IF;

    UPDATE public.narrative_runs
       SET published_at = NULL, published_by = NULL, published_by_label = NULL, published_label = NULL
     WHERE id = r.id
    RETURNING * INTO r;

    RETURN r;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_narrative_run(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unpublish_narrative_run(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publish_narrative_run(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unpublish_narrative_run(UUID) TO authenticated;

-- ============================================================
-- 4. Close runs that stopped reporting progress
-- ============================================================
-- A run's updated_at moves forward each time one of its sections finishes. A RUNNING run that has
-- not moved for the cutoff was abandoned (a closed tab, a crashed request), so it is closed and
-- never shown as the latest report. Called when a run starts and when runs are listed.
CREATE OR REPLACE FUNCTION public.close_stale_narrative_runs(p_minutes INTEGER DEFAULT 30)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    closed INTEGER;
BEGIN
    WITH stale AS (
        UPDATE public.narrative_runs
           SET status = 'FAILED',
               error_message = 'Abandoned: no progress for ' || p_minutes || ' minutes',
               updated_at = now()
         WHERE status = 'RUNNING'
           AND updated_at < now() - make_interval(mins => p_minutes)
        RETURNING id
    ), sections AS (
        UPDATE public.narrative_run_sections s
           SET status = 'FAILED',
               error_message = COALESCE(s.error_message, 'Abandoned with the run'),
               updated_at = now()
          FROM stale
         WHERE s.run_id = stale.id
           AND s.status IN ('PENDING', 'RUNNING')
        RETURNING s.id
    )
    SELECT count(*)::INTEGER INTO closed FROM stale;

    RETURN closed;
END;
$$;

REVOKE ALL ON FUNCTION public.close_stale_narrative_runs(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_stale_narrative_runs(INTEGER) TO authenticated;

-- Clear what is already stranded.
SELECT public.close_stale_narrative_runs(30);

NOTIFY pgrst, 'reload schema';
