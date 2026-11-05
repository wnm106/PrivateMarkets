'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { graphqlQuery } from '@/lib/graphql';
import { attributeText } from '@/lib/experience';
import { domainHref } from '@/lib/domain-routes';
import { useTemporalStore } from '@/lib/store';

const ROLE: Record<string, string> = {
  PARTICIPANT: 'Participant',
  ADMINISTRATIVE_AGENT: 'Administrative agent',
  LEAD_ARRANGER: 'Lead arranger',
  JOINT_LEAD: 'Joint lead',
};

const LENDER_TYPE: Record<string, string> = {
  BANK: 'Bank',
  INSURANCE: 'Insurance',
  CREDIT_FUND: 'Credit fund',
};

const ASSIGNMENT: Record<string, string> = {
  NOT_ISSUED: 'Not issued',
  ISSUED: 'Issued',
  PARTIALLY_SIGNED: 'Partially signed',
  EXECUTED: 'Executed',
};

const STATUS: Record<string, string> = {
  NOT_LAUNCHED: 'Not launched',
  LAUNCHED: 'Launched',
  ALLOCATED: 'Allocated',
  CLOSED: 'Closed',
};

const SHORT: Record<string, string> = {
  LOAN: 'Term Loan',
  DELAYED_DRAW_TERM_LOAN: 'DDTL',
  REVOLVING_CREDIT: 'Revolver',
  SECOND_LIEN_LOAN: '2nd lien',
  MEZZANINE: 'Mezzanine',
  WARRANT: 'Warrant',
  PREFERRED_EQUITY: 'Preferred',
};

const COLOR: Record<string, string> = {
  LOAN: '#0B5D73',
  DELAYED_DRAW_TERM_LOAN: '#4A84AE',
  REVOLVING_CREDIT: '#2F8F7A',
  SECOND_LIEN_LOAN: '#5663B4',
  MEZZANINE: '#B5517A',
  WARRANT: '#7452A6',
  PREFERRED_EQUITY: '#9A5B2E',
};

interface Rel {
  childEntityId: string;
  childEntityName: string;
  relationshipCode: string;
}

interface Node {
  id: string;
  entityName: string;
  attributes: Record<string, unknown>;
  childRelationships: Rel[];
}

interface Tranche {
  id: string;
  name: string;
  label?: string | null;
  size: number;
  instrumentType: string;
  equityLinked?: boolean | null;
  securityId?: string | null;
  rank?: number | null;
}

interface BookRow {
  fundId: string;
  fundName: string;
  level: string;
  cells: Array<{ trancheId: string; amount: number }>;
}

interface Seat {
  id: string;
  name: string;
  house: boolean;
  role: string;
  order: number;
  documents: string;
  lenderId?: string;
  lenderType: string;
  funds: Array<{ id: string; name: string }>;
}

interface Order {
  seatId: string;
  trancheId: string;
  ordered: number;
  allocated: number;
}

const BOOK = `
  query SyndicateBook($dealId: ID!, $asOfDate: Date, $knowledgeDate: DateTime) {
    seats: entities(filter: { domainCode: "SYNDICATE_SEAT", isActive: true }, pagination: { first: 500 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id entityName attributes childRelationships { childEntityId childEntityName relationshipCode } } }
    }
    orders: entities(filter: { domainCode: "SYNDICATE_ORDER", isActive: true }, pagination: { first: 1000 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id entityName attributes childRelationships { childEntityId childEntityName relationshipCode } } }
    }
    lenders: entities(filter: { domainCode: "LENDER", isActive: true }, pagination: { first: 200 }, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      edges { node { id entityName attributes childRelationships { childEntityId childEntityName relationshipCode } } }
    }
    deal: entity(id: $dealId, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) { attributes }
  }
`;

function named(raw: unknown, labels: Record<string, string>): string {
  const text = attributeText(raw).trim();
  return labels[text] || text;
}

function amountOf(raw: unknown): number {
  const value = Number(attributeText(raw).replace(/[$,]/g, ''));
  return Number.isFinite(value) ? value : 0;
}

function isHouse(raw: unknown): boolean {
  const text = attributeText(raw).trim().toLowerCase();
  return text === 'true' || text === 't' || text === '1' || text === 'yes';
}

