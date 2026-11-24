'use client';

import { useState } from 'react';
import type { Fund, OcioData } from '../lib/types';
import { fmtDate, fmtUsd, fmtX, parseMeasure } from '../lib/format';
import { endOf, velocityTone, type Pacing } from '../lib/pacing';
import type { FundSummary } from '../lib/summary';
import { fundBind, yearTargetBind } from '../lib/binds';
import { cumVelocityHow, deployedHow, velocityHow } from '../lib/how';
import { Bound, Derived, Empty, useInputInspect, type BindTarget } from './common';

const TONE: Record<string, string> = { bad: 'breach', warn: 'near', ok: 'ok', ahead: 'ok', '': 'na' };

function YearInput({ value, placeholder, label, disabled, bind, onCommit }: { value: number | null; placeholder: string; label: string; disabled: boolean; bind: BindTarget; onCommit: (v: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const menu = useInputInspect(bind, value != null ? fmtUsd(value) : placeholder);
  const commit = () => {
    if (draft == null) return;
    const p = parseMeasure('usd', draft);
    setDraft(null);
    if (p.ok && (p.v ?? null) !== (value ?? null)) onCommit(p.v);
  };
  return (
    <input
      value={draft ?? (value != null ? fmtUsd(value) : '')}
      placeholder={placeholder}
      aria-label={label}
      disabled={disabled}
      data-attr={bind.code}
      data-editable="true"
      title={`${bind.name}: right-click for sources`}
      {...menu}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
    />
  );
}

export function PacingTab({ fund, summary, pacing, data, asOf, editable, onAnnual, onOverride }: {
  fund: Fund;
  summary: FundSummary;
  pacing: Pacing;
  data: OcioData;
  asOf: Date;
  editable: boolean;
  onAnnual: (v: number) => void;
  onOverride: (year: number, v: number | null) => void;
}) {
  const P = pacing;
  if (!fund.annual && !P.rows.some((r) => r.deployed)) {
    return <Empty>No annual deployment target and no commitments yet. Set an annual target to track pacing.</Empty>;
  }
  const max = Math.max(1, ...P.rows.map((r) => Math.max(r.target, r.deployed ?? 0))) * 1.1;
  const W = 640;
  const H = 230;
  const x0 = 50;
  const slot = (W - x0 - 10) / P.rows.length;
  const y = (v: number) => 200 - (v / max) * 180;
  const ticks = [0, max / 3, (2 * max) / 3, max * 0.999];
  const sleeves = fund.kind === 'client' ? data.funds.filter((s) => s.parentId === fund.id) : [];
  const cumRows = P.rows.filter((r) => !r.future);
  const cumMax = Math.max(1, fund.programUsd || 0, ...cumRows.map((r) => Math.max(r.cumDeployed ?? 0, r.cumTarget ?? 0))) * 1.1;
  const cx = (i: number) => 50 + (cumRows.length > 1 ? (i * 350) / (cumRows.length - 1) : 0);
  const cy = (v: number) => 200 - (v / cumMax) * 180;
  return (
    <section className="da-sec">
      <div className="da-toolbar x-set">
        <span>Mandate start <b><Bound {...fundBind.start(fund)} value={fmtDate(P.start)}>{fmtDate(P.start)}</Bound></b></span>
        <span>Investment period end <b><Bound {...fundBind.end(fund)} value={fmtDate(endOf(fund, asOf))}>{fmtDate(endOf(fund, asOf))}</Bound></b></span>
        <label>Annual deployment target{' '}
          <YearInput value={fund.annual} placeholder="e.g. 150M" label="Annual deployment target" disabled={!editable} bind={fundBind.annual(fund)} onCommit={(v) => { if (v != null) onAnnual(v); }} />
        </label>
        <span className="da-note">The first year is prorated from the start date. Type a figure in any year&apos;s target to override it. Pacing is measured as of {fmtDate(asOf)}.</span>
      </div>
      <div className="x-charts">
        <div className="da-chart">
          <h4>Annual deployment vs target</h4>
          <p className="da-note">Bars are commitments by investment year; dark ticks are the yearly target, and the ring is where {asOf.getFullYear()} should be today.</p>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Annual deployment against target by year">
            {ticks.map((t) => <line key={`g${t}`} className="x-gl" x1={x0} x2={W - 10} y1={y(t)} y2={y(t)} />)}
            {ticks.map((t) => <text key={`a${t}`} className="x-ax" x={44} y={y(t) + 4} textAnchor="end">{fmtUsd(t) || '$0'}</text>)}
            {P.rows.map((r, i) => {
              const cx0 = x0 + slot * i + slot / 2;
              return (
                <g key={r.year}>
                  {r.deployed != null && r.deployed > 0 && (
                    <rect className="x-bar" x={cx0 - 22} y={y(r.deployed)} width={44} height={200 - y(r.deployed)}><title>{`${r.year} deployed: ${fmtUsd(r.deployed)}`}</title></rect>
                  )}
                  {r.target > 0 && <line className={`x-tk${r.future ? ' p' : ''}`} x1={cx0 - 28} x2={cx0 + 28} y1={y(r.target)} y2={y(r.target)}><title>{`${r.year} target: ${fmtUsd(r.target)}`}</title></line>}
                  {r.current && r.targetToDate != null && r.targetToDate > 0 && <circle className="x-ring" cx={cx0} cy={y(r.targetToDate)} r={4}><title>{`Expected by ${fmtDate(asOf)}: ${fmtUsd(r.targetToDate)}`}</title></circle>}
                  <text className="x-lb" x={cx0} y={y(Math.max(r.deployed ?? 0, r.target)) - 6} textAnchor="middle">{r.future ? fmtUsd(r.target) : fmtUsd(r.deployed) || '$0'}</text>
                  <text className={r.current ? 'x-lb' : 'x-ax'} x={cx0} y={218} textAnchor="middle">{r.current ? `${r.year} YTD` : r.year}</text>
                </g>
              );
            })}
          </svg>
          <div className="fs-legend">
            <span><i style={{ background: 'var(--accent-2)' }} />Deployed</span>
            <span><i style={{ height: 2, verticalAlign: 'middle', background: 'var(--ink)' }} />Target</span>
            <span><i style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid var(--amber)', background: 'var(--surface)' }} />Expected by {fmtDate(asOf)}: {fmtUsd(P.current?.targetToDate) || '$0'}</span>
          </div>
        </div>
        <div className="da-chart">
          <h4>Cumulative deployment</h4>
          <p className="da-note">Committed since inception against the cumulative time-weighted target.</p>
          <svg viewBox="0 0 420 230" role="img" aria-label="Cumulative deployment against cumulative target">
            {[0, cumMax / 3, (2 * cumMax) / 3].map((t) => <line key={t} className="x-gl" x1={50} x2={410} y1={cy(t)} y2={cy(t)} />)}
            {fund.programUsd ? <><line className="x-tk p" x1={50} x2={410} y1={cy(fund.programUsd)} y2={cy(fund.programUsd)} /><text className="x-ax" x={56} y={cy(fund.programUsd) - 6}>Program {fmtUsd(fund.programUsd)}</text></> : null}
            {cumRows.length > 0 && (
              <>
                <polygon className="x-area" points={`${cumRows.map((r, i) => `${cx(i)},${cy(r.cumDeployed ?? 0)}`).join(' ')} ${cx(cumRows.length - 1)},200 50,200`} />
                <polyline className="x-tl" points={cumRows.map((r, i) => `${cx(i)},${cy(r.cumTarget ?? 0)}`).join(' ')} />
                <polyline className="x-dep" points={cumRows.map((r, i) => `${cx(i)},${cy(r.cumDeployed ?? 0)}`).join(' ')} />
                {cumRows.map((r, i) => <text key={r.year} className="x-ax" x={cx(i)} y={218} textAnchor="middle">{r.year}</text>)}
                <text className="x-lb" x={cx(cumRows.length - 1) - 6} y={cy(P.cumDeployed) - 8} textAnchor="end">{fmtUsd(P.cumDeployed)}</text>
                <text className="x-ax" x={cx(cumRows.length - 1) - 6} y={cy(P.cumTarget) + 18} textAnchor="end">Target {fmtUsd(P.cumTarget)}</text>
              </>
            )}
          </svg>
          <div className="fs-legend">
            <span><i style={{ background: 'var(--accent-2)' }} />Deployed</span>
            <span><i style={{ height: 2, verticalAlign: 'middle', background: 'var(--ink-3)' }} />Target to date</span>
          </div>
        </div>
      </div>
      <div className="da-gridwrap x-gridwrap">
        <table className="da-grid fit x-pace">
          <thead>
            <tr>
              <th>Year</th>
              <th className="num">Target</th>
              <th className="num">Deployed</th>
              <th className="num"># Inv.</th>
              {sleeves.map((s) => <th key={s.id} className="num">{s.name}</th>)}
              <th className="num">vs Target</th>
              <th className="num">Expected to date · velocity</th>
              <th className="num">Cum. target</th>
              <th className="num">Cum. deployed</th>
              <th className="num">Cum. velocity</th>
            </tr>
          </thead>
          <tbody>
            {P.rows.map((r) => {
              const vs = r.deployed != null && r.target ? r.deployed / r.target : null;
              const vel = r.current && r.targetToDate ? (r.deployed ?? 0) / r.targetToDate : null;
              const cumVel = r.cumTarget ? (r.cumDeployed ?? 0) / r.cumTarget : null;
              const [vt] = velocityTone(vel);
              const [ct] = velocityTone(cumVel);
              return (
                <tr key={r.year} className={r.current ? 'sel' : undefined}>
                  <td>{r.year}{r.current ? ' YTD' : ''}</td>
                  <td className="num act">
                    <YearInput
                      value={r.override ? r.target : null}
                      placeholder={fmtUsd(r.target) || '$0'}
                      label={`${r.year} deployment target`}
                      disabled={!editable}
                      bind={yearTargetBind(fund, r.year)}
                      onCommit={(v) => onOverride(r.year, v)}
                    />
                  </td>
                  <td className="num">{r.deployed != null ? <Derived name={`${r.year} deployed`} how={() => deployedHow(summary, r.year)}>{fmtUsd(r.deployed) || '$0'}</Derived> : ''}</td>
                  <td className="num">{r.count != null ? <Derived name={`${r.year} investments`} how={() => ({ ...deployedHow(summary, r.year), title: `${fund.name} ${r.year} investments`, value: String(r.count), formula: `The number of original commitments with a commit date in ${r.year}.` })}>{r.count}</Derived> : ''}</td>
                  {sleeves.map((s) => <td key={s.id} className="num">{r.bySleeve[s.id] ? <Derived name={`${s.name} ${r.year} deployed`} how={() => ({ ...deployedHow({ ...summary, fund: s, list: summary.list.filter((c) => c.sleeveId === s.id) }, r.year) })}>{fmtUsd(r.bySleeve[s.id])}</Derived> : ''}</td>)}
                  <td className="num">{vs != null ? <Derived name={`${r.year} deployed against target`} how={() => ({ title: `${r.year} deployed against target`, value: `${Math.round(vs * 100)}%`, formula: 'Deployed in the year divided by that year’s target.', rows: [{ label: 'Deployed', value: fmtUsd(r.deployed) || '$0' }, { label: 'Target', value: fmtUsd(r.target) || '$0', bind: yearTargetBind(fund, r.year) }] })}>{r.current ? `${Math.round(vs * 100)}% so far` : <span className={`da-st ${vs >= 0.95 ? 'ok' : vs >= 0.85 ? 'near' : 'breach'}`}>{Math.round(vs * 100)}%</span>}</Derived> : ''}</td>
                  <td className="num">{r.current ? <Derived name="Expected to date and velocity" how={() => velocityHow(summary, asOf)}>{fmtUsd(r.targetToDate) || '$0'} · <span className={`da-st ${TONE[vt]}`}>{fmtX(vel)}</span></Derived> : ''}</td>
                  <td className="num">{r.cumTarget != null ? <Derived name={`Cumulative target to ${r.year}`} how={() => ({ title: `Cumulative target to ${r.year}`, value: fmtUsd(r.cumTarget), formula: 'Each year’s target added up from the start of the investment period. The first year is prorated from the start date, and the current year counts only to your As Of date.', rows: P.rows.filter((x) => x.year <= r.year && !x.future).map((x) => ({ label: `${x.year}${x.current ? ' to date' : ''}`, value: fmtUsd(x.targetToDate) || '$0', bind: yearTargetBind(fund, x.year) })) })}>{fmtUsd(r.cumTarget)}</Derived> : ''}</td>
                  <td className="num">{r.cumDeployed != null ? <Derived name={`Cumulative deployed to ${r.year}`} how={() => ({ title: `Cumulative deployed to ${r.year}`, value: fmtUsd(r.cumDeployed) || '$0', formula: 'Original commitments added up from the start of the investment period to the end of this year, or to your As Of date in the current year.', rows: P.rows.filter((x) => x.year <= r.year && !x.future).map((x) => ({ label: String(x.year), value: fmtUsd(x.deployed) || '$0' })) })}>{fmtUsd(r.cumDeployed) || '$0'}</Derived> : ''}</td>
                  <td className="num">{cumVel != null ? <Derived name={`Cumulative velocity to ${r.year}`} how={() => (r.current ? cumVelocityHow(summary) : { title: `Cumulative velocity to ${r.year}`, value: fmtX(cumVel), formula: 'Cumulative deployed divided by the cumulative target, both to the end of this year.', rows: [{ label: 'Cumulative deployed', value: fmtUsd(r.cumDeployed) || '$0' }, { label: 'Cumulative target', value: fmtUsd(r.cumTarget) || '$0' }] })}><span className={`da-st ${TONE[ct]}`}>{fmtX(cumVel)}</span></Derived> : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
