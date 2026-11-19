-- Sample covenant definitions.
--
-- The borrower statements get the memo lines agreements adjust for:
-- restricted cash, letters of credit, restructuring, transaction costs,
-- stock compensation, and run-rate cost savings.
--
-- The library holds three definitions to copy from and one house standard per
-- metric. Each sample deal's covenants are then defined differently, the way
-- their credit agreements would be:
--   Halyard    net leverage, cash netting capped at $25m, capped add-backs
--   Cormorant  total leverage, letters of credit count as debt, no netting
--   Linden     net leverage, unlimited netting, cost savings capped at $3m
--   Northwind  total leverage on the test quarter annualized
--   Quillon    net leverage, amended from 2026-04-01: the netting cap rises
--              from $10m to $20m and cost savings become an add-back
-- Interest coverage and liquidity follow the same pattern.
--
-- The borrower's certificate values replace the sample readings that were
-- stored as COVENANT_CURRENT. They sit on the BORROWER_CERTIFICATE source and
-- the calculation stays the golden value.

DO $$
DECLARE
    v_client uuid;
    v_test uuid;
    v_cert uuid;
    v_cov_template uuid;
    v_comp_template uuid;
    v_attr uuid;
BEGIN
    SELECT client_id INTO v_client FROM entity_instances.master_entities WHERE entity_code = 'HALY-DEAL-HALYARD';
    SELECT id INTO v_test FROM entity_instances.source_registry
    WHERE source_code IN ('TEST', 'MANUAL')
    ORDER BY CASE source_code WHEN 'TEST' THEN 0 ELSE 1 END
    LIMIT 1;
    SELECT id INTO v_cert FROM entity_instances.source_registry WHERE source_code = 'BORROWER_CERTIFICATE';
    SELECT id INTO v_cov_template FROM metadata_register.domain_templates WHERE template_code = 'DEAL_COVENANT_STANDARD';
    SELECT id INTO v_comp_template FROM metadata_register.domain_templates WHERE template_code = 'COVENANT_COMPONENT_STANDARD';
    IF v_client IS NULL OR v_test IS NULL OR v_cert IS NULL THEN
        RAISE NOTICE 'Skipping covenant samples: client % source % certificate %', v_client, v_test, v_cert;
        RETURN;
    END IF;

    -- --------------------------------------------------------
    -- 1. Memo lines on every sample statement
    -- --------------------------------------------------------
    CREATE TEMP TABLE t_stmt ON COMMIT DROP AS
    SELECT s.id,
           golden_master.golden_date(s.id, 'STATEMENT_END'::varchar, CURRENT_DATE) AS period_end,
           COALESCE(golden_master.golden_numeric(s.id, 'STATEMENT_REVENUE'::varchar, CURRENT_DATE, 0), 0) AS revenue,
           COALESCE(golden_master.golden_numeric(s.id, 'STATEMENT_CASH'::varchar, CURRENT_DATE, 0), 0) AS cash,
           COALESCE(golden_master.golden_numeric(s.id, 'STATEMENT_DEBT'::varchar, CURRENT_DATE, 0), 0) AS debt,
           0.6 + (abs(hashtext(split_part(s.entity_code, '-', 3))) % 9) / 10.0 AS f
    FROM entity_instances.master_entities s
    WHERE s.domain_code = 'STATEMENT_PERIOD'
      AND s.client_id = v_client
      AND s.entity_code LIKE 'HALY-STMT-%';

    CREATE TEMP TABLE t_memo (entity_id uuid, attribute_code text, val numeric) ON COMMIT DROP;
    INSERT INTO t_memo
    SELECT s.id, m.code, round(m.val)
    FROM t_stmt s
    CROSS JOIN LATERAL (VALUES
        ('STATEMENT_RESTRICTED_CASH', s.cash * 0.12),
        ('STATEMENT_LC_OUTSTANDING', s.debt * 0.03),
        ('STATEMENT_RESTRUCTURING', CASE WHEN extract(month FROM s.period_end) IN (6, 12) THEN s.revenue * 0.015 * s.f ELSE 0 END),
        ('STATEMENT_TRANSACTION_COSTS', CASE WHEN extract(month FROM s.period_end) = 9 THEN s.revenue * 0.006 * s.f ELSE 0 END),
        ('STATEMENT_STOCK_COMP', s.revenue * 0.008 * s.f),
        ('STATEMENT_PF_SYNERGIES', s.revenue * 0.01 * s.f)
    ) AS m(code, val)
    WHERE s.period_end IS NOT NULL;

    DELETE FROM golden_master.entity_attribute_values eav
    USING t_memo m, metadata_register.attribute_register ar
    WHERE eav.entity_id = m.entity_id
      AND ar.attribute_code = m.attribute_code
      AND eav.attribute_id = ar.id;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT m.entity_id, ar.id, v_test, m.val::text, m.val,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"covenantSample":true}'::jsonb
    FROM t_memo m
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = m.attribute_code;

    -- --------------------------------------------------------
    -- 2. Library and house definitions
    -- --------------------------------------------------------
    CREATE TEMP TABLE t_lib (code text, name text, descr text, metric text, direction text, unit text, is_house boolean) ON COMMIT DROP;
    INSERT INTO t_lib VALUES
        ('COVLIB-HOUSE-NET-LEV', 'House standard: net leverage', 'Term loan less unrestricted cash, over LTM EBITDA with no add-backs. Computed for every deal so they can be compared.', 'NET_LEVERAGE', 'MAX', 'MULTIPLE', TRUE),
        ('COVLIB-HOUSE-TOTAL-LEV', 'House standard: total leverage', 'Term loan and letters of credit, over LTM EBITDA with no add-backs.', 'TOTAL_LEVERAGE', 'MAX', 'MULTIPLE', TRUE),
        ('COVLIB-HOUSE-INT-COV', 'House standard: interest coverage', 'LTM EBITDA over LTM interest expense, with no add-backs.', 'INTEREST_COVERAGE', 'MIN', 'MULTIPLE', TRUE),
        ('COVLIB-HOUSE-LIQUIDITY', 'House standard: liquidity', 'Unrestricted cash at the test date.', 'LIQUIDITY', 'MIN', 'CURRENCY', TRUE),
        ('COVLIB-NET-LEV-SPONSOR', 'Sponsor net leverage (LTM)', 'Net debt with cash netting capped at $25m, over LTM EBITDA with capped add-backs for restructuring, transaction costs, and cost savings.', 'NET_LEVERAGE', 'MAX', 'MULTIPLE', FALSE),
        ('COVLIB-TOTAL-LEV', 'Total leverage, limited add-backs', 'Term loan and letters of credit, over LTM EBITDA with restructuring capped at 10%.', 'TOTAL_LEVERAGE', 'MAX', 'MULTIPLE', FALSE),
        ('COVLIB-INT-COV', 'Interest coverage with stock compensation', 'LTM EBITDA plus stock compensation, over LTM interest expense.', 'INTEREST_COVERAGE', 'MIN', 'MULTIPLE', FALSE);

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, description, client_id, metadata
    )
    SELECT l.code, 'DEAL_COVENANT', v_cov_template, l.name, l.descr, v_client, '{"covenantSample":true}'::jsonb
    FROM t_lib l
    ON CONFLICT (entity_code) DO UPDATE
    SET entity_name = EXCLUDED.entity_name,
        description = EXCLUDED.description,
        template_id = EXCLUDED.template_id,
        is_active = TRUE,
        client_id = EXCLUDED.client_id,
        metadata = EXCLUDED.metadata;

    -- --------------------------------------------------------
    -- 3. Components
    -- --------------------------------------------------------
    CREATE TEMP TABLE t_comp (
        cov_code text, ord int, name text, side text, line text, sign text, measure text,
        cap_type text, cap_value numeric, eff_from date, eff_to date, clause text
    ) ON COMMIT DROP;

    INSERT INTO t_comp VALUES
        -- House standards
        ('COVLIB-HOUSE-NET-LEV', 1, 'Term loan', 'NUMERATOR', 'STATEMENT_DEBT', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, NULL),
        ('COVLIB-HOUSE-NET-LEV', 2, 'Unrestricted cash', 'NUMERATOR', 'STATEMENT_UNRESTRICTED_CASH', 'SUBTRACT', 'POINT', 'NONE', NULL, NULL, NULL, NULL),
        ('COVLIB-HOUSE-NET-LEV', 3, 'EBITDA', 'DENOMINATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, NULL),
        ('COVLIB-HOUSE-TOTAL-LEV', 1, 'Term loan', 'NUMERATOR', 'STATEMENT_DEBT', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, NULL),
        ('COVLIB-HOUSE-TOTAL-LEV', 2, 'Letters of credit', 'NUMERATOR', 'STATEMENT_LC_OUTSTANDING', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, NULL),
        ('COVLIB-HOUSE-TOTAL-LEV', 3, 'EBITDA', 'DENOMINATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, NULL),
        ('COVLIB-HOUSE-INT-COV', 1, 'EBITDA', 'NUMERATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, NULL),
        ('COVLIB-HOUSE-INT-COV', 2, 'Interest expense', 'DENOMINATOR', 'STATEMENT_INTEREST', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, NULL),
        ('COVLIB-HOUSE-LIQUIDITY', 1, 'Unrestricted cash', 'NUMERATOR', 'STATEMENT_UNRESTRICTED_CASH', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, NULL),
        -- Library
        ('COVLIB-NET-LEV-SPONSOR', 1, 'Term loan', 'NUMERATOR', 'STATEMENT_DEBT', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Consolidated Total Debt (a)'),
        ('COVLIB-NET-LEV-SPONSOR', 2, 'Letters of credit', 'NUMERATOR', 'STATEMENT_LC_OUTSTANDING', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Consolidated Total Debt (d)'),
        ('COVLIB-NET-LEV-SPONSOR', 3, 'Unrestricted cash, up to $25m', 'NUMERATOR', 'STATEMENT_UNRESTRICTED_CASH', 'SUBTRACT', 'POINT', 'AMOUNT', 25000000, NULL, NULL, '1.01 Consolidated Total Net Debt'),
        ('COVLIB-NET-LEV-SPONSOR', 4, 'EBITDA', 'DENOMINATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated EBITDA (a)'),
        ('COVLIB-NET-LEV-SPONSOR', 5, 'Stock compensation', 'DENOMINATOR', 'STATEMENT_STOCK_COMP', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated EBITDA (b)(v)'),
        ('COVLIB-NET-LEV-SPONSOR', 6, 'Restructuring, up to 15%', 'DENOMINATOR', 'STATEMENT_RESTRUCTURING', 'ADD', 'LTM', 'PCT_OF_BASE', 15, NULL, NULL, '1.01 Consolidated EBITDA (b)(iii)'),
        ('COVLIB-NET-LEV-SPONSOR', 7, 'Transaction costs, up to 10%', 'DENOMINATOR', 'STATEMENT_TRANSACTION_COSTS', 'ADD', 'LTM', 'PCT_OF_BASE', 10, NULL, NULL, '1.01 Consolidated EBITDA (b)(iv)'),
        ('COVLIB-NET-LEV-SPONSOR', 8, 'Run-rate cost savings, up to 10%', 'DENOMINATOR', 'STATEMENT_PF_SYNERGIES', 'ADD', 'LTM', 'PCT_OF_BASE', 10, NULL, NULL, '1.01 Consolidated EBITDA (b)(ix)'),
        ('COVLIB-TOTAL-LEV', 1, 'Term loan', 'NUMERATOR', 'STATEMENT_DEBT', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Total Indebtedness (a)'),
        ('COVLIB-TOTAL-LEV', 2, 'Letters of credit', 'NUMERATOR', 'STATEMENT_LC_OUTSTANDING', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Total Indebtedness (c)'),
        ('COVLIB-TOTAL-LEV', 3, 'EBITDA', 'DENOMINATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 EBITDA (a)'),
        ('COVLIB-TOTAL-LEV', 4, 'Restructuring, up to 10%', 'DENOMINATOR', 'STATEMENT_RESTRUCTURING', 'ADD', 'LTM', 'PCT_OF_BASE', 10, NULL, NULL, '1.01 EBITDA (b)(ii)'),
        ('COVLIB-INT-COV', 1, 'EBITDA', 'NUMERATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated EBITDA'),
        ('COVLIB-INT-COV', 2, 'Stock compensation', 'NUMERATOR', 'STATEMENT_STOCK_COMP', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated EBITDA (b)(v)'),
        ('COVLIB-INT-COV', 3, 'Interest expense', 'DENOMINATOR', 'STATEMENT_INTEREST', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated Interest Expense'),
        -- Halyard: the sponsor definition
        ('HALY-COV-HALYARD-1', 1, 'Term loan', 'NUMERATOR', 'STATEMENT_DEBT', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Consolidated Total Debt (a)'),
        ('HALY-COV-HALYARD-1', 2, 'Letters of credit', 'NUMERATOR', 'STATEMENT_LC_OUTSTANDING', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Consolidated Total Debt (d)'),
        ('HALY-COV-HALYARD-1', 3, 'Unrestricted cash, up to $25m', 'NUMERATOR', 'STATEMENT_UNRESTRICTED_CASH', 'SUBTRACT', 'POINT', 'AMOUNT', 25000000, NULL, NULL, '1.01 Consolidated Total Net Debt'),
        ('HALY-COV-HALYARD-1', 4, 'EBITDA', 'DENOMINATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated EBITDA (a)'),
        ('HALY-COV-HALYARD-1', 5, 'Stock compensation', 'DENOMINATOR', 'STATEMENT_STOCK_COMP', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated EBITDA (b)(v)'),
        ('HALY-COV-HALYARD-1', 6, 'Restructuring, up to 15%', 'DENOMINATOR', 'STATEMENT_RESTRUCTURING', 'ADD', 'LTM', 'PCT_OF_BASE', 15, NULL, NULL, '1.01 Consolidated EBITDA (b)(iii)'),
        ('HALY-COV-HALYARD-1', 7, 'Transaction costs, up to 10%', 'DENOMINATOR', 'STATEMENT_TRANSACTION_COSTS', 'ADD', 'LTM', 'PCT_OF_BASE', 10, NULL, NULL, '1.01 Consolidated EBITDA (b)(iv)'),
        ('HALY-COV-HALYARD-1', 8, 'Run-rate cost savings, up to 10%', 'DENOMINATOR', 'STATEMENT_PF_SYNERGIES', 'ADD', 'LTM', 'PCT_OF_BASE', 10, NULL, NULL, '1.01 Consolidated EBITDA (b)(ix)'),
        ('HALY-COV-HALYARD-2', 1, 'EBITDA', 'NUMERATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated EBITDA (a)'),
        ('HALY-COV-HALYARD-2', 2, 'Stock compensation', 'NUMERATOR', 'STATEMENT_STOCK_COMP', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated EBITDA (b)(v)'),
        ('HALY-COV-HALYARD-2', 3, 'Restructuring, up to 15%', 'NUMERATOR', 'STATEMENT_RESTRUCTURING', 'ADD', 'LTM', 'PCT_OF_BASE', 15, NULL, NULL, '1.01 Consolidated EBITDA (b)(iii)'),
        ('HALY-COV-HALYARD-2', 4, 'Interest expense', 'DENOMINATOR', 'STATEMENT_INTEREST', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated Interest Expense'),
        ('HALY-COV-HALYARD-3', 1, 'Unrestricted cash', 'NUMERATOR', 'STATEMENT_UNRESTRICTED_CASH', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '7.11(c) Liquidity'),
        -- Cormorant: total leverage, no netting
        ('HALY-COV-CORMORANT-1', 1, 'Term loan', 'NUMERATOR', 'STATEMENT_DEBT', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Total Indebtedness (a)'),
        ('HALY-COV-CORMORANT-1', 2, 'Letters of credit', 'NUMERATOR', 'STATEMENT_LC_OUTSTANDING', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Total Indebtedness (c)'),
        ('HALY-COV-CORMORANT-1', 3, 'EBITDA', 'DENOMINATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 EBITDA (a)'),
        ('HALY-COV-CORMORANT-1', 4, 'Restructuring, up to 10%', 'DENOMINATOR', 'STATEMENT_RESTRUCTURING', 'ADD', 'LTM', 'PCT_OF_BASE', 10, NULL, NULL, '1.01 EBITDA (b)(ii)'),
        ('HALY-COV-CORMORANT-2', 1, 'EBITDA', 'NUMERATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 EBITDA (a)'),
        ('HALY-COV-CORMORANT-2', 2, 'Interest expense', 'DENOMINATOR', 'STATEMENT_INTEREST', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Interest Expense'),
        ('HALY-COV-CORMORANT-3', 1, 'Cash', 'NUMERATOR', 'STATEMENT_CASH', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '6.12 Minimum Liquidity'),
        -- Linden: net leverage, unlimited netting, savings capped at $3m
        ('HALY-COV-LINDEN-1', 1, 'Term loan', 'NUMERATOR', 'STATEMENT_DEBT', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Funded Debt'),
        ('HALY-COV-LINDEN-1', 2, 'Unrestricted cash', 'NUMERATOR', 'STATEMENT_UNRESTRICTED_CASH', 'SUBTRACT', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Net Funded Debt'),
        ('HALY-COV-LINDEN-1', 3, 'EBITDA', 'DENOMINATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Adjusted EBITDA (a)'),
        ('HALY-COV-LINDEN-1', 4, 'Stock compensation', 'DENOMINATOR', 'STATEMENT_STOCK_COMP', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Adjusted EBITDA (b)(iv)'),
        ('HALY-COV-LINDEN-1', 5, 'Run-rate cost savings, up to $3m', 'DENOMINATOR', 'STATEMENT_PF_SYNERGIES', 'ADD', 'LTM', 'AMOUNT', 3000000, NULL, NULL, '1.01 Adjusted EBITDA (b)(vii)'),
        ('HALY-COV-LINDEN-2', 1, 'EBITDA', 'NUMERATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Adjusted EBITDA (a)'),
        ('HALY-COV-LINDEN-2', 2, 'Stock compensation', 'NUMERATOR', 'STATEMENT_STOCK_COMP', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Adjusted EBITDA (b)(iv)'),
        ('HALY-COV-LINDEN-2', 3, 'Interest expense', 'DENOMINATOR', 'STATEMENT_INTEREST', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Cash Interest Expense'),
        ('HALY-COV-LINDEN-3', 1, 'Unrestricted cash', 'NUMERATOR', 'STATEMENT_UNRESTRICTED_CASH', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '7.1(c) Liquidity'),
        -- Northwind: total leverage on the test quarter annualized
        ('HALY-COV-NORTHWIND-1', 1, 'Term loan', 'NUMERATOR', 'STATEMENT_DEBT', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Total Debt'),
        ('HALY-COV-NORTHWIND-1', 2, 'EBITDA, quarter annualized', 'DENOMINATOR', 'STATEMENT_EBITDA', 'ADD', 'ANNUALIZED', 'NONE', NULL, NULL, NULL, '1.01 Annualized EBITDA'),
        ('HALY-COV-NORTHWIND-2', 1, 'EBITDA', 'NUMERATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 EBITDA'),
        ('HALY-COV-NORTHWIND-2', 2, 'Interest expense', 'DENOMINATOR', 'STATEMENT_INTEREST', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Interest Expense'),
        ('HALY-COV-NORTHWIND-3', 1, 'Unrestricted cash', 'NUMERATOR', 'STATEMENT_UNRESTRICTED_CASH', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '6.9 Liquidity'),
        -- Quillon: net leverage, amended from 2026-04-01
        ('HALY-COV-QUILLON-1', 1, 'Term loan', 'NUMERATOR', 'STATEMENT_DEBT', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '1.01 Consolidated Debt'),
        ('HALY-COV-QUILLON-1', 2, 'Unrestricted cash, up to $10m', 'NUMERATOR', 'STATEMENT_UNRESTRICTED_CASH', 'SUBTRACT', 'POINT', 'AMOUNT', 10000000, NULL, DATE '2026-03-31', '1.01 Consolidated Net Debt'),
        ('HALY-COV-QUILLON-1', 3, 'Unrestricted cash, up to $20m', 'NUMERATOR', 'STATEMENT_UNRESTRICTED_CASH', 'SUBTRACT', 'POINT', 'AMOUNT', 20000000, DATE '2026-04-01', NULL, 'First Amendment 2(a)'),
        ('HALY-COV-QUILLON-1', 4, 'EBITDA', 'DENOMINATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated EBITDA'),
        ('HALY-COV-QUILLON-1', 5, 'Run-rate cost savings, up to 10%', 'DENOMINATOR', 'STATEMENT_PF_SYNERGIES', 'ADD', 'LTM', 'PCT_OF_BASE', 10, DATE '2026-04-01', NULL, 'First Amendment 2(b)'),
        ('HALY-COV-QUILLON-2', 1, 'EBITDA', 'NUMERATOR', 'STATEMENT_EBITDA', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated EBITDA'),
        ('HALY-COV-QUILLON-2', 2, 'Interest expense', 'DENOMINATOR', 'STATEMENT_INTEREST', 'ADD', 'LTM', 'NONE', NULL, NULL, NULL, '1.01 Consolidated Interest Expense'),
        ('HALY-COV-QUILLON-3', 1, 'Unrestricted cash', 'NUMERATOR', 'STATEMENT_UNRESTRICTED_CASH', 'ADD', 'POINT', 'NONE', NULL, NULL, NULL, '7.12 Liquidity');

    -- Only covenants that exist in this database.
    DELETE FROM t_comp c
    WHERE NOT EXISTS (SELECT 1 FROM entity_instances.master_entities me WHERE me.entity_code = c.cov_code);

    INSERT INTO entity_instances.master_entities (
        entity_code, domain_code, template_id, entity_name, client_id, metadata
    )
    SELECT c.cov_code || '-L' || lpad(c.ord::text, 2, '0'), 'COVENANT_COMPONENT', v_comp_template, c.name, v_client,
           '{"covenantSample":true}'::jsonb
    FROM t_comp c
    ON CONFLICT (entity_code) DO UPDATE
    SET entity_name = EXCLUDED.entity_name,
        template_id = EXCLUDED.template_id,
        domain_code = EXCLUDED.domain_code,
        is_active = TRUE,
        client_id = EXCLUDED.client_id,
        metadata = EXCLUDED.metadata;

    INSERT INTO entity_instances.entity_relationships (
        parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from
    )
    SELECT p.id, cov.id, 'Component of covenant', 'COMPONENT_COVENANT', TRUE, DATE '2020-01-01'
    FROM t_comp c
    JOIN entity_instances.master_entities p ON p.entity_code = c.cov_code || '-L' || lpad(c.ord::text, 2, '0')
    JOIN entity_instances.master_entities cov ON cov.entity_code = c.cov_code
    WHERE NOT EXISTS (
        SELECT 1 FROM entity_instances.entity_relationships r
        WHERE r.parent_entity_id = p.id AND r.child_entity_id = cov.id AND r.relationship_code = 'COMPONENT_COVENANT'
    );

    CREATE TEMP TABLE t_val (entity_code text, attribute_code text, val text) ON COMMIT DROP;

    INSERT INTO t_val
    SELECT c.cov_code || '-L' || lpad(c.ord::text, 2, '0'), a.attr, a.val
    FROM t_comp c
    CROSS JOIN LATERAL (VALUES
        ('COMPONENT_SIDE', c.side),
        ('COMPONENT_LINE', c.line),
        ('COMPONENT_SIGN', c.sign),
        ('COMPONENT_MEASURE', c.measure),
        ('COMPONENT_CAP_TYPE', c.cap_type),
        ('COMPONENT_CAP_VALUE', c.cap_value::text),
        ('COMPONENT_EFFECTIVE_FROM', c.eff_from::text),
        ('COMPONENT_EFFECTIVE_TO', c.eff_to::text),
        ('COMPONENT_CLAUSE', c.clause)
    ) AS a(attr, val)
    WHERE a.val IS NOT NULL;

    INSERT INTO t_val
    SELECT l.code, a.attr, a.val
    FROM t_lib l
    CROSS JOIN LATERAL (VALUES
        ('COVENANT_METRIC', l.metric),
        ('COVENANT_DIRECTION', l.direction),
        ('COVENANT_UNIT', l.unit),
        ('COVENANT_IS_LIBRARY', 'true'),
        ('COVENANT_IS_HOUSE', l.is_house::text)
    ) AS a(attr, val);

    INSERT INTO t_val
    SELECT me.entity_code, 'COVENANT_METRIC', v.metric
    FROM entity_instances.master_entities me
    JOIN (VALUES
        ('HALY-COV-HALYARD-1', 'NET_LEVERAGE'),
        ('HALY-COV-CORMORANT-1', 'TOTAL_LEVERAGE'),
        ('HALY-COV-LINDEN-1', 'NET_LEVERAGE'),
        ('HALY-COV-NORTHWIND-1', 'TOTAL_LEVERAGE'),
        ('HALY-COV-QUILLON-1', 'NET_LEVERAGE')
    ) AS v(code, metric) ON v.code = me.entity_code;

    INSERT INTO t_val
    SELECT me.entity_code, 'COVENANT_METRIC',
           CASE split_part(me.entity_code, '-', 4) WHEN '2' THEN 'INTEREST_COVERAGE' ELSE 'LIQUIDITY' END
    FROM entity_instances.master_entities me
    WHERE me.domain_code = 'DEAL_COVENANT'
      AND me.entity_code LIKE 'HALY-COV-%'
      AND split_part(me.entity_code, '-', 4) IN ('2', '3');

    DELETE FROM golden_master.entity_attribute_values eav
    USING entity_instances.master_entities me,
          metadata_register.attribute_register ar,
          t_val v
    WHERE eav.entity_id = me.id
      AND me.entity_code = v.entity_code
      AND eav.attribute_id = ar.id
      AND ar.attribute_code = v.attribute_code;

    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value,
        golden_value_numeric, golden_value_date, golden_value_boolean,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT me.id, ar.id, v_test, v.val,
           CASE WHEN ar.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL') THEN v.val::numeric END,
           CASE WHEN ar.data_type = 'DATE' THEN v.val::date END,
           CASE WHEN ar.data_type = 'BOOLEAN' THEN v.val::boolean END,
           DATE '2020-01-01', DATE '9999-12-31', 100, '{"covenantSample":true}'::jsonb
    FROM t_val v
    JOIN entity_instances.master_entities me ON me.entity_code = v.entity_code
    JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code;

    UPDATE entity_instances.master_entities me
    SET entity_name = 'Maximum net leverage', updated_at = NOW()
    WHERE me.entity_code IN ('HALY-COV-HALYARD-1', 'HALY-COV-LINDEN-1', 'HALY-COV-QUILLON-1');

    -- Two levels close enough to the reading to be worth watching.
    UPDATE golden_master.entity_attribute_values eav
    SET golden_value = v.level::text, golden_value_numeric = v.level
    FROM entity_instances.master_entities me,
         metadata_register.attribute_register ar,
         (VALUES ('HALY-COV-HALYARD-1', 3.25::numeric), ('HALY-COV-CORMORANT-2', 2.75::numeric)) AS v(code, level)
    WHERE me.entity_code = v.code
      AND eav.entity_id = me.id
      AND ar.attribute_code = 'COVENANT_LEVEL'
      AND eav.attribute_id = ar.id
      AND eav.valid_to = DATE '9999-12-31';

    -- --------------------------------------------------------
    -- 4. The borrower's certificate replaces the old sample reading
    -- --------------------------------------------------------
    SELECT id INTO v_attr FROM metadata_register.attribute_register WHERE attribute_code = 'COVENANT_CURRENT';

    DELETE FROM golden_master.entity_attribute_values eav
    USING entity_instances.master_entities me
    WHERE eav.entity_id = me.id
      AND eav.attribute_id = v_attr
      AND me.domain_code = 'DEAL_COVENANT'
      AND me.entity_code LIKE 'HALY-COV-%';

    -- Most borrowers report what the definition gives. Halyard counts its
    -- cost savings without the cap, and Cormorant rounds its coverage up.
    INSERT INTO golden_master.entity_attribute_values (
        entity_id, attribute_id, source_id, golden_value, golden_value_numeric,
        valid_from, valid_to, precedence_rank, metadata
    )
    SELECT x.id, v_attr, v_cert, x.reported::text, x.reported,
           DATE '2026-09-30', DATE '9999-12-31', 100, '{"covenantSample":true}'::jsonb
    FROM (
        SELECT me.id,
               CASE
                   WHEN golden_master.covenant_text(me.id, 'COVENANT_UNIT', DATE '2026-09-30') = 'CURRENCY'
                       THEN round(r.value, -3)
                   WHEN me.entity_code = 'HALY-COV-HALYARD-1' THEN round(r.value - 0.21, 2)
                   WHEN me.entity_code = 'HALY-COV-CORMORANT-2' THEN round(r.value + 0.12, 2)
                   ELSE round(r.value, 2)
               END AS reported
        FROM entity_instances.master_entities me
        CROSS JOIN LATERAL (
            SELECT (golden_master.covenant_evaluate(me.id, me.id, DATE '2026-09-30', 0)->>'value')::numeric AS value
        ) r
        WHERE me.domain_code = 'DEAL_COVENANT'
          AND me.entity_code LIKE 'HALY-COV-%'
          AND r.value IS NOT NULL
    ) x;
END $$;
