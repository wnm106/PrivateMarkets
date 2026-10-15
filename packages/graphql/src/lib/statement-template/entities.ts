/**
 * Statement shape is metadata about the document, not a restriction on which
 * entity type may use the studio. Every domain in the registry is eligible.
 */
export const STATEMENT_SHAPES = [
  { code: 'NAV', label: 'NAV statement' },
  { code: 'FINANCIAL', label: 'Financial statement' },
  { code: 'CUSTOM', label: 'Custom statement' },
] as const;

const DOMAIN_CODE = /^[A-Z][A-Z0-9_]{0,49}$/;
const KIND_CODE = /^[A-Z][A-Z0-9_]{0,40}$/;

export function normalizeDomainCode(value: string | null | undefined): string {
  return String(value || '').trim().toUpperCase();
}

export function isDomainCode(value: string | null | undefined): boolean {
  return DOMAIN_CODE.test(normalizeDomainCode(value));
}

/** Unknown shapes stay usable so a new document type does not need a code change. */
export function statementKindCode(value: string | null | undefined): string {
  const code = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '');
  return KIND_CODE.test(code) ? code : 'CUSTOM';
}
