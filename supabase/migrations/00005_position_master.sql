-- Migration: Position Master Schema
-- Description: Dimensional intersections and position-level metrics

-- Dimensional Intersections: Position-level dimensional data
CREATE TABLE position_master.dimensional_intersections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intersection_code VARCHAR(100) UNIQUE NOT NULL,
    fund_entity_id UUID REFERENCES entity_instances.master_entities(id),
    issuer_entity_id UUID REFERENCES entity_instances.master_entities(id),
    deal_entity_id UUID REFERENCES entity_instances.master_entities(id),
    security_entity_id UUID REFERENCES entity_instances.master_entities(id),
    
    -- Position details
    position_type VARCHAR(50) NOT NULL CHECK (position_type IN ('EQUITY', 'DEBT', 'FUND_INTEREST', 'DERIVATIVE', 'OTHER')),
    quantity NUMERIC(20,6),
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    
    -- Bi-temporal tracking
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL DEFAULT '9999-12-31',
    system_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    system_to TIMESTAMPTZ NOT NULL DEFAULT '9999-12-31 23:59:59',
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

CREATE INDEX idx_di_code ON position_master.dimensional_intersections(intersection_code);
CREATE INDEX idx_di_fund ON position_master.dimensional_intersections(fund_entity_id);
CREATE INDEX idx_di_issuer ON position_master.dimensional_intersections(issuer_entity_id);
CREATE INDEX idx_di_deal ON position_master.dimensional_intersections(deal_entity_id);
CREATE INDEX idx_di_security ON position_master.dimensional_intersections(security_entity_id);
CREATE INDEX idx_di_valid_time ON position_master.dimensional_intersections USING gist (valid_from, valid_to);
CREATE INDEX idx_di_current ON position_master.dimensional_intersections(intersection_code) 
    WHERE valid_to = '9999-12-31' AND system_to = '9999-12-31 23:59:59';

COMMENT ON TABLE position_master.dimensional_intersections IS 'Position-level dimensional intersections across fund/issuer/deal/security';

-- Position Metrics: Calculated metrics for positions
CREATE TABLE position_master.position_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intersection_id UUID NOT NULL REFERENCES position_master.dimensional_intersections(id) ON DELETE CASCADE,
    metric_date DATE NOT NULL,
    
    -- Value metrics
    market_value NUMERIC(20,2),
    cost_basis NUMERIC(20,2),
    unrealized_gain_loss NUMERIC(20,2),
    realized_gain_loss NUMERIC(20,2),
    
    -- Return metrics
    daily_return DECIMAL(10,6),
    mtd_return DECIMAL(10,6),
    ytd_return DECIMAL(10,6),
    since_inception_return DECIMAL(10,6),
    
    -- Risk metrics
    beta DECIMAL(10,4),
    volatility DECIMAL(10,4),
    var_95 DECIMAL(10,4),
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(intersection_id, metric_date)
);

CREATE INDEX idx_pm_intersection ON position_master.position_metrics(intersection_id);
CREATE INDEX idx_pm_date ON position_master.position_metrics(metric_date);
CREATE INDEX idx_pm_market_value ON position_master.position_metrics(market_value);

COMMENT ON TABLE position_master.position_metrics IS 'Calculated position metrics including values, returns, and risk measures';

-- Function to calculate position metrics
CREATE OR REPLACE FUNCTION position_master.calculate_position_metrics(
    p_intersection_id UUID,
    p_metric_date DATE
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_quantity NUMERIC;
    v_price NUMERIC;
    v_cost_basis NUMERIC;
BEGIN
    -- Get position quantity
    SELECT quantity INTO v_quantity
    FROM position_master.dimensional_intersections
    WHERE id = p_intersection_id
        AND valid_from <= p_metric_date
        AND valid_to >= p_metric_date;
    
    -- Get price for the security (simplified - would need security_id lookup)
    -- This is a placeholder for actual pricing logic
    SELECT golden_value_numeric INTO v_price
    FROM golden_master.current_golden_records
    WHERE entity_id = (SELECT security_entity_id FROM position_master.dimensional_intersections WHERE id = p_intersection_id)
        AND attribute_code = 'PRICE'
    LIMIT 1;
    
    -- Calculate market value
    IF v_quantity IS NOT NULL AND v_price IS NOT NULL THEN
        INSERT INTO position_master.position_metrics (
            intersection_id,
            metric_date,
            market_value
        ) VALUES (
            p_intersection_id,
            p_metric_date,
            v_quantity * v_price
        )
        ON CONFLICT (intersection_id, metric_date) 
        DO UPDATE SET 
            market_value = EXCLUDED.market_value,
            updated_at = NOW();
    END IF;
END;
$$;

COMMENT ON FUNCTION position_master.calculate_position_metrics IS 'Calculates position metrics for a given date';
