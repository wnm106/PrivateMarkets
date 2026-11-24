'use client';

import { Fragment, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { LIST_VALUE_TOOL, setPath, unanswered, unmetListValues, type Confidence, type ItemDecision, type ProposalAction, type ProposalItem } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { ChangeSettings, readArg } from '@/components/workflows/ChangeSettings';
import { ReviewAssignment } from '@/components/workflows/ReviewerPicker';
import { BorrowerViews, FinSection, useCovenantData, useFinData } from '@/components/workflows/review-sections/FinSections';
import { AgentViews, RecSection, useRecData, type Decider } from '@/components/workflows/review-sections/RecSections';
import { useReportProgress } from '@/components/workflows/stages/useProgress';
import { graphqlMutation } from '@/lib/graphql';
import { markdownToHtml } from '@/lib/markdown';
import { byRecord, finKey, finKeys, groupsByRecord, isRecSection, recKey, recKeys, reviewSections, sectioned } from '@/lib/review-sections';
import type { CheckProgress } from '@/lib/workflow-checklist';
import { reviewNextStep, summaryLead } from '@/lib/workflow-run-view';
import { DECIDE_REVIEW, showValue, when, type MutationErrors, type ReviewView } from '@/lib/workflows';

/**
 * A person's review of what an agent step proposed.
 *
 * It is laid out in the order a person decides: what to do now, what the
 * agent found in a few lines, where things stand, then each change with the
 * agent's recommendation and what it rests on. Changes the agent is confident
 * in can be approved together. The rest are walked through one at a time.
 * A person who cannot decide the review reads the same page without the
 * call to act: the run's own banner already says who it is waiting on.
 */

type Choice = 'APPROVE' | 'REJECT';

const ACTION: Record<ProposalAction, { label: string; fg: string; bg: string }> = {
  CREATE: { label: 'Create', fg: '#166534', bg: '#dcfce7' },
  UPDATE: { label: 'Edit', fg: '#0e7490', bg: '#cffafe' },
  DELETE: { label: 'Delete', fg: '#b91c1c', bg: '#fee2e2' },
};
const CONFIDENCE: Record<Confidence, { label: string; fg: string; bg: string }> = {
  HIGH: { label: 'Confident', fg: '#166534', bg: '#dcfce7' },
  MEDIUM: { label: 'Fairly sure', fg: '#92400e', bg: '#fde8c0' },
  LOW: { label: 'Unsure', fg: '#b91c1c', bg: '#fee2e2' },
};

const chip = (fg: string, bg: string): CSSProperties => ({ fontSize: 11, fontWeight: 600, color: fg, background: bg, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' });
const cell: CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--line)', verticalAlign: 'top', fontSize: 13 };
const head: CSSProperties = { ...cell, fontSize: 11, fontWeight: 600, color: 'var(--ink-3)', textAlign: 'left', background: 'var(--bg-alt)' };
const sectionLabel: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 };

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The agent's write-up: a short lead, with the full text a click away. */
function AgentSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lead = useMemo(() => summaryLead(text), [text]);
  // The renderer knows three heading levels. Deeper ones are shown as the third.
  const html = useMemo(() => markdownToHtml(text.replace(/^#{4,}\s/gm, '### ')), [text]);
  // There is more to read when the write-up runs past its first paragraph, or the lead was cut.
  const more = /\n\s*\n/.test(text.trim()) || lead !== summaryLead(text, Infinity);
  return (
    <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
      <div style={sectionLabel}>What the agent found</div>
      {open ? (
        <div className="markdown-content" style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55, maxWidth: 900 }} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, maxWidth: 900 }}>{lead}</div>
      )}
      {more && (
        <button type="button" onClick={() => setOpen(!open)} style={{ border: 'none', background: 'none', padding: 0, marginTop: 4, fontSize: 12, fontWeight: 600, color: 'var(--entity-link)', cursor: 'pointer' }}>
          {open ? 'Show less' : "Read the agent's full write-up"}
        </button>
      )}
    </div>
  );
}

