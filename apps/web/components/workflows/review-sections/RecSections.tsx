'use client';

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { BankTxnRow, CashFlowRow, CashRec } from '@tapestrai/graphql/src/lib/cash-rec';
import type { RecItem } from '@tapestrai/graphql/src/lib/fund-rec';
import type { ProposalItem } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { reviewView, type ProposalView } from '@tapestrai/graphql/src/lib/workflow-views';
import type { FundRec } from '@/lib/fund-rec';
import { graphqlQuery } from '@/lib/graphql';
import { markdownToHtml } from '@/lib/markdown';
import { recKey, type RecKey, type ReviewSection } from '@/lib/review-sections';
import { useTemporalStore } from '@/lib/store';

/**
 * The screens for the reconciliation changes an agent proposes, and for the
 * reconciliation views it asks the reviewer to look at. Each reads the fund's
 * reconciliation through the same queries the reconciliation page uses, with
 * the person's As Of and Knowledge dates, so the review shows the figures the
 * page would.
 */

const REC_QUERY = `
  query ReviewRec($fundId: ID!, $periodEnd: Date, $asOfDate: Date, $knowledgeDate: DateTime) {
    fundRec(fundId: $fundId, periodEnd: $periodEnd, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate)
    cashRec(fundId: $fundId, periodEnd: $periodEnd, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate)
  }
`;

export interface RecData {
  rec: FundRec | null;
  cash: CashRec | null;
  error: string | null;
}

