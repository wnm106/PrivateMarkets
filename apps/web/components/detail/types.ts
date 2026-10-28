// Shared types for entity detail pages

export interface RelationshipMember {
  entityId: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
}

export interface AttributeValue {
  value: any;
  source?: string;
  updatedAt?: string;
  reliability?: number;
}

export interface EntityData {
  id: string;
  entityCode: string;
  entityName: string;
  domainCode: string;
  domainName: string;
  templateName?: string;
  description?: string;
  isActive: boolean;
  attributes: Record<string, AttributeValue>;
  parentRelationships: Array<{
    parentEntityId: string;
    parentEntityCode: string;
    parentEntityName: string;
    parentDomainCode: string;
    relationshipType: string;
    relationshipCode: string;
    isPrimary: boolean;
    members?: RelationshipMember[];
  }>;
  childRelationships: Array<{
    childEntityId: string;
    childEntityCode: string;
    childEntityName: string;
    childDomainCode: string;
    relationshipType: string;
    relationshipCode: string;
    isPrimary: boolean;
    members?: RelationshipMember[];
  }>;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface ConflictData {
  field: string;
  severity: 'high' | 'med' | 'low';
  description: string;
}

export interface SourceContributionData {
  source: string;
  sourceName: string;
  fieldCount: number;
  percentage: number;
  color: string;
}

export interface ActivityData {
  who: string;
  time: string;
  text: string;
  attribute?: string;
  attributeCode?: string;
  value?: string;
  validFrom?: string;
  validTo?: string;
}