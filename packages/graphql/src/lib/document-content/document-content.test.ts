import { describe, expect, it } from 'vitest';
import { batchesOf, embedBatch, embedConfigFromEnv, embedPatiently, EmbedRateLimited, EMBEDDING_DIMENSIONS, type EmbedConfig } from './embed';
import { buildChunks, buildOutline, guessTitle } from './outline';
import { decodeBytes, formatOfFile, readHtml, readPdfPages, readPlainText } from './read';
import { cleanTemplateSections, extendTemplate, generateTemplate, headingKey, headingLabel, labelsToEmbed, matchSections } from './template';

const BOLD = 'font-weight:700';
const PLAIN = 'font-weight:400';
const span = (style: string, text: string) => `<font style="${style}">${text}</font>`;
const para = (inner: string) => `<div style="margin-bottom:12pt">${inner}</div>`;
const tocRow = (label: string, page: number) => `<tr><td><div>${span(PLAIN, label)}</div></td><td>${span(PLAIN, String(page))}</td></tr>`;

const TOC = [
  'SECTION 1 DEFINITIONS', '1.1 Defined Terms', '1.2 Rounding', 'SECTION 2 THE LOANS', '2.1 Commitments', '2.2 [Reserved]',
  '2.3 Fees', 'SECTION 7 NEGATIVE COVENANTS', '7.1 Financial Condition Covenants', '7.2 Indebtedness',
];

const AGREEMENT = [
  '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>Document</title></head><body>',
  para(span(BOLD, 'SENIOR SECURED CREDIT FACILITIES')),
  para(span(BOLD, 'CREDIT AGREEMENT')),
  para(span(PLAIN, 'dated as of October 17, 2022')),
  para(span(BOLD, 'Table of Contents')),
  `<table>${TOC.map((label, index) => tocRow(label, index + 1)).join('')}</table>`,
  para(span(PLAIN, 'THIS CREDIT AGREEMENT is entered into by Borrower Co. and the Lenders.')),
  para(span(BOLD, 'SECTION 1<br>DEFINITIONS')),
  para(span(BOLD, '1.1&nbsp;&nbsp;&nbsp;Defined Terms') + span(PLAIN, '.  As used in this Agreement, the following terms have these meanings.')),
  para(span(PLAIN, '&#8220;') + span(BOLD, 'Applicable Margin') + span(PLAIN, '&#8221;: the rate set out in the grid below, by Level.')),
  `<table><tr><td>Level</td><td>SOFR Loans</td></tr><tr><td>I</td><td>2.75%</td></tr></table>`,
  para(span(PLAIN, '&#8220;') + span(BOLD, 'Borrower') + span(PLAIN, '&#8221;: as defined in the preamble hereto.')),
  para(span(BOLD, '1.2&nbsp;&nbsp;&nbsp;Rounding') + span(PLAIN, '.  Any ratio is calculated by dividing and rounding to the nearest number, with a long explanation that carries on to the bottom of the page and does not finish its sentence until the following page begins, so that the two halves must be')),
  '<div><div>' + span(PLAIN, '13') + '</div></div><hr style="page-break-after:always">',
  para(span(PLAIN, 'joined again when the document is read.')),
  para(span(BOLD, 'SECTION 2<br>THE LOANS')),
  para(span(BOLD, '2.1&nbsp;&nbsp;&nbsp;Commitments') + span(PLAIN, '.  Each Lender agrees to make loans to the Borrower.')),
  para(span(BOLD, '2.2&nbsp;&nbsp;&nbsp;[Reserved]') + span(PLAIN, '.')),
  para(span(BOLD, '2.3&nbsp;&nbsp;&nbsp;Fees') + span(PLAIN, '.  The Borrower shall pay the fees.')),
  para(span(BOLD, 'SECTION 7<br>NEGATIVE COVENANTS')),
  para(span(BOLD, '7.1&nbsp;&nbsp;&nbsp;Financial Condition Covenants.')),
  para(span(PLAIN, '(a)&nbsp;&nbsp;Consolidated Interest Coverage Ratio.  Permit the ratio to be less than 3.00:1.00.')),
  para(span(PLAIN, '(b)&nbsp;&nbsp;Consolidated Leverage Ratio.  Permit the ratio to exceed 3.50:1.00, in the amount of 2.5 times EBITDA.')),
  para(span(BOLD, '7.2&nbsp;&nbsp;&nbsp;Indebtedness') + span(PLAIN, '.  Create or incur any Indebtedness, except as permitted under Section 2.1 hereof.')),
  para(span(PLAIN, 'IN WITNESS WHEREOF, the parties have signed.')),
  '</body></html>',
].join('\n');

