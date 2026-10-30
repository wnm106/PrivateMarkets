# Deal Pipeline and Allocation surface: gap analysis

Source: the "Project Halyard: deal allocation" mockup, mapped against the current common backend (entity/attribute EAV, relationships, calc engine, compliance engine, record experiences).

> **Revision (design decisions taken).**
> 1. A tranche is the **intersection of a Deal and a Security** (`DEAL_TRANCHE`). Securities exist before close, so the security carries instrument terms and the tranche carries structure and our hold.
> 2. A proposed allocation is a **synthetic POSITION** (fund + security + tranche, `POSITION_IS_HYPOTHETICAL = true`), not a separate `DEAL_ALLOCATION` entity. This supersedes the `DEAL_ALLOCATION` domain, and removes the need for the overlay in gap C1 and the multi-base problem in C5: existing position rules evaluate a proposal like a booked holding. Rules that measure the real book must exclude hypothetical positions.
> 3. Intersections in this codebase are metadata only. `POSITION` is registered as an intersection type, but position data is stored as entities joined by `POSITION_FUND` / `POSITION_SECURITY`, because the compliance, calc and grid engines read entities and relationships and ignore intersection tables. `DEAL_TRANCHE` follows the same pattern.
> 4. Phase 1 is implemented in `supabase/migrations/20261028120000_deal_allocation_surface_model.sql` (not yet applied; see the status notes in the conversation).

Everything in the mockup is currently hardcoded JS (`PORTS`, `DEAL_SPECS`, `rulesFor`, `compute`, `simulate`). The job is to turn each hardcoded structure into registered metadata plus stored values, and to move the computation into the shared engines.

---

## 1. What the mockup is

**Pipeline view.** Strategy x stage matrix (counts, $ facility, "needs attention" badge), KPI strip, search, group-by (strategy/stage/none), list view and timeline (Gantt) view.

**Deal view**, seven tabs:

| Tab | Content | Nature |
|---|---|---|
| Capital structure | Tranche stack, per-tranche hold sliders, **allocation grid** (portfolio > sub-portfolio x tranche), override/exclude editor with reason codes, adjustment log, drill-down panel (liquidity and rule gauges) | Interactive compute + write |
| IC memo | 11 memo sections, approvals, open items | Document / narrative |
| Compliance | Rule matrix per fund, breach register, waiver workflow (request / approve / reject / reopen), allocation sign-off | Compliance engine + workflow |
| Syndicate | Other lenders, orders vs allocations, oversubscription, assignment-document signatures | New data |
| Funding | Per-sub-fund funding plan (cash / line / capital call), notice dates, 13-week liquidity calendar | Compute + new data |
| Closing | Conditions checklist (some auto-linked to other tabs), documents, funds flow | Workflow data |
| Servicing | Payment schedule, expected draws, commitment usage, covenants, reporting calendar | Derived + new data |

**Core engine (the hard part).** Progressive-fill allocation: each tranche's target hold is spread across eligible funds by available capital, subject to per-fund caps (issuer concentration, sponsor concentration, unfunded-commitment limit, available capital), mandate/guideline eligibility, and manual overrides/exclusions that re-spread the remainder. Output includes "why not eligible" text, "capped by X" flags, and system-vs-final deltas.

---

## 2. Proposed data model (register as entities / attributes / relationships)

### 2.1 Reuse existing domains

| Mockup concept | Existing domain | Notes |
|---|---|---|
| Deal | `DEAL` | Extend with attributes below. `DEAL_STAGE` exists but is a free string and its values do not match the `DEAL_STATUS` list. Create a `DEAL_STAGE` reference list (ORIGINATION, DILIGENCE, IC_APPROVED, ALLOCATION, CLOSING, FUNDED) and align `record_experiences.pipeline.stages`. |
| Portfolio and sub-portfolio | `FUND` + existing `FUND_PARENT` relationship | Parent fund = portfolio, child = sub-portfolio/sleeve. Rollups already traverse this. |
| Borrower | `ISSUER` + `DEAL_ISSUER` | |
| Sponsor | `ISSUER` with a role attribute, or a new `SPONSOR` domain | Recommend a `SPONSOR` domain plus `DEAL_SPONSOR` relationship so sponsor-concentration rules can group by it. |
| Post-close holdings | `POSITION` (FUNDED_PAR_AMOUNT, UNFUNDED_COMMITMENT_AMOUNT) | Source of "existing sponsor exposure" and "existing unfunded". |
| Expected cash events | `CASH_FLOW` | Capital-call notices, line draws, deal funding, coupons, draws. Add CASHFLOW_TYPE values. |
| Reason codes | New reference list `ALLOCATION_REASON` | LIQ, CONC, MAND, TAX, CONF, PORT, IC, CLNT, OTH |
| Strategy, instrument type | Reference lists `STRATEGY` (new), instrument-type list (exists: LOAN, UNITRANCHE, REVOLVING_CREDIT, MEZZANINE, PREFERRED_EQUITY) | Need to add 2L term loan, DDTL, warrant values. |

