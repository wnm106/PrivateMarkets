/**
 * Read the parts of a fund's NAV pack on file for one period: the trial
 * balance, the investors' capital accounts and commitments, valuation support,
 * FX translation and market rates, and the fund's pack settings. The
 * reconciliation store passes the schedule and the capital activity it
 * already read. See nav-pack.ts for what is checked.
 *
 * A record belongs to the period when its period-end field is the period end:
 * a ledger account or a capital account can be one record across periods,
 * with each period's figures read at that period end.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { flag, links, loadEntities, numeric, read, text, valuesFor, type Def, type ValueRow } from './fund-surface';
import {
  emptyPack, PACK_COMPONENTS,
  type AccountClass, type PackActivity, type PackCapitalAccount, type PackComponentKey, type PackHolding, type PackInput, type PackMarketRate,
} from './nav-pack';

const CODES = [
  'FUND_BASE_CURRENCY', 'FUND_NAV_PACK_REQUIRED', 'FUND_VALUATION_COVERAGE_PCT', 'FUND_THIRD_PARTY_COVERAGE_PCT',
  'FUND_FX_RATE_TOLERANCE_PCT', 'FUND_FX_HEDGE_TARGET_PCT', 'FUND_TOTAL_COMMITMENTS', 'FUND_UNDRAWN_COMMITMENTS',
  'STATEMENT_NOTES_INCLUDED',
  'TB_PERIOD_END', 'TB_PERIOD_START', 'TB_ACCOUNT_NUMBER', 'TB_ACCOUNT_NAME', 'TB_ACCOUNT_CLASS', 'TB_DEBIT', 'TB_CREDIT', 'TB_BALANCE', 'TB_NAV_LINE',
  'CAPACCT_PERIOD_END', 'CAPACCT_OPENING', 'CAPACCT_CONTRIBUTIONS', 'CAPACCT_DISTRIBUTIONS', 'CAPACCT_PNL', 'CAPACCT_MGMT_FEE',
  'CAPACCT_FEE_RATE_PCT', 'CAPACCT_CARRY', 'CAPACCT_CARRY_BALANCE', 'CAPACCT_OTHER', 'CAPACCT_CLOSING', 'CAPACCT_COMMITMENT',
  'CAPACCT_CONTRIBUTED_ITD', 'CAPACCT_UNFUNDED', 'CAPACCT_OWNERSHIP_PCT',
  'INVESTOR_TYPE', 'COMMITMENT_AMOUNT',
  'VALUATION_DATE', 'VALUATION_SOURCE_TYPE', 'VALUATION_METHOD', 'VALUATION_PROVIDER', 'VALUATION_FAIR_VALUE',
  'VALUATION_LOW', 'VALUATION_HIGH', 'VALUATION_DOCUMENT',
  'FXT_PERIOD_END', 'FXT_CURRENCY', 'FXT_RATE_APPLIED', 'FXT_EXPOSURE_LOCAL', 'FXT_EXPOSURE_BASE', 'FXT_REALIZED',
  'FXT_UNREALIZED', 'FXT_HEDGE_NOTIONAL', 'FXT_HEDGE_MTM',
  'FX_BASE_CURRENCY', 'FX_QUOTE_CURRENCY', 'FX_MARKET_RATE', 'FX_MARKET_DATE', 'FX_MARKET_TENOR', 'FX_MARKET_SOURCE',
] as const;

const CLASSES = new Set<AccountClass>(['ASSET', 'LIABILITY', 'CAPITAL', 'INCOME', 'EXPENSE', 'GAIN_LOSS']);
const PARTS = new Set<string>(PACK_COMPONENTS.map((part) => part.key));
const dateOnly = (value: string) => value.slice(0, 10);
/** A market rate counts for the period end when it is dated in the week up to it. */
const RATE_WINDOW_DAYS = 7;

async function definitions(supabase: SupabaseClient): Promise<Map<string, Def>> {
  const { data, error } = await supabase.from('attribute_register').select('id, attribute_code').in('attribute_code', [...CODES]);
  if (error) throw new Error(error.message);
  return new Map((data || []).map((row) => [row.attribute_code as string, { id: row.id as string, code: row.attribute_code as string }]));
}

