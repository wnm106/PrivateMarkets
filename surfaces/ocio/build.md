# Build instructions: OCIO

> Mandate Target Manager (OCIO) is an institutional multi-sleeve allocation and portfolio construction surface anchored on FUND entities (representing both macro Client master accounts and Mandate Sleeves). It enables portfolio managers and allocation committees to set tri-measure allocation target bands ($ / # / %) across three orthogonal hierarchies (Strategy, Region, Structure), track pacing velocity against annual commitment targets, evaluate pre-trade and standing compliance limits via the compliance engine, and calculate dynamic deal-sharing ratios across sleeves.

- **Purpose:** Mandate Target Manager — Functional Description
Nov 23, 2026 · @Bill McMahon
The Mandate Target Manager is a working prototype that lets a fund-of-funds and directs manager set allocation targets for each client and mandate sleeve, track deployment pace against those targets, test compliance rules against original commitments, and allocate new deals across sleeves using a sharing ratio constrained by compliance. Everything runs in one browser page on example data; nothing is connected to a live system yet.
Purpose and core concepts
The app answers four questions for each client and mandate sleeve: what we want the portfolio to look like, how fast we are getting there, whether we are inside our compliance limits, and how much of a new deal each sleeve should take.
Who it is for: portfolio managers and allocation committees setting targets and approving allocations, investment operations maintaining targets and the security master, and compliance reviewing rule results.
Concept
What it means in the app
Client
The macro level: an investor with its own program size, deployment pace and targets that apply across all of its sleeves
Mandate sleeve
A portfolio under a client with its own program size, start and end dates, annual deployment target, targets and compliance rules
Hierarchy
One of three ways to classify an investment: Category › Asset Class › Strategy › Sub-Strategy; Region › Asset Class; Category › Structure Type › Structure Detail. Values and parent–child links come from the seven uploaded list files
Measure
Every target can be set in dollars ($), number of investments (#) and percent (%)
Band
Each measure has a min, a target and a max. Any combination can be set, at any level
% basis
Per client or sleeve: a % target is a share of the total program, or a share of the level above
Original commitment
One investment booked to a sleeve, carrying its target tags and its security-master (compliance) attributes
Compliance rule
A rule from the compliance workbook, attached to a sleeve with its own limit and Hard or Soft severity
Sharing ratio
A sleeve's share of a new deal, from its remaining profile allocation spread over the years left in its investment period
Targets can be set at any level, and child levels do not have to add up to the parent; the app shows the gap rather than enforcing it.
App structure and navigation
The page has three top-level views, a left rail of clients and sleeves, and, in the main view, a header ribbon and six tabs for the selected client or sleeve.
Header bar
• Assign targets — the main working view for one client or sleeve (tabs below).
• Overview — coverage, pacing and compliance across every client and sleeve.
• Pipeline — the deal pipeline with the allocation grid underneath.
• Undo (also Ctrl+Z), Copy CSV (every target, with min / target / max per measure) and Reset example (restores the example data).
Left rail (clients and mandates)
• Each client is listed with its sleeves indented underneath. Selecting one opens it in Assign targets.
• Each row shows program size, investment count, the number of targets assigned, a red badge for compliance breaches, a pacing-velocity tag for the current year, and three small bars showing which hierarchies have any targets.
• + Add mandate sleeve opens a form: client, name, program $, investments, start date, annual deployment target and % basis.
Entity header and ribbon (Assign targets view)
• Breadcrumb, name, the % basis switch (Program or Parent level) and Copy targets from…, which copies targets from another client or sleeve by hierarchy, with a choice to keep, replace or clear existing targets first.
• The ribbon shows program size and % committed, investments made against target, current-year deployment against the annual target, pacing velocity, since-inception velocity, compliance status and the last-12-month run-rate. The compliance cell opens the Compliance tab.
Tabs: Strategy, Region and Structure (one per hierarchy), then Pacing, Commitments and Compliance. Each tab carries a count: targets per hierarchy, commitments, or breaches.
Persistence: all edits are saved in the viewer's own browser and survive a reload, but are not shared with other people or devices. Every change can be undone.
Target tabs: Strategy, Region, Structure
Each hierarchy tab is an editable tree grid where targets are entered at any level and every row shows committed amounts against its band. The Total program row at the top holds the program's own $ and # band.
Column
What it shows and does
Level name
Indented tree with expand / collapse, a level tag (CAT, AC, STRAT, SUB, RGN, TYPE, DETAIL) and an "N below" pill on collapsed rows that hold targets further down. Rows with a target carry an accent stripe
$ Dollars
Min, target and max inputs. Bare numbers are millions; K and B suffixes work. Empty cells show the value implied by the % band in grey (≈)
# Investments
Min, target and max number of investments
% Percent
Min, target and max as a share of the program or of the level above, per the % basis. Disabled on the Total program row
Band bar (under each measure)
Shaded min–max range, a tick at the target and a fill for committed commitments. Green = in range or at target, amber = below min, red = above max or over target, blue = building toward a target with no band. Hover gives the exact status
Children Σ
Compares the next level's targets with this row: dollars as a coverage % and investments as n / N. Green = adds up, amber = under, red = over
Client target / Σ Sleeves
On a sleeve: the client's macro target for the same level. On a client: the total of all sleeves' dollar targets and how many sleeves set one
Clear (×)
Clears every target on the row
Actual % basis: the % band bar measures commitments at the level as a share of all committed commitments (or of the level above). Only a % band entered by the user is judged; implied % values stay as hints.
Editing: Tab moves across min / target / max, Enter or the arrow keys move down a r
- **Audience:** Portfolio managers when deciding how much to invest on behalf of clients in an investment
- **Anchored on entity type:** `FUND`
- **Placement:** sdk-surface
- **Generated:** 2026-11-23T14:51:49.847Z (model-refined)

Read `AGENTS.md`, `docs/SURFACE_TABS.md` and `docs/GUARDRAILS.md` before starting. Do not finish until every standard below is met and `npm run guard` passes.

## Tabs

### Strategy

- **Purpose:** Displays and edits target bands across Category, Asset Class, Strategy, and Sub-Strategy, comparing current commitments against target ranges.
- **How to read:** Bands depict Min, Target, and Max. Green fill indicates commitments within the band; amber indicates under target/min; red indicates over target/max. Figures in grey (≈) are implied dollar values derived from percent bands.
- **Shows:** Strategy tree grid with expand/collapse; Min/Target/Max inputs for $, #, and %; Children Σ rollup coverage indicator; Comparison against macro Client targets; Quick clear actions
- **Loads from:** `query_data`, `get_entity`
- **Publishes to the assistant:** Strategy targets summary: total targets assigned, active bands, coverage percent of program size, and breach count.

### Region

- **Purpose:** Manages geographic targets and commitments across Region and Asset Class classifications.
- **How to read:** Tracks geographic commitments against user-defined regional concentration caps and target bands.
- **Shows:** Region tree grid; Regional $, #, and % min/target/max bounds; Parent vs child sum checks; Exposure rollup against base currency
- **Loads from:** `query_data`, `get_entity`
- **Publishes to the assistant:** Region targets summary: regional allocation percentages and compliance delta.

### Structure

- **Purpose:** Evaluates implementation vehicles across Category, Structure Type, and Structure Detail.
- **How to read:** Differentiates Direct Co-Investments, Secondaries (GP-Led vs LP-Led), and Primary structures against mandate constraints.
- **Shows:** Structure tree grid; Implementation vehicle targets; Coverage vs total program commitments
- **Loads from:** `query_data`, `get_entity`
- **Publishes to the assistant:** Structure targets summary: vehicle distribution percentages.

### Pacing

- **Purpose:** Tracks historical and forecasted deployment pacing against the annual deployment target.
- **How to read:** Pacing velocity > 100% indicates ahead of schedule; < 90% indicates behind pace. Dark bars represent actuals; dashed outlines represent targets.
- **Shows:** Annual deployment chart; Pacing velocity KPIs; Year-by-year deployment table with target overrides; Run-rate and vintage trajectory analysis
- **Loads from:** `query_data`, `get_temporal_history`
- **Publishes to the assistant:** Pacing summary: current year deployment target, actual commitments closed, and velocity index.

### Commitments

- **Purpose:** Lists all investments booked to the selected sleeve with their security-master and compliance metadata.
- **How to read:** Shows exact dollar commitment, closing date, vehicle structure, and compliance clearance status per holding.
- **Shows:** Holdings data table; Look-through tags (vintage, market, sector, manager); Holding detail drilldown card with audit lineage
- **Loads from:** `query_data`
- **Publishes to the assistant:** Commitments summary: total holdings count, total fair value, total commitment sum.

### Compliance

- **Purpose:** Evaluates mandate standing rules, concentration limits, and attestation questionnaires using the compliance engine.
- **How to read:** Red badges represent hard limit breaches; orange represents soft guideline warnings; yellow represents items nearing threshold (>90%); blue indicates pending attestations.
- **Shows:** Compliance summary tiles; Rule evaluation table with rule limits, actual cushion, and severity; Breakdown by asset, issuer, and sector concentration; Rule gap diagnostic panel
- **Loads from:** `evaluate_compliance_rule`, `list_compliance_breaches`
- **Publishes to the assistant:** Compliance evaluation summary: hard breach count, soft breach count, watch count, pending attestations.

## Entities and attributes

| Label | Decision | Attribute | Entity type | Type | Editable | Note |
|---|---|---|---|---|---|---|
| Program Size ($) | reuse | `FUND_TOTAL_COMMITMENTS` | FUND | CURRENCY | yes | Reused directly from FUND. Represents total committed or program capacity for the mandate sleeve or client. |
| Committed Amount to Date ($) | derived |  | FUND | CURRENCY |  | Derived as SUM(COMMITMENT_AMOUNT) of active underlying investments linked via COMMITMENT_FUND. |
| Target Investment Count (#) | new | `FUND_TARGET_INVESTMENT_COUNT` | FUND | INTEGER | yes | Target number of discrete investments planned over the mandate's lifecycle. |
| Annual Deployment Target | new | `FUND_ANNUAL_DEPLOYMENT_TARGET` | FUND | CURRENCY | yes | Annual deployment pace target in mandate base currency. |
| Target % Basis | new | `FUND_TARGET_PERCENT_BASIS` | FUND | REFERENCE_LIST | yes | Whether percentage targets are calculated against the Total Program or Parent Level. |
| Allocation Target Matrix | new | `FUND_TARGET_MATRIX` | FUND | JSON | yes | Bi-temporal JSON payload storing hierarchy targets ($ / # / % min, target, max) keyed by taxonomy path. |
| Investment Period Start Date | reuse | `INCEPTION_DATE` | FUND | DATE |  | Inception date of the sleeve or client program. |
| Investment Period End Date | reuse | `FUND_INVESTMENT_PERIOD_END` | FUND | DATE | yes | End of commitment period; used to compute years remaining for sharing ratio calculations. |
| Base Currency | reuse | `FUND_BASE_CURRENCY` | FUND | REFERENCE_LIST |  | ISO currency code of the mandate. |
| Allocation Eligibility | reuse | `FUND_IS_ALLOCATION_ELIGIBLE` | FUND | BOOLEAN | yes | Determines whether sleeve is included in automated deal pipeline sharing ratios. |
| Pacing Velocity (Current Year) | derived |  | FUND | PERCENTAGE |  | Derived as (Current YTD Closed Commitments / (FUND_ANNUAL_DEPLOYMENT_TARGET * (Elapsed Days in Year / 365))) * 100. |
| Compliance Breach Count | derived |  | FUND | INTEGER |  | Count of HARD_BREACH and SOFT_BREACH results returned from compliance engine for the mandate. |

### New attributes to add (seed records, not migrations)

| Code | Name | Entity type | Type | Time-varying | Why |
|---|---|---|---|---|---|
| `FUND_TARGET_INVESTMENT_COUNT` | Target Investment Count | FUND | INTEGER | yes | Needed to store the macro investment count target (#) for the client or mandate sleeve. |
| `FUND_ANNUAL_DEPLOYMENT_TARGET` | Annual Deployment Target | FUND | CURRENCY | yes | Stores the annual commitment pace dollar amount for pacing velocity calculations. |
| `FUND_TARGET_PERCENT_BASIS` | Target Percent Basis | FUND | REFERENCE_LIST (PROGRAM, PARENT_LEVEL) | yes | Configures whether percentage targets are evaluated against the program size or the immediate parent node in the hierarchy tree. |
| `FUND_TARGET_MATRIX` | Target Allocation Matrix | FUND | JSON | yes | Stores the multi-lens target bands ($/ # / % min, target, max) entered by portfolio managers. |

### Relationships

- FUND_PARENT: Links mandate sleeves to parent client FUND records
- COMMITMENT_FUND: Reaches all underlying commitments booked to a mandate sleeve
- DEAL_FUNDING_PLAN: Connects pipeline deals and prospective tranches to the mandate sleeves

## Functional requirements and capabilities

- **Compliance Rule Evaluation** — _exists_ (tool). Runs mandate concentration rules and guidelines directly via the single compliance interpreter. Tools: `evaluate_compliance_rule`, `list_compliance_breaches`.
- **Pre-Trade Proforma Compliance & Capacity** — _exists_ (tool). Scores prospective pipeline deal allocations across all sleeves simultaneously to verify sharing ratios do not violate sleeve concentration limits. Tools: `evaluate_compliance_proforma`, `investment_capacity`.
- **Bi-Temporal Target Matrix Persistence** — _new_ (graphql). Persists sleeve target matrix updates with effective validFrom/validTo dates and audit trail. Tools: `submit_manual_override`.
- **Copy Targets Across Sleeves** — _new_ (ui). Copies hierarchy target configuration from a client or peer sleeve with mode options: replace, append, or merge. Tools: `query_data`, `submit_manual_override`.

## Agentic workflows

Rule: an agent proposes, a person approves, a fixed step applies (`docs/WORKFLOWS.md`).

### Pipeline Deal Allocation & Sharing Ratio Execution

- **Trigger:** Portfolio manager initiates deal allocation from Pipeline view
- **Outcome:** Allocations calculated, compliance verified across all target sleeves, and funding proposals staged for IC review

1. **[agent] Calculate Optimal Sharing Ratios** — Agent inspects each eligible sleeve's remaining investment period, undrawn commitment budget, annual pacing shortfall, and category target gaps, querying compliance capacity. (`query_data`, `investment_capacity`, `evaluate_compliance_proforma`)
2. **[human] Portfolio Manager Review & Overrides** — PM inspects proposed pro-rata allocation matrix in the Pipeline view, adjusts dollar allocations or toggles sleeves, and verifies that no hard compliance breaches are introduced.
3. **[fixed] Stage Deal Funding Plan** — Writes approved allocation shares into DEAL_FUNDING_PLAN and creates draft syndicate order records for investment operations. (`submit_manual_override`)

## Standards and guardrails

- [ ] **Right-click opens the value’s sources** — Every metric derived from master attributes (Program Size, Base Currency, Investment Period End, Holding commitments) is wrapped in InspectValue with attrBind, enabling right-click lineage inspection.
- [ ] **Editable values edit in place** — Min, Target, and Max cells for $, #, and % across Strategy, Region, and Structure grids support in-place editing, committing changes through the golden-record manual override mutation.
- [ ] **Every tab is published to the assistant** — All 6 tabs call host.usePublishTabs to broadcast current sleeve totals, active targets, pacing velocity, and compliance status to the tapestr.ai assistant.
- [ ] **The page tells the assistant what record is open** — Publishes the currently selected client or sleeve FUND entity via usePublishViewContext(entityViewFocus(activeFund)).
- [x] **As Of and Knowledge dates apply** — All queries bind host.asOfDate and host.knowledgeDate, recalculating target adherence and pacing run-rates as of historical periods.
- [ ] **Fields are attributes, not new columns** — Target matrices and pacing configurations are stored as formal FUND attributes (FUND_TARGET_MATRIX, FUND_ANNUAL_DEPLOYMENT_TARGET, FUND_TARGET_PERCENT_BASIS), never ad-hoc SQL tables.
- [ ] **No code names a client, rule or entity by its code** — No hardcoded client or mandate identifiers. Hierarchy taxonomy trees and rules are driven dynamically by reference data lists and compliance scope assignments.
- [ ] **One interpreter per concept** — Compliance evaluation and capacity checks call evaluate_compliance_rule, evaluate_compliance_proforma, and investment_capacity directly; no client-side math replication.
- [ ] **Migrations change schema; records go in seed** — Seeded attributes (FUND_TARGET_MATRIX, FUND_ANNUAL_DEPLOYMENT_TARGET, FUND_TARGET_PERCENT_BASIS, FUND_TARGET_INVESTMENT_COUNT) are added via supabase/seed files.
- [ ] **A client surface uses only the surface SDK** — Surface is located under surfaces/ocio-target-manager/ and strictly imports from React, @tapestrai/surface-sdk, and @tapestrai/ui.
- [ ] **An agent proposes, a person approves, a fixed step applies** — Automated sharing ratios and target recommendations are proposed by the agentic workflow and require explicit PM confirmation before booking.
- [ ] **Loading, empty and error states** — Standardized loading spinners, empty states with clear explanatory text, and actionable error panels are implemented across all hierarchy trees and charts.
- [ ] **House design system** — Strict compliance with house styling: monospace tabular numerals, right-aligned monetary values, single accent (#6aa5e0), 1px solid low-contrast borders, no drop shadows.
- [ ] **Crumbs and record links** — Header breadcrumb links Client -> Sleeve -> Golden Record using surface-links.ts.

## UX notes

- Replaced generic modal shadows with 1px border dialogs matching institutional styling.
- Ensured all numeric columns ($ Dollars, # Investments, % Share, Velocity, Run Rate) use tabular numerals and right text alignment.
- Replaced colored emoji status indicators with standardized status pills (.cpill, .pill) adhering to the house design tokens.
- Added direct SVG labels to pacing bar charts, removing floating external tooltips.
- Integrated unified keyboard navigation (Tab between Min/Target/Max, Enter to commit and advance down tree rows).

## Build steps

1. **Seed Attributes in Catalog** — Create new attributes FUND_TARGET_INVESTMENT_COUNT, FUND_ANNUAL_DEPLOYMENT_TARGET, FUND_TARGET_PERCENT_BASIS, and FUND_TARGET_MATRIX on the FUND domain.
   Files: `supabase/seed/20261123000000_ocio_target_manager_attributes.sql`
2. **Implement SDK Surface Component** — Create the client surface package under surfaces/ocio-target-manager/ using React and @tapestrai/surface-sdk with full tree-grid interactions, inline editing, and compliance integration.
   Files: `surfaces/ocio-target-manager/package.json`, `surfaces/ocio-target-manager/src/index.tsx`, `surfaces/ocio-target-manager/src/components/HeaderRibbon.tsx`, `surfaces/ocio-target-manager/src/components/TargetTreeGrid.tsx`, `surfaces/ocio-target-manager/src/components/PacingPane.tsx`, `surfaces/ocio-target-manager/src/components/CompliancePane.tsx`, `surfaces/ocio-target-manager/src/components/CommitmentsPane.tsx`, `surfaces/ocio-target-manager/src/lib/tree-calculations.ts`
3. **Register Surface in App Registry** — Register 'ocio-target-manager' in apps/web/lib/surface-registry.ts and map it to the FUND domain.
   Files: `apps/web/lib/surface-registry.ts`

## HTML artifacts

### Mandate Target Manager Refined Host Surface

Production-ready HTML/CSS/JS mock demonstrating institutional design system compliance, attribute binding annotations, tree grid interactions, and ribbon status.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OCIO Mandate Target Manager</title>
<style>
:root {
  --bg: #0d1117; --panel: #141a22; --panel-2: #1a212b;
  --line: #242d39; --line-2: #2f3a48; --text: #dbe1e8;
  --muted: #8693a4; --faint: #5b6778; --accent: #6aa5e0;
  --accent-dim: rgba(106,165,224,0.14); --ok: #4fb286;
  --warn: #d9a441; --bad: #e0716c;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color-scheme: dark;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.45; overflow: hidden; height: 100vh; }
.app-layout { display: grid; grid-template-rows: 48px 1fr; height: 100vh; }
header.top-bar { display: flex; align-items: center; gap: 16px; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
.brand { font-size: 14px; font-weight: 600; letter-spacing: 0.02em; }
.brand span { color: var(--muted); font-weight: 400; }
.seg { display: inline-flex; border: 1px solid var(--line-2); border-radius: 6px; overflow: hidden; }
.seg button { background: none; border: 0; padding: 5px 12px; color: var(--muted); font-size: 12px; cursor: pointer; border-right: 1px solid var(--line-2); }
.seg button:last-child { border-right: 0; }
.seg button.active { background: var(--accent-dim); color: var(--accent); font-weight: 500; }
.spacer { flex: 1; }
.btn { background: var(--panel-2); border: 1px solid var(--line-2); border-radius: 6px; padding: 5px 12px; color: var(--text); font-size: 12px; cursor: pointer; }
.btn:hover { border-color: var(--accent); }
.main-layout { display: grid; grid-template-columns: 260px 1fr; height: calc(100vh - 48px); overflow: hidden; }
.rail { border-right: 1px solid var(--line); background: var(--panel); overflow-y: auto; padding: 12px 8px; display: flex; flex-direction: column; gap: 4px; }
.rail h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); padding: 4px 8px 8px; }
.ent-item { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; text-decoration: none; color: inherit; }
.ent-item:hover { background: var(--panel-2); }
.ent-item.active { background: var(--accent-dim); border-color: rgba(106,165,224,0.4); }
.ent-row { display: flex; justify-content: space-between; align-items: baseline; }
.ent-name { font-weight: 500; font-size: 13px; }
.ent-sub { font-size: 11px; color: var(--muted); font-family: monospace; font-variant-numeric: tabular-nums; }
.content-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.ribbon { display: flex; border-bottom: 1px solid var(--line); background: var(--panel); overflow-x: auto; }
.rb-cell { padding: 8px 16px; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 2px; min-width: 140px; }
.rb-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.rb-val { font-size: 15px; font-weight: 600; font-family: monospace; font-variant-numeric: tabular-nums; }
.rb-sub { font-size: 11px; color: var(--muted); }
.tabs-bar { display: flex; gap: 4px; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--bg); }
.tab-btn { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 14px; color: var(--muted); font-size: 12px; font-weight: 500; cursor: pointer; }
.tab-btn.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.grid-container { flex: 1; overflow: auto; padding: 0; }
.tree-grid { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; min-width: 1100px; }
.tree-grid th { position: sticky; top: 0; background: var(--panel); border-bottom: 1px solid var(--line); padding: 8px 10px; text-align: left; font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.05em; z-index: 2; }
.tree-grid th.num { text-align: right; }
.tree-grid td { border-bottom: 1px solid var(--line); padding: 6px 10px; height: 36px; vertical-align: middle; }
.tree-grid tr:hover td { background: var(--panel-2); }
.num-cell { text-align: right; font-family: monospace; font-variant-numeric: tabular-nums; }
.pill { display: inline-flex; align-items: center; border-radius: 4px; padding: 1px 6px; font-size: 10.5px; font-weight: 600; font-family: monospace; }
.pill.ok { background: rgba(79,178,134,0.15); color: var(--ok); border: 1px solid rgba(79,178,134,0.4); }
.pill.warn { background: rgba(217,164,65,0.15); color: var(--warn); border: 1px solid rgba(217,164,65,0.4); }
.pill.bad { background: rgba(224,113,108,0.15); color: var(--bad); border: 1px solid rgba(224,113,108,0.4); }
.input-num { background: transparent; border: 1px solid transparent; border-radius: 4px; color: var(--text); font-family: monospace; font-size: 12px; text-align: right; width: 68px; padding: 2px 4px; }
.input-num:hover { border-color: var(--line-2); }
.input-num:focus { outline: 1px solid var(--accent); background: var(--panel); }
</style>
</head>
<body>
<div class="app-layout">
  <header class="top-bar">
    <div class="brand">tapestr.ai <span>/ OCIO Mandate Target Manager</span></div>
    <div class="seg">
      <button class="active">Assign Targets</button>
      <button>Overview</button>
      <button>Pipeline</button>
    </div>
    <div class="spacer"></div>
    <button class="btn">Copy CSV</button>
  </header>
  <div class="main-layout">
    <nav class="rail">
      <h2>Clients &amp; Mandates</h2>
      <div class="ent-item active" data-entity-id="ctr-pe">
        <div class="ent-row">
          <span class="ent-name">PE Primary Sleeve</span>
          <span class="pill ok">On Pace</span>
        </div>
        <div class="ent-row">
          <span class="ent-sub">$1,200M · 30 Inv</span>
          <span class="ent-sub">9 Targets</span>
        </div>
      </div>
      <div class="ent-item" data-entity-id="ctr-cra">
        <div class="ent-row">
          <span class="ent-name">Credit &amp; Real Assets</span>
          <span class="pill warn">Slow Pace</span>
        </div>
        <div class="ent-row">
          <span class="ent-sub">$450M · 14 Inv</span>
          <span class="ent-sub">7 Targets</span>
        </div>
      </div>
    </nav>
    <main class="content-view">
      <div class="ribbon">
        <div class="rb-cell" data-attr="FUND_TOTAL_COMMITMENTS">
          <span class="rb-label">Program Size</span>
          <span class="rb-val">$1,200.0M</span>
          <span class="rb-sub">82% Committed</span>
        </div>
        <div class="rb-cell" data-attr="FUND_TARGET_INVESTMENT_COUNT">
          <span class="rb-label">Investments</span>
          <span class="rb-val">24 / 30</span>
          <span class="rb-sub">6 Remaining</span>
        </div>
        <div class="rb-cell" data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET">
          <span class="rb-label">Annual Target</span>
          <span class="rb-val">$180.0M</span>
          <span class="rb-sub">Current FY Pace</span>
        </div>
        <div class="rb-cell">
          <span class="rb-label">Pacing Velocity</span>
          <span class="rb-val" style="color:var(--ok)">108%</span>
          <span class="rb-sub">Ahead of Schedule</span>
        </div>
        <div class="rb-cell">
          <span class="rb-label">Compliance</span>
          <span class="rb-val"><span class="pill ok">Pass (0 Breaches)</span></span>
          <span class="rb-sub">13 Rules Monitored</span>
        </div>
      </div>
      <div class="tabs-bar">
        <button class="tab-btn active">Strategy (9)</button>
        <button class="tab-btn">Region (3)</button>
        <button class="tab-btn">Structure (5)</button>
        <button class="tab-btn">Pacing</button>
        <button class="tab-btn">Commitments (24)</button>
        <button class="tab-btn">Compliance (13)</button>
      </div>
      <div class="grid-container">
        <table class="tree-grid" data-attr="FUND_TARGET_MATRIX">
          <thead>
            <tr>
              <th>Hierarchy Node</th>
              <th class="num">$ Min</th>
              <th class="num">$ Target</th>
              <th class="num">$ Max</th>
              <th class="num"># Min</th>
              <th class="num"># Target</th>
              <th class="num"># Max</th>
              <th class="num">% Target</th>
              <th class="num">Actual Committed</th>
              <th class="num">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Total Program</strong></td>
              <td class="num-cell">$1,000M</td>
              <td class="num-cell">$1,200M</td>
              <td class="num-cell">$1,300M</td>
              <td class="num-cell">25</td>
              <td class="num-cell">30</td>
              <td class="num-cell">35</td>
              <td class="num-cell">100%</td>
              <td class="num-cell">$984.0M (24)</td>
              <td class="num-cell"><span class="pill ok">In Band</span></td>
            </tr>
            <tr>
              <td style="padding-left:24px;">Primary › Private Equity</td>
              <td class="num-cell"><input class="input-num" value="800.0M"></td>
              <td class="num-cell"><input class="input-num" value="900.0M"></td>
              <td class="num-cell"><input class="input-num" value="1,000.0M"></td>
              <td class="num-cell"><input class="input-num" value="18"></td>
              <td class="num-cell"><input class="input-num" value="22"></td>
              <td class="num-cell"><input class="input-num" value="26"></td>
              <td class="num-cell"><input class="input-num" value="75.0%"></td>
              <td class="num-cell">$745.0M (18)</td>
              <td class="num-cell"><span class="pill ok">In Band</span></td>
            </tr>
            <tr>
              <td style="padding-left:44px;">Buyout</td>
              <td class="num-cell"><input class="input-num" value="450.0M"></td>
              <td class="num-cell"><input class="input-num" value="540.0M"></td>
              <td class="num-cell"><input class="input-num" value="630.0M"></td>
              <td class="num-cell"><input class="input-num" value="7"></td>
              <td class="num-cell"><input class="input-num" value="9"></td>
              <td class="num-cell"><input class="input-num" value="11"></td>
              <td class="num-cell"><input class="input-num" value="60.0%"></td>
              <td class="num-cell">$520.0M (9)</td>
              <td class="num-cell"><span class="pill ok">At Target</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  </div>
</div>
</body>
</html>
```

### Region (house design)

Region, redesigned in the house kit from the captured view and checked against it.

```html
<style>
.x-top{box-shadow:none}
.x-shell{display:grid;grid-template-columns:216px minmax(0,1fr) 280px;gap:12px;align-items:start;margin-top:10px}
.x-shell a.crumb-link{text-decoration:none}
.x-rail{background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.x-ent{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 6px;width:100%;padding:7px 10px;border:0;border-bottom:1px solid var(--line);background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.x-ent.m{padding-left:22px}
.x-ent[aria-current="true"]{background:var(--accent-light);box-shadow:inset 3px 0 0 var(--accent-2)}
.x-ent b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.x-ent .x-r{display:flex;gap:4px;align-items:center}
.x-ent small{grid-column:1/-1;display:flex;gap:6px;align-items:center;color:var(--ink-3);font-size:11.5px}
.x-ent .da-track{margin:0 0 0 auto}.x-ent .da-track i{width:12px}.x-ent .da-track i.on{background:var(--accent-2)}
.x-rail .btn{margin:10px;width:calc(100% - 20px);justify-content:center}
.x-rib .da-title{flex:1 1 100%;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line);padding:12px 16px}
.x-rib .da-facts{grid-template-columns:repeat(4,minmax(0,1fr))}
.x-rib .da-fact{padding:9px 14px}
.x-rib .da-fact.wide{grid-column:span 2}
.x-rib .da-fact:nth-child(3),.x-rib .da-fact:nth-child(7){border-right:0}
.x-rib .da-fact:nth-child(n+4){border-bottom:0}
.x-rib .da-fact strong{white-space:nowrap}
.x-rib .da-fact strong .da-st{margin-left:4px;vertical-align:2px}
.x-acts{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-3)}
.x-rib .fs-track{height:6px;margin:4px 0 2px}
.x-tabs button{display:flex;flex-direction:column;align-items:flex-start;gap:1px;text-align:left;max-width:190px}
.x-tabs button small{font-size:11px;font-weight:400;color:var(--ink-3)}
.x-tl{display:flex;align-items:center;gap:6px;white-space:nowrap}
.x-tabsep{flex:none;width:1px;background:var(--line);margin:8px 6px}
.x-grid{min-width:0;font-size:12.5px}
.x-grid th,.x-grid td{padding:6px 8px}
.x-grid .da-name b{white-space:nowrap}
.x-grid .da-caret{margin-right:0}
.x-grid td.num,.x-grid th.num{white-space:nowrap}
.x-m{width:172px;min-width:172px}
.x-trio{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px}
.x-trio i{font-style:normal;font-size:11px;font-weight:400;color:var(--ink-3);text-align:right}
.x-trio input{width:100%;min-width:0;font:inherit;font-size:12px;padding:2px 4px;border:1px solid var(--line);border-radius:4px;background:var(--surface);color:var(--ink-3);text-align:right}
.x-trio input.tgt{color:var(--ink);font-weight:600}
.x-trio input:disabled{background:var(--bg-alt)}
.x-band{display:grid;grid-template-columns:1fr 50px;gap:6px;align-items:center;margin-top:5px}
.x-trk{position:relative;height:6px;border-radius:3px;background:var(--bg-alt)}
.x-trk i{position:absolute;top:0;bottom:0;border-radius:3px}
.x-trk i.rng{background:var(--line)}
.x-trk i.fill{left:0;top:1px;bottom:1px;background:var(--ink-4)}
.x-trk i.tg{width:2px;top:-3px;bottom:-3px;margin-left:-1px;border-radius:0;background:var(--ink)}
.x-av{font-size:11.5px;text-align:right;color:var(--ink-2);white-space:nowrap}
.x-av.nil{color:var(--ink-4)}
.x-band.in .fill{background:var(--green)}.x-band.in .x-av{color:var(--green)}
.x-band.under .fill{background:var(--accent-2)}
.x-band.below .fill{background:var(--amber)}.x-band.below .x-av{color:var(--amber)}
.x-band.above .fill{background:var(--red)}.x-band.above .x-av{color:var(--red)}
.da-grid tbody tr.x-has td:first-child{box-shadow:inset 3px 0 0 var(--accent-2)}
.x-gh{display:flex;justify-content:space-between;align-items:baseline;width:100%;padding:0;border:0;background:none;font:inherit;color:inherit;cursor:pointer}
.x-gh span{font-size:14px;font-weight:600}.x-gh small{font-size:11.5px;color:var(--ink-3)}
.x-gh.on span{color:var(--accent-2)}
.x-side .da-mini{font-size:12.5px;margin-top:6px}
.x-side .da-mini td:last-child{text-align:right;white-space:nowrap}
.x-d2 td:first-child{padding-left:12px}.x-d3 td:first-child{padding-left:24px}.x-d4 td:first-child{padding-left:36px}
.x-ctx td{color:var(--ink-3)}
.x-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px;background:var(--ink-4)}
.x-dot.in{background:var(--green)}.x-dot.under{background:var(--accent-2)}.x-dot.below{background:var(--amber)}.x-dot.above{background:var(--red)}.x-dot.over{background:var(--gold)}
.x-legend{display:grid;gap:6px;font-size:12px;color:var(--ink-3)}
@media (max-width:1100px){.x-shell{grid-template-columns:1fr}.x-rib .da-facts{grid-template-columns:repeat(2,1fr)}.x-rib .da-fact.wide{grid-column:auto}}
</style>

<div class="da">
  <header class="page-header x-top">
    <div class="page-title-block">
      <div><div class="page-title">Target Manager</div><div class="page-meta">Fund-of-Funds &amp; Directs</div></div>
      <div class="cr-seg" role="group" aria-label="View">
        <button class="on" aria-pressed="true">Assign targets</button>
        <button aria-pressed="false">Overview</button>
        <button aria-pressed="false">Pipeline</button>
      </div>
    </div>
    <div class="page-actions">
      <button class="btn btn-sm" title="Undo last change (Ctrl+Z)" disabled>Undo</button>
      <button class="btn btn-sm" title="Copy all targets as CSV">Copy CSV</button>
      <button class="btn btn-sm" title="Restore the example clients and targets">Reset example</button>
    </div>
  </header>

  <div class="x-shell">
    <!-- Clients & mandates rail -->
    <nav class="x-rail" aria-label="Clients and mandates">
      <div class="cr-phead"><h2>Clients &amp; mandates</h2></div>
      <button class="x-ent" aria-current="false"><b>Commonwealth Teachers’ Retirement</b><span class="x-r"><i class="cr-n">14</i><span class="da-st breach" title="5 compliance breaches">5</span></span><small>$2B · 70 inv <span class="da-st ok" title="2026 pacing velocity">1.04x</span><span class="da-track" title="Strategy: 6 · Region: 4 · Structure: 4"><i class="on"></i><i class="on"></i><i class="on"></i></span></small></button>
      <button class="x-ent m" aria-current="true"><b>PE Primary Sleeve</b><span class="x-r"><i class="cr-n">17</i><span class="da-st breach" title="3 compliance breaches">3</span></span><small>$1.2B · 30 inv <span class="da-st ok" title="2026 pacing velocity">1.06x</span><span class="da-track" title="Strategy: 9 · Region: 3 · Structure: 5"><i class="on"></i><i class="on"></i><i class="on"></i></span></small></button>
      <button class="x-ent m" aria-current="false"><b>Credit &amp; Real Assets Sleeve</b><span class="x-r"><i class="cr-n">9</i></span><small>$450M · 14 inv <span class="da-st breach" title="2026 pacing velocity">0.77x</span><span class="da-track" title="Strategy: 7 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></small></button>
      <button class="x-ent m" aria-current="false"><b>Co-Investment Sleeve</b><span class="x-r"><i class="cr-n">7</i><span class="da-st breach" title="2 compliance breaches">2</span></span><small>$400M · 24 inv <span class="da-st ok" title="2026 pacing velocity">1.14x</span><span class="da-track" title="Strategy: 4 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></small></button>
      <button class="x-ent" aria-current="false"><b>Halvorsen Family Office</b><span class="x-r"><i class="cr-n">3</i><span class="da-st breach" title="1 compliance breach">1</span></span><small>$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="da-track" title="Strategy: 0 · Region: 3 · Structure: 0"><i></i><i class="on"></i><i></i></span></small></button>
      <button class="x-ent m" aria-current="false"><b>Diversified Sleeve</b><span class="x-r"><i class="cr-n">4</i><span class="da-st breach" title="1 compliance breach">1</span></span><small>$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="da-track" title="Strategy: 4 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></small></button>
      <button class="x-ent" aria-current="false"><b>Northgate Mutual Insurance</b><span class="x-r"><i class="cr-n">2</i><span class="da-st breach" title="3 compliance breaches">3</span></span><small>$900M · 40 inv <span class="da-st ok" title="2026 pacing velocity">1.11x</span><span class="da-track" title="Strategy: 2 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></small></button>
      <button class="x-ent m" aria-current="false"><b>Private Credit Sleeve</b><span class="x-r"><i class="cr-n">10</i><span class="da-st breach" title="3 compliance breaches">3</span></span><small>$600M · 28 inv <span class="da-chip" title="2026 pacing velocity">1.16x</span><span class="da-track" title="Strategy: 8 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></small></button>
      <button class="x-ent m" aria-current="false"><b>Secondaries Sleeve</b><span class="x-r"><i class="cr-n">6</i></span><small>$200M · 10 inv <span class="da-st breach" title="2026 pacing velocity">0.85x</span><span class="da-track" title="Strategy: 3 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></small></button>
      <button class="btn btn-sm">+ Add mandate sleeve</button>
    </nav>

    <!-- Main -->
    <main>
      <div class="crumbs"><a class="crumb-link" href="#">Commonwealth Teachers’ Retirement</a><span class="sep">›</span><span class="crumb-current">Mandate sleeve</span></div>

      <header class="da-ribbon x-rib" role="group" aria-label="Deployment and pacing">
        <div class="da-title">
          <div><span class="da-chip">Mandate sleeve</span><h1>PE Primary Sleeve</h1></div>
          <div class="x-acts">
            <span>% basis</span>
            <div class="cr-seg" role="group" aria-label="Percent basis" data-editable="true">
              <button aria-pressed="false" title="Percent targets are a share of the total program">Program</button>
              <button class="on" aria-pressed="true" title="Percent targets are a share of the level above">Parent level</button>
            </div>
            <button class="btn btn-sm">Copy targets from…</button>
          </div>
        </div>
        <div class="da-facts">
          <div class="da-fact big"><span>Program</span><strong>$1.2B</strong><small>74% committed · since Apr 2022</small></div>
          <div class="da-fact"><span>Investments</span><strong>22 <small style="display:inline">/ 30</small></strong><small>made vs target</small></div>
          <div class="da-fact wide"><span>2026 deployment vs target</span><strong>$167M <small style="display:inline">/ $180M</small></strong>
            <div class="fs-track" title="Bar: deployed against the 2026 target. Marker: where pacing says you should be by 17 Nov 2026"><i style="width:92.8%"></i><b style="left:87.7%"></b></div>
            <small>93% of annual · $157.8M expected to date</small></div>
          <div class="da-fact"><span>Pacing velocity</span><strong class="up">1.06x<span class="da-st ok">On pace</span></strong><small>YTD vs time-weighted target</small></div>
          <div class="da-fact"><span>Since inception</span><strong class="up" title="On pace">1.07x</strong><small>$893.9M vs $833.4M</small></div>
          <div class="da-fact"><span>Compliance</span><a href="#" title="Open the compliance tab"><strong class="dn">3 breaches</strong></a><small>13 rules · 1 watch · 2 pending · 2 soft</small></div>
          <div class="da-fact"><span>Run-rate (LTM)</span><strong>$193.5M<small style="display:inline">/yr</small></strong><small>$306.1M left · ≈1.6 yrs at this pace</small></div>
        </div>
      </header>

      <div class="da-tabs x-tabs" role="tablist">
        <button role="tab" aria-selected="false"><span class="x-tl">Strategy <i class="cr-n">9</i></span><small>Category › Asset Class › Strategy › Sub-Strategy</small></button>
        <button role="tab" aria-selected="true" class="on"><span class="x-tl">Region <i class="cr-n">3</i></span><small>Region › Asset Class</small></button>
        <button role="tab" aria-selected="false"><span class="x-tl">Structure <i class="cr-n">5</i></span><small>Category › Structure Type › Detail</small></button>
        <span class="x-tabsep" aria-hidden="true"></span>
        <button role="tab" aria-selected="false"><span class="x-tl">Pacing</span><small>Annual deployment by year</small></button>
        <button role="tab" aria-selected="false"><span class="x-tl">Commitments <i class="cr-n">22</i></span><small>Original commitments and attributes</small></button>
        <button role="tab" aria-selected="false"><span class="x-tl">Compliance <span class="da-st breach">3 breaches</span></span><small>Rules, limits and results</small></button>
      </div>

      <section class="da-sec">
        <div class="da-toolbar" style="margin-top:0">
          <input class="pipe-search" type="search" placeholder="Find a level, e.g. Mid Cap" aria-label="Find a level">
          <label><input type="checkbox"> Assigned only</label>
          <button class="btn btn-sm">Expand all</button>
          <button class="btn btn-sm">Collapse</button>
          <span class="da-note">$ in millions unless you type K or B · Tab across min / target / max · Enter moves down · % of parent level</span>
        </div>

        <div class="da-gridwrap" style="margin-top:10px">
          <table class="da-grid x-grid">
            <thead><tr>
              <th>Region › Asset Class</th>
              <th class="x-m" title="Minimum, target and maximum. The bar shows commitments against the band (shaded) and target (tick).">$ Dollars<div class="x-trio"><i>Min</i><i>Target</i><i>Max</i></div></th>
              <th class="x-m" title="Minimum, target and maximum. The bar shows commitments against the band (shaded) and target (tick)."># Investments<div class="x-trio"><i>Min</i><i>Target</i><i>Max</i></div></th>
              <th class="x-m" title="Minimum, target and maximum. The bar shows commitments against the band (shaded) and target (tick). Actual % is the share of commitments at the level above.">% Percent<div class="x-trio"><i>Min</i><i>Target</i><i>Max</i></div></th>
              <th class="num" title="Sum of the next level's targets compared with this row">Children Σ</th>
              <th class="num" title="This client’s macro target for the same level">Client target</th>
              <th></th>
            </tr></thead>
            <tbody>
              <tr class="par">
                <td><div class="da-name"><button class="da-caret" aria-expanded="true" aria-label="Collapse Total program">▾</button><span class="cr-type other">ALL</span><b>Total program</b></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" aria-label="Total program Dollars min" data-editable="true"><input class="tgt" value="$1.2B" placeholder="—" aria-label="Total program Dollars target" data-editable="true"><input class="mm" placeholder="max" aria-label="Total program Dollars max" data-editable="true"></div>
                  <div class="x-band under" title="Actual $893.9M · target $1.2B · 74% of target"><span class="x-trk"><i class="fill" style="width:62.1%"></i><i class="tg" style="left:83.3%"></i></span><span class="x-av">$893.9M</span></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" value="25" placeholder="min" aria-label="Total program Investments min" data-editable="true"><input class="tgt" value="30" placeholder="—" aria-label="Total program Investments target" data-editable="true"><input class="mm" value="35" placeholder="max" aria-label="Total program Investments max" data-editable="true"></div>
                  <div class="x-band below" title="Actual 22 · target 30 · range 25 to 35 · Below min"><span class="x-trk"><i class="rng" style="left:59.5%;width:23.8%"></i><i class="fill" style="width:52.4%"></i><i class="tg" style="left:71.4%"></i></span><span class="x-av">22</span></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" disabled aria-label="Total program Percent min"><input class="tgt" value="100%" placeholder="—" disabled aria-label="Total program Percent target"><input class="mm" placeholder="max" disabled aria-label="Total program Percent max"></div>
                  <div class="x-band"><span></span><span class="x-av nil">of program</span></div></td>
                <td class="num"><span class="da-st breach" title="Children total $1.26B against $1.2B at this level (3 of 4 children targeted)">$ 105%</span></td>
                <td class="num">$2B · 70#</td>
                <td></td>
              </tr>
              <tr>
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Global">▸</button><span class="cr-type other">RGN</span><b>Global</b></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" aria-label="Global Dollars min" data-editable="true"><input class="tgt" placeholder="—" aria-label="Global Dollars target" data-editable="true"><input class="mm" placeholder="max" aria-label="Global Dollars max" data-editable="true"></div>
                  <div class="x-band"><span class="x-trk"></span><span class="x-av nil">·</span></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" aria-label="Global Investments min" data-editable="true"><input class="tgt" placeholder="—" aria-label="Global Investments target" data-editable="true"><input class="mm" placeholder="max" aria-label="Global Investments max" data-editable="true"></div>
                  <div class="x-band"><span class="x-trk"></span><span class="x-av nil">·</span></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" aria-label="Global Percent min" data-editable="true"><input class="tgt" placeholder="—" aria-label="Global Percent target" data-editable="true"><input class="mm" placeholder="max" aria-label="Global Percent max" data-editable="true"></div>
                  <div class="x-band"><span class="x-trk"></span><span class="x-av nil">·</span></div></td>
                <td class="num"></td>
                <td class="num">·</td>
                <td></td>
              </tr>
              <tr class="x-has">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand North America">▸</button><span class="cr-type other">RGN</span><b>North America</b></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="≈720M" aria-label="North America Dollars min" data-editable="true"><input class="tgt" placeholder="≈840M" aria-label="North America Dollars target" data-editable="true"><input class="mm" placeholder="≈960M" aria-label="North America Dollars max" data-editable="true"></div>
                  <div class="x-band in" title="Actual $748.4M · target $840M · range $720M to $960M · In range · under target"><span class="x-trk"><i class="rng" style="left:62.5%;width:20.8%"></i><i class="fill" style="width:65%"></i><i class="tg" style="left:72.9%"></i></span><span class="x-av">$748.4M</span></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" aria-label="North America Investments min" data-editable="true"><input class="tgt" placeholder="—" aria-label="North America Investments target" data-editable="true"><input class="mm" placeholder="max" aria-label="North America Investments max" data-editable="true"></div>
                  <div class="x-band none" title="Actual 18 · No target"><span class="x-trk"><i class="fill" style="width:83.3%"></i></span><span class="x-av">18</span></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" value="60%" placeholder="min" aria-label="North America Percent min" data-editable="true"><input class="tgt" value="70%" placeholder="—" aria-label="North America Percent target" data-editable="true"><input class="mm" value="80%" placeholder="max" aria-label="North America Percent max" data-editable="true"></div>
                  <div class="x-band above" title="Actual 83.7% of committed · target 70% · range 60% to 80% · Above max"><span class="x-trk"><i class="rng" style="left:60%;width:20%"></i><i class="fill" style="width:83.7%"></i><i class="tg" style="left:70%"></i></span><span class="x-av">83.7%</span></div></td>
                <td class="num"></td>
                <td class="num">$1.3B · 65%</td>
                <td><button class="btn btn-sm" title="Clear targets on this row" aria-label="Clear North America targets">×</button></td>
              </tr>
              <tr class="x-has">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Western Europe">▸</button><span class="cr-type other">RGN</span><b>Western Europe</b></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" aria-label="Western Europe Dollars min" data-editable="true"><input class="tgt" placeholder="≈300M" aria-label="Western Europe Dollars target" data-editable="true"><input class="mm" placeholder="max" aria-label="Western Europe Dollars max" data-editable="true"></div>
                  <div class="x-band under" title="Actual $78M · target $300M · 26% of target"><span class="x-trk"><i class="fill" style="width:21.7%"></i><i class="tg" style="left:83.3%"></i></span><span class="x-av">$78M</span></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" aria-label="Western Europe Investments min" data-editable="true"><input class="tgt" placeholder="—" aria-label="Western Europe Investments target" data-editable="true"><input class="mm" placeholder="max" aria-label="Western Europe Investments max" data-editable="true"></div>
                  <div class="x-band none" title="Actual 2 · No target"><span class="x-trk"><i class="fill" style="width:83.3%"></i></span><span class="x-av">2</span></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" aria-label="Western Europe Percent min" data-editable="true"><input class="tgt" value="25%" placeholder="—" aria-label="Western Europe Percent target" data-editable="true"><input class="mm" placeholder="max" aria-label="Western Europe Percent max" data-editable="true"></div>
                  <div class="x-band under" title="Actual 8.7% of committed · target 25% · 35% of target"><span class="x-trk"><i class="fill" style="width:29%"></i><i class="tg" style="left:83.3%"></i></span><span class="x-av">8.7%</span></div></td>
                <td class="num"></td>
                <td class="num">$500M · 25%</td>
                <td><button class="btn btn-sm" title="Clear targets on this row" aria-label="Clear Western Europe targets">×</button></td>
              </tr>
              <tr class="x-has">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand APAC/ROW">▸</button><span class="cr-type other">RGN</span><b>APAC/ROW</b></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" aria-label="APAC/ROW Dollars min" data-editable="true"><input class="tgt" placeholder="≈120M" aria-label="APAC/ROW Dollars target" data-editable="true"><input class="mm" placeholder="≈180M" aria-label="APAC/ROW Dollars max" data-editable="true"></div>
                  <div class="x-band in" title="Actual $67.5M · target $120M · range … to $180M · In range · under target"><span class="x-trk"><i class="rng" style="left:0;width:83.3%"></i><i class="fill" style="width:31.3%"></i><i class="tg" style="left:55.6%"></i></span><span class="x-av">$67.5M</span></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" aria-label="APAC/ROW Investments min" data-editable="true"><input class="tgt" placeholder="—" aria-label="APAC/ROW Investments target" data-editable="true"><input class="mm" placeholder="max" aria-label="APAC/ROW Investments max" data-editable="true"></div>
                  <div class="x-band none" title="Actual 2 · No target"><span class="x-trk"><i class="fill" style="width:83.3%"></i></span><span class="x-av">2</span></div></td>
                <td class="x-m"><div class="x-trio"><input class="mm" placeholder="min" aria-label="APAC/ROW Percent min" data-editable="true"><input class="tgt" value="10%" placeholder="—" aria-label="APAC/ROW Percent target" data-editable="true"><input class="mm" value="15%" placeholder="max" aria-label="APAC/ROW Percent max" data-editable="true"></div>
                  <div class="x-band in" title="Actual 7.6% of committed · target 10% · range … to 15% · In range · under target"><span class="x-trk"><i class="rng" style="left:0;width:83.3%"></i><i class="fill" style="width:42.2%"></i><i class="tg" style="left:55.6%"></i></span><span class="x-av">7.6%</span></div></td>
                <td class="num"></td>
                <td class="num">$200M · 10%</td>
                <td><button class="btn btn-sm" title="Clear targets on this row" aria-label="Clear APAC/ROW targets">×</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>

    <!-- Assigned targets side panel -->
    <aside class="da-panel x-side" aria-label="Assigned targets">
      <div class="da-ph"><h3>Assigned targets</h3></div>

      <section>
        <button class="x-gh" title="Open the Strategy targets"><span>Strategy</span><small>9 targets</small></button>
        <p class="da-note">Category › Asset Class › Strategy › Sub-Strategy</p>
        <table class="da-mini"><tbody>
          <tr class="link"><td><i class="x-dot in" title="In range · under target"></i><b>Primary</b><small>range $800M–$1B · 18–26#</small></td><td><b>$900M</b> ≈75% <b>22#</b></td></tr>
          <tr class="link x-d2"><td><i class="x-dot under" title="93% of target"></i>Private Equity</td><td>≈$900M <b>100%</b></td></tr>
          <tr class="link x-d3"><td><i class="x-dot above" title="Above max"></i>Buyout<small>range 7–11# · 50%–70%</small></td><td>≈$540M <b>60%</b> <b>9#</b></td></tr>
          <tr class="link x-d4"><td><i class="x-dot under" title="71% of target"></i>Small Cap</td><td>≈$135M <b>25%</b></td></tr>
          <tr class="link x-d4"><td><i class="x-dot above" title="Above max"></i>Mid Cap<small>range 35%–55%</small></td><td>≈$243M <b>45%</b></td></tr>
          <tr class="link x-d4"><td><i class="x-dot under" title="91% of target"></i>Large Cap</td><td>≈$108M <b>20%</b></td></tr>
          <tr class="link x-d3"><td><i class="x-dot under" title="67% of target"></i>Growth Equity<small>range 10%–20%</small></td><td>≈$135M <b>15%</b> <b>3#</b></td></tr>
          <tr class="link x-d3"><td><i class="x-dot under" title="75% of target"></i>Venture Capital<small>range 10%–25%</small></td><td>≈$180M <b>20%</b> <b>4#</b></td></tr>
          <tr class="link"><td><i class="x-dot below" title="Below min"></i><b>Secondary</b><small>range $200M–…</small></td><td><b>$300M</b> ≈25% <b>8#</b></td></tr>
        </tbody></table>
      </section>

      <section>
        <button class="x-gh on" title="Open the Region targets"><span>Region</span><small>3 targets</small></button>
        <p class="da-note">Region › Asset Class</p>
        <table class="da-mini"><tbody>
          <tr class="link"><td><i class="x-dot above" title="Above max"></i><b>North America</b><small>range 60%–80%</small></td><td>≈$840M <b>70%</b></td></tr>
          <tr class="link"><td><i class="x-dot under" title="26% of target"></i><b>Western Europe</b></td><td>≈$300M <b>25%</b></td></tr>
          <tr class="link"><td><i class="x-dot in" title="In range · under target"></i><b>APAC/ROW</b><small>range …–15%</small></td><td>≈$120M <b>10%</b></td></tr>
        </tbody></table>
      </section>

      <section>
        <button class="x-gh" title="Open the Structure targets"><span>Structure</span><small>5 targets</small></button>
        <p class="da-note">Category › Structure Type › Detail</p>
        <table class="da-mini"><tbody>
          <tr class="link x-ctx"><td><b>Primary</b></td><td><small>no target</small></td></tr>
          <tr class="link x-d2"><td><i class="x-dot over" title="Over target"></i>Traditional Primary</td><td><b>85%</b></td></tr>
          <tr class="link x-d2"><td><i class="x-dot under" title="63% of target"></i>Fund-of-Funds</td><td><b>5%</b></td></tr>
          <tr class="link x-ctx"><td><b>Secondary</b></td><td><small>no target</small></td></tr>
          <tr class="link x-d2"><td><i class="x-dot under" title="48% of target"></i>GP Led</td><td><b>$120M</b></td></tr>
          <tr class="link x-d3"><td><i class="x-dot under" title="72% of target"></i>Single Asset</td><td><b>$80M</b> ≈66.7%</td></tr>
          <tr class="link x-d3"><td><i class="x-dot under" title="0% of target"></i>Multi Asset</td><td><b>$60M</b> ≈50%</td></tr>
        </tbody></table>
      </section>

      <section class="x-legend">
        <div><span class="da-st ok">$ 100%</span> next level adds up</div>
        <div><span class="da-st near">$ 85%</span> next level is under</div>
        <div><span class="da-st breach">$ 105%</span> next level is over</div>
        <div>Dots show the worst band status on the row: <i class="x-dot in"></i>in range <i class="x-dot below"></i>below min <i class="x-dot above"></i>above max <i class="x-dot under"></i>building to target.</div>
        <div>Values with ≈ are implied from the other measure. Muted rows have no target of their own but hold targets below.</div>
      </section>
    </aside>
  </div>
</div>
```

### Structure (house design)

Structure, redesigned in the house kit from the captured view and checked against it.

```html
<style>
.x-top{box-shadow:none;margin-bottom:0}
.x-shell{display:grid;grid-template-columns:220px minmax(0,1fr) 288px;gap:14px;align-items:start;margin-top:10px}
.x-crumbs .crumb-link{text-decoration:none}
.x-ribbon{border-radius:8px}
.fs .x-ribbon .da-title{flex:1 1 100%;min-width:0;border-right:0;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.x-ribbon .da-toolbar{margin:0}
.da-facts.x-f7{grid-template-columns:1fr 0.9fr 1.6fr 1fr 1fr 1.1fr 1.1fr}
.x-f7 .da-fact{border-bottom:0}
.x-f7 .da-fact:last-child{border-right:0}
.x-f7 .da-fact strong{white-space:nowrap}
.fs-track.x-pace{height:8px;margin:4px 0 2px}
.x-clk{cursor:pointer}
.x-seg{display:inline-flex}
.x-seg button{font:inherit;font-size:12px;padding:5px 12px;color:var(--ink-3);white-space:nowrap}
.x-seg button+button{border-left:1px solid var(--line)}
.x-tabs button{flex:1 1 auto;min-width:0;text-align:left}
.x-tl{display:flex;align-items:center;gap:6px;white-space:nowrap}
.x-tabs button small{display:block;font-size:11px;font-weight:400;color:var(--ink-3)}
.x-tabsep{flex:none;width:1px;margin:8px 4px;background:var(--line)}
.x-rail{position:sticky;top:8px;display:flex;flex-direction:column;gap:2px;padding:10px 8px;background:var(--surface);border:1px solid var(--line);border-radius:8px}
.x-rail h2{padding:2px 8px 6px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3)}
.x-ent{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:2px 6px;align-items:center;width:100%;padding:6px 8px;border:0;border-radius:8px;background:none;font:inherit;color:var(--ink);text-align:left;cursor:pointer}
.x-ent.mandate{padding-left:20px}
.x-ent .nm{overflow:hidden;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.x-ent .sub{grid-column:1/-1;display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ink-3)}
.x-ent[aria-current="true"]{background:var(--bg-alt);box-shadow:inset 3px 0 0 var(--accent-2)}
.x-rail .btn{justify-content:center;margin-top:8px}
.x-lens{display:inline-flex;gap:2px;margin-left:auto}
.x-lens i{width:12px;height:4px;border-radius:2px;background:var(--line)}
.x-lens i.on{background:var(--accent-2)}
.x-tree{min-width:1040px}
.x-tree th:first-child,.x-tree td:first-child{white-space:nowrap;min-width:240px}
.x-tree tr.x-d0 td{background:var(--bg-alt)}
.x-tree tr.x-d1 td:first-child{padding-left:28px}
.x-tree tr.x-d2 td:first-child{padding-left:52px}
.x-tree tr.x-has td:first-child{box-shadow:inset 3px 0 0 var(--accent-2)}
.x-tree th.x-mh{min-width:200px}
.x-leaf{visibility:hidden}
.x-tag{font-size:10px;font-weight:600;color:var(--ink-3);border:1px solid var(--line);border-radius:4px;padding:0 5px}
.x-trio{display:grid;grid-template-columns:1fr 1.25fr 1fr;gap:4px}
.x-trio i{font-style:normal;font-size:11px;font-weight:400;color:var(--ink-3);text-align:right}
.x-trio input{width:100%;min-width:0;padding:2px 6px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink);font:inherit;font-size:12px;text-align:right}
.x-trio input.tgt{font-weight:600}
.x-trio input:disabled{background:var(--bg-alt);color:var(--ink-3)}
.x-band{display:flex;align-items:center;gap:8px;margin-top:5px}
.x-trk{position:relative;flex:1;height:6px;border-radius:3px;background:var(--bg-alt)}
.x-trk .x-rng{position:absolute;top:0;bottom:0;background:var(--line)}
.x-trk .x-fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--line-strong)}
.x-trk .x-tg{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink)}
.x-av{min-width:58px;font-size:12px;color:var(--ink-3);text-align:right}
.x-band.under .x-fill{background:var(--accent-2)}
.x-band.below .x-fill{background:var(--amber)}
.x-band.over .x-fill{background:var(--red)}
.x-band.over .x-av{color:var(--red)}
.x-band.below .x-av{color:var(--amber)}
.x-dot{display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:50%;background:var(--ink-4)}
.x-dot.in{background:var(--green)}
.x-dot.below{background:var(--amber)}
.x-dot.above,.x-dot.over{background:var(--red)}
.x-dot.under{background:var(--accent-2)}
.x-side .da-mini td:first-child{width:54%;font-weight:500}
.x-side tr.x-s2 td:first-child{padding-left:12px}
.x-side tr.x-s3 td:first-child{padding-left:24px}
.x-side tr.x-s4 td:first-child{padding-left:36px}
.x-side tr.x-ctx td{color:var(--ink-3)}
.x-side small{padding-left:14px}
.x-imp{color:var(--ink-3)}
.x-side .da-note{margin:2px 0 6px}
.x-legend p{margin:0 0 6px}
@media (max-width:1100px){.x-shell{grid-template-columns:1fr}.x-rail{position:static}}
</style>
<div class="da">

  <header class="page-header x-top">
    <div class="page-title-block">
      <div class="page-title">Target Manager</div>
      <span class="page-meta">· Fund-of-Funds &amp; Directs</span>
      <div class="da-seg2 x-seg" role="group" aria-label="View">
        <button id="vEdit" aria-pressed="true">Assign targets</button>
        <button id="vOv" aria-pressed="false">Overview</button>
        <button id="vPipe" aria-pressed="false">Pipeline</button>
      </div>
    </div>
    <div class="page-actions">
      <button class="btn btn-sm" id="undoBtn" title="Undo last change (Ctrl+Z)" disabled>Undo</button>
      <button class="btn btn-sm" id="exportBtn" title="Copy all targets as CSV">Copy CSV</button>
      <button class="btn btn-sm" id="resetBtn" title="Restore the example clients and targets">Reset example</button>
    </div>
  </header>

  <div class="x-shell">

    <nav class="x-rail" id="rail" aria-label="Clients and mandates">
      <h2>Clients &amp; mandates</h2>
      <button class="x-ent client" data-ent="ctr" aria-current="false"><span class="nm">Commonwealth Teachers’ Retirement</span><span class="cr-n">14</span><span class="da-st breach" title="5 compliance breaches">5</span><span class="sub">$2B · 70 inv <span class="da-st ok" title="2026 pacing velocity">1.04x</span><span class="x-lens" title="Strategy: 6 · Region: 4 · Structure: 4"><i class="on"></i><i class="on"></i><i class="on"></i></span></span></button>
      <button class="x-ent mandate" data-ent="ctr-pe" aria-current="true"><span class="nm">PE Primary Sleeve</span><span class="cr-n">17</span><span class="da-st breach" title="3 compliance breaches">3</span><span class="sub">$1.2B · 30 inv <span class="da-st ok" title="2026 pacing velocity">1.06x</span><span class="x-lens" title="Strategy: 9 · Region: 3 · Structure: 5"><i class="on"></i><i class="on"></i><i class="on"></i></span></span></button>
      <button class="x-ent mandate" data-ent="ctr-cra" aria-current="false"><span class="nm">Credit &amp; Real Assets Sleeve</span><span class="cr-n">9</span><span></span><span class="sub">$450M · 14 inv <span class="da-st breach" title="2026 pacing velocity">0.77x</span><span class="x-lens" title="Strategy: 7 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span></button>
      <button class="x-ent mandate" data-ent="ctr-co" aria-current="false"><span class="nm">Co-Investment Sleeve</span><span class="cr-n">7</span><span class="da-st breach" title="2 compliance breaches">2</span><span class="sub">$400M · 24 inv <span class="da-st ok" title="2026 pacing velocity">1.14x</span><span class="x-lens" title="Strategy: 4 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span></button>
      <button class="x-ent client" data-ent="hfo" aria-current="false"><span class="nm">Halvorsen Family Office</span><span class="cr-n">3</span><span class="da-st breach" title="1 compliance breach">1</span><span class="sub">$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="x-lens" title="Strategy: 0 · Region: 3 · Structure: 0"><i></i><i class="on"></i><i></i></span></span></button>
      <button class="x-ent mandate" data-ent="hfo-div" aria-current="false"><span class="nm">Diversified Sleeve</span><span class="cr-n">4</span><span class="da-st breach" title="1 compliance breach">1</span><span class="sub">$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="x-lens" title="Strategy: 4 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span></button>
      <button class="x-ent client" data-ent="nmi" aria-current="false"><span class="nm">Northgate Mutual Insurance</span><span class="cr-n">2</span><span class="da-st breach" title="3 compliance breaches">3</span><span class="sub">$900M · 40 inv <span class="da-st ok" title="2026 pacing velocity">1.11x</span><span class="x-lens" title="Strategy: 2 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span></button>
      <button class="x-ent mandate" data-ent="nmi-pc" aria-current="false"><span class="nm">Private Credit Sleeve</span><span class="cr-n">10</span><span class="da-st breach" title="3 compliance breaches">3</span><span class="sub">$600M · 28 inv <span class="da-chip" title="2026 pacing velocity">1.16x</span><span class="x-lens" title="Strategy: 8 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span></button>
      <button class="x-ent mandate" data-ent="nmi-sec" aria-current="false"><span class="nm">Secondaries Sleeve</span><span class="cr-n">6</span><span></span><span class="sub">$200M · 10 inv <span class="da-st breach" title="2026 pacing velocity">0.85x</span><span class="x-lens" title="Strategy: 3 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span></button>
      <button class="btn btn-sm" id="addSleeve">+ Add mandate sleeve</button>
    </nav>

    <main id="main">
      <div class="crumbs x-crumbs"><a class="crumb-link" href="#">Commonwealth Teachers’ Retirement</a><span class="sep">›</span><span class="crumb-current">Mandate sleeve</span></div>

      <div class="fs">
        <header class="da-ribbon x-ribbon">
          <div class="da-title">
            <h1>PE Primary Sleeve</h1>
            <div class="da-toolbar">
              <label>% basis</label>
              <div class="da-seg2 x-seg" role="group" aria-label="Percent basis" data-editable="true">
                <button data-basis="program" aria-pressed="false" title="Percent targets are a share of the total program">Program</button>
                <button data-basis="parent" aria-pressed="true" title="Percent targets are a share of the level above">Parent level</button>
              </div>
              <button class="btn btn-sm" id="copyFrom">Copy targets from…</button>
            </div>
          </div>
          <div class="da-facts x-f7" role="group" aria-label="Deployment and pacing">
            <div class="da-fact big"><span>Program</span><strong>$1.2B</strong><small>74% committed · since Apr 2022</small></div>
            <div class="da-fact"><span>Investments</span><strong>22 <small>/ 30</small></strong><small>made vs target</small></div>
            <div class="da-fact"><span>2026 deployment vs target</span><strong>$167M <small>/ $180M</small></strong><div class="fs-track x-pace" title="Bar: deployed against the 2026 target. Marker: where pacing says you should be by 17 Nov 2026"><i style="width:93%"></i><b style="left:87.7%"></b></div><small>93% of annual · $157.8M expected to date</small></div>
            <div class="da-fact"><span>Pacing velocity</span><strong class="up">1.06x <span class="da-st ok">On pace</span></strong><small>YTD vs time-weighted target</small></div>
            <div class="da-fact"><span>Since inception</span><strong class="up" title="On pace">1.07x</strong><small>$893.9M vs $833.4M</small></div>
            <div class="da-fact x-clk" data-tab="compliance" role="button" tabindex="0" title="Open the compliance tab"><span>Compliance</span><strong class="dn">3 breaches</strong><small>13 rules · 1 watch · 2 pending · 2 soft</small></div>
            <div class="da-fact"><span>Run-rate (LTM)</span><strong>$193.5M<small>/yr</small></strong><small>$306.1M left · ≈1.6 yrs at this pace</small></div>
          </div>
        </header>

        <div class="da-tabs x-tabs" role="tablist">
          <button role="tab" data-tab="strategy" aria-selected="false"><span class="x-tl">Strategy <span class="cr-n">9</span></span><small>Category › Asset Class › Strategy › Sub-Strategy</small></button>
          <button role="tab" data-tab="region" aria-selected="false"><span class="x-tl">Region <span class="cr-n">3</span></span><small>Region › Asset Class</small></button>
          <button class="on" role="tab" data-tab="structure" aria-selected="true"><span class="x-tl">Structure <span class="cr-n">5</span></span><small>Category › Structure Type › Detail</small></button>
          <span class="x-tabsep" aria-hidden="true"></span>
          <button role="tab" data-tab="pacing" aria-selected="false"><span class="x-tl">Pacing</span><small>Annual deployment by year</small></button>
          <button role="tab" data-tab="holdings" aria-selected="false"><span class="x-tl">Commitments <span class="cr-n">22</span></span><small>Original commitments and attributes</small></button>
          <button role="tab" data-tab="compliance" aria-selected="false"><span class="x-tl">Compliance <span class="da-st breach">3 breaches</span></span><small>Rules, limits and results</small></button>
        </div>
      </div>

      <section class="da-sec">
        <div class="da-toolbar">
          <input class="pipe-search" id="search" type="search" placeholder="Find a level, e.g. Mid Cap" aria-label="Find a level">
          <label><input type="checkbox" id="assignedOnly" value="on"> Assigned only</label>
          <button class="btn btn-sm" id="expandAll">Expand all</button>
          <button class="btn btn-sm" id="collapseAll">Collapse</button>
          <span class="da-note">$ in millions unless you type K or B · Tab across min / target / max · Enter moves down · % of parent level</span>
        </div>

        <div class="da-main solo">
          <div class="da-gridwrap" id="gridwrap">
            <table class="da-grid x-tree">
              <thead>
                <tr>
                  <th>Category › Structure Type › Detail</th>
                  <th class="num x-mh" title="Minimum, target and maximum. The bar shows commitments against the band (shaded) and target (tick).">$ Dollars<span class="x-trio"><i>Min</i><i>Target</i><i>Max</i></span></th>
                  <th class="num x-mh" title="Minimum, target and maximum. The bar shows commitments against the band (shaded) and target (tick)."># Investments<span class="x-trio"><i>Min</i><i>Target</i><i>Max</i></span></th>
                  <th class="num x-mh" title="Minimum, target and maximum. The bar shows commitments against the band (shaded) and target (tick). Actual % is the share of commitments at the level above.">% Percent<span class="x-trio"><i>Min</i><i>Target</i><i>Max</i></span></th>
                  <th class="num" title="Sum of the next level's targets compared with this row">Children Σ</th>
                  <th class="num" title="This client’s macro target for the same level">Client target</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="tbody">

                <tr class="x-d0" data-key="">
                  <td><div class="da-name"><button class="da-caret" aria-expanded="true" aria-label="Collapse Total program">▾</button><span class="x-tag">ALL</span><b>Total program</b></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Total program Dollars min" data-editable="true"><input class="tgt" data-col="usd" value="$1.2B" placeholder="—" aria-label="Total program Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Total program Dollars max" data-editable="true"></div><div class="x-band under" title="Actual $893.9M · target $1.2B · 74% of target"><span class="x-trk"><i class="x-fill" style="width:63%"></i><i class="x-tg" style="left:85%"></i></span><span class="x-av">$893.9M</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" value="25" placeholder="min" aria-label="Total program Investments min" data-editable="true"><input class="tgt" data-col="n" value="30" placeholder="—" aria-label="Total program Investments target" data-editable="true"><input data-col="nMax" value="35" placeholder="max" aria-label="Total program Investments max" data-editable="true"></div><div class="x-band below" title="Actual 22 · target 30 · range 25 to 35 · Below min"><span class="x-trk"><i class="x-rng" style="left:62.5%;width:25%"></i><i class="x-fill" style="width:55%"></i><i class="x-tg" style="left:75%"></i></span><span class="x-av">22</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" disabled aria-label="Total program Percent min"><input class="tgt" data-col="pct" value="100%" placeholder="—" disabled aria-label="Total program Percent target"><input data-col="pctMax" placeholder="max" disabled aria-label="Total program Percent max"></div><div class="x-band"><span class="x-av">of program</span></div></td>
                  <td class="num"></td>
                  <td class="num">$2B · 70#</td>
                  <td></td>
                </tr>

                <tr class="x-d1" data-key="Primary">
                  <td><div class="da-name"><button class="da-caret" aria-expanded="true" aria-label="Collapse Primary">▾</button><span class="x-tag">CAT</span><b>Primary</b></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Primary Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="Primary Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Primary Dollars max" data-editable="true"></div><div class="x-band" title="Actual $836.4M · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">$836.4M</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="Primary Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="Primary Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="Primary Investments max" data-editable="true"></div><div class="x-band" title="Actual 20 · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">20</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="Primary Percent min" data-editable="true"><input class="tgt" data-col="pct" placeholder="—" aria-label="Primary Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="Primary Percent max" data-editable="true"></div><div class="x-band" title="Actual 93.6% of committed · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">93.6%</span></div></td>
                  <td class="num"></td>
                  <td class="num">·</td>
                  <td></td>
                </tr>

                <tr class="x-d2 x-has" data-key="Primary › Traditional Primary">
                  <td><div class="da-name"><button class="da-caret x-leaf" aria-expanded="false" aria-label="Expand Traditional Primary" tabindex="-1">▸</button><span class="x-tag">TYPE</span><span>Traditional Primary</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Traditional Primary Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="Traditional Primary Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Traditional Primary Dollars max" data-editable="true"></div><div class="x-band" title="Actual $809.9M · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">$809.9M</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="Traditional Primary Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="Traditional Primary Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="Traditional Primary Investments max" data-editable="true"></div><div class="x-band" title="Actual 19 · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">19</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="Traditional Primary Percent min" data-editable="true"><input class="tgt" data-col="pct" value="85%" placeholder="—" aria-label="Traditional Primary Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="Traditional Primary Percent max" data-editable="true"></div><div class="x-band over" title="Actual 96.8% of committed · target 85% · Over target"><span class="x-trk"><i class="x-fill" style="width:96.8%"></i><i class="x-tg" style="left:85%"></i></span><span class="x-av">96.8%</span></div></td>
                  <td class="num"></td>
                  <td class="num">·</td>
                  <td><button class="btn btn-sm" data-clear title="Clear targets on this row" aria-label="Clear Traditional Primary targets">×</button></td>
                </tr>

                <tr class="x-d2 x-has" data-key="Primary › Fund-of-Funds">
                  <td><div class="da-name"><button class="da-caret x-leaf" aria-expanded="false" aria-label="Expand Fund-of-Funds" tabindex="-1">▸</button><span class="x-tag">TYPE</span><span>Fund-of-Funds</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Fund-of-Funds Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="Fund-of-Funds Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Fund-of-Funds Dollars max" data-editable="true"></div><div class="x-band" title="Actual $26.5M · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">$26.5M</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="Fund-of-Funds Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="Fund-of-Funds Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="Fund-of-Funds Investments max" data-editable="true"></div><div class="x-band" title="Actual 1 · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">1</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="Fund-of-Funds Percent min" data-editable="true"><input class="tgt" data-col="pct" value="5%" placeholder="—" aria-label="Fund-of-Funds Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="Fund-of-Funds Percent max" data-editable="true"></div><div class="x-band under" title="Actual 3.2% of committed · target 5% · 63% of target"><span class="x-trk"><i class="x-fill" style="width:54%"></i><i class="x-tg" style="left:85%"></i></span><span class="x-av">3.2%</span></div></td>
                  <td class="num"></td>
                  <td class="num">·</td>
                  <td><button class="btn btn-sm" data-clear title="Clear targets on this row" aria-label="Clear Fund-of-Funds targets">×</button></td>
                </tr>

                <tr class="x-d2" data-key="Primary › Secondary Fund">
                  <td><div class="da-name"><button class="da-caret x-leaf" aria-expanded="false" aria-label="Expand Secondary Fund" tabindex="-1">▸</button><span class="x-tag">TYPE</span><span>Secondary Fund</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Secondary Fund Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="Secondary Fund Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Secondary Fund Dollars max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="Secondary Fund Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="Secondary Fund Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="Secondary Fund Investments max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="Secondary Fund Percent min" data-editable="true"><input class="tgt" data-col="pct" placeholder="—" aria-label="Secondary Fund Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="Secondary Fund Percent max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"></td>
                  <td class="num">·</td>
                  <td></td>
                </tr>

                <tr class="x-d2" data-key="Primary › Co-Investment Fund">
                  <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Co-Investment Fund">▸</button><span class="x-tag">TYPE</span><span>Co-Investment Fund</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Co-Investment Fund Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="Co-Investment Fund Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Co-Investment Fund Dollars max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="Co-Investment Fund Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="Co-Investment Fund Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="Co-Investment Fund Investments max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="Co-Investment Fund Percent min" data-editable="true"><input class="tgt" data-col="pct" placeholder="—" aria-label="Co-Investment Fund Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="Co-Investment Fund Percent max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"></td>
                  <td class="num">·</td>
                  <td></td>
                </tr>

                <tr class="x-d2" data-key="Primary › Delayed Primary">
                  <td><div class="da-name"><button class="da-caret x-leaf" aria-expanded="false" aria-label="Expand Delayed Primary" tabindex="-1">▸</button><span class="x-tag">TYPE</span><span>Delayed Primary</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Delayed Primary Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="Delayed Primary Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Delayed Primary Dollars max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="Delayed Primary Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="Delayed Primary Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="Delayed Primary Investments max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="Delayed Primary Percent min" data-editable="true"><input class="tgt" data-col="pct" placeholder="—" aria-label="Delayed Primary Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="Delayed Primary Percent max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"></td>
                  <td class="num">·</td>
                  <td></td>
                </tr>

                <tr class="x-d2" data-key="Primary › Open-Ended / Evergreen">
                  <td><div class="da-name"><button class="da-caret x-leaf" aria-expanded="false" aria-label="Expand Open-Ended / Evergreen" tabindex="-1">▸</button><span class="x-tag">TYPE</span><span>Open-Ended / Evergreen</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Open-Ended / Evergreen Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="Open-Ended / Evergreen Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Open-Ended / Evergreen Dollars max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="Open-Ended / Evergreen Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="Open-Ended / Evergreen Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="Open-Ended / Evergreen Investments max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="Open-Ended / Evergreen Percent min" data-editable="true"><input class="tgt" data-col="pct" placeholder="—" aria-label="Open-Ended / Evergreen Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="Open-Ended / Evergreen Percent max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"></td>
                  <td class="num">·</td>
                  <td></td>
                </tr>

                <tr class="x-d1" data-key="Secondary">
                  <td><div class="da-name"><button class="da-caret" aria-expanded="true" aria-label="Collapse Secondary">▾</button><span class="x-tag">CAT</span><b>Secondary</b></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Secondary Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="Secondary Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Secondary Dollars max" data-editable="true"></div><div class="x-band" title="Actual $57.5M · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">$57.5M</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="Secondary Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="Secondary Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="Secondary Investments max" data-editable="true"></div><div class="x-band" title="Actual 2 · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">2</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="Secondary Percent min" data-editable="true"><input class="tgt" data-col="pct" placeholder="—" aria-label="Secondary Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="Secondary Percent max" data-editable="true"></div><div class="x-band" title="Actual 6.4% of committed · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">6.4%</span></div></td>
                  <td class="num"></td>
                  <td class="num">·</td>
                  <td></td>
                </tr>

                <tr class="x-d2" data-key="Secondary › LP Led">
                  <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand LP Led">▸</button><span class="x-tag">TYPE</span><span>LP Led</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="LP Led Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="LP Led Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="LP Led Dollars max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="LP Led Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="LP Led Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="LP Led Investments max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="LP Led Percent min" data-editable="true"><input class="tgt" data-col="pct" placeholder="—" aria-label="LP Led Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="LP Led Percent max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"></td>
                  <td class="num">$240M · 12%</td>
                  <td></td>
                </tr>

                <tr class="x-d2 x-has" data-key="Secondary › GP Led">
                  <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand GP Led">▸</button><span class="x-tag">TYPE</span><span>GP Led</span><em title="2 targets set below this level">2 below</em></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="GP Led Dollars min" data-editable="true"><input class="tgt" data-col="usd" value="$120M" placeholder="—" aria-label="GP Led Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="GP Led Dollars max" data-editable="true"></div><div class="x-band under" title="Actual $57.5M · target $120M · 48% of target"><span class="x-trk"><i class="x-fill" style="width:41%"></i><i class="x-tg" style="left:85%"></i></span><span class="x-av">$57.5M</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="GP Led Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="GP Led Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="GP Led Investments max" data-editable="true"></div><div class="x-band" title="Actual 2 · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">2</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="GP Led Percent min" data-editable="true"><input class="tgt" data-col="pct" placeholder="—" aria-label="GP Led Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="GP Led Percent max" data-editable="true"></div><div class="x-band" title="Actual 100% of committed · No target"><span class="x-trk"><i class="x-fill" style="width:90%"></i></span><span class="x-av">100%</span></div></td>
                  <td class="num"><span class="da-st breach" title="Children total $140M against $120M at this level (2 of 2 children targeted)">$ 117%</span></td>
                  <td class="num">$160M · 8%</td>
                  <td><button class="btn btn-sm" data-clear title="Clear targets on this row" aria-label="Clear GP Led targets">×</button></td>
                </tr>

                <tr class="x-d2" data-key="Secondary › Complex">
                  <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Complex">▸</button><span class="x-tag">TYPE</span><span>Complex</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Complex Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="Complex Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Complex Dollars max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="Complex Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="Complex Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="Complex Investments max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="Complex Percent min" data-editable="true"><input class="tgt" data-col="pct" placeholder="—" aria-label="Complex Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="Complex Percent max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"></td>
                  <td class="num">·</td>
                  <td></td>
                </tr>

                <tr class="x-d1" data-key="Co-Investment">
                  <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Co-Investment">▸</button><span class="x-tag">CAT</span><b>Co-Investment</b></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Co-Investment Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="Co-Investment Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Co-Investment Dollars max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="Co-Investment Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="Co-Investment Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="Co-Investment Investments max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="Co-Investment Percent min" data-editable="true"><input class="tgt" data-col="pct" placeholder="—" aria-label="Co-Investment Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="Co-Investment Percent max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"></td>
                  <td class="num">·</td>
                  <td></td>
                </tr>

                <tr class="x-d1" data-key="Separate Account">
                  <td><div class="da-name"><button class="da-caret x-leaf" aria-expanded="false" aria-label="Expand Separate Account" tabindex="-1">▸</button><span class="x-tag">CAT</span><b>Separate Account</b></div></td>
                  <td class="num"><div class="x-trio"><input data-col="usdMin" placeholder="min" aria-label="Separate Account Dollars min" data-editable="true"><input class="tgt" data-col="usd" placeholder="—" aria-label="Separate Account Dollars target" data-editable="true"><input data-col="usdMax" placeholder="max" aria-label="Separate Account Dollars max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="nMin" placeholder="min" aria-label="Separate Account Investments min" data-editable="true"><input class="tgt" data-col="n" placeholder="—" aria-label="Separate Account Investments target" data-editable="true"><input data-col="nMax" placeholder="max" aria-label="Separate Account Investments max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"><div class="x-trio"><input data-col="pctMin" placeholder="min" aria-label="Separate Account Percent min" data-editable="true"><input class="tgt" data-col="pct" placeholder="—" aria-label="Separate Account Percent target" data-editable="true"><input data-col="pctMax" placeholder="max" aria-label="Separate Account Percent max" data-editable="true"></div><div class="x-band"><span class="x-trk"></span><span class="x-av">·</span></div></td>
                  <td class="num"></td>
                  <td class="num">·</td>
                  <td></td>
                </tr>

              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>

    <aside class="da-panel x-side" id="side" aria-label="Assigned targets">
      <div class="da-ph"><h3>Assigned targets</h3></div>

      <section>
        <div class="da-phrow"><h4><button class="cr-link" data-tab="strategy" title="Open the Strategy targets">Strategy</button></h4><span class="cr-n">9 targets</span></div>
        <p class="da-note">Category › Asset Class › Strategy › Sub-Strategy</p>
        <table class="da-mini"><tbody>
          <tr class="link x-s1" data-jump="strategy|Primary" title="Primary"><td><span class="x-dot in" title="In range · under target"></span>Primary<small>range $800M–$1B · 18–26#</small></td><td class="num"><b>$900M</b> <span class="x-imp">≈75%</span> <b>22#</b></td></tr>
          <tr class="link x-s2" data-jump="strategy|Primary › Private Equity" title="Primary › Private Equity"><td><span class="x-dot under" title="93% of target"></span>Private Equity</td><td class="num"><span class="x-imp">≈$900M</span> <b>100%</b></td></tr>
          <tr class="link x-s3" data-jump="strategy|Primary › Private Equity › Buyout" title="Primary › Private Equity › Buyout"><td><span class="x-dot above" title="Above max"></span>Buyout<small>range 7–11# · 50%–70%</small></td><td class="num"><span class="x-imp">≈$540M</span> <b>60%</b> <b>9#</b></td></tr>
          <tr class="link x-s4" data-jump="strategy|Primary › Private Equity › Buyout › Small Cap" title="Primary › Private Equity › Buyout › Small Cap"><td><span class="x-dot under" title="71% of target"></span>Small Cap</td><td class="num"><span class="x-imp">≈$135M</span> <b>25%</b></td></tr>
          <tr class="link x-s4" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap" title="Primary › Private Equity › Buyout › Mid Cap"><td><span class="x-dot above" title="Above max"></span>Mid Cap<small>range 35%–55%</small></td><td class="num"><span class="x-imp">≈$243M</span> <b>45%</b></td></tr>
          <tr class="link x-s4" data-jump="strategy|Primary › Private Equity › Buyout › Large Cap" title="Primary › Private Equity › Buyout › Large Cap"><td><span class="x-dot under" title="91% of target"></span>Large Cap</td><td class="num"><span class="x-imp">≈$108M</span> <b>20%</b></td></tr>
          <tr class="link x-s3" data-jump="strategy|Primary › Private Equity › Growth Equity" title="Primary › Private Equity › Growth Equity"><td><span class="x-dot under" title="67% of target"></span>Growth Equity<small>range 10%–20%</small></td><td class="num"><span class="x-imp">≈$135M</span> <b>15%</b> <b>3#</b></td></tr>
          <tr class="link x-s3" data-jump="strategy|Primary › Private Equity › Venture Capital" title="Primary › Private Equity › Venture Capital"><td><span class="x-dot under" title="75% of target"></span>Venture Capital<small>range 10%–25%</small></td><td class="num"><span class="x-imp">≈$180M</span> <b>20%</b> <b>4#</b></td></tr>
          <tr class="link x-s1" data-jump="strategy|Secondary" title="Secondary"><td><span class="x-dot below" title="Below min"></span>Secondary<small>range $200M–…</small></td><td class="num"><b>$300M</b> <span class="x-imp">≈25%</span> <b>8#</b></td></tr>
        </tbody></table>
      </section>

      <section>
        <div class="da-phrow"><h4><button class="cr-link" data-tab="region" title="Open the Region targets">Region</button></h4><span class="cr-n">3 targets</span></div>
        <p class="da-note">Region › Asset Class</p>
        <table class="da-mini"><tbody>
          <tr class="link x-s1" data-jump="region|North America" title="North America"><td><span class="x-dot above" title="Above max"></span>North America<small>range 60%–80%</small></td><td class="num"><span class="x-imp">≈$840M</span> <b>70%</b></td></tr>
          <tr class="link x-s1" data-jump="region|Western Europe" title="Western Europe"><td><span class="x-dot under" title="26% of target"></span>Western Europe</td><td class="num"><span class="x-imp">≈$300M</span> <b>25%</b></td></tr>
          <tr class="link x-s1" data-jump="region|APAC/ROW" title="APAC/ROW"><td><span class="x-dot in" title="In range · under target"></span>APAC/ROW<small>range …–15%</small></td><td class="num"><span class="x-imp">≈$120M</span> <b>10%</b></td></tr>
        </tbody></table>
      </section>

      <section>
        <div class="da-phrow"><h4><button class="cr-link" data-tab="structure" title="Open the Structure targets">Structure</button></h4><span class="cr-n">5 targets</span></div>
        <p class="da-note">Category › Structure Type › Detail</p>
        <table class="da-mini"><tbody>
          <tr class="link x-s1 x-ctx" data-jump="structure|Primary" title="Primary"><td>Primary</td><td class="num">no target</td></tr>
          <tr class="link x-s2" data-jump="structure|Primary › Traditional Primary" title="Primary › Traditional Primary"><td><span class="x-dot over" title="Over target"></span>Traditional Primary</td><td class="num"><b>85%</b></td></tr>
          <tr class="link x-s2" data-jump="structure|Primary › Fund-of-Funds" title="Primary › Fund-of-Funds"><td><span class="x-dot under" title="63% of target"></span>Fund-of-Funds</td><td class="num"><b>5%</b></td></tr>
          <tr class="link x-s1 x-ctx" data-jump="structure|Secondary" title="Secondary"><td>Secondary</td><td class="num">no target</td></tr>
          <tr class="link x-s2" data-jump="structure|Secondary › GP Led" title="Secondary › GP Led"><td><span class="x-dot under" title="48% of target"></span>GP Led</td><td class="num"><b>$120M</b></td></tr>
          <tr class="link x-s3" data-jump="structure|Secondary › GP Led › Single Asset" title="Secondary › GP Led › Single Asset"><td><span class="x-dot under" title="72% of target"></span>Single Asset</td><td class="num"><b>$80M</b> <span class="x-imp">≈66.7%</span></td></tr>
          <tr class="link x-s3" data-jump="structure|Secondary › GP Led › Multi Asset" title="Secondary › GP Led › Multi Asset"><td><span class="x-dot under" title="0% of target"></span>Multi Asset</td><td class="num"><b>$60M</b> <span class="x-imp">≈50%</span></td></tr>
        </tbody></table>
      </section>

      <section class="x-legend">
        <p class="da-note"><span class="da-st ok">$ 100%</span> next level adds up</p>
        <p class="da-note"><span class="da-st near">$ 85%</span> next level is under</p>
        <p class="da-note"><span class="da-st breach">$ 105%</span> next level is over</p>
        <p class="da-note">Dots show the worst band status on the row: <span class="x-dot in"></span>in range <span class="x-dot below"></span>below min <span class="x-dot above"></span>above max <span class="x-dot under"></span>building to target.</p>
        <p class="da-note">Values with ≈ are implied from the other measure. Muted rows have no target of their own but hold targets below.</p>
      </section>
    </aside>

  </div>
</div>
```

### Strategy (house design)

Strategy, redesigned in the house kit from the captured view and checked against it.

```html
<div class="da">
<style>
.x-shell{display:grid;grid-template-columns:204px minmax(0,1fr) 264px;gap:12px;align-items:start}
.x-mainc{min-width:0}
.x-rail{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 6px;display:flex;flex-direction:column;gap:2px}
.x-rail h2,.x-side h2{margin:0 0 6px;padding:0 6px;font-size:12px;font-weight:600;color:var(--ink-3)}
.x-side h2{padding:0}
.x-ent{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;font:inherit;color:inherit;background:none;border:1px solid transparent;border-radius:8px;padding:5px 6px;cursor:pointer}
.x-ent.mandate{padding-left:16px}
.x-ent[aria-current="true"]{background:var(--bg-alt);border-color:var(--accent-2)}
.x-entline{display:flex;align-items:center;gap:5px}
.x-entline b{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.x-ent.mandate .x-entline b{font-weight:500}
.x-entsub{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ink-3)}
.x-lens{display:inline-flex;gap:2px;margin-left:auto}
.x-lens i{width:12px;height:4px;border-radius:2px;background:var(--line)}
.x-lens i.on{background:var(--accent-2)}
.da-ribbon .x-title{flex:1 1 100%;min-width:0;border-right:0;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 16px}
.x-actions{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-3)}
.x-facts{flex:1 1 100%;grid-template-columns:repeat(2,minmax(90px,1fr)) minmax(160px,1.6fr) repeat(4,minmax(90px,1fr))}
.x-facts .da-fact{padding:8px 12px;border-bottom:0}
.x-facts .da-fact:last-child{border-right:0}
.x-facts .da-fact span{font-size:11.5px}
.x-facts .da-fact strong{font-size:18px;font-weight:600;line-height:1.2;white-space:nowrap}
.x-facts .da-fact small{font-size:11.5px}
.x-facts .da-fact strong small{font-weight:400}
.x-facts .fs-track{margin:4px 0 2px;height:8px}
.x-clk{cursor:pointer}
.da-tabs.x-tabs{margin:12px 0 8px}
.da-tabs.x-tabs button{text-align:left;line-height:1.3;flex:none;padding:8px 12px}
.x-tt{display:flex;align-items:center;gap:6px;white-space:nowrap}
.x-tabs small{display:block;max-width:190px;font-size:11px;color:var(--ink-3);font-weight:400}
.x-tabsep{flex:none;width:1px;background:var(--line);margin:6px}
.x-grid th,.x-grid td{padding:5px 8px}
.x-mh{display:flex;justify-content:flex-end;gap:4px;font-size:11px;font-weight:400;color:var(--ink-3)}
.x-mh i{font-style:normal;width:44px;text-align:right}
.x-mh i:nth-child(2){width:54px}
.x-trio{display:flex;gap:4px;justify-content:flex-end}
.x-trio input{font:inherit;font-size:12px;width:44px;padding:2px 4px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink);text-align:right}
.x-trio input.tgt{width:54px;font-weight:600;border-color:var(--ink-4)}
.x-trio input:disabled{background:var(--bg-alt);color:var(--ink-3)}
.x-trio input::placeholder{color:var(--ink-4)}
.x-band{display:flex;align-items:center;gap:6px;margin-top:3px;min-height:12px}
.x-trk{position:relative;flex:1;height:8px;border-radius:4px;background:var(--bg-alt)}
.x-trk i{position:absolute;top:0;bottom:0;left:0}
.x-trk .r{background:var(--line)}
.x-trk .f{top:2px;bottom:2px;border-radius:2px;background:var(--ink-4)}
.x-trk .t{width:2px;top:-3px;bottom:-3px;margin-left:-1px;background:var(--ink)}
.x-band.in .f,.x-band.at .f{background:var(--green)}
.x-band.below .f,.x-band.above .f{background:var(--red)}
.x-band.under .f{background:var(--accent-2)}
.x-av{width:50px;text-align:right;font-size:11.5px}
.x-band.in .x-av,.x-band.at .x-av{color:var(--green)}
.x-band.below .x-av,.x-band.above .x-av{color:var(--red)}
.x-nil{color:var(--ink-4)}
.x-grid td.x-cmp{font-size:12px;color:var(--ink-2)}
.da-grid tr.x-root{background:var(--bg-alt)}
.da-grid tr.x-d1 td:first-child{padding-left:20px}
.da-grid tr.x-d2 td:first-child{padding-left:34px}
.da-grid tr.x-d3 td:first-child{padding-left:48px}
.da-grid tr.x-has td:first-child{box-shadow:inset 3px 0 0 var(--accent-2)}
.x-grid .da-caret{width:20px;height:20px;margin-right:2px}
.x-grid .da-name{gap:5px}
.x-grid .cr-rule{white-space:nowrap}
.x-sp{display:inline-block;flex:none;width:22px}
.x-sum{display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap}
.x-sum .da-st{white-space:nowrap}
.x-gh{display:flex;justify-content:space-between;align-items:baseline;width:100%;font:inherit;background:none;border:0;padding:0;cursor:pointer;color:var(--ink)}
.x-gh span{font-size:14px;font-weight:600}
.x-gh small{font-size:12px;color:var(--ink-3)}
.x-srow{display:block;width:100%;text-align:left;font:inherit;color:inherit;background:none;border:0;border-bottom:1px solid var(--line);padding:5px 0;cursor:pointer}
.x-srow.d2{padding-left:10px}.x-srow.d3{padding-left:20px}.x-srow.d4{padding-left:30px}
.x-srow .l{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.x-sname{font-weight:500;white-space:nowrap}
.x-srow.ctx .x-sname{color:var(--ink-3)}
.x-vals{white-space:nowrap;color:var(--ink-3);font-size:12px}
.x-vals b{color:var(--ink);font-weight:600}
.x-vals em{font-style:italic}
.x-rgl{display:block;font-size:11.5px;color:var(--ink-3);padding-left:14px}
.x-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--ink-4)}
.x-dot.in{background:var(--green)}.x-dot.below,.x-dot.above{background:var(--red)}.x-dot.under{background:var(--accent-2)}.x-dot.over{background:var(--amber)}
.x-legend{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--ink-3)}
@media (max-width:1200px){.x-shell{grid-template-columns:1fr}.x-shell .da-panel{position:static;height:auto;max-height:none}}
</style>

