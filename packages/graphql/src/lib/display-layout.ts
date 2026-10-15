// Series shaping and constrained HTML expansion for entity display layouts.
// Columns are fiscal period-end dates. A fact stays at the grain it was reported.
// LTM and YTD are computed at read time. Audit and the other bases filter stored observations.

export type Grain = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type PeriodRollup = 'NONE' | 'PERIOD_END' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
export type Presentation = 'AS_REPORTED' | 'LTM' | 'YTD';

export interface DisplayPeriod {
  key: string;
  grain: Grain;
  label: string;
  periodStart: string;
  periodEnd: string;
  entityId?: string | null;
}

export interface SeriesObservation {
  attributeCode: string;
  value: string | null;
  periodEnd: string;
  periodGrain: Grain;
  statementBasis: string;
  entityId: string;
}

export interface SeriesAttribute {
  attributeCode: string;
  attributeName: string;
  reportingGrain: Grain | null;
  periodRollup: PeriodRollup;
}

export interface ControlOption {
  value: string;
  label?: string;
  sets?: Record<string, string>;
}

export interface LayoutParameter {
  name: string;
  label?: string;
  type?: string;
  binds?: string;
  options?: Array<string | ControlOption>;
  default?: string;
  multi?: boolean;
}

export interface EffectiveControls {
  viewGrain: Grain;
  statementBasis: string[];
  presentation: Presentation;
  values: Record<string, string>;
}

export interface DisplayCell {
  periodKey: string;
  basis: string;
  value: string | null;
  readOnly: boolean;
  entityId: string | null;
  periodStart: string;
  periodEnd: string;
  periodGrain: Grain;
}

export interface DisplayRow {
  attributeCode: string;
  attributeName: string;
  reportingGrain: Grain | null;
  periodRollup: PeriodRollup;
  cells: DisplayCell[];
}

export interface DisplayNode {
  type: 'element' | 'text' | 'control' | 'field';
  tag?: string;
  className?: string;
  indent?: string;
  role?: string;
  control?: string;
  attributeCode?: string;
  periodKey?: string;
  basis?: string;
  text?: string;
  children?: DisplayNode[];
}

const GRAIN_RANK: Record<Grain, number> = {
  DAILY: 1,
  WEEKLY: 2,
  MONTHLY: 3,
  QUARTERLY: 4,
  ANNUAL: 5,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ALLOWED_TAGS = new Set([
  'div', 'section', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'span', 'h1', 'h2', 'h3', 'h4', 'p', 'br', 'x-field', 'x-control',
]);
const DROPPED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta']);

export const DEFAULT_SERIES_PARAMETERS: LayoutParameter[] = [
  {
    name: 'financialType',
    label: 'Financial type',
    type: 'select',
    options: [
      { value: 'MONTHLY', label: 'Monthly', sets: { viewGrain: 'MONTHLY', presentation: 'AS_REPORTED', statementBasis: 'ACTUAL' } },
      { value: 'QUARTERLY', label: 'Quarterly', sets: { viewGrain: 'QUARTERLY', presentation: 'AS_REPORTED', statementBasis: 'ACTUAL' } },
      { value: 'LTM', label: 'LTM', sets: { viewGrain: 'QUARTERLY', presentation: 'LTM', statementBasis: 'ACTUAL' } },
      { value: 'AUDIT', label: 'Audit', sets: { viewGrain: 'ANNUAL', presentation: 'AS_REPORTED', statementBasis: 'AUDIT' } },
    ],
    default: 'QUARTERLY',
  },
  {
    name: 'viewGrain',
    label: 'Frequency',
    type: 'select',
    binds: 'view_grain',
    options: ['MONTHLY', 'QUARTERLY', 'ANNUAL'],
    default: 'QUARTERLY',
  },
  {
    name: 'statementBasis',
    label: 'Basis',
    type: 'select',
    binds: 'statement_basis',
    options: ['ACTUAL', 'AUDIT', 'MANAGEMENT', 'BUDGET'],
    default: 'ACTUAL',
  },
  {
    name: 'presentation',
    label: 'Presentation',
    type: 'select',
    binds: 'presentation',
    options: ['AS_REPORTED', 'LTM', 'YTD'],
    default: 'AS_REPORTED',
  },
];

export function isGrain(value: string | null | undefined): value is Grain {
  return value === 'DAILY' || value === 'WEEKLY' || value === 'MONTHLY' || value === 'QUARTERLY' || value === 'ANNUAL';
}

export function optionValue(option: string | ControlOption): string {
  return typeof option === 'string' ? option : option.value;
}

export function optionLabel(option: string | ControlOption): string {
  if (typeof option === 'string') return option;
  return option.label || option.value;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function parseISODate(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return { year, month, day };
}

function formatISODate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function addDays(iso: string, days: number): string {
  const { year, month, day } = parseISODate(iso);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): string {
  const { year, month, day } = parseISODate(iso);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month, 0));
  return date.toISOString().slice(0, 10);
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  const next = ((index % 12) + 12) % 12;
  return { year: Math.floor((index - next) / 12), month: next + 1 };
}

