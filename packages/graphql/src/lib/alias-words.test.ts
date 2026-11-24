import { describe, expect, it } from 'vitest';
import {
  aliasLabelsByAttribute,
  classifyHeader,
  loadAliasWords,
  parseAliasWords,
  NO_ALIAS_WORDS,
} from './semantic-aliases';

const ANSWER = {
  client_id: 'c1',
  labels: { ISSUER: 'Borrower' },
  types: [
    { domain_code: 'ISSUER', alias_label: 'Borrower', alias_code: 'BORROWER', client: true },
    { domain_code: 'ISSUER', alias_label: 'Portfolio', alias_code: 'PORTFOLIO', client: true },
    { domain_code: 'FUND', alias_label: 'Vehicle', alias_code: 'VEHICLE', client: false },
  ],
  names: [
    { domain_code: 'ISSUER', alias_label: 'Portfolio name', alias_code: 'PORTFOLIO_NAME', client: true },
    { domain_code: 'FUND', alias_label: 'Vehicle name', alias_code: 'VEHICLE_NAME', client: false },
  ],
  attributes: [
    { attribute_id: 'a1', alias_label: 'Ending NAV', alias_code: 'ENDING_NAV', domain_code: 'FUND', client: false },
    { attribute_id: 'a1', alias_label: 'Net Assets', alias_code: 'NET_ASSETS', domain_code: 'FUND', client: false },
    { attribute_id: 'a2', alias_label: 'Leverage', alias_code: null, domain_code: null, client: true },
  ],
  hidden_attribute_ids: ['a9'],
};

/** A stand-in for the three alias tables, each answering any chain of filters with its rows. */
function tables(rows: Record<string, any[]>, seen: string[] = []) {
  return {
    from: (table: string) => {
      seen.push(table);
      const builder: any = { select: () => builder, eq: () => builder, then: (resolve: any) => resolve({ data: rows[table] || [], error: null }) };
      return builder;
    },
  };
}

const SHARED_ROWS = {
  domain_aliases: [{ domain_code: 'FUND', alias_label: 'Portfolio', alias_code: 'PORTFOLIO' }],
  entity_name_aliases: [{ domain_code: 'FUND', alias_label: 'Portfolio name', alias_code: 'PORTFOLIO_NAME' }],
  attribute_aliases: [{ attribute_id: 'a1', alias_label: 'Ending NAV', alias_code: 'ENDING_NAV', domain_code: 'FUND' }],
};

describe('parseAliasWords', () => {
  it('reads the database answer, as an object or as text', () => {
    const words = parseAliasWords(ANSWER);
    expect(words.clientId).toBe('c1');
    expect(words.labels).toEqual({ ISSUER: 'Borrower' });
    expect(words.domainAliases).toEqual([
      { domainCode: 'ISSUER', aliasLabel: 'Borrower', aliasCode: 'BORROWER' },
      { domainCode: 'ISSUER', aliasLabel: 'Portfolio', aliasCode: 'PORTFOLIO' },
      { domainCode: 'FUND', aliasLabel: 'Vehicle', aliasCode: 'VEHICLE' },
    ]);
    expect(words.attributeAliases[2]).toEqual({ attributeId: 'a2', aliasLabel: 'Leverage', aliasCode: null, domainCode: null });
    expect(words.hiddenAttributeIds).toEqual(['a9']);
    expect(parseAliasWords(JSON.stringify(ANSWER))).toEqual(words);
  });

  it('gives no words for an empty answer', () => {
    expect(parseAliasWords(null)).toEqual(NO_ALIAS_WORDS);
  });

  it('groups the other words by field', () => {
    expect([...aliasLabelsByAttribute(parseAliasWords(ANSWER))]).toEqual([
      ['a1', ['Ending NAV', 'Net Assets']],
      ['a2', ['Leverage']],
    ]);
  });
});

describe('a client word wins', () => {
  it('reads a header by the client meaning, not the shared one it replaced', () => {
    // Shared: Portfolio means FUND. This client: Portfolio means ISSUER, so the shared row is not in its words.
    const words = parseAliasWords(ANSWER);
    expect(classifyHeader('Portfolio', { domainAliases: words.domainAliases }).domainCode).toBe('ISSUER');
    expect(classifyHeader('portfolio_name', { nameAliases: words.nameAliases }).domainCode).toBe('ISSUER');
    expect(classifyHeader('Vehicle', { domainAliases: words.domainAliases }).domainCode).toBe('FUND');
  });
});

describe('loadAliasWords', () => {
  it('asks the database for the session client words on a signed-in request', async () => {
    const calls: string[] = [];
    const supabase = {
      ...tables(SHARED_ROWS, calls),
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        calls.push(`rpc:${fn}:${JSON.stringify(args ?? null)}`);
        return { data: ANSWER, error: null };
      },
    };
    const words = await loadAliasWords(supabase);
    expect(calls).toEqual(['rpc:session_alias_words:null']);
    expect(words.labels).toEqual({ ISSUER: 'Borrower' });
  });

  it('names the client when server code loads a file for one', async () => {
    const calls: string[] = [];
    const supabase = {
      ...tables(SHARED_ROWS, calls),
      schema: (name: string) => ({
        ...tables(SHARED_ROWS, calls),
        rpc: async (fn: string, args?: Record<string, unknown>) => {
          calls.push(`${name}.rpc:${fn}:${JSON.stringify(args ?? null)}`);
          return { data: ANSWER, error: null };
        },
      }),
    };
    const words = await loadAliasWords(supabase, { clientId: 'c1' });
    expect(calls).toEqual(['metadata_register.rpc:alias_words:{"p_client_id":"c1"}']);
    expect(words.hiddenAttributeIds).toEqual(['a9']);
  });

  it('reads the shared lists from the tables when the database function is not there yet', async () => {
    const calls: string[] = [];
    const supabase = {
      ...tables(SHARED_ROWS, calls),
      rpc: async () => ({ data: null, error: { message: 'Could not find the function public.session_alias_words' } }),
    };
    const words = await loadAliasWords(supabase);
    expect(calls).toEqual(['domain_aliases', 'entity_name_aliases', 'attribute_aliases']);
    expect(words.domainAliases).toEqual([{ domainCode: 'FUND', aliasLabel: 'Portfolio', aliasCode: 'PORTFOLIO' }]);
    expect(words.labels).toEqual({});
    expect(words.hiddenAttributeIds).toEqual([]);
  });

  it('reads the tables when the reader cannot call a function at all', async () => {
    const words = await loadAliasWords(tables(SHARED_ROWS));
    expect(words.nameAliases).toEqual([{ domainCode: 'FUND', aliasLabel: 'Portfolio name', aliasCode: 'PORTFOLIO_NAME' }]);
    expect(words.attributeAliases).toHaveLength(1);
  });

  it('fails when the tables cannot be read either', async () => {
    const broken = { from: () => { const b: any = { select: () => b, eq: () => b, then: (resolve: any) => resolve({ data: null, error: { message: 'permission denied' } }) }; return b; } };
    await expect(loadAliasWords(broken)).rejects.toThrow('permission denied');
  });
});
