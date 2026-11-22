/**
 * Pure helpers for drawing narrative blocks: number formats, axis ticks, label wrapping,
 * delta direction, sparklines, waterfall geometry and chart orientation.
 * No React here, so every rule that decides what a reader sees is unit-tested.
 */
import type { NarrativeBlock, ValueFormat, GoodDirection } from '@/lib/reporting';

type ChartBlock = Extract<NarrativeBlock, { type: 'chart' }>;

/** Categorical hues in fixed order (dataviz reference palette); a ninth series folds into "Other". */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
/** A bar or point that is not the subject of the story. */
export const MUTED = '#cbd5e1';
export const ACCENT = '#2a78d6';
export const GOOD = '#047857';
export const BAD = '#b91c1c';
export const NEUTRAL = '#64748b';

function group(n: number, decimals: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Default decimals for a format when the caller does not say. */
function defaultDecimals(format: ValueFormat | undefined, value: number): number {
  switch (format) {
    case 'bps': return 0;
    case 'multiple': return Math.abs(value) < 10 ? 2 : 1;
    case 'usd_m': case 'percent': case 'pp': return 1;
    default: return Number.isInteger(value) ? 0 : Math.abs(value) >= 100 ? 1 : 2;
  }
}

/**
 * Writes a number the way the format says. Values are already in the format's unit:
 * usd_m 1164.6 -> "$1,164.6M", percent 3.5 -> "3.5%", pp 0.6 -> "0.6 pp", bps 627 -> "627 bps", multiple 1.3 -> "1.30x".
 * signed adds "+" to positive values (for deltas).
 */
export function formatValue(value: unknown, format?: ValueFormat, opts: { signed?: boolean; decimals?: number; compact?: boolean } = {}): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  const decimals = opts.decimals ?? defaultDecimals(format, n);
  const sign = n < 0 ? '-' : opts.signed && n > 0 ? '+' : '';
  const abs = Math.abs(n);
  switch (format) {
    case 'usd_m':
      if (opts.compact && abs >= 1000) return `${sign}$${group(abs / 1000, 2)}bn`;
      return `${sign}$${group(abs, decimals)}M`;
    case 'percent': return `${sign}${group(abs, decimals)}%`;
    case 'pp': return `${sign}${group(abs, decimals)} pp`;
    case 'bps': return `${sign}${group(abs, decimals)} bps`;
    case 'multiple': return `${sign}${group(abs, decimals)}x`;
    default: return `${sign}${group(abs, decimals)}`;
  }
}

/** Clean axis ticks: 1, 2, 2.5 or 5 times a power of ten, covering [min, max] and always including zero when the data spans it. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) { max = min === 0 ? 1 : min + Math.abs(min) * 0.1; }
  const raw = (max - min) / Math.max(target, 1);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** Breaks a label into at most maxLines lines of maxChars, on word boundaries; the last line ends in "..." if it is cut. */
export function wrapLabel(text: string, maxChars: number, maxLines = 2): string[] {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars) { line = next; continue; }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const used = lines.join(' ').split(/\s+/).filter(Boolean).length;
  const cut = used < words.length;
  return lines.map((l, i) => {
    const last = i === lines.length - 1;
    if (l.length > maxChars) return `${l.slice(0, Math.max(maxChars - 1, 1))}…`;
    if (!(last && cut)) return l;
    return l.length < maxChars ? `${l}…` : `${l.slice(0, maxChars - 1)}…`;
  });
}

/** Whether a change reads as good, bad or flat, given which direction is good. Accepts numbers or text like "-0.5 pts". */
export function deltaTone(value: unknown, good: GoodDirection = 'up'): 'good' | 'bad' | 'flat' {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.+-]/g, '').replace(/^\+/, ''));
  if (!Number.isFinite(n) || n === 0) return 'flat';
  const up = n > 0;
  return up === (good === 'up') ? 'good' : 'bad';
}

/** Colour for a trend arrow: up or down is good or bad depending on the measure. */
export function trendColor(trend: 'up' | 'down' | 'flat' | undefined, good: GoodDirection = 'up'): string {
  if (!trend || trend === 'flat') return NEUTRAL;
  return (trend === good) ? GOOD : BAD;
}

/** SVG path for a sparkline in a w by h box, plus the last point (for its end dot). */
export function sparkPath(values: number[], w: number, h: number, pad = 2): { d: string; last: { x: number; y: number } } | null {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return null;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (pts.length - 1);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (h - pad * 2);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return { d, last: { x: x(pts.length - 1), y: y(pts[pts.length - 1]) } };
}

export interface WaterfallBar { from: number; to: number; kind: 'total' | 'up' | 'down' }

/** Waterfall geometry: values are deltas, and an index in totals is drawn as a running total from zero. */
export function waterfallBars(values: number[], totals: number[] = []): WaterfallBar[] {
  const isTotal = new Set(totals);
  let running = 0;
  return values.map((v, i) => {
    if (isTotal.has(i)) {
      const t = i === 0 ? v : running;
      running = t;
      return { from: 0, to: t, kind: 'total' as const };
    }
    const from = running;
    running += v;
    return { from, to: running, kind: v >= 0 ? 'up' as const : 'down' as const };
  });
}

const TIME_LABEL = /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s']?\d{2,4}|q[1-4][-\s]?\d{2,4}|(?:19|20)\d{2}(?:[-/]\d{1,2})?|fy\s?\d{2,4})$/i;

/** True when every label is a date or period (Nov-25, Q3 2026, 2027): such an axis stays left to right. */
export function isTimeAxis(labels: string[]): boolean {
  return labels.length > 0 && labels.every((l) => TIME_LABEL.test(String(l).trim()));
}

/**
 * Bars run horizontally when the labels are names (a ranking, a list of borrowers or industries)
 * or there are too many to sit side by side; a time axis stays vertical.
 * A waterfall goes horizontal when its steps would crowd.
 */
export function chartOrientation(block: Pick<ChartBlock, 'chartType' | 'labels' | 'orientation'>): 'vertical' | 'horizontal' {
  if (block.orientation) return block.orientation;
  const { chartType, labels } = block;
  if (chartType !== 'bar' && chartType !== 'waterfall') return 'vertical';
  if (isTimeAxis(labels)) return 'vertical';
  const longest = Math.max(0, ...labels.map((l) => String(l).length));
  if (chartType === 'waterfall') return labels.length > 7 || longest > 14 ? 'horizontal' : 'vertical';
  return labels.length > 6 || longest > 10 ? 'horizontal' : 'vertical';
}

/** Which label indexes are emphasised; with none given, every bar is drawn in full colour. */
export function emphasis(count: number, highlight?: number[]): (i: number) => boolean {
  const set = new Set(highlight ?? []);
  return (i: number) => set.size === 0 || set.has(i);
}

/** Width in px a label needs at a font size, for laying out a horizontal chart's label column. */
export function labelWidth(labels: string[], fontSize = 11, max = 180): number {
  const longest = Math.max(0, ...labels.map((l) => String(l).length));
  return Math.min(max, Math.max(48, Math.ceil(longest * fontSize * 0.56) + 10));
}
