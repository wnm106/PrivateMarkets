-- ============================================================================
-- Bench Fund 4: back-fill the data an LP review needs
--
-- bench_compliance.sql creates BENCH-FUND-004 with positions, monthly market
-- values, NAV, gross asset value and security industries, and nothing else.
-- This file adds what an investor report draws on, consistent with that data:
--
--   FUND           strategy, vintage, inception, commitments, undrawn, fees,
--                  carry, hurdle, net and gross IRR (three dates), credit line
--                  headroom, unfunded borrower commitments, total debt (0)
--   NAV_STATEMENT  BENCH-FUND-004-STMT, one quarterly statement per quarter
--                  Q3-25 .. Q3-26: changes in net assets, operations, and an
--                  inception-to-date roll-forward. Each quarter's beginning
--                  and ending NAV equal the fund's NAV series exactly.
--   SECURITY       lien, fixed/floating, reference rate, spread, coupon,
--                  maturity, PIK (deferring interest), cov-lite
--   ISSUER         EBITDA, revenue, total and senior net leverage, interest
--                  coverage, rating: a year ago and now
--   POSITION       mark (a year ago and now), funded par, cost, non-accrual,
--                  unfunded commitment
--
-- The story it tells: a fully called 2022 direct lending fund, mostly first
-- lien and floating, earning a steady ~9% net investment income that covers
-- its distributions, with marks drifting down in 2026. Three borrowers are on
-- the watchlist (two of them Software, the fund's largest industry) and one
-- borrower is on non-accrual since July 2026.
--
-- Values are deterministic (hashed from entity ids), so a re-run gives the same
-- numbers. Every value row is tagged metadata.backfill = 'lp_story'; re-running
-- deletes those rows and the statement entity first. Running bench_compliance.sql
-- again deletes all BENCH data, this included; run this file after it.
--
-- Run: npx supabase db query --linked -f supabase/seed/bench_fund4_lp_story.sql
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.u(p_id uuid, p_salt text) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT (abs(hashtext(p_id::text || p_salt)) % 100000) / 100000.0
$$;

-- ---------- context ----------
CREATE TEMP TABLE lp_ctx AS
SELECT me.id AS fund_id, me.client_id,
       (SELECT id FROM entity_instances.source_registry WHERE source_code = 'INTERNAL') AS src_internal,
       (SELECT id FROM entity_instances.source_registry WHERE source_code = 'FUND_ADMIN') AS src_admin,
       (SELECT id FROM entity_instances.source_registry WHERE source_code = 'BORROWER_CERTIFICATE') AS src_cert
FROM entity_instances.master_entities me
WHERE me.entity_code = 'BENCH-FUND-004';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lp_ctx) THEN
    RAISE EXCEPTION 'BENCH-FUND-004 not found: run supabase/seed/bench_compliance.sql first';
  END IF;
END $$;

-- ---------- cleanup of a previous run ----------
DELETE FROM golden_master.entity_attribute_values WHERE metadata->>'backfill' = 'lp_story';
DELETE FROM entity_instances.entity_relationships
 WHERE parent_entity_id IN (SELECT id FROM entity_instances.master_entities WHERE entity_code = 'BENCH-FUND-004-STMT');
DELETE FROM entity_instances.master_entities WHERE entity_code = 'BENCH-FUND-004-STMT';

-- ---------- the fund's book ----------
CREATE TEMP TABLE lp_pos AS
SELECT r.child_entity_id AS pos_id, rs.parent_entity_id AS sec_id, ri.parent_entity_id AS iss_id,
       (SELECT v.golden_value_numeric FROM golden_master.entity_attribute_values v
          JOIN metadata_register.attribute_register a ON a.id = v.attribute_id AND a.attribute_code = 'MARKET_VALUE'
         WHERE v.entity_id = r.child_entity_id AND v.system_to > now() AND v.valid_to = DATE '9999-12-31'
         ORDER BY v.valid_from DESC LIMIT 1) AS mv
