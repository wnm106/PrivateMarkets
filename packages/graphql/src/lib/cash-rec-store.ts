/**
 * Read one fund's cash reconciliation from the entity model and hand it to the matcher.
 * Bank accounts belong to the fund. Bank transactions belong to an account.
 * An approved match pairs one bank transaction with one or more positional cash flows.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  bankDateInPeriod, bankLagDays, buildCashRec, settlementAmount,
  type AdjustmentSide, type CashAccount, type CashAdjustment, type CashFlowFact, type CashRec,
  type CashRule, type CashRuleKind, type BankTxnFact, type LockedMatch,
} from './cash-rec';
import { asOfDate, knowledgeInstant, links, numeric, read, text, valuesFor, type Def, type ValueRow } from './fund-surface';
import { periodEndOnOrBefore, priorPeriodEnd, type Frequency } from './fund-rec';

const CODES = [
  'FUND_CLOSE_FREQUENCY',
  'CASHFLOW_DATE', 'CASHFLOW_TYPE', 'AMOUNT',
  'BANK_NAME', 'BANK_ACCOUNT_NUMBER', 'BANK_ACCOUNT_LABEL',
  'BANK_TXN_DATE', 'BANK_TXN_AMOUNT', 'BANK_TXN_DESCRIPTION', 'BANK_TXN_REFERENCE', 'BANK_TXN_COUNTERPARTY',
  'RULE_KIND', 'RULE_PRIORITY', 'RULE_ENABLED', 'RULE_DATE_DAYS', 'RULE_AMOUNT_TOLERANCE', 'RULE_MAX_ITEMS',
  'MATCH_RULE', 'MATCH_STATUS',
  'ADJ_AMOUNT', 'ADJ_SIDE', 'ADJ_REASON', 'ADJ_PERIOD_END', 'ADJ_STATUS',
] as const;

const RULE_KINDS = new Set<CashRuleKind>(['EXACT', 'DATE_DELAY', 'DOLLAR_VARIANCE', 'DATE_VARIANCE', 'MULTI_POSITION', 'MULTI', 'MANUAL']);

class Facts {
  private values = new Map<string, ValueRow>();
  private constructor(
    private defs: Map<string, Def>,
    private asOf: string,
    private knowledge: string,
  ) {}

  static async open(supabase: SupabaseClient, asOf: string, knowledge: string): Promise<Facts> {
    const { data, error } = await supabase.from('attribute_register').select('id, attribute_code').in('attribute_code', [...CODES]);
    if (error) throw new Error(error.message);
    const defs = new Map<string, Def>();
    for (const row of data || []) defs.set(row.attribute_code, { id: row.id, code: row.attribute_code });
    return new Facts(defs, asOf, knowledge);
  }

  async load(supabase: SupabaseClient, ids: string[]): Promise<void> {
    const fresh = [...new Set(ids)].filter(Boolean);
    if (!fresh.length) return;
    const loaded = await valuesFor(supabase, fresh, this.defs, this.asOf, this.knowledge);
    for (const [key, row] of loaded) this.values.set(key, row);
  }

  private row(id: string, code: string) { return read(this.values, id, this.defs.get(code)); }
  num(id: string, code: string) { return numeric(this.row(id, code)); }
  str(id: string, code: string) { return text(this.row(id, code)); }
  on(id: string, code: string) {
    const value = this.str(id, code).toLowerCase();
    return value === 'true' || value === 't' || value === '1';
  }
}

type Named = { id: string; entity_code: string; entity_name: string };

function day(value: string): string {
  const match = value.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function kindOf(value: string): CashRuleKind | null {
  const key = value.trim().toUpperCase();
  return RULE_KINDS.has(key as CashRuleKind) ? key as CashRuleKind : null;
}

async function activeEntities(supabase: SupabaseClient, ids: string[]): Promise<Named[]> {
  const fresh = [...new Set(ids)].filter(Boolean);
  if (!fresh.length) return [];
  const { data, error } = await supabase.from('master_entities').select('id, entity_code, entity_name, is_active').in('id', fresh);
  if (error) throw new Error(error.message);
  return ((data || []) as Array<Named & { is_active?: boolean }>).filter((row) => row.is_active !== false);
}

export async function loadCashRec(
  supabase: SupabaseClient,
  fundId: string,
  periodEndInput: string | null | undefined,
  todayInput: unknown,
  knowledgeInput: unknown,
): Promise<CashRec> {
  const lookup = /^[0-9a-f-]{36}$/i.test(fundId) ? 'id' : 'entity_code';
  const { data: fund, error } = await supabase
    .from('master_entities')
    .select('id, entity_code, entity_name, domain_code, client_id')
    .eq(lookup, fundId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!fund || fund.domain_code !== 'FUND') throw new Error('Fund not found');

  const asOf = asOfDate(todayInput);
  const knowledge = knowledgeInstant(knowledgeInput);
  const facts = await Facts.open(supabase, asOf, knowledge);
  await facts.load(supabase, [fund.id]);
  const frequency: Frequency = facts.str(fund.id, 'FUND_CLOSE_FREQUENCY') === 'MONTHLY' ? 'MONTHLY' : 'QUARTERLY';
  const periodEnd = day(periodEndInput || '') || periodEndOnOrBefore(frequency, asOf);
  const prior = priorPeriodEnd(frequency, periodEnd);
  const tie = [asOf, knowledge] as const;

  const positionRels = await links(supabase, 'POSITION_FUND', 'child_entity_id', [fund.id], ...tie);
  const positionIds = positionRels.map((row) => row.parent_entity_id);
  const cashRels = await links(supabase, 'POSITION_CASHFLOW', 'parent_entity_id', positionIds, ...tie);
  const cashIds = cashRels.map((row) => row.child_entity_id);
  const positionOfCash = new Map(cashRels.map((row) => [row.child_entity_id, row.parent_entity_id]));

  const accountRels = await links(supabase, 'FUND_BANK_ACCOUNT', 'parent_entity_id', [fund.id], ...tie);
  const accountIds = accountRels.map((row) => row.child_entity_id);
  const txnRels = await links(supabase, 'ACCOUNT_BANK_TXN', 'parent_entity_id', accountIds, ...tie);
  const txnIds = txnRels.map((row) => row.child_entity_id);
  const accountOfTxn = new Map(txnRels.map((row) => [row.child_entity_id, row.parent_entity_id]));

  const ruleRels = await links(supabase, 'FUND_CASH_RULE', 'parent_entity_id', [fund.id], ...tie);
  const ruleIds = ruleRels.map((row) => row.child_entity_id);
  const adjustmentRels = await links(supabase, 'ADJUSTMENT_FUND', 'child_entity_id', [fund.id], ...tie);
  const adjustmentIds = adjustmentRels.map((row) => row.parent_entity_id);

  const matchTxnRels = await links(supabase, 'MATCH_BANK_TXN', 'child_entity_id', txnIds, ...tie);
  const matchIds = [...new Set(matchTxnRels.map((row) => row.parent_entity_id))];
  const matchFlowRels = await links(supabase, 'MATCH_CASHFLOW', 'parent_entity_id', matchIds, ...tie);

  const [positions, cashEntities, accountEntities, txnEntities, ruleEntities, matchEntities, adjustmentEntities] = await Promise.all([
    activeEntities(supabase, positionIds),
    activeEntities(supabase, cashIds),
    activeEntities(supabase, accountIds),
    activeEntities(supabase, txnIds),
    activeEntities(supabase, ruleIds),
    activeEntities(supabase, matchIds),
    activeEntities(supabase, adjustmentIds),
  ]);
  const positionName = new Map(positions.map((row) => [row.id, row.entity_name]));
  const activeCash = new Set(cashEntities.map((row) => row.id));
  const activeTxn = new Set(txnEntities.map((row) => row.id));
  const activeMatch = new Set(matchEntities.map((row) => row.id));
  const cashName = new Map(cashEntities.map((row) => [row.id, row]));
  const txnName = new Map(txnEntities.map((row) => [row.id, row]));

  await facts.load(supabase, [
    ...cashIds, ...accountIds, ...txnIds, ...ruleIds, ...matchIds, ...adjustmentIds,
  ]);

  const rules: CashRule[] = ruleEntities.flatMap((entity) => {
    const kind = kindOf(facts.str(entity.id, 'RULE_KIND'));
    if (!kind || kind === 'MANUAL') return [];
    return [{
      id: entity.id,
      kind,
      name: entity.entity_name || kind,
      priority: facts.num(entity.id, 'RULE_PRIORITY') ?? 100,
      enabled: facts.on(entity.id, 'RULE_ENABLED'),
      dateDays: facts.num(entity.id, 'RULE_DATE_DAYS') ?? 0,
      amountTolerance: facts.num(entity.id, 'RULE_AMOUNT_TOLERANCE') ?? 0.01,
      maxItems: facts.num(entity.id, 'RULE_MAX_ITEMS') ?? 1,
      persisted: true,
    }];
  });
  const lag = bankLagDays(rules);

  const accounts: CashAccount[] = accountEntities.map((entity) => ({
    id: entity.id,
    code: entity.entity_code,
    name: facts.str(entity.id, 'BANK_ACCOUNT_LABEL') || entity.entity_name,
    bankName: facts.str(entity.id, 'BANK_NAME'),
    accountNumber: facts.str(entity.id, 'BANK_ACCOUNT_NUMBER'),
  }));

  const flows: CashFlowFact[] = [];
  for (const id of activeCash) {
    const named = cashName.get(id);
    const date = day(facts.str(id, 'CASHFLOW_DATE'));
    const amount = facts.num(id, 'AMOUNT');
    const signed = amount == null ? null : settlementAmount(facts.str(id, 'CASHFLOW_TYPE'), amount);
    if (!named || !date || date <= prior || date > periodEnd || signed == null || signed === 0) continue;
    const positionId = positionOfCash.get(id) || '';
    flows.push({
      id,
      code: named.entity_code,
      name: named.entity_name,
      positionId,
      positionName: positionName.get(positionId) || '',
      type: facts.str(id, 'CASHFLOW_TYPE'),
      date,
      amount: signed,
    });
  }

  const transactions: BankTxnFact[] = [];
  for (const id of activeTxn) {
    const named = txnName.get(id);
    const date = day(facts.str(id, 'BANK_TXN_DATE'));
    const amount = facts.num(id, 'BANK_TXN_AMOUNT');
    const accountId = accountOfTxn.get(id) || '';
    if (!named || !date || amount == null || !bankDateInPeriod(date, prior, periodEnd, lag)) continue;
    transactions.push({
      id,
      code: named.entity_code,
      accountId,
      date,
      amount,
      description: facts.str(id, 'BANK_TXN_DESCRIPTION') || named.entity_name,
      counterparty: facts.str(id, 'BANK_TXN_COUNTERPARTY'),
      reference: facts.str(id, 'BANK_TXN_REFERENCE'),
    });
  }
  const txnInPeriod = new Set(transactions.map((txn) => txn.id));

  const flowsOfMatch = new Map<string, string[]>();
  for (const rel of matchFlowRels) {
    const list = flowsOfMatch.get(rel.parent_entity_id) ?? [];
    list.push(rel.child_entity_id);
    flowsOfMatch.set(rel.parent_entity_id, list);
  }
  const locked: LockedMatch[] = [];
  for (const rel of matchTxnRels) {
    if (!activeMatch.has(rel.parent_entity_id) || !txnInPeriod.has(rel.child_entity_id)) continue;
    if (facts.str(rel.parent_entity_id, 'MATCH_STATUS').toUpperCase() !== 'APPROVED') continue;
    const kind = kindOf(facts.str(rel.parent_entity_id, 'MATCH_RULE')) ?? 'MANUAL';
    locked.push({
      id: rel.parent_entity_id,
      kind,
      bankTxnId: rel.child_entity_id,
      flowIds: flowsOfMatch.get(rel.parent_entity_id) ?? [],
    });
  }

  const adjustments: CashAdjustment[] = [];
  for (const entity of adjustmentEntities) {
    if (day(facts.str(entity.id, 'ADJ_PERIOD_END')) !== periodEnd) continue;
    const side = facts.str(entity.id, 'ADJ_SIDE').toUpperCase();
    const amount = facts.num(entity.id, 'ADJ_AMOUNT');
    if ((side !== 'POSITION' && side !== 'BANK') || amount == null) continue;
    adjustments.push({
      id: entity.id,
      amount,
      side: side as AdjustmentSide,
      reason: facts.str(entity.id, 'ADJ_REASON') || entity.entity_name,
      status: facts.str(entity.id, 'ADJ_STATUS') || 'POSTED',
    });
  }

  return buildCashRec({
    fundId: fund.id,
    fundCode: fund.entity_code,
    fundName: fund.entity_name,
    clientId: fund.client_id ?? '',
    periodEnd,
    priorPeriodEnd: prior,
    accounts,
    flows,
    transactions,
    rules,
    adjustments,
    locked,
  });
}
