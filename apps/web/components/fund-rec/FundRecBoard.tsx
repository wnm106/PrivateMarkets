'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { useTemporalStore } from '@/lib/store';
import { useSurfaceNav } from '@/lib/surface-nav';
import {
  FUND_REC_BOARD_QUERY, HEALTH_LABEL, dayCount, healthTone, millions, percent, shortDate,
  type FundRecBoard as Board,
} from '@/lib/fund-rec';

const FILTERS = [
  ['all', 'All funds'],
  ['attention', 'Needs attention'],
  ['AWAITING_PACK', 'Awaiting pack'],
  ['IN_REVIEW', 'In review'],
  ['CERTIFIED', 'Certified'],
] as const;

type Filter = (typeof FILTERS)[number][0];

export function FundRecBoard() {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [frequency, setFrequency] = useState<'ALL' | 'MONTHLY' | 'QUARTERLY'>('ALL');

  useSurfaceNav([{ label: 'Fund reconciliation' }]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    graphqlQuery<{ fundRecBoard: Board }, { asOfDate: string }>(FUND_REC_BOARD_QUERY, { asOfDate }, 'network-only').then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error.message || 'Could not load the close board');
      else { setBoard(result.data?.fundRecBoard ?? null); setError(null); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [asOfDate]);

  const rows = useMemo(() => (board?.funds || []).filter((row) => {
    if (frequency !== 'ALL' && row.frequency !== frequency) return false;
    if (filter === 'all') return true;
    if (filter === 'attention') return row.atRisk || row.health === 'BLOCKED' || row.priorOpen;
    return row.health === filter;
  }), [board, filter, frequency]);

  const totals = board?.totals;
  const closed = totals ? totals.certified : 0;
  const count = totals?.funds || 0;
  const matrix = board?.funds.length ? board.funds[0].readiness.map((item) => item.key) : [];

  return (
    <div className="view-fade da fund-rec">
      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Close</span>
          <h1>Fund reconciliation</h1>
          <p>Where every fund stands in its monthly or quarterly close, as of {shortDate(asOfDate)}.</p>
        </div>
        <div className="da-facts five">
          <div className="da-fact big"><span>Funds closing</span><strong>{loading ? '—' : count}</strong></div>
          <div className="da-fact"><span>Awaiting pack</span><strong>{totals?.awaitingPack ?? '—'}</strong></div>
          <div className="da-fact"><span>In review</span><strong>{totals?.inReview ?? '—'}</strong></div>
          <div className="da-fact"><span>Blocked</span><strong>{totals?.blocked ?? '—'}</strong><small>{totals ? `${totals.breaks} breaks, ${totals.withAdmin} with admin` : ''}</small></div>
          <div className="da-fact"><span>At risk</span><strong>{totals?.atRisk ?? '—'}</strong><small>{totals ? `${totals.openItems} items to decide` : ''}</small></div>
        </div>
        <div className="da-holdbox">
          <div className="da-holdtop"><span>NAVs certified</span><b>{closed} of {count}</b></div>
          <div className="da-bar"><i style={{ width: `${count ? (closed / count) * 100 : 0}%` }} /></div>
          <p>{totals && totals.notReady ? `${totals.notReady} fund${totals.notReady === 1 ? '' : 's'} missing inputs the reconciliation needs.` : 'Every fund has the inputs it needs.'}</p>
        </div>
      </header>

      {error && <div className="xp-error">{error}</div>}
      {loading && !board && <div className="xp-empty">Loading closes…</div>}
      {board && !board.funds.length && (
        <div className="xp-empty">No fund has a close calendar. Set a close frequency on a fund record to put it on this board.</div>
      )}

      {board && board.funds.length > 0 && (
        <>
          <div className="da-tabs" role="tablist" aria-label="Filter closes">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={filter === key} className={filter === key ? 'on' : ''} onClick={() => setFilter(key)}>{label}</button>
            ))}
            <label className="da-tabsel">
              Frequency
              <select value={frequency} onChange={(event) => setFrequency(event.target.value as typeof frequency)}>
                <option value="ALL">All</option>
                <option value="MONTHLY">Monthly</option>
                <option value="QUARTERLY">Quarterly</option>
              </select>
            </label>
          </div>

          <section className="da-sec">
            <div className="da-sechead">
              <h2>Current closes</h2>
              <p>Each fund is shown for the period now closing. Open a row to work the reconciliation.</p>
            </div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead>
                  <tr>
                    <th>Fund</th><th>Close</th><th>Certify by</th><th>Status</th><th>Steps</th>
                    <th className="num">Breaks</th><th className="num">Items open</th><th className="num">With admin</th>
                    <th className="num">NAV ($M)</th><th>Inputs</th><th>Next step</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.fundId}>
                      <td>
                        <b><Link href={`/fund-rec/${row.fundId}`}>{row.fundName}</Link></b>
                        <small>{row.strategy || '—'}</small>
                      </td>
                      <td>{row.periodLabel}<small>{row.frequency === 'MONTHLY' ? 'Monthly' : 'Quarterly'}{row.priorOpen ? ' · prior close open' : ''}</small></td>
                      <td>{shortDate(row.targetDate)}<small className={row.daysToTarget < 0 && !row.certified ? 'da-late' : ''}>{row.certified ? 'Done' : dayCount(row.daysToTarget)}</small></td>
                      <td>
                        <span className={`da-st ${healthTone(row.health, row.atRisk)}`}>{HEALTH_LABEL[row.health]}</span>
                        <small>{row.healthNote}{row.atRisk && row.health !== 'CERTIFIED' ? ' · at risk' : ''}</small>
                      </td>
                      <td>
                        {row.stepsDone} of {row.stepsTotal}
                        <div className="da-bar"><i style={{ width: `${(row.stepsDone / row.stepsTotal) * 100}%` }} /></div>
                      </td>
                      <td className="num">{row.breaks ? <span className="da-st breach">{row.breaks}</span> : row.missing ? <span className="da-st na">{row.missing} missing</span> : '0'}</td>
                      <td className="num">{row.itemsTotal ? `${row.itemsOpen} of ${row.itemsTotal}` : '—'}</td>
                      <td className="num">{row.queries || '—'}</td>
                      <td className="num">{millions(row.navProposed ?? row.navReported)}<small>{row.navChangePct == null ? '' : `${percent(row.navChangePct, 1, true)} on prior`}</small></td>
                      <td>{row.readyForRec ? <span className="da-st ok">Ready</span> : <span className="da-st near" title={row.gaps.join(', ')}>{row.gaps.length} missing</span>}</td>
                      <td>{row.nextStep || 'None'}<small>{row.nextDue ? `Due ${shortDate(row.nextDue)}` : ''}</small></td>
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={11}>No fund matches this filter.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="da-sec">
            <div className="da-sechead">
              <h2>Reconciliation inputs</h2>
              <p>Everything the reconciliation reads for the period now closing. A gap here is a record to load, not a break.</p>
            </div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead>
                  <tr>
                    <th>Fund</th>
                    {board.funds[0].readiness.map((item) => <th key={item.key} className="num">{item.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {board.funds.map((row) => (
                    <tr key={row.fundId}>
                      <td><Link href={`/fund-rec/${row.fundId}?tab=inputs`}>{row.fundName}</Link></td>
                      {matrix.map((key) => {
                        const item = row.readiness.find((entry) => entry.key === key);
                        return (
                          <td key={key} className="num">
                            {!item ? '—' : item.ok ? <span className="da-st ok">On file</span> : item.required ? <span className="da-st near">Missing</span> : <span className="da-st na">Not needed</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
