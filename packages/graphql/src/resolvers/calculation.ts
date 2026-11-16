import { Context } from '../context';
import { planAggregateUpdate, type AggregateBinding } from '../lib/calc-aggregate';
import { listExpressionFunctions } from '../lib/expression-library';
import { knowledgeCutoff } from '../lib/on-read-values';

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

function missingCalculatedStateRpc(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const code = String(record.code || '');
  const message = String(record.message || '');
  return code === 'PGRST202' || /could not find the function/i.test(message) || /calculated_attribute_states/i.test(message);
}

export async function dirtyAttributeCodes(context: Context, entityId: string): Promise<Set<string>> {
  try {
    const states = await loadCalculatedAttributeStates(context, entityId);
    return new Set(states.filter((state) => state.dirty).map((state) => state.attributeCode));
  } catch (error) {
    // Lineage must still resolve when the calculated-attribute migration is not applied.
    if (missingCalculatedStateRpc(error)) return new Set();
    throw error;
  }
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

function calcError(message: string) {
  return { field: 'expression', message, code: 'CALC_EXPRESSION' };
}

interface OperandBinding {
  attributeCode: string;
  traversal: 'SELF' | 'UP' | 'DOWN';
  relationshipCodes: string[];
}

function operandBindings(raw: unknown): Map<string, OperandBinding> | null {
  if (!Array.isArray(raw)) return null;
  const bindings = new Map<string, OperandBinding>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { attributeCode?: unknown; traversal?: unknown; relationshipCodes?: unknown };
    const attributeCode = String(record.attributeCode || '').trim();
    const traversal = String(record.traversal || 'SELF').toUpperCase();
    if (!attributeCode || !['SELF', 'UP', 'DOWN'].includes(traversal)) continue;
    const relationshipCodes = Array.isArray(record.relationshipCodes)
      ? record.relationshipCodes.map((code) => String(code || '').trim()).filter(Boolean)
      : [];
    bindings.set(attributeCode, {
      attributeCode,
      traversal: traversal as OperandBinding['traversal'],
      relationshipCodes: traversal === 'SELF' ? [] : relationshipCodes,
    });
  }
  return bindings;
}

function asBreakdown(value: unknown) {
  if (value == null) return null;
  const row = typeof value === 'string' ? JSON.parse(value) : value;
  if (!row || typeof row !== 'object') return null;
  const breakdown = row as Record<string, unknown>;
  return {
    ...breakdown,
    truncated: Boolean(breakdown.truncated),
    components: Array.isArray(breakdown.components) ? breakdown.components : [],
  };
}

function normalizeExpression(value: unknown): Record<string, unknown> {
  const expr = typeof value === 'string' ? JSON.parse(value) : value;
  expressionRefs(expr);
  return expr as Record<string, unknown>;
}

function expressionRefs(expr: unknown, found: string[] = []): string[] {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) throw new Error('Expression must be an object');
  const node = expr as Record<string, unknown>;
  if (typeof node.ref === 'string') {
    found.push(node.ref);
    return found;
  }
  if ('const' in node) return found;
  if (typeof node.op === 'string' && Array.isArray(node.args)) {
    if (node.op === 'neg' && node.args.length !== 1) throw new Error('neg expects one argument');
    if (node.op !== 'neg' && !['add', 'sub', 'mul', 'div'].includes(node.op)) throw new Error(`Unknown operator ${node.op}`);
    if (node.op !== 'neg' && node.args.length !== 2) throw new Error(`${node.op} expects two arguments`);
    node.args.forEach((arg) => expressionRefs(arg, found));
    return found;
  }
  if (typeof node.fn === 'string' && Array.isArray(node.args)) {
    node.args.forEach((arg) => expressionRefs(arg, found));
    return found;
  }
  throw new Error('Expression must use ref, const, op, or fn');
}

interface StoredCalcInput {
  id: string;
  input_role: string;
  attribute_code: string;
  traversal: string;
  relationship_codes: string[] | null;
}

function bindingCode(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  return String((raw as { attributeCode?: unknown }).attributeCode || '').trim();
}

function bindingPath(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const codes = (raw as { relationshipCodes?: unknown }).relationshipCodes;
  if (!Array.isArray(codes)) return [];
  return codes.map((code) => String(code || '').trim()).filter(Boolean);
}

