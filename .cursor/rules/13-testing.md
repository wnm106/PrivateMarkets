# Testing & Quality Assurance

## Test Strategy Overview

### Unit Tests
- Resolver functions
- Utility functions
- GraphQL helper functions
- Schema validation

### Integration Tests
- API endpoints
- Database queries
- Supabase mutations
- Interactions between packages

### E2E Tests
- Complete user workflows
- Admin panel operations
- Data import flows

## Testing Tools

| Tool | Purpose | Location |
|------|---------|----------|
| Vitest | Unit testing | packages/*/package.json |
| Playwright | E2E testing | apps/web/ |
| Supabase JS | Database testing | packages/*/test/ |

## Running Tests

```bash
# Run all tests
npm run test

# Test specific workspace
npm run test --workspace=@meridian-mdm/graphql

# Test with coverage
npm run test:coverage --workspace=@meridian-mdm/graphql
```

## Test File Organization

```
packages/graphql/
└── src/
    └── __tests__/
        ├── resolvers/
        │   ├── entity.test.ts
        │   ├── dataquality.test.ts
        │   └── intersection.test.ts
        └── schema/
            ├── typeDefs.test.ts
            └── schema.test.ts

apps/api/
└── src/
    └── __tests__/
        └── api.test.ts

apps/web/
└── app/
    └── __tests__/
        └── e2e/
            ├── admin.spec.ts
            ├── entities.spec.ts
            └── api.spec.ts
```

## Common Test Patterns

### Resolver Test
```typescript
import { entityResolvers } from '../entity';

describe('entityResolvers', () => {
  test('entities returns paginated results', async () => {
    const context = createMockContext();
    const result = await entityResolvers.Query.entities(
      {},
      { filter: { domainCode: 'FUND' } },
      context
    );
    
    expect(result.edges).toHaveLength(20);
    expect(result.totalCount).toBe(42);
  });
});
```

### API Test
```typescript
import { fetchGraphQL } from '../test/utils';

describe('API', () => {
  test('GET entities with filter', async () => {
    const query = `
      query GetEntities {
        entities(filter: { domainCode: "FUND" }) {
          edges { node { entityCode entityName } }
        }
      }
    `;

    const { data, errors } = await fetchGraphQL(query);
    expect(errors).toBeUndefined();
    expect(data.entities.edges).toHaveLength(20);
  });
});
```

## Test Data Setup

### Test Database Seeding
```typescript
// packages/database/src/test-setup.ts
export const setupTestDatabase = async () => {
  // Create test domain types
  await supabase.from('domain_types').insert([
    { domain_code: 'FUND', domain_name: 'Fund', is_active: true },
    { domain_code: 'ISSUER', domain_name: 'Issuer', is_active: true },
  ]);
  
  // Create test attribute
  await supabase.from('attribute_register').insert({
    attribute_code: 'name',
    attribute_name: 'Name',
    data_type: 'text',
    is_required: true,
    default_precedence_rank: 1,
  });
};
```

## Best Practices

1. **Never commit failing tests** - this is critical
2. **Keep testing until fixed** - iterate until everything passes
3. **Test locally before pushing**
4. **Fix tests before writing new features**
5. **If something breaks, investigate immediately**
6. **Run full test suite before merging**

### Test Until Fixed - How To

When tests fail, follow this process:

1. **Read the error carefully** - look at line numbers and file names
2. **Reproduce locally** - run the failing test with `npm run test -- --name "test-name"`
3. **Check patterns** - review `patterns-catalog.md` to ensure you're following the right pattern
4. **Check test registry** - review `test-registry.md` for expected test structure
5. **Fix the code** - make minimal changes
6. **Re-run tests** - ensure ALL tests pass, not just the one you clicked
7. **Verify manually** - test the feature in the app
8. **Iterate** - if it still fails, repeat from step 1

**Golden Rule**: If tests fail, do NOT merge. Keep fixing until everything passes. Period.

## CI/CD

### Main Branch Protection
- Require passing tests
- Require 80%+ test coverage
- Require type checking

### Auto-Test on PR
```yaml
# .github/workflows/test.yml
name: Test
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm ci
      - run: npm run test
```