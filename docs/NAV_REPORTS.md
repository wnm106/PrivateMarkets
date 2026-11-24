# NAV reconciliation from a filed report

A fund's own filing (a 10-Q, a 10-K, an annual or semi-annual report) is the administrator's NAV in its fullest form: the four primary statements, the NAV per share by class, and the schedule of investments. The NAV reconciliation workflow takes one such file from Load data to a summary of the breaks a person signs off.

The reconciliation also checks the rest of the administrator's NAV pack, part by part: the NAV bridge, trial balance, capital accounts, fees, waterfall, valuation support, calls and commitments, and FX. See [NAV_PACK.md](NAV_PACK.md).

The run needs no one until there is something only a person can decide. A report that arrives is read, matched to its fund, loaded, reconciled and summarized on its own. A person is asked for two things only: to look at a report the run could not trust (the hold reasons below), and to decide breaks and open review items. A period where everything ties ends with its notes kept and no one asked.

## Parts

| Part | Where | What it does |
|---|---|---|
| Report reader | `packages/graphql/src/lib/import-intake/financial-report.ts` | Finds the statements by their titles and the schedule by its column headings, and reads them with the cell each value came from |
| Chart rules | `supabase/migrations/20261122100000_nav_report_chart.sql` | The NAV chart's lines, and on each the report wording it takes (`navLine.match`) |
| Mapper | `packages/graphql/src/lib/nav-report-map.ts` | A report onto the chart and the fund's positions, and the plan of what a load writes |
| Load | `packages/mcp-server/src/feeds/nav-report.ts` | Reads a stored report back, and loads it through the standard loader as one batch |
| Reconciliation | `packages/graphql/src/lib/fund-rec.ts`, `fund-rec-store.ts` | The same engine every fund close uses |
| Break summary | `packages/graphql/src/lib/nav-breaks.ts` | What breaks, what is missing, what is open, with the cause, the next step and the owner |
| Tools | `packages/mcp-server/src/tools/nav-report-tools.ts` | `get_nav_report`, `load_nav_report`, `get_nav_breaks`, `save_nav_notes` |
| Screen | `apps/web/components/workflows/stages/NavReportStage.tsx` | Check a filed report (`nav.report`), only when a report is held |
| Report trigger | `supabase/migrations/20261122110000_report_trigger.sql` | A stored report starts a run (trigger source `REPORT`) |
| Page | `apps/web/components/fund-rec/FundRecWorkspace.tsx` | The Breaks tab of the fund's reconciliation |

## Reading a report

An upload in Load data that is a PDF with a text layer is first tried as a filed report. When at least a balance sheet and one other primary statement are found by their titles, the file is stored as tables and nothing is sent to LlamaParse or Azure, however long it is:

| Table | Holds |
|---|---|
| Statement of assets and liabilities, operations, changes in net assets, cash flows | One row per line: its label, the heading it sits under, and one column per period. Each column says its date and the months it covers |
| Schedule of investments, one per date | One row per investment: asset class, industry, company, footnotes, reference rate and spread, rate, maturity, currency, par, cost and fair value. Industry subtotals, class totals and the portfolio total are rows of their own |
| Checks the report makes of itself | Each industry subtotal, class total and portfolio total against the rows above it; the schedule against investments on the balance sheet; each share class's NAV per share times its shares; the classes against total net assets |
| About the report | The entity, the form, the period end and the comparative date |

What the reader handles: labels wrapped over two or three lines (with the amounts on the first line or the last), headings over two rows ("For the Six Months Ended" over "June 30, 2026"), several amounts in one run of text (`$ 2,868,101 $ 2,815,947`), company names that wrap, schedule headings stacked over three rows, and amounts printed in thousands except share counts and per-share figures. Line numbers printed in a page's margin are ignored.

A scan has no text layer, so it is not read this way.

## Mapping onto the NAV chart

Every NAV chart line carries the report wording it takes, as data on the attribute (`validation_rules.navLine`):

| Setting | Meaning |
|---|---|
| `match` | Rules tested in order: a label pattern, and optionally a heading the line must or must not sit under. A rule marked `total` takes the report's own total; the lines under it are then kept as detail |
| `fallback` | A heading pattern. A line under it that matched nothing else lands here: Other assets, Other liabilities, Other operating expenses |
| `priority` | Lower is tested first, so "Total expenses before fee waivers" is not taken for total expenses |
| `single` | Only one report line can fill it |
| `combine` | `sum` (the default) adds the lines that fill it, such as three share classes' share transactions; `equal` takes a per-share amount only when every class agrees |
| `unit` | `AMOUNT`, `SHARES` or `PER_SHARE` |