### 2.2 New domains

| Domain | Represents | Key relationships |
|---|---|---|
| `DEAL_TRANCHE` | **Intersection of DEAL and SECURITY**: structure, rank, funded/unfunded, **our hold %**; instrument terms stay on the security | `TRANCHE_DEAL`, `TRANCHE_SECURITY` (both required) |
| ~~`DEAL_ALLOCATION`~~ | Replaced by synthetic `POSITION` rows (fund + security), with `POSITION_TRANCHE` to the tranche | `POSITION_FUND`, `POSITION_SECURITY`, `POSITION_TRANCHE` |
| `DEAL_FUNDING_PLAN` | Per deal x sub-fund funding split | `FUNDING_DEAL`, `FUNDING_FUND` |
| `LENDER` | Syndicate participant (type: Bank/Insurance/Credit fund) | |
| `SYNDICATE_ORDER` | Lender x tranche order, allocation, role, doc status | `ORDER_TRANCHE`, `ORDER_LENDER` |
| `CLOSING_CONDITION` | Checklist item (workstream, owner, due offset, status, auto-link source) | `CONDITION_DEAL` |
| `DEAL_DOCUMENT` | Document, parties, version, signatures required / received, status | `DOC_DEAL` |
| `COVENANT` | Level, test date, direction; current/cushion computed | `COVENANT_DEAL` or `_ISSUER` |
| `IC_APPROVAL` | Member, role, decision, date | `APPROVAL_DEAL` |
| `INVESTOR` | Not needed for this surface. Defer. | |

Decision for you: **allocation as entity vs intersection.** The backend has `intersection_types` (members with roles, plus EAV on the intersection) and only POSITION is seeded. An intersection of DEAL x TRANCHE x FUND is a natural fit, but the generic grids, lineage, compliance rollups and import maps are built around entities. Recommendation: entity (`DEAL_ALLOCATION`) with three relationships. Edges carry no attributes today, so a plain relationship cannot hold the amount.

### 2.3 Attributes to register

**DEAL:** `DEAL_STRATEGY` (ref), `DEAL_STAGE` (ref), `DEAL_DESCRIPTION`, `DEAL_SECTOR`, `DEAL_EBITDA`, `DEAL_TARGET_CLOSE_DATE`, `DEAL_STAGE_TARGET_*_DATE` (for the timeline), `DEAL_PRICING_TEXT`, `DEAL_OID`, `DEAL_LEVERAGE_SENIOR`, `DEAL_LEVERAGE_TOTAL`, `DEAL_ADVANCE_RATE`, `DEAL_MATURITY_DATE`, `DEAL_FACILITY_SIZE` (calc: sum of tranche sizes), `DEAL_TARGET_HOLD` (calc: sum of tranche holds), `DEAL_ALLOCATED_AMOUNT` (calc: sum of allocations), `DEAL_UNALLOCATED_GAP` (calc), `DEAL_BREACH_COUNT` and `DEAL_NEEDS_ATTENTION` (derived from compliance results, see gap C6). Stage-entry dates come for free from valid-time history on `DEAL_STAGE`.

**DEAL_TRANCHE:** `TRANCHE_TYPE` (ref), `TRANCHE_SIZE`, `TRANCHE_RANK`, `TRANCHE_IS_UNFUNDED`, `TRANCHE_IS_EQUITY_LINKED`, `OUR_HOLD_PCT`, `OUR_HOLD_AMOUNT` (calc), `TRANCHE_PRICING`, `TRANCHE_TICKING_FEE`, `TRANCHE_CALL_PROTECTION`, `TRANCHE_ATTACH_X` / `DETACH_X` (calc: cumulative size / deal EBITDA), `TRANCHE_COVERAGE_PCT` (warrants).

