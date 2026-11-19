import { describe, expect, it } from 'vitest';
import { entityAliasResolvers } from './entity-aliases';

function client(handlers: Record<string, (call: string, args: unknown[]) => unknown>) {
  function chain(table: string) {
    const calls: unknown[][] = [];
    const run = (name: string) => (...args: unknown[]) => {
      calls.push([name, ...args]);
      const result = handlers[table]?.(name, args);
      if (result && typeof result === 'object' && 'then' in (result as object)) return result;
      return api;
    };
    const api: Record<string, unknown> = {
      select: run('select'),
      eq: run('eq'),
      order: run('order'),
      update: run('update'),
      upsert: run('upsert'),
      delete: run('delete'),
      maybeSingle: () => Promise.resolve(handlers[table]?.('maybeSingle', calls) ?? { data: null, error: null }),
      single: () => Promise.resolve(handlers[table]?.('single', calls) ?? { data: null, error: null }),
      then: (resolve: (value: unknown) => void) => resolve(handlers[table]?.('then', calls) ?? { data: [], error: null }),
    };
    return api;
  }
  return { from: (table: string) => chain(table) };
}

describe('entity alias resolvers', () => {
  it('saves a project name on the borrower', async () => {
    const supabase = client({
      master_entities: () => ({ data: { id: 'e1', domain_code: 'ISSUER' }, error: null }),
      entity_name_aliases: () => ({ data: [{ alias_code: 'PROJECT_NAME' }], error: null }),
      entity_aliases: (name) => {
        if (name === 'single') {
          return { data: { id: 'a1', alias_label: 'Project Falcon', alias_code: 'PROJECT_NAME', alias_kind: 'project' }, error: null };
        }
        return { data: [], error: null };
      },
    });
    const result = await entityAliasResolvers.Mutation.saveEntityAlias(
      null,
      { input: { entityId: 'e1', aliasLabel: 'Project Falcon', aliasCode: 'PROJECT_NAME' } },
      { supabase } as never,
    );
    expect(result.errors).toEqual([]);
    expect(result.alias).toMatchObject({ aliasLabel: 'Project Falcon', aliasCode: 'PROJECT_NAME', aliasKind: 'project' });
  });

  it('refuses a blank name', async () => {
    const supabase = client({
      master_entities: () => ({ data: { id: 'e1', domain_code: 'ISSUER' }, error: null }),
      entity_name_aliases: () => ({ data: [], error: null }),
    });
    const result = await entityAliasResolvers.Mutation.saveEntityAlias(
      null,
      { input: { entityId: 'e1', aliasLabel: '   ' } },
      { supabase } as never,
    );
    expect(result.alias).toBeNull();
    expect(result.errors[0].message).toBe('A name is required');
  });
});
