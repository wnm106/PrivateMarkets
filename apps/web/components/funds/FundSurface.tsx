'use client';

import { createContext, useCallback, useContext, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { EVALUATE_COMPLIANCE_RULE_MUTATION, graphqlMutation, graphqlQuery, UPDATE_ENTITY_MUTATION, UPSERT_COMPLIANCE_THRESHOLD_MUTATION } from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';
import { useTemporalStore } from '@/lib/store';
import { FUND_PANEL_KEYS, mountedPanel, tabReason, useLiveSurface } from '@/components/surfaces/useLiveSurface';
import { useSurfaceNav } from '@/lib/surface-nav';
import { usePublishTabs, type TabPayload } from '@/lib/view-context';
import { attrBind, useInspectBind, type AttrBind } from '@/components/detail/InspectValue';
import { useLatestRequest } from '@/lib/use-latest-request';

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

type TabKey = (typeof TABS)[number][0] | 'accounts' | 'filings';
type FundStructure = 'PUBLIC_BDC' | 'CLOSED_END';

function defaultStructure(name: string): FundStructure {
  if (name === 'Meridian Credit Fund I' || name === 'Harbor Senior Income') return 'PUBLIC_BDC';
  return 'CLOSED_END';
}

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
  positions: Array<{ id: string; name: string; strategy: string; sector: string; issuer: string; issuerId: string | null; cost: number; fairValue: number; income: number; realized: number; gain: number; moic: number | null; grossIrr: number | null; mark: number | null; coupon: string; leverage: number | null; floating: boolean; active: boolean }>;
  forecastLabels: string[];
  forecastRows: Array<{ label: string; emphasize: boolean; cells: Cell[] }>;
  investors: Array<{ id: string; investorId: string; name: string; typeCode: string; typeLabel: string; commitment: number; sharePct: number | null; called: number; unfunded: number; distributions: number; nav: number; status: string; pastDue: number }>;
  investorTypes: Array<{ label: string; amount: number; sharePct: number | null }>;
  exposure: { strategy: Bar[]; sector: Bar[]; issuer: Bar[] };
  pacing: { calledPct: number | null; planPct: number | null; planLabel: string; behindPts: number | null; behindAmount: number | null; requiredCall: number | null; trailingCall: number | null };
  nextCall: { id: string; amount: number; notice: string; date: string } | null;
  largestInvestor: { name: string; sharePct: number | null } | null;
  pastDue: { name: string; amount: number | null } | null;
  investorCount: number;
  errors: Array<{ message: string }>;
}
interface Bar {
  key: string;
  label: string;
  amount: number;
  sharePct: number | null;
  limitPct: number | null;
  status: string;
  ruleId: string | null;
  ruleCode: string | null;
  thresholdId: string | null;
}

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
      positions { id name strategy sector issuer issuerId cost fairValue income realized gain moic grossIrr mark coupon leverage floating active }
      forecastLabels
      forecastRows { label emphasize cells { amount entityId attributeCode } }
      investors { id investorId name typeCode typeLabel commitment sharePct called unfunded distributions nav status pastDue }
      investorTypes { label amount sharePct }
      exposure { strategy { key label amount sharePct limitPct status ruleId ruleCode thresholdId } sector { key label amount sharePct limitPct status ruleId ruleCode thresholdId } issuer { key label amount sharePct limitPct status ruleId ruleCode thresholdId } }
      pacing { calledPct planPct planLabel behindPts behindAmount requiredCall trailingCall }
      nextCall { id amount notice date }
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

type InspectOpen = (event: MouseEvent, bind: AttrBind | null, value?: string) => void;

/** Opens a value's attribute detail. The surface provides it so an edit made there reloads the surface. */
const InspectContext = createContext<InspectOpen>(() => undefined);

const INSPECT_TITLE = 'Right-click to view sources';

/** A read-only value that points back to its attribute. Unbound values render as they are. */
function Src({ bind, value, children }: { bind: AttrBind | null | undefined; value?: string; children: ReactNode }) {
  const open = useContext(InspectContext);
  if (!bind) return <>{children}</>;
  return (
    <span className="attr-inspectable" title={INSPECT_TITLE} onContextMenu={(event) => open(event, bind, value)}>
      {children}
    </span>
  );
}

