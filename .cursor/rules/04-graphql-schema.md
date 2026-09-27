# GraphQL Schema Design

## Schema Location

```
packages/graphql/
├── schema.graphql           # Master schema (bundled from types/)
├── schema/types/            # Modular schema fragments
│   ├── common.graphql       # Common types (enums, scalars)
│   ├── entity.graphql       # Entity system types
│   ├── dataquality.graphql  # DQ rules and exceptions
│   ├── intersection.graphql # Intersection system types
│   ├── deal.graphql         # Deal-specific types
│   ├── fund.graphql         # Fund-specific types
│   ├── issuer.graphql       # Issuer-specific types
│   ├── price.graphql        # Price-specific types
│   ├── security.graphql     # Security-specific types
│   ├── position.graphql     # Position-specific types
│   └── filters.graphql      # Filter input types
├── src/
│   ├── schema/
│   │   ├── typeDefs.ts      # Auto-generated from schema.graphql
│   │   └── schema.ts        # Schema creation
│   └── resolvers/           # Resolver implementations
```

## Schema Generation

```bash
# Regenerate typeDefs.ts from schema.graphql
cd packages/graphql
node generate-typedefs.js
```

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Types | PascalCase | `Entity`, `Security` |
| Inputs | PascalCase + Input | `CreateEntityInput` |
| Results | PascalCase + Result | `CreateEntityResult` |
| Resolvers | camelCase | `entities`, `createEntity` |
| Enums | UPPERCASE | `DOMAIN_TYPE`, `DQ_SEVERITY` |
| Filters | PascalCase + Filter | `EntityFilter` |

## Common Patterns

### Query Patterns
```graphql
# List with pagination
entities(
  filter: EntityFilter
  pagination: PaginationInput
): EntityConnection!

# Single by ID or code
entity(id: ID, entityCode: String): Entity

# Domain-specific convenience
funds(filter: EntityFilter): EntityConnection!
securities(filter: EntityFilter): EntityConnection!
```

### Mutation Patterns
```graphql
# Create with input object
createEntity(input: CreateEntityInput!): CreateEntityResult!

# Update with input object
updateEntity(input: UpdateEntityInput!): UpdateEntityResult!

# Delete by ID
deleteEntity(id: ID!): DeleteEntityResult!
```

### Connection Pattern (for lists)
```graphql
type EntityConnection {
  edges: [EntityEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type EntityEdge {
  node: Entity!
  cursor: String!
}
```

## Adding New Schema Types

1. **Define in type file**: `packages/graphql/schema/types/[domain].graphql`
2. **Add to schema.graphql**: Include the new type
3. **Regenerate**: `node generate-typedefs.js`
4. **Add resolver**: `packages/graphql/src/resolvers/[domain].ts`
5. **Register**: Add to `packages/graphql/src/resolvers/index.ts`

## Type Relationships

```
Entity (generic)
├── FUND (domain)
├── ISSUER (domain)
├── SECURITY (domain)
├── DEAL (domain)
├── PRICE (domain)
└── POSITION (domain)

Intersection (composite)
├── Member entities from any domain
└── Members with roles and precedence

Relationship
├── parentEntity → childEntity
└── relationshipType (defined in database)
```

## Special Types

### JSONObject
```graphql
scalar JSONObject
```
Used for dynamic attribute storage and complex JSON data.

### Temporal Fields
```graphql
validFrom: Date!
validTo: Date!
systemFrom: DateTime!
systemTo: DateTime!
```
Used for temporal validity tracking.

## Error Handling Types

```graphql
type MutationError {
  field: String
  message: String!
  code: String!
}
```

All mutations return result types with `errors: [MutationError!]!`