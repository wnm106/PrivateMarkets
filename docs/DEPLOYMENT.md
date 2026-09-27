# Meridian MDM Deployment Guide

## Overview

Meridian MDM is deployed using:
- **Frontend**: Cloudflare Pages (Next.js)
- **API**: Cloudflare Workers (GraphQL Yoga)
- **Database**: Supabase (PostgreSQL)
- **MCP Server**: Cloudflare Workers

## Prerequisites

- Cloudflare account with Workers and Pages enabled
- Supabase project (production)
- Domain configured in Cloudflare
- CI/CD pipeline (GitHub Actions recommended)

## Environment Setup

### Production Environment Variables

```env
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_PROJECT_ID=your-project-id

# Application
NEXT_PUBLIC_APP_URL=https://meridian-mdm.com
NEXT_PUBLIC_GRAPHQL_ENDPOINT=https://api.meridian-mdm.com/graphql
NODE_ENV=production

# AI Providers
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
GOOGLE_AI_API_KEY=your-google-key

# Cloudflare
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token

# Logging
LOG_LEVEL=info
```

## Database Deployment

### 1. Initialize Supabase Project

```bash
# Link to production project
npx supabase link --project-ref your-project-id

# Verify connection
npx supabase status
```

### 2. Apply Migrations

```bash
# Push all migrations
npx supabase db push

# Verify schemas created
npx supabase db diff
```

### 3. Seed Initial Data

```bash
# Load seed data
npx supabase db seed

# Or run specific seed files
psql $DATABASE_URL -f supabase/seed/001_domain_types.sql
```

### 4. Configure RLS Policies

RLS policies are included in migrations. Verify they're active:

```sql
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE schemaname IN ('metadata_register', 'entity_instances', 'golden_master', 'position_master', 'data_quality');
```

### 5. Create Database Roles

```sql
-- Create application roles
CREATE ROLE app_admin;
CREATE ROLE app_steward;
CREATE ROLE app_ops;
CREATE ROLE app_readonly;

-- Grant permissions
GRANT SELECT ON ALL TABLES IN SCHEMA read_projections TO app_readonly;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA golden_master TO app_steward;
-- ... additional grants
```

## API Deployment (Cloudflare Workers)

### 1. Configure Wrangler

`apps/api/wrangler.toml`:

```toml
name = "meridian-mdm-api"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"

[[routes]]
pattern = "api.meridian-mdm.com/*"
zone_name = "meridian-mdm.com"

[env.production]
[env.production.vars]
SUPABASE_URL = "https://your-project.supabase.co"
ENVIRONMENT = "production"

[env.production.secrets]
SUPABASE_ANON_KEY = "supabase-anon-key"
SUPABASE_SERVICE_ROLE_KEY = "supabase-service-role-key"
```

### 2. Deploy API

```bash
cd apps/api

# Login to Cloudflare
npx wrangler login

# Deploy to production
npm run deploy

# Or deploy specific environment
npx wrangler deploy --env production
```

### 3. Set Secrets

```bash
# Set Supabase keys as secrets
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
```

### 4. Verify Deployment

```bash
# Test GraphQL endpoint
curl -X POST https://api.meridian-mdm.com/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __typename }"}'
```

## Frontend Deployment (Cloudflare Pages)

### 1. Configure Build Settings

In Cloudflare Pages dashboard:

- **Build command**: `npm run build`
- **Build output directory**: `apps/web/.next`
- **Root directory**: `apps/web`
- **Node.js version**: `20`

### 2. Environment Variables

Set in Cloudflare Pages dashboard:

```
NEXT_PUBLIC_APP_URL=https://meridian-mdm.com
NEXT_PUBLIC_GRAPHQL_ENDPOINT=https://api.meridian-mdm.com/graphql
```

### 3. Deploy via Git Integration

1. Connect GitHub repository
2. Configure branch: `main` → production
3. Automatic deploys on push

### 4. Manual Deploy

```bash
cd apps/web

# Build
npm run build

# Deploy to Cloudflare Pages
npx wrangler pages deploy .next --project-name meridian-mdm-web
```

