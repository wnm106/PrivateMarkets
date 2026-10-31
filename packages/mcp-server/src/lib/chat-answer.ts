/**
 * Structured chat answers. A breakdown is a lead, headline figures, bars, and a
 * grid the panel renders — not a bullet for every row.
 */

export interface ChatKpi {
  label: string;
  value: string;
  detail?: string;
}

export interface ChatMeterItem {
  label: string;
  value: number;
  detail?: string;
  /** A limit or target, in the same units as value. Drawn as a marker on the bar. */
  marker?: number;
}

export interface ChatMeters {
  title?: string;
  format: 'currency' | 'number' | 'percent';
  items: ChatMeterItem[];
}

export interface ChatChart {
  title?: string;
  chartType: 'bar' | 'line' | 'pie';
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
}

export interface ChatTable {
  title?: string;
  columns: string[];
  rows: unknown[][];
  /** Outer dimension. Rows that share this value nest under one total. */
  groupBy?: string;
}

export interface NestedTableGroup {
  label: string;
  total: number | null;
  rows: unknown[][];
}

export interface NestedTable {
  groupIndex: number;
  valueIndex: number;
  groups: NestedTableGroup[];
}

export interface ChatAnswer {
  prose: string;
  lead: string;
  kpis: ChatKpi[];
  meters: ChatMeters[];
  chart: ChatChart | null;
  tables: ChatTable[];
}

const FENCE = /```answer\s*([\s\S]*?)```/i;
const MAX_KPIS = 4;
const MAX_METERS = 8;
const MAX_CHART = 8;
const MAX_ROWS = 200;
const MAX_COLS = 8;

function text(value: unknown, max = 180): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().slice(0, max);
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function cell(value: unknown): string | number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value.trim().slice(0, 200);
  return null;
}

function kpis(value: unknown): ChatKpi[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_KPIS).flatMap((item) => {
    const label = text(item?.label, 40);
    const figure = text(item?.value, 40);
    if (!label || !figure) return [];
    const detail = text(item?.detail, 80);
    return [{ label, value: figure, ...(detail ? { detail } : {}) }];
  });
}

function meterGroup(value: unknown): ChatMeters | null {
  if (!value || typeof value !== 'object') return null;
  const format = (value as any).format === 'number' || (value as any).format === 'percent' ? (value as any).format : 'currency';
  const items = Array.isArray((value as any).items) ? (value as any).items : [];
  const parsed = items.slice(0, MAX_METERS).flatMap((item: any) => {
    const label = text(item?.label, 80);
    const amount = num(item?.value);
    if (!label || amount == null) return [];
    const detail = text(item?.detail, 80);
    const marker = num(item?.marker);
    return [{ label, value: amount, ...(detail ? { detail } : {}), ...(marker == null ? {} : { marker }) }];
  });
  if (!parsed.length) return null;
  const title = text((value as any).title, 80);
  return { ...(title ? { title } : {}), format, items: parsed };
}

function chart(value: unknown): ChatChart | null {
  if (!value || typeof value !== 'object') return null;
  const chartType = (value as any).chartType === 'line' || (value as any).chartType === 'pie' ? (value as any).chartType : 'bar';
  const labels = Array.isArray((value as any).labels) ? (value as any).labels.map((label: unknown) => text(label, 40)).filter(Boolean).slice(0, MAX_CHART) : [];
  const series = Array.isArray((value as any).series) ? (value as any).series.slice(0, 3).flatMap((item: any) => {
    const name = text(item?.name, 40) || 'Value';
    const values = Array.isArray(item?.values) ? item.values.map(num).map((n: number | null) => n ?? 0).slice(0, labels.length) : [];
    if (!values.length) return [];
    return [{ name, values }];
  }) : [];
  if (!labels.length || !series.length) return null;
  const title = text((value as any).title, 80);
  return { ...(title ? { title } : {}), chartType, labels, series };
}

function meterGroups(value: unknown): ChatMeters[] {
  if (Array.isArray(value)) return value.map(meterGroup).filter((group): group is ChatMeters => !!group);
  const one = meterGroup(value);
  return one ? [one] : [];
}

