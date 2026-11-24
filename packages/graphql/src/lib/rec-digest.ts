/**
 * A fund reconciliation, cut down to what a reader needs to reason about it.
 *
 * The review the pages draw carries every figure's sources, so it is far too
 * large to hand to a model. These digests keep the figures, the results, and
 * the ids a change has to name, and drop the rest. Pure, so the same digest is
 * what a workflow step sees and what a test checks.
 */

import { clearingAdjustment, type CashRec } from './cash-rec';
import type { RecReview } from './fund-rec';

type Review = RecReview & { fundCode?: string; priorOpen?: boolean; closeNotes?: { notes: string; outcome: string } | null };

const round = (value: number | null | undefined): number | null => (value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100);

function header(review: Review) {
  return {
    fund: { id: review.fundId, code: review.fundCode ?? null, name: review.fundName, strategy: review.strategy },
    periodEnd: review.periodEnd,
    periodLabel: review.periodLabel,
    priorPeriodEnd: review.priorPeriodEnd,
  };
}

/** One line a person can read: where the reconciliation stands. */
export function recOutcome(review: RecReview, cash?: CashRec | null): string {
  const open = review.items.length - review.itemsDecided;
  const parts = [
    review.certified ? 'Certified.' : !review.readyForRec ? 'Not ready to reconcile.' : review.canCertify ? 'Ready to certify.' : 'In review.',
    `${review.breaks} break${review.breaks === 1 ? '' : 's'} and ${review.missing} check${review.missing === 1 ? '' : 's'} with a figure missing.`,
    `${open} of ${review.items.length} review item${review.items.length === 1 ? '' : 's'} undecided, ${review.queries} with the administrator, ${review.adjustments} proposed adjustment${review.adjustments === 1 ? '' : 's'}.`,
    review.roll.present ? `Position roll-forward ${review.roll.tied ? 'ties' : 'does not tie'} to the statements.` : 'No position roll-forward on file.',
  ];
  if (cash) {
    const { summary } = cash;
    parts.push(
      summary.tied
        ? 'Cash ties to the bank.'
        : `Cash is out by ${summary.residual.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}, with ${summary.openFlowCount} cash flow${summary.openFlowCount === 1 ? '' : 's'} and ${summary.openTxnCount} bank transaction${summary.openTxnCount === 1 ? '' : 's'} unmatched.`,
    );
  }
  if (!review.certified && review.certifyBlock) parts.push(review.certifyBlock);
  return parts.join(' ');
}

