/**
 * Run the deal performance model on the server and store its outputs as
 * attribute values, so every figure on the Performance tab points back to a
 * stored value with a source.
 *
 * The model reads the committed allocation, not a what-if. Rates are stored in
 * percent points, multiples as plain numbers, amounts in dollars.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAllocationDraft, previewFromDraft } from './allocation-store';
import { projectPerformance, type PerformanceCase, type PerformanceFees, type PerformanceInput } from './deal-performance';
import { heldShare, spreadFromPricing } from './servicing-schedule';

export const PERFORMANCE_SOURCE = 'PERFORMANCE_MODEL';
const OPEN_SYSTEM = '9999-12-31 23:59:59';

export type PerformanceUnit = 'percent' | 'multiple' | 'amount' | 'number' | 'date';

/** Deal-level outputs: attribute code, how it is stored, and where it comes from on the model. */
export const DEAL_OUTPUTS: Array<{ code: string; unit: PerformanceUnit; read: (model: PerformanceCase) => number | string | null }> = [
  { code: 'DEAL_GROSS_IRR', unit: 'percent', read: (m) => m.grossIrr },
  { code: 'DEAL_NET_IRR', unit: 'percent', read: (m) => m.netIrr },
  { code: 'DEAL_GROSS_MOIC', unit: 'multiple', read: (m) => m.grossMoic },
  { code: 'DEAL_NET_MOIC', unit: 'multiple', read: (m) => m.netMoic },
  { code: 'DEAL_DPI', unit: 'multiple', read: (m) => m.dpi },
  { code: 'DEAL_RVPI', unit: 'multiple', read: (m) => m.rvpi },
  { code: 'DEAL_GROSS_TO_NET_SPREAD_BPS', unit: 'number', read: (m) => (m.grossIrr != null && m.netIrr != null ? Math.round((m.grossIrr - m.netIrr) * 10000) : null) },
  { code: 'DEAL_CASH_YIELD', unit: 'percent', read: (m) => m.cashYield },
  { code: 'DEAL_ALL_IN_YIELD', unit: 'percent', read: (m) => m.allInYield },
  { code: 'DEAL_WEIGHTED_COUPON', unit: 'percent', read: (m) => m.weightedCoupon },
  { code: 'DEAL_WEIGHTED_SPREAD', unit: 'percent', read: (m) => m.weightedSpread },
  { code: 'DEAL_PIK_INCOME_SHARE', unit: 'percent', read: (m) => m.pikShare },
  { code: 'DEAL_INTEREST_COVERAGE', unit: 'multiple', read: (m) => m.coverage },
  { code: 'DEAL_WAL_YEARS', unit: 'multiple', read: (m) => m.walYears },
  { code: 'DEAL_HELD_POSITION', unit: 'amount', read: (m) => m.tranches.reduce((sum, row) => sum + row.position, 0) },
  { code: 'DEAL_INVESTED_AMOUNT', unit: 'amount', read: (m) => m.invested },
  { code: 'DEAL_MODEL_INCOME', unit: 'amount', read: (m) => m.tranches.reduce((sum, row) => sum + row.income, 0) },
  { code: 'DEAL_GROSS_PROFIT', unit: 'amount', read: (m) => m.grossProfit },
  { code: 'DEAL_NET_PROFIT', unit: 'amount', read: (m) => m.netProfit },
  { code: 'DEAL_MGMT_FEE_AMOUNT', unit: 'amount', read: (m) => m.bridge[1]?.amount ?? null },
  { code: 'DEAL_FUND_EXPENSE_AMOUNT', unit: 'amount', read: (m) => m.bridge[2]?.amount ?? null },
  { code: 'DEAL_INCENTIVE_FEE_AMOUNT', unit: 'amount', read: (m) => m.bridge[3]?.amount ?? null },
  { code: 'DEAL_INCOME_CASH', unit: 'amount', read: (m) => m.sources[0]?.amount ?? null },
  { code: 'DEAL_INCOME_PIK', unit: 'amount', read: (m) => m.sources[1]?.amount ?? null },
  { code: 'DEAL_INCOME_OID', unit: 'amount', read: (m) => m.sources[2]?.amount ?? null },
  { code: 'DEAL_INCOME_MARK', unit: 'amount', read: (m) => m.sources[3]?.amount ?? null },
  { code: 'DEAL_PROJECTION_END_DATE', unit: 'date', read: (m) => m.endDate },
];

