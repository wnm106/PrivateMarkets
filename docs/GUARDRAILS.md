# Guardrails

Clients customize the platform with data: entity types, attributes, templates,
compliance rules and their limits, surfaces. The code that runs those must stay
the same for every client. These rules keep it that way, and each one is
checked by a machine, so they hold no matter who or what writes the change.

## The rules

1. **No code names a client, rule or entity by its code.** A database function
   or application module does not compare `client_code`, `rule_code` or
   `entity_code` to a literal, and does not carry a list or map of them.
   Put the difference in data instead:
   - a rule setting in `compliance.rules.metadata` (for example `deal_surface`,
     `group_label`),
   - a fund limit in `compliance.rule_thresholds`,
   - a client flag in `tenancy.clients` (for example `is_internal`),
   - an id passed in by the caller.
2. **One interpreter per concept.** Whether a position counts, which group it
   lands in, which limit applies and which rules a fund is scored on is decided
   in one place:
   - `compliance.evaluate_rule` interprets rules.
   - `compliance.deal_score_plans` decides which rules a deal is scored on and
     for which funds. The pro forma panel, the hypo and capacity all read it.
   - Capacity reads the evaluator (`compliance.deal_capacity_observations`)
     and is solved by `packages/graphql/src/lib/compliance-capacity.ts`, the
     same module `investmentCapacity` uses.
   - `compliance.entity_matches_condition_set` matches a rule's conditions,
     saved or not. The evaluator reaches it through
     `entity_matches_conditions`; the editor's preview through
     `compliance.preview_population`. A result's contributors and their
     amounts come from `compliance.result_contributor_values`.
   - Whether a record may exist without a parent is decided by
     `packages/graphql/src/lib/required-parents.ts`. A relationship type marked
     `is_required` means a record of its first entity type must be linked to a
     record of its second; `required_unless_attribute_code` names a boolean
     attribute that lifts it. The create API, the import framework, the feed
     loader and the assistant's create tool all call it before they write. A
     migration or a seed writes rows directly, so `npm run guard:db` runs
     `scripts/guard/required-parents.sql` and fails on a record with no
     required parent.
   - `golden_master.preference_decision` picks the golden source. The value
     triggers store it; `golden_master.explain_golden_source` explains it.
   - The deal page's capacity tones breach exactly where the evaluator does
     (`apps/web/lib/capacity-view.ts`): past the limit, never at it.
   A new feature that needs any of these calls them. It does not copy them.
3. **Migrations change schema and functions, not records.** Entities,
   attribute values and relationships go in `supabase/seed`. A migration that
   must move data says why with `-- guard: data-migration <reason>`.
4. **An applied migration is never edited.** Add a new one.
5. **Surfaces reach the platform only through `@tapestrai/surface-sdk`.**

## How they are enforced

| Check | What it catches | Where it runs |
|---|---|---|
| `npm run guard` (`scripts/guard/check-static.mjs`) | Rules 1, 3 and 4 on what changed since `master` | Claude Code Stop hook (`.claude/settings.json`), CI `guard` job |
| `npm run lint:surfaces` | Rule 5 | CI `guard` job |
| `npm run db:replay` (`scripts/db-replay`) | A migration that does not apply on a fresh database | CI `database` job |
| `npm run guard:db` (`scripts/guard/check-db.ts`) | Rule 1 in every function in the database, against the real rule, client and entity codes. Also that provisional rows are read only by the functions in `provisional-readers.json`, that a function taking `p_scope` defaults it to null and checks it with `entity_instances.scope_for_caller`, and that every function reading the entity attribute tables directly is listed in `direct-reads.txt` ([PROVISIONAL_RECORDS.md](PROVISIONAL_RECORDS.md)) | CI `database` job |
| `npm run guard` (same script as rules 1, 3 and 4) | A new direct read of `entity_attribute_values`, `entity_relationships` or `master_entities` in application code, a new line in `direct-reads.txt`, or a line there that no longer matches | Claude Code Stop hook, CI `guard` job |
| `npm run test:db` (`scripts/db-tests/capacity-parity.ts`) | Rule 2 for capacity. For every deal, fund and rule, buying exactly the room passes the evaluator and buying a little more breaches it. A parent fund equals the sum of its child funds. The scoring plan's enrollment holds. | CI `database` job |

The Stop hook blocks an agent from finishing while `npm run guard` reports a
problem. If the agent stops again with problems left, they are shown to the
person instead.

## Run them locally

```bash
npm run guard                      # seconds, no database
npm run lint:surfaces

# Needs a superuser on an empty Postgres 16 database with pgvector.
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
npm run db:replay
npm run guard:db
CAPACITY_AS_OF=2026-11-21 npm run test:db
```

## Exceptions

- `scripts/db-replay/legacy.txt` lists older migrations that cannot apply in
  order on a fresh database, and how the replay applies them. Production got
  them in a different order, so they are not edited. The list only shrinks: a
  new migration must apply cleanly and never goes there.
- `scripts/guard/direct-reads.txt` lists the reads of the entity attribute
  tables that do not go through the shared readers yet, so a provisional scope
  cannot see them. Like `legacy.txt`, it only shrinks: move a read onto the
  shared readers and remove its line.
- `scripts/guard/provisional-readers.json` lists the database functions that
  may read provisional rows, each with a reason.
- `scripts/guard/allowlist.json` is for a database function that must name a
  code, each entry with a reason. It is empty. An entry that stops matching
  fails the check, so the list cannot go stale.
