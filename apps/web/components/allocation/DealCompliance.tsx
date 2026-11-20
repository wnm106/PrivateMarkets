'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { graphqlMutation } from '@/lib/graphql';
import {
  CHANGE_LABEL,
  filterHypoLines,
  groupHypoLines,
  isBreach,
  pairHypoResults,
  tallyHypo,
  type HypoFilter,
  type HypoLine,
} from '@/lib/deal-hypo-view';
import { usePublishTab } from '@/lib/view-context';

export interface ComplianceFundRef {
  fundId: string;
  fundName: string;
  parentFundId?: string | null;
  level: string;
}

export interface FundRule {
  id: string;
  ruleCode: string;
  ruleName: string;
  ruleCategory: string;
  resultUnit?: string | null;
  limitDirection?: string | null;
  groupByAttributeCode?: string | null;
}

export interface FundResult {
  id: string;
  ruleId: string;
  anchorEntityId: string;
  groupByValue?: string | null;
  numeratorValue?: number | null;
  denominatorValue?: number | null;
  computedValue?: number | null;
  limitDirection?: string | null;
  softLimitValue?: number | null;
  hardLimitValue?: number | null;
  status: string;
  rankPosition?: number | null;
  contributingCount?: number | null;
}

const CATEGORY: Record<string, string> = {
  CONCENTRATION: 'Concentration',
  EXPOSURE: 'Exposure',
  DIVERSIFICATION: 'Diversification',
  ELIGIBILITY: 'Eligibility',
  LEVERAGE: 'Credit and leverage',
  LIQUIDITY: 'Liquidity',
  FORTY_ACT: '40 Act',
  COVERAGE: 'Coverage',
  COLLATERAL_QUALITY: 'Collateral quality',
  OTHER: 'Other',
};

const GROUP_LABEL: Record<string, string> = {
  ISSUER_LEGAL_NAME: 'Issuer',
  SECTOR: 'Sector',
  SPONSOR_NAME: 'Sponsor',
};

function reading(result: FundResult, direction?: string | null): { tone: string; label: string } {
  if (result.status === 'NO_DATA' || result.status === 'ERROR' || result.computedValue == null) {
    return { tone: 'na', label: result.status === 'ERROR' ? 'Error' : 'Not applicable' };
  }
  if (result.status === 'HARD_BREACH') return { tone: 'breach', label: 'Over limit' };
  if (result.status === 'SOFT_BREACH') return { tone: 'near', label: 'Over soft limit' };
  const ratio = utilisation(result, direction);
  if (ratio == null) return { tone: 'ok', label: 'Within limit' };
  if (ratio > 1.005) return { tone: 'breach', label: 'Over limit' };
  if (ratio >= 0.995) return { tone: 'breach', label: 'At limit' };
  if (ratio >= 0.85) return { tone: 'near', label: 'Near limit' };
  return { tone: 'ok', label: 'Within limit' };
}

