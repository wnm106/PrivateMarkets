'use client';

import { useMemo, useState } from 'react';
import type { Book, Dimension, Filter, Group, WindowInput } from '../lib/data';
import { fmtDay } from '../lib/format';
import { contextFor, type Ctx } from '../lib/view';
import { Empty, ErrorPanel, Loading, RecordLink } from './common';
import { Metric } from './cells';

export const ADHOC_TAB = {
  label: 'Ad hoc',
  purpose: 'Performance of any slice of the firm: the funds, deals and sectors you include or leave out, grouped as you choose and compared across the periods you pick.',
};

export type Mode = 'all' | 'only' | 'except';
export interface Pick { mode: Mode; values: string[] }
export interface CustomPeriod { key: string; label: string; start: string; end: string }
export interface AdhocSpec {
  funds: Pick;
  deals: Pick;
  sectors: Pick;
  periods: string[];
  custom: CustomPeriod[];
  groupBy: Extract<Dimension, 'FAMILY' | 'FUND' | 'DEAL' | 'SECTOR' | 'POSITION'>;
}

export const STANDARD_PERIODS = [
  { key: 'ITD', label: 'Inception to date' },
  { key: 'LTM', label: 'Last 12 months' },
  { key: 'YTD', label: 'Year to date' },
  { key: 'QTD', label: 'Quarter to date' },
];

export const GROUP_BY: Array<{ key: AdhocSpec['groupBy']; label: string }> = [
  { key: 'FAMILY', label: 'Fund family' },
  { key: 'FUND', label: 'Fund vehicle' },
  { key: 'DEAL', label: 'Deal' },
  { key: 'SECTOR', label: 'Sector' },
  { key: 'POSITION', label: 'Position' },
];

export const DEFAULT_SPEC: AdhocSpec = {
  funds: { mode: 'all', values: [] },
  deals: { mode: 'all', values: [] },
  sectors: { mode: 'all', values: [] },
  periods: STANDARD_PERIODS.map((p) => p.key),
  custom: [],
  groupBy: 'FAMILY',
};

const pickFilter = (pick: Pick): { include?: string[]; exclude?: string[] } => (
  pick.mode === 'only' && pick.values.length ? { include: pick.values } : pick.mode === 'except' && pick.values.length ? { exclude: pick.values } : {}
);

/** The query a spec asks for: the filter, and the periods in the order shown. */
export function specRequest(spec: AdhocSpec, asOf: string): { filter: Filter | null; windows: WindowInput[] } {
  const f = pickFilter(spec.funds);
  const d = pickFilter(spec.deals);
  const s = pickFilter(spec.sectors);
  const filter: Filter = {
    ...(f.include ? { includeFundIds: f.include } : {}), ...(f.exclude ? { excludeFundIds: f.exclude } : {}),
    ...(d.include ? { includeDealIds: d.include } : {}), ...(d.exclude ? { excludeDealIds: d.exclude } : {}),
    ...(s.include ? { includeSectors: s.include } : {}), ...(s.exclude ? { excludeSectors: s.exclude } : {}),
  };
  const standard = STANDARD_PERIODS.filter((p) => spec.periods.includes(p.key)).map((p) => ({ key: p.key, label: p.label, startDate: startOf(p.key, asOf), endDate: asOf }));
  const custom = spec.custom.filter((c) => c.end).map((c) => ({ key: c.key, label: c.label, startDate: c.start || null, endDate: c.end }));
  return { filter: Object.keys(filter).length ? filter : null, windows: [...standard, ...custom] };
}

/** The day before a standard period starts (the formula's opening day). */
function startOf(key: string, asOf: string): string | null {
  const [y, m, d] = asOf.split('-').map(Number);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  if (key === 'YTD') return iso(new Date(Date.UTC(y, 0, 0)));
  if (key === 'QTD') return iso(new Date(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 0)));
  if (key === 'LTM') return iso(new Date(Date.UTC(y - 1, m - 1, d)));
  return null;
}

export const isDefaultSpec = (spec: AdhocSpec) => JSON.stringify(spec) === JSON.stringify(DEFAULT_SPEC);

/** One row of the comparison: a group and its figures in each period. */
export interface AdhocRow { key: string; label: string; entityId: string | null; cells: Array<{ ctx: Ctx; group: Group | undefined }> }

export function adhocRows(book: Book, groupBy: AdhocSpec['groupBy']): { total: AdhocRow; rows: AdhocRow[]; ctxs: Ctx[] } {
  const ctxs = book.windows.map((w) => contextFor(book, w));
  const keys = new Map<string, { label: string; entityId: string | null; size: number }>();
  ctxs.forEach((ctx, i) => {
    for (const g of ctx.window.groups.filter((x) => x.dimension === groupBy)) {
      const seen = keys.get(g.key);
      const size = i === 0 ? (g.gross?.paidIn ?? 0) + (g.net?.paidIn ?? 0) : 0;
      keys.set(g.key, { label: g.label, entityId: g.entityId, size: (seen?.size ?? 0) + size });
    }
  });
  const rows = [...keys.entries()].sort((a, b) => b[1].size - a[1].size || a[1].label.localeCompare(b[1].label))
    .map(([key, info]) => ({ key, label: info.label, entityId: info.entityId, cells: ctxs.map((ctx) => ({ ctx, group: ctx.group(groupBy, key) })) }));
  const total = { key: 'TOTAL', label: 'Selection total', entityId: null, cells: ctxs.map((ctx) => ({ ctx, group: ctx.window.total })) };
  return { total, rows, ctxs };
}

