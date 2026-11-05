-- Investment Company Act of 1940 guidelines on Harbor Senior Income.
--
-- The rules are category FORTY_ACT and apply only to HALY-FUND-HSI.
-- The allocation surface keeps the fund's existing NAV ($2,000,000,000).
-- TOTAL_AUM and the sample book use that same figure, so the ratios below
-- are shares of the published NAV. MARKET_VALUE is left unset so the older
-- fund-concentration rules, which read MARKET_VALUE, do not pick this book up.
--
-- Scorecard at 2026-09-30 (the sample is built so each of these is the result):
--   no margin / short / physical / affiliated / ineligible custodian  HARD_BREACH
--   institutional sleeve, which has no orders                         PASS
--   300% asset coverage after a new borrow                            HARD_BREACH
--   underwriting 8% vs 5% cap, and a 2% allocation                    HARD and PASS
--   5/25 issuer basket (excess 31% vs 25%)                           HARD_BREACH
--   names at or under 5%                                              PASS
--   voting 12% vs 10%                                                 HARD_BREACH
--   broker-dealer issuer 6% vs 5%                                     HARD_BREACH
--   investment-company ownership 4% vs 3%, and 2%                     HARD and PASS
--   fund-of-funds sleeve 12% vs 10%                                   HARD_BREACH
--   name test 82% vs 80% hard / 85% warning                           SOFT_BREACH
--   one stale price without an override                               HARD_BREACH
--   a manual price with supervisor override                           PASS
--   VaR utilization 1.10 vs 1.00                                      HARD_BREACH
--   board independence 2/6 vs 40%                                     HARD_BREACH
--   lapsed advisory contract                                          HARD_BREACH
--   public offering seeded at $75,000 vs $100,000                     HARD_BREACH
--   annualized 12b-1 rate 0.80% vs 0.75%                              HARD_BREACH
--   every order has an immutable audit snapshot                       PASS

-- ============================================================
-- 1. Category and denominator source
-- ============================================================

DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'compliance'
          AND rel.relname = 'rules'
          AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) ILIKE '%rule_category%'
    LOOP
        EXECUTE format('ALTER TABLE compliance.rules DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE compliance.rules
    ADD CONSTRAINT rules_rule_category_check
    CHECK (rule_category IN (
        'CONCENTRATION', 'EXPOSURE', 'DIVERSIFICATION', 'ELIGIBILITY',
        'LEVERAGE', 'LIQUIDITY', 'FORTY_ACT', 'OTHER'
    ));

DO $$
DECLARE r record;
BEGIN
    FOR r IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'compliance'
          AND rel.relname = 'rule_versions'
          AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) ILIKE '%denominator_source%'
    LOOP
        EXECUTE format('ALTER TABLE compliance.rule_versions DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE compliance.rule_versions
    ADD CONSTRAINT rule_versions_denominator_source_check
    CHECK (denominator_source IN ('BASE', 'ANCHOR', 'GROUP'));

COMMENT ON CONSTRAINT rule_versions_denominator_source_check ON compliance.rule_versions IS
    'BASE aggregates the denominator on the base entities. ANCHOR reads it on the anchor. GROUP reads one value from the entity at the end of group_by_path (for example voting shares outstanding on the security).';

-- ============================================================
-- 2. Domains, attributes, relationships
-- ============================================================

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('ORDER', 'Order', 'A pre-trade order tested by the compliance rules'),
    ('ACCOUNT', 'Custody Account', 'An account an order is routed through'),
    ('CUSTODIAN', 'Custodian', 'The bank or exchange that holds the account'),
    ('COUNTERPARTY', 'Counterparty', 'The other side of an order'),
    ('TRADE', 'Trade', 'A fill or other order event kept for the audit trail')
ON CONFLICT (domain_code) DO NOTHING;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    parent_domain_code = NULLIF(v.parent_code, ''),
    is_core = FALSE,
    updated_at = NOW()
FROM (VALUES
    ('ORDER', 'FUNDS', 210, 'FUND'),
    ('ACCOUNT', 'FUNDS', 220, 'FUND'),
    ('CUSTODIAN', 'FUNDS', 230, ''),
    ('COUNTERPARTY', 'FUNDS', 240, ''),
    ('TRADE', 'FUNDS', 250, 'ORDER')
) AS v(domain_code, group_code, display_order, parent_code)
JOIN metadata_register.domain_groups g ON g.group_code = v.group_code
WHERE dt.domain_code = v.domain_code;

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    is_required, default_precedence_rank, display_section, display_group,
    is_editable, is_visible, is_time_varying, time_dimension
)
SELECT v.code, v.name, v.dtype, v.descr, v.dom,
       FALSE, 100, '40 Act', v.grp, TRUE, TRUE, FALSE, 'NONE'
