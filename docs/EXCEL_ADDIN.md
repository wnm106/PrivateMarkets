# Excel add-in: `=TAP`

`=TAP(attribute, record, [as_of])` puts one attribute of one Tapestry record into a cell, as of a date. Each person signs in with their own Tapestry account, and a formula shows only what that account can see.

```
=TAP("NAV", "FUND-1")
=TAP("Ending NAV", "Apex Fund II", DATE(2026, 9, 30))
=TAP("MATURITY_DATE", B4, $B$1)
```

The Tapestry pane has a formula builder. It searches attributes first, then records, then takes an optional as-of date, previews the value, and inserts the formula into the selected cell.

The pane can also save new values as manual entries, the same as a manual override on the record screen. Formulas only read; writing is always an action someone takes in the pane.

The pane also brings whole tables into the workbook: the records of one entity type, with the columns you choose, filtered on the way in. A filter can point at a cell, and changing that cell refreshes the table ([Synced tables](#synced-tables)).

## The pieces

| Piece | Where |
| --- | --- |
| Add-in source: custom function, pane, sign-in, manifest template | `apps/excel-addin/` |
| Built add-in, served by the web app at `/excel/addin/` | `apps/web/public/excel/addin/` (generated, not committed) |
| Excel sign-in page | `apps/web/app/excel/connect/page.tsx`, `apps/web/components/excel/ExcelConnect.tsx` |
| Separate Excel session store | `apps/web/lib/session-store.ts`, `apps/web/lib/supabase-browser.ts`, `apps/web/app/auth/callback/route.ts` |
| Sign-in form and authenticator step shared with `/login` | `apps/web/components/auth/SignInForm.tsx`, `apps/web/components/auth/MfaStep.tsx` |
| The session message between the page and the add-in | `packages/graphql/src/lib/excel-session.ts` |
| `tapValues` and `searchAttributes` queries | `packages/graphql/src/resolvers/excel.ts`, `packages/graphql/src/lib/tap.ts`, `packages/graphql/src/lib/attribute-search.ts` |
| Exact matching for a cell's references | `supabase/migrations/20261121150100_excel_tap_matches.sql` |
| Manual entries from Excel: preview and save | `packages/graphql/src/lib/tap-override.ts`, `tapOverridePreview` and `submitTapOverrides` in `resolvers/excel.ts` |
| The one manual-override writer (record screen, chat, workflows, Excel) | `packages/graphql/src/lib/source-write.ts` |
| Reading a value as an attribute stores it (loads and overrides) | `packages/graphql/src/lib/attribute-values.ts` |
| The Override values panel | `apps/excel-addin/src/ui/overrides.ts`, `apps/excel-addin/src/lib/overrides.ts` |
| Synced tables: filters, the query, refresh plans (pure, tested) | `apps/excel-addin/src/lib/tables.ts` |
| Synced tables: reading filter cells, writing the Excel table, the saved definitions | `apps/excel-addin/src/office/tables.ts` |
| Synced tables: refreshing and auto-refresh | `apps/excel-addin/src/office/table-sync.ts` |
| The Tables panel | `apps/excel-addin/src/ui/tables.ts` |
| The rows a table reads (`gridQuery`, the same query as the app's grids) | `packages/graphql/src/resolvers/reporting.ts`, `public.report_grid` |

## The function

Excel custom functions always carry a namespace, so the function is `TAPESTRY.TAP`. The add-in adds a workbook name `TAP`, a `LAMBDA` that calls it, so people can write `=TAP(...)`:

```
=LAMBDA(attribute, entity, [as_of], TAPESTRY.TAP(attribute, entity, IF(ISOMITTED(as_of), "", as_of)))
```

The name is added when the person signs in, opens the pane while signed in, or inserts a formula. It is never added silently on open, so opening a workbook does not mark it changed. A `TAP` name the workbook already uses for something else is left alone, and the builder then writes `=TAPESTRY.TAP(...)`. `LAMBDA` names need Excel for Microsoft 365. Both forms work wherever the add-in is installed. A workbook opened without the add-in shows `#NAME?`.

### Arguments

| Argument | Accepts | Matched against |
| --- | --- | --- |
| `attribute` | Text or a cell | The attribute's code, then an active alias (`attribute_aliases`), then its name. `ENTITY_NAME` and `ENTITY_CODE` are the record's own name and code. |
| `record` | Text or a cell | The record's code, then its name, then another stored name (`entity_aliases`). Only active records. |
| `as_of` | A date cell, `DATE()`, `"YYYY-MM-DD"`, `"YYYY/M/D"`, `"YYYYMMDD"`, or blank | Blank is today. `"09/30/2026"` is refused rather than guessing day and month. |

Matching ignores case and the spaces around the words. It is otherwise exact: a cell never lands on a record whose name only contains the words. Search belongs in the builder, not in a formula.

When a reference matches more than one thing:

1. A record code always means that record.
2. Then a pair whose entity type carries the attribute wins. Two records called "Apex", a fund and an issuer, give `NAV` from the fund.
3. Then the closer attribute match (code, alias, name), then the closer record match (code, name, alias).
4. A tie is ambiguous. The cell shows `#N/A` and lists the codes to use.

### Values

The value is the winning value the record screen shows: `golden_master.winning_attribute_values` at the as-of date and the current knowledge time, then the on-read calculation when nothing is stored and the attribute has one (`on_read_attribute_values`). The record screen and `=TAP` read through the same `loadWinningValues` (`packages/graphql/src/lib/temporal-attributes.ts`).

| Data type | In the cell |
| --- | --- |
| `NUMBER`, `INTEGER`, `CURRENCY`, `PERCENTAGE` | A number. A percentage is the stored number, so 0.075 stays 0.075. |
| `BOOLEAN` | TRUE or FALSE |
| `DATE` | Text, `YYYY-MM-DD`. Excel still uses it in date arithmetic; `DATEVALUE()` turns it into a date serial. |
| Everything else | Text |

### Errors

| Cell | Means |
| --- | --- |
| `#N/A` "Sign in to Tapestry…" | No session in this Excel. Open the pane and sign in. |
| `#N/A` | No attribute or record matched, more than one matched, or the record has no value on that date. The tooltip says which. |
| `#VALUE!` | A missing attribute or record, or an as-of that is not a date. |

### Requests

Excel calls the function once per cell. Calls that arrive within 40 ms of the first one go to the server as one `tapValues` request of up to 200, and the same attribute, record and date in many cells is asked once. The server takes at most 500 per request.

## Sign-in by person

Every person signs in with their own account. There is no shared key.

1. The pane opens `/excel/connect` in an Office dialog.
2. The page signs the person in with the same form as `/login`: email discovery, then password or the single sign-on their organization requires. The access-token hook applies the organization's sign-in rules as it does for the app.
3. The page checks `tenancy.current_sign_in_decision`, as middleware does for the app. A refused method ends there. When the organization requires an authenticator, the page runs the step-up before going on.
4. The person confirms "Connect Excel". The page sends the session to the add-in with Office's `messageParent`, which Office delivers only to an add-in page on the same origin. The add-in also checks the origin and the message's shape.
5. The page forgets the session (removes its cookies without revoking it). From then on the add-in is its only holder.

The add-in calls `/api/graphql` with `Authorization: Bearer <token>` and never sends cookies. The route builds its Supabase client from that token, so Row Level Security decides what each person sees, exactly as in the app.

### Why Excel gets its own session

Supabase rotates refresh tokens. When two places hold the same session, the first refresh retires the token the other one holds, and its next refresh is treated as a stolen token: the whole session is revoked, signing out both. So Excel never shares the browser's app session:

- The Excel sign-in keeps its session in its own cookie, `sb-<project>-excel-auth-token` (`lib/session-store.ts`). Middleware reads and refreshes only the app's cookie, so it never touches this one.
- A single sign-on round trip carries the choice in the `tapestr-session-store` cookie, so `/auth/callback` writes the session to the Excel cookie and returns to `/excel/connect`.
- Signing in for Excel in a browser that is already signed in to the app leaves the app session as it was.

### Keeping and ending the session

- The add-in keeps the session in its own `localStorage` and refreshes it with Supabase Auth a minute before it expires. Two open workbooks share it, and each reads storage before refreshing, so one sees the other's refresh.
- A refresh the server refuses (revoked, expired, or the organization's rules changed) signs Excel out. TAP cells then show the sign-in message.
- **Sign out** in the pane revokes the Excel session only (`/auth/v1/logout?scope=local`). Signing out of the app in a browser does not sign Excel out, and the other way round.

## Manual entries from Excel

Saving a value from Excel is the same as a manual override on the record screen. The value is stored under the Manual Entry source with a reason and the person who saved it. From its date it wins over every other source until it is cleared in Tapestry, or until a later manual entry replaces it.

### Why a formula never writes

Excel decides when a formula runs: on open, when a cell it depends on changes, on a full recalculation, on fill-down, paste and undo. A formula that wrote would save the same value again and again, at moments nobody chose. A workbook passed around would also write under the account of whoever opened it. So `=TAP` only reads, and there is no writing function. Writes happen in the pane, when the person asks.

### In the pane

1. Select cells that hold TAP formulas and choose **Override selected cells** (up to 50 at a time). The pane reads each formula to know the attribute, record and date. Arguments can be text or plain cell references, including references to other sheets. A cell whose arguments are other expressions is listed with the reason it cannot be read.
2. Type the new values. Each row's date is the formula's as-of, or today, and can be changed. Rows left blank are skipped.
3. **Check** runs `tapOverridePreview`. Nothing is written. Each row says what would happen:

   | Status | Means |
   | --- | --- |
   | Will be saved (`READY`) | The value is new and you can change the record |
   | Unchanged (`UNCHANGED`) | It is already this value. It is skipped, so a value another source supplies is not pinned as a manual entry by accident |
   | Changed since you checked (`STALE`) | The record's value changed between Check and Save. Check again |
   | Not a valid value (`INVALID_VALUE`) | The value does not fit the attribute's type |
   | Not editable (`NOT_EDITABLE`) | The attribute is marked not editable, or it is the record's own code or name |
   | You cannot change this record (`NO_ACCESS`) | You do not have write access to it |
   | Not found, or more than one match | As for `=TAP` |

4. Give a reason, then **Save**. `submitTapOverrides` checks every row again, writes only the ready ones, and returns each outcome. The pane then recalculates, so the TAP cells show what was saved.

### Rules the save follows

- **One writer.** The record screen (`submitManualOverride`), chat and workflow steps (`submit_manual_override`), and Excel all write through `writeManualOverride` in `lib/source-write.ts`.
- **Typed like a load.** A value is read the way a file load reads it (`lib/attribute-values.ts`): `1,250,000.50` is stored as the number 1250000.5, `7.5%` as 0.075, and `9/30/2026` as the date 2026-09-30. A value that does not fit the type is refused.
- **Versioned, not replaced.** A new manual entry versions the Manual Entry source from its date. An earlier manual entry keeps its own period, and one already scheduled later stays. Nothing is edited in place; the old version is closed in knowledge time, so an earlier Knowledge date still shows what was believed then.
- **A later row is saved when an earlier one would carry over.** Say one save sets NAV from 30 September to 1,100 and from 31 December to 1,000, and 1,000 is already the 31 December value. The 31 December row is still saved, because otherwise the 30 September entry would carry over to it.
- **Calculations follow.** After a save, the record's calculations are refreshed, as they are after any source change.
- **Each person's own access.** Each write runs as the person. Row security admits a write only on a record they have write access to (`tenancy.has_entity_access(..., 'WRITE')`): a member of another client, or a viewer, is refused by the database itself. The preview checks the same thing first so it can say so.
- **Sign-in rules apply to writes.** A save checks `tenancy.current_sign_in_decision` for the caller's token, as middleware does for the app. If the organization requires an authenticator step that the session has not met, nothing is written.

### Changes this made to manual overrides everywhere

Because the record screen, chat and workflows share the writer, they changed too:

- A new manual entry used to close the record's open manual entry completely, losing the earlier entry's period. It now versions it, as described above.
- Values are now typed. Before, they were stored as text only, without the typed number and date columns loads fill, and a value of the wrong type was accepted.
- Calculations are now refreshed after a manual override. Before, only `addCompetingSource` refreshed them.

## Synced tables

A synced table is an ordinary Excel table that Tapestry fills: the records of one entity type, one row each, with the columns you choose. Filters are applied by Tapestry before anything is sent, so a table holds only the records you asked for, not the whole database.

### Making one

1. Select an empty cell with room below and to the right. In **Tables**, choose **New table**.
2. **Records of**: the entity type, such as Fund.
3. **Columns**: Code and Name always come first. Search for attributes to add more.
4. **Filters**: a field, a test, and a value. The value is either typed or points at cells:

   | Value | Means |
   | --- | --- |
   | `2020`, `Buyout`, `2026-09-30`, `7.5%` | Typed, read as the field's type |
   | `FUND-1, FUND-2` or `2026-01-01; 2026-12-31` | A list, for *is one of*, *is not one of* and *between*. Separate with commas, semicolons or new lines |
   | `=B2`, `=Inputs!B2`, `='Q3 inputs'!$B$2` | The value of that cell. Without a sheet it means the table's own sheet. **Cell** fills in the selected cell |
   | `=Inputs!B2:B20` | The values in a range, as a list. Blank cells are skipped |
   | blank, or a blank cell | No filter. Clearing a filter cell widens the table rather than emptying it |

   Only text that starts with `=` is a reference, so a code such as `AB12` is still a code. A filter can name a field that is not one of the columns.
5. **As of**: blank for today, a date, or a cell such as `=B1`.
6. **Sort**, and **Refresh when a filter cell changes** (on unless you turn it off).
7. **Insert at selected cell**. The table is named `Tapestry_<TYPE>_<n>`, so formulas can use it: `=SUM(Tapestry_FUND_1[Net asset value])`.

### What a refresh writes

- **Values with their types.** Numbers as numbers, dates as Excel dates, text as text. A new table formats text columns as text, so `00123` keeps its zeros, and dates as `yyyy-mm-dd`.
- **Your formats stay.** A refresh writes values only. Rows it adds take the format of the table's first row, column by column, so a date format you chose holds.
- **Never a formula.** Text from Tapestry that starts with `=`, `+` or `@` is written with a leading apostrophe, so a record named `=HYPERLINK(...)` shows as that text and never runs.
- **In place.** The rows the table has are overwritten, extra rows are deleted and missing rows are added. Cells below the table move up or down with it, as with any Excel table; cells beside it stay.
- **Tapestry's columns only.** Put your own columns and formulas beside the table, not inside it. If the table gains or loses a column in Excel, a refresh stops and says so rather than writing into it.
- **At most 50,000 rows.** Rows are read 2,000 at a time and written 1,000 at a time. When more records match, the first page says so, nothing more is read, the table is left as it is, and it says to narrow the filters. A new table checks for room once the first page says how many rows match.
- **Each person's own records.** Rows are read by `gridQuery` under the signed-in person's token, so row security applies exactly as in the app. A workbook passed to someone else refreshes to what that person can see.

### Auto-refresh

A table with auto-refresh on refreshes when a value it is filtered on changes:

- **An edit** to a filter cell, or to the as-of cell.
- **A recalculation** that changes one: a filter cell holding `=EOMONTH(TODAY(), -1)`, a drop-down, or a cell fed from another sheet. After Excel calculates, the add-in reads the filter cells again and refreshes only the tables whose filter values differ from their last refresh. A recalculation that changes nothing sends no query.

Quick edits do not start a refresh each: the add-in waits until changes stop for about a second, refreshes a table once at a time, and refreshes again if a filter changed during the refresh, so the last value always wins. A filter value that does not fit its field, such as text in a number filter, is shown on the table, and the table keeps its rows until the value is fixed.

While any table in a workbook has auto-refresh on, the add-in asks Excel to start it with the workbook (`Office.addin.setStartupBehavior`), so it watches from the moment the file opens. On opening, a table whose filter cells changed while the add-in was closed is refreshed; the others are left alone. When no table has auto-refresh, the add-in goes back to starting only when the pane is opened. A signed-out add-in does not refresh; tables keep their last values.

### Changing and stopping

- **Edit** changes the filters, as-of, sort or columns, then refreshes. Removed columns are deleted and new ones are added at the right, in the same Excel table, so formulas on the columns that stay keep working. The entity type cannot be changed; make a new table.
- **Refresh** and **Refresh all** refresh on request. Refresh all carries on past a table that fails, and names the ones that did.
- **Stop syncing** (click twice) forgets the definition. The table and its values stay as an ordinary Excel table.

### Where a table's definition is kept

In the workbook, as an add-in setting (`tapestry.tables` in `Office.context.document.settings`): the entity type, columns, filters and their references, as-of, sort, auto-refresh, where the table is, and a signature of the filter values at the last refresh. It travels with the file. No data from Tapestry is kept there; the values in the table are ordinary cells.

## Deploying

1. Apply `20261121150100_excel_tap_matches.sql` to the hosted project before the web app that calls it is deployed (docs/MIGRATIONS.md). It only adds two functions.
2. Deploy the web app as usual. `apps/web`'s `prebuild` builds the add-in into `public/excel/addin/`, so every deploy serves the matching add-in. The manifest's URLs come from:
   - `EXCEL_ADDIN_ORIGIN`, else `NEXT_PUBLIC_APP_URL`, else `https://localhost:3000`. It must be https.
   - `EXCEL_ADDIN_ID`, the add-in's GUID. Give staging its own so both can be installed. Production uses the default in `scripts/build.mjs`.
   - `EXCEL_ADDIN_NAME`, the name shown in Excel (default "Tapestry").
3. Validate the manifest once per change to it: `npx office-addin-manifest validate <origin>/excel/addin/manifest.xml`.
4. Install it for an organization in the Microsoft 365 admin center (Settings, Integrated apps, Upload custom apps) with the manifest URL `<origin>/excel/addin/manifest.xml`. For one person, sideload it: in Excel, Home, Add-ins, More add-ins, My add-ins, Upload my add-in.

The add-in shows on the Home tab as **Tapestry** (the pane) and **Refresh TAP** (recalculates every formula).

It needs Excel on Windows or Mac for Microsoft 365, or Excel on the web (shared runtime, requirement set `SharedRuntime 1.1`).

## Local development

Excel loads add-ins only over https, even on your own machine.

```bash
npx office-addin-dev-certs install                      # once: trusted certificate for localhost
cd apps/web
EXCEL_ADDIN_ORIGIN=https://localhost:3000 npm run dev -- --experimental-https
# Manifest: https://localhost:3000/excel/addin/manifest.xml
```

`npm run dev` builds the add-in once first. To rebuild on change, also run `npm run dev -w @tapestrai/excel-addin`. Tests: `npm exec -w @tapestrai/excel-addin -- vitest run`. Icons are drawn by `npm run icons -w @tapestrai/excel-addin`.

## Not covered yet

- **Knowledge date.** `tapValues` takes one, but the function and the pane do not offer it yet. Formulas read current knowledge.
- **Clearing a manual entry from Excel.** Clear it on the record screen. A blank value in the pane is skipped rather than read as "clear".
- **More than 50 cells at once.** The pane lists the first 50 TAP cells of a selection. Larger edits are a file load, which stages and checks a batch (docs/STAGING.md).
- **Ranges.** One cell asks for one value. A spilled array of attributes across records (for example a column of funds by a row of fields) is the natural next function. Synced tables cover the case of many records by many fields.
- **Saved views as tables.** A synced table is built from an entity type, columns and filters. Starting one from a saved view needs the saved views work merged first.
- **Knowledge date on tables.** `gridQuery` takes one; the Tables panel does not offer it yet. Tables read current knowledge.
- **Writing from a synced table.** Its cells are values, not TAP formulas, so **Override selected cells** does not read them. Change records on the record screen or with TAP cells.
- **Reordering columns.** A table whose columns are edited in an order that is not "keep these, add those at the end" is rebuilt at the same corner, which breaks formulas that refer to it. The pane only makes the in-place shape.
- **1904 dates.** A workbook on the 1904 date system passes date cells four years off. Use `"YYYY-MM-DD"` text there.
- **Microsoft single sign-on inside Office.** Sign-in uses the dialog. Office's own SSO (`getAccessToken`) could skip it for organizations on Microsoft Entra ID.
- **Step-up on bearer reads.** Excel saves check `current_sign_in_decision`. Reads through `/api/graphql` do not, for any bearer client. The connect page will not hand over a session that still owes an authenticator step, and refreshing keeps the session's level.
