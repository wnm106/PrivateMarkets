/**
 * The CLO book: what the CLO surface (surfaces/clo) and the assistant read about each CLO.
 *
 * Every test result (OC, IC, WARF, WAS, WAL, WARR, concentrations, eligibility) comes from
 * the compliance engine (`compliance.proforma_snapshot` and `compliance.evaluate_proforma`),
 * read by clo-book-store.ts. The Moody's diversity score is one of those tests (the DIVERSITY
 * term kind, compliance.clo_diversity_rows). This module only arranges those results and works
 * out the two figures the engine does not hold:
 *
 *   - the payment-date waterfall, from note interest due, fees and the engine's coverage tests
 *   - how much each offered loan would improve a CLO, from the engine's pro forma of buying it
 *
 * Which test is which is read from the rule's own data (its limit line, its weighted-average
 * line, its line conditions), never from a rule code.
 */

export type Direction = 'MAX' | 'MIN';

/** One line of the engine's snapshot. */
export interface EngineLine {
  ruleCode: string;
  ruleName: string;
  groupByValue: string | null;
  limitDirection: Direction | null;
  numeratorValue: number | null;
  denominatorValue: number | null;
  computedValue: number | null;
  softLimitValue: number | null;
  hardLimitValue: number | null;
  status: string | null;
  resultUnit: string | null;
  errorMessage?: string | null;
}

/** One measure line of a rule version, with the conditions on it. */
export interface RuleLine {
  side: 'NUMERATOR' | 'DENOMINATOR' | 'LIMIT' | string;
  kind: string;
  attributeCode: string | null;
  weightAttributeCode: string | null;
  label: string | null;
  conditions: Array<{ attributeCode: string; operator: string; value: string | null }>;
}

/** What the engine's rule data says a rule measures. */
export interface RuleShape {
  ruleCode: string;
  ruleName: string;
  category: string;
  lines: RuleLine[];
  /** The attribute a limit term in the version's metadata reads, when there is one. */
  limitTermAttribute: string | null;
}

/** A headline measure the surface tracks. Keyed by what the rule reads, not by its code. */
export type Metric = 'WARF' | 'WAS' | 'WAL' | 'WARR' | 'CCC' | 'OC' | 'IC' | 'DIVERSITY';

/** The weighted-average attribute that identifies each quality metric. */
const WEIGHTED_METRIC: Record<string, Metric> = {
  CLO_MOODYS_RATING_FACTOR: 'WARF',
  SPREAD_BPS: 'WAS',
  MATURITY_DATE: 'WAL',
  CLO_MOODYS_RECOVERY_RATE: 'WARR',
};

/** The note trigger attribute that identifies each coverage test. */
const TRIGGER_METRIC: Record<string, Metric> = {
  CLO_NOTE_OC_TRIGGER: 'OC',
  CLO_NOTE_IC_TRIGGER: 'IC',
};

export interface TestTag {
  metric: Metric | null;
  /** The seniority rank a coverage test covers (every class ranked this or better). */
  rank: number | null;
  /** The attribute the limit is read from, and the record kind holding it. */
  limitAttribute: string | null;
  limitHolder: 'TRANSACTION' | 'NOTE' | null;
}

function equalsCondition(line: RuleLine | undefined, attribute: string): string | null {
  const hit = line?.conditions.find((c) => c.attributeCode === attribute && (c.operator === 'equals' || c.operator === 'eq' || c.operator === '='));
  return hit ? hit.value : null;
}

/** What a rule measures, from its lines. */
export function tagRule(shape: RuleShape | undefined): TestTag {
  const empty: TestTag = { metric: null, rank: null, limitAttribute: null, limitHolder: null };
  if (!shape) return empty;
  const limit = shape.lines.find((line) => line.side === 'LIMIT');
  const limitAttribute = limit?.attributeCode ?? shape.limitTermAttribute ?? null;
  const limitHolder: TestTag['limitHolder'] = !limitAttribute ? null : limitAttribute.startsWith('CLO_NOTE_') ? 'NOTE' : 'TRANSACTION';
  const trigger = limit?.attributeCode ? TRIGGER_METRIC[limit.attributeCode] : undefined;
  if (trigger) {
    const rank = Number(equalsCondition(limit, 'CLO_NOTE_SENIORITY_RANK'));
    return { metric: trigger, rank: Number.isFinite(rank) && rank > 0 ? rank : null, limitAttribute, limitHolder };
  }
  if (shape.lines.some((line) => line.side === 'NUMERATOR' && line.kind === 'DIVERSITY')) return { metric: 'DIVERSITY', rank: null, limitAttribute, limitHolder };
  const weighted = shape.lines.find((line) => line.side === 'NUMERATOR' && line.kind === 'WAVG' && line.attributeCode && WEIGHTED_METRIC[line.attributeCode]);
  if (weighted?.attributeCode) return { metric: WEIGHTED_METRIC[weighted.attributeCode], rank: null, limitAttribute, limitHolder };
  const ccc = shape.lines.some((line) => line.side === 'NUMERATOR' && equalsCondition(line, 'CLO_IS_CCC') === 'true');
  if (ccc && shape.category === 'CONCENTRATION') return { metric: 'CCC', rank: null, limitAttribute, limitHolder };
  return { ...empty, limitAttribute, limitHolder };
}

