# Excel add-in: `=TAP`

`=TAP(attribute, record, [as_of])` puts one attribute of one Tapestry record into a cell, as of a date. Each person signs in with their own Tapestry account, and a formula shows only what that account can see.

```
=TAP("NAV", "FUND-1")
=TAP("Ending NAV", "Apex Fund II", DATE(2026, 9, 30))
=TAP("MATURITY_DATE", B4, $B$1)
```

The Tapestry pane has a formula builder. It searches attributes first, then records, then takes an optional as-of date, previews the value, and inserts the formula into the selected cell.

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
| Exact matching for a cell's references | `supabase/migrations/20261121150000_excel_tap_matches.sql` |

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

## Deploying

1. Apply `20261121150000_excel_tap_matches.sql` to the hosted project before the web app that calls it is deployed (docs/MIGRATIONS.md). It only adds two functions.
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
- **Ranges.** One cell asks for one value. A spilled array of attributes across records (for example a column of funds by a row of fields) is the natural next function.
- **1904 dates.** A workbook on the 1904 date system passes date cells four years off. Use `"YYYY-MM-DD"` text there.
- **Microsoft single sign-on inside Office.** Sign-in uses the dialog. Office's own SSO (`getAccessToken`) could skip it for organizations on Microsoft Entra ID.
- **Step-up on bearer requests.** The connect page will not hand over a session that still owes an authenticator step, and refreshing keeps the session's level. `/api/graphql` itself does not check `current_sign_in_decision` for bearer tokens; that is true for every API client today, not only Excel.