function oneTable(value: unknown): ChatTable | null {
  if (!value || typeof value !== 'object') return null;
  const columns: string[] = Array.isArray((value as any).columns)
    ? (value as any).columns.map((column: unknown) => text(column, 40)).filter((column: string) => column.length > 0).slice(0, MAX_COLS)
    : [];
  const rows = Array.isArray((value as any).rows) ? (value as any).rows.slice(0, MAX_ROWS).flatMap((row: unknown) => {
    if (!Array.isArray(row)) return [];
    return [columns.map((_column: string, index: number) => cell(row[index]))];
  }) : [];
  if (!columns.length || !rows.length) return null;
  const title = text((value as any).title, 80);
  const groupBy = text((value as any).groupBy, 40);
  return { ...(title ? { title } : {}), ...(groupBy ? { groupBy } : {}), columns, rows };
}

function moneyColumn(columns: string[]): number {
  const named = columns.findIndex((column) => /exposure|market value|market_value|amount|nav/i.test(column) && !/share|percent|pct/i.test(column));
  if (named >= 0) return named;
  return columns.findIndex((column) => /value/i.test(column) && !/share|percent|pct/i.test(column));
}

/** Nests a crossed breakdown under its outer dimension, largest total first. */
export function nestTable(table: ChatTable): NestedTable | null {
  if (!table.groupBy) return null;
  const groupIndex = table.columns.findIndex((column) => column.toLowerCase() === table.groupBy!.toLowerCase());
  if (groupIndex < 0) return null;
  const valueIndex = moneyColumn(table.columns);
  const order: string[] = [];
  const buckets = new Map<string, unknown[][]>();
  for (const row of table.rows) {
    const label = String(row[groupIndex] ?? 'Unassigned').trim() || 'Unassigned';
    const bucket = buckets.get(label);
    if (bucket) bucket.push(row);
    else {
      buckets.set(label, [row]);
      order.push(label);
    }
  }
  const groups = order.map((label) => {
    const rows = buckets.get(label) || [];
    const amounts = valueIndex < 0 ? [] : rows.map((row) => row[valueIndex]).filter((value): value is number => typeof value === 'number');
    const total = amounts.length ? amounts.reduce((sum, value) => sum + value, 0) : null;
    const sorted = [...rows].sort((a, b) => {
      const left = valueIndex < 0 || typeof a[valueIndex] !== 'number' ? 0 : a[valueIndex] as number;
      const right = valueIndex < 0 || typeof b[valueIndex] !== 'number' ? 0 : b[valueIndex] as number;
      return right - left;
    });
    return { label, total, rows: sorted };
  });
  groups.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  return { groupIndex, valueIndex, groups };
}

function tablesOf(parsed: any): ChatTable[] {
  const many = Array.isArray(parsed.tables) ? parsed.tables.map(oneTable).filter((item: ChatTable | null): item is ChatTable => !!item) : [];
  const single = oneTable(parsed.table);
  return single ? [single, ...many] : many;
}

