-- Sample CLO fund for the CLO rule library.
--
-- CLOS-FUND "Sample CLO 2026-1" (a CLO because it has a CLO transaction) with its transaction terms, six note classes,
-- four trustee accounts, and 61 holdings (60 performing, 1 defaulted) as of
-- 2026-09-30. Two hypothetical buys carry scenario codes so the maintain-or-
-- improve check has something to compare:
--   CLOS-BUY-CCC  5M of a CCC loan. The CCC bucket already fails, so this makes it worse.
--   CLOS-BUY-B2   5M of a B2 first lien loan in Business Services.
--
-- The book is shaped so the library shows a mix of passes and breaches:
--   CCC bucket          5 loans at Caa1 plus no cap headroom, so over 7.5 percent
--   Single obligor      one obligor at 14M, and two affiliated obligors sharing a group
--   Industry            Healthcare holds 10 loans, well above the largest-industry cap
--   Eligibility         one bridge loan and one loan that matures after the notes
--   Class E OC trigger  set just above the ratio so Class E fails
--
-- Every sample entity carries metadata cloSample = true. To remove the sample,
-- delete the master_entities rows with that flag. Their values and
-- relationships go with them.
--
-- After loading, the migration runs every CLO rule and both pre-trade checks
-- and prints a summary as notices.

DO $$
DECLARE
    v_client uuid;
    v_src uuid;
    v_fund uuid;
    v_asof date := DATE '2026-09-30';
    v_code text;
    v_run uuid;
    v_runs uuid[] := '{}';
    v_row record;
    v_scen text;
    v_fail int := 0;