function child(node: Node, code: string): Rel | undefined {
  return node.childRelationships.find((rel) => rel.relationshipCode === code);
}

function children(node: Node, code: string): Rel[] {
  return node.childRelationships.filter((rel) => rel.relationshipCode === code);
}

function millions(amount: number): string {
  const value = amount / 1_000_000;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
}

function plain(amount: number): string {
  return (amount / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function times(order: number, facility: number): string {
  if (!facility) return '—';
  return `${(order / facility).toFixed(2)}x`;
}

function shortName(name: string): string {
  return name.split(/[\s:]/)[0] || name;
}

export function DealSyndicate({
  dealId,
  stage,
  tranches,
  rows,
}: {
  dealId: string;
  stage?: string | null;
  tranches: Tranche[];
  rows: BookRow[];
}) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await graphqlQuery<{
      seats: { edges: Array<{ node: Node }> };
      orders: { edges: Array<{ node: Node }> };
      lenders: { edges: Array<{ node: Node }> };
      deal: { attributes: Record<string, unknown> } | null;
    }>(BOOK, { dealId, asOfDate, knowledgeDate }, 'network-only');
    if (result.error?.message) {
      setError(result.error.message);
      setLoading(false);
      return;
    }
    const lenders = new Map((result.data?.lenders.edges || []).map((edge) => [edge.node.id, edge.node]));
    const seatNodes = (result.data?.seats.edges || [])
      .map((edge) => edge.node)
      .filter((node) => child(node, 'SEAT_DEAL')?.childEntityId === dealId);
    setSeats(seatNodes.map((node) => {
      const lenderId = child(node, 'SEAT_LENDER')?.childEntityId;
      const lender = lenderId ? lenders.get(lenderId) : undefined;
      return {
        id: node.id,
        name: lender?.entityName || node.entityName,
        house: isHouse(node.attributes?.SEAT_IS_HOUSE),
        role: named(node.attributes?.SEAT_ROLE, ROLE) || 'Participant',
        order: amountOf(node.attributes?.SEAT_DISPLAY_ORDER),
        documents: named(node.attributes?.ASSIGNMENT_STATUS, ASSIGNMENT) || 'Not issued',
        lenderId,
        lenderType: named(lender?.attributes?.LENDER_TYPE, LENDER_TYPE),
        funds: children(node, 'SEAT_FUND').map((rel) => ({ id: rel.childEntityId, name: rel.childEntityName })),
      };
    }));
    const seatIds = new Set(seatNodes.map((node) => node.id));
    setOrders((result.data?.orders.edges || []).map((edge) => edge.node).flatMap((node) => {
      const seatId = child(node, 'ORDER_SEAT')?.childEntityId;
      const trancheId = child(node, 'ORDER_TRANCHE')?.childEntityId;
      if (!seatId || !trancheId || !seatIds.has(seatId)) return [];
      return [{
        seatId,
        trancheId,
        ordered: amountOf(node.attributes?.ORDER_AMOUNT),
        allocated: amountOf(node.attributes?.ORDER_ALLOCATED_AMOUNT),
      }];
    }));
    const stored = attributeText(result.data?.deal?.attributes?.SYNDICATE_STATUS);
    setStatus(STATUS[stored] || stored);
    setLoading(false);
  }, [asOfDate, dealId, knowledgeDate]);

  useEffect(() => { void load(); }, [load]);

  const book = useMemo(() => {
    const debt = tranches.filter((tranche) => !tranche.equityLinked);
    const shown = debt.length ? debt : tranches;
    const portfolios = rows.filter((row) => row.level === 'PORTFOLIO');
    const ours = (trancheId: string) => portfolios.reduce((total, row) => (
      total + (row.cells.find((cell) => cell.trancheId === trancheId)?.amount || 0)
    ), 0);
    const outside = (trancheId: string) => orders
      .filter((order) => order.trancheId === trancheId && !seats.find((seat) => seat.id === order.seatId)?.house)
      .reduce((total, order) => total + order.allocated, 0);
    const ordered = (trancheId: string) => {
      const house = ours(trancheId);
      const external = orders
        .filter((order) => order.trancheId === trancheId)
        .reduce((total, order) => total + order.ordered, 0);
      return house + external;
    };
    return { shown, ours, outside, ordered };
  }, [orders, rows, seats, tranches]);

  const facility = book.shown.reduce((total, tranche) => total + tranche.size, 0);
  const ourTotal = book.shown.reduce((total, tranche) => total + book.ours(tranche.id), 0);
  const otherTotal = book.shown.reduce((total, tranche) => total + book.outside(tranche.id), 0);
  const orderTotal = book.shown.reduce((total, tranche) => total + book.ordered(tranche.id), 0);
  const gap = facility - ourTotal - otherTotal;
  const lenders = seats.filter((seat) => !seat.house);
  const house = seats.find((seat) => seat.house);
  const liveFunds = rows
    .filter((row) => row.level === 'PORTFOLIO' && book.shown.some((tranche) => (row.cells.find((cell) => cell.trancheId === tranche.id)?.amount || 0) > 1000))
    .map((row) => ({ id: row.fundId, name: row.fundName }));
  const funds = liveFunds.length ? liveFunds : (house?.funds || []);
  const listed = [
    ...(ourTotal > 0 || house ? [{
      id: house?.id || 'house',
      house: true,
      name: 'Our funds',
      role: house?.role || 'Participant',
      documents: house?.documents || 'Not issued',
      lenderId: undefined as string | undefined,
      lenderType: '',
      funds,
    }] : []),
    ...lenders.slice().sort((left, right) => left.order - right.order || left.name.localeCompare(right.name)),
  ];

  const statusLabel = status || (stage === 'CLOSED' ? 'Closed' : stage === 'CLOSING' ? 'Launched' : 'Not launched');
  const gapLabel = Math.abs(gap) <= Math.max(facility * 0.005, 1)
    ? 'Fully placed'
    : gap > 0 ? 'Still to place' : 'Placed above the facility';

  return (
    <section className="da-sec">
      <div className="da-sechead">
        <h2>Syndicate</h2>
        <span className="da-st na">{statusLabel}</span>
      </div>

      {loading && <div className="xp-empty">Loading the syndicate…</div>}
      {error && <div className="xp-error">{error}</div>}

      {!loading && !error && (
        <>
          <div className="da-ribbon" style={{ marginTop: 12 }}>
            <div className="da-facts five">
              <div className="da-fact big">
                <span>Facility</span>
                <strong>{millions(facility)}</strong>
                <span>{book.shown.length} tranche{book.shown.length === 1 ? '' : 's'}</span>
              </div>
              <div className="da-fact big">
                <span>Our funds</span>
                <strong>{millions(ourTotal)}</strong>
                <span>{facility ? `${Math.round(ourTotal / facility * 100)}% of facility` : '—'}</span>
              </div>
              <div className="da-fact big">
                <span>Other lenders</span>
                <strong>{millions(otherTotal)}</strong>
                <span>{lenders.length} lender{lenders.length === 1 ? '' : 's'}</span>
              </div>
              <div className="da-fact big">
                <span>Unplaced</span>
                <strong>{millions(Math.abs(gap) <= 1 ? 0 : gap)}</strong>
                <span>{gapLabel}</span>
              </div>
              <div className="da-fact big">
                <span>Oversubscription</span>
                <strong>{times(orderTotal, facility)}</strong>
                <span>Orders against facility</span>
              </div>
            </div>
          </div>

          <div className="da-cards">
            {book.shown.map((tranche) => {
              const ours = book.ours(tranche.id);
              const others = book.outside(tranche.id);
              const placed = ours + others;
              const houseWidth = tranche.size ? Math.min(100, ours / tranche.size * 100) : 0;
              const otherWidth = tranche.size ? Math.min(100 - houseWidth, others / tranche.size * 100) : 0;
              const title = tranche.name;
              return (
                <article key={tranche.id} className="da-card" style={{ borderTopColor: COLOR[tranche.instrumentType] || '#0B5D73' }}>
                  <h3>
                    {tranche.securityId
                      ? <Link href={`${domainHref('SECURITY')}/${tranche.securityId}`}>{title}</Link>
                      : title}
                  </h3>
                  <div className="da-split" aria-hidden="true">
                    <i className="house" style={{ width: `${houseWidth}%` }} />
                    <i className="other" style={{ width: `${otherWidth}%` }} />
                  </div>
                  <dl>
                    <dt>Facility</dt><dd>{millions(tranche.size)}</dd>
                    <dt>Our funds</dt><dd>{millions(ours)}{tranche.size ? ` (${Math.round(ours / tranche.size * 100)}%)` : ''}</dd>
                    <dt>Other lenders</dt><dd>{millions(others)}</dd>
                    <dt>Placed</dt><dd>{tranche.size ? `${Math.round(placed / tranche.size * 100)}%` : '—'}</dd>
                    <dt>Oversubscription</dt><dd>{times(book.ordered(tranche.id), tranche.size)}</dd>
                  </dl>
                </article>
              );
            })}
          </div>

          <div className="da-gridwrap" style={{ marginTop: 16 }}>
            <table className="da-grid">
              <thead>
                <tr>
                  <th>Lender</th>
                  <th>Role</th>
                  {book.shown.map((tranche) => (
                    <th key={tranche.id} className="num da-tcol" style={{ borderTopColor: COLOR[tranche.instrumentType] || '#0B5D73' }}>
                      {SHORT[tranche.instrumentType] || tranche.label || tranche.name}
                    </th>
                  ))}
                  <th className="num">Total</th>
                  <th>Assignment documents</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((seat) => {
                  const cells = book.shown.map((tranche) => {
                    if (seat.house) {
                      const allocated = book.ours(tranche.id);
                      return { allocated, ordered: allocated, house: true };
                    }
                    const order = orders.find((item) => item.seatId === seat.id && item.trancheId === tranche.id);
                    return { allocated: order?.allocated || 0, ordered: order?.ordered || 0, house: false };
                  });
                  const total = cells.reduce((sum, cell) => sum + cell.allocated, 0);
                  return (
                    <tr key={seat.id} className={seat.house ? 'par' : ''}>
                      <td>
                        <div className="da-name" style={{ display: 'block' }}>
                        {seat.house || !seat.lenderId
                          ? <b>{seat.name}</b>
                          : <b><Link href={`${domainHref('LENDER')}/${seat.lenderId}`}>{seat.name}</Link></b>}
                        <small>
                          {seat.house
                            ? seat.funds.map((fund, index) => (
                              <span key={fund.id}>
                                {index > 0 ? ', ' : ''}
                                <Link href={`${domainHref('FUND')}/${fund.id}`}>{shortName(fund.name)}</Link>
                              </span>
                            ))
                            : seat.lenderType}
                        </small>
                        </div>
                      </td>
                      <td>{seat.role}</td>
                      {cells.map((cell, index) => (
                        <td key={book.shown[index].id} className="num">
                          {cell.allocated > 0 || cell.ordered > 0 ? (
                            <>
                              <b>{plain(cell.allocated)}</b>
                              <small>
                                {cell.house || cell.ordered <= 0
                                  ? `Order ${plain(cell.ordered || cell.allocated)}`
                                  : `Order ${plain(cell.ordered)}, cut ${Math.max(0, Math.round((1 - cell.allocated / cell.ordered) * 100))}%`}
                              </small>
                            </>
                          ) : '—'}
                        </td>
                      ))}
                      <td className="num"><b>{plain(total)}</b></td>
                      <td>{seat.documents}</td>
                    </tr>
                  );
                })}
                {!listed.length && (
                  <tr><td colSpan={4 + book.shown.length} style={{ textAlign: 'center', color: 'var(--ink-3)', padding: 28 }}>No lenders are on this book yet.</td></tr>
                )}
              </tbody>
              {listed.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={2}>Total placed</td>
                    {book.shown.map((tranche) => (
                      <td key={tranche.id} className="num">
                        {plain(book.ours(tranche.id) + book.outside(tranche.id))}
                        <small>of {plain(tranche.size)}</small>
                      </td>
                    ))}
                    <td className="num">{plain(ourTotal + otherTotal)}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {stage !== 'CLOSED' && statusLabel !== 'Closed' && (
            <p className="da-note" style={{ marginTop: 8 }}>Amounts before the Allocated stage are indicative.</p>
          )}
        </>
      )}
    </section>
  );
}