describe('reading a file', () => {
  it('keeps bold, the bold opening of a run-in heading, and table rows', () => {
    const document = readHtml(AGREEMENT);
    const heading = document.blocks.find((block) => block.table === null && block.text.startsWith('7.2 Indebtedness'))!;
    expect(heading.bold).toBe(false);
    expect(heading.text.slice(0, heading.lead)).toBe('7.2 Indebtedness');
    expect(document.blocks.find((block) => block.text === '7.1 Financial Condition Covenants.')!.bold).toBe(true);
    expect(document.blocks.some((block) => block.text === 'Level | SOFR Loans' && block.table !== null)).toBe(true);
    // The generic title of a saved filing is not a title.
    expect(document.title).toBeNull();
  });

  it('gives every block the offsets of its own text', () => {
    const document = readHtml(AGREEMENT);
    for (const block of document.blocks) expect(document.body.slice(block.start, block.end)).toBe(block.text);
  });

  it('drops the page number at a page break and joins the paragraph it cut', () => {
    const document = readHtml(AGREEMENT);
    expect(document.pageCount).toBe(2);
    expect(document.blocks.some((block) => block.text === '13')).toBe(false);
    const joined = document.blocks.find((block) => block.table === null && block.text.startsWith('1.2 Rounding'))!;
    expect(joined.text.endsWith('must be joined again when the document is read.')).toBe(true);
    expect(joined.page).toBe(1);
    expect(document.blocks.find((block) => block.table === null && block.text.startsWith('2.1 Commitments'))!.page).toBe(2);
  });

  it('reads Windows-1252 quotes as quotes, whatever the runtime does with that label', () => {
    const bytes = new Uint8Array([...Buffer.from('<meta charset="windows-1252"><p>'), 0x93, 0x41, 0x94, 0x97, 0x92, ...Buffer.from('</p>')]);
    expect(readHtml(decodeBytes(bytes)).body).toBe('\u201CA\u201D\u2014\u2019');
  });

  it('replaces characters outside the basic plane so offsets match Postgres', () => {
    const document = readPlainText('Clause one \u{1F600} ends.\n\nClause two.');
    expect(document.body).toBe('Clause one \uFFFD ends.\nClause two.');
    expect([...document.body].length).toBe(document.body.length);
  });

  it('tells formats apart and joins a PDF paragraph that runs over a page', () => {
    expect(formatOfFile('a.PDF', null, new Uint8Array())).toBe('pdf');
    expect(formatOfFile('a.htm', null, new Uint8Array())).toBe('html');
    expect(formatOfFile('a.docx', 'application/msword', new Uint8Array())).toBeNull();
    const document = readPdfPages(['7.1 Covenants. The Borrower shall not permit the ratio\nto exceed the level that is', 'set out below.\n(a) First clause.']);
    expect(document.blocks.map((block) => block.text)).toEqual([
      '7.1 Covenants. The Borrower shall not permit the ratio to exceed the level that is set out below.',
      '(a) First clause.',
    ]);
    expect(document.blocks[1].page).toBe(2);
  });
});

