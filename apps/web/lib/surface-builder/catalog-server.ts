/**
 * Loads the platform catalog the Surface Builder reasons over, as the caller,
 * so tenancy and row security decide what they see. Server only.
 *
 * Each part loads on its own; a part that fails is recorded in `gaps` and the
 * rest still load, so one missing table does not stop an analysis.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ToolRegistry } from '@tapestrai/mcp-server/src/lib/tool-registry';
import { SKILLS } from '@tapestrai/mcp-server/src/lib/chat-skills';
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
import { registerNavReportTools } from '@tapestrai/mcp-server/src/tools/nav-report-tools';
import { registerSelectionTools } from '@tapestrai/mcp-server/src/tools/selection-tools';
import { registerReportingTools } from '@tapestrai/mcp-server/src/tools/reporting-tools';
import { registerSpecialistTools } from '@tapestrai/mcp-server/src/tools/specialist-tools';
import { isReadTool } from '@tapestrai/graphql/src/lib/workflow-graph';
import { SURFACES } from '@/lib/surface-registry';
import type { CatalogTool, PlatformCatalog } from './catalog';

// The same register calls as app/api/workflows/tools/route.ts and the worker's
// workflow tools. The registry only lists here; nothing is run.
let toolCache: CatalogTool[] | null = null;
function listTools(): CatalogTool[] {
  if (toolCache) return toolCache;
  const registry = new ToolRegistry();
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
  registerNavReportTools(registry);
  registerSelectionTools(registry);
  registerDocumentTools(registry);
  toolCache = (registry.listTools() as Array<{ name: string; description: string; inputSchema?: { properties?: Record<string, unknown> } }>)
    .map((tool) => ({
      name: tool.name,
      description: String(tool.description || ''),
      readOnly: isReadTool(tool.name),
      args: Object.keys(tool.inputSchema?.properties || {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return toolCache;
}

type Row = Record<string, any>;

const PAGE = 1000;

/** Every row of a table, a page at a time: the API caps one response at 1,000 rows. */
async function rows(supabase: SupabaseClient, table: string, gaps: string[], limit = 5000, schema?: string): Promise<Row[]> {
  const out: Row[] = [];
  const source = schema ? supabase.schema(schema) : supabase;
  for (let from = 0; from < limit; from += PAGE) {
    // Order by id so pages do not overlap or skip rows.
    const { data, error } = await source.from(table).select('*').order('id').range(from, Math.min(from + PAGE, limit) - 1);
    if (error) {
      gaps.push(`${schema ? `${schema}.` : ''}${table} could not be read: ${error.message}`);
      break;
    }
    out.push(...((data || []) as Row[]));
    if (!data || data.length < PAGE) break;
  }
  if (out.length >= limit) gaps.push(`${table} has more than ${limit} rows; only the first ${limit} were read.`);
  return out;
}

export async function loadPlatformCatalog(supabase: SupabaseClient): Promise<PlatformCatalog> {
  const gaps: string[] = [];
  const [domains, attributes, relationships, surfaces, experiences, rules, lists] = await Promise.all([
    rows(supabase, 'domain_types', gaps),
    rows(supabase, 'attribute_register', gaps, 10000),
    rows(supabase, 'relationship_types', gaps),
    rows(supabase, 'surface_definitions', gaps),
    rows(supabase, 'record_experiences', gaps),
    rows(supabase, 'rules', gaps, 2000, 'compliance'),
    rows(supabase, 'reference_lists', gaps, 2000, 'metadata_register'),
  ]);

  let tools: CatalogTool[] = [];
  try {
    tools = listTools();
  } catch (error) {
    gaps.push(`The tool registry could not be listed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    domains: domains
      .filter((row) => row.domain_code)
      .map((row) => ({ code: row.domain_code, name: row.domain_name || row.display_name || row.domain_code, parentCode: row.parent_domain_code ?? null, description: row.description ?? null })),
    attributes: attributes
      .filter((row) => row.attribute_code)
      .map((row) => ({
        code: row.attribute_code,
        name: row.attribute_name || row.attribute_code,
        dataType: row.data_type || 'TEXT',
        domainCode: row.domain_code ?? null,
        description: row.description ?? null,
        isDerived: row.is_derived === true,
        isTimeVarying: row.is_time_varying === true,
        listValues: Array.isArray(row.list_values) ? row.list_values : null,
        referenceDomainCode: row.reference_domain_code ?? null,
      })),
    relationships: relationships
      .filter((row) => row.relationship_code)
      .map((row) => ({ code: row.relationship_code, name: row.relationship_name || row.display_name || row.relationship_code, fromDomain: row.parent_domain_code ?? null, toDomain: row.child_domain_code ?? null })),
    tools,
    skills: SKILLS.map((skill) => ({ id: skill.id, name: skill.name, startsWhen: skill.startsWhen, toolContext: String(skill.toolContext), writeTools: [...(skill.writeTools || [])] })),
    surfaces: [
      ...surfaces.filter((row) => row.is_active !== false).map((row) => ({ code: row.surface_code, name: row.surface_name || row.surface_code, domainCode: row.domain_code ?? null, description: row.description ?? null, kind: 'catalog' as const })),
      ...experiences.filter((row) => row.is_active !== false).map((row) => ({ code: row.experience_code, name: row.experience_name || row.experience_code, domainCode: row.anchor_domain_code ?? null, description: row.description ?? null, kind: 'experience' as const })),
      ...SURFACES.map((entry) => ({ code: entry.manifest.code, name: entry.manifest.title || entry.manifest.code, domainCode: entry.manifest.domains?.[0] ?? null, description: entry.manifest.description ?? null, kind: 'sdk' as const })),
    ],
    complianceRules: rules
      .filter((row) => row.rule_code && row.is_active !== false)
      .map((row) => ({
        code: row.rule_code,
        name: row.rule_name || row.rule_code,
        category: row.rule_category ?? null,
        anchorDomainCode: row.anchor_domain_code ?? null,
        metadataKeys: row.metadata && typeof row.metadata === 'object' ? Object.keys(row.metadata).slice(0, 20) : [],
      })),
    referenceLists: lists
      .filter((row) => row.list_code && row.is_active !== false)
      .map((row) => ({ code: row.list_code, name: row.list_name || row.list_code, domainCode: row.domain_code ?? null })),
    gaps,
  };
}
