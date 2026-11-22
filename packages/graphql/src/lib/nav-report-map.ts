/**
 * A filed report, mapped onto the NAV chart and the fund's positions.
 *
 * Each line of the chart says which report wording it takes (navLine.match on
 * the attribute). A report line is tested against the chart lines of its own
 * statement in order; the first rule that holds takes it. Several report lines
 * can fill one chart line (three share classes' share transactions, two
 * realized lines on currency), and are added up, unless the line takes the
 * report's own total. A line that matched nothing is listed with the reason.
 *
 * The plan says what one load writes: the statement as of the period end and as
 * of the comparative date, the flows for the span between them, and one record
 * per investment in the schedule at the period end. Pure, so the read step, the
 * load step and the tests see the same mapping.
 */

import type {
  FinancialReport, ReportCell, ReportCheck, ReportColumn, ReportStatement, ReportStatementKind, ScheduleRow,
} from './import-intake/financial-report';

export type LineUnit = 'AMOUNT' | 'SHARES' | 'PER_SHARE';

export interface MatchRule {
  label: string;
  section?: string;
  notSection?: string;
  total?: boolean;
}

export interface ChartLine {
  code: string;
  name: string;
  section: string;
  role: string;
  order: number;
  unit: LineUnit;
  priority: number;
  single: boolean;
  combine: 'sum' | 'equal';
  fallback: string | null;
  rules: MatchRule[];
}

/** NAV chart lines from attribute rows: the navLine settings in validation_rules. */
export function chartFromAttributes(rows: Array<{ attribute_code: string; attribute_name: string; display_group: number | null; validation_rules: unknown }>): ChartLine[] {
  const out: ChartLine[] = [];
  for (const row of rows) {
    const nav = (row.validation_rules as { navLine?: Record<string, unknown> } | null)?.navLine;
    if (!nav || typeof nav !== 'object' || !nav.section) continue;
    const rules = Array.isArray(nav.match) ? (nav.match as unknown[]).filter((rule): rule is MatchRule => Boolean(rule) && typeof (rule as MatchRule).label === 'string') : [];
    out.push({
      code: row.attribute_code,
      name: row.attribute_name,
      section: String(nav.section),
      role: String(nav.role || 'LINE'),
      order: Number(row.display_group) || 0,
      unit: (nav.unit === 'SHARES' || nav.unit === 'PER_SHARE' ? nav.unit : 'AMOUNT'),
      priority: Number.isFinite(Number(nav.priority)) ? Number(nav.priority) : 100,
      single: nav.single === true,
      combine: nav.combine === 'equal' ? 'equal' : 'sum',
      fallback: typeof nav.fallback === 'string' && nav.fallback ? nav.fallback : null,
      rules,
    });
  }
  return out.sort((left, right) => left.order - right.order);
}

const STATEMENT_SECTIONS: Record<ReportStatementKind, (section: string) => boolean> = {
  BALANCE_SHEET: (section) => section.startsWith('BS_'),
  OPERATIONS: (section) => section === 'OPS',
  CHANGES: (section) => section === 'CHANGES',
  CASH_FLOWS: (section) => section === 'CASH',
};