<header class="page-header">
  <div class="page-title-block">
    <div><span class="page-title">Target Manager</span> <span class="page-meta">· Fund-of-Funds &amp; Directs</span></div>
    <div class="cr-seg" role="group" aria-label="View">
      <button class="on" aria-pressed="true">Assign targets</button>
      <button aria-pressed="false">Overview</button>
      <button aria-pressed="false">Pipeline</button>
    </div>
  </div>
  <div class="page-actions">
    <button class="btn btn-sm" title="Undo last change (Ctrl+Z)" disabled>Undo</button>
    <button class="btn btn-sm" title="Copy all targets as CSV">Copy CSV</button>
    <button class="btn btn-sm" title="Restore the example clients and targets">Reset example</button>
  </div>
</header>

<div class="x-shell">

  <nav class="x-rail" aria-label="Clients and mandates">
    <h2>Clients &amp; mandates</h2>
    <button class="x-ent client" aria-current="false">
      <span class="x-entline"><b>Commonwealth Teachers’ Retirement</b><span class="cr-n">14</span><span class="da-st breach" title="5 compliance breaches">5</span></span>
      <span class="x-entsub">$2B · 70 inv <span class="da-st ok" title="2026 pacing velocity">1.04x</span><span class="x-lens" title="Strategy: 6 · Region: 4 · Structure: 4"><i class="on"></i><i class="on"></i><i class="on"></i></span></span>
    </button>
    <button class="x-ent mandate" aria-current="true">
      <span class="x-entline"><b>PE Primary Sleeve</b><span class="cr-n">17</span><span class="da-st breach" title="3 compliance breaches">3</span></span>
      <span class="x-entsub">$1.2B · 30 inv <span class="da-st ok" title="2026 pacing velocity">1.06x</span><span class="x-lens" title="Strategy: 9 · Region: 3 · Structure: 5"><i class="on"></i><i class="on"></i><i class="on"></i></span></span>
    </button>
    <button class="x-ent mandate" aria-current="false">
      <span class="x-entline"><b>Credit &amp; Real Assets Sleeve</b><span class="cr-n">9</span></span>
      <span class="x-entsub">$450M · 14 inv <span class="da-st breach" title="2026 pacing velocity">0.77x</span><span class="x-lens" title="Strategy: 7 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span>
    </button>
    <button class="x-ent mandate" aria-current="false">
      <span class="x-entline"><b>Co-Investment Sleeve</b><span class="cr-n">7</span><span class="da-st breach" title="2 compliance breaches">2</span></span>
      <span class="x-entsub">$400M · 24 inv <span class="da-st ok" title="2026 pacing velocity">1.14x</span><span class="x-lens" title="Strategy: 4 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span>
    </button>
    <button class="x-ent client" aria-current="false">
      <span class="x-entline"><b>Halvorsen Family Office</b><span class="cr-n">3</span><span class="da-st breach" title="1 compliance breach">1</span></span>
      <span class="x-entsub">$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="x-lens" title="Strategy: 0 · Region: 3 · Structure: 0"><i></i><i class="on"></i><i></i></span></span>
    </button>
    <button class="x-ent mandate" aria-current="false">
      <span class="x-entline"><b>Diversified Sleeve</b><span class="cr-n">4</span><span class="da-st breach" title="1 compliance breach">1</span></span>
      <span class="x-entsub">$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="x-lens" title="Strategy: 4 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span>
    </button>
    <button class="x-ent client" aria-current="false">
      <span class="x-entline"><b>Northgate Mutual Insurance</b><span class="cr-n">2</span><span class="da-st breach" title="3 compliance breaches">3</span></span>
      <span class="x-entsub">$900M · 40 inv <span class="da-st ok" title="2026 pacing velocity">1.11x</span><span class="x-lens" title="Strategy: 2 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span>
    </button>
    <button class="x-ent mandate" aria-current="false">
      <span class="x-entline"><b>Private Credit Sleeve</b><span class="cr-n">10</span><span class="da-st breach" title="3 compliance breaches">3</span></span>
      <span class="x-entsub">$600M · 28 inv <span class="da-chip" title="2026 pacing velocity">1.16x</span><span class="x-lens" title="Strategy: 8 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span>
    </button>
    <button class="x-ent mandate" aria-current="false">
      <span class="x-entline"><b>Secondaries Sleeve</b><span class="cr-n">6</span></span>
      <span class="x-entsub">$200M · 10 inv <span class="da-st breach" title="2026 pacing velocity">0.85x</span><span class="x-lens" title="Strategy: 3 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span>
    </button>
    <button class="btn btn-sm">+ Add mandate sleeve</button>
  </nav>

  <main class="x-mainc">
    <div class="crumbs"><a class="crumb-link" href="#">Commonwealth Teachers’ Retirement</a><span class="sep">›</span><span class="crumb-current">Mandate sleeve</span></div>

    <header class="da-ribbon">
      <div class="da-title x-title">
        <h1>PE Primary Sleeve</h1>
        <div class="x-actions">
          <span>% basis</span>
          <div class="cr-seg" role="group" aria-label="Percent basis" data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">
            <button aria-pressed="false" title="Percent targets are a share of the total program">Program</button>
            <button class="on" aria-pressed="true" title="Percent targets are a share of the level above">Parent level</button>
          </div>
          <button class="btn btn-sm">Copy targets from…</button>
        </div>
      </div>
      <div class="da-facts x-facts" role="group" aria-label="Deployment and pacing">
        <div class="da-fact"><span>Program</span><strong data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$1.2B</strong><small>74% committed · since <span data-attr="INCEPTION_DATE">Apr 2022</span></small></div>
        <div class="da-fact"><span>Investments</span><strong>22 <small>/ <span data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">30</span></small></strong><small>made vs target</small></div>
        <div class="da-fact"><span>2026 deployment vs target</span><strong>$167M <small>/ <span data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$180M</span></small></strong>
          <div class="fs-track" title="Bar: deployed against the 2026 target. Marker: where pacing says you should be by 17 Nov 2026"><i style="width:92.8%"></i><b style="left:87.7%"></b></div>
          <small>93% of annual · $157.8M expected to date</small></div>
        <div class="da-fact"><span>Pacing velocity</span><strong class="up">1.06x <span class="da-st ok">On pace</span></strong><small>YTD vs time-weighted target</small></div>
        <div class="da-fact"><span>Since inception</span><strong class="up" title="On pace">1.07x</strong><small>$893.9M vs $833.4M</small></div>
        <div class="da-fact x-clk" role="button" tabindex="0" title="Open the compliance tab"><span>Compliance</span><strong class="dn">3 breaches</strong><small>13 rules · 1 watch · 2 pending · 2 soft</small></div>
        <div class="da-fact"><span>Run-rate (LTM)</span><strong>$193.5M<small>/yr</small></strong><small>$306.1M left · ≈1.6 yrs at this pace</small></div>
      </div>
    </header>

    <div class="da-tabs x-tabs" role="tablist">
      <button class="on" role="tab" aria-selected="true"><span class="x-tt">Strategy <span class="cr-n">9</span></span><small>Category › Asset Class › Strategy › Sub-Strategy</small></button>
      <button role="tab" aria-selected="false"><span class="x-tt">Region <span class="cr-n">3</span></span><small>Region › Asset Class</small></button>
      <button role="tab" aria-selected="false"><span class="x-tt">Structure <span class="cr-n">5</span></span><small>Category › Structure Type › Detail</small></button>
      <span class="x-tabsep" aria-hidden="true"></span>
      <button role="tab" aria-selected="false"><span class="x-tt">Pacing</span><small>Annual deployment by year</small></button>
      <button role="tab" aria-selected="false"><span class="x-tt">Commitments <span class="cr-n">22</span></span><small>Original commitments and attributes</small></button>
      <button role="tab" aria-selected="false"><span class="x-tt">Compliance <span class="da-st breach">3 breaches</span></span><small>Rules, limits and results</small></button>
    </div>

    <section class="da-sec">
      <div class="da-toolbar">
        <input class="pipe-search" type="search" placeholder="Find a level, e.g. Mid Cap" aria-label="Find a level">
        <label><input type="checkbox" value="on"> Assigned only</label>
        <button class="btn btn-sm">Expand all</button>
        <button class="btn btn-sm">Collapse</button>
        <span class="da-note">$ in millions unless you type K or B · Tab across min / target / max · Enter moves down · % of parent level</span>
      </div>

      <div class="da-main solo">
        <div class="da-gridwrap">
          <table class="da-grid fit x-grid">
            <thead>
              <tr>
                <th>Category › Asset Class › Strategy › Sub-Strategy</th>
                <th class="num" title="Minimum, target and maximum. The bar shows commitments against the band (shaded) and target (tick).">$ Dollars<div class="x-mh"><i>Min</i><i>Target</i><i>Max</i></div></th>
                <th class="num" title="Minimum, target and maximum. The bar shows commitments against the band (shaded) and target (tick)."># Investments<div class="x-mh"><i>Min</i><i>Target</i><i>Max</i></div></th>
                <th class="num" title="Minimum, target and maximum. The bar shows commitments against the band (shaded) and target (tick). Actual % is the share of commitments at the level above.">% Percent<div class="x-mh"><i>Min</i><i>Target</i><i>Max</i></div></th>
                <th class="num" title="Sum of the next level's targets compared with this row">Children Σ</th>
                <th class="num" title="This client’s macro target for the same level">Client target</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <!-- Total program -->
              <tr class="x-root">
                <td><div class="da-name"><button class="da-caret" aria-expanded="true" aria-label="Collapse Total program">▾</button><span class="cr-type other">ALL</span><b>Total program</b></div></td>
                <td class="num"><div class="x-trio"><input class="mm" placeholder="min" aria-label="Total program Dollars min" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="tgt" value="$1.2B" placeholder="—" aria-label="Total program Dollars target" data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true"><input class="mm" placeholder="max" aria-label="Total program Dollars max" data-attr="FUND_TARGET_MATRIX" data-editable="true"></div>
                  <div class="x-band under" title="Actual $893.9M · target $1.2B · 74% of target"><span class="x-trk"><i class="f" style="width:63.3%"></i><i class="t" style="left:85%"></i></span><span class="x-av">$893.9M</span></div></td>
                <td class="num"><div class="x-trio"><input class="mm" value="25" placeholder="min" aria-label="Total program Investments min" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="tgt" value="30" placeholder="—" aria-label="Total program Investments target" data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true"><input class="mm" value="35" placeholder="max" aria-label="Total program Investments max" data-attr="FUND_TARGET_MATRIX" data-editable="true"></div>
                  <div class="x-band below" title="Actual 22 · target 30 · range 25 to 35 · Below min"><span class="x-trk"><i class="r" style="left:60.7%;width:24.3%"></i><i class="f" style="width:53.4%"></i><i class="t" style="left:72.9%"></i></span><span class="x-av">22</span></div></td>
                <td class="num"><div class="x-trio"><input class="mm" placeholder="min" disabled aria-label="Total program Percent min"><input class="tgt" value="100%" placeholder="—" disabled aria-label="Total program Percent target"><input class="mm" placeholder="max" disabled aria-label="Total program Percent max"></div>
                  <div class="x-band"><span class="x-nil">of program</span></div></td>
                <td class="num"><div class="x-sum"><span class="da-st ok" title="Children total $1.2B against $1.2B at this level (2 of 4 children targeted)">$ 100%</span><span class="da-st ok" title="Children total 30 investments against 30 at this level"># 30/30</span></div></td>
                <td class="num x-cmp">$2B · 70#</td>
                <td></td>
              </tr>
              <!-- Primary -->
              <tr class="x-d1 x-has">
                <td><div class="da-name"><button class="da-caret" aria-expanded="true" aria-label="Collapse Primary">▾</button><span class="cr-type other">CAT</span><b>Primary</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" value="$800M" placeholder="min" aria-label="Primary Dollars min"><input class="tgt" value="$900M" placeholder="—" aria-label="Primary Dollars target"><input class="mm" value="$1B" placeholder="max" aria-label="Primary Dollars max"></div>
                  <div class="x-band in" title="Actual $836.4M · target $900M · range $800M to $1B · In range · under target"><span class="x-trk"><i class="r" style="left:68%;width:17%"></i><i class="f" style="width:71.1%"></i><i class="t" style="left:76.5%"></i></span><span class="x-av">$836.4M</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" value="18" placeholder="min" aria-label="Primary Investments min"><input class="tgt" value="22" placeholder="—" aria-label="Primary Investments target"><input class="mm" value="26" placeholder="max" aria-label="Primary Investments max"></div>
                  <div class="x-band in" title="Actual 20 · target 22 · range 18 to 26 · In range · under target"><span class="x-trk"><i class="r" style="left:58.8%;width:26.2%"></i><i class="f" style="width:65.4%"></i><i class="t" style="left:71.9%"></i></span><span class="x-av">20</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="≈66.7%" aria-label="Primary Percent min"><input class="tgt" placeholder="≈75%" aria-label="Primary Percent target"><input class="mm" placeholder="≈83.3%" aria-label="Primary Percent max"></div>
                  <div class="x-band" title="Actual 93.6% of committed · No target"><span class="x-trk"><i class="f" style="width:93.6%"></i></span><span class="x-av">93.6%</span></div></td>
                <td class="num"><div class="x-sum"><span class="da-st ok" title="Children total $900M against $900M at this level (1 of 5 children targeted)">$ 100%</span></div></td>
                <td class="num x-cmp">$1.1B · 55% · 22#</td>
                <td><button class="btn btn-sm" title="Clear targets on this row" aria-label="Clear Primary targets">×</button></td>
              </tr>
              <!-- Private Equity -->
              <tr class="x-d2 x-has">
                <td><div class="da-name"><button class="da-caret" aria-expanded="true" aria-label="Collapse Private Equity">▾</button><span class="cr-type other">AC</span><b>Private Equity</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Private Equity Dollars min"><input class="tgt" placeholder="≈900M" aria-label="Private Equity Dollars target"><input class="mm" placeholder="max" aria-label="Private Equity Dollars max"></div>
                  <div class="x-band under" title="Actual $836.4M · target $900M · 93% of target"><span class="x-trk"><i class="f" style="width:71.1%"></i><i class="t" style="left:76.5%"></i></span><span class="x-av">$836.4M</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Private Equity Investments min"><input class="tgt" placeholder="—" aria-label="Private Equity Investments target"><input class="mm" placeholder="max" aria-label="Private Equity Investments max"></div>
                  <div class="x-band" title="Actual 20 · No target"><span class="x-trk"><i class="f" style="width:85%"></i></span><span class="x-av">20</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Private Equity Percent min"><input class="tgt" value="100%" placeholder="—" aria-label="Private Equity Percent target"><input class="mm" placeholder="max" aria-label="Private Equity Percent max"></div>
                  <div class="x-band at" title="Actual 100% of committed · target 100% · At target"><span class="x-trk"><i class="f" style="width:100%"></i><i class="t" style="left:100%"></i></span><span class="x-av">100%</span></div></td>
                <td class="num"><div class="x-sum"><span class="da-st near" title="Children total $855M against $900M at this level (3 of 5 children targeted)">$ 95%</span></div></td>
                <td class="num x-cmp">$700M · 35%</td>
                <td><button class="btn btn-sm" title="Clear targets on this row" aria-label="Clear Private Equity targets">×</button></td>
              </tr>
              <!-- Buyout -->
              <tr class="x-d3 x-has">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Buyout">▸</button><span class="cr-type other">STRAT</span><b>Buyout</b><span class="cr-rule" title="3 targets set below this level">3 below</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="≈450M" aria-label="Buyout Dollars min"><input class="tgt" placeholder="≈540M" aria-label="Buyout Dollars target"><input class="mm" placeholder="≈630M" aria-label="Buyout Dollars max"></div>
                  <div class="x-band in" title="Actual $615M · target $540M · range $450M to $630M · In range · over target"><span class="x-trk"><i class="r" style="left:60.7%;width:24.3%"></i><i class="f" style="width:83%"></i><i class="t" style="left:72.9%"></i></span><span class="x-av">$615M</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" value="7" placeholder="min" aria-label="Buyout Investments min"><input class="tgt" value="9" placeholder="—" aria-label="Buyout Investments target"><input class="mm" value="11" placeholder="max" aria-label="Buyout Investments max"></div>
                  <div class="x-band above" title="Actual 15 · target 9 · range 7 to 11 · Above max"><span class="x-trk"><i class="r" style="left:39.7%;width:22.7%"></i><i class="f" style="width:85%"></i><i class="t" style="left:51%"></i></span><span class="x-av">15</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" value="50%" placeholder="min" aria-label="Buyout Percent min"><input class="tgt" value="60%" placeholder="—" aria-label="Buyout Percent target"><input class="mm" value="70%" placeholder="max" aria-label="Buyout Percent max"></div>
                  <div class="x-band above" title="Actual 73.5% of committed · target 60% · range 50% to 70% · Above max"><span class="x-trk"><i class="r" style="left:50%;width:20%"></i><i class="f" style="width:73.5%"></i><i class="t" style="left:60%"></i></span><span class="x-av">73.5%</span></div></td>
                <td class="num"><div class="x-sum"><span class="da-st near" title="Children total $486M against $540M at this level (3 of 5 children targeted)">$ 90%</span></div></td>
                <td class="num x-cmp"><span class="x-nil">·</span></td>
                <td><button class="btn btn-sm" title="Clear targets on this row" aria-label="Clear Buyout targets">×</button></td>
              </tr>
              <!-- Growth Equity -->
              <tr class="x-d3 x-has">
                <td><div class="da-name"><span class="x-sp" aria-hidden="true"></span><span class="cr-type other">STRAT</span><b>Growth Equity</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="≈90M" aria-label="Growth Equity Dollars min"><input class="tgt" placeholder="≈135M" aria-label="Growth Equity Dollars target"><input class="mm" placeholder="≈180M" aria-label="Growth Equity Dollars max"></div>
                  <div class="x-band in" title="Actual $104.5M · target $135M · range $90M to $180M · In range · under target"><span class="x-trk"><i class="r" style="left:42.5%;width:42.5%"></i><i class="f" style="width:49.3%"></i><i class="t" style="left:63.7%"></i></span><span class="x-av">$104.5M</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Growth Equity Investments min"><input class="tgt" value="3" placeholder="—" aria-label="Growth Equity Investments target"><input class="mm" placeholder="max" aria-label="Growth Equity Investments max"></div>
                  <div class="x-band under" title="Actual 2 · target 3 · 67% of target"><span class="x-trk"><i class="f" style="width:56.7%"></i><i class="t" style="left:85%"></i></span><span class="x-av">2</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" value="10%" placeholder="min" aria-label="Growth Equity Percent min"><input class="tgt" value="15%" placeholder="—" aria-label="Growth Equity Percent target"><input class="mm" value="20%" placeholder="max" aria-label="Growth Equity Percent max"></div>
                  <div class="x-band in" title="Actual 12.5% of committed · target 15% · range 10% to 20% · In range · under target"><span class="x-trk"><i class="r" style="left:10%;width:10%"></i><i class="f" style="width:12.5%"></i><i class="t" style="left:15%"></i></span><span class="x-av">12.5%</span></div></td>
                <td class="num"></td>
                <td class="num x-cmp"><span class="x-nil">·</span></td>
                <td><button class="btn btn-sm" title="Clear targets on this row" aria-label="Clear Growth Equity targets">×</button></td>
              </tr>
              <!-- Venture Capital -->
              <tr class="x-d3 x-has">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Venture Capital">▸</button><span class="cr-type other">STRAT</span><b>Venture Capital</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="≈90M" aria-label="Venture Capital Dollars min"><input class="tgt" placeholder="≈180M" aria-label="Venture Capital Dollars target"><input class="mm" placeholder="≈225M" aria-label="Venture Capital Dollars max"></div>
                  <div class="x-band in" title="Actual $116.9M · target $180M · range $90M to $225M · In range · under target"><span class="x-trk"><i class="r" style="left:34%;width:51%"></i><i class="f" style="width:44.2%"></i><i class="t" style="left:68%"></i></span><span class="x-av">$116.9M</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Venture Capital Investments min"><input class="tgt" value="4" placeholder="—" aria-label="Venture Capital Investments target"><input class="mm" placeholder="max" aria-label="Venture Capital Investments max"></div>
                  <div class="x-band under" title="Actual 3 · target 4 · 75% of target"><span class="x-trk"><i class="f" style="width:63.7%"></i><i class="t" style="left:85%"></i></span><span class="x-av">3</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" value="10%" placeholder="min" aria-label="Venture Capital Percent min"><input class="tgt" value="20%" placeholder="—" aria-label="Venture Capital Percent target"><input class="mm" value="25%" placeholder="max" aria-label="Venture Capital Percent max"></div>
                  <div class="x-band in" title="Actual 14% of committed · target 20% · range 10% to 25% · In range · under target"><span class="x-trk"><i class="r" style="left:10%;width:15%"></i><i class="f" style="width:14%"></i><i class="t" style="left:20%"></i></span><span class="x-av">14%</span></div></td>
                <td class="num"></td>
                <td class="num x-cmp"><span class="x-nil">·</span></td>
                <td><button class="btn btn-sm" title="Clear targets on this row" aria-label="Clear Venture Capital targets">×</button></td>
              </tr>
              <!-- GP Stakes -->
              <tr class="x-d3">
                <td><div class="da-name"><span class="x-sp" aria-hidden="true"></span><span class="cr-type other">STRAT</span><b>GP Stakes</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="GP Stakes Dollars min"><input class="tgt" placeholder="—" aria-label="GP Stakes Dollars target"><input class="mm" placeholder="max" aria-label="GP Stakes Dollars max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="GP Stakes Investments min"><input class="tgt" placeholder="—" aria-label="GP Stakes Investments target"><input class="mm" placeholder="max" aria-label="GP Stakes Investments max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="GP Stakes Percent min"><input class="tgt" placeholder="—" aria-label="GP Stakes Percent target"><input class="mm" placeholder="max" aria-label="GP Stakes Percent max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"></td>
                <td class="num x-cmp"><span class="x-nil">·</span></td>
                <td></td>
              </tr>
              <!-- FoF - Multi-Strategy PE -->
              <tr class="x-d3">
                <td><div class="da-name"><span class="x-sp" aria-hidden="true"></span><span class="cr-type other">STRAT</span><b>FoF - Multi-Strategy PE</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="FoF - Multi-Strategy PE Dollars min"><input class="tgt" placeholder="—" aria-label="FoF - Multi-Strategy PE Dollars target"><input class="mm" placeholder="max" aria-label="FoF - Multi-Strategy PE Dollars max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="FoF - Multi-Strategy PE Investments min"><input class="tgt" placeholder="—" aria-label="FoF - Multi-Strategy PE Investments target"><input class="mm" placeholder="max" aria-label="FoF - Multi-Strategy PE Investments max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="FoF - Multi-Strategy PE Percent min"><input class="tgt" placeholder="—" aria-label="FoF - Multi-Strategy PE Percent target"><input class="mm" placeholder="max" aria-label="FoF - Multi-Strategy PE Percent max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"></td>
                <td class="num x-cmp"><span class="x-nil">·</span></td>
                <td></td>
              </tr>
              <!-- Private Credit -->
              <tr class="x-d2">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Private Credit">▸</button><span class="cr-type other">AC</span><b>Private Credit</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Private Credit Dollars min"><input class="tgt" placeholder="—" aria-label="Private Credit Dollars target"><input class="mm" placeholder="max" aria-label="Private Credit Dollars max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Private Credit Investments min"><input class="tgt" placeholder="—" aria-label="Private Credit Investments target"><input class="mm" placeholder="max" aria-label="Private Credit Investments max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Private Credit Percent min"><input class="tgt" placeholder="—" aria-label="Private Credit Percent target"><input class="mm" placeholder="max" aria-label="Private Credit Percent max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"></td>
                <td class="num x-cmp">$240M · 12%</td>
                <td></td>
              </tr>
              <!-- Private Real Assets -->
              <tr class="x-d2">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Private Real Assets">▸</button><span class="cr-type other">AC</span><b>Private Real Assets</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Private Real Assets Dollars min"><input class="tgt" placeholder="—" aria-label="Private Real Assets Dollars target"><input class="mm" placeholder="max" aria-label="Private Real Assets Dollars max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Private Real Assets Investments min"><input class="tgt" placeholder="—" aria-label="Private Real Assets Investments target"><input class="mm" placeholder="max" aria-label="Private Real Assets Investments max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Private Real Assets Percent min"><input class="tgt" placeholder="—" aria-label="Private Real Assets Percent target"><input class="mm" placeholder="max" aria-label="Private Real Assets Percent max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"></td>
                <td class="num x-cmp">$160M · 8%</td>
                <td></td>
              </tr>
              <!-- Multi-Strategy -->
              <tr class="x-d2">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Multi-Strategy">▸</button><span class="cr-type other">AC</span><b>Multi-Strategy</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Multi-Strategy Dollars min"><input class="tgt" placeholder="—" aria-label="Multi-Strategy Dollars target"><input class="mm" placeholder="max" aria-label="Multi-Strategy Dollars max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Multi-Strategy Investments min"><input class="tgt" placeholder="—" aria-label="Multi-Strategy Investments target"><input class="mm" placeholder="max" aria-label="Multi-Strategy Investments max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Multi-Strategy Percent min"><input class="tgt" placeholder="—" aria-label="Multi-Strategy Percent target"><input class="mm" placeholder="max" aria-label="Multi-Strategy Percent max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"></td>
                <td class="num x-cmp"><span class="x-nil">·</span></td>
                <td></td>
              </tr>
              <!-- Other Alternatives -->
              <tr class="x-d2">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Other Alternatives">▸</button><span class="cr-type other">AC</span><b>Other Alternatives</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Other Alternatives Dollars min"><input class="tgt" placeholder="—" aria-label="Other Alternatives Dollars target"><input class="mm" placeholder="max" aria-label="Other Alternatives Dollars max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Other Alternatives Investments min"><input class="tgt" placeholder="—" aria-label="Other Alternatives Investments target"><input class="mm" placeholder="max" aria-label="Other Alternatives Investments max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Other Alternatives Percent min"><input class="tgt" placeholder="—" aria-label="Other Alternatives Percent target"><input class="mm" placeholder="max" aria-label="Other Alternatives Percent max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"></td>
                <td class="num x-cmp"><span class="x-nil">·</span></td>
                <td></td>
              </tr>
              <!-- Secondary -->
              <tr class="x-d1 x-has">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Secondary">▸</button><span class="cr-type other">CAT</span><b>Secondary</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" value="$200M" placeholder="min" aria-label="Secondary Dollars min"><input class="tgt" value="$300M" placeholder="—" aria-label="Secondary Dollars target"><input class="mm" placeholder="max" aria-label="Secondary Dollars max"></div>
                  <div class="x-band below" title="Actual $57.5M · target $300M · range $200M to … · Below min"><span class="x-trk"><i class="r" style="left:56.7%;width:43.3%"></i><i class="f" style="width:16.3%"></i><i class="t" style="left:85%"></i></span><span class="x-av">$57.5M</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Secondary Investments min"><input class="tgt" value="8" placeholder="—" aria-label="Secondary Investments target"><input class="mm" placeholder="max" aria-label="Secondary Investments max"></div>
                  <div class="x-band under" title="Actual 2 · target 8 · 25% of target"><span class="x-trk"><i class="f" style="width:21.3%"></i><i class="t" style="left:85%"></i></span><span class="x-av">2</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="≈16.7%" aria-label="Secondary Percent min"><input class="tgt" placeholder="≈25%" aria-label="Secondary Percent target"><input class="mm" placeholder="max" aria-label="Secondary Percent max"></div>
                  <div class="x-band" title="Actual 6.4% of committed · No target"><span class="x-trk"><i class="f" style="width:6.4%"></i></span><span class="x-av">6.4%</span></div></td>
                <td class="num"></td>
                <td class="num x-cmp">$400M · 20% · 8#</td>
                <td><button class="btn btn-sm" title="Clear targets on this row" aria-label="Clear Secondary targets">×</button></td>
              </tr>
              <!-- Co-Investment -->
              <tr class="x-d1">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Co-Investment">▸</button><span class="cr-type other">CAT</span><b>Co-Investment</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Co-Investment Dollars min"><input class="tgt" placeholder="—" aria-label="Co-Investment Dollars target"><input class="mm" placeholder="max" aria-label="Co-Investment Dollars max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Co-Investment Investments min"><input class="tgt" placeholder="—" aria-label="Co-Investment Investments target"><input class="mm" placeholder="max" aria-label="Co-Investment Investments max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Co-Investment Percent min"><input class="tgt" placeholder="—" aria-label="Co-Investment Percent target"><input class="mm" placeholder="max" aria-label="Co-Investment Percent max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"></td>
                <td class="num x-cmp">$500M · 25% · 15#</td>
                <td></td>
              </tr>
              <!-- Separate Account -->
              <tr class="x-d1">
                <td><div class="da-name"><button class="da-caret" aria-expanded="false" aria-label="Expand Separate Account">▸</button><span class="cr-type other">CAT</span><b>Separate Account</b></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Separate Account Dollars min"><input class="tgt" placeholder="—" aria-label="Separate Account Dollars target"><input class="mm" placeholder="max" aria-label="Separate Account Dollars max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Separate Account Investments min"><input class="tgt" placeholder="—" aria-label="Separate Account Investments target"><input class="mm" placeholder="max" aria-label="Separate Account Investments max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"><div class="x-trio" data-attr="FUND_TARGET_MATRIX" data-editable="true"><input class="mm" placeholder="min" aria-label="Separate Account Percent min"><input class="tgt" placeholder="—" aria-label="Separate Account Percent target"><input class="mm" placeholder="max" aria-label="Separate Account Percent max"></div><div class="x-band"><span class="x-trk"></span><span class="x-av x-nil">·</span></div></td>
                <td class="num"></td>
                <td class="num x-cmp"><span class="x-nil">·</span></td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </main>

  <aside class="da-panel x-side" aria-label="Assigned targets">
    <div class="da-ph"><h2>Assigned targets</h2></div>

    <section>
      <button class="x-gh" title="Open the Strategy targets"><span>Strategy</span><small>9 targets</small></button>
      <p class="da-note">Category › Asset Class › Strategy › Sub-Strategy</p>
      <button class="x-srow d1" title="Primary"><span class="l"><span class="x-sname"><i class="x-dot in" title="In range · under target"></i>Primary</span><span class="x-vals"><b>$900M</b> ≈75% <b>22#</b></span></span><span class="x-rgl">range $800M–$1B · 18–26#</span></button>
      <button class="x-srow d2" title="Primary › Private Equity"><span class="l"><span class="x-sname"><i class="x-dot under" title="93% of target"></i>Private Equity</span><span class="x-vals">≈$900M <b>100%</b></span></span></button>
      <button class="x-srow d3" title="Primary › Private Equity › Buyout"><span class="l"><span class="x-sname"><i class="x-dot above" title="Above max"></i>Buyout</span><span class="x-vals">≈$540M <b>60%</b> <b>9#</b></span></span><span class="x-rgl">range 7–11# · 50%–70%</span></button>
      <button class="x-srow d4" title="Primary › Private Equity › Buyout › Small Cap"><span class="l"><span class="x-sname"><i class="x-dot under" title="71% of target"></i>Small Cap</span><span class="x-vals">≈$135M <b>25%</b></span></span></button>
      <button class="x-srow d4" title="Primary › Private Equity › Buyout › Mid Cap"><span class="l"><span class="x-sname"><i class="x-dot above" title="Above max"></i>Mid Cap</span><span class="x-vals">≈$243M <b>45%</b></span></span><span class="x-rgl">range 35%–55%</span></button>
      <button class="x-srow d4" title="Primary › Private Equity › Buyout › Large Cap"><span class="l"><span class="x-sname"><i class="x-dot under" title="91% of target"></i>Large Cap</span><span class="x-vals">≈$108M <b>20%</b></span></span></button>
      <button class="x-srow d3" title="Primary › Private Equity › Growth Equity"><span class="l"><span class="x-sname"><i class="x-dot under" title="67% of target"></i>Growth Equity</span><span class="x-vals">≈$135M <b>15%</b> <b>3#</b></span></span><span class="x-rgl">range 10%–20%</span></button>
      <button class="x-srow d3" title="Primary › Private Equity › Venture Capital"><span class="l"><span class="x-sname"><i class="x-dot under" title="75% of target"></i>Venture Capital</span><span class="x-vals">≈$180M <b>20%</b> <b>4#</b></span></span><span class="x-rgl">range 10%–25%</span></button>
      <button class="x-srow d1" title="Secondary"><span class="l"><span class="x-sname"><i class="x-dot below" title="Below min"></i>Secondary</span><span class="x-vals"><b>$300M</b> ≈25% <b>8#</b></span></span><span class="x-rgl">range $200M–…</span></button>
    </section>

    <section>
      <button class="x-gh" title="Open the Region targets"><span>Region</span><small>3 targets</small></button>
      <p class="da-note">Region › Asset Class</p>
      <button class="x-srow d1" title="North America"><span class="l"><span class="x-sname"><i class="x-dot above" title="Above max"></i>North America</span><span class="x-vals">≈$840M <b>70%</b></span></span><span class="x-rgl">range 60%–80%</span></button>
      <button class="x-srow d1" title="Western Europe"><span class="l"><span class="x-sname"><i class="x-dot under" title="26% of target"></i>Western Europe</span><span class="x-vals">≈$300M <b>25%</b></span></span></button>
      <button class="x-srow d1" title="APAC/ROW"><span class="l"><span class="x-sname"><i class="x-dot in" title="In range · under target"></i>APAC/ROW</span><span class="x-vals">≈$120M <b>10%</b></span></span><span class="x-rgl">range …–15%</span></button>
    </section>

    <section>
      <button class="x-gh" title="Open the Structure targets"><span>Structure</span><small>5 targets</small></button>
      <p class="da-note">Category › Structure Type › Detail</p>
      <button class="x-srow ctx d1" title="Primary"><span class="l"><span class="x-sname">Primary</span><span class="x-vals"><em>no target</em></span></span></button>
      <button class="x-srow d2" title="Primary › Traditional Primary"><span class="l"><span class="x-sname"><i class="x-dot over" title="Over target"></i>Traditional Primary</span><span class="x-vals"><b>85%</b></span></span></button>
      <button class="x-srow d2" title="Primary › Fund-of-Funds"><span class="l"><span class="x-sname"><i class="x-dot under" title="63% of target"></i>Fund-of-Funds</span><span class="x-vals"><b>5%</b></span></span></button>
      <button class="x-srow ctx d1" title="Secondary"><span class="l"><span class="x-sname">Secondary</span><span class="x-vals"><em>no target</em></span></span></button>
      <button class="x-srow d2" title="Secondary › GP Led"><span class="l"><span class="x-sname"><i class="x-dot under" title="48% of target"></i>GP Led</span><span class="x-vals"><b>$120M</b></span></span></button>
      <button class="x-srow d3" title="Secondary › GP Led › Single Asset"><span class="l"><span class="x-sname"><i class="x-dot under" title="72% of target"></i>Single Asset</span><span class="x-vals"><b>$80M</b> ≈66.7%</span></span></button>
      <button class="x-srow d3" title="Secondary › GP Led › Multi Asset"><span class="l"><span class="x-sname"><i class="x-dot under" title="0% of target"></i>Multi Asset</span><span class="x-vals"><b>$60M</b> ≈50%</span></span></button>
    </section>

    <section class="x-legend">
      <div><span class="da-st ok">$ 100%</span> next level adds up</div>
      <div><span class="da-st near">$ 85%</span> next level is under</div>
      <div><span class="da-st breach">$ 105%</span> next level is over</div>
      <div>Dots show the worst band status on the row: <i class="x-dot in"></i>in range <i class="x-dot below"></i>below min <i class="x-dot above"></i>above max <i class="x-dot under"></i>building to target.</div>
      <div>Values with ≈ are implied from the other measure. Muted rows have no target of their own but hold targets below.</div>
    </section>
  </aside>

