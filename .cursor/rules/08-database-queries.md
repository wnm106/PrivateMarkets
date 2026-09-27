# Database Query Patterns

## Key Relationships

```
master_entities (1) ── (*) entity_instances
master_entities (1) ── (*) entity_attribute_values
entity_attribute_values (*) ── (1) source_registry
master_entities (*) ── (*) entity_relationships (via parent/child)
master_entities (1) ── (*) intersection_master
intersection_types (1) ── (*) intersection_type_members
intersection_types (1) ── (*) intersection_master
dq_rules (1) ── (*) dq_exceptions
```

## Temporal Patterns

### Valid Time
- `valid_from`: When the value becomes valid
- `valid_to`: When the value stops being valid

### System Time
- `system_from`: When the record was created in system
- `system_to`: When the record was superseded

## Common Query Patterns

### Get Entity by Code
```sql
SELECT * FROM master_entities 
WHERE entity_code = $1 AND is_active = true;
```

### Get Golden Values for Entity (by date)
```sql
SELECT eav.*, a.attribute_code
FROM entity_attribute_values eav
JOIN attribute_register a ON eav.attribute_id = a.id
WHERE eav.entity_id = $1
  AND eav.valid_from <= $2
  AND eav.valid_to >= $2
  AND eav.system_to = '9999-12-31 23:59:59'
ORDER BY eav.precedence_rank;
```

### Get All Source Values for Attribute
```sql
SELECT eav.*, s.source_code
FROM entity_attribute_values eav
JOIN source_registry s ON eav.source_id = s.id
WHERE eav.entity_id = $1
  AND eav.attribute_id = $2
ORDER BY eav.precedence_rank;
```

### Get Entity Relationships
```sql
SELECT 
  er.*,
  parent.entity_code as parent_entity_code,
  child.entity_code as child_entity_code
FROM entity_relationships er
JOIN master_entities parent ON er.parent_entity_id = parent.id
JOIN master_entities child ON er.child_entity_id = child.id
WHERE er.parent_entity_id = $1 OR er.child_entity_id = $1;
```

### Get Intersection Members
```sql
SELECT 
  im.*,
  e.entity_code,
  e.entity_name,
  e.domain_code
FROM intersection_master im
CROSS JOIN LATERAL jsonb_to_recordset(im.members) AS x(
  entity_id UUID, member_role TEXT
)
JOIN master_entities e ON x.entity_id = e.id
WHERE im.intersection_id = $1;
```