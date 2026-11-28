import { describe, expect, it } from 'vitest';
import { attributeChoices, groupAttributeChoices, type AttributeHit } from './search';

const hit = (attributeCode: string, domainCode: string | null): AttributeHit => ({
  attributeCode,
  attributeName: attributeCode,
  dataType: 'NUMBER',
  domainCode,
  matchedAlias: null,
  match: 'NAME',
});

describe('groupAttributeChoices', () => {
  it('groups by entity type in alphabetical order, keeps the ranking within a type, and puts untyped last', () => {
    const choices = attributeChoices({
      attributes: [
        hit('DEAL_EBITDA', 'DEAL'),
        hit('CAPSTRUCT_VALUATION_BASIS', 'CAPITAL_STRUCTURE'),
        hit('LOOSE', null),
        hit('COMPONENT_CLAUSE', 'COVENANT_COMPONENT'),
        hit('DEAL_LEVERAGE_TOTAL', 'DEAL'),
        hit('DEAL_LEVERAGE_SENIOR', 'DEAL'),
      ],
      entityNames: [],
    });
    expect(groupAttributeChoices(choices).map((group) => [group.domainCode, group.choices.map((choice) => choice.code)])).toEqual([
      ['CAPITAL_STRUCTURE', ['CAPSTRUCT_VALUATION_BASIS']],
      ['COVENANT_COMPONENT', ['COMPONENT_CLAUSE']],
      ['DEAL', ['DEAL_EBITDA', 'DEAL_LEVERAGE_TOTAL', 'DEAL_LEVERAGE_SENIOR']],
      [null, ['LOOSE']],
    ]);
  });

  it('puts a record-name row under its entity type', () => {
    const choices = attributeChoices({ attributes: [hit('FUND_NAV', 'FUND')], entityNames: [hit('ENTITY_NAME', 'DEAL')] });
    expect(groupAttributeChoices(choices).map((group) => [group.domainCode, group.choices.map((choice) => choice.code)])).toEqual([
      ['DEAL', ['ENTITY_NAME']],
      ['FUND', ['FUND_NAV']],
    ]);
  });
});
