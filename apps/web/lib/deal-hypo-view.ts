/**
 * Pairs a Hypo run's before and after compliance results, one line per fund,
 * rule and group, so the Compliance tab and what it publishes read the same
 * figures.
 */

export interface HypoResult {
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

export interface HypoFund {
  fundId: string;
  fundName: string;
  parentFundId?: string | null;
  level: string;
}

/** What happened to one check between before and after. */
export type HypoChange = 'new_breach' | 'worse' | 'better' | 'cleared' | 'moved' | 'added' | 'dropped' | 'same';

export interface HypoLine {
  key: string;
  fundId: string;
  ruleId: string;
  groupByValue: string | null;
  before: HypoResult | null;
  after: HypoResult | null;
  /** after minus before, in the rule's own unit. Null when either side has no value. */
  delta: number | null;
  change: HypoChange;
  changed: boolean;
}

const BREACH = new Set(['HARD_BREACH', 'SOFT_BREACH']);
/** Below this the two figures are the same number, read twice. */
const EPSILON = 1e-6;

export function isBreach(status: string | null | undefined): boolean {
  return BREACH.has(status || '');
}

function lineKey(result: HypoResult): string {
  return `${result.anchorEntityId}|${result.ruleId}|${result.groupByValue ?? ''}`;
}

/** Severity order: a hard breach is worse than a soft one, which is worse than a pass. */
function severity(status: string | null | undefined): number {
  if (status === 'HARD_BREACH') return 2;
  if (status === 'SOFT_BREACH') return 1;
  return 0;
}

/**
 * The direction a move counts as worse: up for a MAX limit, down for a MIN floor.
 * With no direction, any move is only "moved".
 */
function worseWhenUp(direction: string | null | undefined): boolean | null {
  if (direction === 'MIN') return false;
  if (direction === 'MAX') return true;
  return null;
}

export function classify(before: HypoResult | null, after: HypoResult | null, direction?: string | null): {
  delta: number | null;
  change: HypoChange;
} {
  if (!before && !after) return { delta: null, change: 'same' };
  if (!before) return { delta: null, change: isBreach(after!.status) ? 'new_breach' : 'added' };
  if (!after) return { delta: null, change: 'dropped' };
  const delta = before.computedValue != null && after.computedValue != null
    ? after.computedValue - before.computedValue
    : null;
  const beforeLevel = severity(before.status);
  const afterLevel = severity(after.status);
  if (afterLevel > beforeLevel) return { delta, change: beforeLevel === 0 ? 'new_breach' : 'worse' };
  if (afterLevel < beforeLevel) return { delta, change: afterLevel === 0 ? 'cleared' : 'better' };
  if (before.status !== after.status) return { delta, change: 'moved' };
  if (delta == null) {
    return { delta, change: (before.computedValue == null) === (after.computedValue == null) ? 'same' : 'moved' };
  }
  if (Math.abs(delta) <= EPSILON * Math.max(1, Math.abs(before.computedValue ?? 0))) return { delta: 0, change: 'same' };
  const up = worseWhenUp(after.limitDirection || before.limitDirection || direction);
  if (up == null) return { delta, change: 'moved' };
  return { delta, change: (delta > 0) === up ? 'worse' : 'better' };
}

/** One line per fund, rule and group, in the order the funds are given. */
export function pairHypoResults(
  before: HypoResult[],
  after: HypoResult[],
  directionOf: (ruleId: string) => string | null | undefined = () => null,
): HypoLine[] {
  const lines = new Map<string, { before: HypoResult | null; after: HypoResult | null }>();
  for (const result of before) {
    const key = lineKey(result);
    lines.set(key, { before: result, after: lines.get(key)?.after ?? null });
  }
  for (const result of after) {
    const key = lineKey(result);
    lines.set(key, { before: lines.get(key)?.before ?? null, after: result });
  }
  return [...lines.entries()].map(([key, pair]) => {
    const sample = (pair.after || pair.before)!;
    const { delta, change } = classify(pair.before, pair.after, directionOf(sample.ruleId));
    return {
      key,
      fundId: sample.anchorEntityId,
      ruleId: sample.ruleId,
      groupByValue: sample.groupByValue ?? null,
      before: pair.before,
      after: pair.after,
      delta,
      change,
      changed: change !== 'same',
    };
  });
}

export type HypoFilter = 'changed' | 'all' | 'breaches';

export function filterHypoLines(lines: HypoLine[], filter: HypoFilter): HypoLine[] {
  if (filter === 'changed') return lines.filter((line) => line.changed);
  if (filter === 'breaches') return lines.filter((line) => isBreach(line.after?.status) || isBreach(line.before?.status));
  return lines;
}

export interface HypoTally {
  checks: number;
  changed: number;
  newBreaches: number;
  breachesAfter: number;
  cleared: number;
}

export function tallyHypo(lines: HypoLine[]): HypoTally {
  return {
    checks: lines.length,
    changed: lines.filter((line) => line.changed).length,
    newBreaches: lines.filter((line) => line.change === 'new_breach').length,
    breachesAfter: lines.filter((line) => isBreach(line.after?.status)).length,
    cleared: lines.filter((line) => line.change === 'cleared').length,
  };
}

const CHANGE_RANK: Record<HypoChange, number> = {
  new_breach: 0,
  worse: 1,
  added: 2,
  moved: 3,
  dropped: 4,
  better: 5,
  cleared: 6,
  same: 7,
};

export interface HypoFundGroup {
  fund: HypoFund;
  depth: number;
  lines: HypoLine[];
}

/**
 * Lines grouped under their fund: each portfolio, then its sleeves. Inside a
 * fund the worst change comes first. A fund with no lines left after the
 * filter is dropped.
 */
export function groupHypoLines(lines: HypoLine[], funds: HypoFund[]): HypoFundGroup[] {
  const byFund = new Map<string, HypoLine[]>();
  for (const line of lines) {
    const list = byFund.get(line.fundId) || [];
    list.push(line);
    byFund.set(line.fundId, list);
  }
  const ids = new Set(funds.map((fund) => fund.fundId));
  const children = new Map<string, HypoFund[]>();
  const roots: HypoFund[] = [];
  for (const fund of funds) {
    if (fund.parentFundId && ids.has(fund.parentFundId) && fund.parentFundId !== fund.fundId) {
      const list = children.get(fund.parentFundId) || [];
      list.push(fund);
      children.set(fund.parentFundId, list);
    } else {
      roots.push(fund);
    }
  }
  const groups: HypoFundGroup[] = [];
  const walk = (fund: HypoFund, depth: number) => {
    const own = (byFund.get(fund.fundId) || []).slice().sort((left, right) => (
      CHANGE_RANK[left.change] - CHANGE_RANK[right.change]
      || Math.abs(right.delta ?? 0) - Math.abs(left.delta ?? 0)
    ));
    if (own.length) groups.push({ fund, depth, lines: own });
    for (const child of children.get(fund.fundId) || []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return groups;
}

export const CHANGE_LABEL: Record<HypoChange, string> = {
  new_breach: 'New breach',
  worse: 'Worse',
  better: 'Better',
  cleared: 'Cleared',
  moved: 'Moved',
  added: 'New check',
  dropped: 'No longer tested',
  same: 'No change',
};
