'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { useTemporalStore } from '@/lib/store';
import { domainHref } from '@/lib/domain-routes';
import { usePublishTab } from '@/lib/view-context';
import { COVENANT_MEASURE_LABELS, COVENANT_METRIC_LABELS, covenantTabPayload } from '@/lib/covenant-tab';
import { covenantStatus, type CovenantComponentResult, type CovenantDefinitionChoice, type CovenantTest as CovenantTestResult } from '@tapestrai/graphql/src/lib/covenant-test';

const TEST_FIELDS = `
  covenantId code name dealId dealName metric direction unit level firstTest beforeFirstTest
  asOf testDate value numerator denominator stored manualOverride stale status cushion
  house houseId houseName reportedDifference isLibrary isHouse missing
  reported { sourceCode sourceName value validFrom }
  history { testDate value house level tested }
  components {
    id name side line lineName sign measure capType capValue effectiveFrom effectiveTo clause
    active raw capLimit allowed applied capped
  }
`;

const TEST_QUERY = `
  query CovenantTest($covenantId: ID!, $asOfDate: Date) {
    covenantTest(covenantId: $covenantId, asOfDate: $asOfDate, history: 8) { ${TEST_FIELDS} }
    covenantLibrary(asOfDate: $asOfDate) { id name description metric isHouse componentCount }
  }
`;

const COPY_MUTATION = `
  mutation CopyCovenantDefinition($covenantId: ID!, $fromCovenantId: ID!, $effectiveFrom: Date!) {
    copyCovenantDefinition(covenantId: $covenantId, fromCovenantId: $fromCovenantId, effectiveFrom: $effectiveFrom) { ${TEST_FIELDS} }
  }
`;

const RECALCULATE_MUTATION = `
  mutation RecalculateCovenant($covenantId: ID!) {
    recalculateCovenant(covenantId: $covenantId) { ${TEST_FIELDS} }
  }
`;

const METRIC = COVENANT_METRIC_LABELS;
const MEASURE = COVENANT_MEASURE_LABELS;

const STATUS: Record<string, { label: string; className: string }> = {
  PASS: { label: 'Pass', className: 'da-st ok' },
  WATCH: { label: 'Watch', className: 'da-st near' },
  BREACH: { label: 'Breach', className: 'da-st breach' },
  NO_DATA: { label: 'No data', className: 'da-st na' },
};

function millions(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const scaled = value / 1_000_000;
  const body = Math.abs(scaled).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return scaled < 0 ? `($${body}M)` : `$${body}M`;
}