async function keepCalcInput(
  db: { from: (table: string) => any },
  definitionId: string,
  rows: StoredCalcInput[],
  role: string,
  binding: AggregateBinding,
  ordinal: number,
) {
  const [keep, ...extra] = rows;
  if (extra.length) {
    const { error } = await db.from('calc_inputs').delete().in('id', extra.map((row) => row.id));
    if (error) throw error;
  }
  if (!keep) {
    const { error } = await db.from('calc_inputs').insert({
      calc_definition_id: definitionId,
      input_role: role,
      attribute_code: binding.attributeCode,
      traversal: binding.traversal,
      relationship_codes: binding.relationshipCodes,
      ordinal,
    });
    if (error) throw error;
    return;
  }
  const samePath = keep.traversal === binding.traversal
    && JSON.stringify(keep.relationship_codes || []) === JSON.stringify(binding.relationshipCodes);
  if (keep.attribute_code === binding.attributeCode && samePath) return;
  const { error } = await db.from('calc_inputs').update({
    attribute_code: binding.attributeCode,
    traversal: binding.traversal,
    relationship_codes: binding.relationshipCodes,
  }).eq('id', keep.id);
  if (error) throw error;
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
    calcBreakdown: async (
      _: unknown,
      args: { entityId: string; attributeCode: string; asOfDate?: string | null; knowledgeDate?: string | null },
      context: Context,
    ) => {
      const { data, error } = await context.supabase.rpc('explain_calc', {
        p_entity_id: args.entityId,
        p_attribute_code: args.attributeCode,
        p_as_of: args.asOfDate || null,
        p_knowledge: knowledgeCutoff(args.knowledgeDate),
      });
      if (error) {
        const missing = error.code === 'PGRST202'
          || /could not find the function/i.test(error.message || '')
          || /explain_calc/i.test(error.message || '');
        if (missing) return null;
        throw error;
      }
      return asBreakdown(data);
    },
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

    updateCalcExpression: async (
      _: unknown,
      args: { id: string; expression: unknown; operands?: unknown },
      context: Context,
    ) => {
      try {
        const expression = normalizeExpression(args.expression);
        const refs = [...new Set(expressionRefs(expression))];
        const requested = operandBindings(args.operands);
        const db = context.supabase.schema('metadata_register');
        const { data: definition, error: definitionError } = await db
          .from('calc_definitions')
          .select('id, calc_kind, evaluation_mode')
          .eq('id', args.id)
          .maybeSingle();
        if (definitionError) throw definitionError;
        if (!definition) return { definition: null, errors: [calcError('Calculation was not found')] };
        if (definition.calc_kind !== 'EXPRESSION') {
          return { definition: null, errors: [calcError('Only expression calculations can be edited here')] };
        }

        const { data: inputs, error: inputError } = await db
          .from('calc_inputs')
          .select('id, input_role, attribute_code, ordinal, traversal, relationship_codes')
          .eq('calc_definition_id', args.id);
        if (inputError) throw inputError;
        const operands = (inputs || []).filter((input) => input.input_role === 'OPERAND');
        const known = new Map(operands.map((input) => [input.attribute_code, input]));

        if (refs.length) {
          const { data: attributes, error: attributeError } = await db
            .from('attribute_register')
            .select('attribute_code')
            .in('attribute_code', refs);
          if (attributeError) throw attributeError;
          const found = new Set((attributes || []).map((row) => row.attribute_code));
          const missing = refs.find((ref) => !found.has(ref));
          if (missing) return { definition: null, errors: [calcError(`Attribute ${missing} does not exist`)] };
        }

        const resolved = refs.map((ref) => {
          const binding = requested?.get(ref);
          const existing = known.get(ref);
          const traversal = binding?.traversal || existing?.traversal || 'SELF';
          const relationshipCodes = binding
            ? binding.relationshipCodes
            : (existing?.relationship_codes || []);
          return { ref, traversal, relationshipCodes, existing };
        });
        const unbound = resolved.find((item) => item.traversal !== 'SELF' && item.relationshipCodes.length === 0);
        if (unbound) return { definition: null, errors: [calcError(`Choose the entity ${unbound.ref} is read from`)] };
        const codes = [...new Set(resolved.flatMap((item) => item.relationshipCodes))];
        if (codes.length) {
          const { data: types, error: typeError } = await db
            .from('relationship_types')
            .select('relationship_code')
            .in('relationship_code', codes);
          if (typeError) throw typeError;
          const foundCodes = new Set((types || []).map((row) => row.relationship_code));
          const missingCode = codes.find((code) => !foundCodes.has(code));
          if (missingCode) return { definition: null, errors: [calcError(`Relationship ${missingCode} does not exist`)] };
        }

        const nextOrdinal = operands.reduce((max, input) => Math.max(max, input.ordinal || 0), 0) + 1;
        let added = 0;
        for (const item of resolved) {
          if (item.existing) {
            const samePath = item.existing.traversal === item.traversal
              && JSON.stringify(item.existing.relationship_codes || []) === JSON.stringify(item.relationshipCodes);
            if (!samePath) {
              const { error } = await db.from('calc_inputs').update({
                traversal: item.traversal,
                relationship_codes: item.relationshipCodes,
              }).eq('id', item.existing.id);
              if (error) throw error;
            }
          } else {
            const { error } = await db.from('calc_inputs').insert({
              calc_definition_id: args.id,
              input_role: 'OPERAND',
              attribute_code: item.ref,
              traversal: item.traversal,
              relationship_codes: item.relationshipCodes,
              ordinal: nextOrdinal + added,
            });
            added += 1;
            if (error) throw error;
          }
        }

        const { error: updateError } = await db
          .from('calc_definitions')
          .update({ expression, updated_at: new Date().toISOString() })
          .eq('id', args.id);
        if (updateError) throw updateError;

        const removed = operands.filter((input) => !refs.includes(input.attribute_code)).map((input) => input.id);
        if (removed.length) {
          const { error } = await db.from('calc_inputs').delete().in('id', removed);
          if (error) throw error;
        }

        const { data: saved, error: savedError } = await context.supabase
          .from('calc_definitions')
          .select('*')
          .eq('id', args.id)
          .single();
        if (savedError) throw savedError;
        return { definition: mapDefinition(saved), errors: [] };
      } catch (error: any) {
        return { definition: null, errors: [calcError(error?.message || 'Could not save the expression')] };
      }
    },

    updateCalcAggregate: async (
      _: unknown,
      args: { id: string; aggregateFn: string; measure: unknown; weightAttributeCode?: string | null },
      context: Context,
    ) => {
      try {
        const db = context.supabase.schema('metadata_register');
        const { data: definition, error: definitionError } = await db
          .from('calc_definitions')
          .select('id, calc_kind, domain_code, attribute_id')
          .eq('id', args.id)
          .maybeSingle();
        if (definitionError) throw definitionError;
        if (!definition) return { definition: null, errors: [calcError('Calculation was not found')] };
        if (definition.calc_kind !== 'AGGREGATE') {
          return { definition: null, errors: [calcError('Only aggregate calculations can be edited here')] };
        }

        const { data: own, error: ownError } = await db
          .from('attribute_register')
          .select('attribute_code')
          .eq('id', definition.attribute_id)
          .maybeSingle();
        if (ownError) throw ownError;
        if (!own?.attribute_code) return { definition: null, errors: [calcError('Calculation was not found')] };

        const requestedCodes = new Set<string>([own.attribute_code]);
        const measureCode = bindingCode(args.measure);
        if (measureCode) requestedCodes.add(measureCode);
        const weightCode = String(args.weightAttributeCode || '').trim();
        if (weightCode) requestedCodes.add(weightCode);
        const { data: attributes, error: attributeError } = await db
          .from('attribute_register')
          .select('attribute_code, domain_code, data_type')
          .in('attribute_code', [...requestedCodes]);
        if (attributeError) throw attributeError;

        const relationshipCodes = bindingPath(args.measure);
        const { data: relationships, error: relationshipError } = relationshipCodes.length
          ? await db
            .from('relationship_types')
            .select('relationship_code, parent_domain_code, child_domain_code')
            .in('relationship_code', relationshipCodes)
          : { data: [], error: null };
        if (relationshipError) throw relationshipError;

        const plan = planAggregateUpdate(args, {
          ownAttributeCode: own.attribute_code,
          ownDomainCode: definition.domain_code,
          attributes: (attributes || []).map((row) => ({
            attributeCode: row.attribute_code,
            domainCode: row.domain_code,
            dataType: row.data_type,
          })),
          relationships: (relationships || []).map((row) => ({
            relationshipCode: row.relationship_code,
            parentDomainCode: row.parent_domain_code,
            childDomainCode: row.child_domain_code,
          })),
        });

        const { data: inputs, error: inputError } = await db
          .from('calc_inputs')
          .select('id, input_role, attribute_code, ordinal, traversal, relationship_codes')
          .eq('calc_definition_id', args.id);
        if (inputError) throw inputError;
        const rows = (inputs || []) as StoredCalcInput[];
        await keepCalcInput(db, args.id, rows.filter((row) => row.input_role === 'MEASURE'), 'MEASURE', plan.measure, 1);
        if (plan.weight) {
          await keepCalcInput(db, args.id, rows.filter((row) => row.input_role === 'WEIGHT'), 'WEIGHT', plan.weight, 2);
        }

        const { error: updateError } = await db
          .from('calc_definitions')
          .update({ aggregate_fn: plan.aggregateFn, updated_at: new Date().toISOString() })
          .eq('id', args.id);
        if (updateError) throw updateError;

        if (!plan.weight) {
          const weights = rows.filter((row) => row.input_role === 'WEIGHT').map((row) => row.id);
          if (weights.length) {
            const { error } = await db.from('calc_inputs').delete().in('id', weights);
            if (error) throw error;
          }
        }

        const { data: saved, error: savedError } = await context.supabase
          .from('calc_definitions')
          .select('*')
          .eq('id', args.id)
          .single();
        if (savedError) throw savedError;
        return { definition: mapDefinition(saved), errors: [] };
      } catch (error: any) {
        return { definition: null, errors: [calcError(error?.message || 'Could not save the calculation')] };
      }
    },
  },
  Entity: {
    calculatedAttributes: async (entity: { id: string }, _: unknown, context: Context) =>
      loadCalculatedAttributeStates(context, entity.id),
  },
};
