import type { CovenantStatus, CovenantTest } from './covenant-test';
import { isGridLine, isHeadline, projectStatementBook, statementAttributesFromRegister, type RegisterAttribute, type StatementAttribute, type StatementPeriod } from './statement-book';

/**
 * A borrower's financials for one quarter, as a reviewer needs them: the
 * statement lines for the last few quarters, how the lines that matter moved,
 * every covenant on the borrower's deals tested at that quarter end beside
 * what the borrower's certificate says, and what is still open.
 *
 * Nothing is calculated here that the platform calculates elsewhere. The lines
 * come from the statement book (the register's formulas), and a covenant's
 * value, limit and status come from the covenant test. This file lines them up,
 * measures the movement between quarters, and says what needs a person.
 * Pure, so the tool, the review and the tests read the same figures.
 */

export type LineUnit = 'amount' | 'percent' | 'multiple' | 'number';

/** How far a certificate may sit from our calculation, as a share of the calculation, and still agree. */
export const CERTIFICATE_TOLERANCE = 0.02;
/** A move at least this large is called out: a share of the earlier amount, points of a percentage, or turns of a multiple. */
export const NOTABLE = { amountOnYear: 0.15, amountOnQuarter: 0.1, points: 0.03, turns: 0.5 };
/** The attribute that holds a quarter's review notes, when it is registered. */
export const REVIEW_NOTES_CODE = 'STATEMENT_REVIEW_NOTES';
export const REVIEW_OUTCOME_CODE = 'STATEMENT_REVIEW_OUTCOME';

export interface FinancialQuarter {
  end: string;
  label: string;
  /** The quarter has ended, so its figures are reported and not projected. */
  actual: boolean;
  statementId: string | null;
}

export interface FinancialLine {
  code: string;
  name: string;
  section: string;
  unit: LineUnit;
  /** One value for each quarter shown, oldest first. */
  values: Array<number | null>;
  /** A total, a margin or a headline figure: the lines a review reads first. */
  key: boolean;
}

export interface TrendRow {
  code: string;
  name: string;
  unit: LineUnit;
  latest: number | null;
  priorQuarter: number | null;
  yearAgo: number | null;
  /** Change on the quarter and on the year: a share of the earlier figure for an amount, the difference for a percentage or a multiple. */
  onQuarter: number | null;
  onYear: number | null;
  notable: boolean;
}

export interface CovenantCheck {
  covenantId: string;
  code: string;
  name: string;
  dealName: string | null;
  metric: string | null;
  /** MAX: the value must stay at or under the limit. MIN: at or over it. */
  direction: string | null;
  unit: LineUnit;
  testDate: string | null;
  limit: number | null;
  /** Our calculation under the deal's own definition. */
  calculated: number | null;
  numerator: number | null;
  denominator: number | null;
  status: CovenantStatus;
  /** How far inside the limit, as a share of it. Negative when past it. */
  cushion: number | null;
  /** What the borrower's compliance certificate says. */
  certificate: number | null;
  /** Certificate less our calculation. */
  difference: number | null;
  /** The certificate is within tolerance of our calculation. Null when either is missing. */
  agrees: boolean | null;
  /** The value under the house definition, for comparing deals. */
  house: number | null;
  /** The stored value is behind what the definition gives now. */
  stale: boolean;
  /** Before the covenant's first test: shown for monitoring, not scored. */
  beforeFirstTest: boolean;
  /** Statement lines the definition needs that are not on file. */
  missing: string[];
  /** The lines of the deal's definition in force at the test, each with what it read and what it counted after any cap. */
  definition: Array<{ line: string; side: 'NUMERATOR' | 'DENOMINATOR'; sign: 'ADD' | 'SUBTRACT'; period: string; cap: string | null; read: number | null; counted: number | null; capped: boolean; clause: string | null }>;
  history: Array<{ testDate: string; value: number | null; limit: number | null }>;
}

/** Something open on the borrower for this quarter, with what to do and who does it. */
export interface OpenEntry {
  id: string;
  kind: 'statement' | 'breach' | 'watch' | 'certificate' | 'data' | 'review';
  title: string;
  cause: string;
  action: string;
  owner: string;
  blocking: boolean;
}

