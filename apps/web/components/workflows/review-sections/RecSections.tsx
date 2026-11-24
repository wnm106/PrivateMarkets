'use client';

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { BankTxnRow, CashFlowRow, CashRec } from '@tapestrai/graphql/src/lib/cash-rec';
import type { RecItem } from '@tapestrai/graphql/src/lib/fund-rec';
import type { ProposalItem } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { reviewView, type ProposalView } from '@tapestrai/graphql/src/lib/workflow-views';
import type { FundRec } from '@/lib/fund-rec';
import { graphqlQuery } from '@/lib/graphql';
import { markdownToHtml } from '@/lib/markdown';
import { recKey, shareText, type RecKey, type ReviewSection } from '@/lib/review-sections';
import { useTemporalStore } from '@/lib/store';
import { summaryLead } from '@/lib/workflow-run-view';
import { firstSentence } from '@/lib/workflow-story';

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

/** The words on a card's two buttons, before and after each is pressed. */
export interface CardWords {
  approve: string;
  approved: string;
  reject: string;
  rejected: string;
}

const APPROVE_WORDS: CardWords = { approve: 'Approve', approved: 'Approved', reject: 'Reject', rejected: 'Rejected' };

/** How many of the agent's sources a card lists before the rest are a click away. */
const EVIDENCE_SHOWN = 3;

interface CardProps {
  item: ProposalItem;
  decider: Decider;
  fund: string;
  /** The facts the decision rests on: the figures, the two sides. */
  children: ReactNode;
  /** What the person sets before deciding. Shown after the agent's reasons. */
  controls?: ReactNode;
  blocked?: string | null;
  /** A short name for what is being decided. The agent's own one-line summary when not given. */
  title?: string;
  /** What the agent is putting forward, in a few words: "The agent recommends: accept". */
  agentLine?: string;
  words?: CardWords;
}

/**
 * The frame every reconciliation change is shown in, in the order a person
 * decides it: what it is, the facts, what the agent recommends and what that
 * rests on, the person's own setting, then the decision. Used for every kind
 * of change that has its own card, the reconciliation's and any other.
 */
