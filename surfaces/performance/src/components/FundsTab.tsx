'use client';

import { useState } from 'react';
import type { Fund, Group } from '../lib/data';
import { ATTR } from '../lib/data';
import { fmtPctValue, words } from '../lib/format';
import { familyRows, type Ctx } from '../lib/view';
import { BoundOr, Empty, RecordLink, type BindTarget } from './common';
import { Caret, GROSS_COLUMNS, Metric, Spread } from './cells';

const onFund = (f: Fund, code: string, name: string): BindTarget => ({ entityId: f.id, entityName: f.name, domainCode: 'FUND', code, name });

export const FUNDS_TAB = {
  label: 'Funds',
  purpose: 'How each fund family and each of its vehicles has performed, gross from its positions and net to its investors, over the chosen period.',
};

function FundCells({ ctx, group, fund }: { ctx: Ctx; group: Group; fund: Fund | undefined }) {
  return (
    <>
      {GROSS_COLUMNS.map((c) => <td key={c.k} className="num"><Metric ctx={ctx} group={group} basis="gross" k={c.k} toned={c.toned} /></td>)}
      <td className="num x-sep"><Metric ctx={ctx} group={group} basis="net" k="irr" toned /></td>
      <td className="num"><Metric ctx={ctx} group={group} basis="net" k="moic" /></td>
      <td className="num"><Metric ctx={ctx} group={group} basis="net" k="dpi" /></td>
      <td className="num"><Spread ctx={ctx} group={group} /></td>
      <td className="num">{fund ? <BoundOr bind={onFund(fund, ATTR.netIrr, 'Net IRR (reported)')} value={fund.reportedNetIrr} shown={fmtPctValue(fund.reportedNetIrr)} /> : <span className="x-nil">—</span>}</td>
    </>
  );
}

function NameCell({ fund, label, sub }: { fund: Fund | undefined; label: string; sub?: boolean }) {
  return (
    <div className="x-namebox">
      {fund ? <RecordLink path={`/funds/${fund.id}/overview`}>{label}</RecordLink> : <b>{label}</b>}
      {fund && (fund.vintage || fund.strategy) && (
        <small>
          {fund.vintage && <BoundOr bind={onFund(fund, ATTR.vintage, 'Vintage')} value={fund.vintage} shown={fund.vintage} />}
          {fund.vintage && fund.strategy && ' · '}
          {fund.strategy && <BoundOr bind={onFund(fund, ATTR.strategy, 'Strategy')} value={fund.strategy} shown={words(fund.strategy)} />}
        </small>
      )}
      {sub && !fund && <small>Vehicle</small>}
    </div>
  );
}

export function FundsTab({ ctx }: { ctx: Ctx }) {
  const rows = familyRows(ctx);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setClosed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  if (!rows.length) return <Empty>No fund has positions with cash flows or capital account statements in this period.</Empty>;
  return (
    <div className="x-frame">
      <table className="da-grid x-table">
        <thead>
          <tr>
            <th>Fund family and vehicles</th>
            {GROSS_COLUMNS.map((c) => <th key={c.k} className="num">{c.label}</th>)}
            <th className="num x-sep">Net IRR</th>
            <th className="num">TVPI</th>
            <th className="num">DPI</th>
            <th className="num" title="Gross IRR less net IRR">Gross to net</th>
            <th className="num" title="The fund's FUND_NET_IRR attribute, as reported">Reported net IRR</th>
          </tr>
        </thead>
        <tbody>
          <tr className="x-total">
            <td><b>Firm total</b><small className="x-block">{rows.length} famil{rows.length === 1 ? 'y' : 'ies'}</small></td>
            <FundCells ctx={ctx} group={ctx.window.total} fund={undefined} />
          </tr>
          {rows.map(({ family, fund, vehicles }) => {
            const single = vehicles.length === 1 && vehicles[0].key === family.key;
            const open = !closed.has(family.key);
            return [
              <tr key={family.key} className="x-parent">
                <td>
                  <div className="x-namerow">
                    {single ? <span className="x-sp" /> : <Caret open={open} onToggle={() => toggle(family.key)} label={`the vehicles of ${family.label}`} />}
                    <NameCell fund={fund} label={family.label} />
                  </div>
                </td>
                <FundCells ctx={ctx} group={family} fund={fund} />
              </tr>,
              ...(!single && open ? vehicles.map((v) => (
                <tr key={`${family.key}-${v.key}`} className="x-child">
                  <td><div className="x-namerow x-indent"><NameCell fund={ctx.fund.get(v.key)} label={v.label} sub /></div></td>
                  <FundCells ctx={ctx} group={v} fund={ctx.fund.get(v.key)} />
                </tr>
              )) : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