export interface Test {
  ruleCode: string;
  ruleName: string;
  category: string;
  metric: Metric | null;
  rank: number | null;
  group: string | null;
  direction: Direction;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  limit: number | null;
  softLimit: number | null;
  status: string;
  unit: string | null;
  /** Value less limit for a minimum, limit less value for a maximum. Negative is a breach. */
  cushion: number | null;
  /** Cushion as a share of the limit, percent. */
  cushionPct: number | null;
  limitAttribute: string | null;
  limitHolder: 'TRANSACTION' | 'NOTE' | null;
  error: string | null;
}

export function cushionOf(direction: Direction, value: number | null, limit: number | null): number | null {
  if (value == null || limit == null) return null;
  return direction === 'MIN' ? value - limit : limit - value;
}

/** The engine's lines as tests, tagged and with their cushion. */
export function toTests(lines: EngineLine[], shapes: Map<string, RuleShape>): Test[] {
  return lines.map((line) => {
    const shape = shapes.get(line.ruleCode);
    const tag = tagRule(shape);
    const direction: Direction = line.limitDirection === 'MIN' ? 'MIN' : 'MAX';
    const cushion = cushionOf(direction, line.computedValue, line.hardLimitValue);
    return {
      ruleCode: line.ruleCode,
      ruleName: line.ruleName,
      category: shape?.category ?? 'OTHER',
      metric: tag.metric,
      rank: tag.rank,
      group: line.groupByValue,
      direction,
      value: line.computedValue,
      numerator: line.numeratorValue,
      denominator: line.denominatorValue,
      limit: line.hardLimitValue,
      softLimit: line.softLimitValue,
      status: line.status || 'NO_DATA',
      unit: line.resultUnit,
      cushion,
      cushionPct: cushion != null && line.hardLimitValue ? (cushion / Math.abs(line.hardLimitValue)) * 100 : null,
      limitAttribute: tag.limitAttribute,
      limitHolder: tag.limitHolder,
      error: line.errorMessage ?? null,
    };
  });
}

export const isBreach = (status: string | null | undefined) => status === 'HARD_BREACH';
export const isWarning = (status: string | null | undefined) => status === 'SOFT_BREACH';

// ---------------------------------------------------------------------------
// Diversity
// ---------------------------------------------------------------------------

/** One industry behind the engine's diversity score (compliance.clo_diversity_breakdown). A null industry is par whose obligor has none. */
export interface DiversityIndustry { industry: string | null; obligors: number; par: number; units: number; score: number }

export interface DiversityResult {
  score: number | null;
  obligors: number;
  averagePar: number | null;
  industries: Array<{ industry: string; obligors: number; par: number; units: number; score: number }>;
  /** Performing par left out because its obligor has no Moody's industry. */
  unclassifiedPar: number;
}

/** The engine's industry rows, summarised for the screen. The score itself is the engine's test value. */
export function summariseDiversity(rows: DiversityIndustry[], score: number | null): DiversityResult {
  const obligors = rows.reduce((n, r) => n + r.obligors, 0);
  const par = rows.reduce((n, r) => n + r.par, 0);
  const industries = rows.filter((r): r is DiversityIndustry & { industry: string } => Boolean(r.industry)).sort((a, b) => b.par - a.par);
  return {
    score, obligors, averagePar: obligors ? par / obligors : null, industries,
    unclassifiedPar: rows.filter((r) => !r.industry).reduce((n, r) => n + r.par, 0),
  };
}

// ---------------------------------------------------------------------------
// Deal phase
// ---------------------------------------------------------------------------

export type Phase = 'Warehouse' | 'Ramp-up' | 'Reinvestment' | 'Amortization' | 'Matured';

