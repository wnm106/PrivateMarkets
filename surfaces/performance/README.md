# Performance

One place to track firm-wide performance. Mounted at `/s/performance` for every client (curated clients get it with the Funds module, `supabase/seed/performance_surface.sql`).

| Tab | What it answers |
|---|---|
| Funds | How each fund family and each vehicle has done, gross from its positions and net to its investors, with the gross-to-net spread and the fund's reported net IRR. |
| Positions | How each measured position has done: paid in, distributed, value, IRR, MOIC, DPI. Filter by fund, sector or text. |
| Deals | How each deal has done across every fund that holds it, and in each fund. |
| Investors | How each investor has done in each fund and in total, net, from capital account statements. |
| Ad hoc | Any slice: include or leave out funds, deals and sectors, group by family, vehicle, deal, sector or position, and compare inception, LTM, YTD, QTD and any custom periods side by side. |

The period control (inception to date, last 12 months, year to date, quarter to date) applies to the first four tabs. Every figure uses the user's As Of and Knowledge dates.

## Where the figures are worked out

Nowhere in the surface. `performanceBook` (GraphQL) loads the book in `packages/graphql/src/lib/performance-store.ts` and pools it in `packages/graphql/src/lib/performance.ts`. The assistant reads the same figures from the published tabs.

- **Gross** follows `golden_master.performance_formula` exactly: a period opens with each position's `MARKET_VALUE` on its start day as money put in, keeps the `CASHFLOW_INVESTOR_AMOUNT` flows after the start through the end, and closes with `MARKET_VALUE` on the end day. MOIC is money back over money put in; IRR is the XIRR of the pooled flows. A pool of one deal's positions equals `DEAL_IRR_ITD` and `DEAL_MOIC_ITD` from `golden_master.period_returns` (checked on the live records for all 8 deals: largest difference 7e-16).
- **Net** pools quarterly capital account statements (`CAPACCT_CONTRIBUTIONS`, `CAPACCT_DISTRIBUTIONS` dated at `CAPACCT_PERIOD_END`, closing on `CAPACCT_CLOSING`).
- Each row pools its own records. Nothing is averaged.

## Decisions (asked and answered before the build, 2026-11-27)

1. Calculations live in one shared module behind a GraphQL query, not in a new database function.
2. Funds show gross and net side by side, with the reported `FUND_NET_IRR` where stored.
3. Parallel vehicles roll up into families through `FUND_PARENT`; a family row expands to its vehicles, and the firm total pools every position once.
4. "Industry" for the ad hoc filter is the issuer's `SECTOR`, falling back to `DEAL_SECTOR`.

## Left out or changed

- **No editable values.** Every figure on the surface is worked out, and the attributes it shows (vintage, strategy, reported net IRR, sector, investor type, statement balances) are corrected through the source panel that right-click opens, not edited in place.
- **Positions with nothing put in are left out of pools.** A position with a market value but no opening value and no money out in the period (its cash flows carry no investor amount, for example) would otherwise show its whole value as profit; on the live records it lifted the firm's gross ITD multiple from 1.19x to 3.09x. Each figure counts what it left out (`excluded`), and the ribbon's Measured figure says how many. `golden_master.performance_formula` does not do this; a deal mixing such a position with funded ones would read higher in `DEAL_MOIC_ITD` than here. None of the 8 live deals does today.
- **Positions with no cash flow and no deal tranche are not measured** (29,611 on the live records, mostly CLO and BDC holdings with marks only). They are counted, not listed.
- **Net figures are left out under a deal or sector filter**, because capital accounts are held by fund. The Ad hoc tab and the Investors tab say so.
- **Investor contributions and distributions are dated at the statement's quarter end.** The statements carry no flow dates of their own.
- **Deals are gross only.** No capital account is held by deal.
- No Surface Builder handoff folder exists for this surface (it was built from the request, not a prototype), so there are no view counts to check bindings against; `acceptance.js` runs with no minimum bound count.