function fmtMoney(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtCell(value: unknown, header: string): string {
  if (value == null || value === '') return '';
  if (typeof value !== 'number') return String(value).replace(/\|/g, '/');
  if (/share|weight|percent|pct/i.test(header)) return `${(Math.abs(value) <= 1 ? value * 100 : value).toFixed(1)}%`;
  if (/exposure|value|amount|nav|market/i.test(header)) return fmtMoney(value);
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function markdownTable(headers: string[], rows: unknown[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${headers.map((header, index) => fmtCell(row[index], header)).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

/**
 * Turns an answer block into markdown the chat already renders as tables.
 * The model emits a fenced block; the screen should never show that block.
 */
export function presentAnswer(source: string): string {
  const answer = parseChatAnswer(source);
  if (!answer || (!answer.kpis.length && !answer.meters.length && !answer.tables.length && !answer.chart)) return source;
  const lines: string[] = [];
  if (answer.lead) lines.push(answer.lead, '');
  if (answer.kpis.length) {
    lines.push(markdownTable(['', ''], answer.kpis.map((kpi) => [kpi.label, `${kpi.value}${kpi.detail ? ` · ${kpi.detail}` : ''}`])), '');
  }
  for (const group of answer.meters) {
    if (group.title) lines.push(`**${group.title}**`, '');
    lines.push(markdownTable(
      ['', ''],
      group.items.map((item) => [item.label, `${fmtCell(item.value, group.format === 'currency' ? 'exposure' : group.format)}${item.detail ? ` · ${item.detail}` : ''}`]),
    ), '');
  }
  for (const table of answer.tables) {
    if (table.title) lines.push(`**${table.title}**`, '');
    const nested = nestTable(table);
    if (!nested) {
      lines.push(markdownTable(table.columns, table.rows), '');
      continue;
    }
    const detail = table.columns.map((name, index) => ({ name, index })).filter((column) => column.index !== nested.groupIndex);
    for (const group of nested.groups) {
      const total = group.total == null ? '' : ` — ${fmtMoney(group.total)}`;
      lines.push(`**${group.label}${total}**`, '');
      lines.push(markdownTable(
        detail.map((column) => column.name),
        group.rows.map((row) => detail.map((column) => {
          if (/share|weight|percent|pct/i.test(column.name) && group.total && typeof row[nested.valueIndex] === 'number') {
            return (row[nested.valueIndex] as number) / group.total;
          }
          return row[column.index];
        })),
      ), '');
    }
  }
  if (answer.chart) {
    const labels = answer.chart.labels.map((label, index) => `${label}: ${answer.chart!.series[0]?.values[index] ?? ''}`);
    lines.push(answer.chart.title || 'Chart', '', labels.join('\n'), '');
  }
  if (answer.prose) lines.push(answer.prose);
  return lines.join('\n').trim();
}

/** Pulls one answer block out of an assistant message. The prose is what remains. */
export function parseChatAnswer(source: string): ChatAnswer | null {
  const match = source.match(FENCE);
  if (!match) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const lead = text(parsed.lead, 500);
  const parsedKpis = kpis(parsed.kpis);
  const parsedMeters = meterGroups(parsed.meters);
  const parsedChart = chart(parsed.chart);
  const parsedTables = tablesOf(parsed);
  if (!lead && !parsedKpis.length && !parsedMeters.length && !parsedChart && !parsedTables.length) return null;
  return {
    prose: source.replace(FENCE, '').trim(),
    lead,
    kpis: parsedKpis,
    meters: parsedMeters,
    chart: parsedChart,
    tables: parsedTables,
  };
}

export const CHAT_ANSWER_GUIDE = `
## How to present the answer
The answer block is the entire reply. Do not write a heading, paragraph, or bullet list after it. A single number is one or two sentences and does not need a block. kpis are the headline cards, already formatted. "By A and B" is one metric crossed by both dimensions, not a total for A plus a count for B. Exposure by fund and industry is one table with groupBy "Fund": each fund is a total, and the rows under it are that fund's industry exposures. Share of fund is the industry exposure divided by the fund total. A blank industry is Unclassified and still has an exposure. Do not add a second table that only counts positions by industry. meters, when used, rank the fund totals. A chart is a trend, or at most eight slices.

\`\`\`answer
{
  "lead": "Total portfolio exposure is $15.65 billion across 6,203 positions as of October 29, 2026. No industry is recorded on the issuers, so that split is unclassified.",
  "kpis": [
    { "label": "Exposure", "value": "$15.65B", "detail": "6,203 positions" },
    { "label": "Funds", "value": "22", "detail": "65 positions with no fund" }
  ],
  "meters": {
    "title": "Exposure by fund",
    "format": "currency",
    "items": [{ "label": "Bench Fund 4", "value": 1164560000, "detail": "463 positions" }]
  },
  "tables": [{
    "title": "Exposure by fund and industry",
    "groupBy": "Fund",
    "columns": ["Fund", "Industry", "Exposure", "Share of fund"],
    "rows": [
      ["Bench Fund 4", "Software", 400000000, 0.343],
      ["Bench Fund 4", "Unclassified", 764561113, 0.657],
      ["Bench Fund 20", "Energy", 500000000, 0.482]
    ]
  }]
}
\`\`\`
`;
