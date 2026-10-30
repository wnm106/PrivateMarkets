-- Deal pipeline and allocation surface: entity model.
--
-- A deal is financed through tranches. A tranche is the intersection of a DEAL
-- and a SECURITY: the security carries the instrument terms, the deal carries
-- the structure and our hold. Like POSITION, the intersection is registered as
-- an intersection type for its constituents, and the records are ordinary
-- entities joined by relationships so the compliance, calculation and grid
-- engines can reach them.
--
-- A proposed allocation is a synthetic POSITION: a fund, a security and the
-- tranche, flagged hypothetical. Existing position rules (concentration,
-- unfunded commitments, eligibility) then evaluate a proposal exactly as they
-- evaluate a booked holding. Rules that measure the real book must exclude
-- POSITION_IS_HYPOTHETICAL.

-- ============================================================
-- 1. Domains
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('DEAL_TRANCHE', 'Deal Tranche', 'One tranche of a deal: the intersection of a deal and a security, with our hold'),
    ('SPONSOR', 'Sponsor', 'Private equity sponsor or owner behind a borrower'),
    ('DEAL_FUNDING_PLAN', 'Deal Funding Plan', 'How one fund funds its share of a deal: cash, leverage line, capital call')
ON CONFLICT (domain_code) DO NOTHING;

-- ============================================================
-- 2. Controlled lists
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('DEAL_STAGE', 'Deal Stage', 'DEAL', 'Where a deal sits in its life cycle'),
    ('DEAL_STRATEGY', 'Deal Strategy', 'DEAL', 'Investment strategy a deal belongs to'),
    ('ALLOCATION_REASON', 'Allocation Reason', 'POSITION', 'Why an allocation was adjusted by hand'),
    ('ALLOCATION_ADJUSTMENT', 'Allocation Adjustment', 'POSITION', 'Kind of manual adjustment to a proposed allocation'),
    ('FUNDING_ORDER', 'Funding Order', 'DEAL_FUNDING_PLAN', 'Order in which funding sources are used')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    -- Codes match the stages already used by the Deal Management pipeline.
    ('DEAL_STAGE', 'ORIGINATION', 'Origination', 1, '[]'),
    ('DEAL_STAGE', 'DILIGENCE', 'Diligence', 2, '[]'),
    ('DEAL_STAGE', 'COMMITTEE', 'IC approved', 3, '["Committee","IC"]'),
    ('DEAL_STAGE', 'ALLOCATION', 'Allocation', 4, '[]'),
    ('DEAL_STAGE', 'CLOSING', 'Closing', 5, '[]'),
    ('DEAL_STAGE', 'CLOSED', 'Funded', 6, '["Closed"]'),
    ('DEAL_STRATEGY', 'DIRECT_LENDING', 'Direct Lending', 1, '[]'),
    ('DEAL_STRATEGY', 'OPPORTUNISTIC_CREDIT', 'Opportunistic Credit', 2, '[]'),
    ('DEAL_STRATEGY', 'ASSET_BASED_FINANCE', 'Asset-Based Finance', 3, '["ABF"]'),
    ('DEAL_STRATEGY', 'SPECIAL_SITUATIONS', 'Special Situations', 4, '[]'),
    ('ALLOCATION_REASON', 'LIQ', 'Liquidity or reserve constraint', 1, '[]'),
    ('ALLOCATION_REASON', 'CONC', 'Concentration or exposure limit', 2, '[]'),
    ('ALLOCATION_REASON', 'MAND', 'Mandate or guideline restriction', 3, '[]'),
    ('ALLOCATION_REASON', 'TAX', 'Tax or regulatory', 4, '[]'),
    ('ALLOCATION_REASON', 'CONF', 'Conflict of interest or affiliate', 5, '[]'),
    ('ALLOCATION_REASON', 'PORT', 'Portfolio construction or diversification', 6, '[]'),
    ('ALLOCATION_REASON', 'IC', 'Investment committee directive', 7, '[]'),
    ('ALLOCATION_REASON', 'CLNT', 'Client instruction', 8, '[]'),
    ('ALLOCATION_REASON', 'OTH', 'Other (note required)', 9, '[]'),
    ('ALLOCATION_ADJUSTMENT', 'OVERRIDE', 'Override amount', 1, '[]'),
    ('ALLOCATION_ADJUSTMENT', 'EXCLUDE', 'Exclude from tranche', 2, '[]'),
    ('FUNDING_ORDER', 'POLICY', 'Fund policy mix', 1, '[]'),
    ('FUNDING_ORDER', 'CASH_LINE_CALL', 'Cash, then line, then call', 2, '[]'),
    ('FUNDING_ORDER', 'LINE_CASH_CALL', 'Line, then cash, then call', 3, '[]'),
    ('FUNDING_ORDER', 'CALL_CASH_LINE', 'Capital call first', 4, '[]')
) AS v(list_code, code, label, ord, syn) ON v.list_code = rl.list_code
ON CONFLICT (list_id, value_code) DO NOTHING;

