-- Migration: Add Cash Flow Entity Type
-- Description: Creates the CASH_FLOW domain with composite unique identifier (date + type + currency)
--              and establishes parent-child relationship with POSITION

-- Step 0: Create relationship_types table if it doesn't exist (missing from earlier migrations)
CREATE TABLE IF NOT EXISTS metadata_register.relationship_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    relationship_code VARCHAR(100) UNIQUE NOT NULL,
    relationship_name VARCHAR(200) NOT NULL,
    parent_domain_code VARCHAR(50),
    child_domain_code VARCHAR(50),
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    cardinality TEXT DEFAULT 'ONE_TO_ONE' CHECK (cardinality IN ('ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_ONE', 'COMPOSITE')),
    composite_key TEXT[] DEFAULT '{}',
    is_required BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Step 1: Create CASH_FLOW domain type
INSERT INTO metadata_register.domain_types (domain_code, domain_name, description)
VALUES ('CASH_FLOW', 'Cash Flow', 'Cash flow events associated with positions')
ON CONFLICT (domain_code) DO NOTHING;

-- Step 2: Create cash flow attributes
INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required)
VALUES 
  ('CASHFLOW_DATE', 'Cash Flow Date', 'DATE', 'Date of the cash flow event', TRUE),
  ('CASHFLOW_TYPE', 'Cash Flow Type', 'STRING', 'Type of cash flow (e.g., DIVIDEND, INTEREST, PRINCIPAL, FEE)', TRUE),
  ('CURRENCY', 'Currency', 'STRING', 'ISO 4217 currency code (e.g., USD, EUR, GBP)', TRUE),
  ('AMOUNT', 'Amount', 'NUMBER', 'Cash flow amount in the specified currency', TRUE),
  ('PAYMENT_STATUS', 'Payment Status', 'STRING', 'Status of the payment (e.g., EXPECTED, RECEIVED, PAID)', FALSE)
ON CONFLICT (attribute_code) DO NOTHING;

-- Step 3: Create cash flow template
INSERT INTO metadata_register.domain_templates (template_code, template_name, domain_code, description)
VALUES ('STANDARD_CASHFLOW', 'Standard Cash Flow', 'CASH_FLOW', 'Standard cash flow template with date, type, currency, and amount')
ON CONFLICT (template_code) DO NOTHING;

-- Step 4: Assign attributes to template
INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, display_order)
SELECT 
  (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'STANDARD_CASHFLOW'),
  (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'CASHFLOW_DATE'),
  TRUE, 1
ON CONFLICT DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, display_order)
SELECT 
  (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'STANDARD_CASHFLOW'),
  (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'CASHFLOW_TYPE'),
  TRUE, 2
ON CONFLICT DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, display_order)
SELECT 
  (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'STANDARD_CASHFLOW'),
  (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'CURRENCY'),
  TRUE, 3
ON CONFLICT DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, display_order)
SELECT 
  (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'STANDARD_CASHFLOW'),
  (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'AMOUNT'),
  TRUE, 4
ON CONFLICT DO NOTHING;

INSERT INTO metadata_register.template_attribute_assignments (template_id, attribute_id, is_required, display_order)
SELECT 
  (SELECT id FROM metadata_register.domain_templates WHERE template_code = 'STANDARD_CASHFLOW'),
  (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'PAYMENT_STATUS'),
  FALSE, 5
ON CONFLICT DO NOTHING;

-- Step 5: Create composite identifier (date + type + currency)
INSERT INTO metadata_register.entity_identifier_definitions 
  (domain_code, identifier_code, identifier_name, attribute_codes, is_primary, description)
VALUES 
  ('CASH_FLOW', 'CF_COMPOSITE', 'Date+Type+Currency', 
   ARRAY['CASHFLOW_DATE', 'CASHFLOW_TYPE', 'CURRENCY'], 
   TRUE, 'Composite key: cash flow date, type, and currency unique within a position')
ON CONFLICT (domain_code, identifier_code) DO NOTHING;

-- Step 6: Create relationship type (POSITION -> CASH_FLOW)
INSERT INTO metadata_register.relationship_types 
  (relationship_code, relationship_name, parent_domain_code, child_domain_code, cardinality, description)
VALUES 
  ('POSITION_CASHFLOW', 'Position Cash Flows', 'POSITION', 'CASH_FLOW', 'ONE_TO_MANY', 
   'One position can have multiple cash flows, uniquely identified by date+type+currency')
ON CONFLICT (relationship_code) DO NOTHING;

-- Summary:
-- Domain: CASH_FLOW
-- Template: STANDARD_CASHFLOW
-- Attributes: CASHFLOW_DATE, CASHFLOW_TYPE, CURRENCY, AMOUNT, PAYMENT_STATUS
-- Composite Identifier: CF_COMPOSITE (CASHFLOW_DATE + CASHFLOW_TYPE + CURRENCY)
-- Relationship: POSITION (parent) -> CASH_FLOW (child), ONE_TO_MANY