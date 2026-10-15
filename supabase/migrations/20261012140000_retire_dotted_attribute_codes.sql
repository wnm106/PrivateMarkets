-- Migration: Retire the two dotted attribute codes that break every entity grid
--
-- 00011 and 20261012100000 seed two attribute rows whose codes embed a dot
-- ('POSITION.MARKET_VALUE', 'ISSUER.CREDIT_RATING'). The report grid (00053)
-- reserves "<alias>.<attribute>" for attributes reached through a declared
-- relationship lookup, so a bare dotted code can never be addressed as a column:
-- reporting.field_meta raises 'Unknown lookup "ISSUER" in field ISSUER.CREDIT_RATING'.
--
-- EntityAttributeTable pivots every attribute of a domain into a grid column, so
-- sending either code failed the entire page query. /funds, /issuers, /deals,
-- /investors and /securities rendered "No ... found" against a valid record set.
--
-- Both rows duplicate attributes that already exist with proper domain scoping
-- (POSITION.MARKET_VALUE -> MARKET_VALUE on POSITION, ISSUER.CREDIT_RATING ->
-- CREDIT_RATING on ISSUER) and nothing references them -- no template
-- assignments, golden values or source values -- so they are removed. The two
-- derived attributes that named them as dependencies are repointed first.

BEGIN;

-- 1. Repoint derived-attribute dependencies at the surviving attribute codes.
UPDATE metadata_register.attribute_register
SET derivation_dependencies = (
        SELECT jsonb_agg(
                 CASE elem
                     WHEN 'POSITION.MARKET_VALUE' THEN 'MARKET_VALUE'
                     WHEN 'ISSUER.CREDIT_RATING' THEN 'CREDIT_RATING'
                     ELSE elem
                 END)
        FROM jsonb_array_elements_text(derivation_dependencies) AS elem)
WHERE derivation_dependencies ?| ARRAY['POSITION.MARKET_VALUE', 'ISSUER.CREDIT_RATING'];

-- 2. Drop the dotted rows.
DELETE FROM metadata_register.attribute_register
WHERE attribute_code IN ('POSITION.MARKET_VALUE', 'ISSUER.CREDIT_RATING');

COMMIT;

NOTIFY pgrst, 'reload schema';
