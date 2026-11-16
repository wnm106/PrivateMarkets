# Deal pipeline: field lineage audit and design

Date: 2026-11-15. Branch: `feat/job-backbone`.

Goal: every displayed field that is not pure rendering points back to a stored or calculated attribute in the entity model. Where the model lacks the field or calculation, add it and backfill.

## How this was checked

- **Pages covered:** the pipeline surface (`surfaces/deal-pipeline/src/index.tsx`) and the deal view (`AllocationBoard.tsx`) with its eight built tabs.
- **Read closely:** pipeline surface, Capital structure, Syndicate, Closing, and the allocation store that feeds the deal header.
- **Scanned for derivations, not read line by line:** Servicing, Performance, IC memo, Compliance, Financials. Findings on those are reliable for what they list but may not be exhaustive.
- **Registration check:** every attribute and relationship code referenced by these files was matched against the SQL in `supabase/migrations`, and then against the live attribute register (776 attributes, read-only). The live results are in "Live database findings" below and override the migration-based statements where they differ.
- **Not readable:** `metadata_register.calc_definitions` is not granted to the service role over REST, so the live calculation rows were not inspected directly.

## Headline

1. **Stored fields are in good shape.** All ~170 attribute and relationship codes the pages read are registered in migrations.
2. **Calculated fields are the gap.** Only five calc definitions exist for these domains: `TRANCHE_HOLD_AMOUNT`, `DEAL_FACILITY_SIZE`, `DEAL_TARGET_HOLD`, `DEAL_ALLOCATED_AMOUNT`, `FUND_AVAILABLE_CAPITAL`. Roughly 45 other displayed numbers and flags are computed in the browser or resolver with no model field behind them.
3. **Two whole tabs are browser models.** Servicing (payment schedule, roll-forward) and Performance (IRR, MOIC, yields, bridges) are computed client-side in `servicing-schedule.ts` and `deal-performance.ts`.
4. **A few values are fabricated or hardcoded** and should be treated as defects, listed below.
5. **A point-back mechanism already exists in one place.** The IC memo wraps values in `AttrRead` / `AttrField` with an `AttrBind` (entity, domain, attribute code), which opens the attribute inspector. No other tab uses it, and the surface contract has no field-level table.

## Defects (wrong or invented values)

| # | Where | What happens | Fix |
|---|---|---|---|
| D1 | Pipeline timeline | Stage bars are invented: each stage is drawn as 18 days, counted back from target close. A deal with no close date is placed at today + 45 days. | Use real stage dates (see N-series below). Show no bar when dates are missing. |
| D2 | Capital structure, tranche card | Seniority text is hardcoded "1st lien senior secured" for every non-equity tranche (both branches of the conditional are identical). `TRANCHE_SENIORITY` exists and the IC memo uses it. | Bind to `TRANCHE_SENIORITY`. |
| D3 | Servicing and Performance | Spread is parsed from the free-text `TRANCHE_PRICING` with a regex. `SPREAD_BPS` exists on the security. Servicing uses only the first funded tranche's spread for the whole schedule. | Bind to `SPREAD_BPS` per tranche. Backfill where blank. |
| D4 | Performance, "Total leverage (funded)" | Displays `DEAL_LEVERAGE_SENIOR` (`fundedLeverage = senior`). | Confirm intent; bind to the right attribute or relabel. |
| D5 | Performance | Hold period defaults to 3 years in code when `DEAL_HOLD_YEARS` is blank. | Backfill `DEAL_HOLD_YEARS`; show blank instead of assuming. |
| D6 | Pipeline | Sector falls back to `DEAL_TYPE`; facility falls back to `DEAL_VALUE`. Different concepts shown under one label. | Backfill `DEAL_SECTOR` and tranches; drop the fallbacks. |
| D7 | Capital structure, drill-down rule gauges | Issuer, sponsor, unfunded and liquidity gauges are recomputed in the browser from this deal's amount only, ignoring existing exposure. The Compliance tab gets the real answer from the rule engine. The two can disagree. | Read rule results from `scoreDealCompliance`. |
| D8 | IC memo, proposed allocation total | Falls back to target hold when nothing is placed, so it shows an allocation that does not exist. | Show zero or blank. |
| D9 | Performance vs IC memo | Gross IRR and MOIC exist twice: stored and editable on the memo (`DEAL_BLENDED_GROSS_IRR`, `DEAL_EXPECTED_MOIC`), and modelled in the browser on Performance. Nothing reconciles them. | Decide which is the record (see decision 2). |
| D10 | Pipeline and deal view | Strategy labels and order, and the stage list in the deal view, are hardcoded maps. | Read labels from the reference lists and the record experience. |