const PATH: Partial<Record<AdhocSpec['groupBy'], (id: string) => string>> = {
  FAMILY: (id) => `/funds/${id}/overview`,
  FUND: (id) => `/funds/${id}/overview`,
  DEAL: (id) => `/deals/${id}`,
  POSITION: (id) => `/positions/${id}`,
};

function Picker({ label, pick, options, onChange }: { label: string; pick: Pick; options: Array<{ value: string; label: string }>; onChange: (pick: Pick) => void }) {
  const chosen = new Set(pick.values);
  const name = (value: string) => options.find((o) => o.value === value)?.label || value;
  return (
    <fieldset className="x-pick">
      <legend>{label}</legend>
      <select aria-label={`${label}: which to measure`} value={pick.mode} onChange={(e) => onChange({ ...pick, mode: e.target.value as Mode })}>
        <option value="all">All {label.toLowerCase()}</option>
        <option value="only">Only these</option>
        <option value="except">All except these</option>
      </select>
      {pick.mode !== 'all' && (
        <>
          <details className="x-dd">
            <summary>{pick.values.length ? `${pick.values.length} chosen` : `Choose ${label.toLowerCase()}`}</summary>
            <div className="x-ddlist">
              {options.map((o) => (
                <label key={o.value}>
                  <input type="checkbox" checked={chosen.has(o.value)} onChange={(e) => onChange({ ...pick, values: e.target.checked ? [...pick.values, o.value] : pick.values.filter((v) => v !== o.value) })} />
                  {o.label}
                </label>
              ))}
            </div>
          </details>
          <div className="x-chips">
            {pick.values.map((v) => (
              <span key={v} className="da-chip">{name(v)} <button type="button" className="x-chipx" aria-label={`Remove ${name(v)}`} onClick={() => onChange({ ...pick, values: pick.values.filter((x) => x !== v) })}>×</button></span>
            ))}
          </div>
        </>
      )}
    </fieldset>
  );
}

