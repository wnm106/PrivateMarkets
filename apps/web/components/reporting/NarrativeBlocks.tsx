'use client';

import type { ColDef } from 'ag-grid-community';
import { AppGrid } from '@/components/grid/AppGrid';
import { markdownToHtml } from '@/lib/markdown';
import { sanitizeHtmlLinks, type NarrativeBlock } from '@/lib/reporting';

const PALETTE = ['#1b3a4b', '#c2410c', '#047857', '#6d28d9', '#0369a1', '#b91c1c', '#a16207', '#475569'];

const SEVERITY: Record<string, { bg: string; fg: string; label: string }> = {
  info: { bg: '#e8eef2', fg: '#1b3a4b', label: 'Info' },
  positive: { bg: '#e1f1e7', fg: '#047857', label: 'Positive' },
  warning: { bg: '#fdf3d7', fg: '#a16207', label: 'Warning' },
  critical: { bg: '#fdecec', fg: '#b91c1c', label: 'Critical' },
  high: { bg: '#fdecec', fg: '#b91c1c', label: 'High' },
  medium: { bg: '#fdf3d7', fg: '#a16207', label: 'Medium' },
  low: { bg: '#e8eef2', fg: '#1b3a4b', label: 'Low' },
};

/** Credit status words to a colour, so a scorecard reads at a glance. */
function statusStyle(value: unknown): { background: string; color: string } | undefined {
  const text = String(value ?? '').toLowerCase();
  if (!text) return undefined;
  if (/non[- ]?accrual/.test(text)) return { background: '#fdecec', color: '#b91c1c' };
  if (/under\s?perform/.test(text)) return { background: '#fdeee3', color: '#c2410c' };
  if (/watch/.test(text)) return { background: '#fdf3d7', color: '#a16207' };
  if (/perform/.test(text)) return { background: '#e1f1e7', color: '#047857' };
  return undefined;
}

export function NarrativeBlocks({ blocks }: { blocks: NarrativeBlock[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {blocks.map((b, i) => (
        <section key={`${b.key}-${i}`}>
          {b.title && (
            <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'none', letterSpacing: 0, color: 'var(--ink-3)', marginBottom: '8px' }}>
              {b.title}
            </div>
          )}
          <BlockBody block={b} />
        </section>
      ))}
    </div>
  );
}

