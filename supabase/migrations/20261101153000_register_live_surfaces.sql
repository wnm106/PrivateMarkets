-- Register the surfaces that the product actually opens.
--
-- Deal pipeline in the app is the list at /pipeline. The tabs below are the
-- deal record opened from that list.
-- Fund surface tabs match the fund overview.

UPDATE public.surface_definitions
SET is_active = FALSE
WHERE surface_code IN ('FUND_CONDITIONAL_PAGE', 'FUND_FLUID_SURFACE', 'COMPANY_SURFACE');

UPDATE public.surface_definitions
SET surface_name = 'Fund surface',
    description = 'Tabs on the fund overview. Capital accounts appear for a closed-end fund. Shareholder filings appear for a public BDC. The other tabs are on every fund.'
WHERE surface_code = 'FUND_SURFACE';

UPDATE public.surface_definitions
SET surface_name = 'Deal record',
    description = 'Tabs on the deal you open from the Deal pipeline list. Capital structure, IC memo, and Compliance are live. Syndicate, Funding, Closing, and Servicing are on the page and not built yet.'
WHERE surface_code = 'DEAL_PIPELINE';

DELETE FROM public.surface_components
WHERE surface_id IN (SELECT id FROM public.surface_definitions WHERE surface_code IN ('FUND_SURFACE', 'DEAL_PIPELINE'));

DELETE FROM public.surface_page_slots
WHERE surface_id IN (SELECT id FROM public.surface_definitions WHERE surface_code IN ('FUND_SURFACE', 'DEAL_PIPELINE'));

DELETE FROM public.surface_experiences
WHERE surface_id IN (SELECT id FROM public.surface_definitions WHERE surface_code IN ('FUND_SURFACE', 'DEAL_PIPELINE'));

INSERT INTO public.surface_experiences (
    surface_id, experience_code, experience_name, description, is_baseline,
    qualification_priority, display_order, applicability_rules
)
SELECT s.id, v.experience_code, v.experience_name, v.description, v.is_baseline,
       v.qualification_priority, v.display_order, v.applicability_rules::jsonb
FROM public.surface_definitions s
JOIN (VALUES
    ('FUND_SURFACE', 'FUND_BASELINE', 'Fund baseline', 'On every fund overview.', TRUE, 100, 1, '{"logic":"AND","conditions":[]}'),
    ('FUND_SURFACE', 'CLOSED_END_CAPITAL', 'Closed-end capital accounts', 'Capital accounts tab for a closed-end fund.', FALSE, 10, 2, '{"logic":"AND","conditions":[{"attributeCode":"FUND_STRUCTURE","operator":"equals","value":"CLOSED_END"}]}'),
    ('FUND_SURFACE', 'BDC_FILINGS', 'Shareholder filings', 'Shareholder filings tab for a public BDC.', FALSE, 10, 3, '{"logic":"AND","conditions":[{"attributeCode":"FUND_STRUCTURE","operator":"equals","value":"PUBLIC_BDC"}]}'),
    ('DEAL_PIPELINE', 'DEAL_BASELINE', 'Deal baseline', 'On every deal record.', TRUE, 100, 1, '{"logic":"AND","conditions":[]}')
) AS v(surface_code, experience_code, experience_name, description, is_baseline, qualification_priority, display_order, applicability_rules)
    ON s.surface_code = v.surface_code
ON CONFLICT (surface_id, experience_code) DO NOTHING;