describe('finding headings', () => {
  const document = readHtml(AGREEMENT);
  const outline = buildOutline(document);

  it('finds the headings of the body and leaves out the table of contents', () => {
    expect(outline.sections.map((section) => section.heading)).toEqual([
      'SECTION 1 DEFINITIONS', '1.1 Defined Terms', '1.2 Rounding',
      'SECTION 2 THE LOANS', '2.1 Commitments', '2.2 [Reserved]', '2.3 Fees',
      'SECTION 7 NEGATIVE COVENANTS', '7.1 Financial Condition Covenants', '7.2 Indebtedness',
      'Signatures',
    ]);
    const firstBody = document.blocks.find((block) => block.text.startsWith('THIS CREDIT AGREEMENT'))!;
    expect(outline.sections[0].charStart).toBeGreaterThan(firstBody.start);
  });

  it('nests numbered headings under their top heading and bounds each by the next', () => {
    const top = outline.sections.find((section) => section.number === 'SECTION 7')!;
    const child = outline.sections.find((section) => section.number === '7.1')!;
    const next = outline.sections.find((section) => section.number === '7.2')!;
    expect(child.parentSeq).toBe(top.seq);
    expect(child.level).toBe(2);
    expect(child.charEnd).toBe(next.charStart);
  });

  it('does not take a sentence that mentions a number for a heading', () => {
    expect(outline.sections.some((section) => section.number === '2.5')).toBe(false);
  });

  it('guesses a title from the capital lines at the head', () => {
    expect(guessTitle(document, outline)).toBe('Senior Secured Credit Facilities Credit Agreement');
  });

  it('uses heading marks where a file has them', () => {
    const marked = readPlainText('# Fund Terms\n\nIntro text.\n\n## Management Fee\n\nThe fee is 2%.\n\n## Carried Interest\n\nCarry is 20%.', true);
    const sections = buildOutline(marked).sections;
    expect(sections.map((section) => `${section.level}:${section.heading}`)).toEqual(['1:Fund Terms', '2:Management Fee', '2:Carried Interest']);
  });
});

describe('cutting chunks', () => {
  const document = readHtml(AGREEMENT);
  const outline = buildOutline(document);
  const chunks = buildChunks(document, outline, { maxChars: 400, minChars: 60 });
  const textOf = (chunk: { charStart: number; charEnd: number }) => document.body.slice(chunk.charStart, chunk.charEnd);

  it('never overlaps and never crosses a heading', () => {
    for (let i = 1; i < chunks.length; i += 1) expect(chunks[i].charStart).toBeGreaterThanOrEqual(chunks[i - 1].charEnd);
    for (const chunk of chunks) {
      const section = outline.sections.find((candidate) => candidate.seq === chunk.sectionSeq);
      if (!section) continue;
      expect(chunk.charStart).toBeGreaterThanOrEqual(section.charStart);
      expect(chunk.charEnd).toBeLessThanOrEqual(section.charEnd);
    }
  });

  it('makes each defined term its own chunk, tagged with the term', () => {
    const margin = chunks.find((chunk) => chunk.tags.includes('term:applicable margin'))!;
    expect(margin.kind).toBe('DEFINITION');
    expect(textOf(margin)).toContain('the rate set out in the grid below');
    const borrower = chunks.find((chunk) => chunk.tags.includes('term:borrower'))!;
    expect(textOf(borrower).startsWith('\u201CBorrower\u201D')).toBe(true);
  });

  it('keeps a table together and records where each chunk sits', () => {
    const table = chunks.find((chunk) => chunk.kind === 'TABLE')!;
    expect(textOf(table)).toBe('Level | SOFR Loans\nI | 2.75%');
    const covenant = chunks.find((chunk) => textOf(chunk).startsWith('(a) Consolidated Interest Coverage'))!;
    expect(covenant.locator).toMatchObject({
      sectionNumber: '7.1',
      clause: '(a)',
      page: 2,
      path: ['SECTION 7 NEGATIVE COVENANTS', '7.1 Financial Condition Covenants'],
    });
    expect(AGREEMENT.slice(covenant.locator.sourceStart!, covenant.locator.sourceEnd!)).toContain('Consolidated Interest Coverage Ratio');
  });

  it('leaves the contents and bare headings out, and keeps the front matter', () => {
    const all = chunks.map(textOf).join('\n');
    expect(all).not.toContain('7.1 Financial Condition Covenants.');
    expect(all).not.toContain('Table of Contents');
    expect(chunks[0].kind).toBe('FRONT');
    expect(all).toContain('THIS CREDIT AGREEMENT is entered into');
  });

  it('splits a paragraph longer than the limit at a sentence end', () => {
    const long = readPlainText(`7.1 Covenants. ${'The Borrower shall not do the thing. '.repeat(60)}`);
    const pieces = buildChunks(long, buildOutline(long), { maxChars: 500 });
    expect(pieces.length).toBeGreaterThan(3);
    for (const piece of pieces) expect(piece.charEnd - piece.charStart).toBeLessThanOrEqual(500);
    expect(long.body.slice(pieces[0].charStart, pieces[0].charEnd).endsWith('.')).toBe(true);
  });
});

