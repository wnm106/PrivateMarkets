-- Custom surfaces for the two sample funds.
--
-- Harbor Street BDC and Northline PE Fund III are resolved twice:
-- once as themselves, and once with the fund type swapped.
--
-- Conditional page: Overview stays. Shareholder filings appear only for a
-- public BDC. Capital accounts appear only for a closed-end fund.
--
-- Fluid surface: Overview, performance, and NAV stay on the shell. Swapping
-- the type changes the variant inside each page.

ALTER TABLE public.surface_definitions
    ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.surface_definitions
SET is_primary = TRUE
WHERE surface_code IN ('FUND_SURFACE', 'DEAL_PIPELINE', 'COMPANY_SURFACE');

COMMENT ON COLUMN public.surface_definitions.is_primary IS
    'The surface an entity record uses for its domain. Example surfaces stay off the entity page.';

INSERT INTO public.surface_definitions (surface_code, surface_name, domain_code, description, is_primary)
VALUES
    (
        'FUND_CONDITIONAL_PAGE',
        'Conditional page',
        'FUND',
        'Harbor Street BDC and Northline PE Fund III. Overview stays. Shareholder filings appear only when the fund is a public BDC. Capital accounts appear only when it is closed-end. Swap the fund type to add one page and remove the other.',
        FALSE
    ),
    (
        'FUND_FLUID_SURFACE',
        'Fluid surface',
        'FUND',
        'The same two funds. Overview, performance, and NAV stay on the shell. Swapping the fund type changes the variant inside each page: BDC total return and the BDC chart of accounts, or closed-end IRR and the private-equity chart.',
        FALSE
    )
ON CONFLICT (surface_code) DO NOTHING;

-- ------------------------------------------------------------
-- Conditional page
-- ------------------------------------------------------------

INSERT INTO public.surface_experiences (
    surface_id, experience_code, experience_name, description, is_baseline,
    qualification_priority, display_order, applicability_rules
)
SELECT s.id, v.experience_code, v.experience_name, v.description, v.is_baseline,
       v.qualification_priority, v.display_order, v.applicability_rules::jsonb
FROM public.surface_definitions s
JOIN (VALUES
    ('FUND_CONDITIONAL_PAGE', 'FUND_BASELINE', 'Fund baseline', 'Overview granted to every fund.', TRUE, 100, 1, '{"logic":"AND","conditions":[]}'),
    ('FUND_CONDITIONAL_PAGE', 'BDC_FILINGS', 'Shareholder filings', 'Filings page for a public BDC.', FALSE, 10, 2, '{"logic":"AND","conditions":[{"attributeCode":"FUND_STRUCTURE","operator":"equals","value":"PUBLIC_BDC"}]}'),
    ('FUND_CONDITIONAL_PAGE', 'CLOSED_END_CAPITAL', 'Closed-end capital accounts', 'Capital accounts page for a closed-end fund.', FALSE, 10, 3, '{"logic":"AND","conditions":[{"attributeCode":"FUND_STRUCTURE","operator":"equals","value":"CLOSED_END"}]}')
) AS v(surface_code, experience_code, experience_name, description, is_baseline, qualification_priority, display_order, applicability_rules)
    ON s.surface_code = v.surface_code
ON CONFLICT (surface_id, experience_code) DO NOTHING;

INSERT INTO public.surface_page_slots (surface_id, slot_code, slot_name, description, display_order, optionality)
SELECT s.id, v.slot_code, v.slot_name, v.description, v.display_order, v.optionality
FROM public.surface_definitions s
JOIN (VALUES
    ('FUND_CONDITIONAL_PAGE', 'OVERVIEW', 'Overview', 'Always on this surface. The type swap does not replace it.', 1, 'always'),
    ('FUND_CONDITIONAL_PAGE', 'FILINGS', 'Shareholder filings', 'Conditional page. Present only for a public BDC.', 2, 'when_qualified'),
    ('FUND_CONDITIONAL_PAGE', 'CAPITAL', 'Capital accounts', 'Conditional page. Present only for a closed-end fund.', 3, 'when_qualified')
) AS v(surface_code, slot_code, slot_name, description, display_order, optionality)
    ON s.surface_code = v.surface_code