FROM entity_instances.entity_relationships r
JOIN lp_ctx c ON r.parent_entity_id = c.fund_id
JOIN entity_instances.entity_relationships rs ON rs.child_entity_id = r.child_entity_id AND rs.relationship_code = 'POSITION_SECURITY' AND rs.system_to > now()
JOIN entity_instances.entity_relationships ri ON ri.child_entity_id = rs.parent_entity_id AND ri.relationship_code = 'SECURITY_ISSUER' AND ri.system_to > now()
WHERE r.relationship_code = 'POSITION_FUND' AND r.system_to > now();

CREATE TEMP TABLE lp_sec_industry AS
SELECT s.sec_id,
       (SELECT v.golden_value FROM golden_master.entity_attribute_values v
          JOIN metadata_register.attribute_register a ON a.id = v.attribute_id AND a.attribute_code = 'INDUSTRY'
         WHERE v.entity_id = s.sec_id AND v.system_to > now() ORDER BY v.valid_from DESC LIMIT 1) AS industry
FROM (SELECT DISTINCT sec_id FROM lp_pos) s;

-- each issuer's exposure in this fund and its largest industry
CREATE TEMP TABLE lp_iss AS
WITH by_ind AS (
  SELECT p.iss_id, si.industry, SUM(p.mv) AS mv
  FROM lp_pos p JOIN lp_sec_industry si ON si.sec_id = p.sec_id
  GROUP BY 1, 2
)
SELECT iss_id,
       SUM(mv) AS exposure,
       (array_agg(industry ORDER BY mv DESC))[1] AS industry,
       rank() OVER (ORDER BY SUM(mv) DESC) AS size_rank
FROM by_ind GROUP BY iss_id;

-- the problem credits: picked deterministically among mid-sized names
ALTER TABLE lp_iss ADD COLUMN status text NOT NULL DEFAULT 'PERFORMING';
UPDATE lp_iss SET status = 'WATCH' WHERE iss_id IN (
  SELECT iss_id FROM lp_iss WHERE industry = 'Software' AND size_rank BETWEEN 8 AND 40 ORDER BY md5(iss_id::text) LIMIT 2);
UPDATE lp_iss SET status = 'WATCH' WHERE iss_id IN (
  SELECT iss_id FROM lp_iss WHERE industry <> 'Software' AND status = 'PERFORMING' AND size_rank BETWEEN 8 AND 40 ORDER BY md5(iss_id::text) LIMIT 1);
UPDATE lp_iss SET status = 'NON_ACCRUAL' WHERE iss_id IN (
  SELECT iss_id FROM lp_iss WHERE status = 'PERFORMING' AND size_rank BETWEEN 20 AND 60
  ORDER BY (industry = 'Media') DESC, md5(iss_id::text) LIMIT 1);

-- ---------- values to write ----------
CREATE TEMP TABLE lp_vals (
  entity_id uuid, code text, src uuid, txt text, num numeric, dt date, bool boolean, vfrom date, vto date
);

-- helper: one value row (text form derived from the typed value)
CREATE OR REPLACE FUNCTION pg_temp.put(p_entity uuid, p_code text, p_src uuid, p_num numeric, p_txt text, p_dt date, p_bool boolean, p_from date, p_to date)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO lp_vals VALUES (p_entity, p_code, p_src,
    COALESCE(p_txt, p_num::text, p_dt::text, p_bool::text), p_num, p_dt, p_bool, p_from, COALESCE(p_to, DATE '9999-12-31'));
$$;

