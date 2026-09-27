-- Migration: Golden Master Schema
-- Description: Bi-temporal EAV ledger with source precedence and golden record resolution

-- Entity Attribute Values: The core bi-temporal EAV ledger
CREATE TABLE golden_master.entity_attribute_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id) ON DELETE CASCADE,
    attribute_id UUID NOT NULL REFERENCES metadata_register.attribute_register(id),
    source_id UUID NOT NULL REFERENCES entity_instances.source_registry(id),
    source_value_id UUID REFERENCES entity_instances.source_attribute_values(id),
    
    -- Golden record value (resolved from multiple sources)
    golden_value TEXT,
    golden_value_jsonb JSONB,
    golden_value_numeric NUMERIC,
    golden_value_date DATE,
    golden_value_timestamp TIMESTAMPTZ,
    golden_value_boolean BOOLEAN,
    
    -- Bi-temporal dimensions
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL DEFAULT '9999-12-31',
    system_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    system_to TIMESTAMPTZ NOT NULL DEFAULT '9999-12-31 23:59:59',
    
    -- Precedence and confidence
    precedence_rank INTEGER NOT NULL,
    confidence_score DECIMAL(5,4),
    is_manual_override BOOLEAN DEFAULT FALSE,
    override_reason TEXT,
    
    -- Audit trail
    competing_values JSONB DEFAULT '[]',
    resolution_rule_applied VARCHAR(200),
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id),
    updated_by UUID REFERENCES auth.users(id)
);

-- Indexes for efficient temporal queries
CREATE INDEX idx_eav_entity ON golden_master.entity_attribute_values(entity_id);
CREATE INDEX idx_eav_attribute ON golden_master.entity_attribute_values(attribute_id);
CREATE INDEX idx_eav_source ON golden_master.entity_attribute_values(source_id);
CREATE INDEX idx_eav_valid_time ON golden_master.entity_attribute_values USING gist (valid_from, valid_to);
CREATE INDEX idx_eav_system_time ON golden_master.entity_attribute_values USING gist (system_from, system_to);
CREATE INDEX idx_eav_current_valid ON golden_master.entity_attribute_values(entity_id, attribute_id) 
    WHERE valid_to = '9999-12-31' AND system_to = '9999-12-31 23:59:59';
CREATE INDEX idx_eav_precedence ON golden_master.entity_attribute_values(precedence_rank);

COMMENT ON TABLE golden_master.entity_attribute_values IS 'Bi-temporal EAV ledger storing golden records with source precedence and competing values';

-- Function to resolve golden record based on precedence
CREATE OR REPLACE FUNCTION golden_master.resolve_golden_record(
    p_entity_id UUID,
    p_attribute_id UUID,
    p_as_of_date DATE DEFAULT CURRENT_DATE
) RETURNS TABLE (
    golden_value TEXT,
    source_id UUID,
    source_code VARCHAR,
    precedence_rank INTEGER,
    valid_from DATE,
    valid_to DATE
) LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN QUERY
    SELECT 
        eav.golden_value,
        eav.source_id,
        sr.source_code,
        eav.precedence_rank,
        eav.valid_from,
        eav.valid_to
    FROM golden_master.entity_attribute_values eav
    JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
    WHERE eav.entity_id = p_entity_id
        AND eav.attribute_id = p_attribute_id
        AND eav.valid_from <= p_as_of_date
        AND eav.valid_to >= p_as_of_date
        AND eav.system_to = '9999-12-31 23:59:59'
    ORDER BY eav.precedence_rank ASC
    LIMIT 1;
END;
$$;

COMMENT ON FUNCTION golden_master.resolve_golden_record IS 'Resolves the golden record value for an entity-attribute at a point in time';

-- Function to split valid time (bi-temporal split)
CREATE OR REPLACE FUNCTION golden_master.split_valid_time(
    p_eav_id UUID,
    p_split_date DATE,
    p_new_value TEXT,
    p_source_id UUID,
    p_user_id UUID DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
    v_old_record RECORD;
    v_new_id UUID;
BEGIN
    -- Get the existing record
    SELECT * INTO v_old_record
    FROM golden_master.entity_attribute_values
    WHERE id = p_eav_id
        AND system_to = '9999-12-31 23:59:59';
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Record not found or already closed: %', p_eav_id;
    END IF;
    
    IF p_split_date < v_old_record.valid_from OR p_split_date > v_old_record.valid_to THEN
        RAISE EXCEPTION 'Split date % outside valid range [% to %]', 
            p_split_date, v_old_record.valid_from, v_old_record.valid_to;
    END IF;
    
    -- Close the old record
    UPDATE golden_master.entity_attribute_values
    SET 
        valid_to = p_split_date - INTERVAL '1 day',
        system_to = NOW(),
        updated_by = p_user_id
    WHERE id = p_eav_id;
    
    -- Create new record with new value
    INSERT INTO golden_master.entity_attribute_values (
        entity_id,
        attribute_id,
        source_id,
        golden_value,
        valid_from,
        valid_to,
        precedence_rank,
        is_manual_override,
        created_by
    ) VALUES (
        v_old_record.entity_id,
        v_old_record.attribute_id,
        p_source_id,
        p_new_value,
        p_split_date,
        v_old_record.valid_to,
        v_old_record.precedence_rank,
        TRUE,
        p_user_id
    ) RETURNING id INTO v_new_id;
    
    RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION golden_master.split_valid_time IS 'Splits a bi-temporal record at a specified date, creating a new version';

-- View: Current golden records (as of today)
CREATE OR REPLACE VIEW golden_master.current_golden_records AS
SELECT 
    eav.*,
    me.entity_code,
    me.domain_code,
    me.entity_name,
    ar.attribute_code,
    ar.attribute_name,
    ar.data_type,
    sr.source_code,
    sr.source_name
FROM golden_master.entity_attribute_values eav
JOIN entity_instances.master_entities me ON me.id = eav.entity_id
JOIN metadata_register.attribute_register ar ON ar.id = eav.attribute_id
JOIN entity_instances.source_registry sr ON sr.id = eav.source_id
WHERE eav.valid_to = '9999-12-31'
    AND eav.system_to = '9999-12-31 23:59:59';

COMMENT ON VIEW golden_master.current_golden_records IS 'Current golden records as of today';
