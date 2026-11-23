/**
 * Certifications: what a person certified, and the As Of date and knowledge
 * instant its page reads at from then on. See docs/CERTIFICATION.md.
 *
 * The database stamps the knowledge instant (golden_master.certify), so a
 * caller cannot certify "as known" at a time of its choosing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface CertificationRow {
  id: string;
  process_code: string;
  subject_entity_id: string;
  period_end: string | null;
  as_of_date: string;
  knowledge_at: string;
  figures: Record<string, unknown> | null;
  fingerprint: string;
  note: string | null;
  certified_by: string | null;
  certified_by_name: string | null;
  certified_at: string;
  version: number;
  supersedes_id: string | null;
  depends_on: string[] | null;
  revoked_at: string | null;
  revoked_by_name: string | null;
  revoke_reason: string | null;
}

export interface Certification {
  id: string;
  processCode: string;
  subjectEntityId: string;
  periodEnd: string | null;
  asOfDate: string;
  knowledgeAt: string;
  figures: Record<string, unknown>;
  fingerprint: string;
  note: string | null;
  certifiedBy: string | null;
  certifiedAt: string;
  /** 1 for the first certification of a subject and period, then one more for each re-certification. */
  version: number;
  /** The reopened certification this one replaces. */
  supersedesId: string | null;
  /** Certifications this one was read against, such as the prior period's close. */
  dependsOn: string[];
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export interface CertifyInput {
  processCode: string;
  subjectEntityId: string;
  /** Leave out on a re-certification to keep the As Of date of the one it replaces. */
  asOfDate?: string | null;
  periodEnd?: string | null;
  figures?: Record<string, unknown> | null;
  note?: string | null;
  dependsOn?: string[] | null;
}

const COLUMNS = 'id, process_code, subject_entity_id, period_end, as_of_date, knowledge_at, figures, fingerprint, note, certified_by, certified_by_name, certified_at, version, supersedes_id, depends_on, revoked_at, revoked_by_name, revoke_reason';

const day = (value: string | null | undefined): string | null => {
  const match = String(value ?? '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
};

export function toCertification(row: CertificationRow): Certification {
  return {
    id: row.id,
    processCode: row.process_code,
    subjectEntityId: row.subject_entity_id,
    periodEnd: day(row.period_end),
    asOfDate: day(row.as_of_date) || '',
    knowledgeAt: new Date(row.knowledge_at).toISOString(),
    figures: row.figures && typeof row.figures === 'object' && !Array.isArray(row.figures) ? row.figures : {},
    fingerprint: row.fingerprint,
    note: row.note,
    certifiedBy: row.certified_by_name || null,
    certifiedAt: new Date(row.certified_at).toISOString(),
    version: Number(row.version) || 1,
    supersedesId: row.supersedes_id ?? null,
    dependsOn: Array.isArray(row.depends_on) ? row.depends_on : [],
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    revokedBy: row.revoked_by_name || null,
    revokeReason: row.revoke_reason,
  };
}

/** Keeps only { key: { label, value } } entries whose value is a number, text, boolean or null. */
export function cleanFigures(input: unknown): Record<string, { label: string; value: number | string | boolean | null }> {
  const out: Record<string, { label: string; value: number | string | boolean | null }> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!key || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as { label?: unknown; value?: unknown };
    const value = entry.value;
    const kept = value == null ? null
      : typeof value === 'number' ? (Number.isFinite(value) ? value : null)
      : typeof value === 'string' || typeof value === 'boolean' ? value
      : null;
    out[key.slice(0, 80)] = { label: String(entry.label ?? key).slice(0, 160), value: kept };
  }
  return out;
}

/** The certification in force for a subject (and period), or null. */
export async function activeCertification(
  supabase: SupabaseClient,
  processCode: string,
  subjectEntityId: string,
  periodEnd?: string | null,
): Promise<Certification | null> {
  let query = supabase
    .schema('golden_master')
    .from('certifications')
    .select(COLUMNS)
    .eq('process_code', processCode)
    .eq('subject_entity_id', subjectEntityId)
    .is('revoked_at', null);
  const period = day(periodEnd);
  query = period ? query.eq('period_end', period) : query.is('period_end', null);
  const { data, error } = await query.order('certified_at', { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  const row = (data || [])[0] as CertificationRow | undefined;
  return row ? toCertification(row) : null;
}

/** Every certification of a subject, revoked ones included, newest first. */
export async function certificationHistory(
  supabase: SupabaseClient,
  subjectEntityId: string,
  processCode?: string | null,
): Promise<Certification[]> {
  let query = supabase
    .schema('golden_master')
    .from('certifications')
    .select(COLUMNS)
    .eq('subject_entity_id', subjectEntityId);
  if (processCode) query = query.eq('process_code', processCode);
  const { data, error } = await query.order('certified_at', { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return ((data || []) as CertificationRow[]).map(toCertification);
}

/**
 * The certification of a subject and period in force at a knowledge instant,
 * now when none is given. A page pinned at an instant reads the
 * certifications in force then, so a later re-certification does not change it.
 */
export async function certificationAt(
  supabase: SupabaseClient,
  processCode: string,
  subjectEntityId: string,
  periodEnd: string | null | undefined,
  knowledge?: string | null,
): Promise<Certification | null> {
  const { data, error } = await supabase.schema('golden_master').rpc('certification_at', {
    p_process: processCode,
    p_subject: subjectEntityId,
    p_period_end: day(periodEnd),
    p_knowledge: knowledge || null,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as CertificationRow | null | undefined;
  return row?.id ? toCertification(row) : null;
}

/** Certifications by id, in the order asked. Ones the caller cannot see are left out. */
export async function certificationsById(supabase: SupabaseClient, ids: string[]): Promise<Certification[]> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return [];
  const { data, error } = await supabase.schema('golden_master').from('certifications').select(COLUMNS).in('id', wanted);
  if (error) throw new Error(error.message);
  const found = new Map(((data || []) as CertificationRow[]).map((row) => [row.id, toCertification(row)]));
  return wanted.map((id) => found.get(id)).filter((item): item is Certification => Boolean(item));
}

export async function certify(supabase: SupabaseClient, input: CertifyInput): Promise<Certification> {
  const { data, error } = await supabase.schema('golden_master').rpc('certify', {
    p_process: input.processCode,
    p_subject: input.subjectEntityId,
    // Null keeps the As Of date of a reopened certification this one replaces.
    p_as_of: day(input.asOfDate),
    p_period_end: day(input.periodEnd),
    p_figures: cleanFigures(input.figures),
    p_note: input.note ?? null,
    p_depends_on: [...new Set((input.dependsOn || []).filter(Boolean))],
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as CertificationRow | null;
  if (!row?.id) throw new Error('The certification was not recorded.');
  return toCertification(row);
}

export async function revokeCertification(supabase: SupabaseClient, id: string, reason?: string | null): Promise<Certification> {
  if (!String(reason ?? '').trim()) throw new Error('Say why this is being reopened.');
  const { data, error } = await supabase.schema('golden_master').rpc('revoke_certification', {
    p_id: id,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as CertificationRow | null;
  if (!row?.id) throw new Error('The certification was not reopened.');
  return toCertification(row);
}
