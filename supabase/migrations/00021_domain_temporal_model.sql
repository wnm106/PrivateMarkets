-- Migration: Add as-of-date temporal metadata to domain_types
-- Description: Declares which domains require an as-of-date dimension
--              and at what granularity, distinguishing it from knowledge date.
--
-- As Of Date (Valid Time): When was this fact true in the real world?
-- Knowledge Date (System Time): When did we learn about / record this fact?
--
-- This metadata drives UI behavior (show/hide date picker), loader logic,
-- and validation rules per domain.

-- ============================================================
-- 1. Add temporal columns to domain_types
-- ============================================================

-- temporal_model: Does this domain track values over valid time?
--   NONE       - No as-of-date needed (static reference data)
--   VALID_TIME - Values change over time; each record needs an as-of-date
ALTER TABLE metadata_register.domain_types
    ADD COLUMN IF NOT EXISTS temporal_model VARCHAR(20) DEFAULT 'NONE'
    CHECK (temporal_model IN ('NONE', 'VALID_TIME'));

-- as_of_date_granularity: The natural time granularity for as-of-date values
ALTER TABLE metadata_register.domain_types
    ADD COLUMN IF NOT EXISTS as_of_date_granularity VARCHAR(20)
    CHECK (as_of_date_granularity IN ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL', 'IRREGULAR'));

-- as_of_date_label: Display label for UI (e.g. "As Of Date", "Valuation Date", "Trade Date")
ALTER TABLE metadata_register.domain_types
    ADD COLUMN IF NOT EXISTS as_of_date_label VARCHAR(100);

-- ============================================================
-- 2. Seed temporal models for existing domains
-- ============================================================

UPDATE metadata_register.domain_types SET
    temporal_model = 'VALID_TIME',
    as_of_date_granularity = 'DAILY',
    as_of_date_label = 'Pricing Date'
WHERE domain_code = 'PRICE';

UPDATE metadata_register.domain_types SET
    temporal_model = 'VALID_TIME',
    as_of_date_granularity = 'DAILY',
    as_of_date_label = 'Position Date'
WHERE domain_code = 'POSITION';

UPDATE metadata_register.domain_types SET
    temporal_model = 'VALID_TIME',
    as_of_date_granularity = 'DAILY',
    as_of_date_label = 'Effective Date'
WHERE domain_code = 'DEAL';

UPDATE metadata_register.domain_types SET
    temporal_model = 'VALID_TIME',
    as_of_date_granularity = 'MONTHLY',
    as_of_date_label = 'As Of Date'
WHERE domain_code = 'FUND';

-- ISSUER and SECURITY remain temporal_model = 'NONE' (static reference data)

-- ============================================================
-- 3. Index for efficient lookups
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_domain_temporal_model
    ON metadata_register.domain_types(temporal_model)
    WHERE temporal_model != 'NONE';

-- ============================================================
-- 4. Comments
-- ============================================================

COMMENT ON COLUMN metadata_register.domain_types.temporal_model IS
'Whether this domain requires an as-of-date (valid time) dimension. NONE = static entity, no time variation. VALID_TIME = values change over time; each record must carry an as-of-date.';

COMMENT ON COLUMN metadata_register.domain_types.as_of_date_granularity IS
'Natural time granularity for as-of-date: DAILY (prices, positions), MONTHLY (fund AUM), QUARTERLY (financials), etc.';

COMMENT ON COLUMN metadata_register.domain_types.as_of_date_label IS
'Display label for the as-of-date field in the UI. Allows domain-specific naming: "Pricing Date", "Position Date", "Valuation Date", etc.';