function alignedMonths(grain: Grain, fiscalYearEndMonth: number): Set<number> | null {
  if (grain === 'ANNUAL') return new Set([fiscalYearEndMonth]);
  if (grain === 'QUARTERLY') {
    return new Set([0, 3, 6, 9].map((delta) => ((fiscalYearEndMonth - 1 - delta + 12) % 12) + 1));
  }
  return null;
}

function fiscalYear(periodEnd: string, fiscalYearEndMonth: number): number {
  const { year, month } = parseISODate(periodEnd);
  return month <= fiscalYearEndMonth ? year : year + 1;
}

function quarterNumber(periodEnd: string, fiscalYearEndMonth: number): number {
  const startMonth = (fiscalYearEndMonth % 12) + 1;
  const { month } = parseISODate(periodEnd);
  const fromStart = (month - startMonth + 12) % 12;
  return Math.floor(fromStart / 3) + 1;
}

function periodStartFor(grain: Grain, periodEnd: string): string {
  const { year, month } = parseISODate(periodEnd);
  if (grain === 'ANNUAL') {
    const start = shiftMonth(year, month, -11);
    return formatISODate(start.year, start.month, 1);
  }
  if (grain === 'QUARTERLY') {
    const start = shiftMonth(year, month, -2);
    return formatISODate(start.year, start.month, 1);
  }
  if (grain === 'MONTHLY') return formatISODate(year, month, 1);
  if (grain === 'WEEKLY') return addDays(periodEnd, -6);
  return periodEnd;
}

function periodLabel(grain: Grain, periodEnd: string, fiscalYearEndMonth: number): string {
  const { year, month } = parseISODate(periodEnd);
  if (grain === 'ANNUAL') return `FY${fiscalYear(periodEnd, fiscalYearEndMonth)}`;
  if (grain === 'QUARTERLY') return `Q${quarterNumber(periodEnd, fiscalYearEndMonth)} FY${fiscalYear(periodEnd, fiscalYearEndMonth)}`;
  if (grain === 'MONTHLY') return `${MONTHS[month - 1]} ${year}`;
  return periodEnd;
}

function makePeriod(grain: Grain, periodEnd: string, fiscalYearEndMonth: number, entityId?: string | null): DisplayPeriod {
  return {
    key: entityId ? `entity:${entityId}` : `${grain}:${periodEnd}`,
    grain,
    label: periodLabel(grain, periodEnd, fiscalYearEndMonth),
    periodStart: periodStartFor(grain, periodEnd),
    periodEnd,
    entityId: entityId ?? null,
  };
}

