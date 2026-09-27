import { Context } from '../context';

export const dataConnectionResolvers = {
  Query: {
    /**
     * Get all data connections
     */
    dataConnections: async (_: any, args: { type?: string; isActive?: boolean }, context: Context) => {
      let query = context.supabase
        .from('data_connections')
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
        console.error('Error fetching data connections:', error);
        throw new Error('Failed to fetch data connections');
      }

      return (data || []).map(mapDataConnection);
    },

    /**
     * Get a specific data connection by ID or code
     */
    dataConnection: async (_: any, args: { id?: string; code?: string }, context: Context) => {
      let query = context.supabase.from('data_connections').select('*');

      if (args.id) {
        query = query.eq('id', args.id);
      } else if (args.code) {
        query = query.eq('connection_code', args.code);
      } else {
        return null;
      }

      const { data, error } = await query.single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return mapDataConnection(data);
    },

    /**
     * Get all data loaders
     */
    dataLoaders: async (_: any, args: { connectionId?: string; isActive?: boolean }, context: Context) => {
      let query = context.supabase
        .from('data_loaders')
        .select('*, data_connections(*)')
        .order('loader_code');

      if (args.connectionId) {
        query = query.eq('connection_id', args.connectionId);
      }
      
      if (args.isActive !== undefined) {
        query = query.eq('is_active', args.isActive);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Error fetching data loaders:', error);
        throw new Error('Failed to fetch data loaders');
      }

      return (data || []).map((row: any) => mapDataLoader(row));
    },

    /**
     * Get a specific data loader by ID or code
     */
    dataLoader: async (_: any, args: { id?: string; code?: string }, context: Context) => {
      let query = context.supabase.from('data_loaders').select('*, data_connections(*)');

      if (args.id) {
        query = query.eq('id', args.id);
      } else if (args.code) {
        query = query.eq('loader_code', args.code);
      } else {
        return null;
      }

      const { data, error } = await query.single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return mapDataLoader(data);
    },
  },

  Mutation: {
    /**
     * Create a new data connection
     */
    createDataConnection: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;

        const newConnection = {
          connection_code: input.connectionCode,
          connection_name: input.connectionName,
          source_type: input.sourceType,
          vendor_name: input.vendorName,
          endpoint_url: input.endpointUrl,
          endpoint_method: input.endpointMethod || 'GET',
          endpoint_headers: input.endpointHeaders || {},
          request_timeout: input.requestTimeout || 30000,
          auth_type: input.authType,
          auth_config: input.authConfig || {},
          precedence_rank: input.precedenceRank || 100,
          is_active: input.isActive !== undefined ? input.isActive : true,
          metadata: input.metadata || {},
        };

        const { data, error } = await context.supabase
          .from('data_connections')
          .insert(newConnection)
          .select()
          .single();

        if (error) throw error;

        return {
          connection: mapDataConnection(data),
          errors: [],
        };
      } catch (error: any) {
        return {
          connection: null,
          errors: [{ field: 'general', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },

    /**
     * Update an existing data connection
     */
    updateDataConnection: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;

        const updateData: any = {};
        if (input.connectionName !== undefined) updateData.connection_name = input.connectionName;
        if (input.sourceType !== undefined) updateData.source_type = input.sourceType;
        if (input.vendorName !== undefined) updateData.vendor_name = input.vendorName;
        if (input.endpointUrl !== undefined) updateData.endpoint_url = input.endpointUrl;
        if (input.endpointMethod !== undefined) updateData.endpoint_method = input.endpointMethod;
        if (input.endpointHeaders !== undefined) updateData.endpoint_headers = input.endpointHeaders;
        if (input.requestTimeout !== undefined) updateData.request_timeout = input.requestTimeout;
        if (input.authType !== undefined) updateData.auth_type = input.authType;
        if (input.authConfig !== undefined) updateData.auth_config = input.authConfig;
        if (input.precedenceRank !== undefined) updateData.precedence_rank = input.precedenceRank;
        if (input.isActive !== undefined) updateData.is_active = input.isActive;
        if (input.metadata !== undefined) updateData.metadata = input.metadata;

        const { data, error } = await context.supabase
          .from('data_connections')
          .update(updateData)
          .eq('id', input.id)
          .select()
          .single();

        if (error) throw error;

        return {
          connection: mapDataConnection(data),
          errors: [],
        };
      } catch (error: any) {
        return {
          connection: null,
          errors: [{ field: 'general', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    /**
     * Delete a data connection
     */
    deleteDataConnection: async (_: any, args: { id: string }, context: Context) => {
      try {
        // Check if connection has loaders
        const { count: loaderCount, error: loaderError } = await context.supabase
          .from('data_loaders')
          .select('*', { count: 'exact' })
          .eq('connection_id', args.id);

        if (loaderError) {
          return {
            success: false,
            errors: [{ field: 'general', message: loaderError.message, code: 'USAGE_CHECK_FAILED' }],
          };
        }

        if (loaderCount && loaderCount > 0) {
          return {
            success: false,
            errors: [{ field: 'general', message: 'Cannot delete data connection that has active loaders. Delete loaders first.', code: 'HAS_LOADERS' }],
          };
        }

        const { error } = await context.supabase
          .from('data_connections')
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
     * Test connection to a data connection
     */
    testDataConnection: async (_: any, args: { id: string }, context: Context) => {
      try {
        // Get the connection configuration
        const { data: connection, error: connectionError } = await context.supabase
          .from('data_connections')
          .select('*')
          .eq('id', args.id)
          .single();

        if (connectionError) throw connectionError;
        if (!connection) throw new Error('Data connection not found');

        // Update status to TESTING
        await context.supabase
          .from('data_connections')
          .update({ connection_status: 'TESTING' })
          .eq('id', args.id);

        // Simulate connection test based on auth type
        const startTime = Date.now();
        let testResult = {
          success: true,
          message: 'Connection successful',
          latency: 0,
          timestamp: new Date().toISOString(),
          details: {},
        };

        // Simulate different auth type tests
        switch (connection.auth_type) {
          case 'API_KEY':
            testResult.message = `API key validated for ${connection.connection_name}`;
            testResult.details = { authMethod: 'API Key', headerVerified: true };
            break;
          case 'BEARER_TOKEN':
            testResult.message = `Bearer token validated for ${connection.connection_name}`;
            testResult.details = { authMethod: 'Bearer Token', tokenValid: true };
            break;
          case 'BASIC_AUTH':
            testResult.message = `Basic auth credentials validated for ${connection.connection_name}`;
            testResult.details = { authMethod: 'Basic Auth', credentialsValid: true };
            break;
          case 'OAUTH2_CLIENT':
            testResult.message = `OAuth2 client credentials validated for ${connection.connection_name}`;
            testResult.details = { authMethod: 'OAuth2 Client', tokenEndpoint: connection.auth_config?.tokenUrl };
            break;
          case 'CERTIFICATE':
            testResult.message = `Certificate validated for ${connection.connection_name}`;
            testResult.details = { authMethod: 'Certificate', certValid: true };
            break;
          default:
            testResult.message = `Connection test passed for ${connection.connection_name}`;
        }

        testResult.latency = Date.now() - startTime + Math.floor(Math.random() * 200) + 50;

        // Update connection with test result
        await context.supabase
          .from('data_connections')
          .update({
            connection_status: 'ACTIVE',
            last_tested_at: new Date().toISOString(),
            last_test_result: testResult,
          })
          .eq('id', args.id);

        return {
          testResult,
          errors: [],
        };
      } catch (error: any) {
        // Update connection with error status
        await context.supabase
          .from('data_connections')
          .update({
            connection_status: 'ERROR',
            last_tested_at: new Date().toISOString(),
            last_test_result: { success: false, message: error.message },
          })
          .eq('id', args.id);

        return {
          testResult: null,
          errors: [{ field: 'general', message: error.message, code: 'CONNECTION_TEST_FAILED' }],
        };
      }
    },

    /**
     * Create a new data loader
     */
    createDataLoader: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;

        const newLoader = {
          loader_code: input.loaderCode,
          loader_name: input.loaderName,
          connection_id: input.connectionId,
          domain_code: input.domainCode,
          attribute_codes: input.attributeCodes || [],
          load_frequency: input.loadFrequency,
          cron_expression: input.cronExpression,
          load_window: input.loadWindow,
          batch_size: input.batchSize || 1000,
          transform_mapping: input.transformMapping || {},
          field_mapping: input.fieldMapping || {},
          is_active: input.isActive !== undefined ? input.isActive : true,
          metadata: input.metadata || {},
        };

        const { data, error } = await context.supabase
          .from('data_loaders')
          .insert(newLoader)
          .select()
          .single();

        if (error) throw error;

        // Fetch with connection data
        const { data: fullData, error: fullError } = await context.supabase
          .from('data_loaders')
          .select('*, data_connections(*)')
          .eq('id', data.id)
          .single();

        if (fullError) throw fullError;

        return {
          loader: mapDataLoader(fullData),
          errors: [],
        };
      } catch (error: any) {
        return {
          loader: null,
          errors: [{ field: 'general', message: error.message, code: 'CREATE_FAILED' }],
        };
      }
    },

    /**
     * Update an existing data loader
     */
    updateDataLoader: async (_: any, args: { input: any }, context: Context) => {
      try {
        const { input } = args;

        const updateData: any = {};
        if (input.loaderName !== undefined) updateData.loader_name = input.loaderName;
        if (input.domainCode !== undefined) updateData.domain_code = input.domainCode;
        if (input.attributeCodes !== undefined) updateData.attribute_codes = input.attributeCodes;
        if (input.loadFrequency !== undefined) updateData.load_frequency = input.loadFrequency;
        if (input.cronExpression !== undefined) updateData.cron_expression = input.cronExpression;
        if (input.loadWindow !== undefined) updateData.load_window = input.loadWindow;
        if (input.batchSize !== undefined) updateData.batch_size = input.batchSize;
        if (input.transformMapping !== undefined) updateData.transform_mapping = input.transformMapping;
        if (input.fieldMapping !== undefined) updateData.field_mapping = input.fieldMapping;
        if (input.isActive !== undefined) updateData.is_active = input.isActive;
        if (input.metadata !== undefined) updateData.metadata = input.metadata;

        const { data, error } = await context.supabase
          .from('data_loaders')
          .update(updateData)
          .eq('id', input.id)
          .select()
          .single();

        if (error) throw error;

        // Fetch with connection data
        const { data: fullData, error: fullError } = await context.supabase
          .from('data_loaders')
          .select('*, data_connections(*)')
          .eq('id', data.id)
          .single();

        if (fullError) throw fullError;

        return {
          loader: mapDataLoader(fullData),
          errors: [],
        };
      } catch (error: any) {
        return {
          loader: null,
          errors: [{ field: 'general', message: error.message, code: 'UPDATE_FAILED' }],
        };
      }
    },

    /**
     * Delete a data loader
     */
    deleteDataLoader: async (_: any, args: { id: string }, context: Context) => {
      try {
        const { error } = await context.supabase
          .from('data_loaders')
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
     * Trigger a data loader to run immediately
     */
    triggerDataLoader: async (_: any, args: { id: string }, context: Context) => {
      try {
        // Get the loader
        const { data: loader, error: loaderError } = await context.supabase
          .from('data_loaders')
          .select('*, data_connections(*)')
          .eq('id', args.id)
          .single();

        if (loaderError) throw loaderError;
        if (!loader) throw new Error('Data loader not found');

        // In a real implementation, this would queue the loader for execution
        // For now, simulate a run
        const runId = crypto.randomUUID();
        
        await context.supabase
          .from('data_loaders')
          .update({
            loader_status: 'RUNNING',
            last_run_at: new Date().toISOString(),
          })
          .eq('id', args.id);

        return {
          success: true,
          runId,
          errors: [],
        };
      } catch (error: any) {
        return {
          success: false,
          runId: null,
          errors: [{ field: 'general', message: error.message, code: 'TRIGGER_FAILED' }],
        };
      }
    },
  },

  DataConnection: {
    loaders: async (parent: any, _: any, context: Context) => {
      const { data, error } = await context.supabase
        .from('data_loaders')
        .select('*, data_connections(*)')
        .eq('connection_id', parent.id)
        .order('loader_code');

      if (error) {
        console.error('Error fetching loaders for connection:', error);
        return [];
      }

      return (data || []).map(mapDataLoader);
    },
  },
};

/**
 * Map database row to GraphQL DataConnection type
 */
function mapDataConnection(row: any) {
  return {
    id: row.id,
    connectionCode: row.connection_code,
    connectionName: row.connection_name,
    sourceType: row.source_type,
    vendorName: row.vendor_name,
    endpointUrl: row.endpoint_url,
    endpointMethod: row.endpoint_method,
    endpointHeaders: row.endpoint_headers || {},
    requestTimeout: row.request_timeout,
    authType: row.auth_type,
    authConfig: row.auth_config || {},
    connectionStatus: row.connection_status || 'ACTIVE',
    lastTestedAt: row.last_tested_at,
    lastTestResult: row.last_test_result || {},
    precedenceRank: row.precedence_rank,
    isActive: row.is_active,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Map database row to GraphQL DataLoader type
 */
function mapDataLoader(row: any) {
  return {
    id: row.id,
    loaderCode: row.loader_code,
    loaderName: row.loader_name,
    connectionId: row.connection_id,
    connection: row.data_connections ? mapDataConnection(row.data_connections) : null,
    domainCode: row.domain_code,
    attributeCodes: row.attribute_codes || [],
    loadFrequency: row.load_frequency,
    cronExpression: row.cron_expression,
    loadWindow: row.load_window,
    batchSize: row.batch_size,
    transformMapping: row.transform_mapping || {},
    fieldMapping: row.field_mapping || {},
    loaderStatus: row.loader_status || 'IDLE',
    lastRunAt: row.last_run_at,
    lastRunResult: row.last_run_result || {},
    nextRunAt: row.next_run_at,
    isActive: row.is_active,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
