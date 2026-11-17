-- FX rates and forward curves are market data, not fields on a security.
--
-- A security can still carry FX_RATE_TO_BASE, which is that security's own
-- conversion. A quoted rate for a currency pair is an FX_RATE. A forward
-- curve is the set of forward rates for one currency and index, such as
-- USD SOFR. Each tenor is a FORWARD_RATE under that curve.
--
-- Both types are listed under the Market data header. The forward rate is
-- listed under its curve. Rates are percent points: 4.25 is 4.25 percent.
-- An FX quote is units of the quote currency for one unit of the base.

INSERT INTO metadata_register.domain_groups (group_code, group_name, description, color, display_order)
VALUES ('MARKET_DATA', 'Market data', 'FX rates and forward curves', '#0e7490', 15)
ON CONFLICT (group_code) DO UPDATE
SET group_name = EXCLUDED.group_name,
    description = EXCLUDED.description,
    color = EXCLUDED.color,
    display_order = EXCLUDED.display_order,
    updated_at = NOW();

INSERT INTO metadata_register.domain_types (domain_code, domain_name, description) VALUES
    ('FX_RATE', 'FX Rate', 'A quoted exchange rate for a currency pair'),
    ('FORWARD_CURVE', 'Forward Curve', 'Forward rates for one currency and index'),
    ('FORWARD_RATE', 'Forward Rate', 'One tenor on a forward curve')
ON CONFLICT (domain_code) DO UPDATE
SET domain_name = EXCLUDED.domain_name,
    description = EXCLUDED.description;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    display_order = v.display_order,
    parent_domain_code = NULLIF(v.parent_code, ''),
    is_core = FALSE,
    updated_at = NOW()
FROM (VALUES
    ('FX_RATE', 'MARKET_DATA', 10, ''),
    ('FORWARD_CURVE', 'MARKET_DATA', 20, ''),
    ('FORWARD_RATE', 'MARKET_DATA', 21, 'FORWARD_CURVE')
) AS v(domain_code, group_code, display_order, parent_code)
JOIN metadata_register.domain_groups g ON g.group_code = v.group_code
WHERE dt.domain_code = v.domain_code;

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('CURVE_INDEX', 'Curve Index', 'FORWARD_CURVE', 'The index a forward curve is built from'),
    ('FX_TENOR', 'FX Tenor', 'FX_RATE', 'Spot or the forward tenor of an FX quote')
ON CONFLICT (list_code) DO UPDATE
SET list_name = EXCLUDED.list_name,
    domain_code = EXCLUDED.domain_code,
    description = EXCLUDED.description;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('CURVE_INDEX', 'SOFR', 'SOFR', 1),
    ('CURVE_INDEX', 'TERM_SOFR', 'Term SOFR', 2),
    ('CURVE_INDEX', 'EURIBOR', 'EURIBOR', 3),
    ('CURVE_INDEX', 'SONIA', 'SONIA', 4),
    ('CURVE_INDEX', 'PRIME', 'Prime', 5),
    ('CURVE_INDEX', 'FED_FUNDS', 'Fed funds', 6),
    ('FX_TENOR', 'SPOT', 'Spot', 1),
    ('FX_TENOR', 'ON', 'Overnight', 2),
    ('FX_TENOR', '1W', '1 week', 3),
    ('FX_TENOR', '1M', '1 month', 4),
    ('FX_TENOR', '3M', '3 month', 5),
    ('FX_TENOR', '6M', '6 month', 6),
    ('FX_TENOR', '1Y', '1 year', 7)
) AS v(list_code, code, label, ord) ON v.list_code = rl.list_code
ON CONFLICT (list_id, value_code) DO UPDATE
SET value_label = EXCLUDED.value_label,
    display_order = EXCLUDED.display_order;

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension
)
SELECT v.code, v.name, v.dtype, v.descr, v.dom,
       v.list, FALSE, FALSE, 100,
       'Market data', v.grp, TRUE, TRUE,
       v.tv = 'T', CASE WHEN v.tv = 'T' THEN 'VALID_TIME' ELSE 'NONE' END
