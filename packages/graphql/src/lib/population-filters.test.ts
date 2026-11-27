import { describe, expect, it } from 'vitest';
import { describeConditions, normalizePopulationFilter } from './population-filters';

const line = { attributeCode: 'STATUS', operator: 'equals', value: 'ACTIVE', conditionGroup: 1, conditionOrder: 1 };

describe('normalizePopulationFilter', () => {
  it('keeps conditions that name an attribute and drops blank lines', () => {
    const { value, errors } = normalizePopulationFilter({
      domainCode: 'FUND', filterName: ' Active funds ', conditions: [line, { attributeCode: '  ' }],
    });
    expect(errors).toEqual([]);
    expect(value.filterName).toBe('Active funds');
    expect(value.conditions).toHaveLength(1);
  });

  it('needs a name, an entity type and a condition', () => {
    const { errors } = normalizePopulationFilter({ conditions: [] });
    expect(errors.map((e) => e.field).sort()).toEqual(['conditions', 'domainCode', 'filterName']);
  });
});

describe('describeConditions', () => {
  it('says every record when there are no conditions', () => {
    expect(describeConditions([])).toBe('Every record.');
  });
  it('joins a group as written, groups with OR, and names a related path', () => {
    const text = describeConditions([
      { attributeCode: 'STATUS', operator: 'equals', value: 'ACTIVE', conditionGroup: 1, conditionOrder: 1 },
      { attributeCode: 'REGION', operator: 'in', value: '["EU"]', conditionGroup: 1, conditionOrder: 2, logicOperator: 'AND',
        attributeDimension: { relationshipPath: [{ relationshipCode: 'FUND_MANAGER', direction: 'up' }] } },
      { attributeCode: 'IS_PILOT', operator: 'equals', value: 'true', conditionGroup: 2, conditionOrder: 1 },
    ]);
    expect(text).toBe('STATUS equals ACTIVE and REGION of the related record reached by FUND_MANAGER UP is one of ["EU"]; OR IS_PILOT equals true.');
  });
});

describe('population codes', () => {
  it('normalises a typed code and refuses one that is not a code', () => {
    const ok = normalizePopulationFilter({ domainCode: 'FUND', filterName: 'A', populationCode: 'active funds', conditions: [line] });
    expect(ok.value.populationCode).toBe('ACTIVE_FUNDS');
    const bad = normalizePopulationFilter({ domainCode: 'FUND', filterName: 'A', populationCode: '9x!', conditions: [line] });
    expect(bad.errors.map((e) => e.field)).toContain('populationCode');
  });
});
