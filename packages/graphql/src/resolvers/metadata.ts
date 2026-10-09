import { FormulaEngine, DerivationContext } from '../lib/formula-engine';
import { SupabaseClient } from '@supabase/supabase-js';

export const metadataResolvers = {
  Query: {
    /**
     * Get all attributes, optionally filtered by domain
     */
    attributeRegister: async (_: any, args: { domainCode?: string; includeDerived?: boolean }, { supabase }: { supabase: SupabaseClient }) => {
      let query = supabase
        .from('attribute_register')
        .select('*')
        .order('attribute_code');

      // Filter by domain if specified
      if (args.domainCode) {
        query = query.eq('reference_domain_code', args.domainCode);
      }

      // Filter out derived attributes unless explicitly requested
      if (!args.includeDerived) {
        query = query.or('is_derived.eq.false,is_derived.is.null');
      }

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching attribute register:', error);
        throw new Error('Failed to fetch attributes');
      }

      return (data || []).map(mapAttributeDefinition);
    },

    domainTemplates: async (_: any, args: { domainCode?: string }, { supabase }: { supabase: SupabaseClient }) => {
      let query = supabase
        .from('domain_templates')
        .select('*')
        .order('template_code');

      // Filter by domain if specified
      if (args.domainCode) {
        query = query.eq('domain_code', args.domainCode);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching domain templates:', error);
        throw new Error('Failed to fetch domain templates');
      }

      const templates = data || [];
      if (templates.length === 0) return [];

      // Fetch attribute assignments for all templates in one round-trip so
      // Template.attributes (non-null list) always resolves, even when a
      // template has no attributes assigned yet.
      const templateIds = templates.map((t: any) => t.id);
      const { data: assignments, error: assignmentsError } = await supabase
        .from('template_attribute_assignments')
        .select('*, attribute_register!inner(*)')
        .in('template_id', templateIds);

      if (assignmentsError) {
        console.error('Error fetching template attribute assignments:', assignmentsError);
      }

      const assignmentsByTemplate = new Map<string, any[]>();
      (assignments || []).forEach((a: any) => {
        if (!assignmentsByTemplate.has(a.template_id)) {
          assignmentsByTemplate.set(a.template_id, []);
        }
        assignmentsByTemplate.get(a.template_id)!.push(a);
      });

      return templates.map((t: any) => ({
        id: t.id,
        templateCode: t.template_code,
        domainCode: t.domain_code,
        templateName: t.template_name,
        description: t.description,
        isActive: t.is_active,
        attributes: (assignmentsByTemplate.get(t.id) || []).map((a: any) => ({
          attributeId: a.attribute_id,
          attribute: mapAttributeDefinition(a.attribute_register),
          isRequired: a.is_required,
          precedenceRank: a.precedence_rank,
          displayOrder: a.display_order,
          displayLabel: a.display_label,
          defaultPrecedenceChain: Array.isArray(a.default_precedence_chain) ? a.default_precedence_chain : [],
        })),
      }));
    },

    /**
     * Get only derived attributes
     */
    derivedAttributes: async (_: any, __: any, { supabase }: { supabase: SupabaseClient }) => {
      const { data, error } = await supabase
        .from('attribute_register')
        .select('*')
        .eq('is_derived', true)
        .order('attribute_code');

      if (error) {
        console.error('Error fetching derived attributes:', error);
        throw new Error('Failed to fetch derived attributes');
      }

      return (data || []).map(mapAttributeDefinition);
    },

    /**
     * Evaluate a single derived attribute for an entity
     */
    evaluateDerivedAttribute: async (
      _: any,
      args: { entityId: string; attributeCode: string; asOfDate?: string },
      { supabase }: { supabase: SupabaseClient }
    ) => {
      const formulaEngine = new FormulaEngine(supabase);
      const context: DerivationContext = {
        entityId: args.entityId,
        asOfDate: args.asOfDate || new Date().toISOString().split('T')[0],
        supabase,
      };

      try {
        const result = await formulaEngine.evaluateDerivation(args.attributeCode, context);
        if (!result) return null;

        return {
          attributeCode: args.attributeCode,
          value: result.value,
          derivationType: result.derivationType,
          dependencies: result.dependencies,
          evaluatedAt: result.evaluatedAt,
        };
      } catch (error) {
        console.error('Error evaluating derived attribute:', error);
        throw error;
      }
    },

    /**
     * Batch evaluate multiple derived attributes for an entity
     */
    evaluateDerivedAttributesBatch: async (
      _: any,
      args: { entityId: string; attributeCodes: string[]; asOfDate?: string },
      { supabase }: { supabase: SupabaseClient }
    ) => {
      const formulaEngine = new FormulaEngine(supabase);
      const context: DerivationContext = {
        entityId: args.entityId,
        asOfDate: args.asOfDate || new Date().toISOString().split('T')[0],
        supabase,
      };

      try {
        const results = await formulaEngine.evaluateBatch(args.attributeCodes, context);
        return Object.fromEntries(results);
      } catch (error) {
        console.error('Error evaluating derived attributes batch:', error);
        throw error;
      }
    },
  },

  Mutation: {
    /**
     * Create a new attribute (source or derived)
     */
    createAttribute: async (
      _: any,
      args: { input: CreateAttributeInput },
      { supabase }: { supabase: SupabaseClient }
    ) => {
      const { input } = args;

      // Validate derived attribute inputs
      if (input.isDerived) {
        if (!input.derivationType) {
          return {
            attribute: null,
            errors: [{ field: 'derivationType', message: 'Derivation type is required for derived attributes', code: 'VALIDATION_ERROR' }],
          };
        }
        if (!input.derivationFormula) {
          return {
            attribute: null,
            errors: [{ field: 'derivationFormula', message: 'Derivation formula is required for derived attributes', code: 'VALIDATION_ERROR' }],
          };
        }
      }

      const { data, error } = await supabase
        .from('attribute_register')
        .insert({
          attribute_code: input.attributeCode,
          attribute_name: input.attributeName,
          data_type: input.dataType,
          description: input.description,
          unit_of_measure: input.unitOfMeasure,
          is_required: input.isRequired || false,
          is_multi_valued: input.isMultiValued || false,
          reference_domain_code: input.referenceDomainCode,
          default_precedence_rank: input.defaultPrecedenceRank || 100,
          is_derived: input.isDerived || false,
          derivation_type: input.derivationType,
          derivation_formula: input.derivationFormula,
          derivation_dependencies: input.derivationDependencies || [],
          formula_language: input.formulaLanguage || 'SQL',
          is_time_varying: input.isTimeVarying || false,
          time_dimension: input.timeDimension || 'NONE',
        })
        .select()
        .single();

      if (error) {
        console.error('Error creating attribute:', error);
        return {
          attribute: null,
          errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }],
        };
      }

      return {
        attribute: mapAttributeDefinition(data),
        errors: [],
      };
    },

    /**
     * Update an existing attribute
     */
    updateAttributeDefinition: async (
      _: any,
      args: { input: UpdateAttributeDefinitionInput },
      { supabase }: { supabase: SupabaseClient }
    ) => {
      try {
        const { input } = args;

        const updateData: any = {
          updated_at: new Date().toISOString(),
        };

        // Only include fields that were provided
        if (input.attributeName !== undefined) updateData.attribute_name = input.attributeName;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.dataType !== undefined) updateData.data_type = input.dataType;
        if (input.unitOfMeasure !== undefined) updateData.unit_of_measure = input.unitOfMeasure;
        if (input.isRequired !== undefined) updateData.is_required = input.isRequired;
        if (input.isMultiValued !== undefined) updateData.is_multi_valued = input.isMultiValued;
        if (input.referenceDomainCode !== undefined) updateData.reference_domain_code = input.referenceDomainCode;
        if (input.defaultPrecedenceRank !== undefined) updateData.default_precedence_rank = input.defaultPrecedenceRank;
        if (input.isDerived !== undefined) updateData.is_derived = input.isDerived;
        if (input.derivationType !== undefined) updateData.derivation_type = input.derivationType;
        if (input.derivationFormula !== undefined) updateData.derivation_formula = input.derivationFormula;
        if (input.derivationDependencies !== undefined) updateData.derivation_dependencies = input.derivationDependencies;
        if (input.formulaLanguage !== undefined) updateData.formula_language = input.formulaLanguage;
        
        // Time dimension fields
        if (input.isTimeVarying !== undefined) updateData.is_time_varying = input.isTimeVarying;
        if (input.timeDimension !== undefined) updateData.time_dimension = input.timeDimension;
        
        // Display and validation metadata fields
        if (input.displayFormat !== undefined) updateData.display_format = input.displayFormat;
        if (input.listValues !== undefined) updateData.list_values = input.listValues;
        if (input.validationRules !== undefined) updateData.validation_rules = input.validationRules;
        if (input.defaultValue !== undefined) updateData.default_value = input.defaultValue;
        if (input.displaySection !== undefined) updateData.display_section = input.displaySection;
        if (input.displayGroup !== undefined) updateData.display_group = input.displayGroup;
        if (input.isEditable !== undefined) updateData.is_editable = input.isEditable;
        if (input.isVisible !== undefined) updateData.is_visible = input.isVisible;
        
        // Aggregation and precision fields
        if (input.aggregationType !== undefined) updateData.aggregation_type = input.aggregationType;
        if (input.weightAttributeCode !== undefined) updateData.weight_attribute_code = input.weightAttributeCode;
        if (input.numericPrecision !== undefined) updateData.numeric_precision = input.numericPrecision;

        const { data, error } = await supabase
          .from('attribute_register')
          .update(updateData)
          .eq('id', input.id)
          .select()
          .single();

        if (error) {
          console.error('Error updating attribute:', error);
          return {
            success: false,
            attribute: null,
            errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }],
          };
        }

        return {
          success: true,
          attribute: mapAttributeDefinition(data),
          errors: [],
        };
      } catch (err) {
        console.error('Exception in updateAttributeDefinition:', err);
        return {
          success: false,
          attribute: null,
          errors: [{ field: 'general', message: String(err), code: 'EXCEPTION' }],
        };
      }
    },

    /**
     * Delete an attribute (only if not in use)
     */
    deleteAttribute: async (
      _: any,
      args: { id: string },
      { supabase }: { supabase: SupabaseClient }
    ) => {
      // Check if attribute is in use by any template
      const { data: usages, error: usageError } = await supabase
        .from('template_attribute_assignments')
        .select('id')
        .eq('attribute_id', args.id)
        .limit(1);

      if (usageError) {
        return {
          success: false,
          errors: [{ field: 'general', message: usageError.message, code: 'DATABASE_ERROR' }],
        };
      }

      if (usages && usages.length > 0) {
        return {
          success: false,
          errors: [{ field: 'general', message: 'Cannot delete attribute that is in use by templates', code: 'IN_USE' }],
        };
      }

      const { error } = await supabase
        .from('attribute_register')
        .delete()
        .eq('id', args.id);

      if (error) {
        return {
          success: false,
          errors: [{ field: 'general', message: error.message, code: 'DATABASE_ERROR' }],
        };
      }

      return { success: true, errors: [] };
    },
  },
};