export interface BorrowerFinancials {
  borrower: { id: string; code: string; name: string };
  /** The quarter looked at: the one asked for, or the latest that has ended. */
  periodEnd: string | null;
  periodLabel: string;
  /** A statement is on file for that quarter. */
  onFile: boolean;
  statementId: string | null;
  quarters: FinancialQuarter[];
  lines: FinancialLine[];
  trends: TrendRow[];
  covenants: CovenantCheck[];
  counts: { quarters: number; covenants: number; breaches: number; watch: number; pass: number; noData: number; certificateDiffers: number; certificateMissing: number; stale: number; notable: number };
  /** The review notes kept for the quarter, when there are any. */
  reviewNotes: string | null;
  /** One sentence on where the borrower stands. */
  headline: string;
  entries: OpenEntry[];
  /** Why nothing could be read, when the record has no statements and no deals. */
  note: string | null;
}

export interface BorrowerFinancialsInput {
  borrower: { id: string; code: string; name: string };
  periods: StatementPeriod[];
  register: RegisterAttribute[];
  covenants: CovenantTest[];
  /** The quarter end asked for. Null for the latest quarter that has ended. */
  asked: string | null;
  today: string;
  /** How many quarters to show. */
  quarters?: number;
  reviewNotes?: string | null;
  /** Whether review notes can be kept: the attribute for them is registered. */
  notesKept?: boolean;
}

const NUMERIC = new Set(['NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL']);

function unitOf(dataType: string, displayFormat: string | null | undefined): LineUnit {
  const format = String(displayFormat || '').toLowerCase();
  if (format === 'multiple') return 'multiple';
  if (format === 'ratio' || format === 'percent' || format === 'percentage' || dataType === 'PERCENTAGE') return 'percent';
  return dataType === 'CURRENCY' ? 'amount' : 'number';
}

/** A covenant's unit as the lines use it. An amount covenant (liquidity) is dollars; everything else is a multiple. */
export function covenantUnit(unit: string | null): LineUnit {
  const code = String(unit || '').toUpperCase();
  if (code === 'USD' || code === 'AMOUNT' || code === 'CURRENCY') return 'amount';
  if (code === 'PERCENT' || code === 'PCT') return 'percent';
  return 'multiple';
}

/** A figure in words: "$428.9M", "13.6%", "5.33x". */
export function figureText(value: number | null | undefined, unit: LineUnit): string {
  if (value == null || !Number.isFinite(value)) return 'no figure';
  if (unit === 'percent') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'multiple') return `${value.toFixed(2)}x`;
  if (unit === 'number') return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const sign = value < 0 ? '-' : '';
  const size = Math.abs(value);
  if (size >= 1e9) return `${sign}$${(size / 1e9).toFixed(2)}B`;
  if (size >= 1e6) return `${sign}$${(size / 1e6).toFixed(1)}M`;
  if (size >= 1e3) return `${sign}$${(size / 1e3).toFixed(0)}K`;
  return `${sign}$${size.toFixed(0)}`;
}

/** A change in words: "up 4.2%", "down 1.3 pts", "up 0.55x". */
export function changeText(change: number | null | undefined, unit: LineUnit): string {
  if (change == null || !Number.isFinite(change)) return 'no comparison';
  const size = Math.abs(change);
  const amount = unit === 'amount' || unit === 'number' ? `${(size * 100).toFixed(1)}%` : unit === 'percent' ? `${(size * 100).toFixed(1)} pts` : `${size.toFixed(2)}x`;
  if (size < 1e-9) return 'unchanged';
  return `${change > 0 ? 'up' : 'down'} ${amount}`;
}

function change(latest: number | null, earlier: number | null, unit: LineUnit): number | null {
  if (latest == null || earlier == null) return null;
  if (unit === 'amount' || unit === 'number') return earlier === 0 ? null : (latest - earlier) / Math.abs(earlier);
  return latest - earlier;
}

function isNotable(row: Pick<TrendRow, 'unit' | 'onQuarter' | 'onYear'>): boolean {
  const year = Math.abs(row.onYear ?? 0);
  const quarter = Math.abs(row.onQuarter ?? 0);
  if (row.unit === 'percent') return year >= NOTABLE.points || quarter >= NOTABLE.points;
  if (row.unit === 'multiple') return year >= NOTABLE.turns || quarter >= NOTABLE.turns;
  return year >= NOTABLE.amountOnYear || quarter >= NOTABLE.amountOnQuarter;
}

