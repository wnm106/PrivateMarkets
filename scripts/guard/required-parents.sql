-- Records that exist without a parent their entity type requires.
--
-- The application refuses to create one (packages/graphql/src/lib/required-parents.ts), but
-- a migration or a seed writes rows directly and never passes through it. This is the check
-- for those: npm run guard:db fails when it returns a row.
--
-- The rule, the same one the application applies: a relationship type marked is_required
-- means a record of its parent_domain_code must be linked, today, to a record of its
-- child_domain_code. Any link between the two counts. A type may name a boolean attribute
-- (required_unless_attribute_code) that lifts the requirement when it is true.
SELECT me.domain_code,
       me.entity_code,
       rt.relationship_code,
       rt.child_domain_code AS required_domain_code
FROM metadata_register.relationship_types rt
JOIN entity_instances.master_entities me
  ON me.domain_code = rt.parent_domain_code
 AND me.is_active
WHERE rt.is_required
  AND COALESCE(rt.is_active, TRUE)
  AND rt.child_domain_code IS NOT NULL
  AND rt.child_domain_code <> rt.parent_domain_code
  AND NOT EXISTS (
      SELECT 1
      FROM entity_instances.entity_relationships r
      JOIN entity_instances.master_entities other
        ON other.id = CASE WHEN r.parent_entity_id = me.id THEN r.child_entity_id ELSE r.parent_entity_id END
      WHERE me.id IN (r.parent_entity_id, r.child_entity_id)
        AND other.domain_code = rt.child_domain_code
        AND r.valid_to >= CURRENT_DATE
  )
  AND NOT (
      rt.required_unless_attribute_code IS NOT NULL
      AND EXISTS (
          SELECT 1
          FROM golden_master.entity_attribute_values v
          JOIN metadata_register.attribute_register a ON a.id = v.attribute_id
          WHERE v.entity_id = me.id
            AND a.attribute_code = rt.required_unless_attribute_code
            AND v.system_to > NOW()
            AND v.valid_to >= CURRENT_DATE
            AND (v.golden_value_boolean IS TRUE OR lower(COALESCE(v.golden_value, '')) IN ('true', 't', 'yes', 'y', '1'))
      )
  )
ORDER BY me.domain_code, me.entity_code;