-- ---------- FUND ----------
SELECT pg_temp.put(c.fund_id, x.code, c.src_admin, x.num, x.txt, x.dt, NULL, x.vfrom, x.vto)
FROM lp_ctx c, (VALUES
  ('FUND_STRATEGY',            NULL::numeric, 'DIRECT_LENDING', NULL::date, DATE '2022-03-31', NULL::date),
  ('FUND_VINTAGE',             NULL, '2022', NULL, DATE '2022-03-31', NULL),
  ('INCEPTION_DATE',           NULL, NULL, DATE '2022-03-31', DATE '2022-03-31', NULL),
  ('FUND_TOTAL_COMMITMENTS',   1250000000, NULL, NULL, DATE '2022-03-31', NULL),
  ('FUND_UNDRAWN_COMMITMENTS', 130000000,  NULL, NULL, DATE '2025-06-30', DATE '2025-09-29'),
  ('FUND_UNDRAWN_COMMITMENTS', 110000000,  NULL, NULL, DATE '2025-09-30', NULL),
  ('FUND_MGMT_FEE_PCT',        1.25, NULL, NULL, DATE '2022-03-31', NULL),
  ('FUND_CARRY_PCT',           12.5, NULL, NULL, DATE '2022-03-31', NULL),
  ('FUND_HURDLE_PCT',          6,    NULL, NULL, DATE '2022-03-31', NULL),
  ('FUND_NET_IRR',             9.8,  NULL, NULL, DATE '2025-09-30', DATE '2026-06-29'),
  ('FUND_NET_IRR',             9.5,  NULL, NULL, DATE '2026-06-30', DATE '2026-09-29'),
  ('FUND_NET_IRR',             9.3,  NULL, NULL, DATE '2026-09-30', NULL),
  ('FUND_GROSS_IRR',           13.1, NULL, NULL, DATE '2025-09-30', DATE '2026-06-29'),
  ('FUND_GROSS_IRR',           12.8, NULL, NULL, DATE '2026-06-30', DATE '2026-09-29'),
  ('FUND_GROSS_IRR',           12.6, NULL, NULL, DATE '2026-09-30', NULL),
  ('FUND_CREDIT_LINE_HEADROOM',175000000, NULL, NULL, DATE '2025-09-30', NULL),
  ('TOTAL_DEBT',               0,    NULL, NULL, DATE '2025-09-30', NULL)
) AS x(code, num, txt, dt, vfrom, vto);

-- ---------- SECURITY: loan terms ----------
CREATE TEMP TABLE lp_sec AS
SELECT s.sec_id, i.status,
       CASE WHEN pg_temp.u(s.sec_id, 'lien') < 0.80 THEN 'FIRST_LIEN'
            WHEN pg_temp.u(s.sec_id, 'lien') < 0.95 THEN 'SECOND_LIEN' ELSE 'UNSECURED' END AS lien,
       pg_temp.u(s.sec_id, 'fixed') < 0.08 AS is_fixed,
       pg_temp.u(s.sec_id, 'spread') AS us,
       pg_temp.u(s.sec_id, 'mat') AS um,
       pg_temp.u(s.sec_id, 'q') AS uq,
       pg_temp.u(s.sec_id, 'cov') < 0.25 AS cov_lite
FROM (SELECT DISTINCT sec_id, iss_id FROM lp_pos) s
JOIN lp_iss i ON i.iss_id = s.iss_id;

ALTER TABLE lp_sec ADD COLUMN spread numeric, ADD COLUMN coupon numeric, ADD COLUMN maturity date;
UPDATE lp_sec SET
  spread = CASE WHEN is_fixed THEN NULL
                WHEN lien = 'FIRST_LIEN' THEN round(475 + us * 175)
                WHEN lien = 'SECOND_LIEN' THEN round(725 + us * 200)
                ELSE round(850 + us * 200) END,
  maturity = make_date(
                CASE WHEN um < 0.06 THEN 2027 WHEN um < 0.18 THEN 2028 WHEN um < 0.38 THEN 2029
                     WHEN um < 0.62 THEN 2030 WHEN um < 0.85 THEN 2031 ELSE 2032 END,
                (1 + floor(uq * 4))::int * 3, 1) + interval '1 month' - interval '1 day';
UPDATE lp_sec SET coupon = CASE WHEN is_fixed THEN round(9.5 + us * 2.5, 2) ELSE round(4.30 + spread / 100.0, 2) END;

