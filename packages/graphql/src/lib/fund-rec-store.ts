/**
 * Read the entities a fund close needs and hand them to the reconciliation engine.
 * One fund and one period at a time, or every fund on the close board.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asOfDate, flag, knowledgeInstant, links, loadEntities, numeric, read, text, valuesFor,
  type Def, type ValueRow,
} from './fund-surface';
import {
  buildReview, cashflowBucket, periodEndOnOrBefore, priorPeriodEnd,
  type CapitalModel, type FlowBucket, type Frequency, type MgmtFeeBasis, type PerfFeeBasis, type RecBind, type RecDisposition, type RecInput,
  type RecLine, type RecPosition, type RecReview, type RecRoll, type RecSourceCheck, type StepState,
} from './fund-rec';
import {
  FUND_ADMIN_SOURCE, INTERNAL_SOURCE, loadNavLineAttributes, readSourceAmounts, sourceAmount, sourceText,
  type SourceValue,
} from './nav-statement-lines';
import { certificationAt } from './certification-store';

/** The certification process a NAV close is certified under (golden_master.certification_processes). */
export const CLOSE_PROCESS = 'FUND_CLOSE';

/** The prior period's certification a close compares against: the one in force at the close's knowledge instant. */
export interface PriorCertification {
  id: string;
  version: number;
  periodEnd: string | null;
  knowledgeAt: string;
  certifiedAt: string;
}
import { loadNavPack } from './nav-pack-store';
import { cashStanding, type CashRec } from './cash-rec';
import { loadCashRec } from './cash-rec-store';

/** The drift threshold when the fund sets none. */
export const DEFAULT_DRIFT_THRESHOLD_PCT = 10;

export interface FundRecLoadOptions {
  /**
   * The cash reconciliation of the same fund, period and dates, when the caller
   * is reading it anyway. Otherwise the close reads it itself.
   */
  cashRec?: Promise<CashRec>;
}
import type { PackActivity, PackHolding } from './nav-pack';

const CODES = [
  'FUND_STRATEGY', 'FUND_TOTAL_COMMITMENTS', 'FUND_NET_IRR', 'FUND_CLOSE_FREQUENCY', 'FUND_CLOSE_LAG_DAYS', 'FUND_DRIFT_THRESHOLD_PCT',
  'FUND_MGMT_FEE_RATE_PCT', 'FUND_PREF_RETURN_PCT', 'FUND_CARRY_PCT', 'FUND_CATCH_UP_PCT',
  'FUND_CAPITAL_MODEL', 'FUND_MGMT_FEE_BASIS', 'FUND_PERF_FEE_BASIS',
  'FUND_MGMT_FEE_STEPDOWN_DATE', 'FUND_MGMT_FEE_STEPDOWN_RATE_PCT', 'FUND_MGMT_FEE_STEPDOWN_BASIS',
  'STATEMENT_PERIOD_END', 'STATEMENT_PERIOD_LABEL', 'STATEMENT_TOLERANCE_PCT', 'STATEMENT_CERTIFIED', 'STATEMENT_RECEIVED_DATE',
  'STATEMENT_COMPARATIVE_DATE', 'STATEMENT_SOURCE_CHECKS',
  'POSITION_STRATEGY', 'MARKET_VALUE', 'METRIC_DATE', 'ACCRUED_CASH_INTEREST_AMOUNT', 'UNREALIZED_GAIN_LOSS', 'POSITION_MARK', 'POSITION_AGENT_MARK',
  'ACTIVITY_DATE', 'ACTIVITY_KIND', 'ACTIVITY_AMOUNT', 'ACTIVITY_STATUS', 'ACTIVITY_OUTSTANDING',
  'POSITION_CURRENCY', 'COST_BASIS',
  'EVIDENCE_KIND', 'EVIDENCE_DATE', 'EVIDENCE_AMOUNT',
  'CLOSE_PERIOD_END', 'CLOSE_SIGNOFF', 'CLOSE_CERTIFIED_AT', 'CLOSE_CERTIFIED_BY', 'CLOSE_CERTIFIED_NAV',
  'CLOSE_REC_NOTES', 'CLOSE_REC_OUTCOME',
  'DISPOSITION_ITEM', 'DISPOSITION_DECISION', 'DISPOSITION_NOTE',
  'CASHFLOW_DATE', 'CASHFLOW_TYPE', 'AMOUNT',
  'ROLL_PURCHASES', 'ROLL_REPAYMENTS', 'ROLL_SALES', 'ROLL_PIK', 'ROLL_AMORTIZATION',
  'ROLL_UNREALIZED_CHANGE', 'ROLL_REALIZED_GAIN', 'ROLL_END_FV',
  'ROLL_INTEREST_EARNED', 'ROLL_FEE_INCOME', 'ROLL_END_ACCRUED', 'ROLL_OUR_ACCRUED',
] as const;

const POSITION_STRATEGY: Record<string, string> = {
  SENIOR_SECURED: 'Senior secured', UNITRANCHE: 'Unitranche', MEZZANINE: 'Mezzanine', ASSET_BASED: 'Asset-based',
};
const FUND_STRATEGY: Record<string, string> = {
  DIRECT_LENDING: 'Direct lending', OPPORTUNISTIC_CREDIT: 'Opportunistic credit',
  ASSET_BASED_FINANCE: 'Asset-based finance', SPECIAL_SITUATIONS: 'Special situations',
};
const SIGNOFF: Record<string, StepState> = {
  NOT_STARTED: 'Not started', IN_PROGRESS: 'In progress', BLOCKED: 'Blocked', DONE: 'Done',
};

