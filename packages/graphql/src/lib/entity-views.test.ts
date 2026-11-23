import { describe, expect, it } from 'vitest';
import { normalizeEntityView, viewGridField } from './entity-views';

const base = {
  domainCode: 'POSITION',
  viewName: 'Prices by source',
  lookups: [{ alias: 'sec', direction: 'up', domainCode: 'SECURITY', label: 'Security' }],
  columns: [
    { field: 'entity_name' },
    { field: 'MARKET_VALUE' },
    { field: 'sec.PRICE', source: 'BLOOMBERG' },
    { field: 'sec.PRICE' },
  ],
  sort: [{ field: 'sec.PRICE@BLOOMBERG', dir: 'DESC' }, { field: 'NOT_A_COLUMN', dir: 'asc' }],
};

describe('entity views', () => {
  it('reads golden unless a column names a source', () => {
    expect(viewGridField({ field: 'PRICE' })).toBe('PRICE');
    expect(viewGridField({ field: 'sec.PRICE', source: 'WSO' })).toBe('sec.PRICE@WSO');
    expect(viewGridField({ field: 'PRICE', source: '  ' })).toBe('PRICE');
  });

  it('keeps a column locked to the left only when asked', () => {
    const { value } = normalizeEntityView({
      ...base,
      columns: [{ field: 'entity_name', pinned: true }, { field: 'MARKET_VALUE', pinned: 'yes' }, { field: 'entity_code' }],
    });
    expect(value.columns).toEqual([{ field: 'entity_name', pinned: true }, { field: 'MARKET_VALUE' }, { field: 'entity_code' }]);
  });

  it('keeps a valid view and drops sorts on fields it does not show', () => {
    const { value, errors } = normalizeEntityView(base);
    expect(errors).toEqual([]);
    expect(value.lookups[0].direction).toBe('UP');
    expect(value.columns).toHaveLength(4);
    expect(value.sort).toEqual([{ field: 'sec.PRICE@BLOOMBERG', dir: 'desc' }]);
  });

  it('lets the same attribute appear once per source', () => {
    const { errors } = normalizeEntityView({ ...base, columns: [...base.columns, { field: 'sec.PRICE', source: 'BLOOMBERG' }] });
    expect(errors.map((e) => e.message).join(' ')).toMatch(/listed twice/);
  });

  it('refuses a column on a related entity the view does not define', () => {
    const { errors } = normalizeEntityView({ ...base, columns: [{ field: 'iss.RATING' }] });
    expect(errors[0].message).toMatch(/does not define/);
  });

  it('refuses a source on the record name', () => {
    const { errors } = normalizeEntityView({ ...base, columns: [{ field: 'entity_name', source: 'WSO' }] });
    expect(errors[0].message).toMatch(/has no source/);
  });

  it('refuses a chained lookup that starts from a later one', () => {
    const { errors } = normalizeEntityView({
      ...base,
      lookups: [{ alias: 'iss', direction: 'UP', from: 'sec' }, { alias: 'sec', direction: 'UP' }],
      columns: [{ field: 'MARKET_VALUE' }],
    });
    expect(errors[0].message).toMatch(/not listed before/);
  });

  it('reserves the alternate-direction suffix', () => {
    const { errors } = normalizeEntityView({ ...base, lookups: [{ alias: 'sec_alt', direction: 'UP' }], columns: [{ field: 'X' }] });
    expect(errors[0].field).toBe('lookups[0]');
  });

  it('needs a name, an entity type and a column', () => {
    const { errors } = normalizeEntityView({ columns: [] });
    expect(errors.map((e) => e.field)).toEqual(['domainCode', 'viewName', 'columns']);
  });
});
