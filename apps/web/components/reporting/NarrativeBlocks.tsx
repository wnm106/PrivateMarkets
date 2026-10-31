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
};

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
    case 'table': {
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

  const all = series.flatMap((s) => s.values);
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
        {chartType === 'bar'
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
          const x = chartType === 'bar' ? pad.l + (i + 0.5) * (plotW / n) : pad.l + (n <= 1 ? 0 : (i * plotW) / (n - 1));
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
