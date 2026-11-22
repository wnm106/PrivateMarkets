import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { MAX_UNPACKED_BYTES, spreadsheetProblem } from './spreadsheet-safety';

function workbook(): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Fund', 'NAV'], ['A', 100], ['B', 200]]), 'NAV');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** The same zip, with every part's stated unpacked size set to `size`. */
function claiming(zip: Buffer, size: number): Buffer {
  const copy = Buffer.from(zip);
  for (let at = 0; at + 46 <= copy.length; at += 1) {
    if (copy.readUInt32LE(at) === 0x02014b50) copy.writeUInt32LE(size, at + 24);
  }
  return copy;
}

describe('spreadsheetProblem', () => {
  it('opens a real workbook, and leaves files that are not zips alone', () => {
    expect(spreadsheetProblem(workbook())).toBeNull();
    expect(spreadsheetProblem(Buffer.from('Fund,NAV\nA,100\n'))).toBeNull();
  });

  it('refuses a workbook whose parts would unpack past the limit', () => {
    const bomb = claiming(workbook(), Math.ceil(MAX_UNPACKED_BYTES / 4));
    expect(spreadsheetProblem(bomb)).toMatch(/MB once opened/);
  });

  it('refuses a workbook that expands far more than a spreadsheet does', () => {
    const inflated = claiming(workbook(), 4 * 1024 * 1024);
    expect(spreadsheetProblem(inflated)).toMatch(/expands far more|MB once opened/);
  });

  it('refuses a zip with no contents list, and one that says it is ZIP64', () => {
    const zip = workbook();
    expect(spreadsheetProblem(zip.subarray(0, zip.length - 22))).toMatch(/damaged/);
    expect(spreadsheetProblem(claiming(zip, 0xffffffff))).toMatch(/too large/);
  });
});
