# Environments, error tracking and request limits

## Staging

Staging is a second copy of the app on its own infrastructure, for trying a change before it reaches master.

| | Production | Staging |
|---|---|---|
| Web worker | `tapestrai-web` | `tapestrai-web-staging` (`apps/web/wrangler.jsonc`, `env.staging`) |
| GraphQL API worker | `tapestrai-api` | `tapestrai-api-staging` (`apps/api/wrangler.toml`, `env.staging`) |
| Database | the production Supabase project | its own Supabase project |
| Deployed by | `.github/workflows/deploy-web-cloudflare.yml`, after CI on master | `.github/workflows/deploy-staging.yml`, after CI on the `staging` branch, or by hand |
| GitHub environment | `production` | `staging` |

### Setting it up, once

1. Create a Supabase project for staging. Apply every migration to it in order (`npx supabase link --project-ref <staging ref>`, then `npx supabase db push`), then the seed if staging should have sample data (`npx supabase db seed`). Enable the access-token hook `tenancy.custom_access_token_hook` under Authentication, Hooks, as on production.
2. In GitHub, Settings, Environments, add `staging` with:
   - secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`;
   - vars `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the staging project's), `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_GRAPHQL_ENDPOINT` (`/api/graphql`).
3. Set the worker secrets for staging. In `apps/web`: `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging`, and the model keys. In `apps/api`: `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`, each with `--env staging`. Add `ERROR_REPORT_DSN` to both if errors should go to a tracker.
4. Push a branch named `staging`, or run "Deploy staging" from the Actions tab.

### A change through staging

Apply the change's migrations to the staging project (docs/MIGRATIONS.md, against the staging ref). Then push the branch to `staging` (`git push origin <branch>:staging --force-with-lease`) and check it there before merging to master.

## Error tracking

`packages/graphql/src/lib/error-report.ts` reports an error in two ways:

- **Always:** one JSON line in the log, kept by Cloudflare Workers Logs (observability is on for both web workers).
- **When `ERROR_REPORT_DSN` is set:** an event to any Sentry-compatible tracker (Sentry, GlitchTip and others). It is sent by plain HTTP, with no SDK, so it works the same on Workers and in Node.

What is reported:

| Where | How |
|---|---|
| GraphQL resolver failures whose text is hidden from the caller | `maskGraphqlError`, under the reference the caller is shown |
| Pages, route handlers and server actions | `apps/web/instrumentation.ts` (`onRequestError`) |
| The browser: uncaught errors and rejected promises, five per page at most | `components/layout/ErrorReporter.tsx`, through `POST /api/client-errors` |
| A page that crashed outright | `app/global-error.tsx` |

Reports name the person by id only, and have tokens, cookies and email addresses cut out. `ERROR_REPORT_ENVIRONMENT` (a worker var: production or staging) and `ERROR_REPORT_RELEASE` (the commit) are attached when set. The background worker (`packages/worker`) still logs on its own and does not report yet.

## Request limits

- **Per query:** depth and aliases, before a query runs (`packages/graphql/src/lib/query-limits.ts`).
- **Per person:** 300 requests a minute, for GraphQL (web and Workers API), the assistant connector and browser error reports (`packages/graphql/src/lib/rate-limit.ts`). The count is kept by the Workers rate-limiting binding `RATE_LIMITER`, so it holds across every copy of a worker. A signed-in caller is counted by their id, anyone else by their address. Over the limit, GraphQL answers 429 with `RATE_LIMITED` and `Retry-After: 60`. Where there is no binding (`next dev`, tests), nothing is limited, and a binding that fails lets the request through.
- To change the limit, edit `simple.limit` in both wrangler files. The period can be 10 or 60 seconds.
