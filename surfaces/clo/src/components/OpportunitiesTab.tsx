'use client';

import { useState } from 'react';
import { useSurfaceHost } from '@tapestrai/surface-sdk/react';
import type { Capacity, MetricChange, Opportunities, Opportunity, Vehicle } from '../lib/data';
import { ATTR, loadCapacity } from '../lib/data';
import { onIssuer, onOffer, recordPath } from '../lib/binds';
import { countHow } from '../lib/how';
import { fmtBps, fmtDay, fmtMeasure, fmtMeasureChange, fmtNum, fmtUsd, fmtYears } from '../lib/format';
import { juniorOc } from '../lib/view';
import { BoundOr, Derived, Empty, ErrorPanel, Loading, RecordLink, StatusPill } from './common';

export const OPPORTUNITIES_TAB = {
  label: 'Opportunities',
  purpose: 'Loans offered in the market that the open CLO does not hold, each scored as a buy by the compliance engine, ranked by how much it would improve the CLO’s tests and composition.',
};

/** The measures shown as columns, by what the engine tags them. The junior OC is picked per CLO. */
export function opportunityColumns(v: Vehicle): Array<{ key: string; label: string; pick: (o: Opportunity) => MetricChange | undefined }> {
  const junior = juniorOc(v);
  const by = (metric: string, rank: number | null = null) => (o: Opportunity) => o.score?.changes.find((c) => c.metric === metric && (rank == null || c.rank === rank));
  return [
    { key: 'WARF', label: 'WARF', pick: by('WARF') },
    { key: 'WAS', label: 'WAS', pick: by('WAS') },
    { key: 'WAL', label: 'WAL', pick: by('WAL') },
    { key: 'CCC', label: 'CCC', pick: by('CCC') },
    { key: 'DIVERSITY', label: 'Diversity', pick: by('DIVERSITY') },
    ...(junior ? [{ key: 'OC', label: junior.label, pick: by('OC', junior.rank) }] : []),
  ];
}

/** What a buy does to one measure, signed so that a gain is an improvement. */
function ChangeCell({ o, c }: { o: Opportunity; c: MetricChange | undefined }) {
  if (!c || c.gain == null || c.before == null || c.after == null) return <span className="x-nil">—</span>;
  const raw = c.after - c.before;
  const tone = c.gain > 1e-9 ? 'x-up' : c.gain < -1e-9 ? 'x-dn' : 'x-mut';
  return (
    <Derived className={tone} name={`${o.name} ${c.label}`} how={() => countHow(`${o.name} · ${c.label}`, fmtMeasureChange(c.metric, raw),
      `${c.metric === 'DIVERSITY' ? 'The diversity score worked out by the platform with this loan added at the ticket size' : 'The compliance engine’s pro forma: the CLO scored with and without this loan bought at the ticket size'}. Green is better: lower for a maximum, higher for a minimum.`,
      [
        { label: 'Before', value: fmtMeasure(c.metric, c.before) },
        { label: 'After', value: fmtMeasure(c.metric, c.after) },
        { label: c.direction === 'MIN' ? 'Minimum' : 'Maximum', value: fmtMeasure(c.metric, c.limit) },
        { label: 'Gain, share of the cushion', value: c.gainPctOfCushion == null ? '—' : `${fmtNum(c.gainPctOfCushion, 1)}%` },
      ])}>{fmtMeasureChange(c.metric, raw)}</Derived>
  );
}

function Verdict({ o }: { o: Opportunity }) {
  const s = o.score;
  if (!s) return <span className="x-nil">{o.error ? 'Could not score' : '—'}</span>;
  const how = () => countHow(`${o.name} · Engine verdict`, s.approved ? 'Approved' : 'Blocked', 'The compliance engine’s pro forma of buying this loan at the ticket size. A buy is blocked when it puts a passing test into breach, or makes a failing test worse (maintain or improve).',
    o.moves.map((m) => ({ label: m.ruleName, sub: m.groupByValue || undefined, value: `${m.verdict.toLowerCase().replace(/_/g, ' ')}: ${fmtNum(m.baselineValue, 2)} to ${fmtNum(m.scenarioValue, 2)}` })));
  return (
    <Derived name={`${o.name} verdict`} how={how}>
      <span className={`x-st ${s.approved ? 'ok' : 'breach'}`}>{s.approved ? 'Approved' : `Blocked${s.newBreaches ? `, ${s.newBreaches} new` : ''}`}</span>
    </Derived>
  );
}