export function periodsBetween(grain: Grain, fiscalYearEndMonth: number, from: string, to: string): DisplayPeriod[] {
  const fye = Math.min(12, Math.max(1, fiscalYearEndMonth || 12));
  if (from > to) return [];
  if (grain === 'DAILY') {
    const periods: DisplayPeriod[] = [];
    for (let cursor = from; cursor <= to && periods.length < 400; cursor = addDays(cursor, 1)) {
      periods.push(makePeriod(grain, cursor, fye));
    }
    return periods;
  }
  if (grain === 'WEEKLY') {
    const periods: DisplayPeriod[] = [];
    const { year, month, day } = parseISODate(from);
    const start = new Date(Date.UTC(year, month - 1, day));
    const weekday = start.getUTCDay();
    let cursor = addDays(from, weekday === 0 ? 0 : 7 - weekday);
    while (cursor <= to && periods.length < 120) {
      periods.push(makePeriod(grain, cursor, fye));
      cursor = addDays(cursor, 7);
    }
    return periods;
  }

  const aligned = alignedMonths(grain, fye);
  const start = parseISODate(from);
  const end = parseISODate(to);
  const periods: DisplayPeriod[] = [];
  let cursor = { year: start.year, month: start.month };
  const endIndex = end.year * 12 + end.month;
  while (cursor.year * 12 + cursor.month <= endIndex && periods.length < 240) {
    if (!aligned || aligned.has(cursor.month)) {
      const periodEnd = lastDayOfMonth(cursor.year, cursor.month);
      if (periodEnd >= from && periodEnd <= to) periods.push(makePeriod(grain, periodEnd, fye));
    }
    cursor = shiftMonth(cursor.year, cursor.month, 1);
  }
  return periods;
}

export function recentPeriods(grain: Grain, fiscalYearEndMonth: number, asOf: string, count: number): DisplayPeriod[] {
  const monthsBack = grain === 'ANNUAL' ? count * 12 : grain === 'QUARTERLY' ? count * 3 : grain === 'WEEKLY' ? count : count;
  const from = grain === 'DAILY' || grain === 'WEEKLY'
    ? addDays(asOf, -(count * (grain === 'WEEKLY' ? 7 : 1) + 7))
    : addMonths(asOf, -(monthsBack + 2));
  return periodsBetween(grain, fiscalYearEndMonth, from, asOf).slice(-count);
}

export function slotAttributeCodes(html: string): string[] {
  const codes: string[] = [];
  const pattern = /\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g;
  let match = pattern.exec(html);
  while (match) {
    const token = match[1];
    if (token !== 'period' && !token.startsWith('period.') && !codes.includes(token)) codes.push(token);
    match = pattern.exec(html);
  }
  return codes;
}

function normalizeOption(option: string | ControlOption): ControlOption {
  return typeof option === 'string' ? { value: option, label: option } : option;
}

export function applyControlChange(
  parameters: LayoutParameter[],
  current: Record<string, string>,
  name: string,
  value: string,
): Record<string, string> {
  const source = parameters.length > 0 ? parameters : DEFAULT_SERIES_PARAMETERS;
  const next = { ...current, [name]: value };
  const parameter = source.find((item) => item.name === name);
  const option = parameter?.options?.map(normalizeOption).find((item) => item.value === value);
  if (option?.sets) Object.assign(next, option.sets);
  return next;
}

export function effectiveControls(
  parameters: LayoutParameter[],
  selected: Record<string, string | string[] | undefined> | null | undefined,
  fallbackGrain: Grain,
): EffectiveControls {
  const source = parameters.length > 0 ? parameters : DEFAULT_SERIES_PARAMETERS;
  const values: Record<string, string> = {};
  for (const parameter of source) {
    const raw = selected?.[parameter.name];
    const picked = Array.isArray(raw) ? raw[0] : raw;
    values[parameter.name] = picked == null || picked === '' ? (parameter.default ?? '') : String(picked);
  }
  for (const parameter of source) {
    const option = parameter.options?.map(normalizeOption).find((item) => item.value === values[parameter.name]);
    if (!option?.sets) continue;
    for (const [key, value] of Object.entries(option.sets)) {
      const incoming = selected?.[key];
      const explicit = Array.isArray(incoming) ? incoming[0] : incoming;
      if (explicit == null || explicit === '') values[key] = value;
    }
  }

  const bound: Record<string, string> = {};
  for (const parameter of source) {
    if (!parameter.binds) continue;
    bound[parameter.binds] = values[parameter.name] || parameter.default || '';
  }

  const viewGrain = (isGrain(values.viewGrain) ? values.viewGrain : null)
    || (isGrain(bound.view_grain) ? bound.view_grain : null)
    || fallbackGrain;
  const basisRaw = values.statementBasis || bound.statement_basis || 'ACTUAL';
  const presentationRaw = (values.presentation || bound.presentation || 'AS_REPORTED').toUpperCase();
  const presentation: Presentation = presentationRaw === 'LTM' || presentationRaw === 'YTD' ? presentationRaw : 'AS_REPORTED';
  return {
    viewGrain,
    statementBasis: basisRaw.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean),
    presentation,
    values,
  };
}

