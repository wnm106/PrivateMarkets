/**
 * Certification: a close date for knowledge.
 *
 * When a person certifies a process on a record (a fund's NAV close, a deal's
 * allocation) the database stamps the instant. From then on the record's page
 * reads at the certified As Of date and that knowledge instant, so it shows
 * what was certified however the data changes later. Any surface can pin
 * itself the same way; docs/CERTIFICATION.md is the pattern.
 *
 * Re-certifying rolls knowledge forward and keeps the As Of date: after a
 * reopen the page reads the same As Of date as known now, and the new
 * certification replaces the old one as its next version.
 *
 * This module holds what does not need React: the queries, the dates a
 * surface reads at, and the comparison of certified figures with a later read.
 */

import { graphqlMutation, graphqlQuery } from '@/lib/graphql';

export type FigureValue = number | string | boolean | null;
/** The key figures a person saw when certifying, by key. */
export type Figures = Record<string, { label: string; value: FigureValue }>;

/** A certification another one was read against, as it stands now. */
export interface CertificationDependency {
  id: string;
  processCode: string;
  periodEnd: string | null;
  version: number;
  certifiedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export interface Certification {
  id: string;
  processCode: string;
  subjectEntityId: string;
  periodEnd: string | null;
  asOfDate: string;
  knowledgeAt: string;
  figures: Figures;
  fingerprint: string;
  note: string | null;
  certifiedBy: string | null;
  certifiedAt: string;
  /** 1 for the first certification of a record and period, then one more for each re-certification. */
  version: number;
  supersedesId: string | null;
  dependsOn: string[];
  dependencies?: CertificationDependency[];
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

/** What a surface certifies: the process, the record it is certified on, and the period when the process has one. */
export interface CertificationSubject {
  processCode: string;
  subjectEntityId: string | null | undefined;
  periodEnd?: string | null;
}

/** The As Of and Knowledge dates a surface reads at. knowledgeDate is a day or an exact instant. */
export interface SurfaceDates {
  asOfDate: string;
  knowledgeDate: string;
  /** Set when a certification fixes both dates; says what fixed them. */
  pinnedBy?: string | null;
  /** Set when only the As Of date is fixed: a reopened certification is being re-certified at its As Of date. */
  asOfKeptBy?: string | null;
}

/** Whether the surface shows what was certified, or what is known now. */
export type CertificationView = 'certified' | 'current';

const DEPENDENCY_FIELDS = 'id processCode periodEnd version certifiedAt revokedAt revokedBy revokeReason';
const FIELDS = `id processCode subjectEntityId periodEnd asOfDate knowledgeAt figures fingerprint note certifiedBy certifiedAt version supersedesId dependsOn dependencies { ${DEPENDENCY_FIELDS} } revokedAt revokedBy revokeReason`;

export const CERTIFICATION_HISTORY_QUERY = `
  query CertificationHistory($subjectEntityId: ID!, $processCode: String) {
    certificationHistory(subjectEntityId: $subjectEntityId, processCode: $processCode) { ${FIELDS} }
  }
`;

const CERTIFY_MUTATION = `
  mutation Certify($input: CertifyInput!) {
    certify(input: $input) { ${FIELDS} }
  }
`;

const REVOKE_MUTATION = `
  mutation RevokeCertification($id: ID!, $reason: String!) {
    revokeCertification(id: $id, reason: $reason) { ${FIELDS} }
  }
`;

const day = (value: string | null | undefined) => String(value ?? '').slice(0, 10);

/** Every version of a subject's certification for one period, newest first. */
export async function loadCertificationVersions(subject: CertificationSubject): Promise<Certification[]> {
  if (!subject.subjectEntityId) return [];
  const result = await graphqlQuery<{ certificationHistory: Certification[] }>(
    CERTIFICATION_HISTORY_QUERY,
    { subjectEntityId: subject.subjectEntityId, processCode: subject.processCode },
    'network-only',
  );
  if (result.error) throw new Error(result.error.message || 'Could not read the certification');
  return versionsFor(result.data?.certificationHistory || [], subject.periodEnd);
}

/** The versions for one period (or the record, when the process has no period), newest first. */
export function versionsFor(history: Certification[], periodEnd: string | null | undefined): Certification[] {
  const wanted = day(periodEnd);
  return history
    .filter((item) => day(item.periodEnd) === wanted)
    .sort((left, right) => right.version - left.version || right.certifiedAt.localeCompare(left.certifiedAt));
}

/** The certification in force, and the reopened one a re-certification would replace. */
export function standing(versions: Certification[]): { active: Certification | null; reopened: Certification | null } {
  const latest = versions[0] ?? null;
  if (!latest) return { active: null, reopened: null };
  return latest.revokedAt ? { active: null, reopened: latest } : { active: latest, reopened: null };
}

export async function certifySubject(
  subject: CertificationSubject,
  asOfDate: string | null,
  figures: Figures,
  note?: string | null,
  dependsOn?: string[],
): Promise<Certification> {
  if (!subject.subjectEntityId) throw new Error('There is no record to certify yet.');
  const result = await graphqlMutation<{ certify: Certification }>(CERTIFY_MUTATION, {
    input: {
      processCode: subject.processCode,
      subjectEntityId: subject.subjectEntityId,
      periodEnd: subject.periodEnd || null,
      asOfDate,
      figures,
      note: note || null,
      dependsOn: dependsOn?.filter(Boolean) ?? [],
    },
  });
  if (result.error || !result.data?.certify) throw new Error(result.error?.message || 'Could not certify');
  return result.data.certify;
}

export async function revokeCertification(id: string, reason: string): Promise<Certification> {
  if (!reason.trim()) throw new Error('Say why this is being reopened.');
  const result = await graphqlMutation<{ revokeCertification: Certification }>(REVOKE_MUTATION, { id, reason: reason.trim() });
  if (result.error || !result.data?.revokeCertification) throw new Error(result.error?.message || 'Could not reopen');
  return result.data.revokeCertification;
}

function moment(value: string): string {
  const when = new Date(value);
  return Number.isNaN(when.getTime())
    ? value
    : `${when.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}

/** "Certified 22 Nov 2026, 14:03 UTC by Pat (version 2)", for banners and the assistant. */
export function certificationLabel(certification: Certification): string {
  const version = certification.version > 1 ? ` (version ${certification.version})` : '';
  return `Certified ${moment(certification.certifiedAt)}${certification.certifiedBy ? ` by ${certification.certifiedBy}` : ''}${version}`;
}

/** "Version 1, reopened 3 Dec 2026, 09:12 UTC by Sam: NAV restated", for history and banners. */
export function reopenLabel(certification: Certification): string {
  if (!certification.revokedAt) return '';
  return `Version ${certification.version}, reopened ${moment(certification.revokedAt)}${certification.revokedBy ? ` by ${certification.revokedBy}` : ''}${certification.revokeReason ? `: ${certification.revokeReason}` : ''}`;
}

/**
 * The dates a surface reads at.
 * - Certified: the certification's As Of date and knowledge instant, unless
 *   the person chose to see what is known now.
 * - Reopened: the reopened certification's As Of date with the user's
 *   knowledge, so a re-certification rolls knowledge forward on the same date.
 * - Otherwise: the user's dates.
 */
export function surfaceDates(
  userDates: { asOfDate: string; knowledgeDate: string },
  certification: Certification | null | undefined,
  view: CertificationView = 'certified',
  reopened?: Certification | null,
): SurfaceDates {
  if (certification && !certification.revokedAt && view === 'certified') {
    return { asOfDate: certification.asOfDate, knowledgeDate: certification.knowledgeAt, pinnedBy: certificationLabel(certification), asOfKeptBy: null };
  }
  if (!certification && reopened?.revokedAt) {
    return { asOfDate: reopened.asOfDate, knowledgeDate: userDates.knowledgeDate, pinnedBy: null, asOfKeptBy: reopenLabel(reopened) };
  }
  return { asOfDate: userDates.asOfDate, knowledgeDate: userDates.knowledgeDate, pinnedBy: null, asOfKeptBy: null };
}

/** The certifications this one was read against that have been reopened since: it was certified against a replaced version. */
export function replacedDependencies(certification: Certification | null | undefined): CertificationDependency[] {
  return (certification?.dependencies || []).filter((item) => Boolean(item.revokedAt));
}

export interface FigureChange {
  key: string;
  label: string;
  certified: FigureValue;
  current: FigureValue;
}

function same(left: FigureValue, right: FigureValue): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    // Figures are money and counts. Below a hundredth is rounding, not a change.
    return Math.abs(left - right) < 0.005;
  }
  return (left ?? null) === (right ?? null);
}

/**
 * The certified figures that read differently now. A figure missing from the
 * later read counts as changed to null; one the certification did not hold is
 * not a change.
 */
export function figureChanges(certified: Figures | null | undefined, current: Figures | null | undefined): FigureChange[] {
  if (!certified || !current) return [];
  const changes: FigureChange[] = [];
  for (const [key, entry] of Object.entries(certified)) {
    const now = current[key]?.value ?? null;
    if (!same(entry.value, now)) changes.push({ key, label: entry.label || current[key]?.label || key, certified: entry.value, current: now });
  }
  return changes;
}

/**
 * A certification is made "as known now". Browsing at an earlier Knowledge
 * date shows something other than what the certification would pin, so it
 * cannot be certified from there. Returns why not, or null when it can.
 */
export function certifyBlockedBy(knowledgeDate: string | null | undefined, today: string = new Date().toISOString().slice(0, 10)): string | null {
  const value = day(knowledgeDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value >= today) return null;
  return `You are viewing data as known on ${value}. Set Knowledge to today to certify.`;
}
