-- Surface composition
--
-- A surface is the stable shell for a domain. Experiences qualify from the
-- entity profile (many at once). Page slots pick one variant. Components
-- render only when their granting experience qualified and their variant won.
-- The management view reads this catalog and shows the deciding rule for
-- every component, including ones that did not render.

-- ============================================================
-- 1. Catalog
-- ============================================================

CREATE TABLE IF NOT EXISTS public.surface_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    surface_code VARCHAR(100) UNIQUE NOT NULL,
    surface_name VARCHAR(200) NOT NULL,
    domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_surface_definitions_domain
    ON public.surface_definitions(domain_code);

COMMENT ON TABLE public.surface_definitions IS
    'Stable experience shell for a domain, such as the fund surface or the deal pipeline.';

CREATE TABLE IF NOT EXISTS public.surface_experiences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    surface_id UUID NOT NULL REFERENCES public.surface_definitions(id) ON DELETE CASCADE,
    experience_code VARCHAR(100) NOT NULL,
    experience_name VARCHAR(200) NOT NULL,
    description TEXT,
    is_baseline BOOLEAN NOT NULL DEFAULT FALSE,
    qualification_priority INTEGER NOT NULL DEFAULT 100,
    display_order INTEGER NOT NULL DEFAULT 0,
    applicability_rules JSONB NOT NULL DEFAULT '{"logic":"AND","conditions":[]}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (surface_id, experience_code)
);

CREATE INDEX IF NOT EXISTS idx_surface_experiences_surface
    ON public.surface_experiences(surface_id, display_order);

COMMENT ON TABLE public.surface_experiences IS
    'Named capabilities a profile can earn. Baseline experiences always qualify. Others use applicability_rules.';
COMMENT ON COLUMN public.surface_experiences.applicability_rules IS
    'JSON rules: { logic: AND|OR, conditions: [{ attributeCode, operator, value }] }. Operators match template qualification plus relationship_present and relationship_absent.';

CREATE TABLE IF NOT EXISTS public.surface_page_slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    surface_id UUID NOT NULL REFERENCES public.surface_definitions(id) ON DELETE CASCADE,
    slot_code VARCHAR(100) NOT NULL,
    slot_name VARCHAR(200) NOT NULL,
    description TEXT,
    display_order INTEGER NOT NULL DEFAULT 0,
    optionality VARCHAR(20) NOT NULL CHECK (optionality IN ('always', 'when_qualified')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (surface_id, slot_code)
);

CREATE INDEX IF NOT EXISTS idx_surface_page_slots_surface
    ON public.surface_page_slots(surface_id, display_order);

COMMENT ON TABLE public.surface_page_slots IS
    'Page positions on a surface. always is page variability. when_qualified is page optionality.';

CREATE TABLE IF NOT EXISTS public.surface_page_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id UUID NOT NULL REFERENCES public.surface_page_slots(id) ON DELETE CASCADE,
    variant_code VARCHAR(100) NOT NULL,
    variant_name VARCHAR(200) NOT NULL,
    description TEXT,
    qualification_priority INTEGER NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (slot_id, variant_code)
);

CREATE INDEX IF NOT EXISTS idx_surface_page_variants_slot
    ON public.surface_page_variants(slot_id, qualification_priority);

COMMENT ON TABLE public.surface_page_variants IS
    'Competing fillings of a page slot. Lowest qualification_priority among eligible variants wins.';

CREATE TABLE IF NOT EXISTS public.surface_variant_requirements (
    variant_id UUID NOT NULL REFERENCES public.surface_page_variants(id) ON DELETE CASCADE,
    experience_id UUID NOT NULL REFERENCES public.surface_experiences(id) ON DELETE CASCADE,
    PRIMARY KEY (variant_id, experience_id)
);

COMMENT ON TABLE public.surface_variant_requirements IS
    'Experiences that must all qualify before a variant is eligible. Empty means the variant is the surface default.';

