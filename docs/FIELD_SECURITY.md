# Field-level security

Some attributes can be seen only by people cleared for them. Migration: `supabase/migrations/20261126170000_attribute_access_levels.sql`. Tests: `supabase/tests/23_attribute_access.sql`.

## Levels

| Level | Who sees and changes the values | Permission |
|---|---|---|
| Everyone (`STANDARD`, the default) | Anyone who can read the record | |
| Confidential | People cleared for confidential data | `data.confidential.read` (client administrators, data stewards) |
| Restricted | People cleared for restricted data | `data.restricted.read` (client administrators); covers confidential too |

- **The platform** sets an attribute's level in the attribute editor ("Who sees the values").
- **A client** can set its own level for any field it uses, in its field list ("Who sees values"; needs role management in the client). The client's level wins for that client, including making a field more open than the catalog's level.
- **Nothing changes** for anyone until an attribute is classified.
- **A person in several clients** does not see a field that any of their clients hides from them.
- **Platform staff and the platform service** see everything.

## Where it holds

- **The database, through one function.** `tenancy.hidden_attribute_ids()` says which attributes the caller may not see. Row security on `golden_master.entity_attribute_values` and `intersection_attribute_values` applies it to reading and to writing.
- **Everything that runs as the caller.** That covers the shared readers (`winning_attribute_values`, `query_values`, `report_grid`, the `entity_master` view) and every direct read in the app, so:
  - record pages, grids, reports and their CSV exports;
  - the Excel add-in;
  - the assistant's tools and the MCP connector;

  all see only what the person may.
- **The definer functions that hand values to people** read through the same filter: the sources panel (`explain_golden_source`), the data quality dashboard and its details, the rule preview, stale attributes and confirming a receipt.
- **Definer functions that must see every value to stay correct** are not filtered, each listed with its reason in the test: merging records, reverting a load, re-resolving golden sources, and a load's quality check. The test fails when a new definer function that reads values is on neither list.
- **The screens** say "Restricted" instead of a blank (`lib/hidden-attributes.ts`, the `hiddenAttributeCodes` query), and do not offer to edit such fields.
- **The assistant** is told which fields are restricted for the person, so it says so rather than calling them missing, and does not try to work them out.

## Not covered

- **Calculations and compliance** run on every value. A calculated attribute or a compliance result built from a restricted field shows its result to anyone who can see the result. Classify the calculated attribute too where its result gives the input away.
- **Work the platform does on its own** (workflows, narratives, jobs) runs as the platform service and sees everything; its output is as visible as where it is stored.
- **Excel** shows a restricted value as blank, not "Restricted".
- **Changing a level** takes effect at once in the database. A screen already open learns it on its next load.
