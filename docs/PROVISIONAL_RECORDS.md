# Provisional records (design)

Status: step 1 of the [build order](#build-order) is built (`supabase/migrations/20261122180000_provisional_scopes.sql`, applied to the hosted project on 2026-11-22). Nothing writes or reads with a scope yet.

## The problem

A load that is not sure which record a row belongs to stops early. Today:

- A row that matches more than one stored record stops the **whole file**. Nothing is written, the import is `NEEDS_RESOLUTION` (`feed-loader.ts`, `resolutions`), and a workflow waiting on that load can go no further.
- A row that is *nearly* a stored record ("Acme Holdings II LP" against "Acme Holdings 2") matches nothing, because the loader matches only exactly (`entity-match.ts`: code, name, identifier, alias). A new record is created and nobody is asked. The fuzzy matcher (`packages/graphql/src/lib/entity-resolution/match.ts`) only runs later, to find duplicates to merge.

The goal is a run that can go **all the way to the end** even when it meets a mapping question at the start. It does that by making an assumption, recording it, and asking a person to confirm it once, at the end.

## What the design must hold to

1. **Provisional records never appear in default results.** A screen, a report, GraphQL, the Excel add-in, the assistant and every compliance, capacity, reconciliation or data quality reading return what they return today, as though the provisional records did not exist.
2. **Only the run or load that made them sees them,** and only when it names its scope.
3. **A simulation sees the whole app.** Compliance, cash recs, fund recs, data quality and anything else built on the entity attribute model see the assumed records the same way they see live ones. They read them through the same readers, not a copy of the logic.
4. **Workers use only sanctioned access points:** GraphQL, and granted database functions called one at a time. No direct database connection, and no transaction held open across calls.

## The approach in one paragraph

Provisional data stays where staged data already lives: in the load batch tables, which no default read touches. The **shared readers** of the entity attribute model (winning values, links, records) take an optional **scope**. With no scope they behave exactly as they do today. With a scope, they lay that scope's provisional rows over the live data, using the precedence the live data uses. GraphQL passes a scope only on requests a workflow may make for its own run, and SQL interpreters receive the scope from the function that started them. Any read that does not go through a shared reader simply does not see provisional data, so mistakes **hide data instead of leaking it**. How much the app can simulate is then a matter of how many reads go through the shared readers. A guard check makes that number only grow.

Rejected alternatives, and why:

| Alternative | Why not |
|---|---|
| A flag on `master_entities`, or a hidden `PROVISIONAL` source on `entity_attribute_values` | Leaks by default: 97 migration files and 18 TypeScript files read `entity_attribute_values` directly, and each would have to remember to leave it out. Writing the rows live also fires real triggers (`trg_enqueue_calc_from_value`, `trg_enqueue_calc_from_relationship`, `workflow_triggers_wake`): real calculation jobs and real workflow starts on data nobody has confirmed. |
| Separate `provisional` tables read through scoped views | Shows only what is switched to the views. Every other reader would need its own view. |
| Replay the batch and roll back in one transaction | Needs a direct database connection across GraphQL calls, which is not a sanctioned access point. Inside a single SQL function it only covers SQL interpreters, not cash recs or fund recs, which are worked out in TypeScript. |
| A sandbox copy of the client | Full coverage, but copying data, codes that must be unique across clients, and keeping the copy current make it far too heavy for one run. |

## Three outcomes when a row is matched

The loader scores each row it cannot match exactly, using the same match-rule engine the duplicate finder uses (one interpreter: the loader calls `match.ts`, it does not copy it).

| Best score | What happens | Stored where |
|---|---|---|
| Exact match (today's rules), or score ≥ the rule's **auto-match score** | Mapped to that record | Live |
| No candidate scores ≥ the rule's `min_score` | New record | Live |
| More than one exact match, or a best score between `min_score` and the auto-match score | **Provisional**: held with its candidates and scores | Batch, under a scope |

Both scores are data. `metadata_register.match_rules` already has `min_score`. Add `auto_match_score` to it, plus an optional per-client override table, so different clients can use different cutoffs without code naming any client (Guardrails rule 1). With no auto-match score set, nothing is mapped by score alone, so today's behavior stays the default.

**Rule of contact:** a value or link that touches a provisional record is itself provisional. A position row whose fund is certain but whose issuer is uncertain sends the position link, and the values on it, into the scope. The fund's own values in the same row still load live.

## Storage

### Scopes

```sql
entity_instances.provisional_scopes (
  id uuid primary key,
  client_id uuid not null,
  kind text check (kind in ('LOAD_BATCH', 'WORKFLOW_RUN')),
  workflow_run_id uuid,        -- set for WORKFLOW_RUN; the run's batches share its scope
  status text check (status in ('OPEN', 'RESOLVED', 'DISCARDED', 'EXPIRED')),
  expires_at timestamptz,
  created_by uuid, created_at timestamptz, resolved_by uuid, resolved_at timestamptz
)
```

`load_batches` gets a `scope_id`. A file loaded inside a workflow run uses the run's scope, so every step sees what earlier steps assumed. A file staged on its own at `/imports` gets a scope of its own.

### What a scope holds

The batch tables already hold a staged load's records and values. Three changes let them hold assumptions too:

| Table | Change |
|---|---|
| `load_batch_records` | `action` gains `PROVISIONAL`. New columns: `provisional_entity_id` (a uuid given when the row is held, used as the record's id while it is provisional, and kept if the decision is `create`), `candidates` (ids, names, scores, reasons), `assumed_action` (`map` / `create`), `assumed_entity_id`, `decided_action`, `decided_entity_id` |
| `load_batch_values` | None. Values on a provisional record point at its batch record already |
| `load_batch_links` (new) | The links a held row would make: relationship code, parent, child (a live id or a `provisional_entity_id`), valid from and to. Today a batch keeps only link counts |

The batch tables are already read and written only by the service role with an explicit client filter. They have no `authenticated` policy and no GraphQL type. That does not change.

## The scope-aware shared readers

These are the only places provisional data is ever read. Each takes `p_scope uuid DEFAULT NULL`.

| Reader | Today | With a scope |
|---|---|---|
| `golden_master.winning_attribute_values` | The winning value per record and attribute on a date, by precedence | The scope's values join the competition at their own precedence. For an assumed `map`, they compete against the target record's values. For an assumed `create`, they are the record's values |
| Links (new: `entity_instances.links_in_force`) | The `links()` helper in `fund-surface.ts` reads `entity_relationships` as a table | The scope's `load_batch_links` are added, with provisional ids turned into the assumed target where the assumption is `map` |
| Records (new: `entity_instances.records`) | Record lists read `master_entities` as a table | Assumed `create` records are added with their `provisional_entity_id` and marked `provisional: true` |

How the scope gets checked: each reader calls `entity_instances.scope_for_caller(p_scope)`. It returns the scope only if the scope is `OPEN`, belongs to a client the caller may read, and the caller may act for its run or batch. Otherwise it returns null, and the reader returns live data only. A scope id that leaks into the wrong hands shows nothing.

With `p_scope` null, the overlay branch is never planned. The reader runs today's query, at today's cost.

### How a scope reaches a reader

**From GraphQL.** A workflow step that calls GraphQL sends the header `X-Provisional-Scope: <id>`. The GraphQL context reads it into `context.provisionalScope` (and the header goes into `allowedHeaders`). The store helpers that call the shared readers (`valuesFor`, `links`, and their peers) take it from the context and pass it as `p_scope`. Readers still run as the caller's own JWT, so row security applies as usual, and the database decides whether the scope is honored. The app's own pages never send the header.

**Inside SQL.** An interpreter that runs in the database (`compliance.evaluate_rule`, `compliance.deal_capacity_observations`, `compliance.deal_score_plans`, data quality) gets `p_scope` from the function that started it and passes it to every shared reader it calls. A function called through GraphQL or RPC with a scope runs in one transaction, so nothing is held open between calls.

**Never:** no session setting a later call can inherit, no default scope, and no "current run" looked up from somewhere else.

### What a simulation can see

Everything that reads through the shared readers. Today that is about 15 callers of `winning_attribute_values`: `fund-surface.ts`, `allocation-store.ts`, `deal-performance-store.ts`, `tap.ts`, `ic-memo.ts`, `temporal-attributes.ts`, the compliance resolver, and the compliance group and calculation functions. The rest read the tables directly, and inside a scope they show live data only. They never show anything wrong, only less.

**Coverage is a refactor with a finish line:** move each direct read of `entity_attribute_values`, `entity_relationships` and `master_entities` onto a shared reader. That is also Guardrails rule 2 (one interpreter per concept) applied to the golden value. The order follows what runs need first:

1. Compliance and capacity (`evaluate_rule` and its helpers).
2. Cash recs and fund recs (`cash-rec-store.ts`, `fund-rec-store.ts`, `nav-breaks.ts`, and the `fund-surface.ts` helpers they use).
3. The loader's match index, so a second file in the same run matches the first file's assumptions instead of making them again.
4. Everything else, surface by surface.

A step can ask whether what it reads is covered: each step's output records `assumptions: [provisional ids it read]`, collected by the shared readers from the rows they returned from the scope. A step that read no assumption gives a result that does not depend on any.

## Data quality on provisional records

Data quality rules do not read the attribute tables. Each rule is compiled into a function that takes **one record's values as JSON** and a date: `data_quality.apply_compiled_rule(rule_id, values, as_of)`. `public.load_batch_quality` already uses this to check staged values: it overlays them on the record's live values by precedence and checks the result.

Provisional records are checked the same way, with no second interpreter. The values come from `winning_attribute_values` with the scope:

| Assumption | The values the rule sees | Waivers that apply |
|---|---|---|
| `map` to record X | X's live values on the date, with the provisional values competing by precedence | X's waivers in `dq_exceptions` |
| `create` | The provisional values only | None |

The review can check each candidate, not just the assumed one, so a person sees "mapping to X breaks 2 rules, mapping to Y breaks none" before choosing. Nothing is written to `dq_exceptions` for a provisional id, so the data quality page and its counts show only live records. As with staged batches today, calculated attributes are not recalculated for an assumption.

## A run that finishes before anyone answers

1. **Load.** Certain rows go live, as today. Uncertain rows are held in the run's scope, each with an **assumption**: map to the best candidate if one exists, otherwise create. The import is `LOADED_WITH_ASSUMPTIONS`, with a count, instead of `NEEDS_RESOLUTION`.
2. **Later steps run in the scope.** Every GraphQL call and database function a step makes carries the run's scope. Compliance, capacity, recs and reports see live data plus the assumptions. Each output records the assumptions it read and is labelled provisional on its screen.
3. **One review at the end.** A stage screen, `load.resolve` ("Confirm record mappings"), lists every assumption in the scope: the file row, the candidates and their scores, what was assumed, its data quality, and which later results read it. Outcomes: `confirmed`, `abandoned`. A person picks map, create or ignore for each row. Accepting the assumption takes one click.
4. **Before the run goes on.** The engine checks, not the page: every held row has a decision, and each map target is a live record of this client.
5. **Apply.** `public.resolve_provisional_scope(p_scope_id)` turns the decisions into the loader's existing `EntityResolutionDecision[]` and promotes the held rows through the loader (one interpreter for writing). It runs as a batch like any other load, so it can be reverted. `create` keeps the `provisional_entity_id`, `map` writes onto the chosen record by the usual precedence, and `ignore` drops the row. The scope becomes `RESOLVED`.
6. **Results.** If every decision matched its assumption, the run's results stand and lose the provisional label. If any did not, the engine runs again from the first step whose `assumptions` include a changed row. Steps before that are kept.

## Ending a scope without confirming

- **Abandoned** run, or a staged batch **discarded**: the scope becomes `DISCARDED`. Its held rows go with the batch. Nothing live changed.
- **Expiry:** a scope still open after `expires_at` (a client setting, default 30 days) becomes `EXPIRED`, and the readers stop honoring it. The run is marked as needing to start again.
- A held row never becomes live except through `resolve_provisional_scope`.

## Live data that changes while a scope is open

- A **map target is merged or archived** before confirmation: the readers follow `merged_into_id` to the record that survived, and the review asks again.
- **The same record arrives in a later live load:** the next scoped match finds it, and the review offers it as a candidate with score 100.
- Codes stay unique: a `create` decision uses the loader's existing code reservation, so a code taken in the meantime is caught at apply time and handed back to the review.

## Permissions

| Action | Permission |
|---|---|
| Read with a run scope | The caller may act for the run: the client's workflow service account running it, or a person with `workflow.review` on it |
| Read with a batch scope | `entity.read` and access to the batch's import |
| Choose map, create or ignore | `load.promote` (it writes live records), held on the stage when it opens, as `load.quality` does |
| Set the auto-match score | The permission that edits match rules today |

## Making sure nothing leaks

Checked by machine, like the other guardrails:

- `npm run guard:db`: only the shared readers, `scope_for_caller`, `resolve_provisional_scope`, the loader's batch writes and `load_batch_quality` read rows with `action = 'PROVISIONAL'` or from `load_batch_links`. A new function cannot start reading assumptions on its own.
- `npm run guard:db`: every shared reader's `p_scope` defaults to null and is passed through `scope_for_caller` before it is used.
- `npm run guard`: no new direct read of `entity_attribute_values`, `entity_relationships` or `master_entities` outside an allow-list that only shrinks, the same way `scripts/db-replay/legacy.txt` works. Coverage can only grow.
- `npm run guard`: only the GraphQL context reads `X-Provisional-Scope`, and app pages do not send it.
- `npm run test:db`: a parity test loads a file with assumptions into a scope, then checks that every reader with no scope (the entity master view, the grid, GraphQL `entities`, `tap_entity_matches`, compliance, capacity, cash and fund recs) returns exactly what it did before. With the scope, they must see the assumed records. With a scope the caller may not use, they must again return exactly what they did before.

## The review screen

`load.resolve` is a surface with tabs, so per `docs/SURFACE_TABS.md` it publishes every tab to the assistant:

| Tab | Purpose | Data |
|---|---|---|
| Assumptions | What the run assumed for each uncertain row | One line per held record: file row, assumed action and target, best score, data quality result, decision so far |
| Candidates | Why each candidate was offered | Per record, candidates with score, matching clauses, differing identifiers and the data quality result if chosen |
| Depends on it | What would change if an assumption is wrong | Per record, the later steps and results that read it |

`howToRead` explains that a score is the match-rule score, 0 to 100, and that "assumed" is not yet live.

## Build order

1. **Built.** Scopes, the new batch columns, `load_batch_links`, `scope_for_caller`, and the guard checks. Nothing reads with a scope yet.
   - `scripts/db-tests/provisional-scopes.sql` (in `npm run test:db`) checks who `scope_for_caller` hands a scope to, that a closed, expired or unknown scope means live data only, and that only held records carry an assumption.
   - `npm run guard:db` checks `provisional-readers.json`, the `p_scope` rule, and the `db` lines of `direct-reads.txt` (119 functions at the start). `npm run guard` checks the `ts` lines (50 files at the start), and that the list only shrinks.
   - Left for step 5, when the header exists: the check that only the GraphQL context reads `X-Provisional-Scope`.
   - The scope's 30-day expiry is a column default for now. It becomes a client setting with the scheduled expiry job in step 2.
2. Loader: score near-misses with `match.ts`, add the auto-match score, hold uncertain rows in a scope instead of stopping the file. Batch scopes only. `/imports` shows the resolve panel. `resolve_provisional_scope` through the loader's decisions, with revert.
3. `p_scope` on `winning_attribute_values`, plus the new `links_in_force` and `records`. Data quality on assumptions. The parity test.
4. Move compliance and capacity onto the shared readers and thread `p_scope` through them.
5. Workflow run scopes, the `X-Provisional-Scope` header, the `load.resolve` stage, `assumptions` on step outputs, and running again from the first changed step.
6. Move cash recs and fund recs, then the loader's match index, then the rest, surface by surface, shrinking the allow-list.

## Open questions

- Should a run be able to **skip the assumption** for a row, so that its downstream steps leave that row out instead of guessing? It would be safer for compliance numbers, but the results would be less complete.
- Should a confirmation that **matches every assumption** apply without a person when the run's settings say so (for example, every best score ≥ 90)? That would make a run fully automatic for confident clients.
- Should a step refuse to run, instead of running with live data only, when it reads through a reader not yet moved onto the shared readers? Refusing is stricter. Running is more useful while coverage grows.
- How long should the default expiry be, and should an expiring scope notify the run's owner first?
