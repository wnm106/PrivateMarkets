# Auto-Generated Test Registry

## What This Is

A registry of auto-generated test cases that Cursor AI should run against the application when changes are made.

## Generation Source

Tests are generated from:
- `packages/graphql/schema.graphql` - Query/mutation test templates
- `packages/graphql/src/resolvers/` - Resolver-specific tests
- `supabase/migrations/` - Database-level tests

## Test Categories

### 1. Golden Record Tests
Tests for the golden record pattern.

| Test ID | Description | Priority |
|---------|-------------|----------|
| GR-001 | Create golden record for entity attribute | High |
| GR-002 | Query returns golden value over source values | High |
| GR-003 | Multiple source values preserved | Medium |
| GR-004 | Temporal validity with valid_from/valid_to | High |
| GR-005 | Precedence ranking determines golden value | Critical |

### 2. Generic Entity Model Tests
Tests for the GEM pattern.

| Test ID | Description | Priority |
|---------|-------------|----------|
| GEM-001 | Create entity in master_entities | Critical |
| GEM-002 | Entity belongs to correct domain | Critical |
| GEM-003 | Template assignment works | High |
| GEM-004 | Attributes stored in JSON | High |
| GEM-005 | Entity relationships created | Medium |

### 3. Intersection Framework Tests
Tests for composite entities.

| Test ID | Description | Priority |
|---------|-------------|----------|
| INT-001 | Create intersection type with members | Critical |
| INT-002 | Create intersection instance | High |
| INT-003 | Query intersections by entity | High |
| INT-004 | Multiple member roles supported | Medium |
| INT-005 | Intersection attributes stored correctly | Medium |

### 4. Data Quality Tests
Tests for the DQ framework.

| Test ID | Description | Priority |
|---------|-------------|----------|
| DQ-001 | Create DQ rule with expression | High |
| DQ-002 | Rule evaluation on entity creation | Critical |
| DQ-003 | Exception created on rule failure | High |
| DQ-004 | Exception status transitions work | Medium |
| DQ-005 | Rule severity levels work | Low |

### 5. API Tests
Tests for API endpoints.

| Test ID | Description | Priority |
|---------|-------------|----------|
| API-001 | Query entities with pagination | Critical |
| API-002 | Query entities with filters | High |
| API-003 | Create entity mutation | Critical |
| API-004 | Update entity mutation | High |
| API-005 | Delete entity mutation | Medium |
| API-006 | Error responses formatted correctly | High |

### 6. Database Tests
Tests for database operations.

| Test ID | Description | Priority |
|---------|-------------|----------|
| DB-001 | Attribute value insertion | Critical |
| DB-002 | Source tracking works | High |
| DB-003 | Temporal queries return correct values | High |
| DB-004 | Entity relationships queried | Medium |
| DB-005 | Intersection queries work | High |

## Running Tests

### Manual Test Run
```bash
# From root of project
npm run test
npm run test --workspace=@meridian-mdm/graphql
npm run test --workspace=@meridian-mdm/web
```

### Cursor AI Test Execution
```
/cursor run tests
/cursor run tests --category=GoldenRecord
/cursor run tests --category=GEM
/cursor run tests --category=Intersection
/cursor run tests --category=DQ
/cursor run tests --file=packages/graphql/src/__tests__/entity.test.ts
```

### Run Tests for Failing Pattern
```
/cursor run tests --pattern=GoldenRecord
/cursor run tests --pattern=Temporal
/cursor run tests --pattern=Intersection
```

## Test Coverage Targets

| Category | Target Coverage |
|----------|-----------------|
| Golden Record | 100% |
| Generic Entity Model | 80% |
| Intersection Framework | 100% |
| Data Quality | 90% |
| API Endpoints | 80% |
| Database Operations | 80% |

## Automatic Test Generation

### Schema-Based Test Generation
When schema changes:
```
cursor rules generate-tests schema
```

### Resolver-Based Test Generation
When resolvers change:
```
cursor rules generate-tests resolvers
```

## Test Case Templates

### Golden Record Test Template
```typescript
import { describe, test, expect } from 'vitest';

describe('Golden Record - {{feature}}', () => {
  test('{{test_name}}', async () => {
    // Setup
    const context = createMockContext();
    
    // Action
    const result = await {{resolver}}({{args}}, context);
    
    // Assert
    expect(result).{{expectation}};
  });
});
```

### API Test Template
```typescript
import { describe, test, expect } from 'vitest';
import { fetchGraphQL } from '../utils';

describe('API - {{endpoint}}', () => {
  test('{{description}}', async () => {
    const query = `{{query}}`;
    const { data, errors } = await fetchGraphQL(query);
    
    expect(errors).toBeUndefined();
    expect(data).{{expectation}};
  });
});
```