import { describe, expect, it } from 'vitest';
import { extractTablesWithLlamaParse, formatOf, isTableLikeLine, llamaParseConfigured, profilePdfPages, tablesFromParse } from './llama-parse';

const PAGE_TEXT = 'Net asset value statement for the quarter. '.repeat(20);

describe('profilePdfPages', () => {
  it('sends a scan to LlamaParse', () => {
    const profile = profilePdfPages(['', ' ', '']);
    expect(profile.route).toBe('llamaparse');
    expect(profile.reasons[0]).toMatch(/scans/);
  });

  it('keeps a short text PDF with few tables local', () => {
    const profile = profilePdfPages([PAGE_TEXT]);
    expect(profile.route).toBe('local');
  });

  it('sends a long PDF to LlamaParse', () => {
    const profile = profilePdfPages(Array.from({ length: 6 }, () => PAGE_TEXT));
    expect(profile.route).toBe('llamaparse');
    expect(profile.reasons.join(' ')).toMatch(/6 pages/);
  });

  it('sends a table-heavy PDF to LlamaParse', () => {
    const rows = Array.from({ length: 12 }, (_, index) => `Loan ${index}\t12,500,000\t425\t2030-06-30`).join('\n');
    const profile = profilePdfPages([`${PAGE_TEXT}\n${rows}`]);
    expect(profile.route).toBe('llamaparse');
    expect(profile.reasons.join(' ')).toMatch(/table rows/);
  });
});

describe('document format and table-like lines', () => {
  it('reads the format from the name', () => {
    expect(formatOf('a.PDF')).toBe('pdf');
    expect(formatOf('scan.jpeg')).toBe('image');
    expect(formatOf('memo.docx')).toBe('office');
    expect(formatOf('data.csv')).toBe('other');
  });

  it('spots rows of numbers', () => {
    expect(isTableLikeLine('Acme   Term Loan B   12,500,000   425')).toBe(true);
    expect(isTableLikeLine('Total 1,000 (2,000) 3.5%')).toBe(true);
    expect(isTableLikeLine('The fund invests in senior loans.')).toBe(false);
  });
});

describe('tablesFromParse', () => {
  const table = (rows: string[][]) => ({ type: 'table', rows });

  it('turns a table item into headers and rows', () => {
    const { tables, pages } = tablesFromParse({
      items: { pages: [{ page_number: 3, items: [{ type: 'text' }, table([['Issuer', 'Par'], ['Acme', '1,000'], ['Beta', '(500)']])] }] },
    });
    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(['Issuer', 'Par']);
    expect(tables[0].rows).toEqual([{ Issuer: 'Acme', Par: '1,000' }, { Issuer: 'Beta', Par: '(500)' }]);
    expect(pages).toEqual([3]);
  });

  it('joins a table that repeats its header on the next page', () => {
    const { tables } = tablesFromParse({
      items: {
        pages: [
          { page_number: 1, items: [table([['Issuer', 'Par'], ['Acme', '1']])] },
          { page_number: 2, items: [table([['Issuer', 'Par'], ['Beta', '2']])] },
        ],
      },
    });
    expect(tables).toHaveLength(1);
    expect(tables[0].rows.map((row) => row.Issuer)).toEqual(['Acme', 'Beta']);
  });

  it('names blank and repeated headers and skips one-row tables', () => {
    const { tables } = tablesFromParse({
      items: { pages: [{ items: [table([['', 'Amt', 'Amt'], ['x', '1', '2']]), table([['only', 'header']])] }] },
    });
    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(['Column 1', 'Amt', 'Amt (2)']);
  });
});

describe('extractTablesWithLlamaParse', () => {
  const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

  it('is unavailable without a key', async () => {
    expect(llamaParseConfigured({})).toBe(false);
    await expect(extractTablesWithLlamaParse('a.pdf', 'application/pdf', Buffer.from('x'), { env: {} })).rejects.toThrow(/not configured/);
  });

  it('uploads, polls, and returns the tables', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method || 'GET'} ${url}`);
      if (url.endsWith('/upload')) return json({ id: 'job-1', status: 'PENDING' });
      return calls.filter((call) => call.startsWith('GET')).length < 2
        ? json({ job: { status: 'RUNNING' } })
        : json({ job: { status: 'COMPLETED' }, items: { pages: [{ page_number: 1, items: [{ type: 'table', rows: [['A', 'B'], ['1', '2']] }] }] } });
    }) as unknown as typeof fetch;
    const result = await extractTablesWithLlamaParse('a.pdf', 'application/pdf', Buffer.from('x'), { env: { LLAMA_CLOUD_API_KEY: 'k' }, fetchImpl, pollMs: 1 });
    expect(result.tables).toHaveLength(1);
    expect(calls[0]).toBe('POST https://api.cloud.llamaindex.ai/api/v2/parse/upload');
    expect(calls[1]).toContain('/api/v2/parse/job-1?expand=items');
  });

  it('reports a failed job', async () => {
    const fetchImpl = (async (url: string) => (url.endsWith('/upload')
      ? json({ id: 'job-2' })
      : json({ job: { status: 'FAILED', error_message: 'bad scan' } }))) as unknown as typeof fetch;
    await expect(extractTablesWithLlamaParse('a.pdf', 'application/pdf', Buffer.from('x'), { env: { LLAMA_CLOUD_API_KEY: 'k' }, fetchImpl, pollMs: 1 })).rejects.toThrow('bad scan');
  });

  it('reports a rejected upload without leaking the key', async () => {
    const fetchImpl = (async () => json({ detail: 'nope' }, false, 401)) as unknown as typeof fetch;
    await expect(extractTablesWithLlamaParse('a.pdf', 'application/pdf', Buffer.from('x'), { env: { LLAMA_CLOUD_API_KEY: 'secret-key' }, fetchImpl, pollMs: 1 }))
      .rejects.toThrow(/rejected the file \(401\)/);
  });
});
