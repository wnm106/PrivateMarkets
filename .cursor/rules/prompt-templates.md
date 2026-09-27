# LLM Prompt Templates

## Common Prompts for Cursor

### 1. Adding New Feature
```
I want to add [feature description] to the [API/Web/UI].

Requirements:
- Follow the Generic Entity Model pattern
- Use the Golden Record pattern for data consistency
- Create a resolver in [location]
- Add schema definitions in [location]

Please:
1. Update the GraphQL schema
2. Create the resolver function
3. Add tests following test-registry.md patterns
4. Document any new patterns used
```

### 2. Debugging Issue
```
I'm getting an error when [describe what happened].

Error message: [error text]

Context:
- I was trying to [action]
- The issue is in [file/module]
- I've already tried [tried solutions]

Please:
1. Check the patterns-catalog.md for similar patterns
2. Review 05-resolvers.md for resolver structure
3. Check 06-database-schema-core.md for table structure
4. Suggest specific fixes
```

### 3. Code Review Request
```
Please review this code for [module].

Check:
- Follows Golden Record pattern (10-golden-record.md)
- Uses Generic Entity Model (09-generic-entity-model.md)
- Error handling follows 05-resolvers.md patterns
- Tests follow patterns in test-registry.md
- Schema matches resolver (04-graphql-schema.md)

Specifically check:
- [list items to review]
```

### 4. Performance Optimization
```
The [feature/function] is slow.

Current implementation:
[describe current approach]

 please:
1. Check database query patterns in 08-database-queries.md
2. Review resolvers for N+1 issues
3. Suggest DataLoader usage where needed
4. Propose pagination improvements if needed
```

### 5. Test Generation
```
Generate tests for [feature/module].

Follow test-registry.md patterns:
- Coverage target: [specify percentage]
- Test types needed: [unit/integration/e2e]
- Golden record tests required: [yes/no]
- Temporal tests required: [yes/no]

Please generate:
1. Unit tests
2. Integration tests
3. Any edge cases
4. Golden record verification tests
```

### 6. Schema Change Request
```
I need to update the GraphQL schema.

Changes needed:
- [describe schema changes]

Please:
1. Update schema in packages/graphql/schema/types/
2. Update resolvers if needed
3. Regenerate typeDefs using node generate-typedefs.js
4. Update graphql-reference.md
5. Add migration path if breaking change
```

## Advanced Prompt Patterns

### Pattern Detection
```
Find all usages of the [pattern name] pattern.

Check:
- packages/graphql/src/resolvers/
- apps/web/app/
- supabase/migrations/

Report:
- Files using the pattern
- Any inconsistencies
- Missing pattern implementations
```

### Cross-Reference
```
Verify [module] matches the current schema.

Check:
1. Schema queries match resolvers (04-graphql-schema.md)
2. Database queries match schema (06-database-schema-core.md)
3. Resolvers return correct types

Report any mismatches.
```

## Cursor Commands Reference

```
/cursor rules regenerate          # Regenerate auto rules
/cursor audit patterns            # Check pattern coverage
/cursor generate tests <feature>  # Generate test file
/cursor run tests                 # Run all tests
/cursor run tests --<category>    # Run specific tests
```