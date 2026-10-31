-- Halyard Senior Credit Fund II, the worked example for the fund surface.
-- Reporting date September 30, 2026. Amounts in the specification tables are
-- millions; they are stored as currency. Entity codes start with HSCF2-.

DO $$
DECLARE
    v_client uuid;
    v_src uuid;
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

    IF v_client IS NULL OR v_src IS NULL THEN
        RAISE NOTICE 'Skipping fund surface sample: client % source %', v_client, v_src;
        RETURN;
    END IF;

    CREATE TEMP TABLE t_pos ON COMMIT DROP AS
    SELECT * FROM (VALUES
        (1,  'northwind',  'Northwind Logistics',          'SENIOR_SECURED', 'Industrials',    52, 52.6, 6.1,  0,    10.8, 101.2, 101.2, 'S+575',       4.1, TRUE),
        (2,  'quillon',    'Quillon Health',              'UNITRANCHE',     'Healthcare',     48, 48.5, 5.2,  0,    11.4, 101.0, 101.0, 'S+625',       4.8, TRUE),
        (3,  'cobalt',     'Cobalt Software',             'UNITRANCHE',     'Software',       45, 45.9, 4.6,  0,    12.1, 102.0, 102.0, 'S+650',       5.6, TRUE),
        (4,  'harbor',     'Harbor Foods',                'SENIOR_SECURED', 'Consumer',       40, 38.2, 4.0,  0,     3.2,  95.5,  96.8, 'S+550',       5.9, TRUE),
        (5,  'sable',      'Sable Energy Services',       'MEZZANINE',      'Energy',         30, 31.8, 4.8,  0,    14.9, 106.0, 106.0, '12.5% fixed', 4.4, FALSE),
        (6,  'meridian',   'Meridian Specialty Finance',  'ASSET_BASED',    'Financials',     42, 42.4, 4.4,  0,    10.2, 100.9, 100.9, 'S+475',       2.3, TRUE),
        (7,  'pinecrest',  'Pinecrest Education',         'SENIOR_SECURED', 'Education',      36, 36.4, 3.1,  0,     9.7, 101.1, 101.1, 'S+525',       3.9, TRUE),
        (8,  'atlas',      'Atlas Industrial Rentals',    'ASSET_BASED',    'Industrials',    34, 34.1, 2.7,  0,     9.3, 100.3, 100.3, 'S+450',       2.8, TRUE),
        (9,  'bluewater',  'Bluewater Marine',            'MEZZANINE',      'Transportation', 25, 24.0, 3.3,  0,     4.1,  96.0,  94.5, '13.0% fixed', 5.2, FALSE),
        (10, 'ridgeline',  'Ridgeline Dental',            'UNITRANCHE',     'Healthcare',     28, 28.3, 2.4,  0,    10.9, 101.1, 101.1, 'S+600',       4.9, TRUE),
        (11, 'vantage',    'Vantage Payments',            'UNITRANCHE',     'Software',       26, 26.7, 2.0,  0,    11.8, 102.7, 102.7, 'S+625',       4.6, TRUE),
        (12, 'kestrel',    'Kestrel Aerospace',           'SENIOR_SECURED', 'Industrials',    20, 20.4, 1.9,  0,    10.1, 102.0, 102.0, 'S+500',       3.6, TRUE),
        (13, 'fenwick',    'Fenwick Packaging (exited)',  'SENIOR_SECURED', 'Industrials',    30,  0,   3.6, 33.9,  12.6,   0,     0,   'Repaid',      0,   TRUE)
    ) AS v(n, k, name, strategy, sector, cost_m, fv_m, income_m, realized_m, irr, mark, agent, coupon, leverage, floating);

    CREATE TEMP TABLE t_inv ON COMMIT DROP AS
    SELECT * FROM (VALUES
        ('eastbrook',  'Eastbrook Pension Plan',           'PENSION',         100, 'CURRENT',  NULL::numeric),
        ('northgate',  'Northgate Teachers'' Retirement',  'PENSION',          90, 'CURRENT',  NULL),
        ('crestline',  'Crestline Insurance Co.',          'INSURANCE',        80, 'CURRENT',  NULL),
        ('marlow',     'Marlow Family Office',             'FAMILY_OFFICE',    60, 'CURRENT',  NULL),
        ('lakeshore',  'Lakeshore Insurance',              'INSURANCE',        60, 'CURRENT',  NULL),
        ('ashford',    'Ashford Endowment',                'ENDOWMENT',        50, 'CURRENT',  NULL),
        ('sterling',   'Sterling Wealth Platform',         'FUND_OF_FUNDS',    45, 'CURRENT',  NULL),
        ('brandt',     'Brandt Holdings',                  'FAMILY_OFFICE',    40, 'PAST_DUE', 2),
        ('oakhaven',   'Oakhaven Foundation',              'FOUNDATION',       25, 'CURRENT',  NULL),
        ('pinnacle',   'Pinnacle Re',                      'INSURANCE',        20, 'CURRENT',  NULL),
        ('calder',     'Calder Family Trust',              'FAMILY_OFFICE',    15, 'CURRENT',  NULL),
        ('gp',         'GP and affiliates',                'GENERAL_PARTNER',  15, 'CURRENT',  NULL)
    ) AS v(k, name, investor_type, commit_m, status, past_due_m);

    CREATE TEMP TABLE t_act ON COMMIT DROP AS
    SELECT * FROM (VALUES
        (1,  DATE '2024-11-15', 'CAPITAL_CALL', 'Capital call 1', 100,   'FUNDED',    NULL::numeric, NULL::text),
        (2,  DATE '2025-02-14', 'CAPITAL_CALL', 'Capital call 2',  60,   'FUNDED',    NULL, NULL),
        (3,  DATE '2025-05-15', 'CAPITAL_CALL', 'Capital call 3',  45,   'FUNDED',    NULL, NULL),
        (4,  DATE '2025-08-15', 'CAPITAL_CALL', 'Capital call 4',  35,   'FUNDED',    NULL, NULL),
        (5,  DATE '2025-11-14', 'CAPITAL_CALL', 'Capital call 5',  30,   'FUNDED',    NULL, NULL),
        (6,  DATE '2026-02-13', 'CAPITAL_CALL', 'Capital call 6',  25,   'FUNDED',    NULL, NULL),
        (7,  DATE '2026-05-15', 'CAPITAL_CALL', 'Capital call 7',  35,   'FUNDED',    NULL, NULL),
        (8,  DATE '2026-08-14', 'CAPITAL_CALL', 'Capital call 8',  30,   'FUNDED',    2,    NULL),
        (9,  DATE '2026-11-16', 'CAPITAL_CALL', 'Capital call 9',  30,   'PROJECTED', NULL, 'Notice mid-Nov, due Nov 16'),
        (10, DATE '2025-06-27', 'DISTRIBUTION', 'Distribution',     2,   'PAID',      NULL, NULL),
        (11, DATE '2025-09-26', 'DISTRIBUTION', 'Distribution',     4,   'PAID',      NULL, NULL),
        (12, DATE '2025-12-19', 'DISTRIBUTION', 'Distribution',     7,   'PAID',      NULL, NULL),
        (13, DATE '2026-03-27', 'DISTRIBUTION', 'Distribution',    11,   'PAID',      NULL, NULL),
        (14, DATE '2026-06-26', 'DISTRIBUTION', 'Distribution',    18.5, 'PAID',      NULL, NULL),
        (15, DATE '2026-09-25', 'DISTRIBUTION', 'Distribution',     9.5, 'PAID',      NULL, NULL),
        (16, DATE '2026-12-18', 'DISTRIBUTION', 'Distribution',     9.5, 'SCHEDULED', NULL, NULL)
    ) AS v(n, dt, kind, label, amt_m, status, outstanding_m, notice);

    CREATE TEMP TABLE t_plan ON COMMIT DROP AS
    SELECT * FROM (VALUES
        (1,  DATE '2024-12-31', 'Q4''24', 15, 112,   NULL::numeric),
        (2,  DATE '2025-03-31', 'Q1''25', 28, 168,   NULL),
        (3,  DATE '2025-06-30', 'Q2''25', 38, 214,   NULL),
        (4,  DATE '2025-09-30', 'Q3''25', 46, 247,   NULL),
        (5,  DATE '2025-12-31', 'Q4''25', 52, 281,   NULL),
        (6,  DATE '2026-03-31', 'Q1''26', 57, 297,   NULL),
        (7,  DATE '2026-06-30', 'Q2''26', 61, 313.6, NULL),
        (8,  DATE '2026-09-30', 'Q3''26', 65, 343.8, NULL),
        (9,  DATE '2026-12-31', 'Q4''26', 69, NULL,  30),
        (10, DATE '2027-03-31', 'Q1''27', 73, NULL,  30),
        (11, DATE '2027-06-30', 'Q2''27', 77, NULL,  25),
        (12, DATE '2027-09-30', 'Q3''27', 81, NULL,  25),
        (13, DATE '2027-12-31', 'Q4''27', 85, NULL,  20),
        (14, DATE '2028-03-31', 'Q1''28', 88, NULL,  15)
    ) AS v(n, quarter_end, label, called_pct, nav_m, call_m);

    CREATE TEMP TABLE t_fc ON COMMIT DROP AS
    SELECT * FROM (VALUES
        (1, DATE '2026-12-31', 'Q4''26', 13.9, 22, -42, -5.4,  -9.5, 30, -10),
        (2, DATE '2027-03-31', 'Q1''27', 14.6, 18, -40, -5.5, -10.2, 30, -15),
        (3, DATE '2027-06-30', 'Q2''27', 15.4, 25, -35, -5.6, -11.0, 25, -10),
        (4, DATE '2027-09-30', 'Q3''27', 16.1, 20, -33, -5.7, -11.5, 25, -10)
    ) AS v(n, quarter_end, label, interest_m, repay_m, funding_m, fees_m, dist_m, call_m, paydown_m);

    CREATE TEMP TABLE t_lim ON COMMIT DROP AS
    SELECT * FROM (VALUES
        ('senior',  'STRATEGY', 'SENIOR_SECURED', 60),
        ('unit',    'STRATEGY', 'UNITRANCHE',     50),
        ('mezz',    'STRATEGY', 'MEZZANINE',      15),
        ('abf',     'STRATEGY', 'ASSET_BASED',    25)
    ) AS v(k, dimension, key, pct);

    -- Statement rows. Amounts are millions, signed the way the statement shows them.
    -- Liabilities are positive in the liability section. reviewable rows can block certification.
    CREATE TEMP TABLE t_line ON COMMIT DROP AS
    SELECT * FROM (VALUES
        ('BS-01', 'BS_ASSET',     'HEADER',   0, NULL::text, 'Assets', NULL::numeric, NULL::numeric, FALSE, FALSE),
        ('BS-02', 'BS_ASSET',     'NOTE',     0, NULL,  'Investments at fair value (cost $426.0M)', NULL, NULL, FALSE, FALSE),
        ('BS-03', 'BS_ASSET',     'DETAIL',   2, NULL,  'Senior secured', 147.8, 147.6, FALSE, FALSE),
        ('BS-04', 'BS_ASSET',     'DETAIL',   2, NULL,  'Unitranche', 149.4, 149.4, FALSE, FALSE),
        ('BS-05', 'BS_ASSET',     'DETAIL',   2, NULL,  'Mezzanine', 55.8, 55.8, FALSE, FALSE),
        ('BS-06', 'BS_ASSET',     'DETAIL',   2, NULL,  'Asset-based', 76.5, 76.5, FALSE, FALSE),
        ('BS-07', 'BS_ASSET',     'SUBTOTAL', 0, 'inv', 'Total investments at fair value', 429.5, 429.3, TRUE, TRUE),
        ('BS-08', 'BS_ASSET',     'LINE',     0, 'cash','Cash and equivalents', 21.4, 21.4, TRUE, TRUE),
        ('BS-09', 'BS_ASSET',     'LINE',     0, 'rec', 'Interest receivable', 6.1, 6.4, TRUE, TRUE),
        ('BS-10', 'BS_ASSET',     'TOTAL',    0, NULL,  'Total assets', 457.0, 457.1, FALSE, FALSE),
        ('BS-11', 'BS_LIABILITY', 'HEADER',   0, NULL,  'Liabilities', NULL, NULL, FALSE, FALSE),
        ('BS-12', 'BS_LIABILITY', 'LINE',     0, 'fac', 'Credit facility', 110.0, 110.0, TRUE, TRUE),
        ('BS-13', 'BS_LIABILITY', 'LINE',     0, 'fee', 'Accrued management fee', 1.9, 1.88, TRUE, TRUE),
        ('BS-14', 'BS_LIABILITY', 'LINE',     0, 'exp', 'Accrued expenses and interest', 1.3, 1.3, TRUE, TRUE),
        ('BS-15', 'BS_LIABILITY', 'SUBTOTAL', 0, NULL,  'Total liabilities', 113.2, 113.18, FALSE, FALSE),
        ('BS-16', 'BS_NET',       'HEADER',   0, NULL,  'Net assets', NULL, NULL, FALSE, FALSE),
        ('BS-17', 'BS_NET',       'LINE',     0, NULL,  'Capital contributions', 360.0, 360.0, FALSE, FALSE),
        ('BS-18', 'BS_NET',       'LINE',     0, NULL,  'Cumulative distributions', -52.0, -52.0, FALSE, FALSE),
        ('BS-19', 'BS_NET',       'LINE',     0, NULL,  'Accumulated net investment income and gains', 35.8, 35.92, FALSE, FALSE),
        ('BS-20', 'BS_NET',       'TOTAL',    0, NULL,  'Net assets', 343.8, 343.92, FALSE, FALSE),

        ('OP-01', 'OPS', 'HEADER',   0, NULL,   'Investment income', NULL, NULL, FALSE, FALSE),
        ('OP-02', 'OPS', 'LINE',     0, NULL,   'Cash interest income', 12.4, 12.4, FALSE, FALSE),
        ('OP-03', 'OPS', 'LINE',     0, NULL,   'PIK interest income', 0.6, 0.6, FALSE, FALSE),
        ('OP-04', 'OPS', 'LINE',     0, NULL,   'Fee and other income', 0.8, 0.8, FALSE, FALSE),
        ('OP-05', 'OPS', 'SUBTOTAL', 0, NULL,   'Total investment income', 13.8, 13.8, FALSE, FALSE),
        ('OP-06', 'OPS', 'HEADER',   0, NULL,   'Expenses', NULL, NULL, FALSE, FALSE),
        ('OP-07', 'OPS', 'LINE',     0, 'ofee', 'Management fee', 1.9, 1.88, TRUE, FALSE),
        ('OP-08', 'OPS', 'LINE',     0, NULL,   'Interest and facility fees', 3.2, 3.2, FALSE, FALSE),
        ('OP-09', 'OPS', 'LINE',     0, NULL,   'Professional and administration fees', 0.9, 0.9, FALSE, FALSE),
        ('OP-10', 'OPS', 'LINE',     0, NULL,   'Other operating expenses', 0.4, 0.4, FALSE, FALSE),
        ('OP-11', 'OPS', 'SUBTOTAL', 0, NULL,   'Total expenses', 6.4, 6.38, FALSE, FALSE),
        ('OP-12', 'OPS', 'TOTAL',    0, NULL,   'Net investment income', 7.4, 7.42, FALSE, FALSE),
        ('OP-13', 'OPS', 'HEADER',   0, NULL,   'Realized and unrealized gain (loss)', NULL, NULL, FALSE, FALSE),
        ('OP-14', 'OPS', 'LINE',     0, NULL,   'Net realized gain on investments', 3.9, 3.9, FALSE, FALSE),
        ('OP-15', 'OPS', 'LINE',     0, NULL,   'Net change in unrealized appreciation (depreciation)', -1.6, -1.6, FALSE, FALSE),
        ('OP-16', 'OPS', 'SUBTOTAL', 0, NULL,   'Net realized and unrealized gain', 2.3, 2.3, FALSE, FALSE),
        ('OP-17', 'OPS', 'TOTAL',    0, NULL,   'Net increase in net assets from operations', 9.7, 9.72, FALSE, FALSE),

        ('CH-01', 'CHANGES', 'HEADER',   0, NULL, 'Operations', NULL, NULL, FALSE, FALSE),
        ('CH-02', 'CHANGES', 'LINE',     0, NULL, 'Net investment income', 7.4, NULL, FALSE, FALSE),
        ('CH-03', 'CHANGES', 'LINE',     0, NULL, 'Net realized gain on investments', 3.9, NULL, FALSE, FALSE),
        ('CH-04', 'CHANGES', 'LINE',     0, NULL, 'Net change in unrealized appreciation (depreciation)', -1.6, NULL, FALSE, FALSE),
        ('CH-05', 'CHANGES', 'SUBTOTAL', 0, NULL, 'Net increase from operations', 9.7, NULL, FALSE, FALSE),
        ('CH-06', 'CHANGES', 'HEADER',   0, NULL, 'Capital transactions', NULL, NULL, FALSE, FALSE),
        ('CH-07', 'CHANGES', 'LINE',     0, NULL, 'Capital contributions', 30, NULL, FALSE, FALSE),
        ('CH-08', 'CHANGES', 'LINE',     0, NULL, 'Distributions to investors', -9.5, NULL, FALSE, FALSE),
        ('CH-09', 'CHANGES', 'SUBTOTAL', 0, NULL, 'Net increase from capital transactions', 20.5, NULL, FALSE, FALSE),
        ('CH-10', 'CHANGES', 'HEADER',   0, NULL, 'Net assets', NULL, NULL, FALSE, FALSE),
        ('CH-11', 'CHANGES', 'LINE',     0, NULL, 'Total increase in net assets', 30.2, NULL, FALSE, FALSE),
        ('CH-12', 'CHANGES', 'LINE',     0, NULL, 'Beginning of period', 313.6, NULL, FALSE, FALSE),
        ('CH-13', 'CHANGES', 'TOTAL',    0, NULL, 'End of period', 343.8, NULL, FALSE, FALSE),

        ('CF-01', 'CASH', 'HEADER',   0, NULL, 'Operating activities', NULL, NULL, FALSE, FALSE),
        ('CF-02', 'CASH', 'LINE',     0, NULL, 'Net increase in net assets from operations', 9.7, NULL, FALSE, FALSE),
        ('CF-03', 'CASH', 'NOTE',     0, NULL, 'Adjustments to reconcile to net cash from operations:', NULL, NULL, FALSE, FALSE),
        ('CF-04', 'CASH', 'LINE',     1, NULL, 'Net realized gain on investments', -3.9, NULL, FALSE, FALSE),
        ('CF-05', 'CASH', 'LINE',     1, NULL, 'Net change in unrealized (appreciation) depreciation', 1.6, NULL, FALSE, FALSE),
        ('CF-06', 'CASH', 'LINE',     1, NULL, 'PIK interest income', -0.6, NULL, FALSE, FALSE),
        ('CF-07', 'CASH', 'LINE',     1, NULL, 'Purchases of investments', -44.2, NULL, FALSE, FALSE),
        ('CF-08', 'CASH', 'LINE',     1, NULL, 'Proceeds from sales and repayments', 38.9, NULL, FALSE, FALSE),
        ('CF-09', 'CASH', 'LINE',     1, NULL, 'Increase in interest receivable', -0.4, NULL, FALSE, FALSE),
        ('CF-10', 'CASH', 'LINE',     1, NULL, 'Increase in accrued liabilities', 0.2, NULL, FALSE, FALSE),
        ('CF-11', 'CASH', 'SUBTOTAL', 0, NULL, 'Net cash from operating activities', 1.3, NULL, FALSE, FALSE),
        ('CF-12', 'CASH', 'HEADER',   0, NULL, 'Financing activities', NULL, NULL, FALSE, FALSE),
        ('CF-13', 'CASH', 'LINE',     0, NULL, 'Capital contributions', 30, NULL, FALSE, FALSE),
        ('CF-14', 'CASH', 'LINE',     0, NULL, 'Distributions paid', -9.5, NULL, FALSE, FALSE),
        ('CF-15', 'CASH', 'LINE',     0, NULL, 'Repayment of credit facility', -12.1, NULL, FALSE, FALSE),
        ('CF-16', 'CASH', 'SUBTOTAL', 0, NULL, 'Net cash from financing activities', 8.4, NULL, FALSE, FALSE),
        ('CF-17', 'CASH', 'HEADER',   0, NULL, 'Cash', NULL, NULL, FALSE, FALSE),
        ('CF-18', 'CASH', 'LINE',     0, NULL, 'Net increase in cash', 9.7, NULL, FALSE, FALSE),
        ('CF-19', 'CASH', 'LINE',     0, NULL, 'Beginning of period', 11.7, NULL, FALSE, FALSE),
        ('CF-20', 'CASH', 'TOTAL',    0, NULL, 'End of period', 21.4, NULL, FALSE, FALSE),

        ('RF-01', 'ROLL', 'LINE',  0, NULL, 'Beginning NAV', 313.6, NULL, FALSE, FALSE),
        ('RF-02', 'ROLL', 'LINE',  0, NULL, 'Capital contributions', 30, NULL, FALSE, FALSE),
        ('RF-03', 'ROLL', 'LINE',  0, NULL, 'Distributions', -9.5, NULL, FALSE, FALSE),
        ('RF-04', 'ROLL', 'LINE',  0, NULL, 'Net investment income', 7.4, NULL, FALSE, FALSE),
        ('RF-05', 'ROLL', 'LINE',  0, NULL, 'Realized gain (Fenwick exit)', 3.9, NULL, FALSE, FALSE),
        ('RF-06', 'ROLL', 'LINE',  0, NULL, 'Unrealized change', -1.6, NULL, FALSE, FALSE),
        ('RF-07', 'ROLL', 'TOTAL', 0, NULL, 'Ending NAV', 343.8, NULL, FALSE, FALSE)
    ) AS v(lid, section, role, indent, code, label, admin_m, shadow_m, reviewable, composition);

    CREATE TEMP TABLE t_ent (
        entity_code text, domain_code text, template_code text, entity_name text, description text
    ) ON COMMIT DROP;

    INSERT INTO t_ent VALUES
        ('HSCF2-FUND', 'FUND', 'FUND_STANDARD', 'Halyard Senior Credit Fund II', 'Direct lending fund, 2024 vintage.'),
        ('HSCF2-STMT', 'NAV_STATEMENT', 'NAV_STATEMENT_STANDARD', 'Q3 2026 NAV statement', 'Administrator package as of September 30, 2026.'),
        ('HSCF2-FAC', 'CREDIT_FACILITY', 'CREDIT_FACILITY_STANDARD', 'Credit facility', 'Subscription credit facility.');

    INSERT INTO t_ent
    SELECT 'HSCF2-INV-' || k, 'INVESTOR', 'INVESTOR_STANDARD', name, 'Investor in Halyard Senior Credit Fund II.' FROM t_inv;
    INSERT INTO t_ent
    SELECT 'HSCF2-CMT-' || k, 'INVESTOR_COMMITMENT', 'INVESTOR_COMMITMENT_STANDARD', name || ' commitment', 'Commitment to Halyard Senior Credit Fund II.' FROM t_inv;
    INSERT INTO t_ent
    SELECT 'HSCF2-ISS-' || lpad(n::text, 2, '0'), 'ISSUER', 'ISSUER_STANDARD', regexp_replace(name, ' \(exited\)$', ''), 'Borrower held by Halyard Senior Credit Fund II.' FROM t_pos;
    INSERT INTO t_ent
    SELECT 'HSCF2-SEC-' || lpad(n::text, 2, '0'), 'SECURITY', 'SECURITY_STANDARD', regexp_replace(name, ' \(exited\)$', '') || ' loan', 'Holding of Halyard Senior Credit Fund II.' FROM t_pos;
    INSERT INTO t_ent
    SELECT 'HSCF2-POS-' || lpad(n::text, 2, '0'), 'POSITION', 'POSITION_STANDARD', name, 'Booked holding of Halyard Senior Credit Fund II.' FROM t_pos;
    INSERT INTO t_ent
    SELECT 'HSCF2-ACT-' || lpad(n::text, 2, '0'), 'CAPITAL_ACTIVITY', 'CAPITAL_ACTIVITY_STANDARD', label, 'Capital activity of Halyard Senior Credit Fund II.' FROM t_act;
    INSERT INTO t_ent
    SELECT 'HSCF2-PLAN-' || lpad(n::text, 2, '0'), 'CAPITAL_PLAN', 'CAPITAL_PLAN_STANDARD', label, 'Deployment plan quarter.' FROM t_plan;
    INSERT INTO t_ent
    SELECT 'HSCF2-LINE-' || lid, 'NAV_LINE', 'NAV_LINE_STANDARD', label, 'NAV statement row.' FROM t_line;
    INSERT INTO t_ent
    SELECT 'HSCF2-FC-' || n::text, 'CASH_FORECAST', 'CASH_FORECAST_STANDARD', label, 'Cash forecast quarter.' FROM t_fc;
    INSERT INTO t_ent
    SELECT 'HSCF2-LIM-' || k, 'EXPOSURE_LIMIT', 'EXPOSURE_LIMIT_STANDARD', key || ' limit', 'Concentration limit.' FROM t_lim;

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name, e.description, v_client, '{"fundSurfaceSample":true}'::jsonb
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

    CREATE TEMP TABLE t_val (entity_code text, attribute_code text, val text) ON COMMIT DROP;

    INSERT INTO t_val
    SELECT 'HSCF2-FUND', a.attr, a.val
    FROM (VALUES
        ('NAV', '343800000'),
        ('NAV_CURRENCY', 'USD'),
        ('FUND_TYPE', 'Private Credit'),
        ('FUND_STATUS', 'Open'),
        ('FUND_CASH_BALANCE', '21400000'),
        ('FUND_UNDRAWN_COMMITMENTS', '240000000'),
        ('FUND_STRATEGY', 'DIRECT_LENDING'),
        ('FUND_VINTAGE', '2024'),
        ('FUND_REPORTING_DATE', '2026-09-30'),
        ('FUND_TOTAL_COMMITMENTS', '600000000'),
        ('FUND_COMMITMENTS_CLOSED', '2024-09-30'),
        ('FUND_INVESTMENT_PERIOD_END', '2027-12-31'),
        ('FUND_TARGET_CALLED_PCT', '90'),
        ('FUND_GROSS_IRR', '11.2'),
        ('FUND_NET_IRR', '8.7'),
        ('FUND_FEE_DRAG_PTS', '1.5'),
        ('FUND_EXPENSE_DRAG_PTS', '0.4'),
        ('FUND_CARRY_DRAG_PTS', '0.6'),
        ('FUND_UNFUNDED_BORROWER_COMMITMENTS', '38500000'),
        ('FUND_LIQUIDITY_COVERAGE_MIN', '1.25'),
        ('FUND_SECTOR_LIMIT_PCT', '25'),
        ('FUND_ISSUER_LIMIT_PCT', '15')
    ) AS a(attr, val);

    INSERT INTO t_val
    SELECT 'HSCF2-STMT', a.attr, a.val
    FROM (VALUES
        ('STATEMENT_PERIOD_END', '2026-09-30'),
        ('STATEMENT_PERIOD_LABEL', 'September 30, 2026'),
        ('STATEMENT_TOLERANCE_PCT', '0.5'),
        ('STATEMENT_CERTIFIED', 'false')
    ) AS a(attr, val);

    INSERT INTO t_val
    SELECT 'HSCF2-FAC', a.attr, a.val
    FROM (VALUES
        ('FACILITY_COMMITMENT', '150000000'),
        ('FACILITY_DRAWN', '110000000'),
        ('FACILITY_BORROWING_BASE', '141500000'),
        ('FACILITY_MATURITY', '2028-06-30')
    ) AS a(attr, val);

    INSERT INTO t_val
    SELECT 'HSCF2-INV-' || k, 'INVESTOR_TYPE', investor_type FROM t_inv;

    INSERT INTO t_val
    SELECT 'HSCF2-CMT-' || k, a.attr, a.val
    FROM t_inv i
    CROSS JOIN LATERAL (VALUES
        ('COMMITMENT_AMOUNT', (i.commit_m * 1000000)::text),
        ('COMMITMENT_STATUS', i.status),
        ('COMMITMENT_PAST_DUE', (i.past_due_m * 1000000)::text)
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    INSERT INTO t_val
    SELECT 'HSCF2-ISS-' || lpad(n::text, 2, '0'), 'SECTOR', sector FROM t_pos;

    INSERT INTO t_val
    SELECT 'HSCF2-POS-' || lpad(p.n::text, 2, '0'), a.attr, a.val
    FROM t_pos p
    CROSS JOIN LATERAL (VALUES
        ('POSITION_IS_HYPOTHETICAL', 'false'),
        ('POSITION_CURRENCY', 'USD'),
        ('POSITION_STRATEGY', p.strategy),
        ('POSITION_COST', (p.cost_m * 1000000)::text),
        ('MARKET_VALUE', (p.fv_m * 1000000)::text),
        ('POSITION_INCOME', (p.income_m * 1000000)::text),
        ('POSITION_REALIZED_GAIN', (p.realized_m * 1000000)::text),
        ('POSITION_GROSS_IRR', p.irr::text),
        ('POSITION_MARK', p.mark::text),
        ('POSITION_AGENT_MARK', p.agent::text),
        ('POSITION_COUPON', p.coupon),
        ('POSITION_LEVERAGE', p.leverage::text),
        ('POSITION_IS_FLOATING', p.floating::text),
        ('POSITION_MARK_RESOLVED', 'false')
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    INSERT INTO t_val
    SELECT 'HSCF2-ACT-' || lpad(a.n::text, 2, '0'), x.attr, x.val
    FROM t_act a
    CROSS JOIN LATERAL (VALUES
        ('ACTIVITY_DATE', a.dt::text),
        ('ACTIVITY_KIND', a.kind),
        ('ACTIVITY_AMOUNT', (a.amt_m * 1000000)::text),
        ('ACTIVITY_STATUS', a.status),
        ('ACTIVITY_OUTSTANDING', (a.outstanding_m * 1000000)::text),
        ('ACTIVITY_NOTICE', a.notice)
    ) AS x(attr, val)
    WHERE x.val IS NOT NULL;

    INSERT INTO t_val
    SELECT 'HSCF2-PLAN-' || lpad(p.n::text, 2, '0'), x.attr, x.val
    FROM t_plan p
    CROSS JOIN LATERAL (VALUES
        ('PLAN_QUARTER_END', p.quarter_end::text),
        ('PLAN_CALLED_PCT', p.called_pct::text),
        ('PLAN_NAV', (p.nav_m * 1000000)::text),
        ('PLAN_CALL_AMOUNT', (p.call_m * 1000000)::text),
        ('PLAN_ORDER', p.n::text)
    ) AS x(attr, val)
    WHERE x.val IS NOT NULL;

    INSERT INTO t_val
    SELECT 'HSCF2-LINE-' || l.lid, x.attr, x.val
    FROM (
        SELECT t.*, row_number() OVER (PARTITION BY t.section ORDER BY t.lid)::int AS ord
        FROM t_line t
    ) l
    CROSS JOIN LATERAL (VALUES
        ('NAV_LINE_CODE', l.code),
        ('NAV_LINE_STATEMENT', l.section),
        ('NAV_LINE_ROLE', l.role),
        ('NAV_LINE_INDENT', l.indent::text),
        ('NAV_LINE_ORDER', l.ord::text),
        ('NAV_LINE_ADMINISTRATOR', (l.admin_m * 1000000)::text),
        ('NAV_LINE_SHADOW', (l.shadow_m * 1000000)::text),
        ('NAV_LINE_RESOLVED', 'false'),
        ('NAV_LINE_REVIEWABLE', l.reviewable::text),
        ('NAV_LINE_IN_COMPOSITION', l.composition::text)
    ) AS x(attr, val)
    WHERE x.val IS NOT NULL;

    INSERT INTO t_val
    SELECT 'HSCF2-FC-' || f.n::text, x.attr, x.val
    FROM t_fc f
    CROSS JOIN LATERAL (VALUES
        ('FORECAST_QUARTER_END', f.quarter_end::text),
        ('FORECAST_ORDER', f.n::text),
        ('FORECAST_INTEREST', (f.interest_m * 1000000)::text),
        ('FORECAST_REPAYMENTS', (f.repay_m * 1000000)::text),
        ('FORECAST_NEW_FUNDINGS', (f.funding_m * 1000000)::text),
        ('FORECAST_FEES', (f.fees_m * 1000000)::text),
        ('FORECAST_DISTRIBUTIONS', (f.dist_m * 1000000)::text),
        ('FORECAST_CAPITAL_CALLS', (f.call_m * 1000000)::text),
        ('FORECAST_FACILITY_PAYDOWN', (f.paydown_m * 1000000)::text)
    ) AS x(attr, val);

    INSERT INTO t_val
    SELECT 'HSCF2-LIM-' || k, x.attr, x.val
    FROM t_lim
    CROSS JOIN LATERAL (VALUES
        ('LIMIT_DIMENSION', dimension),
        ('LIMIT_KEY', key),
        ('LIMIT_PCT', pct::text)
    ) AS x(attr, val);

    DELETE FROM golden_master.entity_attribute_values eav
    USING entity_instances.master_entities me
    WHERE eav.entity_id = me.id
      AND me.entity_code LIKE 'HSCF2-%';

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_src, v.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') AND v.val ~ '^-?[0-9]+(\.[0-9]+)?$' THEN v.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' AND v.val ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN v.val::date END,
           CASE WHEN ar.data_type = 'BOOLEAN' THEN v.val::boolean END,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"fundSurfaceSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    CREATE TEMP TABLE t_rel (parent_code text, child_code text, rel_code text) ON COMMIT DROP;

    INSERT INTO t_rel
    SELECT 'HSCF2-CMT-' || k, 'HSCF2-INV-' || k, 'COMMITMENT_INVESTOR' FROM t_inv;
    INSERT INTO t_rel
    SELECT 'HSCF2-CMT-' || k, 'HSCF2-FUND', 'COMMITMENT_FUND' FROM t_inv;
    INSERT INTO t_rel
    SELECT 'HSCF2-ACT-' || lpad(n::text, 2, '0'), 'HSCF2-FUND', 'ACTIVITY_FUND' FROM t_act;
    INSERT INTO t_rel SELECT 'HSCF2-STMT', 'HSCF2-FUND', 'STATEMENT_FUND';
    INSERT INTO t_rel
    SELECT 'HSCF2-LINE-' || lid, 'HSCF2-STMT', 'LINE_STATEMENT' FROM t_line;
    INSERT INTO t_rel
    SELECT 'HSCF2-PLAN-' || lpad(n::text, 2, '0'), 'HSCF2-FUND', 'PLAN_FUND' FROM t_plan;
    INSERT INTO t_rel SELECT 'HSCF2-FAC', 'HSCF2-FUND', 'FACILITY_FUND';
    INSERT INTO t_rel
    SELECT 'HSCF2-FC-' || n::text, 'HSCF2-FUND', 'FORECAST_FUND' FROM t_fc;
    INSERT INTO t_rel
    SELECT 'HSCF2-LIM-' || k, 'HSCF2-FUND', 'LIMIT_FUND' FROM t_lim;
    INSERT INTO t_rel
    SELECT x.parent, x.child, x.rel
    FROM t_pos p
    CROSS JOIN LATERAL (VALUES
        ('HSCF2-POS-' || lpad(p.n::text, 2, '0'), 'HSCF2-FUND', 'POSITION_FUND'),
        ('HSCF2-POS-' || lpad(p.n::text, 2, '0'), 'HSCF2-SEC-' || lpad(p.n::text, 2, '0'), 'POSITION_SECURITY'),
        ('HSCF2-SEC-' || lpad(p.n::text, 2, '0'), 'HSCF2-ISS-' || lpad(p.n::text, 2, '0'), 'SECURITY_ISSUER')
    ) AS x(parent, child, rel);

    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from, metadata
    )
    SELECT DISTINCT p.id, c.id, rt.relationship_name, r.rel_code, TRUE, DATE '2020-01-01', '{"fundSurfaceSample":true}'::jsonb
    FROM t_rel r
    JOIN entity_instances.master_entities p ON p.entity_code = r.parent_code
    JOIN entity_instances.master_entities c ON c.entity_code = r.child_code
    JOIN metadata_register.relationship_types rt ON rt.relationship_code = r.rel_code
    ON CONFLICT (parent_entity_id, child_entity_id, relationship_code, valid_from) DO NOTHING;
END $$;

NOTIFY pgrst, 'reload schema';
