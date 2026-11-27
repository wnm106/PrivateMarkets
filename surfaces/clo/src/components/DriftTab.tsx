'use client';

import type { Drift, DriftPoint, Kpi, Vehicle } from '../lib/data';
import { countHow } from '../lib/how';
import { fmtDay, fmtMeasure, fmtMeasureChange, fmtPct, fmtQuarter, fmtUsd } from '../lib/format';
import { kpiKey } from '../lib/view';
import { Derived, Empty, ErrorPanel, Loading, StatusPill, Trend } from './common';

export const DRIFT_TAB = {
  label: 'Drift',
  purpose: 'How the open CLO’s headline measures have moved quarter by quarter to the As Of date, each against its limit, and which way each is drifting.',
};

export interface Series { key: string; label: string; metric: Kpi['metric']; direction: 'MAX' | 'MIN'; values: Array<Kpi | null> }

/** One line per measure across the points, in the order of the latest point. */
export function driftSeries(drift: Drift): Series[] {
  const last = drift.points[drift.points.length - 1];
  if (!last) return [];
  return last.kpis.map((k) => ({
    key: kpiKey(k), label: k.label, metric: k.metric, direction: k.direction,
    values: drift.points.map((p) => p.kpis.find((x) => kpiKey(x) === kpiKey(k)) ?? null),
  }));
}

/** The change from the first point to the last, signed so that positive is better. */
export function improvement(s: Series): number | null {
  const first = s.values.find((v) => v?.value != null)?.value;
  const last = [...s.values].reverse().find((v) => v?.value != null)?.value;
  if (first == null || last == null) return null;
  return s.direction === 'MIN' ? last - first : first - last;
}

const pointHow = (v: Vehicle, p: DriftPoint, k: Kpi) => () => countHow(
  `${v.name} · ${k.label} · ${fmtQuarter(p.date)}`,
  fmtMeasure(k.metric, k.value),
  `${k.metric === 'DIVERSITY' ? 'Worked out by the platform from the holdings' : 'Scored by the compliance engine'} as of ${fmtDay(p.date)}, on the book as it stood that day, as known at the Knowledge date. The limit is the one in force that day.`,
  [
    { label: k.direction === 'MIN' ? 'Minimum' : 'Maximum', value: fmtMeasure(k.metric, k.limit) },
    { label: 'Cushion', value: k.cushion == null ? '—' : fmtMeasureChange(k.metric, k.cushion) },
    { label: 'Status', value: k.status },
    { label: 'Collateral par that day', value: fmtUsd(p.collateralPar) },
  ],
);

