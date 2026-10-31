-- A guided load. The original file stays on the session. The specialist's
-- questions, answers, and the reusable map it produces are stored with it.
-- feed_maps remains the library of maps that can be applied again.

CREATE TABLE IF NOT EXISTS entity_instances.load_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name VARCHAR(500) NOT NULL,
    media_type VARCHAR(200),
    source_base64 TEXT NOT NULL,
    extraction_method VARCHAR(40) NOT NULL DEFAULT 'tabular',
    extraction_note TEXT,
    headers JSONB NOT NULL DEFAULT '[]',
    parsed_rows JSONB NOT NULL DEFAULT '[]',
    tables JSONB NOT NULL DEFAULT '[]',
    row_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'INTERVIEW'
        CHECK (status IN ('EXTRACTING', 'INTERVIEW', 'READY', 'LOADING', 'LOADED', 'FAILED')),
    briefing TEXT,
    questions JSONB NOT NULL DEFAULT '[]',
    answers JSONB NOT NULL DEFAULT '{}',
    recommendations JSONB NOT NULL DEFAULT '[]',
    accepted_recommendations JSONB NOT NULL DEFAULT '[]',
    dismissed_recommendations JSONB NOT NULL DEFAULT '[]',
    column_mappings JSONB NOT NULL DEFAULT '[]',
    map_draft JSONB,
    saved_map_code VARCHAR(100),
    source_code VARCHAR(50),
    as_of_date DATE,
    result JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_load_sessions_created
    ON entity_instances.load_sessions(created_at DESC);

COMMENT ON TABLE entity_instances.load_sessions IS
    'One guided import. The specialist reads the file, asks for the decisions it cannot make, and loads through a reusable source map.';

ALTER TABLE entity_instances.load_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY load_sessions_readable ON entity_instances.load_sessions
    FOR SELECT TO authenticated
    USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.load_sessions TO service_role;
GRANT SELECT ON entity_instances.load_sessions TO authenticated;

-- The specialist can add a source, an entity, an attribute, or a relationship
-- when the file contains something the model does not have yet.
GRANT INSERT, UPDATE ON
    metadata_register.domain_types,
    metadata_register.domain_templates,
    metadata_register.attribute_register,
    metadata_register.template_attribute_assignments,
    metadata_register.relationship_types
TO service_role;

GRANT INSERT, UPDATE ON entity_instances.source_registry TO service_role;
