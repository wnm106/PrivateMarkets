import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Context for evaluating derived attributes
 */
export interface DerivationContext {
  entityId: string;
  asOfDate: string;
  supabase: SupabaseClient;
}

/**
 * Result of a derivation evaluation
 */
export interface DerivationResult {
  value: any;
  dependencies: string[];
  derivationType: string;
  evaluatedAt: string;
}

/**
 * FormulaEngine - Evaluates derived attributes based on their formulas
 * 
 * Supports four derivation types:
 * - SIMPLE: Direct calculation from other attributes
 * - AGGREGATE: Sum/avg/count across related entities
 * - LOOKUP: Fetch from related entity
 * - CUSTOM: Complex formula with SQL/JS expression
 */
export class FormulaEngine {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Evaluate a single derived attribute for a given entity
   */
  async evaluateDerivation(
    attributeCode: string,
    context: DerivationContext
  ): Promise<DerivationResult | null> {
    // Get attribute definition
    const { data: attr, error } = await this.supabase
      .from('attribute_register')
      .select('*')
      .eq('attribute_code', attributeCode)
      .eq('is_derived', true)
      .single();

    if (error || !attr) {
      throw new Error(`Derived attribute not found: ${attributeCode}`);
    }

    const dependencies = attr.derivation_dependencies || [];

    // Execute based on derivation type
    switch (attr.derivation_type) {
      case 'SIMPLE':
        return await this.evaluateSimple(attr, context);
      case 'AGGREGATE':
        return await this.evaluateAggregate(attr, context);
      case 'LOOKUP':
        return await this.evaluateLookup(attr, context);
      case 'CUSTOM':
        return await this.evaluateCustom(attr, context);
      default:
        throw new Error(`Unknown derivation type: ${attr.derivation_type}`);
    }
  }

