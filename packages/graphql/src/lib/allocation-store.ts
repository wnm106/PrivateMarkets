/**
 * Load a deal's tranches and fund tree, run the allocation engine, and write
 * the result through the same attribute ledger as a manual edit.
 *
 * Engine amounts are stored on the Allocation Engine source. A manual override
 * is a second value on the manual source, with the reason in override_reason.
 * The golden-record preference keeps the manual value in front.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { endGoldenValue, OPEN_SYSTEM_TO, writeGoldenValue } from './golden-write';
import {
  allocate,
  type AllocationAdjustment,
  type AllocationCapacityPool,
  type AllocationPortfolio,
  type AllocationRequest,
  type AllocationResult,
  type AllocationSleeve,
  type AllocationTranche,
} from './allocation-engine';
import { solveDealObservations, walkRankedCapacity, type DealObservationRow } from './compliance-capacity';
import { knowledgeInstant } from './fund-surface';


const VALUE_CODES = [
  'TRANCHE_SIZE', 'TRANCHE_HOLD_PCT', 'TRANCHE_IS_UNFUNDED', 'TRANCHE_IS_EQUITY_LINKED', 'TRANCHE_RANK',
  'TRANCHE_PRICING', 'TRANCHE_CALL_PROTECTION', 'TRANCHE_TICKING_FEE_PCT', 'TRANCHE_WARRANT_COVERAGE_PCT',
  'INSTRUMENT_TYPE',
  'NAV', 'FUND_CASH_BALANCE', 'FUND_UNDRAWN_COMMITMENTS', 'FUND_CREDIT_LINE_HEADROOM', 'FUND_PIPELINE_RESERVE',
  'FUND_ALLOWED_INSTRUMENT_TYPES', 'FUND_MANDATE_NOTE', 'FUND_IS_ALLOCATION_ELIGIBLE',
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
  /** Where each fund stands on each rule the deal's securities would worsen. */
  capacities?: CapacityReading[];
}

/**
 * One fund's standing on one compliance rule and group that this deal would
 * worsen, read by the rule evaluator from the fund's book without this deal
 * (other deals' proposals in, the same book the pro forma panel scores). The
 * deal surface shows the current figure, the room and the pro forma figure
 * from this without writing positions.
 */
