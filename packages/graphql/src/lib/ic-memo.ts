/**
 * Assemble the investment-committee memo for one deal from the entities that
 * hold it: deal facts, memo points, sources and uses, the borrower's financial
 * periods, committee approvals, and open items.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const CODES = [
  'DEAL_MEMO_STATUS', 'DEAL_TEAM', 'DEAL_IC_DATE', 'DEAL_SECTOR', 'DEAL_BASE_RATE', 'DEAL_HOLD_YEARS',
  'DEAL_EXPECTED_MOIC', 'DEAL_BLENDED_GROSS_IRR', 'DEAL_RECOMMENDATION', 'SECTOR',
  'MEMO_POINT_KIND', 'MEMO_POINT_TITLE', 'MEMO_POINT_BODY', 'MEMO_POINT_ORDER',
  'CAPITAL_SIDE', 'CAPITAL_LABEL', 'CAPITAL_AMOUNT', 'CAPITAL_ORDER',
  'PERIOD_LABEL', 'PERIOD_BASIS', 'PERIOD_ORDER', 'PERIOD_REVENUE', 'PERIOD_EBITDA', 'PERIOD_EBITDA_MARGIN',
  'PERIOD_FREE_CASH_FLOW', 'PERIOD_FUNDED_DEBT_TO_EBITDA', 'PERIOD_EBITDA_TO_CASH_INTEREST',
  'APPROVAL_MEMBER', 'APPROVAL_ROLE', 'APPROVAL_DECISION', 'APPROVAL_DATE', 'APPROVAL_ORDER',
  'OPEN_ITEM_TITLE', 'OPEN_ITEM_STATUS', 'OPEN_ITEM_ORDER',
  'TRANCHE_GROSS_YIELD', 'TRANCHE_SENIORITY',
] as const;

export interface IcMemoPoint {
  id: string;
  kind: string;
  title: string;
  body: string;
  sortOrder: number;
}

export interface IcCapitalItem {
  id: string;
  side: string;
  label: string;
  amount: number;
  sortOrder: number;
}

export interface IcFinancialPeriod {
  id: string;
  label: string;
  basis: string;
  sortOrder: number;
  revenue: number | null;
  ebitda: number | null;
  ebitdaMargin: number | null;
  freeCashFlow: number | null;
  fundedDebtToEbitda: number | null;
  ebitdaToCashInterest: number | null;
}

export interface IcApproval {
  id: string;
  member: string;
  role: string;
  decision: string;
  decidedOn: string;
  sortOrder: number;
}

export interface IcOpenItem {
  id: string;
  title: string;
  status: string;
  sortOrder: number;
}

export interface IcTrancheYield {
  trancheId: string;
  grossYield: number | null;
  seniority: string;
}

export interface IcMemoDocument {
  dealId: string;
  clientId: string;
  issuerId: string;
  memoStatus: string;
  team: string;
  icDate: string;
  sector: string;
  baseRate: number | null;
  holdYears: number | null;
  expectedMoic: number | null;
  blendedIrr: number | null;
  recommendation: string;
  points: IcMemoPoint[];
  capitalItems: IcCapitalItem[];
  periods: IcFinancialPeriod[];
  approvals: IcApproval[];
  openItems: IcOpenItem[];
  trancheYields: IcTrancheYield[];
}

type ValueRow = { entity_id: string; attribute_id: string; golden_value: string | null; golden_value_numeric: number | null };
type AttributeDef = { id: string; code: string };

function asOfDate(value: string | null | undefined): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date().toISOString().slice(0, 10);
}

function isOpen(systemTo: string | null | undefined): boolean {
  return !systemTo || String(systemTo).startsWith('9999');
}

function text(row: ValueRow | undefined): string {
  return row?.golden_value?.trim() || '';
}

function numeric(row: ValueRow | undefined): number | null {
  if (!row) return null;
  if (row.golden_value_numeric != null && row.golden_value_numeric !== undefined) return Number(row.golden_value_numeric);
  if (row.golden_value == null || row.golden_value === '') return null;
  const parsed = Number(row.golden_value);
  return Number.isFinite(parsed) ? parsed : null;
}

function read(values: Map<string, ValueRow>, entityId: string, defs: Map<string, AttributeDef>, code: string): ValueRow | undefined {
  const def = defs.get(code);
  if (!def) return undefined;
  return values.get(`${entityId}|${def.id}`);
}

async function attributeDefs(supabase: SupabaseClient): Promise<Map<string, AttributeDef>> {
  const { data, error } = await supabase.from('attribute_register').select('id, attribute_code').in('attribute_code', [...CODES]);
  if (error) throw new Error(error.message);
  const defs = new Map<string, AttributeDef>();
  for (const row of data || []) defs.set(row.attribute_code, { id: row.id, code: row.attribute_code });
  return defs;
}

async function valuesFor(supabase: SupabaseClient, entityIds: string[], defs: Map<string, AttributeDef>, asOf: string): Promise<Map<string, ValueRow>> {
  const out = new Map<string, ValueRow>();
  const attributeIds = [...defs.values()].map((def) => def.id);
  if (!entityIds.length || !attributeIds.length) return out;
  const knowledge = new Date().toISOString();
  for (let index = 0; index < entityIds.length; index += 150) {
    const slice = entityIds.slice(index, index + 150);
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

async function linked(supabase: SupabaseClient, code: string, childIds: string[]) {
  if (!childIds.length) return [] as Array<{ id: string; name: string }>;
  const { data, error } = await supabase
    .from('entity_relationships')
    .select('parent_entity_id, system_to')
    .eq('relationship_code', code)
    .in('child_entity_id', childIds);
  if (error) throw new Error(error.message);
  const ids = (data || []).filter((row) => isOpen(row.system_to)).map((row) => row.parent_entity_id);
  if (!ids.length) return [];
  const { data: entities, error: entityError } = await supabase
    .from('master_entities')
    .select('id, entity_name, is_active')
    .in('id', ids);
  if (entityError) throw new Error(entityError.message);
  return (entities || []).filter((row) => row.is_active !== false).map((row) => ({ id: row.id, name: row.entity_name as string }));
}

function byOrder(left: { sortOrder: number }, right: { sortOrder: number }): number {
  return left.sortOrder - right.sortOrder;
}

export function emptyIcMemo(dealId: string): IcMemoDocument {
  return {
    dealId,
    clientId: '',
    issuerId: '',
    memoStatus: '',
    team: '',
    icDate: '',
    sector: '',
    baseRate: null,
    holdYears: null,
    expectedMoic: null,
    blendedIrr: null,
    recommendation: '',
    points: [],
    capitalItems: [],
    periods: [],
    approvals: [],
    openItems: [],
    trancheYields: [],
  };
}

export async function loadIcMemo(
  supabase: SupabaseClient,
  dealId: string,
  asOfInput: string | null | undefined,
): Promise<IcMemoDocument> {
  const asOf = asOfDate(asOfInput);
  const { data: deal, error: dealError } = await supabase
    .from('master_entities')
    .select('id, client_id, domain_code')
    .eq('id', dealId)
    .maybeSingle();
  if (dealError) throw new Error(dealError.message);
  if (!deal) throw new Error('Deal not found');

  const defs = await attributeDefs(supabase);
  const { data: issuerRel, error: issuerError } = await supabase
    .from('entity_relationships')
    .select('child_entity_id, system_to')
    .eq('relationship_code', 'DEAL_ISSUER')
    .eq('parent_entity_id', dealId);
  if (issuerError) throw new Error(issuerError.message);
  const issuerId = (issuerRel || []).find((row) => isOpen(row.system_to))?.child_entity_id || '';

  const [points, capital, periods, approvals, items, tranches] = await Promise.all([
    linked(supabase, 'MEMO_POINT_DEAL', [dealId]),
    linked(supabase, 'CAPITAL_ITEM_DEAL', [dealId]),
    linked(supabase, 'PERIOD_ISSUER', issuerId ? [issuerId] : []),
    linked(supabase, 'APPROVAL_DEAL', [dealId]),
    linked(supabase, 'OPEN_ITEM_DEAL', [dealId]),
    linked(supabase, 'TRANCHE_DEAL', [dealId]),
  ]);

  const entityIds = [dealId, issuerId, ...points, ...capital, ...periods, ...approvals, ...items, ...tranches]
    .map((row) => (typeof row === 'string' ? row : row.id))
    .filter(Boolean);
  const values = await valuesFor(supabase, entityIds, defs, asOf);
  const value = (id: string, code: string) => read(values, id, defs, code);

  return {
    dealId,
    clientId: deal.client_id || '',
    issuerId,
    memoStatus: text(value(dealId, 'DEAL_MEMO_STATUS')) || 'DRAFT',
    team: text(value(dealId, 'DEAL_TEAM')),
    icDate: text(value(dealId, 'DEAL_IC_DATE')),
    sector: text(value(dealId, 'DEAL_SECTOR')) || text(value(issuerId, 'SECTOR')),
    baseRate: numeric(value(dealId, 'DEAL_BASE_RATE')),
    holdYears: numeric(value(dealId, 'DEAL_HOLD_YEARS')),
    expectedMoic: numeric(value(dealId, 'DEAL_EXPECTED_MOIC')),
    blendedIrr: numeric(value(dealId, 'DEAL_BLENDED_GROSS_IRR')),
    recommendation: text(value(dealId, 'DEAL_RECOMMENDATION')),
    points: points.map((row) => ({
      id: row.id,
      kind: text(value(row.id, 'MEMO_POINT_KIND')) || 'THESIS',
      title: text(value(row.id, 'MEMO_POINT_TITLE')),
      body: text(value(row.id, 'MEMO_POINT_BODY')),
      sortOrder: numeric(value(row.id, 'MEMO_POINT_ORDER')) ?? 0,
    })).sort(byOrder),
    capitalItems: capital.map((row) => ({
      id: row.id,
      side: text(value(row.id, 'CAPITAL_SIDE')) || 'SOURCE',
      label: text(value(row.id, 'CAPITAL_LABEL')) || row.name,
      amount: numeric(value(row.id, 'CAPITAL_AMOUNT')) ?? 0,
      sortOrder: numeric(value(row.id, 'CAPITAL_ORDER')) ?? 0,
    })).sort(byOrder),
    periods: periods.map((row) => ({
      id: row.id,
      label: text(value(row.id, 'PERIOD_LABEL')) || row.name,
      basis: text(value(row.id, 'PERIOD_BASIS')),
      sortOrder: numeric(value(row.id, 'PERIOD_ORDER')) ?? 0,
      revenue: numeric(value(row.id, 'PERIOD_REVENUE')),
      ebitda: numeric(value(row.id, 'PERIOD_EBITDA')),
      ebitdaMargin: numeric(value(row.id, 'PERIOD_EBITDA_MARGIN')),
      freeCashFlow: numeric(value(row.id, 'PERIOD_FREE_CASH_FLOW')),
      fundedDebtToEbitda: numeric(value(row.id, 'PERIOD_FUNDED_DEBT_TO_EBITDA')),
      ebitdaToCashInterest: numeric(value(row.id, 'PERIOD_EBITDA_TO_CASH_INTEREST')),
    })).sort(byOrder),
    approvals: approvals.map((row) => ({
      id: row.id,
      member: text(value(row.id, 'APPROVAL_MEMBER')) || row.name,
      role: text(value(row.id, 'APPROVAL_ROLE')) || 'MEMBER',
      decision: text(value(row.id, 'APPROVAL_DECISION')) || 'PENDING',
      decidedOn: text(value(row.id, 'APPROVAL_DATE')),
      sortOrder: numeric(value(row.id, 'APPROVAL_ORDER')) ?? 0,
    })).sort(byOrder),
    openItems: items.map((row) => ({
      id: row.id,
      title: text(value(row.id, 'OPEN_ITEM_TITLE')) || row.name,
      status: text(value(row.id, 'OPEN_ITEM_STATUS')) || 'OPEN',
      sortOrder: numeric(value(row.id, 'OPEN_ITEM_ORDER')) ?? 0,
    })).sort(byOrder),
    trancheYields: tranches.map((row) => ({
      trancheId: row.id,
      grossYield: numeric(value(row.id, 'TRANCHE_GROSS_YIELD')),
      seniority: text(value(row.id, 'TRANCHE_SENIORITY')),
    })),
  };
}
