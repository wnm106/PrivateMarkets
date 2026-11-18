import { describe, expect, it } from 'vitest';
import { buildChunks, buildOutline } from './outline';
import { refineDocument } from './pipeline';
import { readPlainText } from './read';
import { cleanRefineResult, cleanTopics, defaultTopics, isThin, routeTexts, type Refiner } from './refine';
import type { TemplateSection } from './types';

describe('telling a thin passage from prose', () => {
  it('treats every table as thin', () => {
    expect(isThin('Lender | Commitment\nSilicon Valley Bank | $60,000,000.00', 'TABLE')).toBe(true);
  });

  it('finds signature blocks and lists of fields thin', () => {
    expect(isThin('SILICON VALLEY BANK\nBy: /s/ Lawrence Chao\nName: Lawrence Chao\nTitle: Vice President', 'CLAUSE')).toBe(true);
    expect(isThin('(1) Letter of Credit\nApplicant: Pubmatic, Inc.\nBeneficiary: Transfix, Inc.\nIssue Date: 3/23/2022\nAmount in USD: $533,816.00', 'CLAUSE')).toBe(true);
  });

  it('finds a signature block thin even when a sentence introduces it', () => {
    const block = 'IN WITNESS WHEREOF, the parties hereto have caused this Agreement to be duly executed and delivered by their proper and duly authorized officers as of the day and year first above written.\nPUBMATIC, INC.\nBy: /s/ Steven Pantelick\nName: Steven Pantelick\nTitle: Chief Financial Officer';
    expect(isThin(block, 'CLAUSE')).toBe(true);
  });

  it('leaves ordinary clauses and definitions alone', () => {
    expect(isThin('(a) Consolidated Interest Coverage Ratio. Permit the Consolidated Interest Coverage Ratio as at the last day of any Fiscal Quarter to be less than 3.00:1.00.', 'CLAUSE')).toBe(false);
    expect(isThin('\u201CAgreement\u201D: as defined in the preamble hereto, as the same may be amended from time to time.', 'DEFINITION')).toBe(false);
  });

  it('does not bother with a scrap', () => {
    expect(isThin('Schedule 1.1A', 'CLAUSE')).toBe(false);
  });

  it('marks chunks as they are cut', () => {
    const document = readPlainText([
      '7.1 Covenants. The Borrower shall not permit the ratio to exceed the level that is set out in this Section.',
      '',
      'IN WITNESS WHEREOF, the parties hereto have caused this Agreement to be duly executed.',
      '',
      'PUBMATIC, INC.',
      'By: /s/ Steven Pantelick',
      'Name: Steven Pantelick',
      'Title: Chief Financial Officer',
    ].join('\n'));
    const chunks = buildChunks(document, buildOutline(document), { minChars: 10, maxChars: 120 });
    const thin = chunks.filter((chunk) => chunk.thin).map((chunk) => document.body.slice(chunk.charStart, chunk.charEnd));
    expect(thin).toHaveLength(1);
    expect(thin[0]).toContain('Steven Pantelick');
  });
});