SELECT pg_temp.put(s.sec_id, 'LIEN_PRIORITY', c.src_internal, NULL, s.lien, NULL, NULL, DATE '2020-01-01', NULL) FROM lp_sec s, lp_ctx c;
SELECT pg_temp.put(s.sec_id, 'IS_FIXED_RATE', c.src_internal, NULL, NULL, NULL, s.is_fixed, DATE '2020-01-01', NULL) FROM lp_sec s, lp_ctx c;
SELECT pg_temp.put(s.sec_id, 'BENCHMARK_REFERENCE_RATE', c.src_internal, NULL, CASE WHEN s.is_fixed THEN 'FIXED' ELSE 'SOFR' END, NULL, NULL, DATE '2020-01-01', NULL) FROM lp_sec s, lp_ctx c;
SELECT pg_temp.put(s.sec_id, 'SPREAD_BPS', c.src_internal, s.spread, NULL, NULL, NULL, DATE '2020-01-01', NULL) FROM lp_sec s, lp_ctx c WHERE s.spread IS NOT NULL;
SELECT pg_temp.put(s.sec_id, 'COUPON_RATE', c.src_internal, s.coupon, NULL, NULL, NULL, DATE '2025-09-01', NULL) FROM lp_sec s, lp_ctx c;
SELECT pg_temp.put(s.sec_id, 'MATURITY_DATE', c.src_internal, NULL, NULL, s.maturity::date, NULL, DATE '2020-01-01', NULL) FROM lp_sec s, lp_ctx c;
SELECT pg_temp.put(s.sec_id, 'IS_COV_LITE', c.src_internal, NULL, NULL, NULL, s.cov_lite, DATE '2020-01-01', NULL) FROM lp_sec s, lp_ctx c;
-- PIK: watchlist and non-accrual borrowers moved to deferring interest during 2026
SELECT pg_temp.put(s.sec_id, 'IS_DEFERRING_INTEREST', c.src_internal, NULL, NULL, NULL, FALSE, DATE '2020-01-01',
                   CASE WHEN s.status <> 'PERFORMING' THEN DATE '2026-03-31' END)
FROM lp_sec s, lp_ctx c;
SELECT pg_temp.put(s.sec_id, 'IS_DEFERRING_INTEREST', c.src_internal, NULL, NULL, NULL, TRUE, DATE '2026-04-01', NULL)
FROM lp_sec s, lp_ctx c WHERE s.status <> 'PERFORMING';

-- ---------- ISSUER: borrower financials, a year ago and now ----------
CREATE TEMP TABLE lp_fin AS
SELECT i.iss_id, i.status, i.industry,
       round((25000000 + pg_temp.u(i.iss_id, 'ebitda') * 120000000)::numeric, -5) AS ebitda_prior,
       CASE i.status WHEN 'WATCH' THEN -0.20 - pg_temp.u(i.iss_id, 'g') * 0.08
                     WHEN 'NON_ACCRUAL' THEN -0.45
                     ELSE -0.08 + pg_temp.u(i.iss_id, 'g') * 0.25 END AS growth,
       4.0 + pg_temp.u(i.iss_id, 'lev') * 1.8 + CASE WHEN i.industry = 'Software' THEN 0.6 ELSE 0 END AS lev_prior,
       0.18 + pg_temp.u(i.iss_id, 'margin') * 0.17 AS margin
FROM lp_iss i;

ALTER TABLE lp_fin ADD COLUMN ebitda_now numeric, ADD COLUMN lev_now numeric, ADD COLUMN cov_prior numeric, ADD COLUMN cov_now numeric;
-- debt held constant, so leverage moves inversely with EBITDA; coverage = EBITDA / (debt x all-in rate)
UPDATE lp_fin SET
  ebitda_now = round(ebitda_prior * (1 + growth), -5),
  lev_now = round(lev_prior / (1 + growth), 2),
  cov_prior = round(1 / (lev_prior * 0.112), 2),
  cov_now = round(1 / ((lev_prior / (1 + growth)) * 0.104), 2);
UPDATE lp_fin SET lev_prior = round(lev_prior, 2);

