'use client';

import type { Book, Kpi, Vehicle } from '../lib/data';
import { ATTR } from '../lib/data';
import { onTxn, recordPath } from '../lib/binds';
import { collateralHow, countHow, kpiHow } from '../lib/how';
import { fmtDay, fmtMeasure, fmtPct, fmtTest, fmtUsd } from '../lib/format';
import { headline, juniorOc } from '../lib/view';
import { BoundOr, Derived, Empty, RecordLink } from './common';

export const VEHICLES_TAB = {
  label: 'Vehicles',
  purpose: 'Every CLO vehicle side by side: size, phase, the headline quality measures, the most junior OC cushion and how many tests are in breach.',
};

/** One measure for one CLO, from the engine, coloured when it is past its limit. */
export function KpiCell({ v, asOf, k }: { v: Vehicle; asOf: string; k: Kpi | null }) {
  if (!k || k.value == null) return <span className="x-nil">—</span>;
  const tone = k.status === 'HARD_BREACH' ? 'x-dn' : undefined;
  return <Derived className={tone} name={`${v.name} ${k.label}`} how={() => kpiHow(v, asOf, k)}>{fmtMeasure(k.metric, k.value)}</Derived>;
}

export function VehiclesTab({ book, selected, onSelect }: { book: Book; selected: string | null; onSelect: (id: string) => void }) {
  const asOf = book.asOfDate;
  if (!book.vehicles.length) return <Empty>No fund has a CLO transaction record. A fund is a CLO here when it has indenture terms (a CLO Transaction linked by FUND_CLO_TRANSACTION).</Empty>;
  const t = book.totals;
  return (
    <div className="x-frame">
      <table className="da-grid x-table">
        <thead>
          <tr>
            <th className="x-name">CLO</th>
            <th>Phase</th>
            <th className="num">Collateral par</th>
            <th className="num">Notes</th>
            <th className="num" title="Weighted average rating factor">WARF</th>
            <th className="num" title="Weighted average spread">WAS</th>
            <th className="num" title="Weighted average life">WAL</th>
            <th className="num" title="Weighted average recovery rate">WARR</th>
            <th className="num">Diversity</th>
            <th className="num">CCC</th>
            <th className="num" title="Cushion on the most junior overcollateralization test, in points">Junior OC cushion</th>
            <th className="num">Breaches</th>
            <th>Next payment</th>
          </tr>
        </thead>
        <tbody>
          <tr className="x-total">
            <td className="x-name"><b>All CLOs</b><small className="x-mut"> · {t.vehicles}</small></td>
            <td />
            <td className="num"><Derived name="Collateral par, all CLOs" how={() => countHow('All CLOs · Collateral par', fmtUsd(t.collateralPar), 'Collateral par of every CLO, added up.', book.vehicles.map((v) => ({ label: v.name, value: fmtUsd(v.collateral.par) })))}>{fmtUsd(t.collateralPar)}</Derived></td>
            <td className="num"><Derived name="Notes, all CLOs" how={() => countHow('All CLOs · Notes outstanding', fmtUsd(t.notesPar), 'Par outstanding of every note class of every CLO, added up.', book.vehicles.map((v) => ({ label: v.name, value: fmtUsd(v.collateral.notesPar) })))}>{fmtUsd(t.notesPar)}</Derived></td>
            <td colSpan={7} />
            <td className="num"><Derived name="Breaches, all CLOs" how={() => countHow('All CLOs · Breaches', String(t.breaches), 'Tests in breach on each CLO, added up.', book.vehicles.map((v) => ({ label: v.name, value: String(v.summary.breaches) })))}>{t.breaches}</Derived></td>
            <td />
          </tr>
          {book.vehicles.map((v) => {
            const junior = juniorOc(v);
            return (
              <tr key={v.id} className={`x-click${selected === v.id ? ' x-on' : ''}`} onClick={() => onSelect(v.id)} aria-selected={selected === v.id}>
                <td className="x-name">
                  <div className="x-namebox">
                    <RecordLink path={recordPath.fund(v.id)}>{v.name}</RecordLink>
                    <small><BoundOr bind={onTxn(v, ATTR.manager, 'Collateral manager')} value={v.manager} shown={v.manager || ''} /></small>
                  </div>
                </td>
                <td>{v.phase || <span className="x-nil">—</span>}</td>
                <td className="num"><Derived name={`${v.name} collateral par`} how={() => collateralHow(v, 'par')}>{fmtUsd(v.collateral.par)}</Derived></td>
                <td className="num"><Derived name={`${v.name} notes`} how={() => collateralHow(v, 'notesPar')}>{fmtUsd(v.collateral.notesPar)}</Derived></td>
                <td className="num"><KpiCell v={v} asOf={asOf} k={headline(v, 'WARF')} /></td>
                <td className="num"><KpiCell v={v} asOf={asOf} k={headline(v, 'WAS')} /></td>
                <td className="num"><KpiCell v={v} asOf={asOf} k={headline(v, 'WAL')} /></td>
                <td className="num"><KpiCell v={v} asOf={asOf} k={headline(v, 'WARR')} /></td>
                <td className="num"><KpiCell v={v} asOf={asOf} k={headline(v, 'DIVERSITY')} /></td>
                <td className="num"><KpiCell v={v} asOf={asOf} k={headline(v, 'CCC')} /></td>
                <td className="num">
                  {junior?.cushion == null ? <span className="x-nil">—</span> : (
                    <Derived className={junior.cushion < 0 ? 'x-dn' : undefined} name={`${v.name} ${junior.label} cushion`} how={() => kpiHow(v, asOf, junior)}>{fmtPct(junior.cushion)}</Derived>
                  )}
                </td>
                <td className="num">
                  <Derived className={v.summary.breaches ? 'x-dn' : undefined} name={`${v.name} breaches`} how={() => countHow(`${v.name} · Tests in breach`, String(v.summary.breaches), 'Lines the compliance engine scored past their limit.', v.tests.filter((x) => x.status === 'HARD_BREACH').slice(0, 14).map((x) => ({ label: x.ruleName, sub: x.group || undefined, value: fmtTest(x, x.value) })))}>{v.summary.breaches}</Derived>
                </td>
                <td><BoundOr bind={onTxn(v, ATTR.nextPayment, 'Next payment date')} value={v.nextPayment} shown={fmtDay(v.nextPayment)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
