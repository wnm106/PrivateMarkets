// Auto-generated inlined schema for edge runtime compatibility
export const typeDefs = `

# File: common.graphql
# Scalar Types
scalar Date
scalar DateTime
scalar JSON
scalar UUID

# Enums
enum DomainType {
  FUND
  ISSUER
  DEAL
  SECURITY
  PRICE
  POSITION
}

enum SourceType {
  VENDOR
  INTERNAL
  MANUAL
  CALCULATED
}

enum PositionType {
  EQUITY
  DEBT
  FUND_INTEREST
  DERIVATIVE
  OTHER
}

enum DQRuleType {
  COMPLETENESS
  VALIDITY
  CONSISTENCY
  TIMELINESS
  UNIQUENESS
}

enum DQSeverity {
  CRITICAL
  HIGH
  MEDIUM
  LOW
}

enum DQExceptionStatus {
  OPEN
  IN_REVIEW
  RESOLVED
  WAIVED
  FALSE_POSITIVE
}

# Common Types
type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

input PaginationInput {
  first: Int
  after: String
  last: Int
  before: String
}

type MutationError {
  field: String
  message: String!
  code: String!
}

# Temporal Types
type TemporalValue {
  value: String
  validFrom: Date!
  validTo: Date!
  systemFrom: DateTime!
  systemTo: DateTime!
  source: String!
  isOverride: Boolean!
}

type SourceValue {
  source: String!
  sourceName: String!
  value: String
  precedenceRank: Int!
  validFrom: Date!
  validTo: Date!
  confidenceScore: Float
  receivedAt: DateTime
}

type FieldLineage {
  attributeCode: String!
  attributeName: String!
  currentValue: String
  competingValues: [SourceValue!]!
  resolutionRule: String
  lastUpdated: DateTime!
}

# Attribute Definition with Derived Attribute Support
type AttributeDefinition {
  id: ID!
  attributeCode: String!
  attributeName: String!
  dataType: String!
  description: String
  unitOfMeasure: String
  isRequired: Boolean!
  isMultiValued: Boolean!
  referenceDomainCode: String
  domainCode: String
  defaultPrecedenceRank: Int!
  
  # Derived attribute fields
  isDerived: Boolean!
  derivationType: String
  derivationFormula: String
  derivationDependencies: [String!]
  formulaLanguage: String

  # Time dimension fields
  isTimeVarying: Boolean!
  timeDimension: String

  # Display and validation metadata
  displayFormat: String
  listValues: [String!]
  validationRules: JSON
  defaultValue: String
  displaySection: String
  displayGroup: Int
  isEditable: Boolean!
  isVisible: Boolean!
  
  # Aggregation and precision
  aggregationType: String
  weightAttributeCode: String
  numericPrecision: Int

  # Reference list linkage
  referenceListCode: String
  referenceList: ReferenceListSummary

  # Global source sequence. Templates override this only when they set their own chain.
  defaultPrecedenceChain: [String!]!
}

# Derivation evaluation result
type DerivationResult {
  attributeCode: String!
  value: JSON
  derivationType: String!
  dependencies: [String!]!
  evaluatedAt: DateTime!
}

# File: dataquality.graphql
# Data Quality Types

type DQRule {
  id: ID!
  ruleCode: String!
  ruleName: String!
  domainCode: DomainType
  attributeCode: String
  ruleType: DQRuleType!
  severity: DQSeverity!
  ruleExpression: String!
  ruleDescription: String
  thresholdValue: Float
  isActive: Boolean!
  autoRemediate: Boolean!
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
}

type DQException {
  id: ID!
  ruleId: ID!
  rule: DQRule!
  entityId: ID!
  entityCode: String!
  entityName: String!
  domainCode: DomainType!
  attributeId: ID
  attributeCode: String
  attributeName: String
  
  # Exception Details
  exceptionType: String!
  exceptionMessage: String!
  expectedValue: String
  actualValue: String
  severity: DQSeverity!
  
  # Status
  status: DQExceptionStatus!
  assignedTo: String
  assignedToUser: String
  resolvedAt: DateTime
  resolvedBy: String
  resolutionNotes: String
  
  # Temporal
  detectedAt: DateTime!
  validFrom: Date!
  validTo: Date!
  
  # Metadata
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
}

type DQExceptionConnection {
  edges: [DQExceptionEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type DQExceptionEdge {
  node: DQException!
  cursor: String!
}

input DQRuleFilter {
  ruleCode: StringFilter
  ruleName: StringFilter
  domainCode: DomainType
  ruleType: DQRuleType
  severity: DQSeverity
  isActive: Boolean
}

input DQExceptionFilter {
  ruleId: IDFilter
  entityId: IDFilter
  entityCode: StringFilter
  domainCode: DomainType
  attributeCode: StringFilter
  exceptionType: StringFilter
  severity: DQSeverity
  status: DQExceptionStatus
  assignedTo: StringFilter
  detectedAtRange: DateRangeFilter
}

input CreateDQRuleInput {
  ruleCode: String!
  ruleName: String!
  domainCode: DomainType
  attributeCode: String
  ruleType: DQRuleType!
  severity: DQSeverity!
  ruleExpression: String!
  ruleDescription: String
  thresholdValue: Float
  autoRemediate: Boolean
}

input UpdateDQRuleInput {
  id: ID!
  ruleName: String
  ruleExpression: String
  ruleDescription: String
  thresholdValue: Float
  isActive: Boolean
  autoRemediate: Boolean
}

input ResolveDQExceptionInput {
  exceptionId: ID!
  status: DQExceptionStatus!
  resolutionNotes: String
}

type CreateDQRuleResult {
  rule: DQRule
  errors: [MutationError!]!
}

type UpdateDQRuleResult {
  rule: DQRule
  errors: [MutationError!]!
}

type ResolveDQExceptionResult {
  success: Boolean!
  errors: [MutationError!]!
}

# File: compliance.graphql
# Compliance Rules Engine Types
# Bi-temporal, entity-level-agnostic investment/regulatory limit rules.
# Distinct from DQRule (data_quality): compliance rules express concentration,
# exposure, diversification, eligibility, leverage, and liquidity tests with
# numerator/denominator calculations, hard/soft limits, and aggregate rollups.

enum ComplianceRuleCategory {
  CONCENTRATION
  EXPOSURE
  DIVERSIFICATION
  ELIGIBILITY
  LEVERAGE
  LIQUIDITY
  OTHER
}

enum ComplianceAggregation {
  SUM
  AVG
  COUNT
  MIN
  MAX
  VALUE
  CONSTANT
}

enum ComplianceDenominatorScope {
  SAME_GROUP
  ANCHOR_TOTAL
  CONSTANT
}

enum ComplianceResultUnit {
  RATIO
  PERCENTAGE
  CURRENCY
  COUNT
}

enum ComplianceLimitDirection {
  MAX
  MIN
}

enum ComplianceResultStatus {
  PASS
  SOFT_BREACH
  HARD_BREACH
  NO_DATA
  ERROR
}

enum ComplianceRunStatus {
  RUNNING
  COMPLETED
  FAILED
}

enum ComplianceOffsetUnit {
  DAY
  WEEK
  MONTH
  QUARTER
  YEAR
}

enum CompliancePeriodSnap {
  MONTH_END
  QUARTER_END
  YEAR_END
}

enum ComplianceKnowledgeMode {
  RUN
  AT_OFFSET_DATE
}

enum ComplianceResultTransform {
  NONE
  DIFFERENCE
  ABS_DIFFERENCE
  PCT_CHANGE
  ABS_PCT_CHANGE
}

enum ComplianceConditionScope {
  BASE
  ANCHOR
}

enum ComplianceScopeType {
  INCLUDE
  EXCLUDE
}

type ComplianceRule {
  id: ID!
  ruleCode: String!
  ruleName: String!
  ruleCategory: ComplianceRuleCategory!
  anchorDomainCode: String!
  appliesToAll: Boolean!
  isActive: Boolean!
  description: String
  scopeAssignments: [ComplianceScopeAssignment!]!
  versions: [ComplianceRuleVersion!]!
  currentVersion(asOfDate: Date, knowledgeDate: DateTime): ComplianceRuleVersion
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
  createdBy: String
}

# Source / time dimension of an attribute reference. All fields optional;
# empty = the run's source scope (GOLDEN) at the run's as-of date.
type ComplianceAttributeDimension {
  sourceScope: String
  offsetUnit: ComplianceOffsetUnit
  offsetAmount: Int
  snapTo: CompliancePeriodSnap
  knowledgeMode: ComplianceKnowledgeMode
  # Hops from the entity being tested to the entity that holds the attribute.
  # Empty = read the attribute on the entity itself.
  relationshipPath: [ComplianceRollupHop!]!
}

input ComplianceAttributeDimensionInput {
  sourceScope: String
  offsetUnit: ComplianceOffsetUnit
  offsetAmount: Int
  snapTo: CompliancePeriodSnap
  knowledgeMode: ComplianceKnowledgeMode
  relationshipPath: [ComplianceRollupHopInput!]
}

type ComplianceRollupHop {
  relationshipCode: String!
  direction: String! # UP | DOWN
  recursive: Boolean!
}

type ComplianceRuleVersion {
  id: ID!
  ruleId: ID!
  versionNumber: Int!
  # Bi-temporal
  validFrom: Date!
  validTo: Date!
  systemFrom: DateTime!
  systemTo: DateTime!
  # Descriptive
  ruleName: String!
  description: String
  changeReason: String
  # Rollup definition
  baseDomainCode: String!
  baseRollupPath: [ComplianceRollupHop!]!
  groupByPath: [ComplianceRollupHop!]!
  groupByAttributeCode: String
  # Numerator / denominator
  numeratorAttributeCode: String!
  numeratorAggregation: ComplianceAggregation!
  numeratorDimension: ComplianceAttributeDimension
  denominatorDimension: ComplianceAttributeDimension
  groupByDimension: ComplianceAttributeDimension
  resultTransform: ComplianceResultTransform!
  denominatorAttributeCode: String
  denominatorAggregation: ComplianceAggregation
  denominatorScope: ComplianceDenominatorScope!
  denominatorConstantValue: Float
  resultUnit: ComplianceResultUnit!
  # Limits
  limitDirection: ComplianceLimitDirection!
  softLimitValue: Float
  hardLimitValue: Float
  defaultSourceScope: String!
  isActive: Boolean!
  conditions: [ComplianceRuleCondition!]!
  metadata: JSON
  createdAt: DateTime!
  createdBy: String
}

type ComplianceRuleCondition {
  id: ID!
  ruleVersionId: ID!
  appliesTo: ComplianceConditionScope!
  conditionGroup: Int!
  conditionOrder: Int!
  attributeCode: String!
  attributeDimension: ComplianceAttributeDimension
  operator: String!
  value: String
  compareAttributeCode: String
  compareDimension: ComplianceAttributeDimension
  logicOperator: String!
  createdAt: DateTime!
}

type ComplianceScopeAssignment {
  id: ID!
  ruleId: ID!
  scopeType: ComplianceScopeType!
  entityId: ID!
  entityCode: String
  entityName: String
  includeChildren: Boolean!
  notes: String
  createdAt: DateTime!
  createdBy: String
}

type ComplianceEvaluationRun {
  id: ID!
  ruleId: ID!
  rule: ComplianceRule
  ruleVersionId: ID!
  asOfDate: Date!
  knowledgeDate: DateTime!
  sourceScope: String!
  runStatus: ComplianceRunStatus!
  errorMessage: String
  resultCount: Int
  breachCount: Int
  triggeredBy: String
  startedAt: DateTime!
  completedAt: DateTime
  results: [ComplianceEvaluationResult!]!
}

type ComplianceEvaluationResult {
  id: ID!
  runId: ID!
  ruleId: ID!
  ruleVersionId: ID!
  anchorEntityId: ID!
  anchorEntityCode: String
  anchorEntityName: String
  groupByValue: String
  asOfDate: Date!
  knowledgeDate: DateTime!
  sourceScope: String!
  numeratorValue: Float
  denominatorValue: Float
  computedValue: Float
  limitDirection: ComplianceLimitDirection
  softLimitValue: Float
  hardLimitValue: Float
  status: ComplianceResultStatus!
  breachAmount: Float
  contributingEntityIds: [ID!]
  contributingCount: Int
  detail: JSON
  evaluatedAt: DateTime!
}

type ComplianceEvaluationResultConnection {
  edges: [ComplianceEvaluationResultEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type ComplianceEvaluationResultEdge {
  node: ComplianceEvaluationResult!
  cursor: String!
}

# -------------------- Filters --------------------

input ComplianceRuleFilter {
  ruleCode: StringFilter
  ruleCategory: ComplianceRuleCategory
  anchorDomainCode: String
  isActive: Boolean
}

input ComplianceResultFilter {
  ruleId: IDFilter
  anchorEntityId: IDFilter
  status: ComplianceResultStatus
  runId: IDFilter
  asOfDateRange: DateRangeFilter
}

# -------------------- Inputs --------------------

input ComplianceRollupHopInput {
  relationshipCode: String!
  direction: String!
  recursive: Boolean
}

input CreateComplianceRuleInput {
  ruleCode: String!
  ruleName: String!
  ruleCategory: ComplianceRuleCategory!
  anchorDomainCode: String!
  appliesToAll: Boolean
  description: String
  metadata: JSON
}

input UpdateComplianceRuleInput {
  ruleName: String
  ruleCategory: ComplianceRuleCategory
  appliesToAll: Boolean
  isActive: Boolean
  description: String
  metadata: JSON
}

input CreateComplianceRuleVersionInput {
  ruleId: ID!
  validFrom: Date!
  validTo: Date
  ruleName: String!
  description: String
  changeReason: String
  baseDomainCode: String!
  baseRollupPath: [ComplianceRollupHopInput!]
  groupByPath: [ComplianceRollupHopInput!]
  groupByAttributeCode: String
  numeratorAttributeCode: String!
  numeratorAggregation: ComplianceAggregation!
  numeratorDimension: ComplianceAttributeDimensionInput
  denominatorDimension: ComplianceAttributeDimensionInput
  groupByDimension: ComplianceAttributeDimensionInput
  resultTransform: ComplianceResultTransform
  denominatorAttributeCode: String
  denominatorAggregation: ComplianceAggregation
  denominatorScope: ComplianceDenominatorScope
  denominatorConstantValue: Float
  resultUnit: ComplianceResultUnit
  limitDirection: ComplianceLimitDirection!
  softLimitValue: Float
  hardLimitValue: Float
  defaultSourceScope: String
  conditions: [ComplianceRuleConditionInput!]
  metadata: JSON
}

input ComplianceRuleConditionInput {
  appliesTo: ComplianceConditionScope!
  conditionGroup: Int
  conditionOrder: Int
  attributeCode: String!
  attributeDimension: ComplianceAttributeDimensionInput
  operator: String!
  value: String
  compareAttributeCode: String
  compareDimension: ComplianceAttributeDimensionInput
  logicOperator: String
}

input CreateComplianceScopeAssignmentInput {
  ruleId: ID!
  scopeType: ComplianceScopeType!
  entityId: ID!
  includeChildren: Boolean
  notes: String
}

input EvaluateComplianceRuleInput {
  ruleCode: String!
  asOfDate: Date!
  knowledgeDate: DateTime
  sourceScope: String
}

# Draft filter drill-down: which records of a domain qualify before the rule is saved.
input CompliancePopulationPreviewInput {
  domainCode: String!
  conditions: [ComplianceRuleConditionInput!]!
  offset: Int
  limit: Int
}

type CompliancePopulationRow {
  entityId: ID!
  entityCode: String!
  entityName: String
  values: JSON!
}

type CompliancePopulationPreview {
  total: Int!
  scanned: Int!
  truncated: Boolean!
  rows: [CompliancePopulationRow!]!
}

# -------------------- Results --------------------

type CreateComplianceRuleResult {
  rule: ComplianceRule
  errors: [MutationError!]!
}

type UpdateComplianceRuleResult {
  rule: ComplianceRule
  errors: [MutationError!]!
}

type DeleteComplianceRuleResult {
  success: Boolean!
  errors: [MutationError!]!
}

type CreateComplianceRuleVersionResult {
  version: ComplianceRuleVersion
  errors: [MutationError!]!
}

type CreateComplianceScopeAssignmentResult {
  scopeAssignment: ComplianceScopeAssignment
  errors: [MutationError!]!
}

type DeleteComplianceScopeAssignmentResult {
  success: Boolean!
  errors: [MutationError!]!
}

type EvaluateComplianceRuleResult {
  run: ComplianceEvaluationRun
  errors: [MutationError!]!
}

# File: deal.graphql
# Deal Domain Types

type Deal {
  id: ID!
  entityCode: String!
  entityName: String!
  description: String
  isActive: Boolean!
  templateId: ID
  
  # Core Attributes
  dealDate: Date
  dealType: String
  dealSubType: String
  dealValue: Float
  dealValueCurrency: String
  enterpriseValue: Float
  equityValue: Float
  debtValue: Float
  status: String
  closingDate: Date
  announcementDate: Date
  transactionStatus: String
  dealRole: String
  feePercentage: Float
  feeAmount: Float
  
  # Relationships
  issuer: Issuer
  issuerId: ID
  fund: Fund
  fundId: ID
  
  # Source Tracking
  lastUpdated: DateTime
  
  # Lineage
  lineage: [FieldLineage!]
  
  # Metadata
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
  createdBy: String
  updatedBy: String
}

type DealConnection {
  edges: [DealEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type DealEdge {
  node: Deal!
  cursor: String!
}

input DealFilter {
  entityCode: StringFilter
  entityName: StringFilter
  dealType: StringFilter
  dealSubType: StringFilter
  status: StringFilter
  transactionStatus: StringFilter
  dealValueRange: FloatRangeFilter
  dealDateRange: DateRangeFilter
  closingDateRange: DateRangeFilter
  issuerId: IDFilter
  fundId: IDFilter
  isActive: Boolean
}

input CreateDealInput {
  entityCode: String!
  entityName: String!
  description: String
  templateId: ID
  issuerId: ID
  fundId: ID
  attributes: [AttributeInput!]
}

input UpdateDealInput {
  id: ID!
  entityName: String
  description: String
  isActive: Boolean
  issuerId: ID
  fundId: ID
  attributes: [AttributeInput!]
}

type CreateDealResult {
  deal: Deal
  errors: [MutationError!]!
}

type UpdateDealResult {
  deal: Deal
  errors: [MutationError!]!
}

# File: entity.graphql
# Generic Entity Type
type Entity {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  domainName: String!
  templateCode: String
  templateName: String
  description: String
  isActive: Boolean!
  
  # Dynamic attributes from template
  attributes: JSONObject!
  
  # Relationships
  parentRelationships: [EntityRelationship!]!
  childRelationships: [EntityRelationship!]!
  
  # Lineage
  lineage: [FieldLineage!]
  
  # Metadata
  metadata: JSONObject
  createdAt: DateTime!
  updatedAt: DateTime!
}

type EntityRelationship {
  parentEntityId: ID!
  parentEntityCode: String!
  parentEntityName: String!
  parentDomainCode: String!
  childEntityId: ID!
  childEntityCode: String!
  childEntityName: String!
  childDomainCode: String!
  relationshipType: String!
  relationshipCode: String!
  isPrimary: Boolean!
}

type EntityConnection {
  edges: [EntityEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type EntityEdge {
  node: Entity!
  cursor: String!
}

input EntityFilter {
  domainCode: String
  templateCode: String
  entityCode: String
  entityName: String
  isActive: Boolean
  # Attribute-based filters
  attributes: JSONObject
  # Relationship filters
  hasParent: EntityRelationshipFilter
  hasChild: EntityRelationshipFilter
}

input EntityRelationshipFilter {
  entityCode: String
  domainCode: String
  relationshipType: String
}

input CreateEntityInput {
  entityCode: String!
  entityName: String!
  domainCode: String!
  templateCode: String
  description: String
  attributes: JSONObject!
  parentRelationships: [EntityRelationshipInput!]
  childRelationships: [EntityRelationshipInput!]
}

input UpdateEntityInput {
  id: ID!
  entityName: String
  description: String
  isActive: Boolean
  attributes: JSONObject
  parentRelationships: [EntityRelationshipInput!]
  childRelationships: [EntityRelationshipInput!]
}

input EntityRelationshipInput {
  parentEntityId: ID!
  childEntityId: ID!
  relationshipType: String!
  relationshipCode: String!
  isPrimary: Boolean
  validFrom: Date!
}

type CreateEntityResult {
  entity: Entity
  errors: [MutationError!]!
}

type UpdateEntityResult {
  entity: Entity
  errors: [MutationError!]!
}

# Relationship Type Metadata
type RelationshipType {
  id: ID!
  relationshipCode: String!
  relationshipName: String!
  parentDomainCode: String
  childDomainCode: String
  description: String
  isActive: Boolean!
  isRequired: Boolean!
  cardinality: String!
  compositeKey: [String!]!
}

type CreateRelationshipResult {
  relationship: EntityRelationship
  errors: [MutationError!]!
}

type UpdateRelationshipResult {
  relationship: EntityRelationship
  errors: [MutationError!]!
}

type DeleteRelationshipResult {
  success: Boolean!
  errors: [MutationError!]!
}

input UpdateRelationshipInput {
  id: ID!
  isPrimary: Boolean
  validFrom: Date
  validTo: Date
}

# Metadata creation inputs
input CreateDomainTypeInput {
  domainCode: String!
  domainName: String!
  description: String
}

type CreateDomainTypeResult {
  domainType: DomainTypeRecord
  errors: [MutationError!]!
}

input CreateAttributeInput {
  attributeCode: String!
  attributeName: String!
  dataType: String!
  description: String
  unitOfMeasure: String
  validationRegex: String
  isRequired: Boolean
  isMultiValued: Boolean
  referenceDomainCode: String
  domainCode: String
}

type CreateAttributeResult {
  attribute: AttributeDefinition
  errors: [MutationError!]!
}

input CreateTemplateInput {
  templateCode: String!
  domainCode: String!
  templateName: String!
  description: String
}

type CreateTemplateResult {
  template: Template
  errors: [MutationError!]!
}

input UpdateTemplateInput {
  templateName: String
  description: String
  isActive: Boolean
  applicabilityRules: JSON
}

type UpdateTemplateResult {
  template: Template
  errors: [MutationError!]!
}

input AssignAttributeInput {
  templateId: ID!
  attributeId: ID!
  isRequired: Boolean
  precedenceRank: Int
  displayOrder: Int
  displayLabel: String
}

type AssignAttributeResult {
  assignment: TemplateAttribute
  errors: [MutationError!]!
}

input UpdateTemplateAttributeInput {
  templateId: ID!
  attributeId: ID!
  isRequired: Boolean
  precedenceRank: Int
  displayOrder: Int
  displayLabel: String
}

type UpdateTemplateAttributeResult {
  assignment: TemplateAttribute
  errors: [MutationError!]!
}

input ReorderTemplateAttributesInput {
  templateId: ID!
  attributeIds: [ID!]!
}

type ReorderTemplateAttributesResult {
  success: Boolean!
  errors: [MutationError!]!
}

# Scalar for JSON objects
scalar JSONObject

# Domain Type Record (distinct from DomainType enum, used for managing domain types)
type DomainTypeRecord {
  id: ID!
  domainCode: String!
  domainName: String!
  description: String
  isActive: Boolean!
  createdAt: DateTime!
  updatedAt: DateTime!
}

# Domain Type mutation inputs and results
input UpdateDomainTypeInput {
  id: ID!
  domainName: String
  description: String
  isActive: Boolean
}

type UpdateDomainTypeResult {
  domainType: DomainTypeRecord
  errors: [MutationError!]!
}

type DeleteDomainTypeResult {
  success: Boolean!
  errors: [MutationError!]!
}

# File: filters.graphql
# Filter Input Types

input StringFilter {
  equals: String
  contains: String
  startsWith: String
  endsWith: String
  in: [String!]
  notIn: [String!]
}

input FloatRangeFilter {
  equals: Float
  gt: Float
  gte: Float
  lt: Float
  lte: Float
  between: [Float!]
}

input IntRangeFilter {
  equals: Int
  gt: Int
  gte: Int
  lt: Int
  lte: Int
  between: [Int!]
}

input DateRangeFilter {
  equals: Date
  gt: Date
  gte: Date
  lt: Date
  lte: Date
  between: [Date!]
}

input DateTimeRangeFilter {
  equals: DateTime
  gt: DateTime
  gte: DateTime
  lt: DateTime
  lte: DateTime
  between: [DateTime!]
}

input IDFilter {
  equals: ID
  in: [ID!]
  notIn: [ID!]
}

input BooleanFilter {
  equals: Boolean
}

# Common Attribute Input
input AttributeInput {
  attributeCode: String!
  value: String
  valueNumeric: Float
  valueDate: Date
  valueTimestamp: DateTime
  valueBoolean: Boolean
  validFrom: Date
  sourceId: ID
  confidenceScore: Float
}

# File: fund.graphql
# Fund Domain Types

type Fund {
  id: ID!
  entityCode: String!
  entityName: String!
  description: String
  isActive: Boolean!
  templateId: ID
  
  # Core Attributes
  nav: Float
  navCurrency: String
  navDate: Date
  inceptionDate: Date
  fundStatus: String
  fundType: String
  manager: String
  aum: Float
  expenseRatio: Float
  domicile: String
  legalStructure: String
  
  # Source Tracking
  navSource: String
  lastUpdated: DateTime
  
  # Lineage
  lineage: [FieldLineage!]
  
  # Metadata
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
  createdBy: String
  updatedBy: String
}

type FundConnection {
  edges: [FundEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type FundEdge {
  node: Fund!
  cursor: String!
}

input FundFilter {
  entityCode: StringFilter
  entityName: StringFilter
  fundStatus: StringFilter
  fundType: StringFilter
  manager: StringFilter
  domicile: StringFilter
  navRange: FloatRangeFilter
  aumRange: FloatRangeFilter
  navDateRange: DateRangeFilter
  inceptionDateRange: DateRangeFilter
  isActive: Boolean
}

input CreateFundInput {
  entityCode: String!
  entityName: String!
  description: String
  templateId: ID
  attributes: [AttributeInput!]
}

input UpdateFundInput {
  id: ID!
  entityName: String
  description: String
  isActive: Boolean
  attributes: [AttributeInput!]
}

type CreateFundResult {
  fund: Fund
  errors: [MutationError!]!
}

type UpdateFundResult {
  fund: Fund
  errors: [MutationError!]!
}

# File: intersection.graphql
# Intersection Types: Generic composite entity framework

# Intersection Type Definition (metadata)
type IntersectionType {
  id: ID!
  intersectionCode: String!
  intersectionName: String!
  description: String
  isActive: Boolean!
  members: [IntersectionTypeMember!]!
  createdAt: DateTime!
  updatedAt: DateTime!
}

# Intersection Type Member (defines which entity domains compose this intersection)
type IntersectionTypeMember {
  id: ID!
  intersectionTypeId: ID!
  domainCode: String!
  memberRole: String!
  isRequired: Boolean!
  displayOrder: Int!
}

# Intersection Instance (actual intersection record)
type Intersection {
  id: ID!
  intersectionCode: String!
  intersectionTypeCode: String!
  intersectionTypeName: String!
  
  # Members (constituent entities)
  members: [IntersectionMember!]!
  
  # Attributes (intersection-specific data)
  attributes: JSONObject!
  
  # Temporal
  validFrom: Date!
  validTo: Date!
  
  # Metadata
  metadata: JSONObject
  createdAt: DateTime!
  updatedAt: DateTime!
}

# Intersection Member (links intersection to constituent entity)
type IntersectionMember {
  memberRole: String!
  entityId: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
}

type IntersectionConnection {
  edges: [IntersectionEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type IntersectionEdge {
  node: Intersection!
  cursor: String!
}

input IntersectionFilter {
  intersectionTypeCode: String
  intersectionCode: String
  memberEntityId: ID
  memberRole: String
  isActive: Boolean
}

input CreateIntersectionTypeInput {
  intersectionCode: String!
  intersectionName: String!
  description: String
  members: [IntersectionTypeMemberInput!]!
}

input IntersectionTypeMemberInput {
  domainCode: String!
  memberRole: String!
  isRequired: Boolean
  displayOrder: Int
}

type CreateIntersectionTypeResult {
  intersectionType: IntersectionType
  errors: [MutationError!]!
}

input UpdateIntersectionTypeInput {
  id: ID!
  intersectionName: String
  description: String
  isActive: Boolean
}

type UpdateIntersectionTypeResult {
  intersectionType: IntersectionType
  errors: [MutationError!]!
}

type DeleteIntersectionTypeResult {
  success: Boolean!
  errors: [MutationError!]!
}

input CreateIntersectionInput {
  intersectionCode: String!
  intersectionTypeCode: String!
  members: [IntersectionMemberInput!]!
  attributes: JSONObject
  validFrom: Date!
  metadata: JSONObject
}

input IntersectionMemberInput {
  entityId: ID!
  memberRole: String!
}

type CreateIntersectionResult {
  intersection: Intersection
  errors: [MutationError!]!
}

input UpdateIntersectionInput {
  id: ID!
  members: [IntersectionMemberInput!]
  attributes: JSONObject
  metadata: JSONObject
}

type UpdateIntersectionResult {
  intersection: Intersection
  errors: [MutationError!]!
}

type DeleteIntersectionResult {
  success: Boolean!
  errors: [MutationError!]!
}

# File: issuer.graphql
# Issuer Domain Types

type Issuer {
  id: ID!
  entityCode: String!
  entityName: String!
  description: String
  isActive: Boolean!
  templateId: ID
  
  # Core Attributes
  lei: String
  country: String
  sector: String
  industry: String
  subIndustry: String
  marketCap: Float
  marketCapCurrency: String
  creditRating: String
  ratingAgency: String
  employeeCount: Int
  website: String
  foundedDate: Date
  isPublic: Boolean
  tickerSymbol: String
  exchange: String
  
  # Source Tracking
  lastUpdated: DateTime
  
  # Relationships
  securities: SecurityConnection
  
  # Lineage
  lineage: [FieldLineage!]
  
  # Metadata
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
  createdBy: String
  updatedBy: String
}

type IssuerConnection {
  edges: [IssuerEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type IssuerEdge {
  node: Issuer!
  cursor: String!
}

input IssuerFilter {
  entityCode: StringFilter
  entityName: StringFilter
  country: StringFilter
  sector: StringFilter
  industry: StringFilter
  creditRating: StringFilter
  marketCapRange: FloatRangeFilter
  isPublic: Boolean
  isActive: Boolean
}

input CreateIssuerInput {
  entityCode: String!
  entityName: String!
  description: String
  templateId: ID
  attributes: [AttributeInput!]
}

input UpdateIssuerInput {
  id: ID!
  entityName: String
  description: String
  isActive: Boolean
  attributes: [AttributeInput!]
}

type CreateIssuerResult {
  issuer: Issuer
  errors: [MutationError!]!
}

type UpdateIssuerResult {
  issuer: Issuer
  errors: [MutationError!]!
}

# File: position.graphql
# Position Domain Types

type Position {
  id: ID!
  intersectionCode: String!
  positionType: PositionType!
  quantity: Float
  currency: String!
  isActive: Boolean!
  
  # Relationships
  fund: Fund
  fundId: ID
  issuer: Issuer
  issuerId: ID
  deal: Deal
  dealId: ID
  security: Security
  securityId: ID
  
  # Metrics
  marketValue: Float
  costBasis: Float
  unrealizedGainLoss: Float
  realizedGainLoss: Float
  dailyReturn: Float
  mtdReturn: Float
  ytdReturn: Float
  sinceInceptionReturn: Float
  beta: Float
  volatility: Float
  var95: Float
  metricsDate: Date
  
  # Temporal
  validFrom: Date!
  validTo: Date!
  
  # Metadata
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
  createdBy: String
}

type PositionConnection {
  edges: [PositionEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type PositionEdge {
  node: Position!
  cursor: String!
}

input PositionFilter {
  intersectionCode: StringFilter
  positionType: StringFilter
  currency: StringFilter
  fundId: IDFilter
  issuerId: IDFilter
  dealId: IDFilter
  securityId: IDFilter
  marketValueRange: FloatRangeFilter
  validFromRange: DateRangeFilter
  isActive: Boolean
}

input CreatePositionInput {
  intersectionCode: String!
  positionType: PositionType!
  fundId: ID
  issuerId: ID
  dealId: ID
  securityId: ID
  quantity: Float
  currency: String!
  validFrom: Date!
  metadata: JSON
}

input UpdatePositionInput {
  id: ID!
  quantity: Float
  metadata: JSON
}

type CreatePositionResult {
  position: Position
  errors: [MutationError!]!
}

type UpdatePositionResult {
  position: Position
  errors: [MutationError!]!
}

# File: price.graphql
# Price Domain Types

type Price {
  id: ID!
  entityCode: String!
  entityName: String!
  description: String
  isActive: Boolean!
  templateId: ID
  
  # Core Attributes
  price: Float!
  priceDate: Date!
  priceTime: DateTime
  priceType: String
  currency: String!
  exchange: String
  bidPrice: Float
  askPrice: Float
  midPrice: Float
  lastTradePrice: Float
  openPrice: Float
  highPrice: Float
  lowPrice: Float
  volume: Float
  adjustedClosePrice: Float
  
  # Relationships
  security: Security
  securityId: ID
  
  # Source Tracking
  source: String
  confidenceScore: Float
  
  # Lineage
  lineage: [FieldLineage!]
  
  # Metadata
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
  createdBy: String
  updatedBy: String
}

type PriceConnection {
  edges: [PriceEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type PriceEdge {
  node: Price!
  cursor: String!
}

input PriceFilter {
  entityCode: StringFilter
  priceRange: FloatRangeFilter
  priceDateRange: DateRangeFilter
  priceType: StringFilter
  currency: StringFilter
  exchange: StringFilter
  securityId: IDFilter
  source: StringFilter
  isActive: Boolean
}

input CreatePriceInput {
  entityCode: String!
  entityName: String!
  securityId: ID!
  price: Float!
  priceDate: Date!
  currency: String!
  priceType: String
  attributes: [AttributeInput!]
}

input UpdatePriceInput {
  id: ID!
  price: Float
  priceDate: Date
  attributes: [AttributeInput!]
}

type CreatePriceResult {
  price: Price
  errors: [MutationError!]!
}

type UpdatePriceResult {
  price: Price
  errors: [MutationError!]!
}

# File: tenancy.graphql
# Multi-tenant client/user management: tenants, membership, RBAC, entity ACLs, impersonation

type Client {
  id: ID!
  clientCode: String!
  clientName: String!
  isActive: Boolean!
  isInternal: Boolean!
  createdAt: DateTime!
}

type Role {
  id: ID!
  clientId: ID
  roleCode: String!
  roleName: String!
  description: String
  isSystemRole: Boolean!
  permissionCodes: [String!]!
}

type Profile {
  id: ID!
  email: String
  displayName: String
  isTenantAdmin: Boolean!
  isActive: Boolean!
}

type ClientUser {
  id: ID!
  clientId: ID!
  userId: ID!
  isActive: Boolean!
  profile: Profile
  roles: [Role!]!
}

type EntityGrant {
  id: ID!
  clientId: ID!
  entityId: ID!
  granteeType: String!
  userId: ID
  roleId: ID
  granteeLabel: String
  accessLevel: String!
  includeChildren: Boolean!
  createdAt: DateTime!
}

type ImpersonationSession {
  id: ID!
  clientId: ID!
  clientName: String
  reason: String
  startedAt: DateTime!
}

type Me {
  id: ID!
  email: String
  displayName: String
  isTenantAdmin: Boolean!
  clients: [Client!]!
  impersonating: ImpersonationSession
}

type UpdateProfileResult {
  success: Boolean!
  profile: Me
  errors: [MutationError!]!
}

input UpdateProfileInput {
  displayName: String
}

type MutationResult {
  success: Boolean!
  errors: [MutationError!]!
}

input CreateClientInput {
  clientCode: String!
  clientName: String!
  adminEmail: String
}

input CreateRoleInput {
  clientId: ID!
  roleCode: String!
  roleName: String!
  description: String
  permissionCodes: [String!]!
}

input InviteUserInput {
  clientId: ID!
  email: String!
  roleIds: [ID!]!
}

input AssignRoleInput {
  clientId: ID!
  userId: ID!
  roleId: ID!
}

input GrantEntityAccessInput {
  clientId: ID!
  entityId: ID!
  granteeType: String!
  userId: ID
  roleId: ID
  accessLevel: String!
  includeChildren: Boolean!
}

# File: referencelist.graphql
# Reference List Types

type ReferenceListSummary {
  id: ID!
  listCode: String!
  listName: String!
  domainCode: String
  description: String
  isActive: Boolean!
  activeValueCount: Int!
  totalValueCount: Int!
  totalSynonymCount: Int!
  linkedAttributeCount: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type ReferenceListDetail {
  id: ID!
  listCode: String!
  listName: String!
  domainCode: String
  description: String
  isActive: Boolean!
  activeValueCount: Int!
  totalValueCount: Int!
  totalSynonymCount: Int!
  linkedAttributeCount: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
  values: [ReferenceListValue!]!
}

type ReferenceListValue {
  id: ID!
  listId: ID!
  valueCode: String!
  valueLabel: String!
  displayOrder: Int!
  synonyms: [String!]
  isActive: Boolean!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type NormalizationResult {
  normalized: Boolean!
  input: String!
  canonicalCode: String
  canonicalLabel: String
  matchType: String
  confidence: String
  message: String
}

input CreateReferenceListInput {
  listCode: String!
  listName: String!
  domainCode: String
  description: String
}

input UpdateReferenceListInput {
  id: ID!
  listName: String
  description: String
  isActive: Boolean
}

input AddReferenceListValueInput {
  listCode: String!
  valueCode: String!
  valueLabel: String!
  displayOrder: Int
  synonyms: [String!]
}

input UpdateReferenceListValueInput {
  id: ID!
  valueCode: String
  valueLabel: String
  displayOrder: Int
  synonyms: [String!]
  isActive: Boolean
}

input AddSynonymsInput {
  valueId: ID!
  synonyms: [String!]!
}

type CreateReferenceListResult {
  referenceList: ReferenceListDetail
  errors: [MutationError!]!
}

type UpdateReferenceListResult {
  referenceList: ReferenceListSummary
  errors: [MutationError!]!
}

type DeleteReferenceListResult {
  success: Boolean!
  errors: [MutationError!]!
}

type ReferenceListValueResult {
  value: ReferenceListValue
  errors: [MutationError!]!
}

type DeleteReferenceListValueResult {
  success: Boolean!
  errors: [MutationError!]!
}

type LinkAttributeToListResult {
  attribute: AttributeDefinition
  errors: [MutationError!]!
}

# File: root.graphql
# Root Query Type

type Query {
  # Generic entity queries
  entities(
    filter: EntityFilter
    pagination: PaginationInput
    asOfDate: Date
  ): EntityConnection!
  
  entity(id: ID, entityCode: String, asOfDate: Date): Entity
  
  # Domain-specific queries (for convenience, but use generic entity under the hood)
  funds(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  issuers(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  securities(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  deals(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  investors(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  positions(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  
  # Metadata queries
  domainTypes: [DomainTypeRecord!]!
  attributeRegister(domainCode: String): [AttributeDefinition!]!
  domainTemplates(domainCode: String): [Template!]!
  # Entity Management queries
  entityIdentifierDefinitions(domainCode: String): [EntityIdentifierDefinition!]!
  relationshipTypes: [RelationshipType!]!
  
  # Lineage and temporal queries
  fieldLineage(entityId: ID!, asOfDate: Date): [FieldLineage!]!
  temporalHistory(entityId: ID!, attributeCode: String!, fromDate: Date!, toDate: Date!): [TemporalValue!]!
  
  # DQ queries
  dqRule(id: ID!): DQRule
  dqRules(filter: DQRuleFilter, pagination: PaginationInput): [DQRule!]!
  dqExceptions(filter: DQExceptionFilter, pagination: PaginationInput): DQExceptionConnection!
  
  # Source queries
  dataSources(type: String, isActive: Boolean): [DataSource!]!
  dataSource(id: ID, code: String): DataSource
  dataSourceStats(sourceId: ID): DataSourceStats
  
  # Data Connection queries
  dataConnections(type: String, isActive: Boolean): [DataConnection!]!
  dataConnection(id: ID, code: String): DataConnection
  dataLoaders(connectionId: ID, isActive: Boolean): [DataLoader!]!
  dataLoader(id: ID, code: String): DataLoader
  
  # Import Map queries
  importMaps: [ImportMap!]!
  importMap(id: ID!): ImportMap
  identifierSuggestions(domainCode: String!): IdentifierSuggestionsResult!

  # Intersection queries
  intersectionTypes: [IntersectionType!]!
  intersectionType(id: ID, intersectionCode: String): IntersectionType
  intersections(filter: IntersectionFilter, pagination: PaginationInput, asOfDate: Date): IntersectionConnection!
  intersection(id: ID, intersectionCode: String, asOfDate: Date): Intersection

  # Precedence Rules queries
  precedenceRules(domainCode: String, attributeCode: String, isActive: Boolean): [PrecedenceRule!]!
  precedenceRule(id: ID!): PrecedenceRule

  # Golden Source queries
  goldenSource(entityId: ID!, attributeCode: String!): GoldenSource
  goldenSourcesForEntity(entityId: ID!): [GoldenSource!]!
  templatePrecedenceChain(templateId: ID!, attributeCode: String!): TemplatePrecedenceChain
  qualifyEntityTemplate(entityId: ID!, domainCode: String!): TemplateQualificationResult!
  evaluateGoldenSource(entityId: ID!, attributeCode: String!, domainCode: String!, templateId: ID): EvaluateGoldenSourceResult!

  # Tenancy queries
  me: Me!
  clients: [Client!]!
  client(id: ID!): Client
  clientUsers(clientId: ID!): [ClientUser!]!
  roles(clientId: ID): [Role!]!
  permissionsCatalog: [String!]!
  entityGrants(entityId: ID!): [EntityGrant!]!
  myPermissions(clientId: ID!): [String!]!

  # Compliance Rules queries
  complianceRules(filter: ComplianceRuleFilter): [ComplianceRule!]!
  complianceRule(id: ID, ruleCode: String): ComplianceRule
  complianceEvaluationRuns(ruleId: ID, first: Int): [ComplianceEvaluationRun!]!
  complianceEvaluationRun(id: ID!): ComplianceEvaluationRun
  complianceResults(filter: ComplianceResultFilter, pagination: PaginationInput): ComplianceEvaluationResultConnection!
  compliancePopulationPreview(input: CompliancePopulationPreviewInput!): CompliancePopulationPreview!

  # Reference List queries
  referenceLists(domainCode: String, isActive: Boolean): [ReferenceListSummary!]!
  referenceList(id: ID, listCode: String): ReferenceListDetail
  normalizeValue(listCode: String!, values: [String!]!): [NormalizationResult!]!

  # Reporting (dashboards & narratives)
  dashboards(domainCode: String, isActive: Boolean): [Dashboard!]!
  dashboard(id: ID, dashboardCode: String): Dashboard
  narratives(domainCode: String, isActive: Boolean): [Narrative!]!
  narrative(id: ID, narrativeCode: String): Narrative
  narrativeRuns(narrativeId: ID!, entityId: ID, first: Int): [NarrativeRun!]!
  runDataQueries(queries: JSON!, entityId: ID, entityCode: String, params: JSON, asOfDate: String, knowledgeDate: String): DataQueryResponse!
  gridQuery(input: GridQueryInput!): GridResult!
}

type Mutation {
  # Generic entity mutations
  createEntity(input: CreateEntityInput!): CreateEntityResult!
  updateEntity(input: UpdateEntityInput!): UpdateEntityResult!
  
  # Relationship mutations
  createRelationship(input: EntityRelationshipInput!): CreateRelationshipResult!
  updateRelationship(input: UpdateRelationshipInput!): UpdateRelationshipResult!
  deleteRelationship(id: ID!): DeleteRelationshipResult!
  
  # Attribute mutations
  updateAttribute(input: UpdateAttributeInput!): UpdateAttributeResult!
  splitValidTime(input: SplitValidTimeInput!): SplitValidTimeResult!
  submitManualOverride(input: ManualOverrideInput!): ManualOverrideResult!
  addCompetingSource(input: AddCompetingSourceInput!): AddCompetingSourceResult!
  
  # Metadata mutations
  createDomainType(input: CreateDomainTypeInput!): CreateDomainTypeResult!
  updateDomainType(input: UpdateDomainTypeInput!): UpdateDomainTypeResult!
  deleteDomainType(id: ID!): DeleteDomainTypeResult!
  createAttribute(input: CreateAttributeInput!): CreateAttributeResult!
  updateAttributeDefinition(input: UpdateAttributeDefinitionInput!): UpdateAttributeDefinitionResult!
  deleteAttribute(id: ID!): MutationResult!
  createTemplate(input: CreateTemplateInput!): CreateTemplateResult!
  updateTemplate(id: ID!, input: UpdateTemplateInput!): UpdateTemplateResult!
  assignAttributeToTemplate(input: AssignAttributeInput!): AssignAttributeResult!
  updateTemplateAttribute(input: UpdateTemplateAttributeInput!): UpdateTemplateAttributeResult!
  unassignAttributeFromTemplate(templateId: ID!, attributeId: ID!): MutationResult!
  reorderTemplateAttributes(input: ReorderTemplateAttributesInput!): ReorderTemplateAttributesResult!
  
  # DQ mutations
  createDQRule(input: CreateDQRuleInput!): CreateDQRuleResult!
  resolveDQException(input: ResolveDQExceptionInput!): ResolveDQExceptionResult!
  
  # Intersection mutations
  createIntersectionType(input: CreateIntersectionTypeInput!): CreateIntersectionTypeResult!
  updateIntersectionType(input: UpdateIntersectionTypeInput!): UpdateIntersectionTypeResult!
  deleteIntersectionType(id: ID!): DeleteIntersectionTypeResult!
  createIntersection(input: CreateIntersectionInput!): CreateIntersectionResult!
  updateIntersection(input: UpdateIntersectionInput!): UpdateIntersectionResult!
  deleteIntersection(id: ID!): DeleteIntersectionResult!
  
  # Source Registry mutations
  createDataSource(input: CreateDataSourceInput!): CreateDataSourceResult!
  updateDataSource(input: UpdateDataSourceInput!): UpdateDataSourceResult!
  deleteDataSource(id: ID!): DeleteDataSourceResult!
  testDataSourceConnection(id: ID!): TestDataSourceConnectionResult!
  toggleDataSourceActive(id: ID!, active: Boolean!): ToggleDataSourceActiveResult!
  reorderSources(order: [SourceReorderInput!]!): ReorderSourcesResult!
  
  # Data Connection mutations
  createDataConnection(input: CreateDataConnectionInput!): CreateDataConnectionResult!
  updateDataConnection(id: ID!, input: UpdateDataConnectionInput!): UpdateDataConnectionResult!
  deleteDataConnection(id: ID!): DeleteDataConnectionResult!
  testDataConnection(id: ID!): TestDataConnectionResult!
  
  # Data Loader mutations
  createDataLoader(input: CreateDataLoaderInput!): CreateDataLoaderResult!
  updateDataLoader(id: ID!, input: UpdateDataLoaderInput!): UpdateDataLoaderResult!
  deleteDataLoader(id: ID!): DeleteDataLoaderResult!
  triggerDataLoader(id: ID!): TriggerDataLoaderResult!
  
  # Import Map mutations
  createImportMap(input: CreateImportMapInput!): CreateImportMapResult!
  updateImportMap(input: UpdateImportMapInput!): UpdateImportMapResult!
  deleteImportMap(id: ID!): DeleteImportMapResult!
  analyzeImportMap(input: AnalyzeImportMapInput!): AnalyzeImportMapResult!
  executeImportMap(input: ExecuteImportMapInput!): ExecuteImportMapResult!

  # Relationship type (dimension) mutations
  createRelationshipType(input: CreateRelationshipTypeInput!): CreateRelationshipTypeResult!
  updateRelationshipType(input: UpdateRelationshipTypeInput!): UpdateRelationshipTypeResult!
  deleteRelationshipType(id: ID!): DeleteRelationshipTypeResult!

  # Entity identifier (match key) mutations
  createEntityIdentifier(input: CreateEntityIdentifierInput!): CreateEntityIdentifierResult!
  updateEntityIdentifier(input: UpdateEntityIdentifierInput!): UpdateEntityIdentifierResult!
  deleteEntityIdentifier(id: ID!): DeleteEntityIdentifierResult!

  # Precedence Rules mutations
  createPrecedenceRule(input: CreatePrecedenceRuleInput!): CreatePrecedenceRuleResult!
  updatePrecedenceRule(id: ID!, input: UpdatePrecedenceRuleInput!): UpdatePrecedenceRuleResult!
  deletePrecedenceRule(id: ID!): DeletePrecedenceRuleResult!
  updateAttributeDefaultPrecedence(attributeCode: String!, chain: [String!]!): UpdateDefaultPrecedenceResult!
  reorderPrecedenceChain(ruleId: String!, chain: [PrecedenceChainInput!]!): ReorderPrecedenceChainResult!

  # Golden Source mutations
  resolveGoldenSource(entityId: ID!, attributeCode: String!, domainCode: String!, templateId: ID, validFrom: Date): ResolveGoldenSourceResult!
  batchResolveGoldenSources(domainCode: String!, attributeCode: String!, templateCode: String): BatchResolveGoldenSourcesResult!
  updateTemplatePrecedenceChain(templateId: ID!, attributeCode: String!, chain: [String!]!): UpdateTemplatePrecedenceChainResult!

  # Tenancy mutations
  createClient(input: CreateClientInput!): MutationResult!
  createRole(input: CreateRoleInput!): MutationResult!
  inviteUser(input: InviteUserInput!): MutationResult!
  assignRole(input: AssignRoleInput!): MutationResult!
  revokeRole(clientId: ID!, userId: ID!, roleId: ID!): MutationResult!
  deactivateClientUser(clientId: ID!, userId: ID!): MutationResult!
  grantEntityAccess(input: GrantEntityAccessInput!): MutationResult!
  revokeEntityAccess(id: ID!): MutationResult!
  startImpersonation(clientId: ID!, reason: String): MutationResult!
  stopImpersonation: MutationResult!
  updateProfile(input: UpdateProfileInput!): UpdateProfileResult!

  # Compliance Rules mutations
  createComplianceRule(input: CreateComplianceRuleInput!): CreateComplianceRuleResult!
  updateComplianceRule(id: ID!, input: UpdateComplianceRuleInput!): UpdateComplianceRuleResult!
  deleteComplianceRule(id: ID!): DeleteComplianceRuleResult!
  createComplianceRuleVersion(input: CreateComplianceRuleVersionInput!): CreateComplianceRuleVersionResult!
  createComplianceScopeAssignment(input: CreateComplianceScopeAssignmentInput!): CreateComplianceScopeAssignmentResult!
  deleteComplianceScopeAssignment(id: ID!): DeleteComplianceScopeAssignmentResult!
  evaluateComplianceRule(input: EvaluateComplianceRuleInput!): EvaluateComplianceRuleResult!

  # Reference List mutations
  createReferenceList(input: CreateReferenceListInput!): CreateReferenceListResult!
  updateReferenceList(input: UpdateReferenceListInput!): UpdateReferenceListResult!
  deleteReferenceList(id: ID!): DeleteReferenceListResult!
  addReferenceListValue(input: AddReferenceListValueInput!): ReferenceListValueResult!
  updateReferenceListValue(input: UpdateReferenceListValueInput!): ReferenceListValueResult!
  deleteReferenceListValue(id: ID!): DeleteReferenceListValueResult!
  addValueSynonyms(input: AddSynonymsInput!): ReferenceListValueResult!
  removeValueSynonyms(input: AddSynonymsInput!): ReferenceListValueResult!
  linkAttributeToList(attributeId: ID!, listCode: String!): LinkAttributeToListResult!

  # Reporting (dashboards & narratives)
  createDashboard(input: CreateDashboardInput!): CreateDashboardResult!
  updateDashboard(id: ID!, input: UpdateDashboardInput!): UpdateDashboardResult!
  deleteDashboard(id: ID!): DeleteDashboardResult!
  createNarrative(input: CreateNarrativeInput!): CreateNarrativeResult!
  updateNarrative(id: ID!, input: UpdateNarrativeInput!): UpdateNarrativeResult!
  deleteNarrative(id: ID!): DeleteNarrativeResult!
}

# Root Subscription Type

type Subscription {
  # Entity Updates
  entityUpdated(entityId: ID): Entity!
  
  # DQ Events
  dqExceptionCreated: DQException!
  dqExceptionUpdated(exceptionId: ID): DQException!
}

# Additional Types for Attribute Mutations

input UpdateAttributeInput {
  entityId: ID!
  attributeCode: String!
  value: String!
  validFrom: Date!
  sourceId: ID!
  isOverride: Boolean
  overrideReason: String
}

input SplitValidTimeInput {
  eavId: ID!
  splitDate: Date!
  newValue: String!
  sourceId: ID!
  overrideReason: String
}

input ManualOverrideInput {
  entityId: ID!
  attributeCode: String!
  value: String!
  validFrom: Date!
  overrideReason: String!
}

type UpdateAttributeResult {
  success: Boolean!
  goldenValueId: ID
  errors: [MutationError!]!
}

type SplitValidTimeResult {
  success: Boolean!
  newEavId: ID
  errors: [MutationError!]!
}

type ManualOverrideResult {
  success: Boolean!
  goldenValueId: ID
  errors: [MutationError!]!
}

input AddCompetingSourceInput {
  entityId: ID!
  attributeCode: String!
  sourceId: ID!
  value: String!
  validFrom: Date
}

type AddCompetingSourceResult {
  success: Boolean!
  attributeValueId: ID
  errors: [MutationError!]!
}

# Metadata Types
input UpdateAttributeDefinitionInput {
  id: ID!
  attributeName: String
  description: String
  dataType: String
  unitOfMeasure: String
  isRequired: Boolean
  isMultiValued: Boolean
  referenceDomainCode: String
  defaultPrecedenceRank: Int
  isDerived: Boolean
  derivationType: String
  derivationFormula: String
  derivationDependencies: [String!]
  formulaLanguage: String
  isTimeVarying: Boolean
  timeDimension: String
  displayFormat: String
  listValues: [String!]
  validationRules: JSON
  defaultValue: String
  displaySection: String
  displayGroup: Int
  isEditable: Boolean
  isVisible: Boolean
  aggregationType: String
  weightAttributeCode: String
  numericPrecision: Int
  referenceListCode: String
  domainCode: String
}

type UpdateAttributeDefinitionResult {
  success: Boolean!
  attribute: AttributeDefinition
  errors: [MutationError!]!
}

type Template {
  id: ID!
  templateCode: String!
  domainCode: String!
  templateName: String!
  description: String
  isActive: Boolean!
  applicabilityRules: JSON
  attributes: [TemplateAttribute!]!
}

type TemplateAttribute {
  attributeId: ID!
  attribute: AttributeDefinition!
  isRequired: Boolean!
  precedenceRank: Int!
  displayOrder: Int!
  displayLabel: String
}

# Entity Identifier Definition Type
type EntityIdentifierDefinition {
  id: ID!
  identifierCode: String!
  identifierName: String!
  domainCode: String!
  domainName: String!
  attributeCodes: [String!]!
  isPrimary: Boolean!
  description: String
  isActive: Boolean!
  createdAt: DateTime!
  updatedAt: DateTime!
}

# Entity Identifier Input Types
input CreateEntityIdentifierInput {
  identifierCode: String!
  identifierName: String!
  domainCode: String!
  attributeCodes: [String!]!
  isPrimary: Boolean
  description: String
  isActive: Boolean
}

input UpdateEntityIdentifierInput {
  identifierName: String
  attributeCodes: [String!]
  isPrimary: Boolean
  description: String
  isActive: Boolean
}

# Entity Identifier Mutation Result Types
type CreateEntityIdentifierResult {
  identifier: EntityIdentifierDefinition
  errors: [MutationError!]!
}

type UpdateEntityIdentifierResult {
  identifier: EntityIdentifierDefinition
  errors: [MutationError!]!
}

type DeleteEntityIdentifierResult {
  success: Boolean!
  errors: [MutationError!]!
}

# Data Source Types
type DataSource {
  id: ID!
  sourceCode: String!
  sourceName: String!
  sourceType: String!
  vendorName: String
  feedFormat: String
  feedFrequency: String
  connectionConfig: JSON
  precedenceRank: Int!
  isActive: Boolean!
  isProtected: Boolean!
  color: String
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
}

type DataSourceStats {
  totalSources: Int!
  sourceBreakdown: [SourceBreakdown!]!
}

type SourceBreakdown {
  sourceId: ID!
  recordCount: Int!
}

# Source Registry Input/Result Types
input CreateDataSourceInput {
  sourceCode: String!
  sourceName: String!
  sourceType: String!
  vendorName: String
  feedFormat: String
  feedFrequency: String
  precedenceRank: Int
  color: String
  metadata: JSON
}

input UpdateDataSourceInput {
  id: ID!
  sourceName: String
  sourceType: String
  vendorName: String
  feedFormat: String
  feedFrequency: String
  precedenceRank: Int
  color: String
  isActive: Boolean
  metadata: JSON
}

input SourceReorderInput {
  id: ID!
  precedenceRank: Int!
}

type CreateDataSourceResult {
  dataSource: DataSource
  errors: [MutationError!]!
}

type UpdateDataSourceResult {
  dataSource: DataSource
  errors: [MutationError!]!
}

type DeleteDataSourceResult {
  success: Boolean!
  errors: [MutationError!]!
}

type TestDataSourceConnectionResult {
  success: Boolean!
  message: String
  errors: [MutationError!]!
}

type ToggleDataSourceActiveResult {
  dataSource: DataSource
  errors: [MutationError!]!
}

type ReorderSourcesResult {
  sources: [DataSource!]!
  errors: [MutationError!]!
}

# Data Connection Types
type DataConnection {
  id: ID!
  connectionCode: String!
  connectionName: String!
  sourceType: String!
  vendorName: String
  endpointUrl: String
  endpointMethod: String
  endpointHeaders: JSON
  requestTimeout: Int
  authType: String
  authConfig: JSON
  connectionStatus: String
  lastTestedAt: DateTime
  lastTestResult: JSON
  precedenceRank: Int!
  isActive: Boolean!
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
  # Related loaders
  loaders: [DataLoader!]
}

type DataLoader {
  id: ID!
  loaderCode: String!
  loaderName: String!
  connectionId: ID!
  connection: DataConnection
  domainCode: String!
  attributeCodes: [String!]!
  loadFrequency: String
  cronExpression: String
  loadWindow: String
  batchSize: Int
  transformMapping: JSON
  fieldMapping: JSON
  loaderStatus: String
  lastRunAt: DateTime
  lastRunResult: JSON
  nextRunAt: DateTime
  isActive: Boolean!
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
}

# Precedence Rules Types
type PrecedenceRule {
  id: ID!
  ruleCode: String
  ruleName: String!
  domainCode: String!
  templateCode: String
  attributeCode: String!
  priorityTier: String!
  isActive: Boolean!
  conditions: [PrecedenceCondition!]!
  chain: [PrecedenceChainItem!]!
  createdAt: DateTime!
  updatedAt: DateTime!
  createdBy: String
  metadata: JSON
}

type PrecedenceCondition {
  id: ID!
  ruleId: ID!
  conditionGroup: Int!
  conditionOrder: Int!
  attributeCode: String!
  operator: String!
  value: String
  logicOperator: String!
  createdAt: DateTime!
}

type PrecedenceChainItem {
  id: ID!
  ruleId: ID!
  chainOrder: Int!
  sourceCode: String!
  conditionType: String!
  createdAt: DateTime!
}

input CreatePrecedenceRuleInput {
  ruleCode: String
  ruleName: String!
  domainCode: String!
  templateCode: String
  attributeCode: String!
  priorityTier: String
  isActive: Boolean
  conditions: [PrecedenceConditionInput!]
  chain: [PrecedenceChainInput!]
  metadata: JSON
}

input UpdatePrecedenceRuleInput {
  ruleCode: String
  ruleName: String
  domainCode: String
  templateCode: String
  attributeCode: String
  priorityTier: String
  isActive: Boolean
  conditions: [PrecedenceConditionInput!]
  chain: [PrecedenceChainInput!]
  metadata: JSON
}

input PrecedenceConditionInput {
  conditionGroup: Int
  conditionOrder: Int
  attributeCode: String!
  operator: String!
  value: String
  logicOperator: String
}

input PrecedenceChainInput {
  chainOrder: Int
  sourceCode: String!
  conditionType: String
}

type CreatePrecedenceRuleResult {
  precedenceRule: PrecedenceRule
  errors: [MutationError!]!
}

type UpdatePrecedenceRuleResult {
  precedenceRule: PrecedenceRule
  errors: [MutationError!]!
}

type DeletePrecedenceRuleResult {
  success: Boolean!
  errors: [MutationError!]!
}

type UpdateDefaultPrecedenceResult {
  success: Boolean!
  errors: [MutationError!]!
}

type ReorderPrecedenceChainResult {
  success: Boolean!
  errors: [MutationError!]!
}

# Golden Source Types
type GoldenSource {
  entityId: ID!
  attributeCode: String
  attributeName: String
  goldenValue: String
  goldenSourceCode: String
  goldenSourceName: String
  goldenSourceId: ID
  precedenceRank: Int
  isManualOverride: Boolean!
  resolutionRuleApplied: String
  resolutionVersion: Int
  resolvedAt: DateTime
  competingValues: JSON
  isStale: Boolean!
}

type TemplatePrecedenceChain {
  templateId: ID!
  attributeCode: String!
  chain: [String!]!
  chainVersion: Int!
}

type TemplateQualificationResult {
  templateId: ID
  templateCode: String
  matched: Boolean!
}

type EvaluateGoldenSourceResult {
  winningSource: String!
  winningSourceId: ID
  tierUsed: Int!
  isDefault: Boolean!
  resolutionVersion: Int!
  appliedRuleCode: String
  appliedRuleName: String
  allCandidates: JSON
}

type ResolveGoldenSourceResult {
  success: Boolean!
  winningSource: String
  goldenValueId: ID
  goldenValue: String
  errors: [MutationError!]!
}

type BatchResolveGoldenSourcesResult {
  success: Boolean!
  entitiesResolved: Int!
  errors: [MutationError!]!
}

type UpdateTemplatePrecedenceChainResult {
  success: Boolean!
  chainVersion: Int!
  entitiesResolved: Int!
  errors: [MutationError!]!
}

# Data Connection Result Types
type CreateDataConnectionResult {
  connection: DataConnection
  errors: [MutationError!]!
}

type UpdateDataConnectionResult {
  connection: DataConnection
  errors: [MutationError!]!
}

type DeleteDataConnectionResult {
  success: Boolean!
  errors: [MutationError!]!
}

type TestDataConnectionResult {
  testResult: Boolean
  errors: [MutationError!]!
}

# Data Loader Result Types
type CreateDataLoaderResult {
  loader: DataLoader
  errors: [MutationError!]!
}

type UpdateDataLoaderResult {
  loader: DataLoader
  errors: [MutationError!]!
}

type DeleteDataLoaderResult {
  success: Boolean!
  errors: [MutationError!]!
}

type TriggerDataLoaderResult {
  success: Boolean!
  runId: String
  errors: [MutationError!]!
}

# Input Types for Data Connection Mutations
input CreateDataConnectionInput {
  connectionCode: String!
  connectionName: String!
  sourceType: String!
  vendorName: String
  endpointUrl: String
  endpointMethod: String
  endpointHeaders: JSON
  requestTimeout: Int
  authType: String!
  authConfig: JSON
  precedenceRank: Int
  isActive: Boolean
}

input UpdateDataConnectionInput {
  connectionName: String
  sourceType: String
  vendorName: String
  endpointUrl: String
  endpointMethod: String
  endpointHeaders: JSON
  requestTimeout: Int
  authConfig: JSON
  precedenceRank: Int
  isActive: Boolean
}

# Input Types for Data Loader Mutations
input CreateDataLoaderInput {
  loaderCode: String!
  loaderName: String!
  connectionId: ID!
  domainCode: String
  attributeCodes: [String!]
  loadFrequency: String!
  cronExpression: String
  loadWindow: String
  batchSize: Int
}

input UpdateDataLoaderInput {
  loaderName: String
  domainCode: String
  attributeCodes: [String!]
  loadFrequency: String
  cronExpression: String
  loadWindow: String
  batchSize: Int
}

# Import Map Types
type ImportMap {
  id: ID!
  name: String!
  description: String
  sourceFormat: String!
  domainMappings: [DomainImportMapping!]!
  status: String!
  options: JSON
  lastAnalysis: JSON
  lastAnalysisAt: DateTime
  lastExecution: JSON
  lastExecutionAt: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
  createdBy: String
}

type DomainImportMapping {
  domainCode: String!
  sourceColumn: String!
  targetField: String!
  mappingType: String
  isRequired: Boolean
}

type IdentifierSuggestionsResult {
  identifiers: [IdentifierDefinition!]!
  recommendations: [String!]!
}

type IdentifierDefinition {
  identifierCode: String!
  identifierName: String!
  domainCode: String!
  attributeCodes: [String!]!
  isPrimary: Boolean!
  description: String
  isActive: Boolean!
}

# Import Map Result Types
type CreateImportMapResult {
  importMap: ImportMap
  errors: [MutationError!]!
}

type UpdateImportMapResult {
  importMap: ImportMap
  errors: [MutationError!]!
}

type DeleteImportMapResult {
  success: Boolean!
  errors: [MutationError!]!
}

type AnalyzeImportMapResult {
  analysis: ImportMapAnalysis
  errors: [MutationError!]!
}

type ImportMapAnalysis {
  summary: ImportMapSummary
  mappings: [MappingSuggestion!]!
  identifiers: [IdentifierCandidate!]!
}

type ImportMapSummary {
  columns: Int!
  rows: Int!
  domains: Int!
  matches: Int!
  unmatched: Int!
}

type MappingSuggestion {
  column: String!
  domain: String
  field: String
  confidence: Float!
}

type IdentifierCandidate {
  domain: String!
  identifier: String!
  format: String!
  confidence: Float!
}

type ExecuteImportMapResult {
  executionId: String!
  success: Boolean!
  results: ImportMapExecutionResults
  summary: ImportMapSummary
  errors: [String!]!
}

type ImportMapExecutionResults {
  imported: Int!
  skipped: Int!
  errors: [ImportMapError!]!
}

type ImportMapError {
  row: Int!
  column: String!
  message: String!
}

# Input Types for Import Map Mutations
input CreateImportMapInput {
  name: String!
  description: String
  sourceFormat: String!
  sourceData: String!
  domainMappings: [DomainImportMappingInput!]
  options: JSON
}

input DomainImportMappingInput {
  domainCode: String!
  sourceColumn: String!
  targetField: String!
  mappingType: String
  isRequired: Boolean
}

input UpdateImportMapInput {
  name: String
  description: String
  domainMappings: [DomainImportMappingInput!]
  options: JSON
}

input AnalyzeImportMapInput {
  importMapId: ID!
}

input ExecuteImportMapInput {
  importMapId: ID!
  dryRun: Boolean
  skipValidation: Boolean
  continueOnError: Boolean
  batchSize: Int
}

# Relationship Type Types
type RelationshipTypeConnection {
  edges: [RelationshipTypeEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type RelationshipTypeEdge {
  node: RelationshipType!
  cursor: String!
}

# Relationship Type Mutation Results
type CreateRelationshipTypeResult {
  relationshipType: RelationshipType
  errors: [MutationError!]!
}

type UpdateRelationshipTypeResult {
  relationshipType: RelationshipType
  errors: [MutationError!]!
}

type DeleteRelationshipTypeResult {
  success: Boolean!
  errors: [MutationError!]!
}

# Input Types for Relationship Type Mutations
input CreateRelationshipTypeInput {
  relationshipCode: String!
  relationshipName: String!
  parentDomainCode: String
  childDomainCode: String
  description: String
  isActive: Boolean
  cardinality: String
  compositeKey: [String!]
}

input UpdateRelationshipTypeInput {
  relationshipName: String
  description: String
  isActive: Boolean
  cardinality: String
  compositeKey: [String!]
}

# File: security.graphql
# Security Domain Types

type Security {
  id: ID!
  entityCode: String!
  entityName: String!
  description: String
  isActive: Boolean!
  templateId: ID
  
  # Core Attributes
  isin: String
  cusip: String
  sedol: String
  ticker: String
  securityType: String
  assetClass: String
  currency: String
  exchange: String
  country: String
  sector: String
  industry: String
  price: Float
  priceDate: Date
  priceCurrency: String
  parValue: Float
  maturityDate: Date
  couponRate: Float
  dividendYield: Float
  peRatio: Float
  pbRatio: Float
  
  # Relationships
  issuer: Issuer
  issuerId: ID
  
  # Source Tracking
  priceSource: String
  lastUpdated: DateTime
  
  # Lineage
  lineage: [FieldLineage!]
  
  # Metadata
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
  createdBy: String
  updatedBy: String
}

type SecurityConnection {
  edges: [SecurityEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type SecurityEdge {
  node: Security!
  cursor: String!
}

input SecurityFilter {
  entityCode: StringFilter
  entityName: StringFilter
  isin: StringFilter
  cusip: StringFilter
  ticker: StringFilter
  securityType: StringFilter
  assetClass: StringFilter
  currency: StringFilter
  exchange: StringFilter
  country: StringFilter
  sector: StringFilter
  priceRange: FloatRangeFilter
  priceDateRange: DateRangeFilter
  isActive: Boolean
}

input CreateSecurityInput {
  entityCode: String!
  entityName: String!
  description: String
  templateId: ID
  issuerId: ID
  attributes: [AttributeInput!]
}

input UpdateSecurityInput {
  id: ID!
  entityName: String
  description: String
  isActive: Boolean
  issuerId: ID
  attributes: [AttributeInput!]
}

type CreateSecurityResult {
  security: Security
  errors: [MutationError!]!
}

type UpdateSecurityResult {
  security: Security
  errors: [MutationError!]!
}


# Reporting: Custom Dashboards & Narratives
#
# Dashboards and narratives are templates attached to an entity type (domainCode).
# dataQueries is an array of DataQuerySpec (see src/lib/data-query-engine.ts) that is
# executed at view time against the entity being viewed + user filter inputs.

type Dashboard {
  id: ID!
  dashboardCode: String!
  dashboardName: String!
  description: String
  domainCode: String!
  htmlTemplate: String!
  dataQueries: JSON!
  parameters: JSON!
  isActive: Boolean!
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Narrative {
  id: ID!
  narrativeCode: String!
  narrativeName: String!
  description: String
  domainCode: String!
  instructions: String!
  dataQueries: JSON!
  parameters: JSON!
  outputBlocks: JSON!
  model: String
  isActive: Boolean!
  metadata: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
}

type NarrativeRun {
  id: ID!
  narrativeId: ID!
  entityId: ID
  parameters: JSON!
  blocks: JSON!
  status: String!
  errorMessage: String
  model: String
  createdAt: DateTime!
  createdBy: ID
}

type DataQueryResponse {
  anchor: JSON
  results: JSON!
  warnings: [String!]!
  validationErrors: [String!]!
  asOfDate: String
}

input GridQueryInput {
  start: String!
  domainCode: String
  entityId: ID
  entityCode: String
  path: JSON
  includeAnchor: Boolean
  lookups: JSON
  asOfDate: String
  knowledgeDate: String
  filters: JSON
  columns: [String!]
  sort: JSON
  groupBy: [String!]
  groupKeys: JSON
  metrics: JSON
  flat: Boolean
  offset: Int
  limit: Int
  export: Boolean
  params: JSON
}

type GridColumn {
  code: String!
  name: String
  kind: String
  aggregation: String
  weight: String
  unit: String
  precision: Int
}

type GridResult {
  mode: String!
  level: Int
  groupField: String
  total: Int!
  matched: Int!
  rows: JSON!
  summary: JSON
  columns: [GridColumn!]!
  groupBy: [String!]!
  asOfDate: String
  knowledgeDate: String
  entityCount: Int
}

input CreateDashboardInput {
  dashboardCode: String!
  dashboardName: String!
  description: String
  domainCode: String!
  htmlTemplate: String
  dataQueries: JSON
  parameters: JSON
  isActive: Boolean
  metadata: JSON
}

input UpdateDashboardInput {
  dashboardName: String
  description: String
  domainCode: String
  htmlTemplate: String
  dataQueries: JSON
  parameters: JSON
  isActive: Boolean
  metadata: JSON
}

input CreateNarrativeInput {
  narrativeCode: String!
  narrativeName: String!
  description: String
  domainCode: String!
  instructions: String
  dataQueries: JSON
  parameters: JSON
  outputBlocks: JSON
  model: String
  isActive: Boolean
  metadata: JSON
}

input UpdateNarrativeInput {
  narrativeName: String
  description: String
  domainCode: String
  instructions: String
  dataQueries: JSON
  parameters: JSON
  outputBlocks: JSON
  model: String
  isActive: Boolean
  metadata: JSON
}

type CreateDashboardResult {
  dashboard: Dashboard
  errors: [MutationError!]!
}

type UpdateDashboardResult {
  dashboard: Dashboard
  errors: [MutationError!]!
}

type DeleteDashboardResult {
  success: Boolean!
  errors: [MutationError!]!
}

type CreateNarrativeResult {
  narrative: Narrative
  errors: [MutationError!]!
}

type UpdateNarrativeResult {
  narrative: Narrative
  errors: [MutationError!]!
}

type DeleteNarrativeResult {
  success: Boolean!
  errors: [MutationError!]!
}

# Query fields (add to type Query):
#   dashboards(domainCode: String, isActive: Boolean): [Dashboard!]!
#   dashboard(id: ID, dashboardCode: String): Dashboard
#   narratives(domainCode: String, isActive: Boolean): [Narrative!]!
#   narrative(id: ID, narrativeCode: String): Narrative
#   narrativeRuns(narrativeId: ID!, entityId: ID, first: Int): [NarrativeRun!]!
#   runDataQueries(queries: JSON!, entityId: ID, entityCode: String, params: JSON): DataQueryResponse!
#
# Mutation fields (add to type Mutation):
#   createDashboard(input: CreateDashboardInput!): CreateDashboardResult!
#   updateDashboard(id: ID!, input: UpdateDashboardInput!): UpdateDashboardResult!
#   deleteDashboard(id: ID!): DeleteDashboardResult!
#   createNarrative(input: CreateNarrativeInput!): CreateNarrativeResult!
#   updateNarrative(id: ID!, input: UpdateNarrativeInput!): UpdateNarrativeResult!
#   deleteNarrative(id: ID!): DeleteNarrativeResult!


`;
