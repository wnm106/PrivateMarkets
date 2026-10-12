-- Migration: Import Maps
-- Description: Tables for AI-assisted data import mapping and execution

-- Import Maps: Stores import configurations and mappings
CREATE TABLE entity_instances.import_maps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    source_format VARCHAR(10) NOT NULL CHECK (source_format IN ('XLSX', 'CSV', 'JSON', 'HTML', 'XML')),
    source_data TEXT NOT NULL, -- Base64-encoded for binary, raw for text
    domain_mappings JSONB NOT NULL DEFAULT '[]',
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ANALYZING', 'READY', 'IMPORTING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    options JSONB DEFAULT '{}',
    
    -- Analysis results
    last_analysis JSONB,
    last_analysis_at TIMESTAMPTZ,
    
    -- Execution results
    last_execution JSONB,
    last_execution_at TIMESTAMPTZ,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by VARCHAR(100)
);

CREATE INDEX idx_import_maps_status ON entity_instances.import_maps(status);
CREATE INDEX idx_import_maps_format ON entity_instances.import_maps(source_format);
CREATE INDEX idx_import_maps_created ON entity_instances.import_maps(created_at);

COMMENT ON TABLE entity_instances.import_maps IS 'AI-assisted import map configurations for data source ingestion';

-- Import Execution Logs: Tracks individual import executions
CREATE TABLE entity_instances.import_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    import_map_id UUID NOT NULL REFERENCES entity_instances.import_maps(id) ON DELETE CASCADE,
    execution_id VARCHAR(100) NOT NULL UNIQUE,
    
    -- Execution details
    status VARCHAR(20) NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    
    -- Results
    results JSONB NOT NULL DEFAULT '[]',
    summary JSONB NOT NULL DEFAULT '{}',
    errors JSONB NOT NULL DEFAULT '[]',
    
    -- Options used
    dry_run BOOLEAN DEFAULT FALSE,
    skip_validation BOOLEAN DEFAULT FALSE,
    continue_on_error BOOLEAN DEFAULT FALSE,
    batch_size INTEGER DEFAULT 100,
    
    -- Metadata
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_import_executions_map ON entity_instances.import_executions(import_map_id);
CREATE INDEX idx_import_executions_status ON entity_instances.import_executions(status);
CREATE INDEX idx_import_executions_started ON entity_instances.import_executions(started_at);

COMMENT ON TABLE entity_instances.import_executions IS 'Execution history for import map runs';

-- Add IMPORT source to source_registry if not exists
INSERT INTO entity_instances.source_registry (source_code, source_name, source_type, precedence_rank)
VALUES ('IMPORT', 'Data Import', 'INTERNAL', 50)
ON CONFLICT (source_code) DO NOTHING;
