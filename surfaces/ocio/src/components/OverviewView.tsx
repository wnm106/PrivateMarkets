'use client';

import { useState } from 'react';
import type { Lens, OcioData } from '../lib/types';
import { fmtMeasure, fmtUsd, fmtX, monthYear, type Measure } from '../lib/format';
import { velocityTone } from '../lib/pacing';
import { LENS_INFO, actualMap, band, measureStatus, type TreeNode, type Trees } from '../lib/tree';
import type { FundSummary } from '../lib/summary';
import { fundBind, shownTargetBind } from '../lib/binds';
import { complianceHow, cumVelocityHow, deployedHow, targetCountHow, velocityHow } from '../lib/how';
import { Bound, BoundIf, Derived, Dot } from './common';

const TONE: Record<string, string> = { bad: 'breach', warn: 'near', ok: 'ok', ahead: 'ok', '': 'na' };

export function levelsAt(trees: Trees, lens: Lens, depth: number): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (n: TreeNode) => { if (n.depth === depth) out.push(n); else n.children.forEach(visit); };
  visit(trees.roots[lens]);
  return out;
}

export function OverviewView({ summaries, data, trees, asOf, onOpen }: {
  summaries: FundSummary[];
  data: OcioData;
  trees: Trees;
  asOf: Date;
  onOpen: (fundId: string, lens?: Lens) => void;
}) {
  const [lens, setLens] = useState<Lens>('strategy');
  const [depth, setDepth] = useState(1);
  const [measure, setMeasure] = useState<Measure>('pct');
  const cols = levelsAt(trees, lens, depth).filter((n) => summaries.some((s) => s.fund.matrix[lens][n.key] || actualMap(s.list, lens)[n.key])).slice(0, 14);
  const year = asOf.getFullYear();
  if (!summaries.length) return <div className="xp-empty">No OCIO clients yet. A fund appears here once it has a target percent basis.</div>;
  return (
    <main>
      <div className="x-intro">
        <div className="pipe-head" style={{ marginBottom: 0 }}>
          <h1>Target coverage across clients</h1>
          <p className="da-note">Each client carries macro targets and a macro deployment pace; each sleeve carries its own. Velocity compares deployment so far this year with the time-weighted annual target. Select a row to open it, or a matrix cell to open that level.</p>
        </div>
      </div>
      <section className="da-sec">
        <div className="da-sechead"><h2>Programs</h2></div>
        <div className="da-main solo">
          <div className="da-gridwrap x-gridwrap">
            <table className="da-grid x-over">
              <thead>
                <tr>
                  <th>Client / mandate</th>
                  <th className="num">Program</th>
                  <th className="num">Inv.</th>
                  <th>% basis</th>
                  <th>Start</th>
                  <th className="num">Annual target</th>
                  <th className="num">{year} deployed</th>
                  <th>Velocity</th>
                  <th className="num">Since inception</th>
                  <th>Compliance</th>
                  <th className="num">Strategy</th>
                  <th className="num">Region</th>
                  <th className="num">Structure</th>
                  <th className="num">Targets</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => {
                  const f = s.fund;
                  const [vt, vl] = velocityTone(s.pacing.ytdVelocity);
                  const [ct] = velocityTone(s.pacing.cumVelocity);
                  return (
                    <tr key={f.id} className={`x-rowlink ${f.kind === 'client' ? 'par' : 'sub'}`} onClick={() => onOpen(f.id)}>
                      <td>{f.kind === 'client' ? <b>{f.name}</b> : f.name}</td>
                      <td className="num"><Bound {...fundBind.program(f)} value={fmtUsd(f.programUsd)}>{fmtUsd(f.programUsd) || '—'}</Bound></td>
                      <td className="num"><Bound {...fundBind.count(f)} value={f.programN != null ? String(f.programN) : undefined}>{f.programN ?? '—'}</Bound></td>
                      <td><Bound {...fundBind.basis(f)}>{f.basis === 'PARENT_LEVEL' ? 'Parent level' : 'Program'}</Bound></td>
                      <td><Bound {...fundBind.start(f)} value={monthYear(s.pacing.start)}>{monthYear(s.pacing.start)}</Bound></td>
                      <td className="num"><Bound {...fundBind.annual(f)} value={fmtUsd(f.annual)}>{fmtUsd(f.annual) || '—'}</Bound></td>
                      <td className="num"><Derived name={`${year} deployed`} how={() => deployedHow(s, year)}>{fmtUsd(s.pacing.current?.deployed) || '$0'}</Derived></td>
                      <td><Derived name="Pacing velocity this year" how={() => velocityHow(s, asOf)}><span className={`da-st ${TONE[vt]}`}>{fmtX(s.pacing.ytdVelocity)} · {vl}</span></Derived></td>
                      <td className="num"><Derived name="Velocity since inception" how={() => cumVelocityHow(s)}><span className={`x-fig ${ct === 'bad' ? 'bad' : ct === 'warn' ? 'warn' : 'ok'}`}>{fmtX(s.pacing.cumVelocity)}</span></Derived></td>
                      <td className="x-pills">
                        {!s.counts ? <span className="da-note">…</span> : (
                          <Derived name="Compliance results" how={() => complianceHow(s)}>
                            {s.counts.breach > 0 && <span className="da-st breach">Breach {s.counts.breach}</span>}
                            {s.counts.soft > 0 && <span className="da-st x-soft">Soft breach {s.counts.soft}</span>}
                            {s.counts.watch > 0 && <span className="da-st near">Watch {s.counts.watch}</span>}
                            {s.counts.breach + s.counts.soft + s.counts.watch === 0 && <span className="da-st ok">Pass</span>}
                          </Derived>
                        )}
                      </td>
                      {(['strategy', 'region', 'structure'] as Lens[]).map((l) => (
                        <td key={l} className="num"><Derived name={`${LENS_INFO[l].label} targets assigned`} how={() => targetCountHow(s)}><span className={`x-cov${s.targets[l] ? '' : ' nil'}`}><i />{s.targets[l]}</span></Derived></td>
                      ))}
                      <td className="num"><Derived name="Targets assigned" how={() => targetCountHow(s)}>{f.kind === 'client' ? <b>{s.targetCount}</b> : s.targetCount}</Derived></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section className="da-sec">
        <div className="da-sechead">
          <h2>Target matrix</h2>
          <div className="cr-tools">
            <select aria-label="Hierarchy" value={lens} onChange={(e) => { setLens(e.target.value as Lens); setDepth(1); }}>
              {(['strategy', 'region', 'structure'] as Lens[]).map((l) => <option key={l} value={l}>{LENS_INFO[l].label}</option>)}
            </select>
            <select aria-label="Level" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              {LENS_INFO[lens].path.split(' › ').map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
            </select>
            <select aria-label="Measure" value={measure} onChange={(e) => setMeasure(e.target.value as Measure)}>
              <option value="pct">% target</option>
              <option value="usd">$ target</option>
              <option value="n"># investments</option>
            </select>
          </div>
        </div>
        <div className="da-main solo">
          <div className="da-gridwrap x-gridwrap">
            <table className="da-grid fit x-over x-mx">
              <thead>
                <tr>
                  <th>Client / mandate</th>
                  {cols.map((n) => <th key={n.key} className="num" title={n.path.map((c) => data.taxonomy.labels[c] || c).join(' › ')}>{n.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => {
                  const A = actualMap(s.list, lens);
                  return (
                    <tr key={s.fund.id} className={s.fund.kind === 'client' ? 'par' : 'sub'}>
                      <td>{s.fund.kind === 'client' ? <b>{s.fund.name}</b> : s.fund.name}</td>
                      {cols.map((n) => {
                        const b = band(s.fund, lens, n, measure);
                        const st = measureStatus(s.fund, lens, n, A, measure).st;
                        const t = b[1].v;
                        if (t == null && b[0].v == null && b[2].v == null) {
                          return <td key={n.key} className="num nil" onClick={() => onOpen(s.fund.id, lens)} style={{ cursor: 'pointer' }}>·</td>;
                        }
                        return (
                          <td key={n.key} className="num" title={`${s.fund.name} · ${n.name} · ${st.text}`} onClick={() => onOpen(s.fund.id, lens)} style={{ cursor: 'pointer' }}>
                            <Dot cls={st.cls === 'none' ? '' : st.cls} />
                            <BoundIf bind={shownTargetBind(s.fund, lens, n.key, measure)} value={t != null ? fmtMeasure(measure, t) : undefined}>
                              <b>{t != null ? `${b[1].imp ? '≈' : ''}${fmtMeasure(measure, t)}` : '—'}</b>
                              {(b[0].v != null || b[2].v != null) && <small> {fmtMeasure(measure, b[0].v) || '…'}–{fmtMeasure(measure, b[2].v) || '…'}</small>}
                            </BoundIf>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}