  /**
   * Evaluate a simple derivation formula
   */
  private async evaluateSimple(attr: any, context: DerivationContext): Promise<DerivationResult> {
    const { data, error } = await this.supabase.rpc('evaluate_simple_formula', {
      p_entity_id: context.entityId,
      p_formula: attr.derivation_formula,
      p_as_of_date: context.asOfDate,
    });

    if (error) {
      console.error('Error evaluating simple formula:', error);
      throw new Error(`Formula evaluation failed: ${error.message}`);
    }

    return {
      value: data,
      dependencies: attr.derivation_dependencies || [],
      derivationType: 'SIMPLE',
      evaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * Evaluate an aggregate derivation formula
   */
  private async evaluateAggregate(attr: any, context: DerivationContext): Promise<DerivationResult> {
    const { data, error } = await this.supabase.rpc('evaluate_aggregate_formula', {
      p_entity_id: context.entityId,
      p_formula: attr.derivation_formula,
      p_as_of_date: context.asOfDate,
    });

    if (error) {
      console.error('Error evaluating aggregate formula:', error);
      throw new Error(`Formula evaluation failed: ${error.message}`);
    }

    return {
      value: data,
      dependencies: attr.derivation_dependencies || [],
      derivationType: 'AGGREGATE',
      evaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * Evaluate a lookup derivation formula
   */
  private async evaluateLookup(attr: any, context: DerivationContext): Promise<DerivationResult> {
    const { data, error } = await this.supabase.rpc('evaluate_lookup_formula', {
      p_entity_id: context.entityId,
      p_formula: attr.derivation_formula,
      p_as_of_date: context.asOfDate,
    });

    if (error) {
      console.error('Error evaluating lookup formula:', error);
      throw new Error(`Formula evaluation failed: ${error.message}`);
    }

    return {
      value: data,
      dependencies: attr.derivation_dependencies || [],
      derivationType: 'LOOKUP',
      evaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * Evaluate a custom derivation formula
   */
  private async evaluateCustom(attr: any, context: DerivationContext): Promise<DerivationResult> {
    const { data, error } = await this.supabase.rpc('evaluate_custom_formula', {
      p_entity_id: context.entityId,
      p_formula: attr.derivation_formula,
      p_as_of_date: context.asOfDate,
    });

    if (error) {
      console.error('Error evaluating custom formula:', error);
      throw new Error(`Formula evaluation failed: ${error.message}`);
    }

    return {
      value: data,
      dependencies: attr.derivation_dependencies || [],
      derivationType: 'CUSTOM',
      evaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * Batch evaluate multiple derived attributes for an entity
   * Handles dependency ordering via topological sort
   */
  async evaluateBatch(
    attributeCodes: string[],
    context: DerivationContext
  ): Promise<Map<string, any>> {
    const results = new Map<string, any>();

    // Topological sort to handle dependencies
    const sorted = await this.topologicalSort(attributeCodes);

    // Evaluate in dependency order
    for (const code of sorted) {
      try {
        const result = await this.evaluateDerivation(code, context);
        if (result) {
          results.set(code, result.value);
        }
      } catch (error) {
        console.error(`Failed to evaluate ${code}:`, error);
        // Continue with other attributes even if one fails
        results.set(code, null);
      }
    }

    return results;
  }

  /**
   * Sort attributes by dependency order using Kahn's algorithm
   * Ensures dependencies are evaluated before dependents
   */
  private async topologicalSort(attributeCodes: string[]): Promise<string[]> {
    const { data: attrs, error } = await this.supabase
      .from('attribute_register')
      .select('attribute_code, derivation_dependencies')
      .in('attribute_code', attributeCodes);

    if (error || !attrs) {
      console.warn('Could not fetch attributes for sorting:', error);
      return attributeCodes;
    }

    const graph = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    // Initialize graph and in-degree map
    for (const attr of attrs) {
      graph.set(attr.attribute_code, attr.derivation_dependencies || []);
      inDegree.set(attr.attribute_code, 0);
    }

    // Calculate in-degrees
    for (const attr of attrs) {
      for (const dep of attr.derivation_dependencies || []) {
        if (inDegree.has(dep)) {
          inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
        }
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [code, degree] of inDegree) {
      if (degree === 0) queue.push(code);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const code = queue.shift()!;
      sorted.push(code);

      for (const dep of graph.get(code) || []) {
        if (inDegree.has(dep)) {
          inDegree.set(dep, inDegree.get(dep)! - 1);
          if (inDegree.get(dep) === 0) {
            queue.push(dep);
          }
        }
      }
    }

    // If we couldn't sort all attributes, there's a cycle
    if (sorted.length !== attrs.length) {
      console.warn('Circular dependency detected in derived attributes');
      // Return original order as fallback
      return attributeCodes;
    }

    return sorted;
  }

  /**
   * Validate that all dependencies for an attribute exist
   */
  async validateDependencies(attributeCode: string): Promise<{
    valid: boolean;
    missing: string[];
  }> {
    const { data: attr, error } = await this.supabase
      .from('attribute_register')
      .select('derivation_dependencies')
      .eq('attribute_code', attributeCode)
      .single();

    if (error || !attr) {
      return { valid: false, missing: [attributeCode] };
    }

    const dependencies = attr.derivation_dependencies || [];
    if (dependencies.length === 0) {
      return { valid: true, missing: [] };
    }

    const { data: existingAttrs } = await this.supabase
      .from('attribute_register')
      .select('attribute_code')
      .in('attribute_code', dependencies);

    const existingCodes = new Set(existingAttrs?.map(a => a.attribute_code) || []);
    const missing = dependencies.filter((dep: string) => !existingCodes.has(dep));

    return {
      valid: missing.length === 0,
      missing,
    };
  }

  /**
   * Get all derived attributes for a template
   */
  async getDerivedAttributesForTemplate(templateId: string): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('template_attribute_assignments')
      .select(`
        attribute_register!inner(
          attribute_code,
          is_derived
        )
      `)
      .eq('template_id', templateId)
      .eq('attribute_register.is_derived', true);

    if (error || !data) {
      console.error('Error fetching derived attributes for template:', error);
      return [];
    }

    return data
      .map((ta: any) => ta.attribute_register?.attribute_code)
      .filter((code: string | null) => code !== null);
  }

  /**
   * Test a formula without saving it
   */
  async testFormula(
    formula: string,
    derivationType: string,
    entityId: string,
    asOfDate: string
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    try {
      const rpcFunction = this.getRpcFunctionForType(derivationType);
      
      const { data, error } = await this.supabase.rpc(rpcFunction, {
        p_entity_id: entityId,
        p_formula: formula,
        p_as_of_date: asOfDate,
      });

      if (error) {
        return { success: false, error: error.message };
      }

      return { success: true, result: data };
    } catch (err) {
      return { 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      };
    }
  }

  /**
   * Get the appropriate RPC function name for a derivation type
   */
  private getRpcFunctionForType(derivationType: string): string {
    switch (derivationType) {
      case 'SIMPLE':
        return 'evaluate_simple_formula';
      case 'AGGREGATE':
        return 'evaluate_aggregate_formula';
      case 'LOOKUP':
        return 'evaluate_lookup_formula';
      case 'CUSTOM':
        return 'evaluate_custom_formula';
      default:
        throw new Error(`Unknown derivation type: ${derivationType}`);
    }
  }
}

/**
 * Singleton instance for convenience
 */
let formulaEngineInstance: FormulaEngine | null = null;

export function getFormulaEngine(supabase: SupabaseClient): FormulaEngine {
  if (!formulaEngineInstance) {
    formulaEngineInstance = new FormulaEngine(supabase);
  }
  return formulaEngineInstance;
}
