-- Migration 00049: Reference List Normalization
-- Description: Links attributes to reference_lists for value normalization during import.
--              Adds synonym support to reference_list_values for mapping variant inputs
--              to canonical values. Creates a normalization function for the import pipeline.

-- ============================================================
-- 1. Add reference_list_code to attribute_register
-- ============================================================

ALTER TABLE metadata_register.attribute_register
ADD COLUMN IF NOT EXISTS reference_list_code VARCHAR(100);

ALTER TABLE metadata_register.attribute_register
ADD CONSTRAINT fk_attribute_reference_list
FOREIGN KEY (reference_list_code) REFERENCES metadata_register.reference_lists(list_code);

CREATE INDEX IF NOT EXISTS idx_attribute_register_ref_list
ON metadata_register.attribute_register(reference_list_code)
WHERE reference_list_code IS NOT NULL;

COMMENT ON COLUMN metadata_register.attribute_register.reference_list_code IS 
'Links this attribute to a controlled vocabulary in reference_lists. When set, imported values are normalized against this list.';

-- ============================================================
-- 2. Add synonyms column to reference_list_values
-- ============================================================

ALTER TABLE metadata_register.reference_list_values
ADD COLUMN IF NOT EXISTS synonyms JSONB DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_ref_list_values_synonyms
ON metadata_register.reference_list_values USING gin(synonyms);

COMMENT ON COLUMN metadata_register.reference_list_values.synonyms IS 
'JSON array of alternative names/aliases that should normalize to this canonical value. Case-insensitive matching.';

-- ============================================================
-- 3. Normalization function
-- ============================================================

CREATE OR REPLACE FUNCTION metadata_register.normalize_reference_value(
    p_list_code VARCHAR,
    p_input_value TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $body$
DECLARE
    v_normalized_input TEXT;
    v_match record;
BEGIN
    IF p_input_value IS NULL OR trim(p_input_value) = '' THEN
        RETURN jsonb_build_object(
            'normalized', false,
            'input', p_input_value,
            'canonical_code', null,
            'canonical_label', null,
            'match_type', null,
            'message', 'Empty input value'
        );
    END IF;

    v_normalized_input := lower(trim(p_input_value));

    -- 1. Exact match on value_code (case-insensitive)
    SELECT rl.value_code, rl.value_label, 'exact_code' AS match_type
    INTO v_match
    FROM metadata_register.reference_list_values rl
    JOIN metadata_register.reference_lists r ON r.id = rl.list_id
    WHERE r.list_code = p_list_code
      AND rl.is_active = true
      AND lower(rl.value_code) = v_normalized_input
    LIMIT 1;

    IF v_match IS NOT NULL THEN
        RETURN jsonb_build_object(
            'normalized', true,
            'input', p_input_value,
            'canonical_code', v_match.value_code,
            'canonical_label', v_match.value_label,
            'match_type', v_match.match_type
        );
    END IF;

    -- 2. Exact match on value_label (case-insensitive)
    SELECT rl.value_code, rl.value_label, 'exact_label' AS match_type
    INTO v_match
    FROM metadata_register.reference_list_values rl
    JOIN metadata_register.reference_lists r ON r.id = rl.list_id
    WHERE r.list_code = p_list_code
      AND rl.is_active = true
      AND lower(rl.value_label) = v_normalized_input
    LIMIT 1;

    IF v_match IS NOT NULL THEN
        RETURN jsonb_build_object(
            'normalized', true,
            'input', p_input_value,
            'canonical_code', v_match.value_code,
            'canonical_label', v_match.value_label,
            'match_type', v_match.match_type
        );
    END IF;

    -- 3. Match against synonyms (case-insensitive)
    SELECT rl.value_code, rl.value_label, 'synonym' AS match_type
    INTO v_match
    FROM metadata_register.reference_list_values rl
    JOIN metadata_register.reference_lists r ON r.id = rl.list_id
    WHERE r.list_code = p_list_code
      AND rl.is_active = true
      AND rl.synonyms IS NOT NULL
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(rl.synonyms) AS syn
          WHERE lower(trim(syn)) = v_normalized_input
      )
    LIMIT 1;

    IF v_match IS NOT NULL THEN
        RETURN jsonb_build_object(
            'normalized', true,
            'input', p_input_value,
            'canonical_code', v_match.value_code,
            'canonical_label', v_match.value_label,
            'match_type', v_match.match_type
        );
    END IF;

    -- 4. Fuzzy match: contains/starts-with on label or synonyms
    SELECT rl.value_code, rl.value_label, 'fuzzy' AS match_type
    INTO v_match
    FROM metadata_register.reference_list_values rl
    JOIN metadata_register.reference_lists r ON r.id = rl.list_id
    WHERE r.list_code = p_list_code
      AND rl.is_active = true
      AND (
          lower(rl.value_label) LIKE '%' || v_normalized_input || '%'
          OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(rl.synonyms) AS syn
              WHERE lower(trim(syn)) LIKE '%' || v_normalized_input || '%'
          )
      )
    LIMIT 1;

    IF v_match IS NOT NULL THEN
        RETURN jsonb_build_object(
            'normalized', true,
            'input', p_input_value,
            'canonical_code', v_match.value_code,
            'canonical_label', v_match.value_label,
            'match_type', v_match.match_type,
            'confidence', 'low'
        );
    END IF;

    -- No match found
    RETURN jsonb_build_object(
        'normalized', false,
        'input', p_input_value,
        'canonical_code', null,
        'canonical_label', null,
        'match_type', null,
        'message', 'No matching canonical value found'
    );
