import { Client, cacheExchange, fetchExchange } from '@urql/core';

const graphqlEndpoint = process.env.NEXT_PUBLIC_GRAPHQL_ENDPOINT || '/api/graphql';

export const graphqlClient = new Client({
  url: graphqlEndpoint,
  exchanges: [cacheExchange, fetchExchange],
  fetchOptions: () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    return {
      headers: {
        authorization: token ? `Bearer ${token}` : '',
      },
    };
  },
});

export async function graphqlQuery<TData, TVariables extends Record<string, any>>(
  query: string,
  variables?: TVariables
): Promise<{ data?: TData; error?: any }> {
  const result = await graphqlClient.query(query, variables).toPromise();
  return { data: result.data as TData, error: result.error };
}

export async function graphqlMutation<TData, TVariables extends Record<string, any>>(
  mutation: string,
  variables?: TVariables
): Promise<{ data?: TData; error?: any }> {
  const result = await graphqlClient.mutation(mutation, variables).toPromise();
  return { data: result.data as TData, error: result.error };
}

// Strips the display-only fields (entityCode/entityName/domainCode/relationshipName)
// that EntityForm's relationship picker keeps for UI purposes, down to exactly what
// EntityRelationshipInput accepts on createEntity/updateEntity.
export function toRelationshipInputs(
  entries: Array<{ entityId: string; relationshipCode: string; isPrimary: boolean; validFrom: string }> | undefined,
  role: 'parent' | 'child'
) {
  if (!entries || entries.length === 0) return undefined;
  return entries.map(entry => ({
    ...(role === 'parent' ? { parentEntityId: entry.entityId } : { childEntityId: entry.entityId }),
    relationshipType: entry.relationshipType,
    relationshipCode: entry.relationshipCode,
    isPrimary: entry.isPrimary,
    validFrom: entry.validFrom,
  }));
}

// ============== GENERIC ENTITY QUERIES ==============

export const ENTITIES_QUERY = `
  query Entities($filter: EntityFilter, $pagination: PaginationInput) {
    entities(filter: $filter, pagination: $pagination) {
      edges {
        node {
          id
          entityCode
          entityName
          domainCode
          domainName
          templateName
          description
          isActive
          attributes
          parentRelationships {
            parentEntityCode
            parentEntityName
            parentDomainCode
            relationshipType
            relationshipCode
            isPrimary
          }
          childRelationships {
            childEntityCode
            childEntityName
            childDomainCode
            relationshipType
            relationshipCode
            isPrimary
          }
          metadata
          createdAt
          updatedAt
        }
        cursor
      }
      totalCount
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`;

export const ENTITY_QUERY = `
  query Entity($id: ID, $entityCode: String) {
    entity(id: $id, entityCode: $entityCode) {
      id
      entityCode
      entityName
      domainCode
      domainName
      templateName
      description
      isActive
      attributes
      parentRelationships {
        parentEntityId
        parentEntityCode
        parentEntityName
        parentDomainCode
        relationshipType
        relationshipCode
        isPrimary
      }
      childRelationships {
        childEntityId
        childEntityCode
        childEntityName
        childDomainCode
        relationshipType
        relationshipCode
        isPrimary
      }
      metadata
      createdAt
      updatedAt
    }
  }
`;

