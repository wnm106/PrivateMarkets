'use client';

import type { Book, Kpi, Vehicle } from '../lib/data';
import { kpiHow } from '../lib/how';
import { fmtMeasure, fmtPct } from '../lib/format';
import { kpiKey } from '../lib/view';
import { Derived, Gauge, StatusPill } from './common';
import { KpiCell } from './VehiclesTab';

export const KPI_TAB = {
  label: 'KPIs',
  purpose: 'The headline measures the indenture holds the open CLO to (WARF, WAS, WAL, WARR, diversity, the CCC bucket, and OC and IC by class), each against its limit, and the same measures across every CLO.',
};

const TONE: Record<string, string> = { PASS: 'ok', HARD_BREACH: 'breach', SOFT_BREACH: 'near' };

/** One measure against its limit. */
function KpiCard({ v, asOf, k }: { v: Vehicle; asOf: string; k: Kpi }) {
  const cushion = k.cushion == null ? null : k.metric === 'OC' || k.metric === 'IC' || k.metric === 'CCC' ? fmtPct(k.cushion) : fmtMeasure(k.metric, k.cushion);
  return (
    <div className={`x-card ${TONE[k.status] || 'na'}`}>
      <header><b>{k.label}</b><StatusPill status={k.status} /></header>
      <span className="x-big">{k.value == null ? <span className="x-nil">—</span> : <Derived name={`${v.name} ${k.label}`} how={() => kpiHow(v, asOf, k)}>{fmtMeasure(k.metric, k.value)}</Derived>}</span>
      <Gauge value={k.value} limit={k.limit} direction={k.direction} />
      <dl>
        <dt>{k.direction === 'MIN' ? 'Minimum' : 'Maximum'}</dt>
        <dd>{k.limit == null ? <span className="x-nil">—</span> : <Derived name={`${k.label} limit`} how={() => kpiHow(v, asOf, k)}>{fmtMeasure(k.metric, k.limit)}</Derived>}</dd>
        <dt>Cushion</dt>
        <dd className={k.cushion != null && k.cushion < 0 ? 'x-dn' : undefined}>{cushion == null ? <span className="x-nil">—</span> : <Derived name={`${k.label} cushion`} how={() => kpiHow(v, asOf, k)}>{cushion}</Derived>}</dd>
        <dt>Cushion, share of limit</dt>
        <dd>{k.cushionPct == null ? <span className="x-nil">—</span> : <Derived name={`${k.label} cushion share`} how={() => kpiHow(v, asOf, k)}>{fmtPct(k.cushionPct, 1)}</Derived>}</dd>
      </dl>
    </div>
  );
}

export function KpiTab({ book, v }: { book: Book; v: Vehicle }) {
  const asOf = book.asOfDate;
  const quality = v.kpis.filter((k) => k.rank == null);
  const coverage = v.kpis.filter((k) => k.rank != null);
  // Rows of the cross-CLO matrix: every measure any CLO has, quality first, then coverage by rank.
  const rows: Array<{ key: string; label: string; metric: Kpi['metric']; rank: number | null }> = [];
  for (const veh of book.vehicles) for (const k of veh.kpis) if (!rows.some((r) => r.key === kpiKey(k))) rows.push({ key: kpiKey(k), label: k.rank == null ? k.label : `${k.metric} rank ${k.rank}`, metric: k.metric, rank: k.rank });
  rows.sort((a, b) => (a.rank ?? -1) - (b.rank ?? -1) || (a.metric === 'OC' ? -1 : 1));
  return (
    <>
      <div className="x-section">
        <h2>Collateral quality</h2>
        <p>Each measure as the compliance engine scores it (diversity is worked out by the platform), against the limit in the indenture. The bar shows how much of the limit is used.</p>
        <div className="x-cards">{quality.map((k) => <KpiCard key={kpiKey(k)} v={v} asOf={asOf} k={k} />)}</div>
      </div>
      <div className="x-section">
        <h2>Coverage tests</h2>
        <p>Overcollateralization and interest coverage for each class, against the class trigger. A test for a class covers every class ranked with or above it.</p>
        {coverage.length ? <div className="x-cards">{coverage.map((k) => <KpiCard key={kpiKey(k)} v={v} asOf={asOf} k={k} />)}</div> : <p className="x-note">The engine scored no coverage test for this CLO.</p>}
      </div>
      <div className="x-section">
        <h2>Across every CLO</h2>
        <p>The same measures for each CLO. Red is past its limit. Coverage tests are listed by the seniority rank they cover, since class letters differ between deals.</p>
        <div className="x-frame">
          <table className="da-grid x-table">
            <thead>
              <tr>
                <th className="x-name">Measure</th>
                {book.vehicles.map((veh) => <th key={veh.id} className="num">{veh.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="x-name">{r.label}</td>
                  {book.vehicles.map((veh) => {
                    const k = veh.kpis.find((x) => kpiKey(x) === r.key) ?? null;
                    return <td key={veh.id} className="num"><KpiCell v={veh} asOf={asOf} k={k} /></td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
