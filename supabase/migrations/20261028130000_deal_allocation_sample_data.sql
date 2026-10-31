-- Sample data for the deal pipeline and allocation surface.
-- Eleven deals with tranches, their sponsors, borrowers and securities, four
-- portfolios with nine sub-portfolios (liquidity, mandate, funding policy), and
-- a baseline of synthetic positions for the deals that are in allocation or
-- closing. Everything is tagged metadata.dealAllocationSample so it can be found
-- and removed, and entity codes start with HALY-.
--
-- The synthetic positions are an uncapped baseline: each tranche hold is split
-- across the sub-portfolios that may hold the instrument, in proportion to
-- available capital. The allocation engine will replace them with amounts that
-- respect concentration, sponsor and unfunded limits.
--
-- MARKET_VALUE on a synthetic position is the proposed exposure (funded plus
-- unfunded), so position rules measure the real book and proposals with the
-- same attribute.

-- A sponsor name is an attribute so rules can group by it.
ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    is_required, default_precedence_rank, display_section, display_group, is_editable, is_visible
) VALUES (
    'SPONSOR_NAME', 'Sponsor Name', 'STRING', 'Name used to group exposure by sponsor', 'SPONSOR',
    FALSE, 100, 'Profile', 0, TRUE, TRUE
)
ON CONFLICT (attribute_code) DO NOTHING;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, precedence_rank, display_order)
SELECT t.id, a.id, FALSE, 100, 0
FROM metadata_register.domain_templates t
JOIN metadata_register.attribute_register a ON a.attribute_code = 'SPONSOR_NAME'
WHERE t.template_code = 'SPONSOR_STANDARD'
ON CONFLICT (template_id, attribute_id) DO NOTHING;

DO $$
DECLARE
    v_client uuid;
    v_src uuid;
    v_eng uuid;