export function ChangeCard({ item, decider, fund, children, controls, blocked, title, agentLine, words = APPROVE_WORDS }: CardProps) {
  const [allEvidence, setAllEvidence] = useState(false);
  const [exact, setExact] = useState(false);
  const status = decider.status(item);
  const choice = decider.choice(item);
  const open = decider.expanded === item.id;
  const questions = decider.questions(item);
  const confidence = CONFIDENCE[item.confidence] || CONFIDENCE.MEDIUM;
  const evidence = allEvidence ? item.evidence : item.evidence.slice(0, EVIDENCE_SHOWN);
  return (
    <div ref={(element) => decider.register(item.id, element)} style={{ ...card, opacity: choice === 'REJECT' ? 0.75 : 1, boxShadow: open ? 'inset 3px 0 0 #c2410c' : undefined }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14.5 }} title={title ? item.summary : undefined}>{title || item.summary}</strong>
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{fund}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: status.fg }}>{status.text}</span>
      </div>
      {children}
      <div style={{ border: '1px solid #e9d5ff', background: '#faf5ff', borderRadius: 6, padding: '8px 10px', display: 'grid', gap: 4 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 13 }}>
          <b style={{ color: '#6d28d9' }}>{agentLine || 'The agent proposes this change'}</b>
          {chip(confidence.label, confidence.fg, confidence.bg)}
        </div>
        {item.rationale && <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5, maxWidth: 900 }}>{item.rationale}</div>}
        {item.evidence.length > 0 && (
          <div>
            <div style={{ ...label, marginTop: 4 }}>What it checked</div>
            <ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5, maxWidth: 900 }}>
              {evidence.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {item.evidence.length > EVIDENCE_SHOWN && (
              <button type="button" onClick={() => setAllEvidence(!allEvidence)} style={{ border: 'none', background: 'none', padding: 0, marginTop: 2, fontSize: 12, color: 'var(--entity-link)', cursor: 'pointer' }}>
                {allEvidence ? 'Show fewer' : `Show ${item.evidence.length - EVIDENCE_SHOWN} more`}
              </button>
            )}
          </div>
        )}
      </div>
      {controls}
      {(exact || questions > 0) && <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>{decider.details(item)}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {decider.canDecide && (
          <>
            <button type="button" className="btn btn-sm btn-primary" disabled={questions > 0 || Boolean(blocked)} aria-pressed={choice === 'APPROVE'} onClick={() => decider.decide(item, 'APPROVE')}>
              {choice === 'APPROVE' ? words.approved : words.approve}
            </button>
            <button type="button" className="btn btn-sm" aria-pressed={choice === 'REJECT'} onClick={() => decider.decide(item, 'REJECT')}>
              {choice === 'REJECT' ? words.rejected : words.reject}
            </button>
          </>
        )}
        {blocked && <span style={{ fontSize: 12, color: '#b45309' }}>{blocked}</span>}
        <button type="button" aria-expanded={exact} onClick={() => setExact(!exact)} style={{ marginLeft: 'auto', border: 'none', background: 'none', padding: 0, fontSize: 12, color: 'var(--entity-link)', cursor: 'pointer' }}>
          {exact ? 'Hide the exact change' : 'See the exact change'}
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

/** What each choice does, said under the option so nobody has to guess. */
const DECISION_EFFECT: Record<string, string> = {
  ACCEPT: "The administrator's figure stands. The NAV is not changed.",
  ADJUST: 'Our figure is put forward. The proposed NAV moves by the NAV effect.',
  QUERY: 'The item stays open and the question below goes to the administrator.',
};
const DECISION_VERB: Record<string, string> = { ACCEPT: 'accept', ADJUST: 'adjust', QUERY: 'query' };

function RecDecision({ item, data, decider }: { item: ProposalItem; data: RecData | null | undefined; decider: Decider }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const itemId = String(item.args.itemId || '');
  const found = data?.rec?.items.find((entry) => entry.id === itemId) || null;
  const proposed = String(item.args.decision || '').toUpperCase();
  const decision = String(decider.current(item, 'decision') || '').toUpperCase();
  const note = String(decider.current(item, 'note') || '');
  const needsNote = (decision === 'ADJUST' || decision === 'QUERY') && !note.trim();
  // A note the agent wrote for one decision does not fit another, so it is put in front of the person to rewrite.
  const noteIsStale = decision !== proposed && note === String(item.args.note || '') && note.trim() !== '';
  const showNote = noteOpen || needsNote || noteIsStale;
  const difference = found ? found.admin - found.ours : 0;
  const ofFigure = found && found.unit !== 'POINTS' ? shareText(difference, found.admin) : null;
  const ofNav = found && data?.rec?.navReported ? shareText(found.effect, data.rec.navReported) : null;
  const verb = DECISION_VERB[decision] || 'decide';
  return (
    <ChangeCard
      item={item}
      decider={decider}
      fund={fundLine(data, item)}
      title={found?.title}
      agentLine={`The agent recommends: ${(DECISION_WORD[proposed] || proposed).toLowerCase()}`}
      words={{ approve: `Confirm: ${verb}`, approved: `Confirmed: ${verb}`, reject: 'Leave it undecided', rejected: 'Left undecided' }}
      blocked={needsNote ? `${decision === 'QUERY' ? 'A query' : 'An adjustment'} needs a note.` : noteIsStale ? 'Rewrite the note for your decision first.' : null}
      controls={
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={label}>Your decision</span>
          <div role="radiogroup" aria-label="Decision" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 6 }}>
            {(['ACCEPT', 'ADJUST', 'QUERY'] as const).map((option) => {
              const on = decision === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!decider.canDecide}
                  onClick={() => decider.edit(item, 'decision', option)}
                  style={{ textAlign: 'left', padding: '8px 10px', borderRadius: 6, cursor: decider.canDecide ? 'pointer' : 'default', font: 'inherit', background: on ? '#f0f9ff' : '#fff', border: `1.5px solid ${on ? 'var(--accent)' : 'var(--line-strong)'}` }}
                >
                  <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                    <span aria-hidden style={{ color: on ? 'var(--accent)' : 'var(--ink-4)' }}>{on ? '●' : '○'}</span>
                    {DECISION_WORD[option]}
                    {option === proposed && <span style={{ fontSize: 10.5, fontWeight: 700, color: '#6d28d9', background: '#f3e8ff', padding: '0 6px', borderRadius: 999 }}>Agent’s pick</span>}
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{DECISION_EFFECT[option]}</span>
                </button>
              );
            })}
          </div>
          {showNote ? (
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span style={label}>{decision === 'QUERY' ? 'The question for the administrator' : 'Note, kept on the file'}</span>
              {noteIsStale && <span style={{ color: '#b45309' }}>The agent wrote this note for “{(DECISION_WORD[proposed] || proposed).toLowerCase()}”. Rewrite it for your decision.</span>}
              <textarea className="text-input" rows={5} value={note} disabled={!decider.canDecide} onChange={(event) => decider.edit(item, 'note', event.target.value)} />
            </label>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
              <span style={label}>Note, kept on the file</span>{' '}
              {note.trim() ? firstSentence(note, 240) : 'None.'}{' '}
              <button type="button" onClick={() => setNoteOpen(true)} style={{ border: 'none', background: 'none', padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--entity-link)', cursor: 'pointer' }}>
                {decider.canDecide ? 'Read and edit the note' : 'Read the whole note'}
              </button>
            </div>
          )}
        </div>
      }
    >
      <Loading data={data} />
      {data?.rec && !found && <div style={{ fontSize: 12, color: 'var(--red)' }}>The close has no review item “{itemId}” for this period.</div>}
      {found && (
        <div>
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr><th style={{ ...cell, ...label }}>Administrator</th><th style={{ ...cell, ...label }}>Ours</th><th style={{ ...cell, ...label }}>Difference</th><th style={{ ...cell, ...label }}>NAV effect</th></tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ ...num, fontSize: 14, fontWeight: 600 }}>{figure(found.admin, found.unit)}</td>
                <td style={{ ...num, fontSize: 14, fontWeight: 600 }}>{figure(found.ours, found.unit)}</td>
                <td style={{ ...num, fontSize: 14, fontWeight: 600, color: Math.abs(difference) < 0.005 ? '#166534' : '#b45309' }}>{figure(difference, found.unit)}</td>
                <td style={{ ...num, fontSize: 14, fontWeight: 600 }}>{dollars(found.effect)}</td>
              </tr>
            </tbody>
          </table>
          {(ofFigure || ofNav) && (
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 6 }}>
              <b>How big it is:</b> {[ofFigure ? `${ofFigure} of the administrator’s figure` : '', ofNav ? `${ofNav} of the reported NAV of ${dollars(data?.rec?.navReported)}` : ''].filter(Boolean).join(', ')}.
            </div>
          )}
          {found.why && <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 4, maxWidth: 900 }}><b>How ours is worked out:</b> {found.why}</div>}
          {found.decision && <div style={{ fontSize: 12, color: '#b45309', marginTop: 4 }}>Already decided on the close: {DECISION_WORD[found.decision] || found.decision}. Confirming replaces it.</div>}
        </div>
      )}
    </ChangeCard>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/** The headings of a markdown write-up, so a folded one still says what it covers. */
