import { JSONSchema7 } from 'json-schema';
import { SupabaseClient } from '@supabase/supabase-js';

export interface ToolDefinition {
  name: string;
  description: string;
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
