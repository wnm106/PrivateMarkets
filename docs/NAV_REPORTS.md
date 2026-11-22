# NAV reconciliation from a filed report

A fund's own filing (a 10-Q, a 10-K, an annual or semi-annual report) is the administrator's NAV in its fullest form: the four primary statements, the NAV per share by class, and the schedule of investments. The NAV reconciliation workflow takes one such file from Load data to a summary of the breaks a person signs off.

## Parts

| Part | Where | What it does |
|---|---|---|
| Report reader | `packages/graphql/src/lib/import-intake/financial-report.ts` | Finds the statements by their titles and the schedule by its column headings, and reads them with the cell each value came from |
| Chart rules | `supabase/migrations/20261122100000_nav_report_chart.sql` | The NAV chart's lines, and on each the report wording it takes (`navLine.match`) |
| Mapper | `packages/graphql/src/lib/nav-report-map.ts` | A report onto the chart and the fund's positions, and the plan of what a load writes |
| Load | `packages/mcp-server/src/feeds/nav-report.ts` | Reads a stored report back, and loads it through the standard loader as one batch |
| Reconciliation | `packages/graphql/src/lib/fund-rec.ts`, `fund-rec-store.ts` | The same engine every fund close uses |
| Break summary | `packages/graphql/src/lib/nav-breaks.ts` | What breaks, what is missing, what is open, with the cause, the next step and the owner |
| Tools | `packages/mcp-server/src/tools/nav-report-tools.ts` | `get_nav_report`, `load_nav_report`, `get_nav_breaks` |
| Screen | `apps/web/components/workflows/stages/NavReportStage.tsx` | Check a filed report (`nav.report`) |
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
- One position per investment in the schedule at the period end, linked to the fund: asset class, par, cost, fair value, coupon, currency, and the schedule's date (`METRIC_DATE`). A position's code is the fund code, the company, and a short hash of its class, maturity and spread, so the same tranche gets the same code next quarter.

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

Template `NAV_RECONCILIATION`. Start it with the fund and the stored file:

```json
{ "filters": { "entityCodes": ["<fund code>"] }, "importInstanceId": "<stored file id>", "periodEnd": "" }
```

| Step | Kind | What it does |
|---|---|---|
| Select records | Fixed | The fund |
| Read the report | Fixed | `get_nav_report`: what the report holds and how it maps |
| Check the report | Stage | `nav.report`: the report beside the mapping, the report's own checks, the lines left out, the schedule and a trial load. Confirming needs the report to map at its period end |
| Load the report | Fixed | `load_nav_report` |
| Review the NAV | Fixed | `get_nav_breaks` |
| Anything breaks or open? | Fixed | Ends the run with the summary when nothing does |
| Explain the breaks | Agent | Explains each break, proposes a decision or a query for each open item, and writes the notes |
| Review the breaks | Human | Approve, edit or reject each decision and the notes |
| Record the outcome | Fixed | Applies what was approved |
| Where the NAV stands now | Fixed | `get_nav_breaks` again |

No step signs off or certifies.

### Setting up a fund

The fund needs a close calendar (`FUND_CLOSE_FREQUENCY`, `FUND_CLOSE_LAG_DAYS`) to have a reconciliation. For fee recalculation it needs its terms: the management fee rate and basis, and for a performance fee the rate (`FUND_CARRY_PCT`), the hurdle (`FUND_PREF_RETURN_PCT`), the catch-up and the basis. An evergreen fund or BDC sets `FUND_CAPITAL_MODEL` to `EVERGREEN`.

## Not built yet

- Loading the per-class net assets, shares and NAV per share as records of their own. They are checked when the report is read, and the fund's total shares and its NAV per share (when every class agrees) load onto the statement.
- Loading the prior period's schedule of investments. It is read and checked, not loaded.
- Ending a position that has left the schedule. The schedule check counts only positions dated the period end.
- Fund terms from the report's notes. They are set on the fund record.
- Matching the report's investments to positions already in our own book under other codes.
