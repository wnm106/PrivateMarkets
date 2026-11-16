/**
 * The changes a fund reconciliation records: a decision on a review item, an
 * approved cash pair, a cash adjustment, and the reconciliation notes.
 *
 * These write the same records the reconciliation pages write, so a decision
 * made by a workflow and one made on the page are the same thing afterwards.
 * Every one reads the reconciliation first and refuses a change that no longer
 * fits it: an item that is gone, a bank transaction already paired, a
 * certified period.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadCashRec } from './cash-rec-store';
import type { AdjustmentSide, CashRec, CashRuleKind } from './cash-rec';
import type { Decision } from './fund-rec';
import { loadFundRec } from './fund-rec-store';
import { recOutcome } from './rec-digest';

type FundRec = Awaited<ReturnType<typeof loadFundRec>>;

const OPEN_END = '9999-12-31';
const OPEN_SYSTEM = '9999-12-31 23:59:59';

const stamp = (periodEnd: string) => periodEnd.replace(/-/g, '');
const slug = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const unique = () => Date.now().toString(36);

export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function fail(error: { message?: string } | null | undefined, fallback: string): never {
  throw new Error(error?.message || fallback);
}

async function manualSourceId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.schema('entity_instances').from('source_registry').select('id').eq('source_code', 'MANUAL').single();
  if (error || !data?.id) fail(error, 'The Manual Entry source is not registered.');
  return data.id as string;
}

async function attributeDefs(supabase: SupabaseClient, codes: string[]): Promise<Map<string, { id: string; rank: number | null }>> {
  const { data, error } = await supabase.from('attribute_register').select('id, attribute_code, default_precedence_rank').in('attribute_code', codes);
  if (error) fail(error, 'The attributes could not be read.');
  const found = new Map<string, { id: string; rank: number | null }>();
  for (const row of data || []) found.set(row.attribute_code, { id: row.id, rank: row.default_precedence_rank ?? null });
  const missing = codes.filter((code) => !found.has(code));
  if (missing.length > 0) throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set up on this platform. Apply the latest database migrations.`);
  return found;
}

function numericOf(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface NewRecord {
  code: string;
  name: string;
  domainCode: string;
  templateCode: string;
  description: string;
  clientId: string;
  attributes: Record<string, string>;
  /** Records this one points at. This record is the parent of each link, as the pages write them. */
  links: Array<{ childId: string; type: string; code: string }>;
  validFrom: string;
}

async function createRecord(supabase: SupabaseClient, input: NewRecord): Promise<string> {
  if (!input.clientId) throw new Error('This fund has no client, so the change cannot be saved.');
  const defs = await attributeDefs(supabase, Object.keys(input.attributes));
  const sourceId = await manualSourceId(supabase);
  const template = await supabase.from('domain_templates').select('id').eq('template_code', input.templateCode).maybeSingle();
  if (template.error) fail(template.error, 'The record template could not be read.');

  const created = await supabase
    .from('master_entities')
    .insert({
      entity_code: input.code,
      entity_name: input.name,
      domain_code: input.domainCode,
      template_id: template.data?.id ?? null,
      description: input.description,
      client_id: input.clientId,
    })
    .select('id')
    .single();
  if (created.error || !created.data?.id) fail(created.error, 'The record could not be created.');
  const id = created.data.id as string;

  for (const [code, value] of Object.entries(input.attributes)) {
    const def = defs.get(code)!;
    const { error } = await supabase.from('entity_attribute_values').insert({
      entity_id: id,
      attribute_id: def.id,
      source_id: sourceId,
      golden_value: value,
      golden_value_numeric: numericOf(value),
      valid_from: input.validFrom,
      precedence_rank: def.rank,
    });
    if (error) fail(error, `${code} could not be saved.`);
  }
  for (const link of input.links) {
    const { error } = await supabase.from('entity_relationships').insert({
      parent_entity_id: id,
      child_entity_id: link.childId,
      relationship_type: link.type,
      relationship_code: link.code,
      is_primary: true,
      valid_from: input.validFrom,
    });
    if (error) fail(error, 'The record could not be linked.');
  }
  return id;
}

