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

## Applied on 2026-11-21

`20261114160000_compliance_capacity_and_proforma` (never applied before; the new capacity path needs its proforma functions) and `20261121130000_capacity_reads_the_evaluator` were applied together in one transaction through the Management API, after a dry run in a rolled-back transaction, and recorded in `supabase_migrations.schema_migrations`.

Later the same day, 18 more files were brought into line, in one transaction, after a rolled-back dry run. A regression guard compared the rule evaluator's results for two deals across every allocation-eligible fund before and after (362 rows, identical) and would have rolled back on any difference:

- Applied: `00062_dq_set_based_evaluation`, `20261023140000_chat_skill_state`, `20261103090000_condition_expressions`, `20261106160000_statement_import_attributes`, `20261109180000_client_auth_requirements`, `20261113130000_market_cap_required`, `20261114180000_chat_lessons_client_scope`, `20261117150000_import_resolution_status`, `20261120120000_attribute_dropdown_lists`, `20261120170000_security_directory_parent`. `condition_expressions` also redefines `compliance.eval_operand`, which the later, already applied `20261113090000_read_functions` owns; the live definition was kept.
- Recorded as applied without running, because their effect was already there: `20261026170000_market_cap_sums`, `20261113170000_loader_identifier_grants`, `20261115131000_syndicate_status_backfill`, and five applied before under other versions with identical SQL: `20261120143000_entity_search_enabled`, `20261120153000_search_main_entity_types`, `20261120154500_search_hide_market_parties`, `20261120201000_dq_scores`, `20261120214500_dq_consensus`.

`client_auth_requirements` gives every client the permissive default (password allowed, no MFA). The access-token hook it adds is not active until it is turned on in the project's Auth settings.

Still to do:

- `20261121130100_retire_old_capacity_path` drops `compliance.fund_security_capacities`. The deployed app no longer calls it; apply when you want it gone.
- `20261121120000 fund_thresholds_only` is applied on the hosted project but is in no branch of this repo. Its SQL is in `supabase_migrations.schema_migrations.statements`. Add it here as a file so a fresh database matches.
- Not applied, and need a decision:
  - `20261028231000_fund_surface_sample_data` would delete and rewrite 1,044 attribute values of the HSCF2 sample fund.
  - `20261031190000_fluid_surface_fund_records` adds two sample funds (6 records, 3 attributes).
  - `20261105120000_nav_rec_source_backfill` adds 3 records and 150 values for NAV reconciliation.
- Fail on the hosted project as written:
  - `20261031140000_retire_legacy_position_framework`: the view `public.position_master` still depends on `read_projections.position_master`. The legacy tables are empty.
  - `20261101153000_register_live_surfaces`: its `ON CONFLICT` target has no matching unique constraint on hosted.
  - `20261104153000_position_roll_cashflows`: the HSCF2 cash flows it inserts are already there (41 rows), and the insert hits its own duplicate.

## Applied on 2026-11-22

Each was applied through the Management API in its own transaction and recorded in `supabase_migrations.schema_migrations`. The first two had a dry run on the hosted project in a rolled-back transaction first.

| Migration | What it does |
|---|---|
| `20261122100000_nav_report_chart` | The NAV chart lines a filed report needs, the report wording on every chart line (115 lines), the statement's comparative date and report checks, and three fund settings (capital model, management fee basis, performance fee basis). Metadata only. The web app deployed before it shows every chart line on the NAV statement tab, so the new lines show there empty until the app built from the same change is out |
| `20261122110000_report_trigger` | The `REPORT` trigger source: a stored file read as a filed report records one `REPORT_RECEIVED` event, and a trigger that fits starts one run given that file. `workflow_trigger_save`, `job_run_workflow_triggers` and `workflow_triggers_wake_events` are copied whole from their last version with only the REPORT branches added; before applying, the live functions were compared with those copies and differed only there. Tested by `scripts/db-tests/report-trigger.ts` |
| `20261122120000_attribute_aliases_service_role` | Lets the service role read field aliases. Since `20261119190500_semantic_aliases`, every Load data upload that needed a fresh column plan failed on the hosted project with "permission denied for table attribute_aliases" |
| `20261122130000_position_type_report_wording` | The asset classes a schedule of investments prints ("First Lien Debt", "Common Stocks") as synonyms on the position type list, so positions from a filed report get a type on the list |
| `20261122140000_position_link_direction` | Sets `POSITION_FUND` and `POSITION_SECURITY` to the position-as-parent definition `00009_entity_relationships` gives. See below |

### Found on the hosted project

