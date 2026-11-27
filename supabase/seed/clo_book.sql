-- CLO book: sample CLO vehicles with quarterly history, and a loan market to improve them.
-- Read by the CLO surface (surfaces/clo) through cloBook (packages/graphql/src/lib/clo-book.ts).
-- Safe to run again: values are rewritten, records and links are kept.
--
-- What it writes, all in the client that owns the CLO rule-library sample (CLOS-FUND):
--   * the reference list CLO_MARKET_STATUS (the Moody's diversity table and the diversity test
--     are library records: supabase/seed/clo_diversity_rule.sql)
--   * attributes on the global CLO model:
--       CLO_TRANSACTION  CLO_COLLATERAL_MANAGER, CLO_TRUSTEE, CLO_SENIOR_MGMT_FEE_BPS,
--                        CLO_SUB_MGMT_FEE_BPS, CLO_BENCHMARK_RATE_PCT
--       SECURITY         CLO_MARKET_STATUS, CLO_OFFER_PRICE, CLO_OFFER_SIZE
--   * four CLO funds (codes CLOB-<deal>-*), each with its indenture terms (CLO_TRANSACTION),
--     six note classes, four trustee accounts and 48 to 62 holdings
--   * a shared pool of 70 obligors (CLOB-ISS-001..070), each with one term loan (CLOB-SEC-*),
--     held across the four CLOs
--   * a loan market of 30 more obligors (CLOB-ISS-071..100) whose loans are offered and held
--     by none of the CLOs (CLO_MARKET_STATUS = OFFERED). The surface ranks them by how much
--     each improves a CLO, scored by the compliance engine's pro forma.
--
-- History. Values change at each quarter end from 2024-12-31 to 2026-09-30, so the compliance
-- engine scored at any of those dates gives that quarter's tests:
--   * ratings migrate (a few names downgrade into CCC, one defaults in 2026, a few upgrade)
--   * prices move with ratings and with a mid-2025 sell-off
--   * a repricing wave cuts 25 bps off a quarter of the loans from 2026
--   * the benchmark rate falls, so interest collections and note interest fall with it
--   * Lakeshore CLO 2019-1 is past its reinvestment period: its loans prepay and Class A
--     pays down each quarter
--   * Harborview CLO 2021-2 holds more of the names that migrate, so its CCC bucket and junior
--     OC cushions erode and its Class E note is downgraded
--   * reinvesting deals buy a few names during the period and sell a few in 2026
--
-- Every value is written by the INTERNAL source with metadata cloBookSample = true. To remove
-- the sample, delete the CLOB-* records of that client (their values and links go with them).

DO $$
DECLARE
    v_client uuid;
    v_src uuid;
    q date[] := ARRAY[DATE '2024-12-31', DATE '2025-03-31', DATE '2025-06-30', DATE '2025-09-30',
                      DATE '2025-12-31', DATE '2026-03-31', DATE '2026-06-30', DATE '2026-09-30'];
    -- Three-month benchmark rate, percent, in force in each quarter.
    sofr numeric[] := ARRAY[4.49, 4.31, 4.32, 4.24, 3.95, 3.72, 3.66, 3.48];
