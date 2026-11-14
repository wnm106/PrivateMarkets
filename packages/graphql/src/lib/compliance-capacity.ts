/**
 * Pro-forma capacity for one security.
 *
 * Capacity is the largest additional par of that security such that every rule
 * the purchase worsens still meets its limit. Rules the security does not move,
 * and rules it improves, stay out of the minimum. Null capacity means no rule
 * puts a ceiling on the buy. Zero means a rule already blocks it.
 *
 * The algebra is closed form. A ratio (n + a x) / (d + b x) and a par-weighted
 * average both solve in one step from a baseline and two probes. Rank bands,
 * exception baskets, and excess haircuts are piecewise, so the caller checks
 * the closed form against a full proforma and searches down when a larger size
 * would breach a piece the unit probes did not enter.
 *
 * The same formulas are what `investmentCapacity` runs after
 * `compliance.proforma_snapshot`. Keep the two in step: the snapshot returns
 * the numerators, and this module turns them into par.
 */

export type CapacityImpact = 'worsens' | 'improves' | 'neutral' | 'blocks' | 'unbounded' | 'no_data';
export type CapacityShape = 'ratio' | 'sum' | 'wavg' | 'none';
export type LimitKind = 'HARD' | 'SOFT';

const EPS = 1e-8;

export interface CapacityObservation {
  direction: 'MAX' | 'MIN';
  /** Limit in the rule's displayed unit (percent points, rating factor, par). */
  limit: number | null;
  resultUnit?: string | null;
  shape?: 'auto' | CapacityShape;
  /** The security's own metric for a par-weighted average. Null when the rule is not one. */
  securityMetric?: number | null;
  probePar: number;
  baseNum: number | null;
  baseDen: number | null;
  baseValue: number | null;
  baseStatus: string | null;
  probeNum: number | null;
  probeDen: number | null;
  probeValue: number | null;
  probeStatus: string | null;
  /** Per unit of par added to the numerator. */
  numeratorSlope?: number | null;
  /** Per unit of par added to the denominator. */
  denominatorSlope?: number | null;
  limitKind?: LimitKind;
}

export interface CapacityLineResult {
  impact: CapacityImpact;
  capacityPar: number | null;
  nativeHeadroom: number | null;
  shape: CapacityShape;
}

export interface SnapshotRow {
  ruleCode: string;
  ruleName: string;
  groupByValue: string | null;
  limitDirection: 'MAX' | 'MIN' | null;
  numeratorValue: number | null;
  denominatorValue: number | null;
  computedValue: number | null;
  softLimitValue: number | null;
  hardLimitValue: number | null;
  status: string | null;
  resultUnit: string | null;
  errorMessage?: string | null;
}

export interface CapacityLine {
  ruleCode: string;
  ruleName: string;
  groupByValue: string | null;
  limitDirection: 'MAX' | 'MIN' | null;
  impact: CapacityImpact;
  baselineValue: number | null;
  limitValue: number | null;
  nativeHeadroom: number | null;
  capacityPar: number | null;
  binding: boolean;
}

export interface CapacityQuote {
  /** Additional par of the security. Null means no constraining rule. */
  capacityPar: number | null;
  bindingRuleCode: string | null;
  bindingGroup: string | null;
  lines: CapacityLine[];
}

export interface ProformaLegInput {
  securityId?: string | null;
  securityCode?: string | null;
  par: number;
  attributes?: Record<string, unknown> | null;
}

export interface NormalizedProformaLeg {
  security_id: string | null;
  security_code: string | null;
  par: number;
  attributes: Record<string, string> | null;
}

export function rowKey(ruleCode: string, groupByValue: string | null | undefined): string {
  return `${ruleCode}::${groupByValue ?? ''}`;
}

