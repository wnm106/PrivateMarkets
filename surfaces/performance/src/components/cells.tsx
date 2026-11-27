'use client';

import type { Group } from '../lib/data';
import { fmtBps, tone } from '../lib/format';
import { fmtMetric, metricHow, METRIC_NAME, spreadHow, type Basis, type MetricKey } from '../lib/how';
import { spread, type Ctx } from '../lib/view';
import { Derived } from './common';

/** One pooled figure. Right-click shows how it is worked out and the records behind it. */
export function Metric({ ctx, group, basis, k, toned }: { ctx: Ctx; group: Group; basis: Basis; k: MetricKey; toned?: boolean }) {
  const m = basis === 'gross' ? group.gross : group.net;
  if (!m || !m.legs) {
    const why = m?.excluded ? 'Left out: a value but nothing put in during the period' : basis === 'net' ? 'No capital accounts in this row' : 'No measured positions in this row';
    return <span className="x-nil" title={why}>—</span>;
  }
  const shown = fmtMetric(k, m);
  if (shown === '—') return <span className="x-nil" title="Not enough flows to solve">—</span>;
  const value = k === 'irr' ? m.irr : k === 'gain' ? m.gain : null;
  return (
    <Derived name={`${METRIC_NAME[basis][k]}, ${group.label}`} how={() => metricHow(ctx, group, basis, k)} className={toned ? tone(value) : undefined}>
      {shown}
    </Derived>
  );
}

export function Spread({ ctx, group }: { ctx: Ctx; group: Group }) {
  const value = spread(group);
  if (value == null) return <span className="x-nil" title="Needs both a gross and a net IRR">—</span>;
  return <Derived name={`Gross to net, ${group.label}`} how={() => spreadHow(ctx, group, value)}>{fmtBps(value)}</Derived>;
}

/** The cells of the gross block, in the order every tab uses. */
export const GROSS_COLUMNS: Array<{ k: MetricKey; label: string; toned?: boolean }> = [
  { k: 'paidIn', label: 'Paid in' },
  { k: 'distributed', label: 'Distributed' },
  { k: 'closing', label: 'Value' },
  { k: 'irr', label: 'Gross IRR', toned: true },
  { k: 'moic', label: 'Gross MOIC' },
];

export function Caret({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className="x-caret" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${label}`} onClick={onToggle}>
      {open ? '▾' : '▸'}
    </button>
  );
}