function quarterLabel(end: string): string {
  const month = Number(end.slice(5, 7));
  return `Q${Math.ceil((month || 1) / 3)} ${end.slice(0, 4)}`;
}

function monthOf(end: string): string {
  return end.slice(0, 7);
}

function yearBefore(end: string): string {
  return `${Number(end.slice(0, 4)) - 1}${end.slice(4, 7)}`;
}

/** The lines a review reads first: headline figures, totals and margins, and the top line of each section. */
function keyCodes(attributes: StatementAttribute[]): Set<string> {
  const lines = attributes.filter((attr) => isGridLine(attr) && attr.role !== 'section' && NUMERIC.has(attr.dataType));
  const keys = new Set<string>();
  for (const attr of attributes) {
    if (!NUMERIC.has(attr.dataType)) continue;
    if (isHeadline(attr) || attr.role === 'total' || attr.role === 'net' || attr.role === 'ratio') keys.add(attr.code);
  }
  const firstOf = new Map<string, StatementAttribute>();
  for (const attr of lines) {
    const first = firstOf.get(attr.section);
    if (!first || attr.order < first.order) firstOf.set(attr.section, attr);
  }
  for (const attr of firstOf.values()) keys.add(attr.code);
  return keys;
}

function checkOf(test: CovenantTest): CovenantCheck {
  const unit = covenantUnit(test.unit);
  const certificate = test.reported.find((reading) => reading.sourceCode !== 'MANUAL' && reading.value != null)?.value ?? null;
  const difference = certificate != null && test.value != null ? certificate - test.value : null;
  const scale = Math.max(Math.abs(test.value ?? 0), 1e-9);
  return {
    covenantId: test.covenantId,
    code: test.code,
    name: test.name,
    dealName: test.dealName,
    metric: test.metric,
    direction: test.direction,
    unit,
    testDate: test.testDate,
    limit: test.level,
    calculated: test.value,
    numerator: test.numerator,
    denominator: test.denominator,
    status: test.status,
    cushion: test.cushion,
    certificate,
    difference,
    agrees: difference == null ? null : Math.abs(difference) <= scale * CERTIFICATE_TOLERANCE,
    house: test.house,
    stale: test.stale,
    beforeFirstTest: test.beforeFirstTest,
    missing: test.missing,
    definition: test.components
      .filter((component) => component.active)
      .map((component) => ({
        line: component.name,
        side: component.side,
        sign: component.sign,
        period: component.measure,
        cap: component.capType === 'NONE' ? null : component.capType === 'AMOUNT' ? `at most ${figureText(component.capValue, 'amount')}` : `at most ${component.capValue ?? 0}% of the side's uncapped lines`,
        read: component.raw,
        counted: component.applied,
        capped: component.capped,
        clause: component.clause,
      })),
    history: test.history.slice(-6).map((point) => ({ testDate: point.testDate, value: point.value, limit: point.level })),
  };
}

function limitWords(check: CovenantCheck): string {
  return `${figureText(check.calculated, check.unit)} against a ${check.direction === 'MIN' ? 'minimum' : 'maximum'} of ${figureText(check.limit, check.unit)}`;
}

/**
 * What is open. Each entry's id names what it is about (the borrower, or the covenant), so a change
 * that settles it can be matched to it: see `settles`.
 */
