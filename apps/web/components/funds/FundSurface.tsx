'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { graphqlMutation, graphqlQuery, UPDATE_ENTITY_MUTATION } from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';
import { useTemporalStore } from '@/lib/store';

const TABS = [
  ['nav', 'NAV'],
  ['pacing', 'Capital pacing'],
  ['activity', 'Capital activity'],
  ['review', 'NAV statement review'],
  ['returns', 'Returns'],
  ['liquidity', 'Liquidity'],
  ['investors', 'Investors'],
  ['exposure', 'Exposure'],
] as const;

const STRATEGIES = [
  ['DIRECT_LENDING', 'Direct lending'],
  ['OPPORTUNISTIC_CREDIT', 'Opportunistic credit'],
  ['ASSET_BASED_FINANCE', 'Asset-based finance'],
  ['SPECIAL_SITUATIONS', 'Special situations'],
] as const;

const INVESTOR_TYPES = [
  ['PENSION', 'Pension'],
  ['INSURANCE', 'Insurance'],
  ['FAMILY_OFFICE', 'Family office'],
  ['ENDOWMENT', 'Endowment'],
  ['FUND_OF_FUNDS', 'Fund of funds'],
  ['FOUNDATION', 'Foundation'],
  ['GENERAL_PARTNER', 'General partner'],
] as const;

const ACTIVITY_STATUSES = ['FUNDED', 'PAID', 'PROJECTED', 'SCHEDULED'] as const;

type TabKey = (typeof TABS)[number][0];

interface Cell { amount: number | null; entityId: string | null; attributeCode: string | null }
interface Line {
  id: string; label: string; role: string; indent: number;
  administrator: number | null; shadow: number | null; variance: number | null; variancePct: number | null;
  status: string | null; reviewable: boolean; statement: string; signed: number | null;
}
interface Surface {
  fundId: string; fundCode: string; fundName: string;
  strategyCode: string; strategyLabel: string; vintage: string; reportingDate: string;
  commitmentsClosed: string; investmentPeriodEnd: string; monthsRemaining: number | null;
  nav: number; commitments: number; called: number; distributed: number; unfunded: number; netPaidIn: number;
  grossIrr: number | null; feeDrag: number | null; expenseDrag: number | null; carryDrag: number | null; netIrr: number | null;
  tvpi: number | null; dpi: number | null; rvpi: number | null;
  cash: number; unfundedBorrower: number; liquidityMin: number; targetCalledPct: number;
  facilityAvailability: number; availableLiquidity: number; liquidityCoverage: number | null;
  investmentsFairValue: number; activePositions: number; sectorCount: number;
  floatingRatePct: number | null; weightedLeverage: number | null; weightedMark: number | null; marksBelow: number;
  reviewOpen: number; reviewFlagged: number; certified: boolean; tolerancePct: number; statementId: string | null; periodLabel: string;
  facility: null | { id: string; commitment: number; drawn: number; borrowingBase: number; availability: number; utilization: number | null; maturity: string };
  navChart: { labels: string[]; values: Array<number | null> };
  pacingChart: { labels: string[]; plan: Array<number | null>; actual: Array<number | null>; projected: Array<number | null> };
  activityChart: { labels: string[]; calls: number[]; distributions: number[] };
  rollforward: Line[];
  composition: Line[];
  plans: Array<{ id: string; label: string; callAmount: number | null; cumulative: number | null; calledPct: number | null; unfunded: number | null; planPct: number | null; versusPts: number | null }>;
  activities: Array<{ id: string; date: string; label: string; kind: string; amount: number; signed: number; status: string; statusLabel: string; outstanding: number | null; notice: string; pctOfCommitments: number | null }>;
  statements: Array<{ kind: string; title: string; period: string; comparable: boolean; rows: Line[] }>;
  marks: Array<{ id: string; name: string; mark: number | null; agent: number | null; difference: number | null; impact: number | null; status: string | null }>;
  positions: Array<{ id: string; name: string; strategy: string; sector: string; issuer: string; cost: number; fairValue: number; income: number; realized: number; gain: number; moic: number | null; grossIrr: number | null; mark: number | null; coupon: string; leverage: number | null; floating: boolean; active: boolean }>;
  forecastLabels: string[];
  forecastRows: Array<{ label: string; emphasize: boolean; cells: Cell[] }>;
  investors: Array<{ id: string; investorId: string; name: string; typeCode: string; typeLabel: string; commitment: number; sharePct: number | null; called: number; unfunded: number; distributions: number; nav: number; status: string; pastDue: number }>;
  investorTypes: Array<{ label: string; amount: number; sharePct: number | null }>;
  exposure: { strategy: Bar[]; sector: Bar[]; issuer: Bar[] };
  pacing: { calledPct: number | null; planPct: number | null; planLabel: string; behindPts: number | null; behindAmount: number | null; requiredCall: number | null; trailingCall: number | null };
  nextCall: { amount: number; notice: string; date: string } | null;
  largestInvestor: { name: string; sharePct: number | null } | null;
  pastDue: { name: string; amount: number | null } | null;
  investorCount: number;
  errors: Array<{ message: string }>;
}
interface Bar { key: string; label: string; amount: number; sharePct: number | null; limitPct: number | null; status: string; limitId: string | null }