END;
$body$;

COMMENT ON FUNCTION metadata_register.normalize_reference_value IS 
'Normalizes an input value against a reference list. Returns JSON with normalized flag, canonical code/label, and match type (exact_code, exact_label, synonym, fuzzy).';

-- ============================================================
-- 4. Batch normalization function for import pipeline
-- ============================================================

CREATE OR REPLACE FUNCTION metadata_register.batch_normalize_values(
    p_list_code VARCHAR,
    p_input_values TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $body$
DECLARE
    v_results JSONB;
    v_val TEXT;
    v_result JSONB;
BEGIN
    v_results := '[]'::jsonb;
    FOREACH v_val IN ARRAY p_input_values
    LOOP
        v_result := metadata_register.normalize_reference_value(p_list_code, v_val);
        v_results := v_results || jsonb_build_array(v_result);
    END LOOP;
    RETURN v_results;
END;
$body$;

COMMENT ON FUNCTION metadata_register.batch_normalize_values IS 
'Batch normalizes multiple values against a reference list.';

-- ============================================================
-- 5. Update the public view to include reference_list_code
-- ============================================================

DROP VIEW IF EXISTS public.attribute_register;
CREATE VIEW public.attribute_register AS
SELECT 
    id, attribute_code, attribute_name, data_type, description,
    unit_of_measure, validation_regex, is_required, is_multi_valued,
    reference_domain_code, reference_list_code, domain_code,
    default_precedence_rank, is_derived, display_format,
    list_values, validation_rules, default_value,
    display_section, display_group, is_editable, is_visible,
    metadata, created_at, updated_at
FROM metadata_register.attribute_register;

-- ============================================================
-- 6. Update get_attributes_with_aggregation RPC
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_attributes_with_aggregation(p_domain_code VARCHAR DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $body$
DECLARE
    v_result JSONB;
BEGIN
    SELECT COALESCE(
        (SELECT jsonb_agg(attr_obj)
         FROM (
             SELECT jsonb_build_object(
                 'id', id,
                 'attribute_code', attribute_code,
                 'attribute_name', attribute_name,
                 'data_type', data_type,
                 'description', description,
                 'unit_of_measure', unit_of_measure,
                 'is_required', is_required,
                 'is_multi_valued', is_multi_valued,
                 'reference_domain_code', reference_domain_code,
                 'reference_list_code', reference_list_code,
                 'domain_code', domain_code,
                 'default_precedence_rank', default_precedence_rank,
                 'is_derived', is_derived,
                 'derivation_type', derivation_type,
                 'derivation_formula', derivation_formula,
                 'derivation_dependencies', derivation_dependencies,
                 'display_format', display_format,
                 'list_values', list_values,
                 'validation_rules', validation_rules,
                 'default_value', default_value,
                 'display_section', display_section,
                 'display_group', display_group,
                 'is_editable', is_editable,
                 'is_visible', is_visible,
                 'aggregation_type', COALESCE(aggregation_type, 'NONE'),
                 'weight_attribute_code', weight_attribute_code,
                 'numeric_precision', numeric_precision
             ) AS attr_obj
             FROM metadata_register.attribute_register
             WHERE (p_domain_code IS NULL OR domain_code = p_domain_code OR domain_code IS NULL)
               AND (is_derived = false OR is_derived IS NULL)
             ORDER BY attribute_code
         ) sub
        ),
        '[]'::jsonb
    )
    INTO v_result;
    RETURN v_result;
END;
$body$;

-- ============================================================
-- 7. Summary view for reference lists
-- ============================================================

CREATE OR REPLACE VIEW metadata_register.reference_list_summary AS
SELECT 
    rl.id, rl.list_code, rl.list_name, rl.domain_code,
    rl.description, rl.is_active,
    COUNT(rlv.id) FILTER (WHERE rlv.is_active = true) AS active_value_count,
    COUNT(rlv.id) AS total_value_count,
    COALESCE(SUM(
        CASE WHEN rlv.synonyms IS NOT NULL AND jsonb_array_length(rlv.synonyms) > 0 
        THEN jsonb_array_length(rlv.synonyms) ELSE 0 END
    ), 0) AS total_synonym_count,
    (
        SELECT COUNT(DISTINCT ar.attribute_code)
        FROM metadata_register.attribute_register ar
        WHERE ar.reference_list_code = rl.list_code
    ) AS linked_attribute_count,
    rl.created_at, rl.updated_at
FROM metadata_register.reference_lists rl
LEFT JOIN metadata_register.reference_list_values rlv ON rlv.list_id = rl.id
GROUP BY rl.id, rl.list_code, rl.list_name, rl.domain_code,
         rl.description, rl.is_active, rl.created_at, rl.updated_at;

COMMENT ON VIEW metadata_register.reference_list_summary IS 
'Summary view of reference lists with value counts, synonym counts, and linked attribute counts.';

-- ============================================================
-- 8. Seed reference lists
-- ============================================================

-- Instrument Type
INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description)
VALUES ('INSTRUMENT_TYPE', 'Instrument Type', 'SECURITY', 'Classification of financial instruments')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
CROSS JOIN LATERAL (VALUES
    ('BOND', 'Bond', 1, '["Corporate Bond", "Sr. Sec. Notes", "Sr. Unsec. Notes", "Convertible", "Senior Notes"]'),
    ('LOAN', 'Loan', 2, '["Term Loan", "TLB", "Term Loan B", "Senior Loan"]'),
    ('EQUITY', 'Equity', 3, '["Common Stock", "Preferred Stock", "Common Equity", "Ordinary Shares"]'),
    ('DERIVATIVE', 'Derivative', 4, '["Option", "Swap", "Future", "Forward", "Warrant"]'),
    ('UNITRANCHE', 'Unitranche', 5, '["Unitranche Loan", "Uni-Tranche"]'),
    ('REVOLVING_CREDIT', 'Revolving Credit', 6, '["Revolver", "Revolving Facility", "Revolving Credit Facility", "RCF"]'),
    ('MEZZANINE', 'Mezzanine', 7, '["Mezzanine Debt", "Mez", "Mezz"]'),
    ('PREFERRED_EQUITY', 'Preferred Equity', 8, '["Pref Equity", "Preferred"]')
) AS v(code, label, ord, syn)
WHERE rl.list_code = 'INSTRUMENT_TYPE'
ON CONFLICT (list_id, value_code) DO UPDATE SET synonyms = EXCLUDED.synonyms;

-- Seniority
INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description)
VALUES ('SENIORITY', 'Seniority', 'SECURITY', 'Capital structure seniority ranking')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
CROSS JOIN LATERAL (VALUES
    ('SENIOR_SECURED', 'Senior Secured', 1, '["Sr. Sec.", "First Lien", "1st Lien"]'),
    ('SENIOR_UNSECURED', 'Senior Unsecured', 2, '["Sr. Unsec.", "Senior Notes"]'),
    ('SENIOR_SUBORDINATED', 'Senior Subordinated', 3, '["Sr. Sub."]'),
    ('SUBORDINATED', 'Subordinated', 4, '["Sub.", "Sub Debt"]'),
    ('MEZZANINE', 'Mezzanine', 5, '["Mez", "Mezz"]'),
    ('JUNIOR', 'Junior', 6, '["Jr.", "Sub Junior"]'),
    ('EQUITY', 'Equity', 7, '["Common Equity", "Ordinary"]')
) AS v(code, label, ord, syn)
WHERE rl.list_code = 'SENIORITY'
ON CONFLICT (list_id, value_code) DO UPDATE SET synonyms = EXCLUDED.synonyms;

