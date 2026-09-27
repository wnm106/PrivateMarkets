# Cursor AI Rules Library

This directory contains AI rules and documentation for the Cursor AI assistant to understand and work with the Meridian MDM application.

## Critical: Test-Until-Fixed Policy

### When Cursor AI makes changes:

1. **RUN TESTS FIRST** - Never assume code works
2. **If tests fail:**
   - Read the error message carefully
   - Check `patterns-catalog.md` for the pattern being used
   - Check `test-registry.md` for expected test structure
   - Fix the code
   - **Re-run ALL tests**
   - **Keep testing until ALL tests pass**
3. **Golden Rule: NEVER merge failing tests**

### Test Commands:
```
/cursor run tests                    # Run all tests
/cursor run tests --fail-fast       # Stop at first failure
/cursor run tests --coverage        # See which lines aren't tested
```

## Rules Index

| File | Description |
|------|-------------|
| `00-overview.md` | Project overview, architecture diagram, and quick reference |
| `01-architecture-monorepo.md` | Monorepo structure and Turborepo patterns |
| `02-api-cloudflare-workers.md` | API development on Cloudflare Workers |
| `03-web-nextjs.md` | Next.js web application structure and patterns |
| `04-graphql-schema.md` | GraphQL schema design and conventions |
| `05-resolvers.md` | Resolver patterns and business logic |
| `06-database-schema-core.md` | Core database tables and relationships |
| `07-database-schema-extended.md` | Extended tables and data quality |
| `08-database-queries.md` | Common query patterns and SQL examples |
| `09-generic-entity-model.md` | Generic Entity Model (GEM) architecture |
| `10-golden-record.md` | Golden Record pattern for data consistency |
| `11-data-quality.md` | Data Quality framework and rules |
| `12-intersection-framework.md` | Intersection framework for composite entities |
| `13-testing.md` | Testing strategy and patterns |
| `14-deployment.md` | CI/CD and deployment procedures |
| `15-auto-evolution.md` | Auto-evolving rules and test cases |
| `99-cursor-integration.md` | How to use these rules with Cursor AI |

## How Rules Work

### Context Provision
- Rules are loaded when Cursor AI analyzes the codebase
- Provides context about architecture, patterns, and conventions
- Helps Cursor understand "why" behind code structure

### Code Generation
When you ask Cursor to create code:
1. It references relevant rule files
2. Applies patterns and conventions
3. Generates code matching project standards
4. Ensures consistency with existing code

### Question Answering
When you ask Cursor a question:
1. It searches rules for relevant patterns
2. Provides specific guidance for Meridian MDM
3. References actual file paths and conventions

## Available Domains

### API Layer
- Cloudflare Workers (edge runtime)
- GraphQL Yoga server
- Supabase database client

### Web Layer
- Next.js 16 App Router
- React components
- GraphQL client integration

### Database Layer
- Supabase PostgreSQL
- Entity attributes and relationships
- Temporal data tracking

### Graphql Layer
- Modular schema fragments
- Resolvers pattern
- Golden record and intersection frameworks

## Key Patterns

### Golden Record
Single authoritative value per entity/attribute with multiple source tracking.

### Generic Entity Model
One generic `master_entities` table storing all entity types (FUND, ISSUER, SECURITY, etc.).

### Intersection Framework
Composite entities combining multiple domains with flexible member roles.

### Data Quality
Automated validation through rules with severity levels and exception tracking.

## Testing & Validation

Rules are validated by:
1. Schema consistency checks
2. Resolver coverage metrics
3. Test coverage thresholds
4. Documentation completeness

## Contributing

When adding new files:
1. Number files in logical order (01-09, 11-14)
2. Use descriptive filenames
3. Include executable code examples
4. Reference related rules

## Maintenance

Rules should be updated when:
- Adding new domains or entity types
- Changing database schema
- Modifying GraphQL schema
- Updating testing patterns
- Adding new API endpoints