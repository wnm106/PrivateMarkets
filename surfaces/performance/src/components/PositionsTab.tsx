'use client';

import { useMemo, useState } from 'react';
import type { Position } from '../lib/data';
import { ATTR } from '../lib/data';
import { words } from '../lib/format';
import { positionRows, type Ctx } from '../lib/view';
import { countHow } from '../lib/how';
import { BoundOr, Derived, Empty, RecordLink, type BindTarget } from './common';
import { GROSS_COLUMNS, Metric } from './cells';

export const POSITIONS_TAB = {
  label: 'Positions',
  purpose: 'How each measured position has performed over the chosen period: what was put in, what came back, what it is worth and its IRR and multiple.',
};

/** The sector a position is grouped under: its issuer's SECTOR, else its deal's DEAL_SECTOR. */
export function sectorBind(p: Position, dealName?: string): BindTarget | null {
  if (p.sectorFrom === 'ISSUER' && p.issuerId) return { entityId: p.issuerId, entityName: p.issuerName || undefined, domainCode: 'ISSUER', code: ATTR.issuerSector, name: 'Sector' };
  if (p.sectorFrom === 'DEAL' && p.dealId) return { entityId: p.dealId, entityName: dealName, domainCode: 'DEAL', code: ATTR.dealSector, name: 'Deal sector' };
  return null;
}

export function PositionsTab({ ctx }: { ctx: Ctx }) {
  const all = positionRows(ctx);
  const [fund, setFund] = useState('');
  const [sector, setSector] = useState('');
  const [search, setSearch] = useState('');
  const funds = useMemo(() => [...new Set(all.map((r) => r.position.fundId))].map((id) => ({ id, name: ctx.fund.get(id)?.name || id })).sort((a, b) => a.name.localeCompare(b.name)), [all, ctx]);
  const sectors = useMemo(() => [...new Set(all.map((r) => r.position.sector || 'Unclassified'))].sort(), [all]);
  const needle = search.trim().toLowerCase();
  const rows = all.filter(({ position: p }) => (!fund || p.fundId === fund) && (!sector || (p.sector || 'Unclassified') === sector)
    && (!needle || [p.name, p.issuerName, ctx.deal.get(p.dealId || '')?.name].some((t) => t && t.toLowerCase().includes(needle))));
  if (!all.length) return <Empty>No position has a cash flow or a deal tranche in this period.</Empty>;
  return (
    <>
      <div className="x-toolbar">
        <label>Fund <select value={fund} onChange={(e) => setFund(e.target.value)}><option value="">All funds</option>{funds.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label>Sector <select value={sector} onChange={(e) => setSector(e.target.value)}><option value="">All sectors</option>{sectors.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label>Find <input className="x-search" value={search} placeholder="Position, issuer or deal" onChange={(e) => setSearch(e.target.value)} /></label>
        <span className="x-note">
          Showing <Derived name="Positions shown" how={() => countHow('Positions shown', `Measured positions that match the fund, sector and text you chose, out of ${all.length} measured in this period.`, String(rows.length))}>{rows.length}</Derived> of {all.length} measured
        </span>
      </div>
      {!rows.length ? <Empty>No measured position matches. Clear a filter to see more.</Empty> : (
        <div className="x-frame">
          <table className="da-grid x-table">
            <thead>
              <tr>
                <th>Position</th>
                <th>Fund</th>
                <th>Deal</th>
                <th>Sector</th>
                {GROSS_COLUMNS.map((c) => <th key={c.k} className="num">{c.label}</th>)}
                <th className="num">DPI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ group, position: p }) => {
                const deal = p.dealId ? ctx.deal.get(p.dealId) : undefined;
                const f = ctx.fund.get(p.fundId);
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="x-namebox">
                        <RecordLink path={`/positions/${p.id}`}>{p.name}</RecordLink>
                        {p.issuerName && p.issuerId && <small><RecordLink path={`/issuers/${p.issuerId}`}>{p.issuerName}</RecordLink></small>}
                      </div>
                    </td>
                    <td>{f ? <RecordLink path={`/funds/${f.id}/overview`}>{f.name}</RecordLink> : '—'}</td>
                    <td>{deal ? <RecordLink path={`/deals/${deal.id}`}>{deal.name}</RecordLink> : <span className="x-nil">—</span>}</td>
                    <td><BoundOr bind={sectorBind(p, deal?.name)} value={p.sector} shown={words(p.sector)} /></td>
                    {GROSS_COLUMNS.map((c) => <td key={c.k} className="num"><Metric ctx={ctx} group={group} basis="gross" k={c.k} toned={c.toned} /></td>)}
                    <td className="num"><Metric ctx={ctx} group={group} basis="gross" k="dpi" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