-- Reference Rate
INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description)
VALUES ('REFERENCE_RATE', 'Reference Rate', 'SECURITY', 'Benchmark reference rates for floating instruments')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
CROSS JOIN LATERAL (VALUES
    ('SOFR', 'Term SOFR', 1, '["SOFR", "Secured Overnight Financing Rate"]'),
    ('EURIBOR', 'EURIBOR', 2, '["Euro Interbank Offered Rate"]'),
    ('SONIA', 'SONIA', 3, '["Sterling Overnight Index Average"]'),
    ('ESTR', 'Euro STR', 4, '["Euro Short-Term Rate", "EuroSTR"]'),
    ('LIBOR_USD', 'USD LIBOR', 5, '["LIBOR", "USD LIBOR", "London Interbank Offered Rate"]'),
    ('PRIME', 'Prime Rate', 6, '["Bank Prime", "US Prime"]'),
    ('FED_FUNDS', 'Fed Funds', 7, '["Federal Funds Rate", "FFR"]'),
    ('FIXED', 'Fixed Rate', 8, '["Fixed", "N/A - Fixed"]')
) AS v(code, label, ord, syn)
WHERE rl.list_code = 'REFERENCE_RATE'
ON CONFLICT (list_id, value_code) DO UPDATE SET synonyms = EXCLUDED.synonyms;

