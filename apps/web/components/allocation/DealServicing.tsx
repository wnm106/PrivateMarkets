'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { graphqlQuery } from '@/lib/graphql';
import { attributeText } from '@/lib/experience';
import { domainHref } from '@/lib/domain-routes';
import { useTemporalStore } from '@/lib/store';
import { addMonths, heldShare, monthKey, projectSchedule, spreadFromPricing, type ScheduleDraw, type ScheduleMonth } from '@/lib/servicing-schedule';

const RATING: Record<string, string> = {
  R1: '1 Exceptional',
  R2: '2 Performing',
  R3: '3 Watch',
  R4: '4 Special mention',
  R5: '5 Default',
};

const DRAW_TYPES = new Set(['DELAYED_DRAW', 'REVOLVER_DRAW']);

const DRAW_STATUS: Record<string, string> = {
  PROJECTED: 'Projected',
  SCHEDULED: 'Scheduled',
  PAID: 'Actual',
};

interface Rel {
  parentEntityId?: string | null;
  childEntityId?: string | null;
  childEntityName?: string | null;
  relationshipCode: string;
}

interface Node {
  id: string;
  entityName: string;
  attributes: Record<string, unknown>;
  parentRelationships?: Rel[];
  childRelationships: Rel[];
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

interface DrawRow {
  id: string;
  date: string;
  purpose: string;
  amount: number;
  share: number;
  status: string;
  trancheId?: string;
  trancheName: string;
}

interface Covenant {
  id: string;
  name: string;
  direction: string;
  level: number;
  current: number;
  unit: string;
  firstTest: string;
}

interface Report {
  id: string;
  name: string;
  due: string;
}

interface Terms {
  indexRate: number;
  undrawnFeeRate: number;
  pikRate: number;
  amortizationRate: number;
  rating: string;
  mark: number;
  markDate: string;
}

const BOOK = `
  query ServicingBook($dealId: ID!, $asOfDate: Date, $knowledgeDate: DateTime) {
    draws: entities(filter: { domainCode: "AMORTIZATION", isActive: true }, pagination: { first: 500 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id entityName attributes parentRelationships { parentEntityId relationshipCode } } }
    }
    covenants: entities(filter: { domainCode: "DEAL_COVENANT", isActive: true }, pagination: { first: 200 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id entityName attributes childRelationships { childEntityId childEntityName relationshipCode } } }
    }
    reports: entities(filter: { domainCode: "REPORTING_OBLIGATION", isActive: true }, pagination: { first: 400 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id entityName attributes childRelationships { childEntityId childEntityName relationshipCode } } }
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

function rateOf(raw: unknown): number {
  return amountOf(raw) / 100;
}

function child(node: Node, code: string): Rel | undefined {
  return node.childRelationships.find((rel) => rel.relationshipCode === code);
}

function dayStamp(iso: string): number {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(year || 1970, (month || 1) - 1, day || 1);
}

function formatDay(iso: string, withYear = false): string {
  const stamp = dayStamp(iso);
  return new Date(stamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: withYear ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}

function millions(amount: number, digits = 1): string {
  const value = amount / 1_000_000;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}M`;
}

