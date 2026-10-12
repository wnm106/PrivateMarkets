-- ============================================================================
-- Compliance engine benchmark data + timing harness
--
-- Volume (edit the knobs below):
--   20 funds (4 parents, 16 children -> FUND_PARENT hierarchy)
--   100 issuers (50-150), 300 securities (100-500), 100-500 positions per fund
--   (~6,000 positions total), each position with 14 monthly MARKET_VALUE
--   snapshots in the golden master (current + 13 prior months) plus current
--   BLOOMBERG / WSO single-source values (a few with large deviations).
--
-- Run (needs a superuser/postgres connection; RLS is bypassed):
--   psql "$DATABASE_URL" -f supabase/seed/bench_compliance.sql
-- or paste the whole file into the Supabase SQL editor. The final SELECT
-- returns the timing table. Re-running is safe: all BENCH data is deleted first.
--
-- Requires migrations 00031 + 00045 (compliance engine + attribute dimensions).
-- ============================================================================

-- ---------- knobs ----------
CREATE TEMP TABLE bench_cfg AS
SELECT 20  AS n_funds,
       4   AS n_parent_funds,
       100 AS n_issuers,
       300 AS n_securities,
       100 AS min_pos_per_fund,
       500 AS max_pos_per_fund,
       14  AS n_months;           -- month 0 = current month, 1..13 = prior months

SELECT setseed(0.42);

