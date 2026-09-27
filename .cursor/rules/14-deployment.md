# Deployment & Release Process

## CI/CD Pipeline

### Build Stages

```
1. Code Push
   │
   ├─▶ 2. Test
   │    ├─ Type check
   │    ├─ Lint
   │    └─ Run tests
   │
   ├─▶ 3. Build
   │    ├─ packages/graphql
   │    ├─ packages/ui
   │    ├─ apps/api
   │    └─ apps/web
   │
   ├─▶ 4. Deploy
   │    ├─ Cloudflare Workers (API)
   │    └─ Vercel (Web)
   │
   └─▶ 5. Monitor
        └─ Health checks & error tracking
```

### Prerequisites for Merge

1. All tests passing
2. Type checking successful
3. Linting passes
4. Coverage maintained or improved
5. Code review approved

## Deployment Commands

### Deploy API to Cloudflare
```bash
cd apps/api
npx wrangler deploy
```

### Deploy Web to Vercel
```bash
cd apps/web
VERCEL_TOKEN=xxx npx vercel --prod
```

## Environment Variables

### API (Cloudflare)
- `SUPABASE_URL` (required)
- `SUPABASE_ANON_KEY` (required)
- `SUPABASE_SERVICE_ROLE_KEY` (required)
- `ENVIRONMENT` (development|production)

### Web (Vercel)
- `NEXT_PUBLIC_API_URL` (required)
- `NEXT_PUBLIC_SENTRY_DSN` (optional)

##versioning Strategy

### Git Flow

```
main       ──●────●────●────●──
             │    │    │    │
            v1.0  v1.1 v1.2 v1.3

develop    ──●────●────●────────
             │    │    │
          feature  bugfix hotfix
```

### Semantic Versioning

```
MAJOR.MINOR.PATCH

- MAJOR: Breaking changes
- MINOR: New features (backward compatible)
- PATCH: Bug fixes (backward compatible)
```

## Rollback Procedure

### API Rollback
```bash
# List deployments
npx wrangler deployments list

# Rollback to previous
npx wrangler deployments rollback <deployment-id>
```

### Web Rollback
```bash
# Vercel CLI
vercel --prod --prod --prod

# Or use Vercel dashboard
```

## Monitoring

### API Monitoring
- Cloudflare Analytics
- Wrangler logs
- Supabase query performance

### Web Monitoring
- Vercel Analytics
- Sentry error tracking
- Lighthouse scores

## Release Checklist

- [ ] All tests passing
- [ ] Type checking successful
- [ ] Linting passes
- [ ] Documentation updated
- [ ] Environment variables synced
- [ ] Rollback plan reviewed
- [ ] Release notes written
- [ ] Notify stakeholders