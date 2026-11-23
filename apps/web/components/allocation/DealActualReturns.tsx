'use client';

import { useEffect, useMemo, useState } from 'react';
import { graphqlQuery } from '@/lib/graphql';
import { useSurfaceDates } from '@/components/certification/CertificationScope';
import { attrBind, InspectValue } from '@/components/detail/InspectValue';

/**
 * Actual IRR and MOIC from position cash flows and market values.
 *
 * The figures are the attribute formulas, solved when read. Inception to date is the formula as written.
 * Any other period uses that same formula and opens with the market value on the start date.
 */

type Preset = 'ITD' | 'YTD' | 'QTD' | 'LTM' | 'CUSTOM';

const PRESETS: Array<[Preset, string]> = [
  ['ITD', 'Inception to date'],
  ['YTD', 'Year to date'],
  ['QTD', 'Quarter to date'],
  ['LTM', 'Last 12 months'],
  ['CUSTOM', 'Custom'],
];

const RETURNS = `
  query PeriodReturns($entityIds: [ID!]!, $attributeCodes: [String!]!, $startDate: Date, $endDate: Date) {
    periodReturns(entityIds: $entityIds, attributeCodes: $attributeCodes, startDate: $startDate, endDate: $endDate) {
      entityId
      attributeCode
      value
    }
  }
`;

const CODES = ['DEAL_IRR_ITD', 'DEAL_MOIC_ITD', 'TRANCHE_IRR_ITD', 'TRANCHE_MOIC_ITD'];

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The opening valuation date for a preset ending on `end`. Null is inception. */
export function periodStart(preset: Preset, end: string, custom: string): string | null {
  const [year, month, day] = end.slice(0, 10).split('-').map(Number);
  if (preset === 'YTD') return isoDay(new Date(Date.UTC(year, 0, 0)));
  if (preset === 'QTD') return isoDay(new Date(Date.UTC(year, Math.floor((month - 1) / 3) * 3, 0)));
  if (preset === 'LTM') return isoDay(new Date(Date.UTC(year - 1, month - 1, day)));
  if (preset === 'CUSTOM') return custom || null;
  return null;
}

function rate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function multiple(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}x`;
}

export function DealActualReturns({
  dealId,
  dealName,
  tranches,
}: {
  dealId: string;
  dealName?: string | null;
  tranches: Array<{ id: string; name: string }>;
}) {
  const { asOfDate } = useSurfaceDates();
  const [preset, setPreset] = useState<Preset>('ITD');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [values, setValues] = useState<Map<string, number | null>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const end = preset === 'CUSTOM' && customEnd ? customEnd : asOfDate;
  const start = periodStart(preset, end, customStart);
  const trancheKey = useMemo(() => tranches.map((tranche) => tranche.id).join(','), [tranches]);
  const invalid = preset === 'CUSTOM' && !!start && start >= end;

  useEffect(() => {
    if (invalid) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void graphqlQuery<{ periodReturns: Array<{ entityId: string; attributeCode: string; value: number | null }> }>(
      RETURNS,
      { entityIds: [dealId, ...trancheKey.split(',').filter(Boolean)], attributeCodes: CODES, startDate: start, endDate: end },
      'network-only',
    ).then((result) => {
      if (cancelled) return;
      if (result.error?.message) setError(result.error.message);
      setValues(new Map((result.data?.periodReturns || []).map((row) => [`${row.entityId}|${row.attributeCode}`, row.value])));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [dealId, trancheKey, start, end, invalid]);

  const value = (entityId: string, code: string) => values.get(`${entityId}|${code}`) ?? null;
  // Inception to date is the formula on the attribute. Other periods reuse it with a start date.
  const stored = preset === 'ITD';
  const dealBind = (code: string, name: string) => (stored ? attrBind(dealId, 'DEAL', code, name, dealName) : null);
  const trancheBind = (tranche: { id: string; name: string }, code: string, name: string) =>
    (stored ? attrBind(tranche.id, 'DEAL_TRANCHE', code, name, tranche.name) : null);
  const dealIrr = value(dealId, 'DEAL_IRR_ITD');
  const dealMoic = value(dealId, 'DEAL_MOIC_ITD');
  const empty = !loading && dealIrr == null && dealMoic == null;

  return (
    <section className="da-sec">
      <div className="da-sechead">
        <h2>Actual returns</h2>
        <p>
          From position cash flows and market values{start ? `, ${start} to ${end}` : `, inception to ${end}`}.
          {start ? ' The period opens at the market value on the start date.' : ''} IRR is annualised.
        </p>
      </div>
      <div className="da-tabs" role="tablist" aria-label="Return period">
        {PRESETS.map(([code, label]) => (
          <button key={code} type="button" role="tab" aria-selected={preset === code} className={preset === code ? 'on' : ''} onClick={() => setPreset(code)}>
            {label}
          </button>
        ))}
      </div>
      {preset === 'CUSTOM' && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' }}>
          <label>Start <input type="date" value={customStart} max={end} onChange={(event) => setCustomStart(event.target.value)} /></label>
          <label>End <input type="date" value={customEnd || asOfDate} onChange={(event) => setCustomEnd(event.target.value)} /></label>
          {!customStart && <small>No start date means inception.</small>}
        </div>
      )}
      {invalid && <div className="xp-error">The start date must be before the end date.</div>}
      {error && <div className="xp-error">{error}</div>}
      {loading && !invalid && <div className="xp-empty">Loading returns…</div>}
      {empty && !invalid && <div className="xp-empty">No booked cash flows in this period. Actual returns start when the deal closes and funds.</div>}
      {!loading && !empty && !invalid && (
        <div className="da-gridwrap">
          <table className="da-grid">
            <thead>
              <tr><th /><th className="num">IRR</th><th className="num">MOIC</th></tr>
            </thead>
            <tbody>
              {tranches.map((tranche) => (
                <tr key={tranche.id}>
                  <td>{tranche.name}</td>
                  <td className="num">
                    <InspectValue bind={trancheBind(tranche, 'TRANCHE_IRR_ITD', 'IRR, Inception to Date')} value={value(tranche.id, 'TRANCHE_IRR_ITD')}>
                      {rate(value(tranche.id, 'TRANCHE_IRR_ITD'))}
                    </InspectValue>
                  </td>
                  <td className="num">
                    <InspectValue bind={trancheBind(tranche, 'TRANCHE_MOIC_ITD', 'MOIC, Inception to Date')} value={value(tranche.id, 'TRANCHE_MOIC_ITD')}>
                      {multiple(value(tranche.id, 'TRANCHE_MOIC_ITD'))}
                    </InspectValue>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total deal</td>
                <td className="num">
                  <InspectValue bind={dealBind('DEAL_IRR_ITD', 'IRR, Inception to Date')} value={dealIrr}>{rate(dealIrr)}</InspectValue>
                </td>
                <td className="num">
                  <InspectValue bind={dealBind('DEAL_MOIC_ITD', 'MOIC, Inception to Date')} value={dealMoic}>{multiple(dealMoic)}</InspectValue>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