Labels are compared in lower case with "(decrease)", "(loss)" and the like taken out, and with any parenthesis that holds an amount or a note reference taken out. A line that matches nothing is listed with the reason: supplemental disclosure, share-class detail, or no chart line takes the wording. The mapper has no wording of its own; to take a new administrator's wording, add a rule to the chart line.

### Which columns load

The balance sheet loads at the period end and at the date it is compared with. The flow statements load for the span between them: a 10-Q for June compares with the last fiscal year end, so its six-month columns load, not the quarter's. The statement records the comparative date (`STATEMENT_COMPARATIVE_DATE`), and the reconciliation compares the period with that date instead of the previous quarter end.

### What a load writes

All as the administrator's figures (`FUND_ADMIN`), through the loader every file uses, as one batch that Load data can revert:

- The fund's NAV statement record (its existing one, or `<fund code>-STMT`): every mapped line at the period end and at the comparative date, the period end, the comparative date, the received date, a label, and the report's own checks (`STATEMENT_SOURCE_CHECKS`: every check that does not tie, and the headline totals).
- One position per investment in the schedule at the period end, linked to the fund: its type, par, cost, fair value, coupon, currency, and the schedule's date (`METRIC_DATE`). The type is the broad one on the position type list (Debt, Equity): the schedule's asset class ("First Lien Debt", "Common Stocks") is a synonym on that list. A class the list does not take holds the report, with the wording to add. A position's code is the fund code, the company, and a short hash of its class, maturity and spread, so the same tranche gets the same code next quarter.

Loading the same report again changes nothing already on file.

## The reconciliation

The reconciliation is the one every fund close gets. What a filed report needed from it, all decided from data:

| | |
|---|---|
| Comparative date | Prior figures are read at the statement's comparative date when it has one. Fees and annualized ratios use the months between |
| Statement footing | Assets, liabilities and capital lines each add up to their total. Only lines with a figure count |
| Net assets roll | A statement that prints its total change rolls on it, and operations plus distributions plus share or capital transactions must equal that change |
| Investments roll | Uses capitalized PIK from the cash flow statement when it has it, and accretion of discount |
| Cash | Opening cash plus the net change plus the effect of exchange rates |
| Schedule | The administrator's positions dated the period end add up to investments on the balance sheet |
| The report's own checks | Each that fails is a break with both figures; the readiness list says how many tie |
| Capital model (`FUND_CAPITAL_MODEL`) | `EVERGREEN` funds issue and repurchase shares, so contributions are not tied to call notices |
| Management fee basis (`FUND_MGMT_FEE_BASIS`) | `COMMITMENTS`, or `NET_ASSETS` or `TOTAL_ASSETS` averaged over the span |
| Performance fee basis (`FUND_PERF_FEE_BASIS`) | `WATERFALL` (carried interest), or `INCOME`: the carry rate on pre-incentive net investment income over the preferred return as a hurdle on opening net assets, with the catch-up. Pre-incentive income is before the incentive fee and before class distribution and servicing fees |

Lines of the chart with no figure are not shown, so a partnership's pack and a BDC's 10-Q each show only their own. Working capital lines whose move the cash flow statement accounts for (unsettled trades, accrued liabilities) are not flagged as unexplained drift when they tie to it.

### Large funds

A schedule brings hundreds of positions. The readers behind the reconciliation now read ids in batches of 100 and page through results, because PostgREST returns at most 1,000 rows a request without saying there were more (`packages/graphql/src/lib/read-batches.ts`).

## The break summary

`summarizeBreaks` reads the reconciliation and lists, in order: checks that break, review items still open, checks that cannot be made because a figure is missing, and inputs not on file. Each has both figures, the difference, the usual cause, what settles it, who does that, and whether it blocks certification. The `get_nav_breaks` tool returns it with a markdown version, and the Breaks tab of the fund's reconciliation page shows the same summary and publishes it to the assistant.

## The workflow

Template `NAV_RECONCILIATION`. A trigger starts it (below), or a person starts it with the stored file:

```json
{ "importInstanceId": "<stored file id>", "periodEnd": "" }
```

Records are optional. The fund comes from the report: the entity name it gives is matched to a fund's name or one of its aliases, ignoring case, punctuation and "&" against "and". A fund the run was started on, or one given as `fundId`, wins over the name.

