import { describe, expect, it } from 'vitest';
import {
  USAGE_BATCH,
  parseSettingsRow,
  settingsError,
  shapeAliases,
  shapeFields,
  usageCounts,
  usageRequests,
} from './client-catalog';

describe('parseSettingsRow', () => {
  it('reads the database answer, as an object or as text', () => {
    const row = {
      client_id: 'c1',
      can_edit: true,
      domain_code: 'ISSUER',
      catalog_name: 'Issuer',
      display_name: 'Borrower',
      hidden_attribute_ids: ['a1'],
      aliases: [{ id: 'x1', label: 'Obligor', client: false }],
    };
    expect(parseSettingsRow(row)).toEqual(row);
    expect(parseSettingsRow(JSON.stringify(row))).toEqual(row);
  });

  it('treats a session with no single client as read-only with nothing hidden', () => {
    expect(parseSettingsRow({ client_id: null, domain_code: 'ISSUER', catalog_name: 'Issuer' })).toEqual({
      client_id: null,
      can_edit: false,
      domain_code: 'ISSUER',
      catalog_name: 'Issuer',
      display_name: null,
      hidden_attribute_ids: [],
      aliases: [],
    });
  });

  it('lists the client\'s own words before the shared ones', () => {
    expect(shapeAliases([
      { id: '1', label: 'Obligor', client: false },
      { id: '2', label: 'Portfolio company', client: true },
      { id: '3', label: 'Borrower', client: false },
      { id: '4', label: 'Counterparty', client: true },
    ])).toEqual([
      { id: '4', label: 'Counterparty', shared: false },
      { id: '2', label: 'Portfolio company', shared: false },
      { id: '3', label: 'Borrower', shared: true },
      { id: '1', label: 'Obligor', shared: true },
    ]);
  });

  it('refuses an answer that names no entity type', () => {
    expect(() => parseSettingsRow(null)).toThrow();
    expect(() => parseSettingsRow({})).toThrow();
  });
});

describe('usageRequests', () => {
  it('counts every field of the type in one aggregate row', () => {
    const [request, ...rest] = usageRequests('ISSUER', ['COUNTRY', 'RATING', 'COUNTRY']);
    expect(rest).toHaveLength(0);
    expect(request).toMatchObject({ start: 'DOMAIN', domainCode: 'ISSUER', flat: true, limit: 1 });
    expect(request.metrics).toEqual([
      { alias: 'COUNTRY', agg: 'COUNT', field: 'COUNTRY' },
      { alias: 'RATING', agg: 'COUNT', field: 'RATING' },
    ]);
  });

  it('splits a long field list and leaves out a code the grid could not address', () => {
    const codes = Array.from({ length: USAGE_BATCH + 5 }, (_, index) => `F_${index}`);
    const requests = usageRequests('SECURITY', [...codes, 'bad code', 'sec.PRICE']);
    expect(requests.map((request) => request.metrics?.length)).toEqual([USAGE_BATCH, 5]);
  });

  it('asks for nothing when there are no fields', () => {
    expect(usageRequests('ISSUER', [])).toEqual([]);
  });
});

describe('usageCounts', () => {
  it('merges the rows of several requests', () => {
    const counts = usageCounts([{ COUNTRY: 12, RATING: 0 }, { SECTOR: '7' }, null]);
    expect([...counts]).toEqual([['COUNTRY', 12], ['RATING', 0], ['SECTOR', 7]]);
  });
});

describe('shapeFields', () => {
  const attributes = [
    { id: 'a2', attribute_code: 'RATING', attribute_name: 'Rating', display_section: 'Credit', is_visible: true },
    { id: 'a1', attribute_code: 'COUNTRY', attribute_name: 'Country', display_section: 'Credit', is_required: true, is_visible: true },
    { id: 'a3', attribute_code: 'OLD_ID', attribute_name: 'Old id', is_visible: false, catalog_is_visible: true },
    { id: 'a4', attribute_code: 'LEGACY', attribute_name: 'Legacy', is_visible: false, catalog_is_visible: false },
  ];

  it('lists fields by section then name, with the client hidden flag and the count', () => {
    const fields = shapeFields(attributes, ['a3'], new Map([['COUNTRY', 40], ['OLD_ID', 0]]));
    expect(fields.map((field) => field.attributeCode)).toEqual(['COUNTRY', 'RATING', 'LEGACY', 'OLD_ID']);
    expect(fields.find((field) => field.attributeCode === 'COUNTRY')).toMatchObject({ isRequired: true, hidden: false, recordsWithValue: 40 });
    expect(fields.find((field) => field.attributeCode === 'RATING')).toMatchObject({ recordsWithValue: 0 });
  });

  it('tells a field this client hides from one the catalog hides for everyone', () => {
    const fields = shapeFields(attributes, ['a3'], null);
    expect(fields.find((field) => field.attributeCode === 'OLD_ID')).toMatchObject({ hidden: true, catalogIsVisible: true });
    expect(fields.find((field) => field.attributeCode === 'LEGACY')).toMatchObject({ hidden: false, catalogIsVisible: false });
  });

  it('leaves the count empty when usage could not be read', () => {
    expect(shapeFields(attributes, [], null).every((field) => field.recordsWithValue === null)).toBe(true);
  });
});

describe('settingsError', () => {
  it('keeps the database sentence the person can act on', () => {
    expect(settingsError('Another entity type is already called Borrower')).toBe('Another entity type is already called Borrower');
  });

  it('puts a row security refusal and a missing function in plain words', () => {
    expect(settingsError('new row violates row-level security policy for table "client_domain_settings"'))
      .toBe('You cannot change this client\'s settings.');
    expect(settingsError('Could not find the function public.client_catalog_settings(p_domain_code) in the schema cache'))
      .toBe('Client names and hidden fields are not set up on this database yet.');
    expect(settingsError('')).toBe('The change could not be saved.');
  });
});