ON CONFLICT (surface_id, slot_code) DO NOTHING;

INSERT INTO public.surface_page_variants (slot_id, variant_code, variant_name, description, qualification_priority)
SELECT sl.id, v.variant_code, v.variant_name, v.description, v.qualification_priority
FROM public.surface_definitions s
JOIN public.surface_page_slots sl ON sl.surface_id = s.id
JOIN (VALUES
    ('FUND_CONDITIONAL_PAGE', 'OVERVIEW', 'FUND_OVERVIEW', 'Fund overview', 'Single overview. No competing variant.', 100),
    ('FUND_CONDITIONAL_PAGE', 'FILINGS', 'SHAREHOLDER_FILINGS', 'Shareholder filings', 'Filings for a listed BDC.', 10),
    ('FUND_CONDITIONAL_PAGE', 'CAPITAL', 'PARTNER_CAPITAL', 'Partner capital', 'Partner capital accounts.', 10)
) AS v(surface_code, slot_code, variant_code, variant_name, description, qualification_priority)
    ON s.surface_code = v.surface_code AND sl.slot_code = v.slot_code
ON CONFLICT (slot_id, variant_code) DO NOTHING;

INSERT INTO public.surface_variant_requirements (variant_id, experience_id)
SELECT v.id, e.id
FROM (VALUES
    ('FUND_CONDITIONAL_PAGE', 'FILINGS', 'SHAREHOLDER_FILINGS', 'BDC_FILINGS'),
    ('FUND_CONDITIONAL_PAGE', 'CAPITAL', 'PARTNER_CAPITAL', 'CLOSED_END_CAPITAL')
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
    ('FUND_CONDITIONAL_PAGE', 'OVERVIEW', 'FUND_OVERVIEW', 'FUND_BASELINE', 'IDENTITY', 'Identity and terms', 'Stays when the fund type is swapped.', 1),
    ('FUND_CONDITIONAL_PAGE', 'FILINGS', 'SHAREHOLDER_FILINGS', 'BDC_FILINGS', 'SHAREHOLDER_FILINGS', 'Shareholder filings', 'Conditional page content for a public BDC.', 1),
    ('FUND_CONDITIONAL_PAGE', 'CAPITAL', 'PARTNER_CAPITAL', 'CLOSED_END_CAPITAL', 'PARTNER_CAPITAL', 'Partner capital accounts', 'Conditional page content for a closed-end fund.', 1)
) AS c(surface_code, slot_code, variant_code, experience_code, component_code, component_name, description, display_order)
JOIN public.surface_definitions s ON s.surface_code = c.surface_code
JOIN public.surface_page_slots sl ON sl.surface_id = s.id AND sl.slot_code = c.slot_code
LEFT JOIN public.surface_page_variants v ON v.slot_id = sl.id AND v.variant_code = c.variant_code
LEFT JOIN public.surface_experiences e ON e.surface_id = s.id AND e.experience_code = c.experience_code
ON CONFLICT (surface_id, component_code) DO NOTHING;

-- ------------------------------------------------------------
-- Fluid surface
-- ------------------------------------------------------------

INSERT INTO public.surface_experiences (
    surface_id, experience_code, experience_name, description, is_baseline,
    qualification_priority, display_order, applicability_rules
)
SELECT s.id, v.experience_code, v.experience_name, v.description, v.is_baseline,
       v.qualification_priority, v.display_order, v.applicability_rules::jsonb
