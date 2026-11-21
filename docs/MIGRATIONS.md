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