-- Tranche types the existing instrument list does not carry. A warrant is its
-- own type, so the synonym moves off the generic derivative.
INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
CROSS JOIN (VALUES
    ('DELAYED_DRAW_TERM_LOAN', 'Delayed Draw Term Loan', 9, '["DDTL","Delayed Draw","Delayed Draw Term Loan"]'),
    ('SECOND_LIEN_LOAN', 'Second Lien Term Loan', 10, '["2L","Second Lien","Second Lien Term Loan","2L Term Loan"]'),
    ('WARRANT', 'Warrant', 11, '["Warrants","Equity Warrant"]')
) AS v(code, label, ord, syn)
WHERE rl.list_code = 'INSTRUMENT_TYPE'
ON CONFLICT (list_id, value_code) DO NOTHING;

UPDATE metadata_register.reference_list_values v
SET synonyms = COALESCE(v.synonyms, '[]'::jsonb) - 'Warrant'
FROM metadata_register.reference_lists l
WHERE v.list_id = l.id
  AND l.list_code = 'INSTRUMENT_TYPE'
  AND v.value_code = 'DERIVATIVE';

-- ============================================================
-- 3. Attributes
-- ============================================================

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension
)
SELECT v.code, v.name, v.dtype, v.descr, v.dom,
       v.list, v.multi, FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       v.tv, CASE WHEN v.tv THEN 'VALID_TIME' ELSE 'NONE' END
