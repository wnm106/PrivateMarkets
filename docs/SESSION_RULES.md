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
