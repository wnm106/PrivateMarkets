import { describe, expect, it } from 'vitest';
import {
  chooseTapPair,
  normalizeTapDate,
  resolveTapRequests,
  tapCellValue,
  type TapAttributeMatch,
  type TapEntityMatch,
} from './tap';

const nav: TapAttributeMatch = { attributeId: 'a-nav', attributeCode: 'NAV', attributeName: 'Net asset value', dataType: 'CURRENCY', domainCode: 'FUND', matchKind: 'CODE' };
const rating: TapAttributeMatch = { attributeId: 'a-rating', attributeCode: 'RATING', attributeName: 'Rating', dataType: 'STRING', domainCode: 'ISSUER', matchKind: 'NAME' };
const fund: TapEntityMatch = { id: 'e-fund', entityCode: 'FUND-1', entityName: 'Apex', domainCode: 'FUND', matchKind: 'NAME' };
const issuer: TapEntityMatch = { id: 'e-issuer', entityCode: 'ISS-1', entityName: 'Apex', domainCode: 'ISSUER', matchKind: 'NAME' };

describe('normalizeTapDate', () => {
  it('treats blank as today', () => {
    expect(normalizeTapDate('')).toEqual({ ok: true, date: null });
    expect(normalizeTapDate(null)).toEqual({ ok: true, date: null });
  });

  it('keeps a calendar date', () => {
    expect(normalizeTapDate(' 2026-09-30 ')).toEqual({ ok: true, date: '2026-09-30' });
  });

  it('refuses text and impossible dates', () => {
    expect(normalizeTapDate('last quarter').ok).toBe(false);
    expect(normalizeTapDate('2026-02-30').ok).toBe(false);
  });
});

describe('chooseTapPair', () => {
  it('uses the record whose entity type carries the attribute when two records share a name', () => {
    const choice = chooseTapPair([nav], [fund, issuer]);
    expect(choice).toMatchObject({ ok: true, entity: { id: 'e-fund' } });
  });

  it('says which records match when the name alone cannot decide', () => {
    const twin = { ...fund, id: 'e-fund-2', entityCode: 'FUND-2' };
    const choice = chooseTapPair([nav], [fund, twin]);
    expect(choice).toMatchObject({ ok: false, error: 'AMBIGUOUS_ENTITY' });
    if (!choice.ok) expect(choice.candidates).toEqual(['FUND-1 (Apex, FUND)', 'FUND-2 (Apex, FUND)']);
  });

  it('lets a record code win over another record that only shares the name', () => {
    const byCode = { ...issuer, entityCode: 'APEX', matchKind: 'CODE' as const };
    expect(chooseTapPair([nav], [fund, byCode])).toMatchObject({ ok: true, entity: { id: 'e-issuer' } });
  });

  it('picks the attribute that fits the record when an alias names two attributes', () => {
    const fundRating = { ...rating, attributeId: 'a-fund-rating', attributeCode: 'FUND_RATING', domainCode: 'FUND', matchKind: 'ALIAS' as const };
    const issuerRating = { ...rating, matchKind: 'ALIAS' as const };
    expect(chooseTapPair([fundRating, issuerRating], [{ ...issuer, matchKind: 'CODE' }])).toMatchObject({
      ok: true,
      attribute: { attributeCode: 'RATING' },
    });
  });

  it('keeps the closest match of the same attribute', () => {
    const viaName = { ...nav, matchKind: 'NAME' as const };
    const choice = chooseTapPair([viaName, nav], [fund]);
    expect(choice).toMatchObject({ ok: true, attribute: { matchKind: 'CODE' } });
  });

  it('reports what is missing', () => {
    expect(chooseTapPair([], [fund])).toMatchObject({ ok: false, error: 'UNKNOWN_ATTRIBUTE' });
    expect(chooseTapPair([nav], [])).toMatchObject({ ok: false, error: 'UNKNOWN_ENTITY' });
  });
});

describe('tapCellValue', () => {
  it('returns numbers for numeric types', () => {
    expect(tapCellValue('CURRENCY', { numeric: '1250000.5', text: '1,250,000.50' })).toEqual({ value: 1250000.5, valueType: 'NUMBER' });
    expect(tapCellValue('PERCENTAGE', { text: '0.075' })).toEqual({ value: 0.075, valueType: 'NUMBER' });
  });

  it('returns dates as YYYY-MM-DD text', () => {
    expect(tapCellValue('DATE', { date: '2030-06-15', text: '2030-06-15T00:00:00' })).toEqual({ value: '2030-06-15', valueType: 'DATE' });
  });

  it('returns true or false for booleans', () => {
    expect(tapCellValue('BOOLEAN', { text: 'Yes' })).toEqual({ value: true, valueType: 'BOOLEAN' });
    expect(tapCellValue('BOOLEAN', { text: 'false' })).toEqual({ value: false, valueType: 'BOOLEAN' });
  });

  it('treats an empty stored value as no value', () => {
    expect(tapCellValue('STRING', { text: '  ' })).toBeNull();
    expect(tapCellValue('NUMBER', { text: '' })).toBeNull();
  });
});

