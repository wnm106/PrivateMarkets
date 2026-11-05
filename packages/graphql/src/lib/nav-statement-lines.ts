/**
 * A NAV line is an attribute of a NAV statement. The fund administrator and
 * the internal calculation are two sources of that one amount. Section, role,
 * and review rules live on the attribute.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface SourceValue {
  entity_id: string;
  attribute_id: string;
  golden_value: string | null;
  golden_value_numeric: number | null;
  valid_from?: string | null;
  valid_to?: string | null;
  system_from?: string | null;
  system_to?: string | null;
}

export const FUND_ADMIN_SOURCE = 'FUND_ADMIN';
export const INTERNAL_SOURCE = 'INTERNAL';

export interface NavLineAttribute {
  attributeId: string;
  code: string;
  name: string;
  section: string;
  role: string;
  indent: number;
  order: number;
  reviewable: boolean;
  composition: boolean;
}

type SourceRow = SourceValue & { source_id?: string };

export async function loadNavLineAttributes(supabase: SupabaseClient): Promise<NavLineAttribute[]> {
  const { data, error } = await supabase
    .from('attribute_register')
    .select('id, attribute_code, attribute_name, display_group, validation_rules')
    .eq('domain_code', 'NAV_STATEMENT');
  if (error) throw new Error(error.message);
  const lines: NavLineAttribute[] = [];
  for (const row of data || []) {
    const shape = navShape(row.validation_rules);
    if (!shape?.section) continue;
    lines.push({
      attributeId: row.id,
      code: row.attribute_code,
      name: row.attribute_name,
      section: shape.section,
      role: shape.role || 'LINE',
      indent: Number.isFinite(Number(shape.indent)) ? Number(shape.indent) : 0,
      order: Number(row.display_group) || 0,
      reviewable: shape.reviewable === true,
      composition: shape.composition === true,
    });
  }
  return lines.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

/** Attribute codes whose administrator-versus-internal variance has been accepted. */
export function acceptedLineCodes(value: string | null | undefined): Set<string> {
  const text = String(value || '').trim();
  if (!text) return new Set();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return new Set(parsed.map((item) => String(item).trim()).filter(Boolean));
    } catch {
      /* A comma-separated list is the other stored form. */
    }
  }
  return new Set(text.split(',').map((item) => item.trim()).filter(Boolean));
}

/**
 * One in-force row per entity, attribute, and source. The newest valid-from
 * wins, then the newest system time, matching the golden read.
 */
export async function readSourceAmounts(
  supabase: SupabaseClient,
  entityIds: string[],
  attributeIds: string[],
  sourceCodes: string[],
  asOf: string,
  knowledge: string,
): Promise<Map<string, SourceValue>> {
  const out = new Map<string, SourceValue>();
  const ids = [...new Set(entityIds)].filter(Boolean);
  const attributes = [...new Set(attributeIds)].filter(Boolean);
  const codes = [...new Set(sourceCodes)].filter(Boolean);
  if (!ids.length || !attributes.length || !codes.length) return out;

  const { data: sources, error: sourceError } = await supabase
    .schema('entity_instances')
    .from('source_registry')
    .select('id, source_code')
    .in('source_code', codes);
  if (sourceError) throw new Error(sourceError.message);
  const sourceById = new Map((sources || []).map((row) => [row.id, row.source_code as string]));
  const sourceIds = [...sourceById.keys()];
  if (!sourceIds.length) return out;

  const { data, error } = await supabase
    .schema('golden_master')
    .from('entity_attribute_values')
    .select('entity_id, attribute_id, source_id, golden_value, golden_value_numeric, valid_from, valid_to, system_from, system_to')
    .in('entity_id', ids)
    .in('attribute_id', attributes)
    .in('source_id', sourceIds);
  if (error) throw new Error(error.message);

  const best = new Map<string, SourceRow>();
  for (const row of (data || []) as SourceRow[]) {
    const sourceCode = sourceById.get(row.source_id || '');
    if (!sourceCode || !inForce(row, asOf, knowledge)) continue;
    const key = sourceKey(row.entity_id, row.attribute_id, sourceCode);
    const current = best.get(key);
    if (!current || later(row, current)) best.set(key, row);
  }
  for (const [key, row] of best) out.set(key, row);
  return out;
}

export function sourceKey(entityId: string, attributeId: string, sourceCode: string): string {
  return `${entityId}|${attributeId}|${sourceCode}`;
}

export function sourceAmount(rows: Map<string, SourceValue>, entityId: string, attributeId: string, sourceCode: string): number | null {
  return amountOf(rows.get(sourceKey(entityId, attributeId, sourceCode)));
}

export function sourceText(rows: Map<string, SourceValue>, entityId: string, attributeId: string, sourceCode: string): string {
  return rows.get(sourceKey(entityId, attributeId, sourceCode))?.golden_value?.trim() || '';
}

export function amountOf(row: SourceValue | undefined): number | null {
  if (!row) return null;
  if (row.golden_value_numeric != null) return Number(row.golden_value_numeric);
  if (row.golden_value == null || row.golden_value === '') return null;
  const parsed = Number(row.golden_value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inForce(row: SourceRow, asOf: string, knowledge: string): boolean {
  const validFrom = String(row.valid_from || '').slice(0, 10);
  const validTo = String(row.valid_to || '9999-12-31').slice(0, 10);
  if (validFrom && validFrom > asOf) return false;
  if (validTo && validTo < asOf) return false;
  const known = new Date(knowledge).getTime();
  const systemFrom = row.system_from ? new Date(row.system_from).getTime() : 0;
  const systemTo = row.system_to ? new Date(row.system_to).getTime() : Number.POSITIVE_INFINITY;
  return systemFrom <= known && systemTo >= known;
}

function navShape(rules: unknown): { section?: string; role?: string; indent?: number; reviewable?: boolean; composition?: boolean } | null {
  if (!rules || typeof rules !== 'object') return null;
  const nav = (rules as { navLine?: unknown }).navLine;
  if (!nav || typeof nav !== 'object') return null;
  return nav as { section?: string; role?: string; indent?: number; reviewable?: boolean; composition?: boolean };
}

function later(candidate: SourceRow, current: SourceRow): boolean {
  const candidateFrom = String(candidate.valid_from || '');
  const currentFrom = String(current.valid_from || '');
  if (candidateFrom !== currentFrom) return candidateFrom > currentFrom;
  const candidateSystem = candidate.system_from ? new Date(candidate.system_from).getTime() : 0;
  const currentSystem = current.system_from ? new Date(current.system_from).getTime() : 0;
  return candidateSystem >= currentSystem;
}