FROM public.surface_definitions s
JOIN (VALUES
    ('FUND_FLUID_SURFACE', 'FUND_BASELINE', 'Fund baseline', 'Identity granted to every fund.', TRUE, 100, 1, '{"logic":"AND","conditions":[]}'),
    ('FUND_FLUID_SURFACE', 'PUBLIC_BDC_PERFORMANCE', 'Public BDC performance', 'Total return story for a listed BDC.', FALSE, 10, 2, '{"logic":"AND","conditions":[{"attributeCode":"FUND_STRUCTURE","operator":"equals","value":"PUBLIC_BDC"}]}'),
    ('FUND_FLUID_SURFACE', 'CLOSED_END_PERFORMANCE', 'Closed-end performance', 'IRR story for a private closed-end fund.', FALSE, 10, 3, '{"logic":"AND","conditions":[{"attributeCode":"FUND_STRUCTURE","operator":"equals","value":"CLOSED_END"}]}'),
    ('FUND_FLUID_SURFACE', 'BDC_CHART', 'BDC chart of accounts', 'NAV lines for the BDC statement template.', FALSE, 10, 4, '{"logic":"AND","conditions":[{"attributeCode":"TEMPLATE_CODE","operator":"equals","value":"FUND_NAV_BDC"}]}'),
    ('FUND_FLUID_SURFACE', 'PE_CHART', 'PE chart of accounts', 'NAV lines for the private-equity statement template.', FALSE, 10, 5, '{"logic":"AND","conditions":[{"attributeCode":"TEMPLATE_CODE","operator":"equals","value":"FUND_NAV_PE"}]}')
) AS v(surface_code, experience_code, experience_name, description, is_baseline, qualification_priority, display_order, applicability_rules)
    ON s.surface_code = v.surface_code
ON CONFLICT (surface_id, experience_code) DO NOTHING;

INSERT INTO public.surface_page_slots (surface_id, slot_code, slot_name, description, display_order, optionality)
SELECT s.id, v.slot_code, v.slot_name, v.description, v.display_order, v.optionality
FROM public.surface_definitions s
JOIN (VALUES
    ('FUND_FLUID_SURFACE', 'OVERVIEW', 'Overview', 'Always present. The variant changes when the fund is a public BDC.', 1, 'always'),
    ('FUND_FLUID_SURFACE', 'PERFORMANCE', 'Performance', 'Always present. The story swaps between BDC total return and closed-end IRR.', 2, 'always'),
    ('FUND_FLUID_SURFACE', 'NAV', 'NAV statement', 'Always present. The chart of accounts swaps with the winning template.', 3, 'always')
) AS v(surface_code, slot_code, slot_name, description, display_order, optionality)
    ON s.surface_code = v.surface_code
ON CONFLICT (surface_id, slot_code) DO NOTHING;

INSERT INTO public.surface_page_variants (slot_id, variant_code, variant_name, description, qualification_priority)
SELECT sl.id, v.variant_code, v.variant_name, v.description, v.qualification_priority
FROM public.surface_definitions s
JOIN public.surface_page_slots sl ON sl.surface_id = s.id
JOIN (VALUES
    ('FUND_FLUID_SURFACE', 'OVERVIEW', 'FUND_OVERVIEW', 'Fund overview', 'Default overview.', 100),
    ('FUND_FLUID_SURFACE', 'OVERVIEW', 'BDC_OVERVIEW', 'BDC overview', 'Listed BDC overview.', 10),
    ('FUND_FLUID_SURFACE', 'PERFORMANCE', 'PERFORMANCE_DEFAULT', 'Performance summary', 'Default block. Superseded by a specific story.', 100),
    ('FUND_FLUID_SURFACE', 'PERFORMANCE', 'BDC_TOTAL_RETURN', 'BDC total return', 'Total return and NAV per share.', 10),
    ('FUND_FLUID_SURFACE', 'PERFORMANCE', 'CLOSED_END_IRR', 'Closed-end IRR', 'IRR, TVPI, and DPI.', 20),
    ('FUND_FLUID_SURFACE', 'NAV', 'NAV_SUMMARY', 'NAV summary', 'Default NAV block. Superseded by a chart of accounts.', 100),
    ('FUND_FLUID_SURFACE', 'NAV', 'BDC_COA', 'BDC chart of accounts', 'Investments at fair value, borrowings, net assets.', 10),
    ('FUND_FLUID_SURFACE', 'NAV', 'PE_COA', 'Private-equity chart of accounts', 'Paid-in capital, distributions, remaining NAV.', 10)
) AS v(surface_code, slot_code, variant_code, variant_name, description, qualification_priority)
    ON s.surface_code = v.surface_code AND sl.slot_code = v.slot_code