## Field inventory by page

Status: **OK** = bound to a registered stored or calculated attribute. **GAP** = derived in code, no model field. **DEF** = defect above.

### Pipeline surface

| Field | Source today | Status |
|---|---|---|
| Deal name, code | entity | OK |
| Stage | `DEAL_STAGE`; shown as Closing when stage is CLOSED but close date is after the as-of date | OK, with a code-side rewrite (GAP N1) |
| Strategy | `DEAL_STRATEGY`, hardcoded labels | OK / D10 |
| Sector | `DEAL_SECTOR`, else `DEAL_TYPE` | D6 |
| Facility | `DEAL_FACILITY_SIZE` (calc), else `DEAL_VALUE` | OK / D6 |
| Our hold | `DEAL_TARGET_HOLD` (calc) | OK |
| Allocated | `DEAL_ALLOCATED_AMOUNT` (calc) | OK |
| Allocated % | allocated / hold in the browser | GAP A2 |
| Unallocated amount | hold minus allocated in the browser | GAP A1 |
| Needs attention | stage in ALLOCATION or CLOSING and gap over 1% of facility, in the browser | GAP A3 |
| Target close | `DEAL_TARGET_CLOSE_DATE`, else `DEAL_DATE` | OK |
| Timeline stage bars | invented | D1 |
| KPI strip and matrix totals | sums and counts over the rows above | Roll-ups of bound fields; treat as rendering once the row fields are bound |

### Deal header and Capital structure

| Field | Source today | Status |
|---|---|---|
| Description, pricing, OID, leverage, maturity, close | stored `DEAL_*` attributes, editable in place | OK |
| Borrower, sponsor | `DEAL_ISSUER`, `DEAL_SPONSOR` relationships | OK |
| Total facility, target hold, allocated, unallocated | recomputed by the allocation engine for what-if | OK when committed (same calcs); unallocated is GAP A1 |
| Blended hold % | browser | GAP A4 |
| Tranche size, pricing, ticking fee, coverage, call protection, flags | stored `TRANCHE_*` | OK |
| Tranche seniority text | hardcoded | D2 |
| Tranche order | `TRANCHE_RANK`, else a hardcoded instrument map | OK / minor |
| Tranche target amount | engine; equals `TRANCHE_HOLD_AMOUNT` calc | OK |
| Tranche allocated, % allocated, portfolios placed | engine and browser | GAP T1-T3 |
| Fund cash, undrawn, line, reserve, NAV, limits | stored `FUND_*`, `NAV` | OK |
| Portfolio NAV when blank | sum of sleeve NAVs in the store | GAP F1 |
| Available capital | engine; `FUND_AVAILABLE_CAPITAL` calc exists | OK, but confirm the engine and the calc use the same formula |
| % used, remaining after deal, % of facility, share of hold, vs pro-rata | browser ratios of what-if values | What-if rendering; no model field needed unless you want them reportable |
| Cell amount, system amount, cap reason, override reason, note | engine; persisted on commit to `MARKET_VALUE`, `POSITION_ALLOCATION_*` | OK |
| Ineligibility kind and text | engine, from `FUND_ALLOWED_INSTRUMENT_TYPES` and `FUND_MANDATE_NOTE` | Not confirmed whether persisted on commit |
| Rule gauges | browser | D7 |

### Syndicate

