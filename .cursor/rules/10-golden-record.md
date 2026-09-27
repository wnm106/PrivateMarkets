# Golden Record Pattern

## Concept

The **Golden Record** is the single, authoritative value for each entity/attribute combination. Multiple data sources can provide values, but one is designated as the "golden" value.

## Why Golden Records?

- **Data Consistency**: Single source of truth
- **Lineage Tracking**: Know where values come from
- **Conflict Resolution**: precedence_rank determines winner
- **Audit Trail**: All source values are preserved

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Entity ID: abc123, Attribute: "Name"                       │
│                                                              │
│  Source 1 (Vendor): "Acme Corp" (precedence: 10)            │
│  Source 2 (Manual): "Acme Incorporated" (precedence: 1)     │
│  Source 3 (System): "Acme Corp" (precedence: 5)             │
│                                                              │
│  GOLDEN RECORD: "Acme Incorporated" (from Source 2)         │
│  └─ Users always see this value                             │
│  └─ This is the "source of truth"                           │
└──────────────────────────────────────────────────────────────┘
```

## Table Structure

```sql
entity_attribute_values {
  entity_id: UUID,
  attribute_id: UUID,
  source_id: UUID,          -- null if golden
  golden_value: TEXT,
  golden_value_numeric: NUMERIC,
  precedence_rank: INT,     -- Lower = more authoritative
  is_manual_override: BOOLEAN,
  valid_from: DATE,
  valid_to: DATE,
  system_from: TIMESTAMP,
  system_to: TIMESTAMP,
  created_by: TEXT
}
```

## Precedence System

| Precedence Rank | Source Type | Example |
|----------------|-------------|---------|
| 1 | Manual Override | Admin manually set value |
| 2-5 | Internal System | Calculated, aggregated |
| 6-10 | Vendor Data | Third-party data providers |
| 11+ | Raw Source | Original source values |

## Golden Record Creation

### Step 1: Validate the Value
```typescript
// Check if attribute exists
const { data: attr } = await context.supabase
  .from('attribute_register')
  .select('*')
  .eq('attribute_code', attrCode)
  .single();
```

### Step 2: Determine Precedence
```typescript
// Use default precedence from attribute definition
const precedenceRank = attr.default_precedence_rank;
```

### Step 3: Insert Golden Value
```typescript
await context.supabase
  .from('entity_attribute_values')
  .insert({
    entity_id: entityId,
    attribute_id: attr.id,
    source_id: null,  // null for golden record
    golden_value: value,
    golden_value_numeric: numericValue,
    valid_from: validFrom,
    precedence_rank: precedenceRank,
    is_manual_override: isOverride,
  });
```

## Querying Golden Records

### Get Single Golden Value
```typescript
const { data } = await context.supabase
  .from('entity_attribute_values')
  .select('*')
  .eq('entity_id', entityId)
  .eq('attribute_id', attributeId)
  .order('precedence_rank', { ascending: true })
  .limit(1)
  .single();
```

### Get All Golden Values for Entity
```typescript
const { data } = await context.supabase
  .from('entity_attribute_values')
  .select('*, attribute_register(attribute_code)')
  .eq('entity_id', entityId)
  .is('source_id', null)  // Golden records only
  .order('attribute_register.attribute_code');
```

## Source Value Tracking

All values are preserved, not just the golden one:

```sql
-- Get all values for an attribute
SELECT eav.*, s.source_code, a.attribute_code
FROM entity_attribute_values eav
JOIN source_registry s ON eav.source_id = s.id
JOIN attribute_register a ON eav.attribute_id = a.id
WHERE eav.entity_id = 'abc123'
  AND eav.attribute_id = 'name_attr'
ORDER BY eav.precedence_rank;
```

## Best Practices

1. **Always query by precedence_rank ASC** to get golden value
2. **Don't delete old values** - they provide historical context
3. **Use valid_from/valid_to** for temporal queries
4. **Mark manual overrides** with `is_manual_override = true`
5. **Log who created** each golden record (`created_by`)

## Troubleshooting

### Problem: Wrong golden value
- Check `precedence_rank` values (lower wins)
- Verify `valid_from` and `valid_to` dates
- Look for `is_manual_override = true`

### Problem: Multiple golden values
- Verify only one source_id is null
- Check precedence_rank values
- Ensure valid_from/valid_to don't overlap incorrectly