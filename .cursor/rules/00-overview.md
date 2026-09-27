# Meridian MDM - Overview & Architecture

## Project Summary
Meridian MDM is a comprehensive Master Data Management system for Private Markets, managing entities like Funds, Issuers, Securities, Deals, and Positions with complex relationship hierarchies and temporal data tracking.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Meridian MDM Stack                           │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │   Cursor AI  │  │   Web UI     │  │  MCP Server │               │
│  │   (You)      │  │   Next.js    │  │               │               │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘               │
│         │                  │                                         │
│         └──────────────────┴──────────┐                               │
│                                       │                               │
│  ┌───────────────────────────────────────────────────────────┐      │
│  │              GraphQL Layer (Shared Package)               │      │
│  │  - Schema Definitions (typeDefs.ts)                       │      │
│  │  - Resolvers (entity, dataquality, intersection, etc.)    │      │
│  │  - Context & Utilities                                    │      │
│  └───────────────────────────────────────────────────────────┘      │
│                              │                                       │
│  ┌──────────────┐  ┌────────────────────────────────────────┐       │
│  │   API        │  │         Supabase Database              │       │
│  │   (Cloudflare │  │  - Entity Instances                    │       │
│  │   Workers)   │  │  - Attribute Values                    │       │
│  │              │  │  - Relationship Types                  │       │
│  │              │  │  - Data Quality Rules & Exceptions     │       │
│  │              │  │  - Intersection Instances              │       │
│  └──────────────┘  └────────────────────────────────────────┘       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### 1. Generic Entity Model (GEM)
- **Single source of truth** for all entity types
- Entities belong to domains: FUND, ISSUER, DEAL, SECURITY, PRICE, POSITION
- Uses `master_entities` table for generic storage
- Links to domain-specific templates for attribute validation

### 2. Attribute System
- **Golden Record Pattern**: Single authoritative value per entity/attribute
- **Source Tracking**: Historic values with precedence ranking
- **Temporal Validation**: Valid time ranges for all values
- Multiple competing sources can provide values

### 3. Intersection Framework
- **Composite Entities**: Create new entity types from existing domains
- Example: "COUNTRY_ISSUER" = Country + Issuer relationship
- Defines member roles and required relationships

### 4. Data Quality Framework
- **Rule-based Validation**: Completeness, Validity, Consistency, Timeliness
- **Exception Tracking**: Manual and automated DQ exceptions
- **Severity Management**: Critical, High, Medium, Low

## Directory Structure

| Path | Purpose |
|------|---------|
| `apps/api/` | Cloudflare Workers GraphQL API |
| `apps/web/` | Next.js frontend application |
| `packages/graphql/` | Shared schema and resolvers |
| `packages/ui/` | UI component library |
| `supabase/migrations/` | Database schema migrations |
| `supabase/seed/` | Database seed data |

## Key Files & Directories

```
.cursor/rules/           # This AI rules library
apps/
├── api/                 # API Layer
│   └── src/             # Source code
└── web/                 # Web Application
    ├── app/             # Next.js app router pages
    ├── components/      # React components
    └── lib/             # Utility functions
packages/
├── graphql/             # GraphQL Shared
│   ├── schema/          # Schema definitions
│   └── src/             # Resolvers and context
└── ui/                  # UI Components
```

## Interaction Patterns

### API → Database Flow
1. GraphQL request → API endpoints
2. Resolvers parse inputs
3. Supabase client executes queries
4. Results mapped and returned

### Web → API Flow
1. User action triggers API call
2. `graphqlClient` encapsulates requests
3. GraphQL queries from `lib/graphql.ts`
4. Results processed and stored in state

## Development Commands

```bash
# Start all services
npm run dev

# Run specific service
npm run dev --workspace=@meridian-mdm/api
npm run dev --workspace=@meridian-mdm/web

# Build for production
npm run build --workspace=@meridian-mdm/api
npm run build --workspace=@meridian-mdm/web

# Type checking
npm run typecheck --workspace=@meridian-mdm/graphql

# Linting
npm run lint --workspace=@meridian-mdm/api
```

##疾病 Monitoring & Debugging

- API Logs: ` ~/.wrangler/logs/wrangler-*.log`
- Web Dev Server: Local on http://localhost:3000
- API URL: http://127.0.0.1:4000

---

**Version**: 1.0
**Last Updated**: September 2026
**Maintained By**: Development Team