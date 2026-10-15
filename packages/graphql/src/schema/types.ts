// TypeScript types for generic entity model

export interface Entity {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  domainName: string;
  templateCode?: string;
  templateName?: string;
  description?: string;
  isActive: boolean;
  attributes: Record<string, any>;
  parentRelationships: EntityRelationship[];
  childRelationships: EntityRelationship[];
  metadata?: any;
  createdAt: string;
  updatedAt: string;
}

export interface EntityRelationship {
  parentEntityId: string;
  parentEntityCode: string;
  parentEntityName: string;
  parentDomainCode: string;
  childEntityId: string;
  childEntityCode: string;
  childEntityName: string;
  childDomainCode: string;
  relationshipType: string;
  relationshipCode: string;
  isPrimary: boolean;
  members: RelationshipMember[];
}

export interface RelationshipMember {
  entityId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
}

export interface EntityConnection {
  edges: EntityEdge[];
  pageInfo: PageInfo;
  totalCount: number;
}

export interface EntityEdge {
  node: Entity;
  cursor: string;
}

export interface RelationshipType {
  id: string;
  relationshipCode: string;
  relationshipName: string;
  parentDomainCode?: string;
  childDomainCode?: string;
  description?: string;
  isActive: boolean;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor?: string;
  endCursor?: string;
}

// ============== PRECEDENCE RULES ==============

export interface PrecedenceRule {
  id: string;
  ruleCode: string;
  ruleName: string;
  domainCode: string;
  templateCode?: string;
  attributeCode: string;
  priorityTier: string;
  isActive: boolean;
  conditions: PrecedenceCondition[];
  chain: PrecedenceChainItem[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  metadata?: any;
}

export interface PrecedenceCondition {
  id: string;
  ruleId: string;
  conditionGroup: number;
  conditionOrder: number;
  attributeCode: string;
  operator: string;
  value: string;
  logicOperator: string;
  createdAt: string;
}

export interface PrecedenceChainItem {
  id: string;
  ruleId: string;
  chainOrder: number;
  sourceCode: string;
  conditionType: string;
  createdAt: string;
}

export interface PrecedenceRulePayload {
  precedenceRule?: PrecedenceRule;
  errors: Array<{ field: string; message: string; code: string }>;
}

export interface PrecedenceRuleDeletePayload {
  success: boolean;
  errors: Array<{ field: string; message: string; code: string }>;
}

export interface PrecedenceEvaluationResult {
  winningSource: string;
  winningSourceId?: string;
  appliedRule: PrecedenceRule | null;
  isDefault: boolean;
  tierUsed: 1 | 2 | 3 | 4;
  resolutionVersion: number;
  allCandidates: Array<{
    source: string;
    sourceId?: string;
    value: string;
    rank: number;
  }>;
}

export interface CreatePrecedenceRuleInput {
  ruleCode?: string;
  ruleName: string;
  domainCode: string;
  templateCode?: string;
  attributeCode: string;
  priorityTier?: string;
  isActive?: boolean;
  conditions?: Array<{
    conditionGroup?: number;
    conditionOrder?: number;
    attributeCode: string;
    operator: string;
    value?: string;
    logicOperator?: string;
  }>;
  chain?: Array<{
    chainOrder?: number;
    sourceCode: string;
    conditionType?: string;
  }>;
  metadata?: any;
}

export interface UpdatePrecedenceRuleInput {
  ruleCode?: string;
  ruleName?: string;
  domainCode?: string;
  templateCode?: string;
  attributeCode?: string;
  priorityTier?: string;
  isActive?: boolean;
  conditions?: Array<{
    conditionGroup?: number;
    conditionOrder?: number;
    attributeCode: string;
    operator: string;
    value?: string;
    logicOperator?: string;
  }>;
  chain?: Array<{
    chainOrder?: number;
    sourceCode: string;
    conditionType?: string;
  }>;
  metadata?: any;
}

