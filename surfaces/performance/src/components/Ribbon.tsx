'use client';

import type { Ctx } from '../lib/view';
import { countHow, metricHow, METRIC_NAME, fmtMetric } from '../lib/how';
import { fmtDay, tone } from '../lib/format';
import { Derived } from './common';

/** The firm-wide figures for the chosen period, gross and net. */
export function Ribbon({ ctx }: { ctx: Ctx }) {
  const t = ctx.window.total;
  const fact = (basis: 'gross' | 'net', k: 'irr' | 'moic' | 'paidIn' | 'closing' | 'dpi', note: string) => {
    const m = basis === 'gross' ? t.gross : t.net;
    const shown = fmtMetric(k, m);
    return (
      <div className="da-fact">
        <span>{basis === 'gross' && k !== 'irr' && k !== 'moic' ? METRIC_NAME.gross[k] : METRIC_NAME[basis][k]}</span>
        <strong className={k === 'irr' ? tone(m?.irr) : undefined}>
          {shown === '—' ? <span className="x-nil">—</span> : <Derived name={`Firm ${METRIC_NAME[basis][k]}`} how={() => metricHow(ctx, t, basis, k)}>{shown}</Derived>}
        </strong>
        <small>{note}</small>
      </div>
    );
  };
  const excluded = t.gross?.excluded ?? 0;
  return (
    <div className="da-ribbon x-ribbon">
      {fact('gross', 'irr', 'positions, pooled')}
      {fact('gross', 'moic', 'value and distributions over paid in')}
      {fact('gross', 'paidIn', 'opening value and money out')}
      {fact('gross', 'closing', `market value on ${fmtDay(ctx.window.endDate)}`)}
      {fact('net', 'irr', 'capital accounts, pooled')}
      {fact('net', 'moic', 'distributions and NAV over contributed')}
      {fact('net', 'dpi', 'distributions over contributed')}
      <div className="da-fact">
        <span>Measured</span>
        <strong>
          <Derived name="Positions measured" how={() => countHow('Positions measured', `Positions with a cash flow or a deal tranche that had money put in during the period. ${excluded} more have a value but nothing put in during the period and are left out; ${ctx.book.unmeasuredPositions} positions of these funds have no cash flow and no deal tranche at all.`, String(t.gross?.legs ?? 0), [
            { label: 'Pooled', value: String(t.gross?.legs ?? 0) },
            { label: 'Left out: value but nothing put in', value: String(excluded) },
            { label: 'No cash flow or deal tranche', value: String(ctx.book.unmeasuredPositions) },
            { label: 'Capital accounts pooled', value: String(t.net?.legs ?? 0) },
          ])}>{t.gross?.legs ?? 0}</Derived> <small>positions</small>
        </strong>
        <small>{excluded ? `${excluded} left out, nothing put in` : 'none left out'}</small>
      </div>
    </div>
  );
}
