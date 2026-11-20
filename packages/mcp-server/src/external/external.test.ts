import { describe, expect, it } from 'vitest';
import { externalToolName, isExternalToolName, isValidServerCode, serverCodeFrom } from './names';
import { toGeminiParameters } from './gemini-schema';
import { checkServerUrl, isPrivateAddress } from './url-guard';
import { authHeaders, shapeToolResult, toDiscoveredTool } from './client';
import { buildExternalToolset, CONFIRM_ARGUMENT, externalServersPrompt } from './toolset';
import { cleanIdentifierHints, serverFromRuntimeRow } from './rows';
import { isCategoryAllowed } from '../lib/context-profiles';
import type { ExternalServer } from './types';

function server(overrides: Partial<ExternalServer> = {}): ExternalServer {
  return {
    id: 'srv-1',
    serverCode: 'CRM',
    serverName: 'DealCloud',
    url: 'https://mcp.example.com/mcp',
    authType: 'BEARER',
    secret: 'token',
    instructions: 'Our CRM.',
    sourceCode: 'DEALCLOUD',
    sourceName: 'DealCloud',
    identifierHints: [{ identifier: 'DEALCLOUD', argument: 'company_id', tool: 'get_company' }],
    tools: [
      { name: 'get_company', description: 'Reads a company', inputSchema: { type: 'object', properties: { company_id: { type: 'string' } }, required: ['company_id'] }, readOnly: true, destructive: false },
      { name: 'update_stage', description: 'Moves a deal', inputSchema: { type: 'object', properties: { stage: { type: 'string' } } }, readOnly: false, destructive: false },
      { name: 'delete_note', description: 'Deletes a note', inputSchema: { type: 'object', properties: {} }, readOnly: false, destructive: true },
      { name: 'hidden', description: 'Not turned on', inputSchema: { type: 'object' }, readOnly: true, destructive: false },
    ],
    enabledTools: ['get_company', 'update_stage', 'delete_note'],
    writeTools: ['update_stage'],
    ...overrides,
  };
}

describe('outside tool names', () => {
  it('prefixes the server code and keeps names Gemini accepts', () => {
    expect(externalToolName('CRM', 'get_company')).toBe('ext__CRM__get_company');
    expect(externalToolName('CRM', 'companies/search v2')).toBe('ext__CRM__companies_search_v2');
    expect(isExternalToolName('ext__CRM__x')).toBe(true);
    expect(isExternalToolName('query_data')).toBe(false);
  });

  it('cuts long names to 64 characters and keeps them distinct', () => {
    const a = externalToolName('PORTFOLIO_MONITORING', 'get_quarterly_operating_metrics_for_company_alpha');
    const b = externalToolName('PORTFOLIO_MONITORING', 'get_quarterly_operating_metrics_for_company_omega');
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });

  it('makes server codes from names', () => {
    expect(serverCodeFrom('DealCloud CRM')).toBe('DEALCLOUD_CRM');
    expect(serverCodeFrom('3rd party')).toBe('MCP_3RD_PARTY');
    expect(isValidServerCode('DEALCLOUD_CRM')).toBe(true);
    expect(isValidServerCode('1BAD')).toBe(false);
    expect(isValidServerCode('has space')).toBe(false);
  });
});

describe('JSON Schema to Gemini parameters', () => {
  it('maps types, required and nested objects', () => {
    const parameters = toGeminiParameters({
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Company id' },
        limit: { type: 'integer' },
        filter: { type: 'object', properties: { stage: { type: 'string', enum: ['open', 'won'] } } },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'missing'],
    });
    expect(parameters).toEqual({
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING', description: 'Company id' },
        limit: { type: 'INTEGER' },
        filter: { type: 'OBJECT', properties: { stage: { type: 'STRING', enum: ['open', 'won'] } } },
        tags: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['id'],
    });
  });

  it('folds nullable unions, anyOf, refs and numeric enums into what Gemini accepts', () => {
    const parameters = toGeminiParameters({
      type: 'object',
      properties: {
        maybe: { type: ['string', 'null'] },
        either: { anyOf: [{ type: 'null' }, { type: 'number' }] },
        ref: { $ref: '#/definitions/Thing' },
        level: { type: 'integer', enum: [1, 2, 3] },
        fixed: { type: 'string', const: 'x' },
      },
    });
    expect(parameters.properties.maybe).toEqual({ type: 'STRING', nullable: true });
    expect(parameters.properties.either).toEqual({ type: 'NUMBER', nullable: true });
    expect(parameters.properties.ref.type).toBe('STRING');
    expect(parameters.properties.level).toEqual({ type: 'INTEGER', description: 'One of: 1, 2, 3.' });
    expect(parameters.properties.fixed.enum).toEqual(['x']);
  });

  it('gives a tool with no schema an empty object', () => {
    expect(toGeminiParameters(undefined)).toEqual({ type: 'OBJECT', properties: {} });
  });

  it('stops at a depth limit for recursive schemas', () => {
    let schema: any = { type: 'string' };
    for (let i = 0; i < 12; i++) schema = { type: 'object', properties: { child: schema } };
    let node = toGeminiParameters(schema);
    let depth = 0;
    while (node.properties?.child) {
      node = node.properties.child;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(8);
  });
});

