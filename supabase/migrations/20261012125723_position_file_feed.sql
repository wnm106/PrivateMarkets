-- Position file feed: source, controlled lists, and position attributes
-- used by the Position File column map. Load order is not stored here;
-- the application derives it from the map's parent-key columns.

INSERT INTO entity_instances.source_registry (
    source_code, source_name, source_type, vendor_name, feed_format, feed_frequency, precedence_rank
)
VALUES ('POSITION_FILE', 'Position File', 'VENDOR', 'Position File', 'CSV', 'DAILY', 45)
ON CONFLICT (source_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS entity_instances.feed_maps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    map_code VARCHAR(100) UNIQUE NOT NULL,
    source_id UUID NOT NULL REFERENCES entity_instances.source_registry(id),
    map_name VARCHAR(200) NOT NULL,
    description TEXT,
    column_mappings JSONB NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE entity_instances.feed_maps IS
    'Source-specific column maps. Parent load order is computed from parent-key columns, not from relationship direction.';

ALTER TABLE entity_instances.feed_maps ENABLE ROW LEVEL SECURITY;

CREATE POLICY feed_maps_readable ON entity_instances.feed_maps
    FOR SELECT TO authenticated
    USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.feed_maps TO service_role;
GRANT SELECT ON entity_instances.feed_maps TO authenticated;

-- The local API role can use public views, but the loader writes the base
-- tables through the exposed domain schemas. service_role does not receive
-- those grants from the earlier tenancy migrations.
GRANT USAGE ON SCHEMA entity_instances, golden_master, metadata_register TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    entity_instances.master_entities,
    entity_instances.entity_relationships,
    entity_instances.source_registry,
    entity_instances.feed_lineage,
    entity_instances.feed_maps
TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON golden_master.entity_attribute_values TO service_role;

GRANT SELECT ON
    metadata_register.attribute_register,
    metadata_register.reference_lists,
    metadata_register.reference_list_values,
    metadata_register.relationship_types,
    metadata_register.domain_templates
TO service_role;

CREATE OR REPLACE VIEW public.tenant_clients AS
SELECT id, client_code
FROM tenancy.clients;

GRANT SELECT ON public.tenant_clients TO service_role;

-- Controlled lists for values that arrive in the position file.
INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description)
VALUES
    ('COUNTRY', 'Country', NULL, 'ISO 3166-1 alpha-2 country and domicile codes'),
    ('GICS_SECTOR', 'GICS Sector', 'ISSUER', 'GICS sector names used by issuer feeds'),
    ('FUND_STATUS', 'Fund Status', 'FUND', 'Operating status of a fund'),
    ('POSITION_TYPE', 'Position Type', 'POSITION', 'Holding type on a position'),
    ('ISO_CURRENCY', 'Currency', NULL, 'ISO 4217 currency codes')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT l.id, v.value_code, v.value_label, v.display_order, v.synonyms::jsonb
FROM metadata_register.reference_lists l
JOIN (
    VALUES
        ('COUNTRY', 'AU', 'Australia', 10, '["Australia"]'),
        ('COUNTRY', 'DE', 'Germany', 20, '["Germany"]'),
        ('COUNTRY', 'GB', 'United Kingdom', 30, '["United Kingdom","UK"]'),
        ('COUNTRY', 'IE', 'Ireland', 40, '["Ireland"]'),
        ('COUNTRY', 'IT', 'Italy', 50, '["Italy"]'),
        ('COUNTRY', 'JP', 'Japan', 60, '["Japan"]'),
        ('COUNTRY', 'KY', 'Cayman Islands', 70, '["Cayman Islands"]'),
        ('COUNTRY', 'LU', 'Luxembourg', 80, '["Luxembourg"]'),
        ('COUNTRY', 'NO', 'Norway', 90, '["Norway"]'),
        ('COUNTRY', 'SG', 'Singapore', 100, '["Singapore"]'),
        ('COUNTRY', 'US', 'United States', 110, '["United States","USA"]'),
        ('GICS_SECTOR', 'INDUSTRIALS', 'Industrials', 10, '[]'),
        ('GICS_SECTOR', 'INFORMATION_TECHNOLOGY', 'Information Technology', 20, '["Information Technology","IT"]'),
        ('GICS_SECTOR', 'ENERGY', 'Energy', 30, '[]'),
        ('GICS_SECTOR', 'MATERIALS', 'Materials', 40, '[]'),
        ('GICS_SECTOR', 'FINANCIALS', 'Financials', 50, '[]'),
        ('GICS_SECTOR', 'COMMUNICATION_SERVICES', 'Communication Services', 60, '[]'),
        ('GICS_SECTOR', 'UTILITIES', 'Utilities', 70, '[]'),
        ('GICS_SECTOR', 'REAL_ESTATE', 'Real Estate', 80, '[]'),
        ('GICS_SECTOR', 'HEALTH_CARE', 'Health Care', 90, '["Healthcare"]'),
        ('GICS_SECTOR', 'CONSUMER_STAPLES', 'Consumer Staples', 100, '[]'),
        ('FUND_STATUS', 'OPEN', 'Open', 10, '["Open"]'),
        ('FUND_STATUS', 'CLOSED', 'Closed', 20, '["Closed"]'),
        ('POSITION_TYPE', 'EQUITY', 'Equity', 10, '["Equity"]'),
        ('POSITION_TYPE', 'DEBT', 'Debt', 20, '["Debt"]'),
        ('POSITION_TYPE', 'OTHER', 'Other', 30, '["Other"]'),
        ('ISO_CURRENCY', 'USD', 'US Dollar', 10, '["US Dollar","$"]'),
        ('ISO_CURRENCY', 'EUR', 'Euro', 20, '["Euro"]'),
        ('ISO_CURRENCY', 'GBP', 'British Pound', 30, '["British Pound","Sterling"]'),
        ('ISO_CURRENCY', 'JPY', 'Japanese Yen', 40, '["Japanese Yen"]'),
        ('ISO_CURRENCY', 'AUD', 'Australian Dollar', 50, '["Australian Dollar"]'),
        ('ISO_CURRENCY', 'NOK', 'Norwegian Krone', 60, '["Norwegian Krone"]'),
        ('ISO_CURRENCY', 'SGD', 'Singapore Dollar', 70, '["Singapore Dollar"]')
) AS v(list_code, value_code, value_label, display_order, synonyms)
    ON v.list_code = l.list_code