| Field | Source today | Status |
|---|---|---|
| Seat role, order, documents, lender type, house flag | stored `SEAT_*`, `ASSIGNMENT_STATUS`, `LENDER_TYPE` | OK (blank role and documents default to "Participant" and "Not issued" in code) |
| Order amount, allocated amount | `ORDER_AMOUNT`, `ORDER_ALLOCATED_AMOUNT` | OK |
| Status | `SYNDICATE_STATUS`, else inferred from stage | OK / backfill |
| Our funds per tranche and total | sum of allocation cells | GAP T1 |
| Other lenders per tranche and total | browser sum over non-house orders | GAP S1 |
| Placed %, unplaced, oversubscription (tranche and deal) | browser | GAP S2-S5 |
| Cut % per order | browser | GAP S6 |
| Facility | sum of debt tranches only, excluding equity-linked | GAP S7: differs from `DEAL_FACILITY_SIZE` |

### Closing

| Field | Source today | Status |
|---|---|---|
| Condition workstream, owner, due, status, link | stored `CONDITION_*` | OK (blank status defaults to OPEN in code) |
| Document parties, version, signatures, status | stored `DOC_*` | OK (defaults in code) |
| Funding cash, line, call, status | stored `FUNDING_*` | OK |
| Funded at close per fund | cash + line + call in the browser | GAP C1 |
| Funds flow total and column totals | browser | GAP C2 |
| Conditions complete, overdue, blocked, on-track status | browser counts | GAP C3-C6 |
| Days to close | browser, relative to as-of date | GAP C7 |
| Funding tab | slot is registered, no panel is built | Nothing to audit |

### Servicing

| Field | Source today | Status |
|---|---|---|
| Index rate, undrawn fee, PIK rate, amortization rate, rating, mark, mark date | stored `SERVICING_*` | OK |
| Draw date, type, amount, status | stored `AMORT_*` | OK |
| Covenant level, current, direction, unit, first test | stored `COVENANT_*` | OK |
| Reporting due date | `REPORT_DUE_DATE` | OK |
| Spread, cash coupon | regex on pricing text | D3, GAP V1 |
| Funded at close, unfunded commitment (ours) | browser sums of allocation cells | GAP V2 (positions already store `FUNDED_PAR_AMOUNT` and `UNFUNDED_COMMITMENT_AMOUNT`) |
| Our share of each draw; commitment usage by fund | browser | GAP V3 |
| Payment schedule, roll-forward, PIK accrued, next payment | browser projection | GAP V4 (largest item) |
| Covenant cushion and status | browser | GAP V5 |

### Performance

| Field | Source today | Status |
|---|---|---|
| Fund fee terms, realised loss, non-accrual, rating, mark | stored | OK |
| Gross and net IRR, MOIC/TVPI, DPI, RVPI, cash yield, all-in yield, weighted coupon and spread, PIK share, WAL, profit, tranche contribution, gross-to-net bridge, return sources | browser model | GAP P1 |
| Blended fee terms | browser, weighted by hold | GAP P2 |
| Interest coverage | from the model; input not traced | Not verified |
| Total leverage (funded) | `DEAL_LEVERAGE_SENIOR` | D4 |

### IC memo, Compliance, Financials

- **IC memo:** most values are already bound through `AttrRead` / `AttrField`. Remaining derivations: hold % (A4), sources and uses totals (GAP M1), tranche hold amount computed inline although `TRANCHE_HOLD_AMOUNT` exists, and D8.
- **Compliance:** values come from rule results, which are model-backed through the rule definitions. The tallies are counts over results. "Exceptions pending" was not traced. No breach count exists on the deal (GAP R1), which is what the pipeline's "needs attention" should eventually use.
- **Financials:** rows are driven by the `STATEMENT_PERIOD` attribute register, including derivation formulas. Model-driven as far as the scan shows.

## Design

### 1. One binding contract for every field

Add a field-level table to the surface contract and generalise the IC memo's binding component.

- **Table `surface_component_fields`:** `component_id`, `field_code`, `label`, `binding_kind` (`ATTRIBUTE`, `CALC`, `RULE_RESULT`, `ENGINE_OUTPUT`, `RENDERING`), `domain_code`, `attribute_code`, `relationship_path`, `notes`. Seeded by migration for the deal pipeline surface.
- **Shared component:** move `AttrRead` / `AttrField` / `AttrBind` out of `IcMemo.tsx` into a shared module so every tab renders values through it and gets the inspector for free.
- **Guard:** a test that fails when a registered field has kind `ATTRIBUTE` or `CALC` and its code is not in the attribute register. This is what keeps the audit true after today.