FROM (VALUES
    ('FX_BASE_CURRENCY', 'Base Currency', 'STRING', 'ISO currency being priced. One euro in EURUSD.', 'FX_RATE', NULL::text, 1, 'S'),
    ('FX_QUOTE_CURRENCY', 'Quote Currency', 'STRING', 'ISO currency the rate is quoted in. US dollars in EURUSD.', 'FX_RATE', NULL, 2, 'S'),
    ('FX_MARKET_TENOR', 'Tenor', 'STRING', 'Spot, or the forward tenor of the quote.', 'FX_RATE', 'FX_TENOR', 3, 'S'),
    ('FX_MARKET_RATE', 'Rate', 'DECIMAL', 'Units of the quote currency for one unit of the base currency.', 'FX_RATE', NULL, 4, 'T'),
    ('FX_MARKET_DATE', 'Quote Date', 'DATE', 'Date of the quote.', 'FX_RATE', NULL, 5, 'T'),
    ('FX_MARKET_SOURCE', 'Source', 'STRING', 'Where the quote came from.', 'FX_RATE', NULL, 6, 'T'),
    ('CURVE_NAME', 'Curve Name', 'STRING', 'Name of the curve, such as USD SOFR.', 'FORWARD_CURVE', NULL, 1, 'S'),
    ('CURVE_CURRENCY', 'Currency', 'STRING', 'ISO currency of the curve.', 'FORWARD_CURVE', NULL, 2, 'S'),
    ('CURVE_INDEX', 'Index', 'STRING', 'Index the curve is built from.', 'FORWARD_CURVE', 'CURVE_INDEX', 3, 'S'),
    ('CURVE_SOURCE', 'Source', 'STRING', 'Where the curve came from.', 'FORWARD_CURVE', NULL, 4, 'T'),
    ('CURVE_AS_OF_DATE', 'As-of Date', 'DATE', 'Date the curve was observed.', 'FORWARD_CURVE', NULL, 5, 'T'),
    ('FORWARD_TENOR', 'Tenor', 'STRING', 'Tenor of this point, such as 1M, 3M, or 5Y. Unique on one curve.', 'FORWARD_RATE', NULL, 1, 'S'),
    ('FORWARD_RATE_VALUE', 'Forward Rate', 'PERCENTAGE', 'Forward rate in percent points. 4.25 is 4.25 percent.', 'FORWARD_RATE', NULL, 2, 'T'),
    ('FORWARD_START_DATE', 'Start Date', 'DATE', 'First day of the forward period.', 'FORWARD_RATE', NULL, 3, 'T'),
    ('FORWARD_MATURITY_DATE', 'Maturity Date', 'DATE', 'Last day of the forward period.', 'FORWARD_RATE', NULL, 4, 'T')
) AS v(code, name, dtype, descr, dom, list, grp, tv)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    data_type = EXCLUDED.data_type,
    domain_code = EXCLUDED.domain_code,
    reference_list_code = EXCLUDED.reference_list_code,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    is_time_varying = EXCLUDED.is_time_varying,
    time_dimension = EXCLUDED.time_dimension;

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.domain_templates (template_code, template_name, domain_code, description) VALUES
    ('FX_RATE_STANDARD', 'Standard FX Rate', 'FX_RATE', 'A quoted exchange rate'),
    ('FORWARD_CURVE_STANDARD', 'Standard Forward Curve', 'FORWARD_CURVE', 'Forward rates for one currency and index'),
    ('FORWARD_RATE_STANDARD', 'Standard Forward Rate', 'FORWARD_RATE', 'One tenor on a forward curve')
ON CONFLICT (template_code) DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t
  ON t.domain_code = a.domain_code
 AND t.template_code = a.domain_code || '_STANDARD'
WHERE a.attribute_code IN (
    'FX_BASE_CURRENCY', 'FX_QUOTE_CURRENCY', 'FX_MARKET_TENOR', 'FX_MARKET_RATE', 'FX_MARKET_DATE', 'FX_MARKET_SOURCE',
    'CURVE_NAME', 'CURVE_CURRENCY', 'CURVE_INDEX', 'CURVE_SOURCE', 'CURVE_AS_OF_DATE',
    'FORWARD_TENOR', 'FORWARD_RATE_VALUE', 'FORWARD_START_DATE', 'FORWARD_MATURITY_DATE'
)
ON CONFLICT (template_id, attribute_id) DO NOTHING;

INSERT INTO metadata_register.entity_identifier_definitions (
    domain_code, identifier_code, identifier_name, attribute_codes, is_primary, description
) VALUES
    ('FX_RATE', 'FX_PAIR_TENOR_DATE', 'Pair, tenor, and date',
     ARRAY['FX_BASE_CURRENCY', 'FX_QUOTE_CURRENCY', 'FX_MARKET_TENOR', 'FX_MARKET_DATE'], TRUE,
     'One quote for a pair and tenor on a date'),
    ('FORWARD_CURVE', 'CURVE_CURRENCY_INDEX', 'Currency and index',
     ARRAY['CURVE_CURRENCY', 'CURVE_INDEX', 'CURVE_NAME'], TRUE,
     'One curve for a currency, index, and name'),
    ('FORWARD_RATE', 'FORWARD_TENOR', 'Tenor',
     ARRAY['FORWARD_TENOR'], TRUE,
     'One point per tenor on a curve')
ON CONFLICT (domain_code, identifier_code) DO UPDATE
SET identifier_name = EXCLUDED.identifier_name,
    attribute_codes = EXCLUDED.attribute_codes,
    is_primary = EXCLUDED.is_primary,
    description = EXCLUDED.description;

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES (
    'CURVE_FORWARD_RATE', 'Forward rates', 'FORWARD_CURVE', 'FORWARD_RATE',
    'The tenors that make up a forward curve', 'ONE_TO_MANY', FALSE
)
ON CONFLICT (relationship_code) DO UPDATE
SET relationship_name = EXCLUDED.relationship_name,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;