ON CONFLICT (slot_id, variant_code) DO NOTHING;

INSERT INTO public.surface_variant_requirements (variant_id, experience_id)
SELECT v.id, e.id
FROM (VALUES
    ('FUND_FLUID_SURFACE', 'OVERVIEW', 'BDC_OVERVIEW', 'PUBLIC_BDC_PERFORMANCE'),
    ('FUND_FLUID_SURFACE', 'PERFORMANCE', 'BDC_TOTAL_RETURN', 'PUBLIC_BDC_PERFORMANCE'),
    ('FUND_FLUID_SURFACE', 'PERFORMANCE', 'CLOSED_END_IRR', 'CLOSED_END_PERFORMANCE'),
    ('FUND_FLUID_SURFACE', 'NAV', 'BDC_COA', 'BDC_CHART'),
    ('FUND_FLUID_SURFACE', 'NAV', 'PE_COA', 'PE_CHART')
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
    ('FUND_FLUID_SURFACE', 'OVERVIEW', NULL::varchar, 'FUND_BASELINE', 'IDENTITY', 'Identity and terms', 'Stays on whichever overview variant wins.', 1),
    ('FUND_FLUID_SURFACE', 'OVERVIEW', 'FUND_OVERVIEW', NULL::varchar, 'STANDARD_TERMS', 'Standard fund terms', 'Default overview. Superseded by the BDC overview.', 2),
    ('FUND_FLUID_SURFACE', 'OVERVIEW', 'BDC_OVERVIEW', 'PUBLIC_BDC_PERFORMANCE', 'LISTED_SHARE_TERMS', 'Listed share terms', 'BDC overview content.', 2),
    ('FUND_FLUID_SURFACE', 'PERFORMANCE', 'PERFORMANCE_DEFAULT', NULL::varchar, 'PERF_SUMMARY', 'Performance summary', 'Default performance. Superseded by a specific story.', 1),
    ('FUND_FLUID_SURFACE', 'PERFORMANCE', 'BDC_TOTAL_RETURN', 'PUBLIC_BDC_PERFORMANCE', 'BDC_RETURN', 'BDC total return and NAV per share', 'Public BDC performance story.', 1),
    ('FUND_FLUID_SURFACE', 'PERFORMANCE', 'CLOSED_END_IRR', 'CLOSED_END_PERFORMANCE', 'IRR_BRIDGE', 'IRR, TVPI, and DPI bridge', 'Closed-end performance story.', 1),
    ('FUND_FLUID_SURFACE', 'NAV', 'NAV_SUMMARY', NULL::varchar, 'NAV_SUMMARY', 'NAV summary', 'Default NAV block. Superseded by a chart of accounts.', 1),
    ('FUND_FLUID_SURFACE', 'NAV', 'BDC_COA', 'BDC_CHART', 'BDC_NAV_LINES', 'BDC NAV lines', 'BDC chart of accounts.', 1),
    ('FUND_FLUID_SURFACE', 'NAV', 'PE_COA', 'PE_CHART', 'PE_NAV_LINES', 'Private-equity NAV lines', 'Private-equity chart of accounts.', 1)
) AS c(surface_code, slot_code, variant_code, experience_code, component_code, component_name, description, display_order)
JOIN public.surface_definitions s ON s.surface_code = c.surface_code
JOIN public.surface_page_slots sl ON sl.surface_id = s.id AND sl.slot_code = c.slot_code
LEFT JOIN public.surface_page_variants v ON v.slot_id = sl.id AND v.variant_code = c.variant_code
LEFT JOIN public.surface_experiences e ON e.surface_id = s.id AND e.experience_code = c.experience_code
ON CONFLICT (surface_id, component_code) DO NOTHING;

-- ------------------------------------------------------------
-- Sample funds, native and with the type swapped
-- ------------------------------------------------------------

