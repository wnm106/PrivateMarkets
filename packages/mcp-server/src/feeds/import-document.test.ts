import { describe, expect, it } from 'vitest';
import { renderTables } from './import-document';

describe('renderTables', () => {
  it('writes a table of records as a heading and a markdown table', () => {
    const rendered = renderTables('issuers.csv', [
      { id: 't1', name: 'Issuers', headers: ['Code', 'Name', 'Country'], rows: [{ Code: 'A1', Name: 'Acme | Holdings', Country: 'US' }, { Code: 'B2', Name: 'Beta', Country: '' }] },
    ]);
    expect(rendered.text.split('\n')).toEqual([
      '# issuers.csv',
      '',
      '## Issuers',
      '',
      '| Code | Name | Country |',
      '| --- | --- | --- |',
      // A bar in a value would break the row, so it is written as a slash.
      '| A1 | Acme / Holdings | US |',
      '| B2 | Beta |  |',
      '',
    ]);
    expect(rendered).toMatchObject({ rows: 2, cut: false });
  });

  it('writes a statement line by line, each label with its value', () => {
    const rendered = renderTables('q3.xlsx', [
      { id: 't1', name: 'Income statement', headers: ['Entity Name', 'Revenue', 'EBITDA', 'Notes'], rows: [{ 'Entity Name': 'Acme', Revenue: '1,200', EBITDA: '310', Notes: '' }] },
    ]);
    expect(rendered.text).toContain('## Income statement');
    expect(rendered.text).toContain('Revenue: 1,200');
    expect(rendered.text).toContain('EBITDA: 310');
    // A blank value says nothing, so its label is left out.
    expect(rendered.text).not.toContain('Notes');
  });

  it('gives each table its own heading', () => {
    const rendered = renderTables('pack.xlsx', [
      { id: 'a', name: 'Positions', headers: ['Id', 'Par', 'Mark'], rows: [{ Id: '1', Par: '5', Mark: '99' }, { Id: '2', Par: '6', Mark: '98' }] },
      { id: 'b', name: 'Cash', headers: ['Date', 'Amount', 'Memo'], rows: [{ Date: '2026-09-30', Amount: '10', Memo: 'Fee' }, { Date: '2026-09-30', Amount: '4', Memo: 'Int' }] },
    ]);
    expect(rendered.text.match(/^## /gm)).toHaveLength(2);
    expect(rendered.rows).toBe(4);
  });

  it('cuts a very long table and says so', () => {
    const rows = Array.from({ length: 3200 }, (_, index) => ({ Id: String(index), Par: '1', Mark: '100' }));
    const rendered = renderTables('big.csv', [{ id: 't', name: 'Positions', headers: ['Id', 'Par', 'Mark'], rows }]);
    expect(rendered.cut).toBe(true);
    expect(rendered.rows).toBe(3000);
  });
});
