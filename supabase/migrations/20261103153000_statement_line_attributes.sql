-- Statement lines on the deal Financials tab are attributes.
-- The page reads names, order, sign, and formulas from the register.
-- Arithmetic, prior period, trailing windows, and cumulative totals stay
-- virtual: the statement evaluates the formula when it draws the column.

ALTER TABLE metadata_register.attribute_register DISABLE TRIGGER trg_validate_derived_attribute;

CREATE TEMP TABLE statement_lines (
    code text PRIMARY KEY,
    name text NOT NULL,
    data_type text NOT NULL,
    description text NOT NULL,
    section text NOT NULL,
    display_group integer NOT NULL,
    editable boolean NOT NULL,
    visible boolean NOT NULL,
    display_format text,
    formula jsonb,
    deps jsonb NOT NULL,
    line jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO statement_lines (code, name, data_type, description, section, display_group, editable, visible, display_format, formula, deps, line)
SELECT v.code, v.name, v.data_type, v.description, v.section, v.display_group, v.editable, v.visible, NULLIF(v.display_format, ''), v.formula, v.deps, v.line
FROM jsonb_to_recordset($stmt$
[
  {"code":"STATEMENT_END","name":"Period end","data_type":"DATE","description":"Quarter-end date","section":"Period","display_group":1,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"placement":"caption","rollup":"NONE"}},
  {"code":"STATEMENT_REVENUE","name":"Revenue","data_type":"CURRENCY","description":"Revenue for the quarter","section":"Income statement","display_group":10,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"SUM","placement":"grid"}},
  {"code":"STATEMENT_COGS","name":"Cost of revenue","data_type":"CURRENCY","description":"Cost of revenue for the quarter","section":"Income statement","display_group":20,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"SUM","indent":true,"sign":-1,"placement":"grid"}},
  {"code":"STATEMENT_GROSS_PROFIT","name":"Gross profit","data_type":"CURRENCY","description":"Revenue less cost of revenue","section":"Income statement","display_group":30,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"ref":"STATEMENT_REVENUE"},{"ref":"STATEMENT_COGS"}]},"deps":["STATEMENT_REVENUE","STATEMENT_COGS"],"line":{"rollup":"SUM","role":"sub","placement":"grid"}},
  {"code":"STATEMENT_SM","name":"Sales and marketing","data_type":"CURRENCY","description":"Sales and marketing expense for the quarter","section":"Income statement","display_group":40,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"SUM","indent":true,"sign":-1,"placement":"grid"}},
  {"code":"STATEMENT_RD","name":"Research and development","data_type":"CURRENCY","description":"Research and development expense for the quarter","section":"Income statement","display_group":50,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"SUM","indent":true,"sign":-1,"placement":"grid"}},
  {"code":"STATEMENT_GA","name":"General and administrative","data_type":"CURRENCY","description":"General and administrative expense for the quarter","section":"Income statement","display_group":60,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"SUM","indent":true,"sign":-1,"placement":"grid"}},
  {"code":"STATEMENT_OPEX","name":"Total operating expenses","data_type":"CURRENCY","description":"Sales and marketing, research and development, and general and administrative","section":"Income statement","display_group":70,"editable":false,"visible":true,"display_format":"","formula":{"op":"add","args":[{"op":"add","args":[{"ref":"STATEMENT_SM"},{"ref":"STATEMENT_RD"}]},{"ref":"STATEMENT_GA"}]},"deps":["STATEMENT_SM","STATEMENT_RD","STATEMENT_GA"],"line":{"rollup":"SUM","role":"sub","sign":-1,"placement":"grid"}},
  {"code":"STATEMENT_EBITDA","name":"EBITDA","data_type":"CURRENCY","description":"Gross profit less operating expenses","section":"Income statement","display_group":80,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"ref":"STATEMENT_GROSS_PROFIT"},{"ref":"STATEMENT_OPEX"}]},"deps":["STATEMENT_GROSS_PROFIT","STATEMENT_OPEX"],"line":{"rollup":"SUM","role":"total","placement":"grid"}},
  {"code":"STATEMENT_DA","name":"Depreciation and amortization","data_type":"CURRENCY","description":"Depreciation and amortization for the quarter","section":"Income statement","display_group":90,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"SUM","indent":true,"sign":-1,"placement":"grid"}},
  {"code":"STATEMENT_EBIT","name":"Operating income (EBIT)","data_type":"CURRENCY","description":"EBITDA less depreciation and amortization","section":"Income statement","display_group":100,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"ref":"STATEMENT_EBITDA"},{"ref":"STATEMENT_DA"}]},"deps":["STATEMENT_EBITDA","STATEMENT_DA"],"line":{"rollup":"SUM","role":"total","placement":"grid"}},
  {"code":"STATEMENT_INTEREST","name":"Interest expense","data_type":"CURRENCY","description":"Interest expense for the quarter","section":"Income statement","display_group":110,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"SUM","indent":true,"sign":-1,"placement":"grid"}},
  {"code":"STATEMENT_PRETAX","name":"Pre-tax income","data_type":"CURRENCY","description":"Operating income less interest expense","section":"Income statement","display_group":120,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"ref":"STATEMENT_EBIT"},{"ref":"STATEMENT_INTEREST"}]},"deps":["STATEMENT_EBIT","STATEMENT_INTEREST"],"line":{"rollup":"SUM","role":"total","placement":"grid"}},
  {"code":"STATEMENT_TAX","name":"Income tax","data_type":"CURRENCY","description":"Income tax expense for the quarter","section":"Income statement","display_group":130,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"SUM","indent":true,"sign":-1,"placement":"grid"}},
  {"code":"STATEMENT_NET_INCOME","name":"Net income","data_type":"CURRENCY","description":"Pre-tax income less income tax","section":"Income statement","display_group":140,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"ref":"STATEMENT_PRETAX"},{"ref":"STATEMENT_TAX"}]},"deps":["STATEMENT_PRETAX","STATEMENT_TAX"],"line":{"rollup":"SUM","role":"net","placement":"grid"}},
  {"code":"STATEMENT_GROSS_MARGIN","name":"Gross margin","data_type":"NUMBER","description":"Gross profit divided by revenue","section":"Income statement","display_group":150,"editable":false,"visible":true,"display_format":"ratio","formula":{"op":"div","args":[{"ref":"STATEMENT_GROSS_PROFIT"},{"ref":"STATEMENT_REVENUE"}]},"deps":["STATEMENT_GROSS_PROFIT","STATEMENT_REVENUE"],"line":{"rollup":"NONE","role":"ratio","placement":"grid"}},
  {"code":"STATEMENT_EBITDA_MARGIN","name":"EBITDA margin","data_type":"NUMBER","description":"EBITDA divided by revenue","section":"Income statement","display_group":160,"editable":false,"visible":true,"display_format":"ratio","formula":{"op":"div","args":[{"ref":"STATEMENT_EBITDA"},{"ref":"STATEMENT_REVENUE"}]},"deps":["STATEMENT_EBITDA","STATEMENT_REVENUE"],"line":{"rollup":"NONE","role":"ratio","placement":"grid"}},
  {"code":"STATEMENT_NET_MARGIN","name":"Net margin","data_type":"NUMBER","description":"Net income divided by revenue","section":"Income statement","display_group":170,"editable":false,"visible":true,"display_format":"ratio","formula":{"op":"div","args":[{"ref":"STATEMENT_NET_INCOME"},{"ref":"STATEMENT_REVENUE"}]},"deps":["STATEMENT_NET_INCOME","STATEMENT_REVENUE"],"line":{"rollup":"NONE","role":"ratio","placement":"grid"}},
  {"code":"STATEMENT_LTM_REVENUE","name":"LTM revenue","data_type":"CURRENCY","description":"Revenue for the four quarters through this period","section":"Income statement","display_group":180,"editable":false,"visible":true,"display_format":"","formula":{"op":"trail","periods":4,"args":[{"ref":"STATEMENT_REVENUE"}]},"deps":["STATEMENT_REVENUE"],"line":{"rollup":"NONE","role":"line","placement":"both","headlineOrder":1,"hideWhen":["statement"],"captionDate":"short","captionPrefix":"Twelve months to "}},
  {"code":"STATEMENT_LTM_EBITDA","name":"LTM EBITDA","data_type":"CURRENCY","description":"EBITDA for the four quarters through this period","section":"Income statement","display_group":190,"editable":false,"visible":true,"display_format":"","formula":{"op":"trail","periods":4,"args":[{"ref":"STATEMENT_EBITDA"}]},"deps":["STATEMENT_EBITDA"],"line":{"rollup":"NONE","role":"line","placement":"both","headlineOrder":2,"hideWhen":["statement"],"captionCode":"STATEMENT_LTM_EBITDA_MARGIN","captionSuffix":" margin"}},
  {"code":"STATEMENT_LTM_EBITDA_MARGIN","name":"LTM EBITDA margin","data_type":"NUMBER","description":"Trailing EBITDA divided by trailing revenue","section":"Income statement","display_group":200,"editable":false,"visible":true,"display_format":"ratio","formula":{"op":"div","args":[{"ref":"STATEMENT_LTM_EBITDA"},{"ref":"STATEMENT_LTM_REVENUE"}]},"deps":["STATEMENT_LTM_EBITDA","STATEMENT_LTM_REVENUE"],"line":{"rollup":"NONE","role":"ratio","placement":"grid","hideWhen":["statement"]}},

  {"code":"STATEMENT_BAND_ASSETS","name":"Assets","data_type":"STRING","description":"Balance sheet assets","section":"Balance sheet","display_group":10,"editable":false,"visible":false,"display_format":"","formula":null,"deps":[],"line":{"role":"section","placement":"grid","rollup":"NONE"}},
  {"code":"STATEMENT_CASH","name":"Cash and equivalents","data_type":"CURRENCY","description":"Cash and equivalents at quarter end","section":"Balance sheet","display_group":20,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"PERIOD_END","indent":true,"placement":"both","headlineOrder":3,"captionDate":"long"}},
  {"code":"STATEMENT_AR","name":"Accounts receivable","data_type":"CURRENCY","description":"Accounts receivable at quarter end","section":"Balance sheet","display_group":30,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"PERIOD_END","indent":true,"placement":"grid"}},
  {"code":"STATEMENT_PREPAID","name":"Prepaid expenses","data_type":"CURRENCY","description":"Prepaid expenses at quarter end","section":"Balance sheet","display_group":40,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"PERIOD_END","indent":true,"placement":"grid"}},
  {"code":"STATEMENT_CURRENT_ASSETS","name":"Total current assets","data_type":"CURRENCY","description":"Cash, receivables, and prepaids","section":"Balance sheet","display_group":50,"editable":false,"visible":true,"display_format":"","formula":{"op":"add","args":[{"op":"add","args":[{"ref":"STATEMENT_CASH"},{"ref":"STATEMENT_AR"}]},{"ref":"STATEMENT_PREPAID"}]},"deps":["STATEMENT_CASH","STATEMENT_AR","STATEMENT_PREPAID"],"line":{"rollup":"PERIOD_END","role":"sub","placement":"grid"}},
  {"code":"STATEMENT_PPE","name":"Property and equipment, net","data_type":"CURRENCY","description":"Property and equipment, net, at quarter end","section":"Balance sheet","display_group":60,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"PERIOD_END","indent":true,"placement":"grid"}},
  {"code":"STATEMENT_GOODWILL","name":"Goodwill and intangibles","data_type":"CURRENCY","description":"Goodwill and intangibles at quarter end","section":"Balance sheet","display_group":70,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"PERIOD_END","indent":true,"placement":"grid"}},
  {"code":"STATEMENT_TOTAL_ASSETS","name":"Total assets","data_type":"CURRENCY","description":"Current assets plus property and goodwill","section":"Balance sheet","display_group":80,"editable":false,"visible":true,"display_format":"","formula":{"op":"add","args":[{"op":"add","args":[{"ref":"STATEMENT_CURRENT_ASSETS"},{"ref":"STATEMENT_PPE"}]},{"ref":"STATEMENT_GOODWILL"}]},"deps":["STATEMENT_CURRENT_ASSETS","STATEMENT_PPE","STATEMENT_GOODWILL"],"line":{"rollup":"PERIOD_END","role":"net","placement":"grid"}},
  {"code":"STATEMENT_BAND_LIABILITIES","name":"Liabilities","data_type":"STRING","description":"Balance sheet liabilities","section":"Balance sheet","display_group":90,"editable":false,"visible":false,"display_format":"","formula":null,"deps":[],"line":{"role":"section","placement":"grid","rollup":"NONE"}},
  {"code":"STATEMENT_AP","name":"Accounts payable","data_type":"CURRENCY","description":"Accounts payable at quarter end","section":"Balance sheet","display_group":100,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"PERIOD_END","indent":true,"placement":"grid"}},
  {"code":"STATEMENT_ACCRUED","name":"Accrued liabilities","data_type":"CURRENCY","description":"Accrued liabilities at quarter end","section":"Balance sheet","display_group":110,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"PERIOD_END","indent":true,"placement":"grid"}},
  {"code":"STATEMENT_DEFERRED","name":"Deferred revenue","data_type":"CURRENCY","description":"Deferred revenue at quarter end","section":"Balance sheet","display_group":120,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"PERIOD_END","indent":true,"placement":"grid"}},
  {"code":"STATEMENT_CURRENT_LIABILITIES","name":"Total current liabilities","data_type":"CURRENCY","description":"Payables, accruals, and deferred revenue","section":"Balance sheet","display_group":130,"editable":false,"visible":true,"display_format":"","formula":{"op":"add","args":[{"op":"add","args":[{"ref":"STATEMENT_AP"},{"ref":"STATEMENT_ACCRUED"}]},{"ref":"STATEMENT_DEFERRED"}]},"deps":["STATEMENT_AP","STATEMENT_ACCRUED","STATEMENT_DEFERRED"],"line":{"rollup":"PERIOD_END","role":"sub","placement":"grid"}},
  {"code":"STATEMENT_DEBT","name":"Term loan","data_type":"CURRENCY","description":"Term loan at quarter end","section":"Balance sheet","display_group":140,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"PERIOD_END","indent":true,"placement":"both","headlineOrder":4,"captionCode":"STATEMENT_LEVERAGE","captionSuffix":" LTM EBITDA"}},
  {"code":"STATEMENT_TOTAL_LIABILITIES","name":"Total liabilities","data_type":"CURRENCY","description":"Current liabilities plus the term loan","section":"Balance sheet","display_group":150,"editable":false,"visible":true,"display_format":"","formula":{"op":"add","args":[{"ref":"STATEMENT_CURRENT_LIABILITIES"},{"ref":"STATEMENT_DEBT"}]},"deps":["STATEMENT_CURRENT_LIABILITIES","STATEMENT_DEBT"],"line":{"rollup":"PERIOD_END","role":"sub","placement":"grid"}},
  {"code":"STATEMENT_BAND_EQUITY","name":"Equity","data_type":"STRING","description":"Balance sheet equity","section":"Balance sheet","display_group":160,"editable":false,"visible":false,"display_format":"","formula":null,"deps":[],"line":{"role":"section","placement":"grid","rollup":"NONE"}},
  {"code":"STATEMENT_CONTRIBUTED","name":"Contributed capital and opening reserves","data_type":"CURRENCY","description":"Contributed capital and opening reserves","section":"Balance sheet","display_group":170,"editable":true,"visible":true,"display_format":"","formula":null,"deps":[],"line":{"rollup":"PERIOD_END","indent":true,"placement":"grid"}},
  {"code":"STATEMENT_RETAINED","name":"Retained earnings","data_type":"CURRENCY","description":"Cumulative net income","section":"Balance sheet","display_group":180,"editable":false,"visible":true,"display_format":"","formula":{"op":"cumsum","args":[{"ref":"STATEMENT_NET_INCOME"}]},"deps":["STATEMENT_NET_INCOME"],"line":{"rollup":"PERIOD_END","indent":true,"placement":"grid"}},
  {"code":"STATEMENT_TOTAL_EQUITY","name":"Total equity","data_type":"CURRENCY","description":"Contributed capital plus retained earnings","section":"Balance sheet","display_group":190,"editable":false,"visible":true,"display_format":"","formula":{"op":"add","args":[{"ref":"STATEMENT_CONTRIBUTED"},{"ref":"STATEMENT_RETAINED"}]},"deps":["STATEMENT_CONTRIBUTED","STATEMENT_RETAINED"],"line":{"rollup":"PERIOD_END","role":"sub","placement":"grid"}},
  {"code":"STATEMENT_TOTAL_LIABILITIES_EQUITY","name":"Total liabilities and equity","data_type":"CURRENCY","description":"Total liabilities plus total equity","section":"Balance sheet","display_group":200,"editable":false,"visible":true,"display_format":"","formula":{"op":"add","args":[{"ref":"STATEMENT_TOTAL_LIABILITIES"},{"ref":"STATEMENT_TOTAL_EQUITY"}]},"deps":["STATEMENT_TOTAL_LIABILITIES","STATEMENT_TOTAL_EQUITY"],"line":{"rollup":"PERIOD_END","role":"net","placement":"grid"}},
  {"code":"STATEMENT_BALANCE_CHECK","name":"Check: assets less liabilities and equity","data_type":"CURRENCY","description":"Total assets less total liabilities and equity","section":"Balance sheet","display_group":210,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"ref":"STATEMENT_TOTAL_ASSETS"},{"ref":"STATEMENT_TOTAL_LIABILITIES_EQUITY"}]},"deps":["STATEMENT_TOTAL_ASSETS","STATEMENT_TOTAL_LIABILITIES_EQUITY"],"line":{"rollup":"PERIOD_END","role":"ratio","placement":"grid"}},

  {"code":"STATEMENT_BAND_CFO","name":"Operating activities","data_type":"STRING","description":"Cash from operations","section":"Cash flow statement","display_group":10,"editable":false,"visible":false,"display_format":"","formula":null,"deps":[],"line":{"role":"section","placement":"grid","rollup":"NONE"}},
  {"code":"STATEMENT_CF_NET_INCOME","name":"Net income","data_type":"CURRENCY","description":"Net income on the cash flow statement","section":"Cash flow statement","display_group":20,"editable":false,"visible":true,"display_format":"","formula":{"ref":"STATEMENT_NET_INCOME"},"deps":["STATEMENT_NET_INCOME"],"line":{"rollup":"SUM","indent":true,"placement":"grid"}},
  {"code":"STATEMENT_CF_DA","name":"Depreciation and amortization","data_type":"CURRENCY","description":"Depreciation and amortization added back","section":"Cash flow statement","display_group":30,"editable":false,"visible":true,"display_format":"","formula":{"op":"when_prior","args":[{"ref":"STATEMENT_DA"}]},"deps":["STATEMENT_DA"],"line":{"rollup":"SUM","indent":true,"blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_CF_AR","name":"Change in accounts receivable","data_type":"CURRENCY","description":"Prior receivables less this period","section":"Cash flow statement","display_group":40,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"op":"prior","args":[{"ref":"STATEMENT_AR"}]},{"ref":"STATEMENT_AR"}]},"deps":["STATEMENT_AR"],"line":{"rollup":"SUM","indent":true,"blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_CF_PREPAID","name":"Change in prepaids","data_type":"CURRENCY","description":"Prior prepaids less this period","section":"Cash flow statement","display_group":50,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"op":"prior","args":[{"ref":"STATEMENT_PREPAID"}]},{"ref":"STATEMENT_PREPAID"}]},"deps":["STATEMENT_PREPAID"],"line":{"rollup":"SUM","indent":true,"blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_CF_AP","name":"Change in accounts payable","data_type":"CURRENCY","description":"This period's payables less the prior period","section":"Cash flow statement","display_group":60,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"ref":"STATEMENT_AP"},{"op":"prior","args":[{"ref":"STATEMENT_AP"}]}]},"deps":["STATEMENT_AP"],"line":{"rollup":"SUM","indent":true,"blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_CF_ACCRUED","name":"Change in accrued liabilities","data_type":"CURRENCY","description":"This period's accruals less the prior period","section":"Cash flow statement","display_group":70,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"ref":"STATEMENT_ACCRUED"},{"op":"prior","args":[{"ref":"STATEMENT_ACCRUED"}]}]},"deps":["STATEMENT_ACCRUED"],"line":{"rollup":"SUM","indent":true,"blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_CF_DEFERRED","name":"Change in deferred revenue","data_type":"CURRENCY","description":"This period's deferred revenue less the prior period","section":"Cash flow statement","display_group":80,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"ref":"STATEMENT_DEFERRED"},{"op":"prior","args":[{"ref":"STATEMENT_DEFERRED"}]}]},"deps":["STATEMENT_DEFERRED"],"line":{"rollup":"SUM","indent":true,"blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_CFO","name":"Cash from operations","data_type":"CURRENCY","description":"Net income, depreciation, and working-capital changes","section":"Cash flow statement","display_group":90,"editable":false,"visible":true,"display_format":"","formula":{"op":"add","args":[{"op":"add","args":[{"op":"add","args":[{"op":"add","args":[{"op":"add","args":[{"op":"add","args":[{"ref":"STATEMENT_CF_NET_INCOME"},{"ref":"STATEMENT_CF_DA"}]},{"ref":"STATEMENT_CF_AR"}]},{"ref":"STATEMENT_CF_PREPAID"}]},{"ref":"STATEMENT_CF_AP"}]},{"ref":"STATEMENT_CF_ACCRUED"}]},{"ref":"STATEMENT_CF_DEFERRED"}]},"deps":["STATEMENT_CF_NET_INCOME","STATEMENT_CF_DA","STATEMENT_CF_AR","STATEMENT_CF_PREPAID","STATEMENT_CF_AP","STATEMENT_CF_ACCRUED","STATEMENT_CF_DEFERRED"],"line":{"rollup":"SUM","role":"sub","blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_BAND_CFI","name":"Investing activities","data_type":"STRING","description":"Cash from investing","section":"Cash flow statement","display_group":100,"editable":false,"visible":false,"display_format":"","formula":null,"deps":[],"line":{"role":"section","placement":"grid","rollup":"NONE"}},
  {"code":"STATEMENT_CAPEX","name":"Capital expenditures","data_type":"CURRENCY","description":"Growth in property and equipment, after depreciation","section":"Cash flow statement","display_group":110,"editable":false,"visible":true,"display_format":"","formula":{"op":"neg","args":[{"op":"add","args":[{"op":"sub","args":[{"ref":"STATEMENT_PPE"},{"op":"prior","args":[{"ref":"STATEMENT_PPE"}]}]},{"ref":"STATEMENT_DA"}]}]},"deps":["STATEMENT_PPE","STATEMENT_DA"],"line":{"rollup":"SUM","indent":true,"blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_CFI","name":"Cash from investing","data_type":"CURRENCY","description":"Capital expenditures","section":"Cash flow statement","display_group":120,"editable":false,"visible":true,"display_format":"","formula":{"ref":"STATEMENT_CAPEX"},"deps":["STATEMENT_CAPEX"],"line":{"rollup":"SUM","role":"sub","blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_BAND_CFF","name":"Financing activities","data_type":"STRING","description":"Cash from financing","section":"Cash flow statement","display_group":130,"editable":false,"visible":false,"display_format":"","formula":null,"deps":[],"line":{"role":"section","placement":"grid","rollup":"NONE"}},
  {"code":"STATEMENT_CF_DEBT","name":"Term loan amortization","data_type":"CURRENCY","description":"Change in the term loan","section":"Cash flow statement","display_group":140,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"ref":"STATEMENT_DEBT"},{"op":"prior","args":[{"ref":"STATEMENT_DEBT"}]}]},"deps":["STATEMENT_DEBT"],"line":{"rollup":"SUM","indent":true,"blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_CFF","name":"Cash from financing","data_type":"CURRENCY","description":"Term loan amortization","section":"Cash flow statement","display_group":150,"editable":false,"visible":true,"display_format":"","formula":{"ref":"STATEMENT_CF_DEBT"},"deps":["STATEMENT_CF_DEBT"],"line":{"rollup":"SUM","role":"sub","blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_NET_CHANGE","name":"Net change in cash","data_type":"CURRENCY","description":"Operating, investing, and financing cash flows","section":"Cash flow statement","display_group":160,"editable":false,"visible":true,"display_format":"","formula":{"op":"add","args":[{"op":"add","args":[{"ref":"STATEMENT_CFO"},{"ref":"STATEMENT_CFI"}]},{"ref":"STATEMENT_CFF"}]},"deps":["STATEMENT_CFO","STATEMENT_CFI","STATEMENT_CFF"],"line":{"rollup":"SUM","role":"total","blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_BEGINNING_CASH","name":"Beginning cash","data_type":"CURRENCY","description":"Cash at the prior period end","section":"Cash flow statement","display_group":170,"editable":false,"visible":true,"display_format":"","formula":{"op":"prior","args":[{"ref":"STATEMENT_CASH"}]},"deps":["STATEMENT_CASH"],"line":{"rollup":"NONE","indent":true,"blankZero":true,"placement":"grid"}},
  {"code":"STATEMENT_ENDING_CASH","name":"Ending cash","data_type":"CURRENCY","description":"Cash and equivalents at period end","section":"Cash flow statement","display_group":180,"editable":false,"visible":true,"display_format":"","formula":{"ref":"STATEMENT_CASH"},"deps":["STATEMENT_CASH"],"line":{"rollup":"PERIOD_END","role":"net","placement":"grid"}},

  {"code":"STATEMENT_NET_DEBT","name":"Net debt","data_type":"CURRENCY","description":"Term loan less cash","section":"Highlights","display_group":10,"editable":false,"visible":true,"display_format":"","formula":{"op":"sub","args":[{"ref":"STATEMENT_DEBT"},{"ref":"STATEMENT_CASH"}]},"deps":["STATEMENT_DEBT","STATEMENT_CASH"],"line":{"rollup":"PERIOD_END","placement":"headline","headlineOrder":5,"captionCode":"STATEMENT_NET_LEVERAGE","captionSuffix":" LTM EBITDA"}},
  {"code":"STATEMENT_LEVERAGE","name":"LTM EBITDA leverage","data_type":"NUMBER","description":"Term loan divided by trailing EBITDA","section":"Highlights","display_group":20,"editable":false,"visible":true,"display_format":"multiple","formula":{"op":"div","args":[{"ref":"STATEMENT_DEBT"},{"ref":"STATEMENT_LTM_EBITDA"}]},"deps":["STATEMENT_DEBT","STATEMENT_LTM_EBITDA"],"line":{"rollup":"NONE","placement":"caption"}},
  {"code":"STATEMENT_NET_LEVERAGE","name":"LTM EBITDA net leverage","data_type":"NUMBER","description":"Net debt divided by trailing EBITDA","section":"Highlights","display_group":30,"editable":false,"visible":true,"display_format":"multiple","formula":{"op":"div","args":[{"ref":"STATEMENT_NET_DEBT"},{"ref":"STATEMENT_LTM_EBITDA"}]},"deps":["STATEMENT_NET_DEBT","STATEMENT_LTM_EBITDA"],"line":{"rollup":"NONE","placement":"caption"}}
]
$stmt$) AS v(
    code text,
    name text,
    data_type text,
    description text,
    section text,
    display_group integer,
    editable boolean,
    visible boolean,
    display_format text,
    formula jsonb,
    deps jsonb,
    line jsonb
);

INSERT INTO metadata_register.attribute_register (
    attribute_code, attribute_name, data_type, description, domain_code,
    reference_list_code, is_multi_valued, is_required, default_precedence_rank,
    display_section, display_group, is_editable, is_visible,
    is_time_varying, time_dimension, display_format,
    reporting_grain, period_rollup, validation_rules,
    is_derived, derivation_type, derivation_formula, derivation_dependencies, formula_language
)
SELECT s.code, s.name, s.data_type, s.description, 'STATEMENT_PERIOD',
       NULL, FALSE, FALSE, 100,
       s.section, s.display_group, s.editable, s.visible,
       FALSE, 'NONE', NULLIF(s.display_format, ''),
       CASE WHEN s.data_type = 'STRING' THEN NULL ELSE 'QUARTERLY' END,
       COALESCE(s.line->>'rollup', 'NONE'),
       jsonb_build_object('statementLine', s.line),
       FALSE, NULL, NULL, '[]'::jsonb, 'SQL'
FROM statement_lines s
ON CONFLICT (attribute_code) DO UPDATE
SET attribute_name = EXCLUDED.attribute_name,
    description = EXCLUDED.description,
    data_type = EXCLUDED.data_type,
    domain_code = EXCLUDED.domain_code,
    display_section = EXCLUDED.display_section,
    display_group = EXCLUDED.display_group,
    is_editable = EXCLUDED.is_editable,
    is_visible = EXCLUDED.is_visible,
    display_format = EXCLUDED.display_format,
    reporting_grain = EXCLUDED.reporting_grain,
    period_rollup = EXCLUDED.period_rollup,
    validation_rules = EXCLUDED.validation_rules,
    is_derived = FALSE,
    derivation_type = NULL,
    derivation_formula = NULL,
    derivation_dependencies = '[]'::jsonb,
    formula_language = 'SQL',
    updated_at = NOW();

ALTER TABLE metadata_register.attribute_register ENABLE TRIGGER trg_validate_derived_attribute;

UPDATE metadata_register.attribute_register AS a
SET is_derived = TRUE,
    derivation_type = 'CUSTOM',
    derivation_formula = s.formula::text,
    derivation_dependencies = s.deps,
    formula_language = 'CALC_SPEC',
    is_editable = FALSE,
    updated_at = NOW()
FROM statement_lines s
WHERE a.attribute_code = s.code
  AND s.formula IS NOT NULL;

INSERT INTO metadata_register.attribute_sections (domain_code, section_name, display_order, client_id)
SELECT 'STATEMENT_PERIOD', v.name, v.ord, dt.client_id
FROM (VALUES
    ('Period', 0),
    ('Income statement', 10),
    ('Balance sheet', 20),
    ('Cash flow statement', 30),
    ('Highlights', 40)
) AS v(name, ord)
JOIN metadata_register.domain_types dt ON dt.domain_code = 'STATEMENT_PERIOD'
WHERE NOT EXISTS (
    SELECT 1 FROM metadata_register.attribute_sections existing
    WHERE existing.domain_code = 'STATEMENT_PERIOD'
      AND lower(existing.section_name) = lower(v.name)
);

UPDATE metadata_register.attribute_sections AS section
SET display_order = v.ord,
    updated_at = NOW()
FROM (VALUES
    ('Period', 0),
    ('Income statement', 10),
    ('Balance sheet', 20),
    ('Cash flow statement', 30),
    ('Highlights', 40)
) AS v(name, ord)
WHERE section.domain_code = 'STATEMENT_PERIOD'
  AND lower(section.section_name) = lower(v.name);

DELETE FROM metadata_register.attribute_sections AS section
WHERE section.domain_code = 'STATEMENT_PERIOD'
  AND NOT EXISTS (
      SELECT 1 FROM metadata_register.attribute_register AS attr
      WHERE attr.domain_code = section.domain_code
        AND lower(btrim(COALESCE(attr.display_section, ''))) = lower(section.section_name)
  );

INSERT INTO metadata_register.template_attribute_assignments (
    template_id, attribute_id, is_required, precedence_rank, display_order
)
SELECT t.id, a.id, a.attribute_code IN ('STATEMENT_END', 'STATEMENT_REVENUE'), 100, COALESCE(a.display_group, 0)
FROM metadata_register.attribute_register a
JOIN metadata_register.domain_templates t ON t.template_code = 'STATEMENT_PERIOD_STANDARD'
WHERE a.domain_code = 'STATEMENT_PERIOD'
ON CONFLICT (template_id, attribute_id) DO UPDATE
SET display_order = EXCLUDED.display_order;
