-- Migration: Narrative framework v2
-- Description: Sectioned, evidence-backed narratives that can be offered on several
-- entity types and composed either by the app or by an external chat client over MCP.
--
--   narrative_templates   + sections, persona, audience, rules, exposed_domains,
--                           allow_external_search. The v1 columns (instructions,
--                           data_queries, output_blocks) stay: a template with no
--                           sections still runs as a single section.
--   narrative_runs        + RUNNING / PARTIAL status, as-of date, sources, verification,
--                           origin (APP or MCP), and an UPDATE grant so a run can be
--                           filled in section by section.
--   narrative_run_sections  one row per section of a run: blocks, the evidence the
--                           section was composed from, research notes, verification.
--
-- Tenancy is unchanged: a run is visible to its creator, tenant admins, and anyone who
-- can read the entity it is about. Section rows follow the run.

-- ============================================================
-- 1. narrative_templates
-- ============================================================
ALTER TABLE public.narrative_templates
    ADD COLUMN IF NOT EXISTS sections JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS persona TEXT,
    ADD COLUMN IF NOT EXISTS audience VARCHAR(200),
    ADD COLUMN IF NOT EXISTS rules JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS exposed_domains TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS allow_external_search BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_narrative_templates_exposed ON public.narrative_templates USING GIN (exposed_domains);

COMMENT ON COLUMN public.narrative_templates.sections IS
    'Ordered sections: { key, title, purpose, instructions, dataQueries, comparisons, measures, screens, scenarios, blocks, agentic, research, dependsOn, batch }. Empty = single-section template built from instructions / data_queries / output_blocks.';
COMMENT ON COLUMN public.narrative_templates.rules IS 'Extra rules every section must follow, in addition to the framework defaults.';
COMMENT ON COLUMN public.narrative_templates.exposed_domains IS 'Entity types, besides domain_code, whose record pages offer this narrative.';
COMMENT ON COLUMN public.narrative_templates.allow_external_search IS 'When false no section may search the web, so portfolio names are never sent to a search provider.';

-- ============================================================
-- 2. narrative_runs
-- ============================================================
ALTER TABLE public.narrative_runs DROP CONSTRAINT IF EXISTS narrative_runs_status_check;
ALTER TABLE public.narrative_runs
    ADD CONSTRAINT narrative_runs_status_check
    CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'));

ALTER TABLE public.narrative_runs
    ADD COLUMN IF NOT EXISTS as_of_date DATE,
    ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS verification JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS plan JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'APP' CHECK (origin IN ('APP', 'MCP')),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.narrative_runs ALTER COLUMN created_by SET DEFAULT auth.uid();

DROP POLICY IF EXISTS "Narrative runs updatable by creator" ON public.narrative_runs;
CREATE POLICY "Narrative runs updatable by creator" ON public.narrative_runs
    FOR UPDATE TO authenticated
    USING (created_by = auth.uid())
    WITH CHECK (created_by = auth.uid());

GRANT UPDATE ON public.narrative_runs TO authenticated;

-- ============================================================
-- 3. narrative_run_sections
-- ============================================================
CREATE TABLE IF NOT EXISTS public.narrative_run_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES public.narrative_runs(id) ON DELETE CASCADE,
    section_key VARCHAR(100) NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0,
    title VARCHAR(300),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
    blocks JSONB NOT NULL DEFAULT '[]',
    -- The evidence the section was composed from. Kept so a later save can be verified
    -- against it, and so a reader can see what the numbers came from.
    evidence JSONB NOT NULL DEFAULT '{}',
    research JSONB NOT NULL DEFAULT '{}',
    verification JSONB NOT NULL DEFAULT '{}',
    notes JSONB NOT NULL DEFAULT '[]',
    error_message TEXT,
    model VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, section_key)
);

CREATE INDEX IF NOT EXISTS idx_narrative_run_sections_run ON public.narrative_run_sections(run_id, ord);

COMMENT ON TABLE public.narrative_run_sections IS 'One row per section of a narrative run: composed blocks, source evidence, research, and verification.';

ALTER TABLE public.narrative_run_sections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Run sections readable with the run" ON public.narrative_run_sections;
CREATE POLICY "Run sections readable with the run" ON public.narrative_run_sections
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.narrative_runs r WHERE r.id = run_id));

DROP POLICY IF EXISTS "Run sections insertable by run creator" ON public.narrative_run_sections;
CREATE POLICY "Run sections insertable by run creator" ON public.narrative_run_sections
    FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM public.narrative_runs r WHERE r.id = run_id AND r.created_by = auth.uid()));

