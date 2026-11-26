# Session rules per client

Set under Admin, Clients, Users & Roles, Authentication, beside the client's sign-in rules. Migration: `supabase/migrations/20261126140000_session_rules.sql`. Tests: `supabase/tests/21_session_rules.sql`.

| Rule | Stored as | Ends a sign-in when |
|---|---|---|
| Time limit | `client_auth_requirements.max_session_minutes` (15 minutes to 30 days) | It started longer ago than the limit |
| Idle limit | `client_auth_requirements.idle_timeout_minutes` (5 minutes to 1 day) | The web app has not seen it for longer than the limit |
| Sign out everywhere | `tenancy.session_revocations` | It started before the person was signed out everywhere |

A person in several clients gets the strictest rule among them when they sign in. Each client's data is read under that client's own rule.

## How it works

- **When a sign-in started** comes from the token: the earliest time in its `amr` claim, which Supabase keeps across refreshes. So the time limit holds on every path: the web app, the Workers API, the Excel add-in and the assistant.
- **Activity.** The web app's middleware calls `tenancy.touch_session()` on each request it allows, written at most once a minute per sign-in. A sign-in the web app never saw, such as the Excel add-in's own, has no idle limit.
- **One check, `tenancy.session_rule_breach`, used in two places:**
  - `tenancy.evaluate_sign_in`, behind the access-token hook and the middleware: no new token at sign-in or refresh, and the middleware signs the browser out (this device only) with the reason.
  - `tenancy.client_session_ok`, behind every read of a client's data: a token that has not expired yet stops working at once.
- **Sign out everywhere.** `tenancy.sign_out_everywhere(user)`: anyone for themselves (profile page), a client's user managers for their members (members tab), staff for anyone. It also deletes the person's rows in `auth.sessions` where the database role may, so stored sessions cannot refresh. Each use is in the audit log.
- Workflow service accounts are not people and keep their sign-in.
- **Cost.** With no rule and no sign-out, the check is two indexed lookups, about 10 microseconds per call.

# Allowed networks per client

Also on the Authentication tab: networks (CIDR, at most 50) a client's people may use the app from. Empty means any address. Migration: `supabase/migrations/20261126150000_ip_allowlist.sql`. Tests: `supabase/tests/22_ip_allowlist.sql`, `packages/graphql/src/lib/client-ip.test.ts`.

- **The check:** `tenancy.ip_refusal(address)` gives the reason, or null. A person in several clients must meet every list among them. Workflow service accounts are exempt.
- **The address** is Cloudflare's `cf-connecting-ip` (`packages/graphql/src/lib/client-ip.ts`). Cloudflare sets it and replaces any value the caller sends. `X-Forwarded-For` is not trusted. Where there is no trusted address (a server not behind Cloudflare, or local development), a client that lists networks refuses the request.
- **Where it is checked:**
  - The web middleware, for every page and web API request of a browser sign-in. It calls `tenancy.check_request`, which also records activity for the idle limit. A refused page signs out that browser and shows the reason on the sign-in page; a refused API call gets 403.
  - The GraphQL request context, shared by the web route (and so the Excel add-in) and the Workers API. Answers are cached for a minute per person and address, so a changed list takes up to a minute to apply.
  - The MCP route, for the assistant connector.
- **Not covered:** a call made straight to the Supabase API with a valid token. The database cannot see the caller's address, because the app's own servers call it too. Closing that needs the address passed to the database in a form it can trust, such as a header signed by the app's servers.
