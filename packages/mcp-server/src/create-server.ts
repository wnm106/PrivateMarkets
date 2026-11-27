import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { registerDomainTools } from './tools/domain-tools';
import { registerLineageTools } from './tools/lineage-tools';
import { registerDocumentTools } from './tools/document-tools';
import { registerOverrideTools } from './tools/override-tools';
import { registerDQTools } from './tools/dq-tools';
import { registerDQRuleTools } from './tools/dq-rule-tools';
import { registerWorkflowTools } from './tools/workflow-tools';
import { registerImportMapTools } from './tools/import-map-tools';
import { registerPositionFileTools } from './tools/position-file-tools';
import { registerSpecialistTools } from './tools/specialist-tools';
import { registerComplianceTools } from './tools/compliance-tools';
import { registerReportingTools } from './tools/reporting-tools';
import { registerQueryTools } from './tools/query-data';
import { registerPopulationTools } from './tools/population-tools';
import { registerNarrativeTools } from './tools/narrative-tools';
import { registerExternalIdTools } from './tools/external-id-tools';
import { SERVER_INSTRUCTIONS } from './lib/narrative-guide';
import { ToolRegistry } from './lib/tool-registry';
import type { ToolEffect } from './lib/types';
import { listResources, readResource } from './resources';
import { PROMPTS, getPromptMessages } from './prompts';

/**
 * The MCP server itself, apart from how a client reaches it. The stdio process
 * (server.ts) and the HTTP endpoint (http.ts) both build it here, so the two
 * offer the same tools, resources and prompts and cannot drift apart.
 */

/** Every tool category, registered on the given registry. */
export function registerAllTools(registry: ToolRegistry = new ToolRegistry()): ToolRegistry {
  registerDomainTools(registry);
  registerLineageTools(registry);
  registerDocumentTools(registry);
  registerOverrideTools(registry);
  registerDQTools(registry);
  registerDQRuleTools(registry);
  registerWorkflowTools(registry);
  registerImportMapTools(registry);
  registerPositionFileTools(registry);
  registerSpecialistTools(registry);
  registerComplianceTools(registry);
  registerReportingTools(registry);
  registerQueryTools(registry);
  registerPopulationTools(registry);
  registerNarrativeTools(registry);
  registerExternalIdTools(registry);
  return registry;
}

let sharedRegistry: ToolRegistry | null = null;

/** One registry for the process. It holds definitions only, never a database client. */
function defaultRegistry(): ToolRegistry {
  if (!sharedRegistry) sharedRegistry = registerAllTools();
  return sharedRegistry;
}

export interface TapestraiServerOptions {
  /**
   * The client every tool and resource call runs as: the caller's own, carrying
   * their token, so tenancy and row security apply. Null when the server has
   * been given no identity; tool calls then answer with `noClientMessage`.
   */
  client: SupabaseClient | null;
  /**
   * Which tools are offered, by what calling them does (see ToolEffect). Left
   * out, every tool is offered. A tool outside the list is not listed, and a
   * call to it is refused.
   */
  effects?: readonly ToolEffect[];
  /** What a tool call answers when `client` is null. */
  noClientMessage?: string;
  /** Rewrites a tool's error message into one the person can act on. */
  explainError?: (message: string) => string;
  /** The tools to serve. Left out, every registered tool. */
  registry?: ToolRegistry;
}

const NO_CLIENT = 'Error: this MCP server has no database identity configured, so tool calls cannot run as a user.';

/** What a call to a tool that is not offered on this connection answers. */
export function notOfferedMessage(name: string, effect: ToolEffect): string {
  return `Error: ${name} is not offered on this connection because it ${effect === 'write' ? 'changes live records, rules or settings' : `is a ${effect} tool`}. `
    + 'Make the change in tapestr.ai.';
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function createTapestraiServer(options: TapestraiServerOptions): Server {
  const registry = options.registry ?? defaultRegistry();
  const offered = (name: string) => !options.effects || options.effects.includes(registry.effectOf(name));

  const server = new Server(
    { name: 'tapestrai-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      // Sent to every client on connect: how to answer a large analytical request from these tools.
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = registry
      .listTools()
      .filter((tool) => offered(tool.name))
      // The hint lets a client tell a read from a call that changes something.
      .map((tool) => ({ ...tool, annotations: { readOnlyHint: registry.effectOf(tool.name) === 'read' } }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!registry.hasTool(name)) return errorResult(`Error: Unknown tool: ${name}`);
    if (!offered(name)) return errorResult(notOfferedMessage(name, registry.effectOf(name)));
    if (!options.client) return errorResult(options.noClientMessage ?? NO_CLIENT);

    try {
      const result = await registry.executeTool(name, args || {}, options.client);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      const message = error?.message || String(error);
      return errorResult(`Error: ${options.explainError ? options.explainError(message) : message}`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: await listResources(options.client) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const result = await readResource(uri, options.client);
    return { contents: [{ uri, mimeType: result.mimeType, text: result.text }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: PROMPTS };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return { messages: getPromptMessages(name, args || {}) };
  });

  return server;
}
