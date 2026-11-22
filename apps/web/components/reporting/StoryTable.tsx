'use client';

/**
 * A table that tells its story: typed columns (deltas with arrows coloured by whether the
 * direction is good, inline bars for shares, sparklines for series, status pills), and the
 * rows the prose talks about highlighted with a footnote each. Long tables fall back to the
 * data grid, where paging and sorting matter more than emphasis.
 */
import type { ColDef } from 'ag-grid-community';
import { AppGrid } from '@/components/grid/AppGrid';
import type { ColumnSpec, NarrativeBlock, Tone } from '@/lib/reporting';
import { BAD, GOOD, NEUTRAL, ACCENT, deltaTone, formatValue, sparkPath } from '@/lib/narrative-visual';

type TableBlock = Extract<NarrativeBlock, { type: 'table' | 'scorecard' }>;

const STORY_MAX_ROWS = 40;

const TONE_STYLE: Record<Tone, { bg: string; bar: string }> = {
  positive: { bg: '#ecfdf3', bar: '#047857' },
  warning: { bg: '#fffbeb', bar: '#b45309' },
  critical: { bg: '#fef2f2', bar: '#b91c1c' },
  info: { bg: '#eff6ff', bar: '#2a78d6' },
  neutral: { bg: '#f8fafc', bar: '#64748b' },
};

/** Credit status words to a pill colour, so a status column reads at a glance. */
export function statusStyle(value: unknown): { background: string; color: string } | undefined {
  const text = String(value ?? '').toLowerCase();
  if (!text) return undefined;
  if (/non[- ]?accrual|breach|critical/.test(text)) return { background: '#fdecec', color: '#b91c1c' };
  if (/under\s?perform/.test(text)) return { background: '#fdeee3', color: '#c2410c' };
  if (/watch|warning|near/.test(text)) return { background: '#fdf3d7', color: '#a16207' };
  if (/perform|within|pass|ok\b/.test(text)) return { background: '#e1f1e7', color: '#047857' };
  return { background: '#eef2f6', color: '#334155' };
}

/** Column specs for a block: the ones it declares, else inferred (numbers right-aligned, the status column as pills). */
export function columnsOf(block: TableBlock): ColumnSpec[] {
  return block.columns.map((label, i) => {
    // A scorecard's status column is a status whatever else the columns declare.
    if (block.type === 'scorecard' && block.statusColumn === label) return { label, kind: 'status' };
    const declared = block.columnSpecs?.[i];
    if (declared && declared.kind !== 'text') return declared;
    const numeric = block.rows.length > 0 && block.rows.every((r) => r[i] == null || r[i] === '' || typeof r[i] === 'number')
      && block.rows.some((r) => typeof r[i] === 'number');
    return { label, kind: numeric ? 'number' : 'text' };
  });
}

function Spark({ values }: { values: number[] }) {
  const p = sparkPath(values, 72, 20);
  if (!p) return null;
  const rising = values[values.length - 1] >= values[0];
  return (
    <svg width={72} height={20} viewBox="0 0 72 20" aria-hidden style={{ verticalAlign: 'middle' }}>
      <path d={p.d} fill="none" stroke={NEUTRAL} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={p.last.x} cy={p.last.y} r={2.5} fill={rising ? ACCENT : NEUTRAL} />
    </svg>
  );
}

