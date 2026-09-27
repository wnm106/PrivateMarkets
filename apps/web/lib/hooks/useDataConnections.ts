import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { graphqlClient } from '@/lib/graphql';

// Queries
const DATA_CONNECTIONS_QUERY = `
  query DataConnections($type: String, $isActive: Boolean) {
    dataConnections(type: $type, isActive: $isActive) {
      id
      connectionCode
      connectionName
      sourceType
      vendorName
      endpointUrl
      endpointMethod
      requestTimeout
      authType
      authConfig
      connectionStatus
      lastTestedAt
      lastTestResult
      precedenceRank
      isActive
      metadata
      createdAt
      updatedAt
      loaders {
        id
        loaderCode
        loaderName
        loadFrequency
        isActive
      }
    }
  }
`;

const DATA_CONNECTION_QUERY = `
  query DataConnection($id: ID, $code: String) {
    dataConnection(id: $id, code: $code) {
      id
      connectionCode
      connectionName
      sourceType
      vendorName
      endpointUrl
      endpointMethod
      endpointHeaders
      requestTimeout
      authType
      authConfig
      connectionStatus
      lastTestedAt
      lastTestResult
      precedenceRank
      isActive
      metadata
      createdAt
      updatedAt
    }
  }
`;

const DATA_LOADERS_QUERY = `
  query DataLoaders($connectionId: ID, $isActive: Boolean) {
    dataLoaders(connectionId: $connectionId, isActive: $isActive) {
      id
      loaderCode
      loaderName
      connectionId
      connection {
        id
        connectionCode
        connectionName
      }
      domainCode
      attributeCodes
      loadFrequency
      cronExpression
      loadWindow
      batchSize
      transformMapping
      fieldMapping
      loaderStatus
      lastRunAt
      lastRunResult
      nextRunAt
      isActive
      metadata
      createdAt
      updatedAt
    }
  }
`;

const DATA_LOADER_QUERY = `
  query DataLoader($id: ID, $code: String) {
    dataLoader(id: $id, code: $code) {
      id
      loaderCode
      loaderName
      connectionId
      connection {
        id
        connectionCode
        connectionName
      }
      domainCode
      attributeCodes
      loadFrequency
      cronExpression
      loadWindow
      batchSize
      transformMapping
      fieldMapping
      loaderStatus
      lastRunAt
      lastRunResult
      nextRunAt
      isActive
      metadata
      createdAt
      updatedAt
    }
  }
`;

