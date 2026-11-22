-- Reading a filed report onto the NAV chart.
--
-- A 10-Q or annual report of a BDC or registered fund prints lines the chart
-- did not have (subscriptions receivable, distributions payable, an incentive
-- fee, expense support, share transactions by class, the effect of exchange
-- rates on cash). This adds them, and puts on every chart line the wording it
-- takes from a report, so the report mapper has no list of its own:
--
--   navLine.match     rules a report line is tested against, in order. Each has
--                     a label pattern, and may require or exclude a heading.
--                     A rule marked total takes the report's own total, and the
--                     lines under it are then left as detail.
--   navLine.fallback  a heading pattern: a line under that heading that matched
--                     nothing else lands here (Other assets, Other liabilities).
--   navLine.priority  lower is tested first. Default 100.
--   navLine.single    only one report line can fill it.
--   navLine.combine   sum (default) or equal, for a per-share amount that must be
--                     the same in every share class to be taken.
--   navLine.unit      AMOUNT (default), SHARES, or PER_SHARE.
--
-- Patterns are tested against the label in lower case, with "(decrease)",
-- "(loss)" and the like and any parenthesis holding an amount or a note
-- reference taken out.
--
-- Also added:
--   STATEMENT_COMPARATIVE_DATE  the date a statement's prior column is at. A 10-Q
--                               compares with the last fiscal year end, not the
--                               last quarter, and the reconciliation follows it.
--   STATEMENT_SOURCE_CHECKS     the checks the report makes of itself (schedule
--                               subtotals, share-class NAV), kept with the statement.
--   FUND_CAPITAL_MODEL          DRAWDOWN (calls and distribution notices) or
--                               EVERGREEN (shares subscribed and repurchased).
--   FUND_MGMT_FEE_BASIS         what the management fee rate is charged on.
--   FUND_PERF_FEE_BASIS         WATERFALL (carried interest) or INCOME (an
--                               incentive fee on net investment income over a hurdle).

-- ============================================================
-- 1. Lists and fund settings
-- ============================================================

INSERT INTO metadata_register.reference_lists (list_code, list_name, domain_code, description) VALUES
    ('CAPITAL_MODEL', 'Capital Model', 'FUND', 'How investors put capital in and take it out'),
    ('MGMT_FEE_BASIS', 'Management Fee Basis', 'FUND', 'What the management fee rate is charged on'),
    ('PERF_FEE_BASIS', 'Performance Fee Basis', 'FUND', 'How the manager shares in profit')
ON CONFLICT (list_code) DO NOTHING;

INSERT INTO metadata_register.reference_list_values (list_id, value_code, value_label, display_order, synonyms)
SELECT rl.id, v.code, v.label, v.ord, '[]'::jsonb
FROM metadata_register.reference_lists rl
JOIN (VALUES
    ('CAPITAL_MODEL', 'DRAWDOWN', 'Drawdown: capital calls and distribution notices', 1),
    ('CAPITAL_MODEL', 'EVERGREEN', 'Evergreen: shares subscribed and repurchased', 2),
    ('MGMT_FEE_BASIS', 'COMMITMENTS', 'Commitments', 1),
    ('MGMT_FEE_BASIS', 'NET_ASSETS', 'Net assets', 2),
    ('MGMT_FEE_BASIS', 'TOTAL_ASSETS', 'Total assets', 3),
    ('PERF_FEE_BASIS', 'WATERFALL', 'Carried interest on a liquidation waterfall', 1),
    ('PERF_FEE_BASIS', 'INCOME', 'Incentive fee on net investment income over a hurdle', 2)
) AS v(list_code, code, label, ord) ON v.list_code = rl.list_code
ON CONFLICT (list_id, value_code) DO NOTHING;

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension
)
SELECT v.code, v.name, v.dtype, v.descr, v.dom,
       v.list, FALSE, FALSE, 100,
       v.section, v.grp, TRUE, TRUE,
       FALSE, 'NONE'
FROM (VALUES
    ('FUND_CAPITAL_MODEL', 'Capital Model', 'REFERENCE_LIST', 'Drawdown funds call capital and send distribution notices; evergreen funds and BDCs issue and repurchase shares. Blank is drawdown.', 'FUND', 'CAPITAL_MODEL', 'Close', 3),
    ('FUND_MGMT_FEE_BASIS', 'Management Fee Basis', 'REFERENCE_LIST', 'What the management fee rate is charged on. Blank is commitments.', 'FUND', 'MGMT_FEE_BASIS', 'Fees', 5),
    ('FUND_PERF_FEE_BASIS', 'Performance Fee Basis', 'REFERENCE_LIST', 'Carried interest on a liquidation waterfall, or an incentive fee on net investment income over the preferred return as a hurdle, with the catch-up, at the carried interest rate. Blank is the waterfall.', 'FUND', 'PERF_FEE_BASIS', 'Fees', 6),
    ('STATEMENT_COMPARATIVE_DATE', 'Comparative Date', 'DATE', 'Date the prior column of this statement is at. The reconciliation compares the period with this date. Blank is the previous period end of the close calendar.', 'NAV_STATEMENT', NULL, 'Review', 6),
    ('STATEMENT_SOURCE_CHECKS', 'Report Checks', 'STRING', 'JSON list of the checks the report makes of itself when it is read: schedule subtotals and totals, share-class NAV. Each has its label, both figures, and its result.', 'NAV_STATEMENT', NULL, 'Review', 7)
) AS v(code, name, dtype, descr, dom, list, section, grp)
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    reference_list_code = EXCLUDED.reference_list_code,
    data_type = EXCLUDED.data_type,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group;