### 2. New calculated attributes

All are `ON_READ` unless noted, so they need no data backfill.

| Ref | Attribute | Domain | Definition | Engine support today |
|---|---|---|---|---|
| A1 | `DEAL_UNALLOCATED_AMOUNT` | DEAL | target hold minus allocated | Yes (expression) |
| A2 | `DEAL_ALLOCATED_PCT` | DEAL | allocated / target hold | Yes |
| A4 | `DEAL_HOLD_PCT` | DEAL | target hold / facility | Yes |
| A3 | `DEAL_NEEDS_ATTENTION` | DEAL | stage is ALLOCATION or CLOSING and gap over 1% of facility; later also breach count over 0 | Needs a conditional op: verify |
| T1 | `TRANCHE_ALLOCATED_AMOUNT` | DEAL_TRANCHE | sum of `MARKET_VALUE` over `POSITION_TRANCHE` | Yes (aggregate), but must exclude LOCK-role positions |
| T2 | `TRANCHE_ALLOCATED_PCT` | DEAL_TRANCHE | T1 / hold amount | Yes |
| T3 | `TRANCHE_PORTFOLIO_COUNT` | DEAL_TRANCHE | count of portfolios placed | Needs COUNT |
| F1 | `NAV` roll-up for portfolios | FUND | sum of sleeve NAV over `FUND_PARENT` when not stored | Yes |
| S1 | `TRANCHE_SYNDICATED_AMOUNT` | DEAL_TRANCHE | sum of `ORDER_ALLOCATED_AMOUNT` for non-house seats | Needs a filtered aggregate |
| S2-S4 | `TRANCHE_ORDER_AMOUNT`, `TRANCHE_PLACED_PCT`, `TRANCHE_OVERSUBSCRIPTION` | DEAL_TRANCHE | orders, placed / size, orders / size | Yes once S1 exists |
| S5 | `DEAL_UNPLACED_AMOUNT`, `DEAL_OVERSUBSCRIPTION` | DEAL | roll-ups of the above | Yes |
| S6 | `ORDER_CUT_PCT` | SYNDICATE_ORDER | 1 minus allocated / ordered | Yes |
| S7 | `DEAL_DEBT_FACILITY_SIZE` | DEAL | tranche size where not equity-linked | Needs a filtered aggregate |
| C1 | `FUNDING_TOTAL_AMOUNT` | DEAL_FUNDING_PLAN | cash + line + call | Yes |
| C2 | `DEAL_FUNDED_AT_CLOSE` | DEAL | sum of C1 over `FUNDING_DEAL` | Yes |
| C3-C5 | `DEAL_CONDITIONS_TOTAL`, `_COMPLETE`, `_OVERDUE`, `_BLOCKED` | DEAL | counts over `CONDITION_DEAL` | Needs COUNT, a filter, and an as-of comparison |
| C6 | `DEAL_CLOSING_STATUS` | DEAL | on track / overdue / blocked | Needs a conditional |
| C7 | `DEAL_DAYS_TO_CLOSE` | DEAL | target close minus as-of date | Needs an as-of operand |
| V1 | `TRANCHE_CASH_COUPON` | DEAL_TRANCHE | index rate + security `SPREAD_BPS` | Yes (traversal to security and deal) |
| V2 | `DEAL_FUNDED_HOLD_AMOUNT`, `DEAL_UNFUNDED_HOLD_AMOUNT` | DEAL | sums of `FUNDED_PAR_AMOUNT`, `UNFUNDED_COMMITMENT_AMOUNT` over positions | Yes |
| V5 | `COVENANT_CUSHION_PCT`, `COVENANT_STATUS` | DEAL_COVENANT | by direction, level and current | Needs a conditional |
| M1 | `DEAL_SOURCES_TOTAL`, `DEAL_USES_TOTAL` | DEAL | sums of `CAPITAL_AMOUNT` by `CAPITAL_SIDE` | Needs a filtered aggregate |
| R1 | `DEAL_BREACH_COUNT` | DEAL | from latest compliance results | Needs rule results as a calc input (open gap C6 in the earlier analysis) |

