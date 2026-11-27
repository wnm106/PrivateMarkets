/**
 * What each displayed value points back to: one attribute on one record. Right-click on a bound
 * value opens that record's sources for that attribute.
 */
import type { BindTarget } from '../components/common';
import type { Account, Holding, Note, Opportunity, Test, Vehicle } from './data';

export const onFund = (v: Vehicle, code: string, name: string): BindTarget => ({ entityId: v.id, entityName: v.name, domainCode: 'FUND', code, name });

export const onTxn = (v: Vehicle, code: string, name: string): BindTarget | null =>
  v.transactionId ? { entityId: v.transactionId, entityName: v.transactionName || v.name, domainCode: 'CLO_TRANSACTION', code, name } : null;

export const onNote = (n: Note, code: string, name: string): BindTarget => ({ entityId: n.id, entityName: n.name, domainCode: 'CLO_NOTE_CLASS', code, name });

export const onAccount = (a: Account, code: string, name: string): BindTarget => ({ entityId: a.id, entityName: a.name, domainCode: 'CLO_ACCOUNT', code, name });

export const onPosition = (h: Holding, code: string, name: string): BindTarget => ({ entityId: h.positionId, entityName: h.name, domainCode: 'POSITION', code, name });

export const onSecurity = (h: { securityId: string | null; name: string }, code: string, name: string): BindTarget | null =>
  h.securityId ? { entityId: h.securityId, entityName: h.name, domainCode: 'SECURITY', code, name } : null;

export const onIssuer = (h: { issuerId: string | null; issuer: string }, code: string, name: string): BindTarget | null =>
  h.issuerId ? { entityId: h.issuerId, entityName: h.issuer, domainCode: 'ISSUER', code, name } : null;

export const onOffer = (o: Opportunity, code: string, name: string): BindTarget => ({ entityId: o.securityId, entityName: o.name, domainCode: 'SECURITY', code, name });

/** The record and attribute a test reads its limit from: the indenture terms, or the note class it covers. */
export function limitBind(v: Vehicle, t: Test): BindTarget | null {
  if (!t.limitAttribute) return null;
  if (t.limitHolder === 'NOTE') {
    const note = v.notes.find((n) => n.rank === t.rank);
    return note ? onNote(note, t.limitAttribute, `${t.ruleName} trigger`) : null;
  }
  return onTxn(v, t.limitAttribute, `${t.ruleName} limit`);
}

/** Record pages in the app. */
export const recordPath = {
  fund: (id: string) => `/funds/${id}/overview`,
  position: (id: string) => `/positions/${id}`,
  security: (id: string) => `/securities/${id}`,
  issuer: (id: string) => `/issuers/${id}`,
  transaction: (id: string) => `/clo_transactions/${id}`,
  note: (id: string) => `/clo_note_classs/${id}`,
  account: (id: string) => `/clo_accounts/${id}`,
};
