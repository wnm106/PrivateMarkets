'use client';

import { useSurfaceHost } from '@tapestrai/surface-sdk/react';
import type { Fund } from '../lib/types';
import { fmtDate, fmtUsd, fmtX, monthYear, parseMeasure } from '../lib/format';
import { velocityTone } from '../lib/pacing';
import type { FundSummary } from '../lib/summary';
import { fundBind, yearTargetBind } from '../lib/binds';
import { committedHow, complianceHow, cumVelocityHow, deployedHow, investmentsHow, runRateHow, targetCountHow, velocityHow } from '../lib/how';
import { Bound, Derived, InlineEdit } from './common';

const VEL_TONE: Record<string, string> = { bad: 'breach', warn: 'near', ok: 'ok', ahead: 'ok', '': 'na' };

export function Rail({ summaries, selected, asOf, editable, onSelect, onAdd }: {
  summaries: FundSummary[];
  selected: string | null;
  asOf: Date;
  editable: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <nav className="x-rail" aria-label="Clients and mandates">
      <h2>Clients &amp; mandates</h2>
      {summaries.map((s) => {
        const f = s.fund;
        const breaches = s.counts ? s.counts.breach + s.counts.soft : null;
        const [tone] = velocityTone(s.pacing.ytdVelocity);
        return (
          <button key={f.id} className={`x-ent ${f.kind === 'client' ? 'client' : 'mandate'}`} aria-current={selected === f.id} onClick={() => onSelect(f.id)}>
            <span className="x-entline">
              <b>{f.name}</b>
              <Derived name="Targets assigned" how={() => targetCountHow(s)}><span className="cr-n">{s.targetCount}</span></Derived>
              {breaches != null && breaches > 0 && (
                <Derived name="Compliance breaches" how={() => complianceHow(s)}><span className="da-st breach">{breaches}</span></Derived>
              )}
            </span>
            <span className="x-entsub">
              <Bound {...fundBind.program(f)} value={fmtUsd(f.programUsd)}>{fmtUsd(f.programUsd) || '—'}</Bound>
              <Derived name="Investments made" how={() => investmentsHow(s)}>{s.pacing.count} inv</Derived>
              <Derived name="Pacing velocity this year" how={() => velocityHow(s, asOf)}><span className={`da-st ${VEL_TONE[tone]}`}>{fmtX(s.pacing.ytdVelocity)}</span></Derived>
              <span className="x-lens" title={`Strategy: ${s.targets.strategy} · Region: ${s.targets.region} · Structure: ${s.targets.structure}`}>
                <i className={s.targets.strategy ? 'on' : ''} />
                <i className={s.targets.region ? 'on' : ''} />
                <i className={s.targets.structure ? 'on' : ''} />
              </span>
            </span>
          </button>
        );
      })}
      <button className="btn btn-sm x-add" disabled={!editable} title={editable ? 'Add a mandate sleeve under a client' : 'Adding a sleeve needs permission to edit records'} onClick={onAdd}>+ Add mandate sleeve</button>
    </nav>
  );
}

const dollars = (text: string) => { const p = parseMeasure('usd', text); return p.ok && p.v != null && p.v > 0 ? p.v : null; };
const count = (text: string) => { const p = parseMeasure('n', text); return p.ok && p.v != null && p.v > 0 ? p.v : null; };

