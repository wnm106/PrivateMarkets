import {
  CASH_RULE_LABEL, clearingAdjustment,
  type AdjustmentSide, type CashRec, type CashRule, type CashRuleKind,
} from '@tapestrai/graphql/src/lib/cash-rec';
import { CREATE_ENTITY_MUTATION, UPDATE_ENTITY_MUTATION, graphqlMutation } from '@/lib/graphql';

export type { AdjustmentSide, CashRec, CashRule, CashRuleKind };
export { CASH_RULE_LABEL, clearingAdjustment };

type MutationErrors = { entity?: { id: string } | null; errors?: Array<{ message: string }> };

export function cashMoney(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function cashTypeLabel(type: string): string {
  const words = type.trim().toLowerCase().replace(/[_-]+/g, ' ');
  return words.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function owned(rec: CashRec, input: Record<string, unknown>): Record<string, unknown> {
  if (!rec.clientId) throw new Error('This fund has no client, so the pair cannot be saved');
  return { ...input, clientId: rec.clientId };
}

async function create(input: Record<string, unknown>): Promise<string> {
  const result = await graphqlMutation<{ createEntity: MutationErrors }, { input: Record<string, unknown> }>(CREATE_ENTITY_MUTATION, { input });
  const message = result.error?.message || result.data?.createEntity?.errors?.[0]?.message;
  const id = result.data?.createEntity?.entity?.id;
  if (message || !id) throw new Error(message || 'Could not save');
  return id;
}

async function update(id: string, attributes: Record<string, string>, asOfDate: string, isActive?: boolean): Promise<void> {
  const input: Record<string, unknown> = { id, asOfDate };
  if (Object.keys(attributes).length) input.attributes = attributes;
  if (typeof isActive === 'boolean') input.isActive = isActive;
  const result = await graphqlMutation<{ updateEntity: MutationErrors }, { input: Record<string, unknown> }>(UPDATE_ENTITY_MUTATION, { input });
  const message = result.error?.message || result.data?.updateEntity?.errors?.[0]?.message;
  if (message) throw new Error(message);
}

function periodStamp(periodEnd: string): string {
  return periodEnd.replace(/-/g, '');
}

/** Write the preference order. Default rules are saved onto the fund the first time they change. */
export async function saveCashRules(rec: CashRec, next: CashRule[], asOfDate: string): Promise<void> {
  const fresh = rec.rules.some((rule) => !rule.persisted);
  if (fresh) {
    for (const rule of next) {
      await create(owned(rec, {
        entityCode: `${rec.fundCode}-RULE-${rule.kind}`,
        entityName: rule.name,
        domainCode: 'CASH_MATCH_RULE',
        templateCode: 'CASH_MATCH_RULE_STANDARD',
        description: rule.name,
        attributes: {
          RULE_KIND: rule.kind,
          RULE_PRIORITY: String(rule.priority),
          RULE_ENABLED: rule.enabled ? 'true' : 'false',
          RULE_DATE_DAYS: String(rule.dateDays),
          RULE_AMOUNT_TOLERANCE: String(rule.amountTolerance),
          RULE_MAX_ITEMS: String(rule.maxItems),
        },
        parentRelationships: [{
          parentEntityId: rec.fundId,
          childEntityId: rec.fundId,
          relationshipType: 'Match rule of fund',
          relationshipCode: 'FUND_CASH_RULE',
          isPrimary: true,
          validFrom: asOfDate,
        }],
      }));
    }
    return;
  }
  for (const rule of next) {
    const prev = rec.rules.find((item) => item.id === rule.id);
    if (!prev) continue;
    const attributes: Record<string, string> = {};
    if (prev.enabled !== rule.enabled) attributes.RULE_ENABLED = rule.enabled ? 'true' : 'false';
    if (prev.priority !== rule.priority) attributes.RULE_PRIORITY = String(rule.priority);
    if (Object.keys(attributes).length) await update(rule.id, attributes, asOfDate);
  }
}

export function moveCashRule(rules: CashRule[], ruleId: string, direction: -1 | 1): CashRule[] {
  const ordered = [...rules].sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));
  const index = ordered.findIndex((rule) => rule.id === ruleId);
  const swap = index + direction;
  if (index < 0 || swap < 0 || swap >= ordered.length) return ordered;
  const next = ordered.slice();
  const [row] = next.splice(index, 1);
  next.splice(swap, 0, row);
  return next.map((rule, place) => ({ ...rule, priority: (place + 1) * 10 }));
}

/** Approve a proposed pair, or pair the selected cash flows to one bank transaction by hand. */
export async function saveCashMatch(
  rec: CashRec,
  bankTxnId: string,
  flowIds: string[],
  kind: CashRuleKind,
  confidence: number,
  variance: number,
  asOfDate: string,
): Promise<void> {
  const txn = rec.transactions.find((row) => row.id === bankTxnId);
  if (!txn || !flowIds.length) throw new Error('Choose a bank transaction and at least one cash flow');
  await create(owned(rec, {
    entityCode: `${rec.fundCode}-MATCH-${periodStamp(rec.periodEnd)}-${txn.code}-${Date.now().toString(36)}`,
    entityName: txn.description || txn.code,
    domainCode: 'CASH_MATCH',
    templateCode: 'CASH_MATCH_STANDARD',
    description: `${flowIds.length} positional cash flow${flowIds.length === 1 ? '' : 's'} paired to ${txn.description || 'a bank transaction'}.`,
    attributes: {
      MATCH_RULE: kind,
      MATCH_STATUS: 'APPROVED',
      MATCH_CONFIDENCE: String(confidence),
      MATCH_VARIANCE: String(variance),
      MATCH_PERIOD_END: rec.periodEnd,
    },
    childRelationships: [bankTxnId, ...flowIds].map((childId, index) => ({
      parentEntityId: rec.fundId,
      childEntityId: childId,
      relationshipType: index === 0 ? 'Match to bank transaction' : 'Match to cash flow',
      relationshipCode: index === 0 ? 'MATCH_BANK_TXN' : 'MATCH_CASHFLOW',
      isPrimary: true,
      validFrom: asOfDate,
    })),
  }));
}

export async function unmatchCash(matchId: string, asOfDate: string): Promise<void> {
  await update(matchId, {}, asOfDate, false);
}

export async function saveCashAdjustment(
  rec: CashRec,
  amount: number,
  side: AdjustmentSide,
  reason: string,
  asOfDate: string,
): Promise<void> {
  const trimmed = reason.trim();
  if (!Number.isFinite(amount) || amount === 0) throw new Error('Enter an adjustment amount');
  if (!trimmed) throw new Error('Enter a reason for the adjustment');
  await create(owned(rec, {
    entityCode: `${rec.fundCode}-CASH-ADJ-${periodStamp(rec.periodEnd)}-${Date.now().toString(36)}`,
    entityName: trimmed.slice(0, 80),
    domainCode: 'CASH_ADJUSTMENT',
    templateCode: 'CASH_ADJUSTMENT_STANDARD',
    description: trimmed,
    attributes: {
      ADJ_AMOUNT: String(amount),
      ADJ_SIDE: side,
      ADJ_REASON: trimmed,
      ADJ_PERIOD_END: rec.periodEnd,
      ADJ_STATUS: 'POSTED',
    },
    childRelationships: [{
      parentEntityId: rec.fundId,
      childEntityId: rec.fundId,
      relationshipType: 'Adjustment of fund',
      relationshipCode: 'ADJUSTMENT_FUND',
      isPrimary: true,
      validFrom: asOfDate,
    }],
  }));
}
