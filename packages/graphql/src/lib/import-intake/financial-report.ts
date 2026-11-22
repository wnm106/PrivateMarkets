/**
 * Reads a filed financial report: a 10-Q, a 10-K, or an annual or semi-annual
 * report with a text layer.
 *
 * The primary statements are found by their titles and the schedule of
 * investments by its column headings. Each statement is read into lines with
 * one value per column, and each column says the date it is at and how many
 * months it covers. The schedule is read into one row per investment, with the
 * asset class and industry it sits under, and its own subtotals and totals.
 *
 * Every value is read from one cell, and the cell is kept so a screen can
 * point at it. Nothing is inferred from prose. What the report says about
 * itself (industry subtotals, class totals, the per-class NAV) is checked here
 * with both figures, because those lines are not loaded one by one.
 *
 * Pure: it takes the positioned text of each page (extractPdfFragments).
 */

import { findDate } from './interpret';
import type { PdfFragment, PdfPageFragments } from './pdf-text';

export type ReportStatementKind = 'BALANCE_SHEET' | 'OPERATIONS' | 'CHANGES' | 'CASH_FLOWS';

/** Where a value sits on its page. Points, measured from the top left. */
export interface ReportCell {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ReportColumn {
  label: string;
  /** The date the column is at, or the date its period ends. */
  date: string | null;
  /** Months the column covers. Null for a balance at a date. */
  months: number | null;
}

export interface ReportLine {
  label: string;
  /** The heading the line sits under, without its colon. Blank at the top level. */
  section: string;
  header: boolean;
  /** One per column: dollars, or shares and per-share amounts as printed. */
  values: Array<number | null>;
  cells: Array<ReportCell | null>;
  /** Share counts and per-share amounts, which a report prints in units whatever its scale. */
  unscaled: boolean;
  page: number;
  labelCell: ReportCell | null;
}

export interface ReportStatement {
  kind: ReportStatementKind;
  title: string;
  pages: number[];
  /** Printed amounts are multiplied by this: 1000 for a report in thousands. */
  scale: number;
  columns: ReportColumn[];
  lines: ReportLine[];
}

export type ScheduleRowKind = 'investment' | 'subtotal' | 'class_total' | 'total';

export interface ScheduleRow {
  kind: ScheduleRowKind;
  assetClass: string;
  industry: string;
  /** The company, or for a total row its label. */
  company: string;
  footnotes: string;
  /** Reference rate and spread as printed, such as "S + 4.75% (2.25% PIK)". */
  reference: string;
  /** All-in interest rate as printed, such as "8.48%". */
  rate: string;
  maturity: string | null;
  currency: string;
  par: number | null;
  cost: number | null;
  fairValue: number | null;
  /** Percent of net assets as printed (0.35 means 0.35%). */
  pctOfNetAssets: number | null;
  page: number;
  cells: { company: ReportCell | null; par: ReportCell | null; cost: ReportCell | null; fairValue: ReportCell | null };
}

export interface ReportSchedule {
  date: string | null;
  title: string;
  pages: number[];
  scale: number;
  rows: ScheduleRow[];
}

export type ReportCheckResult = 'Ties' | 'Break' | 'Missing';

export interface ReportCheck {
  id: string;
  label: string;
  /** What the report prints. */
  reported: number | null;
  /** What its parts add up to. */
  computed: number | null;
  difference: number | null;
  /** Differences up to this are rounding: each printed figure is rounded on its own. */
  tolerance: number;
  result: ReportCheckResult;
  where: string;
  page: number | null;
}

export interface FinancialReport {
  entityName: string | null;
  /** 10-Q, 10-K, or null when the report does not say. */
  form: string | null;
  /** The date of the latest balance sheet column. */
  periodEnd: string | null;
  /** The date of the balance sheet column it is compared with. */
  comparativeDate: string | null;
  statements: ReportStatement[];
  schedules: ReportSchedule[];
  checks: ReportCheck[];
}

/* ------------------------------------------------------------------ text */

interface Frag extends PdfFragment {
  page: number;
}

interface Row {
  page: number;
  baseline: number;
  top: number;
  frags: Frag[];
  text: string;
}

const STATEMENT_TITLES: Array<[ReportStatementKind, RegExp]> = [
  ['CHANGES', /statements? of changes in net assets/],
  ['BALANCE_SHEET', /statements? of assets and liabilities|balance sheets?|statements? of financial (condition|position)|statements? of net assets/],
  ['OPERATIONS', /statements? of operations|statements? of income|income statements?/],
  ['CASH_FLOWS', /statements? of cash flows/],
];

const SCHEDULE_TITLE = /schedules? of investments/;

/** A title row says only the title: "Consolidated Statements of Operations", "(continued)" at most. */
function titleOf(text: string, pattern: RegExp): boolean {
  const clean = text.toLowerCase().replace(/[–—-]\s*continued|\(continued\)|\(unaudited\)/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = clean.replace(/^((consolidated|combined|condensed)\s+)+/, '');
  const match = stripped.match(pattern);
  return Boolean(match && match.index === 0 && stripped.length - match[0].length <= 2);
}

/**
 * One run of text can hold several amounts ("$ 2,868,101 $ 2,815,947") or an
 * amount and the next column's dollar sign ("5,698 $"). Each amount becomes a
 * run of its own, placed by its share of the characters, so it lines up under
 * its own column. Footnote marks such as "(4) (5)" are left whole.
 */
export function splitAmountRuns(frag: PdfFragment): PdfFragment[] {
  const text = frag.text;
  if (!/[$€£]/.test(text) && !/\d[,.]\d.*\s+\(?\$?\d[\d,]*[,.]\d/.test(text)) return [frag];
  const tokens = [...text.matchAll(/\S+/g)];
  if (tokens.length < 2) return [frag];
  const amounts = tokens.filter((token) => !/^[$€£]$/.test(token[0]));
  if (!amounts.length || !amounts.every((token) => parseReportAmount(token[0]) != null)) return [frag];
  if (amounts.length === 1 && amounts[0][0].length === text.trim().length) return [frag];
  const perChar = frag.w / Math.max(1, text.length);
  return amounts.map((token) => ({
    ...frag,
    text: token[0],
    x: frag.x + (token.index ?? 0) * perChar,
    w: token[0].length * perChar,
  }));
}

function rowsOf(page: PdfPageFragments): Row[] {
  const frags: Frag[] = page.fragments
    .filter((frag) => frag.text.trim() && frag.x >= 0 && frag.x < page.width && frag.y >= 0 && frag.y < page.height)
    .flatMap(splitAmountRuns)
    .map((frag) => ({ ...frag, page: page.page }));
  frags.sort((left, right) => (left.y + left.h) - (right.y + right.h) || left.x - right.x);
  const rows: Row[] = [];
  for (const frag of frags) {
    const baseline = frag.y + frag.h;
    const row = rows.length ? rows[rows.length - 1] : null;
    if (row && Math.abs(row.baseline - baseline) <= 2.5) {
      row.frags.push(frag);
      row.top = Math.min(row.top, frag.y);
    } else {
      rows.push({ page: page.page, baseline, top: frag.y, frags: [frag], text: '' });
    }
  }
  for (const row of rows) {
    row.frags.sort((left, right) => left.x - right.x);
    row.text = row.frags.map((frag) => frag.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
  }
  return rows;
}

const cellOf = (frag: Frag): ReportCell => ({
  page: frag.page,
  x: round2(frag.x),
  y: round2(frag.y),
  w: round2(frag.w),
  h: round2(frag.h),
});

const round2 = (value: number) => Math.round(value * 100) / 100;

function spanCell(frags: Frag[]): ReportCell | null {
  if (!frags.length) return null;
  const x = Math.min(...frags.map((frag) => frag.x));
  const y = Math.min(...frags.map((frag) => frag.y));
  const right = Math.max(...frags.map((frag) => frag.x + frag.w));
  const bottom = Math.max(...frags.map((frag) => frag.y + frag.h));
  return { page: frags[0].page, x: round2(x), y: round2(y), w: round2(right - x), h: round2(bottom - y) };
}

/** A printed amount: 1,234 or (1,234) or — for nothing. Dollar signs and percent signs are dropped. */
export function parseReportAmount(text: string): number | null {
  let value = text.replace(/[$€£]/g, '').replace(/\s+/g, '').replace(/−/g, '-').trim();
  if (!value) return null;
  if (/^[—–-]+%?$/.test(value)) return 0;
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  if (value.startsWith('-')) {
    negative = !negative;
    value = value.slice(1);
  }
  value = value.replace(/%$/, '');
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(value)) return null;
  const amount = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  return negative ? -amount : amount;
}

const isDollarSign = (text: string) => /^[$€£]$/.test(text.trim());

function scaleOf(text: string): number {
  const lower = text.toLowerCase();
  if (/in millions/.test(lower)) return 1_000_000;
  if (/in thousands|\(000'?s\)|in \$000/.test(lower)) return 1000;
  return 1;
}

/** Share counts and per-share amounts are printed in units. */
export function isUnscaledLine(label: string): boolean {
  return /\b(shares|units) outstanding\b|\bper (common )?(share|unit)\b/i.test(label);
}

const MONTH_WORDS: Record<string, number> = { one: 1, three: 3, six: 6, nine: 9, twelve: 12 };

/** How many months a column covers, from its heading. Null for a balance at a date. */
export function columnMonths(label: string): number | null {
  const lower = label.toLowerCase();
  const words = lower.match(/\b(one|three|six|nine|twelve)\s+months?\b/);
  if (words) return MONTH_WORDS[words[1]];
  const digits = lower.match(/\b(\d{1,2})\s+months?\b/);
  if (digits) return Number(digits[1]);
  if (/\b(year|fiscal year|years) ended\b/.test(lower)) return 12;
  if (/\bquarter ended\b/.test(lower)) return 3;
  return null;
}

/* ------------------------------------------------------------ statements */

interface Column {
  left: number;
  right: number;
  center: number;
}

interface RawLine {
  label: string;
  x: number;
  values: Array<number | null>;
  cells: Array<ReportCell | null>;
  hasAmounts: boolean;
  page: number;
  labelFrags: Frag[];
}

interface PageStatement {
  kind: ReportStatementKind;
  title: string;
  page: number;
  scaleText: string;
  entityName: string | null;
  columns: ReportColumn[];
  lines: ReportLine[];
}

function isTitleBlockText(text: string): boolean {
  const lower = text.toLowerCase();
  return /^\(?\s*(unaudited|audited)\s*\)?$/.test(lower)
    || /in (thousands|millions)|except (share|per share|unit)/.test(lower)
    || /^\(?\s*continued\s*\)?$/.test(lower);
}

/** Columns of amounts on a page: the right edges amounts line up on. */
function amountColumns(rows: Row[], minX: number): Column[] {
  const edges: Array<{ left: number; right: number }> = [];
  for (const row of rows) {
    for (const frag of row.frags) {
      if (frag.x < minX || parseReportAmount(frag.text) == null || /\d\/\d/.test(frag.text)) continue;
      edges.push({ left: frag.x, right: frag.x + frag.w });
    }
  }
  edges.sort((left, right) => left.right - right.right);
  const groups: Array<Array<{ left: number; right: number }>> = [];
  for (const edge of edges) {
    const group = groups[groups.length - 1];
    if (group && edge.right - group[group.length - 1].right <= 14) group.push(edge);
    else groups.push([edge]);
  }
  return groups
    .filter((group) => group.length >= 2)
    .map((group) => {
      const rights = group.map((edge) => edge.right).sort((left, right) => left - right);
      const right = rights[Math.floor(rights.length / 2)];
      const left = Math.min(...group.map((edge) => edge.left));
      return { left, right, center: (left + right) / 2 };
    });
}

function nearestColumn(columns: Column[], right: number): number {
  let best = -1;
  let distance = Number.POSITIVE_INFINITY;
  columns.forEach((column, index) => {
    const gap = Math.abs(column.right - right);
    if (gap < distance) {
      distance = gap;
      best = index;
    }
  });
  return distance <= 25 ? best : -1;
}

/** Headings above the amounts. An upper heading spans every column it sits over. */
function columnLabels(headerRows: Row[], columns: Column[]): string[] {
  const parts: string[][] = columns.map(() => []);
  const spacing = columns.length > 1
    ? Math.min(...columns.slice(1).map((column, index) => column.center - columns[index].center))
    : 120;
  headerRows.forEach((row, rowIndex) => {
    const lowest = rowIndex === headerRows.length - 1;
    for (const frag of row.frags) {
      const text = frag.text.trim();
      if (!text || isTitleBlockText(text)) continue;
      if (lowest) {
        const center = frag.x + frag.w / 2;
        let best = 0;
        columns.forEach((column, index) => {
          if (Math.abs(column.center - center) < Math.abs(columns[best].center - center)) best = index;
        });
        parts[best].push(text);
        continue;
      }
      const from = frag.x - spacing / 2;
      const to = frag.x + frag.w + spacing / 2;
      columns.forEach((column, index) => {
        if (column.center >= from && column.center <= to) parts[index].push(text);
      });
    }
  });
  return parts.map((words) => words.join(' ').replace(/\s+/g, ' ').trim());
}

/** The second line of a wrapped label: it starts in lower case or with "$" or "(", or the first is cut mid-phrase. */
function continues(first: string, next: string): boolean {
  const a = first.trim();
  const b = next.trim();
  if (!a || a.endsWith(':')) return false;
  if (!b) return true;
  if (/^[a-z$(]/.test(b)) return true;
  if ((a.match(/\(/g) || []).length > (a.match(/\)/g) || []).length) return true;
  return /(\b(and|of|the|at|in|for|from|to|on|by|net|or|resulting)|[,/&-])$/i.test(a);
}

const isFooter = (row: Row, height: number) => /see (the )?accompanying notes/i.test(row.text)
  || (row.baseline > height * 0.9 && /^\d{1,3}$/.test(row.text));

function parseStatementPage(page: PdfPageFragments, rows: Row[], titleIndex: number, kind: ReportStatementKind): PageStatement | null {
  const title = rows[titleIndex].text;
  let cursor = titleIndex + 1;
  const scaleParts: string[] = [];
  while (cursor < rows.length && isTitleBlockText(rows[cursor].text)) {
    scaleParts.push(rows[cursor].text);
    cursor += 1;
  }
  const above = rows.slice(Math.max(0, titleIndex - 3), titleIndex).map((row) => row.text);
  for (const text of above) if (isTitleBlockText(text)) scaleParts.push(text);
  const entityName = [...above].reverse().find((text) => !isTitleBlockText(text) && !/^item\s+\d/i.test(text) && /[a-z]/i.test(text) && text.length < 120) || null;

  const body = rows.slice(cursor).filter((row) => !isFooter(row, page.height));
  const columns = amountColumns(body, page.width * 0.33);
  if (!columns.length) return null;
  const zoneStart = Math.min(...columns.map((column) => column.left)) - 6;

  // Rows above the first label are the column headings.
  const firstBody = body.findIndex((row) => row.frags.some((frag) => frag.x + frag.w <= zoneStart && !isTitleBlockText(frag.text)));
  if (firstBody < 0) return null;
  const headerRows = body.slice(0, firstBody);
  const labels = columnLabels(headerRows, columns);
  const reportColumns: ReportColumn[] = labels.map((label) => ({ label, date: findDate(label), months: columnMonths(label) }));

  const scale = scaleOf(scaleParts.join(' '));
  const raws: RawLine[] = [];
  for (const row of body.slice(firstBody)) {
    const labelFrags = row.frags.filter((frag) => frag.x + frag.w <= zoneStart + 2 && !isDollarSign(frag.text));
    const label = labelFrags.map((frag) => frag.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
    const values: Array<number | null> = columns.map(() => null);
    const cells: Array<ReportCell | null> = columns.map(() => null);
    let hasAmounts = false;
    for (const frag of row.frags) {
      if (labelFrags.includes(frag)) continue;
      const amount = parseReportAmount(frag.text);
      if (amount == null) continue;
      const index = nearestColumn(columns, frag.x + frag.w);
      if (index < 0) continue;
      values[index] = amount;
      cells[index] = cellOf(frag);
      hasAmounts = true;
    }
    if (!label && !hasAmounts) continue;
    raws.push({ label, x: labelFrags[0]?.x ?? zoneStart, values, cells, hasAmounts, page: page.page, labelFrags });
  }

  // Wrapped labels and headings.
  const merged: Array<RawLine & { header: boolean }> = [];
  let pending: RawLine | null = null;
  const flush = () => {
    if (pending) merged.push({ ...pending, header: true });
    pending = null;
  };
  for (const raw of raws) {
    if (!raw.hasAmounts) {
      if (pending) {
        const open: RawLine = pending;
        if (continues(open.label, raw.label)) {
          pending = { ...open, label: `${open.label} ${raw.label}`, labelFrags: [...open.labelFrags, ...raw.labelFrags] };
          continue;
        }
        flush();
        pending = raw;
        continue;
      }
      const last = merged[merged.length - 1];
      if (last && !last.header && last.hasAmounts && /^[a-z(]/.test(raw.label) && raw.x >= last.x - 2) {
        last.label = `${last.label} ${raw.label}`;
        last.labelFrags = [...last.labelFrags, ...raw.labelFrags];
        continue;
      }
      pending = raw;
      continue;
    }
    if (pending) {
      const open: RawLine = pending;
      if (!raw.label || continues(open.label, raw.label)) {
        merged.push({ ...raw, label: `${open.label} ${raw.label}`.trim(), x: open.x, labelFrags: [...open.labelFrags, ...raw.labelFrags], header: false });
        pending = null;
        continue;
      }
      flush();
    }
    merged.push({ ...raw, header: false });
  }
  flush();

  // Which heading each line sits under. A heading holds the lines indented at least as far as its first one.
  const stack: Array<{ text: string; x: number; childX: number | null }> = [];
  const lines: ReportLine[] = [];
  for (const line of merged) {
    if (line.header) {
      while (stack.length && stack[stack.length - 1].x >= line.x - 1) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent && parent.childX == null) parent.childX = line.x;
      stack.push({ text: line.label.replace(/:\s*$/, '').trim(), x: line.x, childX: null });
    } else {
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.childX == null) top.childX = line.x;
        if (line.x < top.childX - 1.5) stack.pop();
        else break;
      }
    }
    const section = line.header ? (stack.length > 1 ? stack[stack.length - 2].text : '') : (stack[stack.length - 1]?.text ?? '');
    const unscaled = isUnscaledLine(line.label);
    lines.push({
      label: line.label.replace(/:\s*$/, '').replace(/\s+/g, ' ').trim(),
      section,
      header: line.header,
      values: line.values.map((value) => (value == null ? null : unscaled ? value : Math.round(value * scale * 100) / 100)),
      cells: line.cells,
      unscaled,
      page: line.page,
      labelCell: spanCell(line.labelFrags),
    });
  }
  return { kind, title, page: page.page, scaleText: scaleParts.join(' '), entityName, columns: reportColumns, lines };
}

/* -------------------------------------------------------------- schedule */

interface ScheduleAnchors {
  /** Text left of this is the company. */
  companyEnd: number;
  /** Boundaries between the text columns: footnotes | reference | rate | maturity. */
  referenceFrom: number;
  rateFrom: number;
  maturityFrom: number;
  /** Amounts to the right of this are par, cost, fair value, or percent of net assets. */
  amountsFrom: number;
  /** The right edges amounts line up on. */
  par: number;
  cost: number;
  fairValue: number;
  pct: number | null;
  headerBottom: number;
}

/**
 * The columns of a schedule page, from its headings. A heading can be stacked
 * over two or three rows ("Par" / "Amount" / "/Units") or split along one
 * ("Cost" "(3)"), so each one is widened to every heading run under or beside it.
 */
function scheduleAnchors(rows: Row[], height: number): ScheduleAnchors | null {
  const top = rows.filter((row) => row.baseline < height * 0.45);
  const runs = top.flatMap((row) => row.frags);
  const find = (pattern: RegExp): Frag | null => runs.find((frag) => pattern.test(frag.text.trim())) ?? null;
  const footnotes = find(/^footnotes?$/i);
  const fair = find(/^fair(\s*value)?\b/i);
  const cost = find(/^(amortized\s+)?cost\b/i);
  const par = find(/^par\b|par\s*amount|^principal\b/i);
  const maturity = find(/^maturity\b/i);
  if (!fair || !cost || !par || !(footnotes || maturity)) return null;
  const reference = find(/reference\s+rate|^spread\b/i);
  const rate = find(/^interest$|^interest\s+rate|^coupon/i);
  const pct = find(/%\s*of\s*net|^% of$/i);
  const anchors = [footnotes, fair, cost, par, maturity, reference, rate, pct].filter((frag): frag is Frag => Boolean(frag));
  const headerRows = top.filter((row) => row.frags.some((frag) => anchors.includes(frag)));
  const first = Math.min(...headerRows.map((row) => row.baseline));
  const headerBottom = Math.max(...headerRows.map((row) => row.baseline));
  const band = runs.filter((frag) => frag.y + frag.h >= first - 14 && frag.y + frag.h <= headerBottom + 1);
  const widen = (frag: Frag | null): [number, number] | null => {
    if (!frag) return null;
    let left = frag.x;
    let right = frag.x + frag.w;
    for (let pass = 0; pass < 2; pass += 1) {
      for (const other of band) {
        const overlaps = other.x < right && other.x + other.w > left;
        const beside = Math.abs((other.y + other.h) - (frag.y + frag.h)) < 3 && other.x >= right - 1 && other.x - right < 10 && /^\(\d+\)$/.test(other.text.trim());
        if (overlaps || beside) {
          left = Math.min(left, other.x);
          right = Math.max(right, other.x + other.w);
        }
      }
    }
    return [left, right];
  };
  const fn = widen(footnotes);
  const ref = widen(reference);
  const rt = widen(rate);
  const mat = widen(maturity);
  const parSpan = widen(par)!;
  const costSpan = widen(cost)!;
  const fairSpan = widen(fair)!;
  const pctSpan = widen(pct);
  const textColumns = [fn, ref, rt, mat].filter((span): span is [number, number] => Boolean(span));
  const between = (left: [number, number] | null, right: [number, number] | null, fallback: number) => (left && right ? (left[1] + right[0]) / 2 : fallback);
  const companyEnd = Math.min(...textColumns.map((span) => span[0])) - 3;
  const maturityFrom = between(rt, mat, mat ? mat[0] - 4 : parSpan[0] - 60);
  return {
    companyEnd,
    referenceFrom: between(fn, ref ?? rt, ref ? ref[0] - 4 : (rt ? rt[0] - 4 : companyEnd)),
    rateFrom: between(ref, rt, rt ? rt[0] - 4 : maturityFrom),
    maturityFrom,
    amountsFrom: mat ? (mat[1] + parSpan[0]) / 2 : parSpan[0] - 40,
    par: parSpan[1],
    cost: costSpan[1],
    fairValue: fairSpan[1],
    pct: pctSpan ? pctSpan[1] : null,
    headerBottom,
  };
}

/** Amounts are printed right-aligned a little past their heading. Move each column to where its amounts line up. */
function snapAmountColumns(anchors: ScheduleAnchors, body: Row[]): ScheduleAnchors {
  const rights: number[] = [];
  for (const row of body) {
    for (const frag of row.frags) {
      if (frag.x + frag.w / 2 < anchors.amountsFrom || /\d\/\d/.test(frag.text) || parseReportAmount(frag.text) == null) continue;
      rights.push(frag.x + frag.w);
    }
  }
  rights.sort((left, right) => left - right);
  const clusters: number[][] = [];
  for (const right of rights) {
    const last = clusters[clusters.length - 1];
    if (last && right - last[last.length - 1] <= 8) last.push(right);
    else clusters.push([right]);
  }
  const edges = clusters.filter((cluster) => cluster.length >= 3).map((cluster) => cluster[Math.floor(cluster.length / 2)]);
  const snap = (edge: number) => {
    const near = edges.filter((candidate) => Math.abs(candidate - edge) <= 30).sort((left, right) => Math.abs(left - edge) - Math.abs(right - edge));
    return near.length ? near[0] : edge;
  };
  return { ...anchors, par: snap(anchors.par), cost: snap(anchors.cost), fairValue: snap(anchors.fairValue), pct: anchors.pct == null ? null : snap(anchors.pct) };
}

type ScheduleCell = 'par' | 'cost' | 'fairValue' | 'pct';

interface RawScheduleRow {
  company: string;
  companyFrags: Frag[];
  footnotes: string;
  reference: string;
  rate: string;
  maturity: string | null;
  currency: string;
  amounts: Partial<Record<ScheduleCell, { value: number; cell: ReportCell }>>;
  page: number;
}

const DATE_TEXT = /\d{1,2}\/\d{1,2}\/\d{2,4}/;

function readScheduleRow(row: Row, anchors: ScheduleAnchors): RawScheduleRow {
  const out: RawScheduleRow = { company: '', companyFrags: [], footnotes: '', reference: '', rate: '', maturity: null, currency: '', amounts: {}, page: row.page };
  const numeric: Array<[ScheduleCell, number]> = [['par', anchors.par], ['cost', anchors.cost], ['fairValue', anchors.fairValue]];
  if (anchors.pct != null) numeric.push(['pct', anchors.pct]);
  const parts = { footnotes: [] as string[], reference: [] as string[], rate: [] as string[] };
  for (const frag of row.frags) {
    const text = frag.text.trim();
    if (!text || isDollarSign(text)) continue;
    const center = frag.x + frag.w / 2;
    if (frag.x + frag.w <= anchors.companyEnd + 2 || frag.x < anchors.companyEnd - 20) {
      out.company = `${out.company} ${text}`.trim();
      out.companyFrags.push(frag);
      continue;
    }
    if (/^[A-Z]{3}$/.test(text) && center < anchors.par) {
      out.currency = text;
      continue;
    }
    const dated = text.match(DATE_TEXT);
    if (dated && center >= anchors.rateFrom) {
      out.maturity = findDate(dated[0]);
      const rest = text.replace(DATE_TEXT, '').trim();
      if (/^[A-Z]{3}$/.test(rest)) out.currency = rest;
      continue;
    }
    const amount = parseReportAmount(text);
    if (amount != null && center >= anchors.amountsFrom) {
      const right = frag.x + frag.w;
      let best: ScheduleCell | null = null;
      let distance = Number.POSITIVE_INFINITY;
      for (const [key, edge] of numeric) {
        const gap = Math.abs(edge - right);
        if (gap < distance) {
          distance = gap;
          best = key;
        }
      }
      if (best && distance <= 24) {
        out.amounts[best] = { value: amount, cell: cellOf(frag) };
        continue;
      }
    }
    if (center < anchors.referenceFrom) parts.footnotes.push(text);
    else if (center < anchors.rateFrom) parts.reference.push(text);
    else if (center < anchors.amountsFrom) parts.rate.push(text);
  }
  out.footnotes = parts.footnotes.join(' ').trim();
  out.reference = parts.reference.join(' ').replace(/\s+%/g, '%').replace(/\s+/g, ' ').trim();
  out.rate = parts.rate.join(' ').replace(/\s+%/g, '%').trim();
  return out;
}

const normalizeName = (value: string) => value.toLowerCase().replace(/[—–-]/g, ' ').replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();

const TABLE_CAPTION = /^(investments\b|non[-\s]?controlled|controlled|affiliated|non[-\s]?affiliated)/i;
const GRAND_TOTAL = /^total (portfolio )?investments|^total investments|^investments, at fair value/i;

interface SchedulePage {
  page: number;
  date: string | null;
  title: string;
  scaleText: string;
  rows: RawScheduleRow[];
}

function parseSchedulePage(page: PdfPageFragments, rows: Row[], titleIndex: number | null, anchors: ScheduleAnchors): SchedulePage {
  let date: string | null = null;
  let title = '';
  const scaleParts: string[] = [];
  if (titleIndex != null) {
    title = rows[titleIndex].text;
    for (const row of rows.slice(titleIndex + 1, titleIndex + 4)) {
      if (!date) date = findDate(row.text);
      if (isTitleBlockText(row.text)) scaleParts.push(row.text);
    }
  }
  const body = rows.filter((row) => row.baseline > anchors.headerBottom + 1 && !isFooter(row, page.height));
  const snapped = snapAmountColumns(anchors, body);
  return { page: page.page, date, title, scaleText: scaleParts.join(' '), rows: body.map((row) => readScheduleRow(row, snapped)) };
}

function buildSchedule(pages: SchedulePage[]): ReportSchedule {
  const scale = scaleOf(pages.map((page) => page.scaleText).join(' ')) || 1;
  const raws = pages.flatMap((page) => page.rows);
  // Asset classes are the headings the schedule totals: "Total First Lien Debt".
  const classNames = new Set<string>();
  for (const raw of raws) {
    if (/^total\b/i.test(raw.company) && !GRAND_TOTAL.test(raw.company)) classNames.add(normalizeName(raw.company.replace(/^total\s+/i, '')));
  }
  const rows: ScheduleRow[] = [];
  let assetClass = '';
  let industry = '';
  let ended = false;
  let previousHeading: RawScheduleRow | null = null;
  const scaled = (value: number | undefined) => (value == null ? null : Math.round(value * scale * 100) / 100);
  for (const raw of raws) {
    if (ended) break;
    const hasAmounts = raw.amounts.cost != null || raw.amounts.fairValue != null || raw.amounts.par != null;
    const company = raw.company.replace(/\s+/g, ' ').trim();
    const base = {
      assetClass, industry, footnotes: raw.footnotes, reference: raw.reference, rate: raw.rate, maturity: raw.maturity,
      currency: raw.currency, page: raw.page,
      par: scaled(raw.amounts.par?.value), cost: scaled(raw.amounts.cost?.value), fairValue: scaled(raw.amounts.fairValue?.value),
      pctOfNetAssets: raw.amounts.pct?.value ?? null,
      cells: { company: spanCell(raw.companyFrags), par: raw.amounts.par?.cell ?? null, cost: raw.amounts.cost?.cell ?? null, fairValue: raw.amounts.fairValue?.cell ?? null },
    };
    if (company && /^total\b/i.test(company)) {
      if (GRAND_TOTAL.test(company)) {
        rows.push({ ...base, kind: 'total', company });
        if (/portfolio/i.test(company)) ended = true;
      } else {
        rows.push({ ...base, kind: 'class_total', company, assetClass: company.replace(/^total\s+/i, '') });
      }
      previousHeading = null;
      continue;
    }
    if (company && !hasAmounts && !raw.maturity) {
      if (/^\(\d+\)\s+\S/.test(company) && company.length > 40) break;
      // The rest of a name too long for its column: "(London Buyer) (Private)" under the investment it names.
      const last = rows[rows.length - 1];
      if (last && last.kind === 'investment' && !previousHeading && /^[a-z(&]/.test(company) && !classNames.has(normalizeName(company))) {
        last.company = `${last.company} ${company}`;
        if (last.cells.company && raw.companyFrags.length) last.cells.company = spanCell([...raw.companyFrags, { ...raw.companyFrags[0], ...last.cells.company, text: '' } as Frag]);
        continue;
      }
      if (classNames.has(normalizeName(company))) {
        assetClass = company;
        industry = '';
      } else if (!TABLE_CAPTION.test(company)) {
        industry = company;
      }
      previousHeading = raw;
      continue;
    }
    if (!company && hasAmounts && raw.amounts.par == null && !raw.maturity && !raw.rate) {
      rows.push({ ...base, kind: 'subtotal', company: industry });
      previousHeading = null;
      continue;
    }
    if (hasAmounts) {
      // A name too long for its column wraps: its first line was read as a heading.
      let name = company;
      if (!name && previousHeading) {
        name = previousHeading.company;
        industry = rows.length ? rows[rows.length - 1].industry : '';
      }
      rows.push({ ...base, assetClass, industry, kind: 'investment', company: name });
    }
    previousHeading = null;
  }
  return { date: pages.find((page) => page.date)?.date ?? null, title: pages.find((page) => page.title)?.title || 'Schedule of investments', pages: pages.map((page) => page.page), scale, rows };
}

/* ---------------------------------------------------------------- checks */

function check(
  id: string, label: string, reported: number | null, computed: number | null, tolerance: number, where: string, page: number | null,
): ReportCheck {
  const both = reported != null && computed != null;
  const difference = both ? Math.round((reported! - computed!) * 100) / 100 : null;
  return {
    id, label, reported, computed, difference, tolerance, where, page,
    result: !both ? 'Missing' : Math.abs(difference!) <= tolerance ? 'Ties' : 'Break',
  };
}

const sumOf = (values: Array<number | null>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

/** Each printed figure is rounded on its own, so a sum of n of them can be off by about √n units. */
const roundingTolerance = (count: number, scale: number) => Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count)))) * scale;

function longDate(iso: string | null): string {
  if (!iso) return 'undated';
  const date = new Date(`${iso}T12:00:00Z`);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** The investments line of a balance sheet column: "Total investments", or the investment lines under assets. */
export function balanceSheetInvestments(statement: ReportStatement, column: number): number | null {
  const valued = statement.lines.filter((line) => !line.header && line.values[column] != null);
  const total = valued.find((line) => /^total investments\b|^investments,? at fair value\b|^total investments at fair value/i.test(line.label));
  if (total) return total.values[column];
  const parts = valued.filter((line) => /investments\b/i.test(line.label)
    && !/receivable|payable|sold|purchased|income|unrealized|realized/i.test(line.label)
    && (/investments at fair value|^assets$/i.test(line.section) || /investments/i.test(line.section)));
  return parts.length ? sumOf(parts.map((line) => line.values[column])) : null;
}

function scheduleChecks(schedule: ReportSchedule, balanceSheet: ReportStatement | null): ReportCheck[] {
  const checks: ReportCheck[] = [];
  const when = longDate(schedule.date);
  const key = schedule.date || 'undated';
  const investments = schedule.rows.filter((row) => row.kind === 'investment');
  // Industry subtotals: the rows since the last heading, subtotal, or total.
  let block: ScheduleRow[] = [];
  let lastIndustry = '';
  let lastClass = '';
  let seq = 0;
  for (const row of schedule.rows) {
    if (row.kind === 'investment') {
      if (row.industry !== lastIndustry || row.assetClass !== lastClass) block = [];
      lastIndustry = row.industry;
      lastClass = row.assetClass;
      block.push(row);
      continue;
    }
    if (row.kind === 'subtotal') {
      seq += 1;
      const name = `${row.assetClass ? `${row.assetClass}, ` : ''}${row.company || 'subtotal'}`;
      const where = `Schedule of investments, ${when}, page ${row.page}`;
      checks.push(check(`soi:${key}:sub:${seq}:fv`, `${name}: fair value adds up`, row.fairValue, sumOf(block.map((item) => item.fairValue)), roundingTolerance(block.length, schedule.scale), where, row.page));
      checks.push(check(`soi:${key}:sub:${seq}:cost`, `${name}: cost adds up`, row.cost, sumOf(block.map((item) => item.cost)), roundingTolerance(block.length, schedule.scale), where, row.page));
      block = [];
      continue;
    }
    block = [];
  }
  for (const total of schedule.rows.filter((row) => row.kind === 'class_total')) {
    const members = investments.filter((row) => normalizeName(row.assetClass) === normalizeName(total.assetClass));
    const where = `Schedule of investments, ${when}, page ${total.page}`;
    checks.push(check(`soi:${key}:class:${normalizeName(total.assetClass)}:fv`, `${total.company}: fair value adds up`, total.fairValue, sumOf(members.map((row) => row.fairValue)), roundingTolerance(members.length, schedule.scale), where, total.page));
    checks.push(check(`soi:${key}:class:${normalizeName(total.assetClass)}:cost`, `${total.company}: cost adds up`, total.cost, sumOf(members.map((row) => row.cost)), roundingTolerance(members.length, schedule.scale), where, total.page));
  }
  const grand = [...schedule.rows].reverse().find((row) => row.kind === 'total') ?? null;
  const where = `Schedule of investments, ${when}${grand ? `, page ${grand.page}` : ''}`;
  checks.push(check(`soi:${key}:total:fv`, `Schedule of investments, ${when}: total fair value adds up`, grand?.fairValue ?? null, sumOf(investments.map((row) => row.fairValue)), roundingTolerance(investments.length, schedule.scale), where, grand?.page ?? null));
  checks.push(check(`soi:${key}:total:cost`, `Schedule of investments, ${when}: total cost adds up`, grand?.cost ?? null, sumOf(investments.map((row) => row.cost)), roundingTolerance(investments.length, schedule.scale), where, grand?.page ?? null));
  if (balanceSheet) {
    const column = balanceSheet.columns.findIndex((item) => item.months == null && item.date === schedule.date);
    if (column >= 0) {
      const line = balanceSheetInvestments(balanceSheet, column);
      checks.push(check(`soi:${key}:balance`, `Schedule of investments, ${when}: total fair value agrees with the balance sheet`, line, grand?.fairValue ?? null, schedule.scale, `Balance sheet and schedule of investments, ${when}`, balanceSheet.pages[0] ?? null));
    }
  }
  return checks;
}

/** The per-class NAV: each class's NAV per share times its shares, and the classes adding up to total net assets. */
function classChecks(statement: ReportStatement): ReportCheck[] {
  const checks: ReportCheck[] = [];
  const classes = new Map<string, { netAssets?: ReportLine; shares?: ReportLine; nav?: ReportLine }>();
  for (const line of statement.lines) {
    if (line.header || !/\bclass\b|\bseries\b/i.test(line.section)) continue;
    const entry = classes.get(line.section) || {};
    if (/^net assets$/i.test(line.label)) entry.netAssets = line;
    else if (/\b(shares|units) outstanding\b/i.test(line.label)) entry.shares = line;
    else if (/\bper (share|unit)\b/i.test(line.label)) entry.nav = line;
    classes.set(line.section, entry);
  }
  if (!classes.size) return checks;
  const total = statement.lines.find((line) => !line.header && /^total net assets$|^net assets$/i.test(line.label) && !/\bclass\b|\bseries\b/i.test(line.section));
  statement.columns.forEach((column, index) => {
    if (column.months != null) return;
    const when = longDate(column.date);
    const page = statement.pages[statement.pages.length - 1] ?? null;
    for (const [name, entry] of classes) {
      const shares = entry.shares?.values[index];
      const nav = entry.nav?.values[index];
      const netAssets = entry.netAssets?.values[index];
      if (shares == null || nav == null || netAssets == null) continue;
      // NAV per share is printed to the cent, so the product can be off by half a cent a share.
      checks.push(check(`class:${normalizeName(name)}:${column.date}`, `${name}, ${when}: NAV per share times shares equals net assets`, netAssets, Math.round(nav * shares), Math.abs(shares) * 0.005 + statement.scale, `Net asset value per share, ${when}`, entry.nav?.page ?? page));
    }
    const parts = [...classes.values()].map((entry) => entry.netAssets?.values[index] ?? null);
    if (total && parts.some((value) => value != null)) {
      checks.push(check(`class:sum:${column.date}`, `Share classes, ${when}: class net assets add up to total net assets`, total.values[index], sumOf(parts), roundingTolerance(parts.length, statement.scale), `Net asset value per share, ${when}`, page));
    }
  });
  return checks;
}

/* ------------------------------------------------------------------ read */

function mergePages(pages: PageStatement[]): ReportStatement {
  const first = pages[0];
  const columns = first.columns.map((column) => ({ ...column }));
  const lines: ReportLine[] = [];
  for (const page of pages) {
    // A later page's columns are matched to the first page's by date and span.
    const index = page.columns.map((column) => {
      const exact = columns.findIndex((item) => item.date === column.date && item.months === column.months);
      return exact >= 0 ? exact : columns.findIndex((item) => item.label === column.label);
    });
    for (const line of page.lines) {
      const values = columns.map(() => null as number | null);
      const cells = columns.map(() => null as ReportCell | null);
      line.values.forEach((value, at) => {
        if (index[at] >= 0) {
          values[index[at]] = value;
          cells[index[at]] = line.cells[at];
        }
      });
      lines.push({ ...line, values, cells });
    }
  }
  const scale = scaleOf(pages.map((page) => page.scaleText).join(' '));
  return { kind: first.kind, title: first.title, pages: pages.map((page) => page.page), scale, columns, lines };
}

const FORM = /\bform\s+(10-q|10-k|n-csrs?|n-port)\b/i;

/**
 * Read a financial report from the positioned text of its pages. Null when the
 * pages hold fewer than two primary statements: a report needs at least a
 * balance sheet and one other statement to be read this way.
 */
export function readFinancialReport(pages: PdfPageFragments[]): FinancialReport | null {
  const found: PageStatement[] = [];
  const schedulePages: SchedulePage[][] = [];
  let form: string | null = null;
  let openSchedule: SchedulePage[] | null = null;

  for (const page of pages) {
    const rows = rowsOf(page);
    if (!rows.length) {
      openSchedule = null;
      continue;
    }
    if (!form && page.page <= 3) {
      const hit = rows.map((row) => row.text).join(' ').match(FORM);
      if (hit) form = hit[1].toUpperCase();
    }
    const topRows = rows.filter((row) => row.baseline < page.height * 0.3);
    const titleIndex = rows.findIndex((row) => topRows.includes(row) && STATEMENT_TITLES.some(([, pattern]) => titleOf(row.text, pattern)));
    const scheduleTitle = rows.findIndex((row) => topRows.includes(row) && titleOf(row.text, SCHEDULE_TITLE));

    if (scheduleTitle >= 0 || openSchedule) {
      const anchors = scheduleAnchors(rows, page.height);
      if (anchors) {
        const parsed = parseSchedulePage(page, rows, scheduleTitle >= 0 ? scheduleTitle : null, anchors);
        if (scheduleTitle >= 0 && (!openSchedule || (parsed.date && openSchedule[0]?.date && parsed.date !== openSchedule[0].date))) {
          openSchedule = [];
          schedulePages.push(openSchedule);
        }
        openSchedule!.push(parsed);
        if (parsed.rows.some((row) => /^total portfolio investments/i.test(row.company))) openSchedule = null;
        continue;
      }
      openSchedule = null;
    }

    if (titleIndex >= 0) {
      const kind = STATEMENT_TITLES.find(([, pattern]) => titleOf(rows[titleIndex].text, pattern))![0];
      const parsed = parseStatementPage(page, rows, titleIndex, kind);
      if (parsed) found.push(parsed);
    }
  }

  // Consecutive pages of one statement are one statement.
  const statements: ReportStatement[] = [];
  let group: PageStatement[] = [];
  const close = () => {
    if (group.length) statements.push(mergePages(group));
    group = [];
  };
  for (const page of found) {
    const last = group[group.length - 1];
    if (last && (last.kind !== page.kind || page.page !== last.page + 1)) close();
    group.push(page);
  }
  close();
  // Keep the first run of each kind: later ones are notes or a repeat.
  const primary: ReportStatement[] = [];
  for (const statement of statements) if (!primary.some((item) => item.kind === statement.kind)) primary.push(statement);
  if (primary.length < 2 || !primary.some((statement) => statement.kind === 'BALANCE_SHEET')) return null;

  const balanceSheet = primary.find((statement) => statement.kind === 'BALANCE_SHEET') ?? null;
  const points = balanceSheet ? balanceSheet.columns.filter((column) => column.months == null && column.date) : [];
  const dates = [...new Set(points.map((column) => column.date!))].sort();
  const periodEnd = dates.length ? dates[dates.length - 1] : null;
  const comparativeDate = dates.length > 1 ? dates[dates.length - 2] : null;

  const schedules = schedulePages.filter((list) => list.length).map(buildSchedule).filter((schedule) => schedule.rows.length > 0);
  const entityName = found.find((page) => page.entityName)?.entityName ?? null;
  const checks = [
    ...(balanceSheet ? classChecks(balanceSheet) : []),
    ...schedules.flatMap((schedule) => scheduleChecks(schedule, balanceSheet)),
  ];
  return { entityName, form, periodEnd, comparativeDate, statements: primary, schedules, checks };
}

/* ---------------------------------------------------------------- tables */

/** Ids of the tables the reader stores on a file. Load data shows them; the NAV loader reads them back. */
export const REPORT_TABLE: Record<ReportStatementKind, string> = {
  BALANCE_SHEET: 'report-balance-sheet',
  OPERATIONS: 'report-operations',
  CHANGES: 'report-changes',
  CASH_FLOWS: 'report-cash-flows',
};
export const REPORT_SCHEDULE_TABLE = 'report-schedule';
export const REPORT_CHECKS_TABLE = 'report-checks';
export const REPORT_ABOUT_TABLE = 'report-about';

const STATEMENT_NAMES: Record<ReportStatementKind, string> = {
  BALANCE_SHEET: 'Statement of assets and liabilities',
  OPERATIONS: 'Statement of operations',
  CHANGES: 'Statement of changes in net assets',
  CASH_FLOWS: 'Statement of cash flows',
};

export interface ReportTable {
  id: string;
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  /** Same shape as rows by headers. */
  locations: Array<Array<(ReportCell & { precision: 'cell' | 'row' }) | null>>;
  /** Page sizes, so a screen can draw a page and box a cell on it. */
  pages?: Array<{ page: number; width: number; height: number }>;
}

const LINE = 'Line';
const SECTION = 'Section';
const KIND = 'Kind';
const SCHEDULE_HEADERS = ['Row', 'Asset class', 'Industry', 'Company', 'Footnotes', 'Reference rate and spread', 'Interest rate', 'Maturity', 'Currency', 'Par amount', 'Cost', 'Fair value', '% of net assets'] as const;
const CHECK_HEADERS = ['Check', 'Where', 'Reported', 'Computed', 'Difference', 'Result', 'Id'] as const;
const ROW_KIND: Record<ScheduleRowKind, string> = { investment: 'Investment', subtotal: 'Industry subtotal', class_total: 'Class total', total: 'Total' };

const textOf = (value: number | null | undefined) => (value == null ? '' : String(value));
const located = (cell: ReportCell | null | undefined, precision: 'cell' | 'row' = 'cell') => (cell ? { ...cell, precision } : null);

function uniqueLabels(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = (seen.get(label) || 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label} (${count})`;
  });
}

/** The report as tables: one per statement, one per schedule, the report's own checks, and what the report is. */
export function reportTables(report: FinancialReport, pageSizes: Array<{ page: number; width: number; height: number }> = []): ReportTable[] {
  const tables: ReportTable[] = [];
  const pagesOf = (pages: number[]) => pageSizes.filter((size) => pages.includes(size.page));
  for (const statement of report.statements) {
    const columns = uniqueLabels(statement.columns.map((column, index) => column.label || `Column ${index + 1}`));
    const headers = [LINE, SECTION, KIND, ...columns];
    tables.push({
      id: REPORT_TABLE[statement.kind],
      name: STATEMENT_NAMES[statement.kind],
      headers,
      rows: statement.lines.map((line) => ({
        [LINE]: line.label,
        [SECTION]: line.section,
        [KIND]: line.header ? 'Heading' : line.unscaled ? 'Units' : 'Amount',
        ...Object.fromEntries(columns.map((column, index) => [column, textOf(line.values[index])])),
      })),
      locations: statement.lines.map((line) => [located(line.labelCell), null, null, ...line.cells.map((cell) => located(cell))]),
      pages: pagesOf(statement.pages),
    });
  }
  report.schedules.forEach((schedule, index) => {
    tables.push({
      id: `${REPORT_SCHEDULE_TABLE}-${schedule.date || index + 1}`,
      name: `Schedule of investments, ${longDate(schedule.date)}`,
      headers: [...SCHEDULE_HEADERS],
      rows: schedule.rows.map((row) => ({
        Row: ROW_KIND[row.kind],
        'Asset class': row.assetClass,
        Industry: row.industry,
        Company: row.company,
        Footnotes: row.footnotes,
        'Reference rate and spread': row.reference,
        'Interest rate': row.rate,
        Maturity: row.maturity || '',
        Currency: row.currency,
        'Par amount': textOf(row.par),
        Cost: textOf(row.cost),
        'Fair value': textOf(row.fairValue),
        '% of net assets': textOf(row.pctOfNetAssets),
      })),
      locations: schedule.rows.map((row) => [null, null, null, located(row.cells.company), null, null, null, null, null, located(row.cells.par), located(row.cells.cost), located(row.cells.fairValue), null]),
      pages: pagesOf(schedule.pages),
    });
  });
  if (report.checks.length) {
    tables.push({
      id: REPORT_CHECKS_TABLE,
      name: 'Checks the report makes of itself',
      headers: [...CHECK_HEADERS],
      rows: report.checks.map((item) => ({
        Check: item.label, Where: item.where, Reported: textOf(item.reported), Computed: textOf(item.computed), Difference: textOf(item.difference), Result: item.result, Id: item.id,
      })),
      locations: report.checks.map(() => [null, null, null, null, null, null, null]),
    });
  }
  const about: Array<[string, string]> = [
    ['Entity', report.entityName || ''],
    ['Form', report.form || ''],
    ['Period end', report.periodEnd || ''],
    ['Comparative date', report.comparativeDate || ''],
  ];
  tables.push({ id: REPORT_ABOUT_TABLE, name: 'About the report', headers: ['Field', 'Value'], rows: about.map(([Field, Value]) => ({ Field, Value })), locations: about.map(() => [null, null]) });
  return tables;
}

const STATEMENT_BY_TABLE = new Map(Object.entries(REPORT_TABLE).map(([kind, id]) => [id, kind as ReportStatementKind]));

interface StoredTable {
  id: string;
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  locations?: Array<Array<{ page: number; x: number; y: number; w: number; h: number } | null>>;
}

const numberOf = (value: string | undefined): number | null => {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const cellFrom = (cell: { page: number; x: number; y: number; w: number; h: number } | null | undefined): ReportCell | null => (cell ? { page: cell.page, x: cell.x, y: cell.y, w: cell.w, h: cell.h } : null);

/** The report again, from the tables stored on a file. Null when the file was not read as a report. */
export function reportFromTables(tables: StoredTable[]): FinancialReport | null {
  const statements: ReportStatement[] = [];
  const schedules: ReportSchedule[] = [];
  const checks: ReportCheck[] = [];
  const about = new Map<string, string>();
  for (const table of tables) {
    const kind = STATEMENT_BY_TABLE.get(table.id);
    if (kind) {
      const columnHeaders = table.headers.slice(3);
      statements.push({
        kind,
        title: table.name,
        pages: [...new Set((table.locations || []).flat().filter(Boolean).map((cell) => cell!.page))].sort((a, b) => a - b),
        scale: 1,
        columns: columnHeaders.map((label) => {
          const clean = label.replace(/ \(\d+\)$/, '');
          return { label: clean, date: findDate(clean), months: columnMonths(clean) };
        }),
        lines: table.rows.map((row, rowIndex) => ({
          label: row[LINE] || '',
          section: row[SECTION] || '',
          header: row[KIND] === 'Heading',
          unscaled: row[KIND] === 'Units',
          values: columnHeaders.map((header) => numberOf(row[header])),
          cells: columnHeaders.map((_, index) => cellFrom(table.locations?.[rowIndex]?.[index + 3])),
          labelCell: cellFrom(table.locations?.[rowIndex]?.[0]),
          page: cellFrom(table.locations?.[rowIndex]?.[0])?.page ?? 0,
        })),
      });
      continue;
    }
    if (table.id.startsWith(REPORT_SCHEDULE_TABLE)) {
      const kinds = new Map(Object.entries(ROW_KIND).map(([key, label]) => [label, key as ScheduleRowKind]));
      const date = table.id.slice(REPORT_SCHEDULE_TABLE.length + 1);
      schedules.push({
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : findDate(table.name),
        title: table.name,
        pages: [...new Set((table.locations || []).flat().filter(Boolean).map((cell) => cell!.page))].sort((a, b) => a - b),
        scale: 1,
        rows: table.rows.map((row, rowIndex) => ({
          kind: kinds.get(row.Row) || 'investment',
          assetClass: row['Asset class'] || '',
          industry: row.Industry || '',
          company: row.Company || '',
          footnotes: row.Footnotes || '',
          reference: row['Reference rate and spread'] || '',
          rate: row['Interest rate'] || '',
          maturity: row.Maturity || null,
          currency: row.Currency || '',
          par: numberOf(row['Par amount']),
          cost: numberOf(row.Cost),
          fairValue: numberOf(row['Fair value']),
          pctOfNetAssets: numberOf(row['% of net assets']),
          page: cellFrom(table.locations?.[rowIndex]?.[3])?.page ?? 0,
          cells: {
            company: cellFrom(table.locations?.[rowIndex]?.[3]),
            par: cellFrom(table.locations?.[rowIndex]?.[9]),
            cost: cellFrom(table.locations?.[rowIndex]?.[10]),
            fairValue: cellFrom(table.locations?.[rowIndex]?.[11]),
          },
        })),
      });
      continue;
    }
    if (table.id === REPORT_CHECKS_TABLE) {
      table.rows.forEach((row, index) => {
        const reported = numberOf(row.Reported);
        const computed = numberOf(row.Computed);
        const difference = numberOf(row.Difference);
        const result = (row.Result === 'Ties' || row.Result === 'Break' ? row.Result : 'Missing') as ReportCheckResult;
        checks.push({ id: row.Id || `stored:${index}`, label: row.Check || '', where: row.Where || '', reported, computed, difference, tolerance: 0, result, page: null });
      });
      continue;
    }
    if (table.id === REPORT_ABOUT_TABLE) {
      for (const row of table.rows) about.set(row.Field, row.Value || '');
    }
  }
  if (!statements.some((statement) => statement.kind === 'BALANCE_SHEET')) return null;
  const balanceSheet = statements.find((statement) => statement.kind === 'BALANCE_SHEET')!;
  const dates = [...new Set(balanceSheet.columns.filter((column) => column.months == null && column.date).map((column) => column.date!))].sort();
  return {
    entityName: about.get('Entity') || null,
    form: about.get('Form') || null,
    periodEnd: dates.length ? dates[dates.length - 1] : null,
    comparativeDate: dates.length > 1 ? dates[dates.length - 2] : null,
    statements,
    schedules,
    checks,
  };
}
