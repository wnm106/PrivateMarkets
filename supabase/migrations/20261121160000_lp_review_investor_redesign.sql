-- Migration: LP Portfolio Review, redesigned for presenting to an investor
-- Description: Replaces the sections, persona, rules and inputs of FUND_LP_PORTFOLIO_REVIEW.
--
-- Why: the first runs read as a data-gap audit. Most of the text said "data not available",
-- gaps were repeated in every section and in the LP questions, industry was read from the
-- issuer (where it is not stored) instead of the security, NAV history on the fund was
-- never queried, and the credit ranking ranked by size. None of it could be shown to an LP.
--
-- The new design follows the arc an allocator reads in:
--    1. Fund at a glance          KPI cards, the story, strengths and watch items (written last)
--    2. NAV track record          13 monthly marks of NAV and gross asset value
--    3. Returns and income        IRR, TVPI/DPI, income yield, distribution coverage, NAV bridge
--    4. What drove NAV            industry bridge (waterfall) and the largest movers
--    5. Portfolio composition     industry mix now vs a quarter and a year ago, computed screens
--    6. Concentration & downside  computed top-N shares, effective number of names, stress cases
--    7. Loan book                 lien and rate mix, weighted spread and coupon, maturities, rates
--    8. Borrower credit quality   weighted leverage and coverage, ratings, non-accrual, watchlist
--    9. Limits and liquidity      every fund limit evaluated, liquidity against unfunded commitments
--   10. Anticipated LP questions  answered from the sections above
--   11. Appendix (internal)       every gap, once, with what to load for the data room
--
-- Figures are computed wherever the engine can: weighted averages in the queries, shares,
-- screens, scenarios and a deterministic borrower status as measures. The model writes the
-- story around them. Gaps are no longer written into cards, tables and charts; each section
-- leaves out what it cannot show and closes with at most one "Not shown" line, and the
-- appendix lists them all.