function SizeIt({ v, asOf, o }: { v: Vehicle; asOf: string; o: Opportunity }) {
  const host = useSurfaceHost();
  const [state, setState] = useState<{ loading: boolean; capacity: Capacity | null; error: string | null }>({ loading: false, capacity: null, error: null });
  if (state.capacity) {
    const c = state.capacity;
    const shown = c.capacityPar == null ? 'No cap' : fmtUsd(c.capacityPar);
    return (
      <Derived name={`${o.name} capacity`} how={() => countHow(`${o.name} · Largest buy`, shown, 'The platform’s capacity solver: the most par of this loan the CLO can buy before a test it would worsen reaches its limit. The probe carries the offer price and no expected interest.',
        c.lines.slice(0, 10).map((l) => ({ label: l.ruleName, sub: l.groupByValue || undefined, value: l.capacityPar == null ? 'no cap' : fmtUsd(l.capacityPar) })))}>{shown}</Derived>
    );
  }
  if (state.error) return <span className="x-dn" title={state.error}>Could not size</span>;
  return (
    <button className="btn btn-sm" disabled={state.loading} onClick={async (e) => {
      e.stopPropagation();
      setState({ loading: true, capacity: null, error: null });
      const r = await loadCapacity(host, v.id, asOf, o);
      setState({ loading: false, capacity: r.capacity, error: r.error });
    }}>{state.loading ? 'Sizing…' : 'Largest buy'}</button>
  );
}

