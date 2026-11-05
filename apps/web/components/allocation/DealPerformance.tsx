'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { attributeText } from '@/lib/experience';
import { useTemporalStore } from '@/lib/store';
import { heldShare, spreadFromPricing } from '@/lib/servicing-schedule';
import { projectPerformance, type PerformanceCase, type PerformanceFees } from '@/lib/deal-performance';

const RATING: Record<string, string> = {
  R1: '1 Exceptional',
  R2: '2 Performing',
  R3: '3 Watch',
  R4: '4 Special mention',
  R5: '5 Default',
};

interface Rel {
  parentEntityId?: string | null;
  childEntityId?: string | null;
  relationshipCode: string;
}

interface Node {
  id: string;
  attributes: Record<string, unknown>;
  parentRelationships?: Rel[];
  childRelationships?: Rel[];
}

interface Tranche {
  id: string;
  name: string;
  size: number;
  holdPct: number;
  securityId?: string | null;
  pricing?: string | null;
  unfunded: boolean;
  equityLinked?: boolean | null;
}

interface BookRow {
  fundId: string;
  fundName: string;
  level: string;
  cells: Array<{ trancheId: string; amount: number }>;
}

const BOOK = `
  query PerformanceBook($dealId: ID!, $asOfDate: Date, $knowledgeDate: DateTime) {
    draws: entities(filter: { domainCode: "AMORTIZATION", isActive: true }, pagination: { first: 500 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id attributes parentRelationships { parentEntityId relationshipCode } } }
    }
    funds: entities(filter: { domainCode: "FUND", isActive: true }, pagination: { first: 200 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id attributes } }
    }
    deal: entity(id: $dealId, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) { attributes }
  }
`;

function text(raw: unknown): string {
  return attributeText(raw).trim();
}

function amountOf(raw: unknown): number {
  const value = Number(text(raw).replace(/[$,]/g, ''));
  return Number.isFinite(value) ? value : 0;
}

function held(rows: BookRow[], trancheId: string): number {
  return rows
    .filter((row) => row.level === 'PORTFOLIO')
    .reduce((sum, row) => sum + (row.cells.find((cell) => cell.trancheId === trancheId)?.amount || 0), 0);
}

function millions(value: number, digits = 1): string {
  const scaled = value / 1_000_000;
  const body = Math.abs(scaled).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return scaled < 0 ? `($${body}M)` : `$${body}M`;
}

function money(value: number, digits = 2): string {
  const scaled = value / 1_000_000;
  const body = Math.abs(scaled).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return scaled < 0 ? `(${body})` : body;
}

function pct(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function multiple(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}x`;
}

function points(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(2)} pts`;
}

function leverage(from: number | null, to: number | null): string {
  if (from == null && to == null) return '—';
  const left = from == null ? '—' : `${from.toFixed(1)}x`;
  const right = to == null ? '—' : `${to.toFixed(1)}x`;
  return `${left} to ${right}`;
}

