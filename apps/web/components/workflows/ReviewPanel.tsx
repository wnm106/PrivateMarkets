'use client';

import { Fragment, useMemo, useRef, useState, type CSSProperties } from 'react';
import { setPath, unanswered, type Confidence, type ProposalAction, type ProposalItem } from '@tapestrai/graphql/src/lib/workflow-proposal';
import { ChangeSettings, readArg } from '@/components/workflows/ChangeSettings';
import { graphqlMutation } from '@/lib/graphql';
import { markdownToHtml } from '@/lib/markdown';
import { DECIDE_REVIEW, showValue, when, type MutationErrors, type ReviewView } from '@/lib/workflows';

/**
 * A person's review of what an agent step proposed.
 *
 * The table lists every change with how sure the agent is. Changes it is
 * confident in can be approved together. The rest are walked through one at a
 * time: what exactly will change, why, what it is based on, and the questions
 * that have to be answered before it can run.
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

const LONG_SUMMARY = 700;

/** The agent's summary, formatted. A long one is folded so the changes stay in view. */
function AgentSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_SUMMARY;
  // The renderer knows three heading levels. Deeper ones are shown as the third.
  const html = useMemo(() => markdownToHtml(text.replace(/^#{4,}\s/gm, '### ')), [text]);
  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
      <div style={sectionLabel}>What the agent found</div>
      <div style={{ position: 'relative', maxHeight: long && !open ? 210 : undefined, overflow: 'hidden' }}>
        <div className="markdown-content" style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55, maxWidth: 900 }} dangerouslySetInnerHTML={{ __html: html }} />
        {long && !open && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 44, background: 'linear-gradient(rgba(255,255,255,0), var(--surface))' }} />}
      </div>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} style={{ border: 'none', background: 'none', padding: 0, marginTop: 6, fontSize: 12, fontWeight: 600, color: 'var(--entity-link)', cursor: 'pointer' }}>
          {open ? 'Show less' : 'Read the full summary'}
        </button>
      )}
    </div>
  );
}

/** Text the reviewer typed, as the kind of value the agent proposed there. */
function coerce(original: unknown, text: string): unknown {
  if (typeof original === 'number') {
    const parsed = Number(text);
    return text.trim() !== '' && Number.isFinite(parsed) ? parsed : text;
  }
  if (typeof original === 'boolean') return text.trim().toLowerCase() === 'true';
  return text;
}

interface Props {
  review: ReviewView;
  onDecided(): void;
}

