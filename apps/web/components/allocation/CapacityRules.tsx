'use client';

import { useMemo, useState } from 'react';
import { isProhibition, standingsForFund, type CapacityReading, type CapacityStanding } from '@/lib/capacity-view';

function words(code: string): string {
  return code.toLowerCase().replace(/_/g, ' ');
}

export function formatReading(value: number | null | undefined, unit?: string | null): string {
  if (value == null || Number.isNaN(value)) return '—';
  if (unit === 'PERCENTAGE') return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  if (unit === 'CURRENCY') return money(value);
  if (unit === 'COUNT') return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function money(value: number): string {
  return `$${(value / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
}

interface FundRow {
  fundId: string;
  fundName: string;
  parentFundId?: string | null;
  cells: Array<{ trancheId: string; amount: number }>;
}

export function useCapacityStandings(fundId: string, readings: CapacityReading[], rows: FundRow[]): CapacityStanding[] {
  return useMemo(() => standingsForFund(fundId, readings, rows), [fundId, readings, rows]);
}

/**
 * The rules this deal would worsen for one fund, read from the room the
 * allocation already respects: where the fund is now, the room left, and
 * where this allocation takes it. Nothing is run or written.
 */
export function CapacityRules({ fundId, readings, rows, onOpenHypo }: {
  fundId: string;
  readings: CapacityReading[];
  rows: FundRow[];
  onOpenHypo?: () => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const standings = useCapacityStandings(fundId, readings, rows);
  const names = useMemo(() => new Map(rows.map((row) => [row.fundId, row.fundName.replace(/^[^:]+:\s*/, '')])), [rows]);

  if (!standings.length) {
    return <p className="da-note">No compliance limit on this fund is worsened by this deal.</p>;
  }

  return (
    <>
      <p className="da-note">Booked book now, and with this allocation. Only limits set on each fund are tested; set them under Compliance, Thresholds by fund.</p>
      {standings.map((item) => {
        const reading = item.reading;
        const key = `${reading.fundId}|${reading.ruleCode}|${reading.groupValue ?? ''}`;
        const open = openKey === key;
        const banned = isProhibition(reading);
        const group = reading.groupValue
          ? `${reading.groupLabel || 'Group'} ${banned ? words(reading.groupValue) : reading.groupValue}`
          : '';
        const owner = item.ownerId ? names.get(item.ownerId) || '' : '';
        const unit = reading.resultUnit;
        const share = unit === 'PERCENTAGE' || unit === 'RATIO';
        return (
          <div key={key} className={`da-rule${open ? ' open' : ''}`}>
            <button type="button" className="da-rulehead" aria-expanded={open} onClick={() => setOpenKey(open ? null : key)}>
              <span className="da-ruleline">
                <span className="da-twist" aria-hidden="true">{open ? '▾' : '▸'}</span>
                <b>
                  <span className="da-rulename">{reading.ruleName}</span>
                  {(group || owner) && <span className="da-rulegroup">{[group, owner && `(${owner})`].filter(Boolean).join(' ')}</span>}
                </b>
                <span className={`da-st ${item.tone}`}>{item.label}</span>
              </span>
              <span className="cr-line">
                {banned ? (
                  <span>Limit 0: this fund may not hold it{item.used > 0 ? `, ${money(item.used)} placed` : ''}</span>
                ) : (
                <span>
                  {item.current != null
                    ? <>{formatReading(item.current, unit)} <span aria-hidden="true">→</span> <b>{formatReading(item.proForma, unit)}</b> of {formatReading(reading.hardLimit, unit)}</>
                    : <>Room {money(Math.max(0, reading.room))}</>}
                </span>
                )}
                {!banned && <span className="cr-room">{money(item.used)} of {money(Math.max(0, reading.room))} room</span>}
              </span>
              <span className={`da-gauge ${item.tone}`}><i style={{ width: `${Math.min(100, Math.max(0, (item.utilisation ?? 0) * 100))}%` }} /></span>
            </button>
            {open && (
              <div className="da-ruledetail">
                <div><span>Now (booked)</span><b>{formatReading(item.current, unit)}</b></div>
                <div><span>With this deal</span><b>{formatReading(item.proForma, unit)}</b></div>
                <div><span>Limit</span><b>{formatReading(reading.hardLimit, unit)}</b></div>
                {reading.softLimit != null && <div><span>Soft limit</span><b>{formatReading(reading.softLimit, unit)}</b></div>}
                <div><span>Room for this deal</span><b>{money(Math.max(0, reading.room))}</b></div>
                <div><span>Allocated here</span><b>{money(item.used)}</b></div>
                {reading.numerator != null && <div><span>{share ? 'Numerator' : 'Current amount'}</span><b>{money(reading.numerator)}</b></div>}
                {share && reading.denominator != null && (
                  <div><span>Denominator</span><b>{money(reading.denominator)}{reading.denominatorGrows ? ', grows with the deal' : ''}</b></div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {onOpenHypo && (
        <button type="button" className="btn btn-sm cr-hypo" onClick={onOpenHypo}>Run a full Hypo test</button>
      )}
    </>
  );
}
