import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { handleMcpHttpRequest } from './http';
import { ToolRegistry } from './lib/tool-registry';
import type { ToolDefinition } from './lib/types';

const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  description: `Test tool ${name}.`,
  category: 'domain-read',
  inputSchema: { type: 'object', properties: {} },
  execute: async (_args, supabase) => ({ ranAs: (supabase as unknown as { name: string }).name }),
  ...extra,
});

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.registerTool(tool('get_thing'));
  tools.registerTool(tool('stage_thing', { effect: 'stage' }));
  tools.registerTool(tool('update_thing'));
  return tools;
}

const caller = { name: 'caller' } as unknown as SupabaseClient;

function post(body: unknown): Request {
  return new Request('https://app.example.com/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
}

const call = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params });

describe('handleMcpHttpRequest', () => {
  it('answers initialize in JSON with no session to keep', async () => {
    const response = await handleMcpHttpRequest(
      post(call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })),
      { client: caller, registry: registry() }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = await response.json();
    expect(body.result.serverInfo.name).toBe('tapestrai-mcp');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('answers a request on its own, with no initialize before it', async () => {
    const response = await handleMcpHttpRequest(post(call(2, 'tools/list')), { client: caller, registry: registry() });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(['get_thing', 'stage_thing', 'update_thing']);
  });

  it('marks which tools only read', async () => {
    const response = await handleMcpHttpRequest(post(call(3, 'tools/list')), { client: caller, registry: registry() });
    const hints = Object.fromEntries(
      (await response.json()).result.tools.map((t: { name: string; annotations: { readOnlyHint: boolean } }) => [t.name, t.annotations.readOnlyHint])
    );
    expect(hints).toEqual({ get_thing: true, stage_thing: false, update_thing: false });
  });

  it('lists only the tools whose effect is offered', async () => {
    const response = await handleMcpHttpRequest(post(call(4, 'tools/list')), { client: caller, registry: registry(), effects: ['read', 'stage'] });
    const body = await response.json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(['get_thing', 'stage_thing']);
  });

  it('runs an offered tool as the caller', async () => {
    const response = await handleMcpHttpRequest(
      post(call(5, 'tools/call', { name: 'get_thing', arguments: {} })),
      { client: caller, registry: registry(), effects: ['read', 'stage'] }
    );
    const body = await response.json();
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0].text)).toEqual({ ranAs: 'caller' });
  });

  it('refuses a call to a tool that is not offered, without running it', async () => {
    let ran = false;
    const tools = registry();
    tools.registerTool(tool('delete_thing', { execute: async () => { ran = true; return {}; } }));
    const response = await handleMcpHttpRequest(
      post(call(6, 'tools/call', { name: 'delete_thing', arguments: {} })),
      { client: caller, registry: tools, effects: ['read', 'stage'] }
    );
    const body = await response.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not offered on this connection/);
    expect(ran).toBe(false);
  });

  it('says so when a tool does not exist', async () => {
    const response = await handleMcpHttpRequest(
      post(call(7, 'tools/call', { name: 'get_nothing', arguments: {} })),
      { client: caller, registry: registry(), effects: ['read', 'stage'] }
    );
    const body = await response.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe('Error: Unknown tool: get_nothing');
  });

  it('keeps one caller out of the next request', async () => {
    const tools = registry();
    const other = { name: 'someone-else' } as unknown as SupabaseClient;
    const [first, second] = await Promise.all([
      handleMcpHttpRequest(post(call(8, 'tools/call', { name: 'get_thing', arguments: {} })), { client: caller, registry: tools }),
      handleMcpHttpRequest(post(call(9, 'tools/call', { name: 'get_thing', arguments: {} })), { client: other, registry: tools }),
    ]);
    expect(JSON.parse((await first.json()).result.content[0].text)).toEqual({ ranAs: 'caller' });
    expect(JSON.parse((await second.json()).result.content[0].text)).toEqual({ ranAs: 'someone-else' });
  });

  it('answers 405 to anything but POST', async () => {
    const response = await handleMcpHttpRequest(new Request('https://app.example.com/api/mcp', { method: 'GET' }), { client: caller, registry: registry() });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});
