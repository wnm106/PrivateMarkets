# Resolvers and Business Logic

## Resolver Structure

```
packages/graphql/src/resolvers/
├── index.ts              # Main resolver aggregation
├── entity.ts             # Entity CRUD operations
├── dataquality.ts        # DQ rules and exceptions
├── intersection.ts       # Intersection operations
├── deal.ts               # Deal-specific resolvers
├── fund.ts               # Fund-specific resolvers
├── issuer.ts             # Issuer-specific resolvers
├── price.ts              # Price-specific resolvers
├── security.ts           # Security-specific resolvers
├── position.ts           # Position-specific resolvers
├── lineage.ts            # Lineage and temporal queries
├── metadata.ts           # Metadata and template resolvers
└── source.ts             # Source registry resolvers
```

## Resolver Pattern

```typescript
export const myResolvers = {
  Query: {
    myQuery: async (_, args, context: Context) => {
      const { data, error } = await context.supabase...
      if (error) throw error;
      return data;
    }
  },
  
  Mutation: {
    myMutation: async (_, args, context: Context) => {
      try {
        // Business logic
        return { success: true, data };
      } catch (error: any) {
        return { 
          success: false, 
          errors: [{ field: '', message: error.message, code: 'ERROR_CODE' }] 
        };
      }
    }
  },
  
  Entity: {
    // Entity-level resolvers (e.g., lineage)
    someField: async (parent, _, context) => {
      // Resolve field on Entity type
    }
  }
};
```

## Context Structure

```typescript
interface Context {
  supabase: SupabaseClient;  // Database client
  user?: User;                // Authenticated user
  loaders: DataLoaders;       // DataLoader for batching
}
```

## Key Patterns

### 1. Golden Record Pattern
```typescript
// Get single authoritative value
const { data } = await context.supabase
  .from('entity_attribute_values')
  .select('*')
  .eq('entity_id', entityId)
  .eq('attribute_id', attributeId)
  .order('precedence_rank', { ascending: true })
  .limit(1)
  .single();
```

### 2. Temporal Queries
```typescript
// Get values valid at specific date
const asOf = args.asOfDate || new Date().toISOString().split('T')[0];

const { data } = await context.supabase
  .from('entity_attribute_values')
  .select('*')
  .eq('entity_id', entityId)
  .lte('valid_from', asOf)
  .gte('valid_to', asOf)
  .eq('system_to', '9999-12-31 23:59:59');
```

### 3. Source Tracking
```typescript
// Insert with source and precedence
await context.supabase
  .from('entity_attribute_values')
  .insert({
    entity_id: entityId,
    attribute_id: attributeId,
    source_id: sourceId,
    golden_value: value,
    valid_from: validFrom,
    precedence_rank: precedenceRank,
    created_by: userId
  });
```

## Resolver Registration

### Step 1: Export from domain resolver
```typescript
// packages/graphql/src/resolvers/entity.ts
export const entityResolvers = {
  Query: { ... },
  Mutation: { ... },
  Entity: { ... }
};
```

### Step 2: Aggregate in index.ts
```typescript
// packages/graphql/src/resolvers/index.ts
import { entityResolvers } from './entity';
import { dataQualityResolvers } from './dataquality';

export const resolvers = {
  Query: {
    ...entityResolvers.Query,
    ...dataQualityResolvers.Query,
    // Only expose accepted metadata resolvers
    attributeRegister: metadataResolvers.Query.attributeRegister,
  },
  Mutation: {
    ...entityResolvers.Mutation,
    ...dataQualityResolvers.Mutation,
  },
  Entity: entityResolvers.Entity,
};
```

## State Management

### Golden Record Insert
```typescript
// 1. Get attribute definition
const { data: attr } = await context.supabase
  .from('attribute_register')
  .select('id, default_precedence_rank')
  .eq('attribute_code', attrCode)
  .single();

// 2. Get or create source
const { data: source } = await context.supabase
  .from('source_registry')
  .select('id')
  .eq('source_code', 'MANUAL')
  .single();

// 3. Insert golden value
await context.supabase
  .from('entity_attribute_values')
  .insert({
    entity_id: entity.id,
    attribute_id: attr.id,
    source_id: source?.id,
    golden_value: value,
    golden_value_numeric: numericValue,
    valid_from: validFrom,
    precedence_rank: attr.default_precedence_rank,
  });
```

## Error Handling

### GraphQL Errors
```typescript
return {
  data: null,
  errors: [{ 
    field: 'fieldName', 
    message: 'Error message', 
    code: 'ERROR_CODE' 
  }]
};
```

### Success Pattern
```typescript
return {
  success: true,
  data: result,
  errors: []
};
```