**DEAL_ALLOCATION:** `ALLOC_SYSTEM_AMOUNT` (written by engine), `ALLOC_FINAL_AMOUNT`, `ALLOC_ADJUSTMENT_TYPE` (NONE / OVERRIDE / EXCLUDE), `ALLOC_REASON_CODE`, `ALLOC_NOTE`, `ALLOC_CAP_REASON`, `ALLOC_EXCLUSION_REASON`, `ALLOC_STATUS` (INDICATIVE / ALLOCATED / CONFIRMED). Manual adjustments should use the existing MANUAL source (precedence rank 1, `override_reason`), so system-vs-final is already represented as two sources on one attribute. System values stay on the CALCULATED/DERIVED source.

**FUND (portfolio and sub-portfolio):**
- Liquidity: `FUND_CASH`, `FUND_UNDRAWN_COMMITMENTS`, `FUND_LINE_HEADROOM`, `FUND_PIPELINE_RESERVE` (calc: sum of unfunded allocations), `FUND_AVAILABLE_CAPITAL` (calc expression). As-of dated and source-attributed.
- Mandate: `FUND_ALLOWED_INSTRUMENT_TYPES` (multi-valued ref), `FUND_DENIED_REASON_*` or an eligibility rule message (see C3), `FUND_SINGLE_ISSUER_LIMIT_PCT`, `FUND_SPONSOR_LIMIT_PCT`, `FUND_UNFUNDED_LIMIT_PCT`.
- Funding config: `FUND_FUNDING_MIX_CASH/LINE/CALL_PCT`, `FUND_CALL_NOTICE_DAYS`, `FUND_LINE_NOTICE_DAYS`.
- `NAV` already exists.

**DEAL_FUNDING_PLAN:** `FUNDING_CASH`, `FUNDING_LINE`, `FUNDING_CALL`, `FUNDING_ORDER_POLICY`, `FUNDING_IS_MANUAL`.

**Others:** `LENDER_TYPE`, `ORDER_AMOUNT`, `ORDER_ALLOCATED_AMOUNT`, `ORDER_ROLE`, `DOC_SIGNATURES_REQUIRED/RECEIVED`, `CONDITION_WORKSTREAM/OWNER/DUE_OFFSET_DAYS/STATUS/LINK_SOURCE`, `COVENANT_LEVEL/DIRECTION/FIRST_TEST_DATE`, `POSITION_INTERNAL_RATING`, `POSITION_MARK`.

**Templates:** register a `*_STANDARD` template for each new domain (sections: Terms, Allocation, Funding, ...) and add the new attributes to DEAL_STANDARD / FUND_STANDARD. Attribute codes are globally unique, so keep these prefixed.

---

## 3. Compliance engine: what it covers and what it does not

Current engine (`compliance.*`): rules with a base domain, rollup path, group-by, numerator/denominator aggregation, MAX/MIN soft/hard limits, AND/OR conditions, scope assignments, as-of + knowledge date, persisted runs and results. The three seeded rules are inactive examples; there are no deal or allocation rules.

### Maps cleanly (configuration only)

| Mockup rule | Rule shape |
|---|---|
| Single-issuer concentration | Base ALLOCATION (or POSITION), group by issuer, numerator = amount, denominator = fund NAV, MAX |
| Sponsor concentration | Group by sponsor via path ALLOC -> DEAL -> SPONSOR |
| Unfunded commitments | Numerator = unfunded amounts, denominator NAV, MAX |
| Liquidity coverage | Allocation total vs available capital, MAX 100% |
| Mandate / guideline eligibility | Category ELIGIBILITY: condition comparing tranche instrument type to fund allowed list |
| Covenants (servicing tab) | Rules anchored on deal/issuer: leverage MAX, coverage MIN, liquidity MIN, soft limit = "Watch" |

### Gaps in the compliance engine

