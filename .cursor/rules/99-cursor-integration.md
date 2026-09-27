# Integration with Cursor AI

## How to Use These Rules

### Cursor AI Integration

1. **Automatic Loading**: Cursor reads `.cursor/rules/*.md` automatically
2. **Context Aware**: Rules provide context for AI understanding
3. **Code Interpretation**: Helps Cursor understand patterns and conventions

### Best Practices for Cursor Usage

#### 1. Ask Questions About Patterns
```
Cursor: "How do I add a new query to the API?"
→ Based on rules: I need to:
   1. Update schema in packages/graphql/schema/types/
   2. Add resolver in packages/graphql/src/resolvers/
   3. Register in packages/graphql/src/resolvers/index.ts
   4. Run node generate-typedefs.js
```

#### 2. Pattern Detection
```
Cursor: "Does this code follow the golden record pattern?"
→ Check: 
   - Uses entity_attribute_values table
   - Queries with ORDER BY precedence_rank
   - Sets source_id = null for golden values
```

#### 3. Reference Documentation
```
Cursor: "What is the intersection framework?"
→ Reference: 12-intersection-framework.md
```


## Cursor Commands

### Rule Regeneration
Cursor can automatically regenerate rules:
```
/cursor rules regenerate
```
This updates:
- Auto-generated schema docs
- Test case templates
- Coverage reports

### Pattern Audit
```
/cursor audit patterns
```
Checks:
- Schema completeness
- Resolver coverage
- Test coverage
- Documentation gaps

### Test Generation
```
/cursor generate tests for <feature>
```
Creates test file with:
- Happy path tests
- Error handling tests
- Edge case tests
- Golden record tests


## Cursor AI Tips

### For Code Generation

1. **Be specific about domain**
   ```
   "Add a new query for funds with filters"
   "Add mutation for creating security with attributes"
   ```

2. **Request to follow patterns**
   ```
   "Implement using the golden record pattern"
   "Follow the resolver template in entity.ts"
   ```

3. **Ask for validation**
   ```
   "Validate this schema against the existing patterns"
   "Check this resolver follows best practices"
   ```

### For Debugging

1. **Reference error context**
   ```
   "Looking at error about intersectionTypes"
   → Check: 04-graphql-schema.md → Intersection queries
   ```

2. **Check database patterns**
   ```
   "Debug query for entity attributes"
   → Check: 08-database-queries.md → Golden Values
   ```

3. **Review resolver structure**
   ```
   "Fix resolver context issue"
   → Check: 05-resolvers.md → Context Structure
   ```


## Additional Resources

- `00-overview.md` - Project overview
- `01-architecture.md` - Architecture details
- `04-graphql-schema.md` - Schema design
- `05-resolvers.md` - Resolver patterns
- `10-golden-record.md` - Golden record examples
- `11-data-quality.md` - DQ framework
- `12-intersection-framework.md` - Composite entities
- `13-testing.md` - Testing strategies