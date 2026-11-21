# Migrations on the hosted project

On 2026-11-17 the hosted project's migration history was brought into line with `supabase/migrations`. Before that, most migrations had been applied under other version numbers, so `supabase db push` would have tried to replay them.

What was done:

- 80 history records whose version matched no file here were removed from `supabase_migrations.schema_migrations`. They were the same migrations applied under other versions, or in pieces. Each is kept, with the SQL it ran, in `supabase/remote-history/schema_migrations_removed_2026-11-17.json`. Removing a history record changes nothing in the schema.
- 105 files here were recorded as applied: 44 matched a removed record by name; 51 were checked by looking for every table, function, view, column, and index they create; 10 that only add data were checked by the codes they insert.
- Two pairs of files shared a version number. The second of each was renamed so every version is unique: `000611_entity_resolution_and_merge.sql` and `20261103153001_statement_line_attributes.sql`. Both were already applied.

`npx supabase db push --dry-run` now lists only what has not been applied.

## Still pending

`db push` would apply these 16. Look at each before pushing.

**Not applied.** What they create is missing on the hosted project:

| Migration | Missing |
|---|---|
| `00062_dq_set_based_evaluation` | 9 of its 10 data quality functions |
| `20261023140000_chat_skill_state` | `chat_conversations.skill_state` |
| `20261103090000_condition_expressions` | `compliance.rule_conditions.left_expression` and two compliance functions |
| `20261105160000_role_entity_security` | 6 of 10 tenancy access functions. **Changes who can see which records** |
| `20261114180000_chat_lessons_client_scope` | All of it |
| `20261031190000_fluid_surface_fund_records` | Most of the fund attributes it adds |
| `20261106160000_statement_import_attributes` | Most of the statement attributes it adds |

**Could not be checked.** These only update or backfill existing rows, so nothing shows whether they ran. Most are written to be safe to run again; read each first:

`20261026170000_market_cap_sums`, `20261028231000_fund_surface_sample_data`, `20261031140000_retire_legacy_position_framework`, `20261101153000_register_live_surfaces`, `20261104153000_position_roll_cashflows`, `20261105120000_nav_rec_source_backfill`, `20261113130000_market_cap_required`, `20261113170000_loader_identifier_grants`, `20261115131000_syndicate_status_backfill`.

To mark one as applied without running it: `npx supabase migration repair --status applied <version>`.

## Applying a new migration

1. Dry-run it in a transaction that rolls back: `begin;` + the file + `rollback;`, run with `npx supabase db query --linked -f <file>`.
2. Apply it: `npx supabase db push` once nothing else is pending, or `npx supabase db query --linked -f <file>` followed by `npx supabase migration repair --status applied <version>`.
3. A request through `db query --linked` is cut off after about two minutes. A migration that does more than that, such as solving a formula for every record, has to be split, or run over a direct connection with `psql`.

## Fresh builds (2026-11-20)

Until 2026-11-20 the chain did not apply to an empty database: `supabase db reset` stopped part way. The hosted project never noticed, because most of these files ran there long ago, against data that a fresh database does not have yet (`supabase/seed/001_seed_data.sql` runs after the migrations, not before them). These files were edited so the chain applies in order on an empty database, and then the seed. Each edit does what the file did before wherever the earlier state exists, and only skips or adapts where it does not.