export function OpportunitiesTab({ v, asOf, data, loading, error, onRetry }: { v: Vehicle; asOf: string; data: Opportunities | null; loading: boolean; error: string | null; onRetry: () => void }) {
  if (error && !data) return <ErrorPanel message={`Could not score the offered loans: ${error}`} onRetry={onRetry} />;
  if (!data) return <Loading text={loading ? `Scoring each offered loan as a buy for ${v.name}. The engine runs every test with and without each loan; this takes a few seconds.` : 'Offered loans are scored when this tab is opened.'} />;
  if (!data.opportunities.length) return <Empty>No loan is offered in the market that this CLO does not already hold. A loan is offered when its security has a market status of Offered.</Empty>;
  const cols = opportunityColumns(v);
  return (
    <>
      <div className="x-section">
        <p>
          {data.scored} of {data.candidates} offered loans scored for {v.name} as of {fmtDay(data.asOfDate)}. Each is bought at a ticket of the CLO&rsquo;s average holding par, capped at the size offered. Ranked: buys the engine approves first, then the most failing tests cured, then the composition score (each measure&rsquo;s gain as a share of its cushion, added up).
        </p>
      </div>
      <div className="x-frame">
        <table className="da-grid x-table">
          <thead>
            <tr>
              <th className="x-name">Loan and obligor</th>
              <th>Industry</th>
              <th>Moody&rsquo;s</th>
              <th className="num">Spread</th>
              <th className="num">Life</th>
              <th className="num">Offer</th>
              <th className="num">Ticket</th>
              <th>Engine</th>
              <th className="num" title="Failing tests this buy cures">Cures</th>
              {cols.map((c) => <th key={c.key} className="num">{c.label}</th>)}
              <th className="num" title="Each measure's gain as a share of its cushion, added up">Score</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {data.opportunities.map((o) => (
              <tr key={o.securityId}>
                <td className="x-name">
                  <div className="x-namebox">
                    <RecordLink path={recordPath.security(o.securityId)}>{o.name}</RecordLink>
                    <small>{o.issuerId ? <RecordLink path={recordPath.issuer(o.issuerId)}>{o.issuer}</RecordLink> : o.issuer}{o.covLite ? ' · cov-lite' : ''}{o.lien === 'SECOND_LIEN' ? ' · second lien' : ''}</small>
                  </div>
                </td>
                <td>
                  <div className="x-namebox">
                    <BoundOr bind={onIssuer(o, ATTR.industry, 'Moody’s industry')} value={o.industry} shown={o.industry || ''} />
                    {o.newIndustry && <small className="x-up">new to this CLO</small>}
                  </div>
                </td>
                <td><BoundOr bind={onOffer(o, ATTR.moodys, 'Moody’s facility rating')} value={o.ratingMoodys} shown={o.ratingMoodys || ''} /></td>
                <td className="num"><BoundOr bind={onOffer(o, ATTR.spread, 'Spread')} value={o.spreadBps} shown={fmtBps(o.spreadBps)} /></td>
                <td className="num">{o.lifeYears == null ? <span className="x-nil">—</span> : <Derived name={`${o.name} life`} how={() => countHow(`${o.name} · Remaining life`, fmtYears(o.lifeYears), 'Years from the As Of date to the loan’s maturity date.', [{ label: 'Maturity date', value: fmtDay(o.maturity), bind: onOffer(o, ATTR.maturity, 'Maturity date') }])}>{fmtYears(o.lifeYears)}</Derived>}</td>
                <td className="num"><BoundOr bind={onOffer(o, ATTR.offerPrice, 'Offer price')} value={o.offerPrice} shown={fmtNum(o.offerPrice, 2)} /></td>
                <td className="num"><Derived name={`${o.name} ticket`} how={() => countHow(`${o.name} · Ticket`, fmtUsd(o.ticket), `${data.ticketRule}.`, [{ label: 'Average holding par', value: fmtUsd(data.baseline.averagePar) }, { label: 'Size offered', value: fmtUsd(o.offerSize), bind: onOffer(o, ATTR.offerSize, 'Offer size') }])}>{fmtUsd(o.ticket)}</Derived></td>
                <td><Verdict o={o} /></td>
                <td className="num">{o.score ? <Derived className={o.score.cures ? 'x-up' : undefined} name={`${o.name} cures`} how={() => countHow(`${o.name} · Tests cured`, String(o.score!.cures), 'Tests in breach today that the engine scores as passing after the buy.', o.moves.filter((m) => m.verdict === 'CURED').map((m) => ({ label: m.ruleName, sub: m.groupByValue || undefined, value: `${fmtNum(m.baselineValue, 2)} to ${fmtNum(m.scenarioValue, 2)}` })))}>{o.score.cures}</Derived> : <span className="x-nil">—</span>}</td>
                {cols.map((c) => <td key={c.key} className="num"><ChangeCell o={o} c={c.pick(o)} /></td>)}
                <td className="num">{o.score ? <Derived name={`${o.name} score`} how={() => countHow(`${o.name} · Composition score`, fmtNum(o.score!.compositionScore, 1), 'Each tracked measure’s gain as a share of its cushion before the buy, each held to plus or minus 100, added up. Positive means the buy leaves the CLO further inside its limits overall.', o.score!.changes.map((c) => ({ label: c.label, value: c.gainPctOfCushion == null ? '—' : `${fmtNum(c.gainPctOfCushion, 1)}%` })))}>{fmtNum(o.score.compositionScore, 1)}</Derived> : <span className="x-nil">—</span>}</td>
                <td><SizeIt v={v} asOf={asOf} o={o} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.errors.length > 0 && <p className="x-note">{data.errors.length} loan{data.errors.length === 1 ? '' : 's'} could not be scored: {data.errors.slice(0, 2).join('; ')}</p>}
      <p className="x-note">A proposal, not a trade: buying goes through the allocation and pre-trade flow. <StatusPill status="PASS" /> here means the engine found no test this buy would push past its limit.</p>
    </>
  );
}
