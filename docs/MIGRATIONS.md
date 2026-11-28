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

## Applied on 2026-11-28

`20261128050000_dq_blank_shortcut_again` was applied through `db query --linked` after a dry run in a transaction that was rolled back, and recorded in `supabase_migrations.schema_migrations` with its SQL. `migration repair` could not record it, because the file was on a branch the linked checkout did not have. Before it ran, two hosted functions still treated a rule written "ATTRIBUTE IS NULL OR ..." as passing a blank: `public.data_quality_dashboard` and `public.load_batch_quality`. Both now ask `data_quality.rule_passes_when_blank`, and signed-in users can still run them. `npm run perf -- --apply` showed no case changing by more than 0.1% of its baseline.

## Applied on 2026-11-24

`20261124090000_required_parents` was applied through `db query --linked` after a dry run in a transaction that was not committed, and recorded as applied. It adds `relationship_types.required_unless_attribute_code`, exempts library covenants from needing a deal, and links four sample securities to their sample issuers. `supabase/seed/ocio_harbor_lite.sql` was run again after it: Harbor Lite now has 22 issuer records with its 113 securities linked to them, and the Securities, Market Data and Deals modules turned on. One record on the hosted project still has no required parent, by decision: the cash match `HSCF2-FUND-MATCH-20260930-HSCF2-BTX-11-mw46kev8`.

## Seed re-applied on 2026-11-23

`supabase/seed/ocio_harbor_lite.sql` was run again on the hosted project, after a dry run in a transaction that was not committed. It replaces Harbor Lite's two JSON attributes (`OCIO_TARGET_MATRIX`, `OCIO_PACING_OVERRIDES`) with the `OCIO_TARGET` entity type: one Allocation Target record per fund, hierarchy and level, linked by `OCIO_TARGET_FUND`, with each minimum, target and maximum as its own attribute. It created 74 records holding 175 values and deleted the two attributes and their 18 seeded values; no hand-entered value existed. No migration was involved.

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
| `20261122180000_provisional_scopes` | Step 1 of [PROVISIONAL_RECORDS.md](PROVISIONAL_RECORDS.md): `provisional_scopes`, held-record columns on `load_batch_records` (and `action` widened to 12 characters), `load_batch_links`, and `entity_instances.scope_for_caller`. Schema only; nothing writes to it yet. A dry run on the hosted project in a rolled-back transaction came first: the 11 existing batch records passed the new checks, and neither `anon` nor `authenticated` can reach the new tables |

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
2. `20261118210000_agents` and `document_refile` shared a version. `document_refile` is now `20261118210001` (see "Versions made unique on 2026-11-23" below).
3. The 2026-11-20 security migrations, last, in order: `20261120100000_tenancy_hardening` (needs `tenancy.client_auth_requirements` from 20261109180000 and `ops.workflow_service_accounts` from 20261116130000), `20261120101000_function_lockdown`, `20261120102000_compliance_tenant_scope`, `20261120103000_shared_table_reads`, `20261120104000_job_queue_scope`, `20261120105000_merge_entities_repair`, `20261120106000_bitemporal_integrity`, `20261120107000_worker_scope`, `20261120108000_relationship_history`, `20261120130000_compliance_rule_version_atomic` (and any later 20261120 file). Several replace a function "with the body already in the database"; those bodies assume every earlier file has run.

## Testing the chain

