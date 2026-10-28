import { formatAttributeDisplay } from '@/lib/attribute-display';

const NUMERIC_TYPES = new Set(['NUMBER', 'CURRENCY', 'PERCENTAGE', 'INTEGER', 'DECIMAL', 'FLOAT', 'NUMERIC']);

export function formatAttributeValue(value: string, dataType?: string): string {
  if (!value || value === '—') return value || '—';
  return formatAttributeDisplay(value, { dataType }) || value;
}

export function isNumericAttribute(dataType?: string): boolean {
  return Boolean(dataType && NUMERIC_TYPES.has(dataType.toUpperCase()));
}

export interface CompetingValue {
  source: string;
  sourceName: string;
  value: string;
  precedenceRank: number;
  validFrom: string;
  validTo: string;
  confidenceScore: number | null;
  receivedAt?: string | null;
}

export interface FieldData {
  label: string;
  attributeCode?: string;
  dataType?: string;
  value: string;
  source: string;
  conflict?: boolean;
  alt?: number;
  standardized?: boolean;
  /** Precedence rank for the current golden source (lower = higher priority) */
  precedenceRank?: number;
  /** All competing source values with their precedence ranks */
  competingValues?: CompetingValue[];
  /** When the prevailing source last delivered this value. */
  receivedAt?: string | null;
  /** The resolution rule that determined the golden value */
  resolutionRule?: string;
  /** True when the attribute is produced by a calculation rather than a feed. */
  calculated?: boolean;
  formula?: string;
  /** Source that supplied the number currently shown, when it is not the formula result. */
  storedSourceName?: string;
}

export interface LineageField {
  attributeCode: string;
  attributeName?: string | null;
  currentValue?: string | null;
  resolutionRule?: string | null;
  competingValues?: Array<{
    source: string;
    sourceName: string;
    value: string | null;
    precedenceRank: number;
    validFrom: string;
    validTo: string;
    confidenceScore: number | null;
    receivedAt?: string | null;
  }>;
}

/** Own-entity attribute columns. Dotted codes belong to a related record. */
export function isRowAttributeCode(code: string): boolean {
  return Boolean(code) && !code.includes('.') && code !== 'entity_code' && code !== 'entity_name' && code !== 'domain_code';
}

export function fieldFromLineage(
  lineage: LineageField | null | undefined,
  meta: {
    label: string;
    attributeCode: string;
    dataType?: string;
    calculated?: boolean;
    formula?: string;
    fallbackValue?: string;
  },
): FieldData {
  const values: CompetingValue[] = (lineage?.competingValues || []).map((cv) => ({
    source: (typeof cv.source === 'string' ? cv.source : 'manual').toLowerCase(),
    sourceName: cv.sourceName,
    value: cv.value == null || cv.value === '' ? '—' : String(cv.value),
    precedenceRank: cv.precedenceRank,
    validFrom: cv.validFrom,
    validTo: cv.validTo,
    confidenceScore: cv.confidenceScore,
    receivedAt: cv.receivedAt,
  }));
  const current = lineage?.currentValue;
  const winner = (current != null && current !== ''
    ? values.find((cv) => cv.value === String(current))
    : undefined) || values.find((cv) => cv.value && cv.value !== '—') || values[0];
  const resolved = current != null && current !== '' ? String(current) : (meta.fallbackValue || '—');
  return {
    label: meta.label,
    attributeCode: meta.attributeCode,
    dataType: meta.dataType,
    value: resolved,
    source: winner?.source || 'manual',
    calculated: meta.calculated,
    formula: meta.formula,
    storedSourceName: winner?.sourceName,
    precedenceRank: winner?.precedenceRank,
    receivedAt: winner?.receivedAt,
    competingValues: values.length ? values : undefined,
    resolutionRule: meta.formula || lineage?.resolutionRule || undefined,
  };
}