/** Replaces the manual value of each attribute from `asOf`. Earlier values stay in history. */
async function setAttributes(supabase: SupabaseClient, entityId: string, attributes: Record<string, string>, asOf: string): Promise<void> {
  const entries = Object.entries(attributes).filter(([, value]) => value !== '');
  if (entries.length === 0) return;
  const defs = await attributeDefs(supabase, entries.map(([code]) => code));
  const sourceId = await manualSourceId(supabase);
  for (const [code, value] of entries) {
    const def = defs.get(code)!;
    const closed = await supabase
      .from('entity_attribute_values')
      .update({ valid_to: asOf, system_to: new Date().toISOString() })
      .eq('entity_id', entityId)
      .eq('attribute_id', def.id)
      .eq('source_id', sourceId)
      .eq('system_to', OPEN_SYSTEM);
    if (closed.error) fail(closed.error, `${code} could not be saved.`);
    const { error } = await supabase.from('entity_attribute_values').insert({
      entity_id: entityId,
      attribute_id: def.id,
      source_id: sourceId,
      golden_value: value,
      golden_value_numeric: numericOf(value),
      valid_from: asOf,
      valid_to: OPEN_END,
      system_to: OPEN_SYSTEM,
      precedence_rank: 1,
      is_manual_override: true,
    });
    if (error) fail(error, `${code} could not be saved.`);
  }
}

async function fundClientId(supabase: SupabaseClient, fundId: string): Promise<string> {
  const { data, error } = await supabase.from('master_entities').select('client_id').eq('id', fundId).maybeSingle();
  if (error) fail(error, 'The fund could not be read.');
  return (data?.client_id as string | null) || '';
}

/** The close record for the period. Created the first time anything is decided, as on the page. */
async function ensureClose(supabase: SupabaseClient, rec: FundRec, asOf: string): Promise<string> {
  if (rec.closeEntityId) return rec.closeEntityId;
  return createRecord(supabase, {
    code: `${rec.fundCode}-CLOSE-${stamp(rec.periodEnd)}`,
    name: `${rec.periodLabel} close`,
    domainCode: 'FUND_CLOSE',
    templateCode: 'FUND_CLOSE_STANDARD',
    description: `Close of ${rec.fundName} for the period ended ${rec.periodEnd}.`,
    clientId: await fundClientId(supabase, rec.fundId),
    attributes: { CLOSE_PERIOD_END: rec.periodEnd, CLOSE_SIGNOFF: 'NOT_STARTED' },
    links: [{ childId: rec.fundId, type: 'Close of fund', code: 'CLOSE_FUND' }],
    validFrom: asOf,
  });
}

function requireOpen(rec: FundRec): void {
  if (rec.certified) throw new Error(`${rec.periodLabel} of ${rec.fundName} is certified. Reopen the period before changing it.`);
}

export interface PeriodRef {
  /** Fund record id or fund code. */
  fundId: string;
  /** YYYY-MM-DD. Omitted means the period now closing. */
  periodEnd?: string | null;
}

export interface DecisionInput extends PeriodRef {
  itemId: string;
  decision: Decision;
  note?: string | null;
}

const DECISIONS: readonly Decision[] = ['ACCEPT', 'ADJUST', 'QUERY'];

/** What is wrong with a decision before anything is read. Empty means it can be recorded. */
export function decisionProblem(input: { decision: string; note?: string | null }): string | null {
  if (!DECISIONS.includes(input.decision as Decision)) return 'decision must be ACCEPT, ADJUST, or QUERY.';
  if (input.decision !== 'ACCEPT' && !String(input.note || '').trim()) {
    return input.decision === 'ADJUST'
      ? 'An adjustment needs a note saying what is adjusted and why.'
      : 'A query needs a note with the question for the administrator.';
  }
  return null;
}