| # | Gap | Why it matters | Proposed change |
|---|---|---|---|
| C1 | **What-if evaluation (revised).** With synthetic positions the engine can read proposals as ordinary data, so no value overlay is needed. What remains: evaluate a scenario subset (only positions with a given `POSITION_SCENARIO_CODE`, plus the real book), exclude hypotheticals from production runs, and avoid persisting a run on every slider move. | The surface evaluates *proposed* amounts on every override. | Add a condition on production rules (`POSITION_IS_HYPOTHETICAL` is not true); add `p_persist boolean default true` and a scenario filter to `evaluate_rule`. Slider moves still use the shared allocation engine locally; compliance runs on commit. |
| C2 | **One limit per rule version.** Mockup limits differ per fund (3%, 5%, 8%, 10% of NAV...). | Without this you need one rule per fund. | Allow the limit to come from an attribute on the anchor (`limit_attribute_code`), or a per-scope limit override on `rule_scope_assignments`. |
| C3 | **No human-readable breach or ineligibility messages**, only status and amounts. | Grid cells and panels show "Mandate prohibits subordinated debt", "Single-issuer limit". | Add message templates to rule versions (`{value}`, `{limit}`, `{entity}` tokens) and a per-scope message for eligibility denials. |
| C4 | **No headroom / constraint output.** | The allocation engine needs "how much more can fund X take" as an input, not just pass/fail. | Return `headroom = limit - current` per anchor/group (derivable from existing numerator, denominator, limit) and expose it through a `complianceConstraints` query. The allocation engine then consumes rules instead of hardcoded caps. |
| C5 | ~~Rules read one base domain.~~ **Resolved by design:** existing exposure and proposals are both POSITION entities, so one rule covers existing + proposed. At closing, flip `POSITION_IS_HYPOTHETICAL` to false (or book the real position). | | |
| C6 | **Rule results cannot feed calc attributes.** | "Needs attention", breach badges and the "Compliance sign-off" closing condition derive from results. | Expose `compliance.current_status(entity, rule?)` as a function usable as a calc input, or materialize breach counts on the deal. |
| C7 | **No waiver / exception / approval workflow.** Results are append-only; the only precedent is DQ `WAIVED`. | The Compliance tab's request / approve / reject / reopen / expiry flow. | New tables `compliance.rule_exceptions` (result or ad hoc key, reason code, note, status, requested_by, decided_by, decided_at, expires_at) and `compliance.sign_offs` (deal, signer, timestamp, **allocation signature hash**). Sign-off auto-invalidates when the signature changes, as in the mockup. Mutations `requestComplianceException`, `decideComplianceException`, `signOffAllocation`. |
| C8 | **No permission codes** for these actions. | Four-eyes: requester differs from approver. | Add `compliance.waive`, `allocation.write`, `allocation.signoff` to `tenancy.permissions` and map them to roles. Enforce requester != approver. |

---

## 4. Other backend gaps

| # | Gap | Proposed change |
|---|---|---|
| B1 | **Allocation engine** (progressive fill, caps, eligibility, override re-spread, largest-remainder rounding to cents, two levels portfolio to sub-portfolio). Nothing like it exists. | Pure TypeScript module in `packages/graphql/src/lib/allocation-engine.ts`, importable by the web app, so the UI recomputes locally for slider interactivity while the server stays authoritative. Inputs: tranches + hold %, fund hierarchy, liquidity attributes, compliance constraints (C4), eligibility, adjustments. Output: amounts, caps, exclusion reasons, system amounts. Exposed as `previewAllocation` (no writes) and `commitAllocation` (writes). Needs unit tests ported from the mockup's numbers. |
| B2 | **Transactional multi-row writes.** `createEntity` / `updateEntity` loop over PostgREST calls; partial writes are possible. | A SQL RPC `allocation.commit(deal_id, payload)` that writes all allocation rows, adjustments and funding plan in one transaction, closes superseded rows and stamps the signature. |
| B3 | **Liquidity calendar projection** (13 weeks: baseline in/out, deal fundings by close date, call-notice and line-notice dates, reserves). Mockup fakes baseline flows with a hash. | Server RPC `liquidity.project(fund_ids, weeks, scope)` reading CASH_FLOW expected rows plus funding plans. Scope (closing / +allocation / +IC / all open) filters by deal stage. Late-notice detection compares notice date to today. |
| B4 | **Cross-tab / pivot** (strategy x stage with count, $ and attention). | New pivot aggregation in `reporting.grid` (or a dedicated `pipeline_matrix` RPC) returning counts and sums grouped by two attributes. |
| B5 | **Record experiences are not enough as is.** Section kinds are FORM / GRID / DASHBOARD only; there are no create/update mutations or admin editor; no stage-transition rules. | Add section kinds (`ALLOCATION_GRID`, `FUNDING_PLAN`, `CALENDAR`, `COMPLIANCE`, `CHECKLIST`, `MEMO`) and register them in `RecordWorkspace`; add `createRecordExperience` / `updateRecordExperience` and an admin editor; add stage-gating config (required conditions to enter a stage, e.g. "Compliance sign-off" before CLOSING). |
| B6 | **Stage governance.** `/pipeline` moves a card by writing the stage attribute with no checks. | Stage-gate rules evaluated on transition (uses the DQ expression engine or a compliance rule), with block / warn behavior. |
| B7 | **Auto-linked closing conditions** (compliance signed, allocation within hold, funding plan clean). | Calc attributes on the deal (`DEAL_COMPLIANCE_SIGNED`, `DEAL_ALLOCATION_COMPLETE`, `DEAL_FUNDING_PLAN_CLEAN`) that CLOSING_CONDITION status reads. Depends on C6. |
| B8 | **IC memo.** Narrative engine exists (LLM-driven). Memo needs deterministic tables (sources and uses, returns, allocation) plus prose. | A narrative template mixing data tables bound to entity queries with generated prose; financial summary needs period-grained issuer/deal attributes (`period_grain` already exists). Deal team and IC members need a person reference: there is no user/person domain, so either a `PERSON` domain or text attributes. |
| B9 | **Servicing schedules** (interest, fees, amortization, PIK, expected draws). | Generate as expected CASH_FLOW rows or an on-read SERIES calc (the calc engine has `SERIES` / XIRR). Defer to a later phase. |
| B10 | **`domain-routes.ts` is hardcoded**; sidebar `TOOLS` array is hardcoded. | Add routes for new domains; register the new surface in `AppSidebar.tsx`. Move the sidebar toward registry-driven when convenient. |
| B11 | **INVESTOR domain is referenced but not seeded.** | Out of scope here; note only. |
| B12 | **Grants/RLS** for every new metadata table (existing pattern: `GRANT ... TO authenticated`, read-all policy, tenant-admin-write policy, `NOTIFY pgrst`). | Follow the pattern in every migration. |