function Cell({ value, spec, max }: { value: unknown; spec: ColumnSpec; max: number }) {
  if (value === null || value === undefined || value === '') return <span style={{ color: '#94a3b8' }}>–</span>;
  switch (spec.kind) {
    case 'delta': {
      const tone = deltaTone(value, spec.good ?? 'up');
      const n = Number(value);
      const color = tone === 'good' ? GOOD : tone === 'bad' ? BAD : NEUTRAL;
      const arrow = !Number.isFinite(n) || n === 0 ? '▬' : n > 0 ? '▲' : '▼';
      return (
        <span style={{ color, fontWeight: 500, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 9, marginRight: 4 }}>{arrow}</span>
          {Number.isFinite(n) ? formatValue(n, spec.format, { signed: true }) : String(value)}
        </span>
      );
    }
    case 'bar': {
      const n = Number(value);
      const share = Number.isFinite(n) && max > 0 ? Math.max(0, Math.min(1, n / max)) : 0;
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Number.isFinite(n) ? formatValue(n, spec.format) : String(value)}</span>
          <span style={{ width: 64, height: 6, background: '#eef2f6', borderRadius: 3, overflow: 'hidden', flex: '0 0 auto' }}>
            <span style={{ display: 'block', width: `${share * 100}%`, height: '100%', background: ACCENT, borderRadius: 3 }} />
          </span>
        </span>
      );
    }
    case 'spark':
      return Array.isArray(value) ? <Spark values={value as number[]} /> : <span>{String(value)}</span>;
    case 'status': {
      const s = statusStyle(value);
      return <span style={{ ...s, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{String(value)}</span>;
    }
    case 'number':
      return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{typeof value === 'number' ? formatValue(value, spec.format) : String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

const RIGHT: ColumnSpec['kind'][] = ['number', 'delta', 'bar'];

export function StoryTable({ block }: { block: TableBlock }) {
  const specs = columnsOf(block);
  if (block.rows.length > STORY_MAX_ROWS) return <GridTable block={block} specs={specs} />;
  const max = specs.map((s, i) => (s.kind === 'bar' ? Math.max(0, ...block.rows.map((r) => Number(r[i]) || 0)) : 0));
  const marks = new Map((block.highlights ?? []).map((h, n) => [h.row, { ...h, n: n + 1 }]));
  const notes = [...marks.values()].filter((h) => h.note);
  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              {specs.map((s, i) => (
                <th key={i} style={{
                  textAlign: RIGHT.includes(s.kind) ? 'right' : s.kind === 'spark' || s.kind === 'status' ? 'center' : 'left',
                  padding: '6px 10px', fontSize: 11, fontWeight: 600, color: '#475569', borderBottom: '1px solid #cbd5e1', whiteSpace: 'nowrap',
                }}>
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => {
              const mark = marks.get(ri);
              const tone = mark ? TONE_STYLE[mark.tone] : undefined;
              return (
                <tr key={ri} style={{ background: tone?.bg }}>
                  {specs.map((s, ci) => (
                    <td key={ci} style={{
                      padding: '7px 10px', borderBottom: '1px solid #eef2f6', color: '#0f172a',
                      textAlign: RIGHT.includes(s.kind) ? 'right' : s.kind === 'spark' || s.kind === 'status' ? 'center' : 'left',
                      fontWeight: ci === 0 && mark ? 600 : 400,
                      borderLeft: ci === 0 && tone ? `3px solid ${tone.bar}` : undefined,
                      // The subject's name stays on one line; a narrow screen scrolls the table instead.
                      whiteSpace: ci === 0 ? 'nowrap' : undefined,
                    }}>
                      <Cell value={row[ci]} spec={s} max={max[ci]} />
                      {ci === 0 && mark?.note && <sup style={{ marginLeft: 4, color: tone?.bar, fontWeight: 700 }}>{mark.n}</sup>}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {notes.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#334155', display: 'grid', gap: 3 }}>
          {notes.map((h) => (
            <div key={h.n} style={{ display: 'flex', gap: 6 }}>
              <span style={{ color: TONE_STYLE[h.tone].bar, fontWeight: 700, minWidth: 10 }}>{h.n}</span>
              <span>{h.note}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A long table: the data grid, with the same number formats. */
function GridTable({ block, specs }: { block: TableBlock; specs: ColumnSpec[] }) {
  const columns: ColDef[] = specs.map((s, index) => ({
    colId: `c${index}`,
    headerName: s.label,
    flex: 1,
    minWidth: 110,
    type: RIGHT.includes(s.kind) ? 'rightAligned' : undefined,
    valueGetter: (params) => params.data?.[`c${index}`],
    valueFormatter: (params) => (Array.isArray(params.value) ? params.value.join(' → ')
      : typeof params.value === 'number' ? formatValue(params.value, s.format, { signed: s.kind === 'delta' }) : String(params.value ?? '')),
    cellStyle: s.kind === 'status' ? (params) => statusStyle(params.value) ?? null : undefined,
  }));
  const rows = block.rows.map((row, index) => {
    const record: Record<string, unknown> = { __id: String(index) };
    row.forEach((value, cellIndex) => { record[`c${cellIndex}`] = value; });
    return record;
  });
  return <AppGrid rows={rows} columns={columns} getRowId={(row) => String(row.__id)} autoHeight emptyMessage="No rows" />;
}