describe('templates', () => {
  const first = {
    documentId: 'a',
    sections: [
      { seq: 1, parentSeq: null, level: 1, heading: 'SECTION 1 DEFINITIONS' },
      { seq: 2, parentSeq: 1, level: 2, heading: '1.1 Defined Terms' },
      { seq: 3, parentSeq: null, level: 1, heading: 'SECTION 7 NEGATIVE COVENANTS' },
      { seq: 4, parentSeq: 3, level: 2, heading: '7.1 Financial Condition Covenants' },
      { seq: 5, parentSeq: 3, level: 2, heading: '7.2 Indebtedness' },
      { seq: 6, parentSeq: 3, level: 2, heading: '7.7 [Reserved]' },
    ],
  };
  const second = {
    documentId: 'b',
    sections: [
      { seq: 1, parentSeq: null, level: 1, heading: 'ARTICLE I Definitions' },
      { seq: 2, parentSeq: 1, level: 2, heading: '1.01 Defined Terms' },
      { seq: 3, parentSeq: null, level: 1, heading: 'ARTICLE VI Negative Covenants' },
      { seq: 4, parentSeq: 3, level: 2, heading: '6.12 Financial Covenants' },
      { seq: 5, parentSeq: 3, level: 2, heading: '6.01 Liens' },
    ],
  };

  it('compares headings by their words, not their numbers', () => {
    expect(headingLabel('SECTION 7 NEGATIVE COVENANTS')).toBe('NEGATIVE COVENANTS');
    expect(headingKey('ARTICLE VI Negative Covenants')).toBe(headingKey('SECTION 7 NEGATIVE COVENANTS'));
    expect(headingKey('7.3 Liens')).toBe('lien');
  });

  it('draws one template from several documents', () => {
    const template = generateTemplate([first, second]);
    const byCode = new Map(template.map((section) => [section.code, section]));
    expect(byCode.get('NEGATIVE_COVENANTS')).toMatchObject({ title: 'Negative Covenants', parentCode: null, seenIn: 2, required: true });
    // Worded differently in the second document: one section, with the other wording as an alias.
    expect(byCode.get('FINANCIAL_CONDITION_COVENANTS')).toMatchObject({ parentCode: 'NEGATIVE_COVENANTS', seenIn: 2, aliases: ['Financial Covenants'] });
    expect(byCode.get('INDEBTEDNESS')).toMatchObject({ seenIn: 1, required: false });
    expect(byCode.get('LIENS')).toMatchObject({ parentCode: 'NEGATIVE_COVENANTS', seenIn: 1 });
    expect(template.some((section) => /reserved/i.test(section.title))).toBe(false);
    // Children follow their parent.
    const codes = template.map((section) => section.code);
    expect(codes.indexOf('DEFINED_TERMS')).toBe(codes.indexOf('DEFINITIONS') + 1);
  });

  it('adds to a refined template without undoing what a person set', () => {
    const refined = generateTemplate([first]).map((section) =>
      section.code === 'INDEBTEDNESS' ? { ...section, title: 'Debt', tags: ['debt'], guidance: 'What may be borrowed.' } : section);
    const extended = extendTemplate(refined, [second]);
    expect(extended.find((section) => section.code === 'INDEBTEDNESS')).toMatchObject({ title: 'Debt', tags: ['debt'], guidance: 'What may be borrowed.' });
    expect(extended.find((section) => section.code === 'LIENS')).toBeTruthy();
    expect(extended.filter((section) => section.code === 'NEGATIVE_COVENANTS')).toHaveLength(1);
  });

  it('places headings by exact words, alias, and likeness', () => {
    const template = generateTemplate([first]);
    template.find((section) => section.code === 'INDEBTEDNESS')!.aliases.push('Limitation on Debt');
    const matches = matchSections([
      { seq: 1, parentSeq: null, level: 1, heading: 'ARTICLE VI NEGATIVE COVENANTS' },
      { seq: 2, parentSeq: 1, level: 2, heading: '6.01 Limitation on Debt' },
      { seq: 3, parentSeq: 1, level: 2, heading: '6.02 Financial Covenants' },
      { seq: 4, parentSeq: 1, level: 2, heading: '6.03 Sale and Leaseback' },
      { seq: 5, parentSeq: 1, level: 2, heading: '6.04 [Reserved]' },
    ], template);
    expect(matches).toEqual([
      { seq: 1, code: 'NEGATIVE_COVENANTS', method: 'EXACT', score: 1 },
      { seq: 2, code: 'INDEBTEDNESS', method: 'ALIAS', score: 1 },
      { seq: 3, code: 'FINANCIAL_CONDITION_COVENANTS', method: 'SIMILAR', score: 0.6667 },
    ]);
  });

  it('places a heading by meaning when its words do not match', () => {
    const template = generateTemplate([first]);
    const sections = [
      { seq: 1, parentSeq: null, level: 1, heading: 'ARTICLE VI NEGATIVE COVENANTS' },
      { seq: 2, parentSeq: 1, level: 2, heading: '6.01 Borrowings' },
    ];
    const labels = labelsToEmbed(sections, template);
    expect(labels).toContain('Borrowings');
    expect(labels).toContain('Indebtedness');
    const vectors = new Map(labels.map((label) => [label, label === 'Borrowings' || label === 'Indebtedness' ? [1, 0.1] : [0, 1]]));
    const match = matchSections(sections, template, { vectors }).find((candidate) => candidate.seq === 2)!;
    expect(match).toMatchObject({ code: 'INDEBTEDNESS', method: 'EMBEDDING' });
  });

  it('cleans stored sections: two levels, unique codes, lower-case tags', () => {
    const cleaned = cleanTemplateSections([
      { code: 'A', title: 'Top', tags: ['Fees '], order: 1 },
      { code: 'B', title: 'Child', parentCode: 'A', order: 2 },
      { code: 'C', title: 'Grandchild', parentCode: 'B', order: 3 },
      { code: 'A', title: 'Duplicate', order: 4 },
      { title: '' },
    ]);
    expect(cleaned.map((section) => `${section.code}<${section.parentCode}`)).toEqual(['A<null', 'B<A', 'C<null']);
    expect(cleaned[0].tags).toEqual(['fees']);
  });
});

