import { describe, expect, it } from 'vitest';
import {
  domainDepth,
  fetchEntitySearchHits,
  ilikeContainsPattern,
  rankEntitySearch,
  rootDomainCodes,
  type SearchDomainRow,
  type SearchEntityRow,
  type SearchLinkRow,
} from './entity-search';

const domains: SearchDomainRow[] = [
  { domainCode: 'FUND', domainName: 'Fund', parentDomainCode: null },
  { domainCode: 'ISSUER', domainName: 'Issuer', parentDomainCode: null },
  { domainCode: 'DEAL', domainName: 'Deal', parentDomainCode: null },
  { domainCode: 'SECURITY', domainName: 'Security', parentDomainCode: 'ISSUER' },
  { domainCode: 'POSITION', domainName: 'Position', parentDomainCode: 'FUND' },
  { domainCode: 'DEAL_TRANCHE', domainName: 'Tranche', parentDomainCode: 'DEAL' },
  { domainCode: 'ORPHAN', domainName: 'Orphan', parentDomainCode: 'MISSING' },
];

const entities: SearchEntityRow[] = [
  { id: 'f1', entityCode: 'F1', entityName: 'Alpha Fund', domainCode: 'FUND', isActive: true },
  { id: 'i1', entityCode: 'I1', entityName: 'Brightwater Holdings', domainCode: 'ISSUER', isActive: true },
  { id: 'd1', entityCode: 'D1', entityName: 'Project Brightwater', domainCode: 'DEAL', isActive: true },
  { id: 's1', entityCode: 'S1', entityName: 'Brightwater TLB', domainCode: 'SECURITY', isActive: true },
  { id: 'p1', entityCode: 'P1', entityName: 'Lane stake', domainCode: 'POSITION', isActive: true },
  { id: 't1', entityCode: 'T1', entityName: 'Brightwater Delayed Draw', domainCode: 'DEAL_TRANCHE', isActive: true },
  { id: 'o1', entityCode: 'O1', entityName: 'Other Fund', domainCode: 'FUND', isActive: true },
  { id: 'x1', entityCode: 'X1', entityName: 'Closed Fund', domainCode: 'FUND', isActive: false },
];

const links: SearchLinkRow[] = [
  { parentEntityId: 'i1', childEntityId: 's1' },
  { parentEntityId: 'f1', childEntityId: 'p1' },
  { parentEntityId: 's1', childEntityId: 'p1' },
  { parentEntityId: 'd1', childEntityId: 't1' },
];

