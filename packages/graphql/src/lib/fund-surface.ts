/**
 * Assemble the fund surface from registered entities.
 * Stored facts are the editable inputs. Called capital, TVPI, variances,
 * coverage, and exposure are arithmetic on those facts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const CODES = [
  'NAV', 'FUND_CASH_BALANCE', 'FUND_STRATEGY', 'FUND_VINTAGE', 'FUND_REPORTING_DATE',
  'FUND_TOTAL_COMMITMENTS', 'FUND_COMMITMENTS_CLOSED', 'FUND_INVESTMENT_PERIOD_END',
  'FUND_TARGET_CALLED_PCT', 'FUND_GROSS_IRR', 'FUND_FEE_DRAG_PTS', 'FUND_EXPENSE_DRAG_PTS',
  'FUND_CARRY_DRAG_PTS', 'FUND_UNFUNDED_BORROWER_COMMITMENTS', 'FUND_LIQUIDITY_COVERAGE_MIN',
  'FUND_SECTOR_LIMIT_PCT', 'FUND_ISSUER_LIMIT_PCT',
  'INVESTOR_TYPE', 'COMMITMENT_AMOUNT', 'COMMITMENT_STATUS', 'COMMITMENT_PAST_DUE',
  'ACTIVITY_DATE', 'ACTIVITY_KIND', 'ACTIVITY_AMOUNT', 'ACTIVITY_STATUS', 'ACTIVITY_OUTSTANDING', 'ACTIVITY_NOTICE',
  'STATEMENT_PERIOD_END', 'STATEMENT_PERIOD_LABEL', 'STATEMENT_TOLERANCE_PCT', 'STATEMENT_CERTIFIED',
  'NAV_LINE_STATEMENT', 'NAV_LINE_ROLE', 'NAV_LINE_INDENT', 'NAV_LINE_ORDER',
  'NAV_LINE_ADMINISTRATOR', 'NAV_LINE_SHADOW', 'NAV_LINE_RESOLVED', 'NAV_LINE_REVIEWABLE', 'NAV_LINE_IN_COMPOSITION',
  'PLAN_QUARTER_END', 'PLAN_CALLED_PCT', 'PLAN_NAV', 'PLAN_CALL_AMOUNT', 'PLAN_ORDER',
  'FACILITY_COMMITMENT', 'FACILITY_DRAWN', 'FACILITY_BORROWING_BASE', 'FACILITY_MATURITY',
  'LIMIT_DIMENSION', 'LIMIT_KEY', 'LIMIT_PCT',
  'FORECAST_QUARTER_END', 'FORECAST_ORDER', 'FORECAST_INTEREST', 'FORECAST_REPAYMENTS',
  'FORECAST_NEW_FUNDINGS', 'FORECAST_FEES', 'FORECAST_DISTRIBUTIONS', 'FORECAST_CAPITAL_CALLS', 'FORECAST_FACILITY_PAYDOWN',
  'POSITION_STRATEGY', 'POSITION_COST', 'MARKET_VALUE', 'POSITION_INCOME', 'POSITION_REALIZED_GAIN',
  'POSITION_GROSS_IRR', 'POSITION_MARK', 'POSITION_AGENT_MARK', 'POSITION_COUPON', 'POSITION_LEVERAGE',
  'POSITION_IS_FLOATING', 'POSITION_MARK_RESOLVED', 'POSITION_IS_HYPOTHETICAL', 'SECTOR',
] as const;

const FUND_STRATEGY: Record<string, string> = {
  DIRECT_LENDING: 'Direct lending',
  OPPORTUNISTIC_CREDIT: 'Opportunistic credit',
  ASSET_BASED_FINANCE: 'Asset-based finance',
  SPECIAL_SITUATIONS: 'Special situations',
};

const POSITION_STRATEGY: Record<string, string> = {
  SENIOR_SECURED: 'Senior secured',
  UNITRANCHE: 'Unitranche',
  MEZZANINE: 'Mezzanine',
  ASSET_BASED: 'Asset-based',
};

const INVESTOR_TYPE: Record<string, string> = {
  PENSION: 'Pension',
  INSURANCE: 'Insurance',
  FAMILY_OFFICE: 'Family office',
  ENDOWMENT: 'Endowment',
  FUND_OF_FUNDS: 'Fund of funds',
  FOUNDATION: 'Foundation',
  GENERAL_PARTNER: 'General partner',
};

const ACTIVITY_STATUS: Record<string, string> = {
  FUNDED: 'Funded',
  PAID: 'Paid',
  PROJECTED: 'Projected',
  SCHEDULED: 'Scheduled',
};

const STATEMENT_TITLES: Record<string, { title: string; period: (label: string) => string }> = {
  BS: {
    title: 'Statement of Assets and Liabilities',
    period: (label) => `As of ${label}. In millions of US dollars, unaudited`,
  },
  OPS: {
    title: 'Statement of Operations',
    period: (label) => `Three months ended ${label}. In millions of US dollars, unaudited`,
  },
  CHANGES: {
    title: 'Statement of Changes in Net Assets',
    period: (label) => `Three months ended ${label}. In millions of US dollars, unaudited`,
  },
  CASH: {
    title: 'Statement of Cash Flows',
    period: (label) => `Three months ended ${label}. In millions of US dollars, unaudited`,
  },
};

type ValueRow = { entity_id: string; attribute_id: string; golden_value: string | null; golden_value_numeric: number | null };
type Def = { id: string; code: string };
type EntityRow = { id: string; entity_code: string; entity_name: string };
type Rel = {
  parent_entity_id: string;
  child_entity_id: string;
  valid_from: string | null;
  valid_to: string | null;
  system_from: string | null;
  system_to: string | null;
};

export interface FundAmountCell {
  amount: number | null;
  entityId: string | null;
  attributeCode: string | null;
}

export interface FundLine {
  id: string;
  label: string;
  role: string;
  indent: number;
  administrator: number | null;
  shadow: number | null;
  variance: number | null;
  variancePct: number | null;
  status: string | null;
  reviewable: boolean;
  statement: string;
  signed: number | null;
}

export interface FundSurface {
  fundId: string;
  fundCode: string;
  fundName: string;
  strategyCode: string;
  strategyLabel: string;
  vintage: string;
  reportingDate: string;
  commitmentsClosed: string;
  investmentPeriodEnd: string;
  monthsRemaining: number | null;
  nav: number;
  commitments: number;
  called: number;
  distributed: number;
  unfunded: number;
  netPaidIn: number;
  grossIrr: number | null;
  feeDrag: number | null;
  expenseDrag: number | null;
  carryDrag: number | null;
  netIrr: number | null;
  tvpi: number | null;
  dpi: number | null;
  rvpi: number | null;
  cash: number;
  unfundedBorrower: number;
  liquidityMin: number;
  targetCalledPct: number;
  facilityAvailability: number;
  availableLiquidity: number;
  liquidityCoverage: number | null;
  investmentsFairValue: number;
  activePositions: number;
  sectorCount: number;
  floatingRatePct: number | null;
  weightedLeverage: number | null;
  weightedMark: number | null;
  marksBelow: number;
  reviewOpen: number;
  reviewFlagged: number;
  certified: boolean;
  tolerancePct: number;
  statementId: string | null;
  periodLabel: string;
  facility: null | {
    id: string;
    name: string;
    commitment: number;
    drawn: number;
    borrowingBase: number;
    availability: number;
    utilization: number | null;
    maturity: string;
  };
  navChart: { labels: string[]; values: Array<number | null> };
  pacingChart: { labels: string[]; plan: Array<number | null>; actual: Array<number | null>; projected: Array<number | null> };
  activityChart: { labels: string[]; calls: number[]; distributions: number[] };
  rollforward: FundLine[];
  composition: FundLine[];
  plans: Array<{
    id: string;
    label: string;
    quarterEnd: string;
    callAmount: number | null;
    cumulative: number | null;
    calledPct: number | null;
    unfunded: number | null;
    planPct: number | null;
    versusPts: number | null;
    future: boolean;
  }>;
  activities: Array<{
    id: string;
    date: string;
    label: string;
    kind: string;
    amount: number;
    signed: number;
    status: string;
    statusLabel: string;
    outstanding: number | null;
    notice: string;
    pctOfCommitments: number | null;
  }>;
  statements: Array<{ kind: string; title: string; period: string; comparable: boolean; rows: FundLine[] }>;
  marks: Array<{
    id: string;
    name: string;
    mark: number | null;
    agent: number | null;
    difference: number | null;
    impact: number | null;
    status: string | null;
  }>;
  positions: Array<{
    id: string;
    name: string;
    strategyCode: string;
    strategy: string;
    sector: string;
    issuer: string;
    cost: number;
    fairValue: number;
    income: number;
    realized: number;
    gain: number;
    moic: number | null;
    grossIrr: number | null;
    mark: number | null;
    coupon: string;
    leverage: number | null;
    floating: boolean;
    active: boolean;
  }>;
  forecastLabels: string[];
  forecastRows: Array<{ label: string; emphasize: boolean; cells: FundAmountCell[] }>;
  investors: Array<{
    id: string;
    investorId: string;
    name: string;
    typeCode: string;
    typeLabel: string;
    commitment: number;
    sharePct: number | null;
    called: number;
    unfunded: number;
    distributions: number;
    nav: number;
    status: string;
    pastDue: number;
  }>;
  investorTypes: Array<{ label: string; amount: number; sharePct: number | null }>;
  exposure: {
    strategy: ExposureBar[];
    sector: ExposureBar[];
    issuer: ExposureBar[];
  };
  pacing: {
    calledPct: number | null;
    planPct: number | null;
    planLabel: string;
    behindPts: number | null;
    behindAmount: number | null;
    requiredCall: number | null;
    trailingCall: number | null;
  };
  nextCall: { amount: number; notice: string; date: string } | null;
  largestInvestor: { name: string; sharePct: number | null } | null;
  pastDue: { amount: number; name: string } | null;
  investorCount: number;
}

interface ExposureBar {
  key: string;
  label: string;
  amount: number;
  sharePct: number | null;
  limitPct: number | null;
  status: string;
  limitId: string | null;
}

function asOfDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const match = String(value ?? '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : new Date().toISOString().slice(0, 10);
}

function knowledgeInstant(value: unknown): string {
  const text = String(value ?? '').trim();
  const today = new Date().toISOString().slice(0, 10);
  if (!text) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text >= today ? new Date().toISOString() : `${text}T23:59:59.999Z`;
  }
  const parsed = new Date(text.length === 16 ? `${text}:00` : text);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function inForce(row: Rel, asOf: string, knowledge: string): boolean {
  const validFrom = String(row.valid_from || '').slice(0, 10);
  const validTo = String(row.valid_to || '9999-12-31').slice(0, 10);
  if (validFrom && validFrom > asOf) return false;
  if (validTo && validTo < asOf) return false;
  const known = new Date(knowledge).getTime();
  const systemFrom = row.system_from ? new Date(row.system_from).getTime() : 0;
  const systemTo = row.system_to ? new Date(row.system_to).getTime() : Number.POSITIVE_INFINITY;
  return systemFrom <= known && systemTo >= known;
}

function numeric(row: ValueRow | undefined): number | null {
  if (!row) return null;
  if (row.golden_value_numeric != null) return Number(row.golden_value_numeric);
  if (row.golden_value == null || row.golden_value === '') return null;
  const parsed = Number(row.golden_value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(row: ValueRow | undefined): string {
  return row?.golden_value?.trim() || '';
}

function flag(row: ValueRow | undefined): boolean {
  const value = text(row).toLowerCase();
  return value === 'true' || value === 't' || value === '1';
}

function num(value: number | null | undefined): number {
  return value == null || !Number.isFinite(value) ? 0 : value;
}

function monthsBetween(from: string, to: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  // A month-end reporting date has already closed, so that month is not still remaining.
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  const closed = start.getUTCDate() === lastDay ? 1 : 0;
  return Math.max(months - closed, 0);
}

function lineStatus(
  admin: number | null,
  shadow: number | null,
  resolved: boolean,
  reviewable: boolean,
  tolerance: number,
): string | null {
  if (!reviewable || admin == null || shadow == null) return null;
  const variance = admin - shadow;
  if (Math.abs(variance) <= 1) return 'OK';
  const base = Math.abs(shadow) > 1 ? shadow : admin;
  const pct = Math.abs(base) <= 1 ? 100 : Math.abs(variance / base) * 100;
  if (pct <= tolerance + 1e-9) return 'OK';
  return resolved ? 'RESOLVED' : 'REVIEW';
}

function markStatus(mark: number | null, agent: number | null, resolved: boolean): string | null {
  if (mark == null || agent == null) return null;
  if (Math.abs(mark - agent) <= 1) return 'OK';
  return resolved ? 'RESOLVED' : 'REVIEW';
}

function exposureStatus(share: number | null, limit: number | null): string {
  if (share == null || limit == null || limit <= 0) return 'OK';
  const ratio = share / limit;
  if (ratio >= 1) return 'OVER';
  if (ratio >= 0.85) return 'NEAR';
  return 'OK';
}

async function attributeDefs(supabase: SupabaseClient): Promise<Map<string, Def>> {
  const { data, error } = await supabase.from('attribute_register').select('id, attribute_code').in('attribute_code', [...CODES]);
  if (error) throw new Error(error.message);
  const defs = new Map<string, Def>();
  for (const row of data || []) defs.set(row.attribute_code, { id: row.id, code: row.attribute_code });
  return defs;
}

async function valuesFor(supabase: SupabaseClient, entityIds: string[], defs: Map<string, Def>, asOf: string, knowledge: string) {
  const out = new Map<string, ValueRow>();
  const attributeIds = [...defs.values()].map((def) => def.id);
  if (!entityIds.length || !attributeIds.length) return out;
  // PostgREST caps a single response at 1,000 rows. A fund surface reads every
  // related entity at once, so the batches stay small enough to come back whole.
  for (let index = 0; index < entityIds.length; index += 40) {
    const slice = entityIds.slice(index, index + 40);
    const { data, error } = await supabase.schema('golden_master').rpc('winning_attribute_values', {
      p_entity_ids: slice,
      p_attribute_ids: attributeIds,
      p_as_of: asOf,
      p_knowledge: knowledge,
      p_require_text: false,
    });
    if (error) throw new Error(error.message);
    for (const row of (data || []) as ValueRow[]) out.set(`${row.entity_id}|${row.attribute_id}`, row);
  }
  return out;
}

function read(values: Map<string, ValueRow>, entityId: string, def: Def | undefined): ValueRow | undefined {
  if (!def) return undefined;
  return values.get(`${entityId}|${def.id}`);
}

async function links(
  supabase: SupabaseClient,
  code: string,
  column: 'parent_entity_id' | 'child_entity_id',
  ids: string[],
  asOf: string,
  knowledge: string,
): Promise<Rel[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('entity_relationships')
    .select('parent_entity_id, child_entity_id, valid_from, valid_to, system_from, system_to')
    .eq('relationship_code', code)
    .in(column, ids);
  if (error) throw new Error(error.message);
  return ((data || []) as Rel[]).filter((row) => inForce(row, asOf, knowledge));
}

async function loadEntities(supabase: SupabaseClient, ids: string[]): Promise<EntityRow[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase.from('master_entities').select('id, entity_code, entity_name').in('id', ids);
  if (error) throw new Error(error.message);
  return (data || []) as EntityRow[];
}

export async function loadFundSurface(
  supabase: SupabaseClient,
  fundId: string,
  asOfInput: string | null | undefined,
  knowledgeInput?: string | null,
): Promise<FundSurface> {
  const asOf = asOfDate(asOfInput);
  const knowledge = knowledgeInstant(knowledgeInput);
  const lookup = /^[0-9a-f-]{36}$/i.test(fundId) ? 'id' : 'entity_code';
  const { data: fund, error: fundError } = await supabase
    .from('master_entities')
    .select('id, entity_code, entity_name, domain_code')
    .eq(lookup, fundId)
    .maybeSingle();
  if (fundError) throw new Error(fundError.message);
  if (!fund || fund.domain_code !== 'FUND') throw new Error('Fund not found');

  const tie = [asOf, knowledge] as const;
  const commitmentRels = await links(supabase, 'COMMITMENT_FUND', 'child_entity_id', [fund.id], ...tie);
  const activityRels = await links(supabase, 'ACTIVITY_FUND', 'child_entity_id', [fund.id], ...tie);
  const statementRels = await links(supabase, 'STATEMENT_FUND', 'child_entity_id', [fund.id], ...tie);
  const planRels = await links(supabase, 'PLAN_FUND', 'child_entity_id', [fund.id], ...tie);
  const facilityRels = await links(supabase, 'FACILITY_FUND', 'child_entity_id', [fund.id], ...tie);
  const forecastRels = await links(supabase, 'FORECAST_FUND', 'child_entity_id', [fund.id], ...tie);
  const limitRels = await links(supabase, 'LIMIT_FUND', 'child_entity_id', [fund.id], ...tie);
  const positionRels = await links(supabase, 'POSITION_FUND', 'child_entity_id', [fund.id], ...tie);

  const commitmentIds = commitmentRels.map((row) => row.parent_entity_id);
  const activityIds = activityRels.map((row) => row.parent_entity_id);
  const statementIds = statementRels.map((row) => row.parent_entity_id);
  const planIds = planRels.map((row) => row.parent_entity_id);
  const facilityIds = facilityRels.map((row) => row.parent_entity_id);
  const forecastIds = forecastRels.map((row) => row.parent_entity_id);
  const limitIds = limitRels.map((row) => row.parent_entity_id);
  const positionIds = positionRels.map((row) => row.parent_entity_id);

  const lineRels = await links(supabase, 'LINE_STATEMENT', 'child_entity_id', statementIds, asOf, knowledge);
  const lineIds = lineRels.map((row) => row.parent_entity_id);
  const statementOfLine = new Map(lineRels.map((row) => [row.parent_entity_id, row.child_entity_id]));

  const investorRels = await links(supabase, 'COMMITMENT_INVESTOR', 'parent_entity_id', commitmentIds, asOf, knowledge);
  const investorOf = new Map(investorRels.map((row) => [row.parent_entity_id, row.child_entity_id]));
  const investorIds = [...new Set(investorRels.map((row) => row.child_entity_id))];

  const securityRels = await links(supabase, 'POSITION_SECURITY', 'parent_entity_id', positionIds, asOf, knowledge);
  const securityOf = new Map(securityRels.map((row) => [row.parent_entity_id, row.child_entity_id]));
  const securityIds = [...new Set(securityRels.map((row) => row.child_entity_id))];
  const issuerRels = await links(supabase, 'SECURITY_ISSUER', 'parent_entity_id', securityIds, asOf, knowledge);
  const issuerOfSecurity = new Map(issuerRels.map((row) => [row.parent_entity_id, row.child_entity_id]));
  const issuerIds = [...new Set(issuerRels.map((row) => row.child_entity_id))];

  const rows = await loadEntities(supabase, [
    ...commitmentIds, ...activityIds, ...statementIds, ...planIds, ...facilityIds,
    ...forecastIds, ...limitIds, ...positionIds, ...lineIds, ...investorIds, ...issuerIds,
  ]);
  const named = new Map(rows.map((row) => [row.id, row]));

  const defs = await attributeDefs(supabase);
  const values = await valuesFor(supabase, [
    fund.id, ...commitmentIds, ...activityIds, ...statementIds, ...planIds, ...facilityIds,
    ...forecastIds, ...limitIds, ...positionIds, ...lineIds, ...investorIds, ...issuerIds,
  ], defs, asOf, knowledge);
  const def = (code: string) => defs.get(code);
  const n = (id: string, code: string) => numeric(read(values, id, def(code)));
  const t = (id: string, code: string) => text(read(values, id, def(code)));
  const b = (id: string, code: string) => flag(read(values, id, def(code)));

  const reportingDate = t(fund.id, 'FUND_REPORTING_DATE') || asOf;
  const commitments = num(n(fund.id, 'FUND_TOTAL_COMMITMENTS'));
  const nav = num(n(fund.id, 'NAV'));
  const cash = num(n(fund.id, 'FUND_CASH_BALANCE'));
  const grossIrr = n(fund.id, 'FUND_GROSS_IRR');
  const feeDrag = n(fund.id, 'FUND_FEE_DRAG_PTS');
  const expenseDrag = n(fund.id, 'FUND_EXPENSE_DRAG_PTS');
  const carryDrag = n(fund.id, 'FUND_CARRY_DRAG_PTS');
  const netIrr = [grossIrr, feeDrag, expenseDrag, carryDrag].every((item) => item != null)
    ? num(grossIrr) - num(feeDrag) - num(expenseDrag) - num(carryDrag)
    : null;
  const targetCalledPct = num(n(fund.id, 'FUND_TARGET_CALLED_PCT') ?? 90);
  const unfundedBorrower = num(n(fund.id, 'FUND_UNFUNDED_BORROWER_COMMITMENTS'));
  const liquidityMin = num(n(fund.id, 'FUND_LIQUIDITY_COVERAGE_MIN') ?? 1.25);
  const sectorLimit = n(fund.id, 'FUND_SECTOR_LIMIT_PCT');
  const issuerLimit = n(fund.id, 'FUND_ISSUER_LIMIT_PCT');
  const investmentPeriodEnd = t(fund.id, 'FUND_INVESTMENT_PERIOD_END');
  const strategyCode = t(fund.id, 'FUND_STRATEGY');

  const activities = activityIds.map((id) => {
    const kind = t(id, 'ACTIVITY_KIND');
    const amount = num(n(id, 'ACTIVITY_AMOUNT'));
    const status = t(id, 'ACTIVITY_STATUS');
    return {
      id,
      date: t(id, 'ACTIVITY_DATE'),
      label: named.get(id)?.entity_name || 'Activity',
      kind,
      amount,
      signed: kind === 'DISTRIBUTION' ? -amount : amount,
      status,
      statusLabel: ACTIVITY_STATUS[status] || status || '—',
      outstanding: n(id, 'ACTIVITY_OUTSTANDING'),
      notice: t(id, 'ACTIVITY_NOTICE'),
      code: named.get(id)?.entity_code || '',
    };
  }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.code.localeCompare(b.code)));

  const happened = (date: string) => !date || date.slice(0, 10) <= asOf;
  const called = activities.filter((item) => item.kind === 'CAPITAL_CALL' && item.status === 'FUNDED' && happened(item.date)).reduce((sum, item) => sum + item.amount, 0);
  const distributed = activities.filter((item) => item.kind === 'DISTRIBUTION' && item.status === 'PAID' && happened(item.date)).reduce((sum, item) => sum + item.amount, 0);
  const unfunded = commitments - called;
  const ratio = (top: number) => (called > 0 ? top / called : null);

  const plans = planIds.map((id) => ({
    id,
    label: named.get(id)?.entity_name || '',
    quarterEnd: t(id, 'PLAN_QUARTER_END'),
    planPct: n(id, 'PLAN_CALLED_PCT'),
    navAmount: n(id, 'PLAN_NAV'),
    callAmount: n(id, 'PLAN_CALL_AMOUNT'),
    order: num(n(id, 'PLAN_ORDER')),
  })).sort((a, b) => a.order - b.order || a.quarterEnd.localeCompare(b.quarterEnd));

  const calledThrough = (quarterEnd: string) => activities
    .filter((item) => item.kind === 'CAPITAL_CALL' && item.status === 'FUNDED' && item.date && item.date <= quarterEnd)
    .reduce((sum, item) => sum + item.amount, 0);

  let projectedCursor = called;
  const lastActual = plans.reduce((found, plan, index) => (plan.quarterEnd && plan.quarterEnd <= asOf ? index : found), -1);
  const pacingChart = {
    labels: plans.map((plan) => plan.label),
    plan: plans.map((plan) => plan.planPct),
    actual: plans.map((plan) => (plan.quarterEnd && plan.quarterEnd <= asOf && commitments ? calledThrough(plan.quarterEnd) / commitments * 100 : null)),
    projected: plans.map(() => null as number | null),
  };
  if (lastActual >= 0) {
    pacingChart.projected[lastActual] = pacingChart.actual[lastActual];
    projectedCursor = calledThrough(plans[lastActual].quarterEnd);
    for (let index = lastActual + 1; index < plans.length; index += 1) {
      projectedCursor += num(plans[index].callAmount);
      pacingChart.projected[index] = commitments ? projectedCursor / commitments * 100 : null;
    }
  }

  const historical = plans.filter((plan) => plan.quarterEnd && plan.quarterEnd <= asOf);
  const activityChart = {
    labels: historical.map((plan) => plan.label),
    calls: historical.map((plan, index) => {
      const prior = index === 0 ? '' : historical[index - 1].quarterEnd;
      return activities
        .filter((item) => item.kind === 'CAPITAL_CALL' && item.status === 'FUNDED' && item.date > prior && item.date <= plan.quarterEnd)
        .reduce((sum, item) => sum + item.amount, 0);
    }),
    distributions: historical.map((plan, index) => {
      const prior = index === 0 ? '' : historical[index - 1].quarterEnd;
      return activities
        .filter((item) => item.kind === 'DISTRIBUTION' && item.status === 'PAID' && item.date > prior && item.date <= plan.quarterEnd)
        .reduce((sum, item) => sum + item.amount, 0);
    }),
  };

  const currentPlan = lastActual >= 0 ? plans[lastActual] : null;
  const calledPct = commitments ? called / commitments * 100 : null;
  const behindPts = currentPlan?.planPct != null && calledPct != null ? currentPlan.planPct - calledPct : null;
  const futureQuarters = plans.filter((plan) => plan.quarterEnd > asOf && (!investmentPeriodEnd || plan.quarterEnd <= investmentPeriodEnd));
  const fundedCalls = activities.filter((item) => item.kind === 'CAPITAL_CALL' && item.status === 'FUNDED' && happened(item.date)).slice().sort((a, b) => a.date.localeCompare(b.date));
  const trailing = fundedCalls.slice(-4);
  const trailingCall = trailing.length ? trailing.reduce((sum, item) => sum + item.amount, 0) / trailing.length : null;

  const navShown = reportingDate > asOf
    ? plans.filter((plan) => plan.quarterEnd && plan.quarterEnd <= asOf && plan.navAmount != null).at(-1)?.navAmount ?? nav
    : nav;

  const planRows = plans.filter((plan) => plan.quarterEnd > asOf).map((plan) => {
    const cumulativePct = pacingChart.projected[plans.indexOf(plan)];
    const cumulative = cumulativePct != null && commitments ? cumulativePct / 100 * commitments : null;
    return {
      id: plan.id,
      label: plan.label,
      quarterEnd: plan.quarterEnd,
      callAmount: plan.callAmount,
      cumulative,
      calledPct: cumulativePct,
      unfunded: cumulative != null ? commitments - cumulative : null,
      planPct: plan.planPct,
      versusPts: cumulativePct != null && plan.planPct != null ? cumulativePct - plan.planPct : null,
      future: true,
    };
  });

  const facilityId = facilityIds[0] || null;
  const facilityCommitment = facilityId ? num(n(facilityId, 'FACILITY_COMMITMENT')) : 0;
  const facilityDrawn = facilityId ? num(n(facilityId, 'FACILITY_DRAWN')) : 0;
  const borrowingBase = facilityId ? num(n(facilityId, 'FACILITY_BORROWING_BASE')) : 0;
  const facilityAvailability = facilityId ? Math.min(facilityCommitment, borrowingBase) - facilityDrawn : 0;
  const facility = facilityId ? {
    id: facilityId,
    name: named.get(facilityId)?.entity_name || 'Credit facility',
    commitment: facilityCommitment,
    drawn: facilityDrawn,
    borrowingBase,
    availability: facilityAvailability,
    utilization: facilityCommitment ? facilityDrawn / facilityCommitment * 100 : null,
    maturity: t(facilityId, 'FACILITY_MATURITY'),
  } : null;

  const positions = positionIds
    .map((id) => {
      const securityId = securityOf.get(id) || '';
      const issuerId = issuerOfSecurity.get(securityId) || '';
      const cost = num(n(id, 'POSITION_COST'));
      const fairValue = num(n(id, 'MARKET_VALUE'));
      const income = num(n(id, 'POSITION_INCOME'));
      const realized = num(n(id, 'POSITION_REALIZED_GAIN'));
      const strategy = t(id, 'POSITION_STRATEGY');
      return {
        id,
        code: named.get(id)?.entity_code || '',
        name: named.get(id)?.entity_name || 'Position',
        strategyCode: strategy,
        strategy: POSITION_STRATEGY[strategy] || strategy || '—',
        sector: t(issuerId, 'SECTOR') || '—',
        issuer: named.get(issuerId)?.entity_name || '—',
        cost,
        fairValue,
        income,
        realized,
        gain: fairValue + income + realized - cost,
        moic: cost ? (fairValue + income + realized) / cost : null,
        grossIrr: n(id, 'POSITION_GROSS_IRR'),
        mark: n(id, 'POSITION_MARK'),
        agent: n(id, 'POSITION_AGENT_MARK'),
        coupon: t(id, 'POSITION_COUPON'),
        leverage: n(id, 'POSITION_LEVERAGE'),
        floating: b(id, 'POSITION_IS_FLOATING'),
        resolved: b(id, 'POSITION_MARK_RESOLVED'),
        hypothetical: b(id, 'POSITION_IS_HYPOTHETICAL'),
        active: fairValue > 0,
      };
    })
    .filter((item) => !item.hypothetical)
    .sort((a, b) => a.code.localeCompare(b.code));

  const live = positions.filter((item) => item.active);
  const investmentsFairValue = live.reduce((sum, item) => sum + item.fairValue, 0);
  const floatingValue = live.filter((item) => item.floating).reduce((sum, item) => sum + item.fairValue, 0);
  const weightedLeverage = investmentsFairValue
    ? live.reduce((sum, item) => sum + item.fairValue * num(item.leverage), 0) / investmentsFairValue
    : null;
  const weightedMark = investmentsFairValue
    ? live.reduce((sum, item) => sum + item.fairValue * num(item.mark), 0) / investmentsFairValue
    : null;

  const limits = limitIds.map((id) => ({
    id,
    dimension: t(id, 'LIMIT_DIMENSION'),
    key: t(id, 'LIMIT_KEY'),
    pct: n(id, 'LIMIT_PCT'),
  }));
  const limitFor = (dimension: string, key: string) => (
    limits.find((item) => item.dimension === dimension && item.key === key) || null
  );
  const bars = (dimension: 'strategy' | 'sector' | 'issuer', fallback: number | null): ExposureBar[] => {
    const grouped = new Map<string, { label: string; amount: number }>();
    for (const position of live) {
      const key = dimension === 'strategy' ? position.strategyCode : dimension === 'sector' ? position.sector : position.issuer;
      const label = dimension === 'strategy' ? position.strategy : key;
      const current = grouped.get(key) || { label, amount: 0 };
      current.amount += position.fairValue;
      grouped.set(key, current);
    }
    return [...grouped.entries()]
      .map(([key, value]) => {
        const sharePct = investmentsFairValue ? value.amount / investmentsFairValue * 100 : null;
        const specific = limitFor(dimension.toUpperCase(), key);
        const limitPct = specific?.pct ?? fallback;
        return {
          key,
          label: value.label,
          amount: value.amount,
          sharePct,
          limitPct,
          status: exposureStatus(sharePct, limitPct),
          limitId: specific?.id || null,
        };
      })
      .sort((a, b) => b.amount - a.amount);
  };

  const statementChoices = statementIds.map((id) => ({
    id,
    periodEnd: t(id, 'STATEMENT_PERIOD_END'),
    label: t(id, 'STATEMENT_PERIOD_LABEL'),
    tolerance: n(id, 'STATEMENT_TOLERANCE_PCT'),
    certified: b(id, 'STATEMENT_CERTIFIED'),
  })).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const statement = statementChoices.find((item) => item.periodEnd && item.periodEnd <= asOf)
    || statementChoices.find((item) => !item.periodEnd)
    || null;
  const tolerancePct = statement?.tolerance ?? 0.5;
  const periodLabel = statement?.label || reportingDate;

  const lines = lineIds
    .filter((id) => statement != null && statementOfLine.get(id) === statement.id)
    .map((id) => {
      const administrator = n(id, 'NAV_LINE_ADMINISTRATOR');
      const shadow = n(id, 'NAV_LINE_SHADOW');
      const statementCode = t(id, 'NAV_LINE_STATEMENT');
      const reviewable = b(id, 'NAV_LINE_REVIEWABLE');
      const variance = administrator != null && shadow != null ? administrator - shadow : null;
      const variancePct = variance != null && shadow != null && Math.abs(shadow) > 1 ? Math.abs(variance / shadow) * 100 : null;
      return {
        id,
        label: named.get(id)?.entity_name || '',
        role: t(id, 'NAV_LINE_ROLE') || 'LINE',
        indent: num(n(id, 'NAV_LINE_INDENT')),
        administrator,
        shadow,
        variance,
        variancePct,
        status: lineStatus(administrator, shadow, b(id, 'NAV_LINE_RESOLVED'), reviewable, tolerancePct),
        reviewable,
        statement: statementCode,
        signed: administrator == null ? null : administrator * (statementCode === 'BS_LIABILITY' ? -1 : 1),
        order: num(n(id, 'NAV_LINE_ORDER')),
        composition: b(id, 'NAV_LINE_IN_COMPOSITION'),
      };
    })
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));

  const marks = live.map((position) => ({
    id: position.id,
    name: position.name,
    mark: position.mark,
    agent: position.agent,
    difference: position.mark != null && position.agent != null ? position.mark - position.agent : null,
    impact: position.mark != null && position.agent != null ? position.cost * (position.mark - position.agent) / 100 : null,
    status: markStatus(position.mark, position.agent, position.resolved),
  }));

  const reviewItems = [
    ...lines.map((line) => line.status),
    ...marks.map((mark) => mark.status),
  ].filter((status) => status === 'REVIEW' || status === 'RESOLVED');
  const reviewOpen = reviewItems.filter((status) => status === 'REVIEW').length;

  const statementGroups: Array<{ kind: string; sections: string[] }> = [
    { kind: 'BS', sections: ['BS_ASSET', 'BS_LIABILITY', 'BS_NET'] },
    { kind: 'OPS', sections: ['OPS'] },
    { kind: 'CHANGES', sections: ['CHANGES'] },
    { kind: 'CASH', sections: ['CASH'] },
  ];
  const statements = statementGroups.map((group) => {
    const rows = lines.filter((line) => group.sections.includes(line.statement));
    const meta = STATEMENT_TITLES[group.kind];
    return {
      kind: group.kind,
      title: meta.title,
      period: meta.period(periodLabel || 'the period'),
      comparable: rows.some((row) => row.shadow != null),
      rows,
    };
  }).filter((group) => group.rows.length);

  const forecasts = forecastIds.map((id) => ({
    id,
    label: named.get(id)?.entity_name || '',
    order: num(n(id, 'FORECAST_ORDER')),
    interest: num(n(id, 'FORECAST_INTEREST')),
    repayments: num(n(id, 'FORECAST_REPAYMENTS')),
    fundings: num(n(id, 'FORECAST_NEW_FUNDINGS')),
    fees: num(n(id, 'FORECAST_FEES')),
    distributions: num(n(id, 'FORECAST_DISTRIBUTIONS')),
    calls: num(n(id, 'FORECAST_CAPITAL_CALLS')),
    paydown: num(n(id, 'FORECAST_FACILITY_PAYDOWN')),
  })).sort((a, b) => a.order - b.order);

  let runningCash = cash;
  let runningFacility = facilityDrawn;
  const forecastComputed = forecasts.map((item) => {
    const beginning = runningCash;
    runningCash += item.interest + item.repayments + item.fundings + item.fees + item.distributions + item.calls + item.paydown;
    runningFacility += item.paydown;
    return { ...item, beginning, ending: runningCash, facilityBalance: runningFacility };
  });
  const editableForecast = (code: string, pick: (item: typeof forecastComputed[number]) => number) => (
    forecastComputed.map((item) => ({ amount: pick(item), entityId: item.id, attributeCode: code }))
  );
  const plainForecast = (pick: (item: typeof forecastComputed[number]) => number) => (
    forecastComputed.map((item) => ({ amount: pick(item), entityId: null, attributeCode: null }))
  );
  const forecastRows = forecastComputed.length ? [
    { label: 'Beginning cash', emphasize: false, cells: plainForecast((item) => item.beginning) },
    { label: 'Interest income', emphasize: false, cells: editableForecast('FORECAST_INTEREST', (item) => item.interest) },
    { label: 'Repayments', emphasize: false, cells: editableForecast('FORECAST_REPAYMENTS', (item) => item.repayments) },
    { label: 'New fundings', emphasize: false, cells: editableForecast('FORECAST_NEW_FUNDINGS', (item) => item.fundings) },
    { label: 'Fees, expenses, interest', emphasize: false, cells: editableForecast('FORECAST_FEES', (item) => item.fees) },
    { label: 'Distributions', emphasize: false, cells: editableForecast('FORECAST_DISTRIBUTIONS', (item) => item.distributions) },
    { label: 'Capital calls', emphasize: false, cells: editableForecast('FORECAST_CAPITAL_CALLS', (item) => item.calls) },
    { label: 'Facility paydown', emphasize: false, cells: editableForecast('FORECAST_FACILITY_PAYDOWN', (item) => item.paydown) },
    { label: 'Ending cash', emphasize: true, cells: plainForecast((item) => item.ending) },
    { label: 'Facility balance', emphasize: false, cells: plainForecast((item) => item.facilityBalance) },
  ] : [];

  const investors = commitmentIds.map((id) => {
    const investorId = investorOf.get(id) || '';
    const commitment = num(n(id, 'COMMITMENT_AMOUNT'));
    const share = commitments ? commitment / commitments : null;
    const typeCode = t(investorId, 'INVESTOR_TYPE');
    const pastDue = num(n(id, 'COMMITMENT_PAST_DUE'));
    return {
      id,
      investorId,
      name: named.get(investorId)?.entity_name || named.get(id)?.entity_name || 'Investor',
      typeCode,
      typeLabel: INVESTOR_TYPE[typeCode] || typeCode || '—',
      commitment,
      sharePct: share != null ? share * 100 : null,
      called: share != null ? called * share : 0,
      unfunded: share != null ? unfunded * share : 0,
      distributions: share != null ? distributed * share : 0,
      nav: share != null ? navShown * share : 0,
      status: t(id, 'COMMITMENT_STATUS') || 'CURRENT',
      pastDue,
    };
  }).sort((a, b) => b.commitment - a.commitment || a.name.localeCompare(b.name));

  const typeTotals = new Map<string, number>();
  for (const investor of investors) typeTotals.set(investor.typeLabel, (typeTotals.get(investor.typeLabel) || 0) + investor.commitment);
  const investorTypes = [...typeTotals.entries()]
    .map(([label, amount]) => ({ label, amount, sharePct: commitments ? amount / commitments * 100 : null }))
    .sort((a, b) => b.amount - a.amount);

  const largest = investors[0] || null;
  const pastDueInvestors = investors.filter((item) => item.status === 'PAST_DUE' || item.pastDue > 0);
  const next = activities.filter((item) => item.kind === 'CAPITAL_CALL' && item.status === 'PROJECTED' && item.date > asOf).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  const visibleActivities = activities.filter((item) => happened(item.date) || item.status === 'PROJECTED' || item.status === 'SCHEDULED');

  return {
    fundId: fund.id,
    fundCode: fund.entity_code,
    fundName: fund.entity_name,
    strategyCode,
    strategyLabel: FUND_STRATEGY[strategyCode] || strategyCode || 'Fund',
    vintage: t(fund.id, 'FUND_VINTAGE'),
    reportingDate,
    commitmentsClosed: t(fund.id, 'FUND_COMMITMENTS_CLOSED'),
    investmentPeriodEnd,
    monthsRemaining: monthsBetween(asOf, investmentPeriodEnd),
    nav: navShown,
    commitments,
    called,
    distributed,
    unfunded,
    netPaidIn: called - distributed,
    grossIrr,
    feeDrag,
    expenseDrag,
    carryDrag,
    netIrr,
    tvpi: ratio(navShown + distributed),
    dpi: ratio(distributed),
    rvpi: ratio(navShown),
    cash,
    unfundedBorrower,
    liquidityMin,
    targetCalledPct,
    facilityAvailability,
    availableLiquidity: cash + facilityAvailability,
    liquidityCoverage: unfundedBorrower ? (cash + facilityAvailability) / unfundedBorrower : null,
    investmentsFairValue,
    activePositions: live.length,
    sectorCount: new Set(live.map((item) => item.sector)).size,
    floatingRatePct: investmentsFairValue ? floatingValue / investmentsFairValue * 100 : null,
    weightedLeverage,
    weightedMark,
    marksBelow: live.filter((item) => item.mark != null && item.mark < 97).length,
    reviewOpen,
    reviewFlagged: reviewItems.length,
    certified: Boolean(statement?.certified),
    tolerancePct,
    statementId: statement?.id || null,
    periodLabel,
    facility,
    navChart: {
      labels: historical.map((plan) => plan.label),
      values: historical.map((plan) => plan.navAmount),
    },
    pacingChart,
    activityChart,
    rollforward: lines.filter((line) => line.statement === 'ROLL'),
    composition: lines.filter((line) => line.composition),
    plans: planRows,
    activities: visibleActivities.map((item) => ({
      ...item,
      pctOfCommitments: commitments ? item.amount / commitments * 100 : null,
    })),
    statements,
    marks,
    positions: positions.map(({ agent: _agent, resolved: _resolved, hypothetical: _hypothetical, code: _code, ...position }) => position),
    forecastLabels: forecastComputed.map((item) => item.label),
    forecastRows,
    investors,
    investorTypes,
    exposure: {
      strategy: bars('strategy', 60),
      sector: bars('sector', sectorLimit),
      issuer: bars('issuer', issuerLimit),
    },
    pacing: {
      calledPct,
      planPct: currentPlan?.planPct ?? null,
      planLabel: currentPlan?.label || '',
      behindPts,
      behindAmount: behindPts != null && commitments ? behindPts / 100 * commitments : null,
      requiredCall: futureQuarters.length ? (targetCalledPct / 100 * commitments - called) / futureQuarters.length : null,
      trailingCall,
    },
    nextCall: next ? { amount: next.amount, notice: next.notice, date: next.date } : null,
    largestInvestor: largest ? { name: largest.name, sharePct: largest.sharePct } : null,
    pastDue: pastDueInvestors.length
      ? { amount: pastDueInvestors.reduce((sum, item) => sum + item.pastDue, 0), name: pastDueInvestors.map((item) => item.name).join(', ') }
      : null,
    investorCount: investors.length,
  };
}
