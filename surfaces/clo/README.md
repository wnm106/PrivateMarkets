# CLO Manager

Every CLO vehicle in one place. Mounted at `/s/clo` for every client. A fund is a CLO when it has a CLO transaction record (`FUND_CLO_TRANSACTION`), the same test the CLO rule library scopes its rules by.

| Tab | What it answers |
|---|---|
| Vehicles | Every CLO side by side: size, phase, WARF, WAS, WAL, WARR, diversity, CCC, the most junior OC cushion, breaches, next payment. Select a row to open that CLO. |
| Indenture | The open CLO's indenture terms (every `CLO_TRANSACTION` attribute, grouped by its register section), and every test the engine scores, breaches first. Select a test for its drill-down: the engine's numerator, denominator, limit and its source, the note classes it covers, and the holdings it reads. |
| Collateral | Every holding with rating, factor, spread, price, maturity, lien and flags, with filters; and splits by Moody's industry (with each industry's diversity score), rating, maturity year and obligor. |
| KPIs | WARF, WAS, WAL, WARR, CCC, diversity, and OC and IC for each class, each against its limit with its cushion; and the same measures across every CLO. |
| Drift | The open CLO scored at each of the last eight quarter ends and at the As Of date: a trend per measure with its limit line, the change (signed so positive is better), the dates in breach, and a by-date table with collateral, notes, CCC and waterfall figures. |
| Liabilities & waterfall | The capital structure (par, share, attachment, spread, coupon, ratings, OC and IC triggers and results per class), the trustee accounts, and the next payment date's interest and principal waterfall. |
| Opportunities | Every loan offered in the market that the open CLO does not hold, scored as a buy by the engine's pro forma and ranked by how much it improves the CLO; each can be sized with the capacity solver. |

Every tab is published to the assistant, open or not (`src/lib/publish.ts`). Drift loads after the book for the open CLO. Opportunities is costly (one pro forma per offered loan, about 30 seconds for 30 loans), so it is scored when its tab is first opened. Until then it publishes a note saying so.

## Where the figures are worked out

Nowhere in the surface. Three GraphQL queries, all with the user's As Of and Knowledge dates:

- **`cloBook(fundIds)`**: `packages/graphql/src/lib/clo-book-store.ts` loads each CLO through the shared readers. Its tests come from the compliance engine (`compliance.proforma_snapshot`, the same evaluator the compliance screens and pre-trade use). `packages/graphql/src/lib/clo-book.ts` adds the three figures the engine does not hold:
  - the **Moody's diversity score**, from performing par by obligor group and the `MOODYS_DIVERSITY_TABLE` reference list;
  - the **waterfall**, from interest due on each class, the fees and senior expenses on the indenture, and the engine's coverage tests;
  - the **deal phase**, from the indenture dates.
- **`cloDrift(fundId, quarters)`**: the same book and engine at each quarter end.
- **`cloOpportunities(fundId)`**: each offered loan (`CLO_MARKET_STATUS = OFFERED`) bought at a ticket through `compliance.evaluate_proforma`, plus the diversity score with the loan added. **Largest buy** calls the existing `investmentCapacity` query (`compliance-capacity.ts`).

The surface tells tests apart by the rule's own data, never by rule code. Its limit line names a note trigger (OC or IC) and a seniority rank. Its weighted-average line names the rating factor (WARF), spread (WAS), maturity (WAL) or recovery rate (WARR). A numerator filter on `CLO_IS_CCC` marks the CCC bucket.

## Decisions (asked and answered before the build, 2026-11-27)

1. **Data:** seed sample CLOs with quarterly history (`supabase/seed/clo_book.sql`), flagged `cloBookSample` so they can be removed.
2. **Where the new calculations run:** one shared GraphQL module (`clo-book.ts`), not a new database function. Tests stay in the compliance engine.
3. **Opportunities:** a seeded loan market of 30 rated, unheld loans, scored by the engine's pro forma and the capacity solver.
4. **Editing:** read-only. Every value opens its sources on right-click, and corrections go through the source panel.

## Platform changes this needed

