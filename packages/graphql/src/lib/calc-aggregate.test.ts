import { describe, expect, it } from 'vitest';
import { planAggregateUpdate, type AggregateAttribute, type AggregateRelationship } from './calc-aggregate';

const tranche: AggregateRelationship = {
  relationshipCode: 'TRANCHE_DEAL',
  parentDomainCode: 'DEAL_TRANCHE',
  childDomainCode: 'DEAL',
};

const attributes: AggregateAttribute[] = [
  { attributeCode: 'DEAL_FACILITY_SIZE', domainCode: 'DEAL', dataType: 'CURRENCY' },
  { attributeCode: 'TRANCHE_SIZE', domainCode: 'DEAL_TRANCHE', dataType: 'CURRENCY' },
  { attributeCode: 'TRANCHE_HOLD_PCT', domainCode: 'DEAL_TRANCHE', dataType: 'PERCENTAGE' },
  { attributeCode: 'DEAL_NAME', domainCode: 'DEAL', dataType: 'STRING' },
  { attributeCode: 'FUND_CASH_BALANCE', domainCode: 'FUND', dataType: 'CURRENCY' },
];

function plan(raw: Parameters<typeof planAggregateUpdate>[0], relationships: AggregateRelationship[] = [tranche]) {
  return planAggregateUpdate(raw, {
    ownAttributeCode: 'DEAL_FACILITY_SIZE',
    ownDomainCode: 'DEAL',
    attributes,
    relationships,
  });
}

const trancheSize = {
  attributeCode: 'TRANCHE_SIZE',
  traversal: 'UP',
  relationshipCodes: ['TRANCHE_DEAL'],
};

describe('aggregate calculation edits', () => {
  it('accepts a sum of tranche size through the tranche relationship', () => {
    const result = plan({ aggregateFn: 'sum', measure: trancheSize });
    expect(result.aggregateFn).toBe('SUM');
    expect(result.measure).toEqual(trancheSize);
    expect(result.weight).toBeNull();
  });

  it('keeps the weight on the same records as the measure', () => {
    const result = plan({
      aggregateFn: 'WAVG',
      measure: trancheSize,
      weightAttributeCode: 'TRANCHE_HOLD_PCT',
    });
    expect(result.weight).toEqual({
      attributeCode: 'TRANCHE_HOLD_PCT',
      traversal: 'UP',
      relationshipCodes: ['TRANCHE_DEAL'],
    });
  });

  it('rejects a weighted average without a weight', () => {
    expect(() => plan({ aggregateFn: 'WAVG', measure: trancheSize })).toThrow(/weight field/);
  });

  it('rejects a weight that lives on a different record', () => {
    expect(() => plan({
      aggregateFn: 'WAVG',
      measure: trancheSize,
      weightAttributeCode: 'FUND_CASH_BALANCE',
    })).toThrow(/FUND_CASH_BALANCE is on FUND/);
  });

  it('rejects a text field and a path that does not reach the field', () => {
    expect(() => plan({
      aggregateFn: 'SUM',
      measure: { attributeCode: 'DEAL_NAME', traversal: 'SELF', relationshipCodes: [] },
    })).toThrow(/numeric field/);
    expect(() => plan({
      aggregateFn: 'MIN',
      measure: { attributeCode: 'TRANCHE_SIZE', traversal: 'DOWN', relationshipCodes: ['TRANCHE_DEAL'] },
    })).toThrow(/does not connect from DEAL/);
  });

  it('rejects a calculation that reads itself', () => {
    expect(() => plan({
      aggregateFn: 'MAX',
      measure: { attributeCode: 'DEAL_FACILITY_SIZE', traversal: 'SELF', relationshipCodes: [] },
    })).toThrow(/cannot read itself/);
  });

  it('ignores a weight unless the function is a weighted average', () => {
    const result = plan({
      aggregateFn: 'SUM',
      measure: trancheSize,
      weightAttributeCode: 'TRANCHE_HOLD_PCT',
    });
    expect(result.weightAttributeCode).toBeNull();
    expect(result.weight).toBeNull();
  });
});