| File | What stopped a fresh build | Edit | Why it is safe on hosted |
|---|---|---|---|
| `20261012140000_retire_dotted_attribute_codes` | Repointing `TOTAL_AUM` at `MARKET_VALUE` failed the dependency check: `MARKET_VALUE` arrives in 20261014123530, `CREDIT_RATING` with the seed | The check (`trg_validate_derived_attribute`) is switched off around the repoint, as 00054 and many later files do. The file's own `BEGIN`/`COMMIT` is removed (the CLI already runs each file in one transaction) | Applied. Where both codes exist the repoint gives the same result |
| `20261013145919_client_schema_scope` | `CREATE OR REPLACE VIEW public.relationship_types` cannot drop the `updated_at` column the 00055 view (`SELECT *`) has on a fresh database | The view is dropped first only when it has `updated_at`. It comes back with the schema's default grants, which are the grants it had | Applied. The hosted view has no `updated_at`, so it is replaced in place as before |
| `20261118140000_inherited_templates` | Same defect as the line above | Same guard. After the fix above it does nothing on a fresh database either | Status after the 11-17 snapshot unknown. The guard does nothing where the view has no `updated_at` |
| `20261016140000_issuer_security_position_dq` | The DQ sample records named the hosted client `6c6bac30-...` by id: foreign key violation | That client when it exists, else the first client by `created_at`, the rule every other sample-data migration uses | Applied. The lookup returns the same id on hosted |
| `20261024140000_dq_compiled_rule_sql` | The self-check: "Compiled SQL disagrees for Fund NAV Required" | 00006 and 00061 store three sample rules as failure predicates (`nav IS NULL`). The evaluator and compiler installed here read an expression as true for a passing record, and on hosted those rules still read `nav IS NOT NULL`, `price >= 0`, `DEAL_DATE <= CURRENT_DATE` (`supabase/remote-history/dq_program_before_2026-11-17.json`). The file now rewrites exactly those three texts to the hosted ones before the check, so the check compares the rules hosted has. `nav IS NULL` failed only on the message: the compiled SQL drops a lone "nav is present" that the interpreter keeps. 20261117060000 replaces all three rules later | Applied. The rewrite matches only 00061's exact text, which hosted does not hold |
| `20261102165056_deal_performance`, `20261102194523_tranche_seniority_backfill` | Each inserted its own `schema_migrations` row. The CLI inserts that row itself, in the same transaction, after the file, so the CLI's plain insert failed with a duplicate key | The inserts are removed | Applied, and the rows are there |
| `20261104153000_position_roll_cashflows` | Raised when the HSCF2 sample fund is missing | Skips with a notice instead | Could not be checked. Where the sample fund exists nothing changes |
| `20261105132321_forty_act_book` | Raised when `HALY-FUND-HSI` is missing | Skips the sample book, and the scorecard that scores it, with a notice | Applied. Where the fund exists nothing changes |
| `20261105160000_role_entity_security` | Created a helper and four policies on `position_master.dimensional_intersections` and `position_metrics`, which 20261031140000 dropped. **This would also have failed a hosted `db push`** | The helper and the four policies are created only when the tables exist. Everything else in the file is unchanged | Pending. 20261031140000 runs before it in a push, so the tables are gone and the guarded part is skipped, which is the only way the file can apply |
| `20261109181221_scope_unassigned_attributes` | "Attributes still have no entity": the closing check covered the whole catalog, including 17 statement attributes 20261106160000 adds with no entity | The check covers the five attributes this file places | Applied. When it ran on hosted the whole-catalog check passed, so the narrower one does too |
| `20261117060000_data_quality_program` | Expected 185 required attributes and 177 rules; 11 attributes (NAV, COUNTRY, ...) and the 14 rules on them come from the seed, after the migrations | An attribute missing from the catalog altogether is skipped with a notice. One that exists on another entity still stops the migration | Status after the 11-17 snapshot unknown (the snapshot was taken just before it, which suggests it ran). Hosted has every one of these attributes, so nothing is skipped there |
| `20261118210000_document_refile` → `20261118210001_document_refile` | Shared version 20261118210000 with `20261118210000_agents`; the CLI records one row per version | Renamed. See the next section | Content unchanged apart from a header note |

A fresh database still differs from hosted in data: the sample books that need the seed's templates are not created, and 26 of the seed's 28 attributes (NAV, COUNTRY, ISIN, ...) have no entity because 00054 sets entity codes before the seed adds them (43 attributes in all have none, counting the 17 from 20261106160000). Only the seed can fix the second (`supabase/seed/001_seed_data.sql` should give each attribute its `domain_code`).

## Duplicate version 20261118210000

`20261118210000_agents.sql` and `20261118210000_document_refile.sql` had the same version. The second was renamed to `20261118210001_document_refile.sql`, the same way `20261103153001` was handled. It was chosen because it is safe to run twice: it only replaces `public.document_refile(uuid)` and sets its grants, the same grants 20261120101000 leaves it with. `agents` is also written to be run again, but it creates a table and seeds rows.

Hosted has at most one history row for 20261118210000, and it can belong to either file, or to neither. Check before the next push:

```sql
select version, name from supabase_migrations.schema_migrations
where version in ('20261118210000', '20261118210001');
select to_regclass('ops.agents') as agents_table,
       to_regprocedure('public.document_refile(uuid)') as document_refile;
```

- `ops.agents` exists and there is no 20261118210000 row: `npx supabase migration repair --status applied 20261118210000`.
- `public.document_refile(uuid)` exists: `npx supabase migration repair --status applied 20261118210001`. (Letting the push run it again is also safe.)
- A 20261118210000 row exists but `ops.agents` does not (the row came from document_refile): `npx supabase migration repair --status reverted 20261118210000`, so the push applies `agents`.
- Neither exists: nothing to repair; the push applies both.

