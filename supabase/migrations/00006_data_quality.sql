-- Migration: Data Quality Schema
-- Description: DQ rules engine and exception tracking

-- DQ Rules: Data quality rule definitions
CREATE TABLE data_quality.dq_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_code VARCHAR(100) UNIQUE NOT NULL,
    rule_name VARCHAR(200) NOT NULL,
    domain_code VARCHAR(50) REFERENCES metadata_register.domain_types(domain_code),
    attribute_id UUID REFERENCES metadata_register.attribute_register(id),
    rule_type VARCHAR(50) NOT NULL CHECK (rule_type IN ('COMPLETENESS', 'VALIDITY', 'CONSISTENCY', 'TIMELINESS', 'UNIQUENESS')),
    rule_severity VARCHAR(20) NOT NULL CHECK (rule_severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
    rule_expression TEXT NOT NULL,
    rule_description TEXT,
    threshold_value NUMERIC(10,2),
    is_active BOOLEAN DEFAULT TRUE,
    auto_remediate BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dq_rules_code ON data_quality.dq_rules(rule_code);
CREATE INDEX idx_dq_rules_domain ON data_quality.dq_rules(domain_code);
CREATE INDEX idx_dq_rules_attribute ON data_quality.dq_rules(attribute_id);
CREATE INDEX idx_dq_rules_type ON data_quality.dq_rules(rule_type);
CREATE INDEX idx_dq_rules_severity ON data_quality.dq_rules(rule_severity);
CREATE INDEX idx_dq_rules_active ON data_quality.dq_rules(is_active);

COMMENT ON TABLE data_quality.dq_rules IS 'Data quality rule definitions with severity and type classifications';
COMMENT ON COLUMN data_quality.dq_rules.rule_expression IS 'SQL boolean predicate that is true for records that fail the rule. Evaluated against current golden attributes, with attribute codes as lowercase columns.';

-- DQ Exceptions: Data quality exception tracking
CREATE TABLE data_quality.dq_exceptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES data_quality.dq_rules(id),
    entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id),
    attribute_id UUID REFERENCES metadata_register.attribute_register(id),
    
    -- Exception details
    exception_type VARCHAR(50) NOT NULL,
    exception_message TEXT NOT NULL,
    expected_value TEXT,
    actual_value TEXT,
    severity VARCHAR(20) NOT NULL,
    
    -- Status tracking
    status VARCHAR(50) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_REVIEW', 'RESOLVED', 'WAIVED', 'FALSE_POSITIVE')),
    assigned_to UUID REFERENCES auth.users(id),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES auth.users(id),
    resolution_notes TEXT,
    
    -- Bi-temporal tracking
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL DEFAULT '9999-12-31',
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dq_exceptions_rule ON data_quality.dq_exceptions(rule_id);
CREATE INDEX idx_dq_exceptions_entity ON data_quality.dq_exceptions(entity_id);
CREATE INDEX idx_dq_exceptions_attribute ON data_quality.dq_exceptions(attribute_id);
CREATE INDEX idx_dq_exceptions_status ON data_quality.dq_exceptions(status);
CREATE INDEX idx_dq_exceptions_severity ON data_quality.dq_exceptions(severity);
CREATE INDEX idx_dq_exceptions_detected ON data_quality.dq_exceptions(detected_at);
CREATE INDEX idx_dq_exceptions_assigned ON data_quality.dq_exceptions(assigned_to);

COMMENT ON TABLE data_quality.dq_exceptions IS 'Data quality exceptions with status tracking and resolution workflow';

-- Function to evaluate DQ rule
CREATE OR REPLACE FUNCTION data_quality.evaluate_dq_rule(
    p_rule_id UUID,
    p_entity_id UUID
) RETURNS TABLE (
    passed BOOLEAN,
    exception_message TEXT,
    expected_value TEXT,
    actual_value TEXT
) LANGUAGE plpgsql AS $$
DECLARE
    v_rule RECORD;
    v_value TEXT;
    v_passed BOOLEAN;
BEGIN
    -- Get rule definition
    SELECT * INTO v_rule
    FROM data_quality.dq_rules
    WHERE id = p_rule_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Rule not found: %', p_rule_id;
    END IF;
    
    -- Get current value (simplified - would execute rule_expression)
    SELECT golden_value INTO v_value
    FROM golden_master.current_golden_records
    WHERE entity_id = p_entity_id
        AND attribute_id = v_rule.attribute_id
    LIMIT 1;
    
    -- Placeholder. rule_expression is a failure predicate (true => the record
    -- fails) and is executed by the evaluator in 00061_dq_fail_predicates.sql.
    v_passed := v_value IS NOT NULL;
    
    RETURN QUERY
    SELECT 
        v_passed,
        CASE WHEN v_passed THEN 'Rule passed' ELSE 'Rule failed: Value is null' END,
        'Non-null value',
        COALESCE(v_value, 'NULL');
END;
$$;

COMMENT ON FUNCTION data_quality.evaluate_dq_rule IS 'Evaluates a DQ rule against an entity. rule_expression is true when the record fails; full evaluation is installed in 00061.';

-- Sample rules. Each expression is the failing population (true => violation),
-- which is the complement of the previous pass predicate, including NULL.
INSERT INTO data_quality.dq_rules (rule_code, rule_name, domain_code, rule_type, rule_severity, rule_expression, rule_description) VALUES
    ('FUND_NAV_NOT_NULL', 'Fund NAV Required', 'FUND', 'COMPLETENESS', 'CRITICAL', $dq$nav IS NULL$dq$, 'Fund must have a NAV value'),
    ('SECURITY_ISIN_FORMAT', 'ISIN Format Validation', 'SECURITY', 'VALIDITY', 'HIGH', $dq$isin IS NULL OR isin !~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'$dq$, 'ISIN must follow ISO 6166 format'),
    ('DEAL_DATE_NOT_FUTURE', 'Deal Date Not Future', 'DEAL', 'VALIDITY', 'MEDIUM', $dq$deal_date IS NULL OR deal_date > CURRENT_DATE$dq$, 'Deal date cannot be in the future'),
    ('PRICE_NOT_NEGATIVE', 'Price Not Negative', 'PRICE', 'VALIDITY', 'HIGH', $dq$price IS NULL OR price < 0$dq$, 'Price values cannot be negative');