function BlockBody({ block }: { block: NarrativeBlock }) {
  switch (block.type) {
    case 'markdown':
      return (
        <div
          className="markdown-content"
          style={{ fontSize: '14px', lineHeight: 1.6 }}
          // markdownToHtml escapes HTML first; links are additionally restricted to safe schemes.
          dangerouslySetInnerHTML={{ __html: sanitizeHtmlLinks(markdownToHtml(block.text)) }}
        />
      );
    case 'table':
    case 'scorecard': {
      const statusIndex = block.type === 'scorecard' && block.statusColumn ? block.columns.indexOf(block.statusColumn) : -1;
      const numeric = block.columns.map((_, index) => (
        block.rows.length > 0
        && block.rows.every((row) => row[index] == null || row[index] === '' || typeof row[index] === 'number')
        && block.rows.some((row) => typeof row[index] === 'number')
      ));
      const columns: ColDef[] = block.columns.map((name, index) => ({
        colId: `c${index}`,
        headerName: name,
        flex: 1,
        minWidth: 120,
        type: numeric[index] ? 'rightAligned' : undefined,
        valueGetter: (params) => params.data?.[`c${index}`],
        valueFormatter: (params) => typeof params.value === 'number'
          ? params.value.toLocaleString(undefined, { maximumFractionDigits: 2 })
          : String(params.value ?? ''),
        cellStyle: index === statusIndex ? (params) => statusStyle(params.value) ?? null : undefined,
      }));
      const rows = block.rows.map((row, index) => {
        const record: Record<string, unknown> = { __id: String(index) };
        row.forEach((value, cellIndex) => { record[`c${cellIndex}`] = value; });
        return record;
      });
      return (
        <AppGrid
          rows={rows}
          columns={columns}
          getRowId={(row) => String(row.__id)}
          autoHeight
          emptyMessage="No rows"
        />
      );
    }
    case 'chart':
      return <Chart block={block} />;
    case 'kpis':
      return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
          {block.items.map((item, i) => (
            <div key={i} style={{ border: '1px solid var(--line)', padding: '10px 14px', background: 'white' }}>
              <div style={{ fontSize: '11px', color: 'var(--ink-3)' }}>{item.label}</div>
              <div
                style={/^data not available/i.test(item.value)
                  ? { fontSize: '13px', fontWeight: 500, margin: '6px 0', color: 'var(--ink-3)' }
                  : { fontSize: '22px', fontWeight: 600, margin: '2px 0' }}
              >
                {item.value}
                {item.trend && (
                  <span style={{ fontSize: '12px', marginLeft: '6px', color: item.trend === 'up' ? '#047857' : item.trend === 'down' ? '#b91c1c' : 'var(--ink-3)' }}>
                    {item.trend === 'up' ? '▲' : item.trend === 'down' ? '▼' : '▬'}
                  </span>
                )}
              </div>
              {item.detail && <div style={{ fontSize: '11px', color: 'var(--ink-3)' }}>{item.detail}</div>}
            </div>
          ))}
        </div>
      );
    case 'callouts':
      return (
        <div style={{ display: 'grid', gap: '10px' }}>
          {block.items.map((item, i) => {
            const s = SEVERITY[item.severity] || SEVERITY.info;
            return (
              <div key={i} style={{ borderLeft: `3px solid ${s.fg}`, background: s.bg, padding: '10px 14px' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: s.fg }}>{s.label}</div>
                <div style={{ fontWeight: 600, fontSize: '13px', margin: '2px 0 6px' }}>{item.title}</div>
                {item.fields.map((field, j) => (
                  <div key={j} style={{ fontSize: '13px', color: 'var(--ink-2)', margin: '3px 0' }}>
                    <strong>{field.label}:</strong> {field.value}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      );
    case 'sources':
      return (
        <ol style={{ fontSize: '12px', color: 'var(--ink-2)', paddingLeft: '18px', margin: 0 }}>
          {block.items.map((item, i) => (
            <li key={i} style={{ margin: '3px 0' }}>
              {item.url ? <a href={item.url} target="_blank" rel="noreferrer noopener" className="crumb-link">{item.title}</a> : item.title}
              {item.publisher ? `, ${item.publisher}` : ''}{item.date ? ` (${item.date})` : ''}
              {item.note ? ` - ${item.note}` : ''}
            </li>
          ))}
        </ol>
      );
    case 'insights':
      return (
        <div style={{ display: 'grid', gap: '8px' }}>
          {block.items.map((it, i) => {
            const s = SEVERITY[it.severity] || SEVERITY.info;
            return (
              <div key={i} style={{ borderLeft: `3px solid ${s.fg}`, background: s.bg, padding: '10px 14px' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'none', letterSpacing: 0, color: s.fg }}>{s.label}</div>
                <div style={{ fontWeight: 600, fontSize: '13px', margin: '2px 0' }}>{it.title}</div>
                <div style={{ fontSize: '13px', color: 'var(--ink-2)' }}>{it.detail}</div>
              </div>
            );
          })}
        </div>
      );
  }
}

function Chart({ block }: { block: Extract<NarrativeBlock, { type: 'chart' }> }) {
  const { labels, series, chartType } = block;
  const w = 560, h = 240, pad = { l: 40, r: 12, t: 16, b: 44 };

  if (!labels.length || !series.length) return <div style={{ color: 'var(--ink-3)', fontSize: '12px' }}>No chart data</div>;

  if (chartType === 'pie') {
    const values = series[0].values;
    const total = values.reduce((a, b) => a + Math.max(b, 0), 0) || 1;
    const r = 80, cx = 100, cy = 100, c = 2 * Math.PI * r;
    let off = 0;
    return (
      <div style={{ display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap' }}>
        <svg viewBox="0 0 200 200" width={200} height={200} role="img">
          <g transform={`rotate(-90 ${cx} ${cy})`}>
            {values.map((v, i) => {
              const len = (Math.max(v, 0) / total) * c;
              const el = (
                <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth={36} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-off} />
              );
              off += len;
              return el;
            })}
          </g>
        </svg>
        <div style={{ fontSize: '12px' }}>
          {labels.map((l, i) => (
            <div key={i} style={{ margin: '3px 0' }}>
              <span style={{ display: 'inline-block', width: 10, height: 10, background: PALETTE[i % PALETTE.length], marginRight: 6 }} />
              {l} — {(values[i] ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} ({(((values[i] ?? 0) / total) * 100).toFixed(1)}%)
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (chartType === 'heatmap') {
    const flat = series.flatMap((s) => s.values);
    const lo = Math.min(...flat, 0);
    const hi = Math.max(...flat, 0);
    const shade = (v: number) => {
      // Negative is red, positive is green; intensity follows the distance from zero.
      const t = v < 0 ? (lo === 0 ? 0 : v / lo) : (hi === 0 ? 0 : v / hi);
      const a = Math.min(Math.max(t, 0), 1) * 0.75;
      return v < 0 ? `rgba(185,28,28,${a})` : `rgba(4,120,87,${a})`;
    };
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr>
              <th />
              {labels.map((l, i) => <th key={i} style={{ padding: '4px 8px', fontWeight: 500, color: 'var(--ink-3)', textAlign: 'center' }}>{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {series.map((row, ri) => (
              <tr key={ri}>
                <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{row.name}</td>
                {labels.map((_, ci) => (
                  <td key={ci} style={{ padding: '4px 10px', textAlign: 'center', background: shade(row.values[ci] ?? 0), border: '1px solid white' }}>
                    {(row.values[ci] ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (chartType === 'waterfall') {
    // Values are deltas; "totals" marks the indexes drawn as a running total from zero.
    const totals = new Set(block.totals ?? []);
    let running = 0;
    const bars = series[0].values.map((v, i) => {
      if (totals.has(i)) { const t = i === 0 ? v : running; running = t; return { from: 0, to: t, total: true }; }
      const from = running; running += v; return { from, to: running, total: false };
    });
    const points = bars.flatMap((b) => [b.from, b.to]);
    const wmax = Math.max(...points, 1);
    const wmin = Math.min(...points, 0);
    const wspan = wmax - wmin || 1;
    const wn = labels.length;
    const wPlotW = w - pad.l - pad.r;
    const wPlotH = h - pad.t - pad.b;
    const wy = (v: number) => pad.t + (1 - (v - wmin) / wspan) * wPlotH;
    const group = wPlotW / wn;
    return (
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxWidth: w }} role="img">
        <line x1={pad.l} y1={wy(0)} x2={w - pad.r} y2={wy(0)} stroke="#ccc" />
        {bars.map((b, i) => {
          const top = Math.min(wy(b.from), wy(b.to));
          const height = Math.max(Math.abs(wy(b.from) - wy(b.to)), 1);
          const color = b.total ? '#1b3a4b' : b.to >= b.from ? '#047857' : '#b91c1c';
          const x = pad.l + i * group + group * 0.15;
          return (
            <g key={i}>
              <rect x={x} y={top} width={group * 0.7} height={height} fill={color} />
              <text x={x + group * 0.35} y={top - 3} fontSize={9} textAnchor="middle" fill="#444">
                {(b.total ? b.to : b.to - b.from).toLocaleString(undefined, { maximumFractionDigits: 1 })}
              </text>
              <text x={x + group * 0.35} y={h - pad.b + 14} fontSize={10} textAnchor="middle" fill="#666">
                {labels[i].length > 12 ? `${labels[i].slice(0, 11)}…` : labels[i]}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  const stacked = chartType === 'stacked';
  const all = stacked
    ? labels.flatMap((_, i) => [series.reduce((a, s) => a + Math.max(s.values[i] ?? 0, 0), 0), series.reduce((a, s) => a + Math.min(s.values[i] ?? 0, 0), 0)])
    : series.flatMap((s) => s.values);
  const max = Math.max(...all, 1);
  const min = Math.min(...all, 0);
  const span = max - min || 1;
  const n = labels.length;
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const y = (v: number) => pad.t + (1 - (v - min) / span) * plotH;

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxWidth: w }} role="img">
        <line x1={pad.l} y1={y(0)} x2={w - pad.r} y2={y(0)} stroke="#ccc" />
        <text x={4} y={pad.t + 4} fontSize={10} fill="#666">{max.toLocaleString(undefined, { maximumFractionDigits: 1 })}</text>
        <text x={4} y={h - pad.b} fontSize={10} fill="#666">{min.toLocaleString(undefined, { maximumFractionDigits: 1 })}</text>
        {stacked
          ? labels.map((_, i) => {
              const group = plotW / n;
              let pos = 0;
              let neg = 0;
              return series.map((s, si) => {
                const v = s.values[i] ?? 0;
                const from = v >= 0 ? pos : neg;
                const to = from + v;
                if (v >= 0) pos = to; else neg = to;
                return (
                  <rect key={`${si}-${i}`} x={pad.l + i * group + group * 0.15} y={Math.min(y(from), y(to))} width={group * 0.7} height={Math.abs(y(from) - y(to))} fill={PALETTE[si % PALETTE.length]} />
                );
              });
            })
          : chartType === 'bar'
          ? series.map((s, si) => {
              const group = plotW / n;
              const bw = (group * 0.8) / series.length;
              return s.values.map((v, i) => {
                const x = pad.l + i * group + group * 0.1 + si * bw;
                return <rect key={`${si}-${i}`} x={x} y={Math.min(y(v), y(0))} width={bw} height={Math.abs(y(0) - y(v))} fill={PALETTE[si % PALETTE.length]} />;
              });
            })
          : series.map((s, si) => {
              const px = (i: number) => pad.l + (n <= 1 ? 0 : (i * plotW) / (n - 1));
              return (
                <g key={si}>
                  <polyline fill="none" stroke={PALETTE[si % PALETTE.length]} strokeWidth={2} points={s.values.map((v, i) => `${px(i)},${y(v)}`).join(' ')} />
                  {s.values.map((v, i) => <circle key={i} cx={px(i)} cy={y(v)} r={3} fill={PALETTE[si % PALETTE.length]} />)}
                </g>
              );
            })}
        {labels.map((l, i) => {
          if (n > 12 && i % Math.ceil(n / 12) !== 0) return null;
          const x = chartType === 'bar' || stacked ? pad.l + (i + 0.5) * (plotW / n) : pad.l + (n <= 1 ? 0 : (i * plotW) / (n - 1));
          return <text key={i} x={x} y={h - pad.b + 14} fontSize={10} textAnchor="middle" fill="#666">{l.length > 12 ? `${l.slice(0, 11)}…` : l}</text>;
        })}
      </svg>
      {series.length > 1 && (
        <div style={{ display: 'flex', gap: '14px', fontSize: '11px', marginTop: '4px' }}>
          {series.map((s, i) => (
            <span key={i}><span style={{ display: 'inline-block', width: 10, height: 10, background: PALETTE[i % PALETTE.length], marginRight: 5 }} />{s.name}</span>
          ))}
        </div>
      )}
    </div>
  );
}
