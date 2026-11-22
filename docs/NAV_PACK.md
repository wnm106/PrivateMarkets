# The NAV pack

An administrator's quarter-end NAV pack has ten parts. The NAV reconciliation checks each of them against the statements and against each other, says part by part what is on file and whether it ties, and puts every break in the same break summary the workflow keeps as the period's notes.

| Part | Where it comes from | What is checked |
|---|---|---|
| 1. NAV summary and bridge | The statements | Opening NAV + contributions + distributions + other capital movements + income − expenses + realized + unrealized + FX = closing NAV (`bridge`). Gains are what operations add beyond net investment income, split as the statement splits them; FX is its own step when the statement prints currency gains. Also the reconciliation's opening, roll-forward and changes checks |
| 2. Trial balance | `TRIAL_BALANCE_LINE` records | Debits equal credits (`tbBalances`). Asset accounts vs total assets, liability accounts vs total liabilities, capital with income, expenses and gains vs net assets (`tbAssets`, `tbLiabilities`, `tbCapital`). Income and expense accounts vs the statement of operations when the ledger runs from the same date as the statement (`tbIncome`, `tbExpenses`). Accounts mapped to a statement line (`TB_NAV_LINE`) add up to it (`tbLines`) |
| 3. Financial statements | The statements, the notes flag | The reconciliation's statement checks (balance, footing, operations vs cash flows, cash, schedule, investment roll). The part is Partial until the notes are on file (`STATEMENT_NOTES_INCLUDED`, set when a filed report is read and its notes are found) |
| 4. Capital account summary (PCAP) | `CAPITAL_ACCOUNT` records, one per investor per period, linked to the fund and the investor | Each account rolls: opening + contributions − distributions + allocated profit or loss + carry + other = closing (`pcapRoll`, naming the investors that do not). Investors together vs net assets, opening NAV, contributions, distributions, and the net increase from operations with carry (`pcapNav`, `pcapOpening`, `pcapContrib`, `pcapDist`, `pcapPnl`). Ownership adds up to 100% (`pcapOwnership`) |
| 5. Management fee | Fund terms, capital accounts | The fund's fee recalculated on its basis for the period, now with a step-down: before the step-down date at the fund's rate and basis, after it at the step-down rate and basis, each for its days. Each investor's fee at its own rate (`CAPACCT_FEE_RATE_PCT`, else the fund's) on its share of the base (`lpFees`). Fees charged to investors vs the fund's fee (`feeAllocation`) |
| 6. Carried interest and waterfall | Fund terms, the GP's capital account | The waterfall tier by tier: return of capital, preferred return, GP catch-up, carry split. The GP's tiers add up to the carry the reconciliation recalculates. Carry in the GP's account vs that carry (`gpCarry`); carry taken from limited partners equals carry given to the GP (`carryOffsets`) |
| 7. Valuation support | `VALUATION_SUPPORT` records linked to positions | Share of fair value with support dated after the prior period end and up to the certification lag, against `FUND_VALUATION_COVERAGE_PCT` (`valuationCoverage`). Marks inside the support's range, or within 1% of its concluded value (`valuationMarks`). Third-party share against `FUND_THIRD_PARTY_COVERAGE_PCT` when set (`thirdParty`) |
| 8. Capital calls and distributions | `CAPITAL_ACTIVITY` with status and outstanding amount | Calls received in the period vs contributions (`callsReceived`). Calls not yet received vs contributions receivable (`callReceivable`). Distributions declared and not yet paid vs distributions payable (`distPayable`). Distributions paid vs the cash flow statement (`distPaid`). Plus the reconciliation's notice checks |
| 9. Commitments and unfunded | Capital accounts, `INVESTOR_COMMITMENT` | Investors' commitments vs `FUND_TOTAL_COMMITMENTS` (`lpCommitments`). Unfunded vs `FUND_UNDRAWN_COMMITMENTS` (`lpUnfunded`). Commitment less contributions to date equals unfunded per investor (`unfundedRoll`). Unfunded covers calls still to come (`pendingCalls`). Capital account commitments vs commitment records (`commitmentRecords`) |
| 10. FX translation and exposure | `FX_TRANSLATION` records, `FX_RATE` market rates | A rate applied for every currency the schedule holds (`fxCoverage`). Applied rates within `FUND_FX_RATE_TOLERANCE_PCT` (0.25% when blank) of the market rate dated in the week up to the period end, quoted either way round (`fxRates`). Exposure translated at the applied rate (`fxTranslation`). FX gains by currency vs FX gains in operations (`fxGains`). Hedge fair values vs derivatives on the balance sheet (`fxHedgeMtm`). Hedged share vs `FUND_FX_HEDGE_TARGET_PCT` within 10 points when set (`fxHedge`) |

