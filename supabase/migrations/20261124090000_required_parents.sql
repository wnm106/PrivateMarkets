-- A record whose entity type requires a parent could be created without one.
--
-- relationship_types.is_required has said since 00032 that a parent is "required for entity
-- creation", but only the web create form read it. The create API, the import framework, the
-- feed loader, the assistant's tool and every seed wrote records without looking. One client
-- has 113 securities and no issuer.
--
-- The rule now has one home in the application (packages/graphql/src/lib/required-parents.ts)
-- that each writer calls before it creates a record, and scripts/guard/required-parents.sql
-- checks a database for records that slipped past it, which is how a seed gets caught.
--
-- What "required" means, written down here because it was nowhere: a record of the type's
-- first entity type (parent_domain_code) must be linked to a record of its second
-- (child_domain_code). Any link to a record of that second type counts, whichever
-- relationship type or direction stored it.
--
-- This migration adds the one thing the rule needed that the catalog could not say.

-- 1. An exemption, as data. A covenant in the library is a definition nobody has attached to
--    a deal yet, so "a Deal Covenant needs a Deal" has to step aside for it. The relationship
--    type names the boolean attribute that lifts the requirement; no code names the type.
ALTER TABLE metadata_register.relationship_types
    ADD COLUMN IF NOT EXISTS required_unless_attribute_code VARCHAR(100);

COMMENT ON COLUMN metadata_register.relationship_types.is_required IS
    'A record of parent_domain_code must be linked to a record of child_domain_code. Any link to a record of that type satisfies it. Enforced by every writer through required-parents.ts.';
COMMENT ON COLUMN metadata_register.relationship_types.required_unless_attribute_code IS
    'A boolean attribute on the parent_domain_code record that lifts is_required when true. For example a library covenant, which has no deal.';

UPDATE metadata_register.relationship_types rt
SET required_unless_attribute_code = 'COVENANT_IS_LIBRARY'
WHERE rt.is_required
  AND rt.parent_domain_code = 'DEAL_COVENANT'
  AND rt.child_domain_code = 'DEAL'
  AND EXISTS (SELECT 1 FROM metadata_register.attribute_register a WHERE a.attribute_code = 'COVENANT_IS_LIBRARY')
  AND rt.required_unless_attribute_code IS DISTINCT FROM 'COVENANT_IS_LIBRARY';

-- 2. Sample securities that earlier migrations created with no issuer.
-- guard: data-migration The data quality and pipeline samples (20261016140000, 20261024001811) made four securities beside their issuers without linking them. They would fail the required-parent check that now guards every database built from these migrations, and an applied migration cannot be edited, so the links are added here.
INSERT INTO entity_instances.entity_relationships (
    parent_entity_id, child_entity_id, relationship_type, relationship_code, is_primary, valid_from, valid_to, metadata)
SELECT s.id, i.id, rt.relationship_name, rt.relationship_code, TRUE, DATE '2020-01-01', DATE '9999-12-31', '{"sampleRepair": "required-parents"}'::jsonb
FROM (VALUES
        ('DQ-SEC-CEDAR', 'DQ-ISS-CEDAR'),
        ('DQ-SEC-HARBOR', 'DQ-ISS-HARBOR'),
        ('DQ-SEC-NORTHWIND', 'DQ-ISS-NORTHWIND'),
        ('PIPE-SEC-NORTHWIND-2L', 'DQ-ISS-NORTHWIND')
     ) AS pair(security_code, issuer_code)
JOIN entity_instances.master_entities s ON s.entity_code = pair.security_code AND s.domain_code = 'SECURITY'
JOIN entity_instances.master_entities i ON i.entity_code = pair.issuer_code AND i.domain_code = 'ISSUER' AND i.client_id IS NOT DISTINCT FROM s.client_id
JOIN metadata_register.relationship_types rt ON rt.relationship_code = 'SECURITY_ISSUER'
WHERE NOT EXISTS (
    SELECT 1
    FROM entity_instances.entity_relationships r
    JOIN entity_instances.master_entities o ON o.id = CASE WHEN r.parent_entity_id = s.id THEN r.child_entity_id ELSE r.parent_entity_id END
    WHERE s.id IN (r.parent_entity_id, r.child_entity_id) AND o.domain_code = 'ISSUER'
);