export function dealPhase(asOf: string, dates: { closing?: string | null; effective?: string | null; reinvestmentEnd?: string | null; maturity?: string | null }): Phase | null {
  const { closing, effective, reinvestmentEnd, maturity } = dates;
  if (closing && asOf < closing) return 'Warehouse';
  if (effective && asOf < effective) return 'Ramp-up';
  if (maturity && asOf >= maturity) return 'Matured';
  if (reinvestmentEnd && asOf <= reinvestmentEnd) return 'Reinvestment';
  if (reinvestmentEnd) return 'Amortization';
  return null;
}

/** Years from one date to another, by calendar days. */
export function yearsBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / (365.25 * 86_400_000);
}

export function periodsPerYear(frequency: string | null | undefined): number {
  const text = (frequency || '').toLowerCase();
  if (text.startsWith('semi')) return 2;
  if (text.startsWith('month')) return 12;
  if (text.startsWith('annual')) return 1;
  return 4;
}

// ---------------------------------------------------------------------------
// Waterfall
// ---------------------------------------------------------------------------

export interface WaterfallNote {
  id: string;
  name: string;
  cls: string;
  rank: number;
  par: number;
  interestDue: number;
  deferrable: boolean;
  /** The equity tranche: no interest due, takes what is left. */
  residual: boolean;
}

export interface WaterfallInput {
  interestProceeds: number;
  principalProceeds: number;
  seniorExpenses: number;
  collateralPar: number;
  seniorFeeBps: number | null;
  subFeeBps: number | null;
  periodsPerYear: number;
  reinvesting: boolean;
  notes: WaterfallNote[];
  /** The engine's coverage tests, each tagged with the rank it covers. */
  coverage: Array<{ metric: 'OC' | 'IC'; rank: number; ruleName: string; value: number | null; limit: number | null; numerator: number | null; denominator: number | null; status: string }>;
}

export type StepKind = 'EXPENSE' | 'FEE' | 'INTEREST' | 'CURE' | 'RESIDUAL' | 'REINVEST' | 'PAYDOWN';

export interface WaterfallStep {
  order: number;
  waterfall: 'INTEREST' | 'PRINCIPAL';
  kind: StepKind;
  label: string;
  noteId: string | null;
  due: number;
  paid: number;
  /** Unpaid on a class whose interest defers (capitalised), or on a non-deferrable class (a shortfall). */
  deferred: number;
  shortfall: number;
  availableBefore: number;
  availableAfter: number;
  /** How the step's amount is worked out, in words. */
  basis: string;
}

export interface WaterfallResult {
  steps: WaterfallStep[];
  interestProceeds: number;
  principalProceeds: number;
  paidToNotes: number;
  diverted: number;
  deferred: number;
  shortfall: number;
  residualToEquity: number;
  /** Residual to equity a year, over subordinated note par, percent. */
  equityCashYieldPct: number | null;
  /** Par each class pays down this period, from cures and the principal waterfall. */
  paydowns: Array<{ noteId: string; cls: string; amount: number }>;
}

