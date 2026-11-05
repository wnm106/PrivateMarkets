-- CASHFLOW_TYPE was free text. The roll-forward buckets are a fixed set of
-- types, so the field takes that list. Stored codes already match these values.
-- Alternate names sit on the value as synonyms.

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('CASHFLOW_TYPE', 'Cash Flow Type', 'CASH_FLOW', 'What a position cash flow is: the type the roll-forward sums into a bucket')
ON CONFLICT (list_code) DO UPDATE
SET list_name = EXCLUDED.list_name,
    domain_code = EXCLUDED.domain_code,
    description = EXCLUDED.description,
    is_active = TRUE;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('PURCHASE', 'Purchase', 1, '["Funding", "Draw"]'),
    ('REPAYMENT', 'Principal repayment', 2, '["Principal", "Principal repayment"]'),
    ('SALE', 'Sale', 3, '["Sale at cost"]'),
    ('INTEREST', 'Interest', 4, '["Cash interest"]'),
    ('FEE', 'Fee', 5, '["Fee income"]'),
    ('PIK', 'PIK', 6, '["PIK interest", "Pay in kind"]'),
    ('AMORTIZATION', 'Amortization', 7, '["Accretion"]'),
    ('REALIZED_GAIN', 'Realized gain', 8, '["Realized"]'),
    ('UNREALIZED', 'Unrealized change', 9, '["Change in unrealized"]'),
    ('DIVIDEND', 'Dividend', 10, '[]')
) AS v(code, label, ord, syn) ON TRUE
WHERE rl.list_code = 'CASHFLOW_TYPE'
ON CONFLICT (list_id, value_code) DO UPDATE
SET value_label = EXCLUDED.value_label,
    display_order = EXCLUDED.display_order,
    synonyms = EXCLUDED.synonyms;

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

UPDATE metadata_register.attribute_register
SET data_type = 'REFERENCE_LIST',
    reference_list_code = 'CASHFLOW_TYPE',
    description = 'Type of cash flow. The list is the roll-forward vocabulary.',
    updated_at = NOW()
WHERE attribute_code = 'CASHFLOW_TYPE';

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

NOTIFY pgrst, 'reload schema';