export function AdhocTab({ base, result, loading, error, spec, applied, onChange, onRun, onReset }: {
  /** The firm-wide book, for the lists to choose from. */
  base: Book;
  /** What the applied spec measured. */
  result: Book | null;
  loading: boolean;
  error: string | null;
  spec: AdhocSpec;
  applied: AdhocSpec;
  onChange: (spec: AdhocSpec) => void;
  onRun: () => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<CustomPeriod>({ key: '', label: '', start: '', end: base.asOfDate });
  const fundOptions = useMemo(() => base.funds.filter((f) => base.windows[0]?.groups.some((g) => (g.dimension === 'FUND' || g.dimension === 'FAMILY') && g.key === f.id))
    .map((f) => ({ value: f.id, label: f.name })).sort((a, b) => a.label.localeCompare(b.label)), [base]);
  const dealOptions = useMemo(() => base.deals.map((d) => ({ value: d.id, label: d.name })).sort((a, b) => a.label.localeCompare(b.label)), [base]);
  const sectorOptions = useMemo(() => base.sectors.map((s) => ({ value: s, label: s })), [base]);
  const stale = JSON.stringify(spec) !== JSON.stringify(applied);
  const ready = spec.periods.length + spec.custom.length > 0;
  const addCustom = () => {
    if (!draft.end || (draft.start && draft.start >= draft.end)) return;
    const key = `P${spec.custom.length + 1}`;
    onChange({ ...spec, custom: [...spec.custom, { key, label: draft.label.trim() || `${draft.start ? fmtDay(draft.start) : 'Inception'} to ${fmtDay(draft.end)}`, start: draft.start, end: draft.end }] });
    setDraft({ key: '', label: '', start: '', end: base.asOfDate });
  };
  const view = result ? adhocRows(result, applied.groupBy) : null;
  const showNet = Boolean(result && !result.windows[0]?.netExcluded && (applied.groupBy === 'FAMILY' || applied.groupBy === 'FUND'));
  const path = PATH[applied.groupBy];
  return (
    <>
      <div className="x-builder">
        <Picker label="Funds" pick={spec.funds} options={fundOptions} onChange={(funds) => onChange({ ...spec, funds })} />
        <Picker label="Deals" pick={spec.deals} options={dealOptions} onChange={(deals) => onChange({ ...spec, deals })} />
        <Picker label="Sectors" pick={spec.sectors} options={sectorOptions} onChange={(sectors) => onChange({ ...spec, sectors })} />
        <fieldset className="x-pick">
          <legend>Periods</legend>
          <div className="x-checks">
            {STANDARD_PERIODS.map((p) => (
              <label key={p.key}><input type="checkbox" checked={spec.periods.includes(p.key)} onChange={(e) => onChange({ ...spec, periods: e.target.checked ? [...spec.periods, p.key] : spec.periods.filter((k) => k !== p.key) })} /> {p.label}</label>
            ))}
          </div>
          {spec.custom.length > 0 && (
            <div className="x-chips">
              {spec.custom.map((c) => <span key={c.key} className="da-chip">{c.label} <button type="button" className="x-chipx" aria-label={`Remove ${c.label}`} onClick={() => onChange({ ...spec, custom: spec.custom.filter((x) => x.key !== c.key) })}>×</button></span>)}
            </div>
          )}
          <div className="x-custom">
            <label>From <input type="date" value={draft.start} max={draft.end || base.asOfDate} onChange={(e) => setDraft({ ...draft, start: e.target.value })} /></label>
            <label>To <input type="date" value={draft.end} max={base.asOfDate} onChange={(e) => setDraft({ ...draft, end: e.target.value })} /></label>
            <button type="button" className="btn btn-sm" disabled={!draft.end || Boolean(draft.start && draft.start >= draft.end)} onClick={addCustom}>Add period</button>
          </div>
          <p className="x-note">Leave From empty for inception. A period never ends after your As Of date.</p>
        </fieldset>
        <fieldset className="x-pick">
          <legend>Rows</legend>
          <select aria-label="Group rows by" value={spec.groupBy} onChange={(e) => onChange({ ...spec, groupBy: e.target.value as AdhocSpec['groupBy'] })}>
            {GROUP_BY.map((g) => <option key={g.key} value={g.key}>By {g.label.toLowerCase()}</option>)}
          </select>
          <div className="x-acts">
            <button type="button" className="btn btn-sm btn-primary" disabled={!ready || loading || !stale} onClick={onRun}>{loading ? 'Measuring…' : 'Measure'}</button>
            <button type="button" className="btn btn-sm" disabled={loading || isDefaultSpec(spec)} onClick={onReset}>Reset</button>
          </div>
          {stale && <p className="x-note" role="status">Changed. Select Measure to see the new figures.</p>}
          {!ready && <p className="x-note">Pick at least one period.</p>}
        </fieldset>
      </div>
      {error && <ErrorPanel message={error} onRetry={onRun} />}
      {loading && !result && <Loading text="Measuring the selection…" />}
      {view && (!view.rows.length ? <Empty>Nothing in the selection has a cash flow or a capital account statement in these periods. Widen a filter or a period.</Empty> : (
        <div className="x-frame">
          <table className="da-grid x-table">
            <thead>
              <tr>
                <th rowSpan={2}>{GROUP_BY.find((g) => g.key === applied.groupBy)?.label}</th>
                {view.ctxs.map((ctx) => <th key={ctx.window.key} colSpan={showNet ? 4 : 3} className="x-period">{ctx.window.label}<small className="x-block">{ctx.window.startDate ? fmtDay(ctx.window.startDate) : 'Inception'} to {fmtDay(ctx.window.endDate)}</small></th>)}
              </tr>
              <tr className="x-sub">
                {view.ctxs.map((ctx) => [
                  <th key={`${ctx.window.key}-p`} className="num x-sep">Paid in</th>,
                  <th key={`${ctx.window.key}-i`} className="num">Gross IRR</th>,
                  <th key={`${ctx.window.key}-m`} className="num">MOIC</th>,
                  ...(showNet ? [<th key={`${ctx.window.key}-n`} className="num">Net IRR</th>] : []),
                ])}
              </tr>
            </thead>
            <tbody>
              {[view.total, ...view.rows].map((row) => (
                <tr key={row.key} className={row.key === 'TOTAL' ? 'x-total' : undefined}>
                  <td>{row.key === 'TOTAL' ? <b>{row.label}</b> : path && row.entityId ? <RecordLink path={path(row.entityId)}>{row.label}</RecordLink> : row.label}</td>
                  {row.cells.map(({ ctx, group }) => {
                    const blank = <span className="x-nil" title="Nothing measured in this period">—</span>;
                    return [
                      <td key={`${ctx.window.key}-p`} className="num x-sep">{group ? <Metric ctx={ctx} group={group} basis="gross" k="paidIn" /> : blank}</td>,
                      <td key={`${ctx.window.key}-i`} className="num">{group ? <Metric ctx={ctx} group={group} basis="gross" k="irr" toned /> : blank}</td>,
                      <td key={`${ctx.window.key}-m`} className="num">{group ? <Metric ctx={ctx} group={group} basis="gross" k="moic" /> : blank}</td>,
                      ...(showNet ? [<td key={`${ctx.window.key}-n`} className="num">{group ? <Metric ctx={ctx} group={group} basis="net" k="irr" toned /> : blank}</td>] : []),
                    ];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {result?.windows[0]?.netExcluded && <p className="x-note">Net figures are left out: capital accounts are not held by deal or sector, so a deal or sector filter cannot apply to them.</p>}
    </>
  );
}