</div>
</div>
```

### Pacing (house design)

Pacing, redesigned in the house kit from the captured view and checked against it.

```html
<style>
.x-top{display:flex;align-items:center;gap:8px;padding:8px 12px;margin-bottom:12px;background:var(--surface);border:1px solid var(--line);border-radius:8px}
.x-brand{font-size:14px;font-weight:600;margin-right:8px}
.x-brand span{font-weight:400;color:var(--ink-3)}
.x-sp{flex:1}
.x-shell{display:grid;grid-template-columns:232px minmax(0,1fr);gap:14px;align-items:start}
.x-ent{display:flex;flex-direction:column;gap:3px;width:100%;padding:8px 12px;text-align:left;font:inherit;color:inherit;background:none;border:0;border-left:3px solid transparent;border-bottom:1px solid var(--line);cursor:pointer}
.x-ent.m{padding-left:24px}
.x-ent[aria-current="true"]{background:var(--bg-alt);border-left-color:var(--accent-2)}
.x-l1,.x-l2{display:flex;align-items:center;gap:6px}
.x-l1 b{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.x-l2{font-size:11.5px;color:var(--ink-3)}
.x-ent .da-track{margin:0 0 0 auto}
.x-ent .da-track i{width:12px;height:4px}
.x-add{margin:10px 12px 12px;justify-content:center}
.x-acts{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-3)}
.x-f7{grid-template-columns:repeat(8,minmax(0,1fr))}
.x-f7 .da-fact{padding:9px 12px;border-bottom:0}
.x-f7 .da-fact:last-child{border-right:0}
.x-f7 .da-fact strong{display:flex;align-items:baseline;gap:6px;font-size:18px;white-space:nowrap}
.x-f7 .da-fact strong .da-st{align-self:center}
.x-f7 .da-fact small{font-size:11.5px}
.x-f7 .x-wide{grid-column:span 2}
.x-f7 .fs-track{height:8px;margin:4px 0 2px}
.x-clk{cursor:pointer}
.x-tabs button{text-align:left;padding:8px 12px}
.x-tabs b{display:flex;align-items:center;gap:6px;font-weight:inherit;white-space:nowrap}
.x-tabs small{display:block;max-width:220px;font-size:11px;font-weight:400;line-height:1.3;color:var(--ink-3)}
.x-tabsep{flex:none;width:1px;margin:8px 6px;background:var(--line)}
.x-set{margin:0}
.x-set label{flex-direction:column;align-items:flex-start;gap:2px;font-size:12px}
.x-set input{font:inherit;width:150px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)}
.x-set .da-note{max-width:52ch}
.x-charts{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:12px;margin:12px 0}
.x-charts h4{margin:0 0 2px;font-size:13px;font-weight:600}
.x-charts svg{display:block;width:100%;height:auto;margin-top:6px}
.x-gl{stroke:var(--line);stroke-width:1}
.x-ax{fill:var(--ink-3);font-size:11px}
.x-lb{fill:var(--ink);font-size:11px;font-weight:600}
.x-bar{fill:var(--accent-2)}
.x-tk{stroke:var(--ink);stroke-width:2}
.x-tk.p{stroke:var(--ink-3);stroke-dasharray:4 3}
.x-ring{fill:var(--surface);stroke:var(--amber);stroke-width:2}
.x-area{fill:var(--accent-light)}
.x-dep{fill:none;stroke:var(--accent-2);stroke-width:2}
.x-tl{fill:none;stroke:var(--ink-3);stroke-width:1.5;stroke-dasharray:5 4}
.x-grp{padding:8px 0;border-bottom:1px solid var(--line)}
.x-gh{display:flex;justify-content:space-between;align-items:baseline;width:100%;padding:2px 12px;font:inherit;color:var(--ink);background:none;border:0;cursor:pointer}
.x-gh span{font-weight:600}
.x-gh small,.x-path{font-size:11px;color:var(--ink-3)}
.x-path{padding:0 12px 4px}
.x-srow{display:block;width:100%;padding:3px 12px;text-align:left;font:inherit;font-size:12px;color:inherit;background:none;border:0;cursor:pointer}
.x-r{display:flex;justify-content:space-between;gap:8px}
.x-r b{display:flex;align-items:center;gap:6px;font-weight:500}
.x-v{white-space:nowrap;color:var(--ink-3)}
.x-v em{font-style:normal;font-weight:600;color:var(--ink)}
.x-srow small{display:block;padding-left:13px;font-size:11px;color:var(--ink-3)}
.x-d2{padding-left:24px}.x-d3{padding-left:36px}.x-d4{padding-left:48px}
.x-srow.ctx{color:var(--ink-3)}
.x-dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%}
.x-dot.in{background:var(--green)}.x-dot.below{background:var(--red)}.x-dot.above{background:var(--amber)}
.x-dot.under{background:var(--surface);border:1.5px solid var(--accent-2)}.x-dot.over{background:var(--gold)}
.x-leg{display:grid;gap:6px;padding:10px 12px;font-size:11.5px;color:var(--ink-3)}
@media (max-width:1200px){.x-f7{grid-template-columns:repeat(4,minmax(0,1fr))}.x-f7 .da-fact{border-bottom:1px solid var(--line)}}
@media (max-width:860px){.x-shell,.x-charts{grid-template-columns:1fr}.x-f7{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
<div class="da">

  <header class="x-top">
    <div class="x-brand">Target Manager <span>· Fund-of-Funds &amp; Directs</span></div>
    <div class="cr-seg" role="group" aria-label="View">
      <button class="on" aria-pressed="true">Assign targets</button>
      <button aria-pressed="false">Overview</button>
      <button aria-pressed="false">Pipeline</button>
    </div>
    <div class="x-sp"></div>
    <button class="btn btn-sm" title="Undo last change (Ctrl+Z)" disabled>Undo</button>
    <button class="btn btn-sm" title="Copy all targets as CSV">Copy CSV</button>
    <button class="btn btn-sm" title="Restore the example clients and targets">Reset example</button>
  </header>

  <div class="x-shell">

    <nav class="cr-panel" aria-label="Clients and mandates">
      <div class="cr-phead"><h2>Clients &amp; mandates</h2></div>
      <div>
        <button class="x-ent" aria-current="false">
          <span class="x-l1"><b>Commonwealth Teachers’ Retirement</b><i class="cr-n">14</i><span class="da-st breach" title="5 compliance breaches">5</span></span>
          <span class="x-l2">$2B · 70 inv <span class="da-st ok" title="2026 pacing velocity">1.04x</span><span class="da-track" title="Strategy: 6 · Region: 4 · Structure: 4"><i class="on"></i><i class="on"></i><i class="on"></i></span></span>
        </button>
        <button class="x-ent m" aria-current="true">
          <span class="x-l1"><b>PE Primary Sleeve</b><i class="cr-n">17</i><span class="da-st breach" title="3 compliance breaches">3</span></span>
          <span class="x-l2">$1.2B · 30 inv <span class="da-st ok" title="2026 pacing velocity">1.06x</span><span class="da-track" title="Strategy: 9 · Region: 3 · Structure: 5"><i class="on"></i><i class="on"></i><i class="on"></i></span></span>
        </button>
        <button class="x-ent m" aria-current="false">
          <span class="x-l1"><b>Credit &amp; Real Assets Sleeve</b><i class="cr-n">9</i></span>
          <span class="x-l2">$450M · 14 inv <span class="da-st breach" title="2026 pacing velocity">0.77x</span><span class="da-track" title="Strategy: 7 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span>
        </button>
        <button class="x-ent m" aria-current="false">
          <span class="x-l1"><b>Co-Investment Sleeve</b><i class="cr-n">7</i><span class="da-st breach" title="2 compliance breaches">2</span></span>
          <span class="x-l2">$400M · 24 inv <span class="da-st ok" title="2026 pacing velocity">1.14x</span><span class="da-track" title="Strategy: 4 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span>
        </button>
        <button class="x-ent" aria-current="false">
          <span class="x-l1"><b>Halvorsen Family Office</b><i class="cr-n">3</i><span class="da-st breach" title="1 compliance breach">1</span></span>
          <span class="x-l2">$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="da-track" title="Strategy: 0 · Region: 3 · Structure: 0"><i></i><i class="on"></i><i></i></span></span>
        </button>
        <button class="x-ent m" aria-current="false">
          <span class="x-l1"><b>Diversified Sleeve</b><i class="cr-n">4</i><span class="da-st breach" title="1 compliance breach">1</span></span>
          <span class="x-l2">$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="da-track" title="Strategy: 4 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span>
        </button>
        <button class="x-ent" aria-current="false">
          <span class="x-l1"><b>Northgate Mutual Insurance</b><i class="cr-n">2</i><span class="da-st breach" title="3 compliance breaches">3</span></span>
          <span class="x-l2">$900M · 40 inv <span class="da-st ok" title="2026 pacing velocity">1.11x</span><span class="da-track" title="Strategy: 2 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span>
        </button>
        <button class="x-ent m" aria-current="false">
          <span class="x-l1"><b>Private Credit Sleeve</b><i class="cr-n">10</i><span class="da-st breach" title="3 compliance breaches">3</span></span>
          <span class="x-l2">$600M · 28 inv <span class="da-chip" title="2026 pacing velocity">1.16x</span><span class="da-track" title="Strategy: 8 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span>
        </button>
        <button class="x-ent m" aria-current="false">
          <span class="x-l1"><b>Secondaries Sleeve</b><i class="cr-n">6</i></span>
          <span class="x-l2">$200M · 10 inv <span class="da-st breach" title="2026 pacing velocity">0.85x</span><span class="da-track" title="Strategy: 3 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span>
        </button>
      </div>
      <button class="btn btn-sm x-add">+ Add mandate sleeve</button>
    </nav>

    <main>
      <div class="crumbs"><a class="crumb-link" href="#">Commonwealth Teachers’ Retirement</a><span class="sep">›</span><span class="crumb-current">Mandate sleeve</span></div>
      <div class="pipe-head">
        <h1>PE Primary Sleeve</h1>
        <div class="x-acts">
          <span>% basis</span>
          <div class="cr-seg" role="group" aria-label="Percent basis" data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">
            <button aria-pressed="false" title="Percent targets are a share of the total program">Program</button>
            <button class="on" aria-pressed="true" title="Percent targets are a share of the level above">Parent level</button>
          </div>
          <button class="btn btn-sm">Copy targets from…</button>
        </div>
      </div>

      <header class="da-ribbon" role="group" aria-label="Deployment and pacing">
        <div class="da-facts x-f7">
          <div class="da-fact"><span>Program</span><strong data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$1.2B</strong><small>74% committed · since <span data-attr="INCEPTION_DATE">Apr 2022</span></small></div>
          <div class="da-fact"><span>Investments</span><strong>22 <small>/ <span data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">30</span></small></strong><small>made vs target</small></div>
          <div class="da-fact x-wide"><span>2026 deployment vs target</span><strong>$167M <small>/ <span data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$180M</span></small></strong>
            <div class="fs-track" title="Bar: deployed against the 2026 target. Marker: where pacing says you should be by 17 Nov 2026"><i style="width:92.8%"></i><b style="left:87.7%"></b></div>
            <small>93% of annual · $157.8M expected to date</small></div>
          <div class="da-fact"><span>Pacing velocity</span><strong class="up">1.06x <span class="da-st ok">On pace</span></strong><small>YTD vs time-weighted target</small></div>
          <div class="da-fact"><span>Since inception</span><strong class="up" title="On pace">1.07x</strong><small>$893.9M vs $833.4M</small></div>
          <div class="da-fact x-clk" data-tab="compliance" role="button" tabindex="0" title="Open the compliance tab"><span>Compliance</span><strong class="dn">3 breaches</strong><small>13 rules · 1 watch · 2 pending · 2 soft</small></div>
          <div class="da-fact"><span>Run-rate (LTM)</span><strong>$193.5M<small>/yr</small></strong><small>$306.1M left · ≈1.6 yrs at this pace</small></div>
        </div>
      </header>

      <div class="da-tabs x-tabs" role="tablist">
        <button role="tab" aria-selected="false"><b>Strategy <i class="cr-n">9</i></b><small>Category › Asset Class › Strategy › Sub-Strategy</small></button>
        <button role="tab" aria-selected="false"><b>Region <i class="cr-n">3</i></b><small>Region › Asset Class</small></button>
        <button role="tab" aria-selected="false"><b>Structure <i class="cr-n">5</i></b><small>Category › Structure Type › Detail</small></button>
        <span class="x-tabsep" aria-hidden="true"></span>
        <button class="on" role="tab" aria-selected="true"><b>Pacing</b><small>Annual deployment by year</small></button>
        <button role="tab" aria-selected="false"><b>Commitments <i class="cr-n">22</i></b><small>Original commitments and attributes</small></button>
        <button role="tab" aria-selected="false"><b>Compliance <span class="da-st breach">3 breaches</span></b><small>Rules, limits and results</small></button>
      </div>

      <section class="da-sec">
        <div class="da-toolbar x-set">
          <label for="pStart">Mandate start<input type="date" id="pStart" value="2022-04-01" data-attr="INCEPTION_DATE"></label>
          <label for="pEnd">Investment period end<input type="date" id="pEnd" value="2027-04-01" data-attr="FUND_INVESTMENT_PERIOD_END" data-editable="true"></label>
          <label for="pAnnual">Annual deployment target<input id="pAnnual" value="$180M" placeholder="e.g. 150M" data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true"></label>
          <p class="da-note">The first year is prorated from the start date. Type a figure in any year's target to override it. Pacing is measured as of 17 Nov 2026.</p>
        </div>

        <div class="x-charts">
          <div class="da-chart">
            <h4>Annual deployment vs target</h4>
            <p class="da-note">Bars are commitments by investment year; dark ticks are the yearly target, and the ring is where 2026 should be today.</p>
            <svg viewBox="0 0 640 230" role="img" aria-label="Annual deployment against target by year">
              <line class="x-gl" x1="50" x2="630" y1="200" y2="200"/><line class="x-gl" x1="50" x2="630" y1="140" y2="140"/><line class="x-gl" x1="50" x2="630" y1="80" y2="80"/><line class="x-gl" x1="50" x2="630" y1="20" y2="20"/>
              <text class="x-ax" x="44" y="204" text-anchor="end">$0</text><text class="x-ax" x="44" y="144" text-anchor="end">$100M</text><text class="x-ax" x="44" y="84" text-anchor="end">$200M</text><text class="x-ax" x="44" y="24" text-anchor="end">$300M</text>
              <rect class="x-bar" x="69.4" y="105.2" width="44" height="94.8"><title>2022 deployed: $158M</title></rect>
              <line class="x-tk" x1="63.4" x2="119.4" y1="118.6" y2="118.6"><title>2022 target: $135.6M</title></line>
              <text class="x-lb" x="91.4" y="99" text-anchor="middle">$158M</text>
              <text class="x-ax" x="91.4" y="218" text-anchor="middle">2022</text>
              <rect class="x-bar" x="152.3" y="85.7" width="44" height="114.3"><title>2023 deployed: $190.5M</title></rect>
              <line class="x-tk" x1="146.3" x2="202.3" y1="92" y2="92"><title>2023 target: $180M</title></line>
              <text class="x-lb" x="174.3" y="79" text-anchor="middle">$190.5M</text>
              <text class="x-ax" x="174.3" y="218" text-anchor="middle">2023</text>
              <rect class="x-bar" x="235.1" y="95.9" width="44" height="104.1"><title>2024 deployed: $173.5M</title></rect>
              <line class="x-tk" x1="229.1" x2="285.1" y1="92" y2="92"><title>2024 target: $180M</title></line>
              <text class="x-lb" x="257.1" y="85" text-anchor="middle">$173.5M</text>
              <text class="x-ax" x="257.1" y="218" text-anchor="middle">2024</text>
              <rect class="x-bar" x="318" y="77.1" width="44" height="122.9"><title>2025 deployed: $204.9M</title></rect>
              <line class="x-tk" x1="312" x2="368" y1="92" y2="92"><title>2025 target: $180M</title></line>
              <text class="x-lb" x="340" y="71" text-anchor="middle">$204.9M</text>
              <text class="x-ax" x="340" y="218" text-anchor="middle">2025</text>
              <rect class="x-bar" x="400.9" y="99.8" width="44" height="100.2"><title>2026 deployed: $167M</title></rect>
              <line class="x-tk" x1="394.9" x2="450.9" y1="92" y2="92"><title>2026 target: $180M</title></line>
              <circle class="x-ring" cx="422.9" cy="105.3" r="4"><title>Expected by 17 Nov 2026: $157.8M</title></circle>
              <text class="x-lb" x="422.9" y="85" text-anchor="middle">$167M</text>
              <text class="x-lb" x="422.9" y="218" text-anchor="middle">2026 YTD</text>
              <line class="x-tk p" x1="477.7" x2="533.7" y1="92" y2="92"><title>2027 target: $180M</title></line>
              <text class="x-ax" x="505.7" y="85" text-anchor="middle">$180M</text>
              <text class="x-ax" x="505.7" y="218" text-anchor="middle">2027</text>
              <line class="x-tk p" x1="560.6" x2="616.6" y1="92" y2="92"><title>2028 target: $180M</title></line>
              <text class="x-ax" x="588.6" y="85" text-anchor="middle">$180M</text>
              <text class="x-ax" x="588.6" y="218" text-anchor="middle">2028</text>
            </svg>
            <div class="fs-legend"><span><i style="background:var(--accent-2)"></i>Deployed</span><span><i style="height:2px;vertical-align:middle;background:var(--ink)"></i>Target</span><span><i style="width:10px;height:10px;border-radius:50%;border:2px solid var(--amber);background:var(--surface)"></i>Expected by 17 Nov 2026: $157.8M</span></div>
          </div>

          <div class="da-chart">
            <h4>Cumulative deployment</h4>
            <p class="da-note">Committed since inception against the cumulative time-weighted target.</p>
            <svg viewBox="0 0 420 230" role="img" aria-label="Cumulative deployment against cumulative target">
              <line class="x-gl" x1="50" x2="410" y1="200" y2="200"/><line class="x-gl" x1="50" x2="410" y1="140" y2="140"/><line class="x-gl" x1="50" x2="410" y1="80" y2="80"/><line class="x-gl" x1="50" x2="410" y1="20" y2="20"/>
              <text class="x-ax" x="44" y="204" text-anchor="end">$0</text><text class="x-ax" x="44" y="144" text-anchor="end">$500M</text><text class="x-ax" x="44" y="84" text-anchor="end">$1B</text><text class="x-ax" x="44" y="24" text-anchor="end">$1.5B</text>
              <line class="x-tk p" x1="50" x2="410" y1="56" y2="56"/>
              <text class="x-ax" x="56" y="50">Program $1.2B</text>
              <polygon class="x-area" points="50,181 137.5,158.2 225,137.4 312.5,112.8 400,92.7 400,200 50,200"/>
              <polyline class="x-tl" points="50,183.7 137.5,162.1 225,140.5 312.5,118.9 400,100"/>
              <polyline class="x-dep" points="50,181 137.5,158.2 225,137.4 312.5,112.8 400,92.7"/>
              <circle cx="400" cy="92.7" r="3.5" class="x-bar"/>
              <text class="x-lb" x="394" y="84" text-anchor="end">$893.9M</text>
              <text class="x-ax" x="394" y="122" text-anchor="end">Target $833.4M</text>
              <text class="x-ax" x="56" y="218" text-anchor="middle">2022</text><text class="x-ax" x="137.5" y="218" text-anchor="middle">2023</text><text class="x-ax" x="225" y="218" text-anchor="middle">2024</text><text class="x-ax" x="312.5" y="218" text-anchor="middle">2025</text><text class="x-ax" x="398" y="218" text-anchor="middle">2026</text>
            </svg>
            <div class="fs-legend"><span><i style="background:var(--accent-2)"></i>Deployed</span><span><i style="height:2px;vertical-align:middle;background:var(--ink-3)"></i>Target to date</span></div>
          </div>
        </div>

        <div class="da-gridwrap">
          <table class="da-grid fit">
            <thead><tr><th>Year</th><th class="num">Target</th><th class="num">Deployed</th><th class="num"># Inv.</th><th class="num">vs Target</th><th class="num">Expected to date · velocity</th><th class="num">Cum. target</th><th class="num">Cum. deployed</th><th class="num">Cum. velocity</th></tr></thead>
            <tbody>
              <tr><td>2022</td><td class="num act" data-editable="true"><input value="" placeholder="$135.6M" aria-label="2022 deployment target" title="Annual target, prorated from the start date. Type to set a year-specific target."></td><td class="num">$158M</td><td class="num">4</td><td class="num"><span class="da-st ok">116%</span></td><td class="num"></td><td class="num">$135.6M</td><td class="num">$158M</td><td class="num">1.16x</td></tr>
              <tr><td>2023</td><td class="num act" data-editable="true"><input value="" placeholder="$180M" aria-label="2023 deployment target" title="Annual target. Type to set a year-specific target."></td><td class="num">$190.5M</td><td class="num">5</td><td class="num"><span class="da-st ok">106%</span></td><td class="num"></td><td class="num">$315.6M</td><td class="num">$348.5M</td><td class="num">1.10x</td></tr>
              <tr><td>2024</td><td class="num act" data-editable="true"><input value="" placeholder="$180M" aria-label="2024 deployment target" title="Annual target. Type to set a year-specific target."></td><td class="num">$173.5M</td><td class="num">4</td><td class="num"><span class="da-st ok">96%</span></td><td class="num"></td><td class="num">$495.6M</td><td class="num">$522M</td><td class="num">1.05x</td></tr>
              <tr><td>2025</td><td class="num act" data-editable="true"><input value="" placeholder="$180M" aria-label="2025 deployment target" title="Annual target. Type to set a year-specific target."></td><td class="num">$204.9M</td><td class="num">5</td><td class="num"><span class="da-st ok">114%</span></td><td class="num"></td><td class="num">$675.6M</td><td class="num">$726.9M</td><td class="num">1.08x</td></tr>
              <tr class="sel"><td><b>2026</b><small>YTD</small></td><td class="num act" data-editable="true"><input value="" placeholder="$180M" aria-label="2026 deployment target" title="Annual target. Type to set a year-specific target."></td><td class="num"><b>$167M</b></td><td class="num">4</td><td class="num"><span class="da-st ok">93%</span></td><td class="num">$157.8M · 1.06x</td><td class="num">$833.4M</td><td class="num">$893.9M</td><td class="num">1.07x</td></tr>
              <tr><td>2027<small>plan</small></td><td class="num act" data-editable="true"><input value="" placeholder="$180M" aria-label="2027 deployment target" title="Annual target. Type to set a year-specific target."></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td></tr>
              <tr><td>2028<small>plan</small></td><td class="num act" data-editable="true"><input value="" placeholder="$180M" aria-label="2028 deployment target" title="Annual target. Type to set a year-specific target."></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>

    <!-- Assigned-targets side panel: present but collapsed in this state, as in the original (body.noside) -->
    <aside class="cr-panel" aria-label="Assigned targets" data-attr="FUND_TARGET_MATRIX" hidden>
      <div class="cr-phead"><h2>Assigned targets</h2></div>

      <section class="x-grp">
        <button class="x-gh" title="Open the Strategy targets"><span>Strategy</span><small>9 targets</small></button>
        <div class="x-path">Category › Asset Class › Strategy › Sub-Strategy</div>
        <button class="x-srow" title="Primary"><span class="x-r"><b><i class="x-dot in" title="In range · under target"></i>Primary</b><span class="x-v"><em>$900M</em> ≈75% <em>22#</em></span></span><small>range $800M–$1B · 18–26#</small></button>
        <button class="x-srow x-d2" title="Primary › Private Equity"><span class="x-r"><b><i class="x-dot under" title="93% of target"></i>Private Equity</b><span class="x-v">≈$900M <em>100%</em></span></span></button>
        <button class="x-srow x-d3" title="Primary › Private Equity › Buyout"><span class="x-r"><b><i class="x-dot above" title="Above max"></i>Buyout</b><span class="x-v">≈$540M <em>60%</em> <em>9#</em></span></span><small>range 7–11# · 50%–70%</small></button>
        <button class="x-srow x-d4" title="Primary › Private Equity › Buyout › Small Cap"><span class="x-r"><b><i class="x-dot under" title="71% of target"></i>Small Cap</b><span class="x-v">≈$135M <em>25%</em></span></span></button>
        <button class="x-srow x-d4" title="Primary › Private Equity › Buyout › Mid Cap"><span class="x-r"><b><i class="x-dot above" title="Above max"></i>Mid Cap</b><span class="x-v">≈$243M <em>45%</em></span></span><small>range 35%–55%</small></button>
        <button class="x-srow x-d4" title="Primary › Private Equity › Buyout › Large Cap"><span class="x-r"><b><i class="x-dot under" title="91% of target"></i>Large Cap</b><span class="x-v">≈$108M <em>20%</em></span></span></button>
        <button class="x-srow x-d3" title="Primary › Private Equity › Growth Equity"><span class="x-r"><b><i class="x-dot under" title="67% of target"></i>Growth Equity</b><span class="x-v">≈$135M <em>15%</em> <em>3#</em></span></span><small>range 10%–20%</small></button>
        <button class="x-srow x-d3" title="Primary › Private Equity › Venture Capital"><span class="x-r"><b><i class="x-dot under" title="75% of target"></i>Venture Capital</b><span class="x-v">≈$180M <em>20%</em> <em>4#</em></span></span><small>range 10%–25%</small></button>
        <button class="x-srow" title="Secondary"><span class="x-r"><b><i class="x-dot below" title="Below min"></i>Secondary</b><span class="x-v"><em>$300M</em> ≈25% <em>8#</em></span></span><small>range $200M–…</small></button>
      </section>

      <section class="x-grp">
        <button class="x-gh" title="Open the Region targets"><span>Region</span><small>3 targets</small></button>
        <div class="x-path">Region › Asset Class</div>
        <button class="x-srow" title="North America"><span class="x-r"><b><i class="x-dot above" title="Above max"></i>North America</b><span class="x-v">≈$840M <em>70%</em></span></span><small>range 60%–80%</small></button>
        <button class="x-srow" title="Western Europe"><span class="x-r"><b><i class="x-dot under" title="26% of target"></i>Western Europe</b><span class="x-v">≈$300M <em>25%</em></span></span></button>
        <button class="x-srow" title="APAC/ROW"><span class="x-r"><b><i class="x-dot in" title="In range · under target"></i>APAC/ROW</b><span class="x-v">≈$120M <em>10%</em></span></span><small>range …–15%</small></button>
      </section>

      <section class="x-grp">
        <button class="x-gh" title="Open the Structure targets"><span>Structure</span><small>5 targets</small></button>
        <div class="x-path">Category › Structure Type › Detail</div>
        <button class="x-srow ctx" title="Primary"><span class="x-r"><b>Primary</b><span class="x-v">no target</span></span></button>
        <button class="x-srow x-d2" title="Primary › Traditional Primary"><span class="x-r"><b><i class="x-dot over" title="Over target"></i>Traditional Primary</b><span class="x-v"><em>85%</em></span></span></button>
        <button class="x-srow x-d2" title="Primary › Fund-of-Funds"><span class="x-r"><b><i class="x-dot under" title="63% of target"></i>Fund-of-Funds</b><span class="x-v"><em>5%</em></span></span></button>
        <button class="x-srow ctx" title="Secondary"><span class="x-r"><b>Secondary</b><span class="x-v">no target</span></span></button>
        <button class="x-srow x-d2" title="Secondary › GP Led"><span class="x-r"><b><i class="x-dot under" title="48% of target"></i>GP Led</b><span class="x-v"><em>$120M</em></span></span></button>
        <button class="x-srow x-d3" title="Secondary › GP Led › Single Asset"><span class="x-r"><b><i class="x-dot under" title="72% of target"></i>Single Asset</b><span class="x-v"><em>$80M</em> ≈66.7%</span></span></button>
        <button class="x-srow x-d3" title="Secondary › GP Led › Multi Asset"><span class="x-r"><b><i class="x-dot under" title="0% of target"></i>Multi Asset</b><span class="x-v"><em>$60M</em> ≈50%</span></span></button>
      </section>

      <div class="x-leg">
        <div><span class="da-st ok">$ 100%</span> next level adds up</div>
        <div><span class="da-st near">$ 85%</span> next level is under</div>
        <div><span class="da-st breach">$ 105%</span> next level is over</div>
        <div>Dots show the worst band status on the row: <i class="x-dot in"></i> in range <i class="x-dot below"></i> below min <i class="x-dot above"></i> above max <i class="x-dot under"></i> building to target.</div>
        <div>Values with ≈ are implied from the other measure. Muted rows have no target of their own but hold targets below.</div>
      </div>
    </aside>

  </div>
</div>
```

### Compliance (house design)

Compliance, redesigned in the house kit from the captured view and checked against it.

```html
<style>
.x-app{display:grid;grid-template-columns:240px minmax(0,1fr);gap:14px;align-items:start}
.x-top{gap:12px;flex-wrap:wrap;box-shadow:none}
.x-brand{font-size:14px;font-weight:600}
.x-brand span{font-weight:400;color:var(--ink-3)}
.x-seg button{font:inherit;font-size:12.5px;padding:5px 11px;color:var(--ink-2)}
.x-seg button+button{border-left:1px solid var(--line)}
.x-seg button[aria-pressed="true"]{color:#fff;font-weight:600}
.x-acts{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-3);flex-wrap:wrap}
.x-rail{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px 0 12px}
.x-rail h2{margin:0;padding:0 12px 8px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3)}
.x-ent{display:block;width:100%;text-align:left;border:0;border-top:1px solid var(--line);background:none;font:inherit;color:inherit;padding:7px 12px;cursor:pointer}
.x-ent.mandate{padding-left:24px}
.x-ent[aria-current="true"]{background:var(--bg-alt);box-shadow:inset 3px 0 0 var(--accent-2)}
.x-entl{display:flex;gap:6px;align-items:center}
.x-entl b{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.x-ent small{display:flex;gap:6px;align-items:center;margin-top:3px;font-size:11.5px;color:var(--ink-3)}
.x-ent .da-track{margin:0 0 0 auto}
.x-ent .da-track i{width:12px;height:4px}
.x-add{margin:10px 12px 0;width:calc(100% - 24px);justify-content:center}
.x-ribbon .da-title{flex-basis:100%;border-right:0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px}
.x-facts7{grid-template-columns:repeat(2,minmax(96px,0.9fr)) minmax(190px,1.6fr) repeat(4,minmax(110px,1fr))}
.x-facts7 .da-fact{padding:9px 12px;border-bottom:0}
.x-facts7 .da-fact:last-child{border-right:0}
.x-facts7 .da-fact span{font-size:11.5px}
.x-facts7 .da-fact strong{font-size:18px;font-weight:600;display:flex;gap:6px;align-items:baseline;white-space:nowrap}
.x-facts7 .da-fact strong small{font-size:12px;font-weight:400}
.x-facts7 .da-fact>small{font-size:11.5px;line-height:1.35}
.x-facts7 .fs-track{height:8px;margin:5px 0 3px}
.x-factlink{cursor:pointer}
.x-tabs{margin:12px 0 10px}
.x-tabs button{display:flex;flex-direction:column;justify-content:flex-start;align-items:flex-start;gap:1px;text-align:left;white-space:nowrap;padding:7px 12px}
.x-tabs button b{display:flex;align-items:center}
.x-tabs button small{font-size:11px;font-weight:400;color:var(--ink-3)}
.x-tabs .cr-n,.x-tabs .da-st{margin-left:6px}
.x-tabsep{flex:none;width:1px;margin:8px 6px;background:var(--line)}
.x-tile{font:inherit;text-align:left;color:inherit;cursor:pointer}
.x-tile b.bad{color:var(--red)}.x-tile b.soft{color:var(--amber)}.x-tile b.warn{color:var(--gold)}.x-tile b.pend{color:var(--accent-2)}.x-tile b.ok{color:var(--green)}
.x-rules{min-width:1320px}
.x-rules th,.x-rules td{padding:5px 8px}
.x-rules th{white-space:nowrap;font-weight:600;font-size:12px}
.x-rules .x-nw{white-space:nowrap}
.x-rules .da-st{white-space:nowrap}
.x-rules .da-caret{width:18px;height:18px;margin-right:2px;padding:0;font-size:10px;line-height:1;flex:none}
.x-grp td{background:var(--bg-alt);font-weight:600;font-size:12.5px}
.da-grid .x-grp small{display:inline;margin-left:8px}
.x-req{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.x-req.muted{color:var(--ink-3)}
.x-in{font:inherit;width:56px;padding:1px 6px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:inherit;text-align:right}
.x-sev{padding:2px 8px}
.x-sev.soft{color:var(--amber);border-color:var(--amber)}
.x-chips{display:flex;flex-wrap:nowrap;gap:3px;align-items:center}
.x-fc{font-size:10.5px;font-weight:600;padding:0 5px;border:1px solid var(--line);border-radius:4px;color:var(--ink-2);background:var(--surface)}
.x-fc.ctx{background:var(--bg-alt)}
.x-fc.gap{border-style:dashed;color:var(--amber)}
.x-del{border:0;background:none;font:inherit;color:var(--ink-4);cursor:pointer;padding:0 4px}
.x-st.soft{background:var(--surface);color:var(--amber);border:1px solid var(--amber)}
.x-st.pend,.x-st.ahead{background:var(--badge-info-bg);color:var(--badge-info-fg)}
.x-link{border:0;background:none;font:inherit;color:var(--accent-2);cursor:pointer;padding:0;text-decoration:underline}
.x-side>summary{cursor:pointer;font-size:14px;font-weight:600;padding:10px 0}
.x-tgt{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}
.x-srow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;width:100%;padding:5px 0;border:0;border-bottom:1px solid var(--line);background:none;font:inherit;font-size:12.5px;color:inherit;text-align:left;cursor:pointer}
.x-srow.d2{padding-left:14px}.x-srow.d3{padding-left:28px}.x-srow.d4{padding-left:42px}
.x-srow.ctx b{color:var(--ink-3);font-weight:500}
.x-srow em{font-style:normal;font-weight:600}
.x-srow .rg{grid-column:1/-1;font-size:11.5px;color:var(--ink-3)}
.x-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:0}
.x-dot.in{background:var(--green)}.x-dot.below{background:var(--amber)}.x-dot.above{background:var(--red)}.x-dot.under{background:var(--accent-2)}.x-dot.over{background:var(--gold)}
.x-gh{display:flex;justify-content:space-between;align-items:baseline;width:100%;border:0;background:none;font:inherit;font-weight:600;color:inherit;cursor:pointer;padding:0}
.x-legend{display:grid;gap:4px;margin-top:12px;font-size:12px;color:var(--ink-3)}
@media (max-width:1000px){.x-app,.x-tgt{grid-template-columns:1fr}.x-facts7{grid-template-columns:repeat(2,1fr)}}
</style>
<div class="da">
  <header class="page-header x-top">
    <div class="page-title-block">
      <div class="x-brand">Target Manager <span>· Fund-of-Funds &amp; Directs</span></div>
      <div class="fs-seg x-seg" role="group" aria-label="View">
        <button aria-pressed="true">Assign targets</button><button aria-pressed="false">Overview</button><button aria-pressed="false">Pipeline</button>
      </div>
    </div>
    <div class="page-actions">
      <button class="btn btn-sm" title="Undo last change (Ctrl+Z)" disabled>Undo</button>
      <button class="btn btn-sm" title="Copy all targets as CSV">Copy CSV</button>
      <button class="btn btn-sm" title="Restore the example clients and targets">Reset example</button>
    </div>
  </header>

  <div class="x-app">
    <nav class="x-rail" aria-label="Clients and mandates">
      <h2>Clients &amp; mandates</h2>
      <button class="x-ent client" aria-current="false"><span class="x-entl"><b>Commonwealth Teachers’ Retirement</b><i class="cr-n">14</i><span class="da-st breach" title="5 compliance breaches">5</span></span><small>$2B · 70 inv <span class="da-st ok" title="2026 pacing velocity">1.04x</span><span class="da-track" title="Strategy: 6 · Region: 4 · Structure: 4"><i class="on"></i><i class="on"></i><i class="on"></i></span></small></button>
      <button class="x-ent mandate" aria-current="true"><span class="x-entl"><b>PE Primary Sleeve</b><i class="cr-n">17</i><span class="da-st breach" title="3 compliance breaches">3</span></span><small>$1.2B · 30 inv <span class="da-st ok" title="2026 pacing velocity">1.06x</span><span class="da-track" title="Strategy: 9 · Region: 3 · Structure: 5"><i class="on"></i><i class="on"></i><i class="on"></i></span></small></button>
      <button class="x-ent mandate" aria-current="false"><span class="x-entl"><b>Credit &amp; Real Assets Sleeve</b><i class="cr-n">9</i></span><small>$450M · 14 inv <span class="da-st breach" title="2026 pacing velocity">0.77x</span><span class="da-track" title="Strategy: 7 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></small></button>
      <button class="x-ent mandate" aria-current="false"><span class="x-entl"><b>Co-Investment Sleeve</b><i class="cr-n">7</i><span class="da-st breach" title="2 compliance breaches">2</span></span><small>$400M · 24 inv <span class="da-st ok" title="2026 pacing velocity">1.14x</span><span class="da-track" title="Strategy: 4 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></small></button>
      <button class="x-ent client" aria-current="false"><span class="x-entl"><b>Halvorsen Family Office</b><i class="cr-n">3</i><span class="da-st breach" title="1 compliance breach">1</span></span><small>$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="da-track" title="Strategy: 0 · Region: 3 · Structure: 0"><i></i><i class="on"></i><i></i></span></small></button>
      <button class="x-ent mandate" aria-current="false"><span class="x-entl"><b>Diversified Sleeve</b><i class="cr-n">4</i><span class="da-st breach" title="1 compliance breach">1</span></span><small>$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="da-track" title="Strategy: 4 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></small></button>
      <button class="x-ent client" aria-current="false"><span class="x-entl"><b>Northgate Mutual Insurance</b><i class="cr-n">2</i><span class="da-st breach" title="3 compliance breaches">3</span></span><small>$900M · 40 inv <span class="da-st ok" title="2026 pacing velocity">1.11x</span><span class="da-track" title="Strategy: 2 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></small></button>
      <button class="x-ent mandate" aria-current="false"><span class="x-entl"><b>Private Credit Sleeve</b><i class="cr-n">10</i><span class="da-st breach" title="3 compliance breaches">3</span></span><small>$600M · 28 inv <span class="da-st x-st ahead" title="2026 pacing velocity">1.16x</span><span class="da-track" title="Strategy: 8 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></small></button>
      <button class="x-ent mandate" aria-current="false"><span class="x-entl"><b>Secondaries Sleeve</b><i class="cr-n">6</i></span><small>$200M · 10 inv <span class="da-st breach" title="2026 pacing velocity">0.85x</span><span class="da-track" title="Strategy: 3 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></small></button>
      <button class="btn btn-sm x-add">+ Add mandate sleeve</button>
    </nav>

    <main>
      <div class="crumbs"><a class="crumb-link" href="#">Commonwealth Teachers’ Retirement</a><span class="sep">›</span><span class="crumb-current">Mandate sleeve</span></div>
      <header class="da-ribbon x-ribbon" aria-label="Deployment and pacing">
        <div class="da-title">
          <h1>PE Primary Sleeve</h1>
          <div class="x-acts">
            <span>% basis</span>
            <div class="fs-seg x-seg" role="group" aria-label="Percent basis" data-editable="true">
              <button aria-pressed="false" title="Percent targets are a share of the total program">Program</button><button aria-pressed="true" title="Percent targets are a share of the level above">Parent level</button>
            </div>
            <button class="btn btn-sm">Copy targets from…</button>
          </div>
        </div>
        <div class="da-facts x-facts7">
          <div class="da-fact"><span>Program</span><strong data-attr="MND01">$1.2B</strong><small>74% committed · since Apr 2022</small></div>
          <div class="da-fact"><span>Investments</span><strong>22 <small>/ 30</small></strong><small>made vs target</small></div>
          <div class="da-fact"><span>2026 deployment vs target</span><strong>$167M <small>/ $180M</small></strong>
            <div class="fs-track" title="Bar: deployed against the 2026 target. Marker: where pacing says you should be by 17 Nov 2026"><i style="width:92.8%"></i><b style="left:87.7%"></b></div>
            <small>93% of annual · $157.8M expected to date</small></div>
          <div class="da-fact"><span>Pacing velocity</span><strong class="up">1.06x <span class="da-st ok">On pace</span></strong><small>YTD vs time-weighted target</small></div>
          <div class="da-fact"><span>Since inception</span><strong class="up" title="On pace">1.07x</strong><small>$893.9M vs $833.4M</small></div>
          <div class="da-fact x-factlink" role="button" tabindex="0" title="Open the compliance tab"><span>Compliance</span><strong class="dn">3 breaches</strong><small>13 rules · 1 watch · 2 pending · 2 soft</small></div>
          <div class="da-fact"><span>Run-rate (LTM)</span><strong>$193.5M<small>/yr</small></strong><small>$306.1M left · ≈1.6 yrs at this pace</small></div>
        </div>
      </header>

      <div class="da-tabs x-tabs" role="tablist">
        <button role="tab" aria-selected="false"><b>Strategy<i class="cr-n">9</i></b><small>Category › Asset Class › Strategy › Sub-Strategy</small></button>
        <button role="tab" aria-selected="false"><b>Region<i class="cr-n">3</i></b><small>Region › Asset Class</small></button>
        <button role="tab" aria-selected="false"><b>Structure<i class="cr-n">5</i></b><small>Category › Structure Type › Detail</small></button>
        <span class="x-tabsep" aria-hidden="true"></span>
        <button role="tab" aria-selected="false"><b>Pacing</b><small>Annual deployment by year</small></button>
        <button role="tab" aria-selected="false"><b>Commitments<i class="cr-n">22</i></b><small>Original commitments and attributes</small></button>
        <button role="tab" aria-selected="true" class="on"><b>Compliance<span class="da-st breach">3 breaches</span></b><small>Rules, limits and results</small></button>
      </div>

      <section class="da-sec">
        <div class="fs-tiles">
          <button class="fs-tile x-tile"><b class="bad">1</b><span>Breach</span></button>
          <button class="fs-tile x-tile"><b class="soft">2</b><span>Soft breach</span></button>
          <button class="fs-tile x-tile"><b class="warn">1</b><span>Watch</span></button>
          <button class="fs-tile x-tile"><b class="pend">2</b><span>Pending</span></button>
          <button class="fs-tile x-tile"><b class="ok">7</b><span>Pass</span></button>
          <div class="fs-tile"><b>13</b><span>Rules on this mandate</span></div>
        </div>
        <div class="da-toolbar">
          <select class="btn btn-sm" aria-label="Add a rule">
            <option value="">+ Add rule from the rule book…</option>
            <option>Asset Concentration (amount limit)</option><option>Investment Size</option><option>Industry Concentration</option><option>China-specific Primary Investments</option><option>HL Managed/Affiliated (% limit)</option><option>Exposures per Geography</option><option>No Real Estate Funds</option><option>Restricted Industries</option><option>No Fund-of-Funds</option><option>ESG Guidelines</option>
          </select>
          <span class="da-note">Expand a rule to see what drives it, and select a commitment there to open its full record · limits are tested against the <span data-attr="MND01">$1.2B</span> program and 22 commitments</span>
        </div>

        <div class="da-main solo">
          <div class="da-gridwrap">
            <table class="da-grid x-rules">
              <thead><tr><th>Status</th><th>Rule</th><th>Severity</th><th>Requirement</th><th class="num">Result</th><th class="num">Numerator / denominator</th><th class="num">Cushion</th><th>Worst dimension</th><th>Fields</th></tr></thead>
              <tbody>
                <tr class="x-grp"><td colspan="9">Whole investment – amount vs limit<small>4 rules</small></td></tr>
                <tr>
                  <td><span class="da-st near">Watch</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>Asset Concentration (% limit)</b></div></td>
                  <td><button class="btn btn-sm x-sev" data-editable="true" title="Switch between hard and soft limit">Hard</button></td>
                  <td><span class="x-req">&lt; <input class="x-in" value="5%" data-editable="true" aria-label="Asset Concentration (% limit) limit"></span></td>
                  <td class="num x-nw"><b>5%</b></td><td class="num x-nw">$59.5M / <span data-attr="MND01">$1.2B</span></td><td class="num">0%</td>
                  <td class="x-nw">Saltmarsh Growth Partners VII</td>
                  <td><div class="x-chips"><span class="x-fc" title="ECO01 · Commitment Amount (Local) — on 22 of 22 commitments">ECO01</span><span class="x-fc" title="ECO03 · Commitment Amount (Mandate Base Currency) — on 22 of 22 commitments">ECO03</span><span class="x-fc ctx" title="MND01 · Mandate Total Commitment / Program Size — mandate setting">MND01</span><span class="x-fc" title="IDN05 · Underlying Asset (Fund / Company) — on 22 of 22 commitments">IDN05</span><span class="x-fc" title="IDN04 · Investment Type — on 22 of 22 commitments">IDN04</span><span class="x-fc" title="IDN06 · Follow-On Flag &amp; Parent Investment — on 22 of 22 commitments">IDN06</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Asset Concentration (% limit)">×</button></div></td>
                </tr>
                <tr>
                  <td><span class="da-st ok">Pass</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>Issuer Concentration (% limit)</b></div></td>
                  <td><button class="btn btn-sm x-sev" data-editable="true" title="Switch between hard and soft limit">Hard</button></td>
                  <td><span class="x-req">&lt; <input class="x-in" value="12%" data-editable="true" aria-label="Issuer Concentration (% limit) limit"></span></td>
                  <td class="num x-nw"><b>9.7%</b></td><td class="num x-nw">$116.5M / <span data-attr="MND01">$1.2B</span></td><td class="num">2.3%</td>
                  <td class="x-nw">Harborview</td>
                  <td><div class="x-chips"><span class="x-fc" title="ECO01 · Commitment Amount (Local) — on 22 of 22 commitments">ECO01</span><span class="x-fc" title="ECO03 · Commitment Amount (Mandate Base Currency) — on 22 of 22 commitments">ECO03</span><span class="x-fc ctx" title="MND01 · Mandate Total Commitment / Program Size — mandate setting">MND01</span><span class="x-fc" title="MGR01 · Manager / GP Firm (Issuer) — on 22 of 22 commitments">MGR01</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Issuer Concentration (% limit)">×</button></div></td>
                </tr>
                <tr>
                  <td><span class="da-st breach">Breach</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>Percent of Total Fund Size (% limit)</b></div></td>
                  <td><button class="btn btn-sm x-sev" data-editable="true" title="Switch between hard and soft limit">Hard</button></td>
                  <td><span class="x-req">&lt; <input class="x-in" value="10%" data-editable="true" aria-label="Percent of Total Fund Size (% limit) limit"></span></td>
                  <td class="num x-nw"><b>12.3%</b></td><td class="num x-nw">$59.5M / $485M</td><td class="num neg">-2.3%</td>
                  <td class="x-nw">Saltmarsh Growth Partners VII</td>
                  <td><div class="x-chips"><span class="x-fc" title="ECO01 · Commitment Amount (Local) — on 22 of 22 commitments">ECO01</span><span class="x-fc" title="ECO08 · Underlying Fund Size — on 22 of 22 commitments">ECO08</span><span class="x-fc" title="ECO09 · Ownership % of Underlying Fund — on 22 of 22 commitments">ECO09</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Percent of Total Fund Size (% limit)">×</button></div></td>
                </tr>
                <tr>
                  <td><span class="da-st x-st soft">Soft breach</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>Remaining Allocation</b></div></td>
                  <td><button class="btn btn-sm x-sev soft" data-editable="true" title="Switch between hard and soft limit">Soft</button></td>
                  <td><span class="x-req">&lt; <input class="x-in" value="100%" data-editable="true" aria-label="Remaining Allocation limit"></span></td>
                  <td class="num x-nw"><b>116.5%</b></td><td class="num x-nw">$158M / $135.6M</td><td class="num neg">-16.5%</td>
                  <td class="x-nw">2022 Allocation</td>
                  <td><div class="x-chips"><span class="x-fc" title="ECO01 · Commitment Amount (Local) — on 22 of 22 commitments">ECO01</span><span class="x-fc" title="ECO03 · Commitment Amount (Mandate Base Currency) — on 22 of 22 commitments">ECO03</span><span class="x-fc" title="IDN03 · Tranche / Allocation Bucket — on 22 of 22 commitments">IDN03</span><span class="x-fc ctx" title="MND02 · Tranche / Annual Allocation Amount — mandate setting">MND02</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Remaining Allocation">×</button></div></td>
                </tr>

                <tr class="x-grp"><td colspan="9">Whole investment – count of investments<small>1 rule</small></td></tr>
                <tr>
                  <td><span class="da-st ok">Pass</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>Number of Primary Investments</b></div></td>
                  <td><button class="btn btn-sm x-sev" data-editable="true" title="Switch between hard and soft limit">Hard</button></td>
                  <td><span class="x-req">&gt; <input class="x-in" value="18" data-editable="true" aria-label="Number of Primary Investments min"> , &lt; <input class="x-in" value="30" data-editable="true" aria-label="Number of Primary Investments max"></span></td>
                  <td class="num x-nw"><b>19 investments</b></td><td class="num"></td><td class="num"></td>
                  <td class="x-nw">19 commitments</td>
                  <td><div class="x-chips"><span class="x-fc" title="IDN04 · Investment Type — on 22 of 22 commitments">IDN04</span><span class="x-fc" title="IDN05 · Underlying Asset (Fund / Company) — on 22 of 22 commitments">IDN05</span><span class="x-fc" title="ECO04 · Commitment / Closing Date — on 22 of 22 commitments">ECO04</span><span class="x-fc ctx" title="MND03 · Commitment Period &amp; Investment-Year Windows — mandate setting">MND03</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Number of Primary Investments">×</button></div></td>
                </tr>

                <tr class="x-grp"><td colspan="9">Bucket aggregation – share of mandate by attribute<small>5 rules</small></td></tr>
                <tr>
                  <td><span class="da-st ok">Pass</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>Non-US Investments (% limit)</b></div></td>
                  <td><button class="btn btn-sm x-sev" data-editable="true" title="Switch between hard and soft limit">Hard</button></td>
                  <td><span class="x-req">&lt; <input class="x-in" value="40%" data-editable="true" aria-label="Non-US Investments (% limit) limit"></span></td>
                  <td class="num x-nw"><b>16.6%</b></td><td class="num x-nw">$199M / <span data-attr="MND01">$1.2B</span></td><td class="num">23.4%</td>
                  <td class="x-nw">5 commitments</td>
                  <td><div class="x-chips"><span class="x-fc" title="ECO01 · Commitment Amount (Local) — on 22 of 22 commitments">ECO01</span><span class="x-fc" title="ECO03 · Commitment Amount (Mandate Base Currency) — on 22 of 22 commitments">ECO03</span><span class="x-fc ctx" title="MND01 · Mandate Total Commitment / Program Size — mandate setting">MND01</span><span class="x-fc" title="GEO01 · Geographic Focus Region — on 22 of 22 commitments">GEO01</span><span class="x-fc" title="GEO02 · Market Classification — on 22 of 22 commitments">GEO02</span><span class="x-fc ctx" title="MND03 · Commitment Period &amp; Investment-Year Windows — mandate setting">MND03</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Non-US Investments (% limit)">×</button></div></td>
                </tr>
                <tr>
                  <td><span class="da-st ok">Pass</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>Emerging Markets</b></div></td>
                  <td><button class="btn btn-sm x-sev" data-editable="true" title="Switch between hard and soft limit">Hard</button></td>
                  <td><span class="x-req">&lt; <input class="x-in" value="10%" data-editable="true" aria-label="Emerging Markets limit"></span></td>
                  <td class="num x-nw"><b>3.5%</b></td><td class="num x-nw">$42.5M / <span data-attr="MND01">$1.2B</span></td><td class="num">6.5%</td>
                  <td class="x-nw">1 commitments</td>
                  <td><div class="x-chips"><span class="x-fc" title="ECO01 · Commitment Amount (Local) — on 22 of 22 commitments">ECO01</span><span class="x-fc" title="ECO03 · Commitment Amount (Mandate Base Currency) — on 22 of 22 commitments">ECO03</span><span class="x-fc ctx" title="MND01 · Mandate Total Commitment / Program Size — mandate setting">MND01</span><span class="x-fc" title="GEO02 · Market Classification — on 22 of 22 commitments">GEO02</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Emerging Markets">×</button></div></td>
                </tr>
                <tr>
                  <td><span class="da-st ok">Pass</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>Secondary Investments (% limit)</b></div></td>
                  <td><button class="btn btn-sm x-sev soft" data-editable="true" title="Switch between hard and soft limit">Soft</button></td>
                  <td><span class="x-req">&lt; <input class="x-in" value="30%" data-editable="true" aria-label="Secondary Investments (% limit) limit"></span></td>
                  <td class="num x-nw"><b>4.8%</b></td><td class="num x-nw">$57.5M / <span data-attr="MND01">$1.2B</span></td><td class="num">25.2%</td>
                  <td class="x-nw">2 commitments</td>
                  <td><div class="x-chips"><span class="x-fc" title="ECO01 · Commitment Amount (Local) — on 22 of 22 commitments">ECO01</span><span class="x-fc" title="ECO03 · Commitment Amount (Mandate Base Currency) — on 22 of 22 commitments">ECO03</span><span class="x-fc ctx" title="MND01 · Mandate Total Commitment / Program Size — mandate setting">MND01</span><span class="x-fc" title="IDN04 · Investment Type — on 22 of 22 commitments">IDN04</span><span class="x-fc" title="STR02 · Strategy — on 22 of 22 commitments">STR02</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Secondary Investments (% limit)">×</button></div></td>
                </tr>
                <tr>
                  <td><span class="da-st ok">Pass</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>Venture Capital Investments (% limit)</b></div></td>
                  <td><button class="btn btn-sm x-sev" data-editable="true" title="Switch between hard and soft limit">Hard</button></td>
                  <td><span class="x-req">&lt; <input class="x-in" value="20%" data-editable="true" aria-label="Venture Capital Investments (% limit) limit"></span></td>
                  <td class="num x-nw"><b>9.7%</b></td><td class="num x-nw">$116.9M / <span data-attr="MND01">$1.2B</span></td><td class="num">10.3%</td>
                  <td class="x-nw">3 commitments</td>
                  <td><div class="x-chips"><span class="x-fc" title="ECO01 · Commitment Amount (Local) — on 22 of 22 commitments">ECO01</span><span class="x-fc" title="ECO03 · Commitment Amount (Mandate Base Currency) — on 22 of 22 commitments">ECO03</span><span class="x-fc ctx" title="MND01 · Mandate Total Commitment / Program Size — mandate setting">MND01</span><span class="x-fc" title="STR02 · Strategy — on 22 of 22 commitments">STR02</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Venture Capital Investments (% limit)">×</button></div></td>
                </tr>
                <tr>
                  <td><span class="da-st x-st soft">Soft breach</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>Exposures per Strategy</b></div></td>
                  <td><button class="btn btn-sm x-sev soft" data-editable="true" title="Switch between hard and soft limit">Soft</button></td>
                  <td><span class="x-req muted">Within bands <button class="x-link" data-editable="true">edit</button></span></td>
                  <td class="num x-nw"><b>3 of 8 bands breached</b></td><td class="num"></td><td class="num"></td>
                  <td class="x-nw">Primary › Private Equity › Buyout · #</td>
                  <td><div class="x-chips"><span class="x-fc" title="ECO01 · Commitment Amount (Local) — on 22 of 22 commitments">ECO01</span><span class="x-fc" title="ECO03 · Commitment Amount (Mandate Base Currency) — on 22 of 22 commitments">ECO03</span><span class="x-fc ctx" title="MND01 · Mandate Total Commitment / Program Size — mandate setting">MND01</span><span class="x-fc" title="STR01 · Asset Class — on 22 of 22 commitments">STR01</span><span class="x-fc" title="STR02 · Strategy — on 22 of 22 commitments">STR02</span><span class="x-fc" title="IDN04 · Investment Type — on 22 of 22 commitments">IDN04</span><span class="x-fc ctx" title="MND06 · Target Allocation Matrices — mandate setting">MND06</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Exposures per Strategy">×</button></div></td>
                </tr>

                <tr class="x-grp"><td colspan="9">Eligibility screen – investment attribute<small>1 rule</small></td></tr>
                <tr>
                  <td><span class="da-st ok">Pass</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><span><b>Cannot invest in publicly traded securities</b><small class="fs-warn" title="IDN12 Temporary Investment Flag · IDN13 Received as In-Kind Distribution · ECO05 NAV / Market Value">3 fields not captured</small></span></div></td>
                  <td><button class="btn btn-sm x-sev" data-editable="true" title="Switch between hard and soft limit">Hard</button></td>
                  <td><span class="x-req muted">Pass / Fail</span></td>
                  <td class="num x-nw"><b>None found</b></td><td class="num"></td><td class="num"></td>
                  <td></td>
                  <td><div class="x-chips"><span class="x-fc" title="IDN11 · Publicly Traded / Listed Flag — on 22 of 22 commitments">IDN11</span><span class="x-fc gap" title="IDN12 · Temporary Investment Flag — not in the security master yet">IDN12</span><span class="x-fc gap" title="IDN13 · Received as In-Kind Distribution — not in the security master yet">IDN13</span><span class="x-fc gap" title="ECO05 · NAV / Market Value — not in the security master yet">ECO05</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Cannot invest in publicly traded securities">×</button></div></td>
                </tr>

                <tr class="x-grp"><td colspan="9">Questionnaire / attestation<small>2 rules</small></td></tr>
                <tr>
                  <td><span class="da-st x-st pend">Pending</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>No Contractual Restrictions</b></div></td>
                  <td><button class="btn btn-sm x-sev" data-editable="true" title="Switch between hard and soft limit">Hard</button></td>
                  <td><span class="x-req muted">Attestation</span></td>
                  <td class="num x-nw"><b>21 of 22 cleared</b></td><td class="num"></td><td class="num"></td>
                  <td class="x-nw">1 pending</td>
                  <td><div class="x-chips"><span class="x-fc" title="TRM10 · Contractual Restrictions Identified — on 22 of 22 commitments">TRM10</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove No Contractual Restrictions">×</button></div></td>
                </tr>
                <tr>
                  <td><span class="da-st x-st pend">Pending</span></td>
                  <td class="x-nw"><div class="da-name"><button class="da-caret" aria-expanded="false">▸</button><b>Manual Rule 2 - Investment Strategy</b></div></td>
                  <td><button class="btn btn-sm x-sev" data-editable="true" title="Switch between hard and soft limit">Hard</button></td>
                  <td><span class="x-req muted">Attestation</span></td>
                  <td class="num x-nw"><b>21 of 22 cleared</b></td><td class="num"></td><td class="num"></td>
                  <td class="x-nw">1 pending</td>
                  <td><div class="x-chips"><span class="x-fc" title="QST00 · Questionnaire Response Structure — on 22 of 22 commitments">QST00</span><span class="x-fc" title="QST02 · Investment Strategy Questionnaire (Manual Rule 2.x) — on 22 of 22 commitments">QST02</span><span class="x-fc" title="STR01 · Asset Class — on 22 of 22 commitments">STR01</span><span class="x-fc" title="STR02 · Strategy — on 22 of 22 commitments">STR02</span><span class="x-fc" title="STR03 · Sub-Strategy / Size Segment — on 18 of 22 commitments">STR03</span><span class="x-fc" title="IDN04 · Investment Type — on 22 of 22 commitments">IDN04</span><button class="x-del" title="Remove this rule from the mandate" aria-label="Remove Manual Rule 2 - Investment Strategy">×</button></div></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="da-sec">
        <details class="x-side" aria-label="Assigned targets">
          <summary>Assigned targets</summary>
          <div class="fs-panel" data-attr="MND06" data-editable="true">
            <div class="x-tgt">
              <div>
                <button class="x-gh" title="Open the Strategy targets"><span>Strategy</span><small class="da-note">9 targets</small></button>
                <p class="da-note">Category › Asset Class › Strategy › Sub-Strategy</p>
                <button class="x-srow d1" title="Primary"><b><i class="x-dot in" title="In range · under target"></i>Primary</b><span><em>$900M</em> ≈75% <em>22#</em></span><span class="rg">range $800M–$1B · 18–26#</span></button>
                <button class="x-srow d2" title="Primary › Private Equity"><b><i class="x-dot under" title="93% of target"></i>Private Equity</b><span>≈$900M <em>100%</em></span></button>
                <button class="x-srow d3" title="Primary › Private Equity › Buyout"><b><i class="x-dot above" title="Above max"></i>Buyout</b><span>≈$540M <em>60%</em> <em>9#</em></span><span class="rg">range 7–11# · 50%–70%</span></button>
                <button class="x-srow d4" title="Primary › Private Equity › Buyout › Small Cap"><b><i class="x-dot under" title="71% of target"></i>Small Cap</b><span>≈$135M <em>25%</em></span></button>
                <button class="x-srow d4" title="Primary › Private Equity › Buyout › Mid Cap"><b><i class="x-dot above" title="Above max"></i>Mid Cap</b><span>≈$243M <em>45%</em></span><span class="rg">range 35%–55%</span></button>
                <button class="x-srow d4" title="Primary › Private Equity › Buyout › Large Cap"><b><i class="x-dot under" title="91% of target"></i>Large Cap</b><span>≈$108M <em>20%</em></span></button>
                <button class="x-srow d3" title="Primary › Private Equity › Growth Equity"><b><i class="x-dot under" title="67% of target"></i>Growth Equity</b><span>≈$135M <em>15%</em> <em>3#</em></span><span class="rg">range 10%–20%</span></button>
                <button class="x-srow d3" title="Primary › Private Equity › Venture Capital"><b><i class="x-dot under" title="75% of target"></i>Venture Capital</b><span>≈$180M <em>20%</em> <em>4#</em></span><span class="rg">range 10%–25%</span></button>
                <button class="x-srow d1" title="Secondary"><b><i class="x-dot below" title="Below min"></i>Secondary</b><span><em>$300M</em> ≈25% <em>8#</em></span><span class="rg">range $200M–…</span></button>
              </div>
              <div>
                <button class="x-gh" title="Open the Region targets"><span>Region</span><small class="da-note">3 targets</small></button>
                <p class="da-note">Region › Asset Class</p>
                <button class="x-srow d1" title="North America"><b><i class="x-dot above" title="Above max"></i>North America</b><span>≈$840M <em>70%</em></span><span class="rg">range 60%–80%</span></button>
                <button class="x-srow d1" title="Western Europe"><b><i class="x-dot under" title="26% of target"></i>Western Europe</b><span>≈$300M <em>25%</em></span></button>
                <button class="x-srow d1" title="APAC/ROW"><b><i class="x-dot in" title="In range · under target"></i>APAC/ROW</b><span>≈$120M <em>10%</em></span><span class="rg">range …–15%</span></button>
              </div>
              <div>
                <button class="x-gh" title="Open the Structure targets"><span>Structure</span><small class="da-note">5 targets</small></button>
                <p class="da-note">Category › Structure Type › Detail</p>
                <button class="x-srow ctx d1" title="Primary"><b>Primary</b><span class="da-note">no target</span></button>
                <button class="x-srow d2" title="Primary › Traditional Primary"><b><i class="x-dot over" title="Over target"></i>Traditional Primary</b><span><em>85%</em></span></button>
                <button class="x-srow d2" title="Primary › Fund-of-Funds"><b><i class="x-dot under" title="63% of target"></i>Fund-of-Funds</b><span><em>5%</em></span></button>
                <button class="x-srow ctx d1" title="Secondary"><b>Secondary</b><span class="da-note">no target</span></button>
                <button class="x-srow d2" title="Secondary › GP Led"><b><i class="x-dot under" title="48% of target"></i>GP Led</b><span><em>$120M</em></span></button>
                <button class="x-srow d3" title="Secondary › GP Led › Single Asset"><b><i class="x-dot under" title="72% of target"></i>Single Asset</b><span><em>$80M</em> ≈66.7%</span></button>
                <button class="x-srow d3" title="Secondary › GP Led › Multi Asset"><b><i class="x-dot under" title="0% of target"></i>Multi Asset</b><span><em>$60M</em> ≈50%</span></button>
              </div>
            </div>
            <div class="x-legend">
              <div><span class="da-st ok">$ 100%</span> next level adds up</div>
              <div><span class="da-st x-st pend">$ 85%</span> next level is under</div>
              <div><span class="da-st near">$ 105%</span> next level is over</div>
              <div>Dots show the worst band status on the row: <i class="x-dot in"></i>in range <i class="x-dot below"></i>below min <i class="x-dot above"></i>above max <i class="x-dot under"></i>building to target.</div>
              <div>Values with ≈ are implied from the other measure. Muted rows have no target of their own but hold targets below.</div>
            </div>
          </div>
        </details>
      </section>
    </main>
  </div>
</div>
```

### Commitments (house design)

Commitments, redesigned in the house kit from the captured view and checked against it.

```html
<style>
.x-shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); gap: 14px; align-items: start; }
.x-rail { position: sticky; top: 8px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 6px 0 8px; }
.x-rail h2 { font-size: 11px; font-weight: 600; color: var(--ink-3); padding: 4px 12px 6px; }
.x-ent { display: block; width: 100%; text-align: left; font: inherit; color: inherit; background: none; border: 0; border-top: 1px solid var(--line); border-left: 3px solid transparent; padding: 7px 12px 7px 9px; cursor: pointer; }
.x-ent.m { padding-left: 21px; }
.x-ent[aria-current="true"] { background: var(--accent-light); border-left-color: var(--accent-2); }
.x-top, .x-sub { display: flex; align-items: center; gap: 6px; }
.x-nm { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.x-sub { margin-top: 3px; font-size: 11.5px; color: var(--ink-3); }
.x-sub .da-track { margin: 0 0 0 auto; }
.x-sub .da-track i { width: 14px; }
.x-add { width: calc(100% - 24px); margin: 8px 12px 0; justify-content: center; }
.da-ribbon .x-ribtitle { flex: 1 0 100%; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 10px 16px; padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--line); }
.x-ribtitle h1 { margin: 2px 0 0; }
.x-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-3); }
.x-facts7 { grid-template-columns: repeat(7, minmax(118px, 1fr)); }
.x-facts7 .da-fact { border-bottom: 0; padding: 10px 14px; }
.x-facts7 .da-fact:last-child { border-right: 0; }
.x-facts7 .fs-track { height: 8px; margin: 5px 0 3px; }
.x-tabs button { flex: none; white-space: nowrap; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; text-align: left; }
.x-tabs button small { font-size: 11px; font-weight: 400; color: var(--ink-3); }
.x-tabs .cr-n, .x-tabs .da-st { margin-left: 6px; }
.x-tabsep { flex: none; width: 1px; margin: 8px 6px; background: var(--line); }
.x-sel { font: inherit; font-size: 13px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: inherit; }
.x-hint { margin-left: auto; font-size: 12px; color: var(--ink-3); }
.da-grid.x-hgrid { min-width: 0; }
.da-grid.x-hgrid th, .da-grid.x-hgrid td { white-space: nowrap; padding: 6px 8px; }
.x-hgrid tr.x-gh td { background: var(--bg-alt); font-weight: 600; }
.da-grid tr.x-gh small { display: inline; margin-left: 10px; }
.x-tag { font: inherit; font-size: 12px; padding: 1px 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--ink-2); cursor: pointer; }
.x-tag.na { border-style: dashed; background: none; color: var(--ink-4); cursor: default; }
.x-flag { font-family: inherit; border: 1px solid transparent; cursor: pointer; }
.x-flag.x-soft { background: var(--surface); border-color: var(--red); color: var(--red); }
.x-targets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: start; margin-top: 10px; }
.x-grp { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; }
.x-grphead { display: flex; justify-content: space-between; align-items: baseline; width: 100%; padding: 0; border: 0; background: none; font: inherit; font-weight: 600; color: var(--ink); cursor: pointer; }
.x-grphead small, .x-path { font-size: 11px; font-weight: 400; color: var(--ink-3); }
.x-path { margin: 2px 0 4px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
.x-srow { display: block; width: 100%; padding: 5px 0; border: 0; border-bottom: 1px solid var(--line); background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.x-srow:last-child { border-bottom: 0; }
.x-l { display: flex; justify-content: space-between; gap: 8px; }
.x-l b { font-weight: 600; }
.x-v { font-size: 12px; color: var(--ink-3); white-space: nowrap; text-align: right; }
.x-v em { font-style: normal; font-weight: 600; color: var(--ink); }
.x-rg { display: block; font-size: 11px; color: var(--ink-4); }
.x-srow.ctx b { font-weight: 500; color: var(--ink-3); }
.x-d2 { padding-left: 12px; } .x-d3 { padding-left: 24px; } .x-d4 { padding-left: 36px; }
.x-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; border: 1px solid transparent; }
.x-dot.in { background: var(--green); } .x-dot.under { background: var(--accent-2); } .x-dot.over { background: var(--amber); }
.x-dot.above { background: var(--red); } .x-dot.below { background: var(--surface); border-color: var(--red); }
.x-leg { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); font-size: 11.5px; color: var(--ink-3); }
@media (max-width: 1000px) { .x-targets { grid-template-columns: 1fr; } .x-shell { grid-template-columns: 1fr; } .x-rail { position: static; } }
</style>