- **Position links defined the other way round.** On the hosted project, `POSITION_FUND` and `POSITION_SECURITY` had the fund or security as the parent (one to many) since the project was created on 2026-10-02, against `00009_entity_relationships` and every reader. The loader orients a new link by that definition, so a load wrote links the readers did not see. `20261122140000` corrects the definition. Links already stored were not changed, except the 390 the OHA report load wrote that day, which were turned round to match.
- **Still to do:** 6,138 `POSITION_FUND` and 7,776 `POSITION_SECURITY` links from 2026-10-02 and 2026-10-23 are stored the other way round. The fund page, the fund and cash reconciliations and allocations do not see those positions. Turning them round is a change to records: decide first whether the positions they link are still wanted.
- **Still to do:** `DEAL_FUND` is defined in the migrations but missing on the hosted project, and `Deal_Security` is on the hosted project but in no migration.
- **Still to do:** the service role cannot read 17 other tables a signed-in user can (among them `entity_instances.source_attribute_values` and `metadata_register.template_attribute_assignments`). Nothing in the NAV reconciliation needs them. Grant them only where a service-role reader needs them.

## The 2026-11-20 security migrations

`20261120100000_tenancy_hardening` to `20261121000000_reconcile_audit_with_master` came from the tenant-isolation audit (merged 2026-11-22). They were written on a branch cut before master's later migrations, so `20261122150000_notify_collect_client_and_open_check` puts together the one function both sides replaced (`public.job_run_notify_collect`: the client id from the audit, the open-step check from `20261121150000`). Apply it after them on the hosted project too.

The audit also edited a dozen applied migrations so the chain builds on an empty database. Those edits were not kept: an applied migration is never edited. A fresh build is `scripts/db-replay/replay.sh`, and where a file cannot apply there, `scripts/db-replay/legacy.txt` says how it is applied. Three of the audit's fixed copies are used that way, mode `patched`, from `scripts/db-replay/patches/`: `20261024140000_dq_compiled_rule_sql`, `20261105160000_role_entity_security` (it creates `tenancy.entity_ancestors`, which the security migrations need) and `20261109181221_scope_unassigned_attributes`. The files in `supabase/migrations` are as they ran on the hosted project.

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
2. `20261118210000_agents` and `20261118210000_document_refile` share a version. The CLI records one row per version, so check which of the two hosted has (`ops.agents`, `public.document_refile(uuid)`) and use `npx supabase migration repair` for the other before the push.
3. The 2026-11-20 security migrations, last, in order: `20261120100000_tenancy_hardening` (needs `tenancy.client_auth_requirements` from 20261109180000 and `ops.workflow_service_accounts` from 20261116130000), `20261120101000_function_lockdown`, `20261120102000_compliance_tenant_scope`, `20261120103000_shared_table_reads`, `20261120104000_job_queue_scope`, `20261120105000_merge_entities_repair`, `20261120106000_bitemporal_integrity`, `20261120107000_worker_scope`, `20261120108000_relationship_history`, `20261120130000_compliance_rule_version_atomic` (and any later 20261120 file). Several replace a function "with the body already in the database"; those bodies assume every earlier file has run.

## Testing the chain

`npm run db:replay` builds a database from the migrations on plain Postgres with pgvector (`scripts/db-replay/shim.sql` stands in for what a Supabase project provides, with Supabase's starting grants). CI then runs `npm run guard:db`, `npm run test:db` and `bash scripts/db-test.sh --db-url "$DATABASE_URL"`, which checks every version is recorded (a file `legacy.txt` lists as broken may be missing), loads `supabase/tests/fixture.sql` (two clients, A and B) and runs `supabase/tests/NN_*.sql`. Each test file runs in a transaction that rolls back and fails on any check that fails.

`scripts/db-test.sh` without `--db-url` builds its own throwaway cluster from `supabase/tests/supabase_stub.sql` and applies every file as the Supabase CLI would. It stops at the shared 20261118210000 version and at the migrations `legacy.txt` lists, so use the replay for a full build.


## Applied on 2026-11-22: 20261122200000_nav_pack

The NAV pack's record types (trial balance lines, capital accounts, valuation support, FX translation), their lists, links, templates and column headings, the fund's pack and FX settings, a fee step-down, and the notes flag on a statement. Metadata only: no records. Every code it adds was checked to be new on the hosted project first, so its `ON CONFLICT ... DO UPDATE` touched nothing already there, and it runs twice without change. Applied through the Management API after a dry run in a rolled-back transaction, and recorded.

It was first dated `20261122150000`, which `20261122150000_notify_collect_client_and_open_check` already uses, and the hosted project had `20261122160000` to `20261122190000` applied, so it was redated to run after them.

Found on the hosted project: `20261122160000_entity_views`, `20261122170000_surface_blueprints`, `20261122180000_provisional_scopes` and `20261122190000_relationship_reads_set_check` are applied there but are in no file on master. Their SQL is in `supabase_migrations.schema_migrations.statements`. `20261122150000_notify_collect_client_and_open_check` is on master and not applied there.
