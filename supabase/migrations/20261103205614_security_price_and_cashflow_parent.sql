-- Price is a child of Security. Cash Flow is already a child of Position
-- (POSITION_CASHFLOW); list it under Position in the directory.

INSERT INTO metadata_register.relationship_types (
    relationship_code, relationship_name, parent_domain_code, child_domain_code,
    description, cardinality, is_required
) VALUES (
    'SECURITY_PRICE', 'Security prices', 'SECURITY', 'PRICE',
    'Price observations of a security', 'ONE_TO_MANY', FALSE
)
ON CONFLICT (relationship_code) DO UPDATE
SET relationship_name = EXCLUDED.relationship_name,
    parent_domain_code = EXCLUDED.parent_domain_code,
    child_domain_code = EXCLUDED.child_domain_code,
    description = EXCLUDED.description,
    cardinality = EXCLUDED.cardinality,
    is_required = EXCLUDED.is_required;

UPDATE metadata_register.domain_types
SET parent_domain_code = 'SECURITY',
    display_order = 25,
    updated_at = NOW()
WHERE domain_code = 'PRICE';

UPDATE metadata_register.domain_types
SET parent_domain_code = 'POSITION',
    display_order = 41,
    updated_at = NOW()
WHERE domain_code = 'CASH_FLOW';
