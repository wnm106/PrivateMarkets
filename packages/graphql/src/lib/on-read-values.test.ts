import { describe, expect, it } from 'vitest';
import { knowledgeCutoff, loadOnReadValues, mergeOnReadLineage, type OnReadLineage } from './on-read-values';

function row(partial: Partial<OnReadLineage> & Pick<OnReadLineage, 'attributeCode'>): OnReadLineage {
  return {
    currentValue: null,
    competingValues: [],
    ...partial,
  };
}

describe('mergeOnReadLineage', () => {
  it('shows a calculated value when the field has no stored row', () => {
    const merged = mergeOnReadLineage<OnReadLineage>([], [{
      attributeCode: 'EBITDA_LTM',
      attributeName: 'LTM EBITDA',
      valueText: '40000000',
    }], '2026-11-07');
    expect(merged).toHaveLength(1);
    expect(merged[0].currentValue).toBe('40000000');
    expect(merged[0].competingValues[0].source).toBe('CALCULATED');
    expect(merged[0].resolutionRule).toBe('Calculated');
  });

  it('keeps a manual entry ahead of the calculation', () => {
    const merged = mergeOnReadLineage([
      row({
        attributeCode: 'EBITDA_LTM',
        currentValue: '1',
        competingValues: [{ source: 'MANUAL', value: '1' }],
      }),
    ], [{ attributeCode: 'EBITDA_LTM', attributeName: 'LTM EBITDA', valueText: '40000000' }], '2026-11-07');
    expect(merged[0].currentValue).toBe('1');
  });

  it('replaces a feed value with the calculation', () => {
    const merged = mergeOnReadLineage([
      row({
        attributeCode: 'REVENUE_LTM',
        currentValue: '9',
        competingValues: [{ source: 'INTERNAL', value: '9' }],
      }),
    ], [{ attributeCode: 'REVENUE_LTM', attributeName: 'LTM Revenue', valueText: '120' }], '2026-11-07');
    expect(merged[0].currentValue).toBe('120');
    expect(merged[0].competingValues.map((value) => value.source)).toEqual(['CALCULATED', 'INTERNAL']);
  });
});

describe('knowledgeCutoff', () => {
  it('treats a blank, today, or future date as current knowledge', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(knowledgeCutoff(null)).toBeNull();
    expect(knowledgeCutoff('')).toBeNull();
    expect(knowledgeCutoff(today)).toBeNull();
    expect(knowledgeCutoff('2099-01-01')).toBeNull();
  });

  it('closes a past calendar day at the end of that day', () => {
    expect(knowledgeCutoff('2020-01-15')).toBe('2020-01-15T23:59:59.999Z');
  });
});

describe('loadOnReadValues', () => {
  it('sends the knowledge cutoff with the as-of date', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const supabase = {
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        calls.push(args);
        return { data: [], error: null };
      },
    };
    await loadOnReadValues(supabase, 'entity-1', '2026-06-30', '2020-01-15');
    expect(calls).toEqual([{
      p_entity_id: 'entity-1',
      p_as_of: '2026-06-30',
      p_knowledge: '2020-01-15T23:59:59.999Z',
    }]);
  });
});