/** Accept the administrator's figure on a review item, propose an adjustment, or query the administrator. */
export async function recordRecDecision(supabase: SupabaseClient, input: DecisionInput, asOf: string = today()) {
  const problem = decisionProblem(input);
  if (problem) throw new Error(problem);
  const rec = await loadFundRec(supabase, input.fundId, input.periodEnd, asOf, null);
  requireOpen(rec);
  const item = rec.items.find((candidate) => candidate.id === input.itemId);
  if (!item) {
    const known = rec.items.map((candidate) => candidate.id).join(', ') || 'none';
    throw new Error(`"${input.itemId}" is not a review item of ${rec.periodLabel}. Items on this period: ${known}.`);
  }
  const closeId = await ensureClose(supabase, rec, asOf);
  const attributes = {
    DISPOSITION_DECISION: input.decision,
    DISPOSITION_NOTE: String(input.note || '').trim(),
    DISPOSITION_EFFECT: String(item.effect),
  };
  let dispositionId = item.dispositionId;
  if (dispositionId) {
    await setAttributes(supabase, dispositionId, attributes, asOf);
  } else {
    dispositionId = await createRecord(supabase, {
      code: `${rec.fundCode}-REC-${stamp(rec.periodEnd)}-${slug(item.id)}`,
      name: item.title,
      domainCode: 'REC_DISPOSITION',
      templateCode: 'REC_DISPOSITION_STANDARD',
      description: `Decision on ${item.title}, ${rec.periodLabel} close.`,
      clientId: await fundClientId(supabase, rec.fundId),
      attributes: Object.fromEntries(Object.entries({ DISPOSITION_ITEM: item.id, ...attributes }).filter(([, value]) => value !== '')),
      links: [{ childId: closeId, type: 'Decision on close', code: 'DISPOSITION_CLOSE' }],
      validFrom: asOf,
    });
  }
  return {
    fund: rec.fundName,
    period: rec.periodLabel,
    item: item.title,
    decision: input.decision,
    navEffect: item.effect,
    replaced: item.decision,
    closeId,
    dispositionId,
  };
}

export interface CashPairing {
  kind: CashRuleKind;
  confidence: number;
  variance: number;
}

const sameSet = (left: string[], right: string[]) => left.length === right.length && [...left].sort().join('|') === [...right].sort().join('|');

/**
 * Checks a pair against the cash reconciliation and says how it is recorded.
 * A pair the rules already propose keeps the rule's kind and confidence;
 * any other pair is a manual one. Throws when the pair cannot be made.
 */
export function cashPairing(rec: CashRec, bankTxnId: string, flowIds: string[]): CashPairing {
  const ids = [...new Set(flowIds.filter(Boolean))];
  const txn = rec.transactions.find((row) => row.id === bankTxnId);
  if (!txn) throw new Error('That bank transaction is not in this period of the cash reconciliation.');
  if (txn.status === 'APPROVED') throw new Error(`Bank transaction ${txn.code} is already paired. Unmatch it on the cash reconciliation before pairing it again.`);
  if (ids.length === 0) throw new Error('Choose at least one cash flow to pair with the bank transaction.');
  let total = 0;
  for (const id of ids) {
    const flow = rec.flows.find((row) => row.id === id);
    if (!flow) throw new Error(`Cash flow ${id} is not in this period of the cash reconciliation.`);
    if (flow.status === 'APPROVED') throw new Error(`Cash flow ${flow.code} is already paired to a bank transaction.`);
    total += flow.amount;
  }
  const proposed = rec.matches.find((match) => match.status === 'PROPOSED' && match.bankTxnId === bankTxnId && sameSet(match.flowIds, ids));
  if (proposed) return { kind: proposed.kind, confidence: proposed.confidence, variance: proposed.variance };
  return { kind: 'MANUAL', confidence: 1, variance: Math.round((txn.amount - total) * 100) / 100 };
}

export interface CashMatchInput extends PeriodRef {
  bankTxnId: string;
  flowIds: string[];
}