function basisOf(observation: SeriesObservation): string {
  return (observation.statementBasis || 'ACTUAL').toUpperCase();
}

function matchesBasis(observation: SeriesObservation, bases: string[]): boolean {
  if (bases.length === 0) return true;
  return bases.includes(basisOf(observation));
}

function numeric(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 10000) / 10000);
}

function inPeriod(observation: SeriesObservation, period: DisplayPeriod): boolean {
  return observation.periodEnd >= period.periodStart && observation.periodEnd <= period.periodEnd;
}

function asReported(
  attribute: SeriesAttribute,
  observations: SeriesObservation[],
  period: DisplayPeriod,
): { value: string | null; readOnly: boolean; entityId: string | null } {
  const scoped = observations.filter((observation) => (
    observation.attributeCode === attribute.attributeCode
    && (period.entityId ? observation.entityId === period.entityId : true)
  ));
  const sameEnd = scoped.filter((observation) => observation.periodEnd === period.periodEnd);
  const native = sameEnd.find((observation) => observation.periodGrain === period.grain);
  if (native) return { value: native.value, readOnly: false, entityId: native.entityId };

  // A finer view shows a coarser reported fact only on the period-end column it belongs to.
  const coarser = sameEnd
    .filter((observation) => GRAIN_RANK[observation.periodGrain] > GRAIN_RANK[period.grain])
    .sort((a, b) => GRAIN_RANK[a.periodGrain] - GRAIN_RANK[b.periodGrain])[0];
  if (coarser) return { value: coarser.value, readOnly: true, entityId: coarser.entityId };

  const finer = scoped.filter((observation) => (
    GRAIN_RANK[observation.periodGrain] < GRAIN_RANK[period.grain] && inPeriod(observation, period)
  ));
  if (finer.length === 0) return { value: null, readOnly: true, entityId: period.entityId ?? null };

  if (attribute.periodRollup === 'PERIOD_END' || attribute.periodRollup === 'NONE') {
    const atEnd = finer
      .filter((observation) => observation.periodEnd === period.periodEnd)
      .sort((a, b) => GRAIN_RANK[b.periodGrain] - GRAIN_RANK[a.periodGrain])[0];
    return { value: atEnd?.value ?? null, readOnly: true, entityId: atEnd?.entityId ?? period.entityId ?? null };
  }

  const numbers = finer.map((observation) => numeric(observation.value)).filter((value): value is number => value != null);
  if (numbers.length === 0) return { value: null, readOnly: true, entityId: period.entityId ?? null };
  if (attribute.periodRollup === 'SUM') return { value: formatNumber(numbers.reduce((sum, value) => sum + value, 0)), readOnly: true, entityId: period.entityId ?? null };
  if (attribute.periodRollup === 'AVG') return { value: formatNumber(numbers.reduce((sum, value) => sum + value, 0) / numbers.length), readOnly: true, entityId: period.entityId ?? null };
  if (attribute.periodRollup === 'MIN') return { value: formatNumber(Math.min(...numbers)), readOnly: true, entityId: period.entityId ?? null };
  return { value: formatNumber(Math.max(...numbers)), readOnly: true, entityId: period.entityId ?? null };
}

function completeWindow(
  attribute: SeriesAttribute,
  observations: SeriesObservation[],
  grain: Grain,
  fiscalYearEndMonth: number,
  startExclusive: string,
  endInclusive: string,
  entityId?: string | null,
): string | null {
  const expected = periodsBetween(grain, fiscalYearEndMonth, addDays(startExclusive, 1), endInclusive);
  if (expected.length === 0) return null;
  const values: number[] = [];
  for (const period of expected) {
    const cell = asReported(attribute, observations, { ...period, entityId });
    const value = numeric(cell.value);
    if (value == null) return null;
    values.push(value);
  }
  return formatNumber(values.reduce((sum, value) => sum + value, 0));
}

