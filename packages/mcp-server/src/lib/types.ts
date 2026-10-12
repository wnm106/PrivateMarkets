import { JSONSchema7 } from 'json-schema';
import { SupabaseClient } from '@supabase/supabase-js';

export type ToolCategory = 
  | 'domain-read'        // Read entities, attributes, templates
  | 'domain-write'       // Create/update entities, relationships
  | 'domain-admin'       // Create domain types, attributes, templates
  | 'lineage'            // Lineage and temporal queries
  | 'override'           // Manual overrides
  | 'dq'                 // Data quality rules and exceptions
  | 'import'             // Import map tools
  | 'compliance'         // Compliance rules
  | 'reporting'          // Dashboard / narrative design
  | 'intersection';      // Intersection tools

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
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
