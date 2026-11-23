-- The last five attributes whose formula was raw SQL.
--
-- 00011_derived_attributes seeded them as examples. Their SQL reads tables that
-- no longer exist, so none of them ever produced a value, and the record page
-- printed the SQL as the calculation. Each now either is a calculation in the
-- calculation spec, or is an ordinary field that sources supply.
--
--   TOTAL_AUM           GROSS_ASSET_VALUE, which already sums position market value over the fund.
--   CURRENT_YIELD       ANNUAL_INTEREST / CURRENT_PRICE * 100.
--   UNREALIZED_PNL      Ordinary field. Its inputs live on positions, not securities;
--                       positions carry UNREALIZED_GAIN_LOSS.
--   ISSUER_RATING       Ordinary field. It looked up the issuer's own CREDIT_RATING from itself.
--   EFFECTIVE_DURATION  Ordinary field. Duration comes from analytics vendors; there is no duration function.

-- 1. Ordinary fields ----------------------------------------------------------

UPDATE metadata_register.attribute_register
SET is_derived = FALSE,
    derivation_type = NULL,
    derivation_formula = NULL,
    derivation_dependencies = '[]'::jsonb,
    formula_language = NULL,
    updated_at = NOW()
WHERE attribute_code IN ('UNREALIZED_PNL', 'ISSUER_RATING', 'EFFECTIVE_DURATION')
  AND formula_language = 'SQL';

-- 2. Calculations ---------------------------------------------------------------
-- Both are worked out when read, so there is nothing to backfill. The sync
-- trigger on calc_definitions writes the formula, type and dependencies back
-- onto the attribute, replacing the SQL.

INSERT INTO metadata_register.calc_definitions (
    attribute_id, domain_code, calc_kind, evaluation_mode, time_impact, output_grain, expression
)
SELECT ar.id, ar.domain_code, 'EXPRESSION', 'ON_READ', 'FORWARD', 'ON_INPUT_CHANGE', v.expression
FROM (VALUES
    ('TOTAL_AUM', '{"ref":"GROSS_ASSET_VALUE"}'::jsonb),
    ('CURRENT_YIELD', '{"op":"mul","args":[{"op":"div","args":[{"ref":"ANNUAL_INTEREST"},{"ref":"CURRENT_PRICE"}]},{"const":100}]}'::jsonb)
) AS v(attribute_code, expression)
JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code
WHERE ar.formula_language = 'SQL'
ON CONFLICT (attribute_id) DO NOTHING;

INSERT INTO metadata_register.calc_inputs (
    calc_definition_id, input_role, attribute_code, traversal, relationship_codes, ordinal
)
SELECT cd.id, 'OPERAND', v.input_code, 'SELF', '{}', v.ordinal
FROM (VALUES
    ('TOTAL_AUM', 'GROSS_ASSET_VALUE', 1),
    ('CURRENT_YIELD', 'ANNUAL_INTEREST', 1),
    ('CURRENT_YIELD', 'CURRENT_PRICE', 2)
) AS v(attribute_code, input_code, ordinal)
JOIN metadata_register.attribute_register ar ON ar.attribute_code = v.attribute_code
JOIN metadata_register.calc_definitions cd ON cd.attribute_id = ar.id
ON CONFLICT (calc_definition_id, input_role, attribute_code) DO NOTHING;

-- 3. Nothing is left in SQL --------------------------------------------------------

DO $$
DECLARE
    v_left TEXT;
BEGIN
    SELECT string_agg(attribute_code, ', ' ORDER BY attribute_code) INTO v_left
    FROM metadata_register.attribute_register
    WHERE is_derived = TRUE AND formula_language = 'SQL';
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'Attributes still calculated in SQL: %', v_left;
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