export function buildSeriesRows(
  attributes: SeriesAttribute[],
  observations: SeriesObservation[],
  periods: DisplayPeriod[],
  controls: EffectiveControls,
  fiscalYearEndMonth: number,
): DisplayRow[] {
  const bases = controls.statementBasis.length > 0 ? controls.statementBasis : ['ACTUAL'];
  return attributes.map((attribute) => ({
    attributeCode: attribute.attributeCode,
    attributeName: attribute.attributeName,
    reportingGrain: attribute.reportingGrain,
    periodRollup: attribute.periodRollup,
    cells: periods.flatMap((period) => bases.map((basis) => {
      const scoped = observations.filter((observation) => matchesBasis({ ...observation, statementBasis: basisOf(observation) }, [basis]));
      const reported = asReported(attribute, scoped, period);
      let value = reported.value;
      let readOnly = reported.readOnly;
      if (controls.presentation === 'LTM' || controls.presentation === 'YTD') {
        readOnly = true;
        if (attribute.periodRollup === 'PERIOD_END') {
          value = reported.value;
        } else {
          const nativeGrain = attribute.reportingGrain || period.grain;
          const fiscalYearEnd = lastDayOfMonth(fiscalYear(period.periodEnd, fiscalYearEndMonth), fiscalYearEndMonth);
          const windowStart = controls.presentation === 'LTM'
            ? addMonths(period.periodEnd, -12)
            : addDays(periodStartFor('ANNUAL', fiscalYearEnd), -1);
          value = completeWindow(attribute, scoped, nativeGrain, fiscalYearEndMonth, windowStart, period.periodEnd, period.entityId);
        }
      }
      return {
        periodKey: period.key,
        basis,
        value,
        readOnly,
        entityId: reported.entityId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        periodGrain: period.grain,
      };
    })),
  }));
}

export function inferObservation(validFrom: string, validTo: string, periodGrain: string | null | undefined): { periodEnd: string; periodGrain: Grain } {
  if (isGrain(periodGrain)) {
    const periodEnd = validTo && validTo !== '9999-12-31' ? validTo : validFrom;
    return { periodEnd, periodGrain };
  }
  if (!validTo || validTo === '9999-12-31') return { periodEnd: validFrom, periodGrain: 'DAILY' };
  const start = Date.parse(`${validFrom}T00:00:00Z`);
  const end = Date.parse(`${validTo}T00:00:00Z`);
  const days = Math.max(1, Math.round((end - start) / 86400000));
  if (days <= 1) return { periodEnd: validTo, periodGrain: 'DAILY' };
  if (days <= 7) return { periodEnd: validTo, periodGrain: 'WEEKLY' };
  if (days <= 31) return { periodEnd: validTo, periodGrain: 'MONTHLY' };
  if (days <= 100) return { periodEnd: validTo, periodGrain: 'QUARTERLY' };
  return { periodEnd: validTo, periodGrain: 'ANNUAL' };
}

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] || char));
}

function findMatchingEach(input: string, from: number): number {
  let depth = 1;
  let index = from;
  while (index < input.length) {
    const open = input.indexOf('{{', index);
    if (open < 0) return -1;
    const close = input.indexOf('}}', open);
    if (close < 0) return -1;
    const tag = input.slice(open + 2, close).trim();
    if (tag.startsWith('#each ')) depth += 1;
    else if (tag === '/each') {
      depth -= 1;
      if (depth === 0) return open;
    }
    index = close + 2;
  }
  return -1;
}

function expandMustache(input: string, ctx: { periods: DisplayPeriod[]; bases: string[]; period?: DisplayPeriod; basis?: string }): string {
  let output = '';
  let index = 0;
  while (index < input.length) {
    const open = input.indexOf('{{', index);
    if (open < 0) {
      output += input.slice(index);
      break;
    }
    output += input.slice(index, open);
    const close = input.indexOf('}}', open);
    if (close < 0) break;
    const tag = input.slice(open + 2, close).trim();
    if (tag.startsWith('#each ')) {
      const blockEnd = findMatchingEach(input, close + 2);
      if (blockEnd < 0) break;
      const block = input.slice(close + 2, blockEnd);
      const what = tag.slice('#each '.length).trim();
      if (what === 'periods') {
        for (const period of ctx.periods) output += expandMustache(block, { ...ctx, period });
      } else if (what === 'selected.statementBasis') {
        for (const basis of ctx.bases) output += expandMustache(block, { ...ctx, basis });
      }
      index = blockEnd + '{{/each}}'.length;
      continue;
    }
    if (tag === 'period.label') output += escapeText(ctx.period?.label || '');
    else if (tag.startsWith('control ')) {
      output += `<x-control data-name="${escapeText(tag.slice('control '.length).trim())}"></x-control>`;
    } else if (/^[A-Za-z][A-Za-z0-9_.]*$/.test(tag)) {
      const period = ctx.period?.key || '';
      const basis = ctx.basis || '';
      output += `<x-field data-code="${escapeText(tag)}" data-period="${escapeText(period)}" data-basis="${escapeText(basis)}"></x-field>`;
    }
    index = close + 2;
  }
  return output;
}

