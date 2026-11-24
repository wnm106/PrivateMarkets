import { describe, expect, it } from 'vitest';
import { cleanReading, outsideReading, readMarkdownPages, readingPath, sha256Hex } from '@tapestrai/graphql/src/lib/document-content';
import { fileKind, passagesWith } from './import-document';
import { extractTablesWithLlamaParse, readingFromParse, readWithLlamaParse, tidyPageMarkdown } from './llama-parse';
import { mediaTypeOf } from '../tools/position-file-tools';

/**
 * What LlamaParse returned for a made-up three-page package on 2026-11-23 (expand=items,markdown),
 * cut to what the reading uses. Each page has a running header and a "Page n of 3" footer, and a
 * footnote at its foot.
 */
const page = (number: number, markdown: string, items: Array<Record<string, unknown>>) => ({
  markdown: { page_number: number, success: true, markdown, header: 'Sample Borrower Inc. Quarterly Package', footer: `Confidential Page ${number} of 3` },
  items: { page_number: number, page_width: 612, page_height: 792, items: [{ type: 'header', md: 'Sample Borrower Inc. Quarterly Package' }, ...items, { type: 'footer', md: `Confidential Page ${number} of 3` }] },
});

const TABLE_HTML =
  '<table><thead><tr><th>Covenant</th><th>Certified value</th><th>Limit</th><th>Status</th></tr></thead><tbody><tr><td>Net Leverage Ratio</td><td>2.76x</td><td>3.25x</td><td>In compliance</td></tr><tr><td>Liquidity</td><td>$47,466,000</td><td>$7,000,000</td><td>In compliance</td></tr></tbody></table>';

const PAGES = [
  page(
    1,
    `# Sample Borrower Inc. Compliance Certificate\n\nFor the fiscal quarter ended September 30, 2026.\n\nThe undersigned certifies that the financial covenants set out below were met.(1)\n\n${TABLE_HTML}\n\n----\n\n(1) Consolidated Adjusted EBITDA includes $3.5 million of run-rate cost savings under clause (ix) of the definition.`,
    [
      { type: 'heading', level: 1, md: '# Sample Borrower Inc. Compliance Certificate' },
      { type: 'text', md: 'The undersigned certifies that the financial covenants set out below were met.(1)' },
      { type: 'table', rows: [['Covenant', 'Certified value', 'Limit', 'Status'], ['Net Leverage Ratio', '2.76x', '3.25x', 'In compliance'], ['Liquidity', '$47,466,000', '$7,000,000', 'In compliance']], bbox: [{ x: 72, y: 150, w: 420, h: 60 }] },
      { type: 'text', md: '(1) Consolidated Adjusted EBITDA includes $3.5 million of run-rate cost savings under clause (ix) of the definition.' },
    ],
  ),
  page(
    2,
    '## **Note 4. Debt**\n\nThe Term Loan bears interest at SOFR plus 5.25% and matures on June 30, 2030.(2)\nLetters of credit of $4.7 million were outstanding at quarter end.\n\n----\n\n(2) The margin steps down to 5.00% when the Net Leverage Ratio is below 2.50x.',
    [{ type: 'heading', level: 2, md: '## **Note 4. Debt**' }, { type: 'text', md: 'The Term Loan bears interest at SOFR plus 5.25%.(2)' }, { type: 'text', md: '(2) The margin steps down to 5.00% when the Net Leverage Ratio is below 2.50x.' }],
  ),
  page(
    3,
    '## **Note 5. Subsequent events**\n\nOn October 14, 2026 the Company drew $6.0 million on its revolving credit facility.(3)\n\n----\n\n(3) The draw is not reflected in the September 30, 2026 balance sheet.',
    [{ type: 'heading', level: 2, md: '## **Note 5. Subsequent events**' }, { type: 'text', md: 'On October 14, 2026 the Company drew $6.0 million.(3)' }, { type: 'text', md: '(3) The draw is not reflected in the September 30, 2026 balance sheet.' }],
  ),
];

const RESULT = { job: { status: 'COMPLETED' }, markdown: { pages: PAGES.map((entry) => entry.markdown) }, items: { pages: PAGES.map((entry) => entry.items) } };