BEGIN
    SELECT client_id INTO v_client FROM entity_instances.master_entities WHERE entity_code = 'CLOS-FUND' ORDER BY created_at LIMIT 1;
    IF v_client IS NULL THEN
        SELECT id INTO v_client FROM tenancy.clients ORDER BY created_at LIMIT 1;
    END IF;
    SELECT id INTO v_src FROM entity_instances.source_registry WHERE source_code = 'INTERNAL' ORDER BY precedence_rank LIMIT 1;
    IF v_client IS NULL OR v_src IS NULL THEN
        RAISE NOTICE 'Skipping the CLO book seed: client % source %', v_client, v_src;
        RETURN;
    END IF;

    -- ------------------------------------------------------------------
    -- Reference lists
    -- ------------------------------------------------------------------
    INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description)
    VALUES
        ('CLO_MARKET_STATUS', 'CLO Market Status', 'SECURITY', 'Where a loan stands in the market for the CLO desk: offered to buy, allocated, or withdrawn.')
    ON CONFLICT (list_code) DO UPDATE SET list_name = EXCLUDED.list_name, description = EXCLUDED.description;

    INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms, metadata)
    SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb, v.meta::jsonb
    FROM metadata_register.reference_lists rl
    JOIN (VALUES
        ('CLO_MARKET_STATUS', 'OFFERED', 'Offered', 1, '{}'),
        ('CLO_MARKET_STATUS', 'ALLOCATED', 'Allocated', 2, '{}'),
        ('CLO_MARKET_STATUS', 'WITHDRAWN', 'Withdrawn', 3, '{}')
    ) AS v(list_code, code, label, ord, meta) ON v.list_code = rl.list_code
    ON CONFLICT (list_id, value_code) DO UPDATE SET value_label = EXCLUDED.value_label, display_order = EXCLUDED.display_order, metadata = EXCLUDED.metadata;

    -- ------------------------------------------------------------------
    -- Attributes (global, like the rest of the CLO model)
    -- ------------------------------------------------------------------
    INSERT INTO metadata_register.attribute_register (
        attribute_code, attribute_name, data_type, description, domain_code, reference_list_code,
        is_multi_valued, is_required, default_precedence_rank, display_section, display_group,
        is_editable, is_visible, is_time_varying, time_dimension)
    SELECT v.code, v.name, v.dtype, v.descr, v.dom, v.list, FALSE, FALSE, 100, v.section, v.grp, TRUE, TRUE,
           v.tv, CASE WHEN v.tv THEN 'VALID_TIME' ELSE 'NONE' END
    FROM (VALUES
        ('CLO_COLLATERAL_MANAGER', 'Collateral Manager', 'STRING', 'Firm that manages the CLO portfolio under the collateral management agreement', 'CLO_TRANSACTION', NULL, 'Parties', 50, FALSE),
        ('CLO_TRUSTEE', 'Trustee', 'STRING', 'Trustee and collateral administrator of the CLO', 'CLO_TRANSACTION', NULL, 'Parties', 51, FALSE),
        ('CLO_SENIOR_MGMT_FEE_BPS', 'Senior Management Fee (bps)', 'DECIMAL', 'Senior collateral management fee, bps a year on collateral par. Paid in the interest waterfall after senior expenses.', 'CLO_TRANSACTION', NULL, 'Fees', 60, FALSE),
        ('CLO_SUB_MGMT_FEE_BPS', 'Subordinated Management Fee (bps)', 'DECIMAL', 'Subordinated collateral management fee, bps a year on collateral par. Paid after every note class and coverage test cure.', 'CLO_TRANSACTION', NULL, 'Fees', 61, FALSE),
        ('CLO_BENCHMARK_RATE_PCT', 'Benchmark Rate', 'PERCENTAGE', 'Benchmark rate (three-month term SOFR) set for the current interest period, in percent', 'CLO_TRANSACTION', NULL, 'Dates', 10, TRUE),
        ('CLO_MARKET_STATUS', 'Market Status', 'STRING', 'Where the loan stands in the market for the CLO desk', 'SECURITY', 'CLO_MARKET_STATUS', 'CLO Market', 140, TRUE),
        ('CLO_OFFER_PRICE', 'Offer Price', 'DECIMAL', 'Price the loan is offered at, per 100 of par', 'SECURITY', NULL, 'CLO Market', 141, TRUE),
        ('CLO_OFFER_SIZE', 'Offer Size', 'CURRENCY', 'Par available to buy', 'SECURITY', NULL, 'CLO Market', 142, TRUE)
    ) AS v(code, name, dtype, descr, dom, list, section, grp, tv)
    ON CONFLICT (attribute_code) DO UPDATE SET attribute_name = EXCLUDED.attribute_name, description = EXCLUDED.description,
        display_section = EXCLUDED.display_section, is_time_varying = EXCLUDED.is_time_varying, time_dimension = EXCLUDED.time_dimension;

    INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, precedence_rank, display_order)
    SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
    FROM metadata_register.attribute_register a
    JOIN metadata_register.domain_templates t ON t.template_code = a.domain_code || '_STANDARD'
    WHERE a.attribute_code IN ('CLO_COLLATERAL_MANAGER', 'CLO_TRUSTEE', 'CLO_SENIOR_MGMT_FEE_BPS', 'CLO_SUB_MGMT_FEE_BPS',
                               'CLO_BENCHMARK_RATE_PCT', 'CLO_MARKET_STATUS', 'CLO_OFFER_PRICE', 'CLO_OFFER_SIZE')
    ON CONFLICT (template_id, attribute_id) DO NOTHING;

    -- ------------------------------------------------------------------
    -- Quarters: slice k (1..8) is in force from the day after quarter k-1 ends through quarter k.
    -- The first slice reaches back, the last runs on.
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE t_q ON COMMIT DROP AS
    SELECT k, q[k] AS qend, sofr[k] AS sofr,
           CASE WHEN k = 1 THEN DATE '2020-01-01' ELSE q[k - 1] + 1 END AS vfrom,
           CASE WHEN k = 8 THEN DATE '9999-12-31' ELSE q[k] END AS vto
    FROM generate_series(1, 8) AS k;

    -- ------------------------------------------------------------------
    -- The deals
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE t_clo (
        c int, tag text, name text, manager text, trustee text,
        closing date, effective date, rp_end date, nc_end date, maturity date, next_det date, next_pay date,
        target numeric, n_hold int, off int, stressed boolean, amortizing boolean, reinvesting boolean,
        max_warf numeric, min_was numeric, min_warr numeric, max_wal numeric, min_div numeric,
        fee_sr numeric, fee_sub numeric, oc_e numeric
    ) ON COMMIT DROP;
    INSERT INTO t_clo VALUES
        (1, 'GP', 'Granite Peak CLO 2023-1', 'Granite Peak Credit Partners', 'Atlantic Trust Company',
         '2023-06-15', '2023-12-15', '2028-07-15', '2025-07-15', '2036-07-15', '2027-01-08', '2027-01-15',
         450000000, 52, 0, FALSE, FALSE, TRUE, 3100, 340, 44, 6.5, 30, 15, 30, 104.8),
        (2, 'HV', 'Harborview CLO 2021-2', 'Harborview Asset Management', 'Keystone Bank Trust',
         '2021-08-20', '2022-02-20', '2026-07-20', '2023-08-20', '2034-07-20', '2027-01-13', '2027-01-20',
         400000000, 48, 23, TRUE, FALSE, TRUE, 3000, 345, 44, 5.0, 32, 15, 25, 108.9),
        (3, 'SR', 'Summit Ridge CLO 2024-1', 'Summit Ridge Capital', 'Atlantic Trust Company',
         '2024-05-10', '2024-11-10', '2029-04-20', '2026-04-20', '2037-04-20', '2027-01-13', '2027-01-20',
         500000000, 56, 41, FALSE, FALSE, TRUE, 3150, 330, 44, 7.0, 31, 15, 35, 104.5),
        (4, 'LS', 'Lakeshore CLO 2019-1', 'Lakeshore Loan Advisors', 'Keystone Bank Trust',
         '2019-04-11', '2019-10-11', '2023-04-15', '2021-04-15', '2032-04-15', '2027-01-08', '2027-01-15',
         350000000, 50, 57, FALSE, TRUE, FALSE, 3050, 350, 44, 4.75, 28, 15, 25, 104.8);

    -- ------------------------------------------------------------------
    -- Obligors and loans: 1..70 are the held pool, 71..100 the loan market
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE t_sec ON COMMIT DROP AS
    WITH base AS (
        SELECT s, lpad(s::text, 3, '0') AS k, s > 70 AS offered,
               (ARRAY['Abelard', 'Brightwater', 'Calloway', 'Dunmore', 'Eastline', 'Fairhaven', 'Glenrock', 'Halstead',
                      'Ironbridge', 'Juniper Vale', 'Kestrel', 'Larchmont', 'Millbrook', 'Northgate', 'Oakhurst', 'Pinecrest',
                      'Quillon', 'Redfern', 'Stonehaven', 'Tidewater', 'Upland', 'Vantage Hill', 'Westbury', 'Yarrow', 'Zephyr Point'])[(s % 25) + 1]
               || ' ' || (ARRAY['Holdings', 'Group', 'Industries', 'Partners'])[((s - 1) / 25) + 1] AS obligor
        FROM generate_series(1, 100) AS s
    )
    SELECT b.*,
           (ARRAY['Healthcare & Pharmaceuticals', 'High Tech Industries', 'Services: Business', 'Chemicals, Plastics & Rubber',
                  'Banking, Finance, Insurance & Real Estate', 'Telecommunications', 'Capital Equipment', 'Aerospace & Defense',
                  'Retail', 'Media: Broadcasting & Subscription', 'Hotel, Gaming & Leisure', 'Construction & Building',
                  'Containers, Packaging & Glass', 'Automotive', 'Services: Consumer', 'Consumer Goods: Durable',
                  'Beverage, Food & Tobacco', 'Transportation: Cargo', 'Media: Advertising, Printing & Publishing', 'Energy: Oil & Gas',
                  'Utilities: Electric', 'Environmental Industries', 'Forest Products & Paper', 'Metals & Mining', 'Wholesale',
                  'Consumer Goods: Non-Durable'])[
               CASE WHEN NOT b.offered THEN
                        CASE WHEN b.s % 20 = 0 THEN 1 ELSE ((b.s * 7) % 20) + 1 END
                    WHEN b.s % 3 = 0 THEN 21 + (b.s % 6)
                    ELSE ((b.s * 3) % 20) + 1 END] AS industry,
           CASE WHEN b.offered THEN (ARRAY[12, 13, 14, 14, 15, 15, 13, 14])[(b.s % 8) + 1]
                WHEN b.s % 23 = 0 THEN 17
                ELSE (ARRAY[13, 14, 14, 15, 15, 15, 15, 16, 16, 14, 13, 15])[(b.s % 12) + 1] END AS base_ord,
           CASE WHEN b.offered THEN 325 + (b.s % 7) * 30 ELSE 300 + (b.s % 9) * 25 END AS spread0,
           CASE WHEN b.offered THEN DATE '2030-06-30' + ((b.s * 53) % 900) ELSE DATE '2027-06-30' + ((b.s * 37) % 1460) END AS maturity,
           (b.s % 14 = 0) AS second_lien,
           (b.s % 5 IN (1, 2)) AS cov_lite,
           (b.s % 25 = 0) AS fixed_rate,
           (NOT b.offered AND b.s % 17 = 0) AS discount,
           CASE WHEN b.s = 40 THEN 'CLOB-OG-010' ELSE 'CLOB-OG-' || b.k END AS obligor_group,
           CASE WHEN b.s % 31 = 0 THEN 'GB' ELSE 'US' END AS country,
           CASE WHEN b.offered THEN round(97.50 + (b.s % 6) * 0.5, 2) END AS offer_price,
           CASE WHEN b.offered THEN (2 + (b.s % 5) * 2) * 1000000 END AS offer_size
    FROM base b;

    -- Rating, price and spread of each loan in each quarter. The pool migrates; the market is quoted as it stands now.
    CREATE TEMP TABLE t_secq ON COMMIT DROP AS
    WITH r AS (
        SELECT s.s, s.k AS sk, t.k, t.sofr,
               LEAST(20, GREATEST(11, s.base_ord
                   + CASE WHEN NOT s.offered AND s.s % 9 = 0 AND t.k >= (s.s % 5) + 3 THEN 1 ELSE 0 END
                   + CASE WHEN NOT s.offered AND s.s % 18 = 0 AND t.k >= 6 THEN 1 ELSE 0 END
                   + CASE WHEN NOT s.offered AND s.s % 13 = 0 AND t.k >= 5 THEN 2 ELSE 0 END
                   + CASE WHEN NOT s.offered AND s.s % 23 = 0 AND t.k >= 7 THEN 3 ELSE 0 END
                   - CASE WHEN NOT s.offered AND s.s % 11 = 0 AND t.k >= 4 THEN 1 ELSE 0 END)) AS ord,
               s.spread0 - CASE WHEN NOT s.offered AND s.s % 4 = 0 AND t.k >= 6 THEN 25 ELSE 0 END AS spread,
               s.second_lien, s.fixed_rate
        FROM t_sec s CROSS JOIN t_q t
    )
    SELECT r.*,
           (r.ord >= 20) AS defaulted,
           (r.ord >= 17) AS ccc,
           mo.value_code AS moodys,
           sp.value_code AS sp,
           (mo.metadata ->> 'rating_factor')::numeric AS factor,
           CASE WHEN r.ord >= 20 THEN 38 + (r.s % 5)
                ELSE round(99.75 - GREATEST(r.ord - 14, 0) * 1.5
                           - CASE WHEN r.ord >= 17 THEN 16 ELSE 0 END
                           - CASE WHEN r.second_lien THEN 3 ELSE 0 END
                           - ((r.k * 5 + r.s) % 7) * 0.15
                           - CASE WHEN r.k = 3 THEN 1.25 ELSE 0 END, 2) END AS price
    FROM r
    JOIN metadata_register.reference_lists ml ON ml.list_code = 'MOODYS_RATING_SCALE'
    JOIN metadata_register.reference_list_values mo ON mo.list_id = ml.id AND (mo.metadata ->> 'ordinal')::int = r.ord
    JOIN metadata_register.reference_lists sl ON sl.list_code = 'SP_RATING_SCALE'
    JOIN metadata_register.reference_list_values sp ON sp.list_id = sl.id AND (sp.metadata ->> 'ordinal')::int = r.ord;

    -- ------------------------------------------------------------------
    -- Holdings: which loans each deal holds, from when, and at what par
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE t_hold ON COMMIT DROP AS
    WITH ranked AS (
        SELECT c.c, c.tag, c.target, c.n_hold, c.reinvesting, c.amortizing, s.s, s.k AS sk, s.discount,
               CASE WHEN c.stressed AND (s.s % 9 = 0 OR s.s % 13 = 0 OR s.s % 23 = 0) THEN -1
                    ELSE (s.s * 3 + c.off) % 70 END AS rnk
        FROM t_clo c CROSS JOIN t_sec s
        WHERE NOT s.offered
    ), timed AS (
        -- Reinvesting deals buy the last few names during the period and sell a few in 2026.
        SELECT r.*,
               CASE WHEN r.reinvesting AND r.rnk BETWEEN r.n_hold - 4 AND r.n_hold - 1 THEN (r.s % 6) + 2 ELSE 1 END AS first_k,
               CASE WHEN r.reinvesting AND r.rnk BETWEEN 0 AND 2 THEN 6 ELSE 8 END AS last_k
        FROM ranked r
        WHERE r.rnk < r.n_hold
    )
    -- The opening book is sized to the deal's target par; each name is 0.8x to 1.15x the average.
    SELECT t.*,
           t.tag || '-POS-' || t.sk AS pos_code,
           round(t.target / COUNT(*) FILTER (WHERE t.first_k = 1) OVER (PARTITION BY t.c)
                 * (0.8 + ((t.s * 5 + t.c) % 6) * 0.07) / 250000) * 250000 AS par0
    FROM timed t;

    CREATE TEMP TABLE t_holdq ON COMMIT DROP AS
    SELECT h.c, h.tag, h.s, h.sk, h.pos_code, h.discount, t.k, t.sofr,
           CASE WHEN h.amortizing THEN round(h.par0 * power(0.955, t.k - 1) / 1000) * 1000 ELSE h.par0 END AS par,
           sq.price, sq.spread, sq.defaulted, sq.fixed_rate, sq.ord
    FROM t_hold h
    JOIN t_q t ON t.k BETWEEN h.first_k AND h.last_k
    JOIN t_secq sq ON sq.s = h.s AND sq.k = t.k;

    -- ------------------------------------------------------------------
    -- Records
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE t_ent (entity_code text, domain_code text, template_code text, entity_name text, description text) ON COMMIT DROP;
    INSERT INTO t_ent
    SELECT 'CLOB-' || tag || '-FUND', 'FUND', 'FUND_STANDARD', name, 'Sample CLO managed by ' || manager || '.' FROM t_clo
    UNION ALL SELECT 'CLOB-' || tag || '-TXN', 'CLO_TRANSACTION', 'CLO_TRANSACTION_STANDARD', name || ' indenture terms', 'Indenture terms and test parameters.' FROM t_clo
    UNION ALL SELECT 'CLOB-' || tag || '-ACCT-' || a.code, 'CLO_ACCOUNT', 'CLO_ACCOUNT_STANDARD', a.label, 'Trustee account of ' || c.name || '.'
        FROM t_clo c CROSS JOIN (VALUES ('PRIN', 'Principal collection account'), ('INT', 'Interest collection account'),
                                        ('EXP', 'Expense reserve account'), ('RAMP', 'Ramp-up account')) AS a(code, label)
    UNION ALL SELECT 'CLOB-' || tag || '-NOTE-' || n.cls, 'CLO_NOTE_CLASS', 'CLO_NOTE_CLASS_STANDARD', n.label, 'Note class of ' || c.name || '.'
        FROM t_clo c CROSS JOIN (VALUES ('A', 'Class A Senior Secured Floating Rate Notes'), ('B', 'Class B Senior Secured Floating Rate Notes'),
                                        ('C', 'Class C Secured Deferrable Floating Rate Notes'), ('D', 'Class D Secured Deferrable Floating Rate Notes'),
                                        ('E', 'Class E Secured Deferrable Floating Rate Notes'), ('SUB', 'Subordinated Notes')) AS n(cls, label)
    UNION ALL SELECT 'CLOB-ISS-' || k, 'ISSUER', 'ISSUER_STANDARD', obligor, 'Sample leveraged loan obligor.' FROM t_sec
    UNION ALL SELECT 'CLOB-SEC-' || k, 'SECURITY', 'SECURITY_STANDARD', obligor || ' Term Loan B',
              CASE WHEN offered THEN 'Leveraged loan offered in the market. Held by none of the sample CLOs.' ELSE 'Leveraged loan held across the sample CLOs.' END
        FROM t_sec
    UNION ALL SELECT 'CLOB-' || h.pos_code, 'POSITION', 'POSITION_STANDARD', c.name || ' holding: ' || s.obligor, 'Sample CLO holding.'
        FROM t_hold h JOIN t_clo c ON c.c = h.c JOIN t_sec s ON s.s = h.s;

    -- A rerun can change which loans a deal holds and when. This seed's holding links are
    -- rebuilt each run, and a holding no longer in the book is removed with its values.
    DELETE FROM entity_instances.entity_relationships rel
    USING entity_instances.master_entities pos
    WHERE rel.parent_entity_id = pos.id AND pos.client_id = v_client AND pos.domain_code = 'POSITION'
      AND pos.entity_code LIKE 'CLOB-%' AND rel.relationship_code IN ('POSITION_FUND', 'POSITION_SECURITY');
    CREATE TEMP TABLE t_gone ON COMMIT DROP AS
    SELECT pos.id FROM entity_instances.master_entities pos
    WHERE pos.client_id = v_client AND pos.domain_code = 'POSITION' AND pos.entity_code LIKE 'CLOB-%'
      AND NOT EXISTS (SELECT 1 FROM t_ent t WHERE t.entity_code = pos.entity_code);
    DELETE FROM golden_master.entity_attribute_values WHERE entity_id IN (SELECT id FROM t_gone);
    DELETE FROM entity_instances.master_entities WHERE id IN (SELECT id FROM t_gone);

    INSERT INTO entity_instances.master_entities (entity_code, domain_code, template_id, entity_name, description, client_id, is_active, metadata)
    SELECT t.entity_code, t.domain_code, dt.id, t.entity_name, t.description, v_client, TRUE, '{"cloBookSample": true}'::jsonb
    FROM t_ent t LEFT JOIN metadata_register.domain_templates dt ON dt.template_code = t.template_code
    ON CONFLICT (client_id, entity_code) DO UPDATE SET entity_name = EXCLUDED.entity_name, description = EXCLUDED.description,
        template_id = COALESCE(EXCLUDED.template_id, master_entities.template_id), is_active = TRUE, updated_at = now();

    -- ------------------------------------------------------------------
    -- Values. k is the quarter a value holds for; NULL means it holds throughout.
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE t_val (entity_code text, attribute_code text, k int, val text) ON COMMIT DROP;

    -- funds
    INSERT INTO t_val SELECT 'CLOB-' || tag || '-FUND', a.attr, NULL, a.val
    FROM t_clo CROSS JOIN LATERAL (VALUES ('FUND_TYPE', 'CLO'), ('NAV_CURRENCY', 'USD')) AS a(attr, val);

    -- indenture terms
    INSERT INTO t_val SELECT 'CLOB-' || c.tag || '-TXN', a.attr, NULL, a.val
    FROM t_clo c CROSS JOIN LATERAL (VALUES
        ('CLO_CLOSING_DATE', c.closing::text), ('CLO_EFFECTIVE_DATE', c.effective::text),
        ('CLO_REINVESTMENT_PERIOD_END', c.rp_end::text), ('CLO_NON_CALL_END', c.nc_end::text),
        ('CLO_STATED_MATURITY', c.maturity::text), ('CLO_NEXT_DETERMINATION_DATE', c.next_det::text),
        ('CLO_NEXT_PAYMENT_DATE', c.next_pay::text), ('CLO_PAYMENT_FREQUENCY', 'Quarterly'),
        ('CLO_BENCHMARK_FALLBACK', 'Daily simple SOFR plus the ISDA spread adjustment'),
        ('CLO_TARGET_INITIAL_PAR', c.target::text), ('CLO_PERMITTED_JURISDICTIONS', 'US, CA, GB'),
        ('CLO_COLLATERAL_MANAGER', c.manager), ('CLO_TRUSTEE', c.trustee),
        ('CLO_SENIOR_MGMT_FEE_BPS', c.fee_sr::text), ('CLO_SUB_MGMT_FEE_BPS', c.fee_sub::text),
        ('CLO_MAX_SINGLE_OBLIGOR_PCT', '2.5'), ('CLO_MAX_CCC_PCT', '7.5'), ('CLO_MAX_COV_LITE_PCT', '60'),
        ('CLO_MAX_SECOND_LIEN_PCT', '10'), ('CLO_MAX_FIXED_RATE_PCT', '5'), ('CLO_MAX_DISCOUNT_PCT', '10'),
        ('CLO_MAX_NON_USD_PCT', '5'), ('CLO_MAX_DELAYED_DRAW_REVOLVER_PCT', '5'), ('CLO_MAX_PARTICIPATION_PCT', '5'),
        ('CLO_MAX_DEFERRING_PCT', '5'), ('CLO_MAX_WARF', c.max_warf::text), ('CLO_MIN_WAS_BPS', c.min_was::text),
        ('CLO_MIN_WARR', c.min_warr::text), ('CLO_MIN_DIVERSITY_SCORE', c.min_div::text)
    ) AS a(attr, val);
    -- WAL limit steps down a quarter-year each year; senior expenses and the benchmark move each quarter.
    INSERT INTO t_val SELECT 'CLOB-' || c.tag || '-TXN', a.attr, t.k, a.val
    FROM t_clo c CROSS JOIN t_q t CROSS JOIN LATERAL (VALUES
        ('CLO_MAX_WAL_YEARS', round(c.max_wal - 0.25 * floor((t.k - 1) / 4.0), 2)::text),
        ('CLO_SENIOR_EXPENSES', round(c.target * 0.00025 * (1 + (t.k % 3) * 0.04))::text),
        ('CLO_BENCHMARK_RATE_PCT', t.sofr::text)
    ) AS a(attr, val);

    -- obligors
    INSERT INTO t_val SELECT 'CLOB-ISS-' || s.k, a.attr, NULL, a.val
    FROM t_sec s CROSS JOIN LATERAL (VALUES
        ('ISSUER_LEGAL_NAME', s.obligor || ' LLC'), ('MOODYS_INDUSTRY_CODE', s.industry), ('SECTOR', s.industry),
        ('OBLIGOR_GROUP_ID', s.obligor_group), ('COUNTRY_OF_DOMICILE', s.country), ('COUNTRY_OF_RISK', s.country)
    ) AS a(attr, val);
    INSERT INTO t_val SELECT 'CLOB-ISS-' || sq.sk, 'MOODYS_ISSUER_RATING', sq.k, sq.moodys FROM t_secq sq;

    -- loans: terms that hold throughout
    INSERT INTO t_val SELECT 'CLOB-SEC-' || s.k, a.attr, NULL, a.val
    FROM t_sec s CROSS JOIN LATERAL (VALUES
        ('CLO_LOAN_TYPE', CASE WHEN s.second_lien THEN 'SECOND_LIEN' ELSE 'SENIOR_SECURED' END),
        ('LIEN_PRIORITY', CASE WHEN s.second_lien THEN 'SECOND_LIEN' ELSE 'FIRST_LIEN' END),
        ('IS_COV_LITE', s.cov_lite::text), ('IS_FIXED_RATE', s.fixed_rate::text),
        ('IS_REVOLVER', 'false'), ('IS_DELAYED_DRAW', 'false'), ('IS_PARTICIPATION', 'false'),
        ('IS_CONVERTIBLE', 'false'), ('IS_BRIDGE', 'false'), ('IS_STRUCTURED_FINANCE', 'false'),
        ('IS_DEFERRING_INTEREST', 'false'), ('IS_DIP', 'false'),
        ('MATURITY_DATE', s.maturity::text), ('DENOMINATION_CURRENCY', 'USD'),
        ('CLO_MOODYS_RECOVERY_RATE', CASE WHEN s.second_lien THEN '22' ELSE (45 + (s.s % 3) * 2.5)::text END),
        ('CLO_SP_RECOVERY_RATE', CASE WHEN s.second_lien THEN '20' ELSE (50 + (s.s % 3) * 2.5)::text END)
    ) AS a(attr, val);
    -- loans: ratings, spread and default status by quarter
    INSERT INTO t_val SELECT 'CLOB-SEC-' || sq.sk, a.attr, sq.k, a.val
    FROM t_secq sq CROSS JOIN LATERAL (VALUES
        ('CLO_MOODYS_FACILITY_RATING', sq.moodys), ('CLO_MOODYS_CFR', sq.moodys),
        ('CLO_MOODYS_RATING_FACTOR', sq.factor::text), ('CLO_MOODYS_RATING_ORDINAL', sq.ord::text),
        ('CLO_SP_FACILITY_RATING', sq.sp), ('CLO_SP_RATING_ORDINAL', sq.ord::text),
        ('CLO_IS_CCC', sq.ccc::text), ('IS_DEFAULTED', sq.defaulted::text),
        ('SPREAD_BPS', CASE WHEN sq.fixed_rate THEN '0' ELSE sq.spread::text END),
        ('CLO_RATING_OUTLOOK', CASE WHEN sq.ord >= 16 THEN 'NEGATIVE' WHEN sq.ord <= 13 THEN 'POSITIVE' ELSE 'STABLE' END)
    ) AS a(attr, val);
    INSERT INTO t_val
    SELECT 'CLOB-SEC-' || sq.sk, 'DEFAULT_DATE', NULL, MIN(sq.k_end)::text
    FROM (SELECT x.sk, t.qend AS k_end FROM t_secq x JOIN t_q t ON t.k = x.k WHERE x.defaulted) sq
    GROUP BY sq.sk;
    -- the market
    INSERT INTO t_val SELECT 'CLOB-SEC-' || s.k, a.attr, NULL, a.val
    FROM t_sec s CROSS JOIN LATERAL (VALUES
        ('CLO_MARKET_STATUS', 'OFFERED'), ('CLO_OFFER_PRICE', s.offer_price::text), ('CLO_OFFER_SIZE', s.offer_size::text)
    ) AS a(attr, val)
    WHERE s.offered;

    -- holdings
    INSERT INTO t_val SELECT 'CLOB-' || h.pos_code, a.attr, NULL, a.val
    FROM t_hold h JOIN t_q t ON t.k = h.first_k CROSS JOIN LATERAL (VALUES
        ('UNFUNDED_COMMITMENT_AMOUNT', '0'), ('POSITION_IS_HYPOTHETICAL', 'false'),
        ('CLO_IS_DISCOUNT_OBLIGATION', h.discount::text),
        ('CLO_ACQUISITION_DATE', CASE WHEN h.first_k = 1 THEN (SELECT effective FROM t_clo WHERE c = h.c) ELSE t.vfrom + 20 END::text),
        ('CLO_REINVESTMENT_ELIGIBLE', 'true'), ('CLO_IS_UNSETTLED', 'false')
    ) AS a(attr, val);
    INSERT INTO t_val SELECT 'CLOB-' || hq.pos_code, a.attr, hq.k, a.val
    FROM t_holdq hq CROSS JOIN LATERAL (VALUES
        ('FUNDED_PAR_AMOUNT', hq.par::text),
        ('FAIR_MARKET_PRICE', hq.price::text),
        ('MARKET_VALUE', round(hq.par * hq.price / 100, 2)::text),
        ('CLO_EXPECTED_INTEREST', CASE WHEN hq.defaulted THEN '0'
                                       WHEN hq.fixed_rate THEN round(hq.par * 0.0725 / 4, 2)::text
                                       ELSE round(hq.par * (hq.sofr + hq.spread / 100.0) / 100 / 4, 2)::text END),
        ('CLO_DEFAULT_CARRY_VALUE', CASE WHEN hq.defaulted THEN round(LEAST(hq.par * hq.price / 100, hq.par * 0.45), 2)::text ELSE '0' END),
        ('CLO_DISCOUNT_HAIRCUT', CASE WHEN hq.discount THEN round(hq.par * 0.16, 2)::text ELSE '0' END),
        ('CLO_IS_CREDIT_RISK', (hq.ord >= 17)::text)
    ) AS a(attr, val);

    -- note classes. Lakeshore pays Class A down by the principal its loans repay.
    CREATE TEMP TABLE t_note ON COMMIT DROP AS
    WITH coll AS (
        SELECT c, k, SUM(par) AS par FROM t_holdq GROUP BY c, k
    ), paid AS (
        SELECT c1.c, c1.k, COALESCE(c0.par - c1.par, 0) AS repaid
        FROM coll c1 LEFT JOIN coll c0 ON c0.c = c1.c AND c0.k = 1
    )
    SELECT c.c, c.tag, n.cls, n.rank, t.k, t.sofr, n.spread, n.oc, n.ic,
           CASE WHEN n.cls = 'A' AND c.amortizing THEN GREATEST(round(c.target * n.frac) - p.repaid, 0) ELSE round(c.target * n.frac) END AS par,
           round(c.target * n.frac) AS original,
           CASE WHEN n.cls = 'E' THEN c.oc_e ELSE n.oc END AS oc_trigger,
           CASE WHEN n.cls = 'E' AND c.stressed AND t.k >= 7 THEN 'B+' ELSE n.sp END AS sp,
           CASE WHEN n.cls = 'E' AND c.stressed AND t.k >= 7 THEN 'B1' ELSE n.mo END AS mo
    FROM t_clo c
    CROSS JOIN (VALUES
        ('A', 1, 0.62, 135, 121.0, 120.0, 'AAA', 'Aaa'),
        ('B', 2, 0.11, 180, 121.0, 120.0, 'AA', 'Aa2'),
        ('C', 3, 0.065, 230, 113.6, 115.0, 'A', 'A2'),
        ('D', 4, 0.06, 360, 107.9, 110.0, 'BBB-', 'Baa3'),
        ('E', 5, 0.045, 650, NULL, 105.0, 'BB-', 'Ba3'),
        ('SUB', 6, 0.10, 0, NULL, NULL, NULL, NULL)
    ) AS n(cls, rank, frac, spread, oc, ic, sp, mo)
    CROSS JOIN t_q t
    LEFT JOIN paid p ON p.c = c.c AND p.k = t.k;

    INSERT INTO t_val SELECT 'CLOB-' || n.tag || '-NOTE-' || n.cls, a.attr, NULL, a.val
    FROM (SELECT DISTINCT tag, cls, rank, spread, oc_trigger, ic, original FROM t_note) n CROSS JOIN LATERAL (VALUES
        ('CLO_NOTE_CLASS_CODE', n.cls), ('CLO_NOTE_SENIORITY_RANK', n.rank::text),
        ('CLO_NOTE_IS_DEFERRABLE', (n.rank >= 3)::text), ('CLO_NOTE_ORIGINAL_PAR', n.original::text),
        ('CLO_NOTE_SPREAD_BPS', n.spread::text),
        ('CLO_NOTE_OC_TRIGGER', CASE WHEN n.cls = 'SUB' THEN NULL ELSE n.oc_trigger::text END),
        ('CLO_NOTE_IC_TRIGGER', CASE WHEN n.cls = 'SUB' THEN NULL ELSE n.ic::text END)
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;
    INSERT INTO t_val SELECT 'CLOB-' || n.tag || '-NOTE-' || n.cls, a.attr, n.k, a.val
    FROM t_note n CROSS JOIN LATERAL (VALUES
        ('CLO_NOTE_PAR_OUTSTANDING', n.par::text),
        ('CLO_NOTE_DEFERRED_INTEREST', '0'),
        ('CLO_NOTE_INTEREST_DUE', CASE WHEN n.cls = 'SUB' THEN '0' ELSE round(n.par * (n.sofr + n.spread / 100.0) / 100 / 4, 2)::text END),
        ('CLO_NOTE_RATING_SP', n.sp), ('CLO_NOTE_RATING_MOODYS', n.mo)
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    -- trustee accounts
    INSERT INTO t_val SELECT 'CLOB-' || c.tag || '-ACCT-' || a.code, a.attr, NULL, a.val
    FROM t_clo c CROSS JOIN LATERAL (VALUES
        ('PRIN', 'CLO_ACCT_TYPE', 'PRINCIPAL'), ('INT', 'CLO_ACCT_TYPE', 'INTEREST'),
        ('EXP', 'CLO_ACCT_TYPE', 'EXPENSE_RESERVE'), ('RAMP', 'CLO_ACCT_TYPE', 'RAMP_UP'),
        ('PRIN', 'CLO_ACCT_CURRENCY', 'USD'), ('INT', 'CLO_ACCT_CURRENCY', 'USD'),
        ('EXP', 'CLO_ACCT_CURRENCY', 'USD'), ('RAMP', 'CLO_ACCT_CURRENCY', 'USD')
    ) AS a(code, attr, val);
    INSERT INTO t_val SELECT 'CLOB-' || c.tag || '-ACCT-' || a.code, a.attr, t.k, a.val
    FROM t_clo c CROSS JOIN t_q t
    LEFT JOIN (SELECT hq.c, hq.k, SUM(CASE WHEN hq.defaulted THEN 0 WHEN hq.fixed_rate THEN hq.par * 0.0725 / 4
                                           ELSE hq.par * (hq.sofr + hq.spread / 100.0) / 100 / 4 END) AS interest
               FROM t_holdq hq GROUP BY hq.c, hq.k) i ON i.c = c.c AND i.k = t.k
    CROSS JOIN LATERAL (VALUES
        ('PRIN', 'CLO_ACCT_BALANCE', (CASE WHEN c.amortizing THEN 1250000 ELSE 1500000 + ((t.k * 7 + c.c * 3) % 9) * 450000 END)::text),
        ('PRIN', 'CLO_ACCT_UNINVESTED_PROCEEDS', (CASE WHEN c.amortizing THEN 0 ELSE 1500000 + ((t.k * 7 + c.c * 3) % 9) * 450000 END)::text),
        ('INT', 'CLO_ACCT_BALANCE', round(COALESCE(i.interest, 0) * 0.98, 2)::text),
        ('INT', 'CLO_ACCT_UNINVESTED_PROCEEDS', '0'),
        ('EXP', 'CLO_ACCT_BALANCE', '250000'), ('EXP', 'CLO_ACCT_UNINVESTED_PROCEEDS', '0'),
        ('RAMP', 'CLO_ACCT_BALANCE', '0'), ('RAMP', 'CLO_ACCT_UNINVESTED_PROCEEDS', '0')
    ) AS a(code, attr, val);

    -- Rewrite this seed's values. Consecutive quarters with the same value become one row.
    DELETE FROM golden_master.entity_attribute_values eav
    USING entity_instances.master_entities me
    WHERE eav.entity_id = me.id AND me.client_id = v_client AND me.entity_code LIKE 'CLOB-%' AND eav.source_id = v_src;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, precedence_rank, metadata
    )
    WITH runs AS (
        SELECT v.*, SUM(CASE WHEN v.val IS NOT DISTINCT FROM v.prev AND v.k = v.prev_k + 1 THEN 0 ELSE 1 END)
                        OVER (PARTITION BY v.entity_code, v.attribute_code ORDER BY v.k) AS run
        FROM (SELECT t.*, LAG(t.val) OVER w AS prev, LAG(t.k) OVER w AS prev_k
              FROM t_val t WHERE t.k IS NOT NULL
              WINDOW w AS (PARTITION BY t.entity_code, t.attribute_code ORDER BY t.k)) v
    ), spans AS (
        SELECT r.entity_code, r.attribute_code, MIN(r.val) AS val, MIN(r.k) AS k0, MAX(r.k) AS k1
        FROM runs r GROUP BY r.entity_code, r.attribute_code, r.run
        UNION ALL
        SELECT t.entity_code, t.attribute_code, t.val, NULL, NULL FROM t_val t WHERE t.k IS NULL
    )
    SELECT me.id, ar.id, v_src, sp.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') AND sp.val ~ '^-?[0-9]+(\.[0-9]+)?$' THEN sp.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' AND sp.val ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN sp.val::date END,
           CASE WHEN ar.data_type = 'BOOLEAN' THEN sp.val::boolean END,
           COALESCE(q0.vfrom, DATE '2020-01-01'), COALESCE(q1.vto, DATE '9999-12-31'), 100, '{"cloBookSample": true}'::jsonb
    FROM spans sp
    LEFT JOIN t_q q0 ON q0.k = sp.k0
    LEFT JOIN t_q q1 ON q1.k = sp.k1
    JOIN entity_instances.master_entities me ON me.entity_code = sp.entity_code AND me.client_id = v_client
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = sp.attribute_code
    WHERE sp.val IS NOT NULL;

    -- ------------------------------------------------------------------
    -- Links. A fund is the parent of its CLO records; a position is the parent of its fund and
    -- its security; a security is the parent of its issuer (as in the CLO rule-library sample).
    -- A holding is linked to its fund from the quarter it was bought through the quarter it was sold.
    -- ------------------------------------------------------------------
    CREATE TEMP TABLE t_rel (parent_code text, child_code text, rel_code text, vfrom date, vto date) ON COMMIT DROP;
    INSERT INTO t_rel
    SELECT 'CLOB-' || tag || '-FUND', 'CLOB-' || tag || '-TXN', 'FUND_CLO_TRANSACTION', DATE '2020-01-01', DATE '9999-12-31' FROM t_clo
    UNION ALL SELECT 'CLOB-' || c.tag || '-FUND', 'CLOB-' || c.tag || '-NOTE-' || n.cls, 'FUND_CLO_NOTE_CLASS', DATE '2020-01-01', DATE '9999-12-31'
        FROM t_clo c CROSS JOIN (VALUES ('A'), ('B'), ('C'), ('D'), ('E'), ('SUB')) AS n(cls)
    UNION ALL SELECT 'CLOB-' || c.tag || '-FUND', 'CLOB-' || c.tag || '-ACCT-' || a.code, 'FUND_CLO_ACCOUNT', DATE '2020-01-01', DATE '9999-12-31'
        FROM t_clo c CROSS JOIN (VALUES ('PRIN'), ('INT'), ('EXP'), ('RAMP')) AS a(code)
    UNION ALL SELECT 'CLOB-SEC-' || k, 'CLOB-ISS-' || k, 'SECURITY_ISSUER', DATE '2020-01-01', DATE '9999-12-31' FROM t_sec
    UNION ALL SELECT 'CLOB-' || h.pos_code, 'CLOB-SEC-' || h.sk, 'POSITION_SECURITY', DATE '2020-01-01', DATE '9999-12-31' FROM t_hold h
    UNION ALL SELECT 'CLOB-' || h.pos_code, 'CLOB-' || h.tag || '-FUND', 'POSITION_FUND', f.vfrom, l.vto
        FROM t_hold h JOIN t_q f ON f.k = h.first_k JOIN t_q l ON l.k = h.last_k;

    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from, valid_to, metadata)
    SELECT p.id, c.id, rt.relationship_name, t.rel_code, TRUE, t.vfrom, t.vto, '{"cloBookSample": true}'::jsonb
    FROM t_rel t
    JOIN entity_instances.master_entities p ON p.entity_code = t.parent_code AND p.client_id = v_client
    JOIN entity_instances.master_entities c ON c.entity_code = t.child_code AND c.client_id = v_client
    JOIN metadata_register.relationship_types rt ON rt.relationship_code = t.rel_code
    WHERE NOT EXISTS (
        SELECT 1 FROM entity_instances.entity_relationships r
        WHERE r.parent_entity_id = p.id AND r.child_entity_id = c.id AND r.relationship_code = t.rel_code
    );

    -- ------------------------------------------------------------------
    -- Enrollment. A fund is scored on a fund rule only with its own threshold row. Every CLO
    -- fund of this client (these four and the rule-library sample) is enrolled in every CLO rule.
    -- A rule that reads its limit from the deal (a limit line or limit term: indenture caps, note triggers)
    -- gets a blank row, so the deal's own number applies. A rule with a fixed limit (the
    -- eligibility counts) gets that number. Industry keeps the rank-2 row of the library.
    -- ------------------------------------------------------------------
    DELETE FROM compliance.rule_thresholds WHERE notes LIKE 'CLO book sample:%';
    INSERT INTO compliance.rule_thresholds (rule_id, entity_id, hard_limit_value, limit_direction, applies, notes)
    SELECT r.id, f.parent_entity_id,
           CASE WHEN v.metadata ? 'limit_term'
                  OR EXISTS (SELECT 1 FROM compliance.rule_measure_lines ml WHERE ml.rule_version_id = v.id AND ml.side = 'LIMIT')
                THEN NULL ELSE v.hard_limit_value END,
           COALESCE(v.limit_direction, 'MAX'), TRUE, 'CLO book sample: enrolled at the deal''s own limits'
    FROM compliance.rules r
    -- The version in force today. A rule can carry several active versions.
    CROSS JOIN LATERAL (
        SELECT rv.* FROM compliance.rule_versions rv
        WHERE rv.rule_id = r.id AND rv.is_active AND rv.valid_from <= CURRENT_DATE AND rv.valid_to >= CURRENT_DATE
        ORDER BY rv.version_number DESC
        LIMIT 1
    ) v
    CROSS JOIN (
        SELECT DISTINCT rel.parent_entity_id
        FROM entity_instances.entity_relationships rel
        JOIN entity_instances.master_entities fund ON fund.id = rel.parent_entity_id
        WHERE rel.relationship_code = 'FUND_CLO_TRANSACTION' AND fund.client_id = v_client
    ) f
    WHERE r.rule_code LIKE 'CLO\_%' AND r.client_id IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM compliance.rule_thresholds t
          WHERE t.rule_id = r.id AND t.entity_id = f.parent_entity_id
            AND t.group_value IS NULL AND t.rank_from IS NULL AND t.rank_to IS NULL
      );
    INSERT INTO compliance.rule_thresholds (rule_id, entity_id, rank_from, hard_limit_value, limit_direction, applies, notes)
    SELECT g.rule_id, f.parent_entity_id, g.rank_from, g.hard_limit_value, g.limit_direction, TRUE, 'CLO book sample: ' || COALESCE(g.notes, 'rank limit')
    FROM compliance.rule_thresholds g
    JOIN compliance.rules r ON r.id = g.rule_id AND r.rule_code LIKE 'CLO\_%'
    CROSS JOIN (
        SELECT DISTINCT rel.parent_entity_id
        FROM entity_instances.entity_relationships rel
        JOIN entity_instances.master_entities fund ON fund.id = rel.parent_entity_id
        WHERE rel.relationship_code = 'FUND_CLO_TRANSACTION' AND fund.client_id = v_client
    ) f
    WHERE g.entity_id IS NULL AND g.rank_from IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM compliance.rule_thresholds t
          WHERE t.rule_id = g.rule_id AND t.entity_id = f.parent_entity_id AND t.rank_from = g.rank_from
      );

    RAISE NOTICE 'CLO book seed: % records, % values', (SELECT count(*) FROM t_ent), (SELECT count(*) FROM t_val);
END $$;

-- The CLO surface (surfaces/clo) and the CLO record types belong to the Funds module, so a curated
-- client with that module can open it. A curated client's grants are copied from the module
-- catalog when an admin saves its modules, so an existing curated client sees it after its
-- modules are saved again.
UPDATE tenancy.module_catalog
SET surface_codes = array_append(surface_codes, 'clo')
WHERE module_code = 'funds' AND NOT ('clo' = ANY (surface_codes));

UPDATE tenancy.module_catalog
SET domain_codes = domain_codes || ARRAY(
        SELECT d FROM unnest(ARRAY['CLO_TRANSACTION', 'CLO_NOTE_CLASS', 'CLO_ACCOUNT']) AS d
        WHERE NOT (d = ANY (domain_codes)))
WHERE module_code = 'funds';

NOTIFY pgrst, 'reload schema';
