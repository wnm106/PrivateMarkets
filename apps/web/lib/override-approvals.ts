/**
 * Manual values waiting for a second person (golden_master.override_requests,
 * read through the overrideRequests query). Pure helpers, so the screen and
 * what it tells the assistant are worked out the same way.
 */

export type OverrideRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

export interface OverrideRequest {
  id: string;
  status: OverrideRequestStatus;
  clientId: string;
  entityId: string;
  entityName: string | null;
  entityCode: string | null;
  domainCode: string | null;
  attributeCode: string;
  attributeName: string;
  dataType: string | null;
  validFrom: string;
  value: string | null;
  reason: string;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  appliedValueId: string | null;
  mine: boolean;
  blocker: string | null;
  canDecide: boolean;
}

export type ApprovalView = 'waiting' | 'decided' | 'all';

export const APPROVAL_VIEWS: Array<{ id: ApprovalView; label: string; status: string }> = [
  { id: 'waiting', label: 'Waiting', status: 'PENDING' },
  { id: 'decided', label: 'Decided', status: 'ALL' },
  { id: 'all', label: 'Everything', status: 'ALL' },
];

/** The requests a view lists, from what the query returned for its status. */
export function requestsForView(view: ApprovalView, rows: OverrideRequest[]): OverrideRequest[] {
  if (view === 'decided') return rows.filter((row) => row.status !== 'PENDING');
  return rows;
}

export const STATUS_LABEL: Record<OverrideRequestStatus, string> = {
  PENDING: 'Waiting',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

/** The record's name as people know it. */
export function recordName(row: Pick<OverrideRequest, 'entityName' | 'entityCode' | 'entityId'>): string {
  return row.entityName || row.entityCode || row.entityId;
}

/** Who decided, and when, in a sentence. */
export function decisionText(row: Pick<OverrideRequest, 'status' | 'decidedByName' | 'decisionNote' | 'requestedByName'>): string {
  if (row.status === 'PENDING') return 'Waiting for approval';
  if (row.status === 'WITHDRAWN') return `Withdrawn by ${row.requestedByName}`;
  const verb = row.status === 'APPROVED' ? 'Approved' : 'Rejected';
  const by = row.decidedByName ? ` by ${row.decidedByName}` : '';
  return row.decisionNote ? `${verb}${by}: ${row.decisionNote}` : `${verb}${by}`;
}

/** What the current person can do with a request. */
export function actionsFor(row: Pick<OverrideRequest, 'status' | 'mine' | 'canDecide'>): { decide: boolean; withdraw: boolean } {
  return {
    decide: row.status === 'PENDING' && row.canDecide,
    withdraw: row.status === 'PENDING' && row.mine,
  };
}

/** Counts for the ribbon: waiting, waiting on me, mine waiting. */
export function approvalCounts(rows: OverrideRequest[]) {
  const waiting = rows.filter((row) => row.status === 'PENDING');
  return {
    waiting: waiting.length,
    forMe: waiting.filter((row) => row.canDecide).length,
    mine: waiting.filter((row) => row.mine).length,
  };
}

/** The requests as the assistant reads them: counts first, then each request, capped. */
export function approvalsStory(rows: OverrideRequest[], limit = 80) {
  return {
    counts: approvalCounts(rows),
    requests: rows.slice(0, limit).map((row) => ({
      status: STATUS_LABEL[row.status],
      record: recordName(row),
      field: row.attributeName,
      requestedValue: row.value,
      effectiveFrom: row.validFrom,
      reason: row.reason,
      enteredBy: row.requestedByName,
      enteredAt: row.requestedAt,
      decision: row.status === 'PENDING' ? null : decisionText(row),
      youCanApprove: row.status === 'PENDING' ? row.canDecide : undefined,
      whyNot: row.status === 'PENDING' && !row.canDecide ? row.blocker : undefined,
    })),
  };
}