**Engine work this implies.** The original calc schema allows aggregate functions SUM, WAVG, MIN, MAX and kinds EXPRESSION, AGGREGATE, SERIES. Before building, confirm against the current engine whether later migrations added: COUNT, a filter condition on aggregate inputs, a conditional expression op, and an as-of date operand. Roughly half the table depends on those four.

### 3. Stage dates (N-series, fixes D1)

- **N1 `DEAL_STAGE_ENTERED_DATE`:** derive from the valid-time history of `DEAL_STAGE`. This also replaces the code that rewrites CLOSED to CLOSING for earlier as-of dates.
- **N2 target dates per stage:** stored attributes for planned stage dates, as proposed in the earlier gap analysis but never registered. Without them the timeline can only show actuals.

### 4. Servicing and Performance (V3, V4, P1, P2)

These are projections, not single values. Two workable shapes:

- **Server calc (recommended):** move `servicing-schedule.ts` and `deal-performance.ts` into the graphql package (as the allocation engine already is), register the headline outputs as attributes (`DEAL_GROSS_IRR`, `DEAL_NET_IRR`, `DEAL_GROSS_MOIC`, `DEAL_CASH_YIELD`, `DEAL_ALL_IN_YIELD`, `DEAL_WAL_YEARS`, per-tranche IRR and MOIC), and materialise them on commit and on servicing-input change. The schedule itself becomes expected `CASH_FLOW` rows or a SERIES calc.
- **Declared engine output:** leave the maths in the browser but register each output as `ENGINE_OUTPUT` with its input attributes listed. Cheaper, satisfies "points back to inputs", but the numbers stay unqueryable and unreportable.

### 5. Backfill

Calculated attributes need none. Stored backfills, each needing a count from the database first:

| Attribute | Rule |
|---|---|
| `SPREAD_BPS` on deal securities | parse from `TRANCHE_PRICING` where blank (the sample-data migration already does this); review non-SOFR pricing by hand |
| `TRANCHE_SENIORITY` | from instrument type where blank |
| `DEAL_SECTOR` | from the borrower's sector where blank; do not copy `DEAL_TYPE` |
| Tranches for deals that only have `DEAL_VALUE` | list for manual entry; no safe automatic rule |
| `DEAL_HOLD_YEARS` | list blanks; set explicitly rather than assuming 3 |
| `SYNDICATE_STATUS`, `CONDITION_STATUS`, `DOC_STATUS`, `FUNDING_STATUS`, `SEAT_ROLE`, `ASSIGNMENT_STATUS` | write the defaults the pages assume today, so the code defaults can go |
| Stage target dates (N2) | no source; entered going forward |
| Materialised performance outputs (if option 1) | one run per deal |

### 6. Phasing

1. **Binding contract and quick wins:** field table, shared bind component, guard test, defects D2, D4, D5, D6, D8, D10, and the calcs marked "Yes".
2. **Engine extensions:** COUNT, filtered aggregates, conditional, as-of operand; then Closing, Syndicate, covenant and attention calcs; D7.
3. **Spread and stage dates:** D3 with the `SPREAD_BPS` backfill; N1, N2 and the timeline (D1).
4. **Servicing and Performance on the server:** V3, V4, P1, P2; resolve D9.

## Live database findings (2026-11-15, read-only)

### The five existing deal calculations are not in the live register

`TRANCHE_HOLD_AMOUNT`, `DEAL_FACILITY_SIZE`, `DEAL_TARGET_HOLD`, `DEAL_ALLOCATED_AMOUNT`, `FUND_AVAILABLE_CAPITAL` and `POSITION_ALLOCATION_ROLE` are all absent. They are the six attributes registered by `20261028174242_deal_allocation_calculated_attributes.sql`, and no other migration mentions them, so that migration appears never to have been applied to this database. The web app points at the same database.

