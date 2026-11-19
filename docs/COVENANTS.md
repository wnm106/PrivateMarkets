# Covenants

A deal's financial covenants are tested from the borrower's quarterly statements, under that deal's own definition. Two hundred deals can define net leverage two hundred ways and still share one calculation.

## Where things live

| Question | Where it is answered |
|---|---|
| How is a covenant calculated in general? | One `DEFINITION` calc, `golden_master.covenant_evaluate` |
| How does this deal define it? | The covenant's `COVENANT_COMPONENT` records (the Definition tab) |
| What is the limit, and when does it change? | `COVENANT_LEVEL` on the covenant, one dated value per step-down |
| When does testing start? | `COVENANT_FIRST_TEST`. Earlier quarters are shown for monitoring and are not scored. |
| What did each quarter give? | The statement's Covenant section (`STATEMENT_COV_*`) |
| Did it pass? | The `COV_*` compliance rules, anchored on `STATEMENT_PERIOD` |

## A definition

Each component is one line of the credit agreement's definition:

- **Statement line**: any line on the borrower's statement, such as term loan, unrestricted cash, EBITDA, or an add-back in the Covenant memo section.
- **Side**: numerator or denominator. A covenant with no denominator lines is an amount, such as liquidity.
- **Sign**: add or subtract.
- **Period**: last four quarters, the test quarter, the test quarter × 4, or the balance at the test date.
- **Cap**: none, an amount, or a percent of the side's uncapped lines (an add-back limited to 15% of EBITDA).
- **Effective from / to**: an amendment closes the old lines and adds new ones, so a past quarter keeps the definition it was tested under.
- **Clause**: where the agreement says so.

Uncapped lines on a side add up to that side's base. Each capped line is limited before its sign is applied. The value is numerator ÷ denominator.

## The library and the house standard

Library definitions are `DEAL_COVENANT` records with `COVENANT_IS_LIBRARY` and no deal. A covenant's Test tab copies one from a first quarter you choose; lines in force on that date end the day before.

One library definition per metric is also `COVENANT_IS_HOUSE`. It is computed for every deal with that metric next to the deal's own value, so deals can be compared and a large gap (a generous EBITDA definition) stands out.

## Values

- `COVENANT_CURRENT` on the covenant is the calculated value, stored for every quarter end. The borrower's compliance certificate is another source on the same attribute (`BORROWER_CERTIFICATE`). The calculation stays the golden value; a manual entry overrides it.
- Each statement's Covenant section holds, per metric, the value under the deal's definition for that quarter and the limit in force on that quarter end. The limit is blank before the first test.

Editing a component or a statement line queues the covenant and the borrower's statements for recalculation. The covenant's Test tab shows when the stored value is behind and can recalculate it at once (`recalculate_covenant`), which also rewrites the borrower's statements.

## Compliance

`COV_NET_LEVERAGE`, `COV_TOTAL_LEVERAGE`, `COV_INTEREST_COVERAGE`, `COV_FIXED_CHARGE`, and `COV_LIQUIDITY` read the statement's value as the numerator and the statement's limit attribute as the hard limit (`hard_limit_attribute_code`). Leverage rules warn within 10% of the limit (`soft_limit_factor` 0.9). Every quarter that has ended, has a covenant of the metric, and is on or after the first test is scored.

These rules set `score_all_anchors` in their version metadata, so `compliance.evaluate_rule` scores every statement without the per-fund enrollment rows that fund rules need.

The rule editor shows the anchor filters and the limit attribute as fixed parts of the rule, and saving a new version keeps them, along with the soft limit factor, the version metadata (including `score_all_anchors`) and fund consolidation.

## The assistant

The covenant Test tab publishes the test as it shows it (value, level, status, certificate, house standard, each line and the quarter-end history) through `covenantTabPayload` in `apps/web/lib/covenant-tab.ts`. The record page keeps that tab mounted while it is closed, so the assistant can answer about it from any tab. The deal's Servicing tab publishes each covenant's calculated, certificate and house values.

## Functions

- `public.covenant_test(covenant, as_of, history)`: one covenant, line by line, with quarter-end history.
- `public.deal_covenant_tests(deal, as_of)`: every covenant on a deal.
- `public.covenant_library(as_of)`: definitions to copy from.
- `public.copy_covenant_definition(covenant, from, effective_from)`: copy a definition from a date.
- `public.recalculate_covenant(covenant)`: store the covenant and its borrower's statements again.
