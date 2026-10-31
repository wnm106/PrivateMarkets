import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { POSITION_FILE_MAP } from './position-file-map';
import { domainLabel, type ColumnAssignment } from './suggest';
import type { FeedMap } from './types';

export interface LoadMapIdentity {
  mapCode: string;
  sourceCode: string;
  name: string;
  description: string;
}

/** Same columns in any order are the same file shape. */
export function headerSignature(headers: string[]): string {
  return headers
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|');
}

export function positionFileHeaders(): string[] {
  const headers = new Set<string>();
  const add = (column?: string) => {
    if (column) headers.add(column);
  };
  add(POSITION_FILE_MAP.asOfHintColumn);
  add(POSITION_FILE_MAP.rowFilter?.column);
  for (const domain of POSITION_FILE_MAP.domains) {
    add(domain.identityColumn);
    add(domain.nameColumn);
    for (const attribute of domain.attributes) add(attribute.column);
    for (const parent of domain.parents) add(parent.column);
  }
  return [...headers];
}

export function discoveredMapCode(signature: string): string {
  return `LOAD_${createHash('sha256').update(signature).digest('hex').slice(0, 12)}`;
}

export function mapNameFromAssignments(assignments: ColumnAssignment[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.role !== 'identity' || !assignment.domainCode || seen.has(assignment.domainCode)) continue;
    seen.add(assignment.domainCode);
    names.push(domainLabel(assignment.domainCode));
  }
  if (names.length === 0) return 'Loaded file';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function proposeLoadIdentity(headers: string[], assignments: ColumnAssignment[]): LoadMapIdentity {
  const signature = headerSignature(headers);
  if (signature === headerSignature(positionFileHeaders())) {
    return {
      mapCode: POSITION_FILE_MAP.mapCode,
      sourceCode: POSITION_FILE_MAP.sourceCode,
      name: POSITION_FILE_MAP.name,
      description: POSITION_FILE_MAP.description,
    };
  }
  const name = mapNameFromAssignments(assignments);
  return {
    mapCode: discoveredMapCode(signature),
    sourceCode: 'IMPORT',
    name,
    description: `Discovered from a ${name.toLowerCase()} file. Saved when the load is confirmed.`,
  };
}

/** Drop row samples. The saved map keeps the field choice and the cleanup. */
export function templateFromAssignments(assignments: ColumnAssignment[]): ColumnAssignment[] {
  return assignments.map((assignment) => ({
    sourceColumn: assignment.sourceColumn,
    samples: [],
    role: assignment.role,
    domainCode: assignment.domainCode,
    attributeCode: assignment.attributeCode,
    parentDomainCode: assignment.parentDomainCode,
    filterEquals: assignment.filterEquals,
    transform: assignment.transform,
    suggestion: {
      method: 'source_map',
      confidence: 0.99,
      reason: 'Saved from a confirmed file load.',
    },
  }));
}

export function overlayStoredMap(discovered: ColumnAssignment[], template: ColumnAssignment[], mapName: string): ColumnAssignment[] {
  const savedByColumn = new Map(template.map((assignment) => [assignment.sourceColumn.trim().toLowerCase(), assignment]));
  return discovered.map((assignment) => {
    const saved = savedByColumn.get(assignment.sourceColumn.trim().toLowerCase());
    if (!saved) return assignment;
    return {
      ...assignment,
      role: saved.role,
      domainCode: saved.domainCode,
      attributeCode: saved.attributeCode,
      parentDomainCode: saved.parentDomainCode,
      filterEquals: saved.filterEquals,
      transform: saved.transform || assignment.transform,
      suggestion: {
        method: 'source_map',
        confidence: 0.99,
        reason: `Saved map “${mapName}” places this column.`,
      },
    };
  });
}

export interface StoredLoadMap {
  mapCode: string;
  name: string;
  sourceCode: string;
  description: string;
  template: ColumnAssignment[];
}

export async function findStoredMap(client: SupabaseClient, signature: string): Promise<StoredLoadMap | null> {
  const row = await client
    .schema('entity_instances')
    .from('feed_maps')
    .select('map_code, map_name, description, assignment_template, source_id')
    .eq('header_signature', signature)
    .maybeSingle();
  if (row.error) throw new Error(row.error.message);
  if (!row.data?.assignment_template) return null;
  const template = row.data.assignment_template as ColumnAssignment[];
  if (!Array.isArray(template) || template.length === 0) return null;
  const source = await client.schema('entity_instances').from('source_registry').select('source_code').eq('id', row.data.source_id).maybeSingle();
  if (source.error) throw new Error(source.error.message);
  return {
    mapCode: row.data.map_code,
    name: row.data.map_name,
    description: row.data.description || '',
    sourceCode: source.data?.source_code || 'IMPORT',
    template,
  };
}

export async function saveLoadMap(
  client: SupabaseClient,
  input: LoadMapIdentity & { signature: string; template: ColumnAssignment[]; feedMap?: FeedMap }
): Promise<void> {
  const source = await client.schema('entity_instances').from('source_registry').select('id').eq('source_code', input.sourceCode).maybeSingle();
  if (source.error || !source.data) throw new Error(source.error?.message || `Source ${input.sourceCode} was not found`);
  const payload = {
    map_name: input.name,
    description: input.description,
    source_id: source.data.id,
    header_signature: input.signature,
    assignment_template: input.template,
    is_active: true,
    updated_at: new Date().toISOString(),
  };
  const bySignature = await client.schema('entity_instances').from('feed_maps').select('id').eq('header_signature', input.signature).maybeSingle();
  if (bySignature.error) throw new Error(bySignature.error.message);
  if (bySignature.data) {
    const updated = await client.schema('entity_instances').from('feed_maps').update(payload).eq('id', bySignature.data.id);
    if (updated.error) throw new Error(updated.error.message);
    return;
  }
  const byCode = await client.schema('entity_instances').from('feed_maps').select('id').eq('map_code', input.mapCode).maybeSingle();
  if (byCode.error) throw new Error(byCode.error.message);
  if (byCode.data) {
    const updated = await client.schema('entity_instances').from('feed_maps').update(payload).eq('id', byCode.data.id);
    if (updated.error) throw new Error(updated.error.message);
    return;
  }
  const inserted = await client.schema('entity_instances').from('feed_maps').insert({
    ...payload,
    map_code: input.mapCode,
    column_mappings: input.feedMap || { mapCode: input.mapCode },
  });
  if (inserted.error) throw new Error(inserted.error.message);
}