DROP POLICY IF EXISTS "Run sections updatable by run creator" ON public.narrative_run_sections;
CREATE POLICY "Run sections updatable by run creator" ON public.narrative_run_sections
    FOR UPDATE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.narrative_runs r WHERE r.id = run_id AND r.created_by = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.narrative_runs r WHERE r.id = run_id AND r.created_by = auth.uid()));

DROP POLICY IF EXISTS "Run sections deletable by admins" ON public.narrative_run_sections;
CREATE POLICY "Run sections deletable by admins" ON public.narrative_run_sections
    FOR DELETE TO authenticated USING (tenancy.is_tenant_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.narrative_run_sections TO authenticated;

-- ============================================================
-- 4. Starter: LP portfolio review for a fund
-- ============================================================
-- Queries use only the relationship and attribute codes the platform documents for
-- positions, securities and issuers. Everything else (NAV history, covenants, financials,
-- ratings, compliance) is discovered by the section's tools at run time, so the template
-- works on whatever the fund actually has and says "data not available" for the rest.
INSERT INTO public.narrative_templates (
    narrative_code, narrative_name, description, domain_code, exposed_domains,
    persona, audience, rules, allow_external_search, parameters, sections
)
SELECT
    'FUND_LP_PORTFOLIO_REVIEW',
    'LP Portfolio Review',
    'Candid, evidence-backed portfolio review for a Portfolio Manager meeting a prospective LP: evolution, attribution, borrower credit review, risk call-outs, industry sentiment, compliance and liquidity, outlook, and LP Q&A prep.',
    'FUND',
    ARRAY['FUND']::text[],
    'You are a senior private credit portfolio analyst preparing the Portfolio Manager for a meeting with a prospective Limited Partner. Write in the PM''s voice: confident, specific, and transparent about risk. Sophisticated LPs trust managers who name problems before being asked.',
    'Portfolio Manager, for use with a prospective Limited Partner',
    $r$[
      "Show metrics as of the report as-of date, with comparisons at inception, one year ago, and last quarter wherever the data supports them.",
      "Cite external sources (news, ratings actions, industry reports) with their dates. If web research is not enabled, say that sentiment was not researched rather than writing it from memory.",
      "Be honest about weaknesses and pair each with a mitigant or an action.",
      "Prefer tables and scorecards for exposures and borrowers, and prose for the story. Suggest charts where useful: NAV bridge (waterfall), composition over time (stacked), covenant headroom (heatmap), risk-rating migration.",
      "If a metric the prompt asks for has no data, write 'data not available' in its place and list it under what is missing."
    ]$r$::jsonb,
    FALSE,
    $p$[
      {"name":"inceptionDate","label":"Fund inception date","type":"date"},
      {"name":"lpName","label":"Prospective LP (optional)","type":"text"}
    ]$p$::jsonb,
    $s$[
      {
        "key":"exec_summary","title":"Executive Summary",
        "purpose":"What is the two-minute pitch?",
        "instructions":"Write the one-page pitch from the other sections already written. Give the strategy in one sentence only if the data states it (otherwise data not available), then vintage, committed versus deployed capital, and headline performance: net IRR, net MOIC, DPI, TVPI, current yield, and the comparison with relevant benchmarks only where a benchmark figure was supplied or researched. Then up to three things going well, two things we are watching, and one forward-looking view, listing only items the earlier sections evidence. Every figure must come from the earlier sections.",
        "dependsOn":["evolution","attribution","borrowers","risk_callouts","industry","compliance_liquidity","outlook"],
        "dataQueries":[{"key":"fund","label":"The fund","start":"CONTEXT","limit":1}],
        "blocks":[
          {"type":"kpis","key":"headline","title":"Headline performance","guidance":"Net IRR, net MOIC, DPI, TVPI, current yield, NAV, committed and deployed. Use 'data not available' as the value when missing."},
          {"type":"markdown","key":"pitch","title":"The pitch","guidance":"Strategy in one sentence, then the story in under 250 words."},
          {"type":"insights","key":"summary_points","title":"Going well, watching, outlook","guidance":"Three positive, two warning, one info."}
        ]
      },
      {
        "key":"evolution","title":"Portfolio Evolution Over Time",
        "purpose":"How has the portfolio changed, and was each shift a choice or a market outcome?",
        "instructions":"Show NAV progression and its drivers (deployment, income, realizations, unrealized marks), and how composition shifted: industry mix, seniority (1L, unitranche, 2L, junior), sponsor versus non-sponsor, fixed versus floating, deal size, geography, and top-10 concentration. Show movement in weighted-average spread, leverage, interest coverage, and LTV across vintages of deployment. For every shift say whether it looks like a deliberate strategy choice or a market outcome and explain why, using only what the data supports. Use get_model_map and the other tools to find NAV statements, seniority, spread and leverage fields; do not guess codes.",
        "agentic":{"enabled":true,"maxRounds":10},
        "comparisons":[{"label":"Current"},{"label":"Last quarter","offset":{"months":3}},{"label":"1 year ago","offset":{"years":1}},{"label":"Inception","param":"inceptionDate"}],
        "dataQueries":[
          {"key":"exposure_by_industry","label":"Exposure by industry","start":"CONTEXT","path":[{"direction":"DOWN","relationshipCode":"POSITION_FUND","domainCode":"POSITION"}],"lookups":[{"alias":"sec","direction":"UP","relationshipCode":"POSITION_SECURITY","domainCode":"SECURITY","label":"Security"},{"alias":"iss","from":"sec","direction":"UP","relationshipCode":"SECURITY_ISSUER","domainCode":"ISSUER","label":"Issuer"}],"groupBy":["iss.INDUSTRY"],"metrics":[{"alias":"exposure","agg":"SUM","field":"MARKET_VALUE"},{"alias":"positions","agg":"COUNT"}],"orderBy":[{"field":"exposure","dir":"desc"}],"limit":50}
        ],
        "blocks":[
          {"type":"markdown","key":"lead","title":"What changed","guidance":"Lead with the single most important shift and why."},
          {"type":"chart","key":"nav_bridge","title":"NAV bridge","guidance":"Waterfall of NAV from the earlier date to the as-of date by driver. Only if the drivers are in the data."},
          {"type":"chart","key":"composition","title":"Industry mix over time","guidance":"Stacked bar, one bar per comparison date, series are industries."},
          {"type":"table","key":"shifts","title":"Composition and credit metrics by date","guidance":"Rows are metrics, columns are the comparison dates."}
        ]
      },
      {
        "key":"attribution","title":"Performance Attribution",
        "purpose":"Where did the return come from, and what has been lost?",
        "instructions":"Break the return into contractual income, fees and OID, realized gains and losses, and unrealized gains and losses. Attribute by industry, by borrower (top 5 contributors and bottom 5 detractors), and by vintage. Build the gross-to-net bridge (management fee, carry, fund expenses). Give loss history: realized losses, recovery rates, and non-accruals as a percent of cost and of fair value. Use the tools to find these figures. Where an attribution cannot be computed from the data, say so; do not allocate by judgment.",
        "agentic":{"enabled":true,"maxRounds":10},
        "dataQueries":[],
        "blocks":[
          {"type":"markdown","key":"lead","title":"Where the return came from"},
          {"type":"chart","key":"gross_to_net","title":"Gross-to-net bridge","guidance":"Waterfall: gross return, fee, carry, expenses, net."},
          {"type":"table","key":"by_industry","title":"Attribution by industry"},
          {"type":"table","key":"contributors","title":"Top 5 contributors and bottom 5 detractors"},
          {"type":"kpis","key":"losses","title":"Loss history","guidance":"Realized losses, recovery rate, non-accrual percent of cost, non-accrual percent of fair value."}
        ]
      },
      {
        "key":"borrowers","title":"Borrower-by-Borrower Credit Review",
        "purpose":"How is each borrower performing against underwriting?",
        "instructions":"For each borrower in this group give one scorecard row and a 2-3 sentence view. Columns: Company, Website, Industry, Sponsor, Position size (% of NAV), Seniority, Spread/coupon, Maturity, LTM revenue and EBITDA trend (vs underwriting and prior year), Total and senior leverage, Interest coverage, Liquidity runway, Covenant headroom (% cushion on each test), Amendments / waivers / PIK, Internal risk rating and its change since last quarter, Status. Status is exactly one of Performing, Watchlist, Underperforming, Non-accrual, and only when a status, rating, or non-accrual field was found for the borrower; otherwise write data not available. Never default to Performing. Use the tools to find each borrower's financials, covenants and ratings; write 'data not available' for any field you cannot find. Do not rank here; a later section ranks the whole book. Position size is the borrower's exposure_share (its share of total position exposure); label it that way unless a NAV figure was found. Never total, average, or divide figures yourself; quote the values given.",
        "agentic":{"enabled":true,"maxRounds":10},
        "research":{"queries":["Recent news, ratings actions, litigation, or management changes for these companies: {{names}}"],"maxSources":8},
        "batch":{"query":"exposure_by_issuer","size":10},
        "dataQueries":[
          {"key":"exposure_by_issuer","label":"Exposure by borrower","start":"CONTEXT","path":[{"direction":"DOWN","relationshipCode":"POSITION_FUND","domainCode":"POSITION"}],"lookups":[{"alias":"sec","direction":"UP","relationshipCode":"POSITION_SECURITY","domainCode":"SECURITY","label":"Security"},{"alias":"iss","from":"sec","direction":"UP","relationshipCode":"SECURITY_ISSUER","domainCode":"ISSUER","label":"Issuer"}],"groupBy":["iss.entity_name"],"metrics":[{"alias":"exposure","agg":"SUM","field":"MARKET_VALUE"},{"alias":"positions","agg":"COUNT"}],"orderBy":[{"field":"exposure","dir":"desc"}],"limit":500}
        ],
        "blocks":[
          {"type":"scorecard","key":"scorecard","title":"Borrower scorecard","statusColumn":"Status","guidance":"One row per borrower in this group, with the columns named in the instructions."},
          {"type":"markdown","key":"views","title":"Our view","guidance":"A bold borrower name then 2-3 sentences per borrower."}
        ]
      },
      {
        "key":"credit_ranking","title":"Credit Ranking",
        "purpose":"Which names are strongest and which are weakest?",
        "instructions":"Rank the full book from strongest to weakest credit using only the scorecards already written. State the basis for the ranking (the metrics that drove it) and keep it consistent. Do not add borrowers or figures that are not in the scorecards.",
        "dependsOn":["borrowers"],
        "dataQueries":[],
        "blocks":[
          {"type":"table","key":"ranking","title":"Strongest to weakest","guidance":"Columns: Rank, Borrower, Status, Position size (% of NAV), Reason."}
        ]
      },
      {
        "key":"risk_callouts","title":"Risk Call-Outs",
        "purpose":"What would a skeptical LP find, and have we named it first?",
        "instructions":"Flag every borrower or exposure meeting any of: covenant cushion under 15%, or a covenant breach or waiver in the last 12 months; interest coverage below 1.5x, or leverage up more than 1.0x since close; EBITDA down more than 10% versus underwriting, or add-backs above 25% of EBITDA; interest moved to PIK, a rating downgrade, or a mark below 90; a single name above 5% of NAV, or an industry above 20%; negative news, litigation, management turnover, or a sponsor under stress. Use the analyze_rows tool to apply these thresholds to the full book so the flags are computed, not judged. For each flag give: what happened, severity (High/Med/Low), our action plan, downside recovery estimate if available, and how the PM should frame it to an LP.",
        "dependsOn":["borrowers","credit_ranking"],
        "agentic":{"enabled":true,"maxRounds":12},
        "research":{"queries":["Negative news, litigation, management turnover, or sponsor stress at the portfolio companies flagged as at risk for {{entity_name}}"],"maxSources":8},
        "dataQueries":[],
        "blocks":[
          {"type":"callouts","key":"flags","title":"Flagged exposures","guidance":"Fields: What happened; Severity rule met; Action plan; Downside recovery; How to frame it to an LP."},
          {"type":"chart","key":"headroom","title":"Covenant headroom","guidance":"Heatmap: rows are borrowers, columns are covenant tests, values are % cushion. Only if the data exists."}
        ]
      },
      {
        "key":"industry","title":"Industry Exposure and Market Sentiment",
        "purpose":"Which sectors help and which hurt, and are our borrowers keeping up?",
        "instructions":"For each industry over 5% of NAV give the fund's exposure and the performance of those positions. Give current market sentiment from the dated research notes only: demand trends, margin pressure, rate sensitivity, regulatory risk, AI or technology disruption, tariff or supply-chain exposure, default trends. Give a verdict of Tailwind, Neutral, or Headwind, say whether our borrowers are outperforming or lagging their sector, and where we are overweight or underweight versus the broader direct lending market and why. If research is not available, give exposure and performance and mark sentiment as not researched.",
        "dependsOn":["evolution"],
        "agentic":{"enabled":true,"maxRounds":8},
        "research":{"queries":["Current market conditions, default trends, and outlook for direct lending borrowers in these industries: {{industries}}"],"maxSources":10},
        "dataQueries":[
          {"key":"exposure_by_industry","label":"Exposure by industry","start":"CONTEXT","path":[{"direction":"DOWN","relationshipCode":"POSITION_FUND","domainCode":"POSITION"}],"lookups":[{"alias":"sec","direction":"UP","relationshipCode":"POSITION_SECURITY","domainCode":"SECURITY","label":"Security"},{"alias":"iss","from":"sec","direction":"UP","relationshipCode":"SECURITY_ISSUER","domainCode":"ISSUER","label":"Issuer"}],"groupBy":["iss.INDUSTRY"],"metrics":[{"alias":"exposure","agg":"SUM","field":"MARKET_VALUE"},{"alias":"positions","agg":"COUNT"}],"orderBy":[{"field":"exposure","dir":"desc"}],"limit":50}
        ],
        "blocks":[
          {"type":"table","key":"industry_table","title":"Industries over 5% of NAV","guidance":"Columns: Industry, Exposure, % of NAV, Position performance, Sentiment verdict, Us vs sector, Over/underweight vs market."},
          {"type":"markdown","key":"sentiment","title":"Sentiment by industry","guidance":"One short paragraph per industry, every claim with its source and date."},
          {"type":"sources","key":"sources","title":"Sources"}
        ]
      },
      {
        "key":"compliance_liquidity","title":"Fund Compliance and Liquidity",
        "purpose":"Is the fund inside every limit, and can it meet its obligations under stress?",
        "instructions":"Give status against every LPA and credit facility limit (concentration, leverage, eligible assets, borrowing base) with headroom. Give cash, undrawn facility capacity, unfunded commitments to borrowers, and expected capital calls and distributions over the next 12 months. Run the liquidity stress test: can the fund meet its obligations if the 2 largest borrowers stop paying interest? Use list_compliance_rules and evaluate_compliance_rule for the as-of date to get limit status, and analyze_rows for the stress test so the result is computed. If a limit has no rule, say it is not monitored.",
        "agentic":{"enabled":true,"maxRounds":12},
        "dataQueries":[],
        "blocks":[
          {"type":"table","key":"limits","title":"Status against limits","guidance":"Columns: Limit, Source (LPA or facility), Current, Limit, Headroom, Status."},
          {"type":"kpis","key":"liquidity","title":"Liquidity position","guidance":"Cash, undrawn capacity, unfunded borrower commitments, 12-month calls, 12-month distributions."},
          {"type":"markdown","key":"stress","title":"Stress test: two largest borrowers stop paying","guidance":"State the assumption, the computed result, and whether obligations are met."}
        ]
      },
      {
        "key":"outlook","title":"Forward Outlook",
        "purpose":"What does the next 12 months look like, and are we positioned for it?",
        "instructions":"Give the expected maturity and repayment profile. Give the effect of +100bps and -100bps rate scenarios on portfolio income, computed with analyze_rows from floating-rate positions, their spreads, floors, and balances; state the assumptions. Give the pipeline and where the best relative value is now, only if pipeline data exists. Give the key risks for the next 12 months and how we are positioned for them.",
        "dependsOn":["risk_callouts","industry","compliance_liquidity"],
        "agentic":{"enabled":true,"maxRounds":10},
        "dataQueries":[],
        "blocks":[
          {"type":"chart","key":"repayment","title":"Maturity and repayment profile","guidance":"Bar by year."},
          {"type":"table","key":"rates","title":"Rate scenarios","guidance":"Columns: Scenario, Annual income, Change vs base."},
          {"type":"markdown","key":"view","title":"Where we see value and what we are watching"}
        ]
      },
      {
        "key":"lp_qa","title":"LP Q&A Prep",
        "purpose":"What are the ten toughest questions, and what is the data-backed answer to each?",
        "instructions":"List the 10 toughest questions a skeptical LP is likely to ask about this portfolio, each with a concise, data-backed answer drawn from the sections already written. Pick the questions the data makes unavoidable (the weakest credits, concentration, marks, PIK, fees versus returns, liquidity). Do not answer with figures that are not in the earlier sections.",
        "dependsOn":["evolution","attribution","borrowers","credit_ranking","risk_callouts","industry","compliance_liquidity","outlook"],
        "dataQueries":[],
        "blocks":[
          {"type":"callouts","key":"questions","title":"Ten toughest questions","guidance":"Ten items. title is the question, fields hold Answer and Evidence."}
        ]
      }
    ]$s$::jsonb
WHERE EXISTS (SELECT 1 FROM metadata_register.domain_types WHERE domain_code = 'FUND')
ON CONFLICT (narrative_code) DO NOTHING;

NOTIFY pgrst, 'reload schema';