INSERT INTO public.surface_page_slots (surface_id, slot_code, slot_name, description, display_order, optionality)
SELECT s.id, v.slot_code, v.slot_name, v.description, v.display_order, v.optionality
FROM public.surface_definitions s
JOIN (VALUES
    ('FUND_SURFACE', 'NAV', 'NAV', 'On every fund overview.', 1, 'always'),
    ('FUND_SURFACE', 'PACING', 'Capital pacing', 'On every fund overview.', 2, 'always'),
    ('FUND_SURFACE', 'ACTIVITY', 'Capital activity', 'On every fund overview.', 3, 'always'),
    ('FUND_SURFACE', 'REVIEW', 'NAV statement review', 'On every fund overview.', 4, 'always'),
    ('FUND_SURFACE', 'RETURNS', 'Returns', 'On every fund overview.', 5, 'always'),
    ('FUND_SURFACE', 'LIQUIDITY', 'Liquidity', 'On every fund overview.', 6, 'always'),
    ('FUND_SURFACE', 'INVESTORS', 'Investors', 'On every fund overview.', 7, 'always'),
    ('FUND_SURFACE', 'EXPOSURE', 'Exposure', 'On every fund overview.', 8, 'always'),
    ('FUND_SURFACE', 'ACCOUNTS', 'Capital accounts', 'Only for a closed-end fund.', 9, 'when_qualified'),
    ('FUND_SURFACE', 'FILINGS', 'Shareholder filings', 'Only for a public BDC.', 10, 'when_qualified'),
    ('DEAL_PIPELINE', 'CAPITAL', 'Capital structure', 'Live on the deal record.', 1, 'always'),
    ('DEAL_PIPELINE', 'MEMO', 'IC memo', 'Live on the deal record.', 2, 'always'),
    ('DEAL_PIPELINE', 'COMPLIANCE', 'Compliance', 'Live on the deal record.', 3, 'always'),
    ('DEAL_PIPELINE', 'SYNDICATE', 'Syndicate', 'On the deal record. Not built yet.', 4, 'always'),
    ('DEAL_PIPELINE', 'FUNDING', 'Funding', 'On the deal record. Not built yet.', 5, 'always'),
    ('DEAL_PIPELINE', 'CLOSING', 'Closing', 'On the deal record. Not built yet.', 6, 'always'),
    ('DEAL_PIPELINE', 'SERVICING', 'Servicing', 'On the deal record. Not built yet.', 7, 'always')
) AS v(surface_code, slot_code, slot_name, description, display_order, optionality)
    ON s.surface_code = v.surface_code
ON CONFLICT (surface_id, slot_code) DO NOTHING;

INSERT INTO public.surface_page_variants (slot_id, variant_code, variant_name, description, qualification_priority)
SELECT sl.id, v.variant_code, v.variant_name, v.description, v.qualification_priority
FROM public.surface_definitions s
JOIN public.surface_page_slots sl ON sl.surface_id = s.id
JOIN (VALUES
    ('FUND_SURFACE', 'NAV', 'NAV', 'NAV', 'Quarter-end NAV and composition.', 100),
    ('FUND_SURFACE', 'PACING', 'PACING', 'Capital pacing', 'Called capital against the deployment plan.', 100),
    ('FUND_SURFACE', 'ACTIVITY', 'ACTIVITY', 'Capital activity', 'Calls and distributions.', 100),
    ('FUND_SURFACE', 'REVIEW', 'REVIEW', 'NAV statement review', 'Administrator lines against the shadow calculation.', 100),
    ('FUND_SURFACE', 'RETURNS', 'RETURNS', 'Returns', 'IRR, TVPI, and DPI.', 100),
    ('FUND_SURFACE', 'LIQUIDITY', 'LIQUIDITY', 'Liquidity', 'Cash, facility, and coverage.', 100),
    ('FUND_SURFACE', 'INVESTORS', 'INVESTORS', 'Investors', 'Commitments by investor.', 100),
    ('FUND_SURFACE', 'EXPOSURE', 'EXPOSURE', 'Exposure', 'Strategy, sector, and issuer.', 100),
    ('FUND_SURFACE', 'ACCOUNTS', 'ACCOUNTS', 'Capital accounts', 'Investor capital accounts.', 10),
    ('FUND_SURFACE', 'FILINGS', 'FILINGS', 'Shareholder filings', 'Statements for a public BDC.', 10),
    ('DEAL_PIPELINE', 'CAPITAL', 'CAPITAL', 'Capital structure', 'Tranches in order of seniority.', 100),
    ('DEAL_PIPELINE', 'MEMO', 'MEMO', 'IC memo', 'Investment committee memo.', 100),
    ('DEAL_PIPELINE', 'COMPLIANCE', 'COMPLIANCE', 'Compliance', 'Mandate checks for the hold.', 100),
    ('DEAL_PIPELINE', 'SYNDICATE', 'SYNDICATE', 'Syndicate', 'Not built yet.', 100),
    ('DEAL_PIPELINE', 'FUNDING', 'FUNDING', 'Funding', 'Not built yet.', 100),
    ('DEAL_PIPELINE', 'CLOSING', 'CLOSING', 'Closing', 'Not built yet.', 100),
    ('DEAL_PIPELINE', 'SERVICING', 'SERVICING', 'Servicing', 'Not built yet.', 100)
) AS v(surface_code, slot_code, variant_code, variant_name, description, qualification_priority)
    ON s.surface_code = v.surface_code AND sl.slot_code = v.slot_code
