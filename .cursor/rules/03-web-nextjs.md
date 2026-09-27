# Next.js Web Application

## App Router Structure

```
apps/web/app/
├── [domain]/                 # Dynamic domain pages (funds, securities, etc.)
├── admin/                    # Admin management interfaces
│   ├── entities/[domainCode]/  # Entity management
│   ├── attributes/             # Attribute definitions
│   ├── dq-rules/               # Data quality rules
│   ├── sources/                # Data sources
│   └── templates/              # Entity templates
├── api/                      # API route handlers
│   ├── chat/                 # Chat API
│   └── graphql/              # GraphQL endpoint
├── deals/                    # Deals pages
├── dq-exceptions/            # Data quality exceptions
├── funds/                    # Funds pages
├── investors/                # Investors pages
├── issuers/[id]/             # Issuer detail page
├── lists/                    # List views
├── positions/                # Positions pages
├── precedence/               # Precedence rules
├── prices/                   # Price data
├── quality/                  # Quality metrics
├── resolve/                  # Resolution tools
└── securities/[id]/          # Security detail page
```

## Component Organization

```
apps/web/components/
├── domains/                  # Domain-specific components
├── forms/                    # Form components
├── layout/                   # Layout components
└── wizards/                  # Multi-step wizards
```

## Library Structure

```
apps/web/lib/
├── graphql.ts                # GraphQL clients and queries
├── hooks/                    # Custom React hooks
└── utils.ts                  # Utility functions
```

## Key Files

### graphql.ts
Contains all GraphQL queries and mutations for the app:
```typescript
export const GET_ENTITIES = gql`
  query GetEntities($filter: EntityFilter) {
    entities(filter: $filter) {
      edges {
        node {
          id
          entityCode
          entityName
        }
      }
    }
  }
`;
```

### Layout Components
- `apps/web/components/layout/` - Main layout, Navigation, Footer
- `apps/web/components/toolbars/` - Toolbar components for actions

## Development Patterns

### Creating a New Admin Page

1. Create page at `apps/web/app/admin/[page]/page.tsx`
2. Use `useClient` if interactive
3. Import GraphQL queries from `lib/graphql.ts`
4. Use `graphqlClient` for API calls

### Creating a New Domain Page

1. Create `apps/web/app/[domain]/[id]/page.tsx`
2. Create domain-specific components in `apps/web/components/domains/[domain]/`
3. Follow existing patterns (securities, funds, issuers)

## Data Fetching Patterns

```typescript
// Server-side
const entities = await graphqlClient
  .query(GET_ENTITIES, { filter })
  .toPromise();

// Client-side mutation
await graphqlClient
  .mutation(CREATE_ENTITY, { input })
  .toPromise();
```

## Styling

- CSS Modules in components: `[component].module.css`
- Global styles in `apps/web/styles/`
- Use Tailwind for utility classes

## Environment Variables

Required in `.env.local`:
- `NEXT_PUBLIC_API_URL`: http://127.0.0.1:4000/graphql