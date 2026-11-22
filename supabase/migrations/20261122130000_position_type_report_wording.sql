-- The asset classes a filed report's schedule of investments prints, as
-- synonyms on the position type list.
--
-- A position's type is the broad one (Equity, Debt, Other). A BDC's or
-- registered fund's schedule groups investments by a finer class ("First Lien
-- Debt", "Common Stocks"), and the loader matches a list by code, label or
-- synonym, so every position of a filed report was stored with a type off the
-- list (and failed POSITION_TYPE_ALLOWED). The finer class stays in the stored
-- report's schedule. Existing synonyms are kept; running this again changes
-- nothing.

WITH wording(value_code, synonyms) AS (
    VALUES
        ('DEBT', '["First Lien Debt", "First Lien Senior Secured Debt", "Senior Secured Debt", "Second Lien Debt",
                   "Unitranche Debt", "Unsecured Debt", "Subordinated Debt", "Mezzanine Debt",
                   "Asset Backed Securities", "Asset-Backed Securities", "Structured Products", "Debt Investments"]'::jsonb),
        ('EQUITY', '["Common Stocks", "Common Stock", "Common Equity", "Preferred Equity", "Preferred Stock",
                     "Preferred Stocks", "Equity Investments", "Warrants"]'::jsonb)
)
UPDATE metadata_register.reference_list_values v
SET synonyms = (
    SELECT jsonb_agg(term ORDER BY first_seen)
    FROM (
        SELECT term, min(ord) AS first_seen
        FROM jsonb_array_elements_text(COALESCE(v.synonyms, '[]'::jsonb) || w.synonyms) WITH ORDINALITY AS t(term, ord)
        GROUP BY term
    ) merged
)
FROM wording w, metadata_register.reference_lists l
WHERE l.id = v.list_id
  AND l.list_code = 'POSITION_TYPE'
  AND v.value_code = w.value_code;