| Step | Kind | What it does |
|---|---|---|
| Select records | Fixed | The fund, when the run was started on one |
| Read the report | Fixed | `get_nav_report`: the fund, how the report maps, a trial load, and whether anything holds it (`autoLoad`) |
| Can it load on its own? | Fixed | Goes straight to the load when nothing holds the report |
| Check the report | Stage | `nav.report`, only for a held report: why it was held, the fund to choose, the mapping, the report's own checks, the lines left out, the schedule and a trial load. Confirming loads it as checked by that person |
| Load the report | Fixed | `load_nav_report`. Refuses a held report no one confirmed |
| Review the NAV | Fixed | `get_nav_breaks` |
| Keep the summary | Fixed | `save_nav_notes`: the summary as the period's reconciliation notes, written from the reconciliation, not by a model. Refused on a certified period |
| Anything to decide? | Fixed | Ends the run when nothing breaks and no review item is open |
| Explain the breaks | Agent | Explains each break, proposes a decision or a query for each open item |
| Decide the breaks | Human | Approve, edit or reject each decision and the notes |
| Record the outcome | Fixed | Applies what was approved |
| Where the NAV stands now | Fixed | `get_nav_breaks` again |

No step signs off or certifies.

### When a report is held

A report loads on its own unless one of these is true. Each is a reason a load could be wrong without anyone seeing it:

| Hold | Why a person is needed |
|---|---|
| No fund, or more than one, has the report's name | Which fund's books it goes on. Adding the name as an alias of the fund lets the next report find it |
| A statement has no column for the period, or the flow statements do not span to the date the balance sheet is compared with | The figures would load at the wrong dates |
| Nothing maps at the period end | The report was not read |
| One of the report's own subtotals or totals does not add up | The report may have been read wrong |
| A line of a primary statement has no place on the chart | A figure would be left out. Supplemental disclosures, share-class detail and blank lines do not hold |
| The trial load refuses a record, matches one to more than one stored record, or changes a figure already on file for the period | A restatement, or a collision, someone should see before it is written |
| A value is not on its list or names no record, so it would be stored as typed | The list needs the wording as a synonym, or the value is wrong. The hold names the values |

The reasons are in the run's step output and at the top of the screen, and confirming records who checked them.

### Starting on its own

A stored file read as a filed report (by upload, feed or email) records a `REPORT_RECEIVED` event with the entity, the form and the period end. A workflow trigger with source `REPORT` ("A filed report arrives") starts one run for each such report, given as `importInstanceId`. Its match lists entity names (`{ "entityNames": ["OHA SELECT"] }`), each matched anywhere in the name the report gives; an empty list takes every report. As with every trigger, the next report waits while a run is open.

### Setting up a fund

The fund needs a close calendar (`FUND_CLOSE_FREQUENCY`, `FUND_CLOSE_LAG_DAYS`) to have a reconciliation. For fee recalculation it needs its terms: the management fee rate and basis, and for a performance fee the rate (`FUND_CARRY_PCT`), the hurdle (`FUND_PREF_RETURN_PCT`), the catch-up and the basis. An evergreen fund or BDC sets `FUND_CAPITAL_MODEL` to `EVERGREEN`.

### Turning it on for a client

1. Publish the workflow: `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/publish-file-intake.mts <client code> NAV_RECONCILIATION`. Running it again publishes the template's latest version.
2. On the workflow's page, under **Start automatically**, add a trigger with source "A filed report arrives". Leave the names blank to take every report: a report whose fund is not on file waits for a person to choose it.
3. Give each fund its close calendar and terms (above), dated from the fund's start so the reconciliation reads them at every period end.
4. Keep a job worker running (`docs/JOBS.md`). The "Explain the breaks" agent step needs `ANTHROPIC_API_KEY` where the worker runs. Without it, the step fails after the load, the reconciliation and the notes are done, and Retry on the run page continues from it once the key is set.

## Not built yet

- Loading the per-class net assets, shares and NAV per share as records of their own. They are checked when the report is read, and the fund's total shares and its NAV per share (when every class agrees) load onto the statement.
- Loading the prior period's schedule of investments. It is read and checked, not loaded.
- Ending a position that has left the schedule. The schedule check counts only positions dated the period end.
- Fund terms from the report's notes. They are set on the fund record.
- Creating the fund from a report that names none on file. The run holds and a person chooses it.
- Matching the report's investments to positions already in our own book under other codes.
- Keeping the lien or seniority of each investment. A position has only its broad type; the full asset class stays in the stored report's schedule. Lien priority is a field of a security record, which the load does not create.
