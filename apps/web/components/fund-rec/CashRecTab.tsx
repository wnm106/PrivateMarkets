'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { domainHref } from '@/lib/domain-routes';
import {
  CASH_RULE_CONFIDENCE, bankLagDays, cashMoney, cashTypeLabel, clearingAdjustment, moveCashRule, shiftBusinessDays,
  type AdjustmentSide, type CashRec, type CashRule,
} from '@/lib/cash-rec';
import { longDate, type RecBind } from '@/lib/fund-rec';
import { RecBit, RecCell } from './RecInspect';

/** The stored attribute a cash figure is read from, for the right-click sources panel. */
function src(entityId: string, entityName: string, domainCode: string, code: string, name: string, dataType = ''): RecBind[] {
  return [{ entityId, entityName, domainCode, code, name, dataType }];
}

const txnSrc = (txn: { id: string; description?: string | null; code: string }, code: string, name: string, dataType = '') => (
  src(txn.id, txn.description || txn.code, 'BANK_TRANSACTION', code, name, dataType)
);
const flowSrc = (flow: { id: string; positionName?: string | null; name: string }, code: string, name: string, dataType = '') => (
  src(flow.id, flow.positionName || flow.name, 'CASH_FLOW', code, name, dataType)
);

type StatusFilter = 'ALL' | 'OPEN' | 'PROPOSED' | 'APPROVED';

const STATUS_FILTERS: Array<[StatusFilter, string]> = [['ALL', 'All'], ['OPEN', 'Open'], ['PROPOSED', 'Proposed'], ['APPROVED', 'Approved']];
const STATUS_LABEL: Record<string, string> = { OPEN: 'Open', PROPOSED: 'Proposed', APPROVED: 'Approved' };

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sorted = [...left].sort();
  return [...right].sort().every((id, index) => id === sorted[index]);
}

function tone(status: string): string {
  if (status === 'APPROVED') return 'ok';
  if (status === 'PROPOSED') return 'near';
  return 'na';
}

function rowTone(status: string): string {
  if (status === 'APPROVED') return 'approved';
  if (status === 'PROPOSED') return 'proposed';
  return '';
}

/** Chip colour for a cash flow type. Income is green, capital returned blue, fees amber, cash out red. */
function typeTone(type: string): string {
  const key = type.toUpperCase();
  if (/INTEREST|INCOME|DIVIDEND/.test(key)) return 'income';
  if (/FEE/.test(key)) return 'fee';
  if (/CALL|PURCHASE|FUNDING|DRAW|LEVERAGE/.test(key)) return 'out';
  if (/DISTRIBUTION|PRINCIPAL|REPAY|SALE|PROCEEDS/.test(key)) return 'return';
  return 'other';
}

