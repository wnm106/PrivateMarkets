# Narratives (v2)

A narrative is a sectioned, evidence-backed report attached to one or more entity types. The same definition is run by the app and handed to external chat clients over MCP, so a report reads alike whoever composes it.

## What a narrative is

`narrative_templates` holds: `persona`, `audience`, `rules`, `parameters`, `exposed_domains`, `allow_external_search`, and ordered `sections`. A template with no sections still runs as one section built from `instructions`, `data_queries` and `output_blocks` (the v1 form).

A **section** has:

| Field | Purpose |
|---|---|
| `key`, `title`, `purpose` | Identity, and the question the section leads with |
| `instructions` | What to analyse. Names the query keys it may cite |
| `dataQueries` | Declared data (same spec as dashboards) |
| `comparisons` | Re-run every query at other as-of dates: `{label, offset:{years,quarters,months,days}}` or `{label, param}` for an input such as an inception date. At most 13 (a monthly series over a year); validation rejects more |
| `measures` | Derived columns per row: `{query, alias, expr}` |
| `screens` | Thresholds applied to every row, computed not judged: `{key, label, query, when, severity}` |
| `scenarios` | What-ifs aggregated across rows: `{key, label, query, expr, agg, params, rankBy, top}` (rate shock, "two largest stop paying") |
| `blocks` | Expected output: markdown, kpis, table, scorecard, chart (bar, line, pie, stacked, waterfall, heatmap), insights, callouts, sources |
| `agentic` | `{enabled, maxRounds}`: lets the section call read-only tools for what the queries cannot reach |
| `research` | `{queries, maxSources}`: web research. Runs only when the narrative sets `allow_external_search` |
| `dependsOn` | Sections written first. An executive summary depends on all the others; it is shown first and written last |
| `batch` | `{query, size}`: compose a long list a group at a time, then stitch (borrower-by-borrower) |

Expressions (`expr`, `when`) are arithmetic, comparisons, `&& || !`, and `abs min max round coalesce if isnull`. There is no `eval`. A missing input makes a measure null and a test not evaluable; the run counts those and the composer reports them as "data not available".

### Rules every section follows
Only use supplied figures; write "data not available" for gaps; state as-of dates; lead with the insight; pair weaknesses with actions; cite external claims with dates; quote computed screens and scenarios exactly. Add more per narrative in `rules`. The defaults live in `packages/graphql/src/lib/narrative-spec.ts` (`DEFAULT_RULES`).

## Exposing a narrative on entity types
`domain_code` is the primary type. `exposed_domains` adds more. The `narratives(domainCode)` query returns a template for its own type and every exposed type, so `EntityReports` shows it on each record page and runs it against the record being viewed. Queries start at that record (`start: CONTEXT`), so write them to make sense on every type you tick. Set it in the designer (Details tab) or with the MCP tool `assign_narrative_entity_types`.

## How the app runs one
`POST /api/narratives/run` with an `action`:

1. `start` creates a `narrative_runs` row (status RUNNING) and one `narrative_run_sections` row per section.
2. `section` composes one section, or one batch of it: evidence, optional web research, a bounded read-only tool loop, JSON blocks, then verification. A saved run stores each section as it completes.
3. `finish` assembles the sections into the run (COMPLETED, or PARTIAL if some failed).

The browser drives the loop, so each request is short, progress is visible, and one failed section leaves the rest intact. Any section can be re-run on its own.

**Verification.** Every figure in a section's blocks is traced to the evidence, tool results, earlier sections, or the brief. Figures that cannot be traced are listed on the section and in the run. This is advisory: derived arithmetic the model did itself will not trace, which is the point.

**Web research** sends company and industry names to a search provider, so it is off unless the narrative allows it. When off, sections say sentiment was not researched.

## How an external chat client runs one (MCP)
The server sends `SERVER_INSTRUCTIONS` on connect and serves the full method as `tapestrai://model/narrative-guide`. Prompts `compose_narrative` and `portfolio_review` start it in one step.

| Tool | Use |
|---|---|
| `list_narratives`, `get_narrative` | Find the saved narrative for a record's type; read the blueprint, rules, run order |
| `start_narrative_run` | Begin a stored run for a record and as-of date |
| `run_narrative_section_data` | Evidence for one section (and one batch): queries at every comparison date, measures, computed screens and scenarios, `mustDisclose` |
| `save_narrative_section` | Store the composed blocks; returns figures it could not trace |
| `finish_narrative_run` | Assemble the report; returns markdown, gaps, sources |
| `analyze_rows` | Whole-book analysis for any query: derived measures, screens, scenarios, coverage |
| `compare_asof` | One query at several dates, with change from the first |
| `get_data_coverage` | Which fields are defined and how many records have a value |
| `validate_narrative`, `save_narrative`, `assign_narrative_entity_types` | Design (tenant admin) |

