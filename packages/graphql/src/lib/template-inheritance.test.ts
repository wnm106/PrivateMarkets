import { describe, expect, it } from 'vitest';
import {
  choiceOn,
  inheritingDomain,
  resolveEffectiveTemplate,
  rulesForInheritor,
  rulesForSupplier,
  supplyingDomain,
  templateSide,
  type InheritanceRule,
  type TemplateChoice,
  type TemplateRecord,
} from './template-inheritance';

// The statement period carries the link, so it sits in the parent column.
const statementIssuer: InheritanceRule = {
  relationshipCode: 'STATEMENT_ISSUER',
  parentDomainCode: 'STATEMENT_PERIOD',
  childDomainCode: 'ISSUER',
  templateFromSide: 'CHILD',
};

function period(overrides: Partial<TemplateRecord> = {}): TemplateRecord {
  return {
    id: 'period-1',
    domainCode: 'STATEMENT_PERIOD',
    ownTemplateId: 'standard',
    onDate: '2025-03-31',
    links: [{ relationshipCode: 'STATEMENT_ISSUER', side: 'CHILD', entityId: 'acme', entityName: 'Acme' }],
    ...overrides,
  };
}

function choice(overrides: Partial<TemplateChoice>): TemplateChoice {
  return {
    entityId: 'acme',
    relationshipCode: 'STATEMENT_ISSUER',
    templateId: 'saas',
    validFrom: '0001-01-01',
    validTo: '9999-12-31',
    ...overrides,
  };
}

describe('template inheritance', () => {
  it('names the side that supplies the template, whatever the columns are called', () => {
    expect(supplyingDomain(statementIssuer)).toBe('ISSUER');
    expect(inheritingDomain(statementIssuer)).toBe('STATEMENT_PERIOD');
    expect(rulesForInheritor('statement_period', [statementIssuer])).toHaveLength(1);
    expect(rulesForInheritor('ISSUER', [statementIssuer])).toHaveLength(0);
    expect(rulesForSupplier('ISSUER', [statementIssuer])).toHaveLength(1);
    const reversed: InheritanceRule = { ...statementIssuer, templateFromSide: 'PARENT' };
    expect(supplyingDomain(reversed)).toBe('STATEMENT_PERIOD');
    expect(templateSide('child')).toBe('CHILD');
    expect(templateSide('sideways')).toBeNull();
  });

  it('keeps the template stamped on the record until the linked record chooses one', () => {
    const resolved = resolveEffectiveTemplate(period(), [statementIssuer], []);
    expect(resolved).toMatchObject({ templateId: 'standard', source: 'OWN', fromEntityId: 'acme', relationshipCode: 'STATEMENT_ISSUER' });
    expect(resolveEffectiveTemplate(period({ ownTemplateId: null, links: [] }), [statementIssuer], []))
      .toMatchObject({ templateId: null, source: 'NONE', fromEntityId: null });
  });

  it('takes the template chosen on the issuer for every statement period', () => {
    const resolved = resolveEffectiveTemplate(period(), [statementIssuer], [choice({})]);
    expect(resolved).toMatchObject({ templateId: 'saas', source: 'INHERITED', fromEntityId: 'acme', fromEntityName: 'Acme' });
    const other = resolveEffectiveTemplate(
      period({ id: 'period-9', links: [{ relationshipCode: 'STATEMENT_ISSUER', side: 'CHILD', entityId: 'globex' }] }),
      [statementIssuer],
      [choice({})],
    );
    expect(other).toMatchObject({ templateId: 'standard', source: 'OWN', fromEntityId: 'globex' });
  });

  it('ignores a link on the other side and a relationship with no rule', () => {
    const wrongSide = period({ links: [{ relationshipCode: 'STATEMENT_ISSUER', side: 'PARENT', entityId: 'acme' }] });
    expect(resolveEffectiveTemplate(wrongSide, [statementIssuer], [choice({})]).source).toBe('OWN');
    expect(resolveEffectiveTemplate(period(), [], [choice({})]).source).toBe('OWN');
  });

  it('follows the entity type when a relationship is stored the other way round', () => {
    const flipped = period({ links: [{ relationshipCode: 'STATEMENT_ISSUER', side: 'PARENT', entityId: 'acme', domainCode: 'ISSUER' }] });
    expect(resolveEffectiveTemplate(flipped, [statementIssuer], [choice({})]).source).toBe('INHERITED');
    const sibling = period({ links: [{ relationshipCode: 'STATEMENT_ISSUER', side: 'CHILD', entityId: 'acme', domainCode: 'STATEMENT_PERIOD' }] });
    expect(resolveEffectiveTemplate(sibling, [statementIssuer], [choice({})]).source).toBe('OWN');
  });

  it('reads the choice in force on the period date', () => {
    const dated = [
      choice({ templateId: 'old', validTo: '2024-12-31' }),
      choice({ templateId: 'new', validFrom: '2025-01-01' }),
    ];
    expect(resolveEffectiveTemplate(period({ onDate: '2024-06-30' }), [statementIssuer], dated).templateId).toBe('old');
    expect(resolveEffectiveTemplate(period({ onDate: '2025-03-31' }), [statementIssuer], dated).templateId).toBe('new');
    expect(choiceOn([choice({ validFrom: '2025-01-01' })], 'acme', 'STATEMENT_ISSUER', '2024-06-30')).toBeNull();
  });

  it('lets one record override what it inherits', () => {
    const choices = [choice({}), choice({ entityId: 'period-1', relationshipCode: null, templateId: 'bespoke' })];
    expect(resolveEffectiveTemplate(period(), [statementIssuer], choices))
      .toMatchObject({ templateId: 'bespoke', source: 'OVERRIDE', fromEntityId: 'acme' });
    expect(resolveEffectiveTemplate(period({ id: 'period-2' }), [statementIssuer], choices))
      .toMatchObject({ templateId: 'saas', source: 'INHERITED' });
  });
});
