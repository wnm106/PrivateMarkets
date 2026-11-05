-- Deal records sit under the deal. Borrower financials sit under the issuer.
-- A security's principal schedule holds both draws and repayments. An expected
-- draw was our hold of that facility event, so those rows move onto the security
-- and the deal list no longer owns them.

UPDATE metadata_register.domain_types
SET domain_name = 'Principal Schedule',
    description = 'One expected principal movement of a security: a draw that funds it, or a repayment from the first installment through the balloon',
    updated_at = NOW()
WHERE domain_code = 'AMORTIZATION';

UPDATE metadata_register.domain_templates
SET template_name = 'Standard Principal Schedule',
    description = 'One expected draw or repayment',
    updated_at = NOW()
WHERE template_code = 'AMORTIZATION_STANDARD';

UPDATE metadata_register.relationship_types
SET relationship_name = 'Security principal schedule',
    description = 'Draws and repayments of a security through maturity'
WHERE relationship_code = 'SECURITY_AMORTIZATION';

UPDATE metadata_register.attribute_register
SET description = 'Delayed draw, revolver draw, scheduled installment, balloon at maturity, excess-cash-flow sweep, mandatory prepayment, or an expected voluntary prepayment.',
    updated_at = NOW()
WHERE attribute_code = 'AMORT_TYPE';

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, v.syn::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('AMORT_TYPE', 'DELAYED_DRAW', 'Delayed draw', 6, '["DDTL", "Delayed-draw"]'),
    ('AMORT_TYPE', 'REVOLVER_DRAW', 'Revolver draw', 7, '["Revolver", "RCF draw"]')
) AS v(list_code, code, label, ord, syn) ON rl.list_code = v.list_code
WHERE NOT EXISTS (
    SELECT 1 FROM metadata_register.reference_list_values existing
    WHERE existing.list_id = rl.id AND existing.value_code = v.code
);

UPDATE public.record_experiences
SET description = 'Interest contracts, principal schedule, factor schedule, and call schedule for this security.',
    sections = jsonb_set(sections, '{2,title}', '"Principal schedule"')
WHERE experience_code = 'SECURITY_TERMS'
  AND sections->2->>'key' = 'amortization';

UPDATE metadata_register.domain_types AS dt
SET parent_domain_code = v.parent_code,
    display_order = v.display_order,
    updated_at = NOW()
FROM (VALUES
    ('DEAL_TRANCHE', 'DEAL', 11),
    ('DEAL_FUNDING_PLAN', 'DEAL', 12),
    ('DEAL_MEMO_POINT', 'DEAL', 13),
    ('DEAL_CAPITAL_ITEM', 'DEAL', 14),
    ('IC_APPROVAL', 'DEAL', 15),
    ('DEAL_OPEN_ITEM', 'DEAL', 16),
    ('SYNDICATE_SEAT', 'DEAL', 17),
    ('SYNDICATE_ORDER', 'SYNDICATE_SEAT', 18),
    ('CLOSING_CONDITION', 'DEAL', 19),
    ('DEAL_DOCUMENT', 'DEAL', 20),
    ('DEAL_COVENANT', 'DEAL', 21),
    ('REPORTING_OBLIGATION', 'DEAL', 22),
    ('SPONSOR', NULL, 30),
    ('LENDER', NULL, 40)
) AS v(domain_code, parent_code, display_order)
WHERE dt.domain_code = v.domain_code;

UPDATE metadata_register.domain_types AS dt
SET group_id = g.id,
    parent_domain_code = 'ISSUER',
    display_order = v.display_order,
    updated_at = NOW()
FROM (VALUES
    ('FINANCIAL_PERIOD', 11),
    ('STATEMENT_PERIOD', 12)
) AS v(domain_code, display_order)
JOIN metadata_register.domain_groups g ON g.group_code = 'SECURITIES'
WHERE dt.domain_code = v.domain_code;

-- Facility amount of a stored deal draw: tranche size times the percent of
-- the commitment being drawn. Our share was that amount times the hold.
INSERT INTO entity_instances.master_entities (
    entity_code, domain_code, template_id, entity_name, description, client_id, metadata
)
SELECT 'PRIN-' || draw.entity_code,
       'AMORTIZATION',
       tmpl.id,
       COALESCE(NULLIF(purpose.golden_value, ''), draw.entity_name),
       'Facility draw. Our hold is this amount times the tranche hold.',
       draw.client_id,
       '{"fromExpectedDraw":true}'::jsonb
FROM entity_instances.master_entities draw
JOIN metadata_register.domain_templates tmpl ON tmpl.template_code = 'AMORTIZATION_STANDARD'
LEFT JOIN golden_master.entity_attribute_values purpose
  ON purpose.entity_id = draw.id
 AND purpose.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'DRAW_PURPOSE')
 AND purpose.valid_to = DATE '9999-12-31'
WHERE draw.domain_code = 'EXPECTED_DRAW'
  AND draw.is_active
  AND NOT EXISTS (
      SELECT 1 FROM entity_instances.master_entities existing
      WHERE existing.entity_code = 'PRIN-' || draw.entity_code
  );

INSERT INTO golden_master.entity_attribute_values (
    entity_id, attribute_id, source_id, golden_value,
    golden_value_numeric, golden_value_date, valid_from, valid_to, precedence_rank, metadata
)
SELECT sched.id,
       attr.id,
       src.source_id,
       field.val,
       CASE WHEN attr.data_type IN ('NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL')
            AND field.val ~ '^-?[0-9]+(\.[0-9]+)?$' THEN field.val::numeric END,
       CASE WHEN attr.data_type = 'DATE' AND field.val ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN field.val::date END,
       DATE '2020-01-01',
       DATE '9999-12-31',
       100,
       '{"fromExpectedDraw":true}'::jsonb