ON CONFLICT (list_id, value_code) DO NOTHING;

-- File spellings that are not already canonical instrument-type codes.
UPDATE metadata_register.reference_list_values v
SET synonyms = (
    SELECT jsonb_agg(DISTINCT syn ORDER BY syn)
    FROM (
        SELECT jsonb_array_elements_text(COALESCE(v.synonyms, '[]'::jsonb)) AS syn
        UNION
        SELECT unnest(ARRAY['CORPORATE_BOND', 'CONVERTIBLE_BOND', 'Corporate Bond', 'Convertible Bond'])
    ) s
)
FROM metadata_register.reference_lists l
WHERE v.list_id = l.id
  AND l.list_code = 'INSTRUMENT_TYPE'
  AND v.value_code = 'BOND';

UPDATE metadata_register.reference_list_values v
SET synonyms = (
    SELECT jsonb_agg(DISTINCT syn ORDER BY syn)
    FROM (
        SELECT jsonb_array_elements_text(COALESCE(v.synonyms, '[]'::jsonb)) AS syn
        UNION
        SELECT unnest(ARRAY['PREFERRED_STOCK', 'Preferred Stock'])
    ) s
)
FROM metadata_register.reference_lists l
WHERE v.list_id = l.id
  AND l.list_code = 'INSTRUMENT_TYPE'
  AND v.value_code = 'PREFERRED_EQUITY';

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, domain_code, description, is_time_varying, time_dimension
)
VALUES
    ('POSITION_TYPE', 'Position Type', 'STRING', 'POSITION', 'Holding type from a position feed', TRUE, 'VALID_TIME'),
    ('POSITION_CURRENCY', 'Position Currency', 'STRING', 'POSITION', 'Currency of the position amounts', TRUE, 'VALID_TIME'),
    ('UNREALIZED_GAIN_LOSS', 'Unrealized Gain / Loss', 'CURRENCY', 'POSITION', 'Unrealized gain or loss on the position', TRUE, 'VALID_TIME'),
    ('DAILY_RETURN', 'Daily Return', 'PERCENTAGE', 'POSITION', 'One-day return on the position', TRUE, 'VALID_TIME'),
    ('YTD_RETURN', 'Year-to-date Return', 'PERCENTAGE', 'POSITION', 'Year-to-date return on the position', TRUE, 'VALID_TIME'),
    ('METRIC_DATE', 'Metric Date', 'DATE', 'POSITION', 'Date the position metrics were measured', TRUE, 'VALID_TIME')
ON CONFLICT (attribute_code) DO UPDATE
SET domain_code = EXCLUDED.domain_code,
    data_type = EXCLUDED.data_type,
    attribute_name = EXCLUDED.attribute_name,
    is_time_varying = EXCLUDED.is_time_varying,
    time_dimension = EXCLUDED.time_dimension;

UPDATE metadata_register.attribute_register SET reference_list_code = 'SP_RATING' WHERE attribute_code = 'CREDIT_RATING';
UPDATE metadata_register.attribute_register SET reference_list_code = 'INSTRUMENT_TYPE' WHERE attribute_code = 'INSTRUMENT_TYPE';
UPDATE metadata_register.attribute_register SET reference_list_code = 'COUNTRY' WHERE attribute_code IN ('COUNTRY', 'DOMICILE');
UPDATE metadata_register.attribute_register SET reference_list_code = 'GICS_SECTOR' WHERE attribute_code = 'SECTOR';
UPDATE metadata_register.attribute_register SET reference_list_code = 'FUND_STATUS' WHERE attribute_code = 'FUND_STATUS';
UPDATE metadata_register.attribute_register SET reference_list_code = 'POSITION_TYPE' WHERE attribute_code = 'POSITION_TYPE';
UPDATE metadata_register.attribute_register SET reference_list_code = 'ISO_CURRENCY'
WHERE attribute_code IN ('CURRENCY', 'NAV_CURRENCY', 'POSITION_CURRENCY');

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, display_order, display_label)
SELECT t.id, a.id, FALSE, 400 + ROW_NUMBER() OVER (ORDER BY a.attribute_code), a.attribute_name
FROM metadata_register.domain_templates t
JOIN metadata_register.attribute_register a
  ON (
      (t.template_code = 'POSITION_STANDARD' AND a.attribute_code IN (
          'POSITION_TYPE', 'POSITION_CURRENCY', 'UNREALIZED_GAIN_LOSS', 'DAILY_RETURN', 'YTD_RETURN', 'METRIC_DATE'
      ))
      OR (t.template_code = 'FUND_STANDARD' AND a.attribute_code IN ('EXPENSE_RATIO', 'DOMICILE'))
  )
ON CONFLICT (template_id, attribute_id) DO NOTHING;