/** Pair one bank transaction with the positional cash flows it settled. */
export async function approveCashMatch(supabase: SupabaseClient, input: CashMatchInput, asOf: string = today()) {
  const rec = await loadCashRec(supabase, input.fundId, input.periodEnd, asOf, null);
  const flowIds = [...new Set((input.flowIds || []).map(String).filter(Boolean))];
  const pairing = cashPairing(rec, input.bankTxnId, flowIds);
  const txn = rec.transactions.find((row) => row.id === input.bankTxnId)!;
  const matchId = await createRecord(supabase, {
    code: `${rec.fundCode}-MATCH-${stamp(rec.periodEnd)}-${txn.code}-${unique()}`,
    name: txn.description || txn.code,
    domainCode: 'CASH_MATCH',
    templateCode: 'CASH_MATCH_STANDARD',
    description: `${flowIds.length} positional cash flow${flowIds.length === 1 ? '' : 's'} paired to ${txn.description || 'a bank transaction'}.`,
    clientId: rec.clientId,
    attributes: {
      MATCH_RULE: pairing.kind,
      MATCH_STATUS: 'APPROVED',
      MATCH_CONFIDENCE: String(pairing.confidence),
      MATCH_VARIANCE: String(pairing.variance),
      MATCH_PERIOD_END: rec.periodEnd,
    },
    links: [
      { childId: input.bankTxnId, type: 'Match to bank transaction', code: 'MATCH_BANK_TXN' },
      ...flowIds.map((childId) => ({ childId, type: 'Match to cash flow', code: 'MATCH_CASHFLOW' })),
    ],
    validFrom: asOf,
  });
  return { fund: rec.fundName, periodEnd: rec.periodEnd, matchId, bankTransaction: txn.code, bankAmount: txn.amount, cashFlows: flowIds.length, ...pairing };
}

export interface CashAdjustmentInput extends PeriodRef {
  amount: number;
  side: AdjustmentSide;
  reason: string;
}

/** Post a reconciling entry to one side of the cash reconciliation. */
export async function postCashAdjustment(supabase: SupabaseClient, input: CashAdjustmentInput, asOf: string = today()) {
  const amount = Number(input.amount);
  const reason = String(input.reason || '').trim();
  if (!Number.isFinite(amount) || amount === 0) throw new Error('An adjustment needs an amount that is not zero.');
  if (input.side !== 'POSITION' && input.side !== 'BANK') throw new Error('side must be POSITION or BANK.');
  if (!reason) throw new Error('An adjustment needs a reason.');
  const rec = await loadCashRec(supabase, input.fundId, input.periodEnd, asOf, null);
  const adjustmentId = await createRecord(supabase, {
    code: `${rec.fundCode}-CASH-ADJ-${stamp(rec.periodEnd)}-${unique()}`,
    name: reason.slice(0, 80),
    domainCode: 'CASH_ADJUSTMENT',
    templateCode: 'CASH_ADJUSTMENT_STANDARD',
    description: reason,
    clientId: rec.clientId,
    attributes: {
      ADJ_AMOUNT: String(amount),
      ADJ_SIDE: input.side,
      ADJ_REASON: reason,
      ADJ_PERIOD_END: rec.periodEnd,
      ADJ_STATUS: 'POSTED',
    },
    links: [{ childId: rec.fundId, type: 'Adjustment of fund', code: 'ADJUSTMENT_FUND' }],
    validFrom: asOf,
  });
  return { fund: rec.fundName, periodEnd: rec.periodEnd, adjustmentId, amount, side: input.side, residualBefore: rec.summary.residual };
}

export interface NotesInput extends PeriodRef {
  notes: string;
}

/**
 * Keep the reconciliation notes on the period's close. The outcome line beside
 * them is not taken from the writer: it is read from the reconciliation as it
 * stands when the notes are saved, so the two cannot disagree about the facts.
 */
export async function saveRecNotes(supabase: SupabaseClient, input: NotesInput, asOf: string = today()) {
  const notes = String(input.notes || '').trim();
  if (!notes) throw new Error('The notes are empty.');
  const rec = await loadFundRec(supabase, input.fundId, input.periodEnd, asOf, null);
  const cash = await loadCashRec(supabase, rec.fundId, rec.periodEnd, asOf, null).catch(() => null);
  const outcome = `${recOutcome(rec, cash)} As of ${asOf}.`;
  const closeId = await ensureClose(supabase, rec, asOf);
  await setAttributes(supabase, closeId, { CLOSE_REC_NOTES: notes, CLOSE_REC_OUTCOME: outcome }, asOf);
  return { fund: rec.fundName, period: rec.periodLabel, closeId, outcome, replaced: Boolean(rec.closeNotes) };
}
