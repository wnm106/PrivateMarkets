'use client';

import type { Vehicle } from '../lib/data';
import { ATTR } from '../lib/data';
import { onTxn } from '../lib/binds';
import { collateralHow, countHow, diversityHow, kpiHow } from '../lib/how';
import { fmtDay, fmtMeasure, fmtPct, fmtUsd, fmtYears } from '../lib/format';
import { headline, juniorOc } from '../lib/view';
import { BoundOr, Derived } from './common';

/** The open CLO's headline figures. */
export function Ribbon({ v, asOf }: { v: Vehicle; asOf: string }) {
  const c = v.collateral;
  const kpi = (metric: 'WARF' | 'WAS' | 'WAL' | 'CCC') => {
    const k = headline(v, metric);
    return k?.value == null ? <span className="x-nil">—</span> : <Derived name={`${v.name} ${k.label}`} how={() => kpiHow(v, asOf, k)}>{fmtMeasure(metric, k.value)}</Derived>;
  };
  const junior = juniorOc(v);
  return (
    <div className="da-ribbon x-ribbon">
      <div className="da-fact">
        <span>Collateral par</span>
        <strong><Derived name="Collateral par" how={() => collateralHow(v, 'par')}>{fmtUsd(c.par)}</Derived></strong>
        <small><Derived name="Holdings" how={() => collateralHow(v, 'count')}>{c.count}</Derived> holdings</small>
      </div>
      <div className="da-fact">
        <span>Notes outstanding</span>
        <strong><Derived name="Notes outstanding" how={() => collateralHow(v, 'notesPar')}>{fmtUsd(c.notesPar)}</Derived></strong>
        <small>{v.notes.length} classes</small>
      </div>
      <div className="da-fact"><span>WARF</span><strong>{kpi('WARF')}</strong><small>limit {fmtMeasure('WARF', headline(v, 'WARF')?.limit)}</small></div>
      <div className="da-fact"><span>WAS</span><strong>{kpi('WAS')}</strong><small>minimum {fmtMeasure('WAS', headline(v, 'WAS')?.limit)}</small></div>
      <div className="da-fact"><span>WAL</span><strong>{kpi('WAL')}</strong><small>limit {fmtMeasure('WAL', headline(v, 'WAL')?.limit)}</small></div>
      <div className="da-fact">
        <span>Diversity</span>
        <strong>{v.diversity.score == null ? <span className="x-nil">—</span> : <Derived name="Diversity score" how={() => diversityHow(v)}>{fmtMeasure('DIVERSITY', v.diversity.score)}</Derived>}</strong>
        <small>minimum {fmtMeasure('DIVERSITY', v.diversity.limit)}</small>
      </div>
      <div className="da-fact"><span>CCC bucket</span><strong>{kpi('CCC')}</strong><small>limit {fmtPct(headline(v, 'CCC')?.limit)}</small></div>
      <div className="da-fact">
        <span>Junior OC cushion</span>
        <strong className={junior && (junior.cushion ?? 0) < 0 ? 'x-dn' : undefined}>
          {junior?.cushion == null ? <span className="x-nil">—</span> : <Derived name={`${junior.label} cushion`} how={() => kpiHow(v, asOf, junior)}>{fmtPct(junior.cushion)}</Derived>}
        </strong>
        <small>{junior ? junior.label : 'no OC test'}</small>
      </div>
      <div className="da-fact">
        <span>Tests</span>
        <strong className={v.summary.breaches ? 'x-dn' : undefined}>
          <Derived name="Tests in breach" how={() => countHow(`${v.name} · Tests`, `${v.summary.breaches} in breach`, 'Every line the compliance engine scored for this CLO. A grouped test (industry, obligor) counts once per group.', [
            { label: 'In breach', value: String(v.summary.breaches) },
            { label: 'Warning', value: String(v.summary.warnings) },
            { label: 'Passing', value: String(v.summary.passing) },
            { label: 'No data', value: String(v.summary.noData) },
          ])}>{v.summary.breaches}</Derived> <small>in breach</small>
        </strong>
        <small>of {v.summary.tests} scored</small>
      </div>
      <div className="da-fact">
        <span>Reinvestment ends</span>
        <strong><BoundOr bind={onTxn(v, ATTR.reinvestmentEnd, 'Reinvestment period end')} value={v.reinvestmentEnd} shown={fmtDay(v.reinvestmentEnd)} /></strong>
        <small>{v.phase || 'phase unknown'}{v.yearsToReinvestmentEnd != null && v.yearsToReinvestmentEnd > 0 ? `, ${fmtYears(v.yearsToReinvestmentEnd)} left` : ''}</small>
      </div>
    </div>
  );
}