export const CREATE_ENTITY_MUTATION = `
  mutation CreateEntity($input: CreateEntityInput!) {
    createEntity(input: $input) {
      entity {
        id
        entityCode
        entityName
        domainCode
        attributes
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const UPDATE_ENTITY_MUTATION = `
  mutation UpdateEntity($input: UpdateEntityInput!) {
    updateEntity(input: $input) {
      entity {
        id
        entityCode
        entityName
        attributes
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

// ============== METADATA QUERIES ==============

export const ATTRIBUTE_REGISTER_QUERY = `
  query AttributeRegister($domainCode: String) {
    attributeRegister(domainCode: $domainCode) {
      id
      attributeCode
      attributeName
      dataType
      description
      unitOfMeasure
      isRequired
      isMultiValued
      referenceDomainCode
      defaultPrecedenceRank
      displayFormat
      listValues
      validationRules
      defaultValue
      displaySection
      displayGroup
      isEditable
      isVisible
      isTimeVarying
      timeDimension
      aggregationType
      weightAttributeCode
      numericPrecision
    }
  }
`;

export const DOMAIN_TEMPLATES_QUERY = `
  query DomainTemplates($domainCode: String) {
    domainTemplates(domainCode: $domainCode) {
      id
      templateCode
      domainCode
      templateName
      description
      isActive
      attributes {
        attributeId
        attribute {
          attributeCode
          attributeName
          dataType
        }
        isRequired
        precedenceRank
        displayOrder
        displayLabel
        defaultPrecedenceChain
      }
    }
  }
`;

export const RELATIONSHIP_TYPES_QUERY = `
  query RelationshipTypes {
    relationshipTypes {
      id
      relationshipCode
      relationshipName
      parentDomainCode
      childDomainCode
      cardinality
      compositeKey
      description
      isActive
    }
  }
`;

// ============== DOMAIN-SPECIFIC CONVENIENCE QUERIES ==============

export const FUNDS_QUERY = `
  query Funds($filter: EntityFilter, $pagination: PaginationInput) {
    funds(filter: $filter, pagination: $pagination) {
      edges {
        node {
          id
          entityCode
          entityName
          attributes
          parentRelationships {
            parentEntityCode
            parentEntityName
            relationshipType
          }
        }
      }
      totalCount
    }
  }
`;

export const ISSUERS_QUERY = `
  query Issuers($filter: EntityFilter, $pagination: PaginationInput) {
    issuers(filter: $filter, pagination: $pagination) {
      edges {
        node {
          id
          entityCode
          entityName
          attributes
          parentRelationships {
            parentEntityCode
            parentEntityName
            relationshipType
          }
        }
      }
      totalCount
    }
  }
`;

export const SECURITIES_QUERY = `
  query Securities($filter: EntityFilter, $pagination: PaginationInput) {
    securities(filter: $filter, pagination: $pagination) {
      edges {
        node {
          id
          entityCode
          entityName
          attributes
          parentRelationships {
            parentEntityCode
            parentEntityName
            relationshipType
          }
        }
      }
      totalCount
    }
  }
`;

export const DEALS_QUERY = `
  query Deals($filter: EntityFilter, $pagination: PaginationInput) {
    deals(filter: $filter, pagination: $pagination) {
      edges {
        node {
          id
          entityCode
          entityName
          attributes
          parentRelationships {
            parentEntityCode
            parentEntityName
            relationshipType
          }
        }
      }
      totalCount
    }
  }
`;

export const INVESTORS_QUERY = `
  query Investors($filter: EntityFilter, $pagination: PaginationInput) {
    investors(filter: $filter, pagination: $pagination) {
      edges {
        node {
          id
          entityCode
          entityName
          attributes
          parentRelationships {
            parentEntityCode
            parentEntityName
            relationshipType
          }
        }
      }
      totalCount
    }
  }
`;

export const POSITIONS_QUERY = `
  query Positions($filter: EntityFilter, $pagination: PaginationInput) {
    positions(filter: $filter, pagination: $pagination) {
      edges {
        node {
          id
          entityCode
          entityName
          attributes
          parentRelationships {
            parentEntityCode
            parentEntityName
            relationshipType
          }
        }
      }
      totalCount
    }
  }
`;

// ============== ENTITY MANAGEMENT QUERIES/MUTATIONS ==============

export const ENTITY_IDENTIFIER_DEFINITIONS_QUERY = `
  query EntityIdentifierDefinitions($domainCode: String) {
    entityIdentifierDefinitions(domainCode: $domainCode) {
      id
      identifierCode
      identifierName
      domainCode
      domainName
      attributeCodes
      isPrimary
      description
      isActive
      createdAt
      updatedAt
    }
  }
`;

export const DOMAIN_TYPES_QUERY = `
  query DomainTypes {
    domainTypes {
      id
      domainCode
      domainName
      description
      isActive
      createdAt
      updatedAt
    }
  }
`;

export const CREATE_ENTITY_IDENTIFIER_MUTATION = `
  mutation CreateEntityIdentifier($input: CreateEntityIdentifierInput!) {
    createEntityIdentifier(input: $input) {
      identifier {
        id
        identifierCode
        identifierName
        domainCode
        domainName
        attributeCodes
        isPrimary
        description
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

export const UPDATE_ENTITY_IDENTIFIER_MUTATION = `
  mutation UpdateEntityIdentifier($input: UpdateEntityIdentifierInput!) {
    updateEntityIdentifier(input: $input) {
      identifier {
        id
        identifierCode
        identifierName
        domainCode
        domainName
        attributeCodes
        isPrimary
        description
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

export const DELETE_ENTITY_IDENTIFIER_MUTATION = `
  mutation DeleteEntityIdentifier($id: ID!) {
    deleteEntityIdentifier(id: $id) {
      success
      errors {
        field
        message
        code
      }
    }
  }
`;

export const CREATE_RELATIONSHIP_TYPE_MUTATION = `
  mutation CreateRelationshipType($input: CreateRelationshipTypeInput!) {
    createRelationshipType(input: $input) {
      relationshipType {
        id
        relationshipCode
        relationshipName
        parentDomainCode
        childDomainCode
        description
        isActive
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const UPDATE_RELATIONSHIP_TYPE_MUTATION = `
  mutation UpdateRelationshipType($input: UpdateRelationshipTypeInput!) {
    updateRelationshipType(input: $input) {
      relationshipType {
        id
        relationshipCode
        relationshipName
        parentDomainCode
        childDomainCode
        description
        isActive
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const DELETE_RELATIONSHIP_TYPE_MUTATION = `
  mutation DeleteRelationshipType($id: ID!) {
    deleteRelationshipType(id: $id) {
      success
      errors {
        field
        message
        code
      }
    }
  }
`;

export const CREATE_DOMAIN_TYPE_MUTATION = `
  mutation CreateDomainType($input: CreateDomainTypeInput!) {
    createDomainType(input: $input) {
      domainType {
        id
        domainCode
        domainName
        description
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

export const UPDATE_DOMAIN_TYPE_MUTATION = `
  mutation UpdateDomainType($input: UpdateDomainTypeInput!) {
    updateDomainType(input: $input) {
      domainType {
        id
        domainCode
        domainName
        description
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

export const DELETE_DOMAIN_TYPE_MUTATION = `
  mutation DeleteDomainType($id: ID!) {
    deleteDomainType(id: $id) {
      success
      errors {
        field
        message
        code
      }
    }
  }
`;

// ============== ATTRIBUTE MUTATIONS ==============

export const CREATE_ATTRIBUTE_MUTATION = `
  mutation CreateAttribute($input: CreateAttributeInput!) {
    createAttribute(input: $input) {
      attribute {
        id
        attributeCode
        attributeName
        dataType
        description
        unitOfMeasure
        isRequired
        isMultiValued
        referenceDomainCode
        defaultPrecedenceRank
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const UPDATE_ATTRIBUTE_MUTATION = `
  mutation UpdateAttributeDefinition($input: UpdateAttributeDefinitionInput!) {
    updateAttributeDefinition(input: $input) {
      attribute {
        id
        attributeCode
        attributeName
        dataType
        description
        unitOfMeasure
        isRequired
        isMultiValued
        referenceDomainCode
        defaultPrecedenceRank
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const UPDATE_TEMPLATE_SOURCE_PREFERENCE_MUTATION = `
  mutation UpdateTemplateSourcePreference($input: UpdateTemplateSourcePreferenceInput!) {
    updateTemplateSourcePreference(input: $input) {
      assignment {
        attributeId
        defaultPrecedenceChain
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const CREATE_TEMPLATE_MUTATION = `
  mutation CreateTemplate($input: CreateTemplateInput!) {
    createTemplate(input: $input) {
      template {
        id
        templateCode
        templateName
        domainCode
        description
        isActive
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

// ============== DATA SOURCE QUERIES AND MUTATIONS ==============

export const DATA_SOURCES_QUERY = `
  query DataSources($type: String, $isActive: Boolean) {
    dataSources(type: $type, isActive: $isActive) {
      id
      sourceCode
      sourceName
      sourceType
      vendorName
      feedFormat
      feedFrequency
      connectionConfig
      precedenceRank
      isActive
      metadata
      createdAt
      updatedAt
    }
  }
`;

export const DATA_SOURCE_QUERY = `
  query DataSource($id: ID, $code: String) {
    dataSource(id: $id, code: $code) {
      id
      sourceCode
      sourceName
      sourceType
      vendorName
      feedFormat
      feedFrequency
      connectionConfig
      precedenceRank
      isActive
      metadata
      createdAt
      updatedAt
    }
  }
`;

export const DATA_SOURCE_STATS_QUERY = `
  query DataSourceStats($sourceId: ID) {
    dataSourceStats(sourceId: $sourceId) {
      totalSources
      sourceBreakdown {
        sourceId
        recordCount
      }
    }
  }
`;

export const CREATE_DATA_SOURCE_MUTATION = `
  mutation CreateDataSource($input: CreateDataSourceInput!) {
    createDataSource(input: $input) {
      dataSource {
        id
        sourceCode
        sourceName
        sourceType
        vendorName
        feedFormat
        feedFrequency
        connectionConfig
        precedenceRank
        isActive
        metadata
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

export const UPDATE_DATA_SOURCE_MUTATION = `
  mutation UpdateDataSource($input: UpdateDataSourceInput!) {
    updateDataSource(input: $input) {
      dataSource {
        id
        sourceCode
        sourceName
        sourceType
        vendorName
        feedFormat
        feedFrequency
        connectionConfig
        precedenceRank
        isActive
        metadata
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

export const DELETE_DATA_SOURCE_MUTATION = `
  mutation DeleteDataSource($id: ID!) {
    deleteDataSource(id: $id) {
      success
      errors {
        field
        message
        code
      }
    }
  }
`;

export const TEST_DATA_SOURCE_CONNECTION_MUTATION = `
  mutation TestDataSourceConnection($id: ID!) {
    testDataSourceConnection(id: $id) {
      testResult {
        success
        message
        latency
        timestamp
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const TOGGLE_DATA_SOURCE_ACTIVE_MUTATION = `
  mutation ToggleDataSourceActive($id: ID!, $active: Boolean!) {
    toggleDataSourceActive(id: $id, active: $active) {
      dataSource {
        id
        sourceCode
        sourceName
        sourceType
        vendorName
        feedFormat
        feedFrequency
        connectionConfig
        precedenceRank
        isActive
        metadata
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

// ============== DATA CONNECTION QUERIES AND MUTATIONS ==============

export const DATA_CONNECTIONS_QUERY = `
  query DataConnections($type: String, $isActive: Boolean) {
    dataConnections(type: $type, isActive: $isActive) {
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
      loaders {
        id
        loaderCode
        loaderName
      }
    }
  }
`;

export const DATA_CONNECTION_QUERY = `
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

export const CREATE_DATA_CONNECTION_MUTATION = `
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

export const UPDATE_DATA_CONNECTION_MUTATION = `
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

export const DELETE_DATA_CONNECTION_MUTATION = `
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

export const TEST_DATA_CONNECTION_MUTATION = `
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

// ============== DATA LOADER QUERIES AND MUTATIONS ==============

export const DATA_LOADERS_QUERY = `
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

export const DATA_LOADER_QUERY = `
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

export const CREATE_DATA_LOADER_MUTATION = `
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

export const UPDATE_DATA_LOADER_MUTATION = `
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

export const DELETE_DATA_LOADER_MUTATION = `
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

export const TRIGGER_DATA_LOADER_MUTATION = `
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

export const DQ_RULES_QUERY = `
  query DQRules($filter: DQRuleFilter, $pagination: PaginationInput) {
    dqRules(filter: $filter, pagination: $pagination) {
      id
      name
      description
      type
      scope
      scopeRef
      scopeLabel
      threshold
      severity
      enabled
      exceptionCount
      lastEvaluated
      createdAt
      updatedAt
    }
  }
`;

export const CREATE_DQ_RULE_MUTATION = `
  mutation CreateDQRule($input: CreateDQRuleInput!) {
    createDQRule(input: $input) {
      rule {
        id
        name
        description
        type
        scope
        scopeRef
        scopeLabel
        threshold
        severity
        enabled
        exceptionCount
        lastEvaluated
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

export const UPDATE_DQ_RULE_MUTATION = `
  mutation UpdateDQRule($input: UpdateDQRuleInput!) {
    updateDQRule(input: $input) {
      rule {
        id
        name
        description
        type
        scope
        scopeRef
        scopeLabel
        threshold
        severity
        enabled
        exceptionCount
        lastEvaluated
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