ON CONFLICT (slot_id, variant_code) DO NOTHING;

INSERT INTO public.surface_variant_requirements (variant_id, experience_id)
SELECT v.id, e.id
FROM (VALUES
    ('FUND_SURFACE', 'ACCOUNTS', 'ACCOUNTS', 'CLOSED_END_CAPITAL'),
    ('FUND_SURFACE', 'FILINGS', 'FILINGS', 'BDC_FILINGS')
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
    ('FUND_SURFACE', 'NAV', 'NAV', 'FUND_BASELINE', 'NAV', 'NAV', 'Quarter-end NAV and composition.', 1),
    ('FUND_SURFACE', 'PACING', 'PACING', 'FUND_BASELINE', 'PACING', 'Capital pacing', 'Called capital against the plan.', 1),
    ('FUND_SURFACE', 'ACTIVITY', 'ACTIVITY', 'FUND_BASELINE', 'ACTIVITY', 'Capital activity', 'Calls and distributions.', 1),
    ('FUND_SURFACE', 'REVIEW', 'REVIEW', 'FUND_BASELINE', 'REVIEW', 'NAV statement review', 'Administrator versus shadow.', 1),
    ('FUND_SURFACE', 'RETURNS', 'RETURNS', 'FUND_BASELINE', 'RETURNS', 'Returns', 'IRR, TVPI, and DPI.', 1),
    ('FUND_SURFACE', 'LIQUIDITY', 'LIQUIDITY', 'FUND_BASELINE', 'LIQUIDITY', 'Liquidity', 'Cash and facility coverage.', 1),
    ('FUND_SURFACE', 'INVESTORS', 'INVESTORS', 'FUND_BASELINE', 'INVESTORS', 'Investors', 'Commitments by investor.', 1),
    ('FUND_SURFACE', 'EXPOSURE', 'EXPOSURE', 'FUND_BASELINE', 'EXPOSURE', 'Exposure', 'Strategy, sector, and issuer.', 1),
    ('FUND_SURFACE', 'ACCOUNTS', 'ACCOUNTS', 'CLOSED_END_CAPITAL', 'ACCOUNTS', 'Capital accounts', 'Investor capital accounts.', 1),
    ('FUND_SURFACE', 'FILINGS', 'FILINGS', 'BDC_FILINGS', 'FILINGS', 'Shareholder filings', 'Public BDC statements.', 1),
    ('DEAL_PIPELINE', 'CAPITAL', 'CAPITAL', 'DEAL_BASELINE', 'CAPITAL', 'Capital structure', 'Tranches in order of seniority.', 1),
    ('DEAL_PIPELINE', 'MEMO', 'MEMO', 'DEAL_BASELINE', 'MEMO', 'IC memo', 'Investment committee memo.', 1),
    ('DEAL_PIPELINE', 'COMPLIANCE', 'COMPLIANCE', 'DEAL_BASELINE', 'COMPLIANCE', 'Compliance', 'Mandate checks for the hold.', 1),
    ('DEAL_PIPELINE', 'SYNDICATE', 'SYNDICATE', 'DEAL_BASELINE', 'SYNDICATE', 'Syndicate', 'On the page. Not built yet.', 1),
    ('DEAL_PIPELINE', 'FUNDING', 'FUNDING', 'DEAL_BASELINE', 'FUNDING', 'Funding', 'On the page. Not built yet.', 1),
    ('DEAL_PIPELINE', 'CLOSING', 'CLOSING', 'DEAL_BASELINE', 'CLOSING', 'Closing', 'On the page. Not built yet.', 1),
    ('DEAL_PIPELINE', 'SERVICING', 'SERVICING', 'DEAL_BASELINE', 'SERVICING', 'Servicing', 'On the page. Not built yet.', 1)
) AS c(surface_code, slot_code, variant_code, experience_code, component_code, component_name, description, display_order)
JOIN public.surface_definitions s ON s.surface_code = c.surface_code
JOIN public.surface_page_slots sl ON sl.surface_id = s.id AND sl.slot_code = c.slot_code
JOIN public.surface_page_variants v ON v.slot_id = sl.id AND v.variant_code = c.variant_code
JOIN public.surface_experiences e ON e.surface_id = s.id AND e.experience_code = c.experience_code
ON CONFLICT (surface_id, component_code) DO NOTHING;
