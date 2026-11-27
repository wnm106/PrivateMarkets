-- Population filters: reusable conditions that narrow which records a view reads.
--
-- A filter belongs to an entity type and holds conditions in the same row shape
-- as a rule's conditions (compliance.rule_conditions, as the condition builder
-- edits them). Any number of views can point at one filter (entity_views.filter_id).
-- Conditions may reach related records along relationship paths, as rule
-- conditions do, so a filter is built on the same entity tree as the view.
--
-- Matching is not re-implemented here: reporting.grid takes the request's
-- populationConditions and keeps the records that
-- compliance.entity_matches_condition_set selects, as of the request's dates.
-- A person can also send conditions that are not saved (an ad hoc filter, or a
-- saved one edited for this session); the grid treats them the same.

CREATE TABLE IF NOT EXISTS public.population_filters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES tenancy.clients(id) ON DELETE CASCADE,
    domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code) ON DELETE CASCADE,
    filter_name VARCHAR(200) NOT NULL,
    description TEXT,
    -- Condition rows as the builder sends them (camelCase):
    -- [{ conditionGroup, conditionOrder, attributeCode, attributeDimension, operator, value, ... }]
    conditions JSONB NOT NULL DEFAULT '[]',
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT population_filters_name_not_blank CHECK (btrim(filter_name) <> ''),
    CONSTRAINT population_filters_conditions_array CHECK (jsonb_typeof(conditions) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_population_filters_name
    ON public.population_filters (client_id, domain_code, lower(filter_name));
CREATE INDEX IF NOT EXISTS idx_population_filters_domain
    ON public.population_filters (client_id, domain_code);

COMMENT ON TABLE public.population_filters IS
    'Saved, reusable conditions that narrow the records a view reads. Same condition rows as a rule; matched by compliance.entity_matches_condition_set.';

ALTER TABLE public.population_filters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS population_filters_select ON public.population_filters;
CREATE POLICY population_filters_select ON public.population_filters
    FOR SELECT TO authenticated
    USING (client_id IN (SELECT tenancy.current_client_ids()));

DROP POLICY IF EXISTS population_filters_insert ON public.population_filters;
CREATE POLICY population_filters_insert ON public.population_filters
    FOR INSERT TO authenticated
    WITH CHECK (client_id IN (SELECT tenancy.current_client_ids()));

DROP POLICY IF EXISTS population_filters_update ON public.population_filters;
CREATE POLICY population_filters_update ON public.population_filters
    FOR UPDATE TO authenticated
    USING (client_id IN (SELECT tenancy.current_client_ids()))
    WITH CHECK (client_id IN (SELECT tenancy.current_client_ids()));

DROP POLICY IF EXISTS population_filters_delete ON public.population_filters;
CREATE POLICY population_filters_delete ON public.population_filters
    FOR DELETE TO authenticated
    USING (client_id IN (SELECT tenancy.current_client_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.population_filters TO authenticated;
GRANT ALL ON public.population_filters TO service_role;

-- A view's default filter. Deleting the filter leaves the view unfiltered.
ALTER TABLE public.entity_views
    ADD COLUMN IF NOT EXISTS filter_id UUID REFERENCES public.population_filters(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_entity_views_filter ON public.entity_views (filter_id);

-- The grid keeps only records the request's populationConditions select.
--
-- reporting.grid is changed in place, not re-created from a copy: other
-- changes to the grid (lookup directions, expanding rows) land in other
-- migrations, and a copy here would undo whichever it did not know about.
-- The function's current definition gets two additions and is re-run:
--   v_pop: the request's populationConditions, as rule_conditions rows
--          (snake_case, applies_to BASE), read like a saved rule's.
--   v_ids is narrowed by compliance.entity_matches_condition_set, as of the
--   request's dates, so entityCount, groups and totals all see the narrowed set.
-- It stops with an error if the function no longer has the place to patch.
-- Re-running does nothing once the grid reads populationConditions.
--
-- NOTE: a later migration that re-creates reporting.grid from scratch must keep
-- the "population filter" block, or views stop narrowing.

DO $do$
DECLARE
    v_def text := pg_get_functiondef('reporting.grid(jsonb)'::regprocedure);
    v_decl constant text := E'    v_ids uuid[];\n';
    v_anchor constant text := E'        v_asof, v_know);\n\n    -- ---- pivot columns ----';
    v_block constant text := $blk$
    -- ---- population filter ----
    IF jsonb_typeof(p_request->'populationConditions') = 'array' AND jsonb_array_length(p_request->'populationConditions') > 0 THEN
        SELECT COALESCE(array_agg(
            jsonb_populate_record(NULL::compliance.rule_conditions,
                jsonb_build_object('applies_to', 'BASE', 'condition_group', 1, 'condition_order', 1,
                                   'logic_operator', 'AND', 'attribute_dimension', '{}'::jsonb, 'compare_dimension', '{}'::jsonb)
                || jsonb_strip_nulls(c) || jsonb_build_object('applies_to', 'BASE'))
            ORDER BY ordinality), ARRAY[]::compliance.rule_conditions[])
          INTO v_pop
        FROM jsonb_array_elements(p_request->'populationConditions') WITH ORDINALITY AS t(c, ordinality)
        WHERE NULLIF(c ->> 'attribute_code', '') IS NOT NULL;
        IF cardinality(v_pop) > 0 THEN
            SELECT COALESCE(array_agg(e ORDER BY ord), '{}') INTO v_ids
            FROM unnest(v_ids) WITH ORDINALITY AS u(e, ord)
            WHERE compliance.entity_matches_condition_set(u.e, v_pop, 'BASE', v_asof, v_know, 'GOLDEN');
        END IF;
    END IF;
$blk$;
BEGIN
    IF position('populationConditions' IN v_def) > 0 THEN
        RETURN;
    END IF;
    IF (length(v_def) - length(replace(v_def, v_anchor, ''))) <> length(v_anchor)
       OR (length(v_def) - length(replace(v_def, v_decl, ''))) <> length(v_decl) THEN
        RAISE EXCEPTION 'reporting.grid has changed shape: cannot find where to add the population filter. Update this migration.';
    END IF;
    v_def := replace(v_def, v_decl, v_decl || E'    v_pop compliance.rule_conditions[];\n');
    v_def := replace(v_def, v_anchor, E'        v_asof, v_know);\n' || v_block || E'\n    -- ---- pivot columns ----');
    EXECUTE v_def;
END
$do$;

NOTIFY pgrst, 'reload schema';
