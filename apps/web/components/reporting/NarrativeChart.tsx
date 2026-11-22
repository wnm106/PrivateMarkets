'use client';

/**
 * Narrative charts, drawn as SVG. Each form follows the dataviz mark specs: thin bars (24px at most)
 * with a 4px rounded data end, 2px lines with end dots, hairline grids, values at the bar tip rather
 * than on every point, text in ink colours, a legend only for two or more series, and a hover
 * tooltip (<title>) on every mark. Names run as horizontal bars so labels are never squeezed.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { NarrativeBlock } from '@/lib/reporting';
import {
  ACCENT, BAD, GOOD, MUTED, SERIES_COLORS, chartOrientation, emphasis, formatValue, labelWidth, niceTicks,
  waterfallBars, wrapLabel,
} from '@/lib/narrative-visual';

type ChartBlock = Extract<NarrativeBlock, { type: 'chart' }>;

/** Width a chart lays out at before it has been measured (and on the server). */
const DEFAULT_W = 640;
const INK = '#0f172a';
const INK_2 = '#334155';
const INK_3 = '#64748b';
const GRID = '#e2e8f0';
const TOTAL = '#1e3a5f';
const FONT = 11;

const fmt = (b: ChartBlock, v: number, signed = false) => formatValue(v, b.format, { signed, compact: b.format === 'usd_m' && Math.abs(v) >= 10000 });

/** A bar with a 4px rounded data end and a square end at the baseline. */
function barPath(x: number, y: number, w: number, h: number, end: 'top' | 'bottom' | 'right' | 'left'): string {
  const r = Math.max(0, Math.min(4, (end === 'top' || end === 'bottom' ? w : h) / 2, (end === 'top' || end === 'bottom' ? h : w)));
  if (w <= 0 || h <= 0) return '';
  switch (end) {
    case 'top': return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
    case 'bottom': return `M${x},${y} V${y + h - r} Q${x},${y + h} ${x + r},${y + h} H${x + w - r} Q${x + w},${y + h} ${x + w},${y + h - r} V${y} Z`;
    case 'right': return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
    default: return `M${x + w},${y} H${x + r} Q${x},${y} ${x},${y + r} V${y + h - r} Q${x},${y + h} ${x + r},${y + h} H${x + w} Z`;
  }
}

