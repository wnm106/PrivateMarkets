import { describe, expect, it } from 'vitest';
import { cellAddressAt, columnIndex, columnLetters, readOverrideCell, referenceKey, referencesIn, splitAddress, statusText, summarize } from './overrides';

describe('addresses', () => {
  it('converts column letters both ways', () => {
    for (const [letters, index] of [['A', 0], ['Z', 25], ['AA', 26], ['AZ', 51], ['XFD', 16383]] as const) {
      expect(columnIndex(letters)).toBe(index);
      expect(columnLetters(index)).toBe(letters);
    }
  });

  it('finds each cell inside a selected range, quoting sheet names that need it', () => {
    expect(cellAddressAt('Sheet1!B2:D5', 0, 0)).toBe('Sheet1!B2');
    expect(cellAddressAt('Sheet1!B2:D5', 2, 1)).toBe('Sheet1!C4');
    expect(cellAddressAt("'Q3 marks'!Y9:AB9", 0, 3)).toBe("'Q3 marks'!AB9");
    expect(splitAddress("'Bob''s book'!$C$3")).toEqual({ sheet: "Bob's book", address: 'C3' });
  });
});

describe('reading a selected TAP cell', () => {
  const today = '2026-11-21';

  it('takes literal arguments as written, and today when there is no as-of', () => {
    expect(readOverrideCell({ address: 'Sheet1!C2', formula: '=TAP("NAV", "FUND-1")', value: 1000 }, new Map(), today)).toEqual({
      ok: true,
      row: { address: 'Sheet1!C2', attribute: 'NAV', entity: 'FUND-1', validFrom: today, shown: 1000 },
    });
  });

  it('reads cells the formula points at, on its own sheet or another, and date cells as dates', () => {
    const cells = [{ address: 'Grid!C2', formula: '=TAP(C$1, $A2, Inputs!$B$1)', value: 1250000.5 }];
    expect(referencesIn(cells).map(referenceKey)).toEqual(['GRID!C1', 'GRID!A2', 'INPUTS!B1']);
    const values = new Map<string, unknown>([['GRID!C1', 'NAV'], ['GRID!A2', 'FUND-1'], ['INPUTS!B1', 46295]]);
    expect(readOverrideCell(cells[0], values, today)).toMatchObject({ ok: true, row: { attribute: 'NAV', entity: 'FUND-1', validFrom: '2026-09-30' } });
  });

  it('says when it cannot tell which value a cell shows', () => {
    expect(readOverrideCell({ address: 'S!A1', formula: '=TAP(UPPER(B1), "FUND-1")', value: 1 }, new Map(), today)).toMatchObject({ ok: false });
    expect(readOverrideCell({ address: 'S!A1', formula: '=SUM(B1:B3)', value: 1 }, new Map(), today)).toMatchObject({ ok: false, problem: 'Not a TAP formula.' });
    expect(readOverrideCell({ address: 'S!A1', formula: '=TAP("NAV", B1)', value: 1 }, new Map([['S!B1', '']]), today)).toMatchObject({ ok: false, problem: 'The attribute or record is blank.' });
    expect(readOverrideCell({ address: 'S!A1', formula: '=TAP("NAV", "X", "soon")', value: 1 }, new Map(), today)).toMatchObject({ ok: false });
  });
});

describe('status words', () => {
  it('explains each outcome', () => {
    expect(statusText({ status: 'READY', message: null })).toBe('Will be saved');
    expect(statusText({ status: 'STALE', message: 'It is now 1000.' })).toBe('Changed since you checked: It is now 1000.');
    expect(statusText({ status: 'NO_ACCESS', message: 'You cannot change this record.' })).toBe('You cannot change this record.');
    expect(summarize([{ status: 'SAVED' }, { status: 'SAVED' }, { status: 'UNCHANGED' }, { status: 'NO_ACCESS' }])).toBe('2 saved, 1 unchanged, 1 need attention');
  });
});
