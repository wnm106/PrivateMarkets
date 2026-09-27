/**
 * Import Map GraphQL Resolvers
 * Handles CRUD operations and analysis/execution of import maps
 */

import { Context } from '../context';
import { 
  analyzeImportMap, 
  executeImportMap, 
  ImportMap, 
  DomainImportMapping 
} from '../lib/import-map/import-orchestrator';
import { getIdentifierSuggestions } from '../lib/import-map/identifier-validator';

export const importMapResolvers = {
  Query: {
    /**
     * Get all import maps
     */
    importMaps: async (_: any, __: any, context: Context) => {
      const { data, error } = await context.supabase
        .from('import_maps')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching import maps:', error);
        throw new Error('Failed to fetch import maps');
      }

      return (data || []).map(mapImportMap);
    },

    /**
     * Get a specific import map by ID
     */
    importMap: async (_: any, args: { id: string }, context: Context) => {
      const { data, error } = await context.supabase
        .from('import_maps')
        .select('*')
        .eq('id', args.id)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return mapImportMap(data);
    },

    /**
     * Get identifier suggestions for a domain
     */
    identifierSuggestions: async (_: any, args: { domainCode: string }, context: Context) => {
      return getIdentifierSuggestions(args.domainCode, context.supabase);
    },
  },

  Mutation: {
    /**
     * Create a new import map
     */
    createImportMap: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;
        const userId = context.user?.id;

        const newImportMap = {
          name: input.name,
          description: input.description,
          source_format: input.sourceFormat,
          source_data: input.sourceData,
          domain_mappings: input.domainMappings || [],
          status: 'DRAFT',
          options: input.options || {},
          created_by: userId,
        };

        const { data, error } = await context.supabase
          .from('import_maps')
          .insert(newImportMap)
          .select()
          .single();

        if (error) throw error;

        return {
          importMap: mapImportMap(data),
          errors: [],
        };
      } catch (error: any) {
        return {
          importMap: null,
          errors: [{ field: 'general', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },

    /**
     * Update an existing import map
     */
    updateImportMap: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;

        const updateData: any = {
          updated_at: new Date().toISOString(),
        };

        if (input.name !== undefined) updateData.name = input.name;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.domainMappings !== undefined) updateData.domain_mappings = input.domainMappings;
        if (input.options !== undefined) updateData.options = input.options;

        const { data, error } = await context.supabase
          .from('import_maps')
          .update(updateData)
          .eq('id', input.id)
          .select()
          .single();

        if (error) throw error;

        return {
          importMap: mapImportMap(data),
          errors: [],
        };
      } catch (error: any) {
        return {
          importMap: null,
          errors: [{ field: 'general', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    /**
     * Delete an import map
     */
    deleteImportMap: async (_: any, args: { id: string }, context: Context) => {
      try {
        const { error } = await context.supabase
          .from('import_maps')
          .delete()
          .eq('id', args.id);

        if (error) throw error;

        return { success: true, errors: [] };
      } catch (error: any) {
        return {
          success: false,
          errors: [{ field: 'general', message: error.message, code: 'DELETE_FAILED' }],
        };
      }
    },

    /**
     * Analyze an import map (parse data, generate recommendations, validate)
     */
    analyzeImportMap: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;

        // Fetch the import map
        const { data: importMapData, error: fetchError } = await context.supabase
          .from('import_maps')
          .select('*')
          .eq('id', input.id)
          .single();

        if (fetchError) throw fetchError;
        if (!importMapData) throw new Error('Import map not found');

        // Update status to ANALYZING
        await context.supabase
          .from('import_maps')
          .update({ status: 'ANALYZING' })
          .eq('id', input.id);

        // Build import map object for analysis
        const importMap: ImportMap = {
          id: importMapData.id,
          name: importMapData.name,
          description: importMapData.description,
          sourceFormat: (input.sourceFormat || importMapData.source_format).toLowerCase(),
          sourceData: input.sourceData || importMapData.source_data,
          domainMappings: importMapData.domain_mappings,
          options: { ...importMapData.options, ...input },
        };

        // Run analysis
        const analysis = await analyzeImportMap(importMap, context.supabase);

        // Update import map with analysis results
        const newStatus = analysis.overallValidation.isValid ? 'READY' : 'DRAFT';
        
        await context.supabase
          .from('import_maps')
          .update({
            status: newStatus,
            last_analysis: analysis,
            last_analysis_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.id);

        return {
          analysis: {
            parsedFields: analysis.parsedData.fields,
            recordCount: analysis.parsedData.recordCount,
            recommendations: analysis.recommendations,
            identifierValidations: analysis.identifierValidations,
            importPlan: analysis.importPlan,
            importBatches: analysis.importBatches,
            overallValidation: analysis.overallValidation,
          },
          errors: [],
        };
      } catch (error: any) {
        // Update status to FAILED
        if (args.input?.id) {
          await context.supabase
            .from('import_maps')
            .update({ status: 'FAILED' })
            .eq('id', args.input.id);
        }

        return {
          analysis: null,
          errors: [{ field: 'general', message: error.message, code: 'ANALYSIS_FAILED' }],
        };
      }
    },

    /**
     * Execute an import map
     */
    executeImportMap: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;
        const userId = context.user?.id;

        // Fetch the import map
        const { data: importMapData, error: fetchError } = await context.supabase
          .from('import_maps')
          .select('*')
          .eq('id', input.id)
          .single();

        if (fetchError) throw fetchError;
        if (!importMapData) throw new Error('Import map not found');

        // Update status to IMPORTING
        await context.supabase
          .from('import_maps')
          .update({ status: 'IMPORTING' })
          .eq('id', input.id);

        // Build import map object for execution
        const importMap: ImportMap = {
          id: importMapData.id,
          name: importMapData.name,
          description: importMapData.description,
          sourceFormat: importMapData.source_format.toLowerCase(),
          sourceData: importMapData.source_data,
          domainMappings: importMapData.domain_mappings,
          options: {
            ...importMapData.options,
            dryRun: input.dryRun,
            skipValidation: input.skipValidation,
            continueOnError: input.continueOnError,
            batchSize: input.batchSize,
          },
        };

        // Execute import
        const executionResult = await executeImportMap(importMap, context.supabase, userId);

        // Update import map with execution results
        const newStatus = executionResult.success ? 'COMPLETED' : 'FAILED';

        await context.supabase
          .from('import_maps')
          .update({
            status: newStatus,
            last_execution: executionResult,
            last_execution_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.id);

        // Log execution
        await context.supabase
          .from('import_executions')
          .insert({
            import_map_id: importMapData.id,
            execution_id: executionResult.executionId,
            status: executionResult.success ? 'COMPLETED' : 'FAILED',
            completed_at: new Date().toISOString(),
            results: executionResult.results,
            summary: executionResult.summary,
            errors: executionResult.errors,
            dry_run: input.dryRun || false,
            skip_validation: input.skipValidation || false,
            continue_on_error: input.continueOnError || false,
            batch_size: input.batchSize || 100,
            created_by: userId,
          });

        return {
          execution: executionResult,
          errors: [],
        };
      } catch (error: any) {
        // Update status to FAILED
        if (args.input?.id) {
          await context.supabase
            .from('import_maps')
            .update({ status: 'FAILED' })
            .eq('id', args.input.id);
        }

        return {
          execution: null,
          errors: [{ field: 'general', message: error.message, code: 'EXECUTION_FAILED' }],
        };
      }
    },
  },
};

/**
 * Map database row to GraphQL ImportMap type
 */
function mapImportMap(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceFormat: row.source_format,
    domainMappings: row.domain_mappings || [],
    status: row.status,
    options: row.options || {},
    lastAnalysis: row.last_analysis,
    lastAnalysisAt: row.last_analysis_at,
    lastExecution: row.last_execution,
    lastExecutionAt: row.last_execution_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}
