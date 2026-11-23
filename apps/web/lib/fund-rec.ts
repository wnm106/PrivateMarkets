import type { RecBind, RecReview } from '@tapestrai/graphql/src/lib/fund-rec';
import type { FundRecBoard } from '@tapestrai/graphql/src/lib/fund-rec-store';
import { CREATE_ENTITY_MUTATION, UPDATE_ENTITY_MUTATION, graphqlMutation } from '@/lib/graphql';
import type { Figures } from '@/lib/certification';
import type { CashRec } from '@/lib/cash-rec';

export type { RecBind, RecReview, FundRecBoard };
export type FundRec = RecReview & {
  periods: string[];
  priorOpen: boolean;
  fundCode: string;
  /** Reconciliation notes kept on the close, and where the reconciliation stood when they were saved. */
  closeNotes?: { notes: string; outcome: string } | null;
  /** The prior period's certification this close compares against: the one in force at this read's knowledge. */
  priorCertification?: { id: string; version: number; periodEnd: string | null; knowledgeAt: string; certifiedAt: string } | null;
};

export const FUND_REC_BOARD_QUERY = `
  query FundRecBoard($asOfDate: Date) {
    fundRecBoard(asOfDate: $asOfDate)
  }
`;

export const FUND_REC_QUERY = `
  query FundRec($fundId: ID!, $periodEnd: Date, $asOfDate: Date, $knowledgeDate: DateTime, $driftThresholdPct: Float) {
    fundRec(fundId: $fundId, periodEnd: $periodEnd, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate, driftThresholdPct: $driftThresholdPct)
    cashRec(fundId: $fundId, periodEnd: $periodEnd, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate)
  }
`;

/** The certification process a NAV close is certified under (golden_master.certification_processes). */
export const CLOSE_PROCESS = 'FUND_CLOSE';

/**
 * The key figures of a close, as certified and as read again later. Status
 * that certifying itself changes (certified, health, steps done) is left out,
 * so a replay at the certified instant matches what the person saw.
 */
export function recFigures(rec: FundRec, cash: CashRec | null): Figures {
  const undecided = rec.items.filter((item) => item.decision == null).length;
  const figures: Figures = {
    navReported: { label: 'NAV as reported', value: rec.navReported },
    navProposed: { label: 'Proposed NAV', value: rec.navProposed },
    navCertified: { label: 'Certified NAV', value: rec.navProposed ?? rec.navReported },
    navPrior: { label: 'Prior NAV', value: rec.navPrior },
    adjustments: { label: 'Adjustments', value: rec.adjustments },
    breaks: { label: 'Statement breaks', value: rec.breaks },
    itemsDecided: { label: 'Review items decided', value: rec.itemsDecided },
    itemsOpen: { label: 'Review items open', value: undecided },
    rollTied: { label: 'Roll-forward ties', value: rec.roll.present ? rec.roll.tied : null },
  };
  if (cash) {
    figures.cashTied = { label: 'Cash ties', value: cash.summary.tied };
    figures.cashResidual = { label: 'Cash residual', value: cash.summary.residual };
    figures.cashOpenFlows = { label: 'Unmatched cash flows', value: cash.summary.openFlowCount };
    figures.cashOpenTxns = { label: 'Unmatched bank transactions', value: cash.summary.openTxnCount };
  }
  return figures;
}

/** Whole dollars to $ millions. Negatives in parentheses, the way the statements print them. */
export function millions(amount: number | null | undefined, digits = 2): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const value = amount / 1e6;
  if (Math.abs(value) < 0.5 * 10 ** -digits) return (0).toFixed(digits);
  const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return value < 0 ? `(${text})` : text;
}

export function signedMillions(amount: number | null | undefined, digits = 2): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const value = amount / 1e6;
  if (Math.abs(value) < 0.5 * 10 ** -digits) return '—';
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function percent(value: number | null | undefined, digits = 1, withSign = false): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const text = `${Math.abs(value).toFixed(digits)}%`;
  if (!withSign) return value < 0 ? `−${text}` : text;
  return `${value < 0 ? '−' : '+'}${text}`;
}

export function shortDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function longDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function dayCount(days: number): string {
  if (days === 0) return 'due today';
  return days > 0 ? `${days} day${days === 1 ? '' : 's'} left` : `${-days} day${days === -1 ? '' : 's'} late`;
}

export const HEALTH_LABEL: Record<string, string> = {
  CERTIFIED: 'Certified',
  BLOCKED: 'Blocked',
  AWAITING_PACK: 'Awaiting pack',
  IN_REVIEW: 'In review',
};

/** Status chip class from the dashboard baseline: ok, near, breach, na. */
export function healthTone(health: string, atRisk: boolean): 'ok' | 'near' | 'breach' | 'na' {
  if (health === 'CERTIFIED') return 'ok';
  if (health === 'BLOCKED') return 'breach';
  if (atRisk) return 'breach';
  if (health === 'AWAITING_PACK') return 'na';
  return 'near';
}