When no narrative fits, the client plans sections that mirror the request, gathers evidence with `get_model_map`, `query_data`, `analyze_rows` and `compare_asof`, and may offer to save the plan.

Runs composed over MCP are stored (`origin = MCP`) and appear on the record page.

The MCP server runs as one signed-in user: set `TAPESTRAI_MCP_ACCESS_TOKEN` (see `docs/API.md`). Saving a narrative needs the tenant-admin role.

## Sharing runs
A run takes minutes and costs model spend, so a finished run is the shared report for its record, not a private result. Migration `20261113150000_narrative_run_sharing.sql` adds this.

- **Who can see a run.** The person who made it, tenant admins, and anyone who can read the record it is about. This is row-level security on `narrative_runs`; sections follow their run.
- **What a reader opens.** The record page lists finished runs (COMPLETED or PARTIAL) and opens, in order: the published run for the selected as-of date, the newest run for that date, then, only if none matches, the published or newest run on another date, with a warning that the date differs (`chooseRun` in `apps/web/lib/narrative-runs.ts`). A run that is RUNNING or FAILED is never opened by default.
- **Banner.** "Run by <name> <age> · as of <date>", plus a warning when the date differs from the one selected or the report is a week or more old. The name comes from the caller's session, set by a database trigger, so reports composed over MCP carry one too.
- **Run again** asks for confirmation when a finished report for the date already exists, and shows who made it and when.
- **Publish.** Anyone who can read the record can publish a finished run, optionally naming the version. One run per narrative and record is published at a time; publishing another replaces it. Publishing and unpublishing go through the database functions `publish_narrative_run` and `unpublish_narrative_run`, which check the caller may read the record and change only the publish fields.
- **History.** A picker lists earlier finished runs with who, when and as-of date; the published one is starred.
- **Stuck runs.** A run's clock moves forward each time a section starts or finishes. A RUNNING run that has not moved for 30 minutes is closed as abandoned (`close_stale_narrative_runs`), when a run starts and when runs are listed, so a closed tab never leaves a "latest" report behind.
- **External assistants.** `list_narrative_runs` shows finished runs with age, author, and whether each matches the wanted as-of date, with a suggestion; `get_narrative_run` returns the assembled report, section status, verification and data gaps; `publish_narrative_run` publishes on request. The guide and server instructions tell an assistant to look for an existing report before it starts a run.

## Consistency review
The figure check traces numbers. It cannot see a claim that is wrong without containing a number: a strategy nobody recorded, a status nobody assigned, an action described as underway, one section saying data is unavailable while another quotes it, or a value read from a different record that happens to share a name. A review step looks for those (`packages/graphql/src/lib/narrative-review.ts`).

- **When.** Automatically after a run finishes, and on demand ("Check consistency" / "Review again"). The result is stored with the run (`narrative_runs.verification.review`), so everyone who opens the report sees it. Re-running a section finishes the run again, which clears the review: it applies to the text that was reviewed.
- **How.** A reviewer model is given each finished section's text, its recorded data notes, and what its tool gathering found. It works in two steps: list every "absent / unavailable / none" claim, then look through every other section, tables included, for a value of the same thing. It returns issues of six kinds: contradiction, gap-vs-figure, unsupported, record-mixup, stated-as-fact, other.
- **Every issue is anchored.** The reviewer must quote the exact words. Issues whose quote cannot be found in the report (ignoring markdown and punctuation) are discarded and counted, so every issue shown can be located in the text.
- **Acting on it.** Each issue lists the sections it touches, with a **Fix** button. Fix writes that section again with the reviewer's problems attached as instructions it must address. A fix that needs a figure from another section the writer cannot see will surface as an untraced figure; the figure check still applies.
- **Limits.** A review is a second opinion, not proof. It misses things (recall varies from pass to pass; a second pass found issues the first did not), and it can suggest the wrong side of a contradiction, because it cannot know which side the data supports. A person decides.
- **External assistants.** `get_review_brief` returns the same instructions and section digests; the assistant reviews the report itself and stores the result with `save_run_review`, which applies the same quote check.