function headings(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean);
}

function RecNotes({ item, data, decider, all }: { item: ProposalItem; data: RecData | null | undefined; decider: Decider; all: ProposalItem[] }) {
  const fund = recKey(item.args.fundId, item.args.periodEnd)?.key;
  // The notes were written as if everything else for this fund is approved.
  const related = all.filter((other) => other.id !== item.id && recKey(other.args.fundId, other.args.periodEnd)?.key === fund);
  return <NotesCard item={item} decider={decider} subject={fundLine(data, item)} title="Notes kept on the close" kept={data?.rec?.closeNotes?.notes || ''} related={related} label="Reconciliation notes" />;
}

interface NotesProps {
  item: ProposalItem;
  decider: Decider;
  /** What the notes are about: the fund and period, the borrower and quarter. */
  subject: string;
  title: string;
  /** The notes kept now, to compare with. */
  kept: string;
  /** The other changes these notes describe as approved. */
  related: ProposalItem[];
  /** What the notes are called, for a screen reader. */
  label: string;
}

/**
 * A write-up an agent proposes to keep, read from the change's `notes` setting. It opens folded to its
 * first paragraph, and says when a change it describes as approved was turned down.
 */
export function NotesCard({ item, decider, subject, title, kept, related, label: notesLabel }: NotesProps) {
  // The notes open folded: their first paragraph says how things stand, and the rest is a click away.
  const [mode, setMode] = useState<'folded' | 'read' | 'edit'>('folded');
  const [showKept, setShowKept] = useState(false);
  const notes = String(decider.current(item, 'notes') || '');
  const rejected = related.filter((other) => decider.choice(other) === 'REJECT');
  const undecided = related.filter((other) => !decider.choice(other));
  const sections = headings(notes);
  const edited = notes !== String(item.args.notes || '');
  const pick = (next: 'read' | 'edit') => setMode(mode === next ? 'folded' : next);
  return (
    <ChangeCard
      item={item}
      decider={decider}
      fund={subject}
      title={title}
      agentLine="The agent wrote these notes"
      words={{ approve: 'Keep these notes', approved: 'Notes kept', reject: 'Do not keep them', rejected: 'Not kept' }}
      blocked={!notes.trim() ? 'The notes are empty.' : null}
    >
      {decider.canDecide && undecided.length > 0 && <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>Decide the {undecided.length} other change{undecided.length === 1 ? '' : 's'} they describe first. The notes describe {undecided.length === 1 ? 'it' : 'them'} as approved.</div>}
      {rejected.length > 0 && (
        <div role="alert" style={{ fontSize: 12.5, border: '1px solid #fedf89', background: '#fffaeb', color: '#93370d', borderRadius: 6, padding: '6px 10px' }}>
          You turned down {rejected.length === 1 ? 'a change' : `${rejected.length} changes`} these notes describe as approved: {rejected.map((other) => other.summary).join('; ')}. Edit the notes to match before you keep them.
        </div>
      )}
      <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, maxWidth: 900 }}>
        {summaryLead(notes, 420) || 'The notes are empty.'}
        {edited && <span style={{ color: '#b45309', fontWeight: 600 }}> Edited by you.</span>}
      </div>
      {mode === 'folded' && sections.length > 1 && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>The full notes cover: {sections.join(', ')}.</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" aria-pressed={mode === 'read'} onClick={() => pick('read')}>{mode === 'read' ? 'Fold the notes' : 'Read the full notes'}</button>
        {decider.canDecide && <button type="button" className="btn btn-sm" aria-pressed={mode === 'edit'} onClick={() => pick('edit')}>{mode === 'edit' ? 'Done editing' : 'Edit'}</button>}
        {kept && <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setShowKept(!showKept)}>{showKept ? 'Hide the notes kept now' : 'Compare with the notes kept now'}</button>}
      </div>
      {mode === 'read' && <div className="markdown-content" style={{ fontSize: 13, lineHeight: 1.55, maxHeight: 460, overflowY: 'auto', borderTop: '1px solid var(--line)', paddingTop: 8 }} dangerouslySetInnerHTML={{ __html: markdownToHtml(notes.replace(/^#{4,}\s/gm, '### ')) }} />}
      {mode === 'edit' && (
        <textarea className="text-input" aria-label={notesLabel} rows={14} style={{ width: '100%', boxSizing: 'border-box', fontSize: 12.5, fontFamily: 'var(--font-mono, monospace)' }} value={notes} disabled={!decider.canDecide} onChange={(event) => decider.edit(item, 'notes', event.target.value)} />
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

/** One figure of a view, with what it is under it. */
function Tile({ name, value, tone }: { name: string; value: string; tone?: 'good' | 'warn' | 'bad' }) {
  const fg = tone === 'good' ? '#166534' : tone === 'warn' ? '#b45309' : tone === 'bad' ? '#b91c1c' : 'var(--ink)';
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '6px 10px', minWidth: 0 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: fg, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{name}</div>
    </div>
  );
}

/** A fund's close in five figures, then the review items the agent points at that no card below already shows. */
function NavView({ rec, focus, covered }: { rec: FundRec; focus: Set<string>; covered: Set<string> }) {
  const pointed = rec.items.filter((item) => (focus.size > 0 ? focus.has(item.id) : item.decision == null));
  const items = pointed.filter((item) => !covered.has(item.id)).slice(0, 30);
  const below = pointed.length - pointed.filter((item) => !covered.has(item.id)).length;
  const moved = rec.navReported != null && rec.navProposed != null && Math.abs(rec.navProposed - rec.navReported) >= 0.005;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 8 }}>
        <Tile name="Reported NAV" value={dollars(rec.navReported)} />
        <Tile name={moved ? 'Proposed NAV, after adjustments' : 'Proposed NAV, unchanged'} value={dollars(rec.navProposed)} tone={moved ? 'warn' : undefined} />
        <Tile name={rec.breaks === 1 ? 'check breaks' : 'checks break'} value={String(rec.breaks)} tone={rec.breaks > 0 ? 'bad' : 'good'} />
        <Tile name={rec.missing === 1 ? 'check cannot be made' : 'checks cannot be made'} value={String(rec.missing)} tone={rec.missing > 0 ? 'warn' : 'good'} />
        <Tile name="review items decided" value={`${rec.itemsDecided} of ${rec.items.length}`} tone={rec.itemsDecided === rec.items.length ? 'good' : 'warn'} />
      </div>
      {below > 0 && <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{below === 1 ? 'The item the agent points at is the decision below.' : `${below} of the items the agent points at are the decisions below.`}</div>}
      {items.length > 0 && <table style={{ width: '100%', borderCollapse: 'collapse' }}>
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
        </tbody>
      </table>}
    </div>
  );
}

/**
 * What the agent asked the reviewer to look at. A view shows where things
 * stand; a row a decision card below already shows is not repeated here, and
 * the agent's reason for a view whose rows are all below is folded away.
 */
export function AgentViews({ views, data, covered }: { views: ProposalView[]; data: Map<string, RecData | null>; covered?: Set<string> }) {
  if (views.length === 0) return null;
  const decided = covered || new Set<string>();
  return (
    <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', display: 'grid', gap: 10 }}>
      <div style={label}>Where things stand</div>
      {views.map((view) => {
        const spec = reviewView(view.view);
        const key = recKey(view.args.fundId, view.args.periodEnd);
        const found = key ? data.get(key.key) : undefined;
        const focus = new Set(view.focus);
        // The agent's reason restates the item when every row it points at has its own card below.
        const allBelow = view.view === 'rec.nav' && view.focus.length > 0 && view.focus.every((id) => decided.has(id));
        return (
          <div key={view.id} style={card}>
            <div style={{ fontSize: 13 }}>
              <b>{spec?.label || view.view}</b> <span style={{ color: 'var(--ink-3)' }}>· {fundLine(found, { args: view.args })}</span>
            </div>
            {view.why && !allBelow && <div style={{ fontSize: 12.5, color: 'var(--ink-2)', maxWidth: 900 }}>{view.why}</div>}
            <Loading data={found} />
            {view.view === 'rec.cash' && found?.cash && <CashView cash={found.cash} focus={focus} />}
            {view.view === 'rec.nav' && found?.rec && <NavView rec={found.rec} focus={focus} covered={decided} />}
            {view.why && allBelow && (
              <details style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
                <summary style={{ cursor: 'pointer', color: 'var(--entity-link)', fontSize: 12 }}>Why the agent shows this</summary>
                <div style={{ marginTop: 4, maxWidth: 900 }}>{view.why}</div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