function hit(query: string, ...fields: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

function total(rows: Array<{ amount: number }>): number {
  return Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
}

export function CashRecTab({
  cash,
  busy,
  locked,
  fundHref,
  onApprove,
  onPair,
  onUnmatch,
  onAdjust,
  onRules,
}: {
  cash: CashRec;
  busy: boolean;
  /** Why nothing here can be changed: the close is certified. Null when it can. */
  locked: string | null;
  /** The fund record, where bank accounts are added. */
  fundHref: string;
  onApprove: (bankTxnId: string) => Promise<void>;
  onPair: (bankTxnId: string, flowIds: string[]) => Promise<void>;
  onUnmatch: (matchId: string) => Promise<void>;
  onAdjust: (amount: number, side: AdjustmentSide, reason: string) => Promise<void>;
  onRules: (rules: CashRule[]) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [txnSearch, setTxnSearch] = useState('');
  const [flowSearch, setFlowSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [approvingAll, setApprovingAll] = useState(false);

  useEffect(() => {
    setSelectedId(null);
    setChecked([]);
  }, [cash.periodEnd, cash.fundId]);

  const summary = cash.summary;
  const frozen = busy || approvingAll || Boolean(locked);
  const lagDays = bankLagDays(cash.rules);
  const bankThrough = shiftBusinessDays(cash.periodEnd, lagDays);
  const txnById = useMemo(() => new Map(cash.transactions.map((txn) => [txn.id, txn])), [cash.transactions]);
  const flowById = useMemo(() => new Map(cash.flows.map((flow) => [flow.id, flow])), [cash.flows]);
  const selected = selectedId ? txnById.get(selectedId) ?? null : null;

  const visibleTxns = cash.transactions.filter((txn) => {
    if (accountId && txn.accountId !== accountId) return false;
    if (status !== 'ALL' && txn.status !== status) return false;
    return hit(txnSearch, txn.description, txn.accountName, txn.counterparty, txn.reference, txn.date, String(txn.amount));
  });
  const visibleFlows = cash.flows.filter((flow) => {
    if (status !== 'ALL' && flow.status !== status) return false;
    return hit(flowSearch, flow.positionName, flow.name, cashTypeLabel(flow.type), flow.date, String(flow.amount));
  });

  const proposals = useMemo(() => cash.matches
    .filter((match) => match.status === 'PROPOSED')
    .flatMap((match) => {
      const txn = txnById.get(match.bankTxnId);
      const flows = match.flowIds.flatMap((id) => flowById.get(id) ?? []);
      return txn && flows.length ? [{ match, txn, flows }] : [];
    })
    .sort((left, right) => right.txn.date.localeCompare(left.txn.date)), [cash.matches, txnById, flowById]);
  const proposedAmount = Math.round(proposals.reduce((sum, row) => sum + row.match.bankAmount, 0) * 100) / 100;

  const selectTxn = (id: string) => {
    if (id === selectedId) { setSelectedId(null); setChecked([]); return; }
    setSelectedId(id);
    setChecked(txnById.get(id)?.flowIds ?? []);
  };

  const toggleFlow = (id: string) => {
    if (!selected || selected.status === 'APPROVED' || frozen) return;
    setChecked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const approveAll = async () => {
    setApprovingAll(true);
    try {
      for (const row of proposals) await onApprove(row.txn.id);
    } finally {
      setApprovingAll(false);
    }
  };

  const proposedSame = selected?.status === 'PROPOSED' && sameIds(checked, selected.flowIds);
  const canApprove = Boolean(selected && proposedSame && !frozen);
  const canPair = Boolean(selected && selected.status !== 'APPROVED' && checked.length > 0 && !proposedSame && !frozen);
  const canUnmatch = Boolean(selected?.status === 'APPROVED' && selected.matchId && !frozen);
  const checkedAmount = total(checked.flatMap((id) => flowById.get(id) ?? []));
  const pairGap = selected ? Math.round((selected.amount - checkedAmount) * 100) / 100 : 0;
  const clearing = clearingAdjustment(summary.residual);
  const txnCount = cash.transactions.length;
  const completion = txnCount ? Math.round((summary.approvedCount / txnCount) * 100) : 0;

  const move = (ruleId: string, direction: -1 | 1) => {
    const next = moveCashRule(cash.rules, ruleId, direction);
    if (next !== cash.rules && next.map((rule) => rule.id).join() !== cash.rules.map((rule) => rule.id).join()) {
      void onRules(next);
    }
  };

  return (
    <div className="cr">
      <div className="da-ribbon" aria-label="Cash reconciliation summary">
        <div className="da-facts five cr-facts">
          <div className="da-fact"><span>Open bank transactions</span><strong>{summary.openTxnCount}</strong><small>{cashMoney(summary.openTxnAmount)} outstanding</small></div>
          <div className="da-fact"><span>Open cash flows</span><strong>{summary.openFlowCount}</strong><small>{cashMoney(summary.openFlowAmount)} outstanding</small></div>
          <div className="da-fact"><span>Pending review</span><strong className={summary.proposedCount ? 'warn' : ''}>{summary.proposedCount}</strong><small>{summary.proposedCount ? `${cashMoney(proposedAmount)} proposed by rules` : 'Nothing waiting'}</small></div>
          <div className="da-fact">
            <span>Completion</span><strong>{completion}%</strong>
            <div className="da-bar"><i style={{ width: `${completion}%` }} /></div>
            <small>{summary.approvedCount} of {txnCount} bank transactions approved</small>
          </div>
          <div className="da-fact"><span>Tie-out</span><strong className={summary.tied ? 'up' : 'dn'}>{summary.tied ? 'Tied' : cashMoney(summary.residual)}</strong><small>{summary.tied ? 'Position book equals the bank' : 'Position book minus bank'}</small></div>
        </div>
      </div>

      {locked && <div className="cert-banner cert-warn"><span><strong>Read only.</strong> {locked}</span></div>}
      <p className="da-note cr-scope">
        In this period: position cash flows dated after {longDate(cash.priorPeriodEnd)} up to {longDate(cash.periodEnd)}, and bank transactions in the same dates
        or up to {lagDays} business days after, through {longDate(bankThrough)}, so a late settlement can be paired. Non-cash flows stay on the roll-forward. Money leaving the fund is negative.
      </p>

      <div className="cr-controls">
        <div className="cr-seg" role="group" aria-label="Status">
          {STATUS_FILTERS.map(([key, label]) => (
            <button key={key} type="button" className={status === key ? 'on' : ''} aria-pressed={status === key} onClick={() => setStatus(key)}>{label}</button>
          ))}
        </div>
        <div className={`cr-pick ${selected ? 'on' : ''}`} aria-live="polite">
          {selected ? (
            <>
              <span className="cr-pickname"><b>{selected.description || selected.code}</b><small>{selected.date} · {selected.accountName}</small></span>
              <span className="cr-pickfig">Bank<b>{cashMoney(selected.amount)}</b></span>
              <span className="cr-pickfig">{checked.length} cash flow{checked.length === 1 ? '' : 's'}<b>{cashMoney(checkedAmount)}</b></span>
              <span className="cr-pickfig">Difference<b className={Math.abs(pairGap) < 0.01 ? 'zero' : 'neg'}>{cashMoney(pairGap)}</b></span>
              <span className="cr-pickacts">
                {canApprove && <button type="button" className="btn btn-sm btn-primary" onClick={() => void onApprove(selected.id)}>Approve match</button>}
                {canPair && <button type="button" className="btn btn-sm btn-primary" onClick={() => void onPair(selected.id, checked)}>Pair {checked.length} cash flow{checked.length === 1 ? '' : 's'}</button>}
                {canUnmatch && <button type="button" className="btn btn-sm" onClick={() => selected.matchId && void onUnmatch(selected.matchId)}>Unmatch</button>}
                <button type="button" className="btn btn-sm" onClick={() => { setSelectedId(null); setChecked([]); }}>Clear</button>
              </span>
              <small className="cr-pickhint">
                {selected.status === 'APPROVED' ? 'This pair is approved. Unmatch it to pair the transaction again.'
                  : proposedSame ? `Proposed by the rule "${selected.ruleName}". Approve it, or change the ticks to pair it another way.`
                  : !checked.length ? 'Tick the cash flows that settle this transaction.'
                  : Math.abs(pairGap) >= 0.01 ? 'The difference stays on the pair as its variance. Pairing does not post an adjustment.'
                  : 'The cash flows add up to the bank amount.'}
              </small>
            </>
          ) : (
            <span className="cr-hint">{locked ? 'Select a bank transaction to see the cash flows paired to it.' : 'Select a bank transaction, then tick the cash flows that settle it. Proposed pairs are approved in the review tray below.'}</span>
          )}
        </div>
      </div>

      {!cash.accounts.length && (
        <p className="da-note da-also">This fund has no bank account on file, so there are no bank transactions to pair. Add the account on the <Link className="da-link" href={fundHref}>fund record</Link>, then load its statement in <Link className="da-link" href="/load">Load data</Link>.</p>
      )}
      {cash.accounts.length > 0 && !cash.transactions.length && (
        <p className="da-note da-also">No bank transactions are on file for this period. Load the bank statement in <Link className="da-link" href="/load">Load data</Link>, or wait for its feed; the rules then propose pairs here.</p>
      )}
      {!cash.flows.length && (
        <p className="da-note da-also">No position cash flows are dated in this period. They load with the position book in <Link className="da-link" href="/load">Load data</Link>.</p>
      )}

      <div className="cr-work">
        <section className="cr-panel bank" aria-label="Bank transactions">
          <header className="cr-phead">
            <h2>Bank transactions</h2><i className="cr-n">{visibleTxns.length}</i>
            <div className="cr-tools">
              <select value={accountId} aria-label="Account" onChange={(event) => setAccountId(event.target.value)}>
                <option value="">All accounts</option>
                {cash.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.bankName ? ` · ${account.bankName}` : ''}</option>)}
              </select>
              <input type="search" value={txnSearch} placeholder="Search" aria-label="Search bank transactions" onChange={(event) => setTxnSearch(event.target.value)} />
            </div>
          </header>
          <div className="cr-scroll">
            <table className="cr-grid">
              <thead>
                <tr><th>Date</th><th>Description</th><th className="num">Amount</th><th title="The rule that paired it, or Open when nothing has">Match</th><th className="num" title="Bank amount less the cash flows paired to it. For an open transaction, the whole amount.">Difference</th></tr>
              </thead>
              <tbody>
                {visibleTxns.map((txn) => {
                  const gap = txn.variance == null ? txn.amount : txn.variance;
                  return (
                    <tr key={txn.id} className={`pick ${txn.id === selectedId ? 'sel' : rowTone(txn.status)}`} aria-selected={txn.id === selectedId} onClick={() => selectTxn(txn.id)}>
                      <RecCell className="date" sources={txnSrc(txn, 'BANK_TXN_DATE', 'Date', 'DATE')} display={txn.date}>{txn.date}</RecCell>
                      <RecCell sources={txnSrc(txn, 'BANK_TXN_DESCRIPTION', 'Description')} display={txn.description || txn.code}><Link href={`${domainHref('BANK_TRANSACTION')}/${txn.id}`} onClick={(event) => event.stopPropagation()}>{txn.description || txn.code}</Link><small>{txn.accountName}{txn.counterparty ? <RecBit sources={txnSrc(txn, 'BANK_TXN_COUNTERPARTY', 'Counterparty')} display={txn.counterparty}>{` · ${txn.counterparty}`}</RecBit> : ''}</small></RecCell>
                      <RecCell className="num" sources={txnSrc(txn, 'BANK_TXN_AMOUNT', 'Amount', 'CURRENCY')} display={cashMoney(txn.amount)}>{cashMoney(txn.amount)}</RecCell>
                      <td><span className={`da-st ${tone(txn.status)}`} title={txn.status === 'PROPOSED' ? 'Proposed by this rule. Waiting for approval.' : txn.status === 'APPROVED' ? 'Approved pair' : 'No pair yet'}>{txn.ruleName || 'Open'}</span></td>
                      <td className={`num ${txn.variance == null ? 'muted' : Math.abs(gap) < 0.01 ? 'zero' : 'neg'}`}>{cashMoney(gap)}</td>
                    </tr>
                  );
                })}
                {!visibleTxns.length && <tr><td colSpan={5} className="cr-none">{cash.transactions.length ? 'No bank transactions fit the filters above.' : 'No bank transactions on file for this period.'}</td></tr>}
              </tbody>
            </table>
          </div>
          <footer className="cr-pfoot">
            <div><span>Items</span><b>{visibleTxns.length}</b></div>
            <div><span>Matched</span><b>{visibleTxns.filter((txn) => txn.status !== 'OPEN').length}</b></div>
            <div className="end"><span>Open balance</span><b>{cashMoney(total(visibleTxns.filter((txn) => txn.status === 'OPEN')))}</b></div>
            <div><span>Total</span><b>{cashMoney(total(visibleTxns))}</b></div>
          </footer>
        </section>

        <section className="cr-panel flows" aria-label="Positional cash flows">
          <header className="cr-phead">
            <h2>Positional cash flows</h2><i className="cr-n">{visibleFlows.length}</i>
            <div className="cr-tools">
              <input type="search" value={flowSearch} placeholder="Search" aria-label="Search cash flows" onChange={(event) => setFlowSearch(event.target.value)} />
            </div>
          </header>
          <div className="cr-scroll">
            <table className="cr-grid">
              <thead>
                <tr><th aria-label="Pair" /><th>Date</th><th>Position</th><th>Type</th><th className="num">Amount</th><th>Status</th></tr>
              </thead>
              <tbody>
                {visibleFlows.map((flow) => {
                  const inPair = checked.includes(flow.id);
                  const taken = flow.status === 'APPROVED' && flow.bankTxnId !== selectedId;
                  const jump = flow.bankTxnId && flow.bankTxnId !== selectedId ? flow.bankTxnId : null;
                  return (
                    <tr
                      key={flow.id}
                      className={`${jump ? 'pick ' : ''}${inPair ? 'sel' : rowTone(flow.status)}`}
                      title={jump ? 'Show the bank transaction this is paired to' : undefined}
                      onClick={jump ? () => selectTxn(jump) : undefined}
                    >
                      <td className="chk"><input type="checkbox" checked={inPair} disabled={!selected || selected.status === 'APPROVED' || taken || frozen} aria-label={`Pair ${flow.positionName || flow.name}`} onClick={(event) => event.stopPropagation()} onChange={() => toggleFlow(flow.id)} /></td>
                      <RecCell className="date" sources={flowSrc(flow, 'CASHFLOW_DATE', 'Date', 'DATE')} display={flow.date}>{flow.date}</RecCell>
                      <td><Link href={`${domainHref('CASH_FLOW')}/${flow.id}`} onClick={(event) => event.stopPropagation()}>{flow.positionName || flow.name}</Link></td>
                      <RecCell sources={flowSrc(flow, 'CASHFLOW_TYPE', 'Type')} display={cashTypeLabel(flow.type)}><span className={`cr-type ${typeTone(flow.type)}`}>{cashTypeLabel(flow.type)}</span></RecCell>
                      <RecCell className="num" sources={flowSrc(flow, 'AMOUNT', 'Amount', 'CURRENCY')} display={cashMoney(flow.amount)}>{cashMoney(flow.amount)}</RecCell>
                      <td><span className={`da-st ${tone(flow.status)}`}>{STATUS_LABEL[flow.status]}</span></td>
                    </tr>
                  );
                })}
                {!visibleFlows.length && <tr><td colSpan={6} className="cr-none">{cash.flows.length ? 'No positional cash flows fit the filters above.' : 'No positional cash flows dated in this period.'}</td></tr>}
              </tbody>
            </table>
          </div>
          <footer className="cr-pfoot">
            <div><span>Items</span><b>{visibleFlows.length}</b></div>
            <div><span>Matched</span><b>{visibleFlows.filter((flow) => flow.status !== 'OPEN').length}</b></div>
            <div className="end"><span>Open balance</span><b>{cashMoney(total(visibleFlows.filter((flow) => flow.status === 'OPEN')))}</b></div>
            <div><span>Total</span><b>{cashMoney(total(visibleFlows))}</b></div>
          </footer>
        </section>
      </div>

      <section className="cr-panel cr-tray" aria-label="Review tray">
        <header className="cr-phead">
          <h2>Review tray</h2>
          <span className={`da-st ${proposals.length ? 'near' : 'ok'}`}>{proposals.length ? `${proposals.length} match${proposals.length === 1 ? '' : 'es'} pending approval` : 'Nothing pending'}</span>
          {proposals.length > 0 && <span className="cr-ready">{cashMoney(proposedAmount)} ready to settle</span>}
          <div className="cr-tools">
            <button type="button" className="btn btn-sm btn-primary" disabled={frozen || !proposals.length} onClick={() => void approveAll()}>{approvingAll ? 'Approving…' : 'Approve all'}</button>
          </div>
        </header>
        {proposals.length > 0 ? (
          <div className="cr-scroll tray">
            <table className="cr-grid">
              <thead>
                <tr>
                  <th aria-label="Actions" /><th>Bank transaction</th><th>Bank date</th><th className="num">Bank amount</th><th>Rule</th>
                  <th>Cash flow</th><th>Type</th><th>Flow date</th><th className="num">Flow amount</th><th className="num">Difference</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map(({ match, txn, flows }) => flows.map((flow, index) => {
                  const span = index === 0 ? flows.length : 0;
                  return (
                    <tr key={`${match.id}:${flow.id}`} className={`${index === 0 ? 'lead' : 'more'} ${txn.id === selectedId ? 'sel' : ''}`}>
                      {span > 0 && <td rowSpan={span} className="act"><button type="button" className="btn btn-sm btn-primary" disabled={frozen} onClick={() => void onApprove(txn.id)}>Approve</button></td>}
                      {span > 0 && <td rowSpan={span}><button type="button" className="cr-link" onClick={() => selectTxn(txn.id)}>{txn.description || txn.code}</button><small>{txn.accountName}{txn.counterparty ? ` · ${txn.counterparty}` : ''}</small></td>}
                      {span > 0 && <td rowSpan={span} className="date"><RecBit sources={txnSrc(txn, 'BANK_TXN_DATE', 'Date', 'DATE')} display={txn.date}>{txn.date}</RecBit></td>}
                      {span > 0 && <td rowSpan={span} className="num"><RecBit sources={txnSrc(txn, 'BANK_TXN_AMOUNT', 'Amount', 'CURRENCY')} display={cashMoney(match.bankAmount)}>{cashMoney(match.bankAmount)}</RecBit></td>}
                      {span > 0 && <td rowSpan={span}><span className="cr-rule">{match.ruleName}</span><small>{match.confidence}% confidence</small></td>}
                      <td><Link href={`${domainHref('CASH_FLOW')}/${flow.id}`}>{flow.positionName || flow.name}</Link></td>
                      <RecCell sources={flowSrc(flow, 'CASHFLOW_TYPE', 'Type')} display={cashTypeLabel(flow.type)}><span className={`cr-type ${typeTone(flow.type)}`}>{cashTypeLabel(flow.type)}</span></RecCell>
                      <RecCell className="date" sources={flowSrc(flow, 'CASHFLOW_DATE', 'Date', 'DATE')} display={flow.date}>{flow.date}</RecCell>
                      <RecCell className="num" sources={flowSrc(flow, 'AMOUNT', 'Amount', 'CURRENCY')} display={cashMoney(flow.amount)}>{cashMoney(flow.amount)}</RecCell>
                      {span > 0 && <td rowSpan={span} className={`num ${Math.abs(match.variance) < 0.01 ? 'zero' : 'neg'}`}>{cashMoney(match.variance)}</td>}
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cr-none">{summary.openTxnCount ? 'The rules have no proposed pairs waiting. Pair what is left by hand above.' : 'The rules have no proposed pairs waiting, and no bank transaction is open.'}</p>
        )}
      </section>

      <div className="cr-lower">
        <section className="cr-panel" aria-label="Tie-out">
          <header className="cr-phead">
            <h2>Tie-out</h2>
            <span className={`da-st ${summary.tied ? 'ok' : 'breach'}`}>{summary.tied ? 'Tied' : `${cashMoney(summary.residual)} apart`}</span>
          </header>
          <div className="cr-body">
            <p className="da-note">Position cash plus position adjustments must equal bank activity plus bank adjustments. Pairing does not change these totals; it shows which items explain them. What is left apart is the open items on each side and the differences kept on pairs.</p>
            <table className="cr-grid cr-tie">
              <thead>
                <tr><th /><th className="num">Position book</th><th className="num">Bank</th></tr>
              </thead>
              <tbody>
                <tr><td>Cash in the period</td><td className="num">{cashMoney(summary.positionTotal)}</td><td className="num">{cashMoney(summary.bankTotal)}</td></tr>
                <tr className="of"><td>of which paired, proposed or approved</td><td className="num">{cashMoney(summary.matchedFlowAmount)}</td><td className="num">{cashMoney(summary.matchedBankAmount)}</td></tr>
                <tr><td>Plus adjustments</td><td className="num">{cashMoney(summary.positionAdjustments)}</td><td className="num">{cashMoney(summary.bankAdjustments)}</td></tr>
                <tr className="net"><td>After adjustments</td><td className="num">{cashMoney(summary.positionTied)}</td><td className="num">{cashMoney(summary.bankTied)}</td></tr>
                <tr><td>Position book less bank</td><td className={`num ${summary.tied ? 'zero' : 'neg'}`} colSpan={2}>{summary.tied ? 'Tied' : cashMoney(summary.residual)}</td></tr>
              </tbody>
            </table>
            {cash.adjustments.length > 0 && (
              <table className="da-mini">
                <tbody>
                  {cash.adjustments.map((item) => (
                    <tr key={item.id}>
                      <RecCell sources={src(item.id, item.reason, 'CASH_ADJUSTMENT', 'ADJ_REASON', 'Reason')} display={item.reason}><Link href={`${domainHref('CASH_ADJUSTMENT')}/${item.id}`}>{item.reason}</Link><small><RecBit sources={src(item.id, item.reason, 'CASH_ADJUSTMENT', 'ADJ_SIDE', 'Side')} display={item.side}>{item.side === 'BANK' ? 'Bank' : 'Position book'}</RecBit></small></RecCell>
                      <RecCell className="num" sources={src(item.id, item.reason, 'CASH_ADJUSTMENT', 'ADJ_AMOUNT', 'Amount', 'CURRENCY')} display={cashMoney(item.amount)}>{cashMoney(item.amount)}</RecCell>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {locked
              ? <p className="da-note">{locked}</p>
              : <AdjustmentForm key={`${cash.periodEnd}:${summary.residual}:${cash.adjustments.length}`} busy={frozen} clearing={clearing} onAdjust={onAdjust} />}
          </div>
        </section>

        <section className="cr-panel" aria-label="Match rules">
          <header className="cr-phead">
            <h2>Match rules</h2>
            <span className="cr-ready muted">Top to bottom. The first rule that fits a bank transaction wins. A change re-runs the proposals; approved pairs stay.</span>
          </header>
          <table className="cr-grid cr-rules">
            <thead>
              <tr><th>#</th><th>Rule</th><th>Window</th><th className="num" title="How sure a pair proposed by this rule is. A looser rule is a weaker match.">Confidence</th><th>On</th><th aria-label="Reorder" /></tr>
            </thead>
            <tbody>
              {cash.rules.map((rule, index) => (
                <tr key={rule.id} className={rule.enabled ? '' : 'approved'}>
                  <td className="date">{index + 1}</td>
                  <td>{rule.name}<small>{ruleDetail(rule)}</small></td>
                  <td>{rule.dateDays ? `${rule.dateDays} business day${rule.dateDays === 1 ? '' : 's'}` : 'Same date'}{rule.amountTolerance > 0.01 ? ` · ${cashMoney(rule.amountTolerance)}` : ''}</td>
                  <td className="num">{CASH_RULE_CONFIDENCE[rule.kind]}%</td>
                  <td><input type="checkbox" checked={rule.enabled} disabled={frozen} aria-label={`${rule.name} enabled`} onChange={(event) => {
                    void onRules(cash.rules.map((item) => item.id === rule.id ? { ...item, enabled: event.target.checked } : item));
                  }} /></td>
                  <td className="act">
                    <button type="button" className="btn btn-sm" disabled={frozen || index === 0} aria-label={`Move ${rule.name} up`} onClick={() => move(rule.id, -1)}>↑</button>{' '}
                    <button type="button" className="btn btn-sm" disabled={frozen || index === cash.rules.length - 1} aria-label={`Move ${rule.name} down`} onClick={() => move(rule.id, 1)}>↓</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function ruleDetail(rule: CashRule): string {
  if (rule.kind === 'EXACT') return 'Same date and the same amount to the cent.';
  if (rule.kind === 'DATE_DELAY') return 'Same amount, and the dates are business days apart.';
  if (rule.kind === 'DOLLAR_VARIANCE') return 'Same date, amounts inside the tolerance.';
  if (rule.kind === 'DATE_VARIANCE') return 'Same amount, inside the business-day window.';
  if (rule.kind === 'MULTI_POSITION') return 'Cash flows on one position that sum to the bank transaction.';
  if (rule.kind === 'MULTI') return 'Cash flows from any positions that sum to the bank transaction.';
  return 'Paired by hand.';
}

function AdjustmentForm({
  busy, clearing, onAdjust,
}: {
  busy: boolean;
  clearing: { amount: number; side: AdjustmentSide } | null;
  onAdjust: (amount: number, side: AdjustmentSide, reason: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState(clearing ? String(clearing.amount) : '');
  const [side, setSide] = useState<AdjustmentSide>(clearing?.side ?? 'BANK');
  const [reason, setReason] = useState('');
  return (
    <form className="da-editor cr-adjust" onSubmit={(event) => { event.preventDefault(); void onAdjust(Number(amount), side, reason); }}>
      <p className="da-note">
        {clearing
          ? `${cashMoney(clearing.amount)} on the ${clearing.side === 'BANK' ? 'bank' : 'position book'} side would close the gap. Post it only when you know what the difference is, and say so in the reason.`
          : 'The books tie. Post an adjustment only if a later item needs one.'}
        {' '}Bank side: an item the bank has not shown yet, such as a deposit in transit. Position book side: cash the bank shows that is missing from our book, such as a bank fee.
      </p>
      <label className="amt">Amount <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
      <label className="side">Side <select value={side} onChange={(event) => setSide(event.target.value as AdjustmentSide)}><option value="BANK">Bank</option><option value="POSITION">Position book</option></select></label>
      <label className="why">Reason <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="What the difference is, and the evidence for it" /></label>
      <button type="submit" className="btn btn-sm" disabled={busy}>Post adjustment</button>
    </form>
  );
}