/**
 * Map database row to GraphQL AttributeDefinition type
 */
function mapAttributeDefinition(row: any) {
  return {
    id: row.id,
    attributeCode: row.attribute_code,
    attributeName: row.attribute_name,
    dataType: row.data_type,
    description: row.description,
    unitOfMeasure: row.unit_of_measure,
    isRequired: row.is_required || false,
    isMultiValued: row.is_multi_valued || false,
    referenceDomainCode: row.reference_domain_code,
    defaultPrecedenceRank: row.default_precedence_rank || 100,
    isDerived: row.is_derived || false,
    derivationType: row.derivation_type,
    derivationFormula: row.derivation_formula,
    derivationDependencies: row.derivation_dependencies || [],
    formulaLanguage: row.formula_language || 'SQL',
    // Time dimension fields
    isTimeVarying: row.is_time_varying || false,
    timeDimension: row.time_dimension || 'NONE',
    // Display and validation metadata
    displayFormat: row.display_format,
    listValues: row.list_values || [],
    validationRules: row.validation_rules || {},
    defaultValue: row.default_value,
    displaySection: row.display_section || 'General',
    displayGroup: row.display_group || 0,
    isEditable: row.is_editable !== false,
    isVisible: row.is_visible !== false,
    // Aggregation and precision
    aggregationType: row.aggregation_type || 'NONE',
    weightAttributeCode: row.weight_attribute_code,
    numericPrecision: row.numeric_precision,
  };
}