FROM entity_instances.master_entities draw
JOIN entity_instances.master_entities sched ON sched.entity_code = 'PRIN-' || draw.entity_code
JOIN entity_instances.entity_relationships tranche_rel
  ON tranche_rel.parent_entity_id = draw.id
 AND tranche_rel.relationship_code = 'DRAW_TRANCHE'
 AND tranche_rel.valid_to = DATE '9999-12-31'
JOIN entity_instances.master_entities tranche ON tranche.id = tranche_rel.child_entity_id
LEFT JOIN golden_master.entity_attribute_values size
  ON size.entity_id = tranche.id
 AND size.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_SIZE')
 AND size.valid_to = DATE '9999-12-31'
LEFT JOIN golden_master.entity_attribute_values hold
  ON hold.entity_id = tranche.id
 AND hold.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_HOLD_PCT')
 AND hold.valid_to = DATE '9999-12-31'
LEFT JOIN golden_master.entity_attribute_values unfunded
  ON unfunded.entity_id = tranche.id
 AND unfunded.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'TRANCHE_IS_UNFUNDED')
 AND unfunded.valid_to = DATE '9999-12-31'
LEFT JOIN golden_master.entity_attribute_values share
  ON share.entity_id = draw.id
 AND share.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'DRAW_SHARE_PCT')
 AND share.valid_to = DATE '9999-12-31'
LEFT JOIN golden_master.entity_attribute_values amount
  ON amount.entity_id = draw.id
 AND amount.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'DRAW_AMOUNT')
 AND amount.valid_to = DATE '9999-12-31'
LEFT JOIN golden_master.entity_attribute_values draw_date
  ON draw_date.entity_id = draw.id
 AND draw_date.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'DRAW_DATE')
 AND draw_date.valid_to = DATE '9999-12-31'
LEFT JOIN golden_master.entity_attribute_values draw_status
  ON draw_status.entity_id = draw.id
 AND draw_status.attribute_id = (SELECT id FROM metadata_register.attribute_register WHERE attribute_code = 'DRAW_STATUS')
 AND draw_status.valid_to = DATE '9999-12-31'
JOIN golden_master.entity_attribute_values src ON src.id = COALESCE(amount.id, draw_date.id)
CROSS JOIN LATERAL (VALUES
    ('AMORT_DATE', draw_date.golden_value),
    ('AMORT_TYPE', CASE WHEN unfunded.golden_value_boolean IS TRUE THEN 'DELAYED_DRAW' ELSE 'REVOLVER_DRAW' END),
    ('AMORT_PRINCIPAL_AMOUNT', (
        CASE
            WHEN COALESCE(size.golden_value_numeric, 0) > 0 AND COALESCE(share.golden_value_numeric, 0) > 0
                THEN round(size.golden_value_numeric * share.golden_value_numeric / 100.0, 2)
            WHEN COALESCE(hold.golden_value_numeric, 0) > 0 AND COALESCE(amount.golden_value_numeric, 0) > 0
                THEN round(amount.golden_value_numeric / (hold.golden_value_numeric / 100.0), 2)
            ELSE COALESCE(amount.golden_value_numeric, 0)
        END
    )::text),
    ('AMORT_PERCENT_OF_ORIGINAL', COALESCE(share.golden_value, '0')),
    ('AMORT_STATUS', CASE WHEN draw_status.golden_value = 'ACTUAL' THEN 'PAID' ELSE 'PROJECTED' END)
) AS field(code, val)
JOIN metadata_register.attribute_register attr ON attr.attribute_code = field.code
WHERE draw.domain_code = 'EXPECTED_DRAW'
  AND field.val IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM golden_master.entity_attribute_values existing
      WHERE existing.entity_id = sched.id AND existing.attribute_id = attr.id
  );

INSERT INTO entity_instances.entity_relationships (
    parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from
)
SELECT sec.id, sched.id, rt.relationship_name, 'SECURITY_AMORTIZATION', TRUE, DATE '2020-01-01'
FROM entity_instances.master_entities draw
JOIN entity_instances.master_entities sched ON sched.entity_code = 'PRIN-' || draw.entity_code
JOIN entity_instances.entity_relationships tranche_rel
  ON tranche_rel.parent_entity_id = draw.id
 AND tranche_rel.relationship_code = 'DRAW_TRANCHE'
 AND tranche_rel.valid_to = DATE '9999-12-31'
JOIN entity_instances.entity_relationships security_rel
  ON security_rel.parent_entity_id = tranche_rel.child_entity_id
 AND security_rel.relationship_code = 'TRANCHE_SECURITY'
 AND security_rel.valid_to = DATE '9999-12-31'
JOIN entity_instances.master_entities sec ON sec.id = security_rel.child_entity_id
JOIN metadata_register.relationship_types rt ON rt.relationship_code = 'SECURITY_AMORTIZATION'
WHERE draw.domain_code = 'EXPECTED_DRAW'
ON CONFLICT (parent_entity_id, child_entity_id, relationship_code, valid_from) DO NOTHING;

UPDATE metadata_register.domain_types
SET is_active = FALSE,
    parent_domain_code = NULL,
    updated_at = NOW()
WHERE domain_code = 'EXPECTED_DRAW';