### 5. Configure Custom Domain

In Cloudflare Pages dashboard:
1. Add custom domain: `meridian-mdm.com`
2. Configure DNS records
3. Enable HTTPS

## MCP Server Deployment

### 1. Configure Wrangler

`packages/mcp-server/wrangler.toml`:

```toml
name = "meridian-mdm-mcp"
main = "src/server.ts"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"

[[routes]]
pattern = "mcp.meridian-mdm.com/*"
zone_name = "meridian-mdm.com"
```

### 2. Deploy

```bash
cd packages/mcp-server
npm run deploy
```

## CI/CD Pipeline

### GitHub Actions Workflow

`.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy-api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Deploy API
        run: |
          cd apps/api
          npx wrangler deploy --env production
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  
  deploy-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build
        run: |
          cd apps/web
          npm run build
        env:
          NEXT_PUBLIC_APP_URL: https://meridian-mdm.com
          NEXT_PUBLIC_GRAPHQL_ENDPOINT: https://api.meridian-mdm.com/graphql
      
      - name: Deploy to Cloudflare Pages
        run: |
          cd apps/web
          npx wrangler pages deploy .next --project-name meridian-mdm-web
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  
  deploy-database:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
      
      - name: Link project
        run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_ID }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      
      - name: Push migrations
        run: supabase db push
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
```

## Monitoring

### Cloudflare Analytics

Enable in Cloudflare dashboard:
- **Workers**: Analytics → Metrics
- **Pages**: Analytics → Web Analytics

### Supabase Monitoring

- **Database**: Dashboard → Database → Performance
- **API**: Dashboard → API → Logs

### Application Logging

Configure structured logging:

```typescript
import { createLogger } from '@meridian-mdm/config';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  service: 'meridian-mdm-api'
});

logger.info('Request processed', {
  operation: 'getFund',
  duration: 45,
  userId: 'user-123'
});
```

### Alerting

Set up alerts for:
- API error rate > 1%
- API latency P95 > 500ms
- Database connection failures
- DQ exception spike
- Feed ingestion failures

## Backup and Recovery

### Database Backups

Supabase provides automatic backups:
- **Point-in-time recovery**: Last 7 days
- **Daily backups**: Retained for 30 days

Manual backup:

```bash
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql
```

### Restore

```bash
# Restore from backup
psql $DATABASE_URL < backup_20240101.sql

# Point-in-time recovery via Supabase dashboard
```

## Scaling

### Database

- **Read replicas**: Enable in Supabase dashboard
- **Connection pooling**: Configure via Supabase
- **Vertical scaling**: Upgrade Supabase plan

### API

Cloudflare Workers auto-scale. Monitor:
- CPU time per request
- Memory usage
- Concurrent connections

### Frontend

Cloudflare Pages auto-scales globally via CDN.

## Security

### Network Security

- **HTTPS only**: Enforced via Cloudflare
- **CORS**: Configure allowed origins
- **Rate limiting**: Via Cloudflare WAF

### Application Security

- **Authentication**: Supabase Auth
- **Authorization**: RLS policies
- **Input validation**: GraphQL schema validation
- **SQL injection**: Parameterized queries only

### Secrets Management

- **Cloudflare Secrets**: For API keys
- **Supabase Vault**: For database secrets
- **Environment variables**: For non-sensitive config

## Troubleshooting

### Common Issues

**API returns 500 errors**
- Check Worker logs: `npx wrangler tail`
- Verify Supabase connection
- Check secrets are set

**Database connection failures**
- Verify Supabase project is active
- Check connection string
- Review connection pool limits

**Frontend build failures**
- Check environment variables
- Verify Node.js version
- Review build logs in Cloudflare Pages

**Slow queries**
- Check query plans
- Verify indexes exist
- Consider materialized views

## Support

For deployment issues:
- Cloudflare Docs: https://developers.cloudflare.com
- Supabase Docs: https://supabase.com/docs
- GitHub Issues: https://github.com/your-org/meridian-mdm/issues