### Records that share a name
A name is not an identifier. In the test data, 95 issuer names are held by two records each: the seeded issuer the positions link to, and a second record created by a position-file import whose code is the name. Industry values sat on the second record, so a lookup by name attached the wrong record's industry to a borrower. Guards: `list_entities` now warns when a page holds records with the same name; tool warnings are kept in the section's data notes so a reviewer sees them; and the rules tell writers to match records by id or relationship, never by name. The duplicates themselves are a data-quality matter (entity resolution), not something a narrative can fix.

Not built yet: a data-change fingerprint (a report is flagged stale by age and date only), per-run cost tracking, and pruning of old evidence.

## Seeded narrative
`FUND_LP_PORTFOLIO_REVIEW` was first seeded by `20261113140000_narrative_framework.sql` and redesigned for presenting to an investor by `20261121160000_lp_review_investor_redesign.sql` (the current definition, tested by `narrative-seed.test.ts`). It reads in the order an allocator reads:

1. **Fund at a glance**: KPI cards, a 150-word story, three strengths and two watch items. Written last, from the other sections.
2. **NAV track record**: the fund's own NAV and gross asset value at 13 monthly dates, the reconciliation of positions to NAV, and gross asset value to NAV as a reading of fund-level borrowing.
3. **Returns and income**: net and gross IRR from the fund; TVPI, DPI, income yield, distribution coverage and expense ratio as measures on the fund's quarterly NAV statement (`STATEMENT_FUND`, five quarters); a 12-month NAV bridge from the inception-to-date roll-forward.
4. **What drove NAV**: an industry bridge (waterfall) over 12 months and the largest moves by borrower, from `compare_asof`.
5. **Portfolio composition**: industry mix now, a quarter ago and a year ago, with computed concentration screens.
6. **Concentration and downside**: computed top-N shares, a Herfindahl index (effective number of borrowers), and stress cases (largest name written off; two and five largest lose half).
7. **Loan book**: lien, rate type, PIK and cov-lite mix; spread, coupon and mark weighted by marked value in the query (`WEIGHTED_AVG`); a maturity ladder and rate sensitivity as scenarios.
8. **Borrower credit quality**: weighted leverage and coverage now and a year ago, rating mix, non-accrual at fair value and cost, and a watchlist. A borrower's status is a measure (coverage under 1.5x, leverage over 6.5x or a mark under 90 is Watchlist), not the model's call. The PM's own view of a name comes only from the `watchlistNotes` input.
9. **Limits and liquidity**: undrawn commitments and credit line against unfunded borrower commitments, and every fund rule evaluated at the as-of date, tightest headroom first.
10. **Anticipated LP questions**: six to eight, answered from the sections above. Never about data or systems.
11. **Appendix: data room readiness (internal)**: the only place gaps are discussed, with what to load next.

Design choices that matter: industry is read from the security (`sec.INDUSTRY`), where it is stored, not the issuer. Concentration, stress, weighted averages and borrower status are query metrics, measures, scenarios and screens, so they are computed, not judged; only `drivers`, `limits` and the appendix use tools.

Test data: `supabase/seed/bench_fund4_lp_story.sql` back-fills Bench Fund 4 (fund terms and IRR, five quarterly NAV statements that reconcile to its NAV series, loan terms, borrower financials a year ago and now, marks, a watchlist and one non-accrual) so every section has something to show. It is deterministic and re-runnable, and tags its rows `metadata.backfill = 'lp_story'`. It stamps `golden_source_id` on its own rows: the insert trigger only resolves a winner among open-ended rows, so dated history written directly into the golden master is otherwise invisible to grids. Gaps are left out of cards, tables and charts (one "Not shown" line per section at most) and listed once in the appendix. A change in NAV is never called a return unless flows, income and fees are in the evidence. Money is shown in $M and shares in percent units, because the renderer prints numbers as given.

## Files
- `packages/graphql/src/lib/narrative-spec.ts`: spec types, expression evaluator, screens, scenarios, block normalization, verification, export. Pure; safe in the browser.
- `packages/graphql/src/lib/narrative-engine.ts`: evidence gathering against the database as the caller.
- `packages/mcp-server/src/tools/narrative-tools.ts`, `src/lib/narrative-guide.ts`: MCP tools, guide, server instructions, prompts.
- `apps/web/lib/narrative-runner.ts`, `app/api/narratives/run/route.ts`: the app's runner.
- `apps/web/components/reporting/NarrativeRunner.tsx`, `NarrativeBlocks.tsx`: run UI and block renderers.
