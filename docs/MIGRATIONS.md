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

Still to do:

- `20261121130100_retire_old_capacity_path` drops `compliance.fund_security_capacities`. Apply it only after the web app built from this change is deployed; the app deployed before it still calls that function.
- `20261121120000 fund_thresholds_only` is applied on the hosted project but is in no branch of this repo. Its SQL is in `supabase_migrations.schema_migrations.statements`. Add it here as a file so a fresh database matches.
- 23 other files here are still not applied (`npx supabase db push --dry-run` lists them). Review each as described above.

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
