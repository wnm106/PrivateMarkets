import { createHash } from 'crypto';
import type { ColumnAssignment } from './suggest';
import type { ColumnTransform } from './types';

/**
 * A saved column map for one file format. A later file reuses it when every
 * original column is present. Extra columns are new fields on that same map.
 */
export interface StoredAssignment {
  sourceColumn: string;
  role: ColumnAssignment['role'];
  domainCode: string | null;
  attributeCode: string | null;
  parentDomainCode: string | null;
  filterEquals: string | null;
  transform: ColumnTransform;
}

export interface ReusableMap {
  version: 1;
  mapCode: string;
  kind: string;
  name: string;
  description: string;
  /** Columns that defined the format the first time it was saved. */
  coreHeaders: string[];
  /** Core columns plus any fields added by later files. */
  headers: string[];
  assignments: StoredAssignment[];
}

export type MapMatch =
  | { type: 'exact'; map: ReusableMap }
  | { type: 'extended'; map: ReusableMap; newHeaders: string[] }
  | { type: 'none'; missingHeaders: string[] };

export function headerKey(value: string): string {
  return value.trim().toLowerCase();
}

export function newMapCode(kind: string, headers: string[]): string {
  const basis = [...new Set(headers.map(headerKey).filter(Boolean))].sort().join('\n');
  const hash = createHash('sha256').update(basis).digest('hex').slice(0, 12);
  return `${codePrefix(kind)}-${hash}`;
}

export function mapTitle(kind: string, headers: string[]): string {
  const label = kindLabel(kind);
  const sample = headers.filter(Boolean).slice(0, 3).join(', ');
  const title = sample ? `${label} · ${sample}` : label;
  return title.slice(0, 200);
}

export function kindLabel(kindOrCode: string): string {
  const value = kindOrCode.toUpperCase();
  if (value === 'NAV_STATEMENT' || value.startsWith('NAV-') || value === 'NAV') return 'NAV statement';
  if (value === 'FINANCIAL_STATEMENT' || value.startsWith('FINANCIAL-') || value === 'FINANCIAL') return 'Financial statement';
  if (value === 'POSITION_FILE' || value.startsWith('POSITIONS-') || value === 'POSITIONS') return 'Positions';
  return 'Table';
}

export function codePrefix(kind: string): string {
  if (kind === 'NAV_STATEMENT' || kind === 'NAV') return 'NAV';
  if (kind === 'FINANCIAL_STATEMENT' || kind === 'FINANCIAL') return 'FINANCIAL';
  if (kind === 'POSITIONS' || kind === 'POSITION_FILE') return 'POSITIONS';
  return 'TABLE';
}

/**
 * Reuse a map when the file still has every column from the original format.
 * A 100% match has no unknown columns. Extra columns are new fields.
 */
export function matchReusableMap(fileHeaders: string[], maps: ReusableMap[], kind?: string): MapMatch {
  const headers = fileHeaders.filter(Boolean);
  const fileKeys = new Set(headers.map(headerKey));
  const sameKind = kind ? maps.filter((map) => codePrefix(map.kind) === codePrefix(kind)) : maps;
  const candidates = sameKind.filter((map) => map.coreHeaders.every((header) => fileKeys.has(headerKey(header))));
  if (candidates.length === 0) {
    const closest = [...sameKind].sort((left, right) => overlap(right, fileKeys) - overlap(left, fileKeys))[0];
    const missingHeaders = closest
      ? closest.coreHeaders.filter((header) => !fileKeys.has(headerKey(header)))
      : [];
    return { type: 'none', missingHeaders };
  }
  const best = [...candidates].sort((left, right) => {
    const byOverlap = overlap(right, fileKeys) - overlap(left, fileKeys);
    if (byOverlap !== 0) return byOverlap;
    return right.headers.length - left.headers.length;
  })[0];
  const known = new Set(best.headers.map(headerKey));
  const newHeaders = headers.filter((header) => !known.has(headerKey(header)));
  if (newHeaders.length === 0) return { type: 'exact', map: best };
  return { type: 'extended', map: best, newHeaders };
}