export interface CapacityReading {
  fundId: string;
  ruleCode: string;
  ruleName: string;
  groupValue: string | null;
  /** What a group of this rule is called, such as Issuer. From the rule, not the code. */
  groupLabel: string | null;
  /** MAX: the figure must stay at or below the limit. MIN: at or above. */
  limitDirection: 'MAX' | 'MIN';
  /** The deal's tranches this rule counts. */
  trancheIds: string[];
  /** The amount this fund can add before the rule's hard limit, in dollars. */
  room: number;
  numerator: number | null;
  denominator: number | null;
  hardLimit: number | null;
  softLimit: number | null;
  resultUnit: string | null;
  /** The new position also enters the denominator (a share of the fund's own book). */
  denominatorGrows: boolean;
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
  capacities: CapacityReading[];
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

/** Whether a row was current knowledge at this instant. No instant means "now": the row is still open. */
function knownAt(row: { system_from?: string | null; system_to?: string | null }, knowledge: string | null | undefined): boolean {
  if (!knowledge) return isOpen(row.system_to);
  const at = Date.parse(knowledge);
  const from = row.system_from ? Date.parse(String(row.system_from)) : Number.NEGATIVE_INFINITY;
  const to = isOpen(row.system_to) ? Number.POSITIVE_INFINITY : Date.parse(String(row.system_to));
  return from <= at && to > at;
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
  knowledgeAt?: string | null,
): Promise<Map<string, ValueRow>> {
  const out = new Map<string, ValueRow>();
  const attributeIds = [...defs.values()].map((def) => def.id);
  if (!entityIds.length || !attributeIds.length) return out;
  const knowledge = knowledgeAt || new Date().toISOString();
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

/** Links of one kind current at a knowledge instant (now when none is given). */
async function openRelationships(
  supabase: SupabaseClient,
  code: string,
  column: 'parent_entity_id' | 'child_entity_id',
  ids: string[],
  knowledge?: string | null,
) {
  if (!ids.length) return [] as Array<{ parent_entity_id: string; child_entity_id: string; system_from: string | null; system_to: string | null }>;
  const { data, error } = await supabase
    .from('entity_relationships')
    .select('parent_entity_id, child_entity_id, system_from, system_to')
    .eq('relationship_code', code)
    .in(column, ids);
  if (error) throw new Error(error.message);
  return (data || []).filter((row) => knownAt(row, knowledge));
}

/**
 * Funds already holding a position on this deal, plus their portfolios.
 * Enough to score the saved book without rebuilding the allocation.
 */
export async function loadDealScoreAnchors(
  supabase: SupabaseClient,
  dealId: string,
  asOfInput: string | null | undefined,
  knowledgeInput?: string | null,
): Promise<{ asOf: string; dealCode: string; clientId: string | null; fundIds: string[]; knowledge: string | null }> {
  const asOf = asOfDate(asOfInput);
  const knowledge = knowledgeInput ? knowledgeInstant(knowledgeInput) : null;
  const { data: deal, error: dealError } = await supabase
    .from('master_entities')
    .select('id, entity_code, client_id')
    .eq('id', dealId)
    .maybeSingle();
  if (dealError) throw new Error(dealError.message);
  if (!deal) throw new Error('Deal not found');
  const trancheRels = await openRelationships(supabase, 'TRANCHE_DEAL', 'child_entity_id', [deal.id], knowledge);
  const trancheIds = trancheRels.map((row) => row.parent_entity_id);
  const positionRels = await openRelationships(supabase, 'POSITION_TRANCHE', 'child_entity_id', trancheIds, knowledge);
  const positionIds = positionRels.map((row) => row.parent_entity_id);
  const fundRels = await openRelationships(supabase, 'POSITION_FUND', 'parent_entity_id', positionIds, knowledge);
  const sleeveIds = [...new Set(fundRels.map((row) => row.child_entity_id))];
  const parentRels = await openRelationships(supabase, 'FUND_PARENT', 'child_entity_id', sleeveIds, knowledge);
  const fundIds = [...new Set([...sleeveIds, ...parentRels.map((row) => row.parent_entity_id)])];
  return { asOf, dealCode: deal.entity_code, clientId: deal.client_id ?? null, fundIds, knowledge };
}

export async function loadAllocationDraft(
  supabase: SupabaseClient,
  dealId: string,
  asOfInput: string | null | undefined,
  holds: AllocationHold[] | null | undefined,
  adjustments: AllocationAdjustment[] | null | undefined,
  knowledgeInput?: string | null,
): Promise<AllocationDraft> {
  const asOf = asOfDate(asOfInput);
  // A knowledge instant reads the deal as it was known then, such as at a
  // certification. None reads current knowledge.
  const knowledge = knowledgeInput ? knowledgeInstant(knowledgeInput) : null;
  let fundQuery = supabase.from('master_entities').select('id, entity_code, entity_name, client_id').eq('domain_code', 'FUND').eq('is_active', true);
  const [dealResult, defs] = await Promise.all([
    supabase
      .from('master_entities')
      .select('id, entity_code, entity_name, client_id, domain_code')
      .eq('id', dealId)
      .maybeSingle(),
    attributeDefs(supabase),
  ]);
  if (dealResult.error) throw new Error(dealResult.error.message);
  const deal = dealResult.data;
  if (!deal) throw new Error('Deal not found');
  if (deal.client_id) fundQuery = fundQuery.eq('client_id', deal.client_id);

  const [trancheRels, issuerRels, sponsorRels, fundResult] = await Promise.all([
    openRelationships(supabase, 'TRANCHE_DEAL', 'child_entity_id', [dealId], knowledge),
    openRelationships(supabase, 'DEAL_ISSUER', 'parent_entity_id', [dealId], knowledge),
    openRelationships(supabase, 'DEAL_SPONSOR', 'parent_entity_id', [dealId], knowledge),
    fundQuery,
  ]);
  if (fundResult.error) throw new Error(fundResult.error.message);
  const trancheIds = trancheRels.map((row) => row.parent_entity_id);
  const funds = fundResult.data || [];
  const fundIds = funds.map((row) => row.id);
  const namedIds = [issuerRels[0]?.child_entity_id, sponsorRels[0]?.child_entity_id].filter((id): id is string => Boolean(id));

  const [trancheResult, securityRels, positionRels, parentRels, namedResult] = await Promise.all([
    trancheIds.length
      ? supabase.from('master_entities').select('id, entity_code, entity_name').in('id', trancheIds)
      : Promise.resolve({ data: [] as Array<{ id: string; entity_code: string; entity_name: string }>, error: null }),
    openRelationships(supabase, 'TRANCHE_SECURITY', 'parent_entity_id', trancheIds, knowledge),
    openRelationships(supabase, 'POSITION_TRANCHE', 'child_entity_id', trancheIds, knowledge),
    openRelationships(supabase, 'FUND_PARENT', 'parent_entity_id', fundIds, knowledge),
    namedIds.length
      ? supabase.from('master_entities').select('id, entity_name').in('id', namedIds)
      : Promise.resolve({ data: [] as Array<{ id: string; entity_name: string }>, error: null }),
  ]);
  if (trancheResult.error) throw new Error(trancheResult.error.message);
  const trancheRows = trancheResult.data || [];
  const securityByTranche = new Map(securityRels.map((row) => [row.parent_entity_id, row.child_entity_id]));
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const rel of parentRels) {
    if (!fundIds.includes(rel.child_entity_id)) continue;
    parentOf.set(rel.child_entity_id, rel.parent_entity_id);
    const list = childrenOf.get(rel.parent_entity_id) || [];
    list.push(rel.child_entity_id);
    childrenOf.set(rel.parent_entity_id, list);
  }
  const positionIds = positionRels.map((row) => row.parent_entity_id);
  const named = new Map((namedResult.data || []).map((row) => [row.id, row.entity_name]));

  const [fundRels, positionResult] = await Promise.all([
    openRelationships(supabase, 'POSITION_FUND', 'parent_entity_id', positionIds, knowledge),
    positionIds.length
      ? supabase.from('master_entities').select('id, entity_code').in('id', positionIds)
      : Promise.resolve({ data: [] as Array<{ id: string; entity_code: string }>, error: null }),
  ]);
  if (positionResult.error) throw new Error(positionResult.error.message);
  const positionRows = positionResult.data || [];
  const fundOfPosition = new Map(fundRels.map((row) => [row.parent_entity_id, row.child_entity_id]));
  const trancheOfPosition = new Map(positionRels.map((row) => [row.parent_entity_id, row.child_entity_id]));

  const entityIds = [
    dealId,
    ...trancheIds,
    ...[...securityByTranche.values()],
    ...fundIds,
    ...positionIds,
  ];
  const values = await valuesFor(supabase, entityIds, defs, asOf, knowledge);
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

  const everyInstrument = [...new Set(tranches.map((tranche) => tranche.instrumentType))];
  const sleeve = (id: string, parentAllowed: string[]): AllocationSleeve | null => {
    const row = funds.find((fund) => fund.id === id);
    if (!row) return null;
    return {
      id,
      name: row.entity_name,
      nav: numeric(read(values, id, def('NAV'))) || 0,
      cash: numeric(read(values, id, def('FUND_CASH_BALANCE'))) || 0,
      undrawn: numeric(read(values, id, def('FUND_UNDRAWN_COMMITMENTS'))) || 0,
      line: numeric(read(values, id, def('FUND_CREDIT_LINE_HEADROOM'))) || 0,
      reserve: numeric(read(values, id, def('FUND_PIPELINE_RESERVE'))) || 0,
      allowed: parentAllowed,
      denyNote: '',
    };
  };

  const allocationEligible = (id: string) => flag(read(values, id, def('FUND_IS_ALLOCATION_ELIGIBLE')));
  const portfolios: AllocationPortfolio[] = [];
  const portfolioIds = new Set<string>();
  for (const fund of funds) {
    if (!allocationEligible(fund.id)) continue;
    const parentId = parentOf.get(fund.id);
    if (parentId && allocationEligible(parentId)) continue;
    // Which instruments a fund may hold is a compliance rule (Permitted instrument
    // types, a 0 limit on the instrument), applied through its capacity. No list
    // on the fund decides it.
    const allowed = everyInstrument;
    const issuerLimit = numeric(read(values, fund.id, def('FUND_SINGLE_ISSUER_LIMIT_PCT')));
    const childIds = (childrenOf.get(fund.id) || []).filter((id) => allocationEligible(id));
    const sleeves = childIds.map((id) => sleeve(id, allowed)).filter((item): item is AllocationSleeve => Boolean(item));
    if (!sleeves.length) {
      const self = sleeve(fund.id, allowed);
      if (self) sleeves.push(self);
    }
    if (!sleeves.length) continue;
    portfolioIds.add(fund.id);
    portfolios.push({
      id: fund.id,
      name: fund.entity_name,
      nav: numeric(read(values, fund.id, def('NAV'))) || sleeves.reduce((total, item) => total + item.nav, 0),
      issuerLimit: issuerLimit == null ? Number.POSITIVE_INFINITY : issuerLimit / 100,
      sponsorLimit: limitFraction(read(values, fund.id, def('FUND_SPONSOR_LIMIT_PCT'))),
      unfundedLimit: limitFraction(read(values, fund.id, def('FUND_UNFUNDED_LIMIT_PCT'))),
      sponsorExposure: 0,
      unfundedExposure: 0,
      allowed,
      denyNote: '',
      sleeves,
    });
  }
  portfolios.sort((left, right) => right.nav - left.nav || left.name.localeCompare(right.name));
  const capacities = await attachComplianceCapacity(
    supabase,
    portfolios,
    loadedTranches,
    new Set(tranches.filter((tranche) => tranche.unfunded).map((tranche) => tranche.id)),
    deal.entity_code,
    asOf,
    knowledge,
  );

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

  // Saved proposals are shown as they were saved. The engine recomputes only when the
  // caller sends its own adjustments, which is what clearing the allocation does.
  const savedAdjustments: AllocationAdjustment[] = [];
  if (!adjustments) {
    const taken = new Set(storedAdjustments.map((item) => `${item.fundId}|${item.trancheId}`));
    const trancheIdSet = new Set(tranches.map((tranche) => tranche.id));
    const saved = new Map<string, number>();
    for (const position of positions) {
      if (position.role === 'LOCK' || !trancheIdSet.has(position.trancheId)) continue;
      const amount = numeric(read(values, position.id, def('MARKET_VALUE')));
      if (amount == null) continue;
      const key = `${position.fundId}|${position.trancheId}`;
      saved.set(key, (saved.get(key) || 0) + amount);
    }
    for (const portfolio of portfolios) {
      for (const tranche of tranches) {
        const sleeveAmounts = portfolio.sleeves.map((item) => saved.get(`${item.id}|${tranche.id}`));
        if (sleeveAmounts.every((amount) => amount === undefined)) continue;
        let total = 0;
        portfolio.sleeves.forEach((item, index) => {
          const amount = sleeveAmounts[index];
          if (amount === undefined) return;
          total += amount;
          if (!taken.has(`${item.id}|${tranche.id}`)) {
            savedAdjustments.push({ fundId: item.id, trancheId: tranche.id, type: 'override', amount, saved: true });
          }
        });
        const parentOnly = portfolio.sleeves.length === 1 && portfolio.sleeves[0].id === portfolio.id;
        if (!parentOnly && !taken.has(`${portfolio.id}|${tranche.id}`)) {
          savedAdjustments.push({ fundId: portfolio.id, trancheId: tranche.id, type: 'override', amount: total, saved: true });
        }
      }
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
      adjustments: adjustments ?? [...storedAdjustments, ...savedAdjustments],
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
    capacities,
  };
}

/** One dollar of each security: small enough that ranks are read as the buy starts. */
const PROBE_PAR = 1;

/**
 * Caps are the compliance rule capacities for each fund and security.
 * compliance.deal_capacity_observations runs the rule evaluator on each fund's
 * book without this deal and with a probe of each security; the room is solved
 * here from those results by compliance-capacity.ts, the same algebra
 * investmentCapacity uses. Nothing here decides which rules apply, which
 * positions count, or which group a security lands in.
 */
async function attachComplianceCapacity(
  supabase: SupabaseClient,
  portfolios: AllocationPortfolio[],
  tranches: LoadedTranche[],
  unfundedTranches: ReadonlySet<string>,
  dealCode: string,
  asOf: string,
  knowledgeAt?: string | null,
): Promise<CapacityReading[]> {
  const fundIds = [
    ...portfolios.map((portfolio) => portfolio.id),
    ...portfolios.flatMap((portfolio) => portfolio.sleeves.map((sleeve) => sleeve.id)),
  ];
  const tranchesForSecurity = new Map<string, string[]>();
  for (const tranche of tranches) {
    if (!tranche.securityId) continue;
    const list = tranchesForSecurity.get(tranche.securityId) || [];
    list.push(tranche.id);
    tranchesForSecurity.set(tranche.securityId, list);
  }
  const legFor = (securityId: string, par: number) => {
    const trancheIds = tranchesForSecurity.get(securityId) || [];
    return {
      security_id: securityId,
      tranche_id: trancheIds[0] || null,
      par,
      unfunded: trancheIds.length > 0 && trancheIds.every((id) => unfundedTranches.has(id)),
    };
  };
  const empty = () => {
    for (const portfolio of portfolios) {
      portfolio.capacityPools = [];
      for (const sleeve of portfolio.sleeves) sleeve.capacityPools = [];
    }
  };
  const securityIds = [...tranchesForSecurity.keys()];
  if (!fundIds.length || !securityIds.length) {
    empty();
    return [];
  }
  const knowledge = knowledgeAt || new Date().toISOString();
  const observe = async (funds: string[], legs: ReturnType<typeof legFor>[], ruleCodes: string[] | null, allGroups: boolean) => {
    const { data, error } = await supabase.schema('compliance').rpc('deal_capacity_observations', {
      p_fund_ids: funds,
      p_legs: legs,
      p_as_of_date: asOf,
      p_knowledge_date: knowledge,
      p_deal_code: dealCode,
      p_rule_codes: ruleCodes,
      p_all_groups: allGroups,
    });
    if (error) throw new Error(error.message);
    return (data || []) as DealObservationRow[];
  };

  const rows = await observe(fundIds, securityIds.map((id) => legFor(id, PROBE_PAR)), null, false);
  const { lines, errors } = solveDealObservations(rows);
  if (errors.length) throw new Error(`Compliance capacity could not be read. ${errors.join(' ')}`);

  // A rank band can move the limit, or another group's limit, as the buy grows.
  for (const line of lines) {
    if (!line.rankSensitive || line.capacity == null || line.capacity <= 0) continue;
    line.capacity = await walkRankedCapacity(line, (par) => observe([line.fundId], [legFor(line.securityId, par)], [line.ruleCode], true));
  }

  const groupOf = (value: string | null) => (value && value !== '__ALL__' && value !== '__UNASSIGNED__' ? value : null);
  // One reading per fund, rule and group. Securities in one group share its room.
  const readings = new Map<string, CapacityReading>();
  for (const line of lines) {
    if (line.capacity == null || !Number.isFinite(line.capacity)) continue;
    const trancheIds = tranchesForSecurity.get(line.securityId) || [];
    if (!trancheIds.length) continue;
    const key = `${line.fundId}|${line.ruleCode}|${line.groupValue ?? ''}`;
    const existing = readings.get(key);
    if (existing) {
      existing.room = Math.min(existing.room, line.capacity);
      existing.denominatorGrows = existing.denominatorGrows || line.denominatorSlope > 0;
      for (const trancheId of trancheIds) if (!existing.trancheIds.includes(trancheId)) existing.trancheIds.push(trancheId);
      continue;
    }
    readings.set(key, {
      fundId: line.fundId,
      ruleCode: line.ruleCode,
      ruleName: line.ruleName,
      groupValue: groupOf(line.groupValue),
      groupLabel: line.groupLabel,
      limitDirection: line.direction,
      trancheIds: [...trancheIds],
      room: Math.max(0, line.capacity),
      numerator: line.baseNumerator,
      denominator: line.baseDenominator,
      hardLimit: line.hardLimit,
      softLimit: line.softLimit,
      resultUnit: line.resultUnit,
      denominatorGrows: line.denominatorSlope > 0,
    });
  }

  const poolsFor = (fundId: string): AllocationCapacityPool[] => [...readings.values()]
    .filter((reading) => reading.fundId === fundId)
    .map((reading) => ({
      trancheIds: [...reading.trancheIds],
      capacity: reading.room,
      ruleName: reading.ruleName,
      hardLimit: reading.hardLimit,
      groupValue: reading.groupValue,
    }));
  for (const portfolio of portfolios) {
    portfolio.capacityPools = poolsFor(portfolio.id);
    for (const sleeve of portfolio.sleeves) sleeve.capacityPools = poolsFor(sleeve.id);
  }
  return [...readings.values()];
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
    capacities: draft.capacities || [],
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

interface WriteInput {
  entityId: string;
  attributeId: string;
  sourceId: string;
  text: string;
  numeric: number | null;
  boolean: boolean | null;
  asOf: string;
  /** Kept for the caller. write_value takes the writer from the session. */
  userId?: string | null;
  precedence: number;
  manual: boolean;
  reason: string | null;
}

interface OpenValue {
  entity_id: string;
  attribute_id: string;
  source_id: string;
  golden_value: string | null;
  golden_value_numeric: number | string | null;
  golden_value_boolean: boolean | null;
  valid_from: string | null;
  valid_to: string | null;
  is_manual_override: boolean | null;
  override_reason: string | null;
}

function ledgerKey(entityId: string, attributeId: string, sourceId: string): string {
  return `${entityId}|${attributeId}|${sourceId}`;
}

function sameNumber(left: number | string | null | undefined, right: number | null): boolean {
  if (left == null || left === '') return right == null;
  if (right == null) return false;
  return Math.abs(Number(left) - right) < 1e-6;
}

/**
 * The open values of the allocation positions, read once. A write that would
 * store the value already there is skipped, and a close with nothing open is
 * not sent. Scoring an unchanged allocation then writes nothing.
 */
class PositionLedger {
  private open = new Map<string, OpenValue[]>();
  private known = new Set<string>();

  constructor(private supabase: SupabaseClient) {}

  async preload(entityIds: string[], sourceIds: string[]) {
    const ids = [...new Set(entityIds)];
    for (let index = 0; index < ids.length; index += 100) {
      const slice = ids.slice(index, index + 100);
      const { data, error } = await this.supabase
        .from('entity_attribute_values')
        .select('entity_id, attribute_id, source_id, golden_value, golden_value_numeric, golden_value_boolean, valid_from, valid_to, is_manual_override, override_reason')
        .in('entity_id', slice)
        .in('source_id', sourceIds)
        .eq('system_to', OPEN_SYSTEM_TO);
      if (error) throw new Error(error.message);
      for (const id of slice) this.known.add(id);
      for (const row of (data || []) as OpenValue[]) {
        const key = ledgerKey(row.entity_id, row.attribute_id, row.source_id);
        const list = this.open.get(key) || [];
        list.push(row);
        this.open.set(key, list);
      }
    }
  }

  private unchanged(input: WriteInput): boolean {
    if (!this.known.has(input.entityId)) return false;
    const rows = this.open.get(ledgerKey(input.entityId, input.attributeId, input.sourceId)) || [];
    if (rows.length !== 1) return false;
    const row = rows[0];
    const from = (row.valid_from || '').slice(0, 10);
    const to = (row.valid_to || '').slice(0, 10);
    return (row.golden_value ?? '') === input.text
      && sameNumber(row.golden_value_numeric, input.numeric)
      && (row.golden_value_boolean ?? null) === input.boolean
      && Boolean(row.is_manual_override) === input.manual
      && (row.override_reason || null) === (input.reason || null)
      && Boolean(from) && from <= input.asOf
      && (!to || to > input.asOf);
  }

  async write(input: WriteInput) {
    if (this.unchanged(input)) return;
    await writeValue(this.supabase, input);
    if (this.known.has(input.entityId)) {
      this.open.set(ledgerKey(input.entityId, input.attributeId, input.sourceId), [{
        entity_id: input.entityId,
        attribute_id: input.attributeId,
        source_id: input.sourceId,
        golden_value: input.text,
        golden_value_numeric: input.numeric,
        golden_value_boolean: input.boolean,
        valid_from: input.asOf,
        valid_to: null,
        is_manual_override: input.manual,
        override_reason: input.reason,
      }]);
    }
  }

  async close(entityId: string, attributeId: string, sourceId: string, asOf: string) {
    const key = ledgerKey(entityId, attributeId, sourceId);
    if (this.known.has(entityId) && !(this.open.get(key) || []).length) return;
    await closeValue(this.supabase, entityId, attributeId, sourceId, asOf);
    if (this.known.has(entityId)) this.open.delete(key);
  }

  knows(entityId: string): boolean {
    return this.known.has(entityId);
  }
}

/** Runs the tasks with at most `limit` in flight, and rejects on the first failure. */
async function inParallel<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

/**
 * One source's value from the as-of date until that source's next later value,
 * through golden_master.write_value: earlier dates and earlier knowledge dates
 * keep their values. Who wrote it comes from the session.
 */
async function writeValue(supabase: SupabaseClient, input: WriteInput) {
  await writeGoldenValue(supabase, {
    entityId: input.entityId,
    attributeId: input.attributeId,
    sourceId: input.sourceId,
    validFrom: input.asOf,
    value: {
      golden_value: input.text,
      golden_value_numeric: input.numeric,
      golden_value_boolean: input.boolean,
      precedence_rank: input.precedence,
      is_manual_override: input.manual,
      override_reason: input.reason,
    },
  });
}

/** This source has no value from the as-of date on. Its value before that date stays. */
async function closeValue(
  supabase: SupabaseClient,
  entityId: string,
  attributeId: string,
  sourceId: string,
  asOf: string,
) {
  await endGoldenValue(supabase, { entityId, attributeId, sourceId, from: asOf });
}

interface PositionScaffold {
  templateId: string | null;
  relationshipName: Map<string, string>;
}

async function positionScaffold(supabase: SupabaseClient): Promise<PositionScaffold> {
  const [templateRead, relationshipRead] = await Promise.all([
    supabase.from('domain_templates').select('id').eq('template_code', 'POSITION_STANDARD').maybeSingle(),
    supabase
      .from('relationship_types')
      .select('relationship_code, relationship_name')
      .in('relationship_code', ['POSITION_FUND', 'POSITION_SECURITY', 'POSITION_TRANCHE']),
  ]);
  if (templateRead.error) throw new Error(templateRead.error.message);
  if (relationshipRead.error) throw new Error(relationshipRead.error.message);
  return {
    templateId: templateRead.data?.id ?? null,
    relationshipName: new Map((relationshipRead.data || []).map((row) => [row.relationship_code, row.relationship_name])),
  };
}

/** The code of the position for one fund and tranche: a proposal, a lock, or a Hypo run's position. */
function allocationPositionCode(draft: AllocationDraft, fundId: string, trancheId: string, kind: 'PROPOSAL' | 'LOCK' | 'HYPO'): string {
  const tranche = draft.tranches.find((item) => item.id === trancheId);
  const suffix = kind === 'HYPO' ? 'H' : kind === 'LOCK' ? 'L' : 'P';
  return `ALLOC-${slug(tranche?.code || trancheId).slice(0, 28)}-${fundId.replace(/-/g, '').slice(0, 12)}-${suffix}`;
}

/** Creates the position for one fund and tranche, linked to both and to the tranche's security. */
async function createPosition(
  supabase: SupabaseClient,
  draft: AllocationDraft,
  scaffold: PositionScaffold,
  userId: string | null,
  fundId: string,
  fundName: string,
  trancheId: string,
  role: 'PROPOSAL' | 'LOCK',
  hypo = false,
): Promise<string> {
  const tranche = draft.tranches.find((item) => item.id === trancheId);
  const code = allocationPositionCode(draft, fundId, trancheId, hypo ? 'HYPO' : role);
  // The upsert matches on the code alone, and scoring writes with the service role.
  // A code that already names another client's record is refused, not taken over.
  const { data: taken, error: takenError } = await supabase
    .from('master_entities')
    .select('id, client_id')
    .eq('entity_code', code)
    .maybeSingle();
  if (takenError) throw new Error(takenError.message);
  if (taken && (taken.client_id ?? null) !== draft.clientId) {
    throw new Error('An allocation position code on this deal is already used by another record.');
  }
  const { data: created, error } = await supabase.from('master_entities').upsert({
    entity_code: code,
    entity_name: `${draft.dealName}: ${fundName}`,
    domain_code: 'POSITION',
    template_id: scaffold.templateId,
    description: hypo ? 'Hypo allocation for a compliance test' : role === 'LOCK' ? 'Portfolio allocation lock' : 'Proposed allocation',
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
      relationship_type: scaffold.relationshipName.get(relationshipCode) || relationshipCode,
      relationship_code: relationshipCode,
      is_primary: true,
      valid_from: draft.asOf,
    });
    if (linkError && linkError.code !== '23505' && !/duplicate key/.test(linkError.message || '')) throw new Error(linkError.message);
  }
  return created.id as string;
}

/**
 * Saves the allocation: the holds, a proposal per sleeve and tranche, a lock where a
 * portfolio total is adjusted, and the manual adjustments.
 *
 * With a scenarioCode it writes a Hypo run instead: the sleeve amounts as positions
 * of their own under that code. The saved allocation is not touched: its positions
 * carry the deal code, and these carry the Hypo code, so neither reads the other.
 */
export async function commitAllocation(
  supabase: SupabaseClient,
  draft: AllocationDraft,
  userId: string | null,
  options?: { scenarioCode?: string },
): Promise<AllocationPreview> {
  const preview = previewFromDraft(draft);
  const hypo = options?.scenarioCode || null;
  const [defs, engine, manual, scaffold] = await Promise.all([
    attributeDefs(supabase),
    sourceId(supabase, 'ALLOCATION_ENGINE'),
    sourceId(supabase, 'MANUAL'),
    positionScaffold(supabase),
  ]);
  const parents = new Set(preview.rows.map((row) => row.parentFundId).filter((id): id is string => !!id));

  // A Hypo run keeps one position per sleeve and tranche, found by its code.
  const existing = new Map<string, string>();
  if (hypo) {
    const codes = new Map<string, string>();
    for (const row of preview.rows) {
      if (parents.has(row.fundId)) continue;
      for (const cell of row.cells) codes.set(allocationPositionCode(draft, row.fundId, cell.trancheId, 'HYPO'), `${row.fundId}|${cell.trancheId}|PROPOSAL`);
    }
    const list = [...codes.keys()];
    for (let index = 0; index < list.length; index += 100) {
      let query = supabase
        .from('master_entities')
        .select('id, entity_code')
        .in('entity_code', list.slice(index, index + 100));
      // A Hypo run writes with the service role: only this deal's client's positions count.
      query = draft.clientId ? query.eq('client_id', draft.clientId) : query.is('client_id', null);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      for (const row of data || []) existing.set(codes.get(row.entity_code)!, row.id);
    }
  } else {
    for (const position of draft.positions) existing.set(`${position.fundId}|${position.trancheId}|${position.role}`, position.id);
  }

  const ledger = new PositionLedger(supabase);
  await ledger.preload([...existing.values()], [engine, manual]);

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
    await ledger.write({
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

  if (!hypo) {
    for (const tranche of preview.tranches) {
      await put(tranche.id, 'TRANCHE_HOLD_PCT', String(tranche.holdPct), tranche.holdPct, null, manual, true, 'Allocation hold');
    }
  }

  const written = new Set<string>();

  const ensurePosition = async (fundId: string, fundName: string, trancheId: string, role: 'PROPOSAL' | 'LOCK') => {
    const key = `${fundId}|${trancheId}|${role}`;
    const found = existing.get(key);
    if (found) {
      written.add(found);
      return found;
    }
    const createdId = await createPosition(supabase, draft, scaffold, userId, fundId, fundName, trancheId, role, Boolean(hypo));
    written.add(createdId);
    existing.set(key, createdId);
    // An upsert on an existing code returns a position that may hold values, so only a
    // position this draft did not know is read as empty.
    if (!ledger.knows(createdId)) await ledger.preload([createdId], [engine, manual]);
    return createdId;
  };

  // Saved amounts are re-written as the proposal, not stamped as manual overrides.
  // A Hypo position holds the final amount on the engine source alone.
  const adjustments = hypo ? [] : (draft.request.adjustments || []).filter((item) => !item.saved);
  const adjustmentFor = (fundId: string, trancheId: string) => (
    adjustments.find((item) => item.fundId === fundId && (item.trancheId === trancheId || item.trancheId === '*')) || null
  );

  const cells = preview.rows.flatMap((row) => row.cells.map((cell) => ({ row, cell })));
  // Each cell writes its own position, so cells run side by side. Writes inside one
  // position stay in order, because the manual value must follow the engine value.
  await inParallel(cells, 8, async ({ row, cell }) => {
    const adjustment = adjustmentFor(row.fundId, cell.trancheId);
    let role: 'PROPOSAL' | 'LOCK';
    if (hypo) {
      // A Hypo run tests the sleeves. A parent total would count them twice.
      // Its positions are written even at zero, so an earlier run's amount does not linger.
      if (parents.has(row.fundId)) return;
      role = 'PROPOSAL';
    } else {
      // A parent total is the sum of its sleeves. It is stored as a lock, which compliance
      // leaves out, so the parent is not counted twice. A portfolio with no sleeves holds
      // its own proposal.
      role = parents.has(row.fundId) ? 'LOCK' : 'PROPOSAL';
      if (role === 'LOCK' && !adjustment) return;
      if (role === 'PROPOSAL' && !cell.eligible && cell.amount === 0 && !adjustment) return;
    }
    const positionId = await ensurePosition(row.fundId, row.fundName, cell.trancheId, role);
    const amount = cell.amount;
    await maybePut(positionId, 'POSITION_IS_HYPOTHETICAL', 'true', null, true, engine, false, null);
    await maybePut(positionId, 'POSITION_SCENARIO_CODE', hypo || draft.dealCode, null, null, engine, false, null);
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
      await ledger.close(positionId, requireDef('POSITION_ALLOCATION_ADJUSTMENT').id, manual, draft.asOf);
      await ledger.close(positionId, requireDef('MARKET_VALUE').id, manual, draft.asOf);
    }
  });

  // A saved position this allocation no longer fills drops to zero. A Hypo run leaves them be.
  const stale = hypo ? [] : draft.positions.filter((position) => !written.has(position.id));
  await inParallel(stale, 8, async (position) => {
    await put(position.id, 'MARKET_VALUE', '0', 0, null, engine, false, null);
  });

  return preview;
}

/**
 * Refuses holds and adjustments that name a tranche or fund this deal does not have.
 * The draft is loaded with the caller's own access, so an id from another deal or
 * another client is never in it.
 */
export function assertAllocationInputsOnDeal(
  draft: AllocationDraft,
  holds: AllocationHold[] | null | undefined,
  adjustments: AllocationAdjustment[] | null | undefined,
): void {
  const trancheIds = new Set(draft.tranches.map((tranche) => tranche.id));
  const fundIds = new Set<string>(draft.positions.map((position) => position.fundId));
  for (const portfolio of draft.request.portfolios) {
    fundIds.add(portfolio.id);
    for (const sleeve of portfolio.sleeves) fundIds.add(sleeve.id);
  }
  for (const hold of holds || []) {
    if (!trancheIds.has(hold.trancheId)) throw new Error('A hold names a tranche that is not on this deal.');
  }
  for (const item of adjustments || []) {
    if (!fundIds.has(item.fundId)) throw new Error('An adjustment names a fund that is not on this deal.');
    if (item.trancheId !== '*' && !trancheIds.has(item.trancheId)) {
      throw new Error('An adjustment names a tranche that is not on this deal.');
    }
  }
}

export interface StagedWhatIf {
  preview: AllocationPreview;
  /** Score at this knowledge date. The what-if amounts are readable at this instant and no other. */
  knowledgeDate: string;
}

interface VisibleAmount {
  value: number | null;
  precedence: number;
  validFrom: string;
  systemFrom: string;
}

function sameAmount(left: number | null, right: number): boolean {
  return left != null && Math.abs(left - right) < 0.005;
}

/** A knowledge instant after `floor`, with microseconds so two requests do not share one. */
function whatIfInstant(floor: number): string {
  const micros = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `${new Date(floor + 1).toISOString().slice(0, -1)}${micros}Z`;
}

/** The latest system time on rows written for these positions. The database clock set it. */
async function latestSystemFrom(supabase: SupabaseClient, entityIds: string[]): Promise<number> {
  let latest = 0;
  for (let index = 0; index < entityIds.length; index += 150) {
    const slice = entityIds.slice(index, index + 150);
    const [links, values] = await Promise.all([
      supabase.from('entity_relationships').select('system_from').in('parent_entity_id', slice).order('system_from', { ascending: false }).limit(1),
      supabase.from('entity_attribute_values').select('system_from').in('entity_id', slice).order('system_from', { ascending: false }).limit(1),
    ]);
    if (links.error) throw new Error(links.error.message);
    if (values.error) throw new Error(values.error.message);
    for (const row of [...(links.data || []), ...(values.data || [])]) {
      const at = Date.parse(row.system_from);
      if (Number.isFinite(at) && at > latest) latest = at;
    }
  }
  return latest;
}

/** What a rule reads for each position, attribute and source at this as-of and knowledge date. */
async function visibleAmounts(
  supabase: SupabaseClient,
  entityIds: string[],
  attributeIds: string[],
  asOf: string,
  knowledge: string,
): Promise<Map<string, Map<string, VisibleAmount>>> {
  const out = new Map<string, Map<string, VisibleAmount>>();
  if (!attributeIds.length) return out;
  const pageSize = 1000;
  for (let index = 0; index < entityIds.length; index += 100) {
    const slice = entityIds.slice(index, index + 100);
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('entity_attribute_values')
        .select('id, entity_id, attribute_id, source_id, golden_value, golden_value_numeric, precedence_rank, valid_from, system_from')
        .in('entity_id', slice)
        .in('attribute_id', attributeIds)
        .lte('valid_from', asOf)
        .gte('valid_to', asOf)
        .lte('system_from', knowledge)
        .gte('system_to', knowledge)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      for (const row of data || []) {
        const key = `${row.entity_id}|${row.attribute_id}`;
        const bySource = out.get(key) || new Map<string, VisibleAmount>();
        const current = bySource.get(row.source_id);
        const validFrom = String(row.valid_from);
        const systemFrom = String(row.system_from);
        // The same order the golden record read uses within one source.
        if (!current || validFrom > current.validFrom || (validFrom === current.validFrom && Date.parse(systemFrom) > Date.parse(current.systemFrom))) {
          bySource.set(row.source_id, {
            value: numeric(row as unknown as ValueRow),
            precedence: row.precedence_rank,
            validFrom,
            systemFrom,
          });
        }
        out.set(key, bySource);
      }
      if (!data || data.length < pageSize) break;
    }
  }
  return out;
}

/**
 * Puts a what-if allocation where the compliance rules can read it, without
 * changing the saved allocation.
 *
 * The rules run in Postgres and read position amounts from the attribute ledger
 * at an as-of date and a knowledge date. Each amount the what-if changes is
 * added as a ledger row whose system time starts and ends at one instant, and
 * whose valid time starts and ends on the as-of date. The rules are then run at
 * that instant. A read at any other knowledge date, including now, never sees
 * the row, and neither does a read of current rows (valid_to or system_to still
 * open): to those readers it looks like superseded history. No saved row is
 * updated or closed, so the committed amounts and manual overrides are exactly
 * as the last save left them, even when two scores overlap or a request dies
 * part way. The rows are kept, so a result's contributors can be read again at
 * the run's knowledge date.
 *
 * A cell with no position yet gets one, flagged as a hypothetical proposal for
 * this deal and holding no amount. Amounts are stored only by commitAllocation.
 */
export async function stageAllocationWhatIf(
  supabase: SupabaseClient,
  draft: AllocationDraft,
  userId: string | null,
): Promise<StagedWhatIf> {
  // A what-if row ends on the as-of date. On the open end date it would read as current.
  if (draft.asOf >= '9999-12-31') throw new Error('Choose an as-of date before 9999-12-31 to score a what-if.');
  const preview = previewFromDraft(draft);
  const defs = await attributeDefs(supabase);
  const engine = await sourceId(supabase, 'ALLOCATION_ENGINE');
  const marketValue = defs.get('MARKET_VALUE');
  if (!marketValue) throw new Error('MARKET_VALUE is not registered');

  const adjustments = (draft.request.adjustments || []).filter((item) => !item.saved);
  const adjusted = (fundId: string, trancheId: string) => (
    adjustments.some((item) => item.fundId === fundId && (item.trancheId === trancheId || item.trancheId === '*'))
  );
  const proposals = new Map<string, LoadedPosition>();
  for (const position of draft.positions) {
    const key = `${position.fundId}|${position.trancheId}`;
    if (position.role === 'PROPOSAL' && !proposals.has(key)) proposals.set(key, position);
  }

  // Position id to the amount the what-if gives it, and the tranche it sits on.
  const wanted = new Map<string, { amount: number; trancheId: string }>();
  const created: string[] = [];
  let scaffold: PositionScaffold | null = null;
  const parents = new Set(preview.rows.map((row) => row.parentFundId).filter((id): id is string => !!id));
  for (const row of preview.rows) {
    // A parent total is the sum of its sleeves. Counting it as well would double
    // count once a rule rolls child funds into the parent.
    if (parents.has(row.fundId)) continue;
    for (const cell of row.cells) {
      if (!cell.eligible && cell.amount === 0 && !adjusted(row.fundId, cell.trancheId)) continue;
      let positionId = proposals.get(`${row.fundId}|${cell.trancheId}`)?.id;
      if (!positionId) {
        scaffold = scaffold || await positionScaffold(supabase);
        positionId = await createPosition(supabase, draft, scaffold, userId, row.fundId, row.fundName, cell.trancheId, 'PROPOSAL');
        const identity: Array<[string, string, boolean | null]> = [
          ['POSITION_IS_HYPOTHETICAL', 'true', true],
          ['POSITION_SCENARIO_CODE', draft.dealCode, null],
          ['POSITION_ALLOCATION_ROLE', 'PROPOSAL', null],
        ];
        for (const [code, value, flagValue] of identity) {
          const def = defs.get(code);
          if (!def) continue;
          await writeValue(supabase, {
            entityId: positionId,
            attributeId: def.id,
            sourceId: engine,
            text: value,
            numeric: null,
            boolean: flagValue,
            asOf: draft.asOf,
            precedence: def.precedence,
            manual: false,
            reason: null,
          });
        }
        created.push(positionId);
      }
      wanted.set(positionId, { amount: cell.amount, trancheId: cell.trancheId });
    }
  }
  // A saved position the what-if leaves out counts as nothing in this score.
  for (const position of draft.positions) {
    if (position.role === 'LOCK' || wanted.has(position.id)) continue;
    wanted.set(position.id, { amount: 0, trancheId: position.trancheId });
  }

  // Rows for these positions, new ones above all, carry the database clock. The
  // instant must not be before any of them, even when this server's clock is behind.
  const floor = Math.max(Date.now(), await latestSystemFrom(supabase, [...wanted.keys()]));
  const knowledgeDate = whatIfInstant(floor);

  const unfunded = new Map(preview.tranches.map((tranche) => [tranche.id, tranche.unfunded]));
  const amountCodes = ['MARKET_VALUE', 'FUNDED_PAR_AMOUNT', 'UNFUNDED_COMMITMENT_AMOUNT'];
  const amountDefs = amountCodes.map((code) => defs.get(code)).filter((def): def is AttributeDef => Boolean(def));
  const visible = await visibleAmounts(supabase, [...wanted.keys()], amountDefs.map((def) => def.id), draft.asOf, knowledgeDate);

  const rows: Array<Record<string, unknown>> = [];
  for (const [positionId, target] of wanted) {
    const codes = ['MARKET_VALUE', unfunded.get(target.trancheId) ? 'UNFUNDED_COMMITMENT_AMOUNT' : 'FUNDED_PAR_AMOUNT'];
    for (const code of codes) {
      const def = defs.get(code);
      if (!def) continue;
      const stored = visible.get(`${positionId}|${def.id}`);
      // Every source that holds the amount is covered, so the winning source reads the what-if.
      const sources: Array<[string, VisibleAmount | null]> = stored?.size ? [...stored.entries()] : [[engine, null]];
      for (const [source, current] of sources) {
        if (current ? sameAmount(current.value, target.amount) : target.amount === 0) continue;
        rows.push({
          entity_id: positionId,
          attribute_id: def.id,
          source_id: source,
          golden_value: String(target.amount),
          golden_value_numeric: target.amount,
          valid_from: draft.asOf,
          valid_to: draft.asOf,
          system_from: knowledgeDate,
          system_to: knowledgeDate,
          precedence_rank: current?.precedence ?? def.precedence,
          is_manual_override: false,
          created_by: userId,
          metadata: { allocationWhatIf: draft.dealCode },
        });
      }
    }
  }
  for (let index = 0; index < rows.length; index += 500) {
    const { error } = await supabase.from('entity_attribute_values').insert(rows.slice(index, index + 500));
    if (error) throw new Error(error.message);
  }

  return { preview, knowledgeDate };
}
