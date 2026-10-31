-- Retire the fixed position framework and the per-domain read projections
-- that the generic entity model replaced.
--
-- Holdings are POSITION rows in entity_instances.master_entities, with
-- attributes on the golden ledger and relationships to fund and security.
-- read_projections.entity_master is the read model for every domain.
-- The generic intersection framework stays. Only the seeded POSITION
-- intersection type is removed, and only when nothing references it.

DROP VIEW IF EXISTS read_projections.position_master;
DROP VIEW IF EXISTS read_projections.fund_master;
DROP VIEW IF EXISTS read_projections.issuer_master;
DROP VIEW IF EXISTS read_projections.security_master;
DROP VIEW IF EXISTS read_projections.deal_master;

DROP FUNCTION IF EXISTS position_master.calculate_position_metrics(UUID, DATE);

DROP TABLE IF EXISTS position_master.position_metrics;
DROP TABLE IF EXISTS position_master.dimensional_intersections;

DROP SCHEMA IF EXISTS position_master;

-- The 00013 seed defined a position as a fixed fund/security/issuer/deal
-- composite. That shape is the entity domain now. Keep the type when an
-- intersection instance still points at it.
DELETE FROM metadata_register.intersection_types t
WHERE t.intersection_code = 'POSITION'
  AND NOT EXISTS (
    SELECT 1
    FROM entity_instances.intersection_instances i
    WHERE i.intersection_type_id = t.id
  );

-- TOTAL_AUM was seeded with a formula against a table and column that
-- position_master never had. Leave the attribute as a stored value.
ALTER TABLE metadata_register.attribute_register
  DISABLE TRIGGER trg_validate_derived_attribute;

UPDATE metadata_register.attribute_register
SET
  is_derived = FALSE,
  derivation_type = NULL,
  derivation_formula = NULL,
  derivation_dependencies = NULL
WHERE attribute_code = 'TOTAL_AUM'
  AND derivation_formula ILIKE '%position_master%';

ALTER TABLE metadata_register.attribute_register
  ENABLE TRIGGER trg_validate_derived_attribute;
