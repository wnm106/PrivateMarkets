import { describe, expect, it } from 'vitest';
import { refineLocations } from './locate';
import type { CellLocation } from './types';

const page = (fragments: { text: string; x: number; y: number }[]) => ({
  page: 1,
  width: 612,
  height: 792,
  fragments: fragments.map((fragment) => ({ ...fragment, w: 40, h: 10 })),
});

const rowBand = (y: number): CellLocation => ({ page: 1, x: 40, y, w: 500, h: 20, precision: 'row' });

describe('refineLocations', () => {
  const headers = ['Issuer', 'Spread'];
  const rows = [{ Issuer: 'Acme', Spread: '425' }, { Issuer: 'Beta', Spread: '425' }];

  it('finds each value and keeps repeated values on their own row', () => {
    const fragments = page([
      { text: 'Issuer', x: 50, y: 90 }, { text: 'Spread', x: 300, y: 90 },
      { text: 'Acme', x: 50, y: 110 }, { text: '425', x: 300, y: 110 },
      { text: 'Beta', x: 50, y: 130 }, { text: '425', x: 300, y: 130 },
    ]);
    const bands = rows.map((_, index) => [rowBand(100 + index * 20), rowBand(100 + index * 20)]);
    const result = refineLocations(headers, rows, bands, [fragments]);
    expect(result[0][0]).toMatchObject({ x: 50, y: 110, precision: 'cell' });
    expect(result[0][1]).toMatchObject({ x: 300, y: 110, precision: 'cell' });
    expect(result[1][0]).toMatchObject({ x: 50, y: 130, precision: 'cell' });
    expect(result[1][1]).toMatchObject({ x: 300, y: 130, precision: 'cell' });
  });

  it('keeps the row box for a value it cannot find', () => {
    const fragments = page([{ text: 'Acme', x: 50, y: 110 }]);
    const bands = rows.map((_, index) => [rowBand(100 + index * 20), rowBand(100 + index * 20)]);
    const result = refineLocations(headers, rows, bands, [fragments]);
    expect(result[0][0]?.precision).toBe('cell');
    expect(result[0][1]?.precision).toBe('row');
    expect(result[1][0]?.precision).toBe('row');
  });

  it('does not move a row above the one before it', () => {
    const fragments = page([
      { text: 'Beta', x: 50, y: 60 },
      { text: 'Acme', x: 50, y: 110 }, { text: 'Beta', x: 50, y: 130 },
    ]);
    const bands = rows.map((_, index) => [rowBand(100 + index * 20), rowBand(100 + index * 20)]);
    const result = refineLocations(headers, rows, bands, [fragments]);
    expect(result[1][0]).toMatchObject({ y: 130, precision: 'cell' });
  });
});
