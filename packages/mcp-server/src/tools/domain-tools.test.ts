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