FROM (VALUES
    ('IS_DIVERSIFIED', 'Diversified Fund', 'BOOLEAN', 'True when the fund has elected diversified status under the 1940 Act.', 'FUND', 1),
    ('SHORT_SALE_EXEMPT', 'Short Sale Exempt', 'BOOLEAN', 'True when the fund is explicitly exempt from the short-sale prohibition.', 'FUND', 2),
    ('TOTAL_DEBT', 'Total Debt', 'CURRENCY', 'Senior securities and borrowings already on the fund.', 'FUND', 3),
    ('MAX_UNDERWRITE_PCT', 'Max Underwriting Percent', 'PERCENTAGE', 'Largest underwriting allocation the fund may take, in percent of assets.', 'FUND', 4),
    ('FUND_VAR', 'Fund VaR', 'NUMBER', 'Absolute value at risk as a fraction of net assets.', 'FUND', 5),
    ('RELATIVE_VAR_PCT', 'Relative VaR', 'NUMBER', 'Fund VaR as a percent of the reference index VaR.', 'FUND', 6),
    ('ABSOLUTE_VAR_LIMIT', 'Absolute VaR Limit', 'NUMBER', 'Absolute VaR limit as a fraction of net assets. Rule 18f-4 uses 0.20.', 'FUND', 7),
    ('RELATIVE_VAR_LIMIT', 'Relative VaR Limit', 'NUMBER', 'Relative VaR limit in percent of the reference index. Rule 18f-4 uses 200.', 'FUND', 8),
    ('VAR_LIMIT_UTILIZATION', 'VaR Limit Utilization', 'NUMBER', 'Worse of absolute VaR over its limit and relative VaR over its limit. Above 1 is a breach.', 'FUND', 9),
    ('BOARD_MEMBER_COUNT', 'Board Members', 'INTEGER', 'Directors on the fund board.', 'FUND', 10),
    ('INDEPENDENT_MEMBER_COUNT', 'Independent Directors', 'INTEGER', 'Directors who are independent.', 'FUND', 11),
    ('CONTRACT_RENEWAL_DATE', 'Advisory Contract Renewal', 'DATE', 'Date the advisory contract must be renewed. A date in the past suspends the fund.', 'FUND', 12),
    ('CONTRACT_LAPSED', 'Advisory Contract Lapsed', 'INTEGER', '1 when the as-of date is after the renewal date.', 'FUND', 13),
    ('FUND_TRADING_STATUS', 'Trading Status', 'STRING', 'Active, or Suspended when the advisory contract has lapsed.', 'FUND', 14),
    ('IS_PUBLIC_OFFERING', 'Public Offering', 'BOOLEAN', 'True when the fund is making a public offering.', 'FUND', 15),
    ('INITIAL_NET_WORTH', 'Initial Net Worth', 'CURRENCY', 'Seed capital. A public offering needs at least $100,000.', 'FUND', 16),
    ('TOTAL_DISTRIBUTION_FEES_YTD', 'Distribution Fees YTD', 'CURRENCY', 'Rule 12b-1 distribution fees paid year to date.', 'FUND', 17),
    ('ANNUALIZED_DISTRIBUTION_FEES', 'Annualized Distribution Fees', 'CURRENCY', 'Year-to-date distribution fees scaled to a full year.', 'FUND', 18),
    ('FUND_NET_ASSETS', 'Fund Net Assets', 'CURRENCY', 'Net assets used as the 12b-1 denominator.', 'FUND', 19),
    ('FUND_NAME_POLICY_KEYWORDS', 'Name Policy Keywords', 'STRING', 'Words in the fund name that decide which holdings count toward the 80 percent test.', 'FUND', 20),
    ('FUND_DERIVATIVE_NOTIONAL', 'Derivative Notional', 'CURRENCY', 'Gross notional of derivatives on the fund.', 'FUND', 21),
    ('CURRENT_VALUE', 'Current Value', 'CURRENCY', 'Position market value used by the 40 Act limits.', 'POSITION', 1),
    ('SHARES_HELD', 'Shares Held', 'DECIMAL', 'Voting shares the position holds, including the open order being tested.', 'POSITION', 2),
    ('POSITION_NOTIONAL_VALUE', 'Position Notional', 'CURRENCY', 'Notional of the position. Derivatives use this in the VaR batch.', 'POSITION', 3),
    ('VOTING_SHARES_OUTSTANDING', 'Voting Shares Outstanding', 'NUMBER', 'Issuer voting shares outstanding.', 'SECURITY', 1),
    ('IS_INVESTMENT_COMPANY', 'Investment Company', 'BOOLEAN', 'True when the security is another investment company.', 'SECURITY', 2),
    ('SECURITY_ISSUER_NAME', 'Issuer Name', 'STRING', 'Issuer name carried on the security for ownership grouping.', 'SECURITY', 3),
    ('SECURITY_LABEL', 'Security Name', 'STRING', 'Name used when a rule reports one row per security.', 'SECURITY', 4),
    ('PRICE_SOURCE', 'Price Source', 'STRING', 'Market or Manual.', 'SECURITY', 5),
    ('PRICE_AGE_HOURS', 'Price Age Hours', 'NUMBER', 'Hours since the last price. More than 24 requires a fair-value review.', 'SECURITY', 6),
    ('LAST_PRICE_TIMESTAMP', 'Last Price Time', 'TIMESTAMP', 'When the price was last updated.', 'SECURITY', 7),
    ('IS_FAIR_VALUED', 'Fair Valued', 'BOOLEAN', 'True when the price is manual or older than 24 hours.', 'SECURITY', 8),
    ('FAIR_VALUE_OVERRIDE', 'Fair Value Override', 'BOOLEAN', 'Supervisor approval that clears a fair-value block.', 'SECURITY', 9),
    ('FAIR_VALUE_BLOCK', 'Fair Value Block', 'INTEGER', '1 when the price is manual or stale and no supervisor has approved it.', 'SECURITY', 10),
    ('ISSUER_INDUSTRY_SECTOR', 'Issuer Industry', 'STRING', 'Industry used by the securities-related issuer limit. Broker_Dealer_Advisor is in scope.', 'ISSUER', 1),
    ('TRANSACTION_TYPE', 'Transaction Type', 'STRING', 'Margin_Purchase, Short_Sale, Buy, Sell, or Borrow.', 'ORDER', 1),
    ('ESTIMATED_VALUE', 'Estimated Value', 'CURRENCY', 'Dollar value of the order.', 'ORDER', 2),
    ('ORDER_QUANTITY', 'Order Quantity', 'DECIMAL', 'Shares on the order.', 'ORDER', 3),
    ('IS_UNDERWRITING_ALLOCATION', 'Underwriting Allocation', 'BOOLEAN', 'True when the buy is an underwriting allocation.', 'ORDER', 4),
    ('ORDER_LABEL', 'Order', 'STRING', 'Name of the order, used to report one result per order.', 'ORDER', 5),
    ('ORDER_COUNTERPARTY_CODE', 'Counterparty', 'STRING', 'Counterparty on the order.', 'ORDER', 6),
    ('AUDIT_EVENT_COUNT', 'Audit Events', 'INTEGER', 'Immutable audit snapshots recorded for this order.', 'ORDER', 7),
    ('COMPLIANCE_STATUS', 'Compliance Status', 'STRING', 'CLEAR or BLOCKED, copied onto the audit snapshot.', 'ORDER', 8),
    ('ACCOUNT_LABEL', 'Account', 'STRING', 'Custody account name.', 'ACCOUNT', 1),
    ('CUSTODIAN_ID', 'Custodian', 'STRING', 'Custodian that holds the account.', 'ACCOUNT', 2),
    ('CUSTODIAN_NAME', 'Custodian Name', 'STRING', 'Name of the custodian.', 'CUSTODIAN', 1),
    ('IS_ELIGIBLE_BANK_EXCHANGE', 'Eligible Custodian', 'BOOLEAN', 'True when the custodian is an eligible bank or exchange.', 'CUSTODIAN', 2),
    ('COUNTERPARTY_NAME', 'Counterparty Name', 'STRING', 'Name of the counterparty.', 'COUNTERPARTY', 1),
    ('IS_AFFILIATED_ENTITY', 'Affiliated Entity', 'BOOLEAN', 'True when the counterparty is an affiliated person.', 'COUNTERPARTY', 2),
    ('TRADE_LABEL', 'Trade', 'STRING', 'Trade name.', 'TRADE', 1),
    ('TRADE_STATUS', 'Trade Status', 'STRING', 'Status of the trade event.', 'TRADE', 2)
) AS v(code, name, dtype, descr, dom, grp)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    data_type = EXCLUDED.data_type,
    domain_code = EXCLUDED.domain_code,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.domain_templates (template_code, template_name, domain_code, description) VALUES
    ('ORDER_STANDARD', 'Standard Order', 'ORDER', 'A pre-trade order'),
    ('ACCOUNT_STANDARD', 'Standard Custody Account', 'ACCOUNT', 'An account an order is routed through'),
    ('CUSTODIAN_STANDARD', 'Standard Custodian', 'CUSTODIAN', 'A bank or exchange'),
    ('COUNTERPARTY_STANDARD', 'Standard Counterparty', 'COUNTERPARTY', 'The other side of an order'),
    ('TRADE_STANDARD', 'Standard Trade', 'TRADE', 'A fill or other order event')
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, precedence_rank, display_order)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t
  ON t.template_code = CASE a.domain_code
        WHEN 'FUND' THEN 'FUND_STANDARD'
        WHEN 'POSITION' THEN 'POSITION_STANDARD'
        WHEN 'SECURITY' THEN 'SECURITY_STANDARD'
        WHEN 'ISSUER' THEN 'ISSUER_STANDARD'
        ELSE a.domain_code || '_STANDARD'
     END
