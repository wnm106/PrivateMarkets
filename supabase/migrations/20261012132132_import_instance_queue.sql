-- One queue row per uploaded file. The original payload and parsed rows stay
-- on the instance so the same source data can be mapped and reprocessed.

CREATE TABLE IF NOT EXISTS entity_instances.import_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES entity_instances.source_registry(id),
    map_code VARCHAR(100) NOT NULL,
    file_name VARCHAR(500) NOT NULL,
    media_type VARCHAR(200),
    source_base64 TEXT NOT NULL,
    headers JSONB NOT NULL,
    parsed_rows JSONB NOT NULL,
    column_mappings JSONB NOT NULL,
    as_of_date DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'READY'
        CHECK (status IN ('READY', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
    row_count INTEGER NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    result JSONB,
    runs JSONB NOT NULL DEFAULT '[]',
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_instances_source_received
    ON entity_instances.import_instances(source_id, received_at DESC);

COMMENT ON TABLE entity_instances.import_instances IS
    'Queued file loads for an import source. Each row keeps the original file and every process attempt.';

ALTER TABLE entity_instances.import_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY import_instances_readable ON entity_instances.import_instances
    FOR SELECT TO authenticated
    USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_instances.import_instances TO service_role;
GRANT SELECT ON entity_instances.import_instances TO authenticated;
GRANT SELECT ON metadata_register.domain_types TO service_role;