CREATE OR REPLACE FUNCTION pg_temp.rating(p_lev numeric, p_status text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_status = 'NON_ACCRUAL' THEN 'CCC'
              WHEN p_lev < 4.5 THEN 'B_PLUS' WHEN p_lev < 5.5 THEN 'B' WHEN p_lev < 6.5 THEN 'B_MINUS' ELSE 'CCC_PLUS' END
$$;

SELECT pg_temp.put(f.iss_id, x.code, c.src_cert, x.num, x.txt, NULL, NULL, x.vfrom, x.vto)
FROM lp_fin f, lp_ctx c, LATERAL (VALUES
  ('EBITDA_LTM',               f.ebitda_prior, NULL, DATE '2025-09-30', DATE '2026-09-29'),
  ('EBITDA_LTM',               f.ebitda_now,   NULL, DATE '2026-09-30', NULL::date),
  ('REVENUE_LTM',              round(f.ebitda_prior / f.margin, -5), NULL, DATE '2025-09-30', DATE '2026-09-29'),
  ('REVENUE_LTM',              round(f.ebitda_now / f.margin * (1 + CASE WHEN f.status = 'PERFORMING' THEN 0 ELSE 0.08 END), -5), NULL, DATE '2026-09-30', NULL),
  ('TOTAL_NET_LEVERAGE_RATIO', f.lev_prior, NULL, DATE '2025-09-30', DATE '2026-09-29'),
  ('TOTAL_NET_LEVERAGE_RATIO', f.lev_now,   NULL, DATE '2026-09-30', NULL),
  ('SENIOR_NET_LEVERAGE_RATIO',round(f.lev_prior * 0.88, 2), NULL, DATE '2025-09-30', DATE '2026-09-29'),
  ('SENIOR_NET_LEVERAGE_RATIO',round(f.lev_now * 0.88, 2),   NULL, DATE '2026-09-30', NULL),
  ('INTEREST_COVERAGE_RATIO',  f.cov_prior, NULL, DATE '2025-09-30', DATE '2026-09-29'),
  ('INTEREST_COVERAGE_RATIO',  f.cov_now,   NULL, DATE '2026-09-30', NULL),
  ('CREDIT_RATING',            NULL, pg_temp.rating(f.lev_prior, 'PERFORMING'), DATE '2025-09-30', DATE '2026-09-29'),
  ('CREDIT_RATING',            NULL, pg_temp.rating(f.lev_now, f.status),        DATE '2026-09-30', NULL)
) AS x(code, num, txt, vfrom, vto);

-- ---------- POSITION: marks, par, cost, accrual status, unfunded ----------
CREATE TEMP TABLE lp_p AS
SELECT p.pos_id, p.mv, i.status,
       round(CASE i.status WHEN 'WATCH' THEN 96 + pg_temp.u(p.pos_id, 'm0') * 2
                           WHEN 'NON_ACCRUAL' THEN 93 + pg_temp.u(p.pos_id, 'm0') * 2
                           ELSE 98 + pg_temp.u(p.pos_id, 'm0') * 2.5 END, 2) AS mark_prior,
       round(CASE i.status WHEN 'WATCH' THEN 86 + pg_temp.u(p.pos_id, 'm1') * 4
                           WHEN 'NON_ACCRUAL' THEN 58 + pg_temp.u(p.pos_id, 'm1') * 6
                           ELSE 97 + pg_temp.u(p.pos_id, 'm1') * 3.5 END, 2) AS mark_now,
       pg_temp.u(p.pos_id, 'cost') AS uc,
       pg_temp.u(p.pos_id, 'unf') AS uu
FROM lp_pos p JOIN lp_iss i ON i.iss_id = p.iss_id
WHERE p.mv IS NOT NULL;

SELECT pg_temp.put(p.pos_id, 'FAIR_MARKET_PRICE', c.src_internal, p.mark_prior, NULL, NULL, NULL, DATE '2025-09-01', DATE '2026-09-30') FROM lp_p p, lp_ctx c;
SELECT pg_temp.put(p.pos_id, 'FAIR_MARKET_PRICE', c.src_internal, p.mark_now,   NULL, NULL, NULL, DATE '2026-10-01', NULL) FROM lp_p p, lp_ctx c;
SELECT pg_temp.put(p.pos_id, 'FUNDED_PAR_AMOUNT', c.src_internal, round(p.mv * 100 / p.mark_now, 2), NULL, NULL, NULL, DATE '2026-10-01', NULL) FROM lp_p p, lp_ctx c;
SELECT pg_temp.put(p.pos_id, 'POSITION_COST', c.src_internal, round(p.mv * 100 / p.mark_now * (0.985 + p.uc * 0.01), 2), NULL, NULL, NULL, DATE '2025-09-01', NULL) FROM lp_p p, lp_ctx c;
SELECT pg_temp.put(p.pos_id, 'IS_NON_ACCRUAL', c.src_internal, NULL, NULL, NULL, FALSE, DATE '2025-09-01',
                   CASE WHEN p.status = 'NON_ACCRUAL' THEN DATE '2026-06-30' END) FROM lp_p p, lp_ctx c;
SELECT pg_temp.put(p.pos_id, 'IS_NON_ACCRUAL', c.src_internal, NULL, NULL, NULL, TRUE, DATE '2026-07-01', NULL)
FROM lp_p p, lp_ctx c WHERE p.status = 'NON_ACCRUAL';
SELECT pg_temp.put(p.pos_id, 'UNFUNDED_COMMITMENT_AMOUNT', c.src_internal, round(p.mv * (0.15 + p.uu), 2), NULL, NULL, NULL, DATE '2025-09-01', NULL)
FROM lp_p p, lp_ctx c WHERE p.uu < 0.12 AND p.status = 'PERFORMING';

-- fund-level unfunded borrower commitments = the sum of the positions' own
SELECT pg_temp.put(c.fund_id, 'FUND_UNFUNDED_BORROWER_COMMITMENTS', c.src_admin, round(SUM(v.num), 0), NULL, NULL, NULL, DATE '2025-09-30', NULL)
FROM lp_vals v, lp_ctx c WHERE v.code = 'UNFUNDED_COMMITMENT_AMOUNT' GROUP BY c.fund_id, c.src_admin;

-- ---------- NAV_STATEMENT: quarterly statements that reconcile to the NAV series ----------
INSERT INTO entity_instances.master_entities (entity_code, domain_code, entity_name, metadata, client_id)
SELECT 'BENCH-FUND-004-STMT', 'NAV_STATEMENT', 'Bench Fund 4 NAV statement', '{"bench":true,"backfill":"lp_story"}'::jsonb, c.client_id FROM lp_ctx c;

INSERT INTO entity_instances.entity_relationships (parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from, metadata)
SELECT s.id, c.fund_id, 'STATEMENT_FUND', 'STATEMENT_FUND', TRUE, DATE '2025-09-30', '{"backfill":"lp_story"}'::jsonb
FROM lp_ctx c, entity_instances.master_entities s WHERE s.entity_code = 'BENCH-FUND-004-STMT';

-- quarter flows in $M. Ending NAV is the fund's NAV on the period end; unrealized balances the quarter.
CREATE TEMP TABLE lp_q AS
WITH q(n, period_end, label, beginning, contributions, nii, distributions, realized) AS (VALUES
  (1, DATE '2025-09-30', 'September 30, 2025', 1148.2, 20.0, 26.4, -25.1,  0.5),
  (2, DATE '2025-12-31', 'December 31, 2025',  NULL,    0.0, 27.1, -25.7,  1.2),
  (3, DATE '2026-03-31', 'March 31, 2026',     NULL,    0.0, 27.4, -26.0, -3.5),
  (4, DATE '2026-06-30', 'June 30, 2026',      NULL,    0.0, 27.2, -25.9,  0.8),
  (5, DATE '2026-09-30', 'September 30, 2026', NULL,    0.0, 26.9, -25.6, -0.6)
),
nav AS (
  SELECT q.n, (SELECT round(v.golden_value_numeric / 1e6, 1)
                 FROM golden_master.entity_attribute_values v
                 JOIN metadata_register.attribute_register a ON a.id = v.attribute_id AND a.attribute_code = 'NAV'
                 JOIN lp_ctx c ON v.entity_id = c.fund_id
                WHERE v.system_to > now() AND q.period_end BETWEEN v.valid_from AND v.valid_to
                ORDER BY v.precedence_rank LIMIT 1) AS ending
  FROM q
)
SELECT q.n, q.period_end, q.label,
       COALESCE(q.beginning, lag(nav.ending) OVER (ORDER BY q.n)) AS beginning,
       q.contributions, q.nii, q.distributions, q.realized, nav.ending
FROM q JOIN nav USING (n);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM lp_q WHERE ending IS NULL OR beginning IS NULL) THEN
    RAISE EXCEPTION 'Bench Fund 4 has no NAV on a quarter end; the statements cannot reconcile';
  END IF;