WHERE a.display_section = '40 Act'
ON CONFLICT (template_id, attribute_id) DO NOTHING;

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code, is_required
) VALUES
    ('ORDER_FUND', 'Order for fund', 'ORDER', 'FUND', FALSE),
    ('ORDER_SECURITY', 'Order in security', 'ORDER', 'SECURITY', FALSE),
    ('ORDER_ACCOUNT', 'Order routed via account', 'ORDER', 'ACCOUNT', FALSE),
    ('ORDER_COUNTERPARTY', 'Order with counterparty', 'ORDER', 'COUNTERPARTY', FALSE),
    ('ACCOUNT_FUND', 'Account of fund', 'ACCOUNT', 'FUND', FALSE),
    ('ACCOUNT_CUSTODIAN', 'Account at custodian', 'ACCOUNT', 'CUSTODIAN', FALSE),
    ('TRADE_ORDER', 'Trade of order', 'TRADE', 'ORDER', FALSE)
ON CONFLICT (relationship_code) DO NOTHING;

-- ============================================================
-- 3. Audit log. Rows are insert-only and kept for six years.
-- ============================================================

CREATE TABLE IF NOT EXISTS compliance.compliance_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_entity_id UUID REFERENCES entity_instances.master_entities(id) ON DELETE RESTRICT,
    trade_entity_id UUID REFERENCES entity_instances.master_entities(id) ON DELETE RESTRICT,
    action VARCHAR(20) NOT NULL CHECK (action IN ('CREATE', 'MODIFY', 'ROUTE', 'FILL', 'CANCEL')),
    snapshot JSONB NOT NULL,
    user_id UUID,
    compliance_status VARCHAR(20),
    event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    retain_until TIMESTAMPTZ NOT NULL,
    CONSTRAINT audit_retention_six_years CHECK (retain_until >= event_at + INTERVAL '6 years')
);