-- Deal Status
INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description)
VALUES ('DEAL_STATUS', 'Deal Status', 'DEAL', 'Lifecycle status of deals')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
CROSS JOIN LATERAL (VALUES
    ('PIPELINE', 'Pipeline', 1, '["Prospect", "In Pipeline"]'),
    ('UNDER_REVIEW', 'Under Review', 2, '["Review", "IC Review", "Under IC Review"]'),
    ('APPROVED', 'Approved', 3, '["IC Approved", "Committed"]'),
    ('CLOSED', 'Closed', 4, '["Closed/Won", "Funded", "Executed"]'),
    ('LOST', 'Lost', 5, '["Passed", "Declined", "Lost/Passed"]'),
    ('ABANDONED', 'Abandoned', 6, '["Dropped", "Withdrawn"]')
) AS v(code, label, ord, syn)
WHERE rl.list_code = 'DEAL_STATUS'
ON CONFLICT (list_id, value_code) DO UPDATE SET synonyms = EXCLUDED.synonyms;

-- Fund Lifecycle
INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description)
VALUES ('FUND_LIFECYCLE', 'Fund Lifecycle Stage', 'FUND', 'Current stage in the fund lifecycle')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
CROSS JOIN LATERAL (VALUES
    ('FUNDRAISING', 'Fundraising', 1, '["In Market", "Raising"]'),
    ('INVESTING', 'Investing', 2, '["Investment Period", "Deploying"]'),
    ('HARVESTING', 'Harvesting', 3, '["Harvest Period", "Realizing", "Exit Period"]'),
    ('LIQUIDATING', 'Liquidating', 4, '["Winding Down", "Dissolving"]'),
    ('CLOSED', 'Closed', 5, '["Fully Realized", "Terminated"]'),
    ('PLANNING', 'Planning', 6, '["Pre-Launch", "In Development"]')
) AS v(code, label, ord, syn)
WHERE rl.list_code = 'FUND_LIFECYCLE'
ON CONFLICT (list_id, value_code) DO UPDATE SET synonyms = EXCLUDED.synonyms;