const QUERY = `
  query FundSurface($fundId: ID!, $asOfDate: Date, $knowledgeDate: DateTime) {
    fundSurface(fundId: $fundId, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      fundId fundCode fundName strategyCode strategyLabel vintage reportingDate commitmentsClosed investmentPeriodEnd monthsRemaining
      nav commitments called distributed unfunded netPaidIn grossIrr feeDrag expenseDrag carryDrag netIrr tvpi dpi rvpi
      cash unfundedBorrower liquidityMin targetCalledPct facilityAvailability availableLiquidity liquidityCoverage
      investmentsFairValue activePositions sectorCount floatingRatePct weightedLeverage weightedMark marksBelow
      reviewOpen reviewFlagged certified tolerancePct statementId periodLabel investorCount
      facility { id commitment drawn borrowingBase availability utilization maturity }
      navChart { labels values }
      pacingChart { labels plan actual projected }
      activityChart { labels calls distributions }
      rollforward { id label role administrator signed }
      composition { id label signed administrator }
      plans { id label callAmount cumulative calledPct unfunded planPct versusPts }
      activities { id date label kind amount signed status statusLabel outstanding notice pctOfCommitments }
      statements { kind title period comparable rows { id label role indent administrator shadow variance variancePct status reviewable } }
      marks { id name mark agent difference impact status }
      positions { id name strategy sector issuer cost fairValue income realized gain moic grossIrr mark coupon leverage floating active }
      forecastLabels
      forecastRows { label emphasize cells { amount entityId attributeCode } }
      investors { id investorId name typeCode typeLabel commitment sharePct called unfunded distributions nav status pastDue }
      investorTypes { label amount sharePct }
      exposure { strategy { key label amount sharePct limitPct status limitId } sector { key label amount sharePct limitPct status limitId } issuer { key label amount sharePct limitPct status limitId } }
      pacing { calledPct planPct planLabel behindPts behindAmount requiredCall trailingCall }
      nextCall { amount notice date }
      largestInvestor { name sharePct }
      pastDue { name amount }
      errors { message }
    }
  }
`;

function digitsOf(amount: number, digits: number): string {
  return Math.abs(amount / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function paren(amount: number | null | undefined, digits = 1): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const text = digitsOf(amount, digits);
  return amount < -0.5 ? `(${text})` : text;
}

function dollars(amount: number | null | undefined, digits = 1): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  return amount < -0.5 ? `($${digitsOf(amount, digits)}M)` : `$${digitsOf(amount, digits)}M`;
}

function pct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

function multiple(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}x`;
}

function points(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const text = value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${text} pts`;
}