/** Par to pay down on the covered classes so a failing coverage test is met again. */
export function cureAmount(test: WaterfallInput['coverage'][number]): number {
  const { numerator: n, denominator: d, limit } = test;
  if (n == null || d == null || limit == null || !(d > 0) || !(limit > 0)) return 0;
  const trigger = limit / 100;
  if (n / d >= trigger) return 0;
  if (test.metric === 'OC') return Math.max(0, d - n / trigger);
  // IC: paying down par cuts interest due in proportion. Due after x of par is due * (1 - x / par),
  // and the covered par is not on the test, so the cure is read as the share of due to remove.
  // The amount returned is that share of interest due; the caller converts it to par.
  return Math.max(0, d - n / trigger);
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * The payment-date waterfall, simplified to the shape every CLO 2.0 indenture shares:
 *
 *   Interest: senior expenses; senior management fee; interest on each rated class in rank order,
 *   and after each rank its coverage tests (a failing test diverts interest to pay down the most
 *   senior notes until it is met); subordinated management fee; the rest to the subordinated notes.
 *   Principal: an unmet cure first; then reinvestment during the reinvestment period, otherwise
 *   sequential paydown from Class A.
 *
 * Not modelled: the reinvestment OC test, the incentive fee and its hurdle, caps on senior
 * expenses, interest smoothing and supplemental reserves.
 */
export function runWaterfall(input: WaterfallInput): WaterfallResult {
  const steps: WaterfallStep[] = [];
  const notes = [...input.notes].sort((a, b) => a.rank - b.rank);
  const rated = notes.filter((n) => !n.residual);
  const parLeft = new Map(notes.map((n) => [n.id, n.par]));
  const paydowns = new Map<string, number>();
  let available = Math.max(0, input.interestProceeds);
  let order = 0;
  let paidToNotes = 0;
  let diverted = 0;
  let deferred = 0;
  let shortfall = 0;
  let unmetCure = 0;

  const push = (step: Omit<WaterfallStep, 'order' | 'availableBefore' | 'availableAfter'>, before: number) => {
    order += 1;
    steps.push({ ...step, order, availableBefore: before, availableAfter: before - step.paid });
  };

  /** Pay par down on the classes ranked `upTo` or better, most senior first. */
  const payDown = (amount: number, upTo: number): number => {
    let left = amount;
    for (const note of rated) {
      if (note.rank > upTo || left <= 0) continue;
      const owed = parLeft.get(note.id) || 0;
      const pay = Math.min(owed, left);
      if (pay <= 0) continue;
      parLeft.set(note.id, owed - pay);
      paydowns.set(note.id, (paydowns.get(note.id) || 0) + pay);
      left -= pay;
    }
    return amount - left;
  };

  const ppy = input.periodsPerYear > 0 ? input.periodsPerYear : 4;
  const expenses = Math.max(0, input.seniorExpenses || 0);
  {
    const before = available;
    const paid = Math.min(available, expenses);
    available -= paid;
    push({ waterfall: 'INTEREST', kind: 'EXPENSE', label: 'Taxes, trustee and administrative expenses', noteId: null, due: expenses, paid, deferred: 0, shortfall: expenses - paid,
      basis: `Senior expenses for the period (${money(expenses)}).` }, before);
  }
  if (input.seniorFeeBps != null) {
    const due = (input.collateralPar * input.seniorFeeBps) / 10_000 / ppy;
    const before = available;
    const paid = Math.min(available, due);
    available -= paid;
    push({ waterfall: 'INTEREST', kind: 'FEE', label: 'Senior management fee', noteId: null, due, paid, deferred: 0, shortfall: due - paid,
      basis: `${input.seniorFeeBps} bps a year on collateral par of ${money(input.collateralPar)}, for one of ${ppy} periods.` }, before);
  }

  const ranks = [...new Set(rated.map((n) => n.rank))].sort((a, b) => a - b);
  for (const rank of ranks) {
    for (const note of rated.filter((n) => n.rank === rank)) {
      const before = available;
      const due = Math.max(0, note.interestDue);
      const paid = Math.min(available, due);
      available -= paid;
      paidToNotes += paid;
      const unpaid = due - paid;
      if (note.deferrable) deferred += unpaid; else shortfall += unpaid;
      push({ waterfall: 'INTEREST', kind: 'INTEREST', label: `Class ${note.cls} interest`, noteId: note.id, due, paid,
        deferred: note.deferrable ? unpaid : 0, shortfall: note.deferrable ? 0 : unpaid,
        basis: `Interest due on Class ${note.cls}${unpaid > 0 ? (note.deferrable ? '; the unpaid part defers and is added to the class' : '; the unpaid part is a shortfall on a class that may not defer') : ''}.` }, before);
    }
    const tests = input.coverage.filter((t) => t.rank === rank);
    if (!tests.length) continue;
    const failing = tests.filter((t) => isBreach(t.status));
    const coveredPar = rated.filter((n) => n.rank <= rank).reduce((sum, n) => sum + n.par, 0);
    const coveredDue = rated.filter((n) => n.rank <= rank).reduce((sum, n) => sum + n.interestDue, 0);
    const need = failing.reduce((max, t) => {
      if (t.metric === 'OC') return Math.max(max, cureAmount(t));
      // IC: interest due falls with par in proportion, so the par to remove is the same share of covered par.
      const dueToRemove = cureAmount(t);
      return Math.max(max, coveredDue > 0 ? (dueToRemove / coveredDue) * coveredPar : 0);
    }, 0);
    // A test covers every class ranked its rank or better; name the classes since the last tested rank.
    const previous = [...new Set(input.coverage.map((t) => t.rank))].filter((r) => r < rank).sort((a, b) => b - a)[0] ?? 0;
    const label = `Class ${rated.filter((n) => n.rank > previous && n.rank <= rank).map((n) => n.cls).join('/')} coverage tests`;
    const before = available;
    const paid = Math.min(available, need);
    available -= paid;
    diverted += paid;
    payDown(paid, rank);
    unmetCure += need - paid;
    push({ waterfall: 'INTEREST', kind: 'CURE', label, noteId: null, due: need, paid, deferred: 0, shortfall: need - paid,
      basis: failing.length
        ? `${failing.map((t) => `${t.ruleName} ${t.value?.toFixed(2)}% against ${t.limit}%`).join('; ')}. Interest pays down the most senior notes until the test is met: for OC, covered par less the adjusted collateral over the trigger; for IC, the share of covered par whose interest must go.`
        : `${tests.map((t) => `${t.ruleName} ${t.value != null ? `${t.value.toFixed(2)}%` : 'no data'}`).join('; ')}. Passing, so nothing is diverted.` }, before);
  }

  if (input.subFeeBps != null) {
    const due = (input.collateralPar * input.subFeeBps) / 10_000 / ppy;
    const before = available;
    const paid = Math.min(available, due);
    available -= paid;
    push({ waterfall: 'INTEREST', kind: 'FEE', label: 'Subordinated management fee', noteId: null, due, paid, deferred: 0, shortfall: due - paid,
      basis: `${input.subFeeBps} bps a year on collateral par of ${money(input.collateralPar)}, for one of ${ppy} periods.` }, before);
  }
  const equity = notes.find((n) => n.residual);
  const residualToEquity = available;
  {
    const before = available;
    push({ waterfall: 'INTEREST', kind: 'RESIDUAL', label: equity ? `${equity.name}` : 'Residual to equity', noteId: equity?.id ?? null, due: 0, paid: available, deferred: 0, shortfall: 0,
      basis: 'Whatever interest is left after every step above.' }, before);
    available = 0;
  }

  // Principal waterfall.
  let principal = Math.max(0, input.principalProceeds);
  if (unmetCure > 0) {
    const before = principal;
    const lowest = ranks[ranks.length - 1] ?? 1;
    const paid = payDown(Math.min(principal, unmetCure), lowest);
    principal -= paid;
    push({ waterfall: 'PRINCIPAL', kind: 'CURE', label: 'Coverage cure not met from interest', noteId: null, due: unmetCure, paid, deferred: 0, shortfall: unmetCure - paid,
      basis: 'Principal proceeds pay down the most senior notes by the cure interest could not cover.' }, before);
    diverted += paid;
  }
  {
    const before = principal;
    if (input.reinvesting) {
      push({ waterfall: 'PRINCIPAL', kind: 'REINVEST', label: 'Reinvest in collateral', noteId: null, due: principal, paid: principal, deferred: 0, shortfall: 0,
        basis: 'Inside the reinvestment period, principal proceeds buy new collateral.' }, before);
    } else {
      const paid = payDown(principal, Number.POSITIVE_INFINITY);
      push({ waterfall: 'PRINCIPAL', kind: 'PAYDOWN', label: 'Sequential paydown from Class A', noteId: null, due: principal, paid, deferred: 0, shortfall: 0,
        basis: 'After the reinvestment period, principal proceeds repay the notes in order of seniority.' }, before);
    }
  }

  const sub = equity?.par ?? 0;
  return {
    steps,
    interestProceeds: input.interestProceeds,
    principalProceeds: input.principalProceeds,
    paidToNotes,
    diverted,
    deferred,
    shortfall,
    residualToEquity,
    equityCashYieldPct: sub > 0 ? ((residualToEquity * ppy) / sub) * 100 : null,
    paydowns: rated.filter((n) => paydowns.get(n.id)).map((n) => ({ noteId: n.id, cls: n.cls, amount: paydowns.get(n.id)! })),
  };
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export interface ProformaLineLite {
  ruleCode: string;
  ruleName: string;
  groupByValue: string | null;
  limitDirection: Direction | null;
  baselineValue: number | null;
  scenarioValue: number | null;
  baselineStatus: string | null;
  scenarioStatus: string | null;
  hardLimitValue: number | null;
  verdict: string;
  approved: boolean;
}

export interface MetricChange {
  metric: Metric;
  label: string;
  rank: number | null;
  direction: Direction;
  before: number | null;
  after: number | null;
  limit: number | null;
  /** After less before, signed so that positive is better. */
  gain: number | null;
  /** Gain as a share of the cushion before the buy (or of the limit when the cushion is gone), percent. */
  gainPctOfCushion: number | null;
}

export interface OpportunityScore {
  approved: boolean;
  cures: number;
  newBreaches: number;
  worsensFailing: number;
  improvesFailing: number;
  changes: MetricChange[];
  /** Sum of gainPctOfCushion over the tracked measures, each held to +/-100. */
  compositionScore: number;
}

export function metricLabel(metric: Metric, rank: number | null, noteLabel?: (rank: number) => string): string {
  if (metric === 'OC' || metric === 'IC') return `${rank != null && noteLabel ? noteLabel(rank) : `Rank ${rank ?? '?'}`} ${metric}`;
  if (metric === 'DIVERSITY') return 'Diversity';
  if (metric === 'CCC') return 'CCC bucket';
  return metric;
}

/** What one pro forma buy does to the CLO, scored on the measures the surface tracks. */
export function scoreOpportunity(
  lines: ProformaLineLite[],
  shapes: Map<string, RuleShape>,
  noteLabel?: (rank: number) => string,
): OpportunityScore {
  let cures = 0;
  let newBreaches = 0;
  let worsensFailing = 0;
  let improvesFailing = 0;
  const changes: MetricChange[] = [];
  for (const line of lines) {
    if (line.verdict === 'CURED') cures += 1;
    if (line.verdict === 'NEW_BREACH') newBreaches += 1;
    if (line.verdict === 'DETERIORATES') worsensFailing += 1;
    if (line.verdict === 'IMPROVES') improvesFailing += 1;
    const tag = tagRule(shapes.get(line.ruleCode));
    if (!tag.metric || line.groupByValue) continue;
    const direction: Direction = line.limitDirection === 'MIN' ? 'MIN' : 'MAX';
    changes.push(change(tag.metric, tag.rank, direction, line.baselineValue, line.scenarioValue, line.hardLimitValue, noteLabel));
  }
  const compositionScore = changes.reduce((sum, c) => sum + Math.max(-100, Math.min(100, c.gainPctOfCushion ?? 0)), 0);
  return { approved: lines.every((l) => l.approved), cures, newBreaches, worsensFailing, improvesFailing, changes, compositionScore };
}

function change(metric: Metric, rank: number | null, direction: Direction, before: number | null, after: number | null, limit: number | null, noteLabel?: (rank: number) => string): MetricChange {
  const gain = before == null || after == null ? null : direction === 'MIN' ? after - before : before - after;
  const cushion = cushionOf(direction, before, limit);
  const base = cushion != null && cushion > 0 ? cushion : limit != null ? Math.abs(limit) : null;
  return {
    metric, rank, direction, before, after, limit, gain,
    label: metricLabel(metric, rank, noteLabel),
    gainPctOfCushion: gain != null && base ? (gain / base) * 100 : null,
  };
}

/** Rank offered loans: buys the engine approves first, then the most tests cured, then the composition score. */
export function rankOpportunities<T extends { score: OpportunityScore | null }>(rows: T[]): T[] {
  const key = (row: T) => row.score;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (!x || !y) return x ? -1 : y ? 1 : 0;
    if (x.approved !== y.approved) return x.approved ? -1 : 1;
    if (x.cures !== y.cures) return y.cures - x.cures;
    return y.compositionScore - x.compositionScore;
  });
}

