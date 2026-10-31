/**
 * Load a deal's tranches and fund tree, run the allocation engine, and write
 * the result through the same attribute ledger as a manual edit.
 *
 * Engine amounts are stored on the Allocation Engine source. A manual override
 * is a second value on the manual source, with the reason in override_reason.
 * The golden-record preference keeps the manual value in front.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  allocate,
  type AllocationAdjustment,
  type AllocationPortfolio,
  type AllocationRequest,
  type AllocationResult,
  type AllocationSleeve,
  type AllocationTranche,
} from './allocation-engine';

const OPEN_SYSTEM = '9999-12-31 23:59:59';

const VALUE_CODES = [
  'TRANCHE_SIZE', 'TRANCHE_HOLD_PCT', 'TRANCHE_IS_UNFUNDED', 'TRANCHE_IS_EQUITY_LINKED', 'TRANCHE_RANK',
  'TRANCHE_PRICING', 'TRANCHE_CALL_PROTECTION', 'TRANCHE_TICKING_FEE_PCT', 'TRANCHE_WARRANT_COVERAGE_PCT',
  'INSTRUMENT_TYPE',
  'NAV', 'FUND_CASH_BALANCE', 'FUND_UNDRAWN_COMMITMENTS', 'FUND_CREDIT_LINE_HEADROOM', 'FUND_PIPELINE_RESERVE',
  'FUND_ALLOWED_INSTRUMENT_TYPES', 'FUND_MANDATE_NOTE',
  'FUND_SINGLE_ISSUER_LIMIT_PCT', 'FUND_SPONSOR_LIMIT_PCT', 'FUND_UNFUNDED_LIMIT_PCT',
  'POSITION_IS_HYPOTHETICAL', 'POSITION_ALLOCATION_ADJUSTMENT', 'POSITION_ALLOCATION_REASON',
  'POSITION_ALLOCATION_NOTE', 'POSITION_ALLOCATION_ROLE', 'POSITION_ALLOCATION_CAP', 'MARKET_VALUE',
  'POSITION_SCENARIO_CODE', 'FUNDED_PAR_AMOUNT', 'UNFUNDED_COMMITMENT_AMOUNT',
  'DEAL_DESCRIPTION', 'DEAL_STAGE', 'DEAL_STRATEGY', 'DEAL_PRICING_SUMMARY', 'DEAL_OID_PRICE',
  'DEAL_LEVERAGE_SENIOR', 'DEAL_LEVERAGE_TOTAL', 'DEAL_MATURITY_DATE', 'DEAL_TARGET_CLOSE_DATE',
] as const;

export interface AllocationHold {
  trancheId: string;
  holdPct: number;
}

export interface AllocationDraft {
  dealId: string;
  dealCode: string;
  dealName: string;
  asOf: string;
  request: AllocationRequest;
  tranches: LoadedTranche[];
  positions: LoadedPosition[];
  portfolioIds: Set<string>;
  clientId: string | null;
  facts: AllocationFacts;
  faces: Record<string, TrancheFace>;
}

export interface LoadedTranche {
  id: string;
  code: string;
  name: string;
  securityId: string | null;
}

export interface LoadedPosition {
  id: string;
  code: string;
  fundId: string;
  trancheId: string;
  role: string;
}

export interface AllocationFacts {
  description: string;
  stage: string;
  strategy: string;
  borrower: string;
  borrowerId: string;
  sponsor: string;
  sponsorId: string;
  pricing: string;
  oid: string;
  leverage: string;
  maturity: string;
  closeDate: string;
}

export interface TrancheFace {
  rank: number;
  label: string;
  pricing: string;
  callProtection: string;
  equityLinked: boolean;
  coverage: string;
  tickingFee: string;
  status: string;
  securityId: string;
}

export interface AllocationPreview extends AllocationResult {
  dealId: string;
  dealCode: string;
  dealName: string;
  facts: AllocationFacts;
  adjustments: AllocationAdjustment[];
}

type ValueRow = {
  entity_id: string;
  attribute_id: string;
  golden_value: string | null;
  golden_value_numeric: number | null;
};

type AttributeDef = { id: string; code: string; precedence: number };

function asOfDate(value: string | null | undefined): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date().toISOString().slice(0, 10);
}

function isOpen(systemTo: string | null | undefined): boolean {
  return !systemTo || String(systemTo).startsWith('9999');
}

function numeric(row: ValueRow | undefined): number | null {
  if (!row) return null;
  if (row.golden_value_numeric != null && row.golden_value_numeric !== undefined) return Number(row.golden_value_numeric);
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

function list(row: ValueRow | undefined): string[] {
  const value = text(row);
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch {
      // A comma-separated list is the form the sample data writes.
    }
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function limitFraction(row: ValueRow | undefined): number {
  const value = numeric(row);
  if (value == null) return Number.POSITIVE_INFINITY;
  return value / 100;
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'X';
}

async function attributeDefs(supabase: SupabaseClient): Promise<Map<string, AttributeDef>> {
  const { data, error } = await supabase
    .from('attribute_register')
    .select('id, attribute_code, default_precedence_rank')
    .in('attribute_code', [...VALUE_CODES]);
  if (error) throw new Error(error.message);
  const defs = new Map<string, AttributeDef>();
  for (const row of data || []) {
    defs.set(row.attribute_code, {
      id: row.id,
      code: row.attribute_code,
      precedence: row.default_precedence_rank ?? 100,
    });
  }
  return defs;
}

async function valuesFor(
  supabase: SupabaseClient,
  entityIds: string[],
  defs: Map<string, AttributeDef>,
  asOf: string,
): Promise<Map<string, ValueRow>> {
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

function read(values: Map<string, ValueRow>, entityId: string, def: AttributeDef | undefined): ValueRow | undefined {
  if (!def) return undefined;
  return values.get(`${entityId}|${def.id}`);
}

async function openRelationships(supabase: SupabaseClient, code: string, column: 'parent_entity_id' | 'child_entity_id', ids: string[]) {
  if (!ids.length) return [] as Array<{ parent_entity_id: string; child_entity_id: string; system_to: string | null }>;
  const { data, error } = await supabase
    .from('entity_relationships')
    .select('parent_entity_id, child_entity_id, system_to')
    .eq('relationship_code', code)
    .in(column, ids);
  if (error) throw new Error(error.message);
  return (data || []).filter((row) => isOpen(row.system_to));
}

export async function loadAllocationDraft(
  supabase: SupabaseClient,
  dealId: string,
  asOfInput: string | null | undefined,
  holds: AllocationHold[] | null | undefined,
  adjustments: AllocationAdjustment[] | null | undefined,
): Promise<AllocationDraft> {
  const asOf = asOfDate(asOfInput);
  const { data: deal, error: dealError } = await supabase
    .from('master_entities')
    .select('id, entity_code, entity_name, client_id, domain_code')
    .eq('id', dealId)
    .maybeSingle();
  if (dealError) throw new Error(dealError.message);
  if (!deal) throw new Error('Deal not found');

  const trancheRels = await openRelationships(supabase, 'TRANCHE_DEAL', 'child_entity_id', [dealId]);
  const trancheIds = trancheRels.map((row) => row.parent_entity_id);
  const { data: trancheRows, error: trancheError } = trancheIds.length
    ? await supabase.from('master_entities').select('id, entity_code, entity_name').in('id', trancheIds)
    : { data: [], error: null };
  if (trancheError) throw new Error(trancheError.message);

  const securityRels = await openRelationships(supabase, 'TRANCHE_SECURITY', 'parent_entity_id', trancheIds);
  const securityByTranche = new Map(securityRels.map((row) => [row.parent_entity_id, row.child_entity_id]));

  let fundQuery = supabase.from('master_entities').select('id, entity_code, entity_name, client_id').eq('domain_code', 'FUND').eq('is_active', true);
  if (deal.client_id) fundQuery = fundQuery.eq('client_id', deal.client_id);
  const { data: fundRows, error: fundError } = await fundQuery;
  if (fundError) throw new Error(fundError.message);
  const funds = fundRows || [];
  const fundIds = funds.map((row) => row.id);
  const parentRels = await openRelationships(supabase, 'FUND_PARENT', 'parent_entity_id', fundIds);
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const rel of parentRels) {
    if (!fundIds.includes(rel.child_entity_id)) continue;
    parentOf.set(rel.child_entity_id, rel.parent_entity_id);
    const list = childrenOf.get(rel.parent_entity_id) || [];
    list.push(rel.child_entity_id);
    childrenOf.set(rel.parent_entity_id, list);
  }

  const positionRels = await openRelationships(supabase, 'POSITION_TRANCHE', 'child_entity_id', trancheIds);
  const positionIds = positionRels.map((row) => row.parent_entity_id);
  const fundRels = await openRelationships(supabase, 'POSITION_FUND', 'parent_entity_id', positionIds);
  const fundOfPosition = new Map(fundRels.map((row) => [row.parent_entity_id, row.child_entity_id]));
  const trancheOfPosition = new Map(positionRels.map((row) => [row.parent_entity_id, row.child_entity_id]));
  const { data: positionRows, error: positionError } = positionIds.length
    ? await supabase.from('master_entities').select('id, entity_code').in('id', positionIds)
    : { data: [], error: null };
  if (positionError) throw new Error(positionError.message);

  const defs = await attributeDefs(supabase);
  const issuerRels = await openRelationships(supabase, 'DEAL_ISSUER', 'parent_entity_id', [dealId]);
  const sponsorRels = await openRelationships(supabase, 'DEAL_SPONSOR', 'parent_entity_id', [dealId]);
  const namedIds = [issuerRels[0]?.child_entity_id, sponsorRels[0]?.child_entity_id].filter((id): id is string => Boolean(id));
  const { data: namedRows } = namedIds.length
    ? await supabase.from('master_entities').select('id, entity_name').in('id', namedIds)
    : { data: [] as Array<{ id: string; entity_name: string }> };
  const named = new Map((namedRows || []).map((row) => [row.id, row.entity_name]));

  const entityIds = [
    dealId,
    ...trancheIds,
    ...[...securityByTranche.values()],
    ...fundIds,
    ...positionIds,
  ];
  const values = await valuesFor(supabase, entityIds, defs, asOf);
  const def = (code: string) => defs.get(code);

  const loadedTranches: LoadedTranche[] = (trancheRows || []).map((row) => ({
    id: row.id,
    code: row.entity_code,
    name: row.entity_name,
    securityId: securityByTranche.get(row.id) || null,
  }));
  const holdById = new Map((holds || []).map((hold) => [hold.trancheId, hold.holdPct]));
  const faces: Record<string, TrancheFace> = {};
  const tranches: AllocationTranche[] = loadedTranches.map((tranche) => {
    const securityId = tranche.securityId;
    const unfunded = flag(read(values, tranche.id, def('TRANCHE_IS_UNFUNDED')));
    const equityLinked = flag(read(values, tranche.id, def('TRANCHE_IS_EQUITY_LINKED')));
    const instrumentType = text(read(values, securityId || '', def('INSTRUMENT_TYPE')));
    const pricing = text(read(values, tranche.id, def('TRANCHE_PRICING')));
    const coverage = text(read(values, tranche.id, def('TRANCHE_WARRANT_COVERAGE_PCT')));
    const ticking = text(read(values, tranche.id, def('TRANCHE_TICKING_FEE_PCT')));
    faces[tranche.id] = {
      rank: numeric(read(values, tranche.id, def('TRANCHE_RANK'))) ?? 99,
      label: columnLabel(tranche.name, instrumentType),
      pricing,
      callProtection: text(read(values, tranche.id, def('TRANCHE_CALL_PROTECTION'))),
      equityLinked,
      coverage: coverage ? `${coverage}% fully diluted` : '',
      tickingFee: ticking ? `${ticking}%` : '',
      status: unfunded ? 'Unfunded, drawn on demand' : equityLinked ? 'Issued at close' : 'Funded at close',
      securityId: securityId || '',
    };
    return {
      id: tranche.id,
      name: tranche.name.includes(':') ? tranche.name.split(':').pop()!.trim() : tranche.name,
      size: numeric(read(values, tranche.id, def('TRANCHE_SIZE'))) || 0,
      holdPct: holdById.has(tranche.id)
        ? holdById.get(tranche.id) as number
        : (numeric(read(values, tranche.id, def('TRANCHE_HOLD_PCT'))) || 0),
      unfunded,
      instrumentType,
    };
  }).sort((left, right) => (
    (faces[left.id]?.rank ?? 99) - (faces[right.id]?.rank ?? 99)
    || instrumentSeniority(left.instrumentType) - instrumentSeniority(right.instrumentType)
    || left.name.localeCompare(right.name)
  ));

  const sleeve = (id: string, parentAllowed: string[]): AllocationSleeve | null => {
    const row = funds.find((fund) => fund.id === id);
    if (!row) return null;
    const ownAllowed = list(read(values, id, def('FUND_ALLOWED_INSTRUMENT_TYPES')));
    return {
      id,
      name: row.entity_name,
      nav: numeric(read(values, id, def('NAV'))) || 0,
      cash: numeric(read(values, id, def('FUND_CASH_BALANCE'))) || 0,
      undrawn: numeric(read(values, id, def('FUND_UNDRAWN_COMMITMENTS'))) || 0,
      line: numeric(read(values, id, def('FUND_CREDIT_LINE_HEADROOM'))) || 0,
      reserve: numeric(read(values, id, def('FUND_PIPELINE_RESERVE'))) || 0,
      allowed: ownAllowed.length ? ownAllowed : parentAllowed,
      denyNote: text(read(values, id, def('FUND_MANDATE_NOTE'))),
    };
  };

  const portfolios: AllocationPortfolio[] = [];
  const portfolioIds = new Set<string>();
  for (const fund of funds) {
    if (parentOf.has(fund.id)) continue;
    const issuerLimit = numeric(read(values, fund.id, def('FUND_SINGLE_ISSUER_LIMIT_PCT')));
    if (issuerLimit == null) continue;
    const allowed = list(read(values, fund.id, def('FUND_ALLOWED_INSTRUMENT_TYPES')));
    const childIds = childrenOf.get(fund.id) || [];
    if (!allowed.length && !childIds.length) continue;
    const sleeves = childIds.map((id) => sleeve(id, allowed)).filter((item): item is AllocationSleeve => Boolean(item));
    if (!sleeves.length) continue;
    portfolioIds.add(fund.id);
    portfolios.push({
      id: fund.id,
      name: fund.entity_name,
      nav: numeric(read(values, fund.id, def('NAV'))) || sleeves.reduce((total, item) => total + item.nav, 0),
      issuerLimit: issuerLimit / 100,
      sponsorLimit: limitFraction(read(values, fund.id, def('FUND_SPONSOR_LIMIT_PCT'))),
      unfundedLimit: limitFraction(read(values, fund.id, def('FUND_UNFUNDED_LIMIT_PCT'))),
      sponsorExposure: 0,
      unfundedExposure: 0,
      allowed,
      denyNote: text(read(values, fund.id, def('FUND_MANDATE_NOTE'))),
      sleeves,
    });
  }
  portfolios.sort((left, right) => right.nav - left.nav || left.name.localeCompare(right.name));

  const positions: LoadedPosition[] = [];
  const storedAdjustments: AllocationAdjustment[] = [];
  for (const row of positionRows || []) {
    const fundId = fundOfPosition.get(row.id);
    const trancheId = trancheOfPosition.get(row.id);
    if (!fundId || !trancheId) continue;
    if (text(read(values, row.id, def('POSITION_SCENARIO_CODE'))) && text(read(values, row.id, def('POSITION_SCENARIO_CODE'))) !== deal.entity_code) continue;
    const role = text(read(values, row.id, def('POSITION_ALLOCATION_ROLE'))) || 'PROPOSAL';
    positions.push({ id: row.id, code: row.entity_code, fundId, trancheId, role });
    const kind = text(read(values, row.id, def('POSITION_ALLOCATION_ADJUSTMENT'))).toLowerCase();
    if (kind === 'override' || kind === 'exclude') {
      storedAdjustments.push({
        fundId,
        trancheId,
        type: kind,
        amount: kind === 'override' ? (numeric(read(values, row.id, def('MARKET_VALUE'))) || 0) : undefined,
        reason: text(read(values, row.id, def('POSITION_ALLOCATION_REASON'))) || undefined,
        note: text(read(values, row.id, def('POSITION_ALLOCATION_NOTE'))) || undefined,
      });
    }
  }

  return {
    dealId: deal.id,
    dealCode: deal.entity_code,
    dealName: deal.entity_name,
    asOf,
    request: {
      tranches,
      portfolios,
      adjustments: adjustments ?? storedAdjustments,
    },
    tranches: loadedTranches,
    positions,
    portfolioIds,
    clientId: deal.client_id ?? null,
    facts: {
      description: text(read(values, dealId, def('DEAL_DESCRIPTION'))),
      stage: text(read(values, dealId, def('DEAL_STAGE'))),
      strategy: text(read(values, dealId, def('DEAL_STRATEGY'))),
      borrower: named.get(issuerRels[0]?.child_entity_id || '') || '',
      borrowerId: issuerRels[0]?.child_entity_id || '',
      sponsor: named.get(sponsorRels[0]?.child_entity_id || '') || '',
      sponsorId: sponsorRels[0]?.child_entity_id || '',
      pricing: text(read(values, dealId, def('DEAL_PRICING_SUMMARY'))),
      oid: text(read(values, dealId, def('DEAL_OID_PRICE'))),
      leverage: [text(read(values, dealId, def('DEAL_LEVERAGE_SENIOR'))), text(read(values, dealId, def('DEAL_LEVERAGE_TOTAL')))].filter(Boolean).map((value) => `${value}x`).join(' / '),
      maturity: text(read(values, dealId, def('DEAL_MATURITY_DATE'))),
      closeDate: text(read(values, dealId, def('DEAL_TARGET_CLOSE_DATE'))),
    },
    faces,
  };
}

export function previewFromDraft(draft: AllocationDraft): AllocationPreview {
  const result = allocate(draft.request);
  const liquidity = new Map<string, { cash: number; undrawn: number; line: number; reserve: number; issuerLimit: number | null; sponsorLimit: number | null; unfundedLimit: number | null }>();
  const finite = (value: number) => (Number.isFinite(value) ? value : null);
  for (const portfolio of draft.request.portfolios) {
    const limits = {
      issuerLimit: finite(portfolio.issuerLimit),
      sponsorLimit: finite(portfolio.sponsorLimit),
      unfundedLimit: finite(portfolio.unfundedLimit),
    };
    liquidity.set(portfolio.id, {
      ...portfolio.sleeves.reduce((total, sleeve) => ({
        cash: total.cash + sleeve.cash,
        undrawn: total.undrawn + sleeve.undrawn,
        line: total.line + sleeve.line,
        reserve: total.reserve + sleeve.reserve,
      }), { cash: 0, undrawn: 0, line: 0, reserve: 0 }),
      ...limits,
    });
    for (const sleeve of portfolio.sleeves) {
      liquidity.set(sleeve.id, { cash: sleeve.cash, undrawn: sleeve.undrawn, line: sleeve.line, reserve: sleeve.reserve, ...limits });
    }
  }
  return {
    ...result,
    tranches: result.tranches.map((tranche) => ({ ...tranche, ...(draft.faces[tranche.id] || {}) })),
    rows: result.rows.map((row) => ({
      ...row,
      ...(liquidity.get(row.fundId) || { cash: 0, undrawn: 0, line: 0, reserve: 0, issuerLimit: null, sponsorLimit: null, unfundedLimit: null }),
    })),
    dealId: draft.dealId,
    dealCode: draft.dealCode,
    dealName: draft.dealName,
    facts: draft.facts,
    ...draft.facts,
    adjustments: draft.request.adjustments || [],
  };
}

const COLUMN_LABEL: Record<string, string> = {
  LOAN: 'Term Loan',
  DELAYED_DRAW_TERM_LOAN: 'DDTL',
  REVOLVING_CREDIT: 'Revolver',
  SECOND_LIEN_LOAN: '2L Term Loan',
  MEZZANINE: 'Mezz Notes',
  WARRANT: 'Warrant',
  PREFERRED_EQUITY: 'Preferred',
};

function columnLabel(name: string, instrument: string): string {
  return COLUMN_LABEL[instrument] || (name.includes(':') ? name.split(':').pop()!.trim() : name);
}

const INSTRUMENT_SENIORITY: Record<string, number> = {
  LOAN: 1,
  DELAYED_DRAW_TERM_LOAN: 2,
  REVOLVING_CREDIT: 3,
  SECOND_LIEN_LOAN: 4,
  MEZZANINE: 5,
  PREFERRED_EQUITY: 6,
  WARRANT: 7,
};

function instrumentSeniority(instrument: string): number {
  return INSTRUMENT_SENIORITY[instrument] ?? 50;
}

async function sourceId(supabase: SupabaseClient, code: string): Promise<string> {
  const { data, error } = await supabase.schema('entity_instances').from('source_registry').select('id').eq('source_code', code).maybeSingle();
  if (error || !data?.id) throw new Error(error?.message || `${code} source is not registered`);
  return data.id;
}

async function writeValue(
  supabase: SupabaseClient,
  input: {
    entityId: string;
    attributeId: string;
    sourceId: string;
    text: string;
    numeric: number | null;
    boolean: boolean | null;
    asOf: string;
    userId: string | null;
    precedence: number;
    manual: boolean;
    reason: string | null;
  },
) {
  const { error: closeError } = await supabase
    .from('entity_attribute_values')
    .update({ valid_to: input.asOf, system_to: new Date().toISOString() })
    .eq('entity_id', input.entityId)
    .eq('attribute_id', input.attributeId)
    .eq('source_id', input.sourceId)
    .eq('system_to', OPEN_SYSTEM);
  if (closeError) throw new Error(closeError.message);

  const { error } = await supabase.from('entity_attribute_values').insert({
    entity_id: input.entityId,
    attribute_id: input.attributeId,
    source_id: input.sourceId,
    golden_value: input.text,
    golden_value_numeric: input.numeric,
    golden_value_boolean: input.boolean,
    valid_from: input.asOf,
    precedence_rank: input.precedence,
    is_manual_override: input.manual,
    override_reason: input.reason,
    created_by: input.userId,
  });
  if (error) throw new Error(error.message);
}

async function closeValue(
  supabase: SupabaseClient,
  entityId: string,
  attributeId: string,
  sourceId: string,
  asOf: string,
) {
  const { error } = await supabase
    .from('entity_attribute_values')
    .update({ valid_to: asOf, system_to: new Date().toISOString() })
    .eq('entity_id', entityId)
    .eq('attribute_id', attributeId)
    .eq('source_id', sourceId)
    .eq('system_to', OPEN_SYSTEM);
  if (error) throw new Error(error.message);
}

export async function commitAllocation(
  supabase: SupabaseClient,
  draft: AllocationDraft,
  userId: string | null,
  options?: { proposalsOnly?: boolean },
): Promise<AllocationPreview> {
  const preview = previewFromDraft(draft);
  const defs = await attributeDefs(supabase);
  const engine = await sourceId(supabase, 'ALLOCATION_ENGINE');
  const manual = await sourceId(supabase, 'MANUAL');
  const { data: template, error: templateError } = await supabase
    .from('domain_templates')
    .select('id')
    .eq('template_code', 'POSITION_STANDARD')
    .maybeSingle();
  if (templateError) throw new Error(templateError.message);

  const { data: relationshipTypes, error: relationshipError } = await supabase
    .from('relationship_types')
    .select('relationship_code, relationship_name')
    .in('relationship_code', ['POSITION_FUND', 'POSITION_SECURITY', 'POSITION_TRANCHE']);
  if (relationshipError) throw new Error(relationshipError.message);
  const relationshipName = new Map((relationshipTypes || []).map((row) => [row.relationship_code, row.relationship_name]));

  const requireDef = (code: string) => {
    const found = defs.get(code);
    if (!found) throw new Error(`${code} is not registered`);
    return found;
  };

  const maybePut = async (
    entityId: string,
    code: string,
    value: string,
    numericValue: number | null,
    booleanValue: boolean | null,
    source: string,
    isManual: boolean,
    reason: string | null,
  ) => {
    if (!defs.has(code)) return;
    await put(entityId, code, value, numericValue, booleanValue, source, isManual, reason);
  };

  const put = async (
    entityId: string,
    code: string,
    value: string,
    numericValue: number | null,
    booleanValue: boolean | null,
    source: string,
    isManual: boolean,
    reason: string | null,
  ) => {
    const def = requireDef(code);
    await writeValue(supabase, {
      entityId,
      attributeId: def.id,
      sourceId: source,
      text: value,
      numeric: numericValue,
      boolean: booleanValue,
      asOf: draft.asOf,
      userId,
      precedence: def.precedence,
      manual: isManual,
      reason,
    });
  };

  if (!options?.proposalsOnly) {
    for (const tranche of preview.tranches) {
      await put(tranche.id, 'TRANCHE_HOLD_PCT', String(tranche.holdPct), tranche.holdPct, null, manual, true, 'Allocation hold');
    }
  }

  const trancheById = new Map(draft.tranches.map((tranche) => [tranche.id, tranche]));
  const existing = new Map(draft.positions.map((position) => [`${position.fundId}|${position.trancheId}|${position.role}`, position]));
  const written = new Set<string>();

  const ensurePosition = async (fundId: string, fundName: string, trancheId: string, role: 'PROPOSAL' | 'LOCK') => {
    const key = `${fundId}|${trancheId}|${role}`;
    const found = existing.get(key);
    if (found) {
      written.add(found.id);
      return found.id;
    }
    const tranche = trancheById.get(trancheId);
    const code = `ALLOC-${slug(tranche?.code || trancheId).slice(0, 28)}-${fundId.replace(/-/g, '').slice(0, 12)}-${role === 'LOCK' ? 'L' : 'P'}`;
    const { data: created, error } = await supabase.from('master_entities').upsert({
      entity_code: code,
      entity_name: `${draft.dealName}: ${fundName}`,
      domain_code: 'POSITION',
      template_id: template?.id ?? null,
      description: role === 'LOCK' ? 'Portfolio allocation lock' : 'Proposed allocation',
      client_id: draft.clientId,
      created_by: userId,
    }, { onConflict: 'entity_code' }).select('id').single();
    if (error || !created) throw new Error(error?.message || 'Could not create the allocation position');
    const links: Array<[string, string]> = [
      ['POSITION_FUND', fundId],
      ['POSITION_TRANCHE', trancheId],
    ];
    if (tranche?.securityId) links.push(['POSITION_SECURITY', tranche.securityId]);
    for (const [relationshipCode, childId] of links) {
      const { error: linkError } = await supabase.from('entity_relationships').insert({
        parent_entity_id: created.id,
        child_entity_id: childId,
        relationship_type: relationshipName.get(relationshipCode) || relationshipCode,
        relationship_code: relationshipCode,
        is_primary: true,
        valid_from: draft.asOf,
      });
      if (linkError && linkError.code !== '23505' && !/duplicate key/.test(linkError.message || '')) throw new Error(linkError.message);
    }
    written.add(created.id);
    return created.id as string;
  };

  const adjustments = draft.request.adjustments || [];
  const adjustmentFor = (fundId: string, trancheId: string) => (
    adjustments.find((item) => item.fundId === fundId && (item.trancheId === trancheId || item.trancheId === '*')) || null
  );

  const parents = new Set(preview.rows.map((row) => row.parentFundId).filter((id): id is string => !!id));
  for (const row of preview.rows) {
    for (const cell of row.cells) {
      const adjustment = adjustmentFor(row.fundId, cell.trancheId);
      // A parent total is the sum of its sleeves. Writing it again would double count
      // once the compliance rule rolls child funds into the parent.
      if (options?.proposalsOnly && parents.has(row.fundId)) continue;
      const role = options?.proposalsOnly ? 'PROPOSAL' : (row.level === 'PORTFOLIO' ? 'LOCK' : 'PROPOSAL');
      if (role === 'LOCK' && !adjustment) continue;
      if (role === 'PROPOSAL' && !cell.eligible && cell.amount === 0 && !adjustment) continue;
      const positionId = await ensurePosition(row.fundId, row.fundName, cell.trancheId, role);
      const amount = cell.amount;
      await maybePut(positionId, 'POSITION_IS_HYPOTHETICAL', 'true', null, true, engine, false, null);
      await maybePut(positionId, 'POSITION_SCENARIO_CODE', draft.dealCode, null, null, engine, false, null);
      await maybePut(positionId, 'POSITION_ALLOCATION_ROLE', role, null, null, engine, false, null);
      await maybePut(positionId, 'POSITION_ALLOCATION_SYSTEM_AMOUNT', String(cell.systemAmount), cell.systemAmount, null, engine, false, null);
      await put(positionId, 'MARKET_VALUE', String(amount), amount, null, engine, false, null);
      const tranche = preview.tranches.find((item) => item.id === cell.trancheId);
      if (tranche?.unfunded) await maybePut(positionId, 'UNFUNDED_COMMITMENT_AMOUNT', String(amount), amount, null, engine, false, null);
      else await maybePut(positionId, 'FUNDED_PAR_AMOUNT', String(amount), amount, null, engine, false, null);
      if (cell.capReason) await maybePut(positionId, 'POSITION_ALLOCATION_CAP', cell.capReason, null, null, engine, false, null);

      if (adjustment) {
        const reason = adjustment.reason || '';
        await put(positionId, 'MARKET_VALUE', String(amount), amount, null, manual, true, reason || 'Allocation adjustment');
        await put(positionId, 'POSITION_ALLOCATION_ADJUSTMENT', adjustment.type === 'exclude' ? 'EXCLUDE' : 'OVERRIDE', null, null, manual, true, reason || null);
        if (reason) await put(positionId, 'POSITION_ALLOCATION_REASON', reason, null, null, manual, true, reason);
        if (adjustment.note) await put(positionId, 'POSITION_ALLOCATION_NOTE', adjustment.note, null, null, manual, true, reason || null);
      } else {
        await closeValue(supabase, positionId, requireDef('POSITION_ALLOCATION_ADJUSTMENT').id, manual, draft.asOf);
        await closeValue(supabase, positionId, requireDef('MARKET_VALUE').id, manual, draft.asOf);
      }
    }
  }

  for (const position of draft.positions) {
    if (written.has(position.id)) continue;
    if (options?.proposalsOnly && position.role === 'LOCK') continue;
    await put(position.id, 'MARKET_VALUE', '0', 0, null, engine, false, null);
  }

  return preview;
}