function formatMeasure(value: number | null | undefined, unit?: string | null): string {
  if (value == null || Number.isNaN(value)) return '—';
  if (unit === 'PERCENTAGE') return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  if (unit === 'CURRENCY') {
    if (Math.abs(value) >= 1_000_000) {
      const millionsValue = value / 1_000_000;
      return `$${millionsValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
    }
    return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  }
  if (unit === 'COUNT') return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A signed change in the rule's unit: percentage points, dollars, or a plain number. */
function formatDelta(value: number | null | undefined, unit?: string | null): string {
  if (value == null || Number.isNaN(value)) return '—';
  if (Math.abs(value) < 1e-9) return '0';
  const sign = value > 0 ? '+' : '−';
  const size = Math.abs(value);
  if (unit === 'PERCENTAGE') return `${sign}${size.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pts`;
  if (unit === 'CURRENCY') {
    if (size >= 1_000_000) return `${sign}$${(size / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
    return `${sign}${size.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}`;
  }
  if (unit === 'COUNT') return `${sign}${size.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `${sign}${size.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function millions(value: number): string {
  return `$${(value / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
}

function utilisation(result: FundResult, direction?: string | null): number | null {
  const limit = result.hardLimitValue ?? result.softLimitValue;
  if (result.computedValue == null || limit == null || limit === 0) return null;
  const way = result.limitDirection || direction;
  if (way === 'MIN') {
    if (result.computedValue <= 0) return 1;
    return limit / result.computedValue;
  }
  return result.computedValue / limit;
}

const HYPO = `
  mutation RunDealHypo($dealId: ID!, $asOfDate: Date, $holds: [AllocationHoldInput!], $adjustments: [AllocationAdjustmentInput!]) {
    runDealHypo(dealId: $dealId, asOfDate: $asOfDate, holds: $holds, adjustments: $adjustments) {
      scenarioCode asOfDate ranAt
      rules { id ruleCode ruleName ruleCategory resultUnit limitDirection groupByAttributeCode }
      before { id ruleId anchorEntityId groupByValue numeratorValue denominatorValue computedValue limitDirection softLimitValue hardLimitValue status rankPosition contributingCount }
      after { id ruleId anchorEntityId groupByValue numeratorValue denominatorValue computedValue limitDirection softLimitValue hardLimitValue status rankPosition contributingCount }
      allocations { fundId fundName parentFundId level amount }
      errors { message }
    }
  }
`;

type HypoAdjustment = { fundId: string; trancheId: string; type: string; amount?: number | null; reason?: string | null; note?: string | null; saved?: boolean };

export interface DealHypoRun {
  scenarioCode: string | null;
  asOfDate: string | null;
  ranAt: string;
  rules: FundRule[];
  before: FundResult[];
  after: FundResult[];
  allocations: Array<{ fundId: string; fundName: string; parentFundId?: string | null; level: string; amount: number }>;
}

export interface DealHypo {
  run: DealHypoRun | null;
  running: boolean;
  error: string;
  /** The holds or adjustments changed after the last run started. */
  stale: boolean;
  start: () => void;
}

/**
 * A Hypo run on request. It tests the allocation as shown: the holds and
 * adjustments are sent as they are. Nothing runs when the deal opens, and the
 * deal's saved allocation is never written.
 */
export function useDealHypo({
  dealId,
  asOfDate,
  holds,
  adjustments,
}: {
  dealId: string;
  asOfDate?: string | null;
  holds: Record<string, number>;
  adjustments: HypoAdjustment[];
}): DealHypo {
  const [run, setRun] = useState<DealHypoRun | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [ranKey, setRanKey] = useState<string | null>(null);
  const request = useRef(0);
  const key = JSON.stringify([asOfDate || null, holds, adjustments]);

  const start = useCallback(() => {
    const id = ++request.current;
    setRunning(true);
    setError('');
    setRanKey(key);
    graphqlMutation<{ runDealHypo: DealHypoRun & { errors: Array<{ message: string }> } }>(HYPO, {
      dealId,
      asOfDate: asOfDate || null,
      holds: Object.entries(holds).map(([trancheId, holdPct]) => ({ trancheId, holdPct })),
      adjustments: adjustments.map((item) => ({
        fundId: item.fundId,
        trancheId: item.trancheId,
        type: item.type,
        amount: item.amount,
        reasonCode: item.reason,
        note: item.note,
        saved: item.saved,
      })),
    }).then((result) => {
      if (id !== request.current) return;
      const data = result.data?.runDealHypo;
      const message = result.error?.message || data?.errors?.[0]?.message;
      if (!data || (!data.after.length && message)) {
        setError(message || 'The Hypo run did not finish.');
        return;
      }
      setRun(data);
      if (message) setError(message);
    }).catch((err: unknown) => {
      if (id === request.current) setError(err instanceof Error ? err.message : 'The Hypo run did not finish.');
    }).finally(() => {
      if (id === request.current) setRunning(false);
    });
  }, [adjustments, asOfDate, dealId, holds, key]);

  return { run, running, error, stale: Boolean(run && ranKey !== null && ranKey !== key), start };
}

const FILTERS: Array<{ key: HypoFilter; label: string }> = [
  { key: 'changed', label: 'Rules that changed' },
  { key: 'breaches', label: 'Breaches' },
  { key: 'all', label: 'All rules' },
];

const CHANGE_TONE: Record<string, string> = {
  new_breach: 'breach',
  worse: 'near',
  added: 'na',
  moved: 'na',
  dropped: 'na',
  better: 'ok',
  cleared: 'ok',
  same: 'na',
};

function shortName(fund: ComplianceFundRef, depth: number): string {
  return depth > 0 ? fund.fundName.replace(/^[^:]+:\s*/, '') : fund.fundName;
}

function whenRan(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function StatusCell({ result, rule }: { result: FundResult | null; rule: FundRule }) {
  if (!result) return <td className="num dh-none" colSpan={1}>Not tested</td>;
  const view = reading(result, result.limitDirection || rule.limitDirection);
  return (
    <td className="num">
      <span className="dh-val">{formatMeasure(result.computedValue, rule.resultUnit)}</span>
      <span className={`da-st ${view.tone}`}>{view.label}</span>
    </td>
  );
}

export function DealCompliance({ funds, hypo }: {
  funds: ComplianceFundRef[];
  hypo: DealHypo;
}) {
  const [filter, setFilter] = useState<HypoFilter>('changed');
  const run = hypo.run;
  const rules = useMemo(() => new Map((run?.rules || []).map((rule) => [rule.id, rule])), [run]);
  const fundIds = useMemo(() => new Set(funds.map((fund) => fund.fundId)), [funds]);
  const lines = useMemo(() => (run
    ? pairHypoResults(
      run.before.filter((result) => fundIds.has(result.anchorEntityId) && rules.has(result.ruleId)),
      run.after.filter((result) => fundIds.has(result.anchorEntityId) && rules.has(result.ruleId)),
      (ruleId) => rules.get(ruleId)?.limitDirection,
    )
    : []), [run, rules, fundIds]);
  const tally = useMemo(() => tallyHypo(lines), [lines]);
  const groups = useMemo(() => groupHypoLines(filterHypoLines(lines, filter), funds), [lines, filter, funds]);
  const allocated = useMemo(() => new Map((run?.allocations || []).map((row) => [row.fundId, row.amount])), [run]);

  const describe = (line: HypoLine) => {
    const rule = rules.get(line.ruleId)!;
    const side = line.after || line.before;
    return {
      rule: rule.ruleName,
      group: line.groupByValue,
      limit: side?.hardLimitValue ?? side?.softLimitValue ?? null,
      unit: rule.resultUnit || null,
      before: line.before?.computedValue ?? null,
      beforeStatus: line.before?.status ?? null,
      after: line.after?.computedValue ?? null,
      afterStatus: line.after?.status ?? null,
      delta: line.delta,
      change: CHANGE_LABEL[line.change],
    };
  };

  // The assistant sees the changed rules for every fund, the story the tab opens on.
  const changedGroups = useMemo(() => groupHypoLines(filterHypoLines(lines, 'changed'), funds), [lines, funds]);
  let budget = 120;
  usePublishTab('compliance', {
    label: 'Compliance',
    purpose: 'What a Hypo run of this allocation does to each fund\'s compliance rules: the result before the deal, after it, and the change.',
    howToRead: 'A Hypo run is started by the user and tests the allocation as shown, without saving it. before is the book without this deal; after is the book with the Hypo allocation. delta is after minus before in the rule\'s unit: percentage points for PERCENTAGE rules, dollars for CURRENCY. A status of HARD_BREACH is over the limit, SOFT_BREACH over the soft limit. changedRules lists only rules whose value or status moved, grouped by fund; a sleeve is a sub-portfolio of the portfolio above it, and its results are its own, not part of the portfolio row. stale means the allocation was edited after the run, so the figures are for an earlier allocation.',
    data: run ? {
      ranAt: run.ranAt,
      asOfDate: run.asOfDate,
      stale: hypo.stale,
      tally,
      changedRules: changedGroups.flatMap((group) => {
        if (budget <= 0) return [];
        const rows = group.lines.slice(0, budget).map(describe);
        budget -= rows.length;
        return [{
          fund: group.fund.fundName,
          level: group.fund.level,
          allocated: allocated.get(group.fund.fundId) ?? null,
          rules: rows,
        }];
      }),
    } : null,
  });

  return (
    <section className="da-sec dc">
      <div className="dc-top">
        <div>
          <h2>Hypo compliance test</h2>
          <p className="da-note">
            Tests the allocation as shown against every rule on these funds, before and after the deal. Nothing is saved.
          </p>
        </div>
        <div className="dh-run">
          {run && (
            <span className={`dh-ran${hypo.stale ? ' stale' : ''}`}>
              {hypo.stale ? 'Allocation changed since the run at ' : 'Ran at '}{whenRan(run.ranAt)}
            </span>
          )}
          <button type="button" className="btn btn-primary" disabled={hypo.running} onClick={hypo.start}>
            {hypo.running ? 'Running Hypo…' : run ? 'Run Hypo again' : 'Run Hypo'}
          </button>
        </div>
      </div>
      {hypo.error && <div className="xp-error">{hypo.error}</div>}

      {!run ? (
        <div className="xp-empty">
          {hypo.running
            ? 'Scoring the book without this deal, then with the Hypo allocation…'
            : 'Run Hypo to see each fund\'s rules before and after this allocation.'}
        </div>
      ) : (
        <>
          <div className="dc-kpis">
            <div><span>Checks</span><b>{tally.checks}</b><small>{funds.length} portfolio{funds.length === 1 ? '' : 's'}</small></div>
            <div><span>Changed</span><b>{tally.changed}</b><small>Value or status moved</small></div>
            <div><span>New breaches</span><b className={tally.newBreaches ? 'breach' : ''}>{tally.newBreaches}</b><small>Within before, over after</small></div>
            <div><span>Breaches after</span><b className={tally.breachesAfter ? 'breach' : ''}>{tally.breachesAfter}</b><small>Including ones already over</small></div>
            <div><span>Cleared</span><b>{tally.cleared}</b><small>Over before, within after</small></div>
          </div>

          <div className="dh-filter" role="radiogroup" aria-label="Rules to show">
            {FILTERS.map((option) => (
              <label key={option.key} className={filter === option.key ? 'on' : ''}>
                <input
                  type="radio"
                  name="dh-filter"
                  value={option.key}
                  checked={filter === option.key}
                  onChange={() => setFilter(option.key)}
                />
                {option.label}
                <span className="dh-count">
                  {option.key === 'changed' ? tally.changed : option.key === 'breaches' ? filterHypoLines(lines, 'breaches').length : tally.checks}
                </span>
              </label>
            ))}
          </div>

          <div className="dc-tablewrap">
            <table className="dc-table dh-table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th className="num">Limit</th>
                  <th className="num">Before</th>
                  <th className="num">After</th>
                  <th className="num">Change</th>
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={group.fund.fundId}>
                  <tr className={`dh-fund depth-${Math.min(group.depth, 2)}`}>
                    <th colSpan={5} scope="rowgroup">
                      <span>{shortName(group.fund, group.depth)}</span>
                      {allocated.has(group.fund.fundId) && (
                        <small>{millions(allocated.get(group.fund.fundId) || 0)} in the Hypo allocation</small>
                      )}
                    </th>
                  </tr>
                  {group.lines.map((line) => {
                    const rule = rules.get(line.ruleId);
                    if (!rule) return null;
                    const side = line.after || line.before;
                    const groupLabel = line.groupByValue ? `${GROUP_LABEL[rule.groupByAttributeCode || ''] || 'Group'} ${line.groupByValue}` : '';
                    return (
                      <tr key={line.key} className={isBreach(line.after?.status) ? 'dh-over' : ''}>
                        <td className="dc-rule">
                          <b><Link href={`/admin/compliance/${encodeURIComponent(rule.ruleCode)}`}>{rule.ruleName}</Link></b>
                          <small>{[groupLabel, CATEGORY[rule.ruleCategory] || rule.ruleCategory].filter(Boolean).join(' · ')}</small>
                        </td>
                        <td className="num">{formatMeasure(side?.hardLimitValue ?? side?.softLimitValue, rule.resultUnit)}</td>
                        <StatusCell result={line.before} rule={rule} />
                        <StatusCell result={line.after} rule={rule} />
                        <td className="num">
                          <span className="dh-val">{formatDelta(line.delta, rule.resultUnit)}</span>
                          <span className={`da-st ${CHANGE_TONE[line.change]}`}>{CHANGE_LABEL[line.change]}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
              {!groups.length && (
                <tbody>
                  <tr>
                    <td colSpan={5} className="dc-empty">
                      {filter === 'changed' ? 'This allocation does not move any rule.' : filter === 'breaches' ? 'No rule is over its limit, before or after.' : 'No compliance results.'}
                    </td>
                  </tr>
                </tbody>
              )}
            </table>
          </div>
        </>
      )}
    </section>
  );
}
