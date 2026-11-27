'use client';

import type { Vehicle, WaterfallStep } from '../lib/data';
import { ATTR } from '../lib/data';
import { onAccount, onNote, recordPath } from '../lib/binds';
import { countHow, kpiHow, noteHow, stepHow, testHow } from '../lib/how';
import { fmtBps, fmtDay, fmtDollars, fmtPct, fmtUsd, words } from '../lib/format';
import { Bound, BoundOr, Derived, RecordLink, StatusPill } from './common';

export const LIABILITIES_TAB = {
  label: 'Liabilities & waterfall',
  purpose: 'The open CLO’s capital structure (every note class with its terms, ratings and coverage tests), its trustee accounts, and how the next payment date’s interest and principal flow down the waterfall.',
};

const SEG_COLOR = ['#0b3c49', '#0b5d73', '#2a7f93', '#5a9fae', '#8bbcc6', '#c58a1d', '#7a868f'];
const KIND_CLASS: Record<string, string> = { EXPENSE: 'expense', FEE: 'fee', INTEREST: 'interest', CURE: 'cure', RESIDUAL: 'residual', REINVEST: 'interest', PAYDOWN: 'interest' };

function StepRow({ v, s, scale }: { v: Vehicle; s: WaterfallStep; scale: number }) {
  const width = scale > 0 ? Math.max(0.5, (s.paid / scale) * 100) : 0;
  return (
    <>
      <span className="x-label">{s.order}. {s.label}</span>
      <span className="x-bar" aria-hidden="true"><i className={KIND_CLASS[s.kind] || 'interest'} style={{ left: 0, width: `${Math.min(100, width)}%` }} /></span>
      <span className="x-amt"><Derived name={`${s.label} paid`} how={() => stepHow(v, s, 'paid')}>{fmtDollars(s.paid)}</Derived></span>
    </>
  );
}