-- ---------- cleanup of previous runs ----------
DELETE FROM compliance.rule_evaluation_results WHERE rule_id IN (SELECT id FROM compliance.rules WHERE rule_code LIKE 'BENCH\_%' ESCAPE '\');
DELETE FROM compliance.rule_evaluation_runs    WHERE rule_id IN (SELECT id FROM compliance.rules WHERE rule_code LIKE 'BENCH\_%' ESCAPE '\');
DELETE FROM compliance.rule_versions           WHERE rule_id IN (SELECT id FROM compliance.rules WHERE rule_code LIKE 'BENCH\_%' ESCAPE '\');
DELETE FROM compliance.rules                   WHERE rule_code LIKE 'BENCH\_%' ESCAPE '\';

DELETE FROM entity_instances.entity_relationships
 WHERE parent_entity_id IN (SELECT id FROM entity_instances.master_entities WHERE entity_code LIKE 'BENCH-%')
    OR child_entity_id  IN (SELECT id FROM entity_instances.master_entities WHERE entity_code LIKE 'BENCH-%');
DELETE FROM entity_instances.master_entities WHERE entity_code LIKE 'BENCH-%';  -- cascades EAV / source values

-- ---------- metadata the engine needs ----------
INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description) VALUES
    ('NAV',          'Net Asset Value',      'NUMBER', 'Fund net asset value'),
    ('MARKET_VALUE', 'Market Value',         'NUMBER', 'Position market value'),
    ('INDUSTRY',     'Industry',             'STRING', 'Business industry'),
    ('MARKET_CAP',   'Market Capitalization','NUMBER', 'Market capitalization')
ON CONFLICT (attribute_code) DO NOTHING;

INSERT INTO metadata_register.relationship_types (relationship_code, relationship_name, parent_domain_code, child_domain_code, cardinality)
VALUES ('POSITION_FUND',     'Position to Fund',     'FUND',     'POSITION', 'ONE_TO_MANY'),
       ('POSITION_SECURITY', 'Position to Security', 'SECURITY', 'POSITION', 'ONE_TO_MANY'),
       ('SECURITY_ISSUER',   'Security to Issuer',   'ISSUER',   'SECURITY', 'ONE_TO_MANY'),
       ('FUND_PARENT',       'Fund to Parent Fund',  'FUND',     'FUND',     'MANY_TO_ONE')
ON CONFLICT (relationship_code) DO NOTHING;

-- ---------- owning tenant (master_entities.client_id is NOT NULL) ----------
-- Prefer the client that already owns the most real entities (so the data is visible
-- in the UI to your user); fall back to any non-internal client, then MERIDIAN_INTERNAL.
CREATE TEMP TABLE bench_client AS
SELECT COALESCE(
    (SELECT client_id FROM entity_instances.master_entities WHERE entity_code NOT LIKE 'BENCH-%' GROUP BY client_id ORDER BY count(*) DESC LIMIT 1),
    (SELECT id FROM tenancy.clients WHERE NOT is_internal ORDER BY created_at LIMIT 1),
    (SELECT id FROM tenancy.clients WHERE client_code = 'MERIDIAN_INTERNAL')
) AS id;

-- ---------- entities ----------
CREATE TEMP TABLE bench_funds AS
SELECT g AS n, gen_random_uuid() AS id FROM bench_cfg, generate_series(1, n_funds) g;

CREATE TEMP TABLE bench_issuers AS
SELECT g AS n, gen_random_uuid() AS id FROM bench_cfg, generate_series(1, n_issuers) g;

CREATE TEMP TABLE bench_secs AS
SELECT g AS n, gen_random_uuid() AS id,
       -- skewed industry assignment so a few industries concentrate
       (ARRAY['Software','Healthcare','Energy','Financials','Industrials','Consumer','Utilities','Materials','Telecom','Real Estate','Transportation','Media'])
         [1 + floor(power(random(), 2) * 12)::int] AS industry,
       1 + floor(random() * (SELECT n_issuers FROM bench_cfg))::int AS issuer_n
FROM bench_cfg, generate_series(1, n_securities) g;

CREATE TEMP TABLE bench_pos AS
SELECT f.n AS fund_n, f.id AS fund_id, p.n AS pos_n, gen_random_uuid() AS id,
       1 + floor(random() * (SELECT n_securities FROM bench_cfg))::int AS sec_n,
       round((100000 + random() * 4900000)::numeric, 2) AS base_mv
FROM bench_funds f
CROSS JOIN bench_cfg c
-- (0 * f.n) makes the random count depend on the outer row so it is re-drawn per fund
CROSS JOIN LATERAL generate_series(1, c.min_pos_per_fund + floor(random() * (c.max_pos_per_fund - c.min_pos_per_fund + 1))::int + 0 * f.n) p(n);

INSERT INTO entity_instances.master_entities (id, entity_code, domain_code, entity_name, metadata, client_id)
SELECT id, 'BENCH-FUND-' || lpad(n::text, 3, '0'), 'FUND', 'Bench Fund ' || n, '{"bench":true}'::jsonb, (SELECT id FROM bench_client) FROM bench_funds
UNION ALL SELECT id, 'BENCH-ISS-' || lpad(n::text, 4, '0'), 'ISSUER', 'Bench Issuer ' || n, '{"bench":true}'::jsonb, (SELECT id FROM bench_client) FROM bench_issuers
UNION ALL SELECT id, 'BENCH-SEC-' || lpad(n::text, 4, '0'), 'SECURITY', 'Bench Security ' || n, '{"bench":true}'::jsonb, (SELECT id FROM bench_client) FROM bench_secs
UNION ALL SELECT id, 'BENCH-POS-' || lpad(fund_n::text, 3, '0') || '-' || lpad(pos_n::text, 4, '0'), 'POSITION', 'Bench Position ' || fund_n || '/' || pos_n, '{"bench":true}'::jsonb, (SELECT id FROM bench_client) FROM bench_pos;

-- ---------- relationships (parent_entity_id -> child_entity_id) ----------
INSERT INTO entity_instances.entity_relationships (parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from)
SELECT f.id, p.id, 'POSITION_FUND', 'POSITION_FUND', TRUE, DATE '2020-01-01' FROM bench_pos p JOIN bench_funds f ON f.id = p.fund_id
UNION ALL
SELECT s.id, p.id, 'POSITION_SECURITY', 'POSITION_SECURITY', TRUE, DATE '2020-01-01' FROM bench_pos p JOIN bench_secs s ON s.n = p.sec_n
UNION ALL
SELECT i.id, s.id, 'SECURITY_ISSUER', 'SECURITY_ISSUER', TRUE, DATE '2020-01-01' FROM bench_secs s JOIN bench_issuers i ON i.n = s.issuer_n;

-- funds beyond the parent set roll up to funds 1..n_parent_funds (round robin)
INSERT INTO entity_instances.entity_relationships (parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from)
SELECT parent.id, child.id, 'FUND_PARENT', 'FUND_PARENT', TRUE, DATE '2020-01-01'
FROM bench_funds child
CROSS JOIN bench_cfg c
JOIN bench_funds parent ON parent.n = 1 + ((child.n - c.n_parent_funds - 1) % c.n_parent_funds)
WHERE child.n > c.n_parent_funds;

-- ---------- attribute values ----------
-- golden source = INTERNAL (precedence 60)
CREATE TEMP TABLE bench_ctx AS
SELECT (SELECT id FROM entity_instances.source_registry WHERE source_code = 'INTERNAL')  AS golden_src,
       (SELECT id FROM entity_instances.source_registry WHERE source_code = 'BLOOMBERG') AS bbg_src,
       (SELECT id FROM entity_instances.source_registry WHERE source_code = 'WSO')       AS wso_src,
       (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'MARKET_VALUE') AS a_mv,
       (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'NAV')          AS a_nav,
       (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'INDUSTRY')     AS a_ind,
       (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'MARKET_CAP')   AS a_cap,
       date_trunc('month', CURRENT_DATE)::date AS ms0;

-- monthly position market values: k=0 current month, k>0 prior months (non-overlapping valid intervals)
CREATE TEMP TABLE bench_mv AS
SELECT p.id AS pos_id, p.fund_id, k.k,
       round((p.base_mv * (1 + (random() - 0.5) * 0.06 * (k.k + 1)))::numeric, 2) AS mv,
       (x.ms0 - make_interval(months => k.k))::date AS valid_from,
       CASE WHEN k.k = 0 THEN DATE '9999-12-31'
            ELSE (x.ms0 - make_interval(months => k.k - 1))::date - 1 END AS valid_to
FROM bench_pos p
CROSS JOIN bench_ctx x
CROSS JOIN LATERAL generate_series(0, (SELECT n_months - 1 FROM bench_cfg)) k(k);

INSERT INTO golden_master.entity_attribute_values
    (entity_id, attribute_id, source_id, golden_value, golden_value_numeric, valid_from, valid_to, precedence_rank)
SELECT m.pos_id, x.a_mv, x.golden_src, m.mv::text, m.mv, m.valid_from, m.valid_to, 60
FROM bench_mv m, bench_ctx x;

-- fund NAV = sum of its positions' market value for the same month
INSERT INTO golden_master.entity_attribute_values
    (entity_id, attribute_id, source_id, golden_value, golden_value_numeric, valid_from, valid_to, precedence_rank)
SELECT m.fund_id, x.a_nav, x.golden_src, round(SUM(m.mv), 2)::text, round(SUM(m.mv), 2), m.valid_from, m.valid_to, 60
FROM bench_mv m, bench_ctx x
GROUP BY m.fund_id, x.a_nav, x.golden_src, m.valid_from, m.valid_to;

INSERT INTO golden_master.entity_attribute_values
    (entity_id, attribute_id, source_id, golden_value, valid_from, valid_to, precedence_rank)
SELECT s.id, x.a_ind, x.golden_src, s.industry, DATE '2020-01-01', DATE '9999-12-31', 60
FROM bench_secs s, bench_ctx x;

INSERT INTO golden_master.entity_attribute_values
    (entity_id, attribute_id, source_id, golden_value, golden_value_numeric, valid_from, valid_to, precedence_rank)
SELECT i.id, x.a_cap, x.golden_src, v::text, v, DATE '2020-01-01', DATE '9999-12-31', 60
FROM bench_issuers i, bench_ctx x, LATERAL (SELECT round((20000000 + random() * 2000000000)::numeric, 0) AS v) q(v);

-- competing single-source current values: BLOOMBERG (~3% large deviations), WSO (small noise)
INSERT INTO entity_instances.source_attribute_values
    (entity_id, attribute_id, source_id, attribute_value, value_as_numeric, valid_from)
SELECT m.pos_id, x.a_mv, x.bbg_src, v::text, v, m.valid_from
FROM bench_mv m, bench_ctx x,
     LATERAL (SELECT round((m.mv * CASE WHEN random() < 0.03 THEN 1 + (random() - 0.5) * 0.4 ELSE 1 + (random() - 0.5) * 0.01 END)::numeric, 2) AS v) q(v)
WHERE m.k = 0;

INSERT INTO entity_instances.source_attribute_values
    (entity_id, attribute_id, source_id, attribute_value, value_as_numeric, valid_from)
SELECT m.pos_id, x.a_mv, x.wso_src, v::text, v, m.valid_from
FROM bench_mv m, bench_ctx x,
     LATERAL (SELECT round((m.mv * (1 + (random() - 0.5) * 0.004))::numeric, 2) AS v) q(v)
WHERE m.k = 0;

ANALYZE entity_instances.master_entities;
ANALYZE entity_instances.entity_relationships;
ANALYZE golden_master.entity_attribute_values;
ANALYZE entity_instances.source_attribute_values;

-- ---------- benchmark rules exercising the new dimensions ----------
INSERT INTO compliance.rules (rule_code, rule_name, rule_category, anchor_domain_code, applies_to_all, is_active)
VALUES ('BENCH_MV_MOM_CHANGE',  'Bench: fund MV change vs prior month-end', 'EXPOSURE', 'FUND', TRUE, FALSE),
       ('BENCH_SOURCE_DIFF',    'Bench: golden vs Bloomberg MV difference', 'OTHER',    'FUND', TRUE, FALSE),
       ('BENCH_POSITION_SINGLE','Bench: single position share of fund',      'CONCENTRATION', 'FUND', TRUE, FALSE);

-- fund MV today vs. prior month-end: % change, soft 3 / hard 5
INSERT INTO compliance.rule_versions (
    rule_id, version_number, valid_from, rule_name, base_domain_code, base_rollup_path,
    numerator_attribute_code, numerator_aggregation,
    denominator_attribute_code, denominator_aggregation, denominator_scope,
    denominator_dimension, result_transform, result_unit,
    limit_direction, soft_limit_value, hard_limit_value)
SELECT r.id, 1, DATE '2020-01-01', r.rule_name, 'POSITION',
       '[{"relationship_code":"POSITION_FUND","direction":"DOWN","recursive":false}]'::jsonb,
       'MARKET_VALUE', 'SUM', 'MARKET_VALUE', 'SUM', 'ANCHOR_TOTAL',
       '{"offset_unit":"MONTH","offset_amount":-1,"snap_to":"MONTH_END"}'::jsonb, 'ABS_PCT_CHANGE', 'PERCENTAGE',
       'MAX', 3, 5
FROM compliance.rules r WHERE r.rule_code = 'BENCH_MV_MOM_CHANGE';

-- golden vs Bloomberg: absolute % difference, soft 0.5 / hard 1
INSERT INTO compliance.rule_versions (
    rule_id, version_number, valid_from, rule_name, base_domain_code, base_rollup_path,
    numerator_attribute_code, numerator_aggregation,
    denominator_attribute_code, denominator_aggregation, denominator_scope,
    denominator_dimension, result_transform, result_unit,
    limit_direction, soft_limit_value, hard_limit_value)
SELECT r.id, 1, DATE '2020-01-01', r.rule_name, 'POSITION',
       '[{"relationship_code":"POSITION_FUND","direction":"DOWN","recursive":false}]'::jsonb,
       'MARKET_VALUE', 'SUM', 'MARKET_VALUE', 'SUM', 'ANCHOR_TOTAL',
       '{"source_scope":"BLOOMBERG"}'::jsonb, 'ABS_PCT_CHANGE', 'PERCENTAGE',
       'MAX', 0.5, 1
FROM compliance.rules r WHERE r.rule_code = 'BENCH_SOURCE_DIFF';

-- each position's share of its fund, grouped per position is not supported by group-by-attribute;
-- instead this is a single-position-cap proxy: MAX position value / total fund value
INSERT INTO compliance.rule_versions (
    rule_id, version_number, valid_from, rule_name, base_domain_code, base_rollup_path,
    numerator_attribute_code, numerator_aggregation,
    denominator_attribute_code, denominator_aggregation, denominator_scope,
    result_unit, limit_direction, soft_limit_value, hard_limit_value)
SELECT r.id, 1, DATE '2020-01-01', r.rule_name, 'POSITION',
       '[{"relationship_code":"POSITION_FUND","direction":"DOWN","recursive":false}]'::jsonb,
       'MARKET_VALUE', 'MAX', 'MARKET_VALUE', 'SUM', 'ANCHOR_TOTAL',
       'PERCENTAGE', 'MAX', 1, 2
FROM compliance.rules r WHERE r.rule_code = 'BENCH_POSITION_SINGLE';

-- ---------- timing harness ----------
CREATE TEMP TABLE bench_timings (
    step TEXT, rule_code TEXT, ms NUMERIC, results INT, breaches INT, note TEXT);

DO $$
DECLARE
    v_codes TEXT[] := ARRAY['FUND_INDUSTRY_CONCENTRATION', 'FUND_FAMILY_NAV_CAP',
                            'BENCH_MV_MOM_CHANGE', 'BENCH_SOURCE_DIFF', 'BENCH_POSITION_SINGLE'];
    v_code TEXT;
    v_t TIMESTAMPTZ;
    v_run UUID;
    v_rc INT; v_bc INT;
    v_status TEXT;
BEGIN
    FOREACH v_code IN ARRAY v_codes LOOP
        BEGIN
            v_t := clock_timestamp();
            v_run := compliance.evaluate_rule(v_code, CURRENT_DATE, NOW(), NULL, NULL);
            SELECT result_count, breach_count INTO v_rc, v_bc FROM compliance.rule_evaluation_runs WHERE id = v_run;
            INSERT INTO bench_timings VALUES ('evaluate', v_code,
                round((extract(epoch FROM clock_timestamp() - v_t) * 1000)::numeric, 1), v_rc, v_bc, NULL);
        EXCEPTION WHEN OTHERS THEN
            INSERT INTO bench_timings VALUES ('evaluate', v_code, NULL, NULL, NULL, SQLERRM);
        END;
    END LOOP;

    -- one repeat of the heaviest rule to show warm-cache behaviour
    v_t := clock_timestamp();
    v_run := compliance.evaluate_rule('FUND_INDUSTRY_CONCENTRATION', CURRENT_DATE, NOW(), NULL, NULL);
    INSERT INTO bench_timings VALUES ('evaluate (warm repeat)', 'FUND_INDUSTRY_CONCENTRATION',
        round((extract(epoch FROM clock_timestamp() - v_t) * 1000)::numeric, 1), NULL, NULL, NULL);
END $$;

-- data volume summary + timings (this is the output to share)
INSERT INTO bench_timings
SELECT 'rows', t, NULL, c::int, NULL, NULL FROM (
    SELECT 'master_entities (bench)' AS t, count(*) AS c FROM entity_instances.master_entities WHERE entity_code LIKE 'BENCH-%'
    UNION ALL SELECT 'entity_relationships', count(*) FROM entity_instances.entity_relationships WHERE relationship_code IN ('POSITION_FUND','POSITION_SECURITY','SECURITY_ISSUER','FUND_PARENT') AND valid_from = DATE '2020-01-01'
    UNION ALL SELECT 'golden values (bench entities)', count(*) FROM golden_master.entity_attribute_values e JOIN entity_instances.master_entities m ON m.id = e.entity_id WHERE m.entity_code LIKE 'BENCH-%'
    UNION ALL SELECT 'source values (bench entities)', count(*) FROM entity_instances.source_attribute_values s JOIN entity_instances.master_entities m ON m.id = s.entity_id WHERE m.entity_code LIKE 'BENCH-%'
) x;

SELECT * FROM bench_timings ORDER BY step DESC, rule_code;

-- ---------- optional: query plan for the hot path ----------
-- Pick one fund and look at how the set-based lookup behaves:
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT * FROM compliance.get_numeric_values(
--       (SELECT array_agg(id) FROM bench_pos WHERE fund_n = 1),
--       'MARKET_VALUE', CURRENT_DATE, NOW(), 'GOLDEN');
-- Per-statement detail inside functions needs auto_explain:
--   LOAD 'auto_explain'; SET auto_explain.log_min_duration = 0; SET auto_explain.log_nested_statements = on;