function EditableValue({
  value, display, kind, label, bind, onSave,
}: {
  value: string; display?: string; kind: 'text' | 'number' | 'date'; label: string; bind?: AttrBind | null; onSave: (value: string) => Promise<void>;
}) {
  const open = useContext(InspectContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <button
        type="button"
        className={bind ? 'da-edit attr-inspectable' : 'da-edit'}
        title={bind ? INSPECT_TITLE : undefined}
        onClick={() => setEditing(true)}
        onContextMenu={bind ? (event) => open(event, bind, display || value) : undefined}
        aria-label={`Edit ${label}`}
      >
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
  amount, label, digits = 1, format = 'plain', bind, onSave,
}: {
  amount: number | null; label: string; digits?: number; format?: 'plain' | 'dollars'; bind?: AttrBind | null; onSave: (dollars: string) => Promise<void>;
}) {
  const shown = plainMillions(amount);
  return (
    <EditableValue
      kind="number"
      label={label}
      bind={bind}
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

/** label, value, note, tone, and the attribute the value is read from. */
type Tile = [string, string, string, string?, (AttrBind | null)?];

function Tiles({ items }: { items: Tile[] }) {
  return (
    <div className="fs-tiles">
      {items.map(([label, value, note, tone, bind]) => (
        <div className="fs-tile" key={label}>
          <span>{label}</span>
          <b><Src bind={bind} value={value}>{value}</Src></b>
          <small className={tone || ''}>{note}</small>
        </div>
      ))}
    </div>
  );
}

const cap = <T,>(rows: T[], limit: number) => rows.slice(0, limit);

/**
 * What each tab tells the assistant, built from the one load that feeds every tab.
 * The assistant sees all of them at once, whichever tab is open. Amounts are in dollars.
 */
function exposureStory(bar: Bar) {
  return {
    label: bar.label,
    amount: bar.amount,
    sharePct: bar.sharePct,
    limitPct: bar.limitPct,
    status: bar.status,
    ruleCode: bar.ruleCode,
  };
}

/** The name, purpose and reading notes of each tab, published whether or not the fund has loaded. */
const FUND_TAB_INFO = {
  nav: {
    label: 'NAV',
    purpose: 'What the fund is worth at the reporting date: NAV, how it rolls forward and what it is made of.',
    howToRead: 'Amounts are in dollars from the administrator. navChart is quarter-end NAV. rollforward is the administrator\'s NAV roll-forward. composition lists the lines behind the NAV.',
  },
  pacing: {
    label: 'Capital pacing',
    purpose: 'Whether capital is being called on plan: called to date against the deployment plan, and the call needed to reach the target by the end of the investment period.',
    howToRead: 'behindPts above zero means behind plan. requiredCallPerQuarter is what must be called each quarter to hit the target; compare it with the trailing four-quarter average.',
  },
  activity: {
    label: 'Capital activity',
    purpose: 'Capital calls and distributions: totals to date, the next projected call and each call or distribution.',
    howToRead: 'status is funded, paid, scheduled or projected. outstanding is what is still to be received on a call.',
  },
  review: {
    label: 'NAV statement review',
    purpose: 'Whether the administrator\'s NAV statements agree with our own calculation, line by line, and what must be resolved before the NAV is certified.',
    howToRead: 'variance is the difference between the administrator\'s figure and our own calculation (shadow). A line outside the tolerance is flagged. reviewOpen counts the flagged lines not yet resolved. certified means the NAV is signed off.',
  },
  returns: {
    label: 'Returns',
    purpose: 'How the fund has performed: gross to net IRR, TVPI, DPI and RVPI, and the return on each position against cost.',
    howToRead: 'IRRs are since inception. netIrr is after fees, expenses and the carry accrual. TVPI = (NAV + distributions) / paid-in; DPI = distributions / paid-in; RVPI = NAV / paid-in.',
  },
  liquidity: {
    label: 'Liquidity',
    purpose: 'Whether the fund can meet its obligations: cash, facility availability, unfunded commitments both ways and a four-quarter cash forecast.',
    howToRead: 'liquidityCoverage = (cash + facility availability) / unfunded borrower commitments, to be compared with liquidityMin. forecast rows are by quarter.',
  },
  investors: {
    label: 'Investors',
    purpose: 'Who has invested in the fund: each investor\'s commitment, called and unfunded capital, distributions and NAV share.',
    howToRead: 'NAV is allocated to investors pro rata to commitments. pastDue is called capital not yet received.',
  },
  exposure: {
    label: 'Exposure',
    purpose: 'How concentrated the investments are by strategy, sector and issuer, against their limits, and the active positions behind them.',
    howToRead: 'sharePct is the share of investments at fair value. limitPct is the hard limit from the compliance rule for that strategy, sector, or issuer (ruleCode). status is OVER above the hard limit and NEAR above the warning.',
  },
  accounts: {
    label: 'Capital accounts',
    purpose: 'Each investor\'s capital account in a closed-end fund: commitment, called, unfunded, distributions and NAV.',
  },
  filings: {
    label: 'Shareholder filings',
    purpose: 'The statements that go into a public BDC\'s shareholder report, and whether the NAV behind them is certified.',
  },
} satisfies Record<string, Omit<TabPayload, 'data'>>;

/** Tabs shown only for one fund structure. */
const STRUCTURE_TABS: Partial<Record<keyof typeof FUND_TAB_INFO, string>> = { accounts: 'CLOSED_END', filings: 'PUBLIC_BDC' };

/**
 * Every tab with data: null, for while the fund is still loading. A structure tab
 * is listed only when the structure is already known from the surface rules.
 */
function pendingFundTabs(structure: string): Record<string, TabPayload> {
  return Object.fromEntries(Object.entries(FUND_TAB_INFO)
    .filter(([key]) => {
      const only = STRUCTURE_TABS[key as keyof typeof FUND_TAB_INFO];
      return !only || only === structure;
    })
    .map(([key, tab]) => [key, { ...tab, data: null }]));
}

function fundTabs(fund: Surface, structure: string): Record<string, TabPayload> {
  const navPer100 = fund.commitments ? (fund.nav / fund.commitments) * 100 : null;
  const line = (row: Line) => ({ label: row.label, administrator: row.administrator, shadow: row.shadow, variance: row.variance, variancePct: row.variancePct, status: row.status });
  return {
    nav: {
      ...FUND_TAB_INFO.nav,
      data: {
        fund: fund.fundName, reportingDate: fund.reportingDate, nav: fund.nav, navPer100Committed: navPer100,
        investmentsFairValue: fund.investmentsFairValue, activePositions: fund.activePositions,
        facilityDrawn: fund.facility?.drawn ?? 0,
        navChart: fund.navChart,
        rollforward: fund.rollforward.map((row) => ({ label: row.label, role: row.role, amount: row.administrator })),
        composition: fund.composition.map((row) => ({ label: row.label, amount: row.administrator })),
      },
    },
    pacing: {
      ...FUND_TAB_INFO.pacing,
      data: {
        pacing: fund.pacing, called: fund.called, commitments: fund.commitments, targetCalledPct: fund.targetCalledPct,
        investmentPeriodEnd: fund.investmentPeriodEnd, monthsRemaining: fund.monthsRemaining,
        chart: fund.pacingChart,
        plans: fund.plans,
      },
    },
    activity: {
      ...FUND_TAB_INFO.activity,
      data: {
        called: fund.called, distributed: fund.distributed, netPaidIn: fund.netPaidIn, nextCall: fund.nextCall,
        chart: fund.activityChart,
        activities: cap(fund.activities, 60).map((item) => ({ date: item.date, label: item.label, kind: item.kind, amount: item.amount, status: item.statusLabel, outstanding: item.outstanding, pctOfCommitments: item.pctOfCommitments })),
      },
    },
    review: {
      ...FUND_TAB_INFO.review,
      data: {
        period: fund.periodLabel, certified: fund.certified, tolerancePct: fund.tolerancePct,
        flagged: fund.reviewFlagged, open: fund.reviewOpen,
        statements: fund.statements.map((statement) => ({ title: statement.title, period: statement.period, comparable: statement.comparable, lines: cap(statement.rows, 80).map(line) })),
        marks: cap(fund.marks, 60),
      },
    },
    returns: {
      ...FUND_TAB_INFO.returns,
      data: {
        grossIrr: fund.grossIrr, netIrr: fund.netIrr, feeDrag: fund.feeDrag, expenseDrag: fund.expenseDrag, carryDrag: fund.carryDrag,
        tvpi: fund.tvpi, dpi: fund.dpi, rvpi: fund.rvpi,
        positions: cap(fund.positions, 80).map((position) => ({ name: position.name, strategy: position.strategy, sector: position.sector, cost: position.cost, fairValue: position.fairValue, income: position.income, realized: position.realized, gain: position.gain, moic: position.moic, grossIrr: position.grossIrr, active: position.active })),
      },
    },
    liquidity: {
      ...FUND_TAB_INFO.liquidity,
      data: {
        cash: fund.cash, facilityAvailability: fund.facilityAvailability, availableLiquidity: fund.availableLiquidity,
        callableInvestorCommitments: fund.unfunded, unfundedBorrowerCommitments: fund.unfundedBorrower,
        liquidityCoverage: fund.liquidityCoverage, liquidityMin: fund.liquidityMin,
        facility: fund.facility,
        forecast: { quarters: fund.forecastLabels, rows: fund.forecastRows.map((row) => ({ label: row.label, amounts: row.cells.map((cell) => cell.amount) })) },
      },
    },
    investors: {
      ...FUND_TAB_INFO.investors,
      data: {
        investorCount: fund.investorCount, commitments: fund.commitments, commitmentsClosed: fund.commitmentsClosed,
        largestInvestor: fund.largestInvestor, pastDue: fund.pastDue,
        byType: fund.investorTypes,
        investors: cap(fund.investors, 120).map((item) => ({ name: item.name, type: item.typeLabel, commitment: item.commitment, sharePct: item.sharePct, called: item.called, unfunded: item.unfunded, distributions: item.distributions, nav: item.nav, status: item.status, pastDue: item.pastDue })),
      },
    },
    exposure: {
      ...FUND_TAB_INFO.exposure,
      data: {
        activePositions: fund.activePositions, sectors: fund.sectorCount, floatingRatePct: fund.floatingRatePct,
        weightedLeverage: fund.weightedLeverage, weightedMark: fund.weightedMark, marksBelow97: fund.marksBelow,
        byStrategy: fund.exposure.strategy.map(exposureStory), bySector: fund.exposure.sector.map(exposureStory), byIssuer: fund.exposure.issuer.map(exposureStory),
        positions: cap(fund.positions.filter((position) => position.active), 80).map((position) => ({ name: position.name, sector: position.sector, issuer: position.issuer, fairValue: position.fairValue, coupon: position.coupon, leverage: position.leverage, floating: position.floating, mark: position.mark })),
      },
    },
    ...(structure === 'CLOSED_END' ? {
      accounts: {
        ...FUND_TAB_INFO.accounts,
        data: {
          commitments: fund.commitments, called: fund.called, unfunded: fund.unfunded, distributions: fund.distributed,
          accounts: cap(fund.investors, 120).map((item) => ({ name: item.name, commitment: item.commitment, called: item.called, unfunded: item.unfunded, distributions: item.distributions, nav: item.nav })),
        },
      },
    } : {}),
    ...(structure === 'PUBLIC_BDC' ? {
      filings: {
        ...FUND_TAB_INFO.filings,
        data: {
          nav: fund.nav, navPer100Committed: navPer100, period: fund.periodLabel, certified: fund.certified,
          filings: fund.statements.map((statement) => ({ title: statement.title, period: statement.period, status: fund.certified ? 'Certified' : 'Open' })),
        },
      },
    } : {}),
  };
}

export function FundSurface({ fundId }: { fundId: string }) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [surface, setSurface] = useState<Surface | null>(null);
  const [tab, setTab] = useState<TabKey>('nav');
  const [structureOverride, setStructureOverride] = useState<FundStructure | null>(null);
  const baselineRules = useLiveSurface('FUND_SURFACE', fundId);
  const storedStructure = baselineRules.resolution?.facts.find((fact) => fact.key === 'FUND_STRUCTURE')?.value || '';
  const effectiveStructure = structureOverride || storedStructure || (surface?.fundName ? defaultStructure(surface.fundName) : '');
  const structureOverlay = Boolean(effectiveStructure && effectiveStructure !== storedStructure);
  const ruled = useLiveSurface(
    'FUND_SURFACE',
    fundId,
    structureOverlay ? { FUND_STRUCTURE: effectiveStructure } : null,
  );
  const livePages = structureOverlay ? ruled.pages : baselineRules.pages;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<'strategy' | 'sector' | 'issuer'>('strategy');

  const latest = useLatestRequest();
  const load = useCallback(async () => {
    const request = latest.begin();
    setLoading(true);
    const result = await graphqlQuery<{ fundSurface: Surface }>(QUERY, { fundId, asOfDate, knowledgeDate }, 'network-only', request.signal);
    if (!request.current(result)) return;
    const data = result.data?.fundSurface;
    if (result.error || !data) {
      setError(result.error?.message || 'Could not load the fund surface');
      setLoading(false);
      return;
    }
    setSurface(data);
    setError(data.errors?.[0]?.message || null);
    setLoading(false);
  }, [latest, asOfDate, fundId, knowledgeDate]);

  useEffect(() => { setStructureOverride(null); }, [fundId]);

  useEffect(() => { void load(); }, [load]);

  const choose = (next: TabKey) => {
    setTab(next);
    window.history.replaceState(null, '', `#${next}`);
  };

  useEffect(() => {
    const hash = window.location.hash.replace('#', '') as TabKey;
    if (TABS.some((item) => item[0] === hash) || hash === 'accounts' || hash === 'filings') setTab(hash);
  }, []);

  useEffect(() => {
    if (livePages.length === 0) return;
    const open = livePages.filter((page) => mountedPanel(page, FUND_PANEL_KEYS));
    if (!open.some((page) => mountedPanel(page, FUND_PANEL_KEYS) === tab)) {
      const next = open[0];
      const key = next && mountedPanel(next, FUND_PANEL_KEYS);
      if (key) choose(key as TabKey);
    }
  }, [livePages, tab]);

  const write = async (updates: Array<{ id: string; code: string; value: string; sourceCode?: string }>) => {
    setNotice(null);
    setError(null);
    for (const update of updates) {
      const stored = update.sourceCode ? { value: update.value, sourceCode: update.sourceCode } : update.value;
      const result = await graphqlMutation<{ updateEntity: { errors: Array<{ message: string }> } }>(UPDATE_ENTITY_MUTATION, {
        input: { id: update.id, attributes: { [update.code]: stored }, asOfDate },
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

  const inspect = useInspectBind(() => { void load(); });

  const save = (id: string, code: string, value: string) => write([{ id, code, value }]);
  const saveMoney = (id: string, code: string) => (value: string) => save(id, code, value);
  const saveLimit = async (bar: Bar, value: string) => {
    if (!surface || !bar.ruleId || !bar.key || bar.key === '—') return;
    const hard = Number(value);
    if (!Number.isFinite(hard) || hard <= 0) {
      setError('A concentration limit is a percent greater than zero.');
      return;
    }
    setNotice(null);
    setError(null);
    const result = await graphqlMutation<{ upsertComplianceThreshold: { errors: Array<{ message: string }> } }>(
      UPSERT_COMPLIANCE_THRESHOLD_MUTATION,
      {
        input: {
          id: bar.thresholdId,
          ruleId: bar.ruleId,
          entityId: surface.fundId,
          groupValue: bar.key,
          hardLimitValue: hard,
          softLimitValue: Math.round(hard * 0.85 * 100) / 100,
          limitDirection: 'MAX',
          applies: true,
          notes: `${bar.label} concentration limit`,
        },
      },
    );
    const message = result.error?.message || result.data?.upsertComplianceThreshold?.errors?.[0]?.message;
    if (message) {
      setError(message);
      return;
    }
    if (bar.ruleCode) {
      await graphqlMutation(EVALUATE_COMPLIANCE_RULE_MUTATION, {
        input: { ruleCode: bar.ruleCode, asOfDate, entityId: surface.fundId },
      });
    }
    setNotice('Saved.');
    await load();
  };

  useSurfaceNav(surface?.fundName
    ? [
        { label: 'Fund surface', href: '/fund-surface' },
        { label: surface.fundName },
      ]
    : [{ label: 'Fund surface' }]);

  usePublishTabs(surface ? fundTabs(surface, effectiveStructure) : pendingFundTabs(effectiveStructure));

  if (loading && !surface) return <div className="xp-empty">Loading fund…</div>;
  if (!surface) return <div className="xp-error">{error || 'Fund not found'}</div>;

  const fund = surface;
  /** Where a value on this surface is stored: the fund, or one of the records linked to it. */
  const on = (id: string | null | undefined, domainCode: string, code: string, name: string, entityName?: string | null) => attrBind(id, domainCode, code, name, entityName);
  const ofFund = (code: string, name: string) => on(fund.fundId, 'FUND', code, name, fund.fundName);
  const ofStatement = (code: string, name: string) => on(fund.statementId, 'NAV_STATEMENT', code, name, fund.periodLabel ? `NAV statement ${fund.periodLabel}` : 'NAV statement');
  const ofFacility = (code: string, name: string) => on(fund.facility?.id, 'CREDIT_FACILITY', code, name, `${fund.fundName} facility`);
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
    <InspectContext.Provider value={inspect}>
    <div className="da fs">
      {error && <div className="xp-error">{error}</div>}
      {notice && <p className="da-note">{notice}</p>}
      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Investment period</span>
          <h1><Link href={`${domainHref('FUND')}/${fund.fundId}`}>{fund.fundName}</Link></h1>
          <p>
            <Src bind={ofFund('FUND_STRATEGY', 'Strategy')} value={fund.strategyLabel}>
              <select aria-label="Strategy" value={fund.strategyCode} onChange={(event) => { void save(fund.fundId, 'FUND_STRATEGY', event.target.value); }}>
                {STRATEGIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </Src>
            {'. '}
            <select
              aria-label="Fund structure"
              title="This value is a fact. The saved surface rules decide which tabs it opens."
              value={structureOverride || storedStructure || defaultStructure(fund.fundName)}
              onChange={(event) => setStructureOverride(event.target.value as FundStructure)}
            >
              <option value="CLOSED_END">Closed-end</option>
              <option value="PUBLIC_BDC">Public BDC</option>
            </select>
            {', '}
            <EditableValue label="Vintage" kind="text" bind={ofFund('FUND_VINTAGE', 'Vintage')} value={fund.vintage} display={fund.vintage || '—'} onSave={(value) => save(fund.fundId, 'FUND_VINTAGE', value)} />
            {' vintage. Reporting as of '}
            <EditableValue label="Reporting date" kind="date" bind={ofFund('FUND_REPORTING_DATE', 'Reporting Date')} value={fund.reportingDate} display={when(fund.reportingDate)} onSave={(value) => save(fund.fundId, 'FUND_REPORTING_DATE', value)} />
          </p>
        </div>
        <div className="da-facts">
          <div className="da-fact big"><span>NAV</span><strong><Src bind={ofFund('NAV', 'NAV')} value={dollars(fund.nav)}>{dollars(fund.nav)}</Src></strong></div>
          <div className="da-fact">
            <span>Commitments</span>
            <strong><MoneyEdit amount={fund.commitments} format="dollars" label="Commitments" bind={ofFund('FUND_TOTAL_COMMITMENTS', 'Total Commitments')} onSave={saveMoney(fund.fundId, 'FUND_TOTAL_COMMITMENTS')} /></strong>
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
        {(livePages.length > 0 ? livePages : TABS.map(([key, label]) => ({
          slotCode: key.toUpperCase(),
          slotName: label,
          status: 'RENDERED',
          decision: '',
          panelKey: key,
        }))).map((page) => {
          const key = mountedPanel(page, FUND_PANEL_KEYS);
          const open = Boolean(key);
          return (
            <button
              key={page.slotCode}
              type="button"
              role="tab"
              className={tab === key ? 'on' : ''}
              aria-selected={tab === key}
              disabled={!open}
              title={open ? undefined : tabReason(page, FUND_PANEL_KEYS)}
              onClick={() => { if (key) choose(key as TabKey); }}
            >
              {page.slotName}
              {key === 'review' && fund.reviewOpen > 0 && !fund.certified && <span className="fs-tbadge">{fund.reviewOpen}</span>}
            </button>
          );
        })}
      </div>

      {tab === 'nav' && (
        <>
          <Tiles items={[
            ['NAV', dollars(fund.nav), `Administrator, ${when(fund.reportingDate)}`, '', ofFund('NAV', 'NAV')],
            ['Investments at fair value', dollars(fund.investmentsFairValue), `${fund.activePositions} active positions`],
            ['Credit facility', dollars(fund.facility?.drawn || 0), fund.nav ? `${pct((fund.facility?.drawn || 0) / fund.nav * 100, 0)} of NAV` : '—', '', ofFacility('FACILITY_DRAWN', 'Drawn')],
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
                        <td className={`num ${line.signed != null && line.signed < 0 ? 'fs-neg' : ''}`}><Src bind={ofStatement(line.id, line.label)} value={paren(line.administrator)}>{paren(line.administrator)}</Src></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
          <section className="fs-block">
            <div className="da-sechead"><h2>NAV composition</h2><p>Assets and liabilities per the administrator’s statement. The review tab compares the fund administrator source with the internal source.</p></div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>Line</th><th className="num">Administrator ($M)</th><th className="num">% of NAV</th></tr></thead>
                <tbody>
                  {fund.composition.map((line) => (
                    <tr key={line.id}>
                      <td>{line.label}</td>
                      <td className={`num ${line.signed != null && line.signed < 0 ? 'fs-neg' : ''}`}><Src bind={ofStatement(line.id, line.label)} value={paren(line.signed)}>{paren(line.signed)}</Src></td>
                      <td className="num">{fund.nav && line.signed != null ? pct(line.signed / fund.nav * 100) : '—'}</td>
                    </tr>
                  ))}
                  <tr className="par"><td>Net asset value</td><td className="num"><Src bind={ofFund('NAV', 'NAV')} value={paren(fund.nav)}>{paren(fund.nav)}</Src></td><td className="num">100.0%</td></tr>
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
            ['Investment period ends', monthYear(fund.investmentPeriodEnd), fund.monthsRemaining != null ? `${fund.monthsRemaining} months remaining` : '', '', ofFund('FUND_INVESTMENT_PERIOD_END', 'Investment Period End')],
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
                      <td className="num"><MoneyEdit amount={plan.callAmount} label={`${plan.label} call`} bind={on(plan.id, 'CAPITAL_PLAN', 'PLAN_CALL_AMOUNT', 'Projected Call', plan.label)} onSave={saveMoney(plan.id, 'PLAN_CALL_AMOUNT')} /></td>
                      <td className="num">{paren(plan.cumulative)}</td>
                      <td className="num">{pct(plan.calledPct)}</td>
                      <td className="num">{paren(plan.unfunded)}</td>
                      <td className="num"><EditableValue kind="number" label={`${plan.label} plan`} bind={on(plan.id, 'CAPITAL_PLAN', 'PLAN_CALLED_PCT', 'Plan Called', plan.label)} value={plan.planPct == null ? '' : String(plan.planPct)} display={pct(plan.planPct)} onSave={(value) => save(plan.id, 'PLAN_CALLED_PCT', value)} /></td>
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
            ['Next call (projected)', fund.nextCall ? dollars(fund.nextCall.amount) : '—', fund.nextCall?.notice || '', '', on(fund.nextCall?.id, 'CAPITAL_ACTIVITY', 'ACTIVITY_AMOUNT', 'Amount')],
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
                      <td><EditableValue kind="date" label="Date" bind={on(item.id, 'CAPITAL_ACTIVITY', 'ACTIVITY_DATE', 'Date', item.label)} value={item.date} display={when(item.date)} onSave={(value) => save(item.id, 'ACTIVITY_DATE', value)} /></td>
                      <td>{item.label}</td>
                      <td className={`num ${item.kind === 'DISTRIBUTION' ? 'fs-neg' : ''}`}>
                        <MoneyEdit amount={item.kind === 'DISTRIBUTION' ? -item.amount : item.amount} label="Amount" bind={on(item.id, 'CAPITAL_ACTIVITY', 'ACTIVITY_AMOUNT', 'Amount', item.label)} onSave={async (value) => save(item.id, 'ACTIVITY_AMOUNT', String(Math.abs(Number(value))))} />
                      </td>
                      <td className="num">{pct(item.pctOfCommitments)}</td>
                      <td>
                        <Src bind={on(item.id, 'CAPITAL_ACTIVITY', 'ACTIVITY_STATUS', 'Status', item.label)} value={item.statusLabel}>
                          <select aria-label={`${item.label} status`} value={item.status} onChange={(event) => { void save(item.id, 'ACTIVITY_STATUS', event.target.value); }}>
                            {ACTIVITY_STATUSES.map((status) => <option key={status} value={status}>{status === 'FUNDED' ? 'Funded' : status === 'PAID' ? 'Paid' : status === 'PROJECTED' ? 'Projected' : 'Scheduled'}</option>)}
                          </select>
                        </Src>
                        {item.outstanding ? <span className="fs-gap"><Src bind={on(item.id, 'CAPITAL_ACTIVITY', 'ACTIVITY_OUTSTANDING', 'Outstanding', item.label)} value={dollars(item.outstanding)}><Status outstanding={item.outstanding} /></Src></span> : null}
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
              <p>Administrator statements for {fund.periodLabel || 'the period'}. The fund administrator and the internal calculation are two sources of each line. Lines outside tolerance need review before the NAV is certified.</p>
            </div>
            <label className="fs-tol">
              Tolerance
              <Src bind={ofStatement('STATEMENT_TOLERANCE_PCT', 'Tolerance')} value={`${fund.tolerancePct}%`}>
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
              </Src>
            </label>
          </div>
          {fund.statements.filter((item) => item.kind === 'BS' || item.kind === 'OPS').map((statement) => (
            <Statement key={statement.kind} statement={statement} bindLine={ofStatement} onResolve={(code, resolved) => {
              if (!fund.statementId) return Promise.resolve();
              const accepted = new Set(fund.statements.flatMap((item) => item.rows).filter((row) => row.status === 'RESOLVED').map((row) => row.id));
              if (resolved) accepted.delete(code);
              else accepted.add(code);
              return write([
                { id: fund.statementId, code: 'STATEMENT_ACCEPTED_LINES', value: JSON.stringify([...accepted]) },
                { id: fund.statementId, code: 'STATEMENT_CERTIFIED', value: 'false' },
              ]);
            }} onAmount={(code, sourceCode, value) => (fund.statementId ? write([{ id: fund.statementId, code, value, sourceCode }]) : Promise.resolve())} />
          ))}
          <div className="fs-two">
            {fund.statements.filter((item) => item.kind === 'CHANGES' || item.kind === 'CASH').map((statement) => (
              <Statement key={statement.kind} statement={statement} bindLine={ofStatement} onResolve={() => Promise.resolve()} onAmount={(code, sourceCode, value) => (fund.statementId ? write([{ id: fund.statementId, code, value, sourceCode }]) : Promise.resolve())} />
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
                      <td className="num"><EditableValue kind="number" label="Administrator mark" bind={on(mark.id, 'POSITION', 'POSITION_MARK', 'Administrator Mark', mark.name)} value={mark.mark == null ? '' : String(mark.mark)} display={mark.mark == null ? '—' : mark.mark.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} onSave={(value) => save(mark.id, 'POSITION_MARK', value)} /></td>
                      <td className="num"><EditableValue kind="number" label="Agent mark" bind={on(mark.id, 'POSITION', 'POSITION_AGENT_MARK', 'Agent Mark', mark.name)} value={mark.agent == null ? '' : String(mark.agent)} display={mark.agent == null ? '—' : mark.agent.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} onSave={(value) => save(mark.id, 'POSITION_AGENT_MARK', value)} /></td>
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
            ['Gross IRR', pct(fund.grossIrr), 'Since inception', '', ofFund('FUND_GROSS_IRR', 'Gross IRR')],
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
                        <td><Src bind={on(position.id, 'POSITION', 'POSITION_STRATEGY', 'Strategy', position.name)} value={position.strategy}>{position.strategy}</Src></td>
                        <td className="num"><MoneyEdit amount={position.cost} label="Cost" bind={on(position.id, 'POSITION', 'POSITION_COST', 'Cost', position.name)} onSave={saveMoney(position.id, 'POSITION_COST')} /></td>
                        <td className="num"><MoneyEdit amount={position.fairValue} label="Fair value" bind={on(position.id, 'POSITION', 'MARKET_VALUE', 'Fair Value', position.name)} onSave={saveMoney(position.id, 'MARKET_VALUE')} /></td>
                        <td className="num"><MoneyEdit amount={position.income} label="Income" bind={on(position.id, 'POSITION', 'POSITION_INCOME', 'Income', position.name)} onSave={saveMoney(position.id, 'POSITION_INCOME')} /></td>
                        <td className="num">{position.realized ? <MoneyEdit amount={position.realized} label="Realized" bind={on(position.id, 'POSITION', 'POSITION_REALIZED_GAIN', 'Realized Gain', position.name)} onSave={saveMoney(position.id, 'POSITION_REALIZED_GAIN')} /> : '—'}</td>
                        <td className={`num ${position.gain < 0 ? 'fs-neg' : ''}`}>{paren(position.gain)}</td>
                        <td className="num">{multiple(position.moic)}</td>
                        <td className="num"><EditableValue kind="number" label="Gross IRR" bind={on(position.id, 'POSITION', 'POSITION_GROSS_IRR', 'Gross IRR', position.name)} value={position.grossIrr == null ? '' : String(position.grossIrr)} display={pct(position.grossIrr)} onSave={(value) => save(position.id, 'POSITION_GROSS_IRR', value)} /></td>
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
                    <tr><td>Gross IRR</td><td className="num"><EditableValue kind="number" label="Gross IRR" bind={ofFund('FUND_GROSS_IRR', 'Gross IRR')} value={fund.grossIrr == null ? '' : String(fund.grossIrr)} display={pct(fund.grossIrr)} onSave={(value) => save(fund.fundId, 'FUND_GROSS_IRR', value)} /></td></tr>
                    <tr><td>Management fee</td><td className="num fs-neg"><EditableValue kind="number" label="Management fee drag" bind={ofFund('FUND_FEE_DRAG_PTS', 'Management Fee Drag')} value={fund.feeDrag == null ? '' : String(fund.feeDrag)} display={fund.feeDrag == null ? '—' : `(${fund.feeDrag.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })})`} onSave={(value) => save(fund.fundId, 'FUND_FEE_DRAG_PTS', value)} /></td></tr>
                    <tr><td>Fund expenses</td><td className="num fs-neg"><EditableValue kind="number" label="Expense drag" bind={ofFund('FUND_EXPENSE_DRAG_PTS', 'Fund Expense Drag')} value={fund.expenseDrag == null ? '' : String(fund.expenseDrag)} display={fund.expenseDrag == null ? '—' : `(${fund.expenseDrag.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })})`} onSave={(value) => save(fund.fundId, 'FUND_EXPENSE_DRAG_PTS', value)} /></td></tr>
                    <tr><td>Carry accrual</td><td className="num fs-neg"><EditableValue kind="number" label="Carry drag" bind={ofFund('FUND_CARRY_DRAG_PTS', 'Carry Drag')} value={fund.carryDrag == null ? '' : String(fund.carryDrag)} display={fund.carryDrag == null ? '—' : `(${fund.carryDrag.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })})`} onSave={(value) => save(fund.fundId, 'FUND_CARRY_DRAG_PTS', value)} /></td></tr>
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
            ['Cash', dollars(fund.cash), when(fund.reportingDate), '', ofFund('FUND_CASH_BALANCE', 'Cash on Hand')],
            ['Facility availability', dollars(fund.facilityAvailability), 'Limited by borrowing base'],
            ['Callable investor commitments', dollars(fund.unfunded), 'Unfunded, excluding GP'],
            ['Unfunded borrower commitments', dollars(fund.unfundedBorrower), 'Delayed draw and revolvers', '', ofFund('FUND_UNFUNDED_BORROWER_COMMITMENTS', 'Unfunded Borrower Commitments')],
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
                              ? <MoneyEdit amount={cell.amount} label={row.label} bind={on(cell.entityId, 'CASH_FORECAST', cell.attributeCode, row.label, fund.forecastLabels[index])} onSave={saveMoney(cell.entityId, cell.attributeCode)} />
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
                    <dt>Commitment</dt><dd><MoneyEdit format="dollars" amount={fund.facility.commitment} label="Facility commitment" bind={ofFacility('FACILITY_COMMITMENT', 'Commitment')} onSave={saveMoney(fund.facility.id, 'FACILITY_COMMITMENT')} /></dd>
                    <dt>Drawn</dt><dd><MoneyEdit format="dollars" amount={fund.facility.drawn} label="Drawn" bind={ofFacility('FACILITY_DRAWN', 'Drawn')} onSave={saveMoney(fund.facility.id, 'FACILITY_DRAWN')} /></dd>
                    <dt>Borrowing base</dt><dd><MoneyEdit format="dollars" amount={fund.facility.borrowingBase} label="Borrowing base" bind={ofFacility('FACILITY_BORROWING_BASE', 'Borrowing Base')} onSave={saveMoney(fund.facility.id, 'FACILITY_BORROWING_BASE')} /></dd>
                    <dt>Availability</dt><dd>{dollars(fund.facility.availability)}</dd>
                    <dt>Utilization</dt><dd>{pct(fund.facility.utilization, 0)}</dd>
                    <dt>Maturity</dt><dd><EditableValue kind="date" label="Maturity" bind={ofFacility('FACILITY_MATURITY', 'Maturity')} value={fund.facility.maturity} display={monthYear(fund.facility.maturity)} onSave={(value) => save(fund.facility!.id, 'FACILITY_MATURITY', value)} /></dd>
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
            ['Commitments', dollars(fund.commitments), `Closed ${monthYear(fund.commitmentsClosed)}`, '', ofFund('FUND_TOTAL_COMMITMENTS', 'Total Commitments')],
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
                        <Src bind={on(investor.investorId, 'INVESTOR', 'INVESTOR_TYPE', 'Investor Type', investor.name)} value={investor.typeLabel}>
                          <select aria-label={`${investor.name} type`} value={investor.typeCode} onChange={(event) => { void save(investor.investorId, 'INVESTOR_TYPE', event.target.value); }}>
                            {INVESTOR_TYPES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                          </select>
                        </Src>
                      </td>
                      <td className="num"><MoneyEdit amount={investor.commitment} label="Commitment" bind={on(investor.id, 'INVESTOR_COMMITMENT', 'COMMITMENT_AMOUNT', 'Commitment', investor.name)} onSave={saveMoney(investor.id, 'COMMITMENT_AMOUNT')} /></td>
                      <td className="num">{pct(investor.sharePct)}</td>
                      <td className="num">{paren(investor.called)}</td>
                      <td className="num">{paren(investor.unfunded)}</td>
                      <td className="num">{paren(investor.distributions)}</td>
                      <td className="num">{paren(investor.nav)}</td>
                      <td>
                        <Src bind={on(investor.id, 'INVESTOR_COMMITMENT', investor.status === 'PAST_DUE' ? 'COMMITMENT_PAST_DUE' : 'COMMITMENT_STATUS', investor.status === 'PAST_DUE' ? 'Past Due' : 'Status', investor.name)} value={investor.status === 'PAST_DUE' ? dollars(investor.pastDue) : 'Current'}>
                          {investor.status === 'PAST_DUE' ? <span className="da-st bind">Past due {dollars(investor.pastDue)}</span> : <Status status="CURRENT" />}
                        </Src>
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

      {tab === 'accounts' && (
        <>
          <Tiles items={[
            ['Commitments', dollars(fund.commitments), `${fund.investorCount} investors`, '', ofFund('FUND_TOTAL_COMMITMENTS', 'Total Commitments')],
            ['Called', dollars(fund.called), pct(fund.pacing.calledPct, 0)],
            ['Unfunded', dollars(fund.unfunded), 'Remaining commitment'],
            ['Distributions', dollars(fund.distributed), multiple(fund.dpi) + ' DPI'],
          ]} />
          <section className="fs-block">
            <div className="da-sechead">
              <h2>Capital accounts</h2>
              <p>Shown because this fund is closed-end. Each account is the investor’s share of commitments, calls, distributions, and NAV.</p>
            </div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>Account</th><th className="num">Commitment ($M)</th><th className="num">Called ($M)</th><th className="num">Unfunded ($M)</th><th className="num">Distributions ($M)</th><th className="num">NAV ($M)</th></tr></thead>
                <tbody>
                  {fund.investors.map((investor) => (
                    <tr key={investor.id}>
                      <td>{investor.name}</td>
                      <td className="num"><Src bind={on(investor.id, 'INVESTOR_COMMITMENT', 'COMMITMENT_AMOUNT', 'Commitment', investor.name)} value={paren(investor.commitment)}>{paren(investor.commitment)}</Src></td>
                      <td className="num">{paren(investor.called)}</td>
                      <td className="num">{paren(investor.unfunded)}</td>
                      <td className="num">{paren(investor.distributions)}</td>
                      <td className="num">{paren(investor.nav)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {tab === 'filings' && (
        <>
          <Tiles items={[
            ['NAV', dollars(fund.nav), `Reporting ${when(fund.reportingDate)}`, '', ofFund('NAV', 'NAV')],
            ['NAV per $100 committed', fund.commitments ? `$${((fund.nav / fund.commitments) * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—', 'Public BDC disclosure'],
            ['Period', fund.periodLabel || '—', fund.certified ? 'Certified' : 'Not certified', '', ofStatement('STATEMENT_PERIOD_LABEL', 'Period Label')],
            ['Statements', String(fund.statements.length), 'Ready for shareholder filing'],
          ]} />
          <section className="fs-block">
            <div className="da-sechead">
              <h2>Shareholder filings</h2>
              <p>Shown because this fund is a public BDC. These are the statements that go into the shareholder report.</p>
            </div>
            <div className="da-gridwrap">
              <table className="da-grid">
                <thead><tr><th>Filing</th><th>Period</th><th>Status</th></tr></thead>
                <tbody>
                  {fund.statements.map((statement) => (
                    <tr key={statement.kind}>
                      <td>{statement.title}</td>
                      <td>{statement.period}</td>
                      <td>{fund.certified ? 'Certified' : 'Open'}</td>
                    </tr>
                  ))}
                  {fund.statements.length === 0 && (
                    <tr><td>Shareholder report</td><td>{when(fund.reportingDate)}</td><td>{fund.certified ? 'Certified' : 'Open'}</td></tr>
                  )}
                </tbody>
              </table>
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
                <p>Share of investments at fair value. The marker is the compliance limit for that name.</p>
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
                    {bar.ruleId && bar.key !== '—' && (
                      <span className="fs-gap">
                        <EditableValue kind="number" label={`${bar.label} limit`} value={bar.limitPct == null ? '' : String(bar.limitPct)} display={pct(bar.limitPct, 0)} onSave={(value) => saveLimit(bar, value)} />
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
                      <td><Src bind={on(position.issuerId, 'ISSUER', 'SECTOR', 'Sector', position.issuer)} value={position.sector}>{position.sector}</Src></td>
                      <td className="num"><Src bind={on(position.id, 'POSITION', 'MARKET_VALUE', 'Fair Value', position.name)} value={paren(position.fairValue)}>{paren(position.fairValue)}</Src></td>
                      <td className="num"><EditableValue kind="number" label="Mark" bind={on(position.id, 'POSITION', 'POSITION_MARK', 'Administrator Mark', position.name)} value={position.mark == null ? '' : String(position.mark)} display={position.mark == null ? '—' : position.mark.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} onSave={(value) => save(position.id, 'POSITION_MARK', value)} /></td>
                      <td className="num"><EditableValue kind="text" label="Coupon" bind={on(position.id, 'POSITION', 'POSITION_COUPON', 'Coupon', position.name)} value={position.coupon} onSave={(value) => save(position.id, 'POSITION_COUPON', value)} /></td>
                      <td className="num"><EditableValue kind="number" label="Leverage" bind={on(position.id, 'POSITION', 'POSITION_LEVERAGE', 'Leverage', position.name)} value={position.leverage == null ? '' : String(position.leverage)} display={multiple(position.leverage, 1)} onSave={(value) => save(position.id, 'POSITION_LEVERAGE', value)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
    </InspectContext.Provider>
  );
}

function Statement({
  statement, bindLine, onResolve, onAmount,
}: {
  statement: Surface['statements'][number];
  bindLine: (code: string, name: string) => AttrBind | null;
  onResolve: (code: string, resolved: boolean) => Promise<void>;
  onAmount: (code: string, sourceCode: string, value: string) => Promise<void>;
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
              <th className="num">{statement.comparable ? 'Fund admin' : '$M'}</th>
              {statement.comparable && <><th className="num">Internal</th><th className="num">Variance</th><th className="num">Var %</th><th>Status</th></>}
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
                      <MoneyEdit amount={row.administrator} digits={2} label={`${row.label} fund admin`} bind={bindLine(row.id, row.label)} onSave={(value) => onAmount(row.id, 'FUND_ADMIN', value)} />
                    </td>
                  )}
                  {statement.comparable && !quiet && (
                    <>
                      <td className="num">
                        {row.shadow == null ? '—' : <MoneyEdit amount={row.shadow} digits={2} label={`${row.label} internal`} bind={bindLine(row.id, row.label)} onSave={(value) => onAmount(row.id, 'INTERNAL', value)} />}
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
