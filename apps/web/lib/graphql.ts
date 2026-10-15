import { Client, cacheExchange, fetchExchange } from '@urql/core';
import { readBrowserAccessToken } from '@/lib/auth-token';

const graphqlEndpoint = process.env.NEXT_PUBLIC_GRAPHQL_ENDPOINT || '/api/graphql';

export const graphqlClient = new Client({
  url: graphqlEndpoint,
  exchanges: [cacheExchange, fetchExchange],
  fetchOptions: () => {
    const token = readBrowserAccessToken();
    return {
      headers: {
        authorization: token ? `Bearer ${token}` : '',
      },
    };
  },
});

export async function graphqlQuery<TData, TVariables extends Record<string, any>>(
  query: string,
  variables?: TVariables,
  requestPolicy?: 'cache-first' | 'cache-and-network' | 'network-only' | 'cache-only'
): Promise<{ data?: TData; error?: any }> {
  const result = await graphqlClient.query(query, variables, {
    requestPolicy: requestPolicy || 'cache-first',
  }).toPromise();
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
  entries: Array<{ entityId: string; relationshipType?: string; relationshipCode: string; isPrimary: boolean; validFrom: string }> | undefined,
  role: 'parent' | 'child'
) {
  if (!entries || entries.length === 0) return undefined;
  return entries.map(entry => ({
    ...(role === 'parent' ? { parentEntityId: entry.entityId } : { childEntityId: entry.entityId }),
    relationshipType: entry.relationshipType || entry.relationshipCode,
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
  query Entity($id: ID, $entityCode: String, $asOfDate: Date) {
    entity(id: $id, entityCode: $entityCode, asOfDate: $asOfDate) {
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
        members { entityId entityCode entityName domainCode }
      }
      childRelationships {
        childEntityId
        childEntityCode
        childEntityName
        childDomainCode
        relationshipType
        relationshipCode
        isPrimary
        members { entityId entityCode entityName domainCode }
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

export const UPDATE_ATTRIBUTE_VALUE_MUTATION = `
  mutation UpdateAttribute($input: UpdateAttributeInput!) {
    updateAttribute(input: $input) {
      success
      goldenValueId
      errors {
        field
        message
        code
      }
    }
  }
`;

export const DELETE_COMPETING_SOURCE_MUTATION = `
  mutation DeleteCompetingSource($input: DeleteCompetingSourceInput!) {
    deleteCompetingSource(input: $input) {
      success
      errors {
        field
        message
        code
      }
    }
  }
`;

export const ADD_COMPETING_SOURCE_MUTATION = `
  mutation AddCompetingSource($input: AddCompetingSourceInput!) {
    addCompetingSource(input: $input) {
      success
      attributeValueId
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
      domainCode
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
      referenceListCode
      defaultPrecedenceChain
      clientId
      clientName
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
      applicabilityRules
      clientId
      clientName
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
        sectionCode
        sectionName
      }
    }
  }
`;

export const FIELD_LINEAGE_QUERY = `
  query FieldLineage($entityId: ID!, $asOfDate: Date, $knowledgeDate: DateTime) {
    fieldLineage(entityId: $entityId, asOfDate: $asOfDate, knowledgeDate: $knowledgeDate) {
      attributeCode
      attributeName
      currentValue
      competingValues {
        source
        sourceName
        value
        precedenceRank
        validFrom
        validTo
        confidenceScore
        receivedAt
      }
      resolutionRule
      lastUpdated
    }
  }
`;

// ============== GOLDEN SOURCE QUERIES ==============

export const GOLDEN_SOURCES_FOR_ENTITY_QUERY = `
  query GoldenSourcesForEntity($entityId: ID!) {
    goldenSourcesForEntity(entityId: $entityId) {
      entityId
      attributeCode
      attributeName
      goldenValue
      goldenSourceCode
      goldenSourceName
      goldenSourceId
      precedenceRank
      isManualOverride
      resolutionRuleApplied
      resolutionVersion
      resolvedAt
      competingValues
      isStale
    }
  }
`;

export const TEMPLATE_PRECEDENCE_CHAIN_QUERY = `
  query TemplatePrecedenceChain($templateId: ID!, $attributeCode: String!) {
    templatePrecedenceChain(templateId: $templateId, attributeCode: $attributeCode) {
      templateId
      attributeCode
      chain
      chainVersion
    }
  }
`;

export const EVALUATE_GOLDEN_SOURCE_QUERY = `
  query EvaluateGoldenSource($entityId: ID!, $attributeCode: String!, $domainCode: String!, $templateId: ID) {
    evaluateGoldenSource(entityId: $entityId, attributeCode: $attributeCode, domainCode: $domainCode, templateId: $templateId) {
      winningSource
      winningSourceId
      tierUsed
      isDefault
      resolutionVersion
      appliedRuleCode
      appliedRuleName
      allCandidates
    }
  }
`;

export const UPDATE_TEMPLATE_PRECEDENCE_CHAIN_MUTATION = `
  mutation UpdateTemplatePrecedenceChain($templateId: ID!, $attributeCode: String!, $chain: [String!]!) {
    updateTemplatePrecedenceChain(templateId: $templateId, attributeCode: $attributeCode, chain: $chain) {
      success
      chainVersion
      entitiesResolved
      errors { field message code }
    }
  }
`;

export const BATCH_RESOLVE_GOLDEN_SOURCES_MUTATION = `
  mutation BatchResolveGoldenSources($domainCode: String!, $attributeCode: String!, $templateCode: String) {
    batchResolveGoldenSources(domainCode: $domainCode, attributeCode: $attributeCode, templateCode: $templateCode) {
      success
      entitiesResolved
      errors { field message code }
    }
  }
`;

export const QUALIFY_ENTITY_TEMPLATE_QUERY = `
  query QualifyEntityTemplate($entityId: ID!, $domainCode: String!) {
    qualifyEntityTemplate(entityId: $entityId, domainCode: $domainCode) {
      templateId
      templateCode
      matched
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
      clientId
      clientName
    }
  }
`;

// ============== DOMAIN-SPECIFIC CONVENIENCE QUERIES ==============

export const FUNDS_QUERY = `
  query Funds($filter: EntityFilter, $pagination: PaginationInput, $asOfDate: Date) {
    funds(filter: $filter, pagination: $pagination, asOfDate: $asOfDate) {
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
  query Issuers($filter: EntityFilter, $pagination: PaginationInput, $asOfDate: Date) {
    issuers(filter: $filter, pagination: $pagination, asOfDate: $asOfDate) {
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
  query Securities($filter: EntityFilter, $pagination: PaginationInput, $asOfDate: Date) {
    securities(filter: $filter, pagination: $pagination, asOfDate: $asOfDate) {
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
  query Deals($filter: EntityFilter, $pagination: PaginationInput, $asOfDate: Date) {
    deals(filter: $filter, pagination: $pagination, asOfDate: $asOfDate) {
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
  query Investors($filter: EntityFilter, $pagination: PaginationInput, $asOfDate: Date) {
    investors(filter: $filter, pagination: $pagination, asOfDate: $asOfDate) {
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
  query Positions($filter: EntityFilter, $pagination: PaginationInput, $asOfDate: Date) {
    positions(filter: $filter, pagination: $pagination, asOfDate: $asOfDate) {
      edges {
        node {
          id
          entityCode
          entityName
          attributes
          parentRelationships {
            parentEntityCode
            parentEntityName
            parentDomainCode
            relationshipType
          }
          childRelationships {
            childEntityCode
            childEntityName
            childDomainCode
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
      clientId
      clientName
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
        clientId
        clientName
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

export const DELETE_ATTRIBUTE_MUTATION = `
  mutation DeleteAttribute($id: ID!) {
    deleteAttribute(id: $id) {
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
        clientId
        clientName
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
        clientId
        clientName
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
        clientId
        clientName
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const UPDATE_ATTRIBUTE_PRECEDENCE_MUTATION = `
  mutation UpdateAttributePrecedence($attributeCode: String!, $chain: [String!]!) {
    updateAttributeDefaultPrecedence(attributeCode: $attributeCode, chain: $chain) {
      success
      errors { field message code }
    }
  }
`;

export const UPDATE_ATTRIBUTE_MUTATION = `
  mutation UpdateAttributeDefinition($input: UpdateAttributeDefinitionInput!) {
    updateAttributeDefinition(input: $input) {
      success
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
        aggregationType
        weightAttributeCode
        numericPrecision
        referenceListCode
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

export const UPDATE_TEMPLATE_MUTATION = `
  mutation UpdateTemplate($id: ID!, $input: UpdateTemplateInput!) {
    updateTemplate(id: $id, input: $input) {
      template {
        id
        templateCode
        templateName
        domainCode
        description
        isActive
        applicabilityRules
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
        }
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const ASSIGN_ATTRIBUTE_TO_TEMPLATE_MUTATION = `
  mutation AssignAttributeToTemplate($input: AssignAttributeInput!) {
    assignAttributeToTemplate(input: $input) {
      assignment {
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
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const UPDATE_TEMPLATE_ATTRIBUTE_MUTATION = `
  mutation UpdateTemplateAttribute($input: UpdateTemplateAttributeInput!) {
    updateTemplateAttribute(input: $input) {
      assignment {
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
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const REORDER_TEMPLATE_ATTRIBUTES_MUTATION = `
  mutation ReorderTemplateAttributes($input: ReorderTemplateAttributesInput!) {
    reorderTemplateAttributes(input: $input) {
      success
      errors {
        field
        message
        code
      }
    }
  }
`;

export const UNASSIGN_ATTRIBUTE_FROM_TEMPLATE_MUTATION = `
  mutation UnassignAttributeFromTemplate($templateId: ID!, $attributeId: ID!) {
    unassignAttributeFromTemplate(templateId: $templateId, attributeId: $attributeId) {
      success
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

export const DATA_QUALITY_DASHBOARD_QUERY = `
  query DataQualityDashboard($domainCode: String, $fromDate: Date, $toDate: Date) {
    dataQualityDashboard(domainCode: $domainCode, fromDate: $fromDate, toDate: $toDate) {
      fromDate
      toDate
      domains
      summary {
        entityCount
        requiredSlots
        populatedSlots
        missingSlots
        entitiesMissingRequired
        availabilityPercent
        rulesEvaluated
        passingChecks
        failingChecks
        entitiesFailingRules
        qualityPercent
        changedAttributeCount
        changedEntityCount
        attributeChangeCount
        clearEntityCount
      }
      availability {
        attributeCode
        attributeName
        domainCode
        requiredCount
        missingCount
        availabilityPercent
        missingEntities { id entityCode entityName domainCode }
      }
      quality {
        ruleId
        ruleCode
        ruleName
        ruleType
        severity
        domainCode
        ruleExpression
        evaluated
        evaluationMessage
        entityCount
        failingCount
        passingCount
        failingEntities { id entityCode entityName domainCode message actualValue }
      }
      trajectory {
        attributeCode
        attributeName
        domainCode
        changeCount
        changes { id entityCode entityName domainCode previousValue currentValue }
      }
      entities {
        id
        entityCode
        entityName
        domainCode
        requiredCount
        missingCount
        availabilityPercent
        missingAttributes { attributeCode attributeName }
        ruleCount
        failingRuleCount
        qualityPercent
        failingRules { ruleId ruleCode ruleName severity message actualValue }
        changeCount
        changes { attributeCode attributeName previousValue currentValue }
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

// ============== INTERSECTION TYPE QUERIES AND MUTATIONS ==============

export const INTERSECTION_TYPES_QUERY = `
  query IntersectionTypes {
    intersectionTypes {
      id
      intersectionCode
      intersectionName
      description
      isActive
      members {
        id
        domainCode
        memberRole
        isRequired
        displayOrder
      }
      createdAt
      updatedAt
    }
  }
`;

export const CREATE_INTERSECTION_TYPE_MUTATION = `
  mutation CreateIntersectionType($input: CreateIntersectionTypeInput!) {
    createIntersectionType(input: $input) {
      intersectionType {
        id
        intersectionCode
        intersectionName
        description
        isActive
        members {
          id
          domainCode
          memberRole
          isRequired
          displayOrder
        }
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const UPDATE_INTERSECTION_TYPE_MUTATION = `
  mutation UpdateIntersectionType($input: UpdateIntersectionTypeInput!) {
    updateIntersectionType(input: $input) {
      intersectionType {
        id
        intersectionCode
        intersectionName
        description
        isActive
        members {
          id
          domainCode
          memberRole
          isRequired
          displayOrder
        }
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const DELETE_INTERSECTION_TYPE_MUTATION = `
  mutation DeleteIntersectionType($id: ID!) {
    deleteIntersectionType(id: $id) {
      success
      errors {
        field
        message
        code
      }
    }
  }
`;

export const CREATE_INTERSECTION_MUTATION = `
  mutation CreateIntersection($input: CreateIntersectionInput!) {
    createIntersection(input: $input) {
      intersection {
        id
        intersectionCode
        intersectionTypeCode
        intersectionTypeName
        members {
          memberRole
          entityId
          entityCode
          entityName
          domainCode
        }
        attributes
        validFrom
        validTo
      }
      errors {
        field
        message
        code
      }
    }
  }
`;

export const INTERSECTION_TYPE_QUERY = `
  query IntersectionType($intersectionCode: String!) {
    intersectionType(intersectionCode: $intersectionCode) {
      id
      intersectionCode
      intersectionName
      description
      isActive
      members {
        id
        domainCode
        memberRole
        isRequired
        displayOrder
      }
    }
  }
`;

export const INTERSECTION_QUERY = `
  query Intersection($intersectionCode: String!, $asOfDate: Date) {
    intersection(intersectionCode: $intersectionCode, asOfDate: $asOfDate) {
      id
      intersectionCode
      intersectionTypeCode
      intersectionTypeName
      members {
        memberRole
        entityId
        entityCode
        entityName
        domainCode
      }
      attributes
      validFrom
      validTo
      metadata
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

// ============== COMPLIANCE RULES ENGINE ==============

const COMPLIANCE_ROLLUP_HOP_FIELDS = `
  relationshipCode
  direction
  recursive
`;

const COMPLIANCE_DIMENSION_FIELDS = `
  sourceScope
  offsetUnit
  offsetAmount
  snapTo
  knowledgeMode
  relationshipPath { ${COMPLIANCE_ROLLUP_HOP_FIELDS} }
`;

const COMPLIANCE_CONDITION_FIELDS = `
  id
  ruleVersionId
  appliesTo
  conditionGroup
  conditionOrder
  attributeCode
  attributeDimension { ${COMPLIANCE_DIMENSION_FIELDS} }
  operator
  value
  compareAttributeCode
  compareDimension { ${COMPLIANCE_DIMENSION_FIELDS} }
  logicOperator
`;

const COMPLIANCE_VERSION_FIELDS = `
  id
  ruleId
  versionNumber
  validFrom
  validTo
  systemFrom
  systemTo
  ruleName
  description
  changeReason
  baseDomainCode
  baseRollupPath { ${COMPLIANCE_ROLLUP_HOP_FIELDS} }
  groupByPath { ${COMPLIANCE_ROLLUP_HOP_FIELDS} }
  groupByAttributeCode
  numeratorAttributeCode
  numeratorAggregation
  numeratorDimension { ${COMPLIANCE_DIMENSION_FIELDS} }
  denominatorDimension { ${COMPLIANCE_DIMENSION_FIELDS} }
  groupByDimension { ${COMPLIANCE_DIMENSION_FIELDS} }
  resultTransform
  denominatorAttributeCode
  denominatorAggregation
  denominatorScope
  denominatorConstantValue
  resultUnit
  limitDirection
  softLimitValue
  hardLimitValue
  defaultSourceScope
  isActive
  conditions { ${COMPLIANCE_CONDITION_FIELDS} }
  metadata
  createdAt
  createdBy
`;

const COMPLIANCE_SCOPE_ASSIGNMENT_FIELDS = `
  id
  ruleId
  scopeType
  entityId
  entityCode
  entityName
  includeChildren
  notes
  createdAt
  createdBy
`;

export const COMPLIANCE_RULES_QUERY = `
  query ComplianceRules($filter: ComplianceRuleFilter) {
    complianceRules(filter: $filter) {
      id
      ruleCode
      ruleName
      ruleCategory
      anchorDomainCode
      appliesToAll
      isActive
      description
      createdAt
      updatedAt
      currentVersion {
        ${COMPLIANCE_VERSION_FIELDS}
      }
    }
  }
`;

export const COMPLIANCE_RULE_QUERY = `
  query ComplianceRule($id: ID, $ruleCode: String) {
    complianceRule(id: $id, ruleCode: $ruleCode) {
      id
      ruleCode
      ruleName
      ruleCategory
      anchorDomainCode
      appliesToAll
      isActive
      description
      metadata
      createdAt
      updatedAt
      createdBy
      versions {
        ${COMPLIANCE_VERSION_FIELDS}
      }
      currentVersion {
        ${COMPLIANCE_VERSION_FIELDS}
      }
      scopeAssignments {
        ${COMPLIANCE_SCOPE_ASSIGNMENT_FIELDS}
      }
    }
  }
`;

export const CREATE_COMPLIANCE_RULE_MUTATION = `
  mutation CreateComplianceRule($input: CreateComplianceRuleInput!) {
    createComplianceRule(input: $input) {
      rule {
        id
        ruleCode
        ruleName
        ruleCategory
        anchorDomainCode
        appliesToAll
        isActive
        description
      }
      errors { field message code }
    }
  }
`;

export const UPDATE_COMPLIANCE_RULE_MUTATION = `
  mutation UpdateComplianceRule($id: ID!, $input: UpdateComplianceRuleInput!) {
    updateComplianceRule(id: $id, input: $input) {
      rule {
        id
        ruleCode
        ruleName
        ruleCategory
        appliesToAll
        isActive
        description
      }
      errors { field message code }
    }
  }
`;

export const DELETE_COMPLIANCE_RULE_MUTATION = `
  mutation DeleteComplianceRule($id: ID!) {
    deleteComplianceRule(id: $id) {
      success
      errors { field message code }
    }
  }
`;

export const CREATE_COMPLIANCE_RULE_VERSION_MUTATION = `
  mutation CreateComplianceRuleVersion($input: CreateComplianceRuleVersionInput!) {
    createComplianceRuleVersion(input: $input) {
      version {
        ${COMPLIANCE_VERSION_FIELDS}
      }
      errors { field message code }
    }
  }
`;

export const CREATE_COMPLIANCE_SCOPE_ASSIGNMENT_MUTATION = `
  mutation CreateComplianceScopeAssignment($input: CreateComplianceScopeAssignmentInput!) {
    createComplianceScopeAssignment(input: $input) {
      scopeAssignment {
        ${COMPLIANCE_SCOPE_ASSIGNMENT_FIELDS}
      }
      errors { field message code }
    }
  }
`;

export const DELETE_COMPLIANCE_SCOPE_ASSIGNMENT_MUTATION = `
  mutation DeleteComplianceScopeAssignment($id: ID!) {
    deleteComplianceScopeAssignment(id: $id) {
      success
      errors { field message code }
    }
  }
`;

export const EVALUATE_COMPLIANCE_RULE_MUTATION = `
  mutation EvaluateComplianceRule($input: EvaluateComplianceRuleInput!) {
    evaluateComplianceRule(input: $input) {
      run {
        id
        ruleId
        ruleVersionId
        asOfDate
        knowledgeDate
        sourceScope
        runStatus
        errorMessage
        resultCount
        breachCount
        startedAt
        completedAt
      }
      errors { field message code }
    }
  }
`;

export const COMPLIANCE_EVALUATION_RUN_QUERY = `
  query ComplianceEvaluationRun($id: ID!) {
    complianceEvaluationRun(id: $id) {
      id
      ruleId
      ruleVersionId
      asOfDate
      knowledgeDate
      sourceScope
      runStatus
      errorMessage
      resultCount
      breachCount
      triggeredBy
      startedAt
      completedAt
      results {
        id
        anchorEntityId
        anchorEntityCode
        anchorEntityName
        groupByValue
        numeratorValue
        denominatorValue
        computedValue
        limitDirection
        softLimitValue
        hardLimitValue
        status
        breachAmount
        contributingCount
      }
    }
  }
`;

export const COMPLIANCE_EVALUATION_RUNS_QUERY = `
  query ComplianceEvaluationRuns($ruleId: ID, $first: Int) {
    complianceEvaluationRuns(ruleId: $ruleId, first: $first) {
      id
      ruleId
      ruleVersionId
      asOfDate
      knowledgeDate
      sourceScope
      runStatus
      errorMessage
      resultCount
      breachCount
      startedAt
      completedAt
    }
  }
`;

// ============== TENANCY (multi-tenant client/user management) ==============

export const ME_QUERY = `
  query Me {
    me {
      id
      email
      displayName
      isTenantAdmin
      clients {
        id
        clientCode
        clientName
        isActive
        isInternal
      }
      impersonating {
        id
        clientId
        clientName
        reason
        startedAt
      }
    }
  }
`;

export const CLIENTS_QUERY = `
  query Clients {
    clients {
      id
      clientCode
      clientName
      isActive
      isInternal
      createdAt
    }
  }
`;

export const CLIENT_USERS_QUERY = `
  query ClientUsers($clientId: ID!) {
    clientUsers(clientId: $clientId) {
      id
      userId
      isActive
      profile {
        id
        email
        displayName
        isActive
      }
      roles {
        id
        roleCode
        roleName
      }
    }
  }
`;

export const ROLES_QUERY = `
  query Roles($clientId: ID) {
    roles(clientId: $clientId) {
      id
      clientId
      roleCode
      roleName
      description
      isSystemRole
      permissionCodes
    }
  }
`;

export const PERMISSIONS_CATALOG_QUERY = `
  query PermissionsCatalog {
    permissionsCatalog
  }
`;

export const ENTITY_GRANTS_QUERY = `
  query EntityGrants($entityId: ID!) {
    entityGrants(entityId: $entityId) {
      id
      clientId
      entityId
      granteeType
      userId
      roleId
      granteeLabel
      accessLevel
      includeChildren
      createdAt
    }
  }
`;

export const CREATE_CLIENT_MUTATION = `
  mutation CreateClient($input: CreateClientInput!) {
    createClient(input: $input) { success errors { field message code } }
  }
`;

export const CREATE_ROLE_MUTATION = `
  mutation CreateRole($input: CreateRoleInput!) {
    createRole(input: $input) { success errors { field message code } }
  }
`;

export const INVITE_USER_MUTATION = `
  mutation InviteUser($input: InviteUserInput!) {
    inviteUser(input: $input) { success errors { field message code } }
  }
`;

export const ASSIGN_ROLE_MUTATION = `
  mutation AssignRole($input: AssignRoleInput!) {
    assignRole(input: $input) { success errors { field message code } }
  }
`;

export const REVOKE_ROLE_MUTATION = `
  mutation RevokeRole($clientId: ID!, $userId: ID!, $roleId: ID!) {
    revokeRole(clientId: $clientId, userId: $userId, roleId: $roleId) { success errors { field message code } }
  }
`;

export const DEACTIVATE_CLIENT_USER_MUTATION = `
  mutation DeactivateClientUser($clientId: ID!, $userId: ID!) {
    deactivateClientUser(clientId: $clientId, userId: $userId) { success errors { field message code } }
  }
`;

export const GRANT_ENTITY_ACCESS_MUTATION = `
  mutation GrantEntityAccess($input: GrantEntityAccessInput!) {
    grantEntityAccess(input: $input) { success errors { field message code } }
  }
`;

export const REVOKE_ENTITY_ACCESS_MUTATION = `
  mutation RevokeEntityAccess($id: ID!) {
    revokeEntityAccess(id: $id) { success errors { field message code } }
  }
`;

export const START_IMPERSONATION_MUTATION = `
  mutation StartImpersonation($clientId: ID!, $reason: String) {
    startImpersonation(clientId: $clientId, reason: $reason) { success errors { field message code } }
  }
`;

export const STOP_IMPERSONATION_MUTATION = `
  mutation StopImpersonation {
    stopImpersonation { success errors { field message code } }
  }
`;

export const UPDATE_PROFILE_MUTATION = `
  mutation UpdateProfile($input: UpdateProfileInput!) {
    updateProfile(input: $input) {
      success
      profile {
        id
        email
        displayName
        isTenantAdmin
      }
      errors { field message code }
    }
  }
`;

// ============== REFERENCE LIST QUERIES ==============

export const REFERENCE_LISTS_QUERY = `
  query ReferenceLists($domainCode: String, $isActive: Boolean) {
    referenceLists(domainCode: $domainCode, isActive: $isActive) {
      id
      listCode
      listName
      domainCode
      description
      isActive
      activeValueCount
      totalValueCount
      totalSynonymCount
      linkedAttributeCount
      createdAt
      updatedAt
    }
  }
`;

export const REFERENCE_LIST_DETAIL_QUERY = `
  query ReferenceListDetail($listCode: String) {
    referenceList(listCode: $listCode) {
      id
      listCode
      listName
      domainCode
      description
      isActive
      activeValueCount
      totalValueCount
      totalSynonymCount
      linkedAttributeCount
      values {
        id
        valueCode
        valueLabel
        displayOrder
        isActive
        synonyms
      }
      createdAt
      updatedAt
    }
  }
`;

export const NORMALIZE_VALUE_QUERY = `
  query NormalizeValue($listCode: String!, $values: [String!]!) {
    normalizeValue(listCode: $listCode, values: $values) {
      normalized
      input
      canonicalCode
      canonicalLabel
      matchType
      confidence
      message
    }
  }
`;

export const CREATE_REFERENCE_LIST_MUTATION = `
  mutation CreateReferenceList($input: CreateReferenceListInput!) {
    createReferenceList(input: $input) {
      referenceList { id listCode listName }
      errors { field message code }
    }
  }
`;

export const ADD_REFERENCE_LIST_VALUE_MUTATION = `
  mutation AddReferenceListValue($input: AddReferenceListValueInput!) {
    addReferenceListValue(input: $input) {
      value { id valueCode valueLabel synonyms }
      errors { field message code }
    }
  }
`;

export const UPDATE_REFERENCE_LIST_MUTATION = `
  mutation UpdateReferenceList($input: UpdateReferenceListInput!) {
    updateReferenceList(input: $input) {
      referenceList { id listCode listName description isActive }
      errors { field message code }
    }
  }
`;

export const DELETE_REFERENCE_LIST_MUTATION = `
  mutation DeleteReferenceList($id: ID!) {
    deleteReferenceList(id: $id) {
      success
      errors { field message code }
    }
  }
`;

export const UPDATE_REFERENCE_LIST_VALUE_MUTATION = `
  mutation UpdateReferenceListValue($input: UpdateReferenceListValueInput!) {
    updateReferenceListValue(input: $input) {
      value { id valueCode valueLabel synonyms isActive displayOrder }
      errors { field message code }
    }
  }
`;

export const DELETE_REFERENCE_LIST_VALUE_MUTATION = `
  mutation DeleteReferenceListValue($id: ID!) {
    deleteReferenceListValue(id: $id) {
      success
      errors { field message code }
    }
  }
`;

export const ADD_VALUE_SYNONYMS_MUTATION = `
  mutation AddValueSynonyms($input: AddSynonymsInput!) {
    addValueSynonyms(input: $input) {
      value { id valueCode valueLabel synonyms }
      errors { field message code }
    }
  }
`;

export const REMOVE_VALUE_SYNONYMS_MUTATION = `
  mutation RemoveValueSynonyms($input: AddSynonymsInput!) {
    removeValueSynonyms(input: $input) {
      value { id valueCode valueLabel synonyms }
      errors { field message code }
    }
  }
`;

const RECONCILIATION_RUN_FIELDS = `
  id
  anchorEntityId
  anchorEntityCode
  anchorEntityName
  domainCode
  asOfDate
  compareAsOfDate
  status
  stageIndex
  assignedTo
  openBreakCount
  decidedAt
  decisionNotes
  createdAt
  definition {
    id
    definitionCode
    definitionName
    description
    domainCode
    compareMode
    grain
    stages
  }
  identities { code name calculated compareValue variance passed message }
`;

const RECONCILIATION_LINE_FIELDS = `
  lines {
    id
    lineEntityId
    lineCode
    lineName
    attributeCode
    attributeName
    breakKind
    cells { key label value numeric }
    goldenValue
    variance
    isBreak
    status
    resolutionSourceCode
    resolutionValue
    resolutionNotes
  }
`;

export const RECONCILIATION_DEFINITIONS_QUERY = `
  query ReconciliationDefinitions {
    reconciliationDefinitions {
      id
      definitionCode
      definitionName
      description
      domainCode
      compareMode
      grain
      stages
    }
  }
`;

export const RECONCILIATION_RUNS_QUERY = `
  query ReconciliationRuns {
    reconciliationRuns(first: 40) {
      ${RECONCILIATION_RUN_FIELDS}
    }
  }
`;

export const RECONCILIATION_RUN_QUERY = `
  query ReconciliationRun($id: ID!) {
    reconciliationRun(id: $id) {
      ${RECONCILIATION_RUN_FIELDS}
      ${RECONCILIATION_LINE_FIELDS}
    }
  }
`;

export const OPEN_RECONCILIATION_RUN_MUTATION = `
  mutation OpenReconciliationRun($input: OpenReconciliationRunInput!) {
    openReconciliationRun(input: $input) {
      run {
        ${RECONCILIATION_RUN_FIELDS}
      }
      errors { field message code }
    }
  }
`;

export const RESOLVE_RECONCILIATION_LINE_MUTATION = `
  mutation ResolveReconciliationLine($input: ResolveReconciliationLineInput!) {
    resolveReconciliationLine(input: $input) {
      run {
        ${RECONCILIATION_RUN_FIELDS}
        ${RECONCILIATION_LINE_FIELDS}
      }
      errors { field message code }
    }
  }
`;

export const DECIDE_RECONCILIATION_RUN_MUTATION = `
  mutation DecideReconciliationRun($input: DecideReconciliationRunInput!) {
    decideReconciliationRun(input: $input) {
      run {
        ${RECONCILIATION_RUN_FIELDS}
        ${RECONCILIATION_LINE_FIELDS}
      }
      errors { field message code }
    }
  }
`;

export const LINK_ATTRIBUTE_TO_LIST_MUTATION = `
  mutation LinkAttributeToList($attributeId: ID!, $listCode: String!) {
    linkAttributeToList(attributeId: $attributeId, listCode: $listCode) {
      success
      attribute { id attributeCode referenceListCode dataType }
      errors { field message code }
    }
  }
`;