export function Ribbon({ s, asOf, onCompliance, editable, onBasis, onCopy, onEdit, scoreError }: {
  s: FundSummary;
  asOf: Date;
  onCompliance: () => void;
  editable: boolean;
  onBasis: (basis: Fund['basis']) => void;
  onCopy: () => void;
  onEdit: (next: Partial<Pick<Fund, 'programUsd' | 'programN' | 'annual'>>, reason: string) => void;
  /** Why the compliance engine could not score this fund, when it could not. */
  scoreError?: string | null;
}) {
  const host = useSurfaceHost();
  const f = s.fund;
  const P = s.pacing;
  const c = P.current;
  const [vt, vl] = velocityTone(P.ytdVelocity);
  const [ct, cl] = velocityTone(P.cumVelocity);
  const pctCommitted = f.programUsd ? P.cumDeployed / f.programUsd : null;
  const fill = c && c.target ? Math.min(1, (c.deployed ?? 0) / c.target) : 0;
  const mark = c && c.target ? Math.min(1, (c.targetToDate ?? 0) / c.target) : 0;
  const year = asOf.getFullYear();
  const counts = s.counts;
  const breaches = counts ? counts.breach : null;
  return (
    <header className="da-ribbon x-ribbon">
      <div className="da-title x-title">
        <h1><a href={host.href(`/funds/${f.id}/overview`)} title="Open the record">{f.name}</a></h1>
        <div className="x-actions">
          <span>% basis</span>
          <div className="cr-seg attr-inspectable" role="group" aria-label="Percent basis" data-attr={fundBind.basis(f).code} data-editable="true" title="Target percent basis: right-click for sources" onContextMenu={(e) => { e.preventDefault(); host.inspectAttribute({ entityId: f.id, entityName: f.name, domainCode: 'FUND', attributeCode: fundBind.basis(f).code, attributeName: fundBind.basis(f).name, value: f.basis === 'PROGRAM' ? 'Program' : 'Parent level' }); }}>
            <button className={f.basis === 'PROGRAM' ? 'on' : ''} aria-pressed={f.basis === 'PROGRAM'} disabled={!editable} title="Percent targets are a share of the total program" onClick={() => onBasis('PROGRAM')}>Program</button>
            <button className={f.basis === 'PARENT_LEVEL' ? 'on' : ''} aria-pressed={f.basis === 'PARENT_LEVEL'} disabled={!editable} title="Percent targets are a share of the level above" onClick={() => onBasis('PARENT_LEVEL')}>Parent level</button>
          </div>
          <button className="btn btn-sm" disabled={!editable} onClick={onCopy}>Copy targets from…</button>
        </div>
      </div>
      <div className="da-facts x-facts" role="group" aria-label="Deployment and pacing">
        <div className="da-fact">
          <span>Program</span>
          <strong>
            <InlineEdit bind={fundBind.program(f)} shown={fmtUsd(f.programUsd)} editable={editable} parse={dollars} placeholder="e.g. 400M" onCommit={(v) => onEdit({ programUsd: v }, `OCIO: program size set to ${fmtUsd(v)}`)} />
          </strong>
          <small>
            {pctCommitted != null && <><Derived name="Share of program committed" how={() => committedHow(s)}>{Math.round(pctCommitted * 100)}% committed</Derived> · </>}
            since <Bound {...fundBind.start(f)} value={monthYear(P.start)}>{monthYear(P.start)}</Bound>
          </small>
        </div>
        <div className="da-fact">
          <span>Investments</span>
          <strong>
            <Derived name="Investments made" how={() => investmentsHow(s)}>{P.count}</Derived>{' '}
            <small>/ <InlineEdit bind={fundBind.count(f)} shown={f.programN != null ? String(f.programN) : ''} editable={editable} parse={count} onCommit={(v) => onEdit({ programN: v }, `OCIO: target investment count set to ${v}`)} /></small>
          </strong>
          <small>made vs target</small>
        </div>
        <div className="da-fact x-wide">
          <span>{year} deployment vs target</span>
          <strong>
            <Derived name={`${year} deployment`} how={() => deployedHow(s, year)}>{fmtUsd(c?.deployed || 0) || '$0'}</Derived>{' '}
            <small>/ {c?.override
              ? <Bound {...yearTargetBind(f, c.year)} value={fmtUsd(c.target)}>{fmtUsd(c.target) || '—'}</Bound>
              : <InlineEdit bind={fundBind.annual(f)} shown={fmtUsd(c?.target ?? f.annual)} editable={editable && f.annual === c?.target} parse={dollars} placeholder="e.g. 70M" onCommit={(v) => onEdit({ annual: v }, `OCIO: annual deployment target set to ${fmtUsd(v)}`)} />}
            </small>
          </strong>
          <div className="fs-track" title={`Bar: deployed against the ${year} target. Marker: where pacing says you should be by ${fmtDate(asOf)}`}>
            <i style={{ width: `${(fill * 100).toFixed(1)}%` }} />
            <b style={{ left: `${(mark * 100).toFixed(1)}%` }} />
          </div>
          <small>{c && c.target ? `${Math.round(((c.deployed ?? 0) / c.target) * 100)}% of annual · ${fmtUsd(c.targetToDate) || '$0'} expected to date` : 'No annual target set'}</small>
        </div>
        <div className="da-fact">
          <span>Pacing velocity</span>
          <strong className={vt === 'bad' ? 'dn' : 'up'}>
            <Derived name="Pacing velocity this year" how={() => velocityHow(s, asOf)}>{fmtX(P.ytdVelocity)} <span className={`da-st ${VEL_TONE[vt]}`}>{vl}</span></Derived>
          </strong>
          <small>YTD vs time-weighted target</small>
        </div>
        <div className="da-fact">
          <span>Since inception</span>
          <strong className={ct === 'bad' ? 'dn' : 'up'} title={cl}>
            <Derived name="Velocity since inception" how={() => cumVelocityHow(s)}>{fmtX(P.cumVelocity)}</Derived>
          </strong>
          <small>{fmtUsd(P.cumDeployed) || '$0'} vs {fmtUsd(P.cumTarget) || '$0'}</small>
        </div>
        <div className="da-fact x-clk" role="button" tabIndex={0} title="Open the compliance tab" onClick={onCompliance} onKeyDown={(e) => { if (e.key === 'Enter') onCompliance(); }}>
          <span>Compliance</span>
          {counts ? (
            <>
              <strong className={breaches ? 'dn' : 'up'}>
                <Derived name="Compliance breaches" how={() => complianceHow(s)}>{breaches ? `${breaches} breach${breaches === 1 ? '' : 'es'}` : 'No breaches'}</Derived>
              </strong>
              <small>{counts.total} rules · {counts.soft} soft · {counts.watch} watch · {counts.pending} pending</small>
            </>
          ) : scoreError ? (
            <><strong title={scoreError}>Not scored</strong><small>The compliance engine did not answer. Open the tab to try again.</small></>
          ) : (
            <><strong>…</strong><small>Scoring the rules</small></>
          )}
        </div>
        <div className="da-fact">
          <span>Run-rate (LTM)</span>
          <strong><Derived name="Run-rate, last 12 months" how={() => runRateHow(s)}>{fmtUsd(P.ltm) || '$0'}<small>/yr</small></Derived></strong>
          <small>{P.remaining != null ? `${fmtUsd(P.remaining) || '$0'} left${P.yearsAtRunRate != null ? ` · ≈${P.yearsAtRunRate.toFixed(1)} yrs at this pace` : ''}` : 'No program size'}</small>
        </div>
      </div>
    </header>
  );
}