type TrancheRow = PerformanceCase['tranches'][number];

/** Tranche-level outputs. */
export const TRANCHE_OUTPUTS: Array<{ code: string; unit: PerformanceUnit; read: (row: TrancheRow) => number | null }> = [
  { code: 'TRANCHE_HELD_POSITION', unit: 'amount', read: (r) => r.position },
  { code: 'TRANCHE_CASH_COUPON', unit: 'percent', read: (r) => r.coupon },
  { code: 'TRANCHE_MODEL_INCOME', unit: 'amount', read: (r) => r.income },
  { code: 'TRANCHE_MODEL_MARK_GAIN', unit: 'amount', read: (r) => r.mark },
  { code: 'TRANCHE_MODEL_PROFIT', unit: 'amount', read: (r) => r.profit },
  { code: 'TRANCHE_MODEL_IRR', unit: 'percent', read: (r) => r.irr },
  { code: 'TRANCHE_MODEL_MOIC', unit: 'multiple', read: (r) => r.moic },
  { code: 'TRANCHE_PROFIT_SHARE', unit: 'percent', read: (r) => r.share },
  { code: 'TRANCHE_IRR_CONTRIBUTION', unit: 'percent', read: (r) => r.contribution },
];

export interface PerformanceValue {
  entityId: string;
  code: string;
  text: string;
  numeric: number | null;
  date: string | null;
}