Expected effect on the pipeline page, inferred from the code and not observed on screen:

- Facility shows `DEAL_VALUE` through the fallback, not the sum of tranches.
- "Our target hold" and "Allocated" are blank for every deal.
- Every deal in ALLOCATION or CLOSING is flagged "needs attention", because a blank gap counts as attention. That is 5 of the 17 deals today.
- The IC memo's source inspector for Facility and Our hold points at attribute codes that do not exist.

So phase 1 starts by applying that migration (or folding it into the new calc migration), before adding anything new.

### Calculation engine functions available

The live function library has row functions (ADD, SUB, MUL, DIV, COALESCE, CURRENT_DATE, MIN, MAX, ROUND and others), group functions SUM, WAVG, MIN, MAX, and domain functions XIRR, NET_MULTIPLE, CURRENT_YIELD, UNREALIZED_PNL.

- **Present:** CURRENT_DATE, so days-to-close (C7) works without engine changes. XIRR and NET_MULTIPLE, which the server-side performance model can use.
- **Missing:** a conditional (IF), COUNT, and a filter on aggregate inputs. These three are the phase 2 engine work.

### Backfill, sized on the 17 active deals

The pipeline holds 12 `HALY-DEAL-*` deals with 25 tranches and 25 securities, and 5 older `PIPE-DEAL-*` deals with no tranches.

| Item | Result | Action |
|---|---|---|
| `TRANCHE_SENIORITY`, `TRANCHE_RANK` | 0 of 25 blank | None |
| `SPREAD_BPS` on SOFR debt securities | 0 blank | None. The binding change (D3) needs no backfill. |
| Fixed-rate debt securities | 2 (Obsidian "11.0% cash + 3.0% PIK", Redwood "12.0% cash") have no spread, correctly | Bind these to `COUPON_RATE` and `PIK_MARGIN`; confirm those are populated. See the note below. |
| `CONDITION_STATUS` (85), `DOC_STATUS` / `DOC_VERSION` (30), `FUNDING_STATUS` (16), `SEAT_ROLE` / `ASSIGNMENT_STATUS` (45) | 0 blank | None. The code defaults can simply be removed. |
| `SYNDICATE_STATUS` | 12 of 17 blank (7 HALY deals before allocation, 5 PIPE deals) | Write `NOT_LAUNCHED`, or `CLOSED` where the stage is CLOSED |
| `DEAL_SECTOR`, `DEAL_STRATEGY`, `DEAL_HOLD_YEARS`, `DEAL_TARGET_CLOSE_DATE`, `DEAL_BASE_RATE`, tranches | Complete on all 12 HALY deals; blank on all 5 PIPE deals | Decision below: there is no source to derive these from |
| `DEAL_LEVERAGE_SENIOR` / `_TOTAL` | 8 and 7 of 17 blank | 5 are the PIPE deals; the rest need a look per deal |
| Stage target dates (N2) | New attributes | Entered going forward |

**Fixed-rate coupon note.** `spreadFromPricing` returns a fixed rate such as 12% as the "spread", and the schedule then adds the index rate to it. For Obsidian and Redwood this would overstate the coupon wherever an index rate is set. Read from the code, not confirmed at runtime.

## Decisions taken (2026-11-15)

1. **Binding contract:** database table `surface_component_fields`.
2. **Performance and servicing:** move to the server and store the outputs. The memo's IRR and MOIC become overrides of the modelled value.
3. **What-if ratios on the allocation grid:** stay as rendering of engine output.
4. **Syndicate facility:** no recommendation was given originally. Working assumption: keep the page on debt tranches only and register that as `DEAL_DEBT_FACILITY_SIZE` (S7), so the full `DEAL_FACILITY_SIZE` stays untouched. Confirm.
5. **Backfill scope:** only the deals in the pipeline.

## Open questions

1. **The 5 `PIPE-DEAL-*` deals** have no strategy, sector, tranches or close date, and nothing to derive them from. Options: deactivate them so they leave the pipeline, enter real values by hand, or seed invented sample values.
2. **Who applies migrations to the live database.** Only read access has been granted for this work.