---

## 5. Frontend work

| Component | Notes |
|---|---|
| `/deals/pipeline` (or evolve `/pipeline`): matrix, KPIs, filters, list, timeline | Matrix needs B4. Timeline: new Gantt component fed by stage dates. Reuse AppGrid for the list. |
| Deal workspace shell with tabs | Evolve `RecordWorkspace` / `experiences/[code]/[id]`; each tab is a section kind (B5). |
| Allocation grid | Custom (not AG Grid cells): two-level expandable rows, per-cell override/exclude, flash on change, footer totals. Uses the shared engine (B1). |
| Drill-down panel + adjustment log | Rule gauges read compliance constraints/results (C4); log reads MANUAL-source rows with reasons. |
| Compliance tab | Matrix of rule status by fund; exceptions register; sign-off. Reads compliance results plus exceptions (C7). |
| Funding plan + calendar | Editable table with manual-override flag, calendar heatmap, event list. |
| Syndicate / Closing / Servicing | Mostly AppGrid-style tables over new domains; tiles reuse reporting KPI components. |
| IC memo | Narrative runner output with section nav. |

---

## 6. Suggested phasing

1. **Foundation:** reference lists, new domains/attributes/relationships/templates, DEAL_TRANCHE and DEAL_ALLOCATION, seed Halyard-style data (migration), permission codes. No UI beyond the generic entity pages, but the data is browsable.
2. **Allocation core:** allocation engine (B1) + tests, `previewAllocation` / `commitAllocation` (B2), pipeline matrix + list (B4), Capital structure tab with the allocation grid.
3. **Compliance integration:** C1 overlay, C2 per-fund limits, C3 messages, C4 constraints, rules registered for the four checks, Compliance tab, exceptions + sign-off (C7, C8), stage-gating (B6).
4. **Funding and calendar:** funding plan entity, liquidity projection (B3), Funding tab.
5. **Lifecycle tabs:** Syndicate, Closing (with B7), Documents, IC memo (B8).
6. **Servicing and covenants:** covenant rules, schedules (B9).

Phases 1 to 3 are the critical path: they deliver the pipeline, allocation, and compliance gating that justify the surface.

---

## 7. Decisions needed

1. **Allocation as an entity (recommended) or as an intersection?**
2. **Tranche as new `DEAL_TRANCHE` domain (recommended) or reuse SECURITY?**
3. **Proposed allocations in compliance: overlay on `evaluate_rule` (recommended) or union of base domains?**
4. **Per-fund limits: attributes on FUND read by the rule (recommended) or per-scope overrides on the rule?**
5. **Surface registration: extend `record_experiences` with new section kinds (recommended, keeps it config-driven) or a bespoke route like `/pipeline`?**
6. **Scope of v1:** are Syndicate, Closing, Servicing and IC memo in scope for the first release, or is it pipeline + capital structure + compliance + funding?

## 8. Caveats

The backend facts above come from a read-only survey of migrations and code. Before building, verify the specifics that drive the design: that rule conditions support cross-entity attribute comparison (`compare_attribute_code` with a relationship path, migration 00059), the current signature of `compliance.evaluate_rule`, and the derived-attribute trigger behavior when inserting calc attributes. The mockup's numbers (limits, hold %, fund balances) are sample data and should become seed rows, not code.