<div class="da">

  <header class="page-header">
    <div class="page-title-block">
      <b>Target Manager</b><span class="page-meta">· Fund-of-Funds &amp; Directs</span>
      <div class="cr-seg" role="group" aria-label="View">
        <button class="on" aria-pressed="true">Assign targets</button>
        <button aria-pressed="false">Overview</button>
        <button aria-pressed="false">Pipeline</button>
      </div>
    </div>
    <div class="page-actions">
      <button class="btn btn-sm" title="Undo last change (Ctrl+Z)" disabled>Undo</button>
      <button class="btn btn-sm" title="Copy all targets as CSV">Copy CSV</button>
      <button class="btn btn-sm" title="Restore the example clients and targets">Reset example</button>
    </div>
  </header>

  <div class="x-shell">

    <nav class="x-rail" aria-label="Clients and mandates">
      <h2>Clients &amp; mandates</h2>
      <button class="x-ent" data-ent="ctr" aria-current="false">
        <span class="x-top"><span class="x-nm">Commonwealth Teachers’ Retirement</span><i class="cr-n">14</i><span class="da-st breach" title="5 compliance breaches">5</span></span>
        <span class="x-sub">$2B · 70 inv <span class="da-st ok" title="2026 pacing velocity">1.04x</span><span class="da-track" title="Strategy: 6 · Region: 4 · Structure: 4"><i class="on"></i><i class="on"></i><i class="on"></i></span></span>
      </button>
      <button class="x-ent m" data-ent="ctr-pe" aria-current="true">
        <span class="x-top"><span class="x-nm">PE Primary Sleeve</span><i class="cr-n">17</i><span class="da-st breach" title="3 compliance breaches">3</span></span>
        <span class="x-sub">$1.2B · 30 inv <span class="da-st ok" title="2026 pacing velocity">1.06x</span><span class="da-track" title="Strategy: 9 · Region: 3 · Structure: 5"><i class="on"></i><i class="on"></i><i class="on"></i></span></span>
      </button>
      <button class="x-ent m" data-ent="ctr-cra" aria-current="false">
        <span class="x-top"><span class="x-nm">Credit &amp; Real Assets Sleeve</span><i class="cr-n">9</i></span>
        <span class="x-sub">$450M · 14 inv <span class="da-st breach" title="2026 pacing velocity">0.77x</span><span class="da-track" title="Strategy: 7 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span>
      </button>
      <button class="x-ent m" data-ent="ctr-co" aria-current="false">
        <span class="x-top"><span class="x-nm">Co-Investment Sleeve</span><i class="cr-n">7</i><span class="da-st breach" title="2 compliance breaches">2</span></span>
        <span class="x-sub">$400M · 24 inv <span class="da-st ok" title="2026 pacing velocity">1.14x</span><span class="da-track" title="Strategy: 4 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span>
      </button>
      <button class="x-ent" data-ent="hfo" aria-current="false">
        <span class="x-top"><span class="x-nm">Halvorsen Family Office</span><i class="cr-n">3</i><span class="da-st breach" title="1 compliance breach">1</span></span>
        <span class="x-sub">$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="da-track" title="Strategy: 0 · Region: 3 · Structure: 0"><i></i><i class="on"></i><i></i></span></span>
      </button>
      <button class="x-ent m" data-ent="hfo-div" aria-current="false">
        <span class="x-top"><span class="x-nm">Diversified Sleeve</span><i class="cr-n">4</i><span class="da-st breach" title="1 compliance breach">1</span></span>
        <span class="x-sub">$450M · 40 inv <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="da-track" title="Strategy: 4 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span>
      </button>
      <button class="x-ent" data-ent="nmi" aria-current="false">
        <span class="x-top"><span class="x-nm">Northgate Mutual Insurance</span><i class="cr-n">2</i><span class="da-st breach" title="3 compliance breaches">3</span></span>
        <span class="x-sub">$900M · 40 inv <span class="da-st ok" title="2026 pacing velocity">1.11x</span><span class="da-track" title="Strategy: 2 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span>
      </button>
      <button class="x-ent m" data-ent="nmi-pc" aria-current="false">
        <span class="x-top"><span class="x-nm">Private Credit Sleeve</span><i class="cr-n">10</i><span class="da-st breach" title="3 compliance breaches">3</span></span>
        <span class="x-sub">$600M · 28 inv <span class="da-chip" title="2026 pacing velocity">1.16x</span><span class="da-track" title="Strategy: 8 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span>
      </button>
      <button class="x-ent m" data-ent="nmi-sec" aria-current="false">
        <span class="x-top"><span class="x-nm">Secondaries Sleeve</span><i class="cr-n">6</i></span>
        <span class="x-sub">$200M · 10 inv <span class="da-st breach" title="2026 pacing velocity">0.85x</span><span class="da-track" title="Strategy: 3 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span>
      </button>
      <button class="btn btn-sm x-add">+ Add mandate sleeve</button>
    </nav>

    <main>
      <div class="crumbs"><a class="crumb-link" href="#">Commonwealth Teachers’ Retirement</a><span class="sep">›</span><span class="crumb-current">Mandate sleeve</span></div>

      <header class="da-ribbon cr-facts" role="group" aria-label="Deployment and pacing">
        <div class="da-title x-ribtitle">
          <div>
            <span class="da-chip">Mandate sleeve</span>
            <h1>PE Primary Sleeve</h1>
          </div>
          <div class="x-acts">
            <span>% basis</span>
            <div class="cr-seg" role="group" aria-label="Percent basis" data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">
              <button aria-pressed="false" title="Percent targets are a share of the total program">Program</button>
              <button class="on" aria-pressed="true" title="Percent targets are a share of the level above">Parent level</button>
            </div>
            <button class="btn btn-sm">Copy targets from…</button>
          </div>
        </div>
        <div class="da-facts x-facts7">
          <div class="da-fact"><span>Program</span><strong data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$1.2B</strong><small>74% committed · since <span data-attr="INCEPTION_DATE">Apr 2022</span></small></div>
          <div class="da-fact"><span>Investments</span><strong>22 <small>/ <span data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">30</span></small></strong><small>made vs target</small></div>
          <div class="da-fact"><span>2026 deployment vs target</span><strong>$167M <small>/ <span data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$180M</span></small></strong>
            <div class="fs-track" title="Bar: deployed against the 2026 target. Marker: where pacing says you should be by 17 Nov 2026"><i style="width:93%"></i><b style="left:87.7%"></b></div>
            <small>93% of annual · $157.8M expected to date</small></div>
          <div class="da-fact"><span>Pacing velocity</span><strong class="up">1.06x <span class="da-st ok">On pace</span></strong><small>YTD vs time-weighted target</small></div>
          <div class="da-fact"><span>Since inception</span><strong class="up" title="On pace">1.07x</strong><small>$893.9M vs $833.4M</small></div>
          <div class="da-fact"><span>Compliance</span><strong class="dn"><a href="#compliance" data-tab="compliance" title="Open the compliance tab">3 breaches</a></strong><small>13 rules · 1 watch · 2 pending · 2 soft</small></div>
          <div class="da-fact"><span>Run-rate (LTM)</span><strong>$193.5M<small>/yr</small></strong><small>$306.1M left · ≈1.6 yrs at this pace</small></div>
        </div>
      </header>

      <div class="da-tabs x-tabs" role="tablist">
        <button role="tab" aria-selected="false" data-tab="strategy"><span>Strategy<i class="cr-n">9</i></span><small>Category › Asset Class › Strategy › Sub-Strategy</small></button>
        <button role="tab" aria-selected="false" data-tab="region"><span>Region<i class="cr-n">3</i></span><small>Region › Asset Class</small></button>
        <button role="tab" aria-selected="false" data-tab="structure"><span>Structure<i class="cr-n">5</i></span><small>Category › Structure Type › Detail</small></button>
        <span class="x-tabsep" aria-hidden="true"></span>
        <button role="tab" aria-selected="false" data-tab="pacing"><span>Pacing</span><small>Annual deployment by year</small></button>
        <button class="on" role="tab" aria-selected="true" data-tab="holdings"><span>Commitments<i class="cr-n">22</i></span><small>Original commitments and attributes</small></button>
        <button role="tab" aria-selected="false" data-tab="compliance"><span>Compliance<span class="da-st breach">3 breaches</span></span><small>Rules, limits and results</small></button>
      </div>

      <section class="da-sec">
        <div class="da-toolbar">
          <input class="pipe-search" type="search" placeholder="Search name or any attribute" aria-label="Search commitments">
          <div class="cr-seg" role="group" aria-label="Columns">
            <button class="on" aria-pressed="true">Target tags</button>
            <button aria-pressed="false">Security master</button>
          </div>
          <label for="hYear">Year</label>
          <select class="x-sel" id="hYear"><option value="all" selected>All years</option><option>2026</option><option>2025</option><option>2024</option><option>2023</option><option>2022</option></select>
          <label for="hGroup">Group by</label>
          <select class="x-sel" id="hGroup">
            <option value="none">No grouping</option><option value="year" selected>Investment year</option><option value="category">Category</option><option value="assetClass">Asset Class</option><option value="strategy">Strategy</option><option value="subStrategy">Sub-Strategy</option><option value="region">Region</option><option value="structureType">Structure Type</option><option value="structureDetail">Structure Detail</option><option value="investmentType">Investment Type</option><option value="manager">Manager / GP Firm</option><option value="market">Market Classification</option><option value="country">Single-Country Focus</option><option value="sector">Primary Industry Sector</option><option value="currency">Commitment Currency</option><option value="relationship">HL Relationship</option>
          </select>
          <button class="btn btn-sm">Copy commitments CSV</button>
          <span class="x-hint">22 original commitments · $893.9M committed · select a tag to open that target level</span>
        </div>

        <div class="da-main solo">
          <div class="da-gridwrap">
            <table class="da-grid x-hgrid">
              <thead><tr>
                <th aria-sort="none">Commitment</th><th class="num" aria-sort="descending">Commit date ↓</th><th class="num" aria-sort="none">Commitment</th><th aria-sort="none">Category</th><th aria-sort="none">Asset Class</th><th aria-sort="none">Strategy</th><th aria-sort="none">Sub-Strategy</th><th aria-sort="none">Region</th><th aria-sort="none">Structure Type</th><th aria-sort="none">Detail</th><th aria-sort="none" title="Rules on the mandate that flag this commitment">Compliance</th>
              </tr></thead>
              <tbody>
                <tr class="x-gh"><td colspan="11">Investment year: 2026<small>4 commitments · $167M · 19% of shown · target $180M (93%)</small></td></tr>
                <tr data-hid="h20" tabindex="0"><td><b>Harborview Capital Partners IX</b></td><td class="num">2026-11-03</td><td class="num">$37M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap">Mid Cap</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st near x-flag" data-tab="compliance" title="Watch: Remaining Allocation&#10;Pending: No Contractual Restrictions&#10;Pending: Manual Rule 2 - Investment Strategy">3 flags</button></td></tr>
                <tr data-hid="h19" tabindex="0"><td><b>Bluewater Capital Partners VII</b></td><td class="num">2026-07-30</td><td class="num">$53.5M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Large Cap">Large Cap</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st near x-flag" data-tab="compliance" title="Watch: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h21" tabindex="0"><td><b>Copperline Ventures VIII</b></td><td class="num">2026-04-10</td><td class="num">$32M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Venture Capital">Venture Capital</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Venture Capital › Seed / Early Stage">Seed / Early Stage</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st near x-flag" data-tab="compliance" title="Watch: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h22" tabindex="0"><td><b>Fairhaven Capital Partners II</b></td><td class="num">2026-01-29</td><td class="num">$44.5M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Large Cap">Large Cap</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st near x-flag" data-tab="compliance" title="Watch: Remaining Allocation">1 flag</button></td></tr>

                <tr class="x-gh"><td colspan="11">Investment year: 2025<small>5 commitments · $204.9M · 23% of shown · target $180M (114%)</small></td></tr>
                <tr data-hid="h14" tabindex="0"><td><b>Brightpine Capital Partners IV</b></td><td class="num">2025-11-30</td><td class="num">$26.5M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap">Mid Cap</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Fund-of-Funds">Fund-of-Funds</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h17" tabindex="0"><td><b>Saltmarsh Growth Partners VII</b></td><td class="num">2025-10-14</td><td class="num">$59.5M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Growth Equity">Growth Equity</button></td><td><span class="x-tag na">n/a</span></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st breach x-flag" data-tab="compliance" title="Watch: Asset Concentration (% limit)&#10;Breach: Percent of Total Fund Size (% limit)&#10;Soft breach: Remaining Allocation">3 flags</button></td></tr>
                <tr data-hid="h18" tabindex="0"><td><b>Alder Creek Ventures IV</b></td><td class="num">2025-07-19</td><td class="num">$38.9M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Venture Capital">Venture Capital</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Venture Capital › Late Stage">Late Stage</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h15" tabindex="0"><td><b>Quarry Lane Capital Partners II</b></td><td class="num">2025-05-20</td><td class="num">$55M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap">Mid Cap</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st breach x-flag" data-tab="compliance" title="Watch: Asset Concentration (% limit)&#10;Breach: Percent of Total Fund Size (% limit)&#10;Soft breach: Remaining Allocation">3 flags</button></td></tr>
                <tr data-hid="h16" tabindex="0"><td><b>Ridgeline Continuation Vehicle V</b></td><td class="num">2025-03-05</td><td class="num">$25M</td><td><button class="x-tag" data-jump="strategy|Secondary">Secondary</button></td><td><button class="x-tag" data-jump="strategy|Secondary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Secondary › Private Equity › Buyout">Buyout</button></td><td><span class="x-tag na">n/a</span></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Secondary › GP Led">GP Led</button></td><td><button class="x-tag" data-jump="structure|Secondary › GP Led › Single Asset">Single Asset</button></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>

                <tr class="x-gh"><td colspan="11">Investment year: 2024<small>4 commitments · $173.5M · 19% of shown · target $180M (96%)</small></td></tr>
                <tr data-hid="h10" tabindex="0"><td><b>Sterling Oak Capital Partners II</b></td><td class="num">2024-12-30</td><td class="num">$42.5M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap">Mid Cap</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st near x-flag" data-tab="compliance" title="Watch: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h12" tabindex="0"><td><b>Saltmarsh Capital Partners III</b></td><td class="num">2024-09-14</td><td class="num">$33M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap">Mid Cap</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st near x-flag" data-tab="compliance" title="Watch: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h11" tabindex="0"><td><b>Quarry Lane Capital Partners VII</b></td><td class="num">2024-06-26</td><td class="num">$53.5M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Small Cap">Small Cap</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st near x-flag" data-tab="compliance" title="Watch: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h13" tabindex="0"><td><b>Bramblewood Capital Partners VI</b></td><td class="num">2024-02-12</td><td class="num">$44.5M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap">Mid Cap</button></td><td><button class="x-tag" data-jump="region|Western Europe">Western Europe</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st near x-flag" data-tab="compliance" title="Watch: Remaining Allocation">1 flag</button></td></tr>

                <tr class="x-gh"><td colspan="11">Investment year: 2023<small>5 commitments · $190.5M · 21% of shown · target $180M (106%)</small></td></tr>
                <tr data-hid="h9" tabindex="0"><td><b>Granite Peak Capital Partners VII</b></td><td class="num">2023-12-04</td><td class="num">$25M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap">Mid Cap</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h5" tabindex="0"><td><b>Northlake Growth Partners III</b></td><td class="num">2023-10-10</td><td class="num">$45M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Growth Equity">Growth Equity</button></td><td><span class="x-tag na">n/a</span></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h6" tabindex="0"><td><b>Bramblewood Capital Partners IV</b></td><td class="num">2023-05-05</td><td class="num">$45.5M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap">Mid Cap</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h7" tabindex="0"><td><b>Tidewater Continuation Vehicle III</b></td><td class="num">2023-04-02</td><td class="num">$32.5M</td><td><button class="x-tag" data-jump="strategy|Secondary">Secondary</button></td><td><button class="x-tag" data-jump="strategy|Secondary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Secondary › Private Equity › Buyout">Buyout</button></td><td><span class="x-tag na">n/a</span></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Secondary › GP Led">GP Led</button></td><td><button class="x-tag" data-jump="structure|Secondary › GP Led › Single Asset">Single Asset</button></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h8" tabindex="0"><td><b>Tidewater Capital Partners VIII</b></td><td class="num">2023-03-31</td><td class="num">$42.5M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Small Cap">Small Cap</button></td><td><button class="x-tag" data-jump="region|APAC/ROW">APAC/ROW</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>

                <tr class="x-gh"><td colspan="11">Investment year: 2022<small>4 commitments · $158M · 18% of shown · target $135.6M (116%)</small></td></tr>
                <tr data-hid="h4" tabindex="0"><td><b>Harborview Capital Partners III</b></td><td class="num">2022-11-08</td><td class="num">$33.5M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap">Mid Cap</button></td><td><button class="x-tag" data-jump="region|Western Europe">Western Europe</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h2" tabindex="0"><td><b>Harborview Ventures II</b></td><td class="num">2022-07-23</td><td class="num">$46M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Venture Capital">Venture Capital</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Venture Capital › Seed / Early Stage">Seed / Early Stage</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h1" tabindex="0"><td><b>Kestrel Capital Partners VII</b></td><td class="num">2022-05-24</td><td class="num">$25M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap">Mid Cap</button></td><td><button class="x-tag" data-jump="region|APAC/ROW">APAC/ROW</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>
                <tr data-hid="h3" tabindex="0"><td><b>Copperline Capital Partners IV</b></td><td class="num">2022-04-06</td><td class="num">$53.5M</td><td><button class="x-tag" data-jump="strategy|Primary">Primary</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity">Private Equity</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout">Buyout</button></td><td><button class="x-tag" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap">Mid Cap</button></td><td><button class="x-tag" data-jump="region|North America">North America</button></td><td><button class="x-tag" data-jump="structure|Primary › Traditional Primary">Traditional Primary</button></td><td><span class="x-tag na">n/a</span></td><td><button class="da-st x-flag x-soft" data-tab="compliance" title="Soft breach: Remaining Allocation">1 flag</button></td></tr>
              </tbody>
              <tfoot><tr><td colspan="2">Total shown</td><td class="num"><b>$893.9M</b></td><td colspan="8">22 commitments</td></tr></tfoot>
            </table>
          </div>
        </div>
      </section>

      <section class="da-sec" aria-label="Assigned targets" data-attr="FUND_TARGET_MATRIX" data-editable="true">
        <div class="da-sechead"><h2>Assigned targets</h2></div>
        <div class="x-targets">
          <div class="x-grp">
            <button class="x-grphead" data-tab="strategy" title="Open the Strategy targets"><span>Strategy</span><small>9 targets</small></button>
            <div class="x-path">Category › Asset Class › Strategy › Sub-Strategy</div>
            <button class="x-srow" data-jump="strategy|Primary"><span class="x-l"><b><i class="x-dot in" title="In range · under target"></i>Primary</b><span class="x-v"><em>$900M</em> ≈75% <em>22#</em></span></span><span class="x-rg">range $800M–$1B · 18–26#</span></button>
            <button class="x-srow x-d2" data-jump="strategy|Primary › Private Equity"><span class="x-l"><b><i class="x-dot under" title="93% of target"></i>Private Equity</b><span class="x-v">≈$900M <em>100%</em></span></span></button>
            <button class="x-srow x-d3" data-jump="strategy|Primary › Private Equity › Buyout"><span class="x-l"><b><i class="x-dot above" title="Above max"></i>Buyout</b><span class="x-v">≈$540M <em>60%</em> <em>9#</em></span></span><span class="x-rg">range 7–11# · 50%–70%</span></button>
            <button class="x-srow x-d4" data-jump="strategy|Primary › Private Equity › Buyout › Small Cap"><span class="x-l"><b><i class="x-dot under" title="71% of target"></i>Small Cap</b><span class="x-v">≈$135M <em>25%</em></span></span></button>
            <button class="x-srow x-d4" data-jump="strategy|Primary › Private Equity › Buyout › Mid Cap"><span class="x-l"><b><i class="x-dot above" title="Above max"></i>Mid Cap</b><span class="x-v">≈$243M <em>45%</em></span></span><span class="x-rg">range 35%–55%</span></button>
            <button class="x-srow x-d4" data-jump="strategy|Primary › Private Equity › Buyout › Large Cap"><span class="x-l"><b><i class="x-dot under" title="91% of target"></i>Large Cap</b><span class="x-v">≈$108M <em>20%</em></span></span></button>
            <button class="x-srow x-d3" data-jump="strategy|Primary › Private Equity › Growth Equity"><span class="x-l"><b><i class="x-dot under" title="67% of target"></i>Growth Equity</b><span class="x-v">≈$135M <em>15%</em> <em>3#</em></span></span><span class="x-rg">range 10%–20%</span></button>
            <button class="x-srow x-d3" data-jump="strategy|Primary › Private Equity › Venture Capital"><span class="x-l"><b><i class="x-dot under" title="75% of target"></i>Venture Capital</b><span class="x-v">≈$180M <em>20%</em> <em>4#</em></span></span><span class="x-rg">range 10%–25%</span></button>
            <button class="x-srow" data-jump="strategy|Secondary"><span class="x-l"><b><i class="x-dot below" title="Below min"></i>Secondary</b><span class="x-v"><em>$300M</em> ≈25% <em>8#</em></span></span><span class="x-rg">range $200M–…</span></button>
          </div>

          <div class="x-grp">
            <button class="x-grphead" data-tab="region" title="Open the Region targets"><span>Region</span><small>3 targets</small></button>
            <div class="x-path">Region › Asset Class</div>
            <button class="x-srow" data-jump="region|North America"><span class="x-l"><b><i class="x-dot above" title="Above max"></i>North America</b><span class="x-v">≈$840M <em>70%</em></span></span><span class="x-rg">range 60%–80%</span></button>
            <button class="x-srow" data-jump="region|Western Europe"><span class="x-l"><b><i class="x-dot under" title="26% of target"></i>Western Europe</b><span class="x-v">≈$300M <em>25%</em></span></span></button>
            <button class="x-srow" data-jump="region|APAC/ROW"><span class="x-l"><b><i class="x-dot in" title="In range · under target"></i>APAC/ROW</b><span class="x-v">≈$120M <em>10%</em></span></span><span class="x-rg">range …–15%</span></button>
          </div>

          <div class="x-grp">
            <button class="x-grphead" data-tab="structure" title="Open the Structure targets"><span>Structure</span><small>5 targets</small></button>
            <div class="x-path">Category › Structure Type › Detail</div>
            <button class="x-srow ctx" data-jump="structure|Primary"><span class="x-l"><b>Primary</b><span class="x-v">no target</span></span></button>
            <button class="x-srow x-d2" data-jump="structure|Primary › Traditional Primary"><span class="x-l"><b><i class="x-dot over" title="Over target"></i>Traditional Primary</b><span class="x-v"><em>85%</em></span></span></button>
            <button class="x-srow x-d2" data-jump="structure|Primary › Fund-of-Funds"><span class="x-l"><b><i class="x-dot under" title="63% of target"></i>Fund-of-Funds</b><span class="x-v"><em>5%</em></span></span></button>
            <button class="x-srow ctx" data-jump="structure|Secondary"><span class="x-l"><b>Secondary</b><span class="x-v">no target</span></span></button>
            <button class="x-srow x-d2" data-jump="structure|Secondary › GP Led"><span class="x-l"><b><i class="x-dot under" title="48% of target"></i>GP Led</b><span class="x-v"><em>$120M</em></span></span></button>
            <button class="x-srow x-d3" data-jump="structure|Secondary › GP Led › Single Asset"><span class="x-l"><b><i class="x-dot under" title="72% of target"></i>Single Asset</b><span class="x-v"><em>$80M</em> ≈66.7%</span></span></button>
            <button class="x-srow x-d3" data-jump="structure|Secondary › GP Led › Multi Asset"><span class="x-l"><b><i class="x-dot under" title="0% of target"></i>Multi Asset</b><span class="x-v"><em>$60M</em> ≈50%</span></span></button>
          </div>

          <div class="x-leg">
            <div><span class="da-st ok">$ 100%</span> next level adds up</div>
            <div><span class="da-st near">$ 85%</span> next level is under</div>
            <div><span class="da-st breach">$ 105%</span> next level is over</div>
            <div>Dots show the worst band status on the row: <i class="x-dot in"></i>in range <i class="x-dot below"></i>below min <i class="x-dot above"></i>above max <i class="x-dot under"></i>building to target.</div>
            <div>Values with ≈ are implied from the other measure. Muted rows have no target of their own but hold targets below.</div>
          </div>
        </div>
      </section>
    </main>
  </div>