export function applyReusableMap(
  headers: string[],
  rows: Record<string, string>[],
  map: ReusableMap,
  fresh: ColumnAssignment[],
): ColumnAssignment[] {
  const saved = new Map(map.assignments.map((assignment) => [headerKey(assignment.sourceColumn), assignment]));
  const freshByHeader = new Map(fresh.map((assignment) => [headerKey(assignment.sourceColumn), assignment]));
  return headers.filter(Boolean).map((header) => {
    const known = saved.get(headerKey(header));
    if (!known) {
      return freshByHeader.get(headerKey(header)) || ignoredAssignment(header, rows);
    }
    return {
      sourceColumn: header,
      samples: samplesFor(rows, header),
      role: known.role,
      domainCode: known.domainCode,
      attributeCode: known.attributeCode,
      parentDomainCode: known.parentDomainCode,
      filterEquals: known.filterEquals,
      transform: known.transform,
      suggestion: {
        method: 'source_map',
        confidence: 1,
        reason: newHeadersReason(map.mapCode, fresh.length),
      },
    };
  });
}

export function storeAssignment(assignment: ColumnAssignment): StoredAssignment {
  return {
    sourceColumn: assignment.sourceColumn,
    role: assignment.role,
    domainCode: assignment.domainCode,
    attributeCode: assignment.attributeCode,
    parentDomainCode: assignment.parentDomainCode,
    filterEquals: assignment.filterEquals,
    transform: assignment.transform,
  };
}

export function mergeAssignments(saved: StoredAssignment[], incoming: StoredAssignment[]): StoredAssignment[] {
  const merged = new Map(saved.map((assignment) => [headerKey(assignment.sourceColumn), assignment]));
  for (const assignment of incoming) {
    const key = headerKey(assignment.sourceColumn);
    if (!key) continue;
    merged.set(key, assignment);
  }
  return [...merged.values()];
}

export function mergeHeaders(saved: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const header of [...saved, ...incoming]) {
    const key = headerKey(header);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(header);
  }
  return merged;
}

export function parseReusableMap(value: unknown): ReusableMap | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<ReusableMap>;
  if (record.version !== 1 || !record.mapCode || !Array.isArray(record.headers) || !Array.isArray(record.assignments)) return null;
  const coreHeaders = Array.isArray(record.coreHeaders) && record.coreHeaders.length > 0 ? record.coreHeaders : record.headers;
  return {
    version: 1,
    mapCode: record.mapCode,
    kind: record.kind || 'TABULAR',
    name: record.name || record.mapCode,
    description: record.description || '',
    coreHeaders,
    headers: record.headers,
    assignments: record.assignments as StoredAssignment[],
  };
}

function overlap(map: ReusableMap, fileKeys: Set<string>): number {
  return map.headers.filter((header) => fileKeys.has(headerKey(header))).length;
}

function cell(row: Record<string, string>, column: string): string {
  if (Object.prototype.hasOwnProperty.call(row, column)) return row[column] || '';
  const key = headerKey(column);
  const match = Object.keys(row).find((name) => headerKey(name) === key);
  return match ? row[match] || '' : '';
}

function samplesFor(rows: Record<string, string>[], column: string): string[] {
  const seen = new Set<string>();
  const samples: string[] = [];
  for (const row of rows) {
    const value = cell(row, column).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    samples.push(value);
    if (samples.length === 3) break;
  }
  return samples;
}

function ignoredAssignment(header: string, rows: Record<string, string>[]): ColumnAssignment {
  return {
    sourceColumn: header,
    samples: samplesFor(rows, header),
    role: 'ignore',
    domainCode: null,
    attributeCode: null,
    parentDomainCode: null,
    filterEquals: null,
    transform: { kind: 'trim' },
    suggestion: { method: 'name', confidence: 0.2, reason: 'No saved mapping for this column' },
  };
}

function newHeadersReason(mapCode: string, freshCount: number): string {
  if (freshCount > 0) return `Reused map ${mapCode}. New columns keep their own mapping.`;
  return `Reused map ${mapCode}`;
}
