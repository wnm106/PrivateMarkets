'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { graphqlMutation, graphqlQuery } from '@/lib/graphql';
import { domainHref } from '@/lib/domain-routes';
import { usePublishPageData, usePublishViewContext } from '@/lib/view-context';
import { useAttributeInspect } from '@/components/detail/AttributeInspect';
import {
  actionsFor,
  APPROVAL_VIEWS,
  approvalCounts,
  approvalsStory,
  decisionText,
  recordName,
  requestsForView,
  STATUS_LABEL,
  type ApprovalView,
  type OverrideRequest,
} from '@/lib/override-approvals';

/**
 * Manual values waiting for a second person, in clients that require four
 * eyes. The database decides who may approve: never the person who entered
 * the value (supabase/migrations/20261126120000_four_eyes_approvals.sql).
 * Waiting, Decided and Everything are filters over one list, not tabs.
 */

const QUERY = `query OverrideRequests($status: String) { overrideRequests(status: $status) }`;
const DECIDE = `mutation DecideOverrideRequest($id: ID!, $approve: Boolean!, $note: String) {
  decideOverrideRequest(id: $id, approve: $approve, note: $note) { success errors { message } }
}`;
const WITHDRAW = `mutation WithdrawOverrideRequest($id: ID!) {
  withdrawOverrideRequest(id: $id) { success errors { message } }
}`;

type Result = { success: boolean; errors: Array<{ message: string }> };