function plainMillions(amount: number): string {
  return (amount / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function thousands(amount: number | null, blankZero = false): string {
  if (amount == null) return '—';
  const rounded = Math.round(amount / 1000);
  if (blankZero && rounded === 0) return '—';
  const body = Math.abs(rounded).toLocaleString('en-US');
  return rounded < 0 ? `(${body})` : body;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function multiple(value: number): string {
  const textValue = value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${textValue}x`;
}

function cushion(direction: string, level: number, current: number): number {
  if (direction === 'MAX') return level ? (level - current) / level : 0;
  return current ? (current - level) / current : 0;
}

function covenantStatus(direction: string, level: number, current: number): 'Pass' | 'Watch' | 'Breach' {
  const breached = direction === 'MAX' ? current > level : current < level;
  if (breached) return 'Breach';
  return cushion(direction, level, current) < 0.1 ? 'Watch' : 'Pass';
}

function held(rows: BookRow[], trancheId: string): number {
  return rows
    .filter((row) => row.level === 'PORTFOLIO')
    .reduce((sum, row) => sum + (row.cells.find((cell) => cell.trancheId === trancheId)?.amount || 0), 0);
}

export function DealServicing({
  dealId,
  stage,
  closeDate,
  tranches,
  rows,
}: {
  dealId: string;
  stage?: string | null;
  closeDate?: string | null;
  tranches: Tranche[];
  rows: BookRow[];
}) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [draws, setDraws] = useState<DrawRow[]>([]);
  const [covenants, setCovenants] = useState<Covenant[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [terms, setTerms] = useState<Terms | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trancheId, setTrancheId] = useState('ALL');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await graphqlQuery<{
      draws: { edges: Array<{ node: Node }> };
      covenants: { edges: Array<{ node: Node }> };
      reports: { edges: Array<{ node: Node }> };
      deal: { attributes: Record<string, unknown> } | null;
    }>(BOOK, { dealId, asOfDate, knowledgeDate }, 'network-only');
    if (result.error?.message) {
      setError(result.error.message);
      setLoading(false);
      return;
    }
    const attributes = result.data?.deal?.attributes || {};
    setTerms({
      indexRate: rateOf(attributes.SERVICING_INDEX_RATE),
      undrawnFeeRate: rateOf(attributes.SERVICING_UNDRAWN_FEE_PCT),
      pikRate: rateOf(attributes.SERVICING_PIK_RATE),
      amortizationRate: rateOf(attributes.SERVICING_AMORTIZATION_PCT),
      rating: text(attributes.SERVICING_RATING),
      mark: amountOf(attributes.SERVICING_MARK),
      markDate: text(attributes.SERVICING_MARK_DATE).slice(0, 10),
    });
    const trancheBySecurity = new Map(tranches.filter((tranche) => tranche.securityId).map((tranche) => [tranche.securityId as string, tranche]));
    setDraws((result.data?.draws.edges || [])
      .map((edge) => edge.node)
      .filter((node) => DRAW_TYPES.has(text(node.attributes.AMORT_TYPE)))
      .map((node): DrawRow | null => {
        const securityId = (node.parentRelationships || []).find((rel) => rel.relationshipCode === 'SECURITY_AMORTIZATION')?.parentEntityId;
        const tranche = securityId ? trancheBySecurity.get(securityId) : undefined;
        if (!tranche) return null;
        const facility = amountOf(node.attributes.AMORT_PRINCIPAL_AMOUNT);
        return {
          id: node.id,
          date: text(node.attributes.AMORT_DATE).slice(0, 10),
          purpose: node.entityName,
          amount: facility,
          share: heldShare(facility, tranche.holdPct, tranche.size, held(rows, tranche.id)),
          status: text(node.attributes.AMORT_STATUS) || 'PROJECTED',
          trancheId: tranche.id,
          trancheName: tranche.name,
        };
      })
      .filter((row): row is DrawRow => Boolean(row))
      .sort((a, b) => a.date.localeCompare(b.date)));
    setCovenants((result.data?.covenants.edges || [])
      .map((edge) => edge.node)
      .filter((node) => child(node, 'COVENANT_DEAL')?.childEntityId === dealId)
      .map((node): Covenant => ({
        id: node.id,
        name: node.entityName,
        direction: text(node.attributes.COVENANT_DIRECTION),
        level: amountOf(node.attributes.COVENANT_LEVEL),
        current: amountOf(node.attributes.COVENANT_CURRENT),
        unit: text(node.attributes.COVENANT_UNIT),
        firstTest: text(node.attributes.COVENANT_FIRST_TEST).slice(0, 10),
      })));
    setReports((result.data?.reports.edges || [])
      .map((edge) => edge.node)
      .filter((node) => child(node, 'REPORT_DEAL')?.childEntityId === dealId)
      .map((node): Report => ({
        id: node.id,
        name: node.entityName,
        due: text(node.attributes.REPORT_DUE_DATE).slice(0, 10),
      }))
      .sort((a, b) => a.due.localeCompare(b.due)));
    setLoading(false);
  }, [asOfDate, dealId, knowledgeDate, rows, tranches]);

  useEffect(() => { void load(); }, [load]);

  const debt = useMemo(
    () => tranches.filter((tranche) => !tranche.equityLinked),
    [tranches],
  );
  const selected = trancheId === 'ALL' ? debt : debt.filter((tranche) => tranche.id === trancheId);
  const fundedTranches = selected.filter((tranche) => !tranche.unfunded);
  const unfundedTranches = selected.filter((tranche) => tranche.unfunded);
  const initialFunded = fundedTranches.reduce((sum, tranche) => sum + held(rows, tranche.id), 0);
  const initialUnfunded = unfundedTranches.reduce((sum, tranche) => sum + held(rows, tranche.id), 0);
  const spread = spreadFromPricing((fundedTranches[0] || selected[0])?.pricing);
  const sizedDraws = draws.map((draw) => ({
    ...draw,
    our: draw.share,
  }));
  const viewDraws: ScheduleDraw[] = sizedDraws
    .filter((draw) => !draw.trancheId || selected.some((tranche) => tranche.id === draw.trancheId))
    .map((draw) => ({ date: draw.date, amount: draw.our, trancheId: draw.trancheId || '' }));

  const schedule = useMemo(() => {
    if (!closeDate || !terms) return null;
    return projectSchedule({
      closeDate,
      asOfDate,
      funded: stage === 'CLOSED',
      indexRate: terms.indexRate,
      spread,
      undrawnFeeRate: terms.undrawnFeeRate,
      pikRate: terms.pikRate,
      amortizationRate: terms.amortizationRate,
      initialFunded,
      initialUnfunded,
      amortizeDraws: fundedTranches.length === 0 && unfundedTranches.length > 0,
      draws: viewDraws,
    });
  }, [asOfDate, closeDate, fundedTranches.length, initialFunded, initialUnfunded, spread, stage, terms, unfundedTranches.length, viewDraws]);

  const live = stage === 'CLOSED';
  const fundCount = rows.filter((row) => row.level === 'PORTFOLIO' && debt.some((tranche) => !tranche.unfunded && (row.cells.find((cell) => cell.trancheId === tranche.id)?.amount || 0) > 0)).length;
  const drawnToDate = sizedDraws.filter((draw) => draw.date && draw.date <= asOfDate).reduce((sum, draw) => sum + draw.our, 0);
  const nextPayment = schedule?.payments.find((payment) => payment.date >= asOfDate) || schedule?.payments[0];
  const coupon = (terms?.indexRate || 0) + spread;
  const horizon = closeDate ? addMonths(closeDate, 12) : '';
  const drawsInView = sizedDraws.filter((draw) => draw.date && horizon && draw.date <= horizon);
  const usage = rows
    .filter((row) => row.level === 'PORTFOLIO')
    .map((row) => {
      const funded = debt.filter((tranche) => !tranche.unfunded).reduce((sum, tranche) => sum + (row.cells.find((cell) => cell.trancheId === tranche.id)?.amount || 0), 0);
      const unfunded = debt.filter((tranche) => tranche.unfunded).reduce((sum, tranche) => sum + (row.cells.find((cell) => cell.trancheId === tranche.id)?.amount || 0), 0);
      const share = initialUnfunded > 0 ? unfunded / initialUnfunded : 0;
      const upcoming = drawsInView.reduce((sum, draw) => sum + draw.our, 0) * share;
      return { id: row.fundId, name: row.fundName, funded, unfunded, upcoming, remaining: Math.max(0, unfunded - upcoming) };
    })
    .filter((row) => row.funded > 0 || row.unfunded > 0);

  return (
    <div className="da">
      <section className="da-sec">
        <div className="da-sechead">
          <h2>Servicing</h2>
          <p>{live ? 'Funded' : 'Pro forma until funded'}</p>
        </div>
        <div className="da-ribbon" style={{ marginTop: 12 }}>
          <div className="da-facts five">
            <div className="da-fact">
              <span>Funded at close</span>
              <strong>{millions(initialFunded)}</strong>
              <small>{fundCount ? `Across ${fundCount} fund${fundCount === 1 ? '' : 's'}` : '—'}</small>
            </div>
            <div className="da-fact">
              <span>Unfunded commitments</span>
              <strong>{millions(initialUnfunded)}</strong>
              <small>{millions(drawnToDate)} drawn to date</small>
            </div>
            <div className="da-fact">
              <span>Next payment</span>
              <strong>{nextPayment ? formatDay(nextPayment.date) : '—'}</strong>
              <small>{nextPayment ? `${millions(nextPayment.total)} receipts` : '—'}</small>
            </div>
            <div className="da-fact">
              <span>Cash coupon</span>
              <strong>{terms ? percent(coupon) : '—'}</strong>
              <small>Weighted, funded debt</small>
            </div>
            <div className="da-fact">
              <span>Internal rating</span>
              <strong>{terms?.rating ? (RATING[terms.rating] || terms.rating) : '—'}</strong>
              <small>{terms?.mark ? `Mark ${terms.mark.toFixed(1)}${terms.markDate ? `, valued ${formatDay(terms.markDate)}` : ''}` : '—'}</small>
            </div>
          </div>
        </div>
      </section>

      {error && <div className="xp-error">{error}</div>}
      {loading && <div className="xp-empty">Loading servicing…</div>}
      {!loading && !closeDate && <div className="xp-empty">This deal has no target close date, so there is no servicing schedule.</div>}

      {schedule && (
        <section className="da-sec">
          <div className="da-sechead">
            <h2>Cash flow roll-forward</h2>
            <p>Monthly from close. Actuals are shaded, and projections start after the dashed line. Negative cash flow is cash out to the borrower.</p>
          </div>
          <div className="da-tabs" role="tablist" aria-label="Tranche" style={{ marginTop: 8 }}>
            <button type="button" className={trancheId === 'ALL' ? 'on' : ''} onClick={() => setTrancheId('ALL')}>All tranches</button>
            {debt.map((tranche) => (
              <button key={tranche.id} type="button" className={trancheId === tranche.id ? 'on' : ''} onClick={() => setTrancheId(tranche.id)}>
                {tranche.name}
              </button>
            ))}
          </div>
          <RollForward months={schedule.months} showPik={(terms?.pikRate || 0) > 0} />
        </section>
      )}

      {schedule && schedule.payments.length > 0 && (
        <section className="da-sec">
          <div className="da-sechead"><h2>Quarterly payment schedule</h2></div>
          <div className="da-gridwrap">
            <table className="da-grid">
              <thead>
                <tr>
                  <th>Payment date</th>
                  <th className="num">Interest</th>
                  <th className="num">Fees</th>
                  <th className="num">Amortization</th>
                  <th className="num">Total receipts</th>
                  <th className="num">PIK accrued</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {schedule.payments.map((payment) => (
                  <tr key={payment.date}>
                    <td>{formatDay(payment.date, true)}</td>
                    <td className="num">{plainMillions(payment.interest)}</td>
                    <td className="num">{plainMillions(payment.fees)}</td>
                    <td className="num">{plainMillions(payment.amortization)}</td>
                    <td className="num"><b>{plainMillions(payment.total)}</b></td>
                    <td className="num">{payment.pik ? plainMillions(payment.pik) : '—'}</td>
                    <td><span className={payment.projected ? 'da-st na' : 'da-st ok'}>{payment.projected ? 'Projected' : 'Actual'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {sizedDraws.length > 0 && (
        <section className="da-sec">
          <div className="da-sechead">
            <h2>Expected draws</h2>
            <p>Our hold of each facility draw on the security.</p>
          </div>
          <div className="da-gridwrap">
            <table className="da-grid">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Tranche</th>
                  <th>Purpose</th>
                  <th className="num">Our share ($M)</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sizedDraws.map((draw) => (
                  <tr key={draw.id}>
                    <td>{draw.date ? formatDay(draw.date, true) : '—'}</td>
                    <td>{draw.trancheId ? <Link href={`${domainHref('DEAL_TRANCHE')}/${draw.trancheId}`}>{draw.trancheName}</Link> : draw.trancheName}</td>
                    <td><Link href={`${domainHref('AMORTIZATION')}/${draw.id}`}>{draw.purpose}</Link></td>
                    <td className="num">{plainMillions(draw.our)}</td>
                    <td><span className={draw.status === 'PAID' ? 'da-st ok' : 'da-st na'}>{DRAW_STATUS[draw.status] || draw.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {usage.length > 0 && (
        <section className="da-sec">
          <div className="da-sechead"><h2>Commitment usage by fund</h2></div>
          <div className="da-gridwrap">
            <table className="da-grid">
              <thead>
                <tr>
                  <th>Portfolio</th>
                  <th className="num">Funded at close</th>
                  <th className="num">Unfunded commitment</th>
                  <th className="num">Draws in 12 months</th>
                  <th className="num">Undrawn after</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => (
                  <tr key={row.id}>
                    <td><Link href={`${domainHref('FUND')}/${row.id}`}>{row.name}</Link></td>
                    <td className="num">{plainMillions(row.funded)}</td>
                    <td className="num">{plainMillions(row.unfunded)}</td>
                    <td className="num">{plainMillions(row.upcoming)}</td>
                    <td className="num">{plainMillions(row.remaining)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(covenants.length > 0 || reports.length > 0) && (
        <section className="da-sec">
          <div className="da-sechead"><h2>Covenants and reporting</h2></div>
          <div className="da-pair">
            {covenants.length > 0 && (
              <div className="da-gridwrap">
                <table className="da-grid" style={{ minWidth: 0 }}>
                  <thead>
                    <tr>
                      <th>Covenant</th>
                      <th className="num">Level</th>
                      <th className="num">Current</th>
                      <th className="num">Cushion</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {covenants.map((row) => {
                      const status = covenantStatus(row.direction, row.level, row.current);
                      const format = row.unit === 'CURRENCY' ? (value: number) => millions(value) : multiple;
                      return (
                        <tr key={row.id}>
                          <td>
                            <Link href={`${domainHref('DEAL_COVENANT')}/${row.id}`}>{row.name}</Link>
                            {row.firstTest && <small>First test {formatDay(row.firstTest, true)}</small>}
                          </td>
                          <td className="num">{format(row.level)}</td>
                          <td className="num">{format(row.current)}</td>
                          <td className="num">{Math.round(cushion(row.direction, row.level, row.current) * 100)}%</td>
                          <td><span className={status === 'Pass' ? 'da-st ok' : status === 'Watch' ? 'da-st near' : 'da-st breach'}>{status}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {reports.length > 0 && (
              <div className="da-gridwrap">
                <table className="da-grid" style={{ minWidth: 0 }}>
                  <thead>
                    <tr>
                      <th>Reporting due</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((row) => (
                      <tr key={row.id}>
                        <td><Link href={`${domainHref('REPORTING_OBLIGATION')}/${row.id}`}>{row.name}</Link></td>
                        <td>{row.due ? formatDay(row.due, true) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function RollForward({ months, showPik }: { months: ScheduleMonth[]; showPik: boolean }) {
  const lines: Array<{ label: string; band?: string; pick: (month: ScheduleMonth) => string; strong?: boolean }> = [
    { label: 'Commitment amount', pick: (month) => thousands(month.commitment) },
    { label: 'Opening balance', pick: (month) => thousands(month.opening), strong: true },
    { label: 'Undrawn commitment', pick: (month) => thousands(month.undrawn) },
    { label: 'Principal drawdown', pick: (month) => thousands(month.drawdown, true) },
    { label: 'Principal repayment', pick: (month) => thousands(month.repayment, true) },
    { label: 'Cash', band: 'Cash', pick: () => '' },
    { label: 'Index rate', pick: (month) => percent(month.indexRate) },
    { label: 'Cash spread', pick: (month) => percent(month.spread) },
    { label: 'Total cash coupon', pick: (month) => percent(month.coupon) },
    { label: 'Cash interest', pick: (month) => thousands(month.cashInterest, true) },
    { label: 'Undrawn fee', pick: (month) => thousands(month.undrawnFee, true) },
    { label: 'Accrued cash', pick: (month) => thousands(month.accruedCash, true) },
    { label: 'Paid cash', pick: (month) => thousands(month.paidCash, true), strong: true },
    { label: 'PIK', band: 'PIK', pick: () => '' },
    { label: 'PIK coupon', pick: (month) => (showPik ? percent(month.pikRate) : '—') },
    { label: 'PIK interest', pick: (month) => thousands(showPik ? month.pikInterest : 0, true) },
    { label: 'Accrued PIK interest', pick: (month) => thousands(showPik ? month.accruedPik : null, true) },
    { label: 'Capitalised PIK', pick: (month) => thousands(showPik ? month.capitalisedPik : 0, true) },
    { label: 'PIK payment', pick: (month) => thousands(showPik ? month.pikPayment : 0, true) },
    { label: 'Closing balance', pick: (month) => thousands(month.closing), strong: true },
    { label: 'Cash flow', pick: (month) => thousands(month.cashFlow, true), strong: true },
    { label: 'Cumulative cash flow', pick: (month) => thousands(month.cumulative), strong: true },
  ];

  return (
    <div className="da-gridwrap">
      <table className="da-grid da-roll">
        <thead>
          <tr>
            <th>$ thousands</th>
            {months.map((month) => (
              <th key={month.key} className={`num${month.forecastStart ? ' cut' : ''}${month.actual ? ' actual' : ''}`}>{month.label}</th>
            ))}
          </tr>
          <tr>
            <th>Actual or forecast</th>
            {months.map((month) => (
              <th key={month.key} className={`num${month.forecastStart ? ' cut' : ''}${month.actual ? ' actual' : ''}`}>{month.actual ? 'Actual' : 'Forecast'}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            line.band ? (
              <tr key={line.band} className="band">
                <td colSpan={months.length + 1}>{line.band}</td>
              </tr>
            ) : (
              <tr key={line.label}>
                <td>{line.strong ? <b>{line.label}</b> : line.label}</td>
                {months.map((month) => (
                  <td key={month.key} className={`num${month.forecastStart ? ' cut' : ''}${month.actual ? ' actual' : ''}`}>
                    {line.strong ? <b>{line.pick(month)}</b> : line.pick(month)}
                  </td>
                ))}
              </tr>
            )
          ))}
        </tbody>
      </table>
    </div>
  );
}