function when(value?: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function monthYear(value?: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function plainMillions(amount: number | null | undefined): string {
  if (amount == null) return '';
  return String(Math.round(amount / 1_000_000 * 1000) / 1000);
}

function EditableValue({
  value, display, kind, label, onSave,
}: {
  value: string; display?: string; kind: 'text' | 'number' | 'date'; label: string; onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <button type="button" className="da-edit" onClick={() => setEditing(true)} aria-label={`Edit ${label}`}>
        {display || value || '—'}
      </button>
    );
  }
  return (
    <input
      autoFocus
      type={kind === 'date' ? 'date' : kind === 'number' ? 'number' : 'text'}
      step={kind === 'number' ? '0.1' : undefined}
      aria-label={label}
      value={kind === 'date' ? value.slice(0, 10) : draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { setEditing(false); if (draft !== value) void onSave(draft); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') { setDraft(value); setEditing(false); }
      }}
    />
  );
}

function MoneyEdit({
  amount, label, digits = 1, format = 'plain', onSave,
}: {
  amount: number | null; label: string; digits?: number; format?: 'plain' | 'dollars'; onSave: (dollars: string) => Promise<void>;
}) {
  const shown = plainMillions(amount);
  return (
    <EditableValue
      kind="number"
      label={label}
      value={shown}
      display={format === 'dollars' ? dollars(amount, digits) : paren(amount, digits)}
      onSave={async (next) => {
        if (next.trim() === '' || Number.isNaN(Number(next))) return;
        await onSave(String(Number(next) * 1_000_000));
      }}
    />
  );
}

function Status({ status, outstanding }: { status?: string | null; outstanding?: number | null }) {
  if (outstanding && outstanding > 0) return <span className="da-st bind">{dollars(outstanding)} outstanding</span>;
  if (!status) return null;
  const review = status === 'REVIEW' || status === 'NEAR' || status === 'PAST_DUE';
  const kind = status === 'OVER' ? 'breach' : review ? 'bind' : status === 'PROJECTED' || status === 'SCHEDULED' ? 'na' : 'ok';
  const label = status === 'OK' ? 'Within tolerance'
    : status === 'RESOLVED' ? 'Resolved'
    : status === 'REVIEW' ? 'Review'
    : status === 'OVER' ? 'Over'
    : status === 'NEAR' ? 'Near'
    : status === 'PAST_DUE' ? 'Past due'
    : status === 'CURRENT' ? 'Current'
    : status;
  return <span className={`da-st ${kind}`}>{label}</span>;
}

function Chart({
  labels, series, max, unit = '', skip = 1,
}: {
  labels: string[];
  series: Array<{ name: string; color: string; values: Array<number | null>; kind: 'bar' | 'line'; dash?: boolean }>;
  max?: number;
  unit?: string;
  skip?: number;
}) {
  const width = 960;
  const height = 200;
  const left = 56;
  const bottom = 28;
  const top = 12;
  const right = 12;
  const peak = max ?? Math.max(1, ...series.flatMap((item) => item.values.filter((value): value is number => value != null))) * 1.12;
  const y = (value: number) => top + (height - top - bottom) * (1 - value / peak);
  const slot = labels.length ? (width - left - right) / labels.length : 0;
  const bars = series.filter((item) => item.kind === 'bar');
  const barWidth = Math.min(28, slot * 0.7 / Math.max(bars.length, 1));
  return (
    <div>
      <div className="fs-legend">
        {series.map((item) => (
          <span key={item.name}><i style={{ background: item.color }} />{item.name}</span>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" className="fs-chart">
        {[0, 1, 2, 3, 4].map((step) => {
          const value = peak * step / 4;
          return (
            <g key={step}>
              <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="var(--line)" />
              <text x={left - 8} y={y(value) + 4} textAnchor="end" fontSize="13" fill="var(--ink-3)">{Math.round(value)}{unit}</text>
            </g>
          );
        })}
        {labels.map((label, index) => index % skip === 0 ? (
          <text key={label} x={left + slot * (index + 0.5)} y={height - 8} textAnchor="middle" fontSize="13" fill="var(--ink-3)">{label}</text>
        ) : null)}
        {bars.map((item, seriesIndex) => item.values.map((value, index) => {
          if (value == null) return null;
          const x = left + slot * (index + 0.5) - (barWidth * bars.length) / 2 + seriesIndex * barWidth;
          return <rect key={`${item.name}-${index}`} x={x} y={y(value)} width={barWidth - 2} height={Math.max(0, y(0) - y(value))} rx={2} fill={item.color} />;
        }))}
        {series.filter((item) => item.kind === 'line').map((item) => (
          <polyline
            key={item.name}
            fill="none"
            stroke={item.color}
            strokeWidth="2.4"
            strokeDasharray={item.dash ? '5 4' : undefined}
            points={item.values.map((value, index) => (value == null ? '' : `${left + slot * (index + 0.5)},${y(value)}`)).filter(Boolean).join(' ')}
          />
        ))}
      </svg>
    </div>
  );
}

function Tiles({ items }: { items: Array<[string, string, string, string?]> }) {
  return (
    <div className="fs-tiles">
      {items.map(([label, value, note, tone]) => (
        <div className="fs-tile" key={label}>
          <span>{label}</span>
          <b>{value}</b>
          <small className={tone || ''}>{note}</small>
        </div>
      ))}
    </div>
  );
}

export function FundSurface({ fundId }: { fundId: string }) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [surface, setSurface] = useState<Surface | null>(null);
  const [tab, setTab] = useState<TabKey>('nav');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<'strategy' | 'sector' | 'issuer'>('strategy');

  const load = useCallback(async () => {
    setLoading(true);
    const result = await graphqlQuery<{ fundSurface: Surface }>(QUERY, { fundId, asOfDate, knowledgeDate }, 'network-only');
    const data = result.data?.fundSurface;
    if (result.error || !data) {
      setError(result.error?.message || 'Could not load the fund surface');
      setLoading(false);
      return;
    }
    setSurface(data);
    setError(data.errors?.[0]?.message || null);
    setLoading(false);
  }, [asOfDate, fundId, knowledgeDate]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const hash = window.location.hash.replace('#', '') as TabKey;
    if (TABS.some((item) => item[0] === hash)) setTab(hash);
  }, []);

  const choose = (next: TabKey) => {
    setTab(next);
    window.history.replaceState(null, '', `#${next}`);
  };

  const write = async (updates: Array<{ id: string; code: string; value: string }>) => {
    setNotice(null);
    setError(null);
    for (const update of updates) {
      const result = await graphqlMutation<{ updateEntity: { errors: Array<{ message: string }> } }>(UPDATE_ENTITY_MUTATION, {
        input: { id: update.id, attributes: { [update.code]: update.value }, asOfDate },
      });
      const message = result.error?.message || result.data?.updateEntity?.errors?.[0]?.message;
      if (message) {
        setError(message);
        return;
      }
    }
    setNotice('Saved.');
    await load();
  };

  const save = (id: string, code: string, value: string) => write([{ id, code, value }]);
  const saveMoney = (id: string, code: string) => (value: string) => save(id, code, value);

  if (loading && !surface) return <div className="xp-empty">Loading fund…</div>;
  if (!surface) return <div className="xp-error">{error || 'Fund not found'}</div>;

  const fund = surface;
  const resolved = fund.reviewFlagged - fund.reviewOpen;
  const behind = (fund.pacing.behindPts || 0) > 0.05;
  const investors = fund.investors.filter((item) => {
    const haystack = `${item.name} ${item.typeLabel}`.toLowerCase();
    return !query || haystack.includes(query.toLowerCase());
  });
  const exposure = fund.exposure[group];
  const totals = fund.positions.reduce((sum, position) => ({
    cost: sum.cost + position.cost,
    fairValue: sum.fairValue + (position.active ? position.fairValue : 0),
    income: sum.income + position.income,
    realized: sum.realized + position.realized,
    gain: sum.gain + position.gain,
  }), { cost: 0, fairValue: 0, income: 0, realized: 0, gain: 0 });

  return (
    <div className="da fs">
      {error && <div className="xp-error">{error}</div>}
      {notice && <p className="da-note">{notice}</p>}
      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Investment period</span>
          <h1><Link href={`${domainHref('FUND')}/${fund.fundId}`}>{fund.fundName}</Link></h1>
          <p>
            <select aria-label="Strategy" value={fund.strategyCode} onChange={(event) => { void save(fund.fundId, 'FUND_STRATEGY', event.target.value); }}>
              {STRATEGIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
            {', '}
            <EditableValue label="Vintage" kind="text" value={fund.vintage} display={fund.vintage || '—'} onSave={(value) => save(fund.fundId, 'FUND_VINTAGE', value)} />
            {' vintage. Reporting as of '}
            <EditableValue label="Reporting date" kind="date" value={fund.reportingDate} display={when(fund.reportingDate)} onSave={(value) => save(fund.fundId, 'FUND_REPORTING_DATE', value)} />
          </p>
        </div>
        <div className="da-facts">
          <div className="da-fact big"><span>NAV</span><strong>{dollars(fund.nav)}</strong></div>
          <div className="da-fact">
            <span>Commitments</span>
            <strong><MoneyEdit amount={fund.commitments} format="dollars" label="Commitments" onSave={saveMoney(fund.fundId, 'FUND_TOTAL_COMMITMENTS')} /></strong>
          </div>
          <div className="da-fact"><span>Called</span><strong>{pct(fund.pacing.calledPct, 0)} ({dollars(fund.called)})</strong></div>
          <div className="da-fact"><span>Unfunded</span><strong>{dollars(fund.unfunded)}</strong></div>
          <div className="da-fact"><span>Net IRR</span><strong>{pct(fund.netIrr)}</strong></div>
          <div className="da-fact"><span>TVPI / DPI</span><strong>{multiple(fund.tvpi)} / {multiple(fund.dpi)}</strong></div>
          <div className="da-fact"><span>Facility availability</span><strong>{dollars(fund.facilityAvailability)}</strong></div>
          <div className="da-fact"><span>Available liquidity</span><strong>{dollars(fund.availableLiquidity)}</strong></div>
        </div>
        <div className="da-holdbox">
          <div className="da-holdtop"><span>NAV statement review</span><b>{resolved} of {fund.reviewFlagged}</b></div>
          <div className="da-bar"><i style={{ width: `${fund.reviewFlagged ? (resolved / fund.reviewFlagged) * 100 : 100}%` }} /></div>
          <p className={fund.reviewOpen && !fund.certified ? 'fs-warn' : ''}>
            {fund.certified
              ? `NAV certified for ${when(fund.reportingDate)}.`
              : fund.reviewOpen
                ? `${fund.reviewOpen} flagged item${fund.reviewOpen === 1 ? '' : 's'} still open. Resolve them on the review tab.`
                : 'All flagged items resolved. Ready to certify.'}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={fund.certified || fund.reviewOpen > 0 || !fund.statementId}
            onClick={() => { if (fund.statementId) void save(fund.statementId, 'STATEMENT_CERTIFIED', 'true'); }}
          >
            {fund.certified ? 'Certified' : 'Certify NAV'}
          </button>
        </div>
      </header>

      <div className="da-tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" className={tab === key ? 'on' : ''} aria-selected={tab === key} onClick={() => choose(key)}>
            {label}
            {key === 'review' && fund.reviewOpen > 0 && !fund.certified && <span className="fs-tbadge">{fund.reviewOpen}</span>}
          </button>
        ))}
      </div>

      {tab === 'nav' && (
        <>
          <Tiles items={[
            ['NAV', dollars(fund.nav), `Administrator, ${when(fund.reportingDate)}`],
            ['Investments at fair value', dollars(fund.investmentsFairValue), `${fund.activePositions} active positions`],
            ['Credit facility', dollars(fund.facility?.drawn || 0), fund.nav ? `${pct((fund.facility?.drawn || 0) / fund.nav * 100, 0)} of NAV` : '—'],
            ['NAV per $100 committed', fund.commitments ? `$${((fund.nav / fund.commitments) * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—', 'Net of fees and leverage'],
          ]} />
          <div className="fs-main">
            <section>
              <div className="da-sechead"><h2>NAV by quarter</h2><p>Quarter-end NAV, $M.</p></div>
              <div className="fs-panel">
                <Chart labels={fund.navChart.labels} series={[{ name: 'NAV', color: '#0B5D73', kind: 'bar', values: fund.navChart.values.map((value) => (value == null ? null : value / 1e6)) }]} />
              </div>
            </section>
            <section>
              <div className="da-sechead"><h2>Q3 roll-forward</h2></div>
              <div className="da-gridwrap">
                <table className="da-grid">
                  <thead><tr><th>Item</th><th className="num">$M</th></tr></thead>
                  <tbody>
                    {fund.rollforward.map((line) => (
                      <tr key={line.id} className={line.role === 'TOTAL' ? 'par' : ''}>
                        <td>{line.label}</td>
                        <td className={`num ${line.signed != null && line.signed < 0 ? 'fs-neg' : ''}`}>{paren(line.administrator)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
          <section className="fs-block">
            <div className="da-sechead"><h2>NAV composition</h2><p>Assets and liabilities per the administrator’s statement. The review tab compares each line with our shadow calculation.</p></div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>Line</th><th className="num">Administrator ($M)</th><th className="num">% of NAV</th></tr></thead>
                <tbody>
                  {fund.composition.map((line) => (
                    <tr key={line.id}>
                      <td>{line.label}</td>
                      <td className={`num ${line.signed != null && line.signed < 0 ? 'fs-neg' : ''}`}>{paren(line.signed)}</td>
                      <td className="num">{fund.nav && line.signed != null ? pct(line.signed / fund.nav * 100) : '—'}</td>
                    </tr>
                  ))}
                  <tr className="par"><td>Net asset value</td><td className="num">{paren(fund.nav)}</td><td className="num">100.0%</td></tr>
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {tab === 'pacing' && (
        <>
          <Tiles items={[
            ['Called to date', pct(fund.pacing.calledPct), `${dollars(fund.called)} of ${dollars(fund.commitments)}`],
            ['Plan at ' + (fund.pacing.planLabel || 'quarter'), pct(fund.pacing.planPct), behind ? `Behind plan by ${points(fund.pacing.behindPts)} (${dollars(fund.pacing.behindAmount)})` : 'On plan', behind ? 'fs-warn' : ''],
            ['Required call per quarter', dollars(fund.pacing.requiredCall), `To reach ${pct(fund.targetCalledPct, 0)} by ${monthYear(fund.investmentPeriodEnd)}; trailing 4Q average ${dollars(fund.pacing.trailingCall)}`, (fund.pacing.requiredCall || 0) > (fund.pacing.trailingCall || 0) ? 'fs-warn' : ''],
            ['Investment period ends', monthYear(fund.investmentPeriodEnd), fund.monthsRemaining != null ? `${fund.monthsRemaining} months remaining` : ''],
          ]} />
          <section>
            <div className="da-sechead"><h2>Capital called as a share of commitments</h2><p>Actual to date, projected from the deal pipeline, and the deployment plan.</p></div>
            <div className="fs-panel">
              <Chart
                max={100}
                unit="%"
                skip={2}
                labels={fund.pacingChart.labels}
                series={[
                  { name: 'Plan', color: '#58647A', kind: 'line', values: fund.pacingChart.plan },
                  { name: 'Actual', color: '#0B5D73', kind: 'line', values: fund.pacingChart.actual },
                  { name: 'Projected', color: '#B5517A', kind: 'line', dash: true, values: fund.pacingChart.projected },
                ]}
              />
            </div>
          </section>
          <section className="fs-block">
            <div className="da-sechead"><h2>Projected calls</h2></div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>Quarter</th><th className="num">Call ($M)</th><th className="num">Cumulative ($M)</th><th className="num">% called</th><th className="num">Unfunded ($M)</th><th className="num">Plan</th><th className="num">Versus plan</th></tr></thead>
                <tbody>
                  {fund.plans.map((plan) => (
                    <tr key={plan.id}>
                      <td>{plan.label}</td>
                      <td className="num"><MoneyEdit amount={plan.callAmount} label={`${plan.label} call`} onSave={saveMoney(plan.id, 'PLAN_CALL_AMOUNT')} /></td>
                      <td className="num">{paren(plan.cumulative)}</td>
                      <td className="num">{pct(plan.calledPct)}</td>
                      <td className="num">{paren(plan.unfunded)}</td>
                      <td className="num"><EditableValue kind="number" label={`${plan.label} plan`} value={plan.planPct == null ? '' : String(plan.planPct)} display={pct(plan.planPct)} onSave={(value) => save(plan.id, 'PLAN_CALLED_PCT', value)} /></td>
                      <td className={`num ${plan.versusPts != null && plan.versusPts < 0 ? 'fs-neg' : ''}`}>{points(plan.versusPts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {tab === 'activity' && (
        <>
          <Tiles items={[
            ['Called to date', dollars(fund.called), `${pct(fund.pacing.calledPct, 0)} of commitments`],
            ['Distributed', dollars(fund.distributed), `DPI ${multiple(fund.dpi)}`],
            ['Net paid-in', dollars(fund.netPaidIn), 'Called less distributions'],
            ['Next call (projected)', fund.nextCall ? dollars(fund.nextCall.amount) : '—', fund.nextCall?.notice || ''],
          ]} />
          <section>
            <div className="da-sechead"><h2>Calls and distributions by quarter</h2><p>$M.</p></div>
            <div className="fs-panel">
              <Chart
                labels={fund.activityChart.labels}
                series={[
                  { name: 'Calls', color: '#0B5D73', kind: 'bar', values: fund.activityChart.calls.map((value) => value / 1e6) },
                  { name: 'Distributions', color: '#2F8F7A', kind: 'bar', values: fund.activityChart.distributions.map((value) => value / 1e6) },
                ]}
              />
            </div>
          </section>
          <section className="fs-block">
            <div className="da-sechead"><h2>Activity ledger</h2></div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>Date</th><th>Event</th><th className="num">Amount ($M)</th><th className="num">% of commitments</th><th>Status</th></tr></thead>
                <tbody>
                  {fund.activities.map((item) => (
                    <tr key={item.id}>
                      <td><EditableValue kind="date" label="Date" value={item.date} display={when(item.date)} onSave={(value) => save(item.id, 'ACTIVITY_DATE', value)} /></td>
                      <td>{item.label}</td>
                      <td className={`num ${item.kind === 'DISTRIBUTION' ? 'fs-neg' : ''}`}>
                        <MoneyEdit amount={item.kind === 'DISTRIBUTION' ? -item.amount : item.amount} label="Amount" onSave={async (value) => save(item.id, 'ACTIVITY_AMOUNT', String(Math.abs(Number(value))))} />
                      </td>
                      <td className="num">{pct(item.pctOfCommitments)}</td>
                      <td>
                        <select aria-label={`${item.label} status`} value={item.status} onChange={(event) => { void save(item.id, 'ACTIVITY_STATUS', event.target.value); }}>
                          {ACTIVITY_STATUSES.map((status) => <option key={status} value={status}>{status === 'FUNDED' ? 'Funded' : status === 'PAID' ? 'Paid' : status === 'PROJECTED' ? 'Projected' : 'Scheduled'}</option>)}
                        </select>
                        {item.outstanding ? <span className="fs-gap"><Status outstanding={item.outstanding} /></span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {tab === 'review' && (
        <>
          <div className="da-sechead">
            <div>
              <h2>NAV statements</h2>
              <p>Administrator statements for {fund.periodLabel || 'the period'}. Where we run a shadow calculation, the variance is shown and lines outside tolerance need review before the NAV is certified.</p>
            </div>
            <label className="fs-tol">
              Tolerance
              <select
                aria-label="Tolerance"
                value={String(fund.tolerancePct)}
                disabled={!fund.statementId}
                onChange={(event) => {
                  if (!fund.statementId) return;
                  void write([
                    { id: fund.statementId, code: 'STATEMENT_TOLERANCE_PCT', value: event.target.value },
                    { id: fund.statementId, code: 'STATEMENT_CERTIFIED', value: 'false' },
                  ]);
                }}
              >
                {[0.25, 0.5, 1, 2].map((value) => <option key={value} value={value}>{value}%</option>)}
              </select>
            </label>
          </div>
          {fund.statements.filter((item) => item.kind === 'BS' || item.kind === 'OPS').map((statement) => (
            <Statement key={statement.kind} statement={statement} onResolve={(id, resolved) => {
              const updates = [{ id, code: 'NAV_LINE_RESOLVED', value: resolved ? 'false' : 'true' }];
              if (fund.statementId) updates.push({ id: fund.statementId, code: 'STATEMENT_CERTIFIED', value: 'false' });
              return write(updates);
            }} onAmount={(id, code, value) => save(id, code, value)} />
          ))}
          <div className="fs-two">
            {fund.statements.filter((item) => item.kind === 'CHANGES' || item.kind === 'CASH').map((statement) => (
              <Statement key={statement.kind} statement={statement} onResolve={() => Promise.resolve()} onAmount={(id, code, value) => save(id, code, value)} />
            ))}
          </div>
          <section className="fs-block">
            <div className="da-sechead"><h2>Position marks</h2><p>Administrator mark against valuation agent price. Differences over one point are flagged.</p></div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>Position</th><th className="num">Admin mark</th><th className="num">Agent price</th><th className="num">Difference (pts)</th><th className="num">Value impact ($M)</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {fund.marks.map((mark) => (
                    <tr key={mark.id}>
                      <td><Link href={`${domainHref('POSITION')}/${mark.id}`}>{mark.name}</Link></td>
                      <td className="num"><EditableValue kind="number" label="Administrator mark" value={mark.mark == null ? '' : String(mark.mark)} display={mark.mark == null ? '—' : mark.mark.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} onSave={(value) => save(mark.id, 'POSITION_MARK', value)} /></td>
                      <td className="num"><EditableValue kind="number" label="Agent mark" value={mark.agent == null ? '' : String(mark.agent)} display={mark.agent == null ? '—' : mark.agent.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} onSave={(value) => save(mark.id, 'POSITION_AGENT_MARK', value)} /></td>
                      <td className="num">{mark.difference == null ? '—' : mark.difference.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
                      <td className={`num ${mark.impact != null && mark.impact < 0 ? 'fs-neg' : ''}`}>{paren(mark.impact)}</td>
                      <td><Status status={mark.status} /></td>
                      <td>{mark.status === 'REVIEW' || mark.status === 'RESOLVED' ? (
                        <button type="button" className="btn" onClick={() => {
                          const updates = [{ id: mark.id, code: 'POSITION_MARK_RESOLVED', value: mark.status === 'RESOLVED' ? 'false' : 'true' }];
                          if (fund.statementId) updates.push({ id: fund.statementId, code: 'STATEMENT_CERTIFIED', value: 'false' });
                          void write(updates);
                        }}>{mark.status === 'RESOLVED' ? 'Reopen' : 'Resolve'}</button>
                      ) : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {tab === 'returns' && (
        <>
          <Tiles items={[
            ['Gross IRR', pct(fund.grossIrr), 'Since inception'],
            ['Net IRR', pct(fund.netIrr), 'After fees, expenses and carry accrual'],
            ['TVPI', multiple(fund.tvpi), '(NAV + distributions) / paid-in'],
            ['DPI', multiple(fund.dpi), 'Distributions / paid-in'],
            ['RVPI', multiple(fund.rvpi), 'NAV / paid-in'],
          ]} />
          <div className="fs-main">
            <section>
              <div className="da-sechead"><h2>Position returns</h2><p>Fair value plus income and realized proceeds, against cost.</p></div>
              <div className="da-gridwrap">
                <table className="da-grid">
                  <thead><tr><th>Position</th><th>Strategy</th><th className="num">Cost</th><th className="num">Fair value</th><th className="num">Income</th><th className="num">Realized</th><th className="num">Gain</th><th className="num">MOIC</th><th className="num">Gross IRR</th></tr></thead>
                  <tbody>
                    {fund.positions.map((position) => (
                      <tr key={position.id}>
                        <td><Link href={`${domainHref('POSITION')}/${position.id}`}>{position.name}</Link></td>
                        <td>{position.strategy}</td>
                        <td className="num"><MoneyEdit amount={position.cost} label="Cost" onSave={saveMoney(position.id, 'POSITION_COST')} /></td>
                        <td className="num"><MoneyEdit amount={position.fairValue} label="Fair value" onSave={saveMoney(position.id, 'MARKET_VALUE')} /></td>
                        <td className="num"><MoneyEdit amount={position.income} label="Income" onSave={saveMoney(position.id, 'POSITION_INCOME')} /></td>
                        <td className="num">{position.realized ? <MoneyEdit amount={position.realized} label="Realized" onSave={saveMoney(position.id, 'POSITION_REALIZED_GAIN')} /> : '—'}</td>
                        <td className={`num ${position.gain < 0 ? 'fs-neg' : ''}`}>{paren(position.gain)}</td>
                        <td className="num">{multiple(position.moic)}</td>
                        <td className="num"><EditableValue kind="number" label="Gross IRR" value={position.grossIrr == null ? '' : String(position.grossIrr)} display={pct(position.grossIrr)} onSave={(value) => save(position.id, 'POSITION_GROSS_IRR', value)} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td><td />
                      <td className="num">{paren(totals.cost)}</td>
                      <td className="num">{paren(totals.fairValue)}</td>
                      <td className="num">{paren(totals.income)}</td>
                      <td className="num">{paren(totals.realized)}</td>
                      <td className="num">{paren(totals.gain)}</td>
                      <td className="num">{totals.cost ? multiple((totals.fairValue + totals.income + totals.realized) / totals.cost) : '—'}</td>
                      <td className="num">{pct(fund.grossIrr)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
            <section>
              <div className="da-sechead"><h2>Gross to net</h2><p>IRR bridge, percentage points.</p></div>
              <div className="da-gridwrap">
                <table className="da-grid">
                  <thead><tr><th>Step</th><th className="num">Pts</th></tr></thead>
                  <tbody>
                    <tr><td>Gross IRR</td><td className="num"><EditableValue kind="number" label="Gross IRR" value={fund.grossIrr == null ? '' : String(fund.grossIrr)} display={pct(fund.grossIrr)} onSave={(value) => save(fund.fundId, 'FUND_GROSS_IRR', value)} /></td></tr>
                    <tr><td>Management fee</td><td className="num fs-neg"><EditableValue kind="number" label="Management fee drag" value={fund.feeDrag == null ? '' : String(fund.feeDrag)} display={fund.feeDrag == null ? '—' : `(${fund.feeDrag.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })})`} onSave={(value) => save(fund.fundId, 'FUND_FEE_DRAG_PTS', value)} /></td></tr>
                    <tr><td>Fund expenses</td><td className="num fs-neg"><EditableValue kind="number" label="Expense drag" value={fund.expenseDrag == null ? '' : String(fund.expenseDrag)} display={fund.expenseDrag == null ? '—' : `(${fund.expenseDrag.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })})`} onSave={(value) => save(fund.fundId, 'FUND_EXPENSE_DRAG_PTS', value)} /></td></tr>
                    <tr><td>Carry accrual</td><td className="num fs-neg"><EditableValue kind="number" label="Carry drag" value={fund.carryDrag == null ? '' : String(fund.carryDrag)} display={fund.carryDrag == null ? '—' : `(${fund.carryDrag.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })})`} onSave={(value) => save(fund.fundId, 'FUND_CARRY_DRAG_PTS', value)} /></td></tr>
                  </tbody>
                  <tfoot><tr><td>Net IRR</td><td className="num">{fund.netIrr == null ? '—' : fund.netIrr.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td></tr></tfoot>
                </table>
              </div>
            </section>
          </div>
        </>
      )}

      {tab === 'liquidity' && (
        <>
          <Tiles items={[
            ['Cash', dollars(fund.cash), when(fund.reportingDate)],
            ['Facility availability', dollars(fund.facilityAvailability), 'Limited by borrowing base'],
            ['Callable investor commitments', dollars(fund.unfunded), 'Unfunded, excluding GP'],
            ['Unfunded borrower commitments', dollars(fund.unfundedBorrower), 'Delayed draw and revolvers'],
            ['Liquidity coverage', multiple(fund.liquidityCoverage, 1), `Cash plus availability over borrower commitments; minimum ${multiple(fund.liquidityMin, 2)}`, (fund.liquidityCoverage || 0) < fund.liquidityMin ? 'fs-warn' : ''],
          ]} />
          <div className="fs-main">
            <section>
              <div className="da-sechead"><h2>Four-quarter cash forecast</h2><p>$M, projected.</p></div>
              <div className="da-gridwrap">
                <table className="da-grid">
                  <thead>
                    <tr><th />{fund.forecastLabels.map((label) => <th key={label} className="num">{label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {fund.forecastRows.map((row) => (
                      <tr key={row.label} className={row.emphasize ? 'par' : ''}>
                        <td>{row.label}</td>
                        {row.cells.map((cell, index) => (
                          <td key={`${row.label}-${index}`} className={`num ${cell.amount != null && cell.amount < 0 ? 'fs-neg' : ''}`}>
                            {cell.entityId && cell.attributeCode
                              ? <MoneyEdit amount={cell.amount} label={row.label} onSave={saveMoney(cell.entityId, cell.attributeCode)} />
                              : paren(cell.amount)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section>
              <div className="da-sechead"><h2>Credit facility</h2></div>
              <div className="fs-panel">
                {fund.facility ? (
                  <dl className="fs-kv">
                    <dt>Commitment</dt><dd><MoneyEdit format="dollars" amount={fund.facility.commitment} label="Facility commitment" onSave={saveMoney(fund.facility.id, 'FACILITY_COMMITMENT')} /></dd>
                    <dt>Drawn</dt><dd><MoneyEdit format="dollars" amount={fund.facility.drawn} label="Drawn" onSave={saveMoney(fund.facility.id, 'FACILITY_DRAWN')} /></dd>
                    <dt>Borrowing base</dt><dd><MoneyEdit format="dollars" amount={fund.facility.borrowingBase} label="Borrowing base" onSave={saveMoney(fund.facility.id, 'FACILITY_BORROWING_BASE')} /></dd>
                    <dt>Availability</dt><dd>{dollars(fund.facility.availability)}</dd>
                    <dt>Utilization</dt><dd>{pct(fund.facility.utilization, 0)}</dd>
                    <dt>Maturity</dt><dd><EditableValue kind="date" label="Maturity" value={fund.facility.maturity} display={monthYear(fund.facility.maturity)} onSave={(value) => save(fund.facility!.id, 'FACILITY_MATURITY', value)} /></dd>
                  </dl>
                ) : <p className="da-note">No credit facility is linked to this fund.</p>}
                {fund.facility && fund.facility.commitment > 0 && (
                  <div className="da-bar fs-util"><i style={{ width: `${Math.min(100, (fund.facility.drawn / fund.facility.commitment) * 100)}%` }} /></div>
                )}
              </div>
            </section>
          </div>
        </>
      )}

      {tab === 'investors' && (
        <>
          <Tiles items={[
            ['Investors', String(fund.investorCount), 'Including GP and affiliates'],
            ['Commitments', dollars(fund.commitments), `Closed ${monthYear(fund.commitmentsClosed)}`],
            ['Largest investor', pct(fund.largestInvestor?.sharePct), fund.largestInvestor?.name || '—'],
            ['Past due', dollars(fund.pastDue?.amount || 0), fund.pastDue?.name || 'None', fund.pastDue ? 'fs-warn' : ''],
          ]} />
          <section>
            <div className="da-sechead">
              <div>
                <h2>Investor manifest</h2>
                <p>Commitments and capital account activity. NAV is allocated pro rata to commitments.</p>
              </div>
              <input type="search" value={query} placeholder="Search investor or type" aria-label="Search investors" onChange={(event) => setQuery(event.target.value)} />
            </div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>Investor</th><th>Type</th><th className="num">Commitment ($M)</th><th className="num">% of fund</th><th className="num">Called ($M)</th><th className="num">Unfunded ($M)</th><th className="num">Distributions ($M)</th><th className="num">NAV ($M)</th><th>Status</th></tr></thead>
                <tbody>
                  {investors.map((investor) => (
                    <tr key={investor.id}>
                      <td><Link href={`${domainHref('INVESTOR')}/${investor.investorId}`}>{investor.name}</Link></td>
                      <td>
                        <select aria-label={`${investor.name} type`} value={investor.typeCode} onChange={(event) => { void save(investor.investorId, 'INVESTOR_TYPE', event.target.value); }}>
                          {INVESTOR_TYPES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                        </select>
                      </td>
                      <td className="num"><MoneyEdit amount={investor.commitment} label="Commitment" onSave={saveMoney(investor.id, 'COMMITMENT_AMOUNT')} /></td>
                      <td className="num">{pct(investor.sharePct)}</td>
                      <td className="num">{paren(investor.called)}</td>
                      <td className="num">{paren(investor.unfunded)}</td>
                      <td className="num">{paren(investor.distributions)}</td>
                      <td className="num">{paren(investor.nav)}</td>
                      <td>
                        {investor.status === 'PAST_DUE' ? <span className="da-st bind">Past due {dollars(investor.pastDue)}</span> : <Status status="CURRENT" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td><td />
                    <td className="num">{paren(investors.reduce((sum, item) => sum + item.commitment, 0))}</td>
                    <td className="num">{pct(fund.commitments ? investors.reduce((sum, item) => sum + item.commitment, 0) / fund.commitments * 100 : null)}</td>
                    <td className="num">{paren(investors.reduce((sum, item) => sum + item.called, 0))}</td>
                    <td className="num">{paren(investors.reduce((sum, item) => sum + item.unfunded, 0))}</td>
                    <td className="num">{paren(investors.reduce((sum, item) => sum + item.distributions, 0))}</td>
                    <td className="num">{paren(investors.reduce((sum, item) => sum + item.nav, 0))}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
          <section className="fs-block">
            <div className="da-sechead"><h2>Commitments by investor type</h2></div>
            <div className="fs-panel">
              {fund.investorTypes.map((item) => (
                <div className="fs-brow" key={item.label}>
                  <span>{item.label}</span>
                  <div className="fs-bar"><i style={{ width: `${Math.min(100, item.sharePct || 0)}%` }} /></div>
                  <span>{dollars(item.amount)} · {pct(item.sharePct, 0)}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {tab === 'exposure' && (
        <>
          <Tiles items={[
            ['Active positions', String(fund.activePositions), `Across ${fund.sectorCount} sectors`],
            ['Floating rate', pct(fund.floatingRatePct, 0), 'Share of fair value'],
            ['Weighted leverage', multiple(fund.weightedLeverage, 1), 'Net debt to EBITDA at close'],
            ['Weighted mark', fund.weightedMark == null ? '—' : fund.weightedMark.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }), `${fund.marksBelow} below 97`],
          ]} />
          <section>
            <div className="da-sechead">
              <div>
                <h2>Exposure</h2>
                <p>Share of investments at fair value. The marker shows the concentration limit.</p>
              </div>
              <div className="fs-seg">
                {(['strategy', 'sector', 'issuer'] as const).map((key) => (
                  <button key={key} type="button" aria-pressed={group === key} onClick={() => setGroup(key)}>
                    {key === 'strategy' ? 'Strategy' : key === 'sector' ? 'Sector' : 'Issuer'}
                  </button>
                ))}
              </div>
            </div>
            <div className="fs-panel">
              {exposure.map((bar) => (
                <div className="fs-brow" key={bar.key}>
                  <span>{bar.label}</span>
                  <div className="fs-track">
                    <i style={{ width: `${Math.min(100, ((bar.sharePct || 0) / 70) * 100)}%` }} />
                    {bar.limitPct != null && <b style={{ left: `${Math.min(100, (bar.limitPct / 70) * 100)}%` }} title="Limit" />}
                  </div>
                  <span>
                    {dollars(bar.amount)} · {pct(bar.sharePct)} <Status status={bar.status} />
                    {bar.limitId && (
                      <span className="fs-gap">
                        <EditableValue kind="number" label={`${bar.label} limit`} value={bar.limitPct == null ? '' : String(bar.limitPct)} display={pct(bar.limitPct, 0)} onSave={(value) => save(bar.limitId!, 'LIMIT_PCT', value)} />
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="fs-block">
            <div className="da-sechead"><h2>Positions</h2></div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>Position</th><th>Sector</th><th className="num">Fair value ($M)</th><th className="num">Mark</th><th className="num">Coupon</th><th className="num">Leverage</th></tr></thead>
                <tbody>
                  {fund.positions.filter((position) => position.active).map((position) => (
                    <tr key={position.id}>
                      <td><Link href={`${domainHref('POSITION')}/${position.id}`}>{position.name}</Link></td>
                      <td>{position.sector}</td>
                      <td className="num">{paren(position.fairValue)}</td>
                      <td className="num"><EditableValue kind="number" label="Mark" value={position.mark == null ? '' : String(position.mark)} display={position.mark == null ? '—' : position.mark.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} onSave={(value) => save(position.id, 'POSITION_MARK', value)} /></td>
                      <td className="num"><EditableValue kind="text" label="Coupon" value={position.coupon} onSave={(value) => save(position.id, 'POSITION_COUPON', value)} /></td>
                      <td className="num"><EditableValue kind="number" label="Leverage" value={position.leverage == null ? '' : String(position.leverage)} display={multiple(position.leverage, 1)} onSave={(value) => save(position.id, 'POSITION_LEVERAGE', value)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Statement({
  statement, onResolve, onAmount,
}: {
  statement: Surface['statements'][number];
  onResolve: (id: string, resolved: boolean) => Promise<void>;
  onAmount: (id: string, code: string, value: string) => Promise<void>;
}) {
  return (
    <article className="fs-stmt">
      <header className="fs-sth">
        <div className="k">Halyard Senior Credit Fund II</div>
        <h3>{statement.title}</h3>
        <div className="k">{statement.period}</div>
      </header>
      <div className="da-gridwrap" style={{ border: 0 }}>
        <table className="da-grid fs-stmt-table">
          <thead>
            <tr>
              <th />
              <th className="num">{statement.comparable ? 'Administrator' : '$M'}</th>
              {statement.comparable && <><th className="num">Shadow</th><th className="num">Variance</th><th className="num">Var %</th><th>Status</th></>}
            </tr>
          </thead>
          <tbody>
            {statement.rows.map((row) => {
              const quiet = row.role === 'HEADER' || row.role === 'NOTE';
              return (
                <tr key={row.id} className={row.role === 'TOTAL' ? 'par' : row.role === 'SUBTOTAL' ? 'fs-sub' : row.role === 'HEADER' ? 'fs-head' : ''}>
                  <td style={{ paddingLeft: 12 + row.indent * 16 }}>{row.label}</td>
                  {quiet ? <td /> : (
                    <td className={`num ${row.administrator != null && row.administrator < 0 ? 'fs-neg' : ''}`}>
                      <MoneyEdit amount={row.administrator} digits={2} label={`${row.label} administrator`} onSave={(value) => onAmount(row.id, 'NAV_LINE_ADMINISTRATOR', value)} />
                    </td>
                  )}
                  {statement.comparable && !quiet && (
                    <>
                      <td className="num">
                        {row.shadow == null ? '—' : <MoneyEdit amount={row.shadow} digits={2} label={`${row.label} shadow`} onSave={(value) => onAmount(row.id, 'NAV_LINE_SHADOW', value)} />}
                      </td>
                      <td className={`num ${row.variance != null && row.variance < 0 ? 'fs-neg' : ''}`}>{row.variance == null || Math.abs(row.variance) <= 1 ? '—' : paren(row.variance, 2)}</td>
                      <td className="num">{row.variancePct == null || Math.abs(row.variance || 0) <= 1 ? '—' : pct(row.variancePct, 2)}</td>
                      <td>
                        <Status status={row.status} />
                        {(row.status === 'REVIEW' || row.status === 'RESOLVED') && (
                          <button type="button" className="btn fs-gap" onClick={() => { void onResolve(row.id, row.status === 'RESOLVED'); }}>
                            {row.status === 'RESOLVED' ? 'Reopen' : 'Resolve'}
                          </button>
                        )}
                      </td>
                    </>
                  )}
                  {statement.comparable && quiet && <td colSpan={4} />}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </article>
  );
}