function Legend({ series }: { series: ChartBlock['series'] }) {
  if (series.length < 2) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: '11px', color: INK_2, marginTop: '6px' }}>
      {series.map((s, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

/** The rendered width of a container, so a chart lays out at the size it is shown and its text stays 10-11px. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_W);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => { const w = Math.round(el.getBoundingClientRect().width); if (w > 0) setWidth(Math.min(w, 960)); };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function NarrativeChart({ block }: { block: ChartBlock }) {
  const [ref, W] = useWidth();
  const { labels, series, chartType } = block;
  if (!labels.length || !series.length) return <div style={{ color: INK_3, fontSize: '12px' }}>No chart data</div>;
  const orientation = chartOrientation(block);
  let body: ReactNode;
  if (chartType === 'pie') body = <SegmentedBar block={block} />;
  else if (chartType === 'heatmap') body = <Heatmap block={block} />;
  else if (chartType === 'waterfall') body = orientation === 'horizontal' ? <HorizontalWaterfall block={block} W={W} /> : <VerticalWaterfall block={block} W={W} />;
  else if (chartType === 'line') body = <LineChart block={block} W={W} />;
  else if (orientation === 'horizontal' && chartType === 'bar') body = <HorizontalBars block={block} W={W} />;
  else body = <VerticalBars block={block} W={W} />;
  return <div ref={ref} style={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>{body}</div>;
}

// ---------------------------------------------------------------------------
// Horizontal bars: rankings and names
// ---------------------------------------------------------------------------

function HorizontalBars({ block, W }: { block: ChartBlock; W: number }) {
  const { labels, series } = block;
  const strong = emphasis(labels.length, block.highlight);
  const lw = labelWidth(labels, FONT, 200);
  const valueRoom = 64;
  const bandH = series.length > 1 ? 14 + series.length * 10 : 26;
  const barH = series.length > 1 ? 8 : 14;
  const all = series.flatMap((s) => s.values);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const plotW = W - lw - valueRoom - 8;
  const x = (v: number) => lw + 8 + ((v - min) / (max - min || 1)) * plotW;
  const h = labels.length * bandH + 8;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${h}`} width={W} role="img" aria-label={block.title ?? 'Bar chart'} style={{ display: 'block', maxWidth: '100%' }}>
        {min < 0 && <line x1={x(0)} x2={x(0)} y1={0} y2={h} stroke={GRID} />}
        {labels.map((label, i) => {
          const y0 = 4 + i * bandH;
          return (
            <g key={i}>
              <text x={lw} y={y0 + bandH / 2} fontSize={FONT} textAnchor="end" dominantBaseline="middle" fill={strong(i) ? INK : INK_3} fontWeight={block.highlight?.includes(i) ? 600 : 400}>
                {wrapLabel(label, Math.floor(lw / (FONT * 0.56)), 1)[0]}
              </text>
              {series.map((s, si) => {
                const v = s.values[i] ?? 0;
                const y = series.length > 1 ? y0 + 7 + si * 10 : y0 + (bandH - barH) / 2;
                const x0 = x(Math.min(0, v));
                const w = Math.abs(x(v) - x(0));
                const color = series.length > 1 ? SERIES_COLORS[si % SERIES_COLORS.length] : strong(i) ? ACCENT : MUTED;
                return (
                  <g key={si}>
                    <path d={barPath(x0, y, Math.max(w, 1), barH, v < 0 ? 'left' : 'right')} fill={color}>
                      <title>{`${label}${s.name ? ` · ${s.name}` : ''}: ${fmt(block, v)}`}</title>
                    </path>
                    {series.length === 1 && (
                      <text x={(v < 0 ? x0 : x(v)) + (v < 0 ? -6 : 6)} y={y + barH / 2} fontSize={FONT} dominantBaseline="middle" textAnchor={v < 0 ? 'end' : 'start'} fill={strong(i) ? INK_2 : INK_3}>
                        {fmt(block, v)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <Legend series={series} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vertical bars and stacks: time and short categories
// ---------------------------------------------------------------------------

function Axis({ ticks, y, block, left, right }: { ticks: number[]; y: (v: number) => number; block: ChartBlock; left: number; right: number }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
          <text x={left - 6} y={y(t)} fontSize={10} textAnchor="end" dominantBaseline="middle" fill={INK_3}>{fmt(block, t)}</text>
        </g>
      ))}
    </g>
  );
}

function XLabels({ labels, cx, top, band, block }: { labels: string[]; cx: (i: number) => number; top: number; band: number; block: ChartBlock }) {
  const chars = Math.max(4, Math.floor(band / (FONT * 0.56)));
  const step = band < 22 ? Math.ceil(22 / band) : 1;
  return (
    <g>
      {labels.map((l, i) => {
        if (i % step !== 0 && i !== labels.length - 1) return null;
        const lines = wrapLabel(l, chars, 2);
        return (
          <text key={i} x={cx(i)} y={top} fontSize={10} textAnchor="middle" fill={block.highlight?.includes(i) ? INK : INK_3} fontWeight={block.highlight?.includes(i) ? 600 : 400}>
            {lines.map((line, li) => <tspan key={li} x={cx(i)} dy={li === 0 ? 0 : 12}>{line}</tspan>)}
          </text>
        );
      })}
    </g>
  );
}

function VerticalBars({ block, W }: { block: ChartBlock; W: number }) {
  const { labels, series } = block;
  const stacked = block.chartType === 'stacked';
  const strong = emphasis(labels.length, block.highlight);
  const totals = labels.map((_, i) => series.reduce((a, s) => a + Math.max(s.values[i] ?? 0, 0), 0));
  const lows = labels.map((_, i) => series.reduce((a, s) => a + Math.min(s.values[i] ?? 0, 0), 0));
  const all = stacked ? [...totals, ...lows] : series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const pad = { l: 56, r: 12, t: 18, b: 38 };
  const H = 260;
  const plotH = H - pad.t - pad.b;
  const band = (W - pad.l - pad.r) / labels.length;
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * plotH;
  const cx = (i: number) => pad.l + (i + 0.5) * band;
  const groupW = Math.min(stacked ? 24 : 24 * series.length + 2 * (series.length - 1), band * 0.7);
  const barW = stacked ? groupW : Math.max(2, (groupW - 2 * (series.length - 1)) / series.length);
  const labelValues = !stacked && series.length === 1 && labels.length <= 12;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} role="img" aria-label={block.title ?? 'Bar chart'} style={{ display: 'block', maxWidth: '100%' }}>
        <Axis ticks={ticks} y={y} block={block} left={pad.l} right={W - pad.r} />
        {labels.map((label, i) => {
          let pos = 0;
          let neg = 0;
          return series.map((s, si) => {
            const v = s.values[i] ?? 0;
            const color = series.length > 1 ? SERIES_COLORS[si % SERIES_COLORS.length] : strong(i) ? ACCENT : MUTED;
            let from: number;
            let to: number;
            let x: number;
            if (stacked) {
              from = v >= 0 ? pos : neg; to = from + v;
              if (v >= 0) pos = to; else neg = to;
              x = cx(i) - barW / 2;
            } else {
              from = 0; to = v;
              x = cx(i) - groupW / 2 + si * (barW + 2);
            }
            const top = Math.min(y(from), y(to));
            const h = Math.abs(y(from) - y(to));
            // Only the outer segment of a stack gets the rounded end; inner segments are separated by a 2px gap.
            const outer = !stacked || si === series.length - 1;
            const d = outer ? barPath(x, top, barW, Math.max(h - (stacked ? 2 : 0), 1), to >= from ? 'top' : 'bottom') : '';
            return (
              <g key={`${i}-${si}`}>
                {outer
                  ? <path d={d} fill={color}><title>{`${label}${s.name ? ` · ${s.name}` : ''}: ${fmt(block, v)}`}</title></path>
                  : <rect x={x} y={top} width={barW} height={Math.max(h - 2, 0)} fill={color}><title>{`${label} · ${s.name}: ${fmt(block, v)}`}</title></rect>}
                {labelValues && (
                  <text x={cx(i)} y={v >= 0 ? top - 5 : top + h + 12} fontSize={10} textAnchor="middle" fill={strong(i) ? INK_2 : INK_3}>{fmt(block, v)}</text>
                )}
              </g>
            );
          });
        })}
        <XLabels labels={labels} cx={cx} top={H - pad.b + 14} band={band} block={block} />
      </svg>
      <Legend series={series} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Line: change over time, with the turning point annotated
// ---------------------------------------------------------------------------

function LineChart({ block, W }: { block: ChartBlock; W: number }) {
  const { labels, series } = block;
  const all = series.flatMap((s) => s.values);
  const lo0 = Math.min(...all);
  const hi0 = Math.max(...all);
  // A level series (NAV) reads better on a zoomed axis than from zero; a flat line is the story otherwise lost.
  const span = hi0 - lo0 || Math.abs(hi0) * 0.02 || 1;
  const ticks = niceTicks(lo0 - span * 0.15, hi0 + span * 0.15);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const pad = { l: 64, r: 70, t: 22, b: 38 };
  const H = 260;
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const n = labels.length;
  const x = (i: number) => pad.l + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * plotH;
  const band = n > 1 ? plotW / (n - 1) : plotW;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} role="img" aria-label={block.title ?? 'Line chart'} style={{ display: 'block', maxWidth: '100%' }}>
        <Axis ticks={ticks} y={y} block={block} left={pad.l} right={W - pad.r} />
        {series.map((s, si) => {
          const color = SERIES_COLORS[si % SERIES_COLORS.length];
          const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
          const last = s.values.length - 1;
          return (
            <g key={si}>
              {series.length === 1 && (
                <polygon points={`${x(0)},${y(lo)} ${pts} ${x(last)},${y(lo)}`} fill={color} opacity={0.08} />
              )}
              <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.map((v, i) => (
                <circle key={i} cx={x(i)} cy={y(v)} r={9} fill="transparent">
                  <title>{`${labels[i]}${s.name ? ` · ${s.name}` : ''}: ${fmt(block, v)}`}</title>
                </circle>
              ))}
              <circle cx={x(last)} cy={y(s.values[last])} r={4} fill={color} stroke="#fff" strokeWidth={2} />
              <text x={x(last) + 8} y={y(s.values[last])} fontSize={FONT} dominantBaseline="middle" fill={INK_2} fontWeight={600}>
                {fmt(block, s.values[last])}
              </text>
            </g>
          );
        })}
        {(block.annotations ?? []).map((a, ai) => {
          const v = series[0]?.values[a.index];
          if (v === undefined) return null;
          const above = y(v) > pad.t + 30;
          const ty = above ? y(v) - 14 : y(v) + 20;
          return (
            <g key={ai}>
              <circle cx={x(a.index)} cy={y(v)} r={4} fill="#fff" stroke={INK_2} strokeWidth={2} />
              <text x={x(a.index)} y={ty} fontSize={10} textAnchor="middle" fill={INK_2}>{a.text}</text>
            </g>
          );
        })}
        <XLabels labels={labels} cx={x} top={H - pad.b + 16} band={band} block={block} />
      </svg>
      <Legend series={series} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Waterfalls: a walk from a start figure to an end figure
// ---------------------------------------------------------------------------

const stepColor = (kind: 'total' | 'up' | 'down') => (kind === 'total' ? TOTAL : kind === 'up' ? GOOD : BAD);

function VerticalWaterfall({ block, W }: { block: ChartBlock; W: number }) {
  const { labels } = block;
  const bars = waterfallBars(block.series[0].values, block.totals);
  const pts = bars.flatMap((b) => [b.from, b.to]);
  const steps = bars.filter((b) => b.kind !== 'total').flatMap((b) => [b.from, b.to]);
  // Zoom the axis on the steps when the totals dwarf them, so a $10M walk on a $1bn base is visible.
  const zoom = steps.length > 0 && Math.max(...pts) > 0 && (Math.max(...steps) - Math.min(...steps)) < Math.max(...pts) * 0.2;
  const lo0 = zoom ? Math.min(...steps) - (Math.max(...steps) - Math.min(...steps)) * 0.6 : Math.min(0, ...pts);
  const ticks = niceTicks(lo0, Math.max(...pts) * (zoom ? 1.0 : 1));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const pad = { l: 64, r: 12, t: 20, b: 40 };
  const H = 270;
  const plotH = H - pad.t - pad.b;
  const band = (W - pad.l - pad.r) / labels.length;
  const y = (v: number) => pad.t + (1 - (Math.max(v, lo) - lo) / (hi - lo || 1)) * plotH;
  const cx = (i: number) => pad.l + (i + 0.5) * band;
  const bw = Math.min(28, band * 0.6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} role="img" aria-label={block.title ?? 'Waterfall'} style={{ display: 'block', maxWidth: '100%' }}>
      <Axis ticks={ticks} y={y} block={block} left={pad.l} right={W - pad.r} />
      {bars.map((b, i) => {
        const top = Math.min(y(b.from), y(b.to));
        const h = Math.max(Math.abs(y(b.from) - y(b.to)), 1.5);
        const next = bars[i + 1];
        const value = b.kind === 'total' ? b.to : b.to - b.from;
        // On a zoomed axis a total would be a bar cut off at the axis, which misstates its size: draw its level instead.
        const level = zoom && b.kind === 'total';
        return (
          <g key={i}>
            {level
              ? <line x1={cx(i) - bw / 2} x2={cx(i) + bw / 2} y1={y(b.to)} y2={y(b.to)} stroke={TOTAL} strokeWidth={4} strokeLinecap="round"><title>{`${labels[i]}: ${fmt(block, value)}`}</title></line>
              : (
                <rect x={cx(i) - bw / 2} y={top} width={bw} height={h} rx={2} fill={stepColor(b.kind)}>
                  <title>{`${labels[i]}: ${fmt(block, value, b.kind !== 'total')}`}</title>
                </rect>
              )}
            {next && <line x1={cx(i) + bw / 2} x2={cx(i + 1) - bw / 2} y1={y(b.to)} y2={y(b.to)} stroke={INK_3} strokeWidth={1} strokeDasharray="2 2" />}
            <text x={cx(i)} y={(level ? y(b.to) : top) - 7} fontSize={10} textAnchor="middle" fill={INK_2} fontWeight={b.kind === 'total' ? 600 : 400}>
              {fmt(block, value, b.kind !== 'total')}
            </text>
          </g>
        );
      })}
      <XLabels labels={labels} cx={cx} top={H - pad.b + 14} band={band} block={block} />
    </svg>
  );
}

function HorizontalWaterfall({ block, W }: { block: ChartBlock; W: number }) {
  const { labels } = block;
  const bars = waterfallBars(block.series[0].values, block.totals);
  const steps = bars.filter((b) => b.kind !== 'total');
  const lw = labelWidth(labels, FONT, 170);
  const rowH = 24;
  const valueRoom = 70;
  // Steps are drawn on their own scale: the start and end totals are shown as labelled rows, not as bars
  // that would make every step a sliver.
  const stepPts = steps.flatMap((b) => [b.from, b.to]);
  const lo = Math.min(...stepPts);
  const hi = Math.max(...stepPts);
  const plotW = W - lw - valueRoom - 16;
  const x = (v: number) => lw + 12 + ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo || 1)) * plotW;
  const H = labels.length * rowH + 8;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} role="img" aria-label={block.title ?? 'Waterfall'} style={{ display: 'block', maxWidth: '100%' }}>
      {bars.map((b, i) => {
        const yMid = 4 + i * rowH + rowH / 2;
        const value = b.kind === 'total' ? b.to : b.to - b.from;
        const label = wrapLabel(labels[i], Math.floor(lw / (FONT * 0.56)), 1)[0];
        if (b.kind === 'total') {
          return (
            <g key={i}>
              <text x={lw} y={yMid} fontSize={FONT} textAnchor="end" dominantBaseline="middle" fill={INK} fontWeight={600}>{label}</text>
              <line x1={x(b.to)} x2={x(b.to)} y1={yMid - 9} y2={yMid + 9} stroke={TOTAL} strokeWidth={3} />
              <text x={x(b.to) + (x(b.to) > W - valueRoom - 40 ? -8 : 8)} y={yMid} fontSize={FONT} dominantBaseline="middle" textAnchor={x(b.to) > W - valueRoom - 40 ? 'end' : 'start'} fill={INK} fontWeight={600}>
                {fmt(block, value)}
              </text>
            </g>
          );
        }
        const x0 = Math.min(x(b.from), x(b.to));
        const w = Math.max(Math.abs(x(b.to) - x(b.from)), 2);
        return (
          <g key={i}>
            <text x={lw} y={yMid} fontSize={FONT} textAnchor="end" dominantBaseline="middle" fill={INK_2}>{label}</text>
            <rect x={x0} y={yMid - 7} width={w} height={14} rx={2} fill={stepColor(b.kind)}>
              <title>{`${labels[i]}: ${fmt(block, value, true)}`}</title>
            </rect>
            <text x={x0 + w + 6} y={yMid} fontSize={10} dominantBaseline="middle" fill={INK_2}>{fmt(block, value, true)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Parts of a whole: one tall segmented bar instead of a pie
// ---------------------------------------------------------------------------

function SegmentedBar({ block }: { block: ChartBlock }) {
  const values = block.series[0].values.map((v) => Math.max(v, 0));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  let offset = 0;
  return (
    <div>
      <div style={{ display: 'flex', gap: 2, height: 28, borderRadius: 4, overflow: 'hidden' }} role="img" aria-label={block.title ?? 'Share of total'}>
        {values.map((v, i) => {
          const share = (v / total) * 100;
          offset += share;
          if (share <= 0) return null;
          const fits = share >= 9;
          return (
            <div key={i} title={`${block.labels[i]}: ${fmt(block, block.series[0].values[i])} (${share.toFixed(1)}%)`}
              style={{ flex: `${share} 0 0`, background: SERIES_COLORS[i % SERIES_COLORS.length], borderRadius: 4, color: '#fff', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', paddingLeft: 8, whiteSpace: 'nowrap', overflow: 'visible' }}>
              {fits ? `${share.toFixed(0)}%` : ''}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: '12px', color: INK_2, marginTop: 8 }}>
        {block.labels.map((l, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
            {l} <span style={{ color: INK_3 }}>{fmt(block, block.series[0].values[i])}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heatmap: rows are series, columns are labels
// ---------------------------------------------------------------------------

function Heatmap({ block }: { block: ChartBlock }) {
  const flat = block.series.flatMap((s) => s.values);
  const lo = Math.min(...flat, 0);
  const hi = Math.max(...flat, 0);
  const shade = (v: number) => {
    const t = v < 0 ? (lo === 0 ? 0 : v / lo) : (hi === 0 ? 0 : v / hi);
    const a = Math.min(Math.max(t, 0), 1) * 0.7;
    return v < 0 ? `rgba(185,28,28,${a})` : `rgba(4,120,87,${a})`;
  };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 2, fontSize: '12px' }}>
        <thead>
          <tr>
            <th />
            {block.labels.map((l, i) => <th key={i} style={{ padding: '4px 8px', fontWeight: 500, color: INK_3, textAlign: 'center' }}>{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {block.series.map((row, ri) => (
            <tr key={ri}>
              <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: INK_2 }}>{row.name}</td>
              {block.labels.map((_, ci) => {
                const v = row.values[ci] ?? 0;
                return (
                  <td key={ci} title={`${row.name} · ${block.labels[ci]}: ${fmt(block, v)}`}
                    style={{ padding: '5px 10px', textAlign: 'center', background: shade(v), borderRadius: 3, fontVariantNumeric: 'tabular-nums', color: INK }}>
                    {fmt(block, v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