export interface PackLoadArgs {
  fund: { id: string; name: string };
  statementId: string | null;
  periodEnd: string;
  today: string;
  knowledge: string;
  holdings: PackHolding[];
  activities: PackActivity[];
}

export async function loadNavPack(supabase: SupabaseClient, args: PackLoadArgs): Promise<PackInput> {
  const { fund, periodEnd, today, knowledge } = args;
  const defs = await definitions(supabase);
  if (!defs.size) return { ...emptyPack(), holdings: args.holdings, activities: args.activities };
  const tie = [today, knowledge] as const;
  const [tbRels, accountRels, commitmentRels, fxRels, valuationRels] = await Promise.all([
    links(supabase, 'TB_LINE_FUND', 'child_entity_id', [fund.id], ...tie),
    links(supabase, 'CAPACCT_FUND', 'child_entity_id', [fund.id], ...tie),
    links(supabase, 'COMMITMENT_FUND', 'child_entity_id', [fund.id], ...tie),
    links(supabase, 'FXT_FUND', 'child_entity_id', [fund.id], ...tie),
    args.holdings.length ? links(supabase, 'VALUATION_POSITION', 'child_entity_id', args.holdings.map((holding) => holding.id), ...tie) : Promise.resolve([]),
  ]);
  const tbIds = tbRels.map((row) => row.parent_entity_id);
  const accountIds = accountRels.map((row) => row.parent_entity_id);
  const commitmentIds = commitmentRels.map((row) => row.parent_entity_id);
  const fxIds = fxRels.map((row) => row.parent_entity_id);
  const valuationIds = valuationRels.map((row) => row.parent_entity_id);
  const positionOf = new Map(valuationRels.map((row) => [row.parent_entity_id, row.child_entity_id]));
  const [investorRels, commitmentInvestorRels] = await Promise.all([
    accountIds.length ? links(supabase, 'CAPACCT_INVESTOR', 'parent_entity_id', accountIds, ...tie) : Promise.resolve([]),
    commitmentIds.length ? links(supabase, 'COMMITMENT_INVESTOR', 'parent_entity_id', commitmentIds, ...tie) : Promise.resolve([]),
  ]);
  const investorOf = new Map(investorRels.map((row) => [row.parent_entity_id, row.child_entity_id]));
  const commitmentInvestor = new Map(commitmentInvestorRels.map((row) => [row.parent_entity_id, row.child_entity_id]));
  const investorIds = [...new Set([...investorOf.values(), ...commitmentInvestor.values()])];

  // Figures of the period are read at the period end; valuation support is read as it stands now.
  const periodIds = [fund.id, ...(args.statementId ? [args.statementId] : []), ...tbIds, ...accountIds, ...commitmentIds, ...fxIds, ...investorIds];
  const [atEnd, now, entities] = await Promise.all([
    valuesFor(supabase, periodIds, defs, periodEnd, knowledge),
    valuesFor(supabase, valuationIds, defs, today, knowledge),
    loadEntities(supabase, [...tbIds, ...accountIds, ...commitmentIds, ...fxIds, ...valuationIds]),
  ]);
  const nameOf = new Map(entities.map((entity) => [entity.id, entity.entity_name]));
  const at = (values: Map<string, ValueRow>) => ({
    num: (id: string, code: string) => numeric(read(values, id, defs.get(code))),
    str: (id: string, code: string) => text(read(values, id, defs.get(code))),
    bool: (id: string, code: string) => flag(read(values, id, defs.get(code))),
    has: (id: string, code: string) => read(values, id, defs.get(code)) != null,
  });
  const end = at(atEnd);
  const current = at(now);
  const inPeriod = (id: string, code: string) => dateOnly(end.str(id, code)) === periodEnd;
  const baseCurrency = end.str(fund.id, 'FUND_BASE_CURRENCY') || 'USD';

  const required = end.str(fund.id, 'FUND_NAV_PACK_REQUIRED')
    .split(/[,;\s]+/).map((value) => value.trim().toUpperCase()).filter((value) => PARTS.has(value)) as PackComponentKey[];

  const trialBalance = tbIds.filter((id) => inPeriod(id, 'TB_PERIOD_END')).map((id) => {
    const accountClass = end.str(id, 'TB_ACCOUNT_CLASS').toUpperCase();
    return {
      id, name: nameOf.get(id) || end.str(id, 'TB_ACCOUNT_NAME'),
      account: end.str(id, 'TB_ACCOUNT_NUMBER'), accountName: end.str(id, 'TB_ACCOUNT_NAME'),
      accountClass: CLASSES.has(accountClass as AccountClass) ? accountClass as AccountClass : null,
      debit: end.num(id, 'TB_DEBIT'), credit: end.num(id, 'TB_CREDIT'), balance: end.num(id, 'TB_BALANCE'),
      navLine: end.str(id, 'TB_NAV_LINE') || null, periodStart: dateOnly(end.str(id, 'TB_PERIOD_START')) || null,
    };
  });

  const capitalAccounts: PackCapitalAccount[] = accountIds.filter((id) => inPeriod(id, 'CAPACCT_PERIOD_END')).map((id) => {
    const investorId = investorOf.get(id) ?? null;
    return {
      id, name: nameOf.get(id) || '', investorId,
      isGp: Boolean(investorId) && end.str(investorId!, 'INVESTOR_TYPE') === 'GENERAL_PARTNER',
      opening: end.num(id, 'CAPACCT_OPENING'), contributions: end.num(id, 'CAPACCT_CONTRIBUTIONS'), distributions: end.num(id, 'CAPACCT_DISTRIBUTIONS'),
      pnl: end.num(id, 'CAPACCT_PNL'), mgmtFee: end.num(id, 'CAPACCT_MGMT_FEE'), feeRatePct: end.num(id, 'CAPACCT_FEE_RATE_PCT'),
      carry: end.num(id, 'CAPACCT_CARRY'), carryBalance: end.num(id, 'CAPACCT_CARRY_BALANCE'), other: end.num(id, 'CAPACCT_OTHER'),
      closing: end.num(id, 'CAPACCT_CLOSING'), commitment: end.num(id, 'CAPACCT_COMMITMENT'), contributedItd: end.num(id, 'CAPACCT_CONTRIBUTED_ITD'),
      unfunded: end.num(id, 'CAPACCT_UNFUNDED'), ownershipPct: end.num(id, 'CAPACCT_OWNERSHIP_PCT'),
    };
  });

  const commitments = commitmentIds
    .filter((id) => commitmentInvestor.has(id) && end.num(id, 'COMMITMENT_AMOUNT') != null)
    .map((id) => ({ id, name: nameOf.get(id) || '', investorId: commitmentInvestor.get(id)!, amount: end.num(id, 'COMMITMENT_AMOUNT')! }));

  const valuations = valuationIds.filter((id) => current.str(id, 'VALUATION_DATE')).map((id) => ({
    id, name: nameOf.get(id) || '', positionId: positionOf.get(id)!, date: dateOnly(current.str(id, 'VALUATION_DATE')),
    sourceType: current.str(id, 'VALUATION_SOURCE_TYPE') || null, method: current.str(id, 'VALUATION_METHOD') || null,
    provider: current.str(id, 'VALUATION_PROVIDER') || null, fairValue: current.num(id, 'VALUATION_FAIR_VALUE'),
    low: current.num(id, 'VALUATION_LOW'), high: current.num(id, 'VALUATION_HIGH'), document: current.str(id, 'VALUATION_DOCUMENT') || null,
  }));

  const fx = fxIds.filter((id) => inPeriod(id, 'FXT_PERIOD_END') && end.str(id, 'FXT_CURRENCY')).map((id) => ({
    id, name: nameOf.get(id) || end.str(id, 'FXT_CURRENCY'), currency: end.str(id, 'FXT_CURRENCY').toUpperCase(),
    rateApplied: end.num(id, 'FXT_RATE_APPLIED'), exposureLocal: end.num(id, 'FXT_EXPOSURE_LOCAL'), exposureBase: end.num(id, 'FXT_EXPOSURE_BASE'),
    realized: end.num(id, 'FXT_REALIZED'), unrealized: end.num(id, 'FXT_UNREALIZED'),
    hedgeNotional: end.num(id, 'FXT_HEDGE_NOTIONAL'), hedgeMtm: end.num(id, 'FXT_HEDGE_MTM'),
  }));

  const currencies = new Set([...fx.map((item) => item.currency), ...args.holdings.map((holding) => holding.currency).filter((value): value is string => Boolean(value))]);
  currencies.delete(baseCurrency);
  const marketRates = currencies.size ? await readMarketRates(supabase, defs, [...currencies], baseCurrency, periodEnd, knowledge) : [];

  return {
    baseCurrency,
    required: required.length ? required : null,
    notesIncluded: args.statementId && end.has(args.statementId, 'STATEMENT_NOTES_INCLUDED') ? end.bool(args.statementId, 'STATEMENT_NOTES_INCLUDED') : null,
    trialBalance,
    capitalAccounts,
    valuations,
    holdings: args.holdings,
    fx,
    marketRates,
    activities: args.activities,
    commitments,
    settings: {
      valuationCoveragePct: end.num(fund.id, 'FUND_VALUATION_COVERAGE_PCT'),
      thirdPartyCoveragePct: end.num(fund.id, 'FUND_THIRD_PARTY_COVERAGE_PCT'),
      fxTolerancePct: end.num(fund.id, 'FUND_FX_RATE_TOLERANCE_PCT'),
      fxHedgeTargetPct: end.num(fund.id, 'FUND_FX_HEDGE_TARGET_PCT'),
      totalCommitments: end.num(fund.id, 'FUND_TOTAL_COMMITMENTS'),
      undrawnCommitments: end.num(fund.id, 'FUND_UNDRAWN_COMMITMENTS'),
    },
  };
}

