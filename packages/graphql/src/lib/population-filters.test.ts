import { describe, expect, it } from 'vitest';
import { normalizePopulationFilter } from './population-filters';

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