`npm run db:replay` builds a database from the migrations on plain Postgres with pgvector (`scripts/db-replay/shim.sql` stands in for what a Supabase project provides, with Supabase's starting grants). CI then runs `npm run guard:db`, `npm run test:db` and `bash scripts/db-test.sh --db-url "$DATABASE_URL"`, which checks every version is recorded (a file `legacy.txt` lists as broken may be missing), loads `supabase/tests/fixture.sql` (two clients, A and B) and runs `supabase/tests/NN_*.sql`. Each test file runs in a transaction that rolls back and fails on any check that fails.

`scripts/db-test.sh` without `--db-url` builds its own throwaway cluster from `supabase/tests/supabase_stub.sql` and applies every file as the Supabase CLI would. It refuses to start if two files share a version, and it stops at the migrations `legacy.txt` lists, so use the replay for a full build.


## Applied on 2026-11-22: 20261122200000_nav_pack

The NAV pack's record types (trial balance lines, capital accounts, valuation support, FX translation), their lists, links, templates and column headings, the fund's pack and FX settings, a fee step-down, and the notes flag on a statement. Metadata only: no records. Every code it adds was checked to be new on the hosted project first, so its `ON CONFLICT ... DO UPDATE` touched nothing already there, and it runs twice without change. Applied through the Management API after a dry run in a rolled-back transaction, and recorded.

It was first dated `20261122150000`, which `20261122150000_notify_collect_client_and_open_check` already uses, and the hosted project had `20261122160000` to `20261122190000` applied, so it was redated to run after them.

Found on the hosted project: `20261122160000_entity_views`, `20261122170000_surface_blueprints`, `20261122180000_provisional_scopes` and `20261122190000_relationship_reads_set_check` are applied there but are in no file on master. Their SQL is in `supabase_migrations.schema_migrations.statements`. `20261122150000_notify_collect_client_and_open_check` is on master and not applied there.

## Applied on 2026-11-23: the audit migrations and everything after them

The web app deployed from master called functions the hosted project did not have. The first one seen was `golden_master.write_value`, which every manual override now writes through. The others were `create_rule_version`, `revise_relationship`, `evaluate_rule_for_client`, `job_run_notify_claim` and `workflow_worker_entity_access`. The 2026-11-20 security migrations had been merged without being applied.

These 26 were applied in version order, in one transaction, through the Management API. A dry run in a rolled-back transaction came first, with `lock_timeout` 10s and `check_function_bodies` off, as `pg_dump` does:

`20261120100000` to `20261120108000`, `20261120130000`, `20261121000000`, `20261121130000`, `20261121130100`, `20261121150000`, `20261121170000`, `20261122004300`, `20261122150000`, `20261122160000_feed_loads_keep_history`, `20261122170000_entity_codes_per_client`, `20261122180000_golden_source_as_known`, `20261122190000_explain_golden_source`, `20261122200000_population_preview_in_database`, `20261122210000_reresolve_golden_in_batches`, `20261122220000`, `20261122230000`, and `20261123052600_entity_restricted_fast_path_scoped`.

Three things differ from a plain `db push`:

- **Six versions are taken on the hosted project.** `20261122160000` to `20261122210000` are recorded there for other migrations (`entity_views`, `surface_blueprints`, `provisional_scopes`, `relationship_reads_set_check`, `nav_pack`, `dq_rules_describe_exceptions`), so master's files with those versions are applied but not recorded. `db push` sees those versions as applied and will not run them again.
- **`20261120103000_shared_table_reads` ran in a hosted edition.** The hosted project has no `data_connections`, `data_loaders`, `import_maps` or `import_executions`, although `00015` is recorded there. The policy changes on those four tables were wrapped in `to_regclass(...) IS NOT NULL`, so they did nothing there. The SQL that ran is what `statements` records.
- **`20261123052600_entity_restricted_fast_path_scoped` is new.** `tenancy_hardening` counts only the owning client's grants. The hosted project had already restored the no-grants shortcut (`20261120234000 entity_restricted_fast_path`, in no file here). Applied in order, the hardening would have dropped that shortcut. The new migration keeps both, so a fresh database ends the same.

Before: no grant crossed clients and no support session was open, so the audit's two data clean-ups changed nothing. After: all six functions exist, `metadata_register.evaluate_*_formula` run for the service role only, and the 20 free versions plus `20261123052600` are recorded.

Still not applied on the hosted project: the six older migrations under "Still pending" above, left as they were.

## Versions made unique on 2026-11-23

Merging master into the provisional-scopes branch left eight versions used by two files each (three for `20261122200000`). The hosted project records one row per version. For each version, the file it recorded is the one named in `supabase_migrations.schema_migrations.name`, and that file kept its version. The other file was renamed. Where it sorted before the recorded file, it moved to one second before the shared version. Otherwise it moved to one second after. That way the replay order did not change.

| Was | Now | On the hosted project |
|---|---|---|
| `20261118210000_document_refile` | `20261118210001` | applied (`public.document_refile` exists), recorded by repair |
| `20261122160000_feed_loads_keep_history` | `20261122160001` | applied (`golden_master.supersede_value`), recorded by repair |
| `20261122170000_entity_codes_per_client` | `20261122165959` | applied (`entity_instances.entity_id_for_code`), recorded by repair |
| `20261122180000_golden_source_as_known` | `20261122175959` | applied (`golden_master.golden_source_history`), recorded by repair |
| `20261122190000_explain_golden_source` | `20261122185959` | applied (`golden_master.explain_golden_source`), recorded by repair |
| `20261122200000_certifications` | `20261122195959` | was not applied (no `golden_master.certifications`); applied and recorded the same day |
| `20261122200000_population_preview_in_database` | `20261122200001` | applied (`compliance.preview_population`), recorded by repair |
| `20261122210000_reresolve_golden_in_batches` | `20261122210001` | applied (`golden_master.reresolve_golden_sources`), recorded by repair |
| `20261122220000_grid_lookup_entity_id` | `20261122220001` | was not applied (`reporting.grid` did not return `<alias>.entity_id`); applied and recorded the same day |

The recorded files kept their versions: `agents`, `entity_views`, `surface_blueprints`, `provisional_scopes`, `relationship_reads_set_check`, `nav_pack`, `dq_rules_describe_exceptions` and `chat_held_action_uses`.

`20261122195959_certifications`, `20261122220001_grid_lookup_entity_id` and `20261123120000_compliance_results_as_of` were then applied in version order, in one transaction, after a dry run that rolled back, and recorded.

`20261123150000_statement_review_notes` was applied on 2026-11-23 after a dry run that rolled back, and recorded. It registers `STATEMENT_REVIEW_NOTES` and `STATEMENT_REVIEW_OUTCOME` on the statement period and assigns them to its template, for the Borrower financials workflow's review notes ([WORKFLOWS.md](WORKFLOWS.md#borrower-financials)). It changes no function and no value.

The merge also brought 11 database functions with direct reads that were not on `scripts/guard/direct-reads.txt`. Master wrote most of them before the list existed. Two came from this branch's own new files (`latest_results_as_of`, `relationship_endpoint_ids`). They were added to the list, so the static guard flags those 11 lines once, on that commit.

## Applied on 2026-11-23: OCIO for Harbor Lite

Each was dry-run in a transaction that rolled back, then applied with `npx supabase db query --linked -f <file>` and recorded with `migration repair`.

- `20261123170000_client_reference_lists` gives `metadata_register.reference_lists` a nullable `client_id`, like entity types and attributes. A list's values follow their list. Reads and writes use `tenancy.schema_row_visible` and `tenancy.can_write_schema_row`. An attribute may draw only from a global list or its own client's list.
- `20261123190000_proforma_for_signed_in_users` makes pro forma and investment capacity work for signed-in users. `compliance.cleanup_proforma` deletes a hypothetical position's values and links before the position, and only positions marked `proforma`, so `guard_entity_delete` no longer refuses it. `compliance.materialize_proforma_legs` sets `golden_master.trusted_writer` for its own inserts, and `entity_instances.guard_relationship_rows` now honours that mark as the value guard does, so the trade is known at the caller's Knowledge date rather than at `now()`. `compliance.proforma_snapshot` checks each leg's security on its own; the join it replaced ran `has_entity_access` over every record (5.6s of 6.5s). A signed-in one-leg snapshot went from failing after 6.6s to about 1s.
- `20261123180000_proforma_temp_deletes_have_where` changes four bare `DELETE FROM <temp table>;` statements in `compliance.evaluate_proforma` and `compliance.deal_capacity_observations` to `WHERE TRUE`. The API runs with safe updates on, so every pro forma from a signed-in user failed with "DELETE requires a WHERE clause". The functions are otherwise the definitions in force on the hosted project.

`supabase/seed/ocio_harbor_lite.sql` was applied the same way. It writes only Harbor Lite rows: four tree lists, 31 `OCIO_*` attributes on the global FUND, SECURITY, POSITION and DEAL_FUNDING_PLAN types, 249 sample records (`OCIO-*`), 22 compliance rules (`OCIO_*`) with per-sleeve thresholds, and the `ocio` module granted to Harbor Lite. It can be run again. `OCIO_OWNERSHIP_PCT` was created by the first run and then removed; the fund-size rule now divides by the underlying fund size itself.

A later run on 2026-11-23 added Harbor Lite's Fund security template, `OCIO_SECURITY_FUND`. It also added the Harbor Lite list and attribute `OCIO_ASSET_TYPE` (Fund, Direct / Co-Investment, Separate Account), derived from each security's investment type. Primary funds, secondaries and funds of funds are Fund. The template has four sections: Identification, OCIO classification, Fund terms, and Geography and sector. Its 25 fields are every `OCIO_*` security attribute plus the global fields that describe a fund (name, manager, manager record, currency, description, investment company). Asset type and currency are required. The 84 sample securities whose asset type is Fund use it, including 10 pipeline-deal securities. A rerun keeps each record's template in line with its asset type.

## Applied on 2026-11-24: 20261123200000_small_scope_reads_by_record

Dry-run in a transaction that rolled back, then applied with `npx supabase db query --linked -f <file>` and recorded with `migration repair`.

An entity list for a client with few records was as slow as one for a client with many, because two reads went through every client's attribute values:

- `golden_master.persisted_attribute_values` and the by-source read in `reporting.view_values` filtered with `= ANY(COALESCE(ids, '{}'))`. The grid reaches them without the ids known at plan time, and Postgres does not run a `COALESCE` ahead of the row security check, so the filter could not be an index condition. They now filter with `= ANY(ids)`. A null list still matches nothing.
- `public.data_quality_dashboard`, which every entity list loads for its Data Quality tab, joined the values table to the records in scope with nested loops off, so both of its value reads scanned the whole table. It now finds the records in scope first and filters both reads on that list. The scope rule is unchanged.

The dry run ran old and new in one transaction as a signed-in user, each call twice. For Harbor Lite's 113 securities the grid went from 1,311 and 666 ms to 505 ms, and the Data Quality call from 2,410 and 478 ms to 502 and 151 ms. For 725 securities the grid went from 4,909 and 1,529 ms to 1,022 ms, and the Data Quality call from 2,796 and 816 ms to 483 and 469 ms. Results were the same, except that the dashboard's entity list can order records that tie on count and name differently; that order was already arbitrary.

Timings on the hosted project swing several times over between runs, so compare old and new in the same transaction.

## Applied on 2026-11-24: 20261124120000_client_catalog_presentation

What a client calls an entity type and the shared fields it hides ([ALIASES.md](ALIASES.md), "Per client"). It adds `client_domain_settings` and `client_attribute_settings`, `tenancy.presentation_client_id`, and replaces the views `public.domain_types` and `public.attribute_register` and the function `public.get_attributes_with_aggregation`. No record changes.

A dry run on the hosted project on 2026-11-24, in a transaction that rolled back, applied it and checked it as a member of one client, as staff simulating a client, as the service role and signed out. Reading the catalog took the same time before and after (the views' two lookups run once per statement).

It was applied in one transaction with `npx supabase db query --linked -f <file>` and recorded with `migration repair`. Afterwards all 61 entity types read under their catalog names and all 1,204 attributes were returned, with no client setting stored.

Since it was applied, `domain_name` and `is_visible` cannot be written through the public views. An app built before this change writes them there (the entity type edit form, and the Visible box on an attribute), so those two actions fail in that build until the app from this change is deployed. It writes the catalog tables instead. Nothing else in the older build is affected.

## Applied on 2026-11-24: 20261124130000_client_aliases

A client's own aliases ([ALIASES.md](ALIASES.md), "A client's words"). It goes after `20261124120000_client_catalog_presentation`: it reads that migration's tables and replaces its `public.client_catalog_settings`. It adds a nullable `client_id` to `domain_aliases`, `entity_name_aliases` and `attribute_aliases`, replaces each list's unique index with one for shared aliases and one per client, recreates the three public alias views with `client_id` at the end, and adds `metadata_register.alias_words`, `public.session_alias_words`, `public.add_client_domain_alias` and `public.remove_client_domain_alias`. No record changes.

A dry run on the hosted project on 2026-11-24 applied both migrations in one transaction that rolled back. With no client words, `session_alias_words` returned the 90 shared aliases the three tables hold. A client word for another type replaced the shared one for that client only, and a member could not write a shared alias or another client's.

It was applied the same way, straight after the first. Afterwards a signed-in member read the same 90 shared aliases as before (10 for entity types, 10 for record names, 70 for fields), with no client alias stored, and the import screen's catalog returned the same 2,344 targets through the new reader.

This one has no order to keep with the app. The app reads the words through one loader that falls back to the three tables when the function is missing, so it works before and after.
