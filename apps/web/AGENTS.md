<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Local development

Cloud Agent machines do not provide Docker. `supabase/config.toml` enables `[experimental] stack = true`, so `supabase start` runs the native stack. The environment installs Supabase CLI 3.0.0-next.4 on `/usr/local/bin`.

Boot writes `.env`, `apps/web/.env.local`, and `apps/api/.dev.vars` from `supabase status --env`. The web app is http://127.0.0.1:3000 and the Workers GraphQL API is http://127.0.0.1:4000/graphql. `npm run db:reset` rebuilds the local database from migrations and `supabase/seed`.