/** The NAV reconciliation: readiness, the tie-out checks, statement variances, review items, fees, and the close steps. */
export function navDigest(review: Review) {
  const variances = review.statements.flatMap((statement) =>
    statement.lines
      .filter((line) => line.varianceFlagged || line.flagged)
      .map((line) => ({
        statement: statement.title,
        line: line.label,
        administrator: round(line.current),
        internal: round(line.internal),
        variance: round(line.variance),
        varianceFlagged: line.varianceFlagged,
        prior: round(line.prior),
        change: round(line.change),
        changePct: round(line.changePct),
        movementFlagged: line.flagged,
      })),
  );
  return {
    ...header(review),
    targetDate: review.targetDate,
    daysToTarget: review.daysToTarget,
    health: review.health,
    healthNote: review.healthNote,
    atRisk: review.atRisk,
    priorPeriodOpen: review.priorOpen ?? false,
    certified: review.certified,
    canCertify: review.canCertify,
    certifyBlock: review.certifyBlock,
    signoff: review.signoff,
    outcome: recOutcome(review),
    nav: { reported: round(review.navReported), proposed: round(review.navProposed), prior: round(review.navPrior), changePct: round(review.navChangePct) },
    readyForRec: review.readyForRec,
    readiness: review.readiness.map((item) => ({ key: item.key, label: item.label, ok: item.ok, required: item.required, detail: item.detail })),
    breaks: review.breaks,
    missing: review.missing,
    checks: review.checks.map((check) => ({
      id: check.id,
      group: check.group,
      label: check.label,
      compared: check.compared,
      a: round(check.a),
      b: round(check.b),
      difference: round(check.difference),
      result: check.result,
      ...(check.component ? { packPart: check.component } : {}),
    })),
    pack: packDigest(review),
    statementLinesFlagged: variances,
    itemsOpen: review.items.length - review.itemsDecided,
    queries: review.queries,
    adjustments: review.adjustments,
    items: review.items.map((item) => ({
      itemId: item.id,
      area: item.tab,
      title: item.title,
      administrator: round(item.admin),
      ours: round(item.ours),
      navEffect: round(item.effect),
      unit: item.unit,
      why: item.why,
      decision: item.decision,
      note: item.note || null,
    })),
    managementFee: {
      ratePct: review.mgmtFee.rate,
      base: round(review.mgmtFee.base),
      recalculated: round(review.mgmtFee.recalculated),
      administrator: round(review.mgmtFee.admin),
      difference: round(review.mgmtFee.difference),
      differencePct: round(review.mgmtFee.differencePct),
      impliedBase: round(review.mgmtFee.impliedBase),
      segments: review.mgmtFee.segments.map((segment) => ({ from: segment.from, to: segment.to, share: round(segment.share), ratePct: segment.ratePct, basis: segment.basis, base: round(segment.base) })),
    },
    performanceFee: {
      ready: review.perfFee.ready,
      contributions: round(review.perfFee.contributions),
      distributions: round(review.perfFee.distributions),
      nav: round(review.perfFee.nav),
      profit: round(review.perfFee.profit),
      hurdle: round(review.perfFee.hurdle),
      excess: round(review.perfFee.excess),
      recalculated: round(review.perfFee.carry),
      administrator: round(review.perfFee.admin),
      prefPct: review.perfFee.prefPct,
      carryPct: review.perfFee.carryPct,
      catchUpPct: review.perfFee.catchUpPct,
    },
    drift: review.drift
      .filter((row) => row.flagged)
      .map((row) => ({ id: row.id, label: row.label, prior: round(row.prior), current: round(row.current), change: round(row.change), changePct: round(row.changePct), explained: row.explained })),
    steps: review.steps.map((step) => ({ key: step.key, name: step.name, owner: step.owner, due: step.due, state: step.state, overdue: step.overdue, detail: step.detail, rule: step.rule })),
    notesOnFile: review.closeNotes ?? null,
  };
}

