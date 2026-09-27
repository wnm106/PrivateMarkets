-- Migration: Create core schemas for Meridian MDM
-- Description: Establishes the schema boundaries for the bi-temporal EAV architecture

-- Metadata Registry: Domain types, attributes, templates
CREATE SCHEMA IF NOT EXISTS metadata_register;
COMMENT ON SCHEMA metadata_register IS 'Registry of domain types, attribute definitions, and template configurations';

-- Entity Instances: Master entities and source tracking
CREATE SCHEMA IF NOT EXISTS entity_instances;
COMMENT ON SCHEMA entity_instances IS 'Master entity registry and source/vendor feed tracking';

-- Golden Master: Bi-temporal EAV ledger
CREATE SCHEMA IF NOT EXISTS golden_master;
COMMENT ON SCHEMA golden_master IS 'Bi-temporal Entity-Attribute-Value ledger with source precedence';

-- Position Master: Dimensional intersections and metrics
CREATE SCHEMA IF NOT EXISTS position_master;
COMMENT ON SCHEMA position_master IS 'Position-level dimensional data and calculated metrics';

-- Data Quality: Rules and exceptions
CREATE SCHEMA IF NOT EXISTS data_quality;
COMMENT ON SCHEMA data_quality IS 'Data quality rule engine and exception tracking';

-- Read Projections: CQRS flattened views
CREATE SCHEMA IF NOT EXISTS read_projections;
COMMENT ON SCHEMA read_projections IS 'Denormalized read-optimized projections for CQRS pattern';

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
