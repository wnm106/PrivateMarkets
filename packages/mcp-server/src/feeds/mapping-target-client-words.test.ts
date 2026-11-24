import { describe, expect, it } from 'vitest';
import { mappingTargets, type AttributeChoice } from './suggest';

const attributes: AttributeChoice[] = [
  { attributeCode: 'RATING', attributeName: 'Rating', dataType: 'STRING', domainCode: 'ISSUER', referenceListCode: null },
  { attributeCode: 'FAX', attributeName: 'Fax', dataType: 'STRING', domainCode: 'ISSUER', referenceListCode: null, hiddenForClient: true },
  { attributeCode: 'NAV', attributeName: 'NAV', dataType: 'NUMBER', domainCode: 'FUND', referenceListCode: null },
];

describe('mapping targets in a client\'s words', () => {
  it('names an entity type the way the client does', () => {
    const targets = mappingTargets(attributes, ['ISSUER', 'FUND'], { domains: [], names: [], labels: { ISSUER: 'Borrower' } });
    const byKey = new Map(targets.map((target) => [target.key, target]));
    expect(byKey.get('identity:ISSUER')).toMatchObject({ group: 'Borrower', label: 'Borrower \u00b7 Code' });
    expect(byKey.get('name:ISSUER')?.label).toBe('Borrower \u00b7 Name');
    expect(byKey.get('attribute:ISSUER:RATING')).toMatchObject({ group: 'Borrower', label: 'Borrower \u00b7 Rating' });
    // A type the client has not named keeps its own label.
    expect(byKey.get('attribute:FUND:NAV')?.group).toBe(byKey.get('identity:FUND')?.group);
    expect(byKey.get('identity:FUND')?.group).not.toBe('Borrower');
  });

  it('says which fields the client hides, and leaves them loadable', () => {
    const targets = mappingTargets(attributes, ['ISSUER', 'FUND'], { domains: [], names: [] });
    const fax = targets.find((target) => target.key === 'attribute:ISSUER:FAX');
    expect(fax).toMatchObject({ role: 'attribute', attributeCode: 'FAX', hiddenForClient: true });
    expect(targets.find((target) => target.key === 'attribute:ISSUER:RATING')?.hiddenForClient).toBeUndefined();
  });

  it('keeps the labels it always had when no client name is given', () => {
    const before = mappingTargets(attributes, ['ISSUER', 'FUND']);
    const after = mappingTargets(attributes, ['ISSUER', 'FUND'], { domains: [], names: [], labels: {} });
    expect(after.map((target) => target.label)).toEqual(before.map((target) => target.label));
  });
});
