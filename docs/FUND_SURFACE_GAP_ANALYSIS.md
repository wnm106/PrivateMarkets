# Fund surface: gap analysis

Source: the Halyard Senior Credit Fund II fund overview (NAV, capital pacing, capital activity, NAV statement review, returns, liquidity, investors, exposure), mapped against the common backend the same way as the deal allocation surface.

The mock keeps every figure in page script. The surface reads registered entities and writes edits back through `updateEntity`, which is how the deal surface saves a pricing term or a hold. Ratios that are arithmetic on those facts (called capital, TVPI, variance, coverage, exposure share) are assembled when the surface loads. They are not a second stored copy.

## What already existed

| Mockup concept | Existing model | Gap |
|---|---|---|
| Fund, NAV, cash | `FUND`, `NAV`, `FUND_CASH_BALANCE` | No vintage, commitments, reporting date, IRR bridge, pacing target, or concentration defaults |
| Holdings | `POSITION` → `FUND` / `SECURITY` → `ISSUER` | No cost, income, realized gain, gross IRR, admin mark, agent mark, coupon, leverage, floating flag, or position strategy |
| Investor list page | Route expects `INVESTOR` | Domain was never registered |
| Position cash events | `CASH_FLOW` via `POSITION_CASHFLOW` | Fund-level calls and distributions are not position coupons |

`FUND_UNDRAWN_COMMITMENTS` stays the liquidity snapshot used by deal allocation. Called and unfunded on this surface are the sum of capital activity, so a call edit moves the ribbon without a second manual balance.

## What was missing, and how it is registered

| Domain | What it is | Relationships |
|---|---|---|
| `INVESTOR` | Limited partner or the GP | |
| `INVESTOR_COMMITMENT` | Intersection of an investor and a fund: commitment, status, amount past due. Called, distributed, and NAV are the fund totals allocated pro rata | `COMMITMENT_INVESTOR`, `COMMITMENT_FUND` |
| `CAPITAL_ACTIVITY` | One call or distribution: date, kind, amount, status, amount still outstanding, notice | `ACTIVITY_FUND` |
| `CAPITAL_PLAN` | One quarter of the deployment plan: plan percent called, quarter-end NAV, projected call | `PLAN_FUND` |
| `NAV_STATEMENT` | One period: as-of date, tolerance, certified flag | `STATEMENT_FUND` |
| `NAV_LINE` | One statement row. Administrator and shadow are both stored, because the review has to show them together | `LINE_STATEMENT` |
| `CREDIT_FACILITY` | Commitment, drawn, borrowing base, maturity. Availability is the lesser of commitment and borrowing base, minus drawn | `FACILITY_FUND` |
| `CASH_FORECAST` | One future quarter of interest, repayments, fundings, fees, distributions, calls, and facility paydown | `FORECAST_FUND` |
| `EXPOSURE_LIMIT` | A concentration limit for one strategy, sector, or issuer. Sector and issuer defaults live on the fund when a name has no row | `LIMIT_FUND` |

Position strategy (`SENIOR_SECURED`, `UNITRANCHE`, `MEZZANINE`, `ASSET_BASED`) is its own list. It is not the instrument-type list: a unitranche and a senior secured loan are different buckets on this surface and the same instrument family in the deal model.

## Editable behavior

Same write path as the deal surface: click a stored fact, blur, `updateEntity` on that entity and attribute, then reload.

| Control | Writes |
|---|---|
| Vintage, reporting date, strategy, commitments | Fund attributes |
| Resolve / reopen a statement line or a mark | `NAV_LINE_RESOLVED` or `POSITION_MARK_RESOLVED`, and clears `STATEMENT_CERTIFIED` |
| Tolerance | `STATEMENT_TOLERANCE_PCT`, and clears certification |
| Certify NAV | `STATEMENT_CERTIFIED`, only when every flagged line and mark is resolved |
| Administrator and shadow amounts, marks, cost, fair value, income, realized, gross IRR, coupon, leverage | The line or the position |
| Facility terms, forecast cells, plan percent and projected call | The facility, forecast quarter, or plan quarter |
| Commitment, past due, investor type | The commitment or the investor |
| IRR bridge | Gross IRR and the three drags. Net IRR on the surface is the bridge result |
| Search and strategy / sector / issuer grouping | View state only |

A line is flagged when it is marked reviewable, both amounts are present, and the variance exceeds the statement tolerance. A mark is flagged when the administrator and the agent differ by more than one point. Certification is a fact on the statement, not a separate workflow table.

## Sample

`HSCF2-FUND` is Halyard Senior Credit Fund II as of September 30, 2026, with the twelve investors, thirteen positions (Fenwick exited), eight funded calls, the open review items, and the facility from the mock. Entity codes start with `HSCF2-`.
