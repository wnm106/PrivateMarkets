-- Migration: Generic Intersection Model
-- Description: Replaces hardcoded dimensional_intersections with a flexible, 
--              metadata-driven intersection framework supporting any entity combination
-- NOTE: All statements are idempotent (IF NOT EXISTS) for safe re-execution

-- ============================================================
-- 1. Intersection Type Definitions (Metadata)
-- ============================================================

-- Intersection Types: Defines what kinds of intersections exist
CREATE TABLE IF NOT EXISTS metadata_register.intersection_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intersection_code VARCHAR(100) UNIQUE NOT NULL,
    intersection_name VARCHAR(200) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intersection_types_code ON metadata_register.intersection_types(intersection_code);
CREATE INDEX IF NOT EXISTS idx_intersection_types_active ON metadata_register.intersection_types(is_active);

COMMENT ON TABLE metadata_register.intersection_types IS 'Registry of intersection types (e.g., Position, Loan, Portfolio)';

-- Intersection Type Members: Defines which entity domains compose each intersection type
CREATE TABLE IF NOT EXISTS metadata_register.intersection_type_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intersection_type_id UUID NOT NULL REFERENCES metadata_register.intersection_types(id) ON DELETE CASCADE,
    domain_code VARCHAR(50) NOT NULL REFERENCES metadata_register.domain_types(domain_code),
    member_role VARCHAR(100) NOT NULL, -- e.g., 'FUND', 'SECURITY', 'BORROWER'
    is_required BOOLEAN DEFAULT TRUE,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(intersection_type_id, member_role)
);

CREATE INDEX IF NOT EXISTS idx_intersection_type_members_type ON metadata_register.intersection_type_members(intersection_type_id);
CREATE INDEX IF NOT EXISTS idx_intersection_type_members_domain ON metadata_register.intersection_type_members(domain_code);

COMMENT ON TABLE metadata_register.intersection_type_members IS 'Defines which entity domains compose each intersection type';

-- Ensure display_order column exists (for tables created before this column was added)
ALTER TABLE metadata_register.intersection_type_members 
    ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0;

-- ============================================================
-- 2. Intersection Instances (Data)
-- ============================================================

-- Intersection Instances: Actual intersection records
CREATE TABLE IF NOT EXISTS entity_instances.intersection_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intersection_type_id UUID NOT NULL REFERENCES metadata_register.intersection_types(id),
    intersection_code VARCHAR(100) UNIQUE NOT NULL,
    
    -- Bi-temporal tracking
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL DEFAULT '9999-12-31',
    system_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    system_to TIMESTAMPTZ NOT NULL DEFAULT '9999-12-31 23:59:59',
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id),
    updated_by UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_intersection_instances_type ON entity_instances.intersection_instances(intersection_type_id);