/** The NAV pack, part by part, with each part's own figures. Lists are capped, largest first where order matters. */
function packDigest(review: Review) {
  const pack = review.pack;
  return {
    parts: pack.components.map((part) => ({ part: part.key, label: part.label, expected: part.expected, required: part.required, onFile: part.onFile, status: part.status, detail: part.detail, owner: part.owner })),
    bridge: {
      opening: round(pack.bridge.opening),
      steps: pack.bridge.steps.map((step) => ({ step: step.label, amount: round(step.amount) })),
      closing: round(pack.bridge.closing), reported: round(pack.bridge.reported), difference: round(pack.bridge.difference),
    },
    trialBalance: pack.trialBalance,
    capitalAccounts: pack.capitalAccounts
      ? {
        investors: pack.capitalAccounts.investors,
        totals: pack.capitalAccounts.totals,
        notRolling: pack.capitalAccounts.rows.filter((row) => row.difference != null && Math.abs(row.difference) >= 5).slice(0, 25).map((row) => ({ investor: row.name, closing: round(row.closing), rolled: round(row.rolled), difference: round(row.difference) })),
        feesOff: pack.capitalAccounts.rows.filter((row) => row.feeCharged != null && row.feeRecalculated != null && Math.abs(row.feeCharged - row.feeRecalculated) > Math.max(1000, Math.abs(row.feeRecalculated) * 0.005)).slice(0, 25)
          .map((row) => ({ investor: row.name, charged: round(row.feeCharged), recalculated: round(row.feeRecalculated) })),
        accounts: pack.capitalAccounts.rows.slice(0, 40).map((row) => ({ investor: row.name, gp: row.isGp, opening: round(row.opening), contributions: round(row.contributions), distributions: round(row.distributions), pnl: round(row.pnl), carry: round(row.carry), closing: round(row.closing), commitment: round(row.commitment), unfunded: round(row.unfunded), ownershipPct: row.ownershipPct })),
      }
      : null,
    fees: { allocation: pack.fees.allocation, stepDown: pack.fees.stepDown, chargedToInvestors: round(pack.fees.charged), investorsRecalculated: pack.fees.perInvestor },
    waterfall: pack.waterfall
      ? { basis: pack.waterfall.basis, tiers: pack.waterfall.tiers.map((tier) => ({ tier: tier.label, amount: round(tier.total), toLimitedPartners: round(tier.lp), toGp: round(tier.gp) })), carry: round(pack.waterfall.carry), gpCarryOnFile: round(pack.waterfall.gpCarryOnFile) }
      : null,
    valuation: pack.valuation
      ? {
        total: round(pack.valuation.total), supported: round(pack.valuation.supported), coveragePct: round(pack.valuation.coveragePct), requiredPct: pack.valuation.requiredPct, thirdPartyPct: round(pack.valuation.thirdPartyPct),
        unsupported: pack.valuation.unsupported.slice(0, 25).map((row) => ({ position: row.name, fairValue: round(row.fairValue) })),
        unsupportedCount: pack.valuation.unsupported.length,
        outsideSupport: pack.valuation.outside.slice(0, 25).map((row) => ({ position: row.name, fairValue: round(row.fairValue), low: round(row.low), high: round(row.high), concluded: round(row.concluded), source: row.source })),
      }
      : null,
    capitalActivity: pack.capitalActivity
      ? { ...pack.capitalActivity, pending: pack.capitalActivity.pending.slice(0, 20).map((row) => ({ notice: row.name, date: row.date, amount: round(row.amount) })) }
      : null,
    commitments: pack.commitments,
    fx: pack.fx,
  };
}

const DEFAULT_ROWS = 40;

function page<T>(rows: T[], offset: number, limit: number): { rows: T[]; more: number } {
  const start = Math.max(0, Math.trunc(offset) || 0);
  const size = Math.max(1, Math.trunc(limit) || DEFAULT_ROWS);
  return { rows: rows.slice(start, start + size), more: Math.max(0, rows.length - start - size) };
}

/** The position reconciliation: the roll-forward by position, its ties to the statements, marks, and accruals. */
export function positionDigest(review: Review, options: { offset?: number; limit?: number } = {}) {
  const { roll } = review;
  const keys = roll.columns.map((column) => column.key);
  const named = (values: Array<number | null>) => Object.fromEntries(keys.map((key, index) => [key, round(values[index])]));
  const positions = roll.rows.filter((row) => !row.header);
  const shown = page(positions, options.offset ?? 0, options.limit ?? DEFAULT_ROWS);
  const flaggedMarks = review.marks.filter((mark) => mark.flagged);
  return {
    ...header(review),
    rollForwardOnFile: roll.present,
    tiesToStatements: roll.tied,
    ties: roll.ties.map((tie) => ({
      line: tie.line,
      rollForward: round(tie.rollforward),
      statement: round(tie.statement),
      difference: tie.statement == null ? null : round(tie.rollforward - tie.statement),
      result: tie.result,
    })),
    columns: roll.columns.map((column) => ({ key: column.key, label: column.label, group: column.group })),
    positionCount: positions.length,
    positions: shown.rows.map((row) => ({ positionId: row.id, name: row.name, group: row.group, ...named(row.values) })),
    positionsNotShown: shown.more,
    totals: named(roll.total),
    statementTotals: named(roll.statement),
    marksFlagged: flaggedMarks.length,
    marks: review.marks.map((mark) => ({
      itemId: `pos:${mark.id}`,
      positionId: mark.id,
      name: mark.name,
      administratorMark: mark.admin,
      agentMark: mark.agent,
      differencePts: round(mark.difference),
      navEffect: round(mark.effect),
      flagged: mark.flagged,
    })),
    accruals: review.accruals.map((row) => ({ positionId: row.id, name: row.name, administrator: round(row.admin), ours: round(row.ours), difference: round(row.difference) })),
  };
}

