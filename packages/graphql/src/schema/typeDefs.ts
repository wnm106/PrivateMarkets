// Auto-generated inlined schema for edge runtime compatibility
export const typeDefs = `

# File: common.graphql
# Scalar Types
scalar Date
scalar DateTime
scalar JSON
scalar UUID

# Enums
enum SourceType {
  VENDOR
  INTERNAL
  MANUAL
  CALCULATED
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
  lastUpdated: DateTime
  # True while a materialized calc that owns this attribute is waiting to be recomputed.
  calcDirty: Boolean!
}

# One recorded write of an attribute value, newest first in entityActivity.
type AttributeActivity {
  attributeCode: String!
  attributeName: String!
  value: String
  updatedAt: DateTime!
  updatedBy: String!
  sourceName: String
  validFrom: Date!
  validTo: Date!
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
  clientId: ID
  clientName: String
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
  # Width and height on the 4-column attribute display. Both default to 1.
  displaySpanColumns: Int
  displaySpanRows: Int
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

type CalcInput {
  inputRole: String!
  attributeCode: String!
  traversal: String!
  relationshipCodes: [String!]!
}

type CalcDefinition {
  id: ID!
  attributeCode: String!
  domainCode: String!
  calcKind: String!
  evaluationMode: String!
  timeImpact: String!
  outputGrain: String!
  expression: JSON
  aggregateFn: String
  seriesFn: String
  derivationDependencies: [String!]!
  inputs: [CalcInput!]!
}

type CalcComponent {
  attributeCode: String!
  attributeName: String!
  role: String!
  traversal: String!
  relationshipCodes: [String!]!
  relationshipNames: [String!]!
  domainCode: String
  domainName: String
  homeDomainCode: String
  homeDomainName: String
  entityId: ID
  entityCode: String
  entityName: String
  value: String
  detail: String
  calculated: Boolean!
}

type CalcBreakdown {
  attributeCode: String!
  calcKind: String!
  domainCode: String!
  expression: JSON
  value: String
  truncated: Boolean!
  components: [CalcComponent!]!
}

input CalcOperandInput {
  attributeCode: String!
  traversal: String!
  relationshipCodes: [String!]!
}

type CalculatedAttributeState {
  entityId: ID!
  attributeCode: String!
  dirty: Boolean!
  status: String
  windowStart: Date
  windowEnd: Date
}

type ProcessCalculatedAttributesResult {
  processed: Int!
  failed: Int!
  pending: Int!
}

type UpdateCalcExpressionResult {
  definition: CalcDefinition
  errors: [MutationError!]!
}

type ExpressionFunction {
  id: ID!
  code: String!
  name: String!
  category: String!
  returnType: String!
  description: String!
  signature: String!
  example: JSON!
  callable: Boolean!
}

# File: dataquality.graphql
# Data Quality Types

input DQRulePreviewInput {
  domainCode: String
  ruleExpression: String!
  attributeCode: String
  "Attributes whose values are returned with each record."
  columns: [String!]
  asOfDate: Date
  "FAIL, PASS or ALL. FAIL when blank."
  outcome: String
  offset: Int
  limit: Int
}

type DQRulePreviewRow {
  entityId: ID!
  entityCode: String!
  entityName: String
  passed: Boolean!
  message: String
  actualValue: String
  values: JSON
}

type DQRulePreview {
  total: Int!
  passed: Int!
  failed: Int!
  rows: [DQRulePreviewRow!]!
}

type DQRule {
  id: ID!
  ruleCode: String!
  ruleName: String!
  domainCode: String
  attributeCode: String
  ruleType: DQRuleType!
  severity: DQSeverity!
  "SQL predicate that is true when a record fails this rule."
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
  domainCode: String!
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
  domainCode: String
  ruleType: DQRuleType
  severity: DQSeverity
  isActive: Boolean
}

input DQExceptionFilter {
  ruleId: IDFilter
  entityId: IDFilter
  entityCode: StringFilter
  domainCode: String
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
  domainCode: String
  attributeCode: String
  ruleType: DQRuleType!
  severity: DQSeverity!
  "SQL predicate that is true when a record fails this rule."
  ruleExpression: String!
  ruleDescription: String
  thresholdValue: Float
  autoRemediate: Boolean
}

input UpdateDQRuleInput {
  id: ID!
  ruleName: String
  domainCode: String
  attributeCode: String
  ruleType: DQRuleType
  severity: DQSeverity
  "SQL predicate that is true when a record fails this rule."
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

type ConfirmAttributeReceiptResult {
  success: Boolean!
  receivedAt: DateTime
  errors: [MutationError!]!
}

type ResolveDQExceptionResult {
  success: Boolean!
  errors: [MutationError!]!
}

type StaleAttribute {
  entityId: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  attributeCode: String!
  attributeName: String!
  sourceCode: String!
  sourceName: String!
  value: String
  receivedAt: DateTime!
  ageDays: Int!
}

type StaleAttributeReport {
  olderThanDays: Int!
  asOfDate: Date!
  count: Int!
  attributes: [StaleAttribute!]!
}

type DataQualityDashboard {
  fromDate: Date!
  toDate: Date!
  domains: [String!]!
  summary: DataQualitySummary!
  availability: [AttributeAvailability!]!
  quality: [RuleQuality!]!
  trajectory: [AttributeTrajectory!]!
  overrideMatches: [OverrideMatch!]!
  entities: [EntityQualityResult!]!
}

type DataQualitySummary {
  entityCount: Int!
  requiredSlots: Int!
  populatedSlots: Int!
  missingSlots: Int!
  entitiesMissingRequired: Int!
  availabilityPercent: Float
  rulesEvaluated: Int!
  passingChecks: Int!
  failingChecks: Int!
  entitiesFailingRules: Int!
  qualityPercent: Float
  changedAttributeCount: Int!
  changedEntityCount: Int!
  attributeChangeCount: Int!
  clearEntityCount: Int!
  availabilityResolvedCount: Int!
  availabilityIntroducedCount: Int!
  qualityResolvedCount: Int!
  qualityIntroducedCount: Int!
  overrideMatchCount: Int!
}

type MeasureShift {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  previousValue: String
  currentValue: String
}

type OverrideMatch {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  attributeCode: String!
  attributeName: String!
  overrideValue: String!
  overrideReason: String
  prioritySourceCode: String
  prioritySourceName: String
  priorityValue: String
  ready: Boolean!
}

type QualityEntityRef {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
}

type AttributeAvailability {
  attributeCode: String!
  attributeName: String!
  domainCode: String
  requiredCount: Int!
  missingCount: Int!
  availabilityPercent: Float
  resolvedCount: Int!
  introducedCount: Int!
  missingEntities: [QualityEntityRef!]!
  resolvedEntities: [MeasureShift!]!
  introducedEntities: [MeasureShift!]!
}

"Records behind one required-attribute row: missing a value now, or filled in or lost since the from date."
type AvailabilityDetail {
  missingEntities: [QualityEntityRef!]!
  resolvedEntities: [MeasureShift!]!
  introducedEntities: [MeasureShift!]!
}

type RuleFailure {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  attributeCode: String
  attributeName: String
  message: String
  actualValue: String
}

type AcceptedException {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  status: String!
  notes: String
}

type RuleQuality {
  ruleId: ID!
  ruleCode: String!
  ruleName: String!
  ruleType: String!
  severity: String!
  domainCode: String
  ruleExpression: String!
  ruleDescription: String
  attributeCode: String
  attributeName: String
  evaluated: Boolean!
  evaluationMessage: String
  entityCount: Int!
  failingCount: Int!
  passingCount: Int!
  acceptedCount: Int!
  failingEntities: [RuleFailure!]!
  acceptedEntities: [AcceptedException!]!
  resolvedCount: Int!
  introducedCount: Int!
  resolvedEntities: [MeasureShift!]!
  introducedEntities: [MeasureShift!]!
}

type AttributeChange {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  previousValue: String
  currentValue: String
}

type AttributeTrajectory {
  attributeCode: String!
  attributeName: String!
  domainCode: String
  changeCount: Int!
  changes: [AttributeChange!]!
}

type MissingAttribute {
  attributeCode: String!
  attributeName: String!
}

type EntityAcceptedRule {
  ruleId: ID!
  ruleCode: String!
  ruleName: String!
  severity: String!
  attributeCode: String
  attributeName: String
  status: String!
  notes: String
}

type EntityRuleFailure {
  ruleId: ID!
  ruleCode: String!
  ruleName: String!
  severity: String!
  attributeCode: String
  attributeName: String
  message: String
  actualValue: String
}

input RecordDQDispositionInput {
  ruleId: ID!
  entityId: ID!
  status: DQExceptionStatus!
  resolutionNotes: String
  asOf: Date
}

type RecordDQDispositionResult {
  success: Boolean!
  exceptionId: ID
  errors: [MutationError!]!
}

type EntityAttributeChange {
  attributeCode: String!
  attributeName: String!
  previousValue: String
  currentValue: String
}

type EntityQualityResult {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  requiredCount: Int!
  missingCount: Int!
  availabilityPercent: Float
  missingAttributes: [MissingAttribute!]!
  ruleCount: Int!
  failingRuleCount: Int!
  qualityPercent: Float
  failingRules: [EntityRuleFailure!]!
  acceptedRules: [EntityAcceptedRule!]!
  changeCount: Int!
  changes: [EntityAttributeChange!]!
  availabilityResolvedCount: Int!
  availabilityIntroducedCount: Int!
  qualityResolvedCount: Int!
  qualityIntroducedCount: Int!
  overrideMatchCount: Int!
  overrideCount: Int!
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
  FORTY_ACT
  COVERAGE
  COLLATERAL_QUALITY
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
  LINE
}

enum ComplianceMeasureSide {
  NUMERATOR
  DENOMINATOR
  LIMIT
}

enum ComplianceMeasureKind {
  SUM
  COUNT
  MIN
  MAX
  AVG
  VALUE
  WAVG
  EXCESS_OVER_PCT
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
  # BASE aggregates the denominator over positions. ANCHOR reads it on the fund.
  denominatorSource: String!
  denominatorConstantValue: Float
  resultUnit: ComplianceResultUnit!
  # Legacy fallback. The direction that is enforced lives on the fund limit.
  limitDirection: ComplianceLimitDirection
  softLimitValue: Float
  hardLimitValue: Float
  hardLimitAttributeCode: String
  softLimitFactor: Float
  defaultSourceScope: String!
  consolidateDescendants: Boolean!
  isActive: Boolean!
  conditions: [ComplianceRuleCondition!]!
  measureLines: [ComplianceMeasureLine!]!
  metadata: JSON
  createdAt: DateTime!
  createdBy: String
}

# One amount in the formula. Filters on the line count only that amount's records.
type ComplianceMeasureLine {
  id: ID!
  side: ComplianceMeasureSide!
  lineOrder: Int!
  label: String
  kind: ComplianceMeasureKind!
  sign: Int!
  attributeCode: String
  # Where and when this line reads its attribute. Empty reads the run source at the as-of date.
  dimension: ComplianceAttributeDimension
  # Formula evaluated on each record. The line kind aggregates those results.
  expression: JSON
  path: [ComplianceRollupHop!]!
  weightAttributeCode: String
  valuePath: [ComplianceRollupHop!]!
  transform: String
  priceAttributeCode: String
  pct: Float
  pctAttributeCode: String
  pctPath: [ComplianceRollupHop!]!
  totalPath: [ComplianceRollupHop!]!
  required: Boolean!
  conditions: [ComplianceRuleCondition!]!
  totalConditions: [ComplianceRuleCondition!]!
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
  leftExpression: JSON
  rightExpression: JSON
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
  rankPosition: Int
  detail: JSON
  evaluatedAt: DateTime!
}

type ComplianceThreshold {
  id: ID!
  ruleId: ID!
  ruleCode: String
  ruleName: String
  entityId: ID
  entityCode: String
  entityName: String
  groupValue: String
  rankFrom: Int
  rankTo: Int
  # MAX breaches when the result is above the limit. MIN breaches when it is below.
  limitDirection: ComplianceLimitDirection
  softLimitValue: Float
  hardLimitValue: Float
  applies: Boolean!
  notes: String
}

type ComplianceFundNode {
  entityId: ID!
  entityCode: String!
  entityName: String
  parentEntityId: ID
}

type ComplianceFundRule {
  id: ID!
  ruleCode: String!
  ruleName: String!
  ruleCategory: String!
  resultUnit: String
  limitDirection: String
  groupByAttributeCode: String
  consolidateDescendants: Boolean!
  isActive: Boolean!
}

type ComplianceFundBoard {
  funds: [ComplianceFundNode!]!
  rules: [ComplianceFundRule!]!
  thresholds: [ComplianceThreshold!]!
  results: [ComplianceEvaluationResult!]!
}

input UpsertComplianceThresholdInput {
  id: ID
  ruleId: ID!
  entityId: ID
  groupValue: String
  rankFrom: Int
  rankTo: Int
  # MAX is a ceiling. MIN is a floor. Omitted on update leaves the stored direction.
  limitDirection: ComplianceLimitDirection
  softLimitValue: Float
  hardLimitValue: Float
  applies: Boolean
  notes: String
}

type UpsertComplianceThresholdResult {
  threshold: ComplianceThreshold
  errors: [MutationError!]!
}

type DeleteComplianceThresholdResult {
  success: Boolean!
  errors: [MutationError!]!
}

# Booked positions plus one deal's proposed allocation.
type DealComplianceScore {
  rules: [ComplianceFundRule!]!
  results: [ComplianceEvaluationResult!]!
  errors: [MutationError!]!
}

# One record that fed a fund's result, with the values the rule read from it.
type ComplianceContributorColumn {
  code: String!
  label: String!
  # NUMERATOR | DENOMINATOR | GROUP
  role: String!
}

type ComplianceContributor {
  entityId: ID!
  entityCode: String!
  entityName: String
  # What this record added to the numerator (1 per record when counting).
  numeratorValue: Float
  # Share of the numerator total, 0 to 100.
  sharePercent: Float
  values: JSON!
}

type ComplianceResultContributors {
  resultId: ID!
  baseDomainCode: String
  numeratorAggregation: String
  columns: [ComplianceContributorColumn!]!
  rows: [ComplianceContributor!]!
  total: Int!
}

# One buy or sell in a proforma package. Positive par buys the security.
# Negative par sells it. Every leg in one call is applied together.
input ComplianceProformaLegInput {
  securityId: ID
  securityCode: String
  par: Float!
  attributes: JSON
}

type ComplianceProformaLine {
  ruleCode: String!
  ruleName: String!
  groupByValue: String
  limitDirection: ComplianceLimitDirection
  baselineValue: Float
  scenarioValue: Float
  baselineStatus: ComplianceResultStatus
  scenarioStatus: ComplianceResultStatus
  hardLimitValue: Float
  softLimitValue: Float
  verdict: String!
  approved: Boolean!
}

type ComplianceProformaScore {
  approved: Boolean!
  lines: [ComplianceProformaLine!]!
  errors: [MutationError!]!
}

# Headroom, in par of one security, on the rules that security would worsen.
# capacityPar null means no rule caps the buy. Zero means a rule blocks it.
type ComplianceCapacityLine {
  ruleCode: String!
  ruleName: String!
  groupByValue: String
  limitDirection: ComplianceLimitDirection
  impact: String!
  baselineValue: Float
  limitValue: Float
  nativeHeadroom: Float
  capacityPar: Float
  binding: Boolean!
}

type ComplianceCapacity {
  capacityPar: Float
  bindingRuleCode: String
  bindingGroup: String
  lines: [ComplianceCapacityLine!]!
  errors: [MutationError!]!
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
  denominatorSource: String
  denominatorConstantValue: Float
  resultUnit: ComplianceResultUnit
  limitDirection: ComplianceLimitDirection
  softLimitValue: Float
  hardLimitValue: Float
  hardLimitAttributeCode: String
  softLimitFactor: Float
  defaultSourceScope: String
  conditions: [ComplianceRuleConditionInput!]
  measureLines: [ComplianceMeasureLineInput!]
  metadata: JSON
}

input ComplianceMeasureLineInput {
  side: ComplianceMeasureSide!
  lineOrder: Int
  label: String
  kind: ComplianceMeasureKind!
  sign: Int
  attributeCode: String
  dimension: ComplianceAttributeDimensionInput
  expression: JSON
  path: [ComplianceRollupHopInput!]
  weightAttributeCode: String
  valuePath: [ComplianceRollupHopInput!]
  transform: String
  priceAttributeCode: String
  pct: Float
  pctAttributeCode: String
  pctPath: [ComplianceRollupHopInput!]
  totalPath: [ComplianceRollupHopInput!]
  required: Boolean
  conditions: [ComplianceRuleConditionInput!]
  totalConditions: [ComplianceRuleConditionInput!]
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
  leftExpression: JSON
  rightExpression: JSON
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
  entityId: ID
  # Proforma: add this deal's proposed positions to the booked book.
  scenarioCode: String
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

  # The template in force for this record, after overrides and inheritance.
  effectiveTemplate(asOfDate: Date): EffectiveTemplate
  
  # Relationships
  parentRelationships: [EntityRelationship!]!
  childRelationships: [EntityRelationship!]!
  
  # Lineage
  lineage: [FieldLineage!]

  # Materialized calculations for this entity, including whether a recalc is pending.
  calculatedAttributes: [CalculatedAttributeState!]!
  
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
  # Constituents of a composite related entity, such as a position's fund and security.
  members: [RelationshipMember!]!
}

type RelationshipMember {
  entityId: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
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

enum EntitySearchMatch {
  NAME
  PARENT
  RELATED
}

"""One entity hit from global search. Parent domains have depth 0."""
type EntitySearchHit {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  domainName: String!
  depth: Int!
  match: EntitySearchMatch!
  matchedName: String
  matchedDomainName: String
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
  clientId: ID
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
  """Date the attribute edit is effective. Use the date on screen so the new value is visible there."""
  asOfDate: Date
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
  # Stored side (PARENT or CHILD) whose record chooses the template for the other side.
  templateFromSide: String
  clientId: ID
  clientName: String
}

# Which template a record uses, and where it came from.
# source: OVERRIDE (set on the record), INHERITED (chosen on a linked record),
# OWN (the record's own template), NONE.
type EffectiveTemplate {
  entityId: ID!
  templateId: ID
  templateCode: String
  templateName: String
  source: String!
  fromEntityId: ID
  fromEntityName: String
  relationshipCode: String
  onDate: Date
}

type TemplateOption {
  id: ID!
  templateCode: String!
  templateName: String!
}

type EntityTemplateChoice {
  id: ID!
  entityId: ID!
  relationshipCode: String
  templateId: ID!
  templateCode: String!
  templateName: String!
  validFrom: Date
  validTo: Date
}

# One thing a record can choose a template for: the records linked to it
# through a relationship, or itself when relationshipCode is null.
type TemplateChoiceSlot {
  entityId: ID!
  relationshipCode: String
  relationshipName: String
  domainCode: String!
  domainName: String!
  templates: [TemplateOption!]!
  choices: [EntityTemplateChoice!]!
}

input SetEntityTemplateChoiceInput {
  entityId: ID!
  relationshipCode: String
  templateId: ID
  effectiveFrom: Date
}

type SetEntityTemplateChoiceResult {
  success: Boolean!
  choices: [EntityTemplateChoice!]!
  errors: [MutationError!]!
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
  clientId: ID
  groupCode: String
  parentDomainCode: String
  isCore: Boolean
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
  displaySection: String
  displayGroup: Int
  clientId: ID
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
  clientId: ID
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
  defaultPrecedenceChain: [String!]
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

input UpdateTemplateSourcePreferenceInput {
  templateId: ID!
  attributeId: ID!
  defaultPrecedenceChain: [String!]!
}

type UpdateTemplateSourcePreferenceResult {
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

# Domain Type Record (used for managing domain types)
type DomainGroup {
  id: ID!
  groupCode: String!
  groupName: String!
  description: String
  color: String!
  displayOrder: Int!
}

input CreateDomainGroupInput {
  groupName: String!
  description: String
}

type CreateDomainGroupResult {
  group: DomainGroup
  errors: [MutationError!]!
}

type DomainTypeRecord {
  id: ID!
  domainCode: String!
  domainName: String!
  description: String
  isActive: Boolean!
  createdAt: DateTime!
  updatedAt: DateTime!
  clientId: ID
  clientName: String
  isCore: Boolean!
  displayOrder: Int!
  parentDomainCode: String
  group: DomainGroup
  ownedAttributeCount: Int!
  sharedAttributeCount: Int!
  templateCount: Int!
}

# Active-record count for one entity type. Counted from master entities,
# not the aggregated read projection, so large domains stay fast.
type DomainRecordCount {
  domainCode: String!
  totalCount: Int!
}

# Domain Type mutation inputs and results
input UpdateDomainTypeInput {
  id: ID!
  domainName: String
  description: String
  isActive: Boolean
  groupCode: String
  parentDomainCode: String
  isCore: Boolean
  displayOrder: Int
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
  # True for tenant admins and for client members who manage users, roles, or entity access.
  canAccessAdmin: Boolean!
  # True when the caller may assign which roles can open an entity.
  canManageEntityAccess: Boolean!
  clients: [Client!]!
  impersonating: ImpersonationSession
}

type EntityAccessRecord {
  entityId: ID!
  clientId: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  restricted: Boolean!
  grants: [EntityGrant!]!
}

input EntityRoleGrantInput {
  roleId: ID!
  accessLevel: String!
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

# Per-client sign-in rules. A tenant admin chooses password, Microsoft Entra ID,
# SAML 2.0, and OpenID Connect for each client. Email domains select the rules.
type ClientAuthRequirements {
  clientId: ID!
  passwordEnabled: Boolean!
  mfaRequired: Boolean!
  emailDomains: [String!]!
}

type ClientIdentityProvider {
  id: ID!
  clientId: ID!
  provider: String!
  displayName: String
  emailDomain: String
  azureTenantId: String
  samlMetadataUrl: String
  oidcIssuer: String
  oidcClientId: String
  oidcIdentifier: String
  ssoProviderId: String
  registrationStatus: String!
  registrationError: String
  isEnabled: Boolean!
}

input UpdateClientAuthRequirementsInput {
  clientId: ID!
  passwordEnabled: Boolean!
  mfaRequired: Boolean!
  emailDomains: [String!]!
}

input UpsertClientIdentityProviderInput {
  id: ID
  clientId: ID!
  provider: String!
  displayName: String
  emailDomain: String
  azureTenantId: String
  samlMetadataUrl: String
  samlMetadataXml: String
  oidcIssuer: String
  oidcClientId: String
  oidcClientSecret: String
  isEnabled: Boolean
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

type MatchRuleClause {
  id: ID!
  clauseCode: String!
  attributeCodes: [String!]!
  useEntityName: Boolean!
  algorithm: String!
  threshold: Float!
  weight: Float!
  deterministic: Boolean!
  isActive: Boolean!
}

type MatchRule {
  id: ID!
  ruleCode: String!
  ruleName: String!
  description: String
  minScore: Float!
  isActive: Boolean!
  clauses: [MatchRuleClause!]!
}

type MergeReason {
  clauseCode: String!
  algorithm: String!
  label: String!
  leftValue: String!
  rightValue: String!
  leftAttribute: String!
  rightAttribute: String!
  similarity: Float!
  deterministic: Boolean!
}

type MergeEntityRef {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
}

type MergeCandidate {
  score: Int!
  crossDomain: Boolean!
  ruleCode: String!
  ruleName: String!
  reasons: [MergeReason!]!
  left: MergeEntityRef!
  right: MergeEntityRef!
}

type MergeCandidateResult {
  candidates: [MergeCandidate!]!
  scannedCount: Int!
  truncated: Boolean!
}

type MergeFieldComparison {
  attributeCode: String!
  survivorValue: String
  retiredValue: String
  status: String!
}

type MergePreview {
  survivor: MergeEntityRef!
  retired: MergeEntityRef!
  crossDomain: Boolean!
  score: Int!
  ruleName: String
  reasons: [MergeReason!]!
  fields: [MergeFieldComparison!]!
  relationshipsToMove: Int!
}

type MergeEntitiesResult {
  success: Boolean!
  survivorId: ID
  retiredId: ID
  attributesCopied: Int
  relationshipsMoved: Int
  intersectionsMoved: Int
  positionsMoved: Int
  errors: [MutationError!]!
}

type EntityGraphNode {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
  depth: Int!
  direction: String!
}

type EntityGraphEdge {
  id: ID!
  parentEntityId: ID!
  childEntityId: ID!
  relationshipCode: String!
  relationshipType: String!
  isPrimary: Boolean!
  metadata: JSON
}

type EntityGraph {
  rootId: ID!
  nodes: [EntityGraphNode!]!
  edges: [EntityGraphEdge!]!
}

input MergeCandidateFilter {
  entityId: ID
  query: String
  ruleCode: String
  crossDomainOnly: Boolean
  sameDomainOnly: Boolean
  limit: Int
}

input MergeFieldChoiceInput {
  attributeCode: String!
  takeFrom: String!
}

input MatchClauseInput {
  id: ID
  clauseCode: String!
  attributeCodes: [String!]!
  useEntityName: Boolean!
  algorithm: String!
  threshold: Float!
  weight: Float!
  deterministic: Boolean!
  isActive: Boolean!
}

input UpdateMatchRuleInput {
  id: ID!
  ruleName: String
  description: String
  minScore: Float
  isActive: Boolean
  clauses: [MatchClauseInput!]
}

input CreateMatchRuleInput {
  ruleCode: String!
  ruleName: String!
  description: String
  minScore: Float!
  clauses: [MatchClauseInput!]!
}

type UpdateMatchRuleResult {
  rule: MatchRule
  errors: [MutationError!]!
}

# File: allocation.graphql

input AllocationAdjustmentInput {
  fundId: ID!
  trancheId: String!
  type: String!
  amount: Float
  reasonCode: String
  note: String
  saved: Boolean
}

input AllocationHoldInput {
  trancheId: ID!
  holdPct: Float!
}

type AllocationCell {
  trancheId: ID!
  eligible: Boolean!
  amount: Float!
  systemAmount: Float!
  capReason: String
  exclusionKind: String
  exclusionCode: String
  exclusionText: String
  overridden: Boolean!
  reasonCode: String
  imbalance: Boolean!
}

type AllocationRow {
  fundId: ID!
  fundName: String!
  parentFundId: ID
  level: String!
  availableCapital: Float!
  nav: Float!
  total: Float!
  cash: Float
  undrawn: Float
  line: Float
  reserve: Float
  issuerLimit: Float
  sponsorLimit: Float
  unfundedLimit: Float
  cells: [AllocationCell!]!
}

type AllocationTrancheResult {
  id: ID!
  name: String!
  size: Float!
  holdPct: Float!
  unfunded: Boolean!
  instrumentType: String!
  targetAmount: Float!
  allocated: Float!
  rank: Int
  label: String
  pricing: String
  callProtection: String
  equityLinked: Boolean
  coverage: String
  tickingFee: String
  status: String
  securityId: ID
}

# IRR or MOIC for one entity over a period, solved from position cash flows and market values.
type PeriodReturn {
  entityId: ID!
  attributeCode: String!
  startDate: String
  endDate: String!
  value: Float
}

type DealPerformanceRefresh {
  dealId: ID!
  asOfDate: String
  written: Int!
  closed: Int!
  unchanged: Int!
  errors: [MutationError!]!
}

type AllocationPreview {
  dealId: ID!
  dealCode: String!
  dealName: String!
  description: String
  stage: String
  strategy: String
  borrower: String
  borrowerId: ID
  sponsor: String
  sponsorId: ID
  pricing: String
  oid: String
  leverage: String
  maturity: String
  closeDate: String
  facilitySize: Float!
  targetHold: Float!
  allocated: Float!
  unallocated: Float!
  tranches: [AllocationTrancheResult!]!
  rows: [AllocationRow!]!
  adjustments: [AllocationAdjustmentView!]!
  errors: [MutationError!]!
}

type AllocationAdjustmentView {
  fundId: ID!
  trancheId: String!
  type: String!
  amount: Float
  reason: String
  note: String
  saved: Boolean
}

type IcMemoPoint {
  id: ID!
  kind: String!
  title: String
  body: String
  sortOrder: Int!
}

type IcCapitalItem {
  id: ID!
  side: String!
  label: String!
  amount: Float!
  sortOrder: Int!
}

type IcFinancialPeriod {
  id: ID!
  label: String!
  basis: String
  sortOrder: Int!
  revenue: Float
  ebitda: Float
  ebitdaMargin: Float
  freeCashFlow: Float
  fundedDebtToEbitda: Float
  ebitdaToCashInterest: Float
}

type IcApproval {
  id: ID!
  member: String!
  role: String!
  decision: String!
  decidedOn: String
  sortOrder: Int!
}

type IcOpenItem {
  id: ID!
  title: String!
  status: String!
  sortOrder: Int!
}

type IcTrancheYield {
  trancheId: ID!
  grossYield: Float
  seniority: String
}

type IcMemo {
  dealId: ID!
  clientId: ID
  issuerId: ID
  memoStatus: String
  team: String
  icDate: String
  sector: String
  baseRate: Float
  holdYears: Float
  expectedMoic: Float
  blendedIrr: Float
  recommendation: String
  points: [IcMemoPoint!]!
  capitalItems: [IcCapitalItem!]!
  periods: [IcFinancialPeriod!]!
  approvals: [IcApproval!]!
  openItems: [IcOpenItem!]!
  trancheYields: [IcTrancheYield!]!
  errors: [MutationError!]!
}

type FundAmountCell {
  amount: Float
  entityId: ID
  attributeCode: String
}

type FundLine {
  id: ID!
  label: String!
  role: String!
  indent: Int!
  administrator: Float
  shadow: Float
  variance: Float
  variancePct: Float
  status: String
  reviewable: Boolean!
  statement: String!
  signed: Float
}

type FundFacilityView {
  id: ID!
  name: String!
  commitment: Float!
  drawn: Float!
  borrowingBase: Float!
  availability: Float!
  utilization: Float
  maturity: String
}

type FundSeries {
  labels: [String!]!
  values: [Float]!
}

type FundPacingChart {
  labels: [String!]!
  plan: [Float]!
  actual: [Float]!
  projected: [Float]!
}

type FundActivityChart {
  labels: [String!]!
  calls: [Float!]!
  distributions: [Float!]!
}

type FundPlanRow {
  id: ID!
  label: String!
  quarterEnd: String
  callAmount: Float
  cumulative: Float
  calledPct: Float
  unfunded: Float
  planPct: Float
  versusPts: Float
  future: Boolean!
}

type FundActivityRow {
  id: ID!
  date: String
  label: String!
  kind: String!
  amount: Float!
  signed: Float!
  status: String!
  statusLabel: String!
  outstanding: Float
  notice: String
  pctOfCommitments: Float
}

type FundStatement {
  kind: String!
  title: String!
  period: String!
  comparable: Boolean!
  rows: [FundLine!]!
}

type FundMark {
  id: ID!
  name: String!
  mark: Float
  agent: Float
  difference: Float
  impact: Float
  status: String
}

type FundPositionRow {
  id: ID!
  name: String!
  strategyCode: String
  strategy: String!
  sector: String!
  issuer: String!
  issuerId: ID
  cost: Float!
  fairValue: Float!
  income: Float!
  realized: Float!
  gain: Float!
  moic: Float
  grossIrr: Float
  mark: Float
  coupon: String
  leverage: Float
  floating: Boolean!
  active: Boolean!
}

type FundForecastRow {
  label: String!
  emphasize: Boolean!
  cells: [FundAmountCell!]!
}

type FundInvestorRow {
  id: ID!
  investorId: ID
  name: String!
  typeCode: String
  typeLabel: String!
  commitment: Float!
  sharePct: Float
  called: Float!
  unfunded: Float!
  distributions: Float!
  nav: Float!
  status: String!
  pastDue: Float!
}

type FundShare {
  label: String!
  amount: Float!
  sharePct: Float
}

type FundExposureBar {
  key: String!
  label: String!
  amount: Float!
  sharePct: Float
  limitPct: Float
  status: String!
  limitId: ID
}

type FundExposure {
  strategy: [FundExposureBar!]!
  sector: [FundExposureBar!]!
  issuer: [FundExposureBar!]!
}

type FundPacing {
  calledPct: Float
  planPct: Float
  planLabel: String
  behindPts: Float
  behindAmount: Float
  requiredCall: Float
  trailingCall: Float
}

type FundNextCall {
  id: ID!
  amount: Float!
  notice: String
  date: String
}

type FundNamedAmount {
  name: String!
  sharePct: Float
  amount: Float
}

type FundSurface {
  fundId: ID!
  fundCode: String!
  fundName: String!
  strategyCode: String
  strategyLabel: String!
  vintage: String
  reportingDate: String
  commitmentsClosed: String
  investmentPeriodEnd: String
  monthsRemaining: Int
  nav: Float!
  commitments: Float!
  called: Float!
  distributed: Float!
  unfunded: Float!
  netPaidIn: Float!
  grossIrr: Float
  feeDrag: Float
  expenseDrag: Float
  carryDrag: Float
  netIrr: Float
  tvpi: Float
  dpi: Float
  rvpi: Float
  cash: Float!
  unfundedBorrower: Float!
  liquidityMin: Float!
  targetCalledPct: Float!
  facilityAvailability: Float!
  availableLiquidity: Float!
  liquidityCoverage: Float
  investmentsFairValue: Float!
  activePositions: Int!
  sectorCount: Int!
  floatingRatePct: Float
  weightedLeverage: Float
  weightedMark: Float
  marksBelow: Int!
  reviewOpen: Int!
  reviewFlagged: Int!
  certified: Boolean!
  tolerancePct: Float!
  statementId: ID
  periodLabel: String
  facility: FundFacilityView
  navChart: FundSeries!
  pacingChart: FundPacingChart!
  activityChart: FundActivityChart!
  rollforward: [FundLine!]!
  composition: [FundLine!]!
  plans: [FundPlanRow!]!
  activities: [FundActivityRow!]!
  statements: [FundStatement!]!
  marks: [FundMark!]!
  positions: [FundPositionRow!]!
  forecastLabels: [String!]!
  forecastRows: [FundForecastRow!]!
  investors: [FundInvestorRow!]!
  investorTypes: [FundShare!]!
  exposure: FundExposure!
  pacing: FundPacing!
  nextCall: FundNextCall
  largestInvestor: FundNamedAmount
  pastDue: FundNamedAmount
  investorCount: Int!
  errors: [MutationError!]!
}

# File: root.graphql
# Root Query Type

"""A covenant tested on one date: its value from the deal's own definition, the house standard, and the borrower's certificate."""
type CovenantTest {
  covenantId: ID!
  code: String!
  name: String!
  dealId: ID
  dealName: String
  """NET_LEVERAGE, TOTAL_LEVERAGE, INTEREST_COVERAGE, FIXED_CHARGE_COVERAGE, or LIQUIDITY."""
  metric: String
  """MAX or MIN."""
  direction: String
  """MULTIPLE or CURRENCY."""
  unit: String
  level: Float
  firstTest: Date
  """The test date is before the covenant's first test. The value is shown for monitoring."""
  beforeFirstTest: Boolean!
  asOf: Date!
  """End of the latest borrower quarter on or before the as-of date."""
  testDate: Date
  """What this deal's definition gives now."""
  value: Float
  numerator: Float
  denominator: Float
  """The golden value stored for the covenant."""
  stored: Float
  """A manual entry is overriding the calculation."""
  manualOverride: Boolean!
  """The stored value no longer matches the definition and needs recalculating."""
  stale: Boolean!
  """PASS, WATCH, BREACH, or NO_DATA."""
  status: String!
  cushion: Float
  """The same borrower under the house standard for this metric."""
  house: Float
  houseId: ID
  houseName: String
  """Values from other sources, such as the borrower's compliance certificate."""
  reported: [CovenantReading!]!
  """Certificate value less the calculated value."""
  reportedDifference: Float
  isLibrary: Boolean!
  isHouse: Boolean!
  components: [CovenantComponentResult!]!
  """Why the value could not be calculated."""
  missing: [String!]!
  """Quarter ends, oldest first."""
  history: [CovenantHistoryPoint!]!
}

"""One line of a covenant definition and what it contributed on the test date."""
type CovenantComponentResult {
  id: ID!
  name: String!
  side: String!
  line: String
  lineName: String
  sign: String!
  measure: String!
  capType: String!
  capValue: Float
  effectiveFrom: Date
  effectiveTo: Date
  clause: String
  """In force on the test date."""
  active: Boolean!
  """The statement value for the period, before any cap."""
  raw: Float
  capLimit: Float
  allowed: Float
  """What it added to its side, after the cap and the sign."""
  applied: Float
  capped: Boolean!
}

type CovenantReading {
  sourceCode: String!
  sourceName: String!
  value: Float
  validFrom: Date
}

type CovenantHistoryPoint {
  testDate: Date!
  value: Float
  house: Float
  """The level in force on this quarter end."""
  level: Float
  """On or after the first test. Earlier quarters are for monitoring."""
  tested: Boolean!
}

"""A definition in the library that a covenant can copy."""
type CovenantDefinitionChoice {
  id: ID!
  name: String!
  description: String
  metric: String
  isHouse: Boolean!
  componentCount: Int!
}

type Query {
  # Generic entity queries
  entities(
    filter: EntityFilter
    pagination: PaginationInput
    asOfDate: Date
    knowledgeDate: DateTime
  ): EntityConnection!
  
  entity(id: ID, entityCode: String, asOfDate: Date, knowledgeDate: DateTime): Entity

  """Match entity names, related entity names, and parent entity names. Parent domains rank before child domains."""
  searchEntities(query: String!, limit: Int): [EntitySearchHit!]!
  
  # Domain-specific queries (for convenience, but use generic entity under the hood)
  funds(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  issuers(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  securities(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  deals(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  investors(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  positions(filter: EntityFilter, pagination: PaginationInput, asOfDate: Date): EntityConnection!
  
  # Metadata queries
  domainTypes: [DomainTypeRecord!]!
  domainGroups: [DomainGroup!]!
  domainRecordCounts: [DomainRecordCount!]!
  attributeRegister(domainCode: String): [AttributeDefinition!]!
  attributeSections(domainCode: String!): [AttributeSection!]!
  domainTemplates(domainCode: String): [Template!]!
  previewStatementTemplate(input: PreviewStatementTemplateInput!): PreviewStatementTemplateResult!
  calcDefinitions: [CalcDefinition!]!
  calcBreakdown(entityId: ID!, attributeCode: String!, asOfDate: Date, knowledgeDate: DateTime): CalcBreakdown
  calculatedAttributeStates(entityId: ID!): [CalculatedAttributeState!]!
  expressionFunctions(category: String): [ExpressionFunction!]!
  matchRules: [MatchRule!]!
  mergeCandidates(filter: MergeCandidateFilter): MergeCandidateResult!
  mergePreview(survivorId: ID!, retiredId: ID!, ruleCode: String): MergePreview!
  entityGraph(entityId: ID!, depth: Int, relationshipCodes: [String!]): EntityGraph!
  previewAllocation(dealId: ID!, asOfDate: Date, holds: [AllocationHoldInput!], adjustments: [AllocationAdjustmentInput!]): AllocationPreview!
  # Returns over any period. No start date is inception to date. The codes are series calcs such as DEAL_IRR_ITD.
  periodReturns(entityIds: [ID!]!, attributeCodes: [String!]!, startDate: Date, endDate: Date): [PeriodReturn!]!
  icMemo(dealId: ID!, asOfDate: Date): IcMemo!
  fundSurface(fundId: ID!, asOfDate: Date, knowledgeDate: DateTime): FundSurface!
  """Close board: every fund with a close calendar, its current close, status, breaks, and what is still open."""
  fundRecBoard(asOfDate: Date, knowledgeDate: DateTime): JSON!
  """One fund close: statement integrity, roll-forward, fees, marks, drift, review items, and close steps."""
  fundRec(fundId: ID!, periodEnd: Date, asOfDate: Date, knowledgeDate: DateTime, driftThresholdPct: Float): JSON!
  """Positional cash flows matched to the fund's bank transactions, with the tie-out."""
  cashRec(fundId: ID!, periodEnd: Date, asOfDate: Date, knowledgeDate: DateTime): JSON!
  """Job types the worker can run."""
  jobTypes: [JobType!]!
  """Schedules for the caller's clients. Tenant admins also see platform schedules."""
  jobSchedules: [JobSchedule!]!
  """Recent job runs, newest first."""
  jobRuns(status: String, scheduleId: ID, first: Int): [JobRun!]!
  """Workflows the caller can see: their clients' own, and the shared ones."""
  workflows: [Workflow!]!
  """One workflow with the graph of a version. Leave version out for the latest save."""
  workflow(id: ID!, version: Int): Workflow
  """Starting points for a new workflow."""
  workflowTemplates: [WorkflowTemplate!]!
  """Records to choose from when starting a run: the first few of a type, or those matching the search."""
  workflowRecordChoices(domainCode: String, search: String, first: Int): [WorkflowRecordChoice!]!
  """The kinds of step a workflow can have."""
  workflowNodeTypes: JSON!
  """Recent workflow runs, newest first."""
  workflowRuns(workflowId: ID, status: String, first: Int): [WorkflowRun!]!
  """One run with the graph it ran, each step, its audit log, and its reviews."""
  workflowRun(id: ID!): WorkflowRun
  """Reviews waiting for a person, the ones due soonest first. status defaults to OPEN. mine keeps those the caller can decide now."""
  workflowReviews(status: String, mine: Boolean): [WorkflowReview!]!
  """One review with its proposal, for deciding it where it is shown. Null when it is not found or not visible."""
  workflowReview(id: ID!): WorkflowReview
  """Who a review step can be assigned to: people holding workflow.review in the client, and the roles that grant it. Leave out clientId for a shared workflow."""
  workflowReviewerChoices(clientId: ID): WorkflowReviewerChoices!
  """Who is responsible for a record or a domain. Filter by record, by domain, or to the caller's own."""
  responsibilities(entityId: ID, domainCode: String, mine: Boolean): [Responsibility!]!
  """Who is responsible for one record right now, after the nearest assignment wins."""
  responsibleForEntity(entityId: ID!, activity: String): [ResponsiblePerson!]!
  """The named agents a workflow agent step can run as: the shared ones and this session's clients' own."""
  agents(clientId: ID): [Agent!]!
  """The workflow runs in flight, which agent is behind each, and the standing of every agent. With mine, only runs the caller started or that touch their universe."""
  agentsAtWork(mine: Boolean): AgentsAtWork!
  """One covenant tested on a date, with its definition line by line and quarter-end history."""
  covenantTest(covenantId: ID!, asOfDate: Date, history: Int): CovenantTest
  """Every covenant on a deal, tested on a date, without history."""
  dealCovenantTests(dealId: ID!, asOfDate: Date): [CovenantTest!]!
  """Covenant definitions to copy from, house standards included."""
  covenantLibrary(asOfDate: Date): [CovenantDefinitionChoice!]!
  """The records that are the caller's to care about: what they follow and what they are responsible for."""
  myUniverse: MyUniverse!
  """The people, roles, and activities a responsibility can be set to."""
  responsibilityChoices(clientId: ID): ResponsibilityChoices!
  """What starts this workflow when something happens: feed events or new data quality failures."""
  workflowTriggers(workflowId: ID!): [WorkflowTrigger!]!
  """Where this client's review notices are sent besides the assistant: email and Slack."""
  notificationSettings: NotificationSettings!
  """How each workflow did over the last days (default 30): runs, durations, review times, overdue reviews, approvals, slowest steps, commonest failure."""
  workflowAnalytics(days: Int): JSON!
  """Token use and cost of model calls this session can see. days is a rolling window (default 30, at most a year). from and to are ISO timestamps and override days. Filters match one feature, agent, user, or model."""
  agentUsage(days: Int, from: String, to: String, feature: String, agent: String, userId: ID, model: String): JSON!
  """One model call, including its thinking, when this session can see that client."""
  agentCall(id: ID!): JSON
  """Forms workflow steps are waiting on. status defaults to OPEN; runId keeps one run's."""
  workflowForms(status: String, runId: ID): [WorkflowForm!]!
  """Stages workflow steps are waiting on. status defaults to OPEN; pass null with a runId for every stage of one run."""
  workflowStages(status: String, runId: ID): [WorkflowStage!]!
  """The screens a Stage step can show."""
  workflowStageScreens: [WorkflowStageScreen!]!
  """The runs a run was split into, one per record: [{ id, status, input, createdAt, finishedAt, openReviews }]."""
  workflowRunChildren(runId: ID!): JSON!
  """A form by its private link, for someone outside the firm. Null when the link is wrong, used, or expired. Needs no sign-in."""
  workflowPortalForm(token: String!): JSON
  """Places files arrive from, for the caller's clients. Stored credentials are never returned."""
  feedConnections: [FeedConnection!]!
  feeds: [Feed!]!
  """Files the feeds have seen, newest first."""
  receivedFiles(feedId: ID, first: Int): [ReceivedFile!]!
  """Saved maps a feed can load through."""
  feedMaps: [FeedMapOption!]!
  # Document content: types, templates, documents and search (see docs/DOCUMENTS.md)
  documentTypes: [DocumentType!]!
  documentTemplates(typeId: ID): [DocumentTemplate!]!
  documents(typeId: ID, entityId: ID, first: Int): [Document!]!
  document(id: ID!): Document
  documentChunks(documentId: ID!, sectionId: ID, first: Int, offset: Int): [DocumentChunk!]!
  documentText(id: ID!, start: Int!, end: Int!): DocumentText
  documentTags: [DocumentTag!]!
  searchDocuments(query: String!, tags: [String!], entityIds: [ID!], typeCodes: [String!], documentIds: [ID!], first: Int): DocumentSearchResult!
  documentFileUrl(id: ID!): String
  """When the caller wants a summary, and whether delivery is on."""
  assistantSettings: AssistantSettings!
  """What the caller has asked the assistant to follow."""
  assistantFollows: [AssistantFollow!]!
  """Where the caller's home page differs from their role default, for the client in this session."""
  homeLayout: HomeLayout!
  """Recent changes to what the caller follows, newest first."""
  homeActivity(days: Int, first: Int): [HomeActivityItem!]!
  """The caller's latest assistant brief, and whether the assistant is on."""
  homeBrief: HomeBrief!
  """What the caller follows, each with its latest change."""
  homeFollows: [HomeFollow!]!
  # Entity Management queries
  entityIdentifierDefinitions(domainCode: String): [EntityIdentifierDefinition!]!
  relationshipTypes: [RelationshipType!]!
  effectiveTemplates(entityIds: [ID!]!, asOfDate: Date): [EffectiveTemplate!]!
  templateChoiceSlots(entityId: ID!): [TemplateChoiceSlot!]!
  
  # Lineage and temporal queries
  fieldLineage(entityId: ID!, asOfDate: Date, knowledgeDate: DateTime): [FieldLineage!]!
  entityActivity(entityId: ID!, knowledgeDate: DateTime, attributeCode: String, limit: Int): [AttributeActivity!]!
  temporalHistory(entityId: ID!, attributeCode: String!, fromDate: Date!, toDate: Date!): [TemporalValue!]!
  
  # DQ queries
  dqRule(id: ID!): DQRule
  "Applies a rule expression to current records without saving it."
  dqRulePreview(input: DQRulePreviewInput!): DQRulePreview!
  dqRules(filter: DQRuleFilter, pagination: PaginationInput): [DQRule!]!
  dqExceptions(filter: DQExceptionFilter, pagination: PaginationInput): DQExceptionConnection!
  dataQualityDashboard(domainCode: String, fromDate: Date, toDate: Date, knowledgeDate: DateTime, entityId: ID): DataQualityDashboard!
  dqAvailabilityDetail(attributeCode: String!, domainCode: String, fromDate: Date, toDate: Date, knowledgeDate: DateTime, entityId: ID): AvailabilityDetail!
  staleAttributes(domainCode: String, olderThanDays: Int, asOfDate: Date, knowledgeDate: DateTime, entityId: ID): StaleAttributeReport!
  
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
  entityAccess(entityId: ID!): EntityAccessRecord
  entityAccessRoster(clientId: ID!, search: String): [EntityAccessRecord!]!
  myPermissions(clientId: ID!): [String!]!
  clientAuthRequirements(clientId: ID!): ClientAuthRequirements
  clientIdentityProviders(clientId: ID!): [ClientIdentityProvider!]!

  # Compliance Rules queries
  complianceRules(filter: ComplianceRuleFilter): [ComplianceRule!]!
  complianceRule(id: ID, ruleCode: String): ComplianceRule
  complianceEvaluationRuns(ruleId: ID, first: Int): [ComplianceEvaluationRun!]!
  complianceEvaluationRun(id: ID!): ComplianceEvaluationRun
  complianceResults(filter: ComplianceResultFilter, pagination: PaginationInput): ComplianceEvaluationResultConnection!
  complianceResultContributors(resultId: ID!): ComplianceResultContributors!
  compliancePopulationPreview(input: CompliancePopulationPreviewInput!): CompliancePopulationPreview!
  complianceFundBoard: ComplianceFundBoard!
  # Booked book plus any number of buys and sells, scored together.
  evaluateComplianceProforma(
    anchorEntityId: ID!
    legs: [ComplianceProformaLegInput!]!
    asOfDate: Date!
    knowledgeDate: DateTime
    sourceScope: String
    ruleCodes: [String!]
  ): ComplianceProformaScore!
  # Largest additional par of one security. legs are the rest of the package.
  investmentCapacity(
    anchorEntityId: ID!
    securityId: ID
    securityCode: String
    asOfDate: Date!
    knowledgeDate: DateTime
    sourceScope: String
    ruleCodes: [String!]
    limitKind: String
    legs: [ComplianceProformaLegInput!]
  ): ComplianceCapacity!

  # Reference List queries
  referenceLists(domainCode: String, isActive: Boolean): [ReferenceListSummary!]!
  referenceList(id: ID, listCode: String): ReferenceListDetail
  normalizeValue(listCode: String!, values: [String!]!): [NormalizationResult!]!

  # Record experiences: editable multi-entity working screens
  recordExperiences(anchorDomainCode: String, isActive: Boolean): [RecordExperience!]!
  recordExperience(experienceCode: String!): RecordExperience

  # Reporting (dashboards & narratives)
  dashboards(domainCode: String, isActive: Boolean): [Dashboard!]!
  dashboard(id: ID, dashboardCode: String): Dashboard
  narratives(domainCode: String, isActive: Boolean): [Narrative!]!
  narrative(id: ID, narrativeCode: String): Narrative
  narrativeRuns(narrativeId: ID!, entityId: ID, first: Int, statuses: [String!]): [NarrativeRun!]!
  narrativeRun(id: ID!): NarrativeRun
  runDataQueries(queries: JSON!, entityId: ID, entityCode: String, params: JSON, asOfDate: String, knowledgeDate: String): DataQueryResponse!
  gridQuery(input: GridQueryInput!): GridResult!

  # Surface composition
  surfaces: [SurfaceDefinition!]!
  surfaceCatalog(surfaceCode: String!): SurfaceCatalog
  resolveSurface(surfaceCode: String!, profileCode: String, entityId: ID, entityCode: String, facts: JSON): SurfaceResolution
  entitySurface(entityId: ID, entityCode: String): SurfaceResolution
  reconciliationDefinitions(domainCode: String): [ReconciliationDefinition!]!
  reconciliationRuns(status: String, first: Int): [ReconciliationRun!]!
  reconciliationRun(id: ID!): ReconciliationRun
}

type Mutation {
  saveSurfaceCatalog(surfaceCode: String!, tabs: JSON!): SurfaceCatalog!
  """Replace a covenant's definition from a first test date with a copy of a library definition. Earlier quarters keep the definition they were tested under."""
  copyCovenantDefinition(covenantId: ID!, fromCovenantId: ID!, effectiveFrom: Date!): CovenantTest!
  """Store the covenant's calculated value again for every quarter end."""
  recalculateCovenant(covenantId: ID!): CovenantTest!

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
  clearManualOverride(input: ClearManualOverrideInput!): ClearManualOverrideResult!
  addCompetingSource(input: AddCompetingSourceInput!): AddCompetingSourceResult!
  deleteCompetingSource(input: DeleteCompetingSourceInput!): DeleteCompetingSourceResult!
  
  # Metadata mutations
  createDomainType(input: CreateDomainTypeInput!): CreateDomainTypeResult!
  createDomainGroup(input: CreateDomainGroupInput!): CreateDomainGroupResult!
  updateDomainType(input: UpdateDomainTypeInput!): UpdateDomainTypeResult!
  deleteDomainType(id: ID!): DeleteDomainTypeResult!
  createAttribute(input: CreateAttributeInput!): CreateAttributeResult!
  updateAttributeDefinition(input: UpdateAttributeDefinitionInput!): UpdateAttributeDefinitionResult!
  createAttributeSection(domainCode: String!, sectionName: String!): AttributeSectionResult!
  renameAttributeSection(id: ID!, sectionName: String!): AttributeSectionResult!
  reorderAttributeSections(domainCode: String!, orderedIds: [ID!]!): AttributeSectionResult!
  updateAttributeSection(id: ID!, columnCount: Int!): AttributeSectionResult!
  deleteAttributeSection(id: ID!): AttributeSectionResult!
  reorderSectionAttributes(domainCode: String!, sectionName: String!, attributeIds: [ID!]!): AttributeSectionResult!
  processCalculatedAttributes(limit: Int): ProcessCalculatedAttributesResult!
  updateCalcExpression(id: ID!, expression: JSON!, operands: [CalcOperandInput!]): UpdateCalcExpressionResult!
  updateCalcAggregate(id: ID!, aggregateFn: String!, measure: CalcOperandInput!, weightAttributeCode: String): UpdateCalcExpressionResult!
  deleteAttribute(id: ID!): MutationResult!
  createTemplate(input: CreateTemplateInput!): CreateTemplateResult!
  updateTemplate(id: ID!, input: UpdateTemplateInput!): UpdateTemplateResult!
  assignAttributeToTemplate(input: AssignAttributeInput!): AssignAttributeResult!
  updateTemplateAttribute(input: UpdateTemplateAttributeInput!): UpdateTemplateAttributeResult!
  reorderTemplateAttributes(input: ReorderTemplateAttributesInput!): ReorderTemplateAttributesResult!
  unassignAttributeFromTemplate(templateId: ID!, attributeId: ID!): MutationResult!
  applyStatementTemplate(input: ApplyStatementTemplateInput!): ApplyStatementTemplateResult!
  updateTemplateSourcePreference(input: UpdateTemplateSourcePreferenceInput!): UpdateTemplateSourcePreferenceResult!
  mergeEntities(survivorId: ID!, retiredId: ID!, fieldChoices: [MergeFieldChoiceInput!], matchScore: Int, matchReasons: JSON): MergeEntitiesResult!
  updateMatchRule(input: UpdateMatchRuleInput!): UpdateMatchRuleResult!
  createMatchRule(input: CreateMatchRuleInput!): UpdateMatchRuleResult!
  commitAllocation(dealId: ID!, asOfDate: Date, holds: [AllocationHoldInput!], adjustments: [AllocationAdjustmentInput!]): AllocationPreview!
  # Run the deal performance model on the committed allocation and store its outputs as attribute values.
  refreshDealPerformance(dealId: ID!, asOfDate: Date): DealPerformanceRefresh!
  
  # DQ mutations
  createDQRule(input: CreateDQRuleInput!): CreateDQRuleResult!
  updateDQRule(input: UpdateDQRuleInput!): UpdateDQRuleResult!
  resolveDQException(input: ResolveDQExceptionInput!): ResolveDQExceptionResult!
  recordDQDisposition(input: RecordDQDispositionInput!): RecordDQDispositionResult!
  confirmAttributeReceipt(entityId: ID!, attributeCode: String!): ConfirmAttributeReceiptResult!
  
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
  setEntityTemplateChoice(input: SetEntityTemplateChoiceInput!): SetEntityTemplateChoiceResult!

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
  setEntityRoleAccess(clientId: ID!, entityId: ID!, roles: [EntityRoleGrantInput!]!): MutationResult!
  startImpersonation(clientId: ID!, reason: String): MutationResult!
  stopImpersonation: MutationResult!
  updateProfile(input: UpdateProfileInput!): UpdateProfileResult!
  updateClientAuthRequirements(input: UpdateClientAuthRequirementsInput!): MutationResult!
  upsertClientIdentityProvider(input: UpsertClientIdentityProviderInput!): MutationResult!
  deleteClientIdentityProvider(id: ID!): MutationResult!

  # Compliance Rules mutations
  createComplianceRule(input: CreateComplianceRuleInput!): CreateComplianceRuleResult!
  updateComplianceRule(id: ID!, input: UpdateComplianceRuleInput!): UpdateComplianceRuleResult!
  deleteComplianceRule(id: ID!): DeleteComplianceRuleResult!
  createComplianceRuleVersion(input: CreateComplianceRuleVersionInput!): CreateComplianceRuleVersionResult!
  createComplianceScopeAssignment(input: CreateComplianceScopeAssignmentInput!): CreateComplianceScopeAssignmentResult!
  deleteComplianceScopeAssignment(id: ID!): DeleteComplianceScopeAssignmentResult!
  evaluateComplianceRule(input: EvaluateComplianceRuleInput!): EvaluateComplianceRuleResult!
  scoreDealCompliance(dealId: ID!, asOfDate: Date, holds: [AllocationHoldInput!], adjustments: [AllocationAdjustmentInput!]): DealComplianceScore!
  upsertComplianceThreshold(input: UpsertComplianceThresholdInput!): UpsertComplianceThresholdResult!
  deleteComplianceThreshold(id: ID!): DeleteComplianceThresholdResult!

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
  publishNarrativeRun(id: ID!, label: String): NarrativeRun!
  unpublishNarrativeRun(id: ID!): NarrativeRun!

  openReconciliationRun(input: OpenReconciliationRunInput!): ReconciliationRunResult!
  resolveReconciliationLine(input: ResolveReconciliationLineInput!): ReconciliationRunResult!
  decideReconciliationRun(input: DecideReconciliationRunInput!): ReconciliationRunResult!

  # Job schedules and runs
  saveJobSchedule(input: SaveJobScheduleInput!): JobScheduleResult!
  deleteJobSchedule(id: ID!): MutationResult!
  """Queues the schedule's job now. Returns the run already open for it when there is one."""
  runJobScheduleNow(id: ID!): JobRunResult!
  """Puts a failed or cancelled run back in the queue."""
  retryJobRun(id: ID!): JobRunResult!
  """Cancels a queued run. A running job is not interrupted."""
  cancelJobRun(id: ID!): JobRunResult!

  # Workflows: definitions, runs, and reviews
  """Saves a new version of a workflow. It is not published."""
  saveWorkflow(input: SaveWorkflowInput!): WorkflowResult!
  """Makes a version the one new runs use. Refused while the graph has problems."""
  publishWorkflow(id: ID!, version: Int!): WorkflowResult!
  archiveWorkflow(id: ID!): MutationResult!
  """Starts a run on the published version, or on a version to try a draft."""
  startWorkflowRun(workflowId: ID!, input: JSON, version: Int): WorkflowRunResult!
  cancelWorkflowRun(id: ID!): WorkflowRunResult!
  """Puts a failed run back in the queue. It continues from the step that failed."""
  retryWorkflowRun(id: ID!): WorkflowRunResult!
  """Approves or rejects the changes a run proposed, and lets the run continue."""
  decideWorkflowReview(input: DecideWorkflowReviewInput!): WorkflowReviewResult!
  """Hands an open review to other people or roles. Empty lists open it to anyone who can review."""
  reassignWorkflowReview(input: ReassignWorkflowReviewInput!): WorkflowReviewResult!
  """Creates (no id) or changes a trigger. It starts runs as the caller."""
  saveWorkflowTrigger(input: SaveWorkflowTriggerInput!): WorkflowTriggerResult!
  deleteWorkflowTrigger(id: ID!): MutationResult!
  """Turns email on or off, and sets the Slack address. Leave slackWebhookUrl out to keep the saved one; an empty string removes it."""
  saveNotificationSettings(emailEnabled: Boolean!, slackWebhookUrl: String): NotificationSettingsResult!
  """Answers a form, or declines it. The run goes on down the submitted or declined path."""
  submitWorkflowForm(id: ID!, outcome: String!, answers: JSON, note: String): WorkflowFormResult!
  """Leaves a stage with one of its outcomes. The run goes on down that outcome's path, or hands the stage back when it does not hold up."""
  completeWorkflowStage(id: ID!, outcome: String!, result: JSON): WorkflowStageResult!
  """Answers a form by its private link. Needs no sign-in. The link stops working once used."""
  submitWorkflowPortalForm(token: String!, outcome: String!, answers: JSON, note: String): MutationResult!

  # Feeds: files that arrive on their own
  saveFeedConnection(input: SaveFeedConnectionInput!): FeedConnectionResult!
  deleteFeedConnection(id: ID!): MutationResult!
  """Queues a check that the connection can be reached. The result shows on the connection."""
  checkFeedConnection(id: ID!): JobRunResult!
  saveFeed(input: SaveFeedInput!): FeedResult!
  """Deletes the feed, its poll schedule and its file history."""
  deleteFeed(id: ID!): MutationResult!
  """Queues a poll of the feed now."""
  pollFeedNow(id: ID!): JobRunResult!
  # Document content
  saveDocumentType(input: SaveDocumentTypeInput!): DocumentTypeResult!
  saveDocumentTemplate(input: SaveDocumentTemplateInput!): DocumentTemplateResult!
  generateDocumentTemplate(typeId: ID!, documentIds: [ID!]!, baseTemplateId: ID): DocumentTemplateResult!
  publishDocumentTemplate(id: ID!): PublishDocumentTemplateResult!
  deleteDocumentTemplate(id: ID!): MutationResult!
  updateDocument(input: UpdateDocumentInput!): DocumentResult!
  deleteDocument(id: ID!): MutationResult!
  reprocessDocument(id: ID!): DocumentResult!
  retagDocument(id: ID!): DocumentResult!
  assignDocumentSection(sectionId: ID!, templateSectionCode: String): DocumentResult!
  refineDocumentChunk(chunkId: ID!, summary: String, topics: [String!]): MutationResult!

  saveAssistantSettings(input: SaveAssistantSettingsInput!): SaveAssistantSettingsResult!
  saveAssistantFollow(input: SaveAssistantFollowInput!): SaveAssistantFollowResult!
  deleteAssistantFollow(id: ID!): MutationResult!
  """Says whether one of the caller's follows also covers the records under it. Only a followed record can."""
  setAssistantFollowChildren(id: ID!, includeChildren: Boolean!): SaveAssistantFollowResult!
  """Names a person or a role as responsible for a record or a domain. Needs responsibility.manage."""
  saveResponsibility(input: SaveResponsibilityInput!): SaveResponsibilityResult!
  deleteResponsibility(id: ID!): MutationResult!
  """Creates or changes a named agent. A shared agent (no client) needs a tenant admin; a client's needs agent.manage."""
  saveAgent(input: SaveAgentInput!): SaveAgentResult!
  deleteAgent(id: ID!): MutationResult!
  deliverAssistantBrief: MutationResult!
  """Saves the caller's home page choices. Null for a list returns it to the default."""
  saveHomeLayout(input: SaveHomeLayoutInput!): SaveHomeLayoutResult!
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

input ClearManualOverrideInput {
  entityId: ID!
  attributeCode: String!
  asOf: Date
}

type ClearManualOverrideResult {
  success: Boolean!
  errors: [MutationError!]!
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

input DeleteCompetingSourceInput {
  entityId: ID!
  attributeCode: String!
  sourceId: ID!
  asOfDate: Date
}

type DeleteCompetingSourceResult {
  success: Boolean!
  errors: [MutationError!]!
}

# Metadata Types
input UpdateAttributeDefinitionInput {
  id: ID!
  attributeName: String
  dataType: String
  description: String
  unitOfMeasure: String
  isMultiValued: Boolean
  displayFormat: String
  listValues: [String!]
  validationRules: JSON
  defaultValue: String
  displaySection: String
  displayGroup: Int
  displaySpanColumns: Int
  displaySpanRows: Int
  isEditable: Boolean
  isVisible: Boolean
  aggregationType: String
  weightAttributeCode: String
  numericPrecision: Int
  referenceListCode: String
}

type UpdateAttributeDefinitionResult {
  success: Boolean!
  attribute: AttributeDefinition
  errors: [MutationError!]!
}

type AttributeSection {
  id: ID!
  domainCode: String!
  sectionName: String!
  displayOrder: Int!
  columnCount: Int!
}

type AttributeSectionResult {
  success: Boolean!
  section: AttributeSection
  sections: [AttributeSection!]
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
  clientId: ID
  clientName: String
  attributes: [TemplateAttribute!]!
  sections: [TemplateSection!]
  aliases: [AttributeAlias!]
}

type TemplateAttribute {
  attributeId: ID!
  attribute: AttributeDefinition!
  isRequired: Boolean!
  precedenceRank: Int!
  displayOrder: Int!
  displayLabel: String
  sectionCode: String
  sectionName: String
  defaultPrecedenceChain: [String!]!
  chainVersion: Int!
}

type TemplateSection {
  id: ID!
  sectionCode: String!
  sectionName: String!
  displayOrder: Int!
  description: String
}

type AttributeAlias {
  id: ID!
  aliasLabel: String!
  aliasCode: String!
  matchKind: String!
  confidence: Float!
  domainCode: String
  attributeCode: String!
  attributeName: String!
}

input StatementSourceInput {
  sourceName: String!
  sourceKind: String!
  text: String!
}

input PreviewStatementTemplateInput {
  domainCode: String!
  statementKind: String
  sources: [StatementSourceInput!]!
}

type StatementLineDraft {
  attributeCode: String!
  attributeName: String!
  dataType: String!
  displayOrder: Int!
  displayLabel: String!
  matchKind: String!
  confidence: Float!
  isNew: Boolean!
  required: Boolean!
  aliases: [String!]!
  sampleValue: String
  sources: [String!]!
}

type StatementSectionDraft {
  sectionCode: String!
  sectionName: String!
  displayOrder: Int!
  lines: [StatementLineDraft!]!
}

type StatementCatalogAttribute {
  attributeCode: String!
  attributeName: String!
  dataType: String!
}

type PreviewStatementTemplateResult {
  sections: [StatementSectionDraft!]!
  warnings: [String!]!
  catalog: [StatementCatalogAttribute!]!
}

input ApplyStatementLineInput {
  attributeCode: String!
  attributeName: String!
  dataType: String!
  displayOrder: Int!
  displayLabel: String!
  matchKind: String!
  isNew: Boolean!
  required: Boolean!
  aliases: [String!]
}

input ApplyStatementSectionInput {
  sectionCode: String!
  sectionName: String!
  displayOrder: Int!
  lines: [ApplyStatementLineInput!]!
}

input ApplyStatementSourceInput {
  sourceName: String!
  sourceKind: String!
  excerpt: String
}

input ApplyStatementTemplateInput {
  templateCode: String!
  templateName: String!
  domainCode: String!
  description: String
  statementKind: String!
  entityCode: String
  existingTemplateId: ID
  sections: [ApplyStatementSectionInput!]!
  sources: [ApplyStatementSourceInput!]
}

type ApplyStatementTemplateResult {
  template: Template
  aliasCount: Int!
  sectionCount: Int!
  errors: [MutationError!]!
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
  templateFromSide: String
  clientId: ID
}

input UpdateRelationshipTypeInput {
  id: ID!
  relationshipCode: String
  relationshipName: String
  parentDomainCode: String
  childDomainCode: String
  description: String
  isActive: Boolean
  cardinality: String
  compositeKey: [String!]
  templateFromSide: String
}


# Record experiences compose one anchor entity with related forms, grids, and dashboards.

type ExperienceSection {
  key: String!
  title: String!
  kind: String!
  placement: String!
  domainCode: String
  relationshipCode: String
  direction: String
  columns: [String!]!
  dashboardCode: String
  templateCode: String
}

type ExperiencePipelineStage {
  code: String!
  label: String!
}

type ExperiencePipeline {
  stageAttribute: String!
  stages: [ExperiencePipelineStage!]!
  cardAttributes: [String!]!
}

type RecordExperience {
  id: ID!
  experienceCode: String!
  experienceName: String!
  description: String
  anchorDomainCode: String!
  sections: [ExperienceSection!]!
  pipeline: ExperiencePipeline
  isDefault: Boolean!
  isActive: Boolean!
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
  sections: JSON!
  persona: String
  audience: String
  rules: JSON!
  exposedDomains: [String!]!
  allowExternalSearch: Boolean!
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
  asOfDate: String
  sources: JSON!
  verification: JSON!
  plan: JSON!
  origin: String!
  createdByLabel: String
  publishedAt: DateTime
  publishedBy: ID
  publishedByLabel: String
  publishedLabel: String
  sections: [NarrativeRunSection!]!
}

type NarrativeRunSection {
  id: ID!
  runId: ID!
  sectionKey: String!
  ord: Int!
  title: String
  status: String!
  blocks: JSON!
  research: JSON!
  verification: JSON!
  notes: JSON!
  errorMessage: String
  model: String
  updatedAt: DateTime!
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
  sections: JSON
  persona: String
  audience: String
  rules: JSON
  exposedDomains: [String!]
  allowExternalSearch: Boolean
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
  sections: JSON
  persona: String
  audience: String
  rules: JSON
  exposedDomains: [String!]
  allowExternalSearch: Boolean
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
#   narrativeRuns(narrativeId: ID!, entityId: ID, first: Int, statuses: [String!]): [NarrativeRun!]!
#   runDataQueries(queries: JSON!, entityId: ID, entityCode: String, params: JSON): DataQueryResponse!
#
# Mutation fields (add to type Mutation):
#   createDashboard(input: CreateDashboardInput!): CreateDashboardResult!
#   updateDashboard(id: ID!, input: UpdateDashboardInput!): UpdateDashboardResult!
#   deleteDashboard(id: ID!): DeleteDashboardResult!
#   createNarrative(input: CreateNarrativeInput!): CreateNarrativeResult!
#   updateNarrative(id: ID!, input: UpdateNarrativeInput!): UpdateNarrativeResult!
#   deleteNarrative(id: ID!): DeleteNarrativeResult!
#   publishNarrativeRun(id: ID!, label: String): NarrativeRun!
#   unpublishNarrativeRun(id: ID!): NarrativeRun!


# File: surface.graphql
# Surface composition
#
# A surface is the stable shell for a domain. Experiences qualify from the
# profile. Page slots pick one variant. The resolution carries the rule
# trace for every component so the management view can show why it rendered,
# lost a priority contest, or stayed hidden.

type SurfaceDefinition {
  id: ID!
  surfaceCode: String!
  surfaceName: String!
  domainCode: String!
  description: String
  isActive: Boolean!
  isPrimary: Boolean!
  clientId: ID
}

type SurfaceExperience {
  id: ID!
  experienceCode: String!
  experienceName: String!
  description: String
  isBaseline: Boolean!
  qualificationPriority: Int!
  displayOrder: Int!
  applicabilityRules: JSON!
  ruleSummary: String!
}

type SurfacePageVariant {
  id: ID!
  variantCode: String!
  variantName: String!
  description: String
  qualificationPriority: Int!
  requiredExperienceCodes: [String!]!
}

type SurfacePageSlot {
  id: ID!
  slotCode: String!
  slotName: String!
  description: String
  displayOrder: Int!
  optionality: String!
  variants: [SurfacePageVariant!]!
}

type SurfaceComponentDefinition {
  id: ID!
  componentCode: String!
  componentName: String!
  description: String
  slotCode: String
  variantCode: String
  experienceCode: String
  displayOrder: Int!
  clientId: ID
  panelKey: String
}

type SurfaceSampleProfile {
  id: ID!
  profileCode: String!
  profileName: String!
  description: String
  templateCode: String
  facts: JSON!
}

type SurfaceCatalog {
  surface: SurfaceDefinition!
  experiences: [SurfaceExperience!]!
  slots: [SurfacePageSlot!]!
  components: [SurfaceComponentDefinition!]!
  sampleProfiles: [SurfaceSampleProfile!]!
}

type SurfaceFact {
  key: String!
  value: String!
  source: String!
}

type ExperienceQualification {
  experienceCode: String!
  experienceName: String!
  status: String!
  ruleTrace: String!
}

type PageResolution {
  slotCode: String!
  slotName: String!
  optionality: String!
  status: String!
  variantCode: String
  variantName: String
  decision: String!
  panelKey: String
}

type ComponentResolution {
  componentCode: String!
  componentName: String!
  pageName: String!
  experienceName: String!
  status: String!
  ruleTrace: String!
  clientId: ID
  panelKey: String
}

type SurfaceResolution {
  surfaceCode: String!
  surfaceName: String!
  domainCode: String!
  subjectName: String!
  subjectKind: String!
  templateCode: String
  note: String
  facts: [SurfaceFact!]!
  experiences: [ExperienceQualification!]!
  pages: [PageResolution!]!
  components: [ComponentResolution!]!
}
type ReconciliationCell {
  key: String!
  label: String!
  value: String
  numeric: Float
}

type ReconciliationIdentity {
  code: String!
  name: String!
  calculated: Float
  compareValue: Float
  variance: Float
  passed: Boolean!
  message: String
}

type ReconciliationDefinition {
  id: ID!
  definitionCode: String!
  definitionName: String!
  description: String
  domainCode: String!
  compareMode: String!
  grain: String!
  relationshipCode: String
  relationshipDirection: String!
  measures: JSON!
  identityChecks: JSON!
  stages: [String!]!
  isActive: Boolean!
}

type ReconciliationLine {
  id: ID!
  lineEntityId: ID!
  lineCode: String!
  lineName: String!
  attributeCode: String!
  attributeName: String!
  breakKind: String!
  cells: [ReconciliationCell!]!
  goldenValue: String
  variance: Float
  isBreak: Boolean!
  status: String!
  resolutionSourceCode: String
  resolutionValue: String
  resolutionNotes: String
}

type ReconciliationRun {
  id: ID!
  definition: ReconciliationDefinition!
  anchorEntityId: ID!
  anchorEntityCode: String!
  anchorEntityName: String!
  domainCode: String!
  asOfDate: Date!
  compareAsOfDate: Date
  status: String!
  stageIndex: Int!
  assignedTo: String
  identities: [ReconciliationIdentity!]!
  lines: [ReconciliationLine!]!
  openBreakCount: Int!
  decidedAt: DateTime
  decisionNotes: String
  createdAt: DateTime!
}

input OpenReconciliationRunInput {
  definitionCode: String!
  entityId: ID!
  asOfDate: Date!
  compareAsOfDate: Date
}

input ResolveReconciliationLineInput {
  lineId: ID!
  status: String!
  sourceCode: String
  notes: String
}

input DecideReconciliationRunInput {
  runId: ID!
  decision: String!
  notes: String
}

type ReconciliationRunResult {
  run: ReconciliationRun
  errors: [MutationError!]!
}

# Jobs: schedules and the run queue (see src/lib/job-types.ts and packages/worker)

type JobType {
  code: String!
  label: String!
  description: String!
  """PLATFORM (no client), CLIENT (one client), or ANY."""
  scope: String!
  payloadExample: JSON!
}

type JobSchedule {
  id: ID!
  """Null for a platform schedule."""
  clientId: ID
  scheduleCode: String!
  scheduleName: String!
  jobType: String!
  jobTypeLabel: String!
  payload: JSON!
  cronExpression: String!
  timezone: String!
  isActive: Boolean!
  maxAttempts: Int!
  nextRunAt: DateTime
  lastRunAt: DateTime
  lastRunId: ID
  lastRunStatus: String
  createdAt: DateTime!
  updatedAt: DateTime!
}

type JobRun {
  id: ID!
  clientId: ID
  scheduleId: ID
  scheduleName: String
  jobType: String!
  jobTypeLabel: String!
  payload: JSON!
  """QUEUED, RUNNING, SUCCEEDED, FAILED, or CANCELLED."""
  status: String!
  attempts: Int!
  maxAttempts: Int!
  runAfter: DateTime!
  startedAt: DateTime
  finishedAt: DateTime
  result: JSON
  errorMessage: String
  createdAt: DateTime!
}

input SaveJobScheduleInput {
  """Leave out to create a schedule."""
  id: ID
  """True for a platform schedule (tenant admins only). Otherwise the schedule belongs to the caller's client."""
  platform: Boolean
  scheduleCode: String!
  scheduleName: String!
  jobType: String!
  payload: JSON
  """Five fields: minute hour day-of-month month day-of-week."""
  cronExpression: String!
  """IANA zone such as America/New_York. Defaults to UTC."""
  timezone: String
  isActive: Boolean
  maxAttempts: Int
}

type JobScheduleResult {
  schedule: JobSchedule
  errors: [MutationError!]!
}

type JobRunResult {
  run: JobRun
  errors: [MutationError!]!
}

# Workflows: multi-step automations with fixed, agent, and human steps (see docs/WORKFLOWS.md)

type WorkflowProblem {
  """The step with the problem. Null when it is about the workflow as a whole."""
  nodeId: String
  message: String!
}

type WorkflowVersion {
  version: Int!
  changeNote: String
  createdBy: ID
  createdAt: DateTime!
}

type Workflow {
  id: ID!
  """Null for a shared workflow."""
  clientId: ID
  code: String!
  name: String!
  description: String
  """The version new runs use. Null until one is published."""
  publishedVersion: Int
  latestVersion: Int!
  """The version whose graph is returned."""
  version: Int
  """{ nodes, edges }. Null in a list."""
  graph: JSON
  """What a run is asked for when it starts: { appliesTo, requiresRecords, inputs }. For a list, that of the published version."""
  runSetup: JSON
  """What stops this graph being published."""
  problems: [WorkflowProblem!]!
  versions: [WorkflowVersion!]!
  canManage: Boolean!
  runCount: Int!
  lastRunAt: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
}

type WorkflowRecordChoice {
  id: ID!
  entityCode: String!
  entityName: String!
  domainCode: String!
}

type WorkflowTemplate {
  code: String!
  name: String!
  description: String!
  inputExample: JSON!
  graph: JSON!
}

type WorkflowReview {
  id: ID!
  runId: ID!
  clientId: ID!
  nodeId: String!
  workflowName: String
  title: String!
  instructions: String
  """The agent's own summary of what it did and proposed."""
  summary: String
  """{ items }: each proposed change with its tool call, confidence, and open questions. Null in a list."""
  proposal: JSON
  counts: JSON
  """The named agent that proposed it, when the step ran as one. Null in a list."""
  agentCode: String
  agentName: String
  itemCount: Int!
  """OPEN, APPROVED, REJECTED, or CANCELLED."""
  status: String!
  decision: JSON
  decidedBy: ID
  decidedByName: String
  decidedAt: DateTime
  createdAt: DateTime!
  """Whether the caller can decide it now."""
  canReview: Boolean!
  """Why the caller cannot decide it: no permission, they started the run, or it is assigned to someone else."""
  blocker: String
  """Who it is for: [{ kind: person | role, id, name }]. Empty means anyone who holds workflow.review."""
  assignees: JSON!
  assignedToMe: Boolean!
  """True when the person who started the run may not decide it."""
  separateReviewer: Boolean!
  startedBy: ID
  startedByName: String
  dueAt: DateTime
  overdue: Boolean!
  """How many different people must approve."""
  approvalsRequired: Int!
  """[{ id, name, at }] of each approval so far."""
  approvals: JSON!
}

type WorkflowTrigger {
  id: ID!
  clientId: ID!
  workflowId: ID!
  name: String!
  """FEED, DQ_FAILURES, BREACH, or VALUE_CHANGE."""
  source: String!
  """FEED: { kinds, feedCodes }. DQ_FAILURES: { severities, ruleCodes, domainCodes }. BREACH: { ruleCodes, statuses }. VALUE_CHANGE: { attributeCodes, domainCodes }. An empty list matches everything, except attributeCodes."""
  match: JSON!
  """What each run starts with, as for a schedule. For every source but FEED, the records that started the run are added to filters.entityIds."""
  input: JSON!
  isActive: Boolean!
  """The person runs are started as."""
  createdBy: ID!
  createdByName: String
  """A run it started is still going, so new events wait for the next one."""
  busy: Boolean!
  lastFiredAt: DateTime
  """How many events or exceptions the last run was started with."""
  lastCount: Int
  """{ status, error, workflowRunId, finishedAt } of the job that started the last run."""
  lastJob: JSON
  canManage: Boolean!
  createdAt: DateTime!
}

input SaveWorkflowTriggerInput {
  id: ID
  workflowId: ID!
  name: String!
  source: String!
  match: JSON
  input: JSON
  isActive: Boolean
}

type WorkflowTriggerResult {
  trigger: WorkflowTrigger
  errors: [MutationError!]!
}

type WorkflowForm {
  id: ID!
  runId: ID!
  nodeId: String!
  workflowName: String
  title: String!
  instructions: String
  """[{ key, label, type: text|longtext|number|date|choice|yesno, required, options }]"""
  fields: JSON!
  """OPEN, SUBMITTED, DECLINED, or CANCELLED."""
  status: String!
  answers: JSON
  note: String
  """Set when the form went to someone outside the firm."""
  externalEmail: String
  """The private link still works."""
  linkActive: Boolean!
  assignees: JSON!
  canAnswer: Boolean!
  blocker: String
  submittedByName: String
  submittedAt: DateTime
  dueAt: DateTime
  createdAt: DateTime!
}

type WorkflowFormResult {
  form: WorkflowForm
  errors: [MutationError!]!
}

"""A screen a workflow step is waiting on a person to work through."""
type WorkflowStage {
  id: ID!
  runId: ID!
  nodeId: String!
  workflowName: String
  """The screen's code, such as load.map or load.quality."""
  screen: String!
  title: String!
  instructions: String
  """What the run gives the screen."""
  args: JSON!
  outcomes: [String!]!
  """The outcomes this person may choose."""
  allowedOutcomes: [String!]!
  """OPEN, DONE, or CANCELLED."""
  status: String!
  outcome: String
  result: JSON
  """Why the stage was handed back to the person, when it was."""
  returnedReason: String
  assignees: JSON!
  canAct: Boolean!
  blocker: String
  completedByName: String
  completedAt: DateTime
  dueAt: DateTime
  createdAt: DateTime!
}

type WorkflowStageResult {
  stage: WorkflowStage
  errors: [MutationError!]!
}

type WorkflowStageScreen {
  code: String!
  label: String!
  description: String!
  outcomes: [String!]!
  """[{ key, label, help }]"""
  args: JSON!
}

type NotificationSettings {
  emailEnabled: Boolean!
  """Whether a Slack address is saved. The address itself is never returned."""
  slackConfigured: Boolean!
  canManage: Boolean!
  sentLast7Days: Int!
  failedLast7Days: Int!
  updatedAt: DateTime
}

type NotificationSettingsResult {
  settings: NotificationSettings
  errors: [MutationError!]!
}

type WorkflowReviewerChoices {
  """[{ id, name }]"""
  people: JSON!
  """[{ code, name }]"""
  roles: JSON!
}

"""Who must act on a record or a domain. It grants no access."""
type Responsibility {
  id: ID!
  clientId: ID!
  """ENTITY or DOMAIN."""
  subjectType: String!
  entityId: ID
  entityName: String
  """The domain named, or the domain of the record."""
  domainCode: String
  """For a record: also covers the records under it."""
  includeChildren: Boolean!
  """Null covers every activity."""
  activityCode: String
  activityName: String
  userId: ID
  userName: String
  roleCode: String
  roleName: String
  """Used only when nobody else named at the same level can act."""
  isBackup: Boolean!
  note: String
  """The caller is the person named, or holds the role named."""
  isMine: Boolean!
  canManage: Boolean!
  createdAt: DateTime
}

type ResponsiblePerson {
  userId: ID!
  name: String!
  isBackup: Boolean!
}

type ResponsibilityChoices {
  clientId: ID
  canManage: Boolean!
  """[{ id, name }]"""
  people: JSON!
  """[{ code, name }]"""
  roles: JSON!
  """[{ code, name, description }]"""
  activities: JSON!
}

input SaveResponsibilityInput {
  """ENTITY or DOMAIN."""
  subjectType: String!
  entityId: ID
  domainCode: String
  activityCode: String
  userId: ID
  roleCode: String
  isBackup: Boolean
  includeChildren: Boolean
  note: String
  """For a domain, when the session can see more than one client."""
  clientId: ID
}

type SaveResponsibilityResult {
  responsibility: Responsibility
  errors: [MutationError!]!
}

"""A standing definition a workflow agent step can run as. It narrows the step and never widens it."""
type Agent {
  id: ID!
  """Null for a shared agent, offered to every client."""
  clientId: ID
  code: String!
  name: String!
  description: String
  """Who the agent is and how it should judge. Added to the step's instructions."""
  charter: String!
  """The kinds of work it does."""
  activityCodes: [String!]!
  activityNames: [String!]!
  """The domains it may propose changes in. Empty means any."""
  domainCodes: [String!]!
  """The tools it may use, reading and proposing. Empty means whatever the step allows."""
  toolNames: [String!]!
  isActive: Boolean!
  isShared: Boolean!
  canManage: Boolean!
  updatedAt: DateTime
}

input SaveAgentInput {
  """Leave out to create."""
  id: ID
  """Leave out for a shared agent."""
  clientId: ID
  code: String!
  name: String!
  description: String
  charter: String
  activityCodes: [String!]
  domainCodes: [String!]
  toolNames: [String!]
  isActive: Boolean
}

type SaveAgentResult {
  agent: Agent
  errors: [MutationError!]!
}

"""
A person's universe: the records they follow, the records and domains they are
responsible for, and the records under those. It narrows what they are shown.
It grants nothing and routes nothing.
"""
type MyUniverse {
  """False when the caller follows no record and is responsible for nothing. There is then nothing to narrow to."""
  hasAny: Boolean!
  """Records followed."""
  followed: Int!
  """Records the caller is responsible for, as themselves or through a role."""
  responsibleRecords: Int!
  """Domains the caller is responsible for."""
  responsibleDomains: [String!]!
  """The open reviews that are the caller's business: assigned to them, or changing something in their universe."""
  reviewIds: [ID!]!
}

type AgentsAtWork {
  agents: [AgentStatus!]!
  work: [AgentWork!]!
  """Runs that finished in the last day, newest first, with what each produced."""
  finished: [FinishedWork!]!
  """Runs with a step running or queued."""
  running: Int!
  """Runs waiting on a person."""
  waiting: Int!
}

type AgentStatus {
  code: String!
  name: String!
  description: String
  """working, queued, waiting (its proposals are with a person), or idle."""
  state: String!
  runs: Int!
}

"""A workflow run that has finished, with what it produced."""
type FinishedWork {
  runId: ID!
  workflowName: String!
  """done or failed."""
  outcome: String!
  """What the person asked for, when the run was handed a typed request."""
  request: String
  agentName: String
  """The agent's own account of what it found and did. For a failed run, why it failed."""
  result: String!
  """What came of any changes it proposed. Null when it proposed none."""
  changes: String
  finishedAt: DateTime
}

"""One workflow run in flight."""
type AgentWork {
  runId: ID!
  workflowName: String!
  """working, queued, or waiting (on a person)."""
  state: String!
  agentCode: String
  """The named agent, or the agent step's label. Null when no agent step is involved."""
  agentName: String
  stepLabel: String!
  detail: String!
  """0 to 100: steps finished, plus how far through its rounds a running agent is."""
  percent: Int!
  stepsDone: Int!
  stepsTotal: Int!
  startedAt: DateTime
}

input ReassignWorkflowReviewInput {
  reviewId: ID!
  """User ids."""
  people: [ID!]
  """Role codes."""
  roles: [String!]
  note: String
}

type WorkflowRun {
  id: ID!
  clientId: ID!
  workflowId: ID!
  workflowName: String
  version: Int!
  """QUEUED, RUNNING, WAITING (for a person), SUCCEEDED, FAILED, or CANCELLED."""
  status: String!
  input: JSON!
  """Each finished step's output, by step id."""
  context: JSON!
  currentNode: String
  errorMessage: String
  startedBy: ID
  openReviews: Int!
  canRun: Boolean!
  canReview: Boolean!
  """Whether the caller manages this client's workflows, and so can reassign any of its reviews."""
  canManage: Boolean!
  createdAt: DateTime!
  startedAt: DateTime
  finishedAt: DateTime
  """The graph of the version this run is on. Null in a list."""
  graph: JSON
  steps: JSON!
  """The audit log, oldest first."""
  events: JSON!
  reviews: [WorkflowReview!]!
}

input SaveWorkflowInput {
  """Leave out to create a workflow."""
  id: ID
  """True for a shared workflow (tenant admins only). Otherwise it belongs to the caller's client."""
  shared: Boolean
  code: String
  name: String!
  description: String
  graph: JSON!
  changeNote: String
}

input DecideWorkflowReviewInput {
  reviewId: ID!
  """APPROVED or REJECTED."""
  outcome: String!
  """{ items: { <change id>: { decision: APPROVE | REJECT, answers, args, note } }, note }"""
  decision: JSON
}

type WorkflowResult {
  workflow: Workflow
  errors: [MutationError!]!
}

type WorkflowRunResult {
  run: WorkflowRun
  errors: [MutationError!]!
}

type WorkflowReviewResult {
  review: WorkflowReview
  errors: [MutationError!]!
}

# Feeds: connections, feeds and the received-file ledger (see packages/worker/src/feeds.ts)

type FeedConnection {
  id: ID!
  clientId: ID!
  connectionCode: String!
  connectionName: String!
  """STORAGE (a folder in the feed inbox), HTTP (an https address), or SFTP (a folder on an SFTP server)."""
  kind: String!
  """Settings that are safe to show. Never a credential."""
  config: JSON!
  hasSecret: Boolean!
  isActive: Boolean!
  lastCheckedAt: DateTime
  lastCheckOk: Boolean
  lastCheckMessage: String
  """STORAGE only: where to put files, as bucket/folder."""
  inboxPath: String
}

type Feed {
  id: ID!
  clientId: ID!
  connectionId: ID!
  connectionName: String!
  connectionKind: String!
  feedCode: String!
  feedName: String!
  path: String!
  filePattern: String!
  mapCode: String!
  sourceCode: String
  isActive: Boolean!
  """When the feed is polled. Null when it is only polled on request."""
  pollCron: String
  pollTimezone: String
  nextPollAt: DateTime
  """When a file is expected. Null when the feed has no deadline."""
  expectedCron: String
  expectedTimezone: String!
  graceMinutes: Int!
  lastPolledAt: DateTime
  lastReceivedAt: DateTime
  lastFileName: String
  lastFileStatus: String
  lastFileMessage: String
}

type ReceivedFile {
  id: ID!
  feedId: ID!
  feedName: String
  fileName: String!
  remoteRef: String
  sizeBytes: Float
  sha256: String!
  """LOADING, LOADED, NEEDS_REVIEW, or FAILED."""
  status: String!
  attempts: Int!
  """The file in Load data, when it was stored there."""
  importInstanceId: ID
  rowsCreated: Int
  rowsMatched: Int
  message: String
  receivedAt: DateTime!
  lastSeenAt: DateTime!
  finishedAt: DateTime
}

type FeedMapOption {
  mapCode: String!
  mapName: String!
}

input SaveFeedConnectionInput {
  id: ID
  connectionCode: String
  connectionName: String!
  kind: String!
  config: JSON
  """Leave out to keep the stored credential. An empty string removes it."""
  secret: String
  isActive: Boolean
}

input SaveFeedInput {
  id: ID
  connectionId: ID!
  feedCode: String
  feedName: String!
  path: String
  filePattern: String
  mapCode: String!
  sourceCode: String
  isActive: Boolean
  """Five-field cron for polling. Leave out to poll only on request."""
  pollCron: String
  pollTimezone: String
  """Five-field cron for when a file is expected. Leave out for no deadline."""
  expectedCron: String
  expectedTimezone: String
  graceMinutes: Int
}

type FeedConnectionResult {
  connection: FeedConnection
  errors: [MutationError!]!
}

type FeedResult {
  feed: Feed
  errors: [MutationError!]!
}

type AssistantSettings {
  enabled: Boolean!
  preset: String!
  timezone: String!
  morningHour: Int!
  nextDeliveryAt: DateTime
  followCount: Int!
}

type AssistantFollow {
  id: ID!
  subjectType: String!
  subjectId: ID
  subjectCode: String
  label: String!
  delivery: String!
  """For a record: also the records under it, such as a fund's positions."""
  includeChildren: Boolean!
  createdAt: DateTime
}

input SaveAssistantSettingsInput {
  enabled: Boolean!
  preset: String!
  timezone: String!
  morningHour: Int!
}

input SaveAssistantFollowInput {
  subjectType: String!
  subjectId: ID
  subjectCode: String
  delivery: String!
}

type SaveAssistantSettingsResult {
  settings: AssistantSettings
  errors: [MutationError!]!
}

type SaveAssistantFollowResult {
  follow: AssistantFollow
  errors: [MutationError!]!
}

type HomeLayout {
  """Null when the session sees no client or several; the page then shows defaults and cannot save."""
  clientId: ID
  canSave: Boolean!
  """Module codes the caller hid. Null means the default for their role."""
  hiddenModules: [String!]
  """Place keys the caller pinned, in order. Null means every place they can open."""
  pinnedPlaces: [String!]
  updatedAt: DateTime
}

input SaveHomeLayoutInput {
  hiddenModules: [String!]
  pinnedPlaces: [String!]
}

type SaveHomeLayoutResult {
  layout: HomeLayout
  errors: [MutationError!]!
}

type HomeActivityItem {
  id: ID!
  kind: String!
  subjectType: String!
  subjectId: ID
  subjectCode: String
  summary: String!
  occurredAt: DateTime!
  """The follow that matched this change."""
  followLabel: String!
  """DIGEST or IMMEDIATE."""
  delivery: String!
}

type HomeFollow {
  id: ID!
  """KIND, ENTITY, or FEED."""
  subjectType: String!
  subjectId: ID
  subjectCode: String
  label: String!
  delivery: String!
  """The record's domain, when it is a record the caller can read."""
  domainCode: String
  lastSummary: String
  lastAt: DateTime
}

type HomeBrief {
  """False when the session sees no single client."""
  available: Boolean!
  enabled: Boolean!
  preset: String!
  nextDeliveryAt: DateTime
  conversationId: ID
  """The last note the assistant wrote, as markdown."""
  content: String
  deliveredAt: DateTime
  followCount: Int!
}

# Document content: the words of a document in tagged, searchable sections (see docs/DOCUMENTS.md)

type DocumentType {
  id: ID!
  """Null for a type every client can use."""
  clientId: ID
  typeCode: String!
  typeName: String!
  description: String
  isActive: Boolean!
  documentCount: Int!
  publishedTemplateId: ID
  publishedTemplateVersion: Int
}

type DocumentTemplateSection {
  code: String!
  title: String!
  """Null for a top section. A template has two levels."""
  parentCode: String
  """Other headings that mean this section."""
  aliases: [String!]!
  """Tags every chunk under this section carries."""
  tags: [String!]!
  guidance: String!
  required: Boolean!
  order: Int!
  """How many of the source documents had this section."""
  seenIn: Int!
}

type DocumentTemplateTopic {
  code: String!
  title: String!
  """What belongs under the topic. A search question is compared with it."""
  description: String!
}

type DocumentTemplate {
  id: ID!
  clientId: ID
  typeId: ID!
  typeCode: String
  typeName: String
  version: Int!
  """DRAFT, PUBLISHED or RETIRED. Only a draft can be changed."""
  status: String!
  sections: [DocumentTemplateSection!]!
  """The subjects documents of this type cover, such as lenders or pricing."""
  topics: [DocumentTemplateTopic!]!
  sourceDocumentIds: [ID!]!
  notes: String
  createdAt: DateTime!
  updatedAt: DateTime!
  publishedAt: DateTime
}

type DocumentEntityLink {
  entityId: ID!
  entityName: String!
  entityCode: String
  domainCode: String
  """What the record is to the document: BORROWER, LENDER, FUND, SUBJECT."""
  role: String!
}

type DocumentSection {
  id: ID!
  seq: Int!
  parentSeq: Int
  level: Int!
  number: String
  heading: String!
  charStart: Int!
  charEnd: Int!
  templateSectionCode: String
  """EXACT, ALIAS, SIMILAR, EMBEDDING or MANUAL. MANUAL is a choice made by a person and survives tagging again."""
  matchMethod: String
  matchScore: Float
  chunkCount: Int!
}

type Document {
  id: ID!
  clientId: ID!
  typeId: ID!
  typeCode: String!
  typeName: String!
  templateId: ID
  templateVersion: Int
  title: String!
  fileName: String!
  mediaType: String
  sizeBytes: Float
  """RECEIVED, PROCESSING, READY or FAILED."""
  status: String!
  """While processing: READING, TAGGING or EMBEDDING."""
  stage: String
  message: String
  documentDate: Date
  tags: [String!]!
  format: String
  pageCount: Int
  charCount: Int!
  chunkCount: Int!
  embeddedCount: Int!
  embeddingModel: String
  createdAt: DateTime!
  processedAt: DateTime
  entities: [DocumentEntityLink!]!
  """Only on a single document, not in a list."""
  sections: [DocumentSection!]!
}

type DocumentChunk {
  id: ID!
  documentId: ID!
  sectionId: ID
  seq: Int!
  """CLAUSE, DEFINITION, TABLE or FRONT."""
  kind: String!
  """The exact words of the document."""
  text: String!
  charStart: Int!
  charEnd: Int!
  page: Int
  clause: String
  locator: JSON!
  tags: [String!]!
  embedded: Boolean!
  """Mostly names and numbers: a table, a signature block, a list."""
  thin: Boolean!
  """What the passage holds. Written by a model or a person, never the words of the document."""
  summary: String
  """Topic codes from the template."""
  topics: [String!]!
  """MODEL or MANUAL. Null when nobody has described the passage."""
  refinedBy: String
}

type DocumentText {
  start: Int!
  """The length of the whole document."""
  length: Int!
  text: String!
}

type DocumentTag {
  tag: String!
  chunks: Int!
}

type DocumentSearchEntity {
  entityId: ID!
  entityName: String!
  role: String!
}

type DocumentSearchHit {
  chunkId: ID!
  documentId: ID!
  documentTitle: String!
  documentDate: Date
  typeCode: String!
  typeName: String!
  sectionId: ID
  sectionNumber: String
  sectionHeading: String
  parentHeading: String
  templateSectionCode: String
  kind: String!
  """The exact words of the document, to quote as the citation."""
  text: String!
  """What the passage holds, where its own words say little. Not the words of the document."""
  summary: String
  """The topic or section that brought the passage forward: topic:LENDERS, section:NEGATIVE_COVENANTS."""
  routedBy: String
  charStart: Int!
  charEnd: Int!
  page: Int
  clause: String
  locator: JSON!
  tags: [String!]!
  score: Float!
  similarity: Float
  """How well the passage answers the question, from 0 to 1, when the second ranking pass ran."""
  relevance: Float
  """MEANING, WORDS, BOTH, or TOPIC when only the routing found it."""
  foundBy: String!
  entities: [DocumentSearchEntity!]!
}

type DocumentSearchResult {
  hits: [DocumentSearchHit!]!
  """False when only the words were searched."""
  byMeaning: Boolean!
  """True when the candidates were ranked again by a model that reads each against the question."""
  reranked: Boolean!
  note: String
}

input SaveDocumentTypeInput {
  id: ID
  typeCode: String
  typeName: String!
  description: String
  isActive: Boolean
}

input DocumentTemplateSectionInput {
  code: String!
  title: String!
  parentCode: String
  aliases: [String!]
  tags: [String!]
  guidance: String
  required: Boolean
  order: Int
  seenIn: Int
}

input DocumentTemplateTopicInput {
  code: String
  title: String!
  description: String
}

input SaveDocumentTemplateInput {
  """Omit to start a new draft for typeId."""
  id: ID
  typeId: ID
  sections: [DocumentTemplateSectionInput!]!
  """Omit to leave the topics as they are."""
  topics: [DocumentTemplateTopicInput!]
  notes: String
  sourceDocumentIds: [ID!]
}

input DocumentEntityLinkInput {
  entityId: ID!
  role: String
}

input UpdateDocumentInput {
  id: ID!
  title: String
  typeId: ID
  """An empty string clears the date."""
  documentDate: String
  tags: [String!]
  """Replaces every link. Omit to leave them."""
  entities: [DocumentEntityLinkInput!]
}

type DocumentTypeResult {
  type: DocumentType
  errors: [MutationError!]!
}

type DocumentTemplateResult {
  template: DocumentTemplate
  errors: [MutationError!]!
}

type PublishDocumentTemplateResult {
  template: DocumentTemplate
  """Documents of the type tagged against the new version."""
  tagged: Int!
  failed: Int!
  """Topics and sections a search can now be routed by. Zero when no embedding key is set."""
  routes: Int!
  errors: [MutationError!]!
}

type DocumentResult {
  document: Document
  errors: [MutationError!]!
}

`;
