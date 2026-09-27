import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../../../.env') });
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import { registerDomainTools } from './tools/domain-tools.js';
import { registerLineageTools } from './tools/lineage-tools.js';
import { registerOverrideTools } from './tools/override-tools.js';
import { registerDQTools } from './tools/dq-tools.js';
import { registerImportMapTools } from './tools/import-map-tools.js';
import { ToolRegistry } from './lib/tool-registry.js';

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
    name: 'meridian-mdm-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
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
  if (!supabase) {
    return { resources: [] };
  }
  
  // Dynamically list available domain templates as resources
  const { data: templates } = await supabase
    .from('domain_templates')
    .select('id, template_code, domain_code, template_name')
    .eq('is_active', true);
  
  return {
    resources: (templates || []).map((t: any) => ({
      uri: `meridian://template/${t.template_code}`,
      name: `${t.domain_code}: ${t.template_name}`,
      mimeType: 'application/json',
      description: `Template definition for ${t.domain_code} domain`,
    })),
  };
});

// Handle resource reading
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (!supabase) {
    throw new Error('Supabase client not initialized. Set SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY.');
  }
  
  const { uri } = request.params;
  
  // Parse template URI
  const match = uri.match(/^meridian:\/\/template\/(.+)$/);
  if (!match) {
    throw new Error(`Unknown resource URI: ${uri}`);
  }
  
  const templateCode = match[1];
  
  // Fetch template with attributes
  const { data: template } = await supabase
    .from('domain_templates')
    .select(`
      *,
      template_attribute_assignments(
        *,
        attribute_register(*)
      )
    `)
    .eq('template_code', templateCode)
    .single();
  
  if (!template) {
    throw new Error(`Template not found: ${templateCode}`);
  }
  
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(template, null, 2),
      },
    ],
  };
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Meridian MDM MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