export function DriftTab({ v, drift, loading, error, onRetry }: { v: Vehicle; drift: Drift | null; loading: boolean; error: string | null; onRetry: () => void }) {
  if (error && !drift) return <ErrorPanel message={`Could not load the history: ${error}`} onRetry={onRetry} />;
  if (!drift) return <Loading text={loading ? `Scoring ${v.name} at each quarter end…` : 'The history loads after the book.'} />;
  if (drift.points.length < 2) return <Empty>Only one date could be scored, so there is no drift to show.</Empty>;
  const series = driftSeries(drift);
  const first = drift.points[0];
  const last = drift.points[drift.points.length - 1];
  return (
    <>
      {loading && <p className="x-note" role="status">Refreshing…</p>}
      <div className="x-section">
        <h2>Drift since {fmtQuarter(first.date)}</h2>
        <p>Each measure scored at every quarter end and at the As Of date. The dashed red line is the limit in force at each date. The change is signed so that a positive number is an improvement; a card with an amber top is drifting the wrong way, a red one is past its limit today.</p>
        <div className="x-cards">
          {series.map((s) => {
            const gain = improvement(s);
            const latest = s.values[s.values.length - 1];
            const breaches = s.values.filter((x) => x?.status === 'HARD_BREACH').length;
            return (
              <div key={s.key} className={`x-card ${latest?.status === 'HARD_BREACH' ? 'breach' : gain != null && gain < 0 ? 'near' : 'ok'}`}>
                <header><b>{s.label}</b><StatusPill status={latest?.status} /></header>
                <Trend points={s.values.map((x) => x?.value ?? null)} limit={s.values.map((x) => x?.limit ?? null)} />
                <dl>
                  <dt>{fmtQuarter(first.date)}</dt>
                  <dd>{s.values[0]?.value == null ? <span className="x-nil">—</span> : <Derived name={`${s.label} at ${first.date}`} how={pointHow(v, first, s.values[0]!)}>{fmtMeasure(s.metric, s.values[0]!.value)}</Derived>}</dd>
                  <dt>{fmtQuarter(last.date)}</dt>
                  <dd>{latest?.value == null ? <span className="x-nil">—</span> : <Derived name={`${s.label} at ${last.date}`} how={pointHow(v, last, latest)}>{fmtMeasure(s.metric, latest.value)}</Derived>}</dd>
                  <dt>Change, better is positive</dt>
                  <dd className={gain == null ? undefined : gain < 0 ? 'x-dn' : 'x-up'}>{gain == null ? <span className="x-nil">—</span> : <Derived name={`${s.label} change`} how={() => countHow(`${v.name} · ${s.label} · Change`, fmtMeasureChange(s.metric, gain), `The latest value less the first, turned around for a maximum so that a positive change is always an improvement.`, s.values.map((x, i) => ({ label: fmtQuarter(drift.points[i].date), value: fmtMeasure(s.metric, x?.value) })))}>{fmtMeasureChange(s.metric, gain)}</Derived>}</dd>
                  <dt>Dates in breach</dt>
                  <dd><Derived name={`${s.label} dates in breach`} how={() => countHow(`${v.name} · ${s.label} · Dates in breach`, String(breaches), 'How many of the scored dates the measure was past its limit.', s.values.map((x, i) => ({ label: fmtQuarter(drift.points[i].date), value: x?.status || 'NO_DATA' })))}>{breaches}</Derived> <span className="x-mut">of {s.values.length}</span></dd>
                </dl>
              </div>
            );
          })}
        </div>
      </div>
      <div className="x-section">
        <h2>By date</h2>
        <div className="x-frame">
          <table className="da-grid x-table">
            <thead>
              <tr>
                <th className="x-name">Measure</th>
                {drift.points.map((p) => <th key={p.date} className="num">{fmtQuarter(p.date)}</th>)}
              </tr>
            </thead>
            <tbody>
              {series.map((s) => (
                <tr key={s.key}>
                  <td className="x-name">{s.label}</td>
                  {s.values.map((x, i) => (
                    <td key={drift.points[i].date} className="num">
                      {x?.value == null ? <span className="x-nil">—</span> : <Derived className={x.status === 'HARD_BREACH' ? 'x-dn' : undefined} name={`${s.label} at ${drift.points[i].date}`} how={pointHow(v, drift.points[i], x)}>{fmtMeasure(s.metric, x.value)}</Derived>}
                    </td>
                  ))}
                </tr>
              ))}
              {([
                ['Collateral par', (p: DriftPoint) => fmtUsd(p.collateralPar), 'Funded par of every holding that day.'],
                ['Defaulted par', (p: DriftPoint) => fmtUsd(p.defaultedPar), 'Funded par of holdings flagged defaulted that day.'],
                ['Rated notes', (p: DriftPoint) => fmtUsd(p.ratedNotesPar), 'Par outstanding of every rated class that day.'],
                ['CCC share of par', (p: DriftPoint) => fmtPct(p.cccPct), 'Performing par flagged CCC over performing par that day.'],
                ['Residual to equity', (p: DriftPoint) => fmtUsd(p.residualToEquity), 'What the waterfall would pay the subordinated notes on the payment date after that day.'],
                ['Interest diverted', (p: DriftPoint) => fmtUsd(p.diverted), 'Interest the waterfall would divert to cure coverage tests on the payment date after that day.'],
              ] as Array<[string, (p: DriftPoint) => string, string]>).map(([label, shown, formula]) => (
                <tr key={label}>
                  <td className="x-name">{label}</td>
                  {drift.points.map((p) => <td key={p.date} className="num"><Derived name={`${label} at ${p.date}`} how={() => countHow(`${v.name} · ${label} · ${fmtQuarter(p.date)}`, shown(p), formula)}>{shown(p)}</Derived></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {drift.errors.length > 0 && <p className="x-note">Some dates could not be scored in full: {drift.errors.slice(0, 3).join('; ')}</p>}
      </div>
    </>
  );
}