BEGIN
    SELECT client_id INTO v_client
    FROM entity_instances.master_entities
    WHERE entity_code = 'PIPE-DEAL-NORTHWIND';
    IF v_client IS NULL THEN
        SELECT id INTO v_client FROM tenancy.clients ORDER BY created_at LIMIT 1;
    END IF;

    SELECT id INTO v_src
    FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 ELSE 1 END
    LIMIT 1;
    SELECT id INTO v_eng FROM entity_instances.source_registry WHERE source_code = 'ALLOCATION_ENGINE';

    IF v_client IS NULL OR v_src IS NULL OR v_eng IS NULL THEN
        RAISE NOTICE 'Skipping deal allocation sample: client % source % engine %', v_client, v_src, v_eng;
        RETURN;
    END IF;

    -- ---------- specifications ----------
    CREATE TEMP TABLE t_ttype ON COMMIT DROP AS
    SELECT * FROM (VALUES
        ('tl',   'LOAN',                   1, FALSE, FALSE, 'Term Loan',                 '102 / 101'),
        ('ddtl', 'DELAYED_DRAW_TERM_LOAN', 1, TRUE,  FALSE, 'Delayed Draw Term Loan',    '102 / 101'),
        ('rcf',  'REVOLVING_CREDIT',       1, TRUE,  FALSE, 'Revolving Credit Facility', NULL),
        ('sl',   'SECOND_LIEN_LOAN',       2, FALSE, FALSE, 'Second Lien Term Loan',     '103 / 102 / 101'),
        ('mz',   'MEZZANINE',              3, FALSE, FALSE, 'Mezzanine Notes',           'NC2, then 104 / 102'),
        ('w',    'WARRANT',                4, FALSE, TRUE,  'Warrant',                   NULL),
        ('pe',   'PREFERRED_EQUITY',       4, FALSE, TRUE,  'Preferred Equity',          NULL)
    ) AS v(ttype, instrument, rank, unfunded, equity, label, call_prot);

    CREATE TEMP TABLE t_deal ON COMMIT DROP AS
    SELECT * FROM (VALUES
        ('halyard',     'Project Halyard',     'DIRECT_LENDING',       'ALLOCATION',  'Halyard Systems',    'Vertical software',       'Northgate Capital',  'Sponsor-backed unitranche with equity kicker',   'SOFR + 575, 1.00% floor', 98.0, 3.6, 4.8, NULL, DATE '2032-11-30', DATE '2026-11-12', 42, 60),
        ('brightwater', 'Project Brightwater', 'DIRECT_LENDING',       'DILIGENCE',   'Brightwater Health', 'Healthcare services',     'Ashgrove Partners',  'Add-on ready unitranche with revolver',          'SOFR + 550, 0.75% floor', 98.5, 3.8, 4.3, NULL, DATE '2032-12-31', DATE '2026-12-18', 58, 50),
        ('cormorant',   'Project Cormorant',   'DIRECT_LENDING',       'CLOSING',     'Cormorant Supply',   'Industrial distribution', 'Keystone Equity',    'Unitranche with acquisition line',               'SOFR + 600, 1.00% floor', 98.0, 3.5, 4.6, NULL, DATE '2032-11-30', DATE '2026-11-04', 52, 85),
        ('linden',      'Project Linden',      'DIRECT_LENDING',       'CLOSED',      'Linden Brands',      'Consumer brands',         'Ridgeview Capital',  'Unitranche refinancing with revolver',           'SOFR + 525, 0.75% floor', 99.0, 3.1, 3.5, NULL, DATE '2031-10-31', DATE '2026-10-09', 34, 70),
        ('tessera',     'Project Tessera',     'OPPORTUNISTIC_CREDIT', 'COMMITTEE',   'Tessera Chemicals',  'Specialty chemicals',     'Halcyon Partners',   'Second lien with equity warrants',               'SOFR + 950, 1.50% floor', 97.0, 4.4, 5.1, NULL, DATE '2032-12-31', DATE '2026-12-03', 40, 60),
        ('obsidian',    'Project Obsidian',    'OPPORTUNISTIC_CREDIT', 'ORIGINATION', 'Obsidian Security',  'Cybersecurity',           'Vireo Capital',      'Mezzanine growth capital with warrants',         '11.0% cash + 3.0% PIK',   98.0, NULL, 5.4, NULL, DATE '2033-01-31', DATE '2027-01-31', 30, 50),
        ('marlowe',     'Project Marlowe',     'ASSET_BASED_FINANCE',  'DILIGENCE',   'Marlowe Leasing',    'Equipment finance',       'Founder owned',      'Asset-backed revolver and term loan',            'SOFR + 450',              99.0, NULL, NULL, 85,   DATE '2030-01-31', DATE '2027-01-14', 28, 55),
        ('quillon',     'Project Quillon',     'ASSET_BASED_FINANCE',  'ALLOCATION',  'Quillon Credit',     'Consumer receivables',    'Cobalt Partners',    'Receivables facility with delayed draw',         'SOFR + 500, 0.50% floor', 98.5, NULL, NULL, 80,   DATE '2031-11-30', DATE '2026-11-20', 36, 65),
        ('vantage',     'Project Vantage',     'SPECIAL_SITUATIONS',   'ORIGINATION', 'Vantage Logistics',  'Freight and logistics',   'Court supervised',   'Debtor-in-possession loan with exit equity',     'SOFR + 900, 2.00% floor', 96.0, 2.9, 3.6, NULL, DATE '2027-08-31', DATE '2026-12-31', 22, 70),
        ('northwind',   'Project Northwind',   'SPECIAL_SITUATIONS',   'CLOSING',     'Northwind Energy',   'Energy services',         'Sable Peak',         'Super senior term loan with warrants',           'SOFR + 800, 1.50% floor', 97.5, 2.9, 3.2, NULL, DATE '2031-11-30', DATE '2026-11-09', 38, 60),
        ('redwood',     'Project Redwood',     'SPECIAL_SITUATIONS',   'COMMITTEE',   'Redwood Materials',  'Building products',       'Ironbridge Capital', 'Senior term loan with mezzanine tranche',        'SOFR + 700, 1.25% floor', 97.0, 3.2, 4.0, NULL, DATE '2031-12-31', DATE '2026-12-10', 30, 55)
    ) AS v(k, name, strategy, stage, borrower, sector, sponsor, descr, pricing, oid, lev_senior, lev_total, advance, maturity, close_date, ebitda_m, hold_pct);

    CREATE TEMP TABLE t_tr ON COMMIT DROP AS
    SELECT * FROM (VALUES
        ('halyard', 'tl', 150, 'SOFR + 575, 1.00% floor', NULL), ('halyard', 'ddtl', 50, 'SOFR + 575', NULL), ('halyard', 'w', 10, NULL, 4.0),
        ('brightwater', 'tl', 220, 'SOFR + 550', NULL), ('brightwater', 'rcf', 30, 'SOFR + 525', NULL),
        ('cormorant', 'tl', 180, 'SOFR + 600', NULL), ('cormorant', 'ddtl', 60, 'SOFR + 600', NULL),
        ('linden', 'tl', 120, 'SOFR + 525', NULL), ('linden', 'rcf', 20, 'SOFR + 500', NULL),
        ('tessera', 'sl', 90, 'SOFR + 950, 1.50% floor', NULL), ('tessera', 'w', 8, NULL, 3.0),
        ('obsidian', 'mz', 75, '11.0% cash + 3.0% PIK', NULL), ('obsidian', 'w', 6, NULL, 2.5),
        ('marlowe', 'rcf', 100, 'SOFR + 425', NULL), ('marlowe', 'tl', 60, 'SOFR + 475', NULL),
        ('quillon', 'tl', 140, 'SOFR + 500', NULL), ('quillon', 'ddtl', 40, 'SOFR + 500', NULL),
        ('vantage', 'tl', 80, 'SOFR + 900', NULL), ('vantage', 'pe', 20, '12.0% PIK dividend', NULL),
        ('northwind', 'tl', 110, 'SOFR + 800', NULL), ('northwind', 'w', 12, NULL, 6.0),
        ('redwood', 'tl', 95, 'SOFR + 700', NULL), ('redwood', 'mz', 25, '12.0% cash', NULL)
    ) AS v(k, ttype, size_m, pricing, coverage);

    -- Funds: code, name, parent code, NAV and liquidity in $M, mandate, funding policy.
    CREATE TEMP TABLE t_fund ON COMMIT DROP AS
    SELECT * FROM (VALUES
        ('mdl',      'Meridian Direct Lending IV',     NULL,  1200, NULL, NULL, NULL, NULL, ARRAY['LOAN','DELAYED_DRAW_TERM_LOAN','REVOLVING_CREDIT'], 'Mandate limited to first lien senior secured debt', 5, 10, 10, NULL, NULL, NULL, NULL, NULL),
        ('mdl-on',   'Meridian DL IV: Onshore LP',     'mdl',  700,  6, 20,  8, 4, ARRAY['LOAN','DELAYED_DRAW_TERM_LOAN','REVOLVING_CREDIT'], NULL, 5, 10, 10, 20, 40, 40, 14, 2),
        ('mdl-off',  'Meridian DL IV: Offshore Feeder','mdl',  330,  3, 10,  4, 2, ARRAY['LOAN','DELAYED_DRAW_TERM_LOAN','REVOLVING_CREDIT'], NULL, 5, 10, 10, 20, 30, 50, 14, 2),
        ('mdl-sma',  'Meridian DL IV: Pension SMA',    'mdl',  170,  2,  8,  0, 0, ARRAY['LOAN'], 'SMA guidelines prohibit unfunded commitments', 5, 10, 10, 40, 0, 60, 21, 2),
        ('ccf',      'Cascade Credit Opportunities II',NULL,   800, NULL, NULL, NULL, NULL, ARRAY['LOAN','DELAYED_DRAW_TERM_LOAN','REVOLVING_CREDIT','SECOND_LIEN_LOAN','MEZZANINE','WARRANT'], 'Mandate does not permit preferred equity', 8, 10, 15, NULL, NULL, NULL, NULL, NULL),
        ('ccf-main', 'Cascade CO II: Main Fund',       'ccf',  520,  8, 18,  5, 3, ARRAY['LOAN','DELAYED_DRAW_TERM_LOAN','REVOLVING_CREDIT','SECOND_LIEN_LOAN','MEZZANINE','WARRANT'], NULL, 8, 10, 15, 25, 35, 40, 14, 2),
        ('ccf-co',   'Cascade CO II: Co-Invest',       'ccf',  280,  2, 10,  0, 0, ARRAY['LOAN','DELAYED_DRAW_TERM_LOAN','REVOLVING_CREDIT','SECOND_LIEN_LOAN','MEZZANINE','WARRANT'], NULL, 8, 10, 15, 20, 0, 80, 14, 2),
        ('hsi',      'Harbor Senior Income',           NULL,  2000, NULL, NULL, NULL, NULL, ARRAY['LOAN','DELAYED_DRAW_TERM_LOAN','REVOLVING_CREDIT','WARRANT'], 'Mandate limited to first lien senior secured debt', 3, 10, 5, NULL, NULL, NULL, NULL, NULL),
        ('hsi-inst', 'Harbor SI: Institutional Sleeve','hsi', 1250, 18,  0, 30, 3, ARRAY['LOAN','DELAYED_DRAW_TERM_LOAN','REVOLVING_CREDIT','WARRANT'], NULL, 3, 10, 5, 40, 60, 0, 0, 2),
        ('hsi-ret',  'Harbor SI: Retail Sleeve',       'hsi',  750, 10,  0, 17, 2, ARRAY['LOAN','DELAYED_DRAW_TERM_LOAN','REVOLVING_CREDIT'], 'Retail sleeve cannot hold non-income securities', 3, 10, 5, 40, 60, 0, 0, 2),
        ('poc',      'Pioneer Opportunistic Credit',   NULL,   600, NULL, NULL, NULL, NULL, ARRAY['LOAN','SECOND_LIEN_LOAN','MEZZANINE','WARRANT','PREFERRED_EQUITY'], 'Mandate prohibits unfunded commitments', 10, 10, 20, NULL, NULL, NULL, NULL, NULL),
        ('poc-main', 'Pioneer OC: Main Fund',          'poc',  430,  5, 14,  0, 1, ARRAY['LOAN','SECOND_LIEN_LOAN','MEZZANINE','WARRANT','PREFERRED_EQUITY'], NULL, 10, 10, 20, 30, 0, 70, 14, 2),
        ('poc-ovs',  'Pioneer OC: Overseas Feeder',    'poc',  170,  1,  7,  0, 1, ARRAY['LOAN','SECOND_LIEN_LOAN','MEZZANINE'], 'Tax: no equity-linked holdings in the offshore feeder', 10, 10, 20, 30, 0, 70, 14, 2)
    ) AS v(k, name, parent_k, nav_m, cash_m, undrawn_m, line_m, res_m, allowed, note, issuer_lim, sponsor_lim, unf_lim, mix_cash, mix_line, mix_call, call_days, line_days);
    -- Liquidity in the sample is sized to let several deals close in one quarter.
    UPDATE t_fund SET cash_m = cash_m * 3, undrawn_m = undrawn_m * 3, line_m = line_m * 3, res_m = res_m * 3
    WHERE parent_k IS NOT NULL;
    UPDATE t_fund SET line_days = 2 WHERE parent_k IS NOT NULL AND line_days IS NULL;

    -- ---------- entities ----------
    CREATE TEMP TABLE t_ent (entity_code text, domain_code text, template_code text, entity_name text, description text) ON COMMIT DROP;

    INSERT INTO t_ent
    SELECT 'HALY-FUND-' || upper(k), 'FUND', 'FUND_STANDARD', name,
           CASE WHEN parent_k IS NULL THEN 'Sample portfolio for the deal allocation surface.' ELSE 'Sample sub-portfolio for the deal allocation surface.' END
    FROM t_fund;
    INSERT INTO t_ent SELECT DISTINCT 'HALY-SPONSOR-' || upper(regexp_replace(sponsor, '[^A-Za-z0-9]+', '-', 'g')), 'SPONSOR', 'SPONSOR_STANDARD', sponsor, 'Sample sponsor.' FROM t_deal;
    INSERT INTO t_ent SELECT 'HALY-ISS-' || upper(k), 'ISSUER', 'ISSUER_STANDARD', borrower, 'Sample borrower for ' || name || '.' FROM t_deal;
    INSERT INTO t_ent SELECT 'HALY-DEAL-' || upper(k), 'DEAL', 'DEAL_STANDARD', name, descr FROM t_deal;
    INSERT INTO t_ent
    SELECT 'HALY-SEC-' || upper(r.k) || '-' || upper(r.ttype), 'SECURITY', 'SECURITY_STANDARD', d.borrower || ' ' || tt.label, 'Security for the ' || tt.label || ' of ' || d.name || '.'
    FROM t_tr r JOIN t_deal d ON d.k = r.k JOIN t_ttype tt ON tt.ttype = r.ttype;
    INSERT INTO t_ent
    SELECT 'HALY-TR-' || upper(r.k) || '-' || upper(r.ttype), 'DEAL_TRANCHE', 'DEAL_TRANCHE_STANDARD', d.name || ': ' || tt.label, 'Tranche of ' || d.name || '.'
    FROM t_tr r JOIN t_deal d ON d.k = r.k JOIN t_ttype tt ON tt.ttype = r.ttype;

    -- Synthetic positions: deals in allocation or closing, split by available capital.
    CREATE TEMP TABLE t_pos ON COMMIT DROP AS
    WITH tranche AS (
        SELECT r.k, r.ttype, tt.instrument, tt.unfunded, d.hold_pct, r.size_m * 1000000.0 * d.hold_pct / 100.0 AS hold_amt
        FROM t_tr r JOIN t_deal d ON d.k = r.k JOIN t_ttype tt ON tt.ttype = r.ttype
        WHERE d.stage IN ('ALLOCATION', 'CLOSING')
    ),
    elig AS (
        SELECT t.k, t.ttype, t.unfunded, t.hold_amt, f.k AS fund_k, f.name AS fund_name,
               (f.cash_m + f.undrawn_m + f.line_m - f.res_m) AS avail
        FROM tranche t
        JOIN t_fund f ON f.parent_k IS NOT NULL AND t.instrument = ANY (f.allowed)
        WHERE (f.cash_m + f.undrawn_m + f.line_m - f.res_m) > 0
    )
    SELECT e.k, e.ttype, e.unfunded, e.fund_k, e.fund_name,
           round((e.hold_amt * e.avail / sum(e.avail) OVER (PARTITION BY e.k, e.ttype))::numeric, 2) AS amt
    FROM elig e;

    INSERT INTO t_ent
    SELECT 'HALY-POS-' || upper(p.k) || '-' || upper(p.ttype) || '-' || upper(p.fund_k), 'POSITION', 'POSITION_STANDARD',
           d.name || ' ' || tt.label || ': ' || p.fund_name || ' (proposed)', 'Proposed allocation, not a booked holding.'
    FROM t_pos p JOIN t_deal d ON d.k = p.k JOIN t_ttype tt ON tt.ttype = p.ttype;

    INSERT INTO entity_instances.master_entities (entity_code, domain_code, template_id, entity_name, description, client_id, metadata)
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name, e.description, v_client, '{"dealAllocationSample":true}'::jsonb
    FROM t_ent e
    JOIN metadata_register.domain_templates t ON t.template_code = e.template_code
    ON CONFLICT (entity_code) DO UPDATE
    SET entity_name = EXCLUDED.entity_name,
        description = EXCLUDED.description,
        template_id = EXCLUDED.template_id,
        domain_code = EXCLUDED.domain_code,
        is_active = TRUE,
        client_id = EXCLUDED.client_id,
        metadata = EXCLUDED.metadata;

    -- ---------- attribute values ----------
    CREATE TEMP TABLE t_val (entity_code text, attribute_code text, val text, source_code text) ON COMMIT DROP;

    INSERT INTO t_val
    SELECT 'HALY-FUND-' || upper(f.k), a.attr, a.val, 'main'
    FROM t_fund f
    CROSS JOIN LATERAL (VALUES
        ('NAV', (f.nav_m * 1000000)::text),
        ('FUND_TYPE', 'Private Credit'),
        ('FUND_STATUS', 'Open'),
        ('FUND_ALLOWED_INSTRUMENT_TYPES', array_to_string(f.allowed, ',')),
        ('FUND_MANDATE_NOTE', f.note),
        ('FUND_SINGLE_ISSUER_LIMIT_PCT', f.issuer_lim::text),
        ('FUND_SPONSOR_LIMIT_PCT', f.sponsor_lim::text),
        ('FUND_UNFUNDED_LIMIT_PCT', f.unf_lim::text),
        ('FUND_CASH_BALANCE', (f.cash_m * 1000000)::text),
        ('FUND_UNDRAWN_COMMITMENTS', (f.undrawn_m * 1000000)::text),
        ('FUND_CREDIT_LINE_HEADROOM', (f.line_m * 1000000)::text),
        ('FUND_PIPELINE_RESERVE', (f.res_m * 1000000)::text),
        ('FUND_FUNDING_MIX_CASH_PCT', f.mix_cash::text),
        ('FUND_FUNDING_MIX_LINE_PCT', f.mix_line::text),
        ('FUND_FUNDING_MIX_CALL_PCT', f.mix_call::text),
        ('FUND_CALL_NOTICE_DAYS', f.call_days::text),
        ('FUND_LINE_NOTICE_DAYS', f.line_days::text)
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    INSERT INTO t_val
    SELECT DISTINCT 'HALY-SPONSOR-' || upper(regexp_replace(sponsor, '[^A-Za-z0-9]+', '-', 'g')), a.attr, a.val, 'main'
    FROM t_deal d
    CROSS JOIN LATERAL (VALUES
        ('SPONSOR_NAME', d.sponsor),
        ('SPONSOR_TYPE', CASE d.sponsor WHEN 'Founder owned' THEN 'Founder owned' WHEN 'Court supervised' THEN 'Court supervised' ELSE 'Private equity sponsor' END)
    ) AS a(attr, val);

    INSERT INTO t_val
    SELECT 'HALY-ISS-' || upper(d.k), a.attr, a.val, 'main'
    FROM t_deal d
    CROSS JOIN LATERAL (VALUES ('ISSUER_LEGAL_NAME', d.borrower), ('SECTOR', d.sector)) AS a(attr, val);

    INSERT INTO t_val
    SELECT 'HALY-DEAL-' || upper(d.k), a.attr, a.val, 'main'
    FROM t_deal d
    JOIN LATERAL (SELECT sum(size_m) AS fac FROM t_tr r WHERE r.k = d.k) fac ON TRUE
    CROSS JOIN LATERAL (VALUES
        ('DEAL_STAGE', d.stage),
        ('STATUS', CASE WHEN d.stage = 'CLOSED' THEN 'Closed' ELSE 'Active' END),
        ('DEAL_TYPE', 'Financing'),
        ('DEAL_VALUE', (fac.fac * 1000000)::text),
        ('DEAL_STRATEGY', d.strategy),
        ('DEAL_DESCRIPTION', d.descr),
        ('DEAL_SECTOR', d.sector),
        ('DEAL_EBITDA', (d.ebitda_m * 1000000)::text),
        ('DEAL_PRICING_SUMMARY', d.pricing),
        ('DEAL_OID_PRICE', d.oid::text),
        ('DEAL_LEVERAGE_SENIOR', d.lev_senior::text),
        ('DEAL_LEVERAGE_TOTAL', d.lev_total::text),
        ('DEAL_ADVANCE_RATE', d.advance::text),
        ('DEAL_MATURITY_DATE', d.maturity::text),
        ('DEAL_TARGET_CLOSE_DATE', d.close_date::text)
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    INSERT INTO t_val
    SELECT 'HALY-SEC-' || upper(r.k) || '-' || upper(r.ttype), a.attr, a.val, 'main'
    FROM t_tr r
    JOIN t_deal d ON d.k = r.k
    JOIN t_ttype tt ON tt.ttype = r.ttype
    CROSS JOIN LATERAL (VALUES
        ('INSTRUMENT_TYPE', tt.instrument),
        ('ORIGINAL_PRINCIPAL_AMOUNT', (r.size_m * 1000000)::text),
        ('CURRENCY', 'USD'),
        ('MATURITY_DATE', d.maturity::text),
        ('SPREAD_BPS', substring(r.pricing FROM 'SOFR \+ ([0-9]+)'))
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    INSERT INTO t_val
    SELECT 'HALY-TR-' || upper(r.k) || '-' || upper(r.ttype), a.attr, a.val, 'main'
    FROM t_tr r
    JOIN t_deal d ON d.k = r.k
    JOIN t_ttype tt ON tt.ttype = r.ttype
    CROSS JOIN LATERAL (VALUES
        ('TRANCHE_SIZE', (r.size_m * 1000000)::text),
        ('TRANCHE_RANK', tt.rank::text),
        ('TRANCHE_IS_UNFUNDED', tt.unfunded::text),
        ('TRANCHE_IS_EQUITY_LINKED', tt.equity::text),
        ('TRANCHE_HOLD_PCT', d.hold_pct::text),
        ('TRANCHE_PRICING', r.pricing),
        ('TRANCHE_CALL_PROTECTION', tt.call_prot),
        ('TRANCHE_TICKING_FEE_PCT', CASE WHEN r.ttype = 'ddtl' THEN '1.5' END),
        ('TRANCHE_COMMITMENT_FEE_PCT', CASE WHEN r.ttype = 'rcf' THEN '0.5' END),
        ('TRANCHE_DRAW_PERIOD_MONTHS', CASE WHEN r.ttype = 'ddtl' THEN '18' END),
        ('TRANCHE_WARRANT_COVERAGE_PCT', r.coverage::text)
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    INSERT INTO t_val
    SELECT 'HALY-POS-' || upper(p.k) || '-' || upper(p.ttype) || '-' || upper(p.fund_k), a.attr, a.val, 'engine'
    FROM t_pos p
    CROSS JOIN LATERAL (VALUES
        ('POSITION_IS_HYPOTHETICAL', 'true'),
        ('POSITION_SCENARIO_CODE', 'HALY-DEAL-' || upper(p.k)),
        ('POSITION_ALLOCATION_SYSTEM_AMOUNT', p.amt::text),
        ('MARKET_VALUE', p.amt::text),
        ('FUNDED_PAR_AMOUNT', CASE WHEN p.unfunded THEN NULL ELSE p.amt::text END),
        ('UNFUNDED_COMMITMENT_AMOUNT', CASE WHEN p.unfunded THEN p.amt::text ELSE NULL END),
        ('POSITION_CURRENCY', 'USD')
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    DELETE FROM golden_master.entity_attribute_values eav
    USING entity_instances.master_entities me
    WHERE eav.entity_id = me.id
      AND me.entity_code LIKE 'HALY-%';

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean, golden_value_jsonb,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, CASE v.source_code WHEN 'engine' THEN v_eng ELSE v_src END, v.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') THEN v.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' THEN v.val::date END,
           CASE WHEN ar.data_type = 'BOOLEAN' THEN v.val::boolean END,
           CASE WHEN ar.attribute_code = 'FUND_ALLOWED_INSTRUMENT_TYPES' THEN to_jsonb(string_to_array(v.val, ',')) END,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"dealAllocationSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    -- ---------- relationships ----------
    -- Parent is the record that points at the child.
    CREATE TEMP TABLE t_rel (parent_code text, child_code text, rel_code text) ON COMMIT DROP;

    INSERT INTO t_rel SELECT 'HALY-FUND-' || upper(parent_k), 'HALY-FUND-' || upper(k), 'FUND_PARENT' FROM t_fund WHERE parent_k IS NOT NULL;
    INSERT INTO t_rel
    SELECT 'HALY-DEAL-' || upper(k), x.child, x.rel
    FROM t_deal d
    CROSS JOIN LATERAL (VALUES
        ('HALY-ISS-' || upper(d.k), 'DEAL_ISSUER'),
        ('HALY-SPONSOR-' || upper(regexp_replace(d.sponsor, '[^A-Za-z0-9]+', '-', 'g')), 'DEAL_SPONSOR')
    ) AS x(child, rel);
    INSERT INTO t_rel
    SELECT 'HALY-SEC-' || upper(k), 'HALY-ISS-' || upper(k), 'SECURITY_ISSUER' FROM (SELECT DISTINCT k FROM t_tr) s;
    INSERT INTO t_rel
    SELECT x.parent, x.child, x.rel
    FROM t_tr r
    CROSS JOIN LATERAL (VALUES
        ('HALY-DEAL-' || upper(r.k), 'HALY-SEC-' || upper(r.k) || '-' || upper(r.ttype), 'DEAL_SECURITY'),
        ('HALY-SEC-' || upper(r.k) || '-' || upper(r.ttype), 'HALY-ISS-' || upper(r.k), 'SECURITY_ISSUER'),
        ('HALY-TR-' || upper(r.k) || '-' || upper(r.ttype), 'HALY-DEAL-' || upper(r.k), 'TRANCHE_DEAL'),
        ('HALY-TR-' || upper(r.k) || '-' || upper(r.ttype), 'HALY-SEC-' || upper(r.k) || '-' || upper(r.ttype), 'TRANCHE_SECURITY')
    ) AS x(parent, child, rel);
    INSERT INTO t_rel
    SELECT x.parent, x.child, x.rel
    FROM t_pos p
    CROSS JOIN LATERAL (VALUES
        ('HALY-POS-' || upper(p.k) || '-' || upper(p.ttype) || '-' || upper(p.fund_k), 'HALY-FUND-' || upper(p.fund_k), 'POSITION_FUND'),
        ('HALY-POS-' || upper(p.k) || '-' || upper(p.ttype) || '-' || upper(p.fund_k), 'HALY-SEC-' || upper(p.k) || '-' || upper(p.ttype), 'POSITION_SECURITY'),
        ('HALY-POS-' || upper(p.k) || '-' || upper(p.ttype) || '-' || upper(p.fund_k), 'HALY-TR-' || upper(p.k) || '-' || upper(p.ttype), 'POSITION_TRANCHE')
    ) AS x(parent, child, rel);

    -- The sample issuer relationship exists once per security; keep one row per pair.
    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from
    )
    SELECT DISTINCT p.id, c.id, rt.relationship_name, r.rel_code, TRUE, DATE '2020-01-01'
    FROM t_rel r
    JOIN entity_instances.master_entities p ON p.entity_code = r.parent_code
    JOIN entity_instances.master_entities c ON c.entity_code = r.child_code
    JOIN metadata_register.relationship_types rt ON rt.relationship_code = r.rel_code
    ON CONFLICT (parent_entity_id, child_entity_id, relationship_code, valid_from) DO NOTHING;
END $$;

NOTIFY pgrst, 'reload schema';