</div>
```

### Overview (house design)

Overview, redesigned in the house kit from the captured view and checked against it.

```html
<style>
.x-shell{display:grid;grid-template-columns:264px minmax(0,1fr);gap:14px;align-items:start}
.da-panel.x-rail{position:sticky;top:8px;height:auto;max-height:calc(100vh - 16px);padding:10px 8px}
.x-rail h2{margin:2px 8px 8px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3)}
.x-ent{display:flex;flex-direction:column;gap:3px;width:100%;padding:7px 8px;border:1px solid transparent;border-radius:8px;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.x-ent:hover{background:var(--bg-alt)}
.x-ent.m{padding-left:22px}
.x-ent[aria-current="true"]{border-color:var(--accent-2);background:var(--bg-alt)}
.x-er{display:flex;align-items:center;gap:6px;min-width:0}
.x-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.x-ent.m .x-nm{font-weight:500}
.x-sub{font-size:11.5px;color:var(--ink-3)}
.x-sub .da-track{margin:0 0 0 auto}
.x-sub .da-track i{width:14px}
.x-add{width:100%;justify-content:center;margin-top:8px}
.x-dis{opacity:.5;cursor:default}
.da .page-header{box-shadow:none}
.x-tree th,.x-tree td{white-space:nowrap}
.x-tree th,.x-tree td{padding:6px 10px}
.x-tree tbody tr.sub td:first-child{padding-left:28px}
.x-tree tbody tr[data-open]{cursor:pointer}
.x-pills .da-st+.da-st{margin-left:4px}
.da-st.x-soft{background:var(--surface);color:var(--amber);border:1px solid var(--amber);padding:0 7px}
.da-st.x-ahead{background:var(--badge-info-bg);color:var(--badge-info-fg)}
.x-fig.ok{color:var(--green)}.x-fig.warn{color:var(--amber)}.x-fig.bad{color:var(--red)}.x-fig.ahead{color:var(--accent-2)}
.x-cov{display:inline-flex;align-items:center;gap:6px}
.x-cov i{width:14px;height:6px;border-radius:2px;background:var(--accent-2)}
.x-cov.nil{color:var(--ink-4)}.x-cov.nil i{background:var(--line)}
.x-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:0}
.x-dot.above{background:var(--red)}.x-dot.below{background:var(--amber)}.x-dot.in{background:var(--green)}.x-dot.under{background:var(--accent-2)}
.x-dot.at{background:var(--surface);border:2px solid var(--green)}.x-dot.none{background:none;border:1px solid var(--ink-4)}
.x-mx td.num{min-width:132px}
.x-mx .imp{font-style:italic;color:var(--ink-3)}
.x-mx .nil{color:var(--ink-4)}
.x-intro .da-note{max-width:86ch;margin-top:4px}
@media (max-width:860px){.x-shell{grid-template-columns:1fr}.da-panel.x-rail{position:static;max-height:none}}
</style>
<div class="da">
  <div class="crumbs"><a class="crumb-link" href="#">Target Manager</a><span class="sep">›</span><span class="crumb-current">Overview</span></div>

  <header class="page-header">
    <div class="page-title-block">
      <div><div class="page-title">Target Manager</div><div class="page-meta">Fund-of-Funds &amp; Directs</div></div>
      <div class="cr-seg" role="group" aria-label="View">
        <button id="vEdit" aria-pressed="false">Assign targets</button>
        <button id="vOv" class="on" aria-pressed="true">Overview</button>
        <button id="vPipe" aria-pressed="false">Pipeline</button>
      </div>
    </div>
    <div class="page-actions">
      <button class="btn btn-sm x-dis" id="undoBtn" title="Undo last change (Ctrl+Z)" disabled>Undo</button>
      <button class="btn btn-sm" id="exportBtn" title="Copy all targets as CSV">Copy CSV</button>
      <button class="btn btn-sm" id="resetBtn" title="Restore the example clients and targets">Reset example</button>
    </div>
  </header>

  <div class="x-shell">
    <nav class="da-panel x-rail" id="rail" aria-label="Clients and mandates">
      <h2>Clients &amp; mandates</h2>

      <button class="x-ent c" data-ent="ctr" aria-current="false">
        <span class="x-er"><b class="x-nm" title="Commonwealth Teachers’ Retirement">Commonwealth Teachers’ Retirement</b><em class="cr-n">14</em><span class="da-st breach" title="5 compliance breaches">5</span></span>
        <span class="x-er x-sub"><span><span data-attr="FUND_TOTAL_COMMITMENTS">$2B</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">70</span> inv</span><span class="da-st ok" title="2026 pacing velocity">1.04x</span><span class="da-track" title="Strategy: 6 · Region: 4 · Structure: 4"><i class="on"></i><i class="on"></i><i class="on"></i></span></span>
      </button>
      <button class="x-ent m" data-ent="ctr-pe" aria-current="false">
        <span class="x-er"><b class="x-nm">PE Primary Sleeve</b><em class="cr-n">17</em><span class="da-st breach" title="3 compliance breaches">3</span></span>
        <span class="x-er x-sub"><span><span data-attr="FUND_TOTAL_COMMITMENTS">$1.2B</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">30</span> inv</span><span class="da-st ok" title="2026 pacing velocity">1.06x</span><span class="da-track" title="Strategy: 9 · Region: 3 · Structure: 5"><i class="on"></i><i class="on"></i><i class="on"></i></span></span>
      </button>
      <button class="x-ent m" data-ent="ctr-cra" aria-current="false">
        <span class="x-er"><b class="x-nm">Credit &amp; Real Assets Sleeve</b><em class="cr-n">9</em></span>
        <span class="x-er x-sub"><span><span data-attr="FUND_TOTAL_COMMITMENTS">$450M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">14</span> inv</span><span class="da-st breach" title="2026 pacing velocity">0.77x</span><span class="da-track" title="Strategy: 7 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span>
      </button>
      <button class="x-ent m" data-ent="ctr-co" aria-current="false">
        <span class="x-er"><b class="x-nm">Co-Investment Sleeve</b><em class="cr-n">7</em><span class="da-st breach" title="2 compliance breaches">2</span></span>
        <span class="x-er x-sub"><span><span data-attr="FUND_TOTAL_COMMITMENTS">$400M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">24</span> inv</span><span class="da-st ok" title="2026 pacing velocity">1.14x</span><span class="da-track" title="Strategy: 4 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span>
      </button>
      <button class="x-ent c" data-ent="hfo" aria-current="false">
        <span class="x-er"><b class="x-nm">Halvorsen Family Office</b><em class="cr-n">3</em><span class="da-st breach" title="1 compliance breach">1</span></span>
        <span class="x-er x-sub"><span><span data-attr="FUND_TOTAL_COMMITMENTS">$450M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">40</span> inv</span><span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="da-track" title="Strategy: 0 · Region: 3 · Structure: 0"><i></i><i class="on"></i><i></i></span></span>
      </button>
      <button class="x-ent m" data-ent="hfo-div" aria-current="false">
        <span class="x-er"><b class="x-nm">Diversified Sleeve</b><em class="cr-n">4</em><span class="da-st breach" title="1 compliance breach">1</span></span>
        <span class="x-er x-sub"><span><span data-attr="FUND_TOTAL_COMMITMENTS">$450M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">40</span> inv</span><span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="da-track" title="Strategy: 4 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span>
      </button>
      <button class="x-ent c" data-ent="nmi" aria-current="false">
        <span class="x-er"><b class="x-nm" title="Northgate Mutual Insurance">Northgate Mutual Insurance</b><em class="cr-n">2</em><span class="da-st breach" title="3 compliance breaches">3</span></span>
        <span class="x-er x-sub"><span><span data-attr="FUND_TOTAL_COMMITMENTS">$900M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">40</span> inv</span><span class="da-st ok" title="2026 pacing velocity">1.11x</span><span class="da-track" title="Strategy: 2 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span>
      </button>
      <button class="x-ent m" data-ent="nmi-pc" aria-current="false">
        <span class="x-er"><b class="x-nm">Private Credit Sleeve</b><em class="cr-n">10</em><span class="da-st breach" title="3 compliance breaches">3</span></span>
        <span class="x-er x-sub"><span><span data-attr="FUND_TOTAL_COMMITMENTS">$600M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">28</span> inv</span><span class="da-st x-ahead" title="2026 pacing velocity">1.16x</span><span class="da-track" title="Strategy: 8 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span>
      </button>
      <button class="x-ent m" data-ent="nmi-sec" aria-current="false">
        <span class="x-er"><b class="x-nm">Secondaries Sleeve</b><em class="cr-n">6</em></span>
        <span class="x-er x-sub"><span><span data-attr="FUND_TOTAL_COMMITMENTS">$200M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">10</span> inv</span><span class="da-st breach" title="2026 pacing velocity">0.85x</span><span class="da-track" title="Strategy: 3 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span>
      </button>

      <button class="btn btn-sm x-add" id="addSleeve">+ Add mandate sleeve</button>
    </nav>

    <main id="main">
      <div class="x-intro">
        <div class="pipe-head" style="margin-bottom:0">
          <h1>Target coverage across clients</h1>
        </div>
        <p class="da-note">Each client carries macro targets and a macro deployment pace; each sleeve carries its own. Velocity compares deployment so far this year with the time-weighted annual target. Select a row to open it, or a matrix cell to jump to that level.</p>
      </div>

      <section class="da-sec">
        <div class="da-sechead"><h2>Programs</h2></div>
        <div class="da-main solo">
          <div class="da-gridwrap">
            <table class="da-grid x-tree">
              <thead><tr>
                <th>Client / mandate</th><th class="num">Program</th><th class="num">Inv.</th><th>% basis</th><th>Start</th><th class="num">Annual target</th><th class="num">2026 deployed</th><th>Velocity</th><th class="num">Since inception</th><th>Compliance</th><th class="num">Strategy</th><th class="num">Region</th><th class="num">Structure</th><th class="num">Targets</th>
              </tr></thead>
              <tbody>
                <tr class="par" data-open="ctr">
                  <td><b>Commonwealth Teachers’ Retirement</b></td>
                  <td class="num" data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$2B</td>
                  <td class="num" data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">70</td>
                  <td data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">Program</td>
                  <td data-attr="INCEPTION_DATE">Jan 2022</td>
                  <td class="num" data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$340M</td>
                  <td class="num">$310.7M</td>
                  <td><span class="da-st ok">1.04x · On pace</span></td>
                  <td class="num"><span class="x-fig warn">0.89x</span></td>
                  <td class="x-pills"><span class="da-st breach">Breach 3</span><span class="da-st x-soft">Soft breach 2</span><span class="da-st near">Watch 1</span></td>
                  <td class="num"><span class="x-cov"><i></i>6</span></td><td class="num"><span class="x-cov"><i></i>4</span></td><td class="num"><span class="x-cov"><i></i>4</span></td>
                  <td class="num"><b>14</b></td>
                </tr>
                <tr class="sub" data-open="ctr-pe">
                  <td>PE Primary Sleeve</td>
                  <td class="num" data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$1.2B</td>
                  <td class="num" data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">30</td>
                  <td data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">Parent level</td>
                  <td data-attr="INCEPTION_DATE">Apr 2022</td>
                  <td class="num" data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$180M</td>
                  <td class="num">$167M</td>
                  <td><span class="da-st ok">1.06x · On pace</span></td>
                  <td class="num"><span class="x-fig ok">1.07x</span></td>
                  <td class="x-pills"><span class="da-st breach">Breach 1</span><span class="da-st x-soft">Soft breach 2</span><span class="da-st near">Watch 1</span></td>
                  <td class="num"><span class="x-cov"><i></i>9</span></td><td class="num"><span class="x-cov"><i></i>3</span></td><td class="num"><span class="x-cov"><i></i>5</span></td>
                  <td class="num">17</td>
                </tr>
                <tr class="sub" data-open="ctr-cra">
                  <td>Credit &amp; Real Assets Sleeve</td>
                  <td class="num" data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$450M</td>
                  <td class="num" data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">14</td>
                  <td data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">Program</td>
                  <td data-attr="INCEPTION_DATE">Jan 2023</td>
                  <td class="num" data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$110M</td>
                  <td class="num">$74M</td>
                  <td><span class="da-st breach">0.77x · Behind</span></td>
                  <td class="num"><span class="x-fig bad">0.71x</span></td>
                  <td class="x-pills"><span class="da-st ok">Pass 8</span></td>
                  <td class="num"><span class="x-cov"><i></i>7</span></td><td class="num"><span class="x-cov"><i></i>2</span></td><td class="num"><span class="x-cov nil"><i></i>–</span></td>
                  <td class="num">9</td>
                </tr>
                <tr class="sub" data-open="ctr-co">
                  <td>Co-Investment Sleeve</td>
                  <td class="num" data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$400M</td>
                  <td class="num" data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">24</td>
                  <td data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">Program</td>
                  <td data-attr="INCEPTION_DATE">Jul 2023</td>
                  <td class="num" data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$70M</td>
                  <td class="num">$69.7M</td>
                  <td><span class="da-st ok">1.14x · On pace</span></td>
                  <td class="num"><span class="x-fig ahead">1.18x</span></td>
                  <td class="x-pills"><span class="da-st breach">Breach 2</span></td>
                  <td class="num"><span class="x-cov"><i></i>4</span></td><td class="num"><span class="x-cov nil"><i></i>–</span></td><td class="num"><span class="x-cov"><i></i>3</span></td>
                  <td class="num">7</td>
                </tr>
                <tr class="par" data-open="hfo">
                  <td><b>Halvorsen Family Office</b></td>
                  <td class="num" data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$450M</td>
                  <td class="num" data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">40</td>
                  <td data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">Program</td>
                  <td data-attr="INCEPTION_DATE">Jan 2022</td>
                  <td class="num" data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$60M</td>
                  <td class="num">$50.5M</td>
                  <td><span class="da-st ok">0.96x · On pace</span></td>
                  <td class="num"><span class="x-fig warn">0.93x</span></td>
                  <td class="x-pills"><span class="da-st breach">Breach 1</span></td>
                  <td class="num"><span class="x-cov nil"><i></i>–</span></td><td class="num"><span class="x-cov"><i></i>3</span></td><td class="num"><span class="x-cov nil"><i></i>–</span></td>
                  <td class="num"><b>3</b></td>
                </tr>
                <tr class="sub" data-open="hfo-div">
                  <td>Diversified Sleeve</td>
                  <td class="num" data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$450M</td>
                  <td class="num" data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">40</td>
                  <td data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">Program</td>
                  <td data-attr="INCEPTION_DATE">Jan 2022</td>
                  <td class="num" data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$60M</td>
                  <td class="num">$50.5M</td>
                  <td><span class="da-st ok">0.96x · On pace</span></td>
                  <td class="num"><span class="x-fig warn">0.93x</span></td>
                  <td class="x-pills"><span class="da-st breach">Breach 1</span></td>
                  <td class="num"><span class="x-cov"><i></i>4</span></td><td class="num"><span class="x-cov nil"><i></i>–</span></td><td class="num"><span class="x-cov nil"><i></i>–</span></td>
                  <td class="num">4</td>
                </tr>
                <tr class="par" data-open="nmi">
                  <td><b>Northgate Mutual Insurance</b></td>
                  <td class="num" data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$900M</td>
                  <td class="num" data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">40</td>
                  <td data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">Program</td>
                  <td data-attr="INCEPTION_DATE">Jan 2023</td>
                  <td class="num" data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$150M</td>
                  <td class="num">$146.5M</td>
                  <td><span class="da-st ok">1.11x · On pace</span></td>
                  <td class="num"><span class="x-fig warn">0.87x</span></td>
                  <td class="x-pills"><span class="da-st breach">Breach 3</span><span class="da-st near">Watch 1</span></td>
                  <td class="num"><span class="x-cov"><i></i>2</span></td><td class="num"><span class="x-cov nil"><i></i>–</span></td><td class="num"><span class="x-cov nil"><i></i>–</span></td>
                  <td class="num"><b>2</b></td>
                </tr>
                <tr class="sub" data-open="nmi-pc">
                  <td>Private Credit Sleeve</td>
                  <td class="num" data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$600M</td>
                  <td class="num" data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">28</td>
                  <td data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">Parent level</td>
                  <td data-attr="INCEPTION_DATE">Jan 2023</td>
                  <td class="num" data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$100M</td>
                  <td class="num">$102M</td>
                  <td><span class="da-st x-ahead">1.16x · Ahead</span></td>
                  <td class="num"><span class="x-fig ok">1.02x</span></td>
                  <td class="x-pills"><span class="da-st breach">Breach 3</span></td>
                  <td class="num"><span class="x-cov"><i></i>8</span></td><td class="num"><span class="x-cov"><i></i>2</span></td><td class="num"><span class="x-cov nil"><i></i>–</span></td>
                  <td class="num">10</td>
                </tr>
                <tr class="sub" data-open="nmi-sec">
                  <td>Secondaries Sleeve</td>
                  <td class="num" data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">$200M</td>
                  <td class="num" data-attr="FUND_TARGET_INVESTMENT_COUNT" data-editable="true">10</td>
                  <td data-attr="FUND_TARGET_PERCENT_BASIS" data-editable="true">Program</td>
                  <td data-attr="INCEPTION_DATE">Apr 2024</td>
                  <td class="num" data-attr="FUND_ANNUAL_DEPLOYMENT_TARGET" data-editable="true">$60M</td>
                  <td class="num">$44.5M</td>
                  <td><span class="da-st breach">0.85x · Behind</span></td>
                  <td class="num"><span class="x-fig bad">0.72x</span></td>
                  <td class="x-pills"><span class="da-st near">Watch 1</span></td>
                  <td class="num"><span class="x-cov"><i></i>3</span></td><td class="num"><span class="x-cov nil"><i></i>–</span></td><td class="num"><span class="x-cov"><i></i>3</span></td>
                  <td class="num">6</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="da-sec">
        <div class="da-sechead">
          <h2>Target matrix</h2>
          <div class="cr-tools">
            <select id="ovLens" aria-label="Hierarchy"><option value="strategy" selected>Strategy</option><option value="region">Region</option><option value="structure">Structure</option></select>
            <select id="ovDepth" aria-label="Level"><option value="1" selected>Category</option><option value="2">Asset Class</option><option value="3">Strategy</option><option value="4">Sub-Strategy</option></select>
            <select id="ovMeasure" aria-label="Measure"><option value="pct" selected>% target</option><option value="usd">$ target</option><option value="n"># investments</option></select>
          </div>
        </div>
        <div class="da-main solo">
          <div class="da-gridwrap">
            <table class="da-grid fit x-tree x-mx">
              <thead><tr><th>Client / mandate</th><th class="num">Primary</th><th class="num">Secondary</th><th class="num">Co-Investment</th><th class="num">Separate Account</th></tr></thead>
              <tbody>
                <tr class="par">
                  <td><b>Commonwealth Teachers’ Retirement</b></td>
                  <td class="num" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr|strategy|Primary" title="Commonwealth Teachers’ Retirement · Primary · Above max"><span class="x-dot above"></span><b>55%</b><small>50%–60%</small></td>
                  <td class="num" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr|strategy|Secondary" title="Commonwealth Teachers’ Retirement · Secondary · Below min"><span class="x-dot below"></span><b>20%</b><small>15%–25%</small></td>
                  <td class="num" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr|strategy|Co-Investment" title="Commonwealth Teachers’ Retirement · Co-Investment · Below min"><span class="x-dot below"></span><b>25%</b><small>20%–30%</small></td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr|strategy|Separate Account" title="Commonwealth Teachers’ Retirement · Separate Account">·</td>
                </tr>
                <tr class="sub">
                  <td>PE Primary Sleeve</td>
                  <td class="num imp" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-pe|strategy|Primary" title="PE Primary Sleeve · Primary · No target"><span class="x-dot none"></span>≈75%</td>
                  <td class="num imp" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-pe|strategy|Secondary" title="PE Primary Sleeve · Secondary · No target"><span class="x-dot none"></span>≈25%</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-pe|strategy|Co-Investment" title="PE Primary Sleeve · Co-Investment">·</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-pe|strategy|Separate Account" title="PE Primary Sleeve · Separate Account">·</td>
                </tr>
                <tr class="sub">
                  <td>Credit &amp; Real Assets Sleeve</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-cra|strategy|Primary" title="Credit &amp; Real Assets Sleeve · Primary">·</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-cra|strategy|Secondary" title="Credit &amp; Real Assets Sleeve · Secondary">·</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-cra|strategy|Co-Investment" title="Credit &amp; Real Assets Sleeve · Co-Investment">·</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-cra|strategy|Separate Account" title="Credit &amp; Real Assets Sleeve · Separate Account">·</td>
                </tr>
                <tr class="sub">
                  <td>Co-Investment Sleeve</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-co|strategy|Primary" title="Co-Investment Sleeve · Primary">·</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-co|strategy|Secondary" title="Co-Investment Sleeve · Secondary">·</td>
                  <td class="num imp" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-co|strategy|Co-Investment" title="Co-Investment Sleeve · Co-Investment · No target"><span class="x-dot none"></span>≈100%</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="ctr-co|strategy|Separate Account" title="Co-Investment Sleeve · Separate Account">·</td>
                </tr>
                <tr class="par">
                  <td><b>Halvorsen Family Office</b></td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="hfo|strategy|Primary" title="Halvorsen Family Office · Primary">·</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="hfo|strategy|Secondary" title="Halvorsen Family Office · Secondary">·</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="hfo|strategy|Co-Investment" title="Halvorsen Family Office · Co-Investment">·</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="hfo|strategy|Separate Account" title="Halvorsen Family Office · Separate Account">·</td>
                </tr>
                <tr class="sub">
                  <td>Diversified Sleeve</td>
                  <td class="num" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="hfo-div|strategy|Primary" title="Diversified Sleeve · Primary · In range · over target"><span class="x-dot in"></span><b>50%</b><small>40%–60%</small></td>
                  <td class="num" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="hfo-div|strategy|Secondary" title="Diversified Sleeve · Secondary · In range · under target"><span class="x-dot in"></span><b>30%</b><small>20%–35%</small></td>
                  <td class="num" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="hfo-div|strategy|Co-Investment" title="Diversified Sleeve · Co-Investment · In range · under target"><span class="x-dot in"></span><b>20%</b><small>10%–25%</small></td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="hfo-div|strategy|Separate Account" title="Diversified Sleeve · Separate Account">·</td>
                </tr>
                <tr class="par">
                  <td><b>Northgate Mutual Insurance</b></td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi|strategy|Primary" title="Northgate Mutual Insurance · Primary">·</td>
                  <td class="num" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi|strategy|Secondary" title="Northgate Mutual Insurance · Secondary · 90% of target"><span class="x-dot under"></span><b>25%</b></td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi|strategy|Co-Investment" title="Northgate Mutual Insurance · Co-Investment">·</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi|strategy|Separate Account" title="Northgate Mutual Insurance · Separate Account">·</td>
                </tr>
                <tr class="sub">
                  <td>Private Credit Sleeve</td>
                  <td class="num" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi-pc|strategy|Primary" title="Private Credit Sleeve · Primary · At target"><span class="x-dot at"></span><b>70%</b></td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi-pc|strategy|Secondary" title="Private Credit Sleeve · Secondary">·</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi-pc|strategy|Co-Investment" title="Private Credit Sleeve · Co-Investment">·</td>
                  <td class="num" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi-pc|strategy|Separate Account" title="Private Credit Sleeve · Separate Account · In range · over target"><span class="x-dot in"></span><b>30%</b><small>20%–40%</small></td>
                </tr>
                <tr class="sub">
                  <td>Secondaries Sleeve</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi-sec|strategy|Primary" title="Secondaries Sleeve · Primary">·</td>
                  <td class="num imp" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi-sec|strategy|Secondary" title="Secondaries Sleeve · Secondary · No target"><span class="x-dot none"></span>≈100%</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi-sec|strategy|Co-Investment" title="Secondaries Sleeve · Co-Investment">·</td>
                  <td class="num nil" data-attr="FUND_TARGET_MATRIX" data-editable="true" data-go="nmi-sec|strategy|Separate Account" title="Secondaries Sleeve · Separate Account">·</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <p class="da-note" style="margin-top:8px">Only levels with at least one target appear as columns. Small figures are the min–max band; the dot shows where commitments sit against it. Italic ≈ values are implied from the other measure.</p>
      </section>
    </main>
  </div>