describe('entity search ranking', () => {
  it('lists each entity once, parent types before child types, and names in alphabetical order within a type', () => {
    const hits = rankEntitySearch({ query: 'Brightwater', entities, links, domains });
    expect(hits.map((hit) => `${hit.domainName}: ${hit.entityName}`)).toEqual([
      'Deal: Project Brightwater',
      'Issuer: Brightwater Holdings',
      'Position: Lane stake',
      'Security: Brightwater TLB',
      'Tranche: Brightwater Delayed Draw',
    ]);
    expect(hits.slice(0, 2).every((hit) => hit.depth === 0 && hit.match === 'NAME')).toBe(true);
    expect(hits.find((hit) => hit.id === 'p1')).toMatchObject({
      depth: 1,
      match: 'PARENT',
      matchedName: 'Brightwater TLB',
      matchedDomainName: 'Security',
    });
    expect(hits.find((hit) => hit.id === 't1')).toMatchObject({ domainName: 'Tranche', match: 'NAME' });
  });

  it('puts the parent record first when the query matches a child name', () => {
    const hits = rankEntitySearch({ query: 'stake', entities, links, domains });
    expect(hits.map((hit) => [hit.entityName, hit.match, hit.depth])).toEqual([
      ['Alpha Fund', 'RELATED', 0],
      ['Lane stake', 'NAME', 1],
      ['Brightwater TLB', 'RELATED', 1],
    ]);
    expect(hits[0]).toMatchObject({ matchedName: 'Lane stake', matchedDomainName: 'Position' });
  });

  it('matches a parent name onto the child and skips inactive or unrelated records', () => {
    const hits = rankEntitySearch({ query: 'Alpha', entities, links, domains });
    expect(hits.map((hit) => hit.entityName)).toEqual(['Alpha Fund', 'Lane stake']);
    expect(hits[1]).toMatchObject({ match: 'PARENT', matchedName: 'Alpha Fund', matchedDomainName: 'Fund' });
    expect(rankEntitySearch({ query: 'Closed', entities, links, domains })).toEqual([]);
    expect(rankEntitySearch({ query: 'a', entities, links, domains })).toEqual([]);
  });

  it('keeps later entity types in the list when one type has more matching names', () => {
    const bench: SearchEntityRow[] = [
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `bench-fund-${index}`,
        entityCode: `BF${index}`,
        entityName: `Bench Fund ${index}`,
        domainCode: 'FUND',
        isActive: true,
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `bench-issuer-${index}`,
        entityCode: `BI${index}`,
        entityName: `Bench Issuer ${index}`,
        domainCode: 'ISSUER',
        isActive: true,
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `bench-position-${index}`,
        entityCode: `BP${index}`,
        entityName: `Bench Position ${index}`,
        domainCode: 'POSITION',
        isActive: true,
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `bench-security-${index}`,
        entityCode: `BS${index}`,
        entityName: `Bench Security ${index}`,
        domainCode: 'SECURITY',
        isActive: true,
      })),
    ];
    const roots: SearchDomainRow[] = [
      { domainCode: 'FUND', domainName: 'Fund', parentDomainCode: null },
      { domainCode: 'ISSUER', domainName: 'Issuer', parentDomainCode: null },
      { domainCode: 'POSITION', domainName: 'Position', parentDomainCode: null },
      { domainCode: 'SECURITY', domainName: 'Security', parentDomainCode: null },
    ];
    const hits = rankEntitySearch({ query: 'Bench', entities: bench, links: [], domains: roots, limit: 20 });
    expect(hits.filter((hit) => hit.domainCode === 'FUND')).toHaveLength(5);
    expect(hits.filter((hit) => hit.domainCode === 'ISSUER')).toHaveLength(5);
    expect(hits.filter((hit) => hit.domainCode === 'POSITION')).toHaveLength(5);
    expect(hits.filter((hit) => hit.domainCode === 'SECURITY')).toHaveLength(5);
  });

  it('leaves room for child entities when many parent names match', () => {
    const many: SearchEntityRow[] = [
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `fund-${index}`,
        entityCode: `F${index}`,
        entityName: `Fund ${index}`,
        domainCode: 'FUND',
        isActive: true,
      })),
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `pos-${index}`,
        entityCode: `P${index}`,
        entityName: `Funded position ${index}`,
        domainCode: 'POSITION',
        isActive: true,
      })),
    ];
    const hits = rankEntitySearch({ query: 'fund', entities: many, links: [], domains, limit: 20 });
    expect(hits.filter((hit) => hit.depth === 0)).toHaveLength(12);
    expect(hits.filter((hit) => hit.depth > 0)).toHaveLength(8);
  });

  it('returns one hit when the same entity id is supplied twice', () => {
    const fund = entities.find((entity) => entity.id === 'f1')!;
    const hits = rankEntitySearch({
      query: 'Alpha',
      entities: [fund, { ...fund, id: 'F1' }],
      links: [],
      domains,
    });
    expect(hits.map((hit) => hit.entityName)).toEqual(['Alpha Fund']);
  });

  it('keeps a parent that only matched through a child ahead of that child when the list is short', () => {
    const hits = rankEntitySearch({ query: 'stake', entities, links, domains, limit: 1 });
    expect(hits.map((hit) => hit.id)).toEqual(['f1']);
  });

  it('treats a fund stored on the child side of the link as the position parent', () => {
    const reversed: SearchLinkRow[] = [{ parentEntityId: 'p1', childEntityId: 'f1' }];
    const hits = rankEntitySearch({
      query: 'Alpha',
      entities: entities.filter((entity) => entity.id === 'f1' || entity.id === 'p1'),
      links: reversed,
      domains,
    });
    expect(hits.map((hit) => hit.id)).toEqual(['f1', 'p1']);
    expect(hits[1].match).toBe('PARENT');
  });
});

describe('entity search catalog helpers', () => {
  it('counts depth from the domain parent and treats a missing parent as a root', () => {
    const parentOf = new Map<string, string | null>([
      ['FUND', null],
      ['POSITION', 'FUND'],
      ['SECURITY', 'ISSUER'],
      ['ISSUER', null],
    ]);
    expect(domainDepth('POSITION', parentOf)).toBe(1);
    expect(domainDepth('FUND', parentOf)).toBe(0);
    expect(rootDomainCodes(domains)).toEqual(['FUND', 'ISSUER', 'DEAL', 'ORPHAN']);
    const orphan = rankEntitySearch({
      query: 'Orphan Co',
      entities: [{ id: 'z', entityCode: 'Z', entityName: 'Orphan Co', domainCode: 'ORPHAN', isActive: true }],
      links: [],
      domains,
    });
    expect(orphan[0].depth).toBe(0);
    expect(ilikeContainsPattern(' 100%_x ')).toBe('%100\\%\\_x%');
  });
});