describe('embedding', () => {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5);
  const config = (fetchImpl: typeof fetch, key = 'key-a'): EmbedConfig => ({ apiKey: key, model: 'voyage-4', baseUrls: ['https://one.test/v1', 'https://two.test/v1'], fetch: fetchImpl });
  const ok = (count: number) => new Response(JSON.stringify({ data: Array.from({ length: count }, (_, index) => ({ index, embedding: vector })) }), { status: 200 });

  it('is off without a key and defaults to voyage-4', () => {
    expect(embedConfigFromEnv({})).toBeNull();
    expect(embedConfigFromEnv({ VOYAGE_API_KEY: ' k ' })).toMatchObject({ apiKey: 'k', model: 'voyage-4' });
    expect(embedConfigFromEnv({ VOYAGE_API_KEY: 'k', VOYAGE_API_BASE: 'https://x.test/v1/' })!.baseUrls).toEqual(['https://x.test/v1']);
  });

  it('keeps requests small enough for a limited account', () => {
    const batches = batchesOf(Array.from({ length: 10 }, () => ({ text: 'x'.repeat(10000) })));
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 2, 2, 2]);
  });

  it('tries the second address when the first refuses the key, and remembers it', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(url);
      if (url.startsWith('https://one.test')) return new Response('no', { status: 401 });
      expect(JSON.parse(String(init.body))).toMatchObject({ model: 'voyage-4', input_type: 'query', output_dimension: 1024 });
      return ok(1);
    }) as unknown as typeof fetch;
    expect((await embedBatch(['q'], 'query', config(fetchImpl, 'key-b')))[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    await embedBatch(['q'], 'query', config(fetchImpl, 'key-b'));
    expect(seen).toEqual(['https://one.test/v1/embeddings', 'https://two.test/v1/embeddings', 'https://two.test/v1/embeddings']);
  });

  it('waits out a rate limit, and gives up when the budget is spent', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 3 ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }) : ok(1);
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    let clock = 0;
    const pacing = { sleep: async (ms: number) => { waits.push(ms); clock += ms; }, now: () => clock, budgetMs: 10000 };
    await embedPatiently(['a'], 'document', config(fetchImpl, 'key-c'), pacing);
    expect(waits).toEqual([2000, 2000]);

    const always = (async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch;
    await expect(embedPatiently(['a'], 'document', config(always, 'key-d'), { ...pacing, budgetMs: 30000 })).rejects.toBeInstanceOf(EmbedRateLimited);
  });
});