function showWhen(expression: string | undefined, controls: EffectiveControls): boolean {
  if (!expression) return true;
  return expression.split('&&').every((part) => {
    const [rawKey, rawValue] = part.split('=');
    if (!rawKey || rawValue == null) return false;
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key === 'statementBasis') return controls.statementBasis.includes(value.toUpperCase());
    if (key === 'presentation') return controls.presentation === value.toUpperCase();
    if (key === 'viewGrain') return controls.viewGrain === value.toUpperCase();
    return controls.values[key] === value;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([:@\w-]+)\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(source);
  while (match) {
    attributes[match[1].toLowerCase()] = match[2];
    match = pattern.exec(source);
  }
  return attributes;
}

function parseExpanded(html: string, controls: EffectiveControls): DisplayNode[] {
  const tokens = html.match(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g) || [];
  const root: DisplayNode[] = [];
  const stack: DisplayNode[][] = [root];
  let dropping = 0;
  const hiddenStack: number[] = [];

  const current = () => stack[stack.length - 1];

  for (const token of tokens) {
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      const name = token.slice(2).replace(/[^A-Za-z0-9-].*$/, '').toLowerCase();
      if (dropping > 0 && DROPPED_TAGS.has(name)) {
        dropping -= 1;
        continue;
      }
      if (dropping > 0) continue;
      if (hiddenStack.length > 0) {
        hiddenStack[hiddenStack.length - 1] -= 1;
        if (hiddenStack[hiddenStack.length - 1] <= 0) hiddenStack.pop();
        continue;
      }
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (token.startsWith('<')) {
      const name = token.slice(1).replace(/[\s/>].*$/, '').toLowerCase();
      const selfClosing = /\/>\s*$/.test(token) || name === 'br';
      if (dropping > 0) continue;
      if (DROPPED_TAGS.has(name)) {
        if (!selfClosing) dropping += 1;
        continue;
      }
      const attributes = parseAttributes(token);
      const visible = showWhen(attributes['data-show-when'], controls);
      if (!visible || hiddenStack.length > 0) {
        if (!selfClosing && (!visible || hiddenStack.length > 0)) {
          if (!visible && hiddenStack.length === 0) hiddenStack.push(1);
          else if (hiddenStack.length > 0) hiddenStack[hiddenStack.length - 1] += 1;
        }
        continue;
      }
      if (name === 'x-control') {
        current().push({ type: 'control', control: attributes['data-name'] || '' });
        continue;
      }
      if (name === 'x-field') {
        current().push({
          type: 'field',
          attributeCode: attributes['data-code'] || '',
          periodKey: attributes['data-period'] || '',
          basis: attributes['data-basis'] || '',
        });
        continue;
      }
      if (!ALLOWED_TAGS.has(name)) continue;
      const node: DisplayNode = {
        type: 'element',
        tag: name,
        className: attributes.class,
        indent: attributes['data-indent'],
        role: attributes['data-role'],
        children: [],
      };
      current().push(node);
      if (!selfClosing && name !== 'br') stack.push(node.children || []);
      continue;
    }
    if (dropping > 0 || hiddenStack.length > 0) continue;
    const text = token.replace(/\s+/g, ' ');
    if (text.trim()) current().push({ type: 'text', text });
  }
  return root;
}

export function expandLayout(html: string, periods: DisplayPeriod[], controls: EffectiveControls): DisplayNode[] {
  const expanded = expandMustache(html, { periods, bases: controls.statementBasis });
  return parseExpanded(expanded, controls);
}

export function collectControls(nodes: DisplayNode[], into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.type === 'control' && node.control) into.add(node.control);
    if (node.children) collectControls(node.children, into);
  }
  return into;
}