function multiple(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}x`;
}

function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [year, month, date] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year || 1970, (month || 1) - 1, date || 1)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function quarterStart(iso: string | null | undefined): string {
  const base = iso ? iso.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const [year, month] = base.split('-').map(Number);
  const startMonth = Math.floor(((month || 1) - 1) / 3) * 3 + 1;
  return `${year}-${String(startMonth).padStart(2, '0')}-01`;
}

function capText(row: CovenantComponentResult, sideLabel: string): string {
  if (row.capType === 'AMOUNT') return `Up to ${millions(row.capValue)}`;
  if (row.capType === 'PCT_OF_BASE') return `Up to ${row.capValue ?? 0}% of uncapped ${sideLabel.toLowerCase()} lines`;
  return '';
}

function inForce(row: CovenantComponentResult): string {
  if (row.active) {
    if (row.effectiveFrom && row.effectiveTo) return `${day(row.effectiveFrom)} to ${day(row.effectiveTo)}`;
    if (row.effectiveFrom) return `From ${day(row.effectiveFrom)}`;
    if (row.effectiveTo) return `Until ${day(row.effectiveTo)}`;
    return '';
  }
  if (row.effectiveTo) return `Ended ${day(row.effectiveTo)}`;
  if (row.effectiveFrom) return `Starts ${day(row.effectiveFrom)}`;
  return 'Not in force';
}

function SideRows({
  title,
  rows,
  total,
}: {
  title: string;
  rows: CovenantComponentResult[];
  total: number | null;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <tr className="par">
        <td colSpan={5}><strong>{title}</strong></td>
        <td className="num"><strong>{millions(total)}</strong></td>
      </tr>
      {rows.map((row) => {
        const cap = capText(row, title);
        const dates = inForce(row);
        return (
          <tr key={row.id} className={row.active ? 'sub' : 'sub cv-off'}>
            <td>
              {row.sign === 'SUBTRACT' ? 'Less ' : ''}{row.name}
              {row.clause && <small>{row.clause}</small>}
            </td>
            <td>
              {row.lineName || row.line || '—'}
              <small>{MEASURE[row.measure] || row.measure}</small>
            </td>
            <td>
              {cap || '—'}
              {row.capped && row.capLimit != null && <small className="cv-capped">Capped at {millions(row.capLimit)}</small>}
            </td>
            <td>{dates || '—'}</td>
            <td className="num">{row.active ? millions(row.raw) : '—'}</td>
            <td className="num">{row.active ? millions(row.applied) : '—'}</td>
          </tr>
        );
      })}
    </>
  );
}

/** publishAs is the record tab key this test publishes under; the record page keeps the tab mounted so it publishes while closed. */
export function CovenantTest({ covenantId, publishAs, label = 'Test' }: { covenantId: string; publishAs?: string; label?: string }) {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const [test, setTest] = useState<CovenantTestResult | null>(null);
  const [library, setLibrary] = useState<CovenantDefinitionChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fromId, setFromId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // A null entry publishes nothing, so a test shown outside a record tab stays quiet.
  usePublishTab(publishAs || 'covenant-test', publishAs ? covenantTabPayload(label, loading ? null : test) : null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await graphqlQuery<
      { covenantTest: CovenantTestResult | null; covenantLibrary: CovenantDefinitionChoice[] },
      { covenantId: string; asOfDate?: string }
    >(TEST_QUERY, { covenantId, asOfDate: asOfDate || undefined }, 'network-only');
    if (result.error) setError(result.error.message || 'The covenant could not be read.');
    setTest(result.data?.covenantTest ?? null);
    setLibrary(result.data?.covenantLibrary ?? []);
    setLoading(false);
  }, [asOfDate, covenantId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (test && !effectiveFrom) setEffectiveFrom(quarterStart(test.testDate));
  }, [effectiveFrom, test]);

  const choices = useMemo(() => {
    const own = library.filter((item) => item.id !== covenantId);
    const sameMetric = own.filter((item) => !test?.metric || !item.metric || item.metric === test.metric);
    return sameMetric.length > 0 ? sameMetric : own;
  }, [covenantId, library, test?.metric]);

  const recalculate = async () => {
    setBusy(true);
    setError(null);
    const result = await graphqlMutation<{ recalculateCovenant: CovenantTestResult }>(RECALCULATE_MUTATION, { covenantId });
    if (result.error) setError(result.error.message || 'The covenant could not be recalculated.');
    if (result.data?.recalculateCovenant) {
      setTest(result.data.recalculateCovenant);
      setNotice('Stored values recalculated for every quarter end.');
    }
    setBusy(false);
  };

  const copy = async () => {
    if (!fromId || !effectiveFrom) return;
    setBusy(true);
    setError(null);
    const result = await graphqlMutation<{ copyCovenantDefinition: CovenantTestResult }>(COPY_MUTATION, {
      covenantId,
      fromCovenantId: fromId,
      effectiveFrom,
    });
    if (result.error) setError(result.error.message || 'The definition could not be copied.');
    if (result.data?.copyCovenantDefinition) {
      setTest(result.data.copyCovenantDefinition);
      const source = library.find((item) => item.id === fromId);
      setNotice(`Copied ${source?.name || 'the definition'} for quarters ending on or after ${day(effectiveFrom)}. Earlier quarters keep the definition they were tested under.`);
      setConfirming(false);
    }
    setBusy(false);
  };

  if (loading && !test) return <div className="xp-empty">Testing the covenant…</div>;
  if (!test) return <div className="xp-error">{error || 'Covenant not found.'}</div>;

  const format = test.unit === 'CURRENCY' ? (value: number | null) => millions(value) : multiple;
  const status = STATUS[test.status] || STATUS.NO_DATA;
  const numerator = test.components.filter((row) => row.side === 'NUMERATOR');
  const denominator = test.components.filter((row) => row.side === 'DENOMINATOR');
  const certificate = test.reported.find((row) => row.sourceCode !== 'MANUAL');
  const manual = test.reported.find((row) => row.sourceCode === 'MANUAL');
  const ratio = denominator.length > 0;
  const houseGap = test.house != null && test.value != null ? test.value - test.house : null;

  return (
    <div className="da cv">
      <section className="da-sec">
        <div className="da-sechead">
          <h2>{test.name}</h2>
          <p>
            {METRIC[test.metric || ''] || 'Covenant'}
            {test.dealId && test.dealName && <> · <Link href={`${domainHref('DEAL')}/${test.dealId}`}>{test.dealName}</Link></>}
            {test.testDate && <> · Quarter ending {day(test.testDate)}</>}
          </p>
        </div>

        {test.isLibrary && (
          <div className="cv-banner">
            {test.isHouse ? 'This is the house standard. It is computed for every deal with this metric so they can be compared.' : 'This is a library definition. Copy it onto a deal\'s covenant from that covenant\'s Test tab.'}
          </div>
        )}
        {test.beforeFirstTest && (
          <div className="cv-banner">First test is {day(test.firstTest)}. Until then the value is for monitoring only.</div>
        )}
        {test.manualOverride && manual && (
          <div className="cv-banner warn">A manual entry of {format(manual.value)} overrides the calculation in the golden record.</div>
        )}
        {test.stale && !test.isLibrary && (
          <div className="cv-banner warn">
            The stored value ({format(test.stored)}) no longer matches this definition ({format(test.value)}).
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void recalculate()} disabled={busy}>
              {busy ? 'Recalculating…' : 'Recalculate'}
            </button>
          </div>
        )}
        {notice && <div className="cv-banner ok">{notice}</div>}
        {error && <div className="xp-error">{error}</div>}

        <div className="da-ribbon" style={{ marginTop: 12 }}>
          <div className="da-facts five">
            <div className="da-fact">
              <span>Calculated</span>
              <strong>{format(test.value)}</strong>
              <small>This deal&apos;s definition</small>
            </div>
            <div className="da-fact">
              <span>{test.direction === 'MIN' ? 'Minimum' : 'Maximum'}</span>
              <strong>{format(test.level)}</strong>
              <small>{test.cushion != null ? `${Math.round(test.cushion * 100)}% cushion` : '—'}</small>
            </div>
            <div className="da-fact">
              <span>Status</span>
              <strong><span className={status.className}>{status.label}</span></strong>
              <small>{test.testDate ? `Tested ${day(test.testDate)}` : 'No statement yet'}</small>
            </div>
            <div className="da-fact">
              <span>Borrower certificate</span>
              <strong>{certificate ? format(certificate.value) : '—'}</strong>
              <small>
                {certificate && test.reportedDifference != null
                  ? Math.abs(test.reportedDifference) < (test.unit === 'CURRENCY' ? 1000 : 0.005)
                    ? 'Agrees with the calculation'
                    : `${test.reportedDifference > 0 ? '+' : '−'}${format(Math.abs(test.reportedDifference))} from the calculation`
                  : 'Not received'}
              </small>
            </div>
            <div className="da-fact">
              <span>House standard</span>
              <strong>{test.houseId && !test.isHouse ? format(test.house) : '—'}</strong>
              <small>
                {test.isHouse ? 'This is the standard' : houseGap != null
                  ? `Definition is ${format(Math.abs(houseGap))} ${houseGap > 0 ? 'higher' : 'lower'}`
                  : test.houseId ? '—' : 'No house standard for this metric'}
              </small>
            </div>
          </div>
        </div>

        {test.missing.length > 0 && (
          <ul className="cv-missing">
            {test.missing.map((item) => <li key={item}>{item}</li>)}
          </ul>
        )}
      </section>

      <section className="da-sec">
        <div className="da-sechead">
          <h2>How it is calculated</h2>
          <p>Each line is read from the borrower&apos;s statements for the test date. Edit lines on the Definition tab.</p>
        </div>
        <div className="da-gridwrap" style={{ marginTop: 12 }}>
          <table className="da-grid" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Line</th>
                <th>Statement line</th>
                <th>Cap</th>
                <th>In force</th>
                <th className="num">Statement</th>
                <th className="num">Counted</th>
              </tr>
            </thead>
            <tbody>
              <SideRows title={ratio ? 'Numerator' : 'Amount'} rows={numerator} total={test.numerator} />
              <SideRows title="Denominator" rows={denominator} total={test.denominator} />
              <tr className="net">
                <td colSpan={5}><strong>{ratio ? 'Numerator ÷ denominator' : 'Covenant amount'}</strong></td>
                <td className="num"><strong>{format(test.value)}</strong></td>
              </tr>
            </tbody>
          </table>
          {test.components.length === 0 && <div className="xp-empty">No definition yet. Add lines on the Definition tab, or copy one from the library below.</div>}
        </div>
      </section>

      {test.history.length > 0 && (
        <section className="da-sec">
          <div className="da-sechead">
            <h2>Quarter ends</h2>
            <p>Each quarter is tested under the definition and level in force on that date, the same figures the statement's Covenant section and the compliance rules use.</p>
          </div>
          <div className="da-gridwrap" style={{ marginTop: 12 }}>
            <table className="da-grid" style={{ minWidth: 480 }}>
              <thead>
                <tr>
                  <th>Quarter ending</th>
                  <th className="num">This deal&apos;s definition</th>
                  <th className="num">House standard</th>
                  <th className="num">Level</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {[...test.history].reverse().map((point) => {
                  const pointStatus = STATUS[covenantStatus(test.direction, point.level, point.value)];
                  return (
                    <tr key={point.testDate}>
                      <td>{day(point.testDate)}</td>
                      <td className="num">{format(point.value)}</td>
                      <td className="num">{test.isHouse ? '—' : format(point.house)}</td>
                      <td className="num">{format(point.level)}</td>
                      <td>
                        {point.value == null
                          ? <span className="da-st na">Not enough quarters</span>
                          : !point.tested
                            ? <span className="da-st na">Before first test</span>
                            : <span className={pointStatus.className}>{pointStatus.label}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!test.isLibrary && choices.length > 0 && (
        <section className="da-sec">
          <div className="da-sechead">
            <h2>Start from a library definition</h2>
            <p>Replaces the lines in force from the date you choose. Earlier quarters keep their definition, the way an amendment would.</p>
          </div>
          <div className="cv-copy">
            <label>
              Definition
              <select value={fromId} onChange={(event) => { setFromId(event.target.value); setConfirming(false); }}>
                <option value="">Choose a definition…</option>
                {choices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.componentCount} line{item.componentCount === 1 ? '' : 's'})
                  </option>
                ))}
              </select>
            </label>
            <label>
              First quarter it applies to
              <input type="date" value={effectiveFrom} onChange={(event) => { setEffectiveFrom(event.target.value); setConfirming(false); }} />
            </label>
            {!confirming ? (
              <button type="button" className="btn btn-secondary" disabled={!fromId || !effectiveFrom || busy} onClick={() => setConfirming(true)}>
                Copy definition
              </button>
            ) : (
              <span className="cv-confirm">
                Lines in force on {day(effectiveFrom)} will end the day before.
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void copy()}>
                  {busy ? 'Copying…' : 'Replace definition'}
                </button>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
              </span>
            )}
          </div>
          {fromId && (
            <p className="cv-hint">{library.find((item) => item.id === fromId)?.description}</p>
          )}
        </section>
      )}
    </div>
  );
}