/** Text the reviewer typed, as the kind of value the agent proposed there. */
function coerce(original: unknown, text: string): unknown {
  // A list, such as the cash flows of a pair, is edited as a whole and kept as JSON text.
  if (Array.isArray(original)) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not a list after all: kept as typed.
    }
    return text;
  }
  if (typeof original === 'number') {
    const parsed = Number(text);
    return text.trim() !== '' && Number.isFinite(parsed) ? parsed : text;
  }
  if (typeof original === 'boolean') return text.trim().toLowerCase() === 'true';
  return text;
}

interface Props {
  review: ReviewView;
  /** The caller manages this client's workflows, so may reassign the review. */
  canManage?: boolean;
  onDecided(): void;
  /** Reports how many changes this person has decided, for the run's checklist. */
  onProgress?: (progress: CheckProgress) => void;
}

export function ReviewPanel({ review, canManage = false, onDecided, onProgress }: Props) {
  const items = useMemo<ProposalItem[]>(() => review.proposal?.items || [], [review.proposal]);
  const open = review.status === 'OPEN';
  const canDecide = open && review.canReview;

  const [choices, setChoices] = useState<Record<string, Choice>>(() => {
    const recorded: Record<string, Choice> = {};
    for (const [id, entry] of Object.entries(review.decision?.items || {})) recorded[id] = entry.decision === 'APPROVE' ? 'APPROVE' : 'REJECT';
    return recorded;
  });
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>(() => {
    const recorded: Record<string, Record<string, string>> = {};
    for (const [id, entry] of Object.entries(review.decision?.items || {})) {
      recorded[id] = Object.fromEntries(Object.entries(entry.answers || {}).map(([key, value]) => [key, showValue(value)]));
    }
    // An open review starts with the agent's suggestions filled in. They are a
    // recommendation to edit or accept, and nothing is applied until the change is approved.
    if (open) {
      for (const item of items) {
        for (const field of item.missing) {
          if (field.suggested === undefined || field.suggested === null) continue;
          recorded[item.id] = { [field.key]: showValue(field.suggested), ...(recorded[item.id] || {}) };
        }
      }
    }
    return recorded;
  });
  /** The reviewer's changes to what a change sets, by item and setting. */
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [expanded, setExpanded] = useState<string | null>(() => (open && review.canReview ? items.find((item) => item.needsReview)?.id || null : null));
  const [note, setNote] = useState(review.decision?.note || '');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const rows = useRef<Record<string, HTMLElement | null>>({});

  // The changes in sections by their kind, decided in section order. The rec sections and the agent's views read the fund's reconciliation.
  const sections = useMemo(() => reviewSections(items), [items]);
  const inSections = sectioned(sections);
  const ordered = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const views = useMemo(() => review.proposal?.views || [], [review.proposal]);
  const keys = useMemo(() => recKeys(sections, views), [sections, views]);
  const recData = useRecData(keys);
  // A borrower financials review reads each borrower's quarter, and each covenant a certificate value is for.
  const borrowerKeys = useMemo(() => finKeys(sections, views), [sections, views]);
  const finData = useFinData(borrowerKeys.borrowers);
  const covenantData = useCovenantData(borrowerKeys.covenants);
  /** The review items a decision card shows, so a view does not show them a second time. */
  const decidedBelow = useMemo(() => new Set(items.filter((item) => item.tool === 'record_rec_decision').map((item) => String(item.args.itemId || '')).filter(Boolean)), [items]);

  const confident = items.filter((item) => !item.needsReview);
  const attention = items.filter((item) => item.needsReview);
  const openQuestions = (item: ProposalItem) => unanswered(item, { decision: 'APPROVE', answers: answers[item.id] || {} });
  const approved = items.filter((item) => choices[item.id] === 'APPROVE');
  const rejected = items.filter((item) => choices[item.id] === 'REJECT');
  const undecided = items.filter((item) => !choices[item.id]);
  const blocked = approved.filter((item) => openQuestions(item).length > 0);
  /** What this person has decided for one change so far, as the server will read it. */
  const draftDecision = (item: ProposalItem): ItemDecision => {
    const changed = Object.entries(edits[item.id] || {});
    const args = changed.length > 0 ? changed.reduce((next, [key, text]) => setPath(next, key, coerce(readArg(item.args, key), text)), item.args) : undefined;
    return { decision: 'APPROVE', answers: answers[item.id] || {}, ...(args ? { args } : {}) };
  };
  const approvedIds = new Set(approved.map((item) => item.id));
  /** For an approved change: the new list values it sets whose addition is not approved. */
  const unmet = (item: ProposalItem) => (approvedIds.has(item.id) ? unmetListValues(item, draftDecision(item), { items }, approvedIds) : []);
  const unlinked = approved.filter((item) => unmet(item).length > 0);
  const ready = undecided.length === 0 && blocked.length === 0 && unlinked.length === 0;

  const focus = (id: string | null) => {
    setExpanded(id);
    if (id) requestAnimationFrame(() => rows.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };
  const choose = (id: string, choice: Choice) => setChoices((current) => ({ ...current, [id]: choice }));
  const answer = (id: string, key: string, value: string) => setAnswers((current) => ({ ...current, [id]: { ...(current[id] || {}), [key]: value } }));
  const edit = (item: ProposalItem, key: string, value: string | null) =>
    setEdits((current) => {
      const next = { ...(current[item.id] || {}) };
      // Typing the proposed value back in is not an edit.
      if (value === null || value === showValue(readArg(item.args, key))) delete next[key];
      else next[key] = value;
      return { ...current, [item.id]: next };
    });
  /** The proposed settings with the reviewer's edits applied, or undefined when they changed nothing. */
  const editedArgs = (item: ProposalItem): Record<string, unknown> | undefined => {
    const changed = Object.entries(edits[item.id] || {});
    if (changed.length === 0) return undefined;
    return changed.reduce((args, [key, text]) => setPath(args, key, coerce(readArg(item.args, key), text)), item.args);
  };

  /** The next change that still needs a person: undecided, or approved with a question open. */
  const nextNeeding = (after?: string): ProposalItem | undefined => {
    const pending = (item: ProposalItem) => !choices[item.id] || (choices[item.id] === 'APPROVE' && openQuestions(item).length > 0);
    const start = after ? ordered.findIndex((item) => item.id === after) + 1 : 0;
    const order = [...ordered.slice(start), ...ordered.slice(0, start)].filter((item) => item.id !== after && pending(item));
    // A change comes up once the changes it depends on are decided, so a person never decides it before them.
    const known = new Set(items.map((item) => item.id));
    const unblocked = (item: ProposalItem) => (item.dependsOn || []).every((id) => !known.has(id) || id === after || Boolean(choices[id]));
    // The ones the agent flagged come first; the confident ones can be approved together.
    return order.find((item) => item.needsReview && unblocked(item)) || order.find(unblocked) || order[0];
  };

  const decideAndNext = (item: ProposalItem, choice: Choice) => {
    choose(item.id, choice);
    // The choice just made is not in state yet, so skip this item when looking for the next.
    const next = nextNeeding(item.id);
    focus(next && next.id !== item.id ? next.id : null);
  };

  const submit = async (outcome: 'APPROVED' | 'REJECTED') => {
    setSaving(true);
    setErrors([]);
    const decisionItems: Record<string, { decision: Choice; answers?: Record<string, string>; args?: Record<string, unknown> }> = {};
    for (const item of items) {
      const choice: Choice = outcome === 'REJECTED' ? 'REJECT' : choices[item.id] || 'REJECT';
      const given = Object.fromEntries(Object.entries(answers[item.id] || {}).filter(([, value]) => value.trim() !== ''));
      const args = choice === 'APPROVE' ? editedArgs(item) : undefined;
      decisionItems[item.id] = { decision: choice, ...(choice === 'APPROVE' && Object.keys(given).length > 0 ? { answers: given } : {}), ...(args ? { args } : {}) };
    }
    const { data, error } = await graphqlMutation<{ decideWorkflowReview: { errors: MutationErrors } }>(DECIDE_REVIEW, {
      input: { reviewId: review.id, outcome, decision: { items: decisionItems, ...(note.trim() ? { note: note.trim() } : {}) } },
    });
    setSaving(false);
    const problems = error?.message ? [error.message] : (data?.decideWorkflowReview.errors || []).map((entry) => entry.message);
    if (problems.length > 0) {
      setErrors(problems);
      return;
    }
    onDecided();
  };

  const statusFor = (item: ProposalItem): { text: string; fg: string } => {
    const choice = choices[item.id];
    const questions = openQuestions(item).length;
    if (choice === 'REJECT') return { text: 'Rejected', fg: 'var(--ink-3)' };
    if (questions > 0) return { text: `Needs ${plural(questions, 'answer')}`, fg: '#b45309' };
    if (unmet(item).length > 0) return { text: 'Needs the new list value', fg: '#b91c1c' };
    if (choice === 'APPROVE') return { text: 'Approved', fg: '#166534' };
    // Someone who cannot decide the review is told where each change stands, not asked to act on it.
    if (!canDecide) return { text: open ? 'Not decided yet' : 'Not decided', fg: 'var(--ink-3)' };
    return item.needsReview ? { text: 'Yours to decide', fg: '#b45309' } : { text: 'Ready to approve', fg: 'var(--ink-3)' };
  };

  const decided = items.length - undecided.length;
  useReportProgress(
    canDecide ? onProgress : undefined,
    canDecide
      ? {
          done: decided,
          total: items.length,
          ...(inSections
            ? {
                parts: sections.map((section) => {
                  const done = section.items.filter((item) => choices[item.id]).length;
                  return { label: section.label, done: done === section.items.length, note: `${done} of ${section.items.length} decided` };
                }),
              }
            : {}),
        }
      : null,
  );
  const next = canDecide ? nextNeeding() : undefined;
  const approveConfident = () => setChoices((current) => ({ ...current, ...Object.fromEntries(confident.filter((item) => !current[item.id]).map((item) => [item.id, 'APPROVE' as Choice])) }));
  const applyLabel = approved.length === 0 ? 'Confirm: change nothing' : `Apply ${plural(approved.length, 'approved change')}`;

  /**
   * Everything about one change: what it depends on, every setting, why, and what it is based on.
   * `bare` leaves out the reasons and sources, for a card that already shows them.
   */
  function detailsOf(item: ProposalItem, bare = false): ReactNode {
    return (
      <>
        {item.tool === LIST_VALUE_TOOL && (
          <div style={{ fontSize: 12, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e3a8a', borderRadius: 6, padding: '8px 10px', marginBottom: 10, lineHeight: 1.45 }}>
            <strong>This adds a value to a list every client shares.</strong> Nothing on the list meant the same thing, so the agent proposes a new value. Only a tenant admin can approve it.
            {items.filter((other) => (other.dependsOn || []).includes(item.id)).map((other) => (
              <div key={other.id}>
                Step 1 of 2. Then:{' '}
                <button type="button" onClick={() => focus(other.id)} style={{ border: 'none', background: 'none', padding: 0, color: '#1d4ed8', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}>
                  {other.summary}
                </button>
              </div>
            ))}
          </div>
        )}
        {(item.dependsOn || []).map((id) => items.find((other) => other.id === id)).filter((other): other is ProposalItem => Boolean(other)).map((other) => (
          <div key={other.id} style={{ fontSize: 12, background: unmet(item).length > 0 ? '#fef2f2' : '#eff6ff', border: `1px solid ${unmet(item).length > 0 ? '#fecaca' : '#bfdbfe'}`, color: unmet(item).length > 0 ? '#991b1b' : '#1e3a8a', borderRadius: 6, padding: '8px 10px', marginBottom: 10, lineHeight: 1.45 }}>
            <strong>Step 2 of 2.</strong> This sets a value that is not on the list yet. It needs{' '}
            <button type="button" onClick={() => focus(other.id)} style={{ border: 'none', background: 'none', padding: 0, color: '#1d4ed8', fontWeight: 600, cursor: 'pointer', fontSize: 12 }}>
              {other.summary}
            </button>{' '}
            approved too. {unmet(item).length > 0 ? 'That change is not approved: approve it, or choose a value already on the list here.' : 'Or choose a value already on the list here, and reject the addition.'}
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: bare ? 'minmax(0, 1fr)' : 'minmax(260px, 1fr) minmax(260px, 1fr)', gap: 20 }}>
          <div>
            <div style={sectionLabel}>Exactly what will happen</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>
              {ACTION[item.action].label} via <code>{item.tool}</code>
              {canDecide && '. Change any value here before you approve. What it is aimed at (the record, attribute, and type) is fixed.'}
            </div>
            <ChangeSettings
              item={item}
              canDecide={canDecide}
              answers={answers[item.id] || {}}
              edits={edits[item.id] || {}}
              recordedArgs={(review.decision?.items?.[item.id] as { args?: Record<string, unknown> } | undefined)?.args}
              onAnswer={(key, value) => answer(item.id, key, value)}
              onEdit={(key, value) => edit(item, key, value)}
            />
          </div>
          {!bare && <div>
            <div style={sectionLabel}>Why</div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>{item.rationale || 'The agent gave no reason.'}</div>
            {item.fixes && item.fixes.length > 0 && (
              <>
                <div style={{ ...sectionLabel, marginTop: 12 }}>Data quality checks this clears</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {item.fixes.map((code) => (
                    <span key={code} style={{ ...chip('#166534', '#dcfce7'), fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>{code}</span>
                  ))}
                </div>
              </>
            )}
            {item.evidence.length > 0 && (
              <>
                <div style={{ ...sectionLabel, marginTop: 12 }}>Based on</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                  {item.evidence.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            )}
          </div>}
        </div>
      </>
    );
  }

  /**
   * The general table of changes: one row each, opened to its detail. When a record has several changes,
   * the rows sit under the record's name, said once. A column that would say the same on every row is left out.
   */
  function changeTable(list: ProposalItem[]): ReactNode {
    const groups = byRecord(list);
    const grouped = groupsByRecord(groups);
    const rowsInOrder = grouped ? groups.flatMap((group) => group.items) : list;
    const firstOf = new Map(grouped ? groups.map((group) => [group.items[0].id, group]) : []);
    const mixedActions = new Set(list.map((item) => item.action)).size > 1;
    const columns = 4 + (mixedActions ? 1 : 0) + (grouped ? 0 : 1);
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...head, width: 150 }}>Your decision</th>
              {mixedActions && <th style={{ ...head, width: 70 }}>Action</th>}
              {!grouped && <th style={head}>On</th>}
              <th style={head}>What changes</th>
              <th style={{ ...head, width: 100 }}>Agent is</th>
              <th style={{ ...head, width: 130 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rowsInOrder.map((item) => {
              const choice = choices[item.id];
              const status = statusFor(item);
              const group = firstOf.get(item.id);
              const isOpen = expanded === item.id;
              const attentionIndex = attention.findIndex((candidate) => candidate.id === item.id);
              return (
                <Fragment key={item.id}>
                  {group && (
                    <tr>
                      <td colSpan={columns} style={{ ...cell, background: 'var(--bg-alt)', padding: '7px 10px' }}>
                        <span style={{ fontWeight: 600 }}>{group.label}</span>{' '}
                        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                          · {group.kind} · {plural(group.items.length, 'change')}, {group.items.filter((entry) => choices[entry.id]).length} decided
                        </span>
                      </td>
                    </tr>
                  )}
                  <tr
                    ref={(element) => {
                      rows.current[item.id] = element;
                    }}
                    onClick={() => setExpanded(isOpen ? null : item.id)}
                    style={{ cursor: 'pointer', background: isOpen ? '#f8fafc' : choice === 'REJECT' ? '#fafafa' : undefined, opacity: choice === 'REJECT' ? 0.7 : 1 }}
                  >
                    <td style={cell} onClick={(event) => event.stopPropagation()}>
                      <div style={{ display: 'inline-flex', border: '1px solid var(--line-strong)', borderRadius: 6, overflow: 'hidden' }}>
                        {(['APPROVE', 'REJECT'] as const).map((option) => (
                          <button
                            key={option}
                            type="button"
                            disabled={!canDecide}
                            aria-pressed={choice === option}
                            onClick={() => choose(item.id, option)}
                            style={{
                              border: 'none',
                              padding: '4px 10px',
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: canDecide ? 'pointer' : 'default',
                              background: choice === option ? (option === 'APPROVE' ? '#166534' : '#475569') : '#fff',
                              color: choice === option ? '#fff' : 'var(--ink-2)',
                            }}
                          >
                            {option === 'APPROVE' ? 'Approve' : 'Reject'}
                          </button>
                        ))}
                      </div>
                    </td>
                    {mixedActions && <td style={cell}><span style={chip(ACTION[item.action].fg, ACTION[item.action].bg)}>{ACTION[item.action].label}</span></td>}
                    {!grouped && (
                      <td style={cell}>
                        <div style={{ fontWeight: 600 }}>{item.target.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>{item.target.kind}</div>
                      </td>
                    )}
                    <td style={cell}>
                      {item.summary}
                      {item.fixes && item.fixes.length > 0 && (
                        <div style={{ fontSize: 11, color: '#166534', marginTop: 2 }}>
                          Clears {item.fixes.length === 1 ? 'a failing data quality check' : `${item.fixes.length} failing data quality checks`}
                        </div>
                      )}
                    </td>
                    <td style={cell}><span style={chip(CONFIDENCE[item.confidence].fg, CONFIDENCE[item.confidence].bg)}>{CONFIDENCE[item.confidence].label}</span></td>
                    <td style={{ ...cell, color: status.fg, fontWeight: 600, fontSize: 12 }}>{status.text}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={columns} style={{ ...cell, background: '#f8fafc', padding: '14px 18px' }}>
                        {attentionIndex >= 0 && <div style={{ fontSize: 11, color: '#b45309', fontWeight: 700, marginBottom: 8 }}>NEEDS YOUR ATTENTION · {attentionIndex + 1} OF {attention.length}</div>}
                        {detailsOf(item)}

                        {canDecide && (
                          <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
                            <button type="button" className="btn btn-sm btn-primary" disabled={openQuestions(item).length > 0} onClick={() => decideAndNext(item, 'APPROVE')}>
                              Approve and continue
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => decideAndNext(item, 'REJECT')}>
                              Reject and continue
                            </button>
                            {openQuestions(item).length > 0 && <span style={{ fontSize: 12, color: '#b45309' }}>Answer the required {openQuestions(item).length === 1 ? 'question' : 'questions'} to approve this one.</span>}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  /** How a section of the review reads and changes these decisions. */
  const decider: Decider = {
    canDecide,
    choice: (item) => choices[item.id],
    decide: (item, choice) => decideAndNext(item, choice),
    current: (item, key) => {
      const typed = edits[item.id]?.[key];
      return typed === undefined ? readArg(item.args, key) : coerce(readArg(item.args, key), typed);
    },
    edit: (item, key, value) => edit(item, key, value === null || value === undefined ? null : typeof value === 'string' ? value : typeof value === 'number' ? String(value) : JSON.stringify(value)),
    status: (item) => statusFor(item),
    questions: (item) => openQuestions(item).length,
    details: (item) => detailsOf(item, true),
    register: (id, element) => {
      rows.current[id] = element;
    },
    expanded,
    expand: (id) => setExpanded(id),
  };

  /** A change in a few words: the review item it decides, or what the agent's summary says before its first colon. */
  function shortTitle(item: ProposalItem): string {
    if (item.tool === 'save_reconciliation_notes') return 'The notes kept on the close';
    if (item.tool === 'save_borrower_review') return 'The review notes kept on the quarter';
    if (item.tool === 'record_borrower_covenant_value') {
      const key = finKey(item.args.entityId, item.args.testDate);
      const test = key ? covenantData.get(key.key)?.test : null;
      if (test) return `${test.name}: the certificate value`;
    }
    if (item.tool === 'record_rec_decision') {
      const key = recKey(item.args.fundId, item.args.periodEnd);
      const found = key ? recData.get(key.key)?.rec?.items.find((entry) => entry.id === String(item.args.itemId || '')) : null;
      if (found) return found.title;
    }
    // A short summary is already a title. A long one is cut at its first colon.
    if (item.summary.length <= 72) return item.summary;
    const head = item.summary.split(': ')[0];
    return head.length >= 8 && head.length < item.summary.length ? head : item.summary;
  }

  /** What the person looking at this review has to do now, and the button that does it. */
  function callToAction() {
    const base = reviewNextStep(review);
    let headline = base.headline;
    let detail = base.detail;
    if (canDecide && items.length > 0) {
      if (next) {
        headline = `Next: ${shortTitle(next)}`;
        const questions = openQuestions(next).length;
        detail = `${decided} of ${items.length} decided.${questions > 0 ? ` This one needs ${plural(questions, 'answer')} from you before it can be approved.` : next.needsReview ? ' The agent flagged this one for a close look.' : ''}`;
      } else if (ready) {
        headline = 'Everything is decided.';
        detail = `${approved.length} approved, ${rejected.length} rejected. Nothing is written until you apply.`;
      } else if (unlinked.length > 0) {
        headline = 'An approved change needs its new list value approved too.';
      }
    }
    return (
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', background: '#fff7ed', borderLeft: '4px solid #c2410c', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: '#c2410c' }}>What you need to do</div>
          <div style={{ fontSize: 14.5, fontWeight: 600, marginTop: 2 }}>{headline}</div>
          {detail && <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 2 }}>{detail}</div>}
          {/* Apply can be pressed here, so a refusal is said here too, not only at the foot of the review. */}
          {errors.length > 0 && (
            <div role="alert" style={{ color: 'var(--red)', fontSize: 13, marginTop: 4 }}>
              {errors.map((message) => (
                <div key={message}>{message}</div>
              ))}
            </div>
          )}
        </div>
        {canDecide && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {confident.some((item) => !choices[item.id]) && (
              <button type="button" className="btn btn-sm" onClick={approveConfident}>
                Approve the {confident.length} confident
              </button>
            )}
            {next && expanded !== next.id && (
              <button type="button" className="btn btn-primary" onClick={() => focus(next.id)}>
                Review it now
              </button>
            )}
            {(ready || items.length === 0) && (
              <button type="button" className="btn btn-primary" disabled={saving} onClick={() => submit('APPROVED')}>
                {saving ? 'Recording…' : items.length === 0 ? 'Approve and continue' : applyLabel}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <section style={{ border: '1px solid var(--line-strong)', borderRadius: 8, background: 'var(--surface)', overflow: 'hidden' }}>
      <header style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)', background: open ? '#fffbeb' : 'var(--bg-alt)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 15 }}>{review.title}</strong>
          {!open && <span style={chip(review.status === 'APPROVED' ? '#166534' : '#475569', review.status === 'APPROVED' ? '#dcfce7' : '#f1f5f9')}>{review.status === 'APPROVED' ? 'Approved' : review.status === 'REJECTED' ? 'Rejected' : 'Cancelled'} {when(review.decidedAt)}</span>}
        </div>
        {review.instructions && <div style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-2)' }}>{review.instructions}</div>}
        <ReviewAssignment review={review} canManage={canManage} onChanged={onDecided} />
      </header>

      {canDecide && callToAction()}

      {review.summary && <AgentSummary text={review.summary} />}

      <AgentViews views={views.filter((view) => view.view.startsWith('rec.'))} data={recData} covered={decidedBelow} />
      <BorrowerViews views={views.filter((view) => view.view.startsWith('fin.'))} data={finData} />

      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
        <div style={{ fontSize: 13 }}>
          <strong>{items.length === 0 ? 'Nothing to decide.' : `${plural(items.length, 'thing')} to decide.`}</strong>{' '}
          {items.length > 0 && (attention.length === 0 ? 'The agent is confident in all of them.' : confident.length === 0 ? `The agent asks you to look closely at ${attention.length === 1 ? 'it' : attention.length === 2 ? 'both' : `all ${attention.length}`}.` : `The agent is confident in ${confident.length} and asks you to look closely at ${attention.length}.`)}
          {open && items.length > 0 && ' Nothing is written until the decisions are applied.'}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!inSections && new Set(items.map((item) => item.action)).size > 1 && (['CREATE', 'UPDATE', 'DELETE'] as const).map((action) => {
            const count = items.filter((item) => item.action === action).length;
            return count > 0 ? <span key={action} style={chip(ACTION[action].fg, ACTION[action].bg)}>{count} {ACTION[action].label.toLowerCase()}{count === 1 ? '' : 's'}</span> : null;
          })}
        </div>
      </div>

      {items.length === 0 ? (
        <div style={{ padding: 16, fontSize: 13, color: 'var(--ink-3)' }}>The agent proposed no changes. Approve to let the run continue.</div>
      ) : (
        <>
          {!inSections && changeTable(items)}
          {inSections &&
            sections.map((section, index) => {
              const done = section.items.filter((item) => choices[item.id]).length;
              return (
                <div key={section.kind} style={{ borderBottom: '1px solid var(--line)' }}>
                  <div style={{ padding: '12px 16px 8px', display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>
                      {index + 1}. {section.label}
                    </span>
                    <span style={{ fontSize: 12, color: done === section.items.length ? '#166534' : 'var(--ink-3)', fontWeight: 600 }}>
                      {done} of {section.items.length} decided
                    </span>
                    <span style={{ fontSize: 12.5, color: 'var(--ink-3)', flexBasis: '100%' }}>{section.howTo}</span>
                  </div>
                  {section.kind === 'general' ? (
                    changeTable(section.items)
                  ) : (
                    <div style={{ padding: '0 16px 14px' }}>
                      {isRecSection(section.kind) ? <RecSection section={section} data={recData} decider={decider} all={items} /> : <FinSection section={section} fin={finData} covenants={covenantData} decider={decider} all={items} />}
                    </div>
                  )}
                </div>
              );
            })}
        </>
      )}

      {canDecide && (
        <footer style={{ padding: '12px 16px', display: 'grid', gap: 10, background: 'var(--bg-alt)' }}>
          {errors.length > 0 && (
            <div role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>
              {errors.map((message) => (
                <div key={message}>{message}</div>
              ))}
            </div>
          )}
          <input className="text-input" placeholder="Add a note for the record (optional)" value={note} onChange={(event) => setNote(event.target.value)} />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
              {items.length === 0
                ? 'Nothing will change.'
                : `${approved.length} approved, ${rejected.length} rejected${undecided.length > 0 ? `, ${undecided.length} still to decide` : ''}${blocked.length > 0 ? `, ${plural(blocked.length, 'approval')} waiting on an answer` : ''}${unlinked.length > 0 ? `, ${plural(unlinked.length, 'approval')} needing a new list value approved` : ''}.`}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {items.length > 0 && (
                <button type="button" className="btn" disabled={saving} onClick={() => window.confirm('Reject every proposed change? Nothing will be changed and the run takes its rejected path.') && submit('REJECTED')}>
                  Reject everything
                </button>
              )}
              <button type="button" className="btn btn-primary" disabled={saving || !ready} onClick={() => submit('APPROVED')}>
                {saving
                  ? 'Recording…'
                  : items.length === 0
                    ? 'Approve and continue'
                    : undecided.length > 0
                      ? `${undecided.length} still to decide`
                      : blocked.length > 0
                        ? `${plural(blocked.length, 'answer')} still needed`
                        : unlinked.length > 0
                          ? 'A new list value is not approved'
                        : applyLabel}
              </button>
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>Approved changes are made by the workflow service account and signed with your name. You need permission to edit records to approve. Your decision is kept in the run&apos;s history.</div>
        </footer>
      )}
    </section>
  );
}