/** Expected interest on a buy for one period: par times benchmark plus spread, or a fixed coupon. */
export function expectedInterest(par: number, benchmarkPct: number | null, spreadBps: number | null, fixedRate: boolean, ppy: number, fixedCouponPct = 7.25): number {
  if (fixedRate) return (par * fixedCouponPct) / 100 / ppy;
  return (par * ((benchmarkPct ?? 0) + (spreadBps ?? 0) / 100)) / 100 / ppy;
}

/** Quarter ends on or before a date, latest last, plus the date itself when it is not one. */
export function quarterEnds(asOf: string, count: number): string[] {
  const [y, m] = asOf.split('-').map(Number);
  const out: string[] = [];
  let year = y;
  let quarter = Math.floor((m - 1) / 3); // 0..3, the quarter asOf is in
  const end = (yy: number, q: number) => {
    const month = q * 3 + 3;
    const last = new Date(Date.UTC(yy, month, 0)).getUTCDate();
    return `${yy}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  };
  let candidate = end(year, quarter);
  if (candidate > asOf) { quarter -= 1; if (quarter < 0) { quarter = 3; year -= 1; } candidate = end(year, quarter); }
  while (out.length < count) {
    out.push(end(year, quarter));
    quarter -= 1;
    if (quarter < 0) { quarter = 3; year -= 1; }
  }
  out.reverse();
  if (out[out.length - 1] !== asOf) out.push(asOf);
  return out;
}