function monthName(iso: string): string {
  const [year, month] = iso.slice(0, 10).split('-').map(Number);
  const name = new Date(Date.UTC(year || 1970, (month || 1) - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${name} ${year}`;
}

function rateLabel(value: number): string {
  const points = value * 100;
  return `${points.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

export function DealPerformance({
  dealId,
  borrowerName,
  stage,
  closeDate,
  oid,
  tranches,
  rows,
}: {
  dealId: string;
  borrowerName?: string | null;
  stage?: string | null;
  closeDate?: string | null;
  oid?: string | null;
  tranches: Tranche[];
  rows: BookRow[];
}) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [model, setModel] = useState<PerformanceCase | null>(null);
  const [fees, setFees] = useState<PerformanceFees>({ management: 0, expenses: 0, carry: 0, hurdle: 0 });
  const [rating, setRating] = useState('');
  const [mark, setMark] = useState<number | null>(null);
  const [loss, setLoss] = useState(0);
  const [nonAccrual, setNonAccrual] = useState(false);
  const [senior, setSenior] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const debt = useMemo(() => tranches.filter((tranche) => !tranche.equityLinked), [tranches]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await graphqlQuery<{
      draws: { edges: Array<{ node: Node }> };
      funds: { edges: Array<{ node: { id: string; attributes: Record<string, unknown> } }> };
      deal: { attributes: Record<string, unknown> } | null;
    }>(BOOK, { dealId, asOfDate, knowledgeDate }, 'network-only');
    if (result.error?.message) {
      setError(result.error.message);
      setLoading(false);
      return;
    }
    const attributes = result.data?.deal?.attributes || {};
    const fundFees = new Map((result.data?.funds.edges || []).map((edge) => [edge.node.id, edge.node.attributes]));
    const portfolios = rows.filter((row) => row.level === 'PORTFOLIO');
    let weight = 0;
    const blended = { management: 0, expenses: 0, carry: 0, hurdle: 0 };
    portfolios.forEach((row) => {
      const hold = debt.reduce((sum, tranche) => sum + (row.cells.find((cell) => cell.trancheId === tranche.id)?.amount || 0), 0);
      const raw = fundFees.get(row.fundId);
      if (!raw || hold <= 0) return;
      weight += hold;
      blended.management += hold * amountOf(raw.FUND_MGMT_FEE_PCT);
      blended.expenses += hold * amountOf(raw.FUND_EXPENSE_PCT);
      blended.carry += hold * amountOf(raw.FUND_CARRY_PCT);
      blended.hurdle += hold * amountOf(raw.FUND_HURDLE_PCT);
    });
    const nextFees: PerformanceFees = weight
      ? {
          management: blended.management / weight / 100,
          expenses: blended.expenses / weight / 100,
          carry: blended.carry / weight / 100,
          hurdle: blended.hurdle / weight / 100,
        }
      : { management: 0, expenses: 0, carry: 0, hurdle: 0 };
    setFees(nextFees);
    const ratingCode = text(attributes.SERVICING_RATING);
    setRating(RATING[ratingCode] || ratingCode);
    const markValue = amountOf(attributes.SERVICING_MARK);
    setMark(markValue || null);
    setLoss(amountOf(attributes.SERVICING_REALIZED_LOSS));
    setNonAccrual(text(attributes.SERVICING_NON_ACCRUAL).toLowerCase() === 'true');
    const seniorValue = amountOf(attributes.DEAL_LEVERAGE_SENIOR);
    const totalValue = amountOf(attributes.DEAL_LEVERAGE_TOTAL);
    setSenior(seniorValue || null);
    const trancheBySecurity = new Map(debt.filter((tranche) => tranche.securityId).map((tranche) => [tranche.securityId as string, tranche]));
    const draws = (result.data?.draws.edges || [])
      .map((edge) => edge.node)
      .filter((node) => text(node.attributes.AMORT_TYPE) === 'DELAYED_DRAW' || text(node.attributes.AMORT_TYPE) === 'REVOLVER_DRAW')
      .map((node) => {
        const securityId = (node.parentRelationships || []).find((rel) => rel.relationshipCode === 'SECURITY_AMORTIZATION')?.parentEntityId || '';
        const tranche = trancheBySecurity.get(securityId);
        const facility = amountOf(node.attributes.AMORT_PRINCIPAL_AMOUNT);
        return {
          date: text(node.attributes.AMORT_DATE).slice(0, 10),
          amount: tranche ? heldShare(facility, tranche.holdPct, tranche.size, held(rows, tranche.id)) : 0,
          trancheId: tranche?.id || '',
        };
      })
      .filter((draw) => draw.trancheId && draw.date);
    const oidPrice = amountOf(oid);
    const projected = closeDate ? projectPerformance({
      closeDate,
      asOfDate,
      closed: stage === 'CLOSED',
      holdYears: amountOf(attributes.DEAL_HOLD_YEARS) || 3,
      oid: oidPrice > 0 ? oidPrice / 100 : 1,
      mark: markValue > 0 ? markValue / 100 : 1,
      indexRate: amountOf(attributes.SERVICING_INDEX_RATE) / 100 || amountOf(attributes.DEAL_BASE_RATE) / 100,
      undrawnFeeRate: amountOf(attributes.SERVICING_UNDRAWN_FEE_PCT) / 100,
      pikRate: amountOf(attributes.SERVICING_PIK_RATE) / 100,
      amortizationRate: amountOf(attributes.SERVICING_AMORTIZATION_PCT) / 100,
      seniorLeverage: seniorValue || null,
      totalLeverage: totalValue || null,
      fees: nextFees,
      tranches: debt.map((tranche) => ({
        id: tranche.id,
        name: tranche.name,
        unfunded: tranche.unfunded,
        hold: held(rows, tranche.id),
        spread: spreadFromPricing(tranche.pricing),
        draws: draws
          .filter((draw) => draw.trancheId === tranche.id)
          .map((draw) => ({ date: draw.date, amount: draw.amount, trancheId: tranche.id })),
      })),
    }) : null;
    setModel(projected);
    setLoading(false);
  }, [asOfDate, closeDate, dealId, debt, knowledgeDate, oid, rows, stage]);

  useEffect(() => { void load(); }, [load]);

  const spreadBps = model?.grossIrr != null && model.netIrr != null ? Math.round((model.grossIrr - model.netIrr) * 10000) : null;
  const fundedLeverage = senior;

  return (
    <div className="da">
      <section className="da-sec">
        <div className="da-sechead">
          <h2>Performance</h2>
          <p>
            {borrowerName || 'Borrower'}: our allocated position across the debt tranches. Projected returns use the servicing cash flows{stage === 'CLOSED' ? '.' : '; the deal has not closed, so all months are pro forma.'}
          </p>
        </div>
        {model && (
          <div className="da-ribbon" style={{ marginTop: 12 }}>
            <div className="da-facts six">
              <div className="da-fact">
                <span>Gross IRR</span>
                <strong>{pct(model.grossIrr)}</strong>
                <small>MOIC {multiple(model.grossMoic)}</small>
              </div>
              <div className="da-fact">
                <span>Net IRR</span>
                <strong>{pct(model.netIrr)}</strong>
                <small>TVPI {multiple(model.netMoic)}</small>
              </div>
              <div className="da-fact">
                <span>Gross to net spread</span>
                <strong>{spreadBps == null ? '—' : `${spreadBps.toLocaleString('en-US')} bps`}</strong>
                <small>Fees, expenses and carry</small>
              </div>
              <div className="da-fact">
                <span>Current cash yield</span>
                <strong>{pct(model.cashYield, 2)}</strong>
                <small>Annualised, first quarter</small>
              </div>
              <div className="da-fact">
                <span>All-in yield</span>
                <strong>{pct(model.allInYield, 2)}</strong>
                <small>Coupon plus OID over the hold</small>
              </div>
              <div className="da-fact">
                <span>Profit gross / net</span>
                <strong>{millions(model.grossProfit)} / {millions(model.netProfit)}</strong>
                <small>On {millions(model.invested)} invested</small>
              </div>
            </div>
          </div>
        )}
        {model && (
          <div className="da-tabs" role="tablist" aria-label="Return basis">
            <button type="button" className="on">Projected life (to {monthName(model.endDate)})</button>
          </div>
        )}
      </section>

      {error && <div className="xp-error">{error}</div>}
      {loading && <div className="xp-empty">Loading performance…</div>}
      {!loading && !model && <div className="xp-empty">No allocated debt position to measure.</div>}

      {model && (
        <>
          <section className="da-sec">
            <div className="da-sechead">
              <h2>Cumulative profit</h2>
              <p>$M, marked at {mark == null ? 'par' : mark.toFixed(1)}</p>
            </div>
            <ProfitChart points={model.points} />
          </section>

          <section className="da-sec">
            <div className="da-sechead">
              <h2>Tranche contribution to performance</h2>
              <p>Share of profit and points of gross IRR each tranche adds. Income is cash, PIK and OID.</p>
            </div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead>
                  <tr>
                    <th>Tranche</th>
                    <th className="num">Position ($M)</th>
                    <th className="num">Cash coupon</th>
                    <th className="num">Leverage through</th>
                    <th className="num">Income ($M)</th>
                    <th className="num">Mark and equity ($M)</th>
                    <th className="num">Profit ($M)</th>
                    <th className="num">IRR</th>
                    <th className="num">MOIC</th>
                    <th>Share of profit</th>
                    <th className="num">Contribution to IRR</th>
                  </tr>
                </thead>
                <tbody>
                  {model.tranches.map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td className="num">{money(row.position)}</td>
                      <td className="num">{pct(row.coupon, 2)}</td>
                      <td className="num">{leverage(row.leverageFrom, row.leverageTo)}</td>
                      <td className="num">{money(row.income)}</td>
                      <td className="num">{money(row.mark)}</td>
                      <td className="num"><b>{money(row.profit)}</b></td>
                      <td className="num">{pct(row.irr)}</td>
                      <td className="num">{multiple(row.moic)}</td>
                      <td>
                        <span className="da-share" title={pct(row.share, 0)}><i style={{ width: `${Math.max(0, Math.min(100, row.share * 100))}%` }} /></span>
                        <small>{pct(row.share, 0)}</small>
                      </td>
                      <td className="num">{points(row.contribution)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total deal, gross</td>
                    <td className="num">{money(model.tranches.reduce((sum, row) => sum + row.position, 0))}</td>
                    <td className="num">{pct(model.weightedCoupon, 2)}</td>
                    <td className="num">—</td>
                    <td className="num">{money(model.tranches.reduce((sum, row) => sum + row.income, 0))}</td>
                    <td className="num">{money(model.tranches.reduce((sum, row) => sum + row.mark, 0))}</td>
                    <td className="num">{money(model.grossProfit)}</td>
                    <td className="num">{pct(model.grossIrr)}</td>
                    <td className="num">{multiple(model.grossMoic)}</td>
                    <td>100%</td>
                    <td className="num">{points(model.grossIrr)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <div className="da-columns">
            <section className="da-sec">
              <div className="da-sechead"><h2>Gross to net</h2></div>
              <div className="da-gridwrap">
                <table className="da-grid">
                  <thead>
                    <tr><th /><th className="num">$M</th><th className="num">% of gross</th><th className="num">IRR</th><th className="num">MOIC</th></tr>
                  </thead>
                  <tbody>
                    {model.bridge.map((row) => (
                      <tr key={row.label} className={row.net ? 'net' : ''}>
                        <td>{row.label === 'Management fee' ? `Management fee (${rateLabel(fees.management)} on invested)` : row.label === 'Fund expenses' ? `Fund expenses (${rateLabel(fees.expenses)})` : row.label === 'Incentive fee' ? `Incentive fee (${rateLabel(fees.carry)} over ${rateLabel(fees.hurdle)} hurdle)` : row.label}</td>
                        <td className="num">{money(row.amount)}</td>
                        <td className="num">{row.shareOfGross == null ? '—' : `${(row.shareOfGross * 100).toFixed(1)}%`}</td>
                        <td className="num">{row.irr == null ? '' : pct(row.irr)}</td>
                        <td className="num">{row.moic == null ? '' : multiple(row.moic)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="da-sec">
              <div className="da-sechead"><h2>Return sources</h2></div>
              <div className="da-gridwrap">
                <table className="da-grid">
                  <thead>
                    <tr><th /><th className="num">$M</th><th className="num">% of profit</th><th className="num">On invested</th></tr>
                  </thead>
                  <tbody>
                    {model.sources.map((row, index) => (
                      <tr key={row.label} className={index === model.sources.length - 1 ? 'net' : ''}>
                        <td>{row.label}</td>
                        <td className="num">{money(row.amount)}</td>
                        <td className="num">{row.shareOfProfit == null ? '—' : `${Math.round(row.shareOfProfit * 100)}%`}</td>
                        <td className="num">{pct(row.onInvested, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="da-sec">
            <div className="da-sechead"><h2>Private credit KPIs</h2></div>
            <div className="da-cards">
              <article className="da-card">
                <h3>Returns</h3>
                <dl>
                  <dt>Gross TVPI</dt><dd>{multiple(model.grossMoic)}</dd>
                  <dt>Net TVPI</dt><dd>{multiple(model.netMoic)}</dd>
                  <dt>DPI (gross)</dt><dd>{multiple(model.dpi)}</dd>
                  <dt>RVPI (gross)</dt><dd>{multiple(model.rvpi)}</dd>
                  <dt>Gross IRR</dt><dd>{pct(model.grossIrr)}</dd>
                  <dt>Net IRR</dt><dd>{pct(model.netIrr)}</dd>
                </dl>
              </article>
              <article className="da-card">
                <h3>Yield and income</h3>
                <dl>
                  <dt>Weighted cash coupon</dt><dd>{pct(model.weightedCoupon, 2)}</dd>
                  <dt>Weighted spread over SOFR</dt><dd>{pct(model.weightedSpread, 2)}</dd>
                  <dt>Current cash yield</dt><dd>{pct(model.cashYield, 2)}</dd>
                  <dt>All-in yield</dt><dd>{pct(model.allInYield, 2)}</dd>
                  <dt>PIK share of income</dt><dd>{pct(model.pikShare, 0)}</dd>
                  <dt>OID</dt><dd>{amountOf(oid) ? amountOf(oid).toFixed(1) : '—'}</dd>
                </dl>
              </article>
              <article className="da-card">
                <h3>Credit quality</h3>
                <dl>
                  <dt>Total leverage (funded)</dt><dd>{fundedLeverage == null ? '—' : `${fundedLeverage.toFixed(1)}x`}</dd>
                  <dt>Interest coverage</dt><dd>{model.coverage == null ? '—' : `${model.coverage.toFixed(1)}x`}</dd>
                  <dt>Internal rating</dt><dd>{rating || '—'}</dd>
                  <dt>Mark</dt><dd>{mark == null ? '—' : mark.toFixed(1)}</dd>
                  <dt>Weighted average life</dt><dd>{model.walYears == null ? '—' : `${model.walYears.toFixed(1)} yrs`}</dd>
                  <dt>Realised losses / non-accruals</dt><dd>{millions(loss)} / {nonAccrual ? 'non-accrual' : 'none'}</dd>
                </dl>
              </article>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function ProfitChart({ points }: { points: Array<{ date: string; gross: number; net: number }> }) {
  if (points.length < 2) return null;
  const width = 760;
  const height = 240;
  const pad = { l: 44, r: 16, t: 16, b: 32 };
  const max = Math.max(...points.map((point) => Math.max(point.gross, point.net)), 1);
  const top = max / 1_000_000;
  const mid = top / 2;
  const x = (index: number) => pad.l + (index / (points.length - 1)) * (width - pad.l - pad.r);
  const y = (value: number) => pad.t + (1 - value / 1_000_000 / top) * (height - pad.t - pad.b);
  const path = (key: 'gross' | 'net') => points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join(' ');
  const ticks = [0, Math.floor(points.length / 2), points.length - 1];
  return (
    <div className="da-chart">
      <div className="da-legend">
        <span><i className="gross" /> Gross profit</span>
        <span><i className="net" /> Net profit</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cumulative gross and net profit">
        {[0, mid, top].map((tick) => (
          <g key={tick}>
            <line x1={pad.l} x2={width - pad.r} y1={y(tick * 1_000_000)} y2={y(tick * 1_000_000)} stroke="#d5dde6" />
            <text x={pad.l - 8} y={y(tick * 1_000_000) + 4} textAnchor="end" fill="#5c6b7a" fontSize="12">{tick.toFixed(1)}</text>
          </g>
        ))}
        <path d={path('gross')} fill="none" stroke="#0b5d73" strokeWidth="2.5" />
        <path d={path('net')} fill="none" stroke="#b85c74" strokeWidth="2.5" strokeDasharray="6 5" />
        {ticks.map((index) => (
          <text key={index} x={x(index)} y={height - 8} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} fill="#5c6b7a" fontSize="12">
            {monthName(points[index].date)}
          </text>
        ))}
      </svg>
    </div>
  );
}