/** Spot rates between the base currency and each currency, dated in the week up to the period end. */
async function readMarketRates(
  supabase: SupabaseClient, defs: Map<string, Def>, currencies: string[], base: string, periodEnd: string, knowledge: string,
): Promise<PackMarketRate[]> {
  const { data, error } = await supabase.from('master_entities').select('id, entity_name').eq('domain_code', 'FX_RATE').eq('is_active', true).limit(2000);
  if (error) throw new Error(error.message);
  const rows = (data || []) as Array<{ id: string; entity_name: string }>;
  if (!rows.length) return [];
  const values = await valuesFor(supabase, rows.map((row) => row.id), defs, periodEnd, knowledge);
  const str = (id: string, code: string) => text(read(values, id, defs.get(code))).toUpperCase();
  const earliest = new Date(new Date(`${periodEnd}T00:00:00Z`).getTime() - RATE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const wanted = new Set(currencies);
  const best = new Map<string, PackMarketRate & { date: string }>();
  for (const row of rows) {
    const from = str(row.id, 'FX_BASE_CURRENCY');
    const to = str(row.id, 'FX_QUOTE_CURRENCY');
    const pair = from === base && wanted.has(to) ? to : to === base && wanted.has(from) ? from : null;
    if (!pair) continue;
    const tenor = str(row.id, 'FX_MARKET_TENOR');
    if (tenor && !/^(SPOT|SP|S|0D|ON|TN)$/.test(tenor)) continue;
    const date = text(read(values, row.id, defs.get('FX_MARKET_DATE'))).slice(0, 10);
    const rate = numeric(read(values, row.id, defs.get('FX_MARKET_RATE')));
    if (!rate || !date || date > periodEnd || date < earliest) continue;
    const held = best.get(pair);
    if (held && held.date >= date) continue;
    best.set(pair, { id: row.id, name: row.entity_name, base: from, quote: to, rate, source: text(read(values, row.id, defs.get('FX_MARKET_SOURCE'))) || null, date });
  }
  return [...best.values()].map(({ date: _date, ...rate }) => rate);
}
