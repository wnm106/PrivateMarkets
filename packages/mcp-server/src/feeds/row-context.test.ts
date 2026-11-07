import { describe, expect, it } from 'vitest';
import { resolveRowContext } from './row-context';

const fallback = { asOf: '2024-09-30', source: 'POSITION_FILE' };

describe('resolveRowContext', () => {
  it('uses the file date and source when no columns are mapped', () => {
    expect(resolveRowContext({ Name: 'A' }, {}, fallback)).toEqual(fallback);
  });

  it('lets a mapped column replace the file date and source, including blanks', () => {
    const map = { asOfHintColumn: 'As Of', sourceHintColumn: 'Source' };
    expect(resolveRowContext({ 'As Of': '9/30/2024', Source: 'bloomberg' }, map, fallback)).toEqual({
      asOf: '2024-09-30',
      source: 'BLOOMBERG',
    });
    expect(resolveRowContext({ 'As Of': '', Source: 'Position File' }, map, fallback)).toEqual({
      asOf: '2024-09-30',
      source: 'POSITION_FILE',
    });
    expect(resolveRowContext({ 'As Of': 'January 31, 2025', Source: '' }, map, { asOf: '2024-01-01', source: 'ALLVUE' })).toEqual({
      asOf: '2025-01-31',
      source: 'ALLVUE',
    });
  });
});
