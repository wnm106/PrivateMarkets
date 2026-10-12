-- Bring the remote schema up to what the merged code expects.
--
-- The time-dimension work (PR #2/#3) added `is_time_varying` and `time_dimension`
-- to 20260926000000_add_time_dimension_and_composite_relationships.sql, but that
-- migration was already applied on the remote database, so the added column never
-- reached it. Creating an attribute then failed against a missing column, and the
-- position-file migration aborted on the same gap.
--
-- This is the same change expressed forward, without touching the applied file.
--
-- The public view is extended with CREATE OR REPLACE: adding columns at the end
-- preserves the existing grants and the nine views that select from it. The
-- original approach dropped and recreated the view, which would have failed
-- outright here (dependent views) and silently dropped six live columns.

ALTER TABLE metadata_register.attribute_register
  ADD COLUMN IF NOT EXISTS is_time_varying BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS time_dimension TEXT DEFAULT 'NONE';

COMMENT ON COLUMN metadata_register.attribute_register.is_time_varying IS
  'True when the attribute changes over time and is tracked against the time dimension.';
COMMENT ON COLUMN metadata_register.attribute_register.time_dimension IS
  'Time dimension this attribute is tracked against; NONE when not time varying.';

CREATE OR REPLACE VIEW public.attribute_register AS
SELECT
    id,
    attribute_code,
    attribute_name,
    data_type,
    description,
    unit_of_measure,
    validation_regex,
    is_required,
    is_multi_valued,
    reference_domain_code,
    default_precedence_rank,
    metadata,
    created_at,
    updated_at,
    is_derived,
    display_format,
    list_values,
    validation_rules,
    default_value,
    display_section,
    display_group,
    is_editable,
    is_visible,
    derivation_formula,
    derivation_dependencies,
    derivation_type,
    formula_language,
    aggregation_type,
    weight_attribute_code,
    numeric_precision,
    domain_code,
    reference_list_code,
    is_time_varying,
    time_dimension
FROM metadata_register.attribute_register;

CREATE INDEX IF NOT EXISTS idx_attribute_time_dimension
  ON metadata_register.attribute_register(time_dimension)
  WHERE time_dimension IS NOT NULL AND time_dimension <> 'NONE';

CREATE INDEX IF NOT EXISTS idx_relationship_cardinality
  ON metadata_register.relationship_types(cardinality)
  WHERE cardinality IS NOT NULL AND cardinality <> 'ONE_TO_ONE';

-- The remaining attribute rows the same change seeds, which the remote never saw.
INSERT INTO metadata_register.attribute_register
  (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
VALUES
  ('POSITION.MARKET_VALUE', 'Position Market Value', 'CURRENCY', 'Market value of a position', FALSE, 100),
  ('ISSUER.CREDIT_RATING', 'Issuer Credit Rating', 'STRING', 'Credit rating of the parent issuer', FALSE, 100),
  ('CASH_FLOWS', 'Cash Flows', 'JSON', 'Bond cash flow schedule', FALSE, 100),
  ('YIELD_CURVE', 'Yield Curve', 'JSON', 'Yield curve used for duration', FALSE, 100),
  ('COST_BASIS', 'Cost Basis', 'CURRENCY', 'Position cost basis', FALSE, 100),
  ('QUANTITY', 'Quantity', 'NUMBER', 'Position quantity', FALSE, 100)
ON CONFLICT (attribute_code) DO NOTHING;
