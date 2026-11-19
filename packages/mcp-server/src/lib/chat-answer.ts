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

const CLOSED_FENCE = /```answer\s*([\s\S]*?)```/i;
const OPEN_FENCE = /```answer\s*([\s\S]*)$/i;
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

export type ChatTone = 'up' | 'down' | 'flat';

/** A cell the model marked, when the sign and the story do not agree. */
export interface TonedCell {
  text: string | number | null;
  tone: ChatTone;
}

export function isTonedCell(value: unknown): value is TonedCell {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'tone' in value && 'text' in value;
}

/** Change, variance, and growth columns carry the direction of a move. */
export function columnCarriesTone(header: string): boolean {
  return /change|variance|\bvar\b|delta|growth|trend|diff/i.test(header);
}

function toneName(value: unknown): ChatTone | null {
  return value === 'up' || value === 'down' || value === 'flat' ? value : null;
}

function signedTone(value: string | number | null): ChatTone | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (value < 0) return 'down';
    if (value > 0) return 'up';
    return 'flat';
  }
  const shown = value.trim();
  if (/^\+/.test(shown)) return 'up';
  if (/^[−-]/.test(shown) || /^\(.*\)$/.test(shown)) return 'down';
  return null;
}

/**
 * Green, red, or neutral for one cell. An explicit tone wins. Otherwise a
 * signed figure, or any figure in a Change column, supplies the direction.
 */
export function toneFor(header: string, value: unknown): ChatTone | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const marked = toneName((value as { tone?: unknown }).tone);
    if (marked) return marked;
  }
  const shown = isTonedCell(value) ? value.text : value;
  const text = typeof shown === 'string' || typeof shown === 'number' ? shown : cell(shown);
  const signed = signedTone(text);
  if (typeof text === 'string' && /^[+\-−(]/.test(text.trim())) return signed;
  if (columnCarriesTone(header)) return signed;
  return null;
}

function storedCell(value: unknown): string | number | null | TonedCell {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const bag = value as { text?: unknown; value?: unknown; v?: unknown; tone?: unknown };
    const tone = toneName(bag.tone);
    const inner = bag.text ?? bag.value ?? bag.v;
    const text = cell(inner);
    if (tone) return { text, tone };
    return text;
  }
  return cell(value);
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
    return [columns.map((_column: string, index: number) => storedCell(row[index]))];
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

function shownValue(value: unknown): unknown {
  return isTonedCell(value) ? value.text : value;
}

function fmtCell(value: unknown, header: string): string {
  const shown = shownValue(value);
  if (shown == null || shown === '') return '';
  if (typeof shown !== 'number') return String(shown).replace(/\|/g, '/');
  if (/share|weight|percent|pct/i.test(header)) return `${(Math.abs(shown) <= 1 ? shown * 100 : shown).toFixed(1)}%`;
  if (/exposure|value|amount|nav|market/i.test(header)) return fmtMoney(shown);
  return shown.toLocaleString('en-US', { maximumFractionDigits: 2 });
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

/** Reads a JSON value, closing a block the model cut off mid-object. */
function parseJsonValue(raw: string): unknown | null {
  const body = raw.trim().replace(/```[\s]*$/, '').trim();
  try {
    return JSON.parse(body);
  } catch {
    const repaired = repairJson(body);
    if (!repaired) return null;
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

/**
 * Drops a dangling key or an unclosed string, then closes the arrays and
 * objects that were still open. A finished lead and the complete cards survive.
 */
function repairJson(source: string): string | null {
  const start = source.indexOf('{');
  const list = source.indexOf('[');
  const openAt = start < 0 ? list : list < 0 ? start : Math.min(start, list);
  if (openAt < 0) return null;
  let text = source.slice(openAt);
  let inString = false;
  let escaped = false;
  let lastSafe = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        lastSafe = i + 1;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '}' || ch === ']' || ch === ',' || ch === ':') lastSafe = i + 1;
  }
  if (inString) text = text.slice(0, lastSafe);
  text = text.replace(/:\s*$/, '');
  text = text.replace(/,?\s*"[^"]*"\s*$/, '');
  text = text.replace(/,\s*$/, '');

  inString = false;
  escaped = false;
  const open: string[] = [];
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') open.push(ch);
    else if ((ch === '}' || ch === ']') && open.length) open.pop();
  }
  if (inString) return null;
  while (open.length) text += open.pop() === '{' ? '}' : ']';
  return text;
}

/** Pulls one answer block out of an assistant message. The prose is what remains. */
export function parseChatAnswer(source: string): ChatAnswer | null {
  const match = source.match(CLOSED_FENCE) || source.match(OPEN_FENCE);
  if (!match) return null;
  const parsed = parseJsonValue(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const lead = text((parsed as any).lead, 1200);
  const parsedKpis = kpis((parsed as any).kpis);
  const parsedMeters = meterGroups((parsed as any).meters);
  const parsedChart = chart((parsed as any).chart);
  const parsedTables = tablesOf(parsed);
  if (!lead && !parsedKpis.length && !parsedMeters.length && !parsedChart && !parsedTables.length) return null;
  const fence = source.match(CLOSED_FENCE) ? CLOSED_FENCE : OPEN_FENCE;
  return {
    prose: source.replace(fence, '').trim(),
    lead,
    kpis: parsedKpis,
    meters: parsedMeters,
    chart: parsedChart,
    tables: parsedTables,
  };
}

export const CHAT_ANSWER_GUIDE = `
## How to present the answer
The answer block is the entire reply. Do not write a heading, paragraph, or bullet list after it. A single number is one or two sentences and does not need a block. kpis are the headline cards, already formatted. "By A and B" is one metric crossed by both dimensions, not a total for A plus a count for B. Exposure by fund and industry is one table with groupBy "Fund": each fund is a total, and the rows under it are that fund's industry exposures. Share of fund is the industry exposure divided by the fund total. A blank industry is Unclassified and still has an exposure. Do not add a second table that only counts positions by industry. meters, when used, rank the fund totals. A chart is a trend across time, or at most eight slices. When the question asks what each allocation or exposure is, every row carries that row's amount. Names and codes alone do not answer it. Show the booked amount and the proposed amount as separate columns or groups when both were returned.

Visuals. Color the direction of a move. On a Change, variance, or growth column, write the signed figure ("+3.0%", "-$6.5M"). The screen paints an increase green and a decrease red. When a lower number is the good outcome, such as debt, leverage, or a cost, set the cell to { "text": "-4.4%", "tone": "up" } or "down" so the color follows the story rather than the sign. tone is "up", "down", or "flat".

A plot is a chart, not a second copy of the same points. When the user asks to plot, chart, graph, or show a metric over quarters or time, set chart. Use chartType "line" for a trend and "bar" for a few periods side by side. labels are the periods in order. Each series is one metric, with one value per label. At most eight points and three series. Do not repeat the plotted points as bullets or as another table.

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
  }],
  "chart": {
    "title": "Revenue by quarter",
    "chartType": "line",
    "labels": ["Q1", "Q2", "Q3", "Q4"],
    "series": [{ "name": "Revenue", "values": [40.7, 43.1, 46.4, 51.5] }]
  }
}
\`\`\`
`;
