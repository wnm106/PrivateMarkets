# Meridian MDM API Documentation

## GraphQL API

The Meridian MDM GraphQL API provides a flexible interface for querying and managing master data with full bi-temporal support.

## Endpoint

```
Production: https://api.meridian-mdm.com/graphql
Development: http://localhost:4000/graphql
```

## Authentication

All requests require authentication via Bearer token:

```bash
curl -X POST https://api.meridian-mdm.com/graphql \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ funds { id entityName } }"}'
```

## Schema Overview

### Domain Types

```graphql
enum DomainType {
  FUND
  ISSUER
  DEAL
  SECURITY
  PRICE
  POSITION
}
```

### Core Types

#### Fund

```graphql
type Fund {
  id: ID!
  entityCode: String!
  entityName: String!
  description: String
  isActive: Boolean!
  
  # Attributes
  nav: Float
  navCurrency: String
  navDate: Date
  inceptionDate: Date
  fundStatus: String
  fundType: String
  manager: String
  aum: Float
  
  # Metadata
  source: String
  lastUpdated: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
}
```

#### Issuer

```graphql
type Issuer {
  id: ID!
  entityCode: String!
  entityName: String!
  description: String
  isActive: Boolean!
  
  # Attributes
  lei: String
  country: String
  sector: String
  industry: String
  marketCap: Float
  creditRating: String
  
  # Metadata
  createdAt: DateTime!
  updatedAt: DateTime!
}
```

#### Security

```graphql
type Security {
  id: ID!
  entityCode: String!
  entityName: String!
  description: String
  isActive: Boolean!
  
  # Attributes
  isin: String
  cusip: String
  ticker: String
  securityType: String
  currency: String
  exchange: String
  price: Float
  priceDate: Date
  
  # Relationships
  issuer: Issuer
  
  # Metadata
  createdAt: DateTime!
  updatedAt: DateTime!
}
```

#### Deal

```graphql
type Deal {
  id: ID!
  entityCode: String!
  entityName: String!
  description: String
  isActive: Boolean!
  
  # Attributes
  dealDate: Date
  dealType: String
  dealValue: Float
  currency: String
  status: String
  
  # Relationships
  issuer: Issuer
  fund: Fund
  
  # Metadata
  createdAt: DateTime!
  updatedAt: DateTime!
}
```

#### Position

```graphql
type Position {
  id: ID!
  intersectionCode: String!
  positionType: PositionType!
  quantity: Float
  currency: String!
  
  # Relationships
  fund: Fund
  issuer: Issuer
  deal: Deal
  security: Security
  
  # Metrics
  marketValue: Float
  costBasis: Float
  unrealizedGainLoss: Float
  dailyReturn: Float
  ytdReturn: Float
  
  # Temporal
  validFrom: Date!
  validTo: Date!
  createdAt: DateTime!
  updatedAt: DateTime!
}

enum PositionType {
  EQUITY
  DEBT
  FUND_INTEREST
  DERIVATIVE
  OTHER
}
```

### Temporal Types

```graphql
type TemporalValue {
  value: String
  validFrom: Date!
  validTo: Date!
  systemFrom: DateTime!
  systemTo: DateTime!
  source: String!
  isOverride: Boolean!
}

type FieldLineage {
  attributeCode: String!
  attributeName: String!
  currentValue: String
  competingValues: [SourceValue!]!
  resolutionRule: String
}

type SourceValue {
  source: String!
  value: String
  precedenceRank: Int!
  validFrom: Date!
  validTo: Date!
  confidenceScore: Float
}
```

## Queries

### List Funds

```graphql
query ListFunds(
  $filter: FundFilter
  $pagination: PaginationInput
  $asOfDate: Date
) {
  funds(filter: $filter, pagination: $pagination, asOfDate: $asOfDate) {
    edges {
      node {
        id
        entityCode
        entityName
        nav
        navDate
        fundStatus
      }
    }
    pageInfo {
      hasNextPage
      hasPreviousPage
      startCursor
      endCursor
    }
    totalCount
  }
}
```

### Get Fund by ID

```graphql
query GetFund($id: ID!, $asOfDate: Date) {
  fund(id: $id, asOfDate: $asOfDate) {
    id
    entityCode
    entityName
    nav
    navCurrency
    navDate
    inceptionDate
    fundStatus
    fundType
    manager
    aum
    source
    lastUpdated
  }
}
```

### Get Field Lineage

