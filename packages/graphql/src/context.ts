import { GraphQLResolveInfo } from 'graphql';
import { SupabaseClient } from '@supabase/supabase-js';
import DataLoader from 'dataloader';

export interface Context {
  /** Scoped to the caller's own JWT -- RLS applies. Use this for all normal data access. */
  supabase: SupabaseClient;
  /**
   * Service-role client (bypasses RLS). Only `null` if SUPABASE_SERVICE_ROLE_KEY
   * isn't configured. Reserve for specific privileged/audited operations (e.g.
   * `supabase.auth.admin.*` user invitation) -- never use for normal row access.
   */
  supabaseAdmin: SupabaseClient | null;
  user: User | null;
  requestId: string;
  loaders: DataLoaders;
}

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'steward' | 'ops' | 'governance' | 'readonly';
  metadata?: Record<string, any>;
}

export interface DataLoaders {
  entityLoader: DataLoader<string, MasterEntity>;
  attributeLoader: DataLoader<string, AttributeDefinition>;
  sourceLoader: DataLoader<string, SourceRegistry>;
  goldenRecordLoader: DataLoader<string, GoldenRecord>;
}

export interface MasterEntity {
  id: string;
  entity_code: string;
  domain_code: string;
  template_id?: string;
  entity_name: string;
  description?: string;
  is_active: boolean;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
  created_by?: string;
  updated_by?: string;
}

export interface AttributeDefinition {
  id: string;
  attribute_code: string;
  attribute_name: string;
  data_type: string;
  description?: string;
  unit_of_measure?: string;
  is_required: boolean;
  is_multi_valued: boolean;
  reference_domain_code?: string;
  default_precedence_rank: number;
  // Aggregation and precision fields
  aggregation_type?: 'NONE' | 'MIN' | 'MAX' | 'SUM' | 'AVG' | 'WEIGHTED_AVG';
  weight_attribute_code?: string;
  numeric_precision?: number;
}

export interface SourceRegistry {
  id: string;
  source_code: string;
  source_name: string;
  source_type: string;
  vendor_name?: string;
  precedence_rank: number;
  is_active: boolean;
}

export interface GoldenRecord {
  id: string;
  entity_id: string;
  attribute_id: string;
  source_id: string;
  golden_value?: string;
  golden_value_jsonb?: any;
  golden_value_numeric?: number;
  golden_value_date?: string;
  golden_value_timestamp?: string;
  golden_value_boolean?: boolean;
  valid_from: string;
  valid_to: string;
  system_from: string;
  system_to: string;
  precedence_rank: number;
  confidence_score?: number;
  is_manual_override: boolean;
  override_reason?: string;
  competing_values: any[];
  resolution_rule_applied?: string;
}

export interface TemporalContext {
  asOfDate?: string;
  knowledgeDate?: string;
}

export interface PaginationArgs {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

export interface FilterArgs {
  [key: string]: any;
}

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: Context,
  info: GraphQLResolveInfo
) => Promise<TResult> | TResult;
