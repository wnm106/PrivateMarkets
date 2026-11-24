# Build brief: OCIO

Written by the Surface Builder on 2026-11-23T14:51:49.847Z. Give this file to Claude Code with: _"Build the surface in `docs/surfaces/ocio/README.md`."_

## What to build

Mandate Target Manager (OCIO) is an institutional multi-sleeve allocation and portfolio construction surface anchored on FUND entities (representing both macro Client master accounts and Mandate Sleeves). It enables portfolio managers and allocation committees to set tri-measure allocation target bands ($ / # / %) across three orthogonal hierarchies (Strategy, Region, Structure), track pacing velocity against annual commitment targets, evaluate pre-trade and standing compliance limits via the compliance engine, and calculate dynamic deal-sharing ratios across sleeves.

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
- **Placement:** a client surface in `surfaces/<code>/`, built on `@tapestrai/surface-sdk`
- **Anchored on entity type:** `FUND`
- **Suggested surface code:** `ocio`

## Files in this folder

- `build.md`: the blueprint. Tabs, field bindings, entity model, relationship types, taxonomies, compliance mapping, calculations, design decisions, standards and build steps.
- `blueprint.json`: the same blueprint as data.
- `prototype.html`: the original prototype. Behaviour reference only; do not copy its code or styling.
- `views/`: each view redesigned in the house design.
  - `<view>.html` is the markup to build from. It uses only house classes, with `data-attr` on bound values and `data-editable` on editable cells.
  - `<view>.preview.html` opens in a browser styled with the house kit.
  - `<view>.original.jpg` is the prototype view it came from.

| View | Redesign | Checked against the original |
|---|---|---|
| Mandate Target Manager Refined Host Surface | `views/mandate-target-manager-refined-host-surface.html` | no |
| Region | `views/region.html` | yes |
| Structure | `views/structure.html` | yes |
| Strategy | `views/strategy.html` | yes |
| Pacing | `views/pacing.html` | yes |
| Compliance | `views/compliance.html` | yes |
| Commitments | `views/commitments.html` | yes |
| Overview | `views/overview.html` | yes |
| Pipeline | `views/pipeline.html` | yes |

## How to build it

Read `AGENTS.md`, `docs/GUARDRAILS.md`, `docs/SURFACE_TABS.md` and `surfaces/README.md` first. Work in two pull requests, platform first.

### 1. Platform pull request

- Entity types, relationship types and new attributes from `build.md`: schema and functions go in a new migration; records go in `supabase/seed`. Never edit an applied migration.
- Taxonomies become reference lists in seed.
- Compliance: express each prototype rule through `compliance.rules`, `rule_thresholds` and `rule_scope_assignments` as the mapping says. Rules are interpreted only by `compliance.evaluate_rule`; capacity only by `compliance-capacity.ts`. Do not write a second evaluator.
- Calculations live in one home each, as named under Calculations in `build.md`, never inside the surface.
- No code names a client, rule or entity by its code: put the difference in data.
- Run `npm run guard`, `npm run guard:db` and `npm run test:db`.

### 2. Surface pull request

- Copy `surfaces/fund-index` to `surfaces/ocio/`, set the manifest code to `ocio`, and register it in `apps/web/lib/surface-registry.ts`.
- Import only React, `@tapestrai/surface-sdk`, `@tapestrai/ui` and the surface's own files. Read and write through `useSurfaceHost()`.
- Build each tab from its file in `views/`: keep the layout and the house classes, and replace the sample figures with data bound to the attributes named in `data-attr`.
- Publish every tab to the assistant (`label`, `purpose`, `data`, and `howToRead` where needed), with the user's As Of and Knowledge dates applied.
- Meet every standard listed in `build.md`, then run `npm run guard` and the web tests.

If something in the blueprint is marked assumed, or the views and the blueprint disagree, ask before building it.
