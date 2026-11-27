'use client';

import { useState } from 'react';
import { ATTR } from '../lib/data';
import { fmtDay, fmtUsd, words } from '../lib/format';
import { countHow, onStatement } from '../lib/how';
import { investorRows, type Ctx } from '../lib/view';
import { Bound, BoundOr, Derived, Empty, RecordLink } from './common';
import { Caret, Metric } from './cells';

export const INVESTORS_TAB = {
  label: 'Investors',
  purpose: 'How each investor has done in each fund and across all of them, net of fees and carry, from their capital account statements over the chosen period.',
};

export function InvestorsTab({ ctx }: { ctx: Ctx }) {
  const rows = investorRows(ctx);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setClosed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  if (ctx.window.netExcluded) return <Empty>Investor figures come from capital accounts, which are not held by deal or sector. Clear the deal and sector filters to see them.</Empty>;
  if (!rows.length) return <Empty>No capital account statement falls in this period.</Empty>;
  return (
    <div className="x-frame">
      <table className="da-grid x-table">
        <thead>
          <tr>
            <th>Investor and funds</th>
            <th className="num">Commitment</th>
            <th className="num">Contributed</th>
            <th className="num">Distributed</th>
            <th className="num">NAV</th>
            <th className="num">Unfunded</th>
            <th className="num">Net IRR</th>
            <th className="num">TVPI</th>
            <th className="num">DPI</th>
            <th className="num">RVPI</th>
            <th>Last statement</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ investor, type, funds, commitment }) => {
            const open = !closed.has(investor.key);
            const unfunded = funds.map((f) => f.latest?.unfunded).filter((v): v is number => v != null);
            return [
              <tr key={investor.key} className="x-parent">
                <td>
                  <div className="x-namerow">
                    <Caret open={open} onToggle={() => toggle(investor.key)} label={`the funds of ${investor.label}`} />
                    <div className="x-namebox">
                      <RecordLink path={`/investors/${investor.key}`}>{investor.label}</RecordLink>
                      {type && <small><Bound entityId={investor.key} entityName={investor.label} domainCode="INVESTOR" code={ATTR.investorType} name="Investor type" value={type}>{words(type)}</Bound></small>}
                    </div>
                  </div>
                </td>
                <td className="num">{commitment != null
                  ? <Derived name={`Commitment, ${investor.label}`} how={() => countHow(`${investor.label} · Commitment`, 'Each fund’s commitment on the investor’s latest statement in the period, added up.', fmtUsd(commitment), funds.filter((f) => f.latest).map((f) => ({ label: f.group.label, value: fmtUsd(f.latest!.commitment), bind: onStatement(f.latest!, ATTR.commitment, 'Commitment') })))}>{fmtUsd(commitment)}</Derived>
                  : <span className="x-nil">—</span>}</td>
                <td className="num"><Metric ctx={ctx} group={investor} basis="net" k="paidIn" /></td>
                <td className="num"><Metric ctx={ctx} group={investor} basis="net" k="distributed" /></td>
                <td className="num"><Metric ctx={ctx} group={investor} basis="net" k="closing" /></td>
                <td className="num">{unfunded.length
                  ? <Derived name={`Unfunded, ${investor.label}`} how={() => countHow(`${investor.label} · Unfunded`, 'Each fund’s unfunded commitment on the investor’s latest statement in the period, added up.', fmtUsd(unfunded.reduce((a, b) => a + b, 0)), funds.filter((f) => f.latest).map((f) => ({ label: f.group.label, value: fmtUsd(f.latest!.unfunded), bind: onStatement(f.latest!, ATTR.unfunded, 'Unfunded commitment') })))}>{fmtUsd(unfunded.reduce((a, b) => a + b, 0))}</Derived>
                  : <span className="x-nil">—</span>}</td>
                <td className="num"><Metric ctx={ctx} group={investor} basis="net" k="irr" toned /></td>
                <td className="num"><Metric ctx={ctx} group={investor} basis="net" k="moic" /></td>
                <td className="num"><Metric ctx={ctx} group={investor} basis="net" k="dpi" /></td>
                <td className="num"><Metric ctx={ctx} group={investor} basis="net" k="rvpi" /></td>
                <td><span className="x-mut">{funds.length} fund{funds.length === 1 ? '' : 's'}</span></td>
              </tr>,
              ...(open ? funds.map(({ group, latest }) => (
                <tr key={`${investor.key}-${group.key}`} className="x-child">
                  <td><div className="x-namerow x-indent">{group.entityId ? <RecordLink path={`/funds/${group.entityId}/overview`}>{group.label}</RecordLink> : group.label}</div></td>
                  <td className="num">{latest ? <BoundOr bind={onStatement(latest, ATTR.commitment, 'Commitment') ?? null} value={latest.commitment} shown={fmtUsd(latest.commitment)} /> : <span className="x-nil">—</span>}</td>
                  <td className="num"><Metric ctx={ctx} group={group} basis="net" k="paidIn" /></td>
                  <td className="num"><Metric ctx={ctx} group={group} basis="net" k="distributed" /></td>
                  <td className="num">{latest ? <BoundOr bind={onStatement(latest, ATTR.closing, 'Closing balance') ?? null} value={latest.closing} shown={fmtUsd(latest.closing)} /> : <span className="x-nil">—</span>}</td>
                  <td className="num">{latest ? <BoundOr bind={onStatement(latest, ATTR.unfunded, 'Unfunded commitment') ?? null} value={latest.unfunded} shown={fmtUsd(latest.unfunded)} /> : <span className="x-nil">—</span>}</td>
                  <td className="num"><Metric ctx={ctx} group={group} basis="net" k="irr" toned /></td>
                  <td className="num"><Metric ctx={ctx} group={group} basis="net" k="moic" /></td>
                  <td className="num"><Metric ctx={ctx} group={group} basis="net" k="dpi" /></td>
                  <td className="num"><Metric ctx={ctx} group={group} basis="net" k="rvpi" /></td>
                  <td>{latest ? <BoundOr bind={onStatement(latest, ATTR.periodEnd, 'Period end') ?? null} value={latest.periodEnd} shown={fmtDay(latest.periodEnd)} /> : <span className="x-nil">—</span>}</td>
                </tr>
              )) : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
