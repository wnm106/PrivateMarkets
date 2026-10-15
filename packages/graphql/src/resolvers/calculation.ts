import { Context } from '../context';
import { listExpressionFunctions } from '../lib/expression-library';

export interface CalculatedAttributeState {
  entityId: string;
  attributeCode: string;
  dirty: boolean;
  status: string | null;
  windowStart: string | null;
  windowEnd: string | null;
}

function mapState(row: {
  entity_id: string;
  attribute_code: string;
  dirty: boolean;
  status: string | null;
  window_start: string | null;
  window_end: string | null;
}): CalculatedAttributeState {
  return {
    entityId: row.entity_id,
    attributeCode: row.attribute_code,
    dirty: Boolean(row.dirty),
    status: row.status,
    windowStart: row.window_start,
    windowEnd: row.window_end,
  };
}

export async function loadCalculatedAttributeStates(
  context: Context,
  entityId: string,
): Promise<CalculatedAttributeState[]> {
  const { data, error } = await context.supabase.rpc('calculated_attribute_states', {
    p_entity_id: entityId,
  });
  if (error) throw error;
  return (data || []).map(mapState);
}

export async function dirtyAttributeCodes(context: Context, entityId: string): Promise<Set<string>> {
  const states = await loadCalculatedAttributeStates(context, entityId);
  return new Set(states.filter((state) => state.dirty).map((state) => state.attributeCode));
}

function mapDefinition(row: {
  id: string;
  attribute_code: string;
  domain_code: string;
  calc_kind: string;
  evaluation_mode: string;
  time_impact: string;
  output_grain: string;
  expression: unknown;
  aggregate_fn: string | null;
  series_fn: string | null;
  derivation_dependencies: string[] | null;
  inputs: Array<{
    inputRole: string;
    attributeCode: string;
    traversal: string;
    relationshipCodes: string[] | null;
  }> | null;
}) {
  return {
    id: row.id,
    attributeCode: row.attribute_code,
    domainCode: row.domain_code,
    calcKind: row.calc_kind,
    evaluationMode: row.evaluation_mode,
    timeImpact: row.time_impact,
    outputGrain: row.output_grain,
    expression: row.expression,
    aggregateFn: row.aggregate_fn,
    seriesFn: row.series_fn,
    derivationDependencies: row.derivation_dependencies || [],
    inputs: (row.inputs || []).map((input) => ({
      inputRole: input.inputRole,
      attributeCode: input.attributeCode,
      traversal: input.traversal,
      relationshipCodes: input.relationshipCodes || [],
    })),
  };
}

function toExpressionFunction(row: {
  id: string;
  code: string;
  name: string;
  category: string;
  returnType: string;
  description: string;
  signature: string;
  example: unknown;
  callable: boolean;
}) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    returnType: row.returnType,
    description: row.description,
    signature: row.signature,
    example: row.example,
    callable: row.callable,
  };
}

export const calculationResolvers = {
  Query: {
    calcDefinitions: async (_: unknown, __: unknown, context: Context) => {
      const { data, error } = await context.supabase
        .from('calc_definitions')
        .select('*')
        .order('attribute_code');
      if (error) throw error;
      return (data || []).map(mapDefinition);
    },
    calculatedAttributeStates: async (
      _: unknown,
      args: { entityId: string },
      context: Context,
    ) => loadCalculatedAttributeStates(context, args.entityId),
    expressionFunctions: async (
      _: unknown,
      args: { category?: string | null },
      context: Context,
    ) => {
      const filter = args.category?.trim().toUpperCase();
      let query = context.supabase.from('expression_functions').select('*').order('sort_order');
      if (filter) query = query.eq('category', filter);
      const { data, error } = await query;
      if (error) {
        const missing = error.code === '42P01'
          || error.code === 'PGRST205'
          || /expression_functions/i.test(error.message || '');
        if (!missing) throw error;
        return listExpressionFunctions(filter).map(toExpressionFunction);
      }
      return (data || []).map((row) => toExpressionFunction({
        id: row.id,
        code: row.function_code,
        name: row.function_name,
        category: row.category,
        returnType: row.return_type,
        description: row.description,
        signature: row.signature,
        example: row.example,
        callable: row.callable,
      }));
    },
  },
  Mutation: {
    processCalculatedAttributes: async (
      _: unknown,
      args: { limit?: number | null },
      context: Context,
    ) => {
      const { data, error } = await context.supabase.rpc('process_calculated_attributes', {
        p_limit: args.limit ?? 500,
      });
      if (error) throw error;
      const result = (data || {}) as { processed?: number; failed?: number; pending?: number };
      return {
        processed: result.processed ?? 0,
        failed: result.failed ?? 0,
        pending: result.pending ?? 0,
      };
    },
  },
  Entity: {
    calculatedAttributes: async (entity: { id: string }, _: unknown, context: Context) =>
      loadCalculatedAttributeStates(context, entity.id),
  },
};
