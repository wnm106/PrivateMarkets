import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ToolRegistry } from './tool-registry';
import type { ToolDefinition } from './types';

const whoRan: ToolDefinition = {
  name: 'who_ran',
  description: 'Returns the client the call was given.',
  category: 'domain-read',
  inputSchema: { type: 'object', properties: {} },
  execute: async (_args, supabase) => ({ ranAs: supabase }),
};

describe('ToolRegistry', () => {
  it('runs a tool as the client the call names', async () => {
    const registry = new ToolRegistry();
    registry.registerTool(whoRan);
    const caller = { name: 'caller' } as unknown as SupabaseClient;
    expect(await registry.executeTool('who_ran', {}, caller)).toEqual({ ranAs: caller });
  });

  it('refuses a call that names no client', async () => {
    const registry = new ToolRegistry();
    registry.registerTool(whoRan);
    await expect(registry.executeTool('who_ran', {}, undefined as never)).rejects.toThrow(/without a database client/);
    await expect(registry.executeTool('who_ran', {}, null as never)).rejects.toThrow(/without a database client/);
  });

  it('never falls back to a client passed when the registry was built', async () => {
    const privileged = { name: 'service-role' } as unknown as SupabaseClient;
    const registry = new ToolRegistry(privileged);
    registry.registerTool(whoRan);
    await expect(registry.executeTool('who_ran', {}, undefined as never)).rejects.toThrow(/without a database client/);
    const caller = { name: 'caller' } as unknown as SupabaseClient;
    expect(await registry.executeTool('who_ran', {}, caller)).toEqual({ ranAs: caller });
  });

  it('refuses to read a template without a client', async () => {
    await expect(new ToolRegistry().compileSchemaFromTemplate('FUND_STANDARD', undefined as never)).rejects.toThrow(/without a database client/);
  });
});

/** A caller's client whose database answers the license question with the given groups. */
function licensedCaller(licensed: Record<string, boolean | 'missing' | 'broken'>) {
  const asked: { fn: string; args: any }[] = [];
  const client: any = {
    schema: () => ({
      rpc: async (fn: string, args: any) => {
        asked.push({ fn, args });
        const answer = licensed[args.p_code];
        if (answer === 'missing') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
        if (answer === 'broken') return { data: null, error: { code: '57014', message: 'canceled' } };
        return { data: answer ?? true, error: null };
      },
    }),
  };
  return { client: client as SupabaseClient, asked };
}

describe('ToolRegistry license check', () => {
  it('asks the database, as the caller, whether the tool group is licensed', async () => {
    const registry = new ToolRegistry();
    registry.registerTool(whoRan);
    const { client, asked } = licensedCaller({ 'domain-read': true });
    await registry.executeTool('who_ran', {}, client);
    expect(asked).toEqual([{ fn: 'item_enabled', args: { p_kind: 'assistant_tool', p_code: 'domain-read' } }]);
  });

  it('refuses a tool whose group is switched off, before it runs', async () => {
    const registry = new ToolRegistry();
    let ran = false;
    registry.registerTool({ ...whoRan, name: 'rec_tool', category: 'reconciliation', execute: async () => { ran = true; return {}; } });
    const { client } = licensedCaller({ reconciliation: false });
    await expect(registry.executeTool('rec_tool', {}, client)).rejects.toThrow(/not part of this client's license/);
    expect(ran).toBe(false);
  });

  it('asks once per group for the same caller', async () => {
    const registry = new ToolRegistry();
    registry.registerTool(whoRan);
    registry.registerTool({ ...whoRan, name: 'who_ran_again' });
    const { client, asked } = licensedCaller({});
    await registry.executeTool('who_ran', {}, client);
    await registry.executeTool('who_ran_again', {}, client);
    expect(asked).toHaveLength(1);
  });

  it('leaves tools on for a database without license switches, and refuses when the answer fails', async () => {
    const registry = new ToolRegistry();
    registry.registerTool(whoRan);
    await expect(registry.executeTool('who_ran', {}, licensedCaller({ 'domain-read': 'missing' }).client)).resolves.toBeTruthy();
    await expect(registry.executeTool('who_ran', {}, licensedCaller({ 'domain-read': 'broken' }).client)).rejects.toThrow(/license could not be read/);
  });

  it('names each tool\'s license group', () => {
    const registry = new ToolRegistry();
    registry.registerTool(whoRan);
    expect(registry.categoryOf('who_ran')).toBe('domain-read');
    expect(registry.categoryOf('nope')).toBeUndefined();
  });
});