export function stepTone(state: string): 'ok' | 'near' | 'breach' | 'na' {
  if (state === 'Done') return 'ok';
  if (state === 'Blocked') return 'breach';
  if (state === 'In progress') return 'near';
  return 'na';
}

const slug = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

interface WriteContext {
  rec: FundRec;
  asOfDate: string;
}

type MutationErrors = { entity?: { id: string } | null; errors?: Array<{ message: string }> };

async function create(
  input: Record<string, unknown>,
): Promise<string> {
  const result = await graphqlMutation<{ createEntity: MutationErrors }, { input: Record<string, unknown> }>(CREATE_ENTITY_MUTATION, { input });
  const message = result.error?.message || result.data?.createEntity?.errors?.[0]?.message;
  const id = result.data?.createEntity?.entity?.id;
  if (message || !id) throw new Error(message || 'Could not save');
  return id;
}

async function update(id: string, attributes: Record<string, string>, asOfDate: string): Promise<void> {
  const result = await graphqlMutation<{ updateEntity: MutationErrors }, { input: Record<string, unknown> }>(UPDATE_ENTITY_MUTATION, {
    input: { id, attributes, asOfDate },
  });
  const message = result.error?.message || result.data?.updateEntity?.errors?.[0]?.message;
  if (message) throw new Error(message);
}

/** The close record for this period. Created the first time anything is decided or signed off. */
export async function ensureClose({ rec, asOfDate }: WriteContext): Promise<string> {
  if (rec.closeEntityId) return rec.closeEntityId;
  return create({
    entityCode: `${rec.fundCode}-CLOSE-${rec.periodEnd.replace(/-/g, '')}`,
    entityName: `${rec.periodLabel} close`,
    domainCode: 'FUND_CLOSE',
    templateCode: 'FUND_CLOSE_STANDARD',
    description: `Close of ${rec.fundName} for the period ended ${rec.periodEnd}.`,
    attributes: { CLOSE_PERIOD_END: rec.periodEnd, CLOSE_SIGNOFF: 'NOT_STARTED' },
    childRelationships: [{
      parentEntityId: rec.fundId,
      childEntityId: rec.fundId,
      relationshipType: 'Close of fund',
      relationshipCode: 'CLOSE_FUND',
      isPrimary: true,
      validFrom: asOfDate,
    }],
  });
}

export async function recordDecision(
  ctx: WriteContext,
  item: RecReview['items'][number],
  decision: 'ACCEPT' | 'ADJUST' | 'QUERY' | '',
  note: string,
): Promise<void> {
  const closeId = await ensureClose(ctx);
  const attributes = {
    DISPOSITION_DECISION: decision,
    DISPOSITION_NOTE: note,
    DISPOSITION_EFFECT: String(item.effect),
  };
  if (item.dispositionId) {
    await update(item.dispositionId, attributes, ctx.asOfDate);
    return;
  }
  await create({
    entityCode: `${ctx.rec.fundCode}-REC-${ctx.rec.periodEnd.replace(/-/g, '')}-${slug(item.id)}`,
    entityName: item.title,
    domainCode: 'REC_DISPOSITION',
    templateCode: 'REC_DISPOSITION_STANDARD',
    description: `Decision on ${item.title}, ${ctx.rec.periodLabel} close.`,
    attributes: { DISPOSITION_ITEM: item.id, ...attributes },
    childRelationships: [{
      parentEntityId: closeId,
      childEntityId: closeId,
      relationshipType: 'Decision on close',
      relationshipCode: 'DISPOSITION_CLOSE',
      isPrimary: true,
      validFrom: ctx.asOfDate,
    }],
  });
}

export async function setSignoff(ctx: WriteContext, value: string): Promise<void> {
  const closeId = await ensureClose(ctx);
  await update(closeId, { CLOSE_SIGNOFF: value }, ctx.asOfDate);
}

/** Marks the close certified on its records and returns the close record's id. The caller then records the certification. */
export async function certify(ctx: WriteContext): Promise<string> {
  const closeId = await ensureClose(ctx);
  await update(closeId, {
    CLOSE_CERTIFIED_AT: ctx.asOfDate,
    CLOSE_CERTIFIED_NAV: String(ctx.rec.navProposed ?? ctx.rec.navReported ?? ''),
  }, ctx.asOfDate);
  if (ctx.rec.statementId) await update(ctx.rec.statementId, { STATEMENT_CERTIFIED: 'true' }, ctx.asOfDate);
  return closeId;
}

export async function reopen(ctx: WriteContext): Promise<void> {
  if (ctx.rec.closeEntityId) await update(ctx.rec.closeEntityId, { CLOSE_CERTIFIED_AT: '' }, ctx.asOfDate);
  if (ctx.rec.statementId) await update(ctx.rec.statementId, { STATEMENT_CERTIFIED: 'false' }, ctx.asOfDate);
}