/** Lower case, with "(decrease)" and the like and any parenthesis holding an amount or a note taken out. */
export function normalizeReportLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/&/g, ' and ')
    .replace(/\s*\((?:decrease|increase|loss|losses|gain|gains|depreciation|appreciation|used in|provided by|payments|deficit|expense|income)\)/g, '')
    .replace(/\s*\([^)]*[\d$€£][^)]*\)/g, '')
    .replace(/\s*\(note[^)]*\)/g, '')
    .replace(/[:;]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SUPPLEMENTAL = /supplemental|non-cash (financing|investing|activities)/;
const SHARE_CLASS = /\b(class|series)\b/;

function compile(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

interface Compiled {
  line: ChartLine;
  rules: Array<{ label: RegExp; section: RegExp | null; notSection: RegExp | null; total: boolean }>;
  fallback: RegExp | null;
}

function compileChart(chart: ChartLine[]): Compiled[] {
  return [...chart]
    .sort((left, right) => left.priority - right.priority || left.order - right.order)
    .map((line) => ({
      line,
      rules: line.rules
        .map((rule) => ({ label: compile(rule.label), section: compile(rule.section), notSection: compile(rule.notSection), total: rule.total === true }))
        .filter((rule): rule is { label: RegExp; section: RegExp | null; notSection: RegExp | null; total: boolean } => rule.label != null),
      fallback: compile(line.fallback ?? undefined),
    }));
}

export interface SourceLine {
  /** Where the line is in its statement, which is also its row in the stored table. */
  index: number;
  label: string;
  section: string;
  values: Array<number | null>;
  cells: Array<ReportCell | null>;
}

export interface MappedLine {
  code: string;
  name: string;
  unit: LineUnit;
  /** One per report column. */
  values: Array<number | null>;
  /** The report lines that fill it. */
  from: SourceLine[];
  /** Lines under a total the chart line took, kept for the record. */
  detail: SourceLine[];
  /** Why a value is left blank, when one is. */
  note: string | null;
}

export interface UnmappedLine {
  index: number;
  label: string;
  section: string;
  reason: string;
  /** One per report column, so a reader can tell a blank line from one with figures. */
  values: Array<number | null>;
}

export interface StatementMapping {
  kind: ReportStatementKind;
  title: string;
  columns: ReportColumn[];
  lines: MappedLine[];
  unmapped: UnmappedLine[];
}

function combine(line: ChartLine, sources: SourceLine[], width: number): { values: Array<number | null>; note: string | null } {
  const values: Array<number | null> = [];
  let note: string | null = null;
  for (let column = 0; column < width; column += 1) {
    const present = sources.map((source) => source.values[column]).filter((value): value is number => value != null);
    if (!present.length) {
      values.push(null);
      continue;
    }
    if (line.combine === 'equal') {
      const same = present.every((value) => Math.abs(value - present[0]) < 1e-9);
      values.push(same ? present[0] : null);
      if (!same) note = `The report gives ${present.length} different figures (${present.join(', ')}); a per-share amount is taken only when every class agrees.`;
      continue;
    }
    values.push(Math.round(present.reduce((total, value) => total + value, 0) * 100) / 100);
  }
  return { values, note };
}

/** One statement of a report onto the chart lines of that statement. */
export function mapStatement(statement: ReportStatement, chart: ChartLine[]): StatementMapping {
  const compiled = compileChart(chart.filter((line) => STATEMENT_SECTIONS[statement.kind](line.section)));
  const hits = new Map<string, { total: SourceLine[]; parts: SourceLine[] }>();
  const unmapped: UnmappedLine[] = [];
  const take = (code: string, source: SourceLine, total: boolean) => {
    const entry = hits.get(code) || { total: [], parts: [] };
    (total ? entry.total : entry.parts).push(source);
    hits.set(code, entry);
  };
  for (const [index, line] of statement.lines.entries()) {
    if (line.header || line.values.every((value) => value == null)) continue;
    const label = normalizeReportLabel(line.label);
    const section = normalizeReportLabel(line.section);
    if (SUPPLEMENTAL.test(section)) {
      unmapped.push({ index, label: line.label, section: line.section, values: line.values, reason: 'Supplemental disclosure, not a line of the statement.' });
      continue;
    }
    const source: SourceLine = { index, label: line.label, section: line.section, values: line.values, cells: line.cells };
    let placed = false;
    for (const entry of compiled) {
      const rule = entry.rules.find((candidate) => candidate.label.test(label)
        && (!candidate.section || candidate.section.test(section))
        && (!candidate.notSection || !candidate.notSection.test(section)));
      if (!rule) continue;
      take(entry.line.code, source, rule.total);
      placed = true;
      break;
    }
    if (placed) continue;
    if (SHARE_CLASS.test(section)) {
      unmapped.push({ index, label: line.label, section: line.section, values: line.values, reason: 'Share-class detail. The report checks compare it with the fund total.' });
      continue;
    }
    const fallback = compiled.find((entry) => entry.fallback && entry.fallback.test(section) && !/^total\b/.test(label));
    if (fallback) {
      take(fallback.line.code, source, false);
      continue;
    }
    unmapped.push({ index, label: line.label, section: line.section, values: line.values, reason: 'No line on the NAV chart takes this wording.' });
  }

  const width = statement.columns.length;
  const lines: MappedLine[] = [];
  for (const chartLine of chart.filter((line) => STATEMENT_SECTIONS[statement.kind](line.section))) {
    const entry = hits.get(chartLine.code);
    if (!entry) continue;
    let from = entry.total.length ? entry.total : entry.parts;
    const detail = entry.total.length ? entry.parts : [];
    if (chartLine.single && from.length > 1) {
      for (const extra of from.slice(1)) {
        unmapped.push({ index: extra.index, label: extra.label, section: extra.section, values: extra.values, reason: `${chartLine.name} takes one line, and “${from[0].label}” already fills it.` });
      }
      from = from.slice(0, 1);
    }
    const { values, note } = combine(chartLine, from, width);
    lines.push({ code: chartLine.code, name: chartLine.name, unit: chartLine.unit, values, from, detail, note });
  }
  return { kind: statement.kind, title: statement.title, columns: statement.columns, lines, unmapped };
}

/* ------------------------------------------------------------------ plan */

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Whole months from one period end to another: December 31 to June 30 is 6. */
export function monthsBetween(from: string, to: string): number {
  const start = day(from);
  const end = day(to);
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
}

export interface PlannedValue {
  code: string;
  name: string;
  value: number;
  cell: ReportCell | null;
  /** The report lines behind the value, with the statement they are on. */
  from: string[];
}

export interface PlannedRow {
  asOf: string;
  values: PlannedValue[];
}

export interface PlannedPosition {
  code: string;
  name: string;
  assetClass: string;
  industry: string;
  company: string;
  coupon: string;
  maturity: string | null;
  currency: string;
  par: number | null;
  cost: number | null;
  fairValue: number | null;
  cells: ScheduleRow['cells'];
  page: number;
}

export interface NavReportPlan {
  periodEnd: string;
  comparativeDate: string | null;
  /** Months the flow statements cover: from the comparative date to the period end. */
  months: number | null;
  /** The NAV statement at the period end, and at the comparative date. */
  rows: PlannedRow[];
  statements: Array<StatementMapping & { periodColumn: number | null; comparativeColumn: number | null }>;
  positions: PlannedPosition[];
  checks: ReportCheck[];
  problems: string[];
}

/** FNV-1a, 32 bits. Enough to tell a company's tranches apart, and the same in every runtime. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function slug(text: string, length: number): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, length).replace(/-+$/, '');
}

/** A position's code: the fund, the company, and a short hash of what tells its tranches apart. Stable from one schedule to the next. */
export function positionCode(fundCode: string, row: Pick<ScheduleRow, 'assetClass' | 'company' | 'maturity' | 'reference' | 'currency'>, ordinal: number): string {
  const key = [row.assetClass, row.company, row.maturity || '', row.reference.replace(/\s+/g, ''), row.currency].map((part) => part.toLowerCase().trim()).join('|');
  const hash = fnv1a(key).toString(36).toUpperCase().padStart(6, '0').slice(-6);
  return `${fundCode}-${slug(row.company, 24)}-${hash}${ordinal > 1 ? `-${ordinal}` : ''}`;
}

function positionName(row: ScheduleRow, ordinal: number): string {
  const parts = [row.assetClass, row.reference || null, row.maturity ? `due ${row.maturity}` : null].filter(Boolean);
  return `${row.company}${parts.length ? ` (${parts.join(', ')})` : ''}${ordinal > 1 ? ` #${ordinal}` : ''}`;
}

/**
 * What a load writes for one report. periodEnd defaults to the latest balance
 * sheet date, and the comparative date to the other balance sheet column. The
 * flow statements are read for the span between them, so a 10-Q for June is
 * read as six months against December.
 */
export function planNavReport(report: FinancialReport, chart: ChartLine[], options: { fundCode: string; periodEnd?: string | null }): NavReportPlan {
  const problems: string[] = [];
  const periodEnd = options.periodEnd || report.periodEnd;
  if (!periodEnd) {
    return { periodEnd: '', comparativeDate: null, months: null, rows: [], statements: [], positions: [], checks: report.checks, problems: ['The report has no balance sheet date to load it as of.'] };
  }
  const balance = report.statements.find((statement) => statement.kind === 'BALANCE_SHEET');
  const pointDates = [...new Set((balance?.columns || []).filter((column) => column.months == null && column.date).map((column) => column.date!))].sort();
  if (!pointDates.includes(periodEnd)) problems.push(`The balance sheet has no column at ${periodEnd}. It has ${pointDates.join(' and ') || 'none'}.`);
  const comparativeDate = [...pointDates].reverse().find((date) => date < periodEnd) ?? null;
  const months = comparativeDate ? monthsBetween(comparativeDate, periodEnd) : null;

  const current: PlannedValue[] = [];
  const prior: PlannedValue[] = [];
  const statements: NavReportPlan['statements'] = [];
  for (const statement of report.statements) {
    const mapping = mapStatement(statement, chart);
    const flows = statement.kind !== 'BALANCE_SHEET';
    let periodColumn: number | null = null;
    let comparativeColumn: number | null = null;
    if (!flows) {
      periodColumn = statement.columns.findIndex((column) => column.months == null && column.date === periodEnd);
      comparativeColumn = comparativeDate ? statement.columns.findIndex((column) => column.months == null && column.date === comparativeDate) : -1;
    } else {
      const ending = statement.columns.map((column, index) => ({ column, index })).filter(({ column }) => column.date === periodEnd && column.months != null);
      const span = ending.find(({ column }) => column.months === months) ?? null;
      if (span) periodColumn = span.index;
      else if (ending.length) {
        const longest = [...ending].sort((left, right) => (right.column.months || 0) - (left.column.months || 0))[0];
        periodColumn = longest.index;
        problems.push(`${mapping.title} has no ${months ?? '?'}-month column to ${periodEnd}; read the ${longest.column.months}-month column, so it does not run from the comparative date.`);
      } else {
        problems.push(`${mapping.title} has no column ending ${periodEnd}.`);
      }
    }
    if (periodColumn != null && periodColumn < 0) periodColumn = null;
    if (comparativeColumn != null && comparativeColumn < 0) comparativeColumn = null;
    statements.push({ ...mapping, periodColumn, comparativeColumn });
    for (const line of mapping.lines) {
      const describe = (column: number) => line.from.map((source) => `${statement.title}: ${source.section ? `${source.section}: ` : ''}${source.label}`.slice(0, 200));
      const cellAt = (column: number) => (line.from.length === 1 ? line.from[0].cells[column] ?? null : null);
      if (periodColumn != null && line.values[periodColumn] != null) {
        current.push({ code: line.code, name: line.name, value: line.values[periodColumn]!, cell: cellAt(periodColumn), from: describe(periodColumn) });
      }
      if (comparativeColumn != null && line.values[comparativeColumn] != null) {
        prior.push({ code: line.code, name: line.name, value: line.values[comparativeColumn]!, cell: cellAt(comparativeColumn), from: describe(comparativeColumn) });
      }
    }
  }
  const rows: PlannedRow[] = [{ asOf: periodEnd, values: current }];
  if (comparativeDate && prior.length) rows.push({ asOf: comparativeDate, values: prior });

  const schedule = report.schedules.find((item) => item.date === periodEnd) ?? null;
  if (!schedule && report.schedules.length) problems.push(`The schedule of investments is not at ${periodEnd}; positions are not loaded.`);
  const positions: PlannedPosition[] = [];
  if (schedule) {
    const seen = new Map<string, number>();
    for (const row of schedule.rows.filter((item) => item.kind === 'investment')) {
      const base = positionCode(options.fundCode, row, 1);
      const ordinal = (seen.get(base) || 0) + 1;
      seen.set(base, ordinal);
      positions.push({
        code: ordinal === 1 ? base : positionCode(options.fundCode, row, ordinal),
        name: positionName(row, ordinal),
        assetClass: row.assetClass,
        industry: row.industry,
        company: row.company,
        coupon: [row.reference, row.rate].filter(Boolean).join(', '),
        maturity: row.maturity,
        currency: row.currency,
        par: row.par,
        cost: row.cost,
        fairValue: row.fairValue,
        cells: row.cells,
        page: row.page,
      });
    }
  }
  return { periodEnd, comparativeDate, months, rows, statements, positions, checks: report.checks, problems };
}