class Facts {
  private values = new Map<string, ValueRow>();
  constructor(
    private supabase: SupabaseClient,
    private defs: Map<string, Def>,
    private asOf: string,
    private knowledge: string,
  ) {}

  static async open(supabase: SupabaseClient, asOf: string, knowledge: string): Promise<Facts> {
    const { data, error } = await supabase.from('attribute_register').select('id, attribute_code').in('attribute_code', [...CODES]);
    if (error) throw new Error(error.message);
    const defs = new Map<string, Def>();
    for (const row of data || []) defs.set(row.attribute_code, { id: row.id, code: row.attribute_code });
    return new Facts(supabase, defs, asOf, knowledge);
  }

  async load(ids: string[]): Promise<void> {
    const fresh = [...new Set(ids)];
    if (!fresh.length) return;
    const loaded = await valuesFor(this.supabase, fresh, this.defs, this.asOf, this.knowledge);
    for (const [key, row] of loaded) this.values.set(key, row);
  }

  /** Values in force at another valid date and knowledge time. Does not replace the current read. */
  snapshot(ids: string[], asOf: string, knowledge: string): Promise<Map<string, ValueRow>> {
    return valuesFor(this.supabase, [...new Set(ids)], this.defs, asOf, knowledge);
  }

  current(): Map<string, ValueRow> {
    return this.values;
  }

  private row(id: string, code: string) { return read(this.values, id, this.defs.get(code)); }
  attributeId(code: string): string | null { return this.defs.get(code)?.id ?? null; }
  num(id: string, code: string) { return numeric(this.row(id, code)); }
  window(map: Map<string, ValueRow>, id: string, code: string): { value: number | null; validFrom?: string | null; validTo?: string | null } | null {
    const row = read(map, id, this.defs.get(code));
    if (!row) return null;
    return { value: numeric(row), validFrom: row.valid_from, validTo: row.valid_to };
  }
  str(id: string, code: string) { return text(this.row(id, code)); }
  /** Text of a value in another read, such as one taken at the period end. */
  strIn(map: Map<string, ValueRow>, id: string, code: string) { return text(read(map, id, this.defs.get(code))); }
  bool(id: string, code: string) { return flag(this.row(id, code)); }
}

type Named = { id: string; entity_code: string; entity_name: string };

/** The reconciliation notes kept on a close, and the position the reconciliation was in when they were saved. */
export interface CloseNotes {
  notes: string;
  outcome: string;
}

export interface FundRecLoad {
  input: RecInput;
  priorOpen: boolean;
  periods: string[];
  closeNotes: CloseNotes | null;
  priorCertification: PriorCertification | null;
}

/** The report checks kept on a statement: { total, ties, checks: [...] }. Null when there are none or the text is not that. */
export function parseSourceChecks(value: string): { total: number; ties: number; checks: RecSourceCheck[] } | null {
  if (!value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as { total?: unknown; ties?: unknown; checks?: unknown };
    const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
    const amount = (input: unknown) => (input == null || input === '' || !Number.isFinite(Number(input)) ? null : Number(input));
    return {
      total: Number(parsed.total) || checks.length,
      ties: Number(parsed.ties) || 0,
      checks: checks.map((raw) => {
        const item = (raw || {}) as Record<string, unknown>;
        const result = item.result === 'Ties' || item.result === 'Break' ? item.result : 'Missing';
        return { label: String(item.label || ''), where: String(item.where || ''), reported: amount(item.reported), computed: amount(item.computed), difference: amount(item.difference), result };
      }),
    };
  } catch {
    return null;
  }
}