```graphql
query GetFieldLineage($entityId: ID!, $asOfDate: Date) {
  fieldLineage(entityId: $entityId, asOfDate: $asOfDate) {
    attributeCode
    attributeName
    currentValue
    competingValues {
      source
      value
      precedenceRank
      validFrom
      validTo
      confidenceScore
    }
    resolutionRule
  }
}
```

### Get Temporal History

```graphql
query GetTemporalHistory(
  $entityId: ID!
  $attributeCode: String!
  $fromDate: Date!
  $toDate: Date!
) {
  temporalHistory(
    entityId: $entityId
    attributeCode: $attributeCode
    fromDate: $fromDate
    toDate: $toDate
  ) {
    value
    validFrom
    validTo
    systemFrom
    systemTo
    source
    isOverride
  }
}
```

### List DQ Exceptions

```graphql
query ListDQExceptions(
  $filter: DQExceptionFilter
  $pagination: PaginationInput
) {
  dqExceptions(filter: $filter, pagination: $pagination) {
    edges {
      node {
        id
        ruleCode
        ruleName
        entityCode
        entityName
        attributeName
        exceptionMessage
        severity
        status
        detectedAt
        assignedTo
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
    totalCount
  }
}
```

## Mutations

### Create Fund

```graphql
mutation CreateFund($input: CreateFundInput!) {
  createFund(input: $input) {
    fund {
      id
      entityCode
      entityName
    }
    errors {
      field
      message
    }
  }
}

input CreateFundInput {
  entityCode: String!
  entityName: String!
  description: String
  templateId: ID
  attributes: [AttributeInput!]
}

input AttributeInput {
  attributeCode: String!
  value: String
  validFrom: Date
  sourceId: ID
}
```

### Update Fund Attribute

```graphql
mutation UpdateFundAttribute($input: UpdateAttributeInput!) {
  updateAttribute(input: $input) {
    success
    goldenValueId
    errors {
      field
      message
    }
  }
}

input UpdateAttributeInput {
  entityId: ID!
  attributeCode: String!
  value: String!
  validFrom: Date!
  sourceId: ID!
  isOverride: Boolean
  overrideReason: String
}
```

### Split Valid Time

```graphql
mutation SplitValidTime($input: SplitValidTimeInput!) {
  splitValidTime(input: $input) {
    success
    newEavId
    errors {
      field
      message
    }
  }
}

input SplitValidTimeInput {
  eavId: ID!
  splitDate: Date!
  newValue: String!
  sourceId: ID!
  overrideReason: String
}
```

### Submit Manual Override

```graphql
mutation SubmitManualOverride($input: ManualOverrideInput!) {
  submitManualOverride(input: $input) {
    success
    goldenValueId
    errors {
      field
      message
    }
  }
}

input ManualOverrideInput {
  entityId: ID!
  attributeCode: String!
  value: String!
  validFrom: Date!
  overrideReason: String!
}
```

### Resolve DQ Exception

```graphql
mutation ResolveDQException($input: ResolveDQExceptionInput!) {
  resolveDQException(input: $input) {
    success
    errors {
      field
      message
    }
  }
}

input ResolveDQExceptionInput {
  exceptionId: ID!
  status: DQExceptionStatus!
  resolutionNotes: String
}

enum DQExceptionStatus {
  OPEN
  IN_REVIEW
  RESOLVED
  WAIVED
  FALSE_POSITIVE
}
```

## Subscriptions

### Fund Updated

```graphql
subscription OnFundUpdated($fundId: ID) {
  fundUpdated(fundId: $fundId) {
    id
    entityCode
    entityName
    nav
    navDate
    updatedAt
  }
}
```

### DQ Exception Created

```graphql
subscription OnDQExceptionCreated {
  dqExceptionCreated {
    id
    ruleCode
    entityCode
    attributeName
    exceptionMessage
    severity
    detectedAt
  }
}
```

## Filter Types

### FundFilter

```graphql
input FundFilter {
  entityCode: StringFilter
  entityName: StringFilter
  fundStatus: StringFilter
  fundType: StringFilter
  manager: StringFilter
  navRange: FloatRangeFilter
  navDateRange: DateRangeFilter
  isActive: Boolean
}

input StringFilter {
  equals: String
  contains: String
  startsWith: String
  in: [String!]
}

input FloatRangeFilter {
  gte: Float
  lte: Float
  gt: Float
  lt: Float
}

input DateRangeFilter {
  gte: Date
  lte: Date
}
```