describe('fetchEntitySearchHits', () => {
  it('returns the parent before the child and still includes a type that sorts later', async () => {
    const tables: Record<string, Record<string, unknown>[]> = {
      domain_types: domains.map((domain) => ({
        domain_code: domain.domainCode,
        domain_name: domain.domainName,
        parent_domain_code: domain.parentDomainCode,
        is_active: true,
      })),
      master_entities: entities.map((entity) => ({
        id: entity.id,
        entity_code: entity.entityCode,
        entity_name: entity.entityName,
        domain_code: entity.domainCode,
        is_active: entity.isActive !== false,
      })),
      entity_relationships: [
        ...links.map((link) => ({
          parent_entity_id: link.parentEntityId,
          child_entity_id: link.childEntityId,
          valid_to: '9999-12-31',
          system_to: '9999-12-31 23:59:59',
        })),
        {
          parent_entity_id: 'o1',
          child_entity_id: 's1',
          valid_to: '2020-01-01',
          system_to: '2020-01-01 00:00:00',
        },
      ],
    };

    const hits = await fetchEntitySearchHits(fakeClient(tables), 'stake', 20);
    expect(hits.map((hit) => hit.entityName)).toEqual(['Alpha Fund', 'Lane stake', 'Brightwater TLB']);
    expect(hits.some((hit) => hit.id === 'o1')).toBe(false);

    const crowded = await fetchEntitySearchHits(fakeClient({
      domain_types: [
        { domain_code: 'FUND', domain_name: 'Fund', parent_domain_code: null, is_active: true },
        { domain_code: 'POSITION', domain_name: 'Position', parent_domain_code: null, is_active: true },
      ],
      master_entities: [
        ...Array.from({ length: 70 }, (_, index) => ({
          id: `bf${index}`,
          entity_code: `BF${index}`,
          entity_name: `Bench Fund ${index}`,
          domain_code: 'FUND',
          is_active: true,
        })),
        {
          id: 'bp',
          entity_code: 'BP',
          entity_name: 'Bench Position 1',
          domain_code: 'POSITION',
          is_active: true,
        },
      ],
      entity_relationships: [],
    }), 'Bench', 20);
    expect(crowded.some((hit) => hit.domainCode === 'FUND')).toBe(true);
    expect(crowded.some((hit) => hit.id === 'bp')).toBe(true);
    expect(crowded.filter((hit) => hit.domainCode === 'FUND').length).toBeLessThanOrEqual(8);
  });
});

function fakeClient(tables: Record<string, Record<string, unknown>[]>) {
  return {
    rpc(fn: string, args?: Record<string, unknown>) {
      if (fn !== 'search_entity_names') {
        return Promise.resolve({ data: [], error: { message: `Unknown function ${fn}` } });
      }
      const needle = String(args?.p_query || '').trim().toLowerCase();
      const perDomain = Number(args?.p_per_domain || 8);
      const matches = (tables.master_entities || [])
        .filter((row) => row.is_active !== false && String(row.entity_name || '').toLowerCase().includes(needle))
        .sort((a, b) => String(a.entity_name).localeCompare(String(b.entity_name)) || String(a.id).localeCompare(String(b.id)));
      const counts = new Map<string, number>();
      const data = matches.filter((row) => {
        const domain = String(row.domain_code || '');
        const used = counts.get(domain) || 0;
        if (used >= perDomain) return false;
        counts.set(domain, used + 1);
        return true;
      });
      return Promise.resolve({ data, error: null });
    },
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let orderColumn: string | null = null;
      let rowLimit: number | null = null;
      const api = {
        select() { return api; },
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return api;
        },
        ilike(column: string, pattern: string) {
          const needle = pattern.replace(/^%/, '').replace(/%$/, '').replace(/\\([%_\\])/g, '$1').toLowerCase();
          filters.push((row) => String(row[column] ?? '').toLowerCase().includes(needle));
          return api;
        },
        in(column: string, values: readonly unknown[]) {
          const allowed = new Set(values);
          filters.push((row) => allowed.has(row[column]));
          return api;
        },
        order(column: string) {
          orderColumn = column;
          return api;
        },
        limit(count: number) {
          rowLimit = count;
          return api;
        },
        then(onFulfilled: (value: { data: Record<string, unknown>[]; error: null }) => unknown) {
          let rows = (tables[table] || []).filter((row) => filters.every((filter) => filter(row)));
          if (orderColumn) {
            const column = orderColumn;
            rows = [...rows].sort((a, b) => String(a[column] ?? '').localeCompare(String(b[column] ?? '')));
          }
          if (rowLimit != null) rows = rows.slice(0, rowLimit);
          return Promise.resolve(onFulfilled({ data: rows, error: null }));
        },
      };
      return api;
    },
  };
}