-- ============================================================
-- 2. The chart, in display order
-- ============================================================

CREATE TEMP TABLE nav_chart_v2 ON COMMIT DROP AS
SELECT *
FROM ROWS FROM (jsonb_to_recordset($chart$[
  {"code":"NAV_BS_ASSETS","name":"Assets","section":"BS_ASSET","display":"Assets","role":"HEADER","legacy":"BS-01"},
  {"code":"NAV_BS_INVESTMENTS_NOTE","name":"Investments at fair value","section":"BS_ASSET","display":"Assets","role":"NOTE","legacy":"BS-02"},
  {"code":"NAV_BS_SENIOR","name":"Senior secured","section":"BS_ASSET","display":"Assets","role":"DETAIL","indent":2,"legacy":"BS-03","match":[{"label":"^senior secured$"}]},
  {"code":"NAV_BS_UNITRANCHE","name":"Unitranche","section":"BS_ASSET","display":"Assets","role":"DETAIL","indent":2,"legacy":"BS-04","match":[{"label":"^unitranche$"}]},
  {"code":"NAV_BS_MEZZANINE","name":"Mezzanine","section":"BS_ASSET","display":"Assets","role":"DETAIL","indent":2,"legacy":"BS-05","match":[{"label":"^mezzanine$"}]},
  {"code":"NAV_BS_ASSET_BASED","name":"Asset-based","section":"BS_ASSET","display":"Assets","role":"DETAIL","indent":2,"legacy":"BS-06","match":[{"label":"^asset[- ]based$"}]},
  {"code":"NAV_BS_INVESTMENTS","name":"Total investments at fair value","section":"BS_ASSET","display":"Assets","role":"SUBTOTAL","reviewable":true,"composition":true,"legacy":"BS-07","match":[{"label":"^total investments","total":true},{"label":"^investments,? at fair value$","total":true},{"label":"investments$","section":"investments"},{"label":"^investments in "}]},
  {"code":"NAV_BS_CASH","name":"Cash and equivalents","section":"BS_ASSET","display":"Assets","role":"LINE","reviewable":true,"composition":true,"legacy":"BS-08","match":[{"label":"^(restricted )?cash"},{"label":"^foreign currency,? at"}]},
  {"code":"NAV_BS_RECEIVABLE","name":"Interest receivable","section":"BS_ASSET","display":"Assets","role":"LINE","reviewable":true,"composition":true,"legacy":"BS-09","match":[{"label":"^(accrued )?(interest|dividends?|interest and dividends?|investment income)( and fees)? receivable"}]},
  {"code":"NAV_BS_SUBSCRIPTIONS_RECEIVABLE","name":"Subscriptions receivable","section":"BS_ASSET","display":"Assets","role":"LINE","match":[{"label":"^(capital )?subscriptions? receivable"},{"label":"^receivable for (shares|units|capital|fund shares) (sold|issued|subscribed)"}]},
  {"code":"NAV_BS_RECEIVABLE_SOLD","name":"Receivable for investments sold","section":"BS_ASSET","display":"Assets","role":"LINE","match":[{"label":"^receivables? (for|from) investments? sold"},{"label":"^due from brokers?"}]},
  {"code":"NAV_BS_DERIVATIVE_ASSETS","name":"Derivative assets","section":"BS_ASSET","display":"Assets","role":"LINE","match":[{"label":"^derivative assets?"},{"label":"^unrealized appreciation on .*(forward|swap|futures|option|derivative)"}]},
  {"code":"NAV_BS_DEFERRED_FINANCING","name":"Deferred financing costs","section":"BS_ASSET","display":"Assets","role":"LINE","match":[{"label":"^deferred (financing|debt issuance|offering) costs"},{"label":"^unamortized (debt issuance|financing) costs"}]},
  {"code":"NAV_BS_OTHER_ASSETS","name":"Other assets","section":"BS_ASSET","display":"Assets","role":"LINE","match":[{"label":"^(other assets|prepaid|other receivables?)"}],"fallback":"^assets$"},
  {"code":"NAV_BS_TOTAL_ASSETS","name":"Total assets","section":"BS_ASSET","display":"Assets","role":"TOTAL","legacy":"BS-10","single":true,"match":[{"label":"^total assets$","total":true}]},

  {"code":"NAV_BS_LIABILITIES","name":"Liabilities","section":"BS_LIABILITY","display":"Liabilities","role":"HEADER","legacy":"BS-11"},
  {"code":"NAV_BS_FACILITY","name":"Debt and credit facility","section":"BS_LIABILITY","display":"Liabilities","role":"LINE","reviewable":true,"composition":true,"legacy":"BS-12","match":[{"label":"^(debt|borrowings?|credit facilit|revolving credit|secured borrowings|notes payable|unsecured notes|senior notes|loans? payable|short-term borrowings|subscription (line|facility)|secured financing|term loan)"},{"label":"notes due"},{"label":"credit facility$"}]},
  {"code":"NAV_BS_INTEREST_PAYABLE","name":"Interest and debt fees payable","section":"BS_LIABILITY","display":"Liabilities","role":"LINE","match":[{"label":"^(accrued )?interest( and (debt|credit facility|facility|financing|unused) fees?)? payable"},{"label":"^accrued interest (expense|payable)"}]},
  {"code":"NAV_BS_PAYABLE_PURCHASED","name":"Payable for investments purchased","section":"BS_LIABILITY","display":"Liabilities","role":"LINE","match":[{"label":"^payables? for investments? purchased"},{"label":"^due to brokers?"}]},
  {"code":"NAV_BS_DISTRIBUTION_PAYABLE","name":"Distributions payable","section":"BS_LIABILITY","display":"Liabilities","role":"LINE","match":[{"label":"^(distributions?|dividends?) payable"},{"label":"^(distributions?|dividends?) declared and payable"}]},
  {"code":"NAV_BS_ACCRUED_FEE","name":"Accrued management fee","section":"BS_LIABILITY","display":"Liabilities","role":"LINE","reviewable":true,"composition":true,"legacy":"BS-13","match":[{"label":"^(accrued )?(base )?management fees? payable"},{"label":"^accrued (base )?management fees?"},{"label":"^(management and )?advisory fees? payable"}]},
  {"code":"NAV_BS_ACCRUED_PERF","name":"Accrued incentive fee","section":"BS_LIABILITY","display":"Liabilities","role":"LINE","reviewable":true,"composition":true,"match":[{"label":"^(accrued )?(income |capital gains )?(based )?incentive fees? payable"},{"label":"^accrued (performance|incentive|carried)"},{"label":"^(performance fees?|carried interest) payable"}]},
  {"code":"NAV_BS_SERVICING_PAYABLE","name":"Distribution and servicing fees payable","section":"BS_LIABILITY","display":"Liabilities","role":"LINE","match":[{"label":"(shareholder servicing|servicing fees?|distribution fees?|distribution and.*servicing).*payable"}]},
  {"code":"NAV_BS_DERIVATIVE_LIABILITIES","name":"Derivative liabilities","section":"BS_LIABILITY","display":"Liabilities","role":"LINE","match":[{"label":"^derivative liabilit"},{"label":"^unrealized depreciation on .*(forward|swap|futures|option|derivative)"}]},
  {"code":"NAV_BS_ACCRUED_EXPENSES","name":"Accrued expenses and interest","section":"BS_LIABILITY","display":"Liabilities","role":"LINE","reviewable":true,"composition":true,"legacy":"BS-14","match":[{"label":"^accrued expenses"},{"label":"^accounts payable"},{"label":"^(other )?accrued (liabilities|expenses)"}]},
  {"code":"NAV_BS_OTHER_LIABILITIES","name":"Other liabilities","section":"BS_LIABILITY","display":"Liabilities","role":"LINE","match":[{"label":"^(other liabilities|due to (counterpart|affiliate|adviser|advisor|related)|collateral (payable|received)|deferred tax|taxes payable|excise tax)"}],"fallback":"^liabilities$"},
  {"code":"NAV_BS_TOTAL_LIABILITIES","name":"Total liabilities","section":"BS_LIABILITY","display":"Liabilities","role":"SUBTOTAL","legacy":"BS-15","single":true,"match":[{"label":"^total liabilities$","total":true}]},

  {"code":"NAV_BS_NET_HEADER","name":"Net assets","section":"BS_NET","display":"Net assets","role":"HEADER","legacy":"BS-16"},
  {"code":"NAV_BS_CONTRIBUTIONS","name":"Capital contributions","section":"BS_NET","display":"Net assets","role":"LINE","legacy":"BS-17","match":[{"label":"^(capital contributions|contributed capital|partners.? contributions)"}]},
  {"code":"NAV_BS_DISTRIBUTIONS","name":"Cumulative distributions","section":"BS_NET","display":"Net assets","role":"LINE","legacy":"BS-18","match":[{"label":"^cumulative distributions|^distributions to partners"}]},
  {"code":"NAV_BS_SHARES_AT_PAR","name":"Shares at par value","section":"BS_NET","display":"Net assets","role":"LINE","match":[{"label":"(shares?|stock|units?)(, | of beneficial interest,? ).*par value","section":"net assets|equity|capital"},{"label":"^(common|preferred) (stock|shares)$","section":"net assets|equity"}]},
  {"code":"NAV_BS_PAID_IN_CAPITAL","name":"Additional paid-in capital","section":"BS_NET","display":"Net assets","role":"LINE","match":[{"label":"^(additional )?paid[- ]in[- ]capital"},{"label":"^capital in excess of par"}]},
  {"code":"NAV_BS_ACCUMULATED","name":"Accumulated net investment income and gains","section":"BS_NET","display":"Net assets","role":"LINE","legacy":"BS-19","match":[{"label":"^(total )?distributable earnings"},{"label":"^(accumulated|undistributed|retained earnings|total accumulated)"}]},
  {"code":"NAV_BS_NET_ASSETS","name":"Net assets","section":"BS_NET","display":"Net assets","role":"TOTAL","legacy":"BS-20","single":true,"match":[{"label":"^(total )?net assets$","notSection":"class|series|per share|per unit","total":true},{"label":"^total (partners|members|shareholders|unitholders).? (capital|equity)$","total":true}]},
  {"code":"NAV_BS_TOTAL_LIABILITIES_NET_ASSETS","name":"Total liabilities and net assets","section":"BS_NET","display":"Net assets","role":"TOTAL","single":true,"match":[{"label":"^total liabilities and (net assets|equity|partners|members|shareholders)","total":true}]},
  {"code":"NAV_BS_SHARES_OUTSTANDING","name":"Shares outstanding","section":"BS_PER_SHARE","display":"Net assets","role":"LINE","unit":"SHARES","match":[{"label":"(shares|units) outstanding"}]},
  {"code":"NAV_BS_NAV_PER_SHARE","name":"Net asset value per share","section":"BS_PER_SHARE","display":"Net assets","role":"LINE","unit":"PER_SHARE","combine":"equal","match":[{"label":"^(net asset value|nav) per (share|unit)"}]},

  {"code":"NAV_OP_INCOME_HEADER","name":"Investment income","section":"OPS","display":"Operations","role":"HEADER","legacy":"OP-01"},
  {"code":"NAV_OP_CASH_INTEREST","name":"Cash interest income","section":"OPS","display":"Operations","role":"LINE","legacy":"OP-02","match":[{"label":"^(cash )?interest( and dividend)?( income)?$"},{"label":"^interest (and dividend )?income"},{"label":"^dividend income$"},{"label":"^cash interest"}]},
  {"code":"NAV_OP_PIK","name":"PIK interest income","section":"OPS","display":"Operations","role":"LINE","legacy":"OP-03","match":[{"label":"^(payment[- ]in[- ]kind|pik)"}]},
  {"code":"NAV_OP_FEE_INCOME","name":"Fee and other income","section":"OPS","display":"Operations","role":"LINE","legacy":"OP-04","match":[{"label":"^(fee|fees|other|fee and other|other investment) income"},{"label":"^(fee|fees|other)$","section":"income"}]},
  {"code":"NAV_OP_TOTAL_INCOME","name":"Total investment income","section":"OPS","display":"Operations","role":"SUBTOTAL","legacy":"OP-05","single":true,"match":[{"label":"^total (investment )?income$","total":true}]},
  {"code":"NAV_OP_EXPENSE_HEADER","name":"Expenses","section":"OPS","display":"Operations","role":"HEADER","legacy":"OP-06"},
  {"code":"NAV_OP_MGMT_FEE","name":"Management fee","section":"OPS","display":"Operations","role":"LINE","reviewable":true,"legacy":"OP-07","match":[{"label":"^(base )?management fees?$"},{"label":"^(investment )?advisory fees?$"}]},
  {"code":"NAV_OP_INCENTIVE_FEE","name":"Incentive fee","section":"OPS","display":"Operations","role":"LINE","reviewable":true,"match":[{"label":"^(income |capital gains |income based )?incentive fees?$"},{"label":"^(performance fees?|carried interest)( allocation)?$"}]},
  {"code":"NAV_OP_FACILITY_INTEREST","name":"Interest and facility fees","section":"OPS","display":"Operations","role":"LINE","legacy":"OP-08","match":[{"label":"^interest (and (debt|credit facility|facility|financing|other debt) )?(fee )?(expense|fees|costs)"},{"label":"^interest expense"},{"label":"^(credit facility|debt|financing|commitment) fees"}]},
  {"code":"NAV_OP_SERVICING_FEES","name":"Distribution and servicing fees","section":"OPS","display":"Operations","role":"LINE","match":[{"label":"(shareholder servicing|servicing fees?|distribution fees?|distribution and.*servicing)"},{"label":".","section":"shareholder servicing|servicing fees|distribution and.*servicing"}]},
  {"code":"NAV_OP_PROFESSIONAL","name":"Professional and administration fees","section":"OPS","display":"Operations","role":"LINE","legacy":"OP-09","match":[{"label":"^(professional|legal|audit|accounting|administrat|fund administration|custod|transfer agent)"}]},
  {"code":"NAV_OP_OTHER","name":"Other operating expenses","section":"OPS","display":"Operations","role":"LINE","legacy":"OP-10","match":[{"label":"^(other|general and administrative|board|directors|trustees|insurance|organization|offering|amortization of deferred offering|tax|excise)"}],"fallback":"^expenses$|operating expenses"},
  {"code":"NAV_OP_GROSS_EXPENSES","name":"Expenses before waivers and expense support","section":"OPS","display":"Operations","role":"SUBTOTAL","priority":30,"single":true,"match":[{"label":"^total (gross )?expenses before","total":true},{"label":"^(total )?gross expenses$","total":true}]},
  {"code":"NAV_OP_EXPENSE_SUPPORT","name":"Fee waivers and expense support","section":"OPS","display":"Operations","role":"LINE","priority":60,"match":[{"label":"(expense support|expense reimbursement|waiver|waived|recoupment|reimbursement)"}]},
  {"code":"NAV_OP_TOTAL_EXPENSES","name":"Total expenses","section":"OPS","display":"Operations","role":"SUBTOTAL","legacy":"OP-11","priority":40,"single":true,"match":[{"label":"^total (net )?(operating )?expenses( net of .*| after .*)?$","total":true},{"label":"^net expenses$","total":true}]},
  {"code":"NAV_OP_NET_INVESTMENT_INCOME","name":"Net investment income","section":"OPS","display":"Operations","role":"TOTAL","legacy":"OP-12","single":true,"match":[{"label":"^net investment income( after (income )?taxes)?$","total":true}]},
  {"code":"NAV_OP_GAIN_HEADER","name":"Realized and unrealized gain (loss)","section":"OPS","display":"Operations","role":"HEADER","legacy":"OP-13"},
  {"code":"NAV_OP_REALIZED","name":"Net realized gain on investments","section":"OPS","display":"Operations","role":"LINE","legacy":"OP-14","match":[{"label":"^net realized gain on investments$"},{"label":"(investments|investment transactions)$","section":"^(net )?realized"}]},
  {"code":"NAV_OP_REALIZED_OTHER","name":"Realized gain on currency and derivatives","section":"OPS","display":"Operations","role":"LINE","match":[{"label":"(currenc|forward|swap|futures|option|derivative|hedg)","section":"^(net )?realized"},{"label":"^net realized gain on .*(currenc|forward|swap|futures|option|derivative)"}]},
  {"code":"NAV_OP_REALIZED_TOTAL","name":"Net realized gain, total","section":"OPS","display":"Operations","role":"SUBTOTAL","single":true,"match":[{"label":"^net realized gain$","total":true},{"label":"^total net realized gain","total":true}]},
  {"code":"NAV_OP_UNREALIZED","name":"Net change in unrealized appreciation (depreciation)","section":"OPS","display":"Operations","role":"LINE","legacy":"OP-15","match":[{"label":"(investments|investment transactions)$","section":"unrealized"},{"label":"^net change in unrealized .*on investments$"}]},
  {"code":"NAV_OP_UNREALIZED_OTHER","name":"Unrealized on currency and derivatives","section":"OPS","display":"Operations","role":"LINE","match":[{"label":"(currenc|forward|swap|futures|option|derivative|hedg|translation)","section":"unrealized"},{"label":"^net change in unrealized .*(currenc|forward|swap|derivative)"}]},
  {"code":"NAV_OP_UNREALIZED_TOTAL","name":"Net change in unrealized, total","section":"OPS","display":"Operations","role":"SUBTOTAL","single":true,"match":[{"label":"^net change in unrealized( appreciation| depreciation| gain)?$","total":true},{"label":"^net unrealized (appreciation|depreciation|gain)$","total":true}]},
  {"code":"NAV_OP_TOTAL_GAIN","name":"Net realized and unrealized gain","section":"OPS","display":"Operations","role":"SUBTOTAL","legacy":"OP-16","single":true,"match":[{"label":"^(total )?net realized and unrealized","total":true}]},
  {"code":"NAV_OP_NET_INCREASE","name":"Net increase in net assets from operations","section":"OPS","display":"Operations","role":"TOTAL","legacy":"OP-17","single":true,"match":[{"label":"^net increase in net assets (resulting )?from operations$","total":true}]},

  {"code":"NAV_CH_OPERATIONS_HEADER","name":"Operations","section":"CHANGES","display":"Changes in net assets","role":"HEADER","legacy":"CH-01"},
  {"code":"NAV_CH_NET_INVESTMENT_INCOME","name":"Net investment income","section":"CHANGES","display":"Changes in net assets","role":"LINE","legacy":"CH-02","match":[{"label":"^net investment income"}]},
  {"code":"NAV_CH_REALIZED","name":"Net realized gain on investments","section":"CHANGES","display":"Changes in net assets","role":"LINE","legacy":"CH-03","match":[{"label":"^net realized gain"}]},
  {"code":"NAV_CH_UNREALIZED","name":"Net change in unrealized appreciation (depreciation)","section":"CHANGES","display":"Changes in net assets","role":"LINE","legacy":"CH-04","match":[{"label":"^net change in unrealized"},{"label":"^net unrealized"}]},
  {"code":"NAV_CH_NET_OPERATIONS","name":"Net increase from operations","section":"CHANGES","display":"Changes in net assets","role":"SUBTOTAL","legacy":"CH-05","single":true,"match":[{"label":"^net increase (in net assets )?(resulting )?from operations$","total":true}]},
  {"code":"NAV_CH_CAPITAL_HEADER","name":"Capital transactions","section":"CHANGES","display":"Changes in net assets","role":"HEADER","legacy":"CH-06"},
  {"code":"NAV_CH_DISTRIBUTIONS","name":"Distributions to investors","section":"CHANGES","display":"Changes in net assets","role":"LINE","legacy":"CH-08","match":[{"label":"^net (increase|decrease) in net assets (resulting )?from distributions","total":true},{"label":"^total distributions","total":true},{"label":"^distributions to (investors|shareholders|partners|unitholders|common shareholders)$","total":true},{"label":".","section":"^distributions"}]},
  {"code":"NAV_CH_CONTRIBUTIONS","name":"Capital contributions","section":"CHANGES","display":"Changes in net assets","role":"LINE","legacy":"CH-07","match":[{"label":"^(capital contributions|contributions)$"},{"label":"^proceeds from (shares|units|common shares) (sold|issued)"},{"label":"^proceeds from (the )?(issuance|sale) of"},{"label":"^(issuance of (common )?shares|subscriptions|shares sold)"}]},
  {"code":"NAV_CH_REINVESTMENT","name":"Reinvested distributions","section":"CHANGES","display":"Changes in net assets","role":"LINE","match":[{"label":"reinvest"}]},
  {"code":"NAV_CH_REPURCHASES","name":"Repurchases and redemptions","section":"CHANGES","display":"Changes in net assets","role":"LINE","match":[{"label":"^(repurchases?|redemptions?|shares (repurchased|redeemed)|tender|withdrawals)"}]},
  {"code":"NAV_CH_OTHER_CAPITAL","name":"Other capital transactions","section":"CHANGES","display":"Changes in net assets","role":"LINE","match":[{"label":"^(transfers?|exchanges?|conversions?)( of| between| in| out)"}]},
  {"code":"NAV_CH_NET_SHARES","name":"Net increase from share transactions","section":"CHANGES","display":"Changes in net assets","role":"SUBTOTAL","match":[{"label":"^net increase in net assets (resulting )?from (capital )?(share|shares|common share|unit|capital share) transactions$"},{"label":"^net increase from (share|unit) transactions$"}]},
  {"code":"NAV_CH_NET_CAPITAL","name":"Net increase from capital transactions","section":"CHANGES","display":"Changes in net assets","role":"SUBTOTAL","legacy":"CH-09","single":true,"match":[{"label":"^net increase (in net assets )?from capital transactions$","total":true}]},
  {"code":"NAV_CH_NET_HEADER","name":"Net assets","section":"CHANGES","display":"Changes in net assets","role":"HEADER","legacy":"CH-10"},
  {"code":"NAV_CH_TOTAL_INCREASE","name":"Total increase in net assets","section":"CHANGES","display":"Changes in net assets","role":"LINE","legacy":"CH-11","single":true,"match":[{"label":"^(total )?(net )?increase in net assets$","total":true},{"label":"^net change in net assets$","total":true}]},
  {"code":"NAV_CH_BEGINNING","name":"Beginning of period","section":"CHANGES","display":"Changes in net assets","role":"LINE","legacy":"CH-12","single":true,"match":[{"label":"beginning of (the )?(period|year|quarter)$","total":true}]},
  {"code":"NAV_CH_ENDING","name":"End of period","section":"CHANGES","display":"Changes in net assets","role":"TOTAL","legacy":"CH-13","single":true,"match":[{"label":"end of (the )?(period|year|quarter)$","total":true}]},

  {"code":"NAV_CF_OPERATING_HEADER","name":"Operating activities","section":"CASH","display":"Cash flows","role":"HEADER","legacy":"CF-01"},
  {"code":"NAV_CF_NET_OPERATIONS","name":"Net increase in net assets from operations","section":"CASH","display":"Cash flows","role":"LINE","legacy":"CF-02","single":true,"match":[{"label":"^net increase in net assets (resulting )?from operations$","total":true}]},
  {"code":"NAV_CF_NOTE","name":"Adjustments to reconcile to net cash from operations:","section":"CASH","display":"Cash flows","role":"NOTE","legacy":"CF-03"},
  {"code":"NAV_CF_REALIZED","name":"Net realized gain on investments","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"legacy":"CF-04","match":[{"label":"^net realized (gain|loss) on investments$"},{"label":"^net realized (gain|loss)$"},{"label":"^realized (gain|loss) on investments"}]},
  {"code":"NAV_CF_REALIZED_OTHER","name":"Realized gain on currency and derivatives","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"priority":90,"match":[{"label":"^net realized (gain|loss) on .*(currenc|forward|swap|futures|option|derivative)"}]},
  {"code":"NAV_CF_UNREALIZED","name":"Net change in unrealized (appreciation) depreciation","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"legacy":"CF-05","match":[{"label":"^net (change in )?unrealized (appreciation |depreciation |gain |loss )?on investments$"},{"label":"^net change in unrealized( appreciation| depreciation)?$"}]},
  {"code":"NAV_CF_UNREALIZED_OTHER","name":"Unrealized on currency and derivatives","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"priority":90,"match":[{"label":"^net (change in )?unrealized .*(currenc|forward|swap|futures|option|derivative|translation)"}]},
  {"code":"NAV_CF_PIK","name":"PIK interest income","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"legacy":"CF-06","match":[{"label":"^(payment[- ]in[- ]kind|pik)"}]},
  {"code":"NAV_CF_ACCRETION","name":"Net accretion of discount","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"match":[{"label":"accretion"},{"label":"^amortization of (premium|discount)"}]},
  {"code":"NAV_CF_NONCASH_OTHER","name":"Other non-cash items","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"match":[{"label":"^amortization of (deferred|debt|financing)"},{"label":"^(non-cash|noncash)"}]},
  {"code":"NAV_CF_PURCHASES","name":"Purchases of investments","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"legacy":"CF-07","match":[{"label":"^(purchases?|acquisitions?|fundings?) of (investments|portfolio)"},{"label":"^investments purchased"}]},
  {"code":"NAV_CF_PROCEEDS","name":"Proceeds from sales and repayments","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"legacy":"CF-08","match":[{"label":"^proceeds from (the )?(sales?|repayments?|principal|dispositions?|maturities)"},{"label":"^(principal )?repayments? (of|on|from) investments"},{"label":"^sales? of investments"}]},
  {"code":"NAV_CF_DERIVATIVE_SETTLEMENTS","name":"Settlement of derivatives","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"match":[{"label":"settlements? of .*(forward|swap|futures|option|derivative)"}]},
  {"code":"NAV_CF_RECEIVABLE","name":"Increase in interest receivable","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"legacy":"CF-09","match":[{"label":"^(increase in |decrease in |change in )?(interest|dividends?|interest and dividends?) (and fees )?receivable"}]},
  {"code":"NAV_CF_TRADE_SETTLEMENTS","name":"Change in unsettled trades","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"match":[{"label":"(receivables? for investments sold|payables? for investments purchased|due (from|to) brokers?)"}]},
  {"code":"NAV_CF_ACCRUED","name":"Increase in accrued liabilities","section":"CASH","display":"Cash flows","role":"LINE","indent":1,"legacy":"CF-10","match":[{"label":"(payable|accrued|due to|other assets|other liabilities|prepaid|subscriptions? receivable)","section":"operating"}],"fallback":"operating assets and liabilities|changes in operating"},
  {"code":"NAV_CF_NET_OPERATING","name":"Net cash from operating activities","section":"CASH","display":"Cash flows","role":"SUBTOTAL","legacy":"CF-11","single":true,"match":[{"label":"^net cash (provided by |used in |from )?(.* )?operating activities$","total":true}]},
  {"code":"NAV_CF_FINANCING_HEADER","name":"Financing activities","section":"CASH","display":"Cash flows","role":"HEADER","legacy":"CF-12"},
  {"code":"NAV_CF_FACILITY","name":"Borrowings and repayments of debt and credit facility","section":"CASH","display":"Cash flows","role":"LINE","legacy":"CF-15","priority":80,"match":[{"label":"^(borrowings?|repayments?|proceeds|payments?|draws?|drawdowns?|advances?|issuance)( of| on| from| under)? .*(debt|credit facilit|borrowings|notes|revolver|revolving|loans?|subscription (line|facility))"},{"label":"^(borrowings|repayments)$"},{"label":"^repayment of credit facility"}]},
  {"code":"NAV_CF_CONTRIBUTIONS","name":"Capital contributions","section":"CASH","display":"Cash flows","role":"LINE","legacy":"CF-13","match":[{"label":"^proceeds from (the )?(issuance|sale) of (common |preferred )?(shares|units|stock)"},{"label":"^(capital contributions|contributions|subscriptions)"},{"label":"^issuance of (common )?(shares|units)"}]},
  {"code":"NAV_CF_REPURCHASES","name":"Repurchases and redemptions","section":"CASH","display":"Cash flows","role":"LINE","match":[{"label":"^(repurchases?|redemptions?|payments? for (shares|units)|shares repurchased|tender)"}]},
  {"code":"NAV_CF_DISTRIBUTIONS","name":"Distributions paid","section":"CASH","display":"Cash flows","role":"LINE","legacy":"CF-14","match":[{"label":"^(distributions|dividends) (paid|to)"}]},
  {"code":"NAV_CF_OTHER_FINANCING","name":"Other financing activities","section":"CASH","display":"Cash flows","role":"LINE","match":[{"label":"(financing costs|debt issuance costs|offering costs|foreign currency settlements)"}],"fallback":"financing activities"},
  {"code":"NAV_CF_NET_FINANCING","name":"Net cash from financing activities","section":"CASH","display":"Cash flows","role":"SUBTOTAL","legacy":"CF-16","single":true,"match":[{"label":"^net cash (provided by |used in |from )?(.* )?financing activities$","total":true}]},
  {"code":"NAV_CF_CASH_HEADER","name":"Cash","section":"CASH","display":"Cash flows","role":"HEADER","legacy":"CF-17"},
  {"code":"NAV_CF_NET_INCREASE","name":"Net increase in cash","section":"CASH","display":"Cash flows","role":"LINE","legacy":"CF-18","single":true,"match":[{"label":"^net (increase|change) in cash","total":true}]},
  {"code":"NAV_CF_FX_EFFECT","name":"Effect of exchange rate changes on cash","section":"CASH","display":"Cash flows","role":"LINE","single":true,"match":[{"label":"^effect of .*(exchange rate|foreign currency)"}]},
  {"code":"NAV_CF_BEGINNING","name":"Beginning of period","section":"CASH","display":"Cash flows","role":"LINE","legacy":"CF-19","single":true,"match":[{"label":"beginning of (the )?(period|year|quarter)$","total":true}]},
  {"code":"NAV_CF_ENDING","name":"End of period","section":"CASH","display":"Cash flows","role":"TOTAL","legacy":"CF-20","single":true,"match":[{"label":"end of (the )?(period|year|quarter)$","total":true}]},

  {"code":"NAV_RF_BEGINNING","name":"Beginning NAV","section":"ROLL","display":"Roll-forward","role":"LINE","legacy":"RF-01"},
  {"code":"NAV_RF_CONTRIBUTIONS","name":"Capital contributions","section":"ROLL","display":"Roll-forward","role":"LINE","legacy":"RF-02"},
  {"code":"NAV_RF_DISTRIBUTIONS","name":"Distributions","section":"ROLL","display":"Roll-forward","role":"LINE","legacy":"RF-03"},
  {"code":"NAV_RF_NET_INVESTMENT_INCOME","name":"Net investment income","section":"ROLL","display":"Roll-forward","role":"LINE","legacy":"RF-04"},
  {"code":"NAV_RF_REALIZED","name":"Realized gain (Fenwick exit)","section":"ROLL","display":"Roll-forward","role":"LINE","legacy":"RF-05"},
  {"code":"NAV_RF_UNREALIZED","name":"Unrealized change","section":"ROLL","display":"Roll-forward","role":"LINE","legacy":"RF-06"},
  {"code":"NAV_RF_ENDING","name":"Ending NAV","section":"ROLL","display":"Roll-forward","role":"TOTAL","legacy":"RF-07"}
]$chart$::jsonb) AS (
    code text, name text, section text, display text, role text, indent integer,
    reviewable boolean, composition boolean, legacy text, unit text, priority integer,
    single boolean, combine text, fallback text, match jsonb
)) WITH ORDINALITY AS c(
    code, name, section, display, role, indent, reviewable, composition, legacy, unit, priority,
    single, combine, fallback, match, ord
);

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension, validation_rules
)
SELECT c.code, c.name,
       CASE WHEN c.role IN ('HEADER', 'NOTE') THEN 'STRING' WHEN c.unit = 'SHARES' THEN 'NUMBER' ELSE 'CURRENCY' END,
       'Line of the ' || lower(c.display) || ' section on a NAV statement.',
       'NAV_STATEMENT', NULL, FALSE, FALSE, 100,
       c.display, (c.ord * 10)::integer, c.role NOT IN ('HEADER', 'NOTE'), TRUE,
       FALSE, 'NONE',
       jsonb_build_object('navLine', jsonb_strip_nulls(jsonb_build_object(
           'section', c.section,
           'role', c.role,
           'indent', COALESCE(c.indent, 0),
           'reviewable', COALESCE(c.reviewable, FALSE),
           'composition', COALESCE(c.composition, FALSE),
           'legacyId', c.legacy,
           'unit', COALESCE(c.unit, 'AMOUNT'),
           'priority', COALESCE(c.priority, 100),
           'single', COALESCE(c.single, FALSE),
           'combine', COALESCE(c.combine, 'sum'),
           'fallback', c.fallback,
           'match', COALESCE(c.match, '[]'::jsonb)
       )))
FROM nav_chart_v2 c
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    data_type = EXCLUDED.data_type,
    description = EXCLUDED.description,
    domain_code = EXCLUDED.domain_code,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    is_editable = EXCLUDED.is_editable,
    is_visible = EXCLUDED.is_visible,
    validation_rules = EXCLUDED.validation_rules,
    updated_at = NOW();

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

-- ============================================================
-- 3. Templates
-- ============================================================

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order, default_precedence_chain
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0),
       CASE WHEN a.validation_rules ? 'navLine' THEN '["FUND_ADMIN","INTERNAL"]'::jsonb ELSE NULL END
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = 'NAV_STATEMENT_STANDARD'
WHERE a.domain_code = 'NAV_STATEMENT'
  AND (a.validation_rules ? 'navLine' OR a.attribute_code IN ('STATEMENT_COMPARATIVE_DATE', 'STATEMENT_SOURCE_CHECKS'))
ON CONFLICT (template_id, attribute_id) DO UPDATE
SET display_order = EXCLUDED.display_order,
    default_precedence_chain = EXCLUDED.default_precedence_chain;

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, FALSE, 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = 'FUND_STANDARD'
WHERE a.attribute_code IN ('FUND_CAPITAL_MODEL', 'FUND_MGMT_FEE_BASIS', 'FUND_PERF_FEE_BASIS')
ON CONFLICT (template_id, attribute_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