export function ReviewPanel({ review, onDecided }: Props) {
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const [note, setNote] = useState(review.decision?.note || '');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const rows = useRef<Record<string, HTMLTableRowElement | null>>({});

  const confident = items.filter((item) => !item.needsReview);
  const attention = items.filter((item) => item.needsReview);
  const openQuestions = (item: ProposalItem) => unanswered(item, { decision: 'APPROVE', answers: answers[item.id] || {} });
  const approved = items.filter((item) => choices[item.id] === 'APPROVE');
  const rejected = items.filter((item) => choices[item.id] === 'REJECT');
  const undecided = items.filter((item) => !choices[item.id]);
  const blocked = approved.filter((item) => openQuestions(item).length > 0);
  const ready = undecided.length === 0 && blocked.length === 0;

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
    const start = after ? items.findIndex((item) => item.id === after) + 1 : 0;
    const order = [...items.slice(start), ...items.slice(0, start)].filter((item) => item.id !== after && pending(item));
    // The ones the agent flagged come first; the confident ones can be approved together.
    return order.find((item) => item.needsReview) || order[0];
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
    if (choice === 'APPROVE') return { text: 'Approved', fg: '#166534' };
    return item.needsReview ? { text: 'Look closely', fg: '#b45309' } : { text: 'Ready to approve', fg: 'var(--ink-3)' };
  };

  return (
    <section style={{ border: '1px solid var(--line-strong)', borderRadius: 8, background: 'var(--surface)', overflow: 'hidden' }}>
      <header style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)', background: open ? '#fffbeb' : 'var(--bg-alt)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={chip('#92400e', '#fde8c0')}>Human review</span>
          <strong style={{ fontSize: 15 }}>{review.title}</strong>
          {!open && <span style={chip(review.status === 'APPROVED' ? '#166534' : '#475569', review.status === 'APPROVED' ? '#dcfce7' : '#f1f5f9')}>{review.status === 'APPROVED' ? 'Approved' : review.status === 'REJECTED' ? 'Rejected' : 'Cancelled'} {when(review.decidedAt)}</span>}
        </div>
        {review.instructions && <div style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-2)' }}>{review.instructions}</div>}
        {open && !review.canReview && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--red)' }}>You can see this review but cannot decide it. Someone with the review permission needs to.</div>}
      </header>

      {review.summary && <AgentSummary text={review.summary} />}

      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
        <div style={{ fontSize: 13 }}>
          <strong>{plural(items.length, 'change')} proposed.</strong>{' '}
          {items.length > 0 && (
            <>
              The agent is confident in {confident.length}
              {attention.length > 0 ? `, and ${attention.length} ${attention.length === 1 ? 'needs' : 'need'} your attention` : ''}.
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['CREATE', 'UPDATE', 'DELETE'] as const).map((action) => {
            const count = items.filter((item) => item.action === action).length;
            return count > 0 ? <span key={action} style={chip(ACTION[action].fg, ACTION[action].bg)}>{count} {ACTION[action].label.toLowerCase()}{count === 1 ? '' : 's'}</span> : null;
          })}
        </div>
        {canDecide && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {confident.some((item) => !choices[item.id]) && (
              <button type="button" className="btn btn-sm" onClick={() => setChoices((current) => ({ ...current, ...Object.fromEntries(confident.filter((item) => !current[item.id]).map((item) => [item.id, 'APPROVE' as Choice])) }))}>
                Approve the {confident.length} confident
              </button>
            )}
            {nextNeeding() && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => focus(nextNeeding()?.id || null)}>
                {expanded ? 'Next one needing you' : 'Walk me through what needs me'}
              </button>
            )}
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <div style={{ padding: 16, fontSize: 13, color: 'var(--ink-3)' }}>The agent proposed no changes. Approve to let the run continue.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...head, width: 150 }}>Your decision</th>
                <th style={{ ...head, width: 70 }}>Action</th>
                <th style={head}>On</th>
                <th style={head}>What changes</th>
                <th style={{ ...head, width: 100 }}>Agent is</th>
                <th style={{ ...head, width: 130 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const choice = choices[item.id];
                const status = statusFor(item);
                const isOpen = expanded === item.id;
                const attentionIndex = attention.findIndex((candidate) => candidate.id === item.id);
                return (
                  <Fragment key={item.id}>
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
                      <td style={cell}><span style={chip(ACTION[item.action].fg, ACTION[item.action].bg)}>{ACTION[item.action].label}</span></td>
                      <td style={cell}>
                        <div style={{ fontWeight: 600 }}>{item.target.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>{item.target.kind}</div>
                      </td>
                      <td style={cell}>{item.summary}</td>
                      <td style={cell}><span style={chip(CONFIDENCE[item.confidence].fg, CONFIDENCE[item.confidence].bg)}>{CONFIDENCE[item.confidence].label}</span></td>
                      <td style={{ ...cell, color: status.fg, fontWeight: 600, fontSize: 12 }}>{status.text}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6} style={{ ...cell, background: '#f8fafc', padding: '14px 18px' }}>
                          {attentionIndex >= 0 && <div style={{ fontSize: 11, color: '#b45309', fontWeight: 700, marginBottom: 8 }}>NEEDS YOUR ATTENTION · {attentionIndex + 1} OF {attention.length}</div>}
                          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(260px, 1fr)', gap: 20 }}>
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
                            <div>
                              <div style={sectionLabel}>Why</div>
                              <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>{item.rationale || 'The agent gave no reason.'}</div>
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
                            </div>
                          </div>

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
                : `${approved.length} approved, ${rejected.length} rejected${undecided.length > 0 ? `, ${undecided.length} still to decide` : ''}${blocked.length > 0 ? `, ${plural(blocked.length, 'approval')} waiting on an answer` : ''}.`}
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
                        : approved.length === 0
                          ? 'Confirm: change nothing'
                          : `Apply ${plural(approved.length, 'approved change')}`}
              </button>
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>Approved changes are made by the workflow service account and signed with your name. You need permission to edit records to approve. Your decision is kept in the run&apos;s history.</div>
        </footer>
      )}
    </section>
  );
}