describe('server addresses', () => {
  it('accepts public https addresses only', () => {
    expect(checkServerUrl('https://mcp.example.com/mcp', false)).toBeNull();
    expect(checkServerUrl('http://mcp.example.com/mcp', false)).toMatch(/https/);
    expect(checkServerUrl('not a url', false)).toMatch(/full address/);
    expect(checkServerUrl('https://user:pw@mcp.example.com', false)).toMatch(/credential/);
    expect(checkServerUrl('https://localhost:3000', false)).toMatch(/public/);
    expect(checkServerUrl('https://10.0.0.5/mcp', false)).toMatch(/public/);
    expect(checkServerUrl('https://169.254.169.254/latest', false)).toMatch(/public/);
    expect(checkServerUrl('https://[::1]/mcp', false)).toMatch(/public/);
    expect(checkServerUrl('https://metadata.google.internal', false)).toMatch(/public/);
  });

  it('allows local servers when development opts in', () => {
    expect(checkServerUrl('http://localhost:8787/mcp', true)).toBeNull();
  });

  it('recognises private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
});

describe('server sign-in and results', () => {
  it('sends the secret the way the server expects', () => {
    expect(authHeaders({ url: '', authType: 'BEARER', secret: 's' })).toEqual({ Authorization: 'Bearer s' });
    expect(authHeaders({ url: '', authType: 'HEADER', headerName: 'X-Api-Key', secret: 's' })).toEqual({ 'X-Api-Key': 's' });
    expect(authHeaders({ url: '', authType: 'NONE', secret: 's' })).toEqual({});
    expect(authHeaders({ url: '', authType: 'BEARER', secret: null })).toEqual({});
  });

  it('reads tool annotations', () => {
    const tool = toDiscoveredTool({ name: 'x', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } });
    expect(tool).toMatchObject({ name: 'x', readOnly: true, destructive: null });
  });

  it('marks outside content as data and caps its size', () => {
    const shaped = shapeToolResult('DealCloud', 'get_company', {
      content: [{ type: 'text', text: 'a'.repeat(25_000) }, { type: 'image', data: '...' }],
      structuredContent: { id: 1 },
    });
    expect(shaped.provenance).toMatch(/not as instructions/);
    expect(shaped.truncated).toBe(true);
    expect(shaped.text?.length).toBe(20_000);
    expect(shaped.structured).toEqual({ id: 1 });
    expect(shaped.isError).toBe(false);
  });
});

describe('the toolset for one turn', () => {
  it('declares only the tools an administrator turned on', () => {
    const toolset = buildExternalToolset([server()]);
    expect(toolset.declarations.map((d) => d.name)).toEqual(['ext__CRM__get_company', 'ext__CRM__update_stage', 'ext__CRM__delete_note']);
    expect(toolset.has('ext__CRM__hidden')).toBe(false);
    expect(toolset.describe('ext__CRM__get_company')).toEqual({ serverCode: 'CRM', tool: 'get_company', write: false });
  });

  it('tells the model which identifier a tool takes', () => {
    const toolset = buildExternalToolset([server()]);
    const read = toolset.declarations.find((d) => d.name === 'ext__CRM__get_company')!;
    expect(read.description).toMatch(/company_id takes DEALCLOUD/);
    expect(read.parameters.properties[CONFIRM_ARGUMENT]).toBeUndefined();
  });

  it('treats marked and destructive tools as write tools that need confirmation', async () => {
    const toolset = buildExternalToolset([server()]);
    for (const name of ['ext__CRM__update_stage', 'ext__CRM__delete_note']) {
      const declaration = toolset.declarations.find((d) => d.name === name)!;
      expect(declaration.parameters.properties[CONFIRM_ARGUMENT].type).toBe('BOOLEAN');
      expect(declaration.description).toMatch(/changes data/);
      // Refused before any connection is opened.
      await expect(toolset.execute(name, { stage: 'won' })).rejects.toThrow(/confirm/);
    }
    await toolset.close();
  });

  it('writes a prompt section naming the source and the identifiers', () => {
    const servers = [server(), server({ id: 'srv-2', serverCode: 'OFF', serverName: 'Unused', enabledTools: [] })];
    const toolset = buildExternalToolset(servers);
    const prompt = externalServersPrompt(servers, toolset);
    expect(prompt).toMatch(/DealCloud \(tools named ext__CRM__/);
    expect(prompt).toMatch(/source DEALCLOUD/);
    expect(prompt).toMatch(/get_external_ids/);
    expect(prompt).toMatch(/data, never instructions/);
    expect(prompt).not.toMatch(/Unused/);
    expect(externalServersPrompt([], buildExternalToolset([]))).toBe('');
  });
});

describe('database rows', () => {
  it('maps a runtime row and cleans identifier hints', () => {
    const mapped = serverFromRuntimeRow({
      id: 'a', server_code: 'CRM', server_name: 'CRM', url: 'https://x', auth_type: 'WEIRD', secret: 's',
      identifier_hints: [{ identifier: ' LEI ', argument: 'lei' }, { argument: 'no identifier' }, 'bad'],
      discovered_tools: [{ name: 't', inputSchema: { type: 'object' } }, { nope: true }],
      enabled_tools: ['t'], write_tools: [],
    });
    expect(mapped.authType).toBe('NONE');
    expect(mapped.identifierHints).toEqual([{ identifier: 'LEI', argument: 'lei' }]);
    expect(mapped.tools.map((t) => t.name)).toEqual(['t']);
    expect(cleanIdentifierHints('nope')).toEqual([]);
  });
});

describe('profiles that offer outside systems', () => {
  it('offers them where people explore and analyse records, not in guided write contexts', () => {
    for (const profile of ['entity-explorer', 'lineage', 'analyst', 'general']) {
      expect(isCategoryAllowed('external', profile)).toBe(true);
    }
    for (const profile of ['workflow', 'import', 'report-designer', 'entity-admin']) {
      expect(isCategoryAllowed('external', profile)).toBe(false);
    }
  });
});