describe('resolveTapRequests', () => {
  function fakeSupabase(options: {
    attributes?: Record<string, unknown>[];
    entities?: Record<string, unknown>[];
    winners?: Record<string, unknown>[];
    onRead?: Record<string, unknown>[];
    calcDefinitions?: Record<string, unknown>[];
  }) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const client = {
      calls,
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        if (fn === 'tap_attribute_matches') return Promise.resolve({ data: options.attributes || [], error: null });
        if (fn === 'tap_entity_matches') return Promise.resolve({ data: options.entities || [], error: null });
        if (fn === 'on_read_attribute_values') return Promise.resolve({ data: options.onRead || [], error: null });
        return Promise.resolve({ data: [], error: null });
      },
      schema() {
        return {
          rpc(fn: string, args: Record<string, unknown>) {
            calls.push({ fn, args });
            return Promise.resolve({ data: options.winners || [], error: null });
          },
        };
      },
      from() {
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          in: () => builder,
          then: (resolve: any) => resolve({ data: options.calcDefinitions || [], error: null }),
        };
        return builder;
      },
    };
    return client;
  }

  const navRow = { ref: 'nav', attribute_id: 'a-nav', attribute_code: 'NAV', attribute_name: 'Net asset value', data_type: 'CURRENCY', domain_code: 'FUND', match_kind: 'CODE' };
  const fundRow = { ref: 'Apex Fund', id: 'e-fund', entity_code: 'FUND-1', entity_name: 'Apex Fund', domain_code: 'FUND', match_kind: 'NAME' };

  it('answers each cell in order and reads values once per as-of date', async () => {
    const supabase = fakeSupabase({
      attributes: [navRow],
      entities: [fundRow],
      winners: [{ entity_id: 'e-fund', attribute_id: 'a-nav', golden_value: '1000', golden_value_numeric: 1000, valid_from: '2026-06-30' }],
    });
    const results = await resolveTapRequests(supabase as never, [
      { attribute: 'nav', entity: 'Apex Fund', asOfDate: '2026-09-30' },
      { attribute: 'NAV ', entity: 'apex fund', asOfDate: '2026-09-30' },
      { attribute: 'nav', entity: 'Apex Fund', asOfDate: 'soon' },
    ]);
    expect(results.map((row) => row.value)).toEqual([1000, 1000, null]);
    expect(results[0]).toMatchObject({ attributeCode: 'NAV', entityCode: 'FUND-1', valueType: 'NUMBER', validFrom: '2026-06-30', error: null });
    expect(results[2]).toMatchObject({ error: 'INVALID_REQUEST' });
    const winnerCalls = supabase.calls.filter((call) => call.fn === 'winning_attribute_values');
    expect(winnerCalls).toHaveLength(1);
    expect(winnerCalls[0].args).toMatchObject({ p_as_of: '2026-09-30', p_entity_ids: ['e-fund'], p_attribute_ids: ['a-nav'] });
  });

  it('falls back to an on-read calculation when nothing is stored', async () => {
    const supabase = fakeSupabase({
      attributes: [navRow],
      entities: [fundRow],
      calcDefinitions: [{ attribute_id: 'a-nav' }],
      onRead: [{ attribute_code: 'NAV', attribute_name: 'Net asset value', value_text: '42.5' }],
    });
    const [result] = await resolveTapRequests(supabase as never, [{ attribute: 'nav', entity: 'Apex Fund' }]);
    expect(result).toMatchObject({ value: 42.5, valueType: 'NUMBER', error: null, validFrom: null });
  });

  it('says when a record has no value', async () => {
    const supabase = fakeSupabase({ attributes: [navRow], entities: [fundRow] });
    const [result] = await resolveTapRequests(supabase as never, [{ attribute: 'nav', entity: 'Apex Fund', asOfDate: '2026-09-30' }]);
    expect(result).toMatchObject({ value: null, error: 'NO_VALUE', message: 'FUND-1 has no NAV on 2026-09-30.' });
  });

  it('returns the record code and name without a stored value', async () => {
    const supabase = fakeSupabase({ entities: [fundRow] });
    const results = await resolveTapRequests(supabase as never, [
      { attribute: 'entity_name', entity: 'Apex Fund' },
      { attribute: 'Entity_Code', entity: 'Apex Fund' },
    ]);
    expect(results.map((row) => row.value)).toEqual(['Apex Fund', 'FUND-1']);
    expect(supabase.calls.some((call) => call.fn === 'winning_attribute_values')).toBe(false);
  });

  it('refuses an oversized batch', async () => {
    const requests = Array.from({ length: 501 }, () => ({ attribute: 'NAV', entity: 'X' }));
    await expect(resolveTapRequests(fakeSupabase({}) as never, requests)).rejects.toThrow(/At most 500/);
  });
});
