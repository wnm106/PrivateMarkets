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