function entriesOf(input: { borrowerId: string; label: string; onFile: boolean; periodEnd: string | null; covenants: CovenantCheck[]; reviewNotes: string | null; notesKept: boolean }): OpenEntry[] {
  const entries: OpenEntry[] = [];
  if (input.periodEnd && !input.onFile) {
    entries.push({ id: `statement:${input.borrowerId}`, kind: 'statement', title: `No statement on file for ${input.label}`, cause: 'The quarter has no statement, so nothing can be reviewed or tested.', action: "Load the borrower's financial package for the quarter.", owner: 'Credit analyst', blocking: true });
  }
  for (const check of input.covenants) {
    if (check.beforeFirstTest) continue;
    if (check.status === 'BREACH') {
      entries.push({ id: `cov:${check.covenantId}`, kind: 'breach', title: `${check.name} is past its limit`, cause: `${limitWords(check)}.`, action: 'Tell the deal team, and agree a waiver, a cure or a reservation of rights.', owner: 'Deal team', blocking: true });
    } else if (check.status === 'WATCH') {
      entries.push({ id: `cov:${check.covenantId}`, kind: 'watch', title: `${check.name} is close to its limit`, cause: `${limitWords(check)}, a cushion of ${figureText(check.cushion, 'percent')}.`, action: "Ask the borrower for its forecast and watch next quarter's test.", owner: 'Credit analyst', blocking: false });
    } else if (check.status === 'NO_DATA') {
      entries.push({ id: `cov:${check.covenantId}`, kind: 'data', title: `${check.name} cannot be calculated`, cause: check.missing.length > 0 ? `Not on file: ${check.missing.join(', ')}.` : 'A figure or the limit is not on file.', action: 'Load the statement lines the definition needs.', owner: 'Credit analyst', blocking: true });
    }
    if (check.calculated != null && check.certificate == null) {
      entries.push({ id: `cert:${check.covenantId}`, kind: 'certificate', title: `${check.name}: no certificate value on file`, cause: 'Our calculation cannot be compared with what the borrower certified.', action: "Record the value from the borrower's compliance certificate.", owner: 'Credit analyst', blocking: false });
    } else if (check.agrees === false) {
      entries.push({ id: `cert:${check.covenantId}`, kind: 'certificate', title: `${check.name}: the certificate differs from our calculation`, cause: `${figureText(check.certificate, check.unit)} on the certificate against ${figureText(check.calculated, check.unit)} calculated.`, action: "Ask the borrower for the bridge from its figure to the agreement's definition.", owner: 'Credit analyst', blocking: check.status === 'BREACH' });
    }
    if (check.stale) {
      entries.push({ id: `stale:${check.covenantId}`, kind: 'data', title: `${check.name}: the stored value is behind the definition`, cause: 'A statement line or the definition changed after the value was stored.', action: 'Recalculate the covenant.', owner: 'Credit analyst', blocking: false });
    }
  }
  if (input.onFile && input.notesKept && !input.reviewNotes) {
    entries.push({ id: `review:${input.borrowerId}`, kind: 'review', title: `${input.label} has not been reviewed`, cause: 'No review notes are kept for the quarter.', action: 'Write the review and keep its notes on the quarter.', owner: 'Credit analyst', blocking: false });
  }
  return entries;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Lines up a borrower's statements and covenant tests for one quarter. */
export function buildBorrowerFinancials(input: BorrowerFinancialsInput): BorrowerFinancials {
  const attributes = statementAttributesFromRegister(input.register);
  // Everything up to the quarter looked at is read as reported, so a quarter end asked for ahead of today still tests.
  const cut = input.asked && input.asked > input.today ? input.asked : input.today;
  const projection = projectStatementBook(input.periods, attributes, cut, 'quarter');
  const ended = projection.columns.filter((column) => column.end <= cut);
  // A quarter is found by its month: a statement dated the 30th is still the quarter that ends on the 31st.
  const latest = (input.asked ? projection.columns.find((column) => monthOf(column.end) === monthOf(input.asked as string)) : ended[ended.length - 1]) || null;
  const periodEnd = latest?.end || input.asked || null;
  const label = periodEnd ? quarterLabel(periodEnd) : 'No quarter';
  const shown = projection.columns.filter((column) => !periodEnd || column.end <= periodEnd).slice(-(input.quarters || 6));
  const priorIndex = latest ? shown.indexOf(latest) - 1 : -1;
  const prior = priorIndex >= 0 ? shown[priorIndex] : null;
  // The same quarter a year earlier may sit before the quarters shown.
  const yearAgo = periodEnd ? projection.columns.find((column) => monthOf(column.end) === yearBefore(periodEnd)) || null : null;

  const keys = keyCodes(attributes);
  const sectionOrder = [...new Set(attributes.filter((attr) => isGridLine(attr)).sort((a, b) => a.order - b.order).map((attr) => attr.section))];
  const lineAttributes = attributes
    .filter((attr) => NUMERIC.has(attr.dataType) && attr.role !== 'section' && (isGridLine(attr) || keys.has(attr.code)))
    .sort((a, b) => sectionOrder.indexOf(a.section) - sectionOrder.indexOf(b.section) || a.order - b.order || a.name.localeCompare(b.name));
  // A key line that repeats another (ending cash and cash, net income on two statements) or that holds
  // nothing to follow (a balance check of a few cents) is read once, or not at all.
  const seen = new Set<string>();
  const lines: FinancialLine[] = lineAttributes.map((attr) => {
    const unit = unitOf(attr.dataType, attr.displayFormat);
    const values = shown.map((column) => column.values[attr.code] ?? null);
    // Amounts are compared to the dollar, so two totals a rounding apart are still the same line.
    const signature = values.map((value) => (value == null ? '' : unit === 'amount' ? String(Math.round(value)) : value.toFixed(4))).join('|');
    const negligible = unit === 'amount' && values.every((value) => value == null || Math.abs(value) < 1);
    const key = keys.has(attr.code) && !negligible && !seen.has(signature) && values.some((value) => value != null);
    if (key) seen.add(signature);
    return { code: attr.code, name: attr.name, section: attr.section, unit, values, key };
  });
  const keyLines = new Set(lines.filter((entry) => entry.key).map((entry) => entry.code));

  const trends: TrendRow[] = !latest
    ? []
    : lineAttributes
        .filter((attr) => keyLines.has(attr.code))
        .map((attr) => {
          const unit = unitOf(attr.dataType, attr.displayFormat);
          const now = latest.values[attr.code] ?? null;
          const before = prior ? prior.values[attr.code] ?? null : null;
          const year = yearAgo ? yearAgo.values[attr.code] ?? null : null;
          const row = { code: attr.code, name: attr.name, unit, latest: now, priorQuarter: before, yearAgo: year, onQuarter: change(now, before, unit), onYear: change(now, year, unit) };
          return { ...row, notable: isNotable(row) };
        })
        .filter((row) => row.latest != null);

  const covenants = input.covenants.filter((test) => !test.isLibrary).map(checkOf);
  const scored = covenants.filter((check) => !check.beforeFirstTest);
  const counts = {
    quarters: shown.length,
    covenants: covenants.length,
    breaches: scored.filter((check) => check.status === 'BREACH').length,
    watch: scored.filter((check) => check.status === 'WATCH').length,
    pass: scored.filter((check) => check.status === 'PASS').length,
    noData: scored.filter((check) => check.status === 'NO_DATA').length,
    certificateDiffers: scored.filter((check) => check.agrees === false).length,
    certificateMissing: scored.filter((check) => check.calculated != null && check.certificate == null).length,
    stale: scored.filter((check) => check.stale).length,
    notable: trends.filter((row) => row.notable).length,
  };
  const onFile = Boolean(latest);
  const reviewNotes = input.reviewNotes?.trim() || null;
  const none = input.periods.length === 0 && input.covenants.length === 0;

  const tested = scored.length === 0
    ? 'No covenant is tested.'
    : `${plural(scored.length, 'covenant')} tested: ${[
        counts.breaches > 0 ? `${counts.breaches} past ${counts.breaches === 1 ? 'its' : 'the'} limit` : '',
        counts.watch > 0 ? `${counts.watch} close to it` : '',
        counts.pass > 0 ? `${counts.pass} inside` : '',
        counts.noData > 0 ? `${counts.noData} with no figure` : '',
      ].filter(Boolean).join(', ')}.`;
  const certified = scored.length === 0 ? '' : counts.certificateDiffers > 0 ? ` ${plural(counts.certificateDiffers, 'certificate value')} ${counts.certificateDiffers === 1 ? 'differs' : 'differ'} from our calculation.` : counts.certificateMissing > 0 ? ` ${plural(counts.certificateMissing, 'certificate value')} not on file.` : ' The certificate agrees with our calculation.';
  const headline = none
    ? `${input.borrower.name} has no statements and no deals on file.`
    : !onFile
      ? `${input.borrower.name}, ${label}: no statement on file for the quarter.`
      : `${input.borrower.name}, ${label}: statement on file. ${tested}${certified}`;

  return {
    borrower: input.borrower,
    periodEnd,
    periodLabel: label,
    onFile,
    statementId: latest?.entityId || null,
    quarters: shown.map((column) => ({ end: column.end, label: quarterLabel(column.end), actual: column.actual, statementId: column.entityId || null })),
    lines,
    trends,
    covenants,
    counts,
    reviewNotes,
    headline,
    entries: none ? [] : entriesOf({ borrowerId: input.borrower.id, label, onFile, periodEnd, covenants, reviewNotes, notesKept: input.notesKept === true }),
    note: none ? 'This record has no statements and no deals, so it is not a borrower with financials to review.' : null,
  };
}

/**
 * The open entry a proposed change settles, by the tool it runs and the record it names. Null for a
 * change that settles none. The tool names are the borrower tools' own.
 */
export function settles(tool: string, args: Record<string, unknown>): string | null {
  const id = typeof args.entityId === 'string' ? args.entityId.trim() : '';
  if (!id) return null;
  if (tool === 'record_borrower_covenant_value') return `cert:${id}`;
  if (tool === 'save_borrower_review') return `review:${id}`;
  return null;
}

/** One line on where a quarter's review stood when its notes were kept, read from the figures and not written by the author. */
export function reviewOutcome(financials: BorrowerFinancials, asOf: string): string {
  const { counts } = financials;
  const parts = [
    `${plural(counts.covenants, 'covenant')}: ${counts.breaches} past the limit, ${counts.watch} close to it, ${counts.pass} inside${counts.noData > 0 ? `, ${counts.noData} with no figure` : ''}`,
    counts.certificateDiffers > 0 ? `${plural(counts.certificateDiffers, 'certificate value')} differing from our calculation` : counts.certificateMissing > 0 ? `${plural(counts.certificateMissing, 'certificate value')} not on file` : 'the certificate agreeing with our calculation',
    `${plural(counts.notable, 'line')} moving sharply`,
  ];
  return `${financials.periodLabel}. ${parts.join('; ')}. As of ${asOf}.`;
}

/**
 * What a tool hands an agent: the same figures without what only a screen needs. Lines are cut to the
 * key ones unless every line is asked for, so a list of borrowers stays small.
 */
export function borrowerDigest(financials: BorrowerFinancials, options: { allLines?: boolean } = {}) {
  return {
    borrower: financials.borrower,
    periodEnd: financials.periodEnd,
    period: financials.periodLabel,
    statementOnFile: financials.onFile,
    statementId: financials.statementId,
    headline: financials.headline,
    ...(financials.note ? { note: financials.note } : {}),
    counts: financials.counts,
    quarters: financials.quarters.map((quarter) => quarter.end),
    lines: financials.lines.filter((line) => options.allLines || line.key).map((line) => ({ line: line.name, code: line.code, section: line.section, unit: line.unit, values: line.values })),
    trends: financials.trends.map((row) => ({ line: row.name, code: row.code, unit: row.unit, latest: row.latest, priorQuarter: row.priorQuarter, yearAgo: row.yearAgo, onQuarter: row.onQuarter, onYear: row.onYear, notable: row.notable, inWords: `${figureText(row.latest, row.unit)}, ${changeText(row.onQuarter, row.unit)} on the quarter and ${changeText(row.onYear, row.unit)} on the year` })),
    covenants: financials.covenants.map((check) => ({
      covenantId: check.covenantId,
      covenant: check.name,
      deal: check.dealName,
      metric: check.metric,
      direction: check.direction,
      unit: check.unit,
      testDate: check.testDate,
      limit: check.limit,
      calculated: check.calculated,
      numerator: check.numerator,
      denominator: check.denominator,
      status: check.status,
      cushion: check.cushion,
      certificate: check.certificate,
      certificateLessCalculated: check.difference,
      certificateAgrees: check.agrees,
      houseDefinition: check.house,
      storedValueBehind: check.stale,
      beforeFirstTest: check.beforeFirstTest,
      linesNotOnFile: check.missing,
      definition: check.definition,
      history: check.history,
    })),
    reviewNotesKept: Boolean(financials.reviewNotes),
    entries: financials.entries,
  };
}
