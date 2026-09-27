# Cloudflare Workers API

## Execution Environment

- **Runtime**: Cloudflare Workers (edge runtime)
- **Bundling**: Wrangler bundles code for edge deployment
- **Restricted APIs**: No fs, net, or certain Node APIs
- **Configuration**: `wrangler.toml` in `apps/api/`

## Key Constraints

1. **No File System Access**: All data from Supabase or environment vars
2. **Edge Runtime**: Use `graphql-yoga` for GraphQL server
3. **Bundle Size**: Keep dependencies minimal
4. **Cold Starts**: Optimize for fast initialization

## File Organization

```typescript
apps/api/
├── src/
│   ├── index.ts              # Entry point (imports from @meridian-mdm/graphql)
│   ├── environment.ts        # Environment variable types
│   └── resolvers/            # API-specific resolvers (if any)
├── wrangler.toml             # Cloudflare configuration
└── package.json              # Dependencies
```

## Adding a New Query/Mutation

### Step 1: Update Schema (packages/graphql/)

```typescript
// packages/graphql/schema/types/root.graphql
type Query {
  myNewQuery: MyNewType!
}

// packages/graphql/src/resolvers/index.ts
export const resolvers = {
  Query: {
    myNewQuery: async (_, args, context) => {
      // Query logic
    }
  }
}
```

### Step 2: Regenerate Schema

```bash
cd packages/graphql
node generate-typedefs.js
```

### Step 3: API Imports

The API imports from shared graphql package:
```typescript
import { createSchema, resolvers } from '@meridian-mdm/graphql';
```

## Environment Variables

Required in `.env.local` or Cloudflare dashboard:
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_ANON_KEY`: Supabase anon key
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `ENVIRONMENT`: development/production

## Testing API Endpoints

```bash
# Start API locally
npm run dev --workspace=@meridian-mdm/api

# Query usingcurl
curl -X POST http://127.0.0.1:4000 \
  -H "Content-Type: application/json" \
  -d '{"query": "{ entities { edges { node { id entityCode } } } }"}'
```