# tapestr.ai MDM

Bi-temporal financial Master Data Management platform for private markets investments.

## Overview

tapestr.ai MDM is a comprehensive master data management system designed for private markets investment firms. It provides:

- **Bi-temporal EAV Architecture**: Track both valid time (when data was true) and system time (when data was known)
- **Multi-source Integration**: Ingest data from Bloomberg, WSO, DealCloud, Allvue, S&P Capital IQ
- **Golden Record Resolution**: Automatic precedence-based resolution of conflicting source values
- **Data Quality Engine**: Rule-based data quality monitoring and exception tracking
- **GraphQL API**: Flexible query interface with temporal query support
- **MCP Integration**: AI-ready interface for LLM integration

## Architecture

```
meridian-mdm/
├── apps/
│   ├── web/              # Next.js 16 frontend with IBM Plex Design System
│   └── api/              # GraphQL Yoga server (Cloudflare Workers)
├── packages/
│   ├── database/         # Supabase migrations, RLS policies, seed data
│   ├── graphql/          # GraphQL schema, resolvers, context
│   ├── mcp-server/       # MCP server for LLM integration
│   ├── ui/               # Shared UI components
│   └── config/           # Shared configurations
├── supabase/
│   ├── migrations/       # SQL migrations
│   ├── seed/            # Seed data
│   └── functions/       # Edge functions
└── docs/                # Architecture documentation
```

### Database Schemas

- **metadata_register**: Domain types, attributes, templates, reference lists
- **entity_instances**: Master entities, source registry, feed lineage
- **golden_master**: Bi-temporal EAV ledger with golden record resolution
- **position_master**: Position-level dimensional data and metrics
- **data_quality**: DQ rules and exception tracking
- **read_projections**: Denormalized views for CQRS pattern

### Domain Types

- **FUND**: Investment fund vehicles
- **ISSUER**: Companies and entities issuing securities
- **DEAL**: Investment transactions and deals
- **SECURITY**: Tradeable financial instruments
- **PRICE**: Pricing data points
- **POSITION**: Portfolio positions and holdings

## Prerequisites

- Node.js 20+ and npm 10+
- Supabase CLI
- Docker (for local Supabase)
- Git

## Getting Started

### 1. Clone and Install

```bash
cd meridian-mdm
npm install
```

### 2. Environment Setup

Copy the example environment file:

```bash
cp .env.example .env
```

Update `.env` with your configuration:

```env
SUPABASE_URL=http://localhost:54321
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
```

### 3. Start Supabase

```bash
# Start local Supabase stack
npx supabase start

# Apply migrations
npm run db:migrate

# Load seed data
npm run db:seed
```

### 4. Start Development Servers

```bash
# Start all services (web, api, etc.)
npm run dev

# Or start individual services
npm run dev --workspace=apps/web
npm run dev --workspace=apps/api
```

The application will be available at:
- Web: http://localhost:3000
- GraphQL API: http://localhost:4000/graphql
- Supabase Studio: http://localhost:54323

## Development

### Database Migrations

Create a new migration:

```bash
npx supabase migration new migration_name
```

Apply migrations:

```bash
npm run db:migrate
```

Reset database:

```bash
npm run db:reset
```

### GraphQL Schema

Generate TypeScript types from GraphQL schema:

```bash
npm run generate:graphql
```

### Testing

```bash
# Run all tests
npm run test

# Run tests with coverage
npm run test -- --coverage
```

### Type Checking

```bash
npm run typecheck
```

### Linting

```bash
npm run lint
```

## Deployment

### Cloudflare Workers

The GraphQL API is deployed to Cloudflare Workers:

```bash
# Deploy API
cd apps/api
npm run deploy
```

### Frontend

Deploy Next.js frontend to Cloudflare Pages:

```bash
cd apps/web
npm run deploy
```

### Supabase

For production Supabase:

```bash
# Link to production project
npx supabase link --project-ref your-project-id

# Push migrations
npx supabase db push
```

## Documentation

- [Architecture Guide](docs/ARCHITECTURE.md) - Detailed architecture documentation
- [API Reference](docs/API.md) - GraphQL API documentation
- [Deployment Guide](docs/DEPLOYMENT.md) - Production deployment instructions
- [Bi-temporal Model](docs/BI_TEMPORAL.md) - Understanding the bi-temporal data model

## Key Features

### Bi-temporal Data Model

Every data point tracks two time dimensions:
- **Valid Time**: When the data was true in reality
- **System Time**: When the data was recorded in the system

This enables:
- Point-in-time queries ("What did we know on Jan 1?")
- Audit trails ("When did we learn about this change?")
- Temporal corrections ("Fix the value as of last month")

### Source Precedence

When multiple sources provide conflicting values, the system resolves them based on:
1. Template-defined precedence rules
2. Source registry precedence rankings
3. Manual overrides with audit trails

### Data Quality

Automated DQ checks for:
- Completeness (required fields)
- Validity (format, range constraints)
- Consistency (cross-field validation)
- Timeliness (freshness requirements)
- Uniqueness (duplicate detection)

## Workspaces

The application provides three persona-based workspaces:

### Steward Workspace
- Data stewardship and governance
- Manual override terminal
- Lineage tracking
- Exception resolution

### Ops Workspace
- Daily operations
- Feed monitoring
- DQ exception queue
- Position management

### Governance Workspace
- Policy management
- Template configuration
- Source registry management
- Audit reporting

## Contributing

1. Create a feature branch
2. Make your changes
3. Run tests and linting
4. Submit a pull request

## License

Private - All rights reserved

## Support

For questions or issues, contact the development team.
