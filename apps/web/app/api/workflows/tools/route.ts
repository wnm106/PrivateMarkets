import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ToolRegistry } from '@tapestrai/mcp-server/src/lib/tool-registry';
import { registerComplianceTools } from '@tapestrai/mcp-server/src/tools/compliance-tools';
import { registerDocumentTools } from '@tapestrai/mcp-server/src/tools/document-tools';
import { registerDomainTools } from '@tapestrai/mcp-server/src/tools/domain-tools';
import { registerDqCheckTools } from '@tapestrai/mcp-server/src/tools/dq-check-tools';
import { registerDQTools } from '@tapestrai/mcp-server/src/tools/dq-tools';
import { registerImportMapTools } from '@tapestrai/mcp-server/src/tools/import-map-tools';
import { registerLineageTools } from '@tapestrai/mcp-server/src/tools/lineage-tools';
import { registerListTools } from '@tapestrai/mcp-server/src/tools/list-tools';
import { registerNarrativeTools } from '@tapestrai/mcp-server/src/tools/narrative-tools';
import { registerOverrideTools } from '@tapestrai/mcp-server/src/tools/override-tools';
import { registerPositionFileTools } from '@tapestrai/mcp-server/src/tools/position-file-tools';
import { registerQueryTools } from '@tapestrai/mcp-server/src/tools/query-data';
import { registerRecTools } from '@tapestrai/mcp-server/src/tools/rec-tools';
import { registerSelectionTools } from '@tapestrai/mcp-server/src/tools/selection-tools';
import { registerReportingTools } from '@tapestrai/mcp-server/src/tools/reporting-tools';
import { registerSpecialistTools } from '@tapestrai/mcp-server/src/tools/specialist-tools';
import { isReadTool } from '@tapestrai/graphql/src/lib/workflow-graph';
import { authenticate } from '@/lib/chat-server';

/**
 * The tools a workflow step can use, for the workflow editor. Nothing is run
 * here: the registry is only asked what it holds. Keep the list of register
 * calls the same as packages/worker/src/workflow/tools.ts, which runs them.
 */

// The registry's client is never used: this route only lists.
const registry = new ToolRegistry(null as unknown as SupabaseClient);
registerDomainTools(registry);
registerLineageTools(registry);
registerOverrideTools(registry);
registerDQTools(registry);
registerImportMapTools(registry);
registerPositionFileTools(registry);
registerSpecialistTools(registry);
registerComplianceTools(registry);
registerReportingTools(registry);
registerQueryTools(registry);
registerNarrativeTools(registry);
registerListTools(registry);
registerDqCheckTools(registry);
registerRecTools(registry);
registerSelectionTools(registry);
registerDocumentTools(registry);

interface Listed {
  name: string;
  description: string;
  inputSchema?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
}

export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: 'Sign in to read the tool list.' }, { status: 401 });
  const tools = (registry.listTools() as Listed[])
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      readOnly: isReadTool(tool.name),
      args: Object.entries(tool.inputSchema?.properties || {}).map(([name, property]) => ({
        name,
        type: String(property.type || 'string'),
        description: property.description || '',
        required: (tool.inputSchema?.required || []).includes(name),
      })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ tools });
}