FROM (VALUES
    -- Deal
    ('DEAL_STRATEGY', 'Strategy', 'REFERENCE_LIST', 'Investment strategy the deal belongs to', 'DEAL', 'DEAL_STRATEGY', FALSE, 'Pipeline', 3, FALSE),
    ('DEAL_DESCRIPTION', 'Deal Description', 'STRING', 'One line description of the financing', 'DEAL', NULL, FALSE, 'Terms', 13, FALSE),
    ('DEAL_SECTOR', 'Sector', 'STRING', 'Borrower sector', 'DEAL', NULL, FALSE, 'Terms', 14, FALSE),
    ('DEAL_EBITDA', 'Borrower EBITDA', 'CURRENCY', 'Borrower EBITDA used to size leverage', 'DEAL', NULL, FALSE, 'Terms', 15, TRUE),
    ('DEAL_PRICING_SUMMARY', 'Pricing Summary', 'STRING', 'Headline pricing, for example SOFR + 575, 1.00% floor', 'DEAL', NULL, FALSE, 'Terms', 16, FALSE),
    ('DEAL_OID_PRICE', 'OID Price', 'NUMBER', 'Original issue price as a percent of par', 'DEAL', NULL, FALSE, 'Terms', 17, FALSE),
    ('DEAL_LEVERAGE_SENIOR', 'Senior Leverage', 'NUMBER', 'Senior debt to EBITDA through our tranche', 'DEAL', NULL, FALSE, 'Terms', 18, TRUE),
    ('DEAL_LEVERAGE_TOTAL', 'Total Leverage', 'NUMBER', 'Total debt to EBITDA', 'DEAL', NULL, FALSE, 'Terms', 19, TRUE),
    ('DEAL_ADVANCE_RATE', 'Advance Rate', 'PERCENTAGE', 'Advance rate for asset-based deals', 'DEAL', NULL, FALSE, 'Terms', 20, FALSE),
    ('DEAL_MATURITY_DATE', 'Maturity Date', 'DATE', 'Final maturity of the financing', 'DEAL', NULL, FALSE, 'Terms', 21, FALSE),
    ('DEAL_TARGET_CLOSE_DATE', 'Target Close Date', 'DATE', 'Date the deal is expected to close and fund', 'DEAL', NULL, FALSE, 'Pipeline', 4, TRUE),
    ('DEAL_IC_DATE', 'IC Date', 'DATE', 'Investment committee meeting date', 'DEAL', NULL, FALSE, 'Pipeline', 5, FALSE),

    -- Tranche (deal x security)
    ('TRANCHE_SIZE', 'Tranche Size', 'CURRENCY', 'Size of the tranche across all lenders', 'DEAL_TRANCHE', NULL, FALSE, 'Structure', 1, FALSE),
    ('TRANCHE_RANK', 'Seniority Rank', 'INTEGER', '1 is most senior. Equity-linked tranches rank last.', 'DEAL_TRANCHE', NULL, FALSE, 'Structure', 2, FALSE),
    ('TRANCHE_IS_UNFUNDED', 'Unfunded at Close', 'BOOLEAN', 'True for delayed draw and revolving tranches drawn on demand', 'DEAL_TRANCHE', NULL, FALSE, 'Structure', 3, FALSE),
    ('TRANCHE_IS_EQUITY_LINKED', 'Equity-Linked', 'BOOLEAN', 'True for warrants and preferred equity', 'DEAL_TRANCHE', NULL, FALSE, 'Structure', 4, FALSE),
    ('TRANCHE_HOLD_PCT', 'Our Hold', 'PERCENTAGE', 'Our share of the tranche, before it is split across funds', 'DEAL_TRANCHE', NULL, FALSE, 'Allocation', 5, TRUE),
    ('TRANCHE_PRICING', 'Pricing', 'STRING', 'Pricing or coupon of this tranche', 'DEAL_TRANCHE', NULL, FALSE, 'Terms', 6, FALSE),
    ('TRANCHE_CALL_PROTECTION', 'Call Protection', 'STRING', 'Call protection schedule', 'DEAL_TRANCHE', NULL, FALSE, 'Terms', 7, FALSE),
    ('TRANCHE_TICKING_FEE_PCT', 'Ticking Fee', 'PERCENTAGE', 'Fee on undrawn delayed draw amounts', 'DEAL_TRANCHE', NULL, FALSE, 'Terms', 8, FALSE),
    ('TRANCHE_COMMITMENT_FEE_PCT', 'Commitment Fee', 'PERCENTAGE', 'Fee on undrawn revolver amounts', 'DEAL_TRANCHE', NULL, FALSE, 'Terms', 9, FALSE),
    ('TRANCHE_DRAW_PERIOD_MONTHS', 'Draw Period (months)', 'INTEGER', 'How long an unfunded tranche can be drawn', 'DEAL_TRANCHE', NULL, FALSE, 'Terms', 10, FALSE),
    ('TRANCHE_WARRANT_COVERAGE_PCT', 'Warrant Coverage', 'PERCENTAGE', 'Fully diluted equity covered by the warrant', 'DEAL_TRANCHE', NULL, FALSE, 'Terms', 11, FALSE),

    -- Sponsor
    ('SPONSOR_TYPE', 'Sponsor Type', 'STRING', 'Private equity firm, founder owned, court supervised', 'SPONSOR', NULL, FALSE, 'Profile', 1, FALSE),

    -- Fund liquidity, mandate and funding configuration
    ('FUND_CASH_BALANCE', 'Cash on Hand', 'CURRENCY', 'Cash available to deploy', 'FUND', NULL, FALSE, 'Liquidity', 1, TRUE),
    ('FUND_UNDRAWN_COMMITMENTS', 'Undrawn Commitments', 'CURRENCY', 'Investor commitments not yet called', 'FUND', NULL, FALSE, 'Liquidity', 2, TRUE),
    ('FUND_CREDIT_LINE_HEADROOM', 'Credit Line Headroom', 'CURRENCY', 'Unused capacity on the leverage line', 'FUND', NULL, FALSE, 'Liquidity', 3, TRUE),
    ('FUND_PIPELINE_RESERVE', 'Reserved for Pipeline', 'CURRENCY', 'Capital held back for pipeline commitments', 'FUND', NULL, FALSE, 'Liquidity', 4, TRUE),
    ('FUND_ALLOWED_INSTRUMENT_TYPES', 'Allowed Instrument Types', 'REFERENCE_LIST', 'Instrument types the mandate permits', 'FUND', 'INSTRUMENT_TYPE', TRUE, 'Mandate', 1, FALSE),
    ('FUND_MANDATE_NOTE', 'Mandate Restriction Note', 'STRING', 'Plain-language reason shown when a security is not permitted', 'FUND', NULL, FALSE, 'Mandate', 2, FALSE),
    ('FUND_SINGLE_ISSUER_LIMIT_PCT', 'Single-Issuer Limit', 'PERCENTAGE', 'Maximum exposure to one issuer as a percent of NAV', 'FUND', NULL, FALSE, 'Mandate', 3, FALSE),
    ('FUND_SPONSOR_LIMIT_PCT', 'Sponsor Limit', 'PERCENTAGE', 'Maximum exposure to one sponsor as a percent of NAV', 'FUND', NULL, FALSE, 'Mandate', 4, FALSE),
    ('FUND_UNFUNDED_LIMIT_PCT', 'Unfunded Commitment Limit', 'PERCENTAGE', 'Maximum unfunded commitments as a percent of NAV', 'FUND', NULL, FALSE, 'Mandate', 5, FALSE),
    ('FUND_FUNDING_MIX_CASH_PCT', 'Funding Mix: Cash', 'PERCENTAGE', 'Policy share of a deal funded from cash', 'FUND', NULL, FALSE, 'Funding', 1, FALSE),
    ('FUND_FUNDING_MIX_LINE_PCT', 'Funding Mix: Line', 'PERCENTAGE', 'Policy share of a deal funded from the leverage line', 'FUND', NULL, FALSE, 'Funding', 2, FALSE),
    ('FUND_FUNDING_MIX_CALL_PCT', 'Funding Mix: Capital Call', 'PERCENTAGE', 'Policy share of a deal funded by a capital call', 'FUND', NULL, FALSE, 'Funding', 3, FALSE),
    ('FUND_CALL_NOTICE_DAYS', 'Capital Call Notice (days)', 'INTEGER', 'Days of notice a capital call needs', 'FUND', NULL, FALSE, 'Funding', 4, FALSE),
    ('FUND_LINE_NOTICE_DAYS', 'Line Draw Notice (days)', 'INTEGER', 'Days of notice a leverage line draw needs', 'FUND', NULL, FALSE, 'Funding', 5, FALSE),

    -- Synthetic position: a proposed allocation
    ('POSITION_IS_HYPOTHETICAL', 'Hypothetical', 'BOOLEAN', 'True for a proposed allocation that is not a booked holding', 'POSITION', NULL, FALSE, 'Allocation', 1, FALSE),
    ('POSITION_SCENARIO_CODE', 'Scenario', 'STRING', 'Deal or scenario the proposal belongs to', 'POSITION', NULL, FALSE, 'Allocation', 2, FALSE),
    ('POSITION_ALLOCATION_SYSTEM_AMOUNT', 'System Allocation', 'CURRENCY', 'Amount the allocation engine proposed before any manual adjustment', 'POSITION', NULL, FALSE, 'Allocation', 3, FALSE),
    ('POSITION_ALLOCATION_ADJUSTMENT', 'Adjustment', 'REFERENCE_LIST', 'Override or exclusion applied to the system allocation', 'POSITION', 'ALLOCATION_ADJUSTMENT', FALSE, 'Allocation', 4, FALSE),
    ('POSITION_ALLOCATION_REASON', 'Adjustment Reason', 'REFERENCE_LIST', 'Reason code for the adjustment', 'POSITION', 'ALLOCATION_REASON', FALSE, 'Allocation', 5, FALSE),
    ('POSITION_ALLOCATION_NOTE', 'Adjustment Note', 'STRING', 'Context for the audit trail', 'POSITION', NULL, FALSE, 'Allocation', 6, FALSE),
    ('POSITION_ALLOCATION_CAP', 'Capped By', 'STRING', 'Limit that capped the system allocation, if any', 'POSITION', NULL, FALSE, 'Allocation', 7, FALSE),

    -- Funding plan
    ('FUNDING_CASH_AMOUNT', 'From Cash', 'CURRENCY', 'Amount funded from cash', 'DEAL_FUNDING_PLAN', NULL, FALSE, 'Plan', 1, FALSE),
    ('FUNDING_LINE_AMOUNT', 'From Leverage Line', 'CURRENCY', 'Amount funded from the leverage line', 'DEAL_FUNDING_PLAN', NULL, FALSE, 'Plan', 2, FALSE),
    ('FUNDING_CALL_AMOUNT', 'From Capital Call', 'CURRENCY', 'Amount funded by a capital call', 'DEAL_FUNDING_PLAN', NULL, FALSE, 'Plan', 3, FALSE),
    ('FUNDING_ORDER_POLICY', 'Funding Order', 'REFERENCE_LIST', 'Order in which sources are used', 'DEAL_FUNDING_PLAN', 'FUNDING_ORDER', FALSE, 'Plan', 4, FALSE),
    ('FUNDING_IS_MANUAL', 'Manually Set', 'BOOLEAN', 'True when the split was edited by hand', 'DEAL_FUNDING_PLAN', NULL, FALSE, 'Plan', 5, FALSE),
    ('FUNDING_CALL_NOTICE_DATE', 'Call Notice Date', 'DATE', 'Date the capital call notice is due', 'DEAL_FUNDING_PLAN', NULL, FALSE, 'Dates', 6, FALSE),
    ('FUNDING_LINE_NOTICE_DATE', 'Line Notice Date', 'DATE', 'Date the leverage line draw notice is due', 'DEAL_FUNDING_PLAN', NULL, FALSE, 'Dates', 7, FALSE)
) AS v(code, name, dtype, descr, dom, list, multi, section, grp, tv)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    reference_list_code = EXCLUDED.reference_list_code,
    is_multi_valued = EXCLUDED.is_multi_valued,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