function stored(unit: PerformanceUnit, raw: number | string | null): { text: string; numeric: number | null; date: string | null } | null {
  if (raw == null) return null;
  if (unit === 'date') {
    const day = String(raw).slice(0, 10);
    return day ? { text: day, numeric: null, date: day } : null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const scaled = unit === 'percent' ? value * 100 : value;
  const digits = unit === 'amount' ? 2 : unit === 'number' ? 0 : 4;
  const rounded = Number(scaled.toFixed(digits));
  return { text: rounded.toFixed(digits), numeric: rounded, date: null };
}

/** The model's outputs as attribute values. Blank outputs are left out. */
export function performanceValues(dealId: string, model: PerformanceCase): PerformanceValue[] {
  const out: PerformanceValue[] = [];
  for (const output of DEAL_OUTPUTS) {
    const value = stored(output.unit, output.read(model));
    if (value) out.push({ entityId: dealId, code: output.code, ...value });
  }
  for (const row of model.tranches) {
    for (const output of TRANCHE_OUTPUTS) {
      const value = stored(output.unit, output.read(row));
      if (value) out.push({ entityId: row.id, code: output.code, ...value });
    }
  }
  return out;
}

const DEAL_INPUTS = [
  'DEAL_HOLD_YEARS', 'DEAL_BASE_RATE', 'DEAL_LEVERAGE_SENIOR', 'DEAL_LEVERAGE_TOTAL',
  'SERVICING_MARK', 'SERVICING_INDEX_RATE', 'SERVICING_UNDRAWN_FEE_PCT', 'SERVICING_PIK_RATE', 'SERVICING_AMORTIZATION_PCT',
];
const FUND_INPUTS = ['FUND_MGMT_FEE_PCT', 'FUND_EXPENSE_PCT', 'FUND_CARRY_PCT', 'FUND_HURDLE_PCT'];
const DRAW_INPUTS = ['AMORT_TYPE', 'AMORT_DATE', 'AMORT_PRINCIPAL_AMOUNT'];

type Winning = { entity_id: string; attribute_id: string; golden_value: string | null; golden_value_numeric: number | null };
type Lookup = (entityId: string, code: string) => Winning | undefined;

function amount(row: Winning | undefined): number {
  if (!row) return 0;
  if (row.golden_value_numeric != null) return Number(row.golden_value_numeric) || 0;
  const value = Number(String(row.golden_value ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(value) ? value : 0;
}

async function attributeIds(supabase: SupabaseClient, codes: string[]): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('attribute_register').select('id, attribute_code').in('attribute_code', codes);
  if (error) throw new Error(error.message);
  return new Map((data || []).map((row) => [row.attribute_code as string, row.id as string]));
}

async function winning(supabase: SupabaseClient, entityIds: string[], ids: Map<string, string>, asOf: string): Promise<Lookup> {
  const byCode = new Map<string, Winning>();
  const codeOf = new Map([...ids].map(([code, id]) => [id, code]));
  const lookup: Lookup = (entityId, code) => byCode.get(`${entityId}|${code}`);
  if (!entityIds.length || !ids.size) return lookup;
  const knowledge = new Date().toISOString();
  for (let index = 0; index < entityIds.length; index += 150) {
    const { data, error } = await supabase.schema('golden_master').rpc('winning_attribute_values', {
      p_entity_ids: entityIds.slice(index, index + 150),
      p_attribute_ids: [...ids.values()],
      p_as_of: asOf,
      p_knowledge: knowledge,
      p_require_text: false,
    });
    if (error) throw new Error(error.message);
    for (const row of (data || []) as Winning[]) byCode.set(`${row.entity_id}|${codeOf.get(row.attribute_id)}`, row);
  }
  return lookup;
}

export interface PerformanceRun {
  asOf: string;
  input: PerformanceInput | null;
  model: PerformanceCase | null;
  trancheIds: string[];
}

/** Gather the model's inputs from the entity model and run it on the committed allocation. */
export async function runDealPerformance(supabase: SupabaseClient, dealId: string, asOfInput?: string | null): Promise<PerformanceRun> {
  const draft = await loadAllocationDraft(supabase, dealId, asOfInput, null, null);
  const preview = previewFromDraft(draft);
  const asOf = draft.asOf;
  const debt = preview.tranches.filter((tranche) => !draft.faces[tranche.id]?.equityLinked);
  const trancheIds = preview.tranches.map((tranche) => tranche.id);
  const portfolios = preview.rows.filter((row) => row.level === 'PORTFOLIO');
  const held = (trancheId: string) =>
    portfolios.reduce((sum, row) => sum + (row.cells.find((cell) => cell.trancheId === trancheId)?.amount || 0), 0);

  const ids = await attributeIds(supabase, [...DEAL_INPUTS, ...FUND_INPUTS, ...DRAW_INPUTS]);
  const pick = (codes: string[]) => new Map(codes.filter((code) => ids.has(code)).map((code) => [code, ids.get(code) as string]));

  const securityOf = new Map<string, (typeof debt)[number]>();
  for (const tranche of debt) {
    const securityId = draft.faces[tranche.id]?.securityId;
    if (securityId) securityOf.set(securityId, tranche);
  }
  let drawLinks: Array<{ parent_entity_id: string; child_entity_id: string; system_to: string | null }> = [];
  if (securityOf.size) {
    const { data, error } = await supabase
      .from('entity_relationships')
      .select('parent_entity_id, child_entity_id, system_to')
      .eq('relationship_code', 'SECURITY_AMORTIZATION')
      .in('parent_entity_id', [...securityOf.keys()]);
    if (error) throw new Error(error.message);
    drawLinks = (data || []).filter((row) => !row.system_to || String(row.system_to).startsWith('9999'));
  }

  const [dealValue, fundValue, drawValue] = await Promise.all([
    winning(supabase, [dealId], pick(DEAL_INPUTS), asOf),
    winning(supabase, portfolios.map((row) => row.fundId), pick(FUND_INPUTS), asOf),
    winning(supabase, drawLinks.map((link) => link.child_entity_id), pick(DRAW_INPUTS), asOf),
  ]);

  let weight = 0;
  const blended = { management: 0, expenses: 0, carry: 0, hurdle: 0 };
  for (const row of portfolios) {
    const hold = debt.reduce((sum, tranche) => sum + (row.cells.find((cell) => cell.trancheId === tranche.id)?.amount || 0), 0);
    if (hold <= 0) continue;
    weight += hold;
    blended.management += hold * amount(fundValue(row.fundId, 'FUND_MGMT_FEE_PCT'));
    blended.expenses += hold * amount(fundValue(row.fundId, 'FUND_EXPENSE_PCT'));
    blended.carry += hold * amount(fundValue(row.fundId, 'FUND_CARRY_PCT'));
    blended.hurdle += hold * amount(fundValue(row.fundId, 'FUND_HURDLE_PCT'));
  }
  const fees: PerformanceFees = weight
    ? {
        management: blended.management / weight / 100,
        expenses: blended.expenses / weight / 100,
        carry: blended.carry / weight / 100,
        hurdle: blended.hurdle / weight / 100,
      }
    : { management: 0, expenses: 0, carry: 0, hurdle: 0 };

  const draws: Array<{ date: string; amount: number; trancheId: string }> = [];
  for (const link of drawLinks) {
    const tranche = securityOf.get(link.parent_entity_id);
    const type = String(drawValue(link.child_entity_id, 'AMORT_TYPE')?.golden_value ?? '').trim();
    if (!tranche || (type !== 'DELAYED_DRAW' && type !== 'REVOLVER_DRAW')) continue;
    const date = String(drawValue(link.child_entity_id, 'AMORT_DATE')?.golden_value ?? '').slice(0, 10);
    if (!date) continue;
    const facility = amount(drawValue(link.child_entity_id, 'AMORT_PRINCIPAL_AMOUNT'));
    draws.push({ date, amount: heldShare(facility, tranche.holdPct, tranche.size, held(tranche.id)), trancheId: tranche.id });
  }

  const closeDate = draft.facts.closeDate ? String(draft.facts.closeDate).slice(0, 10) : '';
  if (!closeDate) return { asOf, input: null, model: null, trancheIds };

  const oidPrice = Number(String(draft.facts.oid ?? '').replace(/[$,]/g, ''));
  const mark = amount(dealValue(dealId, 'SERVICING_MARK'));
  const input: PerformanceInput = {
    closeDate,
    asOfDate: asOf,
    closed: draft.facts.stage === 'CLOSED',
    holdYears: amount(dealValue(dealId, 'DEAL_HOLD_YEARS')) || 3,
    oid: oidPrice > 0 ? oidPrice / 100 : 1,
    mark: mark > 0 ? mark / 100 : 1,
    indexRate: amount(dealValue(dealId, 'SERVICING_INDEX_RATE')) / 100 || amount(dealValue(dealId, 'DEAL_BASE_RATE')) / 100,
    undrawnFeeRate: amount(dealValue(dealId, 'SERVICING_UNDRAWN_FEE_PCT')) / 100,
    pikRate: amount(dealValue(dealId, 'SERVICING_PIK_RATE')) / 100,
    amortizationRate: amount(dealValue(dealId, 'SERVICING_AMORTIZATION_PCT')) / 100,
    seniorLeverage: amount(dealValue(dealId, 'DEAL_LEVERAGE_SENIOR')) || null,
    totalLeverage: amount(dealValue(dealId, 'DEAL_LEVERAGE_TOTAL')) || null,
    fees,
    tranches: debt.map((tranche) => ({
      id: tranche.id,
      name: tranche.name,
      unfunded: tranche.unfunded,
      hold: held(tranche.id),
      spread: spreadFromPricing(draft.faces[tranche.id]?.pricing),
      draws: draws.filter((draw) => draw.trancheId === tranche.id),
    })),
  };
  return { asOf, input, model: projectPerformance(input), trancheIds };
}

/**
 * Run the model and store what changed on the performance model source.
 * Outputs the model no longer produces are closed, so a stale figure never stays current.
 */
export async function storeDealPerformance(
  supabase: SupabaseClient,
  dealId: string,
  asOfInput: string | null | undefined,
  userId: string | null,
): Promise<{ asOf: string; written: number; closed: number; unchanged: number }> {
  const run = await runDealPerformance(supabase, dealId, asOfInput);
  const values = run.model ? performanceValues(dealId, run.model) : [];
  const codes = [...DEAL_OUTPUTS, ...TRANCHE_OUTPUTS].map((output) => output.code);
  const ids = await attributeIds(supabase, codes);
  const missing = codes.filter((code) => !ids.has(code));
  if (missing.length) throw new Error(`Performance attributes are not registered: ${missing.join(', ')}`);

  const { data: source, error: sourceError } = await supabase
    .schema('entity_instances').from('source_registry').select('id, precedence_rank').eq('source_code', PERFORMANCE_SOURCE).maybeSingle();
  if (sourceError || !source?.id) throw new Error(sourceError?.message || `${PERFORMANCE_SOURCE} source is not registered`);

  const entityIds = [dealId, ...run.trancheIds];
  const { data: open, error: openError } = await supabase
    .from('entity_attribute_values')
    .select('id, entity_id, attribute_id, golden_value')
    .in('entity_id', entityIds)
    .in('attribute_id', [...ids.values()])
    .eq('source_id', source.id)
    .eq('system_to', OPEN_SYSTEM);
  if (openError) throw new Error(openError.message);
  const current = new Map((open || []).map((row) => [`${row.entity_id}|${row.attribute_id}`, row]));

  const inputs = run.input
    ? {
        closeDate: run.input.closeDate, holdYears: run.input.holdYears, oid: run.input.oid, mark: run.input.mark,
        indexRate: run.input.indexRate, undrawnFeeRate: run.input.undrawnFeeRate, pikRate: run.input.pikRate,
        amortizationRate: run.input.amortizationRate, fees: run.input.fees,
      }
    : null;
  const stamp = new Date().toISOString();
  let written = 0;
  let unchanged = 0;
  const kept = new Set<string>();
  for (const value of values) {
    const attributeId = ids.get(value.code) as string;
    const key = `${value.entityId}|${attributeId}`;
    kept.add(key);
    const existing = current.get(key);
    if (existing && existing.golden_value === value.text) { unchanged += 1; continue; }
    if (existing) {
      const { error } = await supabase.from('entity_attribute_values').update({ valid_to: run.asOf, system_to: stamp }).eq('id', existing.id);
      if (error) throw new Error(error.message);
    }
    const { error } = await supabase.from('entity_attribute_values').insert({
      entity_id: value.entityId,
      attribute_id: attributeId,
      source_id: source.id,
      golden_value: value.text,
      golden_value_numeric: value.numeric,
      golden_value_date: value.date,
      valid_from: run.asOf,
      precedence_rank: source.precedence_rank ?? 100,
      is_manual_override: false,
      created_by: userId,
      metadata: { model: 'deal-performance', inputs },
    });
    if (error) throw new Error(error.message);
    written += 1;
  }
  let closed = 0;
  for (const [key, row] of current) {
    if (kept.has(key)) continue;
    const { error } = await supabase.from('entity_attribute_values').update({ valid_to: run.asOf, system_to: stamp }).eq('id', row.id);
    if (error) throw new Error(error.message);
    closed += 1;
  }
  return { asOf: run.asOf, written, closed, unchanged };
}
