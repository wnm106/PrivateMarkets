import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../lib/tool-registry';
import { duplicateNameWarning, registerDomainTools } from './domain-tools';

describe('duplicateNameWarning', () => {
  it('says nothing when every name is its own record', () => {
    expect(duplicateNameWarning([
      { entity_name: 'Bench Issuer 1', entity_code: 'BENCH-ISS-0001', entity_id: 'a' },
      { entity_name: 'Bench Issuer 2', entity_code: 'BENCH-ISS-0002', entity_id: 'b' },
    ])).toEqual({});
  });

  it('names the records that share a name and tells the reader not to combine them', () => {
    const out = duplicateNameWarning([
      { entity_name: 'Bench Issuer 79', entity_code: 'BENCH-ISS-0079', entity_id: 'a' },
      { entity_name: 'bench issuer 79 ', entity_code: 'Bench Issuer 79', entity_id: 'b' },
      { entity_name: 'Bench Issuer 80', entity_code: 'BENCH-ISS-0080', entity_id: 'c' },
    ]);
    expect(out.duplicateNames).toHaveLength(1);
    expect(out.duplicateNames?.[0].records.map((r) => r.entityCode)).toEqual(['BENCH-ISS-0079', 'Bench Issuer 79']);
    expect(out.warnings?.[0]).toMatch(/more than one record/);
    expect(out.warnings?.[0]).toMatch(/entity_code or entity_id/);
  });

  it('ignores records with no name', () => {
    expect(duplicateNameWarning([{ entity_name: null }, { entity_name: '' }, {}])).toEqual({});
  });
});

describe('search_attributes', () => {
  function fakeSupabase(tables: Record<string, any[]>) {
    return {
      from(table: string) {
        const rows = tables[table] || [];
        const b: any = {
          select: () => b,
          eq: () => b,
          or: () => b,
          in: () => b,
          order: () => b,
          limit: () => b,
          then: (resolve: any) => resolve({ data: rows, error: null }),
        };
        return b;
      },
    };
  }

  it('resolves a field alias, an entity type alias, and a name for the record', async () => {
    const supabase = fakeSupabase({
      attribute_register: [{ id: 'a1', attribute_code: 'NAV', attribute_name: 'NAV', description: 'Net asset value', data_type: 'NUMBER', domain_code: 'FUND' }],
      attribute_aliases: [{ attribute_id: 'a1', alias_label: 'Ending NAV', alias_code: 'ENDING_NAV', domain_code: 'FUND' }],
      entity_name_aliases: [{ domain_code: 'ISSUER', alias_label: 'Project name', alias_code: 'PROJECT_NAME' }],
      domain_aliases: [{ domain_code: 'ISSUER', alias_label: 'Borrower', alias_code: 'BORROWER' }],
      domain_types: [{ domain_code: 'ISSUER', domain_name: 'Issuer' }],
    });
    const registry = new ToolRegistry(supabase as never);
    registerDomainTools(registry);
    const ending: any = await registry.executeTool('search_attributes', { query: 'ending nav' }, supabase as never);
    expect(ending.attributes).toEqual([expect.objectContaining({ attribute_code: 'NAV', matched_alias: 'Ending NAV' })]);
    const borrower: any = await registry.executeTool('search_attributes', { query: 'borrower' }, supabase as never);
    expect(borrower.entityTypes).toEqual([expect.objectContaining({ domain_code: 'ISSUER', matched_alias: 'Borrower' })]);
    const project: any = await registry.executeTool('search_attributes', { query: 'project name' }, supabase as never);
    expect(project.entityNames).toEqual([expect.objectContaining({ attribute_code: 'entity_name', domain_code: 'ISSUER', matched_alias: 'Project name' })]);
  });
});

describe('list_entities', () => {
  /** A stand-in for the one query shape list_entities uses. */
  function fakeSupabase(rows: any[]) {
    const b: any = {
      select: () => b, eq: () => b, limit: () => b,
      then: (resolve: any) => resolve({ data: rows, error: null, count: rows.length }),
    };
    return { from: () => b };
  }

  it('returns the warning alongside the records when a name repeats', async () => {
    const supabase = fakeSupabase([
      { entity_id: '1', entity_code: 'BENCH-ISS-0079', entity_name: 'Bench Issuer 79' },
      { entity_id: '2', entity_code: 'Bench Issuer 79', entity_name: 'Bench Issuer 79' },
    ]);
    const registry = new ToolRegistry(supabase as never);
    registerDomainTools(registry);
    const out: any = await registry.executeTool('list_entities', { domainCode: 'ISSUER', filter: { entity_name: 'Bench Issuer 79' } }, supabase as never);
    expect(out.entities).toHaveLength(2);
    expect(out.warnings).toHaveLength(1);
    expect(out.duplicateNames[0].name).toBe('Bench Issuer 79');
  });

  it('adds nothing for a clean page', async () => {
    const supabase = fakeSupabase([{ entity_id: '1', entity_code: 'A', entity_name: 'Alpha' }]);
    const registry = new ToolRegistry(supabase as never);
    registerDomainTools(registry);
    const out: any = await registry.executeTool('list_entities', { domainCode: 'ISSUER' }, supabase as never);
    expect(out.warnings).toBeUndefined();
  });
});