export function failsLimit(status: string | null | undefined, kind: LimitKind): boolean {
  if (kind === 'SOFT') return status === 'SOFT_BREACH' || status === 'HARD_BREACH';
  return status === 'HARD_BREACH';
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

export function nativeHeadroom(value: number | null, limit: number | null, direction: 'MAX' | 'MIN'): number | null {
  if (!finite(value) || !finite(limit)) return null;
  return direction === 'MIN' ? value - limit : limit - value;
}

function line(impact: CapacityImpact, capacityPar: number | null, headroom: number | null, shape: CapacityShape): CapacityLineResult {
  return { impact, capacityPar, nativeHeadroom: headroom, shape };
}

function alreadyThrough(obs: CapacityObservation, limit: number): boolean {
  const kind = obs.limitKind ?? 'HARD';
  if (failsLimit(obs.baseStatus, kind)) return true;
  if (!finite(obs.baseValue)) return false;
  return obs.direction === 'MIN' ? obs.baseValue < limit - EPS : obs.baseValue > limit + EPS;
}

function scaledLimit(limit: number, resultUnit: string | null | undefined, hasDenominator: boolean): number {
  if (hasDenominator && resultUnit === 'PERCENTAGE') return limit / 100;
  return limit;
}

function solveRatio(obs: CapacityObservation, a: number, b: number, headroom: number | null, limit: number): CapacityLineResult {
  const n = obs.baseNum ?? 0;
  const d = obs.baseDen;
  if (!finite(d) || Math.abs(d) <= EPS) {
    if (Math.abs(b) > EPS) {
      const own = a / b;
      const L = scaledLimit(limit, obs.resultUnit, true);
      const worse = obs.direction === 'MIN' ? own < L - EPS : own > L + EPS;
      return worse
        ? line('worsens', 0, headroom, 'ratio')
        : line('unbounded', null, headroom, 'ratio');
    }
    return line('no_data', null, headroom, 'ratio');
  }

  const L = scaledLimit(limit, obs.resultUnit, true);
  const marginal = a * d - b * n;
  const worsens = obs.direction === 'MIN' ? marginal < -EPS : marginal > EPS;
  const improves = obs.direction === 'MIN' ? marginal > EPS : marginal < -EPS;
  if (improves) return line('improves', null, headroom, 'ratio');
  if (!worsens) return line('neutral', null, headroom, 'ratio');
  if (alreadyThrough(obs, limit)) return line('worsens', 0, headroom, 'ratio');

  const slope = a - L * b;
  const bounds = obs.direction === 'MIN' ? slope < -EPS : slope > EPS;
  if (!bounds) return line('unbounded', null, headroom, 'ratio');
  const capacity = (L * d - n) / slope;
  if (!Number.isFinite(capacity) || capacity <= EPS) return line('worsens', 0, headroom, 'ratio');
  return line('worsens', capacity, headroom, 'ratio');
}

function solveSum(obs: CapacityObservation, a: number, headroom: number | null, limit: number): CapacityLineResult {
  const level = finite(obs.baseValue) ? obs.baseValue : (obs.baseNum ?? 0);
  const worsens = obs.direction === 'MIN' ? a < -EPS : a > EPS;
  const improves = obs.direction === 'MIN' ? a > EPS : a < -EPS;
  if (improves) return line('improves', null, headroom, 'sum');
  if (!worsens) return line('neutral', null, headroom, 'sum');
  if (alreadyThrough(obs, limit)) return line('worsens', 0, headroom, 'sum');
  const capacity = (limit - level) / a;
  if (!Number.isFinite(capacity) || capacity <= EPS) return line('worsens', 0, headroom, 'sum');
  return line('worsens', capacity, headroom, 'sum');
}

function solveWavg(obs: CapacityObservation, headroom: number | null, limit: number): CapacityLineResult {
  const metric = obs.securityMetric;
  if (!finite(metric)) return line('no_data', null, headroom, 'wavg');
  const current = obs.baseValue;
  const probed = obs.probeValue;
  // A security the weighted set filters out does not move the average.
  if (finite(current) && finite(probed) && close(probed, current)) {
    return line('neutral', null, headroom, 'wavg');
  }
  if (!finite(current)) {
    const worse = obs.direction === 'MIN' ? metric < limit - EPS : metric > limit + EPS;
    return worse ? line('worsens', 0, headroom, 'wavg') : line('unbounded', null, headroom, 'wavg');
  }

  const worsens = obs.direction === 'MIN' ? metric < current - EPS : metric > current + EPS;
  const improves = obs.direction === 'MIN' ? metric > current + EPS : metric < current - EPS;
  if (improves) return line('improves', null, headroom, 'wavg');
  if (!worsens) return line('neutral', null, headroom, 'wavg');
  if (alreadyThrough(obs, limit)) return line('worsens', 0, headroom, 'wavg');

  const inside = obs.direction === 'MIN' ? metric >= limit - EPS : metric <= limit + EPS;
  if (inside) return line('unbounded', null, headroom, 'wavg');

  if (!finite(probed)) return line('no_data', null, headroom, 'wavg');
  const weight = obs.probePar * (metric - probed) / (probed - current);
  if (!Number.isFinite(weight) || weight <= EPS) return line('no_data', null, headroom, 'wavg');
  const capacity = weight * (limit - current) / (metric - limit);
  if (!Number.isFinite(capacity) || capacity <= EPS) return line('worsens', 0, headroom, 'wavg');
  return line('worsens', capacity, headroom, 'wavg');
}

/**
 * Room, in par, for one rule given the book's level and how one par of the
 * security moves the numerator and the denominator.
 */
export function solveCapacityLine(obs: CapacityObservation): CapacityLineResult {
  const limit = obs.limit;
  const headroom = nativeHeadroom(obs.baseValue, limit, obs.direction);
  if (!finite(limit)) return line('no_data', null, headroom, 'none');
  if (!finite(obs.probePar) || obs.probePar === 0) return line('no_data', null, headroom, 'none');

  const baseNum = obs.baseNum ?? 0;
  const probeNum = obs.probeNum ?? baseNum;
  const a = finite(obs.numeratorSlope) ? obs.numeratorSlope : (probeNum - baseNum) / obs.probePar;
  const baseDen = obs.baseDen;
  const probeDen = obs.probeDen;
  const b = finite(obs.denominatorSlope)
    ? obs.denominatorSlope
    : (baseDen == null && probeDen == null ? 0 : ((probeDen ?? 0) - (baseDen ?? 0)) / obs.probePar);

  const valueMoved = finite(obs.baseValue) && finite(obs.probeValue)
    ? Math.abs(obs.probeValue - obs.baseValue) > EPS * Math.max(1, Math.abs(obs.baseValue))
    : obs.baseValue !== obs.probeValue;
  const entered = Math.abs(a) > EPS || Math.abs(b) > EPS || valueMoved;

  if (!entered) {
    const kind = obs.limitKind ?? 'HARD';
    if (failsLimit(obs.probeStatus, kind) && !failsLimit(obs.baseStatus, kind)) {
      return line('blocks', 0, headroom, 'none');
    }
    return line('neutral', null, headroom, 'none');
  }

  const shape = obs.shape && obs.shape !== 'auto'
    ? obs.shape
    : (obs.baseDen == null && obs.probeDen == null
      ? (finite(obs.securityMetric) ? 'wavg' : 'sum')
      : 'ratio');

  if (shape === 'wavg') return solveWavg(obs, headroom, limit);
  if (shape === 'sum') return solveSum(obs, a, headroom, limit);
  if (shape === 'none') return line('neutral', null, headroom, 'none');
  return solveRatio(obs, a, b, headroom, limit);
}

interface ProbeLevels {
  num: number | null;
  den: number | null;
  value: number | null;
  status: string | null;
}

/**
 * Recover the pre-trade numerator, denominator, and per-par slopes from the
 * booked row plus the same group at `probePar` and `2 * probePar`. A group the
 * security creates has no booked row; the two probes still separate a fixed
 * denominator from one that grows with the trade.
 */
export function observationFromProbes(input: {
  direction: 'MAX' | 'MIN';
  limit: number | null;
  resultUnit?: string | null;
  shape?: 'auto' | CapacityShape;
  securityMetric?: number | null;
  probePar: number;
  limitKind?: LimitKind;
  base: ProbeLevels | null;
  probe: ProbeLevels | null;
  probeAgain: ProbeLevels | null;
}): CapacityObservation {
  const step = input.probePar;
  const n1 = input.probe?.num ?? null;
  const n2 = input.probeAgain?.num ?? null;
  const d1 = input.probe?.den ?? null;
  const d2 = input.probeAgain?.den ?? null;

  let numeratorSlope: number | null = null;
  if (finite(n1) && finite(n2)) numeratorSlope = (n2 - n1) / step;
  else if (finite(n1) && finite(input.base?.num)) numeratorSlope = (n1 - (input.base?.num as number)) / step;

  let denominatorSlope: number | null = null;
  if (finite(d1) && finite(d2)) denominatorSlope = (d2 - d1) / step;
  else if (finite(d1) && finite(input.base?.den)) denominatorSlope = (d1 - (input.base?.den as number)) / step;

  let baseNum = input.base?.num ?? null;
  let baseDen = input.base?.den ?? null;
  if (baseNum == null && finite(n1) && finite(numeratorSlope)) baseNum = n1 - numeratorSlope * step;
  if (baseDen == null && finite(d1) && finite(denominatorSlope)) baseDen = d1 - denominatorSlope * step;

  return {
    direction: input.direction,
    limit: input.limit,
    resultUnit: input.resultUnit,
    shape: input.shape,
    securityMetric: input.securityMetric,
    probePar: step,
    limitKind: input.limitKind,
    baseNum,
    baseDen,
    baseValue: input.base?.value ?? null,
    baseStatus: input.base?.status ?? null,
    probeNum: n1,
    probeDen: d1,
    probeValue: input.probe?.value ?? null,
    probeStatus: input.probe?.status ?? null,
    numeratorSlope,
    denominatorSlope,
  };
}

function limitOf(row: SnapshotRow, kind: LimitKind): number | null {
  if (kind === 'SOFT') return row.softLimitValue ?? row.hardLimitValue;
  return row.hardLimitValue;
}

function levels(row: SnapshotRow | undefined): ProbeLevels | null {
  if (!row) return null;
  return {
    num: row.numeratorValue,
    den: row.denominatorValue,
    value: row.computedValue,
    status: row.status,
  };
}

function indexRows(rows: SnapshotRow[]): Map<string, SnapshotRow> {
  const out = new Map<string, SnapshotRow>();
  for (const row of rows) {
    if (row.status === 'ERROR') continue;
    out.set(rowKey(row.ruleCode, row.groupByValue), row);
  }
  return out;
}

const IMPACT_ORDER: Record<CapacityImpact, number> = {
  blocks: 0,
  worsens: 1,
  unbounded: 2,
  improves: 3,
  no_data: 4,
  neutral: 5,
};

export function buildCapacityQuote(args: {
  baseline: SnapshotRow[];
  probe: SnapshotRow[];
  probeAgain: SnapshotRow[];
  probePar: number;
  limitKind?: LimitKind;
  /** Rules whose result is a par-weighted average, and the security's metric. */
  weightedMetrics?: Map<string, number | null>;
}): CapacityQuote {
  const kind = args.limitKind ?? 'HARD';
  const base = indexRows(args.baseline);
  const probe = indexRows(args.probe);
  const again = indexRows(args.probeAgain);
  const keys = new Set<string>([...base.keys(), ...probe.keys(), ...again.keys()]);
  const lines: CapacityLine[] = [];

  for (const key of keys) {
    const sample = probe.get(key) ?? again.get(key) ?? base.get(key);
    if (!sample) continue;
    const booked = base.get(key);
    const direction = sample.limitDirection ?? booked?.limitDirection ?? 'MAX';
    const limit = limitOf(sample, kind) ?? (booked ? limitOf(booked, kind) : null);
    const metric = args.weightedMetrics?.get(sample.ruleCode);
    const isWeighted = args.weightedMetrics?.has(sample.ruleCode) ?? false;
    const solved = solveCapacityLine(observationFromProbes({
      direction,
      limit,
      resultUnit: sample.resultUnit ?? booked?.resultUnit,
      shape: isWeighted ? 'wavg' : 'auto',
      securityMetric: metric ?? null,
      probePar: args.probePar,
      limitKind: kind,
      base: levels(booked),
      probe: levels(probe.get(key)),
      probeAgain: levels(again.get(key)),
    }));
    if (solved.impact === 'neutral') continue;
    if (solved.impact === 'no_data' && !isWeighted) continue;
    lines.push({
      ruleCode: sample.ruleCode,
      ruleName: sample.ruleName,
      groupByValue: sample.groupByValue,
      limitDirection: direction,
      impact: solved.impact,
      baselineValue: booked?.computedValue ?? null,
      limitValue: limit,
      nativeHeadroom: solved.nativeHeadroom,
      capacityPar: solved.capacityPar,
      binding: false,
    });
  }

  return markBinding(lines);
}

export function markBinding(lines: CapacityLine[]): CapacityQuote {
  const finiteLines = lines.filter((line) => finite(line.capacityPar));
  if (finiteLines.length === 0) {
    return {
      capacityPar: null,
      bindingRuleCode: null,
      bindingGroup: null,
      lines: sortLines(lines.map((line) => ({ ...line, binding: false }))),
    };
  }
  const capacityPar = Math.min(...finiteLines.map((line) => line.capacityPar as number));
  let bindingRuleCode: string | null = null;
  let bindingGroup: string | null = null;
  const marked = lines.map((line) => {
    const binding = finite(line.capacityPar) && Math.abs((line.capacityPar as number) - capacityPar) <= 0.005;
    if (binding && bindingRuleCode == null) {
      bindingRuleCode = line.ruleCode;
      bindingGroup = line.groupByValue;
    }
    return { ...line, binding };
  });
  return { capacityPar, bindingRuleCode, bindingGroup, lines: sortLines(marked) };
}

function sortLines(lines: CapacityLine[]): CapacityLine[] {
  return [...lines].sort((left, right) => {
    if (left.binding !== right.binding) return left.binding ? -1 : 1;
    const impact = IMPACT_ORDER[left.impact] - IMPACT_ORDER[right.impact];
    if (impact !== 0) return impact;
    const leftCap = left.capacityPar ?? Number.POSITIVE_INFINITY;
    const rightCap = right.capacityPar ?? Number.POSITIVE_INFINITY;
    if (leftCap !== rightCap) return leftCap - rightCap;
    return left.ruleCode.localeCompare(right.ruleCode);
  });
}

/**
 * After a full proforma shows the closed form is too high, pin the rules that
 * actually breach there down to the largest size that still passes.
 */
export function applyVerifiedCapacity(
  quote: CapacityQuote,
  verified: number,
  breachingKeys: string[],
  scenario: SnapshotRow[] = [],
): CapacityQuote {
  const breach = new Set(breachingKeys);
  const lines = quote.lines.map((line) => {
    if (!breach.has(rowKey(line.ruleCode, line.groupByValue))) return line;
    const next = line.capacityPar == null || line.capacityPar > verified ? verified : line.capacityPar;
    const impact = line.impact === 'no_data' || line.impact === 'neutral' || line.impact === 'improves' ? 'worsens' as const : line.impact;
    return { ...line, impact, capacityPar: next };
  });
  const present = new Set(lines.map((line) => rowKey(line.ruleCode, line.groupByValue)));
  for (const key of breachingKeys) {
    if (present.has(key)) continue;
    const row = scenario.find((item) => rowKey(item.ruleCode, item.groupByValue) === key);
    if (!row) continue;
    lines.push({
      ruleCode: row.ruleCode,
      ruleName: row.ruleName,
      groupByValue: row.groupByValue,
      limitDirection: row.limitDirection,
      impact: 'worsens',
      baselineValue: null,
      limitValue: row.hardLimitValue,
      nativeHeadroom: null,
      capacityPar: verified,
      binding: false,
    });
  }
  return markBinding(lines);
}

/** Largest par in `[0, closedForm]` for which `feasible` is true. `closedForm` itself is returned when it already passes. */
export async function searchFeasiblePar(
  closedForm: number,
  feasible: (par: number) => Promise<boolean>,
  iterations = 20,
): Promise<number> {
  if (closedForm <= 0) return 0;
  if (await feasible(closedForm)) return closedForm;
  let lo = 0;
  let hi = closedForm;
  for (let i = 0; i < iterations; i += 1) {
    const mid = (lo + hi) / 2;
    if (await feasible(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Rule groups that fail at `scenario` and did not fail on the baseline. */
export function newBreachKeys(baseline: SnapshotRow[], scenario: SnapshotRow[], kind: LimitKind = 'HARD'): string[] {
  const booked = indexRows(baseline);
  const keys: string[] = [];
  for (const row of scenario) {
    if (row.status === 'ERROR') continue;
    if (!failsLimit(row.status, kind)) continue;
    const prior = booked.get(rowKey(row.ruleCode, row.groupByValue));
    if (prior && failsLimit(prior.status, kind)) continue;
    keys.push(rowKey(row.ruleCode, row.groupByValue));
  }
  return keys;
}

export function normalizeProformaLegs(legs: ProformaLegInput[] | null | undefined): NormalizedProformaLeg[] {
  if (!legs || legs.length === 0) {
    throw new Error('A proforma needs at least one buy or sell');
  }
  return legs.map((leg, index) => {
    const label = `Leg ${index + 1}`;
    if (leg.par == null || !Number.isFinite(Number(leg.par)) || Number(leg.par) === 0) {
      throw new Error(`${label} needs a non-zero par. Positive par is a buy and negative par is a sell.`);
    }
    const securityId = leg.securityId?.trim() || null;
    const securityCode = leg.securityCode?.trim() || null;
    if (!securityId && !securityCode) {
      throw new Error(`${label} needs a security`);
    }
    const attributes: Record<string, string> = {};
    for (const [code, value] of Object.entries(leg.attributes ?? {})) {
      if (value == null) continue;
      attributes[code] = typeof value === 'string' ? value : String(value);
    }
    return {
      security_id: securityId,
      security_code: securityCode,
      par: Number(leg.par),
      attributes: Object.keys(attributes).length ? attributes : null,
    };
  });
}

export function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
