'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { changeText, covenantUnit, figureText, type BorrowerFinancials, type CovenantCheck, type LineUnit, type TrendRow } from '@tapestrai/graphql/src/lib/borrower-financials';
import { covenantStatus, type CovenantStatus, type CovenantTest } from '@tapestrai/graphql/src/lib/covenant-test';
import type { ProposalItem } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { reviewView, type ProposalView } from '@tapestrai/graphql/src/lib/workflow-views';
import { graphqlQuery } from '@/lib/graphql';
import { finKey, type FinKey, type ReviewSection } from '@/lib/review-sections';
import { useTemporalStore } from '@/lib/store';
import { ChangeCard, NotesCard, type Decider } from './RecSections';

/**
 * The screens for a borrower financials review: where the borrower stands
 * (how its lines moved, each covenant beside the borrower's certificate), the
 * card that records a certificate value, and the quarter's review notes.
 *
 * Everything is read through the same queries the borrower's own pages use, at
 * the person's As Of and Knowledge dates, so the review shows the figures the
 * pages would. Nothing is calculated here.
 */

const FIN_QUERY = `
  query ReviewBorrower($borrowerId: ID!, $periodEnd: Date, $asOfDate: Date, $knowledgeDate: DateTime) {
    borrowerFinancials(borrowerId: $borrowerId, periodEnd: $periodEnd, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate)
  }
`;

const COVENANT_QUERY = `
  query ReviewCovenant($covenantId: ID!, $asOfDate: Date) {
    covenantTest(covenantId: $covenantId, asOfDate: $asOfDate, history: 4) {
      covenantId name dealName metric direction unit level testDate value status cushion house beforeFirstTest
      reported { sourceCode sourceName value validFrom }
    }
  }
`;

export interface FinData {
  financials: BorrowerFinancials | null;
  error: string | null;
}