-- Deal stage was free text. Bind it to the list; the stage codes already in use are all in it.
UPDATE metadata_register.attribute_register
SET reference_list_code = 'DEAL_STAGE',
    data_type = 'REFERENCE_LIST'
WHERE attribute_code = 'DEAL_STAGE';

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- ============================================================
-- 4. Templates
-- ============================================================

INSERT INTO metadata_register.domain_templates (template_code, template_name, domain_code, description) VALUES
    ('DEAL_TRANCHE_STANDARD', 'Standard Deal Tranche', 'DEAL_TRANCHE', 'Structure, terms and our hold for one tranche of a deal'),
    ('SPONSOR_STANDARD', 'Standard Sponsor', 'SPONSOR', 'Sponsor profile'),
    ('DEAL_FUNDING_PLAN_STANDARD', 'Standard Deal Funding Plan', 'DEAL_FUNDING_PLAN', 'Funding split and notice dates for one fund in one deal')
ON CONFLICT (template_code) DO NOTHING;

-- Every attribute registered above joins the standard template of its domain.
INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id,
       a.attribute_code IN ('TRANCHE_SIZE', 'TRANCHE_RANK'),
       100,
       COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t
  ON t.domain_code = a.domain_code
 AND t.template_code = a.domain_code || '_STANDARD'