INSERT INTO public.narrative_templates (
    narrative_code, narrative_name, description, domain_code, exposed_domains,
    persona, audience, rules, allow_external_search, parameters, sections
)
VALUES (
    'FUND_LP_PORTFOLIO_REVIEW',
    'LP Portfolio Review',
    'Investor-ready portfolio review for a prospective LP: fund at a glance, NAV track record, returns and income, what drove NAV, composition, concentration and downside, loan book, borrower credit quality, limits and liquidity, anticipated LP questions, and an internal data-room appendix.',
    'FUND',
    ARRAY['FUND']::text[],
    'You are the head of investor relations at a private markets manager, writing with the Portfolio Manager. Write the way the best managers write to LPs: lead with the answer, show it in one chart or table, name the risk before the LP finds it, and never spend a page on something that does not inform an investment decision.',
    'A prospective Limited Partner (an institutional allocator) reviewing the fund. The Portfolio Manager presents this report or hands it over unedited.',
    $r$[
      "This report is handed to a prospective LP as written. Use the manager's voice (\"we\", \"our portfolio\"). Never mention attribute codes, field names, tools, queries, databases, 'system records', 'ingestion' or any other internal process, except in the Data Room Readiness appendix.",
      "Format numbers for an investor. In tables and charts, money is in $M with one decimal and the column header or series name says ($M); percentages are in percent units with one decimal (3.5, not 0.035) and the header says (%). In KPI cards write values like $1,164.6M, 3.5%, 1.29x, 545 bps. Never mix fractions and percents in one column. Dates are Mon-YY on chart axes (Nov-25) and 13 Nov 2026 in text. Reference-list codes are written as words: FIRST_LIEN is 'First lien', B_MINUS is 'B-', CCC_PLUS is 'CCC+'.",
      "Gaps, for this report: in every section except the Data Room Readiness appendix, leave out any KPI card, row, column or chart that has no data rather than writing 'data not available' in it. A section may close with one line in italics, 'Not shown: <items>.', and nothing more about gaps. A gap is never a headline, an insight, a risk, a strength or an LP question. This narrows the general rules on gaps; the appendix lists every gap once.",
      "A change in NAV or in marked value is not a return. Call something a return, income, gain or loss only when it comes from the fund's IRR, its NAV statements (income, realized and unrealized lines) or a measure built on them. A change in NAV alone is a change in NAV.",
      "You may compute a difference, a percent change, a share, or one figure divided by another from figures in the evidence or in earlier sections, and show the inputs beside the result so a reader can check. Sums across the book, weighted averages, rankings, top-N shares and threshold tests come from the supplied query metrics, measures, screens, scenarios and totals, or from compare_asof and analyze_rows.",
      "Each chart makes one point, and its title states that point as a finding with its figure, for example 'Software is our largest exposure at 31.0% of NAV', not a label such as 'Industry mix'. Order bars from largest to smallest unless the axis is time or a rating scale. Time runs oldest to newest, left to right.",
      "Pair every risk with the mitigant the data shows (granularity, seniority, no fund-level borrowing, headroom to a limit, distribution coverage, liquidity). Never invent a mitigant, a hedge, a workout, a restructuring, a sponsor action, a pipeline or a plan. Actions on specific borrowers come only from the watchlistNotes input, quoted as the Portfolio Manager's words.",
      "Describe the fund only from the data: its stated strategy, vintage, commitments, positions, borrowers and industries, and how they changed. Do not state a target return, team fact or market view that the evidence does not contain.",
      "A borrower's status (Performing, Watchlist, Non-accrual) comes only from the status measure and the non-accrual data supplied. Never assign one by judgment."
    ]$r$::jsonb,
    FALSE,
    $p$[
      {"name":"lpName","label":"Prospective LP (optional)","type":"text"},
      {"name":"watchlistNotes","label":"PM commentary on watchlist and non-accrual names (optional)","type":"text"},
      {"name":"inceptionDate","label":"Fund inception date, if not on the fund record (optional)","type":"date"}
    ]$p$::jsonb,
    $s$[
      {
        "key":"at_a_glance","title":"Fund at a Glance",
        "purpose":"What does an LP need to know in the first two minutes?",
        "instructions":"Write the opening page from the sections already written, using only their figures. If the lpName input is set, open the story with 'Prepared for <lpName>.' Cards, in this order, leaving out any that no earlier section gives: NAV; net IRR; TVPI; DPI; net investment income yield (annualised); NAV change over 12 months; first lien share; non-accrual share of fair value; borrowers; top 10 borrowers. The story is three short paragraphs, 150 words in all: what the fund is (strategy, vintage, size, breadth, seniority), how it has performed (return, income, what drove NAV), and what we are watching and why it is contained. Then three strengths and two watch items, each one sentence with its figure. A watch item is a real portfolio risk from the earlier sections (a concentration, a limit with little headroom, a watchlist or non-accrual borrower, a decline in marks), never a missing figure.",
        "dataQueries":[],
        "dependsOn":["nav_trend","returns","drivers","allocation","concentration","loan_book","credit","limits"],
        "blocks":[
          {"type":"kpis","key":"headline","title":"At a glance","guidance":"Up to 10 cards, formatted values. trend up or down only on cards that compare two dates; detail gives the comparison, e.g. 'vs 9.8% a year ago'."},
          {"type":"markdown","key":"story","title":"The story","guidance":"Three short paragraphs, 150 words in all. No headings, no bullet lists."},
          {"type":"insights","key":"points","title":"Strengths and what we are watching","guidance":"Exactly three positive, then two warning. Title is the point with its figure; detail is one sentence of evidence and, for a warning, its mitigant."}
        ]
      },
      {
        "key":"nav_trend","title":"NAV Track Record",
        "purpose":"How has NAV moved over the last 12 months, and how steady has it been?",
        "instructions":"Evidence holds fund_values (the fund's NAV and gross asset value) and book_total (the summed marked value and count of the fund's positions) at the as-of date and at each of the 12 prior months; the comparisons list gives each date. Show NAV month by month, oldest first. Give the change over 3 and 12 months in $M and %, and the 12-month high and low with their months. gav_to_nav is gross asset value divided by NAV at each date: quote its range; a value near 1.00x means no material fund-level borrowing is recorded, say exactly that and nothing stronger. Compare book_total exposure with NAV at the as-of date and say whether positions reconcile to NAV. Say whether the position count changed across the period. If a comparison date has no NAV, leave that month out. Returns and income are the next section's subject; do not discuss them here.",
        "comparisons":[
          {"label":"Current"},
          {"label":"1 month ago","offset":{"months":1}},
          {"label":"2 months ago","offset":{"months":2}},
          {"label":"3 months ago","offset":{"months":3}},
          {"label":"4 months ago","offset":{"months":4}},
          {"label":"5 months ago","offset":{"months":5}},
          {"label":"6 months ago","offset":{"months":6}},
          {"label":"7 months ago","offset":{"months":7}},
          {"label":"8 months ago","offset":{"months":8}},
          {"label":"9 months ago","offset":{"months":9}},
          {"label":"10 months ago","offset":{"months":10}},
          {"label":"11 months ago","offset":{"months":11}},
          {"label":"12 months ago","offset":{"months":12}}
        ],
        "dataQueries":[
          {"key":"fund_values","label":"Fund NAV and gross asset value","start":"CONTEXT","path":[],"includeAnchor":true,"select":["NAV","GROSS_ASSET_VALUE"],"limit":1},
          {"key":"book_total","label":"Marked value of the fund's positions","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"},{"agg":"COUNT","alias":"positions"}],
           "limit":1}
        ],
        "measures":[
          {"query":"fund_values","alias":"gav_to_nav","expr":"GROSS_ASSET_VALUE / NAV","label":"Gross asset value / NAV","unit":"multiple"}
        ],
        "blocks":[
          {"type":"kpis","key":"nav_kpis","title":"NAV","guidance":"NAV now; change over 3 months; change over 12 months; 12-month high; 12-month low; gross asset value / NAV."},
          {"type":"markdown","key":"lead","title":"What NAV did","guidance":"Three to five sentences: the 12-month move and range, whether it came from marks or from new and exited positions (position count), the reconciliation of positions to NAV, and the fund-level borrowing reading."},
          {"type":"chart","key":"nav_chart","guidance":"line. labels are Mon-YY, oldest first. Series 'NAV ($M)'; add 'Gross asset value ($M)' only where it has values at most dates. Title states the finding."},
          {"type":"table","key":"nav_table","title":"Monthly NAV","guidance":"Columns: Month, NAV ($M), Change vs prior month ($M), Gross asset value ($M), Positions. Oldest first."}
        ]
      },
      {
        "key":"returns","title":"Returns and Income",
        "purpose":"What has the fund earned for its investors, and is the income durable?",
        "instructions":"Evidence holds fund_terms (the fund's strategy, vintage, inception, commitments, undrawn commitments, net and gross IRR, and fee terms, with called_pct and fee_drag_pts as measures) and statement (the fund's quarterly NAV statement: changes in net assets for the quarter, the operations lines, and the inception-to-date roll-forward) at the as-of date and at each of the four prior quarters. Statement measures are computed and authoritative: tvpi, dpi and rvpi (multiples, from the inception-to-date roll-forward), nii_yield_pct (the quarter's net investment income annualised over beginning NAV), quarter_return_pct (net increase from operations over beginning NAV, not annualised), dist_coverage (net investment income over distributions) and expense_ratio_pct (annualised). Lead with net IRR, TVPI and DPI and how net IRR moved over the year. Then income: the yield, whether it covered distributions in each quarter, and the gap between income and total return (realized and unrealized). Build the 12-month NAV bridge from the inception-to-date roll-forward now and four quarters ago: each step is the difference of one line between the two dates (contributions, net investment income, distributions, realized, unrealized), from the ending NAV four quarters ago to the ending NAV now. Gross-to-net: gross IRR, fee drag and net IRR, with the fee terms. Do not call any figure a benchmark or peer comparison.",
        "comparisons":[
          {"label":"Current"},
          {"label":"1 quarter ago","offset":{"months":3}},
          {"label":"2 quarters ago","offset":{"months":6}},
          {"label":"3 quarters ago","offset":{"months":9}},
          {"label":"4 quarters ago","offset":{"months":12}}
        ],
        "dataQueries":[
          {"key":"fund_terms","label":"Fund terms and returns","start":"CONTEXT","path":[],"includeAnchor":true,
           "select":["FUND_STRATEGY","FUND_VINTAGE","INCEPTION_DATE","FUND_TOTAL_COMMITMENTS","FUND_UNDRAWN_COMMITMENTS","FUND_NET_IRR","FUND_GROSS_IRR","FUND_MGMT_FEE_PCT","FUND_CARRY_PCT","FUND_HURDLE_PCT"],"limit":1},
          {"key":"statement","label":"Quarterly NAV statement","start":"CONTEXT",
           "path":[{"direction":"UP","domainCode":"NAV_STATEMENT","relationshipCode":"STATEMENT_FUND"}],
           "select":["STATEMENT_PERIOD_LABEL","STATEMENT_PERIOD_END",
                     "NAV_CH_BEGINNING","NAV_CH_CONTRIBUTIONS","NAV_CH_DISTRIBUTIONS","NAV_CH_NET_INVESTMENT_INCOME","NAV_CH_REALIZED","NAV_CH_UNREALIZED","NAV_CH_NET_OPERATIONS","NAV_CH_ENDING",
                     "NAV_OP_TOTAL_INCOME","NAV_OP_PIK","NAV_OP_MGMT_FEE","NAV_OP_TOTAL_EXPENSES",
                     "NAV_RF_CONTRIBUTIONS","NAV_RF_DISTRIBUTIONS","NAV_RF_NET_INVESTMENT_INCOME","NAV_RF_REALIZED","NAV_RF_UNREALIZED","NAV_RF_ENDING"],
           "limit":5}
        ],
        "measures":[
          {"query":"fund_terms","alias":"called_pct","expr":"round((FUND_TOTAL_COMMITMENTS - FUND_UNDRAWN_COMMITMENTS) / FUND_TOTAL_COMMITMENTS * 100, 1)","label":"Commitments called","unit":"percent"},
          {"query":"fund_terms","alias":"fee_drag_pts","expr":"round(FUND_GROSS_IRR - FUND_NET_IRR, 1)","label":"Gross-to-net IRR drag","unit":"percent"},
          {"query":"statement","alias":"tvpi","expr":"round((NAV_RF_ENDING - NAV_RF_DISTRIBUTIONS) / NAV_RF_CONTRIBUTIONS, 2)","label":"TVPI","unit":"multiple"},
          {"query":"statement","alias":"dpi","expr":"round(-NAV_RF_DISTRIBUTIONS / NAV_RF_CONTRIBUTIONS, 2)","label":"DPI","unit":"multiple"},
          {"query":"statement","alias":"rvpi","expr":"round(NAV_RF_ENDING / NAV_RF_CONTRIBUTIONS, 2)","label":"RVPI","unit":"multiple"},
          {"query":"statement","alias":"nii_yield_pct","expr":"round(NAV_CH_NET_INVESTMENT_INCOME * 4 / NAV_CH_BEGINNING * 100, 1)","label":"Net investment income yield, annualised","unit":"percent"},
          {"query":"statement","alias":"quarter_return_pct","expr":"round(NAV_CH_NET_OPERATIONS / NAV_CH_BEGINNING * 100, 2)","label":"Quarter return on beginning NAV","unit":"percent"},
          {"query":"statement","alias":"dist_coverage","expr":"round(NAV_CH_NET_INVESTMENT_INCOME / -NAV_CH_DISTRIBUTIONS, 2)","label":"Distribution coverage","unit":"multiple"},
          {"query":"statement","alias":"expense_ratio_pct","expr":"round(NAV_OP_TOTAL_EXPENSES * 4 / NAV_CH_BEGINNING * 100, 2)","label":"Expense ratio, annualised","unit":"percent"}
        ],
        "blocks":[
          {"type":"kpis","key":"return_kpis","title":"Returns","guidance":"Net IRR (detail: a year ago); gross IRR; TVPI; DPI; net investment income yield; distribution coverage; commitments called."},
          {"type":"markdown","key":"lead","title":"What we have earned","guidance":"Three to five sentences: the return, the income and its coverage of distributions, and how much of NAV's movement was income versus marks."},
          {"type":"chart","key":"nav_bridge","guidance":"waterfall in $M. labels: 'NAV <Mon-YY a year ago>', 'Contributions', 'Net investment income', 'Distributions', 'Realized', 'Unrealized', 'NAV <Mon-YY now>'. values: the starting NAV, each step, then 0; totals [0, 6]. Leave out the Contributions step if it is zero. Title states the finding."},
          {"type":"table","key":"quarters","title":"Quarterly results","guidance":"Columns: Quarter, Beginning NAV ($M), Net investment income ($M), Distributions ($M), Realized ($M), Unrealized ($M), Ending NAV ($M), Income yield, annualised (%), Distribution coverage (x), Quarter return (%). Oldest first."},
          {"type":"table","key":"gross_to_net","title":"Gross to net","guidance":"Columns: Item, Value. Rows: Gross IRR (%), Fee and expense drag (pts), Net IRR (%), Management fee (%), Carried interest (%), Hurdle (%), Expense ratio, annualised (%)."}
        ]
      },
      {
        "key":"drivers","title":"What Drove NAV",
        "purpose":"Which industries and which borrowers moved the portfolio's value over the last year?",
        "instructions":"Evidence holds exposure_by_industry and exposure_by_issuer at the as-of date, a quarter ago and a year ago. Use compare_asof with the same queries and dates to get the change for each industry and each borrower; quote its changes rather than subtracting yourself. Build the bridge from total marked value a year ago to total marked value now, one step per industry, largest move first. Then give the five largest increases and five largest decreases by borrower. Say whether the move was broad or driven by a few names, and whether the position count changed (if it did not, the move came from marks on existing positions, not from new deals or exits). Match borrowers across dates by the grouped name only within these query results.",
        "agentic":{"enabled":true,"maxRounds":6},
        "comparisons":[
          {"label":"Current"},
          {"label":"Last quarter","offset":{"months":3}},
          {"label":"1 year ago","offset":{"years":1}}
        ],
        "dataQueries":[
          {"key":"exposure_by_industry","label":"Exposure by industry","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[{"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"}],
           "groupBy":["sec.INDUSTRY"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"},{"agg":"COUNT","alias":"positions"}],
           "orderBy":[{"field":"exposure","dir":"desc"}],"limit":50},
          {"key":"exposure_by_issuer","label":"Exposure by borrower","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[
             {"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"},
             {"alias":"iss","direction":"UP","domainCode":"ISSUER","from":"sec","label":"Issuer","relationshipCode":"SECURITY_ISSUER"}
           ],
           "groupBy":["iss.entity_name"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"},{"agg":"COUNT","alias":"positions"}],
           "orderBy":[{"field":"exposure","dir":"desc"}],"limit":500}
        ],
        "blocks":[
          {"type":"markdown","key":"lead","title":"Where the change came from","guidance":"Three to four sentences, figures in $M."},
          {"type":"chart","key":"industry_bridge","guidance":"waterfall in $M. labels: 'A year ago', then each industry, then 'Now'. values: the total a year ago, each industry's change, then 0 for the end bar; totals [0, last index]. Title states the finding."},
          {"type":"table","key":"movers","title":"Largest moves by borrower, last 12 months","guidance":"Columns: Borrower, A year ago ($M), Now ($M), Change ($M), Change (%). Five largest increases, then five largest decreases."}
        ]
      },
      {
        "key":"allocation","title":"Portfolio Composition",
        "purpose":"Where is the capital, and how has the mix shifted?",
        "instructions":"Evidence holds exposure_by_industry at the as-of date, a quarter ago and a year ago, with each industry's exposure_share of the book and share_pct (the same share in percent). Show the current mix, largest first, and each industry's share now against a quarter and a year ago, with the change in percentage points. The screens industry_over_20 and industry_over_15 are computed: quote them for which industries are concentrated. Say how many industries the book spans and how much sits in the three largest. Call a shift of more than 1 percentage point a shift; anything smaller is stable.",
        "comparisons":[
          {"label":"Current"},
          {"label":"Last quarter","offset":{"months":3}},
          {"label":"1 year ago","offset":{"years":1}}
        ],
        "dataQueries":[
          {"key":"exposure_by_industry","label":"Exposure by industry","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[{"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"}],
           "groupBy":["sec.INDUSTRY"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"},{"agg":"COUNT","alias":"positions"}],
           "orderBy":[{"field":"exposure","dir":"desc"}],"limit":50}
        ],
        "measures":[
          {"query":"exposure_by_industry","alias":"share_pct","expr":"round(exposure_share * 100, 1)","label":"Share of book","unit":"percent"}
        ],
        "screens":[
          {"key":"industry_over_20","label":"Industry above 20% of the book","query":"exposure_by_industry","when":"exposure_share > 0.20","severity":"high"},
          {"key":"industry_over_15","label":"Industry between 15% and 20% of the book","query":"exposure_by_industry","when":"exposure_share > 0.15 && exposure_share <= 0.20","severity":"medium"}
        ],
        "blocks":[
          {"type":"markdown","key":"lead","title":"Where the capital is","guidance":"Two to three sentences: breadth, the largest exposure, and the direction of the mix."},
          {"type":"chart","key":"industry_mix","guidance":"bar, one series 'Share of NAV (%)', industries largest first. Title states the finding."},
          {"type":"table","key":"industry_table","title":"Industry mix over time","guidance":"Columns: Industry, Exposure ($M), Share now (%), Share last quarter (%), Share a year ago (%), Change over 12 months (pp), Positions. Largest first."},
          {"type":"insights","key":"mix_points","title":"What the mix tells us","guidance":"Two or three items from the screens and the table. warning for a screened concentration, with its mitigant; positive for breadth or stability."}
        ]
      },
      {
        "key":"concentration","title":"Concentration and Downside",
        "purpose":"How exposed is the fund to any one borrower, and what happens if the largest ones fail?",
        "instructions":"Evidence holds exposure_by_issuer at the as-of date and a year ago, with exposure_share and share_pct per borrower. The scenarios are computed and authoritative: borrowers (count), top5_share, top10_share, top20_share (each a fraction of the book; show it in %), hhi (sum of squared shares; the effective number of borrowers is 1 divided by hhi, round to a whole number), and the stress cases largest_loss_100, largest2_loss_50 and largest5_loss_50 (each the fraction of the book lost under that assumption; the names used are listed). NAV after a stress case is NAV times one minus the fraction; take NAV from the NAV Track Record section. The screens name_over_5 and name_over_3 are computed. For each stress case give the severity by this rule: low below 2% of NAV, medium 2% to 5%, high above 5%. Compare the top 10 share now with a year ago from the comparison data set.",
        "comparisons":[
          {"label":"Current"},
          {"label":"1 year ago","offset":{"years":1}}
        ],
        "dataQueries":[
          {"key":"exposure_by_issuer","label":"Exposure by borrower","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[
             {"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"},
             {"alias":"iss","direction":"UP","domainCode":"ISSUER","from":"sec","label":"Issuer","relationshipCode":"SECURITY_ISSUER"}
           ],
           "groupBy":["iss.entity_name"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"},{"agg":"COUNT","alias":"positions"}],
           "orderBy":[{"field":"exposure","dir":"desc"}],"limit":500}
        ],
        "measures":[
          {"query":"exposure_by_issuer","alias":"share_pct","expr":"round(exposure_share * 100, 2)","label":"Share of book","unit":"percent"}
        ],
        "screens":[
          {"key":"name_over_5","label":"Borrower above 5% of the book","query":"exposure_by_issuer","when":"exposure_share > 0.05","severity":"high"},
          {"key":"name_over_3","label":"Borrower between 3% and 5% of the book","query":"exposure_by_issuer","when":"exposure_share > 0.03 && exposure_share <= 0.05","severity":"medium"}
        ],
        "scenarios":[
          {"key":"borrowers","label":"Number of borrowers","query":"exposure_by_issuer","expr":"1","agg":"COUNT"},
          {"key":"top5_share","label":"Share of the book in the 5 largest borrowers","query":"exposure_by_issuer","expr":"exposure_share","agg":"SUM","rankBy":"exposure","top":5},
          {"key":"top10_share","label":"Share of the book in the 10 largest borrowers","query":"exposure_by_issuer","expr":"exposure_share","agg":"SUM","rankBy":"exposure","top":10},
          {"key":"top20_share","label":"Share of the book in the 20 largest borrowers","query":"exposure_by_issuer","expr":"exposure_share","agg":"SUM","rankBy":"exposure","top":20},
          {"key":"hhi","label":"Herfindahl index of borrower shares","query":"exposure_by_issuer","expr":"exposure_share * exposure_share","agg":"SUM"},
          {"key":"largest_loss_100","label":"Largest borrower written off in full","query":"exposure_by_issuer","expr":"exposure_share * loss","agg":"SUM","params":{"loss":1},"rankBy":"exposure","top":1},
          {"key":"largest2_loss_50","label":"Two largest borrowers lose 50% of value","query":"exposure_by_issuer","expr":"exposure_share * loss","agg":"SUM","params":{"loss":0.5},"rankBy":"exposure","top":2},
          {"key":"largest5_loss_50","label":"Five largest borrowers lose 50% of value","query":"exposure_by_issuer","expr":"exposure_share * loss","agg":"SUM","params":{"loss":0.5},"rankBy":"exposure","top":5}
        ],
        "dependsOn":["nav_trend"],
        "blocks":[
          {"type":"kpis","key":"conc_kpis","title":"Concentration","guidance":"Borrowers; largest borrower (%); top 5 (%); top 10 (%), with a year ago in detail; effective number of borrowers."},
          {"type":"markdown","key":"lead","title":"How concentrated we are","guidance":"Two to three sentences: the answer, the comparison with a year ago, and what the screens found."},
          {"type":"chart","key":"top10_chart","guidance":"bar, one series 'Share of NAV (%)', the ten largest borrowers, largest first. Title states the finding."},
          {"type":"table","key":"top_borrowers","title":"Fifteen largest borrowers","guidance":"Columns: Rank, Borrower, Exposure ($M), Share of NAV (%), Positions, Change vs a year ago ($M)."},
          {"type":"callouts","key":"stress","title":"Downside cases","guidance":"One item per stress scenario. title: the assumption. severity by the rule in the instructions. fields: Names (the borrowers used), NAV impact (%), NAV after ($M), What limits the damage (granularity, seniority or another mitigant the data shows)."}
        ]
      },
      {
        "key":"loan_book","title":"Loan Book",
        "purpose":"What do we own: how senior, how floating, at what spread, and when does it come due?",
        "instructions":"Evidence holds loan_terms (weighted by marked value: spread in bps over floating-rate loans, coupon in %), by_lien and by_rate_type (exposure and share per lien and per fixed or floating), by_pik and by_cov_lite (exposure and share deferring interest and cov-lite), and by_security (one row per security with its lien, rate type, spread, coupon and maturity). The scenarios are computed and authoritative: maturing_2027 through maturing_2032 (share of the book maturing in each year), coupon_income (annual coupon on marked value, in $), rate_up_100 and rate_down_100 (the change in annual coupon income if the base rate moves 100 bps on floating loans, in $; no floors are modelled, say so). Lead with seniority and rate mix. Show the maturity ladder by year. Show the rate sensitivity with its assumption: coupon on marked value, the base rate passes through fully, no floors and no hedges. Express the rate sensitivity also as % of NAV, with NAV from the NAV Track Record section.",
        "comparisons":[{"label":"Current"}],
        "dataQueries":[
          {"key":"loan_terms","label":"Weighted loan terms","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[{"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"}],
           "metrics":[
             {"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"},
             {"agg":"WEIGHTED_AVG","field":"sec.SPREAD_BPS","weightField":"MARKET_VALUE","alias":"wa_spread_bps"},
             {"agg":"WEIGHTED_AVG","field":"sec.COUPON_RATE","weightField":"MARKET_VALUE","alias":"wa_coupon_pct"},
             {"agg":"WEIGHTED_AVG","field":"FAIR_MARKET_PRICE","weightField":"MARKET_VALUE","alias":"wa_mark"}
           ],"limit":1},
          {"key":"by_lien","label":"Exposure by lien","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[{"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"}],
           "groupBy":["sec.LIEN_PRIORITY"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"},{"agg":"WEIGHTED_AVG","field":"sec.SPREAD_BPS","weightField":"MARKET_VALUE","alias":"wa_spread_bps"}],
           "orderBy":[{"field":"exposure","dir":"desc"}],"limit":10},
          {"key":"by_rate_type","label":"Exposure by rate type","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[{"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"}],
           "groupBy":["sec.IS_FIXED_RATE"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"}],"limit":5},
          {"key":"by_pik","label":"Exposure deferring interest (PIK)","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[{"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"}],
           "groupBy":["sec.IS_DEFERRING_INTEREST"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"}],"limit":5},
          {"key":"by_cov_lite","label":"Exposure by covenant package","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[{"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"}],
           "groupBy":["sec.IS_COV_LITE"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"}],"limit":5},
          {"key":"by_security","label":"Exposure by security","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[{"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"}],
           "groupBy":["sec.entity_name","sec.LIEN_PRIORITY","sec.IS_FIXED_RATE","sec.SPREAD_BPS","sec.COUPON_RATE","sec.MATURITY_DATE"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"}],
           "orderBy":[{"field":"exposure","dir":"desc"}],"limit":500}
        ],
        "scenarios":[
          {"key":"maturing_2027","label":"Share maturing in 2027 or earlier","query":"by_security","expr":"if(sec.MATURITY_DATE < '2028-01-01', exposure_share, 0)","agg":"SUM"},
          {"key":"maturing_2028","label":"Share maturing in 2028","query":"by_security","expr":"if(sec.MATURITY_DATE >= '2028-01-01' && sec.MATURITY_DATE < '2029-01-01', exposure_share, 0)","agg":"SUM"},
          {"key":"maturing_2029","label":"Share maturing in 2029","query":"by_security","expr":"if(sec.MATURITY_DATE >= '2029-01-01' && sec.MATURITY_DATE < '2030-01-01', exposure_share, 0)","agg":"SUM"},
          {"key":"maturing_2030","label":"Share maturing in 2030","query":"by_security","expr":"if(sec.MATURITY_DATE >= '2030-01-01' && sec.MATURITY_DATE < '2031-01-01', exposure_share, 0)","agg":"SUM"},
          {"key":"maturing_2031","label":"Share maturing in 2031","query":"by_security","expr":"if(sec.MATURITY_DATE >= '2031-01-01' && sec.MATURITY_DATE < '2032-01-01', exposure_share, 0)","agg":"SUM"},
          {"key":"maturing_2032","label":"Share maturing in 2032 or later","query":"by_security","expr":"if(sec.MATURITY_DATE >= '2032-01-01', exposure_share, 0)","agg":"SUM"},
          {"key":"coupon_income","label":"Annual coupon income on marked value ($)","query":"by_security","expr":"exposure * sec.COUPON_RATE / 100","agg":"SUM"},
          {"key":"rate_up_100","label":"Change in annual coupon income, base rate +100 bps ($)","query":"by_security","expr":"if(sec.IS_FIXED_RATE == 'false', exposure * shift, 0)","agg":"SUM","params":{"shift":0.01}},
          {"key":"rate_down_100","label":"Change in annual coupon income, base rate -100 bps ($)","query":"by_security","expr":"if(sec.IS_FIXED_RATE == 'false', exposure * shift, 0)","agg":"SUM","params":{"shift":-0.01}}
        ],
        "dependsOn":["nav_trend"],
        "blocks":[
          {"type":"kpis","key":"book_kpis","title":"Loan book","guidance":"First lien (%); floating rate (%); weighted spread (bps); weighted coupon (%); weighted mark; PIK (%); cov-lite (%)."},
          {"type":"markdown","key":"lead","title":"What we own","guidance":"Two to four sentences: seniority, rate mix and pricing, the maturity profile, and the rate sensitivity in one line."},
          {"type":"chart","key":"lien_mix","guidance":"pie of share of NAV by lien, values in %, labels in words. Title states the finding."},
          {"type":"chart","key":"maturities","guidance":"bar, one series 'Share of NAV maturing (%)', labels 2027 to 2032, in year order. Title states the finding."},
          {"type":"table","key":"rates","title":"Rate sensitivity","guidance":"Columns: Scenario, Annual coupon income ($M), Change vs base ($M), Change (% of NAV). Rows: Base, +100 bps, -100 bps. The assumptions go in the lead block, not here."}
        ]
      },
      {
        "key":"credit","title":"Borrower Credit Quality",
        "purpose":"How are our borrowers performing, which are on the watchlist, and what is on non-accrual?",
        "instructions":"Evidence holds portfolio_credit (leverage, interest coverage and mark weighted by marked value) and borrower_credit (one row per borrower with its net leverage, interest coverage, rating, LTM EBITDA, lowest position mark and exposure, and the computed status measure), each now and a year ago, plus accrual (marked value and cost of positions by non-accrual flag, now and a year ago), non_accrual_borrowers (the borrowers with a position on non-accrual) and by_rating (exposure by rating). status is computed: Watchlist when interest coverage is below 1.5x, net leverage above 6.5x or the lowest mark below 90; Not rated when leverage or coverage is missing; otherwise Performing. A borrower in non_accrual_borrowers is Non-accrual whatever its status. The screens are computed: quote them. Lead with weighted leverage and coverage now against a year ago, and the non-accrual rate at fair value and at cost (compute each as the non-accrual row's value over the total). Then the rating mix and the watchlist: every Watchlist and Non-accrual borrower in the scorecard, with its figures now and a year ago and the EBITDA change. For each such borrower give one callout. If the watchlistNotes input is set, quote the part about that borrower under 'Portfolio Manager's view'; otherwise leave that field out. Never describe an action, restructuring or sponsor support that is not in watchlistNotes.",
        "comparisons":[
          {"label":"Current"},
          {"label":"1 year ago","offset":{"years":1}}
        ],
        "dataQueries":[
          {"key":"portfolio_credit","label":"Weighted credit metrics","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[
             {"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"},
             {"alias":"iss","direction":"UP","domainCode":"ISSUER","from":"sec","label":"Issuer","relationshipCode":"SECURITY_ISSUER"}
           ],
           "metrics":[
             {"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"},
             {"agg":"WEIGHTED_AVG","field":"iss.TOTAL_NET_LEVERAGE_RATIO","weightField":"MARKET_VALUE","alias":"wa_net_leverage"},
             {"agg":"WEIGHTED_AVG","field":"iss.INTEREST_COVERAGE_RATIO","weightField":"MARKET_VALUE","alias":"wa_interest_coverage"},
             {"agg":"WEIGHTED_AVG","field":"FAIR_MARKET_PRICE","weightField":"MARKET_VALUE","alias":"wa_mark"}
           ],"limit":1},
          {"key":"borrower_credit","label":"Credit metrics by borrower","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[
             {"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"},
             {"alias":"iss","direction":"UP","domainCode":"ISSUER","from":"sec","label":"Issuer","relationshipCode":"SECURITY_ISSUER"}
           ],
           "groupBy":["iss.entity_name","iss.TOTAL_NET_LEVERAGE_RATIO","iss.INTEREST_COVERAGE_RATIO","iss.CREDIT_RATING","iss.EBITDA_LTM"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"},{"agg":"MIN","field":"FAIR_MARKET_PRICE","alias":"lowest_mark"},{"agg":"COUNT","alias":"positions"}],
           "orderBy":[{"field":"exposure","dir":"desc"}],"limit":500},
          {"key":"accrual","label":"Marked value and cost by accrual status","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "groupBy":["IS_NON_ACCRUAL"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"},{"agg":"SUM","field":"POSITION_COST","alias":"cost"},{"agg":"COUNT","alias":"positions"}],"limit":5},
          {"key":"non_accrual_borrowers","label":"Borrowers with a position on non-accrual","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[
             {"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"},
             {"alias":"iss","direction":"UP","domainCode":"ISSUER","from":"sec","label":"Issuer","relationshipCode":"SECURITY_ISSUER"}
           ],
           "filters":[{"field":"IS_NON_ACCRUAL","op":"eq","value":true}],
           "groupBy":["iss.entity_name"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"},{"agg":"SUM","field":"POSITION_COST","alias":"cost"}],"limit":50},
          {"key":"by_rating","label":"Exposure by borrower rating","start":"CONTEXT",
           "path":[{"direction":"DOWN","domainCode":"POSITION","relationshipCode":"POSITION_FUND"}],
           "lookups":[
             {"alias":"sec","direction":"UP","domainCode":"SECURITY","label":"Security","relationshipCode":"POSITION_SECURITY"},
             {"alias":"iss","direction":"UP","domainCode":"ISSUER","from":"sec","label":"Issuer","relationshipCode":"SECURITY_ISSUER"}
           ],
           "groupBy":["iss.CREDIT_RATING"],
           "metrics":[{"agg":"SUM","field":"MARKET_VALUE","alias":"exposure"}],"limit":30}
        ],
        "measures":[
          {"query":"borrower_credit","alias":"share_pct","expr":"round(exposure_share * 100, 2)","label":"Share of book","unit":"percent"},
          {"query":"borrower_credit","alias":"status","expr":"if(isnull(iss.TOTAL_NET_LEVERAGE_RATIO) || isnull(iss.INTEREST_COVERAGE_RATIO), 'Not rated', if(iss.INTEREST_COVERAGE_RATIO < 1.5 || iss.TOTAL_NET_LEVERAGE_RATIO > 6.5 || lowest_mark < 90, 'Watchlist', 'Performing'))","label":"Status"},
          {"query":"by_rating","alias":"share_pct","expr":"round(exposure_share * 100, 1)","label":"Share of book","unit":"percent"}
        ],
        "screens":[
          {"key":"coverage_below_1_5","label":"Interest coverage below 1.5x","query":"borrower_credit","when":"iss.INTEREST_COVERAGE_RATIO < 1.5","severity":"high"},
          {"key":"leverage_above_6_5","label":"Net leverage above 6.5x","query":"borrower_credit","when":"iss.TOTAL_NET_LEVERAGE_RATIO > 6.5","severity":"medium"},
          {"key":"mark_below_90","label":"A position marked below 90","query":"borrower_credit","when":"lowest_mark < 90","severity":"high"},
          {"key":"ccc_rated","label":"Rated CCC+ or below","query":"borrower_credit","when":"iss.CREDIT_RATING == 'CCC_PLUS' || iss.CREDIT_RATING == 'CCC' || iss.CREDIT_RATING == 'CC' || iss.CREDIT_RATING == 'C' || iss.CREDIT_RATING == 'D'","severity":"high"}
        ],
        "scenarios":[
          {"key":"watchlist_share","label":"Share of the book on the watchlist","query":"borrower_credit","expr":"if(status == 'Watchlist', exposure_share, 0)","agg":"SUM"},
          {"key":"watchlist_count","label":"Borrowers on the watchlist","query":"borrower_credit","expr":"if(status == 'Watchlist', 1, 0)","agg":"SUM"}
        ],
        "blocks":[
          {"type":"kpis","key":"credit_kpis","title":"Credit quality","guidance":"Weighted net leverage (x, detail a year ago); weighted interest coverage (x, detail a year ago); non-accrual at fair value (%); non-accrual at cost (%); watchlist (% of NAV and count); weighted mark."},
          {"type":"markdown","key":"lead","title":"How our borrowers are doing","guidance":"Three to four sentences: the trend in leverage and coverage, the non-accrual rate, and the watchlist in one line."},
          {"type":"chart","key":"ratings","guidance":"bar, one series 'Share of NAV (%)', ratings in scale order from strongest to weakest, labels in words (B+, B, B-, CCC+, CCC). Title states the finding."},
          {"type":"scorecard","key":"watchlist","title":"Watchlist and non-accrual borrowers","statusColumn":"Status","guidance":"Columns: Borrower, Exposure ($M), Share of NAV (%), Net leverage now (x), A year ago (x), Interest coverage now (x), A year ago (x), EBITDA change (%), Rating, Lowest mark, Status. Non-accrual first, then by exposure."},
          {"type":"callouts","key":"credit_notes","title":"Problem credits","guidance":"One item per Watchlist or Non-accrual borrower. title: the borrower and its status. severity high for Non-accrual, medium for Watchlist. fields: What the numbers show (leverage, coverage and EBITDA now versus a year ago); Mark and exposure (lowest mark, $M, % of NAV); What limits the loss (size, and seniority only if the loan book section shows it); Portfolio Manager's view (only from watchlistNotes)."}
        ]
      },
      {
        "key":"limits","title":"Limits and Liquidity",
        "purpose":"Is the fund inside every limit, and can it fund what it has promised?",
        "instructions":"Evidence holds fund_liquidity (the fund's undrawn investor commitments, credit line headroom, unfunded commitments to borrowers and total debt, with liquidity_coverage as a measure: undrawn commitments plus credit line headroom over unfunded borrower commitments). Then call list_compliance_rules for anchorDomainCode FUND, and evaluate_compliance_rule for each active rule at the report as-of date. Use only results for this fund (match by its id or code, never by name). For each rule give the current value, the limit and the headroom; Status is 'Within limit' or 'Breach' only from the evaluation result, otherwise 'Not evaluated'. Order by headroom, tightest first, and name the tightest limit in the lead with its headroom. Where a rule tests the same thing as an earlier section (an industry or a single-borrower share), check its current value against that section and use the rule's value. If the tools return no rules for this fund, leave the limits table out and say in the lead that no fund limits are monitored in this report.",
        "agentic":{"enabled":true,"maxRounds":8},
        "dataQueries":[
          {"key":"fund_liquidity","label":"Fund liquidity","start":"CONTEXT","path":[],"includeAnchor":true,
           "select":["FUND_UNDRAWN_COMMITMENTS","FUND_CREDIT_LINE_HEADROOM","FUND_UNFUNDED_BORROWER_COMMITMENTS","TOTAL_DEBT"],"limit":1}
        ],
        "measures":[
          {"query":"fund_liquidity","alias":"liquidity_coverage","expr":"round((FUND_UNDRAWN_COMMITMENTS + FUND_CREDIT_LINE_HEADROOM) / FUND_UNFUNDED_BORROWER_COMMITMENTS, 1)","label":"Liquidity cover of unfunded commitments","unit":"multiple"}
        ],
        "dependsOn":["allocation","concentration"],
        "blocks":[
          {"type":"markdown","key":"lead","title":"Where we stand","guidance":"Two to three sentences: all limits within or not, the tightest with its headroom, and liquidity against unfunded commitments."},
          {"type":"kpis","key":"liquidity","title":"Liquidity","guidance":"Undrawn investor commitments ($M); credit line headroom ($M); unfunded borrower commitments ($M); liquidity cover (x); fund-level debt ($M)."},
          {"type":"scorecard","key":"limits_table","title":"Status against limits","statusColumn":"Status","guidance":"Columns: Limit, Current (%), Limit (%), Headroom (pp), Status. Use the units of the rule when it is not a percent, and say so in the header."}
        ]
      },
      {
        "key":"lp_qa","title":"Anticipated LP Questions",
        "purpose":"What will a careful LP ask, and what is our answer?",
        "instructions":"Write the six to eight questions a careful allocator would ask after reading the sections above, about the fund itself: returns against the year before and how much is income, the problem credits and the non-accrual, the largest concentration and the tightest limit, the direction of marks, rate sensitivity, maturities, and liquidity. Answer each in two or three sentences in our voice with figures from the sections above. For a problem credit, give the Portfolio Manager's view only if the credit section quotes one. At most one question may cover something this report does not show; answer it plainly that it is not part of this report, without promising when it will be provided. Never ask about our data, systems or reporting.",
        "dataQueries":[],
        "dependsOn":["nav_trend","returns","drivers","allocation","concentration","loan_book","credit","limits"],
        "blocks":[
          {"type":"callouts","key":"questions","title":"Questions and answers","guidance":"title is the question. severity info. fields: Our answer, Evidence (the figures and the section they come from)."}
        ]
      },
      {
        "key":"data_room","title":"Appendix: Data Room Readiness (internal, remove before sending)",
        "purpose":"What would a diligent LP ask for that this report cannot yet show, and what do we load to close it?",
        "instructions":"This is the only section that discusses data, and it is for the manager, not the LP. Call get_data_coverage for FUND, POSITION, SECURITY, ISSUER and NAV_STATEMENT. Check each item an LP data room is expected to hold: net IRR, TVPI, DPI, commitments, called and distributed capital, capital account cash flows by investor, portfolio income and yield, management fee, carry and expenses, coupon or spread, rate floors, maturity, seniority, ratings, non-accrual and PIK, borrower leverage and interest coverage, covenant headroom, sponsor, fund credit facility and borrowing base, cash, benchmark or peer returns. For each give its status: Loaded, Defined but not loaded, or Not defined, with the share of records holding a value where loaded. Then the five that matter most to an LP conversation, each as 'Recommended: <what to load>' with the section it would unlock.",
        "agentic":{"enabled":true,"maxRounds":8},
        "dataQueries":[],
        "blocks":[
          {"type":"table","key":"readiness","title":"Data room checklist","guidance":"Columns: Item, Status, Coverage (%), Why an LP asks. Group Not defined and Defined but not loaded items first."},
          {"type":"markdown","key":"next_steps","title":"Highest-value additions","guidance":"Five bullets, each starting 'Recommended:'."}
        ]
      }
    ]$s$::jsonb
)
ON CONFLICT (narrative_code) DO UPDATE SET
    narrative_name = EXCLUDED.narrative_name,
    description = EXCLUDED.description,
    persona = EXCLUDED.persona,
    audience = EXCLUDED.audience,
    rules = EXCLUDED.rules,
    allow_external_search = EXCLUDED.allow_external_search,
    parameters = EXCLUDED.parameters,
    sections = EXCLUDED.sections,
    instructions = '',
    data_queries = '[]'::jsonb,
    output_blocks = '[]'::jsonb,
    updated_at = NOW();

NOTIFY pgrst, 'reload schema';