/** Each borrower and quarter of a review, read once. */
export function useFinData(keys: FinKey[]): Map<string, FinData | null> {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [data, setData] = useState<Record<string, FinData>>({});
  const wanted = keys.map((key) => key.key).join(',');
  useEffect(() => {
    let live = true;
    setData({});
    for (const key of keys) {
      void graphqlQuery<{ borrowerFinancials: BorrowerFinancials | null }>(FIN_QUERY, { borrowerId: key.entityId, periodEnd: key.periodEnd, asOfDate, knowledgeDate }, 'network-only').then((result) => {
        if (!live || result.aborted) return;
        setData((current) => ({ ...current, [key.key]: { financials: result.data?.borrowerFinancials ?? null, error: result.error?.message || null } }));
      });
    }
    return () => {
      live = false;
    };
    // The keys are compared by their text, so a new array of the same borrowers does not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, asOfDate, knowledgeDate]);
  return useMemo(() => new Map(keys.map((key) => [key.key, data[key.key] ?? null])), [keys, data]);
}

type CovenantRead = Pick<CovenantTest, 'covenantId' | 'name' | 'dealName' | 'metric' | 'direction' | 'unit' | 'level' | 'testDate' | 'value' | 'status' | 'cushion' | 'house' | 'beforeFirstTest' | 'reported'>;

export interface CovenantData {
  test: CovenantRead | null;
  error: string | null;
}

/** Each covenant a certificate value is proposed for, tested at the quarter the certificate covers. */
export function useCovenantData(keys: FinKey[]): Map<string, CovenantData | null> {
  const [data, setData] = useState<Record<string, CovenantData>>({});
  const wanted = keys.map((key) => key.key).join(',');
  useEffect(() => {
    let live = true;
    setData({});
    for (const key of keys) {
      void graphqlQuery<{ covenantTest: CovenantRead | null }>(COVENANT_QUERY, { covenantId: key.entityId, asOfDate: key.periodEnd }, 'network-only').then((result) => {
        if (!live || result.aborted) return;
        setData((current) => ({ ...current, [key.key]: { test: result.data?.covenantTest ?? null, error: result.error?.message || null } }));
      });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  return useMemo(() => new Map(keys.map((key) => [key.key, data[key.key] ?? null])), [keys, data]);
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

const label: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4 };
const cell: CSSProperties = { padding: '5px 8px', borderBottom: '1px solid var(--line)', fontSize: 12.5, textAlign: 'left', verticalAlign: 'top' };
const num: CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const card: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', padding: 12, display: 'grid', gap: 10 };

const STATUS: Record<CovenantStatus, { text: string; fg: string; bg: string }> = {
  PASS: { text: 'Inside the limit', fg: '#166534', bg: '#dcfce7' },
  WATCH: { text: 'Close to the limit', fg: '#92400e', bg: '#fde8c0' },
  BREACH: { text: 'Past the limit', fg: '#b91c1c', bg: '#fee2e2' },
  NO_DATA: { text: 'No figure', fg: '#475569', bg: '#f1f5f9' },
};

function chip(text: string, fg: string, bg: string) {
  return <span style={{ fontSize: 11, fontWeight: 600, color: fg, background: bg, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>{text}</span>;
}

function Tile({ name, value, tone }: { name: string; value: string; tone?: 'good' | 'warn' | 'bad' }) {
  const fg = tone === 'good' ? '#166534' : tone === 'warn' ? '#b45309' : tone === 'bad' ? '#b91c1c' : 'var(--ink)';
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '6px 10px', minWidth: 0 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: fg, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{name}</div>
    </div>
  );
}

function Loading({ data }: { data: { error: string | null } | null | undefined }) {
  if (data === undefined) return <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>This does not name a record, so its figures cannot be shown.</div>;
  if (data === null) return <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Reading the figures…</div>;
  if (data.error) return <div style={{ fontSize: 12, color: 'var(--red)' }}>The figures could not be read: {data.error}</div>;
  return null;
}

/** A change. Whether up is good depends on the line, so a sharp move is marked by its size and not as good or bad. */
function Move({ change, unit, notable }: { change: number | null; unit: LineUnit; notable: boolean }) {
  const text = changeText(change, unit);
  return <span style={{ fontWeight: notable ? 700 : 400, color: change == null ? 'var(--ink-4)' : notable ? '#b45309' : 'var(--ink-2)' }}>{change == null ? '—' : text}</span>;
}

/** Which side of its limit a figure falls. */
function sideOf(direction: string | null, limit: number | null, value: number | null): CovenantStatus {
  return covenantStatus(direction, limit, value);
}

// ---------------------------------------------------------------------------
// Where the borrower stands
// ---------------------------------------------------------------------------

const TRENDS_SHOWN = 8;

function CovenantTable({ covenants, focus }: { covenants: CovenantCheck[]; focus: Set<string> }) {
  if (covenants.length === 0) return <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>No covenant is on file for this borrower’s deals.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...cell, ...label }}>Covenant</th>
            <th style={{ ...cell, ...label, textAlign: 'right' }}>Limit</th>
            <th style={{ ...cell, ...label, textAlign: 'right' }}>Our calculation</th>
            <th style={{ ...cell, ...label, textAlign: 'right' }}>Certificate</th>
            <th style={{ ...cell, ...label, textAlign: 'right' }}>Difference</th>
            <th style={{ ...cell, ...label, textAlign: 'right' }}>Cushion</th>
            <th style={{ ...cell, ...label }}>Where it stands</th>
          </tr>
        </thead>
        <tbody>
          {covenants.map((check) => {
            const status = STATUS[check.status];
            const certified = check.certificate == null ? null : sideOf(check.direction, check.limit, check.certificate);
            // The finding that matters most: the borrower certifies inside the limit and our calculation is past it, or the other way round.
            const split = certified !== null && (certified === 'BREACH') !== (check.status === 'BREACH');
            return (
              <tr key={check.covenantId} style={{ background: focus.has(check.covenantId) ? '#fffbeb' : undefined }}>
                <td style={cell}>
                  <div style={{ fontWeight: 600 }}>{check.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
                    {[check.dealName, check.direction === 'MIN' ? 'must stay at or above the limit' : 'must stay at or below the limit', check.beforeFirstTest ? 'before its first test: shown, not scored' : ''].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td style={num}>{figureText(check.limit, check.unit)}</td>
                <td style={{ ...num, fontWeight: 600 }}>{figureText(check.calculated, check.unit)}</td>
                <td style={num}>{check.certificate == null ? <span style={{ color: '#b45309' }}>Not on file</span> : figureText(check.certificate, check.unit)}</td>
                <td style={{ ...num, color: check.agrees === false ? '#b45309' : 'var(--ink-3)', fontWeight: check.agrees === false ? 700 : 400 }}>
                  {check.difference == null ? '—' : check.agrees ? 'Agrees' : `${check.difference > 0 ? '+' : '−'}${figureText(Math.abs(check.difference), check.unit)}`}
                </td>
                <td style={num}>{check.cushion == null ? '—' : figureText(check.cushion, 'percent')}</td>
                <td style={cell}>
                  {chip(status.text, status.fg, status.bg)}
                  {split && <div style={{ fontSize: 11.5, color: '#b91c1c', fontWeight: 600, marginTop: 3 }}>The certificate puts it {certified === 'BREACH' ? 'past' : 'inside'} the limit.</div>}
                  {check.stale && <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 3 }}>The stored value is behind the definition.</div>}
                  {check.missing.length > 0 && <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 3 }}>Not on file: {check.missing.join(', ')}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TrendTable({ trends, focus, quarter }: { trends: TrendRow[]; focus: Set<string>; quarter: string }) {
  const [all, setAll] = useState(false);
  // What the agent points at and what moved sharply come first; the statement's own order is kept within each.
  const ordered = useMemo(() => [...trends].sort((a, b) => Number(focus.has(b.code)) - Number(focus.has(a.code)) || Number(b.notable) - Number(a.notable)), [trends, focus]);
  const rows = all ? ordered : ordered.slice(0, TRENDS_SHOWN);
  if (trends.length === 0) return null;
  return (
    <div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...cell, ...label }}>Line</th>
            <th style={{ ...cell, ...label, textAlign: 'right' }}>{quarter}</th>
            <th style={{ ...cell, ...label, textAlign: 'right' }}>On the quarter</th>
            <th style={{ ...cell, ...label, textAlign: 'right' }}>On the year</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.code} style={{ background: focus.has(row.code) ? '#fffbeb' : undefined }}>
              <td style={cell}>{row.name}</td>
              <td style={{ ...num, fontWeight: 600 }}>{figureText(row.latest, row.unit)}</td>
              <td style={num}><Move change={row.onQuarter} unit={row.unit} notable={row.notable} /></td>
              <td style={num}><Move change={row.onYear} unit={row.unit} notable={row.notable} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {trends.length > TRENDS_SHOWN && (
        <button type="button" onClick={() => setAll(!all)} style={{ border: 'none', background: 'none', padding: 0, marginTop: 4, fontSize: 12, color: 'var(--entity-link)', cursor: 'pointer' }}>
          {all ? 'Show fewer lines' : `Show all ${trends.length} lines`}
        </button>
      )}
    </div>
  );
}

/** One borrower's quarter: five figures, the covenants beside the certificate, then how the lines moved. */
export function BorrowerView({ financials, focus }: { financials: BorrowerFinancials; focus: Set<string> }) {
  const { counts } = financials;
  if (financials.note) return <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{financials.note}</div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 8 }}>
        <Tile name={financials.onFile ? 'statement on file' : 'no statement on file'} value={financials.periodLabel} tone={financials.onFile ? undefined : 'bad'} />
        <Tile name={counts.breaches === 1 ? 'covenant past its limit' : 'covenants past the limit'} value={String(counts.breaches)} tone={counts.breaches > 0 ? 'bad' : 'good'} />
        <Tile name={counts.watch === 1 ? 'covenant close to its limit' : 'covenants close to the limit'} value={String(counts.watch)} tone={counts.watch > 0 ? 'warn' : 'good'} />
        <Tile name={counts.certificateMissing > 0 && counts.certificateDiffers === 0 ? 'certificate values not on file' : 'certificate values that differ'} value={String(counts.certificateDiffers || counts.certificateMissing)} tone={counts.certificateDiffers + counts.certificateMissing > 0 ? 'warn' : 'good'} />
        <Tile name={counts.notable === 1 ? 'line moving sharply' : 'lines moving sharply'} value={String(counts.notable)} tone={counts.notable > 0 ? 'warn' : undefined} />
      </div>
      <div>
        <div style={{ ...label, marginBottom: 2 }}>Covenants, tested at {financials.periodEnd || 'the quarter end'}</div>
        <CovenantTable covenants={financials.covenants} focus={focus} />
      </div>
      <div>
        <div style={{ ...label, marginBottom: 2 }}>How the lines moved</div>
        <TrendTable trends={financials.trends} focus={focus} quarter={financials.periodLabel} />
      </div>
    </div>
  );
}

/** The borrower views an agent asked the reviewer to look at, each with its reason. */
export function BorrowerViews({ views, data }: { views: ProposalView[]; data: Map<string, FinData | null> }) {
  if (views.length === 0) return null;
  return (
    <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', display: 'grid', gap: 10 }}>
      <div style={label}>Where the borrower stands</div>
      {views.map((view) => {
        const key = finKey(view.args.entityId, view.args.periodEnd);
        const found = key ? data.get(key.key) : undefined;
        return (
          <div key={view.id} style={card}>
            <div style={{ fontSize: 13 }}>
              <b>{found?.financials?.borrower.name || reviewView(view.view)?.label || view.view}</b>
              {found?.financials && <span style={{ color: 'var(--ink-3)' }}> · {found.financials.periodLabel}</span>}
            </div>
            {view.why && <div style={{ fontSize: 12.5, color: 'var(--ink-2)', maxWidth: 900 }}>{view.why}</div>}
            <Loading data={found} />
            {found?.financials && <BorrowerView financials={found.financials} focus={new Set(view.focus)} />}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A certificate value
// ---------------------------------------------------------------------------

function CertificateValue({ item, data, decider }: { item: ProposalItem; data: CovenantData | null | undefined; decider: Decider }) {
  const test = data?.test || null;
  const unit = covenantUnit(test?.unit ?? null);
  const proposed = Number(item.args.value);
  const value = Number(decider.current(item, 'value'));
  const note = String(decider.current(item, 'note') || '');
  const testDate = String(item.args.testDate || '').slice(0, 10);
  const onFile = test?.reported.find((reading) => reading.sourceCode !== 'MANUAL' && reading.value != null)?.value ?? null;
  const ours = test ? sideOf(test.direction, test.level, test.value) : null;
  const theirs = test && Number.isFinite(value) ? sideOf(test.direction, test.level, value) : null;
  const difference = test?.value != null && Number.isFinite(value) ? value - test.value : null;
  const split = ours !== null && theirs !== null && (ours === 'BREACH') !== (theirs === 'BREACH');
  return (
    <ChangeCard
      item={item}
      decider={decider}
      fund={[test?.dealName, testDate ? `tested at ${testDate}` : ''].filter(Boolean).join(' · ')}
      title={test ? `${test.name}: the borrower’s certificate` : undefined}
      agentLine={`The agent read ${Number.isFinite(proposed) ? figureText(proposed, unit) : 'this figure'} off the certificate`}
      words={{ approve: 'Record this value', approved: 'Value recorded', reject: 'Do not record it', rejected: 'Not recorded' }}
      blocked={!Number.isFinite(value) ? 'Give the figure on the certificate.' : null}
      controls={
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 200px) minmax(0, 1fr)', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span style={label}>Figure on the certificate</span>
            <input aria-label="Figure on the certificate" className="text-input" type="number" step="any" value={Number.isFinite(value) ? value : ''} disabled={!decider.canDecide} onChange={(event) => decider.edit(item, 'value', event.target.value === '' ? null : Number(event.target.value))} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span style={label}>Where it is in the certificate</span>
            <input aria-label="Where it is in the certificate" className="text-input" value={note} disabled={!decider.canDecide} onChange={(event) => decider.edit(item, 'note', event.target.value)} />
          </label>
        </div>
      }
    >
      <Loading data={data} />
      {data && !data.error && !test && <div style={{ fontSize: 12, color: 'var(--red)' }}>This covenant is not on file, or you may not see it.</div>}
      {test && (
        <div>
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...cell, ...label, textAlign: 'right' }}>Limit</th>
                <th style={{ ...cell, ...label, textAlign: 'right' }}>Our calculation</th>
                <th style={{ ...cell, ...label, textAlign: 'right' }}>Certificate</th>
                <th style={{ ...cell, ...label, textAlign: 'right' }}>Difference</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ ...num, fontSize: 14, fontWeight: 600 }}>{figureText(test.level, unit)}</td>
                <td style={{ ...num, fontSize: 14, fontWeight: 600 }}>{figureText(test.value, unit)}</td>
                <td style={{ ...num, fontSize: 14, fontWeight: 600 }}>{Number.isFinite(value) ? figureText(value, unit) : '—'}</td>
                <td style={{ ...num, fontSize: 14, fontWeight: 600, color: difference != null && Math.abs(difference) > Math.abs(test.value || 0) * 0.02 ? '#b45309' : '#166534' }}>
                  {difference == null ? '—' : `${difference > 0 ? '+' : difference < 0 ? '−' : ''}${figureText(Math.abs(difference), unit)}`}
                </td>
              </tr>
            </tbody>
          </table>
          <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 6 }}>
            The covenant {test.direction === 'MIN' ? 'must stay at or above' : 'must stay at or below'} {figureText(test.level, unit)}.{' '}
            {ours && <>Our calculation is {STATUS[ours].text.toLowerCase()}. </>}
            {theirs && <span style={{ fontWeight: split ? 700 : 400, color: split ? '#b91c1c' : undefined }}>The certificate’s figure is {STATUS[theirs].text.toLowerCase()}{split ? ', so the two disagree on whether the covenant holds' : ''}.</span>}
          </div>
          {onFile != null && Math.abs(onFile - value) > 1e-9 && <div style={{ fontSize: 12, color: '#b45309', marginTop: 4 }}>A certificate value of {figureText(onFile, unit)} is already on file for this quarter. Recording this one replaces it.</div>}
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>Recording the value changes neither our calculation nor the covenant’s status. It is kept beside them.</div>
        </div>
      )}
    </ChangeCard>
  );
}

// ---------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------

interface SectionProps {
  section: ReviewSection;
  fin: Map<string, FinData | null>;
  covenants: Map<string, CovenantData | null>;
  decider: Decider;
  all: ProposalItem[];
}

/** The cards of one borrower financials section. */
export function FinSection({ section, fin, covenants, decider, all }: SectionProps) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {section.items.map((item) => {
        if (section.kind === 'fin-certificates') {
          const key = finKey(item.args.entityId, item.args.testDate);
          return <CertificateValue key={item.id} item={item} data={key ? covenants.get(key.key) : undefined} decider={decider} />;
        }
        const key = finKey(item.args.entityId, item.args.periodEnd);
        const found = key ? fin.get(key.key) : undefined;
        // The notes describe the other changes for the same borrower as approved.
        const related = all.filter((other) => other.id !== item.id && (item.dependsOn || []).includes(other.id));
        return (
          <NotesCard
            key={item.id}
            item={item}
            decider={decider}
            subject={[found?.financials?.borrower.name, found?.financials?.periodLabel].filter(Boolean).join(' · ')}
            title="Review notes kept on the quarter"
            kept={found?.financials?.reviewNotes || ''}
            related={related}
            label="Review notes"
          />
        );
      })}
    </div>
  );
}
