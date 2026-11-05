'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { domainHref } from '@/lib/domain-routes';
import { cashMoney, cashTypeLabel, clearingAdjustment, moveCashRule, type AdjustmentSide, type CashRec, type CashRule } from '@/lib/cash-rec';

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

export function CashRecTab({
  cash,
  busy,
  onApprove,
  onPair,
  onUnmatch,
  onAdjust,
  onRules,
}: {
  cash: CashRec;
  busy: boolean;
  onApprove: (bankTxnId: string) => Promise<void>;
  onPair: (bankTxnId: string, flowIds: string[]) => Promise<void>;
  onUnmatch: (matchId: string) => Promise<void>;
  onAdjust: (amount: number, side: AdjustmentSide, reason: string) => Promise<void>;
  onRules: (rules: CashRule[]) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState('');
  const [status, setStatus] = useState('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);

  useEffect(() => {
    setSelectedId(null);
    setChecked([]);
  }, [cash.periodEnd, cash.fundId]);

  const selected = cash.transactions.find((txn) => txn.id === selectedId) ?? null;
  const visibleTxns = cash.transactions.filter((txn) => {
    if (accountId && txn.accountId !== accountId) return false;
    if (status !== 'ALL' && txn.status !== status) return false;
    return true;
  });
  const visibleFlows = cash.flows.filter((flow) => status === 'ALL' || flow.status === status);
  const selectedFlowIds = useMemo(() => new Set(selected?.flowIds ?? []), [selected]);

  const selectTxn = (id: string) => {
    const txn = cash.transactions.find((row) => row.id === id);
    setSelectedId(id);
    setChecked(txn?.flowIds ?? []);
  };

  const toggleFlow = (id: string) => {
    if (!selected || selected.status === 'APPROVED') return;
    setChecked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const proposedSame = selected?.status === 'PROPOSED' && sameIds(checked, selected.flowIds);
  const canApprove = Boolean(selected && proposedSame && !busy);
  const canPair = Boolean(selected && selected.status !== 'APPROVED' && checked.length > 0 && !proposedSame && !busy);
  const canUnmatch = Boolean(selected?.status === 'APPROVED' && selected.matchId && !busy);
  const clearing = clearingAdjustment(cash.summary.residual);
  const summary = cash.summary;

  const move = (ruleId: string, direction: -1 | 1) => {
    const next = moveCashRule(cash.rules, ruleId, direction);
    if (next !== cash.rules && next.map((rule) => rule.id).join() !== cash.rules.map((rule) => rule.id).join()) {
      void onRules(next);
    }
  };

  return (
    <div className="da-sec">
      <div className="da-ribbon" aria-label="Cash reconciliation summary">
        <div className="da-facts five">
          <div className="da-fact"><span>Outstanding positional cash</span><strong>{cashMoney(summary.openFlowAmount)}</strong><small>{summary.openFlowCount} cash flow{summary.openFlowCount === 1 ? '' : 's'}</small></div>
          <div className="da-fact"><span>Outstanding bank</span><strong>{cashMoney(summary.openTxnAmount)}</strong><small>{summary.openTxnCount} transaction{summary.openTxnCount === 1 ? '' : 's'}</small></div>
          <div className="da-fact"><span>Matched</span><strong>{cashMoney(summary.matchedBankAmount)}</strong><small>{summary.approvedCount} approved · {summary.proposedCount} proposed</small></div>
          <div className="da-fact"><span>Adjustments</span><strong>{cashMoney(summary.positionAdjustments + summary.bankAdjustments)}</strong><small>{cash.adjustments.length ? `${cash.adjustments.length} posted` : 'None posted'}</small></div>
          <div className="da-fact"><span>Tie-out</span><strong className={summary.tied ? 'up' : 'dn'}>{summary.tied ? 'Tied' : cashMoney(summary.residual)}</strong><small>{summary.tied ? 'Position book equals the bank' : 'Position book minus bank'}</small></div>
        </div>
      </div>

      <div className="da-sechead" style={{ marginTop: 16 }}>
        <h2>Full reconciliation</h2>
        <p>Positional cash plus position adjustments equals bank activity plus bank adjustments.</p>
      </div>
      <div className="da-gridwrap">
        <table className="da-grid fit">
          <thead>
            <tr><th></th><th className="num">Position book</th><th className="num">Bank</th></tr>
          </thead>
          <tbody>
            <tr><td>Cash in the period</td><td className="num">{cashMoney(summary.positionTotal)}</td><td className="num">{cashMoney(summary.bankTotal)}</td></tr>
            <tr><td>Adjustments</td><td className="num">{cashMoney(summary.positionAdjustments)}</td><td className="num">{cashMoney(summary.bankAdjustments)}</td></tr>
            <tr className="net"><td>Tied balance</td><td className="num">{cashMoney(summary.positionTied)}</td><td className="num">{cashMoney(summary.bankTied)}</td></tr>
          </tbody>
        </table>
      </div>
      {cash.adjustments.length > 0 && (
        <table className="da-mini" style={{ marginTop: 8 }}>
          <tbody>
            {cash.adjustments.map((item) => (
              <tr key={item.id}>
                <td><Link href={`${domainHref('CASH_ADJUSTMENT')}/${item.id}`}>{item.reason}</Link><small>{item.side === 'BANK' ? 'Bank' : 'Position book'}</small></td>
                <td className="num">{cashMoney(item.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <AdjustmentForm key={`${cash.periodEnd}:${summary.residual}:${cash.adjustments.length}`} busy={busy} clearing={clearing} onAdjust={onAdjust} />

      <div className="da-sechead">
        <h2>Match rules</h2>
        <p>Rules run from top to bottom. The first one that fits wins. One bank transaction can take several cash flows.</p>
      </div>
      <div className="da-gridwrap">
        <table className="da-grid fit">
          <thead>
            <tr><th>Order</th><th>Rule</th><th>Window</th><th>On</th><th></th></tr>
          </thead>
          <tbody>
            {cash.rules.map((rule, index) => (
              <tr key={rule.id}>
                <td>{index + 1}</td>
                <td>{rule.name}<small>{ruleDetail(rule)}</small></td>
                <td>{rule.dateDays ? `${rule.dateDays} business day${rule.dateDays === 1 ? '' : 's'}` : 'Same date'}{rule.amountTolerance > 0.01 ? ` · ${cashMoney(rule.amountTolerance)}` : ''}</td>
                <td><input type="checkbox" checked={rule.enabled} disabled={busy} aria-label={`${rule.name} enabled`} onChange={(event) => {
                  void onRules(cash.rules.map((item) => item.id === rule.id ? { ...item, enabled: event.target.checked } : item));
                }} /></td>
                <td>
                  <button type="button" className="btn btn-sm" disabled={busy || index === 0} onClick={() => move(rule.id, -1)}>Up</button>{' '}
                  <button type="button" className="btn btn-sm" disabled={busy || index === cash.rules.length - 1} onClick={() => move(rule.id, 1)}>Down</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="da-sechead">
        <h2>Pair cash to the bank</h2>
        <p>Select a bank transaction, then check the positional cash flows that settle it.</p>
      </div>
      <div className="da-toolbar">
        <label>Account <select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">All accounts</option>{cash.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.bankName ? ` · ${account.bankName}` : ''}</option>)}</select></label>
        <label>Status <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">All</option><option value="OPEN">Open</option><option value="PROPOSED">Proposed</option><option value="APPROVED">Approved</option></select></label>
      </div>
      {!cash.accounts.length && <p className="da-note">This fund has no bank accounts yet. Add one on the fund and its transactions can be matched here.</p>}
      <div className="da-columns">
        <div>
          <div className="da-sechead"><h2>Bank transactions</h2><p>{visibleTxns.length}</p></div>
          <div className="da-gridwrap">
            <table className="da-grid fit">
              <thead>
                <tr><th>Date</th><th>Description</th><th className="num">Amount</th><th className="num">Paired</th><th className="num">Variance</th><th>Rule</th></tr>
              </thead>
              <tbody>
                {visibleTxns.map((txn) => (
                  <tr key={txn.id} className={txn.id === selectedId ? 'sel' : txn.status !== 'OPEN' ? 'par' : ''} onClick={() => selectTxn(txn.id)} style={{ cursor: 'pointer' }}>
                    <td>{txn.date}</td>
                    <td><Link href={`${domainHref('BANK_TRANSACTION')}/${txn.id}`} onClick={(event) => event.stopPropagation()}>{txn.description}</Link><small>{txn.accountName}{txn.counterparty ? ` · ${txn.counterparty}` : ''}</small></td>
                    <td className="num">{cashMoney(txn.amount)}</td>
                    <td className="num">{txn.matchedAmount == null ? '—' : cashMoney(txn.matchedAmount)}</td>
                    <td className="num">{txn.variance == null ? '—' : cashMoney(txn.variance)}</td>
                    <td><span className={`da-st ${tone(txn.status)}`}>{txn.ruleName || 'Open'}</span></td>
                  </tr>
                ))}
                {!visibleTxns.length && <tr><td colSpan={6}>No bank transactions in this period.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="da-sechead">
            <h2>Positional cash flows</h2>
            <p>
              {canApprove && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => selected && void onApprove(selected.id)}>Approve pair</button>}
              {canPair && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => selected && void onPair(selected.id, checked)}>Pair {checked.length}</button>}
              {canUnmatch && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => selected?.matchId && void onUnmatch(selected.matchId)}>Unmatch</button>}
            </p>
          </div>
          <div className="da-gridwrap">
            <table className="da-grid fit">
              <thead>
                <tr><th></th><th>Date</th><th>Position</th><th>Type</th><th className="num">Amount</th><th>Status</th></tr>
              </thead>
              <tbody>
                {visibleFlows.map((flow) => {
                  const inPair = selectedFlowIds.has(flow.id) || checked.includes(flow.id);
                  const locked = flow.status === 'APPROVED' && flow.bankTxnId !== selectedId;
                  return (
                    <tr key={flow.id} className={inPair ? 'sel' : ''}>
                      <td><input type="checkbox" checked={checked.includes(flow.id)} disabled={!selected || selected.status === 'APPROVED' || locked || busy} aria-label={`Pair ${flow.positionName}`} onChange={() => toggleFlow(flow.id)} /></td>
                      <td>{flow.date}</td>
                      <td><Link href={`${domainHref('CASH_FLOW')}/${flow.id}`}>{flow.positionName || flow.name}</Link></td>
                      <td>{cashTypeLabel(flow.type)}</td>
                      <td className="num">{cashMoney(flow.amount)}</td>
                      <td><span className={`da-st ${tone(flow.status)}`}>{flow.status === 'APPROVED' ? 'Approved' : flow.status === 'PROPOSED' ? 'Proposed' : 'Open'}</span></td>
                    </tr>
                  );
                })}
                {!visibleFlows.length && <tr><td colSpan={6}>No positional cash flows in this period.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
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
    <form className="da-editor" style={{ marginTop: 12, maxWidth: 640 }} onSubmit={(event) => { event.preventDefault(); void onAdjust(Number(amount), side, reason); }}>
      <p className="da-note">{clearing ? `Post ${cashMoney(clearing.amount)} to the ${clearing.side === 'BANK' ? 'bank' : 'position book'} to tie this period.` : 'The books tie. Post another adjustment if a later item needs one.'}</p>
      <label>Amount <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
      <label>Side <select value={side} onChange={(event) => setSide(event.target.value as AdjustmentSide)}><option value="BANK">Bank</option><option value="POSITION">Position book</option></select></label>
      <label>Reason <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this amount ties the books" /></label>
      <button type="submit" className="btn btn-sm" disabled={busy}>Post adjustment</button>
    </form>
  );
}