// Mutations
const CREATE_DATA_CONNECTION_MUTATION = `
  mutation CreateDataConnection($input: CreateDataConnectionInput!) {
    createDataConnection(input: $input) {
      connection {
        id
        connectionCode
        connectionName
        sourceType
        vendorName
        endpointUrl
        endpointMethod
        requestTimeout
        authType
        authConfig
        connectionStatus
        precedenceRank
        isActive
        createdAt
        updatedAt
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

const UPDATE_DATA_CONNECTION_MUTATION = `
  mutation UpdateDataConnection($id: ID!, $input: UpdateDataConnectionInput!) {
    updateDataConnection(id: $id, input: $input) {
      connection {
        id
        connectionCode
        connectionName
        sourceType
        vendorName
        endpointUrl
        endpointMethod
        requestTimeout
        authType
        authConfig
        connectionStatus
        precedenceRank
        isActive
        updatedAt
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

const DELETE_DATA_CONNECTION_MUTATION = `
  mutation DeleteDataConnection($id: ID!) {
    deleteDataConnection(id: $id) {
      success
      errors {
        field
        message
        code
      }
    }
  }
`;

const TEST_DATA_CONNECTION_MUTATION = `
  mutation TestDataConnection($id: ID!) {
    testDataConnection(id: $id) {
      testResult {
        success
        message
        latency
        timestamp
        details
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

const CREATE_DATA_LOADER_MUTATION = `
  mutation CreateDataLoader($input: CreateDataLoaderInput!) {
    createDataLoader(input: $input) {
      loader {
        id
        loaderCode
        loaderName
        connectionId
        connection {
          id
          connectionCode
          connectionName
        }
        domainCode
        attributeCodes
        loadFrequency
        cronExpression
        loadWindow
        batchSize
        transformMapping
        fieldMapping
        loaderStatus
        isActive
        createdAt
        updatedAt
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

const UPDATE_DATA_LOADER_MUTATION = `
  mutation UpdateDataLoader($id: ID!, $input: UpdateDataLoaderInput!) {
    updateDataLoader(id: $id, input: $input) {
      loader {
        id
        loaderCode
        loaderName
        connectionId
        connection {
          id
          connectionCode
          connectionName
        }
        domainCode
        attributeCodes
        loadFrequency
        cronExpression
        loadWindow
        batchSize
        transformMapping
        fieldMapping
        loaderStatus
        isActive
        updatedAt
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

const DELETE_DATA_LOADER_MUTATION = `
  mutation DeleteDataLoader($id: ID!) {
    deleteDataLoader(id: $id) {
      success
      errors {
        field
        message
        code
      }
    }
  }
`;

const TRIGGER_DATA_LOADER_MUTATION = `
  mutation TriggerDataLoader($id: ID!) {
    triggerDataLoader(id: $id) {
      success
      runId
      errors {
        field
        message
        code
      }
    }
  }
`;

// Hooks for Data Connections
export function useDataConnections(type?: string, isActive?: boolean) {
  return useQuery({
    queryKey: ['dataConnections', type, isActive],
    queryFn: async () => {
      const result = await graphqlClient.query(DATA_CONNECTIONS_QUERY, { type, isActive }).toPromise();
      if (result.error) throw result.error;
      return result.data?.dataConnections || [];
    },
  });
}

export function useDataConnection(id?: string, code?: string) {
  return useQuery({
    queryKey: ['dataConnection', id, code],
    queryFn: async () => {
      const result = await graphqlClient.query(DATA_CONNECTION_QUERY, { id, code }).toPromise();
      if (result.error) throw result.error;
      return result.data?.dataConnection;
    },
    enabled: !!id || !!code,
  });
}

export function useCreateDataConnection() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (input: any) => {
      const result = await graphqlClient
        .mutation(CREATE_DATA_CONNECTION_MUTATION, { input })
        .toPromise();
      
      if (result.error) throw result.error;
      if (result.data?.createDataConnection?.errors?.length > 0) {
        throw new Error(result.data.createDataConnection.errors[0].message);
      }
      
      return result.data?.createDataConnection?.connection;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataConnections'] });
    },
  });
}

export function useUpdateDataConnection() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ id, ...input }: any) => {
      const result = await graphqlClient
        .mutation(UPDATE_DATA_CONNECTION_MUTATION, { id, input })
        .toPromise();
      
      if (result.error) throw result.error;
      if (result.data?.updateDataConnection?.errors?.length > 0) {
        throw new Error(result.data.updateDataConnection.errors[0].message);
      }
      
      return result.data?.updateDataConnection?.connection;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['dataConnections'] });
      queryClient.invalidateQueries({ queryKey: ['dataConnection', variables.id] });
    },
  });
}

export function useDeleteDataConnection() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await graphqlClient
        .mutation(DELETE_DATA_CONNECTION_MUTATION, { id })
        .toPromise();
      
      if (result.error) throw result.error;
      if (result.data?.deleteDataConnection?.errors?.length > 0) {
        throw new Error(result.data.deleteDataConnection.errors[0].message);
      }
      
      return result.data?.deleteDataConnection?.success;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataConnections'] });
    },
  });
}

export function useTestDataConnection() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await graphqlClient
        .mutation(TEST_DATA_CONNECTION_MUTATION, { id })
        .toPromise();
      
      if (result.error) throw result.error;
      if (result.data?.testDataConnection?.errors?.length > 0) {
        throw new Error(result.data.testDataConnection.errors[0].message);
      }
      
      return result.data?.testDataConnection?.testResult;
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['dataConnection', id] });
    },
  });
}

// Hooks for Data Loaders
export function useDataLoaders(connectionId?: string, isActive?: boolean) {
  return useQuery({
    queryKey: ['dataLoaders', connectionId, isActive],
    queryFn: async () => {
      const result = await graphqlClient.query(DATA_LOADERS_QUERY, { connectionId, isActive }).toPromise();
      if (result.error) throw result.error;
      return result.data?.dataLoaders || [];
    },
  });
}

export function useDataLoader(id?: string, code?: string) {
  return useQuery({
    queryKey: ['dataLoader', id, code],
    queryFn: async () => {
      const result = await graphqlClient.query(DATA_LOADER_QUERY, { id, code }).toPromise();
      if (result.error) throw result.error;
      return result.data?.dataLoader;
    },
    enabled: !!id || !!code,
  });
}

export function useCreateDataLoader() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (input: any) => {
      const result = await graphqlClient
        .mutation(CREATE_DATA_LOADER_MUTATION, { input })
        .toPromise();
      
      if (result.error) throw result.error;
      if (result.data?.createDataLoader?.errors?.length > 0) {
        throw new Error(result.data.createDataLoader.errors[0].message);
      }
      
      return result.data?.createDataLoader?.loader;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataLoaders'] });
      queryClient.invalidateQueries({ queryKey: ['dataConnections'] });
    },
  });
}

export function useUpdateDataLoader() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ id, ...input }: any) => {
      const result = await graphqlClient
        .mutation(UPDATE_DATA_LOADER_MUTATION, { id, input })
        .toPromise();
      
      if (result.error) throw result.error;
      if (result.data?.updateDataLoader?.errors?.length > 0) {
        throw new Error(result.data.updateDataLoader.errors[0].message);
      }
      
      return result.data?.updateDataLoader?.loader;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['dataLoaders'] });
      queryClient.invalidateQueries({ queryKey: ['dataLoader', variables.id] });
    },
  });
}

export function useDeleteDataLoader() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await graphqlClient
        .mutation(DELETE_DATA_LOADER_MUTATION, { id })
        .toPromise();
      
      if (result.error) throw result.error;
      if (result.data?.deleteDataLoader?.errors?.length > 0) {
        throw new Error(result.data.deleteDataLoader.errors[0].message);
      }
      
      return result.data?.deleteDataLoader?.success;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dataLoaders'] });
      queryClient.invalidateQueries({ queryKey: ['dataConnections'] });
    },
  });
}

export function useTriggerDataLoader() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await graphqlClient
        .mutation(TRIGGER_DATA_LOADER_MUTATION, { id })
        .toPromise();
      
      if (result.error) throw result.error;
      if (result.data?.triggerDataLoader?.errors?.length > 0) {
        throw new Error(result.data.triggerDataLoader.errors[0].message);
      }
      
      return result.data?.triggerDataLoader;
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['dataLoader', id] });
    },
  });
}
