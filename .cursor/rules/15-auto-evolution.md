## Auto-Evolving Rules & Test Cases

## Generation Strategy

Rules evolve automatically based on:
1. Code changes in the repository
2. New schema additions
3. Test failures/successes
4. Code patterns detected

### Critical: Test-Until-Fixed Evolution

The auto-evolution system includes test validation:
- **On schema changes**: Run all related tests
- **On resolver changes**: Run resolver tests
- **On code changes**: Run affected package tests
- **On errors**: Suggest fixes based on patterns

**Golden Rule**: Auto-generated rules should **never** have failing tests. If tests fail, the system should:
1. Identify the issue from test output
2. Suggest fixes based on pattern catalog
3. Keep re-running until tests pass

## Auto-Generated Files

### rules/auto/schema.md
Generated from `packages/graphql/schema.graphql`:

```
# Auto-Generated Schema Rules
Last Updated: {{timestamp}}
Source: packages/graphql/schema.graphql

## Queries Available
- {{each query from schema}}
  - {{query.name}}: Returns {{query.type}}
    - Args: {{each arg}}
      - {{arg.name}}: {{arg.type}}
    {{/each}}
  - Description: {{query.description}}
{{/each}}

## Mutations Available
- {{each mutation from schema}}
  - {{mutation.name}}: {{mutation.type}}
    - Args: {{each arg}}
      - {{arg.name}}: {{arg.type}}
    {{/each}}
{{/each}}
```

### rules/auto/resolvers-coverage.md
Generated from `packages/graphql/src/resolvers/`:

```
# Resolver Coverage Report
Last Updated: {{timestamp}}
Source: packages/graphql/src/resolvers/

## Queries with Resolvers
- {{each resolver}}
  - {{resolver.name}}
    - File: {{resolver.file}}
    - Status: {{resolver.status}}
    - Tests: {{resolver.testCount}}
{{/each}}

## Missing Resolvers
## Fields without resolvers (schema vs implementation gap)
- {{each missing}}
  - {{field.name}} in {{type.name}}
{{/each}}
```

### rules/auto/test-cases.md
Generated from test patterns:

```
# Auto-Generated Test Cases
Last Updated: {{timestamp}}

## Golden Record Pattern Tests
1. Test: Create golden record
   Steps:
   - Insert attribute value with source_id = null
   - Verify precedence_rank = default
   - Expected: Golden value returned

2. Test: Multiple sources resolve correctly
   Steps:
   - Insert 3 values with different precedence
   - Query for entity attribute
   - Expected: Lowest precedence_rank returned

3. Test: Temporal validity
   Steps:
   - Insert value with valid_from = '2024-01-01', valid_to = '2024-12-31'
   - Query with asOfDate = '2024-06-01'
   - Expected: Value returned
   - Query with asOfDate = '2025-01-01'
   - Expected: Value not returned
```

## Evolution Triggers

### Schedule
- Daily: Check for schema changes
- Weekly: Review missing resolvers
- Monthly: Full compliance audit

### Manual
- `cursor rules regenerate` - Manual trigger
- `cursor rules update` - Update from PR

## Code Patterns to Detect

### 1. New Domain Types
```typescript
// Detect pattern:
DomainType.FUND | DomainType.ISSUER | ...
// → Add domain tests
```

### 2. New GraphQL Types
```typescript
// Detect pattern:
export const newResolvers = { Query: { ... } }
// → Add query test cases
```

### 3. Database Patterns
```sql
-- Detect pattern:
FROM entity_attribute_values
ORDER BY precedence_rank
// → Ensure golden record pattern tests
```

## Quality Metrics

### Coverage Scores
- Schema completeness: {{score}}
- Resolver coverage: {{score}}
- Test coverage: {{score}}
- Code quality: {{score}}

### alerts
- ⚠️ Missing resolver: {{count}} fields
- ⚠️ Low test coverage: {{domain}}
- ⚠️ Schema drift detected

## Maintenance

### Weekly Tasks
- Review missing resolvers
- Update test cases
- Check coverage scores

### Monthly Tasks
- Full code review
- Schema validation
- Test suite optimization

## Best Practices

1. Keep rules in sync with schema
2. Add tests for new features
3. Document patterns explicitly
4. Review auto-generated rules
5. Update documentation when patterns change