import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../../.env') });
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import { registerDomainTools } from './tools/domain-tools.js';
import { registerLineageTools } from './tools/lineage-tools.js';
import { registerOverrideTools } from './tools/override-tools.js';
import { registerDQTools } from './tools/dq-tools.js';
import { registerImportMapTools } from './tools/import-map-tools.js';
import { registerComplianceTools } from './tools/compliance-tools.js';
import { registerReportingTools } from './tools/reporting-tools.js';
import { ToolRegistry } from './lib/tool-registry.js';
import { listResources, readResource } from './resources.js';
import { PROMPTS, getPromptMessages } from './prompts.js';

const supabaseUrl = process.env.SUPABASE_URL || 'https://yxougybcfuignxydipes.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

let supabase: any = null;

if (!supabaseKey) {
  console.error('WARNING: No Supabase key found. MCP server will not be able to query the database.');
  console.error('Set SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY environment variable.');
} else {
  supabase = createClient(supabaseUrl, supabaseKey);
}

const server = new Server(
  {
    name: 'tapestrai-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

const toolRegistry = new ToolRegistry(supabase);

// Register all tool categories
registerDomainTools(toolRegistry);
registerLineageTools(toolRegistry);
registerOverrideTools(toolRegistry);
registerDQTools(toolRegistry);
registerImportMapTools(toolRegistry);
registerComplianceTools(toolRegistry);
registerReportingTools(toolRegistry);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = toolRegistry.listTools();
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    const result = await toolRegistry.executeTool(name, args || {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Handle resource listing
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: await listResources(supabase) };
});

// Handle resource reading
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const result = await readResource(uri, supabase);
  return {
    contents: [
      {
        uri,
        mimeType: result.mimeType,
        text: result.text,
      },
    ],
  };
});

// Handle prompt listing
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: PROMPTS };
});

// Handle prompt retrieval
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const messages = getPromptMessages(name, args || {});
  return { messages };
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('tapestr.ai MDM MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