INSERT INTO public.surface_sample_profiles (
    surface_id, profile_code, profile_name, description, template_code, facts, display_order
)
SELECT s.id, v.profile_code, v.profile_name, v.description, v.template_code, v.facts::jsonb, v.display_order
FROM public.surface_definitions s
JOIN (VALUES
    ('FUND_CONDITIONAL_PAGE', 'HARBOR_BDC', 'Harbor Street BDC', 'Native type: public BDC. Shareholder filings qualify. Capital accounts stay off.', 'FUND_NAV_BDC', '{"attributes":{"FUND_STRUCTURE":"PUBLIC_BDC","LISTING_STATUS":"LISTED","ACCOUNTING_BASIS":"GAAP"},"relationships":[]}', 1),
    ('FUND_CONDITIONAL_PAGE', 'HARBOR_SWAPPED', 'Harbor Street BDC, swapped to closed-end', 'Same fund with the type swapped. Capital accounts qualify. Shareholder filings come off.', 'FUND_NAV_PE', '{"attributes":{"FUND_STRUCTURE":"CLOSED_END","LISTING_STATUS":"PRIVATE","ACCOUNTING_BASIS":"FAIR_VALUE"},"relationships":[]}', 2),
    ('FUND_CONDITIONAL_PAGE', 'NORTHLINE_PE', 'Northline PE Fund III', 'Native type: closed-end. Capital accounts qualify. Shareholder filings stay off.', 'FUND_NAV_PE', '{"attributes":{"FUND_STRUCTURE":"CLOSED_END","LISTING_STATUS":"PRIVATE","ACCOUNTING_BASIS":"FAIR_VALUE"},"relationships":[]}', 3),
    ('FUND_CONDITIONAL_PAGE', 'NORTHLINE_SWAPPED', 'Northline PE Fund III, swapped to public BDC', 'Same fund with the type swapped. Shareholder filings qualify. Capital accounts come off.', 'FUND_NAV_BDC', '{"attributes":{"FUND_STRUCTURE":"PUBLIC_BDC","LISTING_STATUS":"LISTED","ACCOUNTING_BASIS":"GAAP"},"relationships":[]}', 4),
    ('FUND_FLUID_SURFACE', 'HARBOR_BDC', 'Harbor Street BDC', 'Native type: public BDC. Performance and NAV use the BDC variants. Every page stays.', 'FUND_NAV_BDC', '{"attributes":{"FUND_STRUCTURE":"PUBLIC_BDC","LISTING_STATUS":"LISTED","ACCOUNTING_BASIS":"GAAP"},"relationships":[]}', 1),
    ('FUND_FLUID_SURFACE', 'HARBOR_SWAPPED', 'Harbor Street BDC, swapped to closed-end', 'Same fund with the type swapped. The pages stay. Performance and NAV become the closed-end variants.', 'FUND_NAV_PE', '{"attributes":{"FUND_STRUCTURE":"CLOSED_END","LISTING_STATUS":"PRIVATE","ACCOUNTING_BASIS":"FAIR_VALUE"},"relationships":[]}', 2),
    ('FUND_FLUID_SURFACE', 'NORTHLINE_PE', 'Northline PE Fund III', 'Native type: closed-end. Performance and NAV use the private-fund variants. Every page stays.', 'FUND_NAV_PE', '{"attributes":{"FUND_STRUCTURE":"CLOSED_END","LISTING_STATUS":"PRIVATE","ACCOUNTING_BASIS":"FAIR_VALUE"},"relationships":[]}', 3),
    ('FUND_FLUID_SURFACE', 'NORTHLINE_SWAPPED', 'Northline PE Fund III, swapped to public BDC', 'Same fund with the type swapped. The pages stay. Performance and NAV become the BDC variants.', 'FUND_NAV_BDC', '{"attributes":{"FUND_STRUCTURE":"PUBLIC_BDC","LISTING_STATUS":"LISTED","ACCOUNTING_BASIS":"GAAP"},"relationships":[]}', 4)
) AS v(surface_code, profile_code, profile_name, description, template_code, facts, display_order)
    ON s.surface_code = v.surface_code
ON CONFLICT (surface_id, profile_code) DO NOTHING;