</div>
```

### Pipeline (house design)

Pipeline, redesigned in the house kit from the captured view and checked against it.

```html
<style>
.x-pipe { --p-muted: var(--ink-3); --p-serif: var(--font-ibm-plex-sans); --p-surface2: var(--bg-alt); --p-hover: var(--bg); --p-warn: var(--amber); --p-warn-soft: var(--badge-warn-bg); --p-on: #fff; --p-good: var(--green); }
.x-pipe .page-header, .x-pipe .btn-primary, .x-pipe .btn-primary:hover { box-shadow: none; }
.x-pipe .btn:disabled { opacity: .5; cursor: default; }
.x-shell { display: grid; grid-template-columns: 236px minmax(0, 1fr); gap: 14px; align-items: start; }
.x-rail { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 0; position: sticky; top: 8px; }
.x-rail h2 { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-3); padding: 0 12px 6px; }
.x-ent { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 2px 6px; align-items: center; width: 100%; border: 0; border-top: 1px solid var(--line); background: none; padding: 7px 12px; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.x-ent.m { padding-left: 24px; }
.x-ent .nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.x-ent.m .nm { font-weight: 500; }
.x-ent .sub { grid-column: 1 / -1; display: flex; gap: 6px; align-items: center; font-size: 11.5px; color: var(--ink-3); }
.x-ent .sub .pipe-trk { margin-left: auto; }
.x-rail .btn { margin: 8px 12px 0; width: calc(100% - 24px); justify-content: center; }
.x-pipe .da-title { flex: 0 0 330px; min-width: 0; }
.x-pipe .da-holdbox { min-width: 220px; cursor: pointer; }
.x-st-info { background: var(--badge-info-bg); color: var(--badge-info-fg); }
.x-mut { color: var(--ink-3); font-weight: 400; }
.x-pipe .pipe-mx { --t: 0; }
.x-pipe .pipe-mx thead th, .x-pipe .pipe-mx tbody th { padding: 8px 11px; }
.x-pipe .pipe-mx thead th:first-child { width: 190px; }
.x-pipe .pipe-mx td { height: 1px; }
.x-pipe .pipe-mx td.tc { background: var(--bg-alt); }
.x-pipe .pipe-mx .sx { display: block; font-weight: 400; color: var(--ink-3); font-size: 12px; }
.x-pipe .da-grid th.num, .x-pipe .da-grid td.num, .x-pipe .da-grid .da-st, .x-nw { white-space: nowrap; }
.x-chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 6px; font-size: 12px; color: var(--ink-3); }
.x-tin { display: flex; justify-content: flex-end; align-items: center; gap: 4px; font-weight: 400; margin-top: 4px; }
.x-tin input[type="text"] { font: inherit; width: 72px; padding: 2px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); text-align: right; }
.x-range { width: 100%; margin-top: 4px; accent-color: var(--accent-2); }
.x-pipe .da-panel h4 .da-note { font-weight: 400; margin-left: 4px; }
</style>