END $$;

ALTER TABLE lp_q ADD COLUMN unrealized numeric;
UPDATE lp_q SET unrealized = round(ending - beginning - contributions - nii - distributions - realized, 1);

-- inception-to-date roll-forward, anchored at Q3-26 and walked back by each later quarter's flows
CREATE TEMP TABLE lp_itd AS
SELECT q.n,
       1140.0 - COALESCE(SUM(l.contributions), 0) AS contributions,
       -312.4 - COALESCE(SUM(l.distributions), 0) AS distributions,
        341.8 - COALESCE(SUM(l.nii), 0)           AS nii,
         -9.6 - COALESCE(SUM(l.realized), 0)      AS realized
FROM lp_q q LEFT JOIN lp_q l ON l.n > q.n
GROUP BY q.n;
ALTER TABLE lp_itd ADD COLUMN ending numeric, ADD COLUMN unrealized numeric;
UPDATE lp_itd i SET ending = q.ending FROM lp_q q WHERE q.n = i.n;
UPDATE lp_itd SET unrealized = round(ending - contributions - distributions - nii - realized, 1);

-- operations: fee is 1.25% a year on beginning NAV; income = NII + expenses
CREATE TEMP TABLE lp_ops AS
SELECT n, round(beginning * 0.0125 / 4, 2) AS mgmt_fee, 0.62 AS professional, 0.71 AS other, 0.18 AS facility, nii
FROM lp_q;
ALTER TABLE lp_ops ADD COLUMN expenses numeric, ADD COLUMN income numeric;
UPDATE lp_ops SET expenses = mgmt_fee + professional + other + facility;
UPDATE lp_ops SET income = nii + expenses;