function when(value: string): string {
  return new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function ApprovalsPage() {
  const [view, setView] = useState<ApprovalView>('waiting');
  const [rows, setRows] = useState<OverrideRequest[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [explained, setExplained] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);
  const inspect = useAttributeInspect().open;

  const status = APPROVAL_VIEWS.find((item) => item.id === view)?.status ?? 'PENDING';

  const load = useCallback(() => {
    let live = true;
    setRows(null);
    void graphqlQuery<{ overrideRequests: OverrideRequest[] }>(QUERY, { status }, 'network-only').then((result) => {
      if (!live) return;
      if (result.error) {
        setMessage(result.error.message);
        setRows([]);
        return;
      }
      setRows(result.data?.overrideRequests ?? []);
    });
    return () => {
      live = false;
    };
  }, [status]);

  useEffect(() => load(), [load]);

  // A right-click note on a figure worked out here closes on the next click or key.
  useEffect(() => {
    if (!explained) return;
    const close = () => setExplained(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [explained]);

  const explain = (event: React.MouseEvent, title: string, lines: string[]) => {
    event.preventDefault();
    event.stopPropagation();
    setExplained({ x: Math.min(event.clientX, window.innerWidth - 380), y: Math.min(event.clientY + 8, window.innerHeight - 160), title, lines });
  };

  const act = async (row: OverrideRequest, action: 'approve' | 'reject' | 'withdraw') => {
    setBusy(row.id);
    setMessage(null);
    const result = action === 'withdraw'
      ? await graphqlMutation<{ withdrawOverrideRequest: Result }>(WITHDRAW, { id: row.id })
      : await graphqlMutation<{ decideOverrideRequest: Result }>(DECIDE, { id: row.id, approve: action === 'approve', note: action === 'reject' ? note.trim() || null : null });
    const payload = (result.data as Record<string, Result | undefined> | undefined)?.[action === 'withdraw' ? 'withdrawOverrideRequest' : 'decideOverrideRequest'];
    const error = result.error?.message || payload?.errors?.[0]?.message;
    setBusy(null);
    if (error || !payload?.success) {
      setMessage(error || 'That was not saved.');
      return;
    }
    setRejecting(null);
    setNote('');
    load();
  };

  const shown = rows ? requestsForView(view, rows) : null;
  const counts = approvalCounts(rows ?? []);

  usePublishViewContext({ activity: 'viewing', kind: 'approvals', label: 'Approvals', summary: 'Manual values waiting for a second person to approve them' });
  usePublishPageData({
    approvals: {
      purpose: 'Manual values entered in clients that require four eyes. Each takes effect only once someone other than the person who entered it approves it.',
      howToRead:
        'Waiting requests have not changed any value yet. "You can approve" is false for your own entries and where you lack the approve manual values permission or write access to the record. Approving writes the value from its effective date; rejecting or withdrawing writes nothing.',
      view,
      data: shown === null ? null : approvalsStory(shown),
    },
  });

  return (
    <div className="da x-approvals view-fade">
      <header className="da-ribbon">
        <div className="da-title">
          <span className="da-chip">Four eyes</span>
          <h1>Approvals</h1>
          <p>Manual values someone entered in a client that needs a second person to approve them. Nobody approves their own.</p>
        </div>
        <div className="da-facts">
          {([
            ['Waiting', counts.waiting, 'Requests waiting for approval in the list loaded below.'],
            ['For you', counts.forMe, 'Waiting requests you may approve: entered by someone else, on a record you can change, and you hold the approve manual values permission.'],
            ['Yours', counts.mine, 'Waiting requests you entered. Someone else has to approve them; you can withdraw them.'],
          ] as const).map(([label, value, how]) => (
            <div key={label} className="da-fact">
              <span>{label}</span>
              <strong>
                <span data-derived="approval-count" title="Right-click: how this is counted" onContextMenu={(event) => explain(event, `${label}: ${value}`, [how, rows === null ? 'Still loading.' : `Counted from the ${rows.length} requests loaded for this view.`])}>
                  {rows === null ? '—' : value}
                </span>
              </strong>
            </div>
          ))}
        </div>
      </header>

      <div className="da-sec">
        <div className="da-sechead">
          <div>
            <h2>Requests</h2>
            <p>Right-click a field to see its sources and the value in force now.</p>
          </div>
          <div className="da-tabs" role="group" aria-label="Which requests" style={{ margin: 0 }}>
            {APPROVAL_VIEWS.map((item) => (
              <button key={item.id} type="button" aria-pressed={view === item.id} className={view === item.id ? 'on' : ''} onClick={() => setView(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {message && <div role="alert" style={{ color: 'var(--red)', margin: '12px 0' }}>{message}</div>}
        {shown === null && !message && <div style={{ color: 'var(--ink-3)', margin: '16px 0' }}>Reading requests…</div>}
        {shown !== null && shown.length === 0 && (
          <div className="x-approvals-empty">
            {view === 'waiting' ? 'Nothing is waiting for approval.' : 'No requests here.'} Manual values wait here only in clients that require four eyes.
          </div>
        )}

        {shown !== null && shown.length > 0 && (
          <div className="da-gridwrap x-approvals-frame">
            <table className="da-grid">
              <thead>
                <tr>
                  <th>Entered</th><th>Record</th><th>Field</th><th>New value</th><th>From</th><th>Reason</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  const can = actionsFor(row);
                  return (
                    <tr key={row.id}>
                      <td>{when(row.requestedAt)}<small>{row.requestedByName}{row.mine ? ' (you)' : ''}</small></td>
                      <td>
                        {row.domainCode ? <Link href={`${domainHref(row.domainCode)}/${row.entityId}`}>{recordName(row)}</Link> : recordName(row)}
                        {row.entityCode && row.entityName ? <small>{row.entityCode}</small> : null}
                      </td>
                      <td>
                        <span
                          data-attr={row.attributeCode}
                          title="Right-click: sources and the value in force"
                          onContextMenu={(event) => {
                            event.preventDefault();
                            inspect({
                              entityId: row.entityId,
                              entityCode: row.entityCode ?? undefined,
                              entityName: row.entityName ?? undefined,
                              attributeCode: row.attributeCode,
                              attributeName: row.attributeName,
                              dataType: row.dataType ?? undefined,
                              domainCode: row.domainCode ?? undefined,
                              asOfDate: row.validFrom,
                            });
                          }}
                        >
                          {row.attributeName}
                        </span>
                      </td>
                      <td className="x-approvals-value">
                        <span
                          data-derived="requested-value"
                          title="Right-click: where this value comes from"
                          onContextMenu={(event) =>
                            explain(event, `${row.attributeName}: ${row.value ?? '—'}`, [
                              `Entered by ${row.requestedByName} on ${when(row.requestedAt)} as a manual value, effective from ${row.validFrom}.`,
                              row.status === 'APPROVED'
                                ? `Written to the record when ${row.decidedByName ?? 'the approver'} approved it.`
                                : row.status === 'PENDING'
                                  ? 'Not stored on the record yet: it takes effect when someone else approves it.'
                                  : 'Never stored on the record.',
                              `Reason given: ${row.reason}`,
                            ])
                          }
                        >
                          {row.value ?? '—'}
                        </span>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{row.validFrom}</td>
                      <td>{row.reason}</td>
                      <td>
                        {STATUS_LABEL[row.status]}
                        <small>{row.status === 'PENDING' ? (row.canDecide ? 'You can approve' : row.blocker ?? '') : decisionText(row)}</small>
                      </td>
                      <td>
                        <div className="x-approvals-actions">
                        {can.decide && rejecting !== row.id && (
                          <>
                            <button type="button" className="btn btn-primary" disabled={busy === row.id} onClick={() => act(row, 'approve')}>Approve</button>
                            <button type="button" className="btn" disabled={busy === row.id} onClick={() => { setRejecting(row.id); setNote(''); }}>Reject</button>
                          </>
                        )}
                        {can.decide && rejecting === row.id && (
                          <>
                            <input className="text-input" aria-label="Why it is rejected" placeholder="Why (optional)" value={note} onChange={(event) => setNote(event.target.value)} />
                            <button type="button" className="btn" disabled={busy === row.id} onClick={() => act(row, 'reject')}>Reject</button>
                            <button type="button" className="btn" disabled={busy === row.id} onClick={() => setRejecting(null)}>Cancel</button>
                          </>
                        )}
                        {can.withdraw && (
                          <button type="button" className="btn" disabled={busy === row.id} onClick={() => act(row, 'withdraw')}>Withdraw</button>
                        )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {explained && (
        <div className="x-approvals-note" role="dialog" aria-label={explained.title} style={{ left: explained.x, top: explained.y }} onClick={(event) => event.stopPropagation()}>
          <strong>{explained.title}</strong>
          {explained.lines.map((line) => <p key={line}>{line}</p>)}
        </div>
      )}
    </div>
  );
}
