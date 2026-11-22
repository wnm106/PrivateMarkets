import { JSONSchema7 } from 'json-schema';
import { SupabaseClient } from '@supabase/supabase-js';

export type ToolCategory = 
  | 'domain-read'        // Read entities, attributes, templates
  | 'domain-write'       // Create/update entities, relationships
  | 'domain-admin'       // Create domain types, attributes, templates
  | 'lineage'            // Lineage and temporal queries
  | 'override'           // Manual overrides
  | 'dq'                 // Data quality rules and exceptions (read and resolve)
  | 'dq-admin'           // Creating data quality rules
  | 'import'             // Import map tools
  | 'compliance'         // Compliance rules
  | 'reporting'          // Dashboard / narrative design
  | 'narrative'          // Running narratives: evidence, composing, saving runs
  | 'workflow'           // Finding and starting workflows
  | 'intersection'       // Intersection tools
  | 'reconciliation'     // Fund close: NAV, position, and cash reconciliation
  | 'external';          // The client's own MCP servers, and remembering ids in those systems

/**
 * What calling a tool does, so who may call it is decided from data, not from its name.
 *   read   changes nothing.
 *   stage  writes only drafts and staging (a load session, a staged batch, a narrative run being
 *          written, an evaluation run): nothing a live record, rule or setting reads.
 *   write  changes live records, rules or settings. The assistant never runs one itself: the chat
 *          holds the call for the person to confirm (apps/web/lib/held-actions.ts).
 * Left out, a tool named like a read (get_, list_, search_ ...) is read and any other is write.
 */
export type ToolEffect = 'read' | 'stage' | 'write';

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  effect?: ToolEffect;
  inputSchema: JSONSchema7;
  execute: (args: Record<string, any>, supabase: SupabaseClient) => Promise<ToolExecutionResult>;
}

export interface ToolExecutionResult {
  [key: string]: any;
}

export interface DomainQueryArgs {
  entityId?: string;
  entityCode?: string;
  asOfDate?: string;
  filter?: Record<string, any>;
  first?: number;
  after?: string;
}

export interface LineageQueryArgs {
  entityId: string;
  attributeCode?: string;
  asOfDate?: string;
}

export interface OverrideArgs {
  entityId: string;
  attributeCode: string;
  value: string;
  validFrom: string;
  overrideReason: string;
}

export interface DQExceptionArgs {
  exceptionId?: string;
  status?: string;
  severity?: string;
  first?: number;
}
