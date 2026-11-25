# License switches

A tenant admin can turn one surface, workflow, page or assistant tool group on or off for one client. This is how a license is enforced. Set it up in **Admin → Clients, Users & Roles → License** (`/admin/tenancy`).

A switch sits on top of the client's modules (the curated experience on the Clients tab):

| Switch | Result |
|---|---|
| Follow plan (no switch) | What the modules give. A full-catalog client has everything; a curated client has what its saved modules granted. Assistant tool groups are on. |
| On | Available, even if no saved module holds it |
| Off | Unavailable, even if a module holds it or the client is on the full catalog |

Switching an item off never deletes records. Workflows the client built itself are the client's own work, so switches don't reach them.

## What each kind covers

| Kind | Code | Enforced where |
|---|---|---|
| `surface` | The surface code, as in `/s/<code>` | The sidebar, the home page, and `/s/[surface]`, which shows not found |
| `workflow` | A shared workflow's `workflow_code` | `workflow_list`, `workflow_get` and `workflow_run_start` in the database. Trigger-started runs are covered too, because every run starts there. |
| `tool` | A page href from `apps/web/lib/tool-pages.ts` | The sidebar, the home page, and the middleware, which sends a page's address back to home |
| `assistant_tool` | A tool category (`packages/mcp-server/src/lib/tool-groups.ts`) | `ToolRegistry.executeTool`, so the chat assistant, confirmed writes, the MCP endpoint and workflow agent and tool steps all refuse it. The chat also stops offering it, and `external` also stops loading the client's own MCP servers. |

## The pieces

| Piece | Where |
|---|---|
| Table, functions, readers | `supabase/migrations/20261125100000_client_license_switches.sql` |
| The decision | `tenancy.client_item_enabled(client, kind, code)`: the switch, else `tenancy.client_plan_enabled`. `tenancy.item_enabled(kind, code)` asks it for the clients in the session. |
| Setting a switch | `tenancy.set_client_license_switch` (tenant admins only; a null `enabled` clears it) |
| The admin screen's view | `tenancy.client_license_state`, through the `clientLicense` GraphQL query |
| What the web app reads | `tenancy.module_scope()`, which now carries `blocked`; `apps/web/lib/client-modules.ts` reads it |
| Assistant tool check | `packages/mcp-server/src/lib/tool-license.ts`, called by the registry |
| Admin screen | `apps/web/components/admin/ClientLicense.tsx` |
| Database test | `scripts/db-tests/license-switches.sql`, run by `npm run test:db` |

A new surface, shared workflow, page in `tool-pages.ts` or tool category shows up on the License tab with no change, and follows the plan until someone sets a switch.
