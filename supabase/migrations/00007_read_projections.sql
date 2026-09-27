-- Migration: Read Projections Schema
-- Description: Denormalized read-optimized views for CQRS pattern

-- Fund Projection: Flattened fund view
CREATE OR REPLACE VIEW read_projections.fund_master AS
SELECT 
    me.id AS fund_id,
    me.entity_code AS fund_code,
    me.entity_name AS fund_name,
    me.description,
    me.is_active,
    
    -- Key attributes (pivoted from EAV)
    MAX(CASE WHEN ar.attribute_code = 'NAV' THEN eav.golden_value_numeric END) AS nav,
    MAX(CASE WHEN ar.attribute_code = 'NAV_CURRENCY' THEN eav.golden_value END) AS nav_currency,
    MAX(CASE WHEN ar.attribute_code = 'NAV_DATE' THEN eav.golden_value_date END) AS nav_date,
    MAX(CASE WHEN ar.attribute_code = 'INCEPTION_DATE' THEN eav.golden_value_date END) AS inception_date,
    MAX(CASE WHEN ar.attribute_code = 'FUND_STATUS' THEN eav.golden_value END) AS fund_status,
    MAX(CASE WHEN ar.attribute_code = 'FUND_TYPE' THEN eav.golden_value END) AS fund_type,
    MAX(CASE WHEN ar.attribute_code = 'MANAGER' THEN eav.golden_value END) AS manager,
    MAX(CASE WHEN ar.attribute_code = 'AUM' THEN eav.golden_value_numeric END) AS aum,
    
    -- Source tracking
    MAX(CASE WHEN ar.attribute_code = 'NAV' THEN sr.source_code END) AS nav_source,
    
    -- Temporal
    MAX(eav.valid_from) AS last_updated,
    
    me.metadata,
    me.created_at,
    me.updated_at
FROM entity_instances.master_entities me
LEFT JOIN golden_master.entity_attribute_values eav 
    ON eav.entity_id = me.id 
    AND eav.valid_to = '9999-12-31'
    AND eav.system_to = '9999-12-31 23:59:59'
LEFT JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
LEFT JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
WHERE me.domain_code = 'FUND'
GROUP BY me.id, me.entity_code, me.entity_name, me.description, me.is_active, me.metadata, me.created_at, me.updated_at;

COMMENT ON VIEW read_projections.fund_master IS 'Denormalized fund view with pivoted attributes for efficient reads';

-- Issuer Projection: Flattened issuer view
CREATE OR REPLACE VIEW read_projections.issuer_master AS
SELECT 
    me.id AS issuer_id,
    me.entity_code AS issuer_code,
    me.entity_name AS issuer_name,
    me.description,
    me.is_active,
    
    -- Key attributes
    MAX(CASE WHEN ar.attribute_code = 'LEI' THEN eav.golden_value END) AS lei,
    MAX(CASE WHEN ar.attribute_code = 'COUNTRY' THEN eav.golden_value END) AS country,
    MAX(CASE WHEN ar.attribute_code = 'SECTOR' THEN eav.golden_value END) AS sector,
    MAX(CASE WHEN ar.attribute_code = 'INDUSTRY' THEN eav.golden_value END) AS industry,
    MAX(CASE WHEN ar.attribute_code = 'MARKET_CAP' THEN eav.golden_value_numeric END) AS market_cap,
    MAX(CASE WHEN ar.attribute_code = 'CREDIT_RATING' THEN eav.golden_value END) AS credit_rating,
    
    me.metadata,
    me.created_at,
    me.updated_at
FROM entity_instances.master_entities me
LEFT JOIN golden_master.entity_attribute_values eav 
    ON eav.entity_id = me.id 
    AND eav.valid_to = '9999-12-31'
    AND eav.system_to = '9999-12-31 23:59:59'
LEFT JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
WHERE me.domain_code = 'ISSUER'
GROUP BY me.id, me.entity_code, me.entity_name, me.description, me.is_active, me.metadata, me.created_at, me.updated_at;

COMMENT ON VIEW read_projections.issuer_master IS 'Denormalized issuer view with pivoted attributes';

-- Security Projection: Flattened security view
CREATE OR REPLACE VIEW read_projections.security_master AS
SELECT 
    me.id AS security_id,
    me.entity_code AS security_code,
    me.entity_name AS security_name,
    me.description,
    me.is_active,
    
    -- Key attributes
    MAX(CASE WHEN ar.attribute_code = 'ISIN' THEN eav.golden_value END) AS isin,
    MAX(CASE WHEN ar.attribute_code = 'CUSIP' THEN eav.golden_value END) AS cusip,
    MAX(CASE WHEN ar.attribute_code = 'TICKER' THEN eav.golden_value END) AS ticker,
    MAX(CASE WHEN ar.attribute_code = 'SECURITY_TYPE' THEN eav.golden_value END) AS security_type,
    MAX(CASE WHEN ar.attribute_code = 'CURRENCY' THEN eav.golden_value END) AS currency,
    MAX(CASE WHEN ar.attribute_code = 'EXCHANGE' THEN eav.golden_value END) AS exchange,
    MAX(CASE WHEN ar.attribute_code = 'PRICE' THEN eav.golden_value_numeric END) AS price,
    MAX(CASE WHEN ar.attribute_code = 'PRICE_DATE' THEN eav.golden_value_date END) AS price_date,
    
    -- Issuer relationship
    MAX(CASE WHEN ar.attribute_code = 'ISSUER_ID' THEN eav.golden_value END) AS issuer_code,
    
    me.metadata,
    me.created_at,
    me.updated_at