SELECT pg_temp.put(s.id, x.code, c.src_admin, round(x.m * 1000000, 0), NULL, NULL, NULL, q.period_end,
                   (lead(q.period_end) OVER (PARTITION BY x.code ORDER BY q.n) - 1))
FROM lp_q q
JOIN lp_ops o USING (n)
JOIN lp_itd i USING (n)
CROSS JOIN lp_ctx c
CROSS JOIN entity_instances.master_entities s
CROSS JOIN LATERAL (VALUES
  ('NAV_CH_BEGINNING', q.beginning), ('NAV_CH_CONTRIBUTIONS', q.contributions), ('NAV_CH_DISTRIBUTIONS', q.distributions),
  ('NAV_CH_NET_INVESTMENT_INCOME', q.nii), ('NAV_CH_REALIZED', q.realized), ('NAV_CH_UNREALIZED', q.unrealized),
  ('NAV_CH_NET_OPERATIONS', q.nii + q.realized + q.unrealized), ('NAV_CH_NET_CAPITAL', q.contributions + q.distributions),
  ('NAV_CH_TOTAL_INCREASE', q.ending - q.beginning), ('NAV_CH_ENDING', q.ending),
  ('NAV_OP_TOTAL_INCOME', o.income), ('NAV_OP_PIK', round(o.income * 0.05, 2)), ('NAV_OP_FEE_INCOME', round(o.income * 0.04, 2)),
  ('NAV_OP_CASH_INTEREST', o.income - round(o.income * 0.05, 2) - round(o.income * 0.04, 2)),
  ('NAV_OP_MGMT_FEE', o.mgmt_fee), ('NAV_OP_PROFESSIONAL', o.professional), ('NAV_OP_OTHER', o.other),
  ('NAV_OP_FACILITY_INTEREST', o.facility), ('NAV_OP_TOTAL_EXPENSES', o.expenses), ('NAV_OP_NET_INVESTMENT_INCOME', o.nii),
  ('NAV_OP_REALIZED', q.realized), ('NAV_OP_UNREALIZED', q.unrealized), ('NAV_OP_TOTAL_GAIN', q.realized + q.unrealized),
  ('NAV_OP_NET_INCREASE', q.nii + q.realized + q.unrealized),
  ('NAV_RF_BEGINNING', 0), ('NAV_RF_CONTRIBUTIONS', i.contributions), ('NAV_RF_DISTRIBUTIONS', i.distributions),
  ('NAV_RF_NET_INVESTMENT_INCOME', i.nii), ('NAV_RF_REALIZED', i.realized), ('NAV_RF_UNREALIZED', i.unrealized), ('NAV_RF_ENDING', i.ending)
) AS x(code, m)
WHERE s.entity_code = 'BENCH-FUND-004-STMT';