export function LiabilitiesTab({ v, asOf }: { v: Vehicle; asOf: string }) {
  const w = v.waterfall;
  const interest = w.steps.filter((s) => s.waterfall === 'INTEREST');
  const principal = w.steps.filter((s) => s.waterfall === 'PRINCIPAL');
  const notesTotal = v.collateral.notesPar;
  return (
    <>
      <div className="x-section">
        <h2>Capital structure</h2>
        <p>Every note class by par outstanding, most senior on the left. Right-click a segment for its share.</p>
        <div className="x-stack" role="img" aria-label="Capital structure by par outstanding">
          {v.notes.map((n, i) => (
            <span key={n.id} style={{ width: `${notesTotal ? (n.par / notesTotal) * 100 : 0}%`, background: SEG_COLOR[Math.min(i, SEG_COLOR.length - 1)] }} title={`${n.name}: ${fmtUsd(n.par)}`}>
              {(n.sharePct ?? 0) >= 6 ? <Derived name={`${n.name} share`} how={() => noteHow(v, n, 'share')}>{n.cls} {fmtPct(n.sharePct, 0)}</Derived> : null}
            </span>
          ))}
        </div>
        <div className="x-frame">
          <table className="da-grid x-table">
            <thead>
              <tr>
                <th className="x-name">Class</th>
                <th className="num">Rank</th>
                <th className="num">Original par</th>
                <th className="num">Outstanding</th>
                <th className="num">Share</th>
                <th className="num" title="Share of note par below the class, and with it">Attach / detach</th>
                <th className="num">Spread</th>
                <th className="num">Coupon</th>
                <th className="num">Interest due</th>
                <th className="num">Deferred</th>
                <th>S&amp;P</th>
                <th>Moody&rsquo;s</th>
                <th className="num x-sep">OC trigger</th>
                <th className="num">OC</th>
                <th className="num">IC trigger</th>
                <th className="num">IC</th>
              </tr>
            </thead>
            <tbody>
              {v.notes.map((n) => (
                <tr key={n.id}>
                  <td className="x-name">
                    <div className="x-namebox">
                      <RecordLink path={recordPath.note(n.id)}>{n.name}</RecordLink>
                      <small><Bound {...onNote(n, ATTR.noteClass, 'Class')} value={n.cls}>{n.residual ? 'Equity' : `Class ${n.cls}`}</Bound>{!n.residual && <> · <Bound {...onNote(n, ATTR.noteDeferrable, 'Deferrable')} value={n.deferrable ? 'Yes' : 'No'}>{n.deferrable ? 'deferrable' : 'not deferrable'}</Bound></>}</small>
                    </div>
                  </td>
                  <td className="num"><Bound {...onNote(n, ATTR.noteRank, 'Seniority rank')} value={String(n.rank)}>{n.rank}</Bound></td>
                  <td className="num"><BoundOr bind={onNote(n, ATTR.noteOriginal, 'Original par')} value={n.originalPar} shown={fmtUsd(n.originalPar)} /></td>
                  <td className="num"><Bound {...onNote(n, ATTR.notePar, 'Par outstanding')} value={fmtUsd(n.par)}>{fmtUsd(n.par)}</Bound></td>
                  <td className="num"><Derived name={`${n.name} share`} how={() => noteHow(v, n, 'share')}>{fmtPct(n.sharePct, 1)}</Derived></td>
                  <td className="num"><Derived name={`${n.name} attachment`} how={() => noteHow(v, n, 'attachment')}>{fmtPct(n.attachmentPct, 1)}</Derived> / <Derived name={`${n.name} detachment`} how={() => noteHow(v, n, 'detachment')}>{fmtPct(n.detachmentPct, 1)}</Derived></td>
                  <td className="num">{n.residual ? <span className="x-nil">—</span> : <BoundOr bind={onNote(n, ATTR.noteSpread, 'Coupon spread')} value={n.spreadBps} shown={fmtBps(n.spreadBps)} />}</td>
                  <td className="num">{n.couponPct == null ? <span className="x-nil">—</span> : <Derived name={`${n.name} coupon`} how={() => noteHow(v, n, 'coupon')}>{fmtPct(n.couponPct)}</Derived>}</td>
                  <td className="num">{n.residual ? <span className="x-nil">—</span> : <Bound {...onNote(n, ATTR.noteDue, 'Interest due')} value={fmtDollars(n.interestDue)}>{fmtDollars(n.interestDue)}</Bound>}</td>
                  <td className="num">{n.residual ? <span className="x-nil">—</span> : <Bound {...onNote(n, ATTR.noteDeferred, 'Deferred interest')} value={fmtDollars(n.deferredInterest)}>{fmtDollars(n.deferredInterest)}</Bound>}</td>
                  <td><BoundOr bind={onNote(n, ATTR.noteSp, 'S&P rating')} value={n.ratingSp} shown={n.ratingSp || ''} /></td>
                  <td><BoundOr bind={onNote(n, ATTR.noteMoodys, 'Moody’s rating')} value={n.ratingMoodys} shown={n.ratingMoodys || ''} /></td>
                  <td className="num x-sep"><BoundOr bind={onNote(n, ATTR.noteOc, 'OC trigger')} value={n.ocTrigger} shown={fmtPct(n.ocTrigger, 1)} /></td>
                  <td className="num">{n.oc?.value == null ? <span className="x-nil">—</span> : <Derived className={n.oc.status === 'HARD_BREACH' ? 'x-dn' : undefined} name={`${n.name} OC`} how={() => testHow(v, asOf, n.oc!)}>{fmtPct(n.oc.value)}</Derived>}</td>
                  <td className="num"><BoundOr bind={onNote(n, ATTR.noteIc, 'IC trigger')} value={n.icTrigger} shown={fmtPct(n.icTrigger, 1)} /></td>
                  <td className="num">{n.ic?.value == null ? <span className="x-nil">—</span> : <Derived className={n.ic.status === 'HARD_BREACH' ? 'x-dn' : undefined} name={`${n.name} IC`} how={() => testHow(v, asOf, n.ic!)}>{fmtPct(n.ic.value)}</Derived>}</td>
                </tr>
              ))}
              <tr className="x-total">
                <td className="x-name">All classes</td>
                <td />
                <td className="num"><Derived name="Original par, all classes" how={() => countHow(`${v.name} · Original par`, fmtUsd(v.notes.reduce((s, n) => s + (n.originalPar ?? 0), 0)), 'Original par of every class, added up.', v.notes.map((n) => ({ label: n.name, value: fmtUsd(n.originalPar), bind: onNote(n, ATTR.noteOriginal, 'Original par') })))}>{fmtUsd(v.notes.reduce((s, n) => s + (n.originalPar ?? 0), 0))}</Derived></td>
                <td className="num"><Derived name="Outstanding, all classes" how={() => countHow(`${v.name} · Par outstanding`, fmtUsd(notesTotal), 'Par outstanding of every class, added up.', v.notes.map((n) => ({ label: n.name, value: fmtUsd(n.par), bind: onNote(n, ATTR.notePar, 'Par outstanding') })))}>{fmtUsd(notesTotal)}</Derived></td>
                <td colSpan={4} />
                <td className="num"><Derived name="Interest due, all classes" how={() => countHow(`${v.name} · Interest due`, fmtDollars(v.notes.reduce((s, n) => s + n.interestDue, 0)), 'Interest due on every rated class for the period, added up.', v.notes.filter((n) => !n.residual).map((n) => ({ label: n.name, value: fmtDollars(n.interestDue), bind: onNote(n, ATTR.noteDue, 'Interest due') })))}>{fmtDollars(v.notes.reduce((s, n) => s + n.interestDue, 0))}</Derived></td>
                <td colSpan={7} />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="x-section">
        <h2>Trustee accounts</h2>
        <div className="x-frame x-short">
          <table className="da-grid x-table">
            <thead><tr><th className="x-name">Account</th><th>Type</th><th>Currency</th><th className="num">Balance</th><th className="num">Uninvested proceeds</th></tr></thead>
            <tbody>
              {v.accounts.map((a) => (
                <tr key={a.id}>
                  <td className="x-name"><RecordLink path={recordPath.account(a.id)}>{a.name}</RecordLink></td>
                  <td><BoundOr bind={onAccount(a, ATTR.acctType, 'Account type')} value={a.type} shown={words(a.type)} /></td>
                  <td><BoundOr bind={onAccount(a, ATTR.acctCurrency, 'Currency')} value={a.currency} shown={a.currency || ''} /></td>
                  <td className="num"><Bound {...onAccount(a, ATTR.acctBalance, 'Balance')} value={fmtDollars(a.balance)}>{fmtDollars(a.balance)}</Bound></td>
                  <td className="num"><Bound {...onAccount(a, ATTR.acctUninvested, 'Uninvested proceeds')} value={fmtDollars(a.uninvested)}>{fmtDollars(a.uninvested)}</Bound></td>
                </tr>
              ))}
              {!v.accounts.length && <tr><td className="x-name" colSpan={5}><span className="x-mut">No trustee account is linked to this CLO.</span></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="x-section">
        <h2>Waterfall for the next payment date{v.nextPayment ? `, ${fmtDay(v.nextPayment)}` : ''}</h2>
        <p>Interest collections run down the priority of payments: expenses, the senior fee, each class&rsquo;s interest with its coverage tests (a failing test diverts interest to pay the senior notes down), the subordinated fee, and what is left to the equity. Principal is reinvested during the reinvestment period and repays the notes after it.</p>
        <div className="da-ribbon x-ribbon">
          <div className="da-fact"><span>Interest collections</span><strong><Derived name="Interest collections" how={() => countHow(`${v.name} · Interest collections`, fmtDollars(w.interestProceeds), 'Expected interest for the period on each performing holding, added up: the interest the waterfall starts from.')}>{fmtUsd(w.interestProceeds)}</Derived></strong><small>expected for the period</small></div>
          <div className="da-fact"><span>Paid to notes</span><strong><Derived name="Paid to notes" how={() => countHow(`${v.name} · Interest paid to notes`, fmtDollars(w.paidToNotes), 'Interest paid on the rated classes, added up.', interest.filter((s) => s.kind === 'INTEREST').map((s) => ({ label: s.label, value: fmtDollars(s.paid) })))}>{fmtUsd(w.paidToNotes)}</Derived></strong><small>interest on rated classes</small></div>
          <div className="da-fact"><span>Diverted to cures</span><strong className={w.diverted > 0 ? 'x-dn' : undefined}><Derived name="Diverted" how={() => countHow(`${v.name} · Diverted to coverage cures`, fmtDollars(w.diverted), 'Interest (and, where it fell short, principal) paid to the senior notes because a coverage test failed.', w.steps.filter((s) => s.kind === 'CURE').map((s) => ({ label: s.label, value: fmtDollars(s.paid) })))}>{fmtUsd(w.diverted)}</Derived></strong><small>{w.paydowns.length ? `pays down ${w.paydowns.map((p) => `Class ${p.cls}`).join(', ')}` : 'no test is failing'}</small></div>
          <div className="da-fact"><span>Deferred or short</span><strong className={w.deferred + w.shortfall > 0 ? 'x-dn' : undefined}><Derived name="Deferred or short" how={() => countHow(`${v.name} · Unpaid interest`, fmtDollars(w.deferred + w.shortfall), 'Interest a class was owed and did not get: deferred on a deferrable class, a shortfall on a class that may not defer.', interest.filter((s) => s.deferred || s.shortfall).map((s) => ({ label: s.label, value: fmtDollars(s.deferred + s.shortfall) })))}>{fmtUsd(w.deferred + w.shortfall)}</Derived></strong><small>{w.shortfall > 0 ? 'includes a non-deferrable class' : 'none on non-deferrable classes'}</small></div>
          <div className="da-fact"><span>Residual to equity</span><strong><Derived name="Residual to equity" how={() => stepHow(v, interest[interest.length - 1], 'paid')}>{fmtUsd(w.residualToEquity)}</Derived></strong><small>after every step</small></div>
          <div className="da-fact"><span>Equity cash yield</span><strong><Derived name="Equity cash yield" how={() => countHow(`${v.name} · Equity cash yield`, fmtPct(w.equityCashYieldPct), `The residual to equity for one period, times ${v.periodsPerYear} periods a year, over the subordinated notes’ par.`, [{ label: 'Residual for the period', value: fmtDollars(w.residualToEquity) }, ...v.notes.filter((n) => n.residual).map((n) => ({ label: n.name, value: fmtUsd(n.par), bind: onNote(n, ATTR.notePar, 'Par outstanding') }))])}>{fmtPct(w.equityCashYieldPct)}</Derived></strong><small>a year, on par</small></div>
        </div>
        <div className="x-cols x-section">
          <div>
            <h3 className="x-subhead">Interest priority of payments</h3>
            <div className="x-flow">{interest.map((s) => <StepRow key={s.order} v={v} s={s} scale={w.interestProceeds} />)}</div>
          </div>
          <div>
            <h3 className="x-subhead">Principal priority of payments</h3>
            <div className="x-flow">{principal.map((s) => <StepRow key={s.order} v={v} s={s} scale={Math.max(w.principalProceeds, 1)} />)}</div>
            <p className="x-note">{v.phase === 'Reinvestment' ? 'Inside the reinvestment period: principal buys new collateral.' : 'Past the reinvestment period: principal repays the notes in order.'}</p>
          </div>
        </div>
        <div className="x-frame">
          <table className="da-grid x-table">
            <thead><tr><th className="x-name">Step</th><th className="num">Available</th><th className="num">Due</th><th className="num">Paid</th><th className="num">Not paid</th><th>Test</th></tr></thead>
            <tbody>
              {w.steps.map((s) => {
                const cover = s.kind === 'CURE' ? v.kpis.filter((k) => (k.metric === 'OC' || k.metric === 'IC') && s.label.startsWith(k.label.replace(/ (OC|IC)$/, ''))) : [];
                return (
                  <tr key={s.order}>
                    <td className="x-name"><div className="x-namebox"><b>{s.order}. {s.label}</b><small>{s.waterfall === 'INTEREST' ? 'Interest' : 'Principal'} · {s.basis}</small></div></td>
                    <td className="num"><Derived name={`${s.label} available`} how={() => stepHow(v, s, 'paid')}>{fmtDollars(s.availableBefore)}</Derived></td>
                    <td className="num"><Derived name={`${s.label} due`} how={() => stepHow(v, s, 'due')}>{fmtDollars(s.due)}</Derived></td>
                    <td className="num"><Derived name={`${s.label} paid`} how={() => stepHow(v, s, 'paid')}>{fmtDollars(s.paid)}</Derived></td>
                    <td className="num">{s.deferred + s.shortfall > 0 ? <Derived className="x-dn" name={`${s.label} not paid`} how={() => stepHow(v, s, 'short')}>{fmtDollars(s.deferred + s.shortfall)}</Derived> : <span className="x-nil">—</span>}</td>
                    <td>{cover.length ? <span className="x-flags">{cover.map((k) => <Derived key={k.label} name={k.label} how={() => kpiHow(v, asOf, k)}><StatusPill status={k.status} /></Derived>)}</span> : <span className="x-nil">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="x-note">Not modelled: the reinvestment OC test, the incentive fee and its hurdle, caps on senior expenses, and interest reserve or smoothing accounts. Expected interest is each holding&rsquo;s own figure for the period; the trustee&rsquo;s collection may differ.</p>
      </div>
    </>
  );
}
