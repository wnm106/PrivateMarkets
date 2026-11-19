'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { relativeTime } from '@/lib/home';
import { DECIDE_REVIEW } from '@/lib/workflows';
import {
  DECISION_REVIEW_QUERY,
  approvedNote,
  decisionCard,
  primaryAction,
  trustLine,
  type DecisionCard,
  type DecisionReview,
} from '@/lib/home-decisions';

/**
 * Workflow reviews the person can decide, shown with enough to decide them
 * here. A card whose changes are all ready is approved in place; any other is
 * opened and reviewed in full.
 */

type CardState = { status: 'idle' } | { status: 'saving' } | { status: 'done'; note: string } | { status: 'failed'; message: string };

function Card({ card }: { card: DecisionCard }) {
  const [state, setState] = useState<CardState>({ status: 'idle' });
  const action = primaryAction(card);
  const trust = trustLine(card);

  async function approve() {
    if (!card.approveAll || state.status === 'saving') return;
    setState({ status: 'saving' });
    const result = await graphqlMutation<{ decideWorkflowReview: { review: { id: string; status: string } | null; errors: Array<{ message: string }> } }>(DECIDE_REVIEW, {
      input: { reviewId: card.id, outcome: 'APPROVED', decision: card.approveAll },
    });
    const errors = result.data?.decideWorkflowReview.errors || [];
    if (result.error || errors.length > 0) {
      setState({ status: 'failed', message: errors.map((error) => error.message).join(' ') || result.error?.message || 'The approval could not be recorded.' });
      return;
    }
    setState({ status: 'done', note: approvedNote(card) });
  }

  if (state.status === 'done') {
    return (
      <li className="home-decision is-done">
        <div className="home-decision-text">
          <div className="home-decision-title">{card.title}</div>
          <div className="home-decision-done">
            <span className="home-clear-mark" aria-hidden>✓</span>
            {state.note} <Link href={card.href}>See the run</Link>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className={`home-decision${card.overdue ? ' is-overdue' : ''}`}>
      <div className="home-decision-text">
        <div className="home-decision-from">
          <span className="home-decision-agent">{card.from}</span>
          <span className="home-muted">
            {relativeTime(card.createdAt)}
            {card.dueAt ? ` · ${card.overdue ? 'was due' : 'due'} ${relativeTime(card.dueAt)}` : ''}
          </span>
        </div>
        <div className="home-decision-title">{card.title}</div>
        {card.summary && <p className="home-decision-summary">{card.summary}</p>}
        {card.lines.length > 0 && (
          <ul className="home-decision-lines">
            {card.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
            {card.more > 0 && <li className="home-muted">and {card.more} more</li>}
          </ul>
        )}
        {trust && <div className={`home-decision-trust confidence-${(card.confidence || 'medium').toLowerCase()}`}>{trust}</div>}
        {state.status === 'failed' && <div role="alert" className="home-decision-problem">{state.message}</div>}
      </div>
      <div className="home-decision-actions">
        {action.kind === 'approve' ? (
          <>
            <button type="button" className="btn btn-sm btn-primary" onClick={approve} disabled={state.status === 'saving'}>
              {state.status === 'saving' ? 'Approving…' : action.label}
            </button>
            <Link href={card.href} className="btn btn-sm">Open</Link>
          </>
        ) : (
          <Link href={card.href} className="btn btn-sm btn-primary">{action.label}</Link>
        )}
      </div>
    </li>
  );
}

/** Loads each review's proposal and shows it as a card. A review that cannot be loaded is left to the list below. */
export function DecisionCards({ reviewIds, onShown }: { reviewIds: string[]; onShown(ids: string[]): void }) {
  const [cards, setCards] = useState<DecisionCard[] | null>(null);
  const key = reviewIds.join(',');

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    if (ids.length === 0) {
      setCards([]);
      onShown([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      ids.map((id) => graphqlQuery<{ workflowReview: DecisionReview | null }, { id: string }>(DECISION_REVIEW_QUERY, { id }, 'network-only')),
    ).then((results) => {
      if (cancelled) return;
      const loaded = results
        .map((result) => result.data?.workflowReview)
        .filter((review): review is DecisionReview => Boolean(review && review.canReview))
        .map(decisionCard);
      setCards(loaded);
      onShown(loaded.map((card) => card.id));
    });
    return () => {
      cancelled = true;
    };
    // onShown is a state setter in the caller; the ids are what this depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!cards || cards.length === 0) return null;
  return (
    <div className="home-decisions">
      <div className="home-lane-head">
        <h3>
          Needs your decision
          <span className="home-lane-count">{cards.length}</span>
        </h3>
        <span className="home-muted">Approve here when every change is ready. Otherwise open it.</span>
      </div>
      <ul className="home-decision-list">
        {cards.map((card) => (
          <Card key={card.id} card={card} />
        ))}
      </ul>
    </div>
  );
}