/**
 * Input types for mutations
 */
interface CreateAttributeInput {
  attributeCode: string;
  attributeName: string;
  dataType: string;
  description?: string;
  unitOfMeasure?: string;
  isRequired?: boolean;
  isMultiValued?: boolean;
  referenceDomainCode?: string;
  defaultPrecedenceRank?: number;
  isDerived?: boolean;
  derivationType?: string;
  derivationFormula?: string;
  derivationDependencies?: string[];
  formulaLanguage?: string;
  // Time dimension fields
  isTimeVarying?: boolean;
  timeDimension?: 'NONE' | 'VALID_TIME' | 'TRANSACTION_TIME' | 'BITEMPORAL';
}

interface UpdateAttributeDefinitionInput {
  id: string;
  attributeName?: string;
  description?: string;
  dataType?: string;
  unitOfMeasure?: string;
  isRequired?: boolean;
  isMultiValued?: boolean;
  referenceDomainCode?: string;
  defaultPrecedenceRank?: number;
  isDerived?: boolean;
  derivationType?: string;
  derivationFormula?: string;
  derivationDependencies?: string[];
  formulaLanguage?: string;
  // Time dimension fields
  isTimeVarying?: boolean;
  timeDimension?: 'NONE' | 'VALID_TIME' | 'TRANSACTION_TIME' | 'BITEMPORAL';
  // Display and validation metadata
  displayFormat?: string;
  listValues?: string[];
  validationRules?: any;
  defaultValue?: string;
  displaySection?: string;
  displayGroup?: number;
  isEditable?: boolean;
  isVisible?: boolean;
  // Aggregation and precision
  aggregationType?: 'NONE' | 'MIN' | 'MAX' | 'SUM' | 'AVG' | 'WEIGHTED_AVG';
  weightAttributeCode?: string;
  numericPrecision?: number;
}