describe('topics', () => {
  it('starts a credit agreement with lenders, pricing and the rest, and other types with a shorter list', () => {
    const codes = defaultTopics('CREDIT_AGREEMENT').map((topic) => topic.code);
    expect(codes).toEqual(expect.arrayContaining(['LENDERS', 'PRICING', 'FINANCIAL_COVENANTS', 'SIGNATURES']));
    expect(defaultTopics('SIDE_LETTER').map((topic) => topic.code)).toContain('PARTIES');
    expect(defaultTopics(null).length).toBeLessThan(codes.length);
  });

  it('gives a topic typed by a person a code, and drops blanks and repeats', () => {
    expect(cleanTopics([
      { code: '', title: 'Lender club', description: ' Who is in the club. ' },
      { title: 'Lender Club' },
      { code: 'FEES', title: '' },
      'nonsense',
    ])).toEqual([{ code: 'LENDER_CLUB', title: 'Lender club', description: 'Who is in the club.' }]);
  });

  it('keeps a model\u2019s answer to one short description and topics the template has', () => {
    const topics = cleanTopics([{ code: 'LENDERS', title: 'Lenders' }, { code: 'FEES', title: 'Fees' }]);
    expect(cleanRefineResult({ id: 'a', summary: `  Each lender\u2019s\ncommitment.  ${'x'.repeat(600)}`, topics: ['lenders', 'MADE_UP', 'LENDERS'] }, topics)).toEqual({
      id: 'a',
      summary: expect.stringMatching(/^Each lender\u2019s commitment\. x+$/),
      topics: ['LENDERS'],
    });
    expect(cleanRefineResult({ id: 'a', summary: 'x'.repeat(600), topics: [] }, topics).summary).toHaveLength(400);
  });

  it('embeds a topic as its name and what it covers, and only top sections', () => {
    const sections: TemplateSection[] = [
      { code: 'NEGATIVE_COVENANTS', title: 'Negative Covenants', parentCode: null, aliases: ['Restrictive Covenants'], tags: [], guidance: '', required: false, order: 1, seenIn: 1 },
      { code: 'LIENS', title: 'Liens', parentCode: 'NEGATIVE_COVENANTS', aliases: [], tags: [], guidance: '', required: false, order: 2, seenIn: 1 },
    ];
    expect(routeTexts([{ code: 'LENDERS', title: 'Lenders', description: 'Who the lenders are.' }], sections)).toEqual([
      { kind: 'TOPIC', code: 'LENDERS', text: 'Lenders. Who the lenders are.' },
      { kind: 'SECTION', code: 'NEGATIVE_COVENANTS', text: 'Negative Covenants. Restrictive Covenants' },
    ]);
  });
});

describe('refining a document', () => {
  // A stand-in for the two database functions the step uses.
  function fakeStore(chunks: Array<{ id: string; text: string }>) {
    const saved: Array<{ id: string; summary: string; topics: string[] }> = [];
    const rpc = async (fn: string, args: Record<string, any>) => {
      if (fn === 'document_chunks_to_refine') {
        const waiting = chunks.filter((chunk) => !saved.some((row) => row.id === chunk.id));
        return {
          data: {
            title: 'Credit Agreement', type_name: 'Credit agreement',
            topics: [{ code: 'LENDERS', title: 'Lenders', description: '' }],
            waiting: waiting.length,
            chunks: waiting.map((chunk, index) => ({ ...chunk, seq: index + 1, kind: 'TABLE', path: 'SCHEDULE 1.1A', before: null })),
          },
          error: null,
        };
      }
      if (fn === 'document_chunks_refined') {
        saved.push(...args.p_rows);
        return { data: args.p_rows.length, error: null };
      }
      throw new Error(`unexpected ${fn}`);
    };
    return { supabase: { rpc } as any, saved };
  }

  it('saves what the model wrote and stops when nothing is left', async () => {
    const { supabase, saved } = fakeStore([{ id: 'a', text: 'Lender | Commitment' }, { id: 'b', text: 'By: /s/ X' }]);
    const refiner: Refiner = async (requests, context) => {
      expect(context.topics.map((topic) => topic.code)).toEqual(['LENDERS']);
      return requests.map((request) => ({ id: request.id, summary: `About ${request.id}`, topics: ['LENDERS', 'UNKNOWN'] }));
    };
    expect(await refineDocument(supabase, 'doc', refiner)).toEqual({ refined: 2, left: 0 });
    expect(saved).toEqual([
      { id: 'a', summary: 'About a', topics: ['LENDERS'] },
      { id: 'b', summary: 'About b', topics: ['LENDERS'] },
    ]);
  });

  it('asks about a passage once, and reports what the model could not describe', async () => {
    const { supabase, saved } = fakeStore([{ id: 'a', text: 'Lender | Commitment' }, { id: 'b', text: 'By: /s/ X' }]);
    let calls = 0;
    const refiner: Refiner = async (requests) => {
      calls += 1;
      return requests.filter((request) => request.id === 'a').map((request) => ({ id: request.id, summary: 'Commitments by lender.', topics: [] }));
    };
    expect(await refineDocument(supabase, 'doc', refiner)).toEqual({ refined: 1, left: 1 });
    expect(calls).toBe(1);
    expect(saved.map((row) => row.id)).toEqual(['a']);
  });
});
