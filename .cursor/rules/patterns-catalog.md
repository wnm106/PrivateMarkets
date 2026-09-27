## Code Patterns Catalog

This catalog documents common patterns you'll encounter in the Meridian MDM codebase. Each pattern includes purpose, location, key signals, and examples.

---

## 1. Golden Record Pattern

**Purpose**: Ensure single authoritative value per entity/attribute while preserving all source values

**Location**: `packages/graphql/src/resolvers/` and database queries in `entity_attribute_values` table

**Key Signals**:
- `entity_attribute_values` table
- `ORDER BY precedence_rank ASC` (lower = more authoritative)
- `source_id = null` for golden values (the authoritative value)
- `valid_from` and `valid_to` date range checks for temporal validity

**Examples**:
```typescript
// Query golden value (highest precedence = lowest rank)
const { data } = await context.supabase
  .from('entity_attribute_values')
  .select('*')
  .eq('entity_id', entityId)
  .eq('attribute_id', attributeId)
  .order('precedence_rank', { ascending: true })
  .limit(1)
  .single();

// Insert golden value
await context.supabase
  .from('entity_attribute_values')
  .insert({
    entity_id: entityId,
    attribute_id: attributeId,
    source_id: null,  // null means golden record
    golden_value: value,
    golden_value_numeric: numericValue,
    valid_from: validFrom,
    precedence_rank: precedenceRank,  // Lower = more authoritative
    is_manual_override: isOverride,
  });
```

**Also See**: `10-golden-record.md`

---

## 2. Generic Entity Model (GEM)

**Purpose**: Single table for all entity types across domains (FUND, ISSUER, SECURITY, DEAL, etc.)

**Location**: `master_entities` table and `entity_master` view in Supabase

**Key Signals**:
- `master_entities` table with `domain_code` column
- `entity_instances` table with template references
- `attributes` JSONB field for domain-specific data
- Domain-specific queries (funds, securities, etc.)

**Examples**:
```typescript
// Create entity in master_entities
const { data } = await context.supabase
  .from('master_entities')
  .insert({
    entity_code: code,
    entity_name: name,
    domain_code: 'FUND',  // Domain enum: FUND, ISSUER, SECURITY, DEAL, PRICE, POSITION
    template_id: templateId,
    attributes: { ...domainSpecificAttributes },
  })
  .select()
  .single();

// Query entities by domain
const { data } = await context.supabase
  .from('entity_master')  // Read projection view
  .select('*')
  .eq('domain_code', 'FUND');
```

**Also See**: `09-generic-entity-model.md`

---

## 3. Intersection Framework

**Purpose**: Create composite entities from multiple domains with flexible member roles

**Location**: `intersection_master`, `intersection_types`, `intersection_type_members` tables

**Key Signals**:
- `members` JSONB field with array of `{ entity_id, member_role }` objects
- `intersection_type_code` linking to type definition
- `member_role` specifying each entity's role in the intersection

**Examples**:
```typescript
// Create intersection type (define structure)
await context.supabase
  .from('intersection_types')
  .insert({
    intersection_code: 'INVESTOR_MANAGER',
    intersection_name: 'Investor-Manager Relationship',
  });

// Define members of intersection type
await context.supabase
  .from('intersection_type_members')
  .insert([
    { intersection_type_id: typeId, domain_code: 'FUND', member_role: 'investor' },
    { intersection_type_id: typeId, domain_code: 'ISSUER', member_role: 'manager' },
  ]);

// Create intersection instance (actual data)
await context.supabase
  .from('intersection_master')
  .insert({
    intersection_code: 'INV-ABC-MGR-XYZ',
    intersection_type_code: 'INVESTOR_MANAGER',
    members: [
      { entity_id: fundId, member_role: 'investor' },
      { entity_id: issuerId, member_role: 'manager' },
    ],
    attributes: { weight: 50, commitment: 1000000 },
  });
```

**Also See**: `12-intersection-framework.md`

---

### 4. Data Quality Framework

**Purpose**: Automated validation with exceptions

**Location**: `dq_rules`, `dq_exceptions` tables

**Key Signals**:
- `rule_expression` with SQL-like syntax
- `severity` levels (CRITICAL, HIGH, MEDIUM, LOW)
- `status` transitions (OPEN → IN_REVIEW → RESOLVED)

**Examples**:
```typescript
const { data } = await context.supabase
  .from('dq_exceptions')
  .select('*, dq_rules(rule_name)')
  .eq('status', 'OPEN')
  .eq('severity', 'CRITICAL');
```

---

### 5. Temporal Queries

**Purpose**: Query values valid at specific points in time

**Location**: Queries with `valid_from`, `valid_to`, `asOfDate`

**Key Signals**:
- `lte('valid_from', asOf)`
- `gte('valid_to', asOf)`
- `asOfDate` parameter in resolvers

**Examples**:
```typescript
const asOf = args.asOfDate || new Date().toISOString().split('T')[0];

const { data } = await context.supabase
  .from('entity_attribute_values')
  .select('*')
  .eq('entity_id', entityId)
  .lte('valid_from', asOf)
  .gte('valid_to', asOf);
```

---

### 6. Pagination Pattern

**Purpose**: Efficient large dataset queries

**Location**: List resolvers

**Key Signals**:
- `first`, `after` pagination arguments
- `range(offset, offset + limit - 1)` in query
- `btoa`/`atob` for cursor encoding

**Examples**:
```typescript
const limit = pagination?.first || 20;
const offset = pagination?.after ? parseInt(atob(pagination.after)) : 0;

const { data, count } = await context.supabase
  .from('master_entities')
  .select('*', { count: 'exact' })
  .range(offset, offset + limit - 1);
```

---

### 7. Error Handling Pattern

**Purpose**: Consistent error responses

**Location**: All resolvers

**Key Signals**:
- Try/catch blocks
- `errors: [MutationError!]!` in return types
- Error codes (CREATE_FAILED, UPDATE_FAILED, etc.)

**Examples**:
```typescript
try {
  // Operation
  return { success: true, data };
} catch (error: any) {
  return {
    success: false,
    errors: [{ field: '', message: error.message, code: 'OPERATION_FAILED' }]
  };
}
```

---

### 8. Context Pattern

**Purpose**: Pass shared dependencies to resolvers

**Location**: All resolvers receive `context` parameter

**Key Signals**:
- `context.supabase` - Database client
- `context.user` - Authenticated user
- `context.loaders` - DataLoader for batching

**Examples**:
```typescript
export const myResolver = {
  Query: {
    myQuery: async (_, args, context: Context) => {
      const { data } = await context.supabase...
      const userId = context.user?.id;
    }
  }
};
```