Since 20261118210001 sorts before versions hosted may already have, `db push` may ask for `--include-all`.

## Function grants

PostgREST exposes every function in the API schemas, so a function's grants are the first check on who can call it. Since `20261120101000_function_lockdown.sql`:

- A new function is not executable by PUBLIC or anon. The migration that creates it grants what it means to open.
- A function created in `public` still reaches `authenticated` and `service_role` through Supabase's default grant. A function created in any other schema (`tenancy`, `compliance`, `ops`, `golden_master`, ...) gets no grant at all: `GRANT EXECUTE ON FUNCTION ... TO authenticated` (and/or `service_role`) explicitly, or it cannot be called.
- Never `REVOKE ... FROM PUBLIC` alone. Supabase also grants anon and authenticated directly, so revoke from each role you mean: `REVOKE ALL ON FUNCTION f(...) FROM PUBLIC, anon, authenticated;` then grant back what is needed.
- The only functions anon may run are `public.workflow_portal_get(text)` and `public.workflow_portal_submit(text, text, jsonb, text)`.
- A SECURITY DEFINER function sets its own `search_path`, and checks the caller first: `PERFORM tenancy.assert_entity_access(p_entity_id, 'READ')` for a record id, or its own client check.

`supabase/tests/09_function_grants.sql` checks all of this over the whole catalog, and `10_definer_sweep.sql` calls every SECURITY DEFINER function a signed-in user can call with another client's ids and fails on any of that client's data in the answer.

## Upserting links

Since `20261120108000_relationship_history.sql`, `entity_instances.entity_relationships` keeps a link's history: an ended link stays as a row, and the four-column UNIQUE constraint is replaced by a unique index on current links only (`WHERE system_to = '9999-12-31 23:59:59+00'`). A new migration that upserts current links must name that index's predicate, or Postgres finds no matching constraint:

```sql
INSERT INTO entity_instances.entity_relationships (parent_entity_id, child_entity_id, relationship_code, valid_from, ...)
VALUES (...)
ON CONFLICT (parent_entity_id, child_entity_id, relationship_code, valid_from)
    WHERE system_to = '9999-12-31 23:59:59+00'
DO NOTHING;
```

Older migrations that use `ON CONFLICT` on the four columns alone ran before this one and are left as they are. API callers can only end a link; to change one, use `entity_instances.revise_relationship`.

## Pushing what is pending

Push in version order, all at once (`npx supabase db push --include-all`, after the dry run), not the 2026-11-20 files on their own:

1. The pending files listed above, and anything `db push --dry-run` lists from after the 11-17 snapshot, in version order. `20261031140000` comes before `20261105160000`, which has to run before the security migrations: it creates `tenancy.entity_ancestors`, and its `tenancy.is_entity_restricted` is replaced by 20261120100000. Run after them, it would put the old function back.
2. Settle 20261118210000 / 20261118210001 as described above.
3. The 2026-11-20 security migrations, last, in order: `20261120100000_tenancy_hardening` (needs `tenancy.client_auth_requirements` from 20261109180000 and `ops.workflow_service_accounts` from 20261116130000), `20261120101000_function_lockdown`, `20261120102000_compliance_tenant_scope`, `20261120103000_shared_table_reads`, `20261120104000_job_queue_scope`, `20261120105000_merge_entities_repair`, `20261120106000_bitemporal_integrity`, `20261120107000_worker_scope`, `20261120108000_relationship_history`, `20261120130000_compliance_rule_version_atomic` (and any later 20261120 file). Several replace a function "with the body already in the database"; those bodies assume every earlier file has run.

## Testing the chain

`scripts/db-test.sh` builds a throwaway Postgres cluster, loads `supabase/tests/supabase_stub.sql` (stand-ins for Supabase's roles, auth, storage and vault), applies every migration in order, each in one transaction with its history row written the way the CLI writes it, then the seed. It then checks that every migration version is unique and recorded, loads `supabase/tests/fixture.sql` (two clients, A and B), and runs `supabase/tests/NN_*.sql`. Each test file runs in a transaction that rolls back and fails on any check that fails. It needs Postgres with pgvector (`PG_BIN` to choose the binaries); see the header of the script.

`scripts/db-test.sh --db-url <url>` runs only the checks, against a database that is already built. The `database` job in `.github/workflows/ci.yml` does that after `supabase db start` and `supabase db reset --local` on the Supabase Postgres image `supabase/config.toml` names.