The parts are in `packages/graphql/src/lib/nav-pack.ts`, read by `nav-pack-store.ts`, and called by the reconciliation (`fund-rec.ts`). Every pack check is an ordinary reconciliation check (group `pack`, with the part as `component`): it counts as a break, blocks certification, and shows in the break summary with its cause, next step and owner.

## What a fund's pack should hold

Each part has a status: **Ties**, **Breaks**, **Open** (a review item on it is undecided), **Partial** (on file, but a figure or the notes are missing), **Not on file**, or **Not expected**.

Which parts are expected comes from the fund's terms unless the fund lists them:

- Always: the NAV bridge and the financial statements.
- A drawdown fund (`FUND_CAPITAL_MODEL` blank or `DRAWDOWN`): the trial balance, capital accounts, calls and distributions, and commitments.
- A management fee rate: the fee calculation. A carry rate: the waterfall.
- A schedule of investments: valuation support. A holding in a currency other than `FUND_BASE_CURRENCY` (USD when blank): FX.

`FUND_NAV_PACK_REQUIRED` lists the parts a fund must have. When it is set, those are the parts expected, and one that is missing blocks certification (the readiness item "NAV pack" is required). When it is blank, a missing part is reported in the summary as not on file without blocking.

## Loading the parts

Each part is a record type Load data maps a file onto, with the column headings administrators use already known (`Beginning Capital`, `Ending Capital`, `Unfunded Commitment`, `Ownership %`, `Debits`, `Credits`, `GL Account`, `FX Rate`, `Hedge MTM`, ...). A record belongs to a period by its period-end field (`TB_PERIOD_END`, `CAPACCT_PERIOD_END`, `FXT_PERIOD_END`), so one record per ledger account or investor can carry every period's figures. Each is linked to the fund (`TB_LINE_FUND`, `CAPACCT_FUND`, `FXT_FUND`); a capital account also to its investor (`CAPACCT_INVESTOR`, whose `INVESTOR_TYPE` `GENERAL_PARTNER` marks the GP), and valuation support to its position (`VALUATION_POSITION`).

Sign conventions: a trial balance line's net balance is debit less credit. A capital account's distributions, management fee and commitment are positive amounts; its carry is negative for a limited partner and positive for the GP. An FX rate is units of the base currency for one unit of the currency.

Once a client's file layout is mapped, the saved map loads the same layout each quarter without a person.

## Fund settings

| Setting | Effect |
|---|---|
| `FUND_BASE_CURRENCY` | The currency NAV is reported in. Blank is USD |
| `FUND_NAV_PACK_REQUIRED` | The parts the fund must have, enforced |
| `FUND_MGMT_FEE_STEPDOWN_DATE`, `_RATE_PCT`, `_BASIS` | The fee from that date. A basis may now also be `INVESTED_CAPITAL`, the cost of the investments in the schedule |
| `FUND_VALUATION_COVERAGE_PCT` | Valuation support required, share of fair value. Blank is 100 |
| `FUND_THIRD_PARTY_COVERAGE_PCT` | Third-party valuation required. Blank is not checked |
| `FUND_FX_RATE_TOLERANCE_PCT` | How far an applied rate may sit from the market. Blank is 0.25 |
| `FUND_FX_HEDGE_TARGET_PCT` | The share of foreign exposure the fund means to hedge. Blank is not checked |

## Where it shows

- The **NAV pack** tab of the fund's reconciliation page: the ten parts, the bridge, capital accounts, fee terms, waterfall tiers, valuation support, calls and commitments, FX, and the pack's checks. It is published to the assistant with the other tabs.
- The **Breaks** tab and the workflow's break summary (`get_nav_breaks`): pack breaks with the rest, each missing part as not on file with who supplies it, and a section on the pack part by part. The NAV reconciliation workflow keeps that summary as the notes, and its agent explains pack breaks and queries missing parts.
- `get_nav_reconciliation` returns the pack with each part's figures.

## Not built yet

- Reading a pack workbook's tabs into these records without a mapped layout. Each file is mapped once in Load data.
- Per-investor capital calls and distribution notices. Calls and distributions are checked at the fund level and per investor in the capital accounts.
- The notes to the financial statements are found, not read: the flag says they are in the pack.
- Hedge effectiveness and FX forwards as positions of their own. Hedges are checked per currency from the FX translation.
