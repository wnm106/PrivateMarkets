import { describe, expect, it } from 'vitest';
import { SignedOutError } from './auth';
import { GraphQLClient } from './graphql';
import { attributeChoices, entityChoices } from './search';
import { cellResult, TapClient, type TapValue } from './tap-client';

function answer(overrides: Partial<TapValue>): TapValue {
  return {
    attribute: 'NAV', entity: 'FUND-1', asOfDate: null, attributeCode: 'NAV', attributeName: 'NAV', dataType: 'NUMBER',
    entityCode: 'FUND-1', entityName: 'Apex', domainCode: 'FUND', value: null, valueType: null, validFrom: null,
    error: null, message: null, candidates: [], ...overrides,
  };
}

describe('cellResult', () => {
  it('returns the value', () => {
    expect(cellResult(answer({ value: 12.5, valueType: 'NUMBER' }))).toEqual({ ok: true, value: 12.5 });
    expect(cellResult(answer({ value: false, valueType: 'BOOLEAN' }))).toEqual({ ok: true, value: false });
  });

  it('shows #VALUE! for a bad argument and #N/A for everything else, with the codes to use', () => {
    expect(cellResult(answer({ error: 'INVALID_REQUEST', message: 'As of is not a date.' }))).toMatchObject({ ok: false, error: 'value' });
    const ambiguous = cellResult(answer({ error: 'AMBIGUOUS_ENTITY', message: '2 records match. Use the record code.', candidates: ['FUND-1 (Apex, FUND)', 'FUND-2 (Apex, FUND)'] }));
    expect(ambiguous).toEqual({ ok: false, error: 'na', message: '2 records match. Use the record code. FUND-1 (Apex, FUND); FUND-2 (Apex, FUND)' });
  });
});

describe('TapClient', () => {
  it('checks arguments before asking the server', async () => {
    const client = new TapClient({ request: async () => { throw new Error('should not be called'); } });
    expect(await client.cell('', 'FUND-1', null)).toMatchObject({ ok: false, error: 'value' });
    expect(await client.cell('NAV', 'FUND-1', 'soon')).toMatchObject({ ok: false, error: 'value' });
  });

  it('sends every cell of a recalculation in one request, with dates as YYYY-MM-DD', async () => {
    const sent: unknown[] = [];
    const client = new TapClient({
      request: async <T,>(_query: string, variables: Record<string, unknown> = {}) => {
        sent.push(variables.requests);
        const requests = variables.requests as Array<{ entity: string }>;
        return { tapValues: requests.map((request, index) => answer({ entity: request.entity, value: index + 1 })) } as T;
      },
    });
    const results = await Promise.all([
      client.cell('NAV', 'FUND-1', 46295),
      client.cell('nav', 'fund-1', '2026-09-30'),
      client.cell('NAV', 'FUND-2', null),
    ]);
    expect(results).toEqual([{ ok: true, value: 1 }, { ok: true, value: 1 }, { ok: true, value: 2 }]);
    expect(sent).toEqual([[
      { attribute: 'NAV', entity: 'FUND-1', asOfDate: '2026-09-30' },
      { attribute: 'NAV', entity: 'FUND-2', asOfDate: null },
    ]]);
  });

  it('asks the person to sign in when there is no session', async () => {
    const graphql = new GraphQLClient('https://app.example.com/api/graphql', { getAccessToken: async () => null });
    const client = new TapClient(graphql);
    const result = await client.cell('NAV', 'FUND-1', null);
    expect(result).toMatchObject({ ok: false, error: 'na' });
    expect(result.ok ? '' : result.message).toMatch(/Sign in to Tapestry/);
  });
});

describe('GraphQLClient', () => {
  it('sends the bearer token without cookies, and refreshes once when the server says signed out', async () => {
    const tokens = ['old', 'new'];
    const seen: Array<{ auth: string | null; credentials?: RequestCredentials }> = [];
    const replies = [
      { errors: [{ message: 'Not authenticated' }] },
      { data: { ok: true } },
    ];
    const graphql = new GraphQLClient(
      'https://app.example.com/api/graphql',
      { getAccessToken: async (force?: boolean) => (force ? tokens[1] : tokens[0]) },
      async (_url, init) => {
        seen.push({ auth: new Headers(init?.headers).get('Authorization'), credentials: init?.credentials });
        return new Response(JSON.stringify(replies.shift()), { status: 200 });
      },
    );
    expect(await graphql.request<{ ok: boolean }>('{ ok }')).toEqual({ ok: true });
    expect(seen).toEqual([{ auth: 'Bearer old', credentials: 'omit' }, { auth: 'Bearer new', credentials: 'omit' }]);
  });

  it('gives up after one refresh', async () => {
    const graphql = new GraphQLClient(
      'https://app.example.com/api/graphql',
      { getAccessToken: async () => 'token' },
      async () => new Response(JSON.stringify({ errors: [{ message: 'Not authenticated' }] }), { status: 200 }),
    );
    await expect(graphql.request('{ ok }')).rejects.toBeInstanceOf(SignedOutError);
  });
});

describe('builder search results', () => {
  it('lists fields, then words for a record name as ENTITY_NAME', () => {
    const rows = attributeChoices({
      attributes: [{ attributeCode: 'NAV', attributeName: 'Net asset value', dataType: 'CURRENCY', domainCode: 'FUND', matchedAlias: 'Ending NAV', match: 'ATTRIBUTE_ALIAS' }],
      entityNames: [{ attributeCode: 'entity_name', attributeName: 'Name', domainCode: 'ISSUER', matchedAlias: 'Project name', match: 'ENTITY_NAME' }],
    });
    expect(rows.map((row) => row.code)).toEqual(['NAV', 'ENTITY_NAME']);
    expect(rows[0].detail).toBe('FUND · currency · also "Ending NAV"');
  });

  it('puts records of the attribute’s entity type first', () => {
    const hits = [
      { id: '1', entityCode: 'ISS-1', entityName: 'Apex', domainCode: 'ISSUER', domainName: 'Issuer', match: 'NAME', matchedName: null },
      { id: '2', entityCode: 'FUND-1', entityName: 'Apex Fund', domainCode: 'FUND', domainName: 'Fund', match: 'NAME', matchedName: null },
    ];
    expect(entityChoices(hits, 'FUND').map((row) => [row.code, row.fitsAttribute])).toEqual([['FUND-1', true], ['ISS-1', false]]);
    expect(entityChoices(hits, null).map((row) => row.code)).toEqual(['ISS-1', 'FUND-1']);
  });
});