/** Each fund and period's reconciliation, read once. */
export function useRecData(keys: RecKey[]): Map<string, RecData | null> {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const [data, setData] = useState<Record<string, RecData>>({});
  const wanted = keys.map((key) => key.key).join(',');
  useEffect(() => {
    let live = true;
    setData({});
    for (const key of keys) {
      void graphqlQuery<{ fundRec: FundRec | null; cashRec: CashRec | null }>(REC_QUERY, { fundId: key.fundId, periodEnd: key.periodEnd, asOfDate, knowledgeDate }, 'network-only').then((result) => {
        if (!live || result.aborted) return;
        setData((current) => ({ ...current, [key.key]: { rec: result.data?.fundRec ?? null, cash: result.data?.cashRec ?? null, error: result.error?.message || null } }));
      });
    }
    return () => {
      live = false;
    };
    // The keys are compared by their text, so a new array of the same funds does not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, asOfDate, knowledgeDate]);
  return useMemo(() => new Map(keys.map((key) => [key.key, data[key.key] ?? null])), [keys, data]);
}

// ---------------------------------------------------------------------------
// What a section is given by the review
// ---------------------------------------------------------------------------

export type Choice = 'APPROVE' | 'REJECT';

/** The review's decisions, as a section reads and changes them. */
export interface Decider {
  canDecide: boolean;
  choice(item: ProposalItem): Choice | undefined;
  /** Records the choice and moves the review to the next change that needs a person. */
  decide(item: ProposalItem, choice: Choice): void;
  /** A setting as it will run: the agent's value, or the reviewer's edit of it. */
  current(item: ProposalItem, key: string): unknown;
  /** Changes a setting before approving. Null puts the agent's value back. */
  edit(item: ProposalItem, key: string, value: unknown): void;
  status(item: ProposalItem): { text: string; fg: string };
  /** Required questions still open on a change. */
  questions(item: ProposalItem): number;
  /** Every setting, the agent's reasons and evidence: the general view of one change. */
  details(item: ProposalItem): ReactNode;
  register(id: string, element: HTMLElement | null): void;
  expanded: string | null;
  expand(id: string | null): void;
}

interface SectionProps {
  section: ReviewSection;
  data: Map<string, RecData | null>;
  decider: Decider;
  /** Every change in the review, for what the notes have to agree with. */
  all: ProposalItem[];
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

const card: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', padding: 12, display: 'grid', gap: 10 };
const label: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4 };
const cell: CSSProperties = { padding: '4px 8px', borderBottom: '1px solid var(--line)', fontSize: 12.5, textAlign: 'left', verticalAlign: 'top' };
const num: CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const CONFIDENCE: Record<string, { label: string; fg: string; bg: string }> = {
  HIGH: { label: 'Confident', fg: '#166534', bg: '#dcfce7' },
  MEDIUM: { label: 'Fairly sure', fg: '#92400e', bg: '#fde8c0' },
  LOW: { label: 'Unsure', fg: '#b91c1c', bg: '#fee2e2' },
};

/** Signed dollars, cents shown, negatives with a minus. */
export function dollars(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const text = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amount < 0 ? '−' : ''}$${text}`;
}

function figure(value: number, unit: RecItem['unit']): string {
  return unit === 'POINTS' ? `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} pts` : dollars(value);
}

function chip(text: string, fg: string, bg: string) {
  return <span style={{ fontSize: 11, fontWeight: 600, color: fg, background: bg, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>{text}</span>;
}

function fundLine(data: RecData | null | undefined, item: { args: Record<string, unknown> }): string {
  const name = data?.rec?.fundName || data?.cash?.fundName || String(item.args.fundId || '');
  const period = data?.rec?.periodLabel || (typeof item.args.periodEnd === 'string' && item.args.periodEnd) || 'the period now closing';
  return `${name} · ${period}`;
}

function dataFor(data: Map<string, RecData | null>, item: ProposalItem): RecData | null | undefined {
  const key = recKey(item.args.fundId, item.args.periodEnd);
  return key ? data.get(key.key) : undefined;
}

/** The frame every reconciliation change is shown in: what it is, the agent's word, and the decision. */
function ChangeCard({ item, decider, fund, children, blocked }: { item: ProposalItem; decider: Decider; fund: string; children: ReactNode; blocked?: string | null }) {
  const status = decider.status(item);
  const choice = decider.choice(item);
  const open = decider.expanded === item.id;
  const questions = decider.questions(item);
  const confidence = CONFIDENCE[item.confidence] || CONFIDENCE.MEDIUM;
  return (
    <div ref={(element) => decider.register(item.id, element)} style={{ ...card, opacity: choice === 'REJECT' ? 0.7 : 1, boxShadow: open ? 'inset 3px 0 0 #c2410c' : undefined }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13.5 }}>{item.summary}</strong>
        {chip(confidence.label, confidence.fg, confidence.bg)}
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{fund}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: status.fg }}>{status.text}</span>
      </div>
      {children}
      {item.rationale && <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}><b>Why:</b> {item.rationale}</div>}
      {(open || questions > 0) && <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>{decider.details(item)}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {decider.canDecide && (
          <>
            <button type="button" className="btn btn-sm btn-primary" disabled={questions > 0 || Boolean(blocked)} aria-pressed={choice === 'APPROVE'} onClick={() => decider.decide(item, 'APPROVE')}>
              {choice === 'APPROVE' ? 'Approved' : 'Approve'}
            </button>
            <button type="button" className="btn btn-sm" aria-pressed={choice === 'REJECT'} onClick={() => decider.decide(item, 'REJECT')}>
              {choice === 'REJECT' ? 'Rejected' : 'Reject'}
            </button>
          </>
        )}
        {blocked && <span style={{ fontSize: 12, color: '#b45309' }}>{blocked}</span>}
        <button type="button" onClick={() => decider.expand(open ? null : item.id)} style={{ marginLeft: 'auto', border: 'none', background: 'none', padding: 0, fontSize: 12, color: 'var(--entity-link)', cursor: 'pointer' }}>
          {open ? 'Hide the settings' : 'Every setting and the evidence'}
        </button>
      </div>
    </div>
  );
}

function Loading({ data }: { data: RecData | null | undefined }) {
  if (data === undefined) return <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>This change does not name a fund, so the reconciliation cannot be shown.</div>;
  if (data === null) return <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Reading the reconciliation…</div>;
  if (data.error) return <div style={{ fontSize: 12, color: 'var(--red)' }}>The reconciliation could not be read: {data.error}</div>;
  return null;
}

// ---------------------------------------------------------------------------
// Cash pairs
// ---------------------------------------------------------------------------

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function CashPair({ item, data, decider }: { item: ProposalItem; data: RecData | null | undefined; decider: Decider }) {
  const [changing, setChanging] = useState(false);
  const cash = data?.cash || null;
  const bankId = String(item.args.bankTxnId || '');
  const flowIds = idList(decider.current(item, 'flowIds'));
  const proposed = idList(item.args.flowIds);
  const bank = cash?.transactions.find((txn) => txn.id === bankId) || null;
  const flows = flowIds.map((id) => cash?.flows.find((flow) => flow.id === id)).filter((flow): flow is CashFlowRow => Boolean(flow));
  const booked = flows.reduce((sum, flow) => sum + flow.amount, 0);
  const difference = bank ? bank.amount - booked : null;
  const unknown = flowIds.filter((id) => !cash?.flows.some((flow) => flow.id === id));
  // Flows the pair could be changed to: the open ones, nearest the bank amount first, and the ones chosen.
  const candidates = useMemo(() => {
    if (!cash) return [] as CashFlowRow[];
    const target = bank?.amount ?? 0;
    return cash.flows
      .filter((flow) => flow.status === 'OPEN' || flowIds.includes(flow.id))
      .sort((a, b) => Math.abs(a.amount - target) - Math.abs(b.amount - target))
      .slice(0, 25);
  }, [cash, bank, flowIds]);
  const already = bank && bank.status !== 'OPEN' && !proposed.every((id) => bank.flowIds.includes(id));
  const changed = flowIds.join(',') !== proposed.join(',');

  return (
    <ChangeCard item={item} decider={decider} fund={fundLine(data, item)} blocked={flowIds.length === 0 ? 'Choose at least one cash flow.' : null}>
      <Loading data={data} />
      {cash && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
            <div>
              <div style={label}>Bank</div>
              {bank ? (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    <tr><td style={cell}>{bank.date}</td><td style={cell}>{bank.description || bank.reference || bank.code}<div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{[bank.counterparty, bank.accountName].filter(Boolean).join(' · ')}</div></td><td style={num}>{dollars(bank.amount)}</td></tr>
                  </tbody>
                </table>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--red)' }}>This bank transaction is not in the reconciliation for this period.</div>
              )}
              {already && <div style={{ fontSize: 12, color: '#b45309', marginTop: 4 }}>The reconciliation already pairs it {bank?.status === 'APPROVED' ? 'and the pair is locked' : `by ${bank?.ruleName || 'a rule'}`}. Approving this will be refused if either side is taken.</div>}
            </div>
            <div>
              <div style={label}>Book{changed ? ' · changed by you' : ''}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {flows.map((flow) => (
                    <tr key={flow.id}><td style={cell}>{flow.date}</td><td style={cell}>{flow.name}<div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{[flow.positionName, flow.type].filter(Boolean).join(' · ')}</div></td><td style={num}>{dollars(flow.amount)}</td></tr>
                  ))}
                  {flows.length > 1 && <tr><td style={cell} colSpan={2}><b>Book total</b></td><td style={{ ...num, fontWeight: 600 }}>{dollars(booked)}</td></tr>}
                </tbody>
              </table>
              {unknown.length > 0 && <div style={{ fontSize: 12, color: 'var(--red)' }}>{unknown.length === 1 ? 'One cash flow is' : `${unknown.length} cash flows are`} not in the reconciliation for this period.</div>}
            </div>
          </div>
          {difference !== null && (
            <div style={{ fontSize: 13 }}>
              Difference, bank less book: <b style={{ color: Math.abs(difference) < 0.005 ? '#166534' : '#b45309' }}>{Math.abs(difference) < 0.005 ? 'none, the two sides agree' : dollars(difference)}</b>
              {bank && flows.length > 0 && flows.some((flow) => flow.date !== bank.date) && <span style={{ color: 'var(--ink-3)' }}> · dates differ by up to {Math.max(...flows.map((flow) => Math.abs(Date.parse(flow.date) - Date.parse(bank.date)) / 86_400_000)).toFixed(0)} days</span>}
            </div>
          )}
          {decider.canDecide && (
            <div>
              <button type="button" className="btn btn-sm" onClick={() => setChanging(!changing)}>{changing ? 'Done changing the flows' : 'Change the flows'}</button>
              {changed && <button type="button" className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => decider.edit(item, 'flowIds', null)}>Back to the agent’s pair</button>}
              {changing && (
                <div style={{ marginTop: 8, maxHeight: 240, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {candidates.map((flow) => (
                        <tr key={flow.id}>
                          <td style={{ ...cell, width: 24 }}>
                            <input
                              type="checkbox"
                              aria-label={`Pair ${flow.name}`}
                              checked={flowIds.includes(flow.id)}
                              onChange={(event) => decider.edit(item, 'flowIds', event.target.checked ? [...flowIds, flow.id] : flowIds.filter((id) => id !== flow.id))}
                            />
                          </td>
                          <td style={cell}>{flow.date}</td>
                          <td style={cell}>{flow.name}<div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{flow.positionName}</div></td>
                          <td style={num}>{dollars(flow.amount)}</td>
                        </tr>
                      ))}
                      {candidates.length === 0 && <tr><td style={cell}>No open cash flow is left to pair.</td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </ChangeCard>
  );
}

// ---------------------------------------------------------------------------
// Cash adjustments
// ---------------------------------------------------------------------------

function CashAdjustment({ item, data, decider }: { item: ProposalItem; data: RecData | null | undefined; decider: Decider }) {
  const summary = data?.cash?.summary;
  const amount = Number(decider.current(item, 'amount'));
  const side = String(decider.current(item, 'side') || '').toUpperCase();
  const reason = String(decider.current(item, 'reason') || '');
  return (
    <ChangeCard item={item} decider={decider} fund={fundLine(data, item)} blocked={!reason.trim() ? 'An adjustment needs a reason.' : !Number.isFinite(amount) || amount === 0 ? 'Give the amount.' : null}>
      <Loading data={data} />
      {summary && (
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
          Before this adjustment, book less bank is {summary.tied ? 'nil: the two sides tie' : dollars(summary.residual)}. Book {dollars(summary.positionTied)}, bank {dollars(summary.bankTied)}; {summary.openTxnCount} bank and {summary.openFlowCount} book lines are still open.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
          <span style={label}>Side</span>
          <select aria-label="Side" value={side} disabled={!decider.canDecide} onChange={(event) => decider.edit(item, 'side', event.target.value)}>
            <option value="POSITION">Our books</option>
            <option value="BANK">The bank</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
          <span style={label}>Amount, signed</span>
          <input aria-label="Amount" type="number" step="0.01" value={Number.isFinite(amount) ? amount : ''} disabled={!decider.canDecide} onChange={(event) => decider.edit(item, 'amount', event.target.value === '' ? null : Number(event.target.value))} />
        </label>
      </div>
      <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
        <span style={label}>Reason, kept on the reconciliation</span>
        <textarea className="text-input" rows={2} value={reason} disabled={!decider.canDecide} onChange={(event) => decider.edit(item, 'reason', event.target.value)} />
      </label>
      {summary && Number.isFinite(amount) && amount !== 0 && (
        <div style={{ fontSize: 12.5 }}>
          Afterwards, book less bank is <b>{dollars(summary.residual + (side === 'BANK' ? -amount : amount))}</b>{Math.abs(summary.residual + (side === 'BANK' ? -amount : amount)) < 0.005 ? ': the two sides tie' : ''}.
        </div>
      )}
    </ChangeCard>
  );
}

// ---------------------------------------------------------------------------
// Reconciliation decisions
// ---------------------------------------------------------------------------

const DECISION_WORD: Record<string, string> = { ACCEPT: "Accept the administrator's figure", ADJUST: 'Adjust to our figure', QUERY: 'Query the administrator' };

function RecDecision({ item, data, decider }: { item: ProposalItem; data: RecData | null | undefined; decider: Decider }) {
  const itemId = String(item.args.itemId || '');
  const found = data?.rec?.items.find((entry) => entry.id === itemId) || null;
  const decision = String(decider.current(item, 'decision') || '').toUpperCase();
  const note = String(decider.current(item, 'note') || '');
  const needsNote = (decision === 'ADJUST' || decision === 'QUERY') && !note.trim();
  return (
    <ChangeCard item={item} decider={decider} fund={fundLine(data, item)} blocked={needsNote ? `${decision === 'QUERY' ? 'A query' : 'An adjustment'} needs a note.` : null}>
      <Loading data={data} />
      {data?.rec && !found && <div style={{ fontSize: 12, color: 'var(--red)' }}>The close has no review item “{itemId}” for this period.</div>}
      {found && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{found.title}</div>
          <table style={{ borderCollapse: 'collapse', marginTop: 4 }}>
            <thead>
              <tr><th style={{ ...cell, ...label }}>Administrator</th><th style={{ ...cell, ...label }}>Ours</th><th style={{ ...cell, ...label }}>Difference</th><th style={{ ...cell, ...label }}>NAV effect</th></tr>
            </thead>
            <tbody>
              <tr>
                <td style={num}>{figure(found.admin, found.unit)}</td>
                <td style={num}>{figure(found.ours, found.unit)}</td>
                <td style={num}>{figure(found.admin - found.ours, found.unit)}</td>
                <td style={num}>{dollars(found.effect)}</td>
              </tr>
            </tbody>
          </table>
          {found.why && <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 4 }}>{found.why}</div>}
          {found.decision && <div style={{ fontSize: 12, color: '#b45309', marginTop: 4 }}>Already decided on the close: {DECISION_WORD[found.decision] || found.decision}. Approving replaces it.</div>}
        </div>
      )}
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={label}>Decision</span>
        <div role="radiogroup" aria-label="Decision" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['ACCEPT', 'ADJUST', 'QUERY'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={decision === option}
              disabled={!decider.canDecide}
              onClick={() => decider.edit(item, 'decision', option)}
              className="btn btn-sm"
              style={decision === option ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : undefined}
            >
              {DECISION_WORD[option]}
            </button>
          ))}
        </div>
        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
          <span style={label}>{decision === 'QUERY' ? 'The question for the administrator' : 'Note, kept on the file'}</span>
          <textarea className="text-input" rows={3} value={note} disabled={!decider.canDecide} onChange={(event) => decider.edit(item, 'note', event.target.value)} />
        </label>
      </div>
    </ChangeCard>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function RecNotes({ item, data, decider, all }: { item: ProposalItem; data: RecData | null | undefined; decider: Decider; all: ProposalItem[] }) {
  const [preview, setPreview] = useState(false);
  const [showKept, setShowKept] = useState(false);
  const notes = String(decider.current(item, 'notes') || '');
  const kept = data?.rec?.closeNotes?.notes || '';
  const fund = recKey(item.args.fundId, item.args.periodEnd)?.key;
  // The notes were written as if everything else for this fund is approved.
  const rejected = all.filter((other) => other.id !== item.id && recKey(other.args.fundId, other.args.periodEnd)?.key === fund && decider.choice(other) === 'REJECT');
  const undecided = all.filter((other) => other.id !== item.id && recKey(other.args.fundId, other.args.periodEnd)?.key === fund && !decider.choice(other));
  return (
    <ChangeCard item={item} decider={decider} fund={fundLine(data, item)} blocked={!notes.trim() ? 'The notes are empty.' : null}>
      {undecided.length > 0 && <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>Decide the {undecided.length} other change{undecided.length === 1 ? '' : 's'} for this fund first. The notes describe them as approved.</div>}
      {rejected.length > 0 && (
        <div role="alert" style={{ fontSize: 12.5, border: '1px solid #fedf89', background: '#fffaeb', color: '#93370d', borderRadius: 6, padding: '6px 10px' }}>
          You rejected {rejected.length === 1 ? 'a change' : `${rejected.length} changes`} these notes describe as approved: {rejected.map((other) => other.summary).join('; ')}. Edit the notes to match before you approve them.
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-sm" aria-pressed={!preview} onClick={() => setPreview(false)}>Edit</button>
        <button type="button" className="btn btn-sm" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button>
        {kept && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setShowKept(!showKept)}>{showKept ? 'Hide the notes kept now' : 'The notes kept now'}</button>}
      </div>
      {preview ? (
        <div className="markdown-content" style={{ fontSize: 13, lineHeight: 1.55, maxHeight: 420, overflowY: 'auto' }} dangerouslySetInnerHTML={{ __html: markdownToHtml(notes.replace(/^#{4,}\s/gm, '### ')) }} />
      ) : (
        <textarea className="text-input" aria-label="Reconciliation notes" rows={14} style={{ width: '100%', boxSizing: 'border-box', fontSize: 12.5, fontFamily: 'var(--font-mono, monospace)' }} value={notes} disabled={!decider.canDecide} onChange={(event) => decider.edit(item, 'notes', event.target.value)} />
      )}
      {showKept && <div className="markdown-content" style={{ fontSize: 12.5, color: 'var(--ink-2)', borderLeft: '3px solid var(--line-strong)', paddingLeft: 10, maxHeight: 300, overflowY: 'auto' }} dangerouslySetInnerHTML={{ __html: markdownToHtml(kept.replace(/^#{4,}\s/gm, '### ')) }} />}
    </ChangeCard>
  );
}

/** The cards of one reconciliation section. */
export function RecSection({ section, data, decider, all }: SectionProps) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {section.items.map((item) => {
        const found = dataFor(data, item);
        if (section.kind === 'cash-pairs') return <CashPair key={item.id} item={item} data={found} decider={decider} />;
        if (section.kind === 'cash-adjustments') return <CashAdjustment key={item.id} item={item} data={found} decider={decider} />;
        if (section.kind === 'rec-decisions') return <RecDecision key={item.id} item={item} data={found} decider={decider} />;
        return <RecNotes key={item.id} item={item} data={found} decider={decider} all={all} />;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The views the agent chose
// ---------------------------------------------------------------------------

function CashView({ cash, focus }: { cash: CashRec; focus: Set<string> }) {
  const marked = (id: string) => focus.has(id);
  const txns: BankTxnRow[] = cash.transactions.filter((txn) => (focus.size > 0 ? marked(txn.id) : txn.status === 'OPEN')).slice(0, 20);
  const flows: CashFlowRow[] = cash.flows.filter((flow) => (focus.size > 0 ? marked(flow.id) : flow.status === 'OPEN')).slice(0, 20);
  const word: Record<string, string> = { OPEN: 'Open', PROPOSED: 'Paired by a rule', APPROVED: 'Paired' };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 12.5 }}>
        {cash.summary.tied ? <b style={{ color: '#166534' }}>Ties.</b> : <b style={{ color: '#b45309' }}>Differs by {dollars(cash.summary.residual)}.</b>} {cash.summary.matchCount} pairs, {cash.summary.openTxnCount} bank lines ({dollars(cash.summary.openTxnAmount)}) and {cash.summary.openFlowCount} book lines ({dollars(cash.summary.openFlowAmount)}) open.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
        {[
          ['Bank', txns.map((txn) => ({ id: txn.id, date: txn.date, what: txn.description || txn.reference || txn.code, sub: txn.counterparty, amount: txn.amount, status: txn.status }))],
          ['Book', flows.map((flow) => ({ id: flow.id, date: flow.date, what: flow.name, sub: flow.positionName, amount: flow.amount, status: flow.status }))],
        ].map(([title, rows]) => (
          <div key={title as string}>
            <div style={label}>{title as string}{focus.size > 0 ? ', the lines the agent points at' : ', still open'}</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {(rows as Array<{ id: string; date: string; what: string; sub: string; amount: number; status: string }>).map((row) => (
                  <tr key={row.id}>
                    <td style={cell}>{row.date}</td>
                    <td style={cell}>{row.what}<div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{row.sub}</div></td>
                    <td style={num}>{dollars(row.amount)}</td>
                    <td style={{ ...cell, fontSize: 11, color: 'var(--ink-3)' }}>{word[row.status] || row.status}</td>
                  </tr>
                ))}
                {(rows as unknown[]).length === 0 && <tr><td style={{ ...cell, color: 'var(--ink-3)' }}>None.</td></tr>}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

function NavView({ rec, focus }: { rec: FundRec; focus: Set<string> }) {
  const items = rec.items.filter((item) => (focus.size > 0 ? focus.has(item.id) : item.decision == null)).slice(0, 30);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 12.5 }}>
        Reported NAV <b>{dollars(rec.navReported)}</b>, proposed <b>{dollars(rec.navProposed)}</b>. {rec.breaks} {rec.breaks === 1 ? 'check breaks' : 'checks break'}, {rec.missing} missing; {rec.itemsDecided} of {rec.items.length} review items decided.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...cell, ...label }}>Item</th>
            <th style={{ ...cell, ...label, textAlign: 'right' }}>Administrator</th>
            <th style={{ ...cell, ...label, textAlign: 'right' }}>Ours</th>
            <th style={{ ...cell, ...label, textAlign: 'right' }}>NAV effect</th>
            <th style={{ ...cell, ...label }}>On the close</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td style={cell}>{item.title}<div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{item.why}</div></td>
              <td style={num}>{figure(item.admin, item.unit)}</td>
              <td style={num}>{figure(item.ours, item.unit)}</td>
              <td style={num}>{dollars(item.effect)}</td>
              <td style={{ ...cell, fontSize: 12 }}>{item.decision ? DECISION_WORD[item.decision] || item.decision : 'Not decided'}</td>
            </tr>
          ))}
          {items.length === 0 && <tr><td style={{ ...cell, color: 'var(--ink-3)' }} colSpan={5}>Nothing to show.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** What the agent asked the reviewer to look at, each view with its reason. */
export function AgentViews({ views, data }: { views: ProposalView[]; data: Map<string, RecData | null> }) {
  if (views.length === 0) return null;
  return (
    <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', display: 'grid', gap: 10 }}>
      <div style={label}>What the agent wants you to see</div>
      {views.map((view) => {
        const spec = reviewView(view.view);
        const key = recKey(view.args.fundId, view.args.periodEnd);
        const found = key ? data.get(key.key) : undefined;
        const focus = new Set(view.focus);
        return (
          <details key={view.id} open style={card}>
            <summary style={{ cursor: 'pointer', fontSize: 13 }}>
              <b>{spec?.label || view.view}</b> <span style={{ color: 'var(--ink-3)' }}>· {fundLine(found, { args: view.args })}</span>
              {view.why && <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 2 }}>{view.why}</div>}
            </summary>
            <div style={{ marginTop: 8 }}>
              <Loading data={found} />
              {view.view === 'rec.cash' && found?.cash && <CashView cash={found.cash} focus={focus} />}
              {view.view === 'rec.nav' && found?.rec && <NavView rec={found.rec} focus={focus} />}
            </div>
          </details>
        );
      })}
    </div>
  );
}