- **`supabase/migrations/20261127120000_blank_fund_row_reads_limit_line.sql`**: a fund is scored on a fund rule only with its own `rule_thresholds` row. A blank row is meant to enroll the fund at its own limit, but `resolve_threshold` returned blank limits for rules that read their limit from a LIMIT measure line or a `limit_term`. The CLO rules all work that way, so every CLO test came back NO_DATA. The function now counts those as the fund's limit attribute. On the hosted project, no enrolled row is blank on such a rule, so no current result changes. Capacity parity (`npm run test:db`) agrees with the evaluator after the change.
- **Attributes (seed):** `CLO_COLLATERAL_MANAGER`, `CLO_TRUSTEE`, `CLO_SENIOR_MGMT_FEE_BPS`, `CLO_SUB_MGMT_FEE_BPS`, `CLO_BENCHMARK_RATE_PCT` on CLO_TRANSACTION. `CLO_MARKET_STATUS`, `CLO_OFFER_PRICE`, `CLO_OFFER_SIZE` on SECURITY. Reference lists `CLO_MARKET_STATUS` and `MOODYS_DIVERSITY_TABLE`.
- **Enrollment (seed):** every CLO fund of the sample client is enrolled in every CLO rule, the rule-library sample (`CLOS-FUND`) included. The rows are blank where the indenture holds the limit, and carry the rule's own number for the eligibility counts.
- **Module (seed):** the `clo` surface and the three CLO record types join the Funds module, so a curated client with Funds can open the surface once its modules are saved again (the same pattern as `supabase/seed/performance_surface.sql`).
- `performance-store.ts` now exports its shared read helpers (`walk`, `neighbours`, `values`, `defsFor`, `inChunks`), so the CLO store reuses them rather than copying them.

## Left out or changed

- **No Surface Builder handoff folder.** The surface was built from the request, with the Surface Builder's standards and process as the guide: the questions were asked first, the tabs are published, every value is bound and acceptance was measured. With no `views/`, there are no view counts to check bindings against, so `acceptance.js` runs with no minimum bound count.
- **Waterfall is simplified.** It does not model the reinvestment OC test, the incentive fee and its hurdle, caps on senior expenses, or interest reserve and smoothing accounts. An IC cure is sized as the share of covered par whose interest must go. Interest collections are each holding's expected interest for the period (`CLO_EXPECTED_INTEREST`), not the trustee's collection account. The tab says all of this.
- **Diversity score uses the classic Moody's table**, 0 to 10 units by industry, interpolated, and held at 4.0 above 10. Replace the `MOODYS_DIVERSITY_TABLE` rows with the indenture's own table where it differs. The diversity minimum is tested here, not by a compliance rule: the rule library has no diversity rule yet.
- **Pro forma buys add par without spending cash.** `evaluate_proforma` adds the bought loan's par and does not debit the principal account, so an OC improvement from a buy is overstated by the cash it would use. The ranking is a proposal; buying goes through the allocation and pre-trade flow.
- **Largest buy carries no expected interest.** The capacity probe has the offer price but no interest, so IC tests read it as earning nothing (the cautious side).
- **The drift tab shows the open CLO only**, not every CLO at once: each CLO costs nine engine snapshots, about eight seconds. Switching CLO loads its history.
- **Opportunities are capped at 40 offered loans per CLO** (60 at most through the query), because each is a pro forma.
- **No write-back.** Indenture terms and note figures are read-only by decision 4.
- **Sample data only.** On the hosted project there is one CLO (the rule-library sample) and it is not enrolled in the CLO rules, so the surface needs the migration and `supabase/seed/clo_book.sql` applied there to show anything. Neither has been applied to the hosted project.

## Acceptance (2026-11-27, local stack with the seed applied)

`acceptance.js` passed on every tab at 1440x900 and 1920x1080: every figure answers right-click, nothing is clipped or cut off, no text is below 12px, there are no rows of empty boxes, tall tables keep their header, each class is defined once, and the page never scrolls sideways. Right-click on a bound value opened the host's Sources panel for that record and attribute; right-click on a derived figure opened its "how this is worked out" panel.
