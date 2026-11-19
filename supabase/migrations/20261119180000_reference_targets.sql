-- Reference fields name the entity type they point to.
-- Two REFERENCE attributes were registered without a target, so the app could not
-- offer a picker or show the linked record's name. Neither holds values yet.

UPDATE metadata_register.attribute_register
SET reference_domain_code = 'ISSUER'
WHERE attribute_code = 'ULTIMATE_PARENT_ISSUER_ID'
  AND reference_domain_code IS NULL;

UPDATE metadata_register.attribute_register
SET reference_domain_code = 'CREDIT_FACILITY'
WHERE attribute_code = 'PLEDGED_FACILITY_ID'
  AND reference_domain_code IS NULL
  AND EXISTS (SELECT 1 FROM metadata_register.domain_types WHERE domain_code = 'CREDIT_FACILITY');

COMMENT ON COLUMN metadata_register.attribute_register.reference_domain_code IS
'For REFERENCE attributes: the entity type the value points to. The stored value is that entity''s master id.';
