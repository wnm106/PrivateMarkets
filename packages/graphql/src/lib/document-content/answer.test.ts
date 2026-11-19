import { describe, expect, it } from 'vitest';
import { answerDocuments, type AnswerModel, type AnswerToolCall, type AnswerTurn } from './answer';

const DOC = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const SEC = '22222222-2222-4222-8222-222222222222';

function hit(text = 'The Borrower shall not permit leverage above 4.00 to 1.00.') {
  return {
    chunk_id: 'hit-1', document_id: DOC, document_title: 'Credit Agreement', type_code: 'CREDIT_AGREEMENT', type_name: 'Credit agreement',
    section_id: SEC, section_heading: 'Financial Covenants', parent_heading: 'Covenants', kind: 'CLAUSE', text,
    char_start: 80, char_end: 140, locator: { page: 41, clause: '(a)' }, tags: [], score: 0.02, similarity: 0.5,
    meaning_rank: 1, word_rank: 1, entities: [],
  };
}

function store(options: { search?: (query: string) => Array<Record<string, unknown>> } = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const search = options.search || (() => [hit()]);
  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'document_search') return { data: search(String(args.p_query || '')).slice(0, Number(args.p_limit) || 8), error: null };
      if (fn === 'document_get') {
        if (args.p_id !== DOC) return { data: null, error: null };
        return {
          data: {
            id: DOC, title: 'Credit Agreement', type_code: 'CREDIT_AGREEMENT',
            entities: [{ entity_id: 'ent' }],
            sections: [
              { id: 'parent', seq: 1, parent_seq: null, heading: 'Covenants' },
              { id: SEC, seq: 2, parent_seq: 1, heading: 'Financial Covenants' },
            ],
          },
          error: null,
        };
      }
      if (fn === 'document_chunks_list') {
        return {
          data: [{
            id: 'chunk-1', text: 'The full covenant: the Borrower shall not permit leverage above 4.00 to 1.00.',
            char_start: 80, char_end: 200, locator: { page: 41, clause: '(a)' }, summary: null,
          }],
          error: null,
        };
      }
      return { data: null, error: { message: `unexpected ${fn}` } };
    },
  } as any;
  return { supabase, calls };
}

function script(turns: Array<Partial<AnswerTurn> & { calls?: AnswerToolCall[] }>): AnswerModel & { required: boolean[] } {
  const required: boolean[] = [];
  let round = 0;
  return {
    required,
    userMessage: (text) => ({ role: 'user', content: text }),
    resultMessage: (results) => ({ role: 'user', content: results }),
    async turn(_system, _tools, _messages, requireAnswer) {
      required.push(requireAnswer);
      const next = turns[round] || { text: '', calls: [] };
      round += 1;
      return { message: { role: 'assistant' }, text: next.text || '', calls: next.calls || [] };
    },
  };
}

