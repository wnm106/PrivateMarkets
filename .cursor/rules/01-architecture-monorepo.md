# Monorepo Architecture

## Project Structure

```
meridian-mdm/
├── apps/               # Executable applications
│   ├── api/           # Cloudflare Workers (GraphQL API)
│   └── web/           # Next.js Web Application
└── packages/          # Reusable libraries
    ├── graphql/       # Shared GraphQL schema & resolvers
    ├── ui/            # UI component library
    ├── config/        # Shared configurations
    └── database/      # Database utilities
```

## Turborepo Commands

```bash
# Start all services in parallel
npm run dev

# Build specific workspace
npm run build --workspace=@meridian-mdm/api

# Run typecheck on graphql package
npm run typecheck --workspace=@meridian-mdm/graphql

# Run lint
npm run lint --workspace=@meridian-mdm/api

# Clean build cache
npm run clean --workspace=@meridian-mdm/api
```

## Workspace Dependencies

All internal packages use `workspace:*` for versioning:
```json
{
  "dependencies": {
    "@meridian-mdm/graphql": "*",
    "@meridian-mdm/ui": "*"
  }
}
```

## Build Strategy

1. **graphql** - Build first (shared dependency)
2. **ui** - Build second (depends on graphql)
3. **api** - Build third (depends on graphql)
4. **web** - Build last (depends on graphql and ui)

## Development Flow

- Run `npm run dev` to start everything
- API: http://127.0.0.1:4000
- Web: http://localhost:3000 (or 3001 if 3000 in use)