function fakeFetch(body: unknown): typeof fetch {
  return (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith('/parse/upload')) return new Response(JSON.stringify({ id: 'job-1' }), { status: 200 });
    // One call asks for the items and the markdown together.
    expect(target).toContain('expand=items,markdown');
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const options = { env: { LLAMA_CLOUD_API_KEY: 'key' } as NodeJS.ProcessEnv, pollMs: 0 };

describe('the reading of a document', () => {
  it('keeps every page with its footnotes, and leaves out what runs along every page', () => {
    const reading = readingFromParse(RESULT);
    expect(reading.map((entry) => entry.page)).toEqual([1, 2, 3]);
    expect(reading[0].text).toContain('(1) Consolidated Adjusted EBITDA includes $3.5 million of run-rate cost savings');
    expect(reading[1].text).toContain('(2) The margin steps down to 5.00%');
    expect(reading[2].text).toContain('(3) The draw is not reflected');
    const all = reading.map((entry) => entry.text).join('\n');
    expect(all).not.toContain('Quarterly Package');
    expect(all).not.toMatch(/Page \d of 3/);
  });

  it('gives a table as rows of words, a heading without its bold marks, and no rule lines', () => {
    const [first, second] = readingFromParse(RESULT);
    expect(first.text).toContain('| Covenant | Certified value | Limit | Status |');
    expect(first.text).toContain('| Net Leverage Ratio | 2.76x | 3.25x | In compliance |');
    expect(first.text).not.toMatch(/<t[dh]>|<table/);
    expect(first.text).not.toMatch(/^-{3,}$/m);
    expect(second.text.split('\n')[0]).toBe('## Note 4. Debt');
    expect(tidyPageMarkdown('a\n\n***\n\nb')).toBe('a\n\nb');
  });

  it('keeps a footer that differs from page to page, which is a note and not page furniture', () => {
    const result = {
      markdown: {
        pages: [
          { page_number: 1, success: true, markdown: 'Revenue grew.*', footer: '* Excludes the divested unit.' },
          { page_number: 2, success: true, markdown: 'Debt fell.', footer: 'See Note 7 for the amendment.' },
          { page_number: 3, success: true, markdown: 'Cash rose.', footer: 'Unaudited.' },
        ],
      },
    };
    expect(readingFromParse(result).map((entry) => entry.text)).toEqual(['Revenue grew.*\n\n* Excludes the divested unit.', 'Debt fell.\n\nSee Note 7 for the amendment.', 'Cash rose.\n\nUnaudited.']);
  });

  it('puts a page together from its items when the reader gave it no markdown', () => {
    const result = { markdown: { pages: [{ page_number: 1, success: false, error: 'timeout' }] }, items: { pages: [PAGES[1].items] } };
    const [only] = readingFromParse({ ...result, items: { pages: [{ ...PAGES[1].items, page_number: 1 }] } });
    expect(only.text).toContain('## Note 4. Debt');
    expect(only.text).toContain('(2) The margin steps down');
    expect(only.text).not.toContain('Quarterly Package');
  });

  it('comes back with the tables from one call, and on its own for a file that is only read', async () => {
    const extracted = await extractTablesWithLlamaParse('package.pdf', 'application/pdf', Buffer.from('pdf'), { ...options, fetchImpl: fakeFetch(RESULT) });
    expect(extracted.tables).toHaveLength(1);
    expect(extracted.tables[0].rows[0]).toMatchObject({ Covenant: 'Net Leverage Ratio', 'Certified value': '2.76x' });
    expect(extracted.reading?.reader).toBe('llamaparse');
    expect(extracted.reading?.pages).toHaveLength(3);
    const read = await readWithLlamaParse('scan.pdf', null, new Uint8Array([1]), { ...options, fetchImpl: fakeFetch(RESULT) });
    expect(read?.pages[2].text).toContain('(3) The draw is not reflected');
    expect(await readWithLlamaParse('blank.pdf', null, new Uint8Array([1]), { ...options, fetchImpl: fakeFetch({ job: { status: 'COMPLETED' }, markdown: { pages: [] } }) })).toBeNull();
  });

  it('is read into blocks that keep their page, with headings as headings', () => {
    const document = readMarkdownPages(readingFromParse(RESULT), 'pdf');
    expect(document.format).toBe('pdf');
    expect(document.pageCount).toBe(3);
    const footnote = document.blocks.find((block) => block.text.startsWith('(2) The margin steps down'));
    expect(footnote?.page).toBe(2);
    const heading = document.blocks.find((block) => block.text === 'Note 4. Debt');
    expect(heading?.headingLevel).toBe(2);
    expect(heading?.page).toBe(2);
    // A footnote is its own block, not run into the paragraph above it or the heading of the next page.
    expect(document.blocks.find((block) => block.text.startsWith('(1) Consolidated Adjusted EBITDA'))?.page).toBe(1);
    expect(document.body).toContain('(3) The draw is not reflected in the September 30, 2026 balance sheet.');
  });
});

describe('keeping a reading', () => {
  function fakeStorage() {
    const files = new Map<string, string>();
    const bucket = {
      download: async (path: string) => (files.has(path) ? { data: new Blob([files.get(path) as string]), error: null } : { data: null, error: { message: 'not found' } }),
      upload: async (path: string, body: Blob) => {
        files.set(path, await body.text());
        return { error: null };
      },
    };
    return { files, client: { storage: { from: () => bucket } } as never };
  }

  it('reads a file once: the second time the kept reading is used', async () => {
    const { files, client } = fakeStorage();
    const bytes = new Uint8Array([1, 2, 3]);
    let calls = 0;
    const reader = async () => {
      calls += 1;
      return { reader: 'llamaparse', pages: [{ page: 1, text: 'Note 1. Basis of preparation.' }] };
    };
    const first = await outsideReading(client, 'client-1', { fileName: 'scan.pdf', mediaType: 'application/pdf', bytes }, reader);
    const second = await outsideReading(client, 'client-1', { fileName: 'scan.pdf', mediaType: 'application/pdf', bytes }, reader);
    expect(first?.pages[0].text).toBe('Note 1. Basis of preparation.');
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect([...files.keys()]).toEqual([readingPath('client-1', await sha256Hex(bytes))]);
    // Another client's reading of the same file is its own.
    expect(await outsideReading(client, 'client-2', { fileName: 'scan.pdf', mediaType: 'application/pdf', bytes }, null)).toBeNull();
  });

  it('keeps only pages that hold words, in order', () => {
    expect(cleanReading({ reader: 'llamaparse', pages: [{ page: 2, text: ' b ' }, { page: 1, text: 'a' }, { page: 3, text: '  ' }, { page: 0, text: 'x' }] })).toEqual({ reader: 'llamaparse', pages: [{ page: 1, text: 'a' }, { page: 2, text: 'b' }] });
    expect(cleanReading({ pages: [] })).toBeNull();
    expect(cleanReading(null)).toBeNull();
  });
});

describe('finding a passage in a file', () => {
  it('returns the paragraph that holds every word, and a footnote as its own passage', () => {
    const page = { page: 4, text: ['Adjusted EBITDA was $45.5 million.(1)', '', 'Revenue grew 12.6%.', '', '(1) Includes $3.5 million of run-rate cost savings.', '(2) Excludes restricted cash.'].join(String.fromCharCode(10)) };
    expect(passagesWith(page, ['cost', 'savings'])).toEqual(['(1) Includes $3.5 million of run-rate cost savings.']);
    expect(passagesWith(page, ['restricted'])).toEqual(['(2) Excludes restricted cash.']);
    expect(passagesWith(page, ['waiver'])).toEqual([]);
  });

  it('narrows a page with no blank lines to the lines around the words', () => {
    const lines = Array.from({ length: 120 }, (_, index) => `Line ${index + 1} of the statement of operations with some figures 1,234 5,678`);
    lines[80] = 'The income incentive fee is subject to a hurdle of 1.25% a quarter.';
    const [passage] = passagesWith({ page: 54, text: lines.join(String.fromCharCode(10)) }, ['incentive', 'hurdle']);
    expect(passage).toContain('hurdle of 1.25% a quarter');
    expect(passage).toContain('Line 78 ');
    expect(passage).not.toContain('Line 1 ');
    expect(passage.length).toBeLessThanOrEqual(1600);
  });
});

describe('what the standard loader takes', () => {
  it('reads a file by its kind', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    expect(fileKind('package.pdf', 'application/pdf', pdf)).toBe('pdf');
    expect(fileKind('scan.PNG', 'image/png', new Uint8Array())).toBe('picture');
    expect(fileKind('agreement.docx', '', new Uint8Array())).toBe('word');
    expect(fileKind('filing.htm', 'text/html', new Uint8Array())).toBe('html');
    expect(fileKind('notes.txt', 'text/plain', new Uint8Array())).toBe('text');
    // A delimited file is text, but it reads as a table.
    expect(fileKind('positions.csv', 'text/csv', new Uint8Array())).toBe('table');
    expect(fileKind('pack.xlsx', '', new Uint8Array())).toBe('table');
  });

  it('gives each file the media type its extension says', () => {
    expect(mediaTypeOf('pack.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(mediaTypeOf('certificate.PDF')).toBe('application/pdf');
    expect(mediaTypeOf('scan.jpeg')).toBe('image/jpeg');
    expect(mediaTypeOf('agreement.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mediaTypeOf('archive.zip')).toBeNull();
    expect(mediaTypeOf('no-extension')).toBeNull();
  });
});
