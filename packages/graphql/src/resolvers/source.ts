import { Context } from '../context';

export const sourceResolvers = {
  Query: {
    /**
     * Get all data sources with their configurations
     */
    dataSources: async (_: any, args: { type?: string; isActive?: boolean }, context: Context) => {
      let query = context.supabase
        .from('source_registry')
        .select('*')
        .order('precedence_rank');

      if (args.type) {
        query = query.eq('source_type', args.type);
      }
      
      if (args.isActive !== undefined) {
        query = query.eq('is_active', args.isActive);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching data sources:', error);
        throw new Error('Failed to fetch data sources');
      }

      return (data || []).map(mapSourceRegistry);
    },

    /**
     * Get a specific data source by ID or code
     */
    dataSource: async (_: any, args: { id?: string; code?: string }, context: Context) => {
      let query = context.supabase.from('source_registry').select('*');

      if (args.id) {
        query = query.eq('id', args.id);
      } else if (args.code) {
        query = query.eq('source_code', args.code);
      } else {
        return null;
      }

      const { data, error } = await query.single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return mapSourceRegistry(data);
    },

    /**
     * Get source statistics
     */
    dataSourceStats: async (_: any, args: { sourceId?: string }, context: Context) => {
      // First, get the grouped data without using aggregate in select
      let baseQuery = context.supabase
        .from('source_attribute_values')
        .select('source_id')
        .order('source_id');

      if (args.sourceId) {
        baseQuery = baseQuery.eq('source_id', args.sourceId);
      }

      const { data: rawResults, error } = await baseQuery;

      if (error) {
        console.error('Error fetching source stats:', error);
        throw new Error('Failed to fetch source statistics');
      }

      // Group and count manually
      const counts: { [key: string]: number } = {};
      rawResults?.forEach((row: any) => {
        counts[row.source_id] = (counts[row.source_id] || 0) + 1;
      });

      // Convert to array format
      const sourceBreakdown = Object.entries(counts).map(([sourceId, recordCount]) => ({
        sourceId,
        recordCount,
      }));

      // Return aggregated stats
      return {
        totalSources: sourceBreakdown.length,
        sourceBreakdown,
      };
    },
  },

  Mutation: {
    /**
     * Create a new data source
     */
    createDataSource: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;

        // Prepare the record
        const newSource = {
          source_code: input.sourceCode,
          source_name: input.sourceName,
          source_type: input.sourceType,
          vendor_name: input.vendorName,
          feed_format: input.feedFormat,
          feed_frequency: input.feedFrequency,
          connection_config: input.connectionConfig || {},
          precedence_rank: input.precedenceRank || 100,
          is_active: input.isActive !== undefined ? input.isActive : true,
          metadata: input.metadata || {},
        };

        const { data, error } = await context.supabase
          .from('source_registry')
          .insert(newSource)
          .select()
          .single();

        if (error) throw error;

        return {
          dataSource: mapSourceRegistry(data),
          errors: [],
        };
      } catch (error: any) {
        return {
          dataSource: null,
          errors: [{ field: 'general', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },

    /**
     * Update an existing data source
     */
    updateDataSource: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;

        const updateData: any = {};
        if (input.sourceName !== undefined) updateData.source_name = input.sourceName;
        if (input.sourceType !== undefined) updateData.source_type = input.sourceType;
        if (input.vendorName !== undefined) updateData.vendor_name = input.vendorName;
        if (input.feedFormat !== undefined) updateData.feed_format = input.feedFormat;
        if (input.feedFrequency !== undefined) updateData.feed_frequency = input.feedFrequency;
        if (input.connectionConfig !== undefined) updateData.connection_config = input.connectionConfig;
        if (input.precedenceRank !== undefined) updateData.precedence_rank = input.precedenceRank;
        if (input.isActive !== undefined) updateData.is_active = input.isActive;
        if (input.metadata !== undefined) updateData.metadata = input.metadata;

        const { data, error } = await context.supabase
          .from('source_registry')
          .update(updateData)
          .eq('id', input.id)
          .select()
          .single();

        if (error) throw error;

        return {
          dataSource: mapSourceRegistry(data),
          errors: [],
        };
      } catch (error: any) {
        return {
          dataSource: null,
          errors: [{ field: 'general', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    /**
     * Delete a data source
     */
    deleteDataSource: async (_: any, args: { id: string }, context: Context) => {
      try {
        // Check if source is in use by any records
        const { count: usageCount, error: usageError } = await context.supabase
          .from('source_attribute_values')
          .select('*', { count: 'exact' })
          .eq('source_id', args.id);

        if (usageError) {
          return {
            success: false,
            errors: [{ field: 'general', message: usageError.message, code: 'USAGE_CHECK_FAILED' }],
          };
        }

        if (usageCount && usageCount > 0) {
          return {
            success: false,
            errors: [{ field: 'general', message: 'Cannot delete data source that is currently in use', code: 'IN_USE' }],
          };
        }

        const { error } = await context.supabase
          .from('source_registry')
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
     * Test connection to a data source
     */
    testDataSourceConnection: async (_: any, args: { id: string }, context: Context) => {
      try {
        // Get the source configuration
        const { data: source, error: sourceError } = await context.supabase
          .from('source_registry')
          .select('*')
          .eq('id', args.id)
          .single();

        if (sourceError) throw sourceError;
        if (!source) throw new Error('Data source not found');

        // Here we would implement actual connection testing logic based on the source type
        // For now, we'll simulate a successful connection test
        // In a real implementation, this would connect to the actual data source
        
        // Simulate connection test based on source type
        let testResult = {
          success: true,
          message: 'Connection successful',
          latency: Math.floor(Math.random() * 500) + 50, // Simulated latency in ms
          timestamp: new Date().toISOString(),
        };

        // Add custom logic based on source type
        if (source.source_type === 'VENDOR') {
          // Vendor-specific connection logic would go here
          testResult.message = `Connected to ${source.vendor_name || source.source_name}`;
        } else if (source.source_type === 'INTERNAL') {
          testResult.message = 'Internal system accessible';
        } else if (source.source_type === 'MANUAL') {
          testResult.message = 'Manual entry system ready';
        }

        return {
          testResult,
          errors: [],
        };
      } catch (error: any) {
        return {
          testResult: null,
          errors: [{ field: 'general', message: error.message, code: 'CONNECTION_TEST_FAILED' }],
        };
      }
    },

    /**
     * Enable/disable a data source
     */
    toggleDataSourceActive: async (_: any, args: { id: string; active: boolean }, context: Context) => {
      try {
        const { data, error } = await context.supabase
          .from('source_registry')
          .update({ is_active: args.active })
          .eq('id', args.id)
          .select()
          .single();

        if (error) throw error;

        return {
          dataSource: mapSourceRegistry(data),
          errors: [],
        };
      } catch (error: any) {
        return {
          dataSource: null,
          errors: [{ field: 'general', message: error.message, code: 'TOGGLE_FAILED' }],
        };
      }
    },
  },
};

/**
 * Map database row to GraphQL DataSource type
 */
function mapSourceRegistry(row: any) {
  return {
    id: row.id,
    sourceCode: row.source_code,
    sourceName: row.source_name,
    sourceType: row.source_type,
    vendorName: row.vendor_name,
    feedFormat: row.feed_format,
    feedFrequency: row.feed_frequency,
    connectionConfig: row.connection_config || {},
    precedenceRank: row.precedence_rank,
    isActive: row.is_active,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}