describe('answering a question about documents', () => {
  it('writes a summary and returns the section it used, in the document\'s words', async () => {
    const { supabase, calls } = store();
    const model = script([
      { calls: [{ id: '1', name: 'read_section', input: { documentId: DOC, sectionId: SEC } }] },
      { calls: [{ id: '2', name: 'answer', input: { summary: 'Leverage may not exceed 4.00 to 1.00.', sections: [{ documentId: DOC, sectionId: SEC }] } }] },
    ]);
    const result = await answerDocuments(supabase, 'what is the leverage covenant', { documentIds: [DOC] }, null, model);

    expect(result.summary).toBe('Leverage may not exceed 4.00 to 1.00.');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toMatchObject({
      documentId: DOC,
      documentTitle: 'Credit Agreement',
      heading: 'Financial Covenants',
      parentHeading: 'Covenants',
    });
    expect(result.sections[0].passages[0].text).toContain('The full covenant');
    expect(result.sections[0].passages[0].page).toBe(41);
    expect(calls.filter((call) => call.fn === 'document_search').every((call) => call.args.p_document_ids)).toBe(true);
    expect(calls.some((call) => call.fn === 'document_chunks_list' && call.args.p_section_id === SEC)).toBe(true);
  });

  it('will search again when the first pass finds nothing', async () => {
    const { supabase } = store({ search: (query) => (query.includes('covenant') ? [hit()] : []) });
    const model = script([
      { calls: [{ id: '1', name: 'search_passages', input: { query: 'financial covenant leverage' } }] },
      { calls: [{ id: '2', name: 'answer', input: { summary: 'Leverage is capped.', sections: [{ documentId: DOC, sectionId: SEC }] } }] },
    ]);
    const result = await answerDocuments(supabase, 'how much debt can they have', { documentIds: [DOC] }, null, model);
    expect(result.summary).toBe('Leverage is capped.');
    expect(result.sections[0].heading).toBe('Financial Covenants');
  });

  it('drops a section outside the question and keeps the one it could read', async () => {
    const { supabase, calls } = store();
    const model = script([
      { calls: [{ id: '1', name: 'read_section', input: { documentId: OTHER, sectionId: SEC } }] },
      {
        calls: [{
          id: '2', name: 'answer',
          input: { summary: 'See the covenant.', sections: [{ documentId: OTHER, sectionId: SEC }, { documentId: DOC, sectionId: SEC }] },
        }],
      },
    ]);
    const result = await answerDocuments(supabase, 'leverage', { documentIds: [DOC] }, null, model);
    expect(result.sections.map((section) => section.documentId)).toEqual([DOC]);
    expect(calls.some((call) => call.fn === 'document_get' && call.args.p_id === OTHER)).toBe(false);
  });

  it('keeps the summary and shows the passages found when every cited section is missing', async () => {
    const { supabase } = store();
    const model = script([
      { calls: [{ id: '1', name: 'answer', input: { summary: 'It does not say.', sections: [{ documentId: OTHER, sectionId: SEC }] } }] },
    ]);
    const result = await answerDocuments(supabase, 'leverage', { documentIds: [DOC] }, null, model);
    expect(result.summary).toBe('It does not say.');
    expect(result.note).toMatch(/could not be read/);
    expect(result.sections[0].documentId).toBe(DOC);
    expect(result.sections[0].passages[0].text).toMatch(/Borrower shall not/);
  });

  it('shows the passages it found when no model key is set', async () => {
    const { supabase, calls } = store();
    const result = await answerDocuments(supabase, 'leverage', { documentIds: [DOC] }, null, null);
    expect(result.summary).toBeNull();
    expect(result.note).toMatch(/no model key/);
    expect(result.sections[0].heading).toBe('Financial Covenants');
    expect(calls.map((call) => call.fn)).toEqual(['document_search']);
  });

  it('shows those passages when the model cannot be reached', async () => {
    const { supabase } = store();
    const model = script([]);
    model.turn = async () => { throw new Error('The model could not be reached.'); };
    const result = await answerDocuments(supabase, 'leverage', {}, null, model);
    expect(result.summary).toBeNull();
    expect(result.note).toMatch(/without a summary/);
    expect(result.sections).toHaveLength(1);
  });

  it('asks for the summary on the last round', async () => {
    const { supabase } = store();
    const model = script([
      { calls: [{ id: '1', name: 'search_passages', input: { query: 'leverage again' } }] },
      { calls: [{ id: '2', name: 'search_passages', input: { query: 'once more' } }] },
      { text: 'Leverage is limited.' },
    ]);
    const result = await answerDocuments(supabase, 'leverage', {}, null, model);
    expect(model.required).toEqual([false, false, true]);
    expect(result.summary).toBe('Leverage is limited.');
  });

  it('does nothing with a blank question', async () => {
    const { supabase, calls } = store();
    const result = await answerDocuments(supabase, '   ', {}, null, null);
    expect(result).toEqual({ summary: null, note: null, sections: [] });
    expect(calls).toHaveLength(0);
  });
});
