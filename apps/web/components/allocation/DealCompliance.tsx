'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { graphqlMutation } from '@/lib/graphql';

export interface ComplianceFundRef {
  fundId: string;
  fundName: string;
  parentFundId?: string | null;
  level: string;
}

interface FundRule {
  id: string;
  ruleCode: string;
  ruleName: string;
  ruleCategory: string;
  resultUnit?: string | null;
  limitDirection?: string | null;
  groupByAttributeCode?: string | null;
}

interface FundResult {
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

interface Board {
  rules: FundRule[];
  results: FundResult[];
}

type Bucket = 'all' | 'over' | 'near' | 'within' | 'na';
type SortKey = 'utilisation' | 'name' | 'status';

const CATEGORY: Record<string, string> = {
  CONCENTRATION: 'Concentration',
  EXPOSURE: 'Exposure',
  DIVERSIFICATION: 'Diversification',
  ELIGIBILITY: 'Eligibility',
  LEVERAGE: 'Credit and leverage',
  LIQUIDITY: 'Liquidity',
  OTHER: 'Other',
};

const STATUS_RANK: Record<string, number> = {
  HARD_BREACH: 0,
  SOFT_BREACH: 1,
  ERROR: 2,
  NO_DATA: 3,
  PASS: 4,
};

const GROUP_LABEL: Record<string, string> = {
  ISSUER_LEGAL_NAME: 'Issuer',
  SECTOR: 'Sector',
  SPONSOR_NAME: 'Sponsor',
};

function reading(result: FundResult, direction?: string | null): { bucket: Exclude<Bucket, 'all'>; tone: string; label: string } {
  if (result.status === 'NO_DATA' || result.status === 'ERROR' || result.computedValue == null) {
    return { bucket: 'na', tone: 'na', label: result.status === 'ERROR' ? 'Error' : 'Not applicable' };
  }
  const ratio = utilisation(result, direction);
  if (ratio == null) return { bucket: 'within', tone: 'ok', label: 'Within limit' };
  if (ratio > 1.005) return { bucket: 'over', tone: 'breach', label: 'Over limit' };
  if (ratio >= 0.995) return { bucket: 'over', tone: 'breach', label: 'At limit' };
  if (ratio >= 0.85) return { bucket: 'near', tone: 'near', label: 'Near limit' };
  return { bucket: 'within', tone: 'ok', label: 'Within limit' };
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

function formatRaw(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    const millionsValue = value / 1_000_000;
    return `$${millionsValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
  }
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
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

function explain(rule: FundRule, result: FundResult): string {
  const direction = result.limitDirection || rule.limitDirection;
  const groupName = result.groupByValue
    ? `${GROUP_LABEL[rule.groupByAttributeCode || ''] || 'Group'} ${result.groupByValue}. `
    : '';
  const rank = result.rankPosition != null ? `Rank ${result.rankPosition}. ` : '';
  const count = result.contributingCount != null
    ? `${result.contributingCount} position${result.contributingCount === 1 ? '' : 's'}. `
    : '';
  const value = formatMeasure(result.computedValue, rule.resultUnit);
  const hard = formatMeasure(result.hardLimitValue, rule.resultUnit);
  const bound = direction === 'MIN' ? 'floor of' : 'limit of';
  const parts = result.numeratorValue != null && result.denominatorValue != null
    ? ` Numerator ${formatRaw(result.numeratorValue)}, denominator ${formatRaw(result.denominatorValue)}.`
    : '';
  return `${groupName}${rank}${count}Pro-forma ${value} against a ${bound} ${hard}.${parts}`;
}

interface Tally {
  total: number;
  over: number;
  near: number;
  within: number;
  na: number;
}

function PortfolioNode({ fund, childrenOf, depth, selectedId, collapsed, countsFor, onToggle, onSelect }: {
  fund: ComplianceFundRef;
  childrenOf: Map<string, ComplianceFundRef[]>;
  depth: number;
  selectedId: string | null;
  collapsed: Set<string>;
  countsFor: (id: string) => Tally;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const children = childrenOf.get(fund.fundId) || [];
  const open = !collapsed.has(fund.fundId);
  const atLimit = countsFor(fund.fundId).over > 0;
  const label = depth > 0 ? fund.fundName.replace(/^[^:]+:\s*/, '') : fund.fundName;
  return (
    <div className="dc-branch" role="treeitem" aria-expanded={children.length ? open : undefined} aria-selected={selectedId === fund.fundId}>
      <div className={`dc-row${selectedId === fund.fundId ? ' on' : ''}`}>
        {children.length ? (
          <button type="button" className="dc-twist" aria-label={open ? `Collapse ${label}` : `Expand ${label}`} aria-expanded={open} onClick={() => onToggle(fund.fundId)}>{open ? '▾' : '▸'}</button>
        ) : (
          <span className="dc-twist" aria-hidden="true" />
        )}
        <button type="button" className="dc-node" aria-pressed={selectedId === fund.fundId} onClick={() => onSelect(fund.fundId)}>
          <b>{label}</b>
          {atLimit && <span className="dc-limit"><i className="dc-sq breach" /> At limit</span>}
        </button>
      </div>
      {children.length > 0 && open && (
        <div className="dc-kids" role="group" style={{ marginLeft: 14 + depth * 4 }}>
          {children.map((child) => (
            <PortfolioNode
              key={child.fundId}
              fund={child}
              childrenOf={childrenOf}
              depth={depth + 1}
              selectedId={selectedId}
              collapsed={collapsed}
              countsFor={countsFor}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function tally(results: FundResult[], directionFor: (result: FundResult) => string | null | undefined): Tally {
  const counts: Tally = { total: results.length, over: 0, near: 0, within: 0, na: 0 };
  for (const result of results) counts[reading(result, directionFor(result)).bucket] += 1;
  return counts;
}

const SCORE = `
  mutation ScoreDealCompliance($dealId: ID!, $asOfDate: Date, $holds: [AllocationHoldInput!], $adjustments: [AllocationAdjustmentInput!]) {
    scoreDealCompliance(dealId: $dealId, asOfDate: $asOfDate, holds: $holds, adjustments: $adjustments) {
      rules { id ruleCode ruleName ruleCategory resultUnit limitDirection groupByAttributeCode }
      results { id ruleId anchorEntityId groupByValue numeratorValue denominatorValue computedValue limitDirection softLimitValue hardLimitValue status rankPosition contributingCount }
      errors { message }
    }
  }
`;

export function DealCompliance({ dealId, asOfDate, holds, adjustments, funds }: {
  dealId: string;
  asOfDate?: string | null;
  holds: Record<string, number>;
  adjustments: Array<{ fundId: string; trancheId: string; type: string; amount?: number | null; reason?: string | null; note?: string | null }>;
  funds: ComplianceFundRef[];
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(funds.find((fund) => fund.level === 'PORTFOLIO')?.fundId || funds[0]?.fundId || null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('ALL');
  const [sort, setSort] = useState<SortKey>('utilisation');
  const [bucket, setBucket] = useState<Bucket>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const holdKey = JSON.stringify(holds);
  const adjustmentKey = JSON.stringify(adjustments);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const holdList = Object.entries(holds).map(([trancheId, holdPct]) => ({ trancheId, holdPct }));
    const adjustmentList = adjustments.map((item) => ({
      fundId: item.fundId,
      trancheId: item.trancheId,
      type: item.type,
      amount: item.amount,
      reasonCode: item.reason,
      note: item.note,
    }));
    graphqlMutation<{ scoreDealCompliance: Board & { errors: Array<{ message: string }> } }>(SCORE, {
      dealId,
      asOfDate: asOfDate || null,
      holds: holdList,
      adjustments: adjustmentList,
    }).then((result) => {
      if (cancelled) return;
      const scored = result.data?.scoreDealCompliance;
      const message = result.error?.message || scored?.errors?.[0]?.message;
      if (message || !scored) {
        setError(message || 'Could not score this allocation');
        return;
      }
      setBoard({ rules: scored.rules, results: scored.results });
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Could not score this allocation');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [dealId, asOfDate, holdKey, adjustmentKey]);

  const branches = useMemo(() => {
    const ids = new Set(funds.map((fund) => fund.fundId));
    const children = new Map<string, ComplianceFundRef[]>();
    const roots: ComplianceFundRef[] = [];
    for (const fund of funds) {
      if (fund.parentFundId && ids.has(fund.parentFundId)) {
        const list = children.get(fund.parentFundId) || [];
        list.push(fund);
        children.set(fund.parentFundId, list);
      } else {
        roots.push(fund);
      }
    }
    return { roots, children };
  }, [funds]);

  const fundIds = useMemo(() => new Set(funds.map((fund) => fund.fundId)), [funds]);
  const rules = useMemo(() => new Map((board?.rules || []).map((rule) => [rule.id, rule])), [board]);
  const byFund = useMemo(() => {
    const grouped = new Map<string, FundResult[]>();
    for (const result of board?.results || []) {
      if (!fundIds.has(result.anchorEntityId)) continue;
      const list = grouped.get(result.anchorEntityId) || [];
      list.push(result);
      grouped.set(result.anchorEntityId, list);
    }
    return grouped;
  }, [board, fundIds]);

  const dealResults = useMemo(() => funds.flatMap((fund) => byFund.get(fund.fundId) || []), [funds, byFund]);
  const directionFor = (result: FundResult) => result.limitDirection || rules.get(result.ruleId)?.limitDirection;
  const dealTally = tally(dealResults, directionFor);
  const selected = funds.find((fund) => fund.fundId === selectedId) || funds[0] || null;
  const selectedResults = selected ? byFund.get(selected.fundId) || [] : [];
  const selectedTally = tally(selectedResults, directionFor);

  const categories = useMemo(() => {
    const codes = new Set<string>();
    for (const result of selectedResults) {
      const rule = rules.get(result.ruleId);
      if (rule) codes.add(rule.ruleCategory);
    }
    return [...codes].sort();
  }, [selectedResults, rules]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = selectedResults.filter((result) => {
      const rule = rules.get(result.ruleId);
      if (!rule) return false;
      if (bucket !== 'all' && reading(result, rule.limitDirection).bucket !== bucket) return false;
      if (category !== 'ALL' && rule.ruleCategory !== category) return false;
      if (!needle) return true;
      const haystack = `${rule.ruleName} ${rule.ruleCode} ${result.groupByValue || ''} ${CATEGORY[rule.ruleCategory] || rule.ruleCategory}`.toLowerCase();
      return haystack.includes(needle);
    });
    visible.sort((left, right) => {
      const leftRule = rules.get(left.ruleId);
      const rightRule = rules.get(right.ruleId);
      if (sort === 'name') return (leftRule?.ruleName || '').localeCompare(rightRule?.ruleName || '');
      if (sort === 'status') return (STATUS_RANK[left.status] ?? 9) - (STATUS_RANK[right.status] ?? 9);
      const leftUse = utilisation(left, leftRule?.limitDirection);
      const rightUse = utilisation(right, rightRule?.limitDirection);
      return (rightUse ?? -1) - (leftUse ?? -1);
    });
    return visible;
  }, [selectedResults, rules, query, category, bucket, sort]);

  return (
    <section className="da-sec dc">
      <div className="dc-top">
        <h2>Pre-trade checks</h2>
        <span className="dc-signed">Not signed</span>
      </div>
      {error && <div className="xp-error">{error}</div>}
      <div className="dc-kpis">
        <div>
          <span>Checks run</span>
          <b>{loading ? '—' : dealTally.total}</b>
          <small>{funds.length} portfolio{funds.length === 1 ? '' : 's'}</small>
        </div>
        <div>
          <span>Within limit</span>
          <b>{loading ? '—' : dealTally.within}</b>
        </div>
        <div>
          <span>Near or at limit</span>
          <b className={dealTally.near ? 'near' : ''}>{loading ? '—' : dealTally.near}</b>
          <small>Watch list</small>
        </div>
        <div>
          <span>Breaches</span>
          <b className={dealTally.over ? 'breach' : ''}>{loading ? '—' : dealTally.over}</b>
          <small>{dealTally.over ? 'At or over the limit' : 'None'}</small>
        </div>
        <div>
          <span>Exceptions pending</span>
          <b>0</b>
          <small>No waiver register</small>
        </div>
      </div>

      <div className="dc-layout">
        <div>
          <div className="dc-kicker">Portfolio</div>
          <div className="dc-tree" role="tree" aria-label="Portfolios">
            {branches.roots.map((fund) => (
              <PortfolioNode
                key={fund.fundId}
                fund={fund}
                childrenOf={branches.children}
                depth={0}
                selectedId={selected?.fundId || null}
                collapsed={collapsed}
                countsFor={(id) => tally(byFund.get(id) || [], directionFor)}
                onToggle={(id) => setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })}
                onSelect={(id) => { setSelectedId(id); setBucket('all'); }}
              />
            ))}
          </div>
        </div>

        <div>
          {selected && (
            <>
              <h3 className="dc-title">{selected.fundName}</h3>
              <p className="da-note">
                {`${selectedTally.total} ${selectedTally.total === 1 ? 'check' : 'checks'}: ${selectedTally.within} within limit, ${selectedTally.near} near the limit, ${selectedTally.over} at or over the limit${selectedTally.na ? `, ${selectedTally.na} not applicable` : ''}`}
              </p>
            </>
          )}
          <div className="dc-tools">
            <input type="search" value={query} placeholder="Search rules" aria-label="Search rules" onChange={(event) => setQuery(event.target.value)} />
            <select aria-label="Category" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="ALL">All categories</option>
              {categories.map((code) => <option key={code} value={code}>{CATEGORY[code] || code}</option>)}
            </select>
            <select aria-label="Sort checks" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
              <option value="utilisation">Sort by utilisation</option>
              <option value="status">Sort by status</option>
              <option value="name">Sort by rule</option>
            </select>
          </div>
          <div className="dc-chips" role="tablist" aria-label="Filter by status">
            {([
              ['all', 'All', selectedTally.total],
              ['over', 'At limit', selectedTally.over],
              ['near', 'Near limit', selectedTally.near],
              ['within', 'Within limit', selectedTally.within],
              ['na', 'Not applicable', selectedTally.na],
            ] as const).map(([key, label, count]) => (
              <button key={key} type="button" className="btn btn-sm" aria-pressed={bucket === key} onClick={() => setBucket(key)}>{label} {count}</button>
            ))}
          </div>

          {loading && !board ? <div className="xp-empty">Scoring the book and this allocation…</div> : (
            <div className="dc-tablewrap">
              <table className="dc-table">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Category</th>
                    <th className="num">Limit</th>
                    <th className="num">Pro-forma</th>
                    <th>Utilisation</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((result) => {
                    const rule = rules.get(result.ruleId);
                    if (!rule) return null;
                    const ratio = utilisation(result, rule.limitDirection);
                    const place = reading(result, rule.limitDirection);
                    return (
                      <tr key={result.id}>
                        <td className="dc-rule">
                          <b><Link href={`/admin/compliance/${encodeURIComponent(rule.ruleCode)}`}>{rule.ruleName}</Link></b>
                          <small>{explain(rule, result)}</small>
                        </td>
                        <td>{CATEGORY[rule.ruleCategory] || rule.ruleCategory}</td>
                        <td className="num">{formatMeasure(result.hardLimitValue ?? result.softLimitValue, rule.resultUnit)}</td>
                        <td className="num">{formatMeasure(result.computedValue, rule.resultUnit)}</td>
                        <td>
                          <div className="dc-util">
                            <div className={`da-gauge ${place.tone}`}><i style={{ width: `${Math.min(100, Math.max(0, (ratio || 0) * 100))}%` }} /></div>
                            <span>{ratio == null ? '—' : `${Math.round(ratio * 100)}%`}</span>
                          </div>
                        </td>
                        <td><span className={`da-st ${place.tone}`}>{place.label}</span></td>
                      </tr>
                    );
                  })}
                  {!rows.length && (
                    <tr><td colSpan={6} className="dc-empty">{selectedResults.length ? 'No checks match this filter.' : 'This portfolio has no compliance results.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