WHERE a.attribute_code IN (
    'DEAL_STRATEGY','DEAL_DESCRIPTION','DEAL_SECTOR','DEAL_EBITDA','DEAL_PRICING_SUMMARY','DEAL_OID_PRICE',
    'DEAL_LEVERAGE_SENIOR','DEAL_LEVERAGE_TOTAL','DEAL_ADVANCE_RATE','DEAL_MATURITY_DATE',
    'DEAL_TARGET_CLOSE_DATE','DEAL_IC_DATE',
    'TRANCHE_SIZE','TRANCHE_RANK','TRANCHE_IS_UNFUNDED','TRANCHE_IS_EQUITY_LINKED','TRANCHE_HOLD_PCT',
    'TRANCHE_PRICING','TRANCHE_CALL_PROTECTION','TRANCHE_TICKING_FEE_PCT','TRANCHE_COMMITMENT_FEE_PCT',
    'TRANCHE_DRAW_PERIOD_MONTHS','TRANCHE_WARRANT_COVERAGE_PCT',
    'SPONSOR_TYPE',
    'FUND_CASH_BALANCE','FUND_UNDRAWN_COMMITMENTS','FUND_CREDIT_LINE_HEADROOM','FUND_PIPELINE_RESERVE',
    'FUND_ALLOWED_INSTRUMENT_TYPES','FUND_MANDATE_NOTE','FUND_SINGLE_ISSUER_LIMIT_PCT','FUND_SPONSOR_LIMIT_PCT',
    'FUND_UNFUNDED_LIMIT_PCT','FUND_FUNDING_MIX_CASH_PCT','FUND_FUNDING_MIX_LINE_PCT','FUND_FUNDING_MIX_CALL_PCT',
    'FUND_CALL_NOTICE_DAYS','FUND_LINE_NOTICE_DAYS',
    'POSITION_IS_HYPOTHETICAL','POSITION_SCENARIO_CODE','POSITION_ALLOCATION_SYSTEM_AMOUNT',
    'POSITION_ALLOCATION_ADJUSTMENT','POSITION_ALLOCATION_REASON','POSITION_ALLOCATION_NOTE','POSITION_ALLOCATION_CAP',
    'FUNDING_CASH_AMOUNT','FUNDING_LINE_AMOUNT','FUNDING_CALL_AMOUNT','FUNDING_ORDER_POLICY',
    'FUNDING_IS_MANUAL','FUNDING_CALL_NOTICE_DATE','FUNDING_LINE_NOTICE_DATE'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

-- ============================================================
-- 5. Relationships
-- ============================================================
-- Parent is the record that points at the child, as POSITION_FUND does.

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES
    ('TRANCHE_DEAL', 'Tranche of deal', 'DEAL_TRANCHE', 'DEAL', 'The deal a tranche finances', 'MANY_TO_ONE', TRUE),
    ('TRANCHE_SECURITY', 'Tranche security', 'DEAL_TRANCHE', 'SECURITY', 'The security that carries the tranche terms', 'MANY_TO_ONE', TRUE),
    ('POSITION_TRANCHE', 'Position in tranche', 'POSITION', 'DEAL_TRANCHE', 'The tranche a synthetic position proposes to hold', 'MANY_TO_ONE', FALSE),
    ('DEAL_SPONSOR', 'Deal sponsor', 'DEAL', 'SPONSOR', 'Sponsor behind the borrower', 'MANY_TO_ONE', FALSE),
    ('FUNDING_DEAL', 'Funding plan for deal', 'DEAL_FUNDING_PLAN', 'DEAL', 'The deal being funded', 'MANY_TO_ONE', TRUE),
    ('FUNDING_FUND', 'Funding plan for fund', 'DEAL_FUNDING_PLAN', 'FUND', 'The fund doing the funding', 'MANY_TO_ONE', TRUE)
ON CONFLICT (relationship_code) DO UPDATE
SET parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

-- ============================================================
-- 6. Intersection type: a tranche is a deal x a security
-- ============================================================

INSERT INTO metadata_register.intersection_types (intersection_code, intersection_name, description) VALUES
    ('DEAL_TRANCHE', 'Deal Tranche', 'A tranche of a deal: the deal it finances and the security that carries its terms')
ON CONFLICT (intersection_code) DO NOTHING;

INSERT INTO metadata_register.intersection_type_members (intersection_type_id, domain_code, member_role, is_required, display_order)
SELECT it.id, v.domain_code, v.member_role, TRUE, v.ord
FROM metadata_register.intersection_types it
CROSS JOIN (VALUES ('DEAL', 'DEAL', 1), ('SECURITY', 'SECURITY', 2)) AS v(domain_code, member_role, ord)
WHERE it.intersection_code = 'DEAL_TRANCHE'
ON CONFLICT (intersection_type_id, member_role) DO NOTHING;

-- ============================================================
-- 7. Source for engine-written proposals
-- ============================================================

INSERT INTO entity_instances.source_registry (source_code, source_name, source_type)
VALUES ('ALLOCATION_ENGINE', 'Allocation Engine', 'INTERNAL')
ON CONFLICT (source_code) DO NOTHING;

-- ============================================================
-- 8. Deal Management experience: stages and tranches
-- ============================================================

UPDATE public.record_experiences
SET pipeline = jsonb_set(
        pipeline,
        '{stages}',
        '[
          {"code":"ORIGINATION","label":"Origination"},
          {"code":"DILIGENCE","label":"Diligence"},
          {"code":"COMMITTEE","label":"IC approved"},
          {"code":"ALLOCATION","label":"Allocation"},
          {"code":"CLOSING","label":"Closing"},
          {"code":"CLOSED","label":"Funded"}
        ]'::jsonb
    ),
    sections = CASE
        WHEN sections @> '[{"key":"tranches"}]'::jsonb THEN sections
        ELSE sections || '[{"key":"tranches","title":"Tranches","kind":"GRID","placement":"TAB","domainCode":"DEAL_TRANCHE","relationshipCode":"TRANCHE_DEAL","direction":"UP","templateCode":"DEAL_TRANCHE_STANDARD","columns":["TRANCHE_SIZE","TRANCHE_RANK","TRANCHE_HOLD_PCT","TRANCHE_IS_UNFUNDED","TRANCHE_PRICING"]}]'::jsonb
    END,
    updated_at = NOW()
WHERE experience_code = 'DEAL_MANAGEMENT'
  AND pipeline IS NOT NULL;

NOTIFY pgrst, 'reload schema';