## Pagination

```graphql
input PaginationInput {
  first: Int
  after: String
  last: Int
  before: String
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

## Error Handling

All mutations return a result type with errors:

```graphql
type MutationResult {
  success: Boolean!
  errors: [MutationError!]!
}

type MutationError {
  field: String
  message: String!
  code: String!
}
```

Common error codes:
- `VALIDATION_ERROR`: Input validation failed
- `NOT_FOUND`: Entity not found
- `UNAUTHORIZED`: Insufficient permissions
- `CONFLICT`: Concurrent modification detected
- `DQ_VIOLATION`: Data quality rule violation

## Rate Limiting

API requests are rate limited:
- 1000 requests per minute per user
- 10000 requests per hour per user

Rate limit headers:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 995
X-RateLimit-Reset: 1640995200
```

## Examples

### Complete Fund Query with Lineage

```graphql
query CompleteFundQuery {
  fund(id: "fund-123") {
    id
    entityCode
    entityName
    nav
    navDate
    
    # Get lineage for all fields
    lineage {
      attributeCode
      currentValue
      competingValues {
        source
        value
        precedenceRank
      }
    }
  }
}
```

### Temporal Analysis

```graphql
query TemporalAnalysis {
  # Get NAV history for Q1 2024
  temporalHistory(
    entityId: "fund-123"
    attributeCode: "NAV"
    fromDate: "2024-01-01"
    toDate: "2024-03-31"
  ) {
    value
    validFrom
    validTo
    source
  }
  
  # Get current positions
  positions(
    filter: { fundId: { equals: "fund-123" } }
    asOfDate: "2024-03-31"
  ) {
    edges {
      node {
        security {
          entityName
          ticker
        }
        quantity
        marketValue
      }
    }
  }
}
```

### DQ Exception Resolution Workflow

```graphql
# 1. List open exceptions
query ListOpenExceptions {
  dqExceptions(
    filter: { status: { equals: OPEN } }
    pagination: { first: 10 }
  ) {
    edges {
      node {
        id
        ruleName
        entityCode
        exceptionMessage
        severity
      }
    }
  }
}

# 2. Get entity details
query GetEntityDetails($entityId: ID!) {
  fund(id: $entityId) {
    entityCode
    entityName
    nav
    navDate
    lineage {
      attributeCode
      competingValues {
        source
        value
      }
    }
  }
}

# 3. Submit override
mutation SubmitOverride {
  submitManualOverride(
    input: {
      entityId: "fund-123"
      attributeCode: "NAV"
      value: "1005000"
      validFrom: "2024-01-31"
      overrideReason: "Corrected per audit confirmation"
    }
  ) {
    success
    goldenValueId
  }
}

# 4. Resolve exception
mutation ResolveException {
  resolveDQException(
    input: {
      exceptionId: "exc-456"
      status: RESOLVED
      resolutionNotes: "NAV corrected via manual override"
    }
  ) {
    success
  }
}
```

## SDK Usage

### TypeScript Client

```typescript
import { GraphQLClient } from 'graphql-request';

const client = new GraphQLClient('https://api.meridian-mdm.com/graphql', {
  headers: {
    authorization: `Bearer ${token}`
  }
});

// Query funds
const { funds } = await client.request(`
  query {
    funds(filter: { isActive: { equals: true } }) {
      edges {
        node {
          id
          entityCode
          entityName
          nav
        }
      }
    }
  }
`);

// Update attribute
const { updateAttribute } = await client.request(`
  mutation UpdateNav($input: UpdateAttributeInput!) {
    updateAttribute(input: $input) {
      success
      goldenValueId
    }
  }
`, {
  input: {
    entityId: 'fund-123',
    attributeCode: 'NAV',
    value: '1005000',
    validFrom: '2024-01-31',
    sourceId: 'source-manual'
  }
});
```

## Best Practices

1. **Use projections**: Only request fields you need
2. **Paginate large queries**: Use cursor-based pagination
3. **Cache appropriately**: Respect cache headers
4. **Handle errors gracefully**: Check for mutation errors
5. **Use subscriptions wisely**: Only subscribe to needed updates
6. **Batch operations**: Use mutations for multiple updates
7. **Specify temporal context**: Always provide `asOfDate` when relevant

## Support

For API questions or issues:
- GitHub Issues: https://github.com/your-org/meridian-mdm/issues
- Email: api-support@meridian-mdm.com
