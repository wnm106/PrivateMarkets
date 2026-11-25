import type { ToolCategory } from './types';

/**
 * The assistant tool groups a client can be licensed for. A group is a tool
 * category, so a new tool joins its group's license with no change here.
 * Plain data: the admin screen imports it.
 */
export const TOOL_GROUPS: Record<ToolCategory, { name: string; description: string }> = {
  'domain-read': { name: 'Read records', description: 'Find and read entities, attributes and relationships. Most other groups need it.' },
  'domain-write': { name: 'Change records', description: 'Create and update entities and relationships, always on a person\'s confirm.' },
  'domain-admin': { name: 'Data model', description: 'Create entity types, attributes and templates.' },
  lineage: { name: 'Lineage and history', description: 'Where a value came from and what was known when.' },
  override: { name: 'Overrides', description: 'Manual overrides of golden values.' },
  dq: { name: 'Data quality', description: 'Read and resolve data quality exceptions.' },
  'dq-admin': { name: 'Data quality rules', description: 'Write data quality rules.' },
  import: { name: 'Data onboarding', description: 'The data specialist: read a file, build a source map, load it.' },
  compliance: { name: 'Compliance and borrowers', description: 'Compliance rules, covenants, borrower financials and certificates.' },
  reporting: { name: 'Reporting design', description: 'Design dashboards and narratives.' },
  narrative: { name: 'Narratives', description: 'Gather evidence and draft investor commentary.' },
  workflow: { name: 'Workflows', description: 'Find a workflow and start a run from the assistant.' },
  intersection: { name: 'Composite entities', description: 'Build and read composite entities.' },
  reconciliation: { name: 'Reconciliation', description: 'NAV, position and cash reconciliation, and filed reports.' },
  external: { name: 'Client connections', description: 'The client\'s own MCP servers, and ids in those systems.' },
};

export const TOOL_GROUP_CODES = Object.keys(TOOL_GROUPS) as ToolCategory[];