CREATE INDEX IF NOT EXISTS idx_compliance_audit_order ON compliance.compliance_audit_log(order_entity_id, event_at);

COMMENT ON TABLE compliance.compliance_audit_log IS
    'Immutable snapshot of every order action. retain_until is event_at plus six years and cannot be shortened.';

CREATE OR REPLACE FUNCTION compliance.audit_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'compliance_audit_log is immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON compliance.compliance_audit_log;
CREATE TRIGGER trg_audit_log_immutable
    BEFORE UPDATE OR DELETE ON compliance.compliance_audit_log
    FOR EACH ROW EXECUTE FUNCTION compliance.audit_log_immutable();

CREATE OR REPLACE FUNCTION compliance.record_order_audit(
    p_order_id UUID,
    p_trade_id UUID,
    p_action VARCHAR,
    p_snapshot JSONB,
    p_user_id UUID,
    p_status VARCHAR,
    p_event_at TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'compliance', 'pg_temp'
AS $$
DECLARE
    v_id UUID;
    v_event TIMESTAMPTZ := COALESCE(p_event_at, NOW());
BEGIN
    INSERT INTO compliance.compliance_audit_log (
        order_entity_id, trade_entity_id, action, snapshot, user_id,
        compliance_status, event_at, retain_until
    ) VALUES (
        p_order_id, p_trade_id, p_action, COALESCE(p_snapshot, '{}'::jsonb), p_user_id,
        p_status, v_event, v_event + INTERVAL '6 years'
    )
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

ALTER TABLE compliance.compliance_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_read ON compliance.compliance_audit_log;
CREATE POLICY audit_log_read ON compliance.compliance_audit_log
    FOR SELECT TO authenticated, service_role
    USING (true);

GRANT SELECT ON compliance.compliance_audit_log TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION compliance.record_order_audit(UUID, UUID, VARCHAR, JSONB, UUID, VARCHAR, TIMESTAMPTZ) TO authenticated, service_role;

-- ============================================================
-- 4. Engine. Empty prohibitions pass. A borrow is added to both
--    sides of the coverage ratio. Issuer exceptions are allowed
--    only while their excess fits in the 25 percent basket.
--    GROUP reads the denominator from the grouped entity.
-- ============================================================

CREATE OR REPLACE FUNCTION compliance.evaluate_rule(
    p_rule_code character varying,
    p_as_of_date date,
    p_knowledge_date timestamp with time zone DEFAULT now(),
    p_source_scope character varying DEFAULT NULL,
    p_triggered_by uuid DEFAULT NULL,
    p_anchor_entity_id uuid DEFAULT NULL,
    p_scenario_code character varying DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'compliance', 'entity_instances', 'metadata_register', 'golden_master', 'tenancy', 'pg_temp'
AS $function$
DECLARE
    v_rule compliance.rules;
    v_version compliance.rule_versions;
    v_run_id UUID;
    v_source_scope VARCHAR;
    v_anchor RECORD;
    v_base_ids UUID[];
    v_more UUID[];
    v_child_funds UUID[];
    v_eligible_base_ids UUID[];
    v_numerator NUMERIC;
    v_denominator NUMERIC;
    v_computed NUMERIC;
    v_status VARCHAR;
    v_breach NUMERIC;
    v_result_count INTEGER := 0;
    v_breach_count INTEGER := 0;
    v_base_eid UUID;
    v_key TEXT;
    v_group_map JSONB;
    v_part RECORD;
    v_row RECORD;
    v_num_dim RECORD;
    v_den_dim RECORD;
    v_detail JSONB;
    v_hard NUMERIC;
    v_soft NUMERIC;
    v_lim NUMERIC;
    v_anc_den NUMERIC;
    v_opt_out BOOLEAN;
    v_limit RECORD;
    v_group_label TEXT;
    v_meta JSONB;
    v_walked UUID[];
    v_subject UUID;
    v_group_entities JSONB;
    v_addend NUMERIC;
    v_assets NUMERIC;
    v_debt NUMERIC;
    v_excess NUMERIC;
    v_basket_group NUMERIC;
    v_basket_cap NUMERIC;
    v_is_coverage BOOLEAN;
    v_pass_empty BOOLEAN;
BEGIN
    SELECT * INTO v_rule FROM compliance.rules WHERE rule_code = p_rule_code;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown compliance rule: %', p_rule_code;
    END IF;

    v_version := compliance.resolve_rule_version(v_rule.id, p_as_of_date, p_knowledge_date);
    IF v_version.id IS NULL THEN
        RAISE EXCEPTION 'No rule_version of % is in force for as_of_date=% / knowledge_date=%', p_rule_code, p_as_of_date, p_knowledge_date;
    END IF;

    v_source_scope := COALESCE(p_source_scope, v_version.default_source_scope, 'GOLDEN');
    v_meta := COALESCE(v_version.metadata, '{}'::jsonb);
    v_pass_empty := COALESCE((v_meta->>'pass_if_empty')::BOOLEAN, FALSE);
    v_is_coverage := COALESCE(v_meta->>'logic', '') = 'asset_coverage';
    v_basket_group := NULLIF(v_meta #>> '{exception_basket,per_group_limit}', '')::NUMERIC;
    v_basket_cap := NULLIF(v_meta #>> '{exception_basket,basket_limit}', '')::NUMERIC;

    SELECT * INTO v_num_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.numerator_dimension);
    SELECT * INTO v_den_dim FROM compliance.resolve_dimension(p_as_of_date, p_knowledge_date, v_source_scope, v_version.denominator_dimension);

    v_detail := jsonb_build_object(
        'numerator', jsonb_build_object('as_of', v_num_dim.o_as_of, 'knowledge', v_num_dim.o_knowledge, 'source', v_num_dim.o_source),
        'denominator', jsonb_build_object('as_of', v_den_dim.o_as_of, 'knowledge', v_den_dim.o_knowledge, 'source', v_den_dim.o_source),
        'result_transform', v_version.result_transform,
        'consolidate_descendants', COALESCE(v_version.consolidate_descendants, FALSE),
        'logic', NULLIF(v_meta->>'logic', '')
    );

    INSERT INTO compliance.rule_evaluation_runs (rule_id, rule_version_id, as_of_date, knowledge_date, source_scope, triggered_by, metadata)
    VALUES (v_rule.id, v_version.id, p_as_of_date, p_knowledge_date, v_source_scope, p_triggered_by,
            CASE WHEN p_scenario_code IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('scenario_code', p_scenario_code) END)
    RETURNING id INTO v_run_id;

    CREATE TEMP TABLE IF NOT EXISTS compliance_eval_parts (
        group_key TEXT,
        numerator NUMERIC,
        denominator NUMERIC,
        computed NUMERIC,
        contributing_ids UUID[]
    ) ON COMMIT DROP;

    BEGIN
        FOR v_anchor IN
            SELECT a.entity_id
            FROM compliance.get_anchor_entities(v_rule.id, p_as_of_date, p_knowledge_date) a
        LOOP
            IF p_anchor_entity_id IS NOT NULL AND v_anchor.entity_id <> p_anchor_entity_id THEN
                CONTINUE;
            END IF;

            IF NOT compliance.entity_matches_conditions(v_anchor.entity_id, v_version.id, 'ANCHOR', p_as_of_date, p_knowledge_date, v_source_scope) THEN
                CONTINUE;
            END IF;

            SELECT EXISTS (
                SELECT 1
                FROM compliance.rule_thresholds t
                WHERE t.rule_id = v_rule.id
                  AND t.entity_id = v_anchor.entity_id
                  AND t.group_value IS NULL
                  AND t.rank_from IS NULL
                  AND t.rank_to IS NULL
                  AND t.applies = FALSE
                  AND t.valid_from <= p_as_of_date AND t.valid_to >= p_as_of_date
            ) INTO v_opt_out;
            IF v_opt_out THEN
                CONTINUE;
            END IF;

            v_hard := v_version.hard_limit_value;
            v_soft := v_version.soft_limit_value;
            IF v_version.hard_limit_attribute_code IS NOT NULL THEN
                v_lim := NULL;
                SELECT g.val INTO v_lim
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], v_version.hard_limit_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;
                IF v_lim IS NOT NULL THEN
                    v_hard := v_lim;
                    v_soft := CASE WHEN v_version.soft_limit_factor IS NOT NULL THEN v_lim * v_version.soft_limit_factor END;
                END IF;
            END IF;

            v_anc_den := NULL;
            IF v_version.denominator_source = 'ANCHOR' AND v_version.denominator_attribute_code IS NOT NULL THEN
                SELECT g.val INTO v_anc_den
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], v_version.denominator_attribute_code, v_den_dim.o_as_of, v_den_dim.o_knowledge, v_den_dim.o_source) AS g
                LIMIT 1;
            END IF;

            IF v_version.base_rollup_path IS NULL OR jsonb_array_length(v_version.base_rollup_path) = 0 THEN
                v_base_ids := ARRAY[v_anchor.entity_id];
            ELSE
                v_base_ids := compliance.walk_path(ARRAY[v_anchor.entity_id], v_version.base_rollup_path, p_as_of_date, p_knowledge_date);
            END IF;

            IF COALESCE(v_version.consolidate_descendants, FALSE) THEN
                v_child_funds := compliance.walk_path(
                    ARRAY[v_anchor.entity_id],
                    '[{"relationship_code":"FUND_PARENT","direction":"DOWN","recursive":true}]'::jsonb,
                    p_as_of_date,
                    p_knowledge_date
                );
                IF v_child_funds IS NOT NULL AND array_length(v_child_funds, 1) IS NOT NULL THEN
                    IF v_version.base_rollup_path IS NULL OR jsonb_array_length(v_version.base_rollup_path) = 0 THEN
                        v_more := v_child_funds;
                    ELSE
                        v_more := compliance.walk_path(v_child_funds, v_version.base_rollup_path, p_as_of_date, p_knowledge_date);
                    END IF;
                    SELECT array_agg(DISTINCT x) INTO v_base_ids
                    FROM unnest(COALESCE(v_base_ids, '{}'::UUID[]) || COALESCE(v_more, '{}'::UUID[])) AS x
                    WHERE x IS NOT NULL;
                END IF;
            END IF;

            IF (v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL) AND NOT v_is_coverage THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    NULL,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    v_version.limit_direction, v_soft, v_hard,
                    CASE WHEN v_pass_empty THEN 'PASS' ELSE 'NO_DATA' END,
                    0, v_detail || jsonb_build_object('empty', TRUE)
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            IF v_is_coverage AND (v_base_ids IS NULL OR array_length(v_base_ids, 1) IS NULL) THEN
                v_eligible_base_ids := ARRAY[]::UUID[];
            ELSE
                SELECT array_agg(eid) INTO v_eligible_base_ids
                FROM unnest(v_base_ids) AS eid
                WHERE compliance.entity_matches_conditions(eid, v_version.id, 'BASE', p_as_of_date, p_knowledge_date, v_source_scope)
                  AND compliance.include_in_scenario(eid, p_scenario_code, p_as_of_date, p_knowledge_date, v_source_scope);
            END IF;

            IF v_is_coverage THEN
                v_addend := 0;
                IF v_eligible_base_ids IS NOT NULL AND array_length(v_eligible_base_ids, 1) IS NOT NULL THEN
                    SELECT COALESCE(SUM(g.val), 0) INTO v_addend
                    FROM compliance.get_numeric_values(
                        v_eligible_base_ids,
                        COALESCE(v_meta->>'addend_attribute', 'ESTIMATED_VALUE'),
                        p_as_of_date, p_knowledge_date, v_source_scope
                    ) AS g;
                END IF;
                v_assets := NULL;
                v_debt := NULL;
                SELECT g.val INTO v_assets
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], COALESCE(v_meta->>'assets_attribute', 'TOTAL_AUM'), p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;
                SELECT g.val INTO v_debt
                FROM compliance.get_numeric_values(ARRAY[v_anchor.entity_id], COALESCE(v_meta->>'debt_attribute', 'TOTAL_DEBT'), p_as_of_date, p_knowledge_date, v_source_scope) AS g
                LIMIT 1;

                IF v_assets IS NULL OR v_debt IS NULL THEN
                    v_numerator := NULL;
                    v_denominator := NULL;
                    v_computed := NULL;
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSE
                    v_numerator := v_assets + COALESCE(v_addend, 0);
                    v_denominator := v_debt + COALESCE(v_addend, 0);
                    IF v_denominator = 0 THEN
                        v_computed := NULL;
                        v_status := 'NO_DATA';
                        v_breach := NULL;
                    ELSE
                        v_computed := v_numerator / v_denominator;
                        IF v_version.limit_direction = 'MAX' THEN
                            IF v_hard IS NOT NULL AND v_computed > v_hard THEN
                                v_status := 'HARD_BREACH';
                                v_breach := v_computed - v_hard;
                            ELSIF v_soft IS NOT NULL AND v_computed > v_soft THEN
                                v_status := 'SOFT_BREACH';
                                v_breach := v_computed - v_soft;
                            ELSE
                                v_status := 'PASS';
                                v_breach := NULL;
                            END IF;
                        ELSE
                            IF v_hard IS NOT NULL AND v_computed < v_hard THEN
                                v_status := 'HARD_BREACH';
                                v_breach := v_hard - v_computed;
                            ELSIF v_soft IS NOT NULL AND v_computed < v_soft THEN
                                v_status := 'SOFT_BREACH';
                                v_breach := v_soft - v_computed;
                            ELSE
                                v_status := 'PASS';
                                v_breach := NULL;
                            END IF;
                        END IF;
                    END IF;
                END IF;

                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_entity_ids, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_numerator, v_denominator, v_computed,
                    v_version.limit_direction, v_soft, v_hard,
                    v_status, v_breach, v_eligible_base_ids, COALESCE(array_length(v_eligible_base_ids, 1), 0),
                    v_detail || jsonb_build_object(
                        'assets', v_assets,
                        'debt', v_debt,
                        'addend', v_addend,
                        'book_coverage', CASE WHEN v_debt IS NULL OR v_debt = 0 THEN NULL ELSE v_assets / v_debt END,
                        'projected_coverage', v_computed
                    )
                );
                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
                CONTINUE;
            END IF;

            IF v_eligible_base_ids IS NULL OR array_length(v_eligible_base_ids, 1) IS NULL THEN
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, NULL,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    NULL,
                    CASE WHEN v_pass_empty THEN 0 ELSE NULL END,
                    v_version.limit_direction, v_soft, v_hard,
                    CASE WHEN v_pass_empty THEN 'PASS' ELSE 'NO_DATA' END,
                    0, v_detail || jsonb_build_object('empty', TRUE)
                );
                v_result_count := v_result_count + 1;
                CONTINUE;
            END IF;

            v_group_map := '{}'::JSONB;
            v_group_entities := '{}'::JSONB;

            IF v_version.group_by_attribute_code IS NULL THEN
                v_group_map := jsonb_build_object('__ALL__', to_jsonb(v_eligible_base_ids));
            ELSE
                FOR v_base_eid IN SELECT unnest(v_eligible_base_ids) LOOP
                    v_subject := NULL;
                    IF v_version.group_by_path IS NULL OR jsonb_array_length(v_version.group_by_path) = 0 THEN
                        v_subject := v_base_eid;
                        v_key := compliance.get_text_value_dim(v_base_eid, v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension);
                    ELSE
                        v_walked := compliance.walk_path(ARRAY[v_base_eid], v_version.group_by_path, p_as_of_date, p_knowledge_date);
                        IF v_walked IS NULL OR array_length(v_walked, 1) IS NULL THEN
                            v_subject := NULL;
                            v_key := NULL;
                        ELSE
                            v_subject := v_walked[1];
                            v_key := compliance.get_text_value_dim(v_subject, v_version.group_by_attribute_code, p_as_of_date, p_knowledge_date, v_source_scope, v_version.group_by_dimension);
                        END IF;
                    END IF;

                    v_key := COALESCE(v_key, '__UNASSIGNED__');

                    IF v_group_map ? v_key THEN
                        v_group_map := jsonb_set(
                            v_group_map, ARRAY[v_key],
                            to_jsonb((SELECT array_agg(x) FROM (
                                SELECT jsonb_array_elements_text(v_group_map -> v_key)::UUID AS x
                                UNION ALL SELECT v_base_eid
                            ) u))
                        );
                    ELSE
                        v_group_map := jsonb_set(v_group_map, ARRAY[v_key], jsonb_build_array(v_base_eid), TRUE);
                    END IF;

                    IF v_subject IS NOT NULL THEN
                        IF v_group_entities ? v_key THEN
                            v_group_entities := jsonb_set(
                                v_group_entities, ARRAY[v_key],
                                (v_group_entities -> v_key) || jsonb_build_array(v_subject::text)
                            );
                        ELSE
                            v_group_entities := jsonb_set(v_group_entities, ARRAY[v_key], jsonb_build_array(v_subject::text), TRUE);
                        END IF;
                    END IF;
                END LOOP;
            END IF;

            DELETE FROM compliance_eval_parts WHERE TRUE;

            FOR v_part IN
                SELECT *
                FROM compliance.grouped_ratio_parts(
                    v_group_map,
                    v_version.numerator_attribute_code,
                    v_version.numerator_aggregation,
                    v_version.numerator_dimension,
                    CASE WHEN v_version.denominator_source IN ('ANCHOR', 'GROUP') THEN NULL ELSE v_version.denominator_attribute_code END,
                    v_version.denominator_aggregation,
                    v_version.denominator_scope,
                    v_version.denominator_dimension,
                    v_version.denominator_constant_value,
                    p_as_of_date,
                    p_knowledge_date,
                    v_source_scope
                )
            LOOP
                v_key := v_part.group_key;
                v_numerator := v_part.numerator_value;
                v_denominator := v_part.denominator_value;
                IF v_version.denominator_source = 'ANCHOR' THEN
                    v_denominator := v_anc_den;
                END IF;
                IF v_version.denominator_source = 'GROUP' THEN
                    v_denominator := NULL;
                    IF v_group_entities ? v_key AND jsonb_array_length(v_group_entities -> v_key) > 0 THEN
                        SELECT MAX(g.val) INTO v_denominator
                        FROM compliance.get_numeric_values(
                            ARRAY(SELECT DISTINCT t.elem::UUID FROM jsonb_array_elements_text(v_group_entities -> v_key) AS t(elem)),
                            v_version.denominator_attribute_code,
                            v_den_dim.o_as_of, v_den_dim.o_knowledge, v_den_dim.o_source
                        ) AS g;
                    END IF;
                END IF;

                IF v_version.denominator_source IN ('ANCHOR', 'GROUP') AND COALESCE(v_denominator, 0) = 0 THEN
                    v_computed := NULL;
                ELSIF v_denominator IS NULL THEN
                    v_computed := v_numerator;
                ELSIF v_version.result_transform = 'DIFFERENCE' THEN
                    v_computed := v_numerator - v_denominator;
                ELSIF v_version.result_transform = 'ABS_DIFFERENCE' THEN
                    v_computed := abs(v_numerator - v_denominator);
                ELSIF v_denominator = 0 THEN
                    v_computed := NULL;
                ELSIF v_version.result_transform IN ('PCT_CHANGE', 'ABS_PCT_CHANGE') THEN
                    v_computed := (v_numerator - v_denominator) / v_denominator;
                    IF v_version.result_transform = 'ABS_PCT_CHANGE' THEN
                        v_computed := abs(v_computed);
                    END IF;
                    IF v_version.result_unit = 'PERCENTAGE' THEN
                        v_computed := v_computed * 100;
                    END IF;
                ELSE
                    v_computed := v_numerator / v_denominator;
                    IF v_version.result_unit = 'PERCENTAGE' THEN
                        v_computed := v_computed * 100;
                    END IF;
                END IF;

                INSERT INTO compliance_eval_parts (group_key, numerator, denominator, computed, contributing_ids)
                VALUES (v_key, v_numerator, v_denominator, v_computed, v_part.contributing_ids);
            END LOOP;

            v_excess := NULL;
            IF v_basket_group IS NOT NULL THEN
                SELECT COALESCE(SUM(GREATEST(p.computed - v_basket_group, 0)), 0)
                INTO v_excess
                FROM compliance_eval_parts p
                WHERE p.computed IS NOT NULL;
            END IF;

            FOR v_row IN
                SELECT p.*,
                       CASE
                           WHEN p.computed IS NULL THEN NULL
                           ELSE row_number() OVER (
                               ORDER BY
                                   CASE WHEN v_version.limit_direction = 'MIN' THEN p.computed END ASC NULLS LAST,
                                   CASE WHEN COALESCE(v_version.limit_direction, 'MAX') <> 'MIN' THEN p.computed END DESC NULLS LAST,
                                   p.group_key
                           )
                       END AS rank_pos
                FROM compliance_eval_parts p
            LOOP
                v_group_label := CASE WHEN v_row.group_key IN ('__ALL__', '__UNASSIGNED__') THEN NULL ELSE v_row.group_key END;
                SELECT * INTO v_limit
                FROM compliance.resolve_threshold(
                    v_rule.id, v_anchor.entity_id, v_group_label, v_row.rank_pos, p_as_of_date, v_soft, v_hard
                );

                IF NOT COALESCE(v_limit.applies, TRUE) THEN
                    CONTINUE;
                END IF;

                v_computed := v_row.computed;
                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_basket_group IS NOT NULL AND v_computed > v_basket_group THEN
                    IF v_basket_cap IS NOT NULL AND v_excess > v_basket_cap THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_basket_group;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                ELSIF v_version.limit_direction = 'MAX' THEN
                    IF v_limit.hard_limit IS NOT NULL AND v_computed > v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_computed - v_limit.hard_limit;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed > v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_computed - v_limit.soft_limit;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                ELSE
                    IF v_limit.hard_limit IS NOT NULL AND v_computed < v_limit.hard_limit THEN
                        v_status := 'HARD_BREACH';
                        v_breach := v_limit.hard_limit - v_computed;
                    ELSIF v_limit.soft_limit IS NOT NULL AND v_computed < v_limit.soft_limit THEN
                        v_status := 'SOFT_BREACH';
                        v_breach := v_limit.soft_limit - v_computed;
                    ELSE
                        v_status := 'PASS';
                        v_breach := NULL;
                    END IF;
                END IF;

                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_entity_ids, contributing_count,
                    rank_position, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, v_group_label,
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_row.numerator, v_row.denominator, v_computed,
                    v_version.limit_direction, v_limit.soft_limit, v_limit.hard_limit,
                    v_status, v_breach, v_row.contributing_ids, array_length(v_row.contributing_ids, 1),
                    v_row.rank_pos,
                    v_detail || jsonb_build_object('rank', v_row.rank_pos, 'threshold_source', v_limit.source)
                    || CASE
                        WHEN v_basket_group IS NULL THEN '{}'::jsonb
                        ELSE jsonb_build_object(
                            'basket_excess', v_excess,
                            'basket_limit', v_basket_cap,
                            'allowed_exception',
                            v_computed > v_basket_group AND NOT (v_basket_cap IS NOT NULL AND v_excess > v_basket_cap)
                        )
                       END
                );

                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
            END LOOP;

            IF v_basket_group IS NOT NULL THEN
                v_computed := v_excess;
                IF v_computed IS NULL THEN
                    v_status := 'NO_DATA';
                    v_breach := NULL;
                ELSIF v_basket_cap IS NOT NULL AND v_computed > v_basket_cap THEN
                    v_status := 'HARD_BREACH';
                    v_breach := v_computed - v_basket_cap;
                ELSE
                    v_status := 'PASS';
                    v_breach := NULL;
                END IF;
                INSERT INTO compliance.rule_evaluation_results (
                    run_id, rule_id, rule_version_id, anchor_entity_id, group_by_value,
                    as_of_date, knowledge_date, source_scope,
                    numerator_value, denominator_value, computed_value,
                    limit_direction, soft_limit_value, hard_limit_value,
                    status, breach_amount, contributing_count, detail
                ) VALUES (
                    v_run_id, v_rule.id, v_version.id, v_anchor.entity_id, 'Exception basket',
                    p_as_of_date, p_knowledge_date, v_source_scope,
                    v_excess, NULL, v_computed,
                    'MAX', NULL, v_basket_cap,
                    v_status, v_breach, NULL,
                    v_detail || jsonb_build_object(
                        'basket_excess', v_excess,
                        'basket_limit', v_basket_cap,
                        'per_group_limit', v_basket_group
                    )
                );
                v_result_count := v_result_count + 1;
                IF v_status IN ('SOFT_BREACH', 'HARD_BREACH') THEN
                    v_breach_count := v_breach_count + 1;
                END IF;
            END IF;
        END LOOP;

        UPDATE compliance.rule_evaluation_runs
        SET run_status = 'COMPLETED', completed_at = NOW(), result_count = v_result_count, breach_count = v_breach_count
        WHERE id = v_run_id;

    EXCEPTION WHEN OTHERS THEN
        UPDATE compliance.rule_evaluation_runs
        SET run_status = 'FAILED', completed_at = NOW(), error_message = SQLERRM
        WHERE id = v_run_id;
        RAISE;
    END;

    RETURN v_run_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION compliance.evaluate_rule(character varying, date, timestamp with time zone, character varying, uuid, uuid, character varying) TO authenticated, service_role;
