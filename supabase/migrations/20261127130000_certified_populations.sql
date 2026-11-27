-- Certified populations: a population filter a tenant admin has certified is a
-- named, described definition the assistant (MCP) can rely on instead of
-- guessing what "active funds" or "EU managers" means.
--
--   population_code      the stable name an agent passes ("population": "<code>").
--                        Unique per client. Required to certify.
--   certified_at/by/note who vouched for the definition, and when.
--
-- Rules, enforced here so no caller can get around them:
--   * Only a tenant admin can certify or withdraw certification.
--   * A caller cannot choose who or when: the trigger stamps auth.uid() and now().
--   * Certifying needs a code and a description (an agent reads the description).
--   * Changing what a filter means (entity type, code, conditions) withdraws the
--     certification. A certified definition never changes under its certification;
--     certify again after the change.

ALTER TABLE public.population_filters
    ADD COLUMN IF NOT EXISTS population_code VARCHAR(80),
    ADD COLUMN IF NOT EXISTS certified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS certified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS certification_note TEXT;

ALTER TABLE public.population_filters
    DROP CONSTRAINT IF EXISTS population_filters_code_shape,
    DROP CONSTRAINT IF EXISTS population_filters_certified_complete;
ALTER TABLE public.population_filters
    ADD CONSTRAINT population_filters_code_shape
        CHECK (population_code IS NULL OR population_code ~ '^[A-Z][A-Z0-9_]*$'),
    ADD CONSTRAINT population_filters_certified_complete
        CHECK (certified_at IS NULL
               OR (population_code IS NOT NULL AND btrim(COALESCE(description, '')) <> ''));

CREATE UNIQUE INDEX IF NOT EXISTS uq_population_filters_code
    ON public.population_filters (client_id, population_code) WHERE population_code IS NOT NULL;

CREATE OR REPLACE FUNCTION public.population_filters_certification_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.certified_at := NULL;
        NEW.certified_by := NULL;
        NEW.certification_note := NULL;
        RETURN NEW;
    END IF;

    -- What the filter means changed: certification no longer applies.
    IF (NEW.domain_code, NEW.population_code, NEW.conditions)
       IS DISTINCT FROM (OLD.domain_code, OLD.population_code, OLD.conditions) THEN
        IF NEW.certified_at IS DISTINCT FROM OLD.certified_at AND NEW.certified_at IS NOT NULL THEN
            RAISE EXCEPTION 'Save the change to the filter first, then certify it.' USING ERRCODE = '22023';
        END IF;
        NEW.certified_at := NULL;
        NEW.certified_by := NULL;
        NEW.certification_note := NULL;
        RETURN NEW;
    END IF;

    -- Certification itself changed.
    IF (NEW.certified_at IS DISTINCT FROM OLD.certified_at)
       OR (NEW.certified_by IS DISTINCT FROM OLD.certified_by)
       OR (NEW.certification_note IS DISTINCT FROM OLD.certification_note) THEN
        IF NOT tenancy.is_tenant_admin() THEN
            RAISE EXCEPTION 'Only an administrator can certify or withdraw a population.' USING ERRCODE = '42501';
        END IF;
        IF NEW.certified_at IS NULL THEN
            NEW.certified_by := NULL;
            NEW.certification_note := NULL;
        ELSE
            NEW.certified_at := now();
            NEW.certified_by := auth.uid();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS population_filters_certification_guard ON public.population_filters;
CREATE TRIGGER population_filters_certification_guard
    BEFORE INSERT OR UPDATE ON public.population_filters
    FOR EACH ROW EXECUTE FUNCTION public.population_filters_certification_guard();

COMMENT ON COLUMN public.population_filters.population_code IS
    'Stable name the assistant uses to ask for this population. Unique per client.';
COMMENT ON COLUMN public.population_filters.certified_at IS
    'When an administrator certified this definition. Cleared whenever the entity type, code or conditions change.';

NOTIFY pgrst, 'reload schema';
