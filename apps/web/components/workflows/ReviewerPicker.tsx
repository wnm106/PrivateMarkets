'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { REASSIGN_REVIEW, REVIEWER_CHOICES_QUERY, assigneeText, dueText, type MutationErrors, type ReviewView, type ReviewerChoices } from '@/lib/workflows';

/**
 * Who a review is for. The picker is used twice: on a review step in the
 * editor, and to reassign an open review. Only people who hold workflow.review
 * in the client, and roles that grant it, are offered. The database checks the
 * same thing when a review is opened or reassigned.
 */

const hint: CSSProperties = { fontSize: 11, color: 'var(--ink-4)', lineHeight: 1.4 };
const box: CSSProperties = { display: 'grid', gap: 4, maxHeight: 160, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 8px', background: 'var(--surface)' };
const tick: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 };
const head: CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--ink-3)' };

export function useReviewerChoices(clientId: string | null | undefined) {
  const [choices, setChoices] = useState<ReviewerChoices | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void graphqlQuery<{ workflowReviewerChoices: ReviewerChoices }>(REVIEWER_CHOICES_QUERY, { clientId: clientId || null }, 'network-only').then((result) => {
      if (!live || result.aborted) return;
      if (result.error) setError(result.error.message || 'The people who can review could not be read.');
      else setChoices(result.data?.workflowReviewerChoices || { people: [], roles: [] });
    });
    return () => {
      live = false;
    };
  }, [clientId]);
  return { choices, error };
}

function toggle(list: string[], value: string, on: boolean): string[] {
  return on ? (list.includes(value) ? list : [...list, value]) : list.filter((entry) => entry !== value);
}

interface PickerProps {
  clientId: string | null | undefined;
  people: string[];
  roles: string[];
  onChange(next: { people: string[]; roles: string[] }): void;
}

export function ReviewerPicker({ clientId, people, roles, onChange }: PickerProps) {
  const { choices, error } = useReviewerChoices(clientId);
  if (error) return <span style={{ ...hint, color: 'var(--red)' }}>{error}</span>;
  if (!choices) return <span style={hint}>Reading who can review…</span>;

  // A value that is not offered (a placeholder, or someone who has since lost the permission) stays visible so it can be removed.
  const extraPeople = people.filter((id) => !choices.people.some((person) => person.id === id));
  const extraRoles = roles.filter((code) => !choices.roles.some((role) => role.code === code));

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {(choices.people.length > 0 || extraPeople.length > 0) && (
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={head}>People</span>
          <div style={box}>
            {choices.people.map((person) => (
              <label key={person.id} style={tick}>
                <input type="checkbox" checked={people.includes(person.id)} onChange={(event) => onChange({ people: toggle(people, person.id, event.target.checked), roles })} />
                {person.name}
              </label>
            ))}
            {extraPeople.map((id) => (
              <label key={id} style={tick}>
                <input type="checkbox" checked onChange={() => onChange({ people: people.filter((entry) => entry !== id), roles })} />
                <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{id}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={head}>Roles</span>
        <div style={box}>
          {choices.roles.length === 0 && extraRoles.length === 0 && <span style={hint}>No role grants the review permission.</span>}
          {choices.roles.map((role) => (
            <label key={role.code} style={tick}>
              <input type="checkbox" checked={roles.includes(role.code)} onChange={(event) => onChange({ people, roles: toggle(roles, role.code, event.target.checked) })} />
              {role.name}
            </label>
          ))}
          {extraRoles.map((code) => (
            <label key={code} style={tick}>
              <input type="checkbox" checked onChange={() => onChange({ people, roles: roles.filter((entry) => entry !== code) })} />
              {code}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

interface AssignmentProps {
  review: ReviewView;
  /** The run's caller manages workflows, so can reassign whatever the review says. */
  canManage: boolean;
  onChanged(): void;
}

/** The line under a review's title: who it is for, when it is due, and reassigning it. */
export function ReviewAssignment({ review, canManage, onChanged }: AssignmentProps) {
  const open = review.status === 'OPEN';
  const [editing, setEditing] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const due = open ? dueText(review.dueAt) : null;
  const canReassign = open && (canManage || review.canReview);

  const start = () => {
    setPeople((review.assignees || []).filter((entry) => entry.kind === 'person').map((entry) => entry.id));
    setRoles((review.assignees || []).filter((entry) => entry.kind === 'role').map((entry) => entry.id));
    setNote('');
    setError('');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    const { data, error: failed } = await graphqlMutation<{ reassignWorkflowReview: { errors: MutationErrors } }>(REASSIGN_REVIEW, {
      input: { reviewId: review.id, people, roles, note: note.trim() || null },
    });
    setSaving(false);
    const problems = failed?.message ? [failed.message] : (data?.reassignWorkflowReview.errors || []).map((entry) => entry.message);
    if (problems.length > 0) {
      setError(problems.join(' '));
      return;
    }
    setEditing(false);
    onChanged();
  };

  return (
    <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: 'var(--ink-3)' }}>
        <span>
          For <strong style={{ color: 'var(--ink-2)' }}>{assigneeText(review.assignees)}</strong>
        </span>
        {due && <span style={{ fontWeight: 600, color: review.overdue ? '#b91c1c' : 'var(--ink-3)' }}>{due}</span>}
        {review.separateReviewer && review.startedByName && <span>Not {review.startedByName}, who started the run</span>}
        {!open && review.decidedByName && <span>Decided by {review.decidedByName}</span>}
        {canReassign && !editing && (
          <button type="button" onClick={start} style={{ border: 'none', background: 'none', padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--entity-link)', cursor: 'pointer' }}>
            Reassign
          </button>
        )}
      </div>
      {editing && (
        <div style={{ display: 'grid', gap: 8, padding: 10, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg-alt)', maxWidth: 420 }}>
          <ReviewerPicker clientId={review.clientId} people={people} roles={roles} onChange={(next) => { setPeople(next.people); setRoles(next.roles); }} />
          <span style={hint}>Tick nobody to open it to anyone who can review.</span>
          <input className="text-input" placeholder="Why (kept in the run's history)" value={note} onChange={(event) => setNote(event.target.value)} />
          {error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{error}</span>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Reassign'}
            </button>
            <button type="button" className="btn btn-sm" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