BEGIN
    SELECT client_id INTO v_client FROM entity_instances.master_entities WHERE entity_code = 'HSCF2-FUND';
    IF v_client IS NULL THEN
        SELECT id INTO v_client FROM tenancy.clients ORDER BY created_at LIMIT 1;
    END IF;
    SELECT id INTO v_src
    FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL', 'INTERNAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 WHEN 'MANUAL' THEN 1 ELSE 2 END
    LIMIT 1;
    IF v_client IS NULL OR v_src IS NULL THEN
        RAISE NOTICE 'Skipping CLO sample: client % source %', v_client, v_src;
        RETURN;
    END IF;

    -- --------------------------------------------------------
    -- Holdings
    -- --------------------------------------------------------
    CREATE TEMP TABLE t_pos ON COMMIT DROP AS
    WITH base AS (
        SELECT i,
               lpad(i::text, 2, '0') AS k,
               CASE WHEN i = 1 THEN 14000000 WHEN i = 61 THEN 5000000 WHEN i IN (62, 63) THEN 5000000 ELSE 6000000 END::numeric AS par,
               CASE i WHEN 61 THEN 'Ca' WHEN 62 THEN 'Caa1' WHEN 63 THEN 'B2'
                      ELSE (ARRAY['B1','B2','B2','B3','Ba3','B2','B3','B1','Caa1','B2','Ba3','B3'])[(i % 12) + 1] END AS mrating,
               (ARRAY['Healthcare','Software','Business Services','Chemicals','Consumer Goods','Telecommunications',
                      'Industrials','Aerospace and Defense','Retail','Media','Energy','Transportation'])[
                   CASE WHEN i BETWEEN 49 AND 54 THEN 1 WHEN i IN (61, 62) THEN 9 ELSE ((i - 1) % 12) + 1 END] AS industry
        FROM generate_series(1, 63) AS i
    ), step AS (
        SELECT b.*,
               CASE b.mrating WHEN 'B1' THEN 'B+' WHEN 'B2' THEN 'B' WHEN 'B3' THEN 'B-' WHEN 'Ba3' THEN 'BB-'
                              WHEN 'Ca' THEN 'CC' ELSE 'CCC+' END AS sprating,
               b.mrating IN ('Caa1', 'Ca') AS is_ccc,
               (b.i = 61) AS defaulted,
               (b.i >= 62) AS hypothetical,
               (b.i % 2 = 0) AS cov_lite,
               (b.i % 15 = 0) AS second_lien,
               (b.i % 20 = 0) AS fixed_rate,
               (b.i % 10 = 5) AS discount
        FROM base b
    )
    SELECT s.*,
           CASE WHEN s.i = 11 THEN 'BRIDGE' WHEN s.second_lien THEN 'SECOND_LIEN' ELSE 'SENIOR_SECURED' END AS loan_type,
           CASE WHEN s.second_lien THEN 'SECOND_LIEN' ELSE 'FIRST_LIEN' END AS lien,
           CASE WHEN s.fixed_rate THEN 0 ELSE 350 + (s.i % 7) * 25 END AS spread,
           CASE WHEN s.i = 7 THEN DATE '2036-01-01' ELSE DATE '2029-09-30' + ((s.i % 4) * 365) END AS maturity,
           CASE WHEN s.defaulted THEN 40.00
                WHEN s.discount THEN 91.00
                ELSE round(99.00 - CASE WHEN s.is_ccc THEN 28 ELSE 0 END - (s.i % 6) * 0.3, 2) END AS price,
           CASE WHEN s.second_lien THEN 22 ELSE 46 END AS recovery,
           CASE WHEN s.i = 3 THEN 'OB-02' ELSE 'OB-' || lpad(s.i::text, 2, '0') END AS obligor_group
    FROM step s;

    -- --------------------------------------------------------
    -- Entities
    -- --------------------------------------------------------
    CREATE TEMP TABLE t_ent (
        entity_code text, domain_code text, template_code text, entity_name text, description text
    ) ON COMMIT DROP;

    INSERT INTO t_ent VALUES
        ('CLOS-FUND', 'FUND', 'FUND_STANDARD', 'Sample CLO 2026-1', 'Sample CLO fund for the CLO rule library.'),
        ('CLOS-TXN', 'CLO_TRANSACTION', 'CLO_TRANSACTION_STANDARD', 'Sample CLO 2026-1 indenture terms', 'Indenture terms and test parameters.'),
        ('CLOS-NOTE-A', 'CLO_NOTE_CLASS', 'CLO_NOTE_CLASS_STANDARD', 'Class A Senior Secured Floating Rate Notes', 'Most senior class.'),
        ('CLOS-NOTE-B', 'CLO_NOTE_CLASS', 'CLO_NOTE_CLASS_STANDARD', 'Class B Senior Secured Floating Rate Notes', ''),
        ('CLOS-NOTE-C', 'CLO_NOTE_CLASS', 'CLO_NOTE_CLASS_STANDARD', 'Class C Secured Deferrable Floating Rate Notes', ''),
        ('CLOS-NOTE-D', 'CLO_NOTE_CLASS', 'CLO_NOTE_CLASS_STANDARD', 'Class D Secured Deferrable Floating Rate Notes', ''),
        ('CLOS-NOTE-E', 'CLO_NOTE_CLASS', 'CLO_NOTE_CLASS_STANDARD', 'Class E Secured Deferrable Floating Rate Notes', ''),
        ('CLOS-NOTE-SUB', 'CLO_NOTE_CLASS', 'CLO_NOTE_CLASS_STANDARD', 'Subordinated Notes', 'Equity tranche. Not covered by a coverage test.'),
        ('CLOS-ACCT-PRIN', 'CLO_ACCOUNT', 'CLO_ACCOUNT_STANDARD', 'Principal collection account', ''),
        ('CLOS-ACCT-INT', 'CLO_ACCOUNT', 'CLO_ACCOUNT_STANDARD', 'Interest collection account', ''),
        ('CLOS-ACCT-EXP', 'CLO_ACCOUNT', 'CLO_ACCOUNT_STANDARD', 'Expense reserve account', ''),
        ('CLOS-ACCT-RAMP', 'CLO_ACCOUNT', 'CLO_ACCOUNT_STANDARD', 'Ramp-up account', 'Empty after the effective date.');

    INSERT INTO t_ent
    SELECT 'CLOS-ISS-' || k, 'ISSUER', 'ISSUER_STANDARD', 'Sample Obligor ' || k, 'Sample CLO obligor.' FROM t_pos;
    INSERT INTO t_ent
    SELECT 'CLOS-SEC-' || k, 'SECURITY', 'SECURITY_STANDARD', 'Sample Obligor ' || k || ' term loan', 'Sample CLO obligation.' FROM t_pos;
    INSERT INTO t_ent
    SELECT 'CLOS-POS-' || k, 'POSITION', 'POSITION_STANDARD',
           CASE WHEN hypothetical THEN 'Proposed buy ' ELSE 'Holding ' END || 'Sample Obligor ' || k,
           CASE WHEN hypothetical THEN 'Hypothetical position for a pre-trade check.' ELSE 'Sample CLO holding.' END
    FROM t_pos;

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT e.entity_code, e.domain_code, t.id, e.entity_name, e.description, v_client,
           '{"cloSample":true}'::jsonb
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

    -- --------------------------------------------------------
    -- Values
    -- --------------------------------------------------------
    CREATE TEMP TABLE t_val (entity_code text, attribute_code text, val text) ON COMMIT DROP;

    INSERT INTO t_val VALUES
        ('CLOS-FUND', 'FUND_TYPE', 'CLO'),
        ('CLOS-FUND', 'NAV_CURRENCY', 'USD'),
        -- transaction terms
        ('CLOS-TXN', 'CLO_CLOSING_DATE', '2024-03-15'),
        ('CLOS-TXN', 'CLO_EFFECTIVE_DATE', '2024-09-15'),
        ('CLOS-TXN', 'CLO_REINVESTMENT_PERIOD_END', '2028-04-15'),
        ('CLOS-TXN', 'CLO_NON_CALL_END', '2026-04-15'),
        ('CLOS-TXN', 'CLO_STATED_MATURITY', '2034-10-15'),
        ('CLOS-TXN', 'CLO_NEXT_DETERMINATION_DATE', '2026-10-08'),
        ('CLOS-TXN', 'CLO_NEXT_PAYMENT_DATE', '2026-10-15'),
        ('CLOS-TXN', 'CLO_PAYMENT_FREQUENCY', 'Quarterly'),
        ('CLOS-TXN', 'CLO_TARGET_INITIAL_PAR', '400000000'),
        ('CLOS-TXN', 'CLO_SENIOR_EXPENSES', '500000'),
        ('CLOS-TXN', 'CLO_MAX_SINGLE_OBLIGOR_PCT', '2.0'),
        ('CLOS-TXN', 'CLO_MAX_CCC_PCT', '7.5'),
        ('CLOS-TXN', 'CLO_MAX_COV_LITE_PCT', '60'),
        ('CLOS-TXN', 'CLO_MAX_SECOND_LIEN_PCT', '10'),
        ('CLOS-TXN', 'CLO_MAX_FIXED_RATE_PCT', '5'),
        ('CLOS-TXN', 'CLO_MAX_DISCOUNT_PCT', '10'),
        ('CLOS-TXN', 'CLO_MAX_NON_USD_PCT', '5'),
        ('CLOS-TXN', 'CLO_MAX_DELAYED_DRAW_REVOLVER_PCT', '5'),
        ('CLOS-TXN', 'CLO_MAX_PARTICIPATION_PCT', '5'),
        ('CLOS-TXN', 'CLO_MAX_DEFERRING_PCT', '5'),
        ('CLOS-TXN', 'CLO_MAX_WARF', '3200'),
        ('CLOS-TXN', 'CLO_MIN_WAS_BPS', '350'),
        ('CLOS-TXN', 'CLO_MIN_WARR', '40'),
        ('CLOS-TXN', 'CLO_MAX_WAL_YEARS', '6.0'),
        ('CLOS-TXN', 'CLO_MIN_DIVERSITY_SCORE', '55');

    -- note classes: par, seniority, interest due, triggers
    INSERT INTO t_val
    SELECT n.code, a.attr, a.val
    FROM (VALUES
        ('CLOS-NOTE-A', 'A', 1, 215000000, 150, 3120000, 124.0, 130.0, 'AAA', 'Aaa'),
        ('CLOS-NOTE-B', 'B', 2, 35000000, 175, 700000, 118.0, 125.0, 'AA', 'Aa2'),
        ('CLOS-NOTE-C', 'C', 3, 25000000, 225, 620000, 112.0, 120.0, 'A', 'A2'),
        ('CLOS-NOTE-D', 'D', 4, 22000000, 350, 600000, 108.0, 112.0, 'BBB-', 'Baa3'),
        ('CLOS-NOTE-E', 'E', 5, 18000000, 625, 650000, 120.0, 106.0, 'BB-', 'Ba3'),
        ('CLOS-NOTE-SUB', 'SUB', 6, 45000000, 0, 0, NULL, NULL, NULL, NULL)
    ) AS n(code, cls, rank, par, spread, due, oc, ic, sp, mo)
    CROSS JOIN LATERAL (VALUES
        ('CLO_NOTE_CLASS_CODE', n.cls),
        ('CLO_NOTE_SENIORITY_RANK', n.rank::text),
        ('CLO_NOTE_IS_DEFERRABLE', CASE WHEN n.rank >= 3 THEN 'true' ELSE 'false' END),
        ('CLO_NOTE_ORIGINAL_PAR', n.par::text),
        ('CLO_NOTE_PAR_OUTSTANDING', n.par::text),
        ('CLO_NOTE_INTEREST_DUE', n.due::text),
        ('CLO_NOTE_SPREAD_BPS', n.spread::text),
        ('CLO_NOTE_OC_TRIGGER', n.oc::text),
        ('CLO_NOTE_IC_TRIGGER', n.ic::text),
        ('CLO_NOTE_RATING_SP', n.sp),
        ('CLO_NOTE_RATING_MOODYS', n.mo)
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    INSERT INTO t_val
    SELECT x.code, a.attr, a.val
    FROM (VALUES
        ('CLOS-ACCT-PRIN', 'PRINCIPAL', 6500000),
        ('CLOS-ACCT-INT', 'INTEREST', 4200000),
        ('CLOS-ACCT-EXP', 'EXPENSE_RESERVE', 400000),
        ('CLOS-ACCT-RAMP', 'RAMP_UP', 0)
    ) AS x(code, typ, bal)
    CROSS JOIN LATERAL (VALUES
        ('CLO_ACCT_TYPE', x.typ),
        ('CLO_ACCT_CURRENCY', 'USD'),
        ('CLO_ACCT_BALANCE', x.bal::text),
        ('CLO_ACCT_UNINVESTED_PROCEEDS', '0')
    ) AS a(attr, val);

    -- issuers
    INSERT INTO t_val
    SELECT 'CLOS-ISS-' || p.k, a.attr, a.val
    FROM t_pos p
    CROSS JOIN LATERAL (VALUES
        ('ISSUER_LEGAL_NAME', 'Sample Obligor ' || p.k || ' Holdings'),
        ('MOODYS_INDUSTRY_CODE', p.industry),
        ('OBLIGOR_GROUP_ID', p.obligor_group),
        ('COUNTRY_OF_DOMICILE', 'US'),
        ('MOODYS_ISSUER_RATING', p.mrating)
    ) AS a(attr, val);

    -- securities
    INSERT INTO t_val
    SELECT 'CLOS-SEC-' || p.k, a.attr, a.val
    FROM t_pos p
    CROSS JOIN LATERAL (VALUES
        ('CLO_LOAN_TYPE', p.loan_type),
        ('LIEN_PRIORITY', p.lien),
        ('IS_COV_LITE', p.cov_lite::text),
        ('IS_FIXED_RATE', p.fixed_rate::text),
        ('IS_REVOLVER', 'false'),
        ('IS_DELAYED_DRAW', 'false'),
        ('IS_PARTICIPATION', 'false'),
        ('IS_CONVERTIBLE', 'false'),
        ('IS_DEFERRING_INTEREST', 'false'),
        ('IS_DEFAULTED', p.defaulted::text),
        ('SPREAD_BPS', p.spread::text),
        ('MATURITY_DATE', p.maturity::text),
        ('DENOMINATION_CURRENCY', 'USD'),
        ('CLO_MOODYS_FACILITY_RATING', p.mrating),
        ('CLO_SP_FACILITY_RATING', p.sprating),
        ('CLO_MOODYS_RATING_FACTOR', metadata_register.rating_scale_value('MOODYS_RATING_SCALE', p.mrating, 'rating_factor')::text),
        ('CLO_MOODYS_RATING_ORDINAL', metadata_register.rating_scale_value('MOODYS_RATING_SCALE', p.mrating, 'ordinal')::text),
        ('CLO_SP_RATING_ORDINAL', metadata_register.rating_scale_value('SP_RATING_SCALE', p.sprating, 'ordinal')::text),
        ('CLO_IS_CCC', p.is_ccc::text),
        ('CLO_MOODYS_RECOVERY_RATE', p.recovery::text)
    ) AS a(attr, val);

    -- positions
    INSERT INTO t_val
    SELECT 'CLOS-POS-' || p.k, a.attr, a.val
    FROM t_pos p
    CROSS JOIN LATERAL (VALUES
        ('FUNDED_PAR_AMOUNT', p.par::text),
        ('UNFUNDED_COMMITMENT_AMOUNT', '0'),
        ('FAIR_MARKET_PRICE', p.price::text),
        ('CLO_IS_DISCOUNT_OBLIGATION', p.discount::text),
        ('CLO_EXPECTED_INTEREST', CASE WHEN p.defaulted THEN '0'
                                       ELSE round(p.par * (0.043 + p.spread / 10000.0) / 4, 2)::text END),
        ('POSITION_IS_HYPOTHETICAL', p.hypothetical::text)
    ) AS a(attr, val);
    INSERT INTO t_val
    SELECT 'CLOS-POS-' || p.k, 'CLO_DISCOUNT_HAIRCUT', round(p.par * (100 - p.price) / 100, 2)::text
    FROM t_pos p WHERE p.discount;
    INSERT INTO t_val
    SELECT 'CLOS-POS-' || p.k, 'CLO_DEFAULT_CARRY_VALUE', '2000000'
    FROM t_pos p WHERE p.defaulted;
    INSERT INTO t_val VALUES
        ('CLOS-POS-62', 'POSITION_SCENARIO_CODE', 'CLOS-BUY-CCC'),
        ('CLOS-POS-63', 'POSITION_SCENARIO_CODE', 'CLOS-BUY-B2');

    DELETE FROM golden_master.entity_attribute_values eav
    USING entity_instances.master_entities me, metadata_register.attribute_register ar, t_val v
    WHERE eav.entity_id = me.id
      AND me.entity_code = v.entity_code
      AND eav.attribute_id = ar.id
      AND ar.attribute_code = v.attribute_code;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_src, v.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') AND v.val ~ '^-?[0-9]+(\.[0-9]+)?$' THEN v.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' AND v.val ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN v.val::date END,
           CASE WHEN ar.data_type = 'BOOLEAN' THEN v.val::boolean END,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"cloSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    -- --------------------------------------------------------
    -- Relationships. The fund is the parent of its CLO entities. A position is
    -- the parent of its fund and its security. A security is the parent of its issuer.
    -- --------------------------------------------------------
    CREATE TEMP TABLE t_rel (parent_code text, child_code text, rel_code text) ON COMMIT DROP;
    INSERT INTO t_rel VALUES
        ('CLOS-FUND', 'CLOS-TXN', 'FUND_CLO_TRANSACTION'),
        ('CLOS-FUND', 'CLOS-NOTE-A', 'FUND_CLO_NOTE_CLASS'),
        ('CLOS-FUND', 'CLOS-NOTE-B', 'FUND_CLO_NOTE_CLASS'),
        ('CLOS-FUND', 'CLOS-NOTE-C', 'FUND_CLO_NOTE_CLASS'),
        ('CLOS-FUND', 'CLOS-NOTE-D', 'FUND_CLO_NOTE_CLASS'),
        ('CLOS-FUND', 'CLOS-NOTE-E', 'FUND_CLO_NOTE_CLASS'),
        ('CLOS-FUND', 'CLOS-NOTE-SUB', 'FUND_CLO_NOTE_CLASS'),
        ('CLOS-FUND', 'CLOS-ACCT-PRIN', 'FUND_CLO_ACCOUNT'),
        ('CLOS-FUND', 'CLOS-ACCT-INT', 'FUND_CLO_ACCOUNT'),
        ('CLOS-FUND', 'CLOS-ACCT-EXP', 'FUND_CLO_ACCOUNT'),
        ('CLOS-FUND', 'CLOS-ACCT-RAMP', 'FUND_CLO_ACCOUNT');
    INSERT INTO t_rel SELECT 'CLOS-POS-' || k, 'CLOS-FUND', 'POSITION_FUND' FROM t_pos;
    INSERT INTO t_rel SELECT 'CLOS-POS-' || k, 'CLOS-SEC-' || k, 'POSITION_SECURITY' FROM t_pos;
    INSERT INTO t_rel SELECT 'CLOS-SEC-' || k, 'CLOS-ISS-' || k, 'SECURITY_ISSUER' FROM t_pos;

    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from, metadata
    )
    SELECT p.id, c.id, rt.relationship_name, r.rel_code, TRUE, DATE '2020-01-01', '{"cloSample":true}'::jsonb
    FROM t_rel r
    JOIN entity_instances.master_entities p ON p.entity_code = r.parent_code
    JOIN entity_instances.master_entities c ON c.entity_code = r.child_code
    JOIN metadata_register.relationship_types rt ON rt.relationship_code = r.rel_code
    WHERE NOT EXISTS (
        SELECT 1 FROM entity_instances.entity_relationships er
        WHERE er.parent_entity_id = p.id
          AND er.child_entity_id = c.id
          AND er.relationship_code = r.rel_code
          AND er.valid_from = DATE '2020-01-01'
    );

    -- --------------------------------------------------------
    -- Run every CLO rule, then both pre-trade checks. A rule that errors is
    -- reported and the rest still run.
    -- --------------------------------------------------------
    SELECT id INTO v_fund FROM entity_instances.master_entities WHERE entity_code = 'CLOS-FUND';

    FOR v_code IN SELECT rule_code FROM compliance.rules WHERE rule_code LIKE 'CLO\_%' ORDER BY rule_code LOOP
        BEGIN
            v_run := compliance.evaluate_rule(v_code, v_asof, now(), NULL, NULL, v_fund, NULL);
            v_runs := v_runs || v_run;
        EXCEPTION WHEN OTHERS THEN
            v_fail := v_fail + 1;
            RAISE NOTICE 'CLO SAMPLE RULE ERROR % : %', v_code, SQLERRM;
        END;
    END LOOP;

    FOR v_row IN
        SELECT r.rule_code, res.group_by_value, res.computed_value, res.hard_limit_value, res.status,
               res.detail -> 'excess_amount' AS excess
        FROM compliance.rule_evaluation_results res
        JOIN compliance.rules r ON r.id = res.rule_id
        WHERE res.run_id = ANY (v_runs) AND res.anchor_entity_id = v_fund
        ORDER BY r.rule_code, res.rank_position NULLS LAST, res.group_by_value
    LOOP
        IF v_row.group_by_value IS NULL OR v_row.status <> 'PASS' THEN
            RAISE NOTICE 'CLO SAMPLE % [%] value=% limit=% % excess=%',
                v_row.rule_code, COALESCE(v_row.group_by_value, '-'), round(v_row.computed_value, 4),
                v_row.hard_limit_value, v_row.status, v_row.excess;
        END IF;
    END LOOP;

    FOREACH v_scen IN ARRAY ARRAY['CLOS-BUY-CCC', 'CLOS-BUY-B2'] LOOP
        BEGIN
            FOR v_row IN
                SELECT * FROM compliance.evaluate_pre_trade(v_fund, v_scen, v_asof)
                WHERE verdict <> 'PASS'
                ORDER BY rule_code, group_by_value
            LOOP
                RAISE NOTICE 'CLO PRETRADE % % [%] % -> % : % approved=%',
                    v_scen, v_row.rule_code, COALESCE(v_row.group_by_value, '-'),
                    round(v_row.baseline_value, 4), round(v_row.scenario_value, 4), v_row.verdict, v_row.approved;
            END LOOP;
        EXCEPTION WHEN OTHERS THEN
            v_fail := v_fail + 1;
            RAISE NOTICE 'CLO PRETRADE ERROR % : %', v_scen, SQLERRM;
        END;
    END LOOP;

    RAISE NOTICE 'CLO sample done: % rule runs, % errors', COALESCE(array_length(v_runs, 1), 0), v_fail;
END $$;

NOTIFY pgrst, 'reload schema';