function dateOnly(value: string): string {
  const match = value.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

async function funds(supabase: SupabaseClient): Promise<Named[]> {
  const { data, error } = await supabase
    .from('master_entities')
    .select('id, entity_code, entity_name')
    .eq('domain_code', 'FUND')
    .eq('is_active', true);
  if (error) throw new Error(error.message);
  return ((data || []) as Named[]).sort((left, right) => left.entity_name.localeCompare(right.entity_name));
}

/** The periods a fund can close, newest first, ending at the one now closing. */
function recentPeriods(frequency: Frequency, current: string, count = 8): string[] {
  const out = [current];
  while (out.length < count) out.push(priorPeriodEnd(frequency, out[out.length - 1]));
  return out;
}

export async function loadFundRecInput(
  supabase: SupabaseClient,
  fund: Named,
  periodEndInput: string | null | undefined,
  todayInput: unknown,
  knowledgeInput: unknown,
  /** A what-if threshold. Null reads the fund's own, which is what every saved reading uses. */
  driftThresholdOverride: number | null | undefined,
  shared?: Facts,
  options: FundRecLoadOptions = {},
): Promise<FundRecLoad | null> {
  const today = asOfDate(todayInput);
  const knowledge = knowledgeInstant(knowledgeInput);
  const facts = shared ?? await Facts.open(supabase, today, knowledge);
  await facts.load([fund.id]);
  const frequencyCode = facts.str(fund.id, 'FUND_CLOSE_FREQUENCY');
  if (frequencyCode !== 'MONTHLY' && frequencyCode !== 'QUARTERLY') return null;
  const frequency: Frequency = frequencyCode;
  const lagDays = facts.num(fund.id, 'FUND_CLOSE_LAG_DAYS') ?? 37;
  const fundThreshold = facts.num(fund.id, 'FUND_DRIFT_THRESHOLD_PCT');
  const driftThresholdPct = driftThresholdOverride != null && driftThresholdOverride > 0 ? driftThresholdOverride
    : fundThreshold != null && fundThreshold > 0 ? fundThreshold
      : DEFAULT_DRIFT_THRESHOLD_PCT;
  const periodEnd = periodEndInput ? periodEndInput.slice(0, 10) : periodEndOnOrBefore(frequency, today);
  const tie = [today, knowledge] as const;

  const [statementRels, closeRels, evidenceRels, activityRels, positionRels, facilityRels] = await Promise.all([
    links(supabase, 'STATEMENT_FUND', 'child_entity_id', [fund.id], ...tie),
    links(supabase, 'CLOSE_FUND', 'child_entity_id', [fund.id], ...tie),
    links(supabase, 'EVIDENCE_FUND', 'child_entity_id', [fund.id], ...tie),
    links(supabase, 'ACTIVITY_FUND', 'child_entity_id', [fund.id], ...tie),
    links(supabase, 'POSITION_FUND', 'child_entity_id', [fund.id], ...tie),
    links(supabase, 'FACILITY_FUND', 'child_entity_id', [fund.id], ...tie),
  ]);
  const statementIds = statementRels.map((row) => row.parent_entity_id);
  const closeIds = closeRels.map((row) => row.parent_entity_id);
  const evidenceIds = evidenceRels.map((row) => row.parent_entity_id);
  const activityIds = activityRels.map((row) => row.parent_entity_id);
  const positionIds = positionRels.map((row) => row.parent_entity_id);
  await facts.load([...statementIds, ...closeIds, ...evidenceIds, ...activityIds, ...positionIds]);

  const statementFor = (end: string) => statementIds.find((id) => dateOnly(facts.str(id, 'STATEMENT_PERIOD_END')) === end) ?? null;
  /* One statement holds every period as validity windows. A selected period that has no statement of its own is that statement read at the period's as-of. */
  const datedStatements = statementIds
    .map((id) => ({ id, end: dateOnly(facts.str(id, 'STATEMENT_PERIOD_END')) }))
    .filter((row) => row.end)
    .sort((left, right) => left.end.localeCompare(right.end));
  const statementId = statementFor(periodEnd)
    ?? [...datedStatements].reverse().find((row) => row.end >= periodEnd)?.id
    ?? datedStatements[datedStatements.length - 1]?.id
    ?? null;
  const statementPeriod = statementId ? dateOnly(facts.str(statementId, 'STATEMENT_PERIOD_END')) : '';
  // The close holds on cash once the pack is in, so the cash reconciliation is read beside it, not after.
  const cashRead: Promise<CashRec | null> = options.cashRec
    ?? (statementId ? loadCashRec(supabase, fund.id, periodEnd, today, knowledge) : Promise.resolve(null));
  // Awaited at the end; a failure must not go unhandled while the rest loads.
  cashRead.catch(() => undefined);
  /* What the statement says as of its own period end: the date its prior column is at, and the checks the report made of itself. */
  const atPeriodEnd = statementId ? await facts.snapshot([statementId], periodEnd, knowledge) : new Map<string, ValueRow>();
  const comparative = statementId ? dateOnly(facts.strIn(atPeriodEnd, statementId, 'STATEMENT_COMPARATIVE_DATE')) : '';
  const previous = comparative && comparative < periodEnd ? comparative : priorPeriodEnd(frequency, periodEnd);
  const sourceChecks = statementId ? parseSourceChecks(facts.strIn(atPeriodEnd, statementId, 'STATEMENT_SOURCE_CHECKS')) : null;
  const priorStatementId = statementFor(previous);
  const closeFor = (end: string) => closeIds.find((id) => dateOnly(facts.str(id, 'CLOSE_PERIOD_END')) === end) ?? null;
  const closeId = closeFor(periodEnd);

  /* Lines are attributes of the statement. Each amount is the source in force at the period as-of. The prior amount is the same source at the previous period end. */
  const lineAttributes = await loadNavLineAttributes(supabase);
  const [evidenceEntities, activityEntities, closeEntities, statementEntities] = await Promise.all([
    loadEntities(supabase, evidenceIds),
    loadEntities(supabase, activityIds),
    loadEntities(supabase, closeIds),
    loadEntities(supabase, statementIds),
  ]);
  const evidenceName = new Map(evidenceEntities.map((entity) => [entity.id, entity.entity_name]));
  const activityName = new Map(activityEntities.map((entity) => [entity.id, entity.entity_name]));
  const closeName = new Map(closeEntities.map((entity) => [entity.id, entity.entity_name]));
  const statementName = new Map(statementEntities.map((entity) => [entity.id, entity.entity_name]));
  const certifiedAt = closeId ? dateOnly(facts.str(closeId, 'CLOSE_CERTIFIED_AT')) : '';
  const priorCloseId = closeFor(previous);
  const priorCertifiedAt = priorCloseId ? dateOnly(facts.str(priorCloseId, 'CLOSE_CERTIFIED_AT')) : '';
  // Compare with the prior period as certified: the exact instant of the
  // certification in force at this read's knowledge, so a re-certification of
  // the prior period is picked up by an open close but never changes one
  // already certified. A close certified before certifications were recorded
  // falls back to the end of its certified day.
  const priorCertification = priorCloseId
    ? await certificationAt(supabase, CLOSE_PROCESS, priorCloseId, previous, knowledge).catch(() => null)
    : null;
  const priorKnowledge = priorCertification
    ? priorCertification.knowledgeAt
    : priorCertifiedAt ? knowledgeInstant(priorCertifiedAt) : knowledge;
  const lineIds = lineAttributes.map((line) => line.attributeId);
  const [currentLines, priorLines] = statementId
    ? await Promise.all([
      readSourceAmounts(supabase, [statementId], lineIds, [FUND_ADMIN_SOURCE, INTERNAL_SOURCE], periodEnd, knowledge),
      readSourceAmounts(supabase, [statementId], lineIds, [FUND_ADMIN_SOURCE, INTERNAL_SOURCE], previous, knowledge),
    ])
    : [new Map(), new Map()];
  const lines: RecLine[] = statementId ? lineAttributes.map((line) => ({
    id: line.code,
    entityId: statementId,
    code: line.code,
    statement: line.section,
    role: line.role,
    label: line.name,
    indent: line.indent,
    order: line.order,
    admin: sourceAmount(currentLines, statementId, line.attributeId, FUND_ADMIN_SOURCE),
    shadow: sourceAmount(currentLines, statementId, line.attributeId, INTERNAL_SOURCE),
    prior: sourceAmount(priorLines, statementId, line.attributeId, FUND_ADMIN_SOURCE),
    unit: line.unit,
  })) : [];
  const BOOK_SOURCE = INTERNAL_SOURCE;
  const positionCodes = ['MARKET_VALUE', 'ACCRUED_CASH_INTEREST_AMOUNT', 'UNREALIZED_GAIN_LOSS', 'POSITION_MARK', 'POSITION_AGENT_MARK', 'POSITION_STRATEGY', 'METRIC_DATE', 'POSITION_CURRENCY', 'COST_BASIS'] as const;
  const positionAttrIds = positionCodes.map((code) => facts.attributeId(code)).filter((id): id is string => Boolean(id));
  const [positionNow, positionThen] = positionIds.length && positionAttrIds.length
    ? await Promise.all([
      readSourceAmounts(supabase, positionIds, positionAttrIds, [FUND_ADMIN_SOURCE, INTERNAL_SOURCE], periodEnd, knowledge),
      readSourceAmounts(supabase, positionIds, positionAttrIds, [FUND_ADMIN_SOURCE, INTERNAL_SOURCE], previous, knowledge),
    ])
    : [new Map(), new Map()];
  const booked = (rows: Map<string, SourceValue>, entityId: string, code: (typeof positionCodes)[number]) => {
    const attributeId = facts.attributeId(code);
    if (!attributeId) return { amount: null as number | null, source: null as string | null };
    for (const source of [BOOK_SOURCE]) {
      const amount = sourceAmount(rows, entityId, attributeId, source);
      if (amount != null) return { amount, source };
    }
    return { amount: null as number | null, source: null as string | null };
  };

  /* The roll belongs to the statement's own period. Another period is the same positions read at that as-of. */
  const rollRels = statementId && statementPeriod === periodEnd ? await links(supabase, 'ROLL_STATEMENT', 'child_entity_id', [statementId], ...tie) : [];
  const rollIds = rollRels.map((row) => row.parent_entity_id);
  const rollPositionRels = rollIds.length ? await links(supabase, 'ROLL_POSITION', 'parent_entity_id', rollIds, ...tie) : [];
  await facts.load(rollIds);
  const rollByPosition = new Map<string, string>();
  for (const rel of rollPositionRels) rollByPosition.set(rel.child_entity_id, rel.parent_entity_id);
  const [positionEntities, rollEntities] = await Promise.all([
    loadEntities(supabase, positionIds),
    loadEntities(supabase, rollIds),
  ]);
  const rollName = new Map(rollEntities.map((entity) => [entity.id, entity.entity_name]));
  const cashRels = positionIds.length ? await links(supabase, 'POSITION_CASHFLOW', 'parent_entity_id', positionIds, ...tie) : [];
  const cashIds = cashRels.map((row) => row.child_entity_id);
  await facts.load(cashIds);
  const cashEntities = await loadEntities(supabase, cashIds);
  const cashName = new Map(cashEntities.map((entity) => [entity.id, entity.entity_name]));
  const flowsByPosition = new Map<string, Array<{ id: string; name: string; bucket: FlowBucket; amount: number; date: string }>>();
  for (const rel of cashRels) {
    const date = dateOnly(facts.str(rel.child_entity_id, 'CASHFLOW_DATE'));
    const bucket = cashflowBucket(facts.str(rel.child_entity_id, 'CASHFLOW_TYPE'));
    const amount = facts.num(rel.child_entity_id, 'AMOUNT');
    if (!date || date <= previous || date > periodEnd || bucket == null || amount == null) continue;
    const list = flowsByPosition.get(rel.parent_entity_id) ?? [];
    list.push({ id: rel.child_entity_id, name: cashName.get(rel.child_entity_id) || facts.str(rel.child_entity_id, 'CASHFLOW_TYPE'), bucket, amount, date });
    flowsByPosition.set(rel.parent_entity_id, list);
  }
  const flowFields: FlowBucket[] = ['purchases', 'repayments', 'sales', 'pik', 'amort', 'unrealizedChg', 'realized', 'interest', 'fees'];
  const rollCodes = [
    'ROLL_PURCHASES', 'ROLL_REPAYMENTS', 'ROLL_SALES', 'ROLL_PIK', 'ROLL_AMORTIZATION',
    'ROLL_UNREALIZED_CHANGE', 'ROLL_REALIZED_GAIN', 'ROLL_END_FV',
    'ROLL_INTEREST_EARNED', 'ROLL_FEE_INCOME', 'ROLL_END_ACCRUED', 'ROLL_OUR_ACCRUED',
  ] as const;
  const rollAttrIds = rollCodes.map((code) => facts.attributeId(code)).filter((id): id is string => Boolean(id));
  const rollAmounts = rollIds.length && rollAttrIds.length
    ? await readSourceAmounts(supabase, rollIds, rollAttrIds, [FUND_ADMIN_SOURCE, INTERNAL_SOURCE], periodEnd, knowledge)
    : new Map();
  const rollNum = (id: string, code: (typeof rollCodes)[number], source: string) => {
    const attributeId = facts.attributeId(code);
    return attributeId ? sourceAmount(rollAmounts, id, attributeId, source) : null;
  };
  const toRoll = (id: string): RecRoll => ({
    begin: 0,
    purchases: rollNum(id, 'ROLL_PURCHASES', FUND_ADMIN_SOURCE) ?? 0,
    repayments: rollNum(id, 'ROLL_REPAYMENTS', FUND_ADMIN_SOURCE) ?? 0,
    sales: rollNum(id, 'ROLL_SALES', FUND_ADMIN_SOURCE) ?? 0,
    pik: rollNum(id, 'ROLL_PIK', FUND_ADMIN_SOURCE) ?? 0,
    amort: rollNum(id, 'ROLL_AMORTIZATION', FUND_ADMIN_SOURCE) ?? 0,
    unrealizedChg: rollNum(id, 'ROLL_UNREALIZED_CHANGE', FUND_ADMIN_SOURCE) ?? 0,
    realized: rollNum(id, 'ROLL_REALIZED_GAIN', FUND_ADMIN_SOURCE) ?? 0,
    interest: rollNum(id, 'ROLL_INTEREST_EARNED', FUND_ADMIN_SOURCE) ?? 0,
    fees: rollNum(id, 'ROLL_FEE_INCOME', FUND_ADMIN_SOURCE) ?? 0,
    beginUnrealized: 0,
    beginAccrued: 0,
    endAccrued: rollNum(id, 'ROLL_END_ACCRUED', FUND_ADMIN_SOURCE) ?? 0,
    endFv: rollNum(id, 'ROLL_END_FV', FUND_ADMIN_SOURCE) ?? 0,
    ourAccrued: rollNum(id, 'ROLL_OUR_ACCRUED', INTERNAL_SOURCE),
  });
  const positions: RecPosition[] = positionEntities
    .map((entity) => {
      const rollId = rollByPosition.get(entity.id);
      const nowBook = booked(positionNow, entity.id, 'MARKET_VALUE');
      const priorBook = booked(positionThen, entity.id, 'MARKET_VALUE');
      const priorAccrued = booked(positionThen, entity.id, 'ACCRUED_CASH_INTEREST_AMOUNT');
      const priorUnrealized = booked(positionThen, entity.id, 'UNREALIZED_GAIN_LOSS');
      const strategyCode = facts.attributeId('POSITION_STRATEGY');
      const markId = facts.attributeId('POSITION_MARK');
      const agentId = facts.attributeId('POSITION_AGENT_MARK');
      const strategy = (strategyCode ? sourceText(positionNow, entity.id, strategyCode, INTERNAL_SOURCE) : '')
        || facts.str(entity.id, 'POSITION_STRATEGY');
      const mark = markId ? sourceAmount(positionNow, entity.id, markId, FUND_ADMIN_SOURCE) : null;
      const agentMark = agentId ? sourceAmount(positionNow, entity.id, agentId, INTERNAL_SOURCE) : null;
      const hits = flowsByPosition.get(entity.id) ?? [];
      const accruedNow = booked(positionNow, entity.id, 'ACCRUED_CASH_INTEREST_AMOUNT');
      let roll = rollId ? toRoll(rollId) : null;
      const flowSources: Partial<Record<FlowBucket, RecBind[]>> = {};
      if (hits.length) {
        roll = roll ?? {
          begin: 0, purchases: 0, repayments: 0, sales: 0, pik: 0, amort: 0, unrealizedChg: 0, realized: 0,
          interest: 0, fees: 0, beginUnrealized: 0, beginAccrued: 0, endAccrued: accruedNow.amount ?? 0,
          endFv: nowBook.amount ?? 0, ourAccrued: null,
        };
        for (const field of flowFields) roll[field] = 0;
        for (const hit of hits) {
          roll[hit.bucket] += hit.amount;
          const bind: RecBind = {
            entityId: hit.id, entityName: hit.name, domainCode: 'CASH_FLOW', code: 'AMOUNT', name: hit.name, dataType: 'CURRENCY', asOfDate: hit.date,
          };
          (flowSources[hit.bucket] ??= []).push(bind);
        }
      }
      if (roll) {
        roll.begin = priorBook.amount ?? 0;
        roll.beginAccrued = priorAccrued.amount ?? 0;
        roll.beginUnrealized = priorUnrealized.amount ?? 0;
      }
      return {
        id: entity.id,
        code: entity.entity_code,
        name: entity.entity_name,
        group: POSITION_STRATEGY[strategy] || strategy || 'Other',
        mark: mark ?? facts.num(entity.id, 'POSITION_MARK'),
        agentMark: agentMark ?? facts.num(entity.id, 'POSITION_AGENT_MARK'),
        marketValue: nowBook.amount,
        bookSource: nowBook.source,
        priorBookSource: priorBook.source,
        roll,
        flowSources: Object.keys(flowSources).length ? flowSources : undefined,
        rollId: rollId ?? null,
        rollName: rollId ? (rollName.get(rollId) || entity.entity_name) : null,
        openingFromHistory: {
          fairValue: priorBook.amount != null,
          accrued: priorAccrued.amount != null,
          unrealized: priorUnrealized.amount != null,
        },
      };
    })
    // A position that has no roll-forward and no value this period is an exit from an earlier period.
    .filter((position) => position.roll || (position.marketValue ?? 0) > 0)
    .sort((left, right) => left.group.localeCompare(right.group) || left.name.localeCompare(right.name));

  /*
   * The administrator's schedule of investments at the period end: positions whose administrator value is
   * dated the period end. A position that has left the schedule keeps its last value, but not this date.
   */
  const metricId = facts.attributeId('METRIC_DATE');
  const marketId = facts.attributeId('MARKET_VALUE');
  const scheduled = metricId && marketId
    ? positionEntities.filter((entity) => sourceText(positionNow, entity.id, metricId, FUND_ADMIN_SOURCE).slice(0, 10) === periodEnd
      && sourceAmount(positionNow, entity.id, marketId, FUND_ADMIN_SOURCE) != null)
    : [];
  const costId = facts.attributeId('COST_BASIS');
  const currencyId = facts.attributeId('POSITION_CURRENCY');
  const costOf = (id: string) => (costId ? sourceAmount(positionNow, id, costId, FUND_ADMIN_SOURCE) : null);
  const adminSchedule = scheduled.length
    ? {
      total: scheduled.reduce((total, entity) => total + (sourceAmount(positionNow, entity.id, marketId!, FUND_ADMIN_SOURCE) ?? 0), 0),
      cost: scheduled.some((entity) => costOf(entity.id) != null) ? scheduled.reduce((total, entity) => total + (costOf(entity.id) ?? 0), 0) : null,
      count: scheduled.length,
      sources: scheduled.slice(0, 100).map((entity): RecBind => ({
        entityId: entity.id, entityName: entity.entity_name, domainCode: 'POSITION', code: 'MARKET_VALUE', name: 'Market Value',
        dataType: 'NUMBER', asOfDate: periodEnd, sourceCode: FUND_ADMIN_SOURCE,
      })),
    }
    : null;
  /* What the pack's valuation support and FX translation are checked against: the administrator's schedule, or our own book. */
  const holdings: PackHolding[] = scheduled.length
    ? scheduled.map((entity) => ({
      id: entity.id, name: entity.entity_name, fairValue: sourceAmount(positionNow, entity.id, marketId!, FUND_ADMIN_SOURCE) ?? 0,
      cost: costOf(entity.id), currency: (currencyId ? sourceText(positionNow, entity.id, currencyId, FUND_ADMIN_SOURCE) : '').toUpperCase() || null,
    }))
    : positions.filter((position) => (position.marketValue ?? 0) > 0).map((position) => ({
      id: position.id, name: position.name, fairValue: position.marketValue ?? 0, cost: null, currency: null,
    }));

  /* outside evidence */
  const evidenceOn = (kind: string): { amount: number | null; id: string | null; name: string | null } => {
    const hit = evidenceIds.find((id) => facts.str(id, 'EVIDENCE_KIND') === kind && dateOnly(facts.str(id, 'EVIDENCE_DATE')) === periodEnd) ?? null;
    return { amount: hit ? facts.num(hit, 'EVIDENCE_AMOUNT') : null, id: hit, name: hit ? (evidenceName.get(hit) || null) : null };
  };

  /* capital activity */
  const calls: Array<{ date: string; amount: number; id: string; name: string }> = [];
  const distributions: Array<{ id: string; name: string }> = [];
  let callsInPeriod = 0;
  let distributionsInPeriod = 0;
  const activities: PackActivity[] = [];
  for (const id of activityIds) {
    const date = dateOnly(facts.str(id, 'ACTIVITY_DATE'));
    const kind = facts.str(id, 'ACTIVITY_KIND');
    const status = facts.str(id, 'ACTIVITY_STATUS');
    const amount = facts.num(id, 'ACTIVITY_AMOUNT') ?? 0;
    if (date && kind) activities.push({ id, name: activityName.get(id) || '', kind, date, amount, status: status || null, outstanding: facts.num(id, 'ACTIVITY_OUTSTANDING') });
    if (!date || date > periodEnd) continue;
    const inPeriod = date > previous;
    const name = activityName.get(id) || '';
    if (kind === 'CAPITAL_CALL' && (status === 'FUNDED' || status === 'PAID')) {
      calls.push({ date, amount, id, name });
      if (inPeriod) callsInPeriod += amount;
    }
    if (kind === 'DISTRIBUTION' && status === 'PAID' && inPeriod) {
      distributions.push({ id, name });
      distributionsInPeriod += amount;
    }
  }

  /* reviewer decisions on this close */
  const dispositions: Record<string, RecDisposition> = {};
  if (closeId) {
    const rels = await links(supabase, 'DISPOSITION_CLOSE', 'child_entity_id', [closeId], ...tie);
    const ids = rels.map((row) => row.parent_entity_id);
    await facts.load(ids);
    for (const id of ids) {
      const item = facts.str(id, 'DISPOSITION_ITEM');
      const decision = facts.str(id, 'DISPOSITION_DECISION');
      if (!item || (decision !== 'ACCEPT' && decision !== 'ADJUST' && decision !== 'QUERY')) continue;
      dispositions[item] = { id, decision, note: facts.str(id, 'DISPOSITION_NOTE') };
    }
  }

  const statementCertified = statementId ? facts.bool(statementId, 'STATEMENT_CERTIFIED') : false;
  const priorCertified = Boolean(priorCertifiedAt) || Boolean(priorStatementId && facts.bool(priorStatementId, 'STATEMENT_CERTIFIED'));

  const strategy = facts.str(fund.id, 'FUND_STRATEGY');
  const pack = await loadNavPack(supabase, {
    fund: { id: fund.id, name: fund.entity_name }, statementId, periodEnd, today, knowledge, holdings, activities,
  });
  const input: RecInput = {
    fund: {
      id: fund.id,
      code: fund.entity_code,
      name: fund.entity_name,
      strategy: FUND_STRATEGY[strategy] || strategy,
      frequency,
      lagDays,
      commitments: facts.num(fund.id, 'FUND_TOTAL_COMMITMENTS'),
      feeRatePct: facts.num(fund.id, 'FUND_MGMT_FEE_RATE_PCT'),
      prefPct: facts.num(fund.id, 'FUND_PREF_RETURN_PCT'),
      carryPct: facts.num(fund.id, 'FUND_CARRY_PCT'),
      catchUpPct: facts.num(fund.id, 'FUND_CATCH_UP_PCT'),
      netIrr: facts.num(fund.id, 'FUND_NET_IRR'),
      hasFacility: facilityRels.length > 0,
      capitalModel: (facts.str(fund.id, 'FUND_CAPITAL_MODEL') || 'DRAWDOWN') as CapitalModel,
      mgmtFeeBasis: (facts.str(fund.id, 'FUND_MGMT_FEE_BASIS') || 'COMMITMENTS') as MgmtFeeBasis,
      perfFeeBasis: (facts.str(fund.id, 'FUND_PERF_FEE_BASIS') || 'WATERFALL') as PerfFeeBasis,
      mgmtFeeStepDownDate: dateOnly(facts.str(fund.id, 'FUND_MGMT_FEE_STEPDOWN_DATE')) || null,
      mgmtFeeStepDownRatePct: facts.num(fund.id, 'FUND_MGMT_FEE_STEPDOWN_RATE_PCT'),
      mgmtFeeStepDownBasis: (facts.str(fund.id, 'FUND_MGMT_FEE_STEPDOWN_BASIS') || null) as MgmtFeeBasis | null,
    },
    periodEnd,
    priorAsOf: previous,
    priorKnowledge,
    today,
    statement: statementId
      ? {
        id: statementId,
        label: statementName.get(statementId) || facts.str(statementId, 'STATEMENT_PERIOD_LABEL'),
        receivedDate: statementPeriod === periodEnd ? (dateOnly(facts.str(statementId, 'STATEMENT_RECEIVED_DATE')) || null) : null,
        certified: statementPeriod === periodEnd && statementCertified,
        tolerancePct: facts.num(statementId, 'STATEMENT_TOLERANCE_PCT') ?? 0.5,
      }
      : null,
    lines,
    positions,
    adminSchedule,
    sourceChecks,
    pack,
    evidence: (() => {
      const bank = evidenceOn('BANK');
      const lender = evidenceOn('LENDER');
      return {
        bank: bank.amount,
        lender: lender.amount,
        bankEntityId: bank.id,
        bankEntityName: bank.name,
        lenderEntityId: lender.id,
        lenderEntityName: lender.name,
      };
    })(),
    capital: { calls, callsInPeriod, distributionsInPeriod, distributions },
    close: closeId
      ? {
        id: closeId,
        name: closeName.get(closeId) || undefined,
        signoff: SIGNOFF[facts.str(closeId, 'CLOSE_SIGNOFF')] || 'Not started',
        certifiedAt: certifiedAt || null,
        certifiedBy: facts.str(closeId, 'CLOSE_CERTIFIED_BY') || null,
        certifiedNav: facts.num(closeId, 'CLOSE_CERTIFIED_NAV'),
      }
      : null,
    dispositions,
    driftThresholdPct,
    cash: await cashRead.then((rec) => (rec && rec.fundId === fund.id && rec.periodEnd === periodEnd ? cashStanding(rec) : null)),
  };
  return {
    input,
    priorOpen: Boolean(priorStatementId) && !priorCertified,
    periods: recentPeriods(frequency, periodEndOnOrBefore(frequency, today)),
    closeNotes: closeId && facts.str(closeId, 'CLOSE_REC_NOTES')
      ? { notes: facts.str(closeId, 'CLOSE_REC_NOTES'), outcome: facts.str(closeId, 'CLOSE_REC_OUTCOME') }
      : null,
    priorCertification: priorCertification
      ? {
        id: priorCertification.id,
        version: priorCertification.version,
        periodEnd: priorCertification.periodEnd,
        knowledgeAt: priorCertification.knowledgeAt,
        certifiedAt: priorCertification.certifiedAt,
      }
      : null,
  };
}

export async function loadFundRec(
  supabase: SupabaseClient,
  fundId: string,
  periodEnd: string | null | undefined,
  todayInput: unknown,
  knowledgeInput: unknown,
  driftThresholdPct: number | null = null,
  options: FundRecLoadOptions = {},
): Promise<RecReview & { periods: string[]; priorOpen: boolean; fundCode: string; closeNotes: CloseNotes | null; priorCertification: PriorCertification | null }> {
  const lookup = /^[0-9a-f-]{36}$/i.test(fundId) ? 'id' : 'entity_code';
  const { data: fund, error } = await supabase
    .from('master_entities')
    .select('id, entity_code, entity_name, domain_code')
    .eq(lookup, fundId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!fund || fund.domain_code !== 'FUND') throw new Error('Fund not found');
  const loaded = await loadFundRecInput(supabase, fund, periodEnd, todayInput, knowledgeInput, driftThresholdPct, undefined, options);
  if (!loaded) throw new Error('This fund has no close calendar. Set a close frequency on the fund record.');
  return {
    ...buildReview(loaded.input),
    periods: loaded.periods,
    priorOpen: loaded.priorOpen,
    fundCode: fund.entity_code,
    closeNotes: loaded.closeNotes,
    priorCertification: loaded.priorCertification,
  };
}

export interface FundRecSummary {
  fundId: string;
  fundCode: string;
  fundName: string;
  strategy: string;
  frequency: Frequency;
  periodEnd: string;
  periodLabel: string;
  targetDate: string;
  daysToTarget: number;
  health: RecReview['health'];
  healthNote: string;
  atRisk: boolean;
  priorOpen: boolean;
  navReported: number | null;
  navProposed: number | null;
  navChangePct: number | null;
  breaks: number;
  missing: number;
  stepsDone: number;
  stepsTotal: number;
  overdueSteps: number;
  nextStep: string | null;
  nextDue: string | null;
  itemsOpen: number;
  itemsTotal: number;
  queries: number;
  readyForRec: boolean;
  gaps: string[];
  readiness: Array<{ key: string; label: string; ok: boolean; required: boolean }>;
  certified: boolean;
}

export interface FundRecBoard {
  asOfDate: string;
  funds: FundRecSummary[];
  totals: {
    funds: number; certified: number; inReview: number; blocked: number; awaitingPack: number;
    atRisk: number; breaks: number; openItems: number; withAdmin: number; notReady: number;
  };
}

export function summarize(review: RecReview, extra: { fundCode: string; priorOpen: boolean }): FundRecSummary {
  const next = review.steps.find((step) => step.state !== 'Done') ?? null;
  return {
    fundId: review.fundId,
    fundCode: extra.fundCode,
    fundName: review.fundName,
    strategy: review.strategy,
    frequency: review.frequency,
    periodEnd: review.periodEnd,
    periodLabel: review.periodLabel,
    targetDate: review.targetDate,
    daysToTarget: review.daysToTarget,
    health: review.health,
    healthNote: review.healthNote,
    atRisk: review.atRisk,
    priorOpen: extra.priorOpen,
    navReported: review.navReported,
    navProposed: review.navProposed,
    navChangePct: review.navChangePct,
    breaks: review.breaks,
    missing: review.missing,
    stepsDone: review.stepsDone,
    stepsTotal: review.steps.length,
    overdueSteps: review.steps.filter((step) => step.overdue).length,
    nextStep: next?.name ?? null,
    nextDue: next?.due ?? null,
    itemsOpen: review.items.filter((item) => item.decision == null).length,
    itemsTotal: review.items.length,
    queries: review.queries,
    readyForRec: review.readyForRec,
    gaps: review.readiness.filter((item) => item.required && !item.ok).map((item) => item.label),
    readiness: review.readiness.map((item) => ({ key: item.key, label: item.label, ok: item.ok, required: item.required })),
    certified: review.certified,
  };
}

export async function loadFundRecBoard(
  supabase: SupabaseClient,
  todayInput: unknown,
  knowledgeInput?: unknown,
): Promise<FundRecBoard> {
  const today = asOfDate(todayInput);
  const knowledge = knowledgeInstant(knowledgeInput);
  const facts = await Facts.open(supabase, today, knowledge);
  const list = await funds(supabase);
  const loads = await Promise.all(list.map((fund) => loadFundRecInput(supabase, fund, null, today, knowledge, null, facts)
    .then((loaded) => ({ fund, loaded }))));
  const rows = loads
    .filter((entry): entry is { fund: Named; loaded: FundRecLoad } => entry.loaded != null)
    .map(({ fund, loaded }) => summarize(buildReview(loaded.input), { fundCode: fund.entity_code, priorOpen: loaded.priorOpen }));
  const rank: Record<string, number> = { BLOCKED: 0, AWAITING_PACK: 1, IN_REVIEW: 2, CERTIFIED: 3 };
  rows.sort((left, right) => (Number(right.atRisk) - Number(left.atRisk)) || (rank[left.health] - rank[right.health]) || left.targetDate.localeCompare(right.targetDate) || left.fundName.localeCompare(right.fundName));
  const count = (health: string) => rows.filter((row) => row.health === health).length;
  return {
    asOfDate: today,
    funds: rows,
    totals: {
      funds: rows.length,
      certified: count('CERTIFIED'),
      inReview: count('IN_REVIEW'),
      blocked: count('BLOCKED'),
      awaitingPack: count('AWAITING_PACK'),
      atRisk: rows.filter((row) => row.atRisk).length,
      breaks: rows.reduce((total, row) => total + row.breaks, 0),
      openItems: rows.reduce((total, row) => total + row.itemsOpen, 0),
      withAdmin: rows.reduce((total, row) => total + row.queries, 0),
      notReady: rows.filter((row) => !row.readyForRec).length,
    },
  };
}

