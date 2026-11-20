import { describe, expect, it } from 'vitest';
import {
  assembleAttributeSearch,
  classifyHeader,
  resolveStoredAlias,
  takeIdentityTargets,
  type AttributeAlias,
  type DomainAlias,
  type EntityNameAlias,
} from './semantic-aliases';

const domainAliases: DomainAlias[] = [
  { domainCode: 'ISSUER', aliasLabel: 'Borrower', aliasCode: 'BORROWER' },
  { domainCode: 'SECURITY', aliasLabel: 'Tranche', aliasCode: 'TRANCHE' },
];

const nameAliases: EntityNameAlias[] = [
  { domainCode: 'ISSUER', aliasLabel: 'Borrower name', aliasCode: 'BORROWER_NAME' },
  { domainCode: 'ISSUER', aliasLabel: 'Project name', aliasCode: 'PROJECT_NAME' },
  { domainCode: 'SECURITY', aliasLabel: 'Tranche name', aliasCode: 'TRANCHE_NAME' },
];

const attributeAliases: AttributeAlias[] = [
  { attributeCode: 'NAV', aliasLabel: 'Ending NAV', domainCode: 'FUND' },
  { attributeCode: 'NAV', aliasLabel: 'Net Assets', domainCode: 'FUND' },
];

describe('classifyHeader', () => {
  const catalog = { domainCode: 'ISSUER', domainAliases, nameAliases, attributeAliases };

  it('reads a project name as the borrower name', () => {
    expect(classifyHeader('Project Name', catalog)).toMatchObject({
      kind: 'entity_name',
      domainCode: 'ISSUER',
      aliasCode: 'PROJECT_NAME',
    });
  });

  it('reads the entity type word as that record', () => {
    expect(classifyHeader('Borrower', catalog)).toMatchObject({ kind: 'entity_name', domainCode: 'ISSUER', aliasCode: 'BORROWER' });
  });

  it('reads an attribute alias as the field', () => {
    expect(classifyHeader('Ending NAV', { domainCode: 'FUND', domainAliases, nameAliases, attributeAliases })).toMatchObject({
      kind: 'attribute_alias',
      attributeCode: 'NAV',
    });
  });

  it('does not use another type\'s name alias', () => {
    expect(classifyHeader('Project Name', { ...catalog, domainCode: 'FUND' }).kind).toBe('none');
  });
});

describe('assembleAttributeSearch', () => {
  it('returns the field, the entity type, and the entity name for the words a person used', () => {
    const ending = assembleAttributeSearch('ending nav', {
      attributes: [{ id: 'a1', attribute_code: 'NAV', attribute_name: 'NAV', description: 'Net asset value', data_type: 'NUMBER' }],
      attributeAliases: [{ attributeId: 'a1', aliasLabel: 'Ending NAV', aliasCode: 'ENDING_NAV', domainCode: 'FUND' }],
      nameAliases,
      domainAliases,
      domains: [{ domainCode: 'ISSUER', domainName: 'Issuer' }],
    });
    expect(ending.attributes).toEqual([
      expect.objectContaining({ attribute_code: 'NAV', matched_alias: 'Ending NAV', match: 'attribute_alias' }),
    ]);

    const borrower = assembleAttributeSearch('borrower', { nameAliases, domainAliases, domains: [{ domainCode: 'ISSUER', domainName: 'Issuer' }] });
    expect(borrower.entityTypes).toEqual([expect.objectContaining({ domain_code: 'ISSUER', matched_alias: 'Borrower' })]);
    expect(borrower.entityNames.map((hit) => hit.matched_alias)).toEqual(['Borrower name']);

    const project = assembleAttributeSearch('project name', { nameAliases, domainAliases });
    expect(project.entityNames).toEqual([
      expect.objectContaining({ attribute_code: 'entity_name', domain_code: 'ISSUER', matched_alias: 'Project name' }),
    ]);
  });
});

describe('resolveStoredAlias', () => {
  it('keeps a catalog name such as project name and otherwise uses the words', () => {
    expect(resolveStoredAlias('Project Falcon', 'PROJECT_NAME', ['PROJECT_NAME', 'BORROWER_NAME'])).toEqual({
      aliasLabel: 'Project Falcon',
      aliasCode: 'PROJECT_NAME',
      aliasKind: 'project',
    });
    expect(resolveStoredAlias('  Former name  ', null, [])).toMatchObject({ aliasCode: 'FORMER_NAME', aliasKind: 'name' });
    expect(resolveStoredAlias('   ', 'PROJECT_NAME', ['PROJECT_NAME'])).toEqual({ error: 'A name is required' });
  });
});

describe('takeIdentityTargets', () => {
  it('keeps the record name and the project name out of the attribute bag', () => {
    const split = takeIdentityTargets({
      entity_name: 'Acme Holdings',
      'entity_alias:PROJECT_NAME': 'Project Falcon',
      COUNTRY: 'US',
    });
    expect(split.entityName).toBe('Acme Holdings');
    expect(split.aliases).toEqual([{ aliasCode: 'PROJECT_NAME', aliasLabel: 'Project Falcon' }]);
    expect(split.attributes).toEqual({ COUNTRY: 'US' });
  });
});