SELECT pg_temp.put(s.id, 'STATEMENT_PERIOD_END', c.src_admin, NULL, NULL, q.period_end, NULL, q.period_end, lead(q.period_end) OVER (ORDER BY q.n) - 1)
FROM lp_q q, lp_ctx c, entity_instances.master_entities s WHERE s.entity_code = 'BENCH-FUND-004-STMT';
SELECT pg_temp.put(s.id, 'STATEMENT_PERIOD_LABEL', c.src_admin, NULL, q.label, NULL, NULL, q.period_end, lead(q.period_end) OVER (ORDER BY q.n) - 1)
FROM lp_q q, lp_ctx c, entity_instances.master_entities s WHERE s.entity_code = 'BENCH-FUND-004-STMT';
SELECT pg_temp.put(s.id, 'STATEMENT_CERTIFIED', c.src_admin, NULL, NULL, NULL, TRUE, DATE '2025-09-30', NULL)
FROM lp_ctx c, entity_instances.master_entities s WHERE s.entity_code = 'BENCH-FUND-004-STMT';

-- ---------- write ----------
INSERT INTO golden_master.entity_attribute_values
    (entity_id, attribute_id, source_id, golden_value, golden_value_numeric, golden_value_date, golden_value_boolean,
     valid_from, valid_to, precedence_rank, metadata)
SELECT v.entity_id, a.id, v.src, v.txt, v.num, v.dt, v.bool, v.vfrom, v.vto, 60, '{"backfill":"lp_story"}'::jsonb
FROM lp_vals v
JOIN metadata_register.attribute_register a ON a.attribute_code = v.code;

-- The insert trigger picks a winning source only among open-ended rows, so a dated
-- history row (and, depending on insert order, the current row beside it) is left with
-- no golden_source_id, and grids skip it. These rows are the only source for their
-- attributes on these records, so each row's own source is the winner. The "resolving"
-- flag is the triggers' own switch that makes them leave the stamped value alone.
SELECT set_config('golden_master.resolving', '1', true);
SELECT set_config('golden_master.resolving_id', '', true);
UPDATE golden_master.entity_attribute_values
   SET golden_source_id = source_id, resolution_rule_applied = 'DATA_SOURCE_SEQUENCE', resolved_at = now()
 WHERE metadata->>'backfill' = 'lp_story' AND golden_source_id IS DISTINCT FROM source_id;
SELECT set_config('golden_master.resolving', '0', true);

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(DISTINCT v.code, ', ') INTO missing
  FROM lp_vals v WHERE NOT EXISTS (SELECT 1 FROM metadata_register.attribute_register a WHERE a.attribute_code = v.code);
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'Attributes not in the register: %', missing; END IF;
END $$;

ANALYZE golden_master.entity_attribute_values;

-- ---------- summary ----------
SELECT 'values written' AS item, count(*)::text AS value FROM lp_vals
UNION ALL SELECT 'watchlist borrowers', string_agg(me.entity_name || ' (' || i.industry || ')', ', ') FROM lp_iss i JOIN entity_instances.master_entities me ON me.id = i.iss_id WHERE i.status = 'WATCH'
UNION ALL SELECT 'non-accrual borrower', string_agg(me.entity_name || ' (' || i.industry || ')', ', ') FROM lp_iss i JOIN entity_instances.master_entities me ON me.id = i.iss_id WHERE i.status = 'NON_ACCRUAL'
UNION ALL SELECT 'quarters (begin/NII/dist/real/unreal/end $M)', string_agg(label || ': ' || beginning || '/' || nii || '/' || distributions || '/' || realized || '/' || unrealized || '/' || ending, '; ' ORDER BY n) FROM lp_q
UNION ALL SELECT 'ITD at Q3-26 (contrib/dist/NII/real/unreal/NAV $M)', (SELECT contributions || '/' || distributions || '/' || nii || '/' || realized || '/' || unrealized || '/' || ending FROM lp_itd WHERE n = 5);

COMMIT;
