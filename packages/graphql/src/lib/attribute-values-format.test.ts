import { describe, expect, it } from 'vitest';
import { coerceAttributeValue, dateAmbiguity, numberAmbiguity, parseNumber, parseUsDate } from './attribute-values';

describe('reading numbers with a decimal mark', () => {
  it('reads a European file with a comma decimal', () => {
    expect(parseNumber('1.500', ',')).toBe(1500);
    expect(parseNumber('1.234.567,89', ',')).toBe(1234567.89);
    expect(parseNumber('(2.500,5)', ',')).toBe(-2500.5);
  });

  it('reads a US file with a dot decimal', () => {
    expect(parseNumber('1,500', '.')).toBe(1500);
    expect(parseNumber('1,234,567.89', '.')).toBe(1234567.89);
  });

  it('refuses a number that does not fit the mark', () => {
    expect(parseNumber('1,23,4', '.')).toBeNull();
    expect(parseNumber('1.5.6', '.')).toBeNull();
  });
});

describe('flagging values that read two ways', () => {
  it('flags one mark followed by three digits, and nothing else', () => {
    expect(numberAmbiguity('1,500')).toMatch(/read as 1500.*1\.5/);
    expect(numberAmbiguity('1.500')).toMatch(/read as 1\.5/);
    expect(numberAmbiguity('1,500.25')).toBeNull();
    expect(numberAmbiguity('1500')).toBeNull();
    expect(numberAmbiguity('12,5')).toBeNull();
  });

  it('flags a slash date whose two parts could both be the month', () => {
    expect(dateAmbiguity('03/04/2025')).toMatch(/month first, as 2025-03-04/);
    expect(dateAmbiguity('13/04/2025')).toBeNull();
    expect(dateAmbiguity('04/04/2025')).toBeNull();
    expect(dateAmbiguity('2025-03-04')).toBeNull();
  });
});

describe('coerceAttributeValue', () => {
  it('reads US style without a format and says when a value could mean something else', () => {
    const number = coerceAttributeValue('1,500', 'DECIMAL');
    expect(number).toMatchObject({ golden_value_numeric: 1500, ambiguous: expect.stringMatching(/decimal mark/) });
    const date = coerceAttributeValue('03/04/2025', 'DATE');
    expect(date).toMatchObject({ golden_value_date: '2025-03-04', ambiguous: expect.stringMatching(/date order/) });
  });

  it('reads by the format when the file has one, and flags nothing', () => {
    expect(coerceAttributeValue('1.500', 'DECIMAL', { decimal: ',' })).toEqual({ golden_value: '1500', golden_value_numeric: 1500, golden_value_date: null, raw_value: '1.500' });
    expect(coerceAttributeValue('03/04/2025', 'DATE', { dateOrder: 'DMY' })).toMatchObject({ golden_value_date: '2025-04-03' });
    expect(parseUsDate('31/12/2025', 'DMY')).toBe('2025-12-31');
  });
});