CREATE INDEX IF NOT EXISTS idx_intersection_instances_code ON entity_instances.intersection_instances(intersection_code);
CREATE INDEX IF NOT EXISTS idx_intersection_instances_valid_time ON entity_instances.intersection_instances USING gist (valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_intersection_instances_system_time ON entity_instances.intersection_instances USING gist (system_from, system_to);
CREATE INDEX IF NOT EXISTS idx_intersection_instances_current ON entity_instances.intersection_instances(intersection_code) 
    WHERE valid_to = '9999-12-31' AND system_to = '9999-12-31 23:59:59';

COMMENT ON TABLE entity_instances.intersection_instances IS 'Actual intersection instances (e.g., a specific Position, Loan, or Portfolio)';

-- Ensure updated_at column exists (for tables created before this column was added)
ALTER TABLE entity_instances.intersection_instances 
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Intersection Members: Links intersections to their constituent entities
CREATE TABLE IF NOT EXISTS entity_instances.intersection_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intersection_id UUID NOT NULL REFERENCES entity_instances.intersection_instances(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES entity_instances.master_entities(id),
    member_role VARCHAR(100) NOT NULL, -- Matches intersection_type_members.member_role
    
    -- Bi-temporal tracking (members can change over time)
    valid_from DATE NOT NULL,
    valid_to DATE NOT NULL DEFAULT '9999-12-31',
    system_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    system_to TIMESTAMPTZ NOT NULL DEFAULT '9999-12-31 23:59:59',
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(intersection_id, member_role, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_intersection_members_intersection ON entity_instances.intersection_members(intersection_id);
CREATE INDEX IF NOT EXISTS idx_intersection_members_entity ON entity_instances.intersection_members(entity_id);
CREATE INDEX IF NOT EXISTS idx_intersection_members_role ON entity_instances.intersection_members(member_role);
CREATE INDEX IF NOT EXISTS idx_intersection_members_valid_time ON entity_instances.intersection_members USING gist (valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_intersection_members_current ON entity_instances.intersection_members(intersection_id, member_role) 
    WHERE valid_to = '9999-12-31' AND system_to = '9999-12-31 23:59:59';

COMMENT ON TABLE entity_instances.intersection_members IS 'Links intersections to their constituent entities with role assignments';

-- ============================================================
-- 3. Intersection Attributes (EAV for intersection-specific data)
-- ============================================================

-- Intersection Attribute Values: EAV storage for intersection-specific attributes
CREATE TABLE IF NOT EXISTS golden_master.intersection_attribute_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intersection_id UUID NOT NULL REFERENCES entity_instances.intersection_instances(id) ON DELETE CASCADE,
    attribute_id UUID NOT NULL REFERENCES metadata_register.attribute_register(id),
    source_id UUID NOT NULL REFERENCES entity_instances.source_registry(id),
    
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

CREATE INDEX IF NOT EXISTS idx_iav_intersection ON golden_master.intersection_attribute_values(intersection_id);
CREATE INDEX IF NOT EXISTS idx_iav_attribute ON golden_master.intersection_attribute_values(attribute_id);
CREATE INDEX IF NOT EXISTS idx_iav_source ON golden_master.intersection_attribute_values(source_id);
CREATE INDEX IF NOT EXISTS idx_iav_valid_time ON golden_master.intersection_attribute_values USING gist (valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_iav_system_time ON golden_master.intersection_attribute_values USING gist (system_from, system_to);
CREATE INDEX IF NOT EXISTS idx_iav_current ON golden_master.intersection_attribute_values(intersection_id, attribute_id) 
    WHERE valid_to = '9999-12-31' AND system_to = '9999-12-31 23:59:59';

COMMENT ON TABLE golden_master.intersection_attribute_values IS 'Bi-temporal EAV storage for intersection-specific attributes (e.g., position quantity, loan amount)';

-- ============================================================
-- 4. Seed Data: Define Position as an intersection type
-- ============================================================

-- Insert Position intersection type
INSERT INTO metadata_register.intersection_types (intersection_code, intersection_name, description) VALUES
    ('POSITION', 'Position', 'Portfolio position representing ownership of a security within a fund')
ON CONFLICT (intersection_code) DO NOTHING;

-- Insert Position members (Fund + Security as required, Issuer + Deal as optional)
INSERT INTO metadata_register.intersection_type_members (intersection_type_id, domain_code, member_role, is_required, display_order)
SELECT 
    (SELECT id FROM metadata_register.intersection_types WHERE intersection_code = 'POSITION'),
    dt.domain_code,
    member_role,
    is_required,
    display_order
FROM (VALUES
    ('FUND', 'FUND', TRUE, 1),
    ('SECURITY', 'SECURITY', TRUE, 2),
    ('ISSUER', 'ISSUER', FALSE, 3),
    ('DEAL', 'DEAL', FALSE, 4)
) AS dt(domain_code, member_role, is_required, display_order)
ON CONFLICT (intersection_type_id, member_role) DO NOTHING;

-- ============================================================
-- 5. Helper Functions
-- ============================================================

-- Function to validate intersection member completeness
CREATE OR REPLACE FUNCTION entity_instances.validate_intersection_members(
    p_intersection_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_intersection_type_id UUID;
    v_required_count INTEGER;
    v_actual_count INTEGER;
BEGIN
    -- Get intersection type
    SELECT intersection_type_id INTO v_intersection_type_id
    FROM entity_instances.intersection_instances
    WHERE id = p_intersection_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Intersection not found: %', p_intersection_id;
    END IF;
    
    -- Count required members
    SELECT COUNT(*) INTO v_required_count
    FROM metadata_register.intersection_type_members
    WHERE intersection_type_id = v_intersection_type_id
      AND is_required = TRUE;
    
    -- Count actual current members
    SELECT COUNT(DISTINCT member_role) INTO v_actual_count
    FROM entity_instances.intersection_members
    WHERE intersection_id = p_intersection_id
      AND valid_to = '9999-12-31'
      AND system_to = '9999-12-31 23:59:59'
      AND member_role IN (
          SELECT member_role 
          FROM metadata_register.intersection_type_members 
          WHERE intersection_type_id = v_intersection_type_id 
            AND is_required = TRUE
      );
    
    RETURN v_actual_count >= v_required_count;
END;
$$;

COMMENT ON FUNCTION entity_instances.validate_intersection_members IS 'Validates that an intersection has all required members';

-- Function to get intersection with all members and attributes
CREATE OR REPLACE FUNCTION entity_instances.get_intersection_full(
    p_intersection_code VARCHAR,
    p_as_of_date DATE DEFAULT CURRENT_DATE
) RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_result JSONB;
    v_intersection RECORD;
    v_members JSONB;
    v_attributes JSONB;
BEGIN
    -- Get intersection instance
    SELECT * INTO v_intersection
    FROM entity_instances.intersection_instances ii
    JOIN metadata_register.intersection_types it ON it.id = ii.intersection_type_id
    WHERE ii.intersection_code = p_intersection_code
      AND ii.valid_from <= p_as_of_date
      AND ii.valid_to >= p_as_of_date
      AND ii.system_to = '9999-12-31 23:59:59';
    
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Get members
    SELECT jsonb_agg(
        jsonb_build_object(
            'member_role', im.member_role,
            'entity_id', im.entity_id,
            'entity_code', me.entity_code,
            'entity_name', me.entity_name,
            'domain_code', me.domain_code
        )
    ) INTO v_members
    FROM entity_instances.intersection_members im
    JOIN entity_instances.master_entities me ON me.id = im.entity_id
    WHERE im.intersection_id = v_intersection.id
      AND im.valid_from <= p_as_of_date
      AND im.valid_to >= p_as_of_date
      AND im.system_to = '9999-12-31 23:59:59';
    
    -- Get attributes
    SELECT jsonb_object_agg(
        ar.attribute_code,
        jsonb_build_object(
            'value', iav.golden_value,
            'value_numeric', iav.golden_value_numeric,
            'value_date', iav.golden_value_date,
            'source_id', iav.source_id,
            'precedence_rank', iav.precedence_rank
        )
    ) INTO v_attributes
    FROM golden_master.intersection_attribute_values iav
    JOIN metadata_register.attribute_register ar ON ar.id = iav.attribute_id
    WHERE iav.intersection_id = v_intersection.id
      AND iav.valid_from <= p_as_of_date
      AND iav.valid_to >= p_as_of_date
      AND iav.system_to = '9999-12-31 23:59:59';
    
    -- Build result
    v_result := jsonb_build_object(
        'intersection_id', v_intersection.id,
        'intersection_code', v_intersection.intersection_code,
        'intersection_type_code', (SELECT intersection_code FROM metadata_register.intersection_types WHERE id = v_intersection.intersection_type_id),
        'intersection_type_name', (SELECT intersection_name FROM metadata_register.intersection_types WHERE id = v_intersection.intersection_type_id),
        'valid_from', v_intersection.valid_from,
        'valid_to', v_intersection.valid_to,
        'members', COALESCE(v_members, '[]'::jsonb),
        'attributes', COALESCE(v_attributes, '{}'::jsonb),
        'metadata', v_intersection.metadata
    );
    
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION entity_instances.get_intersection_full IS 'Returns complete intersection data with members and attributes as JSONB';

-- ============================================================
-- 6. Views for Read Optimization
-- ============================================================

-- View: Current intersections with member summary
CREATE OR REPLACE VIEW read_projections.intersection_master AS
SELECT 
    ii.id AS intersection_id,
    ii.intersection_code,
    it.intersection_code AS intersection_type_code,
    it.intersection_name AS intersection_type_name,
    
    -- Aggregate members as JSONB
    COALESCE(
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'member_role', im.member_role,
                    'entity_id', im.entity_id,
                    'entity_code', me.entity_code,
                    'entity_name', me.entity_name,
                    'domain_code', me.domain_code
                )
            )
            FROM entity_instances.intersection_members im
            JOIN entity_instances.master_entities me ON me.id = im.entity_id
            WHERE im.intersection_id = ii.id
              AND im.valid_to = '9999-12-31'
              AND im.system_to = '9999-12-31 23:59:59'
        ),
        '[]'::jsonb
    ) AS members,
    
    -- Aggregate attributes as JSONB (only winning values with non-null golden_value)
    COALESCE(
        (
            SELECT jsonb_object_agg(
                winning.attribute_code,
                jsonb_build_object(
                    'value', winning.golden_value,
                    'value_numeric', winning.golden_value_numeric,
                    'value_date', winning.golden_value_date,
                    'source_id', winning.source_id,
                    'source_code', winning.source_code,
                    'precedence_rank', winning.precedence_rank
                )
            )
            FROM (
                SELECT DISTINCT ON (iav2.intersection_id, ar2.attribute_code)
                    iav2.intersection_id,
                    ar2.attribute_code,
                    iav2.golden_value,
                    iav2.golden_value_numeric,
                    iav2.golden_value_date,
                    iav2.source_id,
                    sr2.source_code,
                    iav2.precedence_rank
                FROM golden_master.intersection_attribute_values iav2
                JOIN metadata_register.attribute_register ar2 ON ar2.id = iav2.attribute_id
                LEFT JOIN entity_instances.source_registry sr2 ON sr2.id = iav2.source_id
                WHERE iav2.intersection_id = ii.id
                    AND iav2.valid_to = '9999-12-31'
                    AND iav2.system_to = '9999-12-31 23:59:59'
                    AND iav2.golden_value IS NOT NULL
                    AND iav2.golden_value != ''
                ORDER BY iav2.intersection_id, ar2.attribute_code, iav2.precedence_rank ASC
            ) winning
        ),
        '{}'::jsonb
    ) AS attributes,
    
    ii.valid_from,
    ii.valid_to,
    ii.metadata,
    ii.created_at,
    ii.updated_at
FROM entity_instances.intersection_instances ii
JOIN metadata_register.intersection_types it ON it.id = ii.intersection_type_id
WHERE ii.valid_to = '9999-12-31'
  AND ii.system_to = '9999-12-31 23:59:59';

COMMENT ON VIEW read_projections.intersection_master IS 'Denormalized intersection view with members and attributes as JSONB';

-- ============================================================
-- 7. Grants
-- ============================================================

GRANT SELECT ON read_projections.intersection_master TO authenticated;
GRANT EXECUTE ON FUNCTION entity_instances.validate_intersection_members TO authenticated;
GRANT EXECUTE ON FUNCTION entity_instances.get_intersection_full TO authenticated;