/** The cash reconciliation: the tie-out, pairs the rules propose, and what is still unmatched on each side. */
export function cashDigest(rec: CashRec, options: { offset?: number; limit?: number } = {}) {
  const flowById = new Map(rec.flows.map((flow) => [flow.id, flow]));
  const txnById = new Map(rec.transactions.map((txn) => [txn.id, txn]));
  const flowRow = (flow: CashRec['flows'][number]) => ({
    flowId: flow.id,
    code: flow.code,
    date: flow.date,
    amount: flow.amount,
    type: flow.type,
    position: flow.positionName,
    name: flow.name,
  });
  const txnRow = (txn: CashRec['transactions'][number]) => ({
    bankTxnId: txn.id,
    code: txn.code,
    date: txn.date,
    amount: txn.amount,
    account: txn.accountName,
    description: txn.description,
    counterparty: txn.counterparty,
    reference: txn.reference,
  });
  const proposed = rec.matches.filter((match) => match.status === 'PROPOSED');
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_ROWS;
  const shownMatches = page(proposed, offset, limit);
  const openFlows = page(rec.flows.filter((flow) => flow.status === 'OPEN'), offset, limit);
  const openTxns = page(rec.transactions.filter((txn) => txn.status === 'OPEN'), offset, limit);
  return {
    fund: { id: rec.fundId, code: rec.fundCode, name: rec.fundName },
    periodEnd: rec.periodEnd,
    priorPeriodEnd: rec.priorPeriodEnd,
    tied: rec.summary.tied,
    summary: rec.summary,
    /** The single entry that would clear the residual, when there is one. Posting it explains nothing; it needs a reason. */
    clearingAdjustment: rec.summary.tied ? null : clearingAdjustment(rec.summary.residual),
    accounts: rec.accounts.map((account) => ({ id: account.id, code: account.code, name: account.name, bank: account.bankName })),
    rules: rec.rules.map((rule) => ({ kind: rule.kind, name: rule.name, priority: rule.priority, enabled: rule.enabled, dateDays: rule.dateDays, amountTolerance: rule.amountTolerance, maxItems: rule.maxItems })),
    proposedMatches: shownMatches.rows.map((match) => ({
      rule: match.kind,
      ruleName: match.ruleName,
      confidence: match.confidence,
      variance: round(match.variance),
      bankTxnId: match.bankTxnId,
      flowIds: match.flowIds,
      bank: txnById.has(match.bankTxnId) ? txnRow(txnById.get(match.bankTxnId)!) : null,
      flows: match.flowIds.map((id) => flowById.get(id)).filter((flow): flow is CashRec['flows'][number] => Boolean(flow)).map(flowRow),
    })),
    proposedMatchesNotShown: shownMatches.more,
    approvedMatches: rec.matches.filter((match) => match.status === 'APPROVED').length,
    openCashFlows: openFlows.rows.map(flowRow),
    openCashFlowsNotShown: openFlows.more,
    openBankTransactions: openTxns.rows.map(txnRow),
    openBankTransactionsNotShown: openTxns.more,
    adjustments: rec.adjustments.map((adjustment) => ({ id: adjustment.id, amount: adjustment.amount, side: adjustment.side, reason: adjustment.reason, status: adjustment.status })),
  };
}