CREATE TABLE IF NOT EXISTS public.surface_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    surface_id UUID NOT NULL REFERENCES public.surface_definitions(id) ON DELETE CASCADE,
    slot_id UUID NOT NULL REFERENCES public.surface_page_slots(id) ON DELETE CASCADE,
    variant_id UUID REFERENCES public.surface_page_variants(id) ON DELETE CASCADE,
    experience_id UUID REFERENCES public.surface_experiences(id) ON DELETE SET NULL,
    component_code VARCHAR(100) NOT NULL,
    component_name VARCHAR(200) NOT NULL,
    description TEXT,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (surface_id, component_code)
);

CREATE INDEX IF NOT EXISTS idx_surface_components_surface
    ON public.surface_components(surface_id, display_order);

COMMENT ON TABLE public.surface_components IS
    'Visible units of a surface. A null experience is baseline for its page. A null variant renders on whichever variant won the slot.';

CREATE TABLE IF NOT EXISTS public.surface_sample_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    surface_id UUID NOT NULL REFERENCES public.surface_definitions(id) ON DELETE CASCADE,
    profile_code VARCHAR(100) NOT NULL,
    profile_name VARCHAR(200) NOT NULL,
    description TEXT,
    template_code VARCHAR(100),
    facts JSONB NOT NULL DEFAULT '{"attributes":{},"relationships":[]}'::jsonb,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (surface_id, profile_code)
);

CREATE INDEX IF NOT EXISTS idx_surface_sample_profiles_surface
    ON public.surface_sample_profiles(surface_id, display_order);

COMMENT ON TABLE public.surface_sample_profiles IS
    'Named profiles used by the surface qualification management view. facts is { attributes, relationships }.';
COMMENT ON COLUMN public.surface_sample_profiles.template_code IS
    'Winning attribute template. Injected as the TEMPLATE_CODE fact during resolution.';

-- ============================================================
-- 2. RLS
-- ============================================================

ALTER TABLE public.surface_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surface_experiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surface_page_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surface_page_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surface_variant_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surface_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surface_sample_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS surface_definitions_select ON public.surface_definitions;
CREATE POLICY surface_definitions_select ON public.surface_definitions
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS surface_definitions_write ON public.surface_definitions;
CREATE POLICY surface_definitions_write ON public.surface_definitions
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS surface_experiences_select ON public.surface_experiences;
CREATE POLICY surface_experiences_select ON public.surface_experiences
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS surface_experiences_write ON public.surface_experiences;
CREATE POLICY surface_experiences_write ON public.surface_experiences
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS surface_page_slots_select ON public.surface_page_slots;
CREATE POLICY surface_page_slots_select ON public.surface_page_slots
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS surface_page_slots_write ON public.surface_page_slots;
CREATE POLICY surface_page_slots_write ON public.surface_page_slots
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS surface_page_variants_select ON public.surface_page_variants;
CREATE POLICY surface_page_variants_select ON public.surface_page_variants
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS surface_page_variants_write ON public.surface_page_variants;
CREATE POLICY surface_page_variants_write ON public.surface_page_variants
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS surface_variant_requirements_select ON public.surface_variant_requirements;
CREATE POLICY surface_variant_requirements_select ON public.surface_variant_requirements
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS surface_variant_requirements_write ON public.surface_variant_requirements;
CREATE POLICY surface_variant_requirements_write ON public.surface_variant_requirements
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS surface_components_select ON public.surface_components;
CREATE POLICY surface_components_select ON public.surface_components
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS surface_components_write ON public.surface_components;
CREATE POLICY surface_components_write ON public.surface_components
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

DROP POLICY IF EXISTS surface_sample_profiles_select ON public.surface_sample_profiles;
CREATE POLICY surface_sample_profiles_select ON public.surface_sample_profiles
    FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS surface_sample_profiles_write ON public.surface_sample_profiles;
