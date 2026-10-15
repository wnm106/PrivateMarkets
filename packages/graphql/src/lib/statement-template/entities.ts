export interface StatementEntityType {
  domainCode: 'FUND' | 'ISSUER';
  /** Name shown in the studio. Issuers are the company records. */
  domainName: string;
  statementKind: 'NAV' | 'FINANCIAL';
  statementLabel: string;
}

export const STATEMENT_ENTITY_TYPES: readonly StatementEntityType[] = [
  { domainCode: 'FUND', domainName: 'Fund', statementKind: 'NAV', statementLabel: 'NAV statement' },
  { domainCode: 'ISSUER', domainName: 'Company', statementKind: 'FINANCIAL', statementLabel: 'Financial statement' },
];

export function statementEntityType(domainCode: string | null | undefined): StatementEntityType | undefined {
  const code = String(domainCode || '').trim().toUpperCase();
  return STATEMENT_ENTITY_TYPES.find((entityType) => entityType.domainCode === code);
}