FROM entity_instances.master_entities me
LEFT JOIN golden_master.entity_attribute_values eav 
    ON eav.entity_id = me.id 
    AND eav.valid_to = '9999-12-31'
    AND eav.system_to = '9999-12-31 23:59:59'
LEFT JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
WHERE me.domain_code = 'SECURITY'
GROUP BY me.id, me.entity_code, me.entity_name, me.description, me.is_active, me.metadata, me.created_at, me.updated_at;

COMMENT ON VIEW read_projections.security_master IS 'Denormalized security view with pivoted attributes';

-- Deal Projection: Flattened deal view
CREATE OR REPLACE VIEW read_projections.deal_master AS
SELECT 
    me.id AS deal_id,
    me.entity_code AS deal_code,
    me.entity_name AS deal_name,
    me.description,
    me.is_active,
    
    -- Key attributes
    MAX(CASE WHEN ar.attribute_code = 'DEAL_DATE' THEN eav.golden_value_date END) AS deal_date,
    MAX(CASE WHEN ar.attribute_code = 'DEAL_TYPE' THEN eav.golden_value END) AS deal_type,
    MAX(CASE WHEN ar.attribute_code = 'DEAL_VALUE' THEN eav.golden_value_numeric END) AS deal_value,
    MAX(CASE WHEN ar.attribute_code = 'CURRENCY' THEN eav.golden_value END) AS currency,
    MAX(CASE WHEN ar.attribute_code = 'STATUS' THEN eav.golden_value END) AS status,
    
    -- Relationships
    MAX(CASE WHEN ar.attribute_code = 'ISSUER_ID' THEN eav.golden_value END) AS issuer_code,
    MAX(CASE WHEN ar.attribute_code = 'FUND_ID' THEN eav.golden_value END) AS fund_code,
    
    me.metadata,
    me.created_at,
    me.updated_at
FROM entity_instances.master_entities me
LEFT JOIN golden_master.entity_attribute_values eav 
    ON eav.entity_id = me.id 
    AND eav.valid_to = '9999-12-31'
    AND eav.system_to = '9999-12-31 23:59:59'
LEFT JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
WHERE me.domain_code = 'DEAL'
GROUP BY me.id, me.entity_code, me.entity_name, me.description, me.is_active, me.metadata, me.created_at, me.updated_at;

COMMENT ON VIEW read_projections.deal_master IS 'Denormalized deal view with pivoted attributes';

-- Position Projection: Flattened position view
CREATE OR REPLACE VIEW read_projections.position_master AS
SELECT 
    di.id AS position_id,
    di.intersection_code AS position_code,
    di.position_type,
    di.quantity,
    di.currency,
    
    -- Related entities
    f.entity_name AS fund_name,
    f.entity_code AS fund_code,
    i.entity_name AS issuer_name,
    i.entity_code AS issuer_code,
    d.entity_name AS deal_name,
    d.entity_code AS deal_code,
    s.entity_name AS security_name,
    s.entity_code AS security_code,
    
    -- Latest metrics
    pm.market_value,
    pm.cost_basis,
    pm.unrealized_gain_loss,
    pm.daily_return,
    pm.ytd_return,
    pm.metric_date AS metrics_date,
    
    di.valid_from,
    di.valid_to,
    di.metadata,
    di.created_at,
    di.updated_at
FROM position_master.dimensional_intersections di
LEFT JOIN entity_instances.master_entities f ON f.id = di.fund_entity_id
LEFT JOIN entity_instances.master_entities i ON i.id = di.issuer_entity_id
LEFT JOIN entity_instances.master_entities d ON d.id = di.deal_entity_id
LEFT JOIN entity_instances.master_entities s ON s.id = di.security_entity_id
LEFT JOIN LATERAL (
    SELECT *
    FROM position_master.position_metrics
    WHERE intersection_id = di.id
    ORDER BY metric_date DESC
    LIMIT 1
) pm ON TRUE
WHERE di.valid_to = '9999-12-31'
    AND di.system_to = '9999-12-31 23:59:59';

COMMENT ON VIEW read_projections.position_master IS 'Denormalized position view with related entities and latest metrics';