CREATE POLICY surface_sample_profiles_write ON public.surface_sample_profiles
    FOR ALL TO authenticated
    USING (tenancy.is_tenant_admin())
    WITH CHECK (tenancy.is_tenant_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.surface_definitions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.surface_experiences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.surface_page_slots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.surface_page_variants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.surface_variant_requirements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.surface_components TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.surface_sample_profiles TO authenticated;

-- ============================================================
-- 3. Seed: fund surface, deal pipeline, company surface
-- ============================================================

INSERT INTO public.surface_definitions (surface_code, surface_name, domain_code, description)
VALUES
    ('FUND_SURFACE', 'Fund surface', 'FUND', 'One fund shell. Performance, NAV chart of accounts, and capital accounts follow the fund profile.'),
    ('DEAL_PIPELINE', 'Deal pipeline', 'DEAL', 'One deal shell. Property, rent roll, and credit facility appear only when the deal qualifies.'),
    ('COMPANY_SURFACE', 'Company surface', 'ISSUER', 'One company shell. Reported financials and industry packs follow the issuer profile.')
ON CONFLICT (surface_code) DO NOTHING;

INSERT INTO public.surface_experiences (
    surface_id, experience_code, experience_name, description, is_baseline,
    qualification_priority, display_order, applicability_rules
)
SELECT s.id, v.experience_code, v.experience_name, v.description, v.is_baseline,
       v.qualification_priority, v.display_order, v.applicability_rules::jsonb
FROM public.surface_definitions s
JOIN (VALUES
    ('FUND_SURFACE', 'FUND_BASELINE', 'Fund baseline', 'Identity and investor registry granted to every fund.', TRUE, 100, 1, '{"logic":"AND","conditions":[]}'),
    ('FUND_SURFACE', 'PUBLIC_BDC_PERFORMANCE', 'Public BDC performance', 'Total return and NAV per share for a listed BDC.', FALSE, 10, 2, '{"logic":"AND","conditions":[{"attributeCode":"FUND_STRUCTURE","operator":"equals","value":"PUBLIC_BDC"}]}'),
    ('FUND_SURFACE', 'CLOSED_END_PERFORMANCE', 'Closed-end performance', 'IRR, TVPI, DPI, and partner capital for a private closed-end fund.', FALSE, 10, 3, '{"logic":"AND","conditions":[{"attributeCode":"FUND_STRUCTURE","operator":"equals","value":"CLOSED_END"}]}'),
    ('FUND_SURFACE', 'BDC_CHART', 'BDC chart of accounts', 'NAV sections for a BDC statement template.', FALSE, 10, 4, '{"logic":"AND","conditions":[{"attributeCode":"TEMPLATE_CODE","operator":"equals","value":"FUND_NAV_BDC"}]}'),
    ('FUND_SURFACE', 'PE_CHART', 'PE chart of accounts', 'NAV sections for a private-equity statement template.', FALSE, 10, 5, '{"logic":"AND","conditions":[{"attributeCode":"TEMPLATE_CODE","operator":"equals","value":"FUND_NAV_PE"}]}'),
    ('DEAL_PIPELINE', 'DEAL_BASELINE', 'Deal baseline', 'Identity and pipeline stage granted to every deal.', TRUE, 100, 1, '{"logic":"AND","conditions":[]}'),
    ('DEAL_PIPELINE', 'PROPERTY', 'Property', 'Property summary for a real estate deal that has a property relationship.', FALSE, 10, 2, '{"logic":"AND","conditions":[{"attributeCode":"ASSET_CLASS","operator":"equals","value":"REAL_ESTATE"},{"attributeCode":"PROPERTY_OF","operator":"relationship_present"}]}'),
    ('DEAL_PIPELINE', 'RENT_ROLL', 'Rent roll', 'Unit and lease roll. Requires the property relationship and child units.', FALSE, 10, 3, '{"logic":"AND","conditions":[{"attributeCode":"ASSET_CLASS","operator":"equals","value":"REAL_ESTATE"},{"attributeCode":"PROPERTY_OF","operator":"relationship_present"},{"attributeCode":"UNITS","operator":"relationship_present"}]}'),
    ('DEAL_PIPELINE', 'CREDIT', 'Credit facility', 'Facility terms and covenants for a credit deal.', FALSE, 10, 4, '{"logic":"AND","conditions":[{"attributeCode":"ASSET_CLASS","operator":"equals","value":"CREDIT"}]}'),
    ('COMPANY_SURFACE', 'COMPANY_BASELINE', 'Company baseline', 'Legal identity granted to every company.', TRUE, 100, 1, '{"logic":"AND","conditions":[]}'),
    ('COMPANY_SURFACE', 'GAAP_FINANCIALS', 'GAAP reported financials', 'Income statement, balance sheet, and cash flow under GAAP.', FALSE, 10, 2, '{"logic":"AND","conditions":[{"attributeCode":"REPORTING_FRAMEWORK","operator":"equals","value":"GAAP"}]}'),
    ('COMPANY_SURFACE', 'STATUTORY_FINANCIALS', 'Statutory financials', 'Statutory statement lines.', FALSE, 10, 3, '{"logic":"AND","conditions":[{"attributeCode":"REPORTING_FRAMEWORK","operator":"equals","value":"STATUTORY"}]}'),
    ('COMPANY_SURFACE', 'MANUFACTURING_METRICS', 'Manufacturing metrics', 'Backlog and capacity for a manufacturing company.', FALSE, 10, 4, '{"logic":"AND","conditions":[{"attributeCode":"INDUSTRY","operator":"equals","value":"MANUFACTURING"}]}')
) AS v(surface_code, experience_code, experience_name, description, is_baseline, qualification_priority, display_order, applicability_rules)
    ON s.surface_code = v.surface_code
ON CONFLICT (surface_id, experience_code) DO NOTHING;

INSERT INTO public.surface_page_slots (surface_id, slot_code, slot_name, description, display_order, optionality)
SELECT s.id, v.slot_code, v.slot_name, v.description, v.display_order, v.optionality
FROM public.surface_definitions s
JOIN (VALUES
    ('FUND_SURFACE', 'OVERVIEW', 'Overview', 'Always present. A BDC overview replaces the default when the BDC experience qualifies.', 1, 'always'),
    ('FUND_SURFACE', 'PERFORMANCE', 'Performance', 'Always present. The variant is the BDC total-return story or the closed-end IRR story.', 2, 'always'),
    ('FUND_SURFACE', 'NAV', 'NAV statement', 'Present when a chart-of-accounts experience qualifies.', 3, 'when_qualified'),
    ('FUND_SURFACE', 'CAPITAL', 'Capital accounts', 'Present for a closed-end fund.', 4, 'when_qualified'),
    ('FUND_SURFACE', 'INVESTORS', 'Investors', 'Always present.', 5, 'always'),
    ('DEAL_PIPELINE', 'PIPELINE', 'Pipeline', 'Always present.', 1, 'always'),
    ('DEAL_PIPELINE', 'PROPERTY', 'Property', 'Present when the property experience qualifies.', 2, 'when_qualified'),
    ('DEAL_PIPELINE', 'RENT_ROLL', 'Rent roll', 'Present when the rent-roll experience qualifies.', 3, 'when_qualified'),
    ('DEAL_PIPELINE', 'CREDIT', 'Credit facility', 'Present when the credit experience qualifies.', 4, 'when_qualified'),
    ('COMPANY_SURFACE', 'OVERVIEW', 'Overview', 'Always present.', 1, 'always'),
    ('COMPANY_SURFACE', 'FINANCIALS', 'Reported financials', 'Present when a reporting framework qualifies. The variant is GAAP or statutory.', 2, 'when_qualified'),
    ('COMPANY_SURFACE', 'INDUSTRY', 'Industry pack', 'Present when an industry experience qualifies.', 3, 'when_qualified')
) AS v(surface_code, slot_code, slot_name, description, display_order, optionality)
    ON s.surface_code = v.surface_code
ON CONFLICT (surface_id, slot_code) DO NOTHING;

INSERT INTO public.surface_page_variants (slot_id, variant_code, variant_name, description, qualification_priority)
SELECT sl.id, v.variant_code, v.variant_name, v.description, v.qualification_priority
FROM public.surface_definitions s
JOIN public.surface_page_slots sl ON sl.surface_id = s.id
JOIN (VALUES
    ('FUND_SURFACE', 'OVERVIEW', 'FUND_OVERVIEW', 'Fund overview', 'Default overview.', 100),
    ('FUND_SURFACE', 'OVERVIEW', 'BDC_OVERVIEW', 'BDC overview', 'Listed BDC overview.', 10),
    ('FUND_SURFACE', 'PERFORMANCE', 'PERFORMANCE_DEFAULT', 'Performance summary', 'Default performance block. Loses when a specific story qualifies.', 100),
    ('FUND_SURFACE', 'PERFORMANCE', 'BDC_TOTAL_RETURN', 'BDC total return', 'Total return and NAV per share.', 10),
    ('FUND_SURFACE', 'PERFORMANCE', 'CLOSED_END_IRR', 'Closed-end IRR', 'IRR, TVPI, and DPI.', 20),
    ('FUND_SURFACE', 'NAV', 'BDC_COA', 'BDC chart of accounts', 'Investments at fair value, borrowings, net assets.', 10),
    ('FUND_SURFACE', 'NAV', 'PE_COA', 'Private-equity chart of accounts', 'Paid-in capital, distributions, remaining NAV.', 10),
    ('FUND_SURFACE', 'CAPITAL', 'PARTNER_CAPITAL', 'Partner capital', 'Partner capital accounts.', 10),
    ('FUND_SURFACE', 'INVESTORS', 'INVESTOR_REGISTRY', 'Investor registry', 'Commitments and investors.', 100),
    ('DEAL_PIPELINE', 'PIPELINE', 'PIPELINE_STAGE', 'Stage and milestones', 'Pipeline stage.', 100),
    ('DEAL_PIPELINE', 'PROPERTY', 'PROPERTY_SUMMARY', 'Property summary', 'Property linked to the deal.', 10),
    ('DEAL_PIPELINE', 'RENT_ROLL', 'RENT_ROLL_VARIANT', 'Unit and lease roll', 'Rent roll traversed from the property.', 10),
    ('DEAL_PIPELINE', 'CREDIT', 'FACILITY_TERMS', 'Facility terms', 'Facility terms and covenants.', 10),
    ('COMPANY_SURFACE', 'OVERVIEW', 'COMPANY_OVERVIEW', 'Company overview', 'Default company overview.', 100),
    ('COMPANY_SURFACE', 'FINANCIALS', 'GAAP_STATEMENTS', 'GAAP statements', 'Income statement, balance sheet, and cash flow.', 10),
    ('COMPANY_SURFACE', 'FINANCIALS', 'STATUTORY_STATEMENTS', 'Statutory statements', 'Statutory statement lines.', 20),
    ('COMPANY_SURFACE', 'INDUSTRY', 'MANUFACTURING_PACK', 'Manufacturing metrics', 'Backlog and capacity.', 10)
) AS v(surface_code, slot_code, variant_code, variant_name, description, qualification_priority)
    ON s.surface_code = v.surface_code AND sl.slot_code = v.slot_code
ON CONFLICT (slot_id, variant_code) DO NOTHING;

INSERT INTO public.surface_variant_requirements (variant_id, experience_id)
SELECT v.id, e.id
FROM (VALUES
    ('FUND_SURFACE', 'OVERVIEW', 'BDC_OVERVIEW', 'PUBLIC_BDC_PERFORMANCE'),
    ('FUND_SURFACE', 'PERFORMANCE', 'BDC_TOTAL_RETURN', 'PUBLIC_BDC_PERFORMANCE'),
    ('FUND_SURFACE', 'PERFORMANCE', 'CLOSED_END_IRR', 'CLOSED_END_PERFORMANCE'),
    ('FUND_SURFACE', 'NAV', 'BDC_COA', 'BDC_CHART'),
    ('FUND_SURFACE', 'NAV', 'PE_COA', 'PE_CHART'),
    ('FUND_SURFACE', 'CAPITAL', 'PARTNER_CAPITAL', 'CLOSED_END_PERFORMANCE'),
    ('DEAL_PIPELINE', 'PROPERTY', 'PROPERTY_SUMMARY', 'PROPERTY'),
    ('DEAL_PIPELINE', 'RENT_ROLL', 'RENT_ROLL_VARIANT', 'RENT_ROLL'),
    ('DEAL_PIPELINE', 'CREDIT', 'FACILITY_TERMS', 'CREDIT'),
    ('COMPANY_SURFACE', 'FINANCIALS', 'GAAP_STATEMENTS', 'GAAP_FINANCIALS'),
    ('COMPANY_SURFACE', 'FINANCIALS', 'STATUTORY_STATEMENTS', 'STATUTORY_FINANCIALS'),
    ('COMPANY_SURFACE', 'INDUSTRY', 'MANUFACTURING_PACK', 'MANUFACTURING_METRICS')
) AS req(surface_code, slot_code, variant_code, experience_code)
JOIN public.surface_definitions s ON s.surface_code = req.surface_code
JOIN public.surface_page_slots sl ON sl.surface_id = s.id AND sl.slot_code = req.slot_code
JOIN public.surface_page_variants v ON v.slot_id = sl.id AND v.variant_code = req.variant_code
JOIN public.surface_experiences e ON e.surface_id = s.id AND e.experience_code = req.experience_code
ON CONFLICT DO NOTHING;

INSERT INTO public.surface_components (
    surface_id, slot_id, variant_id, experience_id, component_code, component_name, description, display_order
)
SELECT s.id, sl.id, v.id, e.id, c.component_code, c.component_name, c.description, c.display_order
FROM (VALUES
    ('FUND_SURFACE', 'OVERVIEW', NULL::varchar, 'FUND_BASELINE', 'IDENTITY', 'Identity and terms', 'Shown on whichever overview variant wins.', 1),
    ('FUND_SURFACE', 'OVERVIEW', 'FUND_OVERVIEW', NULL::varchar, 'STANDARD_TERMS', 'Standard fund terms', 'Default overview content. Superseded when the BDC overview wins.', 2),
    ('FUND_SURFACE', 'OVERVIEW', 'BDC_OVERVIEW', 'PUBLIC_BDC_PERFORMANCE', 'LISTED_SHARE_TERMS', 'Listed share terms', 'Share terms for a listed BDC.', 2),
    ('FUND_SURFACE', 'PERFORMANCE', 'PERFORMANCE_DEFAULT', NULL::varchar, 'PERF_SUMMARY', 'Performance summary', 'Default performance block. Superseded by a specific story.', 1),
    ('FUND_SURFACE', 'PERFORMANCE', 'BDC_TOTAL_RETURN', 'PUBLIC_BDC_PERFORMANCE', 'BDC_RETURN', 'BDC total return and NAV per share', 'Public BDC performance story.', 1),
    ('FUND_SURFACE', 'PERFORMANCE', 'CLOSED_END_IRR', 'CLOSED_END_PERFORMANCE', 'IRR_BRIDGE', 'IRR, TVPI, and DPI bridge', 'Closed-end performance story.', 1),
    ('FUND_SURFACE', 'NAV', 'BDC_COA', 'BDC_CHART', 'BDC_NAV_LINES', 'BDC NAV lines', 'Investments at fair value, borrowings, and net assets.', 1),
    ('FUND_SURFACE', 'NAV', 'PE_COA', 'PE_CHART', 'PE_NAV_LINES', 'Private-equity NAV lines', 'Paid-in capital, distributions, and remaining NAV.', 1),
    ('FUND_SURFACE', 'CAPITAL', 'PARTNER_CAPITAL', 'CLOSED_END_PERFORMANCE', 'PARTNER_CAPITAL', 'Partner capital accounts', 'Optional page for a closed-end fund.', 1),
    ('FUND_SURFACE', 'INVESTORS', 'INVESTOR_REGISTRY', 'FUND_BASELINE', 'INVESTOR_COMMITMENTS', 'Investor commitments', 'Baseline investor registry.', 1),
    ('DEAL_PIPELINE', 'PIPELINE', 'PIPELINE_STAGE', 'DEAL_BASELINE', 'DEAL_IDENTITY', 'Deal identity and stage', 'Baseline pipeline content.', 1),
    ('DEAL_PIPELINE', 'PROPERTY', 'PROPERTY_SUMMARY', 'PROPERTY', 'PROPERTY_SUMMARY', 'Property summary', 'Property linked through PROPERTY_OF.', 1),
    ('DEAL_PIPELINE', 'RENT_ROLL', 'RENT_ROLL_VARIANT', 'RENT_ROLL', 'RENT_ROLL', 'Rent roll', 'Units and leases under the property.', 1),
    ('DEAL_PIPELINE', 'CREDIT', 'FACILITY_TERMS', 'CREDIT', 'FACILITY_TERMS', 'Facility terms and covenants', 'Credit facility terms.', 1),
    ('COMPANY_SURFACE', 'OVERVIEW', 'COMPANY_OVERVIEW', 'COMPANY_BASELINE', 'LEGAL_IDENTITY', 'Legal identity', 'Baseline company identity.', 1),
    ('COMPANY_SURFACE', 'FINANCIALS', 'GAAP_STATEMENTS', 'GAAP_FINANCIALS', 'GAAP_LINES', 'Income statement, balance sheet, cash flow', 'GAAP reported metrics. Lines come from the winning statement template.', 1),
    ('COMPANY_SURFACE', 'FINANCIALS', 'STATUTORY_STATEMENTS', 'STATUTORY_FINANCIALS', 'STATUTORY_LINES', 'Statutory statement lines', 'Statutory reported metrics.', 1),
    ('COMPANY_SURFACE', 'INDUSTRY', 'MANUFACTURING_PACK', 'MANUFACTURING_METRICS', 'BACKLOG', 'Backlog and capacity', 'Manufacturing industry pack.', 1)
) AS c(surface_code, slot_code, variant_code, experience_code, component_code, component_name, description, display_order)
JOIN public.surface_definitions s ON s.surface_code = c.surface_code
JOIN public.surface_page_slots sl ON sl.surface_id = s.id AND sl.slot_code = c.slot_code
LEFT JOIN public.surface_page_variants v ON v.slot_id = sl.id AND v.variant_code = c.variant_code
LEFT JOIN public.surface_experiences e ON e.surface_id = s.id AND e.experience_code = c.experience_code
ON CONFLICT (surface_id, component_code) DO NOTHING;

INSERT INTO public.surface_sample_profiles (
    surface_id, profile_code, profile_name, description, template_code, facts, display_order
)
SELECT s.id, v.profile_code, v.profile_name, v.description, NULLIF(v.template_code, ''), v.facts::jsonb, v.display_order
FROM public.surface_definitions s
JOIN (VALUES
    ('FUND_SURFACE', 'HARBOR_BDC', 'Harbor Street BDC', 'Listed business development company. Earns the BDC performance story and the BDC NAV chart.', 'FUND_NAV_BDC', '{"attributes":{"FUND_STRUCTURE":"PUBLIC_BDC","LISTING_STATUS":"LISTED","ACCOUNTING_BASIS":"GAAP"},"relationships":[]}', 1),
    ('FUND_SURFACE', 'NORTHLINE_PE', 'Northline PE Fund III', 'Private closed-end fund. Earns IRR, partner capital, and the private-equity NAV chart.', 'FUND_NAV_PE', '{"attributes":{"FUND_STRUCTURE":"CLOSED_END","LISTING_STATUS":"PRIVATE","ACCOUNTING_BASIS":"FAIR_VALUE"},"relationships":[]}', 2),
    ('DEAL_PIPELINE', 'MERCER_RE', 'Mercer Industrial Portfolio', 'Real estate acquisition with a property and units, so property and rent roll qualify.', '', '{"attributes":{"ASSET_CLASS":"REAL_ESTATE","DEAL_TYPE":"ACQUISITION"},"relationships":["PROPERTY_OF","UNITS"]}', 1),
    ('DEAL_PIPELINE', 'APEX_CREDIT', 'Apex Credit Facility', 'Credit financing. Property and rent roll stay off the pipeline.', '', '{"attributes":{"ASSET_CLASS":"CREDIT","DEAL_TYPE":"FINANCING"},"relationships":[]}', 2),
    ('COMPANY_SURFACE', 'HELIOS', 'Helios Manufacturing', 'GAAP manufacturer. Reported financials use the GAAP statement template, plus a manufacturing pack.', 'ISSUER_GAAP_FINANCIALS', '{"attributes":{"REPORTING_FRAMEWORK":"GAAP","INDUSTRY":"MANUFACTURING","STATEMENT_AVAILABLE":"true"},"relationships":[]}', 1),
    ('COMPANY_SURFACE', 'LUMEN', 'Lumen Holdings', 'No reporting framework and no manufacturing industry, so those pages stay hidden.', '', '{"attributes":{"INDUSTRY":"SERVICES"},"relationships":[]}', 2)
) AS v(surface_code, profile_code, profile_name, description, template_code, facts, display_order)
    ON s.surface_code = v.surface_code
ON CONFLICT (surface_id, profile_code) DO NOTHING;
