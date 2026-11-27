'use client';

import { useState } from 'react';
import { ATTR } from '../lib/data';
import { countHow } from '../lib/how';
import { words } from '../lib/format';
import { dealRows, type Ctx } from '../lib/view';
import { BoundOr, Derived, Empty, RecordLink } from './common';
import { Caret, GROSS_COLUMNS, Metric } from './cells';

export const DEALS_TAB = {
  label: 'Deals',
  purpose: 'How each deal has performed across every fund that holds it, and in each fund, over the chosen period.',
};

export function DealsTab({ ctx }: { ctx: Ctx }) {
  const rows = dealRows(ctx);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setClosed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  if (!rows.length) return <Empty>No deal has a position with a cash flow in this period. A deal appears here once a fund holds one of its tranches.</Empty>;
  return (
    <div className="x-frame">
      <table className="da-grid x-table">
        <thead>
          <tr>
            <th>Deal and holding funds</th>
            <th>Sector</th>
            <th className="num">Funds</th>
            {GROSS_COLUMNS.map((c) => <th key={c.k} className="num">{c.label}</th>)}
            <th className="num">DPI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ deal, sector, funds }) => {
            const open = !closed.has(deal.key);
            return [
              <tr key={deal.key} className="x-parent">
                <td>
                  <div className="x-namerow">
                    <Caret open={open} onToggle={() => toggle(deal.key)} label={`the funds holding ${deal.label}`} />
                    <RecordLink path={`/deals/${deal.key}`}>{deal.label}</RecordLink>
                  </div>
                </td>
                <td><BoundOr bind={{ entityId: deal.key, entityName: deal.label, domainCode: 'DEAL', code: ATTR.dealSector, name: 'Deal sector' }} value={sector} shown={words(sector)} /></td>
                <td className="num">
                  <Derived name={`Funds holding ${deal.label}`} how={() => countHow(`${deal.label} · Funds holding it`, 'Funds with a measured position on one of the deal’s tranches.', String(funds.length), funds.map((f) => ({ label: f.label, value: `${f.positionIds.length} position${f.positionIds.length === 1 ? '' : 's'}` })))}>{funds.length}</Derived>
                </td>
                {GROSS_COLUMNS.map((c) => <td key={c.k} className="num"><Metric ctx={ctx} group={deal} basis="gross" k={c.k} toned={c.toned} /></td>)}
                <td className="num"><Metric ctx={ctx} group={deal} basis="gross" k="dpi" /></td>
              </tr>,
              ...(open ? funds.map((f) => (
                <tr key={`${deal.key}-${f.key}`} className="x-child">
                  <td><div className="x-namerow x-indent">{f.entityId ? <RecordLink path={`/funds/${f.entityId}/overview`}>{f.label}</RecordLink> : f.label}</div></td>
                  <td />
                  <td className="num">
                    <Derived name={`Positions of ${f.label} in ${deal.label}`} how={() => countHow(`${f.label} in ${deal.label} · Positions`, 'Measured positions this fund holds on the deal’s tranches.', String(f.positionIds.length), f.positionIds.map((id) => ({ label: ctx.position.get(id)?.name || id, value: '' })))}>{f.positionIds.length}</Derived>
                  </td>
                  {GROSS_COLUMNS.map((c) => <td key={c.k} className="num"><Metric ctx={ctx} group={f} basis="gross" k={c.k} toned={c.toned} /></td>)}
                  <td className="num"><Metric ctx={ctx} group={f} basis="gross" k="dpi" /></td>
                </tr>
              )) : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