<div class="da x-pipe">
  <header class="page-header">
    <div class="page-title-block">
      <div><b>Target Manager</b> <span class="page-meta">· Fund-of-Funds &amp; Directs</span></div>
      <div class="pipe-seg" role="group" aria-label="View">
        <button aria-pressed="false">Assign targets</button>
        <button aria-pressed="false">Overview</button>
        <button aria-pressed="true">Pipeline</button>
      </div>
    </div>
    <div class="page-actions">
      <button class="btn btn-sm" title="Undo last change (Ctrl+Z)" disabled>Undo</button>
      <button class="btn btn-sm" title="Copy all targets as CSV">Copy CSV</button>
      <button class="btn btn-sm" title="Restore the example clients and targets">Reset example</button>
    </div>
  </header>

  <div class="x-shell">
    <nav class="x-rail" aria-label="Clients and mandates">
      <h2>Clients &amp; mandates</h2>
      <button class="x-ent"><span class="nm">Commonwealth Teachers’ Retirement</span><span class="cr-n">14</span><span class="da-st breach" title="5 compliance breaches">5</span><span class="sub"><span data-attr="FUND_TOTAL_COMMITMENTS">$2B</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">70 inv</span> <span class="da-st ok" title="2026 pacing velocity">1.04x</span><span class="pipe-trk" title="Strategy: 6 · Region: 4 · Structure: 4"><i class="on"></i><i class="on"></i><i class="on"></i></span></span></button>
      <button class="x-ent m"><span class="nm">PE Primary Sleeve</span><span class="cr-n">17</span><span class="da-st breach" title="3 compliance breaches">3</span><span class="sub"><span data-attr="FUND_TOTAL_COMMITMENTS">$1.2B</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">30 inv</span> <span class="da-st ok" title="2026 pacing velocity">1.06x</span><span class="pipe-trk" title="Strategy: 9 · Region: 3 · Structure: 5"><i class="on"></i><i class="on"></i><i class="on"></i></span></span></button>
      <button class="x-ent m"><span class="nm">Credit &amp; Real Assets Sleeve</span><span class="cr-n">9</span><span></span><span class="sub"><span data-attr="FUND_TOTAL_COMMITMENTS">$450M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">14 inv</span> <span class="da-st breach" title="2026 pacing velocity">0.77x</span><span class="pipe-trk" title="Strategy: 7 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span></button>
      <button class="x-ent m"><span class="nm">Co-Investment Sleeve</span><span class="cr-n">7</span><span class="da-st breach" title="2 compliance breaches">2</span><span class="sub"><span data-attr="FUND_TOTAL_COMMITMENTS">$400M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">24 inv</span> <span class="da-st ok" title="2026 pacing velocity">1.14x</span><span class="pipe-trk" title="Strategy: 4 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span></button>
      <button class="x-ent"><span class="nm">Halvorsen Family Office</span><span class="cr-n">3</span><span class="da-st breach" title="1 compliance breach">1</span><span class="sub"><span data-attr="FUND_TOTAL_COMMITMENTS">$450M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">40 inv</span> <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="pipe-trk" title="Strategy: 0 · Region: 3 · Structure: 0"><i></i><i class="on"></i><i></i></span></span></button>
      <button class="x-ent m"><span class="nm">Diversified Sleeve</span><span class="cr-n">4</span><span class="da-st breach" title="1 compliance breach">1</span><span class="sub"><span data-attr="FUND_TOTAL_COMMITMENTS">$450M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">40 inv</span> <span class="da-st ok" title="2026 pacing velocity">0.96x</span><span class="pipe-trk" title="Strategy: 4 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span></button>
      <button class="x-ent"><span class="nm">Northgate Mutual Insurance</span><span class="cr-n">2</span><span class="da-st breach" title="3 compliance breaches">3</span><span class="sub"><span data-attr="FUND_TOTAL_COMMITMENTS">$900M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">40 inv</span> <span class="da-st ok" title="2026 pacing velocity">1.11x</span><span class="pipe-trk" title="Strategy: 2 · Region: 0 · Structure: 0"><i class="on"></i><i></i><i></i></span></span></button>
      <button class="x-ent m"><span class="nm">Private Credit Sleeve</span><span class="cr-n">10</span><span class="da-st breach" title="3 compliance breaches">3</span><span class="sub"><span data-attr="FUND_TOTAL_COMMITMENTS">$600M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">28 inv</span> <span class="da-st x-st-info" title="2026 pacing velocity">1.16x</span><span class="pipe-trk" title="Strategy: 8 · Region: 2 · Structure: 0"><i class="on"></i><i class="on"></i><i></i></span></span></button>
      <button class="x-ent m"><span class="nm">Secondaries Sleeve</span><span class="cr-n">6</span><span></span><span class="sub"><span data-attr="FUND_TOTAL_COMMITMENTS">$200M</span> · <span data-attr="FUND_TARGET_INVESTMENT_COUNT">10 inv</span> <span class="da-st breach" title="2026 pacing velocity">0.85x</span><span class="pipe-trk" title="Strategy: 3 · Region: 0 · Structure: 3"><i class="on"></i><i></i><i class="on"></i></span></span></button>
      <button class="btn btn-sm">+ Add mandate sleeve</button>
    </nav>

    <main>
      <header class="da-ribbon">
        <div class="da-title">
          <span class="da-chip">Pipeline</span>
          <h1>Deal pipeline</h1>
          <p>Where every deal sits in its life cycle, across categories. Pick a cell to filter the list, then open a deal to allocate it across mandate sleeves.</p>
        </div>
        <div class="da-facts">
          <div class="da-fact big"><span>Open deals</span><strong>13</strong></div>
          <div class="da-fact"><span>Deal size</span><strong>$18.73B</strong></div>
          <div class="da-fact"><span>Our target hold</span><strong>$810M</strong></div>
          <div class="da-fact"><span>Proposed allocation</span><strong>$688M</strong></div>
        </div>
        <div class="da-holdbox" role="button" tabindex="0" title="Filter to deals needing attention">
          <div class="da-holdtop"><span>Need attention</span><b>2</b></div>
          <div class="da-bar"><i style="width:15.4%"></i></div>
          <p>2 of 13 open deals</p>
        </div>
      </header>

      <section class="da-sec">
        <div class="pipe-board" style="margin-top:12px">
          <table class="pipe-mx">
            <thead><tr>
              <th>Category<span class="sx">Our hold by stage</span></th>
              <th>Sourcing<span class="sx">2 deals, $95M</span></th>
              <th>Due diligence<span class="sx">4 deals, $250M</span></th>
              <th>IC approved<span class="sx">3 deals, $150M</span></th>
              <th>Allocation<span class="sx">3 deals, $255M</span></th>
              <th>Closing<span class="sx">1 deal, $60M</span></th>
              <th>Closed<span class="sx">0 deals, $0</span></th>
              <th>All stages</th>
            </tr></thead>
            <tbody>
              <tr>
                <th>Primary<span class="sx">8 deals, $15.4B deal size</span></th>
                <td><button class="cb" title="Filter the list to Primary · Sourcing"><span class="n">1</span><span class="d">$70M</span></button></td>
                <td><button class="cb" title="Filter the list to Primary · Due diligence"><span class="n">4</span><span class="d">$250M</span></button></td>
                <td><button class="cb" title="Filter the list to Primary · IC approved"><span class="n">1</span><span class="d">$40M</span></button></td>
                <td><button class="cb" title="Filter the list to Primary · Allocation"><span class="at">1</span><span class="n">1</span><span class="d">$150M</span></button></td>
                <td><button class="cb" title="Filter the list to Primary · Closing"><span class="at">1</span><span class="n">1</span><span class="d">$60M</span></button></td>
                <td><button class="cb zero" title="Filter the list to Primary · Closed"><span class="n">0</span><span class="d">none</span></button></td>
                <td class="tc"><button class="cb" title="Filter the list to Primary · all stages"><span class="at">2</span><span class="n">8</span><span class="d">$570M</span></button></td>
              </tr>
              <tr>
                <th>Secondary<span class="sx">2 deals, $2B deal size</span></th>
                <td><button class="cb zero" title="Filter the list to Secondary · Sourcing"><span class="n">0</span><span class="d">none</span></button></td>
                <td><button class="cb zero" title="Filter the list to Secondary · Due diligence"><span class="n">0</span><span class="d">none</span></button></td>
                <td><button class="cb" title="Filter the list to Secondary · IC approved"><span class="n">1</span><span class="d">$80M</span></button></td>
                <td><button class="cb" title="Filter the list to Secondary · Allocation"><span class="n">1</span><span class="d">$60M</span></button></td>
                <td><button class="cb zero" title="Filter the list to Secondary · Closing"><span class="n">0</span><span class="d">none</span></button></td>
                <td><button class="cb zero" title="Filter the list to Secondary · Closed"><span class="n">0</span><span class="d">none</span></button></td>
                <td class="tc"><button class="cb" title="Filter the list to Secondary · all stages"><span class="n">2</span><span class="d">$140M</span></button></td>
              </tr>
              <tr>
                <th>Co-Investment<span class="sx">3 deals, $1.33B deal size</span></th>
                <td><button class="cb" title="Filter the list to Co-Investment · Sourcing"><span class="n">1</span><span class="d">$25M</span></button></td>
                <td><button class="cb zero" title="Filter the list to Co-Investment · Due diligence"><span class="n">0</span><span class="d">none</span></button></td>
                <td><button class="cb" title="Filter the list to Co-Investment · IC approved"><span class="n">1</span><span class="d">$30M</span></button></td>
                <td><button class="cb" title="Filter the list to Co-Investment · Allocation"><span class="n">1</span><span class="d">$45M</span></button></td>
                <td><button class="cb zero" title="Filter the list to Co-Investment · Closing"><span class="n">0</span><span class="d">none</span></button></td>
                <td><button class="cb zero" title="Filter the list to Co-Investment · Closed"><span class="n">0</span><span class="d">none</span></button></td>
                <td class="tc"><button class="cb" title="Filter the list to Co-Investment · all stages"><span class="n">3</span><span class="d">$100M</span></button></td>
              </tr>
              <tr>
                <th>Separate Account<span class="sx">0 deals, $0 deal size</span></th>
                <td><button class="cb zero" title="Filter the list to Separate Account · Sourcing"><span class="n">0</span><span class="d">none</span></button></td>
                <td><button class="cb zero" title="Filter the list to Separate Account · Due diligence"><span class="n">0</span><span class="d">none</span></button></td>
                <td><button class="cb zero" title="Filter the list to Separate Account · IC approved"><span class="n">0</span><span class="d">none</span></button></td>
                <td><button class="cb zero" title="Filter the list to Separate Account · Allocation"><span class="n">0</span><span class="d">none</span></button></td>
                <td><button class="cb zero" title="Filter the list to Separate Account · Closing"><span class="n">0</span><span class="d">none</span></button></td>
                <td><button class="cb zero" title="Filter the list to Separate Account · Closed"><span class="n">0</span><span class="d">none</span></button></td>
                <td class="tc"><button class="cb zero" title="Filter the list to Separate Account · all stages"><span class="n">0</span><span class="d">none</span></button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="pipe-tools">
          <div class="l">
            <input class="pipe-search" type="search" placeholder="Search deal, manager or sector" aria-label="Search deals">
            <button class="pipe-chip" aria-pressed="false">Needs attention</button>
          </div>
          <div class="r">
            <span class="lbl">Group by</span>
            <div class="pipe-seg" role="group" aria-label="Group deals by">
              <button aria-pressed="true">Category</button><button aria-pressed="false">Stage</button><button aria-pressed="false">None</button>
            </div>
          </div>
        </div>
        <p class="pipe-count">Showing 13 of 13 deals</p>

        <div class="da-gridwrap">
          <table class="da-grid">
            <thead><tr><th>Deal</th><th>Stage</th><th class="num">Deal size</th><th class="num">Our hold</th><th>Allocated</th><th>Flags</th><th class="num">Close</th></tr></thead>
            <tbody>
              <tr class="par"><td colspan="7"><b>Primary</b> <span class="x-mut">8 deals · $570M our hold</span></td></tr>
              <tr><td><div class="da-name"><span><b>Bluewater Specialty Finance Fund III</b> <span class="x-mut">Asset-backed specialty lending</span><small>Primary · Specialty Financing · North America</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i></i></span>Closing</span></td><td class="num">$1.5B</td><td class="num">$60M</td><td class="x-nw"><span class="pipe-prog"><i style="width:98%"></i></span>98%</td><td><span class="da-st near">$1.5M unallocated</span> <span class="da-st x-st-info">Closes in 13 days</span></td><td class="num">30 Nov 2026</td></tr>
              <tr><td><div class="da-name"><span><b>Tidewater Direct Lending Fund VII</b> <span class="x-mut">Senior secured direct lending</span><small>Primary · Origination · Senior Debt · North America</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i></i><i></i></span>Allocation</span></td><td class="num">$2.8B</td><td class="num">$150M</td><td class="x-nw"><span class="pipe-prog"><i style="width:71%"></i></span>71%</td><td><span class="da-st near">$43.5M unallocated</span></td><td class="num">20 Dec 2026</td></tr>
              <tr><td><div class="da-name"><span><b>Kestrel Ventures VI</b> <span class="x-mut">Seed and early-stage software</span><small>Primary · Venture Capital · Seed / Early Stage · North America</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i class="on"></i><i class="on"></i><i></i><i></i><i></i></span>IC approved</span></td><td class="num">$900M</td><td class="num">$40M</td><td class="x-nw"><span class="pipe-prog"><i style="width:100%"></i></span>100%</td><td></td><td class="num">10 Dec 2026</td></tr>
              <tr><td><div class="da-name"><span><b>Ridgeline Capital Partners X</b> <span class="x-mut">Mid-market buyout fund</span><small>Primary · Buyout · Mid Cap · North America</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i><i></i><i></i><i></i></span>Due diligence</span></td><td class="num">$3.5B</td><td class="num">$120M</td><td class="x-nw"><span class="pipe-prog"><i style="width:56%"></i></span>56%</td><td><span class="da-st near">$52.5M unallocated</span></td><td class="num">15 Jan 2027</td></tr>
              <tr><td><div class="da-name"><span><b>Highgate Growth Partners II</b> <span class="x-mut">Emerging-manager growth fund</span><small>Primary · Growth Equity · North America</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i><i></i><i></i><i></i></span>Due diligence</span></td><td class="num">$400M</td><td class="num">$45M</td><td class="x-nw"><span class="pipe-prog"><i style="width:100%"></i></span>100%</td><td></td><td class="num">20 Jan 2027</td></tr>
              <tr><td><div class="da-name"><span><b>Sterling Oak Asia Partners IV</b> <span class="x-mut">Greater China mid-market buyout</span><small>Primary · Buyout · Mid Cap · APAC/ROW</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i><i></i><i></i><i></i></span>Due diligence</span></td><td class="num">$1.1B</td><td class="num">$35M</td><td class="x-nw"><span class="pipe-prog"><i style="width:100%"></i></span>100%</td><td></td><td class="num">28 Jan 2027</td></tr>
              <tr><td><div class="da-name"><span><b>Alder Creek Real Estate Partners V</b> <span class="x-mut">European value-add real estate</span><small>Primary · Real Estate · Value Add · Western Europe</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i><i></i><i></i><i></i></span>Due diligence</span></td><td class="num">$1.2B</td><td class="num">$50M</td><td class="x-nw"><span class="pipe-prog"><i style="width:100%"></i></span>100%</td><td></td><td class="num">1 Feb 2027</td></tr>
              <tr><td><div class="da-name"><span><b>Granite Peak Infrastructure Fund VI</b> <span class="x-mut">Core-plus energy transition</span><small>Primary · Infrastructure · Core Plus Infrastructure · Western Europe</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i></i><i></i><i></i><i></i><i></i></span>Sourcing</span></td><td class="num">$4B</td><td class="num">$70M</td><td class="x-nw"><span class="pipe-prog"><i style="width:100%"></i></span>100%</td><td></td><td class="num">30 Mar 2027</td></tr>
              <tr class="par"><td colspan="7"><b>Secondary</b> <span class="x-mut">2 deals · $140M our hold</span></td></tr>
              <tr><td><div class="da-name"><span><b>Harborview Continuation Vehicle III</b> <span class="x-mut">Single-asset continuation vehicle</span><small>Secondary · Buyout · North America</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i></i><i></i></span>Allocation</span></td><td class="num">$1.4B</td><td class="num">$60M</td><td class="x-nw"><span class="pipe-prog"><i style="width:100%"></i></span>100%</td><td></td><td class="num">18 Dec 2026</td></tr>
              <tr><td><div class="da-name"><span><b>Summit Ridge LP Portfolio 2026</b> <span class="x-mut">Diversified buyout LP portfolio</span><small>Secondary · Buyout · North America</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i class="on"></i><i class="on"></i><i></i><i></i><i></i></span>IC approved</span></td><td class="num">$600M</td><td class="num">$80M</td><td class="x-nw"><span class="pipe-prog"><i style="width:82%"></i></span>82%</td><td><span class="da-st near">$14.5M unallocated</span></td><td class="num">22 Dec 2026</td></tr>
              <tr class="par"><td colspan="7"><b>Co-Investment</b> <span class="x-mut">3 deals · $100M our hold</span></td></tr>
              <tr class="sel"><td><div class="da-name"><span><b>Project Lantern</b> <span class="x-mut">Healthcare services platform</span><small>Co-Investment · Buyout · Mid Cap · North America</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i></i><i></i></span>Allocation</span></td><td class="num">$420M</td><td class="num">$45M</td><td class="x-nw"><span class="pipe-prog"><i style="width:100%"></i></span>100%</td><td><span class="da-st x-st-info">Closes in 18 days</span></td><td class="num">5 Dec 2026</td></tr>
              <tr><td><div class="da-name"><span><b>Project Cobalt</b> <span class="x-mut">Midstream energy services</span><small>Co-Investment · Buyout · Large Cap · North America</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i class="on"></i><i class="on"></i><i></i><i></i><i></i></span>IC approved</span></td><td class="num">$650M</td><td class="num">$30M</td><td class="x-nw"><span class="pipe-prog"><i style="width:67%"></i></span>67%</td><td><span class="da-st near">$10M unallocated</span></td><td class="num">12 Dec 2026</td></tr>
              <tr><td><div class="da-name"><span><b>Project Juniper</b> <span class="x-mut">Vertical software growth equity</span><small>Co-Investment · Growth Equity · Western Europe</small></span></div></td><td><span class="pipe-stg"><span class="pipe-trk" aria-hidden="true"><i class="on"></i><i></i><i></i><i></i><i></i><i></i></span>Sourcing</span></td><td class="num">$260M</td><td class="num">$25M</td><td class="x-nw"><span class="pipe-prog"><i style="width:100%"></i></span>100%</td><td></td><td class="num">15 Feb 2027</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="da-sec">
        <div class="da-sechead">
          <div>
            <h2>Allocation grid · Project Lantern</h2>
            <p>Each sleeve’s sharing ratio is its remaining profile allocation spread over the years left in its investment period, as a share of all eligible sleeves. Compliance caps each sleeve at the lowest capacity of the rules this deal would worsen, and the rest of each tranche goes to the other eligible sleeves.</p>
            <div class="x-chips">
              <span class="da-chip" title="Category">Co-Investment</span><span class="da-chip" title="Asset class">Private Equity</span><span class="da-chip" title="Strategy">Buyout</span><span class="da-chip" title="Sub-strategy">Mid Cap</span><span class="da-chip" title="Region">North America</span><span class="da-chip" title="Structure">Co-Investment</span><span class="da-chip" title="Sector">Health Care</span><span class="da-chip" title="Market">US</span><span class="da-chip" title="Manager">Westbrook</span>
              <span>Close 5 Dec 2026 · Allocation</span>
            </div>
          </div>
        </div>
        <div class="da-toolbar">
          <label><input type="checkbox" value="on"> Show sleeves without a target (4)</label>
          <span style="margin-left:auto"></span>
          <button class="btn btn-sm">Expand all</button>
          <button class="btn btn-sm">Collapse all</button>
          <button class="btn btn-sm" title="Clear overrides and exclusions">Reset allocation</button>
          <button class="btn btn-sm" title="Clear overrides only">Clear adjustments</button>
          <button class="btn btn-sm btn-primary">Commit allocation</button>
        </div>

        <div class="da-main">
          <div class="da-gridwrap">
            <table class="da-grid">
              <thead><tr>
                <th>Portfolio</th>
                <th class="num" title="Program × strategy % × geography %, and what is already deployed in that profile">Profile allocation</th>
                <th class="num" title="Remaining profile allocation ÷ years left in the investment period">Annual pace</th>
                <th class="num" title="Annual pace ÷ the sum of all eligible sleeves">Sharing ratio</th>
                <th>Compliance capacity</th>
                <th class="num da-tcol">Common equity
                  <div class="x-tin"><input type="text" value="35.00" aria-label="Common equity hold in $M" data-editable="true"> <small>of 300.00</small></div>
                  <input class="x-range" type="range" min="0" max="300" step="0.5" value="35" aria-label="Common equity hold slider" data-editable="true">
                </th>
                <th class="num da-tcol">Preferred equity
                  <div class="x-tin"><input type="text" value="10.00" aria-label="Preferred equity hold in $M" data-editable="true"> <small>of 120.00</small></div>
                  <input class="x-range" type="range" min="0" max="120" step="0.5" value="10" aria-label="Preferred equity hold slider" data-editable="true">
                </th>
                <th class="num">Total allocation</th>
              </tr></thead>
              <tbody>
                <tr class="par">
                  <td><div class="da-name"><button class="da-caret" aria-expanded="true" aria-label="Collapse Commonwealth Teachers’ Retirement">▾</button><span><b>Commonwealth Teachers’ Retirement</b><small>1 sleeve</small></span></div></td>
                  <td class="num">156.00<small>99.65 deployed</small></td>
                  <td class="num">34.78<small>56.35 remaining</small></td>
                  <td class="num"><b>62.1%</b></td>
                  <td></td>
                  <td class="num"><b>21.74</b><small>62.1% of tranche</small></td>
                  <td class="num"><b>3.26</b><small>32.6% of tranche</small></td>
                  <td class="num"><b>25.00</b><small>55.6% of hold</small></td>
                </tr>
                <tr class="sub sel">
                  <td><div class="da-name"><span><b>Co-Investment Sleeve</b><small>Co-Investment › Private Equity › Buyout</small></span></div></td>
                  <td class="num">156.00<small>60% × 65% · 99.65 deployed</small></td>
                  <td class="num">34.78<small>56.35 over 1.62 yrs</small></td>
                  <td class="num"><span class="da-share"><i style="width:62.1%"></i></span><b>62.1%</b></td>
                  <td><b>25.00</b><small title="Asset Concentration (amount limit): $25M per asset less $0 already held">Asset Concentration (amount limit) <span class="cr-rule">Limit</span></small></td>
                  <td class="num act"><input value="21.74" aria-label="Co-Investment Sleeve Common equity allocation in $M" data-editable="true"><small>62.1% of tranche</small></td>
                  <td class="num act"><input value="3.26" aria-label="Co-Investment Sleeve Preferred equity allocation in $M" data-editable="true"><small class="fs-warn">Capped</small></td>
                  <td class="num"><b>25.00</b><small>55.6% of hold</small></td>
                </tr>
                <tr class="par">
                  <td><div class="da-name"><button class="da-caret" aria-expanded="true" aria-label="Collapse Halvorsen Family Office">▾</button><span><b>Halvorsen Family Office</b><small>1 sleeve</small></span></div></td>
                  <td class="num">45.00<small>0.00 deployed</small></td>
                  <td class="num">21.23<small>45.00 remaining</small></td>
                  <td class="num"><b>37.9%</b></td>
                  <td></td>
                  <td class="num"><b>13.26</b><small>37.9% of tranche</small></td>
                  <td class="num"><b>6.74</b><small>67.4% of tranche</small></td>
                  <td class="num"><b>20.00</b><small>44.4% of hold</small></td>
                </tr>
                <tr class="sub">
                  <td><div class="da-name"><span><b>Diversified Sleeve</b><small>Co-Investment</small></span></div></td>
                  <td class="num">45.00<small>20% × 50% · 0.00 deployed</small></td>
                  <td class="num">21.23<small>45.00 over 2.12 yrs</small></td>
                  <td class="num"><span class="da-share"><i style="width:37.9%"></i></span><b>37.9%</b></td>
                  <td><b>22.50</b><small title="Asset Concentration (% limit): 5% of $450M less $0 already in Project Lantern">Asset Concentration (% limit) <span class="cr-rule">Limit</span></small></td>
                  <td class="num act"><input value="13.26" aria-label="Diversified Sleeve Common equity allocation in $M" data-editable="true"><small>37.9% of tranche</small></td>
                  <td class="num act"><input value="6.74" aria-label="Diversified Sleeve Preferred equity allocation in $M" data-editable="true"><small>67.4% of tranche</small></td>
                  <td class="num"><b>20.00</b><small>44.4% of hold</small></td>
                </tr>
              </tbody>
              <tfoot>
                <tr><td colspan="5">Allocated</td><td class="num">35.00</td><td class="num">10.00</td><td class="num">45.00</td></tr>
                <tr><td colspan="5">Target hold</td><td class="num">35.00</td><td class="num">10.00</td><td class="num">45.00</td></tr>
                <tr><td colspan="5">Unallocated</td><td class="num">0.00</td><td class="num">0.00</td><td class="num">0.00</td></tr>
              </tfoot>
            </table>
          </div>

          <aside class="da-panel">
            <div class="da-ph">
              <div class="da-phrow">
                <div><small>Portfolio</small><h3>Co-Investment Sleeve</h3><small>Commonwealth Teachers’ Retirement</small></div>
                <button class="btn btn-sm" data-attr="FUND_IS_ALLOCATION_ELIGIBLE" data-editable="true">Exclude entirely</button>
              </div>
              <div class="da-big">$25.00M</div>
              <p class="da-note">55.6% of our hold, 6% of the deal</p>
            </div>
            <section>
              <h4>Tranche allocations <span class="da-note">Amount · vs pro-rata</span></h4>
              <table class="da-mini">
                <tbody>
                  <tr><td><b>Common equity</b><small>At its sharing ratio</small></td><td class="num">21.74</td><td class="num">+0.00</td></tr>
                  <tr><td><b>Preferred equity</b><small>Capped by Asset Concentration (amount limit)</small></td><td class="num">3.26</td><td class="num dn">−2.95</td></tr>
                </tbody>
              </table>
            </section>
            <section>
              <h4>Sharing ratio <span class="da-note">From the allocation workbook</span></h4>
              <table class="da-mini">
                <tbody>
                  <tr><td>Total fund size</td><td class="num" data-attr="FUND_TOTAL_COMMITMENTS" data-editable="true">400.00</td></tr>
                  <tr><td>Strategy %</td><td class="num"><span data-attr="FUND_TARGET_MATRIX" data-editable="true">60%</span><small>Co-Investment › Private Equity › Buyout</small></td></tr>
                  <tr><td>Geography %</td><td class="num"><span data-attr="FUND_TARGET_MATRIX" data-editable="true">65%</span><small>North America · client macro target</small></td></tr>
                  <tr><td>Profile allocation</td><td class="num">156.00</td></tr>
                  <tr><td>Total deployed</td><td class="num">99.65<small>6 commitments</small></td></tr>
                  <tr><td>Remaining deployment</td><td class="num">56.35</td></tr>
                  <tr><td>Fund start / end</td><td class="num"><span data-attr="INCEPTION_DATE">2023-07-01</span> → <span data-attr="FUND_INVESTMENT_PERIOD_END" data-editable="true">2028-07-01</span></td></tr>
                  <tr><td>Fund duration</td><td class="num">5.01 yrs</td></tr>
                  <tr><td>Remaining duration</td><td class="num">1.62 yrs</td></tr>
                  <tr><td>Average annual deployment</td><td class="num">34.78</td></tr>
                  <tr><td>Exclude</td><td class="num" data-attr="FUND_IS_ALLOCATION_ELIGIBLE" data-editable="true">—</td></tr>
                  <tr><td>Sharing ratio</td><td class="num"><b>62.1%</b><small>34.78 ÷ 56.01</small></td></tr>
                </tbody>
              </table>
            </section>
            <section>
              <h4>Compliance, pro forma <span class="da-note">3 rules affected</span></h4>
              <div class="da-rule">
                <div class="da-ruleline"><b><span class="da-rulename">Asset Concentration (amount limit)</span></b><span class="da-st near">At limit</span></div>
                <p>$25M per asset less $0 already held · capacity 25.00 <span class="cr-rule">Limit</span></p>
                <div class="da-gauge bind"><i style="width:100%"></i></div>
              </div>
              <div class="da-rule">
                <div class="da-ruleline"><b><span class="da-rulename">Investment Size</span></b><span class="da-st ok">Within limit</span></div>
                <p>Single commitment below $30M · capacity 30.00 <span class="cr-rule">Limit</span></p>
                <div class="da-gauge"><i style="width:83%"></i></div>
              </div>
              <div class="da-rule">
                <div class="da-ruleline"><b><span class="da-rulename">Industry Concentration</span></b><span class="da-st ok">Within limit</span></div>
                <p>30% of $400M less $11.5M already in Health Care · capacity 108.50 <span class="cr-rule">Limit</span></p>
                <div class="da-gauge"><i style="width:30%"></i></div>
              </div>
            </section>
          </aside>
        </div>
      </section>
    </main>
  </div>
</div>
```

## Open questions

- Should changes to FUND_TARGET_MATRIX be saved immediately on input blur or staged in a local draft batch requiring an explicit 'Commit Targets' action?
- Confirm whether Deal Sharing Ratios should be written directly to DEAL_FUNDING_PLAN or submitted through an IC memo point review process first.
