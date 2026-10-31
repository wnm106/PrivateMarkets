import { describe, expect, it } from 'vitest';
import { QUERY_DATA_GUIDE, queryGrain, valueRequest } from './query-data';

describe('query_data', () => {
  it('treats a source question as one row per field', () => {
    expect(queryGrain({ grain: 'value' })).toBe('value');
    expect(queryGrain({ start: 'DOMAIN', domainCode: 'ISSUER' })).toBe('entity');
  });

  it('keeps a source filter and lifts an attribute code into the scan', () => {
    const request = valueRequest({
      filters: [
        { field: 'source_name', op: 'eq', value: 'Manual Entry' },
        { field: 'attribute_code', op: 'eq', value: 'lei' },
        { field: 'domain_code', op: 'eq', value: 'Issuer' },
      ],
      metrics: [{ alias: 'fields', agg: 'COUNT' }],
    }) as any;
    expect(request.domainCode).toBe('Issuer');
    expect(request.attributeCodes).toEqual(['lei']);
    expect(request.filters).toEqual([{ field: 'source_name', op: 'eq', value: 'Manual Entry' }]);
  });

  it('rejects a sum of a text field', () => {
    expect(() => valueRequest({
      metrics: [{ alias: 'n', agg: 'SUM', field: 'value' }],
    })).toThrow(/numeric_value/);
  });

  it('tells the agent to navigate relationships and read composite identifiers', () => {
    expect(QUERY_DATA_GUIDE).toContain('get_model_map');
    expect(QUERY_DATA_GUIDE).toContain('WEIGHTED_AVG');
    expect(QUERY_DATA_GUIDE).toContain('fund.entity_name');
    expect(QUERY_DATA_GUIDE).toContain('iss.INDUSTRY');
  });
});