-- S&P Rating Scale
INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description)
VALUES ('SP_RATING', 'S&P Rating Scale', 'ISSUER', 'Standard and Poors credit rating scale')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
CROSS JOIN LATERAL (VALUES
    ('AAA', 'AAA', 1, '["AAA", "Aaa"]'),
    ('AA_PLUS', 'AA+', 2, '["AA+", "Aa1"]'),
    ('AA', 'AA', 3, '["AA", "Aa2"]'),
    ('AA_MINUS', 'AA-', 4, '["AA-", "Aa3"]'),
    ('A_PLUS', 'A+', 5, '["A+", "A1"]'),
    ('A', 'A', 6, '["A", "A2"]'),
    ('A_MINUS', 'A-', 7, '["A-", "A3"]'),
    ('BBB_PLUS', 'BBB+', 8, '["BBB+", "Baa1"]'),
    ('BBB', 'BBB', 9, '["BBB", "Baa2"]'),
    ('BBB_MINUS', 'BBB-', 10, '["BBB-", "Baa3"]'),
    ('BB_PLUS', 'BB+', 11, '["BB+"]'),
    ('BB', 'BB', 12, '["BB"]'),
    ('B_PLUS', 'B+', 13, '["B+"]'),
    ('B', 'B', 14, '["B"]'),
    ('B_MINUS', 'B-', 15, '["B-"]'),
    ('CCC_PLUS', 'CCC+', 16, '["CCC+"]'),
    ('CCC', 'CCC', 17, '["CCC"]'),
    ('CC', 'CC', 18, '["CC"]'),
    ('C', 'C', 19, '["C"]'),
    ('D', 'D - Default', 20, '["D", "Default", "In Default"]')
) AS v(code, label, ord, syn)
WHERE rl.list_code = 'SP_RATING'
ON CONFLICT (list_id, value_code) DO UPDATE SET synonyms = EXCLUDED.synonyms;

-- Internal Rating
INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description)
VALUES ('INTERNAL_RATING', 'Internal Rating', 'ISSUER', 'Firm internal credit rating scale')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
CROSS JOIN LATERAL (VALUES
    ('IR_1', '1 - Exceptional', 1, '["R1", "Rating 1"]'),
    ('IR_2', '2 - Strong', 2, '["R2", "Rating 2"]'),
    ('IR_3', '3 - Adequate', 3, '["R3", "Rating 3"]'),
    ('IR_4', '4 - Weak', 4, '["R4", "Rating 4"]'),
    ('IR_5', '5 - Speculative', 5, '["R5", "Rating 5"]'),
    ('IR_6', '6 - Distressed', 6, '["R6", "Rating 6"]'),
    ('IR_7', '7 - Default', 7, '["R7", "Rating 7", "Default"]'),
    ('NR', 'NR - Not Rated', 8, '["NR", "Not Rated", "Unrated"]')
) AS v(code, label, ord, syn)
WHERE rl.list_code = 'INTERNAL_RATING'
ON CONFLICT (list_id, value_code) DO UPDATE SET synonyms = EXCLUDED.synonyms;

-- ============================================================
-- 9. Link existing attributes to reference lists
-- ============================================================

UPDATE metadata_register.attribute_register
SET reference_list_code = 'INSTRUMENT_TYPE',
    data_type = 'REFERENCE_LIST'
WHERE attribute_code = 'SECURITY_TYPE'
  AND reference_list_code IS NULL;

UPDATE metadata_register.attribute_register
SET reference_list_code = 'DEAL_STATUS',
    data_type = 'REFERENCE_LIST'
WHERE attribute_code = 'STATUS'
  AND reference_list_code IS NULL;

-- ============================================================
-- 10. Grant permissions
-- ============================================================

GRANT SELECT ON metadata_register.reference_list_summary TO authenticated;
GRANT EXECUTE ON FUNCTION metadata_register.normalize_reference_value TO authenticated;
GRANT EXECUTE ON FUNCTION metadata_register.batch_normalize_values TO authenticated;

NOTIFY pgrst, 'reload